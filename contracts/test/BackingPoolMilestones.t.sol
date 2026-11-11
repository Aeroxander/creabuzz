// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BackingPool} from "../src/BackingPool.sol";
import {BackingPoolFixture, BlockingQuote} from "./helpers/BackingPoolFixture.sol";

/// @notice The project money: milestone posts, staying or leaving, and releases. Abandonment and its refunds
/// are in BackingPoolAbandonment.t.sol.
contract BackingPoolMilestonesTest is BackingPoolFixture {
    event MilestonePosted(
        uint256 indexed id,
        bytes32 indexed ref,
        address indexed by,
        uint64 windowEndsAt,
        uint64 resolveBy,
        uint256 escrowAtPost,
        uint256 tranche
    );
    event Left(
        uint256 indexed id,
        address indexed backer,
        uint256 unitsIn,
        uint256 quoteOut,
        uint256 fromCurve,
        uint256 fromEscrow,
        uint256 priceAfter,
        uint256 supplyAfter,
        uint256 reserveAfter
    );
    event MilestoneResolved(uint256 indexed id, bool wasReleased, uint256 amount);
    event TreasuryPaid(uint256 amount);

    /// @dev Three backers past the early window: Alice 60%, Bob 30%, Carol 10% of the project money.
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

        uint256 escrow = pool.escrow();
        vm.expectEmit(true, true, true, true, address(pool));
        emit MilestonePosted(1, REF, FOUNDER, uint64(_now() + 7 days), uint64(_now() + 14 days), escrow, escrow / 4);
        vm.prank(FOUNDER);
        assertEq(pool.postMilestone(REF), 1);
        (
            bytes32 ref,
            uint64 postedAt,
            uint64 endsAt,
            uint64 resolveBy,
            BackingPool.MilestoneStatus status,
            uint256 escrowAtPost,
            uint256 leftWith,
            uint256 released
        ) = pool.milestones(1);
        assertEq(ref, REF);
        assertEq(postedAt, _now());
        assertEq(endsAt, _now() + 7 days);
        assertEq(resolveBy, _now() + 14 days);
        assertEq(uint8(status), uint8(BackingPool.MilestoneStatus.Open));
        assertEq(escrowAtPost, escrow);
        assertEq(leftWith, 0);
        assertEq(released, 0);
        assertEq(pool.pending(), escrow / 4);
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
        _release();
        uint256 notBefore = pool.nextClaimAt();
        vm.prank(FOUNDER);
        vm.expectRevert(abi.encodeWithSelector(BackingPool.TooSoon.selector, notBefore));
        pool.postMilestone(REF);
    }

    // ---- release --------------------------------------------------------------------------------------------------

    function test_when_everyone_stays_one_tranche_goes_to_the_treasury() public {
        _threeBackers();
        uint256 escrow = pool.escrow();
        _post();
        uint256 aliceBefore = pool.escrowOf(ALICE);
        vm.expectRevert(BackingPool.WindowNotOver.selector);
        pool.resolveMilestone();
        _skip(7 days);

        // The treasury is sent the tranche and, with it, the fees the trades have paid so far.
        uint256 fees = pool.feesTaken();
        assertEq(pool.treasuryOwed(), fees);
        vm.expectEmit(true, false, false, true, address(pool));
        emit MilestoneResolved(1, true, escrow / 4);
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
        assertEq(pool.pending(), 0);
        assertEq(pool.staked(), 0);
        assertEq(pool.treasuryOwed(), 0);
        assertEq(pool.lastReleaseAt(), _now());
        assertEq(uint8(_status(1)), uint8(BackingPool.MilestoneStatus.Released));
        (,,,,,,, uint256 released) = pool.milestones(1);
        assertEq(released, amount);
        // Everyone's part shrank by the same quarter.
        assertApproxEqAbs(pool.escrowOf(ALICE), aliceBefore * 3 / 4, 2);
        _assertSolvent();
        vm.expectRevert(BackingPool.NoOpenMilestone.selector);
        pool.resolveMilestone();
    }

    function test_each_release_takes_a_quarter_of_what_is_there_when_it_is_posted() public {
        _threeBackers();
        uint256 escrow = pool.escrow();
        for (uint256 i = 1; i <= 3; ++i) {
            uint256 amount = _release();
            assertEq(amount, escrow / 4);
            escrow -= amount;
        }
        assertEq(pool.escrow(), escrow);
        assertEq(pool.milestoneCount(), 3);
    }

    /// @dev Finding F1: the tranche is what was held at the post. Money that arrives afterwards, during the
    /// window or while the milestone waits to be resolved, is not taken and not shrunk.
    function test_money_that_arrives_after_the_post_is_not_touched_by_that_milestone() public {
        _pastEarly();
        _buy(ALICE, 100_000e18);
        _post();
        uint256 atPost = pool.escrow();
        _skip(7 days - 1);
        _buy(BOB, 100_000e18);
        uint256 bobBefore = pool.escrowOf(BOB);
        _skip(1);
        // The window is over; the milestone sits unresolved while a larger buyer arrives.
        _skip(5 days);
        _buy(CAROL, 300_000e18);
        uint256 carolBefore = pool.escrowOf(CAROL);
        uint256 escrowBefore = pool.escrow();

        (, uint256 amount) = pool.resolveMilestone();
        assertEq(amount, atPost / 4, "a quarter of what was there at the post, whatever came later");
        assertEq(pool.escrow(), escrowBefore - atPost / 4);
        assertApproxEqAbs(pool.escrowOf(BOB), bobBefore, 2, "Bob bought in the window: untouched");
        assertApproxEqAbs(pool.escrowOf(CAROL), carolBefore, 2, "Carol bought after it: untouched");
        // Each is owed the project part of what they paid, whole.
        assertApproxEqAbs(bobBefore, 100_000e18 * 99 / 100 / 10, 2);
        assertApproxEqAbs(carolBefore, 300_000e18 * 99 / 100 / 10, 2);
        // Alice, who held at the post and stayed, carried the whole tranche.
        assertApproxEqAbs(pool.escrowOf(ALICE), atPost - atPost / 4, 2);
        _assertSolvent();
    }

    /// @dev Finding F1: a milestone nobody resolves in time can only be voided, by anyone.
    function test_a_milestone_left_unresolved_past_its_deadline_is_voided() public {
        _threeBackers();
        uint256 escrow = pool.escrow();
        uint256 clock = pool.lastReleaseAt();
        _post();
        _skip(14 days - 1);
        uint256 state = vm.snapshotState();
        // One second before the deadline it still releases.
        (bool wasReleased, uint256 amount) = pool.resolveMilestone();
        assertTrue(wasReleased);
        assertEq(amount, escrow / 4);
        vm.revertToState(state);

        _skip(1);
        vm.expectEmit(true, false, false, true, address(pool));
        emit MilestoneResolved(1, false, 0);
        vm.prank(MALLORY);
        (wasReleased, amount) = pool.resolveMilestone();
        assertFalse(wasReleased);
        assertEq(amount, 0);
        assertEq(uint8(_status(1)), uint8(BackingPool.MilestoneStatus.Void));
        assertEq(pool.escrow(), escrow);
        assertEq(pool.pending(), 0);
        assertEq(pool.released(), 0);
        assertEq(pool.lastReleaseAt(), clock, "a voided milestone does not restart the clock");
        // The project can post again once the interval allows.
        vm.warp(pool.nextClaimAt());
        vm.prank(FOUNDER);
        assertEq(pool.postMilestone(REF), 2);
    }

    // ---- leaving --------------------------------------------------------------------------------------------------

    function test_a_backer_who_leaves_gets_the_curve_with_no_fee_and_their_whole_escrow_part() public {
        _threeBackers();
        uint256 bobEscrow = pool.escrowOf(BOB);
        assertApproxEqAbs(bobEscrow, 297e18, 2);
        uint256 units = pool.balanceOf(BOB);
        _post();
        assertApproxEqAbs(pool.escrowOf(BOB), bobEscrow, 1, "the post has not taken anything from him yet");
        bobEscrow = pool.escrowOf(BOB);
        assertTrue(pool.canLeave(BOB));
        (uint256 quotedOut, uint256 fromCurve, uint256 fromEscrow, uint256 priceAfter) = pool.quoteLeave(BOB);
        (uint256 sellOut, uint256 sellFee,,) = pool.quoteSell(BOB, units);
        assertEq(fromCurve, sellOut + sellFee, "the curve, with no fee");
        assertEq(fromEscrow, bobEscrow);
        assertEq(quotedOut, fromCurve + fromEscrow);

        uint256 fees = pool.feesTaken();
        uint256 reserve = pool.reserve();
        uint256 supply = pool.totalSupply();
        uint256 before = quote.balanceOf(BOB);
        vm.expectEmit(true, true, false, true, address(pool));
        emit Left(1, BOB, units, quotedOut, fromCurve, fromEscrow, priceAfter, supply - units, reserve - fromCurve);
        vm.prank(BOB);
        uint256 out = pool.leave(quotedOut, _now());

        assertEq(out, quotedOut);
        assertEq(quote.balanceOf(BOB) - before, out);
        assertEq(pool.balanceOf(BOB), 0);
        assertEq(pool.weightOf(BOB), 0);
        assertEq(pool.feesTaken(), fees, "no fee");
        assertEq(pool.refunded(), fromEscrow);
        assertEq(pool.price(), priceAfter);
        (,,,,,, uint256 leftWith,) = pool.milestones(1);
        assertEq(leftWith, fromEscrow);
        assertFalse(pool.canLeave(BOB));
        _assertSolvent();
    }

    /// @dev The heart of the exit model: a leaver is not charged the tranche, and those who stay are charged
    /// exactly their own quarter, not the leaver's.
    function test_the_tranche_comes_from_those_who_stayed_only() public {
        _threeBackers();
        uint256 escrow = pool.escrow();
        uint256 aliceBefore = pool.escrowOf(ALICE);
        uint256 carolBefore = pool.escrowOf(CAROL);
        _post();
        uint256 bobEscrow = pool.escrowOf(BOB);
        _leave(BOB);
        assertApproxEqAbs(pool.pending(), (escrow - bobEscrow) / 4, 2);
        _skip(7 days);
        (bool wasReleased, uint256 amount) = pool.resolveMilestone();
        assertTrue(wasReleased);
        assertApproxEqAbs(amount, (escrow - bobEscrow) / 4, 2, "a quarter of the escrow of those who stayed");
        assertApproxEqAbs(pool.escrowOf(ALICE), aliceBefore * 3 / 4, 3);
        assertApproxEqAbs(pool.escrowOf(CAROL), carolBefore * 3 / 4, 3);
        assertEq(pool.escrow(), escrow - bobEscrow - amount);
        _assertSolvent();
    }

    function test_leaving_is_only_for_a_running_window_and_a_wallet_with_units() public {
        _threeBackers();
        vm.prank(ALICE);
        vm.expectRevert(BackingPool.WindowOver.selector);
        pool.leave(0, type(uint256).max);
        assertFalse(pool.canLeave(ALICE));
        (uint256 q,,,) = pool.quoteLeave(ALICE);
        assertEq(q, 0);

        _post();
        vm.prank(MALLORY);
        vm.expectRevert(BackingPool.NoSay.selector);
        pool.leave(0, type(uint256).max);
        vm.prank(ALICE);
        vm.expectRevert(BackingPool.Expired.selector);
        pool.leave(0, _now() - 1);
        (q,,,) = pool.quoteLeave(ALICE);
        vm.prank(ALICE);
        vm.expectRevert(BackingPool.Slippage.selector);
        pool.leave(q + 1, type(uint256).max);

        // The last second of the window still works; the window's end does not.
        _skip(7 days - 1);
        assertTrue(pool.canLeave(ALICE));
        _skip(1);
        assertFalse(pool.canLeave(ALICE));
        vm.prank(ALICE);
        vm.expectRevert(BackingPool.WindowOver.selector);
        pool.leave(0, type(uint256).max);
    }

    function test_a_wallet_that_buys_during_the_window_cannot_leave_on_that_milestone() public {
        _threeBackers();
        _post();
        _buy(BOB, 10e18);
        assertEq(pool.boughtDuring(BOB), 1);
        assertFalse(pool.canLeave(BOB));
        assertFalse(pool.snapshot(BOB).holderCanLeave);
        vm.prank(BOB);
        vm.expectRevert(BackingPool.NoSay.selector);
        pool.leave(0, type(uint256).max);
        // A newcomer in the window cannot either.
        _buy(MALLORY, 500e18);
        vm.prank(MALLORY);
        vm.expectRevert(BackingPool.NoSay.selector);
        pool.leave(0, type(uint256).max);
        // On the next milestone both can.
        _skip(7 days);
        pool.resolveMilestone();
        _post();
        assertTrue(pool.canLeave(BOB));
        assertTrue(pool.canLeave(MALLORY));
        _leave(BOB);
        _leave(MALLORY);
    }

    function test_leaving_and_buying_back_gives_no_second_exit() public {
        _threeBackers();
        _post();
        _leave(BOB);
        _buy(BOB, 3_000e18);
        vm.prank(BOB);
        vm.expectRevert(BackingPool.NoSay.selector);
        pool.leave(0, type(uint256).max);
        // What he bought back is priced with the tranche already off, so the release does not shrink it.
        uint256 bobEscrow = pool.escrowOf(BOB);
        assertApproxEqAbs(bobEscrow, 297e18, 2);
        _skip(7 days);
        pool.resolveMilestone();
        assertApproxEqAbs(pool.escrowOf(BOB), bobEscrow, 2);
    }

    function test_a_backer_who_sold_part_leaves_with_the_rest() public {
        _threeBackers();
        _post();
        uint256 units = pool.balanceOf(BOB);
        _sell(BOB, units / 2);
        // Half his part stayed behind for everyone still holding, himself included.
        uint256 rest = pool.escrowOf(BOB);
        assertGt(rest, 297e18 / 2);
        assertLt(rest, 297e18 * 6 / 10);
        uint256 refunded = pool.refunded();
        _leave(BOB);
        assertEq(pool.refunded() - refunded, rest);
        // What he gave up with the ordinary sale stays, and its part of the tranche is still released.
        _skip(7 days);
        (, uint256 amount) = pool.resolveMilestone();
        assertGt(amount, (pool.escrow() + amount) / 4 - 1e6);
        _assertSolvent();
    }

    function test_when_everyone_leaves_the_milestone_releases_nothing_and_nothing_is_stuck() public {
        _threeBackers();
        _post();
        _leave(ALICE);
        _leave(BOB);
        _leave(CAROL);
        assertEq(pool.totalSupply(), 0);
        assertEq(pool.totalWeight(), 0);
        assertLe(pool.escrow(), 3, "only rounding is left");
        _skip(7 days);
        (bool wasReleased, uint256 amount) = pool.resolveMilestone();
        assertTrue(wasReleased);
        assertLe(amount, 3);
        assertEq(uint8(_status(1)), uint8(BackingPool.MilestoneStatus.Released));
        assertEq(pool.pending(), 0);
        if (amount == 0) assertLt(pool.lastReleaseAt(), _now(), "nothing paid: the clock is not restarted");
        _assertSolvent();
        // The pool goes on: the clock starts again with the next money in, and the next milestone releases a
        // quarter of it.
        vm.warp(pool.nextClaimAt());
        bool empty = pool.escrow() == 0;
        _buy(ALICE, 1_000e18);
        if (empty) assertEq(pool.lastReleaseAt(), _now());
        uint256 escrow = pool.escrow();
        assertEq(_release(), escrow / 4);
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
}
