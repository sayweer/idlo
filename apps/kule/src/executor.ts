/**
 * kule_execute (§9.2) ve kule_cancel. SPEC §9.2 sırası:
 *   1 token (AUTH / WRONG_AGENT) + izin sahipliği (shared checkActionOwner, KİLİTTEN ÖNCE) + ERC-8004 bağı
 *   2 izin başına kilit + diske RESERVED (fsync) → varsa ALREADY_EXECUTED
 *   3 sağlık (BEKLET HEALTH:<sebep>)
 *   4–5 zincirde AUTHORIZED + plan aktif + zaman payı ≥ 12 dk (shared checkActionLive, sağlıktan sonra) + eski plan izni
 *   6 yalnız USDT-TRY alışı (sabit)
 *   7 işlem hesabında TRY (BALANCE / BALANCE_IN_FUNDING)
 *   8 veri ≤ 5 sn, makas ≤ 30 bp, post_only px = min(floorTick(maxPx), bestBid), ioc px = bestAsk (ABOVE_MAX_PX → BEKLET)
 *   9 sz = limitBuySz (yalnız KULE hesaplar)
 *  10 ücret (yalnız günlük/tahmin; önbellek 1 sa)
 *  11 PLACED diske → emir (clOrdId "plt"+actionId)
 *  12 sonuç belirsizse emir sonucu get-order ile netleşene kadar YENİ_EMİR_YOK
 *  13 post_only en fazla 10 dk bekler → iptal → reportExecution(…, keccak256(günlük satırı))
 *
 * Takım kararları (SPEC dışı, TODO(spec)):
 *  (a) Emir açılmadan reddedilen sahipli izin (TOO_LATE, BALANCE, BALANCE_IN_FUNDING, BELOW_MIN_SZ, EXCHANGE_REJECTED)
 *      reportExecution(actionId, "", 0, 0, CANCELED, hash) ile hemen serbest bırakılır (ayrılmış TL açılır).
 *      BEKLET sonuçları (geçici) serbest bırakmaz; izin süresi dolana kadar yeniden denenebilir.
 *  (b) plans(user).agent == ERC-8004 agentWallet(plan.agentId) değilse RET NO_AUTHORIZATION.
 *  (c) BuyAuthorized, kullanıcının son PlanSet(immediate)/PlanRevoked bloğundan eskiyse RET NO_AUTHORIZATION.
 * Kâğıt modu (KULE_EXEC=paper): borsaya emir gitmez, canlı tahtaya karşı simüle dolum (ioc: bestAsk, post_only: px),
 * paper:true. TODO(spec): kâğıt modunda işlem hesabı bakiyesi kontrol edilmez (kâğıt, bakiye yokken de çalışsın).
 */
import { isAddressEqual, keccak256, stringToBytes, type Address } from "viem";
import {
  ACTION_STATES,
  EXEC_STATUS_TEXTS,
  ORD_TYPE_TEXTS,
  checkActionLive,
  checkActionOwner,
  clOrdIdFor,
  decimalToScaled,
  floorToTick,
  formatDecimalTr,
  formatPxTr,
  formatTL,
  healthReasonCode,
  kuleReasonText,
  limitBuySz,
  minutesToMs,
  msToSec,
  notionalTLE6,
  pxE6ToPx,
  pxToPxE6,
  verdictOfReason,
  type BuyAction,
  type ExecStatus,
  type KuleMode,
  type KuleReasonCode,
  type OrdType,
  type Plan,
} from "@pilot/shared";
import { ChainDataError, type KuleChain } from "./chain.js";
import type { TokenBinding } from "./config.js";
import { ExchangeError, type Exchange, type OrderInfo } from "./exchange.js";
import { MAX_DATA_AGE_SEC, type HealthMonitor } from "./health.js";
import type { InstrumentCache } from "./instruments.js";
import type { Logger } from "./logger.js";
import { bestPrices, spreadTooWide } from "./market.js";
import type { ActionRecord, ActionStore } from "./store.js";
import type { KuleInput, KuleOutput } from "./types.js";
import { errText, truncDecimal, type Clock, type Sleep } from "./util.js";

