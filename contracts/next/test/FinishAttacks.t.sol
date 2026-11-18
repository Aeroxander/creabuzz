// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Platform} from "./helpers/Platform.sol";
import {Launcher} from "../src/Launcher.sol";
import {Treasury} from "../src/Treasury.sol";
import {Finisher} from "../src/Finisher.sol";
import {SaleParams} from "../src/Pinned.sol";

/// @notice Attacks on the three-step finish and the way out of a pool that never opens: strangers calling every step first, twice
/// and out of order; a failed pool step (the swallowed failure of milestone 1, reproduced) with the Treasury refusing to split;
/// the abandon path early and on time; a sale under its minimum and its retry; a partial sale.
abstract contract FinishAttacksBase is Platform {
    function _fork() internal pure virtual returns (bool);

    function setUp() public virtual {
        _setUpPlatform(_fork());
    }

    /// @dev One sale of 320,000 dollars of demand (the route's, times ten for the 100,000 auction), over, all bids placed.
    function _endedSale() internal returns (Proj memory p, Sale memory s) {
        p = _launch(founder, keccak256("finish"));
        s = _open(p);
        _fiveBids(s);
        _toEnd(s);
        vm.roll(s.endBlock + 1);
    }

    function _state(Proj memory p) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                p.treasury.spendable(),
                p.treasury.melting(),
                p.treasury.poolOpen(),
                p.treasury.saleClosed(),
                p.treasury.settled(),
                uint8(p.finisher.stage()),
                p.finisher.settled(),
                usd.balanceOf(address(p.treasury)),
                usd.balanceOf(address(p.finisher)),
                p.shares.balanceOf(address(p.treasury)),
                p.shares.balanceOf(address(p.finisher))
            )
        );
    }

    // ============================================== every order of the steps =========================================

    /// @dev A stranger may call the three steps in any order and any number of times. Out-of-order calls revert and change
    /// nothing; repeated calls do nothing; and however the calls fall, once a stranger then does the three steps in order the
    /// project is in the same state as after the natural order alone.
    function test_attack_strangersCallTheStepsInEveryOrderAndRepeatThem() public {
        (Proj memory p, Sale memory s) = _endedSale();
        s;
        uint256 base = vm.snapshotState();
        // the natural order first, to know the end state
        vm.startPrank(stranger);
        p.finisher.openPool();
        p.finisher.settle();
        p.finisher.sweep();
        vm.stopPrank();
        bytes32 want = _state(p);
        assertTrue(p.treasury.saleClosed());

        uint8[3][6] memory perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
        for (uint256 i; i < perms.length; ++i) {
            vm.revertToState(base);
            // each order is tried twice in a row; a call that reverts must leave the state exactly as it was
            assertGe(_tryOrder(p, i, perms[i]), 2, "some of the calls did work");
            // whatever fell, a stranger who then does the three steps in order brings it to the natural end state
            vm.startPrank(stranger);
            p.finisher.openPool();
            p.finisher.settle();
            p.finisher.sweep();
            vm.stopPrank();
            assertEq(_state(p), want, "every order ends in the state of the natural order");
        }
    }

    /// @dev Call the three steps in the given order, twice, each by a different stranger; returns how many calls went through.
    function _tryOrder(Proj memory p, uint256 who, uint8[3] memory order) internal returns (uint256 completed) {
        bytes4[3] memory sel = _selectors();
        for (uint256 round; round < 2; ++round) {
            for (uint256 j; j < 3; ++j) {
                bytes32 before = _state(p);
                vm.prank(address(uint160(0x5000 + who * 10 + j)));
                (bool ok,) = address(p.finisher).call(abi.encodeWithSelector(sel[order[j]]));
                if (!ok) assertEq(_state(p), before, "a refused step changed nothing");
                else completed++;
            }
        }
    }

    // ============================================== each step names why it refuses ====================================

    function test_finish_stepsOnAProjectWithNoSaleRefuse() public {
        Proj memory p = _launch(founder, keccak256("idle"));
        vm.startPrank(stranger);
        vm.expectRevert(Finisher.WrongStage.selector);
        p.finisher.openPool();
        vm.expectRevert(Finisher.WrongStage.selector);
        p.finisher.settle();
        vm.expectRevert(Finisher.WrongStage.selector);
        p.finisher.sweep();
        vm.expectRevert(Finisher.WrongStage.selector);
        p.finisher.abandon();
        vm.stopPrank();
    }

    /// @dev Each early call is refused with its own reason, and the reasons are the ones in the plan: the pool step must come
    /// first, and the money is split before the Shares are swept.
    function test_finish_eachStepRefusesWithItsOwnReasonWhenCalledTooEarly() public {
        (Proj memory p,) = _endedSale();
        vm.startPrank(stranger);
        vm.expectRevert(Finisher.PoolStepNotRun.selector);
        p.finisher.settle();
        vm.expectRevert(Finisher.PoolStepNotRun.selector);
        p.finisher.sweep();
        p.finisher.openPool();
        vm.expectRevert(Finisher.SettleFirst.selector);
        p.finisher.sweep();
        p.finisher.settle();
        p.finisher.sweep();
        vm.stopPrank();
    }

    /// @dev The auction's own report sets the least that must have come back. If the Finisher holds less (it cannot, short of a
    /// bug in the strategy or the token), it refuses rather than split a smaller sum as though it were the whole.
    function test_settle_refusesWhenLessCameBackThanTheAuctionsFiguresSay() public {
        (Proj memory p, Sale memory s) = _endedSale();
        uint256 raised = s.auction.currencyRaised();
        uint256 net = raised - raised * 30_000 / 1_000_000;
        uint256 least = net - net * SaleParams.POOL_RATE / SaleParams.RATE_SCALE;
        p.finisher.openPool();
        uint256 held = usd.balanceOf(address(p.finisher));
        assertGe(held, least);
        vm.prank(address(p.finisher));
        usd.transfer(makeAddr("somewhere"), held - least + 1); // simulate the loss of one unit more than the pool could explain
        vm.expectRevert(abi.encodeWithSelector(Finisher.MoneyMissing.selector, least - 1, least));
        p.finisher.settle();
        assertFalse(p.treasury.poolOpen(), "nothing was marked open");
    }

    // ============================================== no re-entry while a step runs ====================================

    /// @dev A dollar token that calls back into the Finisher while the Finisher is paying the Treasury: the call is refused.
    function test_settle_aCallBackFromTheDollarTokenCannotReenter() public {
        (Proj memory p,) = _endedSale();
        p.finisher.openPool();
        usd.armCallback(address(p.treasury), address(p.finisher), abi.encodeCall(Finisher.settle, ()));
        p.finisher.settle();
        assertTrue(usd.callbackFired());
        assertFalse(usd.callbackOk(), "the call-back reverted");
        assertEq(
            bytes4(usd.callbackRet()), Finisher.Reentrancy.selector, "because the Finisher was in the middle of a call"
        );
    }
}

