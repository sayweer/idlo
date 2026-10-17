import { beforeAll, describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MIN5_MS,
  WeatherError,
  computeWeather,
  fxOpen,
  runReplay,
  stepEpisode,
  utcMs,
  type Episode,
  type Metrics,
  type Replay,
  type Weather,
} from "@pilot/shared";
import { readReplayFile } from "../src/weather/index.js";

const REPLAYS = join(dirname(fileURLToPath(import.meta.url)), "../../../data/replays");
const DAYS = ["2024-08-05", "2025-03-19", "2025-10-10", "2025-12-02", "2026-02-01"] as const;
type Day = (typeof DAYS)[number];

const replays = {} as Record<Day, Replay>;
const series = {} as Record<Day, Weather[]>;

beforeAll(async () => {
  for (const d of DAYS) {
    replays[d] = await readReplayFile(join(REPLAYS, `${d}.json`));
    series[d] = runReplay(replays[d]);
  }
});

function at(day: Day, ts: number): Weather {
  const w = series[day].find((x) => x.ts === ts);
  if (!w) throw new Error(`${day}: ${new Date(ts).toISOString()} kaydı yok`);
  return w;
}
/** Günün (UTC) ilk fırtına mumu: bir önceki mum NORMAL iken açılan ilk bölüm. */
function firstStormOfDay(day: Day): Weather {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const start = utcMs(y, m, d);
  const end = start + 86_400_000;
  const w = series[day].find((x) => x.ts >= start && x.ts < end && x.episode !== null && x.episode.startTs === x.ts);
  if (!w) throw new Error(`${day}: gün içinde fırtına yok`);
  return w;
}
/** Eski kural (§11 tablosu her mumda sıfırdan): §11.2'nin düzelttiği davranış. */
function naiveClass(w: Weather): string {
  if (!w.alarm) return "NORMAL";
  if (w.r1hBp < 0) return "TL_GUCLENDI";
  if (w.btc1h <= -1.5) return "KRIPTO_SISMESI";
  if (!w.fxOpen) return "PRIM_SISMESI";
  if (w.btc1h <= -1.0 || w.btc3h <= -1.5) return "BELIRSIZ";
  return "LIRA_ZAYIFLADI";
}

