import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { INJECTION_NOTE, REJECT_TEXTS, STOLEN_KEY_MESSAGE, TraceSchema, type Trace } from "@pilot/shared";
import type { KuleStatus, PlanEvent } from "../../lib/data";
import type { BuyAction } from "@pilot/shared";
import { CycleCard } from "./CycleCard";
import { ExecutionsCard, RejectionsCard, rejectInfo } from "./ChainCards";
import { KuleBody } from "./KuleCard";
import { TraceCard } from "./TraceCard";
import { WeatherBody } from "./WeatherCard";
import { buildAuthRows, eventFromLog, mergeEvents } from "./chainEvents";
import type { ChainView } from "./hooks";
import { DEMO_USER, seededFeed } from "./seed";
import { trNumber } from "./time";
import { choiceOf, parseStepOut } from "./trace";

const NOW = Date.now();
const feed = seededFeed(NOW);
const [T6, T5, T4] = feed.traces as [Trace, Trace, Trace];
const U = DEMO_USER;
const H = (c: string) => `0x${c.repeat(64)}` as `0x${string}`;

describe("tohum (TEMSİLİ VERİ)", () => {
  it("19 Mart 2025 şok değerleri: zd 9,0 ve btc1h −0,08 (T5 turunun havası)", () => {
    const w = parseStepOut("hava_durumu", T5.steps[0]!.out)!;
    expect(w.zd).toBe(9);
    expect(w.btc1h).toBe(-0.08);
    expect(w.alarm).toBe(true);
    expect(w.class).toBe("LIRA_ZAYIFLADI");
  });

  it("her iz adımının çıktısı aracın tam şemasıyla doğrulanır", () => {
    for (const t of feed.traces) for (const s of t.steps) expect(parseStepOut(s.tool, s.out), `${t.turn}/${s.tool}`).not.toBeNull();
  });

  it("özet çıktı (yalnız class+zd) şemayı geçmez: ekran 'doğrulanmamış' gösterir, OK yazmaz", () => {
    expect(parseStepOut("hava_durumu", { class: "NORMAL", zd: 0.4 })).toBeNull();
    const t: Trace = { ...T4, steps: [{ tool: "hava_durumu", out: { class: "NORMAL", zd: 0.4 } }], rationaleTr: "x" };
    const html = renderToStaticMarkup(<TraceCard feed={{ status: "ok", data: { ...feed, traces: [t] }, receivedAt: NOW }} now={NOW} />);
    expect(html).toContain("doğrulanmamış çıktı");
    expect(html).not.toContain("Hava açık");
  });
});

describe("önerilenden farklı seçti rozeti", () => {
  it("izdeki alanlar varsa onlar kullanılır: T5 aynı, T6 farklı", () => {
    expect(choiceOf(T5)?.differs).toBe(false);
    expect(choiceOf(T6)).toMatchObject({ recommended: "BUY_POST_10000", chosen: "ASK", differs: true });
  });

  it("alan yoksa yalnız kural_danis'ten HEMEN sonraki adımla birebir eşleşince türetilir", () => {
    const base = { ...T4, recommendedOptionId: undefined, chosenOptionId: undefined };
    expect(choiceOf(base)).toMatchObject({ recommended: "WAIT_5", chosen: "WAIT_5", differs: false });
    const wait60: Trace = TraceSchema.parse({
      ...T6,
      recommendedOptionId: undefined,
      chosenOptionId: undefined,
      steps: [
        T6.steps[0],
        T6.steps[1],
        { tool: "bekle", in: { dakika: 60, gerekce: "bekliyorum" }, out: { ok: true, untilMs: NOW } },
      ],
    });
    expect(choiceOf(wait60)).toMatchObject({ chosen: "WAIT_60", differs: true });
  });

  it("eşleşme yoksa ya da seçim allowed'da değilse rozet hiç gösterilmez", () => {
    // T6 izin_iste 15.000 TL ister: BUY_POST_15000 allowed'da yok
    expect(choiceOf({ ...T6, recommendedOptionId: undefined, chosenOptionId: undefined })).toBeNull();
    expect(choiceOf({ ...T6, chosenOptionId: "WAIT_999" })).toBeNull();
    expect(choiceOf({ ...T5, steps: T5.steps.filter((s) => s.tool !== "kural_danis") })).toBeNull();
  });

  it("T6 kartında rozet görünür, T5 kartında görünmez", () => {
    const one = (t: Trace) => renderToStaticMarkup(<TraceCard feed={{ status: "ok", data: { ...feed, traces: [t] }, receivedAt: NOW }} now={NOW} />);
    expect(one(T6)).toContain("önerilenden farklı seçti");
    expect(one(T5)).not.toContain("önerilenden farklı seçti");
  });
});

