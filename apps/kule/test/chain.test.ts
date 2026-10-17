import { describe, expect, it } from "vitest";
import {
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  parseAbi,
  parseAbiItem,
  toHex,
  zeroAddress,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalancheFuji } from "viem/chains";
import { parseDeployments } from "@pilot/shared";
import {
  ChainDataError,
  ChainUnreadableError,
  FLIGHT_PLAN_ABI,
  IDENTITY_ABI,
  PlanEventIndex,
  ViemKuleChain,
  decodeAgentWallet,
  posGreater,
} from "../src/chain.js";
import { AGENT, AGENT2, REPORTER, USER, makePlan } from "./helpers.js";

describe("(b) ERC-8004 agentWallet çözümü", () => {
  const raw20 = `0x${AGENT.slice(2)}` as Hex;
  const word32 = `0x${"00".repeat(12)}${AGENT.slice(2)}` as Hex;

  it("20 bayt ham ve 32 bayt abi kelimesi aynı adresi verir (Fuji'de canlı doğrulanan biçim: 20 bayt)", () => {
    expect(decodeAgentWallet(raw20).toLowerCase()).toBe(AGENT.toLowerCase());
    expect(decodeAgentWallet(word32).toLowerCase()).toBe(AGENT.toLowerCase());
  });

  it.each([
    ["boş", "0x"],
    ["19 bayt", `0x${"11".repeat(19)}`],
    ["21 bayt", `0x${"11".repeat(21)}`],
    ["33 bayt", `0x${"11".repeat(33)}`],
    ["64 bayt (iki kelime)", `0x${"00".repeat(12)}${"11".repeat(20)}${"00".repeat(32)}`],
    ["32 bayt ama üst baytlar kirli", `0x${"01".repeat(12)}${"11".repeat(20)}`],
    ["sıfır adres 20 bayt", `0x${"00".repeat(20)}`],
    ["sıfır adres 32 bayt", `0x${"00".repeat(32)}`],
    ["hex değil", "0xzz"],
    ["0x'siz", "1234"],
  ])("%s → ChainDataError (fail-closed)", (_n, hex) => {
    expect(() => decodeAgentWallet(hex as Hex)).toThrow(ChainDataError);
  });
});

describe("(c) olay dizini: izin, son plan değişikliğinden eskiyse stale", () => {
  it("blok ve logIndex sırası", () => {
    expect(posGreater({ block: 5n, logIndex: 0 }, { block: 4n, logIndex: 9 })).toBe(true);
    expect(posGreater({ block: 5n, logIndex: 2 }, { block: 5n, logIndex: 1 })).toBe(true);
    expect(posGreater({ block: 5n, logIndex: 1 }, { block: 5n, logIndex: 1 })).toBe(false);
  });
  it("plan değişikliği yoksa current; izin bulunamazsa unknown; sonraki PlanSet/PlanRevoked stale yapar; aynı blokta sonraki logIndex stale", () => {
    const i = new PlanEventIndex();
    expect(i.freshness("1")).toBe("unknown");
    i.addPermit("1", { block: 10n, logIndex: 3 });
    expect(i.freshness("1")).toBe("current");
    i.addPlanChange({ block: 9n, logIndex: 0 }); // izinden önce
    expect(i.freshness("1")).toBe("current");
    i.addPlanChange({ block: 10n, logIndex: 4 }); // aynı blok, sonra
    expect(i.freshness("1")).toBe("stale");
    i.addPermit("2", { block: 11n, logIndex: 0 }); // değişiklikten sonra verilmiş
    expect(i.freshness("2")).toBe("current");
    i.addPlanChange({ block: 12n, logIndex: 0 }); // revoke ya da commitPending
    expect(i.freshness("2")).toBe("stale");
    expect(i.freshness("1")).toBe("stale");
  });
});

// ── viem uygulaması, sahte JSON-RPC ile (ağ yok) ──

const FAKE_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const EV_PLAN_SET = parseAbiItem("event PlanSet(address indexed user, bytes32 planHash, bool immediate, uint64 activeAt)");
const EV_PLAN_REVOKED = parseAbiItem("event PlanRevoked(address indexed user)");
const EV_BUY_AUTH = parseAbiItem("event BuyAuthorized(uint256 indexed actionId, address indexed user, uint256 indexed agentId, uint64 amountTL, uint64 maxPxE6, uint8 ordType, uint64 openBy, bytes32 reasonHash)");
const FLIGHT = "0x2222222222222222222222222222222222222222" as const;
const IDENTITY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const;

