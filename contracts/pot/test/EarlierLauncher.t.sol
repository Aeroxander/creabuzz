// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {EarlierGrants} from "../src/EarlierGrants.sol";
import {HolderPause} from "../src/HolderPause.sol";
import {Launcher} from "../src/Launcher.sol";
import {Parts} from "../src/Parts.sol";
import {Treasury} from "../src/Treasury.sol";
import {Vester} from "../src/Vester.sol";
import {StackBase, Proj} from "./helpers/StackBase.sol";
import {EarlierBase, Row} from "./helpers/EarlierBase.sol";
import {QuoteToken} from "./mocks/QuoteToken.sol";

/// @dev The Launcher's platform settings as the struct `settingsHash` encodes (the public getter returns the fields).
function platformOf(Launcher l) view returns (Launcher.Platform memory p) {
    (p.quote, p.platform, p.feeBps, p.unit, p.agentUsd) = l.platform();
}

/// @notice With nothing bound (the default) a launch is exactly what it was: no claim contract, no reserve.
contract EarlierLauncherOffTest is StackBase {
    function test_nothingBoundMeansNoClaimContractNoReserveAndTheOldHash() public {
        assertEq(launcher.earlier(), address(0));
        assertEq(launcher.earlierKey(), bytes32(0));
        assertEq(launcher.settingsHash(), keccak256(abi.encode(platformOf(launcher))), "the old formula");
        assertEq(v.earlier(), address(0));
        assertEq(v.earlierReserve(), 0);
        assertEq(team.totalSupply(), POOL);
        assertEq(team.balanceOf(address(v)), POOL);
    }

    function test_aLaunchWithNothingBoundEmitsNoEarlierEvent() public {
        vm.recordLogs();
        _launch(alice, "off", 1000, POOL);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != Launcher.EarlierPoolFunded.selector, "no EarlierPoolFunded");
            assertTrue(logs[i].topics[0] != Launcher.EarlierBound.selector, "no EarlierBound");
        }
    }
}