describe("iz kartı", () => {
  const html = renderToStaticMarkup(<TraceCard feed={{ status: "ok", data: feed, receivedAt: NOW }} now={NOW} />);

  it("izin_iste AUTHORIZED kesinleşme süresiyle, REFUSED gri, emri_uygula KÂĞIT etiketiyle", () => {
    expect(html).toContain("1,4 sn&#x27;de kesinleşti");
    expect(html).toContain("Araç koruması zincire göndermedi");
    expect(html).toContain("KÂĞIT");
    expect(html).toContain("temsili"); // mock iken işlem özeti bağlantı değildir
  });

  it("demo haberi: DEMO + güvenilmeyen veri + ENJEKSİYON DEMOSU ve enjeksiyon notu", () => {
    expect(html).toContain("güvenilmeyen veri");
    expect(html).toContain("ENJEKSİYON DEMOSU");
    expect(html).toContain(INJECTION_NOTE.replace("'", "&#x27;"));
  });

  it("izin_iste REJECTED kırmızı ret gövdesiyle, shared ret metniyle gösterilir", () => {
    const rej: Trace = {
      ...T5,
      steps: [
        T5.steps[1]!,
        { tool: "izin_iste", in: { amountTL: 10000, maxPxE6: 38700000, ordType: "ioc", gerekce: "x" }, out: { status: "REJECTED", code: "OVER_CYCLE_TARGET", message: "m", tx: H("c"), finalityMs: 1700 } },
      ],
    };
    const h = renderToStaticMarkup(<TraceCard feed={{ status: "ok", data: { ...feed, traces: [rej] }, receivedAt: NOW }} now={NOW} />);
    expect(h).toContain("pn-rej");
    expect(h).toContain(REJECT_TEXTS.OVER_CYCLE_TARGET);
    expect(h).toContain("İşlem başarılı, izin reddedildi.");
  });

  it("besleme hata verirse ya da bayatsa 'bilinmiyor' (gri); eski veri gösterilmez", () => {
    expect(renderToStaticMarkup(<TraceCard feed={{ status: "error" }} now={NOW} />)).toContain("bilinmiyor");
    const stale = renderToStaticMarkup(<TraceCard feed={{ status: "ok", data: { ...feed, generatedAt: NOW - 11 * 60_000 }, receivedAt: NOW }} now={NOW} />);
    expect(stale).toContain("Besleme bayat");
  });

  it("iz yok → 'PİLOT henüz bir tur çalıştırmadı.'", () => {
    expect(renderToStaticMarkup(<TraceCard feed={{ status: "ok", data: { ...feed, traces: [] }, receivedAt: NOW }} now={NOW} />)).toContain("PİLOT henüz bir tur çalıştırmadı.");
  });
});

