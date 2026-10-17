/**
 * kule_quote (§9.1): alış teklifini birimleriyle okur ve normalize eder; EMİR GÖNDERMEZ (borsaya yalnız okuma).
 * DÜZELT yalnız burada (§9.1): szHint ≈ amountTL (TL'yi USDT sanmış, U-2) ya da szHint × px, amountTL'den %1'den fazla
 * sapıyor (U-3). Normalize emir her zaman KULE'nin hesapladığı doğru emirdir (CLAUDE.md kural 9: sz'yi yalnız KULE hesaplar).
 * TODO(spec): ioc'de verilen px "en yüksek fiyat" sayılır; bestAsk onun üstündeyse RET ABOVE_MAX_PX (execute'ta BEKLET).
 */
import {
  floorToTick,
  kuleReasonText,
  limitBuySz,
  notionalDeviationBps,
  pxE6ToPx,
  pxToPxE6,
  quoteReadback,
  type KuleReasonCode,
} from "@pilot/shared";
import type { Exchange } from "./exchange.js";
import { MAX_DATA_AGE_SEC } from "./health.js";
import type { InstrumentCache } from "./instruments.js";
import { bestPrices } from "./market.js";
import type { KuleInput, KuleOutput } from "./types.js";
import type { Clock } from "./util.js";

export const DEFAULT_MAKER_BPS = 10; // Ek B: yapıcı %0,10
export const DEFAULT_TAKER_BPS = 22; // Ek B: alıcı %0,22

export interface QuoteDeps {
  exchange: Exchange;
  instruments: InstrumentCache;
  clock: Clock;
}

function ret(reason: KuleReasonCode, estFeeTL: number): KuleOutput<"kule_quote"> {
  return { verdict: "RET", readback: kuleReasonText(reason), normalized: null, estFeeTL, reasons: [reason] };
}

export async function buildQuote(q: KuleInput<"kule_quote">, d: QuoteDeps): Promise<KuleOutput<"kule_quote">> {
  const [book, params, fee] = await Promise.all([
    d.exchange.getBook("USDT-TRY", 5),
    d.instruments.get(),
    d.exchange.getTradeFee().catch(() => ({ makerBps: DEFAULT_MAKER_BPS, takerBps: DEFAULT_TAKER_BPS })),
  ]);
  const feeBps = q.ordType === "ioc" ? fee.takerBps : fee.makerBps;
  const estFeeTL = Math.ceil((q.amountTL * feeBps) / 10_000);

  const age = Math.max(0, (d.clock.nowMs() - book.ts) / 1000);
  const best = bestPrices(book);
  if (best === null || age > MAX_DATA_AGE_SEC) return ret("STALE_DATA", estFeeTL);

  let pxE6: number;
  if (q.ordType === "ioc") {
    if (q.px !== undefined && best.askE6 > floorToTick(pxToPxE6(q.px), params.tickSz)) return ret("ABOVE_MAX_PX", estFeeTL);
    pxE6 = floorToTick(best.askE6, params.tickSz);
  } else {
    const wanted = q.px !== undefined ? floorToTick(pxToPxE6(q.px), params.tickSz) : best.bidE6;
    pxE6 = floorToTick(Math.min(wanted, best.bidE6), params.tickSz);
  }

  let sz: string;
  try {
    sz = limitBuySz({ amountTL: q.amountTL, pxE6, lotSz: params.lotSz, minSz: params.minSz });
  } catch {
    return ret("BELOW_MIN_SZ", estFeeTL);
  }

  const reasons: KuleReasonCode[] = [];
  if (q.szHint !== undefined) {
    // U-2: szHint ≈ amountTL (1 TL = 1 "USDT" sanılmış); U-3: szHint × px tutardan %1'den fazla sapıyor.
    if (notionalDeviationBps(q.szHint, 1_000_000, q.amountTL) <= 100) reasons.push("SZ_LOOKS_LIKE_TL");
    else if (notionalDeviationBps(q.szHint, pxE6, q.amountTL) > 100) reasons.push("NOTIONAL_MISMATCH");
  }

  return {
    verdict: reasons.length > 0 ? "DÜZELT" : "ONAY",
    readback: quoteReadback({ amountTL: q.amountTL, sz, pxE6, ordType: q.ordType }),
    normalized: { instId: "USDT-TRY", side: "buy", ordType: q.ordType, px: pxE6ToPx(pxE6), sz },
    estFeeTL,
    reasons,
  };
}
