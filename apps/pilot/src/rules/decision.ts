/**
 * `kural_danis` karar tablosu (SPEC §10.4; alıcı Elif). Saf fonksiyon: G/Ç yok, saat yok, rastgelelik yok.
 * LLM tabloyu değiştiremez; yalnız `allowed` içinden seçer (§10.2 `izin_iste` koruması bu çıktıya bakar).
 *
 * Fail-closed (CLAUDE.md kural 2): girdi şemaya uymazsa, kendi içinde çelişkiliyse ya da hesap hata verirse
 * çıktıda HİÇBİR BUY seçeneği olmaz; tek seçenek kısa bir beklemedir (HOLD).
 *
 * Sıra (§10.4, ek güvenlik satırları işaretli):
 *   [ek] girdi doğrulanamadı → HOLD
 *   [ek] plan etkin değil (§16 #14) → HOLD
 *   hedef tamam → BITIR
 *   [ek] kalan ≤ 0 ama izinler sonuçlanmadı → HOLD
 *   pencere açılmadı → BEKLE
 *   [ek] pencere kapandı (son gün geçti ya da döngü kapalı, kontrat kod 2 verir) → BEKLE
 *   son güne < 24 sa → BUY(chunk, ioc)
 *   hava sınıfına göre tablo (+ §10.4 soru zaman aşımı)
 */
import { z } from "zod";
import {
  CycleSchema,
  HOUR_SEC,
  KuralDanisOutputSchema,
  OptionIdSchema,
  PLAN_DAY_MAX,
  PLAN_DAY_MIN,
  PlanSchema,
  UnixMsSchema,
  UnixSecSchema,
  WeatherSchema,
  cycleIdOf,
  halfTL,
  hoursToDeadline,
  hoursToSec,
  minutesToMs,
  minutesToSec,
  optionId,
  optionText,
  parseOptionId,
  secToMinutesCeil,
  secToMs,
  trDay,
  type KuralDanisOutput,
  type Option,
  type OrdType,
  type TL,
} from "@pilot/shared";

// ─────────────────────────────── Sabitler ───────────────────────────────

/** §10.4 "Soru zaman aşımı": Elif 2 saat içinde cevap vermezse varsayılan "yarısını al (post_only)". */
export const QUESTION_TIMEOUT_SEC = hoursToSec(2);

/** §10.4: son güne bu kadar saatten az kaldıysa her durumda BUY(chunk, ioc). */
export const DEADLINE_RUSH_H = 24;

/**
 * Hava durumu en fazla bu kadar eski olabilir; daha eskisi ya da gelecekten geleni → HOLD.
 * TODO(spec): SPEC karar tablosu için tazelik sınırı vermiyor. Döngü her 5 dk mum kapanışından 5 sn sonra çalışır
 * (§10.1); en dar seçim iki mum (10 dk).
 */
export const MAX_WEATHER_AGE_MS = minutesToMs(10);

/**
 * Fail-closed bekleme süresi (dk). TODO(spec): SPEC süre vermiyor; en dar seçim bir döngü periyodu (§10.1: 5 dk).
 */
export const HOLD_WAIT_MIN = 5;

// ─────────────────────────────── Metinler ───────────────────────────────

/** Gerekçeler. §10.4'te yazılı olanlar birebir; diğerleri TODO(spec) ile işaretli. */
export const DECISION_REASONS = {
  // §10.4
  done: "Bu ayın hedefi tamam",
  notOpen: "Pencere açılmadı",
  deadline: "Son güne 24 saatten az kaldı",
  kriptoWait: "Fiyat geçici olarak şişkin; geçmişte geri indi",
  kriptoMaxWait: "En fazla bekleme süresi doldu",
  primAsk: "Hafta sonu yükselişi; tür kesin değil, Elif'e soruyorum",
  primSplit: "Hafta sonu yükselişi; risk bölünüyor",
  liraShock: "Lira şoku; beklemek sıçrama riskini taşımak demek",
  tlStronger: "USDT ucuzladı; geçmişte 24 saatte toparlandı",
  uncertain: "Tür belirsiz",
  clear: "Hava açık; lira kayması beklemeyi pahalı yapıyor",
  // §10.4 "Soru zaman aşımı"
  questionTimeout: "Elif 2 saat içinde cevap vermedi; varsayılan: yarısını al",
  // TODO(spec): aşağıdaki durumlar §10.4'te metinle yazılı değil.
  invalidInput: "Girdi doğrulanamadı; emir yok",
  planInactive: "Plan etkin değil; emir yok",
  reservedPending: "Hedefin kalanı verilmiş izinlerde; sonuçları bekleniyor",
  closed: "Pencere kapandı; bu ayın son günü geçti",
  questionPending: "Elif'e soruldu; cevabı bekleniyor",
  halfTaken: "Yarısı alındı; kalan yarı fırtına bitince değerlendirilecek",
} as const;

