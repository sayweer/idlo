/**
 * Emir Denetimi (SPEC §12, ücretsiz). Bir emir taslağını birimleriyle okur; ONAY / DÜZELT / RET ve Türkçe gerekçe döner.
 * SAF: G/Ç yok, anahtar yok, emir göndermez. Enstrüman bilgisi (tickSz/lotSz/minSz) çağırandan gelir.
 *
 * Birim tuzağı (§7, CLAUDE.md kural 9): USDT-TRY piyasa alışında `sz` TL; limit / post_only / ioc / fok alışta `sz` USDT.
 * Tüm birim ve ondalık işlemleri packages/shared/units.ts'tendir (CLAUDE.md kural 7).
 */
import { z } from "zod";
import {
  KULE_REASON_TEXTS,
  OkxDecimalSchema,
  PositiveTLSchema,
  QUOTE_VERDICTS,
  TRADE_INST_ID,
  UnitError,
  decimalPlaces,
  decimalToScaled,
  floorToTick,
  formatDecimalTr,
  formatPxTr,
  formatTL,
  limitBuySz,
  marketBuySzTL,
  notionalDeviationBps,
  notionalTLE6,
  parseTL,
  pxE6ToPx,
  pxToPxE6,
  scaledToDecimal,
  type PxE6,
  type TL,
  type UnixMs,
} from "@pilot/shared";
import type { InstrumentSpec } from "./okxPublic.js";

/** OKX spot emir türleri (KULE yalnız post_only / ioc kullanır; servis başka ajanların taslaklarını da okur). */
export const EMIR_ORD_TYPES = ["market", "limit", "post_only", "ioc", "fok"] as const;
export type EmirOrdType = (typeof EMIR_ORD_TYPES)[number];

export const EmirDenetimiInputSchema = z.strictObject({
  instId: z.string().min(1).max(32),
  side: z.enum(["buy", "sell"]),
  ordType: z.enum(EMIR_ORD_TYPES),
  sz: OkxDecimalSchema.max(32),
  px: OkxDecimalSchema.max(32).optional(),
  tgtCcy: z.enum(["base_ccy", "quote_ccy"]).optional(),
  niyetTL: PositiveTLSchema.optional(),
  limitler: z.strictObject({ maxOrderTL: PositiveTLSchema }).optional(),
});
export type EmirDenetimiInput = z.infer<typeof EmirDenetimiInputSchema>;

export type Karar = (typeof QUOTE_VERDICTS)[number];

export const GEREKCE_KODLARI = [
  "BAD_INSTRUMENT",
  "SIDE_UNSUPPORTED",
  "INSTRUMENT_UNAVAILABLE",
  "SZ_ZERO",
  "PX_REQUIRED",
  "PX_INVALID",
  "PX_OFF_TICK",
  "PX_IGNORED",
  "TGTCCY_IGNORED",
  "SZ_LOOKS_LIKE_TL",
  "NOTIONAL_MISMATCH",
  "LOT_ROUNDING",
  "BELOW_MIN_SZ",
  "MARKET_SZ_IS_TL",
  "MARKET_TL_NOT_WHOLE",
  "MARKET_BASE_CCY",
  "OVER_ORDER_LIMIT",
  "NO_TL_REFERENCE",
  "UNREADABLE",
] as const;
export type GerekceKodu = (typeof GEREKCE_KODLARI)[number];

const DuzeltmeSchema = z.strictObject({
  instId: z.string(),
  side: z.literal("buy"),
  ordType: z.enum(EMIR_ORD_TYPES),
  sz: OkxDecimalSchema,
  px: OkxDecimalSchema.optional(),
  tgtCcy: z.literal("quote_ccy").optional(),
});
export type Duzeltme = z.infer<typeof DuzeltmeSchema>;

