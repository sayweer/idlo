/** deployments/fuji.json'a agentId ekleme (SPEC §8.5, A3). Saf: metin alır, metin döndürür; okuma/yazma çağıranda. */
import { parseDeployments } from "@pilot/shared";

/**
 * Dosya metnine `agentId` ekler. Girdi ve çıktı ortak şemayla (`parseDeployments`) doğrulanır (fail-closed).
 * Ham JSON üzerinde çalışır; böylece şemanın bilmediği anahtarlar da korunur.
 * TODO(spec): agentId 0 ERC-8004'te geçerli olabilir ama web onu "kayıt yok" sayar (UI_HANDOFF §2.2); en dar seçim: reddet.
 */
export function withAgentId(text: string, agentId: bigint): string {
  parseDeployments(text);
  if (agentId <= 0n) throw new Error(`agentId ${agentId} yazılmaz (0 ya da negatif)`);
  const raw = JSON.parse(text) as Record<string, unknown>;
  raw.agentId = agentId.toString();
  const out = JSON.stringify(raw, null, 2) + "\n";
  if (parseDeployments(out).agentId !== agentId.toString()) throw new Error("agentId yazılamadı");
  return out;
}
