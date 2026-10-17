/**
 * "Ajan anahtarı çalındı" sahnesinin gerçek bağlantıları: viem zincir istemcisi, isteğe bağlı canlı KULE (MCP),
 * ortam/argüman okuma. Anahtar yalnız ortamdan okunur, hemen hesaba çevrilir; hiçbir yere yazılmaz.
 * Çıkış kodu: 0 sahne beklendiği gibi · 1 sahne beklenen sonucu vermedi · 2 çalışamadı (işlem gönderilmemiş olabilir).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  http,
  isAddress,
  isAddressEqual,
  parseEventLogs,
  zeroAddress,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalancheFuji } from "viem/chains";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { EXECUTE_VERDICTS, parseDeployments, type Deployments } from "@pilot/shared";
import { FLIGHT_PLAN_SCRIPT_ABI } from "./mutabakat-abi.js";
import {
  runStolenKeyScene,
  SceneAbort,
  type KuleExecuteProbe,
  type RequestBuyCall,
  type SceneNetwork,
  type SentResult,
  type StolenChain,
} from "./stolen-scene.js";

export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const FUJI_PUBLIC_RPC = "https://api.avax-test.network/ext/bc/C/rpc";
export const ANVIL_DEFAULT_RPC = "http://127.0.0.1:8545";
/** TODO(spec): SPEC makbuz bekleme süresini vermiyor; Fuji ~2 sn kesinlik, PİLOT ile aynı 60 sn. */
export const RECEIPT_TIMEOUT_MS = 60_000;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

class UsageError extends Error {}

export function viemStolenChain(o: { rpc: string; account: LocalAccount; flightPlan: Address; fetch?: typeof fetch }): StolenChain {
  const transport = http(o.rpc, o.fetch ? { fetchFn: o.fetch } : {});
  const pub = createPublicClient({ chain: avalancheFuji, transport, pollingInterval: 500 });
  const wallet = createWalletClient({ chain: avalancheFuji, transport, account: o.account });
  const read = { address: o.flightPlan, abi: FLIGHT_PLAN_SCRIPT_ABI } as const;
  const args = (c: RequestBuyCall) => [c.user, c.amountTL, c.maxPxE6, c.ordType, c.reasonHash, []] as const;

  return {
    agent: o.account.address,
    chainId: () => pub.getChainId(),
    plan: (user) => pub.readContract({ ...read, functionName: "plans", args: [user] }),
    isPlanActive: (user) => pub.readContract({ ...read, functionName: "isPlanActive", args: [user] }),
    trDay: () => pub.readContract({ ...read, functionName: "trDay" }),
    lastActionId: () => pub.readContract({ ...read, functionName: "lastActionId" }),
    action: (id) => pub.readContract({ ...read, functionName: "actions", args: [id] }),
    async simulateRequestBuy(c) {
      const { result } = await pub.simulateContract({ ...read, functionName: "requestBuy", args: args(c), account: o.account, value: 0n });
      return result;
    },
    async sendRequestBuy(c): Promise<SentResult> {
      const hash: Hex = await wallet.writeContract({ ...read, functionName: "requestBuy", args: args(c), value: 0n });
      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
      if (receipt.status !== "success") return { kind: "other", hash };
      const events = parseEventLogs({
        abi: FLIGHT_PLAN_SCRIPT_ABI,
        logs: receipt.logs.filter((l) => isAddressEqual(l.address, o.flightPlan)),
        eventName: ["BuyAuthorized", "BuyRejected"],
      });
      if (events.length !== 1) return { kind: "other", hash };
      const ev = events[0]!;
      if (ev.eventName === "BuyAuthorized") return { kind: "authorized", hash, actionId: ev.args.actionId };
      return { kind: "rejected", hash, user: ev.args.user, amountTL: ev.args.amountTL, code: ev.args.code };
    },
  };
}

/** Token yalnız HTTPS'te; düz HTTP yalnız geri döngü adresine (KULE VPS'te 127.0.0.1:8787). */
export function assertKuleUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UsageError("KULE_URL geçerli bir URL değil");
  }
  if (!(u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.has(u.hostname)))) {
    throw new UsageError("KULE_URL https olmalı (düz http yalnız 127.0.0.1/localhost için)");
  }
  if (u.username || u.password) throw new UsageError("KULE_URL kullanıcı adı/parola içermemeli");
  return u;
}

const ExecuteReplySchema = z.object({ verdict: z.enum(EXECUTE_VERDICTS), reasons: z.array(z.string()) });

