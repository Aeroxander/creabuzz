# Step 2 report: the task queue and the exit notes (contracts only)

Branch `step2` of the working copy of `contracts/pot`, 19 November 2026. Build step 2 of
`docs/next-version/JOIN-LEAVE-DESIGN.md` section 8, **contracts only**: the task queue (announce, notice, take, accept, reject,
cancel, return), the caps, the never-reused serial, and the exit notes with their claim. Built in two passes on top of the step 1
contracts: pass A (the queue, the Treasury wiring, the step 1 leftovers) and pass B (exit notes, their claim, the reference model,
the invariants, the mutation list, the chain loop, this report). Nothing is pushed and no network has these contracts. The server and
the app are not part of this step (they are being finished against the step 1 contracts; section 6 says what they read and call
next). This is not legal or tax advice, and no figure here is a promise of any result for anyone. The first public launch is a
test network with play dollars: every number below is play money.

**Status.** Everything in the scope of S1 to S7 is built and green: `forge fmt --check src script test` clean; `forge build` green;
`forge test`: **50 suites, 506 tests passed, 0 failed, 0 skipped** (the 339 step 1 tests are all still there by name, and none
of their assertions was loosened; section 3 lists the step 1 files that were edited and why); the new fuzz tests at 20,000 runs
and the invariants at 1,000 runs of 200 steps; `scripts/check-vectors.sh` current (83 scenarios); the mutation script: **118
mutations, 117 killed, 1 equivalent mutant proved never to change behaviour** (no survivor); the chain loop on the real bytecode:
**24 checks passed** (17 of step 1, 7 new). Commits of pass B: `cdb773c`, `fbc141f`, `430b492`, `8e6a507`, `f8aa54a` and the commit
that adds this report (the earlier pass A commits are `fbe15d2`, `db3cb71`, `0144900`, `c2da39e`).

## 1. What is built

