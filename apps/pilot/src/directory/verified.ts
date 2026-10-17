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
 * Maliyet (spam dayanımı): BuyAuthorized'ı herkes yayabilir (agentId serbest alan), bu yüzden işlem göndereni
 * sorgusu (`txSender`, RPC) YALNIZ olay çiftleri birleştirildikten sonra yapılır: önce ucuz kodla eleme (kendi
 * kendine itibar), sonra BuyExecuted ile birleştirme (filledTL > 0, aynı kullanıcı), en son kalan çiftler için
 * sınırlı eşzamanlılıkla gönderen sorgusu. Spam BuyAuthorized'ın RPC maliyeti sıfırdır. Bütçe aşımı ve gönderen
 * sorgusu hatası YALNIZ o ajanı okunamaz yapar (`failed`); diğer ajanlar etkilenmez. Olay taramasının kendisi
 * (getLogs) başarısızsa tüm ajanlar için fırlatır (RPC tümden kapalı).
 *
 * TODO(spec): bu kural KULE raporlayıcısının dürüst olduğuna dayanır (güven noktası; KULE zaten emri veren taraftır).
 * Aynı kişinin birden çok cüzdanı hâlâ ayrı müşteri sayılır; MIN_VERIFIED_CLIENTS yalnız tek cüzdanı eler.
 * TODO(spec): sonuç bloğa göre önbelleğe alınmıyor; her seçimde deployBlock'tan taranır (indeksleyici gerekir).
 * TODO(spec): bütçe aşımı ajanı eler (fail-closed); bütçeyi aşacak kadar spam, tek bir ajanı dizinden düşürebilir.
 */
import { getAddress, isAddress, isAddressEqual, zeroAddress, type Address, type Hex } from "viem";
import { MAX_VERIFIED_CLIENTS } from "@pilot/shared";
import type { DirectoryChain } from "./chain.js";
import { mapLimit } from "./reputation.js";

/** Bir ajan için uzaktan bakılacak BuyAuthorized sayısı üst sınırı (ucuz elemeden sonra). TODO(spec): SPEC vermiyor. */
export const MAX_AUTHORIZED_LOGS_PER_AGENT = 1_000;
/** Bir ajan için en çok kaç (izin, rapor) çiftinin işlem göndereni (RPC) sorgulanır. TODO(spec): SPEC vermiyor. */
export const MAX_SENDER_LOOKUPS_PER_AGENT = 200;
/** txSender sorgularının eşzamanlılığı. */
export const SENDER_CONCURRENCY = 8;

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

export interface VerifyOutcome {
  /** agentId (ondalık string) → doğrulanmış kullanıcılar (checksum'lı, sıralı, tekrarsız, en çok MAX_VERIFIED_CLIENTS). */
  clients: Map<string, Address[]>;
  /** agentId → okunamama nedeni (yalnız o ajan; fail-closed). */
  failed: Map<string, string>;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 160);

