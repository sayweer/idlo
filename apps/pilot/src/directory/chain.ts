/**
 * Dizinin zincir arayüzü (port) ve viem uygulaması. Dizin mantığı (eşik, sybil kuralı) yalnız bu arayüze dayanır;
 * testler sahtesini verir, gerçekte `viemDirectoryChain` kullanılır.
 *
 * Doğrulanmış Fuji gerçekleri: Identity `tokenURI`, `ownerOf`, `getMetadata(uint256,string)` ("agentWallet" → 20 ham
 * bayt) var; `totalSupply` YOK (adaylar yapılandırılmış agentId listesinden gelir). Reputation
 * `getSummary(agentId, address[] clients, tag1, tag2) → (uint64 count, int128 value, uint8 decimals)`; clients boşsa
 * "clientAddresses required" ile revert eder.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  getAddress,
  parseAbi,
  parseAbiItem,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import type { Deployments } from "@pilot/shared";

// ───────────────────────────── ABI parçaları ─────────────────────────────

/**
 * TODO(spec): scripts/lib/erc8004.ts yalnız yazma (register/giveFeedback) ABI'sini taşır ve pilot uygulamasından
 * içe aktarılamaz; okuma imzaları Fuji'de canlı doğrulandı (görev notu), burada yalnız okuma kısmı tanımlı.
 */
export const IDENTITY_READ_ABI = parseAbi([
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function getMetadata(uint256 agentId, string metadataKey) view returns (bytes)",
]);
export const REPUTATION_READ_ABI = parseAbi([
  "function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 value, uint8 decimals)",
]);

/** contracts/src/interfaces/IFlightPlan.sol olayları (flightPlanAbi.ts yalnız BuyAuthorized'ı taşır). */
export const BUY_AUTHORIZED_EVENT = parseAbiItem(
  "event BuyAuthorized(uint256 indexed actionId, address indexed user, uint256 indexed agentId, uint64 amountTL, uint64 maxPxE6, uint8 ordType, uint64 openBy, bytes32 reasonHash)",
);
export const BUY_EXECUTED_EVENT = parseAbiItem(
  "event BuyExecuted(uint256 indexed actionId, address indexed user, string ordId, uint64 filledTL, uint64 avgPxE6, uint8 status, bytes32 reportHash)",
);

// ───────────────────────────── Port ─────────────────────────────

export interface AuthorizedLog {
  actionId: bigint;
  user: Address;
  agentId: bigint;
  txHash: Hex;
}
export interface ExecutedLog {
  actionId: bigint;
  user: Address;
  /** Zincir birimi (uint64 TL); yalnız > 0 karşılaştırılır. */
  filledTL: bigint;
  txHash: Hex;
}
export interface ReputationSummary {
  count: bigint;
  value: bigint;
  decimals: number;
}

export interface DirectoryChain {
  /** Kayıt yoksa null; ağ/RPC hatasında fırlatır (fail-closed: belirsizlik "yok" sayılmaz). */
  ownerOf(agentId: bigint): Promise<Address | null>;
  tokenURI(agentId: bigint): Promise<string | null>;
  /** `getMetadata(agentId, "agentWallet")` ham baytları; yoksa null ("0x" gibi boş değerler çağıranda elenir). */
  agentWalletBytes(agentId: bigint): Promise<Hex | null>;
  /** Yalnız `clients` boş değilken çağrılmalı (kontrat boşta revert eder). */
  reputationSummary(agentId: bigint, clients: readonly Address[]): Promise<ReputationSummary>;
  /** FlightPlan.BuyAuthorized, verilen agentId'ler için, `fromBlock`'tan son bloğa. */
  buyAuthorized(agentIds: readonly bigint[], fromBlock: bigint): Promise<AuthorizedLog[]>;
  /** FlightPlan.BuyExecuted, verilen actionId'ler için, `fromBlock`'tan son bloğa. */
  buyExecuted(actionIds: readonly bigint[], fromBlock: bigint): Promise<ExecutedLog[]>;
  /** İşlemi GÖNDEREN hesap (`tx.from`). */
  txSender(hash: Hex): Promise<Address>;
}

// ───────────────────────────── viem uygulaması ─────────────────────────────

export interface ViemDirectoryOptions {
  /** getLogs aralığı (blok). Fuji genel RPC ~2048 ile sınırlı. TODO(spec): SPEC vermiyor. */
  logChunkBlocks?: number;
  /** getLogs'a tek seferde verilecek indeksli değer sayısı. */
  topicBatch?: number;
}

