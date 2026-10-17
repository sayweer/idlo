/**
 * Plan şemaları: PlanDraft (LLM çıktısı, §15, §10.6) ve zincir yapılarının kod tarafı karşılıkları (§8.1).
 * Zincir ↔ kod dönüşümü yalnız units.ts yardımcılarıyla yapılır.
 */
import { z } from "zod";
import { zeroAddress, type Address } from "viem";
import {
  chainSecFromBigInt,
  pxE6FromChain,
  pxE6ToChain,
  tlFromChain,
  tlToChain,
} from "../units.js";
import { actionStateFromChain, ordTypeFromChain, ACTION_STATES } from "../codes.js";
import {
  AddressSchema,
  CycleIdSchema,
  OrdTypeSchema,
  PositiveTLSchema,
  PxE6Schema,
  TLSchema,
  Uint16Schema,
  Uint256StringSchema,
  Uint8Schema,
  UnixSecSchema,
} from "./primitives.js";

// ───────────────────────────── Varsayılanlar (§10.6) ─────────────────────────────

/** Kodun türettiği / varsayılan plan alanları (§10.6). */
export const PLAN_DEFAULTS = {
  maxWaitH: 72,
  expiresInDays: 90,
  bandBps: 0,
  closedBandBps: 500,
} as const;

/**
 * Pencere günleri için üst sınır.
 * TODO(spec): SPEC gün aralığını vermiyor; IFlightPlan.InvalidPlan TODO'su ile aynı en dar seçenek (1–28):
 * her ayda var olan günler.
 */
export const PLAN_DAY_MIN = 1;
export const PLAN_DAY_MAX = 28;

/** TODO(spec): expiresInDays üst sınırı SPEC'te yok; en dar makul seçenek 365 gün. */
export const PLAN_EXPIRES_MAX_DAYS = 365;

// ───────────────────────────── PlanDraft (§15) ─────────────────────────────

export const DRAFT_SOURCES = ["user", "default"] as const;
export type DraftSource = (typeof DRAFT_SOURCES)[number];

function draftField<T extends z.ZodType>(value: T) {
  return z.strictObject({ value: value.nullable(), source: z.enum(DRAFT_SOURCES) });
}

const PlanDayValue = z.int().min(PLAN_DAY_MIN).max(PLAN_DAY_MAX);

/** PlanDraft'taki değer alanları (questions hariç). */
export const PLAN_DRAFT_FIELDS = [
  "cycleTL",
  "startDay",
  "deadlineDay",
  "maxOrderTL",
  "askOnAmbiguity",
  "maxWaitH",
  "expiresInDays",
] as const;

/** Varsayılanı olan alanlar; diğerlerinde "default" yalnız `value: null` (boş) demektir. */
const DRAFT_DEFAULTS: Partial<Record<string, number | boolean>> = {
  maxWaitH: PLAN_DEFAULTS.maxWaitH,
  expiresInDays: PLAN_DEFAULTS.expiresInDays,
};

export const PlanDraftSchema = z
  .strictObject({
    cycleTL: draftField(PositiveTLSchema),
    startDay: draftField(PlanDayValue),
    deadlineDay: draftField(PlanDayValue),
    maxOrderTL: draftField(PositiveTLSchema),
    askOnAmbiguity: draftField(z.boolean()),
    maxWaitH: draftField(Uint16Schema),
    expiresInDays: draftField(z.int().min(1).max(PLAN_EXPIRES_MAX_DAYS)),
    questions: z.array(z.string().trim().min(1).max(300)).max(10),
  })
  .superRefine((d, ctx) => {
    let missing = false;
    for (const k of PLAN_DRAFT_FIELDS) {
      const f = d[k];
      if (f.value === null) {
        missing = true;
        if (f.source !== "default") {
          ctx.addIssue({ code: "custom", path: [k, "source"], message: "boş alan yalnız source:\"default\" olabilir" });
        }
      } else if (f.source === "default") {
        const def = DRAFT_DEFAULTS[k];
        if (def === undefined) {
          ctx.addIssue({ code: "custom", path: [k, "value"], message: "bu alanın varsayılanı yok; cümlede yoksa boş bırakılmalı" });
        } else if (f.value !== def) {
          ctx.addIssue({ code: "custom", path: [k, "value"], message: `varsayılan değer ${String(def)} olmalı` });
        }
      }
    }
    if (missing && d.questions.length === 0) {
      ctx.addIssue({ code: "custom", path: ["questions"], message: "boş alan varsa en az bir soru olmalı" });
    }
    if (d.startDay.value !== null && d.deadlineDay.value !== null && d.startDay.value > d.deadlineDay.value) {
      ctx.addIssue({ code: "custom", path: ["deadlineDay", "value"], message: "deadlineDay ≥ startDay olmalı" });
    }
    if (d.maxOrderTL.value !== null && d.cycleTL.value !== null && d.maxOrderTL.value > d.cycleTL.value) {
      ctx.addIssue({ code: "custom", path: ["maxOrderTL", "value"], message: "maxOrderTL ≤ cycleTL olmalı" });
    }
  });
export type PlanDraft = z.infer<typeof PlanDraftSchema>;

