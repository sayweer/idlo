/**
 * Zincir arayüzü (Fuji). KULE zincirden okur (parametreler çağıran değil zincirden gelir, CLAUDE.md kural 3) ve yalnız
 * reportExecution yazar. Gerçek uygulama viem (ViemKuleChain); testlerde FakeChain.
 *
 * Takım kararları (SPEC dışı, TODO(spec)):
 *  (b) ERC-8004 bağı: IdentityRegistry.getMetadata(agentId, "agentWallet") → plans(user).agent'a eşit olmalı.
 *  (c) Eski plan izinleri: BuyAuthorized, kullanıcının son PlanSet(immediate=true) / PlanRevoked bloğundan eskiyse reddedilir
 *      (commitPending de PlanSet(immediate=true) yayar).
 */
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  isAddressEqual,
  parseAbi,
  parseAbiItem,
  zeroAddress,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
  type LocalAccount,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalancheFuji } from "viem/chains";
import {
  buyActionFromChain,
  execStatusToChain,
  planFromChain,
  tlToChain,
  pxE6ToChain,
  type BuyAction,
  type Deployments,
  type ExecStatus,
  type Plan,
} from "@pilot/shared";

/** RPC/okuma hatası: zincirin durumu bilinmiyor → YENİ_EMİR_YOK. */
export class ChainUnreadableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ChainUnreadableError";
  }
}
/** Zincir okundu ama veri geçersiz/beklenmedik → fail-closed RET NO_AUTHORIZATION. */
export class ChainDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainDataError";
  }
}
/** reportExecution yazılamadı. uncertain: işlem ağa gitmiş olabilir. */
export class ChainWriteError extends Error {
  constructor(
    message: string,
    readonly uncertain: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ChainWriteError";
  }
}

export type PermitFreshness = "current" | "stale" | "unknown";

export interface ReportArgs {
  actionId: string;
  ordId: string;
  filledTL: number;
  avgPxE6: number;
  status: ExecStatus;
  reportHash: Hex;
}

export interface KuleChain {
  blockNumber(): Promise<number>;
  /** İzin yoksa null. */
  readAction(actionId: string): Promise<BuyAction | null>;
  /** Plan yoksa (plan.agent == 0) null. */
  readPlan(user: Address): Promise<Plan | null>;
  isPlanActive(user: Address): Promise<boolean>;
  /** (b) ERC-8004 agentWallet. Biçim bozuksa ChainDataError. */
  agentWallet(agentId: string): Promise<Address>;
  /** (c) İzin, kullanıcının son plan değişikliğinden yeni mi? Bulunamazsa "unknown". */
  permitFreshness(actionId: string, user: Address): Promise<PermitFreshness>;
  /** reportExecution gönderir; işlem özetini döndürür. */
  reportExecution(a: ReportArgs): Promise<Hex>;
}

// ─────────────────────────────── ABI ───────────────────────────────

export const FLIGHT_PLAN_ABI = parseAbi([
  "struct Plan { uint64 cycleTL; uint64 maxOrderTL; uint8 startDay; uint8 deadlineDay; uint16 maxWaitH; uint16 bandBps; uint16 closedBandBps; uint8 askMode; uint64 expiresAt; address agent; address kule; uint256 agentId; }",
  "struct BuyAction { address user; uint64 amountTL; uint64 maxPxE6; uint8 ordType; uint64 openBy; uint64 reportBy; uint32 cycleId; uint8 state; }",
  "function plans(address user) view returns (Plan)",
  "function actions(uint256 actionId) view returns (BuyAction)",
  "function isPlanActive(address user) view returns (bool)",
  "function reportExecution(uint256 actionId, string ordId, uint64 filledTL, uint64 avgPxE6, uint8 status, bytes32 reportHash)",
]);
export const IDENTITY_ABI = parseAbi(["function getMetadata(uint256 agentId, string metadataKey) view returns (bytes)"]);

const EV_PLAN_SET = parseAbiItem("event PlanSet(address indexed user, bytes32 planHash, bool immediate, uint64 activeAt)");
const EV_PLAN_REVOKED = parseAbiItem("event PlanRevoked(address indexed user)");
const EV_BUY_AUTHORIZED = parseAbiItem(
  "event BuyAuthorized(uint256 indexed actionId, address indexed user, uint256 indexed agentId, uint64 amountTL, uint64 maxPxE6, uint8 ordType, uint64 openBy, bytes32 reasonHash)",
);

// ─────────────────────── saf yardımcılar (testlenir) ───────────────────────

/**
 * ERC-8004 agentWallet baytlarını adrese çevirir: 20 bayt ham ya da 32 bayt abi kelimesi (üst 12 bayt sıfır).
 * Başka uzunluk, sıfır adres ya da kirli üst bayt → ChainDataError (fail-closed).
 */
