/**
 * Onay penceresi — saldırgan testler (adversarial).
 *
 * Kâhinler bu dosyada bağımsız yazılır: Solidity'deki FlightPlan._validate ve _isTighterOrEqual satır satır taşındı
 * (contracts/src/FlightPlan.sol), Türkçe gösterimler bağımsız bir ayrıştırıcıyla geri çözülür. Amaç:
 *  - pencere bir değer gösterip setPlanArgs başka bir değer taşıyamaz,
 *  - geçersiz/biçim karışık düzeltme (Türkçe "20.000" ↔ İngilizce "20,000", ondalık, eksi, dev sayı, 29–31. gün,
 *    son gün < başlangıç, tek emir > aylık) imzayı kapatır,
 *  - agent / kule / agentId / bantlar kilitli,
 *  - §8.2 24 saat tahmini kontratın kararıyla birebir aynı.
 */
import { describe, expect, it } from "vitest";
import { encodeFunctionData, getAddress, parseAbi, zeroAddress } from "viem";
import {
  EDITABLE_PLAN_FIELDS,
  PLAN_FIELDS,
  applyEdit,
  buildPlanConfirmation,
  type EditablePlanField,
  type PlanConfirmation,
  type PlanConfirmationContext,
} from "../plan/index.js";
import type { ChainPlan, Plan, PlanDraft } from "../schemas/plan.js";
import { trDateToSec } from "../units.js";

const DAY = 86_400;
const HOUR = 3_600;
const NOW = trDateToSec(2026, 10, 17, 12, 0);
const AGENT = "0x4444444444444444444444444444444444444444";
const KULE = "0x3333333333333333333333333333333333333333";
const OTHER = "0x5555555555555555555555555555555555555555";
const DEP = { pilotAgent: AGENT, kuleReporter: KULE, agentId: "17" } as const;

const SET_PLAN_ABI = parseAbi([
  "function setPlan((uint64 cycleTL, uint64 maxOrderTL, uint8 startDay, uint8 deadlineDay, uint16 maxWaitH, uint16 bandBps, uint16 closedBandBps, uint8 askMode, uint64 expiresAt, address agent, address kule, uint256 agentId) p)",
]);

const elifDraft = (): PlanDraft => ({
  cycleTL: { value: 20000, source: "user" },
  startDay: { value: 1, source: "user" },
  deadlineDay: { value: 5, source: "user" },
  maxOrderTL: { value: 10000, source: "user" },
  askOnAmbiguity: { value: true, source: "user" },
  maxWaitH: { value: 72, source: "default" },
  expiresInDays: { value: 90, source: "default" },
  questions: [],
});

const ctx = (over: Partial<PlanConfirmationContext> = {}): PlanConfirmationContext => ({
  nowSec: NOW,
  deployments: DEP,
  current: null,
  currentActive: true,
  ...over,
});

const currentPlan = (over: Partial<Plan> = {}): Plan => ({
  cycleTL: 20000,
  maxOrderTL: 10000,
  startDay: 1,
  deadlineDay: 5,
  maxWaitH: 72,
  bandBps: 0,
  closedBandBps: 500,
  askMode: 1,
  expiresAt: NOW + 100 * DAY,
  agent: AGENT,
  kule: KULE,
  agentId: "17",
  ...over,
});

const row = (c: PlanConfirmation, field: string) => {
  const r = c.rows.find((x) => x.field === field);
  if (!r) throw new Error(`satır yok: ${field}`);
  return r;
};

// ───────────────────────── Bağımsız kâhinler (Solidity'den taşındı) ─────────────────────────

const MAX_DAY = 28;

/** FlightPlan._validate; true = InvalidPlan ile revert. */
function solValidateReverts(p: ChainPlan, blockTimestamp: number): boolean {
  return (
    p.cycleTL === 0n ||
    p.maxOrderTL === 0n ||
    p.maxOrderTL > p.cycleTL ||
    p.startDay === 0 ||
    p.startDay > p.deadlineDay ||
    p.deadlineDay > MAX_DAY ||
    p.askMode > 1 ||
    p.expiresAt <= BigInt(blockTimestamp) ||
    p.agent.toLowerCase() === zeroAddress ||
    p.kule.toLowerCase() === zeroAddress
  );
}

