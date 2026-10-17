import { defineStrings } from "../lib/i18n";

// Arayüzün ortak metinleri: [english, türkçe]. Türkçe varsayılan ve yedektir; İngilizce yuva Türkçe'yi tekrarlayabilir.
// Metni önce `@pilot/shared/texts` içinde ara (rejectText, optionText, WEATHER_CLASS_TEXTS …); yoksa buraya ya da
// ekranın kendi `strings-<ekran>.ts` dosyasına ekle.
defineStrings({
  // marka + cüzdan
  tagline: ["sign the instruction, not the key", "anahtarı değil, imzalı talimatı ver"],
  "wallet.label": ["your wallet", "cüzdanın"],
  "wallet.pitch": [
    "Pin your wallet to the board to sign. Looking around works without one.",
    "İmza atmak için cüzdanını panoya iğnele. Bakınmak için gerek yok.",
  ],
  "wallet.connect": ["Connect wallet", "Cüzdanını bağla"],
  "wallet.opening": ["Opening wallet…", "Cüzdan açılıyor…"],
  "wallet.unpin": ["Unpin", "Ayır"],
  "wallet.switch": ["Switch to Fuji", "Fuji ağına geç"],
  "wallet.onFuji": ["Avalanche Fuji", "Avalanche Fuji"],
  "wallet.needConnect": ["Connect your wallet to do this.", "Bunun için cüzdanını bağla."],
  "wallet.noExtension": ["Install Core or MetaMask.", "Core ya da MetaMask kur."],

  // gezinme + kontrat durumu
  "nav.label": ["Main", "Ana gezinme"],
  "nav.secim": ["Ajan seç", "Ajan seç"],
  "nav.panel": ["Panel", "Panel"],
  "nav.yetkiler": ["Yetkiler", "Yetkiler"],
  "nav.ajan": ["Ajan", "Ajan"],
  "dep.label": ["contract", "kontrat"],
  "dep.none": [
    "The contract is not deployed yet. Signing stays closed until deployments/fuji.json exists.",
    "Kontrat henüz dağıtılmadı. deployments/fuji.json gelene kadar imza kapalı.",
  ],
  "dep.invalid": ["Contract address could not be read", "Kontrat adresi okunamadı"],
  "dep.ready": ["Contract on Fuji", "Kontrat Fuji'de"],

  // alt şerit
  "foot.chain": ["Avalanche Fuji · testnet", "Avalanche Fuji · test ağı"],
  "foot.disclaimer": ["Data, not investment advice.", "Veridir, yatırım tavsiyesi değildir."],

  // zaman
  "time.now": ["now", "şimdi"],
  "time.d": ["d", "g"],
  "time.h": ["h", "sa"],
  "time.m": ["m", "dk"],

  // işlem bildirimi
  "toast.pending": ["on its way", "yolda"],
  "toast.ok": ["done", "tamam"],
  "toast.error": ["didn't go through", "gerçekleşmedi"],
  "toast.confirm": ["{label}: confirm in your wallet…", "{label}: cüzdanında onayla…"],
  "toast.waiting": ["{label}: waiting for Fuji…", "{label}: Fuji bekleniyor…"],
  "toast.done": ["{label}: done.", "{label}: tamamlandı."],
  "toast.view": ["view on Snowtrace ↗", "Snowtrace'te gör ↗"],
  "err.rejected": ["You cancelled it in the wallet.", "Cüzdanda iptal ettin."],
  "err.reverted": ["Transaction reverted on Fuji.", "İşlem Fuji'de geri döndü."],

  // kontrat özel hataları (IFlightPlan); UI_HANDOFF §3.2. TODO(spec): shared'e taşı.
  "err.NotAgent": ["Only the plan's agent can ask for permission.", "Yalnız planın ajanı izin isteyebilir."],
  "err.NotKule": ["Only the plan's KULE can report.", "Yalnız planın KULE'si rapor yazabilir."],
  "err.OverFilled": ["Filled amount is above the authorised amount.", "Gerçekleşen tutar izinli tutarı aşıyor."],
  "err.ActionNotAuthorized": ["This permission is not open.", "Bu izin açık değil."],
  "err.ReportWindowClosed": ["The report window is closed.", "Rapor penceresi kapandı."],
  "err.ReportWindowOpen": ["The report window is still open.", "Rapor penceresi hâlâ açık."],
  "err.InvalidPlan": ["The plan fields are inconsistent.", "Plan alanları tutarsız."],
  "err.NoPlan": ["There is no plan to stop.", "Durdurulacak plan yok."],
  "err.NoPendingPlan": ["There is no pending plan.", "Bekleyen plan yok."],
  "err.PendingNotReady": ["The pending plan is not ready yet.", "Bekleyen plan henüz hazır değil."],
  "err.CycleNotOver": ["The cycle is not over, or has an open permission.", "Döngü bitmedi ya da açık izin var."],
  "err.CycleAlreadyClosed": ["The cycle is already closed.", "Döngü zaten kapalı."],
  "err.InvalidStatus": ["Invalid execution status.", "Geçersiz emir durumu."],
  "err.ValueNotAccepted": ["The contract does not take value.", "Kontrat değer kabul etmez."],

  // bağlantı sorunu
  "net.down": ["Can't reach Fuji right now.", "Şu an Fuji'ye ulaşılamıyor."],
  "net.downBody": ["The network didn't answer. Nothing was signed; try again in a moment.", "Ağ cevap vermedi. Hiçbir şey imzalanmadı; birazdan tekrar dene."],
  "net.retry": ["Try again", "Tekrar dene"],
  "unknown": ["unknown", "bilinmiyor"],
});
