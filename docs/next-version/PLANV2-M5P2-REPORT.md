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
| `BUZZ_CHAIN_HELPER_DAILY_GAS` | 5,000,000 |
| `BUZZ_CHAIN_HELPER_DAILY_SPEND_WEI` | 10^16 |
| `BUZZ_CHAIN_HELPER_MAX_ATTEMPTS` | 8 |
| `BUZZ_CHAIN_HELPER_CALL_GAS_CAP` | 3,000,000 (at most the transaction ceiling) |
| `BUZZ_CHAIN_HELPER_BATCH` | 40 backers or entries per batch |

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
  the fork in the same transaction that deletes the logs (and drops emptied balances). A project's logs load without its
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
