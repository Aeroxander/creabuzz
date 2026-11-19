// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Math} from "oz5/utils/math/Math.sol";
import {PotBase} from "./helpers/PotBase.sol";
import {Treasury} from "../src/Treasury.sol";

contract AllowanceTest is PotBase {
    uint256 internal constant P0 = 98_000e6; // a 100,000 join after the 2% fee

    function setUp() public override {
        super.setUp();
        _join(alice, 100_000e6);
    }

    function _accrual(uint256 pot, uint256 ppm, uint256 secs) internal pure returns (uint256) {
        return Math.mulDiv(pot, ppm * secs, 1e6 * 1 days);
    }

    // ---- accrual and the cap

    function test_accruesLinearlyOnThePot() public {
        vm.warp(T0 + 1 days);
        t.settle();
        assertEq(t.box(), 98e6, "0.10% of 98,000 in a day");
        assertEq(t.pot(), P0 - 98e6);
        vm.warp(T0 + 3 days);
        t.settle(); // linear between settles, on the pot as it stood at the last settle
        assertEq(t.box(), 98e6 + _accrual(P0 - 98e6, 1000, 2 days));
    }

    function test_sevenDaysAtDefaultIsZeroPointSevenPercent() public {
        vm.warp(T0 + 7 days);
        t.settle();
        assertEq(t.box(), 686e6, "0.70% of 98,000");
        assertEq(t.boxCap(), 686e6, "a second settle in the same second moves nothing");
        t.settle();
        assertEq(t.box(), 686e6);
        assertEq(t.pot(), P0 - 686e6);
    }

    function test_theBoxIsCappedAtSevenDaysOfAccrual() public {
        vm.warp(T0 + 14 days - 1); // the whole window idle in one settle
        t.settle();
        assertEq(t.box(), 686e6, "not 1.40%: the cap is seven days");
        assertEq(t.pot(), P0 - 686e6);
    }

    function test_atTheCeilingTheBoxHoldsOnePointFourPercent() public {
        _relaunch(POOL, 2000);
        _join(alice, 100_000e6);
        vm.warp(T0 + 14 days - 1);
        t.settle();
        assertEq(t.box(), 1_372e6, "1.40% of 98,000");
    }

    function test_theBoxStaysUnderItsCapAfterAnySettle() public {
        for (uint256 i; i < 12; ++i) {
            vm.warp(block.timestamp + 40 hours);
            if (i % 3 == 0) _checkIn();
            t.settle();
            assertLe(t.box(), t.boxCap());
            _assertConserved();
        }
    }

    function test_loweringTheRateReturnsTheExcessToThePot() public {
        vm.warp(T0 + 7 days);
        t.settle();
        assertEq(t.box(), 686e6);
        vm.prank(founder);
        t.setRate(500);
        t.settle();
        assertEq(t.box(), 343e6, "cut to seven days at the new rate");
        assertEq(t.box() + t.pot(), P0, "money is conserved: the cut goes back to the pot");
    }

    // ---- rate rules

    function test_lowerIsImmediateRaiseWaitsOneUnit() public {
        vm.prank(founder);
        t.setRate(400);
        assertEq(t.ratePpm(), 400);
        vm.prank(founder);
        t.proposeRate(900);
        assertEq(t.pendingRatePpm(), 900);
        assertEq(t.ratePpm(), 400);
        vm.warp(T0 + UNIT - 1);
        vm.expectRevert(abi.encodeWithSelector(Treasury.NotYet.selector, T0 + UNIT));
        t.applyRate();
        vm.warp(T0 + UNIT);
        vm.prank(stranger); // anyone may apply
        t.applyRate();
        assertEq(t.ratePpm(), 900);
        assertEq(t.pendingAt(), 0);
    }

    function test_aNewProposalRestartsTheWait() public {
        vm.prank(founder);
        t.proposeRate(1500);
        vm.warp(T0 + 3 days);
        _checkIn();
        vm.prank(founder);
        t.proposeRate(2000);
        vm.warp(T0 + UNIT);
        vm.expectRevert(abi.encodeWithSelector(Treasury.NotYet.selector, T0 + 3 days + UNIT));
        t.applyRate();
        vm.warp(T0 + 3 days + UNIT);
        t.applyRate();
        assertEq(t.ratePpm(), 2000);
    }

    function test_theCeilingAndTheDirectionOfEachCall() public {
        vm.startPrank(founder);
        vm.expectRevert(Treasury.BadInput.selector);
        t.proposeRate(2001); // over the ceiling
        vm.expectRevert(Treasury.BadInput.selector);
        t.proposeRate(1000); // not a raise
        vm.expectRevert(Treasury.BadInput.selector);
        t.setRate(1000); // not a lowering
        vm.expectRevert(Treasury.BadInput.selector);
        t.setRate(1500);
        t.proposeRate(2000); // the ceiling itself is allowed
        vm.stopPrank();
    }

    function test_applyRateWithNothingPendingReverts() public {
        vm.expectRevert(Treasury.BadInput.selector);
        t.applyRate();
    }

    function test_loweringClearsAPendingRaise() public {
        vm.startPrank(founder);
        t.proposeRate(2000);
        t.setRate(500);
        vm.stopPrank();
        assertEq(t.pendingAt(), 0);
        vm.warp(T0 + UNIT);
        vm.expectRevert(Treasury.BadInput.selector);
        t.applyRate();
        assertEq(t.ratePpm(), 500);
    }

    function test_onlyTheRunnerSetsTheRate() public {
        vm.startPrank(stranger);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.proposeRate(2000);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.setRate(1);
        vm.stopPrank();
    }

    // ---- draw

    function test_drawLimitsAndEvent() public {
        vm.warp(T0 + 1 days);
        vm.startPrank(founder);
        vm.expectEmit(true, true, false, true, address(t));
        emit Treasury.AllowanceDrawn(founder, bob, 90e6, 8e6);
        t.draw(bob, 90e6);
        assertEq(usd.balanceOf(bob), 90e6);
        vm.expectRevert(abi.encodeWithSelector(Treasury.TooMuch.selector, 8e6 + 1, 8e6));
        t.draw(bob, 8e6 + 1);
        vm.expectRevert(Treasury.BadInput.selector);
        t.draw(bob, 0);
        vm.expectRevert(Treasury.BadInput.selector);
        t.draw(address(0), 1);
        vm.expectRevert(Treasury.BadInput.selector);
        t.draw(address(t), 1);
        vm.expectRevert(Treasury.BadInput.selector);
        t.draw(address(shares), 1);
        vm.expectRevert(Treasury.BadInput.selector);
        t.draw(address(team), 1);
        vm.expectRevert(Treasury.BadInput.selector);
        t.draw(address(vester), 1);
        vm.stopPrank();
        _assertConserved();
    }

    function test_onlyTheRunnerDraws() public {
        vm.warp(T0 + 1 days);
        vm.prank(stranger);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.draw(stranger, 1);
        vm.prank(alice);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.draw(alice, 1);
    }

    function test_drawCannotReachThePotOrTheArrivingMoney() public {
        _revenue(carol, 50_000e6);
        vm.warp(T0 + 1 days);
        vm.prank(founder);
        vm.expectRevert();
        t.draw(founder, 99e6 + 1); // one unit over the box
    }

    // ---- settle runs first (must-bind 2)

    /// @dev The runner draws the box empty on day 10, the project idles to day 60, then checks in. The box grows by the
    /// time inside the OLD window only (days 10 to 14), not to the cap. If `lastCheckIn` were written before the settle
    /// the whole lapse would count and the box would be the cap.
    function test_checkInSettlesBeforeItMovesTheWindow() public {
        vm.warp(T0 + 10 days);
        t.settle();
        uint256 drawn = t.box();
        assertEq(drawn, 686e6);
        vm.prank(founder);
        t.draw(bob, drawn);
        uint256 p1 = t.pot();
        vm.warp(T0 + 60 days);
        _checkIn();
        assertEq(t.box(), _accrual(p1, 1000, 4 days), "four days inside the old window");
        assertLt(t.box(), t.boxCap(), "and not the cap, which is what a late settle would give");
        assertEq(t.lastCheckIn(), T0 + 60 days);
    }

    function test_drawSettlesFirst() public {
        vm.warp(T0 + 10 days);
        vm.prank(founder);
        t.draw(bob, 686e6); // settle happens inside the draw: the box is full
        uint256 p1 = t.pot();
        vm.warp(T0 + 60 days);
        uint256 inside = _accrual(p1, 1000, 4 days);
        vm.prank(founder);
        t.draw(bob, inside); // the four days inside the window are there to draw
        vm.prank(founder);
        vm.expectRevert(); // and nothing of the lapse
        t.draw(bob, 1_000_000);
    }

    function test_setRateSettlesFirstAtTheOldRate() public {
        vm.warp(T0 + 60 days);
        vm.prank(founder);
        t.setRate(0);
        assertEq(t.box(), 686e6, "the window's days were paid at the old rate before the rate fell");
    }

    function test_applyRateSettlesFirstAtTheOldRate() public {
        vm.prank(founder);
        t.proposeRate(2000);
        vm.warp(T0 + 7 days);
        t.applyRate();
        assertEq(t.ratePpm(), 2000);
        assertEq(t.box(), 686e6, "seven days at 0.10%, not at the new 0.20%");
    }

    function test_proposeRateSettlesFirst() public {
        vm.warp(T0 + 5 days);
        vm.prank(founder);
        t.proposeRate(2000);
        assertEq(t.lastSettle(), T0 + 5 days);
        assertEq(t.box(), _accrual(P0, 1000, 5 days));
    }

    // ---- quiet

    function test_quietStopsTheAllowanceAndTheClock() public {
        vm.warp(T0 + 14 days);
        t.settle();
        assertEq(t.activeSeconds(), 14 days);
        uint256 held = t.box();
        vm.prank(founder);
        t.draw(bob, held);
        vm.warp(T0 + 30 days);
        t.settle();
        assertEq(t.box(), 0, "nothing accrues once the window is over");
        assertEq(t.activeSeconds(), 14 days);
        assertEq(t.activeNow(), 14 days);
        // a check-in revives it, and the lapse is not paid back
        _checkIn();
        vm.warp(T0 + 31 days);
        t.settle();
        assertEq(t.activeSeconds(), 15 days);
        assertGt(t.box(), 0);
        assertLt(t.box(), 2 * _accrual(P0, 1000, 1 days));
    }

    function test_activeNowCountsTheSliceSinceTheLastSettle() public {
        vm.warp(T0 + 3 days);
        assertEq(t.activeNow(), 3 days);
        assertEq(t.activeSeconds(), 0);
    }

    function test_accrualStopsAtTheLastSecondOfTheWindow() public {
        vm.warp(T0 + 14 days + 5);
        t.settle();
        assertEq(t.activeSeconds(), 14 days);
    }

    function testFuzz_idleThenCheckInGrowsTheBoxByAtMostTheTimeInsideTheOldWindow(uint256 idle, uint256 drawAt) public {
        drawAt = bound(drawAt, 1 hours, 13 days);
        idle = bound(idle, 14 days, 400 days);
        vm.warp(T0 + drawAt);
        t.settle();
        uint256 held = t.box();
        vm.prank(founder);
        t.draw(bob, held);
        uint256 p1 = t.pot();
        vm.warp(T0 + idle);
        _checkIn();
        assertLe(t.box(), _accrual(p1, 1000, 14 days - drawAt) + 1);
    }
}