export interface Tuning {
  /** post_only en fazla bekleme (§9.2-13: 10 dk). */
  postOnlyWaitMs: number;
  /** ioc'nin sonuçlanması için azami bekleme. TODO(spec): SPEC vermiyor. */
  iocWaitMs: number;
  pollMs: number;
  /** Belirsiz emirde ilk netleştirme denemeleri. */
  resolveAttempts: number;
  resolveBackoffMs: number;
  /** Yeniden başlatmada PLACED + emir bulunamadı: bu süre sonra "emir yok" sayılır (CAA geç düşen emri de iptal eder). TODO(spec). */
  uncertainGraceMs: number;
  /** reportExecution yeniden deneme sınırı. */
  maxReportFailures: number;
}

export const DEFAULT_TUNING: Tuning = {
  postOnlyWaitMs: minutesToMs(10),
  iocWaitMs: 10_000,
  pollMs: 2_000,
  resolveAttempts: 3,
  resolveBackoffMs: 1_000,
  uncertainGraceMs: 90_000,
  maxReportFailures: 20,
};

export interface ExecutorDeps {
  planUser: Address;
  kuleReporter: Address;
  paper: boolean;
  mode: KuleMode;
  clock: Clock;
  sleep: Sleep;
  chain: KuleChain;
  exchange: Exchange;
  instruments: InstrumentCache;
  store: ActionStore;
  health: HealthMonitor;
  logger: Logger;
  tuning?: Partial<Tuning>;
}

type ExecOut = KuleOutput<"kule_execute">;
type CancelOut = KuleOutput<"kule_cancel">;

/** Emir açılmadan reddetme (erken çıkış). release: zincirde CANCELED ile serbest bırak (a). */
class Reject extends Error {
  constructor(
    readonly reasons: KuleReasonCode[],
    readonly opts: { release?: boolean; detail?: string } = {},
  ) {
    super(reasons.join(","));
    this.name = "Reject";
  }
}

interface Ctx {
  actionId: string;
  clOrdId: string;
  caller: string | null;
  checks: string[];
  detail: string[];
}

interface Outcome {
  status: ExecStatus;
  filledTL: number;
  avgPxE6: number;
  accFillSz: string;
}

const TERMINAL = new Set(["filled", "canceled", "mmp_canceled"]);

