/**
 * R-1…R-10 — Ajan seçme dizini (HANDOFF §5 KARAR): kart okuma, aday okuma, doğrulanmış kullanıcılar, itibar, eşik,
 * ihtiyaç yapılandırma, sıralama, seçim → plan taslağı, uçtan uca, viem zincir uyarlayıcısı. Ağ yok: sahte zincir,
 * sahte fetch, sahte LLM, sahte JSON-RPC.
 */
import { describe, expect, it } from "vitest";
import {
  custom,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  type Address,
  type Hex,
} from "viem";
import { avalancheFuji } from "viem/chains";
import { createPublicClient } from "viem";
import {
  CandidateSchema,
  DEFAULT_THRESHOLDS,
  MIN_FEEDBACK,
  MIN_SCORE,
  SelectionResultSchema,
  agentRegistryId,
  cardClaimsAgent,
  sentenceCount,
  type Candidate,
  type PlanDraft,
} from "@pilot/shared";
import {
  BUY_AUTHORIZED_EVENT,
  BUY_EXECUTED_EVENT,
  CARD_MAX_BYTES,
  DirectoryError,
  FAKE_DEPLOYMENTS,
  FAKE_KULE_REPORTER,
  FakeDirectoryChain,
  IDENTITY_READ_ABI,
  REPUTATION_READ_ABI,
  buildDemoWorld,
  buildRankUser,
  checkCardUri,
  confirmationForAgent,
  fakeAddr,
  fakeCard,
  fakeFetch,
  fakeLlm,
  fetchAgentCard,
  findVerifiedClients,
  loadCandidates,
  parseAgentWallet,
  pickCandidate,
  planForAgent,
  rankSurvivors,
  readReputation,
  ruleOrder,
  ruleRanking,
  screen,
  selectAgents,
  structureNeed,
  viemDirectoryChain,
  type DirectoryConfig,
} from "../src/directory/index.js";

const MODEL = "test-model";
const PILOT_URI = "https://pilot.example.com/agent.json";

const regCfg = (chain: FakeDirectoryChain, f: typeof fetch) => ({ chain, deployments: FAKE_DEPLOYMENTS, local: false, fetch: f });

const REFS = [{ agentId: "1" }, { agentId: "2", demo: true }, { agentId: "3", demo: true }];

function config(over: Partial<DirectoryConfig> = {}): { cfg: DirectoryConfig; world: ReturnType<typeof buildDemoWorld> } {
  const world = buildDemoWorld();
  return {
    world,
    cfg: { chain: world.chain, deployments: FAKE_DEPLOYMENTS, candidates: REFS, fetch: world.fetch, llm: null, model: MODEL, ...over },
  };
}

// ───────────────────────────── R-1 kart okuma ─────────────────────────────

describe("R-1 agent.json okuma", () => {
  it("R-1a geçerli kartı https adresinden okur", async () => {
    const f = fakeFetch({ [PILOT_URI]: fakeCard(1) });
    const r = await fetchAgentCard(PILOT_URI, { local: false, fetch: f });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.card.name).toBe("Ajan 1");
  });

  it("R-1b yalnız yerel kipte http://127.0.0.1 kabul edilir", async () => {
    const u = "http://127.0.0.1:3000/agent.json";
    const f = fakeFetch({ [u]: fakeCard(1) });
    expect((await fetchAgentCard(u, { local: true, fetch: f })).ok).toBe(true);
    expect((await fetchAgentCard(u, { local: false, fetch: f })).ok).toBe(false);
  });

  it("R-1c HTTP hatası, JSON olmayan gövde ve şemaya uymayan kart Türkçe nedenle reddedilir", async () => {
    const f = fakeFetch({ "https://a.example.com/agent.json": "<html>", "https://b.example.com/agent.json": { name: "x" } });
    const miss = await fetchAgentCard("https://c.example.com/agent.json", { local: false, fetch: f });
    const html = await fetchAgentCard("https://a.example.com/agent.json", { local: false, fetch: f });
    const bad = await fetchAgentCard("https://b.example.com/agent.json", { local: false, fetch: f });
    for (const r of [miss, html, bad]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reasonTr).toMatch(/Ajan kartı/);
    }
  });

  it("R-1d büyük gövde (beyan edilen ve akan) reddedilir", async () => {
    const big = JSON.stringify({ ...fakeCard(1), description: "x".repeat(CARD_MAX_BYTES) });
    const f = fakeFetch({ [PILOT_URI]: big });
    const r = await fetchAgentCard(PILOT_URI, { local: false, fetch: f });
    expect(r.ok).toBe(false);
    // content-length yok, akış sınırı
    const streaming = (async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(big)); c.close(); } }))) as unknown as typeof fetch;
    expect((await fetchAgentCard(PILOT_URI, { local: false, fetch: streaming })).ok).toBe(false);
  });

  it("R-1e zaman aşımı ve ağ hatası kart geçersiz sayılır (fırlatmaz)", async () => {
    const f = fakeFetch({ [PILOT_URI]: new Error("ECONNRESET") });
    const r = await fetchAgentCard(PILOT_URI, { local: false, fetch: f });
    expect(r.ok).toBe(false);
  });

  it("R-1f checkCardUri: https zorunlu, kullanıcı bilgisi ve özel port yok", () => {
    expect(typeof checkCardUri("ftp://x.example.com/a", false)).toBe("string");
    expect(typeof checkCardUri("http://x.example.com/a", false)).toBe("string");
    expect(typeof checkCardUri("https://u:p@x.example.com/a", false)).toBe("string");
    expect(typeof checkCardUri("https://x.example.com:8443/a", false)).toBe("string");
    expect(typeof checkCardUri("not a url", false)).toBe("string");
    expect(checkCardUri("https://x.example.com/agent.json", false)).toBeInstanceOf(URL);
  });

  it("R-1g cardClaimsAgent: kart yalnız kendi agentId'sini ve doğru kaydı gösterirse kabul", () => {
    const reg = agentRegistryId(43113, FAKE_DEPLOYMENTS.erc8004.identity);
    expect(cardClaimsAgent(fakeCard(7), "7", reg)).toBe(true);
    expect(cardClaimsAgent(fakeCard(7), "8", reg)).toBe(false);
    expect(cardClaimsAgent(fakeCard(7), "7", agentRegistryId(1, FAKE_DEPLOYMENTS.erc8004.identity))).toBe(false);
  });
});

