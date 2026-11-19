// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {StackBase} from "./helpers/StackBase.sol";
import {Treasury} from "../src/Treasury.sol";
import {Vester} from "../src/Vester.sol";
import {Launcher} from "../src/Launcher.sol";
import {Pair} from "../src/Pair.sol";

/// @notice Winding down through the real Launcher and Vester: by choice (the runner, alone or as a Pair of both signers) and
/// after 26 quiet units (anyone). The door shuts, the allowance and vesting stop, leaving stays open, and the Team Shares
/// that were not kept burn after a notice of one time unit.
contract WindDownTest is StackBase {
    uint256 internal constant AMOUNT = 1_040_000e18;

    // ---- by choice

    function test_theRunnerWindsDownByChoiceThroughTheLauncher() public {
        _join(alice, 100_000e6);
        vm.warp(block.timestamp + 5 days);
        _checkIn();
        vm.prank(stranger);
        vm.expectRevert(Launcher.NotRunner.selector);
        launcher.windDown(key);
        vm.prank(stranger);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.markWoundDown();
        vm.expectEmit(true, true, false, false, address(launcher));
        emit Launcher.WoundDown(key, founder);
        vm.prank(founder);
        launcher.windDown(key);
        assertEq(t.windDownKind(), 1);
        assertEq(t.windDownAt(), block.timestamp);
        vm.prank(founder);
        vm.expectRevert(Treasury.AlreadyWoundDown.selector);
        launcher.windDown(key);
    }

    function test_afterAWindDownTheDoorIsShutAndTheAllowanceStopsButLeavingStaysOpen() public {
        uint256 n = _join(alice, 100_000e6);
        vm.warp(block.timestamp + 5 days);
        _checkIn();
        t.settle();
        uint256 boxBefore = t.box();
        assertGt(boxBefore, 0);
        vm.prank(founder);
        launcher.windDown(key);
        assertEq(t.box(), 0, "the box returned to the pot");
        // the door is shut
        usd.mint(bob, 1000e6);
        vm.startPrank(bob);
        usd.approve(address(t), 1000e6);
        vm.expectRevert(Treasury.DoorShut.selector);
        t.join(1000e6, 0, bob);
        vm.stopPrank();
        // the allowance is stopped and so is the clock
        uint256 pot = t.pot();
        uint256 active = t.activeNow();
        vm.warp(block.timestamp + 10 days);
        t.settle();
        assertEq(t.pot(), pot, "no allowance accrues");
        assertEq(t.box(), 0);
        assertEq(t.activeNow(), active, "vesting stops: no active time passes");
        vm.prank(founder);
        vm.expectRevert(Treasury.AlreadyWoundDown.selector);
        t.checkIn(bytes32(0));
        // leaving is open
        assertGt(_leave(alice, n / 2), 0);
    }

    function test_aWoundDownProjectStillTakesOutsideMoneyAndPaysFees() public {
        _join(alice, 100_000e6);
        vm.prank(founder);
        launcher.windDown(key);
        _revenue(carol, 1000e6);
        assertEq(t.arriving(), 1000e6);
        t.collectFees();
        assertEq(usd.balanceOf(platform), 2000e6);
    }

    function test_aWindDownByChoiceKeepsEveryAccruedGrantAndBurnsTheRestAfterTheNotice() public {
        uint256 id = _grant(alice, AMOUNT);
        _active(5 * UNIT); // accrued 50,000; nothing vested before the cliff
        vm.prank(founder);
        launcher.windDown(key);
        uint256 at = block.timestamp + UNIT;
        vm.warp(at - 1);
        vm.expectRevert(abi.encodeWithSelector(Vester.NotYet.selector, at));
        v.burnAfterWindDown(id);
        vm.warp(at);
        uint256 g = team.totalSupply();
        vm.prank(stranger);
        v.burnAfterWindDown(id);
        assertEq(v.grantOf(id).total, 50_000e18, "by choice: what accrued stays");
        assertEq(team.totalSupply(), g - 990_000e18);
        assertEq(t.Z(), 0, "nothing was ever priced into a join: the door was shut");
        assertEq(v.claim(id), 50_000e18);
    }

    function test_theUngrantedPoolBurnsToo() public {
        _grant(alice, 400_000e18);
        vm.prank(founder);
        launcher.windDown(key);
        vm.warp(block.timestamp + UNIT);
        uint256 burned = v.burnUngrantedAfterWindDown();
        assertEq(burned, POOL - 400_000e18);
        assertEq(team.totalSupply(), 400_000e18);
    }

    function test_theBurnHooksNeedAWindDown() public {
        uint256 id = _grant(alice, AMOUNT);
        vm.expectRevert(Vester.NotWoundDown.selector);
        v.burnAfterWindDown(id);
        vm.expectRevert(Vester.NotWoundDown.selector);
        v.burnUngrantedAfterWindDown();
        // the Treasury hook itself refuses before a wind-down even for the Vester
        vm.prank(address(v));
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.burnAfterWindDown(1);
    }

    function test_aPairWindsDownOnlyWithBothSigners() public {
        Pair pair = _makePair(bob);
        vm.prank(address(pair));
        vm.expectRevert(Launcher.NotRunner.selector);
        launcher.windDown(key); // the Pair's address alone, outside a confirmed proposal
        vm.prank(address(pair));
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.windDown();
        _bothTo(pair, founder, bob, address(launcher), abi.encodeCall(Launcher.windDown, (key)));
        assertEq(t.windDownKind(), 1);
    }

    // ---- quiet: anyone, after 26 units

    function test_anyoneWindsAQuietProjectDownAfterTwentySixUnits() public {
        uint256 id = _grant(alice, AMOUNT);
        _active(5 * UNIT);
        uint256 last = block.timestamp;
        vm.warp(last + 26 * UNIT - 1);
        vm.prank(stranger);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.windDown();
        vm.warp(last + 26 * UNIT);
        vm.prank(stranger);
        t.windDown();
        assertEq(t.windDownKind(), 2);
        // a quiet wind-down keeps only what vested; before the cliff that is nothing
        vm.warp(block.timestamp + UNIT);
        v.burnAfterWindDown(id);
        assertEq(v.grantOf(id).total, 0);
    }

    function test_theKindDecidesWhatAGrantKeeps() public {
        // two identical projects, one wound down by choice and one quiet: same grant, different keep
        uint256 idA = _grant(alice, AMOUNT);
        _active(5 * UNIT);
        vm.prank(founder);
        launcher.windDown(key);
        vm.warp(block.timestamp + UNIT);
        v.burnAfterWindDown(idA);
        uint256 byChoice = v.grantOf(idA).total;

        _use(_launch(founder, "q", 1000, POOL));
        uint256 idB = _grant(alice, AMOUNT);
        _active(5 * UNIT);
        vm.warp(block.timestamp + 26 * UNIT);
        t.windDown();
        vm.warp(block.timestamp + UNIT);
        v.burnAfterWindDown(idB);
        assertEq(byChoice, 50_000e18);
        assertEq(v.grantOf(idB).total, 0);
    }

    // ---- quiet before the wind-down

    function test_twoUnitsWithoutACheckInStopsVestingAndShutsTheDoor() public {
        uint256 id = _grant(alice, AMOUNT);
        _active(13 * UNIT);
        uint256 vested = v.vestedOf(id);
        assertEq(vested, 130_000e18);
        vm.warp(block.timestamp + 2 * UNIT - 1);
        assertTrue(t.doorOpenNow());
        assertGt(v.vestedOf(id), vested, "still inside the window");
        vm.warp(block.timestamp + 1);
        assertFalse(t.doorOpenNow(), "shut at exactly 2N");
        uint256 atClose = v.vestedOf(id);
        vm.warp(block.timestamp + 40 * UNIT);
        assertEq(v.vestedOf(id), atClose, "vesting stopped at the same moment");
    }

    function test_aNewProjectStartsInsideItsWindow() public {
        Treasury tr = _launch(alice, "fresh", 1000, POOL).t;
        assertTrue(tr.doorOpenNow());
        assertEq(tr.lastCheckIn(), block.timestamp);
        _joinIn(tr, bob, 1000e6);
        vm.warp(block.timestamp + 2 * UNIT - 1);
        assertTrue(tr.doorOpenNow());
        vm.warp(block.timestamp + 1);
        assertFalse(tr.doorOpenNow());
    }
}