function solBandTighterOrEqual(oldBps: number, newBps: number): boolean {
  if (oldBps === 0) return true;
  return newBps !== 0 && newBps <= oldBps;
}

/** FlightPlan._isTighterOrEqual(o, n) — Solidity ifadesinin harfiyen kopyası. */
function solIsTighterOrEqual(o: Plan, n: ChainPlan): boolean {
  return (
    n.cycleTL <= BigInt(o.cycleTL) &&
    n.maxOrderTL <= BigInt(o.maxOrderTL) &&
    n.maxWaitH <= o.maxWaitH &&
    n.expiresAt <= BigInt(o.expiresAt) &&
    n.startDay >= o.startDay &&
    n.askMode >= o.askMode &&
    solBandTighterOrEqual(o.bandBps, n.bandBps) &&
    solBandTighterOrEqual(o.closedBandBps, n.closedBandBps) &&
    n.deadlineDay === o.deadlineDay &&
    n.agent.toLowerCase() === o.agent.toLowerCase() &&
    n.kule.toLowerCase() === o.kule.toLowerCase() &&
    n.agentId === BigInt(o.agentId)
  );
}

/** FlightPlan.setPlan: `cur.agent == address(0) || _isTighterOrEqual(cur, p)` → hemen etkin. */
function solImmediate(cur: Plan | null, n: ChainPlan): boolean {
  if (cur === null || cur.agent.toLowerCase() === zeroAddress) return true;
  return solIsTighterOrEqual(cur, n);
}

// ───────────────────────── Türkçe gösterimi geri çöz (bağımsız) ─────────────────────────

/** "20.000" → 20000; gruplama biçimi bozuksa fırlatır. */
function parseTrInt(s: string): number {
  if (!/^\d{1,3}(\.\d{3})*$/.test(s)) throw new Error(`Türkçe tamsayı biçimi değil: ${s}`);
  return Number(s.replace(/\./g, ""));
}

/** "%2,5" → 250, "Kapalı" → 0. */
function parseBps(s: string): number {
  if (s === "Kapalı") return 0;
  const m = /^%(\d+)(?:,(\d{1,2}))?$/.exec(s);
  if (!m) throw new Error(`bant biçimi değil: ${s}`);
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

/** "dd.mm.yyyy hh:mm (TR saati)" → unix saniye (dakika başı), sabit UTC+3. */
function parseTrDateTime(s: string): number {
  const m = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2}) \(TR saati\)(?: · (\d+) gün)?$/.exec(s);
  if (!m) throw new Error(`tarih biçimi değil: ${s}`);
  const [, d, mo, y, h, mi] = m.map(Number) as number[];
  return Date.UTC(y!, mo! - 1, d!, h!, mi!) / 1000 - 3 * HOUR;
}

/** Satırın gösterdiği değeri zincir değerine çevirir (pencerede Elif'in gördüğü). */
function shownValue(field: string, display: string): string {
  let m: RegExpExecArray | null;
  switch (field) {
    case "cycleTL":
    case "maxOrderTL":
      m = /^(\S+) TL$/.exec(display);
      if (!m) throw new Error(display);
      return String(parseTrInt(m[1]!));
    case "startDay":
      m = /^Ayın (\d+)\. günü$/.exec(display);
      if (!m) throw new Error(display);
      return m[1]!;
    case "deadlineDay":
      m = /^Ayın (\d+)\. günü sonuna kadar$/.exec(display);
      if (!m) throw new Error(display);
      return m[1]!;
    case "maxWaitH":
      m = /^(\S+) saat$/.exec(display);
      if (!m) throw new Error(display);
      return String(parseTrInt(m[1]!));
    case "bandBps":
    case "closedBandBps":
      return String(parseBps(display));
    case "askMode":
      if (display.startsWith("Evet")) return "1";
      if (display.startsWith("Hayır")) return "0";
      throw new Error(display);
    case "expiresAt":
      return String(parseTrDateTime(display)); // dakikaya kesilmiş
    case "agent":
    case "kule":
      return display;
    case "agentId":
      m = /^#(\d+)$/.exec(display);
      if (!m) throw new Error(display);
      return m[1]!;
    default:
      throw new Error(field);
  }
}

