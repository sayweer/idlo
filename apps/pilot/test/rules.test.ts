import { beforeAll, describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  KuralDanisOutputSchema,
  WEATHER_CLASSES,
  WeatherSchema,
  cycleIdOf,
  optionId,
  trDateToSec,
  type Cycle,
  type Option,
  type Plan,
  type Weather,
  type WeatherClass,
} from "@pilot/shared";
import {
  DECISION_REASONS as R,
  HOLD_WAIT_MIN,
  MAX_WEATHER_AGE_MS,
  QUESTION_TIMEOUT_SEC,
  decide,
  kuralDanis,
  type Decision,
  type DecisionInput,
  type PendingQuestion,
} from "../src/rules/index.js";
import { readReplayFile, runReplay, utcMs } from "../src/weather/index.js";

// ─────────────────────────────── Kurulum ───────────────────────────────

const H = 3600;
const HMS = 3_600_000;

/** Elif'in planı (§1, §15): 20.000 TL, tavan 10.000, 1–5 arası, sor, 72 sa. */
const PLAN: Plan = {
  cycleTL: 20000,
  maxOrderTL: 10000,
  startDay: 1,
  deadlineDay: 5,
  maxWaitH: 72,
  bandBps: 0,
  closedBandBps: 500,
  askMode: 1,
  expiresAt: 2_000_000_000,
  agent: "0x1111111111111111111111111111111111111111",
  kule: "0x2222222222222222222222222222222222222222",
  agentId: "7",
};

/** Pencerenin 2. günü, TR 12:00 (son güne 3,5 gün var). */
const NOW = trDateToSec(2026, 11, 2, 12);

function cycleAt(nowSec: number, c: Partial<Cycle> = {}): Cycle {
  return { id: cycleIdOf(nowSec), spentTL: 0, reservedTL: 0, closed: false, ...c };
}

/** Şemaya uyan hava: fırtınada bu mum bir alarm mumudur (lastAlarmTs = ts). `startAgoH`: bölüm kaç saat önce açıldı. */
function wx(cls: WeatherClass, nowSec: number, startAgoH = 0.5): Weather {
  const ts = nowSec * 1000 - 5000; // mum kapanışından 5 sn sonra (§10.1)
  if (cls === "NORMAL") {
    return WeatherSchema.parse({
      ts, px: 42.5, r1hBp: 3, med168Bp: 10, zd: 0.3, alarm: false, btc1h: 0.1, btc3h: 0.2, fxOpen: true,
      class: "NORMAL", stormUntil: null, episode: null, src: "replay",
    });
  }
  const startTs = Math.min(ts, nowSec * 1000 - Math.round(startAgoH * HMS));
  const dir = cls === "TL_GUCLENDI" ? "down" : "up";
  const episode = { type: cls, dir, P0: 42.0, startTs, lastAlarmTs: ts, endsAt: ts + 6 * HMS };
  return WeatherSchema.parse({
    ts, px: 42.9, r1hBp: dir === "down" ? -95 : 95, med168Bp: 10, zd: 9.5, alarm: true,
    btc1h: cls === "KRIPTO_SISMESI" ? -3 : 0, btc3h: 0, fxOpen: cls !== "PRIM_SISMESI",
    class: cls, stormUntil: episode.endsAt, episode, src: "replay",
  });
}

function input(o: Partial<DecisionInput> & { cls?: WeatherClass; startAgoH?: number } = {}): DecisionInput {
  const { cls = "NORMAL", startAgoH, ...rest } = o;
  const nowSec = rest.nowSec ?? NOW;
  return {
    nowSec,
    planActive: true,
    plan: PLAN,
    cycle: cycleAt(nowSec),
    weather: wx(cls, nowSec, startAgoH),
    question: null,
    halfTakenEpisodeTs: null,
    ...rest,
  };
}

const ids = (d: Decision) => d.allowed.map(optionId);
const rec = (d: Decision) => optionId(d.recommended);
const hasBuy = (d: Decision) => d.allowed.some((x) => x.kind === "BUY");
const plan = (p: Partial<Plan>): Plan => ({ ...PLAN, ...p });
const epStart = (i: DecisionInput) => i.weather.episode!.startTs;

