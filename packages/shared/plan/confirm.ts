/**
 * İmza onay penceresi "Zincire yazılacak değerler" (SPEC §2 adım 1–2, §8.1, §8.2, §10.6, §13 `/talimat`).
 *
 * planFromSentence (LLM) bir PlanDraft üretir; imzadan önce Elif `setPlan`'a gidecek değerlerin TAMAMINI görür ve
 * düzeltebilir. Tek kaynak: pencere de imza çağrısı da `setPlanArgs`'ı kullanır; satırlar (`rows`) aynı nesneden
 * türetilir. Pencerede görünmeyen hiçbir değer zincire yazılmaz.
 *
 * Saf fonksiyonlar: ağ, disk ve saat okumaz (`nowSec` çağırandan gelir). Güvenlik kararı LLM'de değildir (kural 1):
 * taslak her hesapta PlanDraftSchema ile yeniden doğrulanır, plan PlanSchema ile kurulur ve FlightPlan._validate'in
 * kuralları ayrıca uygulanır. Emin olunamayan her durumda `signable=false`, `setPlanArgs=null` (kural 2).
 *
 * TODO(spec): SPEC onay penceresini, "senin düzeltmen" kaynağını ve düzeltme akışını tanımlamıyor; ekip kararıyla
 * eklendi. Düzeltilen alan şemaya `source:"user"` olarak gider (PlanDraftSchema iki kaynak bilir), pencerede "edited".
 */
import { getAddress, isAddress, isAddressEqual, zeroAddress } from "viem";
import { AskMode } from "../codes.js";
import type { Deployments } from "../deployments.js";
import {
  PLAN_DAY_MAX,
  PLAN_DAY_MIN,
  PLAN_DEFAULTS,
  PLAN_DRAFT_FIELDS,
  PLAN_EXPIRES_MAX_DAYS,
  PlanDraftSchema,
  PlanSchema,
  planToChain,
  type ChainPlan,
  type Plan,
  type PlanDraft,
} from "../schemas/plan.js";
import {
  assertUnixSec,
  daysToSec,
  formatDecimalTr,
  formatTL,
  hoursToSec,
  scaledToDecimal,
  trParts,
} from "../units.js";

export const CONFIRM_TITLE_TR = "Zincire yazılacak değerler";

/** IFlightPlan.Plan alanları, §8.1 sırasıyla (pencere satırları bu sırada). */
export const PLAN_FIELDS = [
  "cycleTL",
  "maxOrderTL",
  "startDay",
  "deadlineDay",
  "maxWaitH",
  "bandBps",
  "closedBandBps",
  "askMode",
  "expiresAt",
  "agent",
  "kule",
  "agentId",
] as const satisfies readonly (keyof Plan)[];
export type PlanField = (typeof PLAN_FIELDS)[number];

/** Elif'in pencerede düzeltebildiği alanlar. Diğerlerini kod türetir (§10.6). */
export const EDITABLE_PLAN_FIELDS = [
  "cycleTL",
  "maxOrderTL",
  "startDay",
  "deadlineDay",
  "maxWaitH",
  "askMode",
  "expiresAt",
] as const satisfies readonly PlanField[];
export type EditablePlanField = (typeof EDITABLE_PLAN_FIELDS)[number];

type DraftField = (typeof PLAN_DRAFT_FIELDS)[number];

/** Düzenlenen zincir alanının taslaktaki karşılığı. askMode ← askOnAmbiguity, expiresAt ← expiresInDays. */
const DRAFT_FIELD_OF: Record<EditablePlanField, DraftField> = {
  cycleTL: "cycleTL",
  maxOrderTL: "maxOrderTL",
  startDay: "startDay",
  deadlineDay: "deadlineDay",
  maxWaitH: "maxWaitH",
  askMode: "askOnAmbiguity",
  expiresAt: "expiresInDays",
};
const PLAN_FIELD_OF = Object.fromEntries(
  Object.entries(DRAFT_FIELD_OF).map(([p, d]) => [d, p]),
) as Record<DraftField, EditablePlanField>;

/** §8.2 bekleyen plan kilidi (FlightPlan.PENDING_DELAY). */
export const PENDING_DELAY_SEC = hoursToSec(24);

