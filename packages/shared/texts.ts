/**
 * Kullanıcıya görünen Türkçe metinler (CLAUDE.md kural 10). Kod tanımlayıcıları İngilizce kalır.
 */
import type {
  ExecStatus,
  HealthReasonName,
  HealthState,
  KuleMode,
  KuleReasonCode,
  KuleReasonName,
  KuleVerdict,
  OrdType,
  RejectCodeName,
  WeatherClass,
} from "./codes.js";
import { rejectCodeName } from "./codes.js";
import { formatDecimalTr, formatPxTr, formatTL } from "./units.js";
import type { Option } from "./schemas/option.js";

/** Zincir ret kodlarının (§8.3) kullanıcı mesajları. */
export const REJECT_TEXTS: Record<RejectCodeName, string> = {
  PLAN_INACTIVE: "Plan etkin değil: plan yok, iptal edilmiş ya da süresi dolmuş.",
  OUTSIDE_WINDOW: "Çevirme penceresinin dışında: bugün plandaki gün aralığında değil.",
  OVER_ORDER_LIMIT: "Tutar, plandaki tek emir tavanını aşıyor.",
  OVER_CYCLE_TARGET: "Tutar, bu ayın hedefini aşıyor.",
  PRICE_ABOVE_BAND: "Fiyat, izin verilen bandın üstünde.",
  PRICE_UNAVAILABLE: "Referans fiyat 72 saatten eski; fiyat bandı uygulanamıyor.",
  BAD_ORDTYPE: "Geçersiz emir türü.",
};

/** Zincirdeki uint8 ret kodunun mesajı. Bilinmeyen kod fırlatır. */
export function rejectText(code: number): string {
  return REJECT_TEXTS[rejectCodeName(code)];
}

export const VERDICT_TEXTS: Record<KuleVerdict, string> = {
  ONAY: "Onay",
  DÜZELT: "Düzelt",
  RET: "Ret",
  BEKLET: "Beklet",
};

export const HEALTH_TEXTS: Record<HealthState, string> = {
  NORMAL: "Normal",
  YENİ_EMİR_YOK: "Yeni emir yok",
  YETKİ_YOK: "Yetki yok",
};

export const HEALTH_REASON_TEXTS: Record<HealthReasonName, string> = {
  DATA_STALE: "Piyasa verisi bayat.",
  PILOT_HEARTBEAT: "PİLOT'tan 45 saniyedir kalp atışı gelmedi.",
  CHAIN_UNREADABLE: "Zincir okunamıyor.",
  ORDER_UNCERTAIN: "Bir emrin sonucu belirsiz; netleşene kadar yeni emir yok.",
  PLAN_INACTIVE: "Kullanıcının planı iptal edilmiş ya da süresi bitmiş.",
  CAA_INACTIVE: "Açık emirleri koruyan Cancel-All-After yenilenemiyor; yeni emir yok.",
};

export const KULE_REASON_TEXTS: Record<Exclude<KuleReasonName, "HEALTH">, string> = {
  AUTH: "Geçersiz erişim anahtarı.",
  WRONG_AGENT: "Bu izin başka bir ajana ait.",
  ALREADY_EXECUTED: "Bu izin zaten uygulandı ya da uygulanıyor.",
  NO_AUTHORIZATION: "Zincirde geçerli bir izin yok.",
  TOO_LATE: "İzin süresinin dolmasına 12 dakikadan az kaldı; yeni izin gerekli.",
  BAD_INSTRUMENT: "Yalnız USDT-TRY alışı yapılabilir.",
  BALANCE: "İşlem hesabında yeterli TRY yok.",
  BALANCE_IN_FUNDING: "TRY fon hesabında; işlem hesabına aktarman gerekiyor.",
  STALE_DATA: "Piyasa verisi bayat; emir bekletildi.",
  WIDE_SPREAD: "Alış-satış makası geniş; emir bekletildi.",
  ABOVE_MAX_PX: "En iyi satış fiyatı, izindeki en yüksek fiyatın üstünde; emir bekletildi.",
  BELOW_MIN_SZ: "Tutar, borsanın en küçük emir miktarının altında.",
  UNCERTAIN_RESULT: "Emir sonucu belirsiz; netleşene kadar yeni emir yok.",
  SZ_LOOKS_LIKE_TL: "Miktar TL gibi görünüyor; limit alışta miktar USDT'dir.",
  NOTIONAL_MISMATCH: "Fiyat × miktar, tutardan %1'den fazla sapıyor.",
  EXCHANGE_REJECTED: "Borsa emri reddetti; emir açılmadı.",
};

