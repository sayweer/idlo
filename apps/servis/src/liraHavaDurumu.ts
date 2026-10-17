/**
 * Lira Hava Durumu (SPEC §11, §11.2, §12) — HERKESE AÇIK OKX mumlarıyla, paylaşılan hesaplayıcı (computeWeather).
 * Anahtarsız (CLAUDE.md kural 6). Çıktı veridir, tavsiye değildir.
 *
 * Fırtına bölümü kuralı (CLAUDE.md kural 14): sınıf her çağrıda sıfırdan hesaplanmaz. Bölüm durumu bellekte tutulur ve
 * her 5 dk kapanışında sırayla ilerletilir. İlk çağrıda (ya da süreklilik koptuğunda) son 300 mumun izin verdiği
 * kadar geriden (≈ 22 sa) ısınılır; böylece fırtına sürerken başlayan süreç sınıfı NORMAL'e düşürmez.
 * TODO(spec): §11.2 canlı servis için ısınma süresini vermiyor; kayıt oynatmadaki 48 sa yerine tek istekte alınabilen
 * ≈ 22 sa seçildi (6 sa bölüm süresinin üstünde). 22 saatten uzun kesintisiz fırtına zincirinde ilk sınıf farklı olabilir.
 */
import {
  LOOKBACK,
  MIN5_MS,
  WeatherError,
  computeWeather,
  minutesToMs,
  type Candle,
  type Episode,
  type UnixMs,
  type Weather,
} from "@pilot/shared";
import { CANDLE_LIMIT_MAX, type OkxPublic } from "./okxPublic.js";

/** PİLOT ile aynı eşik (decision.ts MAX_WEATHER_AGE_MS): son kapanmış mum 10 dk'dan eskiyse veri bayattır. */
export const MAX_DATA_AGE_MS = minutesToMs(10);

export interface WeatherProvider {
  current(): Promise<Weather>;
}

export function createLiveWeather(deps: { okx: OkxPublic; now: () => UnixMs }): WeatherProvider {
  let episode: Episode | null = null;
  let lastTs: UnixMs | null = null;
  let last: Weather | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  async function step(): Promise<Weather> {
    const [usdt5m, usdt1h, btc5m] = await Promise.all([
      deps.okx.candles("USDT-TRY", "5m", CANDLE_LIMIT_MAX),
      deps.okx.candles("USDT-TRY", "1H", CANDLE_LIMIT_MAX),
      deps.okx.candles("BTC-USDT", "5m", CANDLE_LIMIT_MAX),
    ]);
    if (usdt5m.length < LOOKBACK.usdt5m || btc5m.length < LOOKBACK.btc5m || usdt1h.length < LOOKBACK.usdt1h) {
      throw new WeatherError("yeterli kapanmış mum yok");
    }
    const closeOf = (c: Candle) => c.ts + MIN5_MS;
    // Son karar anı: iki seride de kapanmış son 5 dk mumun kapanışı.
    const latest = Math.min(closeOf(usdt5m.at(-1)!), closeOf(btc5m.at(-1)!));
    const now = deps.now();
    if (latest > now || now - latest > MAX_DATA_AGE_MS) throw new WeatherError("piyasa verisi bayat ya da gelecekten");
    if (lastTs !== null && latest < lastTs) throw new WeatherError("zaman geri gidemez (yeni veri eskisinden önce)");
    if (lastTs === latest && last !== null) return last;

    const earliest = Math.max(closeOf(usdt5m[0]!), closeOf(btc5m[0]!));
    const continuous = lastTs !== null && lastTs + MIN5_MS >= earliest;
    let ep = continuous ? episode : null;
    let out: Weather | null = null;
    for (let ts = continuous ? lastTs! + MIN5_MS : earliest; ts <= latest; ts += MIN5_MS) {
      let w: Weather;
      try {
        w = computeWeather(ep, { ts, usdt5m, usdt1h, btc5m }, "live");
      } catch (e) {
        // Isınmanın başındaki mumların geriye bakışı eksiktir; ilk başarılı hesaptan sonra her hata fail-closed.
        if (!continuous && out === null && e instanceof WeatherError) continue;
        throw e;
      }
      ep = w.episode;
      out = w;
    }
    if (out === null || out.ts !== latest) throw new WeatherError("güncel mum için hava durumu hesaplanamadı");
    // Durum yalnız tüm adımlar başarılıysa güncellenir.
    episode = ep;
    lastTs = latest;
    last = out;
    return out;
  }

  return {
    current() {
      // Eşzamanlı çağrılar bölüm durumunu sırayla ilerletir.
      const run = queue.then(step);
      queue = run.catch(() => undefined);
      return run;
    },
  };
}
