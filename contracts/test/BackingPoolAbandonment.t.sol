// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BackingPool} from "../src/BackingPool.sol";
import {BackingPoolFixture} from "./helpers/BackingPoolFixture.sol";

/// @notice Abandonment: by the clock (no call needed), by a vote of the backers, and the refunds after it.
contract BackingPoolAbandonmentTest is BackingPoolFixture {
    event MilestoneResolved(uint256 indexed id, bool wasReleased, uint256 amount);
    event AbandonVoted(address indexed backer, uint256 weight);
    event Abandoned(address indexed by, bool byVote, uint256 escrow, uint256 orphaned);

    /// @dev Three backers past the early window: Alice 60%, Bob 30%, Carol 10% of the project money.
    function _threeBackers() internal {
        _pastEarly();
        _buy(ALICE, 6_000e18);
        _buy(BOB, 3_000e18);
        _buy(CAROL, 1_000e18);
    }

    // ---- abandonment by the clock ---------------------------------------------------------------------------------

    function test_no_release_for_the_set_time_makes_the_project_abandoned() public {
        _threeBackers();
        vm.warp(pool.abandonableAt() - 1);
        assertFalse(pool.abandoned());
        vm.expectRevert(BackingPool.NotAbandonable.selector);
        pool.declareAbandoned();
        vm.warp(pool.abandonableAt());
        // True from this second, before anyone has called anything.
        assertTrue(pool.abandoned());
        assertTrue(pool.snapshot(ALICE).abandoned);
        uint256 escrow = pool.escrow();
        uint256 fees = pool.feesTaken();
        vm.expectEmit(true, false, false, true, address(pool));
        emit Abandoned(MALLORY, false, escrow - 1, 1);
        vm.prank(MALLORY);
        pool.declareAbandoned();
        assertTrue(pool.abandoned());
        // The call also sends the treasury what it was owed.
        assertEq(quote.balanceOf(treasury), fees + 1);
        vm.expectRevert(BackingPool.IsAbandoned.selector);
        pool.declareAbandoned();
    }

    /// @dev The clock measures time with backers' money held: a pool nobody has backed yet is never abandoned,
    /// and the clock starts with the first backer in.
    function test_a_pool_with_no_money_in_it_is_not_abandoned_by_the_clock() public {
        vm.warp(uint256(pool.openedAt()) + 400 days);
        assertFalse(pool.abandoned());
        vm.expectRevert(BackingPool.NotAbandonable.selector);
        pool.declareAbandoned();
        _buy(ALICE, 1_000e18);
        assertEq(pool.lastReleaseAt(), _now());
        assertEq(pool.abandonableAt(), _now() + 180 days);
        assertFalse(pool.abandoned());
        _buy(BOB, 1_000e18);
        _skip(1 days);
        _buy(BOB, 1_000e18);
        assertEq(pool.abandonableAt(), _now() + 179 days, "later buys do not restart it");
    }

    function test_once_abandoned_buying_and_milestones_stop_for_good() public {
        _threeBackers();
        vm.warp(pool.abandonableAt());
        // Nobody has declared anything, and still:
        vm.prank(ALICE);
        vm.expectRevert(BackingPool.IsAbandoned.selector);
        pool.buy(1e18, 0, type(uint256).max);
        vm.prank(FOUNDER);
        vm.expectRevert(BackingPool.IsAbandoned.selector);
        pool.postMilestone(REF);
        vm.prank(ALICE);
        vm.expectRevert(BackingPool.IsAbandoned.selector);
        pool.voteAbandon();
        pool.declareAbandoned();
        vm.prank(ALICE);
        vm.expectRevert(BackingPool.IsAbandoned.selector);
        pool.buy(1e18, 0, type(uint256).max);
        vm.prank(FOUNDER);
        vm.expectRevert(BackingPool.IsAbandoned.selector);
        pool.postMilestone(REF);
        vm.expectRevert(BackingPool.NoOpenMilestone.selector);
        pool.resolveMilestone();
    }

    /// @dev Finding F7b: nobody has to call `declareAbandoned`. The first sale after the clock ran out makes
    /// the change itself: no fee, nothing given up, the seller's escrow part paid.
    function test_a_sale_after_the_clock_ran_out_is_a_refund_without_anyone_declaring() public {
        _threeBackers();
        vm.warp(pool.abandonableAt());
        uint256 bobEscrow = pool.escrowOf(BOB);
        assertApproxEqAbs(bobEscrow, 297e18, 2);
        uint256 fees = pool.feesTaken();
        uint256 units = pool.balanceOf(BOB);
        (uint256 quoted, uint256 fee, uint256 refund,) = pool.quoteSell(BOB, units);
        assertEq(fee, 0);
        assertEq(refund, bobEscrow);
        assertEq(pool.snapshot(BOB).holderSellValue, quoted);

        vm.expectEmit(true, false, false, false, address(pool));
        emit Abandoned(BOB, false, 0, 0);
        assertEq(_sell(BOB, units), quoted);
        assertEq(pool.feesTaken(), fees);
        assertEq(pool.refunded(), bobEscrow);
        assertTrue(pool.abandoned());
        vm.expectRevert(BackingPool.IsAbandoned.selector);
        pool.declareAbandoned();
        _assertSolvent();
    }

    function test_after_abandonment_every_backer_gets_their_part_of_the_escrow_in_any_order() public {
        _threeBackers();
        // One tranche went to the project first.
        _release();
        vm.warp(pool.abandonableAt());
        uint256 aliceShare = pool.escrowOf(ALICE);
        uint256 bobShare = pool.escrowOf(BOB);
        uint256 carolShare = pool.escrowOf(CAROL);
        pool.declareAbandoned();
        uint256 escrow = pool.escrow();
        // Declaring changed nobody's part.
        assertEq(pool.escrowOf(ALICE), aliceShare);
        assertEq(pool.escrowOf(BOB), bobShare);
        assertEq(pool.escrowOf(CAROL), carolShare);
        assertApproxEqAbs(aliceShare + bobShare + carolShare, escrow, 3);
        // 60 / 30 / 10, as they paid in.
        assertApproxEqRel(aliceShare, escrow * 60 / 100, 1e12);

        (uint256 out, uint256 fee, uint256 refund,) = pool.quoteSell(BOB, pool.balanceOf(BOB));
        assertEq(fee, 0, "no fee once abandoned");
        assertEq(refund, bobShare);
        uint256 before = quote.balanceOf(BOB);
        assertEq(_sellAll(BOB), out);
        assertEq(quote.balanceOf(BOB) - before, out);
        assertEq(pool.refunded(), bobShare);

        // The others' parts did not move because Bob went first.
        assertApproxEqAbs(pool.escrowOf(ALICE), aliceShare, 2);
        assertApproxEqAbs(pool.escrowOf(CAROL), carolShare, 2);
        // A partial sale pays the matching part of the refund.
        uint256 half = pool.balanceOf(ALICE) / 2;
        (,, uint256 halfRefund,) = pool.quoteSell(ALICE, half);
        assertApproxEqAbs(halfRefund, aliceShare / 2, 1e6);
        _sell(ALICE, half);
        _sellAll(ALICE);
        _sellAll(CAROL);
        assertEq(pool.escrow(), 0, "the last backer out takes the last of it");
        assertEq(pool.totalWeight(), 0);
        assertEq(pool.totalSupply(), 0);
        assertEq(pool.refunded(), escrow);
        _assertSolvent();
    }

    function test_an_open_milestone_is_heard_before_the_clock_decides() public {
        _threeBackers();
        vm.warp(pool.abandonableAt() - 1 days);
        vm.prank(FOUNDER);
        pool.postMilestone(REF);
        vm.warp(pool.abandonableAt());
        assertFalse(pool.abandoned());
        vm.expectRevert(BackingPool.NotAbandonable.selector);
        pool.declareAbandoned();
        // The window is over: it can be released, and until its deadline the clock waits for that.
        _skip(7 days);
        assertFalse(pool.abandoned());
        (bool wasReleased,) = pool.resolveMilestone();
        assertTrue(wasReleased);
        assertFalse(pool.abandoned());
        assertEq(pool.abandonableAt(), _now() + 180 days);
    }

    function test_a_milestone_nobody_resolves_does_not_hold_the_clock_past_its_deadline() public {
        _threeBackers();
        vm.warp(pool.abandonableAt() - 1 days);
        vm.prank(FOUNDER);
        pool.postMilestone(REF);
        _skip(14 days - 1);
        assertFalse(pool.abandoned());
        _skip(1);
        assertTrue(pool.abandoned());
        uint256 escrow = pool.escrow();
        // A sale now voids the milestone, writes the abandonment and refunds.
        uint256 bobEscrow = pool.escrowOf(BOB);
        _sellAll(BOB);
        assertEq(uint8(_status(1)), uint8(BackingPool.MilestoneStatus.Void));
        assertEq(pool.pending(), 0);
        assertEq(pool.released(), 1, "only the slice nobody had a weight for");
        assertEq(pool.refunded(), bobEscrow);
        assertEq(pool.escrow(), escrow - 1 - bobEscrow);
    }

    /// @dev With every backer gone there is nobody to hand anything back to, so the clock does not run: the
    /// pool stays open, what the sellers left behind stays project money for milestones to release, and the
    /// clock starts again with the next backer (who gets no part of what was left: finding F3).
    function test_a_pool_every_backer_has_left_stays_open_and_its_escrow_stays_project_money() public {
        _threeBackers();
        _sellAll(ALICE);
        _sellAll(BOB);
        _sellAll(CAROL);
        uint256 left = pool.escrow();
        assertEq(left, 990e18);
        assertEq(pool.totalWeight(), 0);
        vm.warp(pool.abandonableAt() + 100 days);
        assertFalse(pool.abandoned());
        vm.expectRevert(BackingPool.NotAbandonable.selector);
        pool.declareAbandoned();

        vm.prank(FOUNDER);
        pool.postMilestone(REF);
        _skip(7 days);
        (, uint256 amount) = pool.resolveMilestone();
        assertEq(amount, left / 4);

        _buy(MALLORY, 1_000e18);
        assertEq(pool.lastReleaseAt(), _now(), "the clock starts with her");
        assertLe(pool.escrowOf(MALLORY), 99e18);
        vm.warp(pool.abandonableAt());
        _sellAll(MALLORY);
        assertLe(pool.refunded(), 99e18);
        assertEq(pool.escrow(), 0);
        // Everything the three left, less nothing, went to the treasury: a quarter by the milestone, the rest now.
        assertGe(pool.released(), left);
        _assertSolvent();
    }

    // ---- abandonment by vote --------------------------------------------------------------------------------------

    function test_more_than_half_the_weight_can_declare_abandonment_once_releases_have_stopped() public {
        _threeBackers();
        vm.warp(uint256(pool.lastReleaseAt()) + 90 days);
        vm.expectEmit(true, false, false, true, address(pool));
        emit AbandonVoted(BOB, pool.weightOf(BOB));
        vm.prank(BOB);
        pool.voteAbandon();
        assertEq(pool.abandonVotes(), pool.weightOf(BOB));
        vm.expectRevert(BackingPool.NotAbandonable.selector);
        pool.declareAbandoned();
        vm.prank(ALICE);
        pool.voteAbandon();
        uint256 escrow = pool.escrow();
        vm.expectEmit(true, false, false, true, address(pool));
        emit Abandoned(address(this), true, escrow - 1, 1);
        pool.declareAbandoned();
        assertTrue(pool.abandoned());
    }

    function test_exactly_half_is_not_enough() public {
        BackingPool.Params memory p = defaultTerms();
        p.feeBps = 0;
        p.earlyCap = 0;
        p.voteSeasoning = 0;
        p.voteAfter = 0;
        BackingPool even = new BackingPool(treasury, FOUNDER, IERC20(address(quote)), p);
        vm.prank(ALICE);
        quote.approve(address(even), type(uint256).max);
        vm.prank(BOB);
        quote.approve(address(even), type(uint256).max);
        // With no weight at all there is no majority.
        vm.expectRevert(BackingPool.NotAbandonable.selector);
        even.declareAbandoned();
        vm.prank(ALICE);
        even.buy(1_000e18, 0, type(uint256).max);
        vm.prank(BOB);
        even.buy(1_000e18, 0, type(uint256).max);
        assertEq(even.weightOf(ALICE), even.weightOf(BOB));
        vm.prank(ALICE);
        even.voteAbandon();
        vm.expectRevert(BackingPool.NotAbandonable.selector);
        even.declareAbandoned();
        vm.prank(BOB);
        even.voteAbandon();
        even.declareAbandoned();
        assertTrue(even.abandoned());
    }

    function test_a_majority_cannot_end_a_project_that_released_a_tranche_lately() public {
        _threeBackers();
        _release();
        _skip(30 days);
        vm.prank(ALICE);
        pool.voteAbandon();
        vm.prank(BOB);
        pool.voteAbandon();
        assertGt(pool.abandonVotes(), pool.totalWeight() / 2);
        // 30 days after a release: the vote is there, the waiting time is not.
        vm.expectRevert(BackingPool.NotAbandonable.selector);
        pool.declareAbandoned();
        vm.warp(uint256(pool.lastReleaseAt()) + 90 days);
        pool.declareAbandoned();
        assertTrue(pool.abandoned());
    }

    function test_a_vote_waits_after_a_buy_and_a_new_buy_withdraws_it() public {
        _threeBackers();
        uint256 notBefore = _now() + 30 days;
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(BackingPool.TooSoon.selector, notBefore));
        pool.voteAbandon();
        _skip(30 days);
        vm.prank(ALICE);
        pool.voteAbandon();
        assertTrue(pool.votedAbandon(ALICE));
        assertTrue(pool.snapshot(ALICE).holderVotedAbandon);
        vm.prank(ALICE);
        vm.expectRevert(BackingPool.AlreadyDone.selector);
        pool.voteAbandon();
        vm.prank(MALLORY);
        vm.expectRevert(BackingPool.NoSay.selector);
        pool.voteAbandon();

        _buy(ALICE, 1e18);
        assertFalse(pool.votedAbandon(ALICE));
        assertEq(pool.abandonVotes(), 0);
        vm.expectRevert(BackingPool.NotAbandonable.selector);
        pool.declareAbandoned();
    }

    function test_selling_or_leaving_takes_the_vote_with_it() public {
        _threeBackers();
        _skip(30 days);
        vm.prank(ALICE);
        pool.voteAbandon();
        vm.prank(BOB);
        pool.voteAbandon();
        _sell(ALICE, pool.balanceOf(ALICE) / 2);
        assertEq(pool.abandonVotes(), pool.weightOf(ALICE) + pool.weightOf(BOB));
        _sellAll(ALICE);
        assertEq(pool.abandonVotes(), pool.weightOf(BOB));
        _post();
        _leave(BOB);
        assertEq(pool.abandonVotes(), 0);
    }

    function test_a_vote_ends_an_open_milestone_without_a_release() public {
        _threeBackers();
        _skip(90 days);
        _post();
        vm.prank(ALICE);
        pool.voteAbandon();
        uint256 escrow = pool.escrow();
        pool.declareAbandoned();
        assertEq(uint8(_status(1)), uint8(BackingPool.MilestoneStatus.Void));
        assertEq(pool.pending(), 0);
        assertEq(pool.escrow(), escrow - 1);
        assertEq(pool.released(), 1);
        // Everyone gets their whole part back: the tranche was never taken.
        assertApproxEqAbs(pool.escrowOf(BOB), 297e18, 2);
    }
}
