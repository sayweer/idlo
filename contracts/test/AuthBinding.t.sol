// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DateTimeLib} from "solady/utils/DateTimeLib.sol";
import {FlightPlan} from "../src/FlightPlan.sol";
import {IFlightPlan} from "../src/interfaces/IFlightPlan.sol";

/// @notice AUTH-BIND: kontratın belgelenen özelliği — setPlan'i herkes kendi adresi için çağırabilir ve plana gerçek
///         KULE'yi, gerçek PİLOT adresini ve gerçek agentId'yi yazabilir (§8.2). Sonuçta zincirde Elif'in hiç
///         imzalamadığı bir plana dayanan, Elif'in sınırlarının çok üstünde, AUTHORIZED bir BuyAuthorized oluşur.
///         Bu bir kontrat hatası değil, belgelenen özelliktir: §9.2 adım 4 ("izin var mı, AUTHORIZED mı, kullanıcının
///         planı aktif mi") tek başına yetmez; kullanıcı bağı zincir dışında, KULE'de kurulur.
///         Burada yalnız kontrat tarafı gerçekler test edilir; bağın davranışı: packages/shared/test/authz.test.ts.
/// TODO(spec): §9.2 adım 4 kullanıcı bağı — KULE ayrıca actions(id).user == yapılandırılmış kullanıcı adresi
///             (PLAN_USER_ADDRESS), plans(user).kule == kendi KULE_REPORTER adresi ve plans(user).agent == token'ın
///             ajanı istemeli; değilse RET NO_AUTHORIZATION (packages/shared/authz.ts checkActionOwner).
contract AuthBindingTest is Test {
    FlightPlan internal fp;

    address internal elif = makeAddr("elif");
    address internal pilotAgent = makeAddr("pilot"); // gerçek PILOT_AGENT
    address internal kule = makeAddr("kule"); // gerçek KULE_REPORTER
    address internal attacker = makeAddr("attacker");
    address internal attackerAgent = makeAddr("attackerAgent");
    uint256 internal constant AGENT_ID = 7; // PİLOT'un ERC-8004 kimliği (herkese açık)
    uint64 internal constant PX = 41_500_000;
    bytes32 internal constant RH = keccak256("gerekce");
    uint64 internal constant BIG_TL = 40_000; // §10.5 "tüm TL"

    uint256 internal t0;

    event BuyAuthorized(
        uint256 indexed actionId,
        address indexed user,
        uint256 indexed agentId,
        uint64 amountTL,
        uint64 maxPxE6,
        uint8 ordType,
        uint64 openBy,
        bytes32 reasonHash
    );
    event BuyRejected(address indexed user, uint256 indexed agentId, uint64 amountTL, uint8 code, bytes32 reasonHash);

    function setUp() public {
        fp = new FlightPlan();
        t0 = DateTimeLib.dateTimeToTimestamp(2026, 10, 5, 12, 0, 0) - 3 hours; // TR 5 Ekim 12:00
        vm.warp(t0);

        // Elif'in imzaladığı plan: tek emir 5.000 TL, ay 20.000 TL.
        vm.prank(elif);
        fp.setPlan(_plan(20_000, 5_000, pilotAgent));
    }

    function _plan(uint64 cycleTL, uint64 maxOrderTL, address agent) internal view returns (IFlightPlan.Plan memory) {
        return IFlightPlan.Plan({
            cycleTL: cycleTL,
            maxOrderTL: maxOrderTL,
            startDay: 1,
            deadlineDay: 25,
            maxWaitH: 48,
            bandBps: 0,
            closedBandBps: 0,
            askMode: 1,
            expiresAt: uint64(t0 + 365 days),
            agent: agent,
            kule: kule,
            agentId: AGENT_ID
        });
    }

    /// @dev Zincir dışı KULE'nin §9.2 adım 4'ü harfiyen uygulaması: izin var, AUTHORIZED, kullanıcının planı aktif.
    function _literalStep4Passes(uint256 id) internal view returns (bool) {
        IFlightPlan.BuyAction memory a = fp.actions(id);
        return a.user != address(0) && a.state == uint8(IFlightPlan.ActionState.AUTHORIZED) && fp.isPlanActive(a.user);
    }

    function test_AUTH_BIND_foreignPlan_ownAgent_realKule_authorizedOnChain_userIsAttacker() public {
        // Karşılaştırma: Elif'in planında aynı tutar kod 3 ile düşer.
        vm.expectEmit(true, true, false, true, address(fp));
        emit BuyRejected(elif, AGENT_ID, BIG_TL, uint8(IFlightPlan.RejectCode.OVER_ORDER_LIMIT), RH);
        vm.prank(pilotAgent);
        assertEq(fp.requestBuy(elif, BIG_TL, PX, 0, RH, new bytes[](0)), 0);

        // (a) Saldırgan kendi adresine plan kurar: kendi ajan anahtarı, GERÇEK KULE, gerçek agentId, dev sınırlar.
        vm.prank(attacker);
        fp.setPlan(_plan(10_000_000, 1_000_000, attackerAgent));

        uint64 openBy = uint64(block.timestamp) + fp.OPEN_WINDOW();
        vm.expectEmit(true, true, true, true, address(fp));
        emit BuyAuthorized(1, attacker, AGENT_ID, BIG_TL, PX, 0, openBy, RH);
        vm.prank(attackerAgent);
        uint256 id = fp.requestBuy(attacker, BIG_TL, PX, 0, RH, new bytes[](0));
        assertEq(id, 1);

        // Zincir dışı KULE'nin gördüğü: olay agentId'si Elif'inkiyle aynı, plan.kule gerçek KULE.
        assertEq(fp.actions(id).user, attacker);
        assertEq(fp.actions(id).amountTL, BIG_TL);
        assertEq(fp.plans(attacker).kule, kule);
        assertEq(fp.plans(attacker).agentId, fp.plans(elif).agentId);
        assertTrue(_literalStep4Passes(id), "harfiyen adim 4 bu izni kabul eder");
        // Adım 1'in token→ajan bağı bunu yakalar (PILOT_TOKEN → pilotAgent ≠ attackerAgent); kullanıcı bağı da.
        assertTrue(fp.plans(attacker).agent != pilotAgent);

        // Gerçek KULE raporu bile kabul edilir: harcama saldırganın döngüsüne yazılır, Elif'in döngüsü hiç değişmez.
        vm.prank(kule);
        fp.reportExecution(id, "okx-1", BIG_TL, PX, uint8(IFlightPlan.ExecStatus.FILLED), keccak256("log"));
        assertEq(fp.cycles(attacker).spentTL, BIG_TL);
        assertEq(fp.cycles(elif).spentTL, 0);
    }

    function test_AUTH_BIND_foreignPlan_realPilotAgent_passesLiteralStep4_userIsAttacker() public {
        // (b) Saldırgan planına GERÇEK PİLOT adresini yazar. requestBuy'ı yalnız PİLOT anahtarı çağırabilir;
        //     §10.5 "ajan anahtarı çalındı" sahnesi tam bu varsayımdır.
        vm.prank(attacker);
        fp.setPlan(_plan(10_000_000, 1_000_000, pilotAgent));

        // Saldırgan kendi anahtarıyla çağıramaz.
        vm.prank(attacker);
        vm.expectRevert(IFlightPlan.NotAgent.selector);
        fp.requestBuy(attacker, BIG_TL, PX, 0, RH, new bytes[](0));

        uint64 openBy = uint64(block.timestamp) + fp.OPEN_WINDOW();
        vm.expectEmit(true, true, true, true, address(fp));
        emit BuyAuthorized(1, attacker, AGENT_ID, BIG_TL, PX, 1, openBy, RH);
        vm.prank(pilotAgent); // çalınmış PILOT_AGENT anahtarı
        uint256 id = fp.requestBuy(attacker, BIG_TL, PX, 1, RH, new bytes[](0));
        assertEq(id, 1);

        // Harfiyen §9.2: adım 1 (PILOT_TOKEN → pilotAgent == plans(attacker).agent) ve adım 4 geçer.
        assertEq(fp.plans(attacker).agent, pilotAgent);
        assertEq(fp.plans(attacker).kule, kule);
        assertTrue(_literalStep4Passes(id));
        // Yalnız kullanıcı bağı (actions(id).user == yapılandırılmış kullanıcı) bunu durdurur.
        assertEq(fp.actions(id).user, attacker);

        // Aynı çalınmış anahtar Elif'in planında yine sınıra takılır (§10.5'in iddiası yalnız bu yol için doğru).
        vm.prank(pilotAgent);
        assertEq(fp.requestBuy(elif, BIG_TL, PX, 1, RH, new bytes[](0)), 0);
    }

    function test_AUTH_BIND_elifsOwnAuthorization_userIsElif() public {
        vm.prank(pilotAgent);
        uint256 id = fp.requestBuy(elif, 5_000, PX, 0, RH, new bytes[](0));
        assertGt(id, 0);
        assertTrue(_literalStep4Passes(id));
        assertEq(fp.actions(id).user, elif);
        assertEq(fp.plans(elif).agent, pilotAgent);
        assertEq(fp.plans(elif).kule, kule);
    }
}