/** Pencere ↔ imza tutarlılığı: her satır setPlanArgs'taki değeri gösterir. */
function assertPopupMatchesArgs(c: PlanConfirmation): void {
  expect(c.signable).toBe(true);
  expect(c.setPlanArgs).not.toBeNull();
  const chain = c.setPlanArgs![0];
  expect(c.rows.map((r) => r.field)).toEqual([...PLAN_FIELDS]);
  for (const r of c.rows) {
    const onChain = String(chain[r.field]);
    expect(r.chainValue, r.field).toBe(onChain);
    const shown = shownValue(r.field, r.displayTr);
    if (r.field === "expiresAt") {
      // Gösterim dakikaya kesilir: zincir değeri o dakikanın içinde olmalı.
      const sec = Number(chain.expiresAt);
      expect(sec - Number(shown), r.displayTr).toBeGreaterThanOrEqual(0);
      expect(sec - Number(shown), r.displayTr).toBeLessThan(60);
    } else {
      expect(shown, `${r.field}: "${r.displayTr}"`).toBe(onChain);
    }
  }
  expect(chain.agent).toBe(getAddress(chain.agent));
  expect(chain.kule).toBe(getAddress(chain.kule));
  expect(() => encodeFunctionData({ abi: SET_PLAN_ABI, functionName: "setPlan", args: [chain] })).not.toThrow();
  expect(solValidateReverts(chain, NOW)).toBe(false);
}

