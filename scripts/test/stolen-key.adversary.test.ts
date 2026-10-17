/**
 * E-4 / §16 #19 saldırgan testleri (stolen-key). Değişmez: betik hiçbir koşulda gerçek bir izin (BuyAuthorized)
 * oluşturmaz; ön koşul tutmazsa işlem göndermez; plan yokken de çökmeden, Türkçe mesajla durur.
 * Ağ yok: zincir taklit (sahne) ya da JSON-RPC taklit (viem yolu).
 */
import { describe, expect, it } from "vitest";
import {
  decodeFunctionData,
  encodeFunctionResult,
  numberToHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { parseDeployments, RejectCode, type ChainBuyAction, type ChainPlan } from "@pilot/shared";
import { FLIGHT_PLAN_SCRIPT_ABI } from "../lib/mutabakat-abi.js";
import { assertKuleUrl, runStolenKey } from "../lib/stolen-io.js";
import {
  runStolenKeyScene,
  SceneAbort,
  STOLEN_AMOUNT_TL,
  type KuleExecuteProbe,
  type RequestBuyCall,
  type SentResult,
  type StolenChain,
} from "../lib/stolen-scene.js";
import { deploymentsText, ELIF, KULE_REPORTER, PILOT_AGENT } from "./helpers.js";

const D = parseDeployments(deploymentsText());
const TX: Hex = `0x${"5a".repeat(32)}`;
const PLAN: ChainPlan = {
  cycleTL: 300n, maxOrderTL: 150n, startDay: 15, deadlineDay: 25, maxWaitH: 72, bandBps: 0, closedBandBps: 500, askMode: 1,
  expiresAt: 2_000_000_000n, agent: PILOT_AGENT, kule: KULE_REPORTER, agentId: 17n,
};
const EMPTY_PLAN: ChainPlan = { ...PLAN, cycleTL: 0n, maxOrderTL: 0n, startDay: 0, deadlineDay: 0, maxWaitH: 0, closedBandBps: 0, askMode: 0, expiresAt: 0n, agent: zeroAddress, kule: zeroAddress, agentId: 0n };
const EMPTY_ACTION: ChainBuyAction = { user: zeroAddress, amountTL: 0n, maxPxE6: 0n, ordType: 0, openBy: 0n, reportBy: 0n, cycleId: 0, state: 0 };

/** Kontrat gibi davranan sahte zincir: plan tavanı aşılırsa 0 (ret), değilse izin. Gönderilen her işlem kaydedilir. */
class Chain implements StolenChain {
  sent: RequestBuyCall[] = [];
  simulated: RequestBuyCall[] = [];
  constructor(
    public o: {
      agent?: Address;
      chainId?: number;
      plan?: ChainPlan;
      active?: boolean;
      day?: number;
      simulate?: (c: RequestBuyCall) => bigint;
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
    this.simulated.push(c);
    if (this.o.simulate) return this.o.simulate(c);
    return c.amountTL > (this.o.plan ?? PLAN).maxOrderTL ? 0n : 5n;
  }
  async sendRequestBuy(c: RequestBuyCall): Promise<SentResult> {
    this.sent.push(c);
    if (this.o.send) return this.o.send(c);
    // Gerçek kontrat: tavan aşılırsa ret, değilse İZİN. Bu taklit, betik yanlışlıkla gönderirse bunu yakalar.
    if (c.amountTL > (this.o.plan ?? PLAN).maxOrderTL) {
      return { kind: "rejected", hash: TX, user: c.user, amountTL: c.amountTL, code: RejectCode.OVER_ORDER_LIMIT };
    }
    return { kind: "authorized", hash: TX, actionId: 5n };
  }
}

async function scene(chain: Chain, extra: { kule?: KuleExecuteProbe; user?: Address } = {}) {
  const lines: string[] = [];
  const p = runStolenKeyScene({ chain, network: "fuji", deployments: D, user: extra.user ?? ELIF, out: (l) => lines.push(l), ...(extra.kule ? { kule: extra.kule } : {}) });
  return { p, lines };
}

async function aborts(chain: Chain, msg: RegExp, extra: { user?: Address } = {}) {
  const { p } = await scene(chain, extra);
  await expect(p).rejects.toBeInstanceOf(SceneAbort);
  await expect(p).rejects.toThrow(msg);
  expect(chain.sent, "işlem gönderilmemeli").toHaveLength(0);
}

describe("E-4 saldırgan: betik hiçbir koşulda izin oluşturmaz", () => {
  it("E-4 Elif'in planı yok → çökmeden durur, Türkçe mesaj, işlem ve eth_call yok", async () => {
    const c = new Chain({ plan: EMPTY_PLAN });
    await aborts(c, /planı yok/);
    expect(c.simulated).toHaveLength(0);
  });

  it("E-4 plan iptal edilmiş (isPlanActive false) → durur, işlem yok", async () => {
    await aborts(new Chain({ active: false }), /etkin değil/);
  });

  it("E-4 plan başka ajana bağlı (saldırgan planı) → durur, işlem yok", async () => {
    await aborts(new Chain({ plan: { ...PLAN, agent: "0x000000000000000000000000000000000000beef" } }), /bu ajana bağlı değil/);
  });

  it.each([
    ["tam 40.000", 40_000n],
    ["40.001", 40_001n],
  ])("E-4 tek emir tavanı %s TL (40.000 reddedilmez) → durur, işlem yok", async (_n, maxOrderTL) => {
    await aborts(new Chain({ plan: { ...PLAN, maxOrderTL } }), /reddedilmez/);
  });

  it("E-4 tek emir tavanı uint64 en büyük (TL güvenli aralık dışı) → birim hatasıyla durur, işlem yok (fail-closed)", async () => {
    const c = new Chain({ plan: { ...PLAN, maxOrderTL: 2n ** 64n - 1n } });
    const { p } = await scene(c);
    await expect(p).rejects.toThrow();
    expect(c.sent).toHaveLength(0);
  });

  it("E-4 tavan 39.999 TL → işlem gider ve kontrat reddeder (sınır doğru tarafta)", async () => {
    const c = new Chain({ plan: { ...PLAN, maxOrderTL: 39_999n } });
    const { p } = await scene(c);
    const r = await p;
    expect(c.sent).toHaveLength(1);
    expect(r.rejectCode).toBe(RejectCode.OVER_ORDER_LIMIT);
  });

  it("E-4 tavan düşük ama eth_call izin numarası döndürüyor (ör. kontrat yükseltilmiş) → durur, işlem yok", async () => {
    await aborts(new Chain({ simulate: () => 9n }), /ret beklenmiyor/);
  });

  it("E-4 eth_call revert ederse (ör. NotAgent) → işlem gönderilmez", async () => {
    const c = new Chain({
      simulate: () => {
        throw new Error("NotAgent()");
      },
    });
    const { p } = await scene(c);
    await expect(p).rejects.toThrow();
    expect(c.sent).toHaveLength(0);
  });

  it("E-4 anahtar deployments.pilotAgent değil → durur, işlem yok", async () => {
    await aborts(new Chain({ agent: "0x000000000000000000000000000000000000dead" }), /pilotAgent değil/);
  });

  it("E-4 RPC zinciri Fuji değil (ör. C-Chain ana ağ 43114) → durur, işlem yok", async () => {
    await aborts(new Chain({ chainId: 43114 }), /RPC zinciri 43114/);
  });

  it.each([
    ["pencere öncesi", 14],
    ["pencere sonrası", 26],
  ])("E-4 bugün %s → durur (kod 2 gösterirdi), işlem yok", async (_n, day) => {
    await aborts(new Chain({ day }), /pencere/);
  });

  it.each([
    ["PİLOT adresi", PILOT_AGENT],
    ["KULE adresi", KULE_REPORTER],
    ["sıfır adres", zeroAddress],
  ])("E-4 hedef kullanıcı %s → durur, işlem yok", async (_n, user) => {
    await aborts(new Chain(), /Elif'in adresi/, { user });
  });

  it("E-4 gönderilen tek işlem: requestBuy(Elif, 40.000 TL) — tutar, kullanıcı sabit; değer gönderilmez", async () => {
    const c = new Chain();
    const { p } = await scene(c);
    await p;
    expect(c.sent).toEqual(c.simulated);
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]!.user).toBe(ELIF);
    expect(c.sent[0]!.amountTL).toBe(BigInt(STOLEN_AMOUNT_TL));
  });

  it("E-4 ret olayı başka kullanıcı ya da tutar için → sahne başarısız (yanlış olay başarı sayılmaz)", async () => {
    for (const send of [
      (cl: RequestBuyCall): SentResult => ({ kind: "rejected", hash: TX, user: "0x0000000000000000000000000000000000000bad", amountTL: cl.amountTL, code: 3 }),
      (cl: RequestBuyCall): SentResult => ({ kind: "rejected", hash: TX, user: cl.user, amountTL: 150n, code: 3 }),
      (): SentResult => ({ kind: "other", hash: TX }),
    ]) {
      const { p } = await scene(new Chain({ send }));
      expect((await p).ok).toBe(false);
    }
  });

  it("E-4 canlı KULE sahte izni ONAYlarsa ya da başka gerekçeyle reddederse → sahne başarısız", async () => {
    for (const reply of [{ verdict: "ONAY", reasons: [] }, { verdict: "RET", reasons: ["WRONG_AGENT"] }, { verdict: "BEKLET", reasons: ["NO_AUTHORIZATION"] }]) {
      const { p } = await scene(new Chain(), { kule: { execute: async () => reply } });
      expect((await p).ok, JSON.stringify(reply)).toBe(false);
    }
  });

  it("E-4 canlı KULE hata verirse sahne başarı saymaz (fırlatır)", async () => {
    const { p } = await scene(new Chain(), {
      kule: {
        execute: async () => {
          throw new Error("bağlantı koptu");
        },
      },
    });
    await expect(p).rejects.toThrow();
  });
});

// ─────────────────────────── viem yolu: JSON-RPC taklidi ───────────────────────────

/** FlightPlan okuma çağrılarını ABI ile yanıtlayan JSON-RPC taklidi; gönderim yöntemleri kaydedilir ve reddedilir. */
function fakeRpc(o: { chainId?: number; plan?: ChainPlan; active?: boolean }) {
  const methods: string[] = [];
  const f = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] } | { id: number; method: string; params: unknown[] }[];
    const one = (m: { id: number; method: string; params: unknown[] }) => {
      methods.push(m.method);
      const ok = (result: unknown) => ({ jsonrpc: "2.0", id: m.id, result });
      if (m.method === "eth_chainId") return ok(numberToHex(o.chainId ?? 43113));
      if (m.method === "eth_call") {
        const [{ data }] = m.params as [{ data: Hex }];
        const call = decodeFunctionData({ abi: FLIGHT_PLAN_SCRIPT_ABI, data });
        const plan = o.plan ?? PLAN;
        const res: Record<string, unknown> = {
          plans: plan,
          isPlanActive: o.active ?? true,
          trDay: 17,
          lastActionId: 0n,
          actions: EMPTY_ACTION,
          requestBuy: 0n,
        };
        return ok(encodeFunctionResult({ abi: FLIGHT_PLAN_SCRIPT_ABI, functionName: call.functionName, result: res[call.functionName] } as never));
      }
      return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `taklit: ${m.method} yok` } };
    };
    return Response.json(Array.isArray(body) ? body.map(one) : one(body));
  }) as typeof fetch;
  return { fetch: f, methods };
}

