// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {StackBase} from "./helpers/StackBase.sol";
import {Treasury} from "../src/Treasury.sol";
import {Vester} from "../src/Vester.sol";
import {Pair} from "../src/Pair.sol";
import {Launcher} from "../src/Launcher.sol";

/// @notice Each event of the Vester, the agents, the Pair and the Launcher, with its exact fields: they carry the resulting
/// state so a server can rebuild without redoing the math.
contract EventsTest is StackBase {
    uint256 internal constant AMOUNT = 1_040_000e18;

    function test_projectLaunchedCarriesEverythingAServerNeeds() public {
        vm.recordLogs();
        Launcher.Terms memory terms = Launcher.Terms({ratePpm: 700, teamPool: 5_000_000e18});
        bytes32 h = launcher.settingsHash();
        vm.prank(alice);
        (address sh, address tm, address tr, address vs) = launcher.launch("ev", "Evt", "EVT", terms, h);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(launcher)) continue;
            assertEq(logs[i].topics[0], Launcher.ProjectLaunched.selector);
            assertEq(logs[i].topics[1], launcher.keyOf(alice, "ev"));
            assertEq(logs[i].topics[2], bytes32("ev"));
            assertEq(address(uint160(uint256(logs[i].topics[3]))), alice);
            (Launcher.Project memory p, Launcher.Terms memory tt, Launcher.Platform memory pl) =
                abi.decode(logs[i].data, (Launcher.Project, Launcher.Terms, Launcher.Platform));
            assertEq(p.founder, alice);
            assertEq(p.shares, sh);
            assertEq(p.team, tm);
            assertEq(p.treasury, tr);
            assertEq(p.vester, vs);
            assertEq(p.launchedAt, block.timestamp);
            assertEq(tt.ratePpm, 700);
            assertEq(tt.teamPool, 5_000_000e18);
            assertEq(address(pl.quote), address(usd));
            assertEq(pl.platform, platform);
            assertEq(pl.feeBps, 200);
            assertEq(pl.unit, UNIT);
            assertEq(pl.agentUsd, 25e6);
            found = true;
        }
        assertTrue(found);
    }

    function test_launcherSettingsAndAdminEvents() public {
        Launcher.Platform memory p = _platform(UNIT);
        p.feeBps = 300;
        vm.expectEmit(false, false, false, true, address(launcher));
        emit Launcher.SettingsChanged(p);
        vm.prank(admin);
        launcher.setSettings(p);
        vm.expectEmit(true, false, false, false, address(launcher));
        emit Launcher.AdminOffered(alice);
        vm.prank(admin);
        launcher.transferAdmin(alice);
        vm.expectEmit(true, false, false, false, address(launcher));
        emit Launcher.AdminChanged(alice);
        vm.prank(alice);
        launcher.acceptAdmin();
    }

    function test_grantMadeAndClaimed() public {
        _active(2 * UNIT);
        uint256 start = t.activeNow();
        vm.expectEmit(true, true, false, true, address(v));
        emit Vester.GrantMade(0, alice, AMOUNT, start, 0);
        _grant(alice, AMOUNT);
        _active(13 * UNIT);
        vm.expectEmit(true, true, false, true, address(v));
        emit Vester.GrantClaimed(0, alice, 130_000e18);
        v.claim(0);
    }

    function test_forfeitAnnouncedAndForfeited() public {
        uint256 id = _grant(alice, AMOUNT);
        _active(5 * UNIT);
        uint64 burnAt = uint64(block.timestamp + UNIT);
        vm.expectEmit(false, false, false, true, address(t));
        emit Treasury.BurnAnnounced(990_000e18, 990_000e18);
        vm.expectEmit(true, true, false, true, address(v));
        emit Vester.ForfeitAnnounced(id, alice, 990_000e18, true, burnAt, 990_000e18);
        vm.prank(alice);
        v.announceForfeit(id);
        vm.warp(burnAt);
        vm.expectEmit(true, true, false, true, address(v));
        emit Vester.Forfeited(id, alice, 990_000e18, 0, POOL - 990_000e18);
        v.execute(id);
    }

    function test_theWindDownBurnsEmitForfeitedAndUngrantedBurned() public {
        uint256 id = _grant(alice, 400_000e18);
        vm.prank(founder);
        launcher.windDown(key);
        vm.warp(block.timestamp + UNIT);
        vm.expectEmit(true, true, false, true, address(v));
        emit Vester.Forfeited(id, alice, 400_000e18, 0, POOL - 400_000e18);
        v.burnAfterWindDown(id);
        vm.expectEmit(false, false, false, true, address(v));
        emit Vester.UngrantedBurned(POOL - 400_000e18, 0);
        v.burnUngrantedAfterWindDown();
    }

    function test_agentSetEvents() public {
        vm.expectEmit(true, false, false, true, address(t));
        emit Treasury.AgentSet(bob, true, 25e6, POOL / 1000);
        vm.prank(founder);
        t.authoriseAgent(bob);
        vm.expectEmit(true, false, false, true, address(t));
        emit Treasury.AgentSet(bob, true, 7e6, 3e18);
        vm.prank(founder);
        t.setAgent(bob, 7e6, 3e18);
        vm.expectEmit(true, false, false, true, address(t));
        emit Treasury.AgentSet(bob, false, 7e6, 3e18);
        vm.prank(founder);
        t.revokeAgent(bob);
    }

    function test_pairEvents() public {
        Pair pair = _makePair(bob);
        bytes memory data = abi.encodeCall(Treasury.setDoor, (false));
        bytes32 id = pair.callId(address(t), data, 0);
        vm.expectEmit(true, true, false, true, address(pair));
        emit Pair.Proposed(id, founder, address(t), data, 0);
        vm.prank(founder);
        pair.propose(address(t), data);
        vm.expectEmit(true, true, false, false, address(pair));
        emit Pair.Executed(id, bob);
        vm.prank(bob);
        pair.confirm(address(t), data, 0);
        assertFalse(t.doorFlag());
        bytes memory again = abi.encodeCall(Treasury.setDoor, (true));
        vm.prank(bob);
        bytes32 id2 = pair.propose(address(t), again);
        vm.expectEmit(true, false, false, false, address(pair));
        emit Pair.Cancelled(id2);
        vm.prank(bob);
        pair.cancel(id2);
    }
}