export const PLAN_FIELD_LABELS_TR: Record<PlanField, string> = {
  cycleTL: "Aylık çevrilecek tutar",
  maxOrderTL: "Tek emir tavanı",
  startDay: "Pencere başı",
  deadlineDay: "Son gün",
  maxWaitH: "Fırtınada en fazla bekleme",
  bandBps: "Fiyat bandı",
  closedBandBps: "Piyasa kapalıyken fiyat bandı",
  askMode: "Emin olmazsa sana sorsun",
  expiresAt: "Planın bitişi",
  agent: "PİLOT adresi",
  kule: "KULE adresi",
  agentId: "PİLOT kimliği (ERC-8004)",
};

export type RowSource = "user" | "default" | "edited";

/** Rozet metinleri. `derived`: kodun türettiği, düzenlenemeyen alan (source yine "default"). */
export const CONFIRM_BADGES_TR = {
  user: "senin cümlenden",
  default: "varsayılan",
  edited: "senin düzeltmen",
  derived: "otomatik",
} as const;

export interface ConfirmRow {
  field: PlanField;
  labelTr: string;
  /** Türkçe sayı biçimiyle gösterim; değer yoksa "—". */
  displayTr: string;
  /** setPlanArgs[0][field]'ın ondalık string'i (adres: checksum'lı); değer kurulamadıysa null. */
  chainValue: string | null;
  source: RowSource;
  badgeTr: string;
  editable: boolean;
  /** Bilgi notu (ör. 24 saat uyarısı). */
  note: string | null;
  /** Bu alanı imzaya kapatan hata (blockers'taki metinle aynı). */
  error: string | null;
}

export type ConfirmBlockerCode =
  | "QUESTIONS_OPEN"
  | "MISSING_VALUE"
  | "INVALID_VALUE"
  | "INVALID_DRAFT"
  | "NO_DEPLOYMENT"
  | "NO_AGENT_ID"
  | "INVALID_PLAN";

export interface ConfirmBlocker {
  code: ConfirmBlockerCode;
  field: PlanField | null;
  messageTr: string;
}

/** §8.2 tahmini: anında mı, 24 saat sonra mı. Yalnız bilgidir; gerçek sonuç PlanSet.immediate'tir. */
export interface ActivationPreview {
  immediate: boolean;
  /** Anında ise nowSec; değilse nowSec + 24 sa. */
  activeAtSec: number;
  /** Mevcut plana göre gevşeyen ya da değişmemesi gerekirken değişen alanlar (§8.2, F-3, F-4). */
  loosened: readonly PlanField[];
  textTr: string;
}

export interface PlanConfirmationContext {
  /** Şimdiki zaman, unix saniye (zincir birimi). */
  nowSec: number;
  /** parseDeployments(fuji.json) sonucu; okunamadıysa null (imza kapalı). */
  deployments: Pick<Deployments, "pilotAgent" | "kuleReporter" | "agentId"> | null;
  /** planFromChain(plans(user)); hiç plan yoksa null. agent == 0x0 da "plan yok" sayılır. */
  current: Plan | null;
  /**
   * isPlanActive(user). İptal edilmiş ya da süresi dolmuş plan da `current` olarak gelir (kontratın karşılaştırma
   * tabanı); bu bayrak yalnız metni doğru kurmak içindir. `current` null iken yok sayılır.
   */
  currentActive: boolean;
}

interface ConfirmState {
  readonly draft: PlanDraft;
  readonly values: Readonly<Record<DraftField, number | boolean | null>>;
  /** Çözümlenemeyen düzeltme (ör. "20.000", "abc"); değer null tutulur. */
  readonly unparsable: Readonly<Partial<Record<DraftField, true>>>;
  readonly ctx: PlanConfirmationContext;
}

export interface PlanConfirmation {
  titleTr: typeof CONFIRM_TITLE_TR;
  /** `writeContract({ functionName: "setPlan", args: setPlanArgs })`. Yalnız signable iken dolu; donmuş nesne. */
  setPlanArgs: readonly [ChainPlan] | null;
  rows: readonly ConfirmRow[];
  signable: boolean;
  blockers: readonly ConfirmBlocker[];
  /** Plan değerleri tam kurulduysa §8.2 tahmini; değilse null. */
  activation: ActivationPreview | null;
  questions: readonly string[];
  /** applyEdit'in yeniden hesap girdisi; UI okumaz, değiştirmez. */
  readonly state: ConfirmState;
}

