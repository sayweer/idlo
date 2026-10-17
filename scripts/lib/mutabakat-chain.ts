/**
 * Mutabakat zincir tarafı (§14): herkese açık RPC'den Elif'in BuyAuthorized ve BuyExecuted olayları.
 * Tarama deployments.deployBlock'tan başlar, parça parça (eth_getLogs blok aralığı sınırı) ilerler.
 * Zincire hiçbir işlem gönderilmez; anahtar gerekmez.
 */
import { getAbiItem, isAddressEqual, type Address, type Hex, type PublicClient } from "viem";
import {
  chainSecFromBigInt,
  execStatusFromChain,
  ordTypeFromChain,
  pxE6FromChain,
  tlFromChain,
  type ExecStatus,
  type OrdType,
} from "@pilot/shared";
import { FLIGHT_PLAN_SCRIPT_ABI } from "./mutabakat-abi.js";

/**
 * eth_getLogs parça boyutu (blok).
 * TODO(spec): SPEC vermiyor. [DOĞRULA] Fuji herkese açık RPC'nin aralık sınırı; en dar makul seçim 2048 blok.
 */
export const LOG_CHUNK_BLOCKS = 2048n;

const BUY_AUTHORIZED = getAbiItem({ abi: FLIGHT_PLAN_SCRIPT_ABI, name: "BuyAuthorized" });
const BUY_EXECUTED = getAbiItem({ abi: FLIGHT_PLAN_SCRIPT_ABI, name: "BuyExecuted" });

export interface ChainAuthorized {
  actionId: string;
  agentId: string;
  amountTL: number;
  maxPxE6: number;
  ordType: OrdType;
  openBy: number; // unix sn
  tx: Hex;
}

export interface ChainExecuted {
  actionId: string;
  ordId: string;
  filledTL: number;
  avgPxE6: number;
  status: ExecStatus;
  tx: Hex;
}

export interface ChainSnapshot {
  authorized: ChainAuthorized[];
  executed: ChainExecuted[];
  /** Son bloğun zamanı (unix sn). */
  nowSec: number;
  head: bigint;
}

export class ChainReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainReadError";
  }
}

export async function readChainSnapshot(
  pub: PublicClient,
  o: { flightPlan: Address; user: Address; fromBlock: bigint; expectedChainId: number; chunk?: bigint },
): Promise<ChainSnapshot> {
  const chunk = o.chunk ?? LOG_CHUNK_BLOCKS;
  if (chunk < 1n) throw new ChainReadError("parça boyutu en az 1 blok olmalı");

  const chainId = await pub.getChainId();
  if (chainId !== o.expectedChainId) throw new ChainReadError(`RPC zinciri ${chainId}, beklenen ${o.expectedChainId}`);

  const block = await pub.getBlock({ blockTag: "latest" });
  const head = block.number;
  if (head === null) throw new ChainReadError("son blok okunamadı");
  if (o.fromBlock > head) throw new ChainReadError(`deployBlock (${o.fromBlock}) son bloktan (${head}) büyük`);

  const authorized: ChainAuthorized[] = [];
  const executed: ChainExecuted[] = [];
  for (let from = o.fromBlock; from <= head; from += chunk) {
    const to = from + chunk - 1n > head ? head : from + chunk - 1n;
    const [auth, exec] = await Promise.all([
      pub.getLogs({
        address: o.flightPlan,
        event: BUY_AUTHORIZED,
        args: { user: o.user },
        fromBlock: from,
        toBlock: to,
        strict: true,
      }),
      pub.getLogs({
        address: o.flightPlan,
        event: BUY_EXECUTED,
        args: { user: o.user },
        fromBlock: from,
        toBlock: to,
        strict: true,
      }),
    ]);
    for (const l of auth) {
      // RPC filtresine güvenilmez: adres ve kullanıcı yeniden denetlenir.
      if (!isAddressEqual(l.address, o.flightPlan) || !isAddressEqual(l.args.user, o.user) || l.transactionHash === null) continue;
      authorized.push({
        actionId: l.args.actionId.toString(),
        agentId: l.args.agentId.toString(),
        amountTL: tlFromChain(l.args.amountTL),
        maxPxE6: pxE6FromChain(l.args.maxPxE6),
        ordType: ordTypeFromChain(l.args.ordType),
        openBy: chainSecFromBigInt(l.args.openBy),
        tx: l.transactionHash,
      });
    }
    for (const l of exec) {
      if (!isAddressEqual(l.address, o.flightPlan) || !isAddressEqual(l.args.user, o.user) || l.transactionHash === null) continue;
      executed.push({
        actionId: l.args.actionId.toString(),
        ordId: l.args.ordId,
        filledTL: tlFromChain(l.args.filledTL),
        avgPxE6: pxE6FromChain(l.args.avgPxE6),
        status: execStatusFromChain(l.args.status),
        tx: l.transactionHash,
      });
    }
  }
  return { authorized, executed, nowSec: chainSecFromBigInt(block.timestamp), head };
}
