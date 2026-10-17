/**
 * Araçların veri kaynakları (§10.2): hava durumu, haber, ekonomik takvim. Hepsi yalnız okuma.
 * Demo haberi ve etiketli demo takvimi C7'nin işidir; burada yalnız arayüz ve boş kaynaklar var.
 */
import type { z } from "zod";
import type { EkonomikTakvimOutputSchema, HaberleriOkuOutputSchema, UnixMs, Weather } from "@pilot/shared";
import { WeatherError } from "../weather/index.js";

export interface WeatherSource {
  /** `nowMs` anındaki son Weather (§11). Veri yoksa fırlatır. */
  current(nowMs: UnixMs): Promise<Weather>;
}

/**
 * Kayıt oynatma kaynağı: runReplay çıktısından `ts ≤ nowMs` olan son kayıt. İleriye bakmaz.
 * TODO(spec): canlı kaynak (KULE kule_market mumlarıyla computeWeather) ATK yanıt biçimi doğrulanınca (B2) eklenecek.
 */
export function replayWeatherSource(series: readonly Weather[]): WeatherSource {
  const sorted = [...series].sort((a, b) => a.ts - b.ts);
  return {
    async current(nowMs) {
      let lo = 0;
      let hi = sorted.length - 1;
      let found: Weather | undefined;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid]!.ts <= nowMs) {
          found = sorted[mid];
          lo = mid + 1;
        } else hi = mid - 1;
      }
      if (!found) throw new WeatherError("bu an için kayıtlı hava durumu yok");
      return found;
    },
  };
}

type NewsOut = z.input<typeof HaberleriOkuOutputSchema>;
export type NewsItem = NewsOut["items"][number];
export interface NewsSource {
  read(nowMs: UnixMs): Promise<{ demo: boolean; items: NewsItem[] }>;
}

type CalendarOut = z.input<typeof EkonomikTakvimOutputSchema>;
export type CalendarEvent = CalendarOut["events"][number];
export interface CalendarSource {
  upcoming(nowMs: UnixMs): Promise<{ demo: boolean; events: CalendarEvent[] }>;
}

/** Haber erişimi yokken (ATK news_* yok, demo kapalı). */
export const NO_NEWS: NewsSource = { read: async () => ({ demo: false, items: [] }) };
/** Takvim erişimi yokken. */
export const NO_CALENDAR: CalendarSource = { upcoming: async () => ({ demo: false, events: [] }) };
