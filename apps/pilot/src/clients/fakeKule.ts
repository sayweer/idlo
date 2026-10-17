/**
 * Bellek içi KULE (test ve kayıt oynatma). KULE SUNUCUSU DEĞİLDİR; gerçek KULE apps/kule'dedir (Bekir).
 * Borsaya hiçbir şey gitmez: her dolum kâğıt dolumudur (`paper: true`, mode "paper"; CLAUDE.md kural 12).
 *
 * Paylaşılan şemaları iki yönde zorlar (ValidatingKuleClient) ve §9.2 sırasının temel verdict'lerini verir:
 *   1 token (AUTH) ve ajan bağı (WRONG_AGENT / NO_AUTHORIZATION, shared checkActionOwner)
 *   2 izin başına tek uygulama (ALREADY_EXECUTED)
 *   3 sağlık (BEKLET HEALTH:<sebep>)
 *   4–5 zincirde AUTHORIZED + plan aktif + zaman payı (NO_AUTHORIZATION / TOO_LATE, shared checkActionLive)
 *   7 bakiye (BALANCE / BALANCE_IN_FUNDING)
 *   8 veri yaşı, makas, ioc'de bestAsk > floorTick(maxPx) (BEKLET STALE_DATA / WIDE_SPREAD / ABOVE_MAX_PX)
 *   9 boyut (RET BELOW_MIN_SZ); fiyat tickSz'ye aşağı yuvarlanır
 * kule_quote: §9.1 DÜZELT (szHint ≈ amountTL; px × szHint %1'den fazla sapıyor).
 * sz'yi yalnız KULE hesaplar (CLAUDE.md kural 9); burada KULE'nin yerine geçen sahte hesaptır.
 */
import { keccak256, toHex, type Address, type Hex } from "viem";
import {
  ACTION_STATES,
  checkActionLive,
  checkActionOwner,
  clOrdIdFor,
  elapsedSec,
  floorToTick,
  formatTL,
  healthReasonCode,
  limitBuySz,
  msToSec,
  notionalDeviationBps,
  notionalTLE6,
  pxE6ToPx,
  pxToPxE6,
  quoteReadback,
  verdictOfReason,
  type BuyAction,
  type ExecStatus,
  type HealthReasonName,
  type KuleReasonCode,
  type KuleToolName,
  type OrdType,
  type Plan,
} from "@pilot/shared";
import type { Clock } from "./clock.js";
import { KuleError, ValidatingKuleClient, type KuleInput, type KuleOutput } from "./kule.js";

/** FakeKule'nin zincirden okuduğu her şey (FakeChain bunu sağlar). */
export interface FakeKuleChainView {
  action(actionId: string): BuyAction | null;
  planOf(user: Address): Plan | null;
  isPlanActive(user: Address): boolean;
  reportExecution?(actionId: string, filledTL: number, status: ExecStatus): void;
}

export interface FakeMarket {
  bestBidE6: number;
  bestAskE6: number;
  tickSz: string;
  lotSz: string;
  minSz: string;
  /** Ticker/tahta yaşı (sn). §9.2-8: ≤ 5 sn. */
  ageSec: number;
}

export interface FakeBalance {
  TRY: { trading: string; funding: string | null };
  USDT: { trading: string; funding: string | null };
}

export interface FakeKuleOptions {
  chain: FakeKuleChainView;
  clock: Clock;
  /** KULE yapılandırması (shared KuleBinding): Elif'in adresi ve KULE_REPORTER. */
  planUser: Address;
  kuleReporter: Address;
  /** bearer token → bağlı ajan adresi (§9.2-1). */
  tokens: Record<string, Address>;
  market?: Partial<FakeMarket>;
  balance?: FakeBalance;
}

/** §9.2-8 eşikleri ve Ek B ücretleri. */
export const MAX_DATA_AGE_SEC = 5;
export const MAX_SPREAD_BPS = 30;
export const MAKER_FEE_BPS = 10;
export const TAKER_FEE_BPS = 22;

export interface FakeExecution {
  actionId: string;
  token: string;
  clOrdId: string;
  ordType: OrdType;
  pxE6: number;
  sz: string;
  filledTL: number;
}

export class FakeKule {
  market: FakeMarket;
  balance: FakeBalance;
  health: { reasons: HealthReasonName[] } = { reasons: [] };
  readonly executions: FakeExecution[] = [];
  readonly calls: { token: string; tool: KuleToolName; input: unknown }[] = [];
  lastHeartbeatMs: number | null = null;
  private readonly done = new Set<string>();
  private readonly inFlight = new Set<string>();
  private reportSeq = 0;

