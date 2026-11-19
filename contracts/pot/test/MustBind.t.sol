// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {StackBase} from "./helpers/StackBase.sol";

/// @notice The must-bind tests of JOIN-LEAVE-DESIGN.md section 6 that read best through the real Launcher stack with money moved
/// the way it is moved in production (the others, and the pass A and B versions of these, live where REPORT lists them).
/// Each calls the production functions only: no harness, no forced storage.
contract MustBindTest is StackBase {
    /// @dev No. 2. The runner draws the box empty on day 10, the project idles to day 60, and then checks in: the box grows by
    /// the four days inside the old window (day 10 to the window's end on day 14), not to its seven-day cap. A `checkIn` that wrote
    /// `lastCheckIn` before it settled would count the whole lapse (up to the cap) and fail this.
    function test_no2_aLapseThenACheckInGrowsTheBoxByTheOldWindowOnly() public {
        _use(_launch(founder, "mb2", 2000, POOL)); // at the ceiling a late settle would fill the box to its cap
        _join(alice, 100_000e6);
        vm.warp(T0 + 10 days);
        t.settle();
        uint256 held = t.box();
        assertGt(held, 0);
        vm.prank(founder);
        t.draw(founder, held);
        uint256 p1 = t.pot();
        vm.warp(T0 + 60 days);
        _checkIn();
        uint256 fourDays = p1 * 2000 * 4 days / (1e6 * 1 days);
        assertApproxEqAbs(t.box(), fourDays, 2, "four days of accrual, no more");
        assertLt(t.box() * 100, t.boxCap() * 60, "about 4 of 7 days of the cap, not the cap a late settle would give");
        assertEq(t.lastCheckIn(), T0 + 60 days);
    }

    /// @dev No. 3. 200 equal holders, the pot SPENT (by the allowance, week after week, at the ceiling) to 60% of what they paid
    /// in, then they leave in a random order. The first and the last get the same per Share to the unit, and the cash of any two
    /// differs only by the rounding dust of 200 take-outs.
    /// forge-config: default.fuzz.runs = 8
    function testFuzz_no3_aRunAfterRealSpendingPaysFirstAndLastTheSame(uint256 seed) public {
        _use(_launch(founder, "mb3", 2000, POOL));
        uint256 count = 200;
        address[] memory holders = new address[](count);
        for (uint256 i; i < count; ++i) {
            holders[i] = address(uint160(0x7000 + i));
            _join(holders[i], 100e6);
        }
        uint256 each = shares.balanceOf(holders[0]);
        assertEq(each, 9800e18);
        for (uint256 w; w < 60 && t.pot() * 100 > t.paidIn() * 60; ++w) {
            _active(UNIT);
            t.settle();
            uint256 held = t.box();
            if (held > 0) {
                vm.prank(founder);
                t.draw(founder, held);
            }
        }
        assertLe(t.pot() * 100, t.paidIn() * 60 + t.paidIn(), "the pot was spent to about 60% of paid-in");
        assertLt(t.pot(), t.paidIn(), "the pot is under paid-in, so every backer is paid the same share of it");
        for (uint256 i = count - 1; i > 0; --i) {
            uint256 j = uint256(keccak256(abi.encode(seed, i))) % (i + 1);
            (holders[i], holders[j]) = (holders[j], holders[i]);
        }
        uint256 firstPerShare;
        uint256 lastPerShare;
        uint256 lo = type(uint256).max;
        uint256 hi;
        for (uint256 i; i < count; ++i) {
            uint256 cash = _leave(holders[i], each);
            uint256 perShare = cash * 1e18 / each;
            if (i == 0) firstPerShare = perShare;
            if (i == count - 1) lastPerShare = perShare;
            if (cash < lo) lo = cash;
            if (cash > hi) hi = cash;
        }
        uint256 gap = firstPerShare > lastPerShare ? firstPerShare - lastPerShare : lastPerShare - firstPerShare;
        assertLe(gap, 1, "per Share, in units, the first and the last leaver differ by at most one");
        assertLe(hi - lo, 8, "the spread is the rounding dust of 200 take-outs");
        assertEq(shares.totalSupply(), 0);
        assertEq(t.paidIn(), 0);
        _assertConserved();
    }

    /// @dev No. 10. With ghost sums kept outside the Treasury, every dollar in is in one bucket or was paid out, exactly, through
    /// joins, outside money, the allowance, take-outs, a Team take-out, fees and a wind-down.
    function test_no10_dollarsAreConservedExactly() public {
        uint256 inSum;
        uint256 outSum;
        uint256 n1 = _join(alice, 10_000e6);
        inSum += 10_000e6;
        _join(bob, 3_333_333_333);
        inSum += 3_333_333_333;
        _revenue(carol, 4000e6);
        inSum += 4000e6;
        vm.prank(founder);
        t.grantTeam(dave, 1_000_000e18);
        _active(14 * uint256(UNIT));
        v.claim(0);
        vm.warp(block.timestamp + 3 days);
        t.settle();
        uint256 box = t.box();
        vm.prank(founder);
        t.draw(founder, box);
        outSum += box;
        outSum += _leave(alice, n1 / 3);
        uint256 half = team.balanceOf(dave) / 2;
        vm.prank(dave);
        outSum += t.leaveTeam(half, 0, dave);
        uint256 owed = t.feesOwed();
        t.collectFees();
        outSum += owed;
        vm.prank(founder);
        t.windDown();
        vm.warp(block.timestamp + 2 * uint256(UNIT));
        outSum += _leave(bob, shares.balanceOf(bob));
        uint256 buckets = t.pot() + t.box() + t.arriving() + t.feesOwed();
        assertEq(usd.balanceOf(address(t)), inSum - outSum, "balance is dollars in less dollars out");
        assertEq(buckets, inSum - outSum, "and every one of them is in a bucket");
    }
}
