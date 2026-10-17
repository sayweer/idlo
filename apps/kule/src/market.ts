/** Tahtadan fiyat ve makas hesapları (§9.2-8). Dönüşümler yalnız @pilot/shared units.ts ile. */
import { pxToPxE6 } from "@pilot/shared";
import type { Book } from "./exchange.js";
import { MAX_SPREAD_BPS } from "./health.js";

export interface BestPrices {
  bidE6: number;
  askE6: number;
}

/** En iyi alış/satış; boş, çapraz ya da ayrıştırılamayan tahta → null (veri geçersiz sayılır). */
export function bestPrices(book: Book): BestPrices | null {
  const b = book.bids[0];
  const a = book.asks[0];
  if (!b || !a) return null;
  try {
    const bidE6 = pxToPxE6(b.px);
    const askE6 = pxToPxE6(a.px);
    if (askE6 < bidE6) return null;
    return { bidE6, askE6 };
  } catch {
    return null;
  }
}

/** makas > 30 bp mi? (ask − bid) / bid, tamsayı aritmetiği. */
export function spreadTooWide(p: BestPrices): boolean {
  return BigInt(p.askE6 - p.bidE6) * 10_000n > BigInt(MAX_SPREAD_BPS) * BigInt(p.bidE6);
}