/** §12 çıktısı: {karar, okuma, duzeltme?, gerekceler[], zaman, kaynak}. `zaman` OKX ms. */
export const EmirDenetimiOutputSchema = z.strictObject({
  karar: z.enum(QUOTE_VERDICTS),
  okuma: z.string(),
  duzeltme: DuzeltmeSchema.optional(),
  gerekceler: z.array(z.strictObject({ kod: z.enum(GEREKCE_KODLARI), metin: z.string() })),
  zaman: z.int().nonnegative(), // TODO(spec): §12 `zaman` birimini vermiyor; OKX ms seçildi (§7)
  kaynak: z.string(),
});
export type EmirDenetimiOutput = z.infer<typeof EmirDenetimiOutputSchema>;

/** U-2 eşiği: sz, TL tutarına %1 içinde yakınsa "TL sanılmış" sayılır; U-3: sapma > 100 bp → DÜZELT. */
const SZ_TL_TOLERANCE_BPS = 100n;
const MAX_DEVIATION_BPS = 100;

const ORD_TYPE_TR: Record<EmirOrdType, string> = {
  market: "piyasa",
  limit: "limit",
  post_only: "yalnız yapıcı",
  ioc: "hemen",
  fok: "tamamı ya da hiç",
};

const RANK: Record<Karar, number> = { ONAY: 0, DÜZELT: 1, RET: 2 };

interface Ctx {
  karar: Karar;
  gerekceler: EmirDenetimiOutput["gerekceler"];
}
function add(ctx: Ctx, kod: GerekceKodu, metin: string, karar: Karar): void {
  ctx.gerekceler.push({ kod, metin });
  if (RANK[karar] > RANK[ctx.karar]) ctx.karar = karar;
}

/** İki ondalık string'i ortak ölçekte bigint'e çevirir (units.ts). */
function scaledPair(a: string, b: string): [bigint, bigint, number] {
  const d = Math.max(decimalPlaces(a), decimalPlaces(b));
  return [decimalToScaled(a, d), decimalToScaled(b, d), d];
}
function cmpDecimal(a: string, b: string): number {
  const [x, y] = scaledPair(a, b);
  return x === y ? 0 : x < y ? -1 : 1;
}
/** `sz`'yi `step` katına aşağı yuvarlar (lotSz). */
function floorToStep(sz: string, step: string): string {
  const [x, s, d] = scaledPair(sz, step);
  if (s === 0n) throw new UnitError(`adım sıfır olamaz: ${step}`);
  return scaledToDecimal((x / s) * s, d);
}
/** Ondalık sayının tam kısmı, tam lira olarak (kesir atılır). 0 ise null. */
function wholeTL(sz: string): TL | null {
  const tl = parseTL(sz.split(".")[0]!);
  return tl > 0 ? tl : null;
}
/** sz, TL tutarına %1 içinde mi? (sz USDT yerine TL yazılmış: U-2) */
function looksLikeTL(sz: string, tl: TL): boolean {
  const [x, t] = scaledPair(sz, String(tl));
  const diff = x > t ? x - t : t - x;
  return diff * 10000n <= t * SZ_TL_TOLERANCE_BPS;
}
/** sz × px (TL), Türkçe gösterim. */
function notionalTr(sz: string, pxE6: PxE6): string {
  return formatDecimalTr(scaledToDecimal(notionalTLE6(sz, pxE6), 6), 0);
}
function limitReadback(sz: string, pxE6: PxE6, ordType: EmirOrdType): string {
  return `≈ ${notionalTr(sz, pxE6)} TL ile ${formatDecimalTr(sz, 4)} USDT alınacak (limit ${formatPxTr(pxE6)}, ${ORD_TYPE_TR[ordType]}).`;
}

export interface DenetimMeta {
  nowMs: UnixMs;
  kaynak: string;
}

/** `spec` null = enstrüman bilgisi alınamadı (fail-closed: denetlenemeyen emir onaylanmaz). */
export function denetle(input: EmirDenetimiInput, spec: InstrumentSpec | null, meta: DenetimMeta): EmirDenetimiOutput {
  try {
    return denetleInner(input, spec, meta);
  } catch (e) {
    if (!(e instanceof UnitError)) throw e;
    // Birim yardımcısının reddettiği değer (ör. güvenli aralık dışı tutar): okunamayan emir onaylanmaz.
    return EmirDenetimiOutputSchema.parse({
      karar: "RET",
      okuma: "Emir birimleriyle okunamadı.",
      gerekceler: [{ kod: "UNREADABLE", metin: "Miktar ya da fiyat güvenli aralıkta okunamadı." }],
      zaman: meta.nowMs,
      kaynak: meta.kaynak,
    });
  }
}

