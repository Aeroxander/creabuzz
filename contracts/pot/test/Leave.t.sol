// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {PotBase} from "./helpers/PotBase.sol";
import {Treasury} from "../src/Treasury.sol";
import {ShareToken} from "../src/ShareToken.sol";

contract LeaveTest is PotBase {
    function test_leaveBurnsPaysAndCutsPaidIn() public {
        uint256 n = _join(alice, 100e6); // pot 98, paid-in 98
        uint256 half = n / 2;
        vm.expectEmit(true, true, false, true, address(t));
        emit Treasury.Left(alice, alice, half, 49e6, 0, 49e6, 49e6, n - half);
        uint256 cash = _leave(alice, half);
        assertEq(cash, 49e6);
        assertEq(usd.balanceOf(alice), 49e6);
        assertEq(shares.balanceOf(alice), n - half);
        assertEq(shares.totalSupply(), n - half);
        assertEq(t.pot(), 49e6);
        assertEq(t.paidIn(), 49e6);
    }

    function test_aboveTheMoneyPutInTheSurplusIsSharedWithTeamShares() public {
        uint256 n = _join(alice, 100e6);
        _force(150e6, 98e6, 0, 0, 0); // 52 above what backers put in
        uint256 half = n / 2;
        uint256 expected = half * 98e6 / n + half * 52e6 / (n + POOL);
        assertEq(_leave(alice, half), expected);
        assertEq(t.paidIn(), 98e6 - 98e6 * half / n);
    }

    function test_minCashGuard() public {
        uint256 n = _join(alice, 100e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Treasury.TooLittleCash.selector, 98e6 + 1, 98e6));
        t.leave(n, 98e6 + 1, alice);
        vm.prank(alice);
        t.leave(n, 98e6, alice);
    }

    function test_zeroCashIsRefused() public {
        _join(alice, 100e6);
        vm.prank(alice);
        vm.expectRevert(Treasury.NothingToPay.selector);
        t.leave(1, 0, alice); // one wei of a Share is worth under one unit of a dollar
    }

    function test_badAmounts() public {
        uint256 n = _join(alice, 100e6);
        uint256 m = _join(bob, 100e6);
        vm.startPrank(alice);
        vm.expectRevert(Treasury.BadInput.selector);
        t.leave(0, 0, alice);
        vm.expectRevert(Treasury.BadInput.selector);
        t.leave(n + m + 1, 0, alice); // more than exist
        vm.expectRevert(ShareToken.InsufficientBalance.selector);
        t.leave(n + 1, 0, alice); // more than alice holds: Bob's Shares cannot be burnt by Alice
        vm.stopPrank();
        assertEq(shares.balanceOf(bob), m);
    }

    /// @dev Binds the burn seam at the Treasury: a leave burns the caller's own Shares and nobody else's.
    function test_onlyTheCallersOwnSharesAreBurnt() public {
        uint256 n = _join(alice, 100e6);
        uint256 m = _join(bob, 100e6);
        _leave(bob, m / 2);
        assertEq(shares.balanceOf(alice), n);
        assertEq(shares.balanceOf(bob), m - m / 2);
    }

    function test_lastLeaverClearsPaidInAndTheDustStaysSmall() public {
        uint256 n1 = _join(alice, 100e6 + 7);
        uint256 n2 = _join(bob, 333_333_333);
        uint256 n3 = _join(carol, 12_345_678);
        _leave(bob, n2);
        _leave(alice, n1);
        _leave(carol, n3);
        assertEq(shares.totalSupply(), 0);
        assertEq(t.paidIn(), 0, "B == 0 means paid-in is 0");
        assertLt(t.pot(), 10, "a few units of rounding dust at most");
        _assertConserved();
        // the next first joiner still pays about one cent a Share
        uint256 n = _join(alice, 100e6);
        assertApproxEqRel(n, 9800e18, 1e13);
    }

    function test_leaveDoesNotTouchTheBoxTheArrivingMoneyOrTheFees() public {
        uint256 n = _join(alice, 100e6);
        _force(98e6, 98e6, 500_000, 7e6, uint64(block.timestamp + UNIT)); // under the box cap of 0.70%
        t.forceFees(2e6);
        uint256 rel = 0;
        _leave(alice, n / 2);
        assertEq(t.box(), 500_000);
        assertEq(t.arriving(), 7e6 - rel);
        assertEq(t.feesOwed(), 2e6);
        _assertConserved();
    }

    function test_leaveNeedsNoAllowanceAndNoDoor() public {
        uint256 n = _join(alice, 100e6);
        assertEq(shares.allowance(alice, address(t)), 0);
        vm.prank(founder);
        t.setDoor(false);
        vm.warp(block.timestamp + 3 * UNIT); // quiet: the window has closed
        assertFalse(t.doorOpenNow());
        assertGt(_leave(alice, n / 3), 0);
        vm.warp(block.timestamp + 30 * UNIT);
        vm.prank(stranger);
        t.windDown(); // wound down after quiet
        assertGt(_leave(alice, n / 3), 0);
        assertGt(_leave(alice, shares.balanceOf(alice)), 0);
    }

    function test_cashGoesToTheNamedAddress() public {
        uint256 n = _join(alice, 100e6);
        vm.prank(alice);
        t.leave(n, 0, bob);
        assertEq(usd.balanceOf(bob), 98e6);
        assertEq(usd.balanceOf(alice), 0);
    }

    /// @dev Must-bind 3: 200 equal holders, the pot spent down to 60% of paid-in, leaving in random order. First and last
    /// leaver get the same per Share (to six decimals of a dollar); the totals differ by the rounding dust only.
    /// forge-config: default.fuzz.runs = 12
    function testFuzz_aRunPaysFirstAndLastTheSame(uint256 seed) public {
        uint256 count = 200;
        address[] memory holders = new address[](count);
        for (uint256 i; i < count; ++i) {
            holders[i] = address(uint160(0x1000 + i));
            _join(holders[i], 100e6);
        }
        uint256 each = shares.balanceOf(holders[0]);
        assertEq(each, 9800e18);
        _force(t.paidIn() * 60 / 100, t.paidIn(), 0, 0, 0);
        for (uint256 i = count - 1; i > 0; --i) {
            uint256 j = uint256(keccak256(abi.encode(seed, i))) % (i + 1);
            (holders[i], holders[j]) = (holders[j], holders[i]);
        }
        uint256 first;
        uint256 last;
        uint256 lo = type(uint256).max;
        uint256 hi;
        for (uint256 i; i < count; ++i) {
            uint256 cash = _leave(holders[i], each);
            if (i == 0) first = cash;
            if (i == count - 1) last = cash;
            if (cash < lo) lo = cash;
            if (cash > hi) hi = cash;
        }
        assertEq(first / 1e3, last / 1e3, "per Share to six decimals: 0.006000");
        assertLe(hi - lo, 8, "the spread is the rounding dust of 200 leaves");
        assertEq(shares.totalSupply(), 0);
        assertEq(t.paidIn(), 0);
        assertLt(t.pot(), 10);
        _assertConserved();
    }
}
