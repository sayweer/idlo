// TODO(spec): §18'de A3 için kimlik yok; testler §17.2 adım kimliği "A3" ile adlandırıldı.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ERC8004_FUJI } from "@pilot/shared";
import {
  AgentCardSchema,
  buildAgentCard,
  checkServedCard,
  FUJI_AGENT_REGISTRY,
  validateAgentUri,
} from "../lib/agentCard.js";

const TEMPLATE = JSON.parse(readFileSync(new URL("../../data/agent-card/agent.json", import.meta.url), "utf8"));
const REAL = { imageUrl: "https://pilot.test/pilot.png", mcpEndpoint: "https://servis.pilot.test/mcp" };

describe("A3 agent.json kurucusu", () => {
  it("A3 şablon data/agent-card/agent.json kurucunun yer tutuculu çıktısıyla aynı ve şemaya uyar", () => {
    const built = buildAgentCard({ imageUrl: "https://web.ALANADI.com/pilot.png", mcpEndpoint: "https://servis.ALANADI.com/mcp" });
    expect(TEMPLATE).toEqual(built);
    expect(AgentCardSchema.parse(TEMPLATE)).toEqual(built);
  });

  it("A3 §8.5 alanları: name PİLOT, tek MCP servisi, Fuji Identity kaydı CAIP-10 biçiminde", () => {
    const c = buildAgentCard({ ...REAL, agentId: "41" });
    expect(c.name).toBe("PİLOT");
    expect(c.services).toEqual([{ name: "MCP", endpoint: REAL.mcpEndpoint }]);
    expect(c.registrations).toEqual([{ agentId: 41, agentRegistry: FUJI_AGENT_REGISTRY }]);
    expect(FUJI_AGENT_REGISTRY).toBe(`eip155:43113:${ERC8004_FUJI.identity}`);
    expect(c.active).toBe(true);
  });

  it("A3 agentId yoksa registrations boş (kayıt öncesi route handler)", () => {
    expect(buildAgentCard(REAL).registrations).toEqual([]);
  });

  it("A3 geçersiz ya da JSON sayısına sığmayan agentId reddedilir", () => {
    expect(() => buildAgentCard({ ...REAL, agentId: "-1" })).toThrow();
    expect(() => buildAgentCard({ ...REAL, agentId: "01" })).toThrow();
    expect(() => buildAgentCard({ ...REAL, agentId: "9007199254740992" })).toThrow(/sığmıyor/);
    expect(buildAgentCard({ ...REAL, agentId: "9007199254740991" }).registrations[0]!.agentId).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("A3 https olmayan görsel ya da uç nokta reddedilir", () => {
    expect(() => buildAgentCard({ ...REAL, imageUrl: "http://pilot.test/p.png" })).toThrow();
    expect(() => buildAgentCard({ ...REAL, mcpEndpoint: "servis/mcp" })).toThrow();
  });
});

describe("A3 agentURI ve yayındaki kart denetimi", () => {
  it("A3 agentURI: https + /agent.json kabul; http, başka yol, sorgu, yer tutucu ret", () => {
    expect(validateAgentUri("https://pilot.test/agent.json", { local: false })).toBe("https://pilot.test/agent.json");
    for (const bad of [
      "http://pilot.test/agent.json",
      "https://pilot.test/agent.json?x=1",
      "https://pilot.test/agent.json#a",
      "https://pilot.test/x/agent.json",
      "https://pilot.test/",
      "https://web.ALANADI.com/agent.json",
      "https://u:p@pilot.test/agent.json",
      "agent.json",
    ]) {
      expect(() => validateAgentUri(bad, { local: false }), bad).toThrow();
    }
  });

  it("A3 http yalnız --local ve yerel makinede", () => {
    expect(validateAgentUri("http://127.0.0.1:9/agent.json", { local: true })).toBeTruthy();
    expect(() => validateAgentUri("http://127.0.0.1:9/agent.json", { local: false })).toThrow();
    expect(() => validateAgentUri("http://pilot.test/agent.json", { local: true })).toThrow();
  });

  it("A3 yayındaki kart: şablon (yer tutucu) ve yanlış kayıt adresi reddedilir", () => {
    expect(() => checkServedCard(TEMPLATE)).toThrow(/yer tutucu/);
    const c = buildAgentCard({ ...REAL, agentId: "5" });
    expect(checkServedCard(c)).toEqual(c);
    expect(() => checkServedCard({ ...c, registrations: [{ agentId: 5, agentRegistry: "eip155:1:0x8004A818BFB912233c491871b3d84c89A494BD9e" }] })).toThrow();
    expect(() => checkServedCard({ ...c, name: "PILOT" })).toThrow();
    expect(() => checkServedCard("not json object")).toThrow();
  });
});
