/**
 * E-4 ve M-1, yerel Anvil'de gerçek FlightPlan ile (gerçek ağa gönderim yok; yalnız 127.0.0.1).
 * - E-4 [ANVIL]: stolen-key (kütüphane ve CLI --local) → BuyRejected(3) makbuzda ve zincirde; hiç izin oluşmaz.
 * - M-1 [ANVIL]: gerçek BuyAuthorized/BuyExecuted olayları parça parça getLogs ile okunur, taklit OKX ile eşleşir.
 * Anahtarlar: PİLOT anahtarı her çalıştırmada generatePrivateKey ile üretilir, anvil_setBalance ile fonlanır;
 * diğer roller Anvil'in kilidi açık hesaplarıdır (anahtar yok). Hiçbir anahtar dosyaya yazılmaz.
 * Anvil ya da forge build çıktısı (contracts/out) yoksa bu dosya atlanır.
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
import { ERC8004_FUJI, secToMs, STOLEN_KEY_MESSAGE, trDateToSec } from "@pilot/shared";
import { FLIGHT_PLAN_SCRIPT_ABI } from "../lib/mutabakat-abi.js";
import { OPEN_WINDOW_SEC } from "../lib/mutabakat-match.js";
import { runMutabakat } from "../lib/mutabakat-run.js";
import { runStolenKey } from "../lib/stolen-io.js";
import { headersOf, okxHandler, order, REPO } from "./helpers.js";

const ARTIFACT = join(REPO, "contracts/out/FlightPlan.sol/FlightPlan.json");
const HAS_ANVIL = spawnSync("anvil", ["--version"]).status === 0;
const READY = HAS_ANVIL && existsSync(ARTIFACT);

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

describe.skipIf(!READY)("E-4 / M-1 [ANVIL] gerçek FlightPlan, yerel zincir", () => {
  let anvil: ChildProcess;
  let rpc: string;
  let dir: string;
  let deploymentsPath: string;
  let flightPlan: Address;
  let elif: Address;
  let kule: Address;
  let pk: Hex;
  let agent: Address;
  let abi: Abi;

  const pub = () => createPublicClient({ chain: avalancheFuji, transport: http(rpc) });
  const walletOf = (account: Address) => createWalletClient({ chain: avalancheFuji, transport: http(rpc), account });

  beforeAll(async () => {
    const port = await freePort();
    rpc = `http://127.0.0.1:${port}`;
    // TR 5 Ekim 2026 12:00 — plan penceresi (1–25) içinde.
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
    const [deployer, , kuleAcc, elifAcc] = accounts as [Address, Address, Address, Address];
    elif = getAddress(elifAcc);
    kule = getAddress(kuleAcc);
    pk = generatePrivateKey();
    agent = privateKeyToAccount(pk).address;
    await createTestClient({ chain: avalancheFuji, mode: "anvil", transport: http(rpc) }).setBalance({ address: agent, value: parseEther("10") });

    const deployBlock = Number(await pub().getBlockNumber());
    const hash = await walletOf(deployer).deployContract({ abi, bytecode: art.bytecode.object });
    const rc = await pub().waitForTransactionReceipt({ hash });
    flightPlan = rc.contractAddress!;

    const now = Number((await pub().getBlock()).timestamp);
    const plan = {
      cycleTL: 300n, maxOrderTL: 150n, startDay: 1, deadlineDay: 25, maxWaitH: 72, bandBps: 0, closedBandBps: 500, askMode: 1,
      expiresAt: BigInt(now + 90 * 86_400), agent, kule, agentId: 17n,
    };
    const h2 = await walletOf(elif).writeContract({ address: flightPlan, abi, functionName: "setPlan", args: [plan] });
    await pub().waitForTransactionReceipt({ hash: h2 });

    dir = mkdtempSync(join(tmpdir(), "stolen-anvil-"));
    deploymentsPath = join(dir, ".anvil.json");
    // Yalnız herkese açık adresler; anahtar yok.
    writeFileSync(deploymentsPath, JSON.stringify({
      chainId: 43113, flightPlan, deployBlock, deployer, pilotAgent: agent, kuleReporter: kule, erc8004: ERC8004_FUJI, agentId: "17",
    }));
  }, 30_000);

  afterAll(() => {
    anvil?.kill();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const env = () => ({ ANVIL_RPC: rpc, PILOT_AGENT_PRIVATE_KEY: pk, PLAN_USER_ADDRESS: elif });

  it("E-4 [ANVIL] PİLOT anahtarıyla 40.000 TL → makbuzda BuyRejected(3); hiç izin oluşmaz; sahte actionId → RET", async () => {
    const lines: string[] = [];
    const code = await runStolenKey({ argv: ["--local", "--deployments", deploymentsPath], env: env(), out: (l) => lines.push(l) });
    const text = lines.join("\n");
    expect(code, text).toBe(0);
    expect(text).toContain("BuyRejected — kod 3 OVER_ORDER_LIMIT");
    expect(text).toContain("KULE: RET NO_AUTHORIZATION");
    expect(text).toContain(STOLEN_KEY_MESSAGE);

    const rejected = await pub().getContractEvents({ address: flightPlan, abi: FLIGHT_PLAN_SCRIPT_ABI, eventName: "BuyRejected", fromBlock: 0n });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.args).toMatchObject({ user: elif, agentId: 17n, amountTL: 40_000n, code: 3 });
    expect(await pub().readContract({ address: flightPlan, abi: FLIGHT_PLAN_SCRIPT_ABI, functionName: "lastActionId" })).toBe(0n);
  });

  it("E-4 [ANVIL] CLI: tsx scripts/stolen-key.ts --local (anahtar yalnız ortamdan) → çıkış 0, sahne metni Türkçe", async () => {
    const tsx = join(REPO, "node_modules/.bin/tsx");
    const res = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const p = spawn(tsx, [join(REPO, "scripts/stolen-key.ts"), "--local", "--deployments", deploymentsPath], {
        env: { PATH: process.env.PATH ?? "", ...env() },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      p.stdout.on("data", (b) => (out += String(b)));
      p.stderr.on("data", (b) => (out += String(b)));
      p.on("close", (code) => resolve({ code, out }));
    });
    expect(res.code, res.out).toBe(0);
    expect(res.out).toContain("Sahne: Ajan anahtarı çalındı");
    expect(res.out).toContain("Etiket: YEREL · Anvil");
    expect(res.out).toContain("BuyRejected — kod 3 OVER_ORDER_LIMIT");
    expect(res.out).not.toContain(pk.slice(2));
  }, 30_000);

  it("E-4 [ANVIL] tavan 40.000'e izin veren plan: ön kontrol durdurur, işlem gönderilmez (çıkış 2)", async () => {
    // Ayrı kullanıcı: başka bir kilidi açık hesap, aynı ajanla gevşek bir plan kurar.
    const accounts = await createWalletClient({ chain: avalancheFuji, transport: http(rpc) }).getAddresses();
    const loose = accounts[5]!;
    const now = Number((await pub().getBlock()).timestamp);
    const plan = {
      cycleTL: 100_000n, maxOrderTL: 50_000n, startDay: 1, deadlineDay: 25, maxWaitH: 72, bandBps: 0, closedBandBps: 500, askMode: 1,
      expiresAt: BigInt(now + 86_400), agent, kule, agentId: 17n,
    };
    await pub().waitForTransactionReceipt({ hash: await walletOf(loose).writeContract({ address: flightPlan, abi, functionName: "setPlan", args: [plan] }) });
    const before = await pub().getTransactionCount({ address: agent });
    const lines: string[] = [];
    const code = await runStolenKey({ argv: ["--local", "--deployments", deploymentsPath], env: { ...env(), PLAN_USER_ADDRESS: loose }, out: (l) => lines.push(l) });
    expect(code).toBe(2);
    expect(lines.join("\n")).toContain("işlem gönderilmedi");
    expect(await pub().getTransactionCount({ address: agent })).toBe(before);
    expect(await pub().readContract({ address: flightPlan, abi: FLIGHT_PLAN_SCRIPT_ABI, functionName: "lastActionId" })).toBe(0n);
  });

  it("M-1 [ANVIL] gerçek izin + rapor olayları parça parça okunur; taklit OKX emriyle EŞLEŞTİ, izinsiz emir ALARM", async () => {
    // Elif'in planında 100 TL izin (PİLOT) ve rapor (KULE, kilidi açık hesap).
    const agentWallet = createWalletClient({ chain: avalancheFuji, transport: http(rpc), account: privateKeyToAccount(pk) });
    const h1 = await agentWallet.writeContract({
      address: flightPlan, abi: FLIGHT_PLAN_SCRIPT_ABI, functionName: "requestBuy", args: [elif, 100n, 41_000_000n, 1, `0x${"11".repeat(32)}`, []],
    });
    await pub().waitForTransactionReceipt({ hash: h1 });
    const [ev] = await pub().getContractEvents({ address: flightPlan, abi: FLIGHT_PLAN_SCRIPT_ABI, eventName: "BuyAuthorized", fromBlock: 0n });
    const openBy = Number(ev!.args.openBy);
    const h2 = await walletOf(kule).writeContract({
      address: flightPlan, abi, functionName: "reportExecution", args: [ev!.args.actionId, "880001", 98n, 40_900_000n, 0, `0x${"22".repeat(32)}`],
    });
    await pub().waitForTransactionReceipt({ hash: h2 });

    const nowSec = Number((await pub().getBlock()).timestamp);
    const at = String(secToMs(openBy - OPEN_WINDOW_SEC + 30));
    const creds = { apiKey: "elif-ro-key", secret: "elif-ro-secret", passphrase: "elif-ro-pass" };
    const okx = okxHandler({
      ...creds,
      history: [
        order({ ordId: "880001", clOrdId: `plt${ev!.args.actionId}`, cTime: at, px: "41", sz: "2.4", accFillSz: "2.4", avgPx: "40.9" }), // 98,16 TL
        order({ ordId: "880002", clOrdId: "", cTime: at, accFillSz: "900", sz: "900" }),
      ],
    });
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const net = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      seen.push({ url: url.href, headers: headersOf(init) });
      if (url.origin === "https://tr.okx.com") return okx.handle(url, init);
      if (url.href.startsWith(rpc)) return fetch(input, init);
      throw new Error(`test dışı adres: ${url.href}`);
    }) as typeof fetch;

    const lines: string[] = [];
    const code = await runMutabakat({
      argv: ["--deployments", deploymentsPath],
      env: { OKX_READONLY_API_KEY: creds.apiKey, OKX_READONLY_SECRET: creds.secret, OKX_READONLY_PASSPHRASE: creds.passphrase, FUJI_RPC: rpc, USER: elif },
      fetch: net,
      now: () => new Date(secToMs(nowSec)),
      out: (l) => lines.push(l),
      chunk: 2n,
    });
    const text = lines.join("\n");
    expect(code, text).toBe(1);
    expect(text).toContain("1 izin, 1 rapor");
    expect(lines.find((l) => l.includes("plt1"))).toMatch(/^EŞLEŞTİ/);
    expect(lines.filter((l) => l.startsWith("ALARM BORSADA VAR, ZİNCİRDE YOK"))).toHaveLength(1);
    for (const s of seen.filter((x) => x.url.startsWith(rpc))) {
      expect(JSON.stringify(s.headers)).not.toContain(creds.apiKey);
      expect(JSON.stringify(s.headers)).not.toContain(creds.passphrase);
    }
  });
});
