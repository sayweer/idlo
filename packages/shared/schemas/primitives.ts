/** Ortak zod ilkelleri; birim kuralları units.ts ile aynıdır (§7). */
import { z } from "zod";
import { isAddress, type Address, type Hex } from "viem";
import { assertCycleId } from "../units.js";
import { ORD_TYPES } from "../codes.js";

/** Tam lira (kuruş yok). */
export const TLSchema = z.int().nonnegative();
/** Sıfırdan büyük tam lira (emir tutarı). */
export const PositiveTLSchema = z.int().positive();
/** Fiyat × 10^6 (tamsayı). */
export const PxE6Schema = z.int().nonnegative();
export const PositivePxE6Schema = z.int().positive();
/** Zincir zamanı, unix saniye. */
export const UnixSecSchema = z.int().nonnegative();
/** OKX zamanı, unix milisaniye. */
export const UnixMsSchema = z.int().nonnegative();
/** uint32 YYYYMM, TR saatine göre. */
export const CycleIdSchema = z.int().refine(
  (v) => {
    try {
      assertCycleId(v);
      return true;
    } catch {
      return false;
    }
  },
  { message: "cycleId YYYYMM olmalı" },
);
export const Uint8Schema = z.int().min(0).max(255);
export const Uint16Schema = z.int().min(0).max(65535);

/** OKX ondalık string'i (px, sz, bakiye): "49.39", "202.6". Bilimsel gösterim ve eksi işaret yok. */
export const OkxDecimalSchema = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/, "OKX ondalık biçimi olmalı");

/** EVM adresi (viem isAddress; karışık harfte checksum zorunlu). */
export const AddressSchema = z.custom<Address>((v) => typeof v === "string" && isAddress(v), {
  message: "geçerli bir EVM adresi olmalı",
});
/** İşlem özeti (32 bayt hex). */
export const TxHashSchema = z.custom<Hex>((v) => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v), {
  message: "32 baytlık işlem özeti olmalı",
});
/** Zincirdeki uint256 actionId, ondalık string ("17"). 0 = ret, geçerli izin değildir. */
const MAX_UINT256 = (1n << 256n) - 1n;
export const ActionIdSchema = z
  .string()
  .regex(/^[1-9]\d{0,77}$/, "actionId pozitif ondalık tamsayı string olmalı")
  .refine((v) => BigInt(v) <= MAX_UINT256, { message: "actionId uint256 aralığı dışında" });
/** uint256 ondalık string (agentId). */
export const Uint256StringSchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,77})$/, "uint256 ondalık string olmalı")
  .refine((v) => BigInt(v) <= MAX_UINT256, { message: "uint256 aralığı dışında" });

export const OrdTypeSchema = z.enum(ORD_TYPES);
