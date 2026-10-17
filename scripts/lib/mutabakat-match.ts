/**
 * Mutabakat eşleştirmesi (§14): borsa emirleri ↔ zincirdeki izinler ve raporlar. Saf fonksiyon; ağ yok.
 *
 * Eşleştirme anahtarı clOrdId = "plt" + actionId (§9.2-11, §14). Kural:
 * - Borsadaki her USDT-TRY emri Elif'in bir BuyAuthorized iznine bağlanmalı; bağlanmıyorsa ALARM
 *   (BORSADA VAR, ZİNCİRDE YOK). clOrdId'siz ya da "plt" biçiminde olmayan emir de buna girer (fail-closed).
 * - İzin + emir + rapor: tutar ve fiyat %0,5 içinde ve ordId aynıysa EŞLEŞTİ; değilse ALARM (SONUÇ FARKLI).
 * - İzin var, emir yok: bilgi (ZİNCİRDE VAR, BORSADA YOK); ama rapor dolum gösteriyorsa ALARM (SONUÇ FARKLI).
 *
 * Emir izinle de karşılaştırılır (yön, emir türü, en yüksek fiyat, tutar, zaman); uymazsa ALARM (SONUÇ FARKLI).
 * TODO(spec): §14 bu karşılaştırmaları ayrıca yazmıyor; izinsiz emri yakalamak için en dar seçim olarak eklendi.
 */
import {
  actionIdFromClOrdId,
  decimalToScaled,
  EXEC_STATUS_TEXTS,
  formatDecimalTr,
  formatPxTr,
  formatTL,
  minutesToSec,
  notionalTLE6,
  ORD_TYPES,
  parseOkxTs,
  PX_DECIMALS,
  pxToPxE6,
  scaledToDecimal,
  secToMs,
  TRADE_INST_ID,
  type TL,
} from "@pilot/shared";
import type { ChainAuthorized, ChainExecuted, ChainSnapshot } from "./mutabakat-chain.js";
import { isOpenOrder, type OkxOrder } from "./okx-readonly.js";

/** §8.3: openBy = izin anı + 15 dk; reportBy = openBy + 60 dk (FlightPlan.OPEN_WINDOW / REPORT_WINDOW). */
export const OPEN_WINDOW_SEC = minutesToSec(15);
export const REPORT_WINDOW_SEC = minutesToSec(60);

/** §14: tutar ve fiyat %0,5 içinde. */
export const MATCH_TOLERANCE_BP = 50n;
/**
 * Zincirde TL tam liradır (kural 7); rapor kuruşu atar. TODO(spec): küçük demo tutarlarında (ör. 150 TL) %0,5 < 1 TL;
 * en dar seçim: tutar farkı 1 TL'ye kadar da eşleşir. Fiyat için ek pay yok.
 */
export const TL_ROUNDING_E6 = 1_000_000n;
/** TODO(spec): OKX saati ile blok zamanı arasındaki kayma payı (emir zamanı ↔ izin penceresi). En dar makul: 60 sn. */
export const CLOCK_SKEW_SEC = 60;

export const MATCH_STATUSES = ["MATCHED", "CHAIN_ONLY", "EXCHANGE_ONLY", "MISMATCH", "PENDING"] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

/** Ekrandaki adlar (§14 tablosu). PENDING: emir açık ya da rapor penceresi sürüyor (bilgi). */
export const MATCH_STATUS_TEXTS: Record<MatchStatus, string> = {
  MATCHED: "EŞLEŞTİ",
  CHAIN_ONLY: "ZİNCİRDE VAR, BORSADA YOK",
  EXCHANGE_ONLY: "BORSADA VAR, ZİNCİRDE YOK",
  MISMATCH: "SONUÇ FARKLI",
  PENDING: "RAPOR BEKLENİYOR", // TODO(spec): §14'te yok; rapor penceresi kapanmadan sonuç verilmez
};

export const ALARM_STATUSES: ReadonlySet<MatchStatus> = new Set(["EXCHANGE_ONLY", "MISMATCH"]);

export interface MatchRow {
  status: MatchStatus;
  alarm: boolean;
  actionId: string | null;
  clOrdId: string | null;
  ordId: string | null;
  /** Zincir tarafı özeti (izin + rapor). */
  chain: string;
  /** Borsa tarafı özeti (dolum). */
  exchange: string;
  /** Türkçe açıklama. */
  note: string;
}

