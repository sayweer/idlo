/**
 * Test yardımcıları: ağsız OKX taklidi (imzayı doğrular), ağsız JSON-RPC taklidi (FlightPlan olayları), MCP taklidi.
 * Hiçbir yardımcı gerçek ağa çıkmaz; bilinmeyen adrese giden istek testi düşürür.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeAbiParameters, encodeEventTopics, numberToHex, pad, type Address, type Hex } from "viem";
import { FLIGHT_PLAN_SCRIPT_ABI } from "../lib/mutabakat-abi.js";
import type { OkxOrder } from "../lib/okx-readonly.js";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = join(HERE, "../..");

export const ELIF: Address = "0x00000000000000000000000000000000000e1f00";
export const FLIGHT_PLAN: Address = "0x2222222222222222222222222222222222222222";
export const PILOT_AGENT: Address = "0x4444444444444444444444444444444444444444";
export const KULE_REPORTER: Address = "0x3333333333333333333333333333333333333333";

/** deployments/fuji.example.json + istenen alanlar. */
export function deploymentsText(o: Record<string, unknown> = {}): string {
  const ex = JSON.parse(readFileSync(join(REPO, "deployments/fuji.example.json"), "utf8")) as Record<string, unknown>;
  return JSON.stringify({ ...ex, flightPlan: FLIGHT_PLAN, pilotAgent: PILOT_AGENT, kuleReporter: KULE_REPORTER, deployBlock: 100, ...o });
}

export function order(o: Partial<OkxOrder> & { ordId: string; cTime: string }): OkxOrder {
  return {
    instId: "USDT-TRY",
    clOrdId: "",
    tag: "",
    px: "41",
    sz: "3.6",
    ordType: "ioc",
    side: "buy",
    state: "filled",
    accFillSz: "3.6",
    avgPx: "41",
    ...o,
  };
}

// ─────────────────────────────── kayıt ───────────────────────────────

export interface SeenRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export function headersOf(init?: RequestInit): Record<string, string> {
  const h: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => (h[k] = v));
  return h;
}

// ─────────────────────────────── OKX taklidi ───────────────────────────────

export interface FakeOkxOpts {
  apiKey: string;
  secret: string;
  passphrase: string;
  perm?: string;
  pending?: OkxOrder[];
  history?: OkxOrder[];
  archive?: OkxOrder[];
  /** OKX kodu "0" dışı (ör. "50113" geçersiz imza). */
  failCode?: string;
}

/** OKX v5 taklidi: imza, başlıklar ve yöntem denetlenir; sayfalama after=ordId ile. */
export function okxHandler(o: FakeOkxOpts) {
  const calls: { path: string; query: Record<string, string> }[] = [];
  const handle = (url: URL, init?: RequestInit): Response => {
    const h = headersOf(init);
    if ((init?.method ?? "GET") !== "GET") return Response.json({ code: "405", msg: "yalnız GET", data: [] });
    const requestPath = url.pathname + url.search;
    const expected = createHmac("sha256", o.secret).update(h["ok-access-timestamp"] + "GET" + requestPath).digest("base64");
    if (h["ok-access-key"] !== o.apiKey || h["ok-access-passphrase"] !== o.passphrase || h["ok-access-sign"] !== expected) {
      return Response.json({ code: "50113", msg: "Invalid Sign", data: [] }, { status: 401 });
    }
    if (o.failCode) return Response.json({ code: o.failCode, msg: "hata", data: [] });
    const query = Object.fromEntries(url.searchParams);
    calls.push({ path: url.pathname, query });
    const page = (rows: OkxOrder[]) => {
      const limit = Number(query.limit ?? 100);
      let start = 0;
      if (query.after) start = rows.findIndex((r) => r.ordId === query.after) + 1;
      return rows.slice(start, start + limit);
    };
    switch (url.pathname) {
      case "/api/v5/account/config":
        return Response.json({ code: "0", msg: "", data: [{ uid: "1", perm: o.perm ?? "read_only", acctLv: "1" }] });
      case "/api/v5/trade/orders-pending":
        return Response.json({ code: "0", msg: "", data: page(o.pending ?? []) });
      case "/api/v5/trade/orders-history":
        return Response.json({ code: "0", msg: "", data: page(o.history ?? []) });
      case "/api/v5/trade/orders-history-archive":
        return Response.json({ code: "0", msg: "", data: page(o.archive ?? []) });
      default:
        return Response.json({ code: "404", msg: "yok", data: [] }, { status: 404 });
    }
  };
  return { handle, calls };
}

// ─────────────────────────────── JSON-RPC taklidi ───────────────────────────────

export interface FakeLog {
  block: number;
  event: "BuyAuthorized" | "BuyExecuted" | "BuyRejected";
  args: Record<string, unknown>;
  address?: Address;
}

const AUTH_INPUTS = [
  { type: "uint64" }, { type: "uint64" }, { type: "uint8" }, { type: "uint64" }, { type: "bytes32" },
] as const;
const EXEC_INPUTS = [{ type: "string" }, { type: "uint64" }, { type: "uint64" }, { type: "uint8" }, { type: "bytes32" }] as const;

