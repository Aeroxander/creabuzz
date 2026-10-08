// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {VotingFixture} from "./helpers/VotingFixture.sol";
import {ConvictionVoting} from "../src/ConvictionVoting.sol";
import {Moloch} from "../src/majeur/MolochPatched.sol";

contract ConvictionVotingTest is VotingFixture {
    function test_historical_opposition_does_not_entrench_a_minority() public {
        vm.prank(ALICE);
        shares.transfer(BOB, 49.9e18);
        vm.roll(block.number + 1);
        vm.prank(BOB);
        dao.castVote(1, 0, 49.9e18);
        vm.warp(vm.getBlockTimestamp() + 48 hours);
        vote(ALICE, 1, 50.1e18);
        assertFalse(ledger.qualifies(1), "new FOR support still needs conviction");
        vm.warp(vm.getBlockTimestamp() + 12 hours);
        (,,, uint192 yes, uint192 no,) = ledger.proposalSupport(1);
        assertLt(yes, no, "opposition is older");
        assertTrue(ledger.qualifies(1), "current majority and sustained FOR satisfy approval");
    }

    function test_one_wei_supply_retains_fractional_conviction() public {
        vm.prank(address(dao));
        shares.burnFromMoloch(ALICE, 100e18 - 1);
        vm.roll(block.number + 1);
        vm.prank(ALICE);
        dao.openProposal(1);
        vm.warp(vm.getBlockTimestamp() + 48 hours);
        vote(ALICE, 1, 1);
        assertFalse(ledger.qualifies(1));
        vm.warp(vm.getBlockTimestamp() + 6 hours);
        assertTrue(ledger.qualifies(1), "conviction smaller than a Shares wei must still count");
    }

    function test_twelve_hour_half_life_matches_formula() public {
        vote(ALICE, 1, 100e18);
        vm.warp(vm.getBlockTimestamp() + 12 hours);
        (uint96 raw,,, uint192 mature,,) = ledger.proposalSupport(1);
        assertEq(raw, 100e18);
        assertApproxEqAbs(mature, 50e18 * 1e18, 5e24);
        vm.warp(vm.getBlockTimestamp() + 12 hours);
        (,,, mature,,) = ledger.proposalSupport(1);
        assertApproxEqAbs(mature, 75e18 * 1e18, 5e24);
    }

    function test_recast_does_not_reset_preserved_conviction_new_stake_starts_zero() public {
        vote(ALICE, 1, 50e18);
        vm.warp(vm.getBlockTimestamp() + 12 hours);
        vote(ALICE, 1, 100e18);
        (,,, uint192 mature,,) = ledger.proposalSupport(1);
        assertApproxEqAbs(mature, 25e18 * 1e18, 5e24);
        vm.warp(vm.getBlockTimestamp() + 12 hours);
        (,,, mature,,) = ledger.proposalSupport(1);
        assertApproxEqAbs(mature, 62.5e18 * 1e18, 5e24);
        vote(ALICE, 1, 20e18);
        (uint96 raw,,, uint192 reduced,,) = ledger.proposalSupport(1);
        assertEq(raw, 20e18);
        assertApproxEqAbs(reduced, 12.5e36, 5e24);
        vote(ALICE, 1, 0);
        (raw,,, reduced,,) = ledger.proposalSupport(1);
        assertEq(raw, 0);
        assertEq(reduced, 0);
        vote(ALICE, 2, 100e18);
        (,,, mature,,) = ledger.proposalSupport(2);
        assertEq(mature, 0, "old conviction cannot migrate to a new proposal");
    }

    function test_side_changes_clear_conviction() public {
        vote(ALICE, 1, 100e18);
        vm.warp(vm.getBlockTimestamp() + 2 days);
        vm.prank(ALICE);
        dao.castVote(1, 0, 100e18);
        (uint96 yes, uint96 no,, uint192 cy, uint192 cn,) = ledger.proposalSupport(1);
        assertEq(yes, 0);
        assertEq(no, 100e18);
        assertEq(cy, 0);
        assertEq(cn, 0);
        assertFalse(ledger.qualifies(1));
    }

    function test_half_supply_cannot_authorize_unrestricted_action() public {
        vote(ALICE, 1, 50e18);
        vm.warp(vm.getBlockTimestamp() + 10 days);
        assertFalse(ledger.qualifies(1));
        vote(ALICE, 1, 50e18 + 1);
        assertTrue(ledger.qualifies(1));
    }

    function test_transfers_trim_only_overallocation_and_reset_queue() public {
        vote(ALICE, 1, 60e18);
        vote(ALICE, 2, 40e18);
        vm.warp(vm.getBlockTimestamp() + 2 days);
        dao.queue(1);
        vm.prank(ALICE);
        shares.transfer(CAROL, 50e18);
        (uint96 first,,,,,) = ledger.proposalSupport(1);
        (uint96 second,,,,,) = ledger.proposalSupport(2);
        assertEq(first, 30e18);
        assertEq(second, 20e18);
        assertEq(dao.queuedAt(1), 0);
        assertEq(ledger.available(CAROL), 50e18);
        assertEq(ledger.allocated(ALICE), 50e18);
        vm.prank(CAROL);
        shares.transfer(ALICE, 20e18);
        assertEq(ledger.allocated(ALICE), 50e18, "incoming shares do not mature or allocate automatically");
    }

    function test_free_shares_transfer_does_not_destroy_conviction() public {
        vote(ALICE, 1, 60e18);
        vm.warp(vm.getBlockTimestamp() + 2 days);
        (,,, uint192 before,,) = ledger.proposalSupport(1);
        vm.prank(ALICE);
        shares.transfer(CAROL, 20e18);
        (uint96 yes,,, uint192 after_,,) = ledger.proposalSupport(1);
        assertEq(yes, 60e18);
        assertEq(after_, before);
        assertEq(ledger.available(ALICE), 20e18);
    }

    function test_live_allocation_bound_and_terminal_pruning() public {
        for (uint256 id = 1; id <= 16; ++id) {
            vote(ALICE, id, 1e18);
        }
        vm.prank(ALICE);
        vm.expectRevert(ConvictionVoting.TooManyAllocations.selector);
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
        vote(ALICE, 1, supply);
        vm.warp(vm.getBlockTimestamp() + 48 hours);
        assertTrue(ledger.qualifies(1), "fractional conviction must work even with one Shares wei");
    }

    function testFuzz_withdraw_conserves_raw_and_mature(uint96 input, uint32 elapsed, uint96 reduced) public {
        uint96 amount = uint96(bound(input, 1, 100e18));
        uint96 remaining = uint96(bound(reduced, 0, amount));
        vote(ALICE, 1, amount);
        vm.warp(vm.getBlockTimestamp() + bound(elapsed, 0, 13 days));
        (,,, uint192 before,,) = ledger.proposalSupport(1);
        vote(ALICE, 1, remaining);
        (uint96 raw,,, uint192 after_,,) = ledger.proposalSupport(1);
        assertEq(raw, remaining);
        assertLe(after_, uint256(raw) * 1e18);
        assertApproxEqAbs(after_, uint256(before) * remaining / amount, 2);
        assertEq(ledger.available(ALICE), 100e18 - remaining);
    }
}
