// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {FlightPlan} from "../src/FlightPlan.sol";

/// @notice A2 (§17.2): FlightPlan'i Fuji'ye dağıtır ve deployments/fuji.json'u yazar (biçim: packages/shared/deployments.ts).
/// @dev    Ortam (contracts/.env, Ek B + DEPLOY.md):
///         DEPLOYER_PRIVATE_KEY   (Ek B) dağıtan EOA'nın özel anahtarı
///         PILOT_AGENT_ADDRESS    PİLOT ajanının herkese açık adresi (yalnız adres; anahtar değil)
///         KULE_REPORTER_ADDRESS  KULE raporlayıcının herkese açık adresi (yalnız adres; anahtar değil)
///         DEPLOYMENTS_OUT        isteğe bağlı çıktı yolu (contracts/'a göre); varsayılan ../deployments/fuji.json
///         DEPLOY_LOCAL=1         yalnız yerel Anvil için (kabuk değişkeni); bkz. deploy()
/// TODO(spec): Ek B, PİLOT/KULE adreslerinin contracts/.env alan adlarını vermiyor; en dar seçim: yalnız herkese açık
///             adresler (PILOT_AGENT_ADDRESS, KULE_REPORTER_ADDRESS). Dağıtıcı bu cüzdanların anahtarını hiç görmez.
contract Deploy is Script {
    uint256 public constant FUJI_CHAIN_ID = 43113;
    uint256 public constant ANVIL_CHAIN_ID = 31337;
    string public constant DEFAULT_OUT = "../deployments/fuji.json";

    // ERC-8004 resmî kayıtları, Fuji (Ek B, §8.5). packages/shared ERC8004_FUJI ile aynı olmalı.
    address public constant ERC8004_IDENTITY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    address public constant ERC8004_REPUTATION = 0x8004B663056A597Dffe9eCcC1965A193B7388713;
    address public constant ERC8004_VALIDATION = 0x8004Cb1BF31DAf7788923b405b754f57acEB4272;

    struct Config {
        uint256 deployerKey;
        address pilotAgent;
        address kuleReporter;
        string out; // boş = DEFAULT_OUT (yalnız yerel olmayan dağıtımda)
        bool local;
    }

    error WrongChain(uint256 chainId);
    error BadLocalFlag(uint256 value);
    error BadRole(string role);
    error RegistryMissing(address registry);
    error LocalOutRequired();
    error OutputExists(string path);

    function run() external returns (address) {
        return deploy(loadConfig());
    }

    /// @notice Ortamı okur; doğrulama deploy()'dadır.
    function loadConfig() public view returns (Config memory c) {
        uint256 flag = vm.envOr("DEPLOY_LOCAL", uint256(0));
        if (flag > 1) revert BadLocalFlag(flag);
        c.local = flag == 1;
        c.deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        c.pilotAgent = vm.envAddress("PILOT_AGENT_ADDRESS");
        c.kuleReporter = vm.envAddress("KULE_REPORTER_ADDRESS");
        c.out = vm.envOr("DEPLOYMENTS_OUT", string(""));
    }

    /// @notice Fail-closed: emin olmadığı her durumda dağıtmadan ve dosya yazmadan revert eder.
    function deploy(Config memory c) public returns (address flightPlan) {
        // 1) Zincir: yalnız Fuji. DEPLOY_LOCAL=1 yalnız Anvil'e (31337 ya da --chain-id 43113) izin verir, ana ağa asla.
        bool chainOk = block.chainid == FUJI_CHAIN_ID || (c.local && block.chainid == ANVIL_CHAIN_ID);
        if (!chainOk) revert WrongChain(block.chainid);

        // 2) Roller: üç ayrı cüzdan (§6.1 #6), sıfır adres yok.
        address deployer = vm.addr(c.deployerKey);
        if (c.pilotAgent == address(0)) revert BadRole("PILOT_AGENT_ADDRESS");
        if (c.kuleReporter == address(0)) revert BadRole("KULE_REPORTER_ADDRESS");
        if (c.pilotAgent == c.kuleReporter) revert BadRole("PILOT_AGENT_ADDRESS == KULE_REPORTER_ADDRESS");
        if (c.pilotAgent == deployer || c.kuleReporter == deployer) revert BadRole("DEPLOYER ayri cuzdan olmali");

        // 3) Gerçek Fuji'de ERC-8004 kayıtları canlı olmalı (§8.5). Düz Anvil'de kod yoktur; yerel bayrakla atlanır.
        if (!c.local) {
            _requireCode(ERC8004_IDENTITY);
            _requireCode(ERC8004_REPUTATION);
            _requireCode(ERC8004_VALIDATION);
        }

        // 4) Çıktı yolu: yerel dağıtım gerçek fuji.json'u asla yazmaz; var olan dosyanın üzerine yazılmaz
        //    (A3'ün agentId'si kaybolmasın; yeniden dağıtımda eski dosyayı elle taşı).
        string memory out = c.out;
        if (c.local) {
            if (!isAllowedLocalOut(out)) revert LocalOutRequired();
        } else if (bytes(out).length == 0) {
            out = DEFAULT_OUT;
        }
        if (vm.exists(out)) revert OutputExists(out);

        // deployBlock: betiğin çalıştığı blok; işlem bundan sonraki bir bloğa girer. Olay taraması için alt sınır.
        uint256 deployBlock = block.number;

        vm.startBroadcast(c.deployerKey);
        flightPlan = address(new FlightPlan());
        vm.stopBroadcast();

        string memory json = _json(flightPlan, deployBlock, deployer, c.pilotAgent, c.kuleReporter);
        // Kuru çalıştırmada (--broadcast yok) işlem zincire gitmez: dosya yazılmaz, yalnız gösterilir.
        if (vm.isContext(VmSafe.ForgeContext.ScriptDryRun)) {
            console2.log("Kuru calistirma: dosya yazilmadi. --broadcast ile tekrar calistir.");
        } else {
            vm.writeJson(json, out);
            console2.log("Yazildi:", out);
        }
        console2.log(json);
    }

    /// @notice Yerel çıktı yalnız gizli (nokta ile başlayan) bir dosya adı olabilir, ör. ../deployments/.anvil.json.
    /// @dev Yol karşılaştırması yapılmaz: ./, //, ../x/.. takma adları ve büyük/küçük harf duyarsız dosya sistemi
    ///      (Fuji.json, FUJI.JSON) dize karşılaştırmasını aşar. Son bölüm "." ile başlıyorsa hiçbir yazımda fuji.json
    ///      olamaz. ".", ".." ve "/" ile biten yol (dizin) reddedilir.
    function isAllowedLocalOut(string memory out) public pure returns (bool) {
        bytes memory b = bytes(out);
        uint256 start;
        for (uint256 i; i < b.length; i++) {
            if (b[i] == "/") start = i + 1;
        }
        uint256 len = b.length - start;
        if (len < 2 || b[start] != ".") return false;
        return !(len == 2 && b[start + 1] == ".");
    }

    function _requireCode(address a) internal view {
        if (a.code.length == 0) revert RegistryMissing(a);
    }

    /// @dev Alanlar packages/shared/deployments.ts DeploymentsSchema ile birebir. agentId'yi A3 ekler.
    function _json(address flightPlan, uint256 deployBlock, address deployer, address pilotAgent, address kuleReporter)
        internal
        returns (string memory)
    {
        string memory reg = "erc8004";
        vm.serializeAddress(reg, "identity", ERC8004_IDENTITY);
        vm.serializeAddress(reg, "reputation", ERC8004_REPUTATION);
        string memory regJson = vm.serializeAddress(reg, "validation", ERC8004_VALIDATION);

        string memory root = "deployments";
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeAddress(root, "flightPlan", flightPlan);
        vm.serializeUint(root, "deployBlock", deployBlock);
        vm.serializeAddress(root, "deployer", deployer);
        vm.serializeAddress(root, "pilotAgent", pilotAgent);
        vm.serializeAddress(root, "kuleReporter", kuleReporter);
        return vm.serializeString(root, "erc8004", regJson);
    }
}
