import { isAddressEqual, parseEventLogs, type Address, type Hex, type TransactionReceipt } from "viem";
import {
  formatDecimalTr,
  scaledToDecimal,
  trParts,
  type Candidate,
  type Deployments,
  type PlanConfirmation,
} from "@pilot/shared";
import { FLIGHT_PLAN_ABI } from "../../lib/flightPlanAbi";
import type { AgentsOrigin } from "./types";

// /secim'in saf (React'siz) mantığı: ajan çözümü, imza isteği, PlanSet okuma, biçimler. Testler bunları doğrular.

const two = (n: number) => String(n).padStart(2, "0");

/** 15.01.2027 12:00 (TR saati). Saatler her yerde TR saatidir (UI_HANDOFF §2). */
export function trDateTime(sec: number): string {
  const p = trParts(sec);
  return `${two(p.day)}.${two(p.month)}.${p.year} ${two(p.hour)}:${two(p.minute)} (TR saati)`;
}

/** "X,X sn'de kesinleşti" için: `msToSec` tamsayıya keser (1400 → 1), bu yüzden ondalık biçim kullanılır. */
export function finalitySeconds(ms: number): string {
  return formatDecimalTr(scaledToDecimal(BigInt(Math.max(0, Math.round(ms))), 3), 1);
}

/** Puan: 95 → "95,00" (geri bildirim yoksa "—"). */
export function scoreText(score: number | null): string {
  return score === null ? "—" : score.toFixed(2).replace(".", ",");
}

export type PlanAgentCtx = {
  /** buildPlanConfirmation'a giden `deployments` (agent/agentId seçilen ajandan); null → NO_DEPLOYMENT. */
  deployments: Pick<Deployments, "pilotAgent" | "kuleReporter" | "agentId"> | null;
  /** Aday TEMSİLİ (fixture) ve zincirdeki PİLOT değil: cüzdan adresi örnektir, imza kapalı. */
  demoLock: boolean;
};

/**
 * Seçilen ajan → planın `agent` ve `agentId` alanları (HANDOFF §5 karar 5: `plan.agent` = seçilen ajan).
 * - Aday, `fuji.json`'daki kayıtlı PİLOT ise (agentId eşit) adres ve kimlik dağıtımdan gelir.
 * - Değilse adres adayın ERC-8004 `agentWallet`'ından gelir; fixture adayında bu adres sahtedir, imza kapalı kalır.
 * KULE adresi her zaman dağıtımdan gelir.
 */
export function agentPlanContext(c: Candidate, origin: AgentsOrigin, deployments: Deployments | null): PlanAgentCtx {
  if (deployments === null) return { deployments: null, demoLock: origin === "fixture" };
  if (deployments.agentId !== undefined && c.agentId === deployments.agentId) {
    return {
      deployments: { pilotAgent: deployments.pilotAgent, kuleReporter: deployments.kuleReporter, agentId: deployments.agentId },
      demoLock: false,
    };
  }
  if (c.agentWallet === null) return { deployments: null, demoLock: true };
  return {
    deployments: { pilotAgent: c.agentWallet, kuleReporter: deployments.kuleReporter, agentId: c.agentId },
    demoLock: origin === "fixture",
  };
}

/**
 * İmza isteği: `args` onay penceresindeki `conf.setPlanArgs`'ın KENDİSİDİR (UI_HANDOFF §2.2 adım 4); `planToChain`, taslak ya da
 * form durumu imza için yeniden kullanılmaz. Pencere imzaya kapalıysa ya da kontrat adresi yoksa null.
 */
export function buildSignRequest(deployments: Deployments | null, conf: PlanConfirmation) {
  if (deployments === null || !conf.signable || conf.setPlanArgs === null) return null;
  return {
    address: deployments.flightPlan as Address,
    abi: FLIGHT_PLAN_ABI,
    functionName: "setPlan" as const,
    args: conf.setPlanArgs,
  };
}

export type PlanSetOutcome = {
  planHash: Hex;
  immediate: boolean;
  activeAt: number;
  pendingCleared: boolean;
};

/** Makbuzdaki `PlanSet` (ve varsa `PendingCleared`) olayı: yalnız bu kontrattan ve bu kullanıcıdan. Yoksa null. */
export function readPlanSet(receipt: Pick<TransactionReceipt, "logs">, flightPlan: Address, user: Address): PlanSetOutcome | null {
  const logs = receipt.logs.filter((l) => isAddressEqual(l.address, flightPlan));
  const events = parseEventLogs({ abi: FLIGHT_PLAN_ABI, logs, eventName: ["PlanSet", "PendingCleared"], strict: false });
  let out: PlanSetOutcome | null = null;
  let pendingCleared = false;
  for (const e of events) {
    const a = e.args as { user?: Address; planHash?: Hex; immediate?: boolean; activeAt?: bigint };
    if (a.user === undefined || !isAddressEqual(a.user, user)) continue;
    if (e.eventName === "PendingCleared") pendingCleared = true;
    else if (a.planHash !== undefined && a.immediate !== undefined && a.activeAt !== undefined) {
      out = { planHash: a.planHash, immediate: a.immediate, activeAt: Number(a.activeAt), pendingCleared: false };
    }
  }
  return out === null ? null : { ...out, pendingCleared };
}
