/**
 * A3: PİLOT'u Fuji'deki resmî ERC-8004 Identity kaydına yazar (SPEC §8.5, §17.2 A3, Ek B). Ayrıntı: docs/DEPLOY.md "A3".
 *
 * Çalıştırma (repo kökünden; anahtar yalnız ortamdan, ör. `set -a; source contracts/.env; set +a`):
 *   pnpm exec tsx scripts/register-agent.ts --agent-uri https://<web>/agent.json             # kuru çalıştırma
 *   pnpm exec tsx scripts/register-agent.ts --agent-uri https://<web>/agent.json --broadcast # gerçek kayıt
 * Ortam: DEPLOYER_PRIVATE_KEY (zorunlu; fuji.json.deployer ile aynı cüzdan), FUJI_RPC (ya da --rpc).
 * Anahtar hiçbir yere yazılmaz ve günlüğe basılmaz.
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { parseCliArgs, registerAgent } from "./lib/registerAgent.js";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FETCH_TIMEOUT_MS = 10_000;

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, path);
}

async function fetchJson(uri: string): Promise<unknown> {
  const res = await fetch(uri, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "error" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return JSON.parse(await res.text());
}

async function main(): Promise<void> {
  const opts = parseCliArgs(process.argv.slice(2), process.env, join(REPO_ROOT, "deployments", "fuji.json"));
  const key = process.env.DEPLOYER_PRIVATE_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("DEPLOYER_PRIVATE_KEY yok ya da biçimi geçersiz (0x + 64 hex)");
  const account = privateKeyToAccount(key as Hex);
  const transport = http(opts.rpcUrl);
  const res = await registerAgent(opts, {
    publicClient: createPublicClient({ transport }),
    walletClient: createWalletClient({ account, transport }),
    readFile: readOrNull,
    writeFile: writeAtomic,
    fetchJson,
    log: (l) => console.log(l),
  });
  if (!res.dryRun && !opts.local) console.log(`Tamam. Gezgin: https://testnet.snowtrace.io/tx/${res.txHash}`);
}

main().catch((e: unknown) => {
  console.error(`HATA: ${(e as Error).message}`);
  process.exit(1);
});