describe("Lira Hava Durumu — kayıt oynatma (§11, §11.2, §18)", () => {
  it("W-1 2024-08-05 01:15 UTC → KRIPTO_SISMESI (zd ≈ 18,8, btc1h ≈ −6,45; §15 örneği)", () => {
    const ts = utcMs(2024, 8, 5, 1, 15);
    const w = at("2024-08-05", ts);
    expect(ts).toBe(1722820500000); // §15 örneğindeki ts
    expect(w.class).toBe("KRIPTO_SISMESI");
    expect(w.alarm).toBe(true);
    expect(w.zd).toBeCloseTo(18.8, 1);
    expect(w.btc1h).toBeCloseTo(-6.45, 1);
    expect(w.btc3h).toBeCloseTo(-9.07, 1);
    expect(w.r1hBp).toBeCloseTo(225.1, 1);
    expect(w.med168Bp).toBeCloseTo(12.0, 0);
    expect(w.px).toBe(34.6);
    expect(w.stormUntil).toBe(1722842100000); // §15: 07:15 UTC
    expect(w.src).toBe("replay");
    expect(firstStormOfDay("2024-08-05").ts).toBe(ts);
  });

  it("W-1 hesaplayıcı ileriye bakmaz: yalnız ts'ye kadar kapanmış mumlarla aynı sonuç", () => {
    const r = replays["2024-08-05"];
    const ts = utcMs(2024, 8, 5, 1, 15);
    const cut = <T extends { ts: number }>(xs: T[], step: number) => xs.filter((c) => c.ts + step <= ts);
    const w = computeWeather(
      null,
      { ts, usdt5m: cut(r.usdt5m, MIN5_MS), usdt1h: cut(r.usdt1h, 3_600_000), btc5m: cut(r.btc5m, MIN5_MS) },
      "replay",
    );
    const full = at("2024-08-05", ts);
    expect({ ...w, episode: null, stormUntil: null }).toEqual({ ...full, episode: null, stormUntil: null });
  });

  it("W-1 eksik mum → WeatherError (fail-closed, sınıf uydurulmaz)", () => {
    const r = replays["2024-08-05"];
    const ts = utcMs(2024, 8, 5, 1, 15);
    const gap = r.usdt5m.filter((c) => c.ts !== ts - 13 * MIN5_MS); // C_{t−12}
    expect(() => computeWeather(null, { ts, usdt5m: gap, usdt1h: r.usdt1h, btc5m: r.btc5m }, "replay")).toThrow(
      WeatherError,
    );
    const gap1h = r.usdt1h.filter((_, i) => i !== 100);
    expect(() => computeWeather(null, { ts, usdt5m: r.usdt5m, usdt1h: gap1h, btc5m: r.btc5m }, "replay")).toThrow(
      WeatherError,
    );
    expect(() => computeWeather(null, { ts: ts + 1, usdt5m: r.usdt5m, usdt1h: r.usdt1h, btc5m: r.btc5m }, "replay")).toThrow(
      WeatherError,
    );
  });

  it("W-2 2025-03-19 07:10 UTC → LIRA_ZAYIFLADI (zd ≈ 9,0, btc1h ≈ −0,08)", () => {
    const ts = utcMs(2025, 3, 19, 7, 10);
    const w = at("2025-03-19", ts);
    expect(w.class).toBe("LIRA_ZAYIFLADI");
    expect(w.zd).toBeCloseTo(9.0, 1);
    expect(w.btc1h).toBeCloseTo(-0.08, 1);
    expect(w.fxOpen).toBe(true);
    expect(firstStormOfDay("2025-03-19").ts).toBe(ts);
  });

  it("W-3 2025-12-02 → TL_GUCLENDI (günün ilk fırtınası 20:45 UTC)", () => {
    const w = firstStormOfDay("2025-12-02");
    expect(w.class).toBe("TL_GUCLENDI");
    expect(w.ts).toBe(utcMs(2025, 12, 2, 20, 45));
    expect(w.r1hBp).toBeLessThan(0);
    expect(w.alarm).toBe(true);
    expect(w.episode?.dir).toBe("down");
  });

  it("W-4 2026-02-01 11:00 UTC (pazar, FX kapalı) → PRIM_SISMESI (zd ≈ 9,4, btc1h ≈ −0,98)", () => {
    const ts = utcMs(2026, 2, 1, 11, 0);
    const w = at("2026-02-01", ts);
    expect(w.class).toBe("PRIM_SISMESI");
    expect(w.fxOpen).toBe(false);
    expect(w.zd).toBeCloseTo(9.4, 1);
    expect(w.btc1h).toBeCloseTo(-0.98, 1);
    expect(firstStormOfDay("2026-02-01").ts).toBe(ts);
  });

  it("W-5 2024-08-05 01:40, 01:50, 02:15 UTC → hâlâ KRIPTO_SISMESI (P0 = 33,83)", () => {
    const cases = [
      { h: 1, m: 40, px: 34.09, old: "NORMAL" },
      { h: 1, m: 50, px: 33.97, old: "NORMAL" },
      { h: 2, m: 15, px: 34.18, old: "TL_GUCLENDI" },
    ];
    for (const c of cases) {
      const w = at("2024-08-05", utcMs(2024, 8, 5, c.h, c.m));
      expect(w.class).toBe("KRIPTO_SISMESI");
      expect(w.episode?.P0).toBe(33.83);
      expect(w.episode?.startTs).toBe(utcMs(2024, 8, 5, 1, 15));
      expect(w.px).toBe(c.px);
      expect(naiveClass(w)).toBe(c.old); // eski kuralın yanlışı (§11.2 "Sorun")
    }
    // 01:15–02:15 arası her mumda sınıf değişmez
    const from = utcMs(2024, 8, 5, 1, 15);
    const to = utcMs(2024, 8, 5, 2, 15);
    const span = series["2024-08-05"].filter((w) => w.ts >= from && w.ts <= to);
    expect(span).toHaveLength(13);
    expect(new Set(span.map((w) => w.class))).toEqual(new Set(["KRIPTO_SISMESI"]));
  });

  it("W-6 2025-03-19 08:40 ve 09:45 UTC → hâlâ LIRA_ZAYIFLADI", () => {
    for (const [h, m] of [
      [8, 40],
      [9, 45],
    ] as const) {
      const w = at("2025-03-19", utcMs(2025, 3, 19, h, m));
      expect(w.class).toBe("LIRA_ZAYIFLADI");
      expect(naiveClass(w)).toBe("TL_GUCLENDI"); // eski kural "şimdi al / TL güçlendi" derdi
      expect(w.px).toBeGreaterThan(w.episode!.P0); // P0 altına inmedi → TL_GUCLENDI geçersiz
      expect(w.episode?.startTs).toBe(utcMs(2025, 3, 19, 7, 10));
    }
  });

  it("W-7 2025-10-10 16:05 UTC BELIRSIZ → 21:00 UTC KRIPTO_SISMESI (yükselme; 21:20 zd ≈ 43,7, btc1h ≈ −11,96)", () => {
    const s = series["2025-10-10"];
    const t0 = utcMs(2025, 10, 10, 16, 5);
    const tEsc = utcMs(2025, 10, 10, 21, 0);
    const w0 = at("2025-10-10", t0);
    expect(w0.class).toBe("BELIRSIZ");
    expect(w0.btc1h).toBeCloseTo(-1.02, 1);
    expect(firstStormOfDay("2025-10-10").ts).toBe(t0);
    // 16:05–20:55 hep BELIRSIZ; ilk KRIPTO 21:00'de
    expect(s.filter((w) => w.ts >= t0 && w.ts < tEsc).every((w) => w.class === "BELIRSIZ")).toBe(true);
    const wEsc = at("2025-10-10", tEsc);
    expect(wEsc.class).toBe("KRIPTO_SISMESI");
    expect(wEsc.episode?.startTs).toBe(t0); // aynı bölüm, yeni bölüm değil
    const w20 = at("2025-10-10", utcMs(2025, 10, 10, 21, 20));
    expect(w20.class).toBe("KRIPTO_SISMESI");
    expect(w20.zd).toBeCloseTo(43.7, 1);
    expect(w20.btc1h).toBeCloseTo(-11.96, 1);
    // Ters yönde düşüş yok: bölüm sürdükçe KRIPTO kalır
    const sameEpisode = s.filter((w) => w.ts >= tEsc && w.episode?.startTs === t0);
    expect(sameEpisode.length).toBeGreaterThan(1);
    expect(sameEpisode.every((w) => w.class === "KRIPTO_SISMESI")).toBe(true);
  });

  it("W-8 bölüm lastAlarmTs + 6 sa'te kapanır ve sınıf NORMAL olur (2024-08-05: son alarm 14:50 → 20:50)", () => {
    const lastAlarm = utcMs(2024, 8, 5, 14, 50);
    const before = at("2024-08-05", utcMs(2024, 8, 5, 20, 45));
    expect(before.class).toBe("KRIPTO_SISMESI");
    expect(before.alarm).toBe(false);
    expect(before.episode?.lastAlarmTs).toBe(lastAlarm);
    expect(before.stormUntil).toBe(lastAlarm + 6 * 3_600_000);
    const after = at("2024-08-05", utcMs(2024, 8, 5, 20, 50));
    expect(after.class).toBe("NORMAL");
    expect(after.episode).toBeNull();
    expect(after.stormUntil).toBeNull();
    // aşağı bölüm de aynı kuralla kapanır (2026-02-01: son alarm 12:00 → 18:00)
    expect(at("2026-02-01", utcMs(2026, 2, 1, 17, 55)).class).toBe("TL_GUCLENDI");
    expect(at("2026-02-01", utcMs(2026, 2, 1, 18, 0)).class).toBe("NORMAL");
  });

  it("W-8 yukarı bölümde fiyat P0 altına inerse TL_GUCLENDI bölümü açılır (2026-02-01 12:00 UTC)", () => {
    const prev = at("2026-02-01", utcMs(2026, 2, 1, 11, 55));
    expect(prev.class).toBe("PRIM_SISMESI");
    const ts = utcMs(2026, 2, 1, 12, 0);
    const w = at("2026-02-01", ts);
    expect(w.class).toBe("TL_GUCLENDI");
    expect(w.px).toBeLessThan(prev.episode!.P0);
    expect(w.episode).toMatchObject({ type: "TL_GUCLENDI", dir: "down", startTs: ts, lastAlarmTs: ts });
    expect(w.episode!.P0).not.toBe(prev.episode!.P0); // yeni bölümün P0'ı = C_{t−12}
  });
});

