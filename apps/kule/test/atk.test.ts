import { describe, expect, it } from "vitest";
import { AtkExchange, parseAtkResult, type McpToolCaller } from "../src/atkExchange.js";
import { ExchangeError } from "../src/exchange.js";
import { InstrumentCache, INSTRUMENTS_TTL_MS, parseInstrumentResponse } from "../src/instruments.js";
import { INSTRUMENT_BODY, TestClock } from "./helpers.js";

/** ATK v1.4.8 yanıt kabuğu (canlı gözlendi): {tool, ok:true, data:{endpoint, requestTime, data:[…]}, capabilities}. */
const okRes = (rows: unknown[]): Record<string, unknown> => ({
  content: [{ type: "text", text: JSON.stringify({ tool: "x", ok: true, data: { endpoint: "GET /x", requestTime: "2026-10-17T14:17:55.126Z", data: rows }, capabilities: {} }, null, 2) }],
});
const errRes = (type: string, code: string | undefined, message: string): Record<string, unknown> => ({
  isError: true,
  content: [{ type: "text", text: JSON.stringify({ tool: "x", error: true, type, ...(code ? { code } : {}), message }) }],
});

function fakeMcp(handler: (name: string, args: Record<string, unknown>) => Record<string, unknown> | Error): { mcp: McpToolCaller; calls: { name: string; args: Record<string, unknown> }[] } {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    mcp: {
      async callTool(p) {
        calls.push({ name: p.name, args: p.arguments ?? {} });
        const r = handler(p.name, p.arguments ?? {});
        if (r instanceof Error) throw r;
        return r;
      },
    },
  };
}

describe("ATK yanıt ayrıştırma", () => {
  it("başarı satırlarını, OKX hatasını ve tanınmayan biçimi ayırır", () => {
    expect(parseAtkResult(okRes([{ a: 1 }]))).toEqual({ ok: true, rows: [{ a: 1 }] });
    expect(parseAtkResult(errRes("OkxApiError", "51001", "yok"))).toMatchObject({ ok: false, failure: { type: "OkxApiError", code: "51001" } });
    expect(parseAtkResult({ content: [{ type: "text", text: "JSON degil" }] })).toMatchObject({ ok: false, failure: { type: "UnknownFormat" } });
    expect(parseAtkResult({ content: [] })).toMatchObject({ ok: false, failure: { type: "UnknownFormat" } });
    expect(parseAtkResult({ content: [{ type: "text", text: JSON.stringify({ ok: true }) }] })).toMatchObject({ ok: false });
    expect(parseAtkResult({ content: [{ type: "text", text: JSON.stringify([1]) }] })).toMatchObject({ ok: false });
  });
});

