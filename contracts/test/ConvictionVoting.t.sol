// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ConvictionVoting, IConvictionWeight} from "../src/ConvictionVoting.sol";

/// @dev Binds the mechanism to its own claims (Review-Proven Rule 3): the
/// properties below are the ones the design rests on — a sybil gains nothing
/// by splitting, one allowance cannot back two proposals, small asks cannot
/// pass on crumbs, and a snapshot ignores credits staked after it.
///
/// Block targets are absolute (`vm.roll(201)`, never `block.number + 200`):
/// with `via_ir`, solc folds `block.number` across cheatcode calls, so a roll
/// computed from `block.number` right after a roll re-uses the stale value.
contract ConvictionVotingTest is Test {
    // α = 0.99 per block, so conviction matures toward 100 × credits and the
    // arithmetic below stays readable.
    uint256 constant ALPHA = 0.99e18;
    uint256 constant MIN_W = 0.02e18;
    uint256 constant MAX_W = 0.2e18;

    address constant GOVERNANCE = address(0xBEEF);
    address constant ALICE = address(0xA11CE);
    address constant BOB = address(0xB0B);
    address constant STRANGER = address(0xFA11);
    bytes32 constant P1 = keccak256("proposal-1");
    bytes32 constant P2 = keccak256("proposal-2");

    ConvictionVoting cv;

    function setUp() public {
        cv = new ConvictionVoting(GOVERNANCE, ALPHA, MIN_W, MAX_W, 0);
    }

    function openP1(uint256 askWad) internal {
        vm.prank(GOVERNANCE);
        cv.openProposal(P1, askWad);
    }

    function seatAndFund(address who, uint256 credits) internal {
        vm.startPrank(GOVERNANCE);
        cv.grantSeat(who);
        cv.refill(who, credits);
        vm.stopPrank();
    }

    // ---- growth ----

    function test_conviction_grows_with_time_and_saturates_at_the_allowance_ceiling()
        public
    {
        openP1(0);
        seatAndFund(ALICE, 100);
        vm.prank(ALICE);
        cv.stake(P1, 100);

        uint256 early = cv.convictionOf(P1, ALICE);
        vm.roll(101);
        uint256 later = cv.convictionOf(P1, ALICE);
        vm.roll(2_101);
        uint256 matured = cv.convictionOf(P1, ALICE);

        assertGt(later, early, "conviction grows while the credits stay put");
        // Ceiling is credits / (1 − α) = 100 × 100 = 10,000.
        assertApproxEqRel(matured, 10_000, 0.01e18, "saturates at credits/(1-alpha)");
        assertLe(matured, 10_000, "and never above it");
    }

    function test_unspent_credits_carry_no_weight() public {
        openP1(0);
        seatAndFund(ALICE, 100);
        // Allowance in hand, nothing staked.
        assertEq(cv.convictionOf(P1, ALICE), 0);
        assertEq(cv.convictionWeightAt(P1, ALICE, uint48(block.number)), 0);
    }

    // ---- the sybil defence ----

    function test_a_non_seat_cannot_stake_or_earn_anything() public {
        openP1(0);
        vm.prank(STRANGER);
        vm.expectRevert(ConvictionVoting.NotASeat.selector);
        cv.stake(P1, 1);

        assertEq(cv.convictionOf(P1, STRANGER), 0);
        assertEq(cv.convictionWeightAt(P1, STRANGER, uint48(block.number)), 0);
    }

    function test_splitting_one_allowance_across_many_accounts_gains_nothing() public {
        // Same total issuance, two shapes: one seat with 100 credits, or five
        // seats with 20 each. Conviction accumulates linearly in credits, so
        // splitting a sybil farm buys exactly nothing.
        ConvictionVoting solo = new ConvictionVoting(GOVERNANCE, ALPHA, MIN_W, MAX_W, 0);
        ConvictionVoting split = new ConvictionVoting(GOVERNANCE, ALPHA, MIN_W, MAX_W, 0);

        vm.startPrank(GOVERNANCE);
        solo.openProposal(P1, 0);
        split.openProposal(P1, 0);
        solo.grantSeat(ALICE);
        solo.refill(ALICE, 100);
        address[5] memory sybils =
            [address(0x51), address(0x52), address(0x53), address(0x54), address(0x55)];
        for (uint256 i = 0; i < sybils.length; i++) {
            split.grantSeat(sybils[i]);
            split.refill(sybils[i], 20);
        }
        vm.stopPrank();

        vm.prank(ALICE);
        solo.stake(P1, 100);
        for (uint256 i = 0; i < sybils.length; i++) {
            vm.prank(sybils[i]);
            split.stake(P1, 20);
        }

        vm.roll(501);
        assertEq(
            split.totalConviction(P1),
            solo.totalConviction(P1),
            "five identities holding C/5 reach exactly the conviction of one holding C"
        );
    }

    function test_one_allowance_cannot_back_two_proposals_at_once() public {
        openP1(0);
        vm.prank(GOVERNANCE);
        cv.openProposal(P2, 0);
        seatAndFund(ALICE, 100);

        vm.prank(ALICE);
        cv.stake(P1, 100);
        vm.prank(ALICE);
        vm.expectRevert(ConvictionVoting.NoCredits.selector);
        cv.stake(P2, 1);

        // The books balance: unspent plus staked is the issuance, no more.
        (, uint256 staked,) = cv.totals(P1);
        assertEq(cv.unspent(ALICE), 0);
        assertEq(staked, 100);
    }

    function test_withdrawing_support_lets_the_old_conviction_decay() public {
        openP1(0);
        seatAndFund(ALICE, 100);
        vm.prank(ALICE);
        cv.stake(P1, 100);
        vm.roll(201);
        uint256 peak = cv.convictionOf(P1, ALICE);
        assertGt(peak, 0);

        vm.prank(ALICE);
        cv.unstake(P1, 100);
        vm.roll(2_201);
        uint256 faded = cv.convictionOf(P1, ALICE);
        assertLt(faded, peak / 10, "withdrawn support fades to a tenth after 2,000 blocks");
    }

    // ---- the threshold ----

    function test_a_larger_ask_needs_more_conviction() public {
        seatAndFund(ALICE, 1_000); // issuance sets the ceiling both thresholds scale
        vm.startPrank(GOVERNANCE);
        cv.openProposal(P1, 0.1e18);
        cv.openProposal(P2, 0.9e18);
        vm.stopPrank();
        assertGt(cv.threshold(P2), cv.threshold(P1));
    }

    function test_the_floor_stops_a_tiny_ask_passing_on_crumbs() public {
        // No scaled threshold at all (minW = 0): only the absolute floor
        // stands between a 1-credit joke and the treasury.
        ConvictionVoting floored =
            new ConvictionVoting(GOVERNANCE, ALPHA, 0, MAX_W, 25_000);
        vm.prank(GOVERNANCE);
        floored.openProposal(P1, 0);
        vm.prank(GOVERNANCE);
        floored.grantSeat(ALICE);
        vm.prank(GOVERNANCE);
        floored.refill(ALICE, 100);
        vm.prank(ALICE);
        floored.stake(P1, 100);
        vm.roll(2_001);

        assertEq(floored.threshold(P1), 25_000, "the floor binds for a zero ask");
        assertFalse(floored.passed(P1), "100 credits matured is below a 25,000 floor");
    }

    function test_opening_many_small_proposals_cannot_dilute_a_real_one() public {
        seatAndFund(ALICE, 500);
        vm.prank(GOVERNANCE);
        cv.openProposal(P1, 0.5e18);
        vm.prank(ALICE);
        cv.stake(P1, 500);
        vm.roll(301);

        uint256 wanted = cv.threshold(P1);
        uint256 accumulated = cv.totalConviction(P1);

        // A spammer opens the maximum number of small asks. None of it touches
        // P1's conviction or its threshold: both are measured against issuance.
        vm.startPrank(GOVERNANCE);
        for (uint256 i = 0; i < 20; i++) {
            cv.openProposal(keccak256(abi.encode("spam", i)), 0);
        }
        vm.stopPrank();

        assertEq(cv.threshold(P1), wanted, "threshold is issuance-based, not proposal-count-based");
        assertEq(cv.totalConviction(P1), accumulated, "nobody's conviction moved");
        // Each spam proposal faces the same floor-scaled bar on its own.
        assertTrue(cv.threshold(keccak256(abi.encode("spam", 0))) <= wanted);
    }

    function test_a_real_proposal_passes_when_conviction_crosses_the_curve() public {
        seatAndFund(ALICE, 100);
        seatAndFund(BOB, 100);
        vm.prank(GOVERNANCE);
        cv.openProposal(P1, 0.5e18);

        vm.prank(ALICE);
        cv.stake(P1, 100);
        vm.prank(BOB);
        cv.stake(P1, 100);

        // Fresh stake carries almost no conviction: commitment takes time.
        assertFalse(cv.passed(P1));
        vm.roll(1_001);
        assertTrue(cv.passed(P1), "sustained support crosses the curve");
    }

    // ---- snapshot honesty ----

    function test_a_snapshot_ignores_credits_staked_after_it() public {
        openP1(0);
        seatAndFund(ALICE, 1_000);
        vm.prank(ALICE);
        cv.stake(P1, 100);
        vm.roll(101);
        uint48 past = 101;
        uint256 then = cv.convictionWeightAt(P1, ALICE, past);

        vm.prank(ALICE);
        cv.stake(P1, 900);
        vm.roll(201);

        assertEq(
            cv.convictionWeightAt(P1, ALICE, past),
            then,
            "the later stake does not reach back into the snapshot"
        );
        assertGt(cv.convictionOf(P1, ALICE), then, "and it does count from now on");
    }

    // ---- the door ----

    function test_only_governance_grants_seats_and_opens_proposals() public {
        vm.startPrank(STRANGER);
        vm.expectRevert(ConvictionVoting.OnlyGovernance.selector);
        cv.grantSeat(STRANGER);
        vm.expectRevert(ConvictionVoting.OnlyGovernance.selector);
        cv.openProposal(P1, 0);
        vm.stopPrank();

        vm.prank(GOVERNANCE);
        cv.grantSeat(STRANGER);
        vm.prank(GOVERNANCE);
        vm.expectRevert(ConvictionVoting.NotASeat.selector);
        cv.refill(ALICE, 1); // issuance goes to seats only

        vm.startPrank(GOVERNANCE);
        cv.openProposal(P1, 0);
        vm.expectRevert(ConvictionVoting.ProposalExists.selector);
        cv.openProposal(P1, 0);
        vm.stopPrank();
    }

    function test_the_seat_door_is_bounded() public {
        vm.startPrank(GOVERNANCE);
        for (uint256 i = 0; i < cv.MAX_SEATS(); i++) {
            cv.grantSeat(address(uint160(0x1000 + i)));
        }
        vm.expectRevert(ConvictionVoting.SeatLimit.selector);
        cv.grantSeat(address(0x9999));
        vm.stopPrank();
    }

    function test_unstaking_returns_the_allowance_and_never_more() public {
        openP1(0);
        seatAndFund(ALICE, 100);
        vm.prank(ALICE);
        cv.stake(P1, 100);
        vm.roll(51);
        vm.prank(ALICE);
        cv.unstake(P1, 40);
        (, uint256 staked,) = cv.totals(P1);
        assertEq(cv.unspent(ALICE), 40);
        assertEq(staked, 60);

        vm.prank(ALICE);
        vm.expectRevert(ConvictionVoting.Underflow.selector);
        cv.unstake(P1, 61);
    }

    function test_bad_config_is_refused() public {
        vm.expectRevert(ConvictionVoting.BadConfig.selector);
        new ConvictionVoting(address(0), ALPHA, MIN_W, MAX_W, 0);
        vm.expectRevert(ConvictionVoting.BadConfig.selector);
        new ConvictionVoting(GOVERNANCE, 1e18, MIN_W, MAX_W, 0); // α = 1
        vm.expectRevert(ConvictionVoting.BadConfig.selector);
        new ConvictionVoting(GOVERNANCE, 0.9999999999999e18, MIN_W, MAX_W, 0); // 1 − α below the floor
        vm.expectRevert(ConvictionVoting.BadConfig.selector);
        new ConvictionVoting(GOVERNANCE, ALPHA, MAX_W, MIN_W, 0); // min > max
    }
}
