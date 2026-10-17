// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";

/// @notice A2 (§17.2) Deploy.s.sol. TODO(spec): §18'de dağıtım için kimlik yok; test adları adım kimliği A2 ile başlar.
/// @dev    Çıktı her zaman ../deployments/.deploy-test-*.json geçici dosyasıdır (fs_permissions yalnız ../deployments);
///         gerçek fuji.json'a asla dokunulmaz. Ortam değişkeni (setEnv) süreç genelidir; paralel testler yarışmasın diye
///         ortamı yalnız test_A2_loadConfig okur, diğerleri deploy(Config) çağırır.
contract DeployTest is Test {
    Deploy internal script;

    uint256 internal deployerKey;
    address internal deployer;
    address internal pilotAgent = makeAddr("pilotAgent");
    address internal kuleReporter = makeAddr("kuleReporter");

    function setUp() public {
        script = new Deploy();
        (deployer, deployerKey) = makeAddrAndKey("deployer");
    }

    function _out(string memory name) internal returns (string memory p) {
        p = string.concat("../deployments/.deploy-test-", name, ".json");
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

    function _assertJson(string memory out, address fp, uint256 chainId, uint256 deployBlock) internal {
        string memory j = vm.readFile(out);
        assertEq(vm.parseJsonUint(j, ".chainId"), chainId, "chainId");
        assertEq(vm.parseJsonAddress(j, ".flightPlan"), fp, "flightPlan");
        assertEq(vm.parseJsonUint(j, ".deployBlock"), deployBlock, "deployBlock");
        assertEq(vm.parseJsonAddress(j, ".deployer"), deployer, "deployer");
        assertEq(vm.parseJsonAddress(j, ".pilotAgent"), pilotAgent, "pilotAgent");
        assertEq(vm.parseJsonAddress(j, ".kuleReporter"), kuleReporter, "kuleReporter");
        assertEq(vm.parseJsonAddress(j, ".erc8004.identity"), 0x8004A818BFB912233c491871b3d84c89A494BD9e);
        assertEq(vm.parseJsonAddress(j, ".erc8004.reputation"), 0x8004B663056A597Dffe9eCcC1965A193B7388713);
        assertEq(vm.parseJsonAddress(j, ".erc8004.validation"), 0x8004Cb1BF31DAf7788923b405b754f57acEB4272);
        assertFalse(vm.keyExistsJson(j, ".agentId"), "agentId A3'e kadar yok");
        vm.removeFile(out);
    }

    function test_A2_fuji_deploysAndWritesJson() public {
        vm.chainId(43113);
        vm.roll(1234);
        _etchRegistries();
        string memory out = _out("fuji");
        address expected = vm.computeCreateAddress(deployer, vm.getNonce(deployer));

        address fp = script.deploy(_cfg(out, false));

        assertEq(fp, expected, "dagitan EOA'dan CREATE");
        assertGt(fp.code.length, 0, "kod var");
        _assertJson(out, fp, 43113, 1234);
    }

    function test_A2_local_anvil_deploysAndWritesJson() public {
        assertEq(block.chainid, 31337);
        string memory out = _out("local");
        address fp = script.deploy(_cfg(out, true)); // düz Anvil'de ERC-8004 kodu yok; yerel bayrak atlar
        _assertJson(out, fp, 31337, block.number);
    }

    function test_A2_wrongChain_reverts() public {
        string memory out = _out("wrongchain");
        uint256[3] memory bad = [uint256(43114), 1, 8453];
        for (uint256 i; i < bad.length; i++) {
            vm.chainId(bad[i]);
            vm.expectRevert(abi.encodeWithSelector(Deploy.WrongChain.selector, bad[i]));
            script.deploy(_cfg(out, false));
            vm.expectRevert(abi.encodeWithSelector(Deploy.WrongChain.selector, bad[i]));
            script.deploy(_cfg(out, true)); // yerel bayrak ana ağı açmaz
        }
        vm.chainId(31337); // Anvil yerel bayrak olmadan reddedilir
        vm.expectRevert(abi.encodeWithSelector(Deploy.WrongChain.selector, 31337));
        script.deploy(_cfg(out, false));
        assertFalse(vm.exists(out), "dosya yazilmadi");
    }

    function test_A2_fuji_withoutRegistries_reverts() public {
        vm.chainId(43113);
        string memory out = _out("noreg");
        vm.expectRevert(abi.encodeWithSelector(Deploy.RegistryMissing.selector, script.ERC8004_IDENTITY()));
        script.deploy(_cfg(out, false));
        assertFalse(vm.exists(out));
    }

    function test_A2_badRoles_revert() public {
        string memory out = _out("roles");
        Deploy.Config memory c = _cfg(out, true);
        c.pilotAgent = address(0);
        vm.expectRevert(abi.encodeWithSelector(Deploy.BadRole.selector, "PILOT_AGENT_ADDRESS"));
        script.deploy(c);

        c = _cfg(out, true);
        c.kuleReporter = address(0);
        vm.expectRevert(abi.encodeWithSelector(Deploy.BadRole.selector, "KULE_REPORTER_ADDRESS"));
        script.deploy(c);

        c = _cfg(out, true);
        c.kuleReporter = pilotAgent;
        vm.expectRevert(abi.encodeWithSelector(Deploy.BadRole.selector, "PILOT_AGENT_ADDRESS == KULE_REPORTER_ADDRESS"));
        script.deploy(c);

        c = _cfg(out, true);
        c.pilotAgent = deployer;
        vm.expectRevert(abi.encodeWithSelector(Deploy.BadRole.selector, "DEPLOYER ayri cuzdan olmali"));
        script.deploy(c);
        assertFalse(vm.exists(out));
    }

    function test_A2_local_neverWritesDefaultFujiJson() public {
        // Gerçek dağıtımdan sonra fuji.json vardır; test onun varlığını değil, dokunulmadığını denetler.
        bool existed = vm.exists(script.DEFAULT_OUT());
        string memory before = existed ? vm.readFile(script.DEFAULT_OUT()) : "";
        vm.expectRevert(Deploy.LocalOutRequired.selector);
        script.deploy(_cfg("", true));
        Deploy.Config memory c = _cfg(script.DEFAULT_OUT(), true);
        vm.expectRevert(Deploy.LocalOutRequired.selector);
        script.deploy(c);
        assertEq(vm.exists(script.DEFAULT_OUT()), existed, "fuji.json yazilmadi/silinmedi");
        if (existed) assertEq(vm.readFile(script.DEFAULT_OUT()), before, "fuji.json degismedi");
    }

    function test_A2_existingOutput_notOverwritten() public {
        string memory out = _out("exists");
        vm.writeFile(out, '{"agentId":"17"}');
        vm.expectRevert(abi.encodeWithSelector(Deploy.OutputExists.selector, out));
        script.deploy(_cfg(out, true));
        assertEq(vm.readFile(out), '{"agentId":"17"}', "eski dosya korunur");
        vm.removeFile(out);
    }

    /// Ortamı okuyan tek test (Ek B adı DEPLOYER_PRIVATE_KEY + adres alanları + DEPLOY_LOCAL/DEPLOYMENTS_OUT).
    function test_A2_loadConfig_readsEnv() public {
        vm.setEnv("DEPLOYER_PRIVATE_KEY", vm.toString(bytes32(deployerKey)));
        vm.setEnv("PILOT_AGENT_ADDRESS", vm.toString(pilotAgent));
        vm.setEnv("KULE_REPORTER_ADDRESS", vm.toString(kuleReporter));
        vm.setEnv("DEPLOYMENTS_OUT", "../deployments/.deploy-test-env.json");
        vm.setEnv("DEPLOY_LOCAL", "1");
        Deploy.Config memory c = script.loadConfig();
        assertEq(c.deployerKey, deployerKey);
        assertEq(c.pilotAgent, pilotAgent);
        assertEq(c.kuleReporter, kuleReporter);
        assertEq(c.out, "../deployments/.deploy-test-env.json");
        assertTrue(c.local);

        vm.setEnv("DEPLOY_LOCAL", "0");
        assertFalse(script.loadConfig().local);
        vm.setEnv("DEPLOY_LOCAL", "2");
        vm.expectRevert(abi.encodeWithSelector(Deploy.BadLocalFlag.selector, 2));
        script.loadConfig();

        // Adversarial (aynı fonksiyonda: setEnv süreç genelidir, ayrı testte yarışır).
        // Tanınmayan bayrak değeri yerel kipi AÇMAZ (envOr varsayılana, 0'a düşer → Fuji denetimleri çalışır).
        vm.setEnv("DEPLOY_LOCAL", "true");
        assertFalse(script.loadConfig().local, "DEPLOY_LOCAL=true yerel kip acmaz");
        vm.setEnv("DEPLOY_LOCAL", "0");

        // .env.example'daki gibi boş alanlar: dağıtım başlamadan durur.
        vm.setEnv("DEPLOYER_PRIVATE_KEY", "");
        vm.expectRevert();
        script.loadConfig();
        // 0x'siz anahtar (yanlış ondalık okuma riski) reddedilir.
        vm.setEnv("DEPLOYER_PRIVATE_KEY", _no0x(vm.toString(bytes32(deployerKey))));
        vm.expectRevert();
        script.loadConfig();
        vm.setEnv("DEPLOYER_PRIVATE_KEY", vm.toString(bytes32(deployerKey)));

        vm.setEnv("PILOT_AGENT_ADDRESS", "");
        vm.expectRevert();
        script.loadConfig();
        vm.setEnv("PILOT_AGENT_ADDRESS", "0x1234");
        vm.expectRevert();
        script.loadConfig();
        vm.setEnv("PILOT_AGENT_ADDRESS", vm.toString(pilotAgent));

        vm.setEnv("KULE_REPORTER_ADDRESS", "");
        vm.expectRevert();
        script.loadConfig();
        vm.setEnv("KULE_REPORTER_ADDRESS", vm.toString(kuleReporter));
        assertEq(script.loadConfig().kuleReporter, kuleReporter);
    }

    function _no0x(string memory s) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        bytes memory r = new bytes(b.length - 2);
        for (uint256 i = 2; i < b.length; i++) {
            r[i - 2] = b[i];
        }
        return string(r);
    }
}