/** KULE gerekçe kodunun Türkçe mesajı (`HEALTH:<sebep>` dahil). */
export function kuleReasonText(code: KuleReasonCode): string {
  if (code.startsWith("HEALTH:")) {
    const r = code.slice(7) as HealthReasonName;
    const t = HEALTH_REASON_TEXTS[r];
    if (!t) throw new RangeError(`Bilinmeyen sağlık sebebi: ${code}`);
    return t;
  }
  const t = KULE_REASON_TEXTS[code as Exclude<KuleReasonName, "HEALTH">];
  if (!t) throw new RangeError(`Bilinmeyen KULE gerekçesi: ${code}`);
  return t;
}

export const WEATHER_CLASS_TEXTS: Record<WeatherClass, string> = {
  NORMAL: "Hava açık",
  TL_GUCLENDI: "TL güçlendi",
  KRIPTO_SISMESI: "Kripto şişmesi",
  PRIM_SISMESI: "Prim şişmesi",
  BELIRSIZ: "Belirsiz",
  LIRA_ZAYIFLADI: "Lira zayıfladı",
};

export const ORD_TYPE_TEXTS: Record<OrdType, string> = {
  post_only: "yalnız yapıcı",
  ioc: "hemen",
};

export const EXEC_STATUS_TEXTS: Record<ExecStatus, string> = {
  FILLED: "Doldu",
  PARTIAL: "Kısmen doldu",
  CANCELED: "İptal edildi",
  EXPIRED: "Süresi doldu",
};

/** Ekran etiketleri (CLAUDE.md kural 12: demo modları açıkça etiketlenir). */
export const MODE_LABELS: Record<KuleMode, string> = {
  demo: "DEMO",
  live: "CANLI",
  paper: "KÂĞIT",
};

export const DEMO_LABELS = {
  injectionDemo: "ENJEKSİYON DEMOSU",
  mockFacilitator: "TEMSİLİ ÖDEME",
  rulesMode: "LLM yok, kural modu",
  paperExec: "KÂĞIT",
} as const;

/** Seçeneğin Türkçe adı (panel, soru düğmeleri). */
export function optionText(o: Option): string {
  switch (o.kind) {
    case "BUY":
      return `${formatTL(o.amountTL)} TL al (${ORD_TYPE_TEXTS[o.ordType]})`;
    case "WAIT":
      return `${o.minutes} dk bekle`;
    case "ASK":
      return "Elif'e sor";
    case "BEKLE":
      return "Pencerenin açılmasını bekle";
    case "BITIR":
      return "Bu ay tamam";
  }
}

/**
 * `readback` metni (§9.1): "10.000 TL ile yaklaşık 202,6 USDT alınacak (limit 49,35, yalnız yapıcı)."
 * `sz` USDT (OKX string), `pxE6` limit fiyatı.
 */
export function quoteReadback(args: { amountTL: number; sz: string; pxE6: number; ordType: OrdType }): string {
  return (
    `${formatTL(args.amountTL)} TL ile yaklaşık ${formatDecimalTr(args.sz, 1)} USDT alınacak ` +
    `(limit ${formatPxTr(args.pxE6)}, ${ORD_TYPE_TEXTS[args.ordType]}).`
  );
}

/** Servis çıktısındaki sabit uyarı (§12). */
export const DATA_DISCLAIMER = "Veridir, yatırım tavsiyesi değildir.";

/** "Ajan anahtarı çalındı" sahnesi mesajı (§10.5). */
export const STOLEN_KEY_MESSAGE = "Ajan tamamen ele geçirilse bile Elif'in imzaladığı sınır duruyor.";

/** Haber verisindeki talimatı uygulamama notu (§10.5, E-3). */
export const INJECTION_NOTE = "Haberdeki talimatı veri olarak değerlendirdim.";
