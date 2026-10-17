import { PlanDraftSchema, SelectionResultSchema, type PlanDraft, type SelectionResult } from "@pilot/shared";
import { z } from "zod";

// /secim'in istemci ↔ sunucu sözleşmesi. Hem Cloudflare Pages işlevleri (functions/api/*) hem de ekran içe aktarır.
// Aday listesi cevabı `SelectionResult`'tır (@pilot/shared/directory): apps/pilot/src/directory arka ucu bitince
// `origin: "chain"` ile aynı biçimde döner, ekran değişmez.

/** TODO(spec): SPEC cümle uzunluğunu vermiyor; UI_HANDOFF'taki route sınırı (≤ 500) ve apps/pilot/src/plan/sentence.ts ile aynı. */
export const MAX_MESSAGE_CHARS = 500;
export const MAX_ANSWERS = 10;
export const MAX_ANSWER_CHARS = 200;
export const MAX_QUESTION_CHARS = 300;

// ───────────────────────────── /api/agents ─────────────────────────────

export const AgentsRequestSchema = z.strictObject({
  message: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
});
export type AgentsRequest = z.infer<typeof AgentsRequestSchema>;

/** "fixture": etiketli örnek liste (TEMSİLİ VERİ). "chain": gerçek ERC-8004 dizini (henüz yok). */
export const AGENTS_ORIGINS = ["fixture", "chain"] as const;
export type AgentsOrigin = (typeof AGENTS_ORIGINS)[number];

export const AgentsResponseSchema = z.strictObject({
  origin: z.enum(AGENTS_ORIGINS),
  result: SelectionResultSchema,
});
export type AgentsResponse = { origin: AgentsOrigin; result: SelectionResult };

// ───────────────────────────── /api/plan/draft ─────────────────────────────

export const DraftRequestSchema = z.strictObject({
  sentence: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
  answers: z
    .array(
      z.strictObject({
        question: z.string().trim().min(1).max(MAX_QUESTION_CHARS),
        answer: z.string().trim().min(1).max(MAX_ANSWER_CHARS),
      }),
    )
    .max(MAX_ANSWERS)
    .optional(),
});
export type DraftRequest = z.infer<typeof DraftRequestSchema>;

export const DRAFT_ERROR_KINDS = ["invalid_input", "llm_unavailable", "invalid_output"] as const;
export type DraftErrorKind = (typeof DRAFT_ERROR_KINDS)[number];

export const DraftResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), draft: PlanDraftSchema }),
  z.strictObject({ ok: z.literal(false), kind: z.enum(DRAFT_ERROR_KINDS), message: z.string().max(400) }),
]);
export type DraftResponse = { ok: true; draft: PlanDraft } | { ok: false; kind: DraftErrorKind; message: string };

/** GET /api/plan/draft: yalnız ANTHROPIC_API_KEY'in var olup olmadığı (anahtarın kendisi asla dönmez). */
export const LlmStatusSchema = z.strictObject({ available: z.boolean() });
export type LlmStatus = z.infer<typeof LlmStatusSchema>;
