// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {IInitializerHook} from "liquidity-launcher/src/interfaces/IInitializerHook.sol";
import {ILBPInitializer} from "liquidity-launcher/src/interfaces/ILBPInitializer.sol";
import {ILBPStrategy} from "liquidity-launcher/src/interfaces/ILBPStrategy.sol";
import {MigratorParameters} from "liquidity-launcher/src/libraries/MigratorParams.sol";

interface IAuctionSweeps {
    function sweepUnsoldTokens() external;
    function sweepUnsoldTokensBlock() external view returns (uint256);
}

interface IStrategyPools {
    function registeredPoolIds(PoolId id) external view returns (address);
    function poolManager() external view returns (address);
}

/// @notice A stand-in for the project treasury of milestone 2/3, only as much as milestone 1 needs: it is the
/// strategy's `recipient` (leftover currency and unused pool Shares) and the auction's `tokensRecipient` (unsold Shares,
/// which the auction hands over only when this address itself calls the sweep). It also holds the plan's
/// "three-step finish" as three public, repeatable steps that a stranger may call in any order:
///
///  1. `openPool`  - run the strategy's pool step if it has not run yet;
///  2. `settle`    - split newly arrived currency 15 : 60 (spendable : floor), measured as "balance minus buckets";
///  3. `sweepUnsold` - collect unsold Shares from the auction.
///
/// None of the three reverts because another caller already did the work, and none trusts a caller-supplied number.
contract MockTreasury {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    /// @notice Currency the project may spend (the 15 of every 100 raised).
    uint256 public spendable;
    /// @notice Currency held back as the floor (the 60 of every 100 raised).
    uint256 public floorMoney;

    event Settled(uint256 fresh, uint256 toSpendable, uint256 toFloor);

    /// @notice The new money cannot be split 15 : 60 because the sale has no pool: the 22 meant for the pool is in it.
    error NoPool();

    /// @notice Step 1. Safe to repeat: does nothing when the pool step already ran. The strategy reports a failed pool
    /// step as a successful transaction, so this does not revert on it either; whether a pool exists afterwards is
    /// answered by `poolIsOpen`, which reads the pool manager.
    /// @return ran True when this call performed the pool step.
    function openPool(ILBPStrategy strategy, ILBPInitializer auction) external returns (bool ran) {
        if (strategy.initializers(auction).migrationBlock == 0) return false; // not registered with this strategy
        PoolKey memory key = _key(strategy, auction);
        if (IStrategyPools(address(strategy)).registeredPoolIds(key.toId()) != address(auction)) return false;
        strategy.migrate(auction);
        return true;
    }

    function _key(ILBPStrategy strategy, ILBPInitializer auction) internal view returns (PoolKey memory key) {
        MigratorParameters memory p = strategy.initializers(auction);
        key = PoolKey({
            currency0: Currency.wrap(p.currency < p.token ? p.currency : p.token),
            currency1: Currency.wrap(p.currency < p.token ? p.token : p.currency),
            fee: p.poolParameters.fee,
            tickSpacing: p.poolParameters.tickSpacing,
            hooks: IHooks(p.poolParameters.hook)
        });
    }

    /// @notice True when the project's own pool exists. Read from the pool manager through the same library the strategy
    /// uses, never from an event: the strategy reports a failed pool step as a successful transaction.
    /// @dev "The project's own pool" means the pool at a key whose hook is a pool guard that names this sale's strategy
    /// as the only address allowed to create it. Without that guard the key is the plain one, which a stranger can
    /// initialise at a price of their choosing after the sale opens, so "a pool exists there" would prove nothing about
    /// the project's pool. The strategy accepts a sale with no guard, so this refuses it here: no guard, no pool.
    function poolIsOpen(ILBPStrategy strategy, ILBPInitializer auction) public view returns (bool) {
        PoolKey memory key = _key(strategy, auction);
        address hook = address(key.hooks);
        if (hook == address(0) || IInitializerHook(hook).authorized() != address(strategy)) return false;
        (uint160 sqrtPriceX96,,,) = IPoolManager(IStrategyPools(address(strategy)).poolManager()).getSlot0(key.toId());
        return sqrtPriceX96 != 0;
    }

    /// @notice Step 2. New money is whatever this contract holds above its two buckets, split 15 : 60 (20 : 80).
    /// Refuses when the sale has no pool, because then the 22 of every 100 meant for the pool arrived here too and
    /// a 15 : 60 split would put 77 of 100 in the floor.
    function settle(IERC20 currency, ILBPStrategy strategy, ILBPInitializer auction) external returns (uint256 fresh) {
        if (!poolIsOpen(strategy, auction)) revert NoPool();
        fresh = currency.balanceOf(address(this)) - spendable - floorMoney;
        uint256 toSpendable = fresh * 15 / 75;
        spendable += toSpendable;
        floorMoney += fresh - toSpendable;
        emit Settled(fresh, toSpendable, fresh - toSpendable);
    }

    /// @notice Step 3. Safe to repeat: skips when the auction's unsold-Share sweep already happened.
    function sweepUnsold(IAuctionSweeps auction) external returns (bool ran) {
        if (auction.sweepUnsoldTokensBlock() != 0) return false;
        auction.sweepUnsoldTokens();
        return true;
    }
}
