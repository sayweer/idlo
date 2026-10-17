import { KuleStatusOutputSchema } from "@pilot/shared";
import type { z } from "zod";
import { feedMode } from "./mode";

/** kule_status çıktısı (shared şeması). Yalnız bu araç okunur; diğer kule_* araçları web'e açık değildir. */
export type KuleStatus = z.infer<typeof KuleStatusOutputSchema>;

/** KULE durum kaynağı. `origin: "mock"` iken ekranda TEMSİLİ VERİ rozeti zorunludur. */
export interface KuleStatusSource {
  readonly origin: "mock" | "http";
  /** Ağ ya da şema hatasında fırlatır: ekran "bilinmiyor" (gri) gösterir; NORMAL asla varsayılan değildir. */
  read(): Promise<KuleStatus>;
}

/** Mock: KÂĞIT modunda sağlıklı KULE (CAA etkin). */
export function createMockKuleStatus(): KuleStatusSource {
  return {
    origin: "mock",
    async read() {
      return KuleStatusOutputSchema.parse({
        health: "NORMAL",
        reasons: [],
        caa: { active: true, lastRenewAt: Date.now() - 12 * 60_000 },
        pilotHeartbeatAgeSec: 8,
        dataAgeSec: { ticker: 2, book: 3 },
        chain: { ok: true, block: 40_000_123 },
        mode: "paper",
      });
    },
  };
}

/** Gerçek: sunucu tarafı vekil GET /api/kule/status (PLANLI; MCP istemcisi yalnız kule_status çağırır, token sunucuda kalır). */
export function createHttpKuleStatus(url = "/api/kule/status"): KuleStatusSource {
  return {
    origin: "http",
    async read() {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`KULE durumu okunamadı (HTTP ${res.status})`);
      return KuleStatusOutputSchema.parse(await res.json());
    },
  };
}

export const kuleStatus: KuleStatusSource = feedMode === "http" ? createHttpKuleStatus() : createMockKuleStatus();