// ─────────────────────────────── Girdi ───────────────────────────────

/**
 * Elif'e sorulan soru (§10.2 `kullaniciya_sor`). Bir fırtına bölümüne bağlıdır (`episodeStartTs` = Weather
 * `episode.startTs`); başka bölümün sorusu yok sayılır.
 * - PENDING: soruldu, cevap yok. 2 sa dolunca §10.4 varsayılanı (yarısını al).
 * - ANSWERED: Elif bir seçenek seçti (seçenek kimliği, §15). Yalnız tablonun bu an izin verdiği ASK dışı bir
 *   seçenekse uygulanır; değilse yok sayılır ve tablo yeniden sorar.
 *   TODO(spec): SPEC cevabın ne kadar geçerli olduğunu yazmıyor. En dar seçim: WAIT_<n> cevabı cevaptan n dk sonra
 *   biter (sonra yeniden sorulur); BUY cevabı uygulandıktan sonra çağıran `halfTakenEpisodeTs`'i doldurur.
 */
export const PendingQuestionSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("PENDING"), episodeStartTs: UnixMsSchema, askedAtSec: UnixSecSchema }),
  z.strictObject({
    status: z.literal("ANSWERED"),
    episodeStartTs: UnixMsSchema,
    askedAtSec: UnixSecSchema,
    answer: OptionIdSchema,
    answeredAtSec: UnixSecSchema,
  }),
]);
export type PendingQuestion = z.infer<typeof PendingQuestionSchema>;

/**
 * Karar girdisi. Plan ve döngü zincirden (`plans(user)`, `isPlanActive(user)`, `cycles(user)`), hava §11'den.
 *
 * `halfTakenEpisodeTs`: PRIM_SISMESI / BELIRSIZ bölümünde "yarısı" alındıysa (soru zaman aşımı, Elif'in cevabı ya da
 * askMode kapalıyken PRIM yarısı) o bölümün `startTs`'i. §10.4: "kalan yarı fırtına bitince değerlendirilir".
 * TODO(spec): SPEC bu durumun nerede tutulacağını yazmıyor; çağıran (araç katmanı) tutar, tablo yalnız okur.
 *
 * `waitedH` (§10.4) girdi değildir: bölümün başından (`episode.startTs`) bu yana geçen saat olarak hesaplanır.
 * TODO(spec): SPEC `waitedH`'yi tanımlamıyor; en dar seçim doğrulanmış hava verisinden türetmek (çağırana güvenmez).
 */
