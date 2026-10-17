// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {DateTimeLib} from "solady/utils/DateTimeLib.sol";
import {FlightPlan} from "../src/FlightPlan.sol";
import {IFlightPlan} from "../src/interfaces/IFlightPlan.sol";

/// @notice Saldırgan bakışlı ek testler (SPEC §8.2–§8.4, §18 F-2…F-15). Test adları §18 kimliğiyle başlar.
abstract contract AdvBase is Test {
    FlightPlan internal fp;

    address internal user = makeAddr("elif");
    address internal user2 = makeAddr("ayse");
    address internal agent = makeAddr("pilot");
    address internal agent2 = makeAddr("pilot2");
    address internal kule = makeAddr("kule");
    address internal kule2 = makeAddr("kule2");
    address internal stranger = makeAddr("stranger");
    uint256 internal constant AGENT_ID = 7;
    uint64 internal constant PX = 41_500_000;
    bytes32 internal constant RH = keccak256("gerekce");

    uint256 internal t0;

    event BuyRejected(address indexed user, uint256 indexed agentId, uint64 amountTL, uint8 code, bytes32 reasonHash);
    event CycleClosed(address indexed user, uint32 cycleId, uint64 spentTL, bool ok);

    function setUp() public virtual {
        fp = new FlightPlan();
        t0 = _tr(2026, 10, 5, 12, 0);
        vm.warp(t0);
    }

    function _tr(uint256 y, uint256 m, uint256 d, uint256 h, uint256 mi) internal pure returns (uint256) {
        return DateTimeLib.dateTimeToTimestamp(y, m, d, h, mi, 0) - 3 hours;
    }

    function _trs(uint256 y, uint256 m, uint256 d, uint256 h, uint256 mi, uint256 s) internal pure returns (uint256) {
        return DateTimeLib.dateTimeToTimestamp(y, m, d, h, mi, s) - 3 hours;
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
            expiresAt: uint64(t0 + 3 * 365 days),
            agent: agent,
            kule: kule,
            agentId: AGENT_ID
        });
    }

    function _setAs(address u, IFlightPlan.Plan memory p) internal {
        vm.prank(u);
        fp.setPlan(p);
    }

    function _set(IFlightPlan.Plan memory p) internal {
        _setAs(user, p);
    }

    function _buy(uint64 amountTL) internal returns (uint256) {
        vm.prank(agent);
        return fp.requestBuy(user, amountTL, PX, 0, RH, new bytes[](0));
    }

    function _buyFor(address caller, address u, uint64 amountTL) internal returns (uint256) {
        vm.prank(caller);
        return fp.requestBuy(u, amountTL, PX, 0, RH, new bytes[](0));
    }

    function _reportAs(address caller, uint256 id, uint64 filledTL, uint8 status) internal {
        vm.prank(caller);
        fp.reportExecution(id, "ord", filledTL, PX, status, keccak256("rapor"));
    }

    function _report(uint256 id, uint64 filledTL) internal {
        _reportAs(kule, id, filledTL, 0);
    }

    function _activeAt() internal view returns (uint64 at) {
        (, at) = fp.pending(user);
    }

    function _clone(IFlightPlan.Plan memory p) internal pure returns (IFlightPlan.Plan memory c) {
        c = abi.decode(abi.encode(p), (IFlightPlan.Plan));
    }

    function _eq(IFlightPlan.Plan memory a, IFlightPlan.Plan memory b) internal pure returns (bool) {
        return keccak256(abi.encode(a)) == keccak256(abi.encode(b));
    }

    function _expectRejected(uint64 amountTL, IFlightPlan.RejectCode code) internal {
        vm.expectEmit(true, true, false, true, address(fp));
        emit BuyRejected(user, AGENT_ID, amountTL, uint8(code), RH);
    }
}

