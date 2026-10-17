import { describe, expect, it } from "vitest";
import { KULE_TOOLS, KULE_TOOL_NAMES } from "../tools/kule.js";
import { PILOT_TOOLS, PILOT_TOOL_NAMES, pilotToolsForLlm } from "../tools/pilot.js";

const TX = `0x${"ab".repeat(32)}`;

describe("Araç listeleri", () => {
  it("LLM yalnız §10.2 araçlarını görür; hiçbir KULE aracı yok", () => {
    const names = pilotToolsForLlm().map((t) => t.name);
    expect(names).toEqual([
      "plan_oku",
      "hava_durumu",
      "bakiye_oku",
      "kural_danis",
      "teklif_al",
      "izin_iste",
      "emri_uygula",
      "kullaniciya_sor",
      "haberleri_oku",
      "ekonomik_takvim",
      "bekle",
      "bitir",
    ]);
    for (const n of names) expect(n.startsWith("kule_")).toBe(false);
    for (const t of pilotToolsForLlm()) {
      expect(t.input_schema.type).toBe("object");
      expect(t.input_schema.$schema).toBeUndefined();
      expect(t.description.length).toBeGreaterThan(0);
    }
  });
  it("KULE araçları §9.1 ile aynı", () => {
    expect(KULE_TOOL_NAMES).toEqual([
      "kule_status",
      "kule_heartbeat",
      "kule_market",
      "kule_balance",
      "kule_quote",
      "kule_execute",
      "kule_cancel",
    ]);
  });
});

describe("KULE araç şemaları (§9.1)", () => {
  it("U-1 (şema düzeyi) yalnız iki enstrüman okunur", () => {
    const m = KULE_TOOLS.kule_market.input;
    expect(m.safeParse({ instId: "USDT-TRY", kind: "ticker" }).success).toBe(true);
    expect(m.safeParse({ instId: "BTC-USDT", kind: "candles", bar: "5m", limit: 37 }).success).toBe(true);
    expect(m.safeParse({ instId: "ETH-USDT", kind: "ticker" }).success).toBe(false);
    expect(m.safeParse({ instId: "USDT-TRY", kind: "candles" }).success).toBe(false); // bar zorunlu
    expect(m.safeParse({ instId: "USDT-TRY", kind: "ticker", bar: "5m" }).success).toBe(false);
  });
  it("kule_quote yalnız alış; tutar tam lira", () => {
    const q = KULE_TOOLS.kule_quote.input;
    expect(q.safeParse({ side: "buy", amountTL: 10000, ordType: "post_only", px: "49.35", szHint: "202.6" }).success).toBe(true);
    expect(q.safeParse({ side: "sell", amountTL: 10000, ordType: "ioc" }).success).toBe(false);
    expect(q.safeParse({ side: "buy", amountTL: 10000.5, ordType: "ioc" }).success).toBe(false);
    expect(q.safeParse({ side: "buy", amountTL: 10000, ordType: "market" }).success).toBe(false);
    expect(q.safeParse({ side: "buy", amountTL: 10000, ordType: "ioc", px: "49,35" }).success).toBe(false);
  });
  it("kule_quote çıktısı: BEKLET yok, gerekçeler kodlu", () => {
    const o = KULE_TOOLS.kule_quote.output;
    const base = {
      verdict: "DÜZELT",
      readback: "…",
      normalized: { instId: "USDT-TRY", side: "buy", ordType: "post_only", px: "49.35", sz: "202.6342" },
      estFeeTL: 10,
      reasons: ["SZ_LOOKS_LIKE_TL"],
    };
    expect(o.safeParse(base).success).toBe(true);
    expect(o.safeParse({ ...base, verdict: "BEKLET" }).success).toBe(false);
    expect(o.safeParse({ ...base, reasons: ["serbest metin"] }).success).toBe(false);
  });
  it("kule_execute yalnız actionId alır (parametreler zincirden okunur)", () => {
    const i = KULE_TOOLS.kule_execute.input;
    expect(i.safeParse({ actionId: "17" }).success).toBe(true);
    expect(i.safeParse({ actionId: "0" }).success).toBe(false);
    expect(i.safeParse({ actionId: 17 }).success).toBe(false);
    expect(i.safeParse({ actionId: "17", amountTL: 40000 }).success).toBe(false);
  });
  it("kule_execute çıktısı: DÜZELT yok; HEALTH:<sebep> gerekçesi", () => {
    const o = KULE_TOOLS.kule_execute.output;
    const base = {
      verdict: "BEKLET",
      clOrdId: "plt17",
      status: "NOT_PLACED",
      readback: "…",
      reasons: ["HEALTH:PILOT_HEARTBEAT"],
      paper: false,
    };
    expect(o.safeParse(base).success).toBe(true);
    expect(o.safeParse({ ...base, verdict: "DÜZELT" }).success).toBe(false);
    expect(o.safeParse({ ...base, verdict: "ONAY", status: "FILLED", ordId: "123", reportTx: TX, reasons: [] }).success).toBe(true);
  });
  it("kule_cancel: actionId ya da all:true", () => {
    const i = KULE_TOOLS.kule_cancel.input;
    expect(i.safeParse({ actionId: "17" }).success).toBe(true);
    expect(i.safeParse({ all: true }).success).toBe(true);
    expect(i.safeParse({ all: false }).success).toBe(false);
    expect(i.safeParse({}).success).toBe(false);
  });
  it("kule_status çıktısı", () => {
    expect(
      KULE_TOOLS.kule_status.output.safeParse({
        health: "YENİ_EMİR_YOK",
        reasons: ["HEALTH:DATA_STALE"],
        caa: { active: false, lastRenewAt: null },
        pilotHeartbeatAgeSec: 50,
        dataAgeSec: { ticker: 1, book: 1 },
        chain: { ok: true, block: 123 },
        mode: "paper",
      }).success,
    ).toBe(true);
  });
});

