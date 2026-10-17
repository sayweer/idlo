/**
 * KULE'nin dışarı açtığı araçlar (§9.1) — bunun dışında hiçbir şey yok.
 * Bu araçlar LLM'e GÖSTERİLMEZ; PİLOT araç katmanı ve diğer MCP istemcileri kullanır (§10.2).
 */
import { z } from "zod";
import {
  EXECUTE_VERDICTS,
  EXEC_STATUSES,
  HEALTH_STATES,
  KULE_INSTRUMENTS,
  KULE_MODES,
  QUOTE_VERDICTS,
  TRADE_INST_ID,
  isKuleReasonCode,
  type KuleReasonCode,
} from "../codes.js";
import {
  ActionIdSchema,
  OkxDecimalSchema,
  OrdTypeSchema,
  PositiveTLSchema,
  TxHashSchema,
  UnixMsSchema,
} from "../schemas/primitives.js";
import { defineTool } from "./types.js";

export const KuleReasonCodeSchema = z.custom<KuleReasonCode>(isKuleReasonCode, { message: "geçersiz KULE gerekçe kodu" });

const Empty = z.strictObject({});

// ── kule_status ──
export const KuleStatusOutputSchema = z.strictObject({
  health: z.enum(HEALTH_STATES),
  reasons: z.array(KuleReasonCodeSchema),
  caa: z.strictObject({
    active: z.boolean(),
    lastRenewAt: UnixMsSchema.nullable(), // TODO(spec): birim belirtilmemiş; KULE yerel zamanı, ms seçildi
  }),
  pilotHeartbeatAgeSec: z.number().nonnegative().nullable(),
  dataAgeSec: z.strictObject({
    ticker: z.number().nonnegative().nullable(),
    book: z.number().nonnegative().nullable(),
  }),
  chain: z.strictObject({ ok: z.boolean(), block: z.int().nonnegative().nullable() }),
  mode: z.enum(KULE_MODES),
});

// ── kule_heartbeat ──
export const KuleHeartbeatOutputSchema = z.strictObject({ ok: z.boolean() });

// ── kule_market ──
/** TODO(spec): §9.1 `bar` değerlerini sınırlamıyor; Lira Hava Durumu yalnız 5m ve 1H kullanıyor (§11). */
export const KULE_MARKET_BARS = ["5m", "1H"] as const;
export const KuleMarketInputSchema = z
  .strictObject({
    instId: z.enum(KULE_INSTRUMENTS),
    kind: z.enum(["ticker", "orderbook", "candles"]),
    bar: z.enum(KULE_MARKET_BARS).optional(),
    limit: z.int().min(1).max(300).optional(), // TODO(spec): üst sınır OKX mum uç noktasının 300 sınırı
    after: z.string().regex(/^\d{1,16}$/, "after OKX ms zaman damgası olmalı").optional(),
  })
  .refine((v) => (v.kind === "candles") === (v.bar !== undefined), {
    message: "bar yalnız candles için ve candles için zorunlu",
    path: ["bar"],
  });
/** ATK yanıtı olduğu gibi döner (yalnız okuma). */
export const KuleMarketOutputSchema = z.unknown();

// ── kule_balance ──
/** TODO(spec): §9.1 yalnız "TRY ve USDT" diyor; §9.2-7 işlem/fon ayrımı gerektirdiği için iki hesap da döner. */
const BalanceEntry = z.strictObject({ trading: OkxDecimalSchema, funding: OkxDecimalSchema.nullable() });
export const KuleBalanceOutputSchema = z.strictObject({ TRY: BalanceEntry, USDT: BalanceEntry });

