/**
 * Enstrüman parametreleri (§9.2-9): tickSz / lotSz / minSz, herkese açık
 *   GET https://tr.okx.com/api/v5/public/instruments?instType=SPOT&instId=USDT-TRY
 * Önbellek 1 saat. Yenileme başarısız olursa eldeki (eski) değer kullanılır: tickSz/lotSz çok nadir değişir ve yanlış
 * değeri borsa zaten reddeder. Hiç değer yoksa hata (fail-closed).
 */
import { TRADE_INST_ID, decimalToScaled, hoursToMs } from "@pilot/shared";
import type { Clock } from "./util.js";

export interface InstrumentParams {
  tickSz: string;
  lotSz: string;
  minSz: string;
}

export const OKX_PUBLIC_BASE = "https://tr.okx.com";
export const INSTRUMENTS_TTL_MS = hoursToMs(1);

const DEC = /^(0|[1-9]\d*)(\.\d+)?$/;

export function parseInstrumentResponse(body: unknown): InstrumentParams {
  const b = body as { code?: unknown; data?: unknown } | null;
  if (!b || b.code !== "0" || !Array.isArray(b.data) || b.data.length < 1) throw new Error("instruments yanıtı geçersiz");
  const row = b.data[0] as Record<string, unknown>;
  if (row.instId !== TRADE_INST_ID || row.instType !== "SPOT") throw new Error("instruments yanıtı başka enstrüman");
  const p = { tickSz: row.tickSz, lotSz: row.lotSz, minSz: row.minSz };
  for (const [k, v] of Object.entries(p)) {
    if (typeof v !== "string" || !DEC.test(v)) throw new Error(`instruments ${k} geçersiz`);
    if (decimalToScaled(v, 18) === 0n) throw new Error(`instruments ${k} sıfır`);
  }
  return p as InstrumentParams;
}

export class InstrumentCache {
  private cached: { at: number; params: InstrumentParams } | null = null;
  private inflight: Promise<InstrumentParams> | null = null;

  constructor(
    private readonly clock: Clock,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly base: string = OKX_PUBLIC_BASE,
  ) {}

  async get(): Promise<InstrumentParams> {
    const now = this.clock.nowMs();
    if (this.cached && now - this.cached.at < INSTRUMENTS_TTL_MS) return this.cached.params;
    this.inflight ??= this.refresh().finally(() => {
      this.inflight = null;
    });
    try {
      return await this.inflight;
    } catch (e) {
      if (this.cached) return this.cached.params;
      throw e;
    }
  }

  private async refresh(): Promise<InstrumentParams> {
    const url = `${this.base}/api/v5/public/instruments?instType=SPOT&instId=${TRADE_INST_ID}`;
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`instruments HTTP ${res.status}`);
    const params = parseInstrumentResponse(await res.json());
    this.cached = { at: this.clock.nowMs(), params };
    return params;
  }
}
