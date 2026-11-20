# Step 2, server and app, joined up: the task queue and exit notes run together in a real browser

Branch `v6`, 20 November 2026. This is the report of the last package of `STEP2-SERVER-APP-PLAN.md` (WP6): the joined-up loops. Step 2
puts the task queue and exit notes of `contracts/pot` (`TaskBook`, `Treasury`) in front of people: the team plans a task so holders get
notice before any money moves, a worker takes it and the money is set aside, a holder who leaves while it is set aside is left a note,
the team pays all or part of it or sends it back, and anyone returns the money of a task that ran out. The server reads it all from the
chain and signs it into the project's numbers record (version 2, a new `tasks` section); the app reads that record for lists and the
chain for every press. Nothing is pushed. **No person has tested any of this: every run below was made by an agent. The human test is the
owner's and is still to do (the steps are in section 7).** This is not legal or tax advice, and no figure here is a promise of any
result for anyone. Every amount is play money on a local test chain. The legal line, quoted as it stands: "Buyers acquire ownership only:
governance and exit. No dividends or revenue share, ever, unless they contribute and earn one."

Companion pages: the plan (`STEP2-SERVER-APP-PLAN.md`), the contracts' report (`POT-STEP2-REPORT.md`), the one specification of the record
(`RECORD-V2.md`, section 10, and `record-v2-example.json`, which is the server's own output at block 88), the server's report
(`READER-V2-REPORT.md`, with its step 2 sections) and step 1's (`STEP1-REPORT.md`, `APP-POT-REPORT.md`).

## 1. What is built, in one page

| Part | What it does | Where |
|---|---|---|
| Contracts | the task queue, exit notes, the 28-day cap on money set aside (untouched by this work) | `contracts/pot` |
| Server: the reader | follows each project's task book (found from the Treasury's `TasksReady` log, migration 0071), rebuilds every task and note from logs, holds each row, note and sum to the contracts' own views at one block, signs the `tasks` section; a mismatch keeps the previous record; arrival and the money of tasks that ran out follow the contract's formula | `crates/buzz-relay/src/chain_reader` |
| Server: the rules | a team's task record (kind 47003) is tied to its plan on the network: a take must name the wallet the plan names, a confirm must name the transaction that paid, a stop is refused while the money is set aside | `crates/buzz-relay/src/handlers/task_chain.rs` |
| Server: the helper | a task that ran out ten minutes ago is returned by a plain `settle()`; nothing else new | `crates/buzz-relay/src/chain_reader/helper` |
| Command line | `buzz launchpad tasks accept ... --pay-to` for a helper a task names | `crates/buzz-cli` |
| App: the team | plan the pay (two doors, one sheet), withdraw, pay in full or in part, send the money back, save on the team's record the transaction that paid, a Pair's second signer reads each of the four calls in words | `app/src/features/tasks/chain/team`, `pot/pair-terms.ts` |
| App: the worker and holders | two lines on every planned task (card, strip above the tabs, Money tab), set the money aside, return the money of a task that ran out, notes: list, look back, claim; the Back and Take out sheets say what money set aside means; news on You and the dot; Take out never waits on any of it | `chain/holder`, `alerts`, `pot` |
| This package | the app's own builders and readers against the real contracts, the joined-up journey in a browser against the real server, the record builder of the browser specs held to the contracts, and this report | `app/tests/anvil`, `app/tests/e2e-pot-full`, `scripts/` |

## 2. What this package built

