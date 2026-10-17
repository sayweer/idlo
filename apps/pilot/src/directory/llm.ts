/**
 * Yapılandırılmış LLM çağrısı: JSON şeması API'ye gider, doğrulama kodda zod ile yapılır (CLAUDE.md kural 1).
 * Bozuk çıktı bir kez yeniden denenir; ağ/API hatası kalıcıdır (SDK 429/5xx'i kendisi dener). Hiçbir durumda yarım
 * sonuç dönmez: çağıran `ok:false` görünce kurala düşer ya da durur.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import type { PlanLlmClient } from "../plan/sentence.js";

export const LLM_MAX_ATTEMPTS = 2;
export const LLM_MAX_TOKENS = 4000;

export type AskResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: "llm_unavailable" | "invalid_output"; details: string[] };

export interface AskRequest<S extends z.ZodType> {
  model: string;
  system: string;
  user: string;
  schema: S;
  /** Şema dışı anlamsal denetim: hata metni döndürürse deneme geçersiz sayılır. */
  check?: (value: z.infer<S>) => string | null;
}

export function buildStructuredRequest<S extends z.ZodType>(r: AskRequest<S>): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: r.model,
    max_tokens: LLM_MAX_TOKENS,
    system: r.system,
    output_config: { format: { type: "json_schema", schema: zodOutputFormat(r.schema).schema } },
    messages: [{ role: "user", content: r.user }],
  };
}

export async function askStructured<S extends z.ZodType>(client: PlanLlmClient, r: AskRequest<S>): Promise<AskResult<z.infer<S>>> {
  const body = buildStructuredRequest(r);
  const failures: string[] = [];
  for (let attempt = 1; attempt <= LLM_MAX_ATTEMPTS; attempt++) {
    let msg: Anthropic.Message;
    try {
      msg = await client.messages.create(body);
    } catch (err) {
      const detail = err instanceof Anthropic.APIError ? `API ${String(err.status)}: ${err.message}` : String(err);
      return { ok: false, kind: "llm_unavailable", details: [detail] };
    }
    if (msg.stop_reason !== "end_turn") {
      failures.push(`deneme ${attempt}: stop_reason=${String(msg.stop_reason)}`);
      continue;
    }
    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      failures.push(`deneme ${attempt}: JSON ayrıştırılamadı`);
      continue;
    }
    const parsed = r.schema.safeParse(json);
    if (!parsed.success) {
      failures.push(`deneme ${attempt}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      continue;
    }
    const semantic = r.check?.(parsed.data) ?? null;
    if (semantic !== null) {
      failures.push(`deneme ${attempt}: ${semantic}`);
      continue;
    }
    return { ok: true, value: parsed.data };
  }
  return { ok: false, kind: "invalid_output", details: failures };
}
