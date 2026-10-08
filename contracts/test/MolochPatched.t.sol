// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {VotingFixture} from "./helpers/VotingFixture.sol";
import {Moloch, Loot} from "../src/majeur/MolochPatched.sol";
import {AllocationVoting} from "../src/AllocationVoting.sol";

contract MolochPatchedTest is VotingFixture {
    function test_one_path_uses_exclusive_movable_allocations() public {
        vote(ALICE, 1, 70e18);
        vm.prank(ALICE);
        dao.castVote(2, 1);
        assertEq(ledger.available(ALICE), 0);
        (uint96 yes,,,) = dao.proposalSupport(2);
        assertEq(yes, 30e18);
        vm.prank(ALICE);
        vm.expectRevert(AllocationVoting.InsufficientShares.selector);
        dao.castVote(3, 1, 1);
        assertEq(dao.createdAt(3), 0, "failed allocation also rolls back open");
        vote(ALICE, 1, 20e18);
        vote(ALICE, 2, 80e18);
        assertEq(ledger.available(ALICE), 0);
        vm.prank(ALICE);
        dao.cancelVote(1);
        assertEq(ledger.available(ALICE), 20e18);
    }

    function test_only_shares_vote_and_loot_is_economic() public {
        vm.prank(BOB);
        vm.expectRevert(bytes4(keccak256("Unauthorized()")));
        dao.openProposal(1);
        vote(ALICE, 1, 60e18);
        vm.prank(BOB);
        vm.expectRevert(AllocationVoting.InsufficientShares.selector);
        dao.castVote(1, 1, 1);
        assertEq(dao.supplySnapshot(1), 100e18);
        assertEq(ledger.capacity(BOB), 0);
        assertEq(loot.balanceOf(BOB), 100e18);
    }

    function test_approved_conversion_earns_standing_on_future_snapshots() public {
        bytes memory data = abi.encodeCall(Moloch.convertLootToShares, (BOB, uint96(100e18)));
        bytes32 nonce = keccak256("verified contribution");
        uint256 id = dao.proposalId(0, address(dao), 0, data, nonce);
        vote(ALICE, id, 100e18);
        vm.warp(vm.getBlockTimestamp() + 48 hours);
        dao.queue(id);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        dao.executeByVotes(0, address(dao), 0, data, nonce);
        assertTrue(dao.executed(id));
        assertEq(loot.balanceOf(BOB), 0);
        assertEq(shares.balanceOf(BOB), 100e18);
        assertEq(ledger.available(BOB), 100e18);
        assertEq(ledger.totalCapacity(), 200e18);
        assertEq(ledger.available(ALICE), 100e18, "executed allocation releases");
        (uint256 free, uint256 owned, uint256 eligible, uint96 allocated,,) = dao.votingAllocationFor(id, ALICE);
        assertEq(free, owned);
        assertEq(eligible, 0);
        assertEq(allocated, 0);
        vm.roll(block.number + 1);
        vote(BOB, 2, 100e18);
    }

    function test_review_and_timelock_support_stays_movable() public {
        bytes memory data = abi.encodeCall(Moloch.setQuorumBps, (uint16(600)));
        bytes32 nonce = bytes32("rules");
        uint256 id = dao.proposalId(0, address(dao), 0, data, nonce);
        vote(ALICE, id, 100e18);
        vm.expectRevert(Moloch.NotOk.selector);
        dao.executeByVotes(0, address(dao), 0, data, nonce);
        vm.warp(vm.getBlockTimestamp() + 48 hours);
        dao.queue(id);
        assertEq(uint256(dao.state(id)), uint256(Moloch.ProposalState.Queued));
        vm.warp(vm.getBlockTimestamp() + 23 hours);
        vote(ALICE, id, 0);
        assertEq(dao.queuedAt(id), 0);
        vote(ALICE, id, 100e18);
        vm.expectRevert(Moloch.NotOk.selector);
        dao.executeByVotes(0, address(dao), 0, data, nonce);
        vm.warp(vm.getBlockTimestamp() + 12 hours);
        dao.queue(id);
        vm.expectRevert();
        dao.executeByVotes(0, address(dao), 0, data, nonce);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        dao.executeByVotes(0, address(dao), 0, data, nonce);
        assertEq(dao.quorumBps(), 600);
    }

    function test_rules_are_captured_and_expiry_releases_queued_allocations() public {
        vote(ALICE, 1, 100e18);
        (
            uint96 votingSupply,
            uint96 quorum,
            uint96 minYes,
            uint16 approvalBps,
            uint64 notice,
            uint64 expires,
            uint64 delay,
            uint64 hold,
            bool bounded,
            bool exclusive
        ) = dao.proposalVotingRules(1);
        assertEq(votingSupply, 100e18);
        assertEq(quorum, 50e18, "the governor's own 50% quorum beats the 20% lane quorum");
        assertEq(minYes, 0);
        assertEq(approvalBps, 6600);
        assertEq(notice, vm.getBlockTimestamp() + 48 hours);
        assertEq(expires, vm.getBlockTimestamp() + 14 days);
        assertEq(delay, 1 days);
        assertEq(hold, 12 hours);
        assertFalse(bounded);
        assertTrue(exclusive, "treasury-scale proposals draw from one pool of Shares");
        vm.prank(address(dao));
        dao.setQuorumBps(10_000);
        vm.prank(address(dao));
        dao.setTimelockDelay(2 days);
        vm.warp(vm.getBlockTimestamp() + 48 hours);
        dao.queue(1);
        vm.warp(expires);
        assertEq(uint256(dao.state(1)), uint256(Moloch.ProposalState.Expired));
        assertEq(ledger.available(ALICE), 100e18);
        vm.prank(ALICE);
        vm.expectRevert(AllocationVoting.InvalidProposal.selector);
        dao.castVote(1, 1, 100e18);
    }

    function test_shares_the_dao_holds_itself_do_not_dilute_an_exit() public {
        vm.prank(address(dao));
        shares.mintFromMoloch(address(dao), 100e18); // 100 of the DAO's own beside ALICE's 100
        vm.deal(address(dao), 100 ether);
        address[] memory assets = new address[](1);
        assets[0] = address(0);
        vm.prank(ALICE);
        dao.ragequit(assets, 50e18, 0);
        // Members hold 200 units (ALICE's 100 Shares and BOB's 100 Loot); the DAO's own 100 Shares are nobody's.
        // Burning 50 of the 200 pays a quarter of the 100 ether. (Counting the DAO's 100 in the total, 300, would
        // have paid her 16.67.)
        assertEq(ALICE.balance, 25 ether);
    }

    function test_snapshots_exclude_new_shares() public {
        vm.prank(ALICE);
        dao.openProposal(1);
        vm.prank(ALICE);
        shares.transfer(CAROL, 50e18);
        vm.prank(CAROL);
        vm.expectRevert(AllocationVoting.InsufficientShares.selector);
        dao.castVote(1, 1, 1e18);
        vm.roll(block.number + 1);
        vote(CAROL, 2, 50e18);
    }

    function test_all_in_does_not_prevent_new_proposals_or_exit() public {
        vote(ALICE, 1, 100e18);
        vm.prank(ALICE);
        dao.openProposal(2);
        vm.deal(address(dao), 100 ether);
        address[] memory assets = new address[](1);
        assets[0] = address(0);
        vm.prank(ALICE);
        dao.ragequit(assets, 100e18, 0);
        assertEq(ALICE.balance, 50 ether, "Loot retains the other half of economic rights");
        assertEq(ledger.totalCapacity(), 0);
        assertEq(ledger.available(ALICE), 0);
        (uint96 yes,,,) = dao.proposalSupport(1);
        assertEq(yes, 0);
    }

    function test_no_futarchy_policy_or_delegatecall_bypass() public {
        vm.expectRevert(Moloch.NotOk.selector);
        dao.fundFutarchy(1, address(0), 1);
        // The voting policy cannot be swapped: there is no entry point to try (the old stub only reverted).
        (bool swapped,) = address(dao).call(abi.encodeWithSignature("setVotingWeight(address)", address(1)));
        assertFalse(swapped);
        vm.prank(address(dao));
        vm.expectRevert(Moloch.NotOk.selector);
        dao.setAutoFutarchy(1, 0);
        bytes memory data = abi.encodeCall(Moloch.setQuorumBps, (uint16(1)));
        uint256 id = dao.proposalId(1, address(dao), 0, data, bytes32(0));
        vote(ALICE, id, 100e18);
        vm.warp(vm.getBlockTimestamp() + 48 hours);
        dao.queue(id);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        vm.expectRevert(Moloch.NotOk.selector);
        dao.executeByVotes(1, address(dao), 0, data, bytes32(0));
        assertFalse(dao.executed(id));
    }
}