// ───────────────────────────── R-2 aday okuma ─────────────────────────────

describe("R-2 aday okuma", () => {
  it("R-2a demo dünyası: kimlik, cüzdan, kart, doğrulanmış müşteri ve puan okunur; DEMO etiketi listeden gelir", async () => {
    const w = buildDemoWorld();
    const list = await loadCandidates(REFS, regCfg(w.chain, w.fetch));
    expect(list.map((c) => c.agentId)).toEqual(["1", "2", "3"]);
    const [pilot, d2, d3] = list as [Candidate, Candidate, Candidate];
    expect(pilot.demo).toBe(false);
    expect(d2.demo && d3.demo).toBe(true);
    expect(pilot.agentWallet).toBe(w.agents[0]!.wallet);
    expect(pilot.card?.name).toBe("PİLOT");
    expect(pilot.verifiedClients).toHaveLength(3);
    expect(pilot.feedbackCount).toBe(3);
    expect(pilot.score).toBeCloseTo(92.33, 1);
    for (const c of list) expect(CandidateSchema.safeParse(c).success).toBe(true);
  });

  it("R-2b parseAgentWallet: yalnız tam 20 bayt ve sıfır olmayan adres", () => {
    const a = fakeAddr(0xa1);
    expect(parseAgentWallet(a.toLowerCase() as Hex)).toBe(a);
    expect(parseAgentWallet(null)).toBeNull();
    expect(parseAgentWallet("0x")).toBeNull();
    expect(parseAgentWallet(`0x${"00".repeat(20)}` as Hex)).toBeNull();
    expect(parseAgentWallet(`0x${"00".repeat(12)}${a.slice(2).toLowerCase()}` as Hex)).toBeNull(); // 32 bayt dolgulu
    expect(parseAgentWallet(`${a.toLowerCase()}00` as Hex)).toBeNull();
  });

  it("R-2c kimliği olmayan agentId hasIdentity=false; tokenURI/cüzdan okunmaz", async () => {
    const w = buildDemoWorld();
    const [c] = await loadCandidates([{ agentId: "99" }], regCfg(w.chain, w.fetch));
    expect(c!.hasIdentity).toBe(false);
    expect(c!.readFailed).toBe(false);
    expect(w.fetch.calls).toHaveLength(0);
  });

  it("R-2d agentWallet'ı olmayan kimlik: cüzdan null ve doğrulanmış müşteri yok", async () => {
    const w = buildDemoWorld();
    w.chain.addAgent(5, { owner: fakeAddr(0xb5), uri: PILOT_URI, wallet: null });
    const [c] = await loadCandidates([{ agentId: "5" }], regCfg(w.chain, w.fetch));
    expect(c!.hasIdentity).toBe(true);
    expect(c!.agentWallet).toBeNull();
    expect(c!.verifiedClients).toEqual([]);
  });

  it("R-2e kart başka ajanın kaydını gösteriyorsa ya da pasifse kart geçersiz", async () => {
    const w = buildDemoWorld();
    w.chain.addAgent(6, { owner: fakeAddr(0xb6), uri: "https://six.example.com/agent.json", wallet: fakeAddr(0xa6) });
    w.chain.addAgent(7, { owner: fakeAddr(0xb7), uri: "https://seven.example.com/agent.json", wallet: fakeAddr(0xa7) });
    const f = fakeFetch({
      "https://six.example.com/agent.json": fakeCard(1), // başka ajanın kartı
      "https://seven.example.com/agent.json": fakeCard(7, { active: false }),
    });
    const list = await loadCandidates([{ agentId: "6" }, { agentId: "7" }], regCfg(w.chain, f));
    expect(list[0]!.card).toBeNull();
    expect(list[0]!.cardIssueTr).toMatch(/kaydını göstermiyor/);
    expect(list[1]!.card).toBeNull();
    expect(list[1]!.cardIssueTr).toMatch(/pasif/);
  });

  it("R-2f zincir okuma hatası yutulmaz: readFailed ve neden issuesTr'de", async () => {
    const w = buildDemoWorld();
    w.chain.failing.set("ownerOf", new Error("rpc 503"));
    const list = await loadCandidates(REFS, regCfg(w.chain, w.fetch));
    for (const c of list) {
      expect(c.readFailed).toBe(true);
      expect(c.issuesTr.join(" ")).toMatch(/rpc 503/);
    }
  });

  it("R-2g olay taraması başarısız olursa tüm adaylar readFailed", async () => {
    const w = buildDemoWorld();
    w.chain.failing.set("buyAuthorized", new Error("getLogs limit"));
    const list = await loadCandidates(REFS, regCfg(w.chain, w.fetch));
    expect(list.every((c) => c.readFailed)).toBe(true);
    expect(list[0]!.issuesTr.join(" ")).toMatch(/getLogs limit/);
  });

  it("R-2h tekrarlı agentId tek aday olur; geçersiz agentId ve fazla aday fırlatır", async () => {
    const w = buildDemoWorld();
    expect(await loadCandidates([{ agentId: "1" }, { agentId: "1" }], regCfg(w.chain, w.fetch))).toHaveLength(1);
    await expect(loadCandidates([{ agentId: "-1" }], regCfg(w.chain, w.fetch))).rejects.toThrow();
    await expect(loadCandidates([{ agentId: "01" }], regCfg(w.chain, w.fetch))).rejects.toThrow();
    const many = Array.from({ length: 51 }, (_, i) => ({ agentId: String(i + 1) }));
    await expect(loadCandidates(many, regCfg(w.chain, w.fetch))).rejects.toThrow(/en fazla/);
  });
});

