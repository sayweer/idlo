/**
 * İsteğe bağlı uçtan uca: yerel anvil (--chain-id 43113) + GERÇEK FlightPlan kontratı (contracts/out) + KULE'nin gerçek
 * viem zincir istemcisi (ViemKuleChain) + sahte borsa. anvil ya da derlenmiş kontrat yoksa atlanır.
 * Gerçek anahtar/ağ yok: anvil'in herkese açık varsayılan test anahtarları.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, createWalletClient, getAddress, http, keccak256, parseEventLogs, stringToBytes, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalancheFuji } from "viem/chains";
import { parseDeployments } from "@pilot/shared";
import { createApp, type KuleApp } from "../src/app.js";
import type { KuleConfig, TokenBinding } from "../src/config.js";
import { MemoryLogger } from "../src/logger.js";
import { FakeExchange } from "./helpers.js";

const ARTIFACT = resolve(__dirname, "../../../contracts/out/FlightPlan.sol/FlightPlan.json");
const hasAnvil = spawnSync("anvil", ["--version"]).status === 0;
const canRun = hasAnvil && existsSync(ARTIFACT);

// anvil varsayılan herkese açık test anahtarları
const PK = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  reporter: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  pilot: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  elif: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  attacker: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
} as const;
const acct = (k: keyof typeof PK) => privateKeyToAccount(PK[k]);
const IDENTITY: Address = "0x8004A818BFB912233c491871b3d84c89A494BD9e";

const word = (n: number) => n.toString(16).padStart(64, "0");
/** Her çağrıya `bytes(wallet)` (20 bayt) döndüren sahte ERC-8004 kimlik kaydı çalışma kodu. */
function mockIdentityCode(wallet: Address): Hex {
  const data = word(0x20) + word(0x14) + wallet.slice(2).toLowerCase().padEnd(64, "0");
  return ("0x" + "6060" + "80" + "600b" + "6000" + "39" + "6000" + "f3" + data) as Hex;
}

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
    s.on("error", rej);
  });
}