contract AdversarialTest is AdvBase {
    // ───────────────────────── F-6 / F-7: tutar ve hedef sınırları ─────────────────────────

    function test_F6_adv_maxOrderTamSinirKabul_birFazlasiKod3() public {
        _set(_plan());
        _expectRejected(5_001, IFlightPlan.RejectCode.OVER_ORDER_LIMIT);
        assertEq(_buy(5_001), 0);
        assertGt(_buy(5_000), 0);
    }

    function test_F7_adv_hedefTamSinirKabul_birFazlasiKod4() public {
        _set(_plan());
        for (uint256 i; i < 4; ++i) {
            assertGt(_buy(5_000), 0);
        }
        assertEq(fp.cycles(user).reservedTL, 20_000);
        _expectRejected(1, IFlightPlan.RejectCode.OVER_CYCLE_TARGET);
        assertEq(_buy(1), 0);
    }

    function test_F7_adv_tamDolumSonrasiHedefKapali() public {
        _set(_plan());
        for (uint256 i; i < 4; ++i) {
            _report(_buy(5_000), 5_000);
        }
        IFlightPlan.Cycle memory c = fp.cycles(user);
        assertEq(c.spentTL, 20_000);
        assertEq(c.reservedTL, 0);
        assertEq(_buy(1), 0);
    }

    function test_F7_adv_kismiDolumKalaniIadeEder() public {
        _set(_plan());
        uint256 id = _buy(5_000);
        _reportAs(kule, id, 1_000, 1); // PARTIAL
        IFlightPlan.Cycle memory c = fp.cycles(user);
        assertEq(c.spentTL, 1_000);
        assertEq(c.reservedTL, 0);
        // Kalan 19.000 TL: 3 × 5.000 + 4.000 kabul, sonra 1 TL ret.
        for (uint256 i; i < 3; ++i) {
            assertGt(_buy(5_000), 0);
        }
        assertGt(_buy(4_000), 0);
        assertEq(_buy(1), 0);
    }

    function test_F7_adv_dusurulenIzinButceyiIadeEder() public {
        _set(_plan());
        uint256[4] memory ids;
        for (uint256 i; i < 4; ++i) {
            ids[i] = _buy(5_000);
        }
        assertEq(_buy(1), 0);
        vm.warp(fp.actions(ids[0]).reportBy + 1);
        fp.expireAction(ids[0]);
        assertEq(fp.cycles(user).reservedTL, 15_000);
        assertGt(_buy(5_000), 0);
        assertEq(_buy(1), 0);
    }

    function test_F7_adv_sikiCycleTLMevcutHarcamaAltinda_kod4() public {
        _set(_plan());
        _report(_buy(5_000), 5_000);
        _report(_buy(5_000), 5_000);
        IFlightPlan.Plan memory t = _plan();
        t.cycleTL = 8_000; // harcanan 10.000'in altında; sıkı → hemen
        t.maxOrderTL = 4_000;
        _set(t);
        assertEq(_activeAt(), 0);
        _expectRejected(1, IFlightPlan.RejectCode.OVER_CYCLE_TARGET);
        assertEq(_buy(1), 0);
    }

    function test_F7_adv_uint64UcDegerTasmaYok() public {
        IFlightPlan.Plan memory p = _plan();
        p.cycleTL = type(uint64).max;
        p.maxOrderTL = type(uint64).max;
        _set(p);
        uint256 id = _buy(type(uint64).max);
        assertGt(id, 0);
        // spent + reserved + amount uint64'ü taşar; revert değil kod 4 olmalı.
        _expectRejected(1, IFlightPlan.RejectCode.OVER_CYCLE_TARGET);
        assertEq(_buy(1), 0);
        _report(id, type(uint64).max);
        assertEq(fp.cycles(user).spentTL, type(uint64).max);
        _expectRejected(type(uint64).max, IFlightPlan.RejectCode.OVER_CYCLE_TARGET);
        assertEq(_buy(type(uint64).max), 0);
    }

    function test_F6_adv_retDurumDegistirmez() public {
        _set(_plan());
        uint256 before = fp.lastActionId();
        assertEq(_buy(5_001), 0); // kod 3
        vm.prank(agent);
        assertEq(fp.requestBuy(user, 100, PX, 2, RH, new bytes[](0)), 0); // kod 7
        IFlightPlan.Cycle memory c = fp.cycles(user);
        assertEq(c.reservedTL, 0);
        assertEq(c.spentTL, 0);
        assertEq(fp.lastActionId(), before);
        assertEq(fp.actions(before + 1).user, address(0));
    }

    function test_F7_adv_kullanicilarArasiDonguIzole() public {
        _set(_plan());
        _setAs(user2, _plan()); // aynı agent/kule
        for (uint256 i; i < 4; ++i) {
            _report(_buy(5_000), 5_000);
        }
        assertEq(_buy(1), 0);
        uint256 id2 = _buyFor(agent, user2, 5_000);
        assertGt(id2, 0);
        _report(id2, 5_000);
        assertEq(fp.cycles(user).spentTL, 20_000);
        assertEq(fp.cycles(user2).spentTL, 5_000);
    }

    // ───────────────────────── F-5: agent dışı çağrılar ─────────────────────────

    function test_F5_adv_yetkisizCagiranlarOlayUretmez() public {
        _set(_plan());
        address[4] memory callers = [user, kule, stranger, agent2];
        for (uint256 i; i < callers.length; ++i) {
            vm.recordLogs();
            vm.prank(callers[i]);
            vm.expectRevert(IFlightPlan.NotAgent.selector);
            fp.requestBuy(user, 1_000, PX, 0, RH, new bytes[](0));
            assertEq(vm.getRecordedLogs().length, 0);
        }
    }

    function test_F5_adv_baskaKullaniciIcinIzinYok() public {
        _set(_plan());
        IFlightPlan.Plan memory p2 = _plan();
        p2.agent = agent2;
        _setAs(user2, p2);
        vm.prank(agent);
        vm.expectRevert(IFlightPlan.NotAgent.selector);
        fp.requestBuy(user2, 1_000, PX, 0, RH, new bytes[](0));
        // planı olmayan kullanıcı için de revert (olay yok)
        vm.prank(agent);
        vm.expectRevert(IFlightPlan.NotAgent.selector);
        fp.requestBuy(stranger, 1_000, PX, 0, RH, new bytes[](0));
    }

    function test_F5_adv_bekleyenPlaninYeniAgentiErkenCagiramaz() public {
        _set(_plan());
        IFlightPlan.Plan memory p = _plan();
        p.agent = agent2;
        _set(p);
        uint64 at = _activeAt();
        assertEq(at, block.timestamp + 24 hours);

        vm.warp(at - 1);
        vm.prank(agent2);
        vm.expectRevert(IFlightPlan.NotAgent.selector);
        fp.requestBuy(user, 1_000, PX, 0, RH, new bytes[](0));
        assertGt(_buy(1_000), 0); // eski agent hâlâ geçerli

        vm.warp(at);
        fp.commitPending(user);
        vm.prank(agent);
        vm.expectRevert(IFlightPlan.NotAgent.selector);
        fp.requestBuy(user, 1_000, PX, 0, RH, new bytes[](0));
        assertGt(_buyFor(agent2, user, 1_000), 0);
    }

    function test_F5_adv_iptalPlandaYabanciYineRevert() public {
        _set(_plan());
        vm.prank(user);
        fp.revoke();
        vm.prank(stranger);
        vm.expectRevert(IFlightPlan.NotAgent.selector);
        fp.requestBuy(user, 1_000, PX, 0, RH, new bytes[](0));
        _expectRejected(1_000, IFlightPlan.RejectCode.PLAN_INACTIVE);
        assertEq(_buy(1_000), 0);
    }

    // ───────────────────────── F-8: yalnız kule, tek rapor ─────────────────────────

    function test_F8_adv_kuleDisiHerkesRevert() public {
        _set(_plan());
        IFlightPlan.Plan memory p2 = _plan();
        p2.kule = kule2;
        _setAs(user2, p2);
        uint256 id = _buy(1_000);
        address[4] memory callers = [user, agent, stranger, kule2]; // kule2 = başka kullanıcının KULE'si
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(IFlightPlan.NotKule.selector);
            fp.reportExecution(id, "x", 1_000, PX, 0, bytes32(0));
        }
        _report(id, 1_000);
    }

    function test_F8_adv_varOlmayanIzinRevert() public {
        _set(_plan());
        vm.prank(kule);
        vm.expectRevert(IFlightPlan.NotKule.selector);
        fp.reportExecution(0, "x", 0, PX, 0, bytes32(0));
        vm.prank(kule);
        vm.expectRevert(IFlightPlan.NotKule.selector);
        fp.reportExecution(999, "x", 0, PX, 0, bytes32(0));
        vm.expectRevert(IFlightPlan.ActionNotAuthorized.selector);
        fp.expireAction(0);
        vm.expectRevert(IFlightPlan.ActionNotAuthorized.selector);
        fp.expireAction(999);
    }

    function test_F8_adv_sifirDolumluRaporSonrasiIkinciRaporRevert() public {
        _set(_plan());
        uint256 id = _buy(5_000);
        _reportAs(kule, id, 0, 2); // CANCELED
        vm.prank(kule);
        vm.expectRevert(IFlightPlan.ActionNotAuthorized.selector);
        fp.reportExecution(id, "ord", 5_000, PX, 0, bytes32(0));
        IFlightPlan.Cycle memory c = fp.cycles(user);
        assertEq(c.spentTL, 0);
        assertEq(c.reservedTL, 0);
    }

    function test_F8_adv_dusurulmusIzinRaporlanamaz() public {
        _set(_plan());
        uint256 id = _buy(5_000);
        vm.warp(fp.actions(id).reportBy + 1);
        fp.expireAction(id);
        vm.prank(kule);
        vm.expectRevert(IFlightPlan.ActionNotAuthorized.selector);
        fp.reportExecution(id, "ord", 5_000, PX, 0, bytes32(0));
        assertEq(fp.cycles(user).spentTL, 0);
    }

    /// @dev §8.4 "yalnız plan.kule" harfiyen: KULE değişikliği commit edilince eski KULE açık izni raporlayamaz.
    ///      Bu davranış raporda risk olarak işaretlendi (dolmuş emir aylık toplamın dışında kalabilir).
    function test_F8_adv_kuleDegisinceYalnizYeniKuleRaporlar() public {
        _set(_plan());
        IFlightPlan.Plan memory p = _plan();
        p.kule = kule2;
        _set(p);
        uint64 at = _activeAt();
        vm.warp(at - 1 minutes);
        uint256 id = _buy(5_000);
        vm.warp(at);
        fp.commitPending(user);
        vm.prank(kule);
        vm.expectRevert(IFlightPlan.NotKule.selector);
        fp.reportExecution(id, "ord", 5_000, PX, 0, bytes32(0));
        _reportAs(kule2, id, 5_000, 0);
        assertEq(fp.cycles(user).spentTL, 5_000);
    }

    // ───────────────────────── F-9 / F-14: rapor penceresi ─────────────────────────

    function test_F9_adv_reportBySinirlari() public {
        _set(_plan());
        uint256 a = _buy(1_000);
        uint256 b = _buy(1_000);
        IFlightPlan.BuyAction memory act = fp.actions(a);
        assertEq(act.openBy, block.timestamp + 15 minutes);
        assertEq(act.reportBy, act.openBy + 60 minutes);

        vm.warp(act.reportBy);
        vm.expectRevert(IFlightPlan.ReportWindowOpen.selector);
        fp.expireAction(a);
        vm.expectRevert(IFlightPlan.ReportWindowOpen.selector);
        fp.expireAction(b);
        _report(a, 1_000); // tam reportBy anında kabul

        vm.warp(act.reportBy + 1);
        vm.prank(kule);
        vm.expectRevert(IFlightPlan.ReportWindowClosed.selector);
        fp.reportExecution(b, "ord", 1_000, PX, 0, bytes32(0));
        fp.expireAction(b);
        vm.expectRevert(IFlightPlan.ActionNotAuthorized.selector);
        fp.expireAction(b);
        vm.expectRevert(IFlightPlan.ActionNotAuthorized.selector);
        fp.expireAction(a);

        IFlightPlan.Cycle memory c = fp.cycles(user);
        assertEq(c.spentTL, 1_000);
        assertEq(c.reservedTL, 0);
    }

    function test_F9_adv_openByOncesiBileDusurulemez() public {
        _set(_plan());
        uint256 id = _buy(1_000);
        vm.expectRevert(IFlightPlan.ReportWindowOpen.selector);
        fp.expireAction(id);
        vm.warp(fp.actions(id).openBy + 1);
        vm.expectRevert(IFlightPlan.ReportWindowOpen.selector);
        fp.expireAction(id);
    }

    // ───────────────────────── F-9: ay dönümü ve closeCycle ─────────────────────────

    function _febPlan() internal view returns (IFlightPlan.Plan memory p) {
        p = _plan();
        p.deadlineDay = 28;
    }

    function test_F9_adv_ayDonumundeRaporEskiDongudeKalir() public {
        _set(_febPlan());
        vm.warp(_tr(2027, 2, 28, 23, 50)); // Şubat'ın son günü, TR
        assertEq(fp.currentCycleId(), 202702);
        uint256 id = _buy(5_000);
        assertEq(fp.actions(id).cycleId, 202702);

        vm.warp(_tr(2027, 3, 1, 0, 30)); // Mart, reportBy içinde
        assertEq(fp.currentCycleId(), 202703);
        _report(id, 5_000);
        assertEq(fp.cycleOf(user, 202702).spentTL, 5_000);
        assertEq(fp.cycleOf(user, 202702).reservedTL, 0);
        assertEq(fp.cycles(user).spentTL, 0);
        assertEq(fp.cycles(user).reservedTL, 0);

        vm.expectEmit(true, false, false, true, address(fp));
        emit CycleClosed(user, 202702, 5_000, false);
        fp.closeCycle(user);
    }

    function test_F9_adv_ayDonumundeAcikIzinEskiDonguyuKilitler_expireIadeEder() public {
        _set(_febPlan());
        vm.warp(_tr(2027, 2, 28, 23, 50));
        uint256 id = _buy(5_000);
        vm.warp(_tr(2027, 3, 1, 0, 30));
        vm.expectRevert(IFlightPlan.CycleNotOver.selector);
        fp.closeCycle(user);
        // Yeni ayın bütçesi eski ayın açık izninden etkilenmez.
        for (uint256 i; i < 4; ++i) {
            assertGt(_buy(5_000), 0);
        }
        assertEq(_buy(1), 0);

        vm.warp(fp.actions(id).reportBy + 1);
        fp.expireAction(id);
        assertEq(fp.cycleOf(user, 202702).reservedTL, 0);
        assertEq(fp.cycles(user).reservedTL, 20_000); // Mart'ın rezervi değişmedi
        fp.closeCycle(user);
        assertTrue(fp.cycleOf(user, 202702).closed);
        assertFalse(fp.cycleOf(user, 202703).closed);
    }

    function test_F9_adv_closeCycleSonGunSiniri() public {
        _set(_plan()); // deadlineDay 25
        _report(_buy(1_000), 1_000);
        uint256 edge = _tr(2026, 10, 26, 0, 0); // = 25 Ekim 21:00 UTC
        vm.warp(edge - 1);
        vm.expectRevert(IFlightPlan.CycleNotOver.selector);
        fp.closeCycle(user);
        vm.warp(edge);
        fp.closeCycle(user);
        vm.expectRevert(IFlightPlan.CycleAlreadyClosed.selector);
        fp.closeCycle(user);
    }

    function test_F9_adv_closeCycleOkDegeri() public {
        _set(_plan());
        for (uint256 i; i < 4; ++i) {
            _report(_buy(5_000), 5_000);
        }
        vm.warp(_tr(2026, 10, 26, 0, 0));
        vm.expectEmit(true, false, false, true, address(fp));
        emit CycleClosed(user, 202610, 20_000, true);
        fp.closeCycle(user);
    }

    function test_F9_adv_yeniAyTamButce() public {
        _set(_plan());
        for (uint256 i; i < 4; ++i) {
            _report(_buy(5_000), 5_000);
        }
        assertEq(_buy(1), 0);
        vm.warp(_tr(2026, 11, 1, 0, 0));
        assertEq(fp.cycles(user).spentTL, 0);
        for (uint256 i; i < 4; ++i) {
            assertGt(_buy(5_000), 0);
        }
        assertEq(_buy(1), 0);
    }

    /// @dev Kapanan döngüye, deadlineDay gevşetilse bile yeni izin verilmemeli (aylık toplam yeniden açılamaz).
    function test_F9_adv_kapaliDongudeGevsekPlanlaBileIzinYok() public {
        _set(_plan());
        vm.warp(_tr(2026, 10, 26, 0, 0));
        fp.closeCycle(user);
        IFlightPlan.Plan memory p = _plan();
        p.deadlineDay = 28;
        _set(p);
        vm.warp(_activeAt());
        fp.commitPending(user);
        assertEq(fp.trDay(), 27);
        _expectRejected(1_000, IFlightPlan.RejectCode.OUTSIDE_WINDOW);
        assertEq(_buy(1_000), 0);
    }

    function test_F9_adv_eskiAyKapanmadanYeniAy_sonraSiraylaKapanir() public {
        _set(_plan());
        _report(_buy(5_000), 5_000);
        vm.warp(_tr(2026, 11, 3, 10, 0));
        _report(_buy(2_000), 2_000);
        vm.expectEmit(true, false, false, true, address(fp));
        emit CycleClosed(user, 202610, 5_000, false);
        fp.closeCycle(user);
        vm.expectRevert(IFlightPlan.CycleNotOver.selector); // Kasım'ın son günü gelmedi
        fp.closeCycle(user);
        vm.warp(_tr(2026, 11, 26, 0, 0));
        vm.expectEmit(true, false, false, true, address(fp));
        emit CycleClosed(user, 202611, 2_000, false);
        fp.closeCycle(user);
    }

    function test_F9_adv_closeCyclePlanYokNoPlan() public {
        vm.expectRevert(IFlightPlan.NoPlan.selector);
        fp.closeCycle(user);
    }

    // ───────────────────────── F-10: TR günü / ay / yıl sınırları ─────────────────────────

    function test_F10_adv_pencereBasiUTC21() public {
        IFlightPlan.Plan memory p = _plan();
        p.startDay = 10;
        _set(p);
        uint256 edge = DateTimeLib.dateTimeToTimestamp(2026, 10, 9, 21, 0, 0); // TR 10 Ekim 00:00
        vm.warp(edge - 1);
        assertEq(fp.trDay(), 9);
        _expectRejected(1_000, IFlightPlan.RejectCode.OUTSIDE_WINDOW);
        assertEq(_buy(1_000), 0);
        vm.warp(edge);
        assertEq(fp.trDay(), 10);
        assertGt(_buy(1_000), 0);
    }

    function test_F10_adv_sonGunSonSaniyeKabul() public {
        _set(_plan());
        uint256 last = _trs(2026, 10, 25, 23, 59, 59);
        vm.warp(last);
        assertEq(fp.trDay(), 25);
        assertGt(_buy(1_000), 0);
        vm.warp(last + 1);
        assertEq(fp.trDay(), 26);
        assertEq(_buy(1_000), 0);
    }

    function test_F10_adv_ayDonumuUTC21_izinYeniDongude() public {
        _set(_plan());
        uint256 edge = DateTimeLib.dateTimeToTimestamp(2026, 10, 31, 21, 0, 0);
        vm.warp(edge - 1);
        assertEq(fp.currentCycleId(), 202610);
        assertEq(fp.trDay(), 31);
        vm.warp(edge);
        assertEq(fp.currentCycleId(), 202611);
        assertEq(fp.trDay(), 1);
        uint256 id = _buy(1_000);
        assertEq(fp.actions(id).cycleId, 202611);
        assertEq(fp.cycleOf(user, 202610).reservedTL, 0);
        assertEq(fp.cycleOf(user, 202611).reservedTL, 1_000);
    }

    function test_F10_adv_yilDonumuUTC21() public {
        vm.warp(DateTimeLib.dateTimeToTimestamp(2026, 12, 31, 20, 59, 59));
        assertEq(fp.currentCycleId(), 202612);
        vm.warp(DateTimeLib.dateTimeToTimestamp(2026, 12, 31, 21, 0, 0));
        assertEq(fp.currentCycleId(), 202701);
        assertEq(fp.trDay(), 1);
    }

    function test_F10_adv_artikYilSubat29() public {
        vm.warp(DateTimeLib.dateTimeToTimestamp(2028, 2, 28, 21, 0, 0));
        assertEq(fp.currentCycleId(), 202802);
        assertEq(fp.trDay(), 29);
        vm.warp(DateTimeLib.dateTimeToTimestamp(2028, 2, 29, 21, 0, 0));
        assertEq(fp.currentCycleId(), 202803);
        assertEq(fp.trDay(), 1);
    }

    // ───────────────────────── F-2 / F-3 / F-4: sıkılık kuralı ─────────────────────────

    function _bandBase() internal view returns (IFlightPlan.Plan memory p) {
        p = _plan();
        p.bandBps = 300;
        p.closedBandBps = 500;
        p.askMode = 0;
    }

    /// @dev Tek alanda gevşetme (ya da zorunlu-aynı alanda değişiklik) → bekler.
    function _loosened(uint256 i) internal view returns (IFlightPlan.Plan memory p) {
        p = _bandBase();
        if (i == 0) p.cycleTL += 1;
        else if (i == 1) p.maxOrderTL += 1;
        else if (i == 2) p.maxWaitH += 1;
        else if (i == 3) p.expiresAt += 1;
        // i == 4: startDay/askMode gevşetmesi ayrı testte (taban startDay = 1)
        else if (i == 5) p.bandBps = 301;
        else if (i == 6) p.bandBps = 0; // bandı kapatmak gevşetmedir
        else if (i == 7) p.closedBandBps = 501;
        else if (i == 8) p.closedBandBps = 0;
        else if (i == 9) p.deadlineDay = 24; // daha sıkı görünse de aynı kalmalı
        else if (i == 10) p.deadlineDay = 26;
        else if (i == 11) p.agent = agent2;
        else if (i == 12) p.kule = kule2;
        else if (i == 13) p.agentId = AGENT_ID + 1;
    }

    function test_F3_adv_herGevsetmeAlaniTekTekBekler() public {
        for (uint256 i; i < 14; ++i) {
            if (i == 4) continue; // startDay ayrı test
            setUp();
            _set(_bandBase());
            IFlightPlan.Plan memory before = fp.plans(user);
            IFlightPlan.Plan memory l = _loosened(i);
            _set(l);
            assertEq(_activeAt(), block.timestamp + 24 hours, vm.toString(i));
            assertTrue(_eq(fp.plans(user), before), vm.toString(i));
        }
    }

    function test_F3_adv_startDayVeAskModeGevsetmeBekler() public {
        IFlightPlan.Plan memory b = _plan();
        b.startDay = 5;
        b.askMode = 1;
        _set(b);
        IFlightPlan.Plan memory l = _clone(b);
        l.startDay = 4;
        _set(l);
        assertGt(_activeAt(), 0);
        l = _clone(b);
        l.askMode = 0;
        _set(l);
        assertGt(_activeAt(), 0);
        assertTrue(_eq(fp.plans(user), b));
    }

    function test_F2_adv_herSikilastirmaAlaniTekTekHemen() public {
        for (uint256 i; i < 9; ++i) {
            setUp();
            IFlightPlan.Plan memory b = _bandBase();
            b.startDay = 2;
            _set(b);
            IFlightPlan.Plan memory t = _clone(b);
            if (i == 0) t.cycleTL -= 1;
            else if (i == 1) t.maxOrderTL -= 1;
            else if (i == 2) t.maxWaitH -= 1;
            else if (i == 3) t.expiresAt -= 1;
            else if (i == 4) t.startDay = 3;
            else if (i == 5) t.askMode = 1;
            else if (i == 6) t.bandBps = 299;
            else if (i == 7) t.closedBandBps = 499;
            else if (i == 8) t.maxWaitH = 0;
            _set(t);
            assertEq(_activeAt(), 0, vm.toString(i));
            assertTrue(_eq(fp.plans(user), t), vm.toString(i));
        }
    }

    function test_F2_adv_bantAcmakSikidir() public {
        _set(_plan()); // band 0
        IFlightPlan.Plan memory t = _plan();
        t.bandBps = 9_999;
        t.closedBandBps = 9_999;
        _set(t);
        assertEq(_activeAt(), 0);
        assertTrue(_eq(fp.plans(user), t));
    }

    function test_F3_adv_karisikDegisiklikBekler() public {
        _set(_plan());
        IFlightPlan.Plan memory m = _plan();
        m.cycleTL = 10_000; // sıkı
        m.maxOrderTL = 5_000;
        m.maxWaitH = 72; // gevşek
        _set(m);
        assertGt(_activeAt(), 0);
        assertEq(fp.plans(user).cycleTL, 20_000);
    }

    function test_F3_adv_commitPendingSinirlariVeHerkes() public {
        _set(_plan());
        IFlightPlan.Plan memory l = _plan();
        l.maxOrderTL = 8_000;
        _set(l);
        uint64 at = _activeAt();
        vm.warp(at - 1);
        vm.prank(stranger);
        vm.expectRevert(IFlightPlan.PendingNotReady.selector);
        fp.commitPending(user);
        vm.warp(at);
        vm.prank(stranger);
        fp.commitPending(user);
        assertTrue(_eq(fp.plans(user), l));
        vm.expectRevert(IFlightPlan.NoPendingPlan.selector);
        fp.commitPending(user);
    }

    function test_F3_adv_bekleyenSuresinceEskiPlanGecerli() public {
        _set(_plan());
        IFlightPlan.Plan memory l = _plan();
        l.cycleTL = 50_000;
        l.maxOrderTL = 10_000;
        _set(l);
        vm.warp(_activeAt() - 1);
        _expectRejected(8_000, IFlightPlan.RejectCode.OVER_ORDER_LIMIT);
        assertEq(_buy(8_000), 0);
        for (uint256 i; i < 4; ++i) {
            assertGt(_buy(5_000), 0);
        }
        _expectRejected(1, IFlightPlan.RejectCode.OVER_CYCLE_TARGET);
        assertEq(_buy(1), 0);
        vm.warp(block.timestamp + 1);
        fp.commitPending(user);
        assertGt(_buy(8_000), 0);
    }

    function test_F3_adv_suresiDolanPlanSonrasiYeniPlanBekler_vePlanPasif() public {
        IFlightPlan.Plan memory p = _plan();
        p.expiresAt = uint64(t0 + 1 hours);
        _set(p);
        vm.warp(t0 + 2 hours);
        IFlightPlan.Plan memory n = _plan();
        _set(n);
        assertGt(_activeAt(), 0);
        _expectRejected(1_000, IFlightPlan.RejectCode.PLAN_INACTIVE);
        assertEq(_buy(1_000), 0);
    }

    function test_F3_adv_suresiDolmusBekleyenPlanEtkinlesirseFailClosed() public {
        _set(_plan());
        IFlightPlan.Plan memory l = _plan();
        l.maxOrderTL = 6_000; // gevşek
        l.expiresAt = uint64(block.timestamp + 1 hours); // ama activeAt'ten önce bitiyor
        _set(l);
        vm.warp(_activeAt());
        fp.commitPending(user);
        _expectRejected(1_000, IFlightPlan.RejectCode.PLAN_INACTIVE);
        assertEq(_buy(1_000), 0);
    }

    function test_F3_adv_gecersizPlanBekleyeniSilmez_revertAtomik() public {
        _set(_plan());
        IFlightPlan.Plan memory l = _plan();
        l.maxOrderTL = 6_000;
        _set(l);
        uint64 at = _activeAt();
        IFlightPlan.Plan memory bad = _plan();
        bad.cycleTL = 0;
        vm.prank(user);
        vm.expectRevert(IFlightPlan.InvalidPlan.selector);
        fp.setPlan(bad);
        assertEq(_activeAt(), at);
    }

    // ───────────────────────── F-12 / F-13: bekleyen planın silinmesi ─────────────────────────

    function test_F12_adv_ikinciGevsekPlanSayaciSifirlar() public {
        _set(_plan());
        IFlightPlan.Plan memory a = _plan();
        a.maxOrderTL = 9_000;
        _set(a);
        uint256 tA = block.timestamp;
        vm.warp(tA + 23 hours);
        IFlightPlan.Plan memory b = _plan();
        b.maxOrderTL = 6_000;
        _set(b);
        vm.warp(tA + 24 hours);
        vm.expectRevert(IFlightPlan.PendingNotReady.selector);
        fp.commitPending(user);
        vm.warp(tA + 47 hours);
        fp.commitPending(user);
        assertTrue(_eq(fp.plans(user), b));
    }

    function test_F12_adv_ayniPlanYenidenKurulunca_bekleyenSilinir() public {
        _set(_plan());
        IFlightPlan.Plan memory l = _plan();
        l.maxOrderTL = 9_000;
        _set(l);
        _set(_plan()); // eşit → hemen; bekleyen silinmeli
        assertEq(_activeAt(), 0);
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert(IFlightPlan.NoPendingPlan.selector);
        fp.commitPending(user);
        assertEq(fp.plans(user).maxOrderTL, 5_000);
    }

    function test_F13_adv_revokeSonrasiBekleyenAslaDevreyeGirmez() public {
        _set(_plan());
        IFlightPlan.Plan memory l = _plan();
        l.maxOrderTL = 9_000;
        _set(l);
        vm.prank(user);
        fp.revoke();
        vm.warp(block.timestamp + 30 days);
        vm.expectRevert(IFlightPlan.NoPendingPlan.selector);
        fp.commitPending(user);
        assertFalse(fp.isPlanActive(user));
        _expectRejected(1_000, IFlightPlan.RejectCode.PLAN_INACTIVE);
        assertEq(_buy(1_000), 0);
    }

    function test_F13_adv_revokeSonrasiGevsekPlanBekler_buSuredeKod1() public {
        _set(_plan());
        vm.prank(user);
        fp.revoke();
        IFlightPlan.Plan memory l = _plan();
        l.maxOrderTL = 9_000;
        _set(l);
        uint64 at = _activeAt();
        assertEq(at, block.timestamp + 24 hours);
        vm.warp(at - 1);
        assertEq(_buy(1_000), 0);
        vm.warp(at);
        fp.commitPending(user);
        assertGt(_buy(9_000), 0);
    }

    function test_F13_adv_revokeSonrasiIzinYok_acikIzinRaporlanir() public {
        _set(_plan());
        uint256 id = _buy(5_000);
        vm.prank(user);
        fp.revoke();
        assertEq(_buy(1_000), 0);
        _report(id, 5_000);
        assertEq(fp.cycles(user).spentTL, 5_000);
    }

    /// @dev Kullanıcının kendisi iptalden sonra aynı (ya da daha sıkı) planı kurarsa hemen etkin olur (§8.2 sıkılık).
    function test_F13_adv_revokeSonrasiAyniPlanHemenEtkin() public {
        _set(_plan());
        vm.prank(user);
        fp.revoke();
        _set(_plan());
        assertTrue(fp.isPlanActive(user));
        assertEq(_activeAt(), 0);
    }

    function test_F13_adv_baskasiRevokeEdemez() public {
        _set(_plan());
        vm.prank(agent);
        vm.expectRevert(IFlightPlan.NoPlan.selector);
        fp.revoke();
        assertTrue(fp.isPlanActive(user));
    }

    // ───────────────────────── F-15: dolum sınırı ─────────────────────────

    function test_F15_adv_dolumTamTutarKabul_birFazlasiRevert() public {
        _set(_plan());
        uint256 id = _buy(5_000);
        vm.prank(kule);
        vm.expectRevert(IFlightPlan.OverFilled.selector);
        fp.reportExecution(id, "ord", 5_001, PX, 0, bytes32(0));
        _report(id, 5_000);
    }
}

