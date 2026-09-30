// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {OrgAllowance} from "../src/OrgAllowance.sol";

/// @dev Plain 18-dec ERC-20 with the allowance semantics `spendTo` relies on.
contract AllowanceToken {
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
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            require(a >= amount, "allowance");
            allowance[from][msg.sender] = a - amount;
        }
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @dev Subject = the agent's 32-byte Nostr pubkey, verbatim (no keccak).
contract OrgAllowanceTest is Test {
    OrgAllowance internal org;
    AllowanceToken internal usdc;
    address internal treasuryAddr = makeAddr("treasury");
    address internal payee = makeAddr("payee");
    /// The clock the whole suite runs at: epoch 100 with the default day length,
    /// so the epochs the tests name (1, 2, 3, 99) have all begun.
    uint256 internal constant NOW_TS = 100 * 86_400;

    address internal ownerAddr = makeAddr("communityOwner");
    address internal spender = makeAddr("harnessBackend");
    address internal attacker = makeAddr("attacker");
    address internal token;

    // A plausible 32-byte Nostr pubkey (x-only BIP-340 style), used verbatim.
    bytes32 internal subject = 0xd1a7d9d1a2f0e13a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a;

    function setUp() public {
        vm.warp(NOW_TS);
        usdc = new AllowanceToken();
        token = address(usdc);
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
    // =====================================================================
    // R3: the allowance holds the ceiling AND the payout path (`spendTo`)
    // =====================================================================

    function _wireTreasury(uint256 balance, uint256 approval) internal {
        usdc.mint(treasuryAddr, balance);
        vm.prank(treasuryAddr);
        usdc.approve(address(org), approval);
        vm.prank(ownerAddr);
        org.setTreasury(treasuryAddr);
    }

    /// The enforced path: the ledger debit and the token movement are one call.
    /// `spendTo` emits `SpentTo` and never `Spent` — one authoritative event
    /// per debit, so off-chain consumers summing both can't double-count.
    function test_SpendTo_DebitsTheLedgerAndMovesTheTokens() public {
        _wireTreasury(1_000 ether, 1_000 ether);
        vm.prank(spender);
        vm.expectEmit(true, true, true, true, address(org));
        emit OrgAllowance.SpentTo(subject, token, 1, 30 ether, payee);
        vm.recordLogs();
        org.spendTo(subject, token, 1, 30 ether, payee);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 orgEmits;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != address(org)) continue;
            orgEmits++;
            assertEq(
                logs[i].topics[0],
                keccak256("SpentTo(bytes32,address,uint64,uint256,address)"),
                "spendTo emits SpentTo only (Spent would double-count)"
            );
        }
        assertEq(orgEmits, 1, "exactly one authoritative event per debit");

        assertEq(usdc.balanceOf(payee), 30 ether, "the payee was paid");
        assertEq(usdc.balanceOf(treasuryAddr), 970 ether, "from the treasury");
        assertEq(org.spentOf(subject, token, 1), 30 ether, "and the ledger was debited in the same call");
        assertEq(org.remainingOf(subject, token, 1), 70 ether);
    }

    /// The bypass R3 closes. A spender key holding no funds can move money ONLY
    /// through `spendTo`, and only up to the ledger — even when the treasury's
    /// ERC-20 approval to this contract is far larger than the allowance.
    function test_SpendTo_IsTheOnlyWayAnAgentKeyMovesTreasuryMoney_AndCapsAtTheLedger() public {
        _wireTreasury(1_000_000 ether, type(uint256).max);
        // The agent key cannot pull from the treasury by any other route.
        vm.prank(spender);
        vm.expectRevert("allowance");
        usdc.transferFrom(treasuryAddr, spender, 1 ether);

        // It can drain its allowance exactly ...
        vm.startPrank(spender);
        org.spendTo(subject, token, 1, 60 ether, payee);
        org.spendTo(subject, token, 1, 40 ether, payee);
        // ... and not one wei more, however much the treasury has approved.
        vm.expectRevert(abi.encodeWithSelector(OrgAllowance.OverSpend.selector, 1, 0));
        org.spendTo(subject, token, 1, 1, payee);
        vm.stopPrank();
        assertEq(usdc.balanceOf(payee), 100 ether);
        assertEq(usdc.balanceOf(treasuryAddr), 1_000_000 ether - 100 ether);
    }

    /// The token's own approval is the outer cap: a revert unwinds the ledger
    /// debit too (no half-recorded spend).
    function test_SpendTo_RevertsAtomicallyWhenTheTreasuryHasNotApproved() public {
        _wireTreasury(1_000 ether, 10 ether); // approval < the allowance
        vm.prank(spender);
        vm.expectRevert(); // TransferFromFailed
        org.spendTo(subject, token, 1, 30 ether, payee);
        assertEq(org.spentOf(subject, token, 1), 0, "no ledger debit survived the failed transfer");
        assertEq(usdc.balanceOf(payee), 0);
        // Within the approval it works.
        vm.prank(spender);
        org.spendTo(subject, token, 1, 10 ether, payee);
        assertEq(org.spentOf(subject, token, 1), 10 ether);
    }

    function test_SpendTo_OnlyTheSubjectsSpender() public {
        _wireTreasury(1_000 ether, 1_000 ether);
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(OrgAllowance.NotSpender.selector, attacker, subject));
        org.spendTo(subject, token, 1, 1, attacker);
        // The owner is not a spender either: it sets ceilings, it does not pay.
        vm.prank(ownerAddr);
        vm.expectRevert(abi.encodeWithSelector(OrgAllowance.NotSpender.selector, ownerAddr, subject));
        org.spendTo(subject, token, 1, 1, ownerAddr);
        // A revoked spender is out.
        vm.prank(ownerAddr);
        org.setSpender(subject, address(0));
        vm.prank(spender);
        vm.expectRevert(abi.encodeWithSelector(OrgAllowance.NotSpender.selector, spender, subject));
        org.spendTo(subject, token, 1, 1, payee);
    }

    function test_SpendTo_NeedsATreasuryAndSaneArguments() public {
        vm.prank(spender);
        vm.expectRevert(OrgAllowance.TreasuryNotSet.selector);
        org.spendTo(subject, token, 1, 1, payee);

        _wireTreasury(1_000 ether, 1_000 ether);
        vm.startPrank(spender);
        vm.expectRevert(abi.encodeWithSelector(OrgAllowance.BadRecipient.selector, address(0)));
        org.spendTo(subject, token, 1, 1, address(0));
        vm.expectRevert(abi.encodeWithSelector(OrgAllowance.BadToken.selector, address(0)));
        org.spendTo(subject, address(0), 1, 1, payee);
        vm.stopPrank();

        // Disabling the treasury turns the payout path off again.
        vm.prank(ownerAddr);
        org.setTreasury(address(0));
        vm.prank(spender);
        vm.expectRevert(OrgAllowance.TreasuryNotSet.selector);
        org.spendTo(subject, token, 1, 1, payee);
    }

    function test_SetTreasury_OwnerOnly() public {
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(OrgAllowance.NotOwner.selector, attacker));
        org.setTreasury(attacker);
        vm.prank(ownerAddr);
        vm.expectEmit(true, true, false, false, address(org));
        emit OrgAllowance.TreasurySet(address(0), treasuryAddr);
        org.setTreasury(treasuryAddr);
        assertEq(org.treasury(), treasuryAddr);
    }

    // ---------------------------------------------------------- setOwner

    function test_SetOwner_ZeroAddressReverts() public {
        vm.prank(ownerAddr);
        vm.expectRevert(OrgAllowance.ZeroAddress.selector);
        org.setOwner(address(0));
        assertEq(org.owner(), ownerAddr, "ownership was not bricked");
    }

    // ---------------------------------------------- setAllowance vs spent

    /// `setAllowance` used to accept any value, so an owner (or a DAO proposal)
    /// could set it under what was already spent and `remaining` would underflow.
    function test_SetAllowance_BelowSpentReverts_ExactError() public {
        vm.prank(spender);
        org.spend(subject, token, 1, 30 ether);
        vm.prank(ownerAddr);
        vm.expectRevert(abi.encodeWithSelector(OrgAllowance.BelowSpent.selector, 29 ether, 30 ether));
        org.setAllowance(subject, token, 1, 29 ether);
        // Exactly the spent amount is fine and leaves nothing to spend.
        vm.prank(ownerAddr);
        org.setAllowance(subject, token, 1, 30 ether);
        assertEq(org.remainingOf(subject, token, 1), 0);
        // Raising is always fine.
        vm.prank(ownerAddr);
        org.setAllowance(subject, token, 1, 500 ether);
        assertEq(org.remainingOf(subject, token, 1), 470 ether);
    }

    // ------------------------------------------------------- future epochs

    /// An agent must not pre-spend allowance the owner staged for a window that
    /// has not begun. Removing the `epoch > current` guard fails this test.
    function test_FutureEpoch_CannotBeSpent_ViaSpendOrSpendTo() public {
        _wireTreasury(1_000 ether, 1_000 ether);
        uint64 current = org.currentEpoch(subject);
        assertEq(current, 100, "epoch = timestamp / 86400");
        vm.prank(ownerAddr);
        org.setAllowance(subject, token, current + 1, 50 ether); // staged for tomorrow

        vm.startPrank(spender);
        vm.expectRevert(abi.encodeWithSelector(OrgAllowance.FutureEpoch.selector, current + 1, current));
        org.spend(subject, token, current + 1, 1 ether);
        vm.expectRevert(abi.encodeWithSelector(OrgAllowance.FutureEpoch.selector, current + 1, current));
        org.spendTo(subject, token, current + 1, 1 ether, payee);
        vm.stopPrank();
        assertEq(org.spentOf(subject, token, current + 1), 0);

        // The current epoch is fine, and tomorrow opens tomorrow.
        vm.prank(ownerAddr);
        org.setAllowance(subject, token, current, 5 ether);
        vm.prank(spender);
        org.spend(subject, token, current, 5 ether);
        vm.warp(NOW_TS + 86_400);
        assertEq(org.currentEpoch(subject), current + 1);
        vm.prank(spender);
        org.spendTo(subject, token, current + 1, 50 ether, payee);
        assertEq(usdc.balanceOf(payee), 50 ether);
    }

    function test_EpochSeconds_IsPerSubject_OwnerSet_AndNeverZero() public {
        assertEq(org.currentEpoch(subject), NOW_TS / 86_400, "default is a day");

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(OrgAllowance.NotOwner.selector, attacker));
        org.setEpochSeconds(subject, 3_600);
        vm.prank(ownerAddr);
        vm.expectRevert(abi.encodeWithSelector(OrgAllowance.BadEpochSeconds.selector, uint64(0)));
        org.setEpochSeconds(subject, 0);

        vm.prank(ownerAddr);
        org.setEpochSeconds(subject, 604_800); // weekly
        assertEq(org.currentEpoch(subject), NOW_TS / 604_800);
        // Another subject keeps the default.
        assertEq(org.currentEpoch(keccak256("other")), NOW_TS / 86_400);

        // Under a weekly length, "epoch 100" (daily numbering) is now in the far
        // future for this subject: the epoch domain re-based.
        vm.prank(spender);
        vm.expectRevert(
            abi.encodeWithSelector(OrgAllowance.FutureEpoch.selector, uint64(1_000), uint64(NOW_TS / 604_800))
        );
        org.spend(subject, token, 1_000, 0);
    }
}
