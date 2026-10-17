// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IFlightPlan — Uçuş Planı arayüzü (SPEC v4.1 §8.1, A0.2'de donduruldu)
/// @notice Elif'in imzaladığı plan; PİLOT yalnız bu plan içinde alım izni isteyebilir,
///         KULE yalnız zincirde BuyAuthorized olan izni uygular ve sonucunu raporlar.
/// @dev Birimler (§7): TL = tam lira (uint64), fiyat = pxE6 (fiyat × 10^6), zaman = unix saniye.
///      Gün/ay Türkiye saatine göredir (sabit UTC+3): DateTimeLib.timestampToDate(block.timestamp + 3 hours).
///      Sabitler (§8.2–§8.3): bekleyen plan kilidi 24 saat; openBy = now + 15 dakika; reportBy = openBy + 60 dakika.
///      Yapı ve fonksiyon parametrelerindeki uint8 alanlar bilerek enum değildir: ABI'de uint8 olarak kalırlar ve
///      geçersiz değer (ör. ordType > 1) çözümlemede revert etmek yerine ret kodu (BAD_ORDTYPE) üretebilir.
///      Aşağıdaki enum'lar yalnız bu uint8 değerlerin anlamını sabitler.
interface IFlightPlan {
    // ─────────────────────────────── Enum'lar ───────────────────────────────

    /// @notice BuyAction.ordType / requestBuy.ordType değerleri.
    enum OrdType {
        POST_ONLY, // 0 — yapıcı (post_only)
        IOC // 1 — hemen (ioc)
    }

    /// @notice BuyAction.state değerleri.
    /// @dev Var olmayan izin de state = 0 okunur; varlık kontrolü `user != address(0)` ile yapılır.
    enum ActionState {
        AUTHORIZED, // 0
        REPORTED, // 1
        EXPIRED // 2
    }

    /// @notice reportExecution.status / BuyExecuted.status değerleri (§8.4).
    enum ExecStatus {
        FILLED, // 0
        PARTIAL, // 1
        CANCELED, // 2
        EXPIRED // 3
    }

    /// @notice Plan.askMode değerleri.
    enum AskMode {
        NEVER, // 0 — sorma
        IF_AMBIGUOUS // 1 — belirsizse sor
    }

    /// @notice requestBuy ret kodları (§8.3, tablo sırası). 0 = ret yok.
    enum RejectCode {
        NONE, // 0 — kullanılmaz
        PLAN_INACTIVE, // 1 — plan yok, iptal edilmiş ya da süresi dolmuş
        OUTSIDE_WINDOW, // 2 — trDay < startDay ya da trDay > deadlineDay
        OVER_ORDER_LIMIT, // 3 — amountTL > maxOrderTL
        OVER_CYCLE_TARGET, // 4 — spentTL + reservedTL + amountTL > cycleTL
        PRICE_ABOVE_BAND, // 5 — bant açık ve maxPxE6 > ref × (10000 + bant) / 10000
        PRICE_UNAVAILABLE, // 6 — bant açık ve Pyth fiyatı 72 saatten eski
        BAD_ORDTYPE // 7 — ordType > 1
    }

    // ─────────────────────────────── Yapılar ────────────────────────────────

    struct Plan {
        uint64 cycleTL; // ayda çevrilecek TL
        uint64 maxOrderTL; // tek emir tavanı (TL)
        uint8 startDay; // pencere başı (ayın günü, TR saati)
        uint8 deadlineDay; // bu gün sonuna kadar tamamlanmalı
        uint16 maxWaitH; // fırtınada en fazla bekleme (saat) — PİLOT için, kontrat kaydeder
        uint16 bandBps; // 0 = Pyth bandı kapalı; ör. 300 = referansın en fazla %3 üstü
        uint16 closedBandBps; // FX kapalıyken ya da fiyat eskiyken (ör. 500)
        uint8 askMode; // 0 sorma, 1 belirsizse sor (AskMode)
        uint64 expiresAt; // planın bitişi (unix sn)
        address agent; // PİLOT adresi: requestBuy çağırabilir
        address kule; // KULE_REPORTER adresi: reportExecution çağırabilir
        uint256 agentId; // PİLOT'un ERC-8004 kimliği
    }

    struct Cycle {
        uint32 id; // YYYYMM (TR saati)
        uint64 spentTL;
        uint64 reservedTL;
        bool closed;
    }

    struct BuyAction {
        address user;
        uint64 amountTL;
        uint64 maxPxE6;
        uint8 ordType; // 0 post_only, 1 ioc (OrdType)
        uint64 openBy; // KULE emri bu ana kadar açmalı (unix sn)
        uint64 reportBy; // rapor bu ana kadar yazılabilir (unix sn)
        uint32 cycleId;
        uint8 state; // 0 AUTHORIZED, 1 REPORTED, 2 EXPIRED (ActionState)
    }

    // ─────────────────────────────── Olaylar ────────────────────────────────