// ───────────────────────────── R-3 doğrulanmış kullanıcılar ─────────────────────────────

describe("R-3 doğrulanmış kullanıcılar", () => {
  const W = fakeAddr(0xa1);
  const O = fakeAddr(0xb1);
  const U1 = fakeAddr(0xc1);
  const U2 = fakeAddr(0xc2);
  const params = { kuleReporter: FAKE_KULE_REPORTER, deployBlock: 100n };

  it("R-3a gerçek alım (ajan cüzdanı izin ister, KULE raporlar, dolum > 0) kullanıcıyı doğrular", async () => {
    const c = new FakeDirectoryChain();
    c.addTrade({ actionId: 1, user: U1, agentId: 1, agentSender: W, kuleSender: FAKE_KULE_REPORTER });
    c.addTrade({ actionId: 2, user: U2, agentId: 1, agentSender: W, kuleSender: FAKE_KULE_REPORTER });
    const m = await findVerifiedClients(c, [{ agentId: 1n, wallet: W, owner: O }], params);
    expect(m.get("1")).toEqual([U1, U2]);
  });

  it("R-3b aynı kullanıcı birden çok alımda tek kez sayılır", async () => {
    const c = new FakeDirectoryChain();
    for (const a of [1, 2, 3]) c.addTrade({ actionId: a, user: U1, agentId: 1, agentSender: W, kuleSender: FAKE_KULE_REPORTER });
    const m = await findVerifiedClients(c, [{ agentId: 1n, wallet: W, owner: O }], params);
    expect(m.get("1")).toEqual([U1]);
  });

  it("R-3c izin var ama BuyExecuted yok: doğrulanmaz", async () => {
    const c = new FakeDirectoryChain();
    c.addTrade({ actionId: 1, user: U1, agentId: 1, agentSender: W, kuleSender: FAKE_KULE_REPORTER, skipExecuted: true });
    const m = await findVerifiedClients(c, [{ agentId: 1n, wallet: W, owner: O }], params);
    expect(m.get("1")).toEqual([]);
  });

  it("R-3d agentWallet'ı olmayan ajan için hiç tarama yapılmaz", async () => {
    const c = new FakeDirectoryChain();
    c.addTrade({ actionId: 1, user: U1, agentId: 1, agentSender: W, kuleSender: FAKE_KULE_REPORTER });
    const m = await findVerifiedClients(c, [{ agentId: 1n, wallet: null, owner: O }], params);
    expect(m.get("1")).toEqual([]);
  });

  it("R-3e sıfır ya da geçersiz kuleReporter fırlatır (fail-closed)", async () => {
    const c = new FakeDirectoryChain();
    await expect(
      findVerifiedClients(c, [{ agentId: 1n, wallet: W, owner: O }], { kuleReporter: "0x0000000000000000000000000000000000000000", deployBlock: 0n }),
    ).rejects.toThrow();
  });
});

// ───────────────────────────── R-4 itibar ─────────────────────────────

describe("R-4 itibar", () => {
  it("R-4a doğrulanmış kullanıcı yoksa getSummary ÇAĞRILMAZ ve sayı 0", async () => {
    const c = new FakeDirectoryChain();
    const r = await readReputation(c, 1n, []);
    expect(r).toEqual({ feedbackCount: 0, feedbackClients: 0, score: null });
    expect(c.summaryCalls).toHaveLength(0);
  });

  it("R-4b puan = value / 10^decimals (9500, 2 → 95) ve yalnız verilen istemciler sayılır", async () => {
    const c = new FakeDirectoryChain();
    const U = fakeAddr(0xc1);
    c.addFeedback(1, U, 95);
    c.addFeedback(1, U, 95);
    c.addFeedback(1, fakeAddr(0xee), 1); // verilmeyen istemci
    const r = await readReputation(c, 1n, [U]);
    expect(r).toEqual({ feedbackCount: 2, feedbackClients: 1, score: 95 });
    expect(c.summaryCalls[0]!.clients).toEqual([U]);
  });

  it("R-4c geri bildirim yoksa score null; decimals > 18 ya da çok büyük sayı fırlatır", async () => {
    const c = new FakeDirectoryChain();
    expect(await readReputation(c, 1n, [fakeAddr(1)])).toEqual({ feedbackCount: 0, feedbackClients: 0, score: null });
    const bad = { ...c, reputationSummary: async () => ({ count: 1n, value: 5n, decimals: 40 }) } as unknown as FakeDirectoryChain;
    await expect(readReputation(bad, 1n, [fakeAddr(1)])).rejects.toThrow(/ondalığı/);
    const huge = { ...c, reputationSummary: async () => ({ count: 2n ** 70n, value: 5n, decimals: 2 }) } as unknown as FakeDirectoryChain;
    await expect(readReputation(huge, 1n, [fakeAddr(1)])).rejects.toThrow(/aralık/);
  });
});

// ───────────────────────────── R-5 eşik ─────────────────────────────

