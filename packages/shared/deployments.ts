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

const nonZero = (role: string) =>
  AddressSchema.refine((a) => BigInt(a) !== 0n, { message: `${role} sıfır adres olamaz` });

/**
 * deployments/fuji.json: contracts/script/Deploy.s.sol (A2) yazar, scripts/register-agent.ts (A3) agentId ekler.
 * Alanlar Deploy.s.sol _json() ile birebir; örnek: deployments/fuji.example.json.
 * - deployBlock: betiğin çalıştığı blok, işlemin girdiği bloktan küçük ya da eşit; olay taraması buradan başlar.
 * - pilotAgent / kuleReporter: Plan.agent / Plan.kule için PİLOT_AGENT ve KULE_REPORTER EOA adresleri (§6.1 #6).
 * TODO(spec): SPEC dosyanın alan adlarını vermiyor; adlar UI_HANDOFF §3.3 önerisiyle seçildi.
 * Fail-closed: yanlış zincir, sıfır adres, aynı cüzdana düşen roller ya da Ek B dışı ERC-8004 adresi reddedilir.
 */
export const DeploymentsSchema = z
  .object({
    chainId: z.literal(FUJI_CHAIN_ID),
    flightPlan: nonZero("flightPlan"),
    deployBlock: z.int().nonnegative(),
    deployer: nonZero("deployer"),
    pilotAgent: nonZero("pilotAgent"),
    kuleReporter: nonZero("kuleReporter"),
    erc8004: z.strictObject({
      identity: fixedAddress(ERC8004_FUJI.identity),
      reputation: fixedAddress(ERC8004_FUJI.reputation),
      validation: fixedAddress(ERC8004_FUJI.validation),
    }),
    agentId: Uint256StringSchema.optional(), // A3 register-agent.ts yazana kadar yok
  })
  .refine(
    (d) => new Set([d.deployer, d.pilotAgent, d.kuleReporter].map((a) => a.toLowerCase())).size === 3,
    { message: "deployer, pilotAgent ve kuleReporter ayrı cüzdanlar olmalı", path: ["pilotAgent"] },
  );
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
