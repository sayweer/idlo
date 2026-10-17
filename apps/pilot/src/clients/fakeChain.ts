/**
 * Bellek içi FlightPlan (test ve kayıt oynatma). Ağ yok; hiçbir şey yayınlanmaz.
 * Davranış contracts/src/FlightPlan.sol ile aynı sırada (§8.3 _check): NotAgent revert, ret kodları 1–4,
 * bant açıksa (Pyth yok) 6 (7 BAD_ORDTYPE burada oluşamaz: ordType tipli); openBy = now + 15 dk, reportBy = openBy + 60 dk; reservedTL / spentTL hesabı (§8.4).
 * Bekleyen plan / 24 sa kilit (§8.2) burada yoktur: setPlan test yardımcısıdır ve planı hemen yazar.
 */
import { isAddressEqual, keccak256, toHex, type Address, type Hex } from "viem";
import {
  BuyActionSchema,
  PlanSchema,
  cycleIdOf,
  msToSec,
  trDay,
  type BuyAction,
  type Cycle,
  type ExecStatus,
  type OrdType,
  type Plan,
  type RejectCodeName,
  type TL,
} from "@pilot/shared";
import type { Clock } from "./clock.js";
import { ChainError, type ChainClient, type RequestBuyArgs, type RequestBuyResult } from "./chain.js";

export const OPEN_WINDOW_SEC = 15 * 60;
export const REPORT_WINDOW_SEC = 60 * 60;

export type FakeChainEvent =
  | { kind: "BuyAuthorized"; actionId: string; user: Address; amountTL: TL; maxPxE6: number; ordType: OrdType; reasonHash: Hex; tx: Hex }
  | { kind: "BuyRejected"; user: Address; amountTL: TL; code: RejectCodeName; reasonHash: Hex; tx: Hex }
  | { kind: "BuyExecuted"; actionId: string; filledTL: TL; status: ExecStatus };

const key = (a: string) => a.toLowerCase();

export class FakeChain {
  readonly events: FakeChainEvent[] = [];
  private readonly plans = new Map<string, { plan: Plan; revoked: boolean }>();
  private readonly cycleBook = new Map<string, Cycle>(); // `${user}:${cycleId}`
  private readonly actionBook = new Map<string, BuyAction>();
  private lastActionId = 0;
  private txSeq = 0;

  constructor(readonly clock: Clock) {}

  private nowSec(): number {
    return msToSec(this.clock.nowMs());
  }
  private nextTx(): Hex {
    return keccak256(toHex(`fake-tx-${++this.txSeq}`));
  }

  // ── test yardımcıları ──
  setPlan(user: Address, plan: Plan): void {
    this.plans.set(key(user), { plan: PlanSchema.parse(plan), revoked: false });
  }
  revoke(user: Address): void {
    const p = this.plans.get(key(user));
    if (p) p.revoked = true;
  }

  // ── okuma (IFlightPlan view) ──
  planOf(user: Address): Plan | null {
    return this.plans.get(key(user))?.plan ?? null;
  }
  isPlanActive(user: Address): boolean {
    const p = this.plans.get(key(user));
    return !!p && !p.revoked && this.nowSec() < p.plan.expiresAt;
  }
  cycleOfNow(user: Address): Cycle {
    const id = cycleIdOf(this.nowSec());
    const c = this.cycleBook.get(`${key(user)}:${id}`);
    return { id, spentTL: c?.spentTL ?? 0, reservedTL: c?.reservedTL ?? 0, closed: c?.closed ?? false };
  }
  action(actionId: string): BuyAction | null {
    const a = this.actionBook.get(actionId);
    return a ? { ...a } : null;
  }

