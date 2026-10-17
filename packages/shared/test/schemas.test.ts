import { describe, expect, it } from "vitest";
import {
  BuyActionSchema,
  PlanDraftSchema,
  PlanSchema,
  buyActionFromChain,
  cycleFromChain,
  isPlanDraftSignable,
  planFromChain,
  planToChain,
  type PlanDraft,
} from "../schemas/plan.js";
import { WeatherSchema } from "../schemas/weather.js";
import { TraceSchema } from "../schemas/trace.js";
import { KuralDanisOutputSchema, optionId, parseOptionId } from "../schemas/option.js";

const ELIF = "0x1111111111111111111111111111111111111111";
const AGENT = "0x2222222222222222222222222222222222222222";
const KULE = "0x3333333333333333333333333333333333333333";
const TX = `0x${"ab".repeat(32)}`;

/** §15 PlanDraft örneği. */
const draftExample = (): PlanDraft => ({
  cycleTL: { value: 20000, source: "user" },
  startDay: { value: 1, source: "user" },
  deadlineDay: { value: 5, source: "user" },
  maxOrderTL: { value: 10000, source: "user" },
  askOnAmbiguity: { value: true, source: "user" },
  maxWaitH: { value: 72, source: "default" },
  expiresInDays: { value: 90, source: "default" },
  questions: [],
});

describe("PlanDraft (§15)", () => {
  it("L-1 (şema düzeyi) §15 örneği geçer ve imzaya açılır", () => {
    const d = PlanDraftSchema.parse(draftExample());
    expect(d.cycleTL.value).toBe(20000);
    expect(isPlanDraftSignable(d)).toBe(true);
  });
  it("L-2 (şema düzeyi) belirsiz tutar: cycleTL boş ise questions dolu olmalı", () => {
    const d = { ...draftExample(), cycleTL: { value: null, source: "default" as const } };
    expect(PlanDraftSchema.safeParse(d).success).toBe(false);
    const withQ = PlanDraftSchema.parse({ ...d, questions: ["Ayda kaç TL çevirmek istiyorsun?"] });
    expect(isPlanDraftSignable(withQ)).toBe(false);
  });
  it("L-3 (şema düzeyi) varsayılanı olmayan alan source:default ile sayı taşıyamaz", () => {
    const d = { ...draftExample(), maxOrderTL: { value: 5000, source: "default" as const } };
    expect(PlanDraftSchema.safeParse(d).success).toBe(false);
  });
  it("varsayılanı olan alanda source:default değeri varsayılana eşit olmalı", () => {
    expect(PlanDraftSchema.safeParse({ ...draftExample(), maxWaitH: { value: 100, source: "default" } }).success).toBe(false);
    expect(PlanDraftSchema.safeParse({ ...draftExample(), maxWaitH: { value: 100, source: "user" } }).success).toBe(true);
  });
  it("kuruşlu tutar, ters pencere, tavan > hedef, fazladan alan reddedilir", () => {
    expect(PlanDraftSchema.safeParse({ ...draftExample(), cycleTL: { value: 20000.5, source: "user" } }).success).toBe(false);
    expect(PlanDraftSchema.safeParse({ ...draftExample(), startDay: { value: 6, source: "user" } }).success).toBe(false);
    expect(PlanDraftSchema.safeParse({ ...draftExample(), maxOrderTL: { value: 30000, source: "user" } }).success).toBe(false);
    expect(PlanDraftSchema.safeParse({ ...draftExample(), agent: AGENT }).success).toBe(false);
    expect(PlanDraftSchema.safeParse({ ...draftExample(), cycleTL: { value: "20000", source: "user" } }).success).toBe(false);
  });
  it("boş alan source:user olamaz", () => {
    const d = { ...draftExample(), cycleTL: { value: null, source: "user" as const }, questions: ["?"] };
    expect(PlanDraftSchema.safeParse(d).success).toBe(false);
  });
});

