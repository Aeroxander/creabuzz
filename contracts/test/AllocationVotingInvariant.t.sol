// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {VotingFixture} from "./helpers/VotingFixture.sol";
import {Moloch, Shares} from "../src/majeur/MolochPatched.sol";
import {AllocationVoting} from "../src/AllocationVoting.sol";

contract AllocationHandler is Test {
    Moloch public dao;
    AllocationVoting public policy;
    Shares public shares;
    address[3] public actors;
    uint256[8] public ids;
    uint256 private nextId = 9;
    uint256 public allocationsChanged;
    uint256 public transfers;
    uint256 public failedQueues;

    constructor(Moloch governor, address a, address b, address c) {
        dao = governor;
        policy = AllocationVoting(governor.votingWeight());
        shares = governor.shares();
        actors = [a, b, c];
        for (uint256 i; i < 8; ++i) {
            ids[i] = i + 1;
        }
    }

    function allocate(uint256 actorSeed, uint256 slot, uint256 amountSeed, uint8 side) external {
        address owner = actors[actorSeed % 3];
        if (policy.capacity(owner) == 0) return;
        slot %= 8;
        uint256 id = ids[slot];
        Moloch.ProposalState state = dao.state(id);
        if (state == Moloch.ProposalState.Expired || state == Moloch.ProposalState.Executed) ids[slot] = id = nextId++;
        (,, uint256 eligible, uint96 current,, uint256 opposable) = dao.votingAllocationFor(id, owner);
        uint256 amount = amountSeed % ((side % 3 == 0 ? opposable : eligible) + 1);
        if (amount == 0 && current == 0) return;
        vm.prank(owner);
        dao.castVote(id, side % 3, amount);
        allocationsChanged++;
    }

    function transfer(uint256 fromSeed, uint256 toSeed, uint256 amountSeed) external {
        address from = actors[fromSeed % 3];
        address to = actors[toSeed % 3];
        if (from == to) return;
        uint256 amount = amountSeed % (shares.balanceOf(from) + 1);
        vm.prank(from);
        shares.transfer(to, amount);
        transfers++;
        vm.roll(block.number + 1);
    }

    function delegate(uint256 ownerSeed, uint256 delegateSeed) external {
        vm.prank(actors[ownerSeed % 3]);
        shares.delegate(actors[delegateSeed % 3]);
    }

    function elapse(uint32 seconds_) external {
        vm.warp(vm.getBlockTimestamp() + bound(seconds_, 1, 12 hours));
        vm.roll(block.number + 1);
    }

    function queue(uint256 slot) external {
        uint256 id = ids[slot % 8];
        if (dao.state(id) != Moloch.ProposalState.Succeeded) failedQueues++;
        return;
        dao.queue(id);
    }
}

contract AllocationVotingInvariantTest is VotingFixture {
    AllocationHandler internal handler;

    function setUp() public override {
        super.setUp();
        vm.prank(ALICE);
        shares.transfer(BOB, 40e18);
        vm.roll(block.number + 1);
        handler = new AllocationHandler(dao, ALICE, BOB, CAROL);
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = handler.allocate.selector;
        selectors[1] = handler.transfer.selector;
        selectors[2] = handler.delegate.selector;
        selectors[3] = handler.elapse.selector;
        selectors[4] = handler.queue.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    function invariant_owned_capacity_and_exclusive_allocations_are_conserved() public view {
        uint256 sum;
        for (uint256 a; a < 3; ++a) {
            address owner = handler.actors(a);
            uint256 owned = shares.balanceOf(owner);
            assertEq(ledger.capacity(owner), owned);
            assertLe(ledger.allocated(owner), owned);
            assertEq(ledger.available(owner) + ledger.allocated(owner), owned);
            uint256[] memory live = ledger.allocationsOf(owner);
            for (uint256 k; k < live.length; ++k) {
                (uint96 amount, uint8 side) = ledger.positions(live[k], owner);
                if (side == 0) assertLe(amount, owned, "opposition can never exceed what is owned");
            }
            assertLe(ledger.allocationsOf(owner).length, 16);
            sum += owned;
        }
        assertEq(sum, shares.totalSupply());
        assertEq(ledger.totalCapacity(), sum);
    }

    function invariant_support_matches_positions_and_the_hold_clock_matches_the_bars() public view {
        for (uint256 i; i < 8; ++i) {
            uint256 id = handler.ids(i);
            (uint96 yes, uint96 no, uint96 abstain, uint64 since) = ledger.proposalSupport(id);
            uint256[3] memory sums;
            for (uint256 a; a < 3; ++a) {
                (uint96 amount, uint8 side) = ledger.positions(id, handler.actors(a));
                sums[side] += amount;
            }
            assertEq(yes, sums[1]);
            assertEq(no, sums[0]);
            assertEq(abstain, sums[2]);
            // The hold clock runs exactly while quorum and approval hold.
            assertEq(since != 0, ledger.thresholdsMet(id), "qualifiedSince is set iff the bars hold");
            assertLe(uint256(yes) + no + abstain, 100e18);
            if (dao.queuedAt(id) != 0 && dao.state(id) != Moloch.ProposalState.Expired) assertTrue(ledger.qualifies(id));
        }
    }
}