  // ── yazma ──
  /** FlightPlan.requestBuy; msg.sender = sender. */
  requestBuy(sender: Address, user: Address, a: RequestBuyArgs): RequestBuyResult {
    const entry = this.plans.get(key(user));
    if (!entry || !isAddressEqual(sender, entry.plan.agent)) throw new ChainError("NotAgent", { uncertain: false });
    const p = entry.plan;
    const now = this.nowSec();
    const cycle = this.cycleOfNow(user);
    const tx = this.nextTx();

    let code: RejectCodeName | null = null;
    const d = trDay(now);
    if (!this.isPlanActive(user)) code = "PLAN_INACTIVE";
    else if (d < p.startDay || d > p.deadlineDay || cycle.closed) code = "OUTSIDE_WINDOW";
    else if (a.amountTL === 0 || a.amountTL > p.maxOrderTL) code = "OVER_ORDER_LIMIT";
    else if (cycle.spentTL + cycle.reservedTL + a.amountTL > p.cycleTL) code = "OVER_CYCLE_TARGET";
    else if (p.bandBps !== 0) code = "PRICE_UNAVAILABLE";
    if (code) {
      this.events.push({ kind: "BuyRejected", user, amountTL: a.amountTL, code, reasonHash: a.reasonHash, tx });
      return { status: "REJECTED", code, tx, finalityMs: 0 };
    }

    this.cycleBook.set(`${key(user)}:${cycle.id}`, { ...cycle, reservedTL: cycle.reservedTL + a.amountTL });
    const actionId = String(++this.lastActionId);
    const openBy = now + OPEN_WINDOW_SEC;
    this.actionBook.set(
      actionId,
      BuyActionSchema.parse({
        user,
        amountTL: a.amountTL,
        maxPxE6: a.maxPxE6,
        ordType: a.ordType,
        openBy,
        reportBy: openBy + REPORT_WINDOW_SEC,
        cycleId: cycle.id,
        state: "AUTHORIZED",
      }),
    );
    this.events.push({ kind: "BuyAuthorized", actionId, user, amountTL: a.amountTL, maxPxE6: a.maxPxE6, ordType: a.ordType, reasonHash: a.reasonHash, tx });
    return { status: "AUTHORIZED", actionId, openBy, tx, finalityMs: 0 };
  }

  /** FlightPlan.reportExecution (KULE'nin raporu; FakeKule çağırır). */
  reportExecution(actionId: string, filledTL: TL, status: ExecStatus): void {
    const a = this.actionBook.get(actionId);
    if (!a || a.state !== "AUTHORIZED") throw new ChainError("ActionNotAuthorized", { uncertain: false });
    if (this.nowSec() > a.reportBy) throw new ChainError("ReportWindowClosed", { uncertain: false });
    if (filledTL > a.amountTL) throw new ChainError("OverFilled", { uncertain: false });
    const k = `${key(a.user)}:${a.cycleId}`;
    const c = this.cycleBook.get(k)!;
    this.cycleBook.set(k, { ...c, spentTL: c.spentTL + filledTL, reservedTL: c.reservedTL - a.amountTL });
    a.state = "REPORTED";
    this.events.push({ kind: "BuyExecuted", actionId, filledTL, status });
  }

  /** FlightPlan.expireAction. */
  expireAction(actionId: string): void {
    const a = this.actionBook.get(actionId);
    if (!a || a.state !== "AUTHORIZED") throw new ChainError("ActionNotAuthorized", { uncertain: false });
    if (this.nowSec() <= a.reportBy) throw new ChainError("ReportWindowOpen", { uncertain: false });
    const k = `${key(a.user)}:${a.cycleId}`;
    const c = this.cycleBook.get(k)!;
    this.cycleBook.set(k, { ...c, reservedTL: c.reservedTL - a.amountTL });
    a.state = "EXPIRED";
  }

  /** Bir ajanın (agent) sabit kullanıcı (user) için ChainClient görünümü. */
  clientFor(agent: Address, user: Address): ChainClient {
    return {
      agent,
      user,
      readPlan: async () => {
        const plan = this.planOf(user);
        return { plan, active: plan !== null && this.isPlanActive(user) };
      },
      readCycle: async () => this.cycleOfNow(user),
      readAction: async (id) => this.action(id),
      requestBuy: async (a) => this.requestBuy(agent, user, a),
    };
  }
}
