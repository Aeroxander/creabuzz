// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {StackBase} from "./helpers/StackBase.sol";
import {Treasury} from "../src/Treasury.sol";
import {Pair} from "../src/Pair.sol";
import {Vester} from "../src/Vester.sol";

/// @notice Old consent is not consent. A Pair proposal and a seat offer both die after a while, a seat offer can be
/// withdrawn, and an agent cannot use up a member's grant slots with dust.
contract ExpiryTest is StackBase {
    function _proposeDraw() internal returns (Pair pair, bytes memory data, uint256 n) {
        _join(alice, 100_000e6);
        pair = _makePair(bob);
        vm.warp(block.timestamp + 5 days);
        _checkIn();
        n = pair.nonce();
        data = abi.encodeCall(Treasury.draw, (carol, 500e6));
        vm.prank(founder);
        pair.propose(address(t), data);
    }

    /// A year-old approval moved 500 dollars before: the founder proposed, never cancelled, and the other signer confirmed
    /// a year later with no fresh say from the founder.
    function test_aPairProposalDiesAfterItsWindow() public {
        (Pair pair, bytes memory data, uint256 n) = _proposeDraw();
        uint256 start = block.timestamp;
        for (uint256 i = 1; i <= 52; ++i) {
            vm.warp(start + i * 7 days); // an absolute time: the optimizer may cache a repeated block.timestamp
            vm.prank(bob);
            pair.checkIn(bytes32(0));
        }
        assertGe(t.box(), 500e6, "the box has refilled");
        vm.prank(bob);
        vm.expectRevert(Pair.Expired.selector);
        pair.confirm(address(t), data, n);
        assertEq(usd.balanceOf(carol), 0);
    }

    function test_aPairProposalWorksUpToTheEndOfItsWindow() public {
        (Pair pair, bytes memory data, uint256 n) = _proposeDraw();
        uint256 at = pair.proposedAt(pair.callId(address(t), data, n));
        vm.warp(at + pair.PROPOSAL_TTL());
        _checkIn(); // keep the project active
        vm.prank(bob);
        pair.confirm(address(t), data, n);
        assertEq(usd.balanceOf(carol), 500e6);
    }

    function test_aProposalOneSecondTooOldIsRefusedAndCanBeProposedAgain() public {
        (Pair pair, bytes memory data, uint256 n) = _proposeDraw();
        bytes32 id = pair.callId(address(t), data, n);
        vm.warp(pair.proposedAt(id) + pair.PROPOSAL_TTL() + 1);
        _checkIn();
        vm.prank(bob);
        vm.expectRevert(Pair.Expired.selector);
        pair.confirm(address(t), data, n);
        // a fresh proposal of the same call works, with fresh consent
        uint256 n2 = pair.nonce();
        vm.prank(founder);
        pair.propose(address(t), data);
        vm.prank(bob);
        pair.confirm(address(t), data, n2);
        assertEq(usd.balanceOf(carol), 500e6);
    }

    /// The runner offered the seat and changed their mind: before, re-offering to oneself reverted and the offer stood for
    /// ever.
    function test_aSeatOfferCanBeWithdrawn() public {
        vm.prank(founder);
        t.handOver(bob, false);
        vm.prank(founder);
        t.handOver(address(0), false);
        assertEq(t.pendingRunner(), address(0));
        assertEq(t.pendingSeatAt(), 0);
        vm.prank(bob);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.takeSeat();
        assertEq(t.runner(), founder);
    }

    function test_aSeatOfferDiesAfterTwoUnits() public {
        vm.prank(founder);
        t.handOver(bob, false);
        vm.warp(block.timestamp + 730 days);
        vm.prank(bob);
        vm.expectRevert(Treasury.OfferExpired.selector);
        t.takeSeat();
        assertEq(t.runner(), founder);
    }

    function test_aSeatOfferWorksUpToTwoUnitsAndANewOfferRestartsTheClock() public {
        vm.prank(founder);
        t.handOver(bob, false);
        uint256 end = block.timestamp + 2 * UNIT;
        vm.warp(end);
        vm.prank(bob);
        t.takeSeat();
        assertEq(t.runner(), bob);
        // a fresh offer is stamped afresh
        vm.warp(end + 100 days);
        vm.prank(bob);
        t.handOver(carol, false);
        vm.warp(block.timestamp + 2 * UNIT + 1);
        vm.prank(carol);
        vm.expectRevert(Treasury.OfferExpired.selector);
        t.takeSeat();
    }

    function test_onlyTheRunnerCanWithdrawAnOffer() public {
        vm.prank(founder);
        t.handOver(bob, false);
        vm.prank(carol);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.handOver(address(0), false);
        assertEq(t.pendingRunner(), bob);
    }

    /// An agent (inside its limits) filled a member's 8 grant slots with dust, and the runner could never grant to that
    /// address again. A grant is now at least one whole Team Share.
    function test_anAgentCannotFillAMembersGrantSlotsWithDust() public {
        address agent = makeAddr("agent");
        vm.prank(founder);
        t.authoriseAgent(agent);
        vm.prank(agent);
        vm.expectRevert(Vester.BadGrant.selector);
        t.grantTeam(carol, 1);
        vm.prank(agent);
        vm.expectRevert(Vester.BadGrant.selector);
        t.grantTeam(carol, 1e18 - 1);
        vm.prank(agent);
        t.grantTeam(carol, 1e18);
    }
}
