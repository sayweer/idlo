import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { TokenRegistry, bearerOf } from "../src/auth.js";
import { ConfigError, buildTokenBindings, loadConfig, parseAgentTokens } from "../src/config.js";

// Yalnız testte kullanılan, hiçbir yerde para tutmayan sahte anahtar.
const FAKE_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const REPORTER = privateKeyToAccount(FAKE_PK).address;
const A1 = "0x4444444444444444444444444444444444444444";
const A2 = "0x5555555555555555555555555555555555555555";
const A3 = "0x6666666666666666666666666666666666666666";
const USER = "0x1111111111111111111111111111111111111111";

const deployments = JSON.stringify({
  chainId: 43113,
  deployBlock: 40000000,
  deployer: "0x1111111111111111111111111111111111111112",
  erc8004: {
    identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
    validation: "0x8004Cb1BF31DAf7788923b405b754f57acEB4272",
  },
  flightPlan: "0x2222222222222222222222222222222222222222",
  kuleReporter: REPORTER,
  pilotAgent: A1,
  agentId: "17",
});

const GOOD: Record<string, string> = {
  KULE_PORT: "8787",
  PILOT_TOKEN: "pilot-token-AAAAAAAAAAAA",
  PILOT_AGENT_ADDRESS: A1,
  DEMO_CLIENT_TOKEN: "demo-token-BBBBBBBBBBBBB",
  PLAN_USER_ADDRESS: USER,
  OKX_PROFILE: "kule-demo",
  KULE_EXEC: "okx",
  OKX_API_KEY: "k",
  OKX_SECRET_KEY: "s",
  OKX_PASSPHRASE: "p",
  OKX_DEMO: "1",
  KULE_REPORTER_PRIVATE_KEY: FAKE_PK,
  FUJI_RPC: "https://api.avax-test.network/ext/bc/C/rpc",
  DEPLOYMENTS: "dep.json",
};
const io = { baseDir: "/base", readText: () => deployments, resolvePath: (b: string, p: string) => `${b}/${p}` };
const load = (over: Record<string, string | undefined> = {}) => loadConfig({ ...GOOD, ...over }, io);

