// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {PotBase} from "./helpers/PotBase.sol";
import {Treasury} from "../src/Treasury.sol";
import {MockPair} from "./helpers/Mocks.sol";

/// @notice The quiet rules and the wind-down: 2N without a check-in stops the allowance and shuts the door; 26N lets
/// anyone wind down; the runner may wind down by choice; leaving always works.
contract QuietTest is PotBase {
    function setUp() public override {
        super.setUp();
        _join(alice, 100_000e6);
    }

    function test_theWindowClosesAtExactlyTwoUnits() public {
        vm.warp(T0 + 2 * UNIT - 1);
        assertTrue(t.doorOpenNow());
        vm.warp(T0 + 2 * UNIT);
        assertFalse(t.doorOpenNow());
        assertEq(t.activeEnd(), T0 + 2 * UNIT);
        vm.warp(T0 + 2 * UNIT + 1);
        assertFalse(t.doorOpenNow());
        _checkIn();
        assertTrue(t.doorOpenNow());
        assertEq(t.activeEnd(), T0 + 4 * UNIT + 1);
    }

    function test_theClockStopsWithTheWindow() public {
        vm.warp(T0 + 5 * UNIT);
        assertEq(t.activeNow(), 2 * UNIT);
        vm.warp(T0 + 9 * UNIT);
        assertEq(t.activeNow(), 2 * UNIT, "vesting and the allowance see no active time while quiet");
    }

    // ---- wind-down by anyone after 26 units of quiet

    function test_anyoneMayWindDownAfterTwentySixQuietUnits() public {
        vm.warp(T0 + 26 * UNIT - 1);
        vm.prank(stranger);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.windDown();
        vm.warp(T0 + 26 * UNIT);
        vm.prank(stranger);
        t.windDown();
        assertEq(t.windDownKind(), 2);
        assertEq(t.windDownAt(), T0 + 26 * UNIT);
    }

    function test_aCheckInRestartsTheTwentySixUnitClock() public {
        vm.warp(T0 + 25 * UNIT);
        _checkIn();
        vm.warp(T0 + 26 * UNIT + 5);
        vm.prank(stranger);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.windDown();
        vm.warp(T0 + 51 * UNIT);
        vm.prank(stranger);
        t.windDown();
    }

    function test_theRunnerMayWindDownByChoiceAtAnyTime() public {
        vm.prank(stranger);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.windDown();
        vm.prank(founder);
        t.windDown();
        assertEq(t.windDownKind(), 1);
    }

    function test_theLauncherForwardsAWindDownByChoice() public {
        vm.prank(stranger);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.markWoundDown();
        sale.wind(address(t));
        assertEq(t.windDownKind(), 1);
    }

    function test_windDownReturnsTheBoxToThePotAndShutsTheDoor() public {
        vm.warp(T0 + 7 days);
        vm.expectEmit(true, false, false, true, address(t));
        emit Treasury.WoundDown(1, founder, uint64(T0 + 7 days), 686e6);
        vm.prank(founder);
        t.windDown();
        assertEq(t.box(), 0);
        assertEq(t.pot(), 98_000e6);
        assertFalse(t.doorOpenNow());
        assertEq(t.activeEnd(), 0);
        _assertConserved();
    }

    function test_aSecondWindDownReverts() public {
        vm.prank(founder);
        t.windDown();
        vm.prank(founder);
        vm.expectRevert(Treasury.AlreadyWoundDown.selector);
        t.windDown();
        vm.warp(T0 + 30 * UNIT);
        vm.expectRevert(Treasury.AlreadyWoundDown.selector);
        t.windDown();
    }

    function test_afterAWindDownLeavingRevenueAndFeesStillWork() public {
        uint256 n = _join(bob, 10_000e6);
        vm.prank(founder);
        t.windDown();
        // closed
        usd.mint(carol, 100e6);
        vm.startPrank(carol);
        usd.approve(address(t), 100e6);
        vm.expectRevert(Treasury.DoorShut.selector);
        t.join(100e6, 0, carol);
        vm.stopPrank();
        vm.prank(founder);
        vm.expectRevert(Treasury.AlreadyWoundDown.selector);
        t.checkIn(bytes32(0));
        vm.startPrank(founder);
        vm.expectRevert(Treasury.AlreadyWoundDown.selector);
        t.setRate(1);
        vm.expectRevert(Treasury.AlreadyWoundDown.selector);
        t.proposeRate(2000);
        vm.stopPrank();
        vm.expectRevert(Treasury.AlreadyWoundDown.selector);
        t.applyRate();
        vm.warp(block.timestamp + 5 days);
        vm.prank(founder);
        vm.expectRevert(abi.encodeWithSelector(Treasury.TooMuch.selector, 1, 0));
        t.draw(founder, 1);
        // open
        assertEq(_leave(bob, n), 9_800e6);
        _revenue(carol, 100e6);
        t.collectFees();
        assertEq(t.activeNow(), 0, "no active time ever counted after the wind-down");
    }

    function test_vestingTimeStaysFrozenAfterAWindDown() public {
        vm.warp(T0 + 3 days);
        vm.prank(founder);
        t.windDown();
        uint256 frozen = t.activeNow();
        assertEq(frozen, 3 days);
        vm.warp(T0 + 100 days);
        assertEq(t.activeNow(), frozen);
    }

    function test_aPairRunnerWindsDownByChoiceOnlyWithBothSigners() public {
        MockPair pair = new MockPair(founder, bob);
        sale.setPair(address(pair), true);
        vm.prank(founder);
        t.handOver(address(pair), false);
        (bool ok,) = pair.exec(address(t), abi.encodeCall(Treasury.takeSeat, ()), true);
        assertTrue(ok);
        assertEq(t.runner(), address(pair));
        (ok,) = pair.exec(address(t), abi.encodeCall(Treasury.windDown, ()), false);
        assertFalse(ok, "one signer cannot wind down");
        assertEq(t.windDownKind(), 0);
        (ok,) = pair.exec(address(t), abi.encodeCall(Treasury.windDown, ()), true);
        assertTrue(ok);
        assertEq(t.windDownKind(), 1);
    }
}
