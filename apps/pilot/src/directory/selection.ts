/**
 * Seçim → plan taslağı (HANDOFF §5 KARAR madde 5). Seçilen ajanın cüzdanı ve agentId'si ZİNCİR OKUMASINDAN (eşiği
 * geçen aday) gelir; LLM adres seçmez. Değerler mevcut onay penceresine (packages/shared/plan) verilir:
 * `plan.agent = agentWallet`, `plan.agentId = agentId`, `plan.kule = deployments.kuleReporter`. Pencere ve imza
 * kuralları değişmez (signable, 24 saat kilidi, F-4 "agent/agentId her zaman bekletir").
 *
 * İMZA YOLU İSTEMCİ VERİSİ KABUL ETMEZ: `confirmationForAgent` / `planForAgent` yalnız `agentId` ve zincir tutamağı
 * (`SigningDirectory`) alır; adayı kendileri `loadCandidates` + `screen` ile TAZE okur ve cüzdanı/uygunluğu o
 * sonuçtan alır. Tarayıcıdan geri gelen bir `ScreenResult` (selectAgents'in JSON'u) bu yola giremez; sahte `kept`
 * girdisi yoktur. agentId yalnız yapılandırılmış aday listesinden seçilebilir (aksi hâlde unknown_agent). Bu aynı
 * zamanda seçim ile imza arasındaki eski anlık görüntü sorununu kapatır.
 */
import type { Address } from "viem";
import {
  Uint256StringSchema,
  buildPlanConfirmation,
  type Candidate,
  type Deployments,
  type Plan,
  type PlanConfirmation,
  type PlanDraft,
  type ScreenResult,
  type Thresholds,
} from "@pilot/shared";
import { planFromSentence, type PlanLlmClient } from "../plan/sentence.js";
import type { DirectoryChain } from "./chain.js";
import { DirectoryError } from "./errors.js";
import { loadCandidates, type CandidateRef } from "./registry.js";
import { screen } from "./screen.js";

/** Seçilen agentId eşiği geçenler arasında olmalı; aksi hâlde hata (fail-closed). `screenResult` taze okunmuş olmalı. */
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

/** İmza yolunun zincir tutamağı: selectAgents ile aynı yapılandırma (sunucu tarafı), istemciden gelmez. */
export interface SigningDirectory {
  chain: DirectoryChain;
  deployments: Pick<Deployments, "chainId" | "kuleReporter" | "deployBlock" | "erc8004">;
  /** Yapılandırılmış aday listesi; DEMO işareti buradan gelir. agentId bu listede olmalı. */
  candidates: readonly CandidateRef[];
  local?: boolean;
  fetch?: typeof fetch;
  thresholds?: Partial<Thresholds>;
}

/** Seçilen ajanı zincirden TAZE okur, eşiği yeniden uygular; geçemezse DirectoryError. */
async function freshEligibleCandidate(agentId: string, dir: SigningDirectory): Promise<Candidate> {
  // Uint256StringSchema (zod 4) regex başarısızken BigInt refine'ını da çalıştırıp fırlatabiliyor: önce biçim denetimi.
  const wellFormed = typeof agentId === "string" && /^(0|[1-9]\d{0,77})$/.test(agentId);
  const id = wellFormed ? Uint256StringSchema.safeParse(agentId) : null;
  const ref = id?.success ? dir.candidates.find((r) => r.agentId === id.data) : undefined;
  if (ref === undefined) throw new DirectoryError("unknown_agent", [`agentId=${agentId}`]);
  const loaded = await loadCandidates([ref], {
    chain: dir.chain,
    deployments: dir.deployments,
    local: dir.local === true,
    ...(dir.fetch ? { fetch: dir.fetch } : {}),
  });
  return pickCandidate(screen(loaded, dir.thresholds ?? {}), ref.agentId);
}

/** Hazır taslaktan onay penceresi kurar; ajan alanları taze zincir okumasındaki adaydan gelir. */
export async function confirmationForAgent(
  draft: PlanDraft,
  agentId: string,
  directory: SigningDirectory,
  ctx: SelectionPlanContext,
): Promise<PlanConfirmation> {
  const c = await freshEligibleCandidate(agentId, directory);
  return buildConfirmation(draft, c, directory.deployments, ctx);
}

function buildConfirmation(
  draft: PlanDraft,
  c: Candidate,
  deployments: Pick<Deployments, "kuleReporter">,
  ctx: SelectionPlanContext,
): PlanConfirmation {
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
  /** Sunucu tarafı zincir tutamağı. İstemciden gelen bir `ScreenResult` BURAYA verilemez (ve verilirse yok sayılır). */
  directory: SigningDirectory;
  ctx: SelectionPlanContext;
  llm: { client: PlanLlmClient; model: string } | null;
}

/**
 * Seçilen ajan için taslak → onay penceresi. Taslak yoksa cümle `planFromSentence` ile çevrilir (LLM şart; yoksa
 * DirectoryError plan_not_buildable fırlar, yarım plan dönmez). Eşik denetimi LLM harcanmadan önce, taze okumayla yapılır.
 */
export async function planForAgent(i: PlanForAgentInput): Promise<PlanConfirmation> {
  const candidate = await freshEligibleCandidate(i.agentId, i.directory);
  let draft = i.draft;
  if (draft === undefined) {
    if (i.sentence === undefined) throw new DirectoryError("plan_not_buildable", ["cümle ya da taslak gerekli"]);
    if (i.llm === null) throw new DirectoryError("plan_not_buildable", ["LLM yok"]);
    draft = await planFromSentence(i.sentence, { client: i.llm.client, model: i.llm.model });
  }
  return buildConfirmation(draft, candidate, i.directory.deployments, i.ctx);
}
