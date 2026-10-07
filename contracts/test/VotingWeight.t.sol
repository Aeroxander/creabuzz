// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {VotingWeight, ISnapshotVotes, IBackingWeight} from "../src/VotingWeight.sol";
import {ConvictionVoting, IConvictionWeight} from "../src/ConvictionVoting.sol";
import {ProposalVault, IJoinPrice} from "../src/ProposalVault.sol";
import {MockCurrency, MockToken, MockJoinPrice} from "./ProposalVault.t.sol";

/// @dev A token whose checkpointed votes are set by hand.
contract MockVotes is ISnapshotVotes {
    mapping(address => uint256) public votes;

    function set(address who, uint256 amount) external {
        votes[who] = amount;
    }

    function getPastVotes(address account, uint48) external view returns (uint256) {
        return votes[account];
    }
}

/// @dev Binds the weight seam to the real `ProposalVault`, not a stand-in
/// (Review-Proven Rule 3): what `weightFor` and `mayExit` report must be what
/// the vault's own accounting says.
contract VotingWeightTest is Test {
    MockVotes shares;
    MockVotes loot;
    MockCurrency currency;
    MockToken token;
    MockJoinPrice pricing;
    ProposalVault vault;
    VotingWeight weight;

    address constant GOVERNANCE = address(0xBEEF);
    address constant TREASURY = address(0xFEE);
    address constant ALICE = address(0xA11CE);
    bytes32 constant P1 = keccak256("proposal-1");
    bytes32 constant P2 = keccak256("proposal-2");
    bytes32 constant CHECK = keccak256("ships v1 and the tests pass");

    function setUp() public {
        shares = new MockVotes();
        loot = new MockVotes();
        currency = new MockCurrency();
        token = new MockToken();
        pricing = new MockJoinPrice();

        vault = new ProposalVault(
            address(currency),
            address(token),
            TREASURY,
            GOVERNANCE,
            IJoinPrice(address(pricing)),
            1000,
            500
        );
        token.setMinter(address(vault));
        weight = new VotingWeight(
            shares,
            loot,
            IBackingWeight(address(vault)),
            IConvictionWeight(address(0))
        );

        currency.mint(ALICE, 1_000_000);
        vm.prank(ALICE);
        currency.approve(address(vault), type(uint256).max);
        pricing.set(2, 1);
    }

    function test_weight_is_work_plus_held_plus_backing() public {
        _back(P1, 1_000); // 475 tokens escrowed, weight 475 at the block it began
        shares.set(ALICE, 30); // verified work
        loot.set(ALICE, 7); // plain holding

        uint48 at = uint48(block.number);
        // The snapshot must be at-or-after the backing block for it to count.
        assertEq(weight.weightFor(P1, ALICE, at), 30 + 7 + 475e18);
    }

    function test_backing_buys_voice_only_on_the_proposal_it_backed() public {
        _back(P1, 1_000);
        uint48 at = uint48(block.number);
        assertGt(weight.weightFor(P1, ALICE, at), 0);
        assertEq(weight.weightFor(P2, ALICE, at), 0, "capital directed at one decision buys no voice on another");
    }

    function test_parked_capital_earns_nothing() public {
        // Alice holds a lot and has done nothing with it.
        loot.set(ALICE, 1_000_000e18);
        uint48 at = uint48(block.number);
        assertEq(weight.weightFor(P1, ALICE, at), 1_000_000e18);
    }

    function test_the_exit_gate_is_held_open_once_the_risk_resolves() public {
        _back(P1, 1_000);
        _back(P2, 1_000);

        (bool may, uint256 atRisk) = weight.mayExit(ALICE);
        assertEq(may, false);
        assertEq(atRisk, 950e18);

        vm.prank(GOVERNANCE);
        vault.verify(P1);
        (may, atRisk) = weight.mayExit(ALICE);
        assertEq(may, false, "P2 is still at risk");
        assertEq(atRisk, 475e18);

        vm.prank(GOVERNANCE);
        vault.fail(P2);
        (may, atRisk) = weight.mayExit(ALICE);
        assertEq(may, true);
        assertEq(atRisk, 0);
    }

    function test_an_account_that_never_backed_anything_may_always_exit() public {
        (bool may, uint256 atRisk) = weight.mayExit(ALICE);
        assertEq(may, true);
        assertEq(atRisk, 0);
    }

    function _back(bytes32 proposalId, uint256 amount) internal {
        vm.prank(GOVERNANCE);
        vault.openProposal(proposalId, 100, 10_000, uint64(block.number + 100), CHECK);
        vm.startPrank(ALICE);
        vault.pledge(amount);
        vault.back(proposalId, amount);
        vm.stopPrank();
    }

    /// @dev Binds the conviction term to the real `ConvictionVoting`, not a
    /// stand-in (Review-Proven Rule 3): what `weightFor` adds must be what the
    /// conviction contract's own accounting says, at the snapshot block.
    function test_the_conviction_term_sums_into_weight_at_the_snapshot() public {
        ConvictionVoting conviction =
            new ConvictionVoting(address(this), 0.99e18, 0.02e18, 0.2e18, 0);
        VotingWeight wired = new VotingWeight(
            shares,
            loot,
            IBackingWeight(address(vault)),
            IConvictionWeight(address(conviction))
        );
        shares.set(ALICE, 7);
        loot.set(ALICE, 3);

        // This test contract is the conviction module's governance.
        conviction.grantSeat(ALICE);
        conviction.refill(ALICE, 50);
        conviction.openProposal(P1, 0);
        vm.prank(ALICE);
        conviction.stake(P1, 50);

        vm.roll(51);
        uint48 snap = 51;
        uint256 expected = 7 + 3 + conviction.convictionWeightAt(P1, ALICE, snap);
        assertEq(wired.weightFor(P1, ALICE, snap), expected);
        assertGt(expected, 10, "the credits are actually working");

        // A stake after the snapshot is real weight from now on, but it never
        // reaches back: the snapshot answer is unchanged.
        conviction.refill(ALICE, 50);
        vm.prank(ALICE);
        conviction.stake(P1, 50);
        vm.roll(151);
        assertEq(wired.weightFor(P1, ALICE, snap), expected);
        assertGt(
            wired.weightFor(P1, ALICE, 151),
            expected,
            "and it counts from the block it was made at"
        );
    }
}