describe("Lira Hava Durumu — bölüm kuralı birim testleri (§11.2)", () => {
  const T = utcMs(2025, 1, 6, 12, 0); // pazartesi, FX açık
  const base: Metrics = {
    ts: T,
    px: 40,
    p12: 39.5,
    r1hBp: 100,
    med168Bp: 5,
    zd: 20,
    alarm: true,
    btc1h: 0,
    btc3h: 0,
    fxOpen: true,
  };
  const m = (o: Partial<Metrics>): Metrics => ({ ...base, ...o });
  const up: Episode = { type: "LIRA_ZAYIFLADI", dir: "up", P0: 39.5, startTs: T, lastAlarmTs: T, endsAt: T + 6 * 3_600_000 };

  it("W-8 alarmsız mumda bölüm uzamaz; endsAt'te kapanır, ondan bir mum önce sürer", () => {
    const calm = { alarm: false, zd: 1, r1hBp: 5 };
    expect(stepEpisode(up, m({ ...calm, ts: up.endsAt - MIN5_MS }))).toEqual(up);
    expect(stepEpisode(up, m({ ...calm, ts: up.endsAt }))).toBeNull();
  });

  it("W-8 yukarı bölümde r1h < 0 alarmı P0 üstündeyse sınıf değişmez, yalnız süre uzar", () => {
    const ts = T + 3_600_000;
    const e = stepEpisode(up, m({ ts, px: 39.6, r1hBp: -80 }));
    expect(e).toEqual({ ...up, lastAlarmTs: ts, endsAt: ts + 6 * 3_600_000 });
  });

  it("W-8 yukarı bölümde alarmsız P0 altı mum bölüm açmaz (TODO(spec) dar okuma)", () => {
    const e = stepEpisode(up, m({ ts: T + 3_600_000, px: 39.4, r1hBp: -10, alarm: false, zd: 2 }));
    expect(e?.type).toBe("LIRA_ZAYIFLADI");
  });

  it("W-8 yukarı bölümde r1h < 0 alarmı P0 altındaysa yeni TL_GUCLENDI bölümü (P0 = C_{t−12})", () => {
    const ts = T + 3_600_000;
    const e = stepEpisode(up, m({ ts, px: 39.4, p12: 40.1, r1hBp: -170 }));
    expect(e).toEqual({ type: "TL_GUCLENDI", dir: "down", P0: 40.1, startTs: ts, lastAlarmTs: ts, endsAt: ts + 6 * 3_600_000 });
  });

  it("W-7 yükselme serbest, düşüş yok: btc1h ≤ −1,5 → KRIPTO; sonra BTC sakinleşse de KRIPTO kalır", () => {
    const e1 = stepEpisode(up, m({ ts: T + MIN5_MS, alarm: false, zd: 3, btc1h: -1.6 }));
    expect(e1?.type).toBe("KRIPTO_SISMESI");
    const e2 = stepEpisode(e1, m({ ts: T + 2 * MIN5_MS, btc1h: 0.5 }));
    expect(e2?.type).toBe("KRIPTO_SISMESI");
    const bel: Episode = { ...up, type: "BELIRSIZ" };
    expect(stepEpisode(bel, m({ ts: T + MIN5_MS, btc1h: 0.5 }))?.type).toBe("BELIRSIZ"); // BELIRSIZ → LIRA yok
  });

  it("W-8 aşağı bölümde yükseliş 'toparlanıyor': P0 altında r1h > 0 alarmı sınıfı değiştirmez", () => {
    const down: Episode = { ...up, type: "TL_GUCLENDI", dir: "down", P0: 40 };
    const ts = T + MIN5_MS;
    expect(stepEpisode(down, m({ ts, px: 39.9 }))).toEqual({ ...down, lastAlarmTs: ts, endsAt: ts + 6 * 3_600_000 });
  });
});

