// Veri bağdaştırıcıları: ekranlar zincire, PİLOT'a ve KULE'ye yalnız buradan erişir.
export { deploymentsOf, loadDeployments, useDeployments, type DeploymentState } from "./deployments";
export { createChainReads, useChainReads, type ChainReads, type PlanEvent } from "./chain";
export {
  createHttpPilotFeed,
  createMockPilotFeed,
  pilotFeed,
  PilotFeedSchema,
  type PilotAnswer,
  type PilotFeed,
  type PilotFeedSource,
} from "./pilotFeed";
export { createHttpKuleStatus, createMockKuleStatus, kuleStatus, type KuleStatus, type KuleStatusSource } from "./kuleStatus";
export { feedMode, isMockFeed } from "./mode";
