/** Parçaları bağlar: yapılandırma → ATK, zincir, durum deposu, sağlık, CAA, yürütücü, MCP sunucusu. */
import type { Server as HttpServer } from "node:http";
import { AtkExchange } from "./atkExchange.js";
import { TokenRegistry } from "./auth.js";
import { CaaClient, CaaLoop, type CaaState } from "./caa.js";
import { ViemKuleChain, type KuleChain } from "./chain.js";
import type { KuleConfig } from "./config.js";
import type { Exchange } from "./exchange.js";
import { Executor, type Tuning } from "./executor.js";
import { HealthMonitor, HeartbeatBook } from "./health.js";
import { InstrumentCache } from "./instruments.js";
import { JsonlLogger, type Logger } from "./logger.js";
import { createKuleHttpServer, listen } from "./server.js";
import { KuleService } from "./service.js";
import { ActionStore } from "./store.js";
import { realSleep, systemClock, type Clock, type Sleep } from "./util.js";

export interface AppOverrides {
  exchange?: Exchange;
  chain?: KuleChain;
  clock?: Clock;
  sleep?: Sleep;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  tuning?: Partial<Tuning>;
  caaClient?: Pick<CaaClient, "set">;
  /** Test: 0 = rastgele port. */
  port?: number;
}

export interface KuleApp {
  http: HttpServer;
  executor: Executor;
  health: HealthMonitor;
  heartbeats: HeartbeatBook;
  store: ActionStore;
  caa: CaaLoop | null;
  /** Dinlemeye başlar, CAA ve mutabakat döngülerini açar; gerçek portu döndürür. */
  start(): Promise<number>;
  /**
   * Yeni çağrıları keser, süren kule_execute'ları bekler, KULE'nin açık emirlerini iptal eder. Yalnız hiçbir emir
   * canlı/belirsiz kalmadıysa CAA {"timeOut":"0"} gönderir; aksi halde 60 sn'lik geri sayım emri iptal etsin diye açık bırakılır.
   */
  stop(): Promise<void>;
}

export async function createApp(cfg: KuleConfig, o: AppOverrides = {}): Promise<KuleApp> {
  const clock = o.clock ?? systemClock;
  const sleep = o.sleep ?? realSleep;
  const logger = o.logger ?? new JsonlLogger(cfg.logDir, clock, cfg.mode);
  const exchange = o.exchange ?? (await AtkExchange.spawn(cfg.okxProfile));
  const chain =
    o.chain ??
    new ViemKuleChain({
      rpcUrl: cfg.rpcUrl,
      deployments: cfg.deployments,
      account: ViemKuleChain.account(cfg.reporterKey),
      planUser: cfg.planUser,
    });
  const store = new ActionStore(cfg.actionsPath);
  const instruments = new InstrumentCache(clock, o.fetchImpl);
  const registry = new TokenRegistry(cfg.tokens);
  const heartbeats = new HeartbeatBook(clock, registry.agentLabels());

  let health!: HealthMonitor;
  let caa: CaaLoop | null = null;
  if (cfg.exec === "okx" && (cfg.okx || o.caaClient)) {
    const client =
      o.caaClient ?? new CaaClient({ creds: cfg.okx!, demo: cfg.demo, clock, ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}) });
    caa = new CaaLoop({ client, clock, logger, isNormal: () => health.isNormalForCaa() });
  }
  const caaState: CaaState | null = caa;
  health = new HealthMonitor({ clock, exchange, chain, store, heartbeats, planUser: cfg.planUser, caa: caaState });

  const executor = new Executor({
    planUser: cfg.planUser,
    kuleReporter: cfg.reporter,
    paper: cfg.exec === "paper",
    mode: cfg.mode,
    clock,
    sleep,
    chain,
    exchange,
    instruments,
    store,
    health,
    logger,
    ...(o.tuning ? { tuning: o.tuning } : {}),
  });
  const service = new KuleService({ executor, health, exchange, instruments, clock, heartbeats, mode: cfg.mode, caa: caaState });
  const http = createKuleHttpServer({ registry, service, logger });

  return {
    http,
    executor,
    health,
    heartbeats,
    store,
    caa,
    async start() {
      const port = await listen(http, o.port ?? cfg.port);
      void executor.reconcile(); // yeniden başlatma mutabakatı; bu sırada ORDER_UNCERTAIN yeni emri engeller
      executor.startReconcileLoop();
      caa?.start();
      logger.log({ tool: "kule", event: "started", port, exec: cfg.exec });
      return port;
    },
    async stop() {
      executor.stopReconcileLoop();
      const closed = new Promise<void>((r) => http.close(() => r())); // yeni bağlantı alınmaz; süren istekler sürer
      const sd = await executor.shutdown().catch((e: unknown) => {
        logger.log({ tool: "kule", event: "shutdown_error", error: e instanceof Error ? e.message : String(e) });
        return { safe: false, canceled: [] as string[], reasons: ["shutdown_error"] };
      });
      await caa?.stop({ disarm: sd.safe });
      http.closeAllConnections?.();
      await closed;
      await exchange.close();
      logger.log({ tool: "kule", event: "stopped" });
    },
  };
}
