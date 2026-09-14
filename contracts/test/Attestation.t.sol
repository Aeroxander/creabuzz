// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {VerifierSet} from "../src/VerifierSet.sol";
import {ClaimStake} from "../src/ClaimStake.sol";

contract MockUSD {
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
        require(balanceOf[msg.sender] >= amount, "mock insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "mock allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        require(balanceOf[from] >= amount, "mock insufficient");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract AttestationTest is Test {
    address treasury = address(0xBEEF);
    address verifierA = address(0xA11CE1);
    address verifierB = address(0xB0B);
    address contributor = address(0xC0FFEE);
    MockUSD usd;
    VerifierSet verifiers;
    ClaimStake stake;

    function setUp() public {
        usd = new MockUSD();
        verifiers = new VerifierSet(treasury, 2); // quorum 2 of 2
        stake = new ClaimStake(verifiers, treasury, address(usd));
        // Accept two verifiers, fund the escrow, approve the puller.
        vm.startPrank(treasury);
        verifiers.acceptVerifier(verifierA);
        verifiers.acceptVerifier(verifierB);
        usd.mint(treasury, 10_000e6);
        vm.startPrank(treasury);
        usd.approve(address(stake), 10_000e6);
        stake.fund(treasury, 10_000e6);
        vm.stopPrank();

        // Contributor mints + approves stake and lets the claim pull both
        // stake and payout from their balance. For the test, funding the
        // escrow covers the payout; the stake is pulled from the contributor.
        usd.mint(contributor, 1_000e6);
        vm.startPrank(contributor);
        usd.approve(address(stake), 1_000e6);
        vm.stopPrank();
    }

    bytes32 constant CLAIM = keccak256("milestone-1");

    function test_release_only_on_quorum() public {
        vm.prank(contributor);
        stake.submitClaim(CLAIM, 500e6, 50e6, keccak256("evidence"));
        // No quorum yet: cannot settle.
        vm.expectRevert(abi.encodeWithSelector(ClaimStake.NotOpen.selector, CLAIM));
        stake.settle(CLAIM);
        // One approval: still no quorum.
        vm.prank(verifierA);
        verifiers.attest(CLAIM, true);
        vm.expectRevert(abi.encodeWithSelector(ClaimStake.NotOpen.selector, CLAIM));
        stake.settle(CLAIM);
        // Second approval: quorum reached, release happens; contributor can
        // pull payout + stake.
        vm.prank(verifierB);
        verifiers.attest(CLAIM, true);
        stake.settle(CLAIM);
        vm.prank(contributor);
        stake.payout(CLAIM);
        assertEq(usd.balanceOf(contributor), 1_500e6, "payout + stake returned (1000 minted - 50 stake + 550 payout)");
        assertEq(uint256(_status()), uint256(ClaimStake.Status.Paid), "claim is paid");
    }

    function test_spam_claim_is_slashed_on_objection_quorum() public {
        vm.prank(contributor);
        stake.submitClaim(CLAIM, 500e6, 50e6, keccak256("spam"));
        vm.prank(verifierA);
        verifiers.attest(CLAIM, false);
        vm.prank(verifierB);
        verifiers.attest(CLAIM, false);
        stake.settle(CLAIM);
        assertEq(uint256(_status()), uint256(ClaimStake.Status.Rejected), "spam claim rejected");
        // The stake stays escrowed (treasury may claim via governance); the
        // contributor cannot pull it.
        vm.prank(contributor);
        vm.expectRevert(abi.encodeWithSelector(ClaimStake.NotOpen.selector, CLAIM));
        stake.payout(CLAIM);
    }

    function test_freeze_stops_payout() public {
        vm.prank(contributor);
        stake.submitClaim(CLAIM, 500e6, 50e6, keccak256("evidence"));
        vm.prank(treasury);
        stake.freeze(CLAIM);
        assertEq(uint256(_status()), uint256(ClaimStake.Status.Frozen), "frozen");
        // Verifier approval after a freeze cannot release it.
        vm.prank(verifierA);
        verifiers.attest(CLAIM, true);
        vm.prank(verifierB);
        verifiers.attest(CLAIM, true);
        vm.expectRevert(abi.encodeWithSelector(ClaimStake.AlreadySettled.selector, CLAIM));
        stake.settle(CLAIM);
    }

    function test_single_claim_per_evidence_hash() public {
        vm.prank(contributor);
        stake.submitClaim(CLAIM, 500e6, 50e6, keccak256("evidence"));
        vm.expectRevert(abi.encodeWithSelector(ClaimStake.AlreadySettled.selector, CLAIM));
        stake.submitClaim(CLAIM, 500e6, 50e6, keccak256("evidence2"));
    }

    function test_verifier_slash_is_treasury_only() public {
        vm.expectRevert(abi.encodeWithSelector(VerifierSet.OnlyOwner.selector, verifierA));
        vm.prank(verifierA);
        verifiers.slash(verifierB, 100);
    }

    function _status() internal view returns (ClaimStake.Status) {
        (, , , ClaimStake.Status status, ) = stake.claims(CLAIM);
        return status;
    }
}
