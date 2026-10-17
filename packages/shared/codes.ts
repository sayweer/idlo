/**
 * Kodlar: zincir enum'ları (§8.1, §8.3, §8.4), KULE verdict / gerekçe / sağlık kodları (§9.1–§9.3),
 * Lira Hava Durumu sınıfları (§11). Türkçe metinler texts.ts'te.
 * Zincir uint8 değerleri contracts/src/interfaces/IFlightPlan.sol ile aynı sıradadır.
 */

function invalid(what: string, v: unknown): never {
  throw new RangeError(`${what}: geçersiz değer: ${String(v)}`);
}

// ─────────────────────────── Ret kodları (§8.3) ───────────────────────────

/** requestBuy ret kodları; değerler zincirdeki uint8 (IFlightPlan.RejectCode). 0 = ret yok, kullanılmaz. */
export const RejectCode = {
  PLAN_INACTIVE: 1,
  OUTSIDE_WINDOW: 2,
  OVER_ORDER_LIMIT: 3,
  OVER_CYCLE_TARGET: 4,
  PRICE_ABOVE_BAND: 5,
  PRICE_UNAVAILABLE: 6,
  BAD_ORDTYPE: 7,
} as const;
export type RejectCodeName = keyof typeof RejectCode;
export type RejectCodeValue = (typeof RejectCode)[RejectCodeName];
export const REJECT_CODE_NAMES = Object.keys(RejectCode) as [RejectCodeName, ...RejectCodeName[]];

/** Zincirdeki uint8 → ad. Bilinmeyen kod (0 dahil) fırlatır. */
export function rejectCodeName(code: number): RejectCodeName {
  const name = REJECT_CODE_NAMES.find((n) => RejectCode[n] === code);
  if (!name) invalid("RejectCode", code);
  return name;
}

// ─────────────────────── Zincir enum'ları (§8.1, §8.4) ───────────────────────

/** Kodda emir türü OKX adlarıyla; zincirde uint8 (0 post_only, 1 ioc). */
export const ORD_TYPES = ["post_only", "ioc"] as const;
export type OrdType = (typeof ORD_TYPES)[number];
export const OrdTypeChain = { post_only: 0, ioc: 1 } as const satisfies Record<OrdType, number>;

export function ordTypeToChain(t: OrdType): number {
  const v = OrdTypeChain[t];
  if (v === undefined) invalid("OrdType", t);
  return v;
}
export function ordTypeFromChain(v: number): OrdType {
  const t = ORD_TYPES[v];
  if (t === undefined || !Number.isInteger(v)) invalid("OrdType (zincir)", v);
  return t;
}

export const ACTION_STATES = ["AUTHORIZED", "REPORTED", "EXPIRED"] as const;
export type ActionState = (typeof ACTION_STATES)[number];
export function actionStateFromChain(v: number): ActionState {
  const s = ACTION_STATES[v];
  if (s === undefined || !Number.isInteger(v)) invalid("ActionState (zincir)", v);
  return s;
}

export const EXEC_STATUSES = ["FILLED", "PARTIAL", "CANCELED", "EXPIRED"] as const;
export type ExecStatus = (typeof EXEC_STATUSES)[number];
export function execStatusToChain(s: ExecStatus): number {
  const i = EXEC_STATUSES.indexOf(s);
  if (i < 0) invalid("ExecStatus", s);
  return i;
}
export function execStatusFromChain(v: number): ExecStatus {
  const s = EXEC_STATUSES[v];
  if (s === undefined || !Number.isInteger(v)) invalid("ExecStatus (zincir)", v);
  return s;
}

/** Plan.askMode: 0 sorma, 1 belirsizse sor. */
export const AskMode = { NEVER: 0, IF_AMBIGUOUS: 1 } as const;
export type AskModeValue = (typeof AskMode)[keyof typeof AskMode];

// ─────────────────────────── KULE (§9.1–§9.3) ───────────────────────────

