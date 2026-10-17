/**
 * C4 — PİLOT istemcileri: FakeKule (§9.2 temel verdict'leri), gerçek MCP KULE istemcisi (bearer, şema),
 * viem zincir istemcisi (kullanıcı sabit, olaydan sonuç), ortam yapılandırması. Ağ yok: fetch ve JSON-RPC sahte.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  keccak256,
  parseTransaction,
  toFunctionSignature,
  toEventSignature,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { avalancheFuji } from "viem/chains";
import { trDateToSec, type Plan } from "@pilot/shared";
import {
  ChainError,
  ConfigError,
  FLIGHT_PLAN_ABI,
  FakeChain,
  FakeKule,
  KuleError,
  ManualClock,
  McpKuleClient,
  ViemChainClient,
  assertKuleUrl,
  connectKule,
  loadPilotConfig,
  type McpToolCaller,
} from "../src/clients/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT = "0x1111111111111111111111111111111111111111" as Address;
const ELIF = "0x2222222222222222222222222222222222222222" as Address;
const KULE_REP = "0x3333333333333333333333333333333333333333" as Address;
const OTHER_AGENT = "0x4444444444444444444444444444444444444444" as Address;
const FLIGHT_PLAN = "0x6666666666666666666666666666666666666666" as Address;
const TOKEN = "pilot-token-0123456789";
const OTHER_TOKEN = "other-token-0123456789";
const ZERO32 = `0x${"00".repeat(32)}` as Hex;
const NOW_MS = trDateToSec(2026, 11, 2, 12) * 1000;

const PLAN: Plan = {
  cycleTL: 20000, maxOrderTL: 10000, startDay: 1, deadlineDay: 5, maxWaitH: 72, bandBps: 0, closedBandBps: 500,
  askMode: 1, expiresAt: 2_000_000_000, agent: AGENT, kule: KULE_REP, agentId: "7",
};

// ─────────────────────────────── FakeKule ───────────────────────────────

function kuleWorld() {
  const clock = new ManualClock(NOW_MS);
  const chain = new FakeChain(clock);
  chain.setPlan(ELIF, PLAN);
  const kule = new FakeKule({ chain, clock, planUser: ELIF, kuleReporter: KULE_REP, tokens: { [TOKEN]: AGENT, [OTHER_TOKEN]: OTHER_AGENT } });
  const authorize = (amountTL = 10000, ordType: "ioc" | "post_only" = "post_only", maxPxE6 = 42_200_000) => {
    const r = chain.requestBuy(AGENT, ELIF, { amountTL, maxPxE6, ordType, reasonHash: ZERO32 });
    if (r.status !== "AUTHORIZED") throw new Error(`izin beklenirdi: ${r.code}`);
    return r.actionId;
  };
  return { clock, chain, kule, client: kule.clientFor(TOKEN), authorize };
}

describe("C4 FakeKule: paylaşılan KULE şemaları ve §9.2 temel verdict'leri (kâğıt)", () => {
  it("FakeKule U-4 / E-4: zincirde olmayan actionId → RET NO_AUTHORIZATION", async () => {
    const { client } = kuleWorld();
    expect(await client.execute({ actionId: "424242" })).toMatchObject({ verdict: "RET", reasons: ["NO_AUTHORIZATION"], status: "NOT_PLACED" });
  });

  it("FakeKule §9.2-1: geçersiz token → RET AUTH", async () => {
    const w = kuleWorld();
    const id = w.authorize();
    expect(await w.kule.clientFor("bilinmeyen-token-000").execute({ actionId: id })).toMatchObject({ verdict: "RET", reasons: ["AUTH"] });
    expect(w.kule.executions).toHaveLength(0);
  });

  it("FakeKule U-12: başka ajana bağlı token → RET WRONG_AGENT", async () => {
    const w = kuleWorld();
    const id = w.authorize();
    expect(await w.kule.clientFor(OTHER_TOKEN).execute({ actionId: id })).toMatchObject({ verdict: "RET", reasons: ["WRONG_AGENT"] });
  });

  it("FakeKule U-10: aynı izin ikinci kez → RET ALREADY_EXECUTED; yalnız bir emir", async () => {
    const w = kuleWorld();
    const id = w.authorize();
    const [a, b] = await Promise.all([w.client.execute({ actionId: id }), w.client.execute({ actionId: id })]);
    expect([a.verdict, b.verdict].sort()).toEqual(["ONAY", "RET"]);
    expect(w.kule.executions).toHaveLength(1);
    expect((await w.client.execute({ actionId: id })).reasons).toEqual(["ALREADY_EXECUTED"]);
  });

  it("FakeKule U-13: openBy − now < 12 dk → RET TOO_LATE", async () => {
    const w = kuleWorld();
    const id = w.authorize();
    w.clock.advance(3 * 60_000 + 1000);
    expect(await w.client.execute({ actionId: id })).toMatchObject({ verdict: "RET", reasons: ["TOO_LATE"] });
  });

  it("FakeKule U-5 / §16 #14: plan iptal edildiyse izin RET NO_AUTHORIZATION", async () => {
    const w = kuleWorld();
    const id = w.authorize();
    w.chain.revoke(ELIF);
    expect(await w.client.execute({ actionId: id })).toMatchObject({ verdict: "RET", reasons: ["NO_AUTHORIZATION"] });
  });

  it("FakeKule §9.2-3: sağlık NORMAL değilse BEKLET HEALTH:<sebep>; izin kilitli kalmaz", async () => {
    const w = kuleWorld();
    const id = w.authorize();
    w.kule.health.reasons = ["PILOT_HEARTBEAT"];
    expect(await w.client.execute({ actionId: id })).toMatchObject({ verdict: "BEKLET", reasons: ["HEALTH:PILOT_HEARTBEAT"] });
    expect((await w.client.status()).health).toBe("YENİ_EMİR_YOK");
    w.kule.health.reasons = [];
    expect((await w.client.execute({ actionId: id })).verdict).toBe("ONAY");
  });

  it("FakeKule U-6: ioc ve bestAsk > floorTick(maxPx) → BEKLET ABOVE_MAX_PX", async () => {
    const w = kuleWorld();
    const id = w.authorize(10000, "ioc", 42_119_999);
    expect(await w.client.execute({ actionId: id })).toMatchObject({ verdict: "BEKLET", reasons: ["ABOVE_MAX_PX"] });
  });

  it("FakeKule U-15: TRY yalnız fon hesabında → RET BALANCE_IN_FUNDING; hiç yoksa BALANCE", async () => {
    const w = kuleWorld();
    const id = w.authorize();
    w.kule.balance = { TRY: { trading: "50", funding: "20000" }, USDT: { trading: "0", funding: "0" } };
    expect((await w.client.execute({ actionId: id })).reasons).toEqual(["BALANCE_IN_FUNDING"]);
    w.kule.balance = { TRY: { trading: "50", funding: null }, USDT: { trading: "0", funding: null } };
    expect((await w.client.execute({ actionId: id })).reasons).toEqual(["BALANCE"]);
  });

  it("FakeKule §16 #10: veri bayat ya da makas geniş → BEKLET", async () => {
    const w = kuleWorld();
    const id = w.authorize();
    w.kule.market.ageSec = 6;
    expect((await w.client.execute({ actionId: id })).reasons).toEqual(["STALE_DATA"]);
    w.kule.market.ageSec = 1;
    w.kule.market.bestAskE6 = 42_300_000;
    expect((await w.client.execute({ actionId: id })).reasons).toEqual(["WIDE_SPREAD"]);
  });

  it("FakeKule U-14 / U-7: post_only fiyatı tickSz'ye aşağı yuvarlanır, sz × px ≤ amountTL, kâğıt etiketli rapor", async () => {
    const w = kuleWorld();
    w.kule.market = { ...w.kule.market, tickSz: "0.05", bestBidE6: 42_130_000, bestAskE6: 42_140_000 };
    const id = w.authorize(10000, "post_only", 42_149_999);
    const r = await w.client.execute({ actionId: id });
    expect(r).toMatchObject({ verdict: "ONAY", status: "FILLED", paper: true });
    const ex = w.kule.executions[0]!;
    expect(ex.pxE6).toBe(42_100_000); // min(floorTick(42,149999)=42,10 ; floorTick(bestBid)=42,10)
    expect(ex.pxE6 % 50_000).toBe(0);
    expect(ex.filledTL).toBeLessThanOrEqual(10000);
    expect(w.chain.action(id)!.state).toBe("REPORTED");
    expect(w.chain.cycleOfNow(ELIF)).toMatchObject({ spentTL: ex.filledTL, reservedTL: 0 });
    expect((await w.client.status()).mode).toBe("paper");
  });

  it("FakeKule U-2 / U-3: kule_quote DÜZELT (szHint TL sanılmış; px × sz %1'den fazla sapıyor), aksi ONAY", async () => {
    const { client } = kuleWorld();
    expect(await client.quote({ side: "buy", amountTL: 10000, ordType: "post_only", szHint: "10000" })).toMatchObject({
      verdict: "DÜZELT", reasons: ["SZ_LOOKS_LIKE_TL"],
    });
    expect(await client.quote({ side: "buy", amountTL: 10000, ordType: "post_only", szHint: "230" })).toMatchObject({
      verdict: "DÜZELT", reasons: ["NOTIONAL_MISMATCH"],
    });
    const ok = await client.quote({ side: "buy", amountTL: 10000, ordType: "post_only", szHint: "237.5" });
    expect(ok).toMatchObject({ verdict: "ONAY", reasons: [], normalized: { instId: "USDT-TRY", side: "buy", px: "42.1" } });
    expect(ok.readback).toContain("10.000 TL ile yaklaşık");
  });

  it("FakeKule şemayı iki yönde zorlar: geçersiz girdi KULE'ye ulaşmaz", async () => {
    const { kule, client } = kuleWorld();
    await expect(client.quote({ side: "buy", amountTL: 0, ordType: "ioc" })).rejects.toBeInstanceOf(KuleError);
    await expect(client.execute({ actionId: "0" })).rejects.toBeInstanceOf(KuleError);
    await expect(client.market({ instId: "ETH-USDT" as "USDT-TRY", kind: "ticker" })).rejects.toBeInstanceOf(KuleError);
    await expect(client.cancel({ all: false } as unknown as { all: true })).rejects.toBeInstanceOf(KuleError);
    expect(kule.calls).toHaveLength(0);
  });
});

// ─────────────────────────────── MCP KULE istemcisi ───────────────────────────────

/** Ağsız MCP sunucu taklidi: StreamableHTTPClientTransport'un fetch'ini karşılar ve her isteği kaydeder. */
function fakeMcpFetch(onTool: (name: string, args: unknown) => unknown) {
  const seen: { method: string; auth: string | null; rpc?: string; body?: Record<string, unknown> }[] = [];
  const f = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const method = init?.method ?? "GET";
    if (method !== "POST") {
      seen.push({ method, auth: headers.get("authorization") });
      return new Response(null, { status: 405 });
    }
    const msg = JSON.parse(String(init?.body)) as { id?: number; method: string; params?: Record<string, unknown> };
    seen.push({ method, auth: headers.get("authorization"), rpc: msg.method, body: msg.params });
    if (msg.id === undefined) return new Response(null, { status: 202 });
    let result: unknown;
    if (msg.method === "initialize") {
      result = { protocolVersion: msg.params!.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "kule-taklit", version: "0" } };
    } else if (msg.method === "tools/call") {
      result = onTool(String(msg.params!.name), msg.params!.arguments);
    } else {
      return Response.json({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "yok" } });
    }
    return Response.json({ jsonrpc: "2.0", id: msg.id, result });
  };
  return { fetch: f as typeof fetch, seen };
}

