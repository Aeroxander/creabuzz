// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {RoundsBase} from "./helpers/RoundsBase.sol";
import {Vester} from "../src/Vester.sol";

/// @notice The Vester's backer grants on their own: only the project's Rounds adds and cancels them, a cancel takes the grant off
/// the clock (so cancelled Shares never stay counted as unreleased), and a grant with nothing held cannot be cancelled again.
contract VesterHeldTest is RoundsBase {
    function test_onlyTheRoundsAddAndCancelBackerGrants() public {
        vm.prank(stranger);
        vm.expectRevert(Vester.NotAllowed.selector);
        v.grantHeld(1, alice, 1);
        vm.prank(address(t));
        vm.expectRevert(Vester.NotAllowed.selector);
        v.grantHeld(1, alice, 1); // not even the treasury
        uint256 id = _round(alice, 100 * DOLLAR);
        vm.prank(stranger);
        vm.expectRevert(Vester.NotAllowed.selector);
        v.cancelHeld(id, alice);
        vm.prank(founder);
        vm.expectRevert(Vester.NotAllowed.selector);
        v.cancelHeld(id, alice);
        (uint256 total,) = v.heldGrants(id, alice);
        assertEq(total, 300_000 * SHARE, "still held");
    }

    function test_aCancelTakesTheGrantOffTheClock() public {
        uint256 id = _round(alice, 100 * DOLLAR);
        assertEq(v.granted(), 200_000_000 * SHARE + 300_000 * SHARE);
        assertEq(v.unreleased(), v.granted());
        _refund(id, alice);
        assertEq(v.granted(), 200_000_000 * SHARE, "the cancelled grant left the clock");
        assertEq(v.unreleased(), 200_000_000 * SHARE);
        assertEq(v.committed(), 200_000_000 * SHARE);
        // after the market a backer who took Shares out and then refunds: the whole grant leaves the clock, what was taken out is
        // in their hands and counts, and nothing is counted twice
        uint256 id2 = _round(bob, 1000 * DOLLAR);
        _sale(7500 * DOLLAR);
        _live(73 days);
        vm.prank(bob);
        v.claimHeld(id2, bob);
        _refund(id2, bob);
        assertLe(v.unreleased(), v.committed(), "nothing unreleased is missing from the Vester");
        assertEq(
            t.countingSupply(),
            shares.totalSupply() - shares.balanceOf(address(t)) - shares.balanceOf(rounds) - shares.balanceOf(finisher)
                - v.unreleased()
        );
        (uint256 total, uint256 claimed) = v.heldGrants(id2, bob);
        assertEq(total, claimed, "the grant is closed at what was taken out");
        assertEq(v.claimableHeld(id2, bob), 0);
        _live(365 days);
        assertEq(v.claimableHeld(id2, bob), 0, "and never releases again");
    }

    function test_aGrantWithNothingHeldCannotBeCancelledTwice() public {
        uint256 id = _round(alice, 100 * DOLLAR);
        vm.prank(rounds);
        v.cancelHeld(id, alice);
        uint256 granted = v.granted();
        vm.prank(rounds);
        vm.expectRevert(Vester.NothingHeld.selector);
        v.cancelHeld(id, alice);
        assertEq(v.granted(), granted, "the clock was not touched twice");
        vm.prank(rounds);
        vm.expectRevert(Vester.NothingHeld.selector);
        v.cancelHeld(id, bob); // never granted
    }
}
