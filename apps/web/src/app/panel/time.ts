import { cycleIdParts, msToSec, trParts, type CycleId } from "@pilot/shared";

// Saat dönüşümü yalnız shared `trParts` üstüne ince sarmalayıcıdır (UI_HANDOFF §3.4): getTimezoneOffset / timeZone yok.
const MONTHS_SHORT = ["Oca", "Şub", "Mar", "Nis", "May", "Haz", "Tem", "Ağu", "Eyl", "Eki", "Kas", "Ara"] as const;
const MONTHS_LONG = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"] as const;
const pad = (n: number) => String(n).padStart(2, "0");

/** Türkiye saatiyle "10:35". */
export function trClock(ms: number): string {
  const p = trParts(msToSec(ms));
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** "19 Mar 2025" (TR saati). */
export function trDate(ms: number): string {
  const p = trParts(msToSec(ms));
  return `${p.day} ${MONTHS_SHORT[p.month - 1]} ${p.year}`;
}

export const trDateTime = (ms: number): string => `${trDate(ms)} ${trClock(ms)}`;

/** Aynı TR gününde mi? */
export function sameTrDay(a: number, b: number): boolean {
  const x = trParts(msToSec(a));
  const y = trParts(msToSec(b));
  return x.year === y.year && x.month === y.month && x.day === y.day;
}

/** Saat; başka güne düşüyorsa tarihle: "16:35" ya da "20 Mar 02:10". */
export function trClockRelative(ms: number, refMs: number): string {
  return sameTrDay(ms, refMs) ? trClock(ms) : `${trDate(ms).slice(0, -5)} ${trClock(ms)}`;
}

/** 202503 → "Mart 2025". */
export function cycleName(id: CycleId): string {
  const { year, month } = cycleIdParts(id);
  return `${MONTHS_LONG[month - 1]} ${year}`;
}

/** Sayı → Türkçe virgüllü gösterim, sabit kesir: 9 → "9,0"; −0.08 → "−0,08". İşaret U+2212. */
export function trNumber(n: number, frac = 2): string {
  const s = Math.abs(n).toFixed(frac).replace(".", ",");
  return n < 0 && Number(Math.abs(n).toFixed(frac)) !== 0 ? `−${s}` : s;
}

/** Saniye → "1 sa 20 dk" / "45 sn" (kısa süreler için). */
export function spanText(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} sn`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h === 0) return `${m} dk ${pad(s % 60)} sn`;
  return m ? `${h} sa ${m} dk` : `${h} sa`;
}