/** Her kararın genel değişmezleri: çıktı şeması, recommended ∈ allowed, BUY ≤ min(tavan, kalan). */
function check(i: unknown, d: Decision): void {
  const out = KuralDanisOutputSchema.parse({ allowed: ids(d), recommended: rec(d), reason: d.reason });
  expect(out.allowed).toContain(out.recommended);
  const p = (i as DecisionInput)?.plan;
  const c = (i as DecisionInput)?.cycle;
  for (const o of d.allowed) {
    if (o.kind === "BUY" && p && c) {
      expect(o.amountTL).toBeGreaterThanOrEqual(1);
      expect(o.amountTL).toBeLessThanOrEqual(Math.min(p.maxOrderTL, p.cycleTL - c.spentTL - c.reservedTL));
    }
  }
}
function run(i: unknown): Decision {
  const d = decide(i);
  check(i, d);
  return d;
}
const HOLD = `WAIT_${HOLD_WAIT_MIN}`;

// ─────────────────────────────── D-1 … D-9 ───────────────────────────────

describe("Karar tablosu — §10.4 satırları (§18 D-1…D-9)", () => {
  it("D-1 pencere öncesi: yalnız BEKLE (her hava sınıfında)", () => {
    const nowSec = trDateToSec(2026, 11, 2, 12);
    for (const cls of WEATHER_CLASSES) {
      const d = run(input({ nowSec, cls, plan: plan({ startDay: 3, deadlineDay: 5 }) }));
      expect(ids(d)).toEqual(["BEKLE"]);
      expect(d.reason).toBe("Pencere açılmadı");
    }
  });

  it("D-1 TR günü UTC 21:00'de değişir: başlangıç gününden önceki gece 20:59 UTC BEKLE, 21:00 UTC pencere açık", () => {
    const p = plan({ startDay: 3, deadlineDay: 5 });
    const before = trDateToSec(2026, 11, 2, 23, 59); // = 20:59 UTC
    const opened = trDateToSec(2026, 11, 3, 0, 0); // = 21:00 UTC
    expect(ids(run(input({ nowSec: before, plan: p })))).toEqual(["BEKLE"]);
    expect(rec(run(input({ nowSec: opened, plan: p })))).toBe("BUY_POST_10000");
  });

  it("D-1 pencere kapandı (son gün geçti ya da döngü kapalı): BUY yok, BEKLE (TODO(spec))", () => {
    for (const cls of WEATHER_CLASSES) {
      const after = trDateToSec(2026, 11, 6, 0, 1);
      const d1 = run(input({ nowSec: after, cls }));
      expect(ids(d1)).toEqual(["BEKLE"]);
      expect(d1.reason).toBe(R.closed);
      const d2 = run(input({ cls, cycle: cycleAt(NOW, { closed: true, spentTL: 5000 }) }));
      expect(ids(d2)).toEqual(["BEKLE"]);
    }
  });

  it("D-2 KRIPTO_SISMESI ve waited < maxWaitH → önerilen BEKLE (60 dk); yarısı post_only izinli", () => {
    const d = run(input({ cls: "KRIPTO_SISMESI", startAgoH: 10 }));
    expect(rec(d)).toBe("WAIT_60");
    expect(ids(d)).toEqual(["WAIT_60", "BUY_POST_5000"]);
    expect(d.reason).toBe("Fiyat geçici olarak şişkin; geçmişte geri indi");
  });

  it("D-2 waitedH bölüm başından ölçülür: 71 sa 59 dk hâlâ BEKLE", () => {
    const d = run(input({ cls: "KRIPTO_SISMESI", startAgoH: 72 - 1 / 60 }));
    expect(rec(d)).toBe("WAIT_60");
  });

  it("D-3 KRIPTO_SISMESI ve 72 sa doldu → yalnız BUY(chunk, post_only)", () => {
    const d = run(input({ cls: "KRIPTO_SISMESI", startAgoH: 72 }));
    expect(ids(d)).toEqual(["BUY_POST_10000"]);
    expect(d.reason).toBe("En fazla bekleme süresi doldu");
  });

  it("D-3 maxWaitH plandan okunur (24 sa planı 24 sa sonra alır; 0 sa planı hiç beklemez)", () => {
    expect(ids(run(input({ cls: "KRIPTO_SISMESI", startAgoH: 24, plan: plan({ maxWaitH: 24 }) })))).toEqual(["BUY_POST_10000"]);
    expect(rec(run(input({ cls: "KRIPTO_SISMESI", startAgoH: 23.9, plan: plan({ maxWaitH: 24 }) })))).toBe("WAIT_60");
    expect(ids(run(input({ cls: "KRIPTO_SISMESI", startAgoH: 0, plan: plan({ maxWaitH: 0 }) })))).toEqual(["BUY_POST_10000"]);
  });

  it("D-4 LIRA_ZAYIFLADI → önerilen BUY ioc; kural_danis çıktısı §15 iz örneğiyle aynı", () => {
    const d = run(input({ cls: "LIRA_ZAYIFLADI" }));
    expect(rec(d)).toBe("BUY_IOC_10000");
    expect(d.reason).toBe("Lira şoku; beklemek sıçrama riskini taşımak demek");
    const out = kuralDanis(input({ cls: "LIRA_ZAYIFLADI" }));
    expect({ allowed: out.allowed, recommended: out.recommended }).toEqual({
      allowed: ["BUY_IOC_10000", "BUY_POST_10000"],
      recommended: "BUY_IOC_10000",
    });
  });

  it("D-5 TL_GUCLENDI → BUY (önerilen post_only, ioc da izinli)", () => {
    const d = run(input({ cls: "TL_GUCLENDI" }));
    expect(ids(d)).toEqual(["BUY_IOC_10000", "BUY_POST_10000"]);
    expect(rec(d)).toBe("BUY_POST_10000");
    expect(d.reason).toBe("USDT ucuzladı; geçmişte 24 saatte toparlandı");
  });

  it("D-5 NORMAL (hava açık) → önerilen BUY post_only; 30 dk bekleme izinli", () => {
    const d = run(input({ cls: "NORMAL" }));
    expect(ids(d)).toEqual(["BUY_POST_10000", "WAIT_30"]);
    expect(rec(d)).toBe("BUY_POST_10000");
    expect(d.reason).toBe("Hava açık; lira kayması beklemeyi pahalı yapıyor");
  });

  it("D-6 BELIRSIZ ve askMode açık → ASK seçenekler arasında (önerilen); kapalı → yalnız 60 dk bekle", () => {
    const on = run(input({ cls: "BELIRSIZ" }));
    expect(ids(on)).toEqual(["ASK", "BUY_POST_5000", "WAIT_60"]);
    expect(rec(on)).toBe("ASK");
    expect(on.reason).toBe("Tür belirsiz");
    const off = run(input({ cls: "BELIRSIZ", plan: plan({ askMode: 0 }) }));
    expect(ids(off)).toEqual(["WAIT_60"]);
  });

  it("D-9 PRIM_SISMESI ve askMode açık → önerilen ASK (hafta sonu yükselişi Elif'e sorulur, v4.1)", () => {
    const d = run(input({ cls: "PRIM_SISMESI" }));
    expect(ids(d)).toEqual(["ASK", "WAIT_60", "BUY_POST_5000"]);
    expect(rec(d)).toBe("ASK");
    expect(d.reason).toBe("Hafta sonu yükselişi; tür kesin değil, Elif'e soruyorum");
  });

  it("D-9 PRIM_SISMESI ve askMode kapalı → yalnız yarısını al (post_only)", () => {
    const d = run(input({ cls: "PRIM_SISMESI", plan: plan({ askMode: 0 }) }));
    expect(ids(d)).toEqual(["BUY_POST_5000"]);
    expect(d.reason).toBe("Hafta sonu yükselişi; risk bölünüyor");
  });

  it("D-7 son güne < 24 sa → her sınıfta, her soru/yarım durumunda yalnız BUY(chunk, ioc)", () => {
    const nowSec = trDateToSec(2026, 11, 5, 9); // son gün, TR 09:00
    for (const cls of WEATHER_CLASSES) {
      for (const askMode of [0, 1] as const) {
        const base = input({ nowSec, cls, plan: plan({ askMode }), startAgoH: 1 });
        const ep = base.weather.episode?.startTs ?? 0;
        const variants: DecisionInput[] = [
          base,
          { ...base, question: { status: "PENDING", episodeStartTs: ep, askedAtSec: nowSec - 600 } },
          { ...base, halfTakenEpisodeTs: ep },
        ];
        for (const v of variants) {
          const d = run(v);
          expect(ids(d)).toEqual(["BUY_IOC_10000"]);
          expect(d.reason).toBe("Son güne 24 saatten az kaldı");
        }
      }
    }
  });

  it("D-7 sınır: son gün 00:00:00 tam 24 sa (henüz değil), 00:00:01 ve 23:59 BUY ioc; önceki gün 23:59 değil", () => {
    const dayStart = trDateToSec(2026, 11, 5, 0, 0);
    expect(rec(run(input({ nowSec: dayStart - 60, cls: "KRIPTO_SISMESI" })))).toBe("WAIT_60");
    expect(rec(run(input({ nowSec: dayStart, cls: "KRIPTO_SISMESI" })))).toBe("WAIT_60");
    expect(ids(run(input({ nowSec: dayStart + 1, cls: "KRIPTO_SISMESI" })))).toEqual(["BUY_IOC_10000"]);
    expect(ids(run(input({ nowSec: dayStart + 24 * H - 60, cls: "KRIPTO_SISMESI" })))).toEqual(["BUY_IOC_10000"]);
  });

  it("D-7 son günde dilim = min(tavan, kalan)", () => {
    const nowSec = trDateToSec(2026, 11, 5, 9);
    const d = run(input({ nowSec, cls: "KRIPTO_SISMESI", cycle: cycleAt(nowSec, { spentTL: 17000 }) }));
    expect(ids(d)).toEqual(["BUY_IOC_3000"]);
  });

  it("D-8 hedef tamamsa BITIR (her sınıfta, pencere dışında ve son günde de)", () => {
    for (const cls of WEATHER_CLASSES) {
      for (const nowSec of [NOW, trDateToSec(2026, 11, 5, 9), trDateToSec(2026, 11, 20, 9)]) {
        const d = run(input({ nowSec, cls, cycle: cycleAt(nowSec, { spentTL: 20000 }) }));
        expect(ids(d)).toEqual(["BITIR"]);
        expect(d.reason).toBe("Bu ayın hedefi tamam");
      }
    }
  });

  it("D-8 kalan izinlerde (spent + reserved = hedef, spent < hedef): BITIR değil, BUY değil, kısa bekleme (TODO(spec))", () => {
    const d = run(input({ cls: "LIRA_ZAYIFLADI", cycle: cycleAt(NOW, { spentTL: 10000, reservedTL: 10000 }) }));
    expect(ids(d)).toEqual([HOLD]);
    expect(d.reason).toBe(R.reservedPending);
  });

  it("D-8 dilim = min(maxOrderTL, cycleTL − spent − reserved); yarısı aşağı yuvarlanır, en az 1 TL", () => {
    expect(rec(run(input({ cls: "LIRA_ZAYIFLADI", cycle: cycleAt(NOW, { spentTL: 9000, reservedTL: 4000 }) })))).toBe("BUY_IOC_7000");
    expect(ids(run(input({ cls: "PRIM_SISMESI", cycle: cycleAt(NOW, { spentTL: 12999 }) })))).toContain("BUY_POST_3500");
    expect(ids(run(input({ cls: "PRIM_SISMESI", plan: plan({ askMode: 0 }), cycle: cycleAt(NOW, { spentTL: 19999 }) })))).toEqual([
      "BUY_POST_1",
    ]);
  });
});

