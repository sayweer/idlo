import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, getAddress, type Address, type Hex } from "viem";
import {
  applyEdit,
  buildPlanConfirmation,
  type Candidate,
  type Deployments,
  type PlanDraft,
} from "@pilot/shared";
import { FLIGHT_PLAN_ABI } from "../../lib/flightPlanAbi";
import { buildFixtureResponse } from "./fixture";
import { agentPlanContext, buildSignRequest, finalitySeconds, readPlanSet, scoreText, trDateTime } from "./logic";
import { AgentsResponseSchema } from "./types";

const addr = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);

const DEPLOYMENTS: Deployments = {
  chainId: 43113,
  flightPlan: addr(0x22),
  deployBlock: 1,
  deployer: addr(0x11),
  pilotAgent: addr(0x44),
  kuleReporter: addr(0x33),
  erc8004: {
    identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
    validation: "0x8004Cb1BF31DAf7788923b405b754f57acEB4272",
  },
  agentId: "17",
};

const DRAFT: PlanDraft = {
  cycleTL: { value: 300, source: "user" },
  startDay: { value: 15, source: "user" },
  deadlineDay: { value: 25, source: "user" },
  maxOrderTL: { value: 150, source: "user" },
  askOnAmbiguity: { value: true, source: "user" },
  maxWaitH: { value: 72, source: "default" },
  expiresInDays: { value: 90, source: "default" },
  questions: [],
};

const NOW = 1_760_000_000;
const confFor = (draft: PlanDraft, deployments: Deployments | null) =>
  buildPlanConfirmation(draft, {
    nowSec: NOW,
    deployments: deployments && { pilotAgent: deployments.pilotAgent, kuleReporter: deployments.kuleReporter, agentId: deployments.agentId },
    current: null,
    currentActive: false,
  });

describe("/secim imza isteği", () => {
  it("imza çağrısının args'ı conf.setPlanArgs ile AYNI nesnedir (başka yerden kurulmaz)", () => {
    const conf = confFor(DRAFT, DEPLOYMENTS);
    expect(conf.signable).toBe(true);
    const req = buildSignRequest(DEPLOYMENTS, conf);
    expect(req).not.toBeNull();
    expect(req!.args).toBe(conf.setPlanArgs);
    expect(req!.functionName).toBe("setPlan");
    expect(req!.address).toBe(DEPLOYMENTS.flightPlan);
  });

  it("signable=false iken istek kurulmaz (düğme kapalı kalır)", () => {
    const open = { ...DRAFT, cycleTL: { value: null, source: "default" as const }, questions: ["Her ay kaç TL çevirmek istiyorsun?"] };
    const conf = confFor(open, DEPLOYMENTS);
    expect(conf.signable).toBe(false);
    expect(buildSignRequest(DEPLOYMENTS, conf)).toBeNull();
  });

  it("geçersiz düzeltme imzayı kapatır, düzeltilince açılır", () => {
    const bad = applyEdit(confFor(DRAFT, DEPLOYMENTS), "cycleTL", "20.000");
    expect(bad.signable).toBe(false);
    expect(buildSignRequest(DEPLOYMENTS, bad)).toBeNull();
    const fixed = applyEdit(bad, "cycleTL", "400");
    expect(buildSignRequest(DEPLOYMENTS, fixed)?.args).toBe(fixed.setPlanArgs);
  });

  it("kontrat adresi yoksa (NO_DEPLOYMENT) imza kapalıdır", () => {
    const conf = confFor(DRAFT, null);
    expect(conf.signable).toBe(false);
    expect(conf.blockers.some((b) => b.code === "NO_DEPLOYMENT")).toBe(true);
    expect(buildSignRequest(null, conf)).toBeNull();
  });
});

