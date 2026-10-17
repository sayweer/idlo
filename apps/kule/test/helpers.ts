/** Test yardımcıları: sahte saat, sahte borsa, sahte zincir ve bunları bağlayan harness. Gerçek anahtar/ağ yok. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import type { BuyAction, Plan } from "@pilot/shared";
import { Executor, type Tuning } from "../src/executor.js";
import { ChainDataError, ChainUnreadableError, ChainWriteError, type KuleChain, type PermitFreshness, type ReportArgs } from "../src/chain.js";
import type { CaaState } from "../src/caa.js";
import type { TokenBinding } from "../src/config.js";
import { ExchangeError, type Balance, type Book, type Exchange, type OrderInfo, type PlaceOrderArgs, type Ticker, type TradeFee } from "../src/exchange.js";
import { HealthMonitor, HeartbeatBook } from "../src/health.js";
import { InstrumentCache } from "../src/instruments.js";
import { MemoryLogger } from "../src/logger.js";
import { KuleService } from "../src/service.js";
import { ActionStore } from "../src/store.js";

export const T0 = 1_790_000_000_000; // sabit "şimdi" (ms)

export const USER: Address = "0x1111111111111111111111111111111111111111";
export const AGENT: Address = "0x4444444444444444444444444444444444444444";
export const AGENT2: Address = "0x5555555555555555555555555555555555555555";
export const REPORTER: Address = "0x3333333333333333333333333333333333333333";
export const FOREIGN_USER: Address = "0x9999999999999999999999999999999999999999";
export const FOREIGN_KULE: Address = "0x8888888888888888888888888888888888888888";

export const PILOT: TokenBinding = { token: "pilot-token-0123456789", agent: AGENT, label: "pilot" };
export const OTHER: TokenBinding = { token: "other-token-0123456789", agent: AGENT2, label: "agent2" };
export const DEMO: TokenBinding = { token: "demo-token-0123456789a", agent: null, label: "demo" };

export class TestClock {
  constructor(public ms = T0) {}
  nowMs(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
  sec(): number {
    return Math.floor(this.ms / 1000);
  }
}

// ─────────────────────────────── sahte zincir ───────────────────────────────

export function makePlan(over: Partial<Plan> = {}): Plan {
  return {
    cycleTL: 20000,
    maxOrderTL: 10000,
    startDay: 1,
    deadlineDay: 28,
    maxWaitH: 72,
    bandBps: 0,
    closedBandBps: 500,
    askMode: 0,
    expiresAt: Math.floor(T0 / 1000) + 90 * 86400,
    agent: AGENT,
    kule: REPORTER,
    agentId: "1",
    ...over,
  };
}

export class FakeChain implements KuleChain {
  actions = new Map<string, BuyAction>();
  plans = new Map<string, Plan>();
  wallets = new Map<string, Address>();
  freshness = new Map<string, PermitFreshness>();
  planActive = true;
  unreadable = false;
  walletInvalid = false;
  reports: ReportArgs[] = [];
  reportFails: "none" | "revert" | "uncertain" = "none";
  block = 100;
  reads = 0;

  constructor(private readonly clock: TestClock) {}

  seed(actionId: string, a: Partial<BuyAction> = {}, plan: Partial<Plan> = {}, user: Address = USER): void {
    const nowSec = this.clock.sec();
    this.actions.set(actionId, {
      user,
      amountTL: 10000,
      maxPxE6: 49_500_000,
      ordType: "post_only",
      openBy: nowSec + 900,
      reportBy: nowSec + 900 + 3600,
      cycleId: 202610,
      state: "AUTHORIZED",
      ...a,
    });
    this.plans.set(user.toLowerCase(), makePlan(plan));
    const p = this.plans.get(user.toLowerCase())!;
    if (!this.wallets.has(p.agentId)) this.wallets.set(p.agentId, p.agent);
  }

  private guard(): void {
    if (this.unreadable) throw new ChainUnreadableError("rpc yok");
  }
  async blockNumber(): Promise<number> {
    this.guard();
    return this.block;
  }
  async readAction(id: string): Promise<BuyAction | null> {
    this.guard();
    this.reads++;
    return this.actions.get(id) ?? null;
  }
  async readPlan(user: Address): Promise<Plan | null> {
    this.guard();
    return this.plans.get(user.toLowerCase()) ?? null;
  }
  async isPlanActive(): Promise<boolean> {
    this.guard();
    return this.planActive;
  }
  async agentWallet(agentId: string): Promise<Address> {
    this.guard();
    if (this.walletInvalid) throw new ChainDataError("agentWallet baytları geçersiz");
    const w = this.wallets.get(agentId);
    if (!w) throw new ChainDataError("agentWallet yok");
    return w;
  }
  async permitFreshness(id: string): Promise<PermitFreshness> {
    this.guard();
    return this.freshness.get(id) ?? "current";
  }
  async reportExecution(a: ReportArgs): Promise<Hex> {
    this.guard();
    if (this.reportFails === "revert") throw new ChainWriteError("revert", false);
    if (this.reportFails === "uncertain") throw new ChainWriteError("belirsiz", true);
    this.reports.push(a);
    const act = this.actions.get(a.actionId);
    if (act) act.state = "REPORTED";
    return `0x${(this.reports.length).toString(16).padStart(64, "a")}` as Hex;
  }
}

// ─────────────────────────────── sahte borsa ───────────────────────────────

export type PlaceBehavior =
  | "fill" // emir hemen dolar (ioc ve post_only)
  | "rest" // emir tahtada bekler (post_only); iptalde restFill kadar dolmuş sayılır
  | "reject" // OKX kesin ret
  | "reject-duplicate" // OKX kopya clOrdId (51016) reddi; emir borsada get-order ile bulunamıyor
  | "timeout-landed" // yanıt kaybolur ama emir borsada
  | "timeout-lost"; // yanıt kaybolur ve emir yok

export class FakeExchange implements Exchange {
  bid = "49.447";
  ask = "49.462";
  /** Ticker ve tahta zaman damgasının yaşı (ms). */
  ageMs = 500;
  balance: Balance = { TRY: { trading: "100000", funding: "0" }, USDT: { trading: "0", funding: "0" } };
  behavior: PlaceBehavior = "fill";
  restFill = "0";
  placed: PlaceOrderArgs[] = [];
  orders = new Map<string, OrderInfo>();
  cancels: string[] = [];
  marketDown = false;
  getOrderFails = false;
  onBalanceRead?: () => void;
  readCalls: string[] = [];
  fee: TradeFee = { makerBps: 10, takerBps: 22 };

  constructor(private readonly clock: TestClock) {}

  private ts(): number {
    return this.clock.ms - this.ageMs;
  }
  async getTicker(instId: string): Promise<Ticker> {
    this.readCalls.push(`ticker:${instId}`);
    if (this.marketDown) throw new ExchangeError("piyasa yok", "unavailable");
    return { instId, bidPx: this.bid, askPx: this.ask, last: this.bid, ts: this.ts() };
  }
  async getBook(instId: string): Promise<Book> {
    this.readCalls.push(`book:${instId}`);
    if (this.marketDown) throw new ExchangeError("piyasa yok", "unavailable");
    return { bids: [{ px: this.bid, sz: "1000" }], asks: [{ px: this.ask, sz: "1000" }], ts: this.ts() };
  }
  async getCandles(instId: string): Promise<unknown[]> {
    this.readCalls.push(`candles:${instId}`);
    return [["1790000000000", "49.4", "49.5", "49.3", "49.45", "100", "4900", "4900", "1"]];
  }
  async getBalance(): Promise<Balance> {
    this.onBalanceRead?.();
    return this.balance;
  }
  async getTradeFee(): Promise<TradeFee> {
    return this.fee;
  }
  async placeOrder(a: PlaceOrderArgs): Promise<{ ordId: string }> {
    this.placed.push(a);
    const ordId = `ord-${this.placed.length}`;
    const mk = (state: OrderInfo["state"], acc: string): OrderInfo => ({
      ordId,
      clOrdId: a.clOrdId,
      state,
      sz: a.sz,
      px: a.px,
      accFillSz: acc,
      avgPx: acc === "0" ? "" : a.px,
    });
    switch (this.behavior) {
      case "reject":
        this.placed.pop();
        throw new ExchangeError("OKX ret", "rejected", { code: "51008" });
      case "reject-duplicate":
        this.placed.pop();
        throw new ExchangeError("OKX kopya clOrdId", "rejected", { code: "51016" });
      case "timeout-lost":
        throw new ExchangeError("zaman aşımı", "uncertain");
      case "timeout-landed":
        this.orders.set(a.clOrdId, mk("filled", a.sz));
        throw new ExchangeError("zaman aşımı", "uncertain");
      case "rest":
        this.orders.set(a.clOrdId, mk("live", "0"));
        return { ordId };
      case "fill":
        this.orders.set(a.clOrdId, mk("filled", a.sz));
        return { ordId };
    }
  }
  async getOrder(clOrdId: string): Promise<OrderInfo | null> {
    if (this.getOrderFails) throw new ExchangeError("get-order başarısız", "unavailable");
    return this.orders.get(clOrdId) ?? null;
  }
  async cancelOrder(clOrdId: string): Promise<void> {
    this.cancels.push(clOrdId);
    const o = this.orders.get(clOrdId);
    if (o && (o.state === "live" || o.state === "partially_filled")) {
      this.orders.set(clOrdId, { ...o, state: "canceled", accFillSz: this.restFill, avgPx: this.restFill === "0" ? "" : o.px });
    }
  }
  async listOpenClOrdIds(): Promise<string[]> {
    return [...this.orders.values()].filter((o) => o.state === "live" || o.state === "partially_filled").map((o) => o.clOrdId);
  }
  async close(): Promise<void> {}

  /** Borsada elle emir kur (yeniden başlatma testi). */
  injectOrder(o: OrderInfo): void {
    this.orders.set(o.clOrdId, o);
  }
}