// ─────────────────────── Soru zaman aşımı (§10.4) ───────────────────────

describe("Karar tablosu — Elif'e soru ve 2 sa zaman aşımı (§10.4, §16 #9; D-6, D-9)", () => {
  for (const cls of ["PRIM_SISMESI", "BELIRSIZ"] as const) {
    const id = cls === "PRIM_SISMESI" ? "D-9" : "D-6";

    it(`${id} ${cls}: soru bekliyorken yeniden sorulmaz ve alım yok; zaman aşımına kadar (≤ 60 dk) beklenir`, () => {
      const i = input({ cls, startAgoH: 2 });
      const q = (agoSec: number): PendingQuestion => ({ status: "PENDING", episodeStartTs: epStart(i), askedAtSec: NOW - agoSec });
      expect(ids(run({ ...i, question: q(0) }))).toEqual(["WAIT_60"]);
      expect(ids(run({ ...i, question: q(90 * 60) }))).toEqual(["WAIT_30"]);
      const last = run({ ...i, question: q(QUESTION_TIMEOUT_SEC - 1) });
      expect(ids(last)).toEqual(["WAIT_1"]);
      expect(last.reason).toBe(R.questionPending);
    });

    it(`${id} ${cls}: Elif 2 sa içinde cevap vermezse varsayılan yarısını al (post_only)`, () => {
      const i = input({ cls, startAgoH: 3 });
      const d = run({ ...i, question: { status: "PENDING", episodeStartTs: epStart(i), askedAtSec: NOW - QUESTION_TIMEOUT_SEC } });
      expect(ids(d)).toEqual(["BUY_POST_5000"]);
      expect(d.reason).toBe("Elif 2 saat içinde cevap vermedi; varsayılan: yarısını al");
    });

    it(`${id} ${cls}: yarısı alındıktan sonra kalan yarı fırtına bitince değerlendirilir (bölüm sürerken BUY yok)`, () => {
      const i = input({ cls, startAgoH: 3 });
      const d = run({ ...i, halfTakenEpisodeTs: epStart(i) });
      expect(ids(d)).toEqual(["WAIT_60"]);
      expect(d.reason).toBe(R.halfTaken);
      // Fırtına bitti (NORMAL) → kalan normal tabloyla.
      expect(rec(run({ ...input({ cls: "NORMAL" }), halfTakenEpisodeTs: epStart(i) }))).toBe("BUY_POST_10000");
    });

    it(`${id} ${cls}: Elif'in cevabı (izinli bir seçenekse) tek seçenek olur; ASK yeniden önerilmez`, () => {
      const i = input({ cls, startAgoH: 3 });
      const ans = (answer: string, answeredAgoSec = 60): PendingQuestion => ({
        status: "ANSWERED", episodeStartTs: epStart(i), askedAtSec: NOW - answeredAgoSec - 600, answer, answeredAtSec: NOW - answeredAgoSec,
      });
      const b = run({ ...i, question: ans("BUY_POST_5000") });
      expect(ids(b)).toEqual(["BUY_POST_5000"]);
      expect(b.reason).toBe("Elif'in cevabı: 5.000 TL al (yalnız yapıcı)");
      expect(ids(run({ ...i, question: ans("WAIT_60", 59 * 60) }))).toEqual(["WAIT_60"]);
      // Bekleme cevabının süresi bitti → tablo yeniden sorar.
      expect(rec(run({ ...i, question: ans("WAIT_60", 60 * 60) }))).toBe("ASK");
    });

    it(`${id} ${cls}: izinli olmayan cevap (tavanı aşan, ioc, ASK, BITIR) uygulanmaz → tablo yeniden sorar`, () => {
      const i = input({ cls, startAgoH: 1 });
      for (const answer of ["BUY_POST_10000", "BUY_IOC_5000", "BUY_POST_40000", "ASK", "BITIR", "BEKLE", "WAIT_360"]) {
        const d = run({
          ...i,
          question: { status: "ANSWERED", episodeStartTs: epStart(i), askedAtSec: NOW - 600, answer, answeredAtSec: NOW - 60 },
        });
        expect(rec(d)).toBe("ASK");
        expect(ids(d)).not.toContain("BUY_POST_10000");
      }
    });

    it(`${id} ${cls}: başka bölümün sorusu ve yarısı yok sayılır`, () => {
      const i = input({ cls, startAgoH: 1 });
      const other = epStart(i) - 10 * HMS;
      const d = run({
        ...i,
        question: { status: "PENDING", episodeStartTs: other, askedAtSec: NOW - 3 * H },
        halfTakenEpisodeTs: other,
      });
      expect(rec(d)).toBe("ASK");
    });

    it(`${id} ${cls}: askMode kapalıyken bekleyen soru tabloyu değiştirmez`, () => {
      const i = input({ cls, plan: plan({ askMode: 0 }), startAgoH: 3 });
      const d = run({ ...i, question: { status: "PENDING", episodeStartTs: epStart(i), askedAtSec: NOW - 3 * H } });
      expect(ids(d)).toEqual(cls === "PRIM_SISMESI" ? ["BUY_POST_5000"] : ["WAIT_60"]);
    });
  }

  it("D-2 soru sorulmuşken bölüm KRIPTO_SISMESI'ne yükselirse soru yok sayılır; tablo KRIPTO satırını uygular", () => {
    const i = input({ cls: "KRIPTO_SISMESI", startAgoH: 5 });
    const d = run({ ...i, question: { status: "PENDING", episodeStartTs: epStart(i), askedAtSec: NOW - 3 * H } });
    expect(rec(d)).toBe("WAIT_60");
    expect(ids(d)).not.toContain("ASK");
  });
});

