// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ProposalVault, IJoinPrice} from "../src/ProposalVault.sol";

/// @dev Minimal ERC-20 for the raise currency.
contract MockCurrency {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @dev The project token. Mint rights sit with the vault in these tests,
/// mirroring the real wiring where the DAO grants them.
contract MockToken {
    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;
    address public minter;

    function setMinter(address who) external {
        minter = who;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == minter, "not minter");
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function burn(address from, uint256 amount) external {
        require(msg.sender == minter, "not minter");
        balanceOf[from] -= amount;
        totalSupply -= amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @dev A fixed join price with a floor the vault must respect.
contract MockJoinPrice is IJoinPrice {
    uint256 public price;
    uint256 public floor;

    function set(uint256 price_, uint256 floor_) external {
        price = price_;
        floor = floor_;
    }

    function joinPrice(address, bytes32) external view override returns (uint256, uint256) {
        return (price, floor);
    }
}

contract ProposalVaultTest is Test {
    uint64 constant T = 1000; // maturation, in blocks
    uint16 constant TAX = 500; // 5%

    MockCurrency currency;
    MockToken token;
    MockJoinPrice pricing;
    ProposalVault vault;

    address constant GOVERNANCE = address(0xBEEF);
    address constant TREASURY = address(0xFEE);
    address constant ALICE = address(0xA11CE);
    address constant BOB = address(0xB0B);

    bytes32 constant P1 = keccak256("proposal-1");
    bytes32 constant P2 = keccak256("proposal-2");
    bytes32 constant CHECK = keccak256("ships v1 and the tests pass");

    function setUp() public {
        currency = new MockCurrency();
        token = new MockToken();
        pricing = new MockJoinPrice();
        vault = new ProposalVault(
            address(currency),
            address(token),
            TREASURY,
            GOVERNANCE,
            pricing,
            T,
            TAX
        );
        token.setMinter(address(vault));

        currency.mint(ALICE, 1_000_000);
        currency.mint(BOB, 1_000_000);
        vm.prank(ALICE);
        currency.approve(address(vault), type(uint256).max);
        vm.prank(BOB);
        currency.approve(address(vault), type(uint256).max);

        // 2 currency units per whole token, floor at 1. Raw units here, so the
        // arithmetic stays readable: `tokens = reserve * 1e18 / price`.
        pricing.set(2, 1);
    }

    /* ─────────────── vouchers ─────────────── */

    function test_pledge_issues_vouchers_one_per_unit() public {
        vm.prank(ALICE);
        vault.pledge(1_000);

        assertEq(vault.vouchers(ALICE), 1_000);
        assertEq(vault.totalVouchers(), 1_000);
        assertEq(currency.balanceOf(address(vault)), 1_000);
        _assertSolvent();
    }

    function test_unspent_vouchers_are_refundable_at_any_time() public {
        vm.startPrank(ALICE);
        vault.pledge(1_000);
        vault.refundVouchers(400);
        vm.stopPrank();

        assertEq(vault.vouchers(ALICE), 600);
        assertEq(currency.balanceOf(ALICE), 1_000_000 - 600);
        _assertSolvent();
    }

    function test_refund_more_than_held_reverts() public {
        vm.prank(ALICE);
        vault.pledge(10);
        vm.prank(ALICE);
        vm.expectRevert(ProposalVault.NothingToRefund.selector);
        vault.refundVouchers(11);
    }

    function test_vouchers_stay_with_their_owner_they_are_soulbound() public {
        _open(P1);
        vm.startPrank(ALICE);
        vault.pledge(1_000);
        vault.back(P1, 200);
        vm.stopPrank();

        // Spending vouchers burns them from the backer and gives them to no
        // one: there is no transfer function on this contract at all, so a
        // voucher cannot be sold or moved (plan §4, soulbound).
        assertEq(vault.vouchers(ALICE), 800);
        assertEq(vault.vouchers(BOB), 0);
        assertEq(vault.totalVouchers(), 800);
        _assertSolvent();
    }

    /* ─────────────── opening proposals ─────────────── */

    function test_only_governance_opens_a_proposal() public {
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(ProposalVault.OnlyGovernance.selector, ALICE));
        vault.openProposal(P1, 100, 1_000, uint64(block.number + 100), CHECK);
    }

    function test_a_proposal_needs_a_check_written_up_front() public {
        vm.prank(GOVERNANCE);
        vm.expectRevert(ProposalVault.CheckUnset.selector);
        vault.openProposal(P1, 100, 1_000, uint64(block.number + 100), bytes32(0));
    }

    function test_a_proposal_needs_a_valid_range_and_future_deadline() public {
        vm.startPrank(GOVERNANCE);
        vm.expectRevert(ProposalVault.BadRange.selector);
        vault.openProposal(P1, 0, 1_000, uint64(block.number + 100), CHECK);
        vm.expectRevert(ProposalVault.BadRange.selector);
        vault.openProposal(P1, 1_000, 100, uint64(block.number + 100), CHECK);
        vm.expectRevert(abi.encodeWithSelector(ProposalVault.DeadlinePassed.selector, P1));
        vault.openProposal(P1, 100, 1_000, uint64(block.number), CHECK);
        vm.stopPrank();
    }

    function test_a_proposal_cannot_be_reopened() public {
        _open(P1);
        vm.prank(GOVERNANCE);
        vm.expectRevert(abi.encodeWithSelector(ProposalVault.ProposalClosed.selector, P1));
        vault.openProposal(P1, 1, 2, uint64(block.number + 100), CHECK);
    }

    /* ─────────────── backing ─────────────── */

    function test_backing_moves_money_to_the_reserve_and_escrows_tokens() public {
        _open(P1);
        vm.startPrank(ALICE);
        vault.pledge(1_000);
        vault.back(P1, 1_000);
        vm.stopPrank();

        (,,,, uint256 reserved, uint256 escrowed,) = vault.proposals(P1);

        // 5% tax to the treasury, the rest reserved.
        assertEq(currency.balanceOf(TREASURY), 50);
        assertEq(reserved, 950);
        // 950 currency at 2 per token = 475 tokens, escrowed in the vault.
        assertEq(escrowed, 475e18);
        assertEq(token.balanceOf(address(vault)), 475e18);
        assertEq(token.balanceOf(ALICE), 0, "tokens must be escrowed, not held");
        _assertSolvent();
    }

    function test_unspent_vouchers_carry_no_weight() public {
        _open(P1);
        vm.roll(block.number + 1);
        vm.startPrank(ALICE);
        vault.pledge(1_000);
        vault.back(P1, 200); // 190 reserved -> 95 tokens escrowed
        vm.stopPrank();

        // The 800 vouchers still sitting there buy no influence at all. This
        // is what keeps refundable money from voting (plan §4) and what stops
        // the backing term becoming a reputation faucet (G6).
        assertEq(vault.backingWeightAt(P1, ALICE, uint48(block.number)), 95e18);
    }

    function test_cannot_back_past_the_deadline_or_after_resolution() public {
        _open(P1);
        vm.startPrank(ALICE);
        vault.pledge(1_000);
        vault.back(P1, 200); // clears the minimum, so it can be verified
        vm.stopPrank();

        // Past the deadline.
        vm.roll(block.number + 200);
        vm.prank(BOB);
        vm.expectRevert(abi.encodeWithSelector(ProposalVault.DeadlinePassed.selector, P1));
        vault.back(P1, 100);

        // And after a proposal has resolved.
        _open(P2);
        vm.prank(GOVERNANCE);
        vault.verify(P1);
        vm.prank(BOB);
        vm.expectRevert(abi.encodeWithSelector(ProposalVault.ProposalClosed.selector, P1));
        vault.back(P1, 100);
    }

    function test_cannot_exceed_the_maximum() public {
        _open(P1); // max 10_000
        vm.startPrank(ALICE);
        vault.pledge(1_000_000);
        vault.back(P1, 9_000);
        vm.stopPrank();
        vm.startPrank(BOB);
        vault.pledge(1_000_000);
        vm.expectRevert(abi.encodeWithSelector(ProposalVault.AboveMaximum.selector, P1));
        vault.back(P1, 2_000);
        vm.stopPrank();
        _assertSolvent();
    }

    function test_a_price_below_the_treasury_value_is_refused() public {
        _open(P1);
        pricing.set(1, 5); // price under the floor
        vm.startPrank(ALICE);
        vault.pledge(1_000);
        vm.expectRevert(abi.encodeWithSelector(ProposalVault.PriceBelowFloor.selector, 1, 5));
        vault.back(P1, 100);
        vm.stopPrank();
    }

    function test_one_proposal_cannot_spend_another_proposals_reserve() public {
        _open(P1);
        _open(P2);
        vm.startPrank(ALICE);
        vault.pledge(2_000);
        vault.back(P1, 1_000);
        vault.back(P2, 1_000);
        vm.stopPrank();
        _assertSolvent();

        (,,,, uint256 r1,,) = vault.proposals(P1);
        (,,,, uint256 r2,,) = vault.proposals(P2);
        assertEq(r1, 950);
        assertEq(r2, 950);
    }

    /* ─────────────── resolution ─────────────── */

    function test_below_the_minimum_at_the_deadline_everyone_is_refunded() public {
        _open(P1); // min 100
        vm.startPrank(ALICE);
        vault.pledge(100);
        vault.back(P1, 10); // 10 reserved, below the minimum
        vm.stopPrank();

        vm.roll(block.number + 200);
        // Anyone may close it: a proposal must never strand backers' money
        // behind an absent judge.
        vm.prank(BOB);
        vault.fail(P1);

        uint256 before = currency.balanceOf(ALICE);
        vm.prank(ALICE);
        vault.refundPosition(P1);
        assertEq(currency.balanceOf(ALICE), before + 10, "the whole commitment returns");
        _assertSolvent();
    }

    function test_a_verified_milestone_releases_the_backers_tokens() public {
        _open(P1);
        vm.startPrank(ALICE);
        vault.pledge(1_000);
        vault.back(P1, 1_000);
        vm.stopPrank();

        vm.prank(GOVERNANCE);
        vault.verify(P1);
        assertEq(vault.tokensAtRisk(ALICE), 0, "resolution takes the risk off the table");

        vm.prank(ALICE);
        vault.claimTokens(P1);
        assertEq(token.balanceOf(ALICE), 475e18);
        assertEq(vault.escrowedOf(P1, ALICE), 0);
    }

    function test_verify_below_the_minimum_is_refused() public {
        _open(P1);
        vm.startPrank(ALICE);
        vault.pledge(100);
        vault.back(P1, 10);
        vm.stopPrank();
        vm.prank(GOVERNANCE);
        vm.expectRevert(abi.encodeWithSelector(ProposalVault.BelowMinimum.selector, P1));
        vault.verify(P1);
    }

    function test_verify_is_governance_only() public {
        _open(P1);
        vm.startPrank(ALICE);
        vault.pledge(1_000);
        vault.back(P1, 1_000);
        vm.stopPrank();

        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(ProposalVault.OnlyGovernance.selector, ALICE));
        vault.verify(P1);
    }

    function test_a_live_proposal_cannot_be_rejected_by_a_stranger() public {
        _open(P1);
        vm.startPrank(ALICE);
        vault.pledge(1_000);
        vault.back(P1, 1_000);
        vm.stopPrank();

        // While there is time left and the minimum is met, rejection is the
        // judge's call — not whoever calls first.
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(ProposalVault.ProposalNotResolvable.selector, P1));
        vault.fail(P1);
    }

    function test_a_refund_is_a_refund_not_a_slash() public {
        _open(P1);
        vm.startPrank(ALICE);
        vault.pledge(1_000);
        vault.back(P1, 1_000);
        vm.stopPrank();

        vm.prank(GOVERNANCE);
        vault.fail(P1);
        uint256 before = currency.balanceOf(TREASURY);
        vm.prank(ALICE);
        vault.refundPosition(P1);
        // Rejected claims in `ClaimStake` slash to the treasury. Here the
        // treasury gets nothing more than the tax it already took.
        assertEq(currency.balanceOf(TREASURY), before);
        assertEq(token.totalSupply(), 0, "refunded tokens are burned");
        _assertSolvent();
    }

    function test_cannot_resolve_twice() public {
        _open(P1);
        vm.prank(GOVERNANCE);
        vault.fail(P1);
        vm.prank(GOVERNANCE);
        vm.expectRevert(abi.encodeWithSelector(ProposalVault.ProposalClosed.selector, P1));
        vault.fail(P1);
    }

    /* ─────────────── weight ─────────────── */

    function test_backing_weight_matures_over_the_window() public {
        _open(P1);
        vm.roll(block.number + 1);
        vm.startPrank(ALICE);
        vault.pledge(1_000);
        vault.back(P1, 1_000); // 475 tokens escrowed
        vm.stopPrank();

        uint48 start = uint48(block.number);

        // Fresh commitment: the stake back, and no bonus.
        assertEq(vault.backingWeightAt(P1, ALICE, start), 475e18);

        // Half way: 1.5x.
        assertEq(vault.backingWeightAt(P1, ALICE, start + uint48(T) / 2), 712.5e18);

        // Fully mature: 2x, and it never exceeds that.
        assertEq(vault.backingWeightAt(P1, ALICE, start + uint48(T)), 950e18);
        assertEq(vault.backingWeightAt(P1, ALICE, start + uint48(10 * T)), 950e18);
    }

    function test_a_snapshot_ignores_backing_that_came_after_it() public {
        _open(P1);
        vm.roll(100);
        uint48 snap = 100;
        vm.roll(101);

        vm.startPrank(ALICE);
        vault.pledge(1_000);
        vault.back(P1, 1_000);
        vm.stopPrank();

        assertEq(
            vault.backingWeightAt(P1, ALICE, snap),
            0,
            "backing after the snapshot buys nothing"
        );
        assertGt(
            vault.backingWeightAt(P1, ALICE, 101),
            0,
            "the same backing counts from the block it was made in"
        );
    }

    function test_holding_earns_nothing_only_backing_does() public {
        // Alice holds a lot of project tokens but directs nothing.
        token.setMinter(address(this));
        token.mint(ALICE, 1_000_000e18);
        token.setMinter(address(vault));

        _open(P1);
        assertEq(vault.backingWeightAt(P1, ALICE, uint48(block.number)), 0);
    }

    function test_weight_is_per_proposal() public {
        _open(P1);
        _open(P2);
        vm.roll(block.number + 1);
        vm.startPrank(ALICE);
        vault.pledge(1_500);
        vault.back(P1, 1_000);
        vault.back(P2, 500);
        vm.stopPrank();

        assertGt(vault.backingWeightAt(P1, ALICE, uint48(block.number)), 0);
        assertGt(vault.backingWeightAt(P2, ALICE, uint48(block.number)), 0);
        assertEq(vault.backingWeightAt(keccak256("nope"), ALICE, uint48(block.number)), 0);
    }

    function test_a_resolved_proposal_carries_no_weight() public {
        _open(P1);
        vm.roll(block.number + 1);
        vm.startPrank(ALICE);
        vault.pledge(1_000);
        vault.back(P1, 1_000);
        vm.stopPrank();
        assertGt(vault.backingWeightAt(P1, ALICE, uint48(block.number + 10)), 0);

        vm.prank(GOVERNANCE);
        vault.verify(P1);
        assertEq(vault.backingWeightAt(P1, ALICE, uint48(block.number + 10)), 0);
    }

    /* ─────────────── the exit gate ─────────────── */

    function test_risk_is_derived_and_never_stale() public {
        _open(P1);
        _open(P2);
        vm.roll(block.number + 1);
        vm.startPrank(ALICE);
        vault.pledge(2_000);
        vault.back(P1, 1_000);
        vault.back(P2, 1_000);
        vm.stopPrank();
        assertEq(vault.tokensAtRisk(ALICE), 950e18);

        // P1 resolves; only P2 is still at risk. No sweeping required — a
        // stale cached lock would strand Alice's exit (Review-Proven Rule 6).
        vm.prank(GOVERNANCE);
        vault.verify(P1);
        assertEq(vault.tokensAtRisk(ALICE), 475e18);

        vm.prank(GOVERNANCE);
        vault.fail(P2);
        assertEq(vault.tokensAtRisk(ALICE), 0);
    }

    /* ─────────────── helpers ─────────────── */

    function _open(bytes32 proposalId) internal {
        vm.prank(GOVERNANCE);
        vault.openProposal(proposalId, 100, 10_000, uint64(block.number + 100), CHECK);
    }

    /// @dev The contract's stated solvency invariant:
    /// `currency held == unspent vouchers + Σ reserved`.
    function _assertSolvent() internal view {
        uint256 held = currency.balanceOf(address(vault));
        uint256 owed = vault.totalVouchers();
        assertEq(held, owed + _reservedP1() + _reservedP2(), "vault must hold exactly what it owes");
    }

    function _reservedP1() internal view returns (uint256 r) {
        (,,,, r,,) = vault.proposals(P1);
    }

    function _reservedP2() internal view returns (uint256 r) {
        (,,,, r,,) = vault.proposals(P2);
    }
}