1. **`app/tests/anvil/pot-tasks.test.ts`** (with `pot-tasks-scene.ts`): the task queue through the app's own readers, gates and call
   builders on the real contracts, one run in which every number compared is read from the chain at that moment and none is typed:
   the Plan sheet's read and the `landed` look for a plan that went through under another hash; a plan and a withdrawal; a take too
   early (the Take sheet's gate and the chain say the same words) and in time, with the guard "take it only if the whole most is set
   aside"; a Take out that writes a note and the app's own note finder reading it from the transaction's logs; the pay sheet's gate,
   its amount rules and a part payment, with the transaction the team's record names read by the task's number; a claim that pays the
   holder and nobody else, at the figure the sheet showed; a task nobody settled that ran out and is returned by a stranger, and the
   holder who left while it was set aside claims the whole; a task sent back (the room under the cap comes back); a plan nobody
   took, over, that can no longer be withdrawn; and a project run by two: a plan and a payment through a Pair with both signers,
   each call said in words from what the network holds, a call about a task that has since moved reading as one that cannot be
   confirmed. Every refusal is read in the app's own words.
2. **`app/tests/anvil/pot-settled.test.ts`**: the settled money the browser specs' record builder works out (new `live-settled.ts`)
   against what the Treasury itself stores after a settle, at seven times, two of them chosen where the step 1 arrival formula and the
   contract's give different roundings.
3. **`app/tests/e2e/helpers/live-record.ts`** now uses the contract's arrival formula and puts the money of tasks that ran out back
   last (`dueC`); its `money.locked` is the settled one, its `ledger` has `arrivalStart`, `arrivalTotal`, `locked` and `notesOwed`, and
   its totals carry `paidToWorkers` and `noteClaims`, all read from the chain.
4. **`app/tests/e2e-pot-full/pot-tasks.spec.ts`** (and `world.ts`): the joined-up journey (section 4).
5. **`scripts/pot-full-loop.sh`** runs two journeys, each in a world of its own (section 5), has `--hold` for an engineer who builds a
   journey, and `--serve` now leaves one planned task for a phone.
6. **`scripts/pot-app-loop.sh`** runs the two new files.
7. **One app fix the loops showed** (section 6, finding 1) and one extraction (`plannedSince`, so the `landed` look is a function the
   loop can call and not a closure in a component).

## 3. What ran, and the exact results

All runs on this machine on 20 November 2026 (4 CPUs, shared with the server engineers; the relay built from the committed source with
`cargo build -p buzz-relay`; Postgres and Redis already running; Chromium from `/opt/pw-browsers`). Nothing below is a CI run; each was made by hand from the repository root unless it says otherwise.

| Run | Result |
|---|---|
| `scripts/pot-app-loop.sh` | **16 tests passed, 0 failed, 0 skipped, in 10 files** (8 files before this package; the two new ones are `pot-tasks.test.ts`, 1 test, and `pot-settled.test.ts`, 1 test) |
| `scripts/pot-full-loop.sh` | **616 checks passed**, 2 journeys passed, 0 failed: the step 1 journey 82 checks + 182 field-by-field comparisons of the record with the contracts + 1 (the reader never refused to sign) = 265 (the browser part 42 s); the task journey 57 checks + 293 field-by-field + 1 = 351 (the browser part 1.3 minutes). Step 1's journey was 213 before: its comparisons are 91 each, twice, because the checker now also compares the task section |
| `scripts/chain-loop-pot.sh` | **758 checks passed**, nine stops, exit 0 (the same count as the helper engineer's two runs) |
| `scripts/pot-chain-loop.sh` | **24 checks passed**. Gas from its real receipts: announce a task 243,498; take 199,839; take out with a note 202,169; accept in part 173,189; claim a note 93,958; return 137,274 |
| `scripts/phone-loop.sh` | **33 claims proven** |
| `tsc --noEmit` (app) | clean |
| `vitest run` (app, all) | **125 files, 1,184 tests, 1,184 passed, 0 failed** (1,183 before this package: the one added is the refusal's date) |
| `pnpm -C packages/creaton-core test` | 1,229 tests, 1,228 passed, 0 failed, 1 skipped (the skip is the file's own) |
| `node scripts/pot-app-abi.mjs --check` | "pot ABIs are current." |
| `biome check .` (app) | clean, 463 files |
| `check:copy`, `check:px-text`, `check:file-sizes` (`CHECK_FILE_SIZES_BASE=0e38c9811`) | pass; knip (`cd web && pnpm check:unused`) clean. `pot-tasks.test.ts` was 1,211 lines at first and was split in three under the 1,000-line limit |
| `pnpm build` (`CREATON_DEPLOYMENTS_FILE=../contracts/pot/deployments/pot-31337.json`) | ok: "index 385 KiB ok" (limit 450,000 bytes), "all scripts 1125 KiB" |
| Playwright, project `smoke`, `--trace off`, `REQUIRE_CHAIN=1` | **94 passed, 1 skipped, 0 failed** (6.5 minutes; the skipped test is the existing `pot-phone.spec.ts:60`, which needs the passkey script and was not looked into). Includes the five new browser specs of the earlier passes (`pot-plan`, `pot-tasks`, `pot-alerts`, `pot-notes`, `pot-a11y`) and the step 1 ones |
| `cargo build -p buzz-relay` | built (4 min 45 s) from the committed source; the relay under test is that binary. No Rust file was changed here, so the server engineers' own test counts stand (`chain_reader` 110, `chain_reader::helper` 16, relay rules 59, `launchpad_tasks` 24) and were not re-run |

Left behind: nothing. Every anvil, relay, preview server and miner started was stopped (checked with `ps`), the scratch databases are
dropped (checked in `pg_database`), the temporary folders and the journeys' app builds removed. Postgres and Redis were already running and are
left running. Disk free was 7.6 GB before and after.


## 4. The joined-up journey, step by step

`scripts/pot-full-loop.sh pot-tasks` starts a local chain, deploys `contracts/pot` with its own script (a real week as the time unit),
starts the real relay with its chain reader and helper, builds the app for that chain and lets the relay serve it, then runs one
Playwright journey in Chromium. Every key is made for the run; the chain's accounts are anvil's public development accounts; nothing
is mocked. The chain's clock is moved with `evm_increaseTime` where the design makes people wait (the notice is 14 days).

1. A **founder** signs up in the app, starts "Beacon", launches it on the chain (one wallet prompt). The server finds the project's task
   book and its record carries a `tasks` section with no task in it.
2. Two **holders** back it with 150 play dollars each; the founder checks in; the server reads the money.
3. The founder **posts a task** in the app (6 dollars) and a **worker**, another profile, **takes** it naming the wallet to be paid at.
   Both are the team's own records, accepted by the real server.
4. The team **plans the pay** from the Tasks tab: "Plan the pay of 6 dollars", the sheet, one wallet prompt. The chain holds the plan
   for the task record's id and the worker's wallet; the server's row has the chain's notice end and most; 47 field-by-field checks of
   the record against the contracts' own views at the record's block.
5. A **holder on another profile** and a **stranger signed out** read the two lines on the project page word for word (who would get
   how much at most, from when, that they can take out first, and what would be set aside today), and the holder reads the news on You
   with the date and the way out.
6. The **chain's clock moves past the notice**; the worker hands work in and **sets the money aside** (one prompt): the chain holds the
   task as taken for the wallet the plan named, the whole 6 dollars set aside; the server's row and the project's money set aside agree;
   field-by-field checks again.
7. A **holder takes out** while the money is set aside: the Take out sheet says part of the project's money is set aside for a task and
   shows where to claim; the cash arrives at once; the holder is owed a note on the task, listed by the server with the chain's own
   face. While the money is set aside, a team record that stops the task is refused by the real server in its own words.
8. The team **pays 4 of the 6 dollars**: "Pay part", one wallet prompt; the worker's balance rises by exactly 4 dollars; the rest goes back; the
   server's row says what was paid and names the transaction. A team record that names another transaction as the payment is refused by
   the real server. The app saves the payment on the team's record (the server answers "try again" until it has read the payment;
   the card's own press then saves it); the record names the very transaction that paid.
9. The leaver **claims**: the press says what the network says a claim pays, one prompt, exactly that amount arrives, the note is spent;
   the holder who stayed reads how the task ended on You.
10. A second task is planned and taken on the chain and **nobody settles it**; its deadline passes; **the server's helper returns the money**
    ten minutes later with one plain settle. The record reads it as ran out; the holder's news, the Money tab's room under the cap and
    the team's Tasks tab all read as the record does; the helper's jobs are only the two calls it may send.

At steps 4, 6, 7, 8, 9 and 10 the record the server signed is compared with the contracts at the record's own block by
`scripts/chain-loop-pot-check.py --stop`: the frame, the money, the totals, the whole task section (every row against `taskOf`, every
listed note against `noteOf` and `claimableNote`, the buckets, the cap, the counts and the limits), and the settled numbers worked
forward on their own.

## 5. Why two worlds

The server dates a record with its own clock (`builtAt`); the chain's clock is moved by days in these journeys. A chain that is days
ahead of the server reads, for the rest of that world, as an old record. That is a test chain's artifact (on a live chain the two clocks
are the same), but it would make the step 1 journey's later steps, and the Plan sheet, read "old". So the step 1 journey and the task
journey each get a world of their own, started one after the other; the app is built once (the contracts land at the same addresses on a
fresh chain, and the script checks).

## 6. What the loops showed

### 6.1 What the loops found (each one named, and what became of it)

1. **A node's refusal lost its date and its amounts (fixed, app).** A node words a refusal as `custom error 0x7a537613: <data>` and also
   carries the whole revert in `data`. `potRefusalOf` took the first blob it found, which was the bare selector in the message, so the
   words read "This task can be taken from 1 Jan, 00:00" in place of the notice's end, and every refusal with an amount would have
   lost it. The refusal is now read from the longest blob. The unit test fails with the sort switched off; the anvil loop (the take
   too early, said in the app's words and the gate's words alike) found it.
2. **The step 1 record builder of the browser specs used a different rounding (fixed, tests).** `live-record.ts` worked the arriving
   money forward from the last settle; the contract works it from the stream's own start. The two lines are the same on paper and
   differ by a unit after a mid-stream settle. The builder now has the contract's formula and puts the money of tasks that ran out back
   last (`live-settled.ts`), and `pot-settled.test.ts` holds it to what the Treasury stores at seven times. The first version of that
   test passed with the old formula too (the amounts chosen did not tell the two apart); it now finds two times where they differ.
3. **No server defect was found, and none is reported.** The journey made the real server answer every record the app wrote: the task, the
   take, the hand-in, the plan's pay-to rule, the stop that is refused while money is set aside, the confirm that names another
   transaction, and the confirm that follows the payment. No record the server signed differed from the contracts at any of six stops
   (293 field-by-field checks at six stops) and the reader never logged a refusal to sign.
4. **A world whose chain clock is days ahead of the server's reads old (not a defect; a limit of the test chain).** See section 5. It also
   shows the line "Some projects' news could not be refreshed. Your money is not affected." on You once a record is older than a day,
   which is what that line is for.
5. **A task's card can say it was paid in full when only part was, once its row has left the server's list (open; not fixed).** The server's
   list keeps an ended task for 28 days (or while it holds money for a leaver's note). A task paid in part, whose row has aged out and whose
   team record carries the payment, reads on the Tasks tab as "Paid 6 dollars." (the price on the record) and not "Paid 4 dollars." The
   journey met it at its end (the first task, 4 of 6 dollars). Within the 28 days the network's words stand instead, and the card says the
   part. The amount is not on the record's confirm step, and the server's list no longer has the row, so the app cannot say it. Two ways
   out, for the lead to pick: keep a paid row in the list for as long as the team's record names it, or word the card "Paid. The price was
   6 dollars." where a queue exists and no row ties (which is true in both cases). It changes step 1's own wording where a box pays a task, so
   it is not made here.
6. **The news has a 28-day memory for endings.** The first task of the journey ended more than 28 days (of the chain's clock) before the
   run's last record, so its ending is no longer news on You, by the plan's own rule (`cut.endedWithinSecs`); the journey reads it
   while it is news (step 9) and the second ending at the end. A claim on an old task stays on the Money tab for ever.

### 6.2 Guards switched off once (U5)

Each guard of the code this package binds was switched off in the production file, the loop (and where the loop does not reach it, the
unit tests of `src/features/tasks`, `pot` and `money`) run, and the file put back (checked with `git`). 
| Guard switched off | What failed |
|---|---|
| a take before the notice ends | the early-take check (the gate's sentence and the chain's are the same) |
| a take by another wallet | the wrong-wallet check |
| the runner cannot take its own task | first not caught (the next check said another sentence): the loop now says the exact sentence; fails |
| accept: only a taken task; the deadline room; only the runner | the pay-gate checks |
| accept: the taker is the pay-to; money set aside | not reachable on a chain (a named plan can only be taken by its wallet, a take sets money aside): unit tests of the pay gate fail |
| claim: not yet while the task runs; the whole face for a task that ran out | the two claim figures |
| claim: the contract's own rounding | cannot be made to differ on the real contracts: the claim-figure unit test fails |
| the paid transaction's task number; its book | the unit tests of the search fail (a real node already filters by both, so the loop cannot tell them) |
| the plan's `landed` look: this task's id; a number before it | the look for a plan under another hash |
| the sheet's last look: a send that landed is not a change | the stale-call check |
| pay part: the range; whole cents | the amount rules (the cents rule first not caught: `1.505` is now typed in the loop) |
| a Pair call about a task that has moved | the loop: the second signer's sentence reads as one that cannot be confirmed |
| a Pair plan without the notice read | not caught by the loop (without the check the sentence cannot be built and the call reads as unknown all the same); the unit tests of the Pair's sentences fail |
| notes: nothing owed is not listed | the note list |
| the note finder: this transaction | first not caught (nothing could observe it): the loop now asks about another holder's transaction; fails |
| the note finder: this holder | first not caught by the loop; the unit tests of the note finder fail |
| withdraw only before the plan's end; return only after the deadline | first not caught for withdraw (no plan in the loop had ended unsold): the loop now has one; fails |
| a refusal's arguments from the longest blob of a node's message | the unit test (and the take-too-early check of the loop) |
| the settled money: the contract's arrival formula | `pot-settled.test.ts` (it passed at first with the old formula: its amounts did not tell the two apart; the times are now searched for) |
| the settled money: the money of tasks that ran out put back last | `pot-settled.test.ts` |

28 guards in all; 17 failed a test the first time, 11 did not and each now fails one (4 by a new line in the loop, 7 by the existing unit tests of the
app, which the first run did not include). The files were put back each time (`git` shows only the intended changes).


### 6.3 Chosen under the owner's standing go; the owner may overrule

This package:

- **Two worlds for two journeys** (section 5), not one: the alternative is a server that dates its record with the chain's clock, a change
  to the server for a test chain's sake.
- **The journey plans before it moves the clock.** The Plan sheet refuses a record older than its band; with the server's clock real, the
  plan comes first and the days pass after.
- **The second task of the journey is planned and taken on the chain, not in the app**, and has no team record: it is the "a plan with
  no task record here" card that reads it, and the helper that returns it. The first task is the whole app path.
- **The app's builders and readers loop keeps its scene in `pot-tasks-scene.ts`**, not in `pot-chain.ts`: the file already is the
  deploy of the contracts and stays small.
- **`scripts/pot-full-loop.sh --hold` and a planned task in `--serve`** were added for whoever builds the next journey and for a person
  with a phone; neither changes what the script checks.
- **A second journey does not repeat what step 1's does** (launch, Back, allowance, outside money, the helper's fee): it starts at the task.

Gathered from every report of this step (each is also in its own report):

| From | Choice |
|---|---|
| Reader M1 | Two view batches at one block (the cut needs a limit that is a view) instead of one; the one-block rule is kept. `repeatOf` is set only for a row that is itself announced, taken or paid. `cut.endedDropped` counts eligible rows that did not fit, not rows that aged out. Ties for the next date go: can be taken, lapses, due, room under the cap, then the lowest serial. A taken task past its deadline that nobody settled shows its holders' claim as the whole face. A second withdrawn task (serial 9) is in the example inside the 28 days, and the example's serials differ from the plan's labels (taken 6, in notice 7, repeat 8, withdrawn 9); the example is dated day 101.7, so the door is open. The fixture is 965 KB because every snapshot carries every task's raw answer. |
| Relay rules | A plan that is over is judged by the newest block time the reader has stored, not the wall clock. `take` refuses a plan that is paid or over; `confirm` and `cancel` treat an over, unpaid plan as no plan. On a taken plan "taken by another wallet" is said before "names another wallet". A `chain-key` that points at a launch made for another record is lenient (no plan), not "not read". A record whose launch never appears in the rows gets "try again" on every `confirm` (the plan's C26). The Plan type does not carry the most, which the relay never uses. |
| Reader M2, M3 | `pay` is not in `taskOf`, so it is held by `pay + returned == setAside` and `pay == 0` unless paid, in both the cross-check and `validate`. The cap's used share, its frees and `money.notesOwed` are held to the listed rows only when nothing was cut (otherwise the rows are a floor). `next` is written twice on purpose. `ringIdx` is held to its view though the record does not carry it. The 43,200-second ceiling is applied where the promise is made. The slow-pass alarm threshold is half the shorter refresh setting. The plan's "about 19 views per project" is out of date (51 fixed calls, 12 for the book, and per grant and agent). |
| Helper and loop | The task settle reuses the stored call name `treasury.settle` and tells itself apart by its argument, so the closed list in the database does not change. No wind-down guard (a wind-down sweeps every task). One job per project at a time, for the earliest overdue expiry. "Ten minutes ago" is judged by the final block's time, so on a chain that never mines nothing is due. The refresh cadence is checked in scaled form (5 and 7 seconds). The loop derives which tasks the list holds from its own record of when each ended. The nine tampered records are inside the loop. `accept --pay-to` was built (C35). |
| Team side, first pass | A plan is "live" by the row's state (announced, taken, paid), whether or not it ties; the step 1 box press returns when a plan that ended unpaid is settled. The card's door sentence uses the record's box and its age; the sheet reads them from the chain. The Plan sheet does not read the unit. "Done" is two notes (the date is known only after it lands). "Already planned" is checked before "quiet" and "eight open". The check-in lines: on the card for everyone when the team's last check-in stops counting before anyone could take it; a reminder for the team when it stops before a plan ends. An ended plan with no record here gets a card only if it moved money. Two different pay-to wallets from one worker read as no wallet, which fails the tie (the safe direction). |
| Team side, second pass | The second signer's sentences round cents down, so for "pay all" of a set-aside with sub-cent digits the sentence reads 57.48 while the call moves 57.486851; the pay sheet itself is exact. A waiting call about a task no longer in the state it works on reads as one that cannot be confirmed, with a new sentence. The pay opener is on the card whenever the record is submitted (or accepted with the pay owed) and the row is taken and not past its end; the sheet's gate decides. A part payment is typed in dollars and cents, from 1 dollar to what is set aside. "Stop this task" is offered after any withdrawal. A plan with no record here gets Withdraw and Send back for the runner. The browser specs' record builder (`live-tasks.ts`) carries no leavers' notes and an empty list of frees. |
| Holder side, first pass | The opener and the sheet's press are both "Set the money aside" (never on screen together). The Take sheet's room check blocks only when both the book's room and the record's room are short, because a take settles first. "About {x} set aside now" uses the record's pot with its age, not the row's `atMostNow`. Strips: the Take out press only on a plan, named "Take out before {date}" and then "Take out now". For an ended task the chain's `claimableNote` is the figure and must equal the contract's rounding, or nothing is acted on. With an unreadable queue the Money tab says so and shows no claims section; with none, neither section. A person's claims show for anyone with a wallet on a project with a queue. Own-history serials come from the transaction's own logs. |
| Holder side, second pass | An ended alert exists only inside the record's 28 days; a claim is shown whatever its age. Ended and claim news use the team's words by `what`; planned and taken news only where the plan ties. Opening You marks what it lists read after it renders; "Mark {n} as read" clears the labels. The dot knows the projects this browser has history with and the ones last found held, never a scan. Where held is decided: the record's list when whole, a balance read when cut. Storage that throws keeps what a visit marks in memory. The news row's Take out opens the project's Money tab (the sheet needs a ready wallet). The app has no community switching, so no `resetCommunityState` entry was added. |

### 6.4 Declined, with the reason

- **A change to the server for the test chain's clock** (section 5): not worth a code path that exists only in tests.
- **Guards that could never differ from an earlier check** were removed by their engineers, not tested (the landed check on who took a task,
  the last gate inside two rechecks, a second "ran out pays all" branch, four in the news, one phase check on the stop step): 9 in all.
- **The `!wallet.blockTime` early return in `reaches()`**: removing the line changes nothing, because the call below it sits in a
  `try` that returns the same answer. Kept as written; if the lead wants a deletable guard the `catch` must stop swallowing a missing function.
- **The guards "this book" in the paid-transaction search and "the taker is the pay-to" in the pay gate** cannot be told from the node's own
  filter and from the earlier "the wallet it names" check on this chain: see section 6.2.
- **A "claim all" press, a note transfer, a note sweep, push and email alerts, a chip on Home, a vote or veto on a task, open-to-anyone
  plans made by the app** (plan section 9.1, C4, C27, C28): not in step 2.
- **Reading a plan from the command line** (plan 9.1).
- **The skipped `pot-phone.spec.ts`** (it needs the passkey script) was not touched.

### 6.5 Still open

- **No person has tried it.** The steps are in section 7. The pull request checklist's third step (a human tests it) is not done and is not marked.
- **The whole `buzz-relay` suite** has one test that failed in 2 of 3 runs for the relay engineer and has nothing to do with this work
  (`api::mesh_demo::tests::demo_join_forwarded_arm_round_trips_echo`, a 504); `planted_eval_against_a_real_model` fails without the
  settings of a real model, as it always does. Neither was run again here.
- **`pgschema`'s own binary** needs a network fetch the sandbox did not have; the reader engineer applied the schema with it once and a
  test applies the expanded schema to an empty database.
- **The 360-pixel and 1,280-pixel screens** were looked at in the app engineers' own browser specs (axe and no sideways scroll) and in
  this package's journey at 390 pixels; a person's phone is still the test.
- **The record's age on a chain whose clock is not the server's** (section 5) reads old for the rest of that world.
- **Contracts:** two owner decisions stay open in `POT-STEP2-REPORT.md` (the part-payment band and the arriving-stream stretch), untouched here.


## 7. Try it on a phone on a local network (the human test is yours; nothing below was done on a phone)

What you need on the computer: Foundry (`anvil`, `cast`, `forge`), Node and pnpm, Postgres and Redis, the relay built once
(`cargo build -p buzz-relay`; the scripts never build), `contracts/pot` built once (`forge build` in `contracts/pot`), and a phone on the
same network with a **browser that has a wallet** (a wallet app's own browser). A passkey account needs `https` and a bundler and
sponsor, so it cannot be tried this way. The wallet needs several accounts for step 2: the chain's development accounts are public,
and the wallet can import more than one (or use two phones, or a phone and a computer browser with a wallet).

**Part A: what a holder and a worker read (about ten minutes).**

1. In the repository: `. ./bin/activate-hermit`, then `scripts/pot-full-loop.sh --serve`. Add `SERVE_HOST=<the computer's address on
   your network>` if its first address is not the one the phone reaches. It takes about two minutes, then prints the app's address, the
   chain's address and the words below. It leaves one project, "Lantern", with 50 play dollars in it and **one planned task** ("Paint the
   lamp shades", up to 2 play dollars, for the wallet of development account number 5). Leave the window open: Ctrl-C stops and removes
   everything. The chain's development accounts are public and unlocked, so anyone on that network can send play-money transactions to
   it while it runs: use a network you trust.
2. In the phone's wallet add the network the script prints (chain id 31337, symbol ETH) and import development account number 2 (the
   script prints the command that shows its key; it is public and worth nothing; never put a real account's key anywhere near this).
3. Open the printed app address in the wallet's browser. **What working looks like:** above the project's tabs a strip says "The team
   plans to pay up to 2 dollars to Demo worker for “Paint the lamp shades”, from {a date 14 days or so away}." and under it "You can
   take your money out before then. 2 dollars is the most; it can be less if people take out first.", then what would be set aside today
   and "This can go up or down. It is not a return.", and the line that this is a test network and the dollars are play money. Signed
   out, the same two lines show.
4. Get play dollars and Back with 25 dollars (as in `STEP1-REPORT.md`, section 5). Open **You**: "News about your projects" has one row
   about the plan, with "You can take your money out before {date}" and a "Take out of Lantern before {date}" press. The dot on You is
   lit until you have read it.
5. The Money tab has a section "Planned and running tasks" with the money set aside (none yet) and the room left for tasks.
6. To try the worker's side, move the chain's clock from the computer, then wait two seconds for the next block:
   `cast rpc --rpc-url <the printed chain address> evm_increaseTime 1300000`. The page will say "(as of {date}, may be out of date)"
   because the chain's clock is now far ahead of the server's: that is expected on this test chain. Import development account number 5,
   reload the project's Tasks tab and press **Set the money aside**. The sheet says who is named and the most, "Take it only if the whole
   2 dollars is set aside" is ticked, and it is play money. The wallet asks **once**. "Taken. Hand your work in on the task." follows.
7. With account number 2 (who backed), press **Take out**: the sheet now says part of the project's money is set aside for a task and
   where to claim what you are owed. One wallet prompt.
8. Nobody on this demo project can pay or send the task back (its team is a key nobody holds), so let it run out: move the chain's clock by
   the same amount once more, mine a block by waiting two seconds, and wait about a minute and a half. The server's helper returns the money
   (it acts ten minutes of the chain's clock after the deadline, which the jump covers). The Money tab's "Money you can claim" then
   offers **Claim {amount}** for account 2: one prompt, and exactly that amount arrives. The strip and the news on You now say the task
   ran out and nothing was paid.

**Part B: the team's side (needs a project of your own; about twenty minutes).** The demo project's team is a throwaway key nobody holds,
so the team's presses need your own project:

1. Sign up on the phone's browser, press **Start**, answer the three questions, then press **Open <name> to backers** and its sheet's
   button (the wallet asks once; the account must hold play dollars on this network). Back it with 100 play dollars from a second account
   so there is money in it, and press **This week** then check in (the plan needs a recent check-in).
2. On the Tasks tab press the plus, type what needs doing and 4 dollars, post it. With a second account in another browser, sign up,
   open the project and press **Take this task** (the wallet is asked for its account, nothing is signed).
3. As the team, on the task: **Plan the pay of 4 dollars**. The sheet shows who is paid, the most, the share of the project's money, when
   it can be taken and until when, and that holders get notice first. The wallet asks once. The card then reads "Planned. Can be taken from
   {date}." and offers **Withdraw the plan**.
4. Move the chain's clock as in Part A step 6, check in again from This week, and have the worker press **Set the money aside**. The team's
   card reads "Taken, due {date}." and offers **Pay for the work** and **Send the money back**.
5. Press **Pay for the work**, choose **Pay part**, type 3, press the sheet's button (one prompt). The worker is paid 3 dollars, the rest goes
   back. The card reads "Paid 3 dollars." and "Paid 3 dollars of the 4 dollars set aside; the rest went back." If the server has not read the
   payment yet it says so and offers **Save that it was paid**: press it a little later; nothing is paid twice.

If something differs from what is written here, that is a finding: write down the step and what the screen said.


## 8. How to run it again

```bash
. ./bin/activate-hermit
cargo build -p buzz-relay                 # once; the scripts never build
( cd contracts/pot && forge build )       # once
scripts/pot-app-loop.sh                   # the app's own builders and readers on the real contracts
scripts/pot-full-loop.sh                  # both journeys; prints "pot-full-loop: N checks passed."
scripts/pot-full-loop.sh pot-tasks        # only the task journey (one world)
scripts/pot-full-loop.sh --hold           # one world left running; the script prints the environment a journey needs
scripts/pot-full-loop.sh --serve          # the same world left running for a phone (section 7)
scripts/chain-loop-pot.sh                 # the server's loop: the record equals the contracts at nine stops
scripts/pot-chain-loop.sh                 # the contracts, with cast only
scripts/phone-loop.sh                     # the passkey path
# helpful: FOUNDRY_BIN=<folder with anvil, cast, forge>  SHOTS_DIR=<folder for the journey's screenshots>  RELAY_LOG_COPY=<file>
```
