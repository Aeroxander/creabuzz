// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {PotBase} from "./helpers/PotBase.sol";
import {Treasury} from "../src/Treasury.sol";
import {ShareToken} from "../src/ShareToken.sol";

contract LeaveTeamTest is PotBase {
    function _giveTeam(address to, uint256 n) internal {
        vm.prank(address(vester));
        team.transfer(to, n);
    }

    function test_teamShareClaimsOnlyAboveWhatBackersPutIn() public {
        _join(alice, 100e6);
        _giveTeam(bob, 1_000_000e18);
        _force(120e6, 98e6, 0, 0, 0); // 22 above paid-in
        uint256 b = shares.totalSupply();
        uint256 expected = 1_000_000e18 * 22e6 / (b + POOL);
        vm.expectEmit(true, true, false, true, address(t));
        emit Treasury.TeamLeft(bob, bob, 1_000_000e18, expected, 0, 120e6 - expected, POOL - 1_000_000e18);
        vm.prank(bob);
        assertEq(t.leaveTeam(1_000_000e18, 0, bob), expected);
        assertEq(usd.balanceOf(bob), expected);
        assertEq(t.paidIn(), 98e6, "paid-in is untouched");
        assertEq(team.totalSupply(), POOL - 1_000_000e18, "G falls");
        assertEq(team.balanceOf(bob), 0);
    }

    function test_nothingIsPaidWhenThePotIsAtOrUnderPaidIn() public {
        _join(alice, 100e6);
        _giveTeam(bob, 1_000_000e18);
        vm.prank(bob);
        vm.expectRevert(Treasury.NothingToPay.selector);
        t.leaveTeam(1_000_000e18, 0, bob);
        _force(60e6, 98e6, 0, 0, 0);
        vm.prank(bob);
        vm.expectRevert(Treasury.NothingToPay.selector);
        t.leaveTeam(1_000_000e18, 0, bob);
        assertEq(team.balanceOf(bob), 1_000_000e18, "nothing burnt on a refusal");
    }

    function test_onlyShareYouHoldCanLeave() public {
        _join(alice, 100e6);
        _force(120e6, 98e6, 0, 0, 0);
        vm.prank(stranger);
        vm.expectRevert(ShareToken.InsufficientBalance.selector);
        t.leaveTeam(1e18, 0, stranger);
        vm.prank(alice); // backer Shares are not Team Shares
        vm.expectRevert(ShareToken.InsufficientBalance.selector);
        t.leaveTeam(1e18, 0, alice);
    }

    function test_guards() public {
        _join(alice, 100e6);
        _giveTeam(bob, 1_000_000e18);
        _force(120e6, 98e6, 0, 0, 0);
        vm.startPrank(bob);
        vm.expectRevert(Treasury.BadInput.selector);
        t.leaveTeam(0, 0, bob);
        vm.expectRevert(Treasury.BadInput.selector);
        t.leaveTeam(POOL + 1, 0, bob);
        vm.expectRevert(); // TooLittleCash
        t.leaveTeam(1_000_000e18, 1e12, bob);
        vm.stopPrank();
    }

    function test_aTeamLeaveDoesNotMoveWhatBackersGet() public {
        uint256 n = _join(alice, 100e6);
        _giveTeam(bob, 1_000_000e18);
        _force(120e6, 98e6, 0, 0, 0);
        uint256 before = t.leaveValue();
        vm.prank(bob);
        t.leaveTeam(1_000_000e18, 0, bob);
        assertApproxEqAbs(t.leaveValue(), before, 1, "a Share still gets what it got, within a unit");
        assertGt(_leave(alice, n), 0);
    }

    function test_afterEveryBackerLeftTheTeamSharesSharePotDust() public {
        uint256 n = _join(alice, 100e6);
        _leave(alice, n);
        _force(5e6, 0, 0, 0, 0); // paid-in is zero now: the whole pot is surplus
        _giveTeam(bob, POOL);
        vm.prank(bob);
        assertEq(t.leaveTeam(POOL, 0, bob), 5e6);
    }

    function test_teamSupplyNeverRises() public {
        _join(alice, 100e6);
        _giveTeam(bob, 5e18);
        _revenue(carol, 1_000e6);
        vm.warp(block.timestamp + 5 days);
        _join(bob, 500e6);
        _leave(alice, shares.balanceOf(alice) / 2);
        assertEq(team.totalSupply(), POOL);
        // and the Treasury has no function that could mint Team Shares
        (bool ok,) = address(t).call(abi.encodeWithSignature("mint(address,uint256)", bob, 1));
        assertFalse(ok);
    }
}