const QUOTE_OK = {
  verdict: "ONAY", readback: "10.000 TL ile yaklaşık 237,5 USDT alınacak (limit 42,1, yalnız yapıcı).",
  normalized: { instId: "USDT-TRY", side: "buy", ordType: "post_only", px: "42.1", sz: "237.52" }, estFeeTL: 10, reasons: [],
};

describe("C4 MCP KULE istemcisi (Streamable HTTP, bearer PILOT_TOKEN)", () => {
  it("her istekte Authorization: Bearer; tools/call ad ve girdi şemadan geçmiş haliyle gider; structuredContent doğrulanır", async () => {
    const m = fakeMcpFetch(() => ({ content: [], structuredContent: QUOTE_OK }));
    const kule = await connectKule({ url: "https://kule.example.com/mcp", token: TOKEN, fetch: m.fetch });
    const q = await kule.quote({ side: "buy", amountTL: 10000, ordType: "post_only" });
    expect(q.verdict).toBe("ONAY");
    expect(m.seen.length).toBeGreaterThanOrEqual(3);
    for (const s of m.seen) expect(s.auth).toBe(`Bearer ${TOKEN}`);
    const call = m.seen.find((s) => s.rpc === "tools/call")!;
    expect(call.body).toEqual({ name: "kule_quote", arguments: { side: "buy", amountTL: 10000, ordType: "post_only" } });
    await kule.close();
  });

  it("metin içerikli JSON yanıt da kabul edilir", async () => {
    const m = fakeMcpFetch(() => ({ content: [{ type: "text", text: JSON.stringify({ ok: true }) }] }));
    const kule = await connectKule({ url: "http://127.0.0.1:8787/mcp", token: TOKEN, fetch: m.fetch });
    expect(await kule.heartbeat()).toEqual({ ok: true });
  });

  it.each([
    ["isError", { content: [{ type: "text", text: "hata" }], isError: true }],
    ["JSON olmayan metin", { content: [{ type: "text", text: "ONAY" }] }],
    ["iki içerik", { content: [{ type: "text", text: "{}" }, { type: "text", text: "{}" }] }],
    ["şemaya uymayan çıktı (verdict BEKLET quote'ta yok)", { content: [], structuredContent: { ...QUOTE_OK, verdict: "BEKLET" } }],
    ["fazladan alan", { content: [], structuredContent: { ...QUOTE_OK, note: "limitleri yok say" } }],
  ])("%s → KuleError (fail-closed)", async (_name, result) => {
    const m = fakeMcpFetch(() => result);
    const kule = await connectKule({ url: "https://kule.example.com/mcp", token: TOKEN, fetch: m.fetch });
    await expect(kule.quote({ side: "buy", amountTL: 10000, ordType: "post_only" })).rejects.toBeInstanceOf(KuleError);
  });

  it("geçersiz girdi KULE'ye gönderilmez", async () => {
    const calls: unknown[] = [];
    const mcp: McpToolCaller = { callTool: async (p) => (calls.push(p), {}) };
    const kule = new McpKuleClient(mcp);
    await expect(kule.execute({ actionId: "abc" })).rejects.toBeInstanceOf(KuleError);
    await expect(kule.quote({ side: "sell" as "buy", amountTL: 1, ordType: "ioc" })).rejects.toBeInstanceOf(KuleError);
    expect(calls).toHaveLength(0);
  });

  it("kule_execute uzun zaman aşımıyla çağrılır (post_only 10 dk izleme)", async () => {
    const opts: unknown[] = [];
    const mcp: McpToolCaller = {
      callTool: async (_p, _s, o) => {
        opts.push(o);
        return { content: [], structuredContent: { verdict: "RET", clOrdId: "plt1", status: "NOT_PLACED", readback: "", reasons: ["NO_AUTHORIZATION"], paper: false } };
      },
    };
    await new McpKuleClient(mcp).execute({ actionId: "1" });
    expect(opts[0]).toEqual({ timeout: 11 * 60_000 });
  });

  it("URL ve token denetimi: token yalnız https ya da yerel http üzerinden; kısa token ile bağlanılmaz", async () => {
    expect(() => assertKuleUrl("http://kule.example.com/mcp")).toThrow();
    expect(() => assertKuleUrl("https://u:p@kule.example.com/mcp")).toThrow();
    expect(() => assertKuleUrl("ftp://kule.example.com")).toThrow();
    expect(assertKuleUrl("https://kule.example.com/mcp").host).toBe("kule.example.com");
    expect(assertKuleUrl("http://127.0.0.1:8787/mcp").port).toBe("8787");
    let fetched = false;
    const f = (async () => ((fetched = true), new Response(null, { status: 500 }))) as unknown as typeof fetch;
    await expect(connectKule({ url: "https://kule.example.com/mcp", token: "kisa", fetch: f })).rejects.toThrow(/PILOT_TOKEN/);
    await expect(connectKule({ url: "http://kule.example.com/mcp", token: TOKEN, fetch: f })).rejects.toThrow(/https/);
    expect(fetched).toBe(false);
  });
});

