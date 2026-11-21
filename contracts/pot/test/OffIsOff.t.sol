// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "oz5/token/ERC20/IERC20.sol";
import {StackBase, Proj} from "./helpers/StackBase.sol";
import {QuoteToken} from "./mocks/QuoteToken.sol";
import {Treasury} from "../src/Treasury.sol";
import {ShareToken} from "../src/ShareToken.sol";
import {Vester} from "../src/Vester.sol";
import {TaskBook} from "../src/TaskBook.sol";
import {Pair} from "../src/Pair.sol";
import {Launcher} from "../src/Launcher.sol";
import {HolderPause} from "../src/HolderPause.sol";

/// @notice With the pause switch OFF (the default) nothing may differ from the build at commit 1fed95002. Two proofs:
///
///  1. `OffIsOffGoldenTest`: one long deterministic journey through the real stack (two projects, joins, an allowance, an
///     agent, a rate change, the door, tasks taken, paid in part, rejected, cancelled and lapsed, exit notes and their claims,
///     vesting and Team take-outs, a Pair, a forfeit, a wind-down and what follows) records every log the contracts emit and
///     every balance, and the digest of all of it (154 logs) equals the digest the BUILD AT 1fed95002 gave for the same journey.
///     The golden value below was produced by running this very journey (without the pause lines) in a copy of that commit's
///     `contracts/pot/src` and `test/helpers`: both builds print 0x33368c2e...043a over 154 logs (see the K1 report).
///  2. `OffIsOffDiffTest`: the same fuzzed sequence of 120 steps on a stack with the switch off and on a stack with the switch
///     ON where nobody parks; after every step every public view of the Treasury, Vester, TaskBook and both tokens is equal
///     and every step succeeds or fails alike. (This proves the gate is inert unless Shares are parked; it does not by
///     itself prove the old bytecode's behaviour: point 1 and the old suite are the witness for that.)
abstract contract Journey is StackBase {
    address internal worker = makeAddr("worker");
    address internal erin = makeAddr("erin");
    address internal agent = makeAddr("agent");

    /// @dev Everything the journey touches that is not a log: balances and the views of the default project.
    function _state() internal view returns (bytes32 d) {
        address[8] memory who = [alice, bob, carol, dave, erin, worker, founder, platform];
        for (uint256 i; i < who.length; ++i) {
            d = keccak256(abi.encode(d, usd.balanceOf(who[i]), shares.balanceOf(who[i]), team.balanceOf(who[i])));
        }
        d = keccak256(
            abi.encode(
                d,
                usd.balanceOf(address(t)),
                shares.totalSupply(),
                team.totalSupply(),
                team.balanceOf(address(v)),
                t.pot(),
                t.paidIn(),
                t.box(),
                t.arriving(),
                t.feesOwed(),
                t.locked(),
                t.notesOwed()
            )
        );
        d = keccak256(
            abi.encode(
                d,
                t.Z(),
                t.windDownKind(),
                t.windDownAt(),
                t.lastCheckIn(),
                t.activeSeconds(),
                t.nextExpiry(),
                t.runner(),
                t.ratePpm(),
                t.doorFlag(),
                v.committed(),
                t.leaveValue(),
                t.teamValue()
            )
        );
    }

    /// @dev The journey. Time is moved to absolute seconds so it reads the same on every build.
    function _journey() internal {
        Proj memory q = _launch(alice, "second", 500, 1_000_000e18);
        _joinIn(q.t, bob, 10_000e6);
        // ---- backing, outside money, grants and a plain allowance
        _join(alice, 50_000e6);
        _join(bob, 20_000e6);
        _revenue(carol, 5000e6);
        vm.warp(T0 + 2 days);
        _checkIn();
        uint256 grantId = _grant(dave, 2_000_000e18);
        _grant(erin, 500_000e18);
        vm.warp(T0 + 5 days);
        _checkIn();
        t.settle();
        uint256 half = t.box() / 2;
        vm.prank(founder);
        t.draw(founder, half);
        vm.prank(founder);
        t.authoriseAgent(agent);
        vm.prank(agent);
        t.draw(agent, 1e6);
        // ---- a rate change and the door
        vm.prank(founder);
        t.proposeRate(1500);
        vm.warp(T0 + 12 days);
        _checkIn();
        t.applyRate();
        vm.prank(founder);
        t.setRate(1200);
        vm.prank(founder);
        t.setDoor(false);
        vm.prank(founder);
        t.setDoor(true);
        // ---- tasks: paid in part, rejected with an exit note against it, cancelled, lapsed
        vm.prank(founder);
        uint64 a = t.announceTask(bytes32(uint256(1)), worker, 5000e6, 100);
        vm.prank(founder);
        uint64 b = t.announceTask(bytes32(uint256(2)), address(0), 4000e6, 80);
        vm.prank(founder);
        uint64 c = t.announceTask(bytes32(uint256(3)), address(0), 100e6, 10);
        vm.prank(founder);
        uint64 dd = t.announceTask(bytes32(uint256(4)), address(0), 100e6, 10);
        vm.prank(founder);
        t.cancelTask(c);
        uint256 end = _book().taskOf(b).noticeEnd;
        uint256 endA = _book().taskOf(a).noticeEnd;
        if (endA > end) end = endA;
        for (uint256 i = 1; T0 + 12 days + i * 6 days < end; ++i) {
            vm.warp(T0 + 12 days + i * 6 days);
            _checkIn();
        }
        vm.warp(end);
        _checkIn();
        vm.prank(worker);
        t.takeTask(a, 0);
        vm.prank(erin);
        t.takeTask(b, 0);
        vm.prank(founder);
        t.acceptTask(a, 500e6);
        _leave(alice, shares.balanceOf(alice) * 3 / 10); // writes notes against the task still open
        vm.prank(founder);
        t.rejectTask(b);
        t.claimNote(b, alice);
        // the last task is never taken and lapses after its window
        vm.warp(end + UNIT + 1 days);
        _checkIn();
        t.settle();
        t.returnTask(dd);
        // ---- vesting and a Team take-out
        for (uint256 i = 1; i <= 16; ++i) {
            vm.warp(end + UNIT + 1 days + i * 6 days);
            _checkIn();
        }
        vm.warp(end + UNIT + 1 days + 100 days);
        _checkIn();
        v.claim(grantId);
        _revenue(carol, 20_000e6);
        vm.warp(end + UNIT + 1 days + 108 days);
        _checkIn();
        uint256 teamHalf = team.balanceOf(dave) / 2;
        vm.prank(dave);
        t.leaveTeam(teamHalf, 0, dave);
        _leave(bob, shares.balanceOf(bob) / 2);
        // ---- the second project (the same Launcher) settles much later
        vm.prank(alice);
        q.t.settle();
        // ---- a Pair, a forfeit, a wind-down and what follows
        Pair pair = _makePair(carol);
        _both(pair, founder, carol, abi.encodeCall(Treasury.grantTeam, (worker, 300_000e18)));
        _both(pair, carol, founder, abi.encodeCall(Treasury.announceForfeit, (2)));
        _both(pair, founder, carol, abi.encodeCall(Treasury.announceTask, (bytes32(uint256(5)), address(0), 100e6, 10)));
        vm.warp(end + UNIT + 1 days + 120 days);
        _checkIn();
        _both(pair, founder, carol, abi.encodeCall(Treasury.windDown, ()));
        _leave(bob, shares.balanceOf(bob));
        t.collectFees();
        vm.warp(end + UNIT + 1 days + 140 days);
        uint256 rest = shares.balanceOf(alice);
        vm.prank(alice);
        t.leave(rest, 0, alice);
    }
}

