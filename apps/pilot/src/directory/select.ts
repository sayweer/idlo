/**
 * Giriş noktası: `selectAgents(sohbetMetni, config)` → düz JSON (bigint yok, SelectionResultSchema ile doğrulanmış).
 * Akış: ihtiyaç yapılandır (LLM) ‖ adayları zincirden oku → eşik (kod) → kalanları sırala (LLM, kural yedeği).
 * Web bunu bir route'tan çağırır. İmza yolu (`planForAgent`, selection.ts) bu çıktıyı GİRDİ olarak almaz: seçilen
 * agentId için adayı zincirden taze okur (tarayıcıdan dönen JSON'a güvenilmez).
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  DEFAULT_THRESHOLDS,
  SelectionResultSchema,
  DEMO_LABEL_TR,
  type Deployments,
  type SelectionResult,
  type Thresholds,
} from "@pilot/shared";
import { llmModelFromEnv, type PlanLlmClient } from "../plan/sentence.js";
import type { DirectoryChain } from "./chain.js";
import { normalizeChat, structureNeed } from "./need.js";
import { rankSurvivors } from "./ranking.js";
import { loadCandidates, type CandidateRef } from "./registry.js";
import { screen } from "./screen.js";

export interface DirectoryConfig {
  chain: DirectoryChain;
  deployments: Pick<Deployments, "chainId" | "kuleReporter" | "deployBlock" | "erc8004">;
  /** Yapılandırılmış agentId listesi (Identity'de totalSupply yok); DEMO işareti buradan gelir. */
  candidates: readonly CandidateRef[];
  /** Yerel kip: kartlar http://127.0.0.1'den okunabilir. */
  local?: boolean;
  fetch?: typeof fetch;
  /** null/undefined: LLM yok → ihtiyaç ham metin, sıralama kural. */
  llm?: PlanLlmClient | null;
  /** Varsayılan: LLM_MODEL ortam değişkeni, yoksa sentence.ts varsayılanı. */
  model?: string;
  thresholds?: Partial<Thresholds>;
}

/** ANTHROPIC_API_KEY varsa Anthropic istemcisi, yoksa null (kural modu). Anahtar koda yazılmaz. */
export function directoryLlmFromEnv(env: NodeJS.ProcessEnv = process.env): PlanLlmClient | null {
  if (!env.ANTHROPIC_API_KEY?.trim()) return null;
  return new Anthropic({ timeout: 30_000, maxRetries: 2 });
}

export async function selectAgents(chatText: string, config: DirectoryConfig): Promise<SelectionResult> {
  const text = normalizeChat(chatText); // boş/çok uzun → DirectoryError("invalid_input")
  const client = config.llm ?? null;
  const model = config.model ?? llmModelFromEnv();

  const [need, candidates] = await Promise.all([
    structureNeed(text, { client, model }),
    loadCandidates(config.candidates, {
      chain: config.chain,
      deployments: config.deployments,
      local: config.local === true,
      ...(config.fetch ? { fetch: config.fetch } : {}),
    }),
  ]);
  const screened = screen(candidates, { ...DEFAULT_THRESHOLDS, ...config.thresholds });
  const ranking = await rankSurvivors(need, screened.kept, { client, model, chatText: text });

  const notesTr: string[] = [];
  if (need.source === "fallback") notesTr.push("Mesajın LLM ile yapılandırılamadı; ham metin kullanıldı.");
  if (screened.kept.length === 0) notesTr.push("Eşiği geçen ajan yok.");
  else if (ranking.source === "rule") notesTr.push("Sıralama puana göre yapıldı (LLM yok ya da çıktısı geçersiz).");
  if (candidates.some((c) => c.demo)) notesTr.push(`${DEMO_LABEL_TR} etiketli ajanlar gerçek ajan değildir.`);

  return SelectionResultSchema.parse({ need, screen: screened, ranking, notesTr });
}
