/**
 * Etiketli demo takvimi (§10.2 `ekonomik_takvim`: ATK `news_get_economic_calendar` [DOĞRULA] "yoksa etiketli demo
 * takvimi"; §21 #10). Kaynak dosya: data/demo/calendar.json. Çıktı her zaman `demo: true` taşır ve başlıklar "(DEMO)"
 * içerir; panel DEMO etiketi gösterir (docs/UI_HANDOFF.md).
 *
 * Takvim yalnız okumadır ve karar tablosunu değiştirmez: yalnız `kural_danis`'in izinli seçenekleri arasındaki
 * seçimi etkiler (§10.2, §10.3 "önerilenden farklı seçim").
 *
 * TODO(spec): SPEC demo takviminin zamanlarını vermiyor. En dar ve tekrarlanabilir seçim: her öğe her gün aynı Türkiye
 * saatinde (sabit UTC+3, CLAUDE.md kural 8) tekrarlanır. Kayıt oynatmada simüle saatle, canlıda duvar saatiyle çalışır;
 * dosyayı sahneden önce düzenlemek gerekmez.
 */
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { DAY_SEC, msToSec, secToMs, trDateToSec, trParts } from "@pilot/shared";
import type { CalendarEvent, CalendarSource } from "../tools/sources.js";

const TR_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const DemoCalendarEntrySchema = z.strictObject({
  /** Türkiye saati "SS:DD". */
  trTime: z.string().regex(TR_TIME_RE, "trTime SS:DD olmalı"),
  title: z.string().min(1).max(200),
  country: z.string().min(1).max(8).optional(),
  importance: z.enum(["low", "medium", "high"]).optional(),
});

export const DemoCalendarFileSchema = z.strictObject({
  label: z.string().min(1),
  note: z.string(),
  daily: z.array(DemoCalendarEntrySchema).min(1),
});
export type DemoCalendarFile = z.infer<typeof DemoCalendarFileSchema>;

export function parseDemoCalendar(json: unknown): DemoCalendarFile {
  return DemoCalendarFileSchema.parse(json);
}

export async function readDemoCalendarFile(path: string): Promise<DemoCalendarFile> {
  return parseDemoCalendar(JSON.parse(await readFile(path, "utf8")));
}

/**
 * Bugünün ve yarının (TR) tekrarları; `nowMs`'den önceki atılır. 24 saat ufku ve sıralama araç katmanındadır
 * (pilotTools.ts CALENDAR_HORIZON_MS), burada da sıralı döner.
 */
export function demoCalendarSource(file: DemoCalendarFile): CalendarSource {
  return {
    async upcoming(nowMs) {
      const nowSec = msToSec(nowMs);
      const events: CalendarEvent[] = [];
      for (const daySec of [nowSec, nowSec + DAY_SEC]) {
        const d = trParts(daySec);
        for (const e of file.daily) {
          const [, hh, mm] = TR_TIME_RE.exec(e.trTime)!;
          const ts = secToMs(trDateToSec(d.year, d.month, d.day, Number(hh), Number(mm)));
          if (ts < nowMs) continue;
          events.push({
            ts,
            title: e.title,
            ...(e.country ? { country: e.country } : {}),
            ...(e.importance ? { importance: e.importance } : {}),
          });
        }
      }
      return { demo: true, events: events.sort((a, b) => a.ts - b.ts) };
    },
  };
}
