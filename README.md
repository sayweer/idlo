# Uçuş Planı

**Ajanına anahtarını değil, imzalı talimatını ver.**

Uçuş Planı, bir yapay zekâ ajanının senin borsa hesabında işlem yapmasına izin veren ama sınırı senin koyduğun bir yetki katmanıdır. Kuralını Türkçe cümleyle yazarsın, kural kartına dönüşür, cüzdanınla imzalarsın ve Avalanche'ta bir kontrata yazılır. Ajan her alımdan önce bu kontrattan izin ister. Borsaya emri, anahtarı tutan tek kapı olan **KULE** gönderir ve yalnız zincirin izin verdiği emri gönderir.

> OKX TR × Team1 Türkiye Agentic Hackathon · 17 Ekim 2026 · Ankara

| | |
|---|---|
| **Canlı site** | https://idlo-wine.vercel.app |
| **Uçuş Planı kontratı (Avalanche Fuji)** | [`0xc5f2eA8aF9dE71f78E84F3D10B7c91928E684055`](https://testnet.snowtrace.io/address/0xc5f2eA8aF9dE71f78E84F3D10B7c91928E684055) · kaynak kodu Snowtrace'te doğrulandı |
| **PİLOT'un ERC-8004 kimliği** | Ajan **#284** · [kayıt işlemi](https://testnet.snowtrace.io/tx/0x09ec9a0dd819bddeced46db01e68d973e955a43b81bab9da049cf89e55d07dcd) · [`agent.json`](https://idlo-wine.vercel.app/agent.json) |
| **Ağ** | Avalanche Fuji C-Chain (43113) |

---

## Problem

Bugün bir yapay zekâ ajanına borsada işlem yaptırmak için ona API anahtarını verirsin. Borsaların sunduğu kontrol iki uçludur: ya her emri tek tek onaylarsın (ajanın anlamı kalmaz) ya da ajanı serbest bırakırsın (sınır, alt hesaba koyduğun para kadardır). Arası yoktur: *"Şu kurallar içinde serbestsin, dışına çıkacaksan bana sor."*

Ajan bir haberdeki gizli talimatla kandırılabilir, anahtarı çalınabilir ya da basit bir birim hatası yapabilir. Kullanıcının elinde, ajanın ne yapmaya yetkili olduğunu gösteren imzalı ve bağımsız bir kayıt yoktur.

## Çözüm

Uçuş Planı yetkiyi üç parçaya ayırır:

| Kim | Ne yapar | Ne yapamaz |
|---|---|---|
| **Sen** | Kuralı cümlenle yazarsın, imzalarsın; sınırı anında düşürürsün, her şeyi durdurursun | — |
| **Ajan (PİLOT)** | Ne zaman ve nasıl alınacağına karar verir, gerekçesini Türkçe yazar, emin değilse sana sorar | Plan dışında tutar isteyemez, anahtarı görmez, para çekemez |
| **Kontrat (Uçuş Planı)** | Her alım isteğini planla karşılaştırır, izin verir ya da reddeder; ret zincirde kayıtlı kalır | Kendi başına emir veremez |
| **KULE** | Yalnız zincirde izni olan emri OKX TR'ye gönderir, sonucu zincire yazar | İzin olmadan emir gönderemez; çekim yetkisi yoktur |

**Ajan anahtarı çalınsa bile sınır durur:** Saldırgan PİLOT'un anahtarıyla kontrattan 40.000 TL izin isterse kontrat `OVER_ORDER_LIMIT` ile reddeder. Kendi planını kurup bizim KULE'yi kandırmaya çalışırsa KULE iznin senin planına ait olmadığını görür ve emri göndermez.

## Nasıl çalışır

```
 Sen ──"ayda 300 TL dolara çevir, tek seferde 150'yi geçme, emin olmazsan sor"──▶ Sohbet
                                                                                   │
        ┌──────────────────────────────────────────────────────────────────────────┘
        ▼
 1. Ajan seçimi    Fuji'deki ERC-8004 kayıtlı ajanlar toplanır.
                   Kod eler: kimliksiz, cüzdanı eşleşmeyen, doğrulanmış geri bildirimi az olan ajan çıkar.
                   LLM kalanları ihtiyacına göre sıralar ve gerekçe yazar.
        ▼
 2. Uçuş Planı     Cümlen kural kartına çevrilir. "Zincire yazılacak değerler" penceresinde
                   her değerin kaynağını görürsün (senin cümlenden / varsayılan / senin düzeltmen).
                   Cüzdanınla imzalarsın → FlightPlan.setPlan (Fuji)
        ▼
 3. Ajan çalışır   PİLOT Lira Hava Durumu'nu okur, karar tablosuna danışır, teklif alır.
                   Kontrattan izin ister → BuyAuthorized ya da BuyRejected (zincirde)
        ▼
 4. Emir           KULE izni zincirden okur, kendi kontrollerinden geçirir, emri OKX TR'ye gönderir,
                   sonucu reportExecution ile zincire yazar.
        ▼
 5. Denetim        Mutabakat, borsadaki her emri zincirdeki izinle eşleştirir; eşleşmeyen emir alarm verir.
```

### Sahte puana karşı önlem

Bir ajanın itibarı yalnız **o ajanla KULE üzerinden gerçekten alım yapmış kullanıcıların** geri bildirimleriyle hesaplanır. Bir kullanıcı ancak şu iki koşul birlikte sağlanırsa "doğrulanmış" sayılır:

- `BuyAuthorized` işlemini o ajanın ERC-8004 kaydındaki cüzdan göndermiştir.
- Aynı izin için dolumu sıfırdan büyük `BuyExecuted` işlemini güvenilen KULE göndermiştir.

Fuji'deki ERC-8004 Reputation kontratı da `getSummary` çağrısında geri bildirim listesi verilmeden puan döndürmez; bu tasarımı zincir tarafı da zorlar.

## Mimari

| Bileşen | Klasör | Görev |
|---|---|---|
| **Uçuş Planı kontratı** | `contracts/` | Planı tutar, 24 saat kilidiyle gevşetmeyi geciktirir, alım isteklerini reddeder ya da izin verir, aylık toplamı tutar (Solidity, Foundry) |
| **KULE** | `apps/kule/` | Borsa kapısı. MCP sunucusu (bearer token, her token bir ajana bağlı), OKX Agent Trade Kit alt süreci, izin başına kilit ve diske yazılan durum, Cancel-All-After, kâğıt modu |
| **PİLOT** | `apps/pilot/` | LLM planlayıcı (Claude araç kullanımı), karar tablosu, Lira Hava Durumu, ajan seçme (ERC-8004 tarama, eleme, sıralama), kural modu yedeği |
| **OKX.AI servisleri** | `apps/servis/` | Anahtar tutmayan iki servis: Emir Denetimi ve Lira Hava Durumu (x402, temsili ödeme) |
| **Web** | `apps/web/` | Açılış, ajan seçme + imza, panel, yetkiler ve ajan sayfaları (Vite, React, wagmi) |
| **Ortak paket** | `packages/shared/` | Birim dönüşümleri, şemalar, ret ve karar kodları, yetki bağı kontrolü, Türkçe metinler |
| **Betikler** | `scripts/` | Kayıt oynatma verisi, ERC-8004 kaydı, "ajan anahtarı çalındı" sahnesi, mutabakat |

### Güvenlik ilkeleri

- **Fail-closed:** emin olunmayan her durumda emir verilmez, zincire yazılmaz.
- **Güvenlik kararı LLM'e bırakılmaz:** LLM'in her çıktısı şemayla doğrulanır; tutar, adres ve izin kontrolü koddadır.
- **KULE yetki bağı:** emir yalnız izin plandaki kullanıcıya aitse, plan bu KULE'yi gösteriyorsa, isteyen token o planın ajanına bağlıysa ve ajanın ERC-8004 cüzdanı plandaki adresle eşleşiyorsa gönderilir.
- **Aynı izin iki kez uygulanamaz:** izin başına kilit ve emirden önce diske yazılan durum (`RESERVED → PLACED → DONE → REPORTED`).
- **Çekim yok:** OKX anahtarı yalnız okuma ve işlem yetkilidir; çekim kodu yazılmamıştır.
- **Gevşetme gecikir:** daha gevşek bir plan 24 saat bekler; her yeni plan ve her iptal bekleyen gevşek planı siler.

## Lira Hava Durumu

USDT-TRY'deki ani hareketleri sınıflandırır ve ajana "şimdi mi, bekle mi" bağlamı verir. Kripto çöküşünden gelen geçici USDT primini, liranın gerçekten zayıfladığı andan ayırır. Fırtına başladıktan sonra sınıf, fırtına bitene kadar kilitli kalır; fiyat geri çekilince yanlışlıkla "şimdi al" denmez.

| Sınıf | Ne zaman | Önerilen |
|---|---|---|
| Normal | Alarm yok | Pencere açıksa çevir |
| TL güçlendi | USDT-TRY sert düştü | Şimdi çevir |
| Kripto şişmesi | Yükseliş + BTC 1 saatte −%1,5 ve altı | Bekle |
| Prim şişmesi | Yükseliş + döviz piyasası kapalı | Sor |
| Belirsiz | Yükseliş + BTC kararsız | Sor |
| Lira zayıfladı | Yükseliş + BTC sakin | Şimdi çevir |

Yöntem 29 aylık OKX TR verisiyle (5 dakikalık mumlar) sınandı. Bu bir kanıt değil, makul bir varsayımdır; örneklem küçüktür. **Veridir, yatırım tavsiyesi değildir.**

## Avalanche ve OKX

- **Avalanche:** Uçuş Planı kontratı Fuji C-Chain'de. İki aşamalı onay (önce zincirde izin, sonra emir) hızlı kesinleşmeye dayanır; izin 1–2 saniyede kesinleşir. Ajan kimliği ve itibarı Fuji'deki resmî ERC-8004 kayıtlarındadır.
- **OKX:** Emirler OKX TR'ye OKX Agent Trade Kit (MCP) üzerinden gider. Anahtar tutmayan iki servis OKX.AI'da listelenebilecek biçimde (A2MCP + x402) hazırlandı.

## Hızlı başlangıç

Gerekenler: Node 20+, pnpm 11, Foundry.

```bash
git clone https://github.com/sayweer/idlo.git && cd idlo
pnpm install
pnpm -r build && pnpm -r test
cd contracts && forge build && forge test && cd ..
```

| Komut | Ne yapar |
|---|---|
| `pnpm --filter web dev` | Web arayüzü |
| `REPLAY=data/replays/2025-03-19.json pnpm --filter pilot dev` | PİLOT'u geçmiş bir fırtınanın kaydıyla çalıştırır (ağa işlem göndermez) |
| `pnpm --filter kule dev` | KULE (`apps/kule/.env` gerekir; `KULE_EXEC=paper` ile borsaya emir gitmez) |
| `pnpm --filter servis dev` | OKX.AI servisleri |

Her uygulamanın ayarları `.env.example` dosyasındadır. Anahtarlar yalnız `.env` dosyalarına yazılır; `.env` dosyaları git'e girmez.

Kurulum ve yayın: [`docs/DEPLOY.md`](docs/DEPLOY.md) · web yayını: `apps/web/scripts/deploy-vercel.sh`.

## Testler

| Paket | Test |
|---|---|
| Kontrat (Foundry, 128 bin çağrılı muhasebe testi dahil) | 118 |
| KULE (gerçek kontratla yerel zincir testleri dahil) | 157 |
| PİLOT (karar tablosu, araçlar, döngü, ajan seçme, Lira Hava Durumu) | 643 |
| Betikler (ERC-8004 kaydı, anahtar çalındı sahnesi, mutabakat) | 308 |
| Ortak paket | 143 |
| OKX.AI servisleri | 63 |
| Web | 56 |

Testler SPEC'teki kabul kimlikleriyle adlandırılmıştır (`F-`, `U-`, `W-`, `D-`, `E-`, `R-`), saldırgan senaryolar ayrı dosyalardadır.

## Durum

| Parça | Durum |
|---|---|
| Uçuş Planı kontratı | Fuji'de canlı, kaynak kodu doğrulandı |
| PİLOT ERC-8004 kaydı | Canlı (#284) |
| Web | Canlı; plan taslağı canlı LLM ile çalışıyor |
| KULE | Kod ve testler hazır; canlı OKX TR çağrılarıyla duman testi bekliyor |
| Aday ajan listesi, PİLOT izi ve KULE durumu (web) | Şimdilik örnek veri, ekranda **TEMSİLİ VERİ** etiketiyle |
| Gerçek x402 ödemesi ve OKX.AI listelemesi | Yol haritası; ekranda **TEMSİLİ ÖDEME** |

Ekranda gösterilen her demo durumu etiketlidir: **KAYIT** (geçmiş veri), **KÂĞIT** (borsaya emir gitmez), **DEMO**, **TEMSİLİ VERİ**.

## Yol haritası

- Passkey ile imza ve kullanıcının kendi akıllı hesabı (Avalanche ACP-204)
- KULE'nin borsa tarafına ya da güvenli donanıma taşınması
- Satış yönü (USDT → TL) ve başka varlıklar
- Gerçek x402 ödemesi, OKX.AI listelemesi, ERC-8004 doğrulayıcıları
- Ana ağ

## Belgeler

- [`docs/SPEC.md`](docs/SPEC.md): ürünün tam spesifikasyonu (tek doğru kaynak)
- [`docs/HANDOFF.md`](docs/HANDOFF.md): durum, kararlar, açık sorular
- [`docs/UI_HANDOFF.md`](docs/UI_HANDOFF.md): ekranlar ve veri kaynakları
- [`docs/DEPLOY.md`](docs/DEPLOY.md): Fuji'ye kurulum

## Ekip

Seyit · Bekir Erdem · Barış

Fikir kredisi: "kural kullanıcının isteğinden şekillenir" fikri Atahan Hoca'nın Koul projesinden gelir.

## Uyarı

Bu proje bir hackathon prototipidir ve Avalanche Fuji test ağında çalışır. Yatırım tavsiyesi değildir; hukuki görüş içermez. Türkiye'de kripto varlıklarla ödeme kısıtlıdır; ücretli servis yalnız yurt dışındaki ajanlara açıktır.
