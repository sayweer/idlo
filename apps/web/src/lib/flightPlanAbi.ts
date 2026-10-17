/**
 * Web'in kullandığı FlightPlan ABI'si (contracts/src/interfaces/IFlightPlan.sol, SPEC §8.1).
 * apps/pilot/src/clients/flightPlanAbi.ts yalnız PİLOT'un çağırdıklarını içerir; bu dosya Elif'in çağırdıklarını
 * (setPlan, commitPending, revoke, expireAction, closeCycle), tüm view'ları ve olayları ekler.
 * UI asla requestBuy ya da reportExecution çağırmaz: bilerek ABI'de YOK.
 * TODO(spec): arayüz değişirse bu dosya elle güncellenir (forge çıktısından üretim betiği yok; bun betiği kaldırıldı).
 */
import { parseAbi } from "viem";

export const FLIGHT_PLAN_ABI = parseAbi([
  "struct Plan { uint64 cycleTL; uint64 maxOrderTL; uint8 startDay; uint8 deadlineDay; uint16 maxWaitH; uint16 bandBps; uint16 closedBandBps; uint8 askMode; uint64 expiresAt; address agent; address kule; uint256 agentId; }",
  "struct Cycle { uint32 id; uint64 spentTL; uint64 reservedTL; bool closed; }",
  "struct BuyAction { address user; uint64 amountTL; uint64 maxPxE6; uint8 ordType; uint64 openBy; uint64 reportBy; uint32 cycleId; uint8 state; }",
  // Elif'in yazdıkları
  "function setPlan(Plan p)",
  "function commitPending(address user)",
  "function revoke()",
  "function expireAction(uint256 actionId)",
  "function closeCycle(address user)",
  // view'lar
  "function currentCycleId() view returns (uint32)",
  "function trDay() view returns (uint8)",
  "function plans(address user) view returns (Plan)",
  "function pending(address user) view returns (Plan plan, uint64 activeAt)",
  "function cycles(address user) view returns (Cycle)",
  "function cycleOf(address user, uint32 cycleId) view returns (Cycle)",
  "function actions(uint256 actionId) view returns (BuyAction)",
  "function isPlanActive(address user) view returns (bool)",
  // olaylar (user ile filtrelenir)
  "event PlanSet(address indexed user, bytes32 planHash, bool immediate, uint64 activeAt)",
  "event PlanRevoked(address indexed user)",
  "event PendingCleared(address indexed user)",
  "event BuyAuthorized(uint256 indexed actionId, address indexed user, uint256 indexed agentId, uint64 amountTL, uint64 maxPxE6, uint8 ordType, uint64 openBy, bytes32 reasonHash)",
  "event BuyRejected(address indexed user, uint256 indexed agentId, uint64 amountTL, uint8 code, bytes32 reasonHash)",
  "event BuyExecuted(uint256 indexed actionId, address indexed user, string ordId, uint64 filledTL, uint64 avgPxE6, uint8 status, bytes32 reportHash)",
  "event CycleClosed(address indexed user, uint32 cycleId, uint64 spentTL, bool ok)",
  // özel hatalar (decodeErrorResult ile çözülüp Türkçe gösterilir: strings `err.<Ad>`)
  "error NotAgent()",
  "error NotKule()",
  "error OverFilled()",
  "error ActionNotAuthorized()",
  "error ReportWindowClosed()",
  "error ReportWindowOpen()",
  "error InvalidPlan()",
  "error NoPlan()",
  "error NoPendingPlan()",
  "error PendingNotReady()",
  "error CycleNotOver()",
  "error CycleAlreadyClosed()",
  "error InvalidStatus()",
  "error ValueNotAccepted()",
]);
