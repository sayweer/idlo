/**
 * A3 register-agent uçtan uca, yerel Anvil'de (gerçek ağa gönderim yok).
 * - Anvil A: --chain-id 43113; MockIdentityRegistry, Ek B Identity adresine anvil_setCode ile kurulur (Fuji yolu).
 * - Anvil B: 31337; --local yolu ve CLI.
 * Anahtar: her çalıştırmada generatePrivateKey ile üretilir, anvil_setBalance ile fonlanır; dosyaya yazılmaz.
 * Anvil yoksa (Foundry kurulu değilse) bu dosya atlanır.
 * TODO(spec): §18'de A3 için kimlik yok; testler §17.2 adım kimliği "A3" ile adlandırıldı.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPublicClient, createTestClient, createWalletClient, http, parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ERC8004_FUJI, parseDeployments } from "@pilot/shared";
import { buildAgentCard } from "../lib/agentCard.js";
import { registerAgent, type RegisterDeps, type RegisterOptions } from "../lib/registerAgent.js";
import { MOCK_IDENTITY_RUNTIME, mockAdminAbi } from "./fixtures/mockIdentityRegistry.js";

const HAS_ANVIL = spawnSync("anvil", ["--version"]).status === 0;
const SCRIPTS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const EXAMPLE = JSON.parse(readFileSync(join(SCRIPTS_DIR, "..", "deployments", "fuji.example.json"), "utf8"));
const CARD = buildAgentCard({ imageUrl: "https://pilot.test/pilot.png", mcpEndpoint: "https://servis.pilot.test/mcp" });
const URI = "https://pilot.test/agent.json";
const LOCAL_REGISTRY: Address = "0x00000000000000000000000000000000000Ab8E4";

async function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createNetServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => res(p));
    });
  });
}

async function startAnvil(chainId: number): Promise<{ proc: ChildProcess; rpc: string }> {
  const port = await freePort();
  const proc = spawn("anvil", ["--port", String(port), "--chain-id", String(chainId), "--quiet"], { stdio: "ignore" });
  const rpc = `http://127.0.0.1:${port}`;
  const pc = createPublicClient({ transport: http(rpc) });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await pc.getChainId()) === chainId) return { proc, rpc };
    } catch {
      /* henüz açılmadı */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error("anvil açılmadı");
}

