# Plan v2, milestone 5, part 2: the helper, a harder reader, the claim contract, the market

Server only (`crates/buzz-relay/src/chain_reader` and neighbours), on branch `v6`, not pushed. Part 1 is in
`PLANV2-M5-REPORT.md`; this part takes its "Not done in part 1", its helper design note and its review leftovers.

## What was built, in the order asked

### 1. The helper job (`chain_reader/helper/`, migration 0066)

Built as the part 1 design note says. Commits `6a376bddf` (tables) and `fee8ef2fd` (the job).

- **Calls** are a closed enum (`helper/calls.rs`) that writes its own calldata; no job carries raw calldata. Stored jobs
  keep the call's name and arguments and are parsed back into the enum; an unknown name is a terminal failure. The list:
  `Rounds.close`, `settleMany`, `release`, `returnUnsold`, `sweepFees`; `Treasury.sweepFees`, `release`;
  `Finisher.openPool`, `settle`, `sweep`, `abandon` (only when due); `LiquidityHolder.collect`; `Vester.claim` for plain
  grants only (`Granted`, never `HeldGranted`, never the claim contract); `EarlierBackers.deliverMany`.
- **Never sent:** `Vester.claimHeld`, `Rounds.refund`, `Treasury.checkIn`, `payTeam`, `spend`, `give`, any Pair, runner or
  Launcher write, `Rounds.ask` and `lower`, `EarlierBackers.consent`. `calls_tests.rs` pins the selector set to the
  allow-list exactly and checks each forbidden selector is absent; `plan_tests.rs` feeds the builder every fixture and
  checks it produces only allowed calls.
- **Jobs come only from final rows** (`helper/plan.rs`, pure) and carry the block whose row made them due; a rollback
  deletes pending, dropped and failed jobs past the fork in the same transaction as the logs (`store::rollback`).
- **Checked again at the head** before sending: the contracts' views (`releasable`, `platformOwed`, `feesOwed`,
  `pendingRelease`, `unsold`, `claimable`, `positionOf` per backer, `entryOf` and `due` per entry, `abandonBlock`,
  `poolIsOpen`), then `eth_call` and `eth_estimateGas` from the helper's address. Calls that succeed but do nothing are
  never sent. `settleMany` leaves out settled backers and zero asks; `deliverMany` leaves out open entries, entries inside
  their 21 days or the lock-up gate, and entries with nothing due (EarlierBackers review O1).
- **One key, off by default:** `BUZZ_CHAIN_HELPER_KEY` (32-byte hex, never logged). One transaction in flight; the nonce
  read from `latest`, never `pending`; a vanished transaction goes back to pending and is checked again; a stuck one is
  replaced at the same nonce.
- **Caps and retries:** a daily gas and spend cap counted from every broadcast (`chain_helper_sends`: reserved at send,
  settled to the receipt), so stuck sends count. Reaching a cap postpones the job without counting an attempt. A failure
  adds an attempt with a doubling pause (at most 6 hours) and ends `failed` at the attempt limit, with the last error kept.
- **One writer:** a session advisory lock on a connection detached from the pool, checked every pass. Only the replica
  holding it signs records and sends (review O3).

Configuration (all need `BUZZ_CHAIN_RPC_URL`; any `BUZZ_CHAIN_HELPER_*` without the key stops startup):

| Variable | Default |
|---|---|
| `BUZZ_CHAIN_HELPER_KEY` | unset: the helper is off |
| `BUZZ_CHAIN_HELPER_DAILY_GAS` | 30,000,000 (at least the per-call cap; half kept for closes, settles and the finish) |
| `BUZZ_CHAIN_HELPER_DAILY_SPEND_WEI` | 10^16 |
| `BUZZ_CHAIN_HELPER_MAX_ATTEMPTS` | 8 |
| `BUZZ_CHAIN_HELPER_CALL_GAS_CAP` | 3,000,000 (at most the transaction ceiling) |
| `BUZZ_CHAIN_HELPER_BATCH` | 15 backers or entries per batch (a batch over the cap is halved) |

