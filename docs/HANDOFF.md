# Devir notu — yeni bilgisayarda/oturumda buradan devam

> Tarih: 2026-10-17 (hackathon günü). Yeni Claude Code oturumu açınca: **önce `CLAUDE.md`, sonra bu dosyayı oku.**
> Tek doğru kaynak hâlâ `docs/SPEC.md` (v4.1). UI işi için `docs/UI_HANDOFF.md`, deploy için `docs/DEPLOY.md`.

## 1. Yeni bilgisayarda kurulum

```bash
git clone git@github.com:sayweer/idlo.git && cd idlo
pnpm install            # kontrat kütüphaneleri de (OZ, Solady, forge-std) node_modules'a gelir
pnpm -r build && pnpm -r test
cd contracts && forge build && forge test && cd ..
```

- `apps/pilot/.env` repoda **yok** (gitignore). `apps/pilot/.env.example`'dan kopyala, `ANTHROPIC_API_KEY`'i kendin yaz.
  Not: `sk-ant-usr-…` biçimli bir anahtar workspace'e bağlı değilse API `anthropic-workspace-id` başlığı ister; workspace içinde oluşturulmuş anahtar kullan.
- Anahtarları asla koda/teste/commit'e yazma (CLAUDE.md kural 5).

## 2. Durum (hepsi `main`'de, testler yeşil)