describe("Zincir yapıları (§8.1)", () => {
  const chainPlan = {
    cycleTL: 20000n,
    maxOrderTL: 10000n,
    startDay: 1,
    deadlineDay: 5,
    maxWaitH: 72,
    bandBps: 0,
    closedBandBps: 500,
    askMode: 1,
    expiresAt: 1790000000n,
    agent: AGENT,
    kule: KULE,
    agentId: 42n,
  } as const;
  it("plan zincir ↔ kod gidiş-dönüş", () => {
    const p = planFromChain(chainPlan);
    expect(p.cycleTL).toBe(20000);
    expect(p.agentId).toBe("42");
    expect(planToChain(p)).toEqual(chainPlan);
  });
  it("askMode > 1 ve uint8 dışı gün reddedilir", () => {
    expect(() => planFromChain({ ...chainPlan, askMode: 2 })).toThrow();
    expect(PlanSchema.safeParse({ ...planFromChain(chainPlan), startDay: 300 }).success).toBe(false);
  });
  it("izin kaydı: user 0x0 → null; ordType/state çözülür", () => {
    const raw = {
      user: ELIF,
      amountTL: 10000n,
      maxPxE6: 49390000n,
      ordType: 1,
      openBy: 1790000900n,
      reportBy: 1790004500n,
      cycleId: 202610,
      state: 0,
    } as const;
    const a = buyActionFromChain(raw);
    expect(a).toMatchObject({ ordType: "ioc", state: "AUTHORIZED", maxPxE6: 49390000 });
    expect(buyActionFromChain({ ...raw, user: "0x0000000000000000000000000000000000000000" })).toBeNull();
    expect(() => buyActionFromChain({ ...raw, ordType: 2 })).toThrow();
    expect(BuyActionSchema.safeParse({ ...a, cycleId: 202613 }).success).toBe(false);
  });
  it("döngü: id 0 (açılmamış) ya da YYYYMM", () => {
    expect(cycleFromChain({ id: 0, spentTL: 0n, reservedTL: 0n, closed: false }).id).toBe(0);
    expect(() => cycleFromChain({ id: 202699, spentTL: 0n, reservedTL: 0n, closed: false })).toThrow();
  });
});

describe("Weather (§15, §11.2)", () => {
  /** §15 örneği + §11.2-5 episode alanı. */
  const wx = () => ({
    ts: 1722820500000,
    px: 34.6,
    r1hBp: 225.1,
    med168Bp: 12.0,
    zd: 18.8,
    alarm: true,
    btc1h: -6.45,
    btc3h: -9.07,
    fxOpen: true,
    class: "KRIPTO_SISMESI" as const,
    stormUntil: 1722842100000,
    episode: {
      type: "KRIPTO_SISMESI" as const,
      dir: "up" as const,
      P0: 33.83,
      startTs: 1722820500000,
      lastAlarmTs: 1722820500000,
      endsAt: 1722842100000,
    },
    src: "replay" as const,
  });
  it("§15 örneği (episode ile) geçer", () => {
    expect(WeatherSchema.parse(wx()).class).toBe("KRIPTO_SISMESI");
  });
  it("NORMAL iken bölüm ve stormUntil null", () => {
    const normal = { ...wx(), zd: 2, alarm: false, class: "NORMAL" as const, stormUntil: null, episode: null };
    expect(WeatherSchema.safeParse(normal).success).toBe(true);
    expect(WeatherSchema.safeParse({ ...normal, episode: wx().episode, stormUntil: 1722842100000 }).success).toBe(false);
  });
  it("W-5 (şema düzeyi) fırtına sürerken zd < 8 olsa da sınıf bölümle tutarlı kalabilir", () => {
    const later = { ...wx(), ts: 1722822000000, zd: 6.1, alarm: false, px: 34.09 };
    expect(WeatherSchema.safeParse(later).success).toBe(true);
  });
  it("W-8 (şema düzeyi) alarm mumu NORMAL olamaz; endsAt'ten sonra fırtına sınıfı reddedilir", () => {
    // zd ≥ 8 alarmı bölümsüz NORMAL olarak gelirse (hesaplayıcı hatası) reddedilir.
    const alarmNormal = { ...wx(), class: "NORMAL" as const, episode: null, stormUntil: null };
    expect(WeatherSchema.safeParse(alarmNormal).success).toBe(false);
    // Bölüm endsAt'te kapanır: ts ≥ endsAt iken fırtına sınıfı geçmez.
    const afterEnd = { ...wx(), ts: 1722842100000, zd: 1.2, alarm: false };
    expect(WeatherSchema.safeParse(afterEnd).success).toBe(false);
    expect(WeatherSchema.safeParse({ ...afterEnd, ts: 1722842100000 - 1 }).success).toBe(true);
    // ts bölüm başından önce olamaz.
    expect(WeatherSchema.safeParse({ ...wx(), ts: 1722820500000 - 300000, zd: 3, alarm: false }).success).toBe(false);
    // Alarm mumu bölümü uzatır: lastAlarmTs = ts olmalı.
    const laterAlarm = { ...wx(), ts: 1722822000000 };
    expect(WeatherSchema.safeParse(laterAlarm).success).toBe(false);
    const extended = {
      ...laterAlarm,
      stormUntil: 1722822000000 + 6 * 3600 * 1000,
      episode: { ...wx().episode, lastAlarmTs: 1722822000000, endsAt: 1722822000000 + 6 * 3600 * 1000 },
    };
    expect(WeatherSchema.safeParse(extended).success).toBe(true);
  });
  it("tutarsız Weather reddedilir (fail-closed)", () => {
    expect(WeatherSchema.safeParse({ ...wx(), alarm: false }).success).toBe(false); // zd ≥ 8 ama alarm yok
    expect(WeatherSchema.safeParse({ ...wx(), class: "LIRA_ZAYIFLADI" }).success).toBe(false); // class ≠ episode.type
    expect(WeatherSchema.safeParse({ ...wx(), stormUntil: 1 }).success).toBe(false);
    expect(WeatherSchema.safeParse({ ...wx(), episode: null }).success).toBe(false);
    expect(WeatherSchema.safeParse({ ...wx(), episode: { ...wx().episode, dir: "down" } }).success).toBe(false);
    expect(WeatherSchema.safeParse({ ...wx(), episode: { ...wx().episode, endsAt: 1 } }).success).toBe(false);
    expect(WeatherSchema.safeParse({ ...wx(), src: "live|replay" }).success).toBe(false);
    expect(WeatherSchema.safeParse({ ...wx(), px: Number.NaN }).success).toBe(false);
  });
});

