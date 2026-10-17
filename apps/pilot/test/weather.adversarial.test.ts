/**
 * Lira Hava Durumu — saldırgan (adversarial) testler (SPEC §11, §11.2, §16-25, §18 W-1…W-8).
 * Amaç: bölüm kuralını, veri bütünlüğünü, fail-closed davranışını ve fxOpen takvimini kırmaya çalışmak.
 * Gerçek kayıt dosyaları (data/replays) ve sentetik mumlar kullanılır; zamanlar UTC ve tam dakika (§11.2).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EPISODE_DURATION_MS, EpisodeSchema, type Episode, type Weather } from "@pilot/shared";
import {
  HOUR_MS,
  MIN5_MS,
  WeatherError,
  candleFromOkx,
  classifyAlarm,
  computeMetrics,
  computeWeather,
  fxOpen,
  parseReplay,
  readReplayFile,
  runReplay,
  stepEpisode,
  utcMs,
  type Candle,
  type MarketInput,
  type Metrics,
  type Replay,
} from "../src/weather/index.js";

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

const at = (day: Day, ts: number): Weather => {
  const w = series[day].find((x) => x.ts === ts);
  if (!w) throw new Error(`${day}: ${new Date(ts).toISOString()} yok`);
  return w;
};
const market = (r: Replay, ts: number): MarketInput => ({ ts, usdt5m: r.usdt5m, usdt1h: r.usdt1h, btc5m: r.btc5m });

// ───────────────────────── Sentetik veri ─────────────────────────
const E6 = 1_000_000;
const flat = (ts: number, px: number): Candle => {
  const p = Math.round(px * E6);
  return { ts, o: p, h: p, l: p, c: p };
};
/**
 * ts kapanışı için en dar geçerli girdi: USDT 5 dk (13 mum), BTC 5 dk (37 mum), USDT 1 sa (169 mum, aralık 50 bp).
 * c0/c12: C_t / C_{t−12}; b0/b12/b36: B_t / B_{t−12} / B_{t−36}.
 */
function synth(
  ts: number,
  o: { c0?: number; c12?: number; b0?: number; b12?: number; b36?: number } = {},
): { usdt5m: Candle[]; usdt1h: Candle[]; btc5m: Candle[] } {
  const { c0 = 40, c12 = 40, b0 = 60000, b12 = 60000, b36 = 60000 } = o;
  const usdt5m: Candle[] = [];
  for (let k = 12; k >= 0; k--) usdt5m.push(flat(ts - (k + 1) * MIN5_MS, k === 0 ? c0 : k === 12 ? c12 : c12));
  const btc5m: Candle[] = [];
  for (let k = 36; k >= 0; k--) btc5m.push(flat(ts - (k + 1) * MIN5_MS, k === 0 ? b0 : k === 12 ? b12 : k === 36 ? b36 : b12));
  const lastOpen = Math.floor(ts / HOUR_MS) * HOUR_MS - HOUR_MS;
  const usdt1h: Candle[] = [];
  for (let i = 168; i >= 0; i--) usdt1h.push({ ts: lastOpen - i * HOUR_MS, o: 40 * E6, h: 40.1 * E6, l: 39.9 * E6, c: 40 * E6 });
  return { usdt5m, usdt1h, btc5m };
}

const T = utcMs(2025, 1, 6, 12, 0); // pazartesi, FX açık
const base: Metrics = { ts: T, px: 40, p12: 39.5, r1hBp: 100, med168Bp: 5, zd: 20, alarm: true, btc1h: 0, btc3h: 0, fxOpen: true };
const m = (o: Partial<Metrics>): Metrics => ({ ...base, ...o });
const calm = { alarm: false, zd: 1, r1hBp: 5 } as const;
const ep = (o: Partial<Episode> = {}): Episode => {
  const e = { type: "LIRA_ZAYIFLADI", dir: "up", P0: 39.5, startTs: T, lastAlarmTs: T, ...o } as Episode;
  return { ...e, endsAt: o.endsAt ?? e.lastAlarmTs + EPISODE_DURATION_MS };
};

// ───────────────────────── Bağımsız referans (§11 formülleri) ─────────────────────────
function reference(r: Replay, ts: number) {
  const m5 = new Map(r.usdt5m.map((c) => [c.ts, c]));
  const b5 = new Map(r.btc5m.map((c) => [c.ts, c]));
  const h1 = new Map(r.usdt1h.map((c) => [c.ts, c]));
  const C = (k: number) => m5.get(ts - (k + 1) * MIN5_MS)!.c;
  const B = (k: number) => b5.get(ts - (k + 1) * MIN5_MS)!.c;
  const ranges: number[] = [];
  // kapanışı ≤ ts olan son 168 saat
  let close = ts - (ts % HOUR_MS);
  for (let i = 0; i < 168; i++, close -= HOUR_MS) {
    const c = h1.get(close - HOUR_MS)!;
    ranges.push(((c.h - c.l) / c.o) * 1e4);
  }
  ranges.sort((a, b) => a - b);
  const med = (ranges[83]! + ranges[84]!) / 2;
  const r1h = Math.log(C(0) / C(12)) * 1e4;
  return {
    r1h,
    med,
    zd: Math.abs(r1h) / Math.max(1, med),
    btc1h: Math.log(B(0) / B(12)) * 100,
    btc3h: Math.log(B(0) / B(36)) * 100,
    p12: C(12) / E6,
  };
}

