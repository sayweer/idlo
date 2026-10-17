/**
 * Ajan seçme dizini şemaları (HANDOFF §5 KARAR: ajan seçme sohbeti + ERC-8004 eşiği MVP'si).
 * Aday → eşik (kod) → sıralama (LLM, yalnız kalanlar) → seçim. Güvenlik kararı kodda; LLM çıktısı her zaman zod'dan geçer.
 * Kullanıcıya görünen metinler Türkçe (CLAUDE.md kural 10).
 */
import { z } from "zod";
import { AddressSchema, PositiveTLSchema, Uint256StringSchema } from "../schemas/primitives.js";
import { AgentCardSchema } from "./agentCard.js";

// ───────────────────────────── Eşikler ─────────────────────────────

/**
 * TODO(spec): SPEC eşik vermiyor; değerler en dar makul seçim. Puan ölçeği: Reputation `getSummary` değeri
 * `value / 10^decimals` (örnek: 9500, 2 basamak → 95,00); 0–100 beklenir. Demo için `screen(…, thresholds)` ile gevşetilir.
 */
export const MIN_FEEDBACK = 3;
export const MIN_SCORE = 70;
/**
 * Tek cüzdan tek başına itibar üretemesin: geri bildirim VEREN farklı doğrulanmış kullanıcı sayısının alt sınırı
 * (Candidate.feedbackClients). Bir müşterinin çok sayıda geri bildirimi bu sayıyı artırmaz.
 * TODO(spec): SPEC eşik vermiyor; en dar seçim 2. Tek müşterili demo için `screen(…, { minVerifiedClients: 1 })`
 * açıkça verilir ve ekranda belirtilmelidir.
 */
export const MIN_VERIFIED_CLIENTS = 2;
/** getSummary çağrısına giden istemci listesi üst sınırı (eth_call boyutu). TODO(spec): SPEC vermiyor. */
export const MAX_VERIFIED_CLIENTS = 200;

export interface Thresholds {
  minFeedback: number;
  minScore: number;
  minVerifiedClients: number;
}
export const DEFAULT_THRESHOLDS: Thresholds = Object.freeze({
  minFeedback: MIN_FEEDBACK,
  minScore: MIN_SCORE,
  minVerifiedClients: MIN_VERIFIED_CLIENTS,
});

/** Puan ölçeği: ERC-8004 özet değeri 0–100 olarak okunur; dışı geçersiz sayılır (reputation.ts). */
export const SCORE_MIN = 0;
export const SCORE_MAX = 100;

/** Sunum etiketi: DEMO adaylar ekranda açıkça etiketlenir (CLAUDE.md kural 12). */
export const DEMO_LABEL_TR = "DEMO";

// ───────────────────────────── Aday ─────────────────────────────

export const CandidateSchema = z.strictObject({
  agentId: Uint256StringSchema,
  /** Yapılandırılmış listede DEMO işaretli mi (kartın beyanı değil, koddaki liste). */
  demo: z.boolean(),
  /** Bir zincir okuması başarısız oldu (RPC/ağ); "yok" değil "bilinmiyor": aday elenir (fail-closed). */
  readFailed: z.boolean(),
  /** Identity kaydında `ownerOf(agentId)` çözüldü mü. */
  hasIdentity: z.boolean(),
  owner: AddressSchema.nullable(),
  /** Identity `getMetadata(agentId, "agentWallet")`; yoksa ya da 20 bayt değilse null. */
  agentWallet: AddressSchema.nullable(),
  /** Geçerli `agent.json`; alınamadıysa/geçersizse null (`cardIssueTr` nedeni söyler). */
  card: AgentCardSchema.nullable(),
  cardIssueTr: z.string().max(300).nullable(),
  /** Zincirden doğrulanmış kullanıcılar (yalnız bunların puanı sayılır). */
  verifiedClients: z.array(AddressSchema).max(MAX_VERIFIED_CLIENTS),
  /** getSummary sayısı (geri bildirim ADEDİ, müşteri sayısı değil); doğrulanmış kullanıcı yoksa çağrılmaz ve 0'dır. */
  feedbackCount: z.int().nonnegative(),
  /** Doğrulanmış kullanıcılar arasında en az bir geri bildirim vermiş FARKLI kullanıcı sayısı (alt sınır). */
  feedbackClients: z.int().nonnegative().max(MAX_VERIFIED_CLIENTS),
  /** value / 10^decimals, 0–100; geri bildirim yoksa null. */
  score: z.number().finite().min(SCORE_MIN).max(SCORE_MAX).nullable(),
  /** Okuma hataları ve uyarılar (Türkçe, günlük için): sessizce yutulmaz. */
  issuesTr: z.array(z.string().max(300)).max(20),
});
export type Candidate = z.infer<typeof CandidateSchema>;

// ───────────────────────────── Eşik sonucu ─────────────────────────────

export const ELIMINATION_CODES = [
  "NO_IDENTITY",
  "NO_AGENT_WALLET",
  "INVALID_CARD",
  "CHAIN_UNREADABLE",
  "TOO_FEW_FEEDBACK",
  "LOW_SCORE",
] as const;
export type EliminationCode = (typeof ELIMINATION_CODES)[number];

export const EliminatedSchema = z.strictObject({
  agentId: Uint256StringSchema,
  demo: z.boolean(),
  nameTr: z.string().max(200).nullable(),
  code: z.enum(ELIMINATION_CODES),
  reasonTr: z.string().min(1).max(400),
});
export type Eliminated = z.infer<typeof EliminatedSchema>;

