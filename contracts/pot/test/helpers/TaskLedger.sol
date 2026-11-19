// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {StackBase} from "./StackBase.sol";
import {TaskBook} from "../../src/TaskBook.sol";

/// @notice The task side of the ledger a server rebuilds from logs alone: it reads only the events of the project's TaskBook
/// and the `TaskMoney` events of the Treasury, in order, and holds, per serial, the state, the money set aside (L), the
/// stayers' claim (C), the face of the notes (N), what came back and what is held for the notes; every holder's note per
/// serial; the open count, the next serial and the takes of the rolling 28 days; and the two buckets the Treasury keeps for
/// tasks (the money set aside and the money held for notes). `_sameTasks` compares all of it with the contracts.
abstract contract TaskLedger is StackBase {
    /// @dev What the ledger holds of one task.
    struct LTask {
        uint8 state;
        uint256 setAside; // L
        uint256 stayer; // C
        uint256 noteFace; // N
        uint256 returned;
        uint256 held; // what is held for its notes
    }

    uint256 internal lLocked;
    uint256 internal lNotesOwed;
    uint256 internal lOpen;
    uint256 internal lNext = 1;
    uint256 internal bookEvents;
    mapping(uint256 => LTask) internal lTask;
    mapping(uint256 => mapping(address => uint256)) internal lNote;
    uint256[] internal takeAt;
    uint256[] internal takeBps;
    mapping(uint256 => uint256) internal takeOfSerial; // 1 + the place of the serial's take in the two lists

    function _word(bytes memory d, uint256 i) internal pure returns (uint256 r) {
        assembly {
            r := mload(add(d, add(32, mul(32, i))))
        }
    }

    /// @dev `TaskMoney(kind, serial, who, amount, potAfter, lockedAfter, notesOwedAfter)`: the two buckets after the move.
    function _applyTaskMoney(bytes memory d) internal {
        (lLocked, lNotesOwed) = (_word(d, 4), _word(d, 5));
    }

    /// @dev One event of the TaskBook, in the order of the logs.
    function _applyBook(Vm.Log memory l) internal {
        bytes32 sig = l.topics[0];
        bytes memory d = l.data;
        uint256 serial = uint256(l.topics[1]);
        LTask storage k = lTask[serial];
        if (sig == TaskBook.TaskAnnounced.selector) {
            k.state = uint8(TaskBook.State.Announced);
            (lOpen, lNext) = (_word(d, 7), serial + 1);
        } else if (sig == TaskBook.TaskTaken.selector) {
            k.state = uint8(TaskBook.State.Taken);
            (k.setAside, k.stayer, k.noteFace) = (_word(d, 1), _word(d, 1), 0);
            takeBps.push(_word(d, 2));
            takeAt.push(_word(d, 3));
            takeOfSerial[serial] = takeBps.length;
            lOpen = _word(d, 6);
        } else if (sig == TaskBook.TaskResolved.selector) {
            // the stayers' claim ends with the task; the notes keep what was held for them
            (k.state, k.stayer, k.returned, k.held, k.noteFace) =
                (uint8(_word(d, 0)), 0, _word(d, 2), _word(d, 3), _word(d, 5));
            lOpen = _word(d, 6);
            // a task that ended with nothing paid gives its take back to the 28-day cap
            if (_word(d, 7) != 0) takeBps[takeOfSerial[serial] - 1] -= _word(d, 7);
        } else if (sig == TaskBook.NoteMinted.selector) {
            address holder = address(uint160(uint256(l.topics[2])));
            lNote[serial][holder] += _word(d, 0);
            (k.stayer, k.noteFace) = (_word(d, 1), _word(d, 2));
        } else if (sig == TaskBook.NoteClaimed.selector) {
            address holder = address(uint160(uint256(l.topics[2])));
            lNote[serial][holder] = 0;
            (k.noteFace, k.held) = (_word(d, 2), _word(d, 3));
        } else {
            return;
        }
        ++bookEvents;
    }

    /// @dev The ledger against the contracts: the two buckets, every task, the open count, the next serial, the 28-day sum of
    /// takes, and the notes of every holder against the serials in `noteSerials`.
    function _sameTasks(string memory step, address[] memory holders, uint64[] memory noteSerials) internal view {
        assertEq(lLocked, t.locked(), string.concat(step, ": money set aside"));
        assertEq(lNotesOwed, t.notesOwed(), string.concat(step, ": notes owed"));
        TaskBook b = _book();
        assertEq(lOpen, b.openCount(), string.concat(step, ": open tasks"));
        assertEq(lNext, b.nextSerial(), string.concat(step, ": next serial"));
        uint256 window;
        for (uint256 i; i < takeAt.length; ++i) {
            if (takeAt[i] + 4 * uint256(UNIT) > vm.getBlockTimestamp()) window += takeBps[i];
        }
        assertEq(window, b.windowSumBps(), string.concat(step, ": the 28-day sum of takes"));
        for (uint256 sr = 1; sr < lNext; ++sr) {
            TaskBook.Task memory k = b.taskOf(uint64(sr));
            LTask storage lk = lTask[sr];
            assertEq(lk.state, uint8(k.state), string.concat(step, ": state of task ", vm.toString(sr)));
            assertEq(lk.setAside, k.locked, string.concat(step, ": money of task ", vm.toString(sr)));
            assertEq(lk.stayer, k.stayer, string.concat(step, ": stayers' claim of task ", vm.toString(sr)));
            assertEq(lk.noteFace, k.noteFace, string.concat(step, ": note face of task ", vm.toString(sr)));
            assertEq(lk.returned, k.returned, string.concat(step, ": returned by task ", vm.toString(sr)));
            assertEq(lk.held, k.notesLeft, string.concat(step, ": held for notes of task ", vm.toString(sr)));
        }
        for (uint256 i; i < noteSerials.length; ++i) {
            for (uint256 j; j < holders.length; ++j) {
                assertEq(lNote[noteSerials[i]][holders[j]], b.noteOf(noteSerials[i], holders[j]), "a holder's note");
            }
        }
    }
}
