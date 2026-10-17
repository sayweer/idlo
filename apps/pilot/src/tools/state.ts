/**
 * Turlar arası PİLOT durumu: Elif'e sorulan soru, "yarısı alındı" bölümü ve bu PİLOT'un aldığı izinler.
 * Karar tablosu (src/rules) bunları yalnız okur; araç katmanı yazar (C3 notu).
 *
 * TODO(spec): SPEC bu durumun kalıcılığını yazmıyor. Bellekte tutulur; yeniden başlamada soru yeniden sorulur,
 * izinler zincirde kalır (KULE ALREADY_EXECUTED ile çift uygulamayı zaten engeller). Kalıcı kayıt C5'e bırakıldı.
 */
import type { OrdType, TL, UnixMs, UnixSec } from "@pilot/shared";
import type { PendingQuestion } from "../rules/index.js";

export interface QuestionRecord {
  questionId: string;
  soru: string;
  secenekler: string[];
  episodeStartTs: UnixMs;
  askedAtSec: UnixSec;
  answer: string | null;
  answeredAtSec: UnixSec | null;
}

export interface AuthorizationRecord {
  actionId: string;
  amountTL: TL;
  ordType: OrdType;
  openBy: UnixSec;
  /** emri_uygula ONAY ya da KULE ALREADY_EXECUTED döndürdü. */
  executed: boolean;
}

export class PilotState {
  question: QuestionRecord | null = null;
  halfTakenEpisodeTs: UnixMs | null = null;
  readonly authorizations = new Map<string, AuthorizationRecord>();
  private questionSeq = 0;

  /** Karar tablosu girdisi (DecisionInput.question). */
  pendingQuestion(): PendingQuestion | null {
    const q = this.question;
    if (!q) return null;
    if (q.answer === null || q.answeredAtSec === null) {
      return { status: "PENDING", episodeStartTs: q.episodeStartTs, askedAtSec: q.askedAtSec };
    }
    return { status: "ANSWERED", episodeStartTs: q.episodeStartTs, askedAtSec: q.askedAtSec, answer: q.answer, answeredAtSec: q.answeredAtSec };
  }

  ask(q: Omit<QuestionRecord, "questionId" | "answer" | "answeredAtSec">): QuestionRecord {
    this.question = { ...q, questionId: `q${++this.questionSeq}`, answer: null, answeredAtSec: null };
    return this.question;
  }

  /**
   * Elif'in panelden cevabı. Yalnız bekleyen sorunun kimliği ve o soruda sunulan seçeneklerden biri kabul edilir
   * (§10.2 "Seçenekler sabit listeden"). Kabul edilmezse false; durum değişmez.
   */
  answer(questionId: string, optionId: string, atSec: UnixSec): boolean {
    const q = this.question;
    if (!q || q.questionId !== questionId || q.answer !== null) return false;
    if (!q.secenekler.includes(optionId)) return false;
    if (!Number.isSafeInteger(atSec) || atSec < q.askedAtSec) return false;
    q.answer = optionId;
    q.answeredAtSec = atSec;
    return true;
  }
}
