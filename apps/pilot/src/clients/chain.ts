/**
 * PİLOT'un zincir erişimi (§8.1, §8.3, §10.2 plan_oku / izin_iste). Gerçek: chainViem.ts; test/replay: fakeChain.ts.
 *
 * Güvenlik (CLAUDE.md kural 1, görev C4): kullanıcı adresi (`user`) istemci kurulurken yapılandırmadan sabitlenir.
 * requestBuy arayüzünde kullanıcı parametresi YOKTUR; LLM girdisinden hiçbir yol başka bir kullanıcıya izin isteyemez.
 */
import type { Address, Hex } from "viem";
import type { BuyAction, Cycle, OrdType, Plan, RejectCodeName, TL, PxE6, UnixSec } from "@pilot/shared";

export class ChainError extends Error {
  /** true: işlem ağa gitmiş olabilir, sonucu bilinmiyor (bu turda yeni izin istenmez). */
  readonly uncertain: boolean;
  constructor(message: string, opts: { uncertain: boolean; cause?: unknown }) {
    super(message, { cause: opts.cause });
    this.name = "ChainError";
    this.uncertain = opts.uncertain;
  }
}

export interface RequestBuyArgs {
  amountTL: TL;
  maxPxE6: PxE6;
  ordType: OrdType;
  reasonHash: Hex;
}

export type RequestBuyResult =
  | { status: "AUTHORIZED"; actionId: string; openBy: UnixSec; tx: Hex; finalityMs: number }
  | { status: "REJECTED"; code: RejectCodeName; tx: Hex; finalityMs: number };

export interface ChainClient {
  /** PİLOT_AGENT adresi (requestBuy'ı imzalayan hesap). */
  readonly agent: Address;
  /** Planı okunan ve izni istenen kullanıcı (Elif); yapılandırmadan sabit. */
  readonly user: Address;
  /** plans(user) + isPlanActive(user). Plan hiç kurulmadıysa plan = null. */
  readPlan(): Promise<{ plan: Plan | null; active: boolean }>;
  /** cycles(user): her zaman şimdiki TR ayının döngüsü. */
  readCycle(): Promise<Cycle>;
  /** actions(id); izin yoksa null. */
  readAction(actionId: string): Promise<BuyAction | null>;
  /** FlightPlan.requestBuy(user, …) — user sabit. Zincir reddi (BuyRejected) hata değil, sonuçtur. */
  requestBuy(args: RequestBuyArgs): Promise<RequestBuyResult>;
}
