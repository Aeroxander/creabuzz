// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {VotingFixture} from "./helpers/VotingFixture.sol";
import {AllocationVoting} from "../src/AllocationVoting.sol";

contract VotingWeightTest is VotingFixture {
    function test_preview_has_no_second_native_tally_or_debit() public {
        vote(ALICE, 1, 70e18);
        uint48 snap = uint48(block.number - 1);
        assertEq(dao.weightFor(2, ALICE, snap), 30e18);
        assertEq(dao.weightFor(2, ALICE, snap), 30e18);
        assertEq(shares.getPastVotes(ALICE, snap), 100e18);
        assertEq(ledger.available(ALICE), 30e18);
        assertEq(dao.weightFor(1, ALICE, snap), 100e18, "existing allocation may be replaced");
        (uint96 yes,,) = dao.tallies(1);
        assertEq(yes, 70e18, "the one tally is the allocation itself; the native checkpoint vote is not a second ballot");
    }

    function test_delegate_uses_owner_allocations_owner_can_override() public {
        vm.prank(ALICE);
        shares.delegate(CAROL);
        vm.prank(CAROL);
        dao.castVoteFor(ALICE, 1, 1, 60e18);
        assertEq(ledger.available(ALICE), 40e18);
        assertEq(ledger.available(CAROL), 0);
        vm.prank(ALICE);
        dao.castVote(1, 0, 40e18);
        assertEq(ledger.available(ALICE), 100e18, "moving to AGAINST releases the backing: opposition is free");
        vm.prank(CAROL);
        vm.expectRevert(bytes4(keccak256("Unauthorized()")));
        dao.castVote(2, 1);
    }

    function test_redelegation_revokes_old_authority_without_reset() public {
        vote(ALICE, 1, 70e18);
        vm.prank(ALICE);
        shares.delegate(CAROL);
        vm.prank(ALICE);
        shares.delegate(BOB);
        vm.prank(CAROL);
        vm.expectRevert(AllocationVoting.Unauthorized.selector);
        dao.castVoteFor(ALICE, 2, 1, 30e18);
        vm.prank(BOB);
        dao.castVoteFor(ALICE, 2, 1, 30e18);
        assertEq(ledger.available(ALICE), 0);
        assertEq(ledger.capacity(BOB), 0, "delegate does not own the source's Shares");
    }

    function test_loot_delegation_does_not_create_votes() public {
        vote(ALICE, 1, 1e18);
        vm.prank(BOB);
        shares.delegate(CAROL);
        vm.prank(CAROL);
        vm.expectRevert(AllocationVoting.InsufficientShares.selector);
        dao.castVoteFor(BOB, 1, 1, 1e18);
    }

    function test_callbacks_and_mutations_are_authenticated() public {
        vm.expectRevert(AllocationVoting.Unauthorized.selector);
        ledger.allocateWeight(bytes32(uint256(1)), ALICE, ALICE, uint48(block.number - 1), 1, 1);
        vm.expectRevert(AllocationVoting.Unauthorized.selector);
        ledger.ownershipChanged(false, ALICE, CAROL, 1);
        vm.expectRevert(bytes4(keccak256("Unauthorized()")));
        dao.onOwnershipChanged(ALICE, CAROL, 1);
        vm.expectRevert(bytes4(keccak256("Unauthorized()")));
        dao.onVotingDelegateChanged(ALICE, CAROL);
        vm.expectRevert(bytes4(keccak256("Unauthorized()")));
        dao.convertLootToShares(BOB, 10e18);
        vm.expectRevert(bytes4(keccak256("Unauthorized()")));
        dao.resetApprovalQueue(1);
    }

    function test_self_calls_cannot_fabricate_ballots_or_balances() public {
        vm.prank(address(dao));
        vm.expectRevert(AllocationVoting.Unauthorized.selector);
        ledger.allocateWeight(bytes32(uint256(1)), ALICE, ALICE, uint48(block.number - 1), 1, 1);
        vm.prank(address(dao));
        vm.expectRevert(AllocationVoting.CapacityExceeded.selector);
        ledger.ownershipChanged(false, address(0), ALICE, 1);
        vm.prank(address(dao));
        vm.expectRevert(AllocationVoting.Unauthorized.selector);
        ledger.setDelegate(ALICE, CAROL);
        assertEq(ledger.capacity(ALICE), shares.balanceOf(ALICE));
    }
}