    /// @param immediate true ise plan hemen etkin; false ise bekleyen plan, activeAt'te commitPending ile etkinleşir.
    event PlanSet(address indexed user, bytes32 planHash, bool immediate, uint64 activeAt);
    event PlanRevoked(address indexed user);
    /// @notice Önceki bekleyen plan silindi (her setPlan ve revoke'ta, bekleyen varsa).
    event PendingCleared(address indexed user);
    /// @param openBy Olaydaki son açılış anı (expiry) openBy'dır.
    /// @dev Kimlik kanıtı değildir: setPlan'i herkes kendi adresi için çağırabilir ve plana istediği agent, kule ve
    ///      agentId'yi yazabilir. Olay yalnız msg.sender == plans(user).agent olduğunu kanıtlar; agentId ve user
    ///      zincir dışında doğrulanmalıdır.
    /// TODO(spec): §9.2 adım 4 kullanıcı bağı — KULE (kule_execute) ayrıca şunları istemeli, değilse RET NO_AUTHORIZATION:
    ///   actions(id).user == yapılandırılmış kullanıcı adresi (PLAN_USER_ADDRESS), plans(user).kule == KULE'nin kendi
    ///   KULE_REPORTER adresi, plans(user).agent == token'ın bağlı olduğu ajan adresi. Zincir dışı uygulama:
    ///   packages/shared/authz.ts checkActionOwner; belge testi: contracts/test/AuthBinding.t.sol.
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
    /// @param code RejectCode (1–7).
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

    // ─────────────────────────────── Hatalar ────────────────────────────────

    /// @notice requestBuy: msg.sender != plan.agent (§8.3, F-5). Rastgele çağıranlar olay üretmez.
    error NotAgent();
    /// @notice reportExecution: msg.sender != plan.kule (§8.4, F-8).
    error NotKule();
    /// @notice reportExecution: filledTL > amountTL (§8.4, F-15).
    error OverFilled();
    /// @notice reportExecution / expireAction: izin yok ya da AUTHORIZED değil (ör. ikinci rapor, F-8).
    error ActionNotAuthorized();
    /// @notice reportExecution: now > reportBy.
    error ReportWindowClosed();
    /// @notice expireAction: now ≤ reportBy (rapor penceresi kapanmadan izin düşürülemez, §8.4).
    error ReportWindowOpen();
    /// @notice setPlan: plan alanları tutarsız.
    /// TODO(spec): SPEC doğrulama kurallarını listelemiyor. En dar öneri (A1'de uygulanacak):
    ///   cycleTL > 0, 0 < maxOrderTL ≤ cycleTL, 1 ≤ startDay ≤ deadlineDay ≤ 28, askMode ≤ 1,
    ///   expiresAt > now, agent != 0, kule != 0.
    error InvalidPlan();
    /// @notice revoke: kullanıcının ne kayıtlı (etkin ya da süresi dolmuş) planı ne de bekleyen planı var.
    /// @dev Etkin plan olmaması tek başına revert sebebi değildir: süresi dolmuş plan + bekleyen plan durumunda
    ///      revoke bekleyen planı yine siler (§8.2, F-13; "Her şeyi durdur" fail-closed kalmalı).
    error NoPlan();
    /// @notice commitPending: bekleyen plan yok (silinmiş ya da hiç kurulmamış, F-12/F-13).
    /// TODO(spec): F-12 "commitPending hiçbir şey yapmaz" diyor; burada fail-closed revert seçildi.
    error NoPendingPlan();
    /// @notice commitPending: activeAt henüz gelmedi.
    error PendingNotReady();
    /// @notice closeCycle: döngünün son günü (deadlineDay, TR saati) henüz geçmedi ya da döngüde hâlâ açık izin
    ///         (reservedTL > 0) var. Açık izinler raporlanmalı ya da expireAction ile düşürülmeli (§8.4: dolmuş bir
    ///         emir aylık toplamın dışında kalamaz).
    /// TODO(spec): §8.4 açık izinli döngünün kapatılmasını tanımlamıyor; fail-closed olarak kapatma engellendi.
    error CycleNotOver();
    /// @notice closeCycle: döngü zaten kapalı.
    error CycleAlreadyClosed();
    /// @notice reportExecution: status > 3 (ExecStatus dışı).
    /// TODO(spec): §8.4 geçersiz status için davranış vermiyor; fail-closed revert seçildi.
    error InvalidStatus();
    /// @notice requestBuy: msg.value > 0. Pyth (A5) yokken ücret alınmaz; kontratta takılı AVAX kalmasın.
    /// TODO(spec): A5 (Pyth) eklenince yalnız pythUpdate ücreti kadar değer kabul edilecek.
    error ValueNotAccepted();

    // ─────────────────────────────── Yazma ──────────────────────────────────

    /// @notice Planı kurar ya da değiştirir (msg.sender = kullanıcı, Elif). §8.2:
    ///   - Kontrat çağıranın Elif olduğunu bilmez: her adres kendi planını kurabilir (bkz. BuyAuthorized TODO(spec)).
    ///   - Plan yoksa ya da yeni plan her alanda eşit/daha sıkıysa hemen etkin olur.
    ///   - Aksi halde bekleyen plan olur; activeAt = now + 24 saat.
    ///   - Her çağrı varsa önceki bekleyen planı siler (PendingCleared).
    function setPlan(Plan calldata p) external;