**The spend cap and fees.** A batch is halved to fit the gas room only. The spend cap is checked whole: a call whose
reserve (its gas limit times the max fee per gas) is over what is left of the day's spend is put off an hour at a time,
with no attempt counted and no terminal state, and an essential call put off this way ends the pass. A 15-backer
`settleMany` asks about 2.4M to 2.8M gas; at a 20 gwei max fee it reserves about 0.05 of the native coin, five times
the default daily spend of 10^16 wei, so it would never go out. The default spend fits a call at the 3M per-call cap
only while the max fee is under about 3.3 gwei, and a routine call (half the spend) under about 1.7 gwei. That is
harmless on Base-like fees (well under 1 gwei). On a chain with higher fees, set `BUZZ_CHAIN_HELPER_DAILY_SPEND_WEI` to
at least twice the per-call cap times the highest max fee expected. Startup does not check this, since the fee is not
known then.

### 2. Reader hardening (`02d61160a`)

- **F9:** the reader runs under `supervise`, which starts it again after a panic or an end, with a pause doubling up to
  ten minutes. The last good pass is kept as unix seconds (`chain_reader::last_good_pass()`, the gauge
  `buzz_chain_reader_last_good_pass_seconds`, and `chain_reader.last_good_pass` in `/_status` when the reader is on).
- **O1:** Council only after the Finisher's `Swept` for a sale that was not abandoned (an abandon emits `Swept` too);
  the open date follows it.
- **O2:** no "no market" date while a sale runs (`SaleOpenedBy` with no `Swept`, `SaleFailed` or `Abandoned` yet) or
  after `Treasury.SaleAbandoned`; a failed sale brings the date back.
- **O3 / F6:** the writer lock above gates signing. When a newer record is already stored, the store answers with the
  incoming event either way, so the reader now looks at the live record: if it is not its own, it signs again one second
  after the stored one and remembers that time; if that is refused too, the project's row is left as it was and the next
  pass tries again.
- **F7:** a node whose head is below the newest stored block, or that does not have that block, is waited for: nothing
  is undone, signed or sent that pass.

### 3. Project zero's earlier backers (`fad3f6c23`)

- The claim named in `Launcher.ProjectZeroSplit` is followed from its launch block (role `earlier`). Only that claim:
  `EarlierBackersNamed` can name another before the launch. All eleven events are in the list and checked against the
  build.
- Project zero's `earlierBackers` keeps the split (`fromBacking`, `fromFounder`, `teamBudget`) and adds counts and
  totals only: `bound`, `textVersion`, `consented {count, total}`, `voidedCount`, `delivered {count, total}`,
  `replacements {pending, done, cancelled}`, `listClosed {at, open}`, `sentToReserve`, `keeperChanges`, and
  `receivers {count, shares}`. No entry, holder, receiver or single amount is in the record (a test checks the JSON).
- **Decision on receivers in the holder list:** an account that received Shares from the claim (`Delivered.receiver`)
  is left out of the holder list and counted only in `receivers`. Otherwise each receiver would be listed with its entry's
  Shares, which is per-entry data. The cost: such an account is not listed even if it later buys more.
- The constructor's `TextPublished(1)` and `KeeperChanged` are mined before the Launcher names the contract, so the reader
  never sees them; version 1 is assumed and `keeperChanges` counts changes after the naming.
- `teamPaid` and `teamBudgetLeft` (from `Treasury.TeamPaid`) were already in `treasury`.

### 4. `/sw.js` for the app (`29314b457`; milestone 6 open item 1)

The web fallback answers `/sw.js` from `BUZZ_WEB_DIR/sw.js` with `Content-Type: text/javascript; charset=utf-8`,
`Cache-Control: no-cache` and the page's isolation headers, before the full-SPA fallback can answer it with the page. A
bundle without the file answers 404, never the page. `/sw.js` is an exact NIP-FI exemption. The worker sits at the root,
so no `Service-Worker-Allowed` header is needed.

### 5. Auctions, pool trades, pool fees, running totals (`96aeeba3f`, `f9d74cdf3`)

- **Auctions:** found from `Launcher.SaleOpened` and `ReserveSaleOpened` (role `auction`). `BidSubmitted`, `BidExited`,
  `TokensClaimed`, `CheckpointUpdated`, `ClearingPriceUpdated` and `TokensReceived` add up into `bids[]`, one entry per
  auction: count, amount, exits, refunded, Shares claimed, clearing price, Shares for sale. No bidder is listed.
