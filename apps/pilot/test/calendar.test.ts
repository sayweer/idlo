/**
 * C7 — ekonomik_takvim kaynakları (§10.2, §21 #10, E-5): etiketli demo takvimi (data/demo/calendar.json) ve
 * doğrulanmamış ATK bağdaştırıcısının taslağı. Ağ yok.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { EkonomikTakvimOutputSchema, utcMs, type Replay } from "@pilot/shared";
import {
  CalendarUnavailableError,
  atkCalendarStub,
  demoCalendarSource,
  parseDemoCalendar,
  readDemoCalendarFile,
  type DemoCalendarFile,
} from "../src/calendar/index.js";
import { createReplaySim } from "../src/loop/index.js";
import type { CalendarSource } from "../src/tools/index.js";
import { MemoryTraceStore } from "../src/trace/index.js";
import { readReplayFile } from "../src/weather/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const CAL_PATH = join(ROOT, "data/demo/calendar.json");
const MIN = 60_000;

let file: DemoCalendarFile;
let raw: any;
let R1202: Replay;
beforeAll(async () => {
  file = await readDemoCalendarFile(CAL_PATH);
  raw = JSON.parse(await readFile(CAL_PATH, "utf8"));
  R1202 = await readReplayFile(join(ROOT, "data/replays/2025-12-02.json"));
});

async function toolOut(calendar: CalendarSource, nowMs: number) {
  const sim = await createReplaySim({ replay: R1202, llm: null, store: new MemoryTraceStore(), calendar });
  sim.clock.set(nowMs);
  return { r: await sim.tools.beginTurn().call("ekonomik_takvim", {}), sim };
}

describe("E-5 demo takvimi (data/demo/calendar.json)", () => {
  it("E-5 dosya geçerli ve etiketli; her başlık DEMO", () => {
    expect(file.label).toBe("DEMO TAKVİMİ");
    for (const e of file.daily) expect(e.title).toContain("(DEMO)");
    expect(file.daily.some((e) => e.title.startsWith("TCMB faiz kararı") && e.trTime === "14:00")).toBe(true);
  });

  it("E-5 TR 13:30'da TCMB açıklaması 30 dk sonra; geçmiş tekrarlar atılır, sıralı, demo: true", async () => {
    const now = utcMs(2025, 12, 2, 10, 30); // 13:30 TR
    const r = await demoCalendarSource(file).upcoming(now);
    expect(r.demo).toBe(true);
    // 10:00 TR bugün geçti → yarın; 14:00 TR bugün ve yarın.
    expect(r.events.map((e) => [e.ts, e.title])).toEqual([
      [utcMs(2025, 12, 2, 11, 0), "TCMB faiz kararı (DEMO)"],
      [utcMs(2025, 12, 3, 7, 0), "TÜİK enflasyon verisi (DEMO)"],
      [utcMs(2025, 12, 3, 11, 0), "TCMB faiz kararı (DEMO)"],
    ]);
    expect(r.events[0]!.ts - now).toBe(30 * MIN);
    expect(r.events[0]).toMatchObject({ country: "TR", importance: "high" });
  });

  it("E-5 TR günü UTC 21:00'de değişir (sabit UTC+3, kural 8)", async () => {
    const before = await demoCalendarSource(file).upcoming(utcMs(2025, 12, 2, 20, 59));
    const after = await demoCalendarSource(file).upcoming(utcMs(2025, 12, 2, 21, 0));
    // 23:59 TR (2 Ara): sonraki TÜİK 3 Ara 10:00 TR; 00:00 TR (3 Ara): sonraki TÜİK yine 3 Ara 10:00 TR.
    expect(before.events[0]!.ts).toBe(utcMs(2025, 12, 3, 7, 0));
    expect(after.events[0]!.ts).toBe(utcMs(2025, 12, 3, 7, 0));
    // 00:00 TR'de "bugün" 3 Ara'dır: 4 Ara 14:00 TR de listede (yarın).
    expect(after.events.at(-1)!.ts).toBe(utcMs(2025, 12, 4, 11, 0));
    expect(before.events.at(-1)!.ts).toBe(utcMs(2025, 12, 3, 11, 0));
  });

  it("E-5 ekonomik_takvim aracı üzerinden: yalnız önümüzdeki 24 saat, şemaya uyar, yan etki yok", async () => {
    const now = utcMs(2025, 12, 2, 10, 30) + 5_000;
    const { r, sim } = await toolOut(demoCalendarSource(file), now);
    if (!r.ok) throw new Error(r.error);
    const out = EkonomikTakvimOutputSchema.parse(r.out);
    expect(out.demo).toBe(true);
    // Yarın 14:00 TR 24 saatin dışında.
    expect(out.events.map((e) => e.title)).toEqual(["TCMB faiz kararı (DEMO)", "TÜİK enflasyon verisi (DEMO)"]);
    for (const e of out.events) expect(e.ts - now).toBeLessThanOrEqual(24 * 60 * MIN);
    expect(sim.chain.events).toEqual([]);
    expect(sim.kule.calls).toEqual([]);
  });

  it.each([
    ["saat 24:00", (f: any) => (f.daily[0].trTime = "24:00")],
    ["tek haneli saat", (f: any) => (f.daily[0].trTime = "9:00")],
    ["bilinmeyen önem", (f: any) => (f.daily[0].importance = "kritik")],
    ["fazla alan", (f: any) => (f.daily[0].actual = "45%")],
    ["boş takvim", (f: any) => (f.daily = [])],
  ])("E-5 bozuk demo takvimi reddedilir: %s", (_why, mutate) => {
    const f = structuredClone(raw);
    mutate(f);
    expect(() => parseDemoCalendar(f)).toThrow();
  });
});

describe("E-5 ATK news_get_economic_calendar taslağı (§21 #10 [DOĞRULA])", () => {
  it("E-5 doğrulanmamış ATK kaynağı her zaman hata verir; araç hata döner, uydurma takvim yok, işlem yok", async () => {
    await expect(atkCalendarStub.upcoming(0)).rejects.toBeInstanceOf(CalendarUnavailableError);
    const { r, sim } = await toolOut(atkCalendarStub, utcMs(2025, 12, 2, 10, 30));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("Araç hata verdi; işlem yapılmadı.");
    expect(sim.chain.events).toEqual([]);
  });
});
