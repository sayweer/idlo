/**
 * ATK `news_get_economic_calendar` bağdaştırıcısı — TASLAK (§10.2, §21 #10).
 *
 * TODO(spec): [DOĞRULA: TR'de erişim, bölge kodu]. Aracın girdisi ve yanıt biçimi doğrulanmadı. Ayrıca PİLOT'un ATK
 * bağlantısı yok: ATK, KULE'nin alt sürecidir (§9) ve KULE §9.1 dışında araç açmaz. Doğrulanınca burada ATK yanıtı zod
 * ile doğrulanıp `CalendarEvent`'e çevrilecek.
 *
 * O güne kadar bu kaynak her çağrıda hata verir (fail-closed, CLAUDE.md kural 2): uydurma takvim yok. `ekonomik_takvim`
 * aracı hata döner ("Araç hata verdi; işlem yapılmadı."); LLM takvimsiz, yalnız karar tablosunun seçenekleriyle sürer.
 * Sahnede kullanılan kaynak etiketli demo takvimidir (./demo.ts).
 */
import type { CalendarSource } from "../tools/sources.js";

export const ATK_CALENDAR_TOOL = "news_get_economic_calendar";

export class CalendarUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarUnavailableError";
  }
}

export const atkCalendarStub: CalendarSource = {
  async upcoming() {
    throw new CalendarUnavailableError(`ATK ${ATK_CALENDAR_TOOL} doğrulanmadı (SPEC §21 #10); takvim yok.`);
  },
};
