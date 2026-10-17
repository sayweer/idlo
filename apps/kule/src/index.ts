// KULE — OKX kapısı (SPEC §9). MCP sunucusu (Streamable HTTP, bearer) burada kurulacak (B3).
// Yalnız 127.0.0.1'e bağlanır; dışarıya Caddy üzerinden açılır (SPEC §6.5).
// Çekim (withdrawal) kodu YOK ve yazılmayacak (CLAUDE.md kural 4).

import { KULE_TOOL_NAMES } from "@pilot/shared";

export const KULE_HOST = "127.0.0.1";
export const KULE_DEFAULT_PORT = 8787;

/** İzin başına kalıcı durum deposu (SPEC §9.2-2): emirden önce diske yazılır; .gitignore'da. */
export const KULE_ACTIONS_STORE = "data/kule-actions.sqlite";

console.log(`KULE iskeleti — sunucu henüz yok (port ${KULE_DEFAULT_PORT}); araçlar: ${KULE_TOOL_NAMES.join(", ")}.`);
