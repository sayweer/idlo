/**
 * Birim dönüşümlerinin TEK yeri (SPEC §7, CLAUDE.md kural 7).
 *
 * - TL: tam lira. Zincirde uint64, kodda number (güvenli tamsayı). Kuruş yok.
 * - Fiyat (TRY/USDT): zincirde uint64 pxE6 = fiyat × 10^6; kodda pxE6 (number) ya da OKX `px` string.
 * - USDT: zincirde yok; kodda OKX formatında ondalık string.
 * - Zaman: zincir unix saniye, OKX milisaniye.
 * - Gün / ay / döngü: Türkiye saati, sabit UTC+3 (yaz saati yok). Döngü uint32 YYYYMM.
 *
 * Fail-closed: geçersiz girdide her fonksiyon UnitError fırlatır; sessizce yuvarlamaz.
 * Ondalık hesaplar string/bigint ile yapılır; float kayması yoktur.
 */

export type TL = number;
export type PxE6 = number;
export type UnixSec = number;
export type UnixMs = number;
export type CycleId = number;

export class UnitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnitError";
  }
}

function fail(message: string): never {
  throw new UnitError(message);
}

export const MAX_UINT64 = (1n << 64n) - 1n;
export const MAX_UINT32 = 0xffffffff;
export const PX_DECIMALS = 6;
const PX_SCALE = 10n ** BigInt(PX_DECIMALS);

// ─────────────────────────────── TL ───────────────────────────────

/** Tam lira doğrular: güvenli, negatif olmayan tamsayı. Kuruşlu değer reddedilir. */
export function assertTL(v: unknown, field = "TL"): TL {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
    fail(`${field}: tam lira (negatif olmayan güvenli tamsayı) olmalı, gelen: ${String(v)}`);
  }
  return v;
}

/** Pozitif tam lira (emir tutarı vb.). */
export function assertPositiveTL(v: unknown, field = "TL"): TL {
  const tl = assertTL(v, field);
  if (tl === 0) fail(`${field}: sıfırdan büyük olmalı`);
  return tl;
}

/** Yalnız rakamlardan oluşan string'i tam liraya çevirir ("20000" → 20000). "20.000", "20000,50" reddedilir. */
export function parseTL(s: string): TL {
  if (typeof s !== "string" || !/^(0|[1-9]\d*)$/.test(s)) fail(`TL: yalnız rakam olmalı, gelen: ${String(s)}`);
  return assertTL(Number(s));
}

export function tlToChain(tl: TL): bigint {
  return BigInt(assertTL(tl));
}

export function tlFromChain(v: bigint): TL {
  if (typeof v !== "bigint" || v < 0n || v > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail(`TL (zincir): güvenli aralık dışında: ${String(v)}`);
  }
  return Number(v);
}

/**
 * Tutarın yarısı (karar tablosu §10.4 `chunk/2`).
 * TODO(spec): SPEC tek sayıda yuvarlamayı belirtmiyor; en güvenli seçenek aşağı yuvarlamak (tavanı aşmaz).
 */
export function halfTL(tl: TL): TL {
  return Math.floor(assertTL(tl) / 2);
}

// ──────────────────────────── Ondalık string ────────────────────────────

const DEC_RE = /^(0|[1-9]\d*)(\.\d+)?$/;

/** OKX ondalık string'inin kesir hanesi sayısı ("0.0001" → 4). */
export function decimalPlaces(s: string): number {
  if (typeof s !== "string" || !DEC_RE.test(s)) fail(`ondalık: geçersiz biçim: ${String(s)}`);
  const dot = s.indexOf(".");
  return dot < 0 ? 0 : s.length - dot - 1;
}

/** "49.39", 6 → 49390000n. Ölçeğe sığmayan sıfır olmayan hane reddedilir (yuvarlama yok). */
export function decimalToScaled(s: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) fail(`ondalık: geçersiz ölçek ${decimals}`);
  if (typeof s !== "string" || !DEC_RE.test(s)) fail(`ondalık: geçersiz biçim: ${String(s)}`);
  const [int, frac = ""] = s.split(".") as [string, string?];
  if (frac.length > decimals && /[^0]/.test(frac.slice(decimals))) {
    fail(`ondalık: ${decimals} haneden fazla kesir: ${s}`);
  }
  return BigInt(int + frac.slice(0, decimals).padEnd(decimals, "0"));
}

