// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";

/// @notice A2 (§17.2) Deploy.s.sol için saldırgan (adversarial) testler.
///         TODO(spec): §18'de dağıtım için kimlik yok; test adları adım kimliği A2 ile başlar.
/// @dev    Ortamı (setEnv) okuyan testler Deploy.t.sol test_A2_loadConfig_readsEnv içindedir (süreç geneli yarış).
///         Geçici dosyalar yalnız ../deployments/.deploy-test-adv-*.json; gerçek fuji.json'u bu dosya asla bırakmaz.
contract DeployAdversarialTest is Test {
    Deploy internal script;

    uint256 internal deployerKey;
    address internal deployer;
    address internal pilotAgent = makeAddr("pilotAgent");
    address internal kuleReporter = makeAddr("kuleReporter");

    // secp256k1 grup mertebesi: geçerli özel anahtar 1 ≤ k < N.
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    function setUp() public {
        script = new Deploy();
        (deployer, deployerKey) = makeAddrAndKey("deployer");
    }

    function _out(string memory name) internal returns (string memory p) {
        p = string.concat("../deployments/.deploy-test-adv-", name, ".json");
        if (vm.exists(p)) vm.removeFile(p);
    }

    function _cfg(string memory out, bool local) internal view returns (Deploy.Config memory) {
        return Deploy.Config({
            deployerKey: deployerKey, pilotAgent: pilotAgent, kuleReporter: kuleReporter, out: out, local: local
        });
    }

    function _etchRegistries() internal {
        vm.etch(script.ERC8004_IDENTITY(), hex"00");
        vm.etch(script.ERC8004_REPUTATION(), hex"00");
        vm.etch(script.ERC8004_VALIDATION(), hex"00");
    }

    function _contains(string memory hay, string memory needle) internal pure returns (bool) {
        bytes memory h = bytes(hay);
        bytes memory n = bytes(needle);
        if (n.length == 0 || n.length > h.length) return n.length == 0;
        for (uint256 i; i <= h.length - n.length; i++) {
            bool m = true;
            for (uint256 j; j < n.length; j++) {
                if (h[i + j] != n[j]) {
                    m = false;
                    break;
                }
            }
            if (m) return true;
        }
        return false;
    }

    // ---------------------------------------------------------------- çıktı yolu

    /// Yerel bayrak, gerçek fuji.json'u yol takma adıyla (./, //, ../x/..) ya da harf büyüklüğüyle (APFS büyük/küçük
    /// harf duyarsız) da yazamamalı. Aksi hâlde `anvil --chain-id 43113` dağıtımı chainId 43113 taşıyan sahte bir
    /// fuji.json üretir; parseDeployments bunu kabul eder ve web/PİLOT Fuji'de kodu olmayan bir adrese yönlenir.
    /// @dev Saf denetim: deploy() fuji.json'a çözülen yollarla çağrılmaz, gerçek dosyaya hiç dokunulmaz.
    function test_A2_adv_local_pathAliasOfDefaultFujiJson_reverts() public view {
        string[8] memory rejected = [
            "../deployments/./fuji.json",
            "../deployments//fuji.json",
            "./../deployments/fuji.json",
            "../deployments/../deployments/fuji.json",
            "../deployments/Fuji.json",
            "../deployments/FUJI.JSON",
            "../deployments/fuji.json",
            "fuji.json"
        ];
        for (uint256 i; i < rejected.length; i++) {
            assertFalse(script.isAllowedLocalOut(rejected[i]), rejected[i]);
        }
        string[6] memory degenerate = ["", ".", "..", "../deployments/", "../deployments/.", "../deployments/.."];
        for (uint256 i; i < degenerate.length; i++) {
            assertFalse(script.isAllowedLocalOut(degenerate[i]), degenerate[i]);
        }
        string[4] memory allowed =
            ["../deployments/.anvil.json", "../deployments/.deploy-test-local.json", ".x", "../deployments/./.a.json"];
        for (uint256 i; i < allowed.length; i++) {
            assertTrue(script.isAllowedLocalOut(allowed[i]), allowed[i]);
        }
    }

    /// Uçtan uca: gizli olmayan bir takma ad yolu deploy() içinde LocalOutRequired ile durur ve dosya yazılmaz.
    /// @dev Bekçi adı x-fuji.json'dur; gerileme olsa bile gerçek fuji.json'a asla çözülmez.
    function test_A2_adv_local_nonHiddenAlias_revertsNoFile() public {
        string memory sentinel = "../deployments/./x-fuji.json";
        if (vm.exists(sentinel)) vm.removeFile(sentinel);
        vm.expectRevert(Deploy.LocalOutRequired.selector);
        script.deploy(_cfg(sentinel, true));
        assertFalse(vm.exists(sentinel));
    }

    /// Var olan dosya, takma adla verilse de ezilmez (A3 agentId'si korunur).
    function test_A2_adv_existingOutput_viaPathAlias_notOverwritten() public {
        string memory p = _out("alias");
        string memory aliasPath = "../deployments/./.deploy-test-adv-alias.json";
        vm.writeFile(p, '{"agentId":"17"}');
        vm.expectRevert(abi.encodeWithSelector(Deploy.OutputExists.selector, aliasPath));
        script.deploy(_cfg(aliasPath, true));
        assertEq(vm.readFile(p), '{"agentId":"17"}');
        vm.removeFile(p);
    }

    /// Fuji (yerel olmayan) dağıtımda da var olan çıktı korunur; denetim kayıt kontrolünden sonra da çalışır.
    function test_A2_adv_fuji_existingOutput_notOverwritten() public {
        vm.chainId(43113);
        _etchRegistries();
        string memory p = _out("fuji-exists");
        vm.writeFile(p, "x");
        vm.expectRevert(abi.encodeWithSelector(Deploy.OutputExists.selector, p));
        script.deploy(_cfg(p, false));
        assertEq(vm.readFile(p), "x");
        vm.removeFile(p);
    }

    // ---------------------------------------------------------------- zincir

    /// Yerel bayrak + varsayılan çıktı Fuji kimliğinde de reddedilir (anvil --chain-id 43113 senaryosu).
    function test_A2_adv_local_onFujiChainId_defaultOut_reverts() public {
        vm.chainId(43113);
        vm.expectRevert(Deploy.LocalOutRequired.selector);
        script.deploy(_cfg("", true));
    }

    /// Kayıtlar kısmen varsa (yalnız Identity) Fuji dağıtımı yine durur.
    function test_A2_adv_fuji_partialRegistries_reverts() public {
        vm.chainId(43113);
        vm.etch(script.ERC8004_IDENTITY(), hex"00");
        vm.etch(script.ERC8004_REPUTATION(), hex"00");
        string memory out = _out("partial");
        vm.expectRevert(abi.encodeWithSelector(Deploy.RegistryMissing.selector, script.ERC8004_VALIDATION()));
        script.deploy(_cfg(out, false));
        assertFalse(vm.exists(out));
    }

    /// Avalanche ana ağı ve sık L1/L2'ler, kayıtlar "varmış gibi" olsa ve yerel bayrak açık olsa da reddedilir.
    function test_A2_adv_mainnets_rejected_evenWithRegistriesAndLocalFlag() public {
        _etchRegistries();
        string memory out = _out("mainnet");
        uint256[5] memory bad = [uint256(43114), 1, 10, 42161, 137];
        for (uint256 i; i < bad.length; i++) {
            vm.chainId(bad[i]);
            vm.expectRevert(abi.encodeWithSelector(Deploy.WrongChain.selector, bad[i]));
            script.deploy(_cfg(out, false));
            vm.expectRevert(abi.encodeWithSelector(Deploy.WrongChain.selector, bad[i]));
            script.deploy(_cfg(out, true));
        }
        assertFalse(vm.exists(out));
    }

    // ---------------------------------------------------------------- roller ve anahtar

    function test_A2_adv_kuleReporterEqualsDeployer_reverts() public {
        Deploy.Config memory c = _cfg(_out("kd"), true);
        c.kuleReporter = deployer;
        vm.expectRevert(abi.encodeWithSelector(Deploy.BadRole.selector, "DEPLOYER ayri cuzdan olmali"));
        script.deploy(c);
        assertFalse(vm.exists(c.out));
    }

    /// Geçersiz özel anahtar (0 ya da ≥ N) dosya yazmadan durur.
    function test_A2_adv_invalidDeployerKey_reverts_noFile() public {
        Deploy.Config memory c = _cfg(_out("badkey"), true);
        uint256[3] memory bad = [uint256(0), SECP256K1_N, type(uint256).max];
        for (uint256 i; i < bad.length; i++) {
            c.deployerKey = bad[i];
            vm.expectRevert();
            script.deploy(c);
        }
        assertFalse(vm.exists(c.out));
    }

    // ---------------------------------------------------------------- JSON biçimi (packages/shared DeploymentsSchema)

    /// chainId/deployBlock JSON sayısı (string değil), adresler EIP-55 checksum'lı, anahtar kümesi şemayla birebir,
    /// dosyada anahtar malzemesi yok.
    function test_A2_adv_json_typesChecksumKeysetNoKey() public {
        vm.chainId(43113);
        vm.roll(41_234_567);
        _etchRegistries();
        string memory out = _out("format");
        address fp = script.deploy(_cfg(out, false));
        string memory j = vm.readFile(out);
        vm.removeFile(out);

        // Sayılar tırnaksız (z.literal(43113) ve z.int() string'i reddeder).
        assertFalse(_contains(j, '"43113"'), "chainId string olmamali");
        assertFalse(_contains(j, '"41234567"'), "deployBlock string olmamali");
        assertTrue(_contains(j, "43113"));
        assertTrue(_contains(j, "41234567"));

        // EIP-55: vm.toString(address) checksum'lı yazar; viem isAddress karışık harfte checksum ister.
        address[7] memory addrs = [
            fp,
            deployer,
            pilotAgent,
            kuleReporter,
            script.ERC8004_IDENTITY(),
            script.ERC8004_REPUTATION(),
            script.ERC8004_VALIDATION()
        ];
        for (uint256 i; i < addrs.length; i++) {
            assertTrue(_contains(j, string.concat('"', vm.toString(addrs[i]), '"')), vm.toString(addrs[i]));
        }

        // Anahtar kümesi: DeploymentsSchema alanları (agentId A3'e kadar yok), erc8004 strictObject.
        string[] memory keys = vm.parseJsonKeys(j, "$");
        string[7] memory want =
            ["chainId", "deployBlock", "deployer", "erc8004", "flightPlan", "kuleReporter", "pilotAgent"];
        assertEq(keys.length, want.length, "ust duzey alan sayisi");
        for (uint256 i; i < want.length; i++) {
            assertTrue(vm.keyExistsJson(j, string.concat(".", want[i])), want[i]);
        }
        assertEq(vm.parseJsonKeys(j, ".erc8004").length, 3, "erc8004 alan sayisi");

        // Anahtar sızıntısı yok (hex ve ondalık biçim).
        assertFalse(_contains(j, vm.toString(bytes32(deployerKey))), "hex anahtar");
        assertFalse(_contains(j, _lowerNo0x(vm.toString(bytes32(deployerKey)))), "0x'siz hex anahtar");
        assertFalse(_contains(j, vm.toString(deployerKey)), "ondalik anahtar");
    }

    function _lowerNo0x(string memory s) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        bytes memory r = new bytes(b.length - 2);
        for (uint256 i = 2; i < b.length; i++) {
            r[i - 2] = b[i];
        }
        return string(r);
    }

    /// deployBlock betiğin çalıştığı bloktur; işlem bundan sonraki bloğa girer → olay taraması için alt sınır.
    function test_A2_adv_deployBlock_isLowerBound() public {
        vm.roll(777);
        string memory out = _out("block");
        script.deploy(_cfg(out, true));
        uint256 deployBlock = vm.parseJsonUint(vm.readFile(out), ".deployBlock");
        vm.removeFile(out);
        assertLe(deployBlock, block.number);
        assertEq(deployBlock, 777);
    }
}
