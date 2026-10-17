/**
 * E-4 (§18): stolen-key.ts — PİLOT anahtarıyla 40.000 TL izin isteği → BuyRejected(3) zincirde; sahte actionId ile
 * KULE → RET. Ayrıca yabancı plan varyantı (contracts/test/AuthBinding.t.sol) KULE bağında düşer ve betik hiçbir
 * koşulda gerçek izin oluşturmaz (ön kontrol tutmazsa işlem gönderilmez). Zincir ve KULE taklit; ağ yok.
 */
import { describe, expect, it } from "vitest";
import { zeroAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { parseDeployments, RejectCode, STOLEN_KEY_MESSAGE, type ChainBuyAction, type ChainPlan } from "@pilot/shared";
import { connectKuleProbe, runStolenKey } from "../lib/stolen-io.js";
import {
  DEMO_ATTACKER,
  FAKE_ACTION_OFFSET,
  foreignPlanVerdicts,
  kuleBindingOf,
  runStolenKeyScene,
  SceneAbort,
  snowtraceTx,
  STOLEN_AMOUNT_TL,
  type RequestBuyCall,
  type SentResult,
  type StolenChain,
} from "../lib/stolen-scene.js";
import { deploymentsText, ELIF, fakeMcpFetch, KULE_REPORTER, PILOT_AGENT } from "./helpers.js";

const D = parseDeployments(deploymentsText());
const TX: Hex = `0x${"5a".repeat(32)}`;

const PLAN: ChainPlan = {
  cycleTL: 300n, maxOrderTL: 150n, startDay: 15, deadlineDay: 25, maxWaitH: 72, bandBps: 0, closedBandBps: 500, askMode: 1,
  expiresAt: 2_000_000_000n, agent: PILOT_AGENT, kule: KULE_REPORTER, agentId: 17n,
};
const EMPTY_PLAN: ChainPlan = { ...PLAN, cycleTL: 0n, maxOrderTL: 0n, startDay: 0, deadlineDay: 0, agent: zeroAddress, kule: zeroAddress, agentId: 0n };
const EMPTY_ACTION: ChainBuyAction = { user: zeroAddress, amountTL: 0n, maxPxE6: 0n, ordType: 0, openBy: 0n, reportBy: 0n, cycleId: 0, state: 0 };

/** Kontratın §8.3 davranışını taklit eden sahte zincir; gönderilen her işlem kaydedilir. */
class FakeStolenChain implements StolenChain {
  sent: RequestBuyCall[] = [];
  constructor(
    public o: {
      agent?: Address;
      chainId?: number;
      plan?: ChainPlan;
      active?: boolean;
      day?: number;
      simulate?: bigint;
      send?: (c: RequestBuyCall) => SentResult;
      action?: ChainBuyAction;
    } = {},
  ) {}
  get agent() {
    return this.o.agent ?? PILOT_AGENT;
  }
  async chainId() {
    return this.o.chainId ?? 43113;
  }
  async plan(user: Address) {
    return user.toLowerCase() === ELIF.toLowerCase() ? (this.o.plan ?? PLAN) : EMPTY_PLAN;
  }
  async isPlanActive() {
    return this.o.active ?? true;
  }
  async trDay() {
    return this.o.day ?? 17;
  }
  async lastActionId() {
    return 4n;
  }
  async action() {
    return this.o.action ?? EMPTY_ACTION;
  }
  async simulateRequestBuy(c: RequestBuyCall) {
    if (this.o.simulate !== undefined) return this.o.simulate;
    return c.amountTL > (this.o.plan ?? PLAN).maxOrderTL ? 0n : 5n;
  }
  async sendRequestBuy(c: RequestBuyCall): Promise<SentResult> {
    this.sent.push(c);
    if (this.o.send) return this.o.send(c);
    return { kind: "rejected", hash: TX, user: c.user, amountTL: c.amountTL, code: RejectCode.OVER_ORDER_LIMIT };
  }
}

async function scene(chain: FakeStolenChain, extra: Partial<Parameters<typeof runStolenKeyScene>[0]> = {}) {
  const lines: string[] = [];
  const r = await runStolenKeyScene({ chain, network: "fuji", deployments: D, user: ELIF, out: (l) => lines.push(l), ...extra });
  return { r, text: lines.join("\n"), lines };
}

describe("E-4 ajan anahtarı çalındı (§10.5, §16 #19)", () => {
  it("E-4 PİLOT anahtarıyla 40.000 TL → BuyRejected(3) zincirde, Snowtrace bağlantısı; sahte actionId ile KULE → RET NO_AUTHORIZATION", async () => {
    const chain = new FakeStolenChain();
    const { r, text } = await scene(chain);
    expect(r.ok).toBe(true);
    expect(chain.sent).toHaveLength(1);
    expect(chain.sent[0]).toMatchObject({ user: ELIF, amountTL: BigInt(STOLEN_AMOUNT_TL), ordType: 1 });
    expect(r.rejectCode).toBe(3);
    expect(text).toContain("Etiket: CANLI · Avalanche Fuji");
    expect(text).toContain("BuyRejected — kod 3 OVER_ORDER_LIMIT");
    expect(text).toContain(`Snowtrace: https://testnet.snowtrace.io/tx/${TX}`);
    expect(r.fakeActionId).toBe((4n + FAKE_ACTION_OFFSET).toString());
    expect(r.kuleVerdict).toEqual({ verdict: "RET", reasons: ["NO_AUTHORIZATION"], live: false });
    expect(text).toContain("ÇEVRİMDIŞI KULE kontrolü");
    expect(text).toContain(`Mesaj: ${STOLEN_KEY_MESSAGE}`);
    expect(snowtraceTx(TX)).toBe(`https://testnet.snowtrace.io/tx/${TX}`);
  });

  it("E-4 yerel Anvil: YEREL etiketi, Snowtrace bağlantısı yok", async () => {
    const { r, text } = await scene(new FakeStolenChain(), { network: "local" });
    expect(r.ok).toBe(true);
    expect(text).toContain("Etiket: YEREL · Anvil");
    expect(text).not.toContain("Snowtrace: https");
  });

  it("E-4 yabancı plan varyantı (AuthBinding.t.sol), çevrimdışı: kendi ajanı → WRONG_AGENT, gerçek PİLOT adresi → NO_AUTHORIZATION", async () => {
    expect(foreignPlanVerdicts(kuleBindingOf(D, ELIF), D)).toEqual({ ownAgent: "WRONG_AGENT", realAgent: "NO_AUTHORIZATION" });
    const { r, text } = await scene(new FakeStolenChain());
    expect(r.foreign).toEqual({ ownAgent: "WRONG_AGENT", realAgent: "NO_AUTHORIZATION" });
    expect(text).toContain("KULE: RET WRONG_AGENT — Bu izin başka bir ajana ait.");
    expect(text).toContain("KULE: RET NO_AUTHORIZATION — Zincirde geçerli bir izin yok. (izin Elif'in değil)");
    // Saldırgan adresi Elif değil; bağ Elif'in kendi iznini reddetmez (kontrol: aynı fonksiyon).
    expect(DEMO_ATTACKER.toLowerCase()).not.toBe(ELIF.toLowerCase());
  });

  it("E-4 canlı KULE (KULE_URL + PILOT_TOKEN): kule_execute sahte numarayla çağrılır, RET NO_AUTHORIZATION basılır", async () => {
    const calls: string[] = [];
    const kule = { execute: async (id: string) => (calls.push(id), { verdict: "RET", reasons: ["NO_AUTHORIZATION"] }) };
    const { r, text } = await scene(new FakeStolenChain(), { kule });
    expect(calls).toEqual([(4n + FAKE_ACTION_OFFSET).toString()]);
    expect(r.kuleVerdict).toEqual({ verdict: "RET", reasons: ["NO_AUTHORIZATION"], live: true });
    expect(text).toContain("KULE (canlı): RET NO_AUTHORIZATION");
    // Canlı KULE beklenmeyen yanıt verirse sahne başarısız sayılır.
    const bad = await scene(new FakeStolenChain(), { kule: { execute: async () => ({ verdict: "BEKLET", reasons: ["HEALTH:DATA_STALE"] }) } });
    expect(bad.r.ok).toBe(false);
    expect(bad.text).toContain("UYARI");
  });

  it.each<[string, ConstructorParameters<typeof FakeStolenChain>[0], RegExp]>([
    ["anahtar PİLOT'un değil", { agent: "0x5555555555555555555555555555555555555555" }, /pilotAgent değil/],
    ["yanlış zincir", { chainId: 1 }, /RPC zinciri 1/],
    ["Elif'in planı yok", { plan: EMPTY_PLAN }, /planı yok/],
    ["plan başka ajana bağlı", { plan: { ...PLAN, agent: "0x5555555555555555555555555555555555555555" } }, /bu ajana bağlı değil/],
    ["plan etkin değil (kod 1 çıkardı)", { active: false }, /etkin değil/],
    ["pencere dışı (kod 2 çıkardı)", { day: 3 }, /pencere/],
    ["tavan 40.000'e izin veriyor", { plan: { ...PLAN, cycleTL: 100_000n, maxOrderTL: 40_000n } }, /gerçek izin oluşturmaz/],
    ["eth_call izin numarası döndürüyor", { simulate: 9n }, /ret beklenmiyor/],
  ])("ön kontrol tutmazsa (%s) işlem GÖNDERİLMEZ", async (_n, o, msg) => {
    const chain = new FakeStolenChain(o);
    await expect(scene(chain)).rejects.toThrow(msg);
    await expect(scene(chain)).rejects.toBeInstanceOf(SceneAbort);
    expect(chain.sent).toHaveLength(0);
  });

  it("kontrat beklenmedik biçimde izin verirse ALARM basılır ve sahne başarısız", async () => {
    const chain = new FakeStolenChain({ send: () => ({ kind: "authorized", hash: TX, actionId: 5n }) });
    const { r, text } = await scene(chain);
    expect(r.ok).toBe(false);
    expect(text).toContain("ALARM: kontrat izin verdi");
    expect(text).not.toContain(STOLEN_KEY_MESSAGE);
  });

  it("başka ret kodu (ör. 4) → uyarı; sahne başarısız", async () => {
    const chain = new FakeStolenChain({ send: (c) => ({ kind: "rejected", hash: TX, user: c.user, amountTL: c.amountTL, code: 4 }) });
    const { r, text } = await scene(chain);
    expect(r.ok).toBe(false);
    expect(text).toContain("kod 4 OVER_CYCLE_TARGET");
  });

  it("sahte izin numarası zincirde varsa durur", async () => {
    const chain = new FakeStolenChain({ action: { ...EMPTY_ACTION, user: ELIF } });
    await expect(scene(chain)).rejects.toThrow(/zincirde var/);
  });
});

describe("E-4 stolen-key.ts ortam ve KULE bağlantısı", () => {
  const pk = generatePrivateKey();
  const env = (o: Record<string, string | undefined> = {}) => ({
    PILOT_AGENT_PRIVATE_KEY: pk,
    PLAN_USER_ADDRESS: ELIF,
    ...o,
  });
  const deployments = () => deploymentsText({ pilotAgent: privateKeyToAccount(pk).address });

  it.each<[string, string[], Record<string, string | undefined>]>([
    ["anahtar yok", [], { PILOT_AGENT_PRIVATE_KEY: undefined }],
    ["anahtar bozuk", [], { PILOT_AGENT_PRIVATE_KEY: "0x1234" }],
    ["kullanıcı yok", [], { PLAN_USER_ADDRESS: undefined }],
    ["--local uzak RPC", ["--local"], { ANVIL_RPC: "https://api.avax-test.network/ext/bc/C/rpc" }],
    ["yalnız KULE_URL", [], { KULE_URL: "https://kule.example.com/mcp" }],
    ["KULE düz http uzak", [], { KULE_URL: "http://kule.example.com/mcp", PILOT_TOKEN: "x".repeat(20) }],
    ["bilinmeyen argüman", ["--force"], {}],
  ])("çalışamaz (%s) → çıkış 2, ağa hiç istek yok, anahtar mesajda yok", async (_n, argv, o) => {
    let fetched = 0;
    const f = (async () => ((fetched += 1), new Response(null, { status: 500 }))) as unknown as typeof fetch;
    const lines: string[] = [];
    const code = await runStolenKey({ argv, env: env(o), fetch: f, readText: deployments, out: (l) => lines.push(l) });
    expect(code).toBe(2);
    expect(fetched).toBe(0);
    expect(lines.join("\n")).not.toContain(pk.slice(2));
  });

  it("canlı KULE: her istekte Bearer PILOT_TOKEN; yalnız kule_execute {actionId} çağrılır", async () => {
    const token = "pilot-token-0123456789";
    const m = fakeMcpFetch((name, args) => ({
      content: [],
      structuredContent: { verdict: "RET", clOrdId: `plt${(args as { actionId: string }).actionId}`, status: "NOT_PLACED", readback: "", reasons: ["NO_AUTHORIZATION"], paper: false },
    }));
    const probe = await connectKuleProbe({ url: "https://kule.example.com/mcp", token, fetch: m.fetch });
    expect(await probe.execute("1000004")).toEqual({ verdict: "RET", reasons: ["NO_AUTHORIZATION"] });
    await probe.close();
    for (const s of m.seen) expect(s.auth).toBe(`Bearer ${token}`);
    const toolCalls = m.seen.filter((s) => s.rpc === "tools/call");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.params).toEqual({ name: "kule_execute", arguments: { actionId: "1000004" } });
  });

  it("canlı KULE beklenmeyen yanıt (isError / biçimsiz) → hata (fail-closed)", async () => {
    for (const result of [{ content: [{ type: "text", text: "x" }], isError: true }, { content: [{ type: "text", text: "ONAY" }] }, { content: [], structuredContent: { verdict: "TAMAM" } }]) {
      const probe = await connectKuleProbe({ url: "https://kule.example.com/mcp", token: "pilot-token-0123456789", fetch: fakeMcpFetch(() => result).fetch });
      await expect(probe.execute("1")).rejects.toThrow();
    }
  });
});