describe("AtkExchange (ATK araç adları okx list-tools --json'dan)", () => {
  it("ticker ve tahta: market_get_ticker / market_get_orderbook, ts ms'ye çevrilir", async () => {
    const { mcp, calls } = fakeMcp((name) =>
      name === "market_get_ticker"
        ? okRes([{ instType: "SPOT", instId: "USDT-TRY", last: "49.447", askPx: "49.462", bidPx: "49.447", ts: "1792246674064" }])
        : okRes([{ asks: [["49.463", "1093.1626", "0", "2"]], bids: [["49.447", "990.9558", "0", "1"]], ts: "1792246675253", seqId: 1 }]),
    );
    const ex = new AtkExchange(mcp);
    expect(await ex.getTicker("USDT-TRY")).toEqual({ instId: "USDT-TRY", bidPx: "49.447", askPx: "49.462", last: "49.447", ts: 1792246674064 });
    expect(await ex.getBook("USDT-TRY", 5)).toEqual({ bids: [{ px: "49.447", sz: "990.9558" }], asks: [{ px: "49.463", sz: "1093.1626" }], ts: 1792246675253 });
    expect(calls).toEqual([
      { name: "market_get_ticker", args: { instId: "USDT-TRY" } },
      { name: "market_get_orderbook", args: { instId: "USDT-TRY", sz: 5 } },
    ]);
  });

  it("U-1 yalnız iki enstrüman okunur: ETH-USDT ATK'ya hiç gitmez", async () => {
    const { mcp, calls } = fakeMcp(() => okRes([]));
    const ex = new AtkExchange(mcp);
    await expect(ex.getTicker("ETH-USDT" as never)).rejects.toThrow(ExchangeError);
    await expect(ex.getBook("BTC-USDT-SWAP" as never)).rejects.toThrow(ExchangeError);
    await expect(ex.getCandles("DOGE-TRY" as never, "5m")).rejects.toThrow(ExchangeError);
    expect(calls).toHaveLength(0);
    // izinli ikisi çalışır
    await ex.getCandles("BTC-USDT", "5m", 3);
    expect(calls[0]).toEqual({ name: "market_get_candles", args: { instId: "BTC-USDT", bar: "5m", limit: 3 } });
  });

  it("bakiye: işlem (account_get_balance) ve fon (account_get_asset_balance) ayrı; fon okunamazsa null", async () => {
    const { mcp } = fakeMcp((name) =>
      name === "account_get_balance"
        ? okRes([{ details: [{ ccy: "TRY", availBal: "100.5", cashBal: "100.5" }, { ccy: "USDT", availBal: "3" }] }])
        : okRes([{ ccy: "TRY", availBal: "2500" }]),
    );
    expect(await new AtkExchange(mcp).getBalance()).toEqual({ TRY: { trading: "100.5", funding: "2500" }, USDT: { trading: "3", funding: "0" } });

    const { mcp: m2 } = fakeMcp((name) => (name === "account_get_balance" ? okRes([{ details: [] }]) : errRes("OkxApiError", "50000", "x")));
    expect(await new AtkExchange(m2).getBalance()).toEqual({ TRY: { trading: "0", funding: null }, USDT: { trading: "0", funding: null } });
  });

  it("ücret: negatif OKX oranı bp'ye çevrilir (account_get_trade_fee)", async () => {
    const { mcp, calls } = fakeMcp(() => okRes([{ maker: "-0.001", taker: "-0.0022" }]));
    expect(await new AtkExchange(mcp).getTradeFee()).toEqual({ makerBps: 10, takerBps: 22 });
    expect(calls[0]).toEqual({ name: "account_get_trade_fee", args: { instType: "SPOT", instId: "USDT-TRY" } });
  });

  it("spot_place_order: yalnız USDT-TRY nakit alış; argümanlar ATK adlarıyla; ordId döner", async () => {
    const { mcp, calls } = fakeMcp(() => okRes([{ ordId: "123", clOrdId: "plt7", sCode: "0", sMsg: "" }]));
    const ex = new AtkExchange(mcp);
    expect(await ex.placeOrder({ instId: "USDT-TRY", tdMode: "cash", side: "buy", ordType: "post_only", px: "49.447", sz: "202.2", clOrdId: "plt7" })).toEqual({ ordId: "123" });
    expect(calls[0]).toEqual({ name: "spot_place_order", args: { instId: "USDT-TRY", tdMode: "cash", side: "buy", ordType: "post_only", px: "49.447", sz: "202.2", clOrdId: "plt7" } });
    // savunma: satış / başka enstrüman / margin gönderilmez
    await expect(ex.placeOrder({ instId: "USDT-TRY", tdMode: "cash", side: "sell" as never, ordType: "ioc", px: "1", sz: "1", clOrdId: "plt8" })).rejects.toThrow(/izinsiz/);
    await expect(ex.placeOrder({ instId: "BTC-USDT" as never, tdMode: "cash", side: "buy", ordType: "ioc", px: "1", sz: "1", clOrdId: "plt8" })).rejects.toThrow(/izinsiz/);
    await expect(ex.placeOrder({ instId: "USDT-TRY", tdMode: "cross" as never, side: "buy", ordType: "ioc", px: "1", sz: "1", clOrdId: "plt8" })).rejects.toThrow(/izinsiz/);
    expect(calls).toHaveLength(1);
  });

  it("emir hatası sınıflaması: OKX/doğrulama hatası kesin ret; zaman aşımı, taşıma ve bilinmeyen biçim belirsiz", async () => {
    const args = { instId: "USDT-TRY", tdMode: "cash", side: "buy", ordType: "ioc", px: "49.4", sz: "10", clOrdId: "plt9" } as const;
    const kind = async (r: Record<string, unknown> | Error): Promise<string | undefined> => {
      const { mcp } = fakeMcp(() => r);
      try {
        await new AtkExchange(mcp).placeOrder(args);
        return undefined;
      } catch (e) {
        return (e as ExchangeError).kind;
      }
    };
    expect(await kind(errRes("OkxApiError", "51008", "yetersiz bakiye"))).toBe("rejected");
    expect(await kind(errRes("ValidationError", undefined, "Missing"))).toBe("rejected");
    expect(await kind(errRes("OkxApiError", "50001", "service unavailable"))).toBe("uncertain");
    expect(await kind(errRes("NetworkError", undefined, "ECONNRESET"))).toBe("uncertain");
    expect(await kind(new Error("Request timed out"))).toBe("uncertain");
    expect(await kind({ content: [{ type: "text", text: "???" }] })).toBe("uncertain");
    expect(await kind(okRes([{ sCode: "51008", sMsg: "ret" }]))).toBe("rejected");
    expect(await kind(okRes([{ sCode: "50001", sMsg: "meşgul" }]))).toBe("uncertain");
    expect(await kind(okRes([{ sCode: "0" }]))).toBe("uncertain"); // ordId yok
  });

  it("U-11 ATK taşıma düzeyi hataları (HTTP 502/503/504, UNEXPECTED_CONTENT_TYPE, RESPONSE_TOO_LARGE, kodsuz OkxApiError) belirsizdir; kopya clOrdId (51016) kesin ret sayılmaz", async () => {
    const args = { instId: "USDT-TRY", tdMode: "cash", side: "buy", ordType: "post_only", px: "49.4", sz: "10", clOrdId: "plt9" } as const;
    const kind = async (r: Record<string, unknown> | Error): Promise<string | undefined> => {
      try {
        await new AtkExchange(fakeMcp(() => r).mcp).placeOrder(args);
        return undefined;
      } catch (e) {
        return (e as ExchangeError).kind;
      }
    };
    for (const code of ["502", "503", "504", "429", "UNEXPECTED_CONTENT_TYPE", "RESPONSE_TOO_LARGE", "50011", "50000", "5100", "511008", "51016"]) {
      expect(await kind(errRes("OkxApiError", code, "gateway"))).toBe("uncertain");
    }
    expect(await kind(errRes("OkxApiError", undefined, "kodsuz"))).toBe("uncertain");
    for (const type of ["RateLimitError", "AuthenticationError", "NetworkError"]) {
      expect(await kind(errRes(type, "51008", "x"))).toBe("uncertain");
    }
    // kesin ret yalnız 51xxx–59xxx iş kodu
    expect(await kind(errRes("OkxApiError", "51008", "yetersiz bakiye"))).toBe("rejected");
    expect(await kind(errRes("OkxApiError", "58003", "x"))).toBe("rejected");
    // sCode da aynı kuralla: sistem/HTTP benzeri ve kopya clOrdId belirsiz
    expect(await kind(okRes([{ sCode: "51008", sMsg: "ret" }]))).toBe("rejected");
    expect(await kind(okRes([{ sCode: "50011", sMsg: "rate" }]))).toBe("uncertain");
    expect(await kind(okRes([{ sCode: "51016", sMsg: "duplicate clOrdId" }]))).toBe("uncertain");
  });

  it("spot_get_order: clOrdId ile okur; 51603 (emir yok) → null; diğer hata fırlatır; bilinmeyen durum fırlatır", async () => {
    const row = { ordId: "5", clOrdId: "plt7", state: "partially_filled", sz: "202.2", px: "49.447", accFillSz: "10.5", avgPx: "49.447" };
    const { mcp, calls } = fakeMcp(() => okRes([row]));
    expect(await new AtkExchange(mcp).getOrder("plt7")).toEqual({ ordId: "5", clOrdId: "plt7", state: "partially_filled", sz: "202.2", px: "49.447", accFillSz: "10.5", avgPx: "49.447" });
    expect(calls[0]).toEqual({ name: "spot_get_order", args: { instId: "USDT-TRY", clOrdId: "plt7" } });
    expect(await new AtkExchange(fakeMcp(() => errRes("OkxApiError", "51603", "Order does not exist")).mcp).getOrder("plt7")).toBeNull();
    await expect(new AtkExchange(fakeMcp(() => errRes("OkxApiError", "50001", "meşgul")).mcp).getOrder("plt7")).rejects.toThrow(ExchangeError);
    await expect(new AtkExchange(fakeMcp(() => okRes([{ ...row, state: "garip" }])).mcp).getOrder("plt7")).rejects.toThrow(/bilinmeyen/);
  });

  it("spot_cancel_order ve spot_get_orders (açık emirler)", async () => {
    const { mcp, calls } = fakeMcp((name) => (name === "spot_get_orders" ? okRes([{ clOrdId: "plt7" }, { clOrdId: "" }, { ordId: "x" }]) : okRes([{ clOrdId: "plt7", sCode: "0" }])));
    const ex = new AtkExchange(mcp);
    await ex.cancelOrder("plt7");
    expect(await ex.listOpenClOrdIds()).toEqual(["plt7"]);
    expect(calls.map((c) => c.name)).toEqual(["spot_cancel_order", "spot_get_orders"]);
    // zaten dolmuş/iptal: sessizce geçer
    await new AtkExchange(fakeMcp(() => errRes("OkxApiError", "51400", "iptal edilemedi")).mcp).cancelOrder("plt7");
    await expect(new AtkExchange(fakeMcp(() => errRes("OkxApiError", "50001", "x")).mcp).cancelOrder("plt7")).rejects.toThrow(ExchangeError);
  });

  it("çekim/aktarım aracı hiçbir yöntemden çağrılmaz (beyaz liste)", async () => {
    const { mcp, calls } = fakeMcp(() => okRes([{ ordId: "1", sCode: "0", details: [], bids: [], asks: [], ts: "1", maker: "0", taker: "0", state: "live", last: "1", askPx: "1", bidPx: "1", instId: "USDT-TRY" }]));
    const ex = new AtkExchange(mcp);
    await Promise.allSettled([ex.getTicker("USDT-TRY"), ex.getBook("BTC-USDT"), ex.getCandles("USDT-TRY", "5m"), ex.getBalance(), ex.getTradeFee(), ex.getOrder("plt1"), ex.cancelOrder("plt1"), ex.listOpenClOrdIds()]);
    const allowed = new Set(["market_get_ticker", "market_get_orderbook", "market_get_candles", "account_get_balance", "account_get_asset_balance", "account_get_trade_fee", "spot_get_order", "spot_cancel_order", "spot_get_orders"]);
    for (const c of calls) expect(allowed.has(c.name)).toBe(true);
    expect(calls.some((c) => /transfer|withdraw/i.test(c.name))).toBe(false);
  });
});

