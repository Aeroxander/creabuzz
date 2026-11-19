// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {StdStorage, stdStorage} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {StackBase} from "./helpers/StackBase.sol";
import {Treasury} from "../src/Treasury.sol";
import {TaskBook} from "../src/TaskBook.sol";

/// @notice Replays every scenario of `model/vectors.json` (written by `model/gen_vectors.py` from the exact-decimal
/// reference model) against the real contracts, launched through the real Launcher, and compares every number after every
/// operation: the pot, paid-in, Shares, Team Shares, the allowance box, outside money arriving, fees owed, the burn queue, the
/// money set aside for taken tasks, the money held for exit notes,
/// and what each operation returned (Shares minted, cash paid, what a take-out at once would pay, what is left behind for
/// those who stay, dollars drawn, Team Shares announced and burned; for the task queue: the notice to the second, the money
/// set aside by a take, a take the cap refuses, a payment to a worker, the exit note a take-out writes, the money a note
/// claim pays).
///
/// TOLERANCE. The model is exact; the contracts round down (Shares minted, cash paid), round the platform fee up by at most
/// one unit, and cut paid-in down. Every such rounding is at most a few units of a dollar (a millionth), and it can carry
/// into a later price. So, after `k` operations, a dollar number may differ from the model's by
///     4 x k units  +  its own size x (4 x k) / X,
/// and a Share number (in wei) by 8 x k wei plus the same relative term, where X is the smallest money-in-the-quote
/// (pot + outside money arriving + the one-dollar offset) the project held before any operation so far while it had backers,
/// or the smallest join so far if that is less (a join's fee rounds by up to a unit, a part in its size of the Shares it mints).
/// The relative term is the dollar dust of the earlier operations as a share of the money that set their prices.
/// Tasks add one thing: a take-out spreads its note over the taken tasks and rounds each part down, so the few units that
/// floors leave stay in the stayers' claim; the allowance grows by 8 units for every open task at every take-out.
/// The test prints the worst deviation as a share of this allowance. A formula changed in a contract moves numbers by far more
/// (one part in a thousand or more); `scripts/check-mutations.py` in this folder proves it for a list of changes.
contract ModelVectorsTest is StackBase {
    using stdStorage for StdStorage;

    uint256 internal constant SHARE_BASE = 8; // wei per earlier operation
    uint256 internal constant USD_BASE = 4; // dollar units per earlier operation
    uint256 internal constant OFFSET = 1e6;

    string internal json;
    address[] internal actors;
    uint256[] internal gid; // grant index in the scenario -> Vester id
    address[] internal gmember;
    uint256 internal slack; // units added to every dollar allowance: the spread of exit notes rounds each part down
    uint256 internal worstPermille; // worst deviation as a thousandth of its allowance
    string internal worstWhere;
    uint256 internal checks;

    /// @dev One scenario's columns, read from the file once.
    struct Cols {
        uint256[] who;
        uint256[] x;
        uint256[] y;
        uint256[] o1;
        uint256[] o2;
        uint256[] o3;
        uint256[] o4;
        uint256[] P;
        uint256[] A;
        uint256[] B;
        uint256[] G;
        uint256[] box;
        uint256[] D;
        uint256[] fees;
        uint256[] Z;
        uint256[] locked;
        uint256[] notes;
    }

    // the scenario being replayed
    uint256 internal si;
    string internal sname;
    string[] internal kinds;
    uint256 internal minX;

    function setUp() public override {
        super.setUp();
        json = vm.readFile("model/vectors.json");
    }

    /// @dev The scenarios are replayed in chunks of five, one test each, so no one test runs out of gas.
    uint256 internal constant CHUNK = 5;
    uint256 internal constant CHUNKS = 17;

    function test_vectorFileIsCompleteAndAllChunksCoverIt() public view {
        uint256[] memory rates = abi.decode(vm.parseJson(json, ".scenarios[*].head.rate"), (uint256[]));
        assertGe(rates.length, 40, "the file holds the scenarios");
        assertLe(rates.length, CHUNK * CHUNKS, "a chunk is missing for the last scenarios");
    }

    function test_vectors_0() public {
        _chunk(0);
    }

    function test_vectors_1() public {
        _chunk(1);
    }

    function test_vectors_2() public {
        _chunk(2);
    }

    function test_vectors_3() public {
        _chunk(3);
    }

    function test_vectors_4() public {
        _chunk(4);
    }

    function test_vectors_5() public {
        _chunk(5);
    }

    function test_vectors_6() public {
        _chunk(6);
    }

    function test_vectors_7() public {
        _chunk(7);
    }

    function test_vectors_8() public {
        _chunk(8);
    }

    function test_vectors_9() public {
        _chunk(9);
    }

    function test_vectors_10() public {
        _chunk(10);
    }

    function test_vectors_11() public {
        _chunk(11);
    }

    function test_vectors_12() public {
        _chunk(12);
    }

    function test_vectors_13() public {
        _chunk(13);
    }

    function test_vectors_14() public {
        _chunk(14);
    }

    function test_vectors_15() public {
        _chunk(15);
    }

    function test_vectors_16() public {
        _chunk(16);
    }

    function _chunk(uint256 c) internal {
        uint256[] memory rates = abi.decode(vm.parseJson(json, ".scenarios[*].head.rate"), (uint256[]));
        uint256 ops;
        uint256 scenarios;
        for (uint256 i = c * CHUNK; i < (c + 1) * CHUNK && i < rates.length; ++i) {
            ops += _replay(i, uint32(rates[i]));
            ++scenarios;
        }
        emit log_named_uint("scenarios replayed", scenarios);
        emit log_named_uint("operations replayed", ops);
        emit log_named_uint("numbers compared", checks);
        emit log_named_uint("worst deviation, thousandths of the allowance", worstPermille);
        emit log_string(worstWhere);
        assertLt(worstPermille, 1000, "a number was outside its rounding allowance");
    }

    // ================================================== one scenario =================================================

    function _replay(uint256 i, uint32 rate) internal returns (uint256 n) {
        si = i;
        slack = 0;
        string memory h = _p(i, "head.");
        sname = vm.parseJsonString(json, string.concat(h, "name"));
        uint256 pool = vm.parseJsonUint(json, string.concat(h, "pool"));
        uint256 nActors = vm.parseJsonUint(json, string.concat(h, "actors"));
        delete actors;
        delete gid;
        delete gmember;
        for (uint256 a; a < nActors + 2; ++a) {
            actors.push(makeAddr(string.concat("act", vm.toString(a))));
        }
        _use(_launch(founder, bytes32(i + 1), rate, pool));
        _setupTeam(h);
        _setupForce(h);

        kinds = vm.parseJsonStringArray(json, string.concat(_p(i, "ops."), "kind"));
        n = kinds.length;
        Cols memory c = _cols();
        minX = type(uint256).max;
        if (shares.totalSupply() > 0) minX = OFFSET + t.pot() + t.arriving() + t.locked();
        for (uint256 j; j < n; ++j) {
            _op(j, keccak256(bytes(kinds[j])), c);
            // A warp is not followed by a settle: the next operation acts cold, on a clock nobody has settled, so each
            // entry point must settle first by itself (join, leave, leaveTeam, revenue, grant, the hooks).
            if (keccak256(bytes(kinds[j])) == keccak256("warp")) continue;
            t.settle(); // the model settles once more at the same second, after every operation
            _state(j, c);
            // the money that priced the next operation: what is in the quote now, while there are backers
            if (shares.totalSupply() > 0) {
                uint256 xNow = OFFSET + t.pot() + t.arriving() + t.locked();
                if (xNow < minX) minX = xNow;
            }
        }
    }

    function _setupTeam(string memory h) internal {
        uint256[] memory tw = vm.parseJsonUintArray(json, string.concat(h, "team_who"));
        if (tw.length == 0) return;
        uint256[] memory ta = vm.parseJsonUintArray(json, string.concat(h, "team_amt"));
        uint256[] memory ids = new uint256[](tw.length);
        for (uint256 k; k < tw.length; ++k) {
            vm.prank(founder);
            ids[k] = t.grantTeam(actors[tw[k]], ta[k]);
        }
        _active(104 * uint256(UNIT)); // the whole grant vests (13 time units cliff inside 104 of active time)
        for (uint256 k; k < tw.length; ++k) {
            v.claim(ids[k]);
        }
    }

    function _setupForce(string memory h) internal {
        uint256 p = vm.parseJsonUint(json, string.concat(h, "force_P"));
        if (p == 0) return;
        uint256 a = vm.parseJsonUint(json, string.concat(h, "force_A"));
        uint256[] memory fw = vm.parseJsonUintArray(json, string.concat(h, "force_who"));
        uint256[] memory fa = vm.parseJsonUintArray(json, string.concat(h, "force_amt"));
        stdstore.target(address(t)).sig("pot()").checked_write(p);
        stdstore.target(address(t)).sig("paidIn()").checked_write(a);
        usd.mint(address(t), p);
        for (uint256 k; k < fw.length; ++k) {
            vm.prank(address(t));
            shares.mint(actors[fw[k]], fa[k]);
        }
    }

    // ================================================== one operation ================================================

    function _op(uint256 j, bytes32 kind, Cols memory c) internal {
        (uint256 who, uint256 x, uint256 y) = (c.who[j], c.x[j], c.y[j]);
        uint256[] memory o1 = c.o1;
        uint256[] memory o2 = c.o2;
        uint256[] memory o3 = c.o3;
        uint256[] memory o4 = c.o4;
        address me = who < actors.length ? actors[who] : address(0);
        if (kind == keccak256("join")) {
            if (x < minX) minX = x; // the fee of a join rounds by up to a unit: a part in x of the Shares it mints
            usd.mint(me, x);
            vm.startPrank(me);
            usd.approve(address(t), x);
            (uint256 quoted, uint256 instant,,) = t.quoteBack(x);
            uint256 got = t.join(x, 0, me);
            vm.stopPrank();
            assertEq(got, quoted, _w(j, "the quote is what the join gave"));
            _near(j, "shares minted", got, o1[j], SHARE_BASE);
            _near(j, "take-out at once", instant, o2[j], USD_BASE);
        } else if (kind == keccak256("leave")) {
            uint256 nSh = shares.balanceOf(me) * x / y;
            (uint256 q, uint256 qNote, uint256 behind) = t.quoteTakeOut(me, nSh);
            vm.recordLogs();
            vm.prank(me);
            uint256 cash = t.leave(nSh, 0, me);
            assertEq(cash, q, _w(j, "the take-out quote is what leave paid"));
            uint256 note = _noteOfLeave(Treasury.Left.selector);
            assertEq(note, qNote, _w(j, "the take-out quote shows the note that was written"));
            slack += 8 * _book().openCount();
            _near(j, "cash", cash, o1[j], USD_BASE);
            _near(j, "shares burned", nSh, o2[j], SHARE_BASE);
            _near(j, "left behind", behind, o3[j], USD_BASE);
            _near(j, "exit note", note, o4[j], USD_BASE);
        } else if (kind == keccak256("leaveTeam")) {
            uint256 nT = team.balanceOf(me) * x / y;
            vm.recordLogs();
            vm.prank(me);
            uint256 cash = t.leaveTeam(nT, 0, me);
            uint256 note = _noteOfLeave(Treasury.TeamLeft.selector);
            slack += 8 * _book().openCount();
            _near(j, "team cash", cash, o1[j], USD_BASE);
            _near(j, "team shares burned", nT, o2[j], SHARE_BASE);
            _near(j, "team exit note", note, o4[j], USD_BASE);
        } else if (kind == keccak256("leaveTeamZero")) {
            uint256 nT = team.balanceOf(me);
            vm.prank(me);
            vm.expectRevert(Treasury.NothingToPay.selector);
            t.leaveTeam(nT, 0, me);
        } else if (kind == keccak256("revenue")) {
            usd.mint(me, x);
            vm.startPrank(me);
            usd.approve(address(t), x);
            t.addRevenue(x);
            vm.stopPrank();
        } else if (kind == keccak256("warp")) {
            vm.warp(block.timestamp + x);
        } else if (kind == keccak256("checkIn")) {
            _checkIn();
        } else if (kind == keccak256("draw")) {
            t.settle();
            uint256 amount = t.box();
            vm.prank(founder);
            t.draw(founder, amount);
            _near(j, "dollars drawn", amount, o1[j], USD_BASE);
        } else if (kind == keccak256("setRate")) {
            vm.prank(founder);
            t.setRate(uint32(x));
        } else if (kind == keccak256("proposeRate")) {
            vm.prank(founder);
            t.proposeRate(uint32(x));
        } else if (kind == keccak256("applyRate")) {
            t.applyRate();
        } else if (kind == keccak256("grant")) {
            vm.prank(founder);
            uint256 id = t.grantTeam(me, x);
            assertEq(y, gid.length, "grants are numbered in order");
            gid.push(id);
            gmember.push(me);
        } else if (kind == keccak256("ownExit")) {
            uint256 z0 = t.Z();
            vm.prank(gmember[who]);
            v.announceForfeit(gid[who]);
            _near(j, "announced to burn", t.Z() - z0, o1[j], SHARE_BASE);
        } else if (kind == keccak256("execute")) {
            uint256 z0 = t.Z();
            v.execute(gid[who]);
            _near(j, "burned", z0 - t.Z(), o1[j], SHARE_BASE);
        } else if (kind == keccak256("announce")) {
            vm.prank(founder);
            uint64 serial = t.announceTask(keccak256(abi.encode("vector task", si, o2[j])), me, y, uint16(x));
            assertEq(serial, o2[j], _w(j, "serials are numbered from 1, in order, never reused"));
            TaskBook.Task memory k = _book().taskOf(serial);
            assertEq(k.noticeEnd - k.announcedAt, o1[j], _w(j, "the notice is the model's, to the second"));
            (uint256 notice,,) = t.noticeFor(uint16(x));
            assertEq(notice, o1[j], _w(j, "noticeFor is the model's, to the second"));
            ++checks;
        } else if (kind == keccak256("cancel")) {
            vm.prank(founder);
            t.cancelTask(uint64(x));
        } else if (kind == keccak256("takeEarly")) {
            uint256 end = _book().taskOf(uint64(x)).noticeEnd;
            assertEq(block.timestamp + 1, end, _w(j, "one second before the notice ends"));
            vm.prank(me);
            vm.expectRevert(abi.encodeWithSelector(TaskBook.NoticeRunning.selector, end));
            t.takeTask(uint64(x), 0);
        } else if (kind == keccak256("take")) {
            vm.prank(me);
            uint256 got = t.takeTask(uint64(x), 0);
            _near(j, "dollars set aside", got, o1[j], USD_BASE);
        } else if (kind == keccak256("takeBlocked")) {
            vm.prank(me);
            vm.expectPartialRevert(TaskBook.CapReached.selector);
            t.takeTask(uint64(x), 0);
        } else if (kind == keccak256("accept") || kind == keccak256("acceptAll")) {
            address worker = _book().taskOf(uint64(x)).takenBy;
            uint256 pay = kind == keccak256("accept") ? y : _book().taskOf(uint64(x)).locked;
            uint256 before = usd.balanceOf(worker);
            vm.prank(founder);
            t.acceptTask(uint64(x), pay);
            assertEq(usd.balanceOf(worker) - before, pay, _w(j, "the worker is paid what the runner named"));
            _near(j, "payment", pay, o1[j], USD_BASE);
        } else if (kind == keccak256("reject")) {
            vm.prank(founder);
            t.rejectTask(uint64(x));
        } else if (kind == keccak256("claim")) {
            uint256 paid = t.claimNote(uint64(x), me);
            _near(j, "note paid", paid, o1[j], USD_BASE);
        } else if (kind == keccak256("windDown")) {
            vm.prank(founder);
            t.windDown();
        } else {
            revert("unknown operation kind in the vector file");
        }
    }

    /// @dev The exit note a take-out wrote, from its own event (third number of `Left` and `TeamLeft`).
    function _noteOfLeave(bytes32 sig) internal returns (uint256 note) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(t) && logs[i].topics[0] == sig) {
                (,, note) = abi.decode(logs[i].data, (uint256, uint256, uint256));
            }
        }
    }

    function _state(uint256 j, Cols memory c) internal {
        _near(j, "pot", t.pot(), c.P[j], USD_BASE);
        _near(j, "paid-in", t.paidIn(), c.A[j], USD_BASE);
        _near(j, "backer Shares", shares.totalSupply(), c.B[j], SHARE_BASE);
        _near(j, "Team Shares", team.totalSupply(), c.G[j], SHARE_BASE);
        _near(j, "allowance box", t.box(), c.box[j], USD_BASE);
        _near(j, "outside money arriving", t.arriving(), c.D[j], USD_BASE);
        _near(j, "fees owed", t.feesOwed(), c.fees[j], USD_BASE);
        _near(j, "burn queue", t.Z(), c.Z[j], SHARE_BASE);
        _near(j, "money set aside for tasks", t.locked(), c.locked[j], USD_BASE);
        _near(j, "money held for notes", t.notesOwed(), c.notes[j], USD_BASE);
    }

    // ================================================== comparing ====================================================

    function _near(uint256 j, string memory what, uint256 actual, uint256 expected, uint256 base) internal {
        uint256 k = j + 1;
        uint256 den = minX;
        uint256 allowance = base * k + (expected * 4 * k) / den + 1 + slack;
        uint256 diff = actual > expected ? actual - expected : expected - actual;
        ++checks;
        uint256 permille = diff * 1000 / allowance;
        if (permille > worstPermille) {
            worstPermille = permille;
            worstWhere = string.concat(
                sname, " op ", vm.toString(j), " ", what, ": ", vm.toString(actual), " vs ", vm.toString(expected)
            );
        }
        if (diff > allowance) {
            emit log_named_string("scenario", sname);
            emit log_named_uint("operation", j);
            emit log_named_string("number", what);
            emit log_named_uint("contract", actual);
            emit log_named_uint("model", expected);
            emit log_named_uint("allowance", allowance);
            fail("a contract number is outside the rounding allowance of the model");
        }
    }

    function _w(uint256 j, string memory what) internal view returns (string memory) {
        return string.concat(sname, " op ", vm.toString(j), ": ", what);
    }

    function _p(uint256 i, string memory tail) internal pure returns (string memory) {
        return string.concat(".scenarios[", vm.toString(i), "].", tail);
    }

    function _col(string memory name) internal view returns (uint256[] memory) {
        return vm.parseJsonUintArray(json, string.concat(_p(si, "ops."), name));
    }

    function _cols() internal view returns (Cols memory c) {
        c.who = _col("who");
        c.x = _col("x");
        c.y = _col("y");
        c.o1 = _col("o1");
        c.o2 = _col("o2");
        c.o3 = _col("o3");
        c.o4 = _col("o4");
        c.P = _col("P");
        c.A = _col("A");
        c.B = _col("B");
        c.G = _col("G");
        c.box = _col("box");
        c.D = _col("D");
        c.fees = _col("fees");
        c.Z = _col("Z");
        c.locked = _col("locked");
        c.notes = _col("notes");
    }
}
