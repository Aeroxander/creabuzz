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
| `python3 -I scripts/chain-reader-fixture.py --check` | a second run of the real chain gives the same bytes |
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

Pass A's seven choices stand (Team Shares' balances share the balance tables under a derived key; the Team token is stored with role
`shares` in `chain_contracts`; the dollar is not followed; ledger `lastSettle` not later than the view; Pair events followed; no
migration). Pass B's:

1. **Helper stored names.** The database's closed list of helper call names (`chain_helper_jobs.call`, migration 0066) allows
   `treasury.sweepFees` and `treasury.release` among the old ones, and a migration is outside this track. The two calls keep those
   names and now mean `collectFees()` and `settle()` (said in `helper/calls.rs`). The other calls anyone may make (`applyRate()`,
   `Vester.execute(id)`, `Vester.burnAfterWindDown(id)`, `Treasury.windDown()` after 26 quiet units) are **not built**: they need names
   the list does not allow. `Vester.claim` is left out on purpose (the lead said the helper never claims). The helper never checks in:
   it could not before either.
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
6. **`BUZZ_CHAIN_REFRESH_SECS` may be as low as 5** (was 60), so the loop can show the cadence; the defaults are 3600 and 600.
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

- **A migration** that would (a) let the other four calls anyone may make be stored by the helper
  (`ALTER TABLE chain_helper_jobs DROP CONSTRAINT chain_helper_jobs_call_check;` then a `CHECK (call IN ('treasury.sweepFees',
  'treasury.release', 'treasury.applyRate', 'vester.execute', 'vester.burnAfterWindDown', 'treasury.windDown'))`), (b) add `'team'` to
  `chain_contracts.role`'s check and a token column to `chain_balances` (removing pass A's two workarounds). `crates/buzz-db` asserts the
  number of migrations (69), so it changes with it. Outside this track's folders.
- The helper's old Postgres suites (caps, backoff, receipts, never failing a pass) are not rewritten; the pure tests of its call list and
  planner are. The loop exercises the live helper end to end (one real call).
- No test builds a record with more than 200 holders or grants (the cuts and `truncated` follow the spec's caps by construction).
- The earlier-backers block is parked: version 2 has none.
- The record has no tasks, notice, take or notes: step 2.

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
