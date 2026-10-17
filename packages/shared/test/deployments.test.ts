import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ERC8004_FUJI, parseDeployments } from "../deployments.js";

// TODO(spec): §18'de dağıtım dosyası için kimlik yok; test adları adım kimliği A2 ile başlar.
const FP = "0x4444444444444444444444444444444444444444";
const ok = () => ({
  chainId: 43113,
  flightPlan: FP,
  deployBlock: 41_000_000,
  deployer: "0x1111111111111111111111111111111111111111",
  pilotAgent: "0x2222222222222222222222222222222222222222",
  kuleReporter: "0x3333333333333333333333333333333333333333",
  erc8004: { ...ERC8004_FUJI },
});
const parse = (v: unknown) => parseDeployments(JSON.stringify(v));

describe("Adres okuyucu (§7, Ek B)", () => {
  it("A2 Deploy.s.sol çıktısı okunur; agentId A3'e kadar isteğe bağlı", () => {
    const d = parse(ok());
    expect(d.flightPlan).toBe(FP);
    expect(d.deployBlock).toBe(41_000_000);
    expect(d.agentId).toBeUndefined();
    expect(parse({ ...ok(), agentId: "17" }).agentId).toBe("17");
  });
  it("A2 deployments/fuji.example.json biçimi şemaya uyar", () => {
    const text = readFileSync(new URL("../../../deployments/fuji.example.json", import.meta.url), "utf8");
    expect(parseDeployments(text).chainId).toBe(43113);
  });
  it("A2 eksik, boş ya da bozuk dosya reddedilir (fail-closed)", () => {
    expect(() => parseDeployments(undefined)).toThrow();
    expect(() => parseDeployments("")).toThrow();
    expect(() => parseDeployments("{")).toThrow();
  });
  it("A2 yanlış zincir, eksik/bozuk alan ya da Ek B dışı ERC-8004 adresi reddedilir", () => {
    expect(() => parse({ ...ok(), chainId: 43114 })).toThrow();
    expect(() => parse({ ...ok(), chainId: 31337 })).toThrow(); // düz Anvil
    expect(() => parse({ ...ok(), flightPlan: "0x12" })).toThrow();
    for (const k of ["flightPlan", "deployBlock", "deployer", "pilotAgent", "kuleReporter", "erc8004"] as const) {
      const v: Record<string, unknown> = ok();
      delete v[k];
      expect(() => parse(v), k).toThrow();
    }
    expect(() => parse({ ...ok(), deployBlock: -1 })).toThrow();
    expect(() => parse({ ...ok(), deployBlock: "41000000" })).toThrow();
    expect(() => parse({ ...ok(), erc8004: { ...ERC8004_FUJI, identity: FP } })).toThrow();
    expect(() => parse({ ...ok(), erc8004: { ...ERC8004_FUJI, extra: FP } })).toThrow();
    expect(() => parse({ ...ok(), agentId: 17 })).toThrow();
  });
  it("A2 sıfır adres ve aynı cüzdana düşen roller reddedilir", () => {
    const zero = "0x0000000000000000000000000000000000000000";
    expect(() => parse({ ...ok(), pilotAgent: zero })).toThrow();
    expect(() => parse({ ...ok(), flightPlan: zero })).toThrow();
    expect(() => parse({ ...ok(), kuleReporter: ok().pilotAgent })).toThrow();
    expect(() => parse({ ...ok(), pilotAgent: ok().deployer.toUpperCase().replace("0X", "0x") })).toThrow();
  });
});