// ─────────────────────── Fail-closed (CLAUDE.md kural 2) ───────────────────────

describe("Karar tablosu — fail-closed: doğrulanamayan girdide BUY yok (son günde, lira şokunda bile; D-7)", () => {
  const DEADLINE = trDateToSec(2026, 11, 5, 9);
  const good = (): DecisionInput => input({ nowSec: DEADLINE, cls: "LIRA_ZAYIFLADI" });

  it("D-7 geçerli girdi bu durumda BUY verir (kontrol örneği)", () => {
    expect(ids(run(good()))).toEqual(["BUY_IOC_10000"]);
  });

  it("D-7 plan etkin değil (iptal / süresi dolmuş) → BUY yok", () => {
    for (const i of [
      { ...good(), planActive: false },
      { ...good(), plan: plan({ expiresAt: DEADLINE }) },
      { ...good(), plan: plan({ expiresAt: DEADLINE - 1 }) },
    ]) {
      const d = run(i);
      expect(ids(d)).toEqual([HOLD]);
      expect(d.reason).toBe(R.planInactive);
    }
  });

  const broken: [string, (g: DecisionInput) => unknown][] = [
    ["girdi yok", () => undefined],
    ["null", () => null],
    ["dizi", () => []],
    ["metin", () => "BUY_IOC_10000"],
    ["plan yok", (g) => ({ ...g, plan: null })],
    ["döngü yok", (g) => ({ ...g, cycle: undefined })],
    ["hava yok", (g) => ({ ...g, weather: null })],
    ["fazladan alan (strict)", (g) => ({ ...g, override: "BUY" })],
    ["planActive metin", (g) => ({ ...g, planActive: "true" })],
    ["nowSec NaN", (g) => ({ ...g, nowSec: Number.NaN })],
    ["nowSec ondalık", (g) => ({ ...g, nowSec: g.nowSec + 0.5 })],
    ["nowSec negatif", (g) => ({ ...g, nowSec: -1 })],
    ["kuruşlu TL", (g) => ({ ...g, plan: { ...g.plan, cycleTL: 20000.5 } })],
    ["maxOrderTL > cycleTL", (g) => ({ ...g, plan: { ...g.plan, maxOrderTL: 40000 } })],
    ["maxOrderTL 0", (g) => ({ ...g, plan: { ...g.plan, maxOrderTL: 0 } })],
    ["cycleTL 0", (g) => ({ ...g, plan: { ...g.plan, cycleTL: 0, maxOrderTL: 0 } })],
    ["startDay > deadlineDay", (g) => ({ ...g, plan: { ...g.plan, startDay: 6 } })],
    ["startDay 0", (g) => ({ ...g, plan: { ...g.plan, startDay: 0 } })],
    ["deadlineDay 31", (g) => ({ ...g, plan: { ...g.plan, deadlineDay: 31 } })],
    ["askMode 2", (g) => ({ ...g, plan: { ...g.plan, askMode: 2 } })],
    ["bozuk adres", (g) => ({ ...g, plan: { ...g.plan, agent: "0xdead" } })],
    ["spentTL negatif", (g) => ({ ...g, cycle: { ...g.cycle, spentTL: -10000 } })],
    ["reservedTL NaN", (g) => ({ ...g, cycle: { ...g.cycle, reservedTL: Number.NaN } })],
    ["döngü önceki aydan (bayat okuma)", (g) => ({ ...g, cycle: { ...g.cycle, id: 202610 } })],
    ["döngü id 0", (g) => ({ ...g, cycle: { ...g.cycle, id: 0 } })],
    ["hava bayat (sınırın 1 ms ötesi)", (g) => ({ ...g, weather: reTs(g.weather, g.nowSec * 1000 - MAX_WEATHER_AGE_MS - 1) })],
    ["hava gelecekten", (g) => ({ ...g, weather: reTs(g.weather, g.nowSec * 1000 + 1) })],
    ["hava sınıfı uydurma", (g) => ({ ...g, weather: { ...g.weather, class: "AL_HEMEN" } })],
    ["hava: alarm ama zd < 8", (g) => ({ ...g, weather: { ...g.weather, zd: 2 } })],
    ["hava: fırtına sınıfı, bölüm yok", (g) => ({ ...g, weather: { ...g.weather, episode: null, stormUntil: null } })],
    ["hava: NORMAL ama bölüm var", (g) => ({ ...g, weather: { ...g.weather, class: "NORMAL", alarm: false, zd: 1 } })],
    ["hava: class ≠ episode.type", (g) => ({ ...g, weather: { ...g.weather, class: "TL_GUCLENDI" } })],
    ["soru gelecekten", (g) => ({ ...g, question: { status: "PENDING", episodeStartTs: epStart(g), askedAtSec: g.nowSec + 1 } })],
    ["soru bölümden önce", (g) => ({ ...g, question: { status: "PENDING", episodeStartTs: epStart(g), askedAtSec: epStart(g) / 1000 - 1 } })],
    ["cevap sorudan önce", (g) => ({
      ...g,
      question: { status: "ANSWERED", episodeStartTs: epStart(g), askedAtSec: g.nowSec - 60, answer: "WAIT_60", answeredAtSec: g.nowSec - 120 },
    })],
    ["cevap bozuk kimlik", (g) => ({
      ...g,
      question: { status: "ANSWERED", episodeStartTs: epStart(g), askedAtSec: g.nowSec - 60, answer: "BUY_IOC_-1", answeredAtSec: g.nowSec },
    })],
    ["soru durumu uydurma", (g) => ({ ...g, question: { status: "APPROVED", episodeStartTs: epStart(g), askedAtSec: g.nowSec } })],
    ["halfTakenEpisodeTs gelecekten", (g) => ({ ...g, halfTakenEpisodeTs: g.nowSec * 1000 + 1 })],
  ];

  for (const [name, mk] of broken) {
    it(`D-7 bozuk girdi (${name}) → BUY yok, tek seçenek kısa bekleme`, () => {
      const d = run(mk(good()));
      expect(hasBuy(d)).toBe(false);
      expect(ids(d)).toEqual([HOLD]);
      expect(d.reason).toBe(R.invalidInput);
      expect(KuralDanisOutputSchema.safeParse(kuralDanis(mk(good()))).success).toBe(true);
    });
  }

  it("D-7 hava tam sınırda (10 dk eski) kabul edilir", () => {
    const g = good();
    expect(ids(run({ ...g, weather: reTs(g.weather, g.nowSec * 1000 - MAX_WEATHER_AGE_MS) }))).toEqual(["BUY_IOC_10000"]);
  });

  it("D-7 girdi değiştirilmez (saf fonksiyon) ve aynı girdi aynı kararı verir", () => {
    const g = good();
    const snap = JSON.stringify(g);
    const a = decide(g);
    const b = decide(JSON.parse(snap));
    expect(JSON.stringify(g)).toBe(snap);
    expect(b).toEqual(a);
  });

  it("D-1…D-9 değişmezler, rastgele girdilerde: recommended ∈ allowed; BUY yalnız etkin planda, pencere içinde, ≤ min(tavan, kalan)", () => {
    let seed = 0x9e3779b9;
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
    for (let n = 0; n < 3000; n++) {
      const startDay = 1 + Math.floor(rnd() * 10);
      const deadlineDay = startDay + Math.floor(rnd() * (28 - startDay + 1));
      const cycleTL = 1 + Math.floor(rnd() * 50000);
      const maxOrderTL = 1 + Math.floor(rnd() * cycleTL);
      const p = plan({ startDay, deadlineDay, cycleTL, maxOrderTL, askMode: pick([0, 1] as const), maxWaitH: Math.floor(rnd() * 100) });
      const nowSec = trDateToSec(2026, 1 + Math.floor(rnd() * 12), 1 + Math.floor(rnd() * 28), Math.floor(rnd() * 24), Math.floor(rnd() * 60));
      const spentTL = Math.floor(rnd() * (cycleTL + 2));
      const reservedTL = rnd() < 0.5 ? 0 : Math.floor(rnd() * (cycleTL + 2));
      const i = input({
        nowSec, plan: p, planActive: rnd() < 0.9, cls: pick(WEATHER_CLASSES), startAgoH: rnd() * 100,
        cycle: cycleAt(nowSec, { spentTL, reservedTL, closed: rnd() < 0.05 }),
      });
      const ep = i.weather.episode?.startTs ?? null;
      if (ep !== null && rnd() < 0.3) i.question = { status: "PENDING", episodeStartTs: ep, askedAtSec: nowSec - Math.floor(rnd() * 3 * H) };
      if (ep !== null && rnd() < 0.1) i.halfTakenEpisodeTs = ep;
      if (i.question && i.question.askedAtSec * 1000 < ep!) i.question = null;

      const d = run(i);
      const day = new Date((nowSec + 3 * H) * 1000).getUTCDate();
      const buys = d.allowed.filter((o): o is Extract<Option, { kind: "BUY" }> => o.kind === "BUY");
      if (!i.planActive || day < startDay || day > deadlineDay || i.cycle.closed || spentTL + reservedTL >= cycleTL) {
        expect(buys).toEqual([]);
      }
      if (spentTL >= cycleTL && i.planActive) expect(ids(d)).toEqual(["BITIR"]);
    }
  });
});

