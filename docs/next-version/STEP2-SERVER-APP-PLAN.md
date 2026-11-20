# Step 2, server and app: the build plan (task queue, exit notes, alerts)

Status: a plan. **Nothing in it is built.** It is written for five engineers who build in parallel from it without re-deriving
anything, against the step 2 contracts in `contracts/pot` (`src/TaskBook.sol`, `src/Treasury.sol`; report
`docs/next-version/POT-STEP2-REPORT.md`, section 6 is the contract between the contracts and this plan). The owner's direction is
`docs/next-version/JOIN-LEAVE-DESIGN.md` (sections 2.2, 2.3, 2.8, 5, 6, 8) and is not reopened here. The record spec this extends
is `docs/next-version/RECORD-V2.md`. Where this page and a contract disagree, **the contract is right**: report it, do not
work around it. This is not legal or tax advice, and no figure here is a promise of any result for anyone. The first public launch
is a test network with play dollars: every money screen says so. Legal line, quoted only as it stands and never reworded:
"Buyers acquire ownership only: governance and exit. No dividends or revenue share, ever, unless they contribute and earn one."
Legal text, terms, privacy, the age box and "Posts and votes are public" are never hidden or reworded by this work.

Where a point was open I chose the option the design recommends, or else the simplest safe one. Every such choice is in
section 9 under "Chosen under the owner's standing go; the owner may overrule", numbered **C1 to C30**; the text cites them as
(C#).

## 0. The shape of it in one page

**What a holder gets.** When the team plans a task, every holder of that project sees, in the app and for at least 14 days
before any money can move, two lines: who would get how much at most, from which date, and that they can take out first. When the
task is taken, paid, sent back or runs out, they see that too. A holder who took out while money was set aside for a task has a
note, and a screen that says what it pays now and lets them claim it. Leaving is never slowed: the Take out sheet needs only
`quoteTakeOut` (T6).

**How the pieces fit.**

```
contracts/pot (TaskBook + Treasury)         the truth: tasks, notes, the 28-day cap
        | logs + views at one final block
        v
crates/buzz-relay/src/chain_reader          WP1: reads the book, rebuilds every task and note from logs,
        |                                        checks them against the views, signs record version 2 (kind 39009)
        |                                        with a new `tasks` section (additive, no version change, C1)
        +--> chain_logs (Postgres)  <-----  WP2: the relay's task rules read these logs to tie a team's task record
        |                                        (kind 47003) to its network task, and refuse what contradicts it
        v
app (reads the record for lists, the chain for every sheet)
   WP3 shared library + parser + shared state words     WP4 team side (plan, pay, send back, withdraw)
   WP5 worker + holder side (take, return, notes, planned-task view, alerts)    WP6 loops and report
```

**The five rules everything below follows.**

1. **The network decides, never a person's word (T2).** A task's state shown in the app ("planned", "can be taken from 3 Dec",
   "taken, due 17 Dec", "paid", "sent back", "withdrawn", "lapsed", "ran out") comes from the server's signed record, which comes from
   the chain. A team member's own task record (kind 47003) can say anything; it never changes what the app calls the state.
   Before Accept is offered the app reads the task from the chain again and checks that the taker on the chain is the pay-to address
   in the task record, and that the plan's what-hash is the id of that task record (section 5.5).
2. **Sheets read the chain, lists read the record** (RECORD-V2 section 5, unchanged). The record is minutes old; every press is
   built from numbers read at that moment.
3. **Leaving always works (T6).** Nothing in this plan puts a read of tasks, notes or the record in front of Take out.
4. **Bounded work (T7).** At most 8 open tasks (a contract limit); a stated cut for ended tasks and for note rows (section 1.5).
5. **No new kinds, no new HTTP, no per-holder writes (C25).** Tags on the existing task records, one new reader role, and alerts
   derived in the app from the signed record.

**Words used in this page.** *Network task* (or *plan*): a task in the TaskBook, identified by its serial. *Task record*: the team's
Nostr record (kind 47003, `task-part` = `task`) that says what the work is, identified by its event id. *Plan*: announcing a task
record on the network. *Set aside*: the money a take moves from the project's money into the task (L). *Note*: what a leaver
holds against a taken task. The app words are always the plain ones of section 5; this page uses the contract words so the
engineers can find them.

---

## 1. Record additions

Everything here is **additive inside version 2** (C1). RECORD-V2 section 1 says "Adding a field never changes the version (a reader
ignores fields it does not know). Removing a field, renaming one, or changing what one means is version 3", and section 9 already
promised "step 2 adds `tasks` and fills `money.locked` and `money.notesOwed` (no version change)". Nothing is removed, renamed or
re-meant: `money.locked` and `money.notesOwed` were documented as "always `"0"` in step 1" and now carry their real values.

**What an older app does with a newer record.** The step 1 parser (`app/src/features/money/numbers-read.ts`, `readBody`) reads
the fields it knows and ignores the rest (it builds an object from known keys; verify with a test, WP3). A step 1 app therefore
shows the project as before: no planned-task lines, no alerts, no task screens, and an unknown Pair call is "unknown, never
confirmed from here" (`UNKNOWN_WORDS`). It still shows `money.locked` as it did. Nothing breaks and nothing is hidden that
protects money: leaving needs no record. **What a step 2 app does with an older record** (no `tasks` key): task screens that need
the queue are hidden, the step 1 tasks flow (accept, pay from the box) stays, no alerts are made, and a plain line says
"This server has not told us about this project's tasks yet." (C2). `tasks: null` (a project with no book) reads the same way.

### 1.1 How the server finds a project's task book, and projects born before step 2

The book's address is **not** in `ProjectLaunched` (its `project` tuple is founder, shares, team, treasury, vester, launchedAt) and
the Launcher returns the same tuple as in step 1. It is found from the Treasury's own log, with no node call:

- `Treasury.TasksReady(address book)` is emitted once, in `initialize`, in the launch transaction (report section 6).
- The reader already follows each project's Treasury from its launch block. When a decoded Treasury log is `TasksReady`, the
  reader follows `book` as a new role **`tasks`** (stored `chain_contracts.role = 'tasks'`, `project_key` = the project's key,
  `from_block` = the log's block). The book's own first event can only come in a later transaction, so `from_block` = that block
  loses nothing.
- `scan.rs::discovered` today reveals contracts only from Launcher logs and `scan_range` only decodes Launcher logs for
  discovery. Both take the log's role: a Treasury `TasksReady` row reveals the book. `store::launcher_reveals` (the "late" path
  for stored rows the reader did not follow yet) reads Treasury `TasksReady` rows too. A rollback past `from_block` forgets the
  book as it forgets any contract.
- The record's `tasks.book` is checked against the view `Treasury.tasks()` at `asOf.block`; a difference is a failed build
  (nothing published, the previous record stays).

