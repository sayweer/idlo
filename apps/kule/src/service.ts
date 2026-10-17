/** Araç dağıtıcısı: §9.1'deki yedi araç, bunun dışında hiçbir şey yok. Girdi/çıktı doğrulaması server.ts'te. */
import { KULE_INSTRUMENTS, type KuleMode, type KuleToolName } from "@pilot/shared";
import type { CaaState } from "./caa.js";
import type { TokenBinding } from "./config.js";
import type { Exchange } from "./exchange.js";
import type { Executor } from "./executor.js";
import type { HealthMonitor, HeartbeatBook } from "./health.js";
import type { InstrumentCache } from "./instruments.js";
import { buildQuote } from "./quote.js";
import type { KuleInput, KuleOutput } from "./types.js";
import { truncDecimal, type Clock } from "./util.js";

export interface ServiceDeps {
  executor: Executor;
  health: HealthMonitor;
  exchange: Exchange;
  instruments: InstrumentCache;
  clock: Clock;
  heartbeats: HeartbeatBook;
  mode: KuleMode;
  caa: CaaState | null;
}

export class KuleService {
  constructor(private readonly d: ServiceDeps) {}

  async call(name: KuleToolName, input: unknown, binding: TokenBinding): Promise<unknown> {
    switch (name) {
      case "kule_status":
        return this.status();
      case "kule_heartbeat":
        return { ok: this.d.heartbeats.beat(binding.label) };
      case "kule_market":
        return this.market(input as KuleInput<"kule_market">);
      case "kule_balance":
        return this.balance();
      case "kule_quote":
        return buildQuote(input as KuleInput<"kule_quote">, { exchange: this.d.exchange, instruments: this.d.instruments, clock: this.d.clock });
      case "kule_execute":
        return this.d.executor.execute(binding, (input as KuleInput<"kule_execute">).actionId);
      case "kule_cancel":
        return this.d.executor.cancel(binding, input as KuleInput<"kule_cancel">);
    }
  }

  private async status(): Promise<KuleOutput<"kule_status">> {
    const h = await this.d.health.check({ includeCaa: true });
    const num = (v: number | null) => (v === null ? null : Math.max(0, Number(v.toFixed(3))));
    return {
      health: h.state,
      reasons: h.reasonCodes,
      caa: { active: this.d.caa?.isActive() ?? false, lastRenewAt: this.d.caa?.lastRenewAt() ?? null },
      pilotHeartbeatAgeSec: num(h.heartbeatAgeSec),
      dataAgeSec: { ticker: num(h.dataAgeSec.ticker), book: num(h.dataAgeSec.book) },
      chain: h.chain,
      mode: this.d.mode,
    };
  }

  /**
   * ATK yanıtı olduğu gibi (§9.1 "yalnız okuma"). MCP structuredContent nesne olmak zorunda; veri `data` altında.
   * TODO(spec): mumlar ATK `data` dizisi (OKX satır dizileri) olarak döner.
   */
  private async market(i: KuleInput<"kule_market">): Promise<unknown> {
    if (!(KULE_INSTRUMENTS as readonly string[]).includes(i.instId)) throw new Error("izinsiz enstrüman"); // U-1 (şema da engeller)
    switch (i.kind) {
      case "ticker":
        return { instId: i.instId, kind: i.kind, data: await this.d.exchange.getTicker(i.instId) };
      case "orderbook":
        return { instId: i.instId, kind: i.kind, data: await this.d.exchange.getBook(i.instId, 20) };
      case "candles":
        return { instId: i.instId, kind: i.kind, bar: i.bar, data: await this.d.exchange.getCandles(i.instId, i.bar!, i.limit, i.after) };
    }
  }

  private async balance(): Promise<KuleOutput<"kule_balance">> {
    const b = await this.d.exchange.getBalance();
    const dec = (s: string) => truncDecimal(s, 18);
    const entry = (e: { trading: string; funding: string | null }) => ({ trading: dec(e.trading), funding: e.funding === null ? null : dec(e.funding) });
    return { TRY: entry(b.TRY), USDT: entry(b.USDT) };
  }
}