// ───────────────────────────── Kurallar ─────────────────────────────

const MSG = {
  questions: "Önce PİLOT'un sorularını cevapla; sorular cevaplanmadan plan imzalanamaz.",
  missing: "Bu alan boş; PİLOT'un sorusunu cevapla.",
  notDigits: "Geçersiz değer: yalnız rakam yaz (nokta, virgül, eksi işareti yok).",
  notBool: "Geçersiz değer: evet ya da hayır seçilmeli.",
  cyclePositive: "Aylık tutar 0'dan büyük tam lira olmalı.",
  orderPositive: "Tek emir tavanı 0'dan büyük tam lira olmalı.",
  orderOverCycle: "Tek emir tavanı aylık tutarı aşamaz.",
  dayRange: `Gün ${PLAN_DAY_MIN} ile ${PLAN_DAY_MAX} arasında olmalı (her ayda olan günler).`,
  dayOrder: "Son gün, pencere başından önce olamaz.",
  waitRange: "Bekleme en fazla 65.535 saat olabilir.",
  expiresRange: `Plan 1 ile ${PLAN_EXPIRES_MAX_DAYS} gün arasında geçerli olabilir.`,
  draftSchema: "Değerler plan şemasına uymuyor; taslağı yeniden oluştur.",
  noDeployment: "Kontrat adresi okunamadı; imza kapalı.",
  noAgentId: "PİLOT kaydı bekleniyor; imza kapalı.",
  invalidPlan: "Kontrat bu planı kabul etmez (InvalidPlan).",
} as const;

const NOTE = {
  derived: "Kod tarafından belirlenir; düzenlenemez.",
  looser: "Mevcut planından gevşek: bu değişiklik 24 saat bekletir.",
  mustStay: "Mevcut planından farklı: bu alan değişirse plan her zaman 24 saat bekler.",
  capped:
    "Varsayılan süre mevcut planının bitişiyle sınırlandı; böylece plan anında geçer. " +
    "Daha geç bitiş istersen gün sayısını düzelt; bu 24 saat bekletir.",
  expiredBase: "Mevcut planının süresi doldu; yeni bitiş her zaman daha geç olduğundan plan 24 saat bekler.",
} as const;

const MAX_UINT16 = 65535;

function inRange(v: number, min: number, max: number): boolean {
  return Number.isSafeInteger(v) && v >= min && v <= max;
}

/** Alan düzeyinde Türkçe hata. PlanDraftSchema ve FlightPlan._validate ile aynı kurallar (en dar). */
function fieldErrors(s: ConfirmState): Partial<Record<DraftField, string>> {
  const e: Partial<Record<DraftField, string>> = {};
  const v = s.values;
  for (const f of PLAN_DRAFT_FIELDS) {
    if (s.unparsable[f]) e[f] = f === "askOnAmbiguity" ? MSG.notBool : MSG.notDigits;
    else if (v[f] === null) e[f] = MSG.missing;
  }
  const num = (f: DraftField): number | null => {
    const x = v[f];
    return e[f] === undefined && typeof x === "number" ? x : null;
  };
  const cycle = num("cycleTL");
  const order = num("maxOrderTL");
  const start = num("startDay");
  const deadline = num("deadlineDay");
  const wait = num("maxWaitH");
  const days = num("expiresInDays");
  if (cycle !== null && !inRange(cycle, 1, Number.MAX_SAFE_INTEGER)) e.cycleTL = MSG.cyclePositive;
  if (order !== null) {
    if (!inRange(order, 1, Number.MAX_SAFE_INTEGER)) e.maxOrderTL = MSG.orderPositive;
    else if (cycle !== null && e.cycleTL === undefined && order > cycle) e.maxOrderTL = MSG.orderOverCycle;
  }
  if (start !== null && !inRange(start, PLAN_DAY_MIN, PLAN_DAY_MAX)) e.startDay = MSG.dayRange;
  if (deadline !== null) {
    if (!inRange(deadline, PLAN_DAY_MIN, PLAN_DAY_MAX)) e.deadlineDay = MSG.dayRange;
    else if (start !== null && e.startDay === undefined && start > deadline) e.deadlineDay = MSG.dayOrder;
  }
  if (wait !== null && !inRange(wait, 0, MAX_UINT16)) e.maxWaitH = MSG.waitRange;
  if (days !== null && !inRange(days, 1, PLAN_EXPIRES_MAX_DAYS)) e.expiresInDays = MSG.expiresRange;
  if (v.askOnAmbiguity !== null && typeof v.askOnAmbiguity !== "boolean") e.askOnAmbiguity = MSG.notBool;
  return e;
}