describe("E-4 saldırgan: stolen-key.ts (viem yolu, ağsız)", () => {
  const pk = generatePrivateKey();
  const agent = privateKeyToAccount(pk).address;
  const env = (o: Record<string, string | undefined> = {}) => ({ PILOT_AGENT_PRIVATE_KEY: pk, PLAN_USER_ADDRESS: ELIF, FUJI_RPC: "https://rpc.test/ext/bc/C/rpc", ...o });
  const readText = () => deploymentsText({ pilotAgent: agent });
  const SEND = ["eth_sendRawTransaction", "eth_sendTransaction", "eth_estimateGas", "eth_getTransactionCount", "eth_signTransaction"];

  async function run(rpc: ReturnType<typeof fakeRpc>, argv: string[] = [], e = env()) {
    const lines: string[] = [];
    const code = await runStolenKey({ argv, env: e, fetch: rpc.fetch, readText, out: (l) => lines.push(l) });
    return { code, text: lines.join("\n") };
  }

  it("E-4 plan yok (plans(Elif) boş) → çıkış 2, 'planı yok', zincire hiçbir işlem hazırlığı yok, anahtar çıktıda yok", async () => {
    const rpc = fakeRpc({ plan: { ...EMPTY_PLAN } });
    const r = await run(rpc);
    expect(r.code, r.text).toBe(2);
    expect(r.text).toContain("işlem gönderilmedi");
    expect(r.text).toContain("planı yok");
    expect(r.text).not.toContain(pk.slice(2));
    for (const m of SEND) expect(rpc.methods).not.toContain(m);
  });

  it("E-4 plan iptal (isPlanActive false) → çıkış 2, işlem yok", async () => {
    const rpc = fakeRpc({ plan: { ...PLAN, agent }, active: false });
    const r = await run(rpc);
    expect(r.code, r.text).toBe(2);
    for (const m of SEND) expect(rpc.methods).not.toContain(m);
  });

  it("E-4 FUJI_RPC ana ağı (43114) gösteriyor → çıkış 2, işlem yok", async () => {
    const rpc = fakeRpc({ chainId: 43114, plan: { ...PLAN, agent } });
    const r = await run(rpc);
    expect(r.code, r.text).toBe(2);
    expect(rpc.methods).toEqual(["eth_chainId"]);
  });

  it("E-4 plan tavanı 40.000 TL → çıkış 2, eth_call bile yapılmadan durur", async () => {
    const rpc = fakeRpc({ plan: { ...PLAN, agent, maxOrderTL: 40_000n } });
    const r = await run(rpc);
    expect(r.code, r.text).toBe(2);
    for (const m of SEND) expect(rpc.methods).not.toContain(m);
  });

  it.each([
    ["localhost alt alanı", "http://localhost.evil.example:8545"],
    ["userinfo ile uzak sunucu", "http://127.0.0.1@evil.example:8545"],
    ["0.0.0.0", "http://0.0.0.0:8545"],
    ["https uzak", "https://api.avax.network/ext/bc/C/rpc"],
  ])("E-4 --local ama ANVIL_RPC %s → çıkış 2, ağa istek yok", async (_n, ANVIL_RPC) => {
    const rpc = fakeRpc({});
    const r = await run(rpc, ["--local"], env({ ANVIL_RPC }));
    expect(r.code).toBe(2);
    expect(rpc.methods).toHaveLength(0);
  });
});

describe("E-4 saldırgan: KULE_URL (PILOT_TOKEN yalnız güvenli adrese)", () => {
  it.each([
    "http://localhost.evil.example/mcp",
    "http://127.0.0.1.nip.io/mcp",
    "http://127.0.0.1@evil.example/mcp",
    "http://evil.example/mcp#@127.0.0.1",
    "https://user:pass@kule.example.com/mcp",
    "ftp://127.0.0.1/mcp",
    "http://0.0.0.0:8787/mcp",
    "javascript:alert(1)",
    "kule.example.com/mcp",
  ])("E-4 reddedilir: %s", (u) => {
    expect(() => assertKuleUrl(u)).toThrow();
  });

  it.each(["https://kule.example.com/mcp", "http://127.0.0.1:8787/mcp", "http://localhost:8787/mcp", "http://[::1]:8787/mcp"])("E-4 kabul: %s", (u) => {
    expect(() => assertKuleUrl(u)).not.toThrow();
  });
});
