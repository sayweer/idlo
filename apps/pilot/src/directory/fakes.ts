/**
 * Test sahtesi: bellek içi ERC-8004 + FlightPlan dünyası. Gerçek kontratın Reputation anlamını taklit eder
 * (getSummary yalnız verilen istemcilerin geri bildirimini sayar; istemci listesi boşsa revert eder).
 * FakeChain/FakeKule gibi üretim koduna bağlanmaz; yalnız testler ve yerel demo kullanır.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { getAddress, type Address, type Hex } from "viem";
import { AGENT_CARD_TYPE_V1, FUJI_AGENT_REGISTRY_ID, type AgentCard } from "@pilot/shared";
import type { PlanLlmClient } from "../plan/sentence.js";
import type { AuthorizedLog, DirectoryChain, ExecutedLog, ReputationSummary } from "./chain.js";

/** Belirgin sahte adres: 0x…<n>. */
export function fakeAddr(n: number): Address {
  return getAddress(`0x${n.toString(16).padStart(40, "0")}`);
}

export function fakeCard(agentId: number | string, over: Partial<AgentCard> = {}): AgentCard {
  return {
    type: AGENT_CARD_TYPE_V1,
    name: `Ajan ${agentId}`,
    description: "TL'yi USDT'ye çeviren sahte ajan.",
    services: [{ name: "MCP", endpoint: "https://ajan.example.com/mcp" }],
    active: true,
    registrations: [{ agentId: Number(agentId), agentRegistry: FUJI_AGENT_REGISTRY_ID }],
    supportedTrust: ["reputation"],
    ...over,
  };
}

interface Identity {
  owner: Address;
  uri: string;
  wallet: Hex | null;
}
export interface FakeFeedback {
  agentId: bigint;
  client: Address;
  /** value × 100 (decimals = 2): 95 puan → 9500. */
  value: bigint;
}

export class FakeDirectoryChain implements DirectoryChain {
  readonly identities = new Map<bigint, Identity>();
  readonly feedback: FakeFeedback[] = [];
  readonly authorizedLogs: (AuthorizedLog & { sender: Address })[] = [];
  readonly executedLogs: (ExecutedLog & { sender: Address })[] = [];
  readonly summaryCalls: { agentId: bigint; clients: Address[] }[] = [];
  /** Okuma hatası enjekte et: yöntem adı → hata. */
  readonly failing = new Map<string, Error>();
  /** txSender çağrı sayacı ve belirli işlem karmaları için hata enjeksiyonu (spam/bütçe testleri). */
  readonly senderCalls: Hex[] = [];
  readonly failingTx = new Set<Hex>();
  private nextTx = 1;

  private maybeFail(name: string): void {
    const e = this.failing.get(name);
    if (e !== undefined) throw e;
  }

  addAgent(id: number, i: { owner: Address; uri: string; wallet: Address | Hex | null }): void {
    const wallet = i.wallet === null ? null : (i.wallet.toLowerCase() as Hex);
    this.identities.set(BigInt(id), { owner: i.owner, uri: i.uri, wallet });
  }

  /** Bir alım: BuyAuthorized (agentSender gönderir) + BuyExecuted (kuleSender raporlar). */
  addTrade(t: {
    actionId: number;
    user: Address;
    agentId: number;
    agentSender: Address;
    kuleSender: Address;
    filledTL?: bigint;
    executedUser?: Address;
    skipExecuted?: boolean;
  }): void {
    const aTx = `0x${(this.nextTx++).toString(16).padStart(64, "0")}` as Hex;
    this.authorizedLogs.push({ actionId: BigInt(t.actionId), user: t.user, agentId: BigInt(t.agentId), txHash: aTx, sender: t.agentSender });
    if (t.skipExecuted === true) return;
    const eTx = `0x${(this.nextTx++).toString(16).padStart(64, "0")}` as Hex;
    this.executedLogs.push({
      actionId: BigInt(t.actionId),
      user: t.executedUser ?? t.user,
      filledTL: t.filledTL ?? 10_000_000n,
      txHash: eTx,
      sender: t.kuleSender,
    });
  }

  addFeedback(agentId: number, client: Address, score: number): void {
    this.feedback.push({ agentId: BigInt(agentId), client, value: BigInt(Math.round(score * 100)) });
  }

  async ownerOf(id: bigint): Promise<Address | null> {
    this.maybeFail("ownerOf");
    return this.identities.get(id)?.owner ?? null;
  }
  async tokenURI(id: bigint): Promise<string | null> {
    this.maybeFail("tokenURI");
    return this.identities.get(id)?.uri ?? null;
  }
  async agentWalletBytes(id: bigint): Promise<Hex | null> {
    this.maybeFail("agentWalletBytes");
    return this.identities.get(id)?.wallet ?? null;
  }
  async reputationSummary(agentId: bigint, clients: readonly Address[]): Promise<ReputationSummary> {
    this.maybeFail("reputationSummary");
    this.summaryCalls.push({ agentId, clients: [...clients] });
    if (clients.length === 0) throw new Error("clientAddresses required");
    const set = new Set(clients.map((c) => c.toLowerCase()));
    const rows = this.feedback.filter((f) => f.agentId === agentId && set.has(f.client.toLowerCase()));
    if (rows.length === 0) return { count: 0n, value: 0n, decimals: 2 };
    const sum = rows.reduce((s, r) => s + r.value, 0n);
    return { count: BigInt(rows.length), value: sum / BigInt(rows.length), decimals: 2 };
  }
  async buyAuthorized(agentIds: readonly bigint[], fromBlock: bigint): Promise<AuthorizedLog[]> {
    this.maybeFail("buyAuthorized");
    void fromBlock;
    const set = new Set(agentIds);
    return this.authorizedLogs.filter((l) => set.has(l.agentId));
  }
  async buyExecuted(actionIds: readonly bigint[], fromBlock: bigint): Promise<ExecutedLog[]> {
    this.maybeFail("buyExecuted");
    void fromBlock;
    const set = new Set(actionIds);
    return this.executedLogs.filter((l) => set.has(l.actionId));
  }
  async txSender(hash: Hex): Promise<Address> {
    this.maybeFail("txSender");
    this.senderCalls.push(hash);
    if (this.failingTx.has(hash)) throw new Error("rpc zaman aşımı (işlem)");
    const l = [...this.authorizedLogs, ...this.executedLogs].find((x) => x.txHash === hash);
    if (l === undefined) throw new Error("işlem bulunamadı");
    return l.sender;
  }
}

