// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {Clones} from "oz5/proxy/Clones.sol";
import {HolderPause} from "../src/HolderPause.sol";
import {Launcher} from "../src/Launcher.sol";
import {Treasury} from "../src/Treasury.sol";
import {Parts} from "../src/Parts.sol";
import {StackBase, Proj} from "./helpers/StackBase.sol";
import {QuoteToken} from "./mocks/QuoteToken.sol";

/// @dev The Launcher's platform settings as the struct `settingsHash` encodes (the public getter returns the fields).
function platformOf(Launcher l) view returns (Launcher.Platform memory p) {
    (p.quote, p.platform, p.feeBps, p.unit, p.agentUsd) = l.platform();
}

/// @notice The switch: one-shot, deployer-only, first-hour, with the code hash published; and what a launch does with it on
/// and off. With it off (the default) nothing is bound and a launch is exactly what it was.
contract LauncherPauseSwitchOffTest is StackBase {
    function test_withTheSwitchOffNothingIsBoundAndTheSettingsHashIsTheOldFormula() public view {
        assertEq(launcher.holderPauseImpl(), address(0));
        assertEq(t.pauseGate(), address(0), "the default project has no pause");
        assertEq(launcher.settingsHash(), keccak256(abi.encode(platformOf(launcher))), "the old formula");
    }

    function test_aLaunchWithTheSwitchOffEmitsNoPauseEvent() public {
        vm.recordLogs();
        _launch(alice, "off", 1000, POOL);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != Treasury.PauseReady.selector, "no PauseReady");
            assertTrue(logs[i].topics[0] != Launcher.HolderPauseBound.selector, "no HolderPauseBound");
        }
    }

    function test_theGatedCallsAndJoinsDoNotTouchAnAbsentGate() public {
        // no gate: draw and announce are never refused for a pause and a join needs nothing from one
        _join(alice, 10_000e6);
        vm.warp(block.timestamp + 2 days);
        _checkIn();
        uint256 box = t.box();
        assertGt(box, 0);
        vm.prank(founder);
        t.draw(founder, box);
        vm.prank(founder);
        t.announceTask(bytes32(uint256(1)), address(0), 100e6, 10);
    }

    function test_aTreasuryRefusesAZeroGateEvenFromTheLauncher() public {
        vm.prank(address(launcher));
        vm.expectRevert(Treasury.BadInput.selector);
        t.bindPause(address(0));
        assertEq(t.pauseGate(), address(0));
    }

    function test_bindPauseByAStrangerOrTheAdminIsRefused() public {
        HolderPause impl = new HolderPause();
        vm.prank(stranger);
        vm.expectRevert(Launcher.NotDeployer.selector);
        launcher.bindPause(address(impl));
        vm.prank(admin);
        vm.expectRevert(Launcher.NotDeployer.selector);
        launcher.bindPause(address(impl));
        assertEq(launcher.holderPauseImpl(), address(0));
    }
}

contract LauncherPauseTest is StackBase {
    HolderPause internal impl;

    function setUp() public override {
        vm.warp(T0);
        usd = new QuoteToken();
        parts = new Parts();
        launcher = new Launcher(admin, _platform(UNIT), parts);
        impl = new HolderPause();
    }

    function test_theDeployerIsRecordedAtConstruction() public view {
        assertEq(launcher.deployer(), address(this));
        assertEq(launcher.deployedAt(), T0);
    }

    function test_bindPauseSetsTheImplementationAndPublishesItsCodeHash() public {
        vm.expectEmit(false, false, false, true, address(launcher));
        emit Launcher.HolderPauseBound(address(impl), address(impl).codehash);
        launcher.bindPause(address(impl));
        assertEq(launcher.holderPauseImpl(), address(impl));
        assertTrue(address(impl).codehash != bytes32(0));
    }

    function test_bindPauseOnlyWorksOnce() public {
        launcher.bindPause(address(impl));
        HolderPause other = new HolderPause();
        vm.expectRevert(Launcher.BindClosed.selector);
        launcher.bindPause(address(other));
        assertEq(launcher.holderPauseImpl(), address(impl));
    }

    function test_bindPauseWorksInsideTheFirstHourAndNotAfter() public {
        vm.warp(T0 + 1 hours);
        launcher.bindPause(address(impl)); // the last second still works
        Launcher l2 = new Launcher(admin, _platform(UNIT), parts);
        vm.warp(block.timestamp + 1 hours + 1);
        vm.expectRevert(Launcher.BindClosed.selector);
        l2.bindPause(address(impl));
        assertEq(l2.holderPauseImpl(), address(0), "a key used later cannot turn it on");
    }

    function test_bindPauseNeedsCode() public {
        vm.expectRevert(Launcher.BadStack.selector);
        launcher.bindPause(address(0));
        vm.expectRevert(Launcher.BadStack.selector);
        launcher.bindPause(makeAddr("nobody"));
    }

    function test_theSettingsHashAddsTheBoundImplementationAndOnlyThen() public {
        bytes32 before = launcher.settingsHash();
        assertEq(before, keccak256(abi.encode(platformOf(launcher))));
        launcher.bindPause(address(impl));
        bytes32 after_ = launcher.settingsHash();
        assertTrue(after_ != before);
        assertEq(after_, keccak256(abi.encode(platformOf(launcher), address(impl))));
    }

    function test_aFounderWhoReadTheHashBeforeTheSwitchIsRefusedAfterIt() public {
        bytes32 seen = launcher.settingsHash();
        launcher.bindPause(address(impl));
        vm.prank(alice);
        vm.expectRevert(Launcher.SettingsMoved.selector);
        launcher.launch("x", "Project", "PRJ", Launcher.Terms({ratePpm: 1000, teamPool: POOL}), seen);
    }

    function test_aLaunchWithTheSwitchOnMakesAndBindsAPauseClone() public {
        launcher.bindPause(address(impl));
        vm.recordLogs();
        Proj memory p = _launch(alice, "on", 1000, POOL);
        address gate = p.t.pauseGate();
        assertTrue(gate != address(0));
        assertTrue(gate != address(impl), "a clone, not the implementation");
        assertEq(gate.code.length, 45, "a minimal clone");
        HolderPause c = HolderPause(gate);
        assertEq(address(c.shares()), address(p.shares), "tied to this project's backer Shares");
        assertEq(c.day(), UNIT / 7);
        // exactly one PauseReady, from this project's Treasury, carrying the gate
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == Treasury.PauseReady.selector) {
                ++seen;
                assertEq(logs[i].emitter, address(p.t));
                assertEq(abi.decode(logs[i].data, (address)), gate);
            }
        }
        assertEq(seen, 1);
    }

    function test_everyProjectGetsItsOwnPause() public {
        launcher.bindPause(address(impl));
        Proj memory a = _launch(alice, "a", 1000, POOL);
        Proj memory b = _launch(bob, "b", 1000, POOL);
        assertTrue(a.t.pauseGate() != b.t.pauseGate());
        assertEq(address(HolderPause(a.t.pauseGate()).shares()), address(a.shares));
        assertEq(address(HolderPause(b.t.pauseGate()).shares()), address(b.shares));
    }

    function test_projectLaunchedBeforeBindPauseHasNoPause() public {
        Proj memory early = _launch(alice, "early", 1000, POOL);
        launcher.bindPause(address(impl));
        Proj memory late = _launch(bob, "late", 1000, POOL);
        assertEq(early.t.pauseGate(), address(0), "born without it, keeps it that way");
        assertTrue(late.t.pauseGate() != address(0));
    }
}
