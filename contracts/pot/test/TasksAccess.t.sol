// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {StackBase} from "./helpers/StackBase.sol";
import {Treasury} from "../src/Treasury.sol";
import {TaskBook} from "../src/TaskBook.sol";
import {Pair} from "../src/Pair.sol";

/// @notice Every new money call of the task queue as the wrong party, on the real stack (Launcher, clones, Pair): a stranger, the
/// payee, an agent, a backer, one Pair signer alone, the old runner or the old Pair after a hand-over; the book refuses everyone
/// but the Treasury; a stale proposal never reaches another serial; the queue in a quiet and a wound-down project.
contract TasksAccessTest is StackBase {
    bytes32 internal constant WHAT = keccak256("task");
    address internal worker = makeAddr("worker");
    address internal agent = makeAddr("agent");
    address internal sig2 = makeAddr("sig2");
    address internal next = makeAddr("next runner");

    function setUp() public override {
        super.setUp();
        _join(alice, 60_000e6);
        _join(bob, 40_000e6);
        vm.prank(founder);
        t.authoriseAgent(agent);
    }

    function _warpAlive(uint256 ts) internal {
        if (ts <= block.timestamp) return;
        _checkIn();
        uint256 at = block.timestamp;
        while (at + 10 days < ts) {
            at += 6 days;
            vm.warp(at);
            _checkIn();
        }
        vm.warp(ts);
    }

    /// @dev One taken task (serial 1, worker) and one announced task (serial 2).
    function _two() internal returns (uint64 taken, uint64 announced) {
        vm.prank(founder);
        taken = t.announceTask(WHAT, worker, 10_000e6, 100);
        _warpAlive(_book().taskOf(taken).noticeEnd);
        vm.prank(worker);
        t.takeTask(taken, 0);
        vm.prank(founder);
        announced = t.announceTask(WHAT, address(0), 10_000e6, 100);
    }

    function _refused(address who, bytes memory data, string memory what) internal {
        vm.prank(who);
        (bool ok,) = address(t).call(data);
        assertFalse(ok, what);
    }

    function test_runnerOnlyCallsRefuseEveryoneElse() public {
        (uint64 a, uint64 b) = _two();
        address[4] memory who = [stranger, worker, agent, alice];
        for (uint256 i; i < who.length; ++i) {
            _refused(who[i], abi.encodeCall(Treasury.announceTask, (WHAT, address(0), 1e6, 1)), "announce");
            _refused(who[i], abi.encodeCall(Treasury.acceptTask, (a, 1)), "accept");
            _refused(who[i], abi.encodeCall(Treasury.rejectTask, (a)), "reject");
            _refused(who[i], abi.encodeCall(Treasury.cancelTask, (b)), "cancel");
        }
    }

    function test_theTaskBookRefusesEveryoneButTheTreasury() public {
        (uint64 a,) = _two();
        TaskBook bk = _book();
        address[3] memory who = [stranger, founder, worker];
        for (uint256 i; i < who.length; ++i) {
            vm.startPrank(who[i]);
            vm.expectRevert(TaskBook.NotAllowed.selector);
            bk.announce(WHAT, address(0), 1e6, 1);
            vm.expectRevert(TaskBook.NotAllowed.selector);
            bk.take(a, who[i], 1e12, 0);
            vm.expectRevert(TaskBook.NotAllowed.selector);
            bk.accept(a, 1);
            vm.expectRevert(TaskBook.NotAllowed.selector);
            bk.reject(a);
            vm.expectRevert(TaskBook.NotAllowed.selector);
            bk.cancel(a);
            vm.expectRevert(TaskBook.NotAllowed.selector);
            bk.expireDue();
            vm.expectRevert(TaskBook.NotAllowed.selector);
            bk.sweepAll();
            vm.expectRevert(TaskBook.NotAllowed.selector);
            bk.mintNotes(who[i], 1, 1);
            vm.expectRevert(TaskBook.NotAllowed.selector);
            bk.claim(a, who[i]);
            vm.expectRevert(TaskBook.BadSetup.selector);
            bk.initialize(who[i], 1);
            vm.stopPrank();
        }
    }

    function test_theImplementationsAreLocked() public {
        TaskBook impl = TaskBook(launcher.tasksImpl());
        vm.expectRevert(TaskBook.BadSetup.selector);
        impl.initialize(address(this), 168);
        vm.expectRevert(TaskBook.NotAllowed.selector);
        impl.announce(WHAT, address(0), 1e6, 1);
    }

    function test_theTakerAndTheSignersCannotTakeOrBePaidAsTeam() public {
        Pair p = _makePair(sig2);
        // the open task is announced by the Pair (both signers)
        bytes memory c = abi.encodeCall(Treasury.announceTask, (WHAT, address(0), 10_000e6, 100));
        uint256 n = p.nonce();
        vm.prank(founder);
        p.propose(address(t), c);
        vm.prank(sig2);
        p.confirm(address(t), c, n);
        _warpAlive(_book().taskOf(1).noticeEnd);
        _refused(founder, abi.encodeCall(Treasury.takeTask, (1, 0)), "first signer takes");
        _refused(sig2, abi.encodeCall(Treasury.takeTask, (1, 0)), "second signer takes");
        _refused(address(p), abi.encodeCall(Treasury.takeTask, (1, 0)), "the pair takes");
        // a named payee that is a signer is refused at announce
        c = abi.encodeCall(Treasury.announceTask, (WHAT, sig2, 10_000e6, 100));
        n = p.nonce();
        vm.prank(founder);
        p.propose(address(t), c);
        vm.prank(sig2);
        vm.expectRevert(Treasury.NotAllowed.selector);
        p.confirm(address(t), c, n);
    }

    function test_oneSignerAloneCannotDoAnythingToTheQueue() public {
        Pair p = _makePair(sig2);
        bytes memory c = abi.encodeCall(Treasury.announceTask, (WHAT, worker, 10_000e6, 100));
        uint256 n = p.nonce();
        vm.prank(founder);
        p.propose(address(t), c);
        vm.prank(sig2);
        p.confirm(address(t), c, n);
        _warpAlive(_book().taskOf(1).noticeEnd);
        vm.prank(worker);
        t.takeTask(1, 0);
        // either signer alone, directly and through the Pair
        address[2] memory s = [founder, sig2];
        address bk = address(_book());
        for (uint256 i; i < 2; ++i) {
            _refused(s[i], abi.encodeCall(Treasury.acceptTask, (1, 1e6)), "accept");
            _refused(s[i], abi.encodeCall(Treasury.rejectTask, (1)), "reject");
            _refused(s[i], abi.encodeCall(Treasury.cancelTask, (1)), "cancel");
            _refused(s[i], abi.encodeCall(Treasury.announceTask, (WHAT, worker, 1e6, 1)), "announce");
            // the proposer cannot confirm their own call
            bytes memory call_ = abi.encodeCall(Treasury.acceptTask, (1, 1e6));
            uint256 k = p.nonce();
            vm.prank(s[i]);
            p.propose(address(t), call_);
            vm.prank(s[i]);
            vm.expectRevert(Pair.NotAllowed.selector);
            p.confirm(address(t), call_, k);
            // and a call to anything but the Treasury and the Launcher is refused
            vm.prank(s[i]);
            vm.expectRevert(Pair.BadTarget.selector);
            p.propose(bk, abi.encodeCall(TaskBook.accept, (1, 1)));
            vm.prank(s[i]);
            vm.expectRevert(Pair.BadTarget.selector);
            p.propose(address(usd), "");
        }
        // a stranger cannot propose, confirm or cancel
        vm.prank(stranger);
        vm.expectRevert(Pair.NotAllowed.selector);
        p.propose(address(t), abi.encodeCall(Treasury.rejectTask, (1)));
        // only the proposer may withdraw
        bytes memory c2 = abi.encodeCall(Treasury.rejectTask, (1));
        uint256 n2 = p.nonce();
        vm.prank(founder);
        bytes32 id = p.propose(address(t), c2);
        vm.prank(sig2);
        vm.expectRevert(Pair.NotAllowed.selector);
        p.cancel(id);
        vm.prank(stranger);
        vm.expectRevert(Pair.NotAllowed.selector);
        p.confirm(address(t), c2, n2);
    }

    function test_theOldRunnerAfterAHandOverCannotRunTheQueue() public {
        (uint64 a, uint64 b) = _two();
        vm.prank(founder);
        t.handOver(next, false);
        vm.prank(next);
        t.takeSeat();
        address old = founder;
        _refused(old, abi.encodeCall(Treasury.announceTask, (WHAT, address(0), 1e6, 1)), "announce");
        _refused(old, abi.encodeCall(Treasury.acceptTask, (a, 1)), "accept");
        _refused(old, abi.encodeCall(Treasury.rejectTask, (a)), "reject");
        _refused(old, abi.encodeCall(Treasury.cancelTask, (b)), "cancel");
        // the agent the old runner set is off: it cannot be a runner and its own rights are gone
        _refused(agent, abi.encodeCall(Treasury.draw, (agent, 1)), "agent draw");
        // the new runner can clear what the old one left
        vm.startPrank(next);
        t.cancelTask(b);
        t.rejectTask(a);
        vm.stopPrank();
        assertEq(_book().openCount(), 0);
        assertEq(t.locked(), 0);
    }

    function test_anOldPairAfterAHandOverCannotRunAnything() public {
        Pair p = _makePair(sig2);
        bytes memory c = abi.encodeCall(Treasury.announceTask, (WHAT, address(0), 10_000e6, 100));
        uint256 n = p.nonce();
        vm.prank(founder);
        p.propose(address(t), c);
        // the pair hands the seat to a new person
        bytes memory ho = abi.encodeCall(Treasury.handOver, (next, false));
        uint256 n2 = p.nonce();
        vm.prank(founder);
        p.propose(address(t), ho);
        vm.prank(sig2);
        p.confirm(address(t), ho, n2);
        vm.prank(next);
        t.takeSeat();
        // the earlier, still pending proposal can no longer run
        vm.prank(sig2);
        vm.expectRevert(Treasury.NotAllowed.selector);
        p.confirm(address(t), c, n);
        // and the Pair as a caller is just a stranger now
        _refused(address(p), abi.encodeCall(Treasury.announceTask, (WHAT, address(0), 1e6, 1)), "pair announce");
        // either old signer may take a task now (they are not the seat any more)
        vm.prank(next);
        uint64 s = t.announceTask(WHAT, address(0), 10_000e6, 100);
        _warpAlive(_book().taskOf(s).noticeEnd);
        vm.prank(sig2);
        t.takeTask(s, 0);
        // but the new runner decides whether they are paid (and can reject)
        vm.prank(next);
        t.rejectTask(s);
        assertEq(t.locked(), 0);
    }

    function test_aStaleProposalNeverReachesAnotherSerial() public {
        Pair p = _makePair(sig2);
        bytes memory c = abi.encodeCall(Treasury.announceTask, (WHAT, worker, 10_000e6, 100));
        uint256 n = p.nonce();
        vm.prank(founder);
        p.propose(address(t), c);
        vm.prank(sig2);
        p.confirm(address(t), c, n);
        _warpAlive(_book().taskOf(1).noticeEnd);
        vm.prank(worker);
        t.takeTask(1, 0);
        // a payment of serial 1 is proposed; before it is confirmed the task is rejected and another announced
        bytes memory pay = abi.encodeCall(Treasury.acceptTask, (1, 500e6));
        uint256 np = p.nonce();
        vm.prank(founder);
        p.propose(address(t), pay);
        bytes memory rej = abi.encodeCall(Treasury.rejectTask, (1));
        _bothTo(p, founder, sig2, address(t), rej);
        vm.prank(sig2);
        vm.expectRevert(TaskBook.WrongTaskState.selector);
        p.confirm(address(t), pay, np); // stale: the task it was about is gone
        _bothTo(p, founder, sig2, address(t), c);
        _warpAlive(_book().taskOf(2).noticeEnd);
        vm.prank(worker);
        t.takeTask(2, 0);
        assertEq(usd.balanceOf(worker), 0);
        // the same bytes with another nonce are not the proposal
        vm.prank(sig2);
        vm.expectRevert(Pair.UnknownCall.selector);
        p.confirm(address(t), pay, np + 1);
        // a proposal dies after two units
        vm.warp(block.timestamp + 2 * uint256(UNIT) + 1);
        vm.prank(sig2);
        vm.expectRevert(Pair.Expired.selector);
        p.confirm(address(t), pay, np);
    }

    function test_theQueueInAQuietAndAWoundDownProject() public {
        (uint64 a, uint64 b) = _two();
        // quiet: the window closes after two units without a check-in; a taken task can still be settled
        vm.warp(block.timestamp + 4 * uint256(UNIT));
        _refused(founder, abi.encodeCall(Treasury.announceTask, (WHAT, address(0), 1e6, 1)), "announce while quiet");
        // task b lapsed meanwhile; a ran out
        vm.prank(stranger);
        t.returnTask(a);
        assertEq(t.locked(), 0);
        assertEq(_book().openCount(), 0);
        vm.prank(stranger);
        t.returnTask(b); // lapsed counts as back
        // after 26 units anyone may wind down; then nothing can be announced or taken, and a note can still be claimed
        vm.warp(block.timestamp + 30 * uint256(UNIT));
        vm.prank(stranger);
        t.windDown();
        _refused(founder, abi.encodeCall(Treasury.announceTask, (WHAT, address(0), 1e6, 1)), "announce after");
        _refused(worker, abi.encodeCall(Treasury.takeTask, (b, 0)), "take after");
        _refused(founder, abi.encodeCall(Treasury.acceptTask, (a, 1)), "accept after");
        // and every holder can still take out
        uint256 nb = shares.balanceOf(bob);
        vm.prank(bob);
        assertGt(t.leave(nb, 0, bob), 0);
    }
}
