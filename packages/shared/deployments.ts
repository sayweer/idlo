/** Adres okuyucu (§7): deployments/fuji.json şeması ve fail-closed ayrıştırıcı. Adresler Ek B. */
import { z } from "zod";
import { AddressSchema, Uint256StringSchema } from "./schemas/primitives.js";

export const FUJI_CHAIN_ID = 43113;

/** ERC-8004 resmî kayıtları, Fuji (Ek B, §8.5). */
export const ERC8004_FUJI = {
  identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
  validation: "0x8004Cb1BF31DAf7788923b405b754f57acEB4272",
} as const;

const fixedAddress = (expected: string) =>
  AddressSchema.refine((a) => a.toLowerCase() === expected.toLowerCase(), {
    message: `Ek B adresi olmalı: ${expected}`,
  });

/**
 * deployments/fuji.json (A2 Deploy.s.sol yazar, A3 agentId ekler).
 * TODO(spec): SPEC dosyanın alan adlarını vermiyor; en dar seçim: {chainId, flightPlan, erc8004{identity,
 * reputation, validation}, agentId?}. A2/A3 dosyayı yazınca alan adları buna göre kesinleştirilmeli.
 * ERC-8004 adresleri Ek B'dekinden farklıysa dosya reddedilir (fail-closed).
 */
export const DeploymentsSchema = z.object({
  chainId: z.literal(FUJI_CHAIN_ID),
  flightPlan: AddressSchema,
  erc8004: z.strictObject({
    identity: fixedAddress(ERC8004_FUJI.identity),
    reputation: fixedAddress(ERC8004_FUJI.reputation),
    validation: fixedAddress(ERC8004_FUJI.validation),
  }),
  agentId: Uint256StringSchema.optional(), // A3 register-agent.ts yazana kadar yok
});
export type Deployments = z.infer<typeof DeploymentsSchema>;

/**
 * Dosya içeriğini (metin) ayrıştırır; eksik/boş, bozuk JSON ya da şemaya uymayan içerikte hata fırlatır.
 * Dosyayı okuma işi çağırana bırakılır (Node: readFileSync(DEPLOYMENTS); web: fetch(NEXT_PUBLIC_DEPLOYMENTS_URL)),
 * böylece paket tarayıcıda da node:fs gerektirmez.
 */
export function parseDeployments(text: string | null | undefined): Deployments {
  if (text == null || text.trim() === "") throw new Error("deployments dosyası yok ya da boş");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("deployments dosyası geçerli JSON değil");
  }
  const r = DeploymentsSchema.safeParse(raw);
  if (!r.success) throw new Error(`deployments dosyası geçersiz: ${r.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ")}`);
  return r.data;
}