describe("R-5 eşik (screen)", () => {
  const base = (): Candidate => ({
    agentId: "1",
    demo: false,
    readFailed: false,
    hasIdentity: true,
    owner: fakeAddr(0xb1),
    agentWallet: fakeAddr(0xa1),
    card: fakeCard(1),
    cardIssueTr: null,
    verifiedClients: [fakeAddr(1), fakeAddr(2), fakeAddr(3)],
    feedbackCount: 3,
    feedbackClients: 3,
    score: 90,
    issuesTr: [],
  });
  const codeOf = (c: Candidate) => screen([c]).eliminated[0]?.code ?? null;

  it("R-5a eşikleri geçen aday kalır", () => {
    const r = screen([base()]);
    expect(r.kept).toHaveLength(1);
    expect(r.eliminated).toHaveLength(0);
  });

  it("R-5b her eleme nedeni kendi koduyla ve Türkçe açıklamayla çıkar", () => {
    expect(codeOf({ ...base(), hasIdentity: false, owner: null })).toBe("NO_IDENTITY");
    expect(codeOf({ ...base(), agentWallet: null })).toBe("NO_AGENT_WALLET");
    expect(codeOf({ ...base(), card: null, cardIssueTr: "Ajan kartı alınamadı." })).toBe("INVALID_CARD");
    expect(codeOf({ ...base(), feedbackCount: MIN_FEEDBACK - 1 })).toBe("TOO_FEW_FEEDBACK");
    expect(codeOf({ ...base(), verifiedClients: [], feedbackCount: 0, feedbackClients: 0, score: null })).toBe("TOO_FEW_FEEDBACK");
    expect(codeOf({ ...base(), score: MIN_SCORE - 0.01 })).toBe("LOW_SCORE");
    expect(codeOf({ ...base(), score: null })).toBe("LOW_SCORE");
    expect(codeOf({ ...base(), readFailed: true })).toBe("CHAIN_UNREADABLE");
    const e = screen([{ ...base(), score: 10 }]).eliminated[0]!;
    expect(e.reasonTr).toMatch(/Puan eşiğin altında: 10/);
  });

  it("R-5c eşik sınırları dahildir (tam eşik geçer)", () => {
    expect(screen([{ ...base(), score: MIN_SCORE, feedbackCount: MIN_FEEDBACK }]).kept).toHaveLength(1);
  });

  it("R-5d DEMO etiketi hem kalanda hem elenende korunur", () => {
    const r = screen([{ ...base(), demo: true }, { ...base(), agentId: "2", demo: true, score: 1 }]);
    expect(r.kept[0]!.demo).toBe(true);
    expect(r.eliminated[0]!.demo).toBe(true);
  });

  it("R-5e eşikler dışarıdan gevşetilebilir; sonlu olmayan eşik fırlatır", () => {
    expect(screen([{ ...base(), score: 50 }], { minScore: 40 }).kept).toHaveLength(1);
    expect(DEFAULT_THRESHOLDS.minScore).toBe(MIN_SCORE);
    expect(() => screen([base()], { minScore: Number.NaN })).toThrow();
  });

  it("R-5f kart adı elenenin adı olarak taşınır, kartsızda null", () => {
    const r = screen([{ ...base(), score: 1 }, { ...base(), agentId: "2", card: null, cardIssueTr: "x" }]);
    expect(r.eliminated[0]!.nameTr).toBe("Ajan 1");
    expect(r.eliminated[1]!.nameTr).toBeNull();
  });
});

// ───────────────────────────── R-6 ihtiyaç yapılandırma ─────────────────────────────

describe("R-6 ihtiyaç yapılandırma", () => {
  const TEXT = "Her ay 20 bin TL'yi dolara çevirecek güvenilir bir ajan arıyorum.";
  const good = { summaryTr: "Aylık 20 bin TL'yi dolara çevirecek güvenilir ajan.", keywords: ["dolar", "aylık"], amountTL: 20000, questions: [] };

  it("R-6a LLM çıktısı zod'dan geçer ve source:'llm' olur; istem etiketli ve veri olarak gider", async () => {
    const llm = fakeLlm([good]);
    const need = await structureNeed(TEXT, { client: llm, model: MODEL });
    expect(need).toEqual({ ...good, source: "llm" });
    expect(llm.calls[0]!.model).toBe(MODEL);
    expect(JSON.stringify(llm.calls[0]!.messages)).toContain("<mesaj>");
    expect(llm.calls[0]!.output_config?.format?.type).toBe("json_schema");
  });

  it("R-6b amountTL metinde yoksa null'a döner ve soru eklenir", async () => {
    const need = await structureNeed("Dolar almak istiyorum.", { client: fakeLlm([{ ...good, summaryTr: "Dolar alımı.", keywords: [], amountTL: 5000 }]), model: MODEL });
    expect(need.amountTL).toBeNull();
    expect(need.questions[0]).toMatch(/kaç TL/);
  });

  it("R-6c özet/anahtar/soru metninde kullanıcının yazmadığı sayı varsa çıktı geçersiz: yeniden dener, sonra ham metin", async () => {
    const invented = { ...good, summaryTr: "Aylık 50 bin TL çevirecek ajan." };
    const llm = fakeLlm([invented, invented]);
    const need = await structureNeed(TEXT, { client: llm, model: MODEL });
    expect(llm.calls).toHaveLength(2);
    expect(need.source).toBe("fallback");
    expect(need.summaryTr).toBe(TEXT);
  });

  it("R-6d ilk çıktı bozuksa ikinci deneme geçerliyse onu kullanır", async () => {
    const need = await structureNeed(TEXT, { client: fakeLlm(["json değil", good]), model: MODEL });
    expect(need.source).toBe("llm");
  });

  it("R-6e LLM erişilemezse ya da client null ise ham metinle devam eder", async () => {
    expect((await structureNeed(TEXT, { client: fakeLlm([new Error("ağ")]), model: MODEL })).source).toBe("fallback");
    expect((await structureNeed(TEXT, { client: null, model: MODEL })).source).toBe("fallback");
  });

  it("R-6f boş ya da çok uzun metin invalid_input", async () => {
    await expect(structureNeed("   ", { client: null, model: MODEL })).rejects.toBeInstanceOf(DirectoryError);
    await expect(structureNeed("a".repeat(1001), { client: null, model: MODEL })).rejects.toMatchObject({ kind: "invalid_input" });
  });

  it("R-6g uzun ham metin özet sınırına kırpılır", async () => {
    const need = await structureNeed("kelime ".repeat(100), { client: null, model: MODEL });
    expect(need.summaryTr.length).toBeLessThanOrEqual(300);
  });
});