/** FlightPlan._validate (IFlightPlan.InvalidPlan TODO'sundaki en dar kurallar), zincir birimleriyle. */
function violatesContractValidate(p: ChainPlan, nowSec: number): boolean {
  return (
    p.cycleTL === 0n ||
    p.maxOrderTL === 0n ||
    p.maxOrderTL > p.cycleTL ||
    p.startDay === 0 ||
    p.startDay > p.deadlineDay ||
    p.deadlineDay > PLAN_DAY_MAX ||
    p.askMode > AskMode.IF_AMBIGUOUS ||
    p.expiresAt <= BigInt(nowSec) ||
    isAddressEqual(p.agent, zeroAddress) ||
    isAddressEqual(p.kule, zeroAddress)
  );
}

/** 0 = bant kapalı (en gevşek). FlightPlan._bandTighterOrEqual'ın tersi. */
function bandLooser(oldBps: number, newBps: number): boolean {
  if (oldBps === 0) return false;
  return newBps === 0 || newBps > oldBps;
}

/** §8.2 / FlightPlan._isTighterOrEqual, alan alan: true ise bu alan planı bekletir. */
const LOOSER: Record<PlanField, (o: Plan, n: Plan) => boolean> = {
  cycleTL: (o, n) => n.cycleTL > o.cycleTL,
  maxOrderTL: (o, n) => n.maxOrderTL > o.maxOrderTL,
  startDay: (o, n) => n.startDay < o.startDay,
  deadlineDay: (o, n) => n.deadlineDay !== o.deadlineDay,
  maxWaitH: (o, n) => n.maxWaitH > o.maxWaitH,
  bandBps: (o, n) => bandLooser(o.bandBps, n.bandBps),
  // TODO(spec): §8.2 closedBandBps'i saymıyor; kontrat gibi aynı bant kuralı uygulanır.
  closedBandBps: (o, n) => bandLooser(o.closedBandBps, n.closedBandBps),
  askMode: (o, n) => n.askMode < o.askMode,
  expiresAt: (o, n) => n.expiresAt > o.expiresAt,
  agent: (o, n) => !isAddressEqual(o.agent, n.agent),
  kule: (o, n) => !isAddressEqual(o.kule, n.kule),
  agentId: (o, n) => o.agentId !== n.agentId,
};
const MUST_STAY: ReadonlySet<PlanField> = new Set(["deadlineDay", "agent", "kule", "agentId"]);

/** Adresler geçerli ve sıfır değilse dağıtım kullanılır; değilse null (imza kapalı). */
function usableDeployments(d: PlanConfirmationContext["deployments"]): PlanConfirmationContext["deployments"] {
  if (d === null) return null;
  const ok = (a: unknown) => typeof a === "string" && isAddress(a) && !isAddressEqual(a, zeroAddress);
  return ok(d.pilotAgent) && ok(d.kuleReporter) ? d : null;
}

function hasPlan(current: Plan | null): current is Plan {
  return current !== null && !isAddressEqual(current.agent, zeroAddress);
}

// ───────────────────────────── Biçim ─────────────────────────────

const pad2 = (n: number) => String(n).padStart(2, "0");

/** "18.10.2026 14:05 (TR saati)" */
function formatTrDateTime(sec: number): string {
  const p = trParts(sec);
  return `${pad2(p.day)}.${pad2(p.month)}.${p.year} ${pad2(p.hour)}:${pad2(p.minute)} (TR saati)`;
}

