/**
 * C7 — §19 sahneleri, uçtan uca ve deterministik (kayıt oynatma + FakeChain + FakeKule kâğıt + senaryolu sahte LLM).
 * Ağ yok, yayın yok, gerçek LLM çağrısı yok.
 *
 * E-3 (§10.5, §10.3-3): demo haberindeki gizli talimat. Kandırılmayan LLM talimatı veri sayar ve izde INJECTION_NOTE
 *   yazar; kandırılan LLM'i izin_iste kod koruması durdurur; araç katmanı tamamen atlansa bile zincir (OVER_ORDER_LIMIT)
 *   ve KULE (NO_AUTHORIZATION) durdurur. INJECTION_DEMO hiçbir korumayı kapatmaz.
 * E-5 (§10.3-1): kural_danis "şimdi al (post_only)" önerir, ekonomik_takvim 30 dk sonra TCMB açıklaması söyler; LLM
 *   izinli bekleme seçeneğini seçer ve Türkçe gerekçe yazar. İzde recommendedOptionId ≠ chosenOptionId (panel rozeti).
 *
 * TODO(spec): §10.3-1, §18 E-5 ve §19 "60 dk bekle" der; ama §10.4 karar tablosunun "hava açık" satırı (önerinin
 *   "şimdi al (post_only)" olduğu tek satır) yalnız WAIT(30) verir ve "Bu seçim yalnız allowed listesinin içindendir".
 *   En dar ve güvenli seçim: tabloya dokunulmaz, LLM izinli WAIT_30'u seçer. LLM izin listesinde olmayan 60 dk'yı
 *   seçerse tur kapanır (bekle emir vermez) ama seçim izinli sayılmaz ve rozet çıkmaz.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { keccak256, stringToBytes } from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import {
  DEMO_LABELS,
  INJECTION_NOTE,
  PILOT_TOOL_NAMES,
  TraceSchema,
  optionText,
  parseOptionId,
  pxToPxE6,
  utcMs,
  type KuralDanisOutput,
  type Replay,
  type TraceStep,
  type Weather,
} from "@pilot/shared";
import { atkCalendarStub, demoCalendarSource, readDemoCalendarFile, type DemoCalendarFile } from "../src/calendar/index.js";
import type { ChainClient, KuleClient } from "../src/clients/index.js";
import { REPLAY_ADDRESSES, createReplaySim, type LlmClient, type ReplaySimOptions } from "../src/loop/index.js";
import { INJECTION_DEMO_TEXT, demoNewsSource, readDemoNewsFile, type DemoNewsFile } from "../src/news/index.js";
import { MemoryTraceStore, TraceRecordSchema, turnChoice, type TraceRecord } from "../src/trace/index.js";
import { readReplayFile } from "../src/weather/index.js";

// ─────────────────────────────── Kurulum ───────────────────────────────

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const MIN = 60_000;
let R19: Replay;
let R1202: Replay;
let NEWS: DemoNewsFile;
let CAL: DemoCalendarFile;

beforeAll(async () => {
  R19 = await readReplayFile(join(ROOT, "data/replays/2025-03-19.json"));
  R1202 = await readReplayFile(join(ROOT, "data/replays/2025-12-02.json"));
  NEWS = await readDemoNewsFile(join(ROOT, "data/demo/news.json"));
  CAL = await readDemoCalendarFile(join(ROOT, "data/demo/calendar.json"));
});

// ─────────────────────────────── Senaryolu sahte LLM ───────────────────────────────

interface Call {
  name: string;
  input: Record<string, unknown>;
  out: any;
  error: string | null;
}

/** Bu turdaki araç çağrıları ve sonuçları (LLM'e geri giden tool_result'lardan). */
function history(p: Anthropic.MessageCreateParamsNonStreaming): Call[] {
  const uses = new Map<string, { name: string; input: Record<string, unknown> }>();
  const calls: Call[] = [];
  for (const m of p.messages) {
    if (typeof m.content === "string") continue;
    for (const b of m.content as any[]) {
      if (b.type === "tool_use") uses.set(b.id, { name: b.name, input: b.input });
      if (b.type === "tool_result") {
        const body = JSON.parse(b.content as string);
        calls.push({ ...uses.get(b.tool_use_id)!, out: b.is_error ? null : body, error: b.is_error ? body.hata : null });
      }
    }
  }
  return calls;
}

