/**
 * ATK (Agent Trade Kit) MCP istemcisi üzerinden borsa (§9). ATK alt süreç olarak başlatılır:
 *   okx-trade-mcp --profile ${OKX_PROFILE} --modules market,spot,account
 * Araç adları ve argümanlar `okx list-tools --json` (v1.4.8) çıktısından alındı; tahmin yok.
 * Kullanılan araçlar (dar beyaz liste; account_transfer vb. HİÇ çağrılmaz):
 *   market_get_ticker, market_get_orderbook, market_get_candles,
 *   account_get_balance, account_get_asset_balance, account_get_trade_fee,
 *   spot_place_order, spot_get_order, spot_get_orders, spot_cancel_order.
 *
 * ATK yanıt biçimi (v1.4.8, canlı doğrulandı):
 *   başarı: {"tool","ok":true,"data":{"endpoint","requestTime","data":[…OKX satırları…]},"capabilities":{…}}
 *   hata:   {"tool","error":true,"type":"OkxApiError"|"ValidationError"|…,"code":"51001","message":…}
 * Alt sürece KULE_REPORTER_PRIVATE_KEY aktarılmaz (SDK varsayılan güvenli ortamı kullanır).
 * TODO(spec): spot_place_order / spot_get_order / hesap araçlarının yanıt biçimi canlı hesapla (B1) doğrulanmalı;
 * ayrıştırıcı bilinmeyen biçimde ExchangeError fırlatır (fail-closed). Emir gönderiminde bilinmeyen biçim "uncertain" sayılır.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { KULE_INSTRUMENTS, TRADE_INST_ID, decimalToScaled, parseOkxTs, type KuleInstrument } from "@pilot/shared";
import {
  DUPLICATE_CLORDID_CODES,
  ExchangeError,
  type Balance,
  type Book,
  type BookLevel,
  type Exchange,
  type OrderInfo,
  type OrderState,
  type PlaceOrderArgs,
  type Ticker,
  type TradeFee,
} from "./exchange.js";
import { truncDecimal } from "./util.js";

export interface McpToolCaller {
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: undefined,
    options?: { timeout?: number },
  ): Promise<Record<string, unknown>>;
  close?(): Promise<void>;
}

export const ATK_READ_TIMEOUT_MS = 10_000;
export const ATK_WRITE_TIMEOUT_MS = 15_000;

/** OKX kodları: sistem hatası/zaman aşımı → sonuç belirsiz (emir açılmış olabilir). */
const UNCERTAIN_OKX_CODES = new Set(["50001", "50004", "50013", "50026"]);
/**
 * Emir reddinin KESİN olduğu kodlar: OKX iş hatası (51xxx–59xxx), sistem/zaman aşımı kodları hariç, kopya clOrdId hariç
 * (o durumda emir zaten vardır). 3 haneli HTTP durumları, 50xxx genel/sistem kodları, kodsuz hatalar → belirsiz.
 */
function isDefinitiveOkxCode(code: string | undefined): boolean {
  if (!code || !/^5[1-9]\d{3}$/.test(code)) return false;
  return !UNCERTAIN_OKX_CODES.has(code) && !DUPLICATE_CLORDID_CODES.includes(code);
}
/** OKX: "Order does not exist". */
const ORDER_NOT_FOUND = "51603";