| Part | Where | What |
|---|---|---|
| TaskBook | `src/TaskBook.sol` | One clone per project, holds no dollars, only the Treasury calls it. The queue: `announce`, `take` (notice, window, smaller-of, the rolling cap in an exact ring of 16 takes), `accept` / `reject` / `cancel`, `expireDue`, `sweepAll`, the numbers of every task (`Task`: set aside L, stayers' claim C, note face N, returned, held for notes), and (pass B) the notes: `mintNotes`, `claim`, `spreadSum`, `claimableNote`. Events `TaskAnnounced`, `TaskTaken`, `TaskResolved`, `NoteMinted`, `NoteClaimed`, each carrying the resulting state. |
| Treasury | `src/Treasury.sol` | `announceTask`, `takeTask`, `acceptTask`, `rejectTask`, `cancelTask`, `returnTask`, `claimNote`, `noticeFor`; the buckets `locked` (the stayers' claims on taken tasks) and `notesOwed`; expiry inside every settle (last, after the allowance and the release); a joiner's price and credit count the set-aside money at face; `quoteBack.lockedLine`; **notes written in `leave` and `leaveTeam`** and shown by `quoteTakeOut`; wind-down returns every open task. Events `TasksReady`, `TaskMoney` (kinds 1 to 6), `Left.note`, `TeamLeft.note`. |
| Launcher, Parts | `src/Launcher.sol`, `src/Parts.sol` | `Parts.tasksImpl`; `launch` clones and initialises a book before the Treasury (the `launch` return tuple and `ProjectLaunched` are unchanged). |
| Pair | `src/Pair.sol` | The proposal lifetime is two time units of the project, stored at `initialize` (S5d). The Pair has no selector table: the new money calls are runner-only in the Treasury, which demands both signers when the runner is a Pair. |
| Reference model | `model/pot_ext.py`, `model/gen_vectors.py`, `model/vectors.json` | Tasks, caps, expiry, notes and the one-ratio return in exact decimals; vectors format 2 with 83 scenarios (the 52 of step 1 unchanged). |
| Tests | `test/` | See section 3. |
| Chain loop | `scripts/pot-chain-loop.sh` | Walks a task through announce, the early take, the notice, take, a take-out that writes a note, accept in part, a claim by a stranger, and a second task that is returned by anyone after its deadline. |

The rules, all in calendar seconds (N is the time unit; 7 days on a real network): a task is announced by the runner (with a Pair:
both signers) for a named payee or for whoever takes it first, with a dollar maximum and a share of the pot of 1 to 500
ten-thousandths (at most 5%); moves no money; the notice is `2N + ceil(bps x N / 1400)` (14 days plus 12 hours per 1%); the take
window is `[noticeEnd, noticeEnd + N)`; the take sets aside `min(dollars, floor(share x settled pot))` out of the pot; it is due 2N
after the take; the cap counts `ceil(amount x 10,000 / pot)` and refuses a take that would pass 1,000 in any rolling 4N (28 days); at
most 8 tasks are open; the serial starts at 1 and is never reused.

Exit notes, as built: a holder who takes out while `locked` is not zero is paid cash on the pot without it and written a note
`min(cash(pot + locked) - cash(pot), locked)` (the Team formula for `leaveTeam`), spread over the taken tasks by their stayers'
claims, rounded down per task (the few units the floors leave stay with the stayers). For each taken task `C + N == L`. When a
task ends, the worker is paid first, and what is left (`rem = L - pay`) is split at ONE ratio: notes hold `floor(N x rem / L)`, the
pot gets the rest. A note is claimed with `claimNote(serial, holder)` by anyone, paid to the holder, `floor(note x rem / L)`; the
last claim sends the rounding left over to the pot. A task paid in full has no claimable note.

## 2. What pass B added to what pass A left

Pass A (commits `fbe15d2`, `db3cb71`, `0144900`, `c2da39e`) is the queue itself, the step 1 leftovers (S5 a to d), the size gate and
457 tests. Pass B:

| Commit | What |
|---|---|
| `cdb773c` | Exit notes and their claim: `mintNotes`, `claim`, `spreadSum`, `claimableNote` in the book; `claimNote`, the notes in `leave` and `leaveTeam` and the note of `quoteTakeOut` in the Treasury; `Notes.t.sol` (must-bind 8 through a real leave), `NotesMustBind.t.sol` (must-bind 1). |
| `fbc141f` | The handler's task steps, the task and note invariants, the shared event ledger (`helpers/TaskLedger.sol`), `NotesFuzz.t.sol`. |
| `430b492` | The reference model carries tasks and notes; vectors format 2 (83 scenarios); `ModelVectors` replays them. |
| `8e6a507` | The mutation list (85 to 118), more tests (spread rounding, the quote with one task run out and another still taken, the dust in the last claim's event, the book's refusal, a real Pair through the queue and a note), gas of notes. |
| `f8aa54a` | The chain loop (7 new checks), tolerance where the clock moves in two older checks, the README. |
| the last commit | This report; the 20,000-run fuzz settings of `NotesFuzz` (the inline run counts were removed so `FOUNDRY_FUZZ_RUNS` applies) and a guard in `NotesMustBind` found by the 20,000-run fuzz (see section 3). |

## 3. Measured

**Runtime sizes** (`forge build --sizes`; the limit is 24,576, the creation-code limit 49,152): **Treasury 23,577 (999 to spare;
it was 18,075 after step 1's review and 22,681 after pass A)**, TaskBook 10,057, Vester 7,355, Launcher 6,650, PlayDollar 3,497, ShareToken
2,823, Pair 2,519, Parts 437 with a creation code of **47,356 (1,796 to spare)**. The test-only `TreasuryHarness` is 23,967 (609 to
spare). `test/Size.t.sol` fails if the Treasury, the book or the Parts creation code passes its limit. The note code in the Treasury
cost 896 bytes and in the book 1,892; there is room for about one more small feature in the Treasury and none to spare in Parts: the
next addition to either goes to a new clone (the Launcher's constructor then takes the book's implementation directly instead of
through Parts), not into these two. The optimizer settings are untouched (solc 0.8.37, 200 runs, cancun, via IR).

**Contract lines** (`src/`, counted; "code" = not blank, not a comment): Treasury 1,037 / 718, TaskBook 510 / 368, Launcher 322 / 209,
Vester 302 / 196, Interfaces 146 / 74, Pair 133 / 79, ShareToken 122 / 76, PotMath 103 / 55, PlayDollar 53 / 29, RollingCap 46 / 25, Parts 33 / 18:
**2,807 lines, 1,847 code lines** in `src/` (step 1 had 1,944 and 1,257); `script/DeployPot.s.sol` 99 / 71. The tests are 50 Solidity
files plus 12 helpers and mocks, 11,881 lines; `model/pot_ext.py` 352, `model/gen_vectors.py` 803, `scripts/check-mutations.py` 277,
`scripts/pot-chain-loop.sh` 403.

**Tests.** `forge test` in `contracts/pot`: **50 suites, 506 tests passed, 0 failed, 0 skipped** (fuzz tests 1,000 runs unless stated;
invariants 256 runs of 200 steps). Pass A ended at 457; pass B adds 49: Notes 24, NotesMustBind 3, NotesFuzz 4, PairTasks 5, GasTasks +4,
PotInvariants +3, PotFuzz +1 (the handler reaches every task step), ModelVectors +5 chunks. Per suite: AccessMatrix 7, Agents 14,
Allowance 25, Arrival 5, EmptyJoin 3, Events 7, EventsRebuild 1, Expiry 10, Fees 5, Forfeit 15, Gas 5, GasTasks 8, Join 30, KnownGaps 1,
Launcher 21, Leave 11, LeaveTeam 7, ModelVectors 18, MustBind 3, Notes 24, NotesFuzz 4, NotesMustBind 3, OwnBurn 4, Pair 16, PairTasks 5,
PlayDollar 7, PotFuzz 4, PotInvariants 11, PotMath 8, Pragma 1, QuoteOffset 6, Quiet 11, Reentrancy 3, Revenue 16, RoundTripFuzz 1,
SettleFirst 5, ShareToken 10, Size 3, TaskBook 28, Tasks 44, TasksCaps 12, TasksExpiry 9, TasksRebuild 1, Team 4, Treasury 19, Vester 9,
VesterFuzz 1, VesterUnit 26, WindDown 11, Worked 4.

**Fuzz at 20,000 runs** (`FOUNDRY_FUZZ_RUNS=20000`): the four fuzz tests of `NotesFuzz` (pieces equal the whole to within a unit a
piece; a joiner who leaves at once while money is set aside gains nothing beyond the offset; a rejected task leaves the leaver where no
task would have; the stayers' claim and the notes add up to the task at every take-out): 20,000 runs each, all green, 20 seconds. The
cycled must-bind run as a fuzz (`testFuzz_mb1_notesNeverExceedTheMoneyReturned`, two cycles of eight tasks a run, random seeds): 20,000
runs, green, 12 minutes. This run **found a hole in the test, not in the contracts**: after 9,602 runs a seed let every holder but one
leave, and the last took out the whole pot, so the next take found no money (`TooLittleCash(0, 0)`, correctly); the test now refuses
any take-out that would leave less than 30,000 dollars. The handler's random sequences (`PotFuzz`, 120 steps a run with task steps) ran
2,000 runs once, green (its routine setting is 40). The eleven invariants ran at 1,000 runs of 200 steps (200,000 steps each), green.

**Invariants** (`PotInvariants`, 11): the Step 1 eight (the dollar one now counts `locked + notesOwed` and the handler's ghost sums
count worker payments and note claims), plus: `locked` is the sum of the stayers' claims of the open taken tasks, `notesOwed` is the
face of their notes plus what is still held for the notes of tasks that ended, `C + N == L` for every taken task (I2, I3); for every
serial the notes were paid no more than was held for them when it ended, claimable notes never exceed what is held, a task paid in
full has no claimable note, and no note left means nothing held (I4, I9); at most 8 open tasks and as many as announced or taken,
serials consecutive and used once, the 28-day sum of takes at most 1,000, `nextExpiry` the earliest end of any open task (I5, I6,
I10). The handler's rule "no step but a spend lowers what a Share is worth" now measures a Share with the money set aside counted at
face (a take, a return, a note and a claim leave it alone; a payment to a worker, the allowance and the fee are the spends). The face
value rule is I7. I1 and I8 are the first two invariants.

**Must-bind tests of design section 6** (all ten are now bound): (1) `NotesMustBind` cycles the 8 slots 20 times (two seeds, 160
serials each, `nextSerial == 161`), with random take-outs and joins while the money is set aside, every way a task can end (paid in
full, in part, one unit, rejected, left to run out), claims in a random order and some left for later cycles, and checks after every
step, for every serial, that `C + N == L`, that the notes were paid no more than was held for them, that claimable notes add up to no
more than what is held, that serials only rise, that every dollar is in one bucket, and that a note of one serial pays nothing out of
another (the stale-serial attack, tried against every later user of the same slot); (4) `TasksCaps` (pass A, with the plan's numbers);
(8) `Notes.test_mb8_...`: the worked case through a real take-out: pot 100,000, a 5% task set aside, a holder of 40% takes out (cash
38,000, note 2,000), 3,000 paid, 800 to the note and 1,200 to the stayers: 0.97 a Share each; a rule that repaid notes first would
leave the stayers 0.95 (mutation `notes-first`). The other seven are the step 1 ones.

**Vectors** (`model/vectors.json`, format 2): **83 scenarios** (the 52 of step 1, unchanged, and 31 new: 11 fixed and 20 seeded with
task steps), **3,463 operations, 32,633 numbers compared**, worst deviation **23.9% of its allowance** (`forge test --match-path
test/ModelVectors.t.sol -vv`). The new fixed scenarios: the worked pro-rata case (with a take one second early), a rejected task, a task
paid in full, two leavers over two tasks paid in part and in full, a task that runs out and a note claimed cold, a task that runs out
under an allowance (expiry comes after the accrual), a lapse, a wind-down, a Team take-out under a lock, a join during a lock, and the
rolling 28-day cap with a refused take and then the take at exactly 28 days. The notice is compared to the second. `scripts/check-vectors.sh`
passes.

**Events rebuild.** `EventsRebuild` (500 random steps with the task steps) and `TasksRebuild` (a scripted run through every path:
announce, cancel, take, a take-out with notes, a part payment, a claim, a reject, a take-out, a task that runs out, a lapse, a task
paid in full, a wind-down that sweeps, a claim afterwards, 30 days on) use one ledger (`helpers/TaskLedger.sol`) that reads only the
events of the Treasury and the book and equals the contracts after every step: pot, `locked`, `notesOwed`, every task's state and
money, every holder's note, open count, next serial, the 28-day sum.

**Mutations** (`scripts/check-mutations.py`): 118 deliberate one-line changes, each in a scratch copy, each must make a named test
file fail. Pass A's 85 plus 33: notes keyed by slot, spread equally or rounded up, expired task counted in the quote, the book writing
notes against a sum the Treasury got wrong, a claim not cleared / rounded up / paid at face / paid to the caller / paid before the
buckets are final / without the settle / without the lock, the rounding sent to the last claimer or lost, a task paid in full that
keeps its void notes, both events without their state, a note written without lowering the stayers' claim or without holding the
money or without the event, a note half as big (caught by the vectors alone) or by the backers' formula for a Team take-out or after
the pot was cut, a quote with no note, a take-out that pays no cash, and six that only the vectors must catch (notice floor,
deadline, cap window, larger-of, a joiner's price without the set-aside money, notes repaid first). **117 killed, 1 equivalent**:
`note-no-cap` removes `min(note, locked)`, which cannot change anything because each floor of the cash formula rises by at most the
money added to its part (`ceil(n x d / b) <= d` for `n <= b`), so the note is never above the money set aside; the script requires
that mutant to survive and prints the proof. The first full run had three survivors (the quote with one task run out and another
still taken, the dust in the last claim's event, and re-entry through a settle while a claim pays: the old test re-entered with a
claim, which fails on its own); each got a test and was then killed. The step 1 mutation texts that touch the take-out were re-pointed at the new code (same changes, same tests).

**Gas** (inside the call, cold, `GasTasks.t.sol`; the transaction's 21,000 and calldata are not counted): announce 219,566; take
139,693; accept in part 143,023; reject 81,051; a settle with an open task not due 24,140; a take-out that also returns one task that
ran out 171,784; **a take-out that writes a note against one task 186,559, against eight tasks 403,237** (the worst case: eight
tasks announced together and taken in the same second); a Team take-out against eight tasks 387,342; a claim (the last note of its
task: the rounding goes to the pot) 79,123. Real receipts from the chain loop (whole transaction): announce 243,498; take 199,682;
take out with a note 195,779; accept in part 179,108; claim a note 93,870; return 131,013; and step 1's back by `transferAndCall`
228,551, back by approve and join 139,486, take out 112,276, last take out 102,664.

**Step 1 files edited, and why.** No step 1 test name was removed or renamed; none of its assertions was loosened.
`PotInvariants.invariant_everyDollarIsInOneBucket` counts `locked + notesOwed` (and the handler's `cashOut` counts worker payments and
note claims); `PotHandler` measures a Share's worth with the set-aside money at face (a take lowers the cash value legitimately) and has
the task steps; `EventsRebuild` reads the book's events; `ModelVectors` has the new operations and the extra allowance of 8 units per
open task at a take-out; `PotFuzz` gets the handler coverage test. Pass A's: `Treasury.t`, `AccessMatrix.t`, `Launcher.t` (the Setup
has a book), `Expiry.t` (+2), `PotBase`, `StackBase`, `TreasuryHarness` (the book, the arrival stream).

## 4. Chosen under the owner's standing go; the owner may overrule

Pass A's choices (the plan's list and A's report) stand: a separate TaskBook contract (the Treasury was 18,075 of 24,576 bytes);
events split between the book (task events) and the Treasury (`TaskMoney`); serial from 1; take window `[noticeEnd, noticeEnd +
N)`; deadline `take + 2N`; all calendar time with half-open comparisons; the rolling cap by an exact 16-entry ring, a take that
would pass it reverts (no partial take) and an unpaid return does not refund the cap; announce and take refused while the check-in
window is closed or after a wind-down (accept, reject, cancel, return, claim stay open); a wind-down returns every open task; reject
returns at once and `returnTask` is a thin anyone-call after the settle's sweep; no deadline argument on `announceTask` (the app
reads `noticeFor`); notice rounded up per ten-thousandth, the amount down, the cap's share up; payees, takers and `takenBy` may not
be the runner or a Pair signer (an agent may be a payee or taker, never an announcer or acceptor); the Pair's proposal lifetime is
2N stored at `initialize`; task size floors (`what != 0`, at least 1 dollar, 1 to 500 ten-thousandths); `Setup` carries the book and `initialize` checks that the book's Treasury is this one and its unit the same (`BadSetup` otherwise); every book call that changes the open set returns the next expiry, which the Treasury stores (`nextExpiry`), so a settle with nothing due costs one storage read; a named payee may not be the Treasury, the dollar, the two tokens, the Vester or the book (`BadInput`). Pass B adds:

1. **A note is keyed by the task's serial and kept in the book** (`noteOf[serial][holder]`), one ledger for backer and Team
   take-outs. Notes are not transferable and never expire (a lost key leaves its note owed forever, bounded by that note).
2. **The note is `min(cash(P + C) - cash(P), C)`, computed from the numbers before the burn and the paid-in cut**, the same
   numbers the cash uses. The cap is provably never binding (each floor of the cash formula rises by at most the money added to its
   part), so it is defence in depth; the mutation list says so (an equivalent mutant).
3. **The spread rounds each part down; the remainder stays in `C`** (at most 7 units a leave, with 8 tasks), so a leaver is never
   written more than the note and the stayers keep the dust. The book sums the claims itself and fails closed (`Inconsistent`) if the
   Treasury's sum is another.
4. **A take-out that pays no cash still reverts (`NothingToPay`) even if a note would be due** (decision 9 of the plan). The
   quote agrees: it shows a note only when it shows cash.
5. **A claim**: anyone may call it, the money goes to the holder only; it settles first (so a task that has run out is returned in
   the same call); the note is cleared before anything is paid and the payment is the last step; a note that pays 0 units is still
   cleared and may still sweep the dust; the last claim against a task sends the floors' rounding to the pot, not to the last claimer.
6. **A task paid in full voids its notes**: `claimNote` reverts `NothingToPay`, `claimableNote` is 0, and the money for them was the
   worker's.
7. **Treasury event for a note**: `TaskMoney` kind 5 (written, `who` the leaver, `amount` moved from `locked` to `notesOwed`) and
   kind 6 (claimed, `amount` paid; `potAfter` includes the rounding that went to the pot), besides `Left.note` and `TeamLeft.note`.
8. **Tolerance of the vectors**: the step 1 allowance plus 8 units for every open task at every take-out (the spread's floors).
9. **The model's cap check refuses a vector on a ceil edge** (a take whose `ceil(amount x 10,000 / pot)` could land on the other side
   of a whole ten-thousandth for a pot a few units different): the generator raises and skips it, it never loosens a bound.
10. **The task handler runs with the founder as the single runner**; a Pair-run project is covered by `PairTasks.t.sol` (the real
    Pair through the whole queue and a note), not by the invariant handler.

## 5. Declined, with a number

| What | Why, with the number |
|---|---|
| A refund of the cap on an unpaid return | A stranger who takes an open task and never delivers can lock up to 10% of the pot for up to 14 days in every 28 and burn the cap room; holders lose nothing (the notes and the stayers get everything back). Per-entry bookkeeping would cost about 1 KB in the book. Use named payees for real work. |
| One-signer cancel by a Pair signer | Not built; the Pair has no one-signer lane except check-in. |
| A sweep of notes nobody claims | Not built; bounded by the note. A note against a task paid in full is void, not owed. |
| A caller-chosen deadline | Not built; it could only shorten what holders were promised (the deadline is 2N after the take). |
| A note for money still arriving | Not built (design 13): a leaver is paid on what has arrived. |
| The Pair-run project in the invariant handler | Not built; a real Pair walks the whole queue in `PairTasks.t.sol`. The handler would need two signers for every step and would not reach a state the single runner cannot. |
| The pre-announce-join gap (step 1 report 7.2) | Unchanged: a take and a return do not change what a Share is worth at face (pot + locked), a payment does, and it is announced 14 days or more ahead. |
| A second wallet of the founder as payee | Not stopped on chain (nobody can see a second wallet). The design's sleeper table stays: 15.0 per 100 of a sleeping backer's money in 30 days at the ceiling. Only the notice, the caps and leaving with a note limit it. |
| The Treasury's agent module behind an interface | Not needed: the Treasury is 23,577 bytes of 24,576. |

## 6. What the server and the app must read and call next

Nothing of this is built in this step. All of it is additive: no step 1 function, event or struct changed, `Launcher.launch` returns
the same tuple and `ProjectLaunched` is unchanged.

**New addresses.** Each project has one more contract, its task book: read it from `Treasury.tasks()`, or from the Treasury's
`TasksReady(address book)` event (emitted once, in `initialize`, in the launch transaction). The Launcher and Parts have
`tasksImpl`; the deploy script needs no new input.

**Events** (the book's events come from `Treasury.tasks()`; `serial` is always the first indexed topic):

| Emitter | Event | Fields after the topics |
|---|---|---|
| book | `TaskAnnounced(serial, what, payee, maxDollars, shareBps, announcedAt, noticeEnd, expiresAt, openAfter)` | the whole announced task |
| book | `TaskTaken(serial, takenBy, amount, takeBps, takenAt, deadline, windowSumBpsAfter, openAfter)` | the money set aside; the take's size in the cap; the cap's sum after it |
| book | `TaskResolved(serial, state, pay, returned, notesPool, potPart, noteFaceAfter, openAfter)` | `state` 3 Paid, 4 Rejected, 5 Returned (ran out or wound down), 6 Cancelled, 7 Lapsed; zeros where they do not apply; one per task, also for tasks a settle returns or a wind-down sweeps |
| book | `NoteMinted(serial, holder, part, stayerAfter, noteFaceAfter)` (holder indexed) | one per task a take-out is spread over |
| book | `NoteClaimed(serial, holder, paid, dustToPot, noteFaceAfter, notesLeftAfter)` (holder indexed) | |
| Treasury | `TaskMoney(kind, serial, who, amount, potAfter, lockedAfter, notesOwedAfter)` | kind 1 take, 2 paid, 3 rejected, 4 ran out or swept (serial 0), 5 notes written in a take-out (serial 0), 6 note claimed; always the three buckets after the move |
| Treasury | `Settled` | now also emitted when only a task's return moved money |
| Treasury | `Left.note`, `TeamLeft.note` | the face of the notes written (a sum over the tasks) |
| Treasury | `TasksReady(book)` | once, at birth |

Topic hashes: `TaskAnnounced` `0xb9d38fee...`, `TaskTaken` `0xb9daf7b3...`, `TaskResolved` `0xb81b90e7...`, `NoteMinted`
`0xc08e1b12...`, `NoteClaimed` `0x9a8f1af3...`, `TaskMoney` `0xa8a793d4...`, `TasksReady` `0x840a1824...`.
`test/helpers/TaskLedger.sol`, used by `TasksRebuild.t.sol` and `EventsRebuild.t.sol`, is the recipe: a ledger that reads only
these events (and the step 1 ones) holds the pot, `locked`, `notesOwed`, every task's state and money (L, C, N, returned, held for
notes), every holder's note per serial, the open count, the next serial and the 28-day sum of takes, and equals the contracts after
every step of a 500-step random run and of a scripted run that walks every path.

**Views.** Treasury: `tasks()`, `nextExpiry()` (zero when no task is open), `noticeFor(shareBps)` (notice seconds, take window
seconds, seconds from the take to the deadline), `locked()`, `notesOwed()`, `quoteBack(amount)` (its third number is the money set
aside the price counts at face), `quoteTakeOut(holder, n)` (its second number is the exit note the take-out would write, exactly,
settled first), `arrivalStart()`, `arrivalTotal()`. Book: `taskOf(serial)`, `openSerials()`, `openCount()`, `nextSerial()`,
`windowSumBps()` and `takeRoomBps()` (what the cap allows now), `noteOf(serial, holder)`, `claimableNote(serial, holder)` (what a
claim would pay now: 0 while open, when paid in full, or with no note), `dueC(when)`, `spreadSum(note, stay)`.

**Calls** (app builders): `announceTask(bytes32 what, address payee, uint256 maxDollars, uint16 shareBps) -> uint64`,
`takeTask(uint64 serial, uint256 minAmount) -> uint256`, `acceptTask(uint64 serial, uint256 payDollars)`, `rejectTask(uint64)`,
`cancelTask(uint64)`, `returnTask(uint64)`, `claimNote(uint64 serial, address holder) -> uint256`. Who: announce, accept, reject,
cancel are the runner's alone (with a Pair, both signers; an agent is refused); take is the named payee's, or anyone's when the task
is open, and never the runner's or a Pair signer's; return and claim are anyone's. The money of an accept goes to `takenBy` only,
and there is no `to` argument. The app checks, before it offers Accept, that `takenBy` equals the pay-to address in the relay's
record.

**Errors the app must put in words** (book errors bubble through the Treasury, so the app's error-copy test must read the book's ABI
as well as the Treasury's): book `BadInput`, `ShareTooBig`, `TooManyOpen`, `NoSuchTask`, `WrongTaskState`, `NoticeRunning(readyAt)`,
`TakeWindowOver`, `CapReached(used, add, cap)`, `TakesFull`, `TooLittleCash(min, got)`, `TooMuch(amount, available)`,
`NotYet(readyAt)`, `NothingToPay`, `Inconsistent`, `NotAllowed`; Treasury `ProjectQuiet`, `Inconsistent`, plus the step 1 ones
(`AlreadyWoundDown`, `NothingToPay`, `TooLittleCash`, `NotAllowed`).

**Pair: selectors and the sentences the second signer sees.** The Pair has no selector table (it forwards any call to the
Treasury or the Launcher), so "Pair gets selectors" means: these calls are runner-only in the Treasury (so both signers), and the
app's `KINDS` table and `describeProposal` (`app/src/features/team/pair.ts`) get them:

| Call | Selector | Kind | Sentence (plain words; on the test network the dollars are play dollars) |
|---|---|---|---|
| `announceTask(bytes32,address,uint256,uint16)` | `0xf799daee` | `announce-task` | "Plan a task: pay up to {max} to {payee, or whoever takes it first}, at most {share} of the project's money. Holders get {notice} notice, so it can be taken from {date}; if nobody takes it within {window} it lapses; once taken it is due {due} later." |
| `acceptTask(uint64,uint256)` | `0xa4e235c2` | `accept-task` | "Pay {pay} of the {set aside} set aside for task {serial} to {takenBy}. What is left goes back to the project and to those who took out while it was set aside." |
| `rejectTask(uint64)` | `0xbe99bca8` | `reject-task` | "Send task {serial}'s money back. Nobody is paid." |
| `cancelTask(uint64)` | `0x6190aab8` | `cancel-task` | "Withdraw task {serial}. It was not taken, so no money moves." |

Everything in the first sentence is in the call data (`payee`, `maxDollars`, `shareBps`, `what`) or derived from `noticeFor(shareBps)`
and the dates of the confirmation (the task is announced when the second signer confirms, so the dates are "if confirmed now"). For
an accept, `taskOf(serial)` gives `takenBy`, the money set aside and the deadline, so a stale proposal that names a serial can only
touch that serial (`PairTasks.t.sol` binds it). The proposal lives two time units (`Pair.PROPOSAL_TTL()`, 14 days at N = 7 days).
The amounts and the share are never reworded: {share} is `shareBps / 100` percent; the legal line and the other fixed texts of the
app are untouched by this step.

**What the relay and the record need** (design 6, "Server"): the task states Announced, Taken, Paid, Rejected, Returned, Cancelled,
Lapsed; `takenBy` and the serial; the notice end; the deadline. The record's what-hash is the `what` of `announceTask`.

## 7. How to run it again

From `contracts/pot`, with the Foundry binaries on `PATH`:

```bash
forge fmt --check src script test
forge build --sizes                      # Treasury, TaskBook and Parts must stay under their limits (test/Size.t.sol binds them)
forge test                               # everything
FOUNDRY_FUZZ_RUNS=20000 forge test --match-path 'test/Notes*.t.sol'    # the new fuzz tests at 20,000 runs
bash scripts/check-vectors.sh            # vectors.json is what the model says
python3 scripts/check-mutations.py       # 118 deliberate changes, one at a time; add --check to see each still applies (no forge run)
bash ../../scripts/pot-chain-loop.sh     # the loop on a local chain (needs anvil, cast, forge, jq, python3)
```

The chain loop's gas figures are real receipts; its time-based checks use the chain's own clock (`evm_increaseTime`) and tolerate
the allowance's accrual of a few units a second between a quote and the transaction a block later (a part in a hundred thousand).