const DEPLOY = parseDeployments(
  JSON.stringify({
    chainId: 43113,
    deployBlock: 1000,
    deployer: "0x1111111111111111111111111111111111111112",
    erc8004: { identity: IDENTITY, reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713", validation: "0x8004Cb1BF31DAf7788923b405b754f57acEB4272" },
    flightPlan: FLIGHT,
    kuleReporter: privateKeyToAccount(FAKE_PK).address,
    pilotAgent: AGENT,
    agentId: "1",
  }),
);

interface FakeLog {
  topics: Hex[];
  data: Hex;
  block: number;
  logIndex: number;
}

function planSetLog(user: `0x${string}`, immediate: boolean, block: number, logIndex = 0): FakeLog {
  return {
    topics: encodeEventTopics({ abi: [EV_PLAN_SET], eventName: "PlanSet", args: { user } }) as Hex[],
    data: encodeAbiParameters([{ type: "bytes32" }, { type: "bool" }, { type: "uint64" }], ["0x" + "ab".repeat(32) as Hex, immediate, 0n]),
    block,
    logIndex,
  };
}
function revokedLog(user: `0x${string}`, block: number): FakeLog {
  return { topics: encodeEventTopics({ abi: [EV_PLAN_REVOKED], eventName: "PlanRevoked", args: { user } }) as Hex[], data: "0x", block, logIndex: 0 };
}
function authLog(actionId: bigint, user: `0x${string}`, block: number, logIndex = 0): FakeLog {
  return {
    topics: encodeEventTopics({ abi: [EV_BUY_AUTH], eventName: "BuyAuthorized", args: { actionId, user, agentId: 1n } }) as Hex[],
    data: encodeAbiParameters(
      [{ type: "uint64" }, { type: "uint64" }, { type: "uint8" }, { type: "uint64" }, { type: "bytes32" }],
      [10000n, 49_500_000n, 0, 1_790_000_900n, ("0x" + "00".repeat(32)) as Hex],
    ),
    block,
    logIndex,
  };
}

function fakeRpc(o: { logs: FakeLog[]; head: number; maxRange?: number; failCalls?: boolean; metadata?: Hex; planAgent?: `0x${string}`; active?: boolean }) {
  const calls: { method: string; from?: number; to?: number }[] = [];
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      const p = (params ?? []) as unknown[];
      if (o.failCalls) throw new Error("rpc yok");
      switch (method) {
        case "eth_chainId":
          return toHex(43113);
        case "eth_blockNumber":
          calls.push({ method });
          return toHex(o.head);
        case "eth_getLogs": {
          const f = p[0] as { address: string; topics: (Hex | Hex[] | null)[]; fromBlock: Hex; toBlock: Hex };
          const from = Number(BigInt(f.fromBlock));
          const to = Number(BigInt(f.toBlock));
          if (o.maxRange !== undefined && to - from + 1 > o.maxRange) throw new Error("query range too large");
          calls.push({ method, from, to });
          const out = o.logs
            .filter((l) => l.block >= from && l.block <= to)
            .filter((l) => f.topics.every((t, i) => t === null || t === undefined || (Array.isArray(t) ? t.includes(l.topics[i]!) : t.toLowerCase() === l.topics[i]!.toLowerCase())))
            .map((l) => ({
              address: FLIGHT,
              topics: l.topics,
              data: l.data,
              blockNumber: toHex(l.block),
              logIndex: toHex(l.logIndex),
              transactionHash: "0x" + "cd".repeat(32),
              transactionIndex: "0x0",
              blockHash: "0x" + "ef".repeat(32),
              removed: false,
            }));
          return out;
        }
        case "eth_call": {
          const tx = p[0] as { to: string; data: Hex };
          if (tx.to.toLowerCase() === IDENTITY.toLowerCase()) {
            decodeFunctionData({ abi: IDENTITY_ABI, data: tx.data });
            return encodeFunctionResult({ abi: IDENTITY_ABI, functionName: "getMetadata", result: o.metadata ?? (`0x${AGENT.slice(2)}` as Hex) });
          }
          const d = decodeFunctionData({ abi: FLIGHT_PLAN_ABI, data: tx.data });
          if (d.functionName === "isPlanActive") return encodeFunctionResult({ abi: FLIGHT_PLAN_ABI, functionName: "isPlanActive", result: o.active ?? true });
          if (d.functionName === "plans") {
            const pl = makePlan({ agent: o.planAgent ?? AGENT, kule: REPORTER });
            return encodeFunctionResult({
              abi: FLIGHT_PLAN_ABI,
              functionName: "plans",
              result: {
                cycleTL: BigInt(pl.cycleTL),
                maxOrderTL: BigInt(pl.maxOrderTL),
                startDay: pl.startDay,
                deadlineDay: pl.deadlineDay,
                maxWaitH: pl.maxWaitH,
                bandBps: pl.bandBps,
                closedBandBps: pl.closedBandBps,
                askMode: pl.askMode,
                expiresAt: BigInt(pl.expiresAt),
                agent: pl.agent,
                kule: pl.kule,
                agentId: 1n,
              },
            });
          }
          if (d.functionName === "actions") {
            const id = d.args![0] as bigint;
            return encodeFunctionResult({
              abi: FLIGHT_PLAN_ABI,
              functionName: "actions",
              result:
                id === 7n
                  ? { user: USER, amountTL: 10000n, maxPxE6: 49_500_000n, ordType: 0, openBy: 1_790_000_900n, reportBy: 1_790_004_500n, cycleId: 202610, state: 0 }
                  : { user: zeroAddress, amountTL: 0n, maxPxE6: 0n, ordType: 0, openBy: 0n, reportBy: 0n, cycleId: 0, state: 0 },
            });
          }
          throw new Error(`beklenmeyen çağrı ${d.functionName}`);
        }
        default:
          throw new Error(`beklenmeyen yöntem ${method}`);
      }
    },
  }, { retryCount: 0 });
  return { transport, calls };
}

