/**
 * Aday okuyucu: yapılandırılmış agentId listesi → Identity kaydı (tokenURI, ownerOf, agentWallet) → `agent.json`
 * kartı → doğrulanmış kullanıcılar → itibar. Identity kaydında `totalSupply` yok, bu yüzden adaylar listeden gelir.
 *
 * Okuma hataları sessizce yutulmaz: `issuesTr`'ye yazılır ve `readFailed` ile aday elenir (fail-closed).
 * Kart, ajanın kimliği için kanıt değildir; yalnız kimlik kaydı (zincir) ve doğrulanmış müşteriler sayılır.
 */
import { getAddress, isAddress, isAddressEqual, zeroAddress, type Address, type Hex } from "viem";
import {
  MAX_VERIFIED_CLIENTS,
  Uint256StringSchema,
  agentRegistryId,
  cardClaimsAgent,
  type Candidate,
  type Deployments,
} from "@pilot/shared";
import type { DirectoryChain } from "./chain.js";
import { fetchAgentCard } from "./card.js";
import { readReputation } from "./reputation.js";
import { verifyClients } from "./verified.js";

/** TODO(spec): SPEC aday sayısı sınırı vermiyor; sohbet başına zincir okuması sınırlı kalsın. */
export const MAX_CANDIDATES = 50;

export interface CandidateRef {
  /** uint256 ondalık string. */
  agentId: string;
  /** DEMO etiketi koddaki listeden gelir (kartın beyanı güvenilmez). */
  demo?: boolean;
}

export interface RegistryConfig {
  chain: DirectoryChain;
  deployments: Pick<Deployments, "chainId" | "kuleReporter" | "deployBlock" | "erc8004">;
  /** Yerel kip: kartlar http://127.0.0.1'den okunabilir. */
  local: boolean;
  fetch?: typeof fetch;
}

/** agentWallet baytları: tam 20 bayt ve sıfır olmayan adres; değilse null. */
export function parseAgentWallet(bytes: Hex | null): Address | null {
  if (bytes === null || !/^0x[0-9a-fA-F]{40}$/.test(bytes)) return null;
  if (!isAddress(bytes.toLowerCase())) return null;
  const a = getAddress(bytes.toLowerCase());
  return isAddressEqual(a, zeroAddress) ? null : a;
}

function validateRefs(refs: readonly CandidateRef[]): CandidateRef[] {
  if (refs.length > MAX_CANDIDATES) throw new RangeError(`en fazla ${MAX_CANDIDATES} aday okunur`);
  const seen = new Set<string>();
  const out: CandidateRef[] = [];
  for (const r of refs) {
    const id = Uint256StringSchema.parse(r.agentId);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ agentId: id, demo: r.demo === true });
  }
  return out;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 160);

async function loadIdentity(ref: CandidateRef, cfg: RegistryConfig): Promise<Candidate> {
  const id = BigInt(ref.agentId);
  const c: Candidate = {
    agentId: ref.agentId,
    demo: ref.demo === true,
    readFailed: false,
    hasIdentity: false,
    owner: null,
    agentWallet: null,
    card: null,
    cardIssueTr: null,
    verifiedClients: [],
    feedbackCount: 0,
    feedbackClients: 0,
    score: null,
    issuesTr: [],
  };
  try {
    const owner = await cfg.chain.ownerOf(id);
    if (owner === null || isAddressEqual(owner, zeroAddress)) {
      c.issuesTr.push("Identity kaydında bu kimlik yok.");
      return c;
    }
    c.hasIdentity = true;
    c.owner = owner;
    const [uri, walletBytes] = await Promise.all([cfg.chain.tokenURI(id), cfg.chain.agentWalletBytes(id)]);
    c.agentWallet = parseAgentWallet(walletBytes);
    if (c.agentWallet === null) c.issuesTr.push("Kimlikte agentWallet yok ya da geçersiz.");
    if (uri === null || uri === "") {
      c.cardIssueTr = "Kimlikte ajan kartı adresi (tokenURI) yok.";
    } else {
      const r = await fetchAgentCard(uri, { local: cfg.local, ...(cfg.fetch ? { fetch: cfg.fetch } : {}) });
      if (!r.ok) c.cardIssueTr = r.reasonTr;
      else if (!r.card.active) c.cardIssueTr = "Ajan kartı pasif işaretli.";
      else if (!cardClaimsAgent(r.card, ref.agentId, agentRegistryId(cfg.deployments.chainId, cfg.deployments.erc8004.identity))) {
        c.cardIssueTr = "Ajan kartı bu kimliğin kaydını göstermiyor.";
      } else c.card = r.card;
    }
  } catch (e) {
    c.readFailed = true;
    c.issuesTr.push(`Zincir okunamadı: ${errText(e)}`);
  }
  return c;
}

/** Adayları okur ve doğrulanmış müşteri + itibar bilgisini ekler. Dönen liste girdi sırasındadır. */
export async function loadCandidates(refs: readonly CandidateRef[], cfg: RegistryConfig): Promise<Candidate[]> {
  const list = validateRefs(refs);
  const candidates = await Promise.all(list.map((r) => loadIdentity(r, cfg)));

  // Doğrulanmış müşteriler (tek tarama, tüm adaylar için).
  const live = candidates.filter((c) => !c.readFailed && c.agentWallet !== null);
  try {
    const { clients, failed } = await verifyClients(
      cfg.chain,
      live.map((c) => ({ agentId: BigInt(c.agentId), wallet: c.agentWallet, owner: c.owner })),
      { kuleReporter: cfg.deployments.kuleReporter as Address, deployBlock: BigInt(cfg.deployments.deployBlock) },
    );
    for (const c of live) {
      const why = failed.get(c.agentId);
      if (why !== undefined) {
        // Ajan başına hata: yalnız bu aday okunamaz sayılır (diğerleri etkilenmez).
        c.readFailed = true;
        c.issuesTr.push(`Doğrulanmış kullanıcılar okunamadı: ${why}`);
      } else c.verifiedClients = (clients.get(c.agentId) ?? []).slice(0, MAX_VERIFIED_CLIENTS);
    }
  } catch (e) {
    for (const c of live) {
      c.readFailed = true;
      c.issuesTr.push(`Doğrulanmış kullanıcılar okunamadı: ${errText(e)}`);
    }
  }

  // İtibar: yalnız doğrulanmış kullanıcı varsa çağrılır (readReputation boşta çağırmaz).
  await Promise.all(
    live
      .filter((c) => !c.readFailed)
      .map(async (c) => {
        try {
          const r = await readReputation(cfg.chain, BigInt(c.agentId), c.verifiedClients);
          c.feedbackCount = r.feedbackCount;
          c.feedbackClients = r.feedbackClients;
          c.score = r.score;
        } catch (e) {
          c.readFailed = true;
          c.issuesTr.push(`İtibar okunamadı: ${errText(e)}`);
        }
      }),
  );
  return candidates;
}