  constructor(private readonly o: FakeKuleOptions) {
    this.market = {
      bestBidE6: 42_100_000,
      bestAskE6: 42_120_000,
      tickSz: "0.01",
      lotSz: "0.01",
      minSz: "1",
      ageSec: 1,
      ...o.market,
    };
    this.balance = o.balance ?? {
      TRY: { trading: "100000", funding: "0" },
      USDT: { trading: "0", funding: "0" },
    };
  }

  /** Belirli bir token ile konuşan KuleClient (gerçek istemciyle aynı doğrulama yolu). */
  clientFor(token: string): FakeKuleClient {
    return new FakeKuleClient(this, token);
  }

  private nowSec(): number {
    return msToSec(this.o.clock.nowMs());
  }

  private healthState(): "NORMAL" | "YENİ_EMİR_YOK" | "YETKİ_YOK" {
    if (this.health.reasons.includes("PLAN_INACTIVE")) return "YETKİ_YOK";
    return this.health.reasons.length > 0 ? "YENİ_EMİR_YOK" : "NORMAL";
  }

  /** @internal FakeKuleClient.send buraya düşer. Girdi zaten doğrulanmıştır. */
  handle(token: string, tool: KuleToolName, input: Record<string, unknown>): unknown {
    this.calls.push({ token, tool, input });
    if (!(token in this.o.tokens)) {
      if (tool === "kule_execute") return this.execResult(String(input.actionId), "AUTH");
      throw new KuleError(`${tool}: AUTH`, tool);
    }
    switch (tool) {
      case "kule_status":
        return {
          health: this.healthState(),
          reasons: this.health.reasons.map(healthReasonCode),
          caa: { active: this.healthState() === "NORMAL", lastRenewAt: this.o.clock.nowMs() },
          pilotHeartbeatAgeSec: this.lastHeartbeatMs === null ? null : elapsedSec(this.lastHeartbeatMs, this.o.clock.nowMs()),
          dataAgeSec: { ticker: this.market.ageSec, book: this.market.ageSec },
          chain: { ok: true, block: 1 },
          mode: "paper",
        } satisfies KuleOutput<"kule_status">;
      case "kule_heartbeat":
        this.lastHeartbeatMs = this.o.clock.nowMs();
        return { ok: true };
      case "kule_market":
        return { instId: input.instId, kind: input.kind, fake: true, bestBid: pxE6ToPx(this.market.bestBidE6), bestAsk: pxE6ToPx(this.market.bestAskE6) };
      case "kule_balance":
        return this.balance;
      case "kule_quote":
        return this.quote(input as KuleInput<"kule_quote">);
      case "kule_execute":
        return this.execute(token, String(input.actionId));
      case "kule_cancel":
        return { ok: true, canceled: [], reasons: [] };
    }
  }

  private quote(q: KuleInput<"kule_quote">): KuleOutput<"kule_quote"> {
    const m = this.market;
    const base = q.ordType === "ioc" ? m.bestAskE6 : m.bestBidE6;
    const pxE6 = floorToTick(q.px !== undefined ? pxToPxE6(q.px) : base, m.tickSz);
    const feeBps = q.ordType === "ioc" ? TAKER_FEE_BPS : MAKER_FEE_BPS;
    const estFeeTL = Math.ceil((q.amountTL * feeBps) / 10_000);
    let sz: string;
    try {
      sz = limitBuySz({ amountTL: q.amountTL, pxE6, lotSz: m.lotSz, minSz: m.minSz });
    } catch {
      return { verdict: "RET", readback: "Tutar en küçük emir miktarının altında.", normalized: null, estFeeTL, reasons: ["BELOW_MIN_SZ"] };
    }
    const reasons: KuleReasonCode[] = [];
    if (q.szHint !== undefined) {
      // U-2: szHint ≈ amountTL (TL'yi USDT sanmış); U-3: szHint × px tutardan %1'den fazla sapıyor.
      if (notionalDeviationBps(q.szHint, 1_000_000, q.amountTL) <= 100) reasons.push("SZ_LOOKS_LIKE_TL");
      else if (notionalDeviationBps(q.szHint, pxE6, q.amountTL) > 100) reasons.push("NOTIONAL_MISMATCH");
    }
    return {
      verdict: reasons.length ? "DÜZELT" : "ONAY",
      readback: quoteReadback({ amountTL: q.amountTL, sz, pxE6, ordType: q.ordType }),
      normalized: { instId: "USDT-TRY", side: "buy", ordType: q.ordType, px: pxE6ToPx(pxE6), sz },
      estFeeTL,
      reasons,
    };
  }