function denetleInner(input: EmirDenetimiInput, spec: InstrumentSpec | null, meta: DenetimMeta): EmirDenetimiOutput {
  const ctx: Ctx = { karar: "ONAY", gerekceler: [] };
  const out = (okuma: string, duzeltme?: Duzeltme): EmirDenetimiOutput =>
    EmirDenetimiOutputSchema.parse({
      karar: ctx.karar,
      okuma,
      ...(duzeltme && ctx.karar === "DÜZELT" ? { duzeltme } : {}),
      gerekceler: ctx.gerekceler,
      zaman: meta.nowMs,
      kaynak: meta.kaynak,
    });

  if (input.instId !== TRADE_INST_ID) {
    add(ctx, "BAD_INSTRUMENT", `Yalnız ${TRADE_INST_ID} emirleri denetlenir.`, "RET");
    return out(`${input.instId} denetlenmedi.`);
  }
  // TODO(spec): §12 `side` alır ama KULE yalnız alış yapar (§9.2-6); satış birim kuralı tanımlanmadığından RET.
  if (input.side !== "buy") {
    add(ctx, "SIDE_UNSUPPORTED", "Yalnız alış emirleri denetlenir.", "RET");
    return out("Satış emri denetlenmedi.");
  }
  if (spec === null) {
    add(ctx, "INSTRUMENT_UNAVAILABLE", "Borsanın fiyat adımı ve miktar bilgisi alınamadı; denetlenemeyen emir onaylanmaz.", "RET");
    return out(`${input.instId} enstrüman bilgisi alınamadı; emir denetlenemedi.`);
  }
  if (spec.instId !== input.instId || spec.state !== "live") {
    add(ctx, "INSTRUMENT_UNAVAILABLE", `${input.instId} şu an işleme açık değil.`, "RET");
    return out(`${input.instId} işleme açık değil.`);
  }
  if (cmpDecimal(input.sz, "0") === 0) {
    add(ctx, "SZ_ZERO", "Miktar (sz) sıfır olamaz.", "RET");
    return out("Miktar sıfır.");
  }
  return input.ordType === "market" ? marketBuy(input, ctx, out) : limitBuy(input, spec, ctx, out);
}

type Out = (okuma: string, duzeltme?: Duzeltme) => EmirDenetimiOutput;

function marketBuy(input: EmirDenetimiInput, ctx: Ctx, out: Out): EmirDenetimiOutput {
  if (input.px !== undefined) add(ctx, "PX_IGNORED", "Piyasa emrinde fiyat kullanılmaz; px yok sayıldı.", "ONAY");

  // TODO(spec): tgtCcy=base_ccy piyasa alışı (sz USDT) fiyatsız TL sınırına göre denetlenemez; en dar seçenek:
  // niyet tutarı varsa TL miktarlı piyasa alışına DÜZELT, yoksa RET.
  if (input.tgtCcy === "base_ccy") {
    if (input.niyetTL === undefined) {
      add(ctx, "MARKET_BASE_CCY", "USDT miktarlı piyasa alışı TL tutarına göre denetlenemez; miktarı TL ver (tgtCcy=quote_ccy).", "RET");
      return out(`Piyasa alışı: ${formatDecimalTr(input.sz, 4)} USDT (tgtCcy=base_ccy); TL tutarı bilinmiyor.`);
    }
    add(ctx, "MARKET_BASE_CCY", "Piyasa alışında miktarı TL olarak ver (tgtCcy=quote_ccy); USDT miktarı TL tutarına göre denetlenemez.", "DÜZELT");
    return finishMarket(input, input.niyetTL, ctx, out);
  }

  const whole = wholeTL(input.sz);
  if (whole === null) {
    add(ctx, "MARKET_TL_NOT_WHOLE", "Piyasa alışında miktar TL'dir ve en az 1 TL olmalı.", "RET");
    return out(`Piyasa alışı: ${formatDecimalTr(input.sz, 4)} TL okunamadı.`);
  }
  let amountTL = whole;
  if (decimalPlaces(input.sz) > 0 && cmpDecimal(input.sz, String(whole)) !== 0) {
    add(ctx, "MARKET_TL_NOT_WHOLE", `Tutar tam lira olmalı; ${formatTL(whole)} TL'ye aşağı yuvarlandı.`, "DÜZELT");
  }
  if (input.niyetTL !== undefined && amountTL !== input.niyetTL) {
    add(
      ctx,
      "MARKET_SZ_IS_TL",
      `Piyasa alışında miktar TL'dir; sz (${formatDecimalTr(input.sz, 4)}) niyet tutarıyla (${formatTL(input.niyetTL)} TL) eşleşmiyor.`,
      "DÜZELT",
    );
    amountTL = input.niyetTL;
  }
  return finishMarket(input, amountTL, ctx, out);
}