/** Sahte fetch: uri → kart (nesne ya da ham metin) ya da hata/durum. */
export function fakeFetch(routes: Record<string, unknown>): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (!(url in routes)) return new Response("yok", { status: 404 });
    const r = routes[url];
    if (r instanceof Error) throw r;
    return new Response(typeof r === "string" ? r : JSON.stringify(r), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch & { calls: string[] };
  f.calls = calls;
  return f;
}

// ───────────────────────────── Hazır dünya ─────────────────────────────

export const FAKE_KULE_REPORTER = fakeAddr(0x70);
export const FAKE_DEPLOYMENTS = {
  chainId: 43113 as const,
  kuleReporter: FAKE_KULE_REPORTER,
  deployBlock: 100,
  erc8004: {
    identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
    validation: "0x8004Cb1BF31DAf7788923b405b754f57acEB4272",
  },
} as const;

export interface WorldAgent {
  id: number;
  wallet: Address;
  owner: Address;
  uri: string;
  demo: boolean;
  /** Doğrulanmış (gerçekten işlem yapmış) kullanıcıların verdiği puanlar. */
  scores: number[];
  card?: AgentCard | string;
}

/**
 * Demo dünyası: 1 = PİLOT (iyi), 2 = DEMO iyi, 3 = DEMO düşük puan. Her puan ayrı bir kullanıcıdan gelir ve o
 * kullanıcı ajanla gerçekten işlem yapmıştır (BuyAuthorized ajan cüzdanından, BuyExecuted KULE'den).
 */
export function buildDemoWorld(): { chain: FakeDirectoryChain; fetch: ReturnType<typeof fakeFetch>; agents: WorldAgent[] } {
  const chain = new FakeDirectoryChain();
  const agents: WorldAgent[] = [
    { id: 1, wallet: fakeAddr(0xa1), owner: fakeAddr(0xb1), uri: "https://pilot.example.com/agent.json", demo: false, scores: [90, 95, 92] },
    { id: 2, wallet: fakeAddr(0xa2), owner: fakeAddr(0xb2), uri: "https://demo2.example.com/agent.json", demo: true, scores: [80, 85, 75] },
    { id: 3, wallet: fakeAddr(0xa3), owner: fakeAddr(0xb3), uri: "https://demo3.example.com/agent.json", demo: true, scores: [40, 50, 45] },
  ];
  const routes: Record<string, unknown> = {};
  let action = 1;
  let user = 0xc00;
  for (const a of agents) {
    chain.addAgent(a.id, { owner: a.owner, uri: a.uri, wallet: a.wallet });
    routes[a.uri] = a.card ?? fakeCard(a.id, { name: a.id === 1 ? "PİLOT" : `DEMO Ajan ${a.id}` });
    for (const s of a.scores) {
      const u = fakeAddr(user++);
      chain.addTrade({ actionId: action++, user: u, agentId: a.id, agentSender: a.wallet, kuleSender: FAKE_KULE_REPORTER });
      chain.addFeedback(a.id, u, s);
    }
  }
  return { chain, fetch: fakeFetch(routes), agents };
}

// ───────────────────────────── Sahte LLM ─────────────────────────────

export type FakeLlmReply = string | object | Error | { text: string; stop: Anthropic.StopReason };

/** Sıradaki cevabı verir, istekleri kaydeder. Cevap nesneyse JSON'a çevrilir. */
export function fakeLlm(replies: FakeLlmReply[]): PlanLlmClient & { calls: Anthropic.MessageCreateParamsNonStreaming[] } {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  return {
    calls,
    messages: {
      async create(body) {
        calls.push(body);
        const r = replies[calls.length - 1];
        if (r === undefined) throw new Error("beklenmeyen ek LLM çağrısı");
        if (r instanceof Error) throw r;
        const isStop = typeof r === "object" && "stop" in r && "text" in r;
        const text = isStop ? (r as { text: string }).text : typeof r === "string" ? r : JSON.stringify(r);
        const stop = isStop ? (r as { stop: Anthropic.StopReason }).stop : "end_turn";
        return {
          id: "msg_fake",
          type: "message",
          role: "assistant",
          model: body.model,
          content: [{ type: "text", text, citations: null }],
          stop_reason: stop,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        } as unknown as Anthropic.Message;
      },
    },
  };
}