export const DecisionInputSchema = z
  .strictObject({
    nowSec: UnixSecSchema,
    planActive: z.boolean(),
    plan: PlanSchema,
    cycle: CycleSchema,
    weather: WeatherSchema,
    question: PendingQuestionSchema.nullable(),
    halfTakenEpisodeTs: UnixMsSchema.nullable(),
  })
  .superRefine((i, ctx) => {
    const bad = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
    const nowMs = secToMs(i.nowSec);
    const p = i.plan;
    // Kontrattaki _validate ile aynı (FlightPlan.sol): zincirdeki plan bunu zaten sağlar; sağlamıyorsa veri bozuk.
    if (p.cycleTL < 1 || p.maxOrderTL < 1 || p.maxOrderTL > p.cycleTL) bad(["plan"], "tutarlar tutarsız");
    if (p.startDay < PLAN_DAY_MIN || p.startDay > p.deadlineDay || p.deadlineDay > PLAN_DAY_MAX) {
      bad(["plan"], "pencere günleri tutarsız");
    }
    // cycles(user) her zaman şimdiki TR ayının döngüsünü döndürür; başka ay → bayat okuma.
    if (i.cycle.id !== cycleIdOf(i.nowSec)) bad(["cycle", "id"], "döngü şimdiki aya ait değil");
    const age = nowMs - i.weather.ts;
    if (age < 0 || age > MAX_WEATHER_AGE_MS) bad(["weather", "ts"], "hava durumu bayat ya da gelecekten");
    const q = i.question;
    if (q) {
      if (q.askedAtSec > i.nowSec || secToMs(q.askedAtSec) < q.episodeStartTs) bad(["question"], "soru zamanı tutarsız");
      if (q.status === "ANSWERED" && (q.answeredAtSec < q.askedAtSec || q.answeredAtSec > i.nowSec)) {
        bad(["question"], "cevap zamanı tutarsız");
      }
    }
    if (i.halfTakenEpisodeTs !== null && i.halfTakenEpisodeTs > nowMs) bad(["halfTakenEpisodeTs"], "gelecekten");
  });
export type DecisionInput = z.infer<typeof DecisionInputSchema>;

// ─────────────────────────────── Çıktı ───────────────────────────────

/** §10.4 dönüşü: izinli seçenekler, önerilen (her zaman allowed içinde) ve Türkçe gerekçe. */
export interface Decision {
  allowed: Option[];
  recommended: Option;
  reason: string;
}

const buy = (amountTL: TL, ordType: OrdType): Option => ({ kind: "BUY", amountTL, ordType });
const wait = (minutes: number): Option => ({ kind: "WAIT", minutes });
const ASK: Option = { kind: "ASK" };
const BEKLE: Option = { kind: "BEKLE" };
const BITIR: Option = { kind: "BITIR" };

const one = (o: Option, reason: string): Decision => ({ allowed: [o], recommended: o, reason });
const some = (allowed: Option[], recommended: Option, reason: string): Decision => ({ allowed, recommended, reason });
const hold = (reason: string): Decision => one(wait(HOLD_WAIT_MIN), reason);

// ─────────────────────────────── Tablo ───────────────────────────────

function table(i: DecisionInput): Decision {
  const { nowSec, plan, cycle, weather: wx } = i;
  const R = DECISION_REASONS;

  if (!i.planActive || nowSec >= plan.expiresAt) return hold(R.planInactive);

  // TODO(spec): §10.4 `remaining <= 0 → BITIR`. "Hedef tamam" yalnız spentTL ≥ cycleTL iken doğrudur; izinli ama
  // sonuçlanmamış tutar kısmi dolar ya da iptal olursa kalan geri açılır. En dar seçim: o durumda BITIR değil HOLD.
  if (cycle.spentTL >= plan.cycleTL) return one(BITIR, R.done);
  const remaining = plan.cycleTL - cycle.spentTL - cycle.reservedTL;
  if (remaining <= 0) return hold(R.reservedPending);

  const day = trDay(nowSec);
  if (day < plan.startDay) return one(BEKLE, R.notOpen);
  // TODO(spec): §10.4 pencere sonrasını yazmıyor; yazılı kodla hoursToDeadline negatif olur ve BUY verir
  // (kontrat OUTSIDE_WINDOW ile reddeder). En dar seçim: pencere kapandı → BEKLE (sonraki ayın penceresi).
  if (day > plan.deadlineDay || cycle.closed) return one(BEKLE, R.closed);

  const chunk = Math.min(plan.maxOrderTL, remaining);
  // TODO(spec): chunk = 1 TL iken yarısı 0 olur; geçerli emir tutarı en az 1 TL (halfTL aşağı yuvarlar).
  const half = Math.max(1, halfTL(chunk));

  if (hoursToDeadline(nowSec, plan.deadlineDay) < DEADLINE_RUSH_H) return one(buy(chunk, "ioc"), R.deadline);

  if (wx.class === "NORMAL") return some([buy(chunk, "post_only"), wait(30)], buy(chunk, "post_only"), R.clear);

  const ep = wx.episode;
  if (ep === null) return hold(R.invalidInput); // şema bunu engeller; tip daraltma için
  const halfTaken = i.halfTakenEpisodeTs === ep.startTs;

  switch (wx.class) {
    case "KRIPTO_SISMESI": {
      const waitedH = (secToMs(nowSec) - ep.startTs) / secToMs(HOUR_SEC);
      return waitedH < plan.maxWaitH
        ? some([wait(60), buy(half, "post_only")], wait(60), R.kriptoWait)
        : one(buy(chunk, "post_only"), R.kriptoMaxWait);
    }
    case "PRIM_SISMESI": // hafta sonu, BTC sakin: dayanağı yalnız 3 olay; gerçek lira şoku da olabilir (v4.1)
      if (halfTaken) return one(wait(60), R.halfTaken);
      return plan.askMode
        ? withQuestion(i, ep.startTs, half, some([ASK, wait(60), buy(half, "post_only")], ASK, R.primAsk))
        : one(buy(half, "post_only"), R.primSplit);
    case "LIRA_ZAYIFLADI":
      return some([buy(chunk, "ioc"), buy(chunk, "post_only")], buy(chunk, "ioc"), R.liraShock);
    case "TL_GUCLENDI":
      return some([buy(chunk, "ioc"), buy(chunk, "post_only")], buy(chunk, "post_only"), R.tlStronger);
    case "BELIRSIZ":
      if (halfTaken) return one(wait(60), R.halfTaken);
      return plan.askMode
        ? withQuestion(i, ep.startTs, half, some([ASK, buy(half, "post_only"), wait(60)], ASK, R.uncertain))
        : one(wait(60), R.uncertain);
  }
}