describe.skipIf(!canRun)("anvil: gerçek FlightPlan ile KULE", () => {
  let anvil: ChildProcess;
  let rpc: string;
  let app: KuleApp;
  let flightPlan: Address;
  let offsetMs = 0;
  const logger = new MemoryLogger();
  const abi = canRun ? ((JSON.parse(readFileSync(ARTIFACT, "utf8")) as { abi: Abi }).abi) : [];
  const pilotBinding = (): TokenBinding => ({ token: "anvil-pilot-token-0123456789", agent: getAddress(acct("pilot").address), label: "pilot" });

  const pub = () => createPublicClient({ chain: avalancheFuji, transport: http(rpc), pollingInterval: 50 });
  const wallet = (k: keyof typeof PK) => createWalletClient({ chain: avalancheFuji, transport: http(rpc), account: acct(k), pollingInterval: 50 });
  const raw = async (method: string, params: unknown[] = []) => {
    const r = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    return ((await r.json()) as { result: unknown }).result;
  };

  let expiresAt: bigint | null = null; // sıkılık kuralı: expiresAt ≤ eski; her planda aynı değer
  async function plan(over: Record<string, unknown> = {}) {
    const now = Number((await pub().getBlock()).timestamp);
    expiresAt ??= BigInt(now + 90 * 86400);
    return {
      cycleTL: 80000n,
      maxOrderTL: 40000n,
      startDay: 1,
      deadlineDay: 28,
      maxWaitH: 72,
      bandBps: 0,
      closedBandBps: 500,
      askMode: 0,
      expiresAt,
      agent: getAddress(acct("pilot").address),
      kule: getAddress(acct("reporter").address),
      agentId: 1n,
      ...over,
    };
  }
  const setPlan = async (k: keyof typeof PK, over: Record<string, unknown> = {}) => {
    const h = await wallet(k).writeContract({ address: flightPlan, abi, functionName: "setPlan", args: [await plan(over)] });
    await pub().waitForTransactionReceipt({ hash: h });
  };
  async function requestBuy(user: Address, amountTL: bigint, ordType = 0): Promise<string> {
    const h = await wallet("pilot").writeContract({ address: flightPlan, abi, functionName: "requestBuy", args: [user, amountTL, 49_500_000n, ordType, ("0x" + "00".repeat(32)) as Hex, []] });
    const rc = await pub().waitForTransactionReceipt({ hash: h });
    const ev = parseEventLogs({ abi, logs: rc.logs, eventName: "BuyAuthorized" });
    expect(ev).toHaveLength(1);
    return (ev[0]!.args as { actionId: bigint }).actionId.toString();
  }
  const actionState = async (id: string) => ((await pub().readContract({ address: flightPlan, abi, functionName: "actions", args: [BigInt(id)] })) as { state: number }).state;
  const cycle = async () => (await pub().readContract({ address: flightPlan, abi, functionName: "cycles", args: [acct("elif").address] })) as { spentTL: bigint; reservedTL: bigint };
  const exec = async (id: string) => {
    app.heartbeats.beat("pilot");
    await app.caa!.tick(); // sahte saat sıçradıysa CAA yenilemesi de ilerler
    return app.executor.execute(pilotBinding(), id);
  };

  beforeAll(async () => {
    const port = await freePort();
    rpc = `http://127.0.0.1:${port}`;
    anvil = spawn("anvil", ["--chain-id", "43113", "--port", String(port), "--silent"], { stdio: "ignore" });
    for (let i = 0; i < 100; i++) {
      try {
        if ((await raw("eth_chainId")) === "0xa869") break;
      } catch {
        /* henüz hazır değil */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    const art = JSON.parse(readFileSync(ARTIFACT, "utf8")) as { abi: Abi; bytecode: { object: Hex } };
    const dh = await wallet("deployer").deployContract({ abi: art.abi, bytecode: art.bytecode.object });
    const rc = await pub().waitForTransactionReceipt({ hash: dh });
    flightPlan = rc.contractAddress!;
    await raw("anvil_setCode", [IDENTITY, mockIdentityCode(acct("pilot").address)]);
    await setPlan("elif");

    const deployments = parseDeployments(
      JSON.stringify({
        chainId: 43113,
        deployBlock: Number(rc.blockNumber),
        deployer: acct("deployer").address,
        erc8004: { identity: IDENTITY, reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713", validation: "0x8004Cb1BF31DAf7788923b405b754f57acEB4272" },
        flightPlan,
        pilotAgent: acct("pilot").address,
        kuleReporter: acct("reporter").address,
        agentId: "1",
      }),
    );
    const cfg: KuleConfig = {
      port: 0,
      tokens: [pilotBinding()],
      planUser: getAddress(acct("elif").address),
      okxProfile: "kule-demo",
      exec: "okx",
      okx: null,
      demo: true,
      mode: "demo",
      reporterKey: PK.reporter,
      reporter: getAddress(acct("reporter").address),
      rpcUrl: rpc,
      deployments,
      actionsPath: resolve(process.env.TEMP ?? "/tmp", `kule-anvil-${port}.json`),
      logDir: resolve(process.env.TEMP ?? "/tmp", `kule-anvil-logs-${port}`),
    };
    const clock = { nowMs: () => Date.now() + offsetMs };
    const exchange = new FakeExchange({ get ms() { return Date.now() + offsetMs; } } as never);
    app = await createApp(cfg, { exchange, clock, logger, fetchImpl: (async () => new Response(JSON.stringify({ code: "0", data: [{ instType: "SPOT", instId: "USDT-TRY", tickSz: "0.001", lotSz: "0.0001", minSz: "1" }] }))) as typeof fetch, caaClient: { set: async () => undefined }, sleep: async () => undefined });
    app.heartbeats.beat("pilot");
    await app.caa!.tick();
  }, 60_000);

  afterAll(async () => {
    anvil?.kill();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("zincir bağı: plan etkin, kimlik kaydı PİLOT cüzdanına bağlı", async () => {
    expect(await app.health.check({ includeCaa: true })).toMatchObject({ state: "NORMAL", chain: { ok: true } });
  });

  it("mutlu yol: gerçek requestBuy → KULE → gerçek reportExecution; zincirde REPORTED, spentTL=filledTL, reservedTL=0, reportHash günlük özetine eşit", async () => {
    const id = await requestBuy(acct("elif").address, 10000n);
    const r = await exec(id);
    expect(r).toMatchObject({ verdict: "ONAY", status: "FILLED", clOrdId: `plt${id}` });
    expect(r.reportTx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await actionState(id)).toBe(1); // REPORTED
    const c = await cycle();
    expect(c.reservedTL).toBe(0n);
    expect(c.spentTL).toBeGreaterThan(9000n);
    expect(c.spentTL).toBeLessThanOrEqual(10000n);
    const rc = await pub().getTransactionReceipt({ hash: r.reportTx! });
    const ev = parseEventLogs({ abi, logs: rc.logs, eventName: "BuyExecuted" });
    expect(ev).toHaveLength(1);
    const args = ev[0]!.args as { reportHash: Hex; ordId: string; status: number; filledTL: bigint };
    expect(args.status).toBe(0);
    expect(args.ordId).toBe("ord-1");
    const line = logger.lines.find((l) => (JSON.parse(l) as { event?: string; actionId?: string }).event === "execution" && (JSON.parse(l) as { actionId?: string }).actionId === id)!;
    expect(args.reportHash).toBe(keccak256(stringToBytes(line)));
    expect((await exec(id)).reasons).toEqual(["ALREADY_EXECUTED"]);
  });

  it("TOO_LATE release: openBy − now < 12 dk → RET; izin zincirde CANCELED ile serbest, reservedTL açılır", async () => {
    const id = await requestBuy(acct("elif").address, 10000n);
    expect((await cycle()).reservedTL).toBe(10000n);
    await raw("evm_increaseTime", [4 * 60]);
    await raw("evm_mine");
    offsetMs += 4 * 60_000;
    const r = await exec(id);
    expect(r).toMatchObject({ verdict: "RET", reasons: ["TOO_LATE"] });
    expect(r.reportTx).toBeDefined();
    expect(await actionState(id)).toBe(1);
    expect((await cycle()).reservedTL).toBe(0n);
    const rc = await pub().getTransactionReceipt({ hash: r.reportTx! });
    const ev = parseEventLogs({ abi, logs: rc.logs, eventName: "BuyExecuted" });
    expect(ev[0]!.args).toMatchObject({ ordId: "", filledTL: 0n, avgPxE6: 0n, status: 2 });
  });

  it("yabancı plan: saldırgan kendi planına PİLOT/KULE/agentId yazar, PİLOT onun adına izin alır → KULE RET NO_AUTHORIZATION", async () => {
    await setPlan("attacker");
    const id = await requestBuy(acct("attacker").address, 20000n);
    const r = await exec(id);
    expect(r).toMatchObject({ verdict: "RET", reasons: ["NO_AUTHORIZATION"] });
    expect(app.store.get(id)).toBeUndefined();
    expect((app.executor as unknown as { d: { exchange: FakeExchange } }).d.exchange.placed).toHaveLength(1); // yalnız mutlu yoldaki emir
  });

  it("ERC-8004: agentWallet başka cüzdana bağlıysa RET NO_AUTHORIZATION; geri alınınca çalışır", async () => {
    const id = await requestBuy(acct("elif").address, 10000n);
    await raw("anvil_setCode", [IDENTITY, mockIdentityCode(acct("attacker").address)]);
    expect(await exec(id)).toMatchObject({ verdict: "RET", reasons: ["NO_AUTHORIZATION"] });
    expect(app.store.get(id)).toBeUndefined();
    await raw("anvil_setCode", [IDENTITY, mockIdentityCode(acct("pilot").address)]);
    expect((await exec(id)).verdict).toBe("ONAY");
  });

  it("eski plan izni: izinden sonra Elif planı yenileyince (PlanSet immediate) eski izin reddedilir; yeni izin çalışır", async () => {
    const oldId = await requestBuy(acct("elif").address, 10000n);
    await setPlan("elif", { cycleTL: 70000n }); // aynı ya da daha sıkı → hemen etkin → PlanSet(immediate=true)
    expect(await exec(oldId)).toMatchObject({ verdict: "RET", reasons: ["NO_AUTHORIZATION"] });
    const newId = await requestBuy(acct("elif").address, 10000n);
    expect((await exec(newId)).verdict).toBe("ONAY");
  });

  it("plan iptal edilince (revoke) izin uygulanamaz; kule_status YETKİ_YOK", async () => {
    const id = await requestBuy(acct("elif").address, 10000n);
    const h = await wallet("elif").writeContract({ address: flightPlan, abi, functionName: "revoke" });
    await pub().waitForTransactionReceipt({ hash: h });
    expect(await exec(id)).toMatchObject({ verdict: "RET", reasons: ["NO_AUTHORIZATION"] });
    expect((await app.health.check({ includeCaa: true })).state).toBe("YETKİ_YOK");
  });
});