describe("fxOpen — America/New_York, yaz saati (§11, §11.2-3)", () => {
  it("W-4 EDT (yaz saati, UTC−4): cuma 2025-10-10 20:55 UTC açık, 21:00 UTC (17:00 NY) kapalı", () => {
    expect(fxOpen(utcMs(2025, 10, 10, 20, 55))).toBe(true);
    expect(fxOpen(utcMs(2025, 10, 10, 21, 0))).toBe(false);
  });
  it("W-4 EDT: pazar 2025-10-12 21:55 UTC kapalı, 22:00 UTC (18:00 NY) açık", () => {
    expect(fxOpen(utcMs(2025, 10, 12, 21, 55))).toBe(false);
    expect(fxOpen(utcMs(2025, 10, 12, 22, 0))).toBe(true);
  });
  it("W-4 EST (kış saati, UTC−5): cuma 2026-01-30 21:55 UTC açık, 22:00 UTC (17:00 NY) kapalı", () => {
    expect(fxOpen(utcMs(2026, 1, 30, 21, 55))).toBe(true);
    expect(fxOpen(utcMs(2026, 1, 30, 22, 0))).toBe(false);
  });
  it("W-4 EST: pazar 2026-02-01 22:55 UTC kapalı, 23:00 UTC (18:00 NY) açık; cumartesi hep kapalı", () => {
    expect(fxOpen(utcMs(2026, 2, 1, 22, 55))).toBe(false);
    expect(fxOpen(utcMs(2026, 2, 1, 23, 0))).toBe(true);
    expect(fxOpen(utcMs(2026, 1, 31, 12, 0))).toBe(false);
  });
  it("W-4 yaz saatine geçiş günü (pazar 2026-03-08): 18:00 EDT = 22:00 UTC (sabit −5 olsaydı 23:00)", () => {
    expect(fxOpen(utcMs(2026, 3, 8, 21, 55))).toBe(false);
    expect(fxOpen(utcMs(2026, 3, 8, 22, 0))).toBe(true);
  });
  it("W-4 kış saatine dönüş günü (pazar 2025-11-02): 18:00 EST = 23:00 UTC (sabit −4 olsaydı 22:00)", () => {
    expect(fxOpen(utcMs(2025, 11, 2, 22, 55))).toBe(false);
    expect(fxOpen(utcMs(2025, 11, 2, 23, 0))).toBe(true);
  });
});
