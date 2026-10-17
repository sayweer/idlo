// Birimler, TL/fiyat/TR saati biçimleri `@pilot/shared`'dedir (formatTL, formatPxTr, trParts …): burada yeniden yazma.
// Bu dosya yalnız shared'de olmayan arayüz yardımcılarını tutar.

export const short = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");

export type Units = { now: string; d: string; h: string; m: string };
const TR_UNITS: Units = { now: "şimdi", d: "g", h: "sa", m: "dk" };

export function duration(seconds: number, u: Units = TR_UNITS) {
  if (seconds <= 0) return u.now;
  const d = Math.floor(seconds / 86400), h = Math.floor((seconds % 86400) / 3600), m = Math.floor((seconds % 3600) / 60);
  if (d) return h ? `${d}${u.d} ${h}${u.h}` : `${d}${u.d}`;
  if (h) return m ? `${h}${u.h} ${m}${u.m}` : `${h}${u.h}`;
  return `${Math.max(m, 1)}${u.m}`;
}