const mk = (rpc: ReturnType<typeof fakeRpc>, extra: { logChunk?: number } = {}) =>
  new ViemKuleChain({ transport: rpc.transport, chain: avalancheFuji, deployments: DEPLOY, account: privateKeyToAccount(FAKE_PK), planUser: USER, ...extra });

describe("ViemKuleChain (sahte JSON-RPC)", () => {
  it("izin, plan, plan aktif ve agentWallet okunur; izin yoksa null; plan agent yoksa null", async () => {
    const c = mk(fakeRpc({ logs: [], head: 1100 }));
    expect(await c.readAction("7")).toMatchObject({ user: USER, amountTL: 10000, ordType: "post_only", state: "AUTHORIZED", openBy: 1_790_000_900 });
    expect(await c.readAction("8")).toBeNull();
    expect(await c.readPlan(USER)).toMatchObject({ agent: AGENT, kule: REPORTER, agentId: "1" });
    expect(await c.isPlanActive(USER)).toBe(true);
    expect((await c.agentWallet("1")).toLowerCase()).toBe(AGENT.toLowerCase());
    expect(await c.blockNumber()).toBe(1100);
    expect(await mk(fakeRpc({ logs: [], head: 1100, planAgent: zeroAddress })).readPlan(USER)).toBeNull();
  });

  it("agentWallet 32 baytlık abi kelimesi dönerse de çözülür; bozuk bayt ChainDataError; RPC hatası ChainUnreadableError", async () => {
    const word = `0x${"00".repeat(12)}${AGENT2.slice(2)}` as Hex;
    expect((await mk(fakeRpc({ logs: [], head: 1, metadata: word })).agentWallet("1")).toLowerCase()).toBe(AGENT2.toLowerCase());
    await expect(mk(fakeRpc({ logs: [], head: 1, metadata: "0x1234" })).agentWallet("1")).rejects.toBeInstanceOf(ChainDataError);
    const down = mk(fakeRpc({ logs: [], head: 1, failCalls: true }));
    await expect(down.agentWallet("1")).rejects.toBeInstanceOf(ChainUnreadableError);
    await expect(down.readAction("7")).rejects.toBeInstanceOf(ChainUnreadableError);
    await expect(down.readPlan(USER)).rejects.toBeInstanceOf(ChainUnreadableError);
    await expect(down.isPlanActive(USER)).rejects.toBeInstanceOf(ChainUnreadableError);
    await expect(down.blockNumber()).rejects.toBeInstanceOf(ChainUnreadableError);
    await expect(down.permitFreshness("7", USER)).rejects.toBeInstanceOf(ChainUnreadableError);
  });

  it("permitFreshness: izin plan değişikliğinden sonra → current", async () => {
    const c = mk(fakeRpc({ logs: [planSetLog(USER, true, 1010), authLog(7n, USER, 1020)], head: 1100 }));
    expect(await c.permitFreshness("7", USER)).toBe("current");
    expect(await c.permitFreshness("8", USER)).toBe("unknown"); // bu izin için log yok
  });

  it("permitFreshness: izinden sonra PlanSet(immediate=true) (sıkılaştırma ya da commitPending) → stale", async () => {
    const c = mk(fakeRpc({ logs: [authLog(7n, USER, 1020), planSetLog(USER, true, 1030)], head: 1100 }));
    expect(await c.permitFreshness("7", USER)).toBe("stale");
  });

  it("permitFreshness: izinden sonra PlanRevoked → stale", async () => {
    const c = mk(fakeRpc({ logs: [authLog(7n, USER, 1020), revokedLog(USER, 1050)], head: 1100 }));
    expect(await c.permitFreshness("7", USER)).toBe("stale");
  });

  it("permitFreshness: PlanSet(immediate=false) bekleyen plan etkin plana dokunmaz → current", async () => {
    const c = mk(fakeRpc({ logs: [authLog(7n, USER, 1020), planSetLog(USER, false, 1030)], head: 1100 }));
    expect(await c.permitFreshness("7", USER)).toBe("current");
  });

  it("permitFreshness: aynı blokta sonraki logIndex'li PlanSet → stale; öncekiyse current", async () => {
    expect(await mk(fakeRpc({ logs: [authLog(7n, USER, 1020, 2), planSetLog(USER, true, 1020, 5)], head: 1100 })).permitFreshness("7", USER)).toBe("stale");
    expect(await mk(fakeRpc({ logs: [planSetLog(USER, true, 1020, 1), authLog(7n, USER, 1020, 2)], head: 1100 })).permitFreshness("7", USER)).toBe("current");
  });

  it("başka kullanıcının plan olayları ve izinleri sayılmaz; yapılandırılmamış kullanıcı için unknown", async () => {
    const other = "0x9999999999999999999999999999999999999999" as const;
    const c = mk(fakeRpc({ logs: [authLog(7n, USER, 1020), revokedLog(other, 1050), authLog(9n, other, 1060)], head: 1100 }));
    expect(await c.permitFreshness("7", USER)).toBe("current");
    expect(await c.permitFreshness("9", USER)).toBe("unknown");
    expect(await c.permitFreshness("7", other)).toBe("unknown");
  });

  it("tarama deployBlock'tan başlar ve artımlıdır (ikinci çağrıda yalnız yeni bloklar); aralık hatasında parça yarıya iner", async () => {
    const rpc = fakeRpc({ logs: [authLog(7n, USER, 1500)], head: 5000, maxRange: 700 });
    const c = mk(rpc, { logChunk: 4096 });
    expect(await c.permitFreshness("7", USER)).toBe("current");
    const ranges = rpc.calls.filter((x) => x.method === "eth_getLogs");
    expect(ranges[0]!.from).toBe(1000); // deployBlock
    expect(Math.max(...ranges.map((r) => r.to! - r.from! + 1))).toBeLessThanOrEqual(700);
    const before = rpc.calls.filter((x) => x.method === "eth_getLogs").length;
    expect(await c.permitFreshness("7", USER)).toBe("current");
    expect(rpc.calls.filter((x) => x.method === "eth_getLogs").length).toBe(before); // yeni blok yok → yeni tarama yok
  });

  it("eşzamanlı çağrılar tek taramada birleşir", async () => {
    const rpc = fakeRpc({ logs: [authLog(7n, USER, 1020)], head: 1100 });
    const c = mk(rpc);
    await Promise.all([c.permitFreshness("7", USER), c.permitFreshness("7", USER), c.permitFreshness("7", USER)]);
    expect(rpc.calls.filter((x) => x.method === "eth_getLogs").length).toBe(3); // 1 tarama × 3 olay türü
  });

  it("ABI: FlightPlan ve kimlik kaydı imzaları", () => {
    expect(parseAbi(["function getMetadata(uint256 agentId, string metadataKey) view returns (bytes)"])).toHaveLength(1);
    expect(REPORTER).toMatch(/^0x/);
  });
});
