# PİLOT — Claude Code kuralları

## Ne yapıyoruz
Elif'in imzaladığı Uçuş Planı içinde TL→USDT dönüşümünü yürüten ajan sistemi. Tek doğru kaynak: docs/SPEC.md.
Bileşenler: contracts/ (Foundry, Fuji: FlightPlan), apps/kule (OKX kapısı, MCP 8787), apps/pilot (LLM planlayıcı +
araçlar + Lira Hava Durumu), apps/servis (OKX.AI, anahtarsız, 8790), apps/web (Next.js), packages/shared.

## Değişmez kurallar
1. Güvenlik kararını asla LLM'e bırakma. LLM çıktısı her zaman zod ile doğrulanır; LLM yalnız §10.2 araçlarını görür.
2. Fail-closed: emin olmadığında emir verme, zincire yazma.
3. KULE yalnız zincirde BuyAuthorized olan eylemi uygular; parametreleri çağırandan değil zincirden okur.
4. Çekim (withdrawal) kodu yazma. OKX anahtarı Read+Trade; withdraw yok.
5. Anahtarlar: yalnız .env ve ~/.okx/config.toml. Koda, günlüğe, teste, commit'e yazma.
6. apps/servis hiçbir anahtar tutmaz; yalnız herkese açık piyasa verisi.
7. Birimler: TL tam lira; fiyat pxE6; zincir saniye, OKX ms. Dönüşüm yalnız packages/shared/units.ts.
8. Türkiye saati sabit UTC+3.
9. OKX sz: limit/post_only alışta sz = USDT; piyasa alışında sz = TL. sz'yi yalnız KULE hesaplar.
10. Kullanıcıya görünen metin Türkçe; kod tanımlayıcıları İngilizce.
11. Her davranışa test; test adlarında SPEC §18 kimliklerini kullan (ör. "U-4 ...").
12. INJECTION_DEMO / KULE_EXEC=paper / MOCK_OKX_FACILITATOR modları ekranda açıkça etiketlenir. Demo modları hiçbir kod korumasını kapatmaz.
13. KULE: izin başına kilit + diskte kalıcı durum (RESERVED→PLACED→DONE→REPORTED); token→ajan bağı; fiyat tickSz'ye yuvarlanır.
14. Lira Hava Durumu: fırtına bölümü kuralı (SPEC §11.2) — fırtına sürerken sınıf NORMAL'e ya da TL_GUCLENDI'ye kendiliğinden dönmez.
15. Ortak VPS: güvenlik duvarına ve başka servislerin portlarına dokunma.

## Komutlar
pnpm -r build | pnpm -r test
contracts: forge build | forge test -vv | forge script script/Deploy.s.sol --rpc-url $FUJI_RPC --broadcast
kule: pnpm --filter kule dev | pilot: pnpm --filter pilot dev (REPLAY=data/replays/2025-03-19.json)
servis: pnpm --filter servis dev | web: pnpm --filter web dev

## Yapma
Zincir eli/passkey/vault, iki kullanıcı, smart money, haberle işlem, öğrenen ajan katmanları (SPEC §22).
Sahnedeki isimler: Uçuş Planı, PİLOT, KULE, Lira Hava Durumu. Yeni terim uydurma.

## Belirsizlikte
SPEC'te olmayan karar gerekiyorsa en dar ve en güvenli seçeneği uygula, koda TODO(spec) yaz ve özetinde belirt.