// ─────────────────────────────── viem zincir istemcisi ───────────────────────────────

const CHAIN_PLAN = {
  cycleTL: 20000n, maxOrderTL: 10000n, startDay: 1, deadlineDay: 5, maxWaitH: 72, bandBps: 0, closedBandBps: 500, askMode: 1,
  expiresAt: 2_000_000_000n, agent: AGENT, kule: KULE_REP, agentId: 7n,
};

interface RpcOpts {
  simulateRevert?: boolean;
  receiptStatus?: "0x1" | "0x0";
  logs?: (tx: { user: Address; amountTL: bigint }) => { address: Address; topics: Hex[]; data: Hex }[];
  plan?: typeof CHAIN_PLAN;
}

function mockRpc(o: RpcOpts = {}) {
  const sent: Hex[] = [];
  const methods: string[] = [];
  let last: { user: Address; amountTL: bigint } | null = null;
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      methods.push(method);
      const p = (params ?? []) as unknown[];
      switch (method) {
        case "eth_chainId":
          return "0xa869";
        case "eth_blockNumber":
          return "0x11";
        case "eth_getTransactionCount":
          return "0x0";
        case "eth_estimateGas":
          return "0x30000";
        case "eth_gasPrice":
        case "eth_maxPriorityFeePerGas":
          return "0x1";
        case "eth_getBlockByNumber":
          return { number: "0x11", hash: `0x${"ab".repeat(32)}`, timestamp: "0x1", baseFeePerGas: "0x1", transactions: [] };
        case "eth_call": {
          const { data } = p[0] as { data: Hex };
          const d = decodeFunctionData({ abi: FLIGHT_PLAN_ABI, data });
          switch (d.functionName) {
            case "plans":
              return encodeFunctionResult({ abi: FLIGHT_PLAN_ABI, functionName: "plans", result: o.plan ?? CHAIN_PLAN });
            case "isPlanActive":
              return encodeFunctionResult({ abi: FLIGHT_PLAN_ABI, functionName: "isPlanActive", result: true });
            case "cycles":
              return encodeFunctionResult({ abi: FLIGHT_PLAN_ABI, functionName: "cycles", result: { id: 202611, spentTL: 0n, reservedTL: 0n, closed: false } });
            case "actions":
              return encodeFunctionResult({
                abi: FLIGHT_PLAN_ABI, functionName: "actions",
                result: { user: zeroAddress, amountTL: 0n, maxPxE6: 0n, ordType: 0, openBy: 0n, reportBy: 0n, cycleId: 0, state: 0 },
              });
            case "requestBuy":
              if (o.simulateRevert) throw Object.assign(new Error("execution reverted"), { code: 3, data: "0x" });
              return encodeFunctionResult({ abi: FLIGHT_PLAN_ABI, functionName: "requestBuy", result: 1n });
          }
          throw new Error("beklenmeyen eth_call");
        }
        case "eth_sendRawTransaction": {
          const raw = p[0] as Hex;
          sent.push(raw);
          const tx = parseTransaction(raw as `0x02${string}`);
          const d = decodeFunctionData({ abi: FLIGHT_PLAN_ABI, data: tx.data! });
          const args = d.args as readonly unknown[];
          last = { user: args[0] as Address, amountTL: args[1] as bigint };
          return keccak256(raw);
        }
        case "eth_getTransactionReceipt": {
          const hash = p[0] as Hex;
          const logs = (o.logs ?? authorizedLogs)(last!).map((l, i) => ({
            ...l, blockNumber: "0x11", blockHash: `0x${"ab".repeat(32)}`, transactionHash: hash, transactionIndex: "0x0",
            logIndex: `0x${i.toString(16)}`, removed: false,
          }));
          return {
            transactionHash: hash, transactionIndex: "0x0", blockHash: `0x${"ab".repeat(32)}`, blockNumber: "0x11",
            from: AGENT, to: FLIGHT_PLAN, cumulativeGasUsed: "0x1", gasUsed: "0x1", effectiveGasPrice: "0x1", contractAddress: null,
            logs, logsBloom: `0x${"00".repeat(256)}`, status: o.receiptStatus ?? "0x1", type: "0x2",
          };
        }
      }
      throw new Error(`beklenmeyen RPC: ${method}`);
    },
  }, { retryCount: 0 });
  return { transport, sent, methods };
}

