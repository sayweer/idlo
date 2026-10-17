// /panel ve /ajan ekranlarının metinleri (yalnız Türkçe). Metni önce `@pilot/shared/texts` içinde ara
// (rejectText, optionText, WEATHER_CLASS_TEXTS …); burada yalnız shared'de olmayanlar durur.
// TODO(spec): "Emir açılmadı", "rapor süresi doldu" gibi satırlar shared'e taşınmalı.

export const T = {
  unknown: "bilinmiyor",
  stale: "veri bayat",
  noChain: "Zincir okunamadı",
  noDeploy: "Kontrat henüz dağıtılmadı: zincir verisi yok.",
  badDeploy: "Kontrat adresi okunamadı: zincir verisi yok.",
  connect: "Zincirdeki verini görmek için cüzdanını bağla.",
  clockNote: "kayıt saati",
  notPlaced: "Emir açılmadı",
  expired: "rapor süresi doldu",
  untrusted: "güvenilmeyen veri",
  unverified: "doğrulanmamış çıktı",
  differs: "önerilenden farklı seçti",
  unknownReject: "bilinmeyen ret kodu",

  panelLabel: "/panel",
  panelTitle: "Ajan kendi başına",
  panelNote: "Kararı ajan veriyor, izni kontrat veriyor, emri KULE gönderiyor. Burada üçünü de görürsün.",

  cycleLabel: "Döngü",
  spent: "harcanan",
  reserved: "bekleyen",
  remaining: "kalan",
  window: "Pencere",
  noPlan: "Henüz bir Uçuş Planın yok.",
  toSecim: "Ajan seç",
  planInactive: "Plan etkin değil",
  cycleNone: "Bu ay için henüz döngü açılmadı.",
  goalDone: "Bu ayın hedefi tamamlandı.",
  cycleClosedOk: "Döngü zincirde kapandı: hedef tuttu.",
  cycleClosedMiss: "Döngü zincirde kapandı: hedef tutmadı.",

  weatherLabel: "Lira Hava Durumu",
  alarm: "ALARM",
  fx: "FX",
  fxOpen: "açık",
  fxClosed: "kapalı",
  noStorm: "Aktif fırtına yok.",
  replayNote: "Karar geçmiş fırtınanın verisinden, emir bugünün fiyatıyla.",

  traceLabel: "PİLOT izi",
  traceEmpty: "PİLOT henüz bir tur çalıştırmadı.",
  traceStale: "Besleme bayat: son turlar güncel olmayabilir.",
  turn: "Tur",
  llm: "LLM",
  paperTag: "KÂĞIT",
  rationale: "Gerekçe",
  allowed: "izinli",
  recommended: "önerilen",
  authorized: "İzin verildi",
  rejected: "İzin reddedildi",
  refused: "Araç koruması zincire göndermedi",
  txOk: "İşlem başarılı, izin reddedildi.",
  noOut: "çıktı yok",
  errorPrefix: "hata",
  showRaw: "ham çıktı",

  qLabel: "PİLOT'un soruları",
  qEmpty: "PİLOT şu an soru sormuyor.",
  qDefault: "{min} dk içinde cevap gelmezse",
  qTimeout: "Süre doldu: PİLOT varsayılan seçeneği uyguladı.",
  qAnswered: "Cevaplandı.",
  qNoEndpoint: "Cevap uç noktası henüz bağlı değil (PLANLI): seçimin PİLOT'a iletilmedi.",
  qNeedWallet: "Cevap vermek için cüzdanını bağla: cevap imzalanır.",
  qSign: "İmza cüzdanında istenecek.",
  qFail: "Cevap gönderilemedi.",

  rejLabel: "Reddedilen girişimler",
  rejEmpty: "Zincirde reddedilen girişim yok.",
  rejHint: "Doğrudan zincirden okunur: PİLOT'a güven gerekmez.",

  actLabel: "İzinler ve emirler",
  actEmpty: "Zincirde izin ya da emir kaydı yok.",
  waitingExec: "emir bekleniyor",

  kuleLabel: "KULE",
  health: "Sağlık",
  caa: "Cancel-All-After",
  caaActive: "etkin",
  caaInactive: "etkin değil",
  caaLapsed: "yenilenmedi: açık emirler düşmüş olmalı",
  heartbeat: "PİLOT kalp atışı",
  dataAge: "Piyasa verisi yaşı",
  block: "Zincir bloğu",
  chainDown: "zincir okunamıyor",
  mode: "Mod",

  noticeBalanceFunding: "TRY fon hesabında; işlem hesabına aktarman gerekiyor.",
  noticeBalance: "İşlem hesabında yeterli TRY yok.",

  pilotDead: "PİLOT'tan nabız yok.",
  noFeedUser: "PİLOT beslemesi için cüzdanını bağla.",
  feedDown: "PİLOT beslemesi cevap vermiyor",
  kuleDown: "KULE durumu okunamıyor",
} as const;

/** "{min}" gibi yer tutucuları doldurur. */
export const fill = (s: string, vars: Record<string, string | number>): string =>
  Object.entries(vars).reduce((acc, [k, v]) => acc.replaceAll(`{${k}}`, String(v)), s);