/** KULE verdict'leri. DÜZELT yalnız kule_quote'ta, BEKLET yalnız kule_execute'ta. */
export const KULE_VERDICTS = ["ONAY", "DÜZELT", "RET", "BEKLET"] as const;
export type KuleVerdict = (typeof KULE_VERDICTS)[number];
export const QUOTE_VERDICTS = ["ONAY", "DÜZELT", "RET"] as const satisfies readonly KuleVerdict[];
export const EXECUTE_VERDICTS = ["ONAY", "BEKLET", "RET"] as const satisfies readonly KuleVerdict[];

/** KULE sağlık durumu (§9.3). */
export const HEALTH_STATES = ["NORMAL", "YENİ_EMİR_YOK", "YETKİ_YOK"] as const;
export type HealthState = (typeof HEALTH_STATES)[number];

/** Sağlık sebepleri (§9.3 "Ne zaman" sütunu). Gerekçede `HEALTH:<sebep>` biçiminde geçer. */
export const HealthReason = {
  DATA_STALE: "YENİ_EMİR_YOK",
  PILOT_HEARTBEAT: "YENİ_EMİR_YOK",
  CHAIN_UNREADABLE: "YENİ_EMİR_YOK",
  ORDER_UNCERTAIN: "YENİ_EMİR_YOK",
  PLAN_INACTIVE: "YETKİ_YOK",
} as const satisfies Record<string, Exclude<HealthState, "NORMAL">>;
export type HealthReasonName = keyof typeof HealthReason;
export const HEALTH_REASON_NAMES = Object.keys(HealthReason) as [HealthReasonName, ...HealthReasonName[]];

/**
 * KULE gerekçe kodları ve her birinin verdict'i (§9.1 DÜZELT örnekleri, §9.2 kontrol sırası, §16).
 * `HEALTH` gerekçede her zaman `HEALTH:<HealthReasonName>` olarak yazılır.
 */
export const KuleReason = {
  AUTH: "RET", // §9.2-1
  WRONG_AGENT: "RET", // §9.2-1, U-12
  ALREADY_EXECUTED: "RET", // §9.2-2, U-10
  HEALTH: "BEKLET", // §9.2-3
  NO_AUTHORIZATION: "RET", // §9.2-4, U-4, U-5
  TOO_LATE: "RET", // §9.2-5, U-13
  BAD_INSTRUMENT: "RET", // §9.2-6 — TODO(spec): SPEC bu ret için ad vermiyor
  BALANCE: "RET", // §9.2-7
  BALANCE_IN_FUNDING: "RET", // §9.2-7, U-15
  STALE_DATA: "BEKLET", // §9.2-8, §16 #10
  WIDE_SPREAD: "BEKLET", // §9.2-8, §16 #10
  ABOVE_MAX_PX: "BEKLET", // §9.2-8, U-6
  BELOW_MIN_SZ: "RET", // §9.2-9 — TODO(spec): SPEC ad ve verdict vermiyor; en dar seçenek RET
  UNCERTAIN_RESULT: "BEKLET", // §9.2-12 — TODO(spec): verdict belirtilmemiş; sağlık YENİ_EMİR_YOK olur
  SZ_LOOKS_LIKE_TL: "DÜZELT", // §9.1 kule_quote, U-2
  NOTIONAL_MISMATCH: "DÜZELT", // §9.1 kule_quote, U-3
} as const satisfies Record<string, KuleVerdict>;
export type KuleReasonName = keyof typeof KuleReason;
export const KULE_REASON_NAMES = Object.keys(KuleReason) as [KuleReasonName, ...KuleReasonName[]];

/** Gerekçe dizisindeki tek öğe: `KuleReasonName` ya da `HEALTH:<HealthReasonName>`. */
export type KuleReasonCode = Exclude<KuleReasonName, "HEALTH"> | `HEALTH:${HealthReasonName}`;

export function healthReasonCode(r: HealthReasonName): KuleReasonCode {
  if (!(r in HealthReason)) invalid("HealthReason", r);
  return `HEALTH:${r}`;
}