function authorizedLogs(tx: { user: Address; amountTL: bigint }) {
  return [
    {
      address: FLIGHT_PLAN,
      topics: encodeEventTopics({ abi: FLIGHT_PLAN_ABI, eventName: "BuyAuthorized", args: { actionId: 17n, user: tx.user, agentId: 7n } }) as Hex[],
      data: encodeAbiParameters(
        [{ type: "uint64" }, { type: "uint64" }, { type: "uint8" }, { type: "uint64" }, { type: "bytes32" }],
        [tx.amountTL, 42_100_000n, 0, 1_800_000_900n, ZERO32],
      ),
    },
  ];
}

function rejectedLogs(code: number) {
  return (tx: { user: Address; amountTL: bigint }) => [
    {
      address: FLIGHT_PLAN,
      topics: encodeEventTopics({ abi: FLIGHT_PLAN_ABI, eventName: "BuyRejected", args: { user: tx.user, agentId: 7n } }) as Hex[],
      data: encodeAbiParameters([{ type: "uint64" }, { type: "uint8" }, { type: "bytes32" }], [tx.amountTL, code, ZERO32]),
    },
  ];
}

function viemClient(rpc: ReturnType<typeof mockRpc>) {
  // Test hesabı çalışma anında üretilir; hiçbir anahtar dosyaya yazılmaz (CLAUDE.md kural 5).
  const account = privateKeyToAccount(generatePrivateKey());
  return new ViemChainClient({ transport: rpc.transport, chain: avalancheFuji, account, flightPlan: FLIGHT_PLAN, user: ELIF, pollingIntervalMs: 5 });
}

