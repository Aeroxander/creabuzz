// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Math} from "oz5/utils/math/Math.sol";
import {StackBase} from "./helpers/StackBase.sol";
import {Treasury} from "../src/Treasury.sol";

/// @notice What a Team Share is worth, end to end: the whole pool granted, vested over 104 active units, claimed and left.
/// Only money above what backers put in is the team side's; later joins give the Team nothing.
contract TeamTest is StackBase {
    /// @dev A project with no allowance (so only the rules under test move money) whose whole pool vested in bob's hands.
    function _vestedTeam() internal returns (uint256 id) {
        _use(_launch(founder, "team", 0, POOL));
        id = _grant(bob, POOL);
        _active(104 * UNIT);
        v.claim(id);
        assertEq(team.balanceOf(bob), POOL);
    }

    function test_theTeamsClaimIsZeroWhilePotIsAtOrUnderPaidIn() public {
        uint256 id = _vestedTeam();
        _join(alice, 100_000e6);
        assertEq(t.pot(), t.paidIn(), "at paid-in");
        assertEq(t.teamValue(), 0);
        vm.prank(bob);
        vm.expectRevert(Treasury.NothingToPay.selector);
        t.leaveTeam(POOL, 0, bob);
        // spend the pot under paid-in (a leave takes some out, nothing lifts it)
        _leave(alice, shares.balanceOf(alice) / 2);
        assertEq(t.teamValue(), 0);
        vm.prank(bob);
        vm.expectRevert(Treasury.NothingToPay.selector);
        t.leaveTeam(POOL, 0, bob);
        assertEq(v.grantOf(id).claimed, POOL);
    }

    function test_theTeamsClaimIsTheStatedShareAboveWhatBackersPutIn() public {
        _vestedTeam();
        _join(alice, 100_000e6); // 98,000 in the pot, 9.8M Shares
        _revenue(carol, 20_000e6); // 20,000 from outside, arriving over one unit
        vm.warp(block.timestamp + UNIT);
        _checkIn();
        assertEq(t.pot(), 118_000e6);
        assertEq(t.paidIn(), 98_000e6);
        uint256 b = shares.totalSupply();
        assertEq(b, 9_800_000e18);
        // a Team Share is worth (pot - paid-in) / (backer Shares + Team Shares)
        uint256 expected = Math.mulDiv(1_000_000e18, 20_000e6, b + POOL);
        assertEq(expected, 1_010_101_010);
        vm.prank(bob);
        assertEq(t.leaveTeam(1_000_000e18, 0, bob), expected, "1,000,000 Team Shares leave with 1,010.10");
        // a backer Share is worth paid-in first, then the same slice of the surplus
        uint256 backer = Math.mulDiv(1_000_000e18, 98_000e6, b) + Math.mulDiv(1_000_000e18, 20_000e6, b + POOL);
        assertGt(backer, expected);
        // the team's leave left paid-in alone, so backers still hold their priority
        assertEq(t.paidIn(), 98_000e6);
    }

    function test_laterJoinsGiveTheTeamNothing() public {
        _vestedTeam();
        uint256 first = _join(alice, 10_000e6);
        uint256 paid = 10_000e6;
        for (uint256 i; i < 200; ++i) {
            _join(address(uint160(0x4000 + i)), 500e6);
            paid += 500e6;
        }
        assertEq(t.teamValue(), 0, "the Team's claim is zero");
        vm.prank(bob);
        vm.expectRevert(Treasury.NothingToPay.selector);
        t.leaveTeam(POOL, 0, bob);
        uint256 total = _leave(alice, first);
        for (uint256 i; i < 200; ++i) {
            address a = address(uint160(0x4000 + i));
            total += _leave(a, shares.balanceOf(a));
        }
        assertApproxEqAbs(total, paid * 98 / 100, 20e6, "backers get 98.00 per 100 paid");
        assertLe(total, paid * 98 / 100 + 20e6);
    }

    function test_onlyTheHoldersOwnTeamSharesLeave() public {
        _vestedTeam();
        _join(alice, 100_000e6);
        _revenue(carol, 20_000e6);
        vm.warp(block.timestamp + UNIT);
        _checkIn();
        // a stranger has none, and cannot spend bob's
        vm.prank(stranger);
        vm.expectRevert();
        t.leaveTeam(1e18, 0, stranger);
        uint256 before = team.balanceOf(bob);
        vm.prank(bob);
        t.leaveTeam(1000e18, 0, bob);
        assertEq(team.balanceOf(bob), before - 1000e18);
        assertEq(team.totalSupply(), POOL - 1000e18, "G falls by what left");
    }
}