/** Soran dallarda (PRIM_SISMESI / BELIRSIZ, askMode açık) bekleyen soru ve §10.4 zaman aşımı. */
function withQuestion(i: DecisionInput, episodeStartTs: number, half: TL, base: Decision): Decision {
  const q = i.question;
  if (q === null || q.episodeStartTs !== episodeStartTs) return base;

  if (q.status === "PENDING") {
    const elapsed = i.nowSec - q.askedAtSec;
    if (elapsed >= QUESTION_TIMEOUT_SEC) return one(buy(half, "post_only"), DECISION_REASONS.questionTimeout);
    // Aynı soruyu yeniden sorma; zaman aşımına kadar (en fazla 60 dk) bekle.
    return one(wait(Math.min(60, secToMinutesCeil(QUESTION_TIMEOUT_SEC - elapsed))), DECISION_REASONS.questionPending);
  }

  const id = q.answer;
  if (!base.allowed.some((o) => o.kind !== "ASK" && optionId(o) === id)) return base;
  const answer = parseOptionId(id);
  if (answer.kind === "WAIT" && i.nowSec >= q.answeredAtSec + minutesToSec(answer.minutes)) return base;
  return one(answer, `Elif'in cevabı: ${optionText(answer)}`);
}

// ─────────────────────────────── Dışa açık ───────────────────────────────

function toOutput(d: Decision): KuralDanisOutput {
  return KuralDanisOutputSchema.parse({
    allowed: d.allowed.map(optionId),
    recommended: optionId(d.recommended),
    reason: d.reason,
  });
}

/**
 * Karar tablosu (§10.4). Girdi `unknown`'dır ve burada doğrulanır; hiçbir yol hata fırlatmaz.
 * Çıktı her zaman KuralDanisOutputSchema'ya uyar; doğrulanamayan her durumda BUY yoktur.
 */
export function decide(raw: unknown): Decision {
  try {
    const parsed = DecisionInputSchema.safeParse(raw);
    if (!parsed.success) return hold(DECISION_REASONS.invalidInput);
    const d = table(parsed.data);
    toOutput(d); // çıktı şeması: kimlikler geçerli, tekrarsız, recommended ∈ allowed
    return d;
  } catch {
    return hold(DECISION_REASONS.invalidInput);
  }
}

/** `kural_danis` aracının çıktısı (§10.2, §15 iz biçimi: seçenek kimlikleri). */
export function kuralDanis(raw: unknown): KuralDanisOutput {
  return toOutput(decide(raw));
}
