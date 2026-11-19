#!/usr/bin/env python3
"""Proves two things by breaking the contracts on purpose, one change at a time, in a scratch copy:

  vectors     a changed FORMULA makes `test/ModelVectors.t.sol` fail (the contracts are bound to the reference model);
  invariants  a removed or changed GUARD makes `test/PotInvariants.t.sol` or `test/MustBind.t.sol` fail (the invariant run
              and the handler would catch it);
  tasks       a changed rule or removed guard of the task queue (step 2) makes the test file that binds it fail;
  notes       the same for exit notes and their claims; a changed number moves the model vectors, a changed rule or order
              moves the unit tests, the cycled must-bind run or the ledger of events.

A mutation with a seventh entry (a sentence) is an EQUIVALENT mutant: the change cannot alter what the contract does, the
sentence says why, and the script requires that it survive (a mutant that was killed would mean the proof is wrong).

Each mutation is an exact one-line text replacement that must occur exactly once. A mutation that leaves its tests green is a
hole in the tests: the script prints it and exits 1. The real project is never touched: a minimal copy goes to a temporary folder
(`lib` is linked, not copied).

Run from anywhere:   python3 contracts/pot/scripts/check-mutations.py [--only NAME] [--wait CMD] [--keep]
  --only NAME   run one mutation (or several, comma separated)
  --wait CMD    a shell command to run before every forge call (for machines shared with other builds)
  --keep        keep the scratch folder and print its path
  --check       only check that every mutation's text occurs exactly once (no forge run)

Needs forge on PATH and about 30 seconds per mutation (the first compile is the slowest).
"""
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
POT = os.path.dirname(HERE)

