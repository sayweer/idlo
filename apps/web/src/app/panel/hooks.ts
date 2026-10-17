import { useEffect, useMemo, useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Address, Log } from "viem";
import type { BuyAction, Cycle, Plan } from "@pilot/shared";
import {
  createChainReads,
  deploymentsOf,
  kuleStatus,
  pilotFeed,
  useDeployments,
  type KuleStatus,
  type KuleStatusSource,
  type PilotFeed,
  type PilotFeedSource,
  type PlanEvent,
} from "../../lib/data";
import { FLIGHT_PLAN_ABI } from "../../lib/flightPlanAbi";
import { publicClient } from "../../lib/fuji";
import { buildAuthRows, eventFromLog, mergeEvents, type AuthRow } from "./chainEvents";
import { DEMO_USER, createSeededKuleStatus, createSeededPilotFeed } from "./seed";

/** Mock adaptörler tohumlu (TEMSİLİ VERİ) sürümle değiştirilir; `http` iken gerçek adaptör kullanılır. */
export const pilotSource: PilotFeedSource = pilotFeed.origin === "mock" ? createSeededPilotFeed() : pilotFeed;
export const kuleSource: KuleStatusSource = kuleStatus.origin === "mock" ? createSeededKuleStatus() : kuleStatus;

/** Besleme yaşı eşiği: 10 dk'dan eski zarf "veri bayat" (UI_HANDOFF §2.3, TODO(spec): eşik SPEC'te yok). */
export const STALE_MS = 10 * 60_000;

/** Duvar saati, `intervalMs` aralıkla tazelenir. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Fail-closed yükleme durumu: hata ya da bekleme "bilinmiyor"dur, eski veri gösterilmez. */
export type Loaded<T> =
  | { status: "idle" } // koşul sağlanmadı (ör. cüzdan yok)
  | { status: "loading" }
  | { status: "error" }
  | { status: "ok"; data: T; receivedAt: number };

export function usePilotFeed(user: Address | undefined): Loaded<PilotFeed> {
  const enabled = pilotSource.origin === "mock" || !!user;
  const q = useQuery({
    queryKey: ["panel-pilot-feed", pilotSource.origin, user ?? "demo"],
    queryFn: () => pilotSource.read(user ?? DEMO_USER),
    enabled,
    refetchInterval: 5_000,
    retry: false,
    staleTime: 0,
  });
  if (!enabled) return { status: "idle" };
  if (q.isError) return { status: "error" };
  if (q.data === undefined) return { status: "loading" };
  return { status: "ok", data: q.data, receivedAt: q.dataUpdatedAt };
}

export function useKuleStatus(): Loaded<KuleStatus> {
  const q = useQuery({
    queryKey: ["panel-kule-status", kuleSource.origin],
    queryFn: () => kuleSource.read(),
    refetchInterval: 3_000,
    retry: false,
    staleTime: 0,
  });
  if (q.isError) return { status: "error" };
  if (q.data === undefined) return { status: "loading" };
  return { status: "ok", data: q.data, receivedAt: q.dataUpdatedAt };
}

export type ChainGate = "loading" | "nodeploy" | "baddeploy" | "nowallet" | "ready";

export interface PlanState {
  status: "loading" | "error" | "ok";
  plan: Plan | null;
  active: boolean;
  cycle: Cycle | null;
}

export interface ChainView {
  gate: ChainGate;
  plan: PlanState;
  history: { status: "loading" | "error" | "ok"; events: PlanEvent[] };
  authRows: AuthRow[];
  /** Blok zamanı (unix sn); henüz okunmadıysa undefined. */
  blockTime: (bn: bigint) => number | undefined;
}

const LIST_LIMIT = 40; // blok zamanı okunacak en yeni olay sayısı
const ACTION_LIMIT = 8; // actions(id) okunacak açık izin sayısı

/**
 * Zincir tarafı: plan + döngü, olay geçmişi (deployBlock'tan parçalı getLogs) ve canlı izleme (watchContractEvent),
 * hepsi `user` ile süzülür. Kontrat adresi yoksa ya da cüzdan bağlı değilse okuma yapılmaz.
 */