describe.skipIf(!HAS_ANVIL)("A3 register-agent (Anvil)", () => {
  let fuji: { proc: ChildProcess; rpc: string };
  let dev: { proc: ChildProcess; rpc: string };
  let dir: string;
  const key: Hex = generatePrivateKey();
  const account = privateKeyToAccount(key);
  const otherAccount = privateKeyToAccount(generatePrivateKey());

  const clients = (rpc: string, acct = account) => {
    const transport = http(rpc);
    return {
      publicClient: createPublicClient({ transport }),
      walletClient: createWalletClient({ account: acct, transport }),
      testClient: createTestClient({ mode: "anvil", transport }),
    };
  };

  async function installMock(rpc: string, at: Address, nextId: bigint, mode = 0): Promise<void> {
    const { publicClient, walletClient, testClient } = clients(rpc);
    await testClient.setCode({ address: at, bytecode: MOCK_IDENTITY_RUNTIME });
    for (const [fn, arg] of [["setNextId", nextId], ["setMode", mode]] as const) {
      const h = await walletClient.writeContract({ address: at, abi: mockAdminAbi, functionName: fn, args: [arg as never], chain: null });
      await publicClient.waitForTransactionReceipt({ hash: h });
    }
  }

  function writeDeployments(name: string, over: Record<string, unknown> = {}): string {
    const { agentId: _a, ...base } = EXAMPLE;
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify({ ...base, deployer: account.address, ...over }, null, 2));
    return path;
  }

  function deps(rpc: string, acct = account, card: unknown = CARD): RegisterDeps & { lines: string[] } {
    const { publicClient, walletClient } = clients(rpc, acct);
    const lines: string[] = [];
    return {
      publicClient,
      walletClient,
      readFile: async (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
      writeFile: async (p, t) => writeFileSync(p, t),
      fetchJson: async () => card,
      log: (l) => lines.push(l),
      lines,
    };
  }

  const opts = (rpc: string, deploymentsPath: string, over: Partial<RegisterOptions> = {}): RegisterOptions => ({
    deploymentsPath,
    agentUri: URI,
    rpcUrl: rpc,
    local: false,
    force: false,
    broadcast: true,
    ...over,
  });

  beforeAll(async () => {
    [fuji, dev] = await Promise.all([startAnvil(43113), startAnvil(31337)]);
    for (const n of [fuji, dev]) {
      const { testClient } = clients(n.rpc);
      await testClient.setBalance({ address: account.address, value: parseEther("10") });
      await testClient.setBalance({ address: otherAccount.address, value: parseEther("10") });
    }
    dir = mkdtempSync(join(tmpdir(), "a3-"));
  }, 30_000);

  afterAll(() => {
    fuji?.proc.kill();
    dev?.proc.kill();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await installMock(fuji.rpc, ERC8004_FUJI.identity, 41n);
  });

  it("A3 kuru çalıştırma: işlem gönderilmez, dosya değişmez, beklenen agentId basılır", async () => {
    const path = writeDeployments("fuji.json");
    const before = readFileSync(path, "utf8");
    const { publicClient } = clients(fuji.rpc);
    const nonce = await publicClient.getTransactionCount({ address: account.address });
    const d = deps(fuji.rpc);
    const r = await registerAgent(opts(fuji.rpc, path, { broadcast: false }), d);
    expect(r).toMatchObject({ dryRun: true, expectedAgentId: 41n });
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(await publicClient.getTransactionCount({ address: account.address })).toBe(nonce);
    expect(d.lines.join("\n")).toMatch(/KURU ÇALIŞTIRMA/);
  });

  it("A3 Fuji yolu: register(agentURI) → olaylardan agentId → fuji.json şemaya uygun yazılır", async () => {
    const path = writeDeployments("fuji.json");
    const r = await registerAgent(opts(fuji.rpc, path), deps(fuji.rpc));
    expect(r).toMatchObject({ dryRun: false, agentId: 41n, registry: ERC8004_FUJI.identity });
    expect(parseDeployments(readFileSync(path, "utf8")).agentId).toBe("41");
    const { publicClient } = clients(fuji.rpc);
    const read = (functionName: "tokenURI" | "ownerOf") =>
      publicClient.readContract({ address: ERC8004_FUJI.identity, abi: mockAdminAbi, functionName, args: [41n] });
    expect(await read("tokenURI")).toBe(URI);
    expect(await read("ownerOf")).toBe(account.address);
  });

  it("A3 zaten kayıtlıysa ret; --force ile yeniden kayıt yeni agentId'yi yazar", async () => {
    const path = writeDeployments("fuji.json", { agentId: "17" });
    await expect(registerAgent(opts(fuji.rpc, path), deps(fuji.rpc))).rejects.toThrow(/zaten kayıtlı \(agentId=17\)/);
    expect(parseDeployments(readFileSync(path, "utf8")).agentId).toBe("17");
    const r = await registerAgent(opts(fuji.rpc, path, { force: true }), deps(fuji.rpc));
    expect(r).toMatchObject({ agentId: 41n });
    expect(parseDeployments(readFileSync(path, "utf8")).agentId).toBe("41");
  });

  it("A3 fuji.json yok ya da geçersiz → işlem öncesi ret", async () => {
    await expect(registerAgent(opts(fuji.rpc, join(dir, "yok.json")), deps(fuji.rpc))).rejects.toThrow(/yok ya da boş/);
    const bad = writeDeployments("bad.json", { chainId: 1 });
    await expect(registerAgent(opts(fuji.rpc, bad), deps(fuji.rpc))).rejects.toThrow(/geçersiz/);
  });

  it("A3 43113 olmayan zincirde --local olmadan ret", async () => {
    const path = writeDeployments("fuji.json");
    await expect(registerAgent(opts(dev.rpc, path), deps(dev.rpc))).rejects.toThrow(/zincir 31337/);
  });

  it("A3 Identity adresinde kod yoksa ret", async () => {
    await clients(fuji.rpc).testClient.setCode({ address: ERC8004_FUJI.identity, bytecode: "0x" });
    const path = writeDeployments("fuji.json");
    await expect(registerAgent(opts(fuji.rpc, path), deps(fuji.rpc))).rejects.toThrow(/kod yok/);
  });

  it("A3 imzalayan deployments.deployer değilse işlem gönderilmez", async () => {
    const path = writeDeployments("fuji.json");
    const { publicClient } = clients(fuji.rpc);
    const nonce = await publicClient.getTransactionCount({ address: otherAccount.address });
    await expect(registerAgent(opts(fuji.rpc, path), deps(fuji.rpc, otherAccount))).rejects.toThrow(/deployer/);
    expect(await publicClient.getTransactionCount({ address: otherAccount.address })).toBe(nonce);
  });

  it("A3 yayındaki agent.json geçersiz ya da yer tutuculu ise ret", async () => {
    const path = writeDeployments("fuji.json");
    const tmpl = JSON.parse(readFileSync(join(SCRIPTS_DIR, "..", "data", "agent-card", "agent.json"), "utf8"));
    await expect(registerAgent(opts(fuji.rpc, path), deps(fuji.rpc, account, tmpl))).rejects.toThrow(/yer tutucu/);
    await expect(registerAgent(opts(fuji.rpc, path), deps(fuji.rpc, account, { name: "PİLOT" }))).rejects.toThrow(/agent.json geçersiz/);
    const failing = { ...deps(fuji.rpc), fetchJson: async () => { throw new Error("HTTP 404"); } };
    await expect(registerAgent(opts(fuji.rpc, path), failing)).rejects.toThrow(/okunamadı.*404/);
  });

  it("A3 olay yoksa ya da olaylar çelişirse dosyaya yazılmaz, işlem özeti verilir", async () => {
    for (const mode of [1, 2]) {
      await installMock(fuji.rpc, ERC8004_FUJI.identity, 41n, mode);
      const path = writeDeployments("fuji.json");
      const before = readFileSync(path, "utf8");
      await expect(registerAgent(opts(fuji.rpc, path), deps(fuji.rpc))).rejects.toThrow(/KAYIT ZİNCİRDE AMA DOSYA YAZILMADI.*işlem 0x[0-9a-f]{64}/);
      expect(readFileSync(path, "utf8")).toBe(before);
    }
  });

  it("A3 kayıt agentId 0 verirse dosyaya yazılmaz", async () => {
    await installMock(fuji.rpc, ERC8004_FUJI.identity, 0n);
    const path = writeDeployments("fuji.json");
    await expect(registerAgent(opts(fuji.rpc, path), deps(fuji.rpc))).rejects.toThrow(/DOSYA YAZILMADI.*agentId 0 yazılmaz/);
    expect(parseDeployments(readFileSync(path, "utf8")).agentId).toBeUndefined();
  });

  it("A3 kayıt revert ederse dosya değişmez", async () => {
    await installMock(fuji.rpc, ERC8004_FUJI.identity, 41n, 3);
    const path = writeDeployments("fuji.json");
    await expect(registerAgent(opts(fuji.rpc, path), deps(fuji.rpc))).rejects.toThrow();
    expect(parseDeployments(readFileSync(path, "utf8")).agentId).toBeUndefined();
  });

  it("A3 dosya çalışma sırasında değişirse yazılmaz", async () => {
    const path = writeDeployments("fuji.json");
    const d = deps(fuji.rpc);
    let reads = 0;
    d.readFile = async (p) => {
      const t = readFileSync(p, "utf8");
      return ++reads === 1 ? t : t + " ";
    };
    await expect(registerAgent(opts(fuji.rpc, path), d)).rejects.toThrow(/değişti/);
  });

  it("A3 --local: nokta ile başlamayan çıktı dosyası reddedilir", async () => {
    const path = writeDeployments("fuji.json");
    await expect(registerAgent(opts(dev.rpc, path, { local: true, registry: LOCAL_REGISTRY }), deps(dev.rpc))).rejects.toThrow(/nokta ile/);
  });

  it("A3 CLI --local (31337, http://127.0.0.1 agent.json): anahtar yalnız ortamdan, agentId .anvil.json'a yazılır", async () => {
    await installMock(dev.rpc, LOCAL_REGISTRY, 7n);
    const path = writeDeployments(".anvil.json");
    const server: Server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(CARD));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const uri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/agent.json`;
    try {
      const run = (env: Record<string, string>) =>
        new Promise<{ code: number | null; out: string }>((resolve) => {
          // tsx'in JS girişi node ile: .bin/tsx Windows'ta doğrudan spawn edilemez (ENOENT).
          const p = spawn(
            process.execPath,
            [join(SCRIPTS_DIR, "..", "node_modules", "tsx", "dist", "cli.mjs"), join(SCRIPTS_DIR, "register-agent.ts"), "--agent-uri", uri, "--rpc", dev.rpc, "--deployments", path, "--local", "--registry", LOCAL_REGISTRY, "--broadcast"],
            { env: { PATH: process.env.PATH ?? "", ...env } },
          );
          let out = "";
          p.stdout.on("data", (b) => (out += b));
          p.stderr.on("data", (b) => (out += b));
          p.on("close", (code) => resolve({ code, out }));
        });
      const noKey = await run({});
      expect(noKey.code).toBe(1);
      expect(noKey.out).toMatch(/DEPLOYER_PRIVATE_KEY/);
      const ok = await run({ DEPLOYER_PRIVATE_KEY: key });
      expect(ok.out).not.toContain(key.slice(2));
      expect(ok.code, ok.out).toBe(0);
      expect(parseDeployments(readFileSync(path, "utf8")).agentId).toBe("7");
    } finally {
      server.close();
    }
  }, 60_000);
});
