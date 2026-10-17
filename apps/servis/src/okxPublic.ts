/**
 * OKX TR herkese açık piyasa verisi (SPEC §11 girdileri, §9.2-9 enstrüman bilgisi). ANAHTARSIZ: imza, başlık ya da
 * hesap çağrısı yoktur (CLAUDE.md kural 6). Yanıtlar zod ile doğrulanır; bozuk yanıt OkxPublicError fırlatır (fail-closed).
 */
import { z } from "zod";
import { OkxDecimalSchema, candleFromOkx, hoursToMs, type Candle, type UnixMs } from "@pilot/shared";

export const OKX_PUBLIC_BASE = "https://tr.okx.com"; // Ek B: OKX TR API tabanı
export const CANDLES_PATH = "/api/v5/market/candles";
export const INSTRUMENTS_PATH = "/api/v5/public/instruments";
/** `market/candles` tek istekte en fazla 300 mum döner (OKX belgesi). */
export const CANDLE_LIMIT_MAX = 300;
/** §9.2-9: tickSz / lotSz / minSz önbelleği 1 saat. */
export const INSTRUMENT_CACHE_MS = hoursToMs(1);
const REQUEST_TIMEOUT_MS = 10_000;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class OkxPublicError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OkxPublicError";
  }
}

const EnvelopeSchema = z.object({ code: z.string(), msg: z.string().optional(), data: z.unknown() });
/** [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm] — confirm "1" = mum kapandı. */
const CandleRowSchema = z.array(z.string()).min(9);
const InstrumentSchema = z.object({
  instId: z.string(),
  tickSz: OkxDecimalSchema,
  lotSz: OkxDecimalSchema,
  minSz: OkxDecimalSchema,
  state: z.string(),
});

export interface InstrumentSpec {
  instId: string;
  tickSz: string;
  lotSz: string;
  minSz: string;
  state: string;
}

export type CandleBar = "5m" | "1H";

export interface OkxPublic {
  /** Kapanmış mumlar, artan sırada (açılış zamanı ts). */
  candles(instId: string, bar: CandleBar, limit: number): Promise<Candle[]>;
  /** SPOT enstrüman bilgisi (1 sa önbellekli). */
  instrument(instId: string): Promise<InstrumentSpec>;
}

export function createOkxPublic(deps: { fetch: FetchLike; now: () => UnixMs; base?: string }): OkxPublic {
  const base = deps.base ?? OKX_PUBLIC_BASE;
  const cache = new Map<string, { at: UnixMs; spec: InstrumentSpec }>();

  async function get(path: string, query: Record<string, string>): Promise<unknown> {
    const url = `${base}${path}?${new URLSearchParams(query).toString()}`;
    let res: Response;
    try {
      res = await deps.fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (e) {
      throw new OkxPublicError(`OKX'e ulaşılamadı: ${(e as Error).message}`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new OkxPublicError(`OKX yanıtı JSON değil (HTTP ${res.status})`);
    }
    const env = EnvelopeSchema.safeParse(body);
    if (!res.ok || !env.success || env.data.code !== "0") {
      throw new OkxPublicError(`OKX hatası: HTTP ${res.status} code=${env.success ? env.data.code : "?"}`);
    }
    return env.data.data;
  }

  return {
    async candles(instId, bar, limit) {
      if (!Number.isInteger(limit) || limit < 1 || limit > CANDLE_LIMIT_MAX) throw new OkxPublicError(`geçersiz limit: ${limit}`);
      const data = await get(CANDLES_PATH, { instId, bar, limit: String(limit) });
      const rows = z.array(CandleRowSchema).safeParse(data);
      if (!rows.success) throw new OkxPublicError(`${instId} ${bar}: mum yanıtı bozuk`);
      // OKX yeniden eskiye döner; yalnız kapanmış mumlar alınır, artan sıraya çevrilir.
      const closed = rows.data.filter((r) => r[8] === "1").reverse();
      try {
        return closed.map(candleFromOkx);
      } catch (e) {
        throw new OkxPublicError(`${instId} ${bar}: ${(e as Error).message}`);
      }
    },

    async instrument(instId) {
      const hit = cache.get(instId);
      const now = deps.now();
      if (hit && now - hit.at < INSTRUMENT_CACHE_MS && now >= hit.at) return hit.spec;
      const data = await get(INSTRUMENTS_PATH, { instType: "SPOT", instId });
      const list = z.array(InstrumentSchema).safeParse(data);
      if (!list.success) throw new OkxPublicError(`${instId}: enstrüman yanıtı bozuk`);
      const found = list.data.find((i) => i.instId === instId);
      if (!found) throw new OkxPublicError(`${instId}: enstrüman bulunamadı`);
      const spec: InstrumentSpec = {
        instId: found.instId,
        tickSz: found.tickSz,
        lotSz: found.lotSz,
        minSz: found.minSz,
        state: found.state,
      };
      cache.set(instId, { at: now, spec });
      return spec;
    },
  };
}