/** 49390000n, 6 → "49.39". Sondaki sıfırlar atılır. */
export function scaledToDecimal(v: bigint, decimals: number): string {
  if (typeof v !== "bigint" || v < 0n) fail(`ondalık: negatif olmayan bigint olmalı: ${String(v)}`);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) fail(`ondalık: geçersiz ölçek ${decimals}`);
  if (decimals === 0) return v.toString();
  const s = v.toString().padStart(decimals + 1, "0");
  const int = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
}

// ─────────────────────────────── Fiyat ───────────────────────────────

/** pxE6 doğrular: negatif olmayan güvenli tamsayı (0 yalnız "dolum yok" ortalaması için anlamlı). */
export function assertPxE6(v: unknown, field = "pxE6"): PxE6 {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
    fail(`${field}: negatif olmayan güvenli tamsayı olmalı, gelen: ${String(v)}`);
  }
  return v;
}

export function assertPositivePxE6(v: unknown, field = "pxE6"): PxE6 {
  const p = assertPxE6(v, field);
  if (p === 0) fail(`${field}: sıfırdan büyük olmalı`);
  return p;
}

/** OKX `px` string → pxE6 ("49.39" → 49390000). Sıfır ve 6 haneden ince fiyat reddedilir. */
export function pxToPxE6(px: string): PxE6 {
  const v = decimalToScaled(px, PX_DECIMALS);
  if (v === 0n) fail(`px: sıfırdan büyük olmalı: ${px}`);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) fail(`px: çok büyük: ${px}`);
  return Number(v);
}

/** pxE6 → OKX `px` string (49390000 → "49.39"). */
export function pxE6ToPx(pxE6: PxE6): string {
  return scaledToDecimal(BigInt(assertPositivePxE6(pxE6)), PX_DECIMALS);
}

export function pxE6ToChain(pxE6: PxE6): bigint {
  return BigInt(assertPxE6(pxE6));
}

export function pxE6FromChain(v: bigint): PxE6 {
  if (typeof v !== "bigint" || v < 0n || v > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail(`pxE6 (zincir): güvenli aralık dışında: ${String(v)}`);
  }
  return Number(v);
}

/** Fiyatı borsa adımına (tickSz) AŞAĞI yuvarlar (§9.2 adım 8, floorTick). Sonuç 0 olursa reddedilir. */
export function floorToTick(pxE6: PxE6, tickSz: string): PxE6 {
  const px = BigInt(assertPositivePxE6(pxE6));
  const tick = decimalToScaled(tickSz, PX_DECIMALS);
  if (tick === 0n) fail(`tickSz: sıfır ya da 6 haneden ince: ${tickSz}`);
  const out = (px / tick) * tick;
  if (out === 0n) fail(`floorToTick: sonuç sıfır (px ${pxE6}, tickSz ${tickSz})`);
  return Number(out);
}

/** Fiyat adıma uyuyor mu? */
export function isOnTick(pxE6: PxE6, tickSz: string): boolean {
  return floorToTick(pxE6, tickSz) === pxE6;
}

// ─────────────────────────────── Boyut (sz) ───────────────────────────────

/**
 * Limit / post_only / ioc alışta `sz` (USDT, OKX formatı) — §9.2 adım 9:
 * sz = floor((amountTL / px) / lotSz) × lotSz, sz ≥ minSz, sz × px ≤ amountTL.
 * CLAUDE.md kural 9: `sz`'yi yalnız KULE hesaplar; bu fonksiyonu yalnız KULE çağırır.
 */
export function limitBuySz(args: { amountTL: TL; pxE6: PxE6; lotSz: string; minSz: string }): string {
  const amount = BigInt(assertPositiveTL(args.amountTL, "amountTL"));
  const px = BigInt(assertPositivePxE6(args.pxE6));
  const d = Math.max(decimalPlaces(args.lotSz), decimalPlaces(args.minSz));
  const lot = decimalToScaled(args.lotSz, d);
  const min = decimalToScaled(args.minSz, d);
  if (lot === 0n) fail(`lotSz: sıfırdan büyük olmalı: ${args.lotSz}`);
  const scale = 10n ** BigInt(d);
  const budget = amount * PX_SCALE * scale; // TL × 10^6 × 10^d
  const sz = ((budget / px) / lot) * lot;
  if (sz === 0n || sz < min) fail(`sz: en küçük miktarın (${args.minSz} USDT) altında`);
  if (sz * px > budget) fail("sz × px tutarı aşıyor"); // savunma; tabandan dolayı olmamalı
  return scaledToDecimal(sz, d);
}

/** Piyasa alışında `sz` TL'dir (§7 sz kuralı). Yalnız KULE çağırır. */
export function marketBuySzTL(amountTL: TL): string {
  return String(assertPositiveTL(amountTL, "amountTL"));
}