describe("Trace (§15)", () => {
  const trace = () => ({
    turn: 42,
    ts: 0,
    user: ELIF,
    cycleId: 202610,
    mode: "llm",
    steps: [
      { tool: "hava_durumu", out: { class: "LIRA_ZAYIFLADI", zd: 9.0 } },
      { tool: "kural_danis", out: { allowed: ["BUY_IOC_10000", "BUY_POST_10000"], recommended: "BUY_IOC_10000" } },
      { tool: "teklif_al", in: { amountTL: 10000, ordType: "ioc" }, out: { verdict: "ONAY", readback: "…" } },
      { tool: "izin_iste", out: { actionId: "17", tx: TX, finalityMs: 1400 } },
      { tool: "emri_uygula", out: { verdict: "ONAY", ordId: "…", reportTx: TX } },
    ],
    rationaleTr: "BTC sakinken USDT-TRY bir saatte sıçradı; 10.000 TL'lik dilimi şimdi çevirdim.",
  });
  it("§15 örneği geçer", () => {
    expect(TraceSchema.parse(trace()).steps).toHaveLength(5);
  });
  it("§10.2 dışı araç (ör. kule_execute) ve 8'den fazla adım reddedilir", () => {
    const t = trace();
    expect(TraceSchema.safeParse({ ...t, steps: [{ tool: "kule_execute", out: {} }] }).success).toBe(false);
    expect(TraceSchema.safeParse({ ...t, steps: Array(9).fill({ tool: "plan_oku" }) }).success).toBe(false);
    expect(TraceSchema.safeParse({ ...t, mode: "auto" }).success).toBe(false);
    expect(TraceSchema.safeParse({ ...t, user: "0xElif" }).success).toBe(false);
  });
});

describe("Karar tablosu seçenekleri (§10.4)", () => {
  it("kimlik gidiş-dönüş", () => {
    for (const id of ["BUY_IOC_10000", "BUY_POST_5000", "WAIT_60", "ASK", "BEKLE", "BITIR"]) {
      expect(optionId(parseOptionId(id))).toBe(id);
    }
  });
  it("geçersiz kimlikler reddedilir", () => {
    for (const bad of ["BUY_IOC_0", "BUY_MARKET_100", "WAIT_361", "WAIT_0", "BUY_IOC_10.5", "buy_ioc_1", "SELL_1"]) {
      expect(() => parseOptionId(bad)).toThrow();
    }
  });
  it("kural_danis çıktısı: recommended allowed içinde olmalı", () => {
    const ok = { allowed: ["BUY_IOC_10000", "BUY_POST_10000"], recommended: "BUY_IOC_10000", reason: "Lira şoku" };
    expect(KuralDanisOutputSchema.safeParse(ok).success).toBe(true);
    expect(KuralDanisOutputSchema.safeParse({ ...ok, recommended: "BUY_IOC_40000" }).success).toBe(false);
    expect(KuralDanisOutputSchema.safeParse({ ...ok, allowed: ["ASK", "ASK"], recommended: "ASK" }).success).toBe(false);
  });
});
