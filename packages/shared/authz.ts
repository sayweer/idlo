/**
 * KULE izin bağı (§9.2 adım 1, 4, 5): saf fonksiyonlar, ağ ve disk yok.
 *
 * Neden: setPlan'i herkes kendi adresi için çağırabilir ve plana gerçek KULE'yi, gerçek PİLOT adresini ve gerçek
 * agentId'yi yazabilir (§8.2). Yalnız "izin var mı, AUTHORIZED mı, kullanıcının planı aktif mi" diye bakan KULE,
 * Elif'in hiç imzalamadığı bir plana dayanarak Elif'in OKX hesabında emir verir (contracts/test/AuthBinding.t.sol).
 * TODO(spec): §9.2 adım 4 kullanıcı bağını yazmıyor. En dar seçim: izin yapılandırılmış kullanıcının olmalı,
 * plan bu KULE'nin KULE_REPORTER adresini göstermeli, plan ajanı token'ın ajanı olmalı; değilse RET.
 *
 * §9.2 sırası korunur, kontrol iki parçadır:
 *   adım 1 → checkActionOwner → adım 2 (kilit) → adım 3 (sağlık) → checkActionLive (adım 4 kalanı + adım 5) → adım 6…
 * checkActionOwner kilitten önce çalışır: başka ajanın token'ı ya da başka kullanıcının izni diske RESERVED kilit
 * yazamaz (Elif'in actionId'sini kilitleyip gerçek çağrıyı ALREADY_EXECUTED'a düşüremez).
 * Girdi alanları viem'in actions(id) / plans(action.user) / isPlanActive(action.user) dönüşleriyle aynı biçimdedir.
 *
 * TODO(spec): bağ, uygulama anındaki planı kontrol eder; BuyAction izin anındaki planın özetini tutmaz. Elif'in
 * yeni planı commitPending ile (herkes çağırabilir) devreye girerse ya da sıkılaştıran setPlan / revoke+setPlan
 * hemen geçerse, eski planla verilmiş AUTHORIZED izinler yeni planın ajanıyla/sınırlarıyla uygulanabilir. Tüm planları
 * Elif imzalamıştır; SPEC sessiz. En dar seçim (KULE, Bekir): BuyAuthorized bloğu, o kullanıcı için son
 * PlanSet(active=true) ya da PlanRevoked bloğundan eskiyse RET NO_AUTHORIZATION.
 */
import { isAddress, isAddressEqual, zeroAddress, type Address } from "viem";
import { ACTION_STATES, verdictOfReason, type KuleReasonCode, type KuleVerdict } from "./codes.js";
import type { ChainBuyAction, ChainPlan } from "./schemas/plan.js";

/** §9.2 adım 5: openBy − now ≥ 12 dakika. */
export const MIN_OPEN_MARGIN_SEC = 12 * 60;

/** KULE'nin kendi yapılandırması (.env). */
export interface KuleBinding {
  planUser: string; // PLAN_USER_ADDRESS
  kuleReporter: string; // KULE_REPORTER adresi
  tokenAgent: string; // çağıran bearer token'ın bağlı olduğu ajan adresi (PILOT_AGENT_ADDRESS)
}

export type BindingResult =
  | { ok: true }
  | { ok: false; verdict: KuleVerdict; reason: Extract<KuleReasonCode, "WRONG_AGENT" | "NO_AUTHORIZATION" | "TOO_LATE"> };

const AUTHORIZED = ACTION_STATES.indexOf("AUTHORIZED");

/** Geçerli (checksum'lı ya da tamamı küçük harf; viem isAddress katı) ve sıfır olmayan adres. */
function usable(a: unknown): a is Address {
  return typeof a === "string" && isAddress(a) && !isAddressEqual(a, zeroAddress);
}

function reject(reason: "WRONG_AGENT" | "NO_AUTHORIZATION" | "TOO_LATE"): BindingResult {
  return { ok: false, verdict: verdictOfReason(reason), reason };
}

/** Kilitten (adım 2) önce: izin var mı, token'ın ajanının mı (adım 1), yapılandırılmış kullanıcının ve bu KULE'nin mi. */
export function checkActionOwner(
  action: Pick<ChainBuyAction, "user">,
  plan: Pick<ChainPlan, "agent" | "kule">,
  cfg: KuleBinding,
): BindingResult {
  // Yapılandırma eksik/bozuksa hiçbir izin uygulanmaz (fail-closed).
  // TODO(spec): SPEC yapılandırma hatası için gerekçe kodu vermiyor; en dar seçim NO_AUTHORIZATION.
  if (!usable(cfg.planUser) || !usable(cfg.kuleReporter) || !usable(cfg.tokenAgent)) return reject("NO_AUTHORIZATION");

  // İzin var mı (user == 0 ise yok).
  if (!usable(action.user) || !usable(plan.agent) || !usable(plan.kule)) return reject("NO_AUTHORIZATION");

  // Adım 1: token yalnız kendi ajanının planındaki izni uygulayabilir.
  if (!isAddressEqual(plan.agent, cfg.tokenAgent)) return reject("WRONG_AGENT");

  // Kullanıcı bağı: plan yapılandırılmış kullanıcının ve bu KULE'nin.
  if (!isAddressEqual(action.user, cfg.planUser)) return reject("NO_AUTHORIZATION");
  if (!isAddressEqual(plan.kule, cfg.kuleReporter)) return reject("NO_AUTHORIZATION");

  return { ok: true };
}

/** Sağlıktan (adım 3) sonra: adım 4 (AUTHORIZED, plan aktif) ve adım 5 (zaman payı). planActive = isPlanActive(action.user). */
export function checkActionLive(
  action: Pick<ChainBuyAction, "state" | "openBy">,
  planActive: boolean,
  nowSec: number,
): BindingResult {
  if (!Number.isSafeInteger(nowSec) || nowSec < 0) return reject("NO_AUTHORIZATION");

  if (action.state !== AUTHORIZED) return reject("NO_AUTHORIZATION");
  if (planActive !== true) return reject("NO_AUTHORIZATION");

  if (action.openBy - BigInt(nowSec) < BigInt(MIN_OPEN_MARGIN_SEC)) return reject("TOO_LATE");

  return { ok: true };
}
