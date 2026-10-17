// KULE — OKX kapısı (SPEC §9). MCP sunucusu (Streamable HTTP, bearer): 127.0.0.1:${KULE_PORT}/mcp.
// Yalnız 127.0.0.1'e bağlanır; dışarıya Caddy üzerinden açılır (SPEC §6.5).
// Çekim (withdrawal) kodu YOK ve yazılmayacak (CLAUDE.md kural 4).
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MODE_LABELS } from "@pilot/shared";
import { createApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";

export const KULE_ACTIONS_STORE = "data/kule-actions.json";

async function main(): Promise<void> {
  const baseDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const envFile = resolve(baseDir, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const cfg = loadConfig(process.env, {
    baseDir,
    readText: (p) => readFileSync(p, "utf8"),
    resolvePath: (base, p) => (isAbsolute(p) ? p : resolve(base, p)),
  });
  const app = await createApp(cfg);
  const port = await app.start();
  console.log(`KULE hazır: http://127.0.0.1:${port}/mcp — mod ${MODE_LABELS[cfg.mode]} (${cfg.mode})`);

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    void app.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e: unknown) => {
  // Hata metni gizli değer içermez (ConfigError yalnız alan adı söyler).
  console.error(e instanceof ConfigError ? `KULE yapılandırma hatası: ${e.message}` : `KULE başlatılamadı: ${(e as Error).message}`);
  process.exit(1);
});