// ───────────────────────────── R-7 sıralama ─────────────────────────────

describe("R-7 sıralama", () => {
  const need = { summaryTr: "Dolar çevirecek ajan", keywords: [], amountTL: null, questions: [], source: "llm" as const };
  async function kept(): Promise<Candidate[]> {
    const w = buildDemoWorld();
    const list = await loadCandidates(REFS, regCfg(w.chain, w.fetch));
    return screen(list).kept; // 1 ve 2 kalır, 3 elenir
  }

  it("R-7a kural sırası puana göre azalan, kararlı", async () => {
    const k = await kept();
    expect(ruleOrder(k).map((c) => c.agentId)).toEqual(["1", "2"]);
    const r = ruleRanking(k);
    expect(r.source).toBe("rule");
    expect(r.items[0]!.rationaleTr).toBe("3 farklı doğrulanmış müşteriden 3 geri bildirimle 92,33 puan.");
    expect(r.items[1]!.rationaleTr).toMatch(/^DEMO ajan\./);
  });

  it("R-7b LLM sırası ve gerekçesi kullanılır; kullanıcıya giden istemde yalnız kalanlar vardır", async () => {
    const k = await kept();
    const llm = fakeLlm([{ ranked: [{ agentId: "2", rationaleTr: "Amacına daha yakın görünüyor." }, { agentId: "1", rationaleTr: "Daha yüksek puanlı." }] }]);
    const r = await rankSurvivors(need, k, { client: llm, model: MODEL, chatText: "dolar" });
    expect(r.source).toBe("llm");
    expect(r.items.map((i) => [i.agentId, i.source])).toEqual([["2", "llm"], ["1", "llm"]]);
    const sent = JSON.stringify(llm.calls[0]!.messages);
    expect(sent).toContain('\\"agentId\\": \\"1\\"');
    expect(sent).not.toContain('\\"agentId\\": \\"3\\"'); // elenen LLM'e gitmez
  });

  it("R-7c LLM yoksa kural; kalan yoksa boş liste ve LLM çağrılmaz", async () => {
    const k = await kept();
    expect((await rankSurvivors(need, k, { client: null, model: MODEL, chatText: "x" })).source).toBe("rule");
    const llm = fakeLlm([]);
    const r = await rankSurvivors(need, [], { client: llm, model: MODEL, chatText: "x" });
    expect(r.items).toEqual([]);
    expect(llm.calls).toHaveLength(0);
  });

  it("R-7d LLM'in atladığı ajan kaybolmaz: kural sırasıyla sona eklenir", async () => {
    const k = await kept();
    const llm = fakeLlm([{ ranked: [{ agentId: "2", rationaleTr: "Uygun." }] }]);
    const r = await rankSurvivors(need, k, { client: llm, model: MODEL, chatText: "x" });
    expect(r.items.map((i) => [i.agentId, i.source])).toEqual([["2", "llm"], ["1", "rule"]]);
  });

  it("R-7e gerekçedeki uydurma sayı o ajanın gerekçesini kural gerekçesiyle değiştirir", async () => {
    const k = await kept();
    const llm = fakeLlm([{ ranked: [{ agentId: "1", rationaleTr: "Yüzde 99 başarı oranı var." }, { agentId: "2", rationaleTr: "80 puanla uygun." }] }]);
    const r = await rankSurvivors(need, k, { client: llm, model: MODEL, chatText: "x" });
    expect(r.items[0]).toMatchObject({ agentId: "1", source: "rule" });
    expect(r.items[1]).toMatchObject({ agentId: "2", source: "llm" }); // 80, LLM'e verilen puandır
  });

  it("R-7f 2 cümleyi aşan gerekçe şemada reddedilir → yeniden dener → kural", async () => {
    const k = await kept();
    const long = { ranked: [{ agentId: "1", rationaleTr: "Bir. İki. Üç." }] };
    const llm = fakeLlm([long, long]);
    const r = await rankSurvivors(need, k, { client: llm, model: MODEL, chatText: "x" });
    expect(llm.calls).toHaveLength(2);
    expect(r.source).toBe("rule");
  });

  it("R-7g sentenceCount: ondalık sayı cümleyi bölmez", () => {
    expect(sentenceCount("Puan 92.5 ve güvenilir. İyi.")).toBe(2);
    expect(sentenceCount("Tek cümle")).toBe(1);
    expect(sentenceCount("A! B? C.")).toBe(3);
  });

  it("R-7h buildRankUser: kullanıcı ihtiyacı ve ajanlar ayrı etiket bloklarında", async () => {
    const k = await kept();
    const u = buildRankUser(need, k);
    expect(u).toMatch(/<ihtiyac>[\s\S]*<\/ihtiyac>\s*<ajanlar>[\s\S]*<\/ajanlar>/);
  });
});

// ───────────────────────────── R-8 seçim → plan taslağı ─────────────────────────────

const draft15 = (): PlanDraft => ({
  cycleTL: { value: 20000, source: "user" },
  startDay: { value: 1, source: "user" },
  deadlineDay: { value: 5, source: "user" },
  maxOrderTL: { value: 10000, source: "user" },
  askOnAmbiguity: { value: true, source: "user" },
  maxWaitH: { value: 72, source: "default" },
  expiresInDays: { value: 90, source: "default" },
  questions: [],
});