contract OffIsOffGoldenTest is Journey {
    /// @dev The digest of every log and the final state of `_journey` on the build at 1fed95002.
    bytes32 internal constant GOLDEN = 0x33368c2e42df204bc8ff70338860c7f35e41e9c2d8d37011f9207aa205f8043a;

    function _digest() internal returns (bytes32 d) {
        vm.recordLogs();
        _journey();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            d = keccak256(abi.encode(d, logs[i].emitter, logs[i].topics, logs[i].data));
        }
        emit log_named_uint("logs in the journey", logs.length);
        d = keccak256(abi.encode(d, _state()));
    }

    function test_theJourneyWithTheSwitchOffIsByteForByteWhatTheOldBuildDid() public {
        bytes32 d = _digest();
        emit log_named_bytes32("journey digest", d);
        assertEq(d, GOLDEN, "the journey differs from the build at 1fed95002");
    }

    function test_withTheSwitchOffEveryProjectHasNoGateAndTheOldSettingsHash() public {
        assertEq(t.pauseGate(), address(0));
        Proj memory p = _launch(bob, "other", 700, 5_000_000e18);
        assertEq(p.t.pauseGate(), address(0), "pauseGate() is zero on every project of a switch-off deployment");
        (IERC20 quote, address plat, uint16 fee, uint32 unit_, uint128 agentUsd) = launcher.platform();
        assertEq(
            launcher.settingsHash(),
            keccak256(abi.encode(Launcher.Platform(quote, plat, fee, unit_, agentUsd))),
            "settingsHash() is the old formula"
        );
    }
}

