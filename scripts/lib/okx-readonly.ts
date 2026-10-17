/**
 * OKX TR salt-okunur REST istemcisi (§14 Mutabakat). Elif'in kendi salt-okunur anahtarıyla çalışır.
 *
 * Güvenlik (CLAUDE.md kural 4, 5):
 * - Yalnız GET. POST/emir/iptal/çekim fonksiyonu yoktur; yol sabit bir izin listesinden geçmeyen istek gönderilmez.
 * - Taban adres sabittir (https://tr.okx.com, Ek B); başka bir sunucuya imzalı istek gitmez, yönlendirme izlenmez.
 * - Gizli anahtar (secret) hiçbir yere gönderilmez; yalnız imza (HMAC) gider. Anahtar ve imza günlüğe/hataya yazılmaz.
 * - Çalışmadan önce /api/v5/account/config'teki `perm` okunur: anahtarda trade ya da withdraw yetkisi varsa durulur.
 *   [DOĞRULA] OKX TR'de account/config yanıtındaki `perm` alanı (OKX global belgesi: "read_only", "trade", "withdraw").
 *
 * İmza (OKX v5, §9 ile aynı): base64(HMAC_SHA256(secret, timestamp + "GET" + requestPath)); requestPath sorguyu içerir.
 */
import { createHmac } from "node:crypto";
import { z } from "zod";
import { parseOkxTs, TRADE_INST_ID } from "@pilot/shared";

export const OKX_TR_BASE = "https://tr.okx.com";

/** İzin verilen GET yolları. Bunların dışında hiçbir istek gönderilmez. */
export const OKX_READONLY_GET_PATHS = [
  "/api/v5/account/config",
  "/api/v5/trade/orders-pending",
  "/api/v5/trade/orders-history",
  "/api/v5/trade/orders-history-archive",
] as const;
export type OkxReadonlyPath = (typeof OKX_READONLY_GET_PATHS)[number];

const ALLOWED_QUERY_KEYS = new Set(["instType", "instId", "after", "begin", "end", "limit"]);

/** Sayfa boyutu (OKX en fazla 100) ve sayfa sınırı (sonsuz döngüye karşı; aşılırsa hata). */
export const OKX_PAGE_LIMIT = 100;
export const OKX_MAX_PAGES = 50;

/** orders-history son 7 günü, orders-history-archive son 3 ayı verir (OKX belgesi). */
export const OKX_HISTORY_DAYS = 7;
export const OKX_ARCHIVE_DAYS = 90;

export class OkxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OkxError";
  }
}

export interface OkxReadonlyCreds {
  apiKey: string;
  secret: string;
  passphrase: string;
}

/** Ortamdan salt-okunur anahtar (§14: OKX_READONLY_*). Değer hata mesajına girmez. */
export function loadReadonlyCreds(env: Record<string, string | undefined>): OkxReadonlyCreds {
  const get = (name: string): string => {
    const v = env[name]?.trim();
    if (!v) throw new OkxError(`${name} tanımlı değil`);
    if (/[\r\n]/.test(v)) throw new OkxError(`${name} geçersiz`);
    return v;
  };
  return {
    apiKey: get("OKX_READONLY_API_KEY"),
    secret: get("OKX_READONLY_SECRET"),
    passphrase: get("OKX_READONLY_PASSPHRASE"),
  };
}

/** OKX v5 imzası. */
export function signOkx(secret: string, timestamp: string, method: "GET", requestPath: string, body = ""): string {
  return createHmac("sha256", secret).update(timestamp + method + requestPath + body).digest("base64");
}

const DecOrEmpty = z.string().regex(/^$|^(0|[1-9]\d*)(\.\d+)?$/, "OKX ondalık biçimi olmalı");

/** Emir satırı: yalnız gereken alanlar (OKX diğer alanları da döndürür; atılır). */
export const OkxOrderSchema = z.object({
  instId: z.string(),
  ordId: z.string().regex(/^\d+$/),
  clOrdId: z.string(),
  tag: z.string(),
  px: DecOrEmpty,
  sz: DecOrEmpty,
  ordType: z.string(),
  side: z.string(),
  state: z.string(),
  accFillSz: DecOrEmpty,
  avgPx: DecOrEmpty,
  cTime: z.string().regex(/^\d+$/),
});
export type OkxOrder = z.infer<typeof OkxOrderSchema>;

const EnvelopeSchema = z.object({ code: z.string(), msg: z.string(), data: z.array(z.unknown()) });
const AccountConfigSchema = z.object({ perm: z.string() });

export interface OkxReadonlyOptions {
  /** Test için fetch enjeksiyonu. */
  fetch?: typeof fetch;
  /** OKX demo hesabı (x-simulated-trading: 1). Ekranda DEMO etiketi çıkar. */
  demo?: boolean;
  now?: () => Date;
}

export class OkxReadonlyClient {
  private readonly fetchFn: typeof fetch;
  private readonly demo: boolean;
  private readonly now: () => Date;

  constructor(
    private readonly creds: OkxReadonlyCreds,
    o: OkxReadonlyOptions = {},
  ) {
    this.fetchFn = o.fetch ?? fetch;
    this.demo = o.demo === true;
    this.now = o.now ?? (() => new Date());
  }

