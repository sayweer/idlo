import { z } from "zod";
import {
  OrdTypeSchema,
  PILOT_TOOLS,
  buyOptionId,
  isOptionId,
  kuleReasonText,
  type KuleReasonCode,
  type PilotToolName,
  type Trace,
} from "@pilot/shared";

/** Araç adına göre çıktı tipi: `step.out` gevşek bir kayıttır, gösterimden önce aracın şemasıyla daraltılır. */
export type ToolOut = { [K in PilotToolName]: z.infer<(typeof PILOT_TOOLS)[K]["output"]> };

/**
 * `step.out` → aracın tam çıktı şeması (UI_HANDOFF §2.3). Parse olmuyorsa null: ekran ham JSON'u gri
 * "doğrulanmamış çıktı" gösterir ve asla "OK" yazmaz.
 */
export function parseStepOut<K extends PilotToolName>(tool: K, out: unknown): ToolOut[K] | null {
  if (out === undefined) return null;
  const r = (PILOT_TOOLS[tool].output as z.ZodType).safeParse(out);
  return r.success ? (r.data as ToolOut[K]) : null;
}

/** KULE gerekçe kodu → Türkçe; bilinmeyen kod fırlatır, burada ham kod gösterilir (tahmin yok). */
export function reasonText(code: string): string {
  try {
    return kuleReasonText(code as KuleReasonCode);
  } catch {
    return code;
  }
}

const AmountIn = z.object({ amountTL: z.int().positive(), ordType: OrdTypeSchema });
const WaitIn = z.object({ dakika: z.int().positive() });

/** Bir adımın seçenek kimliği (yalnız bu 4 durumda, UI_HANDOFF §2.3 "önerilenden farklı seçti"); eşleşmezse null. */
function optionOfStep(step: Trace["steps"][number]): string | null {
  switch (step.tool) {
    case "bekle": {
      const r = WaitIn.safeParse(step.in);
      return r.success ? `WAIT_${r.data.dakika}` : null;
    }
    case "izin_iste": {
      const r = AmountIn.safeParse(step.in);
      return r.success ? buyOptionId(r.data.amountTL, r.data.ordType) : null;
    }
    case "kullaniciya_sor":
      return "ASK";
    case "bitir":
      return "BITIR";
    default:
      return null;
  }
}

export interface ChoiceView {
  recommended: string;
  chosen: string;
  allowed: string[];
  differs: boolean;
}

/**
 * Turun "önerilen ↔ seçilen" görünümü. Rozet YALNIZ gösterimdir; güvenlik kararı araç katmanındadır.
 * Öncelik: izdeki `recommendedOptionId` / `chosenOptionId` alanları (varsa); yoksa seçim yalnız `kural_danis`'ten
 * HEMEN sonraki adımla birebir eşleşince türetilir. Eşleşme yoksa ya da kimlik `allowed`'da değilse null:
 * rozet hiç gösterilmez.
 */
export function choiceOf(trace: Trace): ChoiceView | null {
  let idx = -1;
  trace.steps.forEach((s, i) => { if (s.tool === "kural_danis" && parseStepOut("kural_danis", s.out)) idx = i; });
  if (idx < 0) return null;
  const kd = parseStepOut("kural_danis", trace.steps[idx]!.out)!;
  const allowed = kd.allowed;
  const recommended = trace.recommendedOptionId && allowed.includes(trace.recommendedOptionId) ? trace.recommendedOptionId : kd.recommended;
  const next = trace.steps[idx + 1];
  const chosen = trace.chosenOptionId ?? (next ? optionOfStep(next) : null);
  if (!chosen || !isOptionId(chosen) || !allowed.includes(chosen)) return null;
  return { recommended, chosen, allowed, differs: chosen !== recommended };
}

/** Turdaki KULE gerekçeleri (emri_uygula çıktısı): bildirimler için. */
export function traceReasons(trace: Trace): string[] {
  const out: string[] = [];
  for (const s of trace.steps) {
    if (s.tool !== "emri_uygula") continue;
    const o = parseStepOut("emri_uygula", s.out);
    if (o) out.push(...o.reasons);
  }
  return out;
}