// ── kule_quote ──
export const KuleQuoteInputSchema = z.strictObject({
  side: z.literal("buy"),
  amountTL: PositiveTLSchema,
  ordType: OrdTypeSchema,
  px: OkxDecimalSchema.optional(),
  szHint: OkxDecimalSchema.optional(),
});
export const NormalizedOrderSchema = z.strictObject({
  instId: z.literal(TRADE_INST_ID),
  side: z.literal("buy"),
  ordType: OrdTypeSchema,
  px: OkxDecimalSchema,
  sz: OkxDecimalSchema, // USDT (limit/post_only/ioc alışta, §7)
});
export const KuleQuoteOutputSchema = z.strictObject({
  verdict: z.enum(QUOTE_VERDICTS),
  readback: z.string(),
  normalized: NormalizedOrderSchema.nullable(), // TODO(spec): RET'te normalize emir olmayabilir; null seçildi
  estFeeTL: z.number().nonnegative(),
  reasons: z.array(KuleReasonCodeSchema),
});

// ── kule_execute ──
export const KuleExecuteInputSchema = z.strictObject({ actionId: ActionIdSchema });
/** TODO(spec): §9.1 `status` değerlerini vermiyor; zincir rapor durumları + emir açılmadıysa NOT_PLACED. */
export const EXECUTE_STATUSES = [...EXEC_STATUSES, "NOT_PLACED"] as const;
export const KuleExecuteOutputSchema = z.strictObject({
  verdict: z.enum(EXECUTE_VERDICTS),
  clOrdId: z.string().regex(/^plt[1-9]\d*$/).max(32),
  ordId: z.string().min(1).optional(),
  status: z.enum(EXECUTE_STATUSES),
  readback: z.string(),
  reasons: z.array(KuleReasonCodeSchema),
  reportTx: TxHashSchema.optional(),
  paper: z.boolean(), // U-7: kâğıt modunda true; panelde "KÂĞIT" etiketi
});

// ── kule_cancel ──
export const KuleCancelInputSchema = z.union([
  z.strictObject({ actionId: ActionIdSchema }),
  z.strictObject({ all: z.literal(true) }),
]);
/** TODO(spec): §9.1 yalnız "iptal sonucu" diyor. */
export const KuleCancelOutputSchema = z.strictObject({
  ok: z.boolean(),
  canceled: z.array(z.string()), // iptal edilen clOrdId'ler
  reasons: z.array(KuleReasonCodeSchema),
});

export const KULE_TOOLS = {
  kule_status: defineTool({
    name: "kule_status",
    description: "KULE'nin sağlık durumu, CAA, kalp atışı yaşı, veri yaşı, zincir durumu ve modu.",
    input: Empty,
    output: KuleStatusOutputSchema,
  }),
  kule_heartbeat: defineTool({
    name: "kule_heartbeat",
    description: "PİLOT kalp atışı (15 saniyede bir).",
    input: Empty,
    output: KuleHeartbeatOutputSchema,
  }),
  kule_market: defineTool({
    name: "kule_market",
    description: "USDT-TRY ya da BTC-USDT piyasa verisi (ticker, tahta, mumlar); yalnız okuma.",
    input: KuleMarketInputSchema,
    output: KuleMarketOutputSchema,
  }),
  kule_balance: defineTool({
    name: "kule_balance",
    description: "TRY ve USDT bakiyesi (işlem ve fon hesabı); yalnız okuma.",
    input: Empty,
    output: KuleBalanceOutputSchema,
  }),
  kule_quote: defineTool({
    name: "kule_quote",
    description: "Alış teklifini birimleriyle okur ve normalize eder; emir göndermez. Sonuç ONAY, DÜZELT ya da RET.",
    input: KuleQuoteInputSchema,
    output: KuleQuoteOutputSchema,
  }),
  kule_execute: defineTool({
    name: "kule_execute",
    description: "Zincirde BuyAuthorized olan izni uygular; parametreleri zincirden okur. Sonuç ONAY, BEKLET ya da RET.",
    input: KuleExecuteInputSchema,
    output: KuleExecuteOutputSchema,
  }),
  kule_cancel: defineTool({
    name: "kule_cancel",
    description: "Bir iznin emrini ya da tüm açık emirleri iptal eder.",
    input: KuleCancelInputSchema,
    output: KuleCancelOutputSchema,
  }),
} as const;

export type KuleToolName = keyof typeof KULE_TOOLS;
export const KULE_TOOL_NAMES = Object.keys(KULE_TOOLS) as [KuleToolName, ...KuleToolName[]];
