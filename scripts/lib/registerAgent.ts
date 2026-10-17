/**
 * A3 çekirdeği (SPEC §8.5, §17.2 A3): PİLOT'u ERC-8004 Identity kaydına `register(agentURI)` ile yazar,
 * agentId'yi makbuzdaki olaylardan okur ve deployments/fuji.json'a ekler.
 * Bağımlılıklar (RPC istemcileri, dosya, fetch) dışarıdan verilir; CLI: scripts/register-agent.ts.
 *
 * Fail-closed sırası (işlemden önce hepsi): dosya geçerli → kayıtlı değil (ya da --force) → URI geçerli →
 * zincir 43113 (ya da --local) → kayıtta kod var → imzalayan = deployments.deployer → yayındaki agent.json geçerli →
 * simülasyon geçer. `--broadcast` yoksa burada durur, hiçbir şey göndermez/yazmaz.
 */
import { basename } from "node:path";
import { defineChain, isAddress, isAddressEqual, type Address, type Hex, type PublicClient, type WalletClient, type Account, type Chain, type Transport } from "viem";
import { avalancheFuji } from "viem/chains";
import { ERC8004_FUJI, FUJI_CHAIN_ID, parseDeployments } from "@pilot/shared";
import { checkServedCard, LOCAL_HOSTS, validateAgentUri } from "./agentCard.js";
import { withAgentId } from "./deploymentsFile.js";
import { extractAgentId, identityRegistryAbi } from "./erc8004.js";

export interface RegisterOptions {
  deploymentsPath: string;
  agentUri: string;
  rpcUrl: string;
  /** Yerel deneme: zincir kimliği serbest, kayıt adresi `registry` ile verilir, çıktı nokta ile başlayan dosya olmalı. */
  local: boolean;
  /** fuji.json'da agentId varken yeniden kayıt. */
  force: boolean;
  /** Yoksa yalnız kuru çalıştırma (simülasyon). */
  broadcast: boolean;
  /** Yalnız `local` ile. */
  registry?: Address;
}

export interface RegisterDeps {
  publicClient: PublicClient;
  walletClient: WalletClient<Transport, Chain | undefined, Account>;
  readFile(path: string): Promise<string | null>;
  /** Atomik yazım (geçici dosya + rename). */
  writeFile(path: string, text: string): Promise<void>;
  /** agentURI'deki JSON'u getirir. */
  fetchJson(uri: string): Promise<unknown>;
  log(line: string): void;
}

export type RegisterResult =
  | { dryRun: true; expectedAgentId: bigint; registry: Address }
  | { dryRun: false; agentId: bigint; txHash: Hex; registry: Address };

const USAGE =
  "kullanım: register-agent.ts --agent-uri https://<web>/agent.json [--rpc URL] [--deployments yol] [--broadcast] [--force] [--local --registry 0x…]";

/**
 * `--local` yalnız yerel makinedeki bir düğüme gider. TODO(spec): SPEC --local'ı tanımlamıyor; en dar seçim:
 * RPC açıkça verilmeli ve 127.0.0.1/localhost/[::1] olmalı (FUJI_RPC'ye düşülmez). "43113'ü reddet" seçilmedi,
 * çünkü `anvil --fork-url` (UI_HANDOFF §3.3) 43113 bildirir.
 */
function assertLocalRpc(rpcUrl: string | undefined): void {
  let host: string | undefined;
  try {
    host = rpcUrl === undefined ? undefined : new URL(rpcUrl).hostname;
  } catch {
    host = undefined;
  }
  if (host === undefined || !LOCAL_HOSTS.has(host)) {
    throw new Error("--local yalnız yerel RPC ile çalışır: --rpc http://127.0.0.1:<port> (localhost, [::1]) açıkça verilmeli; FUJI_RPC kullanılmaz");
  }
}