export interface ReconcileInput {
  snapshot: ChainSnapshot;
  orders: OkxOrder[];
  /** Pencere başı (unix sn). Bu andan önce verilmiş, emri olmayan izinler gösterilmez. */
  windowStartSec: number;
}

// ─────────────────────────── birim yardımcıları (units.ts üstünde) ───────────────────────────

/** TL (tam lira) → TL × 10^6; notionalTLE6 ile aynı ölçek. */
function tlE6(tl: TL): bigint {
  return decimalToScaled(String(tl), PX_DECIMALS);
}

function fmtTLE6(v: bigint): string {
  return formatDecimalTr(scaledToDecimal(v, PX_DECIMALS), 2);
}

/** OKX ortalama fiyatı 6 haneden ince olabilir; ölçeğe aşağı kesilerek pxE6'ya çevrilir. */
function avgPxE6Of(avgPx: string): number {
  const [int, frac = ""] = avgPx.split(".");
  return pxToPxE6(frac ? `${int}.${frac.slice(0, PX_DECIMALS)}` : int!);
}

function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}

function withinBp(a: bigint, b: bigint): boolean {
  const max = a > b ? a : b;
  return absDiff(a, b) * 10_000n <= max * MATCH_TOLERANCE_BP;
}

function closeTL(a: bigint, b: bigint): boolean {
  return absDiff(a, b) <= TL_ROUNDING_E6 || withinBp(a, b);
}

interface ExchangeFill {
  filledTLE6: bigint;
  avgPxE6: number | null;
}

/** Borsa dolumu; okunamazsa null. */
function exchangeFill(o: OkxOrder): ExchangeFill | null {
  if (o.accFillSz === "" || /^0(\.0+)?$/.test(o.accFillSz)) return { filledTLE6: 0n, avgPxE6: null };
  if (o.avgPx === "") return null;
  try {
    const avgPxE6 = avgPxE6Of(o.avgPx);
    return { filledTLE6: notionalTLE6(o.accFillSz, avgPxE6), avgPxE6 };
  } catch {
    return null;
  }
}

/** OKX emir durumlarının Türkçe adı; bilinmeyen durum olduğu gibi gösterilir. */
const OKX_STATE_TEXTS: Record<string, string> = {
  live: "açık",
  partially_filled: "kısmen doldu, açık",
  filled: "doldu",
  canceled: "iptal",
  mmp_canceled: "iptal",
};

function describeExchange(o: OkxOrder, f: ExchangeFill | null): string {
  const st = OKX_STATE_TEXTS[o.state] ?? o.state;
  if (!f) return `okunamadı (${st})`;
  if (f.filledTLE6 === 0n) return `dolum yok (${st})`;
  return `${fmtTLE6(f.filledTLE6)} TL @ ${formatPxTr(f.avgPxE6!)} (${st})`;
}

function describeChain(a: ChainAuthorized, r: ChainExecuted | undefined): string {
  const auth = `izin ${formatTL(a.amountTL)} TL ≤ ${formatPxTr(a.maxPxE6)}`;
  if (!r) return `${auth} · rapor yok`;
  const px = r.avgPxE6 > 0 ? ` @ ${formatPxTr(r.avgPxE6)}` : "";
  return `${auth} · rapor ${formatTL(r.filledTL)} TL${px} (${EXEC_STATUS_TEXTS[r.status]})`;
}

/** clOrdId → actionId; "plt<id>" değilse null. */
function actionIdOf(clOrdId: string): string | null {
  try {
    return actionIdFromClOrdId(clOrdId);
  } catch {
    return null;
  }
}

