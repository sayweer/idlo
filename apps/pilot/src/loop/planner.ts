/**
 * Bir tur (§10.1): LLM planlama oturumu ya da kural modu. İkisi de YALNIZ PilotTurn üzerinden çalışır; araç adı,
 * girdi şeması ve korumalar orada koddadır (CLAUDE.md kural 1). Bu dosya yalnız sırayı ve izi kurar.
 *
 * - LLM modu: Claude araç kullanımı (elle döngü). Her tool_use bloğu PilotTurn.call'a gider; bilinmeyen araç ya da
 *   geçersiz girdi kayıtlı hatadır, işlem yapılmaz. LLM'in metni yalnız gerekçe olarak ize yazılır.
 * - Kural modu (§10.1 "LLM erişilemezse", §16 #13): aynı araçlar sabit sırayla; kural_danis'in önerdiği seçenek
 *   uygulanır. Gerekçe kısa kod metnidir ve "LLM yok, kural modu" etiketi taşır.
 * - Fail-closed (kural 2): zincir/KULE hatasında ya da beklenmeyen sonuçta yeni adım atılmaz, tur bekle ile kapanır.
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  DEMO_LABELS,
  MAX_TOOL_CALLS_PER_TURN,
  PILOT_TOOL_NAMES,
  kuleReasonText,
  parseOptionId,
  pxToPxE6,
  trParts,
  msToSec,
  type KuralDanisOutput,
  type KuleReasonCode,
  type PilotToolName,
  type TraceStep,
} from "@pilot/shared";
import { HOLD_WAIT_MIN } from "../rules/index.js";
import type { PilotTurn, ToolCallResult } from "../tools/index.js";
import type { RejectedCall, Trigger, TurnEndRecord } from "../trace/index.js";
import { baseParams, type LlmClient } from "./llm.js";

/** TraceSchema.rationaleTr üst sınırı. */
const RATIONALE_MAX = 1000;
/** İzdeki ham (doğrulanmamış) girdi bundan büyükse yazılmaz. TODO(spec): SPEC iz boyutu vermiyor. */
const RAW_INPUT_MAX_JSON = 2000;
/**
 * Kural modunda BEKLE (pencere açılmadı/kapandı) ve soru sonrası bekleme (dk).
 * TODO(spec): §10.4 BEKLE için süre vermiyor; tetikleyiciler (alarm, cevap) turu erken uyandırır. 60 dk seçildi.
 */
export const RULE_IDLE_WAIT_MIN = 60;
/** LLM istek sınırı: her istek ≥ 1 araç çağrısı harcar; 8 çağrı + kapanış için bir istek. */
export const MAX_LLM_REQUESTS = MAX_TOOL_CALLS_PER_TURN + 1;

export interface TurnContext {
  turnNo: number;
  trigger: Trigger;
  nowMs: number;
}

export interface TurnOutcome {
  mode: "llm" | "rules";
  steps: TraceStep[];
  rejected: RejectedCall[];
  rationaleTr: string;
  end: TurnEndRecord;
  llmError?: string;
}

const TRIGGER_TEXTS: Record<Trigger, string> = {
  start: "PİLOT başladı",
  tick: "5 dakikalık döngü",
  alarm: "Lira Hava Durumu değişti",
  answer: "Elif soruya cevap verdi",
  expiry: "Bekleyen bir iznin süresi doldu",
};

function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isPilotToolName(n: string): n is PilotToolName {
  return (PILOT_TOOL_NAMES as readonly string[]).includes(n);
}