export const ScreenResultSchema = z.strictObject({
  kept: z.array(CandidateSchema),
  eliminated: z.array(EliminatedSchema),
});
export type ScreenResult = z.infer<typeof ScreenResultSchema>;

// ───────────────────────────── Kullanıcı ihtiyacı ─────────────────────────────

export const NEED_LIMITS = { summary: 300, keywords: 8, keyword: 40, questions: 5, question: 200 } as const;

export const UserNeedSchema = z.strictObject({
  /** Kullanıcının derdinin kısa Türkçe özeti. */
  summaryTr: z.string().trim().min(1).max(NEED_LIMITS.summary),
  keywords: z.array(z.string().trim().min(1).max(NEED_LIMITS.keyword)).max(NEED_LIMITS.keywords),
  /** Metinde açıkça geçen aylık tutar (tam lira); yoksa null. Kod, metinde olmayan sayıyı null'a çevirir. */
  amountTL: PositiveTLSchema.nullable(),
  /** Anlaşılmayan yerler için kısa sorular. */
  questions: z.array(z.string().trim().min(1).max(NEED_LIMITS.question)).max(NEED_LIMITS.questions),
  /** "llm": LLM yapılandırdı; "fallback": LLM yok ya da çıktı geçersiz, ham metin özet olarak alındı. */
  source: z.enum(["llm", "fallback"]),
});
export type UserNeed = z.infer<typeof UserNeedSchema>;

/** LLM'in üreteceği kısım (source'u kod ekler). */
export const UserNeedLlmSchema = UserNeedSchema.omit({ source: true });
export type UserNeedLlm = z.infer<typeof UserNeedLlmSchema>;

// ───────────────────────────── Sıralama ─────────────────────────────

const MAX_RATIONALE_CHARS = 300;
const MAX_RATIONALE_SENTENCES = 2;

/** Türkçe/Latin cümle sayısı: . ! ? … ile biten parçalar ("%3,5" gibi ondalıklar bölmez). */
export function sentenceCount(text: string): number {
  return text
    .split(/[.!?…]+(?=\s|$)/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0).length;
}

/** İzinli karakterler: harf, rakam, boşluk ve Türkçe düz yazı noktalaması. `@ [ ] < > \ ` | { } # * _ ~ ^ =` ve görünmez/biçim karakterleri yok. */
const RATIONALE_ALLOWED = /^[\p{L}\p{N}\s.,;:!?'’"%+\-–…/()]+$/u;
/** Çıplak alan adı (`evil.com`, `t.me/x`): harf/rakam + nokta + en az 2 harf, boşluksuz. */
const BARE_DOMAIN = /[\p{L}\p{N}-]+\.\p{L}{2,}/u;

/** Gerekçe düz metin mi: adres, bağlantı, alan adı, kullanıcı adı ya da biçimlendirme taşımıyor. */
export function isPlainRationale(s: string): boolean {
  if (!RATIONALE_ALLOWED.test(s)) return false;
  if (/\/\/|0x[0-9a-f]{4,}|https?:|www\./i.test(s)) return false;
  return !BARE_DOMAIN.test(s);
}

/**
 * Gerekçe: ≤2 cümle Türkçe düz metin; adres, bağlantı, çıplak alan adı, @kullanıcı ya da markdown içeremez
 * (LLM adres seçmez). İzin listesi mantığı: tanımadığımız karakter gerekçeyi geçersiz kılar (kural gerekçesine düşer).
 */
export const RationaleSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_RATIONALE_CHARS)
  .refine((s) => sentenceCount(s) <= MAX_RATIONALE_SENTENCES, { message: "gerekçe en fazla 2 cümle olmalı" })
  .refine(isPlainRationale, { message: "gerekçe düz metin olmalı: adres, bağlantı, alan adı ya da biçimlendirme yok" });

export const RankedAgentSchema = z.strictObject({
  agentId: Uint256StringSchema,
  rationaleTr: RationaleSchema,
  /** "llm": gerekçeyi LLM yazdı; "rule": kod (puana göre / LLM dışı). */
  source: z.enum(["llm", "rule"]),
});
export type RankedAgent = z.infer<typeof RankedAgentSchema>;

export const RankingOutputSchema = z.strictObject({
  /** "llm": sıra LLM'den; "rule": LLM yok ya da çıktı geçersiz, puana göre. */
  source: z.enum(["llm", "rule"]),
  items: z.array(RankedAgentSchema),
});
export type RankingOutput = z.infer<typeof RankingOutputSchema>;

/** LLM'in ürettiği ham sıralama (agentId'ler adaylara karşı kodda doğrulanır). */
export const LlmRankingSchema = z.strictObject({
  ranked: z
    .array(z.strictObject({ agentId: Uint256StringSchema, rationaleTr: RationaleSchema }))
    .min(1)
    .max(50),
});
export type LlmRanking = z.infer<typeof LlmRankingSchema>;

// ───────────────────────────── Uçtan uca çıktı ─────────────────────────────

export const SelectionResultSchema = z.strictObject({
  need: UserNeedSchema,
  screen: ScreenResultSchema,
  ranking: RankingOutputSchema,
  /** Kullanıcıya gösterilebilir Türkçe notlar (ör. "LLM yok: sıralama puana göre"). */
  notesTr: z.array(z.string().max(300)).max(10),
});
export type SelectionResult = z.infer<typeof SelectionResultSchema>;