/** 300 → "%3", 250 → "%2,5", 0 → "Kapalı". */
function formatBps(bps: number): string {
  return bps === 0 ? "Kapalı" : `%${formatDecimalTr(scaledToDecimal(BigInt(bps), 2), 2)}`;
}

function display(field: PlanField, p: Partial<Plan>, days: number | null): string {
  const v = p[field];
  if (v === undefined) return "—";
  switch (field) {
    case "cycleTL":
    case "maxOrderTL":
      return `${formatTL(v as number)} TL`;
    case "startDay":
      return `Ayın ${v}. günü`;
    case "deadlineDay":
      return `Ayın ${v}. günü sonuna kadar`;
    case "maxWaitH":
      return `${formatDecimalTr(String(v), 0)} saat`;
    case "bandBps":
    case "closedBandBps":
      return formatBps(v as number);
    case "askMode":
      return v === AskMode.IF_AMBIGUOUS ? "Evet, emin olmazsa sana sorar" : "Hayır, sormadan karar verir";
    case "expiresAt":
      return days === null ? formatTrDateTime(v as number) : `${formatTrDateTime(v as number)} · ${days} gün`;
    case "agent":
    case "kule":
      return v as string;
    case "agentId":
      return `#${v}`;
  }
}

// ───────────────────────────── Hesap ─────────────────────────────

function sourceOf(s: ConfirmState, f: DraftField): RowSource {
  if (s.unparsable[f] || s.values[f] !== s.draft[f].value) return "edited";
  return s.draft[f].source;
}

