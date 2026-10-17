/**
 * İzin başına kalıcı durum (§9.2-2, CLAUDE.md kural 13): data/kule-actions.json.
 * Durumlar: RESERVED → PLACED → DONE → REPORTED. Emir gönderilmeden ÖNCE diske yazılır.
 * Yazma: geçici dosyaya yaz → fsync → atomik rename (yarım dosya oluşmaz). Native sqlite yok.
 * Bellek önce değişir (aynı süreçte eşzamanlı çağrılar anında görür), disk yazımı beklenir; yazım başarısızsa değişiklik
 * geri alınır ve hata fırlatılır (emir gönderilmez, fail-closed). Bozuk dosya → açılışta hata.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { KULE_ACTION_STATES, type ExecStatus, type KuleActionState, type OrdType } from "@pilot/shared";
import type { Hex } from "viem";

export interface ActionRecord {
  actionId: string;
  clOrdId: string;
  state: KuleActionState;
  /** İzni uygulayan ajan adresi (küçük harf). */
  agent: string;
  paper: boolean;
  amountTL: number;
  ordType?: OrdType;
  pxE6?: number;
  sz?: string;
  reservedAtMs: number;
  placedAtMs?: number;
  ordId?: string;
  /** Emir sonucu belirsiz (§9.2-12) ya da yeniden başlatmada netleşmedi. */
  uncertain?: boolean;
  filledTL?: number;
  avgPxE6?: number;
  status?: ExecStatus;
  reportHash?: Hex;
  reportTx?: Hex;
  /** Emir açılmadan reddedilen izin zincirde CANCELED ile serbest bırakıldı (TOO_LATE release). */
  released?: boolean;
  /** reportExecution başarısız deneme sayısı (yeniden denemeyi sınırlar). */
  reportFailures?: number;
  updatedAtMs: number;
}

export class StoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StoreError";
  }
}

interface FileShape {
  version: 1;
  actions: Record<string, ActionRecord>;
}

const STATES = new Set<string>(KULE_ACTION_STATES);

function validate(raw: unknown): FileShape {
  const o = raw as FileShape | null;
  if (!o || typeof o !== "object" || o.version !== 1 || typeof o.actions !== "object" || o.actions === null || Array.isArray(o.actions)) {
    throw new StoreError("durum dosyası biçimi geçersiz");
  }
  for (const [id, r] of Object.entries(o.actions)) {
    if (!/^[1-9]\d*$/.test(id) || r?.actionId !== id || typeof r.clOrdId !== "string" || !STATES.has(r.state) || typeof r.agent !== "string") {
      throw new StoreError("durum dosyasında geçersiz kayıt");
    }
  }
  return o;
}

export class ActionStore {
  private actions = new Map<string, ActionRecord>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    /** Başlangıçta RESERVED/PLACED kayıtlar belirsiz sayılır (yeniden başlatma, §9.2-2). */
    markUnresolvedUncertain = true,
  ) {
    if (existsSync(path)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
      } catch (e) {
        throw new StoreError("durum dosyası okunamadı/bozuk; elle incele (silme)", { cause: e });
      }
      const f = validate(parsed);
      for (const r of Object.values(f.actions)) {
        if (markUnresolvedUncertain && (r.state === "RESERVED" || r.state === "PLACED")) r.uncertain = true;
        this.actions.set(r.actionId, r);
      }
    }
  }

  get(actionId: string): ActionRecord | undefined {
    return this.actions.get(actionId);
  }
  all(): ActionRecord[] {
    return [...this.actions.values()];
  }
  anyUncertain(): boolean {
    for (const r of this.actions.values()) if (r.uncertain === true) return true;
    return false;
  }

  /** Kayıt yoksa ekler ve diske yazar; varsa false. Bellek ekleme eşzamanlıdır (yarış yok). */
  async reserve(rec: ActionRecord): Promise<boolean> {
    if (this.actions.has(rec.actionId)) return false;
    this.actions.set(rec.actionId, rec);
    try {
      await this.persist();
    } catch (e) {
      this.actions.delete(rec.actionId);
      throw e;
    }
    return true;
  }

  async update(actionId: string, patch: Partial<ActionRecord>, nowMs: number): Promise<ActionRecord> {
    const cur = this.actions.get(actionId);
    if (!cur) throw new StoreError(`kayıt yok: ${actionId}`);
    const next: ActionRecord = { ...cur, ...patch, actionId: cur.actionId, updatedAtMs: nowMs };
    this.actions.set(actionId, next);
    try {
      await this.persist();
    } catch (e) {
      this.actions.set(actionId, cur);
      throw e;
    }
    return next;
  }

  async delete(actionId: string): Promise<void> {
    const cur = this.actions.get(actionId);
    if (!cur) return;
    this.actions.delete(actionId);
    try {
      await this.persist();
    } catch (e) {
      this.actions.set(actionId, cur);
      throw e;
    }
  }

  /** Yazımları sıraya sokar; her yazım bellekteki en güncel durumu kaydeder. */
  private persist(): Promise<void> {
    const run = this.writeChain.then(() => this.writeFile());
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  private writeFile(): void {
    const data: FileShape = { version: 1, actions: Object.fromEntries(this.actions) };
    const text = JSON.stringify(data);
    const tmp = `${this.path}.tmp`;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const fd = openSync(tmp, "w");
      try {
        writeSync(fd, text);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameWithRetry(tmp, this.path);
      fsyncDir(dirname(this.path));
    } catch (e) {
      throw new StoreError("durum dosyası yazılamadı", { cause: e });
    }
  }
}

function renameWithRetry(from: string, to: string): void {
  // Windows'ta antivirüs/izleyici anlık EPERM verebilir.
  let last: unknown;
  for (let i = 0; i < 5; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      last = e;
      const end = Date.now() + 20 * (i + 1);
      while (Date.now() < end) {
        /* kısa bekleme */
      }
    }
  }
  throw last;
}

function fsyncDir(dir: string): void {
  if (process.platform === "win32") return; // Windows dizin fsync desteklemez
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* dizin fsync desteklenmiyorsa dosya fsync'i yeterli sayılır */
  }
}
