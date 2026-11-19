# Chain reader, pass A: the reader decodes contracts/pot

Branch `v6`, 19 November 2026. Builder A of the server track. Spec: `docs/next-version/RECORD-V2.md`; contracts:
`contracts/pot` (not edited). This pass moves the reader (`crates/buzz-relay/src/chain_reader`) from the old
`contracts/next` events to the `contracts/pot` events, rebuilds each project's state from its logs, and leaves the record,
the publish path, the helper's calls and the manager's keys to builder B (list at the end). Nothing is pushed. Commits: `89b351def` (the fixture and its script), `f74f99e34` (the reader), and the commit that adds this report. This is not
legal or tax advice, and no figure here is a promise of any result for anyone.

## What is built

| Part | Where | What |
|---|---|---|
| Event table, generated | `scripts/chain-reader-events.mjs`, `chain_reader/events_table.rs`, `chain_reader/testdata/pot-events.json` | The script reads the compiled ABIs of Launcher, Treasury, Vester, Pair, ShareToken and PlayDollar from `contracts/pot/out`, takes each topic from `forge inspect <contract> events --json` (forge's own number), and writes (a) the JSON record of every event and (b) the Rust table `EVENTS` (rustfmt'd). `--check` rebuilds both and fails if either file differs. Nothing in the table is typed by hand. 35 (role, event) pairs. |
| Roles | `chain_reader/events.rs` | `launcher, shares, team, treasury, vester, pair, dollar`. The Team token is a new role (`Role::Team`). Decoding is by (role, topic): the Launcher and the Treasury both have a `WoundDown`; the two tokens and the dollar share one `Transfer` topic. The dollar is in the table so its events decode, but the reader does not follow it (one `Transfer` per dollar move on the chain, and the record reads `held` from the chain). |
| `ProjectLaunched` redecoded | `scan.rs` | `Project{founder,shares,team,treasury,vester,launchedAt}`, `Terms{ratePpm,teamPool}`, `Platform{quote,platform,feeBps,unit,agentUsd}`. Discovery follows shares, team, treasury, vester at launch and a Pair at `PairMade`, from the block they are named in (their own logs in that block, the Team pool minted to the Vester, come before the Launcher's event and are still read). |
| The ledger | `chain_reader/ledger.rs` | A project rebuilt from its events alone, following `contracts/pot/test/EventsRebuild.t.sol`: pot, paid-in, Shares (B), Team Shares (G), burn queue (Z), box, arriving money and its end, active seconds, last settle, fees owed, rate, a rate raise waiting, door switch, last check-in and its record hash, wind-down, runner, first Pair, agents seen, every grant (state, granted, kept, claimed, start, burn, burn time, by member), totals (joined, fees, took out, drawn, outside), time of the first join, every draw with its time, and per-account balances of both tokens (holders). `Ledger::mismatches(&Stored)` is the section 4.3 cross-check against the contracts' own views. |
| Store | `store.rs` | Running balances for both tokens; the project's logs without either token's `Transfer`s; `balances(pool, reader, key, Role, block)`. |
| Fixture, regenerable | `scripts/chain-reader-fixture.py`, `chain_reader/testdata/pot-run.json` | A real run (anvil, the deploy script, `cast`), two projects, 86 blocks, 163 logs, the stored numbers the views gave after every block that changed a project, and the views at the end. Deterministic: a second run gives the same bytes (`--check`). |

Removed with their tests (they stay in git history): the Rounds, Finisher, receipts, bids, sale, pool, earlier-backers and
refund-formula arms of `events`, `scan` (pool trades, the Launcher's fixed contracts, sale auctions, project zero's claim),
`store` (pool ids, pool start, council and pair runners), `numbers` (all of it: `numbers_earlier`, `numbers_market`,
`numbers_tests`), the job planner of the helper (`plan.rs` now plans nothing), and the old Postgres suites
(`postgres_tests`, `hardening_postgres_tests`, `review_postgres_tests`, `review_m5p2_postgres_tests`, the helper's
`helper_postgres_tests` and `review_m5p2_tests`, `plan_tests`), which drove the old contracts through a hand-made fake chain.
`testdata/next-events.json` and `anvil_logs.json` are gone.

Kept as they were: the scan loop, range halving, reorg walk and rollback, the generation fence, the writer lock, signing,
the supervisor.

## The run behind the fixture

Project A, 115 days: launch, a founder grant, a join in one transaction (`transferAndCall`) and in two (`approve`, `join`), a
take-out, weekly check-ins, draws, outside money arriving and released, a rate raise proposed and applied, a lowered rate,
the door switched off and on, an agent set twice and revoked, a member's own exit announced and burned, a Team Share claim
and a Team take-out, fees collected, a seat offered, withdrawn, offered again and taken, a wind-down by choice, and the
burns after it (a grant and the ungranted rest). Project B: launched by another founder, takes the seat through a Pair
(`makePair`), one backer, a call executed by both signers, a call cancelled, a grant, a forfeit announced by the Pair (so
`byMember` is false), a wind-down through the Launcher (`Launcher.WoundDown` and `Treasury.WoundDown`). Last, the platform
settings are set and the admin seat offered and taken. Every event the table names appears in the run (a test fails if one
does not).

Regenerate: `python3 -I scripts/chain-reader-fixture.py` (needs `anvil`, `cast`, `forge` and a `contracts/pot` build);
`--check` plays it again and fails if the file differs. The event table: `node scripts/chain-reader-events.mjs [--check]`.

## Tests

`cargo test -p buzz-relay --lib chain_reader`: see "Results" below. Each of the lead's tests, and where it is:

| Required | Test |
|---|---|
| Every event decodes from the real fixture | `ledger::tests::every_event_decodes_from_the_real_run` (every table entry is emitted by the run, every log of the run's contracts decodes, the only logs the table does not name are `Approval`s) |
| A replay rebuilds exactly what the views gave | `a_replay_of_the_logs_gives_the_numbers_the_views_gave_at_every_step` (every snapshot, both projects: pot, paid-in, box, arriving, arrival end, fees, Z, active seconds, B, G, rate, pending rate, last check-in, door, wind-down, runner, grant count, committed) and `the_end_of_the_run_matches_the_contracts` (adds both tokens' balances account by account, every grant, the agents, totals) and the same through the real reader on Postgres (`the_reader_finds_the_projects_and_rebuilds_the_numbers_the_views_gave`) |
| A log delivered twice changes nothing | `ledger::tests::a_log_delivered_twice_changes_nothing`; on Postgres `scan_postgres_tests::a_log_delivered_twice_changes_nothing` (a node answers every request twice: same rows, same numbers) |
| A reorg that drops a Joined rolls the numbers back | `ledger::tests::a_dropped_join_rolls_the_numbers_back`; on Postgres `scan_postgres_tests::a_reorg_that_drops_a_joined_rolls_the_numbers_back` (a longer fork, empty blocks, the real rollback: rows, both tokens' running balances and the ledger return to what the views gave before that join) |
| An event from a contract that is not the project's is ignored | `ledger::tests::an_event_from_a_contract_that_is_not_the_projects_is_ignored` (a stranger, another project's Treasury, the project's own Vester posing as its Treasury); on Postgres `an_event_from_a_contract_that_is_not_the_projects_is_ignored` (a node that ignores the address filter and returns a stranger's `Joined` and look-alike `ProjectLaunched` and the dollar's transfers: none is stored, nothing is followed) |
| Table equals forge | `events::tests::the_table_is_the_forge_build` (every recorded event, its parameters one by one, the topic recomputed from the signature against forge's), `topics_are_pinned_from_forge` |

The four Postgres tests are `#[ignore]` like the old ones (they need the migrated database and Redis); run with
`cargo test -p buzz-relay --lib chain_reader -- --include-ignored --test-threads=1`.

## Chosen under the owner's standing go; the owner may overrule

1. **The Team token's balances share the existing `chain_balances` tables, under a derived key**: backer Shares under the
   project's key, Team Shares under `keccak256("team-shares" || key)`. The tables have no token column and a migration
   is outside this track (and `crates/buzz-db` asserts the number of migrations). `store::balance_key` is the one place.
2. **The Team token is kept in `chain_contracts` as role `shares`**, because that table's role list is closed by a database
   constraint (migrations 0065, 0066) with no `team`. `store::contracts` tells the Team token by the project's own
   `ProjectLaunched.project.team`. Logs keep the real role (`team`); that column has no constraint. A migration widening the
   constraint (and adding a token column) would make both workarounds unnecessary; it needs the buzz-db migration-count test
   changed too.
3. **The dollar is not followed** (see the table above).
4. **The ledger's `last_settle` is the time of the last `Settled` event, and the cross-check demands only that it is not
   later than `lastSettle()`.** See the contract finding below.
5. **Pair events are followed and stored** (as before), though the record does not read them.
6. **The old helper job machinery stays, its planner plans nothing**, so no old call can be created; the old call variants and
   their `check` arms are still in `helper/calls.rs` and `helper/mod.rs` for builder B to replace.
7. **`numbers::derive` answers `None`** for now: until builder B fills it the reader signs no record (a removal record, for
   a launch that left the chain, is already version 2 and exactly the spec's form).

## A finding in contracts/pot (not worked around silently)

`Treasury._settle()` always sets `lastSettle = block.timestamp` but emits `Settled` only when something moved
(`dt`, `toBox`, `back` or `released` non-zero). A settle that moves nothing (a bare `settle()` on a quiet or wound-down
project, a check-in after a long quiet) leaves no log, so **`lastSettle` cannot be rebuilt from events** and the spec's
section 4.3 cross-check "ledger `lastSettle` equals the view" cannot hold exactly. The numbers are safe (a silent settle
changes none of pot, box, arriving, active seconds), and the record's roll-forward reads `lastSettle()` as a view, so only
the cross-check is weaker: ledger time `<=` view time. In the fixture the end-of-run view is 1805456264 and the last
`Settled` is 1804764200. Fix, if wanted, in the contract: emit `Settled` on every settle, or carry the time in the events
that settle. I did not change `contracts/pot/src`.

Two smaller notes: (a) `Joined.who` is the payer; holders are built from `Transfer`s as the spec says. (b) A forfeit
announced by the runner is possible only through a Pair (`Treasury.announceForfeit` demands both signers), so a
`byMember: false` forfeit appears only for a Pair-run project; the fixture has one in project B.

## What builder B must fill

1. **The record** (`numbers::derive(key, &Ledger, &AsOf)` in `numbers.rs`; today `None`). The ledger gives: identity and
   contracts, `launchedAt`, `team.pool` (`team_pool`), the first Pair (`pair`), pot/box/arriving/active **as of the last
   settle**, paid-in, B, G, Z, fees owed, rate and pending rate (`ppm`, `applicable_at`, `proposed_at`), door switch,
   `last_check_in` and `last_record_hash`, `wind_down`, `runner`, `agents` (addresses and what the last `AgentSet` said;
   whether an agent is live is a view: `agents(a).active` with `agentEpochOf(a) == agentEpoch()`), `grants` (every field
   of section 2.9 that is not a view or time arithmetic), `totals`, `first_backed_at`, `draws` (for `drawnLastDay`),
   `holders(&exclude)` (sorted, the zero address, Treasury, Vester, tokens and dollar already left out; pass the Pair
   and the Launcher to leave them out too), `committed()`, and `shares_in_hands()`. Still to do: the RPC batch of views at
   `asOf.block` (`ChainSource::eth_call` already takes a block), the section 3 roll-forward (it needs `lastSettle()`,
   `activeEnd()`, `arrivalEnd()` from views), `Stored` for `Ledger::mismatches`, the section 4.3 rule that a
   failed check publishes nothing, `playMoney`, `limits`, `quiet`, `value`, `builtAt`, `refreshEverySecs`, the totals
   identity check.
2. **The publish path** (`mod.rs::publish_project`, `numbers::facts_of` and `without_as_of`): `publish_project` builds the
   ledger (`Ledger::from_logs`, then `set_balances` from `store::balances` for `Role::Shares` and `Role::Team`) and calls
   `derive`; `facts_of` still strips only `asOf` and must also strip `builtAt` and the time-moving fields to decide
   whether anything changed; cadence 600 s / 3600 s (`refresh_secs` config today is one number).
3. **The helper** (`helper/`). `plan()` plans nothing. The `HelperCall` variants (rounds, finisher, holder, earlier,
   `treasury.sweepFees`, `treasury.release`, `vester.claim(address)`) and the `check` arms in `helper/mod.rs` are
   the old contracts' and must be replaced by the calls anyone may make on contracts/pot (`settle()`,
   `collectFees()`, `applyRate()`, `Vester.execute(id)`, `Vester.burnAfterWindDown(id)`, `Vester.claim(id)`,
   `Treasury.windDown()` after 26 quiet units). **The call name is closed by a database constraint**
   (`chain_helper_jobs.call`, migration 0066, old names only): new names need a migration, and `crates/buzz-db` asserts
   the number of migrations. The old helper test suites were deleted with the old contracts (`helper_postgres_tests`,
   `review_m5p2_tests`: caps, backoff, receipts, batch halving, the helper never failing a pass); rewrite them for the new
   calls (they are in git history at commit `d5bf58129` and before).
4. **The manager keys** (`api/manager/cost.rs`, outside this track's folders in the sense that it is the manager's code; B
   owns it per the lead). The tables to read: `chain_logs` with `role='treasury'`, `event='Joined'`, `decoded->>'paid'`,
   `decoded->>'fee'`, the block time from `chain_blocks`. The platform fees are the sum of `fee` over the window
   (`platform_fees` today sums `rounds`, `holder`, `finisher` and `HandedBack` events, which no longer exist); "the first
   round closed with money" (`first_round_closed`) becomes "the project has a `Joined` with `paid > 0`" (the same query on
   `event='Joined'`), still checked against the launch row's `projectId`.
5. **Scripts**: `scripts/chain-loop-e2e.sh`, `scripts/chain-loop-query.mjs`, `scripts/m7-chain-loop.sh` and
   `scripts/dev-chain.sh` drive `contracts/next` and read a version 1 record; they need rewriting once the record is built.
   I did not touch them.

## Results

Run on 19 November 2026 before the commits:

- `cargo test -p buzz-relay --lib chain_reader`: **30 passed, 0 failed, 4 ignored** (the four Postgres tests).
- `cargo test -p buzz-relay --lib chain_reader -- --include-ignored --test-threads=1` against the local Postgres and Redis:
  **34 passed, 0 failed**. (The count includes `config::tests::the_chain_reader_is_off_unless_configured_and_bad_values_fail_startup`,
  which matches the filter.)
- `cargo clippy -p buzz-relay --all-targets -- -D warnings`: clean.
- `rustfmt --edition 2021 --check` on the module: clean.
- `node scripts/chain-reader-events.mjs --check`: the table and the JSON match a fresh `forge build`.
- `python3 -I scripts/chain-reader-fixture.py --check`: a second run of the real chain gives the same file, byte for byte.
