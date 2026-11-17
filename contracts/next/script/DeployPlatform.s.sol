// SPDX-License-Identifier: MIT
pragma solidity >=0.8.26;

import {Script} from "forge-std/Script.sol";

/// @notice OUTLINE of the per-network deployment of the platform, in the order that works: fee controller, auction factory,
/// strategy (mined address), pool guard (mined address), bid hook, Launcher. Nothing here has run on any real network and no key
/// is held: it is checked by simulating it against a Sepolia fork (`forge script script/DeployPlatform.s.sol --fork-url
/// $SEPOLIA_RPC_URL`, no `--broadcast`). The strategy and the pool guard must sit at addresses whose lowest 14 bits are exactly
/// 0x2000 (Uniswap v4 reads a hook's permissions from its address), so each is created through the standard CREATE2 deployer at a
/// salt found by `_mine`; about one salt in 16,384 fits. Mining takes under a second on a laptop (see the milestone 3 report).
///
/// Any change to the fee controller means a new factory, a new strategy and a new guard, because each holds the one before it as
/// an immutable. The licence of the vendored strategy (two BUSL-1.1 files of Uniswap's pool code reach its bytecode) is a
/// question for counsel before this is run anywhere real.
///
/// Inputs (environment, with the Sepolia values as defaults): `POOL_MANAGER`, `POSITION_MANAGER` (Uniswap's deployments);
/// `QUOTE` (the platform's 6-decimal dollar token; on a simulation without it a test token is made); `PLATFORM` (receives the 3
/// percent of every raise and the platform part of exit fees); `ADMIN` (may change the settings of new projects; use the
/// zero address to freeze them).
contract DeployPlatform is Script {
    /// @dev The standard CREATE2 deployer (exists on Sepolia, M1-FACTS section 8).
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    uint160 internal constant BEFORE_INITIALIZE = 1 << 13;
    uint160 internal constant HOOK_MASK = (1 << 14) - 1;

    struct Deployed {
        address feeController;
        address factory;
        address strategy;
        address guard;
        address minBid;
        address launcher;
        uint256 strategySalts;
        uint256 guardSalts;
    }

    function run() external returns (Deployed memory d) {
        address poolManager = vm.envOr("POOL_MANAGER", address(0xE03A1074c86CFeDd5C142C4F04F1a1536e203543));
        address positionManager = vm.envOr("POSITION_MANAGER", address(0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4));
        address platform = vm.envOr("PLATFORM", msg.sender);
        address admin = vm.envOr("ADMIN", msg.sender);
        address quote = vm.envOr("QUOTE", address(0));

        vm.startBroadcast();
        if (quote == address(0)) quote = _create(vm.getCode("out/QuoteToken.sol/QuoteToken.json")); // simulation only
        d.feeController = _create(
            abi.encodePacked(
                vm.getCode("out/FixedFeeController.sol/FixedFeeController.json"), abi.encode(platform, uint24(30_000))
            )
        );
        d.factory = _create(
            abi.encodePacked(
                vm.getCode("out/ContinuousClearingAuctionFactory.sol/ContinuousClearingAuctionFactory.json"),
                abi.encode(d.feeController)
            )
        );
        bytes memory strategyInit = abi.encodePacked(
            vm.getCode("out/LBPStrategy.sol/LBPStrategy.json"), abi.encode(positionManager, poolManager, d.factory)
        );
        (d.strategy, d.strategySalts) = _create2Mined(strategyInit);
        bytes memory guardInit =
            abi.encodePacked(vm.getCode("out/PoolGuard.sol/PoolGuard.json"), abi.encode(poolManager, d.strategy));
        (d.guard, d.guardSalts) = _create2Mined(guardInit);
        d.minBid = _create(
            abi.encodePacked(
                vm.getCode("out/MinBid.sol/MinBid.json"), abi.encode(uint128(1e6), uint256(4), uint64(720))
            )
        );
        // Settings: quote, platform, exit fee 5%, platform part 1%, split 15 : 60, agents' defaults 25 dollars and 0.1% of Shares
        d.launcher = _create(
            abi.encodePacked(
                vm.getCode("out/Launcher.sol/Launcher.json"),
                abi.encode(
                    admin,
                    quote,
                    platform,
                    uint16(500),
                    uint16(100),
                    uint16(15),
                    uint16(60),
                    uint128(25e6),
                    uint128(1_000_000e18),
                    d.strategy,
                    d.guard,
                    d.minBid
                )
            )
        );
        vm.stopBroadcast();
        require(uint160(d.strategy) & HOOK_MASK == BEFORE_INITIALIZE, "strategy address");
        require(uint160(d.guard) & HOOK_MASK == BEFORE_INITIALIZE, "guard address");
    }

    function _create(bytes memory initCode) internal returns (address a) {
        assembly ("memory-safe") {
            a := create(0, add(initCode, 0x20), mload(initCode))
        }
        require(a != address(0) && a.code.length != 0, "create failed");
    }

    /// @dev Find the first salt whose CREATE2 address has exactly the `beforeInitialize` bit among the 14 hook bits, then deploy.
    function _create2Mined(bytes memory initCode) internal returns (address a, uint256 tries) {
        bytes32 hash = keccak256(initCode);
        uint256 i;
        for (;; ++i) {
            a = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, bytes32(i), hash)))));
            if (uint160(a) & HOOK_MASK == BEFORE_INITIALIZE) break;
        }
        (bool ok,) = CREATE2_DEPLOYER.call(abi.encodePacked(bytes32(i), initCode));
        require(ok && a.code.length != 0, "create2 failed");
        return (a, i + 1);
    }
}
