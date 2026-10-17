/**
 * Mutabakat (SPEC §14) — Elif'in bilgisayarında, kendi SALT-OKUNUR OKX anahtarıyla çalışır.
 * OKX TR'deki USDT-TRY emirlerini zincirdeki izinlerle (BuyAuthorized) ve raporlarla (BuyExecuted) eşleştirir.
 * Emir vermez, iptal etmez, çekim yapmaz; zincire işlem göndermez. Anahtar yalnız tr.okx.com'a gider.
 *
 * Önce bir kez (repo kökünde):  pnpm install && pnpm -r build
 * Çalıştırma:
 *   OKX_READONLY_API_KEY=... OKX_READONLY_SECRET=... OKX_READONLY_PASSPHRASE=... \
 *   FUJI_RPC=https://api.avax-test.network/ext/bc/C/rpc USER=0xElif... \
 *   pnpm exec tsx scripts/mutabakat.ts --days 7
 * Seçenekler: --days N (1–90, varsayılan 7) · --demo (OKX demo hesabı; ekranda DEMO) ·
 *             --deployments <yol> (varsayılan deployments/fuji.json)
 * Çıkış kodu: 0 ALARM yok · 1 ALARM · 2 çalışamadı.
 *
 * TODO(spec): §14 "Demo/kâğıt modunda borsa tarafı KULE günlüğünden okunur" diyor; KULE günlüğünün biçimi (§9.4)
 * henüz sabit değil (apps/kule, Bekir). Şimdilik yalnız OKX (canlı ya da --demo); kâğıt modu desteklenmiyor.
 */
import { runMutabakat } from "./lib/mutabakat-run.js";

process.exitCode = await runMutabakat({ argv: process.argv.slice(2), env: process.env });
