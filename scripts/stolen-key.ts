/**
 * "Ajan anahtarı çalındı" sahnesi (SPEC §10.5, §16 #19, E-4; demo §19 4:30–6:30).
 * PİLOT'un kendi anahtarıyla, LLM ve araç katmanı olmadan, doğrudan FlightPlan.requestBuy(Elif, 40.000 TL) gönderir;
 * kontrat BuyRejected(OVER_ORDER_LIMIT) yayar (Fuji'de Snowtrace bağlantısı basılır). Ardından var olmayan izin
 * numarasıyla KULE'den emir ister (RET NO_AUTHORIZATION) ve yabancı plan varyantını çevrimdışı gösterir.
 * Betik asla gerçek bir izin oluşturmaz: ön kontrol (eth_call) ret göstermiyorsa işlem göndermeden durur.
 *
 * Önce bir kez (repo kökünde):  pnpm install && pnpm -r build
 * Fuji (CANLI):
 *   PILOT_AGENT_PRIVATE_KEY=0x… PLAN_USER_ADDRESS=0xElif… [FUJI_RPC=…] [KULE_URL=… PILOT_TOKEN=…] \
 *   pnpm exec tsx scripts/stolen-key.ts                       # deployments/fuji.json
 * Yerel Anvil (anvil --chain-id 43113; bkz. docs/DEPLOY.md "Yerel deneme"):
 *   PILOT_AGENT_PRIVATE_KEY=0x… PLAN_USER_ADDRESS=0x… [ANVIL_RPC=http://127.0.0.1:8545] \
 *   pnpm exec tsx scripts/stolen-key.ts --local               # deployments/.anvil.json
 * Seçenek: --deployments <yol>. Anahtar yalnız ortamdan okunur; dosyaya yazılmaz.
 * Çıkış kodu: 0 sahne beklendiği gibi · 1 beklenen sonuç yok · 2 çalışamadı.
 */
import { runStolenKey } from "./lib/stolen-io.js";

process.exitCode = await runStolenKey({ argv: process.argv.slice(2), env: process.env });
