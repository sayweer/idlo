import type { PlanDraft } from "@pilot/shared";
import { buildFixtureResponse } from "./fixture";
import {
  AgentsResponseSchema,
  DraftResponseSchema,
  LlmStatusSchema,
  type AgentsResponse,
  type DraftErrorKind,
} from "./types";

// /secim'in sunucu çağrıları. Hepsi fail-closed: cevap şemaya uymuyorsa hata sayılır, tahmin yürütülmez.

async function readJson(res: Response): Promise<unknown> {
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("json")) throw new Error(`beklenmeyen cevap (HTTP ${res.status})`);
  return res.json();
}

/**
 * Aday listesi. Yerel geliştirmede (`vite dev`) Pages Function yoktur: yalnız orada aynı fixture istemcide kurulur
 * (TEMSİLİ VERİ etiketi aynıdır). Üretim derlemesinde bu dal kaldırılır; hata hata olarak gösterilir.
 */
export async function getCandidates(message: string): Promise<AgentsResponse> {
  try {
    const res = await fetch("/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return AgentsResponseSchema.parse(await readJson(res));
  } catch (e) {
    if (import.meta.env.DEV) return buildFixtureResponse(message);
    throw e;
  }
}

/** GET /api/plan/draft: sunucuda ANTHROPIC_API_KEY var mı. Ulaşılamıyorsa "yok" (fail-closed). */
export async function getLlmAvailable(): Promise<boolean> {
  try {
    const res = await fetch("/api/plan/draft", { headers: { accept: "application/json" } });
    if (!res.ok) return false;
    return LlmStatusSchema.parse(await readJson(res)).available;
  } catch {
    return false;
  }
}

export type DraftResult =
  | { ok: true; draft: PlanDraft }
  | { ok: false; kind: DraftErrorKind; message: string };

const UNAVAILABLE: DraftResult = {
  ok: false,
  kind: "llm_unavailable",
  message: "LLM yok, kural modu — yeni plan şu an oluşturulamaz.",
};

/** POST /api/plan/draft. Ağ hatası, 5xx, 401 ve bozuk cevap "LLM yok" sayılır (UI_HANDOFF §2.2 Durumlar). */
export async function requestDraft(
  sentence: string,
  answers: readonly { question: string; answer: string }[],
): Promise<DraftResult> {
  let res: Response;
  try {
    res = await fetch("/api/plan/draft", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sentence, ...(answers.length > 0 ? { answers } : {}) }),
    });
  } catch {
    return UNAVAILABLE;
  }
  let parsed;
  try {
    parsed = DraftResponseSchema.safeParse(await readJson(res));
  } catch {
    return UNAVAILABLE;
  }
  if (!parsed.success) return UNAVAILABLE;
  return parsed.data;
}
