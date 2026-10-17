import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DATA_DISCLAIMER, limitBuySz, minutesToMs, notionalTLE6, pxToPxE6, utcMs, type UnixMs } from "@pilot/shared";
import { ConfigError, loadServisConfig } from "../src/config.js";
import { denetle, type EmirDenetimiInput } from "../src/emirDenetimi.js";
import { createLiveWeather } from "../src/liraHavaDurumu.js";
import { decodeHeader, mockPaymentProof, type PaymentConfig } from "../src/odeme.js";
import { createOkxPublic, type FetchLike, type InstrumentSpec } from "../src/okxPublic.js";
import { createServisServer } from "../src/server.js";

// ───────────────────────── OKX herkese açık uç nokta taklidi (fetch mock) ─────────────────────────

const REPLAYS = join(dirname(fileURLToPath(import.meta.url)), "../../../data/replays");
type Row = [string, string, string, string, string];
interface ReplayJson {
  candles: { "USDT-TRY": { "5m": Row[]; "1H": Row[] }; "BTC-USDT": { "5m": Row[] } };
}
const AUG5 = JSON.parse(readFileSync(join(REPLAYS, "2024-08-05.json"), "utf8")) as ReplayJson;

const SPEC: InstrumentSpec = { instId: "USDT-TRY", tickSz: "0.01", lotSz: "0.0001", minSz: "1", state: "live" };

interface FakeOkx {
  fetch: FetchLike;
  calls: { url: string; headers: Record<string, string> }[];
}

/** Kayıt dosyasındaki mumları `nowMs` anında OKX `market/candles` gibi sunar (yeniden eskiye, confirm bayrağıyla). */
function fakeOkx(opts: { now: () => UnixMs; replay?: ReplayJson; instrumentsDown?: boolean }): FakeOkx {
  const calls: FakeOkx["calls"] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    const u = new URL(url);
    if (u.origin !== "https://tr.okx.com") throw new Error(`beklenmeyen adres ${url}`);
    if (u.pathname === "/api/v5/public/instruments") {
      if (opts.instrumentsDown) return json({ code: "50001", msg: "down", data: [] }, 503);
      return json({ code: "0", msg: "", data: [{ ...SPEC, instType: "SPOT", baseCcy: "USDT", quoteCcy: "TRY" }] });
    }
    if (u.pathname === "/api/v5/market/candles") {
      const instId = u.searchParams.get("instId") as "USDT-TRY" | "BTC-USDT";
      const bar = u.searchParams.get("bar") as "5m" | "1H";
      const limit = Number(u.searchParams.get("limit"));
      const barMs = bar === "5m" ? minutesToMs(5) : minutesToMs(60);
      const src = (opts.replay ?? AUG5).candles[instId] as Record<string, Row[]>;
      const now = opts.now();
      const rows = (src[bar] ?? [])
        .filter((r) => Number(r[0]) <= now)
        .map((r) => [...r, "0", "0", "0", Number(r[0]) + barMs <= now ? "1" : "0"])
        .reverse()
        .slice(0, limit);
      return json({ code: "0", msg: "", data: rows });
    }
    return json({ code: "51000", msg: "not found", data: [] }, 404);
  };
  return { fetch, calls };
}

// ───────────────────────── Sunucu ─────────────────────────

const MOCK_PAY: PaymentConfig = { mock: true, price: "0.01", recipient: null };
const servers: { close: () => void }[] = [];
afterEach(() => {
  while (servers.length) servers.pop()!.close();
});

async function start(opts: { nowMs: UnixMs; payment?: PaymentConfig; instrumentsDown?: boolean }) {
  let nowMs = opts.nowMs;
  const now = () => nowMs;
  const fake = fakeOkx({ now, instrumentsDown: opts.instrumentsDown });
  const okx = createOkxPublic({ fetch: fake.fetch, now });
  const server = createServisServer({ okx, weather: createLiveWeather({ okx, now }), payment: opts.payment ?? MOCK_PAY, now });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, fake, setNow: (ms: UnixMs) => (nowMs = ms) };
}

