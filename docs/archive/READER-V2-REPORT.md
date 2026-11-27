# Chain reader on contracts/pot: record version 2, the helper, the manager's keys

Branch `v6`, 19 November 2026. The server track, two builders. Spec: `docs/next-version/RECORD-V2.md` and its one example,
`docs/next-version/record-v2-example.json`; contracts: `contracts/pot` (not edited). Nothing is pushed. This is not legal or tax
advice, and no figure here is a promise of any result for anyone. Every money screen of the first public launch is play money, and
the record says so (`playMoney`).

Pass A (builder A, commits `89b351def`, `f74f99e34`, `561a12e7d`): the reader decodes contracts/pot and rebuilds each project from
its events. Pass B (this builder): the record, the publish path, the helper, the manager's cost rules, the loop. Pass A's detailed
report is in git at `561a12e7d`; what it built is kept short here.

## What is built

### Pass A, in short

| Part | Where |
|---|---|
| Event table generated from the contracts build (35 role/event pairs), the Team token as its own role | `scripts/chain-reader-events.mjs`, `chain_reader/events_table.rs`, `testdata/pot-events.json` |
| Discovery from `ProjectLaunched` and `PairMade`; the scan loop, reorg walk and rollback, generation fence, writer lock, signing, supervisor kept | `chain_reader/scan.rs`, `store.rs`, `mod.rs` |
| The ledger: a project rebuilt from its events alone (pot, paid-in, B, G, Z, box, arriving, active time, rate, door, grants, agents, totals, holders, draws); `Ledger::mismatches` is the section 4.3 cross-check | `chain_reader/ledger.rs` |
| The real-run fixture: two projects, 86 blocks, 163 logs, the views after every block that changed a project | `scripts/chain-reader-fixture.py`, `testdata/pot-run.json` |

### Pass B

1. **The record, version 2, exactly as the spec says** (`record.rs`, `views.rs`, `numbers.rs`).
   - `record.rs` holds the spec's fields as typed data (`deny_unknown_fields`: an unknown or missing field is an error), `mul_div`
     (256-bit, the contracts' `mulDiv`), the section 3 roll-forward (`roll_forward`, the one repeated contract formula) and
     `validate`, the rules a record must pass before it is signed.
   - `views.rs` builds the list of view calls and sends it as one batch at `asOf.block` (never at "latest"):
     the Treasury's views, the Vester's, the two tokens' supplies, the Vester's Team balance, the dollar balance of the Treasury,
     `Launcher.testNetwork()` and `isPair(runner)`, `grantOf/vestedOf/claimable` per unfinished grant (at most 200) and four views per
     agent account the events named (at most 100 read, 50 listed), then the Pair's `first()` and `second()` at the same block when
     the runner is a Pair. A call that fails, an answer of the wrong length or a number that does not fit is an error.
   - `numbers.rs::build` runs, in this order, and refuses (an error naming every field and both values) at the first group that fails:
     (a) the ledger the events rebuild must equal the contracts' stored numbers (pot, paid-in, box, arriving, fees owed, Z,
     active seconds, B, G, both tokens' summed balances, the Vester's Team balance, `lastSettle` not later than the view);
     (b) the views must agree with the events on the runner, the grant count, `committed`, the door switch, the rate, a waiting
     raise, the last check-in, the wind-down, the unit, the fee, the arrival end, and each grant's state, keeps, claimed, start, burn,
     burn time, member and kind; (c) the settled snapshot worked forward must give `boxCap()` and `activeNow()`;
     (d) the finished record must pass `validate` (the Treasury holds at least what it owes, the totals identity, Team Shares and
     grants add up, the quiet times and state word, the door, the pending raise). Nothing turns a failed read or a disagreement into
     a zero: the previous record stays and the next pass tries again.
   - `playMoney` is `Launcher.testNetwork()`; `limits`, `unit`, `fee.bps` and the agents' limits are views; nothing is copied.
     The 13 units of "dormant" is the one server constant (S5).
   - `refreshEverySecs` is 600 while the allowance accrues or outside money is arriving and 3600 otherwise
     (`BUZZ_CHAIN_ACTIVE_REFRESH_SECS`, `BUZZ_CHAIN_REFRESH_SECS`). `builtAt` is the event's own `created_at` (set at signing).
2. **The publish path** (`mod.rs`). A record is signed when a fact changed, and again whenever its promised refresh is due even if
   nothing changed (the heartbeat of section 6: before this, an unchanged record only had its clock moved, and a quiet project would
   look dead). `facts_of` strips `asOf`, `builtAt` and every number that moves with time (pot, arriving, box, box cap, value, door
   `openNow`, active seconds, the quiet state, vesting, agents' use, `ledger.lastSettle`); `without_as_of` strips `asOf` and `builtAt`.
3. **The chain helper** (`helper/`). The Rounds and Finisher calls, the earlier backers' delivery, the pool collect, `Vester.claim`
   and the batch halving are gone. It sends five calls anyone may make: `Treasury.collectFees()` (the platform's fee
   goes to the platform), `settle()` (once outside money has all arrived and is still stored as arriving, or a task ran out), and,
   since the launch round (see "The helper's three more calls" at the end), `Treasury.applyRate()`, `Vester.execute(id)` and
   `Vester.burnAfterWindDown(id)`. It never checks in, takes out, refunds, draws, winds a project down or claims for anyone. The
   planner (`plan.rs`) builds a weekly fee job when fees are owed, a settle job when arrived money waits, and the three more.
4. **The manager's cost rules** (`api/manager/cost.rs`, `mod.rs`, `config.rs`).
   - The "free while the founder posts weekly" gate and the hosted allowance key on the project's first `Joined` with money in it
     (`first_backing`, still checked against the launch row's `projectId`).
   - The platform cap reads the `fee` of every Treasury `Joined` in the 90-day window (`platform_fees`).
   - Play dollars count for nothing: the fees are counted only when the Launcher said the dollar is real money
     (`chain_reader::play_money()`, noted by every record build; unknown counts as play money). Then the cap is zero and the hosted
     manager stays off, unless the operator sets `BUZZ_MANAGER_FLOOR_CENTS_PER_90_DAYS`, the least the hosted manager may spend
     whatever the fees are (`cap_base`). The existing ceiling `BUZZ_MANAGER_MAX_CENTS_PER_90_DAYS` still narrows both.
5. **The loop** (`scripts/chain-loop-pot.sh`, `chain-loop-pot-check.py`, `chain-loop-query.mjs`): see "What was measured".

## What was measured

Run on 19 November 2026 on this machine, before the last commit. Contracts at `b17d96d6c`.

| Check | Result |
|---|---|
| `cargo test -p buzz-relay --lib chain_reader` | 46 passed, 0 failed, 5 ignored (the five Postgres tests) |
| The same with `-- --include-ignored --test-threads=1` against the local Postgres and Redis, together with `manager::` | 84 passed, 1 failed: `planted_eval_against_a_real_model`, which needs `BUZZ_LLM_PROXY_URL` and `BUZZ_LLM_API_KEY` and is not part of this change; every other test passed |
| `cargo test -p buzz-relay --lib manager::` | 23 passed, 0 failed, 11 ignored (Postgres) |
| `cargo clippy -p buzz-relay --all-targets -- -D warnings` | clean |
| `cargo fmt -p buzz-relay -- --check` | clean |
| `node scripts/chain-reader-events.mjs --check` | the table matches a fresh forge build |
| `python3 -I scripts/chain-reader-fixture.py --check` | a second run of the real chain gives the same bytes (and, since the section "Closing the step 1 checks", every time: see there) |
| `scripts/chain-loop-pot.sh` | **95 checks passed**, 14 s: anvil, `contracts/pot` deployed by its own script, a launch, a faucet, a Back in one signature, a Back by approve then join, a check-in, a grant, an agent, two days later a draw by the founder and one by the agent, a rate raise announced, outside money, a Take out; the relay's reader pointed at it; the signed record equals the contracts in **79 field-by-field checks** at the record's own block (the settled pot, box and arriving money worked forward independently in Python); the helper collected the platform's fee with nobody pressing and sent nothing else; a fresh record was signed with no new event; a posted copy was refused; the reader never refused to sign. It stopped anvil and the relay, dropped its scratch database and removed its temporary files. |

The tests that bind the points of the brief:

- **The record has the example's fields and types**: `record_tests::the_reader_fed_the_run_writes_the_examples_fields_and_types`
  builds the record from the real chain's answers (four books of the run: project A live, project B run by a Pair, both wound down) and
  compares every field name and JSON type with the example file, and the key set of the top level.
- **The example cannot drift**: `the_example_parses_with_the_servers_own_types_and_writes_back_exactly` parses the example file with
  the server's own types and writes it back equal; an extra or missing field is refused. `the_example_obeys_every_rule_of_section_7_3`
  runs the spec's list on the file; `the_server_accepts_the_example_and_refuses_it_with_a_pot_one_unit_too_high` runs the server's own
  checks in both directions.
- **A failed or mismatched read is an error, never a record**: a missing answer, a block the node cannot serve, a view one unit off the
  events (the message names both numbers), `boxCap` or `activeNow` one unit off, a Treasury that holds less than it owes, a ledger that
  missed an event.
- **Retried, not skipped**: after a failed build the project's row is unchanged, so it is due again on the next pass.
- **Heartbeat**: on Postgres, both projects are signed from stored rows and the real answers, the record kept is the typed record
  true for the last block, an unchanged project is not signed before its promised refresh and is signed again, with a later
  `builtAt`, once it is due (`scan_postgres_tests::the_reader_signs_records_and_signs_them_again_when_the_refresh_is_due`).
- **The helper's rule**: `helper::calls::tests` lists 39 calls the helper must never be able to send (check-in, take-out, join, draw,
  claim, grant, announcing a forfeit, proposing or lowering the rate, door, agents, seat, wind-down, the Pair's and the admin's calls, token moves) and fails if any is in the
  allow-list or can be produced; it also checks every listed signature is a real function in the contracts' compiled ABIs, so a rename
  cannot turn the rule into nothing. Adding a call to the allow-list fails a test.
- **The manager**: `cost::tests::play_dollars_count_for_nothing_unless_the_operator_sets_a_floor` (pure) and, on Postgres,
  `play_dollar_fees_count_for_nothing_until_the_operator_sets_a_floor` (fees plenty and play money: refused; unknown: refused; a floor:
  served, and only up to the floor), plus the existing gate tests moved to `Joined` (`only_a_launch_made_for_this_record_counts_...`).

## What is gone

In git history, not in the tree: the old helper's Rounds, Finisher, holder, earlier-backers and `Vester.claim(address)` calls and
their checks, the batch halving, the job planner of pass A's empty `plan`; the manager's sums of `Settled`, `Refunded`, `HandedBack`,
`Collected` fees and the `RoundClosed` gate; `scripts/chain-loop-e2e.sh` (it drove contracts/next and read a version 1 record).
`scripts/m7-chain-loop.sh` was already replaced by `scripts/pot-app-chain-loop.sh` (the app track). `scripts/dev-chain.sh` is **not**
part of this: it is the older launchpad dev chain (apptoken, DAO kits) used by other scripts, it never read the reader's record, and I
left it alone.

## Chosen under the owner's standing go; the owner may overrule

Pass A's seven choices stand, except the two workarounds migration 0070 removed (Team Shares' balances under a derived key, the Team
token stored with role `shares`; see "Closing the step 1 checks" below); the dollar is not followed; ledger `lastSettle` not later than
the view; Pair events followed. Pass B's:

1. **Helper stored names.** *(Done in migration 0070, see below: the two calls are stored as `treasury.collectFees` and
   `treasury.settle`.)* *(The launch round added `applyRate()`, `Vester.execute(id)` and `Vester.burnAfterWindDown(id)` in migration 0075; `Treasury.windDown()`
   stays a person's press. See the end of this file.)*
   `Vester.claim` is left out on purpose (the lead said the helper never claims). The helper never checks in: it could not before
   either.
2. **Play dollars and the manager.** "The cap is zero with play dollars" is read from the Launcher's own `testNetwork()` (noted by
   the reader in a process-wide value) rather than from a setting, so it cannot disagree with the contracts. Not yet read counts as
   play money. The floor is a setting in US cents over 90 days, like the ceiling; a floor larger than a ceiling is narrowed by the
   ceiling.
3. **Wound-down `allowance.boxCap` is `"0"`**, as the spec's wound-down variant says. The contract's `boxCap()` view still returns the
   rate's seven days of the pot after a wind-down (about 22.7 play dollars in the run's project A); the build checks the view against
   the settled numbers first, then writes `"0"` because the box is closed. If the owner prefers the view's number, it is one line.
4. **Production checks are the spec's, with three honest relaxations:** `held >= owed` (a gift nobody can claim makes it more), listed
   holders' Shares `<=` the supply (Shares sent to the Launcher or a token are stuck and not listed), and the ledger's `lastSettle` not
   later than the view's (see the contract finding). The example's own test keeps the spec's equalities.
5. **Heartbeat on every promised refresh**, even when nothing changed (section 6 needs it; the old rule only moved a clock).
   `published_at` now always means "last signed".
6. **`BUZZ_CHAIN_REFRESH_SECS` may be as low as 5** (was 60), so the loop can show the cadence; the defaults are 3600 and 600. The
   ceiling is now 43200, half a day (was 7 days, then 86400), see below.
7. **Agents.** Up to 100 accounts the events named are read, the first 50 (live first) are listed; `truncated` is true when more exist.
   Agent addresses come only from `AgentSet` events, as the spec says.
8. **Two replicas, one record.** Unchanged: only the writer-lock holder signs; `builtAt` is set to the `created_at` actually kept,
   also when the relay had to sign one second after a stored newer record.

## Spec and contract findings (said loudly)

- **RECORD-V2 section 4.3 edited (one sentence).** It required the ledger's `lastSettle` to equal the view. That cannot hold:
  `Treasury._settle()` always sets `lastSettle` but emits `Settled` only when something moved, so a settle that moves nothing leaves no
  event (in the run, the view is 1805456264 and the last `Settled` is 1804764200). The sentence now says "not later than the view's"; the
  record carries the view's `lastSettle`. The example file is unchanged and still valid (the example test passes). A cleaner fix is in the
  contract: emit `Settled` on every settle. **I did not change `contracts/pot/src`.**
- **The fixture depends on the contracts build.** `contracts/pot` was being changed by its own track while this work ran
  (`b17d96d6c`, 10:35 today). One run of the fixture script, taken while `contracts/pot/out` was being rebuilt, gave a chain shifted by
  one block and failed `--check`; three runs after it gave the file that is committed, byte for byte. If the contracts change again,
  run `python3 -I scripts/chain-reader-fixture.py` and `node scripts/chain-reader-events.mjs` (both have `--check`), and expect the
  numbers in the tests to follow the run, not the other way round.
- **Spec points that are slightly off but harmless:** section 2.11 says the Treasury, Vester, tokens, dollar and Launcher are left out
  of the holders; the Pair is not (a Pair that holds Shares is a holder), and the code follows the spec.

## What is not done

- *(The migration this section used to list is migration 0070, done: see "Closing the step 1 checks".)* The other four calls anyone may
  make are still not built.
- The helper's old Postgres suites (caps, backoff, receipts, never failing a pass) are not rewritten; the pure tests of its call list and
  planner are. The loop exercises the live helper end to end (one real call).
