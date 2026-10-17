/**
 * x402 ödeme akışı — TEMSİLİ (SPEC §12, §19 "TEMSİLİ" etiketi, CLAUDE.md kural 12).
 * 1) Ödeme yoksa 402 + `PAYMENT-REQUIRED` (base64 JSON). 2) İstemci `PAYMENT-SIGNATURE` ile tekrar dener.
 * 3) Sunucu doğrular ve `PAYMENT-RESPONSE` ile veriyi döner.
 *
 * Yalnız MOCK_OKX_FACILITATOR=true modu var: zincirde ödeme yoktur, temsili kanıt kabul edilir ve her yanıt
 * "TEMSİLİ ÖDEME" diye etiketlenir. Servis hiçbir anahtar tutmaz (CLAUDE.md kural 6).
 * TODO(spec): gerçek x402 modu (kolaylaştırıcı https://web3.okx.com/api/v6/x402, X Layer 196, USDG, Onchain OS
 * anahtarları) `[DOĞRULA]` (§21 #6). Paket ve başlık ayrıntıları doğrulanana kadar gerçek modda ücretli uç nokta
 * ödeme İSTEMEZ ve veri VERMEZ (503): doğrulayamadığımız bir ödemeyi talep etmek kullanıcıyı zarara sokar.
 */
import { z } from "zod";
import { DEMO_LABELS } from "@pilot/shared";

export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
export const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";
export const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";

/** Ek B: X Layer (chainId 196), USDG. `[DOĞRULA]` ağ adı biçimi (CAIP-2) resmî belgeden alınmalı. */
export const X402_NETWORK = "eip155:196";
export const X402_ASSET = "USDG";

/** §12 hukuk notu ve §20 TCMB sorusu (hukuki görüş değil). */
export const HUKUK_NOTU =
  "Ücretli erişim yurt dışındaki ajanlara açıktır; Türkiye'deki kullanıcı için ücretsizdir. Hukuki görüş değildir.";

export interface PaymentConfig {
  mock: boolean;
  /** Çağrı başı ücret (USDG, ondalık string). */
  price: string;
  /** Ödemeyi alacak adres; temsili modda boş olabilir. */
  recipient: string | null;
}

export const MOCK_LABEL = DEMO_LABELS.mockFacilitator; // "TEMSİLİ ÖDEME"

/** Yanıtlardaki ödeme etiketi (ekranda açıkça görünür). */
export function odemeEtiketi(): { mod: "TEMSİLİ"; etiket: string; zincirdeOdeme: false } {
  return { mod: "TEMSİLİ", etiket: MOCK_LABEL, zincirdeOdeme: false };
}

export function encodeHeader(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

export function decodeHeader(value: string): unknown {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error("base64 değil");
  return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
}

/** 402 yanıtının `PAYMENT-REQUIRED` içeriği. Biçim temsilidir; `[DOĞRULA]` x402 sürüm ve alan adları. */
export function paymentRequirement(cfg: PaymentConfig, resource: string) {
  return {
    x402Version: 2,
    resource: { url: resource, description: "Lira Hava Durumu (USDT-TRY fırtına sınıfı), çağrı başına", mimeType: "application/json" },
    accepts: [
      {
        scheme: "exact",
        network: X402_NETWORK,
        asset: X402_ASSET,
        amount: cfg.price,
        payTo: cfg.recipient,
      },
    ],
    temsili: true,
    etiket: MOCK_LABEL,
    hukukNotu: HUKUK_NOTU,
  };
}

/** Temsili ödeme kanıtı: base64 JSON, `mock: true`. Zincirde karşılığı yoktur. */
const MockProofSchema = z.looseObject({ mock: z.literal(true) });

/** Demo istemcileri ve testler için temsili kanıt üretir. */
export function mockPaymentProof(): string {
  return encodeHeader({ x402Version: 2, scheme: "exact", network: X402_NETWORK, mock: true });
}

export type PaymentCheck =
  | { ok: true; response: Record<string, unknown> }
  | { ok: false; status: 402 | 503; error: string };

/** `PAYMENT-SIGNATURE` başlığını doğrular. Gerçek modda hiçbir kanıt kabul edilmez (fail-closed). */
export function checkPayment(cfg: PaymentConfig, header: string | undefined): PaymentCheck {
  if (!cfg.mock) return { ok: false, status: 503, error: "Gerçek x402 ödeme modu henüz etkin değil; ücretli servis kapalı." };
  if (header === undefined || header === "") return { ok: false, status: 402, error: "Ödeme gerekli." };
  let proof: unknown;
  try {
    proof = decodeHeader(header);
  } catch {
    return { ok: false, status: 402, error: "Ödeme kanıtı okunamadı (base64 JSON olmalı)." };
  }
  if (!MockProofSchema.safeParse(proof).success) {
    return { ok: false, status: 402, error: "Bu modda yalnız temsili ödeme kanıtı kabul edilir; gerçek ödeme doğrulanmaz." };
  }
  return {
    ok: true,
    response: { success: true, network: X402_NETWORK, transaction: null, temsili: true, etiket: MOCK_LABEL },
  };
}