/** CLI argümanları. Bilinmeyen bayrak, eksik değer ya da tutarsız birleşim reddedilir. */
export function parseCliArgs(argv: readonly string[], env: Record<string, string | undefined>, defaultDeployments: string): RegisterOptions {
  const flags = new Set(["--broadcast", "--force", "--local"]);
  const valued = new Set(["--agent-uri", "--rpc", "--deployments", "--registry"]);
  const v: Record<string, string> = {};
  const f = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (flags.has(a)) f.add(a);
    else if (valued.has(a)) {
      const val = argv[++i];
      if (val === undefined || val.startsWith("--")) throw new Error(`${a} değer ister. ${USAGE}`);
      v[a] = val;
    } else throw new Error(`bilinmeyen argüman: ${a}. ${USAGE}`);
  }
  const agentUri = v["--agent-uri"];
  if (!agentUri) throw new Error(`--agent-uri zorunlu. ${USAGE}`);
  const local = f.has("--local");
  const registry = v["--registry"];
  if (registry !== undefined && !local) throw new Error("--registry yalnız --local ile kullanılır (Fuji'de Ek B adresi sabittir)");
  if (local && (registry === undefined || !isAddress(registry))) throw new Error("--local için --registry 0x… adresi zorunlu");
  if (local) assertLocalRpc(v["--rpc"]);
  const rpcUrl = local ? v["--rpc"] : (v["--rpc"] ?? env.FUJI_RPC);
  if (!rpcUrl) throw new Error(`RPC yok: --rpc ya da FUJI_RPC. ${USAGE}`);
  return {
    deploymentsPath: v["--deployments"] ?? defaultDeployments,
    agentUri,
    rpcUrl,
    local,
    force: f.has("--force"),
    broadcast: f.has("--broadcast"),
    registry: registry as Address | undefined,
  };
}