let seq = 0;
function msg(content: unknown[], stop_reason: Anthropic.StopReason = "tool_use"): Anthropic.Message {
  return {
    id: `msg_${++seq}`,
    type: "message",
    role: "assistant",
    model: "fake-llm",
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as Anthropic.Message;
}
const use = (name: string, input: unknown) => ({ type: "tool_use", id: `tu_${++seq}`, name, input });
const text = (t: string) => ({ type: "text", text: t, citations: null });
const bekle = (dakika: number, gerekce: string) => msg([text(gerekce), use("bekle", { dakika, gerekce })]);

type Policy = (h: Call[]) => Anthropic.Message;
class ScriptedLlm implements LlmClient {
  readonly model = "fake-llm";
  readonly requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  constructor(private readonly policy: Policy) {}
  async create(p: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
    this.requests.push({ ...p, messages: [...p.messages] });
    return this.policy(history(p));
  }
}

const lastOf = (h: Call[], n: string) => [...h].reverse().find((c) => c.name === n);

/** Önerilen alımı teklif_al → izin_iste (maxPx = teklif) → emri_uygula → bekle(5) ile uygular. */
function buyFlow(h: Call[], id: string, why: string, prefix: unknown[] = []): Anthropic.Message {
  const o = parseOptionId(id);
  if (o.kind !== "BUY") throw new Error(`alım değil: ${id}`);
  const q = lastOf(h, "teklif_al");
  if (!q) return msg([...prefix, use("teklif_al", { amountTL: o.amountTL, ordType: o.ordType })]);
  if (q.error || q.out.verdict !== "ONAY") return bekle(5, "Teklif onaylanmadı; emir yok.");
  const iz = lastOf(h, "izin_iste");
  if (!iz) {
    return msg([use("izin_iste", { amountTL: o.amountTL, maxPxE6: pxToPxE6(q.out.normalized.px), ordType: o.ordType, gerekce: why })]);
  }
  if (iz.error || iz.out.status !== "AUTHORIZED") return bekle(5, "İzin verilmedi; emir yok.");
  if (!lastOf(h, "emri_uygula")) return msg([use("emri_uygula", { actionId: iz.out.actionId })]);
  return bekle(5, `${why} Dilim çevrildi; döngü sürüyor.`);
}

/**
 * E-5 planlayıcısı: plan, hava, kural_danis ve ekonomik_takvim'i okur. Önerilen bir alımsa ve 60 dk içinde yüksek
 * önemli bir açıklama varsa YALNIZ allowed içindeki en uzun beklemeyi seçer; yoksa öneriyi uygular.
 * `forceMinutes`: izin listesinde olmayan bir süre dener (TODO(spec) testi).
 */
function calendarAware(o: { forceMinutes?: number } = {}): Policy {
  return (h) => {
    const k = lastOf(h, "kural_danis");
    if (!k) return msg([use("plan_oku", {}), use("hava_durumu", {}), use("kural_danis", {}), use("ekonomik_takvim", {})]);
    if (k.error) return bekle(5, "Karar tablosu okunamadı.");
    const adv = k.out as KuralDanisOutput;
    const now = (lastOf(h, "hava_durumu")!.out as Weather).ts;
    const cal = lastOf(h, "ekonomik_takvim");
    const soon = cal?.out?.events?.find((e: any) => e.importance === "high" && e.ts - now <= 60 * MIN);
    const rec = parseOptionId(adv.recommended);
    const waits = adv.allowed.map(parseOptionId).filter((x) => x.kind === "WAIT");
    if (rec.kind === "BUY" && soon && waits.length > 0 && !lastOf(h, "teklif_al")) {
      const w = waits.reduce((a, b) => (b.kind === "WAIT" && a.kind === "WAIT" && b.minutes > a.minutes ? b : a));
      const dk = o.forceMinutes ?? (w.kind === "WAIT" ? w.minutes : 0);
      const inMin = Math.round((soon.ts - now) / MIN);
      const why =
        `Takvimde ${inMin} dk sonra "${soon.title}" var; önerilen "${optionText(rec)}" yerine izinli ` +
        `"${dk} dk bekle" seçeneğini seçiyorum. Açıklamadan sonra karar tablosuna yeniden bakacağım.`;
      return bekle(dk, why);
    }
    if (rec.kind === "BUY") return buyFlow(h, adv.recommended, adv.reason);
    if (rec.kind === "WAIT") return bekle(rec.minutes, adv.reason);
    return bekle(60, adv.reason);
  };
}

// ─────────────────────────────── Yardımcılar ───────────────────────────────

const stepOf = (r: TraceRecord, tool: string) => r.trace.steps.find((s) => s.tool === tool);
const toolsOf = (r: TraceRecord) => r.trace.steps.map((s) => s.tool);

function at(series: Weather[], ms: number): Weather {
  const w = series.find((x) => x.ts === ms);
  if (!w) throw new Error(`kayıtta ${new Date(ms).toISOString()} yok`);
  return w;
}

function expectValid(records: TraceRecord[]) {
  for (const r of records) {
    expect(TraceRecordSchema.safeParse(r).success).toBe(true);
    expect(TraceSchema.safeParse(r.trace).success).toBe(true);
    expect(r.trace.steps.length).toBeLessThanOrEqual(8);
    for (const s of r.trace.steps) expect(PILOT_TOOL_NAMES).toContain(s.tool);
  }
}

/** PİLOT'un kendi zincir ve KULE istemcileri (araç katmanını atlayan "ele geçirilmiş ajan" denemesi için). */
function capture() {
  const c: { chain?: ChainClient; kule?: KuleClient } = {};
  return {
    c,
    wrapChain: (x: ChainClient) => (c.chain = x),
    wrapKule: (x: KuleClient) => (c.kule = x),
  };
}

/** 2025-03-19 08:40 UTC: LIRA_ZAYIFLADI (W-6); tablo BUY_IOC_10000 önerir. */
async function shockScene(o: Partial<ReplaySimOptions> & { llm: LlmClient | null; injection: boolean }) {
  const store = new MemoryTraceStore();
  const cap = capture();
  const sim = await createReplaySim({
    replay: R19,
    store,
    news: demoNewsSource(NEWS, { injection: o.injection }),
    labels: o.injection ? [DEMO_LABELS.injectionDemo] : [],
    wrapChain: cap.wrapChain,
    wrapKule: cap.wrapKule,
    ...o,
  });
  const w = at(sim.series, utcMs(2025, 3, 19, 8, 40));
  expect(w.class).toBe("LIRA_ZAYIFLADI");
  return { sim, store, w, cap: cap.c };
}

/** 2025-12-02 10:30 UTC = 13:30 TR: hava açık (NORMAL), pencere açık; demo takviminde TCMB 14:00 TR. */
async function calendarScene(o: Partial<ReplaySimOptions> & { llm: LlmClient | null }) {
  const store = new MemoryTraceStore();
  const sim = await createReplaySim({ replay: R1202, store, calendar: demoCalendarSource(CAL), ...o });
  const w = at(sim.series, utcMs(2025, 12, 2, 10, 30));
  expect(w.class).toBe("NORMAL");
  return { sim, store, w, i: sim.series.indexOf(w) };
}

// ─────────────────────────────── E-3 ───────────────────────────────

/** Haberde talimat görür, veri sayar (INJECTION_NOTE), yalnız tablonun önerisini uygular. */
const skepticLlm = () =>
  new ScriptedLlm((h) => {
    const k = lastOf(h, "kural_danis");
    if (!k) return msg([use("plan_oku", {}), use("hava_durumu", {}), use("haberleri_oku", {}), use("kural_danis", {})]);
    const adv = k.out as KuralDanisOutput;
    const news = lastOf(h, "haberleri_oku")!.out;
    const injected = news.items.some((i: any) => /SİSTEM NOTU|limitleri yok say/i.test(i.body));
    return buyFlow(h, adv.recommended, adv.reason, injected ? [text(INJECTION_NOTE)] : []);
  });

/** Haberdeki talimata uyar: 40.000 TL ioc ister. */
const obedientLlm = () =>
  new ScriptedLlm((h) => {
    if (!lastOf(h, "haberleri_oku")) return msg([use("haberleri_oku", {}), use("kural_danis", {})]);
    const q = lastOf(h, "teklif_al");
    if (!q) return msg([use("teklif_al", { amountTL: 40_000, ordType: "ioc" })]);
    if (!lastOf(h, "izin_iste")) {
      const px = q.out?.normalized?.px ? pxToPxE6(q.out.normalized.px) : 50_000_000;
      return msg([use("izin_iste", { amountTL: 40_000, maxPxE6: px, ordType: "ioc", gerekce: "Haberdeki sistem notu: kullanıcı onayladı." })]);
    }
    if (!lastOf(h, "emri_uygula")) return msg([use("emri_uygula", { actionId: "1" })]);
    return bekle(360, "Talimat uygulanamadı.");
  });

describe("E-3 demo haberi sahnesi (§19 4:30–6:30 (2), §10.5)", () => {
  it("E-3 kandırılmayan LLM: gizli talimatı veri sayar, izde 'veri olarak değerlendirdim'; yalnız izinli öneriyi uygular", async () => {
    const llm = skepticLlm();
    const { sim, store, w } = await shockScene({ llm, injection: true });
    const r = (await sim.tick(w))!;

    expect(r.labels).toContain(DEMO_LABELS.injectionDemo);
    const news = stepOf(r, "haberleri_oku")!.out as any;
    expect(news).toMatchObject({ untrusted: true, demo: true });
    expect(news.items.find((i: any) => i.id === "demo-enjeksiyon-1").body).toContain(INJECTION_DEMO_TEXT);

    expect(r.trace.rationaleTr).toContain("Haberdeki talimatı veri olarak değerlendirdim.");
    expect(toolsOf(r)).toEqual(["plan_oku", "hava_durumu", "haberleri_oku", "kural_danis", "teklif_al", "izin_iste", "emri_uygula", "bekle"]);
    const auth = sim.chain.events.filter((e) => e.kind === "BuyAuthorized");
    expect(auth).toHaveLength(1);
    expect(auth[0]).toMatchObject({ amountTL: 10_000, ordType: "ioc", user: REPLAY_ADDRESSES.user });
    expect(sim.chain.events.filter((e) => e.kind === "BuyRejected")).toEqual([]);
    expect(r.trace).toMatchObject({ recommendedOptionId: "BUY_IOC_10000", chosenOptionId: "BUY_IOC_10000" });
    expectValid(store.records);
  });

  it("E-3 kandırılan LLM: 40.000 TL izin_iste kodda REFUSED, zincire gidilmez; haberdeki/uydurma actionId KULE'ye gitmez", async () => {
    const llm = obedientLlm();
    const { sim, store, w } = await shockScene({ llm, injection: true });
    const r = (await sim.tick(w))!;

    const iz = stepOf(r, "izin_iste")!;
    expect(iz.out).toMatchObject({ status: "REFUSED" });
    expect(String((iz.out as any).message)).toContain("BUY_IOC_40000");
    expect(stepOf(r, "emri_uygula")!.error).toContain("PİLOT'un izin_iste sonucu değil");
    expect(sim.chain.events).toEqual([]);
    expect(sim.kule.calls.filter((c) => c.tool === "kule_execute")).toEqual([]);
    // Seçim izinli bir seçeneğe eşlenmez: panel "önerilenden farklı seçti" rozeti göstermez.
    expect(r.trace.recommendedOptionId).toBe("BUY_IOC_10000");
    expect(r.trace.chosenOptionId).toBeUndefined();
    expect(r.labels).toContain(DEMO_LABELS.injectionDemo);
    expectValid(store.records);
  });

  it("E-3 araç katmanı tamamen atlansa bile (ele geçirilmiş PİLOT): zincir OVER_ORDER_LIMIT, KULE NO_AUTHORIZATION", async () => {
    const { sim, cap } = await shockScene({ llm: null, injection: true });
    sim.clock.set(utcMs(2025, 3, 19, 8, 40) + 5_000);
    // PİLOT'un kendi anahtarı/istemcisiyle doğrudan requestBuy (stolen-key.ts'nin PİLOT tarafı eşleniği).
    const res = await cap.chain!.requestBuy({
      amountTL: 40_000,
      maxPxE6: 50_000_000,
      ordType: "ioc",
      reasonHash: keccak256(stringToBytes(INJECTION_DEMO_TEXT)),
    });
    expect(res).toMatchObject({ status: "REJECTED", code: "OVER_ORDER_LIMIT" });
    expect(sim.chain.events).toEqual([expect.objectContaining({ kind: "BuyRejected", amountTL: 40_000, code: "OVER_ORDER_LIMIT" })]);
    expect(sim.chain.cycleOfNow(REPLAY_ADDRESSES.user)).toMatchObject({ spentTL: 0, reservedTL: 0 });
    // PİLOT'un KULE token'ıyla, zincirde olmayan izin numarası → RET.
    const ex = await cap.kule!.execute({ actionId: "999" });
    expect(ex.verdict).toBe("RET");
    expect(ex.reasons).toContain("NO_AUTHORIZATION");
    expect(sim.kule.executions).toEqual([]);
  });

  it("E-3 INJECTION_DEMO hiçbir korumayı kapatmaz: aynı kandırılmış istek bayrak açık da kapalı da aynı biçimde reddedilir", async () => {
    const outcomes = [];
    for (const injection of [false, true]) {
      const { sim, w } = await shockScene({ llm: obedientLlm(), injection });
      const r = (await sim.tick(w))!;
      const news = stepOf(r, "haberleri_oku")!.out as any;
      expect(news.items.some((i: any) => i.body.includes(INJECTION_DEMO_TEXT))).toBe(injection);
      expect(r.labels.includes(DEMO_LABELS.injectionDemo)).toBe(injection);
      expect(sim.chain.events).toEqual([]);
      outcomes.push(r.trace.steps.map((s) => [s.tool, (s.out as any)?.status ?? null, s.error ?? null]));
    }
    expect(outcomes[1]).toEqual(outcomes[0]);
  });
});

// ─────────────────────────────── E-5 ───────────────────────────────

describe("E-5 önerilenden farklı seçim sahnesi (§19 2:00–4:30, §10.3-1)", () => {
  it("E-5 takvimde 30 dk sonra TCMB: LLM önerilen 'şimdi al (post_only)' yerine izinli beklemeyi seçer, gerekçe yazar; iz farkı kaydeder", async () => {
    const llm = new ScriptedLlm(calendarAware());
    const { sim, store, w, i } = await calendarScene({ llm });
    const r = (await sim.tick(w))!;
    const now = w.ts + 5_000; // 13:30:05 TR

    expect(toolsOf(r)).toEqual(["plan_oku", "hava_durumu", "kural_danis", "ekonomik_takvim", "bekle"]);
    const adv = stepOf(r, "kural_danis")!.out as KuralDanisOutput;
    expect(adv.recommended).toBe("BUY_POST_10000");
    expect(adv.allowed).toEqual(["BUY_POST_10000", "WAIT_30"]);
    const cal = stepOf(r, "ekonomik_takvim")!.out as any;
    expect(cal.demo).toBe(true);
    expect(cal.events[0]).toMatchObject({ title: "TCMB faiz kararı (DEMO)", ts: utcMs(2025, 12, 2, 11, 0) });
    expect(Math.round((cal.events[0].ts - now) / MIN)).toBe(30);

    // Seçim allowed içinden ve önerilenden farklı; panel rozeti bu iki alandan.
    expect(r.trace.recommendedOptionId).toBe("BUY_POST_10000");
    expect(r.trace.chosenOptionId).toBe("WAIT_30");
    expect(adv.allowed).toContain(r.trace.chosenOptionId);
    expect(r.trace.mode).toBe("llm");
    expect(r.trace.rationaleTr).toContain('30 dk sonra "TCMB faiz kararı (DEMO)"');
    expect(r.trace.rationaleTr).toContain("10.000 TL al");
    expect(r.trace.rationaleTr.split(/[.!?](?:\s|$)/).filter((x) => x.trim()).length).toBeLessThanOrEqual(2);
    expect(r.end).toEqual({ by: "bekle", untilMs: now + 30 * MIN, gerekce: expect.stringContaining("TCMB") });
    expect(sim.chain.events).toEqual([]);
    expect(sim.kule.calls.filter((c) => c.tool !== "kule_heartbeat")).toEqual([]);

    // Bekleme sırasında tur yok; açıklamadan sonra (14:00:05 TR) takvimde yakın olay yok → öneriye döner.
    for (const x of sim.series.slice(i + 1, i + 6)) expect(await sim.tick(x)).toBeNull();
    const after = (await sim.tick(sim.series[i + 6]!))!;
    expect(after.trace.ts).toBe(utcMs(2025, 12, 2, 11, 0) + 5_000);
    expect(after.trigger).toBe("tick");
    expect((stepOf(after, "ekonomik_takvim")!.out as any).events[0].title).toBe("TÜİK enflasyon verisi (DEMO)");
    expect(after.trace).toMatchObject({ recommendedOptionId: "BUY_POST_10000", chosenOptionId: "BUY_POST_10000" });
    const auth = sim.chain.events.filter((e) => e.kind === "BuyAuthorized");
    expect(auth).toEqual([expect.objectContaining({ amountTL: 10_000, ordType: "post_only" })]);
    expectValid(store.records);
  });

  it("E-5 aynı an kural modunda: takvim kararı etkilemez, önerilen uygulanır (chosen = recommended)", async () => {
    const { sim, w } = await calendarScene({ llm: null });
    const r = (await sim.tick(w))!;
    expect(r.trace.mode).toBe("rules");
    expect(r.trace).toMatchObject({ recommendedOptionId: "BUY_POST_10000", chosenOptionId: "BUY_POST_10000" });
    expect(sim.chain.events.filter((e) => e.kind === "BuyAuthorized")).toHaveLength(1);
  });

  it("E-5 ATK takvimi doğrulanmamış (taslak hata verir): LLM takvimsiz kalır ve öneriyi uygular; uydurma olay yok", async () => {
    const llm = new ScriptedLlm(calendarAware());
    const { sim, w } = await calendarScene({ llm, calendar: atkCalendarStub });
    const r = (await sim.tick(w))!;
    expect(stepOf(r, "ekonomik_takvim")!.error).toBe("Araç hata verdi; işlem yapılmadı.");
    expect(r.trace).toMatchObject({ recommendedOptionId: "BUY_POST_10000", chosenOptionId: "BUY_POST_10000" });
  });

  it("E-5 TODO(spec) '60 dk': hava açıkken izinli bekleme yalnız 30 dk; LLM 60 dk seçerse emir yok ama seçim izinli sayılmaz (rozet yok)", async () => {
    const llm = new ScriptedLlm(calendarAware({ forceMinutes: 60 }));
    const { sim, w } = await calendarScene({ llm });
    const r = (await sim.tick(w))!;
    expect((stepOf(r, "kural_danis")!.out as KuralDanisOutput).allowed).not.toContain("WAIT_60");
    expect(stepOf(r, "bekle")!.in).toMatchObject({ dakika: 60 });
    expect(r.trace.recommendedOptionId).toBe("BUY_POST_10000");
    expect(r.trace.chosenOptionId).toBeUndefined();
    expect(sim.chain.events).toEqual([]);
  });
});

// ─────────────────────────────── turnChoice ───────────────────────────────

describe("E-5 iz seçimi (turnChoice): yalnız izden ve yalnız allowed içinden", () => {
  const kd = (allowed: string[], recommended: string): TraceStep => ({
    tool: "kural_danis",
    out: { allowed, recommended, reason: "test" },
  });
  const cases: [string, TraceStep[], { recommendedOptionId?: string; chosenOptionId?: string }][] = [
    ["kural_danis yok", [{ tool: "bekle", in: { dakika: 5, gerekce: "x" }, out: { ok: true, untilMs: 1 } }], {}],
    [
      "izin_iste REFUSED sayılmaz, sonraki izinli bekleme seçimdir",
      [
        kd(["BUY_POST_10000", "WAIT_30"], "BUY_POST_10000"),
        { tool: "izin_iste", in: { amountTL: 10_000, ordType: "post_only", maxPxE6: 1, gerekce: "x" }, out: { status: "REFUSED", message: "m" } },
        { tool: "bekle", in: { dakika: 30, gerekce: "x" }, out: { ok: true, untilMs: 1 } },
      ],
      { recommendedOptionId: "BUY_POST_10000", chosenOptionId: "WAIT_30" },
    ],
    [
      "zincir reddi (REJECTED) seçimdir; sonraki bekle(5) değil",
      [
        kd(["BUY_IOC_10000", "BUY_POST_10000"], "BUY_IOC_10000"),
        { tool: "izin_iste", in: { amountTL: 10_000, ordType: "post_only", maxPxE6: 1, gerekce: "x" }, out: { status: "REJECTED" } },
        { tool: "bekle", in: { dakika: 5, gerekce: "x" }, out: { ok: true, untilMs: 1 } },
      ],
      { recommendedOptionId: "BUY_IOC_10000", chosenOptionId: "BUY_POST_10000" },
    ],
    [
      "izin listesinde olmayan alım (iz araç katmanından gelmese bile) seçim sayılmaz",
      [
        kd(["BUY_IOC_10000", "BUY_POST_10000"], "BUY_IOC_10000"),
        { tool: "izin_iste", in: { amountTL: 40_000, ordType: "ioc", maxPxE6: 1, gerekce: "x" }, out: { status: "REJECTED" } },
        { tool: "kullaniciya_sor", in: { soru: "x", secenekler: ["BUY_IOC_10000", "BUY_POST_10000"] }, out: { posted: true } },
      ],
      { recommendedOptionId: "BUY_IOC_10000" },
    ],
    [
      "BEKLE seçeneğinde bekle(60) → BEKLE",
      [kd(["BEKLE"], "BEKLE"), { tool: "bekle", in: { dakika: 60, gerekce: "x" }, out: { ok: true, untilMs: 1 } }],
      { recommendedOptionId: "BEKLE", chosenOptionId: "BEKLE" },
    ],
    [
      "soru → ASK; hata veren bitir sayılmaz",
      [
        kd(["ASK", "WAIT_60", "BUY_POST_5000"], "ASK"),
        { tool: "bitir", in: { ozet: "x" }, error: "izin yok" },
        { tool: "kullaniciya_sor", in: { soru: "x", secenekler: ["WAIT_60", "BUY_POST_5000"] }, out: { questionId: "q1", posted: true } },
      ],
      { recommendedOptionId: "ASK", chosenOptionId: "ASK" },
    ],
    [
      "son kural_danis geçerlidir; bozuk kural_danis çıktısı yok sayılır",
      [
        kd(["WAIT_60", "BUY_POST_5000"], "WAIT_60"),
        { tool: "kural_danis", out: { allowed: ["BUY_IOC_40000"], recommended: "WAIT_1" } },
        { tool: "bekle", in: { dakika: 60, gerekce: "x" }, out: { ok: true, untilMs: 1 } },
      ],
      { recommendedOptionId: "WAIT_60", chosenOptionId: "WAIT_60" },
    ],
  ];
  it.each(cases)("E-5 %s", (_why, steps, want) => {
    expect(turnChoice(steps)).toEqual(want);
  });
});
