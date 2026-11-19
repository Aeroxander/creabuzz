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
   and the batch halving are gone. It sends two calls anyone may make on a project's Treasury: `collectFees()` (the platform's fee
   goes to the platform) and `settle()` (once outside money has all arrived and is still stored as arriving). It never checks in,
   takes out, refunds, draws or claims for anyone. The planner (`plan.rs`) builds a weekly fee job when fees are owed and a settle
   job when arrived money waits.
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
- **The helper's rule**: `helper::calls::tests` lists 35 calls the helper must never be able to send (check-in, take-out, join, draw,
  claim, grant, forfeits, rate, door, agents, seat, wind-down, the Pair's and the admin's calls, token moves) and fails if any is in the
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
   `treasury.settle`.)* The other calls anyone may make (`applyRate()`, `Vester.execute(id)`, `Vester.burnAfterWindDown(id)`,
   `Treasury.windDown()` after 26 quiet units) are **not built**: they are a decision for the owner, not a database limit any more.
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
   ceiling is now 86400 (was 7 days), see below.
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

### 2. The refresh settings end at 86400 seconds

`BUZZ_CHAIN_REFRESH_SECS` and `BUZZ_CHAIN_ACTIVE_REFRESH_SECS` accepted 5 to 604800; the app accepts `refreshEverySecs` up to 86400
and refuses a longer promise, so a server set to 2 days would sign records the app throws away. Both now take 5 to 86400
(`settings.rs`: `MIN_REFRESH_SECS`, `MAX_REFRESH_SECS`). `config::tests::the_chain_refresh_settings_end_at_one_day`: 5 and 86400 are
accepted for each; 4, 86401 and 604800 (the old ceiling) are refused naming the setting and "5 to 86400". It fails with the old
ceiling put back. `RECORD-V2.md` section 6 says so.

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
- **Helper names.** `chain_helper_jobs.call` allows `treasury.collectFees` and `treasury.settle`; the helper writes only those. Rows of
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
- **Spec:** `RECORD-V2.md` sections 2.9 and 2.10 say the cut is deterministic and how.
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
4. **Refresh floor stays 5 seconds**, ceiling 86400 (the app's range).
5. **The other four calls anyone may make** (`applyRate()`, `Vester.execute`, `Vester.burnAfterWindDown`, `Treasury.windDown()`) are
   still not built: with the database list no longer in the way, adding them is a product decision (who pays for gas for what).

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
