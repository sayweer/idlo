/**
 * PİLOT döngüsü (§10.1). Saat dışarıdan verilir: canlıda sistem saati, kayıt oynatmada simüle saat.
 * Çağıran `onTick()`'i her 5 dk mum kapanışından 5 sn sonra çağırır; döngü tetikleyiciye bakıp tur açar ya da açmaz.
 *
 * Tetikleyiciler (§10.1), öncelik sırasıyla:
 *   start  — ilk çağrı,
 *   answer — Elif bir soruya cevap verdi (`answer()`),
 *   expiry — bu PİLOT'un aldığı, uygulanmamış bir iznin `openBy`'ı geçti,
 *   alarm  — Lira Hava Durumu sınıfı ya da fırtına bölümü son turdakinden farklı,
 *   tick   — son turun `bekle` süresi doldu.
 * TODO(spec): §10.1 "hava alarmı"nı tanımlamıyor; en dar seçim sınıf/bölüm değişimi (her alarm mumunda LLM turu
 * açmaz). `bekle(dakika)` sonraki 5 dk turunu o kadar erteler; alarm/cevap/süre turu erken uyandırır.
 * TODO(spec): `bitir` sonrası aynı ay için tur açılmaz; ay değişince döngü yeniden başlar.
 *
 * Her tur ize yazılır (§15, src/trace). Mod etiketleri (kural modu, enjeksiyon demosu, kâğıt, kayıt oynatma)
 * her kayıtta durur (CLAUDE.md kural 12). Demo modları burada hiçbir korumayı değiştirmez: koruma araç katmanında.
 */
import type { Address } from "viem";
import { DEMO_LABELS, cycleIdOf, msToSec, secToMs, type CycleId } from "@pilot/shared";
import type { Clock } from "../clients/clock.js";
import type { KuleClient } from "../clients/kule.js";
import type { PilotTools, WeatherSource } from "../tools/index.js";
import type { TraceRecord, TraceStore, Trigger } from "../trace/index.js";
import type { LlmClient } from "./llm.js";
import { runLlmTurn, runRuleTurn, type TurnOutcome } from "./planner.js";

export interface PilotLoopDeps {
  tools: PilotTools;
  /** null: LLM yok (LLM_MODEL boş ya da istemci kurulamadı) → her tur kural modu. */
  llm: LlmClient | null;
  store: TraceStore;
  clock: Clock;
  /** Hava değişimi tetikleyicisi için (aracın kendisi değil; LLM hava_durumu'nu çağırmasa da çalışır). */
  weather: WeatherSource;
  /** Kalp atışı (§10.1: 15 sn'de bir kule_heartbeat). */
  kule: KuleClient;
  /** İzlenen kullanıcı (izdeki `user`). */
  user: Address;
  /** Sürekli etiketler: enjeksiyon demosu, kâğıt emir, kayıt oynatma. */
  labels: readonly string[];
  log?: (line: string) => void;
}

interface WxMark {
  cls: string;
  episodeStartTs: number | null;
}

export class PilotLoop {
  private turnNo = 0;
  private started = false;
  private answered = false;
  private nextWakeMs = 0;
  private finishedCycle: CycleId | null = null;
  private lastWx: WxMark | null = null;
  private readonly notifiedExpired = new Set<string>();

  private constructor(private readonly d: PilotLoopDeps) {}

  /** İz dosyası varsa tur numarası kaldığı yerden sürer. */
  static async create(d: PilotLoopDeps): Promise<PilotLoop> {
    const loop = new PilotLoop(d);
    const last = await d.store.lastTurn();
    loop.turnNo = last === null ? 0 : last + 1;
    return loop;
  }

  /** Elif'in panelden cevabı (§10.2 kullaniciya_sor). Kabul edilirse bir sonraki onTick turu açar. */
  answer(questionId: string, optionId: string): boolean {
    const ok = this.d.tools.state.answer(questionId, optionId, msToSec(this.d.clock.nowMs()));
    if (ok) this.answered = true;
    return ok;
  }

  /** §10.1 kalp atışı. Hata turu etkilemez: KULE kalp atışını kaybederse CAA emirleri iptal eder (§16 #4). */
  async heartbeat(): Promise<boolean> {
    try {
      return (await this.d.kule.heartbeat()).ok === true;
    } catch {
      this.d.log?.("KULE kalp atışı başarısız.");
      return false;
    }
  }