/** Emrin izinle uyuşmayan yanları (izinsiz emir belirtileri). */
function violations(a: ChainAuthorized, o: OkxOrder, f: ExchangeFill | null): string[] {
  const v: string[] = [];
  if (o.side !== "buy") v.push(`emir yönü "${o.side}", izin yalnız alış`);
  if (!(ORD_TYPES as readonly string[]).includes(o.ordType) || o.ordType !== a.ordType) {
    v.push(`emir türü "${o.ordType}", izindeki "${a.ordType}"`);
  }
  if (o.px !== "") {
    let pxE6: number | null = null;
    try {
      pxE6 = pxToPxE6(o.px);
    } catch {
      v.push("emir fiyatı okunamadı");
    }
    if (pxE6 !== null && pxE6 > a.maxPxE6) v.push(`emir fiyatı ${formatPxTr(pxE6)}, izindeki en yüksek ${formatPxTr(a.maxPxE6)}`);
  }
  if (f === null) v.push("borsa dolumu okunamadı");
  else {
    if (f.avgPxE6 !== null && f.avgPxE6 > a.maxPxE6) v.push(`ortalama dolum fiyatı izindeki en yüksek fiyatın üstünde`);
    const cap = tlE6(a.amountTL);
    if (f.filledTLE6 > cap && !closeTL(f.filledTLE6, cap)) v.push(`dolum ${fmtTLE6(f.filledTLE6)} TL, izin ${formatTL(a.amountTL)} TL`);
  }
  const authorizedAtMs = secToMs(a.openBy - OPEN_WINDOW_SEC - CLOCK_SKEW_SEC);
  const openByMs = secToMs(a.openBy + CLOCK_SKEW_SEC);
  const cTime = parseOkxTs(o.cTime);
  if (cTime < authorizedAtMs) v.push("emir izinden önce açılmış");
  if (cTime > openByMs) v.push("emir izin süresi (openBy) dolduktan sonra açılmış");
  return v;
}

function row(
  status: MatchStatus,
  p: { a?: ChainAuthorized; r?: ChainExecuted; o?: OkxOrder; f?: ExchangeFill | null; note: string; clOrdId?: string },
): MatchRow {
  return {
    status,
    alarm: ALARM_STATUSES.has(status),
    actionId: p.a?.actionId ?? null,
    clOrdId: p.o?.clOrdId || p.clOrdId || null,
    ordId: p.o?.ordId ?? p.r?.ordId ?? null,
    chain: p.a ? describeChain(p.a, p.r) : "izin yok",
    exchange: p.o ? describeExchange(p.o, p.f ?? null) : "emir yok",
    note: p.note,
  };
}

/** Tek izin için sonuç. */
function reconcileAction(a: ChainAuthorized, reports: ChainExecuted[], orders: OkxOrder[], nowSec: number): MatchRow[] {
  const reportBy = a.openBy + REPORT_WINDOW_SEC;
  const clOrdId = `plt${a.actionId}`;
  if (reports.length > 1) {
    return [row("MISMATCH", { a, r: reports[0], o: orders[0], f: orders[0] && exchangeFill(orders[0]), clOrdId, note: "aynı izin için birden çok rapor" })];
  }
  const r = reports[0];
  if (orders.length > 1) {
    return orders.map((o) => row("MISMATCH", { a, r, o, f: exchangeFill(o), note: `aynı izinle borsada ${orders.length} emir var` }));
  }

  const o = orders[0];
  if (!o) {
    if (r && r.filledTL > 0) return [row("MISMATCH", { a, r, clOrdId, note: "rapor dolum gösteriyor, borsada bu izne ait emir yok" })];
    const why = r
      ? `rapor: ${EXEC_STATUS_TEXTS[r.status]}`
      : nowSec <= a.openBy
        ? "emir henüz açılmadı"
        : nowSec <= reportBy
          ? "emir açılmadı; rapor penceresi sürüyor"
          : "izin kullanılmadı; süresi doldu";
    return [row("CHAIN_ONLY", { a, r, clOrdId, note: why })];
  }

  const f = exchangeFill(o);
  const bad = violations(a, o, f);
  if (bad.length > 0) return [row("MISMATCH", { a, r, o, f, note: `emir izinle uyuşmuyor: ${bad.join("; ")}` })];

  if (isOpenOrder(o)) {
    if (r) return [row("MISMATCH", { a, r, o, f, note: "rapor yazılmış ama emir borsada hâlâ açık" })];
    if (nowSec > reportBy) return [row("MISMATCH", { a, o, f, note: "rapor penceresi kapandı, emir hâlâ açık" })];
    return [row("PENDING", { a, o, f, note: "emir açık; rapor bekleniyor" })];
  }

  if (!r) {
    if (nowSec <= reportBy) return [row("PENDING", { a, o, f, note: "emir kapandı; rapor penceresi sürüyor" })];
    if (f && f.filledTLE6 === 0n) return [row("MATCHED", { a, o, f, note: "dolum yok; izin raporsuz düştü" })];
    return [row("MISMATCH", { a, o, f, note: "borsada dolum var, zincirde rapor yok" })];
  }

  const diffs: string[] = [];
  if (r.ordId !== o.ordId) diffs.push(`rapordaki ordId ${r.ordId || "boş"}, borsadaki ${o.ordId}`);
  const reported = tlE6(r.filledTL);
  if (f && !closeTL(reported, f.filledTLE6)) diffs.push(`tutar: rapor ${formatTL(r.filledTL)} TL, borsa ${fmtTLE6(f.filledTLE6)} TL`);
  if (f && f.filledTLE6 > 0n && r.filledTL > 0) {
    if (!withinBp(BigInt(r.avgPxE6), BigInt(f.avgPxE6!))) {
      diffs.push(`fiyat: rapor ${r.avgPxE6 > 0 ? formatPxTr(r.avgPxE6) : "0"}, borsa ${formatPxTr(f.avgPxE6!)}`);
    }
  }
  if (diffs.length > 0) return [row("MISMATCH", { a, r, o, f, note: `rapor ile dolum uyuşmuyor: ${diffs.join("; ")}` })];
  return [row("MATCHED", { a, r, o, f, note: "tutar ve fiyat %0,5 içinde" })];
}