| Parça | Durum | Test |
|---|---|---|
| `packages/shared` — units, §15 şemaları, ret/verdict kodları, KULE/PİLOT araç şemaları, deployments okuyucu, `authz.ts`, `weather/` (Lira Hava Durumu hesaplayıcısı), `plan/` (onay penceresi) | ✅ | 143 |
| `contracts` — `IFlightPlan`, `FlightPlan.sol` (A1), `Deploy.s.sol` (A2) | ✅ Fuji'ye henüz deploy edilmedi | 118 |
| `apps/pilot` — weather replay, `rules/` (kural_danis C3), `plan/` (planFromSentence C6, LLM), `tools/` + `clients/` (C4; MCP KULE istemcisi + FakeKule), `loop/` + `trace/` (C5; kural modu), `news/` + `calendar/` (C7) | ✅ | 531 (+3 canlı LLM, anahtar yoksa atlanır) |
| `apps/servis` — Emir Denetimi + Lira Hava Durumu, temsili 402 (C8) | ✅ | 63 |
| `scripts/` — `make-replay.ts`, `register-agent.ts` (A3), `stolen-key.ts` + `mutabakat.ts` (A4) | ✅ | 308 |
| `scripts/e2e.ts` (anvil'de uçtan uca, E1-yerel) | ❌ **yazılmadı** — workflow durduruldu | — |
| `apps/kule` (B2–B7) | ❌ Bekir abi | — |
| `apps/web` (D1–D5) | ❌ Bekir abi — bkz. `docs/UI_HANDOFF.md` | — |

## 3. Çalışma kuralları (ekip kararları)

- **Commit:** her anlamlı değişiklikte yerel commit; conventional commits, Türkçe açıklama. Her commit'in sonuna:
  ```
  Co-authored-by: Barış <barisyzici@gmail.com>
  Co-authored-by: Bekir Erdem <62079983+bekirerdem@users.noreply.github.com>
  ```
  **Claude atıfı yok** (Co-Authored-By Claude, Claude-Session, 🤖 satırları YASAK). Push'u kullanıcı yapar.
- **Ana oturum yönetir, kodu alt ajanlar/workflow yazar;** her görev: yaz → saldırgan testler → 2 mercekle inceleme → doğrulama → düzeltme → bağımsız test.
- **UI (`apps/web`) ve KULE (`apps/kule`) Bekir abinin;** bizim taraf bunlara kod yazmaz, sözleşmeleri sabit ve belgeli tutar.

## 4. Verilmiş kararlar

1. **KULE yetki bağı (güvenlik, doğrulandı):** Kontrat herkesin kendi planını kurmasına izin veriyor; KULE yalnız `BuyAuthorized` var mı diye bakarsa çalınmış ajan anahtarıyla yabancı bir plan kullanıcının hesabında emir açtırabilir. Çözüm `packages/shared/authz.ts`: `checkActionOwner` (kilitten önce) + `checkActionLive` (sağlıktan sonra); `apps/kule/.env.example`'da `PLAN_USER_ADDRESS`, `PILOT_AGENT_ADDRESS`. **KULE bunları `kule_execute`'ta çağırmadıkça açık kapanmış sayılmaz.** CLAUDE.md kural 3'e işlendi. Açık TODO: kullanıcının son PlanSet/PlanRevoked'ından eski BuyAuthorized reddedilmeli.
2. **planFromSentence LLM'li kalıyor** + imzadan önce **onay penceresi** ("Zincire yazılacak değerler"): değerler + kaynak rozeti (senin cümlenden / varsayılan / senin düzeltmen), düzeltme yeniden doğrulanır, imza yalnız `packages/shared/plan` çıktısından. Pencere UI'ı Bekir abide.
3. **Kontrat kütüphaneleri npm** (pnpm workspace).
4. **Süresi dolan planın yerine gelen yeni plan 24 sa bekler** (fail-closed; TODO(spec)). Demoda planı sahneden ≥24 sa önce kur.
5. **Koul** yalnız fikir kredisi; kodu kullanılmıyor. Not: Koul'da 24 sa kilidi yok, o fikir bizim — sunumda "Koul'dan kredi"yi yalnız "kural kullanıcının isteğinden şekillenir" ile sınırla.
6. **Kara Kutu (sicil + öğrenme) şimdilik iptal.** (SPEC §22 de öğrenen katmanları kesmişti.)

## 5. Açık sorular / karar bekleyenler

- **KARAR (2026-10-17, Seyit onayladı): Ajan seçme sohbeti + ERC-8004 eşiği MVP'si yapılacak** (ekibe haber verilecek; SPEC §22 "pazaryeri/iki kullanıcı" ile kısmen çelişir). Dar MVP:
  1. PİLOT sohbeti kullanıcının derdini yapılandırır (LLM).
  2. Adaylar Fuji ERC-8004 Identity kaydından + `agent.json` kartlarından; demoda 3 ajan (PİLOT + 2 demo), **DEMO** etiketli. Gerçek OKX.AI listesi ancak dışarıdan okunabiliyorsa.
  3. **Eşik kodda:** kimliksiz / puanı eşiğin altında / az geri bildirimli ajan elenir. Sybil önlemi: yalnız **FlightPlan'da o ajanla gerçekten `BuyExecuted` almış kullanıcıların** puanı sayılır (zincirden doğrulanır).
  4. LLM kalanları uyuma göre sıralar, her birine Türkçe gerekçe.
  5. Seçilen ajan için Uçuş Planı taslağı → onay penceresi → imza; `plan.agent` = seçilen ajan.
  6. KULE (veya kontrat) `agentId`'nin ERC-8004 cüzdanı == `plan.agent` kontrolü; KULE ajan başına token (Bekir abi).
  7. Sonrası aynı: izin → KULE → mutabakat.
  Önce araştırma (OKX.AI gerçekte ne, ERC-8004 Reputation okuma ABI'si Fuji'de canlı) — `docs/claude/workflows/ajan-rehberi-arastirma.js`. Limit kısıtlı: hafif workflow (az inceleme turu).
- **Hikâye/pivot geçmişi:** "Elif TL→dolar" hikâyesi zayıf bulundu. Masadaki fikir (yukarıdaki karar bunun MVP'si):
  *Kullanıcı sohbete derdini yazar → sistem OKX.AI/ERC-8004'teki ajanları toplar → **kod** ERC-8004 kimlik + itibar eşiğiyle eler (sybil önlemi: yalnız KULE üzerinden gerçekten işlem yapmış kullanıcıların puanı) → LLM uyuma göre sıralar → kullanıcı seçer → seçilen ajan için Uçuş Planı (onay penceresi + imza) → ajan yalnız KULE üzerinden çalışır → mutabakat.* KULE'yi kullanacak ajanların ERC-8004 kimliği zorunlu.
  Gerekenler: OKX.AI'ın gerçekte ne olduğu (liste dışarıdan okunabiliyor mu, hangi zincir), ERC-8004 Reputation okuma ABI'si (Fuji'de canlı kontrol), KULE'de ajan başına token. **Bu araştırma workflow'u başlatılıp durduruldu — yeniden çalıştır.** Ekip (Barış, Bekir) onayı gerekli; SPEC §22 "iki kullanıcı / pazaryeri" ile çelişebilir.
  Ayrıca konuşulan: TL/USDT/BTC konum alma + satış yönü (KULE'ye büyük iş), Uçuş Haritası (Koridor/Sis/Yasak hücreleri) — karar verilmedi.
- **PİLOT mantık soruları:** (1) KRIPTO_SISMESI'nde "bu fırtınada yarısı alındı" kilidi olsun mu? (öneri: evet — 2024-08-05'te açgözlü LLM 15 dk'da 3×5.000 TL aldı). (2) `bekle` kural_danis'in izinli seçenekleriyle sınırlansın mı? (öneri: evet).
- **Barış'a (fırtına bölümü):** TL_GUCLENDI sonrası lira zayıflarsa yeni bölüm açılsın mı (2025-12-02 21:45 UTC); bölüm bitiş anındaki alarm uzatır mı yeni mi açar?
- **Kontrat:** açık eylem varken `commitPending` KULE'yi değiştirirse rapor yazılamıyor; hiç işlem olmayan ay `CycleClosed` almayabilir.
- **Web nerede yayınlanacak (Vercel/VPS)?** Vercel'se `ANTHROPIC_API_KEY` sunucu tarafı env (asla `NEXT_PUBLIC_`).
- **Organizatörlere:** Fuji yeterli mi? OKX TR'de demo işlem açık mı? Builder Code OKX TR'de geçerli mi? OKX TR kurumsal hesap?
- **SPEC'e işlenecekler:** authz kuralı (§9.2, Ek B), onay penceresi (§10.6/§13), Barış'ın soruları, alınan pivot kararı.

## 6. Sıradaki adımlar

1. (Kullanıcı) `.env`'leri doldur, Fuji AVAX al, `docs/DEPLOY.md`'ye göre deploy + Snowtrace doğrulama, `scripts/register-agent.ts` ile ERC-8004 kaydı.
2. (Bekir abi, kritik yol) **B1 duman testleri + CAA testi hemen**, sonra KULE B2–B6 (`authz.ts` bağla), B7 VPS; UI.
3. (Biz) Ajan seçme MVP araştırmasını yeniden çalıştır (§5 KARAR) → tasarım → uygulama; `scripts/e2e.ts` (anvil uçtan uca) yaz; SPEC v5 farkını yazdır. Taşıma paketi: `docs/claude/README.md`.
4. Sunum: 7 slayt + soru-cevap kartı. Mentör soruları: "OKX bunu yaparsa?", "ürün olarak satılabilir mi?", "ajan kandırılabilir mi?", "diğer bekçi projelerinden farkınız?" — cevap taslakları: yetki katmanıyız (OKX'in rakibi değil ekosistemine altyapı), limit kullanıcının imzalı kuralı ve zincirde, kontrat gerçekten reddediyor, ajan anahtarı çalınsa bile sınır duruyor; satış: ajan geliştiricilerine/borsalara lisans-SaaS, Builder Code payı, Lira Hava Durumu verisi.
