// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {StackBase, Proj} from "./helpers/StackBase.sol";
import {Treasury} from "../src/Treasury.sol";
import {Vester} from "../src/Vester.sol";

/// @notice Team Shares through the real stack: grants from the runner, vesting on the project's active time, and a joiner's
/// quote that no vesting day can move.
contract VesterStackTest is StackBase {
    function test_onlyTheRunnerGrants() public {
        vm.prank(stranger);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.grantTeam(alice, 1e18);
        uint256 id = _grant(alice, 1000e18);
        assertEq(id, 0);
        assertEq(v.grantOf(id).member, alice);
        assertEq(team.balanceOf(address(v)), POOL, "the pool stays in the Vester until claimed");
    }

    function test_grantRefusesMembersThatCouldNeverClaim() public {
        address[6] memory bad = [address(0), address(t), address(v), address(team), address(shares), address(usd)];
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(founder);
            vm.expectRevert(Treasury.BadInput.selector);
            t.grantTeam(bad[i], 1e18);
        }
    }

    function test_grantsNeverPassThePoolSetAtBirth() public {
        _grant(alice, POOL - 1);
        vm.prank(founder);
        vm.expectRevert(Vester.NotFunded.selector);
        t.grantTeam(bob, 2);
        _grant(bob, 1);
    }

    function test_vestingRunsOnActiveTime() public {
        uint256 id = _grant(alice, 1_040_000e18);
        _active(13 * UNIT - 1);
        assertEq(v.vestedOf(id), 0, "before the cliff");
        _active(1);
        assertEq(t.activeNow(), 13 * UNIT);
        assertEq(v.vestedOf(id), 130_000e18, "13 of 104");
        _active(39 * UNIT);
        assertEq(v.vestedOf(id), 520_000e18, "52 of 104");
        assertEq(v.claim(id), 520_000e18);
        assertEq(team.balanceOf(alice), 520_000e18);
    }

    function test_aLapseIsNeverPaidBack() public {
        uint256 id = _grant(alice, 1_040_000e18);
        _active(13 * UNIT);
        // quiet: no check-in for 50 units. Only 2 units of the window are active.
        vm.warp(block.timestamp + 50 * UNIT);
        assertEq(t.activeNow(), 15 * UNIT);
        assertEq(v.vestedOf(id), 150_000e18, "15 of 104, not 63");
        _checkIn();
        assertEq(t.activeNow(), 15 * UNIT, "a check-in after the lapse buys nothing back");
        assertEq(v.vestedOf(id), 150_000e18);
        vm.warp(block.timestamp + 1 days);
        assertEq(v.vestedOf(id), 150_000e18 + 1_040_000e18 * 1 days / (104 * UNIT));
    }

    function test_everyGrantHasAClockOfItsOwn() public {
        uint256 a = _grant(alice, 1_040_000e18);
        _active(10 * UNIT);
        uint256 b = _grant(bob, 1_040_000e18);
        assertEq(v.grantOf(b).start, 10 * UNIT);
        _active(13 * UNIT);
        assertEq(v.vestedOf(b), 130_000e18, "13 units after its own start");
        assertEq(v.vestedOf(a), 230_000e18, "23 units after the first");
    }

    function test_aJoinersQuoteIsTheSameTheSecondBeforeAndAfterAnyVestingDay() public {
        _use(_launch(founder, "still", 0, POOL)); // no allowance, so only vesting could move a number
        _join(alice, 10_000e6);
        uint256 id = _grant(bob, 1_040_000e18);
        _active(13 * UNIT - 1);
        (uint256 before,,,) = t.quoteBack(1000e6);
        assertEq(v.vestedOf(id), 0);
        vm.warp(block.timestamp + 1);
        assertEq(v.vestedOf(id), 130_000e18, "the cliff day: a large vesting step");
        (uint256 afterCliff,,,) = t.quoteBack(1000e6);
        assertEq(afterCliff, before, "the quote did not move on the cliff day");
        _active(104 * UNIT - 14 * UNIT);
        assertEq(v.vestedOf(id), 1_040_000e18 * 103 / 104, "a day deep into the vesting");
        (uint256 deep,,,) = t.quoteBack(1000e6);
        assertEq(deep, before);
        _active(UNIT);
        assertEq(v.vestedOf(id), 1_040_000e18);
        (uint256 full,,,) = t.quoteBack(1000e6);
        assertEq(full, before, "all of it counted from birth");
    }

    function test_noGrantsAfterAWindDown() public {
        vm.prank(founder);
        launcher.windDown(key);
        vm.prank(founder);
        vm.expectRevert(Treasury.AlreadyWoundDown.selector);
        t.grantTeam(alice, 1e18);
    }

    function test_theVesterHasNoWayIntoLeaveTeam() public {
        (bool ok,) = address(v).call(abi.encodeWithSignature("leaveTeam(uint256,uint256,address)", 1, 0, alice));
        assertFalse(ok);
        // and the Vester itself cannot be a payee of what it holds: its Team Shares are not in anyone's hands
        vm.prank(address(v));
        vm.expectRevert();
        t.leaveTeam(1e18, 0, alice);
    }
}
