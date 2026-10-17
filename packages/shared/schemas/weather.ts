/** Lira Hava Durumu şeması (§11, §11.2, §15). Zamanlar OKX ms. */
import { z } from "zod";
import { EPISODE_DIRS, STORM_CLASSES, WEATHER_CLASSES, ZD_ALARM, episodeDirOf } from "../codes.js";
import { UnixMsSchema } from "./primitives.js";

/** Bölüm süresi: son alarmdan 6 saat sonra kapanır (§11.2-2). */
export const EPISODE_DURATION_MS = 6 * 3600 * 1000;

/** Fırtına bölümü (§11.2-5): {type, dir, P0, startTs, lastAlarmTs, endsAt}. */
export const EpisodeSchema = z
  .strictObject({
    type: z.enum(STORM_CLASSES),
    dir: z.enum(EPISODE_DIRS),
    P0: z.number().positive(), // fırtına öncesi fiyat (C_{t−12})
    startTs: UnixMsSchema,
    lastAlarmTs: UnixMsSchema,
    endsAt: UnixMsSchema, // lastAlarmTs + 6 sa
  })
  .superRefine((e, ctx) => {
    if (episodeDirOf(e.type) !== e.dir) {
      ctx.addIssue({ code: "custom", path: ["dir"], message: "TL_GUCLENDI aşağı, diğer fırtınalar yukarı yönlüdür" });
    }
    if (e.lastAlarmTs < e.startTs) ctx.addIssue({ code: "custom", path: ["lastAlarmTs"], message: "lastAlarmTs ≥ startTs olmalı" });
    if (e.endsAt !== e.lastAlarmTs + EPISODE_DURATION_MS) {
      ctx.addIssue({ code: "custom", path: ["endsAt"], message: "endsAt = lastAlarmTs + 6 saat olmalı" });
    }
  });
export type Episode = z.infer<typeof EpisodeSchema>;

export const WEATHER_SOURCES = ["live", "replay"] as const;

/**
 * Weather (§15). `stormUntil` ve `episode` fırtına yokken null.
 * TODO(spec): §15 örneğinde fırtına yokken bu alanların değeri verilmiyor; null seçildi.
 * Tutarlılık (fail-closed): NORMAL ⇔ bölüm yok; bölüm varken class = episode.type ve stormUntil = episode.endsAt;
 * alarm = zd ≥ 8; alarm mumu bölüm açar ya da uzatır (class ≠ NORMAL, episode.lastAlarmTs = ts, §11.2-1/2);
 * bölüm varken episode.startTs ≤ ts < episode.endsAt (§11.2-2: endsAt'te bölüm kapanır).
 */
export const WeatherSchema = z
  .strictObject({
    ts: UnixMsSchema,
    px: z.number().positive(),
    r1hBp: z.number(),
    med168Bp: z.number().nonnegative(),
    zd: z.number().nonnegative(),
    alarm: z.boolean(),
    btc1h: z.number(),
    btc3h: z.number(),
    fxOpen: z.boolean(),
    class: z.enum(WEATHER_CLASSES),
    stormUntil: UnixMsSchema.nullable(),
    episode: EpisodeSchema.nullable(),
    src: z.enum(WEATHER_SOURCES),
  })
  .superRefine((w, ctx) => {
    if (w.alarm !== w.zd >= ZD_ALARM) ctx.addIssue({ code: "custom", path: ["alarm"], message: "alarm = zd ≥ 8 olmalı" });
    if (w.alarm) {
      if (w.class === "NORMAL") ctx.addIssue({ code: "custom", path: ["class"], message: "alarm mumunda sınıf NORMAL olamaz" });
      if (w.episode !== null && w.episode.lastAlarmTs !== w.ts) {
        ctx.addIssue({ code: "custom", path: ["episode", "lastAlarmTs"], message: "alarm mumunda episode.lastAlarmTs = ts olmalı" });
      }
    }
    if (w.episode !== null && (w.ts < w.episode.startTs || w.ts >= w.episode.endsAt)) {
      ctx.addIssue({ code: "custom", path: ["ts"], message: "ts bölüm aralığında olmalı (startTs ≤ ts < endsAt)" });
    }
    if (w.class === "NORMAL") {
      if (w.episode !== null) ctx.addIssue({ code: "custom", path: ["episode"], message: "NORMAL iken bölüm olmaz" });
      if (w.stormUntil !== null) ctx.addIssue({ code: "custom", path: ["stormUntil"], message: "NORMAL iken stormUntil null olmalı" });
    } else {
      if (w.episode === null) {
        ctx.addIssue({ code: "custom", path: ["episode"], message: "fırtına sınıfı bölüm gerektirir" });
      } else {
        if (w.episode.type !== w.class) ctx.addIssue({ code: "custom", path: ["class"], message: "class = episode.type olmalı" });
        if (w.stormUntil !== w.episode.endsAt) {
          ctx.addIssue({ code: "custom", path: ["stormUntil"], message: "stormUntil = episode.endsAt olmalı" });
        }
      }
    }
  });
export type Weather = z.infer<typeof WeatherSchema>;
