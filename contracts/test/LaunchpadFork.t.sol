// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {
    IContinuousClearingAuctionFactory
} from "continuous-clearing-auction/src/interfaces/IContinuousClearingAuctionFactory.sol";
import {AuctionLauncher} from "../src/AuctionLauncher.sol";

/// @notice Sepolia fork integration. Run:
/// `forge test --match-contract LaunchpadForkTest --fork-url $SEPOLIA_RPC_URL`
/// Local unit suites stay fork-free; this contract is the only one requiring
/// network access.
contract LaunchpadForkTest is Test {
    // Canonical CCA factory v2.1.0 (same address across EVM chains).
    address constant FACTORY_V210 = 0x000000001F26a0044BaA66024e7b6599c61963F8;

    function test_fork_factory_is_deployed_and_readable() public {
        // Fork-only (see header): without `--fork-url` the factory has no code
        // and there is nothing to read. Skip visibly instead of failing the
        // local suite.
        vm.skip(FACTORY_V210.code.length == 0);
        address controller = address(IContinuousClearingAuctionFactory(FACTORY_V210).protocolFeeController());
        // The read path is the assertion: a wrong ABI or undeployed factory
        // reverts here. The controller must be either unset (zero) or a deployed
        // contract — an EOA/phantom address would break every fee sweep.
        // (Replaces the previously vacuous `... || true` assertion.)
        if (controller != address(0)) {
            assertGt(controller.code.length, 0, "protocolFeeController must be a contract or unset");
        }
    }

    function test_fork_launcher_registers() public {
        AuctionLauncher launcher = new AuctionLauncher();
        bytes memory steps = hex"00000000000000010000000000000002";
        launcher.registerLaunch(
            bytes32(uint256(42)),
            AuctionLauncher.LaunchParams({
                currency: address(1),
                floorPrice: (uint256(1) << 32) + 1,
                tickSpacing: 100,
                requiredRaised: 100,
                startBlock: 10,
                endBlock: 20,
                claimBlock: 30,
                steps: steps,
                validationHook: address(0)
            })
        );
        assertTrue(launcher.paramsHash(bytes32(uint256(42))) != bytes32(0));
    }
}
