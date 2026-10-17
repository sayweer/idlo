/**
 * İtibar okuma: `getSummary(agentId, verifiedClients, "", "")`. Yalnız doğrulanmış kullanıcıların puanı sayılır
 * (verified.ts). Liste boşsa kontrat "clientAddresses required" ile revert eder; bu yüzden çağrılmaz, sayı 0'dır.
 *
 * Puan: `value / 10^decimals` (örnek: 9500, 2 → 95). Beklenmeyen biçim (decimals > 18, sayı taşması, 0–100 dışı
 * puan) puanı okunamaz sayar ve aday elenir; sessizce yuvarlanmaz ya da kırpılmaz.
 *
 * `feedbackCount` geri bildirim ADEDİdir (getSummary.count). Müşteri çeşitliliği ayrıca `feedbackClients` ile
 * ölçülür: her doğrulanmış kullanıcı için tek istemcili `getSummary` (count > 0 ise o kullanıcı geri bildirim
 * vermiştir). Üst sınır MAX_CLIENT_PROBES; sınır aşılırsa sayı alt sınırdır (fail-closed yönde).
 *
 * TODO(spec): ERC-8004 özeti ortalamadır; doğrulanmış tek bir müşteri 0–100 içinde uç bir puan verip ortalamayı
 * kaydırabilir. Müşteri başına ağırlık sınırı için Reputation `readAllFeedback` gerekir (port'ta yok).
 */
import { SCORE_MAX, SCORE_MIN } from "@pilot/shared";
import type { Address } from "viem";
import type { DirectoryChain } from "./chain.js";

export const MAX_DECIMALS = 18;
/** Farklı geri bildirim veren müşteri sayımı için en çok tek-istemcili getSummary çağrısı. */
export const MAX_CLIENT_PROBES = 50;
const PROBE_CONCURRENCY = 8;

export interface ReputationReading {
  /** Geri bildirim adedi (müşteri sayısı değil). */
  feedbackCount: number;
  /** Geri bildirim vermiş farklı doğrulanmış müşteri sayısı (alt sınır). */
  feedbackClients: number;
  /** Geri bildirim yoksa null. */
  score: number | null;
}

/** Sınırlı eşzamanlılıkla sırayla işler; ilk hatada fırlatır. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function readReputation(
  chain: DirectoryChain,
  agentId: bigint,
  verifiedClients: readonly Address[],
): Promise<ReputationReading> {
  if (verifiedClients.length === 0) return { feedbackCount: 0, feedbackClients: 0, score: null };
  const s = await chain.reputationSummary(agentId, verifiedClients);
  if (s.count > BigInt(Number.MAX_SAFE_INTEGER) || s.count < 0n) throw new RangeError("geri bildirim sayısı aralık dışı");
  if (!Number.isInteger(s.decimals) || s.decimals < 0 || s.decimals > MAX_DECIMALS) throw new RangeError("puan ondalığı aralık dışı");
  const feedbackCount = Number(s.count);
  if (feedbackCount === 0) return { feedbackCount: 0, feedbackClients: 0, score: null };
  const score = Number(s.value) / 10 ** s.decimals;
  if (!Number.isFinite(score)) throw new RangeError("puan sayıya çevrilemedi");
  if (score < SCORE_MIN || score > SCORE_MAX) throw new RangeError(`puan ${SCORE_MIN}–${SCORE_MAX} aralığı dışında`);

  let feedbackClients: number;
  if (feedbackCount === 1 || verifiedClients.length === 1) {
    feedbackClients = 1; // tek geri bildirim ya da tek müşteri: yoklamaya gerek yok
  } else {
    const probe = verifiedClients.slice(0, MAX_CLIENT_PROBES);
    const counts = await mapLimit(probe, PROBE_CONCURRENCY, async (c) => (await chain.reputationSummary(agentId, [c])).count);
    feedbackClients = counts.filter((n) => n > 0n).length;
  }
  return { feedbackCount, feedbackClients, score };
}
