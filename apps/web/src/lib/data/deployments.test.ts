import { describe, expect, it } from "vitest";
import { loadDeployments } from "./deployments";
import { createMockKuleStatus } from "./kuleStatus";
import { createMockPilotFeed } from "./pilotFeed";

const reply = (body: string, init: ResponseInit = {}) => (async () => new Response(body, init)) as unknown as typeof fetch;

const VALID = JSON.stringify({
  chainId: 43113,
  deployBlock: 40000000,
  deployer: "0x1111111111111111111111111111111111111111",
  erc8004: {
    identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
    validation: "0x8004Cb1BF31DAf7788923b405b754f57acEB4272",
  },
  flightPlan: "0x2222222222222222222222222222222222222222",
  kuleReporter: "0x3333333333333333333333333333333333333333",
  pilotAgent: "0x4444444444444444444444444444444444444444",
  agentId: "17",
});

describe("deployments/fuji.json durumu", () => {
  it("404 NO_DEPLOYMENT sayılır (imza kapalı)", async () => {
    expect((await loadDeployments(reply("", { status: 404 }))).status).toBe("none");
  });

  it("SPA yedeği (index.html, 200) NO_DEPLOYMENT sayılır, geçersiz JSON değil", async () => {
    const s = await loadDeployments(reply("<!doctype html><html></html>", { status: 200, headers: { "content-type": "text/html" } }));
    expect(s.status).toBe("none");
  });

  it("ağ hatası 'yok' değil 'okunamadı' olur (fail-closed)", async () => {
    const boom = (async () => { throw new Error("ağ yok"); }) as unknown as typeof fetch;
    expect((await loadDeployments(boom)).status).toBe("invalid");
  });

  it("şemaya uymayan içerik reddedilir", async () => {
    expect((await loadDeployments(reply(JSON.stringify({ chainId: 31337 }), { status: 200 }))).status).toBe("invalid");
  });

  it("geçerli dosya ready olur", async () => {
    const s = await loadDeployments(reply(VALID, { status: 200, headers: { "content-type": "application/json" } }));
    expect(s.status).toBe("ready");
  });
});

describe("mock beslemeler shared şemalarından geçer", () => {
  it("PİLOT beslemesi", async () => {
    const f = await createMockPilotFeed().read("0x0");
    expect(f.weather?.class).toBe("NORMAL");
  });

  it("KULE durumu KÂĞIT modunda", async () => {
    expect((await createMockKuleStatus().read()).mode).toBe("paper");
  });
});
