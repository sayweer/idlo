// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DateTimeLib} from "solady/utils/DateTimeLib.sol";
import {IFlightPlan} from "./interfaces/IFlightPlan.sol";

/// @title FlightPlan — Uçuş Planı (SPEC v4.1 §8.1–§8.4), Pyth'siz (A1)
/// @notice Elif planı kurar; PİLOT yalnız plan içinde alım izni ister; KULE yalnız BuyAuthorized izni uygular ve raporlar.
/// @dev Bant (bandBps > 0) bu sürümde fiyat kaynağı olmadığı için fail-closed: her istek PRICE_UNAVAILABLE (6) alır.
///      TODO(spec): A5'te Pyth (§8.3) eklenecek.
contract FlightPlan is IFlightPlan {
    // ─────────────────────────────── Sabitler ───────────────────────────────

    uint64 public constant PENDING_DELAY = 24 hours; // §8.2
    uint64 public constant OPEN_WINDOW = 15 minutes; // §8.3: openBy = now + 15 dk
    uint64 public constant REPORT_WINDOW = 60 minutes; // §8.3: reportBy = openBy + 60 dk
    uint256 internal constant TR_OFFSET = 3 hours; // §7: Türkiye sabit UTC+3
    // TODO(spec): §8.1 gün aralığını vermiyor; her ayda var olan günlerle sınırlandı.
    uint8 internal constant MAX_DAY = 28;

    // ─────────────────────────────── Durum ──────────────────────────────────

    mapping(address => Plan) internal _plans;
    mapping(address => bool) internal _revoked;
    mapping(address => Plan) internal _pendingPlans;
    mapping(address => uint64) internal _pendingAt; // 0 = bekleyen yok
    mapping(address => mapping(uint32 => Cycle)) internal _cycleOf;
    /// @dev closeCycle'ın bakacağı döngü: kapanmamış en eski açılmış döngü (yoksa en son kapanan).
    /// TODO(spec): §8.4 ay atlanırsa (kapanmamış iki eski ay) arada kalan ay kapanış olayı almayabilir.
    mapping(address => uint32) internal _closeCursor;
    mapping(uint256 => BuyAction) internal _actions;
    uint256 public lastActionId; // izinler 1'den başlar; 0 = ret

    // ─────────────────────────────── Plan ───────────────────────────────────

    /// @inheritdoc IFlightPlan
    function setPlan(Plan calldata p) external {
        _validate(p);
        address user = msg.sender;
        _clearPending(user);

        Plan storage cur = _plans[user];
        bytes32 planHash = keccak256(abi.encode(p));
        // TODO(spec): §8.2 "planı yoksa" iptal edilmiş ya da süresi dolmuş planı kapsamıyor. Fail-closed: kayıtlı her
        // plan (iptal/süresi dolmuş dahil) karşılaştırma tabanıdır; gevşeme yine 24 saat bekler.
        if (cur.agent == address(0) || _isTighterOrEqual(cur, p)) {
            _plans[user] = p;
            _revoked[user] = false;
            emit PlanSet(user, planHash, true, uint64(block.timestamp));
        } else {
            uint64 activeAt = uint64(block.timestamp) + PENDING_DELAY;
            _pendingPlans[user] = p;
            _pendingAt[user] = activeAt;
            emit PlanSet(user, planHash, false, activeAt);
        }
    }

    /// @inheritdoc IFlightPlan
    function commitPending(address user) external {
        uint64 activeAt = _pendingAt[user];
        if (activeAt == 0) revert NoPendingPlan();
        if (block.timestamp < activeAt) revert PendingNotReady();

        Plan memory p = _pendingPlans[user];
        _plans[user] = p;
        _revoked[user] = false;
        delete _pendingPlans[user];
        delete _pendingAt[user];
        emit PlanSet(user, keccak256(abi.encode(p)), true, activeAt);
    }

    /// @inheritdoc IFlightPlan
    function revoke() external {
        address user = msg.sender;
        bool hasPlan = _plans[user].agent != address(0);
        bool hadPending = _clearPending(user);
        if (!hasPlan && !hadPending) revert NoPlan();
        if (hasPlan) {
            _revoked[user] = true;
            emit PlanRevoked(user);
        }
    }

    // ─────────────────────────────── İzin ───────────────────────────────────

    /// @inheritdoc IFlightPlan
    function requestBuy(
        address user,
        uint64 amountTL,
        uint64 maxPxE6,
        uint8 ordType,
        bytes32 reasonHash,
        bytes[] calldata /* pythUpdate: A5 */
    ) external payable returns (uint256 actionId) {
        Plan storage p = _plans[user];
        if (msg.sender != p.agent) revert NotAgent();
        if (msg.value != 0) revert ValueNotAccepted();

        uint32 cid = currentCycleId();
        Cycle storage c = _cycleOf[user][cid];

        uint8 code = _check(user, p, c, amountTL, ordType);
        if (code != uint8(RejectCode.NONE)) {
            emit BuyRejected(user, p.agentId, amountTL, code, reasonHash);
            return 0;
        }

        if (c.id == 0) _openCycle(user, c, cid);
        c.reservedTL += amountTL;
        actionId = _authorize(user, amountTL, maxPxE6, ordType, cid);
        emit BuyAuthorized(actionId, user, p.agentId, amountTL, maxPxE6, ordType, _actions[actionId].openBy, reasonHash);
    }

    /// @inheritdoc IFlightPlan
    function reportExecution(
        uint256 actionId,
        string calldata ordId,
        uint64 filledTL,
        uint64 avgPxE6,
        uint8 status,
        bytes32 reportHash
    ) external {
        BuyAction storage a = _actions[actionId];
        // Var olmayan izinde user = 0, kule = 0 → NotKule.
        if (a.user == address(0) || msg.sender != _plans[a.user].kule) revert NotKule();
        if (a.state != uint8(ActionState.AUTHORIZED)) revert ActionNotAuthorized();
        if (block.timestamp > a.reportBy) revert ReportWindowClosed(); // openBy geçmiş olsa da kabul (§8.4)
        if (filledTL > a.amountTL) revert OverFilled();
        if (status > uint8(ExecStatus.EXPIRED)) revert InvalidStatus();

        Cycle storage c = _cycleOf[a.user][a.cycleId];
        c.spentTL += filledTL;
        c.reservedTL -= a.amountTL;
        a.state = uint8(ActionState.REPORTED);
        emit BuyExecuted(actionId, a.user, ordId, filledTL, avgPxE6, status, reportHash);
    }

    /// @inheritdoc IFlightPlan
    function expireAction(uint256 actionId) external {
        BuyAction storage a = _actions[actionId];
        if (a.user == address(0) || a.state != uint8(ActionState.AUTHORIZED)) revert ActionNotAuthorized();
        if (block.timestamp <= a.reportBy) revert ReportWindowOpen();

        _cycleOf[a.user][a.cycleId].reservedTL -= a.amountTL;
        a.state = uint8(ActionState.EXPIRED);
        // TODO(spec): §8.1'de expireAction olayı yok; durum actions(id) ile okunur.
    }

    /// @inheritdoc IFlightPlan
    function closeCycle(address user) external {
        Plan storage p = _plans[user];
        if (p.agent == address(0)) revert NoPlan();

        uint32 nowId = currentCycleId();
        uint32 id = _closeCursor[user];
        if (id == 0 || _cycleOf[user][id].closed) id = nowId;
        Cycle storage c = _cycleOf[user][id];
        if (c.closed) revert CycleAlreadyClosed();
        if ((id == nowId && trDay() <= p.deadlineDay) || c.reservedTL != 0) revert CycleNotOver();

        if (c.id == 0) _openCycle(user, c, id);
        c.closed = true;
        emit CycleClosed(user, id, c.spentTL, c.spentTL >= p.cycleTL);
    }

    // ─────────────────────────────── Okuma ──────────────────────────────────

    /// @inheritdoc IFlightPlan
    function currentCycleId() public view returns (uint32) {
        (uint256 y, uint256 m,) = DateTimeLib.timestampToDate(block.timestamp + TR_OFFSET);
        // casting to 'uint32' is safe because y < 2^32/100 for any uint64-range timestamp of interest and m ≤ 12
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint32(y * 100 + m);
    }

    /// @inheritdoc IFlightPlan
    function trDay() public view returns (uint8) {
        (,, uint256 d) = DateTimeLib.timestampToDate(block.timestamp + TR_OFFSET);
        // casting to 'uint8' is safe because d ∈ [1, 31]
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint8(d);
    }

    /// @inheritdoc IFlightPlan
    function plans(address user) external view returns (Plan memory) {
        return _plans[user];
    }

    /// @inheritdoc IFlightPlan
    function pending(address user) external view returns (Plan memory plan, uint64 activeAt) {
        return (_pendingPlans[user], _pendingAt[user]);
    }

    /// @inheritdoc IFlightPlan
    function cycles(address user) external view returns (Cycle memory c) {
        uint32 cid = currentCycleId();
        c = _cycleOf[user][cid];
        c.id = cid;
    }

    /// @inheritdoc IFlightPlan
    function cycleOf(address user, uint32 cycleId) external view returns (Cycle memory) {
        return _cycleOf[user][cycleId];
    }

    /// @inheritdoc IFlightPlan
    function actions(uint256 actionId) external view returns (BuyAction memory) {
        return _actions[actionId];
    }

    /// @inheritdoc IFlightPlan
    function isPlanActive(address user) public view returns (bool) {
        Plan storage p = _plans[user];
        return p.agent != address(0) && !_revoked[user] && block.timestamp < p.expiresAt;
    }

    // ─────────────────────────────── İç ─────────────────────────────────────

    /// @dev §8.3 kontrolleri tablo sırasıyla; ilk ihlalin kodu döner (0 = geçti).
    function _check(address user, Plan storage p, Cycle storage c, uint64 amountTL, uint8 ordType)
        internal
        view
        returns (uint8)
    {
        if (!isPlanActive(user)) return uint8(RejectCode.PLAN_INACTIVE);
        uint8 d = trDay();
        // Kapalı döngüde yeni izin yok (ör. kapanıştan sonra pencere bekleyen planla değişirse).
        if (d < p.startDay || d > p.deadlineDay || c.closed) return uint8(RejectCode.OUTSIDE_WINDOW);
        // TODO(spec): amountTL = 0 tabloda yok; "plan dışı tutar" (§16 #5) sayılıp kod 3 verildi.
        if (amountTL == 0 || amountTL > p.maxOrderTL) return uint8(RejectCode.OVER_ORDER_LIMIT);
        if (uint256(c.spentTL) + c.reservedTL + amountTL > p.cycleTL) return uint8(RejectCode.OVER_CYCLE_TARGET);
        // Bant açık ama fiyat kaynağı (Pyth, A5) yok → fiyat doğrulanamaz → fail-closed.
        if (p.bandBps != 0) return uint8(RejectCode.PRICE_UNAVAILABLE);
        if (ordType > uint8(OrdType.IOC)) return uint8(RejectCode.BAD_ORDTYPE);
        return uint8(RejectCode.NONE);
    }

    /// @dev İzin kaydını yazar: openBy = now + 15 dk, reportBy = openBy + 60 dk (§8.3).
    function _authorize(address user, uint64 amountTL, uint64 maxPxE6, uint8 ordType, uint32 cid)
        internal
        returns (uint256 actionId)
    {
        uint64 openBy = uint64(block.timestamp) + OPEN_WINDOW;
        actionId = ++lastActionId;
        _actions[actionId] = BuyAction({
            user: user,
            amountTL: amountTL,
            maxPxE6: maxPxE6,
            ordType: ordType,
            openBy: openBy,
            reportBy: openBy + REPORT_WINDOW,
            cycleId: cid,
            state: uint8(ActionState.AUTHORIZED)
        });
    }

    /// @dev Yeni döngüyü açar; kapanmamış eski döngü varsa closeCycle önce onu kapatsın diye imleç ilerlemez.
    function _openCycle(address user, Cycle storage c, uint32 id) internal {
        c.id = id;
        uint32 cur = _closeCursor[user];
        if (cur == 0 || _cycleOf[user][cur].closed) _closeCursor[user] = id;
    }

    /// @dev Bekleyen planı siler; silindiyse PendingCleared yayar ve true döner.
    function _clearPending(address user) internal returns (bool) {
        if (_pendingAt[user] == 0) return false;
        delete _pendingPlans[user];
        delete _pendingAt[user];
        emit PendingCleared(user);
        return true;
    }

    /// @dev TODO(spec): SPEC doğrulama kurallarını listelemiyor; IFlightPlan.InvalidPlan'daki en dar öneri uygulandı.
    function _validate(Plan calldata p) internal view {
        if (
            p.cycleTL == 0 || p.maxOrderTL == 0 || p.maxOrderTL > p.cycleTL || p.startDay == 0
                || p.startDay > p.deadlineDay || p.deadlineDay > MAX_DAY || p.askMode > uint8(AskMode.IF_AMBIGUOUS)
                || p.expiresAt <= block.timestamp || p.agent == address(0) || p.kule == address(0)
        ) revert InvalidPlan();
    }

    /// @dev §8.2 sıkılık şartları. Yeni plan her alanda eşit ya da daha sıkıysa true.
    function _isTighterOrEqual(Plan storage o, Plan calldata n) internal view returns (bool) {
        return n.cycleTL <= o.cycleTL && n.maxOrderTL <= o.maxOrderTL && n.maxWaitH <= o.maxWaitH
            && n.expiresAt <= o.expiresAt && n.startDay >= o.startDay && n.askMode >= o.askMode
            && _bandTighterOrEqual(o.bandBps, n.bandBps)
            // TODO(spec): §8.2 closedBandBps'i saymıyor; gevşeme kapısı kalmasın diye aynı bant kuralı uygulandı.
            && _bandTighterOrEqual(o.closedBandBps, n.closedBandBps) && n.deadlineDay == o.deadlineDay
            && n.agent == o.agent && n.kule == o.kule && n.agentId == o.agentId;
    }

    /// @dev 0 = bant kapalı (en gevşek). Eski 0 → yeni her değer sıkı; eski > 0 → yeni 0 < yeni ≤ eski olmalı.
    function _bandTighterOrEqual(uint16 oldBps, uint16 newBps) internal pure returns (bool) {
        if (oldBps == 0) return true;
        return newBps != 0 && newBps <= oldBps;
    }
}
