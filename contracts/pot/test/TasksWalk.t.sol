// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {StackBase} from "./helpers/StackBase.sol";
import {Treasury} from "../src/Treasury.sol";
import {TaskBook} from "../src/TaskBook.sol";
import {Pair} from "../src/Pair.sol";
import {Launcher} from "../src/Launcher.sol";

/// @notice A random walk over the REAL stack (Launcher, clones, Pair) with the moves the
/// builders' handler lacks: a hand-over to another person, a Pair made mid-project, a hand-over back, quiet stretches, wind-down
/// by choice and after 26 quiet units, agents, strangers taking open tasks. Fails on a Panic, an `Inconsistent`, a revert of
/// `leave` or `settle`, a broken bucket identity, or money that cannot be got out at the end.
contract TasksWalkTest is StackBase {
    address internal w1 = makeAddr("w1");
    address internal w2 = makeAddr("w2");
    address internal r2 = makeAddr("r2");
    address internal r3 = makeAddr("r3");
    address internal sig2 = makeAddr("sig2");
    address internal agent = makeAddr("agent");
    address[] internal holders;
    uint256 internal rng;
    uint256 internal step;
    string internal lastOp;

    function _unit() internal view virtual returns (uint32) {
        return UNIT;
    }

    function setUp() public virtual override {
        super.setUp();
        if (_unit() != UNIT) {
            // a project on a network with a short time unit
            launcher = new Launcher(admin, _platform(_unit()), parts);
            _use(_launch(founder, "short", 1000, POOL));
        }
        holders.push(alice);
        holders.push(bob);
        holders.push(carol);
        holders.push(dave);
        _join(alice, 40_000e6);
        _join(bob, 30_000e6);
    }

    function _r(uint256 mod) internal returns (uint256) {
        rng = uint256(keccak256(abi.encode(rng, step)));
        return rng % mod;
    }

    function _bad(bytes memory ret, string memory what) internal pure returns (bool) {
        if (ret.length < 4) return false;
        bytes4 s = bytes4(ret);
        return s == 0x4e487b71 || s == Treasury.Inconsistent.selector || s == Treasury.TokenMisbehaved.selector
            || s == TaskBook.Inconsistent.selector || keccak256(bytes(what)) == keccak256("never");
    }

    function _call(address from, bytes memory data) internal returns (bool ok, bytes memory ret) {
        vm.prank(from);
        (ok, ret) = address(t).call(data);
        if (!ok && _bad(ret, "")) {
            emit log_string(lastOp);
            emit log_named_uint("step", step);
            emit log_named_bytes("revert", ret);
            fail();
        }
    }

    function _asRunner(bytes memory data) internal returns (bool ok, bytes memory ret) {
        address r = t.runner();
        if (!launcher.isPair(r)) return _call(r, data);
        Pair p = Pair(r);
        uint256 n = p.nonce();
        vm.prank(p.first());
        p.propose(address(t), data);
        vm.prank(p.second());
        (ok, ret) = address(p).call(abi.encodeCall(p.confirm, (address(t), data, n)));
        if (!ok && _bad(ret, "")) {
            emit log_string(lastOp);
            emit log_named_bytes("revert", ret);
            fail();
        }
    }

    function _alive() internal {
        address r = t.runner();
        if (t.windDownKind() != 0) return;
        if (launcher.isPair(r)) {
            vm.prank(Pair(r).first());
            Pair(r).checkIn(bytes32(0));
        } else {
            vm.prank(r);
            t.checkIn(bytes32(0));
        }
    }

    function _actor() internal returns (address) {
        uint256 k = _r(9);
        if (k < 4) return holders[k];
        if (k == 4) return w1;
        if (k == 5) return w2;
        if (k == 6) return stranger;
        if (k == 7) return agent;
        return t.runner();
    }

    function _openSerial() internal returns (uint64) {
        uint64 n = _book().nextSerial();
        if (n <= 1) return 0;
        return uint64(1 + _r(n - 1));
    }

    function _op() internal {
        uint256 o = _r(24);
        if (o >= 18) o = 5 + (o % 3) * 2 - (o % 3); // more takes, accepts
        if (o == 0 || o == 1) {
            lastOp = "warp small + checkIn";
            vm.warp(block.timestamp + _r(uint256(_unit()) * 4 / 7) + 1);
            _alive();
        } else if (o == 2) {
            lastOp = "warp big (quiet)";
            vm.warp(block.timestamp + _r(6) * _unit() * 2 + _r(_unit()));
            if (_r(3) == 0) _alive();
        } else if (o == 3 || o == 4) {
            lastOp = "announce";
            address payee = _r(3) == 0 ? address(0) : (_r(2) == 0 ? w1 : (_r(2) == 0 ? w2 : agent));
            _asRunner(
                abi.encodeCall(
                    Treasury.announceTask,
                    (keccak256(abi.encode(step)), payee, (1 + _r(50_000)) * 1e6, uint16(1 + _r(500)))
                )
            );
        } else if (o == 5 || o == 6) {
            lastOp = "take";
            uint64 s = _openSerial();
            if (s == 0) return;
            TaskBook.Task memory k = _book().taskOf(s);
            if (k.state == TaskBook.State.Announced && block.timestamp < k.noticeEnd && _r(4) != 0) {
                _warpAlive(k.noticeEnd);
            }
            address who = k.payee != address(0) ? k.payee : _actor();
            if (_r(4) == 0) who = _actor();
            _call(who, abi.encodeCall(Treasury.takeTask, (s, 0)));
        } else if (o == 7) {
            lastOp = "accept";
            uint64 s = _openSerial();
            if (s == 0) return;
            TaskBook.Task memory k = _book().taskOf(s);
            uint256 pay = _r(3) == 0 ? k.locked : (k.locked * (1 + _r(100))) / 100;
            _asRunner(abi.encodeCall(Treasury.acceptTask, (s, pay)));
        } else if (o == 8) {
            lastOp = "reject";
            uint64 s = _openSerial();
            if (s != 0) _asRunner(abi.encodeCall(Treasury.rejectTask, (s)));
        } else if (o == 9) {
            lastOp = "cancel";
            uint64 s = _openSerial();
            if (s != 0) _asRunner(abi.encodeCall(Treasury.cancelTask, (s)));
        } else if (o == 10) {
            lastOp = "join";
            address who = holders[_r(4)];
            uint256 amt = (1 + _r(30_000)) * 1e6;
            usd.mint(who, amt);
            vm.prank(who);
            usd.approve(address(t), amt);
            _call(who, abi.encodeCall(Treasury.join, (amt, 0, who)));
        } else if (o == 11 || o == 12) {
            lastOp = "leave";
            address who = holders[_r(4)];
            uint256 bal = shares.balanceOf(who);
            if (bal == 0) return;
            uint256 n = _r(2) == 0 ? bal : (bal * (1 + _r(100))) / 100;
            _call(who, abi.encodeCall(Treasury.leave, (n, 0, who)));
        } else if (o == 13) {
            lastOp = "claim";
            uint64 s = _openSerial();
            if (s == 0) return;
            _call(_actor(), abi.encodeCall(Treasury.claimNote, (s, holders[_r(4)])));
        } else if (o == 14) {
            lastOp = "windDown";
            if (_r(10) != 0) return;
            if (_r(2) == 0) {
                _asRunner(abi.encodeCall(Treasury.windDown, ()));
            } else {
                _call(stranger, abi.encodeCall(Treasury.windDown, ()));
            }
        } else if (o == 15) {
            lastOp = "handOver to a person";
            if (_r(3) != 0) return;
            if (launcher.isPair(t.runner())) {
                _asRunner(abi.encodeCall(Treasury.handOver, (r2, false)));
            } else {
                address next = t.runner() == r2 ? r3 : r2;
                _call(t.runner(), abi.encodeCall(Treasury.handOver, (next, false)));
            }
            address po = t.pendingRunner();
            if (po != address(0)) _call(po, abi.encodeCall(Treasury.takeSeat, ()));
        } else if (o == 16) {
            lastOp = "make a Pair";
            if (_r(2) != 0) return;
            if (launcher.isPair(t.runner()) || t.runner() != founder) return;
            address predicted = launcher.pairAddress(key, founder, sig2);
            _call(founder, abi.encodeCall(Treasury.handOver, (predicted, false)));
            vm.prank(sig2);
            try launcher.makePair(key, founder) {} catch {}
        } else {
            lastOp = "revenue / agent";
            if (_r(2) == 0) {
                address who = holders[_r(4)];
                uint256 amt = (1 + _r(5000)) * 1e6;
                usd.mint(who, amt);
                vm.prank(who);
                usd.approve(address(t), amt);
                _call(who, abi.encodeCall(Treasury.addRevenue, (amt)));
            } else {
                _asRunner(abi.encodeCall(Treasury.authoriseAgent, (agent)));
            }
        }
    }

    function _warpAlive(uint256 ts) internal {
        if (ts <= block.timestamp) return;
        _alive();
        uint256 at = block.timestamp;
        while (at + uint256(_unit()) * 10 / 7 < ts) {
            at += uint256(_unit()) * 6 / 7;
            vm.warp(at);
            _alive();
        }
        vm.warp(ts);
    }

    function _check() internal {
        // conservation
        uint256 acc = t.pot() + t.box() + t.arriving() + t.feesOwed() + t.locked() + t.notesOwed();
        assertGe(usd.balanceOf(address(t)), acc, "owes more than it holds");
        // the book against the Treasury
        TaskBook b = _book();
        uint64 n = b.nextSerial();
        uint256 sumC;
        uint256 owedNotes;
        for (uint64 s = 1; s < n; ++s) {
            TaskBook.Task memory k = b.taskOf(s);
            if (k.state == TaskBook.State.Taken) {
                sumC += k.stayer;
                owedNotes += k.noteFace;
                assertEq(uint256(k.stayer) + k.noteFace, k.locked, "C + N == L");
            } else if (
                k.state == TaskBook.State.Paid || k.state == TaskBook.State.Rejected
                    || k.state == TaskBook.State.Returned
            ) {
                owedNotes += k.notesLeft;
            }
        }
        assertEq(sumC, t.locked(), "locked is the sum of the stayers' claims");
        assertEq(owedNotes, t.notesOwed(), "notesOwed is the face of live notes plus what is left for ended ones");
    }

    function _probes() internal {
        // settle must always work
        (bool ok, bytes memory ret) = _call(stranger, abi.encodeCall(Treasury.settle, ()));
        if (!ok) {
            emit log_string(lastOp);
            emit log_named_bytes("settle reverted", ret);
            fail();
        }
        // every holder who would be paid something can take everything out
        for (uint256 i; i < holders.length; ++i) {
            address h = holders[i];
            uint256 bal = shares.balanceOf(h);
            if (bal == 0) continue;
            (uint256 cashNow,,) = t.quoteTakeOut(h, bal);
            if (cashNow == 0) continue;
            uint256 id = vm.snapshotState();
            vm.prank(h);
            try t.leave(bal, 0, h) returns (uint256 got) {
                assertEq(got, cashNow, "quote equals action");
            } catch (bytes memory err) {
                emit log_string(lastOp);
                emit log_named_uint("step", step);
                emit log_named_address("holder", h);
                emit log_named_bytes("leave reverted", err);
                fail();
            }
            vm.revertToState(id);
        }
    }

    function test_walkStats() public {
        uint256[8] memory c;
        uint256 noteRuns;
        uint256 pairRuns;
        uint256 handRuns;
        for (uint256 seed = 1; seed <= 25; ++seed) {
            uint256 id = vm.snapshotState();
            _walk(seed);
            TaskBook b = _book();
            for (uint64 s = 1; s < b.nextSerial(); ++s) {
                c[uint256(b.taskOf(s).state)]++;
                for (uint256 i; i < holders.length; ++i) {
                    if (b.noteOf(s, holders[i]) != 0) noteRuns++;
                }
            }
            if (launcher.isPair(t.runner())) pairRuns++;
            if (t.runner() == r2 || t.runner() == r3) handRuns++;
            vm.revertToState(id);
        }
        // the walk reaches every end of a task and the three kinds of runner
        assertGt(c[3], 0, "some task was paid");
        assertGt(c[4], 0, "some task was rejected");
        assertGt(c[5], 0, "some task ran out");
        assertGt(c[6] + c[7], 0, "some task was withdrawn or lapsed");
        assertGt(pairRuns, 0, "some runs end with a Pair as runner");
        assertGt(handRuns, 0, "some runs end with a handed-over runner");
        emit log_named_uint("announced-only", c[1]);
        emit log_named_uint("taken", c[2]);
        emit log_named_uint("paid", c[3]);
        emit log_named_uint("rejected", c[4]);
        emit log_named_uint("returned", c[5]);
        emit log_named_uint("cancelled", c[6]);
        emit log_named_uint("lapsed", c[7]);
        emit log_named_uint("notes still unclaimed at end", noteRuns);
        emit log_named_uint("runs ending with a Pair runner", pairRuns);
        emit log_named_uint("runs ending with a handed-over runner", handRuns);
    }

    function testFuzz_walk(uint256 seed) public {
        _walk(seed);
    }

    function _walk(uint256 seed) internal {
        rng = seed;
        for (step = 0; step < 60; ++step) {
            _op();
            _check();
            _probes();
        }
        // drain: wind down, claim every note, everyone out
        vm.warp(block.timestamp + 30 * uint256(_unit()));
        if (t.windDownKind() == 0) _call(stranger, abi.encodeCall(Treasury.windDown, ()));
        assertEq(t.locked(), 0, "no money still set aside after a wind-down");
        TaskBook b = _book();
        for (uint64 s = 1; s < b.nextSerial(); ++s) {
            for (uint256 i; i < holders.length; ++i) {
                if (b.noteOf(s, holders[i]) != 0) {
                    (bool ok, bytes memory ret) = _call(stranger, abi.encodeCall(Treasury.claimNote, (s, holders[i])));
                    if (!ok && bytes4(ret) != TaskBook.NothingToPay.selector) {
                        emit log_named_bytes("claim reverted", ret);
                        fail();
                    }
                }
            }
        }
        assertEq(t.notesOwed(), 0, "every note was claimed or void");
        for (uint256 i; i < holders.length; ++i) {
            uint256 bal = shares.balanceOf(holders[i]);
            if (bal == 0) continue;
            (uint256 cashNow,,) = t.quoteTakeOut(holders[i], bal);
            if (cashNow == 0) continue;
            vm.prank(holders[i]);
            t.leave(bal, 0, holders[i]);
        }
        _check();
    }
}

/// @notice The same walk on a network whose time unit is 168 seconds (the smallest the contracts take).
contract TasksWalkShortTest is TasksWalkTest {
    function _unit() internal pure override returns (uint32) {
        return 168;
    }
}
