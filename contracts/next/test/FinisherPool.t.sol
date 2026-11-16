// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "oz5/token/ERC20/IERC20.sol";
import {Platform} from "./helpers/Platform.sol";
import {ILiquidityRouterTest, IPoolManagerTest, ModifyLiquidityParams} from "./helpers/UniswapTest.sol";
import {QuoteToken} from "./mocks/QuoteToken.sol";
import {MockGuard, NotAGuard} from "./mocks/MockGuard.sol"; // built here so `deployCodeTo` finds them
import {Finisher} from "../src/Finisher.sol";
import {PoolKey} from "../src/Pinned.sol";

/// @notice What the Finisher counts as "the project's pool". Its answer is the one thing that lets money be split and the
/// Vester's clock start, so each part of it is tried alone, against a Finisher built by hand around a guard the test controls
/// (the Launcher never builds one with a wrong guard, so only a hand-built one can show what each check does).
abstract contract FinisherPoolBase is Platform {
    int24 internal constant FULL_LOWER = -887_200;
    int24 internal constant FULL_UPPER = 887_200;

    QuoteToken internal tokenB;
    address internal liquidityRouter;

    function _fork() internal pure virtual returns (bool);

    function setUp() public virtual {
        _setUpPlatform(_fork());
        tokenB = new QuoteToken();
        liquidityRouter = deployer.liquidityRouter(poolManager);
    }

    /// @dev A Finisher around `guard_` whose "Shares" are `tokenB`.
    function _finisherWith(address guard_) internal returns (Finisher f) {
        f = new Finisher(address(this), strategy, guard_);
        f.initialize(makeAddr("some treasury"), address(tokenB), address(usd));
    }

    /// @dev A real pool guard (mined to a hook address) that lets only `creator` create its pools.
    function _guardNaming(address creator, uint256) internal returns (address g) {
        g = deployer.guard(poolManager, creator);
    }

    /// @dev Create the pool at the Finisher's key. The guard lets only its named creator do it, so `creator` makes the call.
    function _makePool(Finisher f, bool withLiquidity, address creator) internal {
        PoolKey memory key = f.poolKey();
        vm.prank(creator);
        IPoolManagerTest(poolManager).initialize(key, uint160(1) << 96);
        if (withLiquidity) {
            usd.mint(address(this), 1_000_000 * DOLLAR);
            tokenB.mint(address(this), 1_000_000_000 * DOLLAR);
            usd.approve(liquidityRouter, type(uint256).max);
            tokenB.approve(liquidityRouter, type(uint256).max);
            ILiquidityRouterTest(liquidityRouter)
                .modifyLiquidity(
                    key,
                    ModifyLiquidityParams({tickLower: FULL_LOWER, tickUpper: FULL_UPPER, liquidityDelta: 1e9, salt: 0}),
                    ""
                );
        }
    }

    function test_poolIsOpen_noPoolIsNoPool() public {
        Finisher f = _finisherWith(guard);
        assertFalse(f.poolIsOpen());
    }

    function test_poolIsOpen_aPoolWithAPriceAndNoLiquidityIsNoPool() public {
        Finisher f = _finisherWith(guard);
        _makePool(f, false, strategy);
        assertGt(_sqrtPrice(f.poolKey()), 0, "the pool exists and has a price");
        assertEq(_poolLiquidity(f.poolKey()), 0);
        assertFalse(f.poolIsOpen(), "a pool nobody can trade in is not the project's pool");
    }

    function test_poolIsOpen_aPoolWhoseGuardNamesSomeoneElseIsNoPool() public {
        Finisher f = _finisherWith(_guardNaming(address(this), 3)); // this test is the one creator the guard allows
        _makePool(f, true, address(this));
        assertGt(_poolLiquidity(f.poolKey()), 0, "the pool has price and liquidity");
        assertFalse(f.poolIsOpen(), "but its guard does not name the platform's strategy as the only creator");
    }

    function test_poolIsOpen_aGuardThatIsNotAGuardIsNoPool() public {
        address notGuard = address(uint160(0xBEEF99 << 14) | uint160(1 << 13)); // asks for beforeInitialize, answers nothing
        deployCodeTo("MockGuard.sol:NotAGuard", "", notGuard);
        Finisher f = _finisherWith(notGuard);
        assertFalse(
            f.poolIsOpen(), "a hook with no authorized() is refused rather than trusted, and the call does not revert"
        );
    }

    function test_poolIsOpen_aPoolWithPriceLiquidityAndTheRightGuardIsThePool() public {
        Finisher f = _finisherWith(guard); // the platform's own guard, as every project has
        _makePool(f, true, strategy);
        assertTrue(f.poolIsOpen());
    }

    function test_poolIsOpen_aPoolAtAnotherKeyIsNotThisProjectsPool() public {
        // a pool of the same two tokens with a different fee, or a different hook, is not at this project's key
        Finisher f = _finisherWith(guard);
        PoolKey memory other = f.poolKey();
        other.fee = 3000;
        vm.prank(strategy);
        IPoolManagerTest(poolManager).initialize(other, uint160(1) << 96);
        PoolKey memory plain = f.poolKey();
        plain.hooks = address(0);
        IPoolManagerTest(poolManager).initialize(plain, uint160(1) << 96);
        assertFalse(f.poolIsOpen());
    }
}

contract FinisherPoolLocalTest is FinisherPoolBase {
    function _fork() internal pure override returns (bool) {
        return false;
    }
}

contract FinisherPoolForkTest is FinisherPoolBase {
    function _fork() internal pure override returns (bool) {
        return true;
    }
}