// ─────────────────────────────── harness ───────────────────────────────

export const INSTRUMENT_BODY = {
  code: "0",
  data: [{ instType: "SPOT", instId: "USDT-TRY", tickSz: "0.001", lotSz: "0.0001", minSz: "1", state: "live" }],
};
export const fakeInstrumentsFetch: typeof fetch = async () =>
  new Response(JSON.stringify(INSTRUMENT_BODY), { status: 200, headers: { "Content-Type": "application/json" } });

export interface Harness {
  dir: string;
  clock: TestClock;
  chain: FakeChain;
  exchange: FakeExchange;
  store: ActionStore;
  logger: MemoryLogger;
  heartbeats: HeartbeatBook;
  health: HealthMonitor;
  executor: Executor;
  service: KuleService;
  instruments: InstrumentCache;
  caa: { active: boolean; renew: number | null };
  actionsPath: string;
  cleanup(): void;
  /** Aynı dizin/sahte borsa/zincir ile yeni süreç gibi yeniden kur (yeniden başlatma). */
  restart(over?: { paper?: boolean }): Harness;
}

export function makeHarness(o: { paper?: boolean; tuning?: Partial<Tuning>; dir?: string; reuse?: Pick<Harness, "clock" | "chain" | "exchange" | "logger" | "caa"> } = {}): Harness {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "kule-test-"));
  const clock = o.reuse?.clock ?? new TestClock();
  const chain = o.reuse?.chain ?? new FakeChain(clock);
  const exchange = o.reuse?.exchange ?? new FakeExchange(clock);
  const logger = o.reuse?.logger ?? new MemoryLogger(clock);
  const caa = o.reuse?.caa ?? { active: true, renew: T0 };
  const actionsPath = join(dir, "data", "kule-actions.json");
  const store = new ActionStore(actionsPath);
  const heartbeats = new HeartbeatBook(clock, ["pilot", "agent2"]);
  heartbeats.beat("pilot");
  heartbeats.beat("agent2");
  const caaState: CaaState = { isActive: () => caa.active, lastRenewAt: () => caa.renew };
  const instruments = new InstrumentCache(clock, fakeInstrumentsFetch);
  const health = new HealthMonitor({
    clock,
    exchange,
    chain,
    store,
    heartbeats,
    planUser: USER,
    caa: o.paper ? null : caaState,
  });
  const sleep = async (ms: number) => {
    clock.advance(ms);
  };
  const executor = new Executor({
    planUser: USER,
    kuleReporter: REPORTER,
    paper: o.paper === true,
    mode: o.paper ? "paper" : "demo",
    clock,
    sleep,
    chain,
    exchange,
    instruments,
    store,
    health,
    logger,
    tuning: o.tuning ?? {},
  });
  const service = new KuleService({ executor, health, exchange, instruments, clock, heartbeats, mode: o.paper ? "paper" : "demo", caa: o.paper ? null : caaState });
  const h: Harness = {
    dir,
    clock,
    chain,
    exchange,
    store,
    logger,
    heartbeats,
    health,
    executor,
    service,
    instruments,
    caa,
    actionsPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    restart: (over) => makeHarness({ paper: over?.paper ?? o.paper, tuning: o.tuning, dir, reuse: { clock, chain, exchange, logger, caa } }),
  };
  return h;
}