function reTs(w: Weather, ts: number): Weather {
  if (w.episode === null) return { ...w, ts };
  const episode = { ...w.episode, startTs: Math.min(w.episode.startTs, ts), lastAlarmTs: ts, endsAt: ts + 6 * HMS };
  return { ...w, ts, episode, stormUntil: episode.endsAt };
}

// ─────────────────────── Kayıt oynatma ile uçtan uca (§11.2 + §10.4) ───────────────────────

describe("Karar tablosu — gerçek kayıtlarla (Lira Hava Durumu → kural_danis)", () => {
  const REPLAYS = join(dirname(fileURLToPath(import.meta.url)), "../../../data/replays");
  const DAYS = ["2024-08-05", "2025-03-19", "2025-10-10", "2025-12-02", "2026-02-01"] as const;
  const series = {} as Record<(typeof DAYS)[number], Weather[]>;
  beforeAll(async () => {
    for (const d of DAYS) series[d] = runReplay(await readReplayFile(join(REPLAYS, `${d}.json`)));
  });
  const at = (day: (typeof DAYS)[number], ts: number) => {
    const w = series[day].find((x) => x.ts === ts);
    if (!w) throw new Error(`${day} ${new Date(ts).toISOString()} yok`);
    return w;
  };
  /** Mum kapanışından 5 sn sonra karar (§10.1). Pencere tarihi kapsar, son güne > 24 sa. */
  const live = (w: Weather, p: Partial<Plan>, extra: Partial<DecisionInput> = {}): DecisionInput => {
    const nowSec = w.ts / 1000 + 5;
    return { nowSec, planActive: true, plan: plan(p), cycle: cycleAt(nowSec), weather: w, question: null, halfTakenEpisodeTs: null, ...extra };
  };

  it("D-2 2024-08-05 01:15 KRIPTO_SISMESI → bekle; geri çekilmede (01:40, 01:50, 02:15) hâlâ bekle (§19 sahnesi)", () => {
    for (const [h, m] of [[1, 15], [1, 40], [1, 50], [2, 15]] as const) {
      const w = at("2024-08-05", utcMs(2024, 8, 5, h, m));
      expect(w.class).toBe("KRIPTO_SISMESI");
      expect(rec(run(live(w, { startDay: 1, deadlineDay: 10 })))).toBe("WAIT_60");
    }
  });

  it("D-4 2025-03-19 07:10 ve 08:40 LIRA_ZAYIFLADI → önerilen BUY ioc 10.000", () => {
    for (const [h, m] of [[7, 10], [8, 40]] as const) {
      const d = run(live(at("2025-03-19", utcMs(2025, 3, 19, h, m)), { startDay: 15, deadlineDay: 25 }));
      expect(rec(d)).toBe("BUY_IOC_10000");
    }
  });

  it("D-5 2025-12-02 ilk fırtına TL_GUCLENDI → önerilen BUY post_only", () => {
    const w = series["2025-12-02"].find((x) => x.episode !== null && x.episode.startTs === x.ts && x.class === "TL_GUCLENDI");
    expect(w).toBeDefined();
    expect(rec(run(live(w!, { startDay: 1, deadlineDay: 10 })))).toBe("BUY_POST_10000");
  });

  it("D-9 2026-02-01 11:00 UTC (pazar) PRIM_SISMESI → önerilen ASK; askMode kapalı → yarısı", () => {
    const w = at("2026-02-01", utcMs(2026, 2, 1, 11, 0));
    expect(w.class).toBe("PRIM_SISMESI");
    expect(rec(run(live(w, { startDay: 1, deadlineDay: 5 })))).toBe("ASK");
    expect(ids(run(live(w, { startDay: 1, deadlineDay: 5, askMode: 0 })))).toEqual(["BUY_POST_5000"]);
  });

  it("D-6 2025-10-10 16:05 BELIRSIZ → ASK; 21:00 KRIPTO'ya yükselince soru yok sayılır → bekle", () => {
    const w1 = at("2025-10-10", utcMs(2025, 10, 10, 16, 5));
    expect(w1.class).toBe("BELIRSIZ");
    expect(rec(run(live(w1, { startDay: 1, deadlineDay: 15 })))).toBe("ASK");
    const w2 = at("2025-10-10", utcMs(2025, 10, 10, 21, 0));
    expect(w2.class).toBe("KRIPTO_SISMESI");
    const question: PendingQuestion = { status: "PENDING", episodeStartTs: w1.episode!.startTs, askedAtSec: w1.ts / 1000 + 5 };
    expect(w2.episode!.startTs).toBe(w1.episode!.startTs); // aynı bölüm (yükselme)
    const d = run(live(w2, { startDay: 1, deadlineDay: 15 }, { question }));
    expect(rec(d)).toBe("WAIT_60");
  });
});
