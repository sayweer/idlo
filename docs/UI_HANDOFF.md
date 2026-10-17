# UI devir notu — `apps/web` (Bekir'in ajanı için)

> Okuma sırası: `CLAUDE.md` → bu dosya → `docs/SPEC.md` (tek doğru kaynak). Bu dosya SPEC ile çelişirse **SPEC kazanır**; bu dosya yalnız SPEC'i web açısından toplar, boşlukları adlandırır ve en dar/güvenli seçimi önerir.
> Sahiplik notu: SPEC §17.2'de Aşama D (web) Seyit'e yazılı; web işi Bekir'in ajanına devredildi. Panel ekranlarında Barış (PİLOT sahibi) destek verir. KULE zaten Bekir'de.
> Durum fotoğrafı: 2026-10-17. `contracts/` ve `apps/pilot` başka bir iş akışında eşzamanlı değişiyor; ABI'yi ve PİLOT çıktılarını **yapım anında** koddan oku, buradan kopyalama.

---

## 1. Ürün tek paragrafta ve UI'ın rolü

**Ne:** Elif maaşını TL olarak OKX TR'ye yatırır ve her ay bir kısmını USDT'ye çevirmek ister. Kurallarını kendi Türkçe cümlesiyle yazar ("ayın 1'inde yatıyor, 20 bininin en geç 5'ine kadar dolara çevrilmesini istiyorum, tek seferde 10 binden fazla harcama, emin olmazsan bana sor" — SPEC §1). PİLOT bu cümleyi bir **kural kartına** çevirir. Elif kartı cüzdanıyla imzalar ve kart Fuji'deki `FlightPlan` kontratına **Uçuş Planı** olarak yazılır. Sonra PİLOT (araç seçen LLM ajanı) her 5 dakikada bir şunları yapar: **Lira Hava Durumu**'nu okur, karar tablosuna danışır, teklif alır, zincirden izin ister (`requestBuy`) ve emri **KULE** üzerinden OKX TR'ye gönderir. KULE yalnız zincirde `BuyAuthorized` olan emri uygular. Çekim yoktur; USDT Elif'in OKX hesabında kalır. Mimari ve güven sınırları: SPEC §2, §4.

**Slogan (`/`):** "Ajanına anahtarını değil, imzalı talimatını ver."
**Sahne cümlesi (§4):** "Kararı ajan veriyor, izni kontrat veriyor, emri KULE gönderiyor. Kontrat hayır derse KULE emir göndermez ve bu hayır zincirde kayıtlıdır."

**UI'ın rolü — üç kitle:**
1. **Elif:**
   - Talimat yazar, kartı okur ve imzalar (`/talimat`).
   - Ajanın ne yaptığını izler ve sorularını cevaplar (`/panel`).
   - Sınırlarını düşürür, yükseltir ya da her şeyi durdurur (`/yetkiler`).
2. **Jüri:** UI, jürinin beş sorusunun kanıt ekranıdır (§3.2). Dakikalar §19'a göredir (§3.2'de Q1/Q4 sınırı 4:15 yazıyor; sahne akışı §19'dur):

   | Jüri sorusu | Ekran | Dakika |
   |---|---|---|
   | Q5 "problem ve kullanıcı net mi?" | `/` | 0:00–0:45 |
   | Q2 "yetkiler/limitler?" | `/talimat` kartı ve `/yetkiler` | 0:45–2:00, 7:45–8:30 |
   | Q1 "canlı mı?" | `/panel` izi, Fuji tx bağlantıları | 2:00–4:30 |
   | Q4 "hata/beklenmedik girdi?" | `/panel` kırmızı retler, `/demo`, terminal (bkz. §2.3 hata bölümü) | 4:30–6:30 |
   | Q3 "kimlik/geçmiş?" | `/ajan`; ayrıca `/panel` olaylarının Snowtrace bağlantıları ve terminalde `mutabakat.ts` (varsa `/mutabakat`) | 6:30–7:45 |

   UX, Demo & Sunum puanının 5'idir (§3.1). Agentic 10 puanı da jürinin **hangi aracın neden seçildiğini panelde okuyabilmesine** bağlıdır (§10.3).
3. **Sahne (§19):** 10 dakikalık demo neredeyse tamamen bu sayfalardan akar. Dakika eşleşmesi aşağıda her ekranın altında var.

---

## 2. Ekranlar ve akışlar

Genel kurallar her ekran için geçerlidir:
- Her zincir işlemi `https://testnet.snowtrace.io/tx/<hash>` bağlantısıyla gösterilir.
- Kesinleşme süresi "X,X sn'de kesinleşti" biçiminde gösterilir: `formatDecimalTr(scaledToDecimal(BigInt(ms), 3), 1)`. `msToSec` **kullanma** (tamsayıya keser: 1400 → 1).
- Kırmızı **yalnız** ret ve alarm içindir (§13).
- Cüzdan bağlı değilse zincir okuyan ekranlar "Cüzdanını bağla" gösterir.
- Yanlış ağdaysa (chainId ≠ 43113) "Fuji ağına geç" gösterilir ve imza düğmeleri kapanır.
- Saatler her yerde **TR saatidir** (UTC+3, `trParts`). SPEC'teki örnek ve test saatleri **UTC**'dir (§11.2 sonu): 5 Ağu 01:15 UTC ekranda 04:15 görünür. Sahne metni buna göre Seyit ile güncellenir.

### 2.1 `/` — giriş
- **Amaç:** tek cümle ve cüzdan bağlantısı (Q5).
- **Eylem:** "Cüzdanını bağla" (Core / MetaMask, injected/EIP-6963).
- **Veri:** yok. Bağlanınca `/talimat`'a yönlendir (plan varsa `/panel`'e; `isPlanActive(user)` ile bak).
- **Durumlar:**
  - Cüzdan eklentisi yok → "Core ya da MetaMask kur".
  - Yanlış ağ → `switchChain(43113)` öner.
- **Demo:** 0:00–0:45.
- **Test:** —.

### 2.2 `/talimat` — cümle → Kural Kartı → imza (D1, ŞART)
- **Amaç:** Elif'in cümlesini imzalanabilir `Plan`'a çevirmek. Bu ekran §3.2 Q2'nin cevabıdır.

