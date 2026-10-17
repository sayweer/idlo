/**
 * scripts/stolen-key.ts ve scripts/mutabakat.ts'in kullandığı FlightPlan ABI parçası
 * (contracts/src/interfaces/IFlightPlan.sol, §8.1). Yalnız okuma fonksiyonları, requestBuy ve izin olayları.
 * setPlan / reportExecution / revoke bilerek yok: bu betikler plan kurmaz ve rapor yazmaz.
 * test/mutabakat.abi.test.ts imzaları derlenmiş IFlightPlan.json ve FlightPlan.json ile karşılaştırır.
 */
import { parseAbi } from "viem";

export const FLIGHT_PLAN_SCRIPT_ABI = parseAbi([
  "struct Plan { uint64 cycleTL; uint64 maxOrderTL; uint8 startDay; uint8 deadlineDay; uint16 maxWaitH; uint16 bandBps; uint16 closedBandBps; uint8 askMode; uint64 expiresAt; address agent; address kule; uint256 agentId; }",
  "struct BuyAction { address user; uint64 amountTL; uint64 maxPxE6; uint8 ordType; uint64 openBy; uint64 reportBy; uint32 cycleId; uint8 state; }",
  "function plans(address user) view returns (Plan)",
  "function actions(uint256 actionId) view returns (BuyAction)",
  "function isPlanActive(address user) view returns (bool)",
  "function trDay() view returns (uint8)",
  "function lastActionId() view returns (uint256)",
  "function requestBuy(address user, uint64 amountTL, uint64 maxPxE6, uint8 ordType, bytes32 reasonHash, bytes[] pythUpdate) payable returns (uint256 actionId)",
  "event BuyAuthorized(uint256 indexed actionId, address indexed user, uint256 indexed agentId, uint64 amountTL, uint64 maxPxE6, uint8 ordType, uint64 openBy, bytes32 reasonHash)",
  "event BuyRejected(address indexed user, uint256 indexed agentId, uint64 amountTL, uint8 code, bytes32 reasonHash)",
  "event BuyExecuted(uint256 indexed actionId, address indexed user, string ordId, uint64 filledTL, uint64 avgPxE6, uint8 status, bytes32 reportHash)",
  "error NotAgent()",
  "error ValueNotAccepted()",
]);