/** Canlı KULE: MCP Streamable HTTP, bearer PILOT_TOKEN (§9). Yalnız kule_execute çağrılır. */
export async function connectKuleProbe(o: { url: string; token: string; fetch?: typeof fetch }): Promise<KuleExecuteProbe & { close(): Promise<void> }> {
  const transport = new StreamableHTTPClientTransport(assertKuleUrl(o.url), {
    requestInit: { headers: { Authorization: `Bearer ${o.token}` } },
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  const client = new Client({ name: "stolen-key", version: "0.0.0" });
  await client.connect(transport);
  return {
    async execute(actionId) {
      const res = (await client.callTool({ name: "kule_execute", arguments: { actionId } })) as Record<string, unknown>;
      if (res.isError === true) throw new Error("KULE araç hatası döndürdü");
      let body: unknown = res.structuredContent;
      if (body === undefined || body === null) {
        const content = res.content as { type?: string; text?: string }[] | undefined;
        if (!Array.isArray(content) || content.length !== 1 || content[0]!.type !== "text") throw new Error("KULE yanıtı beklenen biçimde değil");
        try {
          body = JSON.parse(content[0]!.text!);
        } catch {
          throw new Error("KULE yanıtı JSON değil");
        }
      }
      const r = ExecuteReplySchema.safeParse(body);
      if (!r.success) throw new Error("KULE yanıtı beklenen biçimde değil");
      return r.data;
    },
    close: () => client.close(),
  };
}

interface Config {
  network: SceneNetwork;
  rpc: string;
  account: LocalAccount;
  user: Address;
  deployments: Deployments;
  kule: { url: string; token: string } | null;
}

function loadConfig(argv: string[], env: Record<string, string | undefined>, readText: (p: string) => string): Config {
  let network: SceneNetwork = "fuji";
  let deploymentsPath: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--local") network = "local";
    else if (k === "--deployments") {
      const v = argv[++i];
      if (!v) throw new UsageError("--deployments bir dosya yolu ister");
      deploymentsPath = resolve(v);
    } else throw new UsageError(`bilinmeyen argüman: ${k}`);
  }
  deploymentsPath ??= resolve(REPO_ROOT, network === "local" ? "deployments/.anvil.json" : "deployments/fuji.json");

  const pk = env.PILOT_AGENT_PRIVATE_KEY?.trim();
  if (!pk) throw new UsageError("PILOT_AGENT_PRIVATE_KEY tanımlı değil");
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new UsageError("PILOT_AGENT_PRIVATE_KEY biçimi geçersiz");
  let account: LocalAccount;
  try {
    account = privateKeyToAccount(pk as Hex);
  } catch {
    throw new UsageError("PILOT_AGENT_PRIVATE_KEY geçersiz");
  }

  const user = env.PLAN_USER_ADDRESS?.trim();
  if (!user || !isAddress(user) || isAddressEqual(user, zeroAddress)) throw new UsageError("PLAN_USER_ADDRESS Elif'in adresi (0x…) olmalı");

  let rpc: string;
  if (network === "local") {
    rpc = env.ANVIL_RPC?.trim() || ANVIL_DEFAULT_RPC;
    let host: string;
    try {
      host = new URL(rpc).hostname;
    } catch {
      throw new UsageError("ANVIL_RPC geçerli bir URL değil");
    }
    if (!LOOPBACK.has(host)) throw new UsageError("--local yalnız 127.0.0.1/localhost RPC ile çalışır");
  } else {
    rpc = env.FUJI_RPC?.trim() || FUJI_PUBLIC_RPC;
  }
  if (!/^https?:\/\//.test(rpc)) throw new UsageError("RPC http(s) URL olmalı");

  let text: string;
  try {
    text = readText(deploymentsPath);
  } catch {
    throw new UsageError(`deployments dosyası okunamadı: ${deploymentsPath}`);
  }
  const deployments = parseDeployments(text);

  const url = env.KULE_URL?.trim();
  const token = env.PILOT_TOKEN?.trim();
  if (Boolean(url) !== Boolean(token)) throw new UsageError("canlı KULE için KULE_URL ve PILOT_TOKEN birlikte verilmeli");
  if (token && !/^\S{16,}$/.test(token)) throw new UsageError("PILOT_TOKEN boş ya da çok kısa");
  if (url) assertKuleUrl(url);

  return { network, rpc, account, user, deployments, kule: url && token ? { url, token } : null };
}

function shortMessage(e: unknown): string {
  const s = (e as { shortMessage?: unknown }).shortMessage;
  return typeof s === "string" ? s : (e as Error).message;
}

export async function runStolenKey(d: {
  argv: string[];
  env: Record<string, string | undefined>;
  fetch?: typeof fetch;
  out?: (line: string) => void;
  readText?: (path: string) => string;
}): Promise<number> {
  const out = d.out ?? ((l: string) => console.log(l));
  let cfg: Config;
  try {
    cfg = loadConfig(d.argv, d.env, d.readText ?? ((p) => readFileSync(p, "utf8")));
  } catch (e) {
    out(`Sahne başlamadı: ${(e as Error).message}`);
    return 2;
  }

  const chain = viemStolenChain({
    rpc: cfg.rpc,
    account: cfg.account,
    flightPlan: cfg.deployments.flightPlan,
    ...(d.fetch ? { fetch: d.fetch } : {}),
  });
  let kule: (KuleExecuteProbe & { close(): Promise<void> }) | undefined;
  try {
    if (cfg.kule) kule = await connectKuleProbe({ ...cfg.kule, ...(d.fetch ? { fetch: d.fetch } : {}) });
    const r = await runStolenKeyScene({
      chain,
      network: cfg.network,
      deployments: cfg.deployments,
      user: cfg.user,
      ...(kule ? { kule } : {}),
      out,
    });
    return r.ok ? 0 : 1;
  } catch (e) {
    out(e instanceof SceneAbort ? `Sahne durdu (işlem gönderilmedi): ${e.message}` : `Sahne tamamlanamadı: ${shortMessage(e)}`);
    return 2;
  } finally {
    await kule?.close().catch(() => undefined);
  }
}