abstract contract FinishAttacksBase2 is Platform {
    function _fork() internal pure virtual returns (bool);

    function setUp() public virtual {
        _setUpPlatform(_fork());
    }

    /// @dev One sale of 320,000 dollars of demand (the route's, times ten for the 100,000 auction), over, all bids placed.
    function _endedSale() internal returns (Proj memory p, Sale memory s) {
        p = _launch(founder, keccak256("finish"));
        s = _open(p);
        _fiveBids(s);
        _toEnd(s);
        vm.roll(s.endBlock + 1);
    }

    function _state(Proj memory p) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                p.treasury.spendable(),
                p.treasury.melting(),
                p.treasury.poolOpen(),
                p.treasury.saleClosed(),
                p.treasury.settled(),
                uint8(p.finisher.stage()),
                p.finisher.settled(),
                usd.balanceOf(address(p.treasury)),
                usd.balanceOf(address(p.finisher)),
                p.shares.balanceOf(address(p.treasury)),
                p.shares.balanceOf(address(p.finisher))
            )
        );
    }

    // ============================================== a failed pool step ================================================

    /// @dev The milestone 1 reproduction: the pool step fails inside the strategy and is reported as success, and the 97 of every
    /// 100 dollars and the whole Share reserve come back. Every step a stranger can call, in any order and twice, either does
    /// nothing or refuses, and the Treasury refuses to split: no dollar reaches a bucket and nothing marks the pool open.
    function test_attack_aFailedPoolStepIsNeverSplitAsThoughThePoolExisted() public {
        (Proj memory p, Sale memory s) = _endedSale();
        uint256 raised = s.auction.currencyRaised();
        _failThePoolStep(true);
        vm.startPrank(stranger);
        assertTrue(p.finisher.openPool(), "the strategy swallows the failure: the call succeeds");
        assertFalse(p.finisher.openPool(), "and cannot be run again");
        vm.stopPrank();
        _failThePoolStep(false);
        assertFalse(p.finisher.poolIsOpen(), "but the pool manager has no pool for this project");
        uint256 net = raised - raised * 30_000 / 1_000_000;
        assertEq(usd.balanceOf(address(p.finisher)), net, "97 of every 100 dollars are back with the Finisher");
        assertEq(p.shares.balanceOf(address(p.finisher)), SaleParams.POOL_SHARES, "and the whole pool reserve");
        assertEq(usd.balanceOf(poolManager), 0, "nothing is in any pool");

        bytes32 frozen = _state(p);
        vm.startPrank(stranger);
        vm.expectRevert(Finisher.NoPool.selector);
        p.finisher.settle();
        vm.expectRevert(Finisher.SettleFirst.selector);
        p.finisher.sweep();
        // a stranger cannot get the Treasury to split by sending it dollars and calling it himself
        usd.mint(stranger, 1000 * DOLLAR);
        usd.transfer(address(p.treasury), 1000 * DOLLAR);
        vm.expectRevert(Treasury.NoPool.selector);
        p.treasury.settle(1000 * DOLLAR);
        vm.expectRevert(Treasury.NotAllowed.selector);
        p.treasury.markPoolOpen();
        vm.expectRevert(Treasury.NotAllowed.selector);
        p.treasury.markSaleClosed();
        vm.stopPrank();
        assertEq(usd.balanceOf(address(p.treasury)), 1000 * DOLLAR, "only the stranger's own gift sits in the Treasury");
        assertEq(p.treasury.spendable() + p.treasury.melting(), 0, "no bucket holds a dollar");
        assertFalse(p.treasury.poolOpen());
        assertEq(p.vester.start(), 0, "the Vester's clock did not start");
        assertEq(usd.balanceOf(address(p.finisher)), net, "the money is where it was");
        frozen;

        // nobody can exit
        vm.prank(alice);
        vm.expectRevert(Treasury.NotSettled.selector);
        p.treasury.handBack(1);
    }

    // ============================================== the way out: abandon ==============================================

    function test_abandon_isNotUsableEarlyAndUsableOnTime() public {
        (Proj memory p, Sale memory s) = _endedSale();
        _failThePoolStep(true);
        p.finisher.openPool();
        _failThePoolStep(false);
        uint256 from = uint256(s.endBlock) + 50_400; // seven days at twelve seconds a block, written out
        assertEq(p.finisher.abandonBlock(), from);
        vm.roll(from - 1);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Finisher.TooEarly.selector, from));
        p.finisher.abandon();
        vm.roll(from);
        vm.prank(stranger);
        p.finisher.abandon();
        assertEq(uint256(p.finisher.stage()), uint256(Finisher.Stage.Abandoned));
    }

    /// @dev Owner call 4, with the figures: of each 100 raised, 3 to the platform, 15 spendable, 82 floor (the 60 and the 22 that
    /// had no pool to go to), all Shares back to the Treasury as reserve, the Vester's clock started, exits open.
    function test_abandon_gives15And82AndOpensExits() public {
        (Proj memory p, Sale memory s) = _endedSale();
        uint256 raised = s.auction.currencyRaised();
        uint256 fee = raised * 30_000 / 1_000_000;
        uint256 net = raised - fee;
        _failThePoolStep(true);
        p.finisher.openPool();
        _failThePoolStep(false);
        vm.roll(uint256(s.endBlock) + SaleParams.ABANDON_DELAY_BLOCKS);
        uint256 unsold = s.auction.remainingSupply();
        vm.prank(stranger);
        p.finisher.abandon();

        uint256 floorOnly = net * SaleParams.POOL_RATE / SaleParams.RATE_SCALE;
        uint256 rest = net - floorOnly;
        assertEq(p.treasury.spendable(), rest * 15 / 75, "15 of the 75 that would have come back");
        assertEq(p.treasury.melting(), net - rest * 15 / 75, "the other 60 and the 22 are floor");
        assertEq(
            usd.balanceOf(platform) + p.treasury.spendable() + p.treasury.melting(),
            raised,
            "3 + 15 + 82 is every dollar raised"
        );
        assertApproxEqAbs(p.treasury.spendable(), raised * 15 / 100, raised / 1_000_000 + 2, "15 of every 100");
        assertApproxEqAbs(p.treasury.melting(), raised * 82 / 100, raised / 1_000_000 + 2, "82 of every 100");
        assertEq(usd.balanceOf(address(p.finisher)), 0);
        assertTrue(p.treasury.abandoned());
        assertTrue(p.treasury.poolOpen(), "the sale phase is over");
        assertGt(p.vester.start(), 0, "the founder's Shares are not locked for ever behind a pool that never opened");
        assertEq(p.shares.balanceOf(address(p.finisher)), 0);
        assertEq(
            p.shares.balanceOf(address(p.treasury)),
            300_000_000 * SHARE + SaleParams.POOL_SHARES + unsold,
            "the strategy's Shares and the unsold Shares are plain reserve"
        );
        assertTrue(p.treasury.saleClosed(), "exits are open");

        // a bidder collects Shares and exits against the floor
        (, uint256 got) = _collectBid(s, 4);
        assertGt(got, 0);
        vm.startPrank(alice);
        p.shares.approve(address(p.treasury), type(uint256).max);
        uint256 paid = p.treasury.handBack(got / 2);
        vm.stopPrank();
        assertGt(paid, 0, "an exit pays after an abandon");
        // abandon is once, and a project whose sale was abandoned does not open another
        vm.expectRevert(Finisher.WrongStage.selector);
        p.finisher.abandon();
        assertFalse(p.finisher.canOpen());
        vm.roll(block.number + 1_000_000);
        _openRefused(p, abi.encodeWithSelector(Launcher.WrongStage.selector)); // the Treasury's sale phase is over
    }

    /// @dev Abandon runs the pool step itself if nobody has, so a pool that nobody ever tried to open is reached too.
    function test_abandon_runsThePoolStepIfNobodyDid() public {
        (Proj memory p, Sale memory s) = _endedSale();
        _failThePoolStep(true);
        vm.roll(uint256(s.endBlock) + SaleParams.ABANDON_DELAY_BLOCKS);
        vm.prank(stranger);
        p.finisher.abandon();
        _failThePoolStep(false);
        assertEq(uint256(p.finisher.stage()), uint256(Finisher.Stage.Abandoned));
        assertTrue(p.treasury.saleClosed());
    }

    /// @dev Abandon is not a way to skip a pool that can still open: if the pool step makes a pool, abandon reverts and the normal
    /// finish applies.
    function test_abandon_refusesWhenAPoolExists() public {
        (Proj memory p, Sale memory s) = _endedSale();
        vm.roll(uint256(s.endBlock) + SaleParams.ABANDON_DELAY_BLOCKS);
        vm.prank(stranger);
        vm.expectRevert(Finisher.PoolExists.selector);
        p.finisher.abandon(); // would run the pool step, which succeeds
        assertEq(uint256(p.finisher.stage()), uint256(Finisher.Stage.Open), "and the failed attempt changed nothing");
        // after the pool step by a stranger, same answer, and the normal steps still work
        p.finisher.openPool();
        vm.expectRevert(Finisher.PoolExists.selector);
        p.finisher.abandon();
        p.finisher.settle();
        p.finisher.sweep();
        assertTrue(p.treasury.saleClosed());
        vm.expectRevert(Finisher.WrongStage.selector);
        p.finisher.abandon();
    }
}

