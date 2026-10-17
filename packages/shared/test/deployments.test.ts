import { describe, expect, it } from "vitest";
import { ERC8004_FUJI, parseDeployments } from "../deployments.js";

const FP = "0x4444444444444444444444444444444444444444";
const ok = () => ({ chainId: 43113, flightPlan: FP, erc8004: { ...ERC8004_FUJI } });

describe("Adres okuyucu (§7, Ek B)", () => {
  it("geçerli dosya okunur; agentId isteğe bağlı", () => {
    expect(parseDeployments(JSON.stringify(ok())).flightPlan).toBe(FP);
    expect(parseDeployments(JSON.stringify({ ...ok(), agentId: "17" })).agentId).toBe("17");
  });
  it("eksik, boş ya da bozuk dosya reddedilir (fail-closed)", () => {
    expect(() => parseDeployments(undefined)).toThrow();
    expect(() => parseDeployments("")).toThrow();
    expect(() => parseDeployments("{")).toThrow();
  });
  it("yanlış zincir, eksik adres ya da Ek B dışı ERC-8004 adresi reddedilir", () => {
    expect(() => parseDeployments(JSON.stringify({ ...ok(), chainId: 43114 }))).toThrow();
    expect(() => parseDeployments(JSON.stringify({ ...ok(), flightPlan: "0x12" }))).toThrow();
    const bad = { ...ok(), erc8004: { ...ERC8004_FUJI, identity: FP } };
    expect(() => parseDeployments(JSON.stringify(bad))).toThrow();
    expect(() => parseDeployments(JSON.stringify({ ...ok(), agentId: 17 }))).toThrow();
  });
});