describe("R-8 seçim → plan taslağı", () => {
  const NOW = 1_800_000_000;
  const ctx = { nowSec: NOW, current: null, currentActive: false };
  function directory() {
    const w = buildDemoWorld();
    return { w, dir: { chain: w.chain, deployments: FAKE_DEPLOYMENTS, candidates: REFS, fetch: w.fetch } };
  }

  it("R-8a plan.agent = seçilen ajanın agentWallet'ı, plan.agentId = agentId, plan.kule = kuleReporter; imzaya açılır", async () => {
    const { w, dir } = directory();
    const c = await confirmationForAgent(draft15(), "2", dir, ctx);
    expect(c.signable).toBe(true);
    const plan = c.setPlanArgs![0];
    expect(plan.agent).toBe(w.agents[1]!.wallet);
    expect(plan.agentId).toBe(2n);
    expect(plan.kule).toBe(FAKE_KULE_REPORTER);
    expect(c.rows.find((r) => r.field === "agent")!.chainValue).toBe(w.agents[1]!.wallet);
  });

  it("R-8b elenen ajan seçilemez (agent_not_eligible), listede olmayan unknown_agent", async () => {
    const { w, dir } = directory();
    const s = screen(await loadCandidates(REFS, regCfg(w.chain, w.fetch)));
    expect(() => pickCandidate(s, "3")).toThrowError(expect.objectContaining({ kind: "agent_not_eligible" }));
    expect(() => pickCandidate(s, "77")).toThrowError(expect.objectContaining({ kind: "unknown_agent" }));
    await expect(confirmationForAgent(draft15(), "3", dir, ctx)).rejects.toMatchObject({ kind: "agent_not_eligible" });
    await expect(confirmationForAgent(draft15(), "77", dir, ctx)).rejects.toMatchObject({ kind: "unknown_agent" });
  });

  it("R-8c mevcut plan başka ajanla ise pencere 24 saat bekletir uyarısı verir (agent/agentId her zaman bekletir)", async () => {
    const { w, dir } = directory();
    const first = (await confirmationForAgent(draft15(), "1", dir, ctx)).setPlanArgs![0];
    const current = {
      cycleTL: 20000, maxOrderTL: 10000, startDay: 1, deadlineDay: 5, maxWaitH: 72, bandBps: 0, closedBandBps: 500, askMode: 1 as const,
      expiresAt: NOW + 90 * 86400, agent: first.agent, kule: first.kule, agentId: first.agentId.toString(),
    };
    const c = await confirmationForAgent(draft15(), "2", dir, { nowSec: NOW, current, currentActive: true });
    expect(c.activation!.immediate).toBe(false);
    expect(c.activation!.loosened).toEqual(expect.arrayContaining(["agent", "agentId"]));
    expect(c.setPlanArgs![0].agent).toBe(w.agents[1]!.wallet);
  });

  it("R-8d planForAgent: hazır taslakla LLM çağrılmaz; cümleyle planFromSentence çalışır", async () => {
    const { dir } = directory();
    const llm = fakeLlm([draft15()]);
    const viaDraft = await planForAgent({ draft: draft15(), agentId: "1", directory: dir, ctx, llm: { client: llm, model: MODEL } });
    expect(viaDraft.signable).toBe(true);
    expect(llm.calls).toHaveLength(0);
    const viaSentence = await planForAgent({
      sentence: "Maaşım ayın 1'inde yatıyor. 20 bininin en geç 5'ine kadar dolara çevrilmesini istiyorum. Tek seferde 10 binden fazla harcama. Emin olmadığın bir şey olursa bana sor.",
      agentId: "1", directory: dir, ctx, llm: { client: llm, model: MODEL },
    });
    expect(viaSentence.signable).toBe(true);
    expect(llm.calls).toHaveLength(1);
  });

  it("R-8e eşiği geçmeyen ajan için LLM harcanmaz; LLM yoksa ve taslak da yoksa plan_not_buildable", async () => {
    const { dir } = directory();
    const llm = fakeLlm([]);
    await expect(planForAgent({ sentence: "x", agentId: "3", directory: dir, ctx, llm: { client: llm, model: MODEL } })).rejects.toMatchObject({ kind: "agent_not_eligible" });
    expect(llm.calls).toHaveLength(0);
    await expect(planForAgent({ sentence: "x", agentId: "1", directory: dir, ctx, llm: null })).rejects.toMatchObject({ kind: "plan_not_buildable" });
    await expect(planForAgent({ agentId: "1", directory: dir, ctx, llm: null })).rejects.toMatchObject({ kind: "plan_not_buildable" });
  });

  it("R-8f imza yolu zinciri TAZE okur: seçimden sonra cüzdanı kaldırılan ajan imzaya açılmaz", async () => {
    const { w, dir } = directory();
    expect((await confirmationForAgent(draft15(), "1", dir, ctx)).signable).toBe(true);
    // seçimden sonra zincirde ajan 1'in cüzdanı kaldırıldı: eski anlık görüntü değil, güncel durum kazanır
    w.chain.addAgent(1, { owner: w.agents[0]!.owner, uri: w.agents[0]!.uri, wallet: null });
    await expect(confirmationForAgent(draft15(), "1", dir, ctx)).rejects.toMatchObject({ kind: "agent_not_eligible" });
  });
});

// ───────────────────────────── R-9 uçtan uca ─────────────────────────────

