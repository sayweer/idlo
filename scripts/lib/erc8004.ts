/**
 * ERC-8004 Fuji kayıtları için en küçük ABI (SPEC §8.5, §21 #5, Ek B). Saf modül: node:fs/ağ yok, web de içe aktarabilir.
 *
 * Doğrulanmış (§21 #5, Bekir abi): kontratlarda `register` ve `giveFeedback` var. İmzalar §8.5'ten.
 * `[DOĞRULA]`: olaylar (Registered, Transfer) SPEC'te yok; EIP-8004 ve ERC-721 imzalarından alındı.
 * Bu yüzden agentId iki olaydan da okunur ve ikisi aynı kimliği göstermezse kayıt reddedilir (fail-closed).
 */
import { decodeEventLog, isAddressEqual, zeroAddress, type Address, type Hex } from "viem";

/** Identity `0x8004A818…` — yalnız `register(string)` ve kimlik olayları. */
export const identityRegistryAbi = [
  {
    // §8.5: register(string agentURI) returns (uint256 agentId). Kontratta aşırı yüklemeler olabilir; yalnız bu kullanılır.
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [{ name: "agentURI", type: "string" }],
    outputs: [{ name: "agentId", type: "uint256" }],
  },
  {
    // [DOĞRULA] EIP-8004: event Registered(uint256 indexed agentId, string agentURI, address indexed owner)
    type: "event",
    name: "Registered",
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "agentURI", type: "string", indexed: false },
      { name: "owner", type: "address", indexed: true },
    ],
  },
  {
    // [DOĞRULA] ERC-721 basımı: Transfer(0x0 → sahip, agentId). Identity kaydı ERC-721 tabanlıdır (EIP-8004).
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
    ],
  },
] as const;

/** Reputation `0x8004B663…` — yalnız `giveFeedback` (§8.5; opsiyonel "PİLOT'u puanla", UI_HANDOFF §2.5). */
export const reputationRegistryAbi = [
  {
    type: "function",
    name: "giveFeedback",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "value", type: "int128" },
      { name: "valueDecimals", type: "uint8" },
      { name: "tag1", type: "string" }, // "cycle"
      { name: "tag2", type: "string" }, // "YYYYMM"
      { name: "endpoint", type: "string" },
      { name: "feedbackURI", type: "string" },
      { name: "feedbackHash", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

export interface RegistryLog {
  address: Address;
  topics: readonly Hex[] | [Hex, ...Hex[]] | [];
  data: Hex;
}

/**
 * İşlem makbuzunun günlüklerinden yeni agentId'yi çıkarır.
 * Yalnız `registry` adresinin yaydığı ve `owner`'a ait olaylar sayılır:
 * `Registered(id, _, owner)` ve `Transfer(0x0, owner, id)`. Hiç olay yoksa ya da iki farklı kimlik çıkarsa hata atar.
 */
export function extractAgentId(logs: readonly RegistryLog[], registry: Address, owner: Address): bigint {
  const ids = new Set<bigint>();
  for (const log of logs) {
    if (!isAddressEqual(log.address, registry)) continue;
    let ev;
    try {
      ev = decodeEventLog({ abi: identityRegistryAbi, topics: log.topics as [Hex, ...Hex[]], data: log.data, strict: true });
    } catch {
      continue; // başka olay (ör. MetadataSet) ya da farklı indeksli Transfer
    }
    if (ev.eventName === "Registered" && isAddressEqual(ev.args.owner, owner)) ids.add(ev.args.agentId);
    if (ev.eventName === "Transfer" && isAddressEqual(ev.args.from, zeroAddress) && isAddressEqual(ev.args.to, owner)) {
      ids.add(ev.args.tokenId);
    }
  }
  if (ids.size === 0) throw new Error("kayıt olayı bulunamadı (Registered/Transfer yok) [DOĞRULA: Identity ABI]");
  if (ids.size > 1) throw new Error(`kayıt olayları farklı agentId gösteriyor: ${[...ids].join(", ")}`);
  return [...ids][0]!;
}
