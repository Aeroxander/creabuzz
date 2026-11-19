// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "oz5/token/ERC20/IERC20.sol";
import {StackBase, Proj} from "./helpers/StackBase.sol";
import {Launcher} from "../src/Launcher.sol";
import {Treasury} from "../src/Treasury.sol";
import {Vester} from "../src/Vester.sol";
import {Pair} from "../src/Pair.sol";
import {ShareToken} from "../src/ShareToken.sol";
import {Parts} from "../src/Parts.sol";
import {ITreasuryRunner, ITreasuryClock, IShares} from "../src/Interfaces.sol";

/// @notice A dollar with the wrong number of decimals.
contract Dollar18 {
    function decimals() external pure returns (uint8) {
        return 18;
    }
}

/// @notice A dollar that has no `decimals` at all.
contract NotADollar {}

/// @notice Birth through the Launcher: the numbers a project is born with, the commitment to the platform settings, the
/// bounds on the founder's two numbers, the platform settings' own checks, and what is locked afterwards.
contract LauncherTest is StackBase {
    function _terms(uint32 rate, uint256 pool) internal pure returns (Launcher.Terms memory) {
        return Launcher.Terms({ratePpm: rate, teamPool: pool});
    }

    // ---- birth

    function test_aProjectIsBornWithTheNumbersTheFounderAndThePlatformSet() public view {
        assertEq(t.runner(), founder);
        assertEq(t.founder(), founder);
        assertEq(t.salePath(), address(launcher));
        assertEq(address(t.quote()), address(usd));
        assertEq(address(t.shares()), address(shares));
        assertEq(address(t.team()), address(team));
        assertEq(t.vester(), address(v));
        assertEq(t.platform(), platform);
        assertEq(t.unit(), UNIT);
        assertEq(t.feeBps(), 200);
        assertEq(t.ratePpm(), 1000);
        assertEq(t.agentUsd(), 25e6);
        assertEq(t.agentTeam(), POOL / 1000);
        assertEq(t.lastCheckIn(), T0);
        assertEq(t.lastSettle(), T0);
        assertTrue(t.doorFlag());
        assertTrue(t.doorOpenNow(), "a new project starts inside its window");
        assertEq(shares.controller(), address(t));
        assertEq(team.controller(), address(t));
        assertEq(shares.totalSupply(), 0);
        assertEq(team.totalSupply(), POOL);
        assertEq(team.balanceOf(address(v)), POOL, "the whole pool sits in the Vester");
        assertEq(address(v.treasury()), address(t));
        assertEq(address(v.team()), address(team));
        assertEq(team.name(), "Project Team");
        assertEq(team.symbol(), "PRJ-T");
        assertEq(shares.name(), "Project");
        assertEq(shares.symbol(), "PRJ");
        Launcher.Project memory p = launcher.project(founder, "p1");
        assertEq(p.founder, founder);
        assertEq(p.treasury, address(t));
        assertEq(p.shares, address(shares));
        assertEq(p.team, address(team));
        assertEq(p.vester, address(v));
        assertEq(p.launchedAt, T0);
        assertEq(launcher.projectByKey(key).treasury, address(t));
        assertEq(key, launcher.keyOf(founder, "p1"));
    }

    function test_theCloneAndItsPiecesCannotBeSetUpAgain() public {
        vm.expectRevert(Treasury.BadSetup.selector);
        t.initialize(
            Treasury.Setup({
                quote: IERC20(address(usd)),
                shares: IShares(address(shares)),
                team: IShares(address(team)),
                vester: address(v),
                founder: founder,
                platform: platform,
                salePath: address(launcher),
                unit: UNIT,
                ratePpm: 1,
                feeBps: 1,
                agentUsd: 1,
                agentTeam: 1
            })
        );
        vm.expectRevert(ShareToken.BadBirth.selector);
        shares.initialize("x", "x", address(t), address(0), 0);
        vm.expectRevert(ShareToken.BadBirth.selector);
        team.initialize("x", "x", address(t), address(v), 1);
        vm.expectRevert(Vester.AlreadyInitialized.selector);
        v.initialize(ITreasuryClock(address(t)), IShares(address(team)), POOL);
    }

    function test_theImplementationsAreLocked() public {
        ShareToken tokenImpl = ShareToken(launcher.shareImpl());
        Vester vesterImpl = Vester(launcher.vesterImpl());
        Pair pairImpl = Pair(launcher.pairImpl());
        Treasury treasuryImpl = Treasury(launcher.treasuryImpl());
        vm.expectRevert(ShareToken.BadBirth.selector);
        tokenImpl.initialize("x", "x", address(t), address(0), 0);
        vm.expectRevert(Vester.AlreadyInitialized.selector);
        vesterImpl.initialize(ITreasuryClock(address(t)), IShares(address(team)), POOL);
        vm.expectRevert(Pair.BadSetup.selector);
        pairImpl.initialize(ITreasuryRunner(address(t)), address(0), alice, bob);
        assertEq(treasuryImpl.founder(), address(1), "the Treasury implementation is locked");
    }

    function test_aNewProjectAcceptsAJoinAtOnceAndKeepsItsDoorForTwoUnits() public {
        Proj memory p = _launch(alice, "fresh", 1000, POOL);
        assertGt(_joinIn(p.t, bob, 1000e6), 0);
        vm.warp(block.timestamp + 2 * UNIT - 1);
        assertTrue(p.t.doorOpenNow());
    }

    // ---- the commitment

    function test_aLaunchRefusesSettingsTheFounderDidNotSee() public {
        bytes32 seen = launcher.settingsHash();
        Launcher.Platform memory next = _platform(UNIT);
        next.feeBps = 500;
        vm.prank(admin);
        launcher.setSettings(next);
        assertTrue(launcher.settingsHash() != seen);
        vm.prank(alice);
        vm.expectRevert(Launcher.SettingsMoved.selector);
        launcher.launch("late", "N", "N", _terms(1000, POOL), seen);
        // the new hash is accepted, and the project is born with the new fee
        vm.prank(alice);
        (,, address tr,) = launcher.launch("late", "N", "N", _terms(1000, POOL), launcher.launchHash(key));
        assertEq(Treasury(tr).feeBps(), 500);
        assertEq(t.feeBps(), 200, "a project already launched keeps what it was born with");
    }

    function test_theHashCoversTheFeeTheUnitTheDollarThePlatformAndTheAgentLimit() public {
        bytes32 h = launcher.settingsHash();
        Launcher.Platform memory p = _platform(UNIT);
        p.agentUsd = 26e6;
        vm.prank(admin);
        launcher.setSettings(p);
        assertTrue(launcher.settingsHash() != h);
        h = launcher.settingsHash();
        p.unit = 168;
        vm.prank(admin);
        launcher.setSettings(p);
        assertTrue(launcher.settingsHash() != h);
        h = launcher.settingsHash();
        p.platform = alice;
        vm.prank(admin);
        launcher.setSettings(p);
        assertTrue(launcher.settingsHash() != h);
    }

    function test_theSameFounderCannotReuseAnIdButAnotherCan() public {
        bytes32 h = launcher.settingsHash();
        vm.prank(founder);
        vm.expectRevert(Launcher.ProjectExists.selector);
        launcher.launch("p1", "N", "N", _terms(1000, POOL), h);
        _launch(alice, "p1", 1000, POOL); // the same id under another founder is another project
    }

    function test_aProjectNobodyLaunchedIsUnknown() public {
        vm.expectRevert(Launcher.UnknownProject.selector);
        launcher.projectByKey(bytes32(uint256(1)));
        vm.expectRevert(Launcher.UnknownProject.selector);
        launcher.project(alice, "none");
        vm.expectRevert(Launcher.UnknownProject.selector);
        launcher.makePair(bytes32(uint256(1)), alice);
        vm.expectRevert(Launcher.UnknownProject.selector);
        launcher.windDown(bytes32(uint256(1)));
    }

    // ---- the founder's two numbers

    function test_theAllowanceRateStopsAtTheCeiling() public {
        bytes32 h = launcher.settingsHash();
        vm.prank(alice);
        vm.expectRevert(Launcher.BadTerms.selector);
        launcher.launch("a", "N", "N", _terms(2001, POOL), h);
        vm.prank(alice);
        launcher.launch("b", "N", "N", _terms(2000, POOL), h);
        vm.prank(alice);
        launcher.launch("c", "N", "N", _terms(0, POOL), h);
    }

    function test_theTeamPoolStopsAtOneHundredMillionShares() public {
        bytes32 h = launcher.settingsHash();
        vm.prank(alice);
        vm.expectRevert(Launcher.BadTerms.selector);
        launcher.launch("a", "N", "N", _terms(1000, 100_000_000e18 + 1), h);
        vm.prank(alice);
        (, address tm,,) = launcher.launch("b", "N", "N", _terms(1000, 100_000_000e18), h);
        assertEq(ShareToken(tm).totalSupply(), 100_000_000e18);
        vm.prank(alice);
        (, address tm0, address tr0,) = launcher.launch("c", "N", "N", _terms(1000, 0), h);
        assertEq(ShareToken(tm0).totalSupply(), 0, "no team at all is allowed");
        assertEq(Treasury(tr0).agentTeam(), 0);
    }

    function test_namesAreOneToSixtyFourBytes() public {
        bytes32 h = launcher.settingsHash();
        bytes memory long = new bytes(65);
        for (uint256 i; i < 65; ++i) {
            long[i] = "a";
        }
        vm.startPrank(alice);
        vm.expectRevert(Launcher.BadName.selector);
        launcher.launch("a", "", "N", _terms(1000, POOL), h);
        vm.expectRevert(Launcher.BadName.selector);
        launcher.launch("a", "N", "", _terms(1000, POOL), h);
        vm.expectRevert(Launcher.BadName.selector);
        launcher.launch("a", string(long), "N", _terms(1000, POOL), h);
        vm.expectRevert(Launcher.BadName.selector);
        launcher.launch("a", "N", string(long), _terms(1000, POOL), h);
        vm.stopPrank();
    }

    // ---- the platform settings

    function test_platformSettingsAreChecked() public {
        Launcher.Platform memory p = _platform(UNIT);
        vm.startPrank(admin);
        p.quote = IERC20(address(0));
        vm.expectRevert(Launcher.BadSettings.selector);
        launcher.setSettings(p);
        p = _platform(UNIT);
        p.platform = address(0);
        vm.expectRevert(Launcher.BadSettings.selector);
        launcher.setSettings(p);
        p = _platform(UNIT);
        p.platform = address(launcher);
        vm.expectRevert(Launcher.BadSettings.selector);
        launcher.setSettings(p);
        p = _platform(UNIT);
        p.platform = address(usd);
        vm.expectRevert(Launcher.BadSettings.selector);
        launcher.setSettings(p);
        p = _platform(UNIT);
        p.feeBps = 501;
        vm.expectRevert(Launcher.BadSettings.selector);
        launcher.setSettings(p);
        p = _platform(UNIT);
        p.quote = IERC20(makeAddr("an account, not a token"));
        vm.expectRevert(Launcher.BadSettings.selector);
        launcher.setSettings(p);
        p.quote = IERC20(address(new Dollar18()));
        vm.expectRevert(Launcher.BadSettings.selector);
        launcher.setSettings(p);
        p.quote = IERC20(address(new NotADollar()));
        vm.expectRevert(Launcher.BadSettings.selector);
        launcher.setSettings(p);
        p = _platform(UNIT);
        p.feeBps = 500;
        launcher.setSettings(p);
        vm.stopPrank();
    }

    function test_theTimeUnitIsAMultipleOf168AndSevenDaysOffATestNetwork() public {
        Launcher.Platform memory p = _platform(0);
        vm.startPrank(admin);
        vm.expectRevert(Launcher.BadSettings.selector);
        launcher.setSettings(p);
        p.unit = 169;
        vm.expectRevert(Launcher.BadSettings.selector);
        launcher.setSettings(p);
        p.unit = 1680; // a test network may set it short
        launcher.setSettings(p);
        vm.stopPrank();
        assertTrue(launcher.testNetwork());
        // on a real network only 7 days is accepted
        vm.chainId(1);
        Launcher real = new Launcher(admin, _platform(UNIT), parts);
        assertFalse(real.testNetwork());
        vm.prank(admin);
        vm.expectRevert(Launcher.BadSettings.selector);
        real.setSettings(_platform(1680));
        vm.expectRevert(Launcher.BadSettings.selector);
        new Launcher(admin, _platform(1680), parts);
        vm.prank(admin);
        real.setSettings(_platform(UNIT));
    }

    function test_aShortUnitScalesEveryDayCount() public {
        Launcher.Platform memory p = _platform(1680);
        vm.prank(admin);
        launcher.setSettings(p);
        Proj memory q = _launch(alice, "short", 1000, POOL);
        assertEq(q.t.unit(), 1680);
        _joinIn(q.t, bob, 100_000e6);
        vm.warp(block.timestamp + 2 * 1680 - 1);
        assertTrue(q.t.doorOpenNow());
        vm.warp(block.timestamp + 1);
        assertFalse(q.t.doorOpenNow(), "the window is 2 units of the short unit");
    }

    function test_theConstructorNeedsRealParts() public {
        vm.expectRevert();
        new Launcher(admin, _platform(UNIT), Parts(address(0)));
    }

    // ---- admin

    function test_onlyTheAdminChangesSettingsAndHandsTheSeatOn() public {
        vm.prank(stranger);
        vm.expectRevert(Launcher.NotAdmin.selector);
        launcher.setSettings(_platform(UNIT));
        vm.prank(stranger);
        vm.expectRevert(Launcher.NotAdmin.selector);
        launcher.transferAdmin(stranger);
        vm.prank(admin);
        vm.expectRevert(Launcher.BadSettings.selector);
        launcher.transferAdmin(address(0));
        vm.prank(admin);
        launcher.transferAdmin(alice);
        assertEq(launcher.admin(), alice);
        vm.prank(admin);
        vm.expectRevert(Launcher.NotAdmin.selector);
        launcher.setSettings(_platform(UNIT));
    }

    // ---- the Pair

    function test_makePairAndTheSeat() public {
        address predicted = launcher.pairAddress(key, founder, bob);
        vm.prank(founder);
        t.handOver(predicted, false);
        assertEq(t.runner(), founder, "nothing moves until the Pair accepts");
        vm.expectEmit(true, true, false, true, address(launcher));
        emit Launcher.PairMade(key, predicted, founder, bob);
        vm.prank(bob);
        address pair = launcher.makePair(key, founder);
        assertEq(pair, predicted);
        assertEq(t.runner(), pair);
        // the same pair cannot be made twice
        vm.prank(bob);
        vm.expectRevert();
        launcher.makePair(key, founder);
    }
}
