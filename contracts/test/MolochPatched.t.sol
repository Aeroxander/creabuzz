// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Call, Moloch, Summoner} from "../src/majeur/MolochPatched.sol";
import {VotingWeight, ISnapshotVotes, IBackingWeight} from "../src/VotingWeight.sol";
import {IConvictionWeight} from "../src/ConvictionVoting.sol";

/// @dev A backing source whose answers are set by the test.
contract MockBacking is IBackingWeight {
    mapping(bytes32 => mapping(address => uint256)) public weight;
    mapping(address => uint256) public risk;

    function setWeight(bytes32 proposalId, address who, uint256 amount) external {
        weight[proposalId][who] = amount;
    }

    function setRisk(address who, uint256 amount) external {
        risk[who] = amount;
    }

    function backingWeightAt(bytes32 proposalId, address backer, uint48)
        external
        view
        returns (uint256)
    {
        return weight[proposalId][backer];
    }

    function tokensAtRisk(address backer) external view returns (uint256) {
        return risk[backer];
    }
}

/// @dev The Majeur fork's own seams, bound to `VotingWeight`
/// (docs/token-voting-design.md §7). What `Moloch.vote()` reads is decided by
/// `weightFor`, and `ragequit` refuses to let a backer leave while their
/// capital is still behind a proposal that has not resolved.
contract MolochPatchedTest is Test {
    address constant ALICE = address(0xA11CE);
    bytes32 constant PROPOSAL = keccak256("a-proposal");

    Moloch dao;
    MockBacking backing;
    VotingWeight weight;

    function setUp() public {
        Summoner summoner = new Summoner();

        address[] memory holders = new address[](1);
        holders[0] = ALICE;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 100e18;
        Call[] memory calls = new Call[](0);

        dao = summoner.summon(
            "Org", "ORG", "", 5000, true, address(0), bytes32(0), holders, amounts, calls
        );

        backing = new MockBacking();
        weight = new VotingWeight(
            ISnapshotVotes(address(dao.shares())),
            ISnapshotVotes(address(dao.loot())),
            IBackingWeight(address(backing)),
            IConvictionWeight(address(0))
        );

        // `onlyDAO` is `msg.sender == address(this)`, so only the DAO itself
        // can bind the seam — exactly as it will be via a proposal.
        vm.prank(address(dao));
        dao.setVotingWeight(address(weight));
    }

    function test_the_seam_decides_the_weight() public {
        backing.setWeight(PROPOSAL, ALICE, 700);
        vm.roll(block.number + 1);

        uint48 snap = uint48(block.number - 1);
        // Alice holds 100e18 shares (no delegation, so that is her work weight)
        // and the seam adds 700 of backing.
        assertEq(dao.weightFor(uint256(PROPOSAL), ALICE, snap), 100e18 + 700);
    }

    function test_backing_weight_is_per_proposal_at_the_seam() public {
        backing.setWeight(PROPOSAL, ALICE, 700);
        vm.roll(block.number + 1);
        uint48 snap = uint48(block.number - 1);
        assertEq(dao.weightFor(uint256(keccak256("other")), ALICE, snap), 100e18);
    }

    function test_without_a_seam_the_weight_is_shares_alone() public {
        Summoner summoner = new Summoner();
        address[] memory holders = new address[](1);
        holders[0] = ALICE;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 5e18;
        Call[] memory calls = new Call[](0);
        Moloch bare = summoner.summon(
            "Bare", "BARE", "", 5000, true, address(0), bytes32(0), holders, amounts, calls
        );
        vm.roll(block.number + 1);
        assertEq(bare.weightFor(uint256(PROPOSAL), ALICE, uint48(block.number - 1)), 5e18);
    }

    function test_the_seam_is_bound_once_only() public {
        vm.prank(address(dao));
        vm.expectRevert();
        dao.setVotingWeight(address(0xBAD));
        assertEq(dao.votingWeight(), address(weight));
    }

    function test_ragequit_is_refused_while_capital_is_at_risk() public {
        backing.setRisk(ALICE, 1);

        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(Moloch.StillAtRisk.selector, 1));
        dao.ragequit(new address[](0), 1e18, 0);
    }

    function test_ragequit_is_allowed_once_nothing_is_at_risk() public {
        backing.setRisk(ALICE, 0);
        // The gate is passed: the call gets as far as the token list check and
        // stops there, rather than being turned away by the exit gate.
        vm.prank(ALICE);
        vm.expectRevert(Moloch.LengthMismatch.selector);
        dao.ragequit(new address[](0), 1e18, 0);
    }
}