abstract contract FinishAttacksBase3 is Platform {
    function _fork() internal pure virtual returns (bool);

    function setUp() public virtual {
        _setUpPlatform(_fork());
    }

    function test_abandon_isRefusedForASaleThatFailedItsMinimum() public {
        Proj memory p = _launch(founder, keccak256("under"));
        Sale memory s = _open(p);
        vm.roll(s.startBlock);
        _bid(s, alice, 20_000 * DOLLAR, 1); // minimum is 100,000
        _toEnd(s);
        vm.roll(uint256(s.endBlock) + SaleParams.ABANDON_DELAY_BLOCKS);
        vm.prank(stranger);
        vm.expectRevert(Finisher.SaleDidNotGraduate.selector);
        p.finisher.abandon();
    }

    // ============================================== a sale under its minimum ===========================================

    /// @dev Everyone is refunded in full by the auction, the Shares come back to the Finisher, nothing reaches the Treasury, and
    /// the project can try again 24 hours after the failed sale ended, with any size; a project that sold cannot.
    function test_underMinimum_refundsEveryoneAndTheProjectTriesAgain() public {
        Proj memory p = _launch(founder, keccak256("under"));
        Sale memory s = _open(p);
        vm.roll(s.startBlock);
        uint256 a = _bid(s, alice, 15_000 * DOLLAR, 1);
        uint256 b = _bid(s, bob, 9000 * DOLLAR, 50);
        _toEnd(s); // 24,000 raised: under the 100,000 minimum
        assertFalse(s.auction.isGraduated());
        vm.roll(s.endBlock + 1);

        vm.startPrank(stranger);
        assertTrue(p.finisher.openPool(), "the pool step runs and fails safely (nothing was raised)");
        vm.expectRevert(Finisher.SaleDidNotGraduate.selector);
        p.finisher.settle();
        assertTrue(p.finisher.sweep(), "the sweep returns the Shares for a new try");
        assertFalse(p.finisher.sweep());
        vm.stopPrank();
        assertEq(uint256(p.finisher.stage()), uint256(Finisher.Stage.Failed));
        assertEq(p.shares.balanceOf(address(p.finisher)), 350_000_000 * SHARE, "all 350M Shares are back");
        assertEq(usd.balanceOf(platform), 0, "no fee on a sale that did not go through");
        assertEq(usd.balanceOf(poolManager), 0, "no pool");
        assertFalse(p.treasury.poolOpen());
        assertEq(p.vester.start(), 0);

        // everyone refunded in full, to the unit
        (uint256 ra,) = _collectBid(s, a);
        (uint256 rb,) = _collectBid(s, b);
        assertEq(ra, 15_000 * DOLLAR);
        assertEq(rb, 9000 * DOLLAR);
        assertEq(usd.balanceOf(address(s.auction)), 0, "the auction holds nothing");

        // not before 24 hours after the sale ended
        uint256 retry = uint256(s.endBlock) + SaleParams.SALE_BLOCKS;
        assertEq(p.finisher.retryBlock(), retry);
        assertFalse(p.finisher.canOpen());
        _openRefused(p, abi.encodeWithSelector(Finisher.CannotOpen.selector));
        vm.roll(retry - 1);
        _openRefused(p, abi.encodeWithSelector(Finisher.CannotOpen.selector));
        vm.roll(retry);
        assertTrue(p.finisher.canOpen());
        // the second try goes through completely
        Sale memory s2 = _open(p);
        assertTrue(address(s2.auction) != address(s.auction));
        vm.roll(s2.startBlock);
        _bid(s2, carol, 120_000 * DOLLAR, 1); // the minimum is 100,000
        _toEnd(s2);
        _finish(p, s2);
        assertTrue(p.treasury.saleClosed());
        assertEq(uint256(p.finisher.stage()), uint256(Finisher.Stage.Done));
        assertApproxEqAbs(
            p.treasury.spendable() + p.treasury.melting() + usd.balanceOf(poolManager) + usd.balanceOf(platform),
            s2.auction.currencyRaised(),
            2
        );
        // a project that sold cannot sell again
        vm.roll(block.number + 100_000);
        _openRefused(p, abi.encodeWithSelector(Launcher.WrongStage.selector));
    }
}