describe("/secim seçilen ajan → plan", () => {
  const sel = AgentsResponseSchema.parse(buildFixtureResponse("test"));
  const [pilot, demoA] = sel.result.screen.kept as [Candidate, Candidate];

  it("kayıtlı PİLOT'un kimliği eşitse adres ve kimlik dağıtımdan gelir, imza açık", () => {
    const c = agentPlanContext(pilot, "fixture", DEPLOYMENTS);
    expect(pilot.agentId).toBe("17");
    expect(c.deployments).toEqual({ pilotAgent: DEPLOYMENTS.pilotAgent, kuleReporter: DEPLOYMENTS.kuleReporter, agentId: "17" });
    expect(c.demoLock).toBe(false);
  });

  it("temsili aday zincirdeki PİLOT değilse sahte adresle kurulur ve imza kapanır", () => {
    const c = agentPlanContext(demoA, "fixture", DEPLOYMENTS);
    expect(c.deployments?.pilotAgent).toBe(demoA.agentWallet);
    expect(c.deployments?.agentId).toBe("18");
    expect(c.demoLock).toBe(true);
  });

  it("zincir kaynaklı (gerçek) aday kilitlenmez; plan.agent = adayın agentWallet'ı", () => {
    const c = agentPlanContext(demoA, "chain", DEPLOYMENTS);
    expect(c.demoLock).toBe(false);
    const conf = buildPlanConfirmation(DRAFT, { nowSec: NOW, deployments: c.deployments, current: null, currentActive: false });
    expect(conf.setPlanArgs?.[0].agent).toBe(demoA.agentWallet);
    expect(conf.setPlanArgs?.[0].agentId).toBe(18n);
  });

  it("dağıtım yoksa temsili aday kilitli, adres kurulmaz", () => {
    expect(agentPlanContext(pilot, "fixture", null)).toEqual({ deployments: null, demoLock: true });
  });
});

describe("/secim aday fixture'ı", () => {
  const r = AgentsResponseSchema.parse(buildFixtureResponse("Aylık 300 TL dolar")).result;

  it("PİLOT #17 kalır (2 kullanıcı, 95,00), Demo ajan A #18 kalır (1 kullanıcı, 80,00), Demo ajan B #19 elenir", () => {
    const [a, b] = r.screen.kept;
    expect([a!.agentId, a!.verifiedClients.length, scoreText(a!.score)]).toEqual(["17", 2, "95,00"]);
    expect([b!.agentId, b!.verifiedClients.length, scoreText(b!.score)]).toEqual(["18", 1, "80,00"]);
    expect(r.screen.eliminated).toHaveLength(1);
    expect(r.screen.eliminated[0]).toMatchObject({ agentId: "19", nameTr: "Demo ajan B", code: "TOO_FEW_FEEDBACK", demo: true });
  });

  it("hepsi DEMO, gerekçeler kural kaynaklı (LLM değil)", () => {
    expect([...r.screen.kept, ...r.screen.eliminated].every((c) => c.demo)).toBe(true);
    expect(r.ranking.source).toBe("rule");
  });
});

describe("/secim PlanSet okuma ve biçimler", () => {
  const user = addr(0xa1);
  const planHash = `0x${"ab".repeat(32)}` as Hex;
  const log = (eventName: "PlanSet" | "PendingCleared", who: Address, args: readonly unknown[], address = DEPLOYMENTS.flightPlan) => {
    const topics = encodeEventTopics({ abi: FLIGHT_PLAN_ABI, eventName, args: { user: who } as never });
    const data = eventName === "PlanSet" ? encodeAbiParameters([{ type: "bytes32" }, { type: "bool" }, { type: "uint64" }], args as never) : "0x";
    return { address, topics, data, blockNumber: 1n, transactionHash: planHash, transactionIndex: 0, blockHash: planHash, logIndex: 0, removed: false } as never;
  };

  it("PlanSet (anında) ve PendingCleared birlikte okunur", () => {
    const logs = [log("PendingCleared", user, []), log("PlanSet", user, [planHash, true, BigInt(NOW)])];
    expect(readPlanSet({ logs } as never, DEPLOYMENTS.flightPlan as Address, user)).toEqual({
      planHash,
      immediate: true,
      activeAt: NOW,
      pendingCleared: true,
    });
  });

  it("başka kullanıcının ya da başka kontratın olayı sayılmaz", () => {
    const logs = [log("PlanSet", addr(0xb2), [planHash, true, 1n]), log("PlanSet", user, [planHash, true, 1n], addr(0x99))];
    expect(readPlanSet({ logs } as never, DEPLOYMENTS.flightPlan as Address, user)).toBeNull();
  });

  it("24 saat bekleyen plan: immediate=false", () => {
    const out = readPlanSet({ logs: [log("PlanSet", user, [planHash, false, BigInt(NOW + 86400)])] } as never, DEPLOYMENTS.flightPlan as Address, user);
    expect(out).toMatchObject({ immediate: false, activeAt: NOW + 86400 });
  });

  it("kesinleşme süresi ondalıklı: 1400 ms → 1,4 (msToSec gibi tamsayıya kesmez)", () => {
    expect(finalitySeconds(1400)).toBe("1,4");
    expect(finalitySeconds(2000)).toBe("2");
  });

  it("saatler TR saatidir (UTC+3)", () => {
    // 2024-08-05 01:15 UTC → 04:15 TR
    expect(trDateTime(Date.UTC(2024, 7, 5, 1, 15) / 1000)).toBe("05.08.2024 04:15 (TR saati)");
  });
});
