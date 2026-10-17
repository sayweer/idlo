/**
 * Kayıt oynatma simülasyonu (CLAUDE.md: `REPLAY=data/replays/<gün>.json pnpm --filter pilot dev`).
 * Simüle saat her 5 dk mum kapanışından 5 sn sonra ilerler (§10.1); zincir FakeChain, KULE FakeKule (kâğıt).
 * AĞ YOK: hiçbir işlem yayınlanmaz, borsaya emir gitmez; anahtar kullanılmaz. Kayıtlar "KAYIT OYNATMA" ve "KÂĞIT"
 * etiketi taşır (CLAUDE.md kural 12).
 *
 * TODO(spec): SPEC kayıt oynatmada hangi planın kullanılacağını yazmıyor. En dar seçim: Elif'in §15 örnek planı
 * (20.000 TL, emir başına 10.000, sor, 72 sa) ve pencere kayıt gününde açılır, 5 gün sürer (§15: 1–5 arası).
 */
import type { Address } from "viem";
import {
  DEMO_LABELS,
  MIN5_MS,
  PLAN_DAY_MAX,
  PLAN_DEFAULTS,
  daysToSec,
  floorToTick,
  msToSec,
  pxToPxE6,
  runReplay,
  type Cycle,
  type Plan,
  type Replay,
  type Weather,
} from "@pilot/shared";
import { FakeChain, FakeKule, ManualClock, type ChainClient, type KuleClient } from "../clients/index.js";
import { PilotTools, replayWeatherSource, type CalendarSource, type NewsSource } from "../tools/index.js";
import type { TraceRecord, TraceStore } from "../trace/index.js";
import type { LlmClient } from "./llm.js";
import { PilotLoop } from "./loop.js";

/** Mum kapanışından sonra tur gecikmesi (§10.1: 5 sn). */
export const TICK_OFFSET_MS = 5_000;

/** Simülasyonun sahte adresleri (gerçek hesap değildir; anahtarları yoktur). */
export const REPLAY_ADDRESSES = {
  agent: "0x00000000000000000000000000000000000a6e47",
  user: "0x00000000000000000000000000000000000e11f0",
  kule: "0x000000000000000000000000000000000000c0be",
} as const satisfies Record<string, Address>;
const REPLAY_TOKEN = "replay-pilot-token-0000";

export const REPLAY_LABEL = (day: string) => `KAYIT OYNATMA ${day}`;

/** Kayıt gününde açılan 5 günlük pencere ile Elif'in §15 planı. */
export function replayPlan(replay: Pick<Replay, "day" | "simTo">): Plan {
  const day = Number(replay.day.slice(8, 10));
  const startDay = Math.min(day, PLAN_DAY_MAX);
  return {
    cycleTL: 20_000,
    maxOrderTL: 10_000,
    startDay,
    deadlineDay: Math.min(startDay + 4, PLAN_DAY_MAX),
    maxWaitH: PLAN_DEFAULTS.maxWaitH,
    bandBps: PLAN_DEFAULTS.bandBps,
    closedBandBps: PLAN_DEFAULTS.closedBandBps,
    askMode: 1,
    expiresAt: msToSec(replay.simTo) + daysToSec(PLAN_DEFAULTS.expiresInDays),
    agent: REPLAY_ADDRESSES.agent,
    kule: REPLAY_ADDRESSES.kule,
    agentId: "0",
  };
}

export interface ReplaySimOptions {
  replay: Replay;
  llm: LlmClient | null;
  store: TraceStore;
  /** Ek etiketler (ör. enjeksiyon demosu). */
  labels?: readonly string[];
  plan?: Partial<Plan>;
  news?: NewsSource;
  calendar?: CalendarSource;
  /** Hata enjeksiyonu (test): zincir ya da KULE istemcisini sarar. Korumalar yine araç katmanındadır. */
  wrapChain?: (c: ChainClient) => ChainClient;
  wrapKule?: (k: KuleClient) => KuleClient;
  log?: (line: string) => void;
}

export interface ReplaySim {
  clock: ManualClock;
  chain: FakeChain;
  kule: FakeKule;
  tools: PilotTools;
  loop: PilotLoop;
  plan: Plan;
  /** Simüle saatin her 5 dk kapanışındaki hava (§11.2). */
  series: Weather[];
  /** Saati `w.ts + 5 sn`'ye alır, sahte tahtayı mum kapanışına çeker, kalp atışı ve onTick. */
  tick(w: Weather): Promise<TraceRecord | null>;
}

export interface ReplaySimResult extends ReplaySim {
  records: TraceRecord[];
  cycle: Cycle;
}

/** Simülasyon dünyasını kurar (henüz tur yok). */
export async function createReplaySim(o: ReplaySimOptions): Promise<ReplaySim> {
  const series = runReplay(o.replay);
  const closeByOpenTs = new Map(o.replay.usdt5m.map((c) => [c.ts, c.c]));
  const { agent, user, kule: kuleAddr } = REPLAY_ADDRESSES;
  const plan = { ...replayPlan(o.replay), ...o.plan };

  const clock = new ManualClock(o.replay.simFrom + TICK_OFFSET_MS);
  const chain = new FakeChain(clock);
  chain.setPlan(user, plan);
  const kule = new FakeKule({ chain, clock, planUser: user, kuleReporter: kuleAddr, tokens: { [REPLAY_TOKEN]: agent } });
  const kuleClient = o.wrapKule ? o.wrapKule(kule.clientFor(REPLAY_TOKEN)) : kule.clientFor(REPLAY_TOKEN);
  const chainClient = chain.clientFor(agent, user);
  const weather = replayWeatherSource(series);
  const tools = new PilotTools({
    chain: o.wrapChain ? o.wrapChain(chainClient) : chainClient,
    kule: kuleClient,
    weather,
    clock,
    ...(o.news ? { news: o.news } : {}),
    ...(o.calendar ? { calendar: o.calendar } : {}),
  });
  const loop = await PilotLoop.create({
    tools,
    llm: o.llm,
    store: o.store,
    clock,
    weather,
    kule: kuleClient,
    user,
    labels: [REPLAY_LABEL(o.replay.day), DEMO_LABELS.paperExec, ...(o.labels ?? [])],
    ...(o.log ? { log: o.log } : {}),
  });

  const tick = async (w: Weather): Promise<TraceRecord | null> => {
    clock.set(w.ts + TICK_OFFSET_MS);
    // Sahte tahta mumun kapanışını izler: alış = kapanış, satış = bir adım yukarı (makas ~3 bp).
    const c = closeByOpenTs.get(w.ts - MIN5_MS);
    if (c !== undefined) {
      const bid = floorToTick(c, kule.market.tickSz);
      kule.market = { ...kule.market, bestBidE6: bid, bestAskE6: bid + pxToPxE6(kule.market.tickSz), ageSec: 1 };
    }
    await loop.heartbeat();
    return loop.onTick();
  };
  return { clock, chain, kule, tools, loop, plan, series, tick };
}

/** Kaydı baştan sona oynatır. */
export async function runReplaySim(o: ReplaySimOptions): Promise<ReplaySimResult> {
  const sim = await createReplaySim(o);
  const records: TraceRecord[] = [];
  for (const w of sim.series) {
    const r = await sim.tick(w);
    if (r) records.push(r);
  }
  return { ...sim, records, cycle: sim.chain.cycleOfNow(REPLAY_ADDRESSES.user) };
}
