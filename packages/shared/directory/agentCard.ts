/**
 * Ajan kartı (`agent.json`, SPEC §8.5) — dizin için GENEL şema. Kartı kaydeden herkes yazabilir, bu yüzden kart
 * güvenilmeyen veridir: yalnız biçimi doğrulanır, güvenlik kararı (kimlik, puan) karttan alınmaz.
 *
 * TODO(spec): scripts/lib/agentCard.ts PİLOT'a özel (name === "PİLOT", tek MCP hizmeti) ve pilot uygulamasından
 * içe aktarılamaz; bu şema aynı alanları GENEL biçimde (herhangi bir ad, birden çok hizmet) tanımlar. `type` sabiti
 * ve kayıt kimliği biçimi orada da var; iki yer aynı kalmalı (scripts testi ileride bu şemaya karşı doğrulayabilir).
 */
import { z } from "zod";
import { ERC8004_FUJI, FUJI_CHAIN_ID } from "../deployments.js";

/** EIP-8004 kayıt dosyası türü (scripts/lib/agentCard.ts AGENT_CARD_TYPE ile aynı). */
export const AGENT_CARD_TYPE_V1 = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";

/** `agentRegistry` değeri: "eip155:<zincir>:<Identity adresi>" (§8.5). */
export function agentRegistryId(chainId: number, identity: string): string {
  return `eip155:${chainId}:${identity}`;
}
export const FUJI_AGENT_REGISTRY_ID = agentRegistryId(FUJI_CHAIN_ID, ERC8004_FUJI.identity);

/** Kart alanı sınırları: LLM istemine ve arayüze giden metnin boyu sınırlı kalsın. */
export const AGENT_CARD_LIMITS = { name: 80, description: 1000, services: 10, registrations: 10 } as const;

/** https adresi (paket tarayıcıda da derlenir: URL sınıfı yok). Gerçek denetim getirirken yapılır (card.ts). */
const httpsUrl = z
  .string()
  .max(2048)
  .regex(/^https:\/\/[^\s/?#]+\S*$/, "https URL olmalı");

export const AgentCardSchema = z.object({
  type: z.literal(AGENT_CARD_TYPE_V1),
  name: z.string().trim().min(1).max(AGENT_CARD_LIMITS.name),
  description: z.string().trim().min(1).max(AGENT_CARD_LIMITS.description),
  image: httpsUrl.optional(),
  services: z
    .array(z.object({ name: z.string().trim().min(1).max(40), endpoint: httpsUrl }))
    .max(AGENT_CARD_LIMITS.services),
  active: z.boolean(),
  registrations: z
    .array(
      z.object({
        // JSON sayısı (EIP örneği); güvenli tamsayı aralığı dışı reddedilir.
        agentId: z.int().nonnegative(),
        agentRegistry: z.string().max(200),
      }),
    )
    .max(AGENT_CARD_LIMITS.registrations),
  supportedTrust: z.array(z.string().max(40)).max(10),
});
export type AgentCard = z.infer<typeof AgentCardSchema>;

/** Kart bu agentId'yi bu kayıtta (Identity) kendi kaydı olarak gösteriyor mu? Başka ajanın kartını kopyalamayı eler. */
export function cardClaimsAgent(card: AgentCard, agentId: string, registry: string): boolean {
  return card.registrations.some(
    (r) => String(r.agentId) === agentId && r.agentRegistry.toLowerCase() === registry.toLowerCase(),
  );
}