export function useChain(user: Address | undefined, nowSec: number): ChainView {
  const state = useDeployments();
  const dep = deploymentsOf(state);
  const reads = useMemo(() => (dep ? createChainReads(dep) : null), [dep]);
  const qc = useQueryClient();
  const enabled = !!reads && !!user;
  const flightPlan = dep?.flightPlan;

  const planQ = useQuery({
    queryKey: ["panel-plan", flightPlan, user],
    queryFn: async () => {
      const [p, cycle] = await Promise.all([reads!.readPlan(user!), reads!.readCycle(user!)]);
      return { plan: p.plan, active: p.active, cycle };
    },
    enabled,
    refetchInterval: 15_000,
    retry: false,
  });

  const histQ = useQuery({
    queryKey: ["panel-history", flightPlan, user],
    queryFn: () => reads!.readHistory(user!),
    enabled,
    staleTime: Infinity,
    retry: false,
  });

  // canlı izleme: yeni günlük gelince listeye eklenir, plan/döngü tazelenir
  const [live, setLive] = useState<PlanEvent[]>([]);
  useEffect(() => {
    setLive([]);
    if (!flightPlan || !user) return;
    return publicClient.watchContractEvent({
      address: flightPlan as Address,
      abi: FLIGHT_PLAN_ABI,
      strict: true,
      pollingInterval: 4_000,
      onLogs: (logs) => {
        const ev = logs.map((l) => eventFromLog(l as unknown as Log, user)).filter((e): e is PlanEvent => e !== null);
        if (ev.length === 0) return;
        setLive((prev) => mergeEvents(prev, ev));
        void qc.invalidateQueries({ queryKey: ["panel-plan", flightPlan, user] });
      },
      onError: () => {}, // izleme düşerse geçmiş listesi ve 15 sn'lik plan okuması sürer
    });
  }, [flightPlan, user, qc]);

  const events = useMemo(() => mergeEvents(histQ.data ?? [], live), [histQ.data, live]);

  const blocks = useMemo(() => [...new Set(events.slice(0, LIST_LIMIT).map((e) => e.blockNumber))], [events]);
  const blockQs = useQueries({
    queries: blocks.map((bn) => ({
      queryKey: ["panel-block-ts", String(bn)],
      queryFn: async () => Number((await publicClient.getBlock({ blockNumber: bn })).timestamp),
      staleTime: Infinity,
      retry: 1,
    })),
  });
  const times = useMemo(() => {
    const m = new Map<bigint, number>();
    blocks.forEach((bn, i) => {
      const d = blockQs[i]?.data;
      if (typeof d === "number") m.set(bn, d);
    });
    return m;
  }, [blocks, blockQs]);

  // rapor süresi geçen izin: BuyExecuted gelmeden reportBy dolduysa actions(id) EXPIRED olur (olay yaymaz)
  const openIds = useMemo(() => {
    const done = new Set<string>();
    for (const e of events) if (e.kind === "BuyExecuted") done.add(e.actionId);
    const ids: string[] = [];
    for (const e of events) if (e.kind === "BuyAuthorized" && !done.has(e.actionId)) ids.push(e.actionId);
    return ids.slice(0, ACTION_LIMIT);
  }, [events]);
  const actionQs = useQueries({
    queries: openIds.map((id) => ({
      queryKey: ["panel-action", flightPlan, id],
      queryFn: () => reads!.readAction(id),
      enabled: !!reads,
      refetchInterval: 30_000,
      retry: false,
    })),
  });
  const actions = useMemo(() => {
    const m = new Map<string, BuyAction | null>();
    openIds.forEach((id, i) => {
      const d = actionQs[i]?.data;
      if (d !== undefined) m.set(id, d);
    });
    return m;
  }, [openIds, actionQs]);
  const authRows = useMemo(() => buildAuthRows(events, actions, nowSec), [events, actions, nowSec]);

  const gate: ChainGate =
    state.status === "loading" ? "loading" : state.status === "none" ? "nodeploy" : state.status === "invalid" ? "baddeploy" : !user ? "nowallet" : "ready";

  const plan: PlanState =
    !enabled || planQ.isPending
      ? { status: "loading", plan: null, active: false, cycle: null }
      : planQ.isError
        ? { status: "error", plan: null, active: false, cycle: null }
        : { status: "ok", ...planQ.data };
  const history = {
    status: (!enabled || histQ.isPending ? "loading" : histQ.isError ? "error" : "ok") as "loading" | "error" | "ok",
    events,
  };
  return { gate, plan, history, authRows, blockTime: (bn) => times.get(bn) };
}