async function mcpClient(base: string, headers: Record<string, string> = {}) {
  const client = new Client({ name: "servis-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
  servers.push({ close: () => void client.close() });
  return client;
}

const postEmir = (base: string, body: unknown) =>
  fetch(`${base}/a2mcp/emir-denetimi`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const NOW = utcMs(2024, 8, 5, 1, 17); // 01:15 mumu kapanmış, 01:15–01:20 mumu açık
const TL_TRAP: EmirDenetimiInput = { instId: "USDT-TRY", side: "buy", ordType: "limit", sz: "10000", px: "49.35", niyetTL: 10000 };
const meta = { nowMs: NOW, kaynak: "test" };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const js = (r: Response): Promise<any> => r.json();
const kodlar = (o: { gerekceler: { kod: string }[] }) => o.gerekceler.map((g) => g.kod);

// ───────────────────────── S-1 Emir Denetimi ─────────────────────────

describe("S-1 Emir Denetimi (§12, ücretsiz, anahtarsız)", () => {
  it("S-1 limit buy sz=10000 (TL sanılmış) → DÜZELT; sz USDT'ye çevrilir ve sz × px ≤ niyet tutarı", async () => {
    const { base, fake } = await start({ nowMs: NOW });
    const res = await postEmir(base, TL_TRAP);
    expect(res.status).toBe(200);
    const out = await js(res);
    const expectedSz = limitBuySz({ amountTL: 10000, pxE6: pxToPxE6("49.35"), lotSz: SPEC.lotSz, minSz: SPEC.minSz });
    expect(out.karar).toBe("DÜZELT");
    expect(kodlar(out)).toContain("SZ_LOOKS_LIKE_TL");
    expect(out.gerekceler.find((g: { kod: string }) => g.kod === "SZ_LOOKS_LIKE_TL").metin).toMatch(/limit alışta miktar USDT/);
    expect(out.duzeltme).toEqual({ instId: "USDT-TRY", side: "buy", ordType: "limit", sz: expectedSz, px: "49.35" });
    expect(expectedSz).toBe("202.6342");
    expect(notionalTLE6(out.duzeltme.sz, pxToPxE6("49.35")) <= 10000n * 1_000_000n).toBe(true);
    expect(out.okuma).toMatch(/Gelen: 10\.000 USDT × 49,35 ≈ 493\.500 TL\. Önerilen: ≈ 9\.999 TL ile 202,6342 USDT/);
    expect(out.zaman).toBe(NOW);
    expect(out.kaynak).toMatch(/herkese açık/);
    // anahtarsız: yalnız herkese açık enstrüman uç noktası, imza başlığı yok (CLAUDE.md kural 6)
    expect(fake.calls.map((c) => new URL(c.url).pathname)).toEqual(["/api/v5/public/instruments"]);
    for (const c of fake.calls) expect(Object.keys(c.headers).some((h) => h.startsWith("ok-access"))).toBe(false);
  });

  it("S-1 aynı denetim MCP aracı emir_denetimi ile de DÜZELT döner", async () => {
    const { base } = await start({ nowMs: NOW });
    const client = await mcpClient(base);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(["emir_denetimi", "lira_hava_durumu"]);
    const r = await client.callTool({ name: "emir_denetimi", arguments: TL_TRAP });
    expect(r.isError).toBeFalsy();
    expect((r.structuredContent as { karar: string }).karar).toBe("DÜZELT");
  });

  it("S-1 niyetTL yokken: sz × px tavanı aşıyor → RET OVER_ORDER_LIMIT; sz TL sanılıp küçültülmez, niyetTL ipucu verilir", () => {
    const out = denetle({ ...TL_TRAP, niyetTL: undefined, limitler: { maxOrderTL: 10000 } }, SPEC, meta);
    expect(out.karar).toBe("RET");
    expect(kodlar(out)).toContain("OVER_ORDER_LIMIT");
    expect(kodlar(out)).not.toContain("SZ_LOOKS_LIKE_TL");
    expect(out.duzeltme).toBeUndefined();
    expect(out.gerekceler.find((g) => g.kod === "OVER_ORDER_LIMIT")?.metin).toContain(
      "sz TL olarak yazıldıysa niyetTL gönderin; limit alışta sz USDT'dir.",
    );
  });

  it("S-1 limit emirde tgtCcy=quote_ccy (miktar TL sanılmış) → DÜZELT, tgtCcy kaldırılır", () => {
    const out = denetle({ ...TL_TRAP, niyetTL: undefined, tgtCcy: "quote_ccy" }, SPEC, meta);
    expect(out.karar).toBe("DÜZELT");
    expect(kodlar(out)).toEqual(expect.arrayContaining(["TGTCCY_IGNORED", "SZ_LOOKS_LIKE_TL"]));
    expect(out.duzeltme).toEqual({ instId: "USDT-TRY", side: "buy", ordType: "limit", sz: "202.6342", px: "49.35" });
  });

  it("S-1 doğru birimli limit emir → ONAY, düzeltme yok", () => {
    const out = denetle({ ...TL_TRAP, ordType: "post_only", sz: "202.6342" }, SPEC, meta);
    expect(out.karar).toBe("ONAY");
    expect(out.duzeltme).toBeUndefined();
    expect(out.okuma).toBe("≈ 9.999 TL ile 202,6342 USDT alınacak (limit 49,35, yalnız yapıcı).");
  });

  it("S-1 sz × px niyet tutarından %1'den fazla sapıyor → DÜZELT NOTIONAL_MISMATCH (U-3 ile aynı kural)", () => {
    const out = denetle({ ...TL_TRAP, sz: "150" }, SPEC, meta);
    expect(out.karar).toBe("DÜZELT");
    expect(kodlar(out)).toEqual(["NOTIONAL_MISMATCH"]);
    expect(out.duzeltme?.sz).toBe("202.6342");
  });

  it("S-1 sz × px niyet tutarını az da olsa aşıyor → DÜZELT (U-14: sz × px ≤ tutar)", () => {
    const out = denetle({ ...TL_TRAP, sz: "202.7" }, SPEC, meta);
    expect(out.karar).toBe("DÜZELT");
    expect(out.duzeltme?.sz).toBe("202.6342");
  });

  it("S-1 piyasa alışında sz USDT yazılmış (sz TL olmalı) → DÜZELT sz = niyet tutarı", () => {
    const out = denetle({ instId: "USDT-TRY", side: "buy", ordType: "market", sz: "202.6", niyetTL: 10000 }, SPEC, meta);
    expect(out.karar).toBe("DÜZELT");
    expect(kodlar(out)).toContain("MARKET_SZ_IS_TL");
    expect(out.duzeltme).toEqual({ instId: "USDT-TRY", side: "buy", ordType: "market", sz: "10000", tgtCcy: "quote_ccy" });
    expect(out.okuma).toMatch(/10\.000 TL harcanacak/);
  });

  it("S-1 piyasa alışında sz = niyet tutarı (TL) → ONAY", () => {
    const out = denetle({ instId: "USDT-TRY", side: "buy", ordType: "market", sz: "10000", niyetTL: 10000 }, SPEC, meta);
    expect(out.karar).toBe("ONAY");
  });

  it("S-1 USDT miktarlı piyasa alışı (tgtCcy=base_ccy) niyetTL yoksa RET, varsa TL'ye DÜZELT", () => {
    const base = { instId: "USDT-TRY", side: "buy", ordType: "market", sz: "200", tgtCcy: "base_ccy" } as const;
    expect(denetle(base, SPEC, meta).karar).toBe("RET");
    const fixed = denetle({ ...base, niyetTL: 10000 }, SPEC, meta);
    expect(fixed.karar).toBe("DÜZELT");
    expect(fixed.duzeltme).toMatchObject({ ordType: "market", sz: "10000", tgtCcy: "quote_ccy" });
  });

  it("S-1 fiyat tickSz'ye uymuyor → alışta aşağı yuvarlanır (DÜZELT PX_OFF_TICK)", () => {
    const out = denetle({ ...TL_TRAP, sz: "202.6", px: "49.359" }, SPEC, meta);
    expect(out.karar).toBe("DÜZELT");
    expect(kodlar(out)).toContain("PX_OFF_TICK");
    expect(out.duzeltme?.px).toBe("49.35");
  });

  it("S-1 miktar lotSz katı değil → aşağı yuvarlanır (DÜZELT LOT_ROUNDING)", () => {
    const out = denetle({ ...TL_TRAP, niyetTL: undefined, sz: "100.00005" }, SPEC, meta);
    expect(out.karar).toBe("DÜZELT");
    expect(kodlar(out)).toContain("LOT_ROUNDING");
    expect(out.duzeltme?.sz).toBe("100");
  });

  it("S-1 tavan aşımı → RET OVER_ORDER_LIMIT", () => {
    const out = denetle({ ...TL_TRAP, sz: "405.2684", niyetTL: 20000, limitler: { maxOrderTL: 10000 } }, SPEC, meta);
    expect(out.karar).toBe("RET");
    expect(kodlar(out)).toContain("OVER_ORDER_LIMIT");
    expect(out.duzeltme).toBeUndefined();
  });

  it("S-1 en küçük miktarın altı → RET BELOW_MIN_SZ", () => {
    const out = denetle({ ...TL_TRAP, sz: "0.5", niyetTL: undefined }, SPEC, meta);
    expect(out.karar).toBe("RET");
    expect(kodlar(out)).toContain("BELOW_MIN_SZ");
  });

  it("S-1 yalnız USDT-TRY alışı denetlenir; fiyatsız limit emir RET", () => {
    expect(kodlar(denetle({ ...TL_TRAP, instId: "BTC-USDT" }, SPEC, meta))).toEqual(["BAD_INSTRUMENT"]);
    expect(kodlar(denetle({ ...TL_TRAP, side: "sell" }, SPEC, meta))).toEqual(["SIDE_UNSUPPORTED"]);
    expect(kodlar(denetle({ ...TL_TRAP, px: undefined }, SPEC, meta))).toEqual(["PX_REQUIRED"]);
    expect(kodlar(denetle({ ...TL_TRAP, sz: "0" }, SPEC, meta))).toEqual(["SZ_ZERO"]);
    expect(denetle(TL_TRAP, { ...SPEC, state: "suspend" }, meta).karar).toBe("RET");
    // güvenli aralık dışı tutar: birim yardımcısı reddeder → RET (fırlatmaz)
    expect(kodlar(denetle({ instId: "USDT-TRY", side: "buy", ordType: "market", sz: "99999999999999999999" }, SPEC, meta))).toEqual(["UNREADABLE"]);
  });

  it("S-1 enstrüman bilgisi alınamazsa RET (fail-closed: denetlenemeyen emir onaylanmaz)", async () => {
    const { base } = await start({ nowMs: NOW, instrumentsDown: true });
    const out = await js(await postEmir(base, TL_TRAP));
    expect(out.karar).toBe("RET");
    expect(kodlar(out)).toEqual(["INSTRUMENT_UNAVAILABLE"]);
  });

  it("S-1 şemaya uymayan taslak → 400, bilinmeyen alan ve bozuk JSON reddedilir", async () => {
    const { base } = await start({ nowMs: NOW });
    expect((await postEmir(base, { ...TL_TRAP, sz: 10000 })).status).toBe(400);
    expect((await postEmir(base, { ...TL_TRAP, gizli: "talimat" })).status).toBe(400);
    expect((await postEmir(base, { ...TL_TRAP, niyetTL: 100.5 })).status).toBe(400);
    const bad = await fetch(`${base}/a2mcp/emir-denetimi`, { method: "POST", body: "{bozuk" });
    expect(bad.status).toBe(400);
    expect((await js(bad)).hata).toMatch(/JSON/);
    expect((await fetch(`${base}/a2mcp/emir-denetimi`)).status).toBe(405);
    expect((await fetch(`${base}/yok`)).status).toBe(404);
  });
});

// ───────────────────────── S-2 / S-3 Lira Hava Durumu (x402 temsili) ─────────────────────────

const getHava = (base: string, headers: Record<string, string> = {}) => fetch(`${base}/a2mcp/lira-hava-durumu`, { headers });

describe("S-2 Lira Hava Durumu ödemesiz çağrı → 402", () => {
  it("S-2 ödeme başlığı yoksa 402 + PAYMENT-REQUIRED (base64 JSON); veri hesaplanmaz, OKX'e gidilmez", async () => {
    const { base, fake } = await start({ nowMs: NOW });
    const res = await getHava(base);
    expect(res.status).toBe(402);
    const req = decodeHeader(res.headers.get("payment-required")!) as Record<string, unknown>;
    expect(req).toMatchObject({
      x402Version: 2,
      accepts: [{ scheme: "exact", network: "eip155:196", asset: "USDG", amount: "0.01" }],
      temsili: true,
      etiket: "TEMSİLİ ÖDEME",
    });
    expect(req.hukukNotu).toMatch(/Türkiye'deki kullanıcı için ücretsizdir/);
    const body = await js(res);
    expect(body.odeme.etiket).toBe("TEMSİLİ ÖDEME");
    expect(body.class).toBeUndefined();
    expect(fake.calls).toHaveLength(0);
  });

  it("S-2 bozuk ya da gerçek (temsili olmayan) kanıt → 402", async () => {
    const { base } = await start({ nowMs: NOW });
    expect((await getHava(base, { "PAYMENT-SIGNATURE": "%%%" })).status).toBe(402);
    const real = Buffer.from(JSON.stringify({ x402Version: 2, payload: { signature: "0xabc" } })).toString("base64");
    const r = await getHava(base, { "PAYMENT-SIGNATURE": real });
    expect(r.status).toBe(402);
    expect((await js(r)).hata).toMatch(/yalnız temsili/);
  });

  it("S-2 MCP aracı lira_hava_durumu ödemesiz → araç hatası, durum 402 ve ödeme gereksinimi", async () => {
    const { base } = await start({ nowMs: NOW });
    const client = await mcpClient(base);
    const r = await client.callTool({ name: "lira_hava_durumu", arguments: {} });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ durum: 402, odemeGerekli: { etiket: "TEMSİLİ ÖDEME" } });
  });

  it("S-2 gerçek x402 modu (MOCK_OKX_FACILITATOR=false) henüz yok → 503; ödeme istenmez, veri verilmez", async () => {
    const { base, fake } = await start({ nowMs: NOW, payment: { ...MOCK_PAY, mock: false } });
    for (const h of [{}, { "PAYMENT-SIGNATURE": mockPaymentProof() }] as Record<string, string>[]) {
      const r = await getHava(base, h);
      expect(r.status).toBe(503);
      expect(r.headers.get("payment-required")).toBeNull();
    }
    expect(fake.calls).toHaveLength(0);
  });
});

describe("S-3 temsili ödemeyle veri ve uyari alanı gelir", () => {
  it("S-3 2024-08-05 01:15 UTC: 200, Weather (KRIPTO_SISMESI) + uyari + kaynak + zaman + TEMSİLİ ÖDEME etiketi", async () => {
    const { base, fake } = await start({ nowMs: NOW });
    const res = await getHava(base, { "PAYMENT-SIGNATURE": mockPaymentProof() });
    expect(res.status).toBe(200);
    const body = await js(res);
    expect(body.uyari).toBe(DATA_DISCLAIMER);
    expect(body.uyari).toBe("Veridir, yatırım tavsiyesi değildir.");
    expect(body.ts).toBe(utcMs(2024, 8, 5, 1, 15));
    expect(body.class).toBe("KRIPTO_SISMESI");
    expect(body.zd).toBeCloseTo(18.8, 1);
    expect(body.btc1h).toBeCloseTo(-6.45, 2);
    expect(body.src).toBe("live");
    expect(body.zaman).toBe(NOW);
    expect(body.kaynak).toMatch(/herkese açık mumlar/);
    expect(body.odeme).toEqual({ mod: "TEMSİLİ", etiket: "TEMSİLİ ÖDEME", zincirdeOdeme: false });
    expect(decodeHeader(res.headers.get("payment-response")!)).toMatchObject({ success: true, temsili: true });
    // anahtarsız: yalnız herkese açık mum uç noktası, imza başlığı yok
    expect(new Set(fake.calls.map((c) => new URL(c.url).pathname))).toEqual(new Set(["/api/v5/market/candles"]));
    for (const c of fake.calls) expect(Object.keys(c.headers).some((h) => h.startsWith("ok-access"))).toBe(false);
  });

  it("S-3 fırtına sürerken başlayan servis (01:40, zd < 8) ısınma sayesinde hâlâ KRIPTO_SISMESI der (W-5, kural 14)", async () => {
    const { base } = await start({ nowMs: utcMs(2024, 8, 5, 1, 41) });
    const body = await js(await getHava(base, { "PAYMENT-SIGNATURE": mockPaymentProof() }));
    expect(body.ts).toBe(utcMs(2024, 8, 5, 1, 40));
    expect(body.zd).toBeLessThan(8);
    expect(body.class).toBe("KRIPTO_SISMESI");
    expect(body.episode).toMatchObject({ P0: 33.83, startTs: utcMs(2024, 8, 5, 1, 15) });
  });

  it("S-3 bölüm durumu çağrılar arasında taşınır: 01:15 → 02:15 (geri çekilme) hâlâ KRIPTO_SISMESI", async () => {
    const { base, setNow } = await start({ nowMs: NOW });
    const proof = { "PAYMENT-SIGNATURE": mockPaymentProof() };
    expect((await js(await getHava(base, proof))).class).toBe("KRIPTO_SISMESI");
    setNow(utcMs(2024, 8, 5, 2, 16));
    const later = await js(await getHava(base, proof));
    expect(later.ts).toBe(utcMs(2024, 8, 5, 2, 15));
    expect(later.px).toBe(34.18);
    expect(later.class).toBe("KRIPTO_SISMESI");
  });

  it("S-3 MCP aracı lira_hava_durumu temsili kanıtla (HTTP başlığı) veri ve uyari döner", async () => {
    const { base } = await start({ nowMs: NOW });
    const client = await mcpClient(base, { "PAYMENT-SIGNATURE": mockPaymentProof() });
    const r = await client.callTool({ name: "lira_hava_durumu", arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ durum: 200, class: "KRIPTO_SISMESI", uyari: DATA_DISCLAIMER, odeme: { etiket: "TEMSİLİ ÖDEME" } });
  });

  it("S-3 veri bayatsa (son mum 10 dk'dan eski) 502; sınıf uydurulmaz", async () => {
    // Kayıt 2024-08-06 12:00 UTC'de biter; 1 saat sonra veri bayattır.
    const { base } = await start({ nowMs: utcMs(2024, 8, 6, 13, 0) });
    const r = await getHava(base, { "PAYMENT-SIGNATURE": mockPaymentProof() });
    expect(r.status).toBe(502);
    const body = await js(r);
    expect(body.class).toBeUndefined();
    expect(r.headers.get("payment-response")).toBeNull();
  });
});

// ───────────────────────── Yapılandırma ─────────────────────────

describe("Servis yapılandırması (Ek B)", () => {
  it("varsayılanlar: port 8790, MOCK_OKX_FACILITATOR=true, ücret 0,01", () => {
    expect(loadServisConfig({})).toEqual({ port: 8790, payment: { mock: true, price: "0.01", recipient: null } });
    expect(loadServisConfig({ MOCK_OKX_FACILITATOR: "false" }).payment.mock).toBe(false);
  });

  it("bozuk değerler ConfigError (fail-closed)", () => {
    expect(() => loadServisConfig({ SERVIS_PORT: "80a" })).toThrow(ConfigError);
    expect(() => loadServisConfig({ MOCK_OKX_FACILITATOR: "evet" })).toThrow(ConfigError);
    expect(() => loadServisConfig({ X402_PRICE: "0" })).toThrow(ConfigError);
    expect(() => loadServisConfig({ PAYMENT_RECIPIENT: "0x123" })).toThrow(ConfigError);
  });
});
