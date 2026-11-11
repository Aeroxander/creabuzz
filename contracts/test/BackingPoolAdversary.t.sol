// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BackingPool} from "../src/BackingPool.sol";
import {BackingPoolFixture} from "./helpers/BackingPoolFixture.sol";

/// @notice The attacks a pool like this invites, each run as its attacker would run it. The five named in
/// docs/v3-review/BACKING-POOL.md are A1 to A5; the rest are the sandwich and griefing cases of
/// docs/v3-review/SECONDARY-TRADING-REVIEW.md that still apply to a pool with no rounds and no seats.
contract BackingPoolAdversaryTest is BackingPoolFixture {
    function setUp() public override {
        super.setUp();
        _pastEarly();
    }

    function _spent(address who, uint256 startBalance) internal view returns (int256) {
        return int256(startBalance) - int256(quote.balanceOf(who));
    }

    // ---- A1: sandwiching a trade -----------------------------------------------------------------------------------

    /// @dev Mallory sees Alice's buy, buys first, lets Alice push the price up, and sells into it. Every buy
    /// leaves its project part and two fees behind, so the round trip only pays if Alice's buy alone moves
    /// the curve price by more than about 46%. An ordinary buy does not, and the sandwich loses money.
    function test_A1_sandwiching_an_ordinary_buy_loses_money() public {
        _buy(BOB, 20_000e18);
        uint256 start = quote.balanceOf(MALLORY);
        uint256 units = _buy(MALLORY, 50_000e18);
        _buy(ALICE, 20_000e18);
        _sell(MALLORY, units);
        assertGt(_spent(MALLORY, start), 0, "the sandwich cost her money");
    }

    function testFuzz_A1_no_sandwich_pays_unless_the_victim_moves_the_price_by_nearly_half(
        uint256 depth,
        uint256 front,
        uint256 victim
    ) public {
        depth = bound(depth, 1e15, 3_000_000e18);
        front = bound(front, 1e15, 3_000_000e18);
        _buy(BOB, depth);
        uint256 start = quote.balanceOf(MALLORY);
        uint256 units = _buy(MALLORY, front);
        // The victim adds at most 20% to the curve's quote side: a price move of at most 44%.
        uint256 x = pool.virtualQuote() + pool.reserve();
        victim = bound(victim, 1e15, x * 28 / 100);
        _buy(ALICE, victim);
        _sell(MALLORY, units);
        assertGt(_spent(MALLORY, start), 0);
    }

    /// @dev The limit, recorded and not prevented: a buy large enough to move the price by more than that,
    /// sent with no price limit, can be sandwiched at a profit, as on any curve.
    function test_A1_limit_a_huge_buy_with_no_price_limit_can_be_sandwiched() public {
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
    function test_A1_sandwiching_a_sale_loses_units() public {
        _buy(BOB, 200_000e18);
        uint256 mallory = _buy(MALLORY, 50_000e18);
        uint256 alice = _buy(ALICE, 50_000e18);
        uint256 got = _sell(MALLORY, mallory);
        _sell(ALICE, alice);
        uint256 back = _buy(MALLORY, got);
        assertLt(back, mallory);
    }

    // ---- A2: buying in late to take the refund ---------------------------------------------------------------------

    /// @dev The project is dying: backers have sold and left their project money behind, and the abandonment
    /// clock is about to run out. Mallory buys in at the last second to take a part of that money when it is
    /// refunded. Her weight is priced at what she adds, so she takes none of it.
    function test_A2_buying_just_before_abandonment_takes_nothing_from_those_who_stayed() public {
        _buy(ALICE, 50_000e18);
        uint256 bob = _buy(BOB, 200_000e18);
        _buy(CAROL, 50_000e18);
        // Bob leaves; his project money stays for Alice and Carol.
        _sell(BOB, bob);
        vm.warp(pool.abandonableAt() - 1);
        uint256 aliceDue = pool.escrowOf(ALICE);
        uint256 carolDue = pool.escrowOf(CAROL);

        uint256 start = quote.balanceOf(MALLORY);
        uint256 units = _buy(MALLORY, 300_000e18);
        _skip(1);
        vm.prank(MALLORY);
        pool.declareAbandoned();
        _sell(MALLORY, units);

        assertGt(_spent(MALLORY, start), 0, "she got back less than she put in");
        // Alice and Carol are owed what they were owed before she came.
        assertGe(pool.escrowOf(ALICE), aliceDue);
        assertGe(pool.escrowOf(CAROL), carolDue);
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
        vm.warp(pool.abandonableAt());
        uint256 aliceDue = pool.escrowOf(ALICE);
        uint256 start = quote.balanceOf(MALLORY);
        uint256 units = _buy(MALLORY, late);
        pool.declareAbandoned();
        _sell(MALLORY, units);
        assertGe(_spent(MALLORY, start), 0);
        assertGe(pool.escrowOf(ALICE) + 1, aliceDue);
    }

    /// @dev The same idea with nobody left: every backer sold, the escrow has no owner, and Mallory is the
    /// first to buy again. She gets a weight worth her own money, not the pot.
    function test_A2_the_first_buyer_after_everyone_left_does_not_get_the_pot() public {
        uint256 alice = _buy(ALICE, 100_000e18);
        _sell(ALICE, alice);
        uint256 pot = pool.escrow();
        assertGt(pot, 29_000e18);
        assertEq(pool.totalWeight(), 0);

        (,, uint256 toEscrow,) = pool.quoteBuy(1_000e18);
        _buy(MALLORY, 1_000e18);
        assertLe(pool.escrowOf(MALLORY), toEscrow, "her own project money at most");
        assertApproxEqRel(pool.escrowOf(MALLORY), toEscrow, 1e12);
        // The pot stays project money: released by milestones like the rest.
        _post();
        _skip(7 days);
        (, uint256 amount) = pool.resolveMilestone();
        assertEq(amount, (pot + toEscrow) / 4);
    }

    /// @dev Making the escrow huge next to the weights, so a victim's weight rounds to nothing, would take
    /// leaving a million times the victim's money behind. A thousand times does nothing.
    function test_A2_a_huge_ownerless_pot_does_not_round_a_backers_weight_away() public {
        uint256 mallory = _buy(MALLORY, 3_000_000e18);
        _sell(MALLORY, mallory);
        (,, uint256 toEscrow,) = pool.quoteBuy(1_000e18);
        _buy(ALICE, 1_000e18);
        assertApproxEqRel(pool.escrowOf(ALICE), toEscrow, 1e12);
    }

    // ---- A3: buying a block, or buying to drown one ----------------------------------------------------------------

    /// @dev A rival who holds nothing buys a fifth of the weight after a milestone is posted, to keep the
    /// project's money back. A wallet that buys during the window has no say on that milestone.
    function test_A3_a_block_cannot_be_bought_after_the_post() public {
        _buy(ALICE, 100_000e18);
        _post();
        _buy(MALLORY, 500_000e18);
        vm.prank(MALLORY);
        vm.expectRevert(BackingPool.NoSay.selector);
        pool.object();
        _skip(7 days);
        (bool wasReleased,) = pool.resolveMilestone();
        assertTrue(wasReleased);
    }

    /// @dev The founder, seeing objections come in, buys a mountain of units from other wallets to push the
    /// objectors under the threshold. Weight bought during the window is not in the count either way.
    function test_A3_objections_cannot_be_drowned_after_the_post() public {
        _buy(ALICE, 70_000e18);
        _buy(BOB, 30_000e18);
        _post();
        vm.prank(BOB);
        pool.object();
        // Bob is about 30% of the weight that can object. The founder's sock puppet adds ten times the pool.
        _buy(CAROL, 1_000_000e18);
        (,,,, uint256 eligible, uint256 objections,) = pool.milestones(1);
        assertGe(objections * 10_000, eligible * 2_000, "still over the threshold");
        _skip(7 days);
        (bool wasReleased,) = pool.resolveMilestone();
        assertFalse(wasReleased);
    }

    /// @dev An existing backer cannot dodge the rule either way: topping up during the window takes their
    /// own earlier weight out of the count, so it neither adds to a block nor to the weight it is measured by.
    function test_A3_topping_up_during_the_window_removes_the_wallet_from_the_count() public {
        _buy(ALICE, 70_000e18);
        _buy(BOB, 30_000e18);
        _post();
        uint256 aliceWeight = pool.weightOf(ALICE);
        uint256 total = pool.totalWeight();
        _buy(ALICE, 1e18);
        (,,,, uint256 eligible,,) = pool.milestones(1);
        assertEq(eligible, total - aliceWeight);
        // Bob alone is now the whole count: his objection decides.
        vm.prank(BOB);
        pool.object();
        _skip(7 days);
        (bool wasReleased,) = pool.resolveMilestone();
        assertFalse(wasReleased);
    }

    /// @dev Objecting and then leaving does not leave a ghost objection behind.
    function test_A3_object_then_sell_leaves_no_objection() public {
        _buy(ALICE, 70_000e18);
        uint256 units = _buy(MALLORY, 30_000e18);
        _post();
        vm.prank(MALLORY);
        pool.object();
        _sell(MALLORY, units);
        (,,,, uint256 eligible, uint256 objections,) = pool.milestones(1);
        assertEq(objections, 0);
        assertEq(eligible, pool.weightOf(ALICE));
        _skip(7 days);
        (bool wasReleased,) = pool.resolveMilestone();
        assertTrue(wasReleased);
    }

    // ---- A4: killing a project's pool in one transaction -----------------------------------------------------------

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

    /// @dev What a patient rival with a real majority can do, and what it costs: the project loses the
    /// money not yet released, every other backer gets theirs back, and the rival has held four times the
    /// pool for three months and paid the project a fee on all of it. Recorded as a limit, not prevented.
    function test_A4_a_seasoned_majority_can_end_a_pool_and_pays_for_it() public {
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
        assertGe(pool.escrowOf(ALICE), aliceDue, "and the other backer is whole");
    }

    // ---- A5: the founder draining the escrow -----------------------------------------------------------------------

    /// @dev The founder posts as fast as the contract allows and nobody ever objects: the most the project
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
        // Both backers can still sell everything.
        _sellAll(ALICE);
        _sellAll(BOB);
        _assertSolvent();
    }

    /// @dev A founder who buys in before posting, to outweigh backers he expects to object, needs four times
    /// their project money to get them under a 20% threshold. That money is then in the escrow like anyone
    /// else's: the tranche takes a quarter of it too, and the moment he sells to get his reserve part back,
    /// what is left of his project money belongs to the backers he outweighed.
    function test_A5_outweighing_objectors_before_a_post_costs_the_founder_more_than_it_releases() public {
        _buy(ALICE, 100_000e18);
        uint256 aliceDue = pool.escrowOf(ALICE);
        uint256 start = quote.balanceOf(MALLORY);
        // The founder's other wallet: 4.2 times Alice.
        uint256 units = _buy(MALLORY, 420_000e18);
        _post();
        vm.prank(ALICE);
        pool.object();
        _skip(7 days);
        (bool wasReleased, uint256 amount) = pool.resolveMilestone();
        assertTrue(wasReleased, "the limit: weight bought before the post does count");
        _sell(MALLORY, units);
        // He paid in far more than the tranche the treasury received.
        assertGt(uint256(_spent(MALLORY, start)), amount * 3);
        // And Alice, having stayed, is now owed more than before he started.
        assertGt(pool.escrowOf(ALICE), aliceDue);
    }

    /// @dev Nobody but the founder and the DAO can post, so a stranger cannot burn the project's one post
    /// per interval on a junk reference, or restart anyone's clock.
    function test_A5_a_stranger_cannot_post_or_use_up_the_interval() public {
        _buy(ALICE, 100_000e18);
        vm.warp(pool.nextClaimAt());
        vm.prank(MALLORY);
        vm.expectRevert(BackingPool.NotClaimant.selector);
        pool.postMilestone(keccak256("junk"));
        assertEq(pool.lastClaimAt(), pool.openedAt());
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

    /// @dev Dust objections from many wallets weigh what the wallets hold, no more.
    function test_many_small_objectors_weigh_only_what_they_hold() public {
        _buy(ALICE, 100_000e18);
        address[] memory small = new address[](20);
        for (uint256 i; i < 20; ++i) {
            small[i] = address(uint160(0xE000 + i));
            quote.mint(small[i], 1_000e18);
            vm.startPrank(small[i]);
            quote.approve(address(pool), type(uint256).max);
            pool.buy(500e18, 0, type(uint256).max);
            vm.stopPrank();
        }
        _post();
        for (uint256 i; i < 20; ++i) {
            vm.prank(small[i]);
            pool.object();
        }
        _skip(7 days);
        // Twenty wallets, about 9% of the weight together: under the threshold.
        (bool wasReleased,) = pool.resolveMilestone();
        assertTrue(wasReleased);
    }

    /// @dev Nobody can spend another wallet's say: a buy only ever credits, and only ever silences, the
    /// wallet that sent it.
    function test_nobody_can_silence_another_wallet() public {
        _buy(ALICE, 100_000e18);
        _post();
        vm.prank(ALICE);
        pool.object();
        _buy(MALLORY, 100_000e18);
        assertEq(pool.objectedTo(ALICE), 1);
        (,,,,, uint256 objections,) = pool.milestones(1);
        assertEq(objections, pool.weightOf(ALICE));
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
        // After a day of capped buying at most this much of the curve can be gone per wallet.
        assertLt(fresh.price(), fresh.virtualQuote() * 1e18 / fresh.virtualUnits() * 106 / 100);
    }
}
