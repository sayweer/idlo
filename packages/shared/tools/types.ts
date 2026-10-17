import { z } from "zod";

/** Araç tanımı: ad, Türkçe açıklama, zod girdi/çıktı şemaları. */
export interface ToolDef<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  readonly name: string;
  readonly description: string;
  readonly input: I;
  readonly output: O;
}

export function defineTool<I extends z.ZodType, O extends z.ZodType>(t: ToolDef<I, O>): ToolDef<I, O> {
  return Object.freeze(t);
}

/** Araç girdisinin JSON Schema'sı (LLM / MCP tanımı için). `$schema` anahtarı atılır. */
export function inputJsonSchema(t: ToolDef): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(t.input, { io: "input" }) as Record<string, unknown>;
  return rest;
}
