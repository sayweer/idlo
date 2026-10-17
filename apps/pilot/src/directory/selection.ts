/**
 * Seçim → plan taslağı (HANDOFF §5 KARAR madde 5). Seçilen ajanın cüzdanı ve agentId'si ZİNCİR OKUMASINDAN (eşiği
 * geçen aday) gelir; LLM adres seçmez. Değerler mevcut onay penceresine (packages/shared/plan) verilir:
 * `plan.agent = agentWallet`, `plan.agentId = agentId`, `plan.kule = deployments.kuleReporter`. Pencere ve imza
 * kuralları değişmez (signable, 24 saat kilidi, F-4 "agent/agentId her zaman bekletir").
 *
 * TODO(spec): pencere satırı etiketi hâlâ "PİLOT adresi / PİLOT kimliği"; seçilen ajan başka biri olabilir (UI, Bekir).
 * TODO(spec): seçim ile imza arasında zincir durumu değişebilir; imzadan hemen önce `loadCandidates` + `screen`
 * yeniden çalıştırılmalı (bu modül anlık görüntüyle çalışır).
 */
import type { Address } from "viem";
import {
  buildPlanConfirmation,
  type Candidate,
  type Deployments,
  type Plan,
  type PlanConfirmation,
  type PlanDraft,
  type ScreenResult,
} from "@pilot/shared";
import { planFromSentence, type PlanLlmClient } from "../plan/sentence.js";
import { DirectoryError } from "./errors.js";

/** Seçilen agentId eşiği geçenler arasında olmalı; aksi hâlde hata (fail-closed). */
export function pickCandidate(screenResult: ScreenResult, agentId: string): Candidate {
  const kept = screenResult.kept.find((c) => c.agentId === agentId);
  if (kept !== undefined) return kept;
  if (screenResult.eliminated.some((e) => e.agentId === agentId)) {
    throw new DirectoryError("agent_not_eligible", [`agentId=${agentId}`]);
  }
  throw new DirectoryError("unknown_agent", [`agentId=${agentId}`]);
}

export interface SelectionPlanContext {
  nowSec: number;
  /** planFromChain(plans(user)); plan yoksa null. */
  current: Plan | null;
  currentActive: boolean;
}

/** Hazır taslaktan onay penceresi kurar; ajan alanları seçilen adaydan gelir. */
export function confirmationForAgent(
  draft: PlanDraft,
  screenResult: ScreenResult,
  agentId: string,
  deployments: Pick<Deployments, "kuleReporter">,
  ctx: SelectionPlanContext,
): PlanConfirmation {
  const c = pickCandidate(screenResult, agentId);
  if (c.agentWallet === null) throw new DirectoryError("plan_not_buildable", ["agentWallet yok"]);
  return buildPlanConfirmation(draft, {
    nowSec: ctx.nowSec,
    deployments: { pilotAgent: c.agentWallet as Address, kuleReporter: deployments.kuleReporter, agentId: c.agentId },
    current: ctx.current,
    currentActive: ctx.currentActive,
  });
}

export interface PlanForAgentInput {
  /** Kullanıcının plan cümlesi (planFromSentence girdisi). `draft` verilmişse kullanılmaz. */
  sentence?: string;
  /** Hazır taslak (ör. daha önce kurulmuş); yoksa `sentence` LLM ile çevrilir. */
  draft?: PlanDraft;
  agentId: string;
  screen: ScreenResult;
  deployments: Pick<Deployments, "kuleReporter">;
  ctx: SelectionPlanContext;
  llm: { client: PlanLlmClient; model: string } | null;
}

/**
 * Seçilen ajan için taslak → onay penceresi. Taslak yoksa cümle `planFromSentence` ile çevrilir (LLM şart; yoksa
 * PlanDraftError llm_unavailable fırlar, yarım plan dönmez).
 */
export async function planForAgent(i: PlanForAgentInput): Promise<PlanConfirmation> {
  pickCandidate(i.screen, i.agentId); // taslak için LLM harcamadan önce eşik denetimi
  let draft = i.draft;
  if (draft === undefined) {
    if (i.sentence === undefined) throw new DirectoryError("plan_not_buildable", ["cümle ya da taslak gerekli"]);
    if (i.llm === null) throw new DirectoryError("plan_not_buildable", ["LLM yok"]);
    draft = await planFromSentence(i.sentence, { client: i.llm.client, model: i.llm.model });
  }
  return confirmationForAgent(draft, i.screen, i.agentId, i.deployments, i.ctx);
}
