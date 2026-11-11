// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BackingPool} from "../src/BackingPool.sol";
import {BackingPoolFixture} from "./helpers/BackingPoolFixture.sol";

/// @notice The attacks a pool like this invites, each run as its attacker would run it. A1 to A5 are the five
/// named in docs/v3-review/BACKING-POOL.md. The tests marked "review" are the proofs of concept of the
/// independent review of 2026-11-11 (findings F1 to F3 and its lower ones), kept as regressions: each
/// asserts the opposite of what the proof showed. Tests named `limit` record what is not prevented.
contract BackingPoolAdversaryTest is BackingPoolFixture {
    function setUp() public override {
        super.setUp();
        _fund(FOUNDER);
        _pastEarly();
    }

    /// @dev What `who` is out of pocket since `startBalance` (negative when ahead).
    function _spent(address who, uint256 startBalance) internal view returns (int256) {
        return int256(startBalance) - int256(quote.balanceOf(who));
    }

    // ---- A1: sandwiching a trade -----------------------------------------------------------------------------------

    /// @dev Mallory sees Alice's buy, buys first, lets Alice push the price up, and sells into it. Every buy
    /// leaves its project part and two fees behind (a round trip returns about 88%), so the sandwich only
    /// pays if Alice's buy alone moves the curve price by more than about 13%. An ordinary buy does not.
    function test_A1_sandwiching_an_ordinary_buy_loses_money() public {
        _buy(BOB, 20_000e18);
        uint256 start = quote.balanceOf(MALLORY);
        uint256 units = _buy(MALLORY, 50_000e18);
        _buy(ALICE, 5_000e18);
        _sell(MALLORY, units);
        assertGt(_spent(MALLORY, start), 0, "the sandwich cost her money");
    }

    function testFuzz_A1_no_sandwich_pays_unless_the_victim_moves_the_price_by_an_eighth(
        uint256 depth,
        uint256 front,
        uint256 victim
    ) public {
        depth = bound(depth, 1e15, 3_000_000e18);
        front = bound(front, 1e15, 3_000_000e18);
        _buy(BOB, depth);
        uint256 start = quote.balanceOf(MALLORY);
        uint256 units = _buy(MALLORY, front);
        // The victim adds at most 6% to the curve's quote side: a price move of at most 12.4%.
        uint256 x = pool.virtualQuote() + pool.reserve();
        victim = bound(victim, 1e15, x * 6 / 100);
        _buy(ALICE, victim);
        _sell(MALLORY, units);
        assertGt(_spent(MALLORY, start), 0);
    }

    /// @dev The limit, recorded and not prevented: a buy large enough to move the price by more than that,
    /// sent with no price limit, can be sandwiched at a profit, as on any curve.
    function test_A1_limit_a_large_buy_with_no_price_limit_can_be_sandwiched() public {
        _buy(BOB, 20_000e18);
        uint256 start = quote.balanceOf(MALLORY);
        uint256 units = _buy(MALLORY, 50_000e18);
        _buy(ALICE, 500_000e18);
        _sell(MALLORY, units);
        assertLt(_spent(MALLORY, start), 0, "she came out ahead");
    }

    /// @dev What stops it is the victim's own limit: taken from a quote, it refuses the worse price, and
    /// the attacker is left with a losing round trip.
    function test_A1_a_slippage_limit_refuses_a_front_run_buy() public {
        _buy(BOB, 20_000e18);
        (uint256 expected,,,) = pool.quoteBuy(500_000e18);
        uint256 start = quote.balanceOf(MALLORY);
        uint256 units = _buy(MALLORY, 50_000e18);
        vm.prank(ALICE);
        vm.expectRevert(BackingPool.Slippage.selector);
        pool.buy(500_000e18, expected * 99 / 100, type(uint256).max);
        _sell(MALLORY, units);
        assertGt(_spent(MALLORY, start), 0);
    }

    /// @dev A deadline keeps a held-back buy from being run later at a price the buyer never saw.
    function test_A1_a_deadline_refuses_a_buy_held_back() public {
        uint256 deadline = _now() + 5 minutes;
        _skip(5 minutes + 1);
        vm.prank(ALICE);
        vm.expectRevert(BackingPool.Expired.selector);
        pool.buy(1_000e18, 0, deadline);
    }

    /// @dev The other side: Mallory sells before Alice's sale and buys back cheaper. Buying back pays the
    /// project part and the fees again, so she ends with fewer units than she started with.
    function test_A1_sandwiching_an_ordinary_sale_loses_units() public {
        _buy(BOB, 200_000e18);
        uint256 mallory = _buy(MALLORY, 50_000e18);
        uint256 alice = _buy(ALICE, 5_000e18);
        uint256 got = _sell(MALLORY, mallory);
        _sell(ALICE, alice);
        uint256 back = _buy(MALLORY, got);
        assertLt(back, mallory);
    }

    // ---- A2: taking money that is not yours out of the escrow ------------------------------------------------------

    /// @dev The project is dying: backers have sold and left their project money behind, and the abandonment
    /// clock is about to run out. Mallory buys in at the last second to take a part of that money when it is
    /// refunded. Her weight is priced at what she adds, so she takes none of it.
    function test_A2_buying_just_before_abandonment_takes_nothing_from_those_who_stayed() public {
        _buy(ALICE, 50_000e18);
        uint256 bob = _buy(BOB, 200_000e18);
        _buy(CAROL, 50_000e18);
        // Bob leaves his project money for Alice and Carol.
        _sell(BOB, bob);
        vm.warp(pool.abandonableAt() - 1);
        uint256 aliceDue = pool.escrowOf(ALICE);
        uint256 carolDue = pool.escrowOf(CAROL);

        uint256 start = quote.balanceOf(MALLORY);
        uint256 units = _buy(MALLORY, 300_000e18);
        _skip(1);
        _sell(MALLORY, units);

        assertGe(_spent(MALLORY, start), 3_000e18, "she is out her fee, and gained nothing");
        assertGe(pool.escrowOf(ALICE) + 1, aliceDue);
        assertGe(pool.escrowOf(CAROL) + 1, carolDue);
    }

    function testFuzz_A2_a_late_buyer_never_profits_from_abandonment(uint256 stayed, uint256 left, uint256 late)
        public
    {
        stayed = bound(stayed, 1e15, 2_000_000e18);
        left = bound(left, 1e15, 2_000_000e18);
        late = bound(late, 1e15, 2_000_000e18);
        _buy(ALICE, stayed);
        uint256 bob = _buy(BOB, left);
        _sell(BOB, bob);
        vm.warp(pool.abandonableAt() - 1);
        uint256 aliceDue = pool.escrowOf(ALICE);
        uint256 start = quote.balanceOf(MALLORY);
        uint256 units = _buy(MALLORY, late);
        _skip(1);
        _sell(MALLORY, units);
        assertGe(_spent(MALLORY, start), 0);
        assertGe(pool.escrowOf(ALICE) + 1, aliceDue);
    }

    /// @dev Review, finding F3 (its proof P1): every backer sold, the escrow has no owner, and a dust buyer
    /// arrives to collect it at abandonment. She gets her own dust back; the ownerless money goes to the
    /// treasury. And she can no longer veto anything meanwhile: the project still gets its tranche.
    function test_review_F3_a_dust_buyer_cannot_take_the_ownerless_escrow() public {
        _buy(ALICE, 100_000e18);
        _sellAll(ALICE);
        uint256 orphan = pool.escrow();
        assertGt(orphan, 9_000e18);
        assertEq(pool.totalWeight(), 0);
        uint256 start = quote.balanceOf(MALLORY);
        _buy(MALLORY, 1e18);
        assertLe(pool.escrowOf(MALLORY), 0.099e18, "her own project money at most");

        // The founder collects a tranche of the money nobody holds; she cannot stop it.
        uint256 amount = _release();
        assertApproxEqAbs(amount, (orphan + 0.099e18) / 4, 2);

        vm.warp(pool.abandonableAt());
        _sellAll(MALLORY);
        assertGt(_spent(MALLORY, start), 0, "no profit");
        assertLe(pool.refunded(), 0.099e18);
        // Everything else the escrow held is the treasury's.
        assertEq(pool.escrow(), 0);
        assertApproxEqAbs(pool.released(), orphan + 0.099e18 - pool.refunded(), 2);
        _assertSolvent();
    }

    /// @dev The same dust buyer trying the new way out: leaving at a milestone hands her her own part, not
    /// the ownerless money.
    function test_review_F3_a_dust_buyer_cannot_leave_with_the_ownerless_escrow() public {
        _buy(ALICE, 100_000e18);
        _sellAll(ALICE);
        uint256 orphan = pool.escrow();
        uint256 start = quote.balanceOf(MALLORY);
        _buy(MALLORY, 1e18);
        _post();
        (,, uint256 fromEscrow,) = pool.quoteLeave(MALLORY);
        assertLe(fromEscrow, 0.099e18);
        _leave(MALLORY);
        assertGt(_spent(MALLORY, start), 0);
        assertGe(pool.escrow(), orphan);
        // The project still gets its quarter of it.
        _skip(7 days);
        (, uint256 amount) = pool.resolveMilestone();
        // (to within what one unit of her weight is worth against so large a pot)
        assertApproxEqAbs(amount, orphan / 4, 1e11);
    }

    /// @dev Making the escrow huge next to the weights, so a victim's weight rounds to nothing, would take
    /// leaving a trillion times the victim's money behind. A thousand times does nothing.
    function test_A2_a_huge_ownerless_pot_does_not_round_a_backers_weight_away() public {
        uint256 mallory = _buy(MALLORY, 3_000_000e18);
        _sell(MALLORY, mallory);
        (,, uint256 toEscrow,) = pool.quoteBuy(1_000e18);
        _buy(ALICE, 1_000e18);
        assertApproxEqRel(pool.escrowOf(ALICE), toEscrow, 1e12);
    }

    // ---- A3: abusing the way out at a milestone --------------------------------------------------------------------

    /// @dev Buy after the post and leave at once, to sell without the fee or to take a part of the tranche:
    /// a wallet that bought during the window cannot leave on that milestone.
    function test_A3_buying_in_the_window_gives_no_way_out() public {
        _buy(ALICE, 100_000e18);
        _post();
        _buy(MALLORY, 500_000e18);
        vm.prank(MALLORY);
        vm.expectRevert(BackingPool.NoSay.selector);
        pool.leave(0, type(uint256).max);
    }

    /// @dev Leave, buy back, leave again: each exit would skip a fee and the second would take the tranche
    /// part twice. The buy back closes the door until the next milestone.
    function test_A3_leaving_twice_on_one_milestone_is_refused() public {
        _buy(ALICE, 100_000e18);
        _buy(MALLORY, 100_000e18);
        _post();
        uint256 out = _leave(MALLORY);
        _buy(MALLORY, out);
        vm.prank(MALLORY);
        vm.expectRevert(BackingPool.NoSay.selector);
        pool.leave(0, type(uint256).max);
        // And having left, with nothing bought back, there is nothing to leave with.
        _leave(ALICE);
        vm.prank(ALICE);
        vm.expectRevert(BackingPool.NoSay.selector);
        pool.leave(0, type(uint256).max);
    }

    /// @dev A leaver takes their own part and no more, however the others move: the sum handed back to all
    /// who leave is never more than was held, and what is released is never more than the tranche.
    function testFuzz_A3_leavers_never_take_more_than_their_own(uint256 a, uint256 b, uint256 c, uint8 who) public {
        a = bound(a, 1e15, 2_000_000e18);
        b = bound(b, 1e15, 2_000_000e18);
        c = bound(c, 1e15, 2_000_000e18);
        _buy(ALICE, a);
        _buy(BOB, b);
        _buy(CAROL, c);
        uint256 escrow = pool.escrow();
        uint256[3] memory due = [pool.escrowOf(ALICE), pool.escrowOf(BOB), pool.escrowOf(CAROL)];
        address[3] memory backers = [ALICE, BOB, CAROL];
        _post();
        uint256 took;
        uint256 stayed;
        for (uint256 i; i < 3; ++i) {
            if (who & (1 << i) != 0) {
                uint256 refunded = pool.refunded();
                _leave(backers[i]);
                assertApproxEqAbs(pool.refunded() - refunded, due[i], 2);
                took += pool.refunded() - refunded;
            } else {
                stayed += due[i];
            }
        }
        _skip(7 days);
        (, uint256 amount) = pool.resolveMilestone();
        assertLe(amount, escrow / 4);
        assertApproxEqAbs(amount, stayed / 4, 4);
        assertEq(pool.escrow(), escrow - took - amount);
        _assertSolvent();
    }

    /// @dev Review, finding F1 (its proof P2): the founder leaves a matured milestone unresolved until a
    /// large buyer arrives, then resolves it to take a quarter of the newcomer's money too. The tranche was
    /// fixed at the post; the newcomers lose nothing.
    function test_review_F1_money_that_came_after_the_post_is_not_taken() public {
        _buy(ALICE, 100_000e18);
        _post();
        uint256 atPost = pool.escrow();
        _skip(7 days - 1);
        _buy(BOB, 100_000e18);
        uint256 bobBefore = pool.escrowOf(BOB);
        _skip(1 + 6 days);
        _buy(CAROL, 100_000e18);
        uint256 carolBefore = pool.escrowOf(CAROL);
        (, uint256 amount) = pool.resolveMilestone();
        assertEq(amount, atPost / 4, "a quarter of what was at stake when it was posted");
        assertLt(amount, 2_500e18);
        assertApproxEqAbs(pool.escrowOf(BOB), bobBefore, 2);
        assertApproxEqAbs(pool.escrowOf(CAROL), carolBefore, 2);
    }

    /// @dev And he cannot wait for ever: past the deadline the milestone can only be voided.
    function test_review_F1_a_milestone_held_back_past_its_deadline_releases_nothing() public {
        _buy(ALICE, 100_000e18);
        _post();
        _skip(14 days);
        _buy(CAROL, 100_000e18);
        uint256 escrow = pool.escrow();
        vm.prank(FOUNDER);
        (bool wasReleased, uint256 amount) = pool.resolveMilestone();
        assertFalse(wasReleased);
        assertEq(amount, 0);
        assertEq(pool.escrow(), escrow);
    }

    // ---- A4: stopping a project's money, or killing its pool ------------------------------------------------------

    /// @dev Review, finding F2 (its proofs P3 and P3b): a fifth of the weight used to keep every tranche
    /// back for nothing, run the clock out and walk away whole. Nobody can keep a tranche back now: a
    /// backer who rejects a milestone takes their own money out, and the project gets the tranche of
    /// everyone who stayed.
    function test_review_F2_nobody_can_block_a_release() public {
        _buy(ALICE, 80_000e18);
        _buy(MALLORY, 21_000e18);
        uint256 aliceDue = pool.escrowOf(ALICE);
        (bool ok,) = address(pool).call(abi.encodeWithSignature("object()"));
        assertFalse(ok, "there is no objecting");
        for (uint256 i; i < 6; ++i) {
            _post();
            // All she can do is leave, once.
            if (i == 0) _leave(MALLORY);
            _skip(7 days);
            (bool wasReleased, uint256 amount) = pool.resolveMilestone();
            assertTrue(wasReleased);
            assertGt(amount, 0);
        }
        // The project received Alice's six tranches: 1 - 0.75^6 of her project money.
        assertApproxEqRel(pool.released(), aliceDue * 8220 / 10_000, 0.001e18);
        assertFalse(pool.abandoned());
    }

    /// @dev A rival buys more than half the weight and declares the project abandoned in the same block, to
    /// freeze its funding. A vote needs the wallet to have held for the seasoning time, and the project to
    /// have gone without a release for the waiting time.
    function test_A4_a_majority_bought_now_cannot_vote_now() public {
        _buy(ALICE, 100_000e18);
        _buy(MALLORY, 400_000e18);
        assertGt(pool.weightOf(MALLORY) * 2, pool.totalWeight());
        vm.prank(MALLORY);
        vm.expectRevert(abi.encodeWithSelector(BackingPool.TooSoon.selector, _now() + 30 days));
        pool.voteAbandon();
        vm.expectRevert(BackingPool.NotAbandonable.selector);
        pool.declareAbandoned();
    }

    /// @dev Voting and then selling, or a vote left over from weight that has gone, cannot carry a majority.
    function test_A4_votes_do_not_outlive_the_weight_behind_them() public {
        _buy(ALICE, 100_000e18);
        uint256 units = _buy(MALLORY, 400_000e18);
        _skip(90 days);
        vm.prank(MALLORY);
        pool.voteAbandon();
        _sell(MALLORY, units);
        assertEq(pool.abandonVotes(), 0);
        vm.expectRevert(BackingPool.NotAbandonable.selector);
        pool.declareAbandoned();
        // Buying back in does not bring the vote back.
        _buy(MALLORY, 400_000e18);
        assertFalse(pool.votedAbandon(MALLORY));
        vm.expectRevert(BackingPool.NotAbandonable.selector);
        pool.declareAbandoned();
    }

    /// @dev A project that keeps releasing cannot be voted out at all: every release that pays restarts the
    /// waiting time, and nobody can stop a release.
    function test_A4_a_project_that_keeps_releasing_cannot_be_voted_out() public {
        _buy(ALICE, 100_000e18);
        _buy(MALLORY, 400_000e18);
        _skip(30 days);
        vm.prank(MALLORY);
        pool.voteAbandon();
        for (uint256 i; i < 5; ++i) {
            _release();
            vm.warp(pool.nextClaimAt());
            vm.expectRevert(BackingPool.NotAbandonable.selector);
            pool.declareAbandoned();
        }
    }

    /// @dev What a patient rival with a real majority can do, and what it costs: against a project that
    /// has released nothing for three months, the pool ends, every other backer gets theirs back, and the
    /// rival has held four times the pool for that long and paid the project a fee on all of it. Recorded
    /// as a limit, not prevented.
    function test_A4_limit_a_seasoned_majority_can_end_a_pool_that_stopped_releasing() public {
        _buy(ALICE, 100_000e18);
        uint256 aliceDue = pool.escrowOf(ALICE);
        uint256 start = quote.balanceOf(MALLORY);
        uint256 units = _buy(MALLORY, 400_000e18);
        _skip(30 days);
        vm.prank(MALLORY);
        pool.voteAbandon();
        vm.expectRevert(BackingPool.NotAbandonable.selector);
        pool.declareAbandoned();
        _skip(60 days);
        pool.declareAbandoned();
        _sell(MALLORY, units);
        assertGe(_spent(MALLORY, start), 4_000e18, "her fee went to the project");
        assertGe(pool.feesTaken(), 5_000e18);
        assertGe(pool.escrowOf(ALICE) + 1, aliceDue, "and the other backer is whole");
    }

    // ---- A5: the founder draining the escrow -----------------------------------------------------------------------

    /// @dev The founder posts as fast as the contract allows and every backer stays: the most the project
    /// can take is one tranche an interval, never the whole escrow, and never a unit of the reserve.
    function test_A5_the_founder_cannot_take_more_than_a_tranche_an_interval() public {
        _buy(ALICE, 100_000e18);
        _buy(BOB, 100_000e18);
        uint256 escrow = pool.escrow();
        uint256 reserve = pool.reserve();
        uint256 opened = pool.openedAt();
        for (uint256 i; i < 6; ++i) {
            _post();
            // Posting again, or resolving early, is refused.
            vm.prank(FOUNDER);
            vm.expectRevert(BackingPool.MilestoneOpen.selector);
            pool.postMilestone(REF);
            vm.expectRevert(BackingPool.WindowNotOver.selector);
            pool.resolveMilestone();
            _skip(7 days);
            pool.resolveMilestone();
            vm.expectRevert(BackingPool.NoOpenMilestone.selector);
            pool.resolveMilestone();
        }
        // Six posts took at least six intervals, and released 1 - 0.75^6 of the escrow, about 82%.
        assertGe(_now() - opened, 6 * 28 days);
        assertApproxEqRel(pool.released(), escrow * 8220 / 10_000, 0.001e18);
        assertEq(quote.balanceOf(treasury), pool.released() + pool.feesTaken());
        assertEq(pool.reserve(), reserve, "the reserve is not the project's to take");
        _sellAll(ALICE);
        _sellAll(BOB);
        _assertSolvent();
    }

    /// @dev Review, its proof P4: the founder buys four times a backer's weight before posting. It used to
    /// outvote her objection. Now weight decides nothing: she leaves whole whatever he holds, and the only
    /// money his milestone releases is his own.
    function test_review_F4_a_founder_cannot_outweigh_a_backer_who_wants_out() public {
        _buy(ALICE, 100_000e18);
        uint256 aliceDue = pool.escrowOf(ALICE);
        _buy(FOUNDER, 405_000e18);
        uint256 founderDue = pool.escrowOf(FOUNDER);
        _post();
        (,, uint256 fromEscrow,) = pool.quoteLeave(ALICE);
        assertApproxEqAbs(fromEscrow, aliceDue, 1);
        _leave(ALICE);
        _skip(7 days);
        (, uint256 amount) = pool.resolveMilestone();
        assertApproxEqAbs(amount, founderDue / 4, 2, "he released a quarter of his own money to the DAO");
    }

    /// @dev Nobody but the founder and the DAO can post, so a stranger cannot burn the project's one post
    /// per interval on a junk reference, or open exits the project did not ask for.
    function test_A5_a_stranger_cannot_post_or_use_up_the_interval() public {
        _buy(ALICE, 100_000e18);
        vm.warp(pool.nextClaimAt());
        vm.prank(MALLORY);
        vm.expectRevert(BackingPool.NotClaimant.selector);
        pool.postMilestone(keccak256("junk"));
        assertEq(pool.lastClaimAt(), pool.openedAt());
    }

    /// @dev A founder who posts as often as allowed only offers backers a free way out as often: it costs
    /// the project, never a backer. Milestones cannot come faster than the interval.
    function test_A5_posting_often_only_gives_backers_more_ways_out() public {
        _buy(ALICE, 100_000e18);
        uint256 aliceDue = pool.escrowOf(ALICE);
        _post();
        _skip(7 days);
        pool.resolveMilestone();
        uint256 notBefore = pool.nextClaimAt();
        vm.prank(FOUNDER);
        vm.expectRevert(abi.encodeWithSelector(BackingPool.TooSoon.selector, notBefore));
        pool.postMilestone(REF);
        _post();
        uint256 out = _leave(ALICE);
        // She leaves with what the first milestone did not release, and her units sold with no fee.
        assertApproxEqAbs(pool.refunded(), aliceDue - aliceDue / 4, 2);
        assertGt(out, 100_000e18 * 95 / 100);
    }

    // ---- limits, recorded ------------------------------------------------------------------------------------------

    /// @dev Leaving is not final: a backer can leave at a milestone and buy back straight away. They pay the
    /// 1% fee on the way back in and keep their project money out of that tranche. With the default terms
    /// that is cheaper than staying while their escrow part is more than about 4% of their position, so a
    /// backer who does this every time funds the project through fees only. Recorded, not prevented.
    function test_limit_leaving_and_buying_back_dodges_the_tranche_for_the_price_of_a_fee() public {
        _buy(BOB, 100_000e18);
        uint256 units = _buy(ALICE, 100_000e18);
        uint256 start = quote.balanceOf(ALICE);
        _post();
        uint256 out = _leave(ALICE);
        uint256 back = _buy(ALICE, out);
        _skip(7 days);
        pool.resolveMilestone();
        assertEq(_spent(ALICE, start), 0);
        // She holds 1% fewer units, and all of her project money: the tranche took none of it.
        assertApproxEqRel(back, units, 0.02e18);
        assertApproxEqRel(pool.escrowOf(ALICE), 9_900e18, 0.02e18);
        // Bob, who stayed, carried his own quarter.
        assertApproxEqAbs(pool.escrowOf(BOB), 9_900e18 * 3 / 4, 2);
    }

    /// @dev Review, its proof P3b: project money given up by ordinary sellers goes to those who stay, so a
    /// backer who waits while others sell in a panic is owed more than they put in. Recorded, not prevented:
    /// it is the reason to leave at a milestone, or wait for abandonment, and not to sell.
    function test_limit_those_who_stay_gain_what_ordinary_sellers_give_up() public {
        _buy(ALICE, 80_000e18);
        _buy(MALLORY, 21_000e18);
        uint256 due = pool.escrowOf(MALLORY);
        _sellAll(ALICE);
        assertGt(pool.escrowOf(MALLORY), due * 4);
    }

    /// @dev Review, its proof P5: an ordinary sale gives up weight by the units sold, not by what they cost.
    /// On a curve the last units bought are the dearest, so selling half the units of a large position
    /// takes back most of its reserve and keeps half its weight. Recorded, not prevented.
    function test_limit_a_sale_gives_up_weight_by_units_not_by_cost() public {
        uint256 units = _buy(MALLORY, 1_000_000e18);
        uint256 reserve = pool.reserve();
        uint256 weight = pool.weightOf(MALLORY);
        uint256 out = _sell(MALLORY, units / 2);
        assertGt(out, reserve * 90 / 100);
        assertApproxEqRel(pool.weightOf(MALLORY), weight / 2, 1e12);
    }

    // ---- griefing ---------------------------------------------------------------------------------------------------

    /// @dev There are no seats to fill and no rounds to stall: a swarm of dust buyers shuts nobody out.
    function test_dust_wallets_cannot_keep_anyone_out() public {
        for (uint256 i; i < 40; ++i) {
            address dust = address(uint160(0xD000 + i));
            quote.mint(dust, 1e18);
            vm.startPrank(dust);
            quote.approve(address(pool), type(uint256).max);
            pool.buy(1e15, 0, type(uint256).max);
            vm.stopPrank();
        }
        _buy(ALICE, 10_000e18);
        _sellAll(ALICE);
        _assertSolvent();
    }

    /// @dev Nobody can close another wallet's way out: a buy only ever marks the wallet that sent it.
    function test_nobody_can_close_another_wallets_way_out() public {
        _buy(ALICE, 100_000e18);
        _post();
        _buy(MALLORY, 100_000e18);
        assertEq(pool.boughtDuring(ALICE), 0);
        assertTrue(pool.canLeave(ALICE));
        _leave(ALICE);
    }

    /// @dev Money sent to the pool does not start anyone's clock or change anyone's part.
    function test_a_stray_transfer_changes_nothing() public {
        _buy(ALICE, 100_000e18);
        uint256 due = pool.escrowOf(ALICE);
        uint256 at = pool.abandonableAt();
        quote.mint(address(pool), 1_000_000e18);
        assertEq(pool.escrowOf(ALICE), due);
        assertEq(pool.abandonableAt(), at);
        assertEq(pool.escrow(), due + 1);
    }

    /// @dev The early cap is per wallet. Splitting across wallets gets around it and the document says so;
    /// what it does stop is one wallet taking the opening price in a single transaction.
    function test_the_early_cap_stops_one_wallet_taking_the_opening() public {
        BackingPool fresh = new BackingPool(treasury, FOUNDER, IERC20(address(quote)), defaultTerms());
        vm.startPrank(MALLORY);
        quote.approve(address(fresh), type(uint256).max);
        vm.expectRevert(BackingPool.EarlyCapReached.selector);
        fresh.buy(100_000e18, 0, type(uint256).max);
        fresh.buy(1_000e18, 0, type(uint256).max);
        vm.stopPrank();
        // A capped wallet moves the opening price by about 7%.
        assertLt(fresh.price(), 0.000025e18 * 1e18 * 108 / 100);
    }
}