# (name, file, old text, new text, tests, what the change breaks)
V = "test/ModelVectors.t.sol"
QO = "test/QuoteOffset.t.sol"
SF = "test/SettleFirst.t.sol"
EX = "test/Expiry.t.sol"
INV = "test/PotInvariants.t.sol"
MB = "test/MustBind.t.sol"
TB = "test/TaskBook.t.sol"
TK = "test/Tasks.t.sol"
TC = "test/TasksCaps.t.sol"
TE = "test/TasksExpiry.t.sol"
AR = "test/Arrival.t.sol"
OB = "test/OwnBurn.t.sol"
AM = "test/AccessMatrix.t.sol"
NT = "test/Notes.t.sol"
NM = "test/NotesMustBind.t.sol"
NF = "test/NotesFuzz.t.sol"
TR = "test/TasksRebuild.t.sol"
MUTATIONS = [
    # ---- formulas: the vectors must notice
    ("offset-dollar", "src/PotMath.sol", "OFFSET_USD = 1;", "OFFSET_USD = 1e6;", QO, "the virtual money in the quote grows to a dollar"),
    ("offset-shares", "src/PotMath.sol", "OFFSET_SHARES = 1e14;", "OFFSET_SHARES = 100e18;", QO, "the virtual Shares in the quote grow to 100 Shares (a joiner buys below leave-value)"),
    ("quote-team", "src/PotMath.sol", "num = mn * (bq + ge) + sur * bq;", "num = mn * bq + sur * bq;", V, "the surplus shared with Team Shares in the price"),
    ("cash-team", "src/PotMath.sol", "return Math.mulDiv(n, a1, b) + Math.mulDiv(n, s, b + g);", "return Math.mulDiv(n, a1, b) + Math.mulDiv(n, s, b);", V, "the surplus shared with Team Shares in a take-out"),
    ("teamcash", "src/PotMath.sol", "        return Math.mulDiv(n, s, b + g);\n    }\n\n    /// @notice What leaves paid-in", "        return Math.mulDiv(n, s, b);\n    }\n\n    /// @notice What leaves paid-in", V, "a Team take-out"),
    ("paid-in-cut", "src/PotMath.sol", "return Math.mulDiv(paidIn, n, b);", "return Math.mulDiv(paidIn, n, b) / 2;", V, "what leaves paid-in on a take-out"),
    ("fee", "src/PotMath.sol", "return (a * feeBps + BPS - 1) / BPS;", "return (a * (feeBps + 1) + BPS - 1) / BPS;", V, "the platform fee"),
    ("credit", "src/PotMath.sol", "uint256 cap = Math.mulDiv(n, paidIn, b);", "uint256 cap = Math.mulDiv(n, paidIn, b) / 2;", V, "paid-in credited on a join"),
    ("accrual", "src/Treasury.sol", "Math.mulDiv(s.pot, rate * s.dt, PPM * (unit / 7))", "Math.mulDiv(s.pot, rate * s.dt, PPM * (unit / 8))", V, "the allowance accrual"),
    ("box-cap", "src/Treasury.sol", "uint256 cap = Math.mulDiv(s.pot + s.box, rate * 7, PPM);\n        if (s.dt", "uint256 cap = Math.mulDiv(s.pot + s.box, rate * 8, PPM);\n        if (s.dt", V, "the seven-day box cap"),
    ("release", "src/Treasury.sol", "Math.mulDiv(total, t - arrivalStart, until - arrivalStart)", "Math.mulDiv(total, t - arrivalStart, until - arrivalStart + 1000)", V, "the outside money release"),
    ("merge", "src/Treasury.sol", "Math.ceilDiv(old * rem + x * unit, old + x)", "Math.ceilDiv(x * unit, x)", V, "the weighted-average arrival of two payments"),
    ("window", "src/Treasury.sol", "CHECK_IN_MULT = 2;", "CHECK_IN_MULT = 3;", V, "the two-unit check-in window"),
    ("z-in-quote", "src/Treasury.sol", "uint256 ge = team.totalSupply() - Z;", "uint256 ge = team.totalSupply();", V, "the announced burn in the join price"),
    ("empty-credit", "src/PotMath.sol", "uint256 slice = Math.mulDiv(n, sur, b + OFFSET_SHARES + ge, Math.Rounding.Ceil);", "uint256 slice = 0;", V, "the slice a joiner pays for the surplus is not taken off its credit"),
    ("dust-credit", "src/PotMath.sol", "uint256 c = slice >= m ? 0 : m - slice;", "uint256 c = b == 0 ? (slice >= m ? 0 : m - slice) : m;", QO, "with backers in the project the credit ignores the surplus slice (a dust backer takes the Team's surplus)"),
    ("vesting", "src/Vester.sol", "VEST_MULT = 104;", "VEST_MULT = 52;", V, "the 104-unit vesting length"),
    # ---- guards: the invariant run and the must-bind tests must notice
    ("leave-cut", "src/Treasury.sol", "paidIn -= PotMath.paidInCut(paidIn, n, b);", "", INV, "paid-in is not cut on a take-out"),
    ("team-takes-paid-in", "src/Treasury.sol", "cash = PotMath.teamCash(n, pot, paidIn, b, g);", "cash = PotMath.cash(n, pot, paidIn, b, g);", INV, "Team Shares reach backers' paid-in money"),
    ("box-over-cap", "src/Treasury.sol", "if (s.box > cap) {", "if (s.box > cap && false) {", INV, "the box is not cut back to its cap"),
    ("fee-not-owed", "src/Treasury.sol", "feesOwed += fee;", "", INV, "the platform fee is not booked"),
    ("draw-keeps-box", "src/Treasury.sol", "        box -= amount;\n        _pay(to, amount);", "        _pay(to, amount);", INV, "a draw does not empty the box"),
    ("full-credit", "src/PotMath.sol", "return c;\n    }\n\n    /// @notice The cash `n` backer", "return m;\n    }\n\n    /// @notice The cash `n` backer", INV, "a join is credited its whole payment as paid-in"),
    ("late-settle-checkin", "src/Treasury.sol", "        _settle();\n        lastCheckIn = uint64(block.timestamp);", "        lastCheckIn = uint64(block.timestamp);\n        _settle();", MB, "a check-in that writes the window before it settles"),
    ("no-owner", "src/Treasury.sol", "if (shares.totalSupply() == 0 && team.totalSupply() == 0) revert NoOwner();", "", QO, "outside money accepted while nobody owns any Share"),
    ("revenue-cap", "src/Treasury.sol", "if (amount > MAX_REVENUE) revert TooMuch(amount, MAX_REVENUE);", "", "test/Revenue.t.sol", "an absurd outside payment wedges every join"),
    ("settle-leave", "src/Treasury.sol", "returns (uint256 cash) {\n        _settle();\n        uint256 b = shares.totalSupply();", "returns (uint256 cash) {\n        uint256 b = shares.totalSupply();", SF, "a take-out that does not settle first"),
    ("settle-leave-team", "src/Treasury.sol", "returns (uint256 cash) {\n        _settle();\n        uint256 g = team.totalSupply();", "returns (uint256 cash) {\n        uint256 g = team.totalSupply();", SF, "a Team take-out that does not settle first"),
    ("settle-pay-and-call", "src/Treasury.sol", "        _settle();\n        _gate(value);", "        _gate(value);", SF, "the one-signature join does not settle first"),
    ("settle-revenue", "src/Treasury.sol", "        _settle();\n        uint256 x = _pull(amount);", "        uint256 x = _pull(amount);", SF, "outside money merged into the stream without settling first"),
    ("pair-ttl", "src/Pair.sol", "if (block.timestamp > proposedAt[id] + PROPOSAL_TTL) revert Expired();", "", EX, "a Pair proposal never expires"),
    ("seat-expiry", "src/Treasury.sol", "if (block.timestamp > uint256(pendingSeatAt) + SEAT_OFFER_MULT * unit) revert OfferExpired();", "", EX, "a seat offer never expires"),
    ("seat-withdraw", "src/Treasury.sol", "if (next == runner) revert BadInput();", "if (next == runner || next == address(0)) revert BadInput();", EX, "a seat offer cannot be withdrawn"),
    ("min-grant", "src/Vester.sol", "amount < MIN_GRANT", "amount == 0", EX, "dust grants can fill a member's grant slots"),
    ("admin-accept", "src/Launcher.sol", "if (msg.sender != pendingAdmin) revert NotAdmin();", "", "test/Launcher.t.sol", "anyone can take an admin seat that was offered to someone else"),
    ("data-length", "src/Treasury.sol", "|| data.length != 64) revert NotAllowed();", "|| data.length < 64) revert NotAllowed();", "test/Join.t.sol", "the one-signature join accepts data longer than it decodes"),
    ("cliff", "src/Vester.sol", "CLIFF_MULT = 13;", "CLIFF_MULT = 14;", "test/Vester.t.sol", "the 13-unit vesting cliff"),
    ("raise-wait", "src/Treasury.sol", "if (block.timestamp < uint256(proposedAt) + unit) revert NotYet(uint256(proposedAt) + unit);", "if (block.timestamp < uint256(proposedAt) + unit / 2) revert NotYet(uint256(proposedAt) + unit);", "test/Allowance.t.sol", "a rate raise waits half a time unit instead of one"),
    ("rate-ceiling", "src/Treasury.sol", "MAX_RATE_PPM = 2000;", "MAX_RATE_PPM = 2001;", "test/Allowance.t.sol", "the 0.20% a day ceiling"),
    ("burn-anyone", "src/ShareToken.sol", "function burnFor(address from, uint256 value) external {\n        if (msg.sender != controller) revert NotController();", "function burnFor(address from, uint256 value) external {", "test/ShareToken.t.sol", "anyone can burn another's Shares (the burn authority)"),
    # ---- step 2, the task queue: the unit tests of each rule and guard must notice
    ("notice-base", "src/TaskBook.sol", "return (NOTICE_FLOOR_MULT * n + Math.ceilDiv(uint256(shareBps) * n, NOTICE_PER_BP_DIV), n, DUE_MULT * n);", "return (n + Math.ceilDiv(uint256(shareBps) * n, NOTICE_PER_BP_DIV), n, DUE_MULT * n);", TB, "the notice floor of two units drops to one"),
    ("notice-per-share", "src/TaskBook.sol", "return (NOTICE_FLOOR_MULT * n + Math.ceilDiv(uint256(shareBps) * n, NOTICE_PER_BP_DIV), n, DUE_MULT * n);", "return (NOTICE_FLOOR_MULT * n, n, DUE_MULT * n);", TB, "the 12 hours per 1% of the notice are gone"),
    ("notice-rounds-down", "src/TaskBook.sol", "Math.ceilDiv(uint256(shareBps) * n, NOTICE_PER_BP_DIV)", "((uint256(shareBps) * n) / NOTICE_PER_BP_DIV)", TB, "the notice per ten-thousandth rounds down (for holders' worse)"),
    ("take-window", "src/TaskBook.sol", "return (NOTICE_FLOOR_MULT * n + Math.ceilDiv(uint256(shareBps) * n, NOTICE_PER_BP_DIV), n, DUE_MULT * n);", "return (NOTICE_FLOOR_MULT * n + Math.ceilDiv(uint256(shareBps) * n, NOTICE_PER_BP_DIV), 2 * n, DUE_MULT * n);", TB, "the take window is two units, not one"),
    ("deadline", "src/TaskBook.sol", "uint64 due = uint64(t + DUE_MULT * uint256(unit));", "uint64 due = uint64(t + 3 * uint256(unit));", TB, "a taken task is due three units after the take, not two"),
    ("cap-window", "src/TaskBook.sol", "uint256 span = CAP_WINDOW_MULT * uint256(unit);", "uint256 span = 3 * uint256(unit);", TB, "the rolling cap counts 21 days, not 28"),
    ("cap-1001", "src/TaskBook.sol", "CAP_BPS = 1000;", "CAP_BPS = 1001;", TC, "the 10% cap becomes 10.01%"),
    ("cap-check", "src/TaskBook.sol", "if (used + bps > CAP_BPS) revert CapReached(used, bps, CAP_BPS);", "", TC, "no cap on money taken"),
    ("cap-rounds-down", "src/TaskBook.sol", "uint256 bps = Math.ceilDiv(amount * BPS, pot);", "uint256 bps = (amount * BPS) / pot;", TC, "a take counts against the cap rounded down, not up"),
    ("per-task-501", "src/TaskBook.sol", "MAX_SHARE_BPS = 500;", "MAX_SHARE_BPS = 501;", TB, "a task may ask for 5.01% of the pot"),
    ("slots-nine", "src/TaskBook.sol", "MAX_OPEN = 8;", "MAX_OPEN = 9;", TB, "nine open tasks"),
    ("ring-guard", "src/TaskBook.sol", "if (old & 0xffff != 0 && (old >> 16) + CAP_WINDOW_MULT * uint256(unit) > t) revert TakesFull();", "", TB, "a take may overwrite one still inside the window"),
    ("cap-give-back-off", "src/TaskBook.sol", "uint256 given = pay == 0 ? _giveBackCap(k) : 0;", "uint256 given = 0;", TC, "a take that ended unpaid keeps counting in the cap (a stranger burns the cap of named tasks)"),
    ("cap-give-back-paid", "src/TaskBook.sol", "uint256 given = pay == 0 ? _giveBackCap(k) : 0;", "uint256 given = _giveBackCap(k);", TB, "a take that was paid gives its cap back too"),
    ("cap-give-back-slot", "src/TaskBook.sol", "uint256 i = k.ringIdx;\n        uint256 e = _takes[i];", "uint256 i = 0;\n        uint256 e = _takes[i];", TB, "the give-back clears the first ring entry, not the take's own"),
    ("cap-give-back-time", "src/TaskBook.sol", "if ((e >> 16) != k.takenAt) return 0;", "", TB, "the give-back clears an entry that now belongs to a later take"),
    ("cap-give-back-event", "src/TaskBook.sol", "emit TaskResolved(serial, uint8(st), pay, rem, r.np, r.pp, k.noteFace, openCount, given);", "emit TaskResolved(serial, uint8(st), pay, rem, r.np, r.pp, k.noteFace, openCount, 0);", TR, "the event does not say how much cap was given back (a ledger of events cannot rebuild the window)"),
    ("cap-give-back-partial", "src/TaskBook.sol", "_takes[i] = uint80(e & ~uint256(0xffff));", "_takes[i] = uint80(e & ~uint256(0xff));", TB, "the give-back clears only the low byte of the take's share"),
    ("serial-reuse", "src/TaskBook.sol", "serial = nextSerial++;", "serial = nextSerial;", TB, "a serial is used again"),
    ("larger-of", "src/TaskBook.sol", "amount = Math.min(k.maxDollars, Math.mulDiv(pot, k.shareBps, BPS));", "amount = Math.max(k.maxDollars, Math.mulDiv(pot, k.shareBps, BPS));", TB, "a take sets aside the larger of the dollars and the share"),
    ("notice-guard", "src/TaskBook.sol", "if (t < k.noticeEnd) revert NoticeRunning(k.noticeEnd);", "", TB, "a task is taken before its notice is over"),
    ("window-guard", "src/TaskBook.sol", "if (t >= k.expiresAt) revert TakeWindowOver();", "", TB, "a task is taken after its take window"),
    ("accept-deadline", "src/TaskBook.sol", "if (block.timestamp >= k.deadline) revert WrongTaskState();", "", TB, "a task is accepted after its deadline"),
    ("accept-zero", "src/TaskBook.sol", "if (pay == 0) revert BadInput();", "", TB, "an accept that pays nothing"),
    ("cancel-after-take", "src/TaskBook.sol", "if (k.state != State.Announced) revert WrongTaskState();\n        _end(serial, k, State.Cancelled);", "_end(serial, k, State.Cancelled);", TB, "a taken task can be cancelled"),
    ("payee-check", "src/TaskBook.sol", "if (k.payee != address(0) && k.payee != who) revert NotAllowed();", "", TB, "anyone takes a named task"),
    ("pay-to-payee", "src/TaskBook.sol", "(r.to, r.pay, r.c, r.n) = (k.takenBy, pay, k.stayer, k.noteFace);", "(r.to, r.pay, r.c, r.n) = (k.payee, pay, k.stayer, k.noteFace);", TK, "payment goes to the named payee, not to who took the task"),
    ("notes-first", "src/TaskBook.sol", "r.np = Math.mulDiv(r.n, rem, l);", "r.np = Math.min(r.n, rem);", TB, "on a part payment the notes are repaid first, not pro rata"),
    ("notes-pool-whole", "src/TaskBook.sol", "r.np = Math.mulDiv(r.n, rem, l);", "r.np = r.n;", TB, "the notes' pool is not scaled by what is left"),
    ("stayers-floor", "src/TaskBook.sol", "r.pp = rem - r.np;", "r.pp = Math.mulDiv(r.c, rem, l);", TB, "the stayers' share rounds down too, so a unit is left over"),
    ("open-list", "src/TaskBook.sol", "_open[i] = _open[n];", "", TB, "an ended task stays in the open list"),
    ("book-treasury-only", "src/TaskBook.sol", "if (msg.sender != treasury) revert NotAllowed();", "", AM, "anyone changes the task book"),
    ("quiet-check", "src/Treasury.sol", "if (block.timestamp >= activeEnd()) revert ProjectQuiet();", "", TK, "a task is announced or taken while the check-in window is closed"),
    ("payee-seat", "src/Treasury.sol", "if (payee != address(0) && _isTeamSeat(payee)) revert NotAllowed();", "", TK, "the runner or a signer may be the payee"),
    ("taker-seat", "src/Treasury.sol", "        if (_isTeamSeat(msg.sender)) revert NotAllowed();\n        uint64 next;", "        uint64 next;", TK, "the runner or a signer may take an open task"),
    ("accept-seat", "src/Treasury.sol", "if (_isTeamSeat(r.to)) revert NotAllowed();", "", TK, "a taker who became the runner is paid by themselves"),
    ("accept-anyone", "src/Treasury.sol", "function acceptTask(uint64 serial, uint256 payDollars) external nonReentrant onlyRunner {", "function acceptTask(uint64 serial, uint256 payDollars) external nonReentrant {", TK, "anyone accepts a task"),
    ("accept-no-lock", "src/Treasury.sol", "function acceptTask(uint64 serial, uint256 payDollars) external nonReentrant onlyRunner {", "function acceptTask(uint64 serial, uint256 payDollars) external onlyRunner {", TK, "the payee can re-enter while it is paid"),
    ("pay-before-book", "src/Treasury.sol", "        _book(2, serial, r);\n        _pay(r.to, r.pay);", "        _pay(r.to, r.pay);\n        _book(2, serial, r);", TK, "the worker is paid before the buckets are final"),
    ("expiry-skipped", "src/Treasury.sol", "if (nextExpiry != 0 && block.timestamp >= nextExpiry) {", "if (false) {", TE, "a task that ran out is not returned in the settle"),
    ("expiry-first", "src/Treasury.sol", ["        s.arriving = arriving;\n        uint256 end = activeEnd();", "        s.stay = locked;\n        uint256 nx = nextExpiry;\n        if (nx != 0 && t >= nx) {\n            s.expC = tasks.dueC(t);\n            s.stay -= s.expC;\n            s.pot += s.expC;\n        }"], ["        s.arriving = arriving;\n        s.stay = locked;\n        if (nextExpiry != 0 && t >= nextExpiry) {\n            s.expC = tasks.dueC(t);\n            s.stay -= s.expC;\n            s.pot += s.expC;\n        }\n        uint256 end = activeEnd();", "        s.stay = locked;\n        uint256 nx = nextExpiry;\n        if (nx == 0 && t >= nx) {\n            s.expC = tasks.dueC(t);\n            s.stay -= s.expC;\n            s.pot += s.expC;\n        }"], TE, "returned money is charged allowance for time it was not in the pot (expiry before accrual)"),
    ("quote-no-stay", "src/Treasury.sol", "PotMath.quote(s.pot, s.arriving + s.stay, paidIn, b, ge)", "PotMath.quote(s.pot, s.arriving, paidIn, b, ge)", TK, "a joiner is priced without the money set aside for tasks"),
    ("credit-no-stay", "src/Treasury.sol", "PotMath.credit(m, n, paidIn, b, s.pot, s.arriving + s.stay, ge)", "PotMath.credit(m, n, paidIn, b, s.pot, s.arriving, ge)", TK, "a joiner is credited on other money than it was priced on"),
    ("locked-line", "src/Treasury.sol", "lockedLine = s.stay;", "lockedLine = locked;", TE, "the quote's locked line ignores a task that has already run out"),
    ("wind-sweep", "src/Treasury.sol", "uint256 back = tasks.sweepAll();", "uint256 back = 0;", TK, "a wind-down leaves taken tasks open"),
    ("settled-event", "src/Treasury.sol", "|| s.released != 0 || s.expC != 0) {", "|| s.released != 0) {", TE, "a return that moved only money emits no Settled"),
    ("release-per-call", "src/Treasury.sol", "uint256 target = t >= until ? total : Math.mulDiv(total, t - arrivalStart, until - arrivalStart);", "uint256 target = (total - s.arriving) + (t >= until ? s.arriving : Math.mulDiv(s.arriving, t - last, until - last));", AR, "the outside money released depends on how often settle is called"),
    ("stream-start", "src/Treasury.sol", "(arrivalStart, arrivalTotal) = (uint64(t), old + x);", "(arrivalStart, arrivalTotal) = (uint64(t), x);", AR, "a merged stream forgets what had not arrived"),
    ("pair-ttl-fixed", "src/Pair.sol", "PROPOSAL_TTL = PROPOSAL_UNITS * uint256(treasury_.unit());", "PROPOSAL_TTL = 14 days;", EX, "a Pair's proposal lives 14 days whatever the time unit"),
    ("leave-burns-to", "src/Treasury.sol", "        shares.burnFor(msg.sender, n);\n        note = _giveNotes(msg.sender, note);", "        shares.burnFor(to, n);\n        note = _giveNotes(msg.sender, note);", OB, "a take-out burns the Shares of whoever is named, not the caller's"),
    ("leave-team-burns-to", "src/Treasury.sol", "        team.burnFor(msg.sender, n);\n        note = _giveNotes(msg.sender, note);", "        team.burnFor(to, n);\n        note = _giveNotes(msg.sender, note);", OB, "a Team take-out burns the Team Shares of whoever is named"),
    # ---- step 2, exit notes and their claims
    ("notes-by-slot", "src/TaskBook.sol", "noteOf[ids[i]][holder] += part;", "noteOf[uint64(i)][holder] += part;", NT, "a note is kept by the slot of the task, not by its serial"),
    ("spread-equal", "src/TaskBook.sol", "uint256 part = Math.mulDiv(note, k.stayer, stay);", "uint256 part = note / n;", NT, "a note is spread equally over the open tasks, not by their claims"),
    ("spread-up", "src/TaskBook.sol", "uint256 part = Math.mulDiv(note, k.stayer, stay);", "uint256 part = Math.mulDiv(note, k.stayer, stay, Math.Rounding.Ceil);", NT, "the parts of a note round up, so a leaver is given more than the note"),
    ("spread-sum-expired", "src/TaskBook.sol", "k.state == State.Taken && k.expiresAt > block.timestamp && stay != 0", "k.state == State.Taken && stay != 0", NT, "the quote counts a task that has run out as still taken"),
    ("mint-sum-check", "src/TaskBook.sol", "if (sum != stay || note > stay) revert Inconsistent();", "", NT, "the book writes notes against a sum the Treasury got wrong"),
    ("claim-not-zeroed", "src/TaskBook.sol", "        noteOf[serial][holder] = 0;\n        paid = Math.mulDiv(note, rem, k.locked);", "        paid = Math.mulDiv(note, rem, k.locked);", NT, "a note is not cleared when it is claimed"),
    ("claim-dust-to-claimer", "src/TaskBook.sol", "(dust, left) = (left, 0);", "(paid, left) = (paid + left, 0);", NT, "the rounding left at the last claim goes to the last claimer, not to the pot"),
    ("claim-rounds-up", "src/TaskBook.sol", "paid = Math.mulDiv(note, rem, k.locked);", "paid = Math.mulDiv(note, rem, k.locked, Math.Rounding.Ceil);", NT, "a claim rounds up, so the notes can be paid more than was held for them"),
    ("claim-face", "src/TaskBook.sol", "paid = Math.mulDiv(note, rem, k.locked);", "paid = note;", NT, "a note is paid its face, not its share of what came back"),
    ("claim-ratio", "src/TaskBook.sol", "paid = Math.mulDiv(note, rem, k.locked);", "paid = Math.mulDiv(note, rem, k.locked * 101 / 100);", V, "a claim is paid at a ratio one part in a hundred off"),
    ("claim-void-kept", "src/TaskBook.sol", "        } else {\n            k.noteFace = 0;\n        }", "        } else {\n        }", NM, "a task paid in full keeps the face of its void notes"),
    ("claim-event-state", "src/TaskBook.sol", "emit NoteClaimed(serial, holder, paid, dust, face, left);", "emit NoteClaimed(serial, holder, paid, dust, face, left + dust);", NT, "the claim event does not carry the state after it (the last claim: the rounding is in `dustToPot`, nothing is left)"),
    ("mint-event-state", "src/TaskBook.sol", "emit NoteMinted(ids[i], holder, part, k.stayer, k.noteFace);", "emit NoteMinted(ids[i], holder, part, k.stayer, 0);", TR, "the note event does not carry the state after it"),
    ("mint-keeps-claim", "src/Treasury.sol", "(locked, notesOwed) = (locked - minted, notesOwed + minted);", "(locked, notesOwed) = (locked, notesOwed + minted);", NT, "a note is written but the stayers' claim is not lowered by it"),
    ("mint-no-owed", "src/Treasury.sol", "(locked, notesOwed) = (locked - minted, notesOwed + minted);", "(locked, notesOwed) = (locked - minted, notesOwed);", NT, "a note is written but no money is held for it"),
    ("mint-no-event", "src/Treasury.sol", "        _taskMoney(5, 0, who, minted);\n", "", NT, "a note moves money between buckets and says nothing"),
    ("note-half", "src/Treasury.sol", "return Math.min(withLocked - cashNow, lk);", "return Math.min((withLocked - cashNow) / 2, lk);", V, "a leaver is given half the note they are owed"),
    ("note-team-formula", "src/Treasury.sol", "isTeam ? PotMath.teamCash(n, p + lk, paidIn, b, g) : PotMath.cash(n, p + lk, paidIn, b, g);", "PotMath.cash(n, p + lk, paidIn, b, g);", NT, "a Team take-out is given a note by the backers' formula"),
    ("note-after-cut", "src/Treasury.sol", "        uint256 note = _noteFull(false, n, cash, pot, locked, b, g);\n        paidIn -= PotMath.paidInCut(paidIn, n, b);\n        pot -= cash;", "        paidIn -= PotMath.paidInCut(paidIn, n, b);\n        pot -= cash;\n        uint256 note = _noteFull(false, n, cash, pot, locked, b, g);", NT, "the note is worked out after the pot was cut, not before"),
    ("quote-no-note", "src/Treasury.sol", "        if (cashNow != 0) note = tasks.spreadSum(_noteFull(false, n, cashNow, s.pot, s.stay, b, g), s.stay);\n", "", NT, "the take-out quote shows no note"),
    ("leave-zero-cash", "src/Treasury.sol", "cash = PotMath.cash(n, pot, paidIn, b, g);\n        if (cash == 0) revert NothingToPay();", "cash = PotMath.cash(n, pot, paidIn, b, g);", NT, "a take-out that pays no cash goes through"),
    ("claim-pays-sender", "src/Treasury.sol", "if (paid != 0) _pay(holder, paid);", "if (paid != 0) _pay(msg.sender, paid);", NT, "a claim pays whoever calls it, not the holder"),
    ("claim-no-settle", "src/Treasury.sol", "        _settle();\n        uint256 dust;", "        uint256 dust;", NT, "a claim does not settle first, so a task that ran out is not yet returned"),
    ("claim-no-lock", "src/Treasury.sol", "function claimNote(uint64 serial, address holder) external nonReentrant returns (uint256 paid) {", "function claimNote(uint64 serial, address holder) external returns (uint256 paid) {", NT, "the holder can re-enter while it is paid"),
    ("claim-pay-first", "src/Treasury.sol", "        notesOwed -= paid + dust;\n        pot += dust;\n        _taskMoney(6, serial, holder, paid);\n        if (paid != 0) _pay(holder, paid);", "        if (paid != 0) _pay(holder, paid);\n        notesOwed -= paid + dust;\n        pot += dust;\n        _taskMoney(6, serial, holder, paid);", NT, "the holder is paid before the buckets are final"),
    ("claim-dust-lost", "src/Treasury.sol", "        pot += dust;\n        _taskMoney(6", "        _taskMoney(6", NT, "the rounding left at the last claim is booked out of the notes but never reaches the pot"),
    ("note-no-cap", "src/Treasury.sol", "return Math.min(withLocked - cashNow, lk);", "return withLocked - cashNow;", NT, "the note is not capped at the money set aside", "never binding: each term of the cash formula rises by at most the money added to its part (ceil(n x d / b) <= d for n <= b), so the note is already at most the money set aside; the cap is defence in depth"),
    # the vectors bind the rules of the queue to the model (a rule changed in the contract moves a number the model does not move)
    ("vec-notice-base", "src/TaskBook.sol", "return (NOTICE_FLOOR_MULT * n + Math.ceilDiv(uint256(shareBps) * n, NOTICE_PER_BP_DIV), n, DUE_MULT * n);", "return (n + Math.ceilDiv(uint256(shareBps) * n, NOTICE_PER_BP_DIV), n, DUE_MULT * n);", V, "the notice floor of two units drops to one (the vectors check it to the second)"),
    ("vec-deadline", "src/TaskBook.sol", "uint64 due = uint64(t + DUE_MULT * uint256(unit));", "uint64 due = uint64(t + 3 * uint256(unit));", V, "a taken task is due three units after the take"),
    ("vec-cap-window", "src/TaskBook.sol", "uint256 span = CAP_WINDOW_MULT * uint256(unit);", "uint256 span = 3 * uint256(unit);", V, "the rolling cap counts 21 days (the vectors take at exactly 28 days after)"),
    ("vec-larger-of", "src/TaskBook.sol", "amount = Math.min(k.maxDollars, Math.mulDiv(pot, k.shareBps, BPS));", "amount = Math.max(k.maxDollars, Math.mulDiv(pot, k.shareBps, BPS));", V, "a take sets aside the larger of the dollars and the share"),
    ("vec-quote-no-stay", "src/Treasury.sol", "PotMath.quote(s.pot, s.arriving + s.stay, paidIn, b, ge)", "PotMath.quote(s.pot, s.arriving, paidIn, b, ge)", V, "a joiner is priced without the money set aside (the vectors join during a lock)"),
    ("vec-notes-first", "src/TaskBook.sol", "r.np = Math.mulDiv(r.n, rem, l);", "r.np = Math.min(r.n, rem);", V, "on a part payment the notes are repaid first, not pro rata"),
]