/// @notice The differential: a stack with the switch off against a stack with the switch on where nobody parks.
contract OffIsOffDiffTest is Journey {
    QuoteToken internal usdOn;
    Launcher internal launcherOn;
    Proj internal on;
    uint256 internal clock;
    address[5] internal people;
    uint64 internal serialsMade;
    uint256 internal grants;

    function setUp() public override {
        super.setUp(); // the OFF stack: usd, launcher, t (default project)
        usdOn = new QuoteToken();
        Launcher.Platform memory p = _platform(UNIT);
        p.quote = IERC20(address(usdOn));
        launcherOn = new Launcher(admin, p, parts);
        launcherOn.bindPause(address(new HolderPause()));
        bytes32 h = launcherOn.settingsHash();
        vm.prank(founder);
        (address sh, address tm, address tr, address vs) =
            launcherOn.launch("p1", "Project", "PRJ", Launcher.Terms({ratePpm: 1000, teamPool: POOL}), h);
        on = Proj({
            key: launcherOn.keyOf(founder, "p1"),
            t: Treasury(tr),
            shares: ShareToken(sh),
            team: ShareToken(tm),
            v: Vester(vs)
        });
        assertTrue(on.t.pauseGate() != address(0), "the second stack has its pause");
        assertEq(t.pauseGate(), address(0), "and the first does not");
        people = [alice, bob, carol, dave, erin];
        clock = T0;
    }

    /// @dev Everything public of a project, as one hash: no address of a project contract is in it (the two stacks differ in
    /// those), only numbers and the addresses of people.
    function _views(Treasury tr, ShareToken sh, ShareToken tm, Vester vs, QuoteToken u)
        internal
        view
        returns (bytes32 d)
    {
        TaskBook book = TaskBook(address(tr.tasks()));
        d = keccak256(
            abi.encode(
                tr.pot(),
                tr.paidIn(),
                tr.box(),
                tr.arriving(),
                tr.arrivalEnd(),
                tr.feesOwed(),
                tr.locked(),
                tr.notesOwed(),
                tr.ratePpm(),
                tr.pendingRatePpm(),
                tr.pendingAt(),
                tr.lastSettle(),
                tr.lastCheckIn(),
                tr.activeSeconds()
            )
        );
        d = keccak256(
            abi.encode(
                d,
                tr.doorFlag(),
                tr.windDownAt(),
                tr.windDownKind(),
                tr.Z(),
                tr.runner(),
                tr.pendingRunner(),
                tr.pendingTrim(),
                tr.pendingSeatAt(),
                tr.agentEpoch(),
                tr.nextExpiry(),
                tr.arrivalStart(),
                tr.arrivalTotal()
            )
        );
        d = keccak256(
            abi.encode(
                d,
                tr.leaveValue(),
                tr.teamValue(),
                tr.boxCap(),
                tr.activeNow(),
                tr.doorOpenNow(),
                tr.activeEnd(),
                tr.unaccounted(),
                u.balanceOf(address(tr)),
                sh.totalSupply(),
                tm.totalSupply(),
                tm.balanceOf(address(vs)),
                vs.committed(),
                vs.grantCount(),
                book.nextSerial()
            )
        );
        for (uint256 i; i < people.length; ++i) {
            d = keccak256(
                abi.encode(
                    d,
                    u.balanceOf(people[i]),
                    sh.balanceOf(people[i]),
                    tm.balanceOf(people[i]),
                    tr.agentUsdUsed(people[i])
                )
            );
        }
        d = keccak256(abi.encode(d, u.balanceOf(founder), u.balanceOf(platform), u.balanceOf(worker)));
    }

    function _same(string memory step) internal view {
        assertEq(
            _views(t, shares, team, v, usd),
            _views(on.t, on.shares, on.team, on.v, usdOn),
            string.concat("differs after ", step)
        );
    }

    /// @dev Make the same call on both stacks (as `from`) and require that both succeed or both fail with the same data.
    function _both2(address from, bytes memory data, bytes memory dataOn, string memory step) internal {
        vm.prank(from);
        (bool ok1, bytes memory r1) = address(t).call(data);
        vm.prank(from);
        (bool ok2, bytes memory r2) = address(on.t).call(dataOn);
        assertEq(ok1, ok2, string.concat("success differs: ", step));
        assertEq(keccak256(r1), keccak256(r2), string.concat("return or revert data differs: ", step));
        _same(step);
    }

    function _joinBoth(address who, uint256 amount) internal {
        usd.mint(who, amount);
        usdOn.mint(who, amount);
        vm.startPrank(who);
        usd.approve(address(t), amount);
        usdOn.approve(address(on.t), amount);
        vm.stopPrank();
        _both2(
            who,
            abi.encodeCall(Treasury.join, (amount, 0, who)),
            abi.encodeCall(Treasury.join, (amount, 0, who)),
            "join"
        );
    }

    function testFuzz_aStackWithTheSwitchOnAndNobodyParkingBehavesLikeOneWithItOff(uint256 seed) public {
        uint256 x = uint256(keccak256(abi.encode(seed)));
        for (uint256 step; step < 120; ++step) {
            x = uint256(keccak256(abi.encode(x, step)));
            address who = people[x % 5];
            uint256 r = (x >> 8) % 1_000_000;
            uint256 kind = (x >> 64) % 22;
            if (kind <= 2) {
                _joinBoth(who, 1e6 + r * 30_000);
            } else if (kind == 3) {
                uint256 n = shares.balanceOf(who) * (1 + r % 100) / 100;
                bytes memory c = abi.encodeCall(Treasury.leave, (n == 0 ? 1 : n, 0, who));
                _both2(who, c, c, "leave");
            } else if (kind == 4) {
                uint256 n = team.balanceOf(who) / 2;
                bytes memory c = abi.encodeCall(Treasury.leaveTeam, (n == 0 ? 1 : n, 0, who));
                _both2(who, c, c, "leaveTeam");
            } else if (kind == 5) {
                uint256 amount = 1e6 + r * 5000;
                usd.mint(who, amount);
                usdOn.mint(who, amount);
                vm.startPrank(who);
                usd.approve(address(t), amount);
                usdOn.approve(address(on.t), amount);
                vm.stopPrank();
                bytes memory c = abi.encodeCall(Treasury.addRevenue, (amount));
                _both2(who, c, c, "revenue");
            } else if (kind == 6 || kind == 7) {
                clock += 1 hours + r % 6 days;
                vm.warp(clock);
                bytes memory c = abi.encodeCall(Treasury.checkIn, (bytes32(x)));
                _both2(founder, c, c, "checkIn");
            } else if (kind == 8 || kind == 9) {
                bytes memory c = abi.encodeCall(Treasury.draw, (founder, 1 + r * 3));
                _both2(founder, c, c, "draw");
            } else if (kind == 10) {
                bytes memory c =
                    abi.encodeCall(Treasury.announceTask, (bytes32(x), address(0), 1e6 + r * 100, uint16(1 + r % 500)));
                _both2(founder, c, c, "announceTask");
                ++serialsMade;
            } else if (kind == 11 && serialsMade != 0) {
                bytes memory c = abi.encodeCall(Treasury.takeTask, (uint64(r % serialsMade), 0));
                _both2(who, c, c, "takeTask");
            } else if (kind == 12 && serialsMade != 0) {
                bytes memory c = abi.encodeCall(Treasury.acceptTask, (uint64(r % serialsMade), 1 + r));
                _both2(founder, c, c, "acceptTask");
            } else if (kind == 13 && serialsMade != 0) {
                bytes memory c = abi.encodeCall(Treasury.rejectTask, (uint64(r % serialsMade)));
                _both2(founder, c, c, "rejectTask");
            } else if (kind == 14 && serialsMade != 0) {
                bytes memory c = abi.encodeCall(Treasury.cancelTask, (uint64(r % serialsMade)));
                _both2(founder, c, c, "cancelTask");
            } else if (kind == 15 && serialsMade != 0) {
                bytes memory c = abi.encodeCall(Treasury.claimNote, (uint64(r % serialsMade), who));
                _both2(who, c, c, "claimNote");
            } else if (kind == 16) {
                bytes memory c = abi.encodeCall(Treasury.grantTeam, (who, 1e18 + r * 1e18));
                _both2(founder, c, c, "grantTeam");
                ++grants;
            } else if (kind == 17 && grants != 0) {
                uint256 id = r % grants;
                vm.prank(who);
                (bool ok1,) = address(v).call(abi.encodeCall(Vester.claim, (id)));
                vm.prank(who);
                (bool ok2,) = address(on.v).call(abi.encodeCall(Vester.claim, (id)));
                assertEq(ok1, ok2, "claim");
                _same("claim");
            } else if (kind == 18) {
                bytes memory c = abi.encodeCall(Treasury.proposeRate, (uint32(r % 2001)));
                _both2(founder, c, c, "proposeRate");
            } else if (kind == 19) {
                bytes memory c = abi.encodeCall(Treasury.applyRate, ());
                _both2(who, c, c, "applyRate");
            } else if (kind == 20) {
                bytes memory c = abi.encodeCall(Treasury.setDoor, (r % 2 == 0));
                _both2(founder, c, c, "setDoor");
            } else if (kind == 21 && r % 10 == 0) {
                bytes memory c = abi.encodeCall(Treasury.windDown, ());
                _both2(founder, c, c, "windDown");
            } else {
                bytes memory c = abi.encodeCall(Treasury.settle, ());
                _both2(who, c, c, "settle");
            }
        }
        // nothing was ever parked: the second stack's pause saw nothing
        assertEq(HolderPause(on.t.pauseGate()).parkedTotal(), 0);
        assertEq(HolderPause(on.t.pauseGate()).armedAt(), 0);
    }
}