describe("R-9 selectAgents", () => {
  const TEXT = "Her ay 20 bin TL'yi dolara çevirecek güvenilir bir ajan arıyorum.";

  it("R-9a LLM yokken: 3 adaydan 2'si kalır, puana göre sıralı, düz JSON; notlar Türkçe ve DEMO uyarısı var", async () => {
    const { cfg } = config();
    const r = await selectAgents(TEXT, cfg);
    expect(r.screen.kept.map((c) => c.agentId)).toEqual(["1", "2"]);
    expect(r.screen.eliminated.map((e) => [e.agentId, e.code])).toEqual([["3", "LOW_SCORE"]]);
    expect(r.ranking.items.map((i) => i.agentId)).toEqual(["1", "2"]);
    expect(r.need.source).toBe("fallback");
    expect(r.notesTr.join(" ")).toMatch(/DEMO etiketli/);
    expect(SelectionResultSchema.safeParse(JSON.parse(JSON.stringify(r))).success).toBe(true);
  });

  it("R-9b LLM ile: ihtiyaç yapılandırılır ve LLM sırası kullanılır", async () => {
    const need = { summaryTr: "Aylık 20 bin TL dolara çevrilsin.", keywords: ["dolar"], amountTL: 20000, questions: [] };
    const rank = { ranked: [{ agentId: "2", rationaleTr: "Amacına uygun." }, { agentId: "1", rationaleTr: "Güvenilir." }] };
    const { cfg } = config({ llm: fakeLlm([need, rank]) });
    const r = await selectAgents(TEXT, cfg);
    expect(r.need.source).toBe("llm");
    expect(r.ranking.source).toBe("llm");
    expect(r.ranking.items.map((i) => i.agentId)).toEqual(["2", "1"]);
    expect(r.notesTr.join(" ")).not.toMatch(/puana göre/);
  });

  it("R-9c hiç aday eşiği geçemezse boş sıralama ve 'Eşiği geçen ajan yok' notu", async () => {
    const { cfg } = config({ thresholds: { minScore: 99 } });
    const r = await selectAgents(TEXT, cfg);
    expect(r.screen.kept).toEqual([]);
    expect(r.ranking.items).toEqual([]);
    expect(r.notesTr[1] ?? r.notesTr.join(" ")).toMatch(/Eşiği geçen ajan yok/);
  });

  it("R-9d boş ya da aşırı uzun mesaj DirectoryError(invalid_input)", async () => {
    const { cfg } = config();
    await expect(selectAgents("  ", cfg)).rejects.toMatchObject({ kind: "invalid_input" });
  });

  it("R-9e LLM modeli yapılandırmadan, yoksa LLM_MODEL/varsayılandan gelir", async () => {
    const llm = fakeLlm([new Error("x"), new Error("x")]);
    const { cfg } = config({ llm, model: undefined as unknown as string });
    delete (cfg as { model?: string }).model;
    await selectAgents(TEXT, cfg);
    expect(llm.calls[0]!.model).toBe(process.env.LLM_MODEL?.trim() || "claude-sonnet-5-5");
  });
});

// ───────────────────────────── R-10 viem uyarlayıcı ─────────────────────────────