/** Ham girdi ize yalnız küçük bir nesneyse yazılır (LLM'in uzun metni izi şişirmesin). */
function smallRecord(v: unknown): Record<string, unknown> | undefined {
  if (!isRecord(v)) return undefined;
  try {
    return JSON.stringify(v).length <= RAW_INPUT_MAX_JSON ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Turun araç çağrıları ve izi. Tur sınırı/kapanış PilotTurn'de de var; burada adımı ize yazmadan önce kontrol. */
class StepLog {
  readonly steps: TraceStep[] = [];
  readonly rejected: RejectedCall[] = [];

  async call(turn: PilotTurn, name: string, input: unknown): Promise<ToolCallResult> {
    if (turn.ended || turn.calls >= MAX_TOOL_CALLS_PER_TURN) {
      const error = turn.ended
        ? "Tur kapandı; yeni araç çağrısı yapılmaz."
        : `Bir turda en fazla ${MAX_TOOL_CALLS_PER_TURN} araç çağrısı yapılabilir.`;
      this.rejected.push({ tool: clip(String(name), 200), error });
      return { ok: false, tool: String(name), error };
    }
    const r = await turn.call(name, input);
    if (!isPilotToolName(r.tool)) {
      this.rejected.push({ tool: clip(r.tool, 200), error: clip(r.ok ? "" : r.error, 500) });
      return r;
    }
    if (r.ok) {
      const step: TraceStep = { tool: r.tool, out: isRecord(r.out) ? r.out : { value: r.out } };
      if (Object.keys(r.in).length > 0) step.in = r.in;
      this.steps.push(step);
    } else {
      const step: TraceStep = { tool: r.tool, error: clip(r.error, 500) };
      const raw = smallRecord(r.in);
      if (raw && Object.keys(raw).length > 0) step.in = raw;
      this.steps.push(step);
    }
    return r;
  }
}

function endOf(turn: PilotTurn): TurnEndRecord | null {
  const e = turn.ended;
  if (!e) return null;
  return e.tool === "bekle" ? { by: "bekle", untilMs: e.untilMs, gerekce: e.gerekce } : { by: "bitir", ozet: e.ozet };
}

/** Tur kapanmadıysa kod kapatır: önce bekle aracıyla (izde adım olur), olmazsa kendi kaydıyla. Hiç işlem yok. */
async function closeByCode(turn: PilotTurn, log: StepLog, nowMs: number, gerekce: string): Promise<TurnEndRecord> {
  const done = endOf(turn);
  if (done) return done;
  if (turn.calls < MAX_TOOL_CALLS_PER_TURN) await log.call(turn, "bekle", { dakika: HOLD_WAIT_MIN, gerekce });
  return endOf(turn) ?? { by: "code", untilMs: nowMs + HOLD_WAIT_MIN * 60_000, gerekce };
}

function trTime(nowMs: number): string {
  const p = trParts(msToSec(nowMs));
  const two = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${two(p.month)}-${two(p.day)} ${two(p.hour)}:${two(p.minute)}`;
}

/** Turun ilk kullanıcı mesajı. Değişken bilgi burada (sistem istemi sabit kalır). */
export function turnPrompt(ctx: TurnContext): string {
  return (
    `Tur ${ctx.turnNo}. Tetikleyici: ${TRIGGER_TEXTS[ctx.trigger]}. Şimdi (Türkiye saati): ${trTime(ctx.nowMs)}. ` +
    "Araçlarla durumu öğren, kural_danis'in izin verdiği seçeneklerden birini uygula ve turu bekle ya da bitir ile kapat."
  );
}

/**
 * LLM yanıtının kullanılan alanları (kural 1: LLM çıktısı her zaman doğrulanır). tool_use adı/girdisi burada
 * serbesttir; onları PilotTurn.call doğrular (bilinmeyen ad kayıtlı hatadır). Diğer blok türleri olduğu gibi geçer.
 */
const LlmResponseSchema = z.looseObject({
  stop_reason: z.string().nullable(),
  content: z.array(
    z.union([
      z.looseObject({ type: z.literal("text"), text: z.string() }),
      z.looseObject({ type: z.literal("tool_use"), id: z.string().min(1), name: z.unknown(), input: z.unknown() }),
      z.looseObject({ type: z.string().refine((t) => t !== "text" && t !== "tool_use") }),
    ]),
  ),
});

/** LLM hatasının kısa ve güvenli metni (yanıt gövdesi ya da başlıklar ize yazılmaz). */
function llmErrorText(e: unknown): string {
  if (e instanceof Anthropic.APIError) return `LLM API hatası (${e.status ?? "bağlantı"})`;
  return "LLM çağrısı başarısız";
}

// ─────────────────────────────── LLM modu ───────────────────────────────

/**
 * LLM turu. LLM hiç araç çağrısı yaptırmadan kullanılamaz olursa `{ unavailable }` döner; çağıran turu kural
 * modunda yeniden kurar. Araç çalıştıktan sonra LLM düşerse tur kodla kapanır (aynı turda ikinci bir plan yok).
 */
export async function runLlmTurn(
  turn: PilotTurn,
  llm: LlmClient,
  ctx: TurnContext,
): Promise<TurnOutcome | { unavailable: string }> {
  const log = new StepLog();
  const texts: string[] = [];
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: turnPrompt(ctx) }];
  let llmError: string | undefined;

  for (let i = 0; i < MAX_LLM_REQUESTS && !turn.ended; i++) {
    let msg: Anthropic.Message | null = null;
    try {
      const raw = await llm.create(baseParams(llm.model, messages));
      // Şekli bozuk yanıt API hatası gibidir: hiçbir tool_use çalıştırılmaz (§10.1, §16 #13).
      if (LlmResponseSchema.safeParse(raw).success) msg = raw;
      else llmError = "LLM yanıtı doğrulanamadı";
    } catch (e) {
      llmError = llmErrorText(e);
    }
    // Ret ya da kesilmiş yanıt: araç girdisi yarım olabilir, hiçbir tool_use çalıştırılmaz.
    const cut = msg?.stop_reason === "max_tokens" || msg?.stop_reason === "model_context_window_exceeded";
    if (msg && (msg.stop_reason === "refusal" || cut)) {
      llmError = msg.stop_reason === "refusal" ? "LLM isteği reddetti" : "LLM yanıtı kesildi";
    }
    if (llmError || !msg) {
      if (turn.calls === 0) return { unavailable: llmError ?? "LLM yanıtı yok" };
      break;
    }
    for (const b of msg.content) if (b.type === "text" && b.text.trim()) texts.push(b.text.trim());
    const uses = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (uses.length === 0) break;

    messages.push({ role: "assistant", content: msg.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    // Paralel çağrılar bile sırayla çalışır (izin → emir sırası korunur).
    for (const u of uses) {
      const r = await log.call(turn, u.name, u.input);
      results.push({
        type: "tool_result",
        tool_use_id: u.id,
        content: JSON.stringify(r.ok ? r.out : { hata: r.error }),
        ...(r.ok ? {} : { is_error: true }),
      });
    }
    messages.push({ role: "user", content: results });
  }

  const end = await closeByCode(
    turn,
    log,
    ctx.nowMs,
    llmError ? `${llmError}; tur kodla kapatıldı, işlem yok.` : "LLM turu bekle ya da bitir ile kapatmadı; kod bekletti.",
  );
  const fallback = end.by === "bitir" ? end.ozet : end.gerekce;
  return {
    mode: "llm",
    steps: log.steps,
    rejected: log.rejected,
    rationaleTr: clip(texts.join(" ") || fallback, RATIONALE_MAX),
    end,
    ...(llmError ? { llmError } : {}),
  };
}

// ─────────────────────────────── Kural modu ───────────────────────────────

type QuoteOut = { verdict: string; normalized: { px: string } | null; reasons: KuleReasonCode[] };
type IzinOut = { status: "AUTHORIZED"; actionId: string } | { status: "REJECTED"; message: string } | { status: "REFUSED"; message: string };
type ExecOut = { verdict: string; readback: string; reasons: KuleReasonCode[] };

const reasonsText = (rs: KuleReasonCode[]) => rs.map(kuleReasonText).join(" ");
/** Cümle sonuna nokta (zaten noktalıysa ikinci nokta yok). */
const sentence = (s: string) => (/[.!?…]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

/**
 * Kural modu: plan_oku → hava_durumu → kural_danis → önerilen seçenek (§10.1). Önerilen alım için
 * teklif_al → izin_iste (maxPx = teklif fiyatı) → emri_uygula. Bir adım başarısızsa sonraki adım atılmaz.
 * TODO(spec): §10.1 maxPx'i yazmıyor; kural modunda en dar seçim teklif fiyatının kendisi (pay yok).
 */
export async function runRuleTurn(turn: PilotTurn, nowMs: number): Promise<TurnOutcome> {
  const log = new StepLog();
  const notes: string[] = [];
  let advice: KuralDanisOutput | null = null;

  const finish = async (fallbackWhy: string): Promise<TurnOutcome> => {
    const end = await closeByCode(turn, log, nowMs, `${DEMO_LABELS.rulesMode}: ${fallbackWhy}`);
    const head = advice ? advice.reason : "Karar tablosu okunamadı; emir yok";
    return {
      mode: "rules",
      steps: log.steps,
      rejected: log.rejected,
      rationaleTr: clip([sentence(`${DEMO_LABELS.rulesMode}: ${head}`), ...notes.map(sentence)].join(" "), RATIONALE_MAX),
      end,
    };
  };

  await log.call(turn, "plan_oku", {});
  await log.call(turn, "hava_durumu", {});
  const k = await log.call(turn, "kural_danis", {});
  if (!k.ok) return finish("karar tablosu okunamadı");
  advice = k.out as KuralDanisOutput;
  const rec = parseOptionId(advice.recommended);
  const gerekce = clip(advice.reason, 500);

  switch (rec.kind) {
    case "WAIT":
      await log.call(turn, "bekle", { dakika: rec.minutes, gerekce });
      return finish(gerekce);
    case "BEKLE":
      await log.call(turn, "bekle", { dakika: RULE_IDLE_WAIT_MIN, gerekce });
      return finish(gerekce);
    case "BITIR":
      await log.call(turn, "bitir", { ozet: gerekce });
      return finish(gerekce);
    case "ASK": {
      const secenekler = advice.allowed.filter((o) => o !== "ASK");
      const q = await log.call(turn, "kullaniciya_sor", { soru: clip(`${advice.reason}. Ne yapayım?`, 300), secenekler });
      if (!q.ok) {
        notes.push("Soru sorulamadı.");
        return finish("soru sorulamadı");
      }
      await log.call(turn, "bekle", { dakika: RULE_IDLE_WAIT_MIN, gerekce: "Elif'in cevabı bekleniyor." });
      return finish("Elif'in cevabı bekleniyor");
    }
    case "BUY": {
      const q = await log.call(turn, "teklif_al", { amountTL: rec.amountTL, ordType: rec.ordType });
      const quote = q.ok ? (q.out as QuoteOut) : null;
      if (!quote || quote.verdict !== "ONAY" || !quote.normalized) {
        notes.push(quote ? `Teklif ${quote.verdict}: ${reasonsText(quote.reasons)}` : "Teklif alınamadı");
        return finish("teklif onaylanmadı, emir yok");
      }
      const iz = await log.call(turn, "izin_iste", {
        amountTL: rec.amountTL,
        maxPxE6: pxToPxE6(quote.normalized.px),
        ordType: rec.ordType,
        gerekce,
      });
      const izin = iz.ok ? (iz.out as IzinOut) : null;
      if (!izin || izin.status !== "AUTHORIZED") {
        notes.push(izin ? `İzin verilmedi: ${izin.message}` : "İzin isteği başarısız.");
        return finish("izin yok, emir yok");
      }
      const ex = await log.call(turn, "emri_uygula", { actionId: izin.actionId });
      const exec = ex.ok ? (ex.out as ExecOut) : null;
      notes.push(
        exec
          ? exec.verdict === "ONAY"
            ? exec.readback
            : `Emir ${exec.verdict}: ${reasonsText(exec.reasons)}`
          : "Emir sonucu alınamadı",
      );
      return finish("emir sonrası döngü bekleniyor");
    }
  }
}
