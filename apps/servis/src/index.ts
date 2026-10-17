// Servis — OKX.AI servisleri (SPEC §12). Anahtar tutmaz; yalnız herkese açık piyasa verisi (CLAUDE.md kural 6).
// Yalnız 127.0.0.1'e bağlanır; dışarıya Caddy üzerinden açılır (SPEC §6.5).

import { DATA_DISCLAIMER } from "@pilot/shared";
import { SERVIS_HOST, loadServisConfig } from "./config.js";
import { createLiveWeather } from "./liraHavaDurumu.js";
import { MOCK_LABEL } from "./odeme.js";
import { createOkxPublic } from "./okxPublic.js";
import { EMIR_DENETIMI_PATH, LIRA_HAVA_DURUMU_PATH, MCP_PATH, createServisServer } from "./server.js";

const config = loadServisConfig(process.env);
const now = () => Date.now();
const okx = createOkxPublic({ fetch: (url, init) => fetch(url, init), now });
const server = createServisServer({ okx, weather: createLiveWeather({ okx, now }), payment: config.payment, now });

server.listen(config.port, SERVIS_HOST, () => {
  const mod = config.payment.mock ? MOCK_LABEL : "gerçek x402 henüz yok: ücretli servis kapalı";
  console.log(
    `Servis http://${SERVIS_HOST}:${config.port} — ${EMIR_DENETIMI_PATH}, ${LIRA_HAVA_DURUMU_PATH}, ${MCP_PATH}. Ödeme: ${mod}. ${DATA_DISCLAIMER}`,
  );
});

const stop = () => server.close(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