// ─────────────────────────────── Değişmez (invariant) testi ───────────────────────────────

contract FlightPlanHandler is Test {
    FlightPlan internal fp;
    address internal user;
    address internal agent;
    address internal kule;

    uint256[] public ids;
    mapping(uint32 => uint256) public ghostOpen; // döngü → açık izin tutarı toplamı
    mapping(uint32 => uint256) public ghostFilled; // döngü → raporlanan dolum toplamı
    uint32[] public touched;
    mapping(uint32 => bool) internal _seen;

    // Etkin plan (yalnız hemen-etkin setPlan ve commitPending ile değişir)
    uint64 public effCycleTL;
    uint64 public effMaxOrderTL;
    bool public revoked;
    uint256 public pendingSetAt; // 0 = bekleyen yok
    uint64 public pendingCycleTL;
    uint64 public pendingMaxOrderTL;

    string public violation;
    uint256 public authorizedCount;
    uint256 public reportedCount;
    uint256 public closedCount;

    constructor(FlightPlan fp_, address user_, address agent_, address kule_, uint64 c, uint64 m) {
        fp = fp_;
        user = user_;
        agent = agent_;
        kule = kule_;
        effCycleTL = c;
        effMaxOrderTL = m;
    }

    function _flag(string memory why) internal {
        if (bytes(violation).length == 0) violation = why;
    }

    function _planFor(uint64 c, uint64 m) internal view returns (IFlightPlan.Plan memory p) {
        p = fp.plans(user);
        p.cycleTL = c;
        p.maxOrderTL = m;
    }

    function buy(uint64 amount) external {
        amount = uint64(bound(amount, 1, 12_000));
        uint32 cid = fp.currentCycleId();
        uint8 d = fp.trDay();
        IFlightPlan.Plan memory p = fp.plans(user);
        bool wasClosed = fp.cycleOf(user, cid).closed;
        vm.prank(agent);
        uint256 id = fp.requestBuy(user, amount, 1, 0, bytes32(0), new bytes[](0));
        if (id == 0) return;
        ++authorizedCount;
        if (wasClosed) _flag("izin: kapali dongu");
        if (revoked) _flag("izin: iptal edilmis plan");
        if (block.timestamp >= p.expiresAt) _flag("izin: suresi dolmus plan");
        if (d < p.startDay || d > p.deadlineDay) _flag("izin: pencere disi");
        if (amount > effMaxOrderTL) _flag("izin: maxOrderTL asimi");
        IFlightPlan.Cycle memory c = fp.cycleOf(user, cid);
        if (uint256(c.spentTL) + c.reservedTL > effCycleTL) _flag("izin: cycleTL asimi");
        if (fp.actions(id).cycleId != cid) _flag("izin: yanlis cycleId");
        ids.push(id);
        ghostOpen[cid] += amount;
        if (!_seen[cid]) {
            _seen[cid] = true;
            touched.push(cid);
        }
    }

    function report(uint256 idx, uint64 filled) external {
        if (ids.length == 0) return;
        uint256 id = idx % 2 == 0 ? ids[ids.length - 1] : ids[idx % ids.length];
        IFlightPlan.BuyAction memory a = fp.actions(id);
        filled = uint64(bound(filled, 0, a.amountTL));
        vm.prank(kule);
        try fp.reportExecution(id, "o", filled, 1, 0, bytes32(0)) {
            ++reportedCount;
            if (a.state != 0) _flag("rapor: AUTHORIZED olmayan izin");
            if (block.timestamp > a.reportBy) _flag("rapor: reportBy sonrasi");
            ghostOpen[a.cycleId] -= a.amountTL;
            ghostFilled[a.cycleId] += filled;
        } catch {
            if (a.state == 0 && block.timestamp <= a.reportBy) _flag("rapor: gecerli rapor reddedildi");
        }
    }

    function expire(uint256 idx) external {
        if (ids.length == 0) return;
        uint256 id = ids[idx % ids.length];
        IFlightPlan.BuyAction memory a = fp.actions(id);
        try fp.expireAction(id) {
            if (a.state != 0) _flag("expire: AUTHORIZED olmayan izin");
            if (block.timestamp <= a.reportBy) _flag("expire: erken");
            ghostOpen[a.cycleId] -= a.amountTL;
        } catch {
            if (a.state == 0 && block.timestamp > a.reportBy) _flag("expire: gecerli expire reddedildi");
        }
    }

    function warp(uint256 dt) external {
        // Çoğunlukla rapor penceresi ölçeğinde küçük adımlar; arada gün atlayarak ay/kapanış sınırlarına ulaş.
        vm.warp(block.timestamp + (dt % 3 == 0 ? bound(dt, 1 hours, 3 days) : bound(dt, 1, 40 minutes)));
    }

    function tighten(uint64 dc) external {
        uint64 c = uint64(bound(dc, effMaxOrderTL, effCycleTL));
        IFlightPlan.Plan memory p = _planFor(c, effMaxOrderTL);
        vm.prank(user);
        fp.setPlan(p);
        effCycleTL = c;
        revoked = false;
        pendingSetAt = 0;
        (, uint64 at) = fp.pending(user);
        if (at != 0) _flag("siki plan bekleyeni silmedi");
    }

    function loosen(uint64 extra) external {
        uint64 c = effCycleTL + uint64(bound(extra, 1, 5_000));
        uint64 m = effMaxOrderTL + 1_000 > c ? c : effMaxOrderTL + 1_000;
        IFlightPlan.Plan memory p = _planFor(c, m);
        vm.prank(user);
        fp.setPlan(p);
        (, uint64 at) = fp.pending(user);
        if (at != block.timestamp + 24 hours) _flag("gevsek plan beklemeye girmedi");
        if (fp.plans(user).cycleTL != effCycleTL) _flag("gevsek plan hemen etkin oldu");
        pendingSetAt = block.timestamp;
        pendingCycleTL = c;
        pendingMaxOrderTL = m;
    }

    function commit() external {
        try fp.commitPending(user) {
            if (pendingSetAt == 0) _flag("commit: silinmis bekleyen etkinlesti");
            if (block.timestamp < pendingSetAt + 24 hours) _flag("commit: 24 saatten erken");
            effCycleTL = pendingCycleTL;
            effMaxOrderTL = pendingMaxOrderTL;
            revoked = false;
            pendingSetAt = 0;
        } catch {
            if (pendingSetAt != 0 && block.timestamp >= pendingSetAt + 24 hours) {
                _flag("commit: hazir bekleyen reddedildi");
            }
        }
    }

    function revoke() external {
        vm.prank(user);
        fp.revoke();
        revoked = true;
        pendingSetAt = 0;
    }

    function unrevoke() external {
        if (!revoked) return;
        IFlightPlan.Plan memory p = fp.plans(user); // prank'ten önce oku
        vm.prank(user);
        fp.setPlan(p); // aynı plan → hemen
        revoked = false;
        pendingSetAt = 0;
    }

    function close() external {
        uint32 cid = fp.currentCycleId();
        bool wasClosed = fp.cycleOf(user, cid).closed;
        try fp.closeCycle(user) {
            ++closedCount;
            IFlightPlan.Cycle memory c = fp.cycleOf(user, cid);
            if (c.closed && !wasClosed && fp.trDay() <= fp.plans(user).deadlineDay) _flag("close: son gun gecmeden");
            for (uint256 i; i < touched.length; ++i) {
                IFlightPlan.Cycle memory t = fp.cycleOf(user, touched[i]);
                if (t.closed && t.reservedTL != 0) _flag("close: acik izinli dongu kapandi");
            }
        } catch {}
    }

    function touchedLength() external view returns (uint256) {
        return touched.length;
    }
}

contract FlightPlanInvariantTest is AdvBase {
    FlightPlanHandler internal h;

    function setUp() public override {
        super.setUp();
        vm.warp(_tr(2026, 10, 20, 12, 0)); // ay sonuna yakın başla: kapanış ve ay dönümü kampanyada görülsün
        IFlightPlan.Plan memory p = _plan();
        p.deadlineDay = 28;
        p.expiresAt = uint64(t0 + 50 * 365 days);
        _set(p);
        h = new FlightPlanHandler(fp, user, agent, kule, p.cycleTL, p.maxOrderTL);
        targetContract(address(h));
    }

    /// @dev F-7/F-8/F-9: her döngüde reservedTL = açık izinler, spentTL = raporlanan dolumlar; handler ihlal görmedi.
    function invariant_F7_rezervVeHarcamaMuhasebesi() public view {
        assertEq(h.violation(), "");
        uint256 n = h.touchedLength();
        for (uint256 i; i < n; ++i) {
            uint32 cid = h.touched(i);
            IFlightPlan.Cycle memory c = fp.cycleOf(user, cid);
            assertEq(c.reservedTL, h.ghostOpen(cid));
            assertEq(c.spentTL, h.ghostFilled(cid));
        }
    }
}
