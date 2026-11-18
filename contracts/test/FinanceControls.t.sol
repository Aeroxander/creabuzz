// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ClaimStake} from "../src/ClaimStake.sol";
import {VerifierSet} from "../src/VerifierSet.sol";

/// @dev Minimal ERC-20 the escrow moves currency through.
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

/// @dev The finance controls of plan §7, each as its own failing condition:
/// G1 reviewer recusal, G2 claim expiry returned unslashed, G13 the challenge
/// window before payout, G16 the acceptance check locked on first review, and
/// G20 the expiry every seat can read.
///
/// These are the controls that make the capital commitment worth having: a
/// backer's money is only safe if a claim cannot be approved by its own author,
/// paid before it can be challenged, or judged against a check that moved.
contract FinanceControlsTest is Test {
    MockCurrency usd;
    VerifierSet verifiers;
    ClaimStake stake;

    address constant TREASURY = address(0xFEE);
    address constant CONTRIBUTOR = address(0xA11CE);
    address constant VERIFIER = address(0xBEEF);
    address constant OTHER = address(0xB0B);

    bytes32 constant CLAIM = keccak256("claim");
    bytes32 constant EVIDENCE = keccak256("evidence");
    bytes32 constant CHECK = keccak256("ships v1 and the tests pass");

    function setUp() public {
        usd = new MockCurrency();
        verifiers = new VerifierSet(TREASURY, 1); // one approval is enough
        stake = new ClaimStake(verifiers, TREASURY, address(usd));
        // G1 only bites once the escrow is known to the panel.
        vm.prank(TREASURY);
        verifiers.setClaimStake(address(stake));

        vm.prank(TREASURY);
        verifiers.acceptVerifier(VERIFIER);

        usd.mint(CONTRIBUTOR, 1_000e6);
        vm.prank(CONTRIBUTOR);
        usd.approve(address(stake), type(uint256).max);
        usd.mint(TREASURY, 10_000e6);
        vm.prank(TREASURY);
        usd.approve(address(stake), type(uint256).max);

        vm.prank(CONTRIBUTOR);
        stake.submitClaim(CLAIM, 500e6, 50e6, EVIDENCE);
        vm.prank(TREASURY);
        stake.fund(CLAIM, 500e6);
    }

    /* ─────────────── G16: the check, stated and then locked ─────────────── */

    function test_the_check_is_the_claimants_to_set_before_anyone_looks() public {
        vm.prank(CONTRIBUTOR);
        stake.setCheck(CLAIM, CHECK);
        // contributor, amount, stake, status, evidenceHash, checkHash, expiresAt, releasedAt
        (, , , , , bytes32 checkHash, , ) = stake.claims(CLAIM);
        assertEq(checkHash, CHECK, "the claim carries the check it will be judged against");
    }

    function test_only_the_claimant_sets_the_check() public {
        vm.prank(OTHER);
        vm.expectRevert(abi.encodeWithSelector(ClaimStake.NotClaimant.selector, OTHER));
        stake.setCheck(CLAIM, CHECK);
    }

    function test_the_check_locks_the_moment_a_reviewer_looks() public {
        vm.prank(VERIFIER);
        verifiers.attest(CLAIM, true);

        vm.prank(CONTRIBUTOR);
        vm.expectRevert(abi.encodeWithSelector(ClaimStake.CheckLocked.selector, CLAIM));
        stake.setCheck(CLAIM, keccak256("a different, easier check"));
    }

    /* ─────────────── G1: a claimant cannot judge their own work ─────────────── */

    function test_a_claimant_cannot_attest_to_their_own_claim() public {
        // Let the claimant in as a reviewer first — recusal has to hold
        // whoever is holding the pen.
        vm.prank(TREASURY);
        verifiers.acceptVerifier(CONTRIBUTOR);

        vm.prank(CONTRIBUTOR);
        vm.expectRevert(
            abi.encodeWithSelector(
                VerifierSet.ClaimantCannotAttest.selector, CLAIM, CONTRIBUTOR
            )
        );
        verifiers.attest(CLAIM, true);
    }

    function test_another_reviewer_is_not_recused() public {
        vm.prank(VERIFIER);
        verifiers.attest(CLAIM, true);
        (uint256 approvals, ) = verifiers.claims(CLAIM);
        assertEq(approvals, 1);
    }

    /* ─────────────── G13: the challenge window before payout ─────────────── */

    function test_a_payout_cannot_be_taken_inside_the_challenge_window() public {
        vm.prank(VERIFIER);
        verifiers.attest(CLAIM, true);
        stake.settle(CLAIM);

        vm.prank(CONTRIBUTOR);
        vm.expectRevert();
        stake.payout(CLAIM);
    }

    function test_the_window_closes_and_the_payout_goes_through() public {
        vm.prank(VERIFIER);
        verifiers.attest(CLAIM, true);
        stake.settle(CLAIM);

        vm.warp(block.timestamp + stake.challengeWindow() + 1);
        vm.prank(CONTRIBUTOR);
        stake.payout(CLAIM);
        (, , , ClaimStake.Status status, , , , ) = stake.claims(CLAIM);
        assertEq(uint256(status), uint256(ClaimStake.Status.Paid), "the claim is paid");
        assertEq(usd.balanceOf(CONTRIBUTOR), 1_000e6 - 50e6 + 550e6, "payout + stake returned");
    }

    function test_a_challenge_can_still_freeze_the_claim_during_the_window() public {
        vm.prank(VERIFIER);
        verifiers.attest(CLAIM, true);
        stake.settle(CLAIM);

        // The window is not a pause nobody can act on.
        vm.prank(TREASURY);
        stake.freeze(CLAIM);
        vm.warp(block.timestamp + stake.challengeWindow() + 1);
        vm.prank(CONTRIBUTOR);
        vm.expectRevert(abi.encodeWithSelector(ClaimStake.NotOpen.selector, CLAIM));
        stake.payout(CLAIM);
    }

    function test_the_window_cannot_be_switched_off() public {
        vm.prank(TREASURY);
        vm.expectRevert(ClaimStake.BadWindow_.selector);
        stake.setWindows(30 days, 0);
    }

    /* ─────────────── G2: expiry, returned unslashed ─────────────── */

    function test_a_claim_that_runs_out_of_time_is_refunded_not_slashed() public {
        vm.warp(block.timestamp + stake.claimWindow() + 1);
        uint256 treasuryBefore = usd.balanceOf(TREASURY);

        stake.expire(CLAIM);

        assertEq(
            uint256(_status()),
            uint256(ClaimStake.Status.Expired),
            "the claim lapses"
        );
        assertEq(usd.balanceOf(CONTRIBUTOR), 1_000e6, "the stake comes back unslashed");
        assertEq(usd.balanceOf(TREASURY), treasuryBefore + 500e6, "the reserve returns to the treasury");
        assertEq(usd.balanceOf(address(stake)), 0, "nothing is stranded");
    }

    function test_a_claim_cannot_be_expired_before_its_time() public {
        vm.expectRevert(abi.encodeWithSelector(ClaimStake.NotExpired.selector, CLAIM));
        stake.expire(CLAIM);
    }

    function test_anyone_may_expire_an_abandoned_claim() public {
        vm.warp(block.timestamp + stake.claimWindow() + 1);
        vm.prank(OTHER);
        stake.expire(CLAIM);
        assertEq(uint256(_status()), uint256(ClaimStake.Status.Expired));
    }

    function test_an_expired_claim_is_closed_to_payout() public {
        vm.warp(block.timestamp + stake.claimWindow() + 1);
        stake.expire(CLAIM);
        vm.prank(CONTRIBUTOR);
        vm.expectRevert(abi.encodeWithSelector(ClaimStake.NotOpen.selector, CLAIM));
        stake.payout(CLAIM);
    }

    /* ─────────────── G20: the expiry every seat can read ─────────────── */

    function test_the_expiry_is_on_the_record_other_seats_read() public {
        (, , , , , , uint64 expiresAt, ) = stake.claims(CLAIM);
        assertEq(expiresAt, uint64(block.timestamp + stake.claimWindow()));
        assertEq(stake.claimantOf(CLAIM), CONTRIBUTOR, "who took the task is public too");
    }

    /* ─────────────── the whole thing still balances ─────────────── */

    function test_a_lapsed_claim_leaves_the_escrow_empty() public {
        vm.warp(block.timestamp + stake.claimWindow() + 1);
        stake.expire(CLAIM);
        assertEq(usd.balanceOf(address(stake)), 0);
    }

    function _status() internal view returns (ClaimStake.Status) {
        (, , , ClaimStake.Status status, , , , ) = stake.claims(CLAIM);
        return status;
    }
}