- No test builds a record with more than 200 holders or grants (the cuts and `truncated` follow the spec's caps by construction).
- The earlier-backers block is parked: version 2 has none.
- The record has no tasks, notice, take or notes: step 2.

## Review fixes

Two independent reviews (one of the code against the spec and contracts, one of attacks) were checked item by item against the code.
No BLOCKER was found. Every IMPORTANT item was real and is fixed; each has a test on the production path, and each test was run with
its fix switched off and failed (7 of 7).

### Fixed

| Finding | Fix | Test that fails without it |
|---|---|---|
| Review 1 I1 and attack I4: a quiet project was derived (about 45 view calls plus its stored logs) at every poll for 600 to 3600 s after its last signing, because the "unchanged" branch no longer moved the clock | The writer remembers per project when it is next worth looking at (`Schedule.quiet_until`, the project's own promised refresh after its last signing). A project that is neither changed nor due costs no node call. `touch_source_block` lost its dead `checked` branch | `a_project_that_is_not_due_and_has_not_changed_costs_no_view_calls`: the first look reads the views, the next passes make 0 calls (before: 114 calls on each pass) |
| Attack I1: a head that steps back (not a rollback) made the reader sign older numbers over newer ones | `publish_pass` does nothing while the newest block read is above the final block plus one (a record only goes forward); a real rollback resets the cursor, so it is not blocked. The helper builds no jobs then either (its rule is `helper_final_block`) | `a_head_that_steps_back_does_not_replace_a_newer_record_with_an_older_one`; for the helper, `jobs_are_built_only_at_the_newest_block_read` (fails when `cursor <= f + 1` is dropped) |
| Attack I2: the same step back signed a removal for a project launched above the lower block | The same guard | `a_head_that_steps_back_does_not_publish_a_removal_for_a_live_project` |
| Attack I3: projects whose numbers cannot be built kept the front of the queue (100 of them starve every other project) | A failed build puts the project off for 15 s, doubling to 300 s (`failure_pause`); a success clears it | `a_hundred_projects_that_cannot_be_built_do_not_starve_the_others` (pass 1: 100 failed; pass 2: 0 failed, both real projects signed), `a_failing_project_waits_longer_each_time_up_to_a_cap` |
| Review 1 I2 and attack O4: the dollar's kind (play money or not) was learned only by the writer's record builds, so on other replicas it was "unknown", which the manager reads as play money (cap zero) | Every replica reads `Launcher.testNetwork()` itself (`views::read_test_network`) on its own passes until it knows | `a_replica_without_the_writer_lock_reads_whether_the_dollar_is_play_money` |
| Review 1 I3: dead helper code (batches, positions, essential calls, rest-of-batch, `BUZZ_CHAIN_HELPER_BATCH`) | Deleted: `members`, `only`, `first_half`, `ESSENTIAL`, `is_essential*`, `rest_key`, `store::Rest`, `Position`, `PlanContext.batch`, the gas-halving loop, the routine/essential columns of `used_last_day`, the setting `BUZZ_CHAIN_HELPER_BATCH` (and its lines in the `config.rs` test of the helper's settings). The gas room, the daily share and the stuck-transaction replacement keep their behaviour | the helper's existing call-list and plan tests, the config test, and the real loop (95 checks) |
| Review 1 optional: a collector racing another reverts with `NothingToPay` and was retried | `nothing_to_do_errors` names `NothingToPay()` for `collectFees()`: the job is dropped, no failed attempt | `a_fee_collected_by_someone_else_drops_the_job_without_a_failed_attempt` (fake node, real database) |
| Attack O1: a node that ignores `toBlock` wedged the reader at a duplicate key | Logs outside the range asked for are dropped in `scan_range` (they are read again in their own range) | `a_node_that_ignores_the_end_of_the_range_does_not_wedge_the_reader` (and the run's numbers still rebuild) |
| Review 1 optional: `unwrap_or(0)` on the pending rate (second review: the width check that replaced it could never fail, because the cross-check had already made the Treasury's number equal the events' 32-bit one) | The dead conversion is gone: the raise waiting is taken from the events, and the cross-check in `numbers.rs` is the one place that compares the Treasury's pending rate and time with them | `a_pending_rate_that_is_oversized_or_different_publishes_nothing` (a rate above 32 bits, one unit off, and zero are each refused with "nothing is published ... pending rate"); fails when the rate comparison in the cross-check is removed |
| Reviewers' scratch tests | `review-reader-attacks.rs` deleted. Kept as proper tests: hostile event values one unit off are refused (`an_event_value_one_unit_off_is_never_signed_into_a_record`, in `record_tests.rs`) and 406 big-integer vectors for `mul_div` (`mul_div_tests.rs`, checked again with Python integers: 0 wrong) | both pass |

### Second review (fixer 2)

- `cargo fmt --check` failed on one line of `config.rs` (the helper-settings assertion, from the batch-setting removal). Formatted; the whole workspace is now clean, so the line in the table above and the run step below are true.
- The helper's step-back clause was not covered: the rule is now the plain function `helper_final_block`, which `helper_pass` calls; its test fails when `cursor <= f + 1` is replaced by `cursor > f`.
- The pending-rate fix was not falsifiable (see the table): the unreachable check was removed and the cross-check is tested with an oversized, a different and a zero rate.

### Declined, with the reason

- Attack O3 (the free-while-posting gate opens on a one dollar self-join): it is the key the lead chose (L6); a minimum paid amount or a second backer is a product setting for the owner, not a bug. On play dollars the faucet makes it free; the platform cap is zero there anyway.
- Review 1 optional, `BUZZ_CHAIN_REFRESH_SECS` floor of 5: the load it multiplied was finding I1, now fixed; the loop needs the small value.
- Review 1 optional, `settle()` job reuses the dropped Release name: it costs relay-key gas only; the stored name stays until the migration below (dropping it needs the same migration to be clean). Left, not widened.

### Still open

- (Closed in "Closing the step 1 checks": the migration for the Team token, Team Share balances and the helper's names; the cut of
  agents and grants.)
- The settle job could be dropped altogether (the record works forward to the block's time by itself); the Pair contracts are followed though step 1 reads none of their events.
- The queue still re-derives a project on every new event of that project, and every project is heartbeat-signed; a per-project rate limit on rebuilds, an index for `launcher_reveals`, a snapshot for `project_logs`/`Ledger.draws` are scale work, untested at thousands of projects (attack O5, O7: the helper collects any non-zero fee).
- Views are read at a block number, not a block hash (attack O2); a fork between scan and views is caught by the cross-checks except when the numbers are equal.
- The shape test treats a null on either side as "none" (the values are covered by the real-run books and by `validate`).
- Contract observation for the contracts track: `settle()` is permissionless and sets `lastSettle = now` each call while the released amount rounds down, so calling it every second can hold arriving money back until `arrivalEnd`; bounded, costs the caller gas.

### What ran after the fixes

- `cargo test -p buzz-relay --lib chain_reader -- --include-ignored --test-threads=1` (local Postgres and Redis): 63 passed, 0 failed, 0 ignored (after the second review).
- `cargo test -p buzz-relay --lib manager:: -- --include-ignored --test-threads=1`: 33 passed, 1 failed (`planted_eval_against_a_real_model`, which needs a real model proxy and key; unrelated to this track).
- `cargo test -p buzz-relay --lib config::`: 103 passed, 0 failed.
- `cargo clippy -p buzz-relay --lib --tests -- -D warnings`: clean. `cargo fmt --check` over the workspace is clean (after the second review).
- `node scripts/chain-reader-events.mjs --check`: matches; `python3 scripts/chain-reader-fixture.py --check`: "pot-run.json is what a fresh run gives".
- `scripts/chain-loop-pot.sh` (real anvil, contracts/pot, the real relay binary rebuilt after the fixes): 95 checks passed, exit 0.

## Closing the step 1 checks (server, 19 November 2026)

What the step 1 checks left open on the server, one by one. Contracts (`contracts/pot`) were not touched.

### 1. The fixture is deterministic

The cause: `forge script --broadcast` sent the three deploy transactions (the dollar, the parts, the Launcher) together, and anvil
mined them into 2 or 3 blocks depending on timing. The run then had 86 or 87 blocks and every later block number moved by one, so
`--check` failed most runs, and a regenerated file broke a test that named blocks 19, 34, 35 and 55.

- `scripts/chain-reader-fixture.py` deploys with `--slow` (forge waits for each receipt before sending the next, so each transaction
  gets a block) and then **checks** it: the head must be block 3 with one transaction in each of blocks 1, 2 and 3, or the script
  stops with a message. The flag is not trusted alone.
- The file was regenerated once (87 blocks, 163 logs). Each project in it now records `launchBlock` (A: 4, B: 20), and
  `Fixture::launch_block(name)` and `Fixture::book_block(name)` read those and each book's block from the file.
- The scan test that named 19, 34, 35 and 55 (`a_head_that_steps_back_does_not_publish_a_removal_for_a_live_project`) now reads B's
  launch block and its book's block from the fixture, derives the head it needs (`book + 21`) and the step back (`book + 1`), and
  asserts the shape it depends on (B launched above the block 20 under its book) so that it cannot silently show nothing after a
  future run. No other test hard-coded a block number of this run (the others use `fx.head()`).
- `--check` ran **6 times in a row, 6 passes** after the regeneration, and 5 more at the end (see "What ran").

### 2. The refresh settings end at half a day (43200 seconds)

`BUZZ_CHAIN_REFRESH_SECS` and `BUZZ_CHAIN_ACTIVE_REFRESH_SECS` accepted 5 to 604800 at first; the app accepts `refreshEverySecs` up to 86400
and refuses a longer promise. They were set to 5 to 86400 in the closing work and to **5 to 43200** in round four (see "Review fixes, round
four"): the app calls a record stale once it is older than a day, so a server set to a day would show every record stale for part of each
cycle. (`settings.rs`: `MIN_REFRESH_SECS`, `MAX_REFRESH_SECS`; test `config::tests::the_chain_refresh_settings_end_at_half_a_day`.)
`docs/next-version/RECORD-V2.md` section 6 says so.

### 3. Migration 0070: the Team token's role, Team Share balances, the helper's call names

`migrations/0070_chain_team_token.sql`, with the desired-state schema (`schema/tables/public/chain_*.sql`) changed to match, and the
migration count asserted by `crates/buzz-db` raised from 69 to 70.

- **Role.** `chain_contracts.role` may be `team`; each project's Team token (the address its own `ProjectLaunched` row names as
  `team`) moves to it. The reader now stores `Role::Team` as `team` and `store::contracts` is a plain select (the subquery over
  launch rows and `contract_role` are gone).
- **Balances.** `chain_balances` and `chain_balance_changes` have a `token` column (`shares` or `team`); `chain_balances` is keyed
  by (reader, project key, token, account). The Team Shares use the project's real key (the derived key `keccak256("team-shares" ||
  key)` and `balance_key` are gone). The migration moves Team change rows to the real key, adds change rows for Team Transfers that
  have none (the way 0068 did for backer Shares), and rebuilds every balance as the sum of its changes, which it always is (0068,
  0069). Zero balances are kept, as 0069 says they must be.
- **Helper names.** `chain_helper_jobs.call` allowed `treasury.collectFees` and `treasury.settle` (migration 0075 added `treasury.applyRate`, `vester.execute` and `vester.burnAfterWindDown`); the helper writes only those five. Rows of
  a reader that follows contracts/pot (it has a Team token) are renamed from `treasury.sweepFees` and `treasury.release`.
- **Tests.** A behavioural one in `crates/buzz-db` (`chain_team_migration_postgres_tests`): a scratch database migrated through 0069
  is filled with the old shapes (both tokens stored as `shares`, Team balances under a derived key, a Team Transfer with no change
  row, helper rows of two readers), then the rest of the migrations run. It checks the roles, every change row, every balance (no
  balance left under the derived key; the same account holds both tokens as two rows), the helper names, and that the closed lists
  still refuse what they should. It fails without the helper rename and without the missing-change fill (each tried). A text test
  (`chain_team_token_migration_matches_the_desired_schema`) keeps the migration and the desired-state schema saying the same. The
  reader's Postgres suites (backer and Team balances through a rollback, the helper's jobs) run against the migrated schema; the loop
  starts a relay on a fresh database, which runs all 70 migrations.
- **Not run:** `pgschema apply` itself (the tool is a hermit package that needs a download); the desired-state files were checked by
  the repo's own layout and parity tests, and migration order of columns follows `ADD COLUMN` (token last) in the files.

### 4. A join with nothing paid does not open the manager's gate

`api::manager::route_postgres_tests::a_join_with_nothing_paid_does_not_start_the_hosted_allowance`: a project's own launch plus a
Treasury `Joined` with `paid` 0 leaves the "free while the founder posts weekly" gate closed (a 30-day-old project, quiet 20 days, is
told to post its weekly update first, no model call is made); the first join with money in it opens it. It fails when the check
`paid > 0` in `cost::first_backing` becomes `>= 0`.

### 5. The cut of agents and grants is deterministic

- **Grants:** the candidates are the unfinished ones only (closed with everything it keeps claimed is finished and is never a
  candidate), cut by id at 200 (`views::grants_to_read`). `truncated` is true when more than 200 are unfinished.
- **Agents:** the old cut read the first 100 accounts by address, so a switched-off account with a low address could push a live one
  out of the record. Now (`views::agents_to_read`) the accounts the events show as switched on under the current runner come first
  (`AgentSeen::probably_live`: last `AgentSet` was on, and no `RunnerChanged` since: a hand-over switches agents off without an
  event), then the rest, each group by address, 100 read. The 50 listed are the live ones by the views first, then by address, as
  before; `truncated` says when one was left out. The ledger has a new field `under_runner` for this.
- **Spec:** `docs/next-version/RECORD-V2.md` sections 2.9 and 2.10 say the cut is deterministic and how.
- **Tests** (`views_tests.rs`, `ledger_tests.rs`): finished grants never take a place from an unfinished one (230 finished before 20
  live); 300 unfinished grants are cut to ids 0 to 199 whatever the insertion order; 120 switched-off and 15 handed-over agents with low
  addresses do not push 30 live ones out of the 100 read, and the rest are the lowest addresses; an agent is live only until the
  runner changes (on the real run's events). The finished-grant test and the agent test fail with the old rules put back (the by-id
  test passes either way: that behaviour was already right).

### 6. Pointer in `PLANV2-M5P2-REPORT.md`

The helper section of that report now says, at its top and at the settings table, that the old call list, the batch halving and
`BUZZ_CHAIN_HELPER_BATCH` are removed (and where), and what the helper sends now.

### Chosen under the owner's standing go; the owner may overrule

1. **Fixture:** `--slow` plus a hard check of the deploy blocks, rather than mining each transaction by hand; `launchBlock` is a new
   field of each project in the file.
2. **Migration 0070 keeps the retired helper names allowed** (the old contracts' calls and the two old treasury names), so history
   of a reader on the old contracts stays valid. It renames the two old treasury names only for readers that follow contracts/pot,
   because on another reader they were other calls. Balances are rebuilt from their changes (a `DELETE` and an `INSERT` in one
   migration transaction) rather than patched, since the sum of the changes is the balance by construction.
3. **Agents' cut rule:** "probably live" comes from events (on, set after the last change of runner); the contract's views still decide
   `live`. Grants stay cut by id, as the spec had it.
4. **Refresh floor stays 5 seconds**, ceiling 43200 (half a day, since round four; it was 86400, the app's range).
5. **The other four calls anyone may make** (`applyRate()`, `Vester.execute`, `Vester.burnAfterWindDown`, `Treasury.windDown()`) were
   not built in this round. *(Three are built in the launch round, see the end of this file; `Treasury.windDown()` is not.)*

### What ran

(see the list under "What ran after the closing work" at the end of this file)

## How to run it again

```bash
. ./bin/activate-hermit
# unit tests, no infrastructure
cargo test -p buzz-relay --lib chain_reader
cargo test -p buzz-relay --lib manager::
# with Postgres and Redis (started as scripts/run-tests.sh does)
cargo test -p buzz-relay --lib -- chain_reader manager:: --include-ignored --test-threads=1
cargo clippy -p buzz-relay --all-targets -- -D warnings && cargo fmt -p buzz-relay -- --check
# the generated files follow the contracts build
node scripts/chain-reader-events.mjs --check
python3 -I scripts/chain-reader-fixture.py --check          # regenerate without --check
# the real loop (builds nothing but needs the relay: cargo build -p buzz-relay)
FOUNDRY_BIN=<folder with anvil, cast, forge> scripts/chain-loop-pot.sh
```

The loop needs `node` with `web/node_modules` (nostr-tools), `jq`, `openssl`, `psql`, and a Postgres and a Redis (it starts what is not
running and stops only what it started). `KEEP_DB=1` keeps its scratch database, `RELAY_LOG_COPY=<file>` copies the relay's log.

### What ran after the closing work

On 19 November 2026, local Postgres and Redis, a database migrated to 0070 for the Postgres tests, contracts at their current build.

- `cargo fmt --check` (whole workspace): clean. `cargo clippy -p buzz-relay --lib --tests -- -D warnings`: clean; the same for `-p buzz-db`.
- `cargo test -p buzz-relay --lib chain_reader -- --include-ignored --test-threads=1`: **68 passed, 0 failed, 0 ignored** (63 before; five
  tests added: four on the cut, one on the runner change).
- `cargo test -p buzz-relay --lib manager:: -- --include-ignored --test-threads=1`: **34 passed, 1 failed**: `planted_eval_against_a_real_model`, which
  needs a real model proxy and key and is not part of this work (it failed the same way before). The new gate test passes.
- `cargo test -p buzz-relay --lib config::`: **104 passed, 0 failed** (103 before, plus the refresh test).
- `cargo test -p buzz-db --lib -- migration chain_team --include-ignored --test-threads=1`: **48 passed, 0 failed** (the count asserts 70
  migrations; the behavioural test of migration 0070 is one of them).
- `node scripts/chain-reader-events.mjs --check`: the table matches the contracts build.
- `python3 -I scripts/chain-reader-fixture.py --check`: "pot-run.json is what a fresh run gives" in 6 of 6 runs after the regeneration, and again in
  5 of 5 at the end.
- `scripts/chain-loop-pot.sh` (relay rebuilt from this tree, fresh database migrated through 70): **95 checks passed**, exit 0; anvil and
  the relay stopped, scratch database dropped.

## Review fixes, round four

An independent verifier found the step 1 gap track not ready at `426318757` for one app blocker (see `APP-POT-REPORT.md`) and listed items
for the server side too. The lead decided each; nothing else changed.

### Fixed

1. **G4, the `lastSettle` guard has a test that fails without it.** `Ledger::mismatches` names `lastSettle` when the ledger's last settle
   is later than the view's (docs/next-version/RECORD-V2.md 4.3), and says nothing when the view's is later (a settle that moves nothing emits no
   `Settled`). New test `chain_reader::ledger::tests::a_ledger_settle_later_than_the_views_is_a_mismatch_and_an_earlier_one_is_not`, on
   the real run's ledger: the view's last settle one second before the ledger's gives exactly one mismatch (`lastSettle`, with both
   values), one second after gives none. With the guard replaced by `if false` the test fails ("only lastSettle differs: []", left 0,
   right 1); with the guard in place it passes.
2. **G5, the refresh ceiling is half a day (decision F3, revised).** `MAX_REFRESH_SECS = 43_200` in `chain_reader/settings.rs`: the app calls
   a record stale once it is older than a day, so a server set to a day would show every record stale for part of each cycle. A larger
   setting is refused when the server starts, in the same way as before (the message says "from 5 to 43200"). The test is now
   `config::tests::the_chain_refresh_settings_end_at_half_a_day`: 5 and 43200 are accepted for each of the two settings; 4, 43201, 86400
   (the former ceiling) and 604800 are refused naming the setting and its range. `docs/next-version/RECORD-V2.md` section 6 says what the server allows
   (5 to 43200; with `MAX_REFRESH_SECS` put back to 86_400 the test fails at the `config.rs` assertion) and that the app's own rule does not change (it accepts a stated refresh of 5 to 86400 and calls a record stale after a
   day). The item is gone from "Still open" in both reports. (The earlier report `PLANV2-M5-REPORT.md`, which belongs to another track,
   still names its own older range and was not touched.)
3. **`scripts/chain-loop-pot.sh`: a cash figure that depends on the chain's clock is no longer asserted exactly.** The check "paid what the
   quote said" compared the cash of a Take out with a quote read a second or so earlier, while outside money is still arriving. It now
   asks for the cash to be at least the quote (the call's minimum is the quote, sent by the script) and at most one part in 1,000 above
   it. I did not reproduce a failure of the exact check; the loosened check passed in my run (95 checks).

### Declined, with the reason

- Nothing declined on the server side in this round.

### Still open

- `PLANV2-M5-REPORT.md` (another track's file) still lists the old range for `BUZZ_CHAIN_REFRESH_SECS`; this report and `docs/next-version/RECORD-V2.md` are the
  current word.
- The four calls anyone may make that the helper did not build (`applyRate()`, `Vester.execute`, `Vester.burnAfterWindDown`,
  `Treasury.windDown()`): three are built in the launch round (end of this file); `Treasury.windDown()` stays a person's press.

### What ran in round four

All run in this session on 19 and 20 November 2026, with local Postgres and Redis started for them, `CARGO_BUILD_JOBS=2`:

| Command | Result |
|---|---|
| `cargo fmt --check` | clean |
| `cargo clippy -p buzz-relay --lib --tests -- -D warnings` | finished, no warnings |
| `cargo test -p buzz-relay --lib chain_reader -- --include-ignored --test-threads=1` | **69 passed, 0 failed, 0 ignored** (the Postgres-backed ones included) |
| `cargo test -p buzz-relay --lib manager::` | 23 passed, 0 failed, 12 ignored (the ignored need services this run did not start for them) |
| `cargo test -p buzz-relay --lib config::` | **104 passed, 0 failed** |
| `node scripts/chain-reader-events.mjs --check` | "pot-events.json and events_table.rs match the contracts/pot build" |
| `python3 -I scripts/chain-reader-fixture.py --check` | "pot-run.json is what a fresh run gives" |
| `scripts/chain-loop-pot.sh` (relay built from this tree) | **95 checks passed**, exit 0 |
| `scripts/pot-full-loop.sh` | 213 checks passed |

Guards reverted and the tests run: `if self.last_settle > view.last_settle` replaced by `if false` fails
`a_ledger_settle_later_than_the_views_is_a_mismatch_and_an_earlier_one_is_not` ("only lastSettle differs: []", left 0, right 1);
`MAX_REFRESH_SECS` put back to 86_400 fails `the_chain_refresh_settings_end_at_half_a_day`. Both files were restored and the tests
pass with the guards in place (checked by `git diff` on those two files showing only the intended round-four change).


## Step 2, milestone M1 (server, 20 November 2026)

Package WP1, milestone M1 of `STEP2-SERVER-APP-PLAN.md`: the reader follows each project's task book and writes the `tasks` section of the
record from the events and the contracts' views. `contracts/pot` is not edited. Nothing is pushed. The per-row cross-checks of the book against
`taskOf` and the task rules of `validate` were left to milestone M2, which is the next section after this one's tables ("Step 2, milestones M2 and M3").

### What was built

| Part | Where |
|---|---|
| The seven new events and the new `tasks` role, generated from the build; the one struct-valued view (`taskOf`, 17 words) written as a table and a JSON file the build gives, with a test that compares them | `scripts/chain-reader-events.mjs` (now writes four files), `events_table.rs`, `views_table.rs`, `testdata/pot-events.json`, `testdata/pot-abi.json` |
| Finding the book: the Treasury's own `TasksReady` log names it; it is followed from that block; stored rows reveal a book the reader did not follow yet; a rollback forgets it | `scan.rs` (`discovered(role, ...)`), `store.rs` (`reveals`) |
| Migration 0071 (`'tasks'` in the role check, a partial index on the books' rows) and the same two facts in `schema/` | `migrations/0071_chain_tasks_role.sql`, `schema/tables/public/chain_contracts.sql`, `chain_logs.sql`, buzz-db tests |
| `ledger_tasks.rs`, the port of `contracts/pot/test/helpers/TaskLedger.sol` (tasks, notes, the 16-place ring of takes, the open count, the next serial, what repeats what) | `chain_reader/ledger_tasks.rs`; `ledger.rs` takes the Treasury's `TasksReady` and `TaskMoney`, the stream's start and total, and `paidToWorkers` / `noteClaims` |
| The arrival formula fix (plan 1.2 a) and the return of tasks that ran out, last (1.2 b) | `record.rs::roll_forward`, `record.rs::validate` |
| The record types of the `tasks` section, the cut, the next date, the amount a take sets aside, the section's builder | `record_tasks.rs`; `Record.tasks`, `LedgerRec`, `TotalsRec` in `record.rs` |
| The views of the book and of the rows the record lists, in a second batch at the same block | `views.rs` (`BookViews`, `TaskView`) |
| The fixture with the tasks scenario, and `docs/next-version/record-v2-example.json` as the server's own output for it at one named block | `scripts/chain-reader-fixture.py`, `testdata/pot-run.json`, `docs/next-version/record-v2-example.json` |
| The spec | `docs/next-version/RECORD-V2.md` (sections 2.3, 2.10, 2.12, 3, 4.2, 7, and the new section 10) |

The scenario the fixture plays on project A (all on the real unit of 7 days, each transaction at an exact time): a task announced and withdrawn
(day 20); a task taken and paid in part (60%) with a leaver's note, claimed by the leaver; an open task taken by a stranger and sent back, its
leaver's note claimed for the leaver by the stranger; a task that runs out and is returned by someone else's take-out, its note left
unclaimed; a task whose take window passes; the same task record announced twice; one taken with a note outstanding, one in its notice and one
announced again at the example block; a second payment of outside money merged into the first stream; a block after the run-out task's
deadline that no Treasury call settles (`A_overdue`); the wind-down by choice that sweeps what is open. 260 logs, 116 blocks.

### Chosen under the owner's standing go; the owner may overrule

- **Two batches of views at the one block.** The cut of ended rows needs the cap's window (`CAP_WINDOW_MULT`, a view), so the Treasury's and the
  book's own views go first and the rows' `taskOf` and the notes' `noteOf` / `claimableNote` second, at the same block. The plan said one batch;
  the property that matters (one block, the previous record stays on any failure) is kept.
- **`repeatOf` is set only for a row that is itself announced, taken or paid.** A plan that ended unpaid binds nothing, so it repeats nothing.
- **`cut.endedDropped` counts rows that were eligible and did not fit, not rows that aged out.** An ended task older than 28 days with no notes
  left drops out of the list without making `tasks.truncated` true; otherwise every project would read "cut" a month after its first task.
- **The next date breaks ties in a fixed order**: can be taken, lapses, due, room in the cap; then the lowest serial.
- **Ranking of the rows whose note holders are listed** counts an open taken task by `noteFace` and an ended one by `notesLeft`.
- **A taken task past its deadline that nobody settled** has `claimable` equal to its holders' whole `face` (a claim settles first), as
  `money.pot` counts what ran out as back.
- **Serials in the example are not the plan's labels.** The task taken at the example block is serial 6 (announced first), the one in its
  notice serial 7, the repeat serial 8, and a second withdrawn task serial 9; serial 1 (withdrawn on day 20) has aged out of the list. The
  plan wanted a withdrawn row in the example; a task older than 28 days with nothing to claim cannot be in a list cut by the plan's own rule,
  so a second task is withdrawn inside the 28 days.
- **The example block is at day 101.7**, after the door was shut and opened again, so the example is an ordinary live project (door open).
- **The fixture reads the book's field order from the build** (`TASK_FIELDS`), never from a typed list, and the snapshot of every block carries
  every task's raw `taskOf` answer; `pot-run.json` is 0.9 MB for that reason.
- **Per-row checks were not built at M1** (see below): the ledger is tied to the views by the replay test (`A1`) at every snapshot block, and
  the record's own rules (`validate`) tie `money.locked` to the rows, but a build does not yet compare each row with `taskOf`.

### What M1 left to M2

The per-row check against `taskOf`, the notes checks, the `validate` rules for the buckets, the cap and the counts, and the failure of the whole build
on a task mismatch (C33). They are built at M2, below.

### Guards switched off once (U5), and what failed

Each guard was switched off in the production code, the `chain_reader` tests run (the Postgres tests for discovery), and the file put back
(checked afterwards: the code has none of the edits).

| Guard switched off | Where | Tests that failed |
|---|---|---|
| A take that ended unpaid is not given back to the cap (`capGivenBack` ignored) | `ledger_tasks.rs::resolved` | 19, among them `the_ledger_from_the_logs_equals_the_views_for_every_task_after_every_block_of_the_fixture` (A1), `the_ring_frees_list_adds_up_to_the_used_share` (A8) and the record tests that build real blocks |
| The claims of tasks that ran out are not returned to the pot, last (`dueC`) | `record.rs::roll_forward` | `a_run_out_task_is_returned_in_the_settled_pot_and_locked` (A5), `the_box_cap_check_still_holds_with_a_returned_task_and_fails_when_the_return_is_dropped` (A6), `the_cap_numbers_free_the_share_of_a_taken_task_past_its_deadline` (A5c) |
| The step 1 arrival formula instead of the stream's | `record.rs::roll_forward` | **First try: nothing failed (82 passed).** The two formulas are the same line mathematically and differ by a few units of rounding, and every block of the run that was built sat on a settle, so no check saw the difference (the `boxCap` view moves only when a unit flips the rounding). A finding, not a pass: `every_settle_of_the_run_is_what_the_roll_forward_gives_from_the_state_before_it` was added, which works the ledger's numbers just before each of the run's settles forward to the settle's time and compares pot, box, arriving money and active seconds with what the contract's `Settled` event says, exactly. With the step 1 formula back in it fails; with the contract's formula it passes |
| The share a taken task past its deadline will give back is not taken off the cap (`pending_give_back`) | `ledger_tasks.rs` | `the_ring_frees_list_adds_up_to_the_used_share`, `the_cap_numbers_free_the_share_of_a_taken_task_past_its_deadline` |
| Rows with notes still to claim are not listed first (the cut) | `record_tasks.rs::select` | `the_ended_rows_keep_every_row_with_notes_first_and_33_cancelled_tasks_cannot_push_a_note_out`, `note_holders_are_listed_for_eight_rows_and_twenty_holders_each`, `the_example_is_what_the_server_writes` |
| The book is not found from `TasksReady` | `scan.rs::discovered` | 6 of the 14 Postgres tests, among them `the_book_is_found_from_tasks_ready_and_followed_from_that_block`, `a_rollback_past_it_forgets_it` and `the_stored_rows_reveal_a_book_the_reader_did_not_follow_yet` |

Not tried: the migration's role (the buzz-db test `a_database_made_from_the_desired_state_schema_allows_tasks_and_has_the_index` inserts a
`tasks` contract and reads the index definition, so a constraint or an index without it fails it by construction), `repeatOf` (the test
`the_same_what_planned_twice_marks_the_later_row_repeat_of_the_earlier` reads the run's repeated plan).

### What ran

On 20 November 2026, local Postgres and Redis (a database copied from the shared one and given migration 0071 by hand), `CARGO_BUILD_JOBS=2`:

| Command | Result |
|---|---|
| `cargo fmt --check` (whole workspace) | clean |
| `cargo clippy -p buzz-relay --lib --tests -- -D warnings` | no warnings |
| `cargo test -p buzz-relay --lib chain_reader -- --include-ignored --test-threads=1` | **99 passed, 0 failed, 0 ignored** (69 before step 2; 14 of them Postgres-backed, three new) |
| `cargo test -p buzz-db --lib -- migration chain_ --include-ignored --test-threads=1` | **51 passed, 0 failed** (migration count now 71; two new tests of 0071) |
| `node scripts/chain-reader-events.mjs --check` | "pot-events.json, events_table.rs, pot-abi.json and views_table.rs match the contracts/pot build" |
| `python3 -I scripts/chain-reader-fixture.py --check`, three times | "pot-run.json is what a fresh run gives" each time |
| `UPDATE_EXAMPLE=1 cargo test ... the_example_is_what_the_server_writes`, then without | passes; the example is the server's own bytes |

Existing step 1 reader tests that changed, and why: `events_tests::the_table_is_the_forge_build` (35 to 42 pairs: the book's five events and the
Treasury's `TasksReady` and `TaskMoney`), `ledger_tests` (the cross-check literal now carries the new stored numbers; the totals identity gets
the buckets and the two new totals), `record_tests` (the example is the server's output of the new run; the test that raised the door and a
grant count to fixed values now flips what the example holds), `scan_postgres_tests::stored_of` (the same new fields). No step 1 test was
removed and none was loosened.

## Step 2, milestones M2 and M3 (server, 20 November 2026)

WP1, milestones M2 and M3 of `STEP2-SERVER-APP-PLAN.md`: every cross-check of the ledger against the views, the record's own task rules, the
bounded work per project, the publish path, the refresh rule, and the spec. `contracts/pot` is not edited. Nothing is pushed. **The example
record did not change by one byte**: no check found a mistake in M1's output (`UPDATE_EXAMPLE=1` was run and the file is identical), so the
app engineers' fixtures and parsers need nothing from M2 and M3.

### What was built

| Part | Where |
|---|---|
| **The events against the views.** Every listed row, all 17 words of `taskOf` (the generated table names them; a test fails if the tuple grows without a check), every listed holder's `noteOf`, the largest holder's `claimableNote` (a taken task past its deadline that nobody settled: the view says 0, the record says the whole face), `takeRoomBps`, the Treasury's `nextExpiry`, the open count against `MAX_OPEN`; and the sums over **every task the ledger holds**, listed or not: the stayers' claims against `locked()`, the note faces of open tasks plus what is left for the notes of ended ones against `notesOwed()`, each task's claim plus note face against what was set aside (`C + N == L`), the holders' notes against `noteFace`, paid plus returned against what was set aside. A difference names the task, the field and both values and fails the whole build (C33) | `numbers_tasks.rs`, called from `numbers.rs::cross_check` |
| **The record's own rules** (`validate`), redone from the record alone: open rows are the open count (at most 8), listed first, ordered, no serial twice, every serial below `nextSerial`; each row's shape by state; `deadline == takenAt + dueSecs`; `atMostNow`; notes present exactly when something is held, the face, the holders' order and their claims; `money.notesOwed` against the rows; `usedBps + roomBps == capBps`; the `frees` ascending and adding up; `usedBps` and `frees` against the takes of the listed rows still in the window; `nextExpiry`; `next` (a second, independent function over the rows); the cut (`endedWithinSecs`, at most 24 rows with notes and 4 that moved nothing, no ended row older than the cut keeps unless it has notes) and `truncated`; `repeatOf` | `record_tasks_rules.rs`, called at the end of `record.rs::check` |
| **Bounded work per project**, measured on the production read: a book with 8 open tasks and 200 ended ones, each note held by 30 accounts, asks for 32 `taskOf`, 160 `noteOf`, 8 `claimableNote` and the book's twelve calls once each; the record lists 8 + 24 rows, says it left 176 note rows out, is `truncated`, and is far below 300 KB | `task_checks_tests.rs` (the counting node) |
| **The publish path.** A failed task check keeps the project's previous record (every money field of the project freezes with it, which the app's age rules say), logs the task, the field and both values at error level, and the project is signed again once the contract and the events agree. A pass that takes longer than half the shortest refresh time logs an error (plan 1.5, the alarm for folding the per-holder notes into a running-totals table) | `mod.rs::publish_pass`, `pass_is_slow` |
| **The refresh rule.** 600 seconds while any task is open (it was already built at M1), and `refresh_every` never promises more than the settings' ceiling of 43200 | `numbers.rs::refresh_every` |
| **The spec.** `docs/next-version/RECORD-V2.md`: section 6 (the rule and the ceiling), 2.2, 7.3 (the totals identity with `paidToWorkers` and `noteClaims`, the extra checks of the example), 9 (S4), and section 10.4 and 10.5 (what the server checks, what a build costs the node). `PLANV2-M5-REPORT.md`: the "removed" pointer where the config table named the old 60-second-to-7-day range | `docs/next-version/` |
| **The example block against `cast call`s**, field by field, by a script that reads only the example file and asks the chain itself | `scripts/chain-reader-example-check.py` |

### Chosen under the owner's standing go; the owner may overrule

- **`pay` is not in `taskOf`**, so a row's `pay` cannot be held to a view. It is held by `pay + returned == setAside` for every task that ended after a take
  and by `pay == 0` unless the task was paid (both in the cross-check and in `validate`).
- **`usedBps` and `frees` are redone from the listed rows** in `validate`, equal when nothing was cut (`endedDropped` and `notesRowsDropped` are 0) and the
  rows' share a floor when something was. `money.notesOwed` against the rows is the same: equal unless `notesRowsDropped > 0`.
- **`next` is written twice on purpose** (the builder's function over the ledger, `validate`'s over the rows), so a record whose `next` is wrong fails
  in `validate` rather than being checked against itself.
- **`ringIdx` is held to the view** though the record does not carry it: a ledger whose ring is wrong would give wrong cap numbers.
- **The ceiling is applied where the promise is made** (`refresh_every`), not only where the settings are read, so a `Cadence` built any other way cannot
  promise more than half a day.
- **The alarm's threshold** is half of the shorter of the two refresh settings (the one a project with an open task promises).
- **The plan's "about 19 views" per project is out of date**: the step 1 list is 51 fixed calls and the book adds 12; the record spec says so.

### Guards switched off once (U5), and what failed

Method: a temporary switch read from the environment was put in the production code (a filter on the lines the checks write, a filter on `validate`'s
lines, and one `if` at each of the places named below), the test binary built once, each guard switched off in turn, and every temporary line removed
afterwards (`grep` finds none; the files are the committed ones). **Every guard failed at least one test.**

| Guards switched off | Count | Tests that failed |
|---|---|---|
| The per-row check, one field at a time: `what`, `payee`, `state`, `shareBps`, `ringIdx`, `takenBy`, `announcedAt`, `noticeEnd`, `expiresAt`, `takenAt`, `deadline`, `maxDollars`, `locked`, `stayer`, `noteFace`, `returned`, `notesLeft` | 17 | `a_task_row_one_unit_off_the_view_publishes_nothing` (A2, three rows: paid, ran out with a note, taken) |
| Open rows against the open count; open count against `MAX_OPEN`; next serial against the highest; `takeRoomBps`; `nextExpiry` | 5 | `a_ledger_that_does_not_add_up_...`, `the_cap_room_the_next_expiry_and_the_open_limit_are_held_to_the_contract` |
| The buckets and sums: money set aside; money held for notes; `C + N == L`; the holders' notes against the face; paid plus returned; a payment on a task that did not end paid | 6 | `a_ledger_that_does_not_add_up_publishes_nothing_and_says_which_sum` (A4) |
| A listed holder's `noteOf`; the largest holder's `claimableNote`; events that name tasks of no book | 3 | `a_note_or_a_claim_one_unit_off_its_view_publishes_nothing`, `task_events_with_no_book_publish_nothing` |
| Each rule of `validate` (30 rules: the counts and order, serials, `nextExpiry`, `atMostNow` on an open and on a taken row, the notes, the claims, the shape by state, the deadline, `repeatOf` both ways, the cap's room, dates and used share against the rows, `next`, the cut, `truncated`, hex, share and size, `notesOwed` against the rows) | 30 | `a_record_the_task_rules_refuse_is_never_signed` (A14, A17) |
| The task check inside a real publish pass (the per-row `noteFace` guard off) | 1 | `a_task_mismatch_freezes_the_money_fields_and_logs_the_field` (A17, C33; Postgres) |
| The ceiling in `refresh_every` | 1 | `refresh_is_600_while_a_task_is_open_and_3600_after` |
| The alarm (`pass_is_slow` always false) | 1 | `a_pass_longer_than_half_the_refresh_time_is_slow` |
| The cut's bounds: 24 rows with notes; 8 rows with holders; 20 holders per row | 3 | `the_views_of_one_project_are_bounded_whatever_its_history`, and the cut tests (`the_ended_rows_keep_every_row_with_notes_first_...`, `note_holders_are_listed_for_eight_rows_and_twenty_holders_each`) |

Falsifying the example check: a copy of the example with a `noteFace` one unit up, a claim of 1, a `returned` one up, `usedBps` one up and `locked` one up fails
8 of the 194 checks of `chain-reader-example-check.py`, each named.

### What ran

On 20 November 2026, local Postgres and Redis (`buzz_w1_tests`, migration 0071 applied), `CARGO_BUILD_JOBS=2`:

| Command | Result |
|---|---|
| `cargo fmt --check` | clean |
| `cargo clippy -p buzz-relay --lib --tests -- -D warnings` | no warnings |
| `cargo test -p buzz-relay --lib chain_reader -- --include-ignored --test-threads=1` | **110 passed, 0 failed** (99 before M2: 9 new check tests, the alarm's test, and the Postgres test of C33) |
| `cargo test -p buzz-relay --lib config::` | 104 passed, 0 failed |
| `cargo test -p buzz-relay --lib manager::` | 23 passed, 0 failed, 12 ignored; with `--include-ignored`: 34 passed, 1 failed: `planted_eval_against_a_real_model` needs `BUZZ_LLM_PROXY_URL` and a key for a real model and is not about the reader |
| `node scripts/chain-reader-events.mjs --check` | matches the build |
| `python3 -I scripts/chain-reader-fixture.py --check`, twice | "pot-run.json is what a fresh run gives" each time |
| `pgschema apply` of `schema/schema.sql` into an empty database, then `scripts/reconcile-schema-after-pgschema.sql` | applied (393 statements); `chain_contracts_role_check` lists `'tasks'`; `idx_chain_logs_tasks` exists as a partial index on `role = 'tasks'`; the reconcile script needs nothing new (no seed rows). The scratch database was dropped |
| `python3 -I scripts/chain-reader-example-check.py` | **all 194 checks passed**: the example record is what the contracts say at block 88 (30 on the Treasury, the stream and the settled numbers, 14 on the book's counters and limits, 150 on 8 rows, their notes and claims) |
| `UPDATE_EXAMPLE=1 cargo test ... the_example_is_what_the_server_writes` | passes and `git diff` of the example is empty |

Existing tests that changed: none removed, none loosened. `record_tests.rs` made nine of its helpers visible to the new test file and its refresh test gained the
ceiling.

### For the next engineer

- The reader's behaviour a loop will see: a task mismatch gives the line `chain reader: numbers not signed: the events and the contracts disagree, nothing is
  published: task N <field>: events say X, the contract says Y` at error level, a pause of 15 seconds doubling to 5 minutes, and the old record stays.
- `scripts/chain-reader-example-check.py [record.json]` is the field-by-field check of plan 7.3; the loop's checker (WP2) can reuse its field table.
- Not done at WP1: the helper job and the chain loop (WP2); the agree step and `accept --pay-to` (C35, WP2).

## Step 2, the helper and the chain loop (server, 20 November 2026)

### The helper settles a task that has run out (plan 2.7, C14)

A task that nobody returned stays `taken` (or `announced`) in the book until some action settles the Treasury. The helper now makes that action when
nobody does: ten minutes after the task's time, it sends `Treasury.settle()` and nothing else.

- **When** (`helper/plan.rs`): the ledger built from final rows has an open task whose `expiresAt` (the end of its take window, or its deadline once
  taken) plus 600 seconds is at or before the final block's time. One job per project and expiry second, keyed `settle-task:<treasury>:<expiresAt>`; the
  earliest overdue task names it, because one settle returns every task that is due. `due_block` is the block of the row that fixed that second (the task's
  announcement or its take), so a rollback past it deletes the job.
- **Checked again at the head** (`helper/mod.rs::check`): the Treasury's own `nextExpiry()` must be non-zero and ten minutes past at the head's time. Someone
  else's take-out, claim or check-in settles first and moves it on; the job is then dropped, not failed, and nothing is sent.
- **The call** (`helper/calls.rs`): `HelperCall::TreasurySettleTasks { treasury, expiry }`. It has the same signature (`settle()`) and the same stored name
  (`treasury.settle`, the database's list stays closed, no migration) as the settle of arrived outside money; only its stored argument `{"taskExpiry": <second>}`
  tells it apart. A stored argument that is not a second ends the job as failed and is never sent as another settle.
- **Bounded**: the helper's existing machinery applies to the new job: a pause of 60 s that doubles after each failed attempt up to six hours, a terminal
  `failed` state after `BUZZ_CHAIN_HELPER_MAX_ATTEMPTS` (default 8), the daily gas and spend caps, one transaction in flight, and a call that would revert is
  never sent. A failure is kept in the job's row (`attempts`, `last_error`), never swallowed.
- **Never**: the closed list of forbidden calls grew from 35 to 42 with the task book's seven (`announceTask`, `takeTask`, `acceptTask`, `rejectTask`,
  `cancelTask`, `returnTask`, `claimNote`); a test fails if any is in the allow-list or can be produced, and each is checked to be a real function of the
  built contracts.

### The chain loop (plan 2.9): `scripts/chain-loop-pot.sh`, `chain-loop-pot-check.py`, `chain-loop-query.mjs`

The loop now continues after its step 1 walk, on the real 7-day unit (the chain's clock moved with `evm_increaseTime`, a few days at a time, a check-in
before each warp so the project stays open):

| Stop | What was done | What the record must equal |
|---|---|---|
| `planned` | a task planned and withdrawn; three planned and left in their notice | the book from `Treasury.tasks()`, three open rows, one cancelled |
| `taken` | after the notice, a named worker takes one plan, a stranger takes the open one | rows against `taskOf`, money set aside, the cap |
| `note` | a Take out of half the Shares while both are taken (writes notes) | the leaver's `noteOf` on both rows |
| `paid` | the team pays 60% of one task; a stranger claims the leaver's note | `paidToWorkers`, `noteClaims`, the leaver paid and the stranger not |
| `rejected` | the other task is sent back | the cap given back (`windowSumBps` falls by the row's `capBps`) |
| `lapsed` | a plan nobody took lapses at the next check-in; a fifth is announced; a third backer joins | the lapsed row, the new open one |
| `quiet` | the fifth is taken, a second Take out writes a note, the project goes quiet with the task open | `refreshEverySecs` is still the active cadence |
| `returned` | the fifth runs out; **nobody presses anything**; the relay's helper settles it | the helper's one `settle()` is the transaction that resolved it; the idle cadence |
| `claimed` | the leaver claims their own note on the returned task | the totals and the note |

At every stop the checker (`--stop`) compares with `cast call --block <the record's block>`: the book's address, counters, `nextExpiry`, the seven limits, every
listed row's 16 words against `taskOf`, the amount a row promises, `pay + returned == setAside`, every listed holder's `noteOf` and `claimableNote`, the stayers' claims
against `money.locked`, `C + N == L` for each taken task, the notes owed, the cap (`usedBps`, `roomBps`, the frees), which tasks the list holds (open, with
money to claim, or ended inside 28 days, from the loop's own record of when it ended each), the totals the loop knows from what it sent (including the two new
ones), the dollars held against the buckets, and the settled pot, box, arriving money and active seconds worked forward with the stream formula from
`arrivalStart` and `arrivalTotal` and the money of tasks that ran out put back last (`dueC` from the book). After the `note` stop nine copies of the record, each
with one number wrong, must each be refused with a named difference.

The first record (step 1's single stop) is checked in full as before, with the same task checks on an empty book, and now also the arrival formula and the buckets.
The `chain-loop-query.mjs read` condition accepts `path>=number` so a stop can wait for the record to reach a block.

### What ran

| Command | Result |
|---|---|
| `cargo fmt --check` (`buzz-relay`, `buzz-cli`) | clean |
| `cargo clippy -p buzz-relay --all-targets -- -D warnings` | no warnings |
| `cargo test -p buzz-relay --lib chain_reader::helper -- --include-ignored --test-threads=1` (local Postgres and Redis) | **16 passed, 0 failed** (9 before, 7 new) |
| `cargo build -p buzz-relay` | built |
| `scripts/chain-loop-pot.sh`, twice | **758 checks passed** both times (about six times the plan's 125, because every stop repeats the whole task section and the settled numbers; see below) |
| `scripts/pot-chain-loop.sh` | 24 checks passed |
| `cargo test -p buzz-cli launchpad_tasks` | 24 passed, 0 failed (`accept --pay-to`, C35) |

The 758: step 1's record 105 checks (about 15 of them new: the stream, the buckets and the empty book), then nine stops of 64 to 73 checks each (617 in all), and 36
of the loop's own `ok` lines around them (the deployment, the launch, balances, states, the cap given back, the helper's settle, the nine refused copies).

### Guards switched off once (U5)

A temporary environment switch was put in the helper's production code, the test binary built once, and each guard switched off in turn; every temporary line was
removed afterwards (the files compare equal to the backups).

| Guard off | Tests that failed |
|---|---|
| the ten minutes (delay 0) | `a_task_that_ran_out_ten_minutes_ago_gets_one_settle_for_that_second` |
| only open tasks count (all tasks) | the same, `it_is_the_earliest_task_that_runs_out_and_a_settle_ends_the_job`, the weekly fee test |
| the earliest task names the job (the latest instead) | the first two of the plan tests |
| the head's `nextExpiry()` view | `a_task_someone_else_already_returned_is_not_settled_again`, `a_task_that_ran_out_a_second_short_of_ten_minutes_ago_is_left_alone` |
| the growing pause | `a_settle_that_keeps_failing_waits_longer_each_time_and_ends_failed` |
| the attempt limit | the same |
| the call's calldata (another function than `settle()`) | the allowed-selector test, the forbidden-call test, `the_settle_of_a_task_is_settle_and_nothing_else`, two Postgres tests |
| a stored expiry that is not a second read as the other settle | six tests, among them `stored_calls_read_back_and_unknown_ones_are_refused` |
| the helper's task job not built, in the real loop (relay built with the switch) | the loop fails: "the helper did not settle the task that ran out" |
| the loop's checks: nine wrong records | each refused (the loop's own nine checks) |
| `accept --pay-to`: the tag not written, the address not checked | `accept_may_carry_pay_to_and_the_record_is_the_one_the_relay_accepts` |

### For the next engineer (the joined-up loop)

To start a relay that reads tasks, give it what `chain-loop-pot.sh` gives it: `BUZZ_CHAIN_RPC_URL`, `BUZZ_CHAIN_ID`, `BUZZ_CHAIN_LAUNCHER` (the Launcher from
`contracts/pot/deployments/pot-<chain id>.json`), `BUZZ_CHAIN_START_BLOCK` (at or before the launch), and a Postgres with migrations applied (`BUZZ_AUTO_MIGRATE=true`
applies 0071). Nothing is needed to find a project's task book: the reader learns it from the Treasury's `TasksReady` log. For the helper add
`BUZZ_CHAIN_HELPER_KEY` (anvil's public key 7 in the loop) with `BUZZ_CHAIN_HELPER_DAILY_GAS` and `BUZZ_CHAIN_HELPER_DAILY_SPEND_WEI`; without the key nothing
returns a task that ran out, and the next action by anyone does. The helper builds its jobs once a minute at most, from rows two blocks deep, so after a warp
mine at least three blocks and allow about a minute and a half. For a short wait set `BUZZ_CHAIN_ACTIVE_REFRESH_SECS=5` and `BUZZ_CHAIN_REFRESH_SECS=7`
(the loop's values): the record promises the first while a task is open or money moves, the second otherwise, and says so in `refreshEverySecs`.

## Step 2, review fixes (server, 20 November 2026)

Five independent reviews of the step 2 server and app were read; this section is about everything that concerns `crates/**`, the migrations, the schema, `scripts/chain-reader-*`
and the record documents. `contracts/pot` is unchanged (`git diff a8208c2c6..HEAD -- contracts/pot` is empty; `a8208c2c6` is the last commit that touches it). The app findings
(the team side, the holder side, the app part of the fit review) are the other fixer's.

### Fixed

| Finding | What was wrong | What was done | The test that fails without it |
|---|---|---|---|
| Record review I1 (IMPORTANT) | The settled `locked` and `arriving` were worked forward by the server and only `boxCap` (a floor division on the sum, zero at a rate of zero) and `activeNow` were held to the contract. The step 1 arrival formula gave a pot one unit off at 55 of the reviewer's 7,155 blocks and `boxCap` would have missed 54 of them. | `quoteBack(1 dollar)` joins the first batch of views; `numbers::build` requires the worked-forward `locked` and `arriving` to equal its `lockedLine` and `arrivingLine` exactly (with those two exact the settled pot and box together are exact). The fixture generator asks the same call and the fixture was regenerated (7 new answers, one for each book; nothing else moved, and the example record is byte for byte the same). `docs/next-version/RECORD-V2.md` says so. | `task_checks_tests::the_settled_locked_and_arriving_lines_are_held_to_the_contract_exactly`: every book of the run, each line one unit up and down, the refusal names the field and both values. |
| Relay review IMPORTANT 1 | A plan that was over but not settled (its window or deadline past, nobody had called the Treasury) won the lowest-serial choice, was then judged "over", and so hid a live later plan of the same record: a `confirm` and a `cancel` that should be refused were accepted, and a `take` of the live plan was refused as ended. | `plan_of` treats a row that is not paid and is past its end as ended for the choice and takes the next live serial; when no row is live the lowest over one is still the plan (a take of it is refused with words, as before); a paid row binds for ever. | `task_chain::tests::a_plan_past_its_end_does_not_hide_a_live_later_plan_of_the_same_record`; Postgres `a_plan_past_its_end_that_nobody_settled_does_not_hide_a_live_repeat_of_the_same_record` (the reviewer's 1a, 1b, 1d; 1c is the same decision for a taken plan, covered by the unit test). |
| Relay review IMPORTANT 2 | A `confirm` of a paid plan only compared the payment's transaction; a team that planned its own wallet as payee, took it and paid itself could record that as the named worker's paid task. | `enforce` reads the worker's own `take` and `accept` steps of the task (`task_takes::stored_pay_to`, the same rule as the app's `payToOf`: all steps the worker signed, two different wallets read as none) and `decide_chain` refuses with `PAID_ELSEWHERE` unless it equals the wallet that took the plan on the network. A worker who named none is refused too (a planned task has a named wallet by C4 and C35). `enforce` takes a `StepOn` (step, task id, worker) so the signature stays small. | `task_chain::tests::a_confirm_of_a_paid_plan_needs_the_wallet_the_worker_named`; `task_takes::tests::the_wallet_a_worker_named_is_the_one_they_all_agree_on`; Postgres `a_confirm_is_refused_when_the_network_paid_a_wallet_the_worker_never_named` (another wallet: refused; none: refused; the wallet that was paid: accepted). The two older confirm tests now have the worker take first, naming the paid wallet. |
| Fit review IMPORTANT 1 | A take, accept, confirm or cancel of a planned task scanned the project's whole task book twice and read every stored block of the reader for `max(block_time)`. | Migration 0072 (and `schema/`): two partial indexes, `idx_chain_logs_task_what` (the announced rows of one task record) and `idx_chain_logs_task_serial` (the takes and resolutions of a serial), neither holding the notes. The newest block is read as `ORDER BY number DESC LIMIT 1` through the primary key. The three queries are constants shared by the code and the test. | Postgres `the_plan_reads_use_their_indexes_and_never_scan_every_block` (with sequential scans off and the general indexes out of the way the plan must use the new indexes and the primary key; with `idx_chain_logs_task_what` dropped it fails, tried); `buzz-db` `chain_task_lookup_indexes_migration_matches_the_desired_schema`; the migration count is 72; the Postgres migration test checks both indexes in a migrated and in a schema-made database. |
| Relay review OPTIONAL 3 / fit review OPTIONAL 5 (`PLANS_READ`) | A record announced 65 times: the old cut read 64 rows and, if all had ended, said "no plan", switching every rule off for a live 65th. | The lookup reads 65 rows and fails (a server fault, the write is refused) when there are more than 64. | Postgres `a_record_announced_more_often_than_the_lookup_reads_is_refused_not_guessed_at`, and `a_plan_that_ended_unpaid_is_followed_by_the_live_repeat_of_the_same_record` (a sent-back plan and a live repeat; with the read cut to one row it fails). |
| Fit review OPTIONAL 5 (the 28-day boundary, the four quiet rows, `atMostNow` at the second a take window ends) | Three guards no test bound: moving each constant or comparison changed nothing that failed. | Tests with literal numbers on the production path. | `record_tasks::tests::an_ended_row_is_kept_for_28_days_to_the_second`; `..the_ended_rows_keep_every_row_with_notes_first..` now says 4 and 29 as numbers and asserts `MAX_QUIET_ROWS == 4`; `..at_most_now_stops_at_the_second_a_take_window_ends`. |
| Record review OPTIONAL 5 | The `atMostNow` line in `docs/next-version/RECORD-V2.md` said "the most a take at `asOf.time` would set aside" although a take is refused while the notice runs. | The line now says it is shown during the notice so holders see what would be set aside. | docs only |

Scratch tests of the server side: `crates/buzz-relay/tests/review-s2-live.rs` (the record reviewer's live-chain walk) is **deleted**. It needs a Python chain driver that lives outside the repository (random
walks of the real contracts on a fresh anvil) and the reader's whole scan path against it; its finding is now the fixture test above, and its live path (real scan, real views, `derive` at every
block) is what `scripts/chain-loop-pot.sh` runs on every build (758 checks, which now includes the new exact comparison at every stop). The relay reviewer's `review-s2-wire.*` scripts are outside the
repository; their seven attacks are the Postgres tests above (1a, 1b, 1c, 1d and 2a, 2b), one per attack. None of the server's scratch files remain, tracked or untracked.

### Declined, with the reason

- **Record review OPTIONAL 1** (an unknown topic from a followed contract is dropped for good, so an old reader never finds a step 2 book and refuses to sign for ever, fail closed): no code change. A warning on every
  unknown topic would fire for the ordinary events of the tokens, which the table does not list on purpose. The operational answer is in "For the next engineer": deploy the new reader before the first project is launched
  on the new Launcher.
- **Record review OPTIONAL 3** (`CREATE INDEX` not `CONCURRENTLY`): the migration runner is transactional and `CONCURRENTLY` cannot run in a transaction; the indexes are partial and build quickly. Migration 0072 follows the same rule.
- **Relay review OPTIONAL 1** (`confirm` is refused with `retry:` while the launch is not read, even for a task that never had a plan): the agreed C26; the reviewer says the same.
- **Relay review OPTIONAL 2** (a helper plan error for the task job drops the project's other jobs until the next build): the error is logged and propagates on purpose (rule 1: nothing caught is turned into success); it is not reachable today
  because the ledger and the rows come from the same logs, and the next build is 60 seconds away.
- **Relay review OPTIONAL 4** (a record with no `chain-key`, or another `a` kind, is not tied): the relay rules are early refusals; the app's re-read of the chain before any payment is the real check, and the team is the payer.
- **Fit review OPTIONAL 3** (a `kind.rs` test that 47003 stays the only task kind): there is no way to ask "which kinds are task kinds" of the kind list; a test that pinned the whole list would fail for every unrelated kind added. No kind was added in step 2.
- **Fit review OPTIONAL 6** (the plan's end is judged by the newest stored block, not the wall clock): documented in `task_chain.rs` and the plan; unchanged.
- **Fit review OPTIONAL 8** (an open plan with no payee can be taken by anyone on the chain and the app never offers it): the plan's choice C9.
- The app findings of all five reviews (team B1, I1 to I5, O1 to O5; holder I1 to I3 and O1 to O4; fit I2 and O1, O2, O7): the other fixer's.

### Still open

- **Record review OPTIONAL 2**: the per-pass work is O(all stored rows of a project) (plan C37, accepted). The slow-pass alarm only logs; someone has to watch for it.
- **Record review OPTIONAL 4**: a runner that announces tasks eleven minutes apart gets one settle from the helper for each lapse; bounded by the helper's daily gas and spend caps.
- **Fit review OPTIONAL 4**: `store::reveals` reads all of a reader's history for the Launcher events and `TasksReady` on every scan range (the same pattern as step 1).
- The record review's operational note: `scripts/chain-loop-pot.sh`, the fixture generator, `pot-full-loop` and any random walk deploy with forge and rewrite the git-ignored `contracts/pot/deployments/pot-31337.json`; two running at once can leave it half written. Do not run them side by side.

### Guards switched off once (U5)

A temporary environment switch (`S2_OFF`, read in the production code) was put in beside each guard, the test binary was built once, each guard was switched off in turn, and the switches were removed afterwards (the
three source files compare equal to their backups by sha256). The index guard was tried by dropping `idx_chain_logs_task_what` from the test database for one run and creating it again.

| Guard off | Tests that failed |
|---|---|
| none (control) | 149 passed, 0 failed (`chain_reader`, `task_chain`) |
| the two settled-line comparisons (`quoteBack`) | `the_settled_locked_and_arriving_lines_are_held_to_the_contract_exactly` |
| the "past its end counts as ended" choice in `plan_of` | the unit test and the Postgres test above |
| the worker's wallet check on a paid confirm | the unit test and `a_confirm_is_refused_when_the_network_paid_a_wallet_the_worker_never_named` |
| the read of 65 rows cut to one | the live-repeat test, the sent-back test, the 65-plans test |
| the failure on more than 64 plans | the 65-plans test |
| the 28-day boundary `>` to `>=` | `an_ended_row_is_kept_for_28_days_to_the_second` |
| four quiet rows to five | `the_ended_rows_keep_every_row_with_notes_first_and_33_cancelled_tasks_cannot_push_a_note_out` |
| `atMostNow` at the second the window ends (`<` to `<=`) | `at_most_now_stops_at_the_second_a_take_window_ends` |
| the partial index `idx_chain_logs_task_what` | `the_plan_reads_use_their_indexes_and_never_scan_every_block` |

### What ran

| Command | Result |
|---|---|
| `cargo fmt --check` | clean |
| `cargo clippy -p buzz-relay --lib --tests -- -D warnings` | no warnings (one `too_many_arguments` on the first try, fixed with `StepOn`) |
| `cargo test -p buzz-relay --lib -- chain_reader --include-ignored --test-threads=1` | **120 passed, 0 failed** (117 before, 3 new) |
| `... launch_update_authority` | 32 passed, 0 failed |
| `... task_takes` | 6 passed, 0 failed |
| `... task_chain` (unit and Postgres tests of the task rules) | **29 passed, 0 failed** (22 before, 7 new; the new `task_takes::tests` case is outside this filter) |
| `... manager::` with `--skip planted_eval_against_a_real_model` | 34 passed, 0 failed; the skipped test needs `BUZZ_LLM_PROXY_URL` and `BUZZ_LLM_API_KEY` for a real model and panics without them, as it always does |
| `... config::`, three times in a row | 104 passed, 0 failed, each time |
| `cargo test -p buzz-db --lib -- migration chain_ desired --include-ignored --test-threads=1` (migration count 72, the schema tests, the Postgres migration tests) | 55 passed, 0 failed |
| `cargo test -p buzz-cli launchpad_tasks` | not run: nothing in `buzz-cli` changed |
| `node scripts/chain-reader-events.mjs --check` | "match the contracts/pot build" |
| `python3 -I scripts/chain-reader-fixture.py --check`, twice | "is what a fresh run gives", both times |
| `forge fmt --check src script test`, `forge build`, `forge test` (once) | clean; built; **540 tests passed, 0 failed** (55 suites) |
| `cargo build -p buzz-relay` | built |
| `scripts/chain-loop-pot.sh` | **758 checks passed** |
| `scripts/pot-chain-loop.sh` | 24 checks passed |

### For the next engineer

- **Migration 0072 is new** (two partial indexes). The shared test database `buzz_w1_tests` had it applied by hand (the file, then a row in `_sqlx_migrations` with the file's sha384 as the checksum; `buzz-admin migrate` sees it as applied) because building `buzz-admin` takes ten minutes on this machine. A database
  that is migrated by `buzz-admin migrate` or by the relay with `BUZZ_AUTO_MIGRATE=true` gets it by itself.
- **Deploy order**: the new reader (this build) must run before the first project is launched on the step 2 Launcher; an older binary drops the unknown `TasksReady` and `TaskMoney` topics for good (stored rows are final), never finds the book and refuses to sign for that project (fail closed, no wrong record).
- The relay's `confirm` rule now needs the worker to have named the wallet on a `take` or `accept` step they signed, for a task whose plan the network paid. The app's own flows already do (the e2e helpers take naming the payee); any script that confirms a paid plan must, too.
- `contracts/pot/deployments/pot-31337.json` is rewritten by every deploy; do not run two loops at once.
- Commits of this section: `a2e433ae2` (the exact `quoteBack` lines), `f7fb96c7c` (the relay rules and migration 0072), `b009b97e4` (the boundary tests and this section).

## Step 3, package P1: the record's social keys and the ranking index (server, 20 November 2026)

The plan is `docs/archive/STEP3-PLAN.md` (sections 2, 3 and 9.2); the spec is `docs/next-version/RECORD-V2.md` section 11. Nothing in `contracts/pot` changed; the
record stays version 2 with four new keys and one new signed index.

### The two leftovers of step 2

| What | Done |
|---|---|
| The ranking of ended rows with unclaimed notes (largest first, then newest) had no test that failed without it | `record_tasks::tests::past_24_rows_with_notes_the_largest_stay_and_a_tie_keeps_the_newest`: thirty ended rows with notes, the twenty largest on the oldest serials and ten equal small ones, a cap of 24: the twenty largest and the four newest of the equal ones stay, six are counted. With the size ranking taken out it fails; with the newest-first tie-break taken out it fails (both tried). |
| `the_plan_reads_use_their_indexes_and_never_scan_every_block` failed once in thirteen runs | The primary key of `chain_logs` is dropped inside the test's transaction too (rolled back), so the planner can only use the partial indexes. A second, separate failure showed up after migration 0073 (five runs in a row after the chain tests had filled and emptied the table): with stale statistics the planner could serve the newest-block read from a new index on `chain_blocks` and a sort. Two fixes: the new index is `(reader, block_time)` (it holds no `number`, so it cannot compete for that read), and the test drops it for its transaction as well. Ten runs in a row pass, taken right after `chain_reader` and `task_chain` had run. |

### What is built

| Piece | Where |
|---|---|
| `held`: each account's lowest balance over a 30-day and a 13-unit window, counted by the database (one row per account, the row cap before the running sum, two caps: 500,000 rows and 20,000 accounts), the pure `lowest`, the in-memory `walk` the tests hold the SQL against | `chain_reader/held.rs` |
| `feed`, `streaks`, `established`, the four record types, the checks (`check_held`, `check_feed`, `check_streaks`, `check_established`, the recount from the rows `check_feed_rows` and `check_streaks_rows`) and `fill` (builds the four keys, checks each, signs a failing one as `null`) | `chain_reader/record_social.rs` |
| `Record` carries the four keys (always present, `null` when unknown); `validate` repeats the record-only checks; `facts_of` strips the four keys so they never make the server sign again alone | `record.rs`, `numbers.rs` |
| `Ledger::excluded`: the one list of accounts nobody holds for, used by `holders` and by the held count | `ledger.rs` |
| The ranking index (`explore_of`, the tie to a coordinate, the standing, `publish`) and the five columns written beside each signed record | `chain_reader/explore.rs`, `store.rs` (`RankingColumns`, one statement) |
| `publish_project` counts the two windows (a database error leaves `held` null and is tried again at the next build), `publish_pass` builds the index at most every 600 s; the pass report gains `social_failed`, `held_cut`, `explore_signed`, `explore_failed` | `chain_reader/mod.rs` |
| Migration 0073 and the desired-state files: `idx_chain_balance_changes_block (reader, project_key, token, block_number, log_index)`, `idx_chain_blocks_time (reader, block_time)`, five nullable columns on `chain_project_numbers` | `migrations/0073_chain_held_indexes.sql`, `schema/tables/public/{chain_balance_changes,chain_blocks,chain_project_numbers}.sql` |
| The fixture run gains a dip (the second backer sends half its Shares to the first on day 41, the first sends them back on day 55) and a late buyer (the first backer gives 2 percent of its Shares to a third account on day 88); the example is regenerated | `scripts/chain-reader-fixture.py`, `testdata/pot-run.json`, `docs/next-version/record-v2-example.json` |
| An independent recomputation of the four keys from the raw logs and the chain's own balances, run on the example (222 checks) and at every stop of the loop | `scripts/chain-social-recompute.py`, used by `chain-reader-example-check.py` and `chain-loop-pot-check.py` |

### Chosen under the owner's standing go; the owner may overrule

- **The index on the changes holds `log_index` too** (the plan said `(reader, project_key, token, block_number)`): then `ORDER BY block_number, log_index` is the index's own order and the `LIMIT` stops the scan; with the plan's index the planner sorted every row of the window before the limit and the bound was not a bound (found by the test of section H9, which now fails without it).
- **The window's first block is a scalar subquery**, not a join: the join form made the planner sort every row of the window (the same finding).
- **The first-block index is `(reader, block_time)`** and not `(reader, block_time, number)`, for the reason in the first table above.
- **`seen` of the ranking index counts the projects that passed the tie**; the standing (listed, not removed, founder not banned or muted) is asked down the sorted list until 20 are found, at most 100 asks, so a project that fails its standing is in `cut`, not in `entries`.
- **No index is signed when there is nothing to list and none is live.**
- **The window for a change at exactly the window's start**: a change counts as inside when its block's time is *later* than the start (a change at the start is part of the start balance).
- **`TaskResolved` states**: paid is `task_paid`, cancelled is `task_withdrawn`, sent back, ran out and lapsed are `task_ended`.
- **A database error in the held count is counted as a failed key** (`social_failed`) and logged with the project, like a failed check.

### Guards switched off once (review rule 3)

Each edit was made in the production file, the tests were run, and the file was put back (compared byte for byte with the saved copy).

| Guard off | Tests that failed |
|---|---|
| ended rows with notes ranked by size | `past_24_rows_with_notes_the_largest_stay_and_a_tie_keeps_the_newest` |
| the newest-first tie-break of that ranking | the same test |
| the `LIMIT` of the window query moved after the running sum (written as a limit that never bites) | `h9_the_bound_is_real_on_a_table_of_a_million_rows` (the scan returned 5,000 rows, not 1,001) |
| the block lower bound of the window query taken out | the same test (4,001 rows, not 1,000) |
| the SQL's `rows_read > rows_max` cut | `h4_a_window_over_its_caps_is_cut_in_the_database` and the H9 test |
| the walk's row cap | `h4_a_window_over_its_cap_is_cut_and_one_at_the_cap_is_not` |
| rounding half up (one less than half a step) | `f2_the_net_is_rounded_once_per_hour_half_up` |
| the open window being empty no longer skipped | `s1_to_s4_streaks_are_launch_aligned_and_do_not_slide` |
| two signers: the same signer twice counts | `h5_the_badge_rule_on_its_inputs` |
| `facts_of` not stripping the four keys | `v4_facts_of_strips_the_four_keys` |
| `validate` not running the social checks | `v1_validate_refuses_a_verdict_that_contradicts_its_inputs` |
| the `established` check removed | the same test |
| the recount of the feed from the rows | **none failed at first** (the guard was not bound); `v2_the_recount_from_the_rows_catches_what_the_record_alone_cannot` was written and fails without it |
| the tie of a project to its coordinate | `ix2_and_ix3_the_index_lists_tied_projects_and_is_signed_only_when_it_changes` |
| the `NOT stale` of the ranking rows | the same test |

### What ran

| Command | Result |
|---|---|
| `cargo fmt --check` | clean |
| `cargo clippy -p buzz-relay --lib --tests -- -D warnings` | no warnings |
| `cargo test -p buzz-relay --lib -- chain_reader task_chain --include-ignored --test-threads=1` (Postgres and Redis running) | **187 passed, 0 failed** (156 in `chain_reader` before the tests of this section grew to 158; 29 in `task_chain`) |
| `cargo test -p buzz-relay --lib -- --skip mesh_demo` | 1848 passed, 0 failed, 628 ignored. `api::mesh_demo::tests::demo_join_forwarded_arm_round_trips_echo` fails here with a 504: it calls out to the network, which the sandbox's proxy does not allow; it is not touched by this work |
| `cargo test -p buzz-db --lib -- migration chain_ desired --include-ignored --test-threads=1` (migration count 73, the 0073 text against the desired-state schema, the Postgres migration tests for 0073 in a migrated and a schema-made database) | 58 passed, 0 failed |
| `node scripts/chain-reader-events.mjs --check` | match the contracts/pot build |
| `python3 -I scripts/chain-reader-fixture.py --check`, twice | "is what a fresh run gives", both times |
| `python3 -I scripts/chain-reader-example-check.py` | **416 checks passed** (222 are the four social keys, recomputed from the raw logs) |
| `scripts/chain-loop-pot.sh` (a real relay on a real chain; the social check runs at every stop) | **2936 checks passed** (758 before) |
| `scripts/check-postgres-test-discovery.py` over the reader and the buzz-db tests | validated |
| the plan-reads test, ten runs in a row after `chain_reader` and `task_chain` | 10 passed |

### For the next engineer

- **Migration 0073 is new.** A database migrated by `buzz-admin migrate` or by the relay gets it by itself. The migration macro embeds the files at compile time: after adding a migration, touch `crates/buzz-db/src/runtime/migration.rs` or the migrator does not see it.
- **The example changed** (the fixture gained transfers, so every block number moved and the example block is 91 now). Anything that read the old example by block number needs the new one; nothing is hand-copied. The app's strict parser test `numbers-hostile.test.ts` walks every path of the example and expects a null parse for a bad value: the four social keys must be left out of that walk (they are parsed apart and a bad one reads as `null` for that part only).
- **The four keys are `null` or objects, never missing** in a record this server signs; a record from an older server has no such key at all (the app reads both as "not known here").
- **`held.rank.accounts` and `held.countedAccounts` use `value.leaveValue` and `limits.minJoin` of the same record**; at a one-cent Share they carry the 6-decimal rounding of `leaveValue`.
- **The ranking index is signed only when its entries change**, at most every 600 s, and not at all while nothing could be listed. A project is listed only once the reader has stored a project record whose coordinate hashes to the launch's `projectId`: on the fixture chain nothing hashes, so the ranking is empty there.
- **Scratch databases:** the H4, H8, H9 and H10 tests create `held_<uuid>` databases and drop them at the end; one left behind after a crash is harmless and can be dropped by hand. H9 needs about 300 MB of disk for a moment.


## Step 3, package P3: web push alerts and the sponsored-fee limit (server, 20 November 2026)

The plan is `docs/archive/STEP3-PLAN.md` (section 6 and the tests P1 to P16 and K1 to K9 of 9.2); the operator's page is `docs/web-push-deployment.md`;
what the app reads is `docs/next-version/RECORD-V2.md` section 12. Nothing in `contracts/pot` changed and no record changed: this package adds one migration, a module,
two paths and two keys of the information document. **Both services are off unless the operator names what they need, and neither is on in a plain
deployment.**

### What is built

| Piece | Where |
|---|---|
| Migration 0074 and the desired-state files: `web_push_subscriptions` and `web_push_outbox` (community tables, fenced, in the deletion catalog), `web_push_cursor`, `web_push_alerts` and `sponsor_usage` (operator-global, registered in the migration, the seeds and the reconcile script) | `migrations/0074_web_push_and_sponsor.sql`, `schema/{tables/public,seeds,triggers}/`, `schema/schema.sql`, `scripts/reconcile-schema-after-pgschema.sql`, `crates/buzz-db/src/{runtime/migration.rs,store/deletion.rs}` |
| RFC 8291 message encryption (`aes128gcm`, one record) on `p256`, `hkdf` and `aes-gcm`, which are now direct dependencies (they were transitive); the RFC's own appendix A is a test | `web_push/ece.rs` |
| RFC 8292 VAPID: the ES256 token written by hand on `p256` (no `jsonwebtoken`), the keyed per-device topic; the RFC's example token is a test | `web_push/vapid.rs` |
| Settings: both of `BUZZ_WEB_PUSH_VAPID_PRIVATE_KEY` and `BUZZ_WEB_PUSH_SUBJECT`, or neither (one is a startup error that names both); `BUZZ_WEB_PUSH_DAILY_CAP`, `_MAX_PER_ACCOUNT`, `_EXTRA_HOSTS`. Push also needs the chain reader | `web_push/settings.rs`, `config.rs` |
| Where an address may point, and where it is sent: known push services or the operator's list, no credentials, the name resolved at send time and the connection made to the address that passed (`pick_address`), no redirect | `web_push/hosts.rs` |
| `PUT` and `DELETE /push/web`, signed per request (NIP-98), 10 requests an hour per account | `api/web_push.rs`, `web_push/store.rs` |
| The alert maker (cursor at the reader's position, task rows to alerts, audience, caps, rollback) and the sender (lease, backoff, terminal state, pause, one sender per deployment) | `web_push/alerts.rs`, `web_push/sender.rs`, started from `main.rs` |
| `POST /sponsor`: the pins, the call-data reader (`calldata.rs`, held to the app's own decoder by vectors the app's encoder made), the three limits on ordinary operations, exits counted only against one address cap | `api/sponsor.rs`, `api/sponsor/calldata.rs`, `scripts/sponsor-calldata-vectors.mjs` |
| `/info` carries `webPush` (only when on) and `smartAccountLinks` (whenever there is a chain reader) | `nip11.rs` |
| The stand-in push service (Node, no dependencies: makes devices, decrypts, checks the VAPID token) and the real-relay loop | `scripts/web-push-standin.mjs`, `scripts/web-push-loop.sh`, `scripts/web-push-loop-client.mjs` |

### Chosen under the owner's standing go; the owner may overrule

- **Any `2xx` is delivered.** The plan said 201; the push services answer 201, and a 200 or 202 from a gateway means the same.
- **A row's age is measured on the chain's clock**: a task row more than 24 hours older than the newest block the reader has stored is dropped, not
  the wall clock (a test chain's clock is not the wall's, and a stopped reader that catches up drops what is old either way).
- **A plan the chain already shows as withdrawn makes no `planned` alert** (the plan says a withdrawn plan makes none; the app's alert comes from the
  signed record, which never lists a plan withdrawn before it was written). A plan alerted and withdrawn later is not taken back.
- **`gone` is momentary**: a 404 or 410 marks the row and deletes the device in one transaction, and the device's rows go with it (cascade), so the
  durable record of a gone device is the metric `buzz_web_push_sent_total{result="gone"}` and nothing in the table. (The alternative, rows that outlive their
  device, would keep a trace of a person who turned alerts off.)
- **A deleted device takes its outbox rows with it**, delivered ones too, so the daily cap restarts for a device that comes back. A person who turns
  alerts off has nothing about the device left.
- **No `failures` column on the device row** (the plan listed one): failures are counted on the outbox row, where the retry record is, and the device row keeps nothing else.
- **`BUZZ_WEB_PUSH_EXTRA_HOSTS` may be plain `http`** (and may resolve to a private address), only for the exact `host` or `host:port` the operator listed:
  a local stand-in has no certificate. Every other address must be `https`.
- **A subscription-request limit of 10 an hour per account is kept in memory per process** (the way self-serve creation keeps its caps), with a hard
  capacity, not in the database. Behind a load balancer the real ceiling is the cap times the number of servers.
- **The cut of the audience is counted up to 100,000** (one bounded count query), so `cut` is exact below that and a floor above it.
- **`/sponsor` is an exact path in the NIP-FI exempt list** (`router.rs`): a phone account has no session to present, and the path carries its own pins
  and limits. `PUT` and `DELETE /push/web` are not exempt. Its refusals are HTTP 200 JSON-RPC errors (a 4xx would be hidden and a 5xx retried by the app).
- **The server-wide sponsor total is kept per reader (`all:<reader>`)**, the deployment, not one global key.
- **A sponsor request whose `chainId` is not the reader's chain is "not allowed"**, and so is any target that is not a contract the reader follows, the
  dollar token or the Launcher; the allow-list is read from the reader's tables and kept 30 seconds.
- **Sponsor and push both need the chain reader**: either set without `BUZZ_CHAIN_RPC_URL` stops the relay at start.
- **The alert maker replays only the project's launch row** to find the contract accounts (`Ledger::excluded`, the one list), not every row.
- **Dependencies**: `p256` (features `arithmetic`, `ecdsa`, `std`; no `ecdh`, so the shared secret is the scalar multiple's x coordinate), `hkdf` 0.13 and `aes-gcm` 0.10.
  `Cargo.lock` gains only the three entries in `buzz-relay`'s dependency list (no crate that was not in it); the sources of the curve crates had not been downloaded until now.
- **The tick is every 5 seconds**; one pass claims up to 32 rows and sends 8 at a time.

### Small changes outside P3's own list (each minimal)

- `crates/buzz-relay/src/api/public_read.rs`: `client_address` is `pub(crate)` (the sponsor reads the client's address by the rule the public reads use).
- `crates/buzz-relay/src/handlers/room_support.rs` (P2's test support): the reader's community host is the test's own, so the alert maker finds the world's community.
- `crates/buzz-db/src/store/deletion.rs` and `runtime/migration.rs`: the two new community tables are in the deletion catalog and in the fence-attachment test; the migration count is 74.
- `scripts/sponsor-calldata-vectors.mjs` and `scripts/web-push-loop-client.mjs` are scripts the plan did not name (the vectors the Rust reader is held to, and the loop's Nostr half).
- `app/.env.example`: the sponsor lines now say `/sponsor` exists and which settings it reads.

### Guards switched off once (review rule 3)

Each edit was made in the production file, the tests of the whole package were run, and the files were put back (compared byte for byte). Three runs of
many edits each, so a failing test is matched to its edit by what it asserts; where two edits share a test it is said.

| Guard off | Tests that failed |
|---|---|
| the cursor starts at 0, not the reader's position | `p7b_a_fresh_cursor_starts_at_the_readers_position_and_old_rows_make_no_alert` (100 old rows made 100 alerts) |
| the unique key absorbs nothing (a repeated row makes a second alert) | `p7_one_alert_per_task_event_and_a_repeated_pass_or_a_rewound_cursor_makes_no_second` |
| the audience has no floor (a holder of one wei, and a person who took out and holds a zero row, are told) | `p8_the_audience_is_largest_first_above_the_floor_and_cut_at_2000_with_the_cut_counted`, `p8_only_a_linked_holder_is_told` |
| the contract accounts are not left out of the audience | `p8_the_audience_is_largest_first_...` (it is the only one that asserts an excluded account) |
| no cut at 2,000 | `p8_the_audience_is_largest_first_...` |
| no daily cap, no project cap | `the_daily_cap_and_the_project_cap_say_which_one_held`, `p10_the_project_cap_and_the_daily_cap_write_dropped_rows_with_their_reason` |
| no rollback handling | `p14_a_rollback_deletes_pending_rows_and_leaves_delivered_ones` |
| a plan the chain shows as withdrawn still alerts | `a_withdrawn_plan_makes_no_alert_and_the_other_endings_do` |
| a row older than the alert's lifetime is sent | `a_row_older_than_the_alerts_own_lifetime_is_too_old`, `a_row_older_than_the_alerts_own_lifetime_is_dropped_not_sent` |
| the cursor moves before the work (not in the transaction of the alerts) | `a_failed_pass_keeps_the_cursor_and_the_next_pass_makes_every_alert` |
| the pause does not grow | `the_pause_doubles_from_a_minute_to_six_hours`, `p9_retry_after_is_honoured_...` |
| more than 8 attempts (80) | `p9_retry_after_is_honoured_the_pause_doubles_and_the_eighth_attempt_ends_failed` (alone in its run) |
| `Retry-After` ignored | `p9_retry_after_is_honoured_...` at its first assertion ("the service's wait is honoured, not the 60 s") |
| a gone device is kept | `p9_a_404_and_a_410_delete_the_device` |
| a crashed lease is never reclaimed | `a_claim_holds_a_lease_a_crashed_lease_is_reclaimed_and_a_release_gives_the_attempt_back` |
| a device beyond the cap stays | `p5_at_most_the_cap_of_devices_stay_and_the_oldest_goes`, `p5_requests_at_once_cannot_leave_more_than_the_cap`, `p4_and_p5_a_bad_subscription_writes_nothing_and_the_cap_holds_through_the_path` |
| a redirect is followed | `a_timeout_is_a_retry_and_a_redirect_is_a_terminal_refusal_that_is_never_followed` |
| the address is not checked again at send time | `an_address_that_is_no_longer_allowed_is_not_called` |
| the sender never pauses after refusals of the key | `three_different_devices_refused_in_a_row_pause_the_sender_once`, `p13_repeated_refusals_of_the_operators_key_pause_the_sender_once` |
| every replica sends (the lock always held) | `p15_and_p16_the_sender_is_not_started_when_off_and_only_one_replica_sends` |
| the topic is a plain hash of public values | `topics_are_per_device_stable_for_one_alert_and_not_a_plain_hash`, `p12_topics_are_per_device_stable_for_one_alert_and_keyed` |
| a different content-coding label in the key derivation | `rfc8291_appendix_a_vector` |
| a device key off the curve is kept | `a_good_subscription_passes_and_every_bad_one_is_refused_with_a_sentence`, `p4_and_p5_...` |
| any host is allowed | `the_known_services_pass_and_everything_else_is_refused`, `p4_and_p5_...` |
| a private or loopback address counts as public | `private_loopback_and_link_local_addresses_are_not_public`, `the_address_that_passes_is_the_one_connected_to` |
| the information document names no `webPush` | `the_information_document_says_webpush_only_when_on_and_whether_phone_links_can_be_checked` |
| an exit counts like any other operation | `an_exit_meets_only_the_address_cap_and_every_other_operation_meets_three`, `k8_an_exit_is_never_counted_or_refused_by_the_person_or_server_limit`, `k9_a_stranger_can_use_up_a_victims_day_but_never_the_victims_exit` |
| no per-account, no server-wide, no per-address limit (three edits) | `k1_the_per_account_limit`, `k2_the_server_wide_limit`, `k3_the_per_address_limit` |
| a refused or unreachable upstream keeps its count (two edits) | `k4_the_reservation_is_released_when_the_upstream_refuses_or_fails` |
| any method, any chain, any target, a body of any size (four edits) | `the_request_is_pinned`, `the_pins_hold_through_the_handler` |

**Not switched off, and why.** The NIP-98 requirement of the two paths is the existing verifier's (`bridge.rs`), tested by the unsigned and tampered
and replayed requests of `p6_the_paths_need_a_signed_request_and_a_person_removes_their_own_devices`, but not switched off. `FOR UPDATE SKIP LOCKED`
is exercised by two claimers at once in the lease test, which also passes with it removed on a small queue (Postgres re-checks the row), so that test
does not bind it; it is named as unbound. The upstream's address never appearing in a **log line** is held by reading the code (no error from the
upstream request is ever printed; `forward` returns nothing but its own status) and by `k7` for answers and `Debug`; no log capture was built.

### What ran

| Command | Result |
|---|---|
| `cargo fmt --check` | clean |
| `cargo clippy -p buzz-relay -p buzz-db --all-targets -- -D warnings` | no warnings |
| `cargo test -p buzz-relay --lib -- web_push api::sponsor api::web_push config:: nip11 --include-ignored --test-threads=1` (Postgres and Redis running) | **204 passed, 0 failed**. Of these 73 are new in this package: 47 in `web_push` (3 RFC 8291, 4 VAPID, 4 addresses, 1 settings, 2 store, 5 alerts, 3 sender, 1 message; 11 alert maker, 9 sender and 4 device rows against Postgres), 6 in `api::web_push` (2 pure, 4 Postgres), 18 in `api::sponsor` (5 pure, 4 call data, 9 Postgres) and 2 settings tests in `config::` |
| `cargo test -p buzz-relay --lib -- --skip mesh_demo` | 1903 passed, 0 failed, 694 ignored |
| `cargo test -p buzz-db --lib -- migration desired chain_ web_push store::deletion::postgres_tests --include-ignored --test-threads=1` | 108 passed, 1 failed: `blocked_owner_submission_cannot_be_claimed` claims the next owner submission of the whole test database, and the shared development database holds 21 submissions left by earlier runs; its cause is the state of that shared database, not a table of this package; the deletion catalog and fence tests that this package had to change pass |
| `scripts/check-postgres-test-discovery.py crates/buzz-relay/src` | validated |
| `node --experimental-strip-types scripts/sponsor-calldata-vectors.mjs --check` | the vectors are what the app's encoder gives |
| `node scripts/web-push-standin.mjs --self-test` | reads RFC 8291 appendix A's message and RFC 8292's token |
| `cargo build -p buzz-relay -p buzz-cli` (from HEAD, then the loops) | built |
| `scripts/web-push-loop.sh` (a real relay on a real chain, the stand-in push service) | **28 checks passed**: the half-set relay stops and names both settings; push off has no `webPush` and answers 404; with both the public key is in `/info`; the unsigned `PUT` is 401, a subscription to the metadata address 400; the cursor starts where the chain is and the history made no alert; a planned task and a planned-and-withdrawn one made exactly ONE push, to the linked holder, decrypted as `{"v":1,"k":"planned","r":"<link>"}` with a verified token and a 32-character topic, and none to a stranger, a leaver or a holder who never linked; after "Turn off" the next task reached nobody and after keeping the device the next one did; a 403 from the service left a pending row with its status; the key is in no log line |
| `scripts/chain-loop-pot.sh` (the relay built from HEAD) | **2936 checks passed** (the same as before this package: nothing in the reader changed) |

### For the next engineer

- **Migration 0074 is applied to the development database `buzz`** (it was there, with the right checksum, after the buzz-db migration tests ran). A database migrated by the relay or `buzz-admin migrate`
  gets it by itself. The migration count assertion in buzz-db is 74; the next migration is 0075.
- **How the app registers and removes a subscription** (A4): read `/info`; if it has no `webPush`, draw no card. Otherwise `registration.pushManager.subscribe({userVisibleOnly: true,
  applicationServerKey: <the 65 bytes of webPush.publicKey>})`, then `PUT /push/web` on the community's own host with the body `JSON.stringify({endpoint, keys: {p256dh, auth}})`
  (what `sub.toJSON()` gives; other fields such as `expirationTime` are ignored) and the header `Authorization: Nostr <base64 of a kind 27235 event>` whose tags are `u` (the full address,
  `https://<host>/push/web`), `method` (`PUT`) and `payload` (the SHA-256 hex of exactly the body bytes sent). "Turn off" is `DELETE /push/web` with `{"endpoint": "..."}` signed the same
  way (method `DELETE`), then `await sub.unsubscribe()`; no body removes every device of the account. Renew (a `PUT` again) when the device's row is older than 30 days. Answers are in
  `docs/next-version/RECORD-V2.md` 12.2. Alerts reach only an account that has linked the wallet that holds Shares; say so in the card (the opt-in text is the plan's section 7.8).
- **The worker reads `{"v":1,"k":"planned"|"taken"|"ended","r":"<link ref>"}`** and nothing else (`web_push/mod.rs`, `message`; `Kind::as_str`). For the cross-language check (X3): the three words are
  `Kind::as_str`, and the sponsor's two refusal sentences are `api::sponsor::{LIMIT_EXCEEDED, NOT_ALLOWED}` with the words the app's classifier holds in `APP_WORDS` (the app's own regex is
  `looksLikePolicyDenial` in `packages/creaton-core/src/aa/zerodev.ts`).
- **The stand-in** (`scripts/web-push-standin.mjs`): `POST /_vapid {publicKey}`, `POST /_devices` (returns `{endpoint, keys}` to hand to `PUT /push/web`), `POST /_script {answers: [201, 410,
  {status: 429, retryAfter: 120}]}`, `GET /_received` (decrypted message, headers, the token's claims or why it failed), `POST /_reset`. Start the relay with `BUZZ_WEB_PUSH_EXTRA_HOSTS=127.0.0.1:<its port>`.
  `scripts/web-push-loop.sh` is a working example of the whole chain; the sender ticks every 5 seconds, so allow up to 15 seconds for a push after the reader has stored a task row (the reader stores
  rows `BUZZ_CHAIN_CONFIRMATIONS` blocks late).
- **A key for a run** is made with the one line in `docs/web-push-deployment.md`; the loop makes one and passes it in the relay's environment only.
- **Tests that link and unlink a wallet inside one second** must wait a second between the two records (a replacement signed in the same second as the record it replaces does not replace it): one run of `p8_only_a_linked_holder_is_told` did not wait and failed once.
- **The queue is one for the whole deployment**, so a test that sends must start with an empty one (`push_world` deletes the pending and sending rows of the test database).
- **Not done:** no log capture for the upstream's address; no test of the NIP-98 requirement switched off; a push to a real service is the first human test; the opt-in's words and the worker are A4's.
- **Disk:** the machine was at 3.0 GB free twice; older duplicate test executables in `target/debug/deps` were deleted (about 1.3 GB, newest of each kept).

## Step 3, review fixes (server, 20 November 2026)

Five independent reviews of step 3 (record, room, page, social, fit) were read; every finding about `crates/**`, the schema, the loop scripts and the record documents was checked against the code first.
Each fix below has a test on the production path that fails without it (the third table). The reviewers' scratch files of this side (`crates/buzz-relay/tests/review-s3-record.rs`,
`scripts/review-s3-{room,push}.sh` and their two clients) are turned into the tests named below and **deleted**; none of this side remains, tracked or untracked. No file of `contracts/pot` is touched
(`git diff 35ea0a894..HEAD -- contracts/pot` is empty), the record stays version 2 with no new field, and no migration was needed.

### Fixed

| Finding | What was wrong (checked) | The fix |
|---|---|---|
| record IMPORTANT 1 (and fit R2's start) | `explore::build` tied a project to its record through the newest 5,000 project records of the community and read only the best 500 rows before the tie; about 84 fresh keys saved 60 records a day each to push everyone out, and 500 richer projects with no record hid the honest ones. `seen` and `cut` did not say so. | `record_of_launch` finds the record **by its key** (the `chain-key` tag), one search for each candidate, newest first, pages of 100, at most 500 records of that key; the rows are read a page of 50 at a time, best first, until 20 are kept (500 rows looked at, 100 standing checks at most). `seen` is the number of projects with money that stayed (one count) and `cut` is everything not in the entries, whatever the reason. The newest-5,000 read is gone. |
| record IMPORTANT 2 | 20,001 one-wei transfers to fresh addresses tripped the 20,000-accounts cap of `held`, so a rival's `held.rank`, `held.badge`, `established.reached` and ranking columns went `null` for 30 or 91 days. | The window query (`WINDOW_SQL`, `$7`) returns only accounts that hold **now** at least `dust_floor = ceil(limits.minJoin x 1e18 / value.leaveValue)` (the fewest Shares a smallest Back buys); the same floor is in `held::lowest_above`, so the sums and the accounts cap agree. Making a window `null` by accounts now costs 20,001 smallest Backs held at the end; what still cuts is 500,000 rows from one sender (stated in RECORD-V2 11.1). The views are read before the windows are counted (`numbers::read_views`, `derive` now takes them). The last row of the query carries the rows read, so a window over the row cap is cut even when no account in it reaches the floor. |
| record IMPORTANT 3, page I8, fit R2 | An unchanged ranking index was never signed again, so on a quiet network it was older than the 24 hours after which Home hides it; a failed or empty first look waited 600 s. | `publish` signs the same entries again when the live index is 12 hours old (`RESIGN_SECS`). A look that listed nothing or failed is repeated after 60 s, then 120, 240 ... up to 600 (`explore_misses`), so the first index is not ten minutes late and the retry has a backoff and a ceiling. |
| record OPTIONAL 3 | RECORD-V2 7.1 named block 88 and a "third who backed 500 at day 90" (the example is at block 91 and the run has a late buyer at day 88). | The section now names no block or time (the file's own `asOf` says), and describes the run as the fixture plays it. |
| room B1 | A past or dust holder wrote for ever: any negative balance change, of one wei, started a new grace (`last_decrease_time`). | Only a decrease of at least `ROOM_MIN_SHARES` (the floor of step 4) starts the grace. |
| room B2 | A team member could stop the founder (or an operator, or a fellow member) writing by listing their wallet under a made-up person: the mute follows a wallet to every account that linked it. | At write time (`enforce_room_mute`, now async) every `room-mute-wallet` must be a live linked wallet of the person named, and none may be linked by the founder, an operator or the signer. At read time the founder and the operators are never muted whatever a record says. |
| room I1 | A mute signed by a team member stayed after the founder took the member off the team. | `read_mutes` reads only records signed by the founder or a member listed on the project record now; the older record of a current member decides again. |
| room C1 (optional) | Count-then-insert with no lock: 40 posts at once stored 15 against 12 an hour. | One advisory lock for one account and one room, held until the event is stored (`SeasonLock::acquire_named`, returned by `room_write::enforce` and kept by `ingest_event`). |
| room I2 | The link of an alert was searched among the newest 50 records naming the key; 55 decoys hid the real one and the alert was stored with no link, no rows and no retry. | The same paged search as the index (`record_of_launch`). An alert made while the record is not found is **kept** (its row with no link is the durable retry record) and `retry_unlinked` looks again about once a minute (the sender's tick) for each such alert less than a day old on the chain's clock, oldest first, 50 a pass; when found it gives the alert its link, audience and outbox rows in one transaction. At a day old it stays as it is (terminal: reached nobody). |
| room I3 | 120 fresh keys each stored a device: nothing tied a device to a wallet and the table had no cap. | On a server that reads the chain `PUT /push/web` refuses (403, a plain sentence) an account with no live wallet link and writes nothing; a community keeps at most 100,000 live devices (`upsert_subscription_capped`, count and insert under one lock; a renewal is never refused; 503 when full). |
| room I4 | A visitor's read of a room or a season dropped everything from signers past the 100th. | The signers of the records read are judged in **one query** (`moderation_restricted_among`, the same rule as `restriction_state`, an agent's owner included) before the one-by-one bound is used. |

### Declined, with the reason

- **record OPTIONAL 1 (Established made with nine day-old accounts).** The design (2.6) says "at least 10 different accounts hold" and records that it "can be faked"; the rule is as written. Counting only accounts that held for the whole badge window needs a new field in
  `held.badge` and a change in the app's words, which is wider than a few lines and changes the contract the app was built on. RECORD-V2 11.2 now says plainly what it costs to fake (nine smallest Backs and the fee). Open for the owner.
- **record OPTIONAL 2 (feed `joins` and `tookOut` count events).** The design gives joins and take-outs equal weight and the chain shows every event; counting accounts would change what the numbers mean and the fixture. RECORD-V2 11.3 now says "events, not accounts". The
  app's "N backed" is the other fixer's words ("N backs").
- **record OPTIONAL 4** is a statement that no leak was found; nothing to do.
- **room I5 (a sponsored Take out is limited only per address).** A per-sender cap on exits lets a stranger name a victim's address and use up their exits (the `sender` is not authenticated: step 3 plan 6, R6); a "holds Shares" check would read the chain reader's rows, which
  lag a fresh Back by its confirmations, and would refuse a real person their exit; a server-wide cap lets one abuser stop everyone. Rotating addresses spends the operator's own upstream cap, which the deployment document names as the last backstop; it now also says the shared-address case.
- **room: `next_cursor` skips the unread rows of one block that holds more than 200 task rows.** Not a few lines (a second read of that one block and a test with 250 rows); only task announcements, takes and resolutions of this reader count, and the alert is a convenience beside the in-app alert. Open.
- **room: a device kept by two accounts on one browser; a quote or an `E`-tag reply is not a room event; `FOR UPDATE SKIP LOCKED` has no test.** The first is handled in the app; the second never shows in a room (a room is read by its own tags, and a NIP-22 `E` tag does not match the app's `#e`
  filter); the third is not a finding against behaviour.
- **fit: an upper-case hex `e` tag naming a room post "may skip the room rule".** Checked: it is counted as a bad tag and then, with no room tag, the event is not a room event. It cannot appear in a room (the app and `/query` match `#e` exactly and the room is read by its tags), so nothing is
  shown or hidden wrongly.
- **page I7 (the share link's preview carries the founder's words, while the app says it shows no amounts).** The preview is the founder's name and pitch by the plan's choice (7.2); the sentence is the app's, and the other fixer changes it.
- **social, page and fit findings about the app** belong to the other fixer.
- **fit R6 (the phone path of the room is not proven through a real relay with `smartAccountLinks` on)** needs the first human test with a passkey; not run here.

### Still open

- `held` is cut by 500,000 rows from one sender (about 250,000 transfers); stated in RECORD-V2 11.1.
- The index finds a record among at most 500 that name the same key; an attacker who signs more than that under one project's key hides that project from the ranking and from alerts' links until the founder saves the record again (a saved record is the newest). Both say so by `cut` / by an alert with no link.
- Established can still be made with nine smallest Backs (declined above).
- `next_cursor` (above).

### Guards switched off once (U5), and what failed

Eighteen edits were made to the code in three builds and every named test failed; the files were then restored byte for byte (`git diff` shows only the fixes).

| Guard switched off | Failed |
|---|---|
| the floor of a decrease (`delta < 0`) | `b1_a_move_below_the_floor_does_not_renew_the_grace_of_a_past_holder` |
| the wallets of a mute must be the person's / not the founder's, an operator's, the signer's | `b2_a_mute_may_list_only_wallets_the_person_linked_and_never_the_founders_or_an_operators` |
| the founder and operators are never muted (read time) | `b2_the_founder_and_an_operator_are_never_stopped_even_by_an_older_record_that_names_their_wallet` |
| only the team's own signers' mutes are read | `i1_a_mute_ends_with_its_signers_place_on_the_team` |
| the lock on one account's count (made unique per event) | `c1_posts_sent_at_once_by_one_account_stay_inside_the_hourly_cap` |
| the floor passed to the held windows (0) | `a_crowd_of_one_wei_transfers_leaves_a_signed_record_its_held_figures` |
| the floor in the window query's `HAVING` | `h11_accounts_below_the_floor_do_not_cut_a_window` |
| the search of records by key in pages (one page) and the pages of rows (one page) | `the_index_finds_a_record_among_many_and_a_project_among_richer_ones_with_no_record` |
| the same entries signed again at 12 hours | `ix2_and_ix3_the_index_lists_tied_projects_and_is_signed_only_when_it_changes` (at the re-sign assertion) |
| the shorter wait after a look that listed nothing | the same test, at "a failed look is repeated soon: 600" |
| the retry of alerts with no link | `i2_an_alert_with_no_link_is_kept_and_linked_when_the_record_is_found_for_a_day` |
| the paged search for an alert's link | `i2_a_crowd_of_records_naming_the_key_does_not_hide_the_projects_link` |
| the cap of devices in a community | `i3_a_community_keeps_at_most_its_cap_of_live_devices` |
| the link requirement of `PUT /push/web` | `i3_on_a_server_that_reads_the_chain_only_an_account_with_a_linked_wallet_keeps_a_device` |
| the one-query judgement of signers (prefetch) | `i4_a_room_with_more_signers_than_the_bound_is_read_whole_and_a_muted_signer_is_left_out` |

The first build's constant-only change of `RESIGN_SECS` did not fail the test (the test used the constant itself); a compile-time assertion that it is at most 12 hours now stands in the test.

### What ran

| Command | Result |
|---|---|
| `cargo fmt --check` | clean |
| `cargo clippy -p buzz-relay --lib --tests -- -D warnings`, `cargo clippy -p buzz-db --lib -- -D warnings` | clean |
| `cargo test -p buzz-relay --lib -- chain_reader handlers::room_write handlers::wallet_binding handlers::season_rules handlers::room_removal handlers::launch_update_authority handlers::ingest web_push api::web_push api::sponsor public_read --include-ignored --test-threads=1` | **618 passed, 0 failed** (the `chain_reader` part alone was 163 passed, 1 failed at the first run: the index test's `seen`/`cut` and its retry wait, which these fixes change on purpose, and that test was updated) |
| `task_chain` three times in a row | 29 passed, 0 failed, three times |
| `config::` three times in a row | 106 passed, 0 failed, three times |
| `manager::` (without `planted_eval_against_a_real_model`) | 34 passed, 0 failed |
| `cargo test -p buzz-db --lib -- migration chain_ desired --include-ignored --test-threads=1` | 59 passed, 0 failed |
| `cargo test -p buzz-core`, `-p buzz-cli` | not run: nothing of them changed |
| `node scripts/chain-reader-events.mjs --check` | the tables match the contracts build |
| `python3 -I scripts/chain-reader-fixture.py --check` (twice) | "is what a fresh run gives", both times |
| `python3 -I scripts/chain-reader-example-check.py` | all 416 checks passed (222 recomputed from the raw logs); the example is byte for byte what the server writes |
| `git diff 35ea0a894..HEAD -- contracts/pot` | empty |
| `cargo build -p buzz-relay` | built |
| `scripts/chain-loop-pot.sh` | **2936 checks passed** |
| `scripts/room-loop.sh` | 55 checks passed |
| `scripts/web-push-loop.sh` | 28 checks passed (its client and its two counts changed: the unlinked holder and the stranger now get a 403 and keep no device, so the relay keeps two devices, not four) |

### For the next engineer (the app)

- **`PUT /push/web` now answers 403 to an account with no live wallet link** (on a server that reads the chain) with `Alerts are for people who back a project. Back one and confirm your account there, then turn alerts on.`, and 503 `This server cannot keep more devices for alerts now. Try again later.` when
  the community is full. The app's opt-in must say the first in its own plain words (the card should be drawn only for an account that has linked a wallet, or the answer shown as a sentence); `app/src/features/alerts/push/` reads the answer.
- `explore` entries and the signed index are as before; only `seen` and `cut` mean more (all projects with money that stayed, and all that are not in the entries).
- A mute may list only wallets the person linked themselves; the app's "stop" press already reads the person's own `kind 37017` records. A record that lists anyone else's wallet is now refused with `a room mute may list only wallets the person has linked to their own account`
  or `the founder and the people who run this server cannot be stopped from writing`; show them plainly.
- `feed.hours[].joins` and `tookOut` are events, not accounts (said in RECORD-V2 11.3).
- Disk: the machine stayed above 3.5 GB free; the test executable of the previous build (about 400 MB) was removed before each rebuild. No anvil, relay, stand-in or scratch database is left; Postgres and Redis are left running.

## Follow-up round (server, 20 November 2026)

A short round on the two verifiers' "important" findings of step 3. Nothing new was added; only the two points below were touched.

### Closed

- **S1, the season record's signer filter had no test.** `read_season` keeps only the records signed by a current operator, and no test failed
  when that filter was dropped. New test `season_rules_postgres_tests::m1b_a_season_reads_only_from_a_current_operators_record` (Postgres, through the
  real `ingest_event` and the real `read_season` / `enforce_step`): an operator signs season 1, the season reads; the same server with an operator list
  that no longer holds the signer reads it as missing, and an entry into it is refused as for a season that does not exist; the new operator's own
  record for the same number then wins although the former operator's record is newer. Run with the filter switched off
  (`.filter(|_stored| true)`) it **failed**; the file was restored byte for byte and it passes. The entry, leave and removal records are **not**
  filtered by signer on the read path (`read_rows` keeps every record of the season); who may sign them is judged once, at write time, so a removal
  an operator signed stays a removal after that operator leaves the list. That is the design, so there is no second filter to test.
- **S2, `next_cursor` stepped over task rows of one block holding more than 200.** A caller could lose rows for good: with 201 rows read from one block,
  the cursor could not name a place inside the block, so it went to the next block and the rows after the 200th of that block never made an alert
  (the second pass, starting at that block, hit the same cut and stepped over it). The fix is contained, in `web_push/alerts.rs` only, with no change to
  the table or to any generated file: when the first unread row is in the same block as the first row (`oversized_block`), that block is read whole,
  alone (up to `BLOCK_ROWS_MAX` = 10,000 rows, a ceiling far above what one block's gas allows; a block above it logs a warning), and the cursor goes
  past it. Any other cut is as before (the cursor goes to the first block not fully read, and a block read twice is absorbed by the unique key).
  Tests: pure `a_batch_that_one_block_fills_is_read_whole_and_no_other_is`; Postgres `a_block_with_more_task_rows_than_a_batch_makes_every_alert` (100
  rows, a block of 250, then 5: 355 alerts) and `a_cursor_on_a_block_of_more_than_a_batch_reads_all_of_it` (one block of 250: 250 alerts, the cursor past
  it). With `oversized_block` made to answer `None` all three **failed**; restored, they pass.

### Still open

- Everything listed under "Still open" in the review-fixes section above, except `next_cursor`, which is closed here.
- The alert reads at most `BLOCK_ROWS_MAX` rows of one block; the rest of such a block would make no alert (it logs a warning). A block cannot hold that
  many task events within its gas, so this is a ceiling, not a limit anyone can reach.

### What ran

| Command | Result |
|---|---|
| `cargo fmt --check` | clean |
| `cargo clippy -p buzz-relay --lib --tests -- -D warnings` | clean |
| `cargo test -p buzz-relay --lib -- handlers::season_rules --include-ignored --test-threads=1` | 13 passed, 0 failed |
| `cargo test -p buzz-relay --lib -- chain_reader --include-ignored --test-threads=1` | 164 passed, 0 failed |
| `cargo test -p buzz-relay --lib -- task_chain --include-ignored --test-threads=1` | 29 passed, 0 failed |
| `cargo test -p buzz-relay --lib -- web_push --include-ignored --test-threads=1` | 61 passed, 0 failed |
| `node scripts/chain-reader-events.mjs --check` | the four generated files match the contracts build |
| `python3 -I scripts/chain-reader-fixture.py --check` | "is what a fresh run gives" |
| `python3 -I scripts/chain-reader-example-check.py` | all 416 checks passed |

## Launch round: the helper's three more calls (21 November 2026)

The server's helper sent two calls (`Treasury.collectFees()`, `Treasury.settle()`). Three more calls that anyone may make were pressed by no
one unless a person did. They are now sent by the helper, and `Treasury.windDown()` is, on purpose, not.

### What the helper sends now

| Call | Stored name | When it is built (`helper/plan.rs`, from final rows) | Checked again at the head (`helper/mod.rs::check`) | One job per |
|---|---|---|---|---|
| `Treasury.applyRate()` | `treasury.applyRate` | a raise is pending (`RateProposed`, no `RateSet` since), the project is not wound down, and `applicableAt` plus ten minutes has passed | `windDownKind() == 0`, `pendingAt() != 0`, head time at least `pendingAt() + unit() + 600` | proposal (key names the second it became applicable) |
| `Vester.execute(id)` | `vester.execute` | a grant is announced to burn (`ForfeitAnnounced`, no `Forfeited` since) and `burnAt` plus ten minutes has passed | `grantOf(id)`: state is announced and head time at least `burnAt + 600` | grant |
| `Vester.burnAfterWindDown(id)` | `vester.burnAfterWindDown` | the project is wound down, `windDownAt + unit + 600` has passed, and the grant is still live and not protected | `grantOf(id)`: live and not protected; the Treasury (read from the Vester's `treasury()`): `windDownKind() != 0` and head time at least `windDownAt() + unit() + 600` | grant |

The ten minutes (`calls::NOTICE_GRACE_SECS`) are the same grace the task settle already has: whoever is there has had that time to press it
themselves. Each call is also asked of the node with `eth_call` and `eth_estimateGas` from the helper's address before it is sent, as the first two
are; a revert that means "someone did it first" (`AlreadyWoundDown()` or `BadInput()` for the rate, `WrongState()` for the burns, `ProtectedGrant()`)
drops the job without counting an attempt. The three are the last in a pass (after the settle and the fee), so they never hold back the first two.

### The bounds (a stranger cannot make the helper pay for failing transactions)

Anyone can open a project and announce grants, so these three are held to a tighter rule than the first two, in addition to the daily gas and spend
caps (the calls' half of the day) that all calls share:

- **3 failed attempts** and the job ends `failed` for good (`calls::MAX_OPTIONAL_ATTEMPTS`; the first two calls keep the configured 8). The pause
  between attempts doubles from a minute as before; a failure is recorded in `chain_helper_jobs.last_error`, the metric
  `buzz_chain_helper_failed_total{call}` and the log line, where the first two record theirs.
- **3 jobs of these kinds looked at per pass** (`OPTIONAL_PER_PASS`); the rest stay pending for the next pass, with no attempt counted.
- **8 transactions per project in 24 hours** (`OPTIONAL_PER_PROJECT_PER_DAY`, counted from `chain_helper_sends`, a replacement at the same nonce
  counting once, a reverted one counting). A project that has had them is put off for an hour without using one of the pass's places and without an
  attempt.
- **16 jobs per project per kind** are built in one build (`MAX_GRANT_JOBS_PER_PROJECT`), the earliest first.

### What is not sent, on purpose

- **`Treasury.windDown()` after 26 quiet units is not sent.** `docs/next-version/JOIN-LEAVE-DESIGN.md` says "any holder can announce a wind-down" at 182 days
  quiet (line 353) and `windDown()` is "anyone after 26N quiet" (line 634); it never says the server does it, and ending a project is not a routine. It stays in
  the forbidden list of `calls_tests.rs`, and the database does not allow a stored `treasury.windDown`. The app already offers that press to anyone
  who is not the project's runner or Pair once the quiet time has passed: `app/src/features/seat/SeatSection.tsx` (`canQuietWindDown`, the
  `seat-quiet` block, lines 120 and 206), opening `app/src/features/seat/WindDownSheet.tsx`, whose "quiet" mode sends `Treasury.windDown()` from
  the person's own wallet (`treasuryWindDownCall`).
- `Vester.burnUngrantedAfterWindDown()` (the Team Shares nobody was granted, after a wind-down and a unit) is not in this round either; it is
  another call anyone may make, was not asked for, and stays forbidden to the helper.
- The app still has its own press for the rate (`app/src/features/pot/AllowanceSheets.tsx`, `applyRateCall`); the helper only does it when nobody has.

### Chosen under the owner's standing go; the owner may overrule

1. **Migration 0075, with the desired-state schema file.** The stored call names are closed by a database list, so the three names needed a
   migration (`migrations/0075_chain_helper_more_calls.sql`) and the same line in `schema/tables/public/chain_helper_jobs.sql`; the buzz-db
   migration test count is 75 and its 0070 test now also checks the three names are accepted and `treasury.windDown` is refused. These are outside
   `crates/`; the number 0075 was the next free one when taken, and another engineer who adds a migration meanwhile will have to renumber one.
2. **Grace of ten minutes for all three** (the same as the task settle), not none: the runner or a holder who is there presses it first.
3. **The three burns and the rate are built for a wound-down project only where the contracts allow it**: no rate after a wind-down; `execute` for
   an announced grant at any time; the after-wind-down burn only for live, unprotected grants (a grant announced before the wind-down is burned by
   its own `execute`). A grant the wind-down left nothing to burn from is still sent once (the call then closes the grant); the cost is one
   transaction, bounded as above.
4. **Numbers**: 3 attempts, 3 per pass, 8 per project per day, 16 jobs per project per kind. They are constants in `calls.rs` and `plan.rs`, not
   settings (a setting that raised them would be the thing a stranger wants).
5. **`scripts/chain-loop-pot.sh` is not edited** (not this package's). See below.

### What ran

| Command | Result |
|---|---|
| `cargo fmt --check` | clean |
| `cargo clippy -p buzz-relay --lib --tests -- -D warnings` | clean |
| `cargo test -p buzz-relay --lib chain_reader -- --include-ignored --test-threads=1` (a scratch database migrated through 0075) | 181 passed, 0 failed (the earlier run of the same command in the section above: 164) |
| `cargo test -p buzz-db --lib -- chain_team embedded_migrator desired schema_matches chain_helper --include-ignored --test-threads=1` | 17 passed, 0 failed |
| `scripts/chain-loop-pot.sh`, unchanged | **fails at its last helper check**: "helper jobs of any other call: got 1, expected 0". That one job is the `treasury.applyRate` for the rate the loop proposes early (1500) and never applies by hand, which the helper now applies a week and ten minutes later. Every check before it passed (2,934). |
| the same script with three lines changed in a copy outside the repository (`'treasury.applyRate'` added to the two allowed-call lists, `applyRate()` added to the selectors it accepts, and five new checks: one done `treasury.applyRate` job, sent from the helper's address, one `RateSet` raised, rate 1500, nothing pending) | **2,937 checks passed**; the helper sent 4 transactions in the whole run (the fee, a settle of outside money, the settle of the task that ran out, the rate), nobody pressing |

The three edits the script itself needs (lines 255 and 504 and 507 of `scripts/chain-loop-pot.sh`): add `'treasury.applyRate'` to the two `call not in (...)` lists,
and `$(cast sig 'applyRate()')` to `SIGS`; and its closing `ok` line says "every one a settle or a fee collection".

### Guards switched off once, each by one test

Each was run with the whole `chain_reader::helper` suite (database tests included); the named test failed and nothing else did.

| Guard switched off | Failing test |
|---|---|
| the ten minutes before applying a rate (planner) | `plan::tests::a_proposed_rate_is_applied_ten_minutes_after_its_wait_and_once` |
| no rate for a wound-down project (planner) | `plan::tests::a_rate_waiting_in_a_wound_down_project_is_not_applied` |
| the ten minutes before an announced burn (planner) | `plan::tests::an_announced_burn_is_executed_ten_minutes_after_its_notice_and_once` |
| protected grants left out of the burn after a wind-down (planner) | `plan::tests::a_grant_that_is_protected_announced_or_in_a_live_project_gets_no_burn_job` |
| 16 jobs per project per kind | `plan::tests::one_project_gets_a_bounded_number_of_grant_jobs_earliest_first` |
| the unit after the wind-down (planner) | `plan::tests::after_a_wind_down_and_a_unit_each_live_grant_gets_one_burn_job` |
| the head check "not wound down" (rate) | `optional_postgres_tests::a_call_is_not_sent_when_the_chain_no_longer_wants_it` |
| the head check "announced" (execute) | the same test |
| the head check "not protected" (burn after a wind-down) | the same test |
| the ten minutes at the head (rate) | `optional_postgres_tests::each_optional_call_is_left_alone_a_second_before_its_time` |
| 3 attempts instead of the configured 8 | `an_optional_call_that_keeps_reverting_ends_failed_after_three_attempts` and `an_optional_call_whose_transaction_keeps_reverting_is_sent_three_times_at_most` |
| 3 jobs per pass | `optional_postgres_tests::a_pass_sends_at_most_three_optional_calls` |
| 8 per project per day | `optional_postgres_tests::one_project_gets_at_most_eight_optional_calls_a_day` |
| "someone did it first" dropped, not failed (execute) | `optional_postgres_tests::a_call_someone_else_made_first_is_dropped_not_failed` |

The run-through of the three in the Postgres tests uses a fake node, a real database and the real pass: sent when due (the exact target and calldata),
not sent a second before, not sent when the chain says otherwise (eight changes), dropped when someone was first, not repeated when it keeps
reverting (never sent, failed on the third attempt) or when its transaction keeps reverting (sent three times, then failed), and the fee and the
settle are not held to the bounds. The planner is tested on the real run (`testdata/pot-run.json`: project A's pending rate, announced burn and
wind-down; project B's), and on grants made up for the cases the run has none of.
