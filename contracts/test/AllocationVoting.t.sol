// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {VotingFixture} from "./helpers/VotingFixture.sol";
import {AllocationVoting} from "../src/AllocationVoting.sol";
import {Moloch} from "../src/majeur/MolochPatched.sol";

contract AllocationVotingTest is VotingFixture {
    uint256 internal constant ID = 1;

    function setUp() public override {
        super.setUp();
        // The fixture's native 50% quorum would hide the lane's own 20%; test the lane.
        vm.prank(address(dao));
        dao.setQuorumBps(500);
    }

    /// @dev ALICE 50, BOB 30, CAROL 20 Shares (BOB also holds the fixture's Loot, which never votes).
    function _three() internal {
        vm.startPrank(ALICE);
        shares.transfer(BOB, 30e18);
        shares.transfer(CAROL, 20e18);
        vm.stopPrank();
        vm.roll(block.number + 1);
    }

    function _castAgainst(address who, uint256 id, uint256 amount) internal {
        vm.prank(who);
        dao.castVote(id, 0, amount);
    }

    // ---- the bars ---------------------------------------------------------------------------

    function test_unrestricted_needs_two_thirds_of_votes_cast() public {
        _three();
        vote(ALICE, ID, 50e18);
        _castAgainst(BOB, ID, 30e18);
        vm.warp(vm.getBlockTimestamp() + 3 days);
        assertFalse(ledger.thresholdsMet(ID), "50 of 80 cast is 62.5%, below the 66% bar");
        assertFalse(ledger.qualifies(ID));
        vote(CAROL, ID, 20e18);
        assertTrue(ledger.thresholdsMet(ID), "70 of 100 cast clears 66% and the 20% quorum");
    }

    function test_quorum_is_a_share_of_voting_supply_not_of_those_who_showed_up() public {
        _three();
        vote(CAROL, ID, 15e18);
        assertFalse(ledger.thresholdsMet(ID), "15% of voting supply is below the 20% quorum even at 100% approval");
        vote(CAROL, ID, 20e18);
        assertTrue(ledger.thresholdsMet(ID), "exactly 20% clears it");
    }

    function test_a_late_arrival_still_waits_the_hold_time() public {
        _three();
        vote(ALICE, ID, 1e18); // opens the proposal; nowhere near a bar
        vm.warp(vm.getBlockTimestamp() + 47 hours);
        vote(ALICE, ID, 50e18);
        vote(CAROL, ID, 20e18);
        assertTrue(ledger.thresholdsMet(ID));
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        assertFalse(ledger.qualifies(ID), "review is over but the support arrived an hour ago");
        vm.warp(vm.getBlockTimestamp() + 11 hours - 1);
        assertFalse(ledger.qualifies(ID), "one second short of the 12 hour hold");
        vm.warp(vm.getBlockTimestamp() + 1);
        assertTrue(ledger.qualifies(ID));
    }

    function test_steady_support_is_approvable_the_moment_review_ends() public {
        _three();
        vote(ALICE, ID, 50e18);
        vote(CAROL, ID, 20e18);
        vm.warp(vm.getBlockTimestamp() + 48 hours - 1);
        assertFalse(ledger.qualifies(ID));
        vm.warp(vm.getBlockTimestamp() + 1);
        assertTrue(ledger.qualifies(ID), "the hold ran inside the review period");
        assertEq(ledger.earliestApproval(ID), _rules(ID).reviewEndsAt);
    }

    function test_losing_support_restarts_the_hold_and_the_queue() public {
        _three();
        vote(ALICE, ID, 50e18);
        vote(CAROL, ID, 20e18);
        _castAgainst(BOB, ID, 30e18);
        vm.warp(vm.getBlockTimestamp() + 2 days);
        dao.queue(ID); // 70 of 100 cast, above the 66% bar
        assertGt(dao.queuedAt(ID), 0);
        vote(CAROL, ID, 0); // 50 of 80 cast is 62.5%: the bar is lost
        assertEq(dao.queuedAt(ID), 0, "a lost bar clears the queued timestamp");
        (,,, uint64 since) = ledger.proposalSupport(ID);
        assertEq(since, 0);
        vote(CAROL, ID, 20e18);
        assertFalse(ledger.qualifies(ID), "recovered support has to hold again");
        vm.warp(vm.getBlockTimestamp() + 12 hours);
        assertTrue(ledger.qualifies(ID));
    }

    function test_opposition_counts_at_once() public {
        _three();
        vote(ALICE, ID, 50e18);
        vote(CAROL, ID, 20e18);
        vm.warp(vm.getBlockTimestamp() + 3 days);
        assertTrue(ledger.qualifies(ID));
        _castAgainst(ALICE, ID, 50e18);
        assertFalse(ledger.qualifies(ID), "a flipped position is opposition immediately, not after it accrues");
    }

    function test_abstain_counts_for_quorum_only() public {
        _three();
        vote(ALICE, ID, 15e18);
        vm.prank(CAROL);
        dao.castVote(ID, 2, 20e18);
        (uint96 yes,, uint96 abstain,) = ledger.proposalSupport(ID);
        assertEq(yes, 15e18);
        assertEq(abstain, 20e18);
        assertTrue(ledger.thresholdsMet(ID), "35 cast clears quorum and all of the decided votes are FOR");
        vm.prank(CAROL);
        dao.castVote(ID, 2, 0);
        assertFalse(ledger.thresholdsMet(ID), "15 cast is under quorum: abstain was the only thing carrying it");
    }

    // ---- voting supply -----------------------------------------------------------------------

    function test_voting_supply_leaves_out_treasury_burn_and_excluded_holders() public {
        _three();
        vm.startPrank(address(dao));
        shares.mintFromMoloch(address(dao), 100e18);
        shares.mintFromMoloch(ledger.BURN(), 50e18);
        shares.mintFromMoloch(address(0xA0C), 25e18);
        vm.stopPrank();
        vm.roll(block.number + 1);
        vote(ALICE, ID, 1);
        AllocationVoting.Rules memory r = _rules(ID);
        assertEq(shares.getPastTotalSupply(uint48(block.number - 1)), 275e18, "all of it is in total supply");
        assertEq(r.votingSupply, 125e18, "treasury and burn leave 100 of voters plus 25 in an unmarked wallet");

        vm.prank(address(dao));
        ledger.setExcluded(address(0xA0C), true);
        vote(ALICE, 2, 1);
        assertEq(_rules(2).votingSupply, 100e18, "an excluded holder (a sale tranche, an AMM) leaves too");
    }

    function test_only_the_dao_manages_exclusions_and_they_are_bounded() public {
        vm.expectRevert(AllocationVoting.Unauthorized.selector);
        ledger.setExcluded(address(0xBEEF), true);
        vm.startPrank(address(dao));
        // BURN is already excluded; fill the rest.
        for (uint160 i = 1; i < ledger.MAX_EXCLUDED(); ++i) {
            ledger.setExcluded(address(i + 0x1000), true);
        }
        vm.expectRevert(AllocationVoting.TooManyExcluded.selector);
        ledger.setExcluded(address(0xFFFF), true);
        ledger.setExcluded(address(0x1001), false);
        ledger.setExcluded(address(0xFFFF), true);
        vm.stopPrank();
        assertEq(ledger.excludedHolders().length, ledger.MAX_EXCLUDED());
    }

    // ---- lanes ------------------------------------------------------------------------------

    function test_lane_settings_are_dao_only_and_bounded() public {
        vm.expectRevert(AllocationVoting.Unauthorized.selector);
        ledger.setLane(false, 2000, 6600, 48 hours, 12 hours, true);
        vm.startPrank(address(dao));
        vm.expectRevert(AllocationVoting.InvalidLane.selector);
        ledger.setLane(false, 499, 6600, 48 hours, 12 hours, true); // quorum under 5%
        vm.expectRevert(AllocationVoting.InvalidLane.selector);
        ledger.setLane(false, 6001, 6600, 48 hours, 12 hours, true); // a quorum most DAOs could never reach
        vm.expectRevert(AllocationVoting.InvalidLane.selector);
        ledger.setLane(false, 2000, 5000, 48 hours, 12 hours, true); // approval must be strictly above half
        vm.expectRevert(AllocationVoting.InvalidLane.selector);
        ledger.setLane(false, 2000, 9001, 48 hours, 12 hours, true);
        vm.expectRevert(AllocationVoting.InvalidLane.selector);
        ledger.setLane(false, 2000, 6600, 23 hours, 12 hours, true);
        vm.expectRevert(AllocationVoting.InvalidLane.selector);
        ledger.setLane(false, 2000, 6600, 48 hours, 49 hours, true); // hold longer than review
        ledger.setLane(false, 3000, 7000, 3 days, 1 days, true);
        vm.stopPrank();
        (uint16 q, uint16 a, uint64 review, uint64 hold, bool exclusive) = ledger.lanes(0);
        assertEq(q, 3000);
        assertEq(a, 7000);
        assertEq(review, 3 days);
        assertEq(hold, 1 days);
        assertTrue(exclusive);
    }

    function test_a_lane_change_never_rewrites_an_open_proposal() public {
        _three();
        vote(ALICE, ID, 1e18);
        AllocationVoting.Rules memory before_ = _rules(ID);
        vm.prank(address(dao));
        ledger.setLane(false, 6000, 9000, 14 days, 7 days, true);
        AllocationVoting.Rules memory after_ = _rules(ID);
        assertEq(after_.quorum, before_.quorum);
        assertEq(after_.approvalBps, before_.approvalBps);
        assertEq(after_.reviewEndsAt, before_.reviewEndsAt);
        vote(ALICE, 2, 1e18);
        assertEq(_rules(2).approvalBps, 9000, "the next proposal does use it");
    }

    function test_a_ttl_too_short_for_the_lane_cannot_brick_proposals() public {
        // Moloch only requires TTL > 48h + delay; this lane needs 48h review + 12h hold + 1d delay on top.
        vm.startPrank(address(dao));
        dao.setProposalTTL(4 days);
        vm.stopPrank();
        vote(ALICE, ID, 1e18);
        AllocationVoting.Rules memory r = _rules(ID);
        assertEq(r.expiresAt, uint64(vm.getBlockTimestamp()) + 48 hours + 12 hours + 1 days + 1 days, "stretched to fit");
    }

    function test_governor_settings_can_raise_a_bar_but_never_lower_the_lane() public {
        vm.prank(address(dao));
        dao.setQuorumBps(5000);
        _three();
        vote(ALICE, ID, 1);
        assertEq(_rules(ID).quorum, 50e18, "50% governor quorum beats the 20% lane quorum");
        vm.prank(address(dao));
        dao.setQuorumBps(100);
        vote(ALICE, 2, 1);
        assertEq(_rules(2).quorum, 20e18, "a 1% governor quorum cannot go under the 20% lane");
    }

    // ---- allocations (unchanged contract with the owners) ---------------------------------------

    function test_transfers_trim_only_overallocation_and_reset_queue() public {
        _three();
        vote(ALICE, ID, 30e18);
        vote(ALICE, 2, 20e18);
        vote(CAROL, ID, 20e18);
        vm.warp(vm.getBlockTimestamp() + 2 days);
        dao.queue(ID);
        vm.prank(ALICE);
        shares.transfer(address(0xD00D), 25e18);
        (uint96 first,,,) = ledger.proposalSupport(ID);
        (uint96 second,,,) = ledger.proposalSupport(2);
        assertEq(first, 20e18 + 15e18, "ALICE's 30 trimmed to 15; CAROL's 20 untouched");
        assertEq(second, 10e18, "ALICE's 20 trimmed to 10");
        assertEq(ledger.available(address(0xD00D)), 25e18);
        assertEq(ledger.allocated(ALICE), 25e18);
        vm.prank(address(0xD00D));
        shares.transfer(ALICE, 20e18);
        assertEq(ledger.allocated(ALICE), 25e18, "incoming shares do not allocate themselves");
    }

    function test_free_shares_transfer_leaves_positions_alone() public {
        _three();
        vote(ALICE, ID, 30e18);
        vm.prank(ALICE);
        shares.transfer(CAROL, 20e18);
        (uint96 yes,,,) = ledger.proposalSupport(ID);
        assertEq(yes, 30e18);
        assertEq(ledger.available(ALICE), 0);
    }

    function test_side_changes_move_the_whole_position() public {
        _three();
        vote(ALICE, ID, 50e18);
        vm.prank(ALICE);
        dao.castVote(ID, 0, 50e18);
        (uint96 yes, uint96 no,,) = ledger.proposalSupport(ID);
        assertEq(yes, 0);
        assertEq(no, 50e18);
    }

    function test_live_allocation_bound_and_terminal_pruning() public {
        for (uint256 id = 1; id <= 16; ++id) {
            vote(ALICE, id, 1e18);
        }
        vm.prank(ALICE);
        vm.expectRevert(AllocationVoting.TooManyAllocations.selector);
        dao.castVote(17, 1, 1e18);
        vm.warp(vm.getBlockTimestamp() + 14 days);
        vote(ALICE, 18, 100e18);
        assertEq(ledger.allocationsOf(ALICE).length, 1);
        assertEq(ledger.allocated(ALICE), 100e18);
    }

    function testFuzz_any_nonzero_remaining_supply_can_authorize(uint96 input) public {
        uint96 supply = uint96(bound(input, 1, 100e18));
        vm.prank(address(dao));
        shares.burnFromMoloch(ALICE, 100e18 - supply);
        vm.roll(block.number + 1);
        vote(ALICE, ID, supply);
        vm.warp(vm.getBlockTimestamp() + 48 hours);
        assertTrue(ledger.qualifies(ID), "even one Shares wei is a whole voting supply");
    }

    function testFuzz_withdraw_conserves_support(uint96 input, uint96 reduced) public {
        uint96 amount = uint96(bound(input, 1, 100e18));
        uint96 remaining = uint96(bound(reduced, 0, amount));
        vote(ALICE, ID, amount);
        vote(ALICE, ID, remaining);
        (uint96 raw,,,) = ledger.proposalSupport(ID);
        assertEq(raw, remaining);
        assertEq(ledger.available(ALICE), 100e18 - remaining);
    }

    // ---- opposition is free; backing is exclusive ---------------------------------------------

    function test_opposition_is_free_and_backing_is_exclusive() public {
        _three();
        vote(ALICE, 1, 30e18);
        vote(ALICE, 2, 20e18);
        assertEq(ledger.available(ALICE), 0, "all 50 back something");
        _castAgainst(ALICE, 3, 50e18);
        _castAgainst(ALICE, 4, 50e18);
        assertEq(ledger.allocated(ALICE), 50e18, "AGAINST adds nothing to what is committed");
        assertEq(ledger.available(ALICE), 0);
        vm.prank(ALICE);
        vm.expectRevert(AllocationVoting.InsufficientShares.selector);
        dao.castVote(5, 1, 1);
        (, uint96 no3,,) = ledger.proposalSupport(3);
        (, uint96 no4,,) = ledger.proposalSupport(4);
        assertEq(no3, 50e18);
        assertEq(no4, 50e18);
    }

    function test_a_majority_busy_with_its_priorities_can_still_block_a_minority() public {
        _three();
        // CAROL (20%) alone would clear the 20% quorum with 100% approval ...
        vote(CAROL, 9, 20e18);
        assertTrue(ledger.thresholdsMet(9));
        // ... but ALICE and BOB, each fully committed to something else, still oppose it at full weight.
        vote(ALICE, 1, 50e18);
        vote(BOB, 2, 30e18);
        _castAgainst(ALICE, 9, 50e18);
        assertFalse(ledger.thresholdsMet(9), "20 FOR against 50 AGAINST");
    }

    function test_moving_to_against_frees_the_backing() public {
        _three();
        vote(ALICE, 1, 50e18);
        assertEq(ledger.available(ALICE), 0);
        _castAgainst(ALICE, 1, 50e18);
        assertEq(ledger.available(ALICE), 50e18);
        vote(ALICE, 2, 50e18);
        assertEq(ledger.available(ALICE), 0);
    }

    function test_leaving_shares_caps_opposition_at_the_balance() public {
        _three();
        _castAgainst(ALICE, 1, 50e18);
        _castAgainst(ALICE, 2, 50e18);
        vm.prank(ALICE);
        shares.transfer(address(0xD00D), 30e18);
        (, uint96 first,,) = ledger.proposalSupport(1);
        (, uint96 second,,) = ledger.proposalSupport(2);
        assertEq(first, 20e18, "capped at the 20 ALICE still holds");
        assertEq(second, 20e18);
    }

    // ---- a lane that is not exclusive -----------------------------------------------------------

    function test_a_reusable_lane_lets_the_same_shares_back_every_proposal() public {
        _three();
        vm.prank(address(dao));
        ledger.setLane(false, 2000, 6600, 48 hours, 12 hours, false);
        vote(ALICE, 1, 50e18);
        vote(ALICE, 2, 50e18);
        vote(ALICE, 3, 50e18);
        assertEq(ledger.allocated(ALICE), 0, "nothing is drawn from a single pool in this lane");
        assertEq(ledger.available(ALICE), 50e18);
        (uint96 a,,,) = ledger.proposalSupport(1);
        (uint96 b,,,) = ledger.proposalSupport(2);
        assertEq(a, 50e18);
        assertEq(b, 50e18);
    }

    function test_the_lane_is_frozen_at_opening_so_an_open_proposal_keeps_its_rule() public {
        _three();
        vote(ALICE, 1, 50e18); // opened while the lane is exclusive
        vm.prank(address(dao));
        ledger.setLane(false, 2000, 6600, 48 hours, 12 hours, false);
        vote(ALICE, 2, 50e18); // a new proposal in the now-reusable lane
        assertEq(ledger.allocated(ALICE), 50e18, "only the exclusive one counts");
        assertTrue(_rules(1).exclusive);
        assertFalse(_rules(2).exclusive);
    }

    function test_leaving_shares_trims_reusable_backing_to_the_balance_too() public {
        _three();
        vm.prank(address(dao));
        ledger.setLane(false, 2000, 6600, 48 hours, 12 hours, false);
        vote(ALICE, 1, 50e18);
        vote(ALICE, 2, 50e18);
        vm.prank(ALICE);
        shares.transfer(address(0xD00D), 30e18);
        (uint96 a,,,) = ledger.proposalSupport(1);
        (uint96 b,,,) = ledger.proposalSupport(2);
        assertEq(a, 20e18);
        assertEq(b, 20e18);
    }

    function _rules(uint256 id) internal view returns (AllocationVoting.Rules memory r) {
        (r.votingSupply, r.quorum, r.minYes, r.approvalBps, r.reviewEndsAt, r.expiresAt, r.delay, r.hold, r.bounded, r.exclusive) =
            ledger.proposals(id);
    }
}
