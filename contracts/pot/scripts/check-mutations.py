#!/usr/bin/env python3
"""Proves two things by breaking the contracts on purpose, one change at a time, in a scratch copy:

  vectors     a changed FORMULA makes `test/ModelVectors.t.sol` fail (the contracts are bound to the reference model);
  invariants  a removed or changed GUARD makes `test/PotInvariants.t.sol` or `test/MustBind.t.sol` fail (the invariant run
              and the handler would catch it);
  tasks       a changed rule or removed guard of the task queue (step 2) makes the test file that binds it fail;
  notes       the same for exit notes and their claims; a changed number moves the model vectors, a changed rule or order
              moves the unit tests, the cycled must-bind run or the ledger of events;
  pause       a changed rule or removed guard of the holder pause (step 4, K1) makes the unit, attack or launcher tests fail;
  earlier     the same for the earlier backers' grants (step 4, K2): the claim contract, the Vester's reserve and counters, and the
              Launcher's binding;
  council     the same for the Council runner and the Treasury's and Launcher's recognition of it (the Council round, K1): the
              three-of-five rule, the list of calls, the fence, the seats and elections, `seatByVote`, the Launcher's binding, the
              settings hash's fourth form and the Pair's `isSeat`.

A mutation with a seventh entry (a sentence) is an EQUIVALENT mutant: the change cannot alter what the contract does, the
sentence says why, and the script requires that it survive (a mutant that was killed would mean the proof is wrong).

Each mutation is an exact one-line text replacement that must occur exactly once. A mutation that leaves its tests green is a
hole in the tests: the script prints it and exits 1. The real project is never touched: a minimal copy goes to a temporary folder
(`lib` is linked, not copied).

Run from anywhere:   python3 contracts/pot/scripts/check-mutations.py [--only NAME] [--wait CMD] [--keep]
  --only NAME   run one mutation (or several, comma separated); only the tests those mutations name are compiled and run
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
HP = "test/HolderPause.t.sol"
HA = "test/HolderPauseAttacks.t.sol"
LP = "test/LauncherPause.t.sol"
HI = "test/HolderPauseInvariants.t.sol"
EG = "test/EarlierGrants.t.sol"
EV = "test/EarlierVester.t.sol"
EL = "test/EarlierLauncher.t.sol"
EM = "test/EarlierMoney.t.sol"
CO = "test/Council.t.sol"
CA = "test/CouncilAccess.t.sol"
CS = "test/CouncilSeats.t.sol"
LC = "test/LauncherCouncil.t.sol"
SV = "test/SeatByVote.t.sol"
CE = "test/CouncilEventsRebuild.t.sol"
HV = "test/HolderVote.t.sol"
HC = "test/HolderVoteCount.t.sol"
HB = "test/HolderVoteBoundary.t.sol"
HR = "test/HolderVoteResults.t.sol"
HA = "test/HolderVoteAttacks.t.sol"
LV = "test/LauncherVote.t.sol"
DV = "test/DeployVoteSettings.t.sol"
OV = "test/OffIsOffVote.t.sol"
PV = "test/HolderPauseOnVote.t.sol"
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
    # ---- step 4, the holder pause (docs/next-version/STEP4-PLAN.md, K1): the unit, attack and launcher tests must notice
    ("line-floor", "src/HolderPause.sol", "return b != 0 && parkedTotal * LINE_DIVISOR >= b;", "return b != 0 && parkedTotal >= b / LINE_DIVISOR;", HP, "the line is a third rounded DOWN, so a few wei under a third arms the pause"),
    ("no-b-zero-guard", "src/HolderPause.sol", "return b != 0 && parkedTotal * LINE_DIVISOR >= b;", "return parkedTotal * LINE_DIVISOR >= b;", HP, "no Shares at all counts as a third (zero parked of zero) and pauses a project nobody backs"),
    ("delay-zero", "src/HolderPause.sol", "if (a == 0 || block.timestamp < a + day) return false;", "if (a == 0 || block.timestamp < a) return false;", HP, "the pause starts the second the line is reached: no day of warning"),
    ("no-hidden-dip-reset", "src/HolderPause.sol", "if (armedAt != 0 && !_reached(b)) armedAt = 0;", "", HP, "park and unpark do not look first, so a dip nobody saw keeps an old clock alive"),
    ("no-disarm", "src/HolderPause.sol", "        } else if (a != 0) {\n            armedAt = a = 0;\n        }", "        }", HP, "the clock is not cleared when parked Shares fall under the line"),
    ("arm-restarts", "src/HolderPause.sol", "if (a == 0) armedAt = a = uint64(block.timestamp);", "armedAt = a = uint64(block.timestamp);", HP, "parking more while armed restarts the day"),
    ("park-from-origin", "src/HolderPause.sol", "transferFrom(msg.sender, address(this), n)", "transferFrom(tx.origin, address(this), n)", HP, "park pulls Shares from someone who did not call it"),
    ("unpark-gated", "src/HolderPause.sol", "if (n > mine) revert TooMuch(n, mine);", "if (n > mine || (armedAt != 0 && block.timestamp >= uint256(armedAt) + day)) revert TooMuch(n, mine);", HA, "un-park is refused while the pause is on"),
    ("count-donation", "src/HolderPause.sol", "return b != 0 && parkedTotal * LINE_DIVISOR >= b;", "return b != 0 && shares.balanceOf(address(this)) * LINE_DIVISOR >= b;", HP, "Shares sent straight to the pause count as parked"),
    ("paused-not-live", "src/HolderPause.sol", "return _reached(shares.totalSupply());\n    }\n\n    /// @notice The fewest", "return true;\n    }\n\n    /// @notice The fewest", HP, "paused() stops reading the live ratio (killed only through a planted stale clock: with the join hook no reachable state differs)"),
    ("park-zero", "src/HolderPause.sol", "function park(uint256 n) external {\n        if (n == 0) revert BadInput();", "function park(uint256 n) external {", HP, "parking zero is accepted"),
    ("unpark-zero", "src/HolderPause.sol", "function unpark(uint256 n) external {\n        if (n == 0) revert BadInput();", "function unpark(uint256 n) external {", HP, "un-parking zero is accepted"),
    ("unpark-over", "src/HolderPause.sol", "if (n > mine) revert TooMuch(n, mine);", "", HP, "a holder can take back more than they parked (the subtraction still reverts, with another error)"),
    ("init-twice", "src/HolderPause.sol", "if (address(shares) != address(0)) revert AlreadyBorn();", "", HP, "a pause can be set up again"),
    ("init-unit", "src/HolderPause.sol", "|| unit_ == 0 || unit_ % 168 != 0) revert BadInput();", "|| unit_ == 0) revert BadInput();", HP, "a unit that is not a multiple of 168 is accepted"),
    ("park-false-ignored", "src/HolderPause.sol", "if (!IERC20(address(shares)).transferFrom(msg.sender, address(this), n)) revert TransferFailed();", "IERC20(address(shares)).transferFrom(msg.sender, address(this), n);", HP, "a Share token that answers false to a pull is believed"),
    ("unpark-false-ignored", "src/HolderPause.sol", "if (!shares.transfer(msg.sender, n)) revert TransferFailed();", "shares.transfer(msg.sender, n);", HP, "a Share token that answers false to a send back is believed"),
    ("draw-ungated", "src/Treasury.sol", "        _settle();\n        _notPaused();\n        if (\n            to == address(0)", "        _settle();\n        if (\n            to == address(0)", HA, "the team draws its allowance while the pause is on"),
    ("announce-ungated", "src/Treasury.sol", "        _openWindow();\n        _notPaused();", "        _openWindow();", HA, "a task is announced while the pause is on"),
    ("no-join-poke", "src/Treasury.sol", "        if (pauseGate != address(0)) IHolderPause(pauseGate).poke();\n", "", HA, "a join does not tell the pause to look, so a dip made by a join is unseen"),
    ("gate-fails-open", "src/Treasury.sol", "if (g != address(0) && IHolderPause(g).paused()) revert Paused();", "if (g != address(0)) {\n            try IHolderPause(g).paused() returns (bool p) {\n                if (p) revert Paused();\n            } catch {}\n        }", HA, "a gate that reverts is ignored (swallowed)"),
    ("bind-pause-anyone", "src/Treasury.sol", "function bindPause(address gate) external {\n        if (msg.sender != salePath) revert NotAllowed();", "function bindPause(address gate) external {", HP, "anyone can bind a gate to a Treasury"),
    ("bind-twice", "src/Treasury.sol", "if (pauseGate != address(0) || gate == address(0)) revert BadInput();", "if (gate == address(0)) revert BadInput();", HP, "a Treasury's gate can be replaced"),
    ("bind-zero-gate", "src/Treasury.sol", "if (pauseGate != address(0) || gate == address(0)) revert BadInput();", "if (pauseGate != address(0)) revert BadInput();", LP, "a Treasury accepts a zero gate (and keeps thinking it has none)"),
    ("launcher-bind-twice", "src/Launcher.sol", "if (holderPauseImpl != address(0) || block.timestamp > uint256(deployedAt) + 1 hours) revert BindClosed();", "if (block.timestamp > uint256(deployedAt) + 1 hours) revert BindClosed();", LP, "the Launcher's pause switch can be set again"),
    ("bind-after-hour", "src/Launcher.sol", "if (holderPauseImpl != address(0) || block.timestamp > uint256(deployedAt) + 1 hours) revert BindClosed();", "if (holderPauseImpl != address(0)) revert BindClosed();", LP, "the switch can be turned on after the first hour"),
    ("bind-not-deployer", "src/Launcher.sol", "function bindPause(address impl) external {\n        if (msg.sender != deployer) revert NotDeployer();", "function bindPause(address impl) external {", LP, "anyone can turn the pause on for new projects"),
    ("bind-needs-code", "src/Launcher.sol", "if (impl.code.length == 0) revert BadStack();", "", LP, "the switch accepts an address with no code"),
    ("launch-no-bind", "src/Launcher.sol", "            Treasury(treasury).bindPause(gate);\n", "", LP, "a project is launched with a pause that its Treasury does not know"),
    ("settings-hash-no-pause", "src/Launcher.sol", "return keccak256(abi.encode(platform, pause));", "return keccak256(abi.encode(platform));", LP, "the founder's settings hash does not cover the pause switch"),
    # ---- step 4, the earlier backers' grants (docs/next-version/STEP4-PLAN.md, K2): the claim, Vester and launcher tests must notice
    ("no-text-check", "src/EarlierGrants.sol", "if (accepted != textHash) revert WrongText();", "", EG, "a claim goes through without naming the text it accepts"),
    ("no-bitmap", "src/EarlierGrants.sol", "if (seen & bit != 0) revert AlreadyClaimed();", "", EG, "a row can be claimed again and again"),
    ("no-double-hash", "src/EarlierGrants.sol", "bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(index, msg.sender, amount))));", "bytes32 leaf = keccak256(abi.encode(index, msg.sender, amount));", EG, "a leaf is a single hash, so an inner node of the tree could pass as a row"),
    ("no-sender-in-leaf", "src/EarlierGrants.sol", "keccak256(abi.encode(index, msg.sender, amount))", "keccak256(abi.encode(index, tx.origin, amount))", EG, "the transaction's origin, not the sender, is tied to the row (a relay or contract could claim in someone's name)"),
    ("no-index-bound", "src/EarlierGrants.sol", "if (index >= rows || proof.length > MAX_PROOF) revert BadRow();", "if (proof.length > MAX_PROOF) revert BadRow();", EG, "an index past the number of rows is not refused for its index"),
    ("no-proof-depth", "src/EarlierGrants.sol", "if (index >= rows || proof.length > MAX_PROOF) revert BadRow();", "if (index >= rows) revert BadRow();", EG, "a proof of any depth is accepted"),
    ("no-pool-bound", "src/EarlierGrants.sol", "if (sum > total) revert OverPool();", "", EG, "the rows claimed can pass the pool"),
    ("no-min-row", "src/EarlierGrants.sol", "if (amount < MIN_ROW) revert RowTooSmall();", "", EG, "a row below one Share is not refused for its size"),
    ("claim-bind-twice", "src/EarlierGrants.sol", "if (address(vester) != address(0)) revert AlreadyBound();", "", EG, "the claim contract can be tied to another Vester"),
    ("claim-bind-anyone", "src/EarlierGrants.sol", "if (msg.sender != launcher) revert NotLauncher();", "", EG, "anyone can tie the claim contract to a Vester"),
    ("acceptance-overwritten", "src/EarlierGrants.sol", "if (acceptedAt[msg.sender] == 0) acceptedAt[msg.sender] = uint64(block.timestamp);", "acceptedAt[msg.sender] = uint64(block.timestamp);", EG, "a later claim overwrites the first acceptance"),
    ("no-acceptance", "src/EarlierGrants.sol", "if (acceptedAt[msg.sender] == 0) acceptedAt[msg.sender] = uint64(block.timestamp);", "", EG, "the acceptance is not recorded"),
    ("grant-to-other", "src/EarlierGrants.sol", "grantId = v.grant(msg.sender, amount, true);", "grantId = v.grant(address(uint160(index + 1)), amount, true);", EG, "the grant goes to someone other than the row's account"),
    ("reserve-ignored", "src/Vester.sol", "if (team.balanceOf(address(this)) < committed + earlierReserve + amount) revert NotFunded();", "if (team.balanceOf(address(this)) < committed + amount) revert NotFunded();", EV, "an ordinary grant can spend the earlier backers' reserve"),
    ("reserve-burned-after-wind-down", "src/Vester.sol", "uint256 kept = committed + earlierReserve; // the earlier backers' reserve is never burned", "uint256 kept = committed; // the earlier backers' reserve is never burned", EV, "the ungranted burn after a wind-down burns the reserve too"),
    ("start-at-claim", "src/Vester.sol", "(protected_, start) = (true, earlierStart);", "(protected_, start) = (true, block.timestamp);", EV, "an earlier grant's clock starts at the claim, not at the project's birth"),
    ("cliff-on-protected", "src/Vester.sol", "if (!g.protected_ && _elapsed(g) < CLIFF_MULT * treasury.unit()) return 0;", "if (_elapsed(g) < CLIFF_MULT * treasury.unit()) return 0;", EV, "a protected grant has a cliff"),
    ("protected-uses-ordinary-cap", "src/Vester.sol", "if (prot >= MAX_PROTECTED_PER_MEMBER) revert TooManyGrants();", "if (_ids[member].length >= MAX_GRANTS_PER_MEMBER) revert TooManyGrants();", EV, "the runner can fill a listed account's grant slots and lock it out of its claim"),
    ("no-protected-cap", "src/Vester.sol", "if (prot >= MAX_PROTECTED_PER_MEMBER) revert TooManyGrants();", "", EV, "an account can claim without limit (the hand-over trim is unbounded)"),
    ("ordinary-ignores-protected-count", "src/Vester.sol", "if (_ids[member].length - prot >= MAX_GRANTS_PER_MEMBER) revert TooManyGrants();", "if (_ids[member].length >= MAX_GRANTS_PER_MEMBER) revert TooManyGrants();", EV, "earlier grants use up an account's ordinary slots"),
    ("earlier-grant-by-anyone", "src/Vester.sol", "if (!early && msg.sender != address(treasury)) revert NotAllowed();", "", EV, "anyone can grant Team Shares"),
    ("reserve-not-spent", "src/Vester.sol", "earlierReserve = reserve - amount;", "", EV, "an earlier grant leaves the reserve whole, so the same Shares can be granted twice"),
    ("funded-lower-bound", "src/Vester.sol", "if (team_.balanceOf(address(this)) != funded) revert NotFunded();", "if (team_.balanceOf(address(this)) < funded) revert NotFunded();", EV, "the Vester accepts a pool larger than the one it was told"),
    ("earlier-bound-by-anyone", "src/Launcher.sol", "function bindEarlier(address earlier_) external {\n        if (msg.sender != deployer) revert NotDeployer();", "function bindEarlier(address earlier_) external {", EL, "anyone can bind a claim contract"),
    ("bind-earlier-twice", "src/Launcher.sol", "if (earlier != address(0) || block.timestamp > uint256(deployedAt) + 1 hours) revert BindClosed();", "if (block.timestamp > uint256(deployedAt) + 1 hours) revert BindClosed();", EL, "the claim contract can be bound again"),
    ("bind-earlier-after-hour", "src/Launcher.sol", "if (earlier != address(0) || block.timestamp > uint256(deployedAt) + 1 hours) revert BindClosed();", "if (earlier != address(0)) revert BindClosed();", EL, "a stolen key can bind a claim contract at any time"),
    ("bind-after-launch", "src/Launcher.sol", "if (_projects[k].treasury != address(0)) revert BindClosed();", "", EL, "the claim contract is bound after project zero launched, which could never have its reserve"),
    ("earlier-wrong-launcher", "src/Launcher.sol", "if (earlier_.code.length == 0 || IEarlierGrants(earlier_).launcher() != address(this)) revert BadStack();", "if (earlier_.code.length == 0) revert BadStack();", EL, "a claim contract made for another Launcher is accepted"),
    ("launch-no-earlier-bind", "src/Launcher.sol", "            IEarlierGrants(claims).bind(vester);\n", "", EL, "project zero is launched with a reserve its claim contract is not tied to"),
    ("launch-key-ignored", "src/Launcher.sol", "if (claims != address(0) && key == earlierKey) earlierPool", "if (claims != address(0)) earlierPool", EL, "every project is born with the earlier backers' reserve"),
    ("launch-pool-unfunded", "src/Launcher.sol", "                vester,\n                terms.teamPool + earlierPool\n", "                vester,\n                terms.teamPool\n", EL, "the reserve is not minted with the Team pool"),
    ("no-earlier-funded-event", "src/Launcher.sol", "            emit EarlierPoolFunded(key, vester, earlierPool);\n", "", EL, "the launch does not announce the reserve"),
    ("settings-hash-no-earlier", "src/Launcher.sol", "if (claims != address(0)) return keccak256(abi.encode(platform, pause, claims));", "", EL, "the founder's settings hash does not cover the claim contract"),
    # ---- the Council round (docs/next-version/COUNCIL-PLAN.md, K1): the Council, Pair, Treasury, Launcher and settings-hash tests must notice
    ("council-threshold-two", "src/Council.sol", "uint8 public constant THRESHOLD = 3;", "uint8 public constant THRESHOLD = 2;", CO, "two seats are enough to run a call"),
    ("council-seats-six", "src/Council.sol", "uint8 public constant SEATS = 5;", "uint8 public constant SEATS = 4;", CO, "a Council has four seats"),
    ("council-no-generation", "src/Council.sol", "        if (p.generation != generation) revert SeatsChanged();\n        if (block.timestamp > uint256(p.at) + PROPOSAL_TTL) revert Expired();", "        if (block.timestamp > uint256(p.at) + PROPOSAL_TTL) revert Expired();", CO, "an agreement given before a seat changed hands still counts"),
    ("council-withdraw-no-generation", "src/Council.sol", "        if (p.generation != generation) revert SeatsChanged();\n        uint8 bit = uint8(1 << i);\n        if (p.mask & bit == 0) revert NotAllowed();", "        uint8 bit = uint8(1 << i);\n        if (p.mask & bit == 0) revert NotAllowed();", CO, "a proposal of an older generation can be taken back"),
    ("council-no-expiry", "src/Council.sol", "        if (block.timestamp > uint256(p.at) + PROPOSAL_TTL) revert Expired();", "", CO, "a proposal never runs out"),
    ("council-expiry-inclusive", "src/Council.sol", "if (block.timestamp > uint256(p.at) + PROPOSAL_TTL) revert Expired();", "if (block.timestamp >= uint256(p.at) + PROPOSAL_TTL) revert Expired();", CO, "a proposal runs out one second early"),
    ("council-ttl-wrong", "src/Council.sol", "PROPOSAL_TTL = PROPOSAL_UNITS * uint256(u);", "PROPOSAL_TTL = PROPOSAL_UNITS * uint256(u) + 1 days;", CO, "a proposal lives longer than two time units"),
    ("council-withdraw-ignored", "src/Council.sol", "        p.mask &= ~bit;\n", "", CO, "taking an agreement back leaves it counted"),
    ("council-withdraw-nonagreed", "src/Council.sol", "        if (p.mask & bit == 0) revert NotAllowed();", "", CO, "a seat that did not agree can take another's agreement back"),
    ("council-withdraw-no-cancel", "src/Council.sol", "        if (p.mask == 0) {\n            delete proposals[id];\n            emit Cancelled(id);\n        } else {\n            proposals[id] = p;\n        }", "        proposals[id] = p;", CO, "a proposal with no agreement left stays and says nothing"),
    ("council-any-selector", "src/Council.sol", "        if (target == address(treasury)) {\n            if (sel == Treasury.handOver.selector)", "        if (target == address(treasury)) {\n            if (sel != bytes4(0)) return true;\n            if (sel == Treasury.handOver.selector)", CO, "every call to the Treasury is on the list"),
    ("council-list-launcher-any", "src/Council.sol", "return target == launcher && sel == ILauncherWindDown.windDown.selector;", "return target == launcher;", CO, "every Launcher call is on the list"),
    ("council-handover-trim-allowed", "src/Council.sol", "return data.length == 68 && uint256(bytes32(data[36:68])) == 0;", "return data.length == 68;", CO, "a hand-over that trims the founder is on the list (killed at propose)"),
    ("council-forfeit-allowed", "src/Council.sol", "|| sel == Treasury.revokeAgent.selector || sel == Treasury.windDown.selector;", "|| sel == Treasury.revokeAgent.selector || sel == Treasury.windDown.selector\n                || sel == Treasury.announceForfeit.selector;", CO, "a forfeit without the member's say is on the list (killed at propose)"),
    ("council-propose-list-missing", "src/Council.sol", "        if (!listed(target, data)) revert BadCall();\n", "", CO, "propose accepts any call"),
    ("council-propose-target-missing", "src/Council.sol", "        if (target != address(treasury) && target != launcher) revert BadTarget();\n", "", CO, "propose accepts any target (killed by the list too: the table covers it)"),
    ("council-propose-seat-only", "src/Council.sol", "        uint8 i = _indexOf(msg.sender);\n        if (i == NONE) revert NotAllowed();\n        if (target != address(treasury)", "        uint8 i = _indexOf(msg.sender);\n        if (target != address(treasury)", CO, "anyone proposes"),
    ("council-agree-seat-only", "src/Council.sol", "        uint8 i = _indexOf(msg.sender);\n        if (i == NONE) revert NotAllowed();\n        bytes32 id = callId(target, data, n);", "        uint8 i = _indexOf(msg.sender);\n        bytes32 id = callId(target, data, n);", CO, "anyone agrees"),
    ("council-agree-twice", "src/Council.sol", "        if (p.mask & bit != 0) revert AlreadyAgreed();", "", CO, "a seat's agreement counts again and again"),
    ("council-no-delete-on-run", "src/Council.sol", "        delete proposals[id];\n        _executing = true;", "        _executing = true;", CO, "the record is kept after the third agreement: seats four and five run the call again"),
    ("council-no-reentry-guard", "src/Council.sol", "        if (_executing) revert Reentrancy();\n", "", CO, "a seat that is paid by a call can agree to another inside it"),
    ("council-failed-call-swallowed", "src/Council.sol", "        if (!ok) {\n            assembly (\"memory-safe\") {\n                revert(add(result, 0x20), mload(result))\n            }\n        }\n        emit Executed(id, msg.sender);", "        emit Executed(id, msg.sender);", CO, "a call that failed is called run and its record is gone"),
    ("council-bothsigned-always", "src/Council.sol", "        return _executing;", "        return true;", CO, "the Council always looks as if its seats agreed"),
    ("council-init-sender", "src/Council.sol", "if (launcher != address(0) || msg.sender != launcher_) revert BadSetup();", "if (launcher != address(0)) revert BadSetup();", CO, "anyone can set a clone up"),
    ("council-init-vote-missing", "src/Council.sol", "        vote = treasury_.pauseGate();\n", "", CO, "a Council does not know its vote contract"),
    ("council-double-seat", "src/Council.sol", "                if (members[i] == members[j]) revert BadSetup();", "", CO, "one account holds two seats of a new Council"),
    ("council-zero-seat", "src/Council.sol", "            if (members[i] == address(0)) revert BadSetup();", "", CO, "the zero address is a seat of a new Council"),
    ("council-seat-anyone", "src/Council.sol", "        if (msg.sender != vote || msg.sender == address(0)) revert NotAllowed();", "", CS, "anyone opens an election or puts winners in seats"),
    ("council-vote-zero", "src/Council.sol", "        if (msg.sender != vote || msg.sender == address(0)) revert NotAllowed();", "        if (msg.sender != vote) revert NotAllowed();", CS, "with no vote contract, the zero address is the vote"),
    ("council-isseat-zero", "src/Council.sol", "        if (a == address(0)) return NONE;\n", "", CO, "the zero address, which an open seat is stored as, is a seat"),
    ("council-election-not-due", "src/Council.sol", "        if (block.timestamp < nextElection) revert NotDue(nextElection);", "", CS, "an election can be opened at any time"),
    ("council-election-from-schedule", "src/Council.sol", "        nextElection = uint64(block.timestamp + ELECTION_UNITS * uint256(unit));\n        _emitSeats();\n    }", "        nextElection = uint64(uint256(nextElection) + ELECTION_UNITS * uint256(unit));\n        _emitSeats();\n    }", CS, "a late election makes the next one early"),
    ("council-election-units", "src/Council.sol", "uint256 public constant ELECTION_UNITS = 26;", "uint256 public constant ELECTION_UNITS = 25;", CO, "two seats come up every 25 time units"),
    ("council-up-open-not-first", "src/Council.sol", "uint48 l = _seats[i].who == address(0) ? 0 : _seats[i].lastUp;", "uint48 l = _seats[i].lastUp;", CS, "an open seat that came up and was not filled is not first again"),
    ("council-up-tie-higher", "src/Council.sol", "            if (l < la) {", "            if (l <= la) {", CS, "a tie goes to the higher seat number"),
    ("council-up-lastup-not-set", "src/Council.sol", "        _seats[upA].lastUp = nowAt;\n        _seats[upB].lastUp = nowAt;\n", "", CS, "the two seats' time is not moved on at opening, so the same two come up again"),
    ("council-seat-wrong-seat", "src/Council.sol", "                (s, loTaken) = (lo, true);", "                (s, loTaken) = (hi, true);", CS, "a new winner takes the higher seat first"),
    ("council-seat-incumbent-moved", "src/Council.sol", "            if (at == lo) {\n                (loTaken, placed[k]) = (true, true);", "            if (false) {\n                (loTaken, placed[k]) = (true, true);", CS, "a winner who holds one of the two seats is treated as new"),
    ("council-seat-already-seated", "src/Council.sol", "            } else if (at != NONE) {\n                revert AlreadySeated(w[k]);\n            }", "            }", CS, "a winner who holds a seat that is not up gets a second seat"),
    ("council-seat-same-winner", "src/Council.sol", "        if (winnerA != address(0) && winnerA == winnerB) revert BadSeat();\n", "", CS, "the same winner named twice takes both seats"),
    ("council-seat-up-equal", "src/Council.sol", "if (upA >= SEATS || upB >= SEATS || upA == upB) revert BadSeat();", "if (upA >= SEATS || upB >= SEATS) revert BadSeat();", CS, "the same seat named as both seats that are up"),
    ("council-seat-generation-missing", "src/Council.sol", "        if (changed) {\n            ++generation;", "        if (changed) {", CS, "a seat changes hands and older proposals live on"),
    ("council-resign-no-generation", "src/Council.sol", "        ++generation;\n        emit Resigned(i, msg.sender);", "        emit Resigned(i, msg.sender);", CO, "a resigned seat's agreements live on"),
    ("council-withdrawn-count-missing", "src/Council.sol", "emit Withdrawn(id, msg.sender, _count(p.mask));", "emit Withdrawn(id, msg.sender, 0);", CE, "the event of a taken-back agreement does not carry the count after it (a ledger of events cannot rebuild it)"),
    ("pair-isseat-second-missing", "src/Pair.sol", "        return a == first || a == second;", "        return a == first;", CS, "a Pair's second signer is not a seat, so may take the tasks the Treasury bars"),
    ("treasury-teamseat-pair-only", "src/Treasury.sol", "        if (_kind(r) == 0) return false;\n        return IPairSigners(r).isSeat(a);", "        if (!ILauncherPairs(salePath).isPair(r)) return false;\n        return IPairSigners(r).first() == a || IPairSigners(r).second() == a;", CS, "the five seats of a Council may take the tasks the Treasury bars (only a Pair's two signers are barred)"),
    ("treasury-runnerkind-true", "src/Treasury.sol", "        if (_kind(r) == 0) return true;\n        return IPair(r).bothSigned();", "        if (_kind(r) != 1) return true;\n        return IPair(r).bothSigned();", CA, "a Council as the runner needs no agreement of its seats at the Treasury"),
    ("treasury-forfeit-accepts-council", "src/Treasury.sol", "if (!_isRunnerBothSigned() || !ILauncherPairs(salePath).isPair(msg.sender)) revert NotAllowed();", "if (!_isRunnerBothSigned() || _kind(msg.sender) == 0) revert NotAllowed();", CA, "a Council can announce a forfeit (killed at the Treasury by a Council-like runner)"),
    ("treasury-founderagrees-accepts-council", "src/Treasury.sol", "        if (!ILauncherPairs(salePath).isPair(msg.sender)) return false;\n        return IPairSigners(msg.sender).first() == founder", "        if (_kind(msg.sender) == 0) return false;\n        return IPairSigners(msg.sender).first() == founder", CA, "a Council can mark \"founder leaves\" and trim the founder's grants (killed at the Treasury)"),
    ("treasury-seatbyvote-anyone", "src/Treasury.sol", "if (g == address(0) || msg.sender != g || _kind(council) != 2) revert NotAllowed();", "if (g == address(0) || _kind(council) != 2) revert NotAllowed();", SV, "anyone moves the runner seat to a Council"),
    ("treasury-seatbyvote-zero-gate", "src/Treasury.sol", "if (g == address(0) || msg.sender != g || _kind(council) != 2) revert NotAllowed();", "if (msg.sender != g || _kind(council) != 2) revert NotAllowed();", SV, "a project with no gate can be moved by the zero address"),
    ("treasury-seatbyvote-any-address", "src/Treasury.sol", "if (g == address(0) || msg.sender != g || _kind(council) != 2) revert NotAllowed();", "if (g == address(0) || msg.sender != g) revert NotAllowed();", SV, "the vote seats any address, not only a Council the Launcher made"),
    ("treasury-seatbyvote-keeps-agents", "src/Treasury.sol", "        ++agentEpoch;\n        emit RunnerChanged(from, to);", "        emit RunnerChanged(from, to);", SV, "the old runner's helpers work under the new runner"),
    ("treasury-seatbyvote-keeps-offer", "src/Treasury.sol", "(runner, pendingRunner, pendingTrim, pendingSeatAt) = (to, address(0), false, 0);", "(runner, pendingTrim, pendingSeatAt) = (to, false, 0);", SV, "an offer the old runner made to a puppet survives the vote"),
    ("treasury-seatbyvote-keeps-rate", "src/Treasury.sol", "        (pendingRatePpm, pendingAt) = (0, 0);\n        _seat(council, false);", "        _seat(council, false);", SV, "a rate the old runner proposed reaches the new Council"),
    ("treasury-takeseat-clears-rate", "src/Treasury.sol", "        _seat(msg.sender, pendingTrim);", "        (pendingRatePpm, pendingAt) = (0, 0);\n        _seat(msg.sender, pendingTrim);", SV, "a plain hand-over clears a pending rate (a money rule that changed)"),
    ("launcher-bindcouncil-anyone", "src/Launcher.sol", "function bindCouncil(address impl) external {\n        if (msg.sender != deployer) revert NotDeployer();", "function bindCouncil(address impl) external {", LC, "anyone can turn the Council on"),
    ("launcher-bindcouncil-twice", "src/Launcher.sol", "if (councilBound || block.timestamp > uint256(deployedAt) + 1 hours) revert BindClosed();", "if (block.timestamp > uint256(deployedAt) + 1 hours) revert BindClosed();", LC, "the Council can be bound again"),
    ("launcher-bindcouncil-after-hour", "src/Launcher.sol", "if (councilBound || block.timestamp > uint256(deployedAt) + 1 hours) revert BindClosed();", "if (councilBound) revert BindClosed();", LC, "a stolen key can turn the Council on at any time"),
    ("launcher-bindcouncil-no-pause", "src/Launcher.sol", "if (impl.code.length == 0 || holderPauseImpl == address(0)) revert BadStack();", "if (impl.code.length == 0) revert BadStack();", LC, "a Council can be bound with no pause beside it"),
    ("launcher-bindcouncil-needs-code", "src/Launcher.sol", "if (impl.code.length == 0 || holderPauseImpl == address(0)) revert BadStack();", "if (holderPauseImpl == address(0)) revert BadStack();", LC, "an address with no code can be bound"),
    ("launcher-makecouncil-no-switch", "src/Launcher.sol", "    function makeCouncil(bytes32 key, address[5] calldata members, bytes32 salt) external returns (address council) {\n        if (!councilBound) revert NoCouncil();", "    function makeCouncil(bytes32 key, address[5] calldata members, bytes32 salt) external returns (address council) {", LC, "a Council can be made with the switch off"),
    ("launcher-makecouncil-kind", "src/Launcher.sol", "        runnerKindOf[council] = 2;\n        Council(council).initialize(ITreasuryRunner(p.treasury), address(this), members, true);", "        runnerKindOf[council] = 1;\n        Council(council).initialize(ITreasuryRunner(p.treasury), address(this), members, true);", LC, "a Council is registered as a Pair"),
    ("launcher-council-salt-members", "src/Launcher.sol", "return keccak256(abi.encode(key, \"council\", members, salt));", "return keccak256(abi.encode(key, \"council\", salt));", LC, "the Council's address does not commit to its five accounts"),
    ("launcher-council-member-project-account", "src/Launcher.sol", "        for (uint256 i; i < 5; ++i) {\n            if (_isProjectAccount(p, members[i])) revert BadSeatHolder(members[i]);\n        }\n        council = impl.cloneDeterministic(_councilSalt(key, members, salt));", "        for (uint256 i; i < 5; ++i) {\n        }\n        council = impl.cloneDeterministic(_councilSalt(key, members, salt));", LC, "a project account is accepted as a seat"),
    ("launcher-isprojectaccount-runner", "src/Launcher.sol", " || runnerKindOf[who] != 0;", ";", LC, "a runner contract can be a seat"),
    ("launcher-isprojectaccount-tasks", "src/Launcher.sol", " || who == address(Treasury(p.treasury).tasks())", "", LC, "the project's task queue can be a seat"),
    ("launcher-isprojectaccount-gate", "src/Launcher.sol", " || who == Treasury(p.treasury).pauseGate()", "", LC, "the project's pause can be a seat"),
    ("launcher-isprojectaccount-impl", "src/Launcher.sol", "\n            || who == councilImpl", "", LC, "the Council implementation can be a seat"),
    ("launcher-windDown-council-bypass", "src/Launcher.sol", "(runnerKindOf[runner] != 0 && !IPair(runner).bothSigned())", "(runnerKindOf[runner] == 1 && !IPair(runner).bothSigned())", LC, "a Council-kind runner winds a project down without its seats' agreement"),
    ("settingshash-council-missing", "src/Launcher.sol", "        if (pause != address(0) && councilBound) return keccak256(abi.encode(platform, pause, claims, councilImpl));\n", "", LC, "the founder's settings hash does not cover the Council switch"),
    ("settingshash-council-after-claims", "src/Launcher.sol", "        if (pause != address(0) && councilBound) return keccak256(abi.encode(platform, pause, claims, councilImpl));\n        if (claims != address(0)) return keccak256(abi.encode(platform, pause, claims));", "        if (claims != address(0)) return keccak256(abi.encode(platform, pause, claims));\n        if (pause != address(0) && councilBound) return keccak256(abi.encode(platform, pause, claims, councilImpl));", LC, "with claims and a Council bound the hash has no Council in it (the Council test is after the claims branch)"),
    ("settingshash-council-no-claims", "src/Launcher.sol", "keccak256(abi.encode(platform, pause, claims, councilImpl))", "keccak256(abi.encode(platform, pause, councilImpl))", LC, "the fourth form leaves the claim contract out"),
    # ---- the Council round, part 2 (K2): the vote's counting, results, fates and the Launcher's vote path
    ('snapshot-missing', 'src/HolderVote.sol', '        if (uint32(s >> 96) == id) return uint96(s);\n        return parkedOf[who];', '        return parkedOf[who];', 'test/HolderVoteCount.t.sol', 'a park after the ballot opened counts (the snapshot is not kept)'),
    ('low-not-min', 'src/HolderVote.sol', '        if (newParked < low) {', '        if (newParked < low && false) {', 'test/HolderVoteCount.t.sol', 'an unpark does not lower the fewest-since-snapshot, so a re-park restores the weight'),
    ('fall-not-applied', 'src/HolderVote.sol', '        _cast[id] -= fall;\n        _tally[id][option] -= fall;', '', 'test/HolderVoteAttacks.t.sol', 'a Share taken back during the vote stays counted in the tallies'),
    ('hook-after-end', 'src/HolderVote.sol', 'if (id != 0 && block.timestamp >= ballots[id].voteEnd) return 0;', 'if (id != 0 && block.timestamp >= type(uint64).max) return 0;', 'test/HolderVoteBoundary.t.sol', 'the hooks and castVote run after voteEnd, so the tallies are not frozen'),
    ('floor-low', 'src/HolderVote.sol', 'uint256 floor = Math.ceilDiv(supply, LINE_DIVISOR);', 'uint256 floor = Math.ceilDiv(supply, LINE_DIVISOR + 1);', 'test/HolderVoteResults.t.sol', 'the turnout floor is a quarter, not a third'),
    ('floor-not-snapshot', 'src/HolderVote.sol', 'if (cast < b.floor) return (OUTCOME_SHORT, 0, 0);', 'if (cast < Math.ceilDiv(shares.totalSupply(), LINE_DIVISOR)) return (OUTCOME_SHORT, 0, 0);', 'test/HolderVoteResults.t.sol', 'the floor is read at the result, not at the snapshot (a late buyer can raise it)'),
    ('majority-half-inclusive', 'src/HolderVote.sol', 'if (_tally[id][i] * 2 > cast) return (OUTCOME_MOVED, i, 0);', 'if (_tally[id][i] * 2 >= cast) return (OUTCOME_MOVED, i, 0);', 'test/HolderVoteResults.t.sol', 'exactly half of the cast Shares moves the seat'),
    ('seat-beats-keep-inclusive', 'src/HolderVote.sol', 'if (t < MIN_VOTE || t <= keep) continue;', 'if (t < MIN_VOTE || t < keep) continue;', 'test/HolderVoteResults.t.sol', 'a person tied with keep takes the seat'),
    ('keep-missing-in-seats', 'src/HolderVote.sol', 'uint256 keep = _tally[id][0];', 'uint256 keep;', 'test/HolderVoteResults.t.sol', 'keep is not counted against a person in a seat election'),
    ('opener-list-missing', 'src/HolderVote.sol', '        _standList(id, ballots[id], members, recordHash, msg.sender);\n', '', 'test/HolderVote.t.sol', 'a replace ballot opens with nothing to choose between'),
    ('displace-by-wrong-end', 'src/HolderVote.sol', '                if (s < smallest) {', '                if (s > smallest) {', 'test/HolderVoteAttacks.t.sol', 'a larger stake displaces by the wrong end (the largest place, not the smallest)'),
    ('displace-on-equal', 'src/HolderVote.sol', 'if (w <= smallest) revert NoRoom();', 'if (w < smallest) revert NoRoom();', 'test/HolderVoteAttacks.t.sol', 'an equal stake displaces the smallest place'),
    ('cooldown-after-short', 'src/HolderVote.sol', 'if (b.kind == KIND_REPLACE && o == OUTCOME_KEPT && _cast[id] >= b.floor) {', 'if (b.kind == KIND_REPLACE && (o == OUTCOME_KEPT || o == OUTCOME_SHORT) && _cast[id] >= b.floor) {', 'test/HolderVoteResults.t.sol', 'a ballot that fell short starts the replace cooldown'),
    ('cooldown-after-moved', 'src/HolderVote.sol', 'if (b.kind == KIND_REPLACE && o == OUTCOME_KEPT && _cast[id] >= b.floor) {', 'if (b.kind == KIND_REPLACE && (o == OUTCOME_KEPT || o == OUTCOME_MOVED) && _cast[id] >= b.floor) {', 'test/HolderVoteResults.t.sol', 'a ballot that moved the seat starts the replace cooldown'),
    ('cooldown-missing', 'src/HolderVote.sol', '        if (b.kind == KIND_REPLACE && o == OUTCOME_KEPT && _cast[id] >= b.floor) {\n            uint64 until = uint64(uint256(b.voteEnd) + COOLDOWN_UNITS * _unit());\n            if (until > nextReplaceAt) nextReplaceAt = until;\n        }\n', '', 'test/HolderVoteResults.t.sol', 'a kept replace ballot with the floor met leaves no cooldown'),
    ('wait-zero', 'src/HolderVote.sol', 'uint64 effectiveAt = uint64(uint256(voteEnd) + wait);', 'uint64 effectiveAt = voteEnd;', 'test/HolderVoteResults.t.sol', 'a won result takes effect at voteEnd (no wait)'),
    ('carryout-before-effective', 'src/HolderVote.sol', '        if (block.timestamp < b.effectiveAt) revert TooEarly(b.effectiveAt);\n', '', 'test/HolderVoteBoundary.t.sol', 'a won result is carried out before its wait is over'),
    ('open-floor-missing', 'src/HolderVote.sol', '        if (parkedTotal * OPEN_DIVISOR < supply) revert NotEligible();\n', '', 'test/HolderVoteAttacks.t.sol', 'a replace vote opens without the parked fifth'),
    ('stand-stake-missing', 'src/HolderVote.sol', 'if (_weightNow(id, msg.sender) * STAND_DIVISOR < b.supply) revert NotEligible();', '', 'test/HolderVoteAttacks.t.sol', 'a person stands with no stake at all'),
    ('min-vote-missing', 'src/HolderVote.sol', 'if (w < MIN_VOTE) revert NotEligible();', '', 'test/HolderVoteCount.t.sol', 'a dust account can cast (and fill the logs)'),
    ('list-duplicate-members', 'src/HolderVote.sol', '            for (uint256 j = i + 1; j < 5; ++j) {\n                if (members[i] == members[j]) revert BadMembers();\n            }\n', '', 'test/HolderVoteAttacks.t.sol', 'a list may name the same account twice'),
    ('list-project-account', 'src/HolderVote.sol', '            if (launcher.isProjectAccount(key, members[i])) revert ProjectAccount();\n', '', 'test/HolderVoteAttacks.t.sol', 'a project account can be on a list'),
    ('double-seat-winner', 'src/HolderVote.sol', '        if (_stood[msg.sender] == id) revert AlreadyStood();\n', '', 'test/HolderVoteResults.t.sol', 'one account stands twice in a seat ballot and can take both seats'),
    ('winner-takes-wrong-seat', 'src/HolderVote.sol', 'ICouncilVote(b.council).seat(b.upA, b.upB, _seatWinner(id, b.winner), _seatWinner(id, b.winnerB));', 'ICouncilVote(b.council).seat(b.upA, b.upB, _seatWinner(id, b.winnerB), _seatWinner(id, b.winner));', 'test/HolderVoteResults.t.sol', 'the second winner takes the lower seat'),
    ('tie-takes-the-seat', 'src/HolderVote.sol', 'if (secondAt != 0 && second < best) return (OUTCOME_SEATED, bestAt, secondAt);', 'if (secondAt != 0 && second <= best) return (OUTCOME_SEATED, bestAt, secondAt);', 'test/HolderVoteResults.t.sol', 'a tie for the last seat takes it'),
    ('finish-twice', 'src/HolderVote.sol', '        if (b.finished) revert AlreadyFinished();\n', '', 'test/HolderVoteBoundary.t.sol', "a ballot's result can be recorded twice"),
    ('lapse-early', 'src/HolderVote.sol', '        if (!late && !wound && !councilGone) revert NotLapsable();\n', '', 'test/HolderVoteBoundary.t.sol', 'a won result can be let go before it is due'),
    ('late-stand', 'src/HolderVote.sol', '        if (b.kind != KIND_SEATS) revert BadKind();\n        if (block.timestamp >= b.standEnd) revert StandingClosed();', '        if (b.kind != KIND_SEATS) revert BadKind();', 'test/HolderVoteBoundary.t.sol', 'names may be put forward after the stand window'),
    ('vote-before-standend', 'src/HolderVote.sol', '        if (block.timestamp < b.standEnd) revert VotingClosed();\n', '', 'test/HolderVoteBoundary.t.sol', 'a ballot is voted in before the stand window closes'),
    ('vote-at-voteend', 'src/HolderVote.sol', 'if (id != 0 && block.timestamp >= ballots[id].voteEnd) return 0;', 'if (id != 0 && block.timestamp > ballots[id].voteEnd) return 0;', 'test/HolderVoteBoundary.t.sol', 'a vote cast in the second the ballot ends still counts'),
    ('cast-twice-overcounts', 'src/HolderVote.sol', '            _tally[id][fromOption] = fromTally;\n            _cast[id] -= old;\n', '', 'test/HolderVoteCount.t.sol', 'a moved vote leaves its old weight counted (the cast total doubles)'),
    ('voted-from-fields-missing', 'src/HolderVote.sol', 'emit Voted(id, msg.sender, option, w, t, _cast[id], fromOption, fromTally);', 'emit Voted(id, msg.sender, option, w, t, _cast[id], 255, 0);', 'test/VoteEventsRebuild.t.sol', 'the event does not carry the option the vote left (a ledger cannot rebuild a moved vote)'),
    ('carryout-not-atomic', 'src/HolderVote.sol', '            treasury.seatByVote(council);\n', '', 'test/HolderVoteAttacks.t.sol', 'a replace result makes the Council but never seats it (half the change)'),
    ('bind-project-twice', 'src/HolderVote.sol', '        if (address(treasury) != address(0)) revert AlreadyBound();\n', '', 'test/DeployVoteSettings.t.sol', 'a vote clone can be bound to a second project'),
    ('vote-salt-missing', 'src/Launcher.sol', 'return keccak256(abi.encode(key, "council-vote", members, ballotId));', 'return keccak256(abi.encode(key, "council-vote", members));', 'test/LauncherVote.t.sol', "the vote path's address does not commit to the ballot, so the same five cannot be elected twice"),
    ('isvote-missing', 'src/Launcher.sol', '        (bool ok, bytes memory ret) = holderPauseImpl.staticcall(abi.encodeCall(IHolderVote.isVote, ()));\n        if (!ok || !abi.decode(ret, (bool))) revert NotVote();\n', '', 'test/LauncherVote.t.sol', 'a Council is bound beside a plain pause (no vote contract to elect or replace it)'),
    ('hook-underflow-unchecked', 'src/HolderVote.sol', '        _cast[id] -= fall;\n        _tally[id][option] -= fall;', '        unchecked {\n            _cast[id] -= fall;\n            _tally[id][option] -= fall;\n        }', 'test/HolderVoteAttacks.t.sol', 'the hook checked-subtracts; the guard is the invariant that a tally is the sum of the weights cast on it', 'never reachable: `fall` is `w - low`; `w` is the weight cast on this option and the invariant that the tallies add up to the cast total holds on every handler step, so the tally is at least `w`; `unchecked` changes no reachable behaviour.'),
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
        # with --only, only the tests those mutations name are copied (the compile of the whole suite is the slow part)
        keep_tests = {"ModelVectors.t.sol"} | {os.path.basename(m[4]) for m in MUTATIONS}
        if only:
            keep_tests = {os.path.basename(m[4]) for m in MUTATIONS if m[0] in only}
        os.makedirs(os.path.join(work, "test"))
        for sub in ("helpers", "mocks"):
            shutil.copytree(os.path.join(POT, "test", sub), os.path.join(work, "test", sub))
        for name in keep_tests:
            # --check reads the sources only; a mutation that names a test file not written yet still applies its text check
            path = os.path.join(POT, "test", name)
            if os.path.exists(path):
                shutil.copy(path, os.path.join(work, "test", name))
        env = dict(os.environ, FOUNDRY_INVARIANT_RUNS="64")
        baseline = ["forge", "test"] if only else ["forge", "test", "--match-path", "test/ModelVectors.t.sol"]
        first = None if check_only else run(baseline, work, env, wait)
        if first is not None and first.returncode != 0:
            print("the unchanged copy does not pass its own tests:\n" + first.stdout[-3000:] + first.stderr[-2000:])
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