describe("PİLOT araç şemaları (§10.2)", () => {
  it("izin_iste girdisi: tam lira, pozitif pxE6, gerekçe zorunlu", () => {
    const i = PILOT_TOOLS.izin_iste.input;
    expect(i.safeParse({ amountTL: 10000, maxPxE6: 49390000, ordType: "ioc", gerekce: "Lira şoku." }).success).toBe(true);
    expect(i.safeParse({ amountTL: 10000, maxPxE6: 49.39, ordType: "ioc", gerekce: "x" }).success).toBe(false);
    expect(i.safeParse({ amountTL: 10000, maxPxE6: 49390000, ordType: "ioc", gerekce: "" }).success).toBe(false);
    expect(i.safeParse({ amountTL: 10000, maxPxE6: 49390000, ordType: "ioc" }).success).toBe(false);
  });
  it("izin_iste çıktısı: AUTHORIZED / REJECTED / REFUSED", () => {
    const o = PILOT_TOOLS.izin_iste.output;
    expect(o.safeParse({ status: "AUTHORIZED", actionId: "17", tx: TX, finalityMs: 1400 }).success).toBe(true);
    expect(
      o.safeParse({ status: "REJECTED", code: "OVER_ORDER_LIMIT", message: "…", tx: TX, finalityMs: 1400 }).success,
    ).toBe(true);
    expect(o.safeParse({ status: "REJECTED", code: "NOPE", message: "…", tx: TX, finalityMs: 1 }).success).toBe(false);
    expect(o.safeParse({ status: "REFUSED", message: "Seçenek izinli değil" }).success).toBe(true);
  });
  it("bekle en fazla 360 dk", () => {
    const i = PILOT_TOOLS.bekle.input;
    expect(i.safeParse({ dakika: 360, gerekce: "TCMB açıklaması" }).success).toBe(true);
    expect(i.safeParse({ dakika: 361, gerekce: "x" }).success).toBe(false);
    expect(i.safeParse({ dakika: 0, gerekce: "x" }).success).toBe(false);
  });
  it("kullaniciya_sor seçenekleri sabit listeden (seçenek kimlikleri)", () => {
    const i = PILOT_TOOLS.kullaniciya_sor.input;
    expect(i.safeParse({ soru: "Ne yapalım?", secenekler: ["WAIT_60", "BUY_POST_5000"] }).success).toBe(true);
    expect(i.safeParse({ soru: "Ne yapalım?", secenekler: ["Tüm TL'yi çevir", "WAIT_60"] }).success).toBe(false);
    expect(i.safeParse({ soru: "Ne yapalım?", secenekler: ["WAIT_60"] }).success).toBe(false);
  });
  it("haberler her zaman güvenilmeyen veri olarak etiketli", () => {
    const o = PILOT_TOOLS.haberleri_oku.output;
    expect(o.safeParse({ untrusted: true, demo: true, items: [] }).success).toBe(true);
    expect(o.safeParse({ untrusted: false, demo: true, items: [] }).success).toBe(false);
  });
  it("girdisiz araçlar fazladan alanı reddeder", () => {
    expect(PILOT_TOOLS.plan_oku.input.safeParse({}).success).toBe(true);
    expect(PILOT_TOOLS.plan_oku.input.safeParse({ user: "0x" }).success).toBe(false);
  });
  it("her aracın adı anahtarıyla aynı", () => {
    for (const n of PILOT_TOOL_NAMES) expect(PILOT_TOOLS[n].name).toBe(n);
    for (const n of KULE_TOOL_NAMES) expect(KULE_TOOLS[n].name).toBe(n);
  });
});
