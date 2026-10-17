/**
 * Kayıt oynatma (SPEC §11.2): `scripts/make-replay.ts`'in yazdığı "pilot-replay/1" içeriğini doğrular ve
 * aynı hesaplayıcıyı simüle saatle (her 5 dk mum kapanışı) çalıştırır. Dosya biçimi make-replay.ts başlığındadır.
 * Saf modül: dosya OKUMA burada yok (apps/pilot `readReplayFile`); shared G/Ç yapmaz.
 */
import { z } from "zod";
import { UnixMsSchema } from "../schemas/primitives.js";
import type { Episode, Weather } from "../schemas/weather.js";
import { secToMs, trDateToSec, TR_UTC_OFFSET_SEC, type UnixMs } from "../units.js";
import { MIN5_MS, WeatherError, candleFromOkx, computeWeather, type Candle } from "./calc.js";

const RowSchema = z.tuple([z.string(), z.string(), z.string(), z.string(), z.string()]);
export const ReplayFileSchema = z.strictObject({
  format: z.literal("pilot-replay/1"),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  source: z.string(),
  fetchedAt: UnixMsSchema,
  simFrom: UnixMsSchema,
  simTo: UnixMsSchema,
  candles: z.strictObject({
    "USDT-TRY": z.strictObject({ "5m": z.array(RowSchema), "1H": z.array(RowSchema) }),
    "BTC-USDT": z.strictObject({ "5m": z.array(RowSchema) }),
  }),
});

export interface Replay {
  day: string;
  simFrom: UnixMs;
  simTo: UnixMs;
  usdt5m: Candle[];
  usdt1h: Candle[];
  btc5m: Candle[];
}

function toCandles(rows: readonly (readonly string[])[], what: string): Candle[] {
  const out = rows.map(candleFromOkx);
  for (let i = 1; i < out.length; i++) {
    if (out[i]!.ts <= out[i - 1]!.ts) throw new WeatherError(`${what}: mumlar artan sırada değil`);
  }
  return out;
}

export function parseReplay(json: unknown): Replay {
  const f = ReplayFileSchema.parse(json);
  if (f.simFrom % MIN5_MS !== 0 || f.simTo % MIN5_MS !== 0 || f.simTo < f.simFrom) {
    throw new WeatherError("simFrom/simTo 5 dk kapanışlarına hizalı ve sıralı olmalı");
  }
  return {
    day: f.day,
    simFrom: f.simFrom,
    simTo: f.simTo,
    usdt5m: toCandles(f.candles["USDT-TRY"]["5m"], "USDT-TRY 5m"),
    usdt1h: toCandles(f.candles["USDT-TRY"]["1H"], "USDT-TRY 1H"),
    btc5m: toCandles(f.candles["BTC-USDT"]["5m"], "BTC-USDT 5m"),
  };
}

/**
 * simFrom'dan simTo'ya her 5 dk kapanışında Weather üretir; bölüm durumu bir sonraki muma taşınır.
 * Bölüm durumu simFrom'da boş başlar (dosyada 48 sa ısınma vardır).
 */
export function runReplay(r: Replay): Weather[] {
  const out: Weather[] = [];
  let episode: Episode | null = null;
  for (let ts = r.simFrom; ts <= r.simTo; ts += MIN5_MS) {
    const w = computeWeather(episode, { ts, usdt5m: r.usdt5m, usdt1h: r.usdt1h, btc5m: r.btc5m }, "replay");
    episode = w.episode;
    out.push(w);
  }
  return out;
}

/** UTC tarih/saat → OKX ms (units.ts: TR gün başı + sabit UTC+3 farkı). Test zamanları UTC ve tam dakika (§11.2). */
export function utcMs(year: number, month: number, day: number, hour = 0, minute = 0): UnixMs {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new WeatherError(`UTC saat geçersiz: ${hour}:${minute}`);
  }
  return secToMs(trDateToSec(year, month, day, hour, minute) + TR_UTC_OFFSET_SEC);
}
