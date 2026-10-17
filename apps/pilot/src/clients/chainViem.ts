/**
 * Gerçek zincir istemcisi (viem). requestBuy PİLOT_AGENT hesabıyla imzalanır; kullanıcı yapılandırmadan sabittir.
 *
 * Fail-closed (CLAUDE.md kural 2):
 * - Önce simülasyon (eth_call): NotAgent gibi revert'ler ağa işlem göndermeden yakalanır.
 * - Sonuç yalnız makbuzdaki FlightPlan olayından okunur (simülasyonun dönüş değerine güvenilmez).
 *   Tam bir BuyAuthorized ya da BuyRejected olayı yoksa, olay başka kullanıcı/tutar gösteriyorsa ya da işlem
 *   revert ettiyse ChainError fırlatılır.
 */
import {
  createPublicClient,
  createWalletClient,
  isAddressEqual,
  parseEventLogs,
  zeroAddress,
  type Address,
  type Chain,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import {
  buyActionFromChain,
  buyArgsToChain,
  chainSecFromBigInt,
  cycleFromChain,
  ordTypeToChain,
  planFromChain,
  rejectCodeName,
  type BuyAction,
  type Cycle,
  type Plan,
} from "@pilot/shared";
import { FLIGHT_PLAN_ABI } from "./flightPlanAbi.js";
import { ChainError, type ChainClient, type RequestBuyArgs, type RequestBuyResult } from "./chain.js";

export interface ViemChainOptions {
  transport: Transport;
  chain: Chain;
  /** PİLOT_AGENT hesabı (privateKeyToAccount). Ham anahtar bu modülde tutulmaz. */
  account: LocalAccount;
  flightPlan: Address;
  /** Elif'in adresi (PLAN_USER_ADDRESS). */
  user: Address;
  /** Makbuz bekleme sınırı. TODO(spec): SPEC vermiyor; Fuji ~2 sn kesinlik, 60 sn seçildi. */
  receiptTimeoutMs?: number;
  pollingIntervalMs?: number;
}

export class ViemChainClient implements ChainClient {
  readonly agent: Address;
  readonly user: Address;
  private readonly pub: PublicClient<Transport, Chain>;
  private readonly wallet: WalletClient<Transport, Chain, LocalAccount>;
  private readonly flightPlan: Address;
  private readonly receiptTimeoutMs: number;

  constructor(o: ViemChainOptions) {
    if (isAddressEqual(o.user, zeroAddress) || isAddressEqual(o.flightPlan, zeroAddress)) {
      throw new ChainError("kullanıcı ya da FlightPlan adresi sıfır olamaz", { uncertain: false });
    }
    this.agent = o.account.address;
    this.user = o.user;
    this.flightPlan = o.flightPlan;
    this.receiptTimeoutMs = o.receiptTimeoutMs ?? 60_000;
    const pollingInterval = o.pollingIntervalMs ?? 1_000;
    this.pub = createPublicClient({ chain: o.chain, transport: o.transport, pollingInterval });
    this.wallet = createWalletClient({ chain: o.chain, transport: o.transport, account: o.account, pollingInterval });
  }

  async readPlan(): Promise<{ plan: Plan | null; active: boolean }> {
    const [raw, active] = await Promise.all([
      this.pub.readContract({ address: this.flightPlan, abi: FLIGHT_PLAN_ABI, functionName: "plans", args: [this.user] }),
      this.pub.readContract({ address: this.flightPlan, abi: FLIGHT_PLAN_ABI, functionName: "isPlanActive", args: [this.user] }),
    ]);
    // plans(user) plan yokken sıfır değerli döner.
    if (isAddressEqual(raw.agent, zeroAddress)) return { plan: null, active: false };
    return { plan: planFromChain(raw), active };
  }

  async readCycle(): Promise<Cycle> {
    const raw = await this.pub.readContract({ address: this.flightPlan, abi: FLIGHT_PLAN_ABI, functionName: "cycles", args: [this.user] });
    return cycleFromChain(raw);
  }

  async readAction(actionId: string): Promise<BuyAction | null> {
    const raw = await this.pub.readContract({
      address: this.flightPlan,
      abi: FLIGHT_PLAN_ABI,
      functionName: "actions",
      args: [BigInt(actionId)],
    });
    return buyActionFromChain(raw);
  }

  async requestBuy(a: RequestBuyArgs): Promise<RequestBuyResult> {
    const { amountTL, maxPxE6 } = buyArgsToChain(a.amountTL, a.maxPxE6);
    // TODO(spec): Pyth (A5) yok; pythUpdate boş ve msg.value 0 (kontrat ValueNotAccepted ile değeri reddeder).
    const args = [this.user, amountTL, maxPxE6, ordTypeToChain(a.ordType), a.reasonHash, []] as const;
    const started = Date.now();

    let request;
    try {
      ({ request } = await this.pub.simulateContract({
        address: this.flightPlan,
        abi: FLIGHT_PLAN_ABI,
        functionName: "requestBuy",
        args,
        account: this.wallet.account,
        value: 0n,
      }));
    } catch (e) {
      throw new ChainError("requestBuy simülasyonu başarısız; işlem gönderilmedi", { uncertain: false, cause: e });
    }

    let hash: Hex;
    try {
      hash = await this.wallet.writeContract(request);
    } catch (e) {
      throw new ChainError("requestBuy gönderilemedi; ağa gidip gitmediği bilinmiyor", { uncertain: true, cause: e });
    }

    let receipt;
    try {
      receipt = await this.pub.waitForTransactionReceipt({ hash, timeout: this.receiptTimeoutMs });
    } catch (e) {
      throw new ChainError(`requestBuy makbuzu alınamadı (${hash})`, { uncertain: true, cause: e });
    }
    const finalityMs = Math.max(0, Math.round(Date.now() - started));
    if (receipt.status !== "success") throw new ChainError(`requestBuy revert etti (${hash})`, { uncertain: false });

    const events = parseEventLogs({
      abi: FLIGHT_PLAN_ABI,
      logs: receipt.logs.filter((l) => isAddressEqual(l.address, this.flightPlan)),
      eventName: ["BuyAuthorized", "BuyRejected"],
    });
    if (events.length !== 1) throw new ChainError(`requestBuy makbuzunda tek izin olayı yok (${hash})`, { uncertain: true });
    const ev = events[0]!;
    if (!isAddressEqual(ev.args.user, this.user) || ev.args.amountTL !== amountTL) {
      throw new ChainError(`requestBuy olayı istekle uyuşmuyor (${hash})`, { uncertain: true });
    }
    if (ev.eventName === "BuyAuthorized") {
      if (ev.args.actionId === 0n) throw new ChainError("izin numarası 0", { uncertain: true });
      return {
        status: "AUTHORIZED",
        actionId: ev.args.actionId.toString(),
        openBy: chainSecFromBigInt(ev.args.openBy),
        tx: hash,
        finalityMs,
      };
    }
    return { status: "REJECTED", code: rejectCodeName(ev.args.code), tx: hash, finalityMs };
  }
}