describe("Lira Hava Durumu ve KULE kutusu", () => {
  it("sınıf metni, zd alarmı, BTC değişimi ve fırtına saatleri TR saatiyle", () => {
    const w = parseStepOut("hava_durumu", T5.steps[0]!.out)!;
    const html = renderToStaticMarkup(<WeatherBody w={w} replay />);
    expect(html).toContain("Lira zayıfladı");
    expect(html).toContain("ALARM");
    expect(html).toContain("%−0,08");
    expect(html).toContain("10:30"); // 07:30 UTC = 10:30 TR
    expect(html).toContain("16:35"); // son alarm 07:35 UTC + 6 sa = 13:35 UTC = 16:35 TR
    expect(html).toContain("kayıt saati");
    expect(html).toContain("Veridir, yatırım tavsiyesi değildir.");
  });

  it("trNumber: virgüllü, işaretli", () => {
    expect(trNumber(9, 1)).toBe("9,0");
    expect(trNumber(-0.08)).toBe("−0,08");
    expect(trNumber(-0.001)).toBe("0,00");
  });

  it("KULE: CAA geri sayımı lastRenewAt + 60 sn; yenilenmediyse düşmüş sayılır; YETKİ_YOK kırmızı", () => {
    const s: KuleStatus = { health: "NORMAL", reasons: [], caa: { active: true, lastRenewAt: NOW - 7_000 }, pilotHeartbeatAgeSec: 6, dataAgeSec: { ticker: 1, book: 2 }, chain: { ok: true, block: 5 }, mode: "paper" };
    expect(renderToStaticMarkup(<KuleBody s={s} now={NOW} />)).toContain("53 sn sonra açık emirler düşer");
    expect(renderToStaticMarkup(<KuleBody s={s} now={NOW + 120_000} />)).toContain("yenilenmedi");
    const denied = renderToStaticMarkup(<KuleBody s={{ ...s, health: "YETKİ_YOK", reasons: ["NO_AUTHORIZATION"] }} now={NOW} />);
    expect(denied).toContain("pn-red");
    expect(denied).toContain("Yetki yok");
  });
});

const ev = {
  rejected: { kind: "BuyRejected", user: U, hash: H("1"), blockNumber: 12n, agentId: "17", amountTL: 40000n, code: 3 } satisfies PlanEvent,
  auth18: { kind: "BuyAuthorized", user: U, hash: H("2"), blockNumber: 10n, actionId: "18", agentId: "17", amountTL: 10000n } satisfies PlanEvent,
  exec18: { kind: "BuyExecuted", user: U, hash: H("3"), blockNumber: 11n, actionId: "18", filledTL: 10000n, avgPxE6: 38700000n, status: 0 } satisfies PlanEvent,
  auth19: { kind: "BuyAuthorized", user: U, hash: H("4"), blockNumber: 13n, actionId: "19", agentId: "17", amountTL: 5000n } satisfies PlanEvent,
};

function chainWith(events: PlanEvent[], authRows: ChainView["authRows"] = [], gate: ChainView["gate"] = "ready"): ChainView {
  return { gate, plan: { status: "ok", plan: null, active: false, cycle: null }, history: { status: "ok", events }, authRows, blockTime: () => undefined };
}

