/**
 * Sağlık (§9.3): NORMAL / YENİ_EMİR_YOK / YETKİ_YOK.
 *  - YENİ_EMİR_YOK: veri bayat (>5 sn); PİLOT kalp atışı >45 sn; zincir okunamıyor; emir sonucu belirsiz;
 *    (TODO(spec)) CAA yenilenemiyor.
 *  - YETKİ_YOK: kullanıcının planı iptal ya da süresi bitmiş.
 * Kalp atışı: ajana bağlı token'lar tek tek tutulur. Genel (status/CAA) için en tazesi, kule_execute için çağıranın
 * kendi kalp atışı kullanılır. Hiç kalp atışı gelmediyse (null) fail-closed: PILOT_HEARTBEAT.
 */
import type { Address } from "viem";
import { elapsedSec, healthReasonCode, type HealthReasonName, type HealthState, type KuleReasonCode } from "@pilot/shared";
import type { KuleChain } from "./chain.js";
import type { CaaState } from "./caa.js";
import type { Book, Exchange, Ticker } from "./exchange.js";
import type { ActionStore } from "./store.js";
import type { Clock } from "./util.js";

export const MAX_DATA_AGE_SEC = 5;
export const MAX_HEARTBEAT_AGE_SEC = 45;
export const MAX_SPREAD_BPS = 30;

export class HeartbeatBook {
  private readonly last = new Map<string, number>();
  constructor(
    private readonly clock: Clock,
    private readonly labels: readonly string[],
  ) {}

  beat(label: string): boolean {
    if (!this.labels.includes(label)) return false;
    this.last.set(label, this.clock.nowMs());
    return true;
  }
  ageSec(label: string): number | null {
    const t = this.last.get(label);
    return t === undefined ? null : elapsedSec(t, this.clock.nowMs());
  }
  /** Ajana bağlı token'ların en taze kalp atışı yaşı. */
  minAgeSec(): number | null {
    let best: number | null = null;
    for (const l of this.labels) {
      const a = this.ageSec(l);
      if (a !== null && (best === null || a < best)) best = a;
    }
    return best;
  }
}

export interface HealthSnapshot {
  state: HealthState;
  reasons: HealthReasonName[];
  reasonCodes: KuleReasonCode[];
  heartbeatAgeSec: number | null;
  /** null = okunamadı. */
  dataAgeSec: { ticker: number | null; book: number | null };
  chain: { ok: boolean; block: number | null };
  market: { ticker: Ticker; book: Book } | null;
  planActive: boolean | null;
}

export interface HealthCheckOptions {
  /** Kalp atışı için çağıranın token adı; yoksa genel (en taze). */
  callerLabel?: string | null;
  /** CAA_INACTIVE gerekçesini hesaba kat (CAA döngüsünün kendisi için false). */
  includeCaa?: boolean;
}

export interface HealthDeps {
  clock: Clock;
  exchange: Exchange;
  chain: KuleChain;
  store: ActionStore;
  heartbeats: HeartbeatBook;
  planUser: Address;
  /** okx modunda CAA durumu; paper modunda null (CAA yok). */
  caa: CaaState | null;
}

const PRIORITY: HealthReasonName[] = ["CHAIN_UNREADABLE", "ORDER_UNCERTAIN", "PILOT_HEARTBEAT", "DATA_STALE", "CAA_INACTIVE", "PLAN_INACTIVE"];

export class HealthMonitor {
  constructor(private readonly d: HealthDeps) {}

  async check(o: HealthCheckOptions = {}): Promise<HealthSnapshot> {
    const reasons = new Set<HealthReasonName>();
    const nowMs = this.d.clock.nowMs();

    const [chainRes, planRes, ticker, book] = await Promise.all([
      this.d.chain.blockNumber().then(
        (block) => ({ ok: true as const, block }),
        () => ({ ok: false as const, block: null }),
      ),
      this.d.chain.isPlanActive(this.d.planUser).then(
        (active) => ({ ok: true as const, active }),
        () => ({ ok: false as const, active: null }),
      ),
      this.d.exchange.getTicker("USDT-TRY").then(
        (t) => t,
        () => null,
      ),
      this.d.exchange.getBook("USDT-TRY", 5).then(
        (b) => b,
        () => null,
      ),
    ]);

    const chainOk = chainRes.ok && planRes.ok;
    if (!chainOk) reasons.add("CHAIN_UNREADABLE");
    else if (planRes.active === false) reasons.add("PLAN_INACTIVE");

    const age = (ts: number | undefined): number | null => (ts === undefined ? null : Math.max(0, (nowMs - ts) / 1000));
    const tickerAge = age(ticker?.ts);
    const bookAge = age(book?.ts);
    if (tickerAge === null || bookAge === null || tickerAge > MAX_DATA_AGE_SEC || bookAge > MAX_DATA_AGE_SEC) reasons.add("DATA_STALE");

    const hb = o.callerLabel ? this.d.heartbeats.ageSec(o.callerLabel) : this.d.heartbeats.minAgeSec();
    if (hb === null || hb > MAX_HEARTBEAT_AGE_SEC) reasons.add("PILOT_HEARTBEAT");

    if (this.d.store.anyUncertain()) reasons.add("ORDER_UNCERTAIN");

    if (o.includeCaa !== false && this.d.caa !== null && !this.d.caa.isActive()) reasons.add("CAA_INACTIVE");

    const ordered = PRIORITY.filter((r) => reasons.has(r));
    const state: HealthState = reasons.has("PLAN_INACTIVE") ? "YETKİ_YOK" : ordered.length > 0 ? "YENİ_EMİR_YOK" : "NORMAL";
    return {
      state,
      reasons: ordered,
      reasonCodes: ordered.map(healthReasonCode),
      heartbeatAgeSec: o.callerLabel ? hb : this.d.heartbeats.minAgeSec(),
      dataAgeSec: { ticker: tickerAge, book: bookAge },
      chain: { ok: chainOk, block: chainRes.block },
      market: ticker && book ? { ticker, book } : null,
      planActive: planRes.active,
    };
  }

  /** CAA döngüsü için: CAA gerekçesi hariç NORMAL mi? */
  async isNormalForCaa(): Promise<boolean> {
    const s = await this.check({ includeCaa: false });
    return s.state === "NORMAL";
  }
}