describe("R-10 viemDirectoryChain", () => {
  const ID = FAKE_DEPLOYMENTS.erc8004.identity as Address;
  const REP = FAKE_DEPLOYMENTS.erc8004.reputation as Address;
  const FP = fakeAddr(0x99);
  const wallet = fakeAddr(0xa1);
  const user = fakeAddr(0xc1);
  const txAuth = `0x${"11".repeat(32)}` as Hex;
  const txExec = `0x${"22".repeat(32)}` as Hex;
  const sentBy: Record<string, Address> = { [txAuth]: wallet, [txExec]: FAKE_KULE_REPORTER };

  function transport(opts: { latest: bigint; revertOwner?: boolean }) {
    const logRanges: [bigint, bigint][] = [];
    const t = custom({
      async request({ method, params }: { method: string; params?: unknown }) {
        const p = params as unknown[];
        switch (method) {
          case "eth_blockNumber":
            return `0x${opts.latest.toString(16)}`;
          case "eth_call": {
            const { to, data } = p[0] as { to: Address; data: Hex };
            const sel = data.slice(0, 10);
            if (to.toLowerCase() === ID.toLowerCase()) {
              const fnOf = (n: string) => IDENTITY_READ_ABI.find((x) => x.name === n)!;
              const sels: Record<string, string> = {};
              for (const n of ["tokenURI", "ownerOf", "getMetadata"]) {
                const { toFunctionSelector } = await import("viem");
                sels[toFunctionSelector(fnOf(n))] = n;
              }
              const name = sels[sel];
              if (name === "ownerOf") {
                if (opts.revertOwner) throw Object.assign(new Error("execution reverted"), { code: 3, data: "0x" });
                return encodeFunctionResult({ abi: IDENTITY_READ_ABI, functionName: "ownerOf", result: fakeAddr(0xb1) });
              }
              if (name === "tokenURI") return encodeFunctionResult({ abi: IDENTITY_READ_ABI, functionName: "tokenURI", result: PILOT_URI });
              return encodeFunctionResult({ abi: IDENTITY_READ_ABI, functionName: "getMetadata", result: wallet.toLowerCase() as Hex });
            }
            if (to.toLowerCase() === REP.toLowerCase()) {
              return encodeFunctionResult({ abi: REPUTATION_READ_ABI, functionName: "getSummary", result: [2n, 9500n, 2] });
            }
            throw new Error("bilinmeyen çağrı");
          }
          case "eth_getLogs": {
            const f = p[0] as { fromBlock: Hex; toBlock: Hex; topics: (Hex | Hex[] | null)[] };
            logRanges.push([BigInt(f.fromBlock), BigInt(f.toBlock)]);
            const authTopic = encodeEventTopics({ abi: [BUY_AUTHORIZED_EVENT], eventName: "BuyAuthorized" })[0];
            const pad = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
            const addrTopic = (a: Address) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}` as Hex;
            const inRange = (b: bigint) => b >= BigInt(f.fromBlock) && b <= BigInt(f.toBlock);
            if (f.topics[0] === authTopic) {
              if (!inRange(150n)) return [];
              return [{
                address: FP, blockHash: `0x${"aa".repeat(32)}`, blockNumber: "0x96", data: encodeAbiParameters(
                  [{ type: "uint64" }, { type: "uint64" }, { type: "uint8" }, { type: "uint64" }, { type: "bytes32" }],
                  [1n, 2n, 0, 3n, `0x${"00".repeat(32)}`]),
                logIndex: "0x0", removed: false, topics: [authTopic, pad(7n), addrTopic(user), pad(1n)], transactionHash: txAuth, transactionIndex: "0x0",
              }];
            }
            if (!inRange(160n)) return [];
            const execTopic = encodeEventTopics({ abi: [BUY_EXECUTED_EVENT], eventName: "BuyExecuted" })[0];
            return [{
              address: FP, blockHash: `0x${"bb".repeat(32)}`, blockNumber: "0xa0", data: encodeAbiParameters(
                [{ type: "string" }, { type: "uint64" }, { type: "uint64" }, { type: "uint8" }, { type: "bytes32" }],
                ["ord-1", 5_000_000n, 1n, 0, `0x${"00".repeat(32)}`]),
              logIndex: "0x0", removed: false, topics: [execTopic, pad(7n), addrTopic(user)], transactionHash: txExec, transactionIndex: "0x0",
            }];
          }
          case "eth_getTransactionByHash": {
            const h = p[0] as string;
            return {
              hash: h, from: sentBy[h], to: FP, nonce: "0x0", blockHash: `0x${"aa".repeat(32)}`, blockNumber: "0x96", transactionIndex: "0x0",
              value: "0x0", gas: "0x5208", gasPrice: "0x1", input: "0x", type: "0x0", v: "0x1b", r: `0x${"01".repeat(32)}`, s: `0x${"01".repeat(32)}`, chainId: "0xa869",
            };
          }
        }
        throw new Error(`beklenmeyen yöntem ${method}`);
      },
    });
    return { t, logRanges };
  }

  function chainOf(o: Parameters<typeof transport>[0], extra: { logChunkBlocks?: number } = {}) {
    const { t, logRanges } = transport(o);
    const client = createPublicClient({ chain: avalancheFuji, transport: t });
    const dep = { flightPlan: FP, erc8004: FAKE_DEPLOYMENTS.erc8004 };
    return { chain: viemDirectoryChain(client, dep, extra), logRanges };
  }

  it("R-10a okumalar ve olaylar çözülür; tx.from ayrı sorgulanır", async () => {
    const { chain } = chainOf({ latest: 200n });
    expect(await chain.ownerOf(1n)).toBe(fakeAddr(0xb1));
    expect(await chain.tokenURI(1n)).toBe(PILOT_URI);
    expect(await chain.agentWalletBytes(1n)).toBe(wallet.toLowerCase());
    expect(await chain.reputationSummary(1n, [user])).toEqual({ count: 2n, value: 9500n, decimals: 2 });
    const auth = await chain.buyAuthorized([1n], 100n);
    expect(auth).toEqual([{ actionId: 7n, user, agentId: 1n, txHash: txAuth }]);
    const ex = await chain.buyExecuted([7n], 100n);
    expect(ex).toEqual([{ actionId: 7n, user, filledTL: 5_000_000n, txHash: txExec }]);
    expect(await chain.txSender(txAuth)).toBe(wallet);
  });

  it("R-10b olay taraması deployBlock'tan son bloğa küçük parçalarla yapılır ve hiçbir blok atlanmaz", async () => {
    const { chain, logRanges } = chainOf({ latest: 200n }, { logChunkBlocks: 40 });
    const auth = await chain.buyAuthorized([1n], 100n);
    expect(auth).toHaveLength(1);
    expect(logRanges[0]![0]).toBe(100n);
    expect(logRanges.at(-1)![1]).toBe(200n);
    for (let i = 1; i < logRanges.length; i++) expect(logRanges[i]![0]).toBe(logRanges[i - 1]![1] + 1n);
  });

  it("R-10c ownerOf revert'ü 'kayıt yok' (null); ağ hatası fırlatılır", async () => {
    const { chain } = chainOf({ latest: 200n, revertOwner: true });
    expect(await chain.ownerOf(9n)).toBeNull();
    const broken = viemDirectoryChain(
      { readContract: async () => { throw new Error("fetch failed"); }, getLogs: async () => [], getBlockNumber: async () => 1n, getTransaction: async () => { throw new Error("x"); } } as never,
      { flightPlan: FP, erc8004: FAKE_DEPLOYMENTS.erc8004 },
    );
    await expect(broken.ownerOf(1n)).rejects.toThrow(/fetch failed/);
  });

  it("R-10d uçtan uca: viem uyarlayıcı üzerinden doğrulanmış müşteri bulunur", async () => {
    const { chain } = chainOf({ latest: 200n });
    const m = await findVerifiedClients(chain, [{ agentId: 1n, wallet, owner: fakeAddr(0xb1) }], { kuleReporter: FAKE_KULE_REPORTER, deployBlock: 100n });
    expect(m.get("1")).toEqual([user]);
  });

  it("R-10e geçersiz parça boyutu fırlatır", () => {
    const client = createPublicClient({ chain: avalancheFuji, transport: transport({ latest: 1n }).t });
    expect(() => viemDirectoryChain(client, { flightPlan: FP, erc8004: FAKE_DEPLOYMENTS.erc8004 }, { logChunkBlocks: 0 })).toThrow();
  });
});