// ───────────────────────── Tohumlu rastgele üreteç ─────────────────────────

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("Onay penceresi — saldırgan testler", () => {
  it("L-1 pencere ile setPlanArgs ayrışamaz: rastgele düzeltme dizilerinde her satır imzalanacak değeri gösterir", () => {
    const rnd = mulberry32(0xc0ffee);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const NUM_VALUES: Record<Exclude<EditablePlanField, "askMode">, readonly unknown[]> = {
      cycleTL: [1, 150, 300, 999, 1000, 20000, "20000", " 25000 ", 123456789, Number.MAX_SAFE_INTEGER, "999999999999999"],
      maxOrderTL: [1, 150, 999, 1000, 10000, "10000", 15000, 20000],
      startDay: [1, 2, 5, 15, 28, "3"],
      deadlineDay: [1, 5, 10, 25, 28, "28"],
      maxWaitH: [0, 1, 24, 72, 999, 1000, 65535, "1234"],
      expiresAt: [1, 2, 30, 90, 100, 120, 365],
    };
    const currents: (Plan | null)[] = [
      null,
      currentPlan({ agent: zeroAddress }),
      currentPlan(),
      currentPlan({ bandBps: 300 }),
      currentPlan({ closedBandBps: 0 }),
      currentPlan({ closedBandBps: 300 }),
      currentPlan({ askMode: 0 }),
      currentPlan({ expiresAt: NOW - DAY }),
      currentPlan({ expiresAt: NOW + 10 * DAY }),
      currentPlan({ expiresAt: NOW + 400 * DAY }),
      currentPlan({ agent: OTHER }),
      currentPlan({ kule: OTHER }),
      currentPlan({ agentId: "18" }),
      currentPlan({ cycleTL: 1_000_000, maxOrderTL: 1_000_000, maxWaitH: 65535, startDay: 1, deadlineDay: 28 }),
      currentPlan({ cycleTL: 300, maxOrderTL: 150, startDay: 15, deadlineDay: 25, maxWaitH: 1 }),
    ];

    let signed = 0;
    let waited = 0;
    for (let i = 0; i < 1500; i++) {
      const cur = pick(currents);
      let c = buildPlanConfirmation(elifDraft(), ctx({ current: cur }));
      const steps = 1 + Math.floor(rnd() * 5);
      for (let k = 0; k < steps; k++) {
        const f = pick(EDITABLE_PLAN_FIELDS);
        c = applyEdit(c, f, f === "askMode" ? rnd() < 0.5 : pick(NUM_VALUES[f]));
      }
      if (!c.signable) {
        expect(c.setPlanArgs).toBeNull();
        expect(c.blockers.length).toBeGreaterThan(0);
        continue;
      }
      signed++;
      assertPopupMatchesArgs(c);
      const chain = c.setPlanArgs![0];
      const imm = solImmediate(cur, chain);
      expect(c.activation!.immediate, JSON.stringify({ cur, chain: String(chain.cycleTL) })).toBe(imm);
      expect(c.activation!.activeAtSec).toBe(imm ? NOW : NOW + 24 * HOUR);
      expect(c.activation!.loosened.length === 0).toBe(imm);
      if (!imm) waited++;
    }
    // Üreteç gerçekten iki yolu da denedi.
    expect(signed).toBeGreaterThan(300);
    expect(waited).toBeGreaterThan(100);
  });

  it("F-2 / F-3 / F-4 24 saat tahmini her alan için kontratın _isTighterOrEqual kararıyla aynı", () => {
    // Taslağı sabit tut; mevcut planı tek tek alanlarda sınırın iki yanına oynat.
    const base = buildPlanConfirmation(elifDraft(), ctx({ current: currentPlan() }));
    const n = base.setPlanArgs![0];
    const variants: Partial<Plan>[] = [
      {},
      { cycleTL: 19999 },
      { cycleTL: 20001 },
      { maxOrderTL: 9999 },
      { maxOrderTL: 10001 },
      { maxWaitH: 71 },
      { maxWaitH: 73 },
      { startDay: 2, deadlineDay: 5 },
      { startDay: 1, deadlineDay: 6 },
      { deadlineDay: 4 },
      { askMode: 0 },
      { bandBps: 1 },
      { bandBps: 0 },
      { closedBandBps: 499 },
      { closedBandBps: 501 },
      { closedBandBps: 0 },
      { expiresAt: Number(n.expiresAt) - 1 },
      { expiresAt: Number(n.expiresAt) },
      { expiresAt: Number(n.expiresAt) + 1 },
      { agent: OTHER },
      { kule: OTHER },
      { agentId: "170" },
    ];
    for (const v of variants) {
      const cur = currentPlan(v);
      const c = buildPlanConfirmation(elifDraft(), ctx({ current: cur }));
      expect(c.signable, JSON.stringify(v)).toBe(true);
      expect(c.activation!.immediate, JSON.stringify(v)).toBe(solImmediate(cur, c.setPlanArgs![0]));
    }
  });

  it("F-1 (önkontrol) Türkçe/İngilizce sayı biçimi karışıklığı sessizce dönüştürülmez", () => {
    const base = buildPlanConfirmation(elifDraft(), ctx());
    // Number("20.000") = 20, parseInt("20,000") = 20, Number("0x10") = 16, Number("1e3") = 1000: hiçbiri kabul edilmez.
    const bad = ["20.000", "20,000", "20.000,00", "1,5", "1.5", "5.0", "-5", "+5", "0x10", "1e3", "Infinity", "NaN",
      "", "   ", "20 000", "٢٠٠٠٠", "２００００", "20000TL", "₺20000", "1000000000000000"];
    for (const v of bad) {
      const c = applyEdit(base, "cycleTL", v);
      expect(c.signable, JSON.stringify(v)).toBe(false);
      expect(c.setPlanArgs, JSON.stringify(v)).toBeNull();
      expect(row(c, "cycleTL").error, JSON.stringify(v)).not.toBeNull();
      expect(row(c, "cycleTL").chainValue).toBeNull();
      expect(row(c, "cycleTL").displayTr).toBe("—");
    }
    // Rakamdan ibaret girdiler aynen alınır; pencere Türkçe gruplu gösterir.
    const ok = applyEdit(base, "cycleTL", "25000");
    expect(ok.setPlanArgs![0].cycleTL).toBe(25000n);
    expect(row(ok, "cycleTL").displayTr).toBe("25.000 TL");
  });

  it("F-1 (önkontrol) sayı tipindeki geçersiz düzeltmeler (ondalık, eksi, dev, NaN, bigint) imzayı kapatır", () => {
    const base = buildPlanConfirmation(elifDraft(), ctx());
    const cases: [EditablePlanField, unknown][] = [
      ["cycleTL", 1.5],
      ["cycleTL", -20000],
      ["cycleTL", 0],
      ["cycleTL", -0.0001],
      ["cycleTL", Number.NaN],
      ["cycleTL", Number.POSITIVE_INFINITY],
      ["cycleTL", 2 ** 53],
      ["cycleTL", 1e300],
      ["cycleTL", 20000n],
      ["cycleTL", null],
      ["cycleTL", undefined],
      ["cycleTL", true],
      ["cycleTL", { valueOf: () => 20000 }],
      ["cycleTL", [20000]],
      ["maxOrderTL", 0],
      ["maxOrderTL", 20001], // > cycleTL
      ["maxOrderTL", 9999.99],
      ["maxWaitH", 65536],
      ["maxWaitH", -1],
      ["maxWaitH", 2.5],
      ["expiresAt", 0],
      ["expiresAt", 366],
      ["expiresAt", 0.5],
      ["expiresAt", NOW + 90 * DAY], // unix saniye gün yerine verilirse
      ["askMode", 1],
      ["askMode", "true"],
      ["askMode", null],
    ];
    for (const [f, v] of cases) {
      const c = applyEdit(base, f, v);
      expect(c.signable, `${f}=${String(v)}`).toBe(false);
      expect(c.setPlanArgs, `${f}=${String(v)}`).toBeNull();
    }
  });

  it("F-1 (önkontrol) gün kuralları: 29–31 ve 0 reddedilir, son gün < başlangıç reddedilir, sınırlar kabul edilir", () => {
    const base = buildPlanConfirmation(elifDraft(), ctx());
    for (const d of [0, 29, 30, 31, 32, 255, 256]) {
      expect(applyEdit(base, "deadlineDay", d).signable, `deadlineDay=${d}`).toBe(false);
      expect(applyEdit(base, "startDay", d).signable, `startDay=${d}`).toBe(false);
    }
    // start = 10, deadline = 5 (taslaktaki) → son gün < başlangıç.
    const inverted = applyEdit(base, "startDay", 10);
    expect(inverted.signable).toBe(false);
    expect(row(inverted, "deadlineDay").error).not.toBeNull();
    // Önce son günü ileri, sonra başlangıcı ileri al: geçerli. Ara durumun ters sırası da geçerli olmalı.
    const fixed = applyEdit(inverted, "deadlineDay", 28);
    assertPopupMatchesArgs(fixed);
    expect(fixed.setPlanArgs![0].startDay).toBe(10);
    expect(fixed.setPlanArgs![0].deadlineDay).toBe(28);
    // start == deadline sınırı kontratta geçerli (startDay > deadlineDay revert eder, eşitlik etmez).
    const same = applyEdit(applyEdit(base, "startDay", 28), "deadlineDay", 28);
    assertPopupMatchesArgs(same);
  });

  it("F-1 (önkontrol) maxOrderTL > cycleTL her iki düzenleme sırasında da kapanır; eşitlik kabul edilir", () => {
    const base = buildPlanConfirmation(elifDraft(), ctx());
    expect(applyEdit(base, "cycleTL", 9999).signable).toBe(false); // maxOrderTL 10000 > 9999
    expect(applyEdit(base, "maxOrderTL", 20001).signable).toBe(false);
    const eq = applyEdit(base, "maxOrderTL", 20000);
    assertPopupMatchesArgs(eq);
    // Dev ama güvenli değerler: pencere gösterimi ile uint64 argüman aynı.
    const huge = applyEdit(applyEdit(base, "cycleTL", Number.MAX_SAFE_INTEGER), "maxOrderTL", Number.MAX_SAFE_INTEGER);
    assertPopupMatchesArgs(huge);
    expect(huge.setPlanArgs![0].cycleTL).toBe(BigInt(Number.MAX_SAFE_INTEGER));
    expect(row(huge, "cycleTL").displayTr).toBe("9.007.199.254.740.991 TL");
  });

  it("F-4 agent, kule, agentId ve bantlar kilitli: applyEdit fırlatır, satırlar düzenlenemez, değer dağıtımdan gelir", () => {
    const base = buildPlanConfirmation(elifDraft(), ctx());
    const locked = ["agent", "kule", "agentId", "bandBps", "closedBandBps", "__proto__", "constructor", "toString",
      "expiresInDays", "askOnAmbiguity", "questions"];
    for (const f of locked) {
      expect(() => applyEdit(base, f as EditablePlanField, OTHER), f).toThrow(TypeError);
      expect(() => applyEdit(base, f as EditablePlanField, 0), f).toThrow(TypeError);
    }
    for (const f of ["agent", "kule", "agentId", "bandBps", "closedBandBps"]) {
      expect(row(base, f).editable, f).toBe(false);
      expect(row(base, f).badgeTr, f).toBe("otomatik");
    }
    const chain = base.setPlanArgs![0];
    expect(chain.agent).toBe(getAddress(AGENT));
    expect(chain.kule).toBe(getAddress(KULE));
    expect(chain.agentId).toBe(17n);
    expect(chain.bandBps).toBe(0);
    expect(chain.closedBandBps).toBe(500);
  });

  it("F-4 setPlanArgs dondurulmuş: imza öncesi değer değiştirilemez; state oynamak eski argümanı değiştirmez", () => {
    const base = buildPlanConfirmation(elifDraft(), ctx());
    const args = base.setPlanArgs!;
    expect(Object.isFrozen(args)).toBe(true);
    expect(Object.isFrozen(args[0])).toBe(true);
    expect(() => {
      (args[0] as { agent: string }).agent = OTHER;
    }).toThrow(TypeError);
    expect(() => {
      (args[0] as { cycleTL: bigint }).cycleTL = 1n;
    }).toThrow(TypeError);
    // Düzeltme yeni nesne üretir; eski onay nesnesinin argümanı aynı kalır.
    const edited = applyEdit(base, "cycleTL", 15000);
    expect(args[0].cycleTL).toBe(20000n);
    expect(edited.setPlanArgs![0].cycleTL).toBe(15000n);
  });

  it("F-4 dağıtım adresi bozuk/sıfır/aynı değilse ya da LLM taslağı adres taşımaya çalışırsa imza kapalı", () => {
    for (const deployments of [
      null,
      { ...DEP, pilotAgent: zeroAddress },
      { ...DEP, kuleReporter: zeroAddress },
      { ...DEP, pilotAgent: "0x123" },
      { ...DEP, pilotAgent: "0x4444444444444444444444444444444444444444 " },
      { ...DEP, agentId: undefined },
      { ...DEP, agentId: "0" },
    ] as PlanConfirmationContext["deployments"][]) {
      const c = buildPlanConfirmation(elifDraft(), ctx({ deployments }));
      expect(c.signable, JSON.stringify(deployments)).toBe(false);
      expect(c.setPlanArgs).toBeNull();
    }
    // Taslağa fazladan alan (agent) eklemek PlanDraftSchema (strict) ile reddedilir.
    const sneaky = { ...elifDraft(), agent: { value: OTHER, source: "user" } } as unknown as PlanDraft;
    expect(() => buildPlanConfirmation(sneaky, ctx())).toThrow();
  });

  it("F-3 süresi dolmuş plan yerine her plan 24 saat bekler (kontrat süresi dolanı da taban sayar)", () => {
    const cur = currentPlan({ expiresAt: NOW - 1 });
    const c = buildPlanConfirmation(elifDraft(), ctx({ current: cur }));
    expect(c.activation!.immediate).toBe(false);
    expect(solImmediate(cur, c.setPlanArgs![0])).toBe(false);
    expect(c.activation!.loosened).toContain("expiresAt");
  });

  it("F-2 mevcut plan bantlı (bandBps>0) iken yeni plan bandı 0 yapar: kontrat gevşek sayar, tahmin de bekler", () => {
    const cur = currentPlan({ bandBps: 300 });
    const c = buildPlanConfirmation(elifDraft(), ctx({ current: cur }));
    expect(c.setPlanArgs![0].bandBps).toBe(0);
    expect(c.activation!.immediate).toBe(false);
    expect(c.activation!.loosened).toEqual(["bandBps"]);
    expect(row(c, "bandBps").displayTr).toBe("Kapalı");
    expect(row(c, "bandBps").note).not.toBeNull();
  });

  it("F-2 mevcut planın kapalı piyasa bandı 0 iken yeni 500: sıkılaşma, anında", () => {
    const cur = currentPlan({ closedBandBps: 0 });
    const c = buildPlanConfirmation(elifDraft(), ctx({ current: cur }));
    expect(solImmediate(cur, c.setPlanArgs![0])).toBe(true);
    expect(c.activation!.immediate).toBe(true);
  });

  it("F-4 mevcut plandaki adres küçük harf / checksum'lı yazılsa da aynı adres sayılır", () => {
    const cur = currentPlan({ agent: AGENT.toLowerCase() as Plan["agent"], kule: getAddress(KULE) });
    const c = buildPlanConfirmation(elifDraft(), ctx({ current: cur }));
    expect(c.activation!.immediate).toBe(true);
  });

  it("F-2 bitiş sınırlandığında pencere sınırlanmış tarihi gösterir, istenen gün sayısını göstermez", () => {
    const cur = currentPlan({ expiresAt: NOW + 10 * DAY });
    const c = buildPlanConfirmation(elifDraft(), ctx({ current: cur }));
    assertPopupMatchesArgs(c);
    expect(c.setPlanArgs![0].expiresAt).toBe(BigInt(NOW + 10 * DAY));
    expect(row(c, "expiresAt").displayTr).not.toMatch(/90 gün/);
    expect(row(c, "expiresAt").note).not.toBeNull();
    expect(c.activation!.immediate).toBe(true);
  });

  it("F-3 Elif'in bitiş düzeltmesi sessizce yok sayılmaz: uzatma ya 24 saat bekler ya da hata verir", () => {
    // Mevcut plan 10 gün sonra bitiyor. Elif pencerede süreyi 365 güne çıkarır. §8.2'ye göre bu gevşemedir ve
    // 24 saat beklemelidir (F-3); alternatif olarak düzeltme hatayla imzaya kapatılabilir. Yanlış olan: satır
    // "senin düzeltmen" rozeti taşırken setPlanArgs'ın düzeltmeden önceki değeri imzalatması.
    // BULGU: compute() bitişi mevcut planın bitişine kırpar; 365 gün düzeltmesi argümanı hiç değiştirmez.
    const cur = currentPlan({ expiresAt: NOW + 10 * DAY });
    const before = buildPlanConfirmation(elifDraft(), ctx({ current: cur }));
    const after = applyEdit(before, "expiresAt", 365);
    expect(row(after, "expiresAt").source).toBe("edited");
    const silentNoOp =
      after.signable && after.setPlanArgs![0].expiresAt === before.setPlanArgs![0].expiresAt;
    expect(silentNoOp).toBe(false);
  });

  it("L-1 TR saati sabit UTC+3: bitiş gösterimi gün dönümünde (UTC 21:00) doğru günü verir", () => {
    // nowSec = 17.10.2026 21:00 UTC = 18.10.2026 00:00 TR; 1 gün sonra 19.10.2026 00:00 TR.
    const now = Date.UTC(2026, 9, 17, 21, 0) / 1000;
    const c = applyEdit(buildPlanConfirmation(elifDraft(), ctx({ nowSec: now })), "expiresAt", 1);
    expect(row(c, "expiresAt").displayTr).toBe("19.10.2026 00:00 (TR saati) · 1 gün");
    expect(c.setPlanArgs![0].expiresAt).toBe(BigInt(now + DAY));
  });
});
