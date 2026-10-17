/**
 * Eşik (HANDOFF §5 KARAR madde 3): saf kod, LLM yok, ağ yok. Kimliksiz, cüzdansız, kartı geçersiz, doğrulanmış
 * geri bildirimi az ya da puanı düşük aday elenir. Kalanlar yalnız sıralama için LLM'e gider.
 * DEMO etiketi (koddaki listeden) hem kalanlarda hem elenenlerde korunur.
 */
import {
  DEFAULT_THRESHOLDS,
  ScreenResultSchema,
  type Candidate,
  type Eliminated,
  type EliminationCode,
  type ScreenResult,
  type Thresholds,
} from "@pilot/shared";

/** 95 → "95", 72.5 → "72,5" (Türkçe ondalık virgül). */
function num(n: number): string {
  return String(Math.round(n * 100) / 100).replace(".", ",");
}

function nameOf(c: Candidate): string | null {
  return c.card?.name ?? null;
}

function eliminate(c: Candidate, code: EliminationCode, reasonTr: string): Eliminated {
  return { agentId: c.agentId, demo: c.demo, nameTr: nameOf(c), code, reasonTr };
}

/** İlk başarısız kural elenme nedenidir (sıra: okuma → kimlik → cüzdan → kart → geri bildirim → puan). */
export function eliminationOf(c: Candidate, t: Thresholds): Eliminated | null {
  if (c.readFailed) {
    return eliminate(c, "CHAIN_UNREADABLE", "Zincir okunamadığı için doğrulanamadı; emin olunamayan ajan elenir.");
  }
  if (!c.hasIdentity) return eliminate(c, "NO_IDENTITY", "ERC-8004 kimliği yok.");
  if (c.agentWallet === null) return eliminate(c, "NO_AGENT_WALLET", "Kimlikte ajan cüzdanı (agentWallet) tanımlı değil.");
  if (c.card === null) return eliminate(c, "INVALID_CARD", c.cardIssueTr ?? "Ajan kartı geçersiz.");
  if (c.verifiedClients.length < t.minVerifiedClients || c.feedbackCount < t.minFeedback) {
    return eliminate(
      c,
      "TOO_FEW_FEEDBACK",
      `Doğrulanmış geri bildirim yetersiz: ${c.feedbackCount} (en az ${t.minFeedback} gerekli; yalnız bu ajanla gerçekten işlem yapmış kullanıcılar sayılır).`,
    );
  }
  if (c.score === null || c.score < t.minScore) {
    return eliminate(
      c,
      "LOW_SCORE",
      `Puan eşiğin altında: ${c.score === null ? "yok" : num(c.score)} (en az ${num(t.minScore)} gerekli).`,
    );
  }
  return null;
}

export function screen(candidates: readonly Candidate[], thresholds: Partial<Thresholds> = {}): ScreenResult {
  const t: Thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  for (const v of [t.minFeedback, t.minScore, t.minVerifiedClients]) {
    if (!Number.isFinite(v)) throw new RangeError("eşikler sonlu sayı olmalı");
  }
  const kept: Candidate[] = [];
  const eliminated: Eliminated[] = [];
  for (const c of candidates) {
    const e = eliminationOf(c, t);
    if (e === null) kept.push(c);
    else eliminated.push(e);
  }
  return ScreenResultSchema.parse({ kept, eliminated });
}
