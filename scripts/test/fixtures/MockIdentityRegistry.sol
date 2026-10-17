// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice YALNIZ TEST: ERC-8004 Identity kaydının register-agent.ts'in kullandığı küçük alt kümesi.
/// Gerçek kayıt Fuji'de 0x8004A818BFB912233c491871b3d84c89A494BD9e (Ek B); bu dosya contracts/src'ye girmez.
/// Olaylar EIP-8004 / ERC-721 imzalarıyla aynıdır: Transfer(0 → sahip) + Registered(agentId, agentURI, sahip).
/// mode: 0 normal, 1 olay yok, 2 Registered ile Transfer farklı kimlik, 3 her zaman revert.
contract MockIdentityRegistry {
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);

    uint256 public nextId; // testler setNextId ile kurar (anvil_setCode kurucu çalıştırmaz)
    uint8 public mode;
    mapping(uint256 => string) public tokenURI;
    mapping(uint256 => address) public ownerOf;

    function setMode(uint8 m) external { mode = m; }
    function setNextId(uint256 n) external { nextId = n; }

    function register(string calldata agentURI) external returns (uint256 agentId) {
        require(mode != 3, "mock: revert");
        agentId = nextId++;
        tokenURI[agentId] = agentURI;
        ownerOf[agentId] = msg.sender;
        if (mode == 1) return agentId;
        emit Transfer(address(0), msg.sender, agentId);
        emit Registered(mode == 2 ? agentId + 1 : agentId, agentURI, msg.sender);
    }
}