describe("yapılandırma (fail-closed)", () => {
  it("geçerli yapılandırma: token→ajan bağı, kipler, yollar", () => {
    const c = load();
    expect(c.tokens.map((t) => [t.label, t.agent])).toEqual([
      ["pilot", A1],
      ["demo", null],
    ]);
    expect(c.mode).toBe("demo");
    expect(c.reporter).toBe(REPORTER);
    expect(c.actionsPath).toBe("/base/data/kule-actions.json");
    expect(load({ KULE_EXEC: "paper" }).mode).toBe("paper");
    expect(load({ OKX_PROFILE: "kule", OKX_DEMO: "0" }).mode).toBe("live");
  });

  it("AGENT_TOKENS ile çok ajanlı yön: ajan başına tek token", () => {
    const c = load({ AGENT_TOKENS: `agent-token-CCCCCCCCCCCC:${A2}, agent-token-DDDDDDDDDDDD:${A3}` });
    expect(c.tokens.filter((t) => t.agent).map((t) => t.agent)).toEqual([A1, A2, A3]);
    expect(c.tokens.map((t) => t.label)).toEqual(["pilot", "demo", "agent1", "agent2"]);
  });

  it("DEMO_CLIENT_AGENT_ADDRESS ile demo token'ı ajana bağlanabilir", () => {
    const c = load({ DEMO_CLIENT_AGENT_ADDRESS: A2 });
    expect(c.tokens.find((t) => t.label === "demo")?.agent).toBe(A2);
  });

  it.each([
    ["PILOT_TOKEN yok", { PILOT_TOKEN: undefined }],
    ["PILOT_AGENT_ADDRESS yok", { PILOT_AGENT_ADDRESS: undefined }],
    ["kısa token", { PILOT_TOKEN: "kisa" }],
    ["boşluklu token", { PILOT_TOKEN: "token with spaces 123456" }],
    ["sıfır ajan adresi", { PILOT_AGENT_ADDRESS: "0x0000000000000000000000000000000000000000" }],
    ["bozuk ajan adresi", { PILOT_AGENT_ADDRESS: "0x123" }],
    ["aynı token iki kez", { DEMO_CLIENT_TOKEN: "pilot-token-AAAAAAAAAAAA" }],
    ["aynı ajana iki token", { AGENT_TOKENS: `agent-token-CCCCCCCCCCCC:${A1}` }],
    ["bozuk AGENT_TOKENS", { AGENT_TOKENS: "tokensizadres" }],
    ["PLAN_USER_ADDRESS yok", { PLAN_USER_ADDRESS: undefined }],
    ["PLAN_USER_ADDRESS sıfır", { PLAN_USER_ADDRESS: "0x0000000000000000000000000000000000000000" }],
    ["KULE_EXEC bilinmeyen", { KULE_EXEC: "live" }],
    ["KULE_PORT geçersiz", { KULE_PORT: "99999" }],
    ["OKX_PROFILE kabuk karakteri", { OKX_PROFILE: "kule; rm -rf /" }],
    ["demo profil ama OKX_DEMO=0", { OKX_PROFILE: "kule-demo", OKX_DEMO: "0" }],
    ["canlı profil ama OKX_DEMO=1", { OKX_PROFILE: "kule", OKX_DEMO: "1" }],
    ["okx modunda CAA anahtarı yok", { OKX_API_KEY: undefined }],
    ["raportör anahtarı yok", { KULE_REPORTER_PRIVATE_KEY: undefined }],
    ["raportör anahtarı bozuk", { KULE_REPORTER_PRIVATE_KEY: "0x1234" }],
    ["raportör anahtarı deployments ile uyuşmuyor", { KULE_REPORTER_PRIVATE_KEY: "0x" + "11".repeat(32) }],
    ["RPC düz http", { FUJI_RPC: "http://rpc.example.com" }],
    ["RPC içinde parola", { FUJI_RPC: "https://user:pw@rpc.example.com" }],
    ["DEPLOYMENTS yok", { DEPLOYMENTS: undefined }],
  ])("%s → ConfigError", (_name, over) => {
    expect(() => load(over as Record<string, string | undefined>)).toThrow(ConfigError);
  });

  it("paper modunda OKX anahtarı gerekmez; okx modunda gerekir", () => {
    expect(() => load({ KULE_EXEC: "paper", OKX_API_KEY: undefined, OKX_SECRET_KEY: undefined, OKX_PASSPHRASE: undefined })).not.toThrow();
  });

  it("http://127.0.0.1 RPC (anvil) kabul edilir", () => {
    expect(() => load({ FUJI_RPC: "http://127.0.0.1:8545" })).not.toThrow();
  });

  it("DEPLOYMENTS okunamaz / bozuksa ConfigError; hata mesajı gizli değer içermez", () => {
    const bad = { ...io, readText: () => "{bozuk" };
    let msg = "";
    try {
      loadConfig(GOOD, bad);
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      msg = (e as Error).message;
    }
    expect(msg).not.toContain(FAKE_PK);
    expect(msg).not.toContain(GOOD.PILOT_TOKEN!);
    const missing = { ...io, readText: () => { throw new Error("ENOENT"); } };
    expect(() => loadConfig(GOOD, missing)).toThrow(ConfigError);
  });

  it("hiçbir ConfigError mesajı token/anahtar/parola içermez", () => {
    const secrets = [GOOD.PILOT_TOKEN!, GOOD.DEMO_CLIENT_TOKEN!, FAKE_PK, "k", "s", "p"].filter((s) => s.length > 3);
    const cases: Record<string, string | undefined>[] = [
      { PILOT_AGENT_ADDRESS: "0x123" },
      { KULE_REPORTER_PRIVATE_KEY: "0x" + "11".repeat(32) },
      { PLAN_USER_ADDRESS: undefined },
      { FUJI_RPC: "http://x" },
    ];
    for (const c of cases) {
      try {
        load(c);
        throw new Error("fırlatmalıydı");
      } catch (e) {
        for (const s of secrets) expect((e as Error).message).not.toContain(s);
      }
    }
  });

  it("parseAgentTokens / buildTokenBindings uç durumlar", () => {
    expect(parseAgentTokens("")).toEqual([]);
    expect(() => buildTokenBindings({})).toThrow(ConfigError);
    expect(() => buildTokenBindings({ DEMO_CLIENT_TOKEN: "demo-token-BBBBBBBBBBBBB" })).toThrow(/ajana bağlı/);
    expect(() => buildTokenBindings({ PILOT_TOKEN: GOOD.PILOT_TOKEN!, PILOT_AGENT_ADDRESS: A1, DEMO_CLIENT_AGENT_ADDRESS: A2 })).toThrow(ConfigError);
  });
});

describe("token çözümü", () => {
  const reg = new TokenRegistry([
    { token: "pilot-token-AAAAAAAAAAAA", agent: A1 as `0x${string}`, label: "pilot" },
    { token: "demo-token-BBBBBBBBBBBBB", agent: null, label: "demo" },
  ]);
  it("geçerli token bağını döndürür; geçersiz/boş/öneki eşleşen null", () => {
    expect(reg.resolve("pilot-token-AAAAAAAAAAAA")?.label).toBe("pilot");
    expect(reg.resolve("demo-token-BBBBBBBBBBBBB")?.agent).toBeNull();
    expect(reg.resolve("pilot-token-AAAAAAAAAAA")).toBeNull();
    expect(reg.resolve("pilot-token-AAAAAAAAAAAAx")).toBeNull();
    expect(reg.resolve("")).toBeNull();
    expect(reg.resolve(null)).toBeNull();
    expect(reg.resolve(undefined)).toBeNull();
  });
  it("yalnız ajana bağlı token'lar kalp atışı sayılır", () => {
    expect(reg.agentLabels()).toEqual(["pilot"]);
  });
  it("Authorization başlığı ayrıştırma", () => {
    expect(bearerOf("Bearer abc")).toBe("abc");
    expect(bearerOf("bearer abc")).toBeNull();
    expect(bearerOf("Bearer a b")).toBeNull();
    expect(bearerOf("Basic abc")).toBeNull();
    expect(bearerOf(undefined)).toBeNull();
    expect(bearerOf(["Bearer abc"])).toBeNull();
  });
});