function compute(state: ConfirmState): PlanConfirmation {
  const { ctx, values } = state;
  const blockers: ConfirmBlocker[] = [];
  const errorOf: Partial<Record<PlanField, string>> = {};
  const block = (code: ConfirmBlockerCode, field: PlanField | null, messageTr: string) => {
    blockers.push({ code, field, messageTr });
    if (field !== null && errorOf[field] === undefined) errorOf[field] = messageTr;
  };

  if (state.draft.questions.length > 0) block("QUESTIONS_OPEN", null, MSG.questions);

  const errs = fieldErrors(state);
  for (const f of PLAN_DRAFT_FIELDS) {
    const m = errs[f];
    if (m !== undefined) block(m === MSG.missing ? "MISSING_VALUE" : "INVALID_VALUE", PLAN_FIELD_OF[f], m);
  }

  // Zod yedek kontrolü (kural 1): alan kuralları geçtiyse taslak şemaya da uymalı.
  if (Object.keys(errs).length === 0) {
    const candidate = Object.fromEntries(
      PLAN_DRAFT_FIELDS.map((f) => {
        const src = sourceOf(state, f);
        return [f, { value: values[f], source: src === "edited" ? "user" : src }];
      }),
    );
    if (!PlanDraftSchema.safeParse({ ...candidate, questions: state.draft.questions }).success) {
      block("INVALID_DRAFT", null, MSG.draftSchema);
    }
  }

  // Kod tarafı Plan alanları (tek tek; eksik olan yok sayılır).
  const fields: Partial<Plan> = { bandBps: PLAN_DEFAULTS.bandBps, closedBandBps: PLAN_DEFAULTS.closedBandBps };
  const num = (f: DraftField) => (errs[f] === undefined ? (values[f] as number) : undefined);
  const set = <K extends keyof Plan>(k: K, v: Plan[K] | undefined) => {
    if (v !== undefined) fields[k] = v;
  };
  set("cycleTL", num("cycleTL"));
  set("maxOrderTL", num("maxOrderTL"));
  set("startDay", num("startDay"));
  set("deadlineDay", num("deadlineDay"));
  set("maxWaitH", num("maxWaitH"));
  if (errs.askOnAmbiguity === undefined) fields.askMode = values.askOnAmbiguity ? AskMode.IF_AMBIGUOUS : AskMode.NEVER;

  const current = hasPlan(ctx.current) ? ctx.current : null;
  const currentExpired = current !== null && current.expiresAt <= ctx.nowSec;
  const days = num("expiresInDays") ?? null;
  let capped = false;
  if (days !== null) {
    const wanted = ctx.nowSec + daysToSec(days);
    // Mevcut plan sürüyorsa yalnız VARSAYILAN süre onun bitişiyle sınırlanır (daha geç bitiş §8.2'de gevşemedir).
    // Elif'in cümlesinden ya da düzeltmesinden gelen süre olduğu gibi imzalatılır; tahmin 24 saat bekler der.
    // TODO(spec): SPEC varsayılan süreyi kırpmayı tanımlamıyor; ekip kararı, Elif'in seçtiği değer sessizce değişmez.
    if (
      sourceOf(state, "expiresInDays") === "default" &&
      current !== null &&
      current.expiresAt > ctx.nowSec &&
      current.expiresAt < wanted
    ) {
      fields.expiresAt = current.expiresAt;
      capped = true;
    } else {
      fields.expiresAt = wanted;
    }
  }

  const dep = usableDeployments(ctx.deployments);
  if (dep === null) {
    block("NO_DEPLOYMENT", "agent", MSG.noDeployment);
    block("NO_DEPLOYMENT", "kule", MSG.noDeployment);
  } else {
    fields.agent = getAddress(dep.pilotAgent);
    fields.kule = getAddress(dep.kuleReporter);
  }
  // agentId "0" ile imzalatma: sonradan düzeltmek F-4 yüzünden her zaman 24 saat bekletir.
  if (dep !== null && dep.agentId !== undefined && dep.agentId !== "0") fields.agentId = dep.agentId;
  else block("NO_AGENT_ID", "agentId", dep === null ? MSG.noDeployment : MSG.noAgentId);

  // Tam plan → zincir argümanı (tek kaynak).
  let plan: Plan | null = null;
  let chain: ChainPlan | null = null;
  if (PLAN_FIELDS.every((f) => fields[f] !== undefined)) {
    const parsed = PlanSchema.safeParse(fields);
    if (parsed.success) {
      plan = parsed.data;
      chain = Object.freeze(planToChain(plan));
      if (violatesContractValidate(chain, ctx.nowSec)) block("INVALID_PLAN", null, MSG.invalidPlan);
    } else {
      block("INVALID_PLAN", null, MSG.invalidPlan);
    }
  }

  // §8.2 tahmini.
  let activation: ActivationPreview | null = null;
  const loosened = new Set<PlanField>();
  if (plan !== null) {
    if (current === null) {
      activation = {
        immediate: true,
        activeAtSec: ctx.nowSec,
        loosened: [],
        textTr: "Zincirde planın yok; imzalarsan plan anında geçerli olur.",
      };
    } else {
      for (const f of PLAN_FIELDS) if (LOOSER[f](current, plan)) loosened.add(f);
      const immediate = loosened.size === 0;
      const activeAtSec = immediate ? ctx.nowSec : ctx.nowSec + PENDING_DELAY_SEC;
      const at = formatTrDateTime(activeAtSec);
      let textTr: string;
      if (immediate) textTr = "Yeni plan mevcut planından gevşek değil; imzalarsan anında geçerli olur.";
      else if (currentExpired) {
        textTr = `Mevcut planının süresi doldu; imzalarsan yeni plan ${at} geçerli olur. O zamana kadar PİLOT alım yapamaz.`;
      } else if (!ctx.currentActive) {
        textTr = `Mevcut planın durduruldu; imzalarsan yeni plan ${at} geçerli olur. O zamana kadar PİLOT alım yapamaz.`;
      } else {
        textTr = `Yeni plan mevcut planından gevşek; imzalarsan ${at} geçerli olur. O zamana kadar mevcut planın geçerli.`;
      }
      activation = { immediate, activeAtSec, loosened: PLAN_FIELDS.filter((f) => loosened.has(f)), textTr };
    }
  }

  const editable = new Set<PlanField>(EDITABLE_PLAN_FIELDS);
  const rows: ConfirmRow[] = PLAN_FIELDS.map((field) => {
    const isEditable = editable.has(field);
    const draftField = isEditable ? DRAFT_FIELD_OF[field as EditablePlanField] : null;
    const source: RowSource = draftField === null ? "default" : sourceOf(state, draftField);
    const v = chain !== null ? chain[field] : fields[field];
    let note: string | null = isEditable ? null : NOTE.derived;
    if (field === "expiresAt" && loosened.has(field) && currentExpired) note = NOTE.expiredBase;
    else if (loosened.has(field)) note = MUST_STAY.has(field) ? NOTE.mustStay : NOTE.looser;
    else if (field === "expiresAt" && capped) note = NOTE.capped;
    return {
      field,
      labelTr: PLAN_FIELD_LABELS_TR[field],
      displayTr: display(field, fields, field === "expiresAt" && !capped ? days : null),
      chainValue: v === undefined ? null : String(v),
      source,
      // Kırpılan varsayılan süre kodun türettiği değerdir: "varsayılan" (90 gün) değil "otomatik".
      badgeTr:
        draftField === null || (field === "expiresAt" && capped) ? CONFIRM_BADGES_TR.derived : CONFIRM_BADGES_TR[source],
      editable: isEditable,
      note,
      error: errorOf[field] ?? null,
    };
  });

  const signable = blockers.length === 0 && chain !== null;
  return {
    titleTr: CONFIRM_TITLE_TR,
    setPlanArgs: signable && chain !== null ? (Object.freeze([chain] as const) as readonly [ChainPlan]) : null,
    rows,
    signable,
    blockers,
    activation,
    questions: state.draft.questions,
    state,
  };
}

