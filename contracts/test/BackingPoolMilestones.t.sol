// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BackingPool} from "../src/BackingPool.sol";
import {BackingPoolFixture, BlockingQuote} from "./helpers/BackingPoolFixture.sol";

/// @notice The project money: milestone posts, objections, releases, and abandonment with its refunds.
contract BackingPoolMilestonesTest is BackingPoolFixture {
    event MilestonePosted(
        uint256 indexed id, bytes32 indexed ref, address indexed by, uint64 windowEndsAt, uint256 eligible
    );
    event Objected(uint256 indexed id, address indexed backer, uint256 weight);
    event MilestoneResolved(uint256 indexed id, bool released, uint256 amount, uint256 objections, uint256 eligible);
    event TreasuryPaid(uint256 amount);
    event AbandonVoted(address indexed backer, uint256 weight);
    event Abandoned(address indexed by, bool byVote, uint256 escrow, uint256 orphaned);

    /// @dev Three backers past the early window: Alice 60%, Bob 30%, Carol 10% of the project money (about).
    function _threeBackers() internal {
        _pastEarly();
        _buy(ALICE, 6_000e18);
        _buy(BOB, 3_000e18);
        _buy(CAROL, 1_000e18);
    }

    // ---- posting --------------------------------------------------------------------------------------------------

    function test_only_the_founder_or_the_dao_posts_a_milestone() public {
        _threeBackers();
        vm.warp(pool.nextClaimAt());
        vm.prank(ALICE);
        vm.expectRevert(BackingPool.NotClaimant.selector);
        pool.postMilestone(REF);

        vm.expectEmit(true, true, true, true, address(pool));
        emit MilestonePosted(1, REF, FOUNDER, uint64(_now() + 7 days), pool.totalWeight());
        vm.prank(FOUNDER);
        assertEq(pool.postMilestone(REF), 1);
        (bytes32 ref, uint64 postedAt, uint64 endsAt, BackingPool.MilestoneStatus status, uint256 eligible,,) =
            pool.milestones(1);
        assertEq(ref, REF);
        assertEq(postedAt, _now());
        assertEq(endsAt, _now() + 7 days);
        assertEq(uint8(status), uint8(BackingPool.MilestoneStatus.Open));
        assertEq(eligible, pool.totalWeight());
        assertEq(pool.lastClaimAt(), _now());
    }

    function test_the_dao_can_post_when_the_founder_cannot() public {
        _threeBackers();
        vm.warp(pool.nextClaimAt());
        vm.prank(treasury);
        assertEq(pool.postMilestone(REF), 1);
    }

    function test_a_pool_without_a_founder_takes_posts_from_the_dao_only() public {
        BackingPool daoOnly = new BackingPool(treasury, address(0), IERC20(address(quote)), defaultTerms());
        vm.warp(daoOnly.nextClaimAt());
        vm.prank(address(0));
        vm.expectRevert(BackingPool.NotClaimant.selector);
        daoOnly.postMilestone(REF);
        vm.prank(treasury);
        daoOnly.postMilestone(REF);
    }

    function test_the_first_post_waits_a_full_interval_after_opening() public {
        _threeBackers();
        uint256 notBefore = pool.nextClaimAt();
        vm.warp(notBefore - 1);
        vm.prank(FOUNDER);
        vm.expectRevert(abi.encodeWithSelector(BackingPool.TooSoon.selector, notBefore));
        pool.postMilestone(REF);
        vm.warp(notBefore);
        vm.prank(FOUNDER);
        pool.postMilestone(REF);
    }

    function test_a_post_needs_a_reference_and_no_other_post_open() public {
        _threeBackers();
        vm.warp(pool.nextClaimAt());
        vm.prank(FOUNDER);
        vm.expectRevert(BackingPool.ZeroAmount.selector);
        pool.postMilestone(bytes32(0));
        vm.prank(FOUNDER);
        pool.postMilestone(REF);
        // Even once the interval has passed again, an unresolved post blocks the next.
        _skip(28 days);
        vm.prank(FOUNDER);
        vm.expectRevert(BackingPool.MilestoneOpen.selector);
        pool.postMilestone(REF);
        pool.resolveMilestone();
        vm.prank(FOUNDER);
        assertEq(pool.postMilestone(keccak256("two")), 2);
    }

    function test_posts_are_at_least_an_interval_apart() public {
        _threeBackers();
        _post();
        _skip(7 days);
        pool.resolveMilestone();
        uint256 notBefore = pool.nextClaimAt();
        vm.prank(FOUNDER);
        vm.expectRevert(abi.encodeWithSelector(BackingPool.TooSoon.selector, notBefore));
        pool.postMilestone(REF);
    }

    // ---- release --------------------------------------------------------------------------------------------------

    function test_an_unopposed_milestone_releases_one_tranche_to_the_treasury() public {
        _threeBackers();
        uint256 escrow = pool.escrow();
        uint256 aliceBefore = pool.escrowOf(ALICE);
        _post();
        vm.expectRevert(BackingPool.WindowNotOver.selector);
        pool.resolveMilestone();
        _skip(7 days);

        vm.expectEmit(true, false, false, true, address(pool));
        emit MilestoneResolved(1, true, escrow / 4, 0, pool.totalWeight());
        // The treasury is sent the tranche and, with it, the fees the trades have paid so far.
        uint256 fees = pool.feesTaken();
        assertEq(pool.treasuryOwed(), fees);
        vm.expectEmit(false, false, false, true, address(pool));
        emit TreasuryPaid(escrow / 4 + fees);
        // Anyone resolves.
        vm.prank(MALLORY);
        (bool wasReleased, uint256 amount) = pool.resolveMilestone();

        assertTrue(wasReleased);
        assertEq(amount, escrow / 4);
        assertEq(quote.balanceOf(treasury), escrow / 4 + fees);
        assertEq(pool.escrow(), escrow - escrow / 4);
        assertEq(pool.released(), escrow / 4);
        assertEq(pool.treasuryOwed(), 0);
        assertEq(pool.lastReleaseAt(), _now());
        assertEq(uint8(_status(1)), uint8(BackingPool.MilestoneStatus.Released));
        // Everyone's part shrank by the same quarter.
        assertApproxEqAbs(pool.escrowOf(ALICE), aliceBefore * 3 / 4, 2);
        // The reserve was not touched: the curve pays exactly as before.
        _assertSolvent();
        vm.expectRevert(BackingPool.NoOpenMilestone.selector);
        pool.resolveMilestone();
    }

    function test_each_release_takes_a_quarter_of_what_is_left() public {
        _threeBackers();
        uint256 escrow = pool.escrow();
        for (uint256 i = 1; i <= 3; ++i) {
            _post();
            _skip(7 days);
            (, uint256 amount) = pool.resolveMilestone();
            assertEq(amount, escrow / 4);
            escrow -= amount;
        }
        assertEq(pool.escrow(), escrow);
        assertEq(pool.milestoneCount(), 3);
    }

    // ---- objections -----------------------------------------------------------------------------------------------

    function test_objections_at_the_threshold_keep_the_money_back() public {
        _threeBackers();
        uint256 escrow = pool.escrow();
        _post();
        // Bob holds about 30% of the weight: over the 20% threshold alone.
        vm.expectEmit(true, true, false, true, address(pool));
        emit Objected(1, BOB, pool.weightOf(BOB));
        vm.prank(BOB);
        pool.object();
        _skip(7 days);
        (bool wasReleased, uint256 amount) = pool.resolveMilestone();
        assertFalse(wasReleased);
        assertEq(amount, 0);
        assertEq(pool.escrow(), escrow);
        assertEq(pool.released(), 0);
        assertEq(quote.balanceOf(treasury), 0);
        assertEq(uint8(_status(1)), uint8(BackingPool.MilestoneStatus.Blocked));
        // A kept-back milestone does not restart the abandonment clock.
        assertEq(pool.lastReleaseAt(), pool.openedAt());
    }

    function test_objections_under_the_threshold_do_not_stop_a_release() public {
        _threeBackers();
        _post();
        // Carol holds about 10%.
        vm.prank(CAROL);
        pool.object();
        _skip(7 days);
        (bool wasReleased,) = pool.resolveMilestone();
        assertTrue(wasReleased);
    }

    function test_the_threshold_is_inclusive() public {
        // Two backers with exactly equal weight and a 50% threshold: one objecting is exactly at it.
        BackingPool.Params memory p = defaultTerms();
        p.objectionBps = 5000;
        p.feeBps = 0;
        p.earlyCap = 0;
        BackingPool even = new BackingPool(treasury, FOUNDER, IERC20(address(quote)), p);
        vm.prank(ALICE);
        quote.approve(address(even), type(uint256).max);
        vm.prank(BOB);
        quote.approve(address(even), type(uint256).max);
        vm.prank(ALICE);
        even.buy(1_000e18, 0, type(uint256).max);
        // Bob's project money has to buy the same weight: with no fee the weight price has not moved.
        vm.prank(BOB);
        even.buy(1_000e18, 0, type(uint256).max);
        assertEq(even.weightOf(ALICE), even.weightOf(BOB));
        vm.warp(even.nextClaimAt());
        vm.prank(FOUNDER);
        even.postMilestone(REF);
        vm.prank(BOB);
        even.object();
        _skip(7 days);
        (bool wasReleased,) = even.resolveMilestone();
        assertFalse(wasReleased);
    }

    function test_object_refuses_outside_a_window_without_weight_and_twice() public {
        _threeBackers();
        vm.prank(ALICE);
        vm.expectRevert(BackingPool.WindowOver.selector);
        pool.object();
        _post();
        vm.prank(MALLORY);
        vm.expectRevert(BackingPool.NoSay.selector);
        pool.object();
        vm.prank(ALICE);
        pool.object();
        vm.prank(ALICE);
        vm.expectRevert(BackingPool.AlreadyDone.selector);
        pool.object();
        _skip(7 days);
        vm.prank(BOB);
        vm.expectRevert(BackingPool.WindowOver.selector);
        pool.object();
    }

    function test_buying_during_a_window_gives_up_the_say_on_that_milestone() public {
        _threeBackers();
        _post();
        uint256 eligible = pool.totalWeight();
        uint256 bobWeight = pool.weightOf(BOB);
        vm.prank(BOB);
        pool.object();
        _buy(BOB, 10e18);
        // His objection and his weight are both out of this milestone's count.
        (,,,, uint256 nowEligible, uint256 objections,) = pool.milestones(1);
        assertEq(objections, 0);
        assertEq(nowEligible, eligible - bobWeight);
        assertEq(pool.boughtDuring(BOB), 1);
        vm.prank(BOB);
        vm.expectRevert(BackingPool.NoSay.selector);
        pool.object();
        // Buying again changes nothing more.
        _buy(BOB, 10e18);
        (,,,, uint256 again,,) = pool.milestones(1);
        assertEq(again, nowEligible);
        // On the next milestone he has his say back.
        _skip(7 days);
        pool.resolveMilestone();
        _post();
        vm.prank(BOB);
        pool.object();
    }

    function test_selling_takes_the_sold_part_of_an_objection_with_it() public {
        _threeBackers();
        _post();
        vm.prank(BOB);
        pool.object();
        uint256 eligible = pool.totalWeight();
        uint256 bobWeight = pool.weightOf(BOB);
        _sell(BOB, pool.balanceOf(BOB) / 2);
        uint256 sold = bobWeight - pool.weightOf(BOB);
        (,,,, uint256 nowEligible, uint256 objections,) = pool.milestones(1);
        assertEq(objections, bobWeight - sold);
        assertEq(nowEligible, eligible - sold);
        _sellAll(BOB);
        (,,,, nowEligible, objections,) = pool.milestones(1);
        assertEq(objections, 0);
        assertEq(nowEligible, eligible - bobWeight);
        _skip(7 days);
        (bool wasReleased,) = pool.resolveMilestone();
        assertTrue(wasReleased, "an objector who left no longer blocks");
    }

    function test_the_count_is_final_when_the_window_ends() public {
        _threeBackers();
        _post();
        vm.prank(BOB);
        pool.object();
        _skip(7 days);
        (,,,, uint256 eligible, uint256 objections,) = pool.milestones(1);
        // After the window, neither a sale nor a buy moves the count.
        _sellAll(BOB);
        _buy(ALICE, 500e18);
        (,,,, uint256 eligibleAfter, uint256 objectionsAfter,) = pool.milestones(1);
        assertEq(eligibleAfter, eligible);
        assertEq(objectionsAfter, objections);
        assertEq(pool.boughtDuring(ALICE), 0);
        (bool wasReleased,) = pool.resolveMilestone();
        assertFalse(wasReleased);
    }

    // ---- a token that refuses the treasury ------------------------------------------------------------------------

    function test_a_token_that_refuses_the_treasury_never_blocks_a_milestone() public {
        BlockingQuote token = new BlockingQuote();
        BackingPool blockPool = new BackingPool(treasury, FOUNDER, IERC20(address(token)), defaultTerms());
        token.mint(ALICE, 10_000e18);
        vm.startPrank(ALICE);
        token.approve(address(blockPool), type(uint256).max);
        uint256 units = blockPool.buy(1_000e18, 0, type(uint256).max);
        vm.stopPrank();
        uint256 fees = blockPool.feesTaken();
        assertEq(blockPool.treasuryOwed(), fees);

        token.setBlocked(treasury);
        vm.warp(blockPool.nextClaimAt());
        vm.prank(FOUNDER);
        blockPool.postMilestone(REF);
        _skip(7 days);
        (bool wasReleased, uint256 amount) = blockPool.resolveMilestone();
        assertTrue(wasReleased);
        assertEq(blockPool.treasuryOwed(), amount + fees);
        assertEq(blockPool.released(), amount);
        assertEq(token.balanceOf(treasury), 0);
        assertEq(token.balanceOf(address(blockPool)), blockPool.reserve() + blockPool.escrow() + amount + fees);
        // Still refused: the retry says so and the money keeps waiting.
        vm.expectRevert(BackingPool.BadQuoteTransfer.selector);
        blockPool.payTreasury();
        // Backers are not held up by it.
        vm.prank(ALICE);
        blockPool.sell(units / 2, 0, type(uint256).max);

        token.setBlocked(address(0));
        uint256 owed = blockPool.treasuryOwed();
        assertEq(owed, amount + blockPool.feesTaken());
        vm.expectEmit(false, false, false, true, address(blockPool));
        emit TreasuryPaid(owed);
        blockPool.payTreasury();
        assertEq(blockPool.treasuryOwed(), 0);
        assertEq(token.balanceOf(treasury), owed);
        assertEq(token.balanceOf(address(blockPool)), blockPool.reserve() + blockPool.escrow());
        vm.expectRevert(BackingPool.NothingOwed.selector);
        blockPool.payTreasury();
    }

    // ---- abandonment by the clock ---------------------------------------------------------------------------------

    function test_no_release_for_the_set_time_lets_anyone_declare_abandonment() public {
        _threeBackers();
        vm.warp(pool.abandonableAt() - 1);
        vm.expectRevert(BackingPool.NotAbandonable.selector);
        pool.declareAbandoned();
        vm.warp(pool.abandonableAt());
        uint256 escrow = pool.escrow();
        vm.expectEmit(true, false, false, true, address(pool));
        emit Abandoned(MALLORY, false, escrow, 0);
        vm.prank(MALLORY);
        pool.declareAbandoned();
        assertTrue(pool.abandoned());
        assertTrue(pool.snapshot(ALICE).abandoned);
    }

    function test_after_abandonment_buying_and_milestones_stop_for_good() public {
        _threeBackers();
        vm.warp(pool.abandonableAt());
        pool.declareAbandoned();
        vm.prank(ALICE);
        vm.expectRevert(BackingPool.IsAbandoned.selector);
        pool.buy(1e18, 0, type(uint256).max);
        vm.prank(FOUNDER);
        vm.expectRevert(BackingPool.IsAbandoned.selector);
        pool.postMilestone(REF);
        vm.expectRevert(BackingPool.IsAbandoned.selector);
        pool.resolveMilestone();
        vm.prank(ALICE);
        vm.expectRevert(BackingPool.IsAbandoned.selector);
        pool.voteAbandon();
        vm.expectRevert(BackingPool.IsAbandoned.selector);
        pool.declareAbandoned();
    }

    function test_after_abandonment_every_backer_gets_their_part_of_the_escrow_in_any_order() public {
        _threeBackers();
        // One tranche went to the project first.
        _post();
        _skip(7 days);
        pool.resolveMilestone();
        vm.warp(pool.abandonableAt());
        pool.declareAbandoned();

        uint256 escrow = pool.escrow();
        uint256 aliceShare = pool.escrowOf(ALICE);
        uint256 bobShare = pool.escrowOf(BOB);
        uint256 carolShare = pool.escrowOf(CAROL);
        assertApproxEqAbs(aliceShare + bobShare + carolShare, escrow, 3);
        // 60 / 30 / 10, as they paid in.
        assertApproxEqRel(aliceShare, escrow * 60 / 100, 0.01e18);

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

    function test_a_milestone_inside_its_window_is_heard_before_the_clock_decides() public {
        _threeBackers();
        vm.warp(pool.abandonableAt() - 1 days);
        vm.prank(FOUNDER);
        pool.postMilestone(REF);
        vm.warp(pool.abandonableAt());
        vm.expectRevert(BackingPool.MilestoneOpen.selector);
        pool.declareAbandoned();
        // The window is over and nobody objected: it has to be released, not overridden.
        _skip(7 days);
        vm.expectRevert(BackingPool.MilestoneOpen.selector);
        pool.declareAbandoned();
        pool.resolveMilestone();
        vm.expectRevert(BackingPool.NotAbandonable.selector);
        pool.declareAbandoned();
    }

    function test_a_kept_back_milestone_does_not_save_the_project_from_the_clock() public {
        _threeBackers();
        vm.warp(pool.abandonableAt() - 1 days);
        vm.prank(FOUNDER);
        pool.postMilestone(REF);
        vm.prank(ALICE);
        pool.object();
        _skip(7 days);
        // Not resolved by anyone yet: declaring settles it as kept back and goes on.
        pool.declareAbandoned();
        assertTrue(pool.abandoned());
        assertEq(uint8(_status(1)), uint8(BackingPool.MilestoneStatus.Blocked));
    }

    function test_escrow_nobody_has_a_weight_for_goes_to_the_treasury_on_abandonment() public {
        _threeBackers();
        _sellAll(ALICE);
        _sellAll(BOB);
        _sellAll(CAROL);
        uint256 left = pool.escrow();
        assertGt(left, 0);
        assertEq(pool.totalWeight(), 0);
        vm.warp(pool.abandonableAt());
        vm.expectEmit(true, false, false, true, address(pool));
        emit Abandoned(address(this), false, 0, left);
        pool.declareAbandoned();
        assertEq(pool.escrow(), 0);
        assertEq(pool.released(), left);
        assertEq(quote.balanceOf(treasury), left + pool.feesTaken());
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
        emit Abandoned(address(this), true, escrow, 0);
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
        _post();
        _skip(7 days);
        pool.resolveMilestone();
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

    function test_selling_shrinks_a_vote() public {
        _threeBackers();
        _skip(30 days);
        vm.prank(ALICE);
        pool.voteAbandon();
        _sell(ALICE, pool.balanceOf(ALICE) / 2);
        assertEq(pool.abandonVotes(), pool.weightOf(ALICE));
        _sellAll(ALICE);
        assertEq(pool.abandonVotes(), 0);
        assertEq(pool.weightOf(ALICE), 0);
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
        assertEq(pool.escrow(), escrow);
        assertEq(quote.balanceOf(treasury), 0);
    }
}