export class Executor {
  private readonly t: Tuning;
  private readonly inFlight = new Set<string>();
  private reconciling = false;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly d: ExecutorDeps) {
    this.t = { ...DEFAULT_TUNING, ...d.tuning };
  }

  private nowMs(): number {
    return this.d.clock.nowMs();
  }

  // ─────────────────────────────── kule_execute ───────────────────────────────

  async execute(binding: TokenBinding | null, actionId: string): Promise<ExecOut> {
    const clOrdId = clOrdIdFor(actionId); // geçersiz/çok uzun actionId → fırlatır (araç hatası)
    const ctx: Ctx = { actionId, clOrdId, caller: binding?.label ?? null, checks: [], detail: [] };
    try {
      return await this.run(binding, ctx);
    } catch (e) {
      if (e instanceof Reject) return this.reply(ctx, e.reasons, e.opts.detail ? { detail: e.opts.detail } : undefined);
      throw e;
    }
  }

  private async run(binding: TokenBinding | null, ctx: Ctx): Promise<ExecOut> {
    const { actionId } = ctx;
    // 1. token → ajan bağı
    if (!binding) throw new Reject(["AUTH"]);
    if (!binding.agent) throw new Reject(["WRONG_AGENT"]);
    const agent = binding.agent;

    // 1b. izin sahipliği (kilitten ÖNCE): başka ajanın token'ı/başka kullanıcının izni diske RESERVED yazamaz.
    const pre = await this.readChain(actionId);
    const owner = checkActionOwner({ user: pre.action.user }, { agent: pre.plan.agent, kule: pre.plan.kule }, this.binding(agent));
    if (!owner.ok) throw new Reject([owner.reason]);
    ctx.checks.push("owner:ok");
    await this.assertAgentWallet(pre.plan, ctx);

    // 2. izin başına kilit + kalıcı durum
    if (this.inFlight.has(actionId) || this.d.store.get(actionId)) throw new Reject(["ALREADY_EXECUTED"]);
    this.inFlight.add(actionId);
    try {
      const now = this.nowMs();
      const rec: ActionRecord = {
        actionId,
        clOrdId: ctx.clOrdId,
        state: "RESERVED",
        agent: agent.toLowerCase(),
        paper: this.d.paper,
        amountTL: pre.action.amountTL,
        reservedAtMs: now,
        updatedAtMs: now,
      };
      if (!(await this.d.store.reserve(rec))) throw new Reject(["ALREADY_EXECUTED"]);
      ctx.checks.push("reserved");
      try {
        return await this.runLocked(binding, agent, ctx);
      } catch (e) {
        if (e instanceof Reject) {
          // Emir açılmadı: kayıt PLACED'a geçmediyse temizle ya da serbest bırak.
          const cur = this.d.store.get(actionId);
          if (cur && cur.state === "RESERVED") {
            if (e.opts.release) {
              const tx = await this.releaseUnplaced(actionId, e.reasons[0]!);
              return this.reply(ctx, e.reasons, { ...(tx ? { reportTx: tx } : {}), ...(e.opts.detail ? { detail: e.opts.detail } : {}) });
            }
            await this.d.store.delete(actionId);
          }
        }
        throw e;
      }
    } finally {
      this.inFlight.delete(actionId);
    }
  }

  private async runLocked(binding: TokenBinding, agent: Address, ctx: Ctx): Promise<ExecOut> {
    const { actionId } = ctx;

    // 3. sağlık (PLAN_INACTIVE adım 4'te RET NO_AUTHORIZATION olur)
    const h = await this.d.health.check({ callerLabel: binding.label });
    const blocking = h.reasons.filter((r) => r !== "PLAN_INACTIVE");
    if (blocking.length > 0) throw new Reject(blocking.map(healthReasonCode));
    ctx.checks.push("health:NORMAL");

    // 4. zincir yeniden okunur (kilit sonrası) ve sahiplik/bağ yeniden doğrulanır
    const cur = await this.readChain(actionId);
    const owner = checkActionOwner({ user: cur.action.user }, { agent: cur.plan.agent, kule: cur.plan.kule }, this.binding(agent));
    if (!owner.ok) throw new Reject([owner.reason]);
    await this.assertAgentWallet(cur.plan, ctx);
    const a = cur.action;

    // 4–5. AUTHORIZED, plan aktif, zaman payı
    const nowSec = msToSec(this.nowMs());
    const live = checkActionLive({ state: ACTION_STATES.indexOf(a.state), openBy: BigInt(a.openBy) }, h.planActive === true, nowSec);
    if (!live.ok) throw new Reject([live.reason], { release: live.reason === "TOO_LATE" });
    ctx.checks.push("live:ok");

    // (c) eski plan izni
    let fresh;
    try {
      fresh = await this.d.chain.permitFreshness(actionId, a.user);
    } catch {
      throw new Reject([healthReasonCode("CHAIN_UNREADABLE")]);
    }
    if (fresh !== "current") throw new Reject(["NO_AUTHORIZATION"], { detail: fresh === "stale" ? "permit_older_than_plan_change" : "permit_not_found" });
    ctx.checks.push("permit:current");

    // 6. enstrüman ve yön: yalnız USDT-TRY alışı (sabit; izin enstrüman taşımaz)
    ctx.checks.push("inst:USDT-TRY/buy");

    // 7. bakiye: işlem hesabında TRY
    if (!this.d.paper) {
      let bal;
      try {
        bal = await this.d.exchange.getBalance();
      } catch {
        throw new Reject([healthReasonCode("DATA_STALE")], { detail: "balance_unreadable" });
      }
      const need = BigInt(a.amountTL) * 1_000_000n;
      const trading = decimalToScaled(truncDecimal(bal.TRY.trading, 6), 6);
      if (trading < need) {
        const funding = bal.TRY.funding === null ? 0n : decimalToScaled(truncDecimal(bal.TRY.funding, 6), 6);
        throw new Reject([funding >= need ? "BALANCE_IN_FUNDING" : "BALANCE"], { release: true });
      }
      ctx.checks.push("balance:ok");
    }

    // 8. piyasa ve fiyat
    let params;
    try {
      params = await this.d.instruments.get();
    } catch {
      throw new Reject([healthReasonCode("DATA_STALE")], { detail: "instruments_unavailable" });
    }
    const market = h.market;
    if (!market) throw new Reject([healthReasonCode("DATA_STALE")]);
    const nowMs = this.nowMs();
    const age = (ts: number) => Math.max(0, (nowMs - ts) / 1000);
    if (age(market.ticker.ts) > MAX_DATA_AGE_SEC || age(market.book.ts) > MAX_DATA_AGE_SEC) throw new Reject(["STALE_DATA"]);
    const best = bestPrices(market.book);
    if (!best) throw new Reject(["STALE_DATA"], { detail: "book_invalid" });
    if (spreadTooWide(best)) throw new Reject(["WIDE_SPREAD"]);
    let maxPx: number;
    try {
      maxPx = floorToTick(a.maxPxE6, params.tickSz);
    } catch {
      throw new Reject(["NO_AUTHORIZATION"], { detail: "maxPx_invalid" });
    }
    let pxE6: number;
    if (a.ordType === "ioc") {
      if (best.askE6 > maxPx) throw new Reject(["ABOVE_MAX_PX"]);
      pxE6 = floorToTick(best.askE6, params.tickSz);
    } else {
      pxE6 = floorToTick(Math.min(maxPx, best.bidE6), params.tickSz);
    }
    ctx.checks.push("market:ok");

    // 9. boyut
    let sz: string;
    try {
      sz = limitBuySz({ amountTL: a.amountTL, pxE6, lotSz: params.lotSz, minSz: params.minSz });
    } catch {
      throw new Reject(["BELOW_MIN_SZ"], { release: true });
    }
    if (notionalTLE6(sz, pxE6) > BigInt(a.amountTL) * 1_000_000n) throw new Error("sz × px tutarı aşıyor (savunma)");
    ctx.checks.push("sz:ok");

    // 10. ücret (yalnız günlük; başarısızsa sessizce geçilir)
    const fee = await this.d.exchange.getTradeFee().catch(() => null);

    // 11. PLACED diske, sonra emir
    const placedAt = this.nowMs();
    await this.d.store.update(actionId, { state: "PLACED", ordType: a.ordType, pxE6, sz, placedAtMs: placedAt, amountTL: a.amountTL }, placedAt);
    ctx.checks.push("placed_written");
    this.d.logger.log({
      tool: "kule_execute",
      event: "placing",
      actionId,
      clOrdId: ctx.clOrdId,
      ordType: a.ordType,
      pxE6,
      sz,
      amountTL: a.amountTL,
      paper: this.d.paper,
      ...(fee ? { feeBps: a.ordType === "ioc" ? fee.takerBps : fee.makerBps } : {}),
      caller: ctx.caller,
    });

    if (this.d.paper) {
      // Kâğıt: borsaya emir gitmez; canlı tahtaya karşı simüle dolum.
      const info: OrderInfo = { ordId: `paper-${actionId}`, clOrdId: ctx.clOrdId, state: "filled", sz, px: pxE6ToPx(pxE6), accFillSz: sz, avgPx: pxE6ToPx(pxE6) };
      await this.d.store.update(actionId, { ordId: info.ordId }, this.nowMs());
      return await this.settle(ctx, this.recOf(actionId), info, false);
    }

    let ordId: string;
    let uncertain = false;
    try {
      const r = await this.d.exchange.placeOrder({
        instId: "USDT-TRY",
        tdMode: "cash",
        side: "buy",
        ordType: a.ordType,
        px: pxE6ToPx(pxE6),
        sz,
        clOrdId: ctx.clOrdId,
      });
      ordId = r.ordId;
    } catch (e) {
      if (e instanceof ExchangeError && e.kind === "rejected") {
        // Borsa kesin reddetti: emir yok → ayrılmış TL serbest.
        this.d.logger.log({ tool: "kule_execute", event: "order_rejected", actionId, error: errText(e), code: e.code ?? null });
        const tx = await this.releaseUnplaced(actionId, "EXCHANGE_REJECTED");
        return this.reply(ctx, ["EXCHANGE_REJECTED"], tx ? { reportTx: tx } : undefined);
      }
      // Sonuç belirsiz: YENİ_EMİR_YOK; get-order ile netleşene kadar yeni emir yok (§9.2-12).
      this.d.logger.log({ tool: "kule_execute", event: "order_uncertain", actionId, error: errText(e) });
      uncertain = true;
      ordId = "";
    }
    if (uncertain) {
      await this.d.store.update(actionId, { uncertain: true }, this.nowMs());
      const resolved = await this.resolveUncertain(ctx.clOrdId);
      if (!resolved) return this.uncertainReply(ctx);
      ordId = resolved.ordId;
    }
    await this.d.store.update(actionId, { ordId }, this.nowMs());
    const fin = await this.awaitFinal(actionId, ctx.clOrdId, a.ordType, placedAt);
    if (!fin) {
      await this.d.store.update(actionId, { uncertain: true }, this.nowMs());
      return this.uncertainReply(ctx, ordId);
    }
    return await this.settle(ctx, this.recOf(actionId), fin.info, fin.timedOut);
  }

  // ─────────────────────────────── yardımcılar ───────────────────────────────

  private binding(agent: Address) {
    return { planUser: this.d.planUser, kuleReporter: this.d.kuleReporter, tokenAgent: agent };
  }

  private recOf(actionId: string): ActionRecord {
    const r = this.d.store.get(actionId);
    if (!r) throw new Error(`kayıt yok: ${actionId}`);
    return r;
  }

  private async readChain(actionId: string): Promise<{ action: BuyAction; plan: Plan }> {
    try {
      const action = await this.d.chain.readAction(actionId);
      if (!action) throw new Reject(["NO_AUTHORIZATION"]);
      const plan = await this.d.chain.readPlan(action.user);
      if (!plan) throw new Reject(["NO_AUTHORIZATION"]);
      return { action, plan };
    } catch (e) {
      if (e instanceof Reject) throw e;
      if (e instanceof ChainDataError) throw new Reject(["NO_AUTHORIZATION"]);
      throw new Reject([healthReasonCode("CHAIN_UNREADABLE")]);
    }
  }

  /** (b) ERC-8004: plans(user).agent == agentWallet(plan.agentId). */
  private async assertAgentWallet(plan: Plan, ctx: Ctx): Promise<void> {
    let wallet: Address;
    try {
      wallet = await this.d.chain.agentWallet(plan.agentId);
    } catch (e) {
      if (e instanceof ChainDataError) throw new Reject(["NO_AUTHORIZATION"], { detail: "agentWallet_invalid" });
      throw new Reject([healthReasonCode("CHAIN_UNREADABLE")]);
    }
    if (!isAddressEqual(wallet, plan.agent)) throw new Reject(["NO_AUTHORIZATION"], { detail: "agentWallet_mismatch" });
    ctx.checks.push("erc8004:ok");
  }

  /** Emir sonucu belirsizken get-order ile netleştirme denemeleri. */
  private async resolveUncertain(clOrdId: string): Promise<OrderInfo | null> {
    for (let i = 1; i <= this.t.resolveAttempts; i++) {
      await this.d.sleep(this.t.resolveBackoffMs * i);
      try {
        const o = await this.d.exchange.getOrder(clOrdId);
        if (o) return o;
      } catch {
        /* tekrar dene */
      }
    }
    return null;
  }

  /**
   * Emri izler: terminal olana kadar yoklar; süre dolarsa (post_only 10 dk) iptal eder ve son durumu okur.
   * Okunamıyorsa null (belirsiz).
   */
  private async awaitFinal(
    actionId: string,
    clOrdId: string,
    ordType: OrdType,
    placedAtMs: number,
  ): Promise<{ info: OrderInfo; timedOut: boolean } | null> {
    const deadline = placedAtMs + (ordType === "post_only" ? this.t.postOnlyWaitMs : this.t.iocWaitMs);
    for (;;) {
      let info: OrderInfo | null = null;
      try {
        info = await this.d.exchange.getOrder(clOrdId);
      } catch {
        info = null;
      }
      if (info && TERMINAL.has(info.state)) return { info, timedOut: false };
      const now = this.nowMs();
      if (now >= deadline) break;
      await this.d.sleep(Math.min(this.t.pollMs, deadline - now));
    }
    // Süre doldu: iptal et, sonra son durumu oku.
    try {
      await this.d.exchange.cancelOrder(clOrdId);
    } catch (e) {
      this.d.logger.log({ tool: "kule_execute", event: "cancel_failed", actionId, error: errText(e) });
    }
    for (let i = 0; i < 3; i++) {
      try {
        const info = await this.d.exchange.getOrder(clOrdId);
        if (info && TERMINAL.has(info.state)) return { info, timedOut: true };
      } catch {
        /* tekrar dene */
      }
      await this.d.sleep(500);
    }
    return null;
  }

  private outcomeOf(rec: ActionRecord, info: OrderInfo, timedOut: boolean): Outcome {
    const acc = truncDecimal(info.accFillSz, 18);
    const accScaled = decimalToScaled(acc, 18);
    if (accScaled === 0n) return { status: timedOut ? "EXPIRED" : "CANCELED", filledTL: 0, avgPxE6: 0, accFillSz: "0" };
    let avgPxE6: number;
    try {
      avgPxE6 = pxToPxE6(truncDecimal(info.avgPx, 6));
    } catch {
      // Ortalama fiyat yoksa emrin limit fiyatı üst sınırdır (alışta dolum limitten pahalı olamaz).
      avgPxE6 = rec.pxE6 ?? pxToPxE6(truncDecimal(info.px, 6));
    }
    const filledTL = Math.min(rec.amountTL, Number(notionalTLE6(acc, avgPxE6) / 1_000_000n));
    const szScaled = decimalToScaled(truncDecimal(rec.sz ?? info.sz, 18), 18);
    const status: ExecStatus = info.state === "filled" || accScaled >= szScaled ? "FILLED" : "PARTIAL";
    return { status, filledTL, avgPxE6, accFillSz: acc };
  }

  /** Emir terminal: DONE yaz, günlük satırı → keccak256 → reportExecution. */
  private async settle(ctx: Ctx, rec: ActionRecord, info: OrderInfo, timedOut: boolean): Promise<ExecOut> {
    const { actionId } = ctx;
    const o = this.outcomeOf(rec, info, timedOut);
    await this.d.store.update(actionId, { state: "DONE", ordId: info.ordId, filledTL: o.filledTL, avgPxE6: o.avgPxE6, status: o.status, uncertain: false }, this.nowMs());
    const line = this.d.logger.log({
      tool: "kule_execute",
      event: "execution",
      actionId,
      clOrdId: ctx.clOrdId,
      ordId: info.ordId,
      ordType: rec.ordType ?? null,
      pxE6: rec.pxE6 ?? null,
      sz: rec.sz ?? null,
      accFillSz: o.accFillSz,
      filledTL: o.filledTL,
      avgPxE6: o.avgPxE6,
      status: o.status,
      timedOut,
      paper: rec.paper,
      caller: ctx.caller,
      checks: ctx.checks,
    });
    const reportHash = keccak256(stringToBytes(line));
    await this.d.store.update(actionId, { reportHash }, this.nowMs());
    const tx = await this.tryReport(actionId);
    const paperLabel = rec.paper ? "KÂĞIT: " : "";
    const avg = o.avgPxE6 > 0 ? formatPxTr(o.avgPxE6, 4) : "-";
    const readback =
      `${paperLabel}${EXEC_STATUS_TEXTS[o.status]}: ${formatTL(o.filledTL)} TL ile ${formatDecimalTr(truncDecimal(o.accFillSz, 8), 4)} USDT ` +
      `(ort. ${avg}, ${ORD_TYPE_TEXTS[rec.ordType ?? "post_only"]}).`;
    return {
      verdict: "ONAY",
      clOrdId: ctx.clOrdId,
      ordId: info.ordId,
      status: o.status,
      readback,
      reasons: [],
      ...(tx ? { reportTx: tx } : {}),
      paper: rec.paper,
    };
  }

  /** DONE kaydını zincire raporlar; başarılıysa REPORTED. Başarısızsa undefined (reconcile yeniden dener). */
  private async tryReport(actionId: string): Promise<`0x${string}` | undefined> {
    const rec = this.d.store.get(actionId);
    if (!rec || rec.state !== "DONE" || !rec.status || rec.reportHash === undefined) return undefined;
    try {
      const tx = await this.d.chain.reportExecution({
        actionId,
        ordId: rec.ordId ?? "",
        filledTL: rec.filledTL ?? 0,
        avgPxE6: rec.avgPxE6 ?? 0,
        status: rec.status,
        reportHash: rec.reportHash,
      });
      await this.d.store.update(actionId, { state: "REPORTED", reportTx: tx }, this.nowMs());
      this.d.logger.log({ tool: "kule_execute", event: "reported", actionId, tx });
      return tx;
    } catch (e) {
      const failures = (rec.reportFailures ?? 0) + 1;
      this.d.logger.log({ tool: "kule_execute", event: "report_failed", actionId, error: errText(e), failures });
      await this.d.store.update(actionId, { reportFailures: failures }, this.nowMs()).catch(() => undefined);
      return undefined;
    }
  }

  /** (a) Emir açılmadı: reportExecution(actionId, "", 0, 0, CANCELED, hash) ile ayrılmış TL'yi serbest bırak. */
  private async releaseUnplaced(actionId: string, reason: KuleReasonCode): Promise<`0x${string}` | undefined> {
    const line = this.d.logger.log({ tool: "kule_execute", event: "release", actionId, status: "CANCELED", reason });
    const reportHash = keccak256(stringToBytes(line));
    try {
      const tx = await this.d.chain.reportExecution({ actionId, ordId: "", filledTL: 0, avgPxE6: 0, status: "CANCELED", reportHash });
      await this.d.store.update(
        actionId,
        { state: "REPORTED", status: "CANCELED", filledTL: 0, avgPxE6: 0, reportHash, reportTx: tx, released: true, uncertain: false },
        this.nowMs(),
      );
      return tx;
    } catch (e) {
      this.d.logger.log({ tool: "kule_execute", event: "release_failed", actionId, error: errText(e) });
      await this.d.store.delete(actionId).catch(() => undefined);
      return undefined;
    }
  }

  private uncertainReply(ctx: Ctx, ordId?: string): ExecOut {
    return this.reply(ctx, ["UNCERTAIN_RESULT"], ordId ? { ordId } : undefined);
  }

  private reply(ctx: Ctx, reasons: KuleReasonCode[], extra?: { reportTx?: `0x${string}`; ordId?: string; detail?: string }): ExecOut {
    const first = reasons[0]!;
    const verdict = verdictOfReason(first) === "BEKLET" ? "BEKLET" : "RET";
    const readback = reasons.map((r) => kuleReasonText(r)).join(" ");
    this.d.logger.log({
      tool: "kule_execute",
      event: "verdict",
      actionId: ctx.actionId,
      clOrdId: ctx.clOrdId,
      caller: ctx.caller,
      verdict,
      reasons,
      readback,
      checks: ctx.checks,
      ...(extra?.detail ? { detail: extra.detail } : {}),
      ...(extra?.reportTx ? { tx: extra.reportTx } : {}),
      paper: this.d.paper,
    });
    return {
      verdict,
      clOrdId: ctx.clOrdId,
      ...(extra?.ordId ? { ordId: extra.ordId } : {}),
      status: "NOT_PLACED",
      readback,
      reasons,
      ...(extra?.reportTx ? { reportTx: extra.reportTx } : {}),
      paper: this.d.paper,
    };
  }

  // ─────────────────────────────── yeniden başlatma / mutabakat ───────────────────────────────

  /**
   * §9.2-2: RESERVED/PLACED kalan her izin için clOrdId ile emir sorgulanır. Emir varsa izlenip raporlanır; yoksa
   * (PLACED: bekleme süresinden sonra) kayıt silinir. DONE ama raporlanmamış kayıtlar yeniden raporlanır.
   * Canlı çalışan izinlere dokunmaz.
   */
  async reconcile(): Promise<{ resolved: number; pending: number }> {
    if (this.reconciling) return { resolved: 0, pending: 0 };
    this.reconciling = true;
    let resolved = 0;
    let pending = 0;
    try {
      for (const rec of this.d.store.all()) {
        if (rec.state === "REPORTED") continue;
        if (this.inFlight.has(rec.actionId)) continue;
        this.inFlight.add(rec.actionId);
        try {
          const done = await this.reconcileOne(rec.actionId);
          if (done) resolved++;
          else pending++;
        } catch (e) {
          pending++;
          this.d.logger.log({ tool: "kule_reconcile", event: "error", actionId: rec.actionId, error: errText(e) });
        } finally {
          this.inFlight.delete(rec.actionId);
        }
      }
    } finally {
      this.reconciling = false;
    }
    return { resolved, pending };
  }

  private async reconcileOne(actionId: string): Promise<boolean> {
    const rec = this.d.store.get(actionId);
    if (!rec) return true;
    const ctx: Ctx = { actionId, clOrdId: rec.clOrdId, caller: "reconcile", checks: ["reconcile"], detail: [] };

    if (rec.state === "DONE") {
      if ((rec.reportFailures ?? 0) >= this.t.maxReportFailures) {
        await this.d.store.update(actionId, { uncertain: false }, this.nowMs());
        return true; // vazgeçildi; günlükte report_failed kayıtları var, elle bakılmalı
      }
      const tx = await this.tryReport(actionId);
      return tx !== undefined;
    }

    // RESERVED ya da PLACED
    if (rec.paper) {
      if (rec.state === "PLACED" && rec.pxE6 && rec.sz) {
        const info: OrderInfo = { ordId: `paper-${actionId}`, clOrdId: rec.clOrdId, state: "filled", sz: rec.sz, px: pxE6ToPx(rec.pxE6), accFillSz: rec.sz, avgPx: pxE6ToPx(rec.pxE6) };
        await this.settle(ctx, rec, info, false);
      } else {
        await this.d.store.delete(actionId);
      }
      return true;
    }

    let info: OrderInfo | null;
    try {
      info = await this.d.exchange.getOrder(rec.clOrdId);
    } catch (e) {
      this.d.logger.log({ tool: "kule_reconcile", event: "get_order_failed", actionId, error: errText(e) });
      return false; // belirsiz kalır (uncertain=true)
    }

    if (!info) {
      if (rec.state === "RESERVED") {
        await this.d.store.delete(actionId);
        this.d.logger.log({ tool: "kule_reconcile", event: "reserved_dropped", actionId });
        return true;
      }
      const since = rec.placedAtMs ?? rec.reservedAtMs;
      if (this.nowMs() - since >= this.t.uncertainGraceMs) {
        this.d.logger.log({ tool: "kule_reconcile", event: "no_order_found", actionId });
        await this.releaseUnplaced(actionId, "UNCERTAIN_RESULT");
        return true;
      }
      return false;
    }

    // Emir borsada var: ikinci emir açılmaz; izlenir ve raporlanır.
    const ordType: OrdType = rec.ordType ?? "post_only";
    const placedAt = rec.placedAtMs ?? rec.reservedAtMs;
    await this.d.store.update(actionId, { state: "PLACED", ordId: info.ordId }, this.nowMs());
    const fin = TERMINAL.has(info.state) ? { info, timedOut: false } : await this.awaitFinal(actionId, rec.clOrdId, ordType, placedAt);
    if (!fin) return false;
    const cur = this.d.store.get(actionId)!;
    await this.settle(ctx, cur, fin.info, fin.timedOut);
    return true;
  }

  /** Periyodik mutabakat (belirsiz ve raporlanmamış kayıtlar için). */
  startReconcileLoop(intervalMs = 30_000): void {
    if (this.reconcileTimer) return;
    this.reconcileTimer = setInterval(() => void this.reconcile(), intervalMs);
    this.reconcileTimer.unref?.();
  }
  stopReconcileLoop(): void {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
  }

  // ─────────────────────────────── kule_cancel ───────────────────────────────

  /**
   * Yalnız KULE'nin kendi "plt…" emirleri iptal edilir ve yalnız emri açan ajanın token'ıyla. `all: true` çağıran ajanın
   * emirleriyle sınırlıdır (başka ajanın emri iptal edilemez). TODO(spec): SPEC "tüm açık emirleri" diyor; çok ajanlı
   * yönde en dar seçim bu. İptal yeni emir değildir; sağlıktan bağımsızdır.
   */
  async cancel(binding: TokenBinding | null, input: KuleInput<"kule_cancel">): Promise<CancelOut> {
    const fail = (reason: KuleReasonCode): CancelOut => ({ ok: false, canceled: [], reasons: [reason] });
    if (!binding) return fail("AUTH");
    if (!binding.agent) return fail("WRONG_AGENT");
    const agentKey = binding.agent.toLowerCase();
    const canceled: string[] = [];

    const cancelOne = async (rec: ActionRecord): Promise<boolean> => {
      if (rec.paper || rec.state === "RESERVED" || rec.state === "DONE" || rec.state === "REPORTED") return true; // açık emir yok
      try {
        await this.d.exchange.cancelOrder(rec.clOrdId);
        canceled.push(rec.clOrdId);
        this.d.logger.log({ tool: "kule_cancel", actionId: rec.actionId, clOrdId: rec.clOrdId, caller: binding.label });
        return true;
      } catch (e) {
        this.d.logger.log({ tool: "kule_cancel", event: "failed", actionId: rec.actionId, error: errText(e) });
        return false;
      }
    };

    if ("actionId" in input) {
      const rec = this.d.store.get(input.actionId);
      if (!rec) return fail("NO_AUTHORIZATION");
      if (rec.agent !== agentKey) return fail("WRONG_AGENT");
      const ok = await cancelOne(rec);
      return { ok, canceled, reasons: ok ? [] : ["UNCERTAIN_RESULT"] };
    }

    let open: string[];
    try {
      open = await this.d.exchange.listOpenClOrdIds();
    } catch {
      return fail(healthReasonCode("DATA_STALE"));
    }
    let allOk = true;
    for (const clOrdId of open) {
      if (!/^plt[1-9]\d*$/.test(clOrdId)) continue; // yalnız KULE emirleri
      const rec = this.d.store.get(clOrdId.slice(3));
      if (!rec || rec.agent !== agentKey) continue;
      if (!(await cancelOne(rec))) allOk = false;
    }
    return { ok: allOk, canceled, reasons: allOk ? [] : ["UNCERTAIN_RESULT"] };
  }
}