  private execResult(actionId: string, reason: KuleReasonCode): KuleOutput<"kule_execute"> {
    const verdict = verdictOfReason(reason);
    return {
      verdict: verdict === "BEKLET" ? "BEKLET" : "RET",
      clOrdId: clOrdIdFor(actionId),
      status: "NOT_PLACED",
      readback: "Emir gönderilmedi.",
      reasons: [reason],
      paper: true,
    };
  }

  private execute(token: string, actionId: string): KuleOutput<"kule_execute"> {
    const agent = this.o.tokens[token]!;
    const action = this.o.chain.action(actionId);
    if (!action) return this.execResult(actionId, "NO_AUTHORIZATION");
    const plan = this.o.chain.planOf(action.user);
    const owner = checkActionOwner(
      { user: action.user },
      { agent: plan?.agent ?? "0x0000000000000000000000000000000000000000", kule: plan?.kule ?? "0x0000000000000000000000000000000000000000" },
      { planUser: this.o.planUser, kuleReporter: this.o.kuleReporter, tokenAgent: agent },
    );
    if (!owner.ok) return this.execResult(actionId, owner.reason);

    // Adım 2: izin başına kilit + "kalıcı" durum (bellekte).
    if (this.done.has(actionId) || this.inFlight.has(actionId)) return this.execResult(actionId, "ALREADY_EXECUTED");
    this.inFlight.add(actionId);
    try {
      const health = this.health.reasons[0];
      if (health) return this.execResult(actionId, healthReasonCode(health));

      const live = checkActionLive(
        { state: ACTION_STATES.indexOf(action.state), openBy: BigInt(action.openBy) },
        this.o.chain.isPlanActive(action.user),
        this.nowSec(),
      );
      if (!live.ok) return this.execResult(actionId, live.reason);

      const need = BigInt(action.amountTL) * 1_000_000n;
      if (decE6(this.balance.TRY.trading) < need) {
        const funding = this.balance.TRY.funding;
        const inFunding = funding !== null && decE6(funding) >= need;
        return this.execResult(actionId, inFunding ? "BALANCE_IN_FUNDING" : "BALANCE");
      }

      const m = this.market;
      if (m.ageSec > MAX_DATA_AGE_SEC) return this.execResult(actionId, "STALE_DATA");
      if (((m.bestAskE6 - m.bestBidE6) * 10_000) / m.bestBidE6 > MAX_SPREAD_BPS) return this.execResult(actionId, "WIDE_SPREAD");
      const maxPx = floorToTick(action.maxPxE6, m.tickSz);
      let pxE6: number;
      if (action.ordType === "ioc") {
        if (m.bestAskE6 > maxPx) return this.execResult(actionId, "ABOVE_MAX_PX");
        pxE6 = m.bestAskE6;
      } else {
        pxE6 = Math.min(maxPx, m.bestBidE6);
      }
      pxE6 = floorToTick(pxE6, m.tickSz);

      let sz: string;
      try {
        sz = limitBuySz({ amountTL: action.amountTL, pxE6, lotSz: m.lotSz, minSz: m.minSz });
      } catch {
        return this.execResult(actionId, "BELOW_MIN_SZ");
      }
      const filledTL = Number(notionalTLE6(sz, pxE6) / 1_000_000n);
      const clOrdId = clOrdIdFor(actionId);
      this.done.add(actionId);
      this.executions.push({ actionId, token, clOrdId, ordType: action.ordType, pxE6, sz, filledTL });
      let reportTx: Hex | undefined;
      if (this.o.chain.reportExecution) {
        this.o.chain.reportExecution(actionId, filledTL, "FILLED");
        reportTx = keccak256(toHex(`fake-report-${++this.reportSeq}`));
      }
      return {
        verdict: "ONAY",
        clOrdId,
        ordId: `paper-${actionId}`,
        status: "FILLED",
        readback: `${formatTL(action.amountTL)} TL için kâğıt dolum: ${sz} USDT (${pxE6ToPx(pxE6)}).`,
        reasons: [],
        ...(reportTx ? { reportTx } : {}),
        paper: true,
      };
    } finally {
      this.inFlight.delete(actionId);
    }
  }

}

/** Ondalık bakiye → ×10^6 bigint (fazla haneler kesilir; yalnız karşılaştırma için). */
function decE6(s: string): bigint {
  const [i = "0", f = ""] = s.split(".");
  return BigInt(i + f.slice(0, 6).padEnd(6, "0"));
}

export class FakeKuleClient extends ValidatingKuleClient {
  constructor(
    private readonly kule: FakeKule,
    private readonly token: string,
  ) {
    super();
  }
  protected async send(name: KuleToolName, args: Record<string, unknown>): Promise<unknown> {
    return this.kule.handle(this.token, name, args);
  }
}
