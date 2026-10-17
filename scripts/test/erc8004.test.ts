// TODO(spec): §18'de A3 için kimlik yok; testler §17.2 adım kimliği "A3" ile adlandırıldı.
import { describe, expect, it } from "vitest";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  toFunctionSelector,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { identityRegistryAbi, reputationRegistryAbi, extractAgentId, type RegistryLog } from "../lib/erc8004.js";

const REG: Address = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const OWNER: Address = "0x1111111111111111111111111111111111111111";
const OTHER: Address = "0x2222222222222222222222222222222222222222";

const registered = (id: bigint, owner: Address = OWNER, address: Address = REG): RegistryLog => ({
  address,
  topics: encodeEventTopics({ abi: identityRegistryAbi, eventName: "Registered", args: { agentId: id, owner } }) as Hex[],
  data: encodeAbiParameters([{ type: "string" }], ["https://pilot.test/agent.json"]),
});
const minted = (id: bigint, to: Address = OWNER, from: Address = zeroAddress): RegistryLog => ({
  address: REG,
  topics: encodeEventTopics({ abi: identityRegistryAbi, eventName: "Transfer", args: { from, to, tokenId: id } }) as Hex[],
  data: "0x",
});

describe("A3 ERC-8004 ABI", () => {
  it("A3 §8.5 imzaları: register(string), giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)", () => {
    expect(encodeFunctionData({ abi: identityRegistryAbi, functionName: "register", args: ["x"] }).slice(0, 10)).toBe(
      toFunctionSelector("register(string)"),
    );
    const fb = encodeFunctionData({
      abi: reputationRegistryAbi,
      functionName: "giveFeedback",
      args: [1n, 5n, 0, "cycle", "202610", "", "", `0x${"00".repeat(32)}`],
    });
    expect(fb.slice(0, 10)).toBe(toFunctionSelector("giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)"));
  });
});

describe("A3 makbuzdan agentId", () => {
  it("A3 Registered ve Transfer(0→sahip) aynı kimliği gösterir → agentId", () => {
    expect(extractAgentId([minted(41n), registered(41n)], REG, OWNER)).toBe(41n);
  });

  it("A3 olaylardan yalnız biri varsa da okunur", () => {
    expect(extractAgentId([registered(7n)], REG, OWNER)).toBe(7n);
    expect(extractAgentId([minted(7n)], REG, OWNER)).toBe(7n);
  });

  it("A3 iki farklı kimlik → ret", () => {
    expect(() => extractAgentId([minted(41n), registered(42n)], REG, OWNER)).toThrow(/farklı agentId/);
  });

  it("A3 olay yok → ret (fail-closed)", () => {
    expect(() => extractAgentId([], REG, OWNER)).toThrow(/bulunamadı/);
  });

  it("A3 başka kontrat, başka sahip, sıfırdan olmayan Transfer ve ERC-20 Transfer sayılmaz", () => {
    const erc20Transfer: RegistryLog = {
      address: REG,
      topics: [minted(1n).topics[0]!, minted(1n).topics[1]!, minted(1n).topics[2]!],
      data: encodeAbiParameters([{ type: "uint256" }], [9n]),
    };
    const logs = [registered(1n, OWNER, OTHER), registered(2n, OTHER), minted(3n, OWNER, OTHER), erc20Transfer, minted(4n)];
    expect(extractAgentId(logs, REG, OWNER)).toBe(4n);
  });
});