    /// @notice Herkes çağırabilir; bekleyen plan hâlâ duruyorsa ve activeAt geçtiyse onu etkinleştirir.
    function commitPending(address user) external;

    /// @notice Kullanıcı; anında etkili. Plan pasifleşir, bekleyen plan da silinir (§8.2).
    /// @dev Etkin plan olmasa da (ör. süresi dolmuş) çalışır: bekleyen plan varsa her zaman silinir
    ///      (PendingCleared), kayıtlı plan varsa pasifleşir (PlanRevoked). Yalnız ikisi de yoksa revert NoPlan.
    function revoke() external;

    /// @notice PİLOT'un alım izni isteği (§8.3). msg.sender == plan.agent olmalı, değilse revert NotAgent.
    ///         Diğer ihlallerde revert yok: BuyRejected yayılır ve 0 döner.
    /// @param ordType 0 post_only, 1 ioc; > 1 ise ret kodu 7.
    /// @param pythUpdate Boş değilse Pyth ücreti ödenip fiyat güncellenir (yalnız bandBps > 0 iken anlamlı).
    /// @return actionId Başarıda > 0; retle 0.
    function requestBuy(
        address user,
        uint64 amountTL,
        uint64 maxPxE6,
        uint8 ordType,
        bytes32 reasonHash,
        bytes[] calldata pythUpdate
    ) external payable returns (uint256 actionId);

    /// @notice KULE'nin emir sonucu raporu (§8.4). msg.sender == plan.kule; izin AUTHORIZED ve now ≤ reportBy
    ///         (openBy geçmiş olsa da kabul). filledTL ≤ amountTL. spentTL += filledTL, reservedTL −= amountTL.
    /// @param status 0 FILLED, 1 PARTIAL, 2 CANCELED, 3 EXPIRED (ExecStatus).
    function reportExecution(
        uint256 actionId,
        string calldata ordId,
        uint64 filledTL,
        uint64 avgPxE6,
        uint8 status,
        bytes32 reportHash
    ) external;

    /// @notice Herkes; yalnız now > reportBy ve izin raporlanmamışsa. reservedTL iade edilir.
    function expireAction(uint256 actionId) external;

    /// @notice Herkes; son gün geçtiyse döngüyü kapatır (ok = spentTL ≥ cycleTL). Yeni ay ilk çağrıda açılır.
    /// @dev Hedef: en son açılan döngü kapanmamışsa o; yoksa bu ayın döngüsü (hiç izin olmasa da kapatılabilir,
    ///      ok = false). Kayıtlı plan yoksa revert NoPlan; açık izin varsa revert CycleNotOver.
    function closeCycle(address user) external;

    // ─────────────────────────────── Okuma ──────────────────────────────────

    /// @notice Şu anki döngü kimliği, YYYYMM (TR saati).
    function currentCycleId() external view returns (uint32);

    /// @notice Ayın günü (1–31, TR saati). UTC 21:00'de bir sonraki güne geçer (F-10).
    function trDay() external view returns (uint8);

    /// @notice Kullanıcının kayıtlı (bekleyen değil, yürürlükteki) planı; hiç plan yoksa sıfır değerli.
    /// @dev İptal edilmiş ya da süresi dolmuş plan da döner (KULE açık izni hâlâ raporlayabilsin diye kule adresi
    ///      saklanır). Aktiflik için isPlanActive kullanılır.
    function plans(address user) external view returns (Plan memory);

    /// @notice Kullanıcının bekleyen planı ve etkinleşme anı (activeAt == 0 ise bekleyen yok).
    function pending(address user) external view returns (Plan memory plan, uint64 activeAt);

    /// @notice Kullanıcının şu anki ay (TR saati) döngüsü. Bu ay henüz açılmadıysa id = currentCycleId() ve
    ///         sıfır harcama döner (PİLOT yeni ayda eski ayın toplamını görmesin).
    function cycles(address user) external view returns (Cycle memory);

    /// @notice Belirli bir ayın döngüsü (id = YYYYMM). Açılmamışsa sıfır değerli (id = 0).
    /// TODO(spec): §8.1'de yok; önceki ayın kapanışını ve aya bağlı raporları okumak için eklendi.
    function cycleOf(address user, uint32 cycleId) external view returns (Cycle memory);

    /// @notice İzin kaydı (user == address(0) ise yok).
    function actions(uint256 actionId) external view returns (BuyAction memory);

    /// @notice Plan var, iptal edilmemiş ve süresi dolmamış mı (§9.2 adım 4: KULE "plan aktif mi" kontrolü).
    /// TODO(spec): §8.1'de yok; KULE'nin aktiflik mantığını zincir dışında yeniden kurmaması için eklendi.
    function isPlanActive(address user) external view returns (bool);
}
