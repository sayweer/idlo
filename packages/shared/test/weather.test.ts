/**
 * Lira Hava Durumu paylaşılan modülü (SPEC §11). Davranış testleri (W-1…W-8) apps/pilot/test/weather*.test.ts'te,
 * `@pilot/shared`'den içe aktarılarak koşar; burada yalnız paylaşım sözleşmesi denetlenir.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as shared from "../index.js";

const WEATHER_DIR = join(dirname(fileURLToPath(import.meta.url)), "../weather");

describe("W (paylaşım) Lira Hava Durumu hesaplayıcısı shared'de, G/Ç'siz", () => {
  it("hesaplayıcı ve kayıt ayrıştırıcı index'ten dışa aktarılır", () => {
    for (const name of ["computeWeather", "computeMetrics", "stepEpisode", "fxOpen", "parseReplay", "runReplay", "utcMs"]) {
      expect(typeof (shared as Record<string, unknown>)[name]).toBe("function");
    }
    expect(shared.MIN5_MS).toBe(300000);
    expect(shared.HOUR_MS).toBe(3600000);
  });
  it("weather/ dosyaları node: modülü içe aktarmaz (dosya okuma apps/pilot'ta kalır)", () => {
    const files = readdirSync(WEATHER_DIR).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(readFileSync(join(WEATHER_DIR, f), "utf8")).not.toMatch(/from\s+["']node:/);
  });
  it("utcMs UTC duvar saatini ms'ye çevirir", () => {
    expect(shared.utcMs(2024, 8, 5, 1, 15)).toBe(Date.parse("2024-08-05T01:15:00Z"));
    expect(shared.utcMs(2025, 12, 31, 23, 59)).toBe(Date.parse("2025-12-31T23:59:00Z"));
    expect(() => shared.utcMs(2024, 8, 5, 24, 0)).toThrow(shared.WeatherError);
  });
});