describe("zincir olayları", () => {
  it("BuyRejected kırmızı ret satırı olarak, shared ret metniyle ve çalınmış anahtar mesajıyla gösterilir", () => {
    const html = renderToStaticMarkup(<RejectionsCard chain={chainWith([ev.rejected])} />);
    expect(html).toContain("o-rejected");
    expect(html).toContain(REJECT_TEXTS.OVER_ORDER_LIMIT);
    expect(html).toContain("40.000 TL");
    expect(html).toContain(STOLEN_KEY_MESSAGE.replaceAll("'", "&#x27;"));
    expect(html).toContain("testnet.snowtrace.io/tx/"); // zincir verisi gerçektir: bağlantı verilir
  });

  it("bilinmeyen ret kodu yine ret sayılır (kırmızı), 'bilinmeyen ret kodu' yazar", () => {
    expect(rejectInfo(99)).toEqual({ name: null, text: "bilinmeyen ret kodu" });
    expect(rejectInfo(0).name).toBeNull();
  });

  it("kontrat yok → NO_DEPLOYMENT notu; zincir okunamadı → gri not", () => {
    expect(renderToStaticMarkup(<RejectionsCard chain={chainWith([], [], "nodeploy")} />)).toContain("NO_DEPLOYMENT");
    const bad = { ...chainWith([]), history: { status: "error", events: [] } } as ChainView;
    expect(renderToStaticMarkup(<RejectionsCard chain={bad} />)).toContain("Zincir okunamadı");
  });

  it("izin ↔ emir eşleşir; rapor süresi geçen izin gri 'rapor süresi doldu'", () => {
    const events = [ev.auth19, ev.rejected, ev.exec18, ev.auth18];
    const open: BuyAction = { user: U, amountTL: 5000, maxPxE6: 1, ordType: "ioc", openBy: 0, reportBy: 100, cycleId: 202503, state: "AUTHORIZED" };
    const rows = buildAuthRows(events, new Map([["19", open]]), 200);
    expect(rows.find((r) => r.actionId === "18")).toMatchObject({ reportExpired: false });
    expect(rows.find((r) => r.actionId === "18")?.executed).not.toBeNull();
    expect(rows.find((r) => r.actionId === "19")).toMatchObject({ reportExpired: true });
    // actions(id) okunamadıysa tahmin yok
    expect(buildAuthRows(events, new Map(), 200).find((r) => r.actionId === "19")?.reportExpired).toBe(false);
    const html = renderToStaticMarkup(<ExecutionsCard chain={chainWith(events, rows)} paper />);
    expect(html).toContain("rapor süresi doldu");
    expect(html).toContain("Doldu");
    expect(html).toContain("KÂĞIT");
  });

  it("canlı günlük yalnız bağlı kullanıcı için olaya çevrilir; geçmişle birleşince tekrarlanmaz ve yeni → eski sıralanır", () => {
    const other = "0x2222222222222222222222222222222222222222";
    const log = (user: string) => ({ eventName: "BuyRejected", args: { user, agentId: 17n, amountTL: 40000n, code: 3, reasonHash: H("0") }, transactionHash: H("1"), blockNumber: 12n }) as never;
    expect(eventFromLog(log(other), U)).toBeNull();
    const e = eventFromLog(log(U), U)!;
    expect(e).toMatchObject({ kind: "BuyRejected", code: 3, amountTL: 40000n });
    const merged = mergeEvents([ev.auth18, ev.rejected], [e]);
    expect(merged.map((x) => x.kind)).toEqual(["BuyRejected", "BuyAuthorized"]);
  });
});

describe("döngü çubuğu", () => {
  it("harcanan / hedef, bekleyen dilim ve hedef tamam notu", () => {
    const plan = { cycleTL: 20000, maxOrderTL: 10000, startDay: 1, deadlineDay: 28, maxWaitH: 72, bandBps: 0, closedBandBps: 500, askMode: 1, expiresAt: 4102444800, agent: U, kule: U, agentId: "17" } as const;
    const mk = (spentTL: number, reservedTL: number): ChainView => ({
      ...chainWith([]),
      plan: { status: "ok", plan, active: true, cycle: { id: 202503, spentTL, reservedTL, closed: false } },
    });
    const html = renderToStaticMarkup(<CycleCard chain={mk(10000, 5000)} nowSec={1742369700} />);
    expect(html).toContain("10.000 / 20.000");
    expect(html).toContain("width:50%"); // harcanan
    expect(html).toContain("width:25%"); // bekleyen
    expect(html).toContain("Mart 2025");
    expect(html).not.toContain("Bu ayın hedefi tamamlandı.");
    expect(renderToStaticMarkup(<CycleCard chain={mk(20000, 0)} nowSec={1742369700} />)).toContain("Bu ayın hedefi tamamlandı.");
  });

  it("kontrat yok, cüzdan yok ve okunamadı durumlarında gri; çubuk çizilmez", () => {
    expect(renderToStaticMarkup(<CycleCard chain={chainWith([], [], "nodeploy")} nowSec={1} />)).toContain("NO_DEPLOYMENT");
    expect(renderToStaticMarkup(<CycleCard chain={chainWith([], [], "nowallet")} nowSec={1} />)).toContain("cüzdanını bağla");
    const err = { ...chainWith([]), plan: { status: "error", plan: null, active: false, cycle: null } } as ChainView;
    const html = renderToStaticMarkup(<CycleCard chain={err} nowSec={1} />);
    expect(html).toContain("bilinmiyor");
    expect(html).not.toContain("gauge");
  });
});