/** Tüm satırlar: önce izinler (actionId sırasıyla), sonra hiçbir izne bağlanmayan emirler (zaman sırasıyla). */
export function reconcile(input: ReconcileInput): MatchRow[] {
  const { snapshot, windowStartSec } = input;
  const authById = new Map<string, ChainAuthorized>();
  for (const a of snapshot.authorized) authById.set(a.actionId, a);
  const reportsById = new Map<string, ChainExecuted[]>();
  for (const r of snapshot.executed) reportsById.set(r.actionId, [...(reportsById.get(r.actionId) ?? []), r]);

  const ordersById = new Map<string, OkxOrder[]>();
  const unbound: MatchRow[] = [];
  const sortedOrders = [...input.orders].sort((x, y) => parseOkxTs(x.cTime) - parseOkxTs(y.cTime));
  for (const o of sortedOrders) {
    if (o.instId !== TRADE_INST_ID) continue;
    const id = actionIdOf(o.clOrdId);
    if (id === null) {
      unbound.push(row("EXCHANGE_ONLY", { o, f: exchangeFill(o), note: o.clOrdId ? "clOrdId bir PİLOT izni değil" : "clOrdId yok" }));
    } else if (!authById.has(id)) {
      unbound.push(row("EXCHANGE_ONLY", { o, f: exchangeFill(o), note: `zincirde bu kullanıcı için ${id} numaralı izin yok` }));
    } else {
      ordersById.set(id, [...(ordersById.get(id) ?? []), o]);
    }
  }

  const rows: MatchRow[] = [];
  const ids = [...authById.keys()].sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : BigInt(x) > BigInt(y) ? 1 : 0));
  for (const id of ids) {
    const a = authById.get(id)!;
    const orders = ordersById.get(id) ?? [];
    const reports = reportsById.get(id) ?? [];
    const authorizedAt = a.openBy - OPEN_WINDOW_SEC;
    if (orders.length === 0 && authorizedAt < windowStartSec) continue; // pencere dışı, emri yok
    rows.push(...reconcileAction(a, reports, orders, snapshot.nowSec));
  }
  // İzni olmayan rapor kontratta olamaz (reportExecution AUTHORIZED ister); yine de görünürse ALARM.
  for (const [id, reps] of reportsById) {
    if (!authById.has(id)) {
      rows.push({
        status: "MISMATCH",
        alarm: true,
        actionId: id,
        clOrdId: `plt${id}`,
        ordId: reps[0]!.ordId || null,
        chain: "rapor var, izin olayı yok",
        exchange: "—",
        note: "zincirde izinsiz rapor",
      });
    }
  }
  return [...rows, ...unbound];
}

export function hasAlarm(rows: MatchRow[]): boolean {
  return rows.some((r) => r.alarm);
}
