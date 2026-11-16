// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {ILBPStrategy} from "liquidity-launcher/src/interfaces/ILBPStrategy.sol";
import {ILBPInitializer} from "liquidity-launcher/src/interfaces/ILBPInitializer.sol";
import {IContinuousClearingAuction} from "continuous-clearing-auction/src/interfaces/IContinuousClearingAuction.sol";
import {IAuctionStorage} from "continuous-clearing-auction/src/interfaces/IAuctionStorage.sol";
import {MigratorParameters} from "liquidity-launcher/src/libraries/MigratorParams.sol";
import {PoolGuard} from "../src/PoolGuard.sol";
import {SaleBase} from "./helpers/SaleBase.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {IAuctionSweeps, MockTreasury} from "./mocks/MockTreasury.sol";

/// @notice Step 5 of milestone 1: the attacks the plan promised tests for, each with the guard that stops it and, where
/// the vendored code cannot stop it, an honest statement of what happens instead. A test that still passed with its
/// guard removed would prove nothing, so each guard was removed once to see its test fail (see M1-REPORT.md).
abstract contract AttackBase is SaleBase {
    using PoolIdLibrary for PoolKey;

    uint256 internal constant DOLLAR = 1e6;
    uint160 internal constant PRICE_ONE = 79_228_162_514_264_337_593_543_950_336; // sqrt price 1.0, a stranger's choice

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function _fork() internal pure virtual returns (bool);

    function setUp() public virtual {
        if (!_setUpStack(_fork())) return;
        _deployTokens(true);
        _deployInfra(_defaultConfig());
    }

    function _noGuard() internal {
        Config memory c = _defaultConfig();
        c.useGuard = false;
        guard = PoolGuard(address(0));
        _deployInfra(c);
    }

    /// @dev A graduating sale: 12,000 dollars at up to 2x the floor, ended and past its migration block.
    function _graduatedSale() internal returns (Sale memory s) {
        s = _openSale(_standard());
        vm.roll(s.startBlock);
        _bid(s, alice, 7000 * DOLLAR, 100);
        _bid(s, bob, 5000 * DOLLAR, 100);
        _toEnd(s);
        vm.roll(s.endBlock + 1);
    }

    function _logs(Vm.Log[] memory logs, bytes32 topic) internal view returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(strategy) && logs[i].topics[0] == topic) ++n;
        }
    }

    // ===================================================================================================================
    // A stranger creates the project's pool first
    // ===================================================================================================================

    /// @notice Without the guard, a plain pool for the pair made before the sale opens makes opening the sale revert.
    function test_poolFirst_withoutGuard_aStrangersPlainPoolBlocksOpeningTheSale() public {
        _noGuard();
        PoolKey memory plain = _poolKey(address(0));
        vm.prank(stranger);
        poolManager.initialize(plain, PRICE_ONE);

        share.mint(address(this), SHARES);
        share.approve(address(strategy), SALE_AND_RESERVE);
        uint64 start = uint64(block.number + 1);
        (uint256 f, uint256 t) = _floorAndTick(10_000e6);
        bytes memory cfg = abi.encode(
            _migratorParams(start + SALE_BLOCKS, address(0)), abi.encode(_auctionParams(_standard(), start, f, t))
        );
        vm.expectRevert(abi.encodeWithSignature("InvalidHook(address)", address(0)));
        strategy.initializeDistribution(address(share), SALE_AND_RESERVE, cfg, bytes32(0));
    }

    /// @notice Without the guard, a plain pool made after the sale opens does not stop the pool step, but the project's
    /// pool moves to a second key (the strategy's own), and the stranger's pool sits beside it at a price they chose.
    function test_poolFirst_withoutGuard_aStrangersPlainPoolAfterOpeningMovesTheProjectsPool() public {
        _noGuard();
        Sale memory s = _openSale(_standard());
        vm.roll(s.startBlock);
        _bid(s, alice, 12_000 * DOLLAR, 100);
        PoolKey memory plain = _poolKey(address(0));
        vm.prank(stranger);
        poolManager.initialize(plain, PRICE_ONE); // a price of 1.0 raw units: nothing like the sale's
        _toEnd(s);
        vm.roll(s.endBlock + 1);

        vm.recordLogs();
        treasury.openPool(strategy, ILBPInitializer(address(s.auction)));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_logs(logs, ILBPStrategy.Migrated.selector), 1, "the pool step still worked");

        PoolKey memory fallbackKey = _poolKey(address(strategy));
        assertGt(_poolSqrtPrice(fallbackKey), 0, "the project's pool is at the strategy-hooked key");
        assertEq(_poolSqrtPrice(plain), PRICE_ONE, "the stranger's plain pool still has the stranger's price");
        assertTrue(_poolSqrtPrice(fallbackKey) != PRICE_ONE, "the two pools disagree: two markets for one token");
        assertEq(quote.balanceOf(address(poolManager)) > 0, true, "the project's liquidity is in the fallback pool");
    }

    /// @notice With the guard the stranger cannot take the project's key, and a plain pool next to it changes nothing.
    function test_poolFirst_withGuard_theProjectsKeyIsTheirsAlone() public {
        PoolKey memory plain = _poolKey(address(0));
        vm.prank(stranger);
        poolManager.initialize(plain, PRICE_ONE); // allowed: it is a different pool

        Sale memory s = _openSale(_standard()); // opening is not blocked
        PoolKey memory guarded = _poolKey(address(guard));
        assertEq(address(s.key.hooks), address(guard), "key carries the guard");
        vm.prank(stranger);
        vm.expectRevert(); // the guard refuses anyone but the strategy (exact error in Pieces.t.sol)
        poolManager.initialize(guarded, PRICE_ONE);

        vm.roll(s.startBlock);
        _bid(s, alice, 12_000 * DOLLAR, 100);
        _toEnd(s);
        vm.roll(s.endBlock + 1);
        treasury.openPool(strategy, ILBPInitializer(address(s.auction)));

        assertGt(_poolSqrtPrice(guarded), 0, "the project's pool exists at the guarded key");
        assertTrue(_poolSqrtPrice(guarded) != PRICE_ONE, "at the auction's price, not the stranger's");
        assertEq(_poolSqrtPrice(plain), PRICE_ONE, "the stranger's other pool is theirs and is not the project's");
    }

    // ===================================================================================================================
    // A stranger calls the pool step first, or twice
    // ===================================================================================================================

    function test_poolStep_beforeTheMigrationBlockIsRefused() public {
        Sale memory s = _openSale(_standard());
        vm.roll(s.startBlock);
        _bid(s, alice, 12_000 * DOLLAR, 100);
        _toEnd(s); // the end block itself: migration is allowed from the next block
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(ILBPStrategy.MigrationNotYetAllowed.selector, s.endBlock + 1, s.endBlock)
        );
        strategy.migrate(ILBPInitializer(address(s.auction)));
        assertEq(_poolSqrtPrice(s.key), 0, "no pool was made");
        assertEq(strategy.registeredPoolIds(s.key.toId()), address(s.auction), "and the key is still reserved");
    }

    struct Outcome {
        uint256 platformDollars;
        uint256 poolDollars;
        uint256 poolShares;
        uint256 treasuryDollars;
        uint256 treasuryShares;
        uint160 sqrtPrice;
    }

    function _outcome(Sale memory s) internal view returns (Outcome memory o) {
        o.platformDollars = quote.balanceOf(platform);
        o.poolDollars = quote.balanceOf(address(poolManager));
        o.poolShares = share.balanceOf(address(poolManager));
        o.treasuryDollars = quote.balanceOf(address(treasury));
        o.treasuryShares = share.balanceOf(address(treasury));
        o.sqrtPrice = _poolSqrtPrice(s.key);
    }

    /// @notice Whoever calls the pool step, the result is the same to the last unit: the recipients were fixed when the
    /// sale opened, so a stranger who goes first gains nothing and can change nothing.
    function test_poolStep_aStrangerGoingFirstGetsTheSameResultAsAnyone() public {
        Sale memory s = _graduatedSale();
        uint256 snap = vm.snapshotState();

        vm.prank(stranger);
        strategy.migrate(ILBPInitializer(address(s.auction)));
        Outcome memory byStranger = _outcome(s);
        assertGt(byStranger.sqrtPrice, 0, "pool opened");
        assertEq(quote.balanceOf(stranger), 0, "the stranger received nothing");
        assertEq(share.balanceOf(stranger), 0, "no Shares either");

        vm.revertToState(snap);
        vm.prank(address(treasury));
        strategy.migrate(ILBPInitializer(address(s.auction)));
        Outcome memory byTreasury = _outcome(s);

        assertEq(byStranger.platformDollars, byTreasury.platformDollars, "platform");
        assertEq(byStranger.poolDollars, byTreasury.poolDollars, "pool dollars");
        assertEq(byStranger.poolShares, byTreasury.poolShares, "pool Shares");
        assertEq(byStranger.treasuryDollars, byTreasury.treasuryDollars, "treasury dollars");
        assertEq(byStranger.treasuryShares, byTreasury.treasuryShares, "treasury Shares");
        assertEq(byStranger.sqrtPrice, byTreasury.sqrtPrice, "pool price");
    }

    function test_poolStep_aSecondCallIsRefused() public {
        Sale memory s = _graduatedSale();
        strategy.migrate(ILBPInitializer(address(s.auction)));
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ILBPStrategy.InitializerNotRegistered.selector, s.auction));
        strategy.migrate(ILBPInitializer(address(s.auction)));
    }

    function test_poolStep_theInnerStepIsNotPublic_andUnknownSalesAreRefused() public {
        Sale memory s = _graduatedSale();
        ILBPInitializer init = ILBPInitializer(address(s.auction));
        MigratorParameters memory params = strategy.initializers(init); // read before the prank, which covers one call
        vm.prank(stranger);
        vm.expectRevert(ILBPStrategy.OnlySelfCall.selector);
        strategy.tryMigrate(init, params, s.key);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ILBPStrategy.InitializerNotRegistered.selector, address(0xBEEF)));
        strategy.migrate(ILBPInitializer(address(0xBEEF)));
    }

    /// @notice A caller who chooses the gas cannot force the swallowed-failure path. Scans gas limits from far too little
    /// to plenty: every outcome is either "the whole call reverted and nothing changed" or "the pool opened". Not a
    /// proof (the scan is finite), but the mechanism is clear: the inner step needs far less than 1/64 of what the
    /// recovery path needs, so any limit that starves the inner step also starves the recovery and reverts everything.
    function test_poolStep_gasGriefingCannotForceTheSwallowedFailure() public {
        Sale memory s = _graduatedSale();
        uint256 snap = vm.snapshotState();
        uint256 reverted;
        uint256 opened;
        for (uint256 g = 400_000; g <= 12_000_000; g += g < 2_000_000 ? 25_000 : 500_000) {
            vm.recordLogs();
            vm.prank(stranger);
            (bool ok,) = address(strategy).call{gas: g}(
                abi.encodeCall(ILBPStrategy.migrate, (ILBPInitializer(address(s.auction))))
            );
            Vm.Log[] memory logs = vm.getRecordedLogs();
            if (ok) {
                assertEq(_logs(logs, ILBPStrategy.MigrationFailed.selector), 0, "never the swallowed failure");
                assertEq(_logs(logs, ILBPStrategy.Migrated.selector), 1, "success means the pool opened");
                ++opened;
            } else {
                assertEq(_poolSqrtPrice(s.key), 0, "a reverted call changed nothing");
                assertEq(strategy.registeredPoolIds(s.key.toId()), address(s.auction), "still reserved");
                ++reverted;
            }
            vm.revertToState(snap);
        }
        emit log_named_uint("gas limits that reverted whole", reverted);
        emit log_named_uint("gas limits that opened the pool", opened);
        assertGt(reverted, 0, "the scan did cover starved calls");
        assertGt(opened, 0, "and generous ones");
    }

    // ===================================================================================================================
    // Sale under its minimum, and a partial sale
    // ===================================================================================================================

    function test_sale_underTheMinimumRefundsEveryoneInFullAndNoPoolOpens() public {
        Sale memory s = _openSale(_standard());
        vm.roll(s.startBlock);
        uint256 a = _bid(s, alice, 1500 * DOLLAR, 100);
        uint256 b = _bid(s, bob, 700 * DOLLAR, 50); // 2,200 dollars in all: under the 2,500 minimum
        _toEnd(s);
        assertFalse(s.auction.isGraduated(), "not graduated");
        vm.roll(s.endBlock + 1);

        vm.recordLogs();
        treasury.openPool(strategy, ILBPInitializer(address(s.auction)));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_logs(logs, ILBPStrategy.Migrated.selector), 0, "no Migrated event");
        assertEq(_logs(logs, ILBPStrategy.MigrationFailed.selector), 1, "the strategy reports MigrationFailed");
        assertEq(_logs(logs, ILBPStrategy.FundsRecovered.selector), 1, "and returns the pool reserve");
        assertEq(_poolSqrtPrice(s.key), 0, "no pool exists");
        assertFalse(treasury.poolIsOpen(strategy, ILBPInitializer(address(s.auction))), "the treasury sees it too");

        // Nobody paid a fee, nothing went to the pool.
        assertEq(quote.balanceOf(platform), 0, "no fee on a failed sale");
        assertEq(quote.balanceOf(address(poolManager)), 0, "no dollars in any pool");
        assertEq(share.balanceOf(address(treasury)), POOL_RESERVE, "the 10% reserve is back with the treasury");
        assertEq(share.balanceOf(address(strategy)), 0, "the strategy keeps nothing");

        // Every bidder is refunded in full, to the unit, by the auction itself.
        _exit(s, a);
        _exit(s, b);
        assertEq(quote.balanceOf(alice), 1500 * DOLLAR, "alice refunded in full");
        assertEq(quote.balanceOf(bob), 700 * DOLLAR, "bob refunded in full");
        assertEq(quote.balanceOf(address(s.auction)), 0, "the auction holds no dollars");
        // Shares cannot be claimed from a failed sale, and all 400,000,000 for sale come back via the sweep.
        vm.expectRevert(IAuctionStorage.NotGraduated.selector);
        s.auction.claimTokens(a);
        assertTrue(treasury.sweepUnsold(IAuctionSweeps(address(s.auction))), "the treasury sweeps the unsold Shares");
        assertEq(share.balanceOf(address(treasury)), POOL_RESERVE + SALE_SHARES, "all of the sale's Shares are back");
        // The treasury refuses to split money when there is no pool.
        vm.expectRevert(MockTreasury.NoPool.selector);
        treasury.settle(quote, strategy, ILBPInitializer(address(s.auction)));
    }

    /// @notice Over the minimum, under the goal: 5,000 dollars of demand for a 10,000-dollar sale. The price stays at the
    /// floor, half the Shares sell, the pool opens, and the unsold half comes back.
    function test_sale_partialSaleOverTheMinimumStillOpensAPool() public {
        Sale memory s = _openSale(_standard());
        vm.roll(s.startBlock);
        uint256 a = _bid(s, alice, 5000 * DOLLAR, 100);
        _toEnd(s);
        assertTrue(s.auction.isGraduated(), "5,000 is over the 2,500 minimum");
        assertEq(s.auction.clearingPrice(), s.floorQ96, "no competition: the price stayed at the floor");
        uint256 raised = s.auction.currencyRaised();
        assertApproxEqAbs(raised, 5000 * DOLLAR, 2, "everything bid was raised");
        uint256 sold = s.auction.totalCleared();
        assertApproxEqRel(sold, SALE_SHARES / 2, 1e12, "half of the Shares sold");

        vm.roll(s.endBlock + 1);
        treasury.openPool(strategy, ILBPInitializer(address(s.auction)));
        assertTrue(treasury.poolIsOpen(strategy, ILBPInitializer(address(s.auction))), "the pool opened");
        uint256 fee = raised * FEE_PIPS / 1_000_000;
        assertEq(quote.balanceOf(platform), fee, "3% fee");
        assertApproxEqAbs(fee, 150 * DOLLAR, 2, "which is 150 dollars");
        uint256 poolDollars = quote.balanceOf(address(poolManager));
        // 22/97 is rounded to a ten-millionth, so the pool may be a ten-thousandth of a dollar short
        assertApproxEqAbs(poolDollars, 1100 * DOLLAR, 200, "22 of every 100: 1,100 dollars in the pool");
        // At the floor price 1,100 dollars match 44,000,000 Shares: that is all the pool takes of the 100,000,000 reserve.
        assertApproxEqRel(share.balanceOf(address(poolManager)), 44_000_000e18, 1e12, "the pool took 44M Shares");
        treasury.settle(quote, strategy, ILBPInitializer(address(s.auction)));
        assertApproxEqAbs(treasury.spendable(), 750 * DOLLAR, 200, "15 of every 100: 750 dollars");
        assertApproxEqAbs(treasury.floorMoney(), 3000 * DOLLAR, 200, "60 of every 100: 3,000 dollars");

        assertTrue(treasury.sweepUnsold(IAuctionSweeps(address(s.auction))), "unsold half collected");
        assertApproxEqRel(
            share.balanceOf(address(treasury)),
            SALE_SHARES / 2 + POOL_RESERVE - 44_000_000e18,
            1e12,
            "treasury holds the unsold half plus the unused pool reserve"
        );
        // The one bidder is filled in full for what was raised and refunded nothing.
        _exit(s, a);
        assertEq(quote.balanceOf(alice), 0, "no refund: all 5,000 dollars were spent at the floor price");
        s.auction.claimTokens(a);
        assertApproxEqRel(share.balanceOf(alice), SALE_SHARES / 2, 1e12, "and received the half");
    }

    // ===================================================================================================================
    // The auction's sweeps are recipient-only
    // ===================================================================================================================

    function test_sweeps_onlyTheNamedRecipientsMayCallThem() public {
        Sale memory s = _graduatedSale();
        // stranger
        vm.startPrank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IContinuousClearingAuction.NotAuthorized.selector, address(strategy), stranger)
        );
        s.auction.sweepCurrency();
        vm.expectRevert(
            abi.encodeWithSelector(IContinuousClearingAuction.NotAuthorized.selector, address(treasury), stranger)
        );
        s.auction.sweepUnsoldTokens();
        vm.stopPrank();
        // even the other recipient cannot call the wrong one
        vm.prank(address(treasury));
        vm.expectRevert(
            abi.encodeWithSelector(
                IContinuousClearingAuction.NotAuthorized.selector, address(strategy), address(treasury)
            )
        );
        s.auction.sweepCurrency();
        vm.prank(address(strategy));
        vm.expectRevert(
            abi.encodeWithSelector(
                IContinuousClearingAuction.NotAuthorized.selector, address(treasury), address(strategy)
            )
        );
        s.auction.sweepUnsoldTokens();
        // and the dollars are where they were
        assertEq(quote.balanceOf(address(s.auction)), 12_000 * DOLLAR, "nothing moved");
    }

    // ===================================================================================================================
    // The pool step fails and the strategy says nothing (the swallowed failure)
    // ===================================================================================================================

    /// @dev A stablecoin that can freeze an address is realistic: freeze the position manager and the pool step cannot
    /// deliver the dollars to the pool. Anything that makes the inner step revert behaves the same.
    function _failingPoolStep() internal returns (Sale memory s, Vm.Log[] memory logs, uint256 raised) {
        s = _graduatedSale();
        raised = s.auction.currencyRaised();
        quote.setBlocked(address(positionManager), true);
        vm.recordLogs();
        vm.prank(stranger);
        strategy.migrate(ILBPInitializer(address(s.auction))); // does not revert
        logs = vm.getRecordedLogs();
    }

    function test_swallowedFailure_theTransactionSucceedsButThereIsNoPool() public {
        (Sale memory s, Vm.Log[] memory logs, uint256 raised) = _failingPoolStep();
        // What a reader of the chain sees:
        assertEq(_logs(logs, ILBPStrategy.Migrated.selector), 0, "no Migrated event");
        assertEq(_logs(logs, ILBPStrategy.MigrationFailed.selector), 1, "one MigrationFailed event");
        assertEq(_logs(logs, ILBPStrategy.FundsRecovered.selector), 1, "one FundsRecovered event");
        // The same CurrencySwept / TokensSwept events a SUCCESSFUL step emits are present: a reader keyed on them is fooled.
        assertGe(_logs(logs, ILBPStrategy.CurrencySwept.selector), 1, "CurrencySwept is emitted on failure too");
        assertGe(_logs(logs, ILBPStrategy.TokensSwept.selector), 1, "TokensSwept is emitted on failure too");
        // The state:
        assertEq(_poolSqrtPrice(s.key), 0, "there is no pool");
        assertFalse(treasury.poolIsOpen(strategy, ILBPInitializer(address(s.auction))), "the treasury can tell");
        uint256 fee = raised * FEE_PIPS / 1_000_000;
        assertEq(quote.balanceOf(platform), fee, "the platform fee was still paid");
        assertEq(
            quote.balanceOf(address(treasury)), raised - fee, "all 97 of every 100 went to the treasury, none to a pool"
        );
        assertEq(share.balanceOf(address(treasury)), POOL_RESERVE, "the whole Share reserve too");
        // One-shot: nobody can try again.
        vm.expectRevert(abi.encodeWithSelector(ILBPStrategy.InitializerNotRegistered.selector, s.auction));
        strategy.migrate(ILBPInitializer(address(s.auction)));
    }

    /// @notice The three-step finish reads the pool, not the events, and refuses to split money as if a pool existed.
    function test_swallowedFailure_theFinishStepsKeepTheMoneyWhole() public {
        (Sale memory s,,) = _failingPoolStep();
        // step 1 already ran (by the stranger); running it again is a harmless no-op
        assertFalse(treasury.openPool(strategy, ILBPInitializer(address(s.auction))), "step 1: nothing left to do");
        // step 2 refuses: splitting 97 as 15:60 would put 77 of every 100 into the floor and nothing in a pool
        vm.expectRevert(MockTreasury.NoPool.selector);
        treasury.settle(quote, strategy, ILBPInitializer(address(s.auction)));
        assertEq(treasury.spendable() + treasury.floorMoney(), 0, "no bucket was touched");
        // step 3 still works: the unsold Shares are collected
        assertTrue(treasury.sweepUnsold(IAuctionSweeps(address(s.auction))), "step 3 ran");
    }

    /// @notice The finish's protection against the swallowed failure depends on the pool guard. With no guard the key is
    /// the plain one, which a stranger can initialise at any price after the sale opens; "a pool exists at that key" is
    /// then true while the project's own pool never opened. The finish must still refuse to split, and it must not take
    /// the stranger's pool for the project's.
    function test_swallowedFailure_withoutAGuardAStrangersPlainPoolDoesNotFoolTheFinish() public {
        _noGuard();
        Sale memory s = _openSale(_standard());
        vm.roll(s.startBlock);
        _bid(s, alice, 7000 * DOLLAR, 100);
        _bid(s, bob, 5000 * DOLLAR, 100);
        PoolKey memory plain = _poolKey(address(0));
        vm.prank(stranger);
        poolManager.initialize(plain, PRICE_ONE); // the stranger's pool, at a price they chose
        _toEnd(s);
        vm.roll(s.endBlock + 1);
        uint256 raised = s.auction.currencyRaised();
        quote.setBlocked(address(positionManager), true); // the pool step cannot deliver the dollars
        vm.recordLogs();
        vm.prank(stranger);
        strategy.migrate(ILBPInitializer(address(s.auction)));
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(_logs(logs, ILBPStrategy.MigrationFailed.selector), 1, "the pool step failed and said nothing");
        assertEq(_poolSqrtPrice(plain), PRICE_ONE, "the only pool that exists is the stranger's");
        assertFalse(treasury.poolIsOpen(strategy, ILBPInitializer(address(s.auction))), "it is not the project's");
        uint256 held = quote.balanceOf(address(treasury));
        assertEq(held, raised - raised * FEE_PIPS / 1_000_000, "97 of every 100 are in the treasury, none in a pool");

        vm.expectRevert(MockTreasury.NoPool.selector);
        treasury.settle(quote, strategy, ILBPInitializer(address(s.auction)));
        assertEq(treasury.spendable() + treasury.floorMoney(), 0, "no bucket was touched");
    }

    // ===================================================================================================================
    // Stranger gifts before the pool step change nothing for the recipients' accounting
    // ===================================================================================================================

    function test_donations_toTheStrategyAndAuctionDoNotChangeThePoolStep() public {
        Sale memory s = _graduatedSale();
        uint256 snap = vm.snapshotState();
        strategy.migrate(ILBPInitializer(address(s.auction)));
        Outcome memory clean = _outcome(s);

        vm.revertToState(snap);
        quote.mint(address(strategy), 1000 * DOLLAR);
        quote.mint(address(s.auction), 1000 * DOLLAR);
        share.mint(address(strategy), 1000e18);
        strategy.migrate(ILBPInitializer(address(s.auction)));
        Outcome memory gifted = _outcome(s);
        assertEq(gifted.platformDollars, clean.platformDollars, "same fee");
        assertEq(gifted.poolDollars, clean.poolDollars, "same pool dollars");
        assertEq(gifted.poolShares, clean.poolShares, "same pool Shares");
        assertEq(gifted.treasuryDollars, clean.treasuryDollars, "the treasury got none of the gifts");
        assertEq(gifted.treasuryShares, clean.treasuryShares, "nor the Share gift");
        assertEq(gifted.sqrtPrice, clean.sqrtPrice, "same pool price");
    }

    /// @notice Many one-dollar bids at many prices (the cheapest allowed spam) do not stop the sale.
    function test_dust_manyMinimumBidsAtManyPricesDoNotStopTheSale() public {
        Sale memory s = _openSale(_standard());
        vm.roll(s.startBlock);
        for (uint256 k = 1; k <= 120; ++k) {
            _bid(s, makeAddr(string.concat("spam", vm.toString(k))), DOLLAR, k);
        }
        _bid(s, alice, 12_000 * DOLLAR, 300);
        _toEnd(s);
        assertTrue(s.auction.isGraduated(), "the sale still graduates");
        vm.roll(s.endBlock + 1);
        treasury.openPool(strategy, ILBPInitializer(address(s.auction)));
        assertTrue(treasury.poolIsOpen(strategy, ILBPInitializer(address(s.auction))), "and the pool opens");
    }
}

contract AttacksLocalTest is AttackBase {
    function _fork() internal pure override returns (bool) {
        return false;
    }
}

contract AttacksForkTest is AttackBase {
    function _fork() internal pure override returns (bool) {
        return true;
    }
}
