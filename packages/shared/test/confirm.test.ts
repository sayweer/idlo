import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encodeFunctionData, getAddress, parseAbi } from "viem";
import * as shared from "../index.js";
import {
  CONFIRM_TITLE_TR,
  EDITABLE_PLAN_FIELDS,
  PLAN_FIELDS,
  applyEdit,
  buildPlanConfirmation,
  type PlanConfirmation,
  type PlanConfirmationContext,
} from "../plan/index.js";
import { PlanSchema, type Plan, type PlanDraft } from "../schemas/plan.js";
import { trDateToSec } from "../units.js";

// Testlerde süre aritmetiği bilerek elle yazılır (bağımsız kâhin).
const DAY = 86_400;
const NOW = trDateToSec(2026, 10, 17, 12, 0); // 17.10.2026 12:00 TR
const AGENT = "0x4444444444444444444444444444444444444444";
const KULE = "0x3333333333333333333333333333333333333333";
const OTHER = "0x5555555555555555555555555555555555555555";
const DEP = { pilotAgent: AGENT, kuleReporter: KULE, agentId: "17" } as const;

/** IFlightPlan.setPlan, contracts/src/interfaces/IFlightPlan.sol'daki struct ile aynı sıra ve tipler. */
const SET_PLAN_ABI = parseAbi([
  "function setPlan((uint64 cycleTL, uint64 maxOrderTL, uint8 startDay, uint8 deadlineDay, uint16 maxWaitH, uint16 bandBps, uint16 closedBandBps, uint8 askMode, uint64 expiresAt, address agent, address kule, uint256 agentId) p)",
]);

/** §15 / L-1: Elif'in §1 cümlesinin taslağı. */
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

/** §19 demo planı: 300 / 150 / 15 / 25. */
const demoDraft = (): PlanDraft => ({
  ...elifDraft(),
  cycleTL: { value: 300, source: "user" },
  maxOrderTL: { value: 150, source: "user" },
  startDay: { value: 15, source: "user" },
  deadlineDay: { value: 25, source: "user" },
});

const ctx = (over: Partial<PlanConfirmationContext> = {}): PlanConfirmationContext => ({
  nowSec: NOW,
  deployments: DEP,
  current: null,
  currentActive: true,
  ...over,
});

/** Zincirdeki mevcut plan (Elif'in planı, 100 gün sonra biter). */
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

function expectSingleSource(c: PlanConfirmation) {
  const args = c.setPlanArgs;
  expect(args).not.toBeNull();
  for (const r of c.rows) expect(r.chainValue).toBe(String(args![0][r.field]));
  // Tipler setPlan ABI'sine birebir uyar (uint64/uint256 bigint, uint8/16 number).
  expect(() => encodeFunctionData({ abi: SET_PLAN_ABI, functionName: "setPlan", args: args! })).not.toThrow();
}