  /** Tek imzalı GET. Yol izin listesinde, sorgu anahtarları sabit kümede olmalı. */
  async get(path: OkxReadonlyPath, query: Record<string, string> = {}): Promise<unknown[]> {
    if (!(OKX_READONLY_GET_PATHS as readonly string[]).includes(path)) throw new OkxError(`izin listesinde olmayan yol: ${path}`);
    for (const [k, v] of Object.entries(query)) {
      if (!ALLOWED_QUERY_KEYS.has(k)) throw new OkxError(`izin verilmeyen sorgu alanı: ${k}`);
      if (typeof v !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(v)) throw new OkxError(`geçersiz sorgu değeri: ${k}`);
    }
    const qs = new URLSearchParams(query).toString();
    const requestPath = qs ? `${path}?${qs}` : path;
    const url = new URL(requestPath, OKX_TR_BASE);
    if (url.origin !== OKX_TR_BASE || url.pathname !== path) throw new OkxError("istek OKX TR dışına çıkıyor");

    const timestamp = this.now().toISOString();
    const headers: Record<string, string> = {
      Accept: "application/json",
      "OK-ACCESS-KEY": this.creds.apiKey,
      "OK-ACCESS-SIGN": signOkx(this.creds.secret, timestamp, "GET", requestPath),
      "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-PASSPHRASE": this.creds.passphrase,
    };
    if (this.demo) headers["x-simulated-trading"] = "1";

    let res: Response;
    try {
      res = await this.fetchFn(url.toString(), { method: "GET", headers, redirect: "error" });
    } catch {
      throw new OkxError(`OKX'e ulaşılamadı (${path})`);
    }
    if (!res.ok) throw new OkxError(`OKX HTTP ${res.status} (${path})`);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new OkxError(`OKX yanıtı JSON değil (${path})`);
    }
    const env = EnvelopeSchema.safeParse(body);
    if (!env.success) throw new OkxError(`OKX yanıtı beklenen biçimde değil (${path})`);
    if (env.data.code !== "0") throw new OkxError(`OKX hata kodu ${env.data.code}: ${env.data.msg.slice(0, 200)} (${path})`);
    return env.data.data;
  }

  /** Anahtar salt-okunur mu? trade ya da withdraw yetkisi varsa (ya da perm okunamazsa) hata. */
  async assertReadOnly(): Promise<void> {
    const data = await this.get("/api/v5/account/config");
    const cfg = AccountConfigSchema.safeParse(data[0]);
    if (data.length !== 1 || !cfg.success) throw new OkxError("anahtar yetkisi okunamadı (account/config)");
    const perms = cfg.data.perm.split(",").map((p) => p.trim()).filter(Boolean);
    if (perms.length === 0 || perms.some((p) => p !== "read_only")) {
      throw new OkxError(`bu anahtar salt-okunur değil (yetki: ${perms.join(",") || "boş"}); Mutabakat yalnız Read anahtarıyla çalışır`);
    }
  }

  /**
   * USDT-TRY spot emirleri: açık emirler + [beginMs, endMs] aralığındaki geçmiş emirler (cTime'a göre).
   * Aynı ordId iki listede görünürse bir kez döner.
   */
  async listOrders(o: { beginMs: number; endMs: number; days: number }): Promise<OkxOrder[]> {
    if (!Number.isInteger(o.days) || o.days < 1 || o.days > OKX_ARCHIVE_DAYS) throw new OkxError(`gün sayısı 1–${OKX_ARCHIVE_DAYS} olmalı`);
    const base = { instType: "SPOT", instId: TRADE_INST_ID };
    const pending = await this.paginate("/api/v5/trade/orders-pending", base);
    const historyPath = o.days <= OKX_HISTORY_DAYS ? "/api/v5/trade/orders-history" : "/api/v5/trade/orders-history-archive";
    const history = await this.paginate(historyPath, { ...base, begin: String(o.beginMs), end: String(o.endMs) });

    const byId = new Map<string, OkxOrder>();
    for (const row of [...pending, ...history]) {
      if (row.instId !== TRADE_INST_ID) throw new OkxError(`beklenmeyen enstrüman: ${row.instId}`);
      if (!byId.has(row.ordId)) byId.set(row.ordId, row);
    }
    return [...byId.values()].filter((r) => parseOkxTs(r.cTime) >= o.beginMs || isOpenOrder(r));
  }

  private async paginate(path: OkxReadonlyPath, query: Record<string, string>): Promise<OkxOrder[]> {
    const out: OkxOrder[] = [];
    let after: string | undefined;
    for (let page = 0; page < OKX_MAX_PAGES; page++) {
      const data = await this.get(path, { ...query, limit: String(OKX_PAGE_LIMIT), ...(after ? { after } : {}) });
      for (const raw of data) {
        const r = OkxOrderSchema.safeParse(raw);
        if (!r.success) throw new OkxError(`OKX emir satırı beklenen biçimde değil (${path})`);
        out.push(r.data);
      }
      if (data.length < OKX_PAGE_LIMIT) return out;
      after = out[out.length - 1]!.ordId;
    }
    throw new OkxError(`çok fazla emir (${OKX_MAX_PAGES} sayfadan fazla); daha kısa bir pencere seç (${path})`);
  }
}

/** OKX'te hâlâ açık emir. */
export function isOpenOrder(o: Pick<OkxOrder, "state">): boolean {
  return o.state === "live" || o.state === "partially_filled";
}
