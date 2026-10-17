import { isAddressEqual, type Address, type Log } from "viem";
import { type BuyAction, type UnixSec } from "@pilot/shared";
import type { PlanEvent } from "../../lib/data";

/**
 * Canlı izlemeden (watchContractEvent) gelen günlüğü geçmiş listesiyle aynı `PlanEvent` biçimine çevirir.
 * Süzgeç `user`: olayların hiçbirinde ilk indexed alan `user` olmadığı için istemci tarafında yapılır.
 * Geçmiş okumasının (lib/data/chain.ts) eşlemesiyle aynı alanlar; PendingCleared/PlanSet gösterilmez.
 */
export function eventFromLog(log: Log, user: Address): PlanEvent | null {
  const name = (log as { eventName?: string }).eventName;
  const a = ((log as { args?: unknown }).args ?? {}) as Record<string, unknown>;
  if (!name || typeof a.user !== "string" || !isAddressEqual(a.user as Address, user)) return null;
  if (log.transactionHash == null || log.blockNumber == null) return null; // bekleyen günlük: henüz kesinleşmedi
  const base = { user, hash: log.transactionHash, blockNumber: log.blockNumber };
  switch (name) {
    case "BuyAuthorized":
      return { kind: "BuyAuthorized", ...base, actionId: String(a.actionId), agentId: String(a.agentId), amountTL: a.amountTL as bigint };
    case "BuyRejected":
      return { kind: "BuyRejected", ...base, agentId: String(a.agentId), amountTL: a.amountTL as bigint, code: Number(a.code) };
    case "BuyExecuted":
      return { kind: "BuyExecuted", ...base, actionId: String(a.actionId), filledTL: a.filledTL as bigint, avgPxE6: a.avgPxE6 as bigint, status: Number(a.status) };
    case "CycleClosed":
      return { kind: "CycleClosed", ...base, cycleId: Number(a.cycleId), spentTL: a.spentTL as bigint, ok: a.ok as boolean };
    case "PlanSet":
      return { kind: "PlanSet", ...base, immediate: a.immediate as boolean, activeAt: Number(a.activeAt) };
    case "PlanRevoked":
      return { kind: "PlanRevoked", ...base };
    default:
      return null;
  }
}

const keyOf = (e: PlanEvent) => `${e.hash}:${e.kind}:${"actionId" in e ? e.actionId : ""}:${"code" in e ? e.code : ""}:${"cycleId" in e ? e.cycleId : ""}`;

/** Geçmiş + canlı olayları birleştirir, tekilleştirir, yeni → eski sıralar (blok numarası). */
export function mergeEvents(history: readonly PlanEvent[], live: readonly PlanEvent[]): PlanEvent[] {
  const seen = new Map<string, PlanEvent>();
  for (const e of [...history, ...live]) if (!seen.has(keyOf(e))) seen.set(keyOf(e), e);
  return [...seen.values()].sort((a, b) => (a.blockNumber === b.blockNumber ? 0 : a.blockNumber < b.blockNumber ? 1 : -1));
}

export type AuthRow = {
  actionId: string;
  authorized: Extract<PlanEvent, { kind: "BuyAuthorized" }>;
  executed: Extract<PlanEvent, { kind: "BuyExecuted" }> | null;
  /** İzin açık ama rapor süresi geçmiş: `actions(id)` EXPIRED ya da reportBy < şimdi (expireAction olay yaymaz). */
  reportExpired: boolean;
};

/**
 * BuyAuthorized ↔ BuyExecuted eşlemesi. `actions` açık izinler için `actions(id)` okumasıdır (yoksa/okunamadıysa
 * `reportExpired` false kalır: tahmin yok).
 */
export function buildAuthRows(events: readonly PlanEvent[], actions: ReadonlyMap<string, BuyAction | null>, nowSec: UnixSec): AuthRow[] {
  const executed = new Map<string, Extract<PlanEvent, { kind: "BuyExecuted" }>>();
  for (const e of events) if (e.kind === "BuyExecuted") executed.set(e.actionId, e);
  const rows: AuthRow[] = [];
  for (const e of events) {
    if (e.kind !== "BuyAuthorized") continue;
    const ex = executed.get(e.actionId) ?? null;
    const act = actions.get(e.actionId) ?? null;
    const reportExpired = !ex && !!act && (act.state === "EXPIRED" || (act.state === "AUTHORIZED" && act.reportBy < nowSec));
    rows.push({ actionId: e.actionId, authorized: e, executed: ex, reportExpired });
  }
  return rows;
}

