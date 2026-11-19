// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "oz5/token/ERC20/IERC20.sol";
import {PotBase} from "./helpers/PotBase.sol";
import {Treasury} from "../src/Treasury.sol";
import {TaskBook} from "../src/TaskBook.sol";
import {TreasuryHarness} from "./helpers/TreasuryHarness.sol";
import {MockPair} from "./helpers/Mocks.sol";

/// @notice The task queue as the Treasury runs it: announce, the notice, take, accept (in full and in part), reject, cancel
/// and return, with the money in its buckets, who may call what, and the quiet and wind-down rules. The project has no
/// allowance (rate 0), so the pot is exactly what the test forced it to be, and the numbers are exact. Dollar numbers are in
/// units of 1e-6; the pot is 100,000 dollars.
contract TasksTest is PotBase {
    bytes32 internal constant WHAT = keccak256("a task");
    address internal worker = makeAddr("worker");
    address internal agent = makeAddr("agent");

    function setUp() public override {
        super.setUp();
        _relaunch(POOL, 0); // no allowance: the pot moves only by the tasks
        _join(alice, 60_000e6);
        _join(bob, 40_000e6);
        _force(100_000e6, 100_000e6, 0, 0, 0);
    }

    // ---- helpers

    function _announce(uint16 bps, uint256 max) internal returns (uint64 serial) {
        return _announce(bps, max, worker);
    }

    function _announce(uint16 bps, uint256 max, address payee) internal returns (uint64 serial) {
        vm.prank(founder);
        serial = t.announceTask(WHAT, payee, max, bps);
    }

    /// @dev Move the clock to `ts`, with the founder checking in on the way so the window never closes.
    function _warpAlive(uint256 ts) internal {
        if (ts <= vm.getBlockTimestamp()) return; // time only runs forward
        _checkIn();
        uint256 at = vm.getBlockTimestamp();
        while (at + 10 days < ts) {
            at += 6 days; // an absolute time: the optimizer may cache a repeated vm.getBlockTimestamp()
            vm.warp(at);
            _checkIn();
        }
        vm.warp(ts);
    }

    function _noticeEnd(uint64 serial) internal view returns (uint256) {
        return _book().taskOf(serial).noticeEnd;
    }

    function _take(uint64 serial, address who) internal returns (uint256 amount) {
        _warpAlive(_noticeEnd(serial));
        vm.prank(who);
        amount = t.takeTask(serial, 0);
    }

    function _accept(uint64 serial, uint256 pay) internal {
        vm.prank(founder);
        t.acceptTask(serial, pay);
    }

    function _pairRunner() internal returns (MockPair pair) {
        pair = new MockPair(founder, bob);
        sale.setPair(address(pair), true);
        vm.prank(founder);
        t.handOver(address(pair), false);
        pair.exec(address(t), abi.encodeCall(Treasury.takeSeat, ()), false);
        assertEq(t.runner(), address(pair));
    }

    // ---- announce

    function test_announceRecordsTheTaskAndMovesNoMoney() public {
        uint256 held = usd.balanceOf(address(t));
        uint64 serial = _announce(300, 2000e6, worker);
        assertEq(serial, 1);
        TaskBook.Task memory k = _book().taskOf(1);
        assertEq(k.what, WHAT);
        assertEq(k.payee, worker);
        assertEq(uint8(k.state), uint8(TaskBook.State.Announced));
        assertEq(k.shareBps, 300);
        assertEq(k.maxDollars, 2000e6);
        (uint256 notice, uint256 window, uint256 due) = t.noticeFor(300);
        assertEq(k.noticeEnd, T0 + notice);
        assertEq(k.expiresAt, T0 + notice + window);
        assertEq(notice, 2 * uint256(UNIT) + 3 * UNIT / 14, "14 days plus 12 hours per 1%: 3% waits 15.5 days");
        assertEq(window, UNIT);
        assertEq(due, 2 * uint256(UNIT));
        assertEq(t.nextExpiry(), k.expiresAt, "the Treasury knows when it next has to look");
        assertEq(t.pot(), 100_000e6, "nothing moved");
        assertEq(t.locked(), 0);
        assertEq(usd.balanceOf(address(t)), held);
        assertEq(_announce(100, 1000e6, address(0)), 2, "the next serial");
    }

    function test_announceIsTheRunnersAloneAndNotAnAgents() public {
        vm.prank(founder);
        t.authoriseAgent(agent);
        address[4] memory nobody = [alice, stranger, agent, worker];
        for (uint256 i; i < nobody.length; ++i) {
            vm.prank(nobody[i]);
            vm.expectRevert(Treasury.NotAllowed.selector);
            t.announceTask(WHAT, worker, 1000e6, 100);
        }
        _announce(100, 1000e6, worker);
    }

    function test_announceRefusesPayeesThatAreSignersOrPartsOfTheProject() public {
        address[6] memory parts_ =
            [address(t), address(usd), address(shares), address(team), address(vester), address(t.tasks())];
        for (uint256 i; i < parts_.length; ++i) {
            vm.prank(founder);
            vm.expectRevert(Treasury.BadInput.selector);
            t.announceTask(WHAT, parts_[i], 1000e6, 100);
        }
        vm.prank(founder);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.announceTask(WHAT, founder, 1000e6, 100); // the runner may not pay themself
        _announce(100, 1000e6, address(0)); // open is fine
        _announce(100, 1000e6, agent); // an agent may be a payee
    }

    function test_withAPairRunnerNeitherSignerMayBeThePayeeAndBothMustSign() public {
        MockPair pair = _pairRunner();
        (bool ok,) = pair.exec(address(t), abi.encodeCall(Treasury.announceTask, (WHAT, worker, 1000e6, 100)), false);
        assertFalse(ok, "one signer is not enough");
        address[3] memory seats = [founder, bob, address(pair)];
        for (uint256 i; i < seats.length; ++i) {
            (ok,) = pair.exec(address(t), abi.encodeCall(Treasury.announceTask, (WHAT, seats[i], 1000e6, 100)), true);
            assertFalse(ok, "a signer cannot be paid by a task");
        }
        (bool ok2, bytes memory ret) =
            pair.exec(address(t), abi.encodeCall(Treasury.announceTask, (WHAT, worker, 1000e6, 100)), true);
        assertTrue(ok2);
        assertEq(abi.decode(ret, (uint64)), 1);
    }

    function test_announceBubblesTheBooksOwnRefusals() public {
        vm.startPrank(founder);
        vm.expectRevert(TaskBook.BadInput.selector);
        t.announceTask(bytes32(0), worker, 1000e6, 100);
        vm.expectRevert(TaskBook.BadInput.selector);
        t.announceTask(WHAT, worker, 1000e6, 0);
        vm.expectRevert(TaskBook.ShareTooBig.selector);
        t.announceTask(WHAT, worker, 1000e6, 501);
        vm.expectRevert(TaskBook.BadInput.selector);
        t.announceTask(WHAT, worker, 1e6 - 1, 100);
        for (uint256 i; i < 8; ++i) {
            t.announceTask(WHAT, worker, 1000e6, 100);
        }
        vm.expectRevert(TaskBook.TooManyOpen.selector);
        t.announceTask(WHAT, worker, 1000e6, 100);
        vm.stopPrank();
    }

    function test_announceIsRefusedWhileQuietAndAfterAWindDown() public {
        vm.warp(T0 + 2 * uint256(UNIT) - 1);
        _announce(100, 1000e6, worker); // the last second of the window
        vm.warp(T0 + 2 * uint256(UNIT));
        vm.prank(founder);
        vm.expectRevert(Treasury.ProjectQuiet.selector);
        t.announceTask(WHAT, worker, 1000e6, 100);
        _checkIn();
        _announce(100, 1000e6, worker); // a check-in opens it again
        vm.prank(founder);
        t.windDown();
        vm.prank(founder);
        vm.expectRevert(Treasury.AlreadyWoundDown.selector);
        t.announceTask(WHAT, worker, 1000e6, 100);
    }

    function test_theNoticeFollowsTheTimeUnitOfTheProject() public {
        (TreasuryHarness small,,,) = _launch(IERC20(address(usd)), POOL, 0, 200, 168);
        (uint256 n1, uint256 w, uint256 d) = small.noticeFor(100);
        assertEq(n1, 336 + 12);
        assertEq(w, 168);
        assertEq(d, 336);
        (uint256 n5,,) = small.noticeFor(500);
        assertEq(n5, 336 + 60);
    }

    // ---- take

    function test_takeMovesTheSmallerOfTheDollarsAndTheShareFromThePotToTheTask() public {
        uint64 a = _announce(400, 3000e6, worker); // dollars: 3,000 binds, 4% of 100,000 is 4,000
        uint64 b = _announce(200, 50_000e6, worker); // share: 2% of the pot as it is when it is taken
        uint256 amount = _take(a, worker);
        assertEq(amount, 3000e6);
        assertEq(t.pot(), 97_000e6);
        assertEq(t.locked(), 3000e6);
        TaskBook.Task memory k = _book().taskOf(a);
        assertEq(uint8(k.state), uint8(TaskBook.State.Taken));
        assertEq(k.takenBy, worker);
        assertEq(k.takenAt, vm.getBlockTimestamp());
        assertEq(k.deadline, vm.getBlockTimestamp() + 2 * uint256(UNIT));
        assertEq(t.nextExpiry(), _book().taskOf(b).expiresAt, "the earliest end of any open task: b's take window");
        amount = _take(b, worker);
        assertEq(t.nextExpiry(), k.deadline, "a's deadline is now the earliest");
        assertEq(amount, 97_000e6 * 200 / 10_000, "the share is of the pot at the take, not the announce");
        _assertConserved();
    }

    function test_theAmountFollowsThePotNotTheAnnouncement() public {
        // design 2.3b3: a 4,000 task stated as 4% of 100,000; if 20% of the pot is gone by the take, 3,200 is set aside
        uint64 a = _announce(400, 4000e6, worker);
        _warpAlive(_noticeEnd(a));
        _force(80_000e6, 80_000e6, 0, 0, 0);
        vm.prank(worker);
        assertEq(t.takeTask(a, 0), 3200e6);
        assertEq(t.pot(), 76_800e6);
    }

    function test_takeWaitsForTheNoticeAndLapsesAfterOneUnit() public {
        uint64 a = _announce(100, 1000e6, worker);
        uint256 end = _noticeEnd(a);
        _warpAlive(end - 1);
        vm.prank(worker);
        vm.expectRevert(abi.encodeWithSelector(TaskBook.NoticeRunning.selector, end));
        t.takeTask(a, 0);
        vm.warp(end);
        uint256 id = vm.snapshotState();
        vm.prank(worker);
        t.takeTask(a, 0); // the first second works
        vm.revertToState(id);
        _checkIn();
        vm.warp(end + UNIT - 1);
        vm.prank(worker);
        t.takeTask(a, 0); // and the last second of the window
        vm.revertToState(id);
        _checkIn();
        vm.warp(end + UNIT); // the window is over: the task has lapsed and nothing moved
        vm.prank(worker);
        vm.expectRevert(TaskBook.WrongTaskState.selector);
        t.takeTask(a, 0);
        t.settle(); // (the refused call undid its own settle)
        assertEq(uint8(_book().taskOf(a).state), uint8(TaskBook.State.Lapsed));
        assertEq(t.pot(), 100_000e6);
    }

    function test_onlyTheNamedPayeeTakesAndAnOpenTaskGoesToTheFirstTaker() public {
        uint64 named = _announce(100, 1000e6, worker);
        uint64 open = _announce(100, 1000e6, address(0));
        _warpAlive(_noticeEnd(named));
        vm.prank(stranger);
        vm.expectRevert(TaskBook.NotAllowed.selector);
        t.takeTask(named, 0);
        vm.prank(stranger);
        t.takeTask(open, 0);
        assertEq(_book().taskOf(open).takenBy, stranger, "the first taker is the one who is paid");
        vm.prank(worker);
        vm.expectRevert(TaskBook.WrongTaskState.selector);
        t.takeTask(open, 0);
        vm.prank(worker);
        t.takeTask(named, 0);
        assertEq(_book().taskOf(named).takenBy, worker);
    }

    function test_theRunnerAndThePairSignersCannotTakeAnOpenTask() public {
        uint64 open = _announce(100, 1000e6, address(0));
        _warpAlive(_noticeEnd(open));
        vm.prank(founder);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.takeTask(open, 0);
        MockPair pair = _pairRunner();
        address[3] memory seats = [founder, bob, address(pair)];
        for (uint256 i; i < seats.length; ++i) {
            vm.prank(seats[i]);
            vm.expectRevert(Treasury.NotAllowed.selector);
            t.takeTask(open, 0);
        }
        vm.prank(alice);
        t.takeTask(open, 0);
    }

    function test_takeGuardsTheAmountAndTheSerial() public {
        uint64 a = _announce(100, 1000e6, worker);
        _warpAlive(_noticeEnd(a));
        vm.prank(worker);
        vm.expectRevert(abi.encodeWithSelector(TaskBook.TooLittleCash.selector, 1000e6 + 1, 1000e6));
        t.takeTask(a, 1000e6 + 1);
        vm.prank(worker);
        vm.expectRevert(TaskBook.NoSuchTask.selector);
        t.takeTask(2, 0);
        vm.prank(worker);
        vm.expectRevert(TaskBook.NoSuchTask.selector);
        t.takeTask(0, 0); // serial 0 is no task
        vm.prank(worker);
        t.takeTask(a, 1000e6);
    }

    function test_takeIsRefusedWhileQuietAndAfterAWindDown() public {
        uint64 a = _announce(100, 1000e6, worker);
        uint64 b = _announce(100, 1000e6, worker);
        uint256 end = _noticeEnd(a);
        vm.warp(end); // no check-in since the launch: the window closed after 14 days, the notice is 14.5
        vm.prank(worker);
        vm.expectRevert(Treasury.ProjectQuiet.selector);
        t.takeTask(a, 0);
        _checkIn();
        vm.prank(founder);
        t.windDown();
        vm.prank(worker);
        vm.expectRevert(Treasury.AlreadyWoundDown.selector);
        t.takeTask(b, 0);
    }

    function test_takeOfWhatTheProjectCannotFundIsRefused() public {
        uint64 a = _announce(100, 1000e6, worker);
        _warpAlive(_noticeEnd(a));
        _force(0, 0, 0, 0, 0);
        vm.prank(worker);
        vm.expectRevert(abi.encodeWithSelector(TaskBook.TooLittleCash.selector, 0, 0));
        t.takeTask(a, 0);
    }

    function test_takeEmitsTheMoneyItMoved() public {
        uint64 a = _announce(100, 1000e6, worker);
        _warpAlive(_noticeEnd(a));
        vm.expectEmit(true, false, false, true, address(t));
        emit Treasury.TaskMoney(1, a, worker, 1000e6, 99_000e6, 1000e6, 0);
        vm.prank(worker);
        t.takeTask(a, 0);
    }

    // ---- accept

    function test_acceptInFullPaysTheTakerAndOnlyTheTaker() public {
        uint64 a = _announce(300, 2000e6, worker);
        _take(a, worker);
        vm.expectEmit(true, false, false, true, address(t));
        emit Treasury.TaskMoney(2, a, worker, 2000e6, 98_000e6, 0, 0);
        _accept(a, 2000e6);
        assertEq(usd.balanceOf(worker), 2000e6);
        assertEq(t.pot(), 98_000e6, "the pot is what it was after the take");
        assertEq(t.locked(), 0);
        assertEq(t.notesOwed(), 0);
        assertEq(uint8(_book().taskOf(a).state), uint8(TaskBook.State.Paid));
        assertEq(t.nextExpiry(), 0);
        assertEq(_book().openCount(), 0);
        _assertConserved();
    }

    function test_aPartPaymentBringsTheRestBackToThePot() public {
        uint64 a = _announce(300, 2000e6, worker);
        _take(a, worker);
        _accept(a, 500e6);
        assertEq(usd.balanceOf(worker), 500e6);
        assertEq(t.pot(), 98_000e6 + 1500e6, "no notes: all that is left goes to the stayers");
        assertEq(t.locked(), 0);
        assertEq(t.notesOwed(), 0);
        assertEq(_book().taskOf(a).returned, 1500e6);
        _assertConserved();
    }

    function test_aPartPaymentSplitsWhatIsLeftAtOneRatioToStayersAndNotes() public {
        // the plan's worked case: 5% of 100,000 set aside, a holder's note of 2,000 against it, 3,000 paid
        uint64 a = _announce(500, 5000e6, worker);
        _take(a, worker);
        _book().forceNote(a, carol, 2000e6);
        t.forceNote(2000e6);
        assertEq(t.locked(), 3000e6);
        assertEq(t.notesOwed(), 2000e6);
        _accept(a, 3000e6);
        assertEq(usd.balanceOf(worker), 3000e6);
        assertEq(t.pot(), 95_000e6 + 1200e6, "the stayers' share of the 2,000 left: 3,000 / 5,000");
        assertEq(t.locked(), 0);
        assertEq(t.notesOwed(), 800e6, "the notes' share: 2,000 / 5,000 of what is left, still held");
        _assertConserved();
        assertEq(usd.balanceOf(address(t)), t.pot() + t.notesOwed() + t.box() + t.arriving() + t.feesOwed());
    }

    function test_aFullPaymentVoidsTheNotesAndTheirMoneyGoesToTheWorker() public {
        uint64 a = _announce(500, 5000e6, worker);
        _take(a, worker);
        _book().forceNote(a, carol, 2000e6);
        t.forceNote(2000e6);
        _accept(a, 5000e6);
        assertEq(usd.balanceOf(worker), 5000e6);
        assertEq(t.notesOwed(), 0, "the notes' money was the worker's");
        assertEq(t.locked(), 0);
        assertEq(t.pot(), 95_000e6);
        assertEq(_book().taskOf(a).returned, 0);
    }

    function test_acceptRefusesNothingTooMuchAndWhatIsNotTaken() public {
        uint64 a = _announce(300, 2000e6, worker);
        vm.prank(founder);
        vm.expectRevert(TaskBook.WrongTaskState.selector);
        t.acceptTask(a, 1); // not taken yet
        vm.prank(founder);
        vm.expectRevert(TaskBook.NoSuchTask.selector);
        t.acceptTask(99, 1);
        _take(a, worker);
        vm.startPrank(founder);
        vm.expectRevert(TaskBook.BadInput.selector);
        t.acceptTask(a, 0);
        vm.expectRevert(abi.encodeWithSelector(TaskBook.TooMuch.selector, 2000e6 + 1, 2000e6));
        t.acceptTask(a, 2000e6 + 1);
        vm.stopPrank();
    }

    function test_acceptIsTheRunnersAloneNeverThePayeeOrAnAgent() public {
        vm.prank(founder);
        t.authoriseAgent(agent);
        uint64 a = _announce(300, 2000e6, worker);
        _take(a, worker);
        address[4] memory nobody = [worker, agent, alice, stranger];
        for (uint256 i; i < nobody.length; ++i) {
            vm.prank(nobody[i]);
            vm.expectRevert(Treasury.NotAllowed.selector);
            t.acceptTask(a, 2000e6);
        }
        assertEq(t.locked(), 2000e6);
    }

    function test_withAPairRunnerAcceptNeedsBothSigners() public {
        MockPair pair = _pairRunner();
        (bool ok, bytes memory ret) =
            pair.exec(address(t), abi.encodeCall(Treasury.announceTask, (WHAT, worker, 1000e6, 100)), true);
        assertTrue(ok);
        uint64 a = abi.decode(ret, (uint64));
        _warpAlive(_noticeEnd(a));
        vm.prank(worker);
        t.takeTask(a, 0);
        (ok,) = pair.exec(address(t), abi.encodeCall(Treasury.acceptTask, (a, 1000e6)), false);
        assertFalse(ok, "one signer cannot pay");
        (ok,) = pair.exec(address(t), abi.encodeCall(Treasury.rejectTask, (a)), false);
        assertFalse(ok);
        (ok,) = pair.exec(address(t), abi.encodeCall(Treasury.acceptTask, (a, 1000e6)), true);
        assertTrue(ok);
        assertEq(usd.balanceOf(worker), 1000e6);
    }

    function test_theTakerThatBecameTheRunnerIsNotPaidByThemselves() public {
        // a stranger takes an open task, then is handed the seat: the seat may have changed hands since the take
        uint64 a = _announce(100, 1000e6, address(0));
        _take(a, bob);
        vm.prank(founder);
        t.handOver(bob, false);
        vm.prank(bob);
        t.takeSeat();
        vm.prank(bob);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.acceptTask(a, 1000e6);
        vm.prank(bob);
        t.rejectTask(a); // sending the money back is always allowed
        assertEq(t.locked(), 0);
        assertEq(usd.balanceOf(bob), 0);
    }

    function test_theTakerIsPaidNotWhoeverTheRunnerLikes() public {
        // payment goes to `takenBy` only: there is no `to` argument, and an open task pays whoever took it
        uint64 a = _announce(100, 1000e6, address(0));
        _take(a, stranger);
        _accept(a, 400e6);
        assertEq(usd.balanceOf(stranger), 400e6);
        assertEq(usd.balanceOf(worker), 0);
        assertEq(usd.balanceOf(founder), 0);
    }

    function test_aTaskIsNotAcceptedAfterItsDeadline() public {
        uint64 a = _announce(100, 1000e6, worker);
        _take(a, worker);
        uint256 dl = _book().taskOf(a).deadline;
        vm.warp(dl - 1);
        _checkIn(); // keep the window open
        uint256 id = vm.snapshotState();
        _accept(a, 1000e6); // the last second works
        vm.revertToState(id);
        vm.warp(dl);
        vm.prank(founder);
        vm.expectRevert(TaskBook.WrongTaskState.selector);
        t.acceptTask(a, 1000e6); // the settle that opens the call has already returned the money
        t.settle(); // (the refused call undid its own settle)
        assertEq(t.locked(), 0, "returned");
        assertEq(t.pot(), 100_000e6);
    }

    // ---- reject, cancel, return

    function test_rejectSendsTheMoneyBackAtOnce() public {
        uint64 a = _announce(300, 2000e6, worker);
        _take(a, worker);
        vm.expectEmit(true, false, false, true, address(t));
        emit Treasury.TaskMoney(3, a, worker, 2000e6, 100_000e6, 0, 0);
        vm.prank(founder);
        t.rejectTask(a);
        assertEq(t.pot(), 100_000e6);
        assertEq(t.locked(), 0);
        assertEq(uint8(_book().taskOf(a).state), uint8(TaskBook.State.Rejected));
        assertEq(t.nextExpiry(), 0);
        vm.prank(founder);
        vm.expectRevert(TaskBook.WrongTaskState.selector);
        t.rejectTask(a);
        vm.prank(stranger);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.rejectTask(a);
    }

    function test_rejectKeepsTheNotesWhole() public {
        uint64 a = _announce(500, 5000e6, worker);
        _take(a, worker);
        _book().forceNote(a, carol, 2000e6);
        t.forceNote(2000e6);
        vm.prank(founder);
        t.rejectTask(a);
        assertEq(t.pot(), 95_000e6 + 3000e6);
        assertEq(t.notesOwed(), 2000e6, "every note keeps its full face");
        assertEq(t.locked(), 0);
    }

    function test_cancelWithdrawsATaskNobodyTookAndFreesItsSlot() public {
        for (uint256 i; i < 8; ++i) {
            _announce(100, 1000e6, worker);
        }
        vm.prank(founder);
        vm.expectRevert(TaskBook.TooManyOpen.selector);
        t.announceTask(WHAT, worker, 1000e6, 100);
        vm.prank(founder);
        t.cancelTask(4);
        assertEq(uint8(_book().taskOf(4).state), uint8(TaskBook.State.Cancelled));
        assertEq(_announce(100, 1000e6, worker), 9);
        vm.prank(stranger);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.cancelTask(1);
        vm.prank(founder);
        vm.expectRevert(TaskBook.WrongTaskState.selector);
        t.cancelTask(4);
        // not after the take
        uint64 b = 1;
        _take(b, worker);
        vm.prank(founder);
        vm.expectRevert(TaskBook.WrongTaskState.selector);
        t.cancelTask(b);
        assertEq(t.pot(), 99_000e6);
    }

    function test_cancelUpdatesWhenTheTreasuryNextLooks() public {
        uint64 a = _announce(100, 1000e6, worker);
        uint64 b = _announce(500, 1000e6, worker);
        assertEq(t.nextExpiry(), _book().taskOf(a).expiresAt);
        vm.prank(founder);
        t.cancelTask(a);
        assertEq(t.nextExpiry(), _book().taskOf(b).expiresAt);
        vm.prank(founder);
        t.cancelTask(b);
        assertEq(t.nextExpiry(), 0);
    }

    function test_returnTaskIsForATaskThatRanOutAndSaysWhenNot() public {
        uint64 a = _announce(100, 1000e6, worker);
        vm.expectRevert(abi.encodeWithSelector(TaskBook.NotYet.selector, _book().taskOf(a).expiresAt));
        t.returnTask(a);
        _take(a, worker);
        uint256 dl = _book().taskOf(a).deadline;
        vm.expectRevert(abi.encodeWithSelector(TaskBook.NotYet.selector, dl));
        t.returnTask(a);
        vm.warp(dl - 1);
        vm.expectRevert(abi.encodeWithSelector(TaskBook.NotYet.selector, dl));
        t.returnTask(a);
        vm.warp(dl);
        vm.prank(stranger); // anyone
        t.returnTask(a);
        assertEq(t.pot(), 100_000e6);
        assertEq(t.locked(), 0);
        assertEq(uint8(_book().taskOf(a).state), uint8(TaskBook.State.Returned));
        t.returnTask(a); // again: still returned
        vm.expectRevert(TaskBook.NoSuchTask.selector);
        t.returnTask(7);
        _checkIn();
        uint64 b = _announce(100, 1000e6, worker);
        _take(b, worker);
        _accept(b, 1000e6);
        vm.expectRevert(TaskBook.WrongTaskState.selector);
        t.returnTask(b); // paid in full: nothing came back
    }

    // ---- quiet, wind-down, hand-over

    function test_whileQuietWhatIsAlreadyMovingCanStillBeHandledButNothingNewStarts() public {
        uint64 a = _announce(100, 1000e6, worker);
        uint64 b = _announce(100, 1000e6, worker);
        uint64 c = _announce(100, 1000e6, worker);
        _take(a, worker);
        uint64 d = _announce(100, 1000e6, worker);
        vm.warp(vm.getBlockTimestamp() + 2 * uint256(UNIT)); // the check-in window closed; a's deadline is this very second
        // new money cannot start
        vm.prank(founder);
        vm.expectRevert(Treasury.ProjectQuiet.selector);
        t.announceTask(WHAT, worker, 1000e6, 100);
        // what is still announced can be withdrawn
        vm.prank(founder);
        t.cancelTask(d);
        assertEq(uint8(_book().taskOf(d).state), uint8(TaskBook.State.Cancelled));
        // a, taken, ran out (its deadline passed in the quiet): its money is back
        vm.prank(stranger);
        t.returnTask(a);
        assertEq(t.pot(), 100_000e6);
        // b and c lapsed: their take windows are long over
        t.returnTask(b);
        t.returnTask(c);
        assertEq(uint8(_book().taskOf(b).state), uint8(TaskBook.State.Lapsed));
        assertEq(uint8(_book().taskOf(c).state), uint8(TaskBook.State.Lapsed));
    }

    function test_aTakenTaskCanBeAcceptedWhileTheWindowIsClosed() public {
        uint64 a = _announce(100, 1000e6, worker);
        _take(a, worker);
        // quiet falls before the deadline: the window closes 14 days after the last check-in, the deadline is 14 days after the take
        uint256 dl = _book().taskOf(a).deadline;
        vm.warp(dl - 1);
        assertGe(vm.getBlockTimestamp(), t.activeEnd(), "no check-in for a while");
        _accept(a, 1000e6);
        assertEq(usd.balanceOf(worker), 1000e6);
    }

    function test_aWindDownByChoiceEndsEveryOpenTask() public {
        uint64 a = _announce(100, 1000e6, worker); // will be taken
        uint64 b = _announce(100, 1000e6, worker); // never taken
        _take(a, worker);
        assertEq(t.locked(), 1000e6);
        vm.expectEmit(true, false, false, true, address(t));
        emit Treasury.TaskMoney(4, 0, address(0), 1000e6, 100_000e6, 0, 0);
        vm.prank(founder);
        t.windDown();
        assertEq(t.pot(), 100_000e6);
        assertEq(t.locked(), 0);
        assertEq(t.nextExpiry(), 0);
        assertEq(uint8(_book().taskOf(a).state), uint8(TaskBook.State.Returned));
        assertEq(uint8(_book().taskOf(b).state), uint8(TaskBook.State.Cancelled));
        assertEq(_book().openCount(), 0);
        // nothing new, and nothing left to handle
        vm.startPrank(founder);
        vm.expectRevert(Treasury.AlreadyWoundDown.selector);
        t.announceTask(WHAT, worker, 1000e6, 100);
        vm.expectRevert(TaskBook.WrongTaskState.selector);
        t.acceptTask(a, 1);
        vm.expectRevert(TaskBook.WrongTaskState.selector);
        t.rejectTask(a);
        vm.expectRevert(TaskBook.WrongTaskState.selector);
        t.cancelTask(b);
        vm.stopPrank();
        vm.prank(worker);
        vm.expectRevert(Treasury.AlreadyWoundDown.selector);
        t.takeTask(b, 0);
        t.returnTask(a); // and the named call still answers
        _assertConserved();
    }

    function test_aWindDownAfterTwentySixQuietUnitsByAnyoneLeavesNothingSetAside() public {
        // a take needs an open check-in window and is due two units later, so by 26 quiet units every task has run out:
        // the settle inside the wind-down returns it, and the sweep that follows must not return it twice
        uint64 a = _announce(100, 1000e6, worker);
        _take(a, worker);
        uint256 quietAt = t.lastCheckIn() + 26 * uint256(UNIT);
        vm.warp(quietAt);
        vm.prank(stranger);
        t.windDown();
        assertEq(t.pot(), 100_000e6, "the money is back in the pot, once");
        assertEq(t.locked(), 0);
        assertEq(uint8(_book().taskOf(a).state), uint8(TaskBook.State.Returned));
        assertEq(t.windDownKind(), 2);
        _assertConserved();
    }

    function test_tasksAreNotTiedToTheRunnerWhoAnnouncedThem() public {
        uint64 a = _announce(100, 1000e6, worker);
        vm.prank(founder);
        t.handOver(carol, false);
        vm.prank(carol);
        t.takeSeat();
        _take(a, worker);
        vm.prank(carol);
        t.acceptTask(a, 1000e6); // the new runner pays it
        assertEq(usd.balanceOf(worker), 1000e6);
        vm.prank(founder);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.announceTask(WHAT, worker, 1000e6, 100); // the old runner no longer announces
    }

    // ---- what a joiner sees

    function test_aJoinerDuringALockPaysTheSamePriceAsBeforeAndSeesTheLockedLine() public {
        (uint256 sharesBefore, uint256 outBefore,,) = t.quoteBack(10_000e6);
        uint64 a = _announce(500, 5000e6, worker);
        _take(a, worker);
        (uint256 sharesLocked, uint256 outLocked, uint256 lockedLine,) = t.quoteBack(10_000e6);
        assertEq(sharesLocked, sharesBefore, "set-aside money counts at face in the price");
        assertEq(lockedLine, 5000e6);
        assertLt(outLocked, outBefore, "but it is not cash a leaver can reach: what taking out at once gives is lower");
        vm.warp(_book().taskOf(a).deadline);
        (uint256 sharesAfter, uint256 outAfter, uint256 lockedAfter,) = t.quoteBack(10_000e6);
        assertEq(sharesAfter, sharesBefore, "back in the pot: the same price");
        assertEq(outAfter, outBefore);
        assertEq(lockedAfter, 0, "and the quote sees the return before anyone has settled");
    }

    function test_aRealJoinDuringALockGetsTheQuotedShares() public {
        uint64 a = _announce(500, 5000e6, worker);
        _take(a, worker);
        (uint256 quoted,,,) = t.quoteBack(10_000e6);
        uint256 n = _join(carol, 10_000e6);
        assertEq(n, quoted);
        _assertConserved();
    }

    function test_theJoinersPriceAndCreditCountTheSameMoney() public {
        // a lock must not change what a joiner pays or is credited: the same join, with and without 5% set aside
        uint256 id = vm.snapshotState();
        uint256 plain = _join(carol, 10_000e6);
        uint256 paidInPlain = t.paidIn();
        vm.revertToState(id);
        uint64 a = _announce(500, 5000e6, worker);
        _take(a, worker);
        uint256 withLock = _join(carol, 10_000e6);
        assertEq(withLock, plain);
        assertEq(t.paidIn(), paidInPlain, "the credit counts the money set aside too");
    }

    function test_withASurplusAboveWhatBackersPaidInTheCreditCountsTheSetAsideMoneyToo() public {
        // 20,000 above paid-in, shared with the Team Shares: the slice a joiner pays for it is part of the credit, and it must be
        // worked out on the very money that priced the join, the money set aside included
        _force(100_000e6, 80_000e6, 0, 0, 0);
        uint256 id = vm.snapshotState();
        uint256 plain = _join(carol, 10_000e6);
        uint256 paidInPlain = t.paidIn();
        vm.revertToState(id);
        uint64 a = _announce(500, 5000e6);
        _take(a, worker);
        assertEq(t.pot(), 95_000e6);
        uint256 withLock = _join(carol, 10_000e6);
        assertEq(withLock, plain, "the price counts the money set aside");
        assertEq(t.paidIn(), paidInPlain, "so does the credit");
    }

    function test_withNoBackersAtAllTheFirstJoinersCreditStillCountsTheSetAsideMoney() public {
        // only the Team pool owns the project, and the money in it is outside payments: without backers there is no cap on the
        // credit but the slice of the surplus the joiner pays for, which must be worked out on the money set aside too
        _relaunch(POOL, 0);
        _revenue(carol, 100_000e6);
        uint64 a = _announce(500, 5000e6);
        _warpAlive(_noticeEnd(a));
        assertEq(t.pot(), 100_000e6, "all of it has arrived");
        uint256 id = vm.snapshotState();
        uint256 plain = _join(alice, 10_000e6);
        uint256 paidInPlain = t.paidIn();
        vm.revertToState(id);
        _take(a, worker);
        assertEq(t.pot(), 95_000e6);
        uint256 withLock = _join(alice, 10_000e6);
        assertEq(withLock, plain, "the price counts the money set aside");
        assertEq(t.paidIn(), paidInPlain, "and so does the credit");
    }

    function test_aLeaverIsPaidOnThePotWithoutTheSetAsideMoney() public {
        uint64 a = _announce(500, 5000e6, worker);
        _take(a, worker);
        uint256 n = shares.balanceOf(bob);
        (uint256 quoted,,) = t.quoteTakeOut(bob, n);
        uint256 cash = _leave(bob, n);
        assertEq(cash, quoted);
        // 40% of the shares, 95,000 in the pot (the note for the 5,000 is bound in Notes.t.sol)
        assertApproxEqAbs(cash, 38_000e6, 1e6);
        _assertConserved();
    }

    // ---- a payee that is a hooked contract

    function test_theWorkerIsPaidAfterEveryBucketIsFinal() public {
        Recorder rec = new Recorder(t);
        uint64 a = _announce(300, 2000e6, address(rec));
        _take(a, address(rec));
        usd.setHooked(address(rec), true);
        _accept(a, 500e6);
        assertTrue(rec.fired(), "the dollar called the payee back");
        assertEq(rec.potSeen(), 98_000e6 + 1500e6, "the pot already held the rest when the payee was paid");
        assertEq(rec.lockedSeen(), 0);
        assertEq(rec.nextExpirySeen(), 0);
        assertEq(uint8(rec.stateSeen()), uint8(TaskBook.State.Paid));
    }

    function test_thePayeeCannotReenterWhileItIsBeingPaid() public {
        uint64 a = _announce(300, 2000e6, worker);
        uint64 b = _announce(300, 2000e6, worker);
        _take(a, worker);
        vm.prank(founder);
        t.cancelTask(b);
        bytes[4] memory calls = [
            abi.encodeCall(Treasury.settle, ()),
            abi.encodeCall(Treasury.takeTask, (b, 0)),
            abi.encodeCall(Treasury.returnTask, (a)),
            abi.encodeCall(Treasury.leave, (1, 0, worker))
        ];
        for (uint256 i; i < calls.length; ++i) {
            uint256 id = vm.snapshotState();
            usd.armCallback(worker, address(t), calls[i]);
            _accept(a, 1000e6);
            assertTrue(usd.callbackFired(), "the dollar called back");
            assertFalse(usd.callbackOk(), string.concat("the Treasury refused re-entry #", vm.toString(i)));
            assertEq(bytes4(usd.callbackRet()), Treasury.Reentrancy.selector, "and for that reason");
            vm.revertToState(id);
        }
    }
}

/// @notice A payee that looks at the Treasury while it is being paid.
contract Recorder {
    Treasury internal t;
    bool public fired;
    uint256 public potSeen;
    uint256 public lockedSeen;
    uint64 public nextExpirySeen;
    TaskBook.State public stateSeen;

    constructor(Treasury t_) {
        t = t_;
    }

    function onQuoteTransfer(address, address, uint256, bool after_) external {
        if (!after_ || fired) return;
        fired = true;
        (potSeen, lockedSeen, nextExpirySeen) = (t.pot(), t.locked(), t.nextExpiry());
        stateSeen = TaskBook(address(t.tasks())).taskOf(1).state;
    }
}