describe("Onay penceresi: Zincire yazılacak değerler", () => {
  it("L-1 Elif'in §1 cümlesinin taslağı: setPlanArgs tam ve satırlar aynı nesneden", () => {
    const c = buildPlanConfirmation(elifDraft(), ctx());
    expect(c.titleTr).toBe(CONFIRM_TITLE_TR);
    expect(c.signable).toBe(true);
    expect(c.blockers).toEqual([]);
    expect(c.setPlanArgs).toEqual([
      {
        cycleTL: 20000n,
        maxOrderTL: 10000n,
        startDay: 1,
        deadlineDay: 5,
        maxWaitH: 72,
        bandBps: 0,
        closedBandBps: 500,
        askMode: 1,
        expiresAt: BigInt(NOW + 90 * DAY),
        agent: getAddress(AGENT),
        kule: getAddress(KULE),
        agentId: 17n,
      },
    ]);
    expectSingleSource(c);
    expect(Object.isFrozen(c.setPlanArgs)).toBe(true);
    expect(Object.isFrozen(c.setPlanArgs![0])).toBe(true);

    expect(c.rows.map((r) => r.field)).toEqual(Object.keys(PlanSchema.shape));
    expect(c.rows.map((r) => [r.field, r.displayTr])).toEqual([
      ["cycleTL", "20.000 TL"],
      ["maxOrderTL", "10.000 TL"],
      ["startDay", "Ayın 1. günü"],
      ["deadlineDay", "Ayın 5. günü sonuna kadar"],
      ["maxWaitH", "72 saat"],
      ["bandBps", "Kapalı"],
      ["closedBandBps", "%5"],
      ["askMode", "Evet, emin olmazsa sana sorar"],
      ["expiresAt", "15.01.2027 12:00 (TR saati) · 90 gün"],
      ["agent", getAddress(AGENT)],
      ["kule", getAddress(KULE)],
      ["agentId", "#17"],
    ]);
    expect(c.rows.map((r) => [r.field, r.source, r.badgeTr, r.editable])).toEqual([
      ["cycleTL", "user", "senin cümlenden", true],
      ["maxOrderTL", "user", "senin cümlenden", true],
      ["startDay", "user", "senin cümlenden", true],
      ["deadlineDay", "user", "senin cümlenden", true],
      ["maxWaitH", "default", "varsayılan", true],
      ["bandBps", "default", "otomatik", false],
      ["closedBandBps", "default", "otomatik", false],
      ["askMode", "user", "senin cümlenden", true],
      ["expiresAt", "default", "varsayılan", true],
      ["agent", "default", "otomatik", false],
      ["kule", "default", "otomatik", false],
      ["agentId", "default", "otomatik", false],
    ]);
    expect(c.rows.every((r) => r.error === null)).toBe(true);
  });

  it("F-1 §19 demo planı (300/150/15/25) ilk plan olarak anında geçerli", () => {
    const c = buildPlanConfirmation(demoDraft(), ctx());
    expect(c.signable).toBe(true);
    const a = c.setPlanArgs![0];
    expect([a.cycleTL, a.maxOrderTL, a.startDay, a.deadlineDay]).toEqual([300n, 150n, 15, 25]);
    expect([row(c, "cycleTL").displayTr, row(c, "maxOrderTL").displayTr]).toEqual(["300 TL", "150 TL"]);
    expect(row(c, "startDay").displayTr).toBe("Ayın 15. günü");
    expect(row(c, "deadlineDay").displayTr).toBe("Ayın 25. günü sonuna kadar");
    expectSingleSource(c);
    expect(c.activation).toEqual({
      immediate: true,
      activeAtSec: NOW,
      loosened: [],
      textTr: "Zincirde planın yok; imzalarsan plan anında geçerli olur.",
    });
    // agent == 0x0 olan kayıt da "plan yok" sayılır.
    const zero = currentPlan({ agent: "0x0000000000000000000000000000000000000000" });
    expect(buildPlanConfirmation(demoDraft(), ctx({ current: zero })).activation?.immediate).toBe(true);
  });

  it("L-3 düzeltilen alan 'senin düzeltmen' rozeti taşır, imza değerleri düzeltmeyle güncellenir", () => {
    const base = buildPlanConfirmation(elifDraft(), ctx());
    const c1 = applyEdit(base, "cycleTL", "25000");
    expect(row(c1, "cycleTL")).toMatchObject({ source: "edited", badgeTr: "senin düzeltmen", displayTr: "25.000 TL" });
    expect(c1.setPlanArgs![0].cycleTL).toBe(25000n);
    expect(row(c1, "maxOrderTL").source).toBe("user");
    expectSingleSource(c1);
    // Asıl pencere değişmez (saf fonksiyon).
    expect(base.setPlanArgs![0].cycleTL).toBe(20000n);
    expect(row(base, "cycleTL").source).toBe("user");

    const c2 = applyEdit(applyEdit(c1, "askMode", false), "expiresAt", 30);
    expect(c2.setPlanArgs![0].askMode).toBe(0);
    expect(row(c2, "askMode")).toMatchObject({ source: "edited", displayTr: "Hayır, sormadan karar verir" });
    expect(c2.setPlanArgs![0].expiresAt).toBe(BigInt(NOW + 30 * DAY));
    expect(row(c2, "expiresAt")).toMatchObject({ source: "edited", displayTr: "16.11.2026 12:00 (TR saati) · 30 gün" });
    const c3 = applyEdit(c2, "maxWaitH", 24);
    expect(c3.setPlanArgs![0].maxWaitH).toBe(24);
    expect(row(c3, "maxWaitH")).toMatchObject({ source: "edited", badgeTr: "senin düzeltmen" });

    // Asıl değere geri dönen düzeltme asıl kaynağını geri alır.
    expect(row(applyEdit(c1, "cycleTL", 20000), "cycleTL").source).toBe("user");
    expect(row(applyEdit(c3, "maxWaitH", 72), "maxWaitH").source).toBe("default");
  });

  it("F-1 (önkontrol) geçersiz düzeltme imzayı kapatır; FlightPlan._validate kuralları", () => {
    const base = buildPlanConfirmation(elifDraft(), ctx());
    const bad: [Parameters<typeof applyEdit>[1], unknown, string, string][] = [
      ["cycleTL", "20.000", "cycleTL", "Geçersiz değer: yalnız rakam yaz (nokta, virgül, eksi işareti yok)."],
      ["cycleTL", "1,5", "cycleTL", "Geçersiz değer: yalnız rakam yaz (nokta, virgül, eksi işareti yok)."],
      ["cycleTL", -5, "cycleTL", "Geçersiz değer: yalnız rakam yaz (nokta, virgül, eksi işareti yok)."],
      ["cycleTL", 1.5, "cycleTL", "Geçersiz değer: yalnız rakam yaz (nokta, virgül, eksi işareti yok)."],
      ["cycleTL", 0, "cycleTL", "Aylık tutar 0'dan büyük tam lira olmalı."],
      ["maxOrderTL", 0, "maxOrderTL", "Tek emir tavanı 0'dan büyük tam lira olmalı."],
      ["maxOrderTL", 20001, "maxOrderTL", "Tek emir tavanı aylık tutarı aşamaz."],
      ["startDay", 0, "startDay", "Gün 1 ile 28 arasında olmalı (her ayda olan günler)."],
      ["startDay", 6, "deadlineDay", "Son gün, pencere başından önce olamaz."],
      ["deadlineDay", 29, "deadlineDay", "Gün 1 ile 28 arasında olmalı (her ayda olan günler)."],
      ["maxWaitH", 65536, "maxWaitH", "Bekleme en fazla 65.535 saat olabilir."],
      ["expiresAt", 0, "expiresAt", "Plan 1 ile 365 gün arasında geçerli olabilir."],
      ["expiresAt", 366, "expiresAt", "Plan 1 ile 365 gün arasında geçerli olabilir."],
      ["askMode", 1, "askMode", "Geçersiz değer: evet ya da hayır seçilmeli."],
      ["askMode", "evet", "askMode", "Geçersiz değer: evet ya da hayır seçilmeli."],
    ];
    for (const [field, value, errField, msg] of bad) {
      const c = applyEdit(base, field, value);
      expect(c.signable, `${field}=${String(value)}`).toBe(false);
      expect(c.setPlanArgs).toBeNull();
      expect(c.blockers).toContainEqual({ code: "INVALID_VALUE", field: errField, messageTr: msg });
      expect(row(c, errField).error).toBe(msg);
      expect(row(c, field).source).toBe("edited");
    }
    // Çözümlenemeyen değer satırda boş görünür, zincir değeri yoktur.
    const unparsable = applyEdit(base, "cycleTL", "20.000");
    expect(row(unparsable, "cycleTL")).toMatchObject({ displayTr: "—", chainValue: null });
    // Düzeltme geri alınınca imza açılır.
    expect(applyEdit(unparsable, "cycleTL", "20000").signable).toBe(true);
    // Düzenlenemez alan programlama hatasıdır.
    expect(() => applyEdit(base, "agent" as never, OTHER)).toThrow(TypeError);
  });

  it("L-2 / §16 #8 belirsiz cümle: sorular açıkken imza kapalı; elle doldurmak soruyu kapatmaz", () => {
    const vague: PlanDraft = {
      ...elifDraft(),
      cycleTL: { value: null, source: "default" },
      questions: ["Ayda kaç TL çevirmek istiyorsun?"],
    };
    const c = buildPlanConfirmation(vague, ctx());
    expect(c.signable).toBe(false);
    expect(c.setPlanArgs).toBeNull();
    expect(c.activation).toBeNull();
    expect(c.questions).toEqual(["Ayda kaç TL çevirmek istiyorsun?"]);
    expect(c.blockers.map((b) => b.code)).toEqual(["QUESTIONS_OPEN", "MISSING_VALUE"]);
    expect(row(c, "cycleTL")).toMatchObject({ displayTr: "—", chainValue: null, error: "Bu alan boş; PİLOT'un sorusunu cevapla." });
    const filled = applyEdit(c, "cycleTL", 20000);
    expect(filled.signable).toBe(false);
    expect(filled.blockers.map((b) => b.code)).toEqual(["QUESTIONS_OPEN"]);
    expect(filled.activation?.immediate).toBe(true); // tahmin yine gösterilir
  });

  it("F-4 (önkoşul) dağıtım ya da agentId yoksa imza kapalı; agentId=0 ile imzalatılmaz", () => {
    const noDep = buildPlanConfirmation(elifDraft(), ctx({ deployments: null }));
    expect(noDep.signable).toBe(false);
    expect(noDep.blockers.map((b) => [b.code, b.field])).toEqual([
      ["NO_DEPLOYMENT", "agent"],
      ["NO_DEPLOYMENT", "kule"],
      ["NO_AGENT_ID", "agentId"],
    ]);
    expect(row(noDep, "agent")).toMatchObject({ displayTr: "—", chainValue: null });
    for (const agentId of [undefined, "0"]) {
      const c = buildPlanConfirmation(elifDraft(), ctx({ deployments: { ...DEP, agentId } }));
      expect(c.signable).toBe(false);
      expect(c.blockers).toEqual([{ code: "NO_AGENT_ID", field: "agentId", messageTr: "PİLOT kaydı bekleniyor; imza kapalı." }]);
    }
    const zeroAgent = { ...DEP, pilotAgent: "0x0000000000000000000000000000000000000000" } as typeof DEP & { pilotAgent: `0x${string}` };
    expect(buildPlanConfirmation(elifDraft(), ctx({ deployments: zeroAgent })).signable).toBe(false);
  });

  it("F-2 mevcut plandan yalnız cycleTL düşürülünce tahmin = anında", () => {
    const c = applyEdit(buildPlanConfirmation(elifDraft(), ctx({ current: currentPlan() })), "cycleTL", 15000);
    expect(c.signable).toBe(true);
    expect(c.activation).toMatchObject({ immediate: true, activeAtSec: NOW, loosened: [] });
    expect(c.rows.every((r) => r.note === null || r.note === "Kod tarafından belirlenir; düzenlenemez.")).toBe(true);
  });

  it("F-3 gevşek değişiklik 24 saat bekler; gevşeyen alan satırda işaretlenir", () => {
    const c = applyEdit(buildPlanConfirmation(elifDraft(), ctx({ current: currentPlan() })), "cycleTL", 25000);
    expect(c.signable).toBe(true); // bekleyen plan da imzalanabilir; yalnız tahmin değişir
    expect(c.activation).toMatchObject({ immediate: false, activeAtSec: NOW + DAY, loosened: ["cycleTL"] });
    expect(c.activation!.textTr).toContain("18.10.2026 12:00 (TR saati)");
    expect(row(c, "cycleTL").note).toBe("Mevcut planından gevşek: bu değişiklik 24 saat bekletir.");
    // Bant: eski > 0 iken yeni 0 (kapalı) gevşemedir.
    const banded = buildPlanConfirmation(elifDraft(), ctx({ current: currentPlan({ bandBps: 300 }) }));
    expect(banded.activation?.loosened).toEqual(["bandBps"]);
    // Süresi dolmuş plan üstüne her plan 24 saat bekler (expiresAt mecburen daha geç).
    const expired = buildPlanConfirmation(elifDraft(), ctx({ current: currentPlan({ expiresAt: NOW - DAY }) }));
    expect(expired.activation).toMatchObject({ immediate: false, loosened: ["expiresAt"] });
  });

  it("F-4 deadlineDay, agent, kule ya da agentId değişikliği (azaltma dahil) her zaman 24 saat bekler", () => {
    const cur = ctx({ current: currentPlan() });
    const c = applyEdit(buildPlanConfirmation(elifDraft(), cur), "deadlineDay", 4);
    expect(c.activation).toMatchObject({ immediate: false, loosened: ["deadlineDay"] });
    expect(row(c, "deadlineDay").note).toBe("Mevcut planından farklı: bu alan değişirse plan her zaman 24 saat bekler.");
    const moved = buildPlanConfirmation(
      elifDraft(),
      ctx({ current: currentPlan(), deployments: { pilotAgent: OTHER, kuleReporter: KULE, agentId: "18" } }),
    );
    expect(moved.activation?.loosened).toEqual(["agent", "agentId"]);
  });

  it("F-2 varsayılan süre mevcut planın bitişiyle sınırlanır; rozet otomatik, plan anında geçer", () => {
    const c = buildPlanConfirmation(elifDraft(), ctx({ current: currentPlan({ expiresAt: NOW + 30 * DAY }) }));
    expect(c.setPlanArgs![0].expiresAt).toBe(BigInt(NOW + 30 * DAY));
    expect(row(c, "expiresAt")).toMatchObject({
      displayTr: "16.11.2026 12:00 (TR saati)",
      source: "default",
      badgeTr: "otomatik",
      note:
        "Varsayılan süre mevcut planının bitişiyle sınırlandı; böylece plan anında geçer. " +
        "Daha geç bitiş istersen gün sayısını düzelt; bu 24 saat bekletir.",
    });
    expect(c.activation?.immediate).toBe(true);
  });

  it("F-3 Elif'in seçtiği süre (cümle ya da düzeltme) kırpılmaz; daha geç bitiş 24 saat bekler", () => {
    const cur = ctx({ current: currentPlan({ expiresAt: NOW + 30 * DAY }) });
    const fromSentence = buildPlanConfirmation(
      { ...elifDraft(), expiresInDays: { value: 90, source: "user" } },
      cur,
    );
    const edited = applyEdit(buildPlanConfirmation(elifDraft(), cur), "expiresAt", 365);
    for (const [c, days, source, badgeTr] of [
      [fromSentence, 90, "user", "senin cümlenden"],
      [edited, 365, "edited", "senin düzeltmen"],
    ] as const) {
      expect(c.signable).toBe(true);
      expect(c.setPlanArgs![0].expiresAt).toBe(BigInt(NOW + days * DAY));
      expect(row(c, "expiresAt")).toMatchObject({
        source,
        badgeTr,
        note: "Mevcut planından gevşek: bu değişiklik 24 saat bekletir.",
      });
      expect(row(c, "expiresAt").displayTr).toContain(`· ${days} gün`);
      expect(c.activation).toMatchObject({ immediate: false, activeAtSec: NOW + DAY, loosened: ["expiresAt"] });
    }
    // Mevcut bitişten önceye çekilen süre sıkılaşmadır: anında.
    const shorter = applyEdit(buildPlanConfirmation(elifDraft(), cur), "expiresAt", 10);
    expect(shorter.setPlanArgs![0].expiresAt).toBe(BigInt(NOW + 10 * DAY));
    expect(shorter.activation?.immediate).toBe(true);
  });

  it("F-3 süresi dolmuş ya da durdurulmuş plan üstüne: metin 'mevcut planın geçerli' demez", () => {
    const expired = applyEdit(
      buildPlanConfirmation(elifDraft(), ctx({ current: currentPlan({ expiresAt: NOW - 10 }), currentActive: false })),
      "cycleTL",
      15000,
    );
    expect(expired.activation).toMatchObject({ immediate: false, loosened: ["expiresAt"] });
    expect(expired.activation!.textTr).toBe(
      "Mevcut planının süresi doldu; imzalarsan yeni plan 18.10.2026 12:00 (TR saati) geçerli olur. " +
        "O zamana kadar PİLOT alım yapamaz.",
    );
    expect(row(expired, "expiresAt").note).toBe(
      "Mevcut planının süresi doldu; yeni bitiş her zaman daha geç olduğundan plan 24 saat bekler.",
    );
    // Çağıran currentActive'i yanlış (true) verse de süre dolmuşsa metin yine doğru.
    const staleFlag = buildPlanConfirmation(elifDraft(), ctx({ current: currentPlan({ expiresAt: NOW - 10 }) }));
    expect(staleFlag.activation!.textTr).not.toContain("mevcut planın geçerli");

    const revoked = applyEdit(
      buildPlanConfirmation(elifDraft(), ctx({ current: currentPlan(), currentActive: false })),
      "cycleTL",
      25000,
    );
    expect(revoked.activation).toMatchObject({ immediate: false, loosened: ["cycleTL"] });
    expect(revoked.activation!.textTr).toBe(
      "Mevcut planın durduruldu; imzalarsan yeni plan 18.10.2026 12:00 (TR saati) geçerli olur. " +
        "O zamana kadar PİLOT alım yapamaz.",
    );
    // Etkin plan: eski metin.
    const active = applyEdit(buildPlanConfirmation(elifDraft(), ctx({ current: currentPlan() })), "cycleTL", 25000);
    expect(active.activation!.textTr).toContain("O zamana kadar mevcut planın geçerli.");
    // currentActive boolean değilse fail-closed: fırlatır.
    const noFlag = { nowSec: NOW, deployments: DEP, current: currentPlan() } as unknown as PlanConfirmationContext;
    expect(() => buildPlanConfirmation(elifDraft(), noFlag)).toThrow();
  });

  it("L-1 (şema) geçersiz taslak fail-closed: buildPlanConfirmation fırlatır", () => {
    const bad = { ...elifDraft(), maxOrderTL: { value: 30000, source: "user" } } as PlanDraft;
    expect(() => buildPlanConfirmation(bad, ctx())).toThrow();
    expect(() => buildPlanConfirmation(elifDraft(), ctx({ nowSec: -1 }))).toThrow();
  });

  // TODO(spec): §18 arayüz eşleşmesi için kimlik vermiyor; adım kimliği A0.2 (arayüz donduruldu) kullanıldı.
  it("A0.2 PLAN_FIELDS IFlightPlan.Plan struct sırasıyla aynı; paket kökünden dışa açık", () => {
    const sol = readFileSync(new URL("../../../contracts/src/interfaces/IFlightPlan.sol", import.meta.url), "utf8");
    const body = /struct Plan \{([^}]*)\}/.exec(sol)![1]!;
    const names = [...body.matchAll(/^\s*\w+\s+(\w+);/gm)].map((m) => m[1]);
    expect(names).toEqual([...PLAN_FIELDS]);
    expect(EDITABLE_PLAN_FIELDS.every((f) => (PLAN_FIELDS as readonly string[]).includes(f))).toBe(true);
    expect(shared.buildPlanConfirmation).toBe(buildPlanConfirmation);
    expect(shared.applyEdit).toBe(applyEdit);
  });
});
