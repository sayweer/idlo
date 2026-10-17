/**
 * İki servisin çekirdeği (SPEC §12); HTTP (A2MCP) ve MCP aracı aynı fonksiyonları çağırır.
 */
import { DATA_DISCLAIMER, TRADE_INST_ID, WeatherError, type UnixMs } from "@pilot/shared";
import { denetle, type EmirDenetimiInput, type EmirDenetimiOutput } from "./emirDenetimi.js";
import type { WeatherProvider } from "./liraHavaDurumu.js";
import { INSTRUMENTS_PATH, OKX_PUBLIC_BASE, OkxPublicError, type OkxPublic } from "./okxPublic.js";
import {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  checkPayment,
  encodeHeader,
  odemeEtiketi,
  paymentRequirement,
  type PaymentConfig,
} from "./odeme.js";

export interface ServisDeps {
  okx: OkxPublic;
  weather: WeatherProvider;
  payment: PaymentConfig;
  now: () => UnixMs;
}

export const EMIR_KAYNAK = `OKX TR herkese açık enstrüman verisi (${OKX_PUBLIC_BASE}${INSTRUMENTS_PATH})`;
export const HAVA_KAYNAK = `OKX TR herkese açık mumlar (${OKX_PUBLIC_BASE}: USDT-TRY 5m ve 1H, BTC-USDT 5m)`;

export async function emirDenetimi(deps: ServisDeps, input: EmirDenetimiInput): Promise<EmirDenetimiOutput> {
  const meta = { nowMs: deps.now(), kaynak: EMIR_KAYNAK };
  // Enstrüman ve yön kontrolü veri gerektirmez; yalnız denetlenecek emir için borsa bilgisi okunur.
  if (input.instId !== TRADE_INST_ID || input.side !== "buy") return denetle(input, null, meta);
  try {
    return denetle(input, await deps.okx.instrument(input.instId), meta);
  } catch (e) {
    if (e instanceof OkxPublicError) return denetle(input, null, meta);
    throw e;
  }
}

export const HAVA_VERI_HATASI = "Piyasa verisi alınamadı ya da bayat; sınıf hesaplanmadı.";
export const HAVA_IC_HATA = "Hava durumu hesaplanamadı (iç hata).";

export interface LiraResult {
  status: 200 | 402 | 502 | 503;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Lira Hava Durumu: önce ödeme (402 akışı), sonra veri. Ödeme yoksa hesap yapılmaz. */
export async function liraHavaDurumu(deps: ServisDeps, paymentHeader: string | undefined, resource: string): Promise<LiraResult> {
  const pay = checkPayment(deps.payment, paymentHeader);
  if (!pay.ok) {
    if (pay.status === 503) return { status: 503, headers: {}, body: { hata: pay.error, uyari: DATA_DISCLAIMER } };
    const req = paymentRequirement(deps.payment, resource);
    return {
      status: 402,
      headers: { [PAYMENT_REQUIRED_HEADER]: encodeHeader(req) },
      body: { hata: pay.error, odemeGerekli: req, odeme: odemeEtiketi() },
    };
  }
  try {
    const w = await deps.weather.current();
    return {
      status: 200,
      headers: { [PAYMENT_RESPONSE_HEADER]: encodeHeader(pay.response) },
      body: { ...w, kaynak: HAVA_KAYNAK, zaman: deps.now(), uyari: DATA_DISCLAIMER, odeme: odemeEtiketi() },
    };
  } catch (e) {
    // Veri yoksa sınıf uydurulmaz (fail-closed); ödeme yanıtı da dönmez. Ayrıntı yalnız yerel günlüğe gider (anahtar yok).
    const known = e instanceof WeatherError || e instanceof OkxPublicError;
    console.error(`[servis] lira_hava_durumu: ${known ? (e as Error).message : String(e)}`);
    return { status: 502, headers: {}, body: { hata: known ? HAVA_VERI_HATASI : HAVA_IC_HATA, uyari: DATA_DISCLAIMER } };
  }
}
