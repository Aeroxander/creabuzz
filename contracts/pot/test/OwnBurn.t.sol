// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {PotBase} from "./helpers/PotBase.sol";
import {ShareToken} from "../src/ShareToken.sol";

/// @notice Design section 6, must-bind 9: only the holder's own take-out can burn. A caller with no Shares, or fewer than
/// they name, cannot make `leave(n, minCash, to)` or `leaveTeam(n, minCash, to)` burn anyone else's, whatever `to` says: the
/// Treasury burns the CALLER's Shares and nothing else. Each test fails when `burnFor(msg.sender, n)` becomes `burnFor(to, n)`.
contract OwnBurnTest is PotBase {
    address internal victim = makeAddr("victim");

    function setUp() public override {
        super.setUp();
        _join(victim, 50_000e6);
        _join(alice, 1000e6);
        vm.prank(address(vester));
        team.transfer(victim, 1_000_000e18);
        // a surplus above paid-in so a Team take-out would pay
        _force(t.pot() + 20_000e6, t.paidIn(), t.box(), t.arriving(), t.arrivalEnd());
    }

    function test_aCallerWithNoSharesCannotBurnAnotherHoldersShares() public {
        uint256 victimShares = shares.balanceOf(victim);
        uint256 supply = shares.totalSupply();
        uint256 pot = t.pot();
        uint256 n = victimShares / 2;
        vm.prank(stranger);
        vm.expectRevert(ShareToken.InsufficientBalance.selector);
        t.leave(n, 0, victim);
        vm.prank(stranger);
        vm.expectRevert(ShareToken.InsufficientBalance.selector);
        t.leave(n, 0, stranger);
        assertEq(shares.balanceOf(victim), victimShares, "the victim's Shares are untouched");
        assertEq(shares.totalSupply(), supply);
        assertEq(t.pot(), pot, "and no money moved");
        assertEq(usd.balanceOf(victim), 0);
    }

    function test_aCallerWithFewerSharesThanTheyNameCannotBurnTheDifferenceFromAnother() public {
        uint256 mine = shares.balanceOf(alice);
        uint256 victimShares = shares.balanceOf(victim);
        vm.prank(alice);
        vm.expectRevert(ShareToken.InsufficientBalance.selector);
        t.leave(mine + 1, 0, victim);
        assertEq(shares.balanceOf(alice), mine);
        assertEq(shares.balanceOf(victim), victimShares);
    }

    function test_aCallerWithNoTeamSharesCannotBurnAnotherHoldersTeamShares() public {
        uint256 victimTeam = team.balanceOf(victim);
        uint256 supply = team.totalSupply();
        uint256 pot = t.pot();
        vm.prank(stranger);
        vm.expectRevert(ShareToken.InsufficientBalance.selector);
        t.leaveTeam(victimTeam / 2, 0, victim);
        vm.prank(alice);
        vm.expectRevert(ShareToken.InsufficientBalance.selector);
        t.leaveTeam(victimTeam / 2, 0, victim);
        assertEq(team.balanceOf(victim), victimTeam);
        assertEq(team.totalSupply(), supply);
        assertEq(t.pot(), pot);
    }

    function test_theHoldersOwnTakeOutStillBurnsTheirOwnAndPaysWhomTheyName() public {
        uint256 n = shares.balanceOf(victim) / 2;
        uint256 before_ = shares.balanceOf(victim);
        vm.prank(victim);
        uint256 cash = t.leave(n, 0, stranger);
        assertGt(cash, 0);
        assertEq(shares.balanceOf(victim), before_ - n);
        assertEq(usd.balanceOf(stranger), cash);
        uint256 tn = team.balanceOf(victim) / 2;
        vm.prank(victim);
        uint256 tc = t.leaveTeam(tn, 0, stranger);
        assertGt(tc, 0);
        assertEq(team.balanceOf(victim), 500_000e18);
    }
}
