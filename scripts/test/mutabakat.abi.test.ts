/**
 * M-1 / E-4 ön koşulu: betiklerin ABI parçası derlenmiş FlightPlan ile aynı imzaları taşır (forge build çıktısı varsa).
 * Olay imzası yanlışsa mutabakat olayları hiç bulamaz ve her emri yanlışlıkla "izinsiz" sayar.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { toEventSignature, toFunctionSignature, type AbiEvent, type AbiFunction } from "viem";
import { FLIGHT_PLAN_SCRIPT_ABI } from "../lib/mutabakat-abi.js";
import { REPO } from "./helpers.js";

const ART = join(REPO, "contracts/out/FlightPlan.sol/FlightPlan.json");

function sig(x: { type: string; name?: string }): string {
  if (x.type === "function") return `${toFunctionSignature(x as AbiFunction)}→${JSON.stringify((x as AbiFunction).outputs.map((o) => o.type))}`;
  if (x.type === "event") return `${toEventSignature(x as AbiEvent)}|${(x as AbiEvent).inputs.map((i) => (i.indexed ? "i" : "-")).join("")}`;
  return `${x.type}:${x.name}`;
}

describe.skipIf(!existsSync(ART))("M-1 / E-4 ABI parçası derlenmiş FlightPlan ile aynı", () => {
  it("M-1 her fonksiyon, olay (indexed dahil) ve hata derlenmiş ABI'de var", () => {
    const full = (JSON.parse(readFileSync(ART, "utf8")) as { abi: { type: string; name?: string }[] }).abi;
    const all = new Set(full.map(sig));
    for (const item of FLIGHT_PLAN_SCRIPT_ABI) expect(all, sig(item)).toContain(sig(item));
  });
});
