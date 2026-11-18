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
import {ForkPick} from "./ForkPick.sol";
import {ForkGate} from "./ForkGate.sol";
// Not used as a type: tests load the Deployer from its build artifact. Importing it makes `forge test` rebuild that
// artifact whenever anything it deploys (the strategy, our pool guard) changes; without this, an old build would run.
import {Deployer} from "./Deployer.sol";

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
abstract contract Stack is ForkGate {
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
            ForkPick.Plan memory plan = _planFork(rpc);
            if (bytes(plan.message).length != 0) emit log_string(plan.message);
            if (plan.skip) {
                vm.skip(true, plan.message);
                return false;
            }
            vm.createSelectFork(rpc, plan.blockNumber);
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