describe("enstrüman parametreleri (tickSz/lotSz/minSz, önbellek 1 saat)", () => {
  it("herkese açık uç noktadan okur, 1 saat önbellekler, süre dolunca yeniler", async () => {
    const clock = new TestClock();
    let n = 0;
    const urls: string[] = [];
    const f: typeof fetch = async (u) => {
      n++;
      urls.push(String(u));
      return new Response(JSON.stringify(INSTRUMENT_BODY), { status: 200 });
    };
    const c = new InstrumentCache(clock, f);
    expect(await c.get()).toEqual({ tickSz: "0.001", lotSz: "0.0001", minSz: "1" });
    await c.get();
    expect(n).toBe(1);
    expect(urls[0]).toBe("https://tr.okx.com/api/v5/public/instruments?instType=SPOT&instId=USDT-TRY");
    clock.advance(INSTRUMENTS_TTL_MS - 1);
    await c.get();
    expect(n).toBe(1);
    clock.advance(2);
    await c.get();
    expect(n).toBe(2);
  });

  it("eşzamanlı çağrılar tek istekte birleşir; yenileme başarısızsa eldeki değer, hiç yoksa hata (fail-closed)", async () => {
    const clock = new TestClock();
    let n = 0;
    let fail = false;
    const f: typeof fetch = async () => {
      n++;
      if (fail) throw new Error("ağ yok");
      return new Response(JSON.stringify(INSTRUMENT_BODY), { status: 200 });
    };
    const c = new InstrumentCache(clock, f);
    await Promise.all([c.get(), c.get(), c.get()]);
    expect(n).toBe(1);
    clock.advance(INSTRUMENTS_TTL_MS + 1);
    fail = true;
    expect(await c.get()).toEqual({ tickSz: "0.001", lotSz: "0.0001", minSz: "1" });
    await expect(new InstrumentCache(clock, f).get()).rejects.toThrow();
  });

  it("geçersiz yanıtlar reddedilir", () => {
    const bad = (row: Record<string, unknown>) => parseInstrumentResponse({ code: "0", data: [{ instType: "SPOT", instId: "USDT-TRY", tickSz: "0.001", lotSz: "0.0001", minSz: "1", ...row }] });
    expect(() => bad({ tickSz: "0" })).toThrow();
    expect(() => bad({ lotSz: "abc" })).toThrow();
    expect(() => bad({ minSz: undefined })).toThrow();
    expect(() => bad({ instId: "BTC-USDT" })).toThrow();
    expect(() => parseInstrumentResponse({ code: "1", data: [] })).toThrow();
    expect(() => parseInstrumentResponse(null)).toThrow();
  });
});
