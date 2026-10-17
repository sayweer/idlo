/** PİLOT izi: bir tur (§15, §10.1). */
import { z } from "zod";
import { PILOT_TOOL_NAMES } from "../tools/pilot.js";
import { OptionIdSchema } from "./option.js";
import { AddressSchema, CycleIdSchema, UnixMsSchema } from "./primitives.js";

/** Bir turda en fazla 8 araç çağrısı (§10.1). */
export const MAX_TOOL_CALLS_PER_TURN = 8;

export const TRACE_MODES = ["llm", "rules"] as const;

/** Adım: araç adı + girdi/çıktı özeti. Özet panel içindir; tam doğrulama araç çağrısında yapılır. */
export const TraceStepSchema = z.strictObject({
  tool: z.enum(PILOT_TOOL_NAMES),
  in: z.record(z.string(), z.unknown()).optional(),
  out: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(), // TODO(spec): §15'te yok; şemayı geçmeyen ya da hata veren çağrı için
});
export type TraceStep = z.infer<typeof TraceStepSchema>;

export const TraceSchema = z.strictObject({
  turn: z.int().nonnegative(),
  ts: UnixMsSchema,
  user: AddressSchema,
  cycleId: CycleIdSchema,
  mode: z.enum(TRACE_MODES),
  steps: z.array(TraceStepSchema).max(MAX_TOOL_CALLS_PER_TURN),
  rationaleTr: z.string().max(1000),
  /**
   * TODO(spec): §15'te yok. Panelin "önerilenden farklı seçti" rozeti için (§10.3-1, E-5, docs/UI_HANDOFF.md /panel):
   * bu turun son geçerli `kural_danis` önerisi ve turda uygulanan, `allowed` içindeki seçenek. Seçim izinli bir
   * seçeneğe eşlenmezse `chosenOptionId` yoktur. Yalnız gösterimdir; güvenlik kararı araç katmanındadır.
   */
  recommendedOptionId: OptionIdSchema.optional(),
  chosenOptionId: OptionIdSchema.optional(),
});
export type Trace = z.infer<typeof TraceSchema>;