/** sz (USDT string) × px → TL × 10^6 (aşağı yuvarlanmış, tam). */
export function notionalTLE6(sz: string, pxE6: PxE6): bigint {
  const d = decimalPlaces(sz);
  return (decimalToScaled(sz, d) * BigInt(assertPositivePxE6(pxE6))) / 10n ** BigInt(d);
}

/** |sz × px − amountTL| / amountTL, baz puan (aşağı yuvarlanmış). U-3: > 100 bp ise DÜZELT. */
export function notionalDeviationBps(sz: string, pxE6: PxE6, amountTL: TL): number {
  const expected = BigInt(assertPositiveTL(amountTL, "amountTL")) * PX_SCALE;
  const actual = notionalTLE6(sz, pxE6);
  const diff = actual > expected ? actual - expected : expected - actual;
  const bps = (diff * 10000n) / expected;
  return bps > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(bps);
}

// ─────────────────────────────── Zaman ───────────────────────────────

export function assertUnixSec(v: unknown, field = "unixSec"): UnixSec {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
    fail(`${field}: negatif olmayan tamsayı saniye olmalı, gelen: ${String(v)}`);
  }
  return v;
}

export function assertUnixMs(v: unknown, field = "unixMs"): UnixMs {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
    fail(`${field}: negatif olmayan tamsayı milisaniye olmalı, gelen: ${String(v)}`);
  }
  return v;
}

/** Zincir saniyesi → OKX milisaniyesi. */
export function secToMs(sec: UnixSec): UnixMs {
  return assertUnixMs(assertUnixSec(sec) * 1000);
}

/** OKX milisaniyesi → zincir saniyesi (aşağı yuvarlanır). */
export function msToSec(ms: UnixMs): UnixSec {
  return Math.floor(assertUnixMs(ms) / 1000);
}

/** OKX zaman damgası string'i ("1722820500000") → ms. */
export function parseOkxTs(s: string): UnixMs {
  if (typeof s !== "string" || !/^\d{1,16}$/.test(s)) fail(`OKX ts: geçersiz: ${String(s)}`);
  return assertUnixMs(Number(s));
}

export function chainSecFromBigInt(v: bigint): UnixSec {
  if (typeof v !== "bigint" || v < 0n || v > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail(`zaman (zincir): güvenli aralık dışında: ${String(v)}`);
  }
  return Number(v);
}

// ─────────────────────────────── Süre ───────────────────────────────
// Dakika / saat / gün süreleri yalnız buradan saniyeye / ms'ye çevrilir (CLAUDE.md kural 7).
// Girdi negatif olmayan güvenli tamsayıdır; kesirli süre reddedilir (sessiz yuvarlama yok).

export const MINUTE_SEC = 60;
export const HOUR_SEC = 60 * MINUTE_SEC;
export const DAY_SEC = 24 * HOUR_SEC;

function durationSec(n: unknown, unitSec: number, field: string): UnixSec {
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) {
    fail(`${field}: negatif olmayan tamsayı olmalı, gelen: ${String(n)}`);
  }
  return assertUnixSec(n * unitSec, field);
}

export function minutesToSec(minutes: number): UnixSec {
  return durationSec(minutes, MINUTE_SEC, "dakika");
}

export function hoursToSec(hours: number): UnixSec {
  return durationSec(hours, HOUR_SEC, "saat");
}

export function daysToSec(days: number): UnixSec {
  return durationSec(days, DAY_SEC, "gün");
}

export function minutesToMs(minutes: number): UnixMs {
  return secToMs(minutesToSec(minutes));
}

export function hoursToMs(hours: number): UnixMs {
  return secToMs(hoursToSec(hours));
}

/** Saniye süresi → dakika, YUKARI yuvarlanır (bekleme süresi kısa kesilmez). */
export function secToMinutesCeil(sec: UnixSec): number {
  return Math.ceil(assertUnixSec(sec, "saniye") / MINUTE_SEC);
}

/** İki OKX ms anı arasındaki süre, saniye (kesirli olabilir; ör. kalp atışı yaşı). Geri giden saat reddedilir. */
export function elapsedSec(fromMs: UnixMs, toMs: UnixMs): number {
  const d = assertUnixMs(toMs, "toMs") - assertUnixMs(fromMs, "fromMs");
  if (d < 0) fail(`süre negatif olamaz: ${fromMs} → ${toMs}`);
  return d / secToMs(1);
}