**A project born before step 2.** On the test network there is none: the first public deployment is made from the step 2
contracts, a local chain is rebuilt from scratch, and the reader is configured with one Launcher, whose projects all have a book.
A project with no `TasksReady` row (a step 1 Launcher's project, which cannot happen under one configured Launcher) gets
`"tasks": null`, and its record is otherwise exactly the step 1 record. The reader never guesses a book address and never calls
`tasks()` on a Treasury that has no `TasksReady` row. If an operator later points the reader at a step 1 Launcher, those projects
read as `tasks: null` and keep working (the contract has no book to ask).

### 1.2 The settled numbers change (`money.pot`, `money.locked`)

`Treasury._settled()` now returns money from tasks that have run out **last**, after the allowance and the arriving release (the
returned money is not charged allowance for time it was not in the pot). RECORD-V2 section 3 must follow, or `money.pot` is wrong
whenever a task ran out and nobody has settled since. The roll-forward gets one more step, **after** the arriving release:

```
dueC   = book.dueC(asOf.time)          # view at asOf.block: sum of the stayers' claims C of Taken tasks whose expiresAt <= asOf.time
pot   += dueC                          # only when nextExpiry() != 0 and asOf.time >= nextExpiry(), as _settled() does
locked = locked() - dueC               # the record's money.locked is the SETTLED figure
```

`boxCap()` is computed by the contract from the final `s.pot` (including `dueC`) and `s.box`: the existing check
`mulDiv(pot + box, rate*7, 1e6) == boxCap()` keeps its form with the final pot (the clamp inside the roll-forward still uses the pot
before `dueC`, as the contract does; a test pins the order, section 2.6). `notesOwed` does not move at an expiry (a task paid
nothing keeps its notes whole: `notesOwed - N + N`). The held identity becomes
`held == pot + box + arriving + feesOwed + locked + notesOwed` with the settled `pot` and `locked`.

### 1.3 The record: new and changed fields

All amounts are decimal strings in dollar units (6 decimals); times unix seconds; counts JSON integers; addresses and 32-byte values
lower-case `0x` text; `null` means none. **Source** says where the value comes from, **rebuilt** how the server gets it from the
logs (the recipe is `contracts/pot/test/helpers/TaskLedger.sol`, which an event-only ledger passes after every step of a 500-step
random run and a scripted walk), **checked** which view it must equal at `asOf.block`.

**Changed fields** (same name and type, now live):

| Field | Meaning | Source / rebuilt | Checked against |
|---|---|---|---|
| `money.locked` | Money set aside for taken tasks that are still running at `asOf.time`: the stayers' claims. This is the line the Back sheet's price counts at face. **Settled** (1.2). | `TaskMoney.lockedAfter` (last one), less `dueC` | `Treasury.locked()` minus `book.dueC(asOf.time)` |
| `money.notesOwed` | What is held for exit notes: the face of the notes against open tasks plus what is left to claim on tasks that ended. | `TaskMoney.notesOwedAfter` (last one) | `Treasury.notesOwed()` |
| `money.pot` | As before, now including run-out tasks' returned money (1.2). | `TaskMoney.potAfter` and the step 1 events; settled by section 3 | the existing `boxCap()` and `activeNow()` checks |
| `refreshEverySecs` | 600 while the allowance accrues, outside money arrives **or any task is open** (announced or taken), else 3600 (C12). `atMostNow` and the cap room move with time, and a task's state moves with the clock. | server rule | n/a |

**New top-level field `tasks`**, an object, or `null` (1.1). Every field is required when `tasks` is an object.

| Field | Type | Meaning | Source | Rebuilt / checked |
|---|---|---|---|---|
| `tasks.book` | address | The project's TaskBook. | `Treasury.TasksReady.book` | checked against view `Treasury.tasks()` |
| `tasks.bookBlock` | int | The block of `TasksReady`: the first block the book can have logs in. The app scans for a person's notes from here (5.9). | `TasksReady` log | n/a |
| `tasks.nextSerial` | int | The serial the next plan gets. Serials start at 1, never repeat, and are JSON integers (the server refuses a book whose serial passes 2^53: it fails the build). | `TaskAnnounced.serial + 1` (last) | view `book.nextSerial()` |
| `tasks.openCount` | int 0..8 | Tasks announced or taken, not ended. | `openAfter` of the last book event | view `book.openCount()`, and equal to the number of open rows |
| `tasks.nextExpiry` | int or null | The earliest second an open task runs out (end of a take window, or a deadline); null when none is open. | min over open rows of `expiresAt` | view `Treasury.nextExpiry()` (zero becomes null) |
| `tasks.limits.maxOpen` | int | 8. | | view `book.MAX_OPEN()` |
| `tasks.limits.maxShareBps` | int | The most one task may ask for, in ten-thousandths of the pot (500 = 5%). | | view `book.MAX_SHARE_BPS()` |
| `tasks.limits.capBps` | int | The most that may be taken in any rolling window (1000 = 10%). | | view `book.CAP_BPS()` |
| `tasks.limits.minTask` | amount | The smallest task (1 dollar). | | view `book.MIN_TASK()` |
| `tasks.limits.capWindowSecs` | int | The rolling window of the cap: `CAP_WINDOW_MULT x unit` (28 days on a real network). | | view `book.CAP_WINDOW_MULT()` times `unit` |
| `tasks.limits.takeWindowSecs`, `dueSecs` | int, int | How long a task can be taken after its notice (one unit), and how long after a take it is due (two units). | | views `book.noticeFor(1)` second and third results |
| `tasks.cap.usedBps` | int | The takes counted in the window now (ten-thousandths of the pot at each take, less what was given back). | **settled at `asOf.time`**: sum of `capBps` of takes with `takenAt + capWindowSecs > asOf.time` | view `book.windowSumBps()` |
| `tasks.cap.roomBps` | int | The room left under the cap: `capBps - usedBps` ("the room left under the 28-day cap"). | arithmetic | view `book.takeRoomBps()` |
| `tasks.cap.frees` | array, at most 16 | When room comes back: `{at, bps}` per counted take, oldest first, `at = takenAt + capWindowSecs`, `bps` that take's counted share. | the ring of takes, rebuilt | sum of `bps` equals `usedBps` |
| `tasks.next` | `{at, kind, serial}` or null | The next date something can happen: the earliest of "can be taken" (`noticeEnd`, kind `can_be_taken`), "lapses" (`expiresAt` of an announced task, `lapses`), "due" (`deadline` of a taken task, `due`) and "room frees" (first `frees.at`, kind `cap_room`, serial 0), strictly after `asOf.time`; null when none. | arithmetic on the rows | the example test redoes it independently (A14, 8.2) |
| `tasks.list` | array | The rows of 1.4: open tasks first (serial ascending), then ended tasks (serial descending). At most 8 open plus 32 ended. | | |
| `tasks.cut` | object | `{maxEnded: 32, endedWithinSecs: capWindowSecs, endedDropped: n}`: the rule that chose the ended rows and how many it left out (1.5). | | |
| `tasks.truncated` | bool | True when `endedDropped > 0` or a row's note list was cut. A cut list never says "none". | | |

`tasks.truncated` is separate from the top-level `truncated` (holders, grants, agents) on purpose: the app's holder hint
reads the top-level one (RECORD-V2 2.13), and a task cut must not make it less certain.

### 1.4 A task row

One row per task in the list. Every number in it is checked against `book.taskOf(serial)` at `asOf.block` (a 17-word static
struct whose order the generator reads from the ABI, section 2.2); the state words are mapped from `TaskBook.State`.

| Field | Type | Meaning | Source / rebuilt | Checked against `taskOf` |
|---|---|---|---|---|
| `serial` | int | The task's number, never reused. | topic of every book event | the argument |
| `what` | bytes32 | The hash tied to the team's task record: **the task record's event id** (C4). | `TaskAnnounced.what` | `what` |
| `payee` | address or null | Who may take it; null when open to anyone. | `TaskAnnounced.payee` (zero becomes null) | `payee` |
| `state` | `"announced"`, `"taken"`, `"paid"`, `"rejected"`, `"returned"`, `"cancelled"` or `"lapsed"` | Where it is on the network at `asOf.block`. `returned` is a task that ran out or was swept by a wind-down. A taken task whose `deadline <= asOf.time` is still `taken` here until someone settles: the app words it "ran out" from the dates (5.4). | `TaskAnnounced`, `TaskTaken`, `TaskResolved.state` (3 paid, 4 rejected, 5 returned, 6 cancelled, 7 lapsed) | `state` |
| `shareBps` | int | The share of the pot it may ask for (1..500). | `TaskAnnounced` | `shareBps` |
| `maxDollars` | amount | The most it may set aside. | `TaskAnnounced` | `maxDollars` |
| `atMostNow` | amount or null | For an announced task whose take window has not ended (`asOf.time < expiresAt`): `min(maxDollars, mulDiv(money.pot, shareBps, 10000))`, the most a take at `asOf.time` would set aside. Null for every other state. The one contract formula repeated here (`TaskBook.take`); a test replays it against the fixture's real takes (A9, 8.2). | arithmetic on settled `money.pot` | not a view; pinned by a fixture test |
| `announcedAt`, `noticeEnd`, `expiresAt` | int | Announce time; first second it can be taken; end of the take window while announced, the deadline once taken. | `TaskAnnounced` (`expiresAt` is replaced by `TaskTaken.deadline`) | same names |
| `takenBy` | address or null | Who took it, and the only address a payment goes to. | `TaskTaken.takenBy` | `takenBy` |
| `takenAt`, `deadline` | int or null | When taken; due time (taken time plus two units). | `TaskTaken` | `takenAt`, `deadline` |
| `setAside` | amount | L: what the take moved out of the pot ("0" before a take; kept after the end, because notes are paid against it). | `TaskTaken.amount` | `locked` |
| `stayerClaim` | amount | C: the stayers' claim while taken ("0" otherwise). | `TaskTaken.amount`, then `NoteMinted.stayerAfter` | `stayer` |
| `noteFace` | amount | N: the face of the notes against it (kept after the end for the claims; "0" when paid in full). | `NoteMinted.noteFaceAfter`, `TaskResolved.noteFaceAfter`, `NoteClaimed.noteFaceAfter` | `noteFace` |
| `pay` | amount | What the worker was paid ("0" unless `paid`). | `TaskResolved.pay` | not in `taskOf`; equals `setAside - returned` when `state` is `paid` |
| `returned` | amount | What came back when it ended: `setAside - pay`. | `TaskResolved.returned` | `returned` |
| `notesLeft` | amount | What is still held for the claims of its notes. | `TaskResolved.notesPool`, then `NoteClaimed.notesLeftAfter` | `notesLeft` |
| `capBps` | int | What this take still counts in the cap (the take's share less `capGivenBack`); 0 when never taken or when it ended unpaid and the share was given back. | `TaskTaken.takeBps` minus `TaskResolved.capGivenBack` | equals the entry of the ring (via `windowSumBps` sums) |
| `resolvedAt`, `resolvedTx` | int or null, bytes32 or null | When it ended (the block time of `TaskResolved`) and the transaction that ended it (the proof the app writes into a team record, 3.3). | the log row's block time and `tx_hash` | n/a |
| `repeatOf` | int or null | The serial of an **earlier** row with the same `what` that is announced, taken or paid (or ended with a payment). The same task record planned twice would be paid twice; the app refuses to pay the later one and tells holders (attack 2, 8.1). Computed over the whole history in the ledger, not only the listed rows. | arithmetic on the ledger's `what` index | n/a |
| `notes` | object or null | Null when `noteFace` is 0 and there is nothing held, or when the task was paid in full (its notes are void, `NothingToPay`). Otherwise `{faceTotal, holders: [{account, face, claimable}], holdersCut}`. | below | below |

**Notes in a row** (a holder's notes per task and what a claim would pay now). `face` is `noteOf(serial, account)`; `claimable` is
`claimableNote(serial, account)`: **0 while the task is open or paid in full**, otherwise `mulDiv(face, returned, setAside)` (the
contract's own rounding, from the view). `holders` lists at most **20** accounts, largest `face` first then address, and only for
the **8 newest tasks that still have notes outstanding** (`notesLeft > 0` or an open taken task with `noteFace > 0`); older rows
carry `notes.holders: []` with `holdersCut: true`. `faceTotal` is `noteFace` of the row. Rebuilt from `NoteMinted(serial, holder
indexed; part, ...)` (add `part` to that holder) and `NoteClaimed(serial, holder; paid, ...)` (that holder's note is 0), exactly as
`TaskLedger` does with `lNote`. **Checked:** the sum over **all** holders' notes of a task (listed or not) equals the view
`taskOf.noteFace` (for a task not paid in full); each listed holder's `face` and `claimable` equal the views `noteOf` and
`claimableNote` at `asOf.block` (at most 8 x 20 x 2 = 320 view calls in the same batch, only when such rows exist).

The rows give the **list**; the figure a person presses on is always read from the chain when the claim sheet opens (5.9), exactly as
positions are (RECORD-V2 2.13). The record's rows are a hint for lists and for the alert "you can claim", and the way to find a
note when the person has no Shares left: a leaver is not in `holders` of the record and holds no balance, but is in a note row.

### 1.5 The cuts (T7)

| What | Bound | Rule | What the record says |
|---|---|---|---|
| Open tasks | 8 | the contract's `MAX_OPEN`; the server cannot exceed it and fails the build if the book says more | `tasks.limits.maxOpen`, `openCount` |
| Ended rows | 32 | every ended task that ended within `capWindowSecs` (28 days) **or** still has `notesLeft > 0` or an unclaimed note, newest serial first, at most 32 | `tasks.cut`, `endedDropped`, `tasks.truncated` |
| Note rows | 20 holders x 8 tasks | 1.4 | `notes.holdersCut`, `tasks.truncated` |
| Cap `frees` | 16 | the ring of takes | none (a contract constant) |
| Per project, view calls | about 17 views + 1 per row (at most 40) + 2 per listed note holder (at most 320) | one batch with the step 1 views, at the one block | none |

Worst-case size added to the record: 40 rows at about 1.3 KB plus 160 note rows at about 160 bytes is about 78 KB. RECORD-V2
section 1 puts the step 1 worst case at about 120 KB and the frame at 512 KB: the worst record is about 200 KB. A test builds the
worst case (A11, 8.2) and asserts the signed event stays under 300 KB.

An ended task older than 28 days with no notes left drops out of the list. Nothing is lost that matters: it moved no money anyone
can still claim, and the chain has it. The app's alert for it was derived from the record while it was in it (6).

### 1.6 What the app shows when a field is absent, wrong or old

| Case | What the app does |
|---|---|
| `tasks` absent (older server) or `null` | No queue screens, no alerts; the step 1 tasks flow stays; the line in 1 above, once, on the Tasks tab. |
| `tasks` present but any part of it does not parse (a bad row, a duplicate serial, more than 8 open, a list over 40 rows, a negative number, `openCount` not equal to the open rows) | **Only the tasks section is treated as unreadable** (`tasks: "unreadable"` in the parsed type); the rest of the record parses as always. The Tasks tab says "The task list could not be read. Your money is not affected: you can take it out any time." No alert is made from it. (Hostile record tests, 8.) |
| Record fresh | Nothing special; dates in the Details fold. |
| Record older than `3 x refreshEverySecs + 60` (RECORD-V2 section 6) | Every task date and state on a list or page says "as of {time}" (the record's `asOf.time`). Alerts still show, marked "as of". Buttons are not removed: each press re-reads the chain (5.3). |
| Record older than 24 hours | The Tasks tab and the planned-task lines are replaced by: "We have not been able to refresh this project's tasks since {date}. Your money is not affected: you can take it out any time." Alerts from this project are not made, and the You page says the project's news could not be refreshed. Take out, claim a note and "Return the money" stay (they read the chain, never the record). |
| Wrong network (the wallet is on another chain) | The sheet's gate (`WalletGate`, unchanged) says which network and offers the switch; no press. |
| A task row whose dates are before `now` but whose state is still `announced` or `taken` | The app words it from the dates (5.4); the chain re-read before any press decides. |

The state of a task is **never** carried forward by the app from an old record into a button: a press re-reads `taskOf(serial)`
from the chain (5.3).

---

## 2. Server work (WP1: `crates/buzz-relay/src/chain_reader`, the generators, the fixture, the loop script, the migration)

### 2.1 Files to change

| File | Change |
|---|---|
| `events.rs` | `Role::Tasks` (`as_str` "tasks", `parse`). The `Ty` set is enough (all fields are `uint64/uint256/uint16/uint8/address/bytes32`). |
| `events_table.rs` | **Generated, never typed**: `node scripts/chain-reader-events.mjs`. The script gets one more contract, `{contract: "TaskBook", roles: ["Tasks"]}`, and the Treasury table gains `TasksReady`, `TaskMoney` and any changed signature (`Settled` is unchanged; `Left.note` and `TeamLeft.note` exist from step 1). Five book events: `TaskAnnounced`, `TaskTaken`, `TaskResolved` (nine fields, ending `capGivenBack`), `NoteMinted`, `NoteClaimed`. |
| `testdata/pot-events.json` | regenerated by the same script (forge's own topics). |
| `scan.rs` | `discovered(...)` takes the emitting role and reveals the book from a Treasury `TasksReady`; the discovery loop in `scan_range` decodes Treasury logs as well as Launcher logs for this; `late` discovery reads the stored `TasksReady` rows. |
| `store.rs` | `launcher_reveals` becomes `reveals` and also returns Treasury `TasksReady` rows (`event IN ('ProjectLaunched','PairMade','TasksReady')`). A new read `task_logs_of(project)` is not needed: `rows_of_project` already returns every stored row of the project. **No change to `commit_range`.** |
| `ledger.rs` | `Contracts.tasks: Option<String>`; `is_ours` knows `Role::Tasks`; the Treasury arms for `TasksReady` (sets `contracts.tasks`, `book_block`) and `TaskMoney` (sets `pot`, `locked`, `notes_owed` from the three "after" fields, as `TaskLedger._applyTaskMoney` does for the buckets); `LogRow` gains `tx: [u8; 32]` (from `chain_logs.tx_hash`). `Stored` gains `locked`, `notes_owed`, `open_count`, `next_serial`, `window_sum_bps`. `mismatches` compares them. |
| `ledger_tasks.rs` (new) | The task ledger: `TaskLedger { tasks: BTreeMap<u64, LTask>, notes: BTreeMap<(u64, String), u128>, takes: Vec<Take>, whats: BTreeMap<[u8;32], Vec<u64>>, open_count, next_serial, locked, notes_owed, book_block }` and `fn apply(&mut self, row: &LogRow)`. A line-for-line port of `TaskLedger._applyBook` (2.3). |
| `views.rs` | The book's views in the same one-block batch (2.4); `Views` gets `book: Option<BookViews>` with the per-row `taskOf` answers and the per-holder `noteOf`/`claimableNote` answers. |
| `views_table.rs` (new, generated) | The `taskOf` tuple's field names and Solidity types, in order, from the ABI (the script writes it and `testdata/pot-abi.json`; a test compares). |
| `record.rs` | `roll_forward` gets the `dueC` step (1.2); `Stored` gets `locked`, `due_c`; `validate` gets the task rules (2.5); `Record.tasks: Option<TasksRec>` serialised as `null` when none (no `skip_serializing_if`: the key is always there), `deny_unknown_fields` stays. |
| `record_tasks.rs` (new) | `TasksRec`, `TaskRowRec`, `TaskNotesRec`, `CapRec`, `NextRec`, `CutRec`, `LimitsTasksRec`, the cut (1.5), `next`, `repeat_of`, `at_most_now` and their unit tests. Keeps `record.rs` from growing past the file-size gate. |
| `numbers.rs` | `cross_check` gets the task groups (2.5); `build` fills `tasks`, `money.locked`, `money.notesOwed`; `facts_of` strips the time-moving task numbers (`atMostNow`, `cap.usedBps`, `cap.roomBps`, `cap.frees` is kept, `next`) so they do not re-sign a record every pass; the refresh rule (C12). |
| `mod.rs` | `refresh_every`: 600 while `openCount > 0`. |
| `helper/plan.rs` | A settle job for an expired task (2.7). No new call in the allow-list. |
| `fixture.rs` | Role `Tasks` in the fixture's contract list. |
| `migrations/0071_chain_tasks_role.sql` (next free number at merge; `ls migrations`) | Add `'tasks'` to `chain_contracts_role_check`. `schema/tables/public/chain_contracts.sql` gets the same role (CLAUDE.md gotcha 7: `schema.sql` is a manifest, the table file holds the `CREATE TABLE`; there is no seed DML here, so `scripts/reconcile-schema-after-pgschema.sql` needs no new statement; a test asserts the constraint in a pgschema-created database). `chain_logs.role` has no check. |
| `scripts/chain-reader-events.mjs`, `scripts/chain-reader-fixture.py`, `scripts/chain-loop-pot.sh`, `scripts/chain-loop-pot-check.py`, `scripts/chain-loop-query.mjs` | 2.8 and 2.9. |
| `docs/next-version/RECORD-V2.md` | A new section 10 "Step 2 additions" with this section 1 (tables only, the prose stays here); section 3 gets the `dueC` step; sections 2.3 and 9 lose "always 0 in step 1". Owner: WP1. |

### 2.2 The new events and the views table, generated

Nothing about a layout is typed by hand. `scripts/chain-reader-events.mjs` already writes the events table from the forge build;
it now also writes the one view whose answer is a struct, `book.taskOf`, as `views_table.rs`:

```
TASK_OF: [("what","bytes32"),("payee","address"),("state","uint8"),("shareBps","uint16"),("ringIdx","uint8"),
          ("takenBy","address"),("announcedAt","uint64"),("noticeEnd","uint64"),("expiresAt","uint64"),("takenAt","uint64"),
          ("deadline","uint64"),("maxDollars","uint128"),("locked","uint128"),("stayer","uint128"),("noteFace","uint128"),
          ("returned","uint128"),("notesLeft","uint128")]      // 17 words; the order shown is TaskBook.sol's struct as read
```

The list above is what the report says today (`ringIdx` between `shareBps` and `takenBy`); **the generator, not this page, is the
source**. `views.rs::expect_words` for `taskOf` takes `TASK_OF.len()`. A test (`the_task_tuple_is_the_forge_abi`) compares the table with
`testdata/pot-abi.json`, so a contract that adds a field fails CI instead of shifting every number by one word. The report's warning
stands: "a decoder that reads the tuple by position must be regenerated from the ABI".

### 2.3 The ledger from logs (a port of `TaskLedger`)

Process the project's rows in `(block, log_index)` order. For each book event, serial = topic 1:

| Event | Updates |
|---|---|
| `TaskAnnounced` | row state `announced`; `what`, `payee` (zero is null), `maxDollars`, `shareBps`, `announcedAt`, `noticeEnd`, `expiresAt`; `open_count = openAfter`; `next_serial = serial + 1`; `whats[what].push(serial)` |
| `TaskTaken` | state `taken`; `takenBy`, `takenAt`, `deadline`; `expiresAt = deadline`; `setAside = stayerClaim = amount`; `noteFace = 0`; push a take `{serial, at: takenAt, bps: takeBps}`; `open_count = openAfter` |
| `TaskResolved` | `state` from the first data word (3 to 7); `stayerClaim = 0`; `pay`, `returned`, `notesLeft = notesPool`, `noteFace = noteFaceAfter`; `open_count = openAfter`; if `capGivenBack != 0`, subtract it from that serial's take; `resolvedAt` = the row's block time, `resolvedTx` = the row's `tx`. A `cancelled` or `lapsed` task has all money fields 0. |
| `NoteMinted` | `notes[(serial, holder)] += part`; `stayerClaim = stayerAfter`; `noteFace = noteFaceAfter` |
| `NoteClaimed` | `notes[(serial, holder)] = 0`; `noteFace = noteFaceAfter`; `notesLeft = notesLeftAfter` |
| Treasury `TaskMoney` | `pot, locked, notes_owed` = the three "after" fields |
| Treasury `Settled` | as step 1 (it is now also emitted when only a task's return moved money) |

The window at `asOf.time` is `sum(take.bps)` over takes with `take.at + capWindowSecs > asOf.time`; `frees` lists those takes oldest
first (at most 16, the ring). Rounding, ordering and the **single "after" snapshot per event** are what make the ledger exact: do not
recompute a task's money from other fields. If an event the table knows fails to decode, the range fails and is read again (step 1
rule, unchanged).

### 2.4 The views, in the one batch at `asOf.block`

Added to the step 1 list (RECORD-V2 4.2): Treasury `tasks`, `nextExpiry`, `locked` (already read), `notesOwed` (already read); the
book `openCount`, `nextSerial`, `windowSumBps`, `takeRoomBps`, `dueC(asOf.time)`, `noticeFor(1)`, the constants `MAX_OPEN`,
`MAX_SHARE_BPS`, `CAP_BPS`, `MIN_TASK`, `CAP_WINDOW_MULT`; then, for each listed row, `taskOf(serial)`; and for each listed note
holder `noteOf(serial, holder)` and `claimableNote(serial, holder)`. A failed call, an answer of the wrong length or a number that
does not fit is an error (step 1 rule); the record is not built at a later block.

### 2.5 The checks (every one has a test that fails without it: the A tests of 8.2)

In `numbers.rs::cross_check` (before the record is built) and `record.rs::validate` (after):

1. `tasks.book` equals `Treasury.tasks()`; `openCount`, `nextSerial`, `nextExpiry`, `windowSumBps`, `takeRoomBps` equal the ledger's.
2. **Per row**: every field of 1.4 that has a `taskOf` field equals it (a mismatch names the field and both values, like step 1).
3. **Money buckets**: the ledger's `locked` equals the view `locked()`; the sum of `stayer` over taken open rows equals `locked()`;
   the ledger's `notes_owed` equals the view `notesOwed()`; the sum of `noteFace` of open taken rows plus `notesLeft` of ended rows
   equals `notesOwed()` (over **all** tasks the ledger holds, not only the listed ones).
4. **Per task**: for each task, `setAside == stayerClaim + noteFace` while taken (`C + N == L`, invariant I2); the sum of all
   holders' notes equals `noteFace` unless paid in full; for an ended task `returned <= setAside` and, if paid, `pay + returned ==
   setAside`.
5. **Cap**: the ledger's window sum equals the view `windowSumBps()`; `usedBps + roomBps == capBps`.
6. **Settled snapshot**: with `dueC` (1.2) the existing `boxCap()` and `activeNow()` checks still hold; the `held` identity holds with
   settled `locked`; the totals identity of RECORD-V2 2.10 still holds once it has two more terms, `totals.paidToWorkers` and
   `totals.noteClaims` (below): a worker's payment leaves through `TaskMoney` kind 2 and a claimed note through kind 6, and neither is in `totals.drawn`.
7. **Counts**: open rows equal `openCount` and are at most 8; serials in the list are unique; `repeatOf` is smaller than the row's serial.

**One more total** (so the identity stays an identity): `totals.paidToWorkers` (amount) = sum of `TaskResolved.pay`, and
`totals.noteClaims` (amount) = sum of `NoteClaimed.paid`. The identity becomes
`joined + outside = fees + tookOut + drawn + paidToWorkers + noteClaims + pot + box + arriving + locked + notesOwed`. (A note is
claimed out of `notesOwed`; `dust` goes to the pot and is in `potAfter`.) Both are plain sums of events. The step 1 example test and
the app's `numbers-types` get the two fields (additive).

### 2.6 Tests (WP1; each names the guard it protects and is run with the guard off)

The A tests of 8.2 (A1 to A16), each run once with its guard switched off.

### 2.7 The chain helper (small, C14)

The planner already builds a `treasury.settle` job when arrived money waits. It builds one more kind of job: when the ledger has a
taken task with `deadline + 600 s <= now` or an announced task with `expiresAt + 600 s <= now`, and the project's last
`TaskResolved` is older than that, a `treasury.settle` job keyed by (project, the expiry second) so it is made once. It calls the
existing `settle()` only. It **never** calls `returnTask`, `claimNote`, `acceptTask`, `rejectTask`, `cancelTask`, `takeTask` or
`announceTask`; the existing never-list test (35 calls) gains these seven and fails if any is in the allow-list or producible
(the signature check against the ABI stays). Why: a settle returns the money and makes `locked`, the notes and the record true without
a person; it moves no one's money to anyone.

### 2.8 The fixture and the example record (T4)

`scripts/chain-reader-fixture.py` is extended; the file `testdata/pot-run.json` is regenerated (the contracts changed, so every
address and block moves anyway: expect the tests' numbers to follow the run, not the other way round, as step 1 said). Project A's
run gets this section **before its wind-down**, all with `cast`, each transaction at an exact timestamp, on the real unit of 7 days (the chain's clock is set by `evm_setNextBlockTimestamp`, as the fixture
already does for its 115 days):

1. check in; announce T1 (named payee W1, share 1%, max 400), cancel it (state `cancelled`, no money);
2. announce T2 (W1, 2%), check in inside the notice, take at the notice end plus one second (`TaskTaken.amount` equals the
   server's `atMostNow` formula at that settled pot), backer one **takes out a part** (writes a note), accept in part (60%), backer one
   **claims**, a stranger **claims for backer one** (pays backer one only);
3. announce T3 (**open**, no payee), a stranger takes it, the runner **rejects** it (cap given back);
4. announce T4 (W2), take it, a second backer takes out (a note), let it **run out** (move the clock past the deadline), settle by a
   take-out of a third holder, leave the note unclaimed;
5. announce T5 (W2), let the take window pass (**lapse**);
6. announce T6 (W1, 1%) and leave it **in its notice**; announce and take T7 (W1) with a note outstanding and leave it **taken**;
7. **the example block** is the block after T7's take-out note with T6 in notice (so the record shows: 2 open rows, ended rows of
   state `cancelled`, `paid` in part, `rejected`, `returned`, `lapsed`; note rows with claimable money; `cap.frees`; `next`; a
   `repeatOf` case from announcing T2's what once more and leaving it announced, T8);
8. the run then ends as before with a wind-down by choice, which sweeps T6, T7 and T8 (`cancelled`, `returned`, `cancelled`).

`docs/next-version/record-v2-example.json` is **the server's output** for project A at the example block, not a hand-built file:
test `the_example_is_what_the_server_writes` builds the record from the fixture's `books` entry and compares it byte for byte
with the file; running that test with `UPDATE_EXAMPLE=1` rewrites it. The step 1 example (a scratch-script chain) is retired; the
tests that read it follow the new numbers (WP3 and WP1 update their own). The `books` entry per named block holds the raw answers of
every view the builder calls; `the_books_cover_every_call_the_builder_makes` fails if the Python list and the Rust list differ.

### 2.9 The chain loop (`scripts/chain-loop-pot.sh`, `chain-loop-pot-check.py`)

After step 1's walk, on the real unit of 7 days with the chain's clock moved as step 1's loop moves it: a launch's `tasks.book` equals `cast call treasury "tasks()"`; announce, cancel, announce,
check in, move the chain clock past the notice, take, a Take out that writes a note, accept in part, claim by a stranger, a second
task rejected, a third run out and returned by a take-out's settle, a fourth lapsed. At each stop the relay's signed record (kind
39009, read as in step 1) is compared with `cast call`s **by the independent Python checker**: every row's fields against
`taskOf(serial)`, the three buckets, `windowSumBps` and `takeRoomBps`, `money.locked` settled (the checker redoes `dueC`), the
sum of notes against `noteFace`, and the worked-forward pot with `dueC`. New checks: about 30 (the count is printed). It also
checks that the helper sent a `settle` for the run-out task with nobody pressing and nothing else, and that `refreshEverySecs` is
600 while a task is open and 3600 after the last one ended.

---

## 3. Relay rules (WP2: `crates/buzz-relay/src/handlers`)

The relay is not the chain and never pretends to be. Its rules do two things: **keep a team's task record from contradicting the
network**, and **make the tie between a task record and its network task checkable** by anyone who reads both. The app's own
checks (5.5) are the safety; these rules are the early, honest refusal.

### 3.1 The tie

- **What-hash** (C4): the network task's `what` is the **event id** of the task record (`task-part` = `task`), 32 bytes. The id is the
  SHA-256 of the signed record, so it commits to the words, the pay (`task-usd`), the helper, the project (`a` tag), the signer and the
  time. Nobody can change a task record after it is planned.
- **Pay amount**: `maxDollars` of the plan must equal `task-usd x 1,000,000`. A plan that differs is shown (1.4) and refused for
  Accept by the app (5.5).
- **Pay-to address**: the address the worker named under their own signature: `task-pay-to` on a **take** (open task, as today) or on
  an **accept** step (a task that names its helper; **new**, C5). The plan's `payee` and the chain's `takenBy` must equal it.
- **Serial**: not in any relay record (C6). The relay never needs to name it: `what` finds the plan, the plan's serial is in the
  server's record. (A relay record that carried the serial could be written before the plan exists, or for the wrong plan.)

### 3.2 Tag changes and no new kind (C25)

| Change | Where | Rule |
|---|---|---|
| `task-pay-to` is allowed on the **`accept`** step of a task that names its helper, as well as on `take` | `launch_update_authority.rs::check_money_tags` (`task-pay-to` => `TaskPart::Take` becomes Take or Accept) and the doc table | still one at most, still `0x` and 40 hex digits, still under the helper's own signature (accept is the helper's step) |
| No other tag is added or changed. No new `task-part` value, no new kind in `crates/buzz-core/src/kind.rs`. | | `kind.rs` has a test that asserts 47003 stays the only task kind; WP2 adds none |

The app's builder follows: a new `agreeRecord(coordinate, task, payTo)` for the helper's `accept` step carries `task-pay-to` (WP5 owns the helper's side, in
`tasks/chain/holder/agree-record.ts`, which builds its own tags from the exported `TASK_LABEL` and `KIND_LAUNCH_UPDATE`; `task-record.ts` stays WP4's and is not edited for it). The command line gets `accept --pay-to` (WP2, 7.1).

### 3.3 What the relay refuses (new file `handlers/task_chain.rs`, called from `launch_update_authority.rs` after `decide`)

`task_chain::chain_task_of(pool, reader, chain_key, project_id, what) -> ChainLookup` reads the reader's rows in `chain_logs` (the
same database, the same `reader` the manager reads: `state.chain_reader.reader_id()`), following the precedent of
`api/manager/cost.rs::first_backing`: the project record's `chain-key` tag gives the key, a `ProjectLaunched` row for that key must
carry `projectId` equal to `cost::project_id(coordinate)` (a launch made for someone else's record is not this project), then the
project's `tasks` rows are read by `idx_chain_logs_project` and the plan is the `TaskAnnounced` row whose `decoded->>'what'` equals the
task id. The answer is `NoReader` (no reader configured), `NotRead` (the key's launch is not in the rows yet), `Absent` (the project is
read and has no plan with this `what`), or `Plan { serial, state, payee, taken_by, max_dollars, paid_tx }` where the state and
`taken_by` follow the latest `TaskTaken` and `TaskResolved` rows of that serial, and `paid_tx` is the stored `tx_hash` of a
`TaskResolved` of state 3. A failed read is a server fault and **refuses the write** (an outage never lets a record past a check:
the rule of `task_takes.rs`).

Applied to task steps whose task has a **live** plan (`Plan`: announced, taken or paid; a plan that ended unpaid ties nothing, 3.5), by step:

| Step | Refused when | Message (a constant; `retry:` marks "ask again soon") |
|---|---|---|
| `take` (open task) | no `task-pay-to`; or the plan names a payee different from it; or the chain says it is taken by another address; or it ended | `invalid: this task is planned on the network: name the wallet you will take it with` / `invalid: the plan on the network names another wallet` / `restricted: this task is already taken on the network by another wallet` / `restricted: this task's plan has ended on the network` |
| `accept` (named helper) carrying `task-pay-to` | the plan's payee differs | `invalid: the plan on the network names another wallet` |
| `confirm` (team accepts work) | the chain does not say `paid` for this plan; or `task-paid` is missing or is not the transaction that paid it (`paid_tx`) | `retry: the network has not shown this payment to the server yet; try again in a minute` when the chain says `taken` or the reader has not read the block; `invalid: pay it on the network first, then record it` otherwise; `invalid: that is not the payment that paid this task` |
| `cancel` (team stops the task) | the chain says the plan is `announced` or `taken` | `invalid: withdraw or send back the money on the network first` |
| `send-back` (returns work for changes), `evidence`, `more-time`, `give-up` | never refused by this module (they move no money; the network has its own deadline) | |
| `task` (a new task record) | never | |

When the lookup says `Absent` or `NoReader`, **nothing changes**: tasks without a plan work exactly as in step 1 (step 1 box pay),
and so do all tasks that exist today (3.5). When it says `NotRead` the rule that needs the plan lets the record through **except
`confirm`**, which is refused with `retry:` (an accepted-and-paid record must be tied before it is written). The app maps the prefixes of these messages (`retry:`, `invalid:`, `restricted:`) to its own sentences in `tasks-copy.ts` (WP4) and never shows a prefix. The reader's lag can
make the relay too lenient on a take; it can never make the app pay wrongly, because the app re-reads the chain (5.5).

### 3.4 `take_caps` and caps

`enforce_take_caps` (20 takes a day) is unchanged. The chain tie does not add a per-account cap.

### 3.5 What happens to tasks that already exist

Nothing is rewritten. A task with no plan is a step 1 task: accept, pay from the box (`AcceptAndPay`, `PayFromBox`) as built.
"Records stored before this check existed are not looked at again" (the module's own rule) extends: an old `confirm` is never
re-judged. A team may **plan** an old task that is accepted with the pay owed (the plan door, 5.1): the later `payRecord`
(a second `confirm` naming `task-paid`) is then tied to the network payment by the same rule. A task the team has cancelled stays
cancelled; a plan whose `what` is a cancelled task record is not offered by the app. **A plan that ended without a payment (cancelled, lapsed, sent back, ran out) no longer ties anything:** the
rules of 3.3 treat the task as having no plan, so a team that withdrew a plan can pay a small task from the box and record it, or plan it again.

### 3.6 Tests (WP2)

Pure tests of the decision function (one per row of the table above, each fails when its refusal is removed), and Postgres tests
beside `task_takes_postgres_tests.rs`: a real `chain_logs` fixture built from the fixture run (`testdata/pot-run.json`: the
`ProjectLaunched` row and the book's rows are inserted as the reader stores them) and records signed by real keys: take with
another pay-to refused; take before and after the plan; confirm without a payment refused with `retry:`; confirm with the right
transaction accepted; confirm naming another task's payment refused; cancel while announced refused, after the network cancel
accepted; a plan of another project (same `what`, another chain key) ignored; a launch made for another record ignored; an outage
(reader table unreadable) refuses the write; no reader configured leaves step 1 behaviour byte for byte (the existing tests all pass
unchanged).

---

## 4. Shared library (WP3: `packages/creaton-core/src/pot`, `scripts/pot-app-abi.mjs`, the record parser, the shared words)

### 4.1 ABIs

`scripts/pot-app-abi.mjs` adds `TASK_BOOK_ABI` (artifact `TaskBook`) to `abis.generated.ts`; `TREASURY_ABI` is regenerated (it gains
`announceTask`, `takeTask`, `acceptTask`, `rejectTask`, `cancelTask`, `returnTask`, `claimNote`, `noticeFor`, `tasks`, `nextExpiry`,
`locked`, `notesOwed`, the new errors and events). `abi-fresh.test.mjs` (builds the contracts and compares) stays the guard. The
codec must decode a **static tuple return** (`taskOf`); a test uses a vector made with `cast abi-decode` and a real `taskOf` answer
from the chain loop.

### 4.2 The seven call builders (`pot-calls.ts`)

All return `PotCall` data built from the ABI; the seven selectors are pinned against `cast sig` in `pot-calls.test.mjs`
(`announceTask(bytes32,address,uint256,uint16)` `0xf799daee`, `acceptTask(uint64,uint256)` `0xa4e235c2`, `rejectTask(uint64)`
`0xbe99bca8`, `cancelTask(uint64)` `0x6190aab8`; the other three are read from the ABI and pinned the same way).

| Builder | Call | Sender |
|---|---|---|
| `announceTaskCall({treasury, what, payee, maxDollars, shareBps})` | `Treasury.announceTask` | the runner (with a Pair, both signers: proposed through the Pair) |
| `takeTaskCall({treasury, serial, minAmount})` | `Treasury.takeTask` | the named payee; never the runner or a signer |
| `acceptTaskCall({treasury, serial, payDollars})` | `Treasury.acceptTask` | the runner (Pair: both). **There is no `to`**: the money goes to `takenBy` |
| `rejectTaskCall({treasury, serial})` | `Treasury.rejectTask` | the runner (Pair: both) |
| `cancelTaskCall({treasury, serial})` | `Treasury.cancelTask` | the runner (Pair: both) |
| `returnTaskCall({treasury, serial})` | `Treasury.returnTask` | anyone |
| `claimNoteCall({treasury, serial, holder})` | `Treasury.claimNote` | anyone; the money goes to `holder` only. The app always passes the connected account (5.9) |

`serial` is a `bigint` (uint64) everywhere in the library; `what` is 32 bytes; `maxDollars`, `payDollars`, `minAmount` raw dollar units
(`bigint`), refused when not a safe positive amount; `shareBps` an integer 1 to 500 (the builder refuses others before the call).

### 4.3 Readers (`pot-reads.ts`, all through `ReadCall`; chain at the latest block)

`readTask(read, book, serial) -> ChainTaskNow | null` (null when `state` is none), `readOpenSerials(read, book)`,
`readNoticeFor(read, treasury, shareBps) -> {noticeSecs, takeWindowSecs, dueSecs}`, `readTakeRoom(read, book)`,
`readNoteOf(read, book, serial, holder)`, `readClaimable(read, book, serial, holder)`, `readBookOf(read, treasury)` (`tasks()`),
`readActiveEnd(read, treasury)` (`activeEnd()`, for the check-in line and the quiet gate), `readUnit(read, treasury)`, and
`scanNotes(getLogs, book, bookBlock, holder) -> serial[]` (the `NoteMinted(serial, holder)` logs filtered by the indexed holder, from
`bookBlock`, in pages of at most 5,000 blocks, at most 40 pages; a node that refuses the range makes the scan say "could not look",
never "none"). `TakeOutQuote.note` loses its "always zero until step 2" comment.

### 4.4 The shared state and words (new, owned by WP3, used by WP4 and WP5): `app/src/features/tasks/chain/`

```
chain/types.ts      ChainTask, ChainTasks (the parsed section of 1.3 and 1.4; amounts bigint, serial bigint), ChainTaskNow
chain/state.ts      phaseOf, stateWords, nextDateOf, tieOf, acceptGate, doorFor, shareFor, noticeWords, durationWords
chain/words.ts      every sentence of section 5 that more than one screen uses (the error words live in money/pot-copy.ts)
chain/slots.tsx     three slot components TaskCard mounts: <TeamActions/>, <WorkerActions/>, <HolderLines/>
chain/team/TeamActions.tsx      stub (WP3) replaced by WP4
chain/holder/WorkerActions.tsx  stub (WP3) replaced by WP5
chain/holder/HolderLines.tsx    stub (WP3) replaced by WP5
```

Exact signatures (WP4 and WP5 code against these on day one; WP3 changes them only by telling both):

```ts
type Phase =
  | "notice"      // announced, now < noticeEnd
  | "open"        // announced, noticeEnd <= now < expiresAt
  | "missed"      // announced, now >= expiresAt (nobody took it in time; it lapses)
  | "working"     // taken, now < deadline
  | "overdue"     // taken, now >= deadline (ran out, not yet returned)
  | "paid" | "sent-back" | "ran-out" | "withdrawn" | "lapsed";
phaseOf(task: ChainTask, now: number): Phase;
stateWords(task: ChainTask, now: number): { headline: string; detail: string | null };   // 5.4, "can be taken from 3 Dec" etc.

type Tie =
  | { ok: true }
  | { ok: false; why: "no-record" | "what" | "amount" | "payee" | "taker" | "repeat" | "worker-left" | "not-taken" };
tieOf(chain: ChainTask, relay: ProjectTask | null): Tie;   // pure; the relay task is the app's own reading of kind 47003

acceptGate(input: { fresh: ChainTaskNow; shown: ChainTask; relay: ProjectTask | null; now: number; me: string }):
  { ok: true } | { ok: false; sentence: string; sendBackOffered: boolean };

type Door = { door: "box" | "plan" | "too-big"; sentence: string; planAlso: boolean };
doorFor(input: { usd: number; boxCap: bigint; pot: bigint; limits: ChainTasks["limits"]; notice: NoticeFor | null }): Door;
shareFor(maxDollars: bigint, pot: bigint, maxShareBps: number): number | null;   // 5.1, the 10% margin
noticeWords(secs: number): string; durationWords(secs: number): string;          // "16 days 12 hours", on a test network "1 hour 17 minutes"
```

`tieOf` returns, in this order and returning the first failure: `no-record` (no task record with id = `chain.what` in the project's
tasks), `what` (the record exists but belongs to another project or is not a `task` record), `amount` (`maxDollars !=
usd x 1e6`), `payee` (`chain.payee` is null or differs from the record's pay-to), `taker` (state taken or paid and `takenBy` differs
from the record's pay-to), `repeat` (`repeatOf != null`), `worker-left` (the record's worker gave up), `not-taken` (the relay
worker never took or agreed). `acceptGate` calls `tieOf` on the **fresh** chain read and adds "state is taken", "not past the
deadline" and "the runner is the sender". Each `why` has one sentence in `chain/words.ts` (5.5).

### 4.5 The parser (`money/numbers-types.ts`, `numbers-read.ts`, owned by WP3)

`ProjectNumbers.tasks: ChainTasks | null | "unreadable" | undefined`. Strictness as step 1 (amounts bigint, times bounded, addresses
and bytes32 shaped, no negative or absurd number), plus: at most 8 open and at most 32 ended rows, unique serials, `openCount`
equals the open rows, `repeatOf < serial`, `state` one of the seven words, `notes.holders` at most 20. A section that fails
is `"unreadable"`, the rest of the record is read (1.6). New totals fields `paidToWorkers`, `noteClaims`. The parser test reads the
**new example** (`record-v2-example.json`, WP1) and a hostile set (attack 9, 8.1).

### 4.6 Every new error, in words (`money/pot-copy.ts`; `ERROR_WORDS` is keyed by every error name, so it does not compile until each has words)

`ABIS` and `PotErrorName` gain `TASK_BOOK_ABI`. New `PotAction` values: `"plan-task"`, `"take-task"`, `"pay-task"`,
`"send-back-task"`, `"withdraw-task"`, `"return-task"`, `"claim-note"`. The test `pot-copy.test.ts` walks every error of every ABI (the
book's included) and every action; the existing `team-copy.test.ts` rule (an error with no words fails) covers the new ones.
Percent words below come from the arguments (`bps / 100`); dates come from `timeText`. Each sentence says what happened and what to do next;
none shows a name, code or hex.

| Error (from) | Sentence |
|---|---|
| `BadInput` (book, Treasury; **extend the existing entry**) | `plan-task`: "A task needs its record, at least 1 dollar and a share of the project's money from 0.01% to 5%. Nothing changed." `pay-task`: "Pay more than nothing, or send the money back instead. Nothing was paid." (existing variants and `any` stay) |
| `ShareTooBig` | "That is more of the project's money than one task may ask for. Plan it in smaller parts. Nothing changed." |
| `TooManyOpen` | "The most tasks are already planned or taken. Wait for one to end, or withdraw one that nobody has taken. Nothing changed." |
| `NoSuchTask` | "The network does not know that task. Nothing changed." |
| `WrongTaskState` | `take-task`: "This task cannot be taken now: it was already taken, withdrawn or has ended. Nothing changed." `pay-task`, `send-back-task`: "This task is not waiting for a payment: it may already be paid, sent back or have run out. Nothing was paid." `withdraw-task`: "Someone has taken this task, so it cannot be withdrawn. Send the money back instead. Nothing changed." `any`: "This task is not in a state this step works on. Nothing changed." |
| `NoticeRunning(readyAt)` | "The notice is still running. This task can be taken from {time}. Nothing changed." |
| `TakeWindowOver` | "The time to take this task is over, so it lapses and nothing was set aside. Ask the team to plan it again." |
| `CapReached(used, add, cap)` | "Too much of the project's money has been set aside for tasks recently: {used} of the {cap} the limit allows, and this task needs {add}. It can be taken once earlier tasks are old enough to stop counting. Nothing was set aside." |
| `TakesFull` | "The limit on tasks taken recently has been reached, so this one cannot be taken yet. Try again later. Nothing was set aside." |
| `TooLittleCash(min, got)` (**extend**) | `take-task`: "The project's money moved, so only {got} dollars would be set aside, less than the {min} you asked for. Nothing was taken. Look again and press again." |
| `TooMuch(amount, available)` (**extend**) | `pay-task`: "That is more than the {available} dollars set aside for this task. Pay less. Nothing was paid." |
| `NotYet(readyAt)` (**extend**) | `return-task`: "This task is not past its deadline yet. The money can be returned from {time}. Nothing changed." `claim-note`: "This task has not ended yet, so there is nothing to claim. It ends by {time}." |
| `NothingToPay` (**extend**) | `claim-note`: "There is nothing to claim here: the task was paid in full, or you already claimed. Nothing changed." |
| `NotAllowed` (**extend**) | `plan-task`, `send-back-task`, `withdraw-task`: "Only the person who runs the project can do this (with two people running it, both must say yes). Nothing changed." `pay-task`: "Only the person who runs the project can pay for a task, and not someone who took the task and now also runs the project. Nothing was paid." `take-task`: "This task is for someone else, or you run this project and so cannot take its tasks. Nothing changed." |
| `ProjectQuiet` (Treasury) | "The team has not checked in lately, so no task can be planned or taken until they do. Nothing changed." |
| `Inconsistent` (book, Treasury) | "Something in the project's numbers did not add up, so nothing was done. Nothing changed. Try again in a moment." |
| `BadSetup` (book) | already worded (same name). |
| `AlreadyWoundDown` | already worded: it covers plan and take on a wound-down project. |

### 4.7 The Pair kinds and their four sentences (`pot/pair-terms.ts`, the app's live Pair describer)

`describePotCall` is the function the Pair confirm sheet uses (`team/pair.ts::describeProposal` is the parked step 1 version; the
report's "KINDS table" is this function's `switch`). `PairCallKind` gains `"announce-task" | "accept-task" | "reject-task" |
"cancel-task"`. The sentences are the report's, word for word, with the placeholders filled as below; the only changes a copy rule forces
are: `{max}` and `{pay}` and `{set aside}` are written `{n} dollars` (the file's own `smallDollarsText`) and the play-money line is the
sheet's (it already says "play dollars"); `{payee}` and `{takenBy}` are written `{name} ({address})` as every other Pair sentence (`who()`);
`task {serial}` is written `task 3`; `{share}` is `shareBps / 100` percent; durations are `durationWords`.

| Kind | Sentence |
|---|---|
| `announce-task` | "Plan a task: pay up to {max} to {payee, or whoever takes it first}, at most {share} of the project's money. Holders get {notice} notice, so it can be taken from {date}; if nobody takes it within {window} it lapses; once taken it is due {due} later." |
| `accept-task` | "Pay {pay} of the {set aside} set aside for task {serial} to {takenBy}. What is left goes back to the project and to those who took out while it was set aside." |
| `reject-task` | "Send task {serial}'s money back. Nobody is paid." |
| `cancel-task` | "Withdraw task {serial}. It was not taken, so no money moves." |

`{notice}`, `{window}`, `{due}` come from `noticeFor(shareBps)` read from the chain when the waiting call is shown; `{date}` is "if
confirmed now" plus the notice (the proposal lives two units, so the date can move if the second signer confirms late: the sentence
ends with "The date counts from when you confirm." as a second line, C20). For `accept-task`, `reject-task` and `cancel-task`
the facts (`takenBy`, `setAside`) come from `taskOf(serial)` read by `use-pair-waiting.ts`; `describePotCall` gets an extra optional
argument `taskFacts?: (serial: bigint) => TaskFacts | null`. **With no facts the kind is `"unknown"` with the sentence "This is about a
task whose details could not be read from the network, so it cannot be confirmed from here. Try again in a moment."** and the call is
never offered. An optional second line "The task: “{words}”" is shown under the sentence when the task's `what` ties to a task record
(it is not part of the sentence). The decode target is the Treasury (`TREASURY_ABI`), because these four are Treasury calls.

### 4.8 Tests (WP3)

`pot-calls.test.mjs` (selectors against `cast sig`, round trip of every builder, refusals of bad arguments), `pot-reads.test.mjs`
against the `fake-chain.mjs` stub and against a real anvil answer, `abi-codec.test.mjs` (the tuple), `numbers.test.ts`,
`numbers-hostile.test.ts` (attack 9, 8.1), `chain/state.test.ts` (every phase at every edge second: `now = noticeEnd - 1, noticeEnd, expiresAt - 1,
expiresAt, deadline - 1, deadline`; `tieOf` each failure; `acceptGate` each failure; `doorFor` at the cap, one unit over and at zero; `shareFor`
at 5%, 4.55%, 0), `pot-copy.test.ts` (each new error in each action reads as a sentence with no hex, no name, no "revert"), and the
`check:copy` scan over `chain/words.ts`.

---

## 5. Screens, one by one (phone first; WP4 team side, WP5 worker and holder side)

### 5.0 What every task sheet does (the same machinery as Back and Take out, not new)

Every press below is a `PotSheet` (`app/src/features/pot/PotSheet.tsx`) inside a `WalletGate`: one sheet, one press, one signature, the
legal line, "You can take your money out any time." and the play-money line (`PLAY_MONEY_WORDS`: every money screen says it is play money).
What it adds for tasks, once, here:

- **Numbers are read when the sheet opens**: `useQuery` with `staleTime: 0, gcTime: 0, retry: false` (as `TakeOutSheet`). Nothing is
  taken from the record except what is named "from the record" below, and that carries its "as of".
- **`recheck`** (PotSheet's own hook) runs after the account check and right before the send: it reads `taskOf(serial)` again and
  compares it with the snapshot the sheet showed (state, `takenBy`, `setAside`, `deadline`, `payee`). Any difference gives the
  sentence "This task changed while you were looking: it is now {new state words}. Nothing was sent. Close this and open it again."
  and no send. A read that fails stops the press ("The network could not be asked to check these numbers again, so nothing was
  sent. Press again in a moment.", PotSheet's own sentence).
- **A send that may have landed** is never sent again: PotSheet remembers the call under its `action` key (`pending-sends.ts`),
  shows "A step you sent earlier has not been found on the network yet. Pressing looks for it first; nothing new is sent while it may
  still land.", and the press becomes `lookLabel`. A reload or a second tab opens the same sheet in the same state. The `landed`
  check per call (5.12) reads the chain; it is what turns "may have landed" into "landed" or "did not".
- **A Pair runner** (`numbers.runner.isPair`): the runner calls go through `runnerSend(numbers, me, inner)`; the press asks the other
  signer (`PAIR_WORDS`: "This project is run by two. Pressing asks the other signer: nothing happens until they confirm the same
  step."), the done note is `doneWords("pair", ...)`, and the call appears in `PairWaiting` with the sentences of 4.7. A person who is
  neither the runner nor a signer sees the screen's facts and no press.
- **Semantics (rule 7 of the Review-Proven Rules)**: the sheet is the shared `Sheet` (dialog with a title and a description, focus
  goes back to what opened it); a choice is a `fieldset` with a `legend` and radios of at least 44 px; every number has a visible
  label that is its accessible name (the `Line` pattern of `TakeOutSheet`: `dt`/`dd`); a date is text ("3 Dec, 14:05"), never a colour or
  an icon; icons are `aria-hidden`; there is **one** owner of each actionable label (no label on both the row and its button); the
  state headline is one `<p>`; what arrives after the sheet opened is inside `aria-live="polite"`, a refusal is `role="alert"`; a
  list of tasks is `<ul>` with one `<article aria-labelledby>` per task; text sizes are rem tokens (`text-sm`, `text-xs`, `text-2xs`;
  the CI guard `check:px-text` fails on others); no word of a contract, event or error appears in copy (`check:copy`).
- **Files stay small**: one component per file (the app's file-size gate), each sheet with its words in `chain/words.ts` or its own
  `*-words.ts`.

### 5.1 The two doors, and the door rule (T3) (WP4: `tasks/chain/team/DoorChoice.tsx`, `chain/state.ts::doorFor`)

Where: on a task card (team side) once a person has taken the task or agreed to it and named a wallet, for a task that is not yet
accepted and paid, and on an accepted task that still has "pay owed". It shows one proposed door and one sentence; the other door
stays one press away when it is valid.

**The rule (the design names it, 2.3: the allowance is the small, any-day door; tasks above it are planned):** with `usd` the task's pay
in dollars and `boxCap` the most the allowance box can hold (`allowance.boxCap` in the record, read again from `boxCap()` on the chain
when the sheet opens):

| Case | Proposed door | Sentence (the app's own words; `{cap}` and `{notice}` are filled) |
|---|---|---|
| `usd x 1e6 <= boxCap` and `boxCap > 0` | **box** (step 1, `PayFromBox`, unchanged) | "This is small enough for the allowance box, which can hold up to {cap} dollars. The team can pay it any day, with no notice." |
| `usd x 1e6 > boxCap` and the share fits (`shareFor` is not null) | **plan** | "This is more than the allowance box can hold ({cap} dollars), so it is planned: holders get {notice} notice before any money moves, and anyone can take their money out first." |
| `boxCap == 0` (allowance off or no money in it) and it fits | **plan** | "The allowance is not paying into the box, so this is planned: holders get {notice} notice before any money moves, and anyone can take their money out first." |
| the share does not fit (`shareFor` is null: the pay is more than 4.5% of the project's money, the most one task can ask for after the margin) | **too-big** (no press) | "This is more of the project's money than one task may ask for. Plan it in smaller parts, or pay part of it from the allowance." |

`planAlso` is true when the proposed door is box and the share fits: a second line "Plan it instead, so holders get notice first."
opens the plan sheet. The plan door is never hidden for a small task (a team may prefer to give notice), and the box door is never
offered for a larger one (the contract would refuse it). A pay split into pieces under `boxCap` is allowed: the allowance is a rate
of the project's money, drawn at the team's will whatever the reason (design 2.3a), and notice is the protection for what is
larger. The sentence is shown beside the press, always, so the person sees why.

### 5.2 Plan the pay (WP4: `tasks/chain/team/PlanSheet.tsx`, `plan-read.ts`, `plan-words.ts`)

Where: the plan door of 5.1, from the task card (Tasks tab). Visible to the runner, and to a Pair's signers; others see 5.4 only.

Reads when it opens (chain): `tasks()`, `nextSerial`, `openSerials` and `taskOf` of each open serial (to find the same `what`),
`noticeFor(shareBps)`, `activeEnd()`, `unit()`, `boxCap()`, the account, the door. From the record, with its "as of": `money.pot`
(for the share), `tasks.limits`, `tasks.cap`.

The share is `shareFor(maxDollars, pot, maxShareBps)`: `ceil(maxDollars x 10,000 x 1.1 / pot)` ten-thousandths, at least 1, at most
`maxShareBps`; null when it passes (C8). The 10% margin makes the contract's "smaller of the dollars and the share of the pot at the
take" bind on the dollars unless the project's money fell by more than a tenth between now and the take. It is shown, not hidden.

```
Plan the pay for “{what}”                                  [x]
Pay to        {name}  {0xfull…address}   (the wallet they named)
Up to         {max} dollars
              at most {share}% of the project's money; if people take out first, less is set aside
Holders get {notice} notice. It can be taken from {date}.
If nobody takes it within {window}, it lapses and nothing moves.
Once taken, it is due {due} later.
The team must check in again before {date} or it cannot be taken. The last check-in counts until {activeUntil}.
Room under the limit for tasks now: {room}% of the project's money. This one needs about {share}% when it is taken; if there is not enough room then, it waits until earlier tasks are old enough to stop counting (from {date}).
{door sentence of 5.1}
This is play money.            You can take your money out any time.   [legal line]
[ Plan this task ]            (a Pair: [ Ask the other signer ])
```

`{notice}`, `{window}`, `{due}` come from `noticeFor(share)` read now; `{date}` is now plus the notice ("if you press now"). `{name}` is the
person's profile name from the task record's worker (and the full address is always shown, as the Pair sentences do). Done: "Planned. Holders
can see it now, and anyone can take their money out before {date}." (Pair: "Asked. It is planned when the other signer confirms.")

Blocks (no press, a sentence, `data-testid="plan-blocked"`): the record is older than 24 hours ("We could not refresh this project's numbers, so a plan
cannot be sized now. Try again in a moment."); the project is quiet (`activeEnd <= now`: the `ProjectQuiet` sentence with "Check in first");
8 tasks open ("The most tasks are already planned or taken..."); the same task is already planned (an open row whose `what` equals the record's
id, read from the chain: "This task is already planned: it can be taken from {date}."); the task record is not one that ties (`tieOf` against a
hypothetical row: the worker named no wallet: "{name} has not named a wallet to be paid at, so this cannot be planned. Ask them to agree to the task
first."); the share does not fit (5.1, too-big); wrong network (the gate); a wallet that is not the runner or a signer (the gate's sentence).

Presses and signatures: one press, one wallet signature (`announceTaskCall`; the platform's play dollar needs none for a plan). With a Pair: one
proposal signature now, the second signer's confirmation later. `landed`: `nextSerial` read now is above the one read when the sheet opened and
a serial in between has `what` equal to this record's id. `detail` (80 characters): `{what first 16 hex}:{nextSerial before}`. `action`:
`plan-task:{chainId}:{treasury}:{what}`. A second press of the same plan while one may have landed looks first; a second plan of the same task is
refused by the `recheck` ("This task is already planned").

### 5.3 What everyone sees about a planned or running task (WP5: `tasks/chain/holder/HolderLines.tsx`, `PlannedStrip.tsx`) (T5)

Three places show it, all from the record (`tasks.list`), all with the record's "as of" when it is old (1.6):

1. **The project page**, above the tabs, one strip per open task while it is `notice`, `open` or `working` (at most 3 shown, "and {n} more" opens the Tasks tab).
2. **The Money tab**, a section "Planned and running tasks" with the same lines and the room under the cap.
3. **The Tasks tab**, the task's card (5.4).

**A planned task in two lines (T5)**, for every viewer, signed in or not:

> **The team plans to pay up to {max} dollars to {name or "whoever takes it"} for “{what}”, from {date}.**
> **You can take your money out before then. {max} is the most; it can be less if people take out first.**

`{what}` is the task record's words when the plan ties to a record (`tieOf` ok), else "a task" (the numbers are the network's and shown
all the same; the words are not trusted when they do not tie). `{name}` is the profile name of the pay-to, else the short address; the
full address is in the Details fold. `{date}` is `noticeEnd`: "from 3 Dec, 14:05". While `now >= noticeEnd`, the first line is "...
it can be taken until {date}." and the second is unchanged. Below, in `text-sm text-muted`: "{atMostNow} dollars would be set aside today
(a share of the project's money). This can go up or down. It is not a return." (`NOT_A_RETURN`, `atMostNow` from the row). A button
"Take out" (the existing sheet, 5.11) sits next to it on the project page for a holder. Phone: the two lines wrap, the date never truncates
(`break-words`), the strip is one card with one heading.

**A taken or ended task** (the lead's alert kinds, 6): "{name} took “{what}”. {setAside} dollars are set aside until {deadline}." / "“{what}” was paid {pay}
dollars." / "“{what}” was sent back. Nothing was paid; the money went back to the project." / "“{what}” ran out. Nothing was paid; the money went back." /
"The plan for “{what}” was withdrawn." / "Nobody took “{what}” in time, so it lapsed. Nothing moved."

### 5.4 The state words (T2): one table, one function (`chain/state.ts::stateWords`)

Every state the app names is a function of the row and `now`, and a row comes from the record, which comes from the network.

| Phase | Headline (`data-state`) | Detail line |
|---|---|---|
| `notice` | "Planned. Can be taken from {date}." | "{name} would be paid up to {max} dollars." |
| `open` | "Can be taken now, until {date}." | the same |
| `missed` | "Lapsed. Nobody took it in time." | "Nothing moved." (the network marks it at the next step; the words do not wait) |
| `working` | "Taken, due {date}." | "{setAside} dollars are set aside for it." |
| `overdue` | "Ran out. The money goes back to the project." | "Anyone can return it now." (5.9) |
| `paid` | "Paid {pay} dollars." | when `pay < setAside`: "Paid {pay} of the {setAside} set aside; the rest went back." |
| `sent-back` | "Sent back. Nothing was paid." | "The money went back to the project." |
| `ran-out` | "Ran out. Nothing was paid." | "The money went back to the project." |
| `withdrawn` | "Withdrawn." | "Nobody took it, so no money moved." |
| `lapsed` | "Lapsed. Nobody took it in time." | "Nothing moved." |

A task record with **no** plan keeps its step 1 words (`STATE_WORDS`), unchanged. A task with a plan shows both lines: the network's
headline first (bold), the record's own step under it ("Work handed in") in muted text; they never swap, and a team record that says
"Accepted" while the network says `taken` shows "Taken, due {date}." with the record's step beside it.

### 5.5 Accept in full or in part, and what the app checks before it offers the press (WP4: `AcceptSheet.tsx`, `chain/state.ts::acceptGate`) (T2)

Where: the task card, for the runner (or a Pair's signer), when the relay task is `submitted` (work handed in; same as step 1) and the network
task is `taken`. A task whose pay is owed from step 1 (accepted, no payment) and that has a plan is also offered it.

**Before the press is offered the app reads `taskOf(serial)` from the chain (not the record) and runs `acceptGate`.** It offers Accept only when all of
this holds; otherwise it shows the one sentence below, offers "Send the money back" (5.6) where the money is set aside, and nothing else:

| Check | Sentence when it fails |
|---|---|
| The task on the network is `taken` (not announced, paid, sent back, ran out) | "This task is not waiting for payment on the network: {state words}. Nothing can be paid." |
| `block.timestamp < deadline` (read from the latest block's time, or the app clock with 60 seconds of room) | "The deadline passed on {date}. The money goes back to the project and cannot be paid now." |
| `takenBy` equals the pay-to address in the task record of **this** task (`tieOf`: `taker`) | "The network says this task was taken by {addr}, but the person who took it here named {addr2} to be paid. Nothing can be paid until they match. You can send the money back." |
| The plan's what-hash is the id of this task record and the pay equals the record's (`tieOf`: `what`, `amount`) | "This plan on the network is not for this task as it was written here ({reason}), so it cannot be paid from here. You can send the money back." |
| No earlier plan of the same record exists (`repeatOf` null) | "This task was planned more than once on the network (task {n} came first), so only the first can be paid. You can send this money back." |
| The record's worker is still the worker (they did not give up), and the sender is not the worker, nor runs the worker, nor is an agent (`checksOwnWork`, step 1) | the step 1 sentences (`TASK_PROBLEM.ownWork`, `notRunner`) |
| The money is in a bucket the pay can reach: `setAside > 0` | "Nothing is set aside for this task, so nothing can be paid." |

Sheet when the gate is ok:

```
Pay for the work on “{what}”                                     [x]
Pay to          {name}  {full address}            (the wallet that took the task)
Set aside       {setAside} dollars, due {deadline}
(•) Pay all {setAside} dollars
( ) Pay part:  [ amount ] dollars        (at least 1 dollar, at most {setAside})
What is left goes back to the project and to the people who took out while it was set aside.
This is play money.   You can take your money out any time.   [legal line]
[ Pay {pay} dollars ]       (a Pair: [ Ask the other signer ])
```

Pay part: `payDollars` is a whole number of cents from 1 dollar to `setAside` (`TooMuch` and `BadInput` are the contract's own refusals,
worded in 4.6). "What is left" line gives the figure: "{rest} dollars go back." The press sends `acceptTaskCall({serial, payDollars})`
(**there is no payee argument**; the money goes to `takenBy` and to nobody else). Done: "Paid {pay} dollars to {name}." On landing the app writes the
team's record, as step 1: `acceptRecord(project.coordinate, task, handIn.id, txHash)` carrying `task-paid` = the transaction (the relay's rule 3.3 ties
it to the network payment); the step 1 `paid-journal` remembers a payment whose record failed ("The money was sent, but the record that the work was
accepted was not saved. Press again to save it: nothing is paid twice." and `retry:` from the relay reads as "The payment went through. The server has
not read it yet, so the record is not saved. Press again in a minute: nothing is paid twice."). `landed`: `taskOf(serial).state == paid`. `action`:
`pay-task:{chainId}:{treasury}:{serial}`; `detail`: `{serial}:{payDollars}`. The `recheck` is the gate again on a fresh read.

### 5.6 Send the money back (WP4: `SendBackSheet.tsx`)

Where: the task card for the runner, when the network task is `taken` (any time, including after the relay worker gave up or handed in nothing).
(The team's existing relay step "send-back" keeps its meaning, "return work for changes", and its button "Ask for changes". C7.)

> **Send the money back for “{what}”.** Nobody is paid. All {setAside} dollars go back to the project and to the people who took out while it was set aside.

Press "Send the money back" (`rejectTaskCall`; Pair: "Ask the other signer"). Done: "Sent back. The money is in the project again." Blocks: not `taken`
("This task is not holding money: {state words}."). `landed`: state `rejected`. The cap room of this take is given back by the contract when nothing was paid
(the sheet says so in the details: "This does not use up the room the project has for tasks.").

### 5.7 Withdraw a plan (WP4: `WithdrawSheet.tsx`)

Where: the task card for the runner, when the network task is `announced` (any time in the notice or the take window).

> **Withdraw the plan for “{what}”.** Nobody has taken it, so no money moves. The task stays on your list and can be planned again.

Press "Withdraw the plan" (`cancelTaskCall`). Done: "Withdrawn." Blocks: taken ("Someone has taken this task. Send the money back instead.").
`landed`: state `cancelled`. After it lands the app offers (not forces) the relay record's own "Stop this task" (existing step 1 `cancel` step); the
relay refuses that step while the network task is open (3.3), so the order is always network first.

### 5.8 Take the task (WP5: `tasks/chain/holder/TakeSheet.tsx`)

Where: the task card of the worker (the account whose pay-to is the plan's `payee`), phase `open`. Before the date the worker sees the wait line
only: "You can take it from {date}." (no press). A person who is not the payee sees the facts and no press; a task whose payee is null (open to anyone,
made outside this app) shows "Open to anyone. The team chose not to name who is paid." and no press (C9).

Reads: `taskOf(serial)`, `activeEnd()`, the account. From the record with "as of": `money.pot`, the task's `atMostNow`.

```
Take “{what}”                                                     [x]
You are named for this task: {max} dollars at most.
Taking it sets money aside for you now: the smaller of {max} dollars and {share}% of the project's money, about {atMostNow} dollars today.
If the team accepts your work, you are paid what they choose, up to what is set aside, by {due} after you take it. If they do not, the money goes back.
[x] Take it only if the whole {max} dollars is set aside          (checked: nothing is taken if less would be)
This is play money.   [legal line]
[ Take this task ]
```

Unchecked, the least accepted is 1 dollar. The guard is `minAmount`: checked = `maxDollars`, unchecked = `minTask`. The press sends
`takeTaskCall({serial, minAmount})` from the payee's own account (a passkey account or a wallet; the same `PotSheet`). Blocks: the notice is running
(`NoticeRunning` words with the date, no press), the take window is over ("The time to take this task is over, so it lapses..."), the project is quiet
(`ProjectQuiet`: "The team has not checked in lately..."), the cap is reached (`CapReached` words, with the date room comes back from `tasks.cap.frees`),
the sender is the runner or a signer (`NotAllowed`). `landed`: state `taken` and `takenBy` is the account. `action`: `take-task:{chainId}:{treasury}:{serial}`.

Done: "Taken. {setAside} dollars are set aside for you until {deadline}. Hand your work in on the task." After landing the app does not write a relay record (the
chain is the take); the relay worker's earlier `take` or `accept` record carried the pay-to.

**A task that names its helper** (made by the command line or an agent; the app's own "Post a task" makes open tasks): the named helper sees "This task is for you." and a button
"Agree and name my wallet" (`holder/AgreeButton.tsx`), which connects the wallet as `takeRecord`'s press does and writes the helper's `accept` step with `task-pay-to` = that account
(`holder/agree-record.ts`). Until they have, the plan sheet refuses the task (5.2: "{name} has not named a wallet to be paid at"). Nothing else about a named task changes.

### 5.9 Return the money after the deadline (WP5: `ReturnButton.tsx`) and notes (WP5: `NotesSection.tsx`, `ClaimSheet.tsx`)

**Return.** Anyone sees, on a task whose phase is `overdue`, once the chain read says `state == taken && now >= deadline`: "The deadline passed on {date} and nobody was paid.
Anyone can return the money to the project." and a button "Return the money" (`returnTaskCall`). Nothing is signed by the sender except that call (no token). Done: "Returned. The
money is in the project again." `landed`: state `returned` (or `lapsed`). A holder is never required to do it: every take-out, back and claim settles first and returns it too; the button
exists so a person who looks at an overdue task can fix it in one press. `NotYet` words ("This task is not past its deadline yet...") when early. The server's helper also settles (2.7).

**Notes (T1: "the notes list and claim").** Where: the Money tab, a section "Money you can claim", and the same rows on You. It lists tasks
for which the person holds a note, newest first, at most 20, each as:

> **“{what}”: you took out while {setAside} dollars were set aside for it. The task is {ended / still running}.**
> Running: "You will be able to claim up to {face} dollars if it is not paid." Ended unpaid or paid in part: "You can claim {claimable} dollars now." Paid in full: "It was paid in full, so there is nothing to claim."

Ended rows show a button "Claim {claimable} dollars" that opens `ClaimSheet`. How the list is made (S1: a person's position is read from the chain, never from the record):

1. **Candidates**: the record's rows that list the person in `notes.holders`, every ended row with `notesLeft > 0`, and every open taken row; at most 40 serials (the cut keeps the newest).
2. **Reads** (one `eth_call` batch when the section opens, and again when a sheet opens): `noteOf(serial, me)` and `claimableNote(serial, me)` for each candidate. The figure on the button is the chain's,
   never the record's. Rows with `noteOf == 0` disappear.
3. **"Look for money I can claim"** (a link under the section, a press by the person): `scanNotes` from `tasks.bookBlock` for `NoteMinted` logs naming the person, then step 2 for the serials found. This finds notes
   on tasks that left the record's list, and for a person with no Shares left. It says "Could not look just now. Try again in a moment." when the node refuses the range, and never says "none" for a failed look.
4. A person who took out of a project (this browser's own history, `own-history.ts`) sees the section on that project's page even with no Shares.

`ClaimSheet`: "Claim {claimable} dollars for “{what}”. When you took out, {setAside} dollars were set aside for this task. It ended, and {returned} dollars of it came back; you are owed {claimable} dollars now.
The money goes to your account." Press "Claim {claimable} dollars" (`claimNoteCall({serial, holder: me})`). **The holder argument is always the connected account**: the sheet has no way to name another (A6).
Blocks: the task has not ended (`NotYet`), nothing to claim (`NothingToPay`), `claimable == 0` ("This note pays nothing now. Nothing to claim."), wrong account. `landed`: `noteOf(serial, me) == 0`. `action`:
`claim-note:{chainId}:{treasury}:{serial}:{me}`; `detail`: `{serial}:{face}`. One claim per press (no "claim all": each is its own signature and its own check, C27).

### 5.10 The lines on the Back sheet and the Take out sheet (T6) (WP5: `pot/BackSheet.tsx`, `pot/TakeOutSheet.tsx`, `pot/pot-words.ts`)

**Take out.** The existing `takeout-note` line becomes the design's (2.8): shown only when `quoteTakeOut` returns a note above zero:

> "Part of the project's money is set aside for a task, for up to {dueSecs}. You get {cash} dollars now, and up to {note} dollars more if the task is not paid in full."

and a link "Where the notes are claimed" to the Money tab section of 5.9. `{dueSecs}` is the record's `tasks.limits.dueSecs` in words ("14 days"); when the record has none the sentence is
"Part of the project's money is set aside for a task. You get {cash} dollars now, and up to {note} dollars more if the task is not paid in full." The press never waits for the record. **The sheet needs only `quoteTakeOut`**: `good.call` and the minimum cash come from `readTakeOut` as today; the task decoration (the link and `{dueSecs}`) is rendered from props the project page already
holds, never from a query the sheet makes, and a hung or failed read of tasks, notes or the record cannot disable, delay or reword the press (test C13, 8.2: it hangs the record and the book reads and presses Take out). The arriving-money line is unchanged.

**Back.** The existing `back-locked` line (it already shows `quoteBack`'s third number, the settled `locked`) says, when it is above zero:

> "Money set aside for tasks: {X} dollars. You pay for it at full value now. If the task is paid, that cost is shared by everyone who holds; if it is not, the money comes back to the project."

and `none` as today. Numbers stay the chain's `quoteBack`; the sentence is in `pot-words.ts` and both sheets' tests assert it.

### 5.11 The Tasks tab, the project page and the check-in line (WP4 owns `TasksTab.tsx`, `TaskCard.tsx`, `use-tasks.ts`; WP5 owns `ProjectPage.tsx` strips and `ProjectMoney.tsx`)

- **Task card**: the step 1 card plus, when the task record ties to a row, the headline of 5.4 above the record's step, and the slot components
  (`<TeamActions/>`, `<WorkerActions/>`, `<HolderLines/>`, mounted once by `chain/slots.tsx`). A plan with no matching record is its own card ("A planned task with no matching task here: {max} dollars to {addr},
  from {date}") so a team cannot plan something a holder cannot see.
- **The Tasks tab** lists planned and running plans first, then the step 1 tasks, then ended plans. Empty: "No tasks yet" as today.
- **The check-in line** (team only, `chain/team/CheckInLine.tsx`): when a plan is `notice` or `open` and `clock.activeUntil` (record, and `activeEnd()` when the sheet is open) is earlier than the end of the take window:
  "{n} planned task(s) can be taken from {date}, but nobody can take them unless the project checks in again before {activeUntil}. Check in on This week." with a link to the check-in. A plan whose take window opens
  after the quiet date shows "This task cannot be taken unless the team checks in before {activeUntil}." to everyone on its card, so a worker or a holder is never told "can be taken" when it cannot (a teammate who withholds a check-in
  makes the task lapse, never move money: A11).
- **The Money tab** adds "Planned and running tasks" (5.3) and "Money you can claim" (5.9) under "Money set aside for tasks: {money.locked} dollars. Room left for tasks: {roomBps/100}% of the project's money for now; more from {frees[0].at}."

### 5.12 The `landed` check, per call

| Call | `landed` reads | `detail` |
|---|---|---|
| plan | `nextSerial` above the value read at open, and a serial in between has this `what` | `{what16}:{nextSerialBefore}` |
| take | `taskOf(serial).state == taken` and `takenBy == me` | `{serial}:{minAmount}` |
| pay | `state == paid` | `{serial}:{payDollars}` |
| send back | `state == rejected` | `{serial}` |
| withdraw | `state == cancelled` | `{serial}` |
| return | `state` is `returned` or `lapsed` | `{serial}` |
| claim | `noteOf(serial, me) == 0` | `{serial}:{face}` |

A call whose hash changed in the wallet (a replacement) is found by this read, exactly as `TakeOutSheet.landed` finds a take-out by the balance. If the call did not land and the wallet says it
was refused or dropped, PotSheet's own failure words show and the press stays.

---

## 6. Alerts to every holder (T1) (WP5: `app/src/features/alerts/**`, You page, project page)

**Choice (C10): the app derives the alerts from the signed record it already reads.** No relay event, no server write, no new kind.

| Option | Cannot be forged by a teammate | Cannot be missed by a holder who opens the app a week later | Cost | Verdict |
|---|---|---|---|---|
| The server writes a Nostr event per holder per change | yes (server key) | yes | a write per holder per task step, undo on reorg, a new event shape or a tag on 47003 that strangers can also sign, a spam surface | no |
| The team writes an alert event | **no**: the team can omit it or fake it | no | one event | no |
| **The app derives it from the signed record** | **yes**: the record is signed by the server's key (the parser checks signer, `d` tag and the project's founder and id) and made from the chain; a teammate's records change none of it | **yes**: an alert is a property of the record's rows, not an event that passes: a planned task is in the record for its whole notice (at least 14 days) and take window (7), a taken one until it ends, an ended one for 28 days | none on the server | **yes** |

What it does not do, stated: it needs the app opened (push and email are step 3, C25 of the design: until then the page shows notices only, and the claim "a holder who looks every 7 days
always has a week" is the whole claim); a task that was planned **and** ended inside a holder's absence of more than 28 days is not shown (it moved no money they could still act on; a note on it is
found by 5.9).

### 6.1 What an alert is (`alerts/alerts.ts`, pure)

```ts
interface TaskAlert {
  id: string;             // `${chainKey}:${serial}:${kind}`; a changed state is a new id, so it is unseen again
  kind: "planned" | "taken" | "ended" | "claim";
  chainKey: string; projectName: string | null; serial: bigint;
  at: number;             // announcedAt / takenAt / resolvedAt (lapsed: expiresAt) / the note's task's resolvedAt
  urgent: boolean;        // planned and now < noticeEnd: "You can take your money out before {date}"
  stale: boolean;         // the record is past 3R + 60 s: the sentence says "(as of {time})"
  words: string;          // 6.4
}
alertsOf(input: { numbers: ProjectNumbers[]; names: Map<string,string>; me: readonly string[]; held: (chainKey) => boolean | "unknown"; now: number }): TaskAlert[]
```

One row of the record yields at most one alert at a time: `announced` in phase `notice` or `open` => `planned`; `taken` => `taken`; an ended row inside the cut => `ended`; a row whose
`notes.holders` lists one of `me` with `claimable > 0` => `claim` (also). Ordered by `at` descending. `held` says whether the person holds the project (6.2).

### 6.2 Whose alerts (every holder)

A person is a holder of project P when one of their accounts (the connected wallet or passkey account; `useWallets`) holds Shares or Team Shares in P. The set of projects is the union of:
(a) projects whose recent records list one of their accounts in `holders` (`holdingHint(numbers, accounts).listed`, the same read `YourSharesList` makes: 3 pages of 100 records); (b) projects in this
browser's own history (`ownSteps`: their Backs and Take outs); (c) projects whose note rows list them. For a project that is only a hint ("not listed, and the list was cut": `holdingHint.certain` false) the app
reads `shares.balanceOf(me)` and `team.balanceOf(me)` once per project per five minutes (at most 20 projects, newest alert first) and makes alerts only when a balance is above zero or a note exists. A person with
no wallet connected sees no You news and still sees the strips on every project page (5.3). The people who run a project and its team members see the same strips; they are not told apart.

### 6.3 Where it shows

1. **You**: a section "News about your projects" above "Your Shares" (`alerts/NewsSection.tsx`), the 30 newest alerts, each a row with the sentence, the project's name as one link, and the time; an urgent row has a
   second line and a button "Take out" that opens the project's Money tab at the Take out sheet. Empty: "No news about your projects." Never "no news" for a failed read: "News could not be read just now. Your money
   is not affected." with "Try again".
2. **The dot on You** (`useUnseenCount`): counts unseen alerts in addition to what it counts today (the sum, one dot).
3. **The project page**: the strips of 5.3 for everyone, which are also what marks the project's alerts seen.
4. Not built: a chip on Home's project cards, a sound, a browser notification (C28).

### 6.4 The sentences (all text nodes; the task's words are cut at 80 characters and never markup)

| Kind | Sentence |
|---|---|
| planned | "{Project}: the team plans to pay up to {max} dollars for “{what}”, from {date}. You can take your money out before then." |
| taken | "{Project}: “{what}” was taken. {setAside} dollars are set aside until {deadline}." |
| ended, paid in full | "{Project}: “{what}” was paid {pay} dollars." |
| ended, paid in part | "{Project}: “{what}” was paid {pay} of the {setAside} dollars set aside; the rest went back." |
| ended, sent back or ran out | "{Project}: “{what}” ended and nothing was paid. The money went back to the project." |
| ended, withdrawn | "{Project}: the plan for “{what}” was withdrawn." |
| ended, lapsed | "{Project}: nobody took “{what}” in time, so it lapsed. Nothing moved." |
| claim | "{Project}: you can claim {x} dollars from “{what}”. It ended after you took out." |

`{what}` is the task record's words when `tieOf` is ok, else "a task". The list carries the play-money line (`PLAY_MONEY_WORDS`) once, at its top. A record in the "as of" band adds "(as of {time})" to each sentence;
a record past 24 hours makes none (1.6), and the section says "Some projects' news could not be refreshed. Your money is not affected."

### 6.5 Marked read (per device, a convenience)

`alerts/seen.ts`: `localStorage` key `creaton-task-alerts-seen:{relay URL}:{pubkey}`, value `{v: 1, seen: {[alertId]: unixSeconds}}`, every read and write inside `try/catch`, the page correct with no storage
(everything then shows as unseen, never hidden). Opening the You news list marks the listed alerts seen after it renders (as the bell does); opening a project page or its Tasks tab marks that project's alerts seen;
a button "Mark {n} as read" does it by hand. Pruning on every write: keep ids still derived plus ids seen in the last 60 days, at most 500. It never reaches the server or another device (a second device shows
the alert again, which is the safe side).

### 6.6 Tests (WP5; named in 8.2)

Pure: every kind and every phase; the id changes with the state; a relay record that says "paid" while the chain says `announced` makes a `planned` alert; a record signed by another key makes none; a project not held makes none;
`held` unknown reads the balance; two accounts; a week later (`now = t0 + 7 days`) the planned alert is still there with the right date; an ended task 29 days old that is not in the record makes none, while one with notes left does;
seen survives a reload, storage that throws shows everything unseen, pruning never drops a live id; a hostile `what` (markup, 10,000 characters, a right-to-left mark) is a short plain text node. Component: the You section (list
semantics, one link per row, the mark button's label names its count), the dot, the strips. e2e: 8.2.

---

## 7. The work packages (five engineers, six packages)

Engineer A: WP1. Engineer B: WP2, then WP6. Engineer C: WP3. Engineer D: WP4. Engineer E: WP5. The machine is shared (4 CPUs): one heavy build or test at a time per person,
`CARGO_BUILD_JOBS=2 CARGO_INCREMENTAL=0` for cargo, `nice -n 10`, and run the loops (anvil, relay) one at a time. Estimates (engineer-days, a guess): WP1 9, WP2 4, WP3 6, WP4 8, WP5 9, WP6 5 (about 41 days, about
8 engineer-weeks on top of the 5.5 the design gave the contracts; the design's whole step 2 figure of 5.5 was for contracts, server and app and is low: C30).

### 7.1 Ownership (one owner per path; a change to another's path is asked of the owner and waits for their commit)

| WP | Owns (exact) | Does not touch |
|---|---|---|
| **WP1 Server reader and record** | `crates/buzz-relay/src/chain_reader/**` (including `helper/**`, `testdata/**`, `events_table.rs`, `views_table.rs`, `record_tasks.rs`, `ledger_tasks.rs`); `scripts/chain-reader-events.mjs`, `scripts/chain-reader-fixture.py`, `scripts/chain-loop-pot.sh`, `scripts/chain-loop-pot-check.py`, `scripts/chain-loop-query.mjs`; `migrations/0071_chain_tasks_role.sql`, `schema/tables/public/chain_contracts.sql`; `docs/next-version/RECORD-V2.md`, `docs/next-version/record-v2-example.json`, a "Step 2" section of `docs/next-version/READER-V2-REPORT.md` | `handlers/**`, `app/**`, `packages/**` |
| **WP2 Relay rules** | `crates/buzz-relay/src/handlers/launch_update_authority.rs` and `launch_update_authority_postgres_tests.rs`; new `handlers/task_chain.rs`, `handlers/task_chain_postgres_tests.rs`; the `mod task_chain;` line in `handlers/mod.rs`; `handlers/task_takes.rs` (only if needed); `crates/buzz-cli/src/commands/launchpad_tasks.rs` (an `accept` step may carry `--pay-to`, so the command line agrees with 3.2) | `chain_reader/**`, `app/**` |
| **WP3 Shared library, parser, state, words** | `packages/creaton-core/src/pot/**`; `scripts/pot-app-abi.mjs`; `app/src/features/money/numbers.ts`, `numbers-types.ts`, `numbers-read.ts`, `numbers*.test.ts`, `pot-copy.ts`, `pot-copy.test.ts`, `money-copy.ts`; `app/src/features/tasks/chain/types.ts`, `state.ts`, `words.ts`, `slots.tsx`, `state.test.ts`, `words.test.ts` and the three **stub** files (`chain/team/TeamActions.tsx`, `chain/holder/WorkerActions.tsx`, `chain/holder/HolderLines.tsx`) that WP4 and WP5 overwrite; the one-time edit of `tasks/TaskCard.tsx` that mounts `chain/slots.tsx` (made on day 2, before WP4 starts editing that file) | screens |
| **WP4 App, team side** | `app/src/features/tasks/{TaskCard.tsx, TasksTab.tsx, use-tasks.ts, task-record.ts, task-record.test.ts, tasks-copy.ts, AcceptAndPay.tsx, PayFromBox.tsx}` (and their tests); `app/src/features/tasks/chain/team/**`; `app/src/features/pot/{pair-terms.ts, pair-terms.test.ts, use-pair-waiting.ts, PairWaiting.tsx}` and their tests; `app/tests/e2e/pot-plan.spec.ts`, `app/tests/e2e/pot-tasks.spec.ts` (the existing step 1 spec) | the holder files, `chain/state.ts` (asked of WP3) |
| **WP5 App, worker and holder side, with alerts** | `app/src/features/tasks/chain/holder/**`; `app/src/features/alerts/**` (new); `app/src/features/pot/{BackSheet.tsx, TakeOutSheet.tsx, pot-words.ts, ProjectMoney.tsx, YourSharesList.tsx}` and tests; `app/src/features/project/ProjectPage.tsx` (the strips); `app/src/features/you/YouPage.tsx`; `app/src/features/notifications/use-notifications.ts` (the unseen count); `app/tests/e2e/pot-notes.spec.ts`, `pot-alerts.spec.ts` | the team files |
| **WP6 The joined-up loop and report** | `scripts/pot-app-loop.sh`; `app/tests/anvil/pot-tasks.test.ts` and `app/tests/anvil/pot-chain.ts` additions; `scripts/pot-full-loop.sh`, `app/tests/e2e-pot-full/pot-tasks.spec.ts`, `world.ts`; `docs/next-version/STEP2-SERVER-APP-REPORT.md`; the final run of everything | everything else |

Shared files that two people could want, and who gets them: `TaskCard.tsx` is WP3 once (day 2), then WP4; WP5's blocks are components mounted through `chain/slots.tsx`. `ProjectPage.tsx` and `ProjectMoney.tsx` are WP5 only
(WP4's check-in line lives in `TasksTab`). `numbers-*` and `pot-copy.ts` are WP3 only: WP4 and WP5 ask for a field or a sentence by a message to C and wait for the commit. `docs/next-version/*.md` of the record and the
reader are WP1 only. A package never edits a generated file by hand (`events_table.rs`, `views_table.rs`, `abis.generated.ts`, `pot-events.json`, `pot-run.json`, `record-v2-example.json`): it runs the generator.

### 7.2 Order and what each needs from the others

| When | WP | What lands | Needed by |
|---|---|---|---|
| Day 0 | the lead | the step 2 contracts in the main repository, `forge build` in `contracts/pot` | everyone |
| Days 0 to 3 | WP1 **M1** | `events_table.rs` + `pot-events.json` regenerated, `ledger_tasks.rs`, the fixture run with the tasks scenario, the first generated `record-v2-example.json` (rows, notes, cap, next), the record types | WP3 (parser and the example), WP4, WP5 (the real shape instead of guesses), WP2 (fixture rows for its tests) |
| Days 0 to 2 | WP3 **S1** | `types.ts`, the `state.ts` signatures with `unimplemented` bodies, the stubs, `slots.tsx`, `TaskCard.tsx` mounting, the regenerated ABIs, the seven builders | WP4, WP5 (they build against the types and shape-only fixtures labelled `shape-only`, replaced by the real example at M1) |
| Days 0 to 3 | WP2 | the decision function and its pure tests, then the Postgres tests when WP1 M1 lands | WP6 |
| Days 3 to 8 | WP1 **M2** | views, cross-checks, validate, `numbers.rs`, the rolled-forward pot; WP3 **S2**: the parser, `state.ts` bodies, words, errors in words; WP4 and WP5 the screens | WP6 |
| Days 8 to 11 | WP1, WP4, WP5 | **M3** of WP1 (publish path, refresh rule, helper job, the loop script); WP4 and WP5 finish the screens, a11y, the specs | WP6 |
| Days 11 to 15 | WP6 | the joined-up loops and the report; every package fixes what the loops find | the lead |

The two things that must not slip: the **types** (WP3 S1) and the **first generated example** (WP1 M1). If M1 is late, WP4 and WP5 keep building against `shape-only` fixtures and the join is the first test run (a mismatch is then a bug in
the fixture, not a reason to hand-copy numbers).

### 7.3 The checks each package runs before it hands over (nothing is "done" on green CI alone: each runs the thing)

| WP | Commands (from the repository root) | And exercises |
|---|---|---|
| WP1 | `node scripts/chain-reader-events.mjs --check`; `python3 -I scripts/chain-reader-fixture.py --check` (twice: it must give the same bytes); `CARGO_BUILD_JOBS=2 cargo test -p buzz-relay --lib chain_reader`; the same with `-- --include-ignored --test-threads=1 scan_postgres_tests` against the local Postgres and Redis; `cargo clippy -p buzz-relay --all-targets -- -D warnings`; `cargo fmt -p buzz-relay -- --check`; a pgschema apply of `schema/` and the constraint check; `scripts/chain-loop-pot.sh` | the chain loop (about 125 checks): the record equals the contracts, field by field, at its own block |
| WP2 | `cargo test -p buzz-relay --lib launch_update_authority task_takes task_chain`; the Postgres tests (`-- --include-ignored --test-threads=1 task_`); clippy, fmt; `cargo test -p buzz-cli launchpad_tasks` | a real relay with a fixture chain read: each refusal over the wire, with a real signed record |
| WP3 | `node --experimental-strip-types --test "packages/creaton-core/src/**/*.test.mjs"` (`pnpm -C packages/creaton-core test`); `pnpm -C app test -- src/features/money src/features/tasks/chain`; `pnpm -C app check`; `node scripts/pot-app-abi.mjs --check` | every error of every ABI in words; the example parses |
| WP4 | `pnpm -C app test -- src/features/tasks src/features/pot/pair`; `pnpm -C app check`; `pnpm -C app test:e2e pot-plan` (the mock-bridge Playwright spec) | the screens at 360 px and 1280 px, keyboard only, with a screen reader's accessible names read from the DOM |
| WP5 | `pnpm -C app test -- src/features/alerts src/features/pot src/features/tasks/chain/holder src/features/you src/features/project`; `pnpm -C app check`; `pnpm -C app test:e2e pot-notes pot-alerts` | the same, and a week-later open (the app clock moved) |
| WP6 | `scripts/pot-app-loop.sh`; `scripts/pot-full-loop.sh`; `scripts/chain-loop-pot.sh`; `scripts/pot-chain-loop.sh` | the whole thing in a browser against a real relay and a real chain, and the report's numbers from those runs |

Rust rules of CLAUDE.md hold for WP1 and WP2: no `unsafe`, no new `unwrap()` or `expect()` in production paths, doc comments on new public API, `cargo fmt` and clippy clean; the app's rules hold for WP3 to WP5 (rem text tokens only,
the product name from `APP_NAME`, `check:copy`, one component per file under the file-size gate).

`just ci` before the pull request as CLAUDE.md says; the human steps of the pull request checklist (a person tries it) are not skipped and are not marked by an engineer.

---

## 8. The attack list and the test list

### 8.1 What builders and reviewers hold against (each: the defence, and the test that fails without it)

| # | Attack | Defence | Test (8.2) |
|---|---|---|---|
| 1 | **A teammate fakes a task's state** (a task record saying "accepted", "paid", "cancelled") | The state words come only from the signed record (T2). The record is signed by the server's key and checked (signer, `d`, founder and id); it is made from final logs and views at one block. A team record is a record-step under the headline, never the headline. The relay refuses `confirm` and `cancel` that contradict the chain (3.3). | A1, A2, B3, B4, B5 |
| 2 | **An app task tied to another on-chain task** (the plan's `what` points at another record, or the same record is planned twice and paid twice) | `what` is the record's id, so a swap needs another real record; `tieOf` checks id, amount, payee and taker; `repeatOf` marks a second plan of the same record and Accept is off for it; the plan door refuses a record already planned (`recheck` reads the open serials). | A3, C5, C6, D4 |
| 3 | **A pay-to address changed after the plan** | The network fixes `payee` at the plan and `takenBy` at the take; the contract pays `takenBy` only (no `to`); the team record's `task-pay-to` is under the worker's own signature and the relay allows one live take and no re-take after give-up; the app compares `takenBy` with the record's pay-to on a **fresh chain read** before offering Accept and again in `recheck`. A pay-to written later does not exist (a second `take` is refused while one is live). | B1, B2, C4, D2 |
| 4 | **A stale record shown as fresh** | Age rules (1.6): "as of", then the 24-hour replacement; the alert and the strips carry "as of"; a press re-reads the chain and does not read the record's state; `asOf` never goes backwards (step 1 guard); the app uses the newest record by `created_at` and the parser's signer check. | C7, D5, E3 |
| 5 | **A holder who never sees the notice** | The notice is at least 14 days; the strips are on the project page for everyone; the You news and the dot for holders; derived alerts survive a week's absence; the claim stated is the weekly looker's. The honest remainder (a holder who does not open the app for 3 weeks or more; push and email are step 3) is written in the report and on the sheet. | E1, E2, E4 |
| 6 | **A claim sent for another holder** | `claimNote(serial, holder)` can be called by anyone and pays `holder` only (contract); the app's builder takes the connected account and the sheet cannot name another; a test decodes the call data; "Look for money I can claim" scans for the connected account's logs only. | C8, D6 |
| 7 | **Double sends** | PotSheet keeps a call that may have landed and looks it up before any new send; `landed` per call (5.12); the contract's state checks refuse a second pay, take or withdraw (`WrongTaskState`); an announce can double (the contract allows it) and is stopped by the app's `recheck` and marked `repeatOf`; a Pair proposal for the same plan twice is shown once with the same `what` ("already waiting"). | C9, C10, D7 |
| 8 | **The relay lags the chain** (a take or a confirm judged on rows that are not read yet) | `NotRead` lets a take through (lenient) and refuses `confirm` with `retry:`; the app's check never depends on the relay's. | B6, B7 |
| 9 | **Hostile or broken record** (huge numbers, duplicate serials, 9 open tasks, negative, `what` of the wrong length, a row count over the cut, a script in `what`) | `tasks` becomes unreadable on its own; the rest of the record is read; take out works. | C1, C2 |
| 10 | **A stranger takes an open network task** and holds up to 10% set aside for 14 days (report: still open 2) | The app plans only with a named payee (C4); a task the app did not plan, with no payee, shows "Open to anyone..." and no Accept unless it ties; the contract returns the money at the deadline and gives the cap back. | C11, D3 |
| 11 | **The team withholds a check-in so the task cannot be taken** (a grief on the worker) | Nothing moves: the plan lapses; the card says "cannot be taken unless the team checks in before {date}" to everyone; the worker can see it before. | C12, E5 |
| 12 | **Alerts used to spam or mislead** | Alerts are derived, not written; a team record cannot create one; the text is a plain text node, cut at 80 characters. | E6 |
| 13 | **An old record or another project's record replayed** | The parser's `numbersBelongTo` and signer checks (unchanged) and the newest-by-time rule. | C3 |
| 14 | **Leaving slowed by tasks** | Take out reads only `quoteTakeOut` (T6); a hung record or book read cannot disable the press; the note line is a decoration. | C13, D8 |
| 15 | **Wrong network or wrong account at the press** | `WalletGate` and PotSheet's account check (unchanged). | C14 |
| 16 | **A plan sized wrong** (a share so small the worker is short, or so large the notice is long) | `shareFor` (10% margin, at most 5%); the sheet shows the share, the notice and the date before the press; `minAmount` protects the worker. | C15 |
| 17 | **A Pair confirms a plan or a pay it cannot see** | The four sentences (4.7) with the full addresses and amounts; no facts means "unknown" and no press. | C16 |
| 18 | **Money screens that forget they are play money** | `PotSheet`'s line, the strips' and alerts' line, the Tasks tab's line (a test per screen). | E7, D9 |

### 8.2 The tests (each guard has one that fails without it; run it with the guard switched off once and write that in the report)

**Server (WP1, `chain_reader`)**

| ID | Test | Guard |
|---|---|---|
| A1 | `the_ledger_from_the_logs_equals_the_views_for_every_task_after_every_block_of_the_fixture` | the whole port of `TaskLedger` |
| A2 | `a_task_row_one_unit_off_the_view_publishes_nothing` (one test per field of 1.4: state, `setAside`, `stayer`, `noteFace`, `returned`, `notesLeft`, `takenBy`) | the per-row cross-check |
| A3 | `the_same_what_planned_twice_marks_the_later_row_repeat_of_the_earlier` | `repeatOf` |
| A4 | `the_sum_of_every_holders_notes_equals_the_notes_face_and_a_task_paid_in_full_has_none` | the notes check and the void-note rule |
| A5 | `a_run_out_task_is_returned_in_the_settled_pot_and_locked` (a block with a task past its deadline and nobody settling): `money.pot`, `money.locked` equal what a settle at that time gives | `dueC` in `roll_forward` |
| A6 | `the_box_cap_check_still_holds_with_a_returned_task_and_fails_when_the_return_is_dropped` | the order of the roll-forward |
| A7 | `the_cap_window_sum_gives_back_a_take_that_ended_unpaid_and_keeps_a_paid_one` (replay of the fixture's reject and part payment) | `capGivenBack` |
| A8 | `the_ring_frees_list_adds_up_to_the_used_share` | `cap.frees` |
| A9 | `the_amount_a_take_sets_aside_is_the_at_most_now_formula_at_the_settled_pot` (fixture's real takes) | `atMostNow` |
| A10 | `the_book_is_found_from_tasks_ready_and_followed_from_that_block`, `a_rollback_past_it_forgets_it`, `a_project_with_no_tasks_ready_has_tasks_null`, `the_stored_rows_reveal_a_book_the_reader_did_not_follow_yet` | discovery |
| A11 | `the_ended_rows_are_cut_at_32_by_age_and_notes_and_the_record_says_so`; `the_worst_record_is_under_300_kb` | the cuts |
| A12 | `the_task_tuple_is_the_forge_abi`; `the_table_is_the_forge_build` (existing) | generated layouts |
| A13 | `refresh_is_600_while_a_task_is_open_and_3600_after`; `a_task_phase_change_alone_does_not_resign` (facts) | refresh and facts |
| A14 | the example: `the_example_is_what_the_server_writes` (byte for byte), `the_example_obeys_every_rule_of_the_spec` (the independent checks of RECORD-V2 7.3 extended: rows, notes, cap, next, identity with `paidToWorkers` and `noteClaims`), `the_server_accepts_the_example_and_refuses_it_with_a_pot_one_unit_too_high` and `...a_row_one_unit_off` | T4 |
| A15 | helper: `settle_is_planned_for_an_expired_task_once_and_never_for_a_task_not_due`, `the_never_list_gains_the_seven_task_calls` | 2.7 |
| A16 | pgschema: the constraint allows `tasks` in a database made from `schema/` | migration 0071 |

**Relay (WP2)**

| ID | Test | Guard |
|---|---|---|
| B1 | `a_take_with_another_pay_to_than_the_plan_names_is_refused`; `a_take_with_no_pay_to_on_a_planned_task_is_refused` | 3.3 take |
| B2 | `an_accept_may_carry_a_pay_to_and_it_must_match_the_plan`; `a_pay_to_on_any_other_step_is_refused` (existing) | 3.2 |
| B3 | `a_confirm_for_a_planned_task_needs_the_network_payment` (`invalid:`), `...with_another_transaction_is_refused`, `...with_the_right_transaction_is_accepted` | 3.3 confirm |
| B4 | `a_cancel_is_refused_while_the_plan_is_announced_or_taken_and_accepted_after_the_network_withdrew` | 3.3 cancel |
| B5 | `a_plan_of_another_project_with_the_same_what_is_ignored`; `a_launch_made_for_another_record_is_ignored` | the project tie |
| B6 | `a_confirm_before_the_reader_has_the_block_is_refused_with_retry` | `retry:` |
| B7 | `a_reader_that_cannot_be_read_refuses_the_write`; `no_reader_leaves_step_1_behaviour_exactly` | outage and step 1 |
| B8 | `every_existing_task_takes_test_still_passes` (not a new test: the module's existing suite, unchanged) | 3.5 |
| B9 | CLI: `accept_may_carry_pay_to_and_the_record_is_the_one_the_relay_accepts` | agreement |

**Shared library and parser (WP3) and screens (WP4)**

| ID | Test | Guard |
|---|---|---|
| C1 | `numbers.test.ts`: the example parses; `tasks` absent and null parse; a bad row, duplicate serial, 9 open, `openCount` wrong, 33 ended, negative amount, short `what` each make `tasks` unreadable **and the rest parse** | 1.6 |
| C2 | `numbers-hostile.test.ts`: the hostile set of attack 9, none throws | parser |
| C3 | the record of another project or another signer is null | existing, kept |
| C4 | `state.test.ts`: `acceptGate` refuses when `takenBy` differs from the record's pay-to; when `what` is another record's id; when `maxDollars` differs from the pay; when `repeatOf` is set; when the deadline passed; when the sender is the worker | T2 |
| C5 | `tieOf` each failure in order; the same record planned twice marks the later | attack 2 |
| C6 | `PlanSheet`: a record already planned (an open row with the same `what`) is refused at open and at `recheck` | attack 2 |
| C7 | the age bands change the words; a stale record never shows a state as current | attack 4 |
| C8 | `pot-calls.test.mjs`: `claimNoteCall` for the connected account; the sheet cannot name another | attack 6 |
| C9 | `landed` per call (a stub chain that answers "landed" after the press, "not yet" before): the second press looks first | attack 7 |
| C10 | a reload in the middle: the pending send is found again, the press says "Look for ...", and no second send happens (existing `PotSheet` tests cover the machinery; one per call here) | attack 7 |
| C11 | an open network task that the app did not plan shows "Open to anyone" and no Accept | attack 10 |
| C12 | a plan whose window opens after the quiet date says it cannot be taken | attack 11 |
| C13 | `TakeOutSheet`: the press works with the record hung, the book read failing and `tasks` unreadable; the cash and the note line come from `quoteTakeOut` only | T6 |
| C14 | wrong network and wrong account at each new sheet | attack 15 |
| C15 | `shareFor` at 5%, 4.55%, 0, one unit; the sheet shows share, notice and date | attack 16 |
| C16 | `pair-terms.test.ts`: the four sentences word for word; `accept-task` with no facts is `unknown` and not confirmable; a call to another contract is `unknown` | attack 17 |
| C17 | `pot-copy.test.ts`: every error of the book and the Treasury in every new action reads as a sentence (no hex, no name, no "revert") | 4.6 |
| C18 | `doorFor`: at the cap (box), one unit over (plan), `boxCap == 0` (plan), too big | 5.1 |
| C19 | each sheet: loading, read failed, stale record, wrong network, blocked, ok, pending-send, Pair; keyboard only (Tab order, Escape closes, focus returns), accessible names (no duplicate, one owner of each label) | rule 7 |
| C20 | `check:copy` and `check:px-text` pass on every new file | copy rules |

**Holder side and alerts (WP5)**

| ID | Test | Guard |
|---|---|---|
| D1 | `HolderLines`: the two lines for a planned task, with a name, with no name, `atMostNow` below the maximum, in the take window; phone width wraps the date | T5 |
| D2 | `TakeSheet`: only the payee sees a press; the notice running shows the wait and no press; `minAmount` is the maximum when the box is checked and the minimum when not | 5.8 |
| D3 | `TakeSheet`/`WorkerActions`: a runner or a signer is never offered Take | `NotAllowed` |
| D4 | `ReturnButton`: shown only on `taken` past the deadline; `NotYet` words early | 5.9 |
| D5 | `NotesSection`: candidates, chain read overrides the record's figure, a leaver with no Shares sees it, "Look for money I can claim" says "could not look" on a refused range and never "none" | 5.9 |
| D6 | `ClaimSheet`: holder is the connected account; claimable 0 gives no press; a task paid in full gives none | attack 6 |
| D7 | a second tab and a reload in the middle of claim and take | attack 7 |
| D8 | `BackSheet`: the set-aside sentence with money set aside and "none" without | 5.10 |
| D9 | the play-money line on every new strip, list and sheet | attack 18 |
| E1 | alerts: a week later the planned alert is still there | attack 5 |
| E2 | the You news and the dot count unseen; marking read; reload; storage that throws | 6.5 |
| E3 | no alert from a record past 24 hours; "as of" in the band | attack 4 |
| E4 | `held` unknown reads the balance; not held makes none | 6.2 |
| E5 | the strip says "cannot be taken unless the team checks in" | attack 11 |
| E6 | a forged team record makes no alert; a hostile `what` is plain text | attack 12 |
| E7 | a11y: the news list, the strips, the claim list (list semantics, one link per row, labels) | rule 7 |

**Loops (WP6)**

| ID | Check | Where |
|---|---|---|
| F1 | the walk of 2.9 with the record equal to the contracts at each stop | `scripts/chain-loop-pot.sh` |
| F2 | the app's own builders and readers against the chain: plan, take, pay in part, send back, withdraw, return, claim, each refusal in words; the `landed` read after a replaced call; a Pair's whole round for plan and pay with both signers (`app/tests/anvil/pot-tasks.test.ts`) | `scripts/pot-app-loop.sh` |
| F3 | a browser journey against a real relay and chain: the team plans; a stranger and a holder see the strip and the alert; the holder takes out; the worker takes; the team pays in part; the leaver claims; a task runs out and is returned; every number on the page equals the record equals the contracts | `scripts/pot-full-loop.sh` (`pot-tasks.spec.ts`) |
| F4 | the step 1 loops still pass unchanged (95, 24 and the app's) | the three loops |

---

## 9. Not in step 2, and every choice I made

### 9.1 Not in step 2

- **Push and email alerts** (step 3b): this step has the in-app alerts only, and the page says so where it makes the protection claim.
- **The holder room, feed, streaks, share card, the Established badge** (step 3a); **a phone with no wallet browser** (step 3b: the passkey account already sends these calls where it is available, nothing new here).
- **A holder vote or veto** on a task (the design has none; leaving is the veto).
- **A "claim all" notes press**, a note transfer, a note sweep (the contract has none).
- **Open-to-anyone plans made by the app.** The app plans only with a named payee (C4). A network task with no payee made by another tool is shown and can be taken by anyone the contract allows; the app never offers Accept on it unless it ties.
- **A chip on Home's project cards, a browser notification, a sound** (C28).
- **Rewriting any existing task record or re-judging an old confirmation** (3.5).
- **Contract changes.** Two owner decisions are open in the contracts' report and are not touched here: the part-payment band and the arriving-stream stretch (report 8, "still open").
- **The earlier backers, project zero, the platform pool** (steps 3 to 4).
- **A relay-side chain verifier** of anything but the tie rules of 3.3: the relay still does not check money.
- **The AI manager's task notes** (the manager keeps its step 1 behaviour; a check note beside Accept is not built here).

### 9.2 Chosen under the owner's standing go; the owner may overrule

| # | Choice | Alternative |
|---|---|---|
| C1 | The record additions are **additive inside version 2** (the spec's own rule: only removing, renaming or re-meaning a field is version 3). A step 1 app ignores `tasks` and keeps working; a step 2 app with no `tasks` hides the queue screens. | Version 3 (every app and server would have to move on one day, and Take out would go blank on a mismatch, against T6) |
| C2 | A step 2 app facing `tasks` absent says one plain line and keeps the step 1 tasks flow. | Hide tasks entirely |
| C3 | The book is found from the Treasury's `TasksReady` log (a new reader role `tasks`, migration 0071). | Add the book to `ProjectLaunched` (a contract change); call `tasks()` per project at the launch block (a node call per project) |
| C4 | **`what` is the task record's event id**; the app plans only with a **named payee** (the worker's pay-to). | A hash of the task's fields (a second thing to keep in step); open plans (a stranger holds up to 10% set aside for 14 days, report "still open 2") |
| C5 | `task-pay-to` is allowed on the helper's `accept` step as well as on `take`, so a named helper can agree to a wallet before the plan. | The team types the address (a wrong address cannot be told from the worker's) |
| C6 | No serial in any relay record; the tie is `what` only. | A `task-serial` tag (written before the plan exists or for the wrong plan; the relay cannot trust it) |
| C7 | The relay step "send-back" keeps meaning "return work for changes" (button "Ask for changes"); the network's `rejectTask` is the button **"Send the money back"**. | Rename the relay step (breaks the command line and old records) |
| C8 | Share of a plan: `ceil(max x 10,000 x 1.1 / pot)`, at most 5%; a pay above about 4.5% of the project's money is "too big for one task". | No margin (a small drop in the pot short-changes the worker); a bigger margin (a longer notice: 12 hours more per 1%) |
| C9 | A network task with no payee is shown ("Open to anyone") but gets no Take or Accept from this app. | Offer it |
| C10 | **Alerts are derived in the app from the signed record**, marked read on the device, for holders found by the record's list, the app's history, the notes rows and a balance read where the list was cut. | Server-written events per holder; team-written events (6) |
| C11 | Door rule: the box if the pay is at most `allowance.boxCap` (read again from the chain), else the plan; the plan door stays available for a small task; split pays are allowed. | A fixed dollar threshold (a number the founder cannot see and the design avoids); forbid splitting (cannot be enforced) |
| C12 | Refresh every 600 seconds while any task is open. | Leave 3600 (the cap room and `atMostNow` would be an hour old) |
| C13 | Ended rows kept: those that ended in the last 28 days or still have notes, at most 32; 20 note holders per row for the 8 newest rows with notes. | Keep all (unbounded); keep none (a leaver's note unfindable) |
| C14 | The helper settles an expired task (a `settle()` only) 10 minutes after its time. | Nothing (the next action settles anyway) |
| C15 | The Take sheet's default guard is "the whole maximum or nothing" (`minAmount = maxDollars`), unchecked means 1 dollar. | Always the least (a worker could be set aside less than they expect without noticing) |
| C16 | State words "Ran out" for a task that ran out unpaid, beside the lead's seven. | Call it "sent back" (it was not) |
| C17 | Totals gain `paidToWorkers` and `noteClaims` so the identity stays an identity. | Leave the identity without them (it would fail on the first payment) |
| C18 | The example record is the **server's output** for the fixture's project A at one named block, byte-compared by a test; the step 1 scratch example is retired and the tests that read it follow. | Keep both (two sources of truth) |
| C19 | The fixture and the example are one run (`pot-run.json` is regenerated whole; the contracts changed, so every number moved anyway). | A second fixture file (two runs to keep identical) |
| C20 | The Pair's plan sentence ends with "The date counts from when you confirm." as a second line, not a change of the sentence. | Put it in the sentence (a copy change) |
| C21 | A malformed `tasks` section makes only `tasks` unreadable; the rest of the record is believed. | Treat the whole record as bad (Take out and Back would go blank on a task bug, against T6) |
| C22 | A task card shows the network's headline first and the team record's step under it; they never swap. | One merged state (a team word could then decide the headline) |
| C23 | The plan sheet needs a record under 24 hours old (the share needs the pot); the other sheets need none. | Read the pot from the chain (no view returns the settled pot; the contracts' report names that) |
| C24 | The check-in line (a task cannot be taken after the quiet date) sits on the Tasks tab and on every task card. | Say nothing (the contracts' own report: "the app must prompt the check-in before the take date") |
| C25 | No new event kind, no new HTTP endpoint, no relay event for alerts; one tag change (`task-pay-to` on `accept`). | A new kind (CLAUDE.md: tags on existing events first) |
| C26 | The relay judges only plans it can see in its own `chain_logs`; where the reader has not read yet it is lenient except on `confirm`. | Refuse everything until read (a lag would block honest tasks) |
| C27 | One claim per press; no "claim all". | A batch of claims in one signature (each needs its own check) |
| C28 | No Home chip, sound or browser notification. | Build them (step 3) |
| C29 | The report's "KINDS table in `team/pair.ts`" is the live `pot/pair-terms.ts` `describePotCall`; the kinds are named `announce-task`, `accept-task`, `reject-task`, `cancel-task`. | Edit the parked step 1 file (it is not what the Pair sheet reads) |
| C30 | Honest cost: about 41 engineer-days for server and app on top of the contracts, not the design's 5.5 engineer-weeks for all of step 2. | n/a (a correction of an estimate) |

Checked against the product contract: `VISION.md` is the workspace vision (zero-notification defaults, an agent-first command line); this plan adds no push, no sound and no per-holder
write, and its one new surface for holders is a quiet "News about your projects" section and a dot that already exists, about money moving, which is what the design's protection rests on. The direction of the money
(join fast, leave any day, protected by notice and the right to leave) is `JOIN-LEAVE-DESIGN.md`, and this plan follows it. CLAUDE.md asks that agent-facing operations go in `buzz-cli`: the one that
changes here is `launchpad tasks accept --pay-to` (WP2); reading plans from the command line is not built in step 2. The one intentional tension, named: the protection still depends on a holder
opening the app (design 1, "where it is weak"); alerts that arrive without opening the app are step 3b.
