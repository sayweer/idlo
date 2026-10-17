/**
 * PİLOT'un kullandığı FlightPlan ABI parçası (contracts/src/interfaces/IFlightPlan.sol, §8.1).
 * Yalnız okuma fonksiyonları, requestBuy ve izin olayları. PİLOT'un reportExecution / setPlan / revoke çağırması
 * gerekmez; ABI'ye bilerek eklenmedi. test/tools.clients.test.ts imzaları derlenmiş IFlightPlan.json ile karşılaştırır.
 */
import { parseAbi } from "viem";

export const FLIGHT_PLAN_ABI = parseAbi([
  "struct Plan { uint64 cycleTL; uint64 maxOrderTL; uint8 startDay; uint8 deadlineDay; uint16 maxWaitH; uint16 bandBps; uint16 closedBandBps; uint8 askMode; uint64 expiresAt; address agent; address kule; uint256 agentId; }",
  "struct Cycle { uint32 id; uint64 spentTL; uint64 reservedTL; bool closed; }",
  "struct BuyAction { address user; uint64 amountTL; uint64 maxPxE6; uint8 ordType; uint64 openBy; uint64 reportBy; uint32 cycleId; uint8 state; }",
  "function plans(address user) view returns (Plan)",
  "function cycles(address user) view returns (Cycle)",
  "function actions(uint256 actionId) view returns (BuyAction)",
  "function isPlanActive(address user) view returns (bool)",
  "function requestBuy(address user, uint64 amountTL, uint64 maxPxE6, uint8 ordType, bytes32 reasonHash, bytes[] pythUpdate) payable returns (uint256 actionId)",
  "event BuyAuthorized(uint256 indexed actionId, address indexed user, uint256 indexed agentId, uint64 amountTL, uint64 maxPxE6, uint8 ordType, uint64 openBy, bytes32 reasonHash)",
  "event BuyRejected(address indexed user, uint256 indexed agentId, uint64 amountTL, uint8 code, bytes32 reasonHash)",
  "error NotAgent()",
  "error ValueNotAccepted()",
]);
