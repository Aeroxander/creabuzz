// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {OrgAllowance} from "../src/OrgAllowance.sol";

/// @dev Subject = the agent's 32-byte Nostr pubkey, verbatim (no keccak).
contract OrgAllowanceTest is Test {
    OrgAllowance internal org;

    address internal ownerAddr = makeAddr("communityOwner");
    address internal spender = makeAddr("harnessBackend");
    address internal attacker = makeAddr("attacker");
    address internal token = makeAddr("usdc");

    // A plausible 32-byte Nostr pubkey (x-only BIP-340 style), used verbatim.
    bytes32 internal subject = 0xd1a7d9d1a2f0e13a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a;

    function setUp() public {
        vm.prank(ownerAddr);
        org = new OrgAllowance();
        vm.prank(ownerAddr);
        org.setSpender(subject, spender);
        vm.prank(ownerAddr);
        org.setAllowance(subject, token, 1, 100 ether);
    }

    // ------------------------------------------------------------- happy path

    function test_DeployerIsOwner() public view {
        assertEq(org.owner(), ownerAddr);
    }

    function test_SpendHappyPath() public {
        vm.prank(spender);
        vm.expectEmit(true, true, true, true, address(org));
        emit OrgAllowance.Spent(subject, token, 1, 30 ether, spender);
        org.spend(subject, token, 1, 30 ether);

        assertEq(org.spentOf(subject, token, 1), 30 ether);
        assertEq(org.remainingOf(subject, token, 1), 70 ether);
    }

    function test_MultipleSpendsAccumulate() public {
        vm.startPrank(spender);
        org.spend(subject, token, 1, 30 ether);
        org.spend(subject, token, 1, 70 ether); // exactly exhausts
        vm.stopPrank();
        assertEq(org.remainingOf(subject, token, 1), 0);
    }

    // ------------------------------------------------------------ over-spend

    function test_OverSpendReverts_ExactError() public {
        vm.prank(spender);
        vm.expectRevert(abi.encodeWithSelector(OrgAllowance.OverSpend.selector, 101 ether, 100 ether));
        org.spend(subject, token, 1, 101 ether);
    }

    function test_OverSpendAfterPartialUse() public {
        vm.prank(spender);
        org.spend(subject, token, 1, 40 ether);
        vm.prank(spender);
        vm.expectRevert(abi.encodeWithSelector(OrgAllowance.OverSpend.selector, 61 ether, 60 ether));
        org.spend(subject, token, 1, 61 ether);
    }

    // --------------------------------------------------------- spender auth

    function test_NonSpenderReverts() public {
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(OrgAllowance.NotSpender.selector, attacker, subject));
        org.spend(subject, token, 1, 1);
    }

    function test_SubjectWithoutSpenderReverts() public {
        bytes32 stranger = keccak256("unmanaged-agent");
        vm.prank(ownerAddr);
        org.setAllowance(stranger, token, 1, 5 ether); // allowance exists...
        vm.prank(spender); // ...but nobody is authorized for this subject
        vm.expectRevert(abi.encodeWithSelector(OrgAllowance.NotSpender.selector, spender, stranger));
        org.spend(stranger, token, 1, 1 ether);
    }

    function test_RevokedSpenderCannotSpend() public {
        vm.prank(ownerAddr);
        org.setSpender(subject, address(0));
        vm.prank(spender);
        vm.expectRevert(abi.encodeWithSelector(OrgAllowance.NotSpender.selector, spender, subject));
        org.spend(subject, token, 1, 1);
    }

    // ---------------------------------------------------------- owner gates

    function test_OwnerOnlySetters() public {
        vm.startPrank(attacker);
        vm.expectRevert(abi.encodeWithSelector(OrgAllowance.NotOwner.selector, attacker));
        org.setSpender(subject, attacker);
        vm.expectRevert(abi.encodeWithSelector(OrgAllowance.NotOwner.selector, attacker));
        org.setAllowance(subject, token, 2, 1 ether);
        vm.expectRevert(abi.encodeWithSelector(OrgAllowance.NotOwner.selector, attacker));
        org.decreaseAllowance(subject, token, 1, 1);
        vm.expectRevert(abi.encodeWithSelector(OrgAllowance.NotOwner.selector, attacker));
        org.setOwner(attacker);
        vm.stopPrank();
        assertEq(org.owner(), ownerAddr);
    }

    function test_OwnerTransfer() public {
        vm.prank(ownerAddr);
        org.setOwner(spender);
        assertEq(org.owner(), spender);
        // new owner can administer; old owner cannot
        vm.prank(spender);
        org.setSpender(subject, attacker);
        assertEq(org.spenderOf(subject), attacker);
        vm.prank(ownerAddr);
        vm.expectRevert(abi.encodeWithSelector(OrgAllowance.NotOwner.selector, ownerAddr));
        org.setOwner(ownerAddr);
    }

    // ------------------------------------------------------- epoch isolation

    function test_EpochIsolation() public {
        vm.prank(spender);
        org.spend(subject, token, 1, 100 ether); // drain epoch 1
        assertEq(org.remainingOf(subject, token, 1), 0);

        // epoch 2 is untouched: no allowance -> nothing spendable there
        vm.prank(spender);
        vm.expectRevert(abi.encodeWithSelector(OrgAllowance.OverSpend.selector, 1 ether, 0));
        org.spend(subject, token, 2, 1 ether);

        // granting epoch 2 its own allowance does not revive epoch 1
        vm.prank(ownerAddr);
        org.setAllowance(subject, token, 2, 50 ether);
        vm.prank(spender);
        org.spend(subject, token, 2, 50 ether);
        assertEq(org.remainingOf(subject, token, 1), 0);
        assertEq(org.remainingOf(subject, token, 2), 0);
        assertEq(org.allowanceOf(subject, token, 1), 100 ether);
    }

    function test_TokenIsolation() public {
        address other = makeAddr("otherToken");
        vm.prank(ownerAddr);
        org.setAllowance(subject, other, 1, 10 ether);
        vm.prank(spender);
        org.spend(subject, token, 1, 100 ether);
        vm.prank(spender);
        org.spend(subject, other, 1, 10 ether);
        assertEq(org.remainingOf(subject, token, 1), 0);
        assertEq(org.remainingOf(subject, other, 1), 0);
    }

    // ------------------------------------------------- decrease vs. spent

    function test_DecreaseAllowance_BelowSpentReverts() public {
        vm.prank(spender);
        org.spend(subject, token, 1, 30 ether);
        vm.prank(ownerAddr);
        vm.expectRevert(abi.encodeWithSelector(OrgAllowance.BelowSpent.selector, 29 ether, 30 ether));
        org.decreaseAllowance(subject, token, 1, 71 ether); // 100-71=29 < 30 spent
    }

    function test_DecreaseAllowance_ToExactlySpent_Ok() public {
        vm.prank(spender);
        org.spend(subject, token, 1, 30 ether);
        vm.prank(ownerAddr);
        org.decreaseAllowance(subject, token, 1, 70 ether); // 100-70=30 == spent
        assertEq(org.remainingOf(subject, token, 1), 0);
    }

    // ----------------------------------------------- zero / missing allowance

    function test_ZeroAllowanceCannotSpend() public {
        vm.prank(ownerAddr);
        org.setAllowance(subject, token, 3, 0);
        vm.prank(spender);
        vm.expectRevert(abi.encodeWithSelector(OrgAllowance.OverSpend.selector, 1, 0));
        org.spend(subject, token, 3, 1);
    }

    function test_MissingAllowanceIsZero() public view {
        assertEq(org.allowanceOf(subject, token, 99), 0);
        assertEq(org.spentOf(subject, token, 99), 0);
        assertEq(org.remainingOf(subject, token, 99), 0);
    }

    function test_SpendZeroOnMissingAllowance_Ok() public {
        // spending 0 against a zero/missing allowance is a no-op success
        vm.prank(spender);
        org.spend(subject, token, 99, 0);
        assertEq(org.spentOf(subject, token, 99), 0);
    }

    // ------------------------------------------------------------------ fuzz

    /// Two spends that together fit in the allowance must never revert.
    function testFuzz_TwoSpendsWithinAllowance_NeverReverts(uint256 a, uint256 b) public {
        a = bound(a, 0, 100 ether);
        b = bound(b, 0, 100 ether - a);
        vm.prank(spender);
        org.spend(subject, token, 1, a);
        vm.prank(spender);
        org.spend(subject, token, 1, b);
        assertEq(org.spentOf(subject, token, 1), uint256(a) + b);
        assertEq(org.remainingOf(subject, token, 1), 100 ether - a - b);
    }

    /// Spends summing above the allowance must always revert with OverSpend
    /// on the spend that crosses the line.
    function testFuzz_TwoSpendsOverAllowance_AlwaysReverts(uint256 a, uint256 b) public {
        a = bound(a, 0, 100 ether);
        b = bound(b, 100 ether - a + 1, 200 ether); // a + b > allowance
        vm.prank(spender);
        org.spend(subject, token, 1, a);
        uint256 expectedRemaining = 100 ether - a;
        vm.prank(spender);
        vm.expectRevert(abi.encodeWithSelector(OrgAllowance.OverSpend.selector, b, expectedRemaining));
        org.spend(subject, token, 1, b);
        // failed spend left no trace
        assertEq(org.spentOf(subject, token, 1), a);
        assertEq(org.remainingOf(subject, token, 1), expectedRemaining);
    }
}