- **The Launcher's fixed contracts:** `holder()` and `strategy().poolManager()` are read once with `eth_call` (a new
  `ChainSource::eth_call`) and stored as roles `holder` and `pool_manager`. A failed call fails the range, so it is read
  again.
- **Pool fees:** `LiquidityHolder.Collected` goes to the project whose Treasury its topic names. `Owed` and `OwedSent`
  count when they name the project's Treasury. The record shows them under `pool.fees`.
- **Pool trades:** only the `Swap` logs of the pools the projects' Finishers opened (`Finisher.PoolOpened.poolId`) are
  read from the shared pool manager, with a filter on the second topic (`ChainSource::logs_with_topic1`; a source that
  cannot filter on it errors rather than answering nothing). Signed `int128` and `int24` values decode as two's
  complement (`Ty::Int`, `word_to_signed_decimal`). The amounts are the trader's (checked in v4-core: the swap delta is
  accounted to `msg.sender`), so a positive Shares amount is a buy. `pool` has the trades, traded dollars, Shares bought
  and sold, and the last price and tick.
- **F8:** the LiquidityHolder and the pool manager are never listed as holders.
- **F5, running totals (migration 0067):** `chain_balances` keeps each project's Shares per account as ranges commit;
  `chain_balance_changes` keeps each change under its block and log, and a rollback subtracts and deletes the changes past
  the fork in the same transaction that deletes the logs (an emptied balance is kept at 0, and reads leave zeros out). A project's logs load without its
  Transfers, and balances are read as of the final block (stored balance less any change past it). Both tables are
  operator-global, mirrored in `schema/`, registered in the reconcile script, and covered by a parity test.

## Tests

| Lane | Result |
|---|---|
| `cargo test -p buzz-relay --lib chain_reader` (pure) | 48 passed, 21 ignored (the Postgres ones) |
| `... chain_reader -- --include-ignored --test-threads=1` (Postgres and Redis) | 69 passed |
| `cargo test -p buzz-relay --lib router::tests::` | 50 passed, 8 ignored |
| `cargo test -p buzz-relay --lib config::tests:: -- --test-threads=1` | 103 passed |
| `cargo test -p buzz-db --lib runtime::migration -- --include-ignored --test-threads=1` (scratch database) | 31 passed |
| `node scripts/chain-reader-events.mjs --check` | matches the `contracts/next` build |
| `cargo fmt --all -- --check`; `cargo clippy -p buzz-relay -p buzz-db --all-targets -- -D warnings` | clean |

New tests in this part, and the guard removal that makes each fail (one at a time, restored after):

| Test | Guard removed | Result |
|---|---|---|
| `hardening_postgres_tests::a_newer_stored_record_does_not_hide_the_numbers` (F6) | the first version took the store's answer as the stored record | failed (the planted record stayed shown), which found the bug that the store answers with the incoming event |
| `hardening_postgres_tests::a_node_behind_the_stored_blocks_is_waited_for_not_rolled_back` (F7) | the head and missing-header checks in `check_rollback` | fails |
| `supervise_tests::a_panicking_reader_is_started_again_and_the_good_pass_moves` (F9) | none needed: it fails unless the task is started again after its panic | |
| `numbers::tests::an_abandoned_sale_is_not_council_and_shows_no_no_market_date`, `a_failed_sale_brings_the_no_market_date_back`, and the extended `stages_follow_the_launcher_rules` (O1, O2) | | |
| `numbers::tests::earlier_backers_are_counts_and_totals_only` | leaving receivers in the holder list | fails |
| `hardening_postgres_tests::the_earlier_backers_claim_is_found_and_counted` | discovery from `ProjectZeroSplit` | fails |
| `router::tests::the_service_worker_is_served_from_the_bundle_root` | (before the change `/sw.js` was 404, or the page in full-SPA mode) | fails |
| `word::tests::signed_decimals_keep_their_sign`, `events::tests::a_pool_swap_decodes_with_its_signs` (`cast abi-encode` fixture) | | |
| `numbers::tests::bids_trades_and_pool_fees_are_added_up` | the shared-contract holder exclusion (F8) | fails (also the Postgres test below) |
| `hardening_postgres_tests::auctions_pool_trades_and_fees_reach_the_record` | `Swap` logs assigned to their pool's project | fails |
| `hardening_postgres_tests::running_balances_follow_transfers_and_a_rollback` (F5) | the rollback's balance subtraction | fails |
| `runtime::migration::...::chain_balance_tables_are_operator_global_in_every_schema_source` | | |

