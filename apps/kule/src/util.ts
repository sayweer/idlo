/** Saat ve küçük yardımcılar. Birim dönüşümleri yalnız @pilot/shared units.ts'te (CLAUDE.md kural 7). */

/** Saat: canlıda sistem saati, testte elle ilerletilen saat. OKX ms. */
export interface Clock {
  nowMs(): number;
}
export const systemClock: Clock = { nowMs: () => Date.now() };

export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ondalık string'in kesirini n haneye KESER (yuvarlama yok); sonra units.ts ile çevrilir. Boş/undefined → "0". */
export function truncDecimal(s: string | undefined | null, maxFrac: number): string {
  if (typeof s !== "string" || s === "") return "0";
  const m = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) throw new RangeError(`ondalık biçim geçersiz: ${s}`);
  const frac = (m[2] ?? "").slice(0, maxFrac).replace(/0+$/, "");
  return frac ? `${m[1]}.${frac}` : m[1]!;
}

/** Günlükten gizli değerleri ayıklar (CLAUDE.md kural 5): anahtar adı gizli sözcük içeriyorsa değer yazılmaz. */
const SECRET_KEY_RE = /(key|secret|passphrase|token|signature|authorization|password|private)/i;
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[derin]";
  if (typeof value === "string") return value.length > 2000 ? value.slice(0, 2000) + "…" : value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) ? "[gizli]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Hata → günlüğe yazılabilir kısa metin (yığın ve neden zinciri hariç). */
export function errText(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`.slice(0, 500);
  return String(e).slice(0, 500);
}