abstract contract FinishAttacksBase4 is Platform {
    function _fork() internal pure virtual returns (bool);

    function setUp() public virtual {
        _setUpPlatform(_fork());
    }

    // ============================== the minimum is the whole sale at the starting price ==============================

    /// @dev Plan version 2 re-run: the minimum (100,000) is every one of the 250M Shares sold at the starting price, so there is no
    /// partial sale any more. Half that demand fails and refunds everyone; the whole of it sells every Share at the starting
    /// price, the pool opens with 22,000 dollars and the 55M Shares that match them, and the pool reserve it did not need is
    /// plain reserve.
    function test_minimumIsTheWholeSale_halfTheDemandFails_theWholeDemandSellsEveryShare() public {
        uint256 snap = vm.snapshotState();
        Proj memory p = _launch(founder, keccak256("half"));
        Sale memory s = _open(p);
        _flat(s, 50_000 * DOLLAR);
        _toEnd(s);
        assertFalse(s.auction.isGraduated(), "half the minimum: the sale fails");
        vm.revertToState(snap);
        p = _launch(founder, keccak256("whole"));
        s = _open(p);
        _flat(s, 100_000 * DOLLAR);
        _toEnd(s);
        assertTrue(s.auction.isGraduated());
        assertEq(s.auction.clearingPrice(), s.floorQ96, "the price stays at the starting price");
        uint256 sold = s.auction.totalCleared();
        assertApproxEqRel(
            sold, SaleParams.SALE_SHARES, 0.01e18, "every auction Share sold (the floor is rounded up a tick)"
        );
        uint256 raised = s.auction.currencyRaised();
        assertGe(raised, 100_000 * DOLLAR - 10);
        _finish(p, s);
        assertEq(usd.balanceOf(platform), raised * 3 / 100, "3%");
        assertApproxEqAbs(usd.balanceOf(poolManager), raised * 22 / 100, 5000, "22% in the pool (a few thousandths)");
        assertApproxEqAbs(p.treasury.spendable(), raised * 15 / 100, 5000);
        assertApproxEqAbs(p.treasury.melting(), raised * 60 / 100, 5000);
        uint256 inPool = p.shares.balanceOf(poolManager);
        assertApproxEqRel(
            inPool, 55_000_000 * SHARE, 0.01e18, "the pool's Shares match its dollars at the starting price"
        );
        assertApproxEqAbs(
            p.shares.balanceOf(address(p.treasury)),
            280_000_000 * SHARE + (SaleParams.SALE_SHARES - sold) + (SaleParams.POOL_SHARES - inPool),
            10,
            "unsold dust and the unused pool reserve are plain reserve (after the 20M stake left it)"
        );
        assertTrue(p.treasury.saleClosed());
    }
}

contract FinishAttacksLocalTest is FinishAttacksBase {
    function _fork() internal pure override returns (bool) {
        return false;
    }
}

contract FinishAttacksForkTest is FinishAttacksBase {
    function _fork() internal pure override returns (bool) {
        return true;
    }
}

contract FinishAttacksLocal2Test is FinishAttacksBase2 {
    function _fork() internal pure override returns (bool) {
        return false;
    }
}

contract FinishAttacksLocal3Test is FinishAttacksBase3 {
    function _fork() internal pure override returns (bool) {
        return false;
    }
}

contract FinishAttacksFork2Test is FinishAttacksBase2 {
    function _fork() internal pure override returns (bool) {
        return true;
    }
}

contract FinishAttacksFork3Test is FinishAttacksBase3 {
    function _fork() internal pure override returns (bool) {
        return true;
    }
}

contract FinishAttacksLocal4Test is FinishAttacksBase4 {
    function _fork() internal pure override returns (bool) {
        return false;
    }
}

contract FinishAttacksFork4Test is FinishAttacksBase4 {
    function _fork() internal pure override returns (bool) {
        return true;
    }
}
