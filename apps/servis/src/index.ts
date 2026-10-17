// Servis — OKX.AI servisleri (SPEC §12). Anahtar tutmaz; yalnız herkese açık piyasa verisi (CLAUDE.md kural 6).
// Yalnız 127.0.0.1'e bağlanır; dışarıya Caddy üzerinden açılır (SPEC §6.5).

import { DATA_DISCLAIMER } from "@pilot/shared";

export const SERVIS_HOST = "127.0.0.1";
export const SERVIS_DEFAULT_PORT = 8790;

console.log(`Servis iskeleti — sunucu henüz yok (port ${SERVIS_DEFAULT_PORT}). ${DATA_DISCLAIMER}`);