interface AtkFailure {
  type: string;
  code?: string;
  message: string;
}
type AtkResult = { ok: true; rows: unknown[] } | { ok: false; failure: AtkFailure };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** MCP sonucunu {ok, rows} ya da {ok:false, failure} yapar. Biçim tanınmazsa failure.type = "UnknownFormat". */
export function parseAtkResult(res: Record<string, unknown>): AtkResult {
  const content = res.content;
  let text: string | undefined;
  if (Array.isArray(content) && content.length >= 1) {
    const b = content[0] as { type?: unknown; text?: unknown };
    if (b.type === "text" && typeof b.text === "string") text = b.text;
  }
  let obj: unknown;
  if (text !== undefined) {
    try {
      obj = JSON.parse(text);
    } catch {
      return { ok: false, failure: { type: "UnknownFormat", message: "ATK yanıtı JSON değil" } };
    }
  } else if (isObj(res.structuredContent)) {
    obj = res.structuredContent;
  } else {
    return { ok: false, failure: { type: "UnknownFormat", message: "ATK yanıtında metin yok" } };
  }
  if (!isObj(obj)) return { ok: false, failure: { type: "UnknownFormat", message: "ATK yanıtı nesne değil" } };
  if (obj.error === true || res.isError === true || obj.ok === false) {
    return {
      ok: false,
      failure: {
        type: typeof obj.type === "string" ? obj.type : "Unknown",
        ...(typeof obj.code === "string" ? { code: obj.code } : {}),
        message: typeof obj.message === "string" ? obj.message.slice(0, 300) : "ATK hatası",
      },
    };
  }
  if (obj.ok !== true) return { ok: false, failure: { type: "UnknownFormat", message: "ATK yanıtında ok yok" } };
  const outer = obj.data;
  const inner = isObj(outer) ? outer.data : outer;
  if (Array.isArray(inner)) return { ok: true, rows: inner };
  if (isObj(inner)) return { ok: true, rows: [inner] };
  return { ok: false, failure: { type: "UnknownFormat", message: "ATK yanıtında veri yok" } };
}

function str(v: unknown, field: string): string {
  if (typeof v !== "string") throw new ExchangeError(`ATK yanıtı: ${field} yok`, "unavailable");
  return v;
}

function assertInst(instId: string): asserts instId is KuleInstrument {
  // U-1: yalnız iki enstrüman okunur.
  if (!(KULE_INSTRUMENTS as readonly string[]).includes(instId)) throw new ExchangeError("izinsiz enstrüman", "unavailable");
}

function levels(raw: unknown, field: string): BookLevel[] {
  if (!Array.isArray(raw)) throw new ExchangeError(`ATK yanıtı: ${field} yok`, "unavailable");
  return raw.map((l) => {
    if (!Array.isArray(l)) throw new ExchangeError(`ATK yanıtı: ${field} satırı geçersiz`, "unavailable");
    return { px: str(l[0], `${field}.px`), sz: str(l[1], `${field}.sz`) };
  });
}

function tsOf(v: unknown, field: string): number {
  try {
    return parseOkxTs(str(v, field));
  } catch (e) {
    if (e instanceof ExchangeError) throw e;
    throw new ExchangeError(`ATK yanıtı: ${field} geçersiz`, "unavailable");
  }
}

const ORDER_STATES: readonly OrderState[] = ["live", "partially_filled", "filled", "canceled", "mmp_canceled"];

export class AtkExchange implements Exchange {
  constructor(private readonly mcp: McpToolCaller) {}