/** Ajan başına izolasyonlu doğrulama: bir ajanın hatası ya da bütçe aşımı diğerlerini düşürmez. */
export async function verifyClients(
  chain: DirectoryChain,
  agents: readonly AgentIdentityFacts[],
  params: VerifyParams,
): Promise<VerifyOutcome> {
  if (!isAddress(params.kuleReporter) || isAddressEqual(params.kuleReporter, zeroAddress)) {
    throw new Error("kuleReporter geçerli ve sıfırdan farklı olmalı");
  }
  const clients = new Map<string, Address[]>();
  const failed = new Map<string, string>();
  const facts = new Map<bigint, AgentIdentityFacts & { wallet: Address }>();
  for (const a of agents) {
    clients.set(a.agentId.toString(), []);
    if (a.wallet !== null) facts.set(a.agentId, { ...a, wallet: a.wallet });
  }
  if (facts.size === 0) return { clients, failed };

  // (1) BuyAuthorized taraması + ucuz eleme (RPC yok): kendi kendine itibar, sıfır adres.
  const authorized = await chain.buyAuthorized([...facts.keys()], params.deployBlock);
  const perAgent = new Map<bigint, Map<bigint, { user: Address; txHash: Hex }>>();
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
    const m = perAgent.get(log.agentId) ?? new Map<bigint, { user: Address; txHash: Hex }>();
    m.set(log.actionId, { user: log.user, txHash: log.txHash });
    perAgent.set(log.agentId, m);
  }
  for (const [agentId, m] of [...perAgent]) {
    if (m.size > MAX_AUTHORIZED_LOGS_PER_AGENT) {
      failed.set(agentId.toString(), `çok fazla BuyAuthorized olayı (${m.size} > ${MAX_AUTHORIZED_LOGS_PER_AGENT})`);
      perAgent.delete(agentId);
    }
  }
  if (perAgent.size === 0) return { clients, failed };

  // (2) BuyExecuted taraması (yalnız elemeden geçen actionId'ler) ve birleştirme: filledTL > 0, aynı kullanıcı.
  const actionToAgent = new Map<bigint, bigint>();
  for (const [agentId, m] of perAgent) for (const actionId of m.keys()) actionToAgent.set(actionId, agentId);
  const executed = await chain.buyExecuted([...actionToAgent.keys()], params.deployBlock);
  // agentId → actionId → BuyExecuted işlemleri (aynı actionId için birden çok rapor olabilir)
  const joined = new Map<bigint, Map<bigint, Hex[]>>();
  for (const log of executed) {
    const agentId = actionToAgent.get(log.actionId);
    if (agentId === undefined) continue;
    const auth = perAgent.get(agentId)?.get(log.actionId);
    if (auth === undefined) continue;
    if (!isAddressEqual(log.user, auth.user)) continue; // başka kullanıcı için raporlanmış
    if (log.filledTL <= 0n) continue; // hiçbir şey dolmadı
    const byAction = joined.get(agentId) ?? new Map<bigint, Hex[]>();
    byAction.set(log.actionId, [...(byAction.get(log.actionId) ?? []), log.txHash]);
    joined.set(agentId, byAction);
  }

  // (3) Yalnız birleşen çiftler için işlem göndereni: önce KULE raporu (spam burada elenir), sonra ajan izni.
  const senders = new Map<Hex, Promise<Address>>();
  const senderOf = (h: Hex): Promise<Address> => {
    let p = senders.get(h);
    if (p === undefined) senders.set(h, (p = chain.txSender(h)));
    return p;
  };
  await Promise.all(
    [...joined].map(async ([agentId, byAction]) => {
      const key = agentId.toString();
      const f = facts.get(agentId)!;
      try {
        const pairs = [...byAction].map(([actionId, reportTxs]) => ({ actionId, reportTxs, auth: perAgent.get(agentId)!.get(actionId)! }));
        const verified = new Map<string, Address>();
        let lookups = 0;
        const pending = [...pairs];
        while (pending.length > 0) {
          // Aynı kullanıcı doğrulandıktan sonra onun diğer çiftleri atlanır (gereksiz RPC yok).
          const wave: typeof pairs = [];
          while (wave.length < SENDER_CONCURRENCY && pending.length > 0) {
            const p = pending.shift()!;
            if (!verified.has(p.auth.user.toLowerCase())) wave.push(p);
          }
          if (wave.length === 0) break;
          lookups += wave.length;
          if (lookups > MAX_SENDER_LOOKUPS_PER_AGENT) throw new RangeError(`çok fazla işlem göndereni sorgusu (> ${MAX_SENDER_LOOKUPS_PER_AGENT} çift)`);
          const oks = await mapLimit(wave, SENDER_CONCURRENCY, async (p) => {
            let reportedByKule = false;
            for (const tx of p.reportTxs) {
              if (isAddressEqual(await senderOf(tx), params.kuleReporter)) {
                reportedByKule = true;
                break;
              }
            }
            if (!reportedByKule) return false; // sahte KULE
            return isAddressEqual(await senderOf(p.auth.txHash), f.wallet); // agentId'yi başkası yazmış → false
          });
          wave.forEach((p, k) => {
            if (oks[k]) verified.set(p.auth.user.toLowerCase(), getAddress(p.auth.user));
          });
        }
        clients.set(
          key,
          [...verified.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())).slice(0, MAX_VERIFIED_CLIENTS),
        );
      } catch (e) {
        failed.set(key, errText(e));
      }
    }),
  );
  return { clients, failed };
}

/** Eski sözleşme: ajan başına hata yok sayılmaz, herhangi bir ajan okunamazsa fırlatır (fail-closed). */
export async function findVerifiedClients(
  chain: DirectoryChain,
  agents: readonly AgentIdentityFacts[],
  params: VerifyParams,
): Promise<Map<string, Address[]>> {
  const { clients, failed } = await verifyClients(chain, agents, params);
  if (failed.size > 0) throw new Error(`doğrulanmış kullanıcılar okunamadı: ${[...failed].map(([k, v]) => `${k}: ${v}`).join("; ")}`);
  return clients;
}