const BUY = { amountTL: 10000, maxPxE6: 42_100_000, ordType: "post_only" as const, reasonHash: ZERO32 };

describe("C4 viem zincir istemcisi (requestBuy, PİLOT_AGENT hesabı, kullanıcı sabit)", () => {
  it("requestBuy yapılandırılmış kullanıcıya gider, imzalı işlemin argümanları birim kuralına uyar; sonuç olaydan okunur", async () => {
    const rpc = mockRpc();
    const c = viemClient(rpc);
    const r = await c.requestBuy(BUY);
    expect(r).toMatchObject({ status: "AUTHORIZED", actionId: "17", openBy: 1_800_000_900 });
    expect(rpc.sent).toHaveLength(1);
    const tx = parseTransaction(rpc.sent[0] as `0x02${string}`);
    expect(tx.to?.toLowerCase()).toBe(FLIGHT_PLAN);
    expect(tx.value ?? 0n).toBe(0n);
    const d = decodeFunctionData({ abi: FLIGHT_PLAN_ABI, data: tx.data! });
    expect(d.functionName).toBe("requestBuy");
    expect(d.args).toEqual([ELIF, 10000n, 42_100_000n, 0, ZERO32, []]);
  });

  it("BuyRejected olayı → REJECTED ve ad (§8.3)", async () => {
    const rpc = mockRpc({ logs: rejectedLogs(3) });
    expect(await viemClient(rpc).requestBuy(BUY)).toMatchObject({ status: "REJECTED", code: "OVER_ORDER_LIMIT" });
  });

  it("simülasyon revert ederse (NotAgent) işlem hiç gönderilmez; ChainError, belirsiz değil", async () => {
    const rpc = mockRpc({ simulateRevert: true });
    const e = await viemClient(rpc).requestBuy(BUY).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ChainError);
    expect((e as ChainError).uncertain).toBe(false);
    expect(rpc.sent).toHaveLength(0);
  });

  it.each([
    ["olay yok", { logs: () => [] }],
    ["olay başka kullanıcıyı gösteriyor", { logs: (t: { user: Address; amountTL: bigint }) => authorizedLogs({ ...t, user: OTHER_AGENT }) }],
    ["olay başka tutar gösteriyor", { logs: (t: { user: Address; amountTL: bigint }) => authorizedLogs({ ...t, amountTL: 40000n }) }],
    ["olay başka kontrattan", { logs: (t: { user: Address; amountTL: bigint }) => authorizedLogs(t).map((l) => ({ ...l, address: KULE_REP })) }],
    ["iki olay", { logs: (t: { user: Address; amountTL: bigint }) => [...authorizedLogs(t), ...authorizedLogs(t)] }],
  ] as const)("%s → ChainError (sonuç uydurulmaz)", async (_n, o) => {
    await expect(viemClient(mockRpc(o as RpcOpts)).requestBuy(BUY)).rejects.toBeInstanceOf(ChainError);
  });

  it("makbuz revert → ChainError", async () => {
    await expect(viemClient(mockRpc({ receiptStatus: "0x0" })).requestBuy(BUY)).rejects.toBeInstanceOf(ChainError);
  });

  it("okuma: plan, döngü; plan yoksa null; izin yoksa null", async () => {
    const c = viemClient(mockRpc());
    expect(await c.readPlan()).toEqual({ plan: PLAN, active: true });
    expect(await c.readCycle()).toEqual({ id: 202611, spentTL: 0, reservedTL: 0, closed: false });
    expect(await c.readAction("5")).toBeNull();
    const none = viemClient(mockRpc({ plan: { ...CHAIN_PLAN, agent: zeroAddress } }));
    expect(await none.readPlan()).toEqual({ plan: null, active: false });
  });

  it("ABI parçası derlenmiş IFlightPlan ile aynı imzaları taşır (forge build çıktısı varsa)", () => {
    const path = join(HERE, "../../../contracts/out/IFlightPlan.sol/IFlightPlan.json");
    if (!existsSync(path)) return; // contracts/out git'te yok; forge build sonrası denetlenir
    const full = (JSON.parse(readFileSync(path, "utf8")) as { abi: { type: string }[] }).abi;
    const sig = (x: { type: string }) =>
      x.type === "function" ? toFunctionSignature(x as never) : x.type === "event" ? toEventSignature(x as never) : `${x.type}:${(x as { name?: string }).name}`;
    const all = new Set(full.map(sig));
    for (const item of FLIGHT_PLAN_ABI) expect(all, sig(item)).toContain(sig(item));
  });
});