function finishMarket(input: EmirDenetimiInput, amountTL: TL, ctx: Ctx, out: Out): EmirDenetimiOutput {
  const max = input.limitler?.maxOrderTL;
  if (max !== undefined && amountTL > max) {
    add(ctx, "OVER_ORDER_LIMIT", `Tutar (${formatTL(amountTL)} TL), tek emir tavanını (${formatTL(max)} TL) aşıyor.`, "RET");
  }
  const okuma = `Piyasa alışı: ${formatTL(amountTL)} TL harcanacak (piyasa alışında miktar TL'dir).`;
  return out(okuma, { instId: input.instId, side: "buy", ordType: "market", sz: marketBuySzTL(amountTL), tgtCcy: "quote_ccy" });
}

function limitBuy(input: EmirDenetimiInput, spec: InstrumentSpec, ctx: Ctx, out: Out): EmirDenetimiOutput {
  if (input.px === undefined) {
    add(ctx, "PX_REQUIRED", `${ORD_TYPE_TR[input.ordType]} emirde fiyat (px) zorunlu.`, "RET");
    return out("Fiyatsız limit emir okunamadı.");
  }
  let pxE6: PxE6;
  try {
    pxE6 = pxToPxE6(input.px);
    const onTick = floorToTick(pxE6, spec.tickSz);
    if (onTick !== pxE6) {
      add(
        ctx,
        "PX_OFF_TICK",
        `Fiyat borsa adımına (tickSz ${spec.tickSz}) uymuyor; alışta aşağı yuvarlandı: ${formatPxTr(onTick, 6)}.`,
        "DÜZELT",
      );
      pxE6 = onTick;
    }
  } catch (e) {
    if (!(e instanceof UnitError)) throw e;
    add(ctx, "PX_INVALID", `Fiyat okunamadı ya da borsa adımına (tickSz ${spec.tickSz}) yuvarlanamıyor.`, "RET");
    return out(`Fiyat ${input.px} okunamadı.`);
  }
  const gelen = `Gelen: ${formatDecimalTr(input.sz, 4)} USDT × ${formatPxTr(pxE6, 6)} ≈ ${notionalTr(input.sz, pxE6)} TL.`;

  if (input.tgtCcy === "base_ccy") add(ctx, "TGTCCY_IGNORED", "tgtCcy yalnız piyasa emrinde geçerlidir; limit alışta miktar zaten USDT'dir.", "ONAY");

  // TL referansı: niyetTL; yoksa yalnız tgtCcy=quote_ccy sz'nin TL sanıldığını gösterir.
  let targetTL: TL | null = input.niyetTL ?? null;
  let szIsTL = targetTL !== null && looksLikeTL(input.sz, targetTL);
  const max = input.limitler?.maxOrderTL;
  if (input.tgtCcy === "quote_ccy") {
    add(ctx, "TGTCCY_IGNORED", "tgtCcy=quote_ccy yalnız piyasa emrinde geçerlidir; limit alışta miktar USDT'dir.", "DÜZELT");
    if (targetTL === null) {
      targetTL = wholeTL(input.sz);
      szIsTL = targetTL !== null;
    }
  }

  let sz = input.sz;
  if (targetTL !== null) {
    let fixed: string;
    try {
      fixed = limitBuySz({ amountTL: targetTL, pxE6, lotSz: spec.lotSz, minSz: spec.minSz });
    } catch (e) {
      if (!(e instanceof UnitError)) throw e;
      add(ctx, "BELOW_MIN_SZ", `${KULE_REASON_TEXTS.BELOW_MIN_SZ} (en küçük ${spec.minSz} USDT)`, "RET");
      return out(gelen);
    }
    if (szIsTL) {
      const neden = input.niyetTL !== undefined ? "" : " Niyet tutarı verilmediği için sz TL sayıldı.";
      add(ctx, "SZ_LOOKS_LIKE_TL", `${KULE_REASON_TEXTS.SZ_LOOKS_LIKE_TL}${neden}`, "DÜZELT");
      sz = fixed;
    } else if (notionalDeviationBps(input.sz, pxE6, targetTL) > MAX_DEVIATION_BPS) {
      add(ctx, "NOTIONAL_MISMATCH", KULE_REASON_TEXTS.NOTIONAL_MISMATCH, "DÜZELT");
      sz = fixed;
    } else if (cmpDecimal(input.sz, fixed) > 0) {
      // U-14: sz × px ≤ niyet tutarı (lot katına aşağı yuvarlanmış en büyük miktar).
      add(ctx, "NOTIONAL_MISMATCH", `Fiyat × miktar niyet tutarını (${formatTL(targetTL)} TL) aşıyor; miktar düşürüldü.`, "DÜZELT");
      sz = fixed;
    }
  } else {
    add(ctx, "NO_TL_REFERENCE", "Niyet tutarı (niyetTL) verilmedi; sz USDT olarak okundu. Tutarın TL ise niyetTL gönder.", "ONAY");
  }

  const onLot = floorToStep(sz, spec.lotSz);
  if (cmpDecimal(onLot, sz) !== 0) {
    add(ctx, "LOT_ROUNDING", `Miktar borsa adımına (lotSz ${spec.lotSz}) aşağı yuvarlandı.`, "DÜZELT");
    sz = onLot;
  }
  if (cmpDecimal(sz, spec.minSz) < 0 || cmpDecimal(sz, "0") === 0) {
    add(ctx, "BELOW_MIN_SZ", `${KULE_REASON_TEXTS.BELOW_MIN_SZ} (en küçük ${spec.minSz} USDT)`, "RET");
    return out(gelen);
  }
  if (max !== undefined && !fitsMax(sz, pxE6, max)) {
    // TL referansı yoksa sz TL sanılarak küçültülmez (§9.1, kural 2); yalnız ipucu verilir.
    const ipucu = targetTL === null ? " sz TL olarak yazıldıysa niyetTL gönderin; limit alışta sz USDT'dir." : "";
    add(ctx, "OVER_ORDER_LIMIT", `Fiyat × miktar (≈ ${notionalTr(sz, pxE6)} TL), tek emir tavanını (${formatTL(max)} TL) aşıyor.${ipucu}`, "RET");
  }

  const readback = limitReadback(sz, pxE6, input.ordType);
  const okuma = ctx.karar === "ONAY" ? readback : ctx.karar === "DÜZELT" ? `${gelen} Önerilen: ${readback}` : gelen;
  return out(okuma, { instId: input.instId, side: "buy", ordType: input.ordType, sz, px: pxE6ToPx(pxE6) });
}

/** sz × px ≤ maxOrderTL mi? */
function fitsMax(sz: string, pxE6: PxE6, maxOrderTL: TL): boolean {
  return cmpDecimal(scaledToDecimal(notionalTLE6(sz, pxE6), 6), String(maxOrderTL)) <= 0;
}
