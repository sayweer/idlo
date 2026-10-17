/**
 * E-4 [ANVIL] saldırgan: plan yokken ve plan iptal edilmişken stolen-key, gerçek FlightPlan ile (yalnız 127.0.0.1).
 * - Betik çökmeden, Türkçe mesajla durur ve işlem göndermez (nonce değişmez).
 * - Betiğin ön kontrolü atlanıp çalınmış anahtarla doğrudan requestBuy gönderilse bile kontrat izin vermez.
 * Anahtar her çalıştırmada üretilir; dosyaya yazılmaz (deployments JSON'u yalnız adres içerir).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, createTestClient, createWalletClient, getAddress, http, parseEther, type Abi, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { avalancheFuji } from "viem/chains";
import { ERC8004_FUJI, trDateToSec } from "@pilot/shared";
import { FLIGHT_PLAN_SCRIPT_ABI } from "../lib/mutabakat-abi.js";
import { runStolenKey } from "../lib/stolen-io.js";
import { REPO } from "./helpers.js";

const ARTIFACT = join(REPO, "contracts/out/FlightPlan.sol/FlightPlan.json");
const READY = spawnSync("anvil", ["--version"]).status === 0 && existsSync(ARTIFACT);

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => res(p));
    });
    s.on("error", rej);
  });
}

describe.skipIf(!READY)("E-4 [ANVIL] saldırgan: plan yok / plan iptal", () => {
  let anvil: ChildProcess;
  let rpc: string;
  let dir: string;
  let deploymentsPath: string;
  let flightPlan: Address;
  let noPlanUser: Address;
  let revokedUser: Address;
  let kule: Address;
  let pk: Hex;
  let agent: Address;
  let abi: Abi;

  const pub = () => createPublicClient({ chain: avalancheFuji, transport: http(rpc) });
  const walletOf = (account: Address) => createWalletClient({ chain: avalancheFuji, transport: http(rpc), account });
  const lastActionId = () => pub().readContract({ address: flightPlan, abi: FLIGHT_PLAN_SCRIPT_ABI, functionName: "lastActionId" });
  const authorizedEvents = () => pub().getContractEvents({ address: flightPlan, abi: FLIGHT_PLAN_SCRIPT_ABI, eventName: "BuyAuthorized", fromBlock: 0n });

  beforeAll(async () => {
    const port = await freePort();
    rpc = `http://127.0.0.1:${port}`;
    const t0 = trDateToSec(2026, 10, 5, 12, 0);
    anvil = spawn("anvil", ["--port", String(port), "--chain-id", "43113", "--timestamp", String(t0), "--quiet"], { stdio: "ignore" });
    for (let i = 0; i < 100; i++) {
      try {
        await pub().getChainId();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const art = JSON.parse(readFileSync(ARTIFACT, "utf8")) as { abi: Abi; bytecode: { object: Hex } };
    abi = art.abi;
    const accounts = await createWalletClient({ chain: avalancheFuji, transport: http(rpc) }).getAddresses();
    const [deployer, , kuleAcc, a3, a4] = accounts as [Address, Address, Address, Address, Address];
    kule = getAddress(kuleAcc);
    noPlanUser = getAddress(a3);
    revokedUser = getAddress(a4);
    pk = generatePrivateKey();
    agent = privateKeyToAccount(pk).address;
    await createTestClient({ chain: avalancheFuji, mode: "anvil", transport: http(rpc) }).setBalance({ address: agent, value: parseEther("10") });

    const deployBlock = Number(await pub().getBlockNumber());
    const hash = await walletOf(deployer).deployContract({ abi, bytecode: art.bytecode.object });
    flightPlan = (await pub().waitForTransactionReceipt({ hash })).contractAddress!;

    // revokedUser: plan kurar (tavan 150 TL), sonra iptal eder.
    const now = Number((await pub().getBlock()).timestamp);
    const plan = {
      cycleTL: 300n, maxOrderTL: 150n, startDay: 1, deadlineDay: 25, maxWaitH: 72, bandBps: 0, closedBandBps: 500, askMode: 1,
      expiresAt: BigInt(now + 90 * 86_400), agent, kule, agentId: 17n,
    };
    await pub().waitForTransactionReceipt({ hash: await walletOf(revokedUser).writeContract({ address: flightPlan, abi, functionName: "setPlan", args: [plan] }) });
    await pub().waitForTransactionReceipt({ hash: await walletOf(revokedUser).writeContract({ address: flightPlan, abi, functionName: "revoke", args: [] }) });

    dir = mkdtempSync(join(tmpdir(), "stolen-adv-anvil-"));
    deploymentsPath = join(dir, ".anvil.json");
    writeFileSync(deploymentsPath, JSON.stringify({
      chainId: 43113, flightPlan, deployBlock, deployer, pilotAgent: agent, kuleReporter: kule, erc8004: ERC8004_FUJI, agentId: "17",
    }));
  }, 30_000);

  afterAll(() => {
    anvil?.kill();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function runFor(user: Address) {
    const lines: string[] = [];
    const before = await pub().getTransactionCount({ address: agent });
    const code = await runStolenKey({
      argv: ["--local", "--deployments", deploymentsPath],
      env: { ANVIL_RPC: rpc, PILOT_AGENT_PRIVATE_KEY: pk, PLAN_USER_ADDRESS: user },
      out: (l) => lines.push(l),
    });
    const after = await pub().getTransactionCount({ address: agent });
    return { code, text: lines.join("\n"), sentTx: after - before };
  }

  it("E-4 [ANVIL] Elif'in planı yok → çıkış 2, 'planı yok', işlem gönderilmez, anahtar çıktıda yok", async () => {
    const r = await runFor(noPlanUser);
    expect(r.code, r.text).toBe(2);
    expect(r.text).toContain("planı yok");
    expect(r.text).toContain("işlem gönderilmedi");
    expect(r.text).not.toContain(pk.slice(2));
    expect(r.sentTx).toBe(0);
    expect(await lastActionId()).toBe(0n);
  });

  it("E-4 [ANVIL] plan iptal edilmiş → çıkış 2, işlem gönderilmez", async () => {
    const r = await runFor(revokedUser);
    expect(r.code, r.text).toBe(2);
    expect(r.text).toContain("etkin değil");
    expect(r.sentTx).toBe(0);
    expect(await lastActionId()).toBe(0n);
  });

  it("E-4 [ANVIL] ön kontrol atlanıp çalınmış anahtarla doğrudan requestBuy: plan yok → revert, iptal → BuyRejected(1); hiç izin yok", async () => {
    const w = createWalletClient({ chain: avalancheFuji, transport: http(rpc), account: privateKeyToAccount(pk) });
    const args = (user: Address) => [user, 40_000n, 50_000_000n, 1, `0x${"11".repeat(32)}`, []] as const;

    await expect(
      pub().simulateContract({ address: flightPlan, abi: FLIGHT_PLAN_SCRIPT_ABI, functionName: "requestBuy", args: args(noPlanUser), account: privateKeyToAccount(pk) }),
    ).rejects.toThrow(/NotAgent/);

    // Küçük tutarla bile (tavan içinde) iptal edilmiş planda izin çıkmaz.
    for (const amount of [40_000n, 100n]) {
      const h = await w.writeContract({ address: flightPlan, abi: FLIGHT_PLAN_SCRIPT_ABI, functionName: "requestBuy", args: [revokedUser, amount, 50_000_000n, 1, `0x${"11".repeat(32)}`, []] });
      await pub().waitForTransactionReceipt({ hash: h });
    }
    const rejected = await pub().getContractEvents({ address: flightPlan, abi: FLIGHT_PLAN_SCRIPT_ABI, eventName: "BuyRejected", fromBlock: 0n });
    expect(rejected.map((e) => e.args.code)).toEqual([1, 1]);
    expect(await authorizedEvents()).toHaveLength(0);
    expect(await lastActionId()).toBe(0n);
  });
});