export function decodeAgentWallet(data: Hex): Address {
  if (typeof data !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(data)) throw new ChainDataError("agentWallet baytları geçersiz");
  const hex = data.slice(2);
  let addr: string;
  if (hex.length === 40) addr = hex;
  else if (hex.length === 64) {
    if (!/^0{24}/.test(hex)) throw new ChainDataError("agentWallet abi kelimesinin üst baytları sıfır değil");
    addr = hex.slice(24);
  } else {
    throw new ChainDataError(`agentWallet uzunluğu geçersiz (${hex.length / 2} bayt)`);
  }
  const a = getAddress(`0x${addr}`);
  if (isAddressEqual(a, zeroAddress)) throw new ChainDataError("agentWallet sıfır adres");
  return a;
}

/** Blok + log sırası. */
export interface LogPos {
  block: bigint;
  logIndex: number;
}
export function posGreater(a: LogPos, b: LogPos): boolean {
  return a.block > b.block || (a.block === b.block && a.logIndex > b.logIndex);
}

/** Artımlı olay dizini: tek kullanıcının izinleri ve son plan değişikliği. */
export class PlanEventIndex {
  readonly permits = new Map<string, LogPos>();
  lastPlanChange: LogPos | null = null;

  addPlanChange(p: LogPos): void {
    if (this.lastPlanChange === null || posGreater(p, this.lastPlanChange)) this.lastPlanChange = p;
  }
  addPermit(actionId: string, p: LogPos): void {
    this.permits.set(actionId, p);
  }
  freshness(actionId: string): PermitFreshness {
    const permit = this.permits.get(actionId);
    if (!permit) return "unknown";
    if (this.lastPlanChange !== null && posGreater(this.lastPlanChange, permit)) return "stale";
    return "current";
  }
}

// ─────────────────────────────── viem uygulaması ───────────────────────────────

export interface ViemKuleChainOptions {
  rpcUrl?: string;
  transport?: Transport;
  chain?: Chain;
  deployments: Deployments;
  /** KULE_REPORTER hesabı. */
  account: LocalAccount;
  /** Yapılandırılmış kullanıcı (PLAN_USER_ADDRESS); olay dizini yalnız bunun için tutulur. */
  planUser: Address;
  receiptTimeoutMs?: number;
  pollingIntervalMs?: number;
  /** getLogs aralığı başlangıç boyutu (blok). */
  logChunk?: number;
}

export class ViemKuleChain implements KuleChain {
  private readonly pub: PublicClient<Transport, Chain>;
  private readonly wallet: WalletClient<Transport, Chain, LocalAccount>;
  private readonly flightPlan: Address;
  private readonly identity: Address;
  private readonly planUser: Address;
  private readonly account: LocalAccount;
  private readonly receiptTimeoutMs: number;
  private readonly index = new PlanEventIndex();
  private cursor: bigint;
  private chunk: number;
  private scanning: Promise<void> | null = null;

  constructor(o: ViemKuleChainOptions) {
    const transport = o.transport ?? http(o.rpcUrl);
    const chain = o.chain ?? avalancheFuji;
    const pollingInterval = o.pollingIntervalMs ?? 1_000;
    this.pub = createPublicClient({ chain, transport, pollingInterval });
    this.wallet = createWalletClient({ chain, transport, account: o.account, pollingInterval });
    this.account = o.account;
    this.flightPlan = o.deployments.flightPlan as Address;
    this.identity = o.deployments.erc8004.identity as Address;
    this.planUser = o.planUser;
    this.receiptTimeoutMs = o.receiptTimeoutMs ?? 60_000;
    this.cursor = BigInt(o.deployments.deployBlock) - 1n;
    this.chunk = o.logChunk ?? 50_000;
  }

  static account(privateKey: Hex): LocalAccount {
    return privateKeyToAccount(privateKey);
  }

  async blockNumber(): Promise<number> {
    try {
      return Number(await this.pub.getBlockNumber({ cacheTime: 0 }));
    } catch (e) {
      throw new ChainUnreadableError("blok numarası okunamadı", { cause: e });
    }
  }

  async readAction(actionId: string): Promise<BuyAction | null> {
    try {
      const raw = await this.pub.readContract({ address: this.flightPlan, abi: FLIGHT_PLAN_ABI, functionName: "actions", args: [BigInt(actionId)] });
      return buyActionFromChain(raw);
    } catch (e) {
      throw new ChainUnreadableError("izin okunamadı", { cause: e });
    }
  }

  async readPlan(user: Address): Promise<Plan | null> {
    let raw;
    try {
      raw = await this.pub.readContract({ address: this.flightPlan, abi: FLIGHT_PLAN_ABI, functionName: "plans", args: [user] });
    } catch (e) {
      throw new ChainUnreadableError("plan okunamadı", { cause: e });
    }
    if (isAddressEqual(raw.agent, zeroAddress)) return null;
    try {
      return planFromChain(raw);
    } catch (e) {
      throw new ChainDataError(`plan geçersiz: ${(e as Error).message}`);
    }
  }