Helper guards removed once in this part: the `positionOf` check (settled backers left out) fails
`a_settled_backer_is_left_out_of_the_batch` and `a_rollback_past_the_row_that_made_a_job_due_drops_it`; the daily cap
check fails `the_daily_cap_puts_a_job_off_without_counting_an_attempt`.

## The real-server loop on anvil

`FOUNDRY_BIN=... bash scripts/chain-loop-e2e.sh` with the relay built from this branch, exit 0. Nobody closes or settles
by hand; the relay's helper (anvil account 4) does:

```
ok the helper closed the round (tx 0xb49a…ed11) and settled both backers in 1 transaction(s), block 29
ok the record is as of block 23 with the head at 29
ok total raised: 2500000000          ok against the cap: 10000000000      ok stage: backed
ok round price for the whole project: 333333.33                         ok receipts: 2
ok day 0 refund for bob: 77899974 (chain: 77899974; per 100: 77.90)
ok day 45 refund for bob: 58639035 = chain 58639035 (58.64 of each 100; the worked number is 58639010)
ok block 39: bob took back 58639030; the record shows it and offers him nothing more
ok rolled back: the refund's row is gone, the record offers bob 58639035 again (chain: 58639035 at block 40)
ok helper: 4 sent, 805286 gas; jobs: rounds.close:done rounds.settleMany:done rounds.release:done rounds.sweepFees:done
ok a posted copy of the record is refused (relay-only kind)
every check passed
```

The relay log had no failed pass. On anvil the reader also resolved the holder and the (mock) pool manager by `eth_call`.

## Open, with reasons

- **Step 6, notices to backers** (a lower-priced round, an auction starting below what they paid): **not built.** The
  part ran out of room after step 5. The shape, for the next part: an outbox table (`reader`, source block and log,
  backer pubkey, state, attempts, next try, last error), dropped by a rollback like helper jobs and built only from final
  rows; backers mapped through `evm_identities` (`revoked_at IS NULL`); sent as relay-signed DMs by a sibling of
  `handlers/moderation_notices.rs` with its own "{host} Projects" profile and a deterministic `created_at`. A backer with
  no bound address gets no DM. The record already has each round's price and each receipt.
- **The helper's `collect` is never built in practice:** pool position token ids are not in any project event; they
  come from the position manager's ERC-721 `Transfer` to the holder, which needs a filter on the third topic and a way to
  tie a token to its project (the Finisher's settle transaction). `logs_with_topic1` is the pattern to extend.
- **Auctions, pool trades and pool fees are tested only on the fake chain** with `cast` fixtures and real Postgres. The
  anvil loop uses `MockStrategy` and `MockGuard`, with no v4 pool, auction or position manager.
- **F5 is in part:** `final_projects` still groups every stored log to find each project's newest block, and balance
  changes and Transfer rows are kept (for rollbacks), not pruned.
- **"k of N":** the record has the agreed count (k) but not `entryCount()` (N), which only a view gives; the reader does
  not call views for the record. The app reads `entryCount()`. `launchHash(key)` is not computed.
- **The holder and pool manager are found when a range is read:** a reader that ran before this change reads their
  logs from its current position on. No project has a pool yet, so nothing is missed today.
- **F7's second case** (a node whose head is above the stored tip but that lacks the tip's header) is covered by the
  same branch but has no test of its own.
- `./bin/pgschema apply` plus the reconcile script was not run by hand. The buzz-db parity tests, including the
  desired-state against migrations test on a scratch database, pass.
- `api::mesh_demo::tests::demo_join_forwarded_arm_round_trips_echo` failed in part 1 (504) and is unrelated. It was not
  run again here.

