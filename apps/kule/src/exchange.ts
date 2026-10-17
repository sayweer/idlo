/**
 * Borsa arayüzü (§9): KULE borsaya yalnız bu arayüzle konuşur. Gerçek uygulama ATK MCP istemcisidir
 * (atkExchange.ts); testlerde FakeExchange (test/helpers). Çekim (withdrawal) ve aktarım (transfer) yöntemi YOKTUR
 * ve eklenmeyecek (CLAUDE.md kural 4).
 */
import type { KuleInstrument, OrdType } from "@pilot/shared";

export type OrderState = "live" | "partially_filled" | "filled" | "canceled" | "mmp_canceled";

export interface Ticker {
  instId: string;
  bidPx: string;
  askPx: string;
  last: string;
  /** OKX ms zaman damgası. */
  ts: number;
}
export interface BookLevel {
  px: string;
  sz: string;
}
export interface Book {
  bids: BookLevel[];
  asks: BookLevel[];
  ts: number;
}
export interface BalanceEntry {
  /** İşlem hesabı kullanılabilir bakiye (OKX ondalık string). */
  trading: string;
  /** Fon hesabı kullanılabilir bakiye; okunamazsa null. */
  funding: string | null;
}
export interface Balance {
  TRY: BalanceEntry;
  USDT: BalanceEntry;
}
export interface TradeFee {
  /** Baz puan (pozitif = ücret). */
  makerBps: number;
  takerBps: number;
}
export interface OrderInfo {
  ordId: string;
  clOrdId: string;
  state: OrderState;
  sz: string;
  px: string;
  /** Birikmiş dolum miktarı (USDT). */
  accFillSz: string;
  /** Ortalama dolum fiyatı; dolum yoksa boş string. */
  avgPx: string;
}
export interface PlaceOrderArgs {
  instId: "USDT-TRY";
  tdMode: "cash";
  side: "buy";
  ordType: OrdType;
  px: string;
  sz: string;
  clOrdId: string;
}

/**
 * kind:
 *  - "rejected": borsa emri kesin reddetti, emir yok (yeniden deneme güvenli).
 *  - "uncertain": sonuç bilinmiyor (zaman aşımı, taşıma hatası); emir açılmış olabilir → YENİ_EMİR_YOK.
 *  - "unavailable": okuma başarısız.
 */
export class ExchangeError extends Error {
  constructor(
    message: string,
    readonly kind: "rejected" | "uncertain" | "unavailable",
    options?: { cause?: unknown; code?: string },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ExchangeError";
    this.code = options?.code;
  }
  readonly code: string | undefined;
}

export interface Exchange {
  getTicker(instId: KuleInstrument): Promise<Ticker>;
  getBook(instId: KuleInstrument, depth?: number): Promise<Book>;
  /** ATK `data` dizisi olduğu gibi (kule_market). */
  getCandles(instId: KuleInstrument, bar: string, limit?: number, after?: string): Promise<unknown[]>;
  getBalance(): Promise<Balance>;
  getTradeFee(): Promise<TradeFee>;
  placeOrder(a: PlaceOrderArgs): Promise<{ ordId: string }>;
  /** clOrdId ile emir; borsada yoksa null. */
  getOrder(clOrdId: string): Promise<OrderInfo | null>;
  cancelOrder(clOrdId: string): Promise<void>;
  /** USDT-TRY açık emirlerinin clOrdId'leri. */
  listOpenClOrdIds(): Promise<string[]>;
  close(): Promise<void>;
}
