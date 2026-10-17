/**
 * Turun önerilen ve seçilen seçeneği (shared TraceSchema `recommendedOptionId` / `chosenOptionId`): panelin
 * "önerilenden farklı seçti" rozeti (§10.3-1, E-5). Yalnız izden türetilir ve yalnız gösterimdir; LLM'in seçimini
 * sınırlayan korumalar araç katmanındadır (src/tools/pilotTools.ts).
 *
 * Kural: adımlar sırayla taranır. Bir karar adımı, ondan önceki son geçerli `kural_danis`'in `allowed` listesindeki bir
 * seçeneğe eşlenirse seçimdir; turun böyle İLK kararı seçilir ve öneri o `kural_danis`'ten alınır:
 *   izin_iste (REFUSED değil) → BUY_<tür>_<tutar> · kullaniciya_sor → ASK · bitir → BITIR ·
 *   bekle(n) → WAIT_<n>; WAIT_<n> izinli değil ve BEKLE izinliyse → BEKLE.
 * Hata veren ya da izinli seçeneğe eşlenmeyen adım seçim sayılmaz (ör. kandırılmış LLM'in 40.000 TL isteği).
 */
import { KuralDanisOutputSchema, buyOptionId, type KuralDanisOutput, type TraceStep } from "@pilot/shared";

export interface TurnChoice {
  recommendedOptionId?: string;
  chosenOptionId?: string;
}

function decisionOf(s: TraceStep, allowed: readonly string[]): string | null {
  if (s.error) return null;
  const i = s.in ?? {};
  switch (s.tool) {
    case "izin_iste": {
      if (s.out?.status === "REFUSED") return null;
      try {
        return buyOptionId(i.amountTL as number, i.ordType as "ioc" | "post_only");
      } catch {
        return null;
      }
    }
    case "kullaniciya_sor":
      return "ASK";
    case "bitir":
      return "BITIR";
    case "bekle": {
      const wait = `WAIT_${String(i.dakika)}`;
      if (allowed.includes(wait)) return wait;
      return allowed.includes("BEKLE") ? "BEKLE" : null;
    }
    default:
      return null;
  }
}

export function turnChoice(steps: readonly TraceStep[]): TurnChoice {
  // İleri tarama: karar, o ana kadarki son geçerli kural_danis'e göre değerlendirilir. İzinli seçeneğe eşlenen İLK karar
  // turun seçimidir; uygulanmış bir alımdan sonra turu kapatan bekle seçim sayılmaz (E-5).
  let advice: KuralDanisOutput | null = null;
  for (const s of steps) {
    if (s.tool === "kural_danis") {
      const p = s.error ? null : KuralDanisOutputSchema.safeParse(s.out);
      if (p?.success) advice = p.data;
      continue;
    }
    if (!advice) continue;
    const id = decisionOf(s, advice.allowed);
    if (id !== null && advice.allowed.includes(id)) return { recommendedOptionId: advice.recommended, chosenOptionId: id };
  }
  return advice ? { recommendedOptionId: advice.recommended } : {};
}
