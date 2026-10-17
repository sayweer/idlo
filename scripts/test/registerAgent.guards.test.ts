/**
 * A3 register-agent: inceleme bulgularının regresyon testleri (kanonik agentURI, gönderim/makbuz belirsizliği,
 * --local yalnız yerel RPC, gönderimin zincir nesnesine bağlı olması). Sahte RPC istemcileri; ağ yok, gönderim yok.
 * Anahtar her çalıştırmada üretilir (generatePrivateKey); dosyaya yazılmaz.
 * TODO(spec): §18'de A3 için kimlik yok; testler §17.2 adım kimliği "A3" ile adlandırıldı.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { encodeEventTopics, zeroAddress, type Address, type Chain, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ERC8004_FUJI } from "@pilot/shared";
import { buildAgentCard, validateAgentUri } from "../lib/agentCard.js";
import { identityRegistryAbi } from "../lib/erc8004.js";
import { parseCliArgs, registerAgent, type RegisterDeps, type RegisterOptions } from "../lib/registerAgent.js";

const SCRIPTS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const { agentId: _drop, ...BASE } = JSON.parse(readFileSync(join(SCRIPTS_DIR, "..", "deployments", "fuji.example.json"), "utf8"));
const CARD = buildAgentCard({ imageUrl: "https://pilot.test/pilot.png", mcpEndpoint: "https://servis.pilot.test/mcp" });
const URI = "https://pilot.test/agent.json";
const TX: Hex = `0x${"cd".repeat(32)}`;
const ACCOUNT = privateKeyToAccount(generatePrivateKey());
const LOCAL_REGISTRY: Address = "0x00000000000000000000000000000000000Ab8E4";
const FILE = JSON.stringify({ ...BASE, deployer: ACCOUNT.address }, null, 2);

const mint = (address: Address) => ({
  address,
  topics: encodeEventTopics({ abi: identityRegistryAbi, eventName: "Transfer", args: { from: zeroAddress, to: ACCOUNT.address, tokenId: 41n } }) as Hex[],
  data: "0x" as Hex,
});

function fake(o: { chainId?: number; sendError?: Error; receiptError?: Error; registry?: Address } = {}) {
  const calls: string[] = [];
  const seen = { simulateArgs: [] as unknown[], fetched: [] as string[], chains: [] as (Chain | null | undefined)[], written: [] as string[] };
  const deps = {
    publicClient: {
      getChainId: async () => (calls.push("getChainId"), o.chainId ?? 43113),
      getCode: async () => (calls.push("getCode"), "0x6000"),
      simulateContract: async (a: { address: Address; args: unknown[] }) => {
        calls.push("simulate");
        seen.simulateArgs.push(...a.args);
        return { result: 41n, request: { address: a.address, args: a.args } };
      },
      waitForTransactionReceipt: async () => {
        calls.push("wait");
        if (o.receiptError) throw o.receiptError;
        return { status: "success", logs: [mint(o.registry ?? ERC8004_FUJI.identity)] };
      },
    },
    walletClient: {
      account: ACCOUNT,
      writeContract: async (r: { chain?: Chain | null }) => {
        calls.push("send");
        seen.chains.push(r.chain);
        if (o.sendError) throw o.sendError;
        return TX;
      },
    },
    readFile: async () => (calls.push("readFile"), FILE),
    writeFile: async (_p: string, t: string) => (calls.push("writeFile"), seen.written.push(t)),
    fetchJson: async (u: string) => (calls.push("fetch"), seen.fetched.push(u), CARD),
    log: () => {},
  } as unknown as RegisterDeps;
  return { deps, calls, seen };
}

const opts = (over: Partial<RegisterOptions> = {}): RegisterOptions => ({
  deploymentsPath: "/tmp/a3-guard/fuji.json",
  agentUri: URI,
  rpcUrl: "http://127.0.0.1:1",
  local: false,
  force: false,
  broadcast: true,
  ...over,
});

describe("A3 agentURI kanonik biçim", () => {
  it.each([
    "https:\\\\pilot.test\\agent.json",
    "https://PILOT.test/agent.json",
    "https://pilot.test:443/agent.json",
    "https://pilot.test/./agent.json",
    "HTTPS://pilot.test/agent.json",
  ])("A3 ayrıştırıcının değiştirdiği agentURI (%j) reddedilir", (uri) => {
    expect(() => validateAgentUri(uri, { local: false })).toThrow(/kanonik/);
  });

  it("A3 kanonik agentURI aynen döner; yerel http yalnız --local ile", () => {
    expect(validateAgentUri(URI, { local: false })).toBe(URI);
    expect(validateAgentUri("http://127.0.0.1:8080/agent.json", { local: true })).toBe("http://127.0.0.1:8080/agent.json");
    expect(() => validateAgentUri("http://127.0.0.1:8080/agent.json", { local: false })).toThrow(/https/);
  });

  it("A3 indirilen ve zincire yazılan agentURI denetlenen metnin aynısı", async () => {
    const f = fake();
    await registerAgent(opts(), f.deps);
    expect(f.seen.fetched).toEqual([URI]);
    expect(f.seen.simulateArgs).toEqual([URI]);
  });
});

describe("A3 gönderim belirsizliği (çift kayıt riski)", () => {
  it("A3 gönderim hata verirse 'İŞLEM GÖNDERİLMİŞ OLABİLİR' + tekrarlama uyarısı; dosya yazılmaz", async () => {
    const f = fake({ sendError: new Error("request timed out") });
    const p = registerAgent(opts(), f.deps);
    await expect(p).rejects.toThrow(/İŞLEM GÖNDERİLMİŞ OLABİLİR: tx bilinmiyor.*tekrarlama/);
    expect(f.calls).not.toContain("writeFile");
  });

  it("A3 makbuz beklenemezse 'SONUÇ BİLİNMİYOR' + tx hash + tekrarlama uyarısı; dosya yazılmaz", async () => {
    const f = fake({ receiptError: new Error("Timed out while waiting for transaction") });
    const p = registerAgent(opts(), f.deps);
    await expect(p).rejects.toThrow(new RegExp(`SONUÇ BİLİNMİYOR: tx ${TX}.*tekrarlama`));
    expect(f.calls).not.toContain("writeFile");
  });
});

describe("A3 gönderim zincire bağlı", () => {
  it("A3 Fuji yolunda writeContract chain.id = 43113 ile çağrılır (chain: null değil)", async () => {
    const f = fake();
    await registerAgent(opts(), f.deps);
    expect(f.seen.chains).toHaveLength(1);
    expect(f.seen.chains[0]?.id).toBe(43113);
  });

  it("A3 --local yolunda writeContract gözlenen zincir kimliğiyle çağrılır", async () => {
    const f = fake({ chainId: 31337, registry: LOCAL_REGISTRY });
    await registerAgent(opts({ local: true, registry: LOCAL_REGISTRY, deploymentsPath: "/tmp/a3-guard/.anvil.json" }), f.deps);
    expect(f.seen.chains[0]?.id).toBe(31337);
  });
});

describe("A3 --local gerçek RPC'yi reddeder", () => {
  const base = ["--agent-uri", URI, "--local", "--registry", LOCAL_REGISTRY];
  const env = { FUJI_RPC: "https://api.avax-test.network/ext/bc/C/rpc" };

  it("A3 --local: --rpc yoksa FUJI_RPC'ye düşülmez", () => {
    expect(() => parseCliArgs(base, env, "d/.x.json")).toThrow(/--local yalnız yerel RPC/);
  });

  it.each(["https://api.avax-test.network/ext/bc/C/rpc", "http://10.0.0.5:8545", "http://127.0.0.1.evil.test:8545", "not a url"])(
    "A3 --local --rpc %s reddedilir",
    (rpc) => {
      expect(() => parseCliArgs([...base, "--rpc", rpc], env, "d/.x.json")).toThrow(/--local yalnız yerel RPC/);
    },
  );

  it.each(["http://127.0.0.1:8545", "http://localhost:8545", "http://[::1]:8545"])("A3 --local --rpc %s kabul edilir", (rpc) => {
    expect(parseCliArgs([...base, "--rpc", rpc], env, "d/.x.json")).toMatchObject({ local: true, rpcUrl: rpc });
  });

  it("A3 --local olmadan FUJI_RPC'ye düşülür", () => {
    expect(parseCliArgs(["--agent-uri", URI], env, "d.json").rpcUrl).toBe(env.FUJI_RPC);
  });

  it("A3 registerAgent: --local + uzak rpcUrl → hiçbir RPC çağrısı yok", async () => {
    const f = fake({ chainId: 43113 });
    const o = opts({ local: true, registry: LOCAL_REGISTRY, deploymentsPath: "/tmp/a3-guard/.x.json", rpcUrl: env.FUJI_RPC });
    await expect(registerAgent(o, f.deps)).rejects.toThrow(/--local yalnız yerel RPC/);
    expect(f.calls).toEqual([]);
  });
});
