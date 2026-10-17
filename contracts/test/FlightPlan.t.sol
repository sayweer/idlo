// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DateTimeLib} from "solady/utils/DateTimeLib.sol";
import {FlightPlan} from "../src/FlightPlan.sol";
import {IFlightPlan} from "../src/interfaces/IFlightPlan.sol";

/// @notice SPEC §18 F-1…F-10, F-12…F-15 (A1). Test adları §18 kimliğiyle başlar (test_F<n>_…).
contract FlightPlanTest is Test {
    FlightPlan internal fp;

    address internal user = makeAddr("elif");
    address internal agent = makeAddr("pilot");
    address internal kule = makeAddr("kule");
    address internal stranger = makeAddr("stranger");
    uint256 internal constant AGENT_ID = 7;
    uint64 internal constant PX = 41_500_000; // 41,50 TL (pxE6)
    bytes32 internal constant RH = keccak256("gerekce");

    uint256 internal t0;

    // Olaylar (expectEmit için)
    event PlanSet(address indexed user, bytes32 planHash, bool immediate, uint64 activeAt);
    event PlanRevoked(address indexed user);
    event PendingCleared(address indexed user);
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
    event BuyExecuted(
        uint256 indexed actionId,
        address indexed user,
        string ordId,
        uint64 filledTL,
        uint64 avgPxE6,
        uint8 status,
        bytes32 reportHash
    );
    event CycleClosed(address indexed user, uint32 cycleId, uint64 spentTL, bool ok);

    function setUp() public {
        fp = new FlightPlan();
        t0 = _tr(2026, 10, 5, 12, 0); // 5 Ekim 2026 12:00 TR
        vm.warp(t0);
    }

    // ─────────────────────────────── Yardımcılar ───────────────────────────────

    /// @dev TR saatiyle (UTC+3) tarih → unix sn.
    function _tr(uint256 y, uint256 m, uint256 d, uint256 h, uint256 mi) internal pure returns (uint256) {
        return DateTimeLib.dateTimeToTimestamp(y, m, d, h, mi, 0) - 3 hours;
    }

    function _plan() internal view returns (IFlightPlan.Plan memory) {
        return IFlightPlan.Plan({
            cycleTL: 20_000,
            maxOrderTL: 5_000,
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

    function _set(IFlightPlan.Plan memory p) internal {
        vm.prank(user);
        fp.setPlan(p);
    }

    function _buy(uint64 amountTL) internal returns (uint256) {
        return _buyAs(agent, amountTL, 0);
    }

    function _buyAs(address caller, uint64 amountTL, uint8 ordType) internal returns (uint256) {
        vm.prank(caller);
        return fp.requestBuy(user, amountTL, PX, ordType, RH, new bytes[](0));
    }

    function _report(uint256 id, uint64 filledTL) internal {
        vm.prank(kule);
        fp.reportExecution(id, "ord-1", filledTL, PX, 0, keccak256("rapor"));
    }

    function _hash(IFlightPlan.Plan memory p) internal pure returns (bytes32) {
        return keccak256(abi.encode(p));
    }

    function _eq(IFlightPlan.Plan memory a, IFlightPlan.Plan memory b) internal pure returns (bool) {
        return _hash(a) == _hash(b);
    }

    function _activeAt() internal view returns (uint64 at) {
        (, at) = fp.pending(user);
    }

    function _expectRejected(uint64 amountTL, IFlightPlan.RejectCode code) internal {
        vm.expectEmit(true, true, false, true, address(fp));
        emit BuyRejected(user, AGENT_ID, amountTL, uint8(code), RH);
    }

    // ─────────────────────────────── F-1 ───────────────────────────────

    function test_F1_ilkPlanHemenEtkin() public {
        IFlightPlan.Plan memory p = _plan();
        vm.expectEmit(true, false, false, true, address(fp));
        emit PlanSet(user, _hash(p), true, uint64(block.timestamp));
        _set(p);

        assertTrue(_eq(fp.plans(user), p));
        assertTrue(fp.isPlanActive(user));
        assertEq(_activeAt(), 0);
        assertGt(_buy(1_000), 0);
    }

    function test_F1_gecersizPlanReddedilir() public {
        IFlightPlan.Plan[] memory bad = new IFlightPlan.Plan[](10);
        for (uint256 i; i < bad.length; ++i) {
            bad[i] = _plan();
        }
        bad[0].cycleTL = 0;
        bad[1].maxOrderTL = 0;
        bad[2].maxOrderTL = 20_001; // > cycleTL
        bad[3].startDay = 0;
        bad[4].startDay = 26; // > deadlineDay
        bad[5].deadlineDay = 29;
        bad[6].askMode = 2;
        bad[7].expiresAt = uint64(block.timestamp);
        bad[8].agent = address(0);
        bad[9].kule = address(0);
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(user);
            vm.expectRevert(IFlightPlan.InvalidPlan.selector);
            fp.setPlan(bad[i]);
        }
        assertFalse(fp.isPlanActive(user));
    }

    // ─────────────────────────────── F-2 ───────────────────────────────

    function test_F2_sikiDegisiklikHemenEtkin() public {
        _set(_plan());
        IFlightPlan.Plan memory p = _plan();
        p.cycleTL = 15_000;
        p.maxOrderTL = 4_000;
        p.maxWaitH = 24;
        p.expiresAt = uint64(t0 + 30 days);
        p.startDay = 3;
        p.bandBps = 300; // 0 → >0 sıkılaşma
        p.closedBandBps = 500;

        vm.expectEmit(true, false, false, true, address(fp));
        emit PlanSet(user, _hash(p), true, uint64(block.timestamp));
        _set(p);
        assertTrue(_eq(fp.plans(user), p));
        assertEq(_activeAt(), 0);

        // İkisi de > 0 iken daha dar bant da hemen etkin.
        p.bandBps = 200;
        _set(p);
        assertEq(fp.plans(user).bandBps, 200);
    }

    function test_F2_ayniPlanHemenEtkin() public {
        _set(_plan());
        _set(_plan());
        assertEq(_activeAt(), 0);
        assertTrue(_eq(fp.plans(user), _plan()));
    }

    function test_F2_askModeArtisiSikidir() public {
        IFlightPlan.Plan memory p = _plan();
        p.askMode = 0;
        _set(p);
        p.askMode = 1;
        _set(p);
        assertEq(fp.plans(user).askMode, 1);
        assertEq(_activeAt(), 0);
    }

    // ─────────────────────────────── F-3 ───────────────────────────────

    function test_F3_gevsekDegisiklik24SaatBekler() public {
        _set(_plan());
        IFlightPlan.Plan memory loose = _plan();
        loose.maxOrderTL = 8_000;

        uint64 expectedAt = uint64(block.timestamp + 24 hours);
        vm.expectEmit(true, false, false, true, address(fp));
        emit PlanSet(user, _hash(loose), false, expectedAt);
        _set(loose);

        (IFlightPlan.Plan memory pend, uint64 at) = fp.pending(user);
        assertEq(at, expectedAt);
        assertTrue(_eq(pend, loose));
        assertTrue(_eq(fp.plans(user), _plan())); // eski plan geçerli

        // commitPending öncesi eski tavan uygulanır.
        _expectRejected(6_000, IFlightPlan.RejectCode.OVER_ORDER_LIMIT);
        assertEq(_buy(6_000), 0);

        vm.warp(expectedAt - 1);
        vm.expectRevert(IFlightPlan.PendingNotReady.selector);
        fp.commitPending(user);

        vm.warp(expectedAt);
        vm.prank(stranger); // herkes çağırabilir
        fp.commitPending(user);
        assertTrue(_eq(fp.plans(user), loose));
        assertEq(_activeAt(), 0);
        assertGt(_buy(6_000), 0);
    }

    function test_F3_gevsetmeTurleriBekler() public {
        IFlightPlan.Plan memory base = _plan();
        base.startDay = 5;
        base.bandBps = 300;
        base.closedBandBps = 500;
        _set(base);

        IFlightPlan.Plan[] memory v = new IFlightPlan.Plan[](10);
        for (uint256 i; i < v.length; ++i) {
            v[i] = _clone(base);
        }
        v[0].cycleTL = 20_001;
        v[1].maxOrderTL = 5_001;
        v[2].maxWaitH = 49;
        v[3].expiresAt = base.expiresAt + 1;
        v[4].startDay = 4;
        v[5].askMode = 0;
        v[6].bandBps = 0; // bandı kapatmak gevşek
        v[7].bandBps = 301;
        v[8].closedBandBps = 0;
        v[9].closedBandBps = 501;

        for (uint256 i; i < v.length; ++i) {
            _set(v[i]);
            assertGt(_activeAt(), 0, "gevsek plan beklemeli");
            assertTrue(_eq(fp.plans(user), base), "eski plan gecerli kalmali");
        }
    }

    function _clone(IFlightPlan.Plan memory p) internal pure returns (IFlightPlan.Plan memory c) {
        c = abi.decode(abi.encode(p), (IFlightPlan.Plan));
    }

    // ─────────────────────────────── F-4 ───────────────────────────────

    function test_F4_agentKuleDeadlineDegisikligiHepBekler() public {
        _set(_plan());
        IFlightPlan.Plan[] memory v = new IFlightPlan.Plan[](5);
        for (uint256 i; i < v.length; ++i) {
            v[i] = _plan();
            // Diğer her alan daha sıkı olsa bile beklemeli.
            v[i].maxOrderTL = 1_000;
            v[i].cycleTL = 10_000;
        }
        v[0].agent = stranger;
        v[1].kule = stranger;
        v[2].deadlineDay = 20; // daha erken son gün de "aynı kalmalı" kuralına takılır
        v[3].deadlineDay = 28;
        v[4].agentId = AGENT_ID + 1;

        for (uint256 i; i < v.length; ++i) {
            uint64 expectedAt = uint64(block.timestamp + 24 hours);
            vm.expectEmit(true, false, false, true, address(fp));
            emit PlanSet(user, _hash(v[i]), false, expectedAt);
            _set(v[i]);
            assertEq(_activeAt(), expectedAt);
            assertTrue(_eq(fp.plans(user), _plan()));
        }

        // Yeni ajan 24 saat dolmadan izin isteyemez.
        _set(v[0]);
        vm.prank(stranger);
        vm.expectRevert(IFlightPlan.NotAgent.selector);
        fp.requestBuy(user, 1_000, PX, 0, RH, new bytes[](0));

        vm.warp(block.timestamp + 24 hours);
        fp.commitPending(user);
        assertEq(fp.plans(user).agent, stranger);
        assertGt(_buyAs(stranger, 1_000, 0), 0);
    }

    // ─────────────────────────────── F-5 ───────────────────────────────

    function test_F5_agentDisiCagiranRevertNotAgent() public {
        _set(_plan());
        address[3] memory callers = [user, kule, stranger];
        for (uint256 i; i < callers.length; ++i) {
            vm.recordLogs();
            vm.prank(callers[i]);
            vm.expectRevert(IFlightPlan.NotAgent.selector);
            fp.requestBuy(user, 1_000, PX, 0, RH, new bytes[](0));
            assertEq(vm.getRecordedLogs().length, 0);
        }
        // Planı olmayan kullanıcı için de olay yok, revert.
        vm.prank(agent);
        vm.expectRevert(IFlightPlan.NotAgent.selector);
        fp.requestBuy(stranger, 1_000, PX, 0, RH, new bytes[](0));
        assertEq(fp.lastActionId(), 0);
    }

    function test_F5_degerGonderilirseRevert() public {
        _set(_plan());
        vm.deal(agent, 1 ether);
        vm.prank(agent);
        vm.expectRevert(IFlightPlan.ValueNotAccepted.selector);
        fp.requestBuy{value: 1}(user, 1_000, PX, 0, RH, new bytes[](0));
    }

    // ─────────────────────────────── F-6 ───────────────────────────────

    function _assertNoAuthorization() internal view {
        assertEq(fp.lastActionId(), 0);
        assertEq(fp.cycles(user).reservedTL, 0);
    }

    function test_F6_kod1PlanIptal() public {
        _set(_plan());
        vm.prank(user);
        fp.revoke();
        _expectRejected(1_000, IFlightPlan.RejectCode.PLAN_INACTIVE);
        assertEq(_buy(1_000), 0);
        _assertNoAuthorization();
    }

    function test_F6_kod1PlanSuresiDolmus() public {
        IFlightPlan.Plan memory p = _plan();
        p.expiresAt = uint64(t0 + 1 hours);
        _set(p);
        vm.warp(t0 + 1 hours);
        _expectRejected(1_000, IFlightPlan.RejectCode.PLAN_INACTIVE);
        assertEq(_buy(1_000), 0);
        _assertNoAuthorization();
    }

    function test_F6_kod2PencereDisi() public {
        IFlightPlan.Plan memory p = _plan();
        p.startDay = 10;
        p.deadlineDay = 20;
        _set(p);
        // 5 Ekim < startDay
        _expectRejected(1_000, IFlightPlan.RejectCode.OUTSIDE_WINDOW);
        assertEq(_buy(1_000), 0);
        // 21 Ekim > deadlineDay
        vm.warp(_tr(2026, 10, 21, 0, 0));
        _expectRejected(1_000, IFlightPlan.RejectCode.OUTSIDE_WINDOW);
        assertEq(_buy(1_000), 0);
        _assertNoAuthorization();
        // Pencere içi sınırlar geçer.
        vm.warp(_tr(2026, 10, 20, 23, 59));
        assertGt(_buy(1_000), 0);
    }

    function test_F6_kod3EmirTavaniAsimi() public {
        _set(_plan());
        _expectRejected(5_001, IFlightPlan.RejectCode.OVER_ORDER_LIMIT);
        assertEq(_buy(5_001), 0);
        _expectRejected(40_000, IFlightPlan.RejectCode.OVER_ORDER_LIMIT); // §16 #19 çalıntı anahtar
        assertEq(_buy(40_000), 0);
        _expectRejected(0, IFlightPlan.RejectCode.OVER_ORDER_LIMIT); // TODO(spec): 0 TL plan dışı tutar
        assertEq(_buy(0), 0);
        _assertNoAuthorization();
        assertGt(_buy(5_000), 0);
    }

    function test_F6_kod4AylikHedefAsimi() public {
        IFlightPlan.Plan memory p = _plan();
        p.cycleTL = 6_000;
        _set(p);
        uint256 id = _buy(5_000);
        _report(id, 5_000);
        _expectRejected(1_001, IFlightPlan.RejectCode.OVER_CYCLE_TARGET);
        assertEq(_buy(1_001), 0);
        assertGt(_buy(1_000), 0);
    }

    function test_F6_kod7EmirTuruGecersiz() public {
        _set(_plan());
        _expectRejected(1_000, IFlightPlan.RejectCode.BAD_ORDTYPE);
        assertEq(_buyAs(agent, 1_000, 2), 0);
        _expectRejected(1_000, IFlightPlan.RejectCode.BAD_ORDTYPE);
        assertEq(_buyAs(agent, 1_000, 255), 0);
        _assertNoAuthorization();
        assertGt(_buyAs(agent, 1_000, 1), 0); // ioc
    }

    function test_F6_kod6BantAcikFiyatKaynagiYok() public {
        // A1 Pyth'siz: bant açıksa fiyat doğrulanamaz → fail-closed kod 6.
        IFlightPlan.Plan memory p = _plan();
        p.bandBps = 300;
        _set(p);
        _expectRejected(1_000, IFlightPlan.RejectCode.PRICE_UNAVAILABLE);
        assertEq(_buy(1_000), 0);
        _assertNoAuthorization();
    }

    function test_F6_basariliIzinAlanlari() public {
        _set(_plan());
        uint64 openBy = uint64(block.timestamp + 15 minutes);
        vm.expectEmit(true, true, true, true, address(fp));
        emit BuyAuthorized(1, user, AGENT_ID, 2_500, PX, 1, openBy, RH);
        uint256 id = _buyAs(agent, 2_500, 1);
        assertEq(id, 1);

        IFlightPlan.BuyAction memory a = fp.actions(id);
        assertEq(a.user, user);
        assertEq(a.amountTL, 2_500);
        assertEq(a.maxPxE6, PX);
        assertEq(a.ordType, 1);
        assertEq(a.openBy, openBy);
        assertEq(a.reportBy, openBy + 60 minutes);
        assertEq(a.cycleId, 202610);
        assertEq(a.state, uint8(IFlightPlan.ActionState.AUTHORIZED));
        assertEq(fp.cycles(user).reservedTL, 2_500);
        assertEq(_buy(1), 2);
    }

    // ─────────────────────────────── F-7 ───────────────────────────────

    function test_F7_reservedTLIkiEszamanliIzninHedefiAsmasiniEngeller() public {
        IFlightPlan.Plan memory p = _plan();
        p.cycleTL = 8_000;
        _set(p);
        uint256 a = _buy(5_000);
        assertGt(a, 0);
        assertEq(fp.cycles(user).reservedTL, 5_000);

        // İlk izin raporlanmadan ikinci izin hedefi aşamaz.
        _expectRejected(5_000, IFlightPlan.RejectCode.OVER_CYCLE_TARGET);
        assertEq(_buy(5_000), 0);
        uint256 b = _buy(3_000);
        assertGt(b, 0);
        assertEq(fp.cycles(user).reservedTL, 8_000);
        assertEq(_buy(1), 0);

        // Kısmi dolum rezervi serbest bırakır; kalan için yeni izin alınabilir.
        _report(a, 2_000);
        IFlightPlan.Cycle memory c = fp.cycles(user);
        assertEq(c.spentTL, 2_000);
        assertEq(c.reservedTL, 3_000);
        assertGt(_buy(3_000), 0);
        assertEq(_buy(1), 0);
    }

    function testFuzz_F7_ikiIzinYalnizHedefIcindeyse(uint64 x, uint64 y) public {
        IFlightPlan.Plan memory p = _plan();
        p.cycleTL = 6_000;
        _set(p);
        x = uint64(bound(x, 1, p.maxOrderTL));
        y = uint64(bound(y, 1, p.maxOrderTL));
        assertGt(_buy(x), 0);
        uint256 idY = _buy(y);
        assertEq(idY != 0, uint256(x) + y <= p.cycleTL);
        IFlightPlan.Cycle memory c = fp.cycles(user);
        assertLe(uint256(c.reservedTL), p.cycleTL);
        assertEq(c.reservedTL, uint256(x) + (idY != 0 ? y : 0));
    }

    // ─────────────────────────────── F-8 ───────────────────────────────

    function test_F8_yalnizKuleRaporlar_ikinciRaporRevert() public {
        _set(_plan());
        uint256 id = _buy(3_000);

        address[3] memory others = [user, agent, stranger];
        for (uint256 i; i < others.length; ++i) {
            vm.prank(others[i]);
            vm.expectRevert(IFlightPlan.NotKule.selector);
            fp.reportExecution(id, "x", 3_000, PX, 0, bytes32(0));
        }

        vm.expectEmit(true, true, false, true, address(fp));
        emit BuyExecuted(id, user, "ord-1", 3_000, PX, 0, keccak256("rapor"));
        _report(id, 3_000);
        assertEq(fp.actions(id).state, uint8(IFlightPlan.ActionState.REPORTED));

        vm.prank(kule);
        vm.expectRevert(IFlightPlan.ActionNotAuthorized.selector);
        fp.reportExecution(id, "ord-1", 3_000, PX, 0, bytes32(0));

        // Var olmayan izin.
        vm.prank(kule);
        vm.expectRevert(IFlightPlan.NotKule.selector);
        fp.reportExecution(999, "ord-1", 1, PX, 0, bytes32(0));
    }

    function test_F8_gecersizStatusRevert() public {
        _set(_plan());
        uint256 id = _buy(3_000);
        vm.prank(kule);
        vm.expectRevert(IFlightPlan.InvalidStatus.selector);
        fp.reportExecution(id, "ord-1", 0, PX, 4, bytes32(0));
        // 3 EXPIRED geçerli.
        vm.prank(kule);
        fp.reportExecution(id, "ord-1", 0, PX, 3, bytes32(0));
        assertEq(fp.cycles(user).reservedTL, 0);
    }

    function test_F8_iptalSonrasiAcikIzinHalaRaporlanir() public {
        // Dolmuş emir aylık toplamın dışında kalmasın (§8.4).
        _set(_plan());
        uint256 id = _buy(3_000);
        vm.prank(user);
        fp.revoke();
        _report(id, 3_000);
        assertEq(fp.cycles(user).spentTL, 3_000);
        assertEq(fp.cycles(user).reservedTL, 0);
    }

    // ─────────────────────────────── F-9 ───────────────────────────────

    function test_F9_expireActionYalnizReportByGecince() public {
        _set(_plan());
        uint256 id = _buy(3_000);
        IFlightPlan.BuyAction memory a = fp.actions(id);

        vm.warp(a.openBy + 1); // openBy geçti ama rapor penceresi açık
        vm.expectRevert(IFlightPlan.ReportWindowOpen.selector);
        fp.expireAction(id);
        vm.warp(a.reportBy);
        vm.expectRevert(IFlightPlan.ReportWindowOpen.selector);
        fp.expireAction(id);

        vm.warp(a.reportBy + 1);
        vm.prank(stranger);
        fp.expireAction(id);
        assertEq(fp.actions(id).state, uint8(IFlightPlan.ActionState.EXPIRED));
        assertEq(fp.cycles(user).reservedTL, 0);
        assertEq(fp.cycles(user).spentTL, 0);

        vm.expectRevert(IFlightPlan.ActionNotAuthorized.selector);
        fp.expireAction(id);
        vm.prank(kule);
        vm.expectRevert(IFlightPlan.ActionNotAuthorized.selector);
        fp.reportExecution(id, "ord-1", 1, PX, 0, bytes32(0));
        vm.expectRevert(IFlightPlan.ActionNotAuthorized.selector);
        fp.expireAction(12345);
    }

    function test_F9_raporlanmisIzinDusurulemez() public {
        _set(_plan());
        uint256 id = _buy(3_000);
        _report(id, 1_000);
        vm.warp(fp.actions(id).reportBy + 1);
        vm.expectRevert(IFlightPlan.ActionNotAuthorized.selector);
        fp.expireAction(id);
        assertEq(fp.cycles(user).spentTL, 1_000);
    }

    function test_F9_closeCycleBasarili() public {
        IFlightPlan.Plan memory p = _plan();
        p.cycleTL = 10_000;
        _set(p);
        _report(_buy(5_000), 5_000);
        _report(_buy(5_000), 5_000);

        vm.expectRevert(IFlightPlan.CycleNotOver.selector);
        fp.closeCycle(user);

        vm.warp(_tr(2026, 10, 25, 23, 59)); // son gün hâlâ sürüyor
        vm.expectRevert(IFlightPlan.CycleNotOver.selector);
        fp.closeCycle(user);

        vm.warp(_tr(2026, 10, 26, 0, 0));
        vm.expectEmit(true, false, false, true, address(fp));
        emit CycleClosed(user, 202610, 10_000, true);
        vm.prank(stranger);
        fp.closeCycle(user);
        assertTrue(fp.cycleOf(user, 202610).closed);

        vm.expectRevert(IFlightPlan.CycleAlreadyClosed.selector);
        fp.closeCycle(user);

        // Kapalı döngüde (pencere yeniden açılsa bile) izin yok — burada pencere zaten dışarıda.
        _expectRejected(1_000, IFlightPlan.RejectCode.OUTSIDE_WINDOW);
        assertEq(_buy(1_000), 0);
    }

    function test_F9_closeCycleEksikDongu_okFalse() public {
        _set(_plan());
        _report(_buy(5_000), 4_000);
        vm.warp(_tr(2026, 10, 26, 9, 0));
        vm.expectEmit(true, false, false, true, address(fp));
        emit CycleClosed(user, 202610, 4_000, false);
        fp.closeCycle(user);
    }

    function test_F9_closeCycleAcikIzinVarkenKapanmaz() public {
        _set(_plan());
        vm.warp(_tr(2026, 10, 25, 23, 50));
        uint256 id = _buy(5_000);
        vm.warp(_tr(2026, 10, 26, 0, 10));
        vm.expectRevert(IFlightPlan.CycleNotOver.selector);
        fp.closeCycle(user);
        // Geç gelen rapor aya sayılır, sonra kapanır.
        _report(id, 5_000);
        vm.expectEmit(true, false, false, true, address(fp));
        emit CycleClosed(user, 202610, 5_000, false);
        fp.closeCycle(user);
    }

    function test_F9_yeniAyIlkCagridaYeniDongu() public {
        _set(_plan());
        _report(_buy(5_000), 5_000);

        vm.warp(_tr(2026, 11, 2, 10, 0));
        // Yeni ay: cycles() boş döngüyü gösterir, eski ay cycleOf ile okunur.
        IFlightPlan.Cycle memory c = fp.cycles(user);
        assertEq(c.id, 202611);
        assertEq(c.spentTL, 0);
        assertEq(fp.cycleOf(user, 202610).spentTL, 5_000);

        uint256 id = _buy(5_000);
        assertEq(fp.actions(id).cycleId, 202611);
        assertEq(fp.cycles(user).reservedTL, 5_000);

        // Ekim kapanmamıştı: closeCycle önce onu kapatır, Kasım henüz sürüyor.
        vm.expectEmit(true, false, false, true, address(fp));
        emit CycleClosed(user, 202610, 5_000, false);
        fp.closeCycle(user);
        vm.expectRevert(IFlightPlan.CycleNotOver.selector);
        fp.closeCycle(user);
    }

    function test_F9_closeCycleHicIzinYokken() public {
        _set(_plan());
        vm.warp(_tr(2026, 10, 27, 0, 0));
        vm.expectEmit(true, false, false, true, address(fp));
        emit CycleClosed(user, 202610, 0, false);
        fp.closeCycle(user);
        assertEq(fp.cycles(user).id, 202610);
        assertTrue(fp.cycles(user).closed);

        vm.expectRevert(IFlightPlan.NoPlan.selector);
        fp.closeCycle(stranger);
    }

    // ─────────────────────────────── F-10 ───────────────────────────────

    function test_F10_trGunuUTC21deDegisir() public {
        uint256 utc2100 = DateTimeLib.dateTimeToTimestamp(2026, 10, 5, 21, 0, 0);
        vm.warp(utc2100 - 1);
        assertEq(fp.trDay(), 5);
        vm.warp(utc2100);
        assertEq(fp.trDay(), 6);

        // Ay sınırı: 31 Ekim 21:00 UTC = 1 Kasım 00:00 TR.
        uint256 monthEdge = DateTimeLib.dateTimeToTimestamp(2026, 10, 31, 21, 0, 0);
        vm.warp(monthEdge - 1);
        assertEq(fp.trDay(), 31);
        assertEq(fp.currentCycleId(), 202610);
        vm.warp(monthEdge);
        assertEq(fp.trDay(), 1);
        assertEq(fp.currentCycleId(), 202611);

        // Yıl sınırı.
        vm.warp(DateTimeLib.dateTimeToTimestamp(2026, 12, 31, 21, 0, 0));
        assertEq(fp.currentCycleId(), 202701);
    }

    function test_F10_sonGunPenceresiUTC21deKapanir() public {
        _set(_plan()); // deadlineDay 25
        uint256 edge = DateTimeLib.dateTimeToTimestamp(2026, 10, 25, 21, 0, 0);
        vm.warp(edge - 1);
        assertGt(_buy(1_000), 0);
        vm.warp(edge);
        _expectRejected(1_000, IFlightPlan.RejectCode.OUTSIDE_WINDOW);
        assertEq(_buy(1_000), 0);
    }

    // ─────────────────────────────── F-12 ───────────────────────────────

    function test_F12_sikiPlanBekleyenGevsegiSiler() public {
        _set(_plan());
        IFlightPlan.Plan memory loose = _plan();
        loose.maxOrderTL = 20_000;
        _set(loose);
        uint64 at = _activeAt();
        assertGt(at, 0);

        IFlightPlan.Plan memory tight = _plan();
        tight.maxOrderTL = 3_000;
        vm.expectEmit(true, false, false, false, address(fp));
        emit PendingCleared(user);
        vm.expectEmit(true, false, false, true, address(fp));
        emit PlanSet(user, _hash(tight), true, uint64(block.timestamp));
        _set(tight);

        (IFlightPlan.Plan memory pend, uint64 at2) = fp.pending(user);
        assertEq(at2, 0);
        assertEq(pend.agent, address(0));
        assertTrue(_eq(fp.plans(user), tight));

        vm.warp(at + 1);
        vm.expectRevert(IFlightPlan.NoPendingPlan.selector);
        fp.commitPending(user);
        assertTrue(_eq(fp.plans(user), tight));
        _expectRejected(4_000, IFlightPlan.RejectCode.OVER_ORDER_LIMIT);
        assertEq(_buy(4_000), 0);
    }

    function test_F12_yeniGevsekPlanEskiBekleyeniSiler() public {
        _set(_plan());
        IFlightPlan.Plan memory l1 = _plan();
        l1.maxOrderTL = 20_000;
        _set(l1);
        uint64 at1 = _activeAt();

        vm.warp(block.timestamp + 12 hours);
        IFlightPlan.Plan memory l2 = _plan();
        l2.maxOrderTL = 6_000;
        vm.expectEmit(true, false, false, false, address(fp));
        emit PendingCleared(user);
        _set(l2);
        (IFlightPlan.Plan memory pend, uint64 at2) = fp.pending(user);
        assertTrue(_eq(pend, l2));
        assertEq(at2, uint64(block.timestamp + 24 hours));

        vm.warp(at1); // l1'in anı geldi: l2 henüz hazır değil
        vm.expectRevert(IFlightPlan.PendingNotReady.selector);
        fp.commitPending(user);
        vm.warp(at2);
        fp.commitPending(user);
        assertTrue(_eq(fp.plans(user), l2));
    }

    function test_F12_bekleyenYokkenPendingClearedYayilmaz() public {
        _set(_plan());
        vm.recordLogs();
        _set(_plan());
        assertEq(vm.getRecordedLogs().length, 1); // yalnız PlanSet
    }

    // ─────────────────────────────── F-13 ───────────────────────────────

    function test_F13_revokeBekleyeniSiler() public {
        _set(_plan());
        IFlightPlan.Plan memory loose = _plan();
        loose.maxOrderTL = 20_000;
        _set(loose);
        uint64 at = _activeAt();

        vm.expectEmit(true, false, false, false, address(fp));
        emit PendingCleared(user);
        vm.expectEmit(true, false, false, false, address(fp));
        emit PlanRevoked(user);
        vm.prank(user);
        fp.revoke();

        assertEq(_activeAt(), 0);
        assertFalse(fp.isPlanActive(user));
        vm.warp(at + 1);
        vm.expectRevert(IFlightPlan.NoPendingPlan.selector);
        fp.commitPending(user);
        assertFalse(fp.isPlanActive(user));
        _expectRejected(1_000, IFlightPlan.RejectCode.PLAN_INACTIVE);
        assertEq(_buy(1_000), 0);
    }

    function test_F13_suresiDolmusPlanVeBekleyen_revokeBekleyeniSiler() public {
        IFlightPlan.Plan memory p = _plan();
        p.expiresAt = uint64(t0 + 2 hours);
        _set(p);
        IFlightPlan.Plan memory loose = _clone(p);
        loose.expiresAt = uint64(t0 + 365 days);
        _set(loose);
        uint64 at = _activeAt();
        assertGt(at, 0);

        vm.warp(t0 + 3 hours); // etkin plan süresi doldu, bekleyen hâlâ duruyor
        assertFalse(fp.isPlanActive(user));

        vm.expectEmit(true, false, false, false, address(fp));
        emit PendingCleared(user);
        vm.prank(user);
        fp.revoke();
        assertEq(_activeAt(), 0);

        vm.warp(at + 1);
        vm.expectRevert(IFlightPlan.NoPendingPlan.selector);
        fp.commitPending(user);
        assertFalse(fp.isPlanActive(user));
    }

    function test_F13_planYokkenRevokeNoPlan() public {
        vm.prank(user);
        vm.expectRevert(IFlightPlan.NoPlan.selector);
        fp.revoke();
    }

    function test_F13_iptalSonrasiGevsekPlanYineBekler() public {
        // Fail-closed: iptal edilmiş plan da karşılaştırma tabanıdır (TODO(spec)).
        _set(_plan());
        vm.prank(user);
        fp.revoke();
        IFlightPlan.Plan memory loose = _plan();
        loose.maxOrderTL = 20_000;
        _set(loose);
        assertGt(_activeAt(), 0);
        assertFalse(fp.isPlanActive(user));

        // Aynı (eşit) plan hemen yeniden etkinleşir.
        _set(_plan());
        assertTrue(fp.isPlanActive(user));
        assertEq(_activeAt(), 0);
    }

    // ─────────────────────────────── F-14 ───────────────────────────────

    function test_F14_openByGecmisReportByGecmemis_raporKabul() public {
        _set(_plan());
        uint256 id = _buy(4_000);
        IFlightPlan.BuyAction memory a = fp.actions(id);
        assertEq(a.openBy, uint64(t0 + 15 minutes));
        assertEq(a.reportBy, uint64(t0 + 75 minutes));

        vm.warp(a.openBy + 30 minutes);
        _report(id, 4_000);
        IFlightPlan.Cycle memory c = fp.cycles(user);
        assertEq(c.spentTL, 4_000);
        assertEq(c.reservedTL, 0);
    }

    function test_F14_reportBySinirinda() public {
        _set(_plan());
        uint256 a = _buy(1_000);
        uint256 b = _buy(1_000);
        uint64 reportBy = fp.actions(a).reportBy;
        vm.warp(reportBy);
        _report(a, 1_000); // now == reportBy kabul
        vm.warp(reportBy + 1);
        vm.prank(kule);
        vm.expectRevert(IFlightPlan.ReportWindowClosed.selector);
        fp.reportExecution(b, "ord-2", 1_000, PX, 0, bytes32(0));
        assertEq(fp.cycles(user).spentTL, 1_000);
    }

    // ─────────────────────────────── F-15 ───────────────────────────────

    function test_F15_filledTLAmountTLiAsarsaOverFilled() public {
        _set(_plan());
        uint256 id = _buy(4_000);
        vm.prank(kule);
        vm.expectRevert(IFlightPlan.OverFilled.selector);
        fp.reportExecution(id, "ord-1", 4_001, PX, 0, bytes32(0));
        assertEq(fp.cycles(user).spentTL, 0);
        assertEq(fp.actions(id).state, uint8(IFlightPlan.ActionState.AUTHORIZED));

        _report(id, 4_000); // eşit kabul
        assertEq(fp.cycles(user).spentTL, 4_000);
    }

    function testFuzz_F15_dolumHerZamanTutarIcinde(uint64 amount, uint64 filled) public {
        _set(_plan());
        amount = uint64(bound(amount, 1, 5_000));
        uint256 id = _buy(amount);
        vm.prank(kule);
        if (filled > amount) vm.expectRevert(IFlightPlan.OverFilled.selector);
        fp.reportExecution(id, "ord-1", filled, PX, 1, bytes32(0));
        IFlightPlan.Cycle memory c = fp.cycles(user);
        assertLe(c.spentTL, amount);
        assertEq(c.reservedTL, filled > amount ? amount : 0);
    }

    // ─────────────────────── Fuzz: reservedTL / aylık toplam değişmezleri ───────────────────────

    /// @dev Rastgele izin / rapor / düşürme / zaman dizisi. Her adımdan sonra:
    ///      reservedTL = AUTHORIZED izinlerin toplamı; spentTL = raporlanan dolumların toplamı;
    ///      spentTL + reservedTL ≤ cycleTL.
    function testFuzz_F7_reservedVeAylikToplamDegismezi(uint256 seed) public {
        IFlightPlan.Plan memory p = _plan();
        p.cycleTL = 12_000;
        p.maxOrderTL = 4_000;
        _set(p);

        uint256[] memory ids = new uint256[](40);
        uint256 n;
        uint256 sumFilled;

        for (uint256 step; step < 40; ++step) {
            uint256 r = uint256(keccak256(abi.encode(seed, step)));
            uint256 op = r % 4;
            if (op == 0) {
                uint256 id = _buy(uint64(bound(r >> 8, 0, 6_000)));
                if (id != 0) ids[n++] = id;
            } else if (op == 1 && n > 0) {
                uint256 id = ids[(r >> 8) % n];
                IFlightPlan.BuyAction memory a = fp.actions(id);
                if (a.state == uint8(IFlightPlan.ActionState.AUTHORIZED) && block.timestamp <= a.reportBy) {
                    uint64 f = uint64(bound(r >> 80, 0, a.amountTL));
                    _report(id, f);
                    sumFilled += f;
                }
            } else if (op == 2 && n > 0) {
                uint256 id = ids[(r >> 8) % n];
                IFlightPlan.BuyAction memory a = fp.actions(id);
                if (a.state == uint8(IFlightPlan.ActionState.AUTHORIZED) && block.timestamp > a.reportBy) {
                    fp.expireAction(id);
                }
            } else {
                vm.warp(block.timestamp + bound(r >> 8, 1, 40 minutes));
            }

            // Döngü Ekim içinde kalmalı (5 Ekim + 40 × 40 dk < 25 Ekim).
            IFlightPlan.Cycle memory c = fp.cycleOf(user, 202610);
            uint256 sumReserved;
            for (uint256 i; i < n; ++i) {
                IFlightPlan.BuyAction memory a = fp.actions(ids[i]);
                if (a.state == uint8(IFlightPlan.ActionState.AUTHORIZED)) sumReserved += a.amountTL;
            }
            assertEq(c.reservedTL, sumReserved, "reservedTL");
            assertEq(c.spentTL, sumFilled, "spentTL");
            assertLe(uint256(c.spentTL) + c.reservedTL, p.cycleTL, "aylik toplam");
        }
    }
}