**Akış:**
1. **Cümle kutusu** (örnek cümle placeholder olarak §1'den).
2. **İstek:** `POST /api/plan/draft {sentence, answers?: {question, answer}[]}`. Bu, **web'in kendi Next.js route handler'ı**dır; sunucu tarafında `ANTHROPIC_API_KEY` ve `LLM_MODEL` ile `planFromSentence` çalıştırır (§10.6). `answers` varsa route bunları cümlenin sonuna "Soru: … Cevap: …" satırları olarak ekler (TODO(spec)).
   - Sistem istemi §10.6'dan **birebir** alınır.
   - LLM çıktısı `PlanDraftSchema.safeParse` ile doğrulanır.
   - Bozuk JSON'da **bir kez** yeniden denenir, olmazsa hata döner (L-4).
   - LLM yalnız çıkarır, sayı uydurmaz (L-3).
   - Route LLM istemcisini **enjekte edilebilir** alır (test için).
3. **Kural Kartı** — alanlar `PLAN_DRAFT_FIELDS` sırasıyla gelir. Her satırda **değer** ve **kaynak rozeti** görünür (`user` → "senin cümlenden", `default` → "varsayılan"). Kart okumak içindir; **düzeltme kartta değil, onay penceresinde yapılır** (adım 4).
   - **"PİLOT ne yapabilir / ne yapamaz"** kutusu §4 katman tablosundan türetilir. TODO(spec): SPEC tam metin vermiyor; aşağıdakini kullan.
     - Yapabilir: "Ne zaman, ne kadar ve hangi emir türüyle alınacağına karar verir; Türkçe gerekçe yazar; emin değilse sana sorar."
     - Yapamaz: "Kontrat izni olmadan emir verdiremez; planın dışında tutar isteyemez; para çekemez (çekim yetkisi yoktur); senin anahtarını görmez."
   - **Sorular** (`draft.questions`) kartın üstünde, her biri için bir cevap kutusuyla listelenir. "Sorular cevaplanmadan kart imzaya açılmaz" (§10.6, §16 #8). **Tek yol:** cevaplar `answers` ile yeniden `/api/plan/draft`'a gönderilir ve yeni taslak gelir. Elle alan doldurmak soruyu kapatmaz (`questions` hiçbir alana bağlı değil; `QUESTIONS_OPEN` engeli kalır). TODO(spec): soru başına alan anahtarı gerekiyorsa shared'e eklenir.
   - Kartın altında **"İmzaya geç"** düğmesi onay penceresini açar. Pencere sorular açıkken de açılabilir (değerleri görmek için), ama imza düğmesi kapalı kalır.

4. **Onay penceresi — "Zincire yazılacak değerler"** (ekip kararı; TODO(spec): SPEC pencereyi tanımlamıyor). İmzadan önceki **tek** ekran; `setPlan`'a gidecek değerlerin **tamamını** gösterir ve düzeltmeye izin verir.
   - **Kurulum:** `const conf = buildPlanConfirmation(draft, { nowSec, deployments, current, currentActive })` (`@pilot/shared`, §3.1).
     - `nowSec`: `msToSec(Date.now())` (zincir saniyesi).
     - `deployments`: `parseDeployments(fuji.json)`; okunamadıysa `null` (pencere `NO_DEPLOYMENT` gösterir).
     - `current`: `planFromChain(plans(user))`; zincir okunamadıysa pencereyi **açma** (tahmin yapılamaz, fail-closed). Hiç plan yoksa `null` ya da `agent == 0x0` olan kayıt (ikisi de "plan yok").
     - `currentActive`: `isPlanActive(user)` (zorunlu `boolean`; `current` varken eksikse fırlatır). İptal ya da süresi dolmuş plan yine `current` olarak verilir (karşılaştırma tabanı); bu bayrak yalnız tahmin metnini doğru kurar. Okunamadıysa pencereyi açma.
     - Geçersiz taslak ya da `nowSec` fırlatır: "Taslak doğrulanamadı, tekrar dene." Taslak zaten `PlanDraftSchema`'dan geçtiyse olmaz.
   - **Başlık:** `conf.titleTr` ("Zincire yazılacak değerler"). `/talimat?demo=1` ise başlığın yanında **"DEMO PLANI"** etiketi.
   - **Satırlar:** `conf.rows` — `IFlightPlan.Plan`'ın 12 alanı, §8.1 sırasıyla (`PLAN_FIELDS`). Satır eklenmez, çıkarılmaz, sıra değişmez. Her satırda:
     - `labelTr` (ör. "Aylık çevrilecek tutar") ve `displayTr` (Türkçe biçim: "20.000 TL", "Ayın 1. günü", "72 saat", "Kapalı", "%5", "15.01.2027 12:00 (TR saati) · 90 gün", adres, "#17"). Değer kurulamadıysa "—".
     - `chainValue` küçük, eş aralıklı yazıyla ("zincire giden değer": "20000", `expiresAt` için unix saniye, checksum'lı adres). Bu metin `setPlanArgs[0][field]`'ın kendisidir; UI kendi hesaplamaz.
     - `badgeTr` rozeti: "senin cümlenden" (`user`), "varsayılan" (`default`), **"senin düzeltmen"** (`edited`), "otomatik" (kodun türettiği, `editable=false`; ayrıca kırpılmış varsayılan süre, bkz. `expiresAt` düzeltmesi). Dört rozet **ayrı renkte**, hiçbiri kırmızı değil. Demo planında rozetlerin yanında "DEMO PLANI".
     - `note` (bilgi, nötr renk): "Kod tarafından belirlenir; düzenlenemez.", "Mevcut planından gevşek: bu değişiklik 24 saat bekletir.", "Mevcut planından farklı: bu alan değişirse plan her zaman 24 saat bekler." (F-4), "Varsayılan süre mevcut planının bitişiyle sınırlandı; böylece plan anında geçer. Daha geç bitiş istersen gün sayısını düzelt; bu 24 saat bekletir.", "Mevcut planının süresi doldu; yeni bitiş her zaman daha geç olduğundan plan 24 saat bekler."
     - `error` (alan hatası; kırmızı **değil**, uyarı rengi — kırmızı yalnız ret ve alarm, §13): ör. "Tek emir tavanı aylık tutarı aşamaz."
   - **Düzenlenebilir satırlar** (`editable=true`, `EDITABLE_PLAN_FIELDS`): `cycleTL`, `maxOrderTL`, `startDay`, `deadlineDay`, `maxWaitH`, `askMode`, `expiresAt`. Diğerleri (`bandBps`, `closedBandBps`, `agent`, `kule`, `agentId`) salt-okunur, "otomatik".
   - **Düzeltme akışı:** satırdaki "Düzelt" → satır içi giriş → "Uygula" → `conf = applyEdit(conf, field, value)`. Pencere her düzeltmede **baştan** doğrulanır (zod + `FlightPlan._validate` kuralları + §8.2 tahmini); UI ayrıca doğrulama yazmaz.
     - Giriş biçimi: TL / gün / saat alanlarında **ham metin** (`input.value`) olduğu gibi verilir; `Number()` ile çevirme ("20.000" → 20 olur). Yalnız rakam kabul edilir; "20.000", "1,5", "-3" alan hatası verir.
     - `askMode`: evet/hayır anahtarı → `boolean`.
     - `expiresAt`: "kaç gün geçerli" girişi (1–365) → gün sayısı. Elif'in cümlesinden ya da düzeltmesinden gelen süre **olduğu gibi** imzalatılır; mevcut planın bitişinden geçse 24 saat bekler (F-3). Yalnız **varsayılan** süre (90 gün), mevcut plan sürüyorsa onun bitişiyle sınırlanır: satır "otomatik" rozeti ve not taşır, "· N gün" eki gösterilmez. TODO(spec): kırpma ekip kararı. (Taslaktaki değere eşit düzeltme, ör. yine 90, asıl rozetine döner ve kırpılır.)
     - Asıl değere geri dönülen alan asıl rozetine döner.
     - Düzeltme taslaktaki `questions`'ı kapatmaz.
   - **Engeller** (`conf.blockers`, imza düğmesinin üstünde liste; `field` doluysa ilgili satıra kaydır):
     - `QUESTIONS_OPEN` — "Önce PİLOT'un sorularını cevapla; …"
     - `MISSING_VALUE` / `INVALID_VALUE` — satırdaki `error` ile aynı metin.
     - `INVALID_DRAFT` / `INVALID_PLAN` — "Değerler plan şemasına uymuyor; taslağı yeniden oluştur." / "Kontrat bu planı kabul etmez (InvalidPlan)."
     - `NO_DEPLOYMENT` — "Kontrat adresi okunamadı; imza kapalı."
     - `NO_AGENT_ID` — "PİLOT kaydı bekleniyor; imza kapalı." (`agentId` yok ya da `"0"`: sonradan düzeltmek F-4 yüzünden her zaman 24 saat bekletir.)
   - **Anında / 24 saat tahmini** (`conf.activation`, plan tam kurulduysa): `textTr` imza düğmesinin hemen üstünde. `immediate=false` ise `loosened` alanları listelenir ve `activeAtSec` TR saatiyle gösterilir ("… 18.10.2026 12:00 (TR saati) geçerli olur. O zamana kadar mevcut planın geçerli."). Mevcut plan etkin değilse metin bunu söyler: "Mevcut planının süresi doldu; …" ya da "Mevcut planın durduruldu; …" + "O zamana kadar PİLOT alım yapamaz." UI metni kendisi kurmaz.. Altında küçük not: "Tahmindir; gerçek sonuç zincirdeki PlanSet olayıdır."
   - **"Cüzdanla imzala"** (pencerenin içinde; **imza yalnız bu pencereden** yapılır, kartta ya da başka ekranda setPlan düğmesi yok):
     - Açılış koşulu: `conf.signable === true` (bu, `setPlanArgs !== null` demektir). Ayrıca doğru ağ (43113) ve bağlı cüzdan.
     - Çağrı: `writeContract({ address: deployments.flightPlan, abi, functionName: "setPlan", args: conf.setPlanArgs })`. `args` **başka hiçbir yerden** kurulmaz: `planToChain`'i, `draft`'ı ya da form durumunu imza için yeniden kullanma. Pencerede görünmeyen değer zincire gitmez.
     - Düğmeye basılınca pencere kilitlenir (düzeltme kapalı) ve aynı `conf` nesnesi kullanılır; cüzdan reddederse kilit açılır.
     - Pencere uzun süre açık kaldıysa (öneri: 10 dk) ya da `plans(user)` değiştiyse (`PlanSet`/`PlanRevoked` olayı) "Değerler eskidi, yenile" gösterilir ve `buildPlanConfirmation` yeniden çağrılır; düzeltmeler `applyEdit` ile yeniden uygulanır. TODO(spec): eşik SPEC'te yok.
5. **Sonuç:**
   - `PlanSet(user, planHash, immediate, activeAt)` olayı gösterilir: "Uçuş Planı zincire yazıldı — anında geçerli" ya da "… 24 saat sonra geçerli (<TR saati>)". Tahminle olay farklıysa **olay** gösterilir.
   - Snowtrace bağlantısı ve kesinleşme süresi (§3.5 ölçümü) gösterilir.
   - `PendingCleared` olayı da geldiyse "bekleyen gevşek plan silindi" notu eklenir.

**Durumlar:**
- **Yükleniyor:** "PİLOT cümleni okuyor…"
- **LLM yok:** sunucu bileşeni yalnız `ANTHROPIC_API_KEY`'in **var olup olmadığına** bakar; yoksa cümle kutusu baştan kapalıdır. Route ağ hatası / 5xx / 401 dönerse de aynı durum: "LLM yok, kural modu — yeni plan şu an oluşturulamaz" (§16 #13). Elle form **yazma**, çünkü SPEC bunu öngörmüyor (onay penceresindeki düzeltme yalnız LLM taslağı üstünde çalışır).
- **Taslak çıkarılamadı:** iki kez şema hatası (L-4) → "Taslak çıkarılamadı, tekrar dene." Route hata türünü (`llm_unavailable` / `invalid_output`) ayrı döner.
- **`fuji.json` yok/geçersiz** (`parseDeployments` hata atar): `deployments: null` ile pencere açılır, `NO_DEPLOYMENT` engeli, imza kapalı.
- **Zincir okunamadı** (`plans(user)`): pencere açılmaz, "Mevcut plan okunamadı; anında/24 saat tahmini yapılamaz" (gri).
- **Düzeltme hatası:** satırda `error`, engel listesinde aynı metin, imza kapalı; düzeltilince kendiliğinden açılır.
- **Cüzdan reddetti:** nötr bilgi gösterilir, kırmızı değil; pencere açık kalır.
- **`InvalidPlan` revert:** Türkçe hata, kırmızı değil. Revert bir "ret" değildir, bkz. §3.4. (Pencere aynı kuralları önceden uyguladığı için olmamalı; olursa `nowSec` eskimiştir → yenile.)

**Demo planı (§19):** sahne **canlı LLM ile** oynanır. Bunun için 300 / 150 / 15 / 25 değerlerini üreten bir demo cümlesi gerekir; Elif'in §1 cümlesi 1–5 penceresini verir ve bugün (17'si) `OUTSIDE_WINDOW` olur. Öneri (Seyit onaylasın, TODO(spec)): "Her ayın 15'inde maaşım yatıyor, 300 lirasının en geç 25'ine kadar dolara çevrilmesini istiyorum, tek seferde 150 liradan fazla harcama, emin olmazsan bana sor."
- **Yedek — "Demo planı yükle"** (`/demo` → `/talimat?demo=1`): LLM'i atlar. Kart 300 / 150 / 15 / 25 ile, kalanlar `PLAN_DEFAULTS` ve `askOnAmbiguity=true` ile dolar. Şema gereği alanlar `source:"user"` taşır; kartın başlığında ve her rozette **"DEMO PLANI"** görünür. Bu taslak da **aynı onay penceresinden** (`buildPlanConfirmation`) geçer; imza yine Elif'in cüzdanında ve yalnız penceredeki `setPlanArgs` ile. TODO(spec).

- **Demo:** 0:45–2:00 (CANLI). Akış: cümle → kart (kaynaklar, yapabilir/yapamaz) → imza → Snowtrace'te `PlanSet`. Ayrıca belirsiz cümle ("Maaşımın çoğu") ile imza düğmesinin kapalı kaldığı gösterilebilir. Bu imza **plansız** bir cüzdanla "anında" çıkar (bkz. §3.4, §6.1 E2).
- **Testler:** L-2 ve L-4 sahte LLM istemcisiyle (deterministik). L-1 ve L-3 için anahtar varsa çalışan, adında "CANLI" geçen ve anahtar yoksa atlanan testler. Ayrıca §16 #8, #13. Pencere mantığının testleri shared'dedir (`packages/shared/test/confirm.test.ts`: L-1, §19 demo planı, düzeltmeler, geçersiz düzeltme, F-2/F-3/F-4 tahmini); web testi yalnız şunu doğrular: imza çağrısının `args`'ı `conf.setPlanArgs` ile aynı nesnedir ve `signable=false` iken düğme kapalıdır.

### 2.3 `/panel` — ajan kendi başına (D2, ŞART; Barış destek)
- **Amaç:** PİLOT'un her turunu, Lira Hava Durumu'nu, döngü ilerlemesini, soruları, retleri ve KULE sağlığını tek ekranda göstermek. Agentic puanı ve Q1/Q4 burada kazanılır.

Bölümler ve veri kaynakları:

| Bölüm | Gösterilen | Kaynak |
|---|---|---|
| **Döngü** | `spentTL / cycleTL` çubuğu, `reservedTL` "bekleyen" olarak, döngü kimliği (YYYYMM), pencere `startDay–deadlineDay`, kalan süre | Zincir: `cycles(user)`, `plans(user)`, `trDay()` |
| **Lira Hava Durumu** | Sınıf (`WEATHER_CLASS_TEXTS`), `zd` (≥ `ZD_ALARM`=8 ise alarm), `btc1h`/`btc3h`, "FX açık/kapalı" (`fxOpen`), `px`. Fırtına sürerken "fırtına 04:15'ten beri; en erken 10:15'te biter (son alarmdan 6 sa sonra, yeni alarm uzatır)" (`episode.startTs`, `episode.endsAt`, TR saati). `src:"replay"` ise **KAYIT** etiketi. | PİLOT beslemesi (PLANLI) → `WeatherSchema` |
| **PİLOT izi** | Tur başına bir kart: `turn`, saat, mod rozeti, adımlar (≤8: araç adı, kısa girdi/çıktı, hata) ve `rationaleTr` | PİLOT beslemesi → `TraceSchema` |
| **PİLOT'un soruları** | Soru metni (`soru`) ve 2–4 düğme (`secenekler` → `parseOptionId` → `optionText`), süre geri sayımı | PİLOT beslemesi (PLANLI). Cevap: `POST` (PLANLI). |
| **Reddedilen girişimler** (kırmızı) | `BuyRejected(user, agentId, amountTL, code, reasonHash)` → `rejectText(code)` (uint8), tutar `formatTL`, Snowtrace | **Doğrudan zincirden** (§3.3 geçmiş okuma + `watchContractEvent`, `user` filtresi). PİLOT'a güven gerekmez. |
| **İzinler ve emirler** | `BuyAuthorized` ve `BuyExecuted`. `filledTL`, `avgPxE6` → `formatPxTr`, `status` → `EXEC_STATUS_TEXTS`. `BuyExecuted` gelmeden `reportBy` geçen izin için `actions(id)` okunur ve gri "rapor süresi doldu" gösterilir (`expireAction` olayı yoktur). | Zincir olayları + `actions(id)` |
| **KULE durumu ve mod** | `health` (`HEALTH_TEXTS`), `reasons` (`kuleReasonText`), CAA aktif, PİLOT nabız yaşı, veri yaşı, zincir bloğu, mod rozeti `MODE_LABELS[mode]` (DEMO / CANLI / KÂĞIT) | `kule_status` → `KuleStatusOutputSchema`, sunucu-tarafı vekil üzerinden (PLANLI, §4), 2–5 sn yoklama |
| **Bildirimler** | `BALANCE_IN_FUNDING` → "TRY fon hesabında; işlem hesabına aktarman gerekiyor." `BALANCE` → yetersiz bakiye notu. **Hedef tamam** → "Bu ayın hedefi tamamlandı." | KULE gerekçeleri (izdeki `emri_uygula` çıktısı ya da `kule_status.reasons`). Hedef tamam: zincirden `cycles(user).spentTL ≥ plans(user).cycleTL` ya da izde `bitir` adımı. `CycleClosed` ayrıca "döngü zincirde kapandı (hedef tuttu / tutmadı)" diye gösterilir; `closeCycle` yalnız son günden sonra ve biri çağırınca yayılır. |

**İz kartı ayrıntıları** (§10.3'teki "LLM gerçekten düşünüyor" anları görünmek **zorunda**):
- **Adım çıktılarını daralt.** `step.out` gevşek bir kayıttır; araç adına göre `PILOT_TOOLS[tool]` çıktı şemasıyla `safeParse` et. Parse olmuyorsa ham JSON'u gri "doğrulanmamış çıktı" olarak göster, **asla "OK" yazma**.
  - **Açık karar (Barış):** shared `TraceStepSchema` yorumu "özet" diyor ve §15 örneği özettir (`hava_durumu` yalnız `{class, zd}`, `izin_iste`'de `status` yok, `emri_uygula`'da `clOrdId`/`status`/`paper` yok). PİLOT özet yazarsa tam şemayla her adım gri çıkar. En dar seçim: `step.out` = aracın **tam** çıktısı, PİLOT yazmadan önce `PILOT_TOOLS[tool].output` ile doğrular. Mock izler bu biçimle yazılır. TODO(spec), §6.2 #1.
- **`kural_danis`:** `allowed` listesi (`optionText`) ve `recommended` vurgulu gösterilir.
- **"Önerilenden farklı seçti" rozeti** (E-5): `Trace`'te seçilen seçenek alanı yok. Barış'tan tura/adıma `chosenOptionId` istenir (shared). O gelene kadar seçim yalnız `kural_danis`'ten sonraki adımla **birebir** eşleşince türetilir: `bekle.in.dakika` → `WAIT_<n>`, `izin_iste.in` → `buyOptionId(amountTL, ordType)`, `kullaniciya_sor` → `ASK`, `bitir` → `BITIR`. Eşleşme yoksa ya da türetilen kimlik `allowed`'da değilse rozet **hiç gösterilmez**. Bu yalnız gösterimdir; güvenlik kararı değildir. Gerekçe yanında durur.
- **`teklif_al`:** `readback` metni, ör. "10.000 TL ile yaklaşık 202,6 USDT alınacak (limit 49,35, yalnız yapıcı)." `DÜZELT` kararı sarı/nötr, `RET` kırmızı gösterilir.
- **`izin_iste`:** `IzinIsteOutputSchema` duruma göre üç biçimde gösterilir:
  - `AUTHORIZED` → actionId, Snowtrace, `finalityMs` → "X,X sn'de kesinleşti"
  - `REJECTED` → **kırmızı**, `REJECT_TEXTS[out.code]` (burada `code` bir **isimdir**, ör. `"OVER_ORDER_LIMIT"`; `rejectText(number)` yalnız zincir olayının uint8 kodu içindir), Snowtrace. "İşlem başarılı, izin reddedildi" (§8.3).
  - `REFUSED` → kod koruması zincire göndermedi; mesaj gri gösterilir.
- **Retten sonra yeniden planlama:** SPEC çelişkili: §10.3(2) "tutarı böl, yeniden iste" der; ama §10.2'ye göre `izin_iste` bu turun `kural_danis` listesinde olmayan tutarı REFUSED eder ve `chunk = min(maxOrderTL, remaining)` daha küçük dilimi listede tutmaz. Gerçek sıra Barış'a sorulur (ör. REJECTED → yeniden `kural_danis` → yeni `izin_iste`). Kart **gelen sırayı** gösterir, hiçbir sırayı varsaymaz; mock iz araç korumasıyla tutarlı yazılır. TODO(spec).
- **`emri_uygula`:** `verdict`, `clOrdId`, `status`, `readback`, `reportTx` (Snowtrace). `status:"NOT_PLACED"` için `EXEC_STATUS_TEXTS`'te metin yok → web `src/lib/texts.ts`'te "Emir açılmadı" (TODO(spec): shared'e taşı). `paper:true` ise **KÂĞIT** etiketi eklenir.
- **`haberleri_oku` / `ekonomik_takvim`:** `demo:true` ise **DEMO** etiketi. Haberler `untrusted:true` olduğu için "güvenilmeyen veri" etiketiyle gösterilir.
- **Enjeksiyon:** `INJECTION_DEMO` açıkken **ENJEKSİYON DEMOSU** etiketi. Gerekçede `INJECTION_NOTE` ("Haberdeki talimatı veri olarak değerlendirdim.") görünür (E-3).
- **`bekle`:** "`untilMs`'e kadar bekliyor" (TR saati).
- **Kural modu:** `mode:"rules"` → `DEMO_LABELS.rulesMode` ("LLM yok, kural modu").
- **Hava `px`:** `WeatherSchema.px` ondalıklı `number`dır, `formatPxTr` tamsayı pxE6 ister. `formatPxTr(pxToPxE6(String(w.px)))` kullan; hata atarsa "bilinmiyor". Tercihen shared'e `formatPxNumTr(px)` eklenmesini iste. `* 1e6` yazma.

**Sorular:**
- Düğmeye basılınca bağlı cüzdan `{questionId, optionId, ts}` mesajını `signMessage` ile imzalar; `POST /api/pilot/answer` imzayı ve imzalayanın planın `user`'ı olduğunu doğrular, değilse reddeder. PİLOT aynı kontrolü ve `optionId ∈ secenekler`'i yeniden yapar. İmza yoksa cevap yok (fail-closed). TODO(spec), Barış ile.
- Cevap yeni bir tur başlatır.
- **Zaman aşımı:** SPEC çelişkili: §16 #9 "önerilen seçenek", §10.4 "yarısını al (post_only)" diyor; PRIM_SISMESI/BELIRSIZ'de önerilen zaten `ASK`. Metni UI'da sabit **yazma**: soru zarfına PİLOT'un hesapladığı `defaultOptionId` eklenir, ekranda "2 saat içinde cevap gelmezse: `optionText(parseOptionId(defaultOptionId))`" ve geri sayım (duvar saatiyle) gösterilir. Çelişki Seyit'e bildirilir.

**Durumlar:**
- **Boş:**
  - Plan yok → "/talimat'a git".
  - İz yok → "PİLOT henüz bir tur çalıştırmadı."
- **Bayat ya da bilinmeyen veri:** PİLOT beslemesi ya da KULE vekili cevap vermiyorsa ilgili kutu gri **"bilinmiyor"** gösterir; yeşil/"Hava açık"/"NORMAL" **gösterme** (fail-closed). Bayatlık zarfın duvar saati `generatedAt`'ine (yoksa vekilin yanıtı aldığı ana) göre ölçülür; 10 dk'dan eskiyse "veri bayat". `weather.ts` ile **ölçülmez**: KAYIT'ta bu simüle saattir ve ekranda "kayıt saati" diye etiketlenir (iz `ts`'i de). TODO(spec): eşik SPEC'te yok; KULE'nin `dataAgeSec`'i ayrı tutulur.
- **Zincir okunamıyor:** "Zincir okunamadı" (gri).
- **Sınıf hesaplama:** UI sınıfı **asla kendisi hesaplamaz**; sunucunun değerini gösterir. Fırtına bölümü kuralı (§11.2, CLAUDE.md #14) PİLOT'tadır.

**Demo:** 2:00–4:30 (KAYIT + CANLI).
- KAYIT 5 Ağu 2024: iz `hava_durumu → kural_danis → bekle`; geri çekilmede "hâlâ şişme".
- KAYIT 19 Mar 2025: `… → izin_iste` ("1,4 sn'de kesinleşti") `→ emri_uygula → BuyExecuted`.
- Ardından "60 dk bekle" farklı seçimi.

**Hata bölümü 4:30–6:30** (§19'un beş anı; ekran eşlemesi):
- (1a) Çalınmış anahtar → panelde kırmızı `BuyRejected(OVER_ORDER_LIMIT)` ve `STOLEN_KEY_MESSAGE`. (1b) sahte izin numarasıyla KULE → RET: **terminal**, web ekranı gerekmez.
- (2) Demo haberi → izde enjeksiyon notu.
- (3) Ayrı MCP istemcisi → RET: **terminal**.
- (4) Birim tuzağı → DÜZELT: **terminalde `kule_quote`** (iddia KULE'ye ait, §3.2 Q4). Yedek: `/servis`'teki "Birim tuzağı" düğmesi. Seçimi Seyit onaylasın.
- (5) "PİLOT'u kapat" → KULE kutusu (bkz. §2.8 CAA).

**Testler:** E-3, E-5 (gösterim), §16 #1, #4, #5–7, #9–12, #15–17, #19, #22, #24, #25.

### 2.4 `/yetkiler` — sınırlar (D3, ŞART)
- **Amaç:** zincirdeki planı insan okunur göstermek ve Elif'e sınırları üzerinde tam kontrol vermek (Q2).
- **Okunan veri:**
  - `plans(user)` → `planFromChain`, `isPlanActive(user)`
  - `pending(user)` → `{plan, activeAt}`; `activeAt==0` bekleyen yok demektir
  - `cycles(user)` → `cycleFromChain`
  - Olaylar: `PlanSet`, `PendingCleared`, `PlanRevoked`

**Düzenleme formu** (tek form, zincirdeki plandan başlar):
- Başlangıç değeri `planFromChain(plans(user))`. **Kilitli ve aynen korunur:** `agent`, `kule`, `agentId`, `bandBps`, `closedBandBps`, `expiresAt`. Yeniden hesaplanan `expiresAt` her zaman daha geç olur ve `_isTighterOrEqual` (`n.expiresAt <= o.expiresAt`) bunu gevşeme sayar; "düşür" hiç anında geçmez.
- **Düzenlenebilir:** `cycleTL`, `maxOrderTL`, `startDay`, `deadlineDay`, `maxWaitH`, `askMode`. Süreyi uzatmak ayrı, açık bir alandır ("bitiş tarihi") ve her zaman gevşemedir.
- `deadlineDay` değişince "bu değişiklik her zaman 24 saat bekler" uyarısı çıkar (F-4; azaltmak da bekler).
- Düğme metni §3.4 tahminine göre değişir: **"Sınırı düşür — anında geçer"** (F-2) ya da **"Sınırı yükselt — 24 saat bekler; eski plan o zamana kadar geçerli"** (F-3). Sonuç yine `PlanSet.immediate`'ten gösterilir.
- Bekleyen plan varsa etkin planın yanında **fark tablosu** olarak gösterilir, `pending.activeAt`'e geri sayımla.
  - Sayaç bitince "Şimdi devreye al" → `commitPending(user)`. Herkes çağırabilir; `NoPendingPlan` ve `PendingNotReady` revertleri Türkçeleştirilir.

**Diğer eylemler:**
- **"Her şeyi durdur":** onay diyaloğu → `revoke()`. Hemen etkilidir ve bekleyeni de siler. Sonrasında **verilmiş izinleri KULE düşürür** (plan etkin değil → `NO_AUTHORIZATION`, sağlık YETKİ_YOK). `BuyRejected(1 PLAN_INACTIVE)` yalnız PİLOT yeni `requestBuy` çağırırsa oluşur; gerçekten gelirse gösterilir, **varsayılmaz** (F-13, §16 #14).
- **Bekleyen silindiğinde:** `PendingCleared` geldiyse "Bekleyen gevşek plan silindi — 24 saat sonra sessizce devreye girmeyecek" notu gösterilir (§16 #26).
- **"Süresi dolan izni düşür"** → `expireAction(id)`: `reportBy` geçmiş ve `actions(id).state == AUTHORIZED` olan izinler için. Çağrılmazsa `reservedTL` takılı kalır (sonraki istekler OVER_CYCLE_TARGET, `closeCycle` `CycleNotOver` alır).
- **"Döngüyü kapat"** → `closeCycle(user)`: yalnız son gün geçtiyse ve `reservedTL == 0` ise açık. `CycleNotOver`/`CycleAlreadyClosed` Türkçeleştirilir.

**Durumlar:**
- Plan yok (`plans(user).agent == 0x0`) → "/talimat".
- Plan iptal ya da süresi dolmuş → `isPlanActive=false`, "Plan etkin değil" (gri). Bu "plan yok" **değildir**: üstüne kurulan daha gevşek plan 24 saat bekler (bkz. §3.4). Ekranda bu not durur.

- **Demo:** 7:45–8:30 — düşür (anında), yükselt (24 sa geri sayım), "her şeyi durdur".
- **Testler:** F-1…F-4, F-12, F-13 (kontrat testleri; UI aynı semantiği yansıtmalı), §16 #14, #26. Web testi: aynı plandan yalnız `cycleTL` düşürülünce tahmin = anında.

### 2.5 `/ajan` — kimlik ve servisler (D4, OLMALI)
- **Amaç:** PİLOT'un ERC-8004 kimliğini ve OKX.AI'da listelenebilir servisleri göstermek (Q3, OKX 5).
- **Veri:**
  - `fuji.json.agentId` (A3 yazar; yoksa "kayıt bekleniyor").
  - Identity kaydı `ERC8004_FUJI.identity` için Snowtrace adres bağlantısı.
  - `/agent.json` bağlantısı.
  - PİLOT ajan adresi (`fuji.json`'dan, alan adı TODO(spec), §3.3).
- **"PİLOT'u puanla" (OLURSA):** Elif'in cüzdanı Reputation `giveFeedback(agentId, int128 value, uint8 valueDecimals, "cycle", "YYYYMM", endpoint, feedbackURI, feedbackHash)` çağırır (§8.5).
  - ABI'yi elle `as const` yaz.
  - Yalnız zincire göre hedef tamamsa göster: `spentTL ≥ cycleTL` ya da `CycleClosed` geldi (en dar seçim).
- **Servis kartları:** "Emir Denetimi — ücretsiz" ve "Lira Hava Durumu — x402 (ör. 0,01 USDG)". Her kartta "OKX.AI'da listelenebilir" satırı ve `/servis`'e bağlantı olur.
- **Demo:** 6:30–7:45 (önce `/ajan`, sonra terminalde mutabakat, sonra `/servis`).

### 2.6 `/agent.json` — ERC-8004 kayıt dosyası (A3'e bağımlı)
- **Uygulama:** Route handler (`src/app/agent.json/route.ts`) ya da `public/agent.json`.
- **Biçim sabit:** Yayındaki dosyanın şekli tam olarak `data/agent-card/agent.json` olmalı; yalnız `ALANADI` geçen iki URL gerçek adreslerle değişir. `register-agent.ts` (A3) kayıttan önce bu adresi indirir ve aşağıdaki kurallara uymazsa **kayıt yapmaz**. Şema: `scripts/lib/agentCard.ts` → `AgentCardSchema` (yalnız okuma için; web bu dosyayı içe aktaramaz, çünkü `@pilot/scripts` web'in bağımlılığı değil ve derlenmiş çıktısı yok. Değerleri kopyala.)
- **Alanlar (§8.5) ve A3'ün zorladığı değerler:**
  - `type`: tam olarak `"https://eips.ethereum.org/EIPS/eip-8004#registration-v1"` [DOĞRULA]. Başka değer → ret.
  - `name`: tam olarak `"PİLOT"`. `description`: boş olmayan metin (şablondakini kullan).
  - `image`: `https://` URL'si (`public/` altına basit bir görsel).
  - `services`: **tam bir** öğe, yalnız iki anahtarla: `[{"name":"MCP","endpoint":"https://…"}]`. Fazladan anahtar ya da ikinci servis → ret. SPEC'te servisin MCP yolu yok, yalnız `/a2mcp/*` HTTP uçları var. Yol Barış'a sorulur (ör. `https://servis.<alan>/mcp`). TODO(spec).
  - `active`: boolean (`true`).
  - `registrations`: kayıttan **önce** `[]`. Kayıttan sonra en fazla bir öğe, yalnız iki anahtarla: `[{"agentId": 41, "agentRegistry":"eip155:43113:0x8004A818BFB912233c491871b3d84c89A494BD9e"}]`. `agentId` **JSON sayısıdır** (string değil; `fuji.json.agentId` string'ini `Number(...)` ile çevir, `Number.MAX_SAFE_INTEGER` üstü → yayınlama) [DOĞRULA].
  - `supportedTrust`: tam olarak `["reputation"]` [DOĞRULA]. Başka değer (ör. `"crypto-economic"`) → ret.
  - Bilinmeyen üst düzey alan eklemek serbest, ama dosyanın hiçbir yerinde `ALANADI` kalmamalı.
- **URL sabitliği:** URL **A3'ten önce sabit ve yayında olmalı**, çünkü `register-agent.ts` `agentURI = https://<web>/agent.json` değerini zincire kalıcı yazar. URL kanonik yazılmalı: küçük harfli alan adı, port yok (443), yol tam `/agent.json`, sorgu/parça/sonda `?` yok. Web'in barınağı (§6.2 #5) belli olunca Seyit'e bildir.
- **`agentId`:** kayıttan önce bilinmez. Route handler `fuji.json`'dan okur; yoksa `registrations:[]`.

### 2.7 `/servis` — OKX.AI servislerinin canlı denemesi (D4, OLMALI)
**Emir Denetimi formu:**
- **Alanlar:** `instId` (USDT-TRY), `side`, `ordType`, `sz`, `px?`, `tgtCcy?`, `niyetTL?`, `limitler.maxOrderTL?`.
- **Çağrı:** `POST <servis>/a2mcp/emir-denetimi`.
- **Sonuç:** `karar` (ONAY / DÜZELT / RET → `VERDICT_TEXTS`), `okuma`, `duzeltme?`, `gerekceler[]`, `zaman`, `kaynak`.
- **Hazır örnek düğmesi:** "Birim tuzağı: limit buy sz=10000" → DÜZELT (S-1).

**Lira Hava Durumu (x402 akışı)** — adımlar ekranda numaralı gösterilir:
1. `GET <servis>/a2mcp/lira-hava-durumu` → **402**. `PAYMENT-REQUIRED` başlığı base64 JSON'dur; çözülüp tutar, ağ ve alıcı gösterilir.
2. "Öde" → imzalanıp `PAYMENT-SIGNATURE` ile tekrar denenir.
3. **200** + `PAYMENT-RESPONSE` + veri gelir: Weather, `kaynak`, `zaman` ve `uyari` = `DATA_DISCLAIMER` ("Veridir, yatırım tavsiyesi değildir.").

**Ödeme modu:**
- `MOCK_OKX_FACILITATOR=true` (varsayılan) iken ekranda büyük **"TEMSİLİ ÖDEME"** etiketi zorunludur (`DEMO_LABELS.mockFacilitator`). Temsili modda imza adımı servis tarafından taklit edilir; tarayıcıda gerçek cüzdan imzası istenmez.
  - TODO(spec): mock'ta imzanın kim tarafından üretileceği netleşmeli; en dar seçim servis tarafından üretilmesi.
- Gerçek mod (X Layer 196, USDG) OLURSA kapsamındadır [DOĞRULA].

**Yasal not satırı:** "Türkiye'deki kullanıcılar için ücretsiz; ücret yalnız yurt dışındaki ajanlar için. Hukuki görüş değildir."

**Durumlar:**
- Servis kapalı → "Servis şu an yanıt vermiyor" (gri).
- `PAYMENT-*` başlıkları okunamıyor → büyük olasılıkla CORS sorunu, bkz. §4.

- **Demo:** 6:30–7:45 (CANLI + TEMSİLİ).
- **Testler:** S-1…S-3 (servis testleri; UI gösterir).

### 2.8 `/demo` — sahne kumandası (D5; yalnız `DEMO=1`)
- **Görünürlük ve erişim:** Sunucu bileşeninde `process.env.DEMO === "1"` değilse `notFound()`. Buna **ek olarak** sayfa ve `POST /api/pilot/demo` yalnız sunucuda tutulan operatör parolasıyla açılır (basic auth ya da httpOnly çerez; env `DEMO_OPERATOR_PASSWORD`, TODO(spec)). Yayındaki web herkese açıktır; parola yoksa URL'yi bilen herkes PİLOT'u kapatabilir. `apps/web/.env.example`'da `DEMO=0` olsun (Ek B `DEMO=1` diyor; Seyit'e bildir). Sayfanın tepesinde kalıcı **"DEMO"** şeridi bulunur.
- **Eylemler** (düğme durumu yerelden değil, besleme zarfından okunur: `pilot.alive`, `pilot.src`, `pilot.injectionDemo`):
  - **"Kayıt oynat"** — 4 senaryo: `2024-08-05` kripto şişmesi, `2025-03-19` lira zayıfladı, `2025-12-02` TL güçlendi, `2026-02-01` prim şişmesi. `data/replays/2025-10-10.json` da var (W-7, BELIRSIZ→KRIPTO); listede beşinci olarak gösterilebilir. Oynatırken panelde **KAYIT** etiketi görünür. **"Canlıya dön"** kaydı durdurur.
  - **"Demo haberi enjekte et" / "Enjeksiyonu kapat"** (`INJECTION_DEMO`): gizli metin §10.5'teki gibidir. Haber satırı **ENJEKSİYON DEMOSU** etiketli olur.
  - **"PİLOT'u kapat" / "PİLOT'u aç":** nabız durur. KULE >45 sn sonra YENİ_EMİR_YOK'a geçer, CAA ≤60 sn içinde bekleyen emri iptal eder.
    - **CAA geri sayımı PLANLI:** `kule_status` ne `timeOut`'u, ne iptal anını, ne açık emirleri veriyor; `caa.lastRenewAt` KULE'nin saatidir (tarayıcı saatiyle kıyaslama). Bekir'den `caa.timeoutSec` + `serverNowMs` (ya da `caa.cancelAt` + `serverNowMs`) ve açık emir sayısı/`clOrdId` listesi istenir; geri sayım = `timeoutSec − (serverNowMs − lastRenewAt)/1000`. O zamana kadar `pilotHeartbeatAgeSec`, `caa.active` ve izdeki son `emri_uygula` durumu gösterilir. Yerel sahte sayaç **kullanma**.
    - İptal anı sonradan `BuyExecuted(CANCELED)` ile kesinleşir.
    - CAA çalışmazsa sahne kayıttan oynatılır ve **KAYIT** etiketi gösterilir [DOĞRULA §21 #2].
  - **"Demo planı yükle"** (yedek): `/talimat?demo=1` açar (bkz. §2.2 Demo planı). Doğrudan imzalamaz.
- **Koruma:** Demo modları **hiçbir kod korumasını kapatmaz** (CLAUDE.md #12). `/demo` yalnız PİLOT'a komut iletir; kontrat ve KULE aynen çalışır.
- **Veri kaynağı:** PİLOT kontrol uçları (GAP, §4). Bu uçlar `/demo` dışında kullanılmaz.

### 2.9 `/mutabakat` — opsiyonel (D4)
- **Gerçek kontrol nerede:** Gerçek kontrol `scripts/mutabakat.ts`, **Elif'in bilgisayarında**, kendi salt-okunur anahtarıyla çalışır (§14). Demo sahnesi bunu terminalde gösterir, web'de değil.
- **Web sayfası ne yapar:** Yapılırsa **yalnız script çıktısını** gösterir. Kullanıcı JSON çıktısını yapıştırır ya da dosya yükler, sayfa bunu zod ile doğrular ve tabloya döker.
  - Sayfada şu cümle bulunur: "bu kontrol Elif'in bilgisayarında çalışır".
  - Demo/kâğıt modunda borsa tarafı KULE günlüğündendir ve bu ekranda yazılır.
- **Durumlar:**
  - EŞLEŞTİ (tutar/fiyat %0,5 içinde)
  - ZİNCİRDE VAR, BORSADA YOK (bilgi)
  - **BORSADA VAR, ZİNCİRDE YOK — ALARM** "Anahtarı hemen iptal et" (kırmızı)
  - **SONUÇ FARKLI — ALARM** (kırmızı)
- **Anahtar kuralı:** Web **OKX anahtarı kullanmaz**. Ek B'deki `OKX_READONLY_*` alanları §14 ilkesiyle çelişir; doldurma ve okuma. TODO(spec): Ek B'den kaldırılması Seyit'e önerilecek.
- **Çıktı biçimi:** script'in JSON biçimi A4'te belirlenecek; o zamana kadar sayfayı yapma ya da `M-1` durum adlarıyla yerel bir şema yaz (TODO(spec)).
- **Test:** M-1.

---

## 3. Veri sözleşmeleri

### 3.1 `@pilot/shared` — kullan, kopyalama
- **Derleme:** Paket `dist/`'ten tüketilir. `next dev`/`next build`'den önce `pnpm --filter @pilot/shared build` çalıştırılmalı (ya da `pnpm -r build`). `dist` bayat olabilir.
- **Tarayıcı güvenliği:** Paket tarayıcıda güvenlidir (`node:fs` yok).

| İhtiyaç | Export |
|---|---|
| Birim/zaman/biçim | `units.ts`: `formatTL`, `formatPxTr`, `formatDecimalTr`, `scaledToDecimal`, `pxToPxE6`, `tlFromChain`, `tlToChain`, `pxE6FromChain`, `secToMs`, `msToSec`, `chainSecFromBigInt`, `trParts`, `trDay`, `trDateToSec`, `cycleIdOf`, `cycleIdParts`, `deadlineEndSec`, `hoursToDeadline`, `TR_UTC_OFFSET_SEC` |
| Kodlar | `rejectCodeName`, `RejectCode`, `REJECT_CODE_NAMES`, `ordTypeFromChain`, `execStatusFromChain`, `actionStateFromChain`, `AskMode`, `HEALTH_STATES`, `KULE_MODES`, `WEATHER_CLASSES`, `ZD_ALARM`, `clOrdIdFor` |
| Türkçe metin | `REJECT_TEXTS`/`rejectText`, `VERDICT_TEXTS`, `HEALTH_TEXTS`, `HEALTH_REASON_TEXTS`, `kuleReasonText`, `WEATHER_CLASS_TEXTS`, `ORD_TYPE_TEXTS`, `EXEC_STATUS_TEXTS`, `MODE_LABELS`, `DEMO_LABELS`, `optionText`, `quoteReadback`, `DATA_DISCLAIMER`, `STOLEN_KEY_MESSAGE`, `INJECTION_NOTE` |
| Plan | `PlanDraftSchema`, `PlanDraft`, `PLAN_DRAFT_FIELDS`, `DRAFT_SOURCES`, `isPlanDraftSignable`, `PLAN_DEFAULTS`, `PLAN_DAY_MIN`/`PLAN_DAY_MAX` (1–28), `PLAN_EXPIRES_MAX_DAYS`, `PlanSchema`, `planToChain`, `planFromChain`, `CycleSchema`, `cycleFromChain`, `buyActionFromChain` |
| Plan onayı (`plan/confirm.ts`, §2.2 adım 4) | `buildPlanConfirmation`, `applyEdit`, `PlanConfirmation`, `PlanConfirmationContext`, `ConfirmRow`, `ConfirmBlocker`, `ConfirmBlockerCode`, `ActivationPreview`, `RowSource`, `PLAN_FIELDS`, `EDITABLE_PLAN_FIELDS`, `EditablePlanField`, `PLAN_FIELD_LABELS_TR`, `CONFIRM_BADGES_TR`, `CONFIRM_TITLE_TR`, `PENDING_DELAY_SEC` |
| Hava | `WeatherSchema`, `Weather`, `EpisodeSchema`, `EPISODE_DURATION_MS`, `WEATHER_SOURCES` |
| İz/araçlar | `TraceSchema`, `Trace`, `TraceStepSchema`, `MAX_TOOL_CALLS_PER_TURN`, `PILOT_TOOLS`, `PILOT_TOOL_NAMES`, `IzinIsteOutputSchema`, `KullaniciyaSorInputSchema`, `KullaniciyaSorOutputSchema`, `HaberleriOkuOutputSchema`, `EkonomikTakvimOutputSchema`, `BekleOutputSchema`, `KuralDanisOutputSchema` |
| Seçenekler | `parseOptionId`, `isOptionId`, `buyOptionId`, `OptionIdSchema`, `OptionSchema` |
| KULE | `KuleStatusOutputSchema`, `KuleQuoteOutputSchema`, `KuleExecuteOutputSchema`, `EXECUTE_STATUSES` |
| Dağıtım | `parseDeployments`, `DeploymentsSchema`, `FUJI_CHAIN_ID`, `ERC8004_FUJI` |

**Shared'de eksik olanlar** — web'de yerel yaz ve `TODO(spec): shared'e taşı` notu düş. Shared'i değiştirmek ekibin ortak işidir; Seyit/Barış'a söyle.
- ~~`draftToPlan`~~ **artık shared'de: `buildPlanConfirmation`** (yerel yazma). Web'de taslaktan `Plan`/`setPlan` argümanı kuran başka kod olmamalı.
  - İmza: `buildPlanConfirmation(draft: PlanDraft, ctx: { nowSec, deployments: Pick<Deployments,"pilotAgent"|"kuleReporter"|"agentId"> | null, current: Plan | null, currentActive: boolean }): PlanConfirmation`; düzeltme: `applyEdit(conf, field: EditablePlanField, value: unknown): PlanConfirmation`. İkisi de saf (ağ, disk, saat yok) ve tarayıcıda güvenli.
  - Dönen: `setPlanArgs: readonly [ChainPlan] | null` (viem `writeContract` `args`'ı; uint64/uint256 `bigint`, uint8/16 `number`; donmuş nesne; yalnız `signable` iken dolu), `rows` (§2.2 adım 4), `signable`, `blockers`, `activation` (§8.2 tahmini), `questions`.
  - Türetilen alanlar: `agent` = `pilotAgent`, `kule` = `kuleReporter` (checksum'lı), `agentId` (yok ya da `"0"` → `NO_AGENT_ID`), `bandBps=0`, `closedBandBps=500`, `askMode` = `askOnAmbiguity ? 1 : 0`, `expiresAt` = `nowSec + daysToSec(expiresInDays)`; yalnız süre kaynağı `default` iken ve `current.expiresAt > nowSec` ise `min(…, current.expiresAt)` (rozet "otomatik", satır notu); `user`/`edited` süre kırpılmaz.
  - Doğrulama: her hesapta `PlanDraftSchema` (düzeltilen alan şemaya `source:"user"` olarak gider) + `PlanSchema` + `FlightPlan._validate`'in kuralları (§3.4). Tahmin `_isTighterOrEqual` ile alan alan aynıdır (`closedBandBps` dahil).
  - `ChainPlan` (`schemas/plan.ts`) tipi de kökten dışa açıktır.
- **Kontrat özel hatalarının Türkçe metinleri:** `InvalidPlan`, `NoPlan`, `NoPendingPlan`, `PendingNotReady`, `CycleNotOver`, `CycleAlreadyClosed`, `ActionNotAuthorized`, `ReportWindowOpen` …
- **`EXEC_STATUS_TEXTS.NOT_PLACED`**, **`formatPxNumTr`**, **`formatFinalityTr(ms)`** (isteğe bağlı kolaylık).
- **PİLOT besleme zarfları:** §4.
- **`/api/plan/draft` mantığı:** `apps/pilot`'tan **import etme**: paket bir kütüphane değil (`exports` yok, `main` yan etkiyle `console.log` çalıştırır, `weather/replay.ts` `node:fs/promises` kullanır, web ona bağımlı değil). Sistem istemi + parse/yeniden deneme web route'unda yazılır; Barış isterse SDK çağrısı dışarıdan verilen saf bir fonksiyon olarak shared'e taşınır. Tek yerde yazılır.

### 3.2 `IFlightPlan` (Fuji)
- **ABI kaynağı:** `contracts/src/interfaces/IFlightPlan.sol` (A0.2'de donduruldu). Uygulama eşzamanlı değişiyor; ABI'yi **arayüzden** al.
  - `forge build` sonrası `contracts/out/IFlightPlan.sol/IFlightPlan.json`'dan `abi` alanını `apps/web/src/lib/flightPlanAbi.ts` içine `as const` olarak üret.
  - Üretimi bir script ile yap (ör. `apps/web/scripts/gen-abi.ts`); elle kopyalama.
- **Struct'lar:**
  - `Plan{uint64 cycleTL; uint64 maxOrderTL; uint8 startDay; uint8 deadlineDay; uint16 maxWaitH; uint16 bandBps; uint16 closedBandBps; uint8 askMode; uint64 expiresAt; address agent; address kule; uint256 agentId}`
  - `Cycle{uint32 id; uint64 spentTL; uint64 reservedTL; bool closed}`
  - `BuyAction{address user; uint64 amountTL; uint64 maxPxE6; uint8 ordType; uint64 openBy; uint64 reportBy; uint32 cycleId; uint8 state}`
- **Enum'lar (uint8):**
  - `OrdType` 0 POST_ONLY / 1 IOC
  - `ActionState` 0 AUTHORIZED / 1 REPORTED / 2 EXPIRED (0 aynı zamanda "yok" anlamına gelir; `user != 0` kontrol et)
  - `ExecStatus` 0 FILLED / 1 PARTIAL / 2 CANCELED / 3 EXPIRED
  - `RejectCode` 0 NONE, 1–7
- **Elif'in çağırdıkları:** `setPlan(Plan)`, `commitPending(address)`, `revoke()`; ayrıca `/yetkiler`'de `expireAction(uint256)` ve `closeCycle(address)` (§2.4).
  - UI **asla** `requestBuy` ya da `reportExecution` çağırmaz.
- **View'lar:** `plans`, `pending` (→ `(plan, activeAt)`), `cycles`, `cycleOf`, `actions`, `isPlanActive`, `currentCycleId`, `trDay`.
- **Olaylar** (`user` = bağlı adres ile filtrele):
  - `PlanSet(user, planHash, immediate, activeAt)`, `PlanRevoked(user)`, `PendingCleared(user)`
  - `BuyAuthorized(actionId, user, agentId, amountTL, maxPxE6, ordType, openBy, reasonHash)`
  - `BuyRejected(user, agentId, amountTL, code, reasonHash)`
  - `BuyExecuted(actionId, user, ordId, filledTL, avgPxE6, status, reportHash)`
  - `CycleClosed(user, cycleId, spentTL, ok)`
  - `expireAction` olay yaymaz; durum `actions(id)` ile okunur.
- **Özel hatalar** (viem `decodeErrorResult` ile çöz ve Türkçe göster): `NotAgent`, `NotKule`, `OverFilled`, `ActionNotAuthorized`, `ReportWindowClosed`, `ReportWindowOpen`, `InvalidPlan`, `NoPlan`, `NoPendingPlan`, `PendingNotReady`, `CycleNotOver`, `CycleAlreadyClosed`, `InvalidStatus`, `ValueNotAccepted`.

### 3.3 `deployments/fuji.json`
- **Okuma:** `fetch(process.env.NEXT_PUBLIC_DEPLOYMENTS_URL)` → `.text()` → `parseDeployments(text)`. Hata atarsa fail-closed: imza ve zincir okuma kapanır, "Kontrat adresi okunamadı" gösterilir.
- **Şu anki şema:** `{chainId:43113, flightPlan, erc8004{identity,reputation,validation}, agentId?}`. `DeploymentsSchema` bir `z.object`'tir, **bilinmeyen anahtarları atar**: dosyaya `agent`/`kule` eklemek yetmez.
- **PLANLI / TODO(spec)** (shared işi, Seyit, §6.2 #4): şemaya PİLOT ajan adresi, KULE adresi (adlar Seyit ile, ör. `pilotAgent`, `kuleReporter`) ve `deployBlock` eklenir. Adres kaynağı tektir: `fuji.json` (env `NEXT_PUBLIC_PILOT_ADDRESS` vb. **kullanma**; Ek B'de yok). Alanlar gelene kadar imza kapalıdır.
- **Olay geçmişi:** `deployBlock`'tan başlayıp parçalı `getLogs` (ör. 2048 blok; herkese açık Fuji RPC aralığı sınırlar), sonra `watchContractEvent`. `deployBlock` yoksa ya da bir parça okunamazsa geçmiş listesi gri "Zincir okunamadı"; yeni olay izleme sürer. Genesis'ten tarama yapma.
- **Durum:**
  - Dosya **henüz yok**: `contracts/script/` boş, `deployments/` boş.
  - `apps/web/public/` altında da yok. `NEXT_PUBLIC_DEPLOYMENTS_URL=/deployments/fuji.json` bu yüzden 404 döner.
- **En dar seçim:** `apps/web/scripts/sync-deployments.ts`, `predev`/`prebuild` sırasında `../../deployments/fuji.json`'u `public/deployments/fuji.json`'a kopyalar. Dosya yoksa build kırılmaz, sayfa fail-closed gösterir.
- **Yerel geliştirme:** düz Anvil chainId 31337'dir ve parser bunu reddeder (doğru davranış, değiştirme). `anvil --fork-url $FUJI_RPC` kullan (chainId 43113 ve ERC-8004 kayıtları korunur; ya da `anvil --chain-id 43113`). Cüzdana ağ olarak `http://127.0.0.1:8545`, chainId 43113 eklenir; `NEXT_PUBLIC_FUJI_RPC` buna çevrilir.

### 3.4 Birimler ve doğrulama (CLAUDE.md #7, #8)
- **Birimler:**
  - TL **tam lira** (tamsayı).
  - Fiyat **pxE6** (49,35 → 49350000). Hava `px` ondalıklı number'dır (§2.3).
  - Zincir **saniye**, OKX/iz/hava **ms**.
- **Dönüşüm:** Her dönüşüm yalnız `packages/shared/units.ts` üzerinden yapılır. Web'de `* 1e6`, `/ 1000`, `new Date().getTimezoneOffset()` ya da `toLocaleString("tr-TR", {timeZone})` **yazma**.
- **Saat:** Türkiye saati sabit UTC+3'tür; TR saati göstermek için `trParts` kullan. Eksik bir biçimleyici gerekiyorsa (ör. "04:15") shared'e eklenmesini iste ya da web'de `trParts` üstüne ince bir sarmalayıcı yaz.
- **`sz` hesabı yapma:** `limitBuySz`/`marketBuySzTL` KULE'ye aittir (CLAUDE.md #9).
- **İmza öncesi önkontrol** (kontratın `_validate`'i ile aynıdır):
  - `cycleTL > 0`
  - `0 < maxOrderTL ≤ cycleTL`
  - `1 ≤ startDay ≤ deadlineDay ≤ 28`
  - `askMode ∈ {0,1}`
  - `expiresAt > now`
  - `agent ≠ 0`, `kule ≠ 0`
- **Anında / 24 sa tahmini** (§8.2, `_isTighterOrEqual`):
  - **"Plan yok" = `plans(user).agent == 0x0`** (hiç plan kurulmamış) → anında. İptal edilmiş ya da süresi dolmuş plan (`isPlanActive=false`) **hâlâ karşılaştırma tabanıdır** (kontrat TODO(spec)).
  - Taban varsa aşağıdakilerin **hepsi** sağlanırsa anında, değilse 24 sa:
    - `cycleTL`, `maxOrderTL`, `maxWaitH`, `expiresAt` küçük ya da eşit
    - `startDay`, `askMode` büyük ya da eşit
    - `bandBps` **ve** `closedBandBps`: 0→>0 sıkılaştırmadır; ikisi de >0 ise yeni değer eskiden küçük ya da eşit olmalı
    - `deadlineDay`, `agent`, `kule`, `agentId` **aynı** (F-4)
  - Sonuç: süresi dolmuş plan üstüne her plan 24 saat bekler (`expiresAt` mecburen daha geç). İptal edilen planın üstüne daha gevşek plan da 24 saat bekler; ekranda bu not durur.

  UI tahmini yalnız bilgidir; **gerçek sonuç `PlanSet.immediate`'tir**, ekranda onu göster.

### 3.5 Cüzdan
- **Kütüphaneler:** wagmi v3 + viem + react-query (kurulu).
- **Zincir:** viem `avalancheFuji` (43113). RPC `NEXT_PUBLIC_FUJI_RPC` (varsayılan `https://api.avax-test.network/ext/bc/C/rpc`), gezgin `https://testnet.snowtrace.io`.
- **Bağlayıcı:** `injected()` / EIP-6963 keşfi. Core ve MetaMask ikisi de enjekte sağlayıcıdır. Ek bağlayıcı paketi (WalletConnect vb.) **ekleme**.
  - [DOĞRULA]: wagmi v3'te `injected`/`metaMask` bağlayıcılarının hangi paketten geldiğini `node_modules/wagmi` içinden kontrol et.
- **Next.js uyarısı:** `apps/web/AGENTS.md` uyarısı geçerli: Next.js 16.4.2 eğitim verinizden farklı. Kod yazmadan önce `apps/web/node_modules/next/dist/docs/` oku. `next.config.ts`'te `cacheComponents: true` açık; istemci sağlayıcıları (`WagmiProvider`, `QueryClientProvider`) `"use client"` bir `providers.tsx` içinde olmalı.
- **Kesinleşme ölçümü:** `writeContract` hash dönünce zaman damgası alınır, `waitForTransactionReceipt({hash, pollingInterval: 250})` dönünce fark hesaplanır. viem'in Fuji varsayılanı 4 sn yoklamadır (`avalancheFuji`'de `blockTime` yok); değiştirilmezse yoklama gecikmesi ölçülür. Ekranda yöntem yazar: "gönderimden makbuza". Bu, Elif'in kendi işlemleri içindir; PİLOT'un `izin_iste` işlemleri için yalnız `out.finalityMs` kullanılır.

---

## 4. Arka uç uç noktaları — VAR ve PLANLI

**Kural:** PLANLI olanları bekleme. `apps/web/src/lib/feeds/` altında bir arayüz tanımla (ör. `PilotFeed`, `KuleStatusSource`, `ServisClient`), iki uygulama yaz:
- `mock`: sabit veri; replay'den ya da elle yazılmış `Trace`/`Weather` örnekleri, **shared zod şemalarıyla `parse` edilmiş** (iz adımları tam araç çıktısıyla, §2.3)
- `http`: gerçek

Seçim `NEXT_PUBLIC_FEED=mock|http` ile yapılır. Mock açıkken ekranda **"TEMSİLİ VERİ"** etiketi zorunludur, çünkü demo modu görünür etiketlenmelidir. TODO(spec): bu etiket adı SPEC'te yok; en dar seçim.

| Uç | Durum | Kim / SPEC adımı | Sözleşme | Web nasıl bağlanır |
|---|---|---|---|---|
| `POST /api/plan/draft` (web route handler) | **PLANLI — web'in kendisi yapar** | Web (D1) + mantık C6 `planFromSentence` | Girdi `{sentence: string (≤ 500), answers?: {question, answer}[]}` (TODO(spec)), çıktı `PlanDraft` ya da `{error: "llm_unavailable" \| "invalid_output"}` | Sunucu tarafı; `@anthropic-ai/sdk` web'e eklenir. Model `LLM_MODEL`. Anahtar yalnız sunucuda. Mantık web'de (§3.1); testler L-1…L-4 adıyla. |
| Fuji RPC (view + olaylar) | **VAR** (kontrat deploy edilince) | A2 (Seyit) | §3.2 | Tarayıcıdan doğrudan, viem/wagmi; geçmiş §3.3 |
| `deployments/fuji.json` | **PLANLI** | A2/A3 (Seyit) | `DeploymentsSchema` (+ §3.3 eklemeleri) | §3.3 |
| `kule_status` (MCP Streamable HTTP, `127.0.0.1:8787/mcp`, Caddy `kule.ALANADI.com`, bearer) | **PLANLI** (`apps/kule` yalnız stub) | B3 (Bekir) | `KuleStatusOutputSchema` (+ §2.8 CAA eklemeleri) | **Yalnız sunucu tarafı vekil:** `GET /api/kule/status` route handler'ı MCP istemcisi olarak **yalnız `kule_status`** çağırır, sonucu zod ile doğrular ve döner. Token sunucu `.env`'inde kalır, tarayıcıya **gitmez**. Diğer `kule_*` araçları vekilde **yoktur**. |
| PİLOT beslemesi: iz, hava, sorular, durum | **GAP** — SPEC port/HTTP tanımlamıyor | Barış (C5/C7) ile karar | Önerilen zarf aşağıda | Web sunucu tarafı vekil `GET /api/pilot/feed?user=` kullanır (SSE ya da 5 sn yoklama). |
| Soru cevabı | **GAP** | Barış | `{questionId, optionId, ts, signature}` | `POST /api/pilot/answer`: imzalayan = plan `user` mı doğrular, sonra PİLOT'a iletir; PİLOT imzayı ve `optionId ∈ secenekler`'i yeniden doğrular (§2.3). Cevap yalnız bir seçenek kimliğidir; panele yürütme gücü vermez. |
| `/demo` kontrolleri | **GAP** | Barış | `{action:"replay", day} \| {action:"live"} \| {action:"inject", on:boolean} \| {action:"stop"} \| {action:"start"}` | `POST /api/pilot/demo`, yalnız `DEMO=1` **ve** operatör parolasıyla (§2.8). Web→PİLOT paylaşılan gizliyle. |
| Servis: `POST /a2mcp/emir-denetimi`, `GET /a2mcp/lira-hava-durumu` (8790, Caddy `servis.ALANADI.com`) | **PLANLI** (yalnız stub) | C8 (Barış) | §12; shared zod şeması **yok** (GAP) → web'de yerel şema, TODO(spec) | Tarayıcıdan doğrudan çağrı CORS ve `Access-Control-Expose-Headers: PAYMENT-REQUIRED, PAYMENT-RESPONSE` ister. En dar seçim: sunucu tarafı vekil `/api/servis/*`, başlıkları da aktarır. |
| `scripts/mutabakat.ts` çıktısı | **PLANLI** | A4 (Seyit) | Henüz biçim yok | §2.9; web'e ağ ucu yok |

**Yeni env'ler** (hepsi TODO(spec), Ek B'de yok; `apps/web/.env.example`'a boş alan olarak eklenir; gizlilere `NEXT_PUBLIC_` öneki **verilmez**):

| Env | Gizli mi | Ne |
|---|---|---|
| `KULE_URL` | hayır (sunucu) | KULE MCP adresi; web VPS dışındaysa `https://kule.ALANADI.com/mcp` |
| `KULE_STATUS_TOKEN` | **evet** | `kule_status` için token (`DEMO_CLIENT_TOKEN` mı ayrı salt-okunur mu, §6.2 #3) |
| `PILOT_FEED_URL` | hayır (sunucu) | PİLOT besleme/kontrol taban adresi |
| `PILOT_CONTROL_SECRET` | **evet** | web↔PİLOT paylaşılan gizli |
| `DEMO_OPERATOR_PASSWORD` | **evet** | `/demo` erişimi |
| `SERVIS_URL` | hayır (sunucu) | servis taban adresi |
| `NEXT_PUBLIC_FEED` | hayır | `mock` \| `http` |

**Önerilen PİLOT besleme zarfı** — web'de yerel tanımla, `TODO(spec): Barış ile kesinleştir, shared'e taşı`. SPEC'te yok; mevcut shared şemalarını **sarmalar**:

```ts
// apps/web/src/lib/feeds/pilot.ts — TODO(spec)
PilotFeedSchema = z.strictObject({
  generatedAt: UnixMsSchema,            // DUVAR saati; bayatlık bununla ölçülür
  pilot: z.strictObject({
    alive: z.boolean(),                 // nabız
    mode: z.enum(TRACE_MODES),          // "llm" | "rules"
    injectionDemo: z.boolean(),
    src: z.enum(WEATHER_SOURCES),       // "live" | "replay" → KAYIT
    replayDay: z.string().nullable(),
  }),
  weather: WeatherSchema.nullable(),    // KAYIT'ta weather.ts simüle saat
  traces: z.array(TraceSchema),         // son N tur, yeni → eski; KAYIT'ta ts simüle saat
  questions: z.array(z.strictObject({
    questionId: z.string(),
    soru: z.string(),
    secenekler: KullaniciyaSorInputSchema.shape.secenekler,
    defaultOptionId: OptionIdSchema,    // zaman aşımında PİLOT'un uygulayacağı
    askedAt: UnixMsSchema,              // DUVAR saati
    timeoutAt: UnixMsSchema,            // DUVAR saati, askedAt + 2 sa
    answered: z.boolean(),
  })),
});
```

Hangi alanın simüle saatle geldiği zarfta sabittir (yukarıdaki yorumlar); Barış farklı seçerse burası güncellenir. `KULE_EXEC=paper` bilgisi `kule_status.mode === "paper"` → **KÂĞIT** üzerinden gelir. `MOCK_OKX_FACILITATOR` bilgisi servis yanıtından gelir; servis kendi yanıtında `mock:true` gibi bir alan vermeli (TODO(spec), Barış ile).

---

## 5. Zorunlu kurallar (UI)

1. **Metin dili:** Kullanıcıya görünen her metin Türkçe; kod tanımlayıcıları İngilizce (CLAUDE.md #10). Metinleri önce `@pilot/shared/texts` içinde ara; yoksa web'de tek bir `src/lib/texts.ts` dosyasında topla.
2. **Mod etiketleri her zaman görünür** (CLAUDE.md #12, §19). Etiketler küçük not değil, rozettir; header'da ve ilgili kutuda tekrarlanır:
   - `INJECTION_DEMO` → "ENJEKSİYON DEMOSU"
   - `KULE_EXEC=paper` → "KÂĞIT"
   - `MOCK_OKX_FACILITATOR` → "TEMSİLİ ÖDEME"
   - replay → "KAYIT"
   - OKX demo hesabı → "DEMO"
   - canlı → "CANLI"
   - kural modu → "LLM yok, kural modu"
   - mock besleme → "TEMSİLİ VERİ"
   - demo planı → "DEMO PLANI"

   Demo modları hiçbir korumayı kapatmaz.
3. **Tarayıcıda borsa anahtarı ya da ajan/KULE token'ı yok** (CLAUDE.md #4, #5, #6):
   - `ANTHROPIC_API_KEY`, `OKX_*`, KULE/PİLOT token'ları ve gizlileri yalnız sunucu env'inde durur; `NEXT_PUBLIC_` önekiyle **asla** tanımlanmaz.
   - Web hiçbir OKX çağrısı yapmaz ve çekim kodu yoktur.
   - Hiçbir anahtarı günlüğe, teste ya da commit'e yazma; `.env.example`'a yalnız boş alan ekle.
4. **LLM çıktısı zod ile doğrulanır** (CLAUDE.md #1). `/api/plan/draft` `PlanDraftSchema` dışında hiçbir şey döndürmez (hata zarfı hariç). Panelde gösterilen iz de `TraceSchema` ile doğrulanır; doğrulanmayan tur "doğrulanmamış" etiketiyle gri gösterilir. Güvenlik kararı LLM'e bırakılmaz: imza düğmesinin açılması `isPlanDraftSignable` ve kod önkontrolüne bağlıdır, LLM'in "imzalanabilir" demesine değil.
5. **Fail-closed gösterim** (CLAUDE.md #2):
   - Bilinmeyen, bayat, parse olmayan ya da ağ hatası veren her durum "bilinmiyor/okunamadı" (gri) gösterilir.
   - **"NORMAL", "Hava açık", "EŞLEŞTİ", yeşil tik asla varsayılan değer olmaz.**
   - Sınıfı, sağlığı ya da ret kodunu UI kendisi tahmin etmez.
   - `rejectCodeName` 0/bilinmeyen kodda hata atar; yakala ve "bilinmeyen ret kodu" göster (kırmızı, çünkü yine ret).
6. **Renk:** Kırmızı yalnız ret (`BuyRejected`, KULE RET, `izin_iste` REJECTED) ve alarm (mutabakat ALARM, `zd ≥ 8` alarm, KULE YETKİ_YOK) içindir. Revert, cüzdan reddi ve ağ hatası kırmızı değildir.
7. **İsimler:** yalnız Uçuş Planı, PİLOT, KULE, Lira Hava Durumu (+ Ek E sözlüğü: İzin, Mutabakat, CAA, zd, yapıcı/alıcı, A2MCP, x402). Yeni terim uydurma. "Akıllı kasa", "bot", "vault", "AI asistan" gibi adlar kullanma.
8. **Yatırım tavsiyesi tonu yok:** kâr iddiası, "kazandırır" dili yok (§20). Veri ekranlarında `DATA_DISCLAIMER` bulunur.
9. **§22 kesilenler — YAPMA:**
   - zincir eli / Kasa / passkey / vault
   - iki kullanıcı akışı
   - smart money
   - haberle işlem
   - "öğrenen ajan" katmanları, NOTAM, terfi
   - yalnız-Pyth sınıflandırma
   - KULE'nin ajanı notlaması
   - anahtar tutan pazar yeri servisi
   - satış yönü (USDT→TL)
   - mainnet

   Yol haritası öğeleri UI'da "yakında" kartı olarak da gösterilmez.
10. **Testler** (CLAUDE.md #11): her davranışa test yazılır. SPEC kimliği olan testlerde ad kimlikle başlar ("L-2 belirsiz cümlede imza kapalı"). Kimliksiz web testleri için açıklayıcı Türkçe ad kullanılır. Canlı LLM testleri adında "CANLI" taşır ve anahtar yoksa atlanır. `package.json`'da `vitest run` tanımlı ama `vitest` devDependency olarak **ekli değil**; ekle.
11. **Altyapı:** Ortak VPS'te güvenlik duvarına ve başka servislerin portlarına dokunma (CLAUDE.md #15). Web için port seçerken mevcutları `ss -tlnp` ile kontrol et.

---

## 6. Yapım sırası, bitti kriterleri, açık sorular

### 6.1 Sıra (§17.2 Aşama D, §17.3 kontrol noktaları)

| Adım | İçerik | Bağımlılık | Bitti kriteri |
|---|---|---|---|
| **D0** (hazırlık) | `providers.tsx` (wagmi + react-query, Fuji), `fuji.json` senkron script'i, ABI üretimi, ortak bileşenler (`TxLink`, `FinalityBadge`, `ModeBadge`, `RejectRow`, `UnknownState`), `vitest` kurulumu, `feeds/` mock'ları | shared `dist` | `pnpm --filter web build` ve `pnpm --filter web test` geçer; mock beslemeyle tüm sayfa iskeletleri açılır |
| **D1** (K2'ye kadar) | `/` + `/talimat` (`/api/plan/draft`, kart, `draftToPlan`, önkontrol, `setPlan`, `PlanSet` gösterimi) | `fuji.json` (A2) + ajan/KULE adresleri ve `agentId` (A3, §3.3); öncesinde Fuji çatallı Anvil | L-2/L-4 sahte istemciyle geçer; "Maaşımın çoğu" → imza kapalı; `agentId` yokken imza kapalı; Fuji'de gerçek `setPlan` → Snowtrace bağlantısı + kesinleşme süresi ekranda |
| **D2** (K3) | `/panel`: döngü, hava, iz, sorular, retler, KULE kutusu | PİLOT beslemesi (GAP → mock), KULE B3 | Mock izle §19 2:00–4:30 sahnesi ekranda baştan sona oynar (5 Ağu bekle, 19 Mar izin → emir, 60 dk farklı seçim, enjeksiyon notu); `BuyRejected` zincirden kırmızı gelir; besleme kapatılınca kutular "bilinmiyor" olur |
| **D3** (K3) | `/yetkiler` | kontrat | Fuji'de mevcut plandan düşür → `immediate=true`; yükselt → pending + geri sayım (önceki bekleyen varsa `PendingCleared`); durdur → `PlanRevoked`, KULE kutusunda YETKİ_YOK, bekleyen silinir |
| **D4** (K3) | `/ajan`, `/agent.json`, `/servis`; `/mutabakat` opsiyonel | A3, C8 | `/agent.json` geçerli JSON ve sabit URL; Emir Denetimi `sz=10000` → DÜZELT; 402 → TEMSİLİ ödeme → veri + uyarı, "TEMSİLİ ÖDEME" görünür |
| **D5** (K3) | `/demo` | PİLOT kontrol uçları (GAP), `kule_status` CAA alanları (Bekir) | `DEMO≠1` iken 404; parolasız erişim yok; dört kayıt seçilebilir ve "canlıya dön" çalışır; "PİLOT'u kapat"/"aç" çalışır; CAA alanları geldiyse KULE kutusunda gerçek geri sayım |
| **E1–E2** | Uçtan uca ve iki tam prova | herkes | §17.2 E1 akışı Fuji'de; her sahnenin ekran kaydı; **her prova ve sahne için plansız (yeni) bir Elif cüzdanı** — önceki prova planı (iptal edilmiş olsa da) 0:45 imzasını "24 saat sonra"ya çevirir (§3.4) |
| **K4** | yeni özellik yok | — | — |

**Öncelik** (§17.1):
- **ŞART:** `/talimat`, `/panel` (iz), `/yetkiler`
- **OLMALI:** soru akışı, `/servis`, `/mutabakat`
- **OLURSA:** gerçek x402, ERC-8004 puanı

Zaman daralırsa D4/D5'ten kes, D1–D3'ten kesme.

### 6.2 Açık sorular / TODO(spec) / [DOĞRULA]

Kime sorulacağı parantez içinde:

1. **PİLOT↔web taşıma katmanı ve iz biçimi** (Barış): port, `GET feed`, `POST answer` (cüzdan imzası), `POST demo` (start/stop/live/inject), kimlik doğrulama. `step.out` tam araç çıktısı mı (öneri: evet)? `chosenOptionId` alanı, soru `defaultOptionId`'si, zarfın `generatedAt` ve saat alanları. Ret sonrası gerçek araç sırası (§10.2 ↔ §10.3 çelişkisi). §4'teki zarf öneridir.
2. **`/api/plan/draft`** (Barış): mantık web route'unda yazılıyor (§3.1); shared'e saf fonksiyon olarak taşınacaksa söylesin. `apps/pilot`'tan import yok.
3. **`kule_status`** (Bekir): web'in token'ı (`DEMO_CLIENT_TOKEN` mı, ayrı salt-okunur mu; yürütme yapamamalı). CAA geri sayımı için `caa.timeoutSec` + `serverNowMs` (ya da `cancelAt`) ve açık emir sayısı/`clOrdId` listesi.
4. **`fuji.json` / `DeploymentsSchema`** (Seyit, A2/A3): ajan ve KULE adres alanları, `deployBlock`. `draftToPlan` ve imza bunlara bağlı.
5. **Web nerede çalışacak** (ekip, A3'ten önce): Vercel mi VPS mi? PİLOT/KULE vekilleri ve `/agent.json` URL'si buna bağlı. VPS seçilirse: `ss -tlnp` ile boş port, Caddy'de ayrı alt alan adı, güvenlik duvarına dokunma. Vercel seçilirse PİLOT beslemesi Caddy + bearer ile dışarı açılmalı (yeni yüzey). Karar `/agent.json` URL'siyle Seyit'e bildirilir.
6. **Servis** (Barış): `SERVIS_URL`, CORS ya da web vekili, servis zod şemaları shared'e girecek mi, MCP uç yolu (`/agent.json` için).
7. **Ek B web `.env`'i** (Seyit): `OKX_READONLY_*` §14 ile çelişiyor (web kullanmayacak, kaldırılmalı); `DEMO=1` varsayılanı → `DEMO=0` önerisi; §4'teki yeni env'ler.
8. **Mutabakat çıktı biçimi** (Seyit, A4).
9. **SPEC çelişkileri** (Seyit): soru zaman aşımı varsayılanı (§16 #9 ↔ §10.4); ret sonrası dilimleme (§10.3 ↔ §10.2); Q1/Q4 dakika sınırı (§3.2 4:15 ↔ §19 4:30); sahne metnindeki saatler UTC (ekran TR saati).
10. **Demo cümlesi** (Seyit): 300 / 150 / 15 / 25 üreten cümle (§2.2 önerisi) ve birim tuzağı (4)'ün terminalde mi `/servis`'te mi gösterileceği.
11. **Kart:** düzenlenebilirlik seçimi, "senin düzeltmen" rozeti, "ne yapabilir / ne yapamaz" metni (§2.2); Seyit onaylasın.
12. **Bayat veri eşiği** (hava 10 dk önerisi) ve mock besleme etiketi "TEMSİLİ VERİ".
13. **[DOĞRULA]:**
    - OKX TR demo hesabı var mı? Mod etiketi DEMO/CANLI/KÂĞIT buna bağlı (§21 #1, B1 sonucu).
    - CAA TR spot'ta çalışıyor mu (§21 #2)? Çalışmıyorsa "PİLOT'u kapat" sahnesi KAYIT.
    - `ekonomik_takvim` TR erişimi (§21 #10): yoksa takvim DEMO etiketli.
    - x402 gerçek mod paket/başlıkları (§21 #6).
    - TL fon mu işlem hesabına mı düşüyor (§21 #9): `BALANCE_IN_FUNDING` bildirimi.
    - wagmi v3 bağlayıcı paketleri.
    - ERC-8004 kayıt dosyasında `type`/`supportedTrust` değerleri.
14. **Dürüstlük notları** (§19) ekranda desteklenmeli:
    - KAYIT sahnesinde "karar geçmiş fırtınanın verisinden, emir bugünün fiyatıyla" alt yazısı.
    - Cumartesi canlı modda her yükselişin PRIM_SISMESI çıkacağı notu (hava kutusunda `fxOpen=false` iken "FX kapalı — yükselişler prim şişmesi sayılır").
