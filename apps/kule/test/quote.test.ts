import { afterEach, describe, expect, it } from "vitest";
import { KULE_TOOLS } from "@pilot/shared";
import { PILOT, makeHarness, type Harness } from "./helpers.js";

const hs: Harness[] = [];
const setup = (): Harness => {
  const h = makeHarness();
  hs.push(h);
  return h;
};
afterEach(() => {
  while (hs.length) hs.pop()!.cleanup();
});

const quote = (h: Harness, input: Record<string, unknown>) => h.service.call("kule_quote", KULE_TOOLS.kule_quote.input.parse(input), PILOT) as Promise<ReturnType<typeof KULE_TOOLS.kule_quote.output.parse>>;

describe("kule_quote (§9.1): emir göndermez, DÜZELT kuralları", () => {
  it("U-2 szHint ≈ amountTL (TL USDT sanılmış) → DÜZELT SZ_LOOKS_LIKE_TL; normalize emir doğru sz ile gelir", async () => {
    const h = setup();
    const r = await quote(h, { side: "buy", amountTL: 10000, ordType: "post_only", szHint: "10000" });
    expect(r.verdict).toBe("DÜZELT");
    expect(r.reasons).toEqual(["SZ_LOOKS_LIKE_TL"]);
    expect(r.normalized).toMatchObject({ instId: "USDT-TRY", side: "buy", ordType: "post_only", px: "49.447" });
    expect(Number(r.normalized!.sz)).toBeCloseTo(10000 / 49.447, 1);
    // %1 içinde sapma da aynı (≈)
    expect((await quote(h, { side: "buy", amountTL: 10000, ordType: "post_only", szHint: "10050" })).reasons).toEqual(["SZ_LOOKS_LIKE_TL"]);
    expect(h.exchange.placed).toHaveLength(0);
  });

  it("U-3 px × sz tutardan %1'den fazla saparsa DÜZELT NOTIONAL_MISMATCH; %1 içinde ONAY", async () => {
    const h = setup();
    const bad = await quote(h, { side: "buy", amountTL: 10000, ordType: "post_only", szHint: "150" });
    expect(bad).toMatchObject({ verdict: "DÜZELT", reasons: ["NOTIONAL_MISMATCH"] });
    const ok = await quote(h, { side: "buy", amountTL: 10000, ordType: "post_only", szHint: "202.2" });
    expect(ok).toMatchObject({ verdict: "ONAY", reasons: [] });
    expect(ok.readback).toContain("10.000 TL ile yaklaşık 202,2 USDT alınacak");
    expect(ok.readback).toContain("yalnız yapıcı");
  });

  it("emir göndermez, yalnız okur (U-1: yalnız USDT-TRY tahtası), ücret tahmini yapıcı/alıcıya göre", async () => {
    const h = setup();
    const m = await quote(h, { side: "buy", amountTL: 10000, ordType: "post_only" });
    const t = await quote(h, { side: "buy", amountTL: 10000, ordType: "ioc" });
    expect(m.estFeeTL).toBe(10); // %0,10
    expect(t.estFeeTL).toBe(22); // %0,22
    expect(t.normalized).toMatchObject({ ordType: "ioc", px: "49.462" });
    expect(h.exchange.placed).toHaveLength(0);
    expect(h.exchange.readCalls.every((c) => c.endsWith(":USDT-TRY") || c.endsWith(":BTC-USDT"))).toBe(true);
  });

  it("px verilirse tick'e aşağı yuvarlanır ve bestBid'i aşamaz; ioc'de bestAsk px'in üstündeyse RET ABOVE_MAX_PX", async () => {
    const h = setup();
    const r = await quote(h, { side: "buy", amountTL: 10000, ordType: "post_only", px: "49.4478" });
    expect(r.normalized!.px).toBe("49.447");
    const above = await quote(h, { side: "buy", amountTL: 10000, ordType: "post_only", px: "60" });
    expect(above.normalized!.px).toBe("49.447"); // bestBid'i aşmaz (post_only çaprazlanmaz)
    const ioc = await quote(h, { side: "buy", amountTL: 10000, ordType: "ioc", px: "49.4" });
    expect(ioc).toMatchObject({ verdict: "RET", reasons: ["ABOVE_MAX_PX"], normalized: null });
  });

  it("minSz altı → RET BELOW_MIN_SZ; bayat veri → RET STALE_DATA", async () => {
    const h = setup();
    expect(await quote(h, { side: "buy", amountTL: 10, ordType: "post_only" })).toMatchObject({ verdict: "RET", reasons: ["BELOW_MIN_SZ"] });
    h.exchange.ageMs = 8000;
    expect(await quote(h, { side: "buy", amountTL: 10000, ordType: "post_only" })).toMatchObject({ verdict: "RET", reasons: ["STALE_DATA"] });
  });

  it("yalnız alış: side=sell şema düzeyinde reddedilir", () => {
    expect(KULE_TOOLS.kule_quote.input.safeParse({ side: "sell", amountTL: 100, ordType: "ioc" }).success).toBe(false);
  });
});