/** §11 tablosu, kodun sırasından bağımsız yazıldı (satır koşulları açıkça). */
function tableClass(w: Pick<Weather, "r1hBp" | "btc1h" | "btc3h" | "fxOpen">): string {
  if (w.r1hBp < 0) return "TL_GUCLENDI";
  if (w.btc1h <= -1.5) return "KRIPTO_SISMESI";
  if (!w.fxOpen) return "PRIM_SISMESI";
  if ((w.btc1h > -1.5 && w.btc1h <= -1.0) || w.btc3h <= -1.5) return "BELIRSIZ";
  return "LIRA_ZAYIFLADI";
}

// ════════════════════════════════════════════════════════════════════════════════════
describe("Adversarial — §11 ölçümleri gerçek veride bağımsız hesapla aynı (W-1)", () => {
  it("W-1 her kayıtta her mumda r1h, med168, zd, btc1h, btc3h bağımsız referansla eşleşir", () => {
    for (const d of DAYS) {
      for (const w of series[d]) {
        const ref = reference(replays[d], w.ts);
        expect(w.r1hBp).toBeCloseTo(ref.r1h, 9);
        expect(w.med168Bp).toBeCloseTo(ref.med, 9);
        expect(w.zd).toBeCloseTo(ref.zd, 9);
        expect(w.alarm).toBe(ref.zd >= 8);
        expect(w.btc1h).toBeCloseTo(ref.btc1h, 9);
        expect(w.btc3h).toBeCloseTo(ref.btc3h, 9);
      }
    }
  });

  it("W-1 med168 < 1 bp iken payda 1'dir (max(1, med168))", () => {
    const s = synth(T, { c0: 40.4, c12: 40 });
    const flat1h = s.usdt1h.map((c) => ({ ...c, h: c.o, l: c.o }));
    const mt = computeMetrics({ ts: T, usdt5m: s.usdt5m, usdt1h: flat1h, btc5m: s.btc5m });
    expect(mt.med168Bp).toBe(0);
    expect(mt.zd).toBeCloseTo(Math.abs(mt.r1hBp), 12);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════
describe("Adversarial — bölüm kuralı değişmezleri, tüm kayıtlarda her mum (§11.2, W-5…W-8)", () => {
  it("W-5 bölüm sürerken sınıf NORMAL'e dönmez; TL_GUCLENDI yalnız alarm + P0 altı ile; yukarı sınıf yalnız KRIPTO'ya yükselir", () => {
    let checked = 0;
    for (const d of DAYS) {
      const s = series[d];
      for (let i = 1; i < s.length; i++) {
        const prev = s[i - 1]!;
        const w = s[i]!;
        const pe = prev.episode;
        const open = pe !== null && w.ts < pe.endsAt;
        if (!open) {
          // bölüm yok/kapandı: tablo yalnız ilk alarm için (§11)
          if (!w.alarm) {
            expect(w.class, `${d} ${new Date(w.ts).toISOString()}`).toBe("NORMAL");
          } else {
            expect(w.episode!.startTs).toBe(w.ts);
            expect(w.class).toBe(tableClass(w));
            expect(w.episode!.P0).toBe(reference(replays[d], w.ts).p12); // §11.2-1: P0 = C_{t−12}
          }
          continue;
        }
        checked++;
        const ctx = `${d} ${new Date(w.ts).toISOString()}`;
        expect(w.class, ctx).not.toBe("NORMAL"); // §11.2-2
        const e = w.episode!;
        if (e.startTs !== pe.startTs) {
          // yeni bölüm yalnız yön değişiminde ve yalnız P0 çizgisi geçilince
          expect(w.alarm, ctx).toBe(true);
          expect(e.dir, ctx).not.toBe(pe.dir);
          if (pe.dir === "up") {
            expect(e.type, ctx).toBe("TL_GUCLENDI");
            expect(w.px, ctx).toBeLessThan(pe.P0); // §11.2-3
          } else {
            expect(w.px, ctx).toBeGreaterThan(pe.P0); // §11.2-4: P0 altında yükseliş "toparlanıyor"
          }
          expect(e.P0).toBe(reference(replays[d], w.ts).p12);
        } else {
          expect(e.P0, ctx).toBe(pe.P0);
          expect(e.dir, ctx).toBe(pe.dir);
          if (e.type !== pe.type) {
            // yükselme serbest, düşüş yok (§11.2-3)
            expect(pe.dir, ctx).toBe("up");
            expect(e.type, ctx).toBe("KRIPTO_SISMESI");
            expect(w.btc1h, ctx).toBeLessThanOrEqual(-1.5);
          }
          if (pe.type === "KRIPTO_SISMESI") expect(e.type, ctx).toBe("KRIPTO_SISMESI");
          // §11.2-2: her alarm lastAlarmTs'i günceller; alarmsız mum güncellemez
          expect(e.lastAlarmTs, ctx).toBe(w.alarm ? w.ts : pe.lastAlarmTs);
          expect(e.endsAt, ctx).toBe(e.lastAlarmTs + EPISODE_DURATION_MS);
        }
      }
    }
    expect(checked).toBeGreaterThan(200); // gerçekten fırtına içinde mum denetlendi
  });

  it("W-8 bölüm tam lastAlarmTs + 6 sa'te kapanır: önceki mum fırtına, endsAt mumu (alarmsızsa) NORMAL", () => {
    let closes = 0;
    for (const d of DAYS) {
      const s = series[d];
      for (let i = 1; i < s.length; i++) {
        const pe = s[i - 1]!.episode;
        const w = s[i]!;
        if (pe !== null && w.ts === pe.endsAt && !w.alarm) {
          expect(w.class).toBe("NORMAL");
          closes++;
        }
        if (pe !== null && w.class === "NORMAL") expect(w.ts).toBeGreaterThanOrEqual(pe.endsAt);
      }
    }
    expect(closes).toBeGreaterThanOrEqual(4);
  });

  it("W-5 aynı mumu iki kez işlemek (yeniden deneme) sonucu değiştirmez — tüm kayıtlar", () => {
    for (const d of DAYS) {
      const r = replays[d];
      let episode: Episode | null = null;
      for (const w of series[d]) {
        const once = computeWeather(episode, market(r, w.ts), "replay");
        const twice = computeWeather(once.episode, market(r, w.ts), "replay");
        expect(twice).toEqual(once);
        expect(once).toEqual(w);
        episode = once.episode;
      }
    }
  });

  it("W-5 yeniden başlatma: diskte saklanan bölüm (JSON + EpisodeSchema) ile devam eden seri kesintisiz seriyle aynı", () => {
    const r = replays["2024-08-05"];
    const cut = utcMs(2024, 8, 5, 1, 35); // fırtına ortası
    const before = series["2024-08-05"].find((w) => w.ts === cut)!;
    const saved = EpisodeSchema.parse(JSON.parse(JSON.stringify(before.episode)));
    let episode: Episode | null = saved;
    for (let ts = cut + MIN5_MS; ts <= utcMs(2024, 8, 5, 21, 0); ts += MIN5_MS) {
      const w = computeWeather(episode, market(r, ts), "replay");
      expect(w).toEqual(at("2024-08-05", ts));
      episode = w.episode;
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════
describe("Adversarial — bölüm kuralı sınırları (stepEpisode, §11.2)", () => {
  it("W-8 fiyat tam P0'a eşitken r1h < 0 alarmı TL_GUCLENDI açmaz ('P0'ın altına' kesin eşitsizlik)", () => {
    const up = ep();
    const e = stepEpisode(up, m({ ts: T + HOUR_MS, px: 39.5, r1hBp: -120 }));
    expect(e).toEqual({ ...up, lastAlarmTs: T + HOUR_MS, endsAt: T + HOUR_MS + EPISODE_DURATION_MS });
  });

  it("W-8 fiyat P0'ın 1 kuruş altında r1h < 0 alarmı TL_GUCLENDI bölümü açar", () => {
    const e = stepEpisode(ep(), m({ ts: T + HOUR_MS, px: 39.49, p12: 40.2, r1hBp: -120 }));
    expect(e?.type).toBe("TL_GUCLENDI");
    expect(e?.dir).toBe("down");
  });

  it("W-8 aşağı bölümde fiyat tam P0'dayken r1h > 0 alarmı sınıfı değiştirmez, süreyi uzatır", () => {
    const down = ep({ type: "TL_GUCLENDI", dir: "down", P0: 40 });
    const ts = T + HOUR_MS;
    expect(stepEpisode(down, m({ ts, px: 40, r1hBp: 150 }))).toEqual({ ...down, lastAlarmTs: ts, endsAt: ts + EPISODE_DURATION_MS });
  });

  it("W-8 aşağı bölümde BTC çöküşü (btc1h ≤ −1,5) sınıfı KRIPTO'ya çevirmez (yükselme yalnız yukarı bölümde)", () => {
    const down = ep({ type: "TL_GUCLENDI", dir: "down", P0: 40 });
    expect(stepEpisode(down, m({ ts: T + MIN5_MS, ...calm, px: 39, btc1h: -5 }))?.type).toBe("TL_GUCLENDI");
    expect(stepEpisode(down, m({ ts: T + MIN5_MS, px: 39, r1hBp: -200, btc1h: -5 }))?.type).toBe("TL_GUCLENDI");
  });

  it("W-8 yeni alarm süreyi uzatır: endsAt'ten bir mum önceki alarm bölümü 6 sa daha açık tutar", () => {
    const up = ep();
    const tLast = up.endsAt - MIN5_MS;
    const e1 = stepEpisode(up, m({ ts: tLast, r1hBp: 90 }));
    expect(e1).toEqual({ ...up, lastAlarmTs: tLast, endsAt: tLast + EPISODE_DURATION_MS });
    const e2 = stepEpisode(e1, m({ ts: up.endsAt, ...calm }));
    expect(e2?.type).toBe("LIRA_ZAYIFLADI");
    expect(stepEpisode(e2, m({ ts: tLast + EPISODE_DURATION_MS - MIN5_MS, ...calm }))?.type).toBe("LIRA_ZAYIFLADI");
    expect(stepEpisode(e2, m({ ts: tLast + EPISODE_DURATION_MS, ...calm }))).toBeNull();
  });

  it("W-8 endsAt anında bölüm kapanmış sayılır; aynı mumdaki alarm §11 tablosuyla yeni bölüm açar (TODO(spec) sınır)", () => {
    const up = ep({ type: "KRIPTO_SISMESI" });
    // P0 üstünde r1h < 0 alarmı: bölüm açık olsaydı KRIPTO kalırdı; endsAt'te tablo TL_GUCLENDI der.
    const e = stepEpisode(up, m({ ts: up.endsAt, px: 41, p12: 41.5, r1hBp: -120 }));
    expect(e).toMatchObject({ type: "TL_GUCLENDI", startTs: up.endsAt, P0: 41.5 });
  });

  it("W-7 yükselme alarmsız mumda süreyi uzatmaz; PRIM_SISMESI ve BELIRSIZ de KRIPTO'ya yükselir", () => {
    for (const type of ["PRIM_SISMESI", "BELIRSIZ", "LIRA_ZAYIFLADI"] as const) {
      const up = ep({ type });
      const e = stepEpisode(up, m({ ts: T + MIN5_MS, ...calm, btc1h: -1.5 }));
      expect(e).toEqual({ ...up, type: "KRIPTO_SISMESI" }); // lastAlarmTs/endsAt değişmez
    }
  });

  it("W-7 eşik: btc1h = −1,5 yükseltir, −1,4999 yükseltmez", () => {
    expect(stepEpisode(ep(), m({ ts: T + MIN5_MS, ...calm, btc1h: -1.5 }))?.type).toBe("KRIPTO_SISMESI");
    expect(stepEpisode(ep(), m({ ts: T + MIN5_MS, ...calm, btc1h: -1.4999 }))?.type).toBe("LIRA_ZAYIFLADI");
  });

  it("W-7 ters yönde düşüş yok: KRIPTO bölümünde BTC sakin, FX kapalı ya da BELIRSIZ koşullu alarm sınıfı değiştirmez", () => {
    const kr = ep({ type: "KRIPTO_SISMESI" });
    const ts = T + MIN5_MS;
    for (const o of [{ btc1h: 0.3 }, { btc1h: 0, fxOpen: false }, { btc1h: -1.2 }, { btc3h: -3 }]) {
      expect(stepEpisode(kr, m({ ts, ...o }))?.type).toBe("KRIPTO_SISMESI");
    }
    // LIRA bölümünde FX kapanınca PRIM'e geçiş yok (yalnız KRIPTO'ya yükselme tanımlı)
    expect(stepEpisode(ep(), m({ ts, fxOpen: false }))?.type).toBe("LIRA_ZAYIFLADI");
  });

  it("W-8 zaman geri gidemez: ts < lastAlarmTs → WeatherError", () => {
    const up = ep({ lastAlarmTs: T + HOUR_MS });
    expect(() => stepEpisode(up, m({ ts: T + HOUR_MS - MIN5_MS, ...calm }))).toThrow(WeatherError);
  });

  it("W-8 bozuk saklanmış bölüm (tür/yön uyumsuz ya da endsAt uzatılmış) → WeatherError (fail-closed)", () => {
    const ts = utcMs(2024, 8, 5, 2, 15);
    const r = replays["2024-08-05"];
    const good = at("2024-08-05", ts - MIN5_MS).episode!;
    expect(() => computeWeather({ ...good, dir: "down" }, market(r, ts), "replay")).toThrow(WeatherError);
    const long = { ...good, endsAt: good.lastAlarmTs + 12 * HOUR_MS };
    expect(() => computeWeather(long, market(r, good.lastAlarmTs + 7 * HOUR_MS), "replay")).toThrow(WeatherError);
  });

  it("W-5 bozuk saklanmış bölüm (endsAt kısaltılmış) fırtınayı sessizce kapatmaz → WeatherError (fail-closed)", () => {
    // 2024-08-05 02:15: gerçek bölüm KRIPTO (P0 33,83, px 34,18). endsAt = lastAlarmTs + 30 dk olan bozuk bölümle
    // hesaplayıcı bölümü kapalı sayar ve 02:15 alarmını §11 tablosuyla TL_GUCLENDI ("şimdi çevir") sınıflar.
    const ts = utcMs(2024, 8, 5, 2, 15);
    const good = at("2024-08-05", ts - MIN5_MS).episode!;
    const short = { ...good, endsAt: good.lastAlarmTs + 30 * 60_000 };
    expect(() => computeWeather(short, market(replays["2024-08-05"], ts), "replay")).toThrow(WeatherError);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════
describe("Adversarial — eksik / boşluklu / tekrarlı / sırasız mum (W-1 fail-closed)", () => {
  const ts = utcMs(2024, 8, 5, 1, 15);

  it("W-1 kullanılan her mum (C_t, C_{t−12}, B_t, B_{t−12}, B_{t−36}) eksikse WeatherError", () => {
    const r = replays["2024-08-05"];
    const drop = (xs: Candle[], k: number) => xs.filter((c) => c.ts !== ts - (k + 1) * MIN5_MS);
    for (const k of [0, 12]) {
      expect(() => computeWeather(null, { ...market(r, ts), usdt5m: drop(r.usdt5m, k) }, "replay")).toThrow(WeatherError);
    }
    for (const k of [0, 12, 36]) {
      expect(() => computeWeather(null, { ...market(r, ts), btc5m: drop(r.btc5m, k) }, "replay")).toThrow(WeatherError);
    }
  });

  it("W-1 med168 penceresinin ilk, son ve ortadaki saati eksikse WeatherError; 168 saatten azsa WeatherError", () => {
    const r = replays["2024-08-05"];
    const lastOpen = Math.floor(ts / HOUR_MS) * HOUR_MS - HOUR_MS;
    for (const h of [0, 84, 167]) {
      const usdt1h = r.usdt1h.filter((c) => c.ts !== lastOpen - h * HOUR_MS);
      expect(() => computeWeather(null, { ...market(r, ts), usdt1h }, "replay")).toThrow(WeatherError);
    }
    const short = r.usdt1h.filter((c) => c.ts > lastOpen - 167 * HOUR_MS && c.ts <= lastOpen);
    expect(short).toHaveLength(167);
    expect(() => computeWeather(null, { ...market(r, ts), usdt1h: short }, "replay")).toThrow(WeatherError);
  });

  it("W-1 kayıt oynatmada sim penceresinin ortasında tek 5 dk mum eksikse runReplay WeatherError (sınıf uydurmaz)", () => {
    const r = replays["2025-03-19"];
    const hole = utcMs(2025, 3, 19, 8, 0);
    const bad: Replay = { ...r, usdt5m: r.usdt5m.filter((c) => c.ts !== hole) };
    expect(() => runReplay(bad)).toThrow(WeatherError);
  });

  it("W-1 kayıt dosyasında tekrarlı ya da sırasız satır → WeatherError", () => {
    const raw = JSON.parse(readFileSync(join(REPLAYS, "2024-08-05.json"), "utf8"));
    const dup = structuredClone(raw);
    const rows = dup.candles["USDT-TRY"]["5m"];
    rows.splice(500, 0, [rows[500][0], "99", "99", "99", "99"]);
    expect(() => parseReplay(dup)).toThrow(WeatherError);
    const swap = structuredClone(raw);
    const b = swap.candles["BTC-USDT"]["5m"];
    [b[10], b[11]] = [b[11], b[10]];
    expect(() => parseReplay(swap)).toThrow(WeatherError);
  });

  it("W-1 doğrudan verilen girdide çelişkili tekrar mum (aynı ts, farklı kapanış) → WeatherError", () => {
    const s = synth(T, { c0: 40.4, c12: 40 });
    const evil = flat(T - MIN5_MS, 45); // C_t için ikinci, çelişkili mum
    const usdt5m = [...s.usdt5m.slice(0, -1), evil, s.usdt5m.at(-1)!].sort((a, b) => a.ts - b.ts);
    expect(() => computeWeather(null, { ts: T, ...s, usdt5m }, "live")).toThrow(WeatherError);
  });

  it("W-1 doğrudan verilen girdide sırasız mumlar: ya WeatherError ya da sıralı girdiyle birebir aynı sonuç", () => {
    const r = replays["2024-08-05"];
    const ok = computeWeather(null, market(r, ts), "replay");
    const rev = <T>(xs: readonly T[]) => [...xs].reverse();
    for (const variant of [
      { usdt5m: rev(r.usdt5m) },
      { btc5m: rev(r.btc5m) },
      { usdt1h: rev(r.usdt1h) },
    ]) {
      let w: Weather | undefined;
      try {
        w = computeWeather(null, { ...market(r, ts), ...variant }, "replay");
      } catch (e) {
        expect(e).toBeInstanceOf(WeatherError);
        continue;
      }
      expect(w).toEqual(ok);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════
describe("Adversarial — NaN / sıfır / negatif / bozuk fiyat (W-1 fail-closed)", () => {
  it("W-1 OKX satırında 0, negatif, NaN, boş, üstel, h < l → hata (candleFromOkx)", () => {
    const ok = ["1722820200000", "34.5", "34.7", "34.4", "34.6"];
    expect(candleFromOkx(ok).c).toBe(34_600_000);
    for (const bad of [
      ["1722820200000", "0", "34.7", "34.4", "34.6"],
      ["1722820200000", "34.5", "34.7", "34.4", "0"],
      ["1722820200000", "-34.5", "34.7", "34.4", "34.6"],
      ["1722820200000", "NaN", "34.7", "34.4", "34.6"],
      ["1722820200000", "34.5", "34.7", "34.4", ""],
      ["1722820200000", "3.45e1", "34.7", "34.4", "34.6"],
      ["1722820200000", "34.5", "34.3", "34.4", "34.35"], // h < l
      ["1722820200000", "34.5", "34.7", "34.4", "34.8"], // c > h
      ["abc", "34.5", "34.7", "34.4", "34.6"],
      ["1722820200000", "34.5", "34.7", "34.4"],
    ]) {
      expect(() => candleFromOkx(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it("W-1 doğrudan verilen USDT 5 dk mumda NaN / 0 / negatif kapanış → hata (Weather üretilmez)", () => {
    for (const bad of [Number.NaN, 0, -40 * E6, Number.POSITIVE_INFINITY]) {
      const s = synth(T, { c0: 40.4 });
      s.usdt5m[s.usdt5m.length - 1] = { ...s.usdt5m.at(-1)!, c: bad };
      expect(() => computeWeather(null, { ts: T, ...s }, "live"), String(bad)).toThrow();
      const s2 = synth(T, { c0: 40.4 });
      s2.usdt5m[0] = { ...s2.usdt5m[0]!, c: bad }; // C_{t−12}
      expect(() => computeWeather(null, { ts: T, ...s2 }, "live"), `C12 ${bad}`).toThrow();
    }
  });

  it("W-1 doğrudan verilen BTC mumunda NaN / 0 / negatif / sonsuz kapanış → WeatherError", () => {
    for (const k of [0, 12, 36]) {
      for (const bad of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
        const s = synth(T, { c0: 40.4 });
        const i = s.btc5m.findIndex((c) => c.ts === T - (k + 1) * MIN5_MS);
        s.btc5m[i] = { ...s.btc5m[i]!, c: bad };
        expect(() => computeWeather(null, { ts: T, ...s }, "live"), `B${k} ${bad}`).toThrow(WeatherError);
      }
    }
  });

  it.each([
    ["h=NaN", (c: Candle): Candle => ({ ...c, h: Number.NaN })],
    ["o=NaN", (c: Candle): Candle => ({ ...c, o: Number.NaN })],
    ["o=0", (c: Candle): Candle => ({ ...c, o: 0 })],
    ["h<l", (c: Candle): Candle => ({ ...c, h: c.l - 1_000_000 })],
  ])("W-1 doğrudan verilen 1 sa mumda %s → WeatherError (med168 sessizce bozulmaz)", (_name, mut) => {
    const s = synth(T, { c0: 40.4 });
    s.usdt1h[100] = mut(s.usdt1h[100]!);
    expect(() => computeWeather(null, { ts: T, ...s }, "live")).toThrow(WeatherError);
  });

  it("W-1 gerçek veri: tek 1 sa mumda h=NaN sakin mumu (2025-03-20 07:40, zd 6,77) sahte alarma çevirmez", () => {
    const r = replays["2025-03-19"];
    const ts = utcMs(2025, 3, 20, 7, 40);
    expect(at("2025-03-19", ts).alarm).toBe(false);
    const lastOpen = Math.floor(ts / HOUR_MS) * HOUR_MS - HOUR_MS;
    const usdt1h = r.usdt1h.map((c) => (c.ts === lastOpen - 41 * HOUR_MS ? { ...c, h: Number.NaN } : c));
    expect(() => computeWeather(null, { ...market(r, ts), usdt1h }, "live")).toThrow(WeatherError);
  });

  it("W-1 geçersiz ts (NaN, negatif, hizasız, ondalıklı) → WeatherError", () => {
    const s = synth(T);
    for (const ts of [Number.NaN, -MIN5_MS, T + 1, T + 0.5]) {
      expect(() => computeWeather(null, { ts, ...s }, "live"), String(ts)).toThrow(WeatherError);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════
describe("Adversarial — bayat veri → fail-closed (W-1, §16-10)", () => {
  const r = () => replays["2024-08-05"];
  const ts = utcMs(2024, 8, 5, 1, 15);
  const upTo = (xs: Candle[], step: number, lastClose: number) => xs.filter((c) => c.ts + step <= lastClose);

  it("W-1 son USDT 5 dk mumu bir mum geride (ts'de kapanmamış) → WeatherError", () => {
    const usdt5m = upTo(r().usdt5m, MIN5_MS, ts - MIN5_MS);
    expect(() => computeWeather(null, { ...market(r(), ts), usdt5m }, "live")).toThrow(WeatherError);
  });

  it("W-1 USDT taze ama BTC bir mum geride → WeatherError (eski BTC ile sınıf uydurulmaz)", () => {
    const btc5m = upTo(r().btc5m, MIN5_MS, ts - MIN5_MS);
    expect(() => computeWeather(null, { ...market(r(), ts), btc5m }, "live")).toThrow(WeatherError);
  });

  it("W-1 son tamamlanmış saat (00:00–01:00) yoksa → WeatherError", () => {
    const usdt1h = upTo(r().usdt1h, HOUR_MS, ts - (ts % HOUR_MS) - HOUR_MS);
    expect(() => computeWeather(null, { ...market(r(), ts), usdt1h }, "live")).toThrow(WeatherError);
  });

  it("W-1 veri saatlerce geride, ts ileride → WeatherError", () => {
    const later = ts + 3 * HOUR_MS;
    const cut = { usdt5m: upTo(r().usdt5m, MIN5_MS, ts), usdt1h: upTo(r().usdt1h, HOUR_MS, ts), btc5m: upTo(r().btc5m, MIN5_MS, ts) };
    expect(() => computeWeather(null, { ts: later, ...cut }, "live")).toThrow(WeatherError);
  });

  it("W-1 tam saat başında (ts = 01:00) kapanmış son saat kullanılır; henüz kapanmamış saat gerekmez", () => {
    const t = utcMs(2024, 8, 5, 1, 0);
    const cut = { usdt5m: upTo(r().usdt5m, MIN5_MS, t), usdt1h: upTo(r().usdt1h, HOUR_MS, t), btc5m: upTo(r().btc5m, MIN5_MS, t) };
    const w = computeWeather(null, { ts: t, ...cut }, "live");
    expect(w.med168Bp).toBeCloseTo(at("2024-08-05", t).med168Bp, 12);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════
describe("Adversarial — §11 tablosu ve hafta sonu (W-4, §10.4 PRIM_SISMESI → Elif'e sor)", () => {
  const cls = (o: Partial<Metrics>) => classifyAlarm(m(o));

  it("W-4 hafta sonu (fxOpen=false) BTC sakin ya da kararsız yükseliş → PRIM_SISMESI (BELIRSIZ değil)", () => {
    expect(cls({ fxOpen: false })).toBe("PRIM_SISMESI");
    expect(cls({ fxOpen: false, btc1h: -1.2 })).toBe("PRIM_SISMESI");
    expect(cls({ fxOpen: false, btc1h: -1.0 })).toBe("PRIM_SISMESI");
    expect(cls({ fxOpen: false, btc3h: -4 })).toBe("PRIM_SISMESI");
  });

  it("W-4 hafta sonu BTC çöküşü KRIPTO_SISMESI, hafta sonu düşüş TL_GUCLENDI (tablo satır sırası)", () => {
    expect(cls({ fxOpen: false, btc1h: -1.5 })).toBe("KRIPTO_SISMESI");
    expect(cls({ fxOpen: false, r1hBp: -100 })).toBe("TL_GUCLENDI");
    expect(cls({ fxOpen: false, r1hBp: -100, btc1h: -5 })).toBe("TL_GUCLENDI");
  });

  it("W-2 FX açıkken eşikler: btc1h −1,0 → BELIRSIZ, −0,9999 → LIRA; btc3h −1,5 → BELIRSIZ, −1,4999 → LIRA", () => {
    expect(cls({ btc1h: -1.0 })).toBe("BELIRSIZ");
    expect(cls({ btc1h: -0.9999 })).toBe("LIRA_ZAYIFLADI");
    expect(cls({ btc3h: -1.5 })).toBe("BELIRSIZ");
    expect(cls({ btc3h: -1.4999 })).toBe("LIRA_ZAYIFLADI");
    expect(cls({ btc1h: -1.4999 })).toBe("BELIRSIZ");
    expect(cls({ btc1h: 2, btc3h: 2 })).toBe("LIRA_ZAYIFLADI");
  });

  it("W-4 alarm olmayan mumda classifyAlarm çağrısı WeatherError (tablo sınıf uydurmaz)", () => {
    expect(() => classifyAlarm(m({ ...calm }))).toThrow(WeatherError);
  });

  it("W-4 sentetik: cumartesi alarmında computeWeather PRIM_SISMESI; aynı veri pazartesi LIRA_ZAYIFLADI", () => {
    const sat = utcMs(2025, 1, 4, 12, 0);
    const mon = utcMs(2025, 1, 6, 12, 0);
    for (const [ts, want] of [
      [sat, "PRIM_SISMESI"],
      [mon, "LIRA_ZAYIFLADI"],
    ] as const) {
      const w = computeWeather(null, { ts, ...synth(ts, { c0: 42, c12: 40 }) }, "live");
      expect(w.alarm).toBe(true);
      expect(w.class).toBe(want);
    }
  });

  it("W-4 cuma FX açıkken açılan LIRA bölümü hafta sonuna girince PRIM'e dönmez (yalnız KRIPTO'ya yükselme)", () => {
    const fri = utcMs(2025, 1, 3, 21, 50); // cuma 16:50 EST, FX açık
    const w0 = computeWeather(null, { ts: fri, ...synth(fri, { c0: 42, c12: 40 }) }, "live");
    expect(w0.class).toBe("LIRA_ZAYIFLADI");
    const sat = fri + 4 * HOUR_MS;
    const w1 = computeWeather(w0.episode, { ts: sat, ...synth(sat, { c0: 44, c12: 42 }) }, "live");
    expect(w1.fxOpen).toBe(false);
    expect(w1.alarm).toBe(true);
    expect(w1.class).toBe("LIRA_ZAYIFLADI");
  });

  it("W-4 2026-02-01 kaydı: cumartesi ve pazar 23:00 UTC'ye kadar fxOpen=false, sonrası true", () => {
    const open = utcMs(2026, 2, 1, 23, 0);
    for (const w of series["2026-02-01"]) {
      const day = new Date(w.ts).getUTCDay();
      if (w.ts >= utcMs(2026, 1, 30, 22, 0) && w.ts < open) expect(w.fxOpen).toBe(false);
      if (w.ts >= open && day >= 1 && day <= 4) expect(w.fxOpen).toBe(true);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════
describe("Adversarial — fxOpen yaz saati geçişleri (W-4, §11.2-3)", () => {
  /** Bağımsız referans: ABD DST kuralı (Mart 2. pazar 07:00 UTC – Kasım 1. pazar 06:00 UTC), sabit tablo. */
  function sunday(year: number, month: number, n: number): number {
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    return 1 + ((7 - first) % 7) + 7 * (n - 1);
  }
  function refFxOpen(ts: number): boolean {
    const y = new Date(ts).getUTCFullYear();
    const dstStart = Date.UTC(y, 2, sunday(y, 3, 2), 7);
    const dstEnd = Date.UTC(y, 10, sunday(y, 11, 1), 6);
    const off = ts >= dstStart && ts < dstEnd ? -4 : -5;
    const local = new Date(ts + off * HOUR_MS);
    const wd = local.getUTCDay();
    const min = local.getUTCHours() * 60 + local.getUTCMinutes();
    if (wd === 6) return false;
    if (wd === 0) return min >= 18 * 60;
    if (wd === 5) return min < 17 * 60;
    return true;
  }

  it("W-4 Mart ve Kasım geçiş haftalarında (2024–2027) her 5 dakikada fxOpen bağımsız DST tablosuyla aynı", () => {
    const windows: [number, number][] = [
      [utcMs(2024, 3, 1), utcMs(2024, 3, 20)],
      [utcMs(2024, 10, 25), utcMs(2024, 11, 12)],
      [utcMs(2025, 3, 1), utcMs(2025, 3, 20)],
      [utcMs(2025, 10, 25), utcMs(2025, 11, 12)],
      [utcMs(2026, 3, 1), utcMs(2026, 3, 20)],
      [utcMs(2026, 10, 24), utcMs(2026, 11, 12)],
      [utcMs(2027, 3, 6), utcMs(2027, 3, 20)],
    ];
    let n = 0;
    for (const [a, b] of windows) {
      for (let ts = a; ts < b; ts += MIN5_MS, n++) {
        if (fxOpen(ts) !== refFxOpen(ts)) throw new Error(`fxOpen uyuşmuyor: ${new Date(ts).toISOString()}`);
      }
    }
    expect(n).toBeGreaterThan(30_000);
  });

  it("W-4 2025-03-09 (yaz saatine geçiş pazarı): 21:55 UTC kapalı, 22:00 UTC açık; önceki cuma (EST) 22:00 kapanır", () => {
    expect(fxOpen(utcMs(2025, 3, 9, 21, 55))).toBe(false);
    expect(fxOpen(utcMs(2025, 3, 9, 22, 0))).toBe(true);
    expect(fxOpen(utcMs(2025, 3, 7, 21, 55))).toBe(true);
    expect(fxOpen(utcMs(2025, 3, 7, 22, 0))).toBe(false);
    expect(fxOpen(utcMs(2025, 3, 14, 20, 55))).toBe(true); // sonraki cuma EDT
    expect(fxOpen(utcMs(2025, 3, 14, 21, 0))).toBe(false);
  });

  it("W-4 2026-11-01 (kış saatine dönüş pazarı): 22:55 UTC kapalı, 23:00 UTC açık; önceki cuma (EDT) 21:00 kapanır", () => {
    expect(fxOpen(utcMs(2026, 11, 1, 22, 0))).toBe(false); // sabit −4 olsaydı açık
    expect(fxOpen(utcMs(2026, 11, 1, 22, 55))).toBe(false);
    expect(fxOpen(utcMs(2026, 11, 1, 23, 0))).toBe(true);
    expect(fxOpen(utcMs(2026, 10, 30, 20, 55))).toBe(true);
    expect(fxOpen(utcMs(2026, 10, 30, 21, 0))).toBe(false);
    expect(fxOpen(utcMs(2026, 11, 6, 21, 55))).toBe(true); // sonraki cuma EST
    expect(fxOpen(utcMs(2026, 11, 6, 22, 0))).toBe(false);
  });

  it("W-4 2024-11-03 dönüş pazarı ve 2027-03-14 geçiş pazarı açılışları", () => {
    expect(fxOpen(utcMs(2024, 11, 3, 22, 55))).toBe(false);
    expect(fxOpen(utcMs(2024, 11, 3, 23, 0))).toBe(true);
    expect(fxOpen(utcMs(2027, 3, 14, 21, 55))).toBe(false);
    expect(fxOpen(utcMs(2027, 3, 14, 22, 0))).toBe(true);
  });

  it("W-4 NY gece yarısı (h23 '24' tuzağı yok): pazartesi 00:00 NY açık, cumartesi 00:00 NY kapalı, pazar 00:00–17:55 kapalı", () => {
    expect(fxOpen(utcMs(2026, 3, 9, 4, 0))).toBe(true); // pzt 00:00 EDT
    expect(fxOpen(utcMs(2026, 1, 5, 5, 0))).toBe(true); // pzt 00:00 EST
    expect(fxOpen(utcMs(2026, 1, 3, 5, 0))).toBe(false); // cmt 00:00 EST
    expect(fxOpen(utcMs(2026, 1, 4, 5, 0))).toBe(false); // pazar 00:00 EST
    expect(fxOpen(utcMs(2026, 3, 8, 7, 0))).toBe(false); // geçiş anı (02:00 → 03:00), pazar sabahı
    expect(fxOpen(utcMs(2026, 1, 4, 22, 55))).toBe(false); // pazar 17:55 EST
  });

  it("W-4 hafta ortası her zaman açık: çarşamba 12:00 UTC ve perşembe 23:55 UTC", () => {
    expect(fxOpen(utcMs(2026, 3, 11, 12, 0))).toBe(true);
    expect(fxOpen(utcMs(2026, 11, 5, 23, 55))).toBe(true);
  });
});
