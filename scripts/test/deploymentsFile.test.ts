// TODO(spec): §18'de A3 için kimlik yok; testler §17.2 adım kimliği "A3" ile adlandırıldı.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDeployments } from "@pilot/shared";
import { withAgentId } from "../lib/deploymentsFile.js";

const EXAMPLE = JSON.parse(readFileSync(new URL("../../deployments/fuji.example.json", import.meta.url), "utf8"));
const { agentId: _drop, ...BASE } = EXAMPLE;
const BASE_TEXT = JSON.stringify(BASE, null, 2);

describe("A3 fuji.json'a agentId", () => {
  it("A3 agentId ondalık string olarak eklenir; diğer alanlar aynen kalır", () => {
    const out = withAgentId(BASE_TEXT, 41n);
    expect(parseDeployments(out).agentId).toBe("41");
    expect(JSON.parse(out)).toEqual({ ...BASE, agentId: "41" });
  });

  it("A3 şemanın bilmediği anahtarlar korunur", () => {
    const out = withAgentId(JSON.stringify({ ...BASE, note: "x" }), 5n);
    expect(JSON.parse(out).note).toBe("x");
  });

  it("A3 eksik, bozuk ya da şemaya uymayan dosya → ret", () => {
    expect(() => withAgentId("", 1n)).toThrow(/yok ya da boş/);
    expect(() => withAgentId("{", 1n)).toThrow(/JSON/);
    expect(() => withAgentId(JSON.stringify({ ...BASE, chainId: 31337 }), 1n)).toThrow(/geçersiz/);
    expect(() => withAgentId(JSON.stringify({ ...BASE, erc8004: { ...BASE.erc8004, identity: BASE.deployer } }), 1n)).toThrow();
  });

  it("A3 agentId 0 yazılmaz (web 0'ı kayıt yok sayar)", () => {
    expect(() => withAgentId(BASE_TEXT, 0n)).toThrow(/0/);
  });
});