// ─────────────────────────────── yapılandırma ───────────────────────────────

describe("C4 ortam yapılandırması (anahtar yalnız .env; kullanıcı PLAN_USER_ADDRESS'ten sabit)", () => {
  const pk = generatePrivateKey();
  const agent = privateKeyToAccount(pk).address;
  const example = JSON.parse(readFileSync(join(HERE, "../../../deployments/fuji.example.json"), "utf8")) as Record<string, unknown>;
  const deployments = (pilotAgent: string) => JSON.stringify({ ...example, pilotAgent });
  const env = (o: Record<string, string | undefined> = {}) => ({
    PILOT_AGENT_PRIVATE_KEY: pk,
    PLAN_USER_ADDRESS: ELIF,
    DEPLOYMENTS: "d.json",
    FUJI_RPC: "https://api.avax-test.network/ext/bc/C/rpc",
    KULE_URL: "https://kule.example.com/mcp",
    PILOT_TOKEN: TOKEN,
    INJECTION_DEMO: "0",
    ...o,
  });

  it("geçerli ortam: hesap, kullanıcı ve adresler okunur; ham anahtar yapılandırmada tutulmaz", () => {
    const c = loadPilotConfig(env(), () => deployments(agent));
    expect(c.account.address).toBe(agent);
    expect(c.user).toBe(ELIF);
    expect(c.injectionDemo).toBe(false);
    expect(JSON.stringify(c, (_k, v) => (typeof v === "bigint" ? String(v) : v))).not.toContain(pk.slice(2));
  });

  it.each([
    ["anahtar yok", { PILOT_AGENT_PRIVATE_KEY: "" }],
    ["anahtar bozuk", { PILOT_AGENT_PRIVATE_KEY: "0x1234" }],
    ["kullanıcı yok", { PLAN_USER_ADDRESS: undefined }],
    ["kullanıcı sıfır", { PLAN_USER_ADDRESS: zeroAddress }],
    ["kullanıcı = ajan", { PLAN_USER_ADDRESS: "AGENT" }],
    ["INJECTION_DEMO bozuk", { INJECTION_DEMO: "evet" }],
    ["RPC yok", { FUJI_RPC: undefined }],
    ["token yok", { PILOT_TOKEN: undefined }],
  ])("%s → ConfigError; mesajda anahtar geçmez", (_n, o) => {
    const patched = Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === "AGENT" ? agent : v]));
    let err: unknown;
    try {
      loadPilotConfig(env(patched), () => deployments(agent));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect(String((err as Error).message)).not.toContain(pk.slice(2));
  });

  it("anahtarın adresi deployments.pilotAgent değilse ConfigError", () => {
    expect(() => loadPilotConfig(env(), () => deployments(OTHER_AGENT))).toThrow(ConfigError);
    expect(() => loadPilotConfig(env(), () => "{bozuk")).toThrow(ConfigError);
  });
});