  /** Tetikleyici varsa bir tur çalıştırır ve iz kaydını döndürür; yoksa null. */
  async onTick(): Promise<TraceRecord | null> {
    const trigger = await this.dueTrigger();
    return trigger ? this.runTurn(trigger) : null;
  }

  private async readWx(nowMs: number): Promise<WxMark | null> {
    try {
      const w = await this.d.weather.current(nowMs);
      return { cls: w.class, episodeStartTs: w.episode?.startTs ?? null };
    } catch {
      return null;
    }
  }

  async dueTrigger(): Promise<Trigger | null> {
    const nowMs = this.d.clock.nowMs();
    if (!this.started) return "start";
    if (this.answered) return "answer";
    if (this.finishedCycle !== null) {
      if (cycleIdOf(msToSec(nowMs)) === this.finishedCycle) return null;
      this.finishedCycle = null;
      return "tick";
    }
    for (const a of this.d.tools.state.authorizations.values()) {
      if (!a.executed && secToMs(a.openBy) <= nowMs && !this.notifiedExpired.has(a.actionId)) {
        this.notifiedExpired.add(a.actionId);
        return "expiry";
      }
    }
    const wx = await this.readWx(nowMs);
    if (wx && this.lastWx && (wx.cls !== this.lastWx.cls || wx.episodeStartTs !== this.lastWx.episodeStartTs)) return "alarm";
    return nowMs >= this.nextWakeMs ? "tick" : null;
  }

  /** Bir tur: LLM modu; LLM hiç kullanılamazsa aynı tur kural modunda (§10.1, §16 #13). */
  async runTurn(trigger: Trigger): Promise<TraceRecord> {
    const nowMs = this.d.clock.nowMs();
    this.started = true;
    this.answered = false;
    this.lastWx = (await this.readWx(nowMs)) ?? this.lastWx;
    const ctx = { turnNo: this.turnNo, trigger, nowMs };

    let outcome: TurnOutcome;
    let llmError: string | undefined;
    if (this.d.llm) {
      const r = await runLlmTurn(this.d.tools.beginTurn(), this.d.llm, ctx);
      if ("unavailable" in r) {
        llmError = r.unavailable;
        // LLM hiç araç çağırtmadı: tur temiz; kural modu yeni bir turla aynı korumalardan geçer.
        outcome = await runRuleTurn(this.d.tools.beginTurn(), nowMs);
      } else {
        outcome = r;
        llmError = r.llmError;
      }
    } else {
      outcome = await runRuleTurn(this.d.tools.beginTurn(), nowMs);
    }

    const record: TraceRecord = {
      v: 1,
      trace: {
        turn: this.turnNo,
        ts: nowMs,
        user: this.d.user,
        cycleId: cycleIdOf(msToSec(nowMs)),
        mode: outcome.mode,
        steps: outcome.steps,
        rationaleTr: outcome.rationaleTr,
      },
      labels: [...this.d.labels, ...(outcome.mode === "rules" ? [DEMO_LABELS.rulesMode] : [])],
      trigger,
      end: outcome.end,
      rejected: outcome.rejected,
      ...(llmError ? { llmError } : {}),
    };
    // İz yazılamazsa hata yükselir ve döngü durur (fail-closed): izsiz tur olmaz.
    await this.d.store.append(record);
    this.turnNo++;

    if (outcome.end.by === "bitir") this.finishedCycle = record.trace.cycleId;
    else this.nextWakeMs = outcome.end.untilMs;

    this.d.log?.(summarize(record));
    return record;
  }
}

/** Konsol satırı: tur, mod, adımlar, gerekçe. */
export function summarize(r: TraceRecord): string {
  const tools = r.trace.steps.map((s) => (s.error ? `${s.tool}✗` : s.tool)).join(" → ");
  const labels = r.labels.length ? ` [${r.labels.join(" · ")}]` : "";
  return `tur ${r.trace.turn} (${r.trigger}, ${r.trace.mode})${labels}: ${tools || "—"} | ${r.trace.rationaleTr}`;
}