/** Gün içi saat → gece yarısından bu yana dakika (18:00 → 1080). */
export function clockMinutes(hour: number, minute: number): number {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) fail(`saat: geçersiz ${hour}`);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) fail(`dakika: geçersiz ${minute}`);
  return hour * 60 + minute;
}

// ──────────────────────── Türkiye saati (sabit UTC+3) ────────────────────────

export const TR_UTC_OFFSET_SEC = 3 * HOUR_SEC;

export interface TrParts {
  year: number;
  month: number; // 1–12
  day: number; // 1–31
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 pazar … 6 cumartesi
}

/** Unix saniyesini Türkiye saatine (sabit UTC+3) ayırır. */
export function trParts(sec: UnixSec): TrParts {
  const d = new Date((assertUnixSec(sec) + TR_UTC_OFFSET_SEC) * 1000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    weekday: d.getUTCDay(),
  };
}

/** Ayın günü, TR saati (kontrattaki trDay ile aynı; F-10: UTC 21:00'de sonraki güne geçer). */
export function trDay(sec: UnixSec): number {
  return trParts(sec).day;
}

export function daysInMonth(year: number, month: number): number {
  if (!Number.isInteger(year) || year < 1970 || year > 9999) fail(`yıl: geçersiz ${year}`);
  if (!Number.isInteger(month) || month < 1 || month > 12) fail(`ay: geçersiz ${month}`);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** TR saatindeki tarih/saat → unix saniye. Geçersiz gün (ör. 31 Şubat) reddedilir. */
export function trDateToSec(year: number, month: number, day: number, hour = 0, minute = 0): UnixSec {
  const dim = daysInMonth(year, month);
  if (!Number.isInteger(day) || day < 1 || day > dim) fail(`gün: geçersiz ${year}-${month}-${day}`);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) fail(`saat: geçersiz ${hour}`);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) fail(`dakika: geçersiz ${minute}`);
  return assertUnixSec(Date.UTC(year, month - 1, day, hour, minute) / 1000 - TR_UTC_OFFSET_SEC);
}

/** Döngü kimliği doğrular: uint32 YYYYMM, ay 1–12. */
export function assertCycleId(v: unknown): CycleId {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > MAX_UINT32) fail(`cycleId: uint32 olmalı: ${String(v)}`);
  const year = Math.floor(v / 100);
  const month = v % 100;
  if (year < 1970 || year > 9999 || month < 1 || month > 12) fail(`cycleId: YYYYMM olmalı: ${v}`);
  return v;
}

/** Döngü kimliği (YYYYMM, TR saatine göre). */
export function cycleIdOf(sec: UnixSec): CycleId {
  const p = trParts(sec);
  return assertCycleId(p.year * 100 + p.month);
}

export function cycleIdParts(id: CycleId): { year: number; month: number } {
  const v = assertCycleId(id);
  return { year: Math.floor(v / 100), month: v % 100 };
}

/**
 * `deadlineDay` gününün sonu (TR saatiyle ertesi gün 00:00), şimdiki TR ayında, unix saniye.
 * Ayda olmayan gün (ör. 30 Şubat) reddedilir.
 */
export function deadlineEndSec(nowSec: UnixSec, deadlineDay: number): UnixSec {
  const p = trParts(nowSec);
  return trDateToSec(p.year, p.month, deadlineDay) + DAY_SEC;
}

/** Son günün sonuna kalan saat (§10.4 `hoursToDeadline`); geçmişse negatif. */
export function hoursToDeadline(nowSec: UnixSec, deadlineDay: number): number {
  return (deadlineEndSec(nowSec, deadlineDay) - nowSec) / HOUR_SEC;
}

// ──────────────────────── Türkçe sayı biçimi (gösterim) ────────────────────────

function groupThousands(int: string): string {
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/** 10000 → "10.000" */
export function formatTL(tl: TL): string {
  return groupThousands(String(assertTL(tl)));
}

/** "202.6403" → "202,64" (maxFrac = 2). Kesir aşağı kesilir; yuvarlama yukarı taşımaz. */
export function formatDecimalTr(dec: string, maxFrac = 2): string {
  decimalPlaces(dec); // biçim doğrulaması
  const [int, frac = ""] = dec.split(".") as [string, string?];
  const f = frac.slice(0, Math.max(0, maxFrac)).replace(/0+$/, "");
  return f ? `${groupThousands(int)},${f}` : groupThousands(int);
}

/** 49350000 → "49,35" */
export function formatPxTr(pxE6: PxE6, maxFrac = 2): string {
  return formatDecimalTr(pxE6ToPx(pxE6), maxFrac);
}