## Commits

`6a376bddf`, `fee8ef2fd` (the helper), `02d61160a` (hardening), `fad3f6c23` (earlier backers), `29314b457` (`/sw.js`),
`96aeeba3f` (market), `f9d74cdf3` (running balances), `c222ecb9d` (clippy), then this report.

## Review fixes

Two reviews found one blocker (both), three important defects in the first and two in the second. Each fix has a test
that fails without it (checked by removing each guard in turn and restoring it), except one part of I3: the reader's
pass keeping the helper's error (`pass_all`'s `match` on the helper's pass) failed no test when it was removed, since
the I3 test's node errors no longer reach it. The second review of these fixes found that; its test is below. The reviewers' failing tests were
adopted: the attack tests moved from `crates/buzz-relay/tests/attack_m5p2_helper.rs` (deleted, to save building a second
test binary) into `chain_reader/helper/review_m5p2_tests.rs`, and the reader's into
`chain_reader/review_m5p2_postgres_tests.rs`.

| Finding | Fix | Test (fails without the fix) |
|---|---|---|
| **B1** (blocker, both reviews): the default batch of 40 settles needs about 6.0M gas with the margin, over the 3M per-call cap and the 5M daily cap; the job was retried as it was until `failed` | Defaults are now batch 15 and daily gas 30M. A batch whose estimate is over its room (the per-call cap, and never more than its daily budget) is halved until it fits, and the first part is sent with no attempt counted. For `settleMany` the rest is still waiting once that send is final, so the builder makes it a new job (for a repeating `deliverMany` it was not; see the second review below). Startup refuses a daily gas cap below the per-call cap. | `a_default_sized_settle_batch_is_sent` (fails with the old defaults), `an_oversized_batch_is_halved_not_failed` (fails without the halving: `failed` after 8 attempts), `config::tests::the_chain_helper_is_off_unless_its_key_is_set_and_never_echoes_it` (the new startup check) |
| **I1** (second review): one backer whose settle reverts (a blacklisted dollar receiver) reverts the whole batch, which ended `failed` and left the rest unsettled | When a batch's `eth_call` reverts for a reason other than "nothing to do", each member is simulated alone with `eth_call` (nothing is sent). The batch is tried once more without the members that revert. Those come back later in a batch of their own, which can fail for good without holding back anyone else. | `one_reverting_backer_does_not_strand_the_rest_of_its_batch` |
| **I2** (second review): the daily caps were one first-come budget, so many small `Vester.claim`s of one project could keep another project's round from closing | The calls a round or a sale waits on (`close`, `settleMany`, the Finisher's steps) are essential. Routine calls (releases, sweeps, claims, deliveries, collection) may use at most half of each daily cap (`ROUTINE_SHARE_PERCENT`); a routine call over its share is put off without an attempt and the pass goes on. A routine call whose share is used up waits without asking the node anything. Due jobs are now ordered by priority in SQL, not only within the first 200 by id. | `dust_claims_of_one_project_do_not_stop_another_projects_close` |
| **I3** (first review) / O1 (second): any helper error failed the whole reader pass, slowing record signing to every 10 minutes and freezing the reader's health number | The helper runs as its own step: an error is logged, counted (`buzz_chain_helper_pass_failed_total`) and kept in `PassReport.helper_error`, never returned from `pass_all`. A node that does not answer a job's check, `eth_call`, estimate, fees or nonce puts that job off for 5 minutes without an attempt, ends the helper's pass and is counted (`node_errors`, `buzz_chain_helper_node_errors_total`), so the next pass starts with other jobs. A view answer that cannot be read counts an attempt. The helper has its own health number: `chain_reader::last_good_helper_pass()`, the gauge `buzz_chain_helper_last_good_pass_seconds`, and `chain_reader.helper_last_good_pass` in `/_status`. | `a_node_that_does_not_answer_the_helper_does_not_fail_the_pass` (the reader's pass failed before; now its record is signed and the close goes out once the node answers) |
| **I1** (first review): trades between the pool step (which makes the pool) and `settle()` (which names it in `PoolOpened`) were lost when the two landed in different ranges | When a pool is first named, its `Swap` logs are also read back from its pool step's block (`PoolStep`, stored or in this range; else the sale's `endBlock`) up to the range, in pieces the size of the range. Rows from before the range are inserted with `ON CONFLICT DO NOTHING`, and the projects they belong to are marked to be signed again. | `swaps_before_pool_opened_in_an_earlier_range_are_counted` (the review's test, with the `PoolStep` that precedes any trade on chain) |
| **I2** (first review): on a database where the part 1 reader ran, migration 0067 started the running balances empty while Transfers stopped loading, and claim and auction contracts were found only in newly read Launcher logs | Migration **0068** (data only) fills `chain_balance_changes` from the stored Shares Transfers with the reader's rules (no zero address, no self-transfer), then sets every balance to the sum of its changes. It is safe to run again. Each range also looks at the stored Launcher rows (`ProjectLaunched`, `SaleOpened`, `ReserveSaleOpened`, `ProjectZeroSplit`, `PairMade`): a contract they name that is not followed is followed from then on, and its logs from where it was named are read back. | `migration_0068_fills_balances_from_stored_transfers`, `contracts_named_by_stored_launcher_rows_are_followed_with_their_past`, `runtime::migration::...::chain_balances_backfill_is_data_only` |

Optional findings:

- **Fixed because they were small:** the replacement of a stuck transaction is recorded before it is broadcast, as the
  first send already was, and voided if the node refuses it (O4a / O2). Before a send's cost is cancelled, its receipt
  is checked once more. A send the node answers with "already known" is kept as in flight. `writer_address` is inlined
  (O3, in part).
- **Declined: the "not yet" Finisher sweep (O1 of the first review).** Treating `SettleFirst` and `PoolStepNotRun` as a
  postponement would leave the job without a terminal state. Today abandon covers the case where no pool exists, so it
  costs only retries.
- **Declined: pruning `chain_balance_changes` (O2).** A rollback, and migration 0068's sum, rely on every change being
  kept. Pruning below the rollback window needs a separate baseline balance. Recorded as open with F5's other part.
- **Declined: the dead `Transfer` arm in `numbers::derive` (O3).** The pure tests feed Transfers through it. Removing it
  means rewriting those tests to use the balances map, which is a refactor with no defect behind it.
- **Declined: deliveries less often (O5).** The routine share now protects closes and settles from daily deliveries.
  Deliveries stay daily so receivers get their Shares as they are released.
- **Declined: replicas that are not the writer open a connection each pass (O4b).** This costs one short-lived
  connection per poll for each standby replica. Taking the lock on a pooled connection and detaching it only after it is
  held is a small change, but it touches the writer lock, which already passed review. Left as open.
- **Declined: stable chunk keys and pruning failed jobs and sends (O3 of the second review).** The job count is bounded
  by the waiting list, and each check is at most one batch of views. Pruning is left open with F5's.

Gates after the fixes:

| Lane | Result |
|---|---|
| `cargo fmt --all -- --check` | clean |
| `cargo clippy -p buzz-relay -p buzz-db --all-targets -- -D warnings` | clean |
| `cargo test -p buzz-relay --lib chain_reader` (pure) | 48 passed, 29 ignored |
| `... chain_reader -- --include-ignored --test-threads=1` (Postgres and Redis) | 77 passed (8 new) |
| `cargo test -p buzz-relay --lib config::tests:: -- --test-threads=1` | 103 passed |
| `cargo test -p buzz-relay --lib router::tests::` | 50 passed, 8 ignored |
| `cargo test -p buzz-db --lib runtime::migration -- --include-ignored --test-threads=1` (scratch database, dropped after) | 32 passed |
| `FOUNDRY_BIN=... bash scripts/chain-loop-e2e.sh` (relay rebuilt from this change) | exit 0: the helper closed the round and settled both backers in 1 transaction, 4 sent, every job done, the rollback undone and signed again |

The Postgres tests run migration 0068 from its file. The shared local `buzz` test database itself has migrations up to
0067 only (checked in the second review): nothing in the relay's tests applies the embedded migrations to it.

## Second review of the fixes

The second review found two important defects that the fixes brought in, one test gap and two optional points. All are
fixed here.

| Finding | Fix | Test (fails without the fix) |
|---|---|---|
| A routine call that got stuck once the routine share was used up was never replaced: the replacement was checked for its whole cost again (the stuck send already counts), and against the routine share. With one nonce, no close, settle or finish step went out until it mined or the day passed (I2's starvation by another path). | The replacement is checked for what it adds over the sends still counted at its nonce (only one of them can mine: `store::reserved_at_nonce`), against the whole caps only. The call was let in when it was first sent. | `a_stuck_routine_call_is_replaced_when_its_share_is_used_up` (daily gas twice one claim, so the share holds one; replaced on stuck after 0 seconds; the writer never mines): fails without the fix (the stuck send is never replaced) |
| A halved repeating `deliverMany` sent its first half and ended `done`. Its key names the day and the batch's position, so the builder made the same first half again each day and the second half was never delivered (with `BUZZ_CHAIN_HELPER_BATCH=64`, entries 32 to 63). | When a repeating batch is halved, the members left out are stored as a job of their own (the job's key plus `:rest:` and a digest of them) in the same transaction that records the send (`store::Rest`). A one-off `settleMany` is left to the builder as before. | `every_due_entry_of_a_halved_repeating_delivery_is_delivered` (64 entries in one batch, about 3.8M gas, over the 3M cap): fails without the fix (the second half is never delivered) |
| Test gap: removing the reader pass's keeping of the helper's error failed no test. | | `a_node_error_on_the_send_in_flight_does_not_fail_the_readers_pass`: a transaction in flight whose receipt the node does not answer; `pass_all` is Ok, `helper_error` is kept and the record is signed. With `?` in place of the `match`, the pass fails. |
| Optional: migration 0068 ended by deleting zero balances, and the reader's rollback did too. A rollback only subtracts from rows that exist, so an account at 0 with changes inside the rollback window was lost after a reorg past them (two rollbacks in a row, or a reorg after 0068). | The rollback keeps zero balances (`balances()` already leaves zeros out). 0068 already ran on local databases and sqlx refuses an applied migration whose checksum changed, so 0068 is left as it is and migration **0069** (insert only, data only) puts back a row for every account with kept changes and no balance. It changes no table, so `schema/` and the reconcile script need nothing (a fresh database has no rows); a buzz-db test pins it to inserts only. | `two_rollbacks_in_a_row_restore_a_balance_that_was_emptied` (fails with the rollback's delete put back), `migration_0069_puts_back_emptied_balances` (fails when 0069 deletes the zeros again), `runtime::migration::...::chain_balances_keep_zeros_is_insert_only`; `running_balances_follow_transfers_and_a_rollback` now expects the emptied balance kept at 0 |
| Optional: the spend cap is checked whole and has no terminal state. | Stated under the configuration above. | |

