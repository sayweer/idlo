/**
 * Doğrulanmış kullanıcılar (SYBIL KURALI, HANDOFF §5 KARAR madde 3).
 *
 * Neden: `setPlan` herkese açık; plandaki `agent`, `kule`, `agentId` alanları kullanıcının kendi beyanıdır ve
 * kontrat bunları birbirine bağlamaz. Bir olayın varlığı tek başına "bu ajanla gerçekten alım yapıldı" demek değildir.
 * Bu yüzden bir kullanıcı agentId X'in doğrulanmış müşterisi SAYILIR ancak ve ancak:
 *   (1) FlightPlan'da BuyAuthorized(actionId, user, agentId=X) vardır VE bu olayın işlemini X'in `agentWallet`
 *       adresi göndermiştir (requestBuy'ı ajanın kendisi çağırmıştır; başkası agentId=X yazıp ajanı taklit edemez), VE
 *   (2) aynı actionId için BuyExecuted(actionId, user, filledTL > 0) vardır VE bu olayın işlemini GÜVENİLEN KULE
 *       raporlayıcısı (`deployments.kuleReporter`) göndermiştir (kendi `kule` adresini yazan saldırgan kendi
 *       emrini "gerçekleşti" diye raporlayamaz).
 * Ek olarak ajanın kendisi, sahibi ve KULE raporlayıcısı müşteri sayılmaz (kendi kendine itibar üretme).
 *
 * TODO(spec): bu kural KULE raporlayıcısının dürüst olduğuna dayanır (güven noktası; KULE zaten emri veren taraftır).
 * Aynı kişinin birden çok cüzdanı hâlâ ayrı müşteri sayılır; MIN_VERIFIED_CLIENTS yalnız tek cüzdanı eler.
 */
import { getAddress, isAddress, isAddressEqual, zeroAddress, type Address, type Hex } from "viem";
import { MAX_VERIFIED_CLIENTS } from "@pilot/shared";
import type { DirectoryChain } from "./chain.js";

export interface AgentIdentityFacts {
  agentId: bigint;
  /** Identity `agentWallet`; null ise doğrulanmış müşteri yoktur. */
  wallet: Address | null;
  owner: Address | null;
}

export interface VerifyParams {
  /** deployments.kuleReporter: BuyExecuted'ı gönderebilecek tek güvenilen hesap. */
  kuleReporter: Address;
  /** deployments.deployBlock: olay taraması buradan başlar. */
  deployBlock: bigint;
}

/** agentId (ondalık string) → doğrulanmış kullanıcılar (checksum'lı, sıralı, tekrarsız, en çok MAX_VERIFIED_CLIENTS). */
export async function findVerifiedClients(
  chain: DirectoryChain,
  agents: readonly AgentIdentityFacts[],
  params: VerifyParams,
): Promise<Map<string, Address[]>> {
  if (!isAddress(params.kuleReporter) || isAddressEqual(params.kuleReporter, zeroAddress)) {
    throw new Error("kuleReporter geçerli ve sıfırdan farklı olmalı");
  }
  const result = new Map<string, Address[]>();
  const facts = new Map<bigint, AgentIdentityFacts & { wallet: Address }>();
  for (const a of agents) {
    result.set(a.agentId.toString(), []);
    if (a.wallet !== null) facts.set(a.agentId, { ...a, wallet: a.wallet });
  }
  if (facts.size === 0) return result;

  const senders = new Map<Hex, Promise<Address>>();
  const senderOf = (h: Hex) => {
    let p = senders.get(h);
    if (p === undefined) senders.set(h, (p = chain.txSender(h)));
    return p;
  };

  // (1) BuyAuthorized: işlemi ajanın agentWallet'ı göndermiş olmalı.
  const authorized = await chain.buyAuthorized([...facts.keys()], params.deployBlock);
  const byAction = new Map<bigint, { user: Address; agentId: bigint }>();
  for (const log of authorized) {
    const f = facts.get(log.agentId);
    if (f === undefined) continue; // sorgulanmayan agentId
    if (isAddressEqual(log.user, zeroAddress)) continue;
    if (
      isAddressEqual(log.user, f.wallet) ||
      isAddressEqual(log.user, params.kuleReporter) ||
      (f.owner !== null && isAddressEqual(log.user, f.owner))
    ) {
      continue; // kendi kendine itibar
    }
    if (!isAddressEqual(await senderOf(log.txHash), f.wallet)) continue; // agentId'yi başkası yazmış
    byAction.set(log.actionId, { user: log.user, agentId: log.agentId });
  }
  if (byAction.size === 0) return result;

  // (2) BuyExecuted: filledTL > 0 ve işlemi güvenilen KULE raporlayıcısı göndermiş olmalı.
  const executed = await chain.buyExecuted([...byAction.keys()], params.deployBlock);
  const sets = new Map<string, Map<string, Address>>();
  for (const log of executed) {
    const auth = byAction.get(log.actionId);
    if (auth === undefined) continue;
    if (!isAddressEqual(log.user, auth.user)) continue; // başka kullanıcı için raporlanmış
    if (log.filledTL <= 0n) continue; // hiçbir şey dolmadı
    if (!isAddressEqual(await senderOf(log.txHash), params.kuleReporter)) continue; // sahte KULE
    const key = auth.agentId.toString();
    const m = sets.get(key) ?? new Map<string, Address>();
    m.set(auth.user.toLowerCase(), getAddress(auth.user));
    sets.set(key, m);
  }
  for (const [key, m] of sets) {
    result.set(
      key,
      [...m.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())).slice(0, MAX_VERIFIED_CLIENTS),
    );
  }
  return result;
}
