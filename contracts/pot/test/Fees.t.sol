// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {PotBase} from "./helpers/PotBase.sol";
import {Treasury} from "../src/Treasury.sol";

contract FeesTest is PotBase {
    function test_feesAreOwedThenCollected() public {
        _join(alice, 100e6);
        _join(bob, 1_000_001);
        assertEq(t.feesOwed(), 2e6 + 20_001);
        assertEq(usd.balanceOf(platform), 0);
        vm.expectEmit(true, false, false, true, address(t));
        emit Treasury.FeesCollected(platform, 2e6 + 20_001);
        vm.prank(stranger); // anyone may send it
        t.collectFees();
        assertEq(usd.balanceOf(platform), 2e6 + 20_001);
        assertEq(t.feesOwed(), 0);
        assertEq(t.unaccounted(), 0);
        vm.expectRevert(Treasury.NothingToPay.selector);
        t.collectFees();
    }

    function test_aBlockedPlatformAddressCannotBlockJoinOrLeave() public {
        uint256 n = _join(alice, 100e6);
        usd.setBlocked(platform, true);
        vm.expectRevert();
        t.collectFees();
        assertEq(t.feesOwed(), 2e6, "the fee stays owed");
        uint256 m = _join(bob, 100e6);
        assertEq(_leave(alice, n), 98e6);
        assertGt(_leave(bob, m), 0);
        usd.setBlocked(platform, false);
        t.collectFees();
        assertEq(usd.balanceOf(platform), 4e6);
    }

    function test_noFeeOnLeaveOnRevenueOrOnDraw() public {
        uint256 n = _join(alice, 100_000e6);
        _revenue(carol, 5_000e6);
        vm.warp(T0 + 1 days);
        uint256 owed = t.feesOwed();
        _leave(alice, n / 2);
        assertEq(t.feesOwed(), owed);
        vm.prank(founder);
        t.draw(bob, 1e6);
        assertEq(t.feesOwed(), owed);
    }

    function test_feeIsChargedOnWhatArrived() public {
        _relaunch(POOL, 1000);
        _join(alice, 50e6);
        assertEq(t.feeFor(50e6), 1e6);
        assertEq(t.feesOwed(), 1e6);
    }
}