export function isKuleReasonCode(s: unknown): s is KuleReasonCode {
  if (typeof s !== "string") return false;
  if (s.startsWith("HEALTH:")) return HEALTH_REASON_NAMES.includes(s.slice(7) as HealthReasonName);
  return s !== "HEALTH" && KULE_REASON_NAMES.includes(s as KuleReasonName);
}

/** Gerekçe kodunun verdict'i. */
export function verdictOfReason(code: KuleReasonCode): KuleVerdict {
  if (!isKuleReasonCode(code)) invalid("KuleReason", code);
  return code.startsWith("HEALTH:") ? KuleReason.HEALTH : KuleReason[code as KuleReasonName];
}

/** KULE izin başına kalıcı durum (§9.2-2, CLAUDE.md kural 13). */
export const KULE_ACTION_STATES = ["RESERVED", "PLACED", "DONE", "REPORTED"] as const;
export type KuleActionState = (typeof KULE_ACTION_STATES)[number];

/** KULE çalışma modu (§9.1 kule_status). */
export const KULE_MODES = ["demo", "live", "paper"] as const;
export type KuleMode = (typeof KULE_MODES)[number];

/** İzin başına OKX clOrdId: "plt" + actionId (§9.2-11, §14). OKX sınırı: en fazla 32 alfanümerik karakter. */
export function clOrdIdFor(actionId: string): string {
  if (typeof actionId !== "string" || !/^[1-9]\d*$/.test(actionId)) invalid("actionId", actionId);
  const id = `plt${actionId}`;
  if (id.length > 32) invalid("clOrdId (32 karakteri aşıyor)", id);
  return id;
}

export function actionIdFromClOrdId(clOrdId: string): string {
  const m = typeof clOrdId === "string" ? /^plt([1-9]\d*)$/.exec(clOrdId) : null;
  if (!m || clOrdId.length > 32) invalid("clOrdId", clOrdId);
  return m[1]!;
}

/** KULE'nin dışarı açtığı enstrümanlar (§9.1, U-1). Emir yalnız USDT-TRY alışı. */
export const KULE_INSTRUMENTS = ["USDT-TRY", "BTC-USDT"] as const;
export type KuleInstrument = (typeof KULE_INSTRUMENTS)[number];
export const TRADE_INST_ID = "USDT-TRY" as const;

// ─────────────────────── Lira Hava Durumu (§11, §11.2) ───────────────────────

export const WEATHER_CLASSES = [
  "NORMAL",
  "TL_GUCLENDI",
  "KRIPTO_SISMESI",
  "PRIM_SISMESI",
  "BELIRSIZ",
  "LIRA_ZAYIFLADI",
] as const;
export type WeatherClass = (typeof WEATHER_CLASSES)[number];

/** Fırtına sınıfları (NORMAL dışı). */
export const STORM_CLASSES = ["TL_GUCLENDI", "KRIPTO_SISMESI", "PRIM_SISMESI", "BELIRSIZ", "LIRA_ZAYIFLADI"] as const;
export type StormClass = (typeof STORM_CLASSES)[number];

/** Yukarı yönlü bölüm sınıfları (§11.2-3); aşağı yönlü tek sınıf TL_GUCLENDI (§11.2-4). */
export const UP_STORM_CLASSES = ["KRIPTO_SISMESI", "PRIM_SISMESI", "LIRA_ZAYIFLADI", "BELIRSIZ"] as const;
export const EPISODE_DIRS = ["up", "down"] as const;
export type EpisodeDir = (typeof EPISODE_DIRS)[number];

export function episodeDirOf(cls: StormClass): EpisodeDir {
  if (!STORM_CLASSES.includes(cls)) invalid("StormClass", cls);
  return cls === "TL_GUCLENDI" ? "down" : "up";
}

/** zd alarm eşiği (§11: alarm = zd ≥ 8). */
export const ZD_ALARM = 8;
