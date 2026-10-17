/**
 * Servis yapılandırması (Ek B, apps/servis/.env). Servis borsa anahtarı TUTMAZ (CLAUDE.md kural 6).
 * OKX_WEB3_* (Onchain OS) alanları yalnız gerçek x402 modu içindir; o mod henüz yok (TODO(spec), §21 #6), bu yüzden
 * burada okunmaz. Fail-closed: bozuk değer ConfigError; hata mesajında değer geçmez.
 */
import { AddressSchema, OkxDecimalSchema } from "@pilot/shared";
import type { PaymentConfig } from "./odeme.js";

export const SERVIS_HOST = "127.0.0.1"; // yalnız yerel; dışarıya Caddy üzerinden (§6.5)
export const SERVIS_DEFAULT_PORT = 8790;
export const DEFAULT_X402_PRICE = "0.01"; // §12 örneği: 0,01 USDG

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface ServisConfig {
  port: number;
  payment: PaymentConfig;
}

export function loadServisConfig(env: Record<string, string | undefined>): ServisConfig {
  const portRaw = env.SERVIS_PORT?.trim() || String(SERVIS_DEFAULT_PORT);
  const port = Number(portRaw);
  if (!/^\d{1,5}$/.test(portRaw) || port < 1 || port > 65535) throw new ConfigError("SERVIS_PORT geçersiz");

  // §12: varsayılan MOCK_OKX_FACILITATOR=true.
  const mockRaw = env.MOCK_OKX_FACILITATOR?.trim().toLowerCase() || "true";
  if (!["true", "1", "false", "0"].includes(mockRaw)) throw new ConfigError("MOCK_OKX_FACILITATOR true ya da false olmalı");
  const mock = mockRaw === "true" || mockRaw === "1";

  const price = env.X402_PRICE?.trim() || DEFAULT_X402_PRICE;
  if (!OkxDecimalSchema.safeParse(price).success || !/[1-9]/.test(price)) throw new ConfigError("X402_PRICE pozitif ondalık olmalı");

  const recipientRaw = env.PAYMENT_RECIPIENT?.trim() || "";
  if (recipientRaw && !AddressSchema.safeParse(recipientRaw).success) throw new ConfigError("PAYMENT_RECIPIENT geçerli bir adres değil");

  return { port, payment: { mock, price, recipient: recipientRaw || null } };
}
