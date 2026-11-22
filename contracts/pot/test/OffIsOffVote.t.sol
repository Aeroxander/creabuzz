// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "oz5/token/ERC20/IERC20.sol";
import {Journey} from "./OffIsOff.t.sol";
import {Proj} from "./helpers/StackBase.sol";
import {QuoteToken} from "./mocks/QuoteToken.sol";
import {Council} from "../src/Council.sol";
import {HolderPause} from "../src/HolderPause.sol";
import {HolderVote} from "../src/HolderVote.sol";
import {Launcher} from "../src/Launcher.sol";
import {ShareToken} from "../src/ShareToken.sol";
import {TaskBook} from "../src/TaskBook.sol";
import {Treasury} from "../src/Treasury.sol";
import {Vester} from "../src/Vester.sol";

/// @notice The switch-off proof for the *vote* contract (COUNCIL-PLAN 4.4 point 3), modelled on `OffIsOffCouncil.t.sol`. The same
/// fuzzed sequence of 120 steps as `OffIsOffDiffTest` runs on a stack with every switch off and on a stack with the pause AND the
/// Council bound — a `HolderVote` as the project's pause and a bound `Council` — where nobody opens a ballot and nobody makes a
/// Council. After every step every public view of the Treasury, Vester, the task book and both tokens is equal and every step
/// succeeds or fails alike.
///
/// The second stack also parks and takes Shares back, which is what makes this a proof about the vote contract rather than about a
/// project that never touches it: `park` and `unpark` run the vote contract's `_beforeChange`/`_afterUnpark` hooks, and with no ballot
/// live they must write nothing. The park is always followed by the matching `unpark` inside the same step, because Shares left in the
/// vote contract's custody would show in the token's own balances, which the differential compares. With the switches off there is no
/// pause to park in, so the pair runs only on the switch-on stack.
contract OffIsOffVoteDiffTest is Journey {
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
        launcherOn.bindPause(address(new HolderVote()));
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
        assertTrue(HolderVote(on.t.pauseGate()).isVote(), "and it is the vote contract");
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

    /// @dev Park `who`'s Shares in the vote contract and take them back in the same step: the hooks run with no ballot live and must
    /// write nothing, so every view (the token's balances included) is where it was.
    function _parkAndUnpark(address who, uint256 r) internal {
        HolderVote gate = HolderVote(on.t.pauseGate());
        uint256 bal = on.shares.balanceOf(who);
        if (bal == 0) {
            _same("park and unpark");
            return;
        }
        uint256 n = 1 + r % bal;
        vm.startPrank(who);
        on.shares.approve(address(gate), n);
        gate.park(n);
        assertEq(gate.parkedOf(who), n, "parked");
        gate.unpark(n);
        vm.stopPrank();
        assertEq(on.shares.balanceOf(who), bal, "the Shares came back");
        assertEq(gate.parkedOf(who), 0);
        assertEq(gate.parkedTotal(), 0);
        assertEq(gate.armedAt(), 0, "a park that reached the line was cleared by the unpark");
        assertFalse(gate.paused());
        _same("park and unpark");
    }

    /// forge-config: default.fuzz.runs = 300
    function testFuzz_aVoteStackWithNoBallotEverOpenedBehavesLikeOneWithEverySwitchOff(uint256 seed) public {
        HolderVote gate = HolderVote(on.t.pauseGate());
        bytes32 gateKey = launcherOn.keyOf(founder, "p1");
        uint256 x = uint256(keccak256(abi.encode(seed)));
        for (uint256 step; step < 120; ++step) {
            x = uint256(keccak256(abi.encode(x, step)));
            address who = people[x % 5];
            uint256 r = (x >> 8) % 1_000_000;
            uint256 kind = (x >> 64) % 22;
            // a quarter of the steps also park and un-park in the vote contract (only it has one)
            if ((x >> 160) % 4 == 0) _parkAndUnpark(who, r);
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
        // nobody opened a ballot and nobody made a Council: the vote contract was the pause and nothing else
        assertEq(gate.current(), 0, "no ballot was opened");
        assertEq(gate.nextBallot(), 0);
        assertEq(gate.parkedTotal(), 0, "the parks were all taken back");
        assertEq(gate.armedAt(), 0);
        assertFalse(gate.paused());
        assertEq(address(gate.treasury()), address(on.t));
        assertEq(gate.key(), gateKey);
        assertEq(launcherOn.runnerKindOf(founder), 0, "no runner contract was made");
        assertEq(on.t.runner(), founder);
        assertEq(uint256(HolderPause(on.t.pauseGate()).day()), uint256(UNIT / 7));
    }

    function test_aVoteStackWithNoBallotEverOpenedHasTheVoteContractAsItsPauseAndNoCouncil() public view {
        HolderVote gate = HolderVote(on.t.pauseGate());
        assertTrue(gate.isVote());
        assertEq(gate.current(), 0);
        assertEq(gate.nextBallot(), 0);
        assertEq(gate.nextReplaceAt(), 0);
        assertEq(gate.parkedTotal(), 0);
        assertEq(gate.armedAt(), 0);
        assertFalse(gate.paused());
        assertEq(address(gate.treasury()), address(on.t));
        assertEq(gate.key(), launcherOn.keyOf(founder, "p1"));
        assertEq(launcherOn.runnerKindOf(founder), 0);
        assertEq(on.t.runner(), founder, "the founder still runs it");
        assertEq(launcherOn.councilImpl() != address(0), true, "the switch is on, but no Council was made");
        assertEq(t.runner(), on.t.runner());
    }
}