def run(cmd, cwd, env, wait):
    if wait:
        subprocess.run(wait, shell=True, cwd=cwd)
    return subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True)


def main():
    args = sys.argv[1:]
    only = set()
    wait = None
    keep = False
    check_only = False
    i = 0
    while i < len(args):
        if args[i] == "--only":
            only = set(args[i + 1].split(","))
            i += 2
        elif args[i] == "--wait":
            wait = args[i + 1]
            i += 2
        elif args[i] == "--keep":
            keep = True
            i += 1
        elif args[i] == "--check":
            check_only = True
            i += 1
        else:
            print(__doc__)
            return 2
    work = tempfile.mkdtemp(prefix="pot-mutations-")
    try:
        for d in ("src", "model"):
            shutil.copytree(os.path.join(POT, d), os.path.join(work, d))
        for f in ("foundry.toml", "remappings.txt"):
            shutil.copy(os.path.join(POT, f), work)
        os.symlink(os.path.realpath(os.path.join(POT, "lib")), os.path.join(work, "lib"))
        keep_tests = {"ModelVectors.t.sol"} | {os.path.basename(m[4]) for m in MUTATIONS}
        os.makedirs(os.path.join(work, "test"))
        for sub in ("helpers", "mocks"):
            shutil.copytree(os.path.join(POT, "test", sub), os.path.join(work, "test", sub))
        for name in keep_tests:
            shutil.copy(os.path.join(POT, "test", name), os.path.join(work, "test", name))
        env = dict(os.environ, FOUNDRY_INVARIANT_RUNS="64")
        first = None if check_only else run(["forge", "test", "--match-path", "test/ModelVectors.t.sol"], work, env, wait)
        if first is not None and first.returncode != 0:
            print("the unchanged copy does not pass its own vector test:\n" + first.stdout[-3000:] + first.stderr[-2000:])
            return 2
        survivors = []
        ran = 0
        for entry in MUTATIONS:
            name, rel, old, new, tests, what = entry[:6]
            equivalent = entry[6] if len(entry) > 6 else None
            if only and name not in only:
                continue
            path = os.path.join(work, rel)
            text = open(path).read()
            pairs = list(zip(old, new)) if isinstance(old, list) else [(old, new)]
            bad = [o for o, _ in pairs if text.count(o) != 1]
            if bad:
                print("%-22s MUTATION DOES NOT APPLY (%d matches in %s)" % (name, text.count(bad[0]), rel))
                survivors.append(name)
                continue
            if check_only:
                print("%-22s applies" % name)
                continue
            mutated = text
            for o, n in pairs:
                mutated = mutated.replace(o, n)
            open(path, "w").write(mutated)
            try:
                r = run(["forge", "test", "--match-path", tests], work, env, wait)
            finally:
                open(path, "w").write(text)
            ran += 1
            compiled = "Compiler run failed" not in (r.stdout + r.stderr)
            killed = r.returncode != 0 and compiled
            if equivalent:
                print("%-22s %s  (%s: %s)" % (name, "SURVIVED as proved: equivalent" if not killed else "KILLED, SO THE PROOF IS WRONG", os.path.basename(tests), what))
                print("%-22s   proof: %s" % ("", equivalent))
                if killed:
                    survivors.append(name)
                continue
            print("%-22s %s  (%s: %s)" % (name, "KILLED" if killed else "SURVIVED", os.path.basename(tests), what))
            if not killed:
                survivors.append(name)
        print("\n%d mutations run, %d survived" % (ran, len(survivors)))
        if survivors:
            print("survivors: " + ", ".join(survivors))
        return 1 if survivors else 0
    finally:
        if keep:
            print("scratch folder kept: " + work)
        else:
            shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