/** Kart imzaya açılabilir mi (§10.6: sorular cevaplanmadan açılmaz; boş alan yok). */
export function isPlanDraftSignable(d: PlanDraft): boolean {
  return d.questions.length === 0 && PLAN_DRAFT_FIELDS.every((k) => d[k].value !== null);
}

// ───────────────────────── Zincir yapıları (§8.1), kod tarafı ─────────────────────────

/** Plan; alan adları §8.1 ile aynı. TL number, zaman saniye, agentId ondalık string. */
export const PlanSchema = z.strictObject({
  cycleTL: TLSchema,
  maxOrderTL: TLSchema,
  startDay: Uint8Schema,
  deadlineDay: Uint8Schema,
  maxWaitH: Uint16Schema,
  bandBps: Uint16Schema,
  closedBandBps: Uint16Schema,
  askMode: z.union([z.literal(0), z.literal(1)]),
  expiresAt: UnixSecSchema,
  agent: AddressSchema,
  kule: AddressSchema,
  agentId: Uint256StringSchema,
});
export type Plan = z.infer<typeof PlanSchema>;

export const CycleSchema = z.strictObject({
  id: z.union([z.literal(0), CycleIdSchema]), // 0: henüz döngü açılmadı
  spentTL: TLSchema,
  reservedTL: TLSchema,
  closed: z.boolean(),
});
export type Cycle = z.infer<typeof CycleSchema>;

export const BuyActionSchema = z.strictObject({
  user: AddressSchema,
  amountTL: TLSchema,
  maxPxE6: PxE6Schema,
  ordType: OrdTypeSchema,
  openBy: UnixSecSchema,
  reportBy: UnixSecSchema,
  cycleId: CycleIdSchema,
  state: z.enum(ACTION_STATES),
});
export type BuyAction = z.infer<typeof BuyActionSchema>;

/** viem'in döndürdüğü biçim (uint64/uint256 → bigint, uint8/16/32 → number). */
export interface ChainPlan {
  cycleTL: bigint;
  maxOrderTL: bigint;
  startDay: number;
  deadlineDay: number;
  maxWaitH: number;
  bandBps: number;
  closedBandBps: number;
  askMode: number;
  expiresAt: bigint;
  agent: Address;
  kule: Address;
  agentId: bigint;
}
export interface ChainCycle {
  id: number;
  spentTL: bigint;
  reservedTL: bigint;
  closed: boolean;
}
export interface ChainBuyAction {
  user: Address;
  amountTL: bigint;
  maxPxE6: bigint;
  ordType: number;
  openBy: bigint;
  reportBy: bigint;
  cycleId: number;
  state: number;
}

export function planFromChain(raw: ChainPlan): Plan {
  return PlanSchema.parse({
    cycleTL: tlFromChain(raw.cycleTL),
    maxOrderTL: tlFromChain(raw.maxOrderTL),
    startDay: raw.startDay,
    deadlineDay: raw.deadlineDay,
    maxWaitH: raw.maxWaitH,
    bandBps: raw.bandBps,
    closedBandBps: raw.closedBandBps,
    askMode: raw.askMode,
    expiresAt: chainSecFromBigInt(raw.expiresAt),
    agent: raw.agent,
    kule: raw.kule,
    agentId: raw.agentId.toString(),
  });
}

export function planToChain(plan: Plan): ChainPlan {
  const p = PlanSchema.parse(plan);
  return {
    cycleTL: tlToChain(p.cycleTL),
    maxOrderTL: tlToChain(p.maxOrderTL),
    startDay: p.startDay,
    deadlineDay: p.deadlineDay,
    maxWaitH: p.maxWaitH,
    bandBps: p.bandBps,
    closedBandBps: p.closedBandBps,
    askMode: p.askMode,
    expiresAt: BigInt(p.expiresAt),
    agent: p.agent,
    kule: p.kule,
    agentId: BigInt(p.agentId),
  };
}

export function cycleFromChain(raw: ChainCycle): Cycle {
  return CycleSchema.parse({
    id: raw.id,
    spentTL: tlFromChain(raw.spentTL),
    reservedTL: tlFromChain(raw.reservedTL),
    closed: raw.closed,
  });
}

/** İzin kaydı; `user == 0x0` ise izin yoktur ve null döner (IFlightPlan.actions). */
export function buyActionFromChain(raw: ChainBuyAction): BuyAction | null {
  if (raw.user.toLowerCase() === zeroAddress) return null;
  return BuyActionSchema.parse({
    user: raw.user,
    amountTL: tlFromChain(raw.amountTL),
    maxPxE6: pxE6FromChain(raw.maxPxE6),
    ordType: ordTypeFromChain(raw.ordType),
    openBy: chainSecFromBigInt(raw.openBy),
    reportBy: chainSecFromBigInt(raw.reportBy),
    cycleId: raw.cycleId,
    state: actionStateFromChain(raw.state),
  });
}

/** requestBuy argümanları için birim dönüşümü (TL ve pxE6 → uint64). */
export function buyArgsToChain(amountTL: number, maxPxE6: number): { amountTL: bigint; maxPxE6: bigint } {
  return { amountTL: tlToChain(amountTL), maxPxE6: pxE6ToChain(maxPxE6) };
}
