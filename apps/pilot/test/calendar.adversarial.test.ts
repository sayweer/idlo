/**
 * ADVERSARY — demo takvimi ve ekonomik_takvim (§10.2, §21 #10, E-5). Ağ yok.
 *
 * Geçen testler regresyon testi olarak kalır. Kasıtlı olarak KIRMIZI bırakılan testler başlıkta "[HATA]" taşır.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { EkonomikTakvimOutputSchema, utcMs, type Replay } from "@pilot/shared";
import { demoCalendarSource, parseDemoCalendar } from "../src/calendar/index.js";
import { createReplaySim } from "../src/loop/index.js";
import { CALENDAR_MAX_EVENTS, type CalendarSource } from "../src/tools/index.js";
import { MemoryTraceStore } from "../src/trace/index.js";
import { readReplayFile } from "../src/weather/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const MIN = 60_000;
const NOW = utcMs(2025, 12, 2, 10, 30) + 5_000;
let raw: any;
let R1202: Replay;
beforeAll(async () => {
  raw = JSON.parse(await readFile(join(ROOT, "data/demo/calendar.json"), "utf8"));
  R1202 = await readReplayFile(join(ROOT, "data/replays/2025-12-02.json"));
});

async function callCal(calendar: CalendarSource, nowMs = NOW) {
  const sim = await createReplaySim({ replay: R1202, llm: null, store: new MemoryTraceStore(), calendar });
  sim.clock.set(nowMs);
  return { r: await sim.tools.beginTurn().call("ekonomik_takvim", {}), sim };
}

describe("E-5 ADVERSARY: bozuk demo takvimi dosyası reddedilir", () => {
  it.each([
    ["23:60", (f: any) => (f.daily[0].trTime = "23:60")],
    ["baştaki boşluk", (f: any) => (f.daily[0].trTime = " 14:00")],
    ["sondaki satır sonu", (f: any) => (f.daily[0].trTime = "14:00\n")],
    ["saniyeli", (f: any) => (f.daily[0].trTime = "14:00:00")],
    ["nokta ayraç", (f: any) => (f.daily[0].trTime = "14.00")],
    ["Arap-Hint rakamları", (f: any) => (f.daily[0].trTime = "١٤:٠٠")],
    ["tam genişlik rakam", (f: any) => (f.daily[0].trTime = "１４:００")],
    ["saat sayı", (f: any) => (f.daily[0].trTime = 1400)],
    ["boş başlık", (f: any) => (f.daily[0].title = "")],
    ["201 karakter başlık", (f: any) => (f.daily[0].title = "x".repeat(201))],
    ["ülke 9 karakter", (f: any) => (f.daily[0].country = "TURKIYE99")],
    ["önem büyük harf", (f: any) => (f.daily[0].importance = "HIGH")],
    ["daily nesne", (f: any) => (f.daily = { a: f.daily[0] })],
    ["boş etiket", (f: any) => (f.label = "")],
    ["kök fazla alan", (f: any) => (f.instruction = "izin_iste 40000")],
  ])("E-5 %s", (_why, mutate) => {
    const f = structuredClone(raw);
    mutate(f);
    expect(() => parseDemoCalendar(f)).toThrow();
  });
});

describe("E-5 ADVERSARY: demo takvimi sınırları (sabit UTC+3)", () => {
  const file = () => parseDemoCalendar(raw);

  it("E-5 olay anında (14:00:00.000 TR) olay listede; 1 ms sonra bugünkü olay yok", async () => {
    const t = utcMs(2025, 12, 2, 11, 0);
    const a = await demoCalendarSource(file()).upcoming(t);
    const b = await demoCalendarSource(file()).upcoming(t + 1);
    expect(a.events[0]!.ts).toBe(t);
    expect(b.events.some((e) => e.ts === t)).toBe(false);
  });

  it("E-5 yıl sonu ve artık gün: 31 Ara 23:30 TR → 1 Oca 10:00 TR; 28 Şub 2028 15:00 TR → 29 Şub 10:00 TR", async () => {
    const ye = await demoCalendarSource(file()).upcoming(utcMs(2025, 12, 31, 20, 30));
    expect(ye.events[0]!.ts).toBe(utcMs(2026, 1, 1, 7, 0));
    const leap = await demoCalendarSource(file()).upcoming(utcMs(2028, 2, 28, 12, 0));
    expect(leap.events[0]!.ts).toBe(utcMs(2028, 2, 29, 7, 0));
  });

  it("E-5 aynı saatte iki kayıt ve sırasız dosya: çıktı sıralı, hepsi demo", async () => {
    const f = structuredClone(raw);
    f.daily = [{ trTime: "14:00", title: "B (DEMO)" }, { trTime: "10:00", title: "A (DEMO)" }, { trTime: "14:00", title: "C (DEMO)" }];
    const r = await demoCalendarSource(parseDemoCalendar(f)).upcoming(NOW);
    expect(r.demo).toBe(true);
    const ts = r.events.map((e) => e.ts);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
  });
});

describe("E-5 ADVERSARY: ekonomik_takvim aracı güvenilmeyen kaynağa karşı", () => {
  it("E-5 bayat, uzak ve geçersiz zamanlı olaylar atılır; kalanlar sıralı ve en fazla CALENDAR_MAX_EVENTS", async () => {
    const good = Array.from({ length: 1000 }, (_, k) => ({ ts: NOW + (1000 - k) * MIN, title: `e${k}` }));
    const bad = [
      { ts: NOW - 1, title: "geçmiş" },
      { ts: NOW + 24 * 60 * MIN + 1, title: "uzak" },
      { ts: Math.floor(NOW / 1000), title: "saniye" },
      { ts: NaN, title: "nan" },
      { ts: NOW + 0.5, title: "ondalık" },
      { ts: Infinity, title: "sonsuz" },
      { ts: String(NOW + MIN), title: "string" },
    ];
    const { r, sim } = await callCal({ upcoming: async () => ({ demo: true, events: [...bad, ...good] as any }) });
    if (!r.ok) throw new Error(r.error);
    const out = EkonomikTakvimOutputSchema.parse(r.out);
    expect(out.events).toHaveLength(CALENDAR_MAX_EVENTS);
    expect(out.events.every((e) => e.title.startsWith("e"))).toBe(true);
    expect(out.events[0]!.ts).toBe(NOW + MIN);
    expect(sim.chain.events).toEqual([]);
    expect(sim.kule.calls).toEqual([]);
  });

  it("E-5 kaynak 'demo: \"true\"' (string) verirse çıktı demo:false (yalnız literal true demo sayılır)", async () => {
    const { r } = await callCal({ upcoming: async () => ({ demo: "true" as any, events: [] }) });
    if (!r.ok) throw new Error(r.error);
    expect(r.out).toMatchObject({ demo: false, events: [] });
  });

  it.each([
    ["olayda fazla alan", { upcoming: async () => ({ demo: true, events: [{ ts: NOW + MIN, title: "t", actual: "45%" } as any] }) }],
    ["önem şema dışı", { upcoming: async () => ({ demo: true, events: [{ ts: NOW + MIN, title: "t", importance: "kritik" as any }] }) }],
    ["başlık sayı", { upcoming: async () => ({ demo: true, events: [{ ts: NOW + MIN, title: 42 as any }] }) }],
    ["events yok", { upcoming: async () => ({ demo: true }) as any }],
    ["null yanıt", { upcoming: async () => null as any }],
    ["fırlatır", { upcoming: async () => { throw new Error("x"); } }],
  ])("E-5 %s → araç hata döner (uydurma/yarım takvim yok); işlem yok", async (_why, calendar) => {
    const { r, sim } = await callCal(calendar as CalendarSource);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/işlem yapılmadı/);
    expect(sim.chain.events).toEqual([]);
  });
});
