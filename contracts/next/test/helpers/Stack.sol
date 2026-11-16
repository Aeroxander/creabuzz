// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IDistributorFactory} from "liquidity-launcher/src/interfaces/IDistributorFactory.sol";
import {LBPStrategy} from "liquidity-launcher/src/strategies/lbp/LBPStrategy.sol";
import {PoolGuard} from "../../src/PoolGuard.sol";

/// @dev The view of `Deployer` the tests use (the contract itself is deployed from its artifact, see its header).
interface IDeployer {
    function localStack(address permit2) external returns (IPoolManager, IPositionManager, PoolSwapTest);
    function auctionFactory(address feeController) external returns (address);
    function strategy(IPositionManager, IPoolManager, address factory) external returns (address);
    function guard(IPoolManager, address strategy) external returns (address);
}

/// @notice The Uniswap side of every test: v4 pool manager, position manager, Permit2 and a swap helper, plus our own
/// strategy and pool guard mined to hook addresses. Two modes, one code path for everything after setup:
///  * local: deploys the vendored v4 stack itself (no network needed);
///  * fork: runs on a Sepolia fork pinned to `SEPOLIA_PIN`, using the REAL deployed pool manager, position manager and
///    Permit2, with our own contracts deployed on top. Skips with a message when no RPC url is set.
abstract contract Stack is Test {
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    // Real Sepolia deployments (verified by test/ForkFacts.t.sol). See docs/next-version/M1-FACTS.md for sources.
    address internal constant SEPOLIA_POOL_MANAGER = 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543;
    address internal constant SEPOLIA_POSITION_MANAGER = 0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4;
    address internal constant SEPOLIA_UNIVERSAL_ROUTER = 0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b;
    address internal constant SEPOLIA_POOL_SWAP_TEST = 0x9B6b46e2c869aa39918Db7f52f5557FE577B6eEe;

    /// @notice The fork block. The public node keeps only about the last 10,000 blocks; override with
    /// `SEPOLIA_FORK_BLOCK` (a recent block) when this one is out of range and not in the local Foundry cache.
    uint256 internal constant SEPOLIA_PIN = 12_146_650;

    IPoolManager internal poolManager;
    IPositionManager internal positionManager;
    IAllowanceTransfer internal permit2;
    PoolSwapTest internal swapTest;
    IDeployer internal deployer;
    bool internal onFork;

    /// @dev Call first in `setUp`. Returns false when the fork mode was asked for and no RPC is set (tests skipped).
    function _setUpStack(bool fork) internal returns (bool) {
        onFork = fork;
        if (fork) {
            string memory rpc = vm.envOr("SEPOLIA_RPC_URL", string(""));
            if (bytes(rpc).length == 0) {
                vm.skip(
                    true, "SEPOLIA_RPC_URL is not set: the Sepolia fork tests are skipped (the local twin still runs)"
                );
                return false;
            }
            vm.createSelectFork(rpc, vm.envOr("SEPOLIA_FORK_BLOCK", SEPOLIA_PIN));
            poolManager = IPoolManager(SEPOLIA_POOL_MANAGER);
            positionManager = IPositionManager(SEPOLIA_POSITION_MANAGER);
            permit2 = IAllowanceTransfer(PERMIT2);
            swapTest = PoolSwapTest(SEPOLIA_POOL_SWAP_TEST);
            deployer = IDeployer(deployCode("out/Deployer.sol/Deployer.json")); // after the fork is selected
        } else {
            deployer = IDeployer(deployCode("out/Deployer.sol/Deployer.json"));
            // Permit2 lives at a fixed address the auction's token pull uses; deploy the real source there.
            deployCodeTo("out/Permit2.sol/Permit2.json", PERMIT2); // artifact by path: lookup by name finds nothing in this project
            permit2 = IAllowanceTransfer(PERMIT2);
            (poolManager, positionManager, swapTest) = deployer.localStack(PERMIT2);
        }
        return true;
    }

    /// @dev Our strategy at a mined address (the beforeInitialize bit).
    function _deployStrategy(address factory) internal returns (LBPStrategy strategy) {
        strategy = LBPStrategy(payable(deployer.strategy(positionManager, poolManager, factory)));
        assertEq(uint160(address(strategy)) & Hooks.ALL_HOOK_MASK, Hooks.BEFORE_INITIALIZE_FLAG, "strategy hook bits");
    }

    /// @dev Our pool guard at a mined address, authorizing only `strategy`.
    function _deployGuard(address strategy) internal returns (PoolGuard guard) {
        guard = PoolGuard(deployer.guard(poolManager, strategy));
    }
}
