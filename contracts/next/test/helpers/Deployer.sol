// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {IPositionDescriptor} from "@uniswap/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IDistributorFactory} from "liquidity-launcher/src/interfaces/IDistributorFactory.sol";
import {LBPStrategy} from "liquidity-launcher/src/strategies/lbp/LBPStrategy.sol";
import {ContinuousClearingAuctionFactory} from "continuous-clearing-auction/src/ContinuousClearingAuctionFactory.sol";
import {HookSalt} from "../../src/HookSalt.sol";
import {PoolGuard} from "../../src/PoolGuard.sol";

/// @notice Test-only. Does every deployment that embeds a large contract's creation code. Test contracts deploy it
/// from its build artifact (`vm.getCode`), not with `new`, so each test contract does not recompile the whole
/// Uniswap stack: that is the difference between a 2 second and a 100 second compile after every test edit.
/// @dev This contract is the CREATE2 deployer of the strategy and the pool guard, so their addresses depend on it.
contract Deployer {
    /// @notice The vendored v4 stack, for the local twin (Permit2 must already sit at its fixed address).
    function localStack(address permit2)
        external
        returns (IPoolManager poolManager, IPositionManager positionManager, PoolSwapTest swapTest)
    {
        poolManager = IPoolManager(address(new PoolManager(msg.sender)));
        positionManager = IPositionManager(
            address(
                new PositionManager(
                    poolManager,
                    IAllowanceTransfer(permit2),
                    300_000,
                    IPositionDescriptor(address(0)),
                    IWETH9(address(0))
                )
            )
        );
        swapTest = new PoolSwapTest(poolManager);
    }

    /// @notice Our deployment of the auction factory, bound to one fee controller.
    function auctionFactory(address feeController) external returns (address) {
        return address(new ContinuousClearingAuctionFactory(feeController));
    }

    /// @notice The vendored strategy at a mined address (low 14 bits are exactly the `beforeInitialize` flag).
    function strategy(IPositionManager positionManager, IPoolManager poolManager, address factory)
        external
        returns (address)
    {
        bytes memory args = abi.encode(positionManager, poolManager, IDistributorFactory(factory));
        (address predicted, bytes32 salt) =
            HookSalt.find(address(this), uint160(Hooks.BEFORE_INITIALIZE_FLAG), type(LBPStrategy).creationCode, args);
        LBPStrategy s = new LBPStrategy{salt: salt}(positionManager, poolManager, IDistributorFactory(factory));
        require(address(s) == predicted, "strategy address");
        return address(s);
    }

    /// @notice Our pool guard at a mined address, authorizing only `strategy_`.
    function guard(IPoolManager poolManager, address strategy_) external returns (address) {
        bytes memory args = abi.encode(poolManager, strategy_);
        (address predicted, bytes32 salt) =
            HookSalt.find(address(this), uint160(Hooks.BEFORE_INITIALIZE_FLAG), type(PoolGuard).creationCode, args);
        PoolGuard g = new PoolGuard{salt: salt}(poolManager, strategy_);
        require(address(g) == predicted, "guard address");
        return address(g);
    }
}