  /** ATK'yı alt süreç olarak başlatır. */
  static async spawn(profile: string): Promise<AtkExchange> {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(profile)) throw new Error("OKX_PROFILE geçersiz");
    const transport = new StdioClientTransport({
      command: process.platform === "win32" ? "okx-trade-mcp.cmd" : "okx-trade-mcp",
      args: ["--profile", profile, "--modules", "market,spot,account"],
      stderr: "ignore",
    });
    const client = new Client({ name: "kule", version: "0.0.0" });
    await client.connect(transport);
    return new AtkExchange(client as unknown as McpToolCaller);
  }

  private async rows(name: string, args: Record<string, unknown>, timeout: number): Promise<AtkResult> {
    let res: Record<string, unknown>;
    try {
      res = await this.mcp.callTool({ name, arguments: args }, undefined, { timeout });
    } catch (e) {
      return { ok: false, failure: { type: "Transport", message: (e as Error).message?.slice(0, 200) ?? "taşıma hatası" } };
    }
    return parseAtkResult(res);
  }

  private async read(name: string, args: Record<string, unknown>): Promise<unknown[]> {
    const r = await this.rows(name, args, ATK_READ_TIMEOUT_MS);
    if (!r.ok) throw new ExchangeError(`${name}: ${r.failure.type} ${r.failure.message}`, "unavailable", r.failure.code ? { code: r.failure.code } : undefined);
    return r.rows;
  }

  async getTicker(instId: KuleInstrument): Promise<Ticker> {
    assertInst(instId);
    const row = (await this.read("market_get_ticker", { instId }))[0];
    if (!isObj(row)) throw new ExchangeError("market_get_ticker: veri yok", "unavailable");
    return {
      instId: str(row.instId, "instId"),
      bidPx: str(row.bidPx, "bidPx"),
      askPx: str(row.askPx, "askPx"),
      last: str(row.last, "last"),
      ts: tsOf(row.ts, "ts"),
    };
  }

  async getBook(instId: KuleInstrument, depth = 5): Promise<Book> {
    assertInst(instId);
    const row = (await this.read("market_get_orderbook", { instId, sz: depth }))[0];
    if (!isObj(row)) throw new ExchangeError("market_get_orderbook: veri yok", "unavailable");
    return { bids: levels(row.bids, "bids"), asks: levels(row.asks, "asks"), ts: tsOf(row.ts, "ts") };
  }

  async getCandles(instId: KuleInstrument, bar: string, limit?: number, after?: string): Promise<unknown[]> {
    assertInst(instId);
    return this.read("market_get_candles", { instId, bar, ...(limit !== undefined ? { limit } : {}), ...(after !== undefined ? { after } : {}) });
  }

  async getBalance(): Promise<Balance> {
    const trading = await this.read("account_get_balance", { ccy: "TRY,USDT" });
    const first = trading[0];
    const details = isObj(first) && Array.isArray(first.details) ? first.details : [];
    const pick = (ccy: string): string => {
      for (const d of details) {
        if (isObj(d) && d.ccy === ccy) return truncDecimal(typeof d.availBal === "string" ? d.availBal : "0", 18);
      }
      return "0"; // listede yoksa bakiye yok
    };
    let fundingRows: unknown[] | null = null;
    try {
      fundingRows = await this.read("account_get_asset_balance", { ccy: "TRY,USDT" });
    } catch {
      fundingRows = null; // fon hesabı okunamadı → null; BALANCE_IN_FUNDING söylenemez, BALANCE denir
    }
    const fund = (ccy: string): string | null => {
      if (fundingRows === null) return null;
      for (const d of fundingRows) {
        if (isObj(d) && d.ccy === ccy) return truncDecimal(typeof d.availBal === "string" ? d.availBal : "0", 18);
      }
      return "0";
    };
    return { TRY: { trading: pick("TRY"), funding: fund("TRY") }, USDT: { trading: pick("USDT"), funding: fund("USDT") } };
  }

  async getTradeFee(): Promise<TradeFee> {
    const row = (await this.read("account_get_trade_fee", { instType: "SPOT", instId: TRADE_INST_ID }))[0];
    if (!isObj(row)) throw new ExchangeError("account_get_trade_fee: veri yok", "unavailable");
    const bps = (v: unknown, f: string): number => {
      const s = str(v, f).replace(/^-/, "");
      // OKX oranı ondalık (0.001 = %0,1 = 10 bp): ölçek 6 → bp = ölçekli / 100
      return Number(decimalToScaled(truncDecimal(s, 6), 6)) / 100;
    };
    return { makerBps: bps(row.maker, "maker"), takerBps: bps(row.taker, "taker") };
  }

  async placeOrder(a: PlaceOrderArgs): Promise<{ ordId: string }> {
    // Savunma: yalnız USDT-TRY nakit alış.
    if (a.instId !== TRADE_INST_ID || a.side !== "buy" || a.tdMode !== "cash") throw new ExchangeError("izinsiz emir", "rejected");
    const r = await this.rows(
      "spot_place_order",
      { instId: a.instId, tdMode: a.tdMode, side: a.side, ordType: a.ordType, px: a.px, sz: a.sz, clOrdId: a.clOrdId },
      ATK_WRITE_TIMEOUT_MS,
    );
    if (!r.ok) {
      const f = r.failure;
      // Ret opt-in: yalnız OKX iş kodu (5 haneli 51xxx–59xxx) kesin ret sayılır. ATK taşıma düzeyi HTTP hatalarını da
      // OkxApiError olarak verir (code = "502"/"504", UNEXPECTED_CONTENT_TYPE, RESPONSE_TOO_LARGE); bunlarda emir
      // borsada açılmış olabilir → belirsiz.
      const definitive = f.type === "ValidationError" || (f.type === "OkxApiError" && isDefinitiveOkxCode(f.code));
      throw new ExchangeError(`spot_place_order: ${f.type} ${f.message}`, definitive ? "rejected" : "uncertain", f.code ? { code: f.code } : undefined);
    }
    const row = r.rows[0];
    if (isObj(row)) {
      const sCode = typeof row.sCode === "string" ? row.sCode : "0";
      if (sCode !== "0") {
        throw new ExchangeError(`spot_place_order: sCode ${sCode}`, isDefinitiveOkxCode(sCode) ? "rejected" : "uncertain", { code: sCode });
      }
      if (typeof row.ordId === "string" && row.ordId !== "") return { ordId: row.ordId };
    }
    throw new ExchangeError("spot_place_order: yanıtta ordId yok", "uncertain");
  }

  async getOrder(clOrdId: string): Promise<OrderInfo | null> {
    const r = await this.rows("spot_get_order", { instId: TRADE_INST_ID, clOrdId }, ATK_READ_TIMEOUT_MS);
    if (!r.ok) {
      if (r.failure.code === ORDER_NOT_FOUND) return null;
      throw new ExchangeError(`spot_get_order: ${r.failure.type} ${r.failure.message}`, "unavailable", r.failure.code ? { code: r.failure.code } : undefined);
    }
    const row = r.rows[0];
    if (!isObj(row)) return null;
    if (typeof row.ordId !== "string" || row.ordId === "") return null;
    const state = row.state;
    if (typeof state !== "string" || !(ORDER_STATES as readonly string[]).includes(state)) {
      throw new ExchangeError("spot_get_order: bilinmeyen emir durumu", "unavailable");
    }
    return {
      ordId: row.ordId,
      clOrdId: typeof row.clOrdId === "string" ? row.clOrdId : clOrdId,
      state: state as OrderState,
      sz: typeof row.sz === "string" ? row.sz : "0",
      px: typeof row.px === "string" ? row.px : "",
      accFillSz: typeof row.accFillSz === "string" && row.accFillSz !== "" ? row.accFillSz : "0",
      avgPx: typeof row.avgPx === "string" ? row.avgPx : "",
    };
  }

  async cancelOrder(clOrdId: string): Promise<void> {
    const r = await this.rows("spot_cancel_order", { instId: TRADE_INST_ID, clOrdId }, ATK_WRITE_TIMEOUT_MS);
    if (!r.ok) {
      // 51400/51402/51603: emir zaten dolmuş/iptal/yok; çağıran getOrder ile netleştirir.
      if (r.failure.code && ["51400", "51401", "51402", "51603"].includes(r.failure.code)) return;
      throw new ExchangeError(`spot_cancel_order: ${r.failure.type} ${r.failure.message}`, "unavailable", r.failure.code ? { code: r.failure.code } : undefined);
    }
  }

  async listOpenClOrdIds(): Promise<string[]> {
    const rows = await this.read("spot_get_orders", { instId: TRADE_INST_ID });
    const out: string[] = [];
    for (const row of rows) if (isObj(row) && typeof row.clOrdId === "string" && row.clOrdId !== "") out.push(row.clOrdId);
    return out;
  }

  async close(): Promise<void> {
    await this.mcp.close?.();
  }
}