function checkContext(ctx: PlanConfirmationContext): PlanConfirmationContext {
  assertUnixSec(ctx.nowSec, "nowSec");
  if (ctx.current !== null && typeof ctx.currentActive !== "boolean") throw new TypeError("currentActive boolean olmalı");
  return { ...ctx, current: ctx.current === null ? null : PlanSchema.parse(ctx.current) };
}

/**
 * Onay penceresini kurar. `draft` planFromSentence çıktısıdır ve burada yeniden PlanDraftSchema ile doğrulanır
 * (geçersizse fırlatır). İmza yalnız `signable` iken ve yalnız `setPlanArgs` ile yapılır.
 */
export function buildPlanConfirmation(draft: PlanDraft, ctx: PlanConfirmationContext): PlanConfirmation {
  const d = PlanDraftSchema.parse(draft);
  const values = Object.fromEntries(PLAN_DRAFT_FIELDS.map((f) => [f, d[f].value])) as Record<
    DraftField,
    number | boolean | null
  >;
  return compute({ draft: d, values, unparsable: {}, ctx: checkContext(ctx) });
}

/** Sayı alanı girdisi: güvenli negatif olmayan tamsayı ya da yalnız rakamlı string ("20000", "05"). */
function parseIntInput(v: unknown): number | null {
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? v : null;
  if (typeof v === "string" && /^\d{1,15}$/.test(v.trim())) return Number(v.trim());
  return null;
}

/**
 * Bir alanı düzeltir ve pencereyi baştan doğrular. Değer biçimi:
 * - cycleTL, maxOrderTL (TL), startDay, deadlineDay (gün), maxWaitH (saat): tamsayı ya da yalnız rakamlı string.
 *   "20.000", "1,5", "-3" reddedilir (sessiz yuvarlama yok).
 * - askMode: boolean (true = emin olmazsa sor).
 * - expiresAt: bugünden itibaren gün sayısı (1–365); olduğu gibi imzalatılır (yalnız varsayılan süre kırpılır).
 * Geçersiz değer pencereyi imzaya kapatır (blocker + satır hatası). Düzenlenemez alan programlama hatasıdır, fırlatır.
 */
export function applyEdit(confirmation: PlanConfirmation, field: EditablePlanField, value: unknown): PlanConfirmation {
  if (!(EDITABLE_PLAN_FIELDS as readonly string[]).includes(field)) {
    throw new TypeError(`düzenlenemez alan: ${String(field)}`);
  }
  const s = confirmation.state;
  const f = DRAFT_FIELD_OF[field];
  const parsed = field === "askMode" ? (typeof value === "boolean" ? value : null) : parseIntInput(value);
  const unparsable = { ...s.unparsable };
  if (parsed === null) unparsable[f] = true;
  else delete unparsable[f];
  return compute({ ...s, values: { ...s.values, [f]: parsed }, unparsable });
}
