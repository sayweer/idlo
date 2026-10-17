/**
 * İtibar okuma: `getSummary(agentId, verifiedClients, "", "")`. Yalnız doğrulanmış kullanıcıların puanı sayılır
 * (verified.ts). Liste boşsa kontrat "clientAddresses required" ile revert eder; bu yüzden çağrılmaz, sayı 0'dır.
 *
 * Puan: `value / 10^decimals` (örnek: 9500, 2 → 95). Beklenmeyen biçim (decimals > 18, sayı taşması) puanı
 * okunamaz sayar ve aday elenir; sessizce yuvarlanmaz.
 */
import type { Address } from "viem";
import type { DirectoryChain } from "./chain.js";

export const MAX_DECIMALS = 18;

export interface ReputationReading {
  feedbackCount: number;
  /** Geri bildirim yoksa null. */
  score: number | null;
}

export async function readReputation(
  chain: DirectoryChain,
  agentId: bigint,
  verifiedClients: readonly Address[],
): Promise<ReputationReading> {
  if (verifiedClients.length === 0) return { feedbackCount: 0, score: null };
  const s = await chain.reputationSummary(agentId, verifiedClients);
  if (s.count > BigInt(Number.MAX_SAFE_INTEGER) || s.count < 0n) throw new RangeError("geri bildirim sayısı aralık dışı");
  if (!Number.isInteger(s.decimals) || s.decimals < 0 || s.decimals > MAX_DECIMALS) throw new RangeError("puan ondalığı aralık dışı");
  const feedbackCount = Number(s.count);
  if (feedbackCount === 0) return { feedbackCount: 0, score: null };
  const score = Number(s.value) / 10 ** s.decimals;
  if (!Number.isFinite(score)) throw new RangeError("puan sayıya çevrilemedi");
  return { feedbackCount, score };
}
