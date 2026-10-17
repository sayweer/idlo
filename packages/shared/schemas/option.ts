/**
 * Karar tablosu seçenekleri (§10.4, `kural_danis`). İzde ve araç girdilerinde kimlik string'i kullanılır
 * (§15 örneği: "BUY_IOC_10000", "BUY_POST_10000").
 *
 * Kimlik biçimleri:
 *   BUY_IOC_<amountTL> · BUY_POST_<amountTL> · WAIT_<dakika> · ASK · BEKLE · BITIR
 * TODO(spec): §10.4 `one("BEKLE", "Pencere açılmadı")` için süre vermiyor; ayrı "BEKLE" seçeneği tutuldu.
 */
import { z } from "zod";
import type { OrdType } from "../codes.js";
import { OrdTypeSchema, PositiveTLSchema } from "./primitives.js";

/** `bekle` aracının üst sınırı (§10.2: en fazla 360 dk). */
export const MAX_WAIT_MINUTES = 360;

export const OptionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("BUY"), amountTL: PositiveTLSchema, ordType: OrdTypeSchema }),
  z.strictObject({ kind: z.literal("WAIT"), minutes: z.int().min(1).max(MAX_WAIT_MINUTES) }),
  z.strictObject({ kind: z.literal("ASK") }),
  z.strictObject({ kind: z.literal("BEKLE") }),
  z.strictObject({ kind: z.literal("BITIR") }),
]);
export type Option = z.infer<typeof OptionSchema>;

const ORD_TAG: Record<OrdType, string> = { ioc: "IOC", post_only: "POST" };
const OPTION_ID_RE = /^(?:BUY_(IOC|POST)_([1-9]\d*)|WAIT_([1-9]\d*)|(ASK|BEKLE|BITIR))$/;

export function optionId(o: Option): string {
  const v = OptionSchema.parse(o);
  switch (v.kind) {
    case "BUY":
      return `BUY_${ORD_TAG[v.ordType]}_${v.amountTL}`;
    case "WAIT":
      return `WAIT_${v.minutes}`;
    default:
      return v.kind;
  }
}

/** Kimlik string'i → seçenek. Geçersiz kimlik fırlatır. */
export function parseOptionId(id: string): Option {
  const m = typeof id === "string" ? OPTION_ID_RE.exec(id) : null;
  if (!m) throw new RangeError(`Seçenek kimliği geçersiz: ${String(id)}`);
  if (m[1] && m[2]) {
    return OptionSchema.parse({ kind: "BUY", ordType: m[1] === "IOC" ? "ioc" : "post_only", amountTL: Number(m[2]) });
  }
  if (m[3]) return OptionSchema.parse({ kind: "WAIT", minutes: Number(m[3]) });
  return OptionSchema.parse({ kind: m[4] });
}

export function isOptionId(id: unknown): id is string {
  try {
    parseOptionId(id as string);
    return true;
  } catch {
    return false;
  }
}

export const OptionIdSchema = z.string().refine(isOptionId, { message: "geçersiz seçenek kimliği" });

/** Alım seçeneğinin kimliği (izin_iste korumasında: tutar + tür bu turdaki allowed listesinde mi?). */
export function buyOptionId(amountTL: number, ordType: OrdType): string {
  return optionId({ kind: "BUY", amountTL, ordType });
}

/** `kural_danis` çıktısı (§10.4): recommended her zaman allowed içindedir. */
export const KuralDanisOutputSchema = z
  .strictObject({
    allowed: z.array(OptionIdSchema).min(1),
    recommended: OptionIdSchema,
    reason: z.string().min(1).max(300),
  })
  .refine((o) => o.allowed.includes(o.recommended), { message: "recommended, allowed içinde olmalı", path: ["recommended"] })
  .refine((o) => new Set(o.allowed).size === o.allowed.length, { message: "allowed tekrarsız olmalı", path: ["allowed"] });
export type KuralDanisOutput = z.infer<typeof KuralDanisOutputSchema>;
