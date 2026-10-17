/**
 * Uçtan uca MCP: gerçek HTTP sunucusu + PİLOT'un GERÇEK istemcisi (apps/pilot/src/clients/kuleMcp.ts, yalnız okunur/içe aktarılır).
 * Borsa ve zincir sahte; ağ yok.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { KULE_TOOL_NAMES } from "@pilot/shared";
import { connectKule } from "../../pilot/src/clients/kuleMcp.js";
import { createApp, type KuleApp } from "../src/app.js";
import type { KuleConfig } from "../src/config.js";
import { MemoryLogger } from "../src/logger.js";
import { AGENT, AGENT2, DEMO, FakeChain, FakeExchange, OTHER, PILOT, REPORTER, TestClock, USER, fakeInstrumentsFetch } from "./helpers.js";

let app: KuleApp;
let url: string;
let dir: string;
let chain: FakeChain;
let exchange: FakeExchange;
let clock: TestClock;
const logger = new MemoryLogger();

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kule-srv-"));
  clock = new TestClock();
  chain = new FakeChain(clock);
  exchange = new FakeExchange(clock);
  const cfg: KuleConfig = {
    port: 0,
    tokens: [PILOT, DEMO, OTHER],
    planUser: USER,
    okxProfile: "kule-demo",
    exec: "paper", // CAA ve gerçek borsa yok
    okx: null,
    demo: true,
    mode: "paper",
    reporterKey: ("0x" + "11".repeat(32)) as `0x${string}`,
    reporter: REPORTER,
    rpcUrl: "http://127.0.0.1:1",
    deployments: {} as never,
    actionsPath: join(dir, "data", "kule-actions.json"),
    logDir: join(dir, "logs"),
  };
  app = await createApp(cfg, { exchange, chain, clock, logger, fetchImpl: fakeInstrumentsFetch, port: 0, sleep: async (ms) => void clock.advance(ms) });
  const port = await app.start();
  url = `http://127.0.0.1:${port}/mcp`;
});

afterAll(async () => {
  await app.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function rawClient(token: string): Promise<Client> {
  const c = new Client({ name: "raw", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return c;
}

describe("MCP sunucusu (§9)", () => {
  it("yalnız 127.0.0.1'e bağlanır", () => {
    const a = app.http.address();
    expect(typeof a === "object" && a?.address).toBe("127.0.0.1");
  });

  it("araç listesi tam olarak §9.1'deki yedi araç (bunun dışında hiçbir şey yok)", async () => {
    const c = await rawClient(PILOT.token);
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...KULE_TOOL_NAMES].sort());
    expect(tools).toHaveLength(7);
    for (const t of tools) expect(t.inputSchema.type).toBe("object");
    expect(tools.find((t) => t.name === "kule_execute")!.inputSchema).toMatchObject({ properties: { actionId: { type: "string" } } });
    await c.close();
  });

  it("bearer token yok/yanlış → HTTP 401; yanlış yol 404; GET 405", async () => {
    const post = (headers: Record<string, string>, path = "/mcp") =>
      fetch(url.replace("/mcp", path), { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect((await post({})).status).toBe(401);
    expect((await post({ Authorization: "Bearer yanlis-token-0123456789" })).status).toBe(401);
    expect((await post({ Authorization: "Basic abc" })).status).toBe(401);
    expect((await post({ Authorization: `Bearer ${PILOT.token}` }, "/baska")).status).toBe(404);
    expect((await fetch(url, { headers: { Authorization: `Bearer ${PILOT.token}` } })).status).toBe(405);
    expect((await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${PILOT.token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: "{bozuk" })).status).toBe(400);
    await expect(connectKule({ url, token: "yanlis-token-0123456789" })).rejects.toThrow();
  });

  it("PİLOT'un gerçek istemcisi: status, heartbeat, market, balance, quote, execute, cancel (şema doğrulamalı)", async () => {
    const kule = await connectKule({ url, token: PILOT.token });
    try {
      expect(await kule.heartbeat()).toEqual({ ok: true });
      const st = await kule.status();
      expect(st).toMatchObject({ health: "NORMAL", mode: "paper", chain: { ok: true } });
      expect(st.caa.active).toBe(false); // kâğıt modunda CAA yok

      const tk = (await kule.market({ instId: "USDT-TRY", kind: "ticker" })) as { instId: string; data: { bidPx: string } };
      expect(tk).toMatchObject({ instId: "USDT-TRY", data: { bidPx: "49.447" } });
      expect(await kule.market({ instId: "BTC-USDT", kind: "orderbook" })).toMatchObject({ kind: "orderbook" });
      expect(await kule.market({ instId: "BTC-USDT", kind: "candles", bar: "5m", limit: 1 })).toMatchObject({ kind: "candles", bar: "5m" });

      expect(await kule.balance()).toEqual({ TRY: { trading: "100000", funding: "0" }, USDT: { trading: "0", funding: "0" } });

      const q = await kule.quote({ side: "buy", amountTL: 10000, ordType: "post_only", szHint: "10000" });
      expect(q).toMatchObject({ verdict: "DÜZELT", reasons: ["SZ_LOOKS_LIKE_TL"] });

      chain.seed("501");
      const r = await kule.execute({ actionId: "501" });
      expect(r).toMatchObject({ verdict: "ONAY", status: "FILLED", paper: true, clOrdId: "plt501" });
      expect(r.reportTx).toBeDefined();
      expect(await kule.execute({ actionId: "501" })).toMatchObject({ verdict: "RET", reasons: ["ALREADY_EXECUTED"] });
      expect(await kule.execute({ actionId: "9999" })).toMatchObject({ verdict: "RET", reasons: ["NO_AUTHORIZATION"] });
      expect(await kule.cancel({ all: true })).toEqual({ ok: true, canceled: [], reasons: [] });
      expect(await kule.cancel({ actionId: "9999" })).toMatchObject({ ok: false, reasons: ["NO_AUTHORIZATION"] });
      expect(exchange.placed).toHaveLength(0); // kâğıt
    } finally {
      await kule.close();
    }
  });

  it("U-10 MCP üzerinden eşzamanlı iki kule_execute: biri ONAY, diğeri ALREADY_EXECUTED", async () => {
    const a = await connectKule({ url, token: PILOT.token });
    const b = await connectKule({ url, token: PILOT.token });
    try {
      await a.heartbeat();
      chain.seed("502");
      const [x, y] = await Promise.all([a.execute({ actionId: "502" }), b.execute({ actionId: "502" })]);
      expect([x.verdict, y.verdict].sort()).toEqual(["ONAY", "RET"]);
      const ret = x.verdict === "RET" ? x : y;
      expect(ret.reasons).toEqual(["ALREADY_EXECUTED"]);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("U-12 başka ajanın token'ı WRONG_AGENT; ajansız demo token'ı da; ama okuma/teklif çalışır", async () => {
    chain.seed("503");
    const other = await connectKule({ url, token: OTHER.token });
    const demo = await connectKule({ url, token: DEMO.token });
    try {
      expect(await other.execute({ actionId: "503" })).toMatchObject({ verdict: "RET", reasons: ["WRONG_AGENT"] });
      expect(await demo.execute({ actionId: "503" })).toMatchObject({ verdict: "RET", reasons: ["WRONG_AGENT"] });
      expect((await demo.status()).mode).toBe("paper");
      expect((await demo.quote({ side: "buy", amountTL: 5000, ordType: "ioc" })).verdict).toBe("ONAY");
      expect(await demo.heartbeat()).toEqual({ ok: false }); // ajansız token kalp atışı sayılmaz
      expect(await other.heartbeat()).toEqual({ ok: true });
    } finally {
      await other.close();
      await demo.close();
    }
    const pilot = await connectKule({ url, token: PILOT.token });
    await pilot.heartbeat();
    expect((await pilot.execute({ actionId: "503" })).verdict).toBe("ONAY"); // gerçek sahip yine uygular
    await pilot.close();
  });

  it("U-1 yalnız iki enstrüman: şema dışı enstrüman, ham MCP çağrısında bile araç hatası", async () => {
    const c = await rawClient(PILOT.token);
    const r = await c.callTool({ name: "kule_market", arguments: { instId: "ETH-USDT", kind: "ticker" } });
    expect(r.isError).toBe(true);
    const r2 = await c.callTool({ name: "kule_market", arguments: { instId: "BTC-USDT-SWAP", kind: "ticker" } });
    expect(r2.isError).toBe(true);
    const unknownTool = await c.callTool({ name: "withdraw", arguments: { amount: "1" } });
    expect(unknownTool.isError).toBe(true);
    const badExec = await c.callTool({ name: "kule_execute", arguments: { actionId: "abc" } });
    expect(badExec.isError).toBe(true);
    const extra = await c.callTool({ name: "kule_execute", arguments: { actionId: "5", amountTL: 40000 } }); // çağıran parametre dayatamaz
    expect(extra.isError).toBe(true);
    const sell = await c.callTool({ name: "kule_quote", arguments: { side: "sell", amountTL: 10, ordType: "ioc" } });
    expect(sell.isError).toBe(true);
    await c.close();
  });

  it("yanıt hem structuredContent hem tek JSON metin bloğu taşır", async () => {
    const c = await rawClient(PILOT.token);
    const r = await c.callTool({ name: "kule_heartbeat", arguments: {} });
    expect(r.structuredContent).toEqual({ ok: true });
    expect(r.content).toEqual([{ type: "text", text: '{"ok":true}' }]);
    await c.close();
  });

  it("günlükte token yok", () => {
    const all = logger.lines.join("\n");
    for (const t of [PILOT.token, DEMO.token, OTHER.token]) expect(all).not.toContain(t);
    void AGENT;
    void AGENT2;
  });
});
