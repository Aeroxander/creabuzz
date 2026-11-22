// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "oz5/token/ERC20/IERC20.sol";
import {Journey} from "./OffIsOff.t.sol";
import {Proj} from "./helpers/StackBase.sol";
import {QuoteToken} from "./mocks/QuoteToken.sol";
import {Council} from "../src/Council.sol";
import {HolderPause} from "../src/HolderPause.sol";
import {Launcher} from "../src/Launcher.sol";
import {ShareToken} from "../src/ShareToken.sol";
import {Treasury} from "../src/Treasury.sol";
import {TaskBook} from "../src/TaskBook.sol";
import {Vester} from "../src/Vester.sol";

/// @notice The switch-off proof, extended for the Council switch. The same fuzzed sequence of 120 steps as `OffIsOffDiffTest`
/// (this contract is that test's body, copied: its `setUp` is not `virtual`, and `OffIsOff.t.sol` is not edited) runs on a stack
/// with every switch off and on a stack with the pause AND the Council bound where nobody opens a ballot and nobody makes a
/// Council; after every step every public view of the Treasury, Vester, task book and both tokens is equal and every step
/// succeeds or fails alike. This proves the new contracts are inert unless used. For the old bytecode the witnesses are the
/// golden digest of `OffIsOff.t.sol` (unedited, on the real Launcher) and the whole old suite.
contract OffIsOffCouncilDiffTest is Journey {
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
        launcherOn.bindCouncil(address(new Council()));
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
        assertTrue(launcherOn.councilImpl() != address(0), "and its Council switch");
        assertEq(launcher.councilImpl(), address(0), "and the first has none");
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

    /// forge-config: default.fuzz.runs = 300
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

    function test_aCouncilThatIsNeverMadeLeavesTheRunnerAFounderAndKindZero() public view {
        assertEq(on.t.runner(), founder);
        assertEq(launcherOn.runnerKindOf(founder), 0);
        assertEq(launcherOn.runnerKindOf(address(on.t)), 0);
        assertEq(t.runner(), on.t.runner());
    }
}
