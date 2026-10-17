import { isAddressEqual, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import {
  buyActionFromChain,
  cycleFromChain,
  planFromChain,
  type BuyAction,
  type Cycle,
  type Deployments,
  type Plan,
  type UnixSec,
} from "@pilot/shared";
import { FLIGHT_PLAN_ABI } from "../flightPlanAbi";
import { publicClient } from "../fuji";
import { deploymentsOf, useDeployments } from "./deployments";

type EventBase = { user: Address; hash: Hex; blockNumber: bigint };

/** FlightPlan olayı. Blok zamanı geçmiş listesinde ayrıca okunur (olay günlüğü zaman damgası taşımaz). */
export type PlanEvent =
  | (EventBase & { kind: "PlanSet"; immediate: boolean; activeAt: UnixSec })
  | (EventBase & { kind: "PlanRevoked" })
  | (EventBase & { kind: "BuyAuthorized"; actionId: string; agentId: string; amountTL: bigint })
  | (EventBase & { kind: "BuyRejected"; agentId: string; amountTL: bigint; code: number })
  | (EventBase & { kind: "BuyExecuted"; actionId: string; filledTL: bigint; avgPxE6: bigint; status: number })
  | (EventBase & { kind: "CycleClosed"; cycleId: number; spentTL: bigint; ok: boolean });

/**
 * Zincir okuma arayüzü (yalnız okuma: yazma `useTx` ile ve yalnız onay penceresinden yapılır).
 * Ekranlar bu arayüze bağlanır; uygulama `createChainReads` (viem) ya da testlerde sahte olabilir.
 * Birim dönüşümü @pilot/shared'in `*FromChain` yardımcılarındadır: ekranlar ham bigint görmez (olaylar hariç).
 */
export interface ChainReads {
  /** plans(user) + isPlanActive(user). Hiç plan kurulmadıysa plan = null ("plan yok" = plans(user).agent == 0x0). */
  readPlan(user: Address): Promise<{ plan: Plan | null; active: boolean }>;
  /** pending(user): bekleyen plan ve etkinleşme anı; yoksa null. */
  readPending(user: Address): Promise<{ plan: Plan; activeAt: UnixSec } | null>;
  /** cycles(user): şimdiki TR ayının döngüsü. */
  readCycle(user: Address): Promise<Cycle>;
  /** actions(id); izin yoksa null. */
  readAction(actionId: string): Promise<BuyAction | null>;
  /** Olay geçmişi: deployBlock'tan parçalı getLogs. Bir parça okunamazsa fırlatır (arayüz gri "Zincir okunamadı" gösterir). */
  readHistory(user: Address, opts?: { toBlock?: bigint }): Promise<PlanEvent[]>;
}

const LOG_CHUNK = 2048n; // herkese açık Fuji RPC getLogs aralığını sınırlar (UI_HANDOFF §3.3)
const EVENT_ABI = FLIGHT_PLAN_ABI.filter((x) => x.type === "event");

export function createChainReads(deployments: Deployments, client: PublicClient = publicClient): ChainReads {
  const address = deployments.flightPlan as Address;
  const abi = FLIGHT_PLAN_ABI;
  return {
    async readPlan(user) {
      const [raw, active] = await Promise.all([
        client.readContract({ address, abi, functionName: "plans", args: [user] }),
        client.readContract({ address, abi, functionName: "isPlanActive", args: [user] }),
      ]);
      if (isAddressEqual(raw.agent, zeroAddress)) return { plan: null, active: false };
      return { plan: planFromChain(raw), active };
    },
    async readPending(user) {
      const [raw, activeAt] = await client.readContract({ address, abi, functionName: "pending", args: [user] });
      if (activeAt === 0n) return null;
      return { plan: planFromChain(raw), activeAt: Number(activeAt) };
    },
    async readCycle(user) {
      return cycleFromChain(await client.readContract({ address, abi, functionName: "cycles", args: [user] }));
    },
    async readAction(actionId) {
      return buyActionFromChain(await client.readContract({ address, abi, functionName: "actions", args: [BigInt(actionId)] }));
    },
    async readHistory(user, opts) {
      const latest = opts?.toBlock ?? (await client.getBlockNumber());
      const events: PlanEvent[] = [];
      for (let from = BigInt(deployments.deployBlock); from <= latest; from += LOG_CHUNK) {
        const to = from + LOG_CHUNK - 1n < latest ? from + LOG_CHUNK - 1n : latest;
        // her olayın ilk indexed alanı `user` değil (BuyAuthorized: actionId): süzgeç istemci tarafında
        const logs = await client.getLogs({ address, fromBlock: from, toBlock: to, events: EVENT_ABI, strict: true });
        for (const l of logs) {
          const a = l.args as Record<string, unknown>;
          if (typeof a.user !== "string" || !isAddressEqual(a.user as Address, user)) continue;
          const base = { user, hash: l.transactionHash, blockNumber: l.blockNumber };
          switch (l.eventName) {
            case "PlanSet": events.push({ kind: "PlanSet", ...base, immediate: a.immediate as boolean, activeAt: Number(a.activeAt) }); break;
            case "PlanRevoked": events.push({ kind: "PlanRevoked", ...base }); break;
            case "BuyAuthorized": events.push({ kind: "BuyAuthorized", ...base, actionId: String(a.actionId), agentId: String(a.agentId), amountTL: a.amountTL as bigint }); break;
            case "BuyRejected": events.push({ kind: "BuyRejected", ...base, agentId: String(a.agentId), amountTL: a.amountTL as bigint, code: Number(a.code) }); break;
            case "BuyExecuted": events.push({ kind: "BuyExecuted", ...base, actionId: String(a.actionId), filledTL: a.filledTL as bigint, avgPxE6: a.avgPxE6 as bigint, status: Number(a.status) }); break;
            case "CycleClosed": events.push({ kind: "CycleClosed", ...base, cycleId: Number(a.cycleId), spentTL: a.spentTL as bigint, ok: a.ok as boolean }); break;
            default: break; // PendingCleared geçmiş listesinde gösterilmez
          }
        }
      }
      return events;
    },
  };
}

/** Deployments hazır değilse null: ekranlar NO_DEPLOYMENT / "Kontrat adresi okunamadı" gösterir ve imzayı kapatır. */
export function useChainReads(): ChainReads | null {
  const d = deploymentsOf(useDeployments());
  return d ? createChainReads(d) : null;
}