/** Sözleşme "yok/boş" dedi (revert ya da sıfır veri) mi? Bunun dışındaki her hata (ağ, zaman aşımı) fırlatılır. */
function isContractNotFound(e: unknown): boolean {
  return (
    e instanceof BaseError &&
    e.walk((x) => x instanceof ContractFunctionRevertedError || x instanceof ContractFunctionZeroDataError) !== null
  );
}

function* ranges(from: bigint, to: bigint, chunk: bigint): Generator<[bigint, bigint]> {
  for (let a = from; a <= to; a += chunk) yield [a, a + chunk - 1n < to ? a + chunk - 1n : to];
}

export function viemDirectoryChain(
  client: Pick<PublicClient, "readContract" | "getLogs" | "getBlockNumber" | "getTransaction">,
  deployments: Pick<Deployments, "flightPlan" | "erc8004">,
  opts: ViemDirectoryOptions = {},
): DirectoryChain {
  const chunk = BigInt(opts.logChunkBlocks ?? 2048);
  const batch = opts.topicBatch ?? 50;
  if (chunk <= 0n || batch <= 0) throw new RangeError("logChunkBlocks ve topicBatch pozitif olmalı");
  const identity = deployments.erc8004.identity as Address;
  const reputation = deployments.erc8004.reputation as Address;
  const flightPlan = deployments.flightPlan as Address;

  async function readIdentity<T>(fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (e) {
      if (isContractNotFound(e)) return null;
      throw e;
    }
  }

  async function scan<T>(
    ids: readonly bigint[],
    fromBlock: bigint,
    one: (batchIds: bigint[], a: bigint, b: bigint) => Promise<T[]>,
  ): Promise<T[]> {
    if (ids.length === 0) return [];
    const latest = await client.getBlockNumber();
    const out: T[] = [];
    for (let i = 0; i < ids.length; i += batch) {
      const part = ids.slice(i, i + batch);
      for (const [a, b] of ranges(fromBlock, latest, chunk)) out.push(...(await one(part, a, b)));
    }
    return out;
  }

  return {
    ownerOf: (id) =>
      readIdentity(async () =>
        getAddress(await client.readContract({ address: identity, abi: IDENTITY_READ_ABI, functionName: "ownerOf", args: [id] })),
      ),
    tokenURI: (id) =>
      readIdentity(() => client.readContract({ address: identity, abi: IDENTITY_READ_ABI, functionName: "tokenURI", args: [id] })),
    agentWalletBytes: (id) =>
      readIdentity(() =>
        client.readContract({ address: identity, abi: IDENTITY_READ_ABI, functionName: "getMetadata", args: [id, "agentWallet"] }),
      ),
    async reputationSummary(id, clients) {
      const [count, value, decimals] = await client.readContract({
        address: reputation,
        abi: REPUTATION_READ_ABI,
        functionName: "getSummary",
        args: [id, [...clients], "", ""],
      });
      return { count, value, decimals };
    },
    buyAuthorized: (agentIds, fromBlock) =>
      scan(agentIds, fromBlock, async (ids, a, b) => {
        const logs = await client.getLogs({
          address: flightPlan,
          event: BUY_AUTHORIZED_EVENT,
          args: { agentId: ids },
          fromBlock: a,
          toBlock: b,
        });
        return logs.flatMap((l) =>
          l.transactionHash === null || l.args.actionId === undefined || l.args.user === undefined || l.args.agentId === undefined
            ? []
            : [{ actionId: l.args.actionId, user: l.args.user, agentId: l.args.agentId, txHash: l.transactionHash }],
        );
      }),
    buyExecuted: (actionIds, fromBlock) =>
      scan(actionIds, fromBlock, async (ids, a, b) => {
        const logs = await client.getLogs({
          address: flightPlan,
          event: BUY_EXECUTED_EVENT,
          args: { actionId: ids },
          fromBlock: a,
          toBlock: b,
        });
        return logs.flatMap((l) =>
          l.transactionHash === null || l.args.actionId === undefined || l.args.user === undefined || l.args.filledTL === undefined
            ? []
            : [{ actionId: l.args.actionId, user: l.args.user, filledTL: l.args.filledTL, txHash: l.transactionHash }],
        );
      }),
    async txSender(hash) {
      const tx = await client.getTransaction({ hash });
      return getAddress(tx.from);
    },
  };
}