Guard removals, one at a time, each restored and the file touched so the next build used it: the old replacement check
(`over_cap` with the stuck send's gas and the routine share) fails the first test; no rest job fails the second;
`?` in `pass_all` fails the third; the rollback's `DELETE ... balance = 0` fails `two_rollbacks...`; a trailing
`DELETE` in 0069 fails `migration_0069...`.

Gates after the second review:

| Lane | Result |
|---|---|
| `cargo fmt --all -- --check` | clean |
| `cargo clippy -p buzz-relay -p buzz-db --all-targets -- -D warnings` | clean |
| `cargo test -p buzz-relay --lib chain_reader` (pure) | 48 passed, 34 ignored |
| `... chain_reader -- --include-ignored --test-threads=1` (Postgres and Redis) | 82 passed (5 new) |
| `cargo test -p buzz-db --lib runtime::migration -- --include-ignored --test-threads=1` (scratch database, dropped after) | 33 passed |
| `FOUNDRY_BIN=... bash scripts/chain-loop-e2e.sh` (relay rebuilt from this change) | exit 0: the helper closed the round and settled both backers in 1 transaction, 4 sent, every job done, the rollback undone and signed again |

Still open, as the review accepted: reading earlier logs for contracts or pools named late is not bounded (many log
requests on the first pass after a long gap), and `launcher_reveals` runs on every range.