  async isPlanActive(user: Address): Promise<boolean> {
    try {
      return await this.pub.readContract({ address: this.flightPlan, abi: FLIGHT_PLAN_ABI, functionName: "isPlanActive", args: [user] });
    } catch (e) {
      throw new ChainUnreadableError("plan durumu okunamadı", { cause: e });
    }
  }

  async agentWallet(agentId: string): Promise<Address> {
    let data: Hex;
    try {
      data = await this.pub.readContract({ address: this.identity, abi: IDENTITY_ABI, functionName: "getMetadata", args: [BigInt(agentId), "agentWallet"] });
    } catch (e) {
      throw new ChainUnreadableError("agentWallet okunamadı", { cause: e });
    }
    return decodeAgentWallet(data);
  }

  async permitFreshness(actionId: string, user: Address): Promise<PermitFreshness> {
    if (!isAddressEqual(user, this.planUser)) return "unknown";
    await this.refreshIndex();
    return this.index.freshness(actionId);
  }

  /** deployBlock'tan başlayarak artımlı tarama; aralık hatasında parça yarıya iner. Eşzamanlı çağrılar tek taramada birleşir. */
  private refreshIndex(): Promise<void> {
    this.scanning ??= this.scanOnce().finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }

  private async scanOnce(): Promise<void> {
    // cacheTime: 0 — viem blok numarasını varsayılan olarak önbellekler; PİLOT requestBuy sonrası hemen çağırdığı için bayat baş izni kaçırırdı.
    let head: bigint;
    try {
      head = await this.pub.getBlockNumber({ cacheTime: 0 });
    } catch (e) {
      throw new ChainUnreadableError("blok numarası okunamadı", { cause: e });
    }
    while (this.cursor < head) {
      const from = this.cursor + 1n;
      const to = from + BigInt(this.chunk) - 1n < head ? from + BigInt(this.chunk) - 1n : head;
      try {
        const [sets, revokes, auths] = await Promise.all([
          this.pub.getLogs({ address: this.flightPlan, event: EV_PLAN_SET, args: { user: this.planUser }, fromBlock: from, toBlock: to }),
          this.pub.getLogs({ address: this.flightPlan, event: EV_PLAN_REVOKED, args: { user: this.planUser }, fromBlock: from, toBlock: to }),
          this.pub.getLogs({ address: this.flightPlan, event: EV_BUY_AUTHORIZED, args: { user: this.planUser }, fromBlock: from, toBlock: to }),
        ]);
        for (const l of sets) {
          if (l.args.immediate === true && l.blockNumber !== null && l.logIndex !== null) {
            this.index.addPlanChange({ block: l.blockNumber, logIndex: l.logIndex });
          }
        }
        for (const l of revokes) {
          if (l.blockNumber !== null && l.logIndex !== null) this.index.addPlanChange({ block: l.blockNumber, logIndex: l.logIndex });
        }
        for (const l of auths) {
          if (l.args.actionId !== undefined && l.blockNumber !== null && l.logIndex !== null) {
            this.index.addPermit(l.args.actionId.toString(), { block: l.blockNumber, logIndex: l.logIndex });
          }
        }
        this.cursor = to;
      } catch (e) {
        if (this.chunk > 500) {
          this.chunk = Math.max(500, Math.floor(this.chunk / 2));
          continue;
        }
        throw new ChainUnreadableError("olay taraması başarısız", { cause: e });
      }
    }
  }

  async reportExecution(a: ReportArgs): Promise<Hex> {
    const args = [BigInt(a.actionId), a.ordId, tlToChain(a.filledTL), pxE6ToChain(a.avgPxE6), execStatusToChain(a.status), a.reportHash] as const;
    let request;
    try {
      ({ request } = await this.pub.simulateContract({
        address: this.flightPlan,
        abi: FLIGHT_PLAN_ABI,
        functionName: "reportExecution",
        args,
        account: this.account,
      }));
    } catch (e) {
      throw new ChainWriteError("reportExecution simülasyonu başarısız; işlem gönderilmedi", false, { cause: e });
    }
    let hash: Hex;
    try {
      hash = await this.wallet.writeContract(request);
    } catch (e) {
      throw new ChainWriteError("reportExecution gönderilemedi; ağa gidip gitmediği bilinmiyor", true, { cause: e });
    }
    let receipt;
    try {
      receipt = await this.pub.waitForTransactionReceipt({ hash, timeout: this.receiptTimeoutMs });
    } catch (e) {
      throw new ChainWriteError(`reportExecution makbuzu alınamadı (${hash})`, true, { cause: e });
    }
    if (receipt.status !== "success") throw new ChainWriteError(`reportExecution revert etti (${hash})`, false);
    return hash;
  }
}
