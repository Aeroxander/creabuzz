// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Math} from "oz5/utils/math/Math.sol";
import {ITaskBook} from "./Interfaces.sol";

/// @title TaskBook
/// @notice One project's task queue (JOIN-LEAVE-DESIGN.md, 2.3b and 2.3c): a task is announced, waits out its notice, is taken
/// (only then does money move), and is paid in full, paid in part, rejected, or runs out of time. The book keeps the rules of
/// the queue and the numbers of every task; it holds no dollars. The Treasury is its only caller: it settles first, checks who
/// is asking, moves the dollars between its buckets by what the book returns, and pays the worker.
///
/// The rules, all in calendar seconds (N is the time unit):
///  - the notice is 2N plus N/14 per 1% of the pot the task asks for (per ten-thousandth N/1400, rounded up), and depends only
///    on the stated share;
///  - a task can be taken from the end of its notice for N more seconds, then it lapses and nothing has moved;
///  - a taken task is due 2N after the take; at that second it is returned to the pot;
///  - at most 5% of the pot per task, 10% of the pot taken in any 28 days (4N, an exact ring of the last 16 takes), at most 8
///    open tasks, and a serial number that is never reused (it starts at 1, so 0 means "no task").
///
/// While a task is taken its money `L` is split in two claims, `L == stayer + noteFace`: the stayers' claim (`stayer`) and the
/// face of the exit notes leavers hold against it (`noteFace`). A task ends by splitting what is not paid to the worker at one
/// ratio, `returned / L`, between stayers and notes, so a note can never be paid more than its share of its own task's money.
/// @dev One clone per project, made and set up by the Launcher before the Treasury. No owner, no upgrade. The implementation
/// locks itself in its constructor.
contract TaskBook is ITaskBook {
    /// @notice Where a task is.
    enum State {
        None,
        Announced,
        Taken,
        Paid,
        Rejected,
        Returned,
        Cancelled,
        Lapsed
    }

    /// @notice One task. Dollar amounts are in units of 1e-6; times are seconds.
    struct Task {
        bytes32 what; // the hash tied to the signed task record
        address payee; // zero when open to anyone
        State state;
        uint16 shareBps; // the stated share of the pot, in ten-thousandths (1 to 500)
        address takenBy; // who took it, and the only address a payment goes to
        uint64 announcedAt;
        uint64 noticeEnd; // the first second it can be taken
        uint64 expiresAt; // the end of the take window while announced, the deadline once taken
        uint64 takenAt;
        uint64 deadline; // 2N after the take (zero until taken)
        uint128 maxDollars; // the most it may set aside
        uint128 locked; // L: what was set aside at the take
        uint128 stayer; // C: the stayers' claim while taken
        uint128 noteFace; // N: the face of the notes against it (kept after the end, for the claims)
        uint128 returned; // what came back when it ended: L less what the worker was paid
        uint128 notesLeft; // what is still held for claims of its notes
    }

    /// @notice The most open tasks (announced or taken) at once.
    uint256 public constant MAX_OPEN = 8;
    /// @notice The most one task may ask for: 5% of the pot, in ten-thousandths.
    uint256 public constant MAX_SHARE_BPS = 500;
    /// @notice The most taken in any 28 days: 10% of the pot, in ten-thousandths, counted at each take.
    uint256 public constant CAP_BPS = 1000;
    /// @notice The smallest task: 1 dollar.
    uint256 public constant MIN_TASK = 1e6;
    /// @notice The takes the cap remembers (see `take` for why 16 is enough).
    uint256 public constant RING = 16;
    uint256 private constant BPS = 1e4;

    /// @notice The Treasury, the only caller of every state-changing function.
    address public treasury;
    /// @notice The time unit N in seconds.
    uint32 public unit;
    /// @notice The serial the next task gets. Starts at 1, only rises.
    uint64 public nextSerial;
    /// @notice Open tasks (announced or taken).
    uint8 public openCount;
    uint8 internal _takeIdx;
    uint64[8] internal _open;
    /// @dev The last 16 takes, `time << 16 | bps`, three to a slot.
    uint80[16] internal _takes;
    mapping(uint64 => Task) internal _task;
    /// @notice What a leaver holds against a task (the face of its exit note); a leave writes it, a claim clears it.
    mapping(uint64 => mapping(address => uint256)) public noteOf;

    /// @notice A task was announced. `openAfter` counts the open tasks after it.
    event TaskAnnounced(
        uint64 indexed serial,
        bytes32 what,
        address payee,
        uint256 maxDollars,
        uint16 shareBps,
        uint64 announcedAt,
        uint64 noticeEnd,
        uint64 expiresAt,
        uint8 openAfter
    );
    /// @notice A task was taken: `amount` dollars were set aside, counted as `takeBps` ten-thousandths of the pot in the
    /// 28-day cap, which now stands at `windowSumBpsAfter`.
    event TaskTaken(
        uint64 indexed serial,
        address takenBy,
        uint256 amount,
        uint256 takeBps,
        uint64 takenAt,
        uint64 deadline,
        uint256 windowSumBpsAfter,
        uint8 openAfter
    );
    /// @notice A task ended in `state` (Paid, Rejected, Returned, Cancelled or Lapsed). `pay` went to the worker, `returned`
    /// came back, of which `notesPool` stays owed to notes and `potPart` went to the pot; `noteFaceAfter` is the face of the
    /// notes left against it.
    event TaskResolved(
        uint64 indexed serial,
        uint8 state,
        uint256 pay,
        uint256 returned,
        uint256 notesPool,
        uint256 potPart,
        uint256 noteFaceAfter,
        uint8 openAfter
    );
    /// @notice A leaver was given a note: `part` dollars of the stayers' claim on task `serial` became the holder's note. The
    /// task now stands at `stayerAfter` (stayers) and `noteFaceAfter` (all notes).
    event NoteMinted(
        uint64 indexed serial, address indexed holder, uint256 part, uint256 stayerAfter, uint256 noteFaceAfter
    );
    /// @notice A note was settled: `paid` went to the holder; `dustToPot` is the rounding left when it was the last note against
    /// the task, which goes to the pot. The task now holds `notesLeftAfter` for the notes still to be claimed.
    event NoteClaimed(
        uint64 indexed serial,
        address indexed holder,
        uint256 paid,
        uint256 dustToPot,
        uint256 noteFaceAfter,
        uint256 notesLeftAfter
    );

    /// @notice A state-changing call from anyone but the Treasury, or a payee who is not the caller.
    error NotAllowed();
    /// @notice Set up twice or on the implementation.
    error BadSetup();
    /// @notice A task needs a what-hash, a share of 1 to 500 ten-thousandths and at least 1 dollar.
    error BadInput();
    /// @notice A task may ask for at most 5% of the pot.
    error ShareTooBig();
    /// @notice Eight tasks are open.
    error TooManyOpen();
    /// @notice No task has that serial.
    error NoSuchTask();
    /// @notice The task is not in the state this call needs.
    error WrongTaskState();
    /// @notice The notice is still running; the task can be taken from `readyAt`.
    error NoticeRunning(uint256 readyAt);
    /// @notice The take window is over.
    error TakeWindowOver();
    /// @notice Taking this much would pass the cap of 10% of the pot in 28 days: `used` is already counted, `add` is this
    /// take, `cap` the limit (all in ten-thousandths of the pot).
    error CapReached(uint256 used, uint256 add, uint256 cap);
    /// @notice The ring of takes is full of takes still inside 28 days (cannot happen with 8 open tasks; fails closed).
    error TakesFull();
    /// @notice The pot cannot fund the task as stated: nothing, or less than `minAmount`.
    error TooLittleCash(uint256 min, uint256 got);
    /// @notice A payment above what the task holds.
    error TooMuch(uint256 amount, uint256 available);
    /// @notice Not before `readyAt`.
    error NotYet(uint256 readyAt);
    /// @notice The numbers the Treasury and the book keep do not agree (fails closed).
    error Inconsistent();
    /// @notice No note to settle: none held for this task, or the task was paid in full (its notes are void), withdrawn or
    /// lapsed.
    error NothingToPay();

    modifier onlyTreasury() {
        if (msg.sender != treasury) revert NotAllowed();
        _;
    }

    constructor() {
        treasury = address(1); // locks the implementation the clones point at
    }

    /// @notice Set up the clone, once. The Launcher calls it in the transaction that creates the clone.
    function initialize(address treasury_, uint32 unit_) external {
        if (treasury != address(0) || treasury_ == address(0) || unit_ == 0) revert BadSetup();
        (treasury, unit, nextSerial) = (treasury_, unit_, 1);
    }

    // ================================================= the queue =====================================================

    /// @inheritdoc ITaskBook
    function announce(bytes32 what, address payee, uint256 maxDollars, uint16 shareBps)
        external
        onlyTreasury
        returns (uint64 serial, uint64 next)
    {
        if (what == 0 || shareBps == 0 || maxDollars < MIN_TASK || maxDollars > type(uint128).max) {
            revert BadInput();
        }
        if (shareBps > MAX_SHARE_BPS) revert ShareTooBig();
        uint256 n = openCount;
        if (n >= MAX_OPEN) revert TooManyOpen();
        serial = nextSerial++;
        (uint256 notice, uint256 window,) = noticeFor(shareBps);
        uint64 noticeEnd = uint64(block.timestamp + notice);
        uint64 end = uint64(noticeEnd + window);
        Task storage k = _task[serial];
        k.what = what;
        k.payee = payee;
        k.state = State.Announced;
        k.shareBps = shareBps;
        k.announcedAt = uint64(block.timestamp);
        k.noticeEnd = noticeEnd;
        k.expiresAt = end;
        k.maxDollars = uint128(maxDollars);
        _open[n] = serial;
        openCount = uint8(n + 1);
        emit TaskAnnounced(
            serial, what, payee, maxDollars, shareBps, uint64(block.timestamp), noticeEnd, end, openCount
        );
        next = _minExpiry();
    }

    /// @inheritdoc ITaskBook
    /// @dev The money is the smaller of the stated dollars and the stated share of the settled pot now, rounded down. The cap
    /// counts it as `ceil(amount x 10,000 / pot)` ten-thousandths (rounded up, against the taker) in any 28 days. The ring
    /// holds 16 takes: every task is open at least 2N before its take, so the takes inside any 4N window were open at the
    /// window's start or at its middle, at most 8 each time; a take that would overwrite a take still inside the window
    /// fails closed.
    function take(uint64 serial, address who, uint256 pot, uint256 minAmount)
        external
        onlyTreasury
        returns (uint256 amount, uint64 next)
    {
        Task storage k = _task[serial];
        State st = k.state;
        if (st == State.None) revert NoSuchTask();
        if (st != State.Announced) revert WrongTaskState();
        if (k.payee != address(0) && k.payee != who) revert NotAllowed();
        uint256 t = block.timestamp;
        if (t < k.noticeEnd) revert NoticeRunning(k.noticeEnd);
        if (t >= k.expiresAt) revert TakeWindowOver();
        amount = Math.min(k.maxDollars, Math.mulDiv(pot, k.shareBps, BPS));
        if (amount == 0 || amount < minAmount) revert TooLittleCash(minAmount, amount);
        uint256 bps = Math.ceilDiv(amount * BPS, pot);
        uint256 used = _windowSum(t);
        if (used + bps > CAP_BPS) revert CapReached(used, bps, CAP_BPS);
        uint256 i = _takeIdx;
        uint256 old = _takes[i];
        if (old & 0xffff != 0 && (old >> 16) + 4 * uint256(unit) > t) revert TakesFull();
        _takes[i] = uint80((t << 16) | bps);
        _takeIdx = uint8((i + 1) % RING);
        uint64 due = uint64(t + 2 * uint256(unit));
        k.state = State.Taken;
        (k.takenBy, k.takenAt, k.deadline, k.expiresAt) = (who, uint64(t), due, due);
        (k.locked, k.stayer) = (uint128(amount), uint128(amount));
        emit TaskTaken(serial, who, amount, bps, uint64(t), due, used + bps, openCount);
        next = _minExpiry();
    }

    /// @inheritdoc ITaskBook
    function accept(uint64 serial, uint256 pay) external onlyTreasury returns (Resolved memory r) {
        Task storage k = _task[serial];
        _needTaken(k);
        if (block.timestamp >= k.deadline) revert WrongTaskState();
        if (pay == 0) revert BadInput();
        if (pay > k.locked) revert TooMuch(pay, k.locked);
        r = _resolve(serial, k, pay, State.Paid);
        r.next = _minExpiry();
    }

    /// @inheritdoc ITaskBook
    function reject(uint64 serial) external onlyTreasury returns (Resolved memory r) {
        Task storage k = _task[serial];
        _needTaken(k);
        r = _resolve(serial, k, 0, State.Rejected);
        r.next = _minExpiry();
    }

    /// @inheritdoc ITaskBook
    function cancel(uint64 serial) external onlyTreasury returns (uint64 next) {
        Task storage k = _task[serial];
        if (k.state == State.None) revert NoSuchTask();
        if (k.state != State.Announced) revert WrongTaskState();
        _end(serial, k, State.Cancelled);
        emit TaskResolved(serial, uint8(State.Cancelled), 0, 0, 0, 0, 0, openCount);
        next = _minExpiry();
    }

    /// @inheritdoc ITaskBook
    function expireDue() external onlyTreasury returns (uint256 sumC, uint64 next) {
        uint64[8] memory ids = _open;
        uint256 n = openCount;
        for (uint256 i; i < n; ++i) {
            Task storage k = _task[ids[i]];
            if (k.expiresAt > block.timestamp) continue;
            if (k.state == State.Taken) {
                sumC += _resolve(ids[i], k, 0, State.Returned).pp;
            } else {
                _end(ids[i], k, State.Lapsed);
                emit TaskResolved(ids[i], uint8(State.Lapsed), 0, 0, 0, 0, 0, openCount);
            }
        }
        next = _minExpiry();
    }

    /// @inheritdoc ITaskBook
    function sweepAll() external onlyTreasury returns (uint256 sumC) {
        uint64[8] memory ids = _open;
        uint256 n = openCount;
        for (uint256 i; i < n; ++i) {
            Task storage k = _task[ids[i]];
            if (k.state == State.Taken) {
                sumC += _resolve(ids[i], k, 0, State.Returned).pp;
            } else {
                _end(ids[i], k, State.Cancelled);
                emit TaskResolved(ids[i], uint8(State.Cancelled), 0, 0, 0, 0, 0, openCount);
            }
        }
    }

    // ================================================= exit notes ====================================================

    /// @inheritdoc ITaskBook
    /// @dev A leaver's note is spread over the taken tasks in proportion to each one's stayers' claim: `part = floor(note x C /
    /// stay)`, so a part never passes its task's `C` while `note <= stay`, and the few units the floors leave stay in `C`
    /// (the stayers' dust). For each task `C + N == L` keeps holding, since `C` falls by what `N` gains. The book adds up the
    /// claims itself and fails closed if the Treasury's sum is another.
    function mintNotes(address holder, uint256 note, uint256 stay) external onlyTreasury returns (uint256 minted) {
        uint64[8] memory ids = _open;
        uint256 n = openCount;
        uint256 sum;
        for (uint256 i; i < n; ++i) {
            Task storage k = _task[ids[i]];
            if (k.state == State.Taken) sum += k.stayer;
        }
        if (sum != stay || note > stay) revert Inconsistent();
        if (note == 0) return 0;
        for (uint256 i; i < n; ++i) {
            Task storage k = _task[ids[i]];
            if (k.state != State.Taken) continue;
            uint256 part = Math.mulDiv(note, k.stayer, stay);
            if (part == 0) continue;
            (k.stayer, k.noteFace) = (k.stayer - uint128(part), k.noteFace + uint128(part));
            noteOf[ids[i]][holder] += part;
            minted += part;
            emit NoteMinted(ids[i], holder, part, k.stayer, k.noteFace);
        }
    }

    /// @inheritdoc ITaskBook
    /// @dev The task ended with `returned` dollars (`rem`) of its `locked` (`L`); the notes were given `floor(N x rem / L)` to
    /// share, and each note is paid `floor(note x rem / L)`. A sum of floors of shares of `N` cannot pass the floor of the
    /// whole, so the notes of a task are never paid more than it returned for them. The note is cleared before anything else
    /// is written. The last note against a task also releases what the floors left over.
    function claim(uint64 serial, address holder) external onlyTreasury returns (uint256 paid, uint256 dust) {
        Task storage k = _task[serial];
        State st = k.state;
        if (st == State.None) revert NoSuchTask();
        if (st == State.Announced || st == State.Taken) revert NotYet(k.expiresAt);
        uint256 rem = k.returned;
        uint256 note = noteOf[serial][holder];
        if (rem == 0 || note == 0) revert NothingToPay();
        noteOf[serial][holder] = 0;
        paid = Math.mulDiv(note, rem, k.locked);
        uint256 face = k.noteFace - note;
        uint256 left = k.notesLeft - paid;
        if (face == 0) {
            (dust, left) = (left, 0);
        }
        (k.noteFace, k.notesLeft) = (uint128(face), uint128(left));
        emit NoteClaimed(serial, holder, paid, dust, face, left);
    }

    // ================================================= views =========================================================

    /// @inheritdoc ITaskBook
    function spreadSum(uint256 note, uint256 stay) external view returns (uint256 minted) {
        uint256 n = openCount;
        for (uint256 i; i < n; ++i) {
            Task storage k = _task[_open[i]];
            if (k.state == State.Taken && k.expiresAt > block.timestamp && stay != 0) {
                minted += Math.mulDiv(note, k.stayer, stay);
            }
        }
    }

    /// @inheritdoc ITaskBook
    function claimableNote(uint64 serial, address holder) external view returns (uint256) {
        Task storage k = _task[serial];
        State st = k.state;
        if (st == State.None || st == State.Announced || st == State.Taken || k.returned == 0) return 0;
        return Math.mulDiv(noteOf[serial][holder], k.returned, k.locked);
    }

    /// @inheritdoc ITaskBook
    function requireReturned(uint64 serial) external view {
        Task storage k = _task[serial];
        State st = k.state;
        if (st == State.None) revert NoSuchTask();
        if (st == State.Returned || st == State.Lapsed) return;
        if (st == State.Announced || st == State.Taken) revert NotYet(k.expiresAt);
        revert WrongTaskState();
    }

    /// @inheritdoc ITaskBook
    function dueC(uint256 when) external view returns (uint256 sumC) {
        uint256 n = openCount;
        for (uint256 i; i < n; ++i) {
            Task storage k = _task[_open[i]];
            if (k.state == State.Taken && k.expiresAt <= when) sumC += k.stayer;
        }
    }

    /// @inheritdoc ITaskBook
    /// @dev The notice is `2N + N/1400` per ten-thousandth of the pot asked, rounded up (14 days plus 12 hours per 1% at
    /// N = 7 days). The take window is N; a taken task is due 2N after the take.
    function noticeFor(uint16 shareBps)
        public
        view
        returns (uint256 noticeSecs, uint256 takeWindowSecs, uint256 dueSecs)
    {
        uint256 n = unit;
        return (2 * n + Math.ceilDiv(uint256(shareBps) * n, 1400), n, 2 * n);
    }

    /// @notice Everything stored about task `serial`.
    function taskOf(uint64 serial) external view returns (Task memory) {
        return _task[serial];
    }

    /// @notice The serials of the open tasks (announced or taken).
    function openSerials() external view returns (uint64[] memory out) {
        uint256 n = openCount;
        out = new uint64[](n);
        for (uint256 i; i < n; ++i) {
            out[i] = _open[i];
        }
    }

    /// @notice The takes counted against the cap right now, in ten-thousandths of the pot.
    function windowSumBps() external view returns (uint256) {
        return _windowSum(block.timestamp);
    }

    /// @notice How much more may be taken right now before the cap, in ten-thousandths of the pot.
    function takeRoomBps() external view returns (uint256) {
        return CAP_BPS - _windowSum(block.timestamp);
    }

    // ================================================= plumbing ======================================================

    function _needTaken(Task storage k) private view {
        if (k.state == State.None) revert NoSuchTask();
        if (k.state != State.Taken) revert WrongTaskState();
    }

    /// @dev The takes still inside 28 days (4N) of `t`, in ten-thousandths of the pot.
    function _windowSum(uint256 t) private view returns (uint256 sum) {
        uint256 span = 4 * uint256(unit);
        for (uint256 i; i < RING; ++i) {
            uint256 e = _takes[i];
            if ((e >> 16) + span > t) sum += e & 0xffff;
        }
    }

    /// @dev The earliest end of any open task, zero when none is open.
    function _minExpiry() private view returns (uint64 m) {
        uint256 n = openCount;
        for (uint256 i; i < n; ++i) {
            uint64 e = _task[_open[i]].expiresAt;
            if (m == 0 || e < m) m = e;
        }
    }

    /// @dev Take `serial` off the open list and give it its end state.
    function _end(uint64 serial, Task storage k, State st) private {
        k.state = st;
        uint256 n = openCount - 1;
        openCount = uint8(n);
        for (uint256 i; i <= n; ++i) {
            if (_open[i] == serial) {
                _open[i] = _open[n];
                _open[n] = 0;
                return;
            }
        }
        revert Inconsistent();
    }

    /// @dev End a taken task having paid `pay` to its taker. What is left, `rem = L - pay`, is split at one ratio: the notes get
    /// `floor(N x rem / L)` (it stays held for their claims), everything else is the stayers' and goes back to the pot, so
    /// the stayers get the rounding. Paid in full (`rem == 0`) the notes are void.
    function _resolve(uint64 serial, Task storage k, uint256 pay, State st) private returns (Resolved memory r) {
        uint256 l = k.locked;
        (r.to, r.pay, r.c, r.n) = (k.takenBy, pay, k.stayer, k.noteFace);
        uint256 rem = l - pay;
        if (rem != 0) {
            r.np = Math.mulDiv(r.n, rem, l);
            r.pp = rem - r.np;
            (k.returned, k.notesLeft) = (uint128(rem), uint128(r.np));
        } else {
            k.noteFace = 0;
        }
        k.stayer = 0;
        _end(serial, k, st);
        emit TaskResolved(serial, uint8(st), pay, rem, r.np, r.pp, k.noteFace, openCount);
    }
}