/// @notice `bindEarlier`: deployer-only, once, inside the first hour, only while project zero has not launched, and only for a
/// claim contract that names this Launcher; and what the launch of project zero does with it.
contract EarlierLauncherTest is EarlierBase {
    function _fresh() internal returns (Launcher l, EarlierGrants e) {
        l = new Launcher(admin, _platform(UNIT), parts);
        e = new EarlierGrants(address(l), root, TEXT, poolTotal, 8, l.keyOf(founder, ZERO_ID));
    }

    // ---------------------------------------------------------------- the binding

    function test_bindEarlierIsTheDeployersAlone() public {
        (Launcher l, EarlierGrants e) = _fresh();
        vm.prank(admin);
        vm.expectRevert(Launcher.NotDeployer.selector);
        l.bindEarlier(address(e));
        vm.prank(stranger);
        vm.expectRevert(Launcher.NotDeployer.selector);
        l.bindEarlier(address(e));
        assertEq(l.earlier(), address(0));
        l.bindEarlier(address(e)); // the deployer: this test contract
        assertEq(l.earlier(), address(e));
    }

    function test_bindEarlierPublishesTheClaimContractAndTheKey() public {
        (Launcher l, EarlierGrants e) = _fresh();
        vm.expectEmit(false, false, false, true, address(l));
        emit Launcher.EarlierBound(address(e), l.keyOf(founder, ZERO_ID));
        l.bindEarlier(address(e));
        assertEq(l.earlierKey(), l.keyOf(founder, ZERO_ID));
    }

    function test_bindEarlierWorksOnlyOnce() public {
        (Launcher l, EarlierGrants e) = _fresh();
        l.bindEarlier(address(e));
        EarlierGrants other = new EarlierGrants(address(l), root, TEXT, poolTotal, 8, l.keyOf(founder, "again"));
        vm.expectRevert(Launcher.BindClosed.selector);
        l.bindEarlier(address(other));
        vm.expectRevert(Launcher.BindClosed.selector);
        l.bindEarlier(address(e));
        assertEq(l.earlier(), address(e));
    }

    function test_bindEarlierWorksInsideTheFirstHourAndNotAfter() public {
        (Launcher a, EarlierGrants ea) = _fresh();
        (Launcher b, EarlierGrants eb) = _fresh();
        _warp(1 hours);
        a.bindEarlier(address(ea)); // the last second of the hour is inside it
        assertEq(a.earlier(), address(ea));
        _warp(1);
        vm.expectRevert(Launcher.BindClosed.selector);
        b.bindEarlier(address(eb));
        assertEq(b.earlier(), address(0));
    }

    function test_bindEarlierNeedsACodeThatNamesThisLauncher() public {
        (Launcher l, EarlierGrants e) = _fresh();
        vm.expectRevert(Launcher.BadStack.selector);
        l.bindEarlier(address(0));
        vm.expectRevert(Launcher.BadStack.selector);
        l.bindEarlier(makeAddr("an account"));
        // a claim contract made for another Launcher
        EarlierGrants foreign =
            new EarlierGrants(address(launcher), root, TEXT, poolTotal, 8, l.keyOf(founder, ZERO_ID));
        vm.expectRevert(Launcher.BadStack.selector);
        l.bindEarlier(address(foreign));
        l.bindEarlier(address(e));
    }

    function test_bindEarlierRefusesAfterTheKeyLaunched() public {
        (Launcher l, EarlierGrants e) = _fresh();
        // project zero's founder launches before the claim contract is bound: it could never have the reserve
        bytes32 h = l.settingsHash();
        vm.prank(founder);
        l.launch(ZERO_ID, "Project", "PRJ", Launcher.Terms({ratePpm: 1000, teamPool: POOL}), h);
        vm.expectRevert(Launcher.BindClosed.selector);
        l.bindEarlier(address(e));
        assertEq(l.earlier(), address(0));
        // another key's launch does not close it
        (Launcher l2, EarlierGrants e2) = _fresh();
        h = l2.settingsHash();
        vm.prank(alice);
        l2.launch(ZERO_ID, "Project", "PRJ", Launcher.Terms({ratePpm: 1000, teamPool: POOL}), h);
        l2.bindEarlier(address(e2));
    }

    function test_theEarlierBindingAndThePauseBindingAreIndependent() public {
        (Launcher l, EarlierGrants e) = _fresh();
        HolderPause pauseImpl = new HolderPause();
        l.bindEarlier(address(e));
        l.bindPause(address(pauseImpl));
        assertEq(l.earlier(), address(e));
        assertEq(l.holderPauseImpl(), address(pauseImpl));
        // and in the other order
        (Launcher l2, EarlierGrants e2) = _fresh();
        l2.bindPause(address(pauseImpl));
        l2.bindEarlier(address(e2));
        assertEq(l2.earlier(), address(e2));
    }

    // ---------------------------------------------------------------- the settings hash

    function test_theSettingsHashChangesWhenBoundAndIsTheOldFormulaWhenNot() public {
        (Launcher l, EarlierGrants e) = _fresh();
        assertEq(l.settingsHash(), keccak256(abi.encode(platformOf(l))), "unbound: the old formula");
        l.bindEarlier(address(e));
        assertEq(l.settingsHash(), keccak256(abi.encode(platformOf(l), address(0), address(e))), "bound");
        assertTrue(l.settingsHash() != keccak256(abi.encode(platformOf(l))));
    }

    function test_withBothBoundTheHashCoversBoth() public {
        (Launcher l, EarlierGrants e) = _fresh();
        HolderPause pauseImpl = new HolderPause();
        bytes32 old = l.settingsHash();
        l.bindPause(address(pauseImpl));
        bytes32 pauseOnly = l.settingsHash();
        assertEq(
            pauseOnly, keccak256(abi.encode(platformOf(l), address(pauseImpl))), "pause only: the formula of the pause"
        );
        l.bindEarlier(address(e));
        assertEq(l.settingsHash(), keccak256(abi.encode(platformOf(l), address(pauseImpl), address(e))));
        assertTrue(old != pauseOnly && pauseOnly != l.settingsHash());
    }

    function test_aFounderWhoReadTheHashBeforeTheBindingIsRefusedAfterIt() public {
        (Launcher l, EarlierGrants e) = _fresh();
        bytes32 before_ = l.settingsHash();
        l.bindEarlier(address(e));
        vm.prank(alice);
        vm.expectRevert(Launcher.SettingsMoved.selector);
        l.launch("x", "Project", "PRJ", Launcher.Terms({ratePpm: 1000, teamPool: POOL}), before_);
    }

    // ---------------------------------------------------------------- the launch of project zero

    function test_launchingUnderTheKeyMintsPoolPlusEarlierPoolAndBindsTheClaimContract() public view {
        assertEq(team.totalSupply(), POOL + poolTotal, "pool and earlier pool");
        assertEq(team.balanceOf(address(v)), POOL + poolTotal, "all in the Vester");
        assertEq(v.earlier(), address(earlier));
        assertEq(v.earlierReserve(), poolTotal);
        assertEq(v.earlierStart(), T0, "the birth");
        assertEq(address(earlier.vester()), address(v), "the claim contract is tied to this project's Vester");
        assertEq(address(t.team()), address(team));
    }

    function test_earlierPoolFundedIsEmittedOnceWithThePoolInTheLaunchTransaction() public {
        Launcher l = new Launcher(admin, _platform(UNIT), parts);
        EarlierGrants e = new EarlierGrants(address(l), root, TEXT, poolTotal, 8, l.keyOf(founder, "z2"));
        l.bindEarlier(address(e));
        bytes32 h = l.settingsHash();
        vm.recordLogs();
        vm.prank(founder);
        (,,, address vs) = l.launch("z2", "Project", "PRJ", Launcher.Terms({ratePpm: 1000, teamPool: POOL}), h);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(l) && logs[i].topics[0] == Launcher.EarlierPoolFunded.selector) {
                ++seen;
                assertEq(logs[i].topics[1], l.keyOf(founder, "z2"), "the key is indexed");
                (address vester, uint256 amount) = abi.decode(logs[i].data, (address, uint256));
                assertEq(vester, vs);
                assertEq(amount, poolTotal);
            }
        }
        assertEq(seen, 1);
        assertEq(address(e.vester()), vs);
    }

    function test_projectZeroCannotLaunchTwice() public {
        bytes32 h = launcher.settingsHash();
        vm.prank(founder);
        vm.expectRevert(Launcher.ProjectExists.selector);
        launcher.launch(ZERO_ID, "Project", "PRJ", Launcher.Terms({ratePpm: 1000, teamPool: POOL}), h);
        // so the claim contract can never be bound a second time (it would revert AlreadyBound)
    }

    function test_anotherKeyLaunchesAsBefore() public {
        Proj memory p = _launch(founder, "p1", 1000, POOL); // same founder, another id
        assertEq(p.team.totalSupply(), POOL);
        assertEq(p.v.earlierReserve(), 0);
        assertEq(p.v.earlier(), address(0));
        Proj memory q = _launch(alice, ZERO_ID, 1000, POOL); // same id, another founder
        assertEq(q.team.totalSupply(), POOL, "the key is the founder's AND the id");
        assertEq(q.v.earlierReserve(), 0);
        assertEq(address(earlier.vester()), address(v), "the claim contract stays tied to project zero's Vester");
    }

    function test_nobodyElseCanLaunchProjectZeroTheirOwnWay() public {
        // `keyOf` uses the caller: the key of (alice, ZERO_ID) is not project zero's
        assertTrue(launcher.keyOf(alice, ZERO_ID) != launcher.earlierKey());
        assertEq(launcher.earlierKey(), launcher.keyOf(founder, ZERO_ID));
    }

    function test_projectZeroKeepsItsTermsAndTheAgentLimit() public view {
        assertEq(uint256(t.ratePpm()), 1000);
        assertEq(uint256(t.agentTeam()), POOL / 1000, "the agent's Team Share limit ignores the earlier pool");
    }

    function test_aProjectLaunchedBeforeBindPauseHasNoPauseAndTheOneBeforeBindEarlierNoReserve() public {
        // the order of the deploy script is bind first, launch after; a launch before the bind is simply born without
        Launcher l = new Launcher(admin, _platform(UNIT), parts);
        bytes32 h = l.settingsHash();
        vm.prank(alice);
        (,, address tr, address vs) =
            l.launch("early", "Project", "PRJ", Launcher.Terms({ratePpm: 1000, teamPool: POOL}), h);
        EarlierGrants e = new EarlierGrants(address(l), root, TEXT, poolTotal, 8, l.keyOf(bob, "later"));
        HolderPause pauseImpl = new HolderPause();
        l.bindPause(address(pauseImpl));
        l.bindEarlier(address(e));
        assertEq(Treasury(tr).pauseGate(), address(0));
        assertEq(Vester(vs).earlierReserve(), 0);
    }

    function test_theEarlierProjectWithThePauseOnBothArePresent() public {
        Launcher l = new Launcher(admin, _platform(UNIT), parts);
        EarlierGrants e = new EarlierGrants(address(l), root, TEXT, poolTotal, 8, l.keyOf(founder, ZERO_ID));
        HolderPause pauseImpl = new HolderPause();
        l.bindPause(address(pauseImpl));
        l.bindEarlier(address(e));
        bytes32 h = l.settingsHash();
        vm.prank(founder);
        (,, address tr, address vs) =
            l.launch(ZERO_ID, "Project", "PRJ", Launcher.Terms({ratePpm: 1000, teamPool: POOL}), h);
        assertTrue(Treasury(tr).pauseGate() != address(0), "the pause");
        assertEq(Vester(vs).earlierReserve(), poolTotal, "and the reserve");
        assertEq(address(e.vester()), vs);
    }
}