export async function registerAgent(opts: RegisterOptions, deps: RegisterDeps): Promise<RegisterResult> {
  const { publicClient, walletClient, log } = deps;

  // 1. deployments dosyası
  if (opts.local && !basename(opts.deploymentsPath).startsWith(".")) {
    throw new Error("--local gerçek deployments dosyasına yazamaz: dosya adı nokta ile başlamalı (ör. deployments/.anvil.json)");
  }
  if (opts.local) assertLocalRpc(opts.rpcUrl);
  const text = await deps.readFile(opts.deploymentsPath);
  const d = parseDeployments(text);
  if (d.agentId !== undefined && !opts.force) {
    throw new Error(`PİLOT zaten kayıtlı (agentId=${d.agentId}). Yeniden kayıt için --force (eski agentId'nin üzerine yazar)`);
  }

  // 2. URI, zincir, kayıt adresi
  // Zincire yalnız denetlenen (kanonik) metin yazılır; ham girdi bundan sonra kullanılmaz.
  const agentUri = validateAgentUri(opts.agentUri, { local: opts.local });
  const chainId = await publicClient.getChainId();
  if (!opts.local && chainId !== FUJI_CHAIN_ID) throw new Error(`zincir ${chainId}; Fuji (${FUJI_CHAIN_ID}) bekleniyor. Yerel deneme için --local`);
  // Gönderimde viem eth_chainId'yi bu zincirle yeniden karşılaştırır ve EIP-155 imzasına bu kimliği koyar;
  // böylece yukarıdaki denetim imzaya bağlanır (denetim ile gönderim arasında RPC değişse bile).
  const chain: Chain = opts.local
    ? defineChain({ id: chainId, name: `yerel ${chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [opts.rpcUrl] } } })
    : avalancheFuji;
  const registry: Address = opts.local ? opts.registry! : ERC8004_FUJI.identity;
  const code = await publicClient.getCode({ address: registry });
  if (!code || code === "0x") throw new Error(`Identity kaydında kod yok: ${registry} (zincir ${chainId})`);

  // 3. imzalayan
  const signer = walletClient.account.address;
  if (!isAddressEqual(signer, d.deployer)) {
    // TODO(spec): SPEC kaydı kimin yapacağını söylemiyor; en dar seçim: fuji.json'daki deployer (sıcak PİLOT anahtarı değil).
    throw new Error(`imzalayan ${signer}, deployments.deployer ${d.deployer} değil`);
  }

  // 4. yayındaki kayıt dosyası (URL A3'ten önce sabit olmalı, UI_HANDOFF §2.6)
  let served: unknown;
  try {
    served = await deps.fetchJson(agentUri);
  } catch (e) {
    throw new Error(`agentURI okunamadı (${agentUri}): ${(e as Error).message}`);
  }
  checkServedCard(served);

  // 5. simülasyon
  const { result: expectedAgentId, request } = await publicClient.simulateContract({
    address: registry,
    abi: identityRegistryAbi,
    functionName: "register",
    args: [agentUri],
    account: walletClient.account,
  });
  log(`kayıt: ${registry} (zincir ${chainId}), imzalayan ${signer}, agentURI ${agentUri}`);
  if (!opts.broadcast) {
    log(`KURU ÇALIŞTIRMA: beklenen agentId ≈ ${expectedAgentId}. Gönderim yok, dosya yazılmadı. Göndermek için --broadcast`);
    return { dryRun: true, expectedAgentId, registry };
  }

  // 6. gönderim ve makbuz
  // Gönderim ya da makbuz beklemesi hata verirse işlem zincirde olabilir: fuji.json'da agentId olmadığından yeniden
  // --broadcast çift kayıt yapar. Bu yüzden hata tx hash'ini (biliniyorsa) ve "tekrarlama" uyarısını taşır.
  let txHash: Hex;
  try {
    txHash = await walletClient.writeContract({ ...request, chain });
  } catch (e) {
    throw new Error(
      `İŞLEM GÖNDERİLMİŞ OLABİLİR: tx bilinmiyor (${(e as Error).message}). ` +
        `Gezginde ${signer} adresinin son işlemini/nonce'unu kontrol et; kontrol etmeden --broadcast'ı tekrarlama (çift kayıt).`,
    );
  }
  log(`işlem gönderildi: ${txHash}`);
  let receipt: Awaited<ReturnType<PublicClient["waitForTransactionReceipt"]>>;
  try {
    receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  } catch (e) {
    throw new Error(
      `İŞLEM GÖNDERİLDİ, SONUÇ BİLİNMİYOR: tx ${txHash} (${(e as Error).message}). Gezginde kontrol et; ` +
        `kayıt zincirdeyse agentId'yi ${opts.deploymentsPath} dosyasına elle ekle. --broadcast'ı tekrarlama (çift kayıt).`,
    );
  }
  // Revert: zincirde kayıt yok, yeniden denemek güvenli.
  if (receipt.status !== "success") throw new Error(`kayıt işlemi başarısız (revert), zincir değişmedi: ${txHash}`);

  // 7. agentId ve dosya. Bu noktada kayıt zincirde; hata olursa elle kurtarma bilgisi verilir.
  let agentId: bigint | undefined;
  try {
    agentId = extractAgentId(receipt.logs, registry, signer);
    const now = await deps.readFile(opts.deploymentsPath);
    if (now === null || now !== text) throw new Error("deployments dosyası çalışma sırasında değişti");
    await deps.writeFile(opts.deploymentsPath, withAgentId(now, agentId));
  } catch (e) {
    throw new Error(
      `KAYIT ZİNCİRDE AMA DOSYA YAZILMADI: ${(e as Error).message}. işlem ${txHash}, agentId ${agentId ?? "okunamadı"}. ` +
        `Olayı gezginde kontrol edip agentId'yi ${opts.deploymentsPath} dosyasına elle ekle.`,
    );
  }
  log(`agentId ${agentId} → ${opts.deploymentsPath}`);
  return { dryRun: false, agentId, txHash, registry };
}