function encodeLog(l: FakeLog, i: number) {
  const a = l.args;
  let topics: Hex[];
  let data: Hex;
  if (l.event === "BuyAuthorized") {
    topics = encodeEventTopics({ abi: FLIGHT_PLAN_SCRIPT_ABI, eventName: "BuyAuthorized", args: { actionId: a.actionId as bigint, user: a.user as Address, agentId: a.agentId as bigint } }) as Hex[];
    data = encodeAbiParameters(AUTH_INPUTS, [a.amountTL as bigint, a.maxPxE6 as bigint, a.ordType as number, a.openBy as bigint, pad("0x01")]);
  } else if (l.event === "BuyExecuted") {
    topics = encodeEventTopics({ abi: FLIGHT_PLAN_SCRIPT_ABI, eventName: "BuyExecuted", args: { actionId: a.actionId as bigint, user: a.user as Address } }) as Hex[];
    data = encodeAbiParameters(EXEC_INPUTS, [a.ordId as string, a.filledTL as bigint, a.avgPxE6 as bigint, a.status as number, pad("0x02")]);
  } else {
    throw new Error("taklit desteklemiyor");
  }
  return {
    address: l.address ?? FLIGHT_PLAN,
    topics,
    data,
    blockNumber: numberToHex(l.block),
    blockHash: pad(numberToHex(l.block)),
    transactionHash: pad(numberToHex(1000 + i)),
    transactionIndex: "0x0",
    logIndex: numberToHex(i),
    removed: false,
  };
}

export function rpcHandler(o: { chainId?: number; head: number; nowSec: number; logs: FakeLog[] }) {
  const getLogsRanges: [number, number][] = [];
  const encoded = o.logs.map(encodeLog);
  const handle = async (init?: RequestInit): Promise<Response> => {
    const msg = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
    const ok = (result: unknown) => Response.json({ jsonrpc: "2.0", id: msg.id, result });
    switch (msg.method) {
      case "eth_chainId":
        return ok(numberToHex(o.chainId ?? 43113));
      case "eth_blockNumber":
        return ok(numberToHex(o.head));
      case "eth_getBlockByNumber":
        return ok({
          number: numberToHex(o.head),
          hash: pad(numberToHex(o.head)),
          parentHash: pad("0x0"),
          timestamp: numberToHex(o.nowSec),
          transactions: [],
          logsBloom: pad("0x0", { size: 256 }),
          gasLimit: "0x0",
          gasUsed: "0x0",
          miner: "0x0000000000000000000000000000000000000000",
          extraData: "0x",
          size: "0x0",
          uncles: [],
          difficulty: "0x0",
          nonce: "0x0000000000000000",
          sha3Uncles: pad("0x0"),
          stateRoot: pad("0x0"),
          receiptsRoot: pad("0x0"),
          transactionsRoot: pad("0x0"),
        });
      case "eth_getLogs": {
        const f = msg.params[0] as { address: string; fromBlock: Hex; toBlock: Hex; topics: (Hex | null)[] };
        const from = Number(f.fromBlock);
        const to = Number(f.toBlock);
        getLogsRanges.push([from, to]);
        const res = encoded.filter((l) => {
          const b = Number(l.blockNumber);
          if (b < from || b > to) return false;
          if (l.address.toLowerCase() !== f.address.toLowerCase()) return false;
          return f.topics.every((t, i) => t === null || t === undefined || l.topics[i]?.toLowerCase() === t.toLowerCase());
        });
        return ok(res);
      }
      default:
        return Response.json({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `yok: ${msg.method}` } });
    }
  };
  return { handle, getLogsRanges };
}

/** Tek fetch: OKX taklidi + RPC taklidi; her istek kaydedilir, bilinmeyen adres hata verir. */
export function routerFetch(routes: { okx?: ReturnType<typeof okxHandler>; rpcUrl?: string; rpc?: ReturnType<typeof rpcHandler> }) {
  const seen: SeenRequest[] = [];
  const f = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    seen.push({ url: url.href, method: init?.method ?? "GET", headers: headersOf(init), body: init?.body ? String(init.body) : "" });
    if (url.origin === "https://tr.okx.com" && routes.okx) return routes.okx.handle(url, init);
    if (routes.rpcUrl && url.href.startsWith(routes.rpcUrl) && routes.rpc) return routes.rpc.handle(init);
    throw new Error(`test dışı adres: ${url.href}`);
  };
  return { fetch: f as typeof fetch, seen };
}

// ─────────────────────────────── MCP taklidi ───────────────────────────────

/** Ağsız MCP sunucu taklidi (StreamableHTTPClientTransport'un fetch'i). */
export function fakeMcpFetch(onTool: (name: string, args: unknown) => unknown) {
  const seen: { method: string; auth: string | null; rpc?: string; params?: Record<string, unknown> }[] = [];
  const f = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const method = init?.method ?? "GET";
    if (method !== "POST") {
      seen.push({ method, auth: headers.get("authorization") });
      return new Response(null, { status: 405 });
    }
    const msg = JSON.parse(String(init?.body)) as { id?: number; method: string; params?: Record<string, unknown> };
    seen.push({ method, auth: headers.get("authorization"), rpc: msg.method, ...(msg.params ? { params: msg.params } : {}) });
    if (msg.id === undefined) return new Response(null, { status: 202 });
    if (msg.method === "initialize") {
      return Response.json({
        jsonrpc: "2.0",
        id: msg.id,
        result: { protocolVersion: msg.params!.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "kule-taklit", version: "0" } },
      });
    }
    if (msg.method === "tools/call") {
      return Response.json({ jsonrpc: "2.0", id: msg.id, result: onTool(String(msg.params!.name), msg.params!.arguments) });
    }
    return Response.json({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "yok" } });
  };
  return { fetch: f as typeof fetch, seen };
}
