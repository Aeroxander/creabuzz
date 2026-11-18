# Plan v2, milestone 5, part 1: the chain reader and the project numbers

18 November 2026. Branch `v4-governance-rework`, not pushed. Plan: `docs/PLAN-V2.md` sections 4, 7, 8 and 9; the events
come from `docs/next-version/PLANV2-M4-REPORT.md` ("Events the server must index" and the founder-set prices section).

## The short answer

- **Built:** a chain reader inside the relay (`crates/buzz-relay/src/chain_reader/`). It reads the `contracts/next`
  events of one Launcher and of every project the Launcher's events reveal (Shares, Treasury, Vester, Finisher, Rounds,
  Pair) into five Postgres tables that survive a chain rollback, works out the numbers the chain cannot give, and signs
  one "project numbers" record per project: **kind 39009**, addressable, `d` = the project's key, signed by the relay,
  republished when the numbers change. A copy posted by anyone else is refused (`restricted: relay-only kind`) on the
  WebSocket and on `POST /events`.
- **Off unless configured** (`BUZZ_CHAIN_RPC_URL`). With it unset, the relay and its tests behave as before (the boot
  tests and the 1,698 relay unit tests pass; see Gates).
- **Real-server loop passes** (`scripts/chain-loop-e2e.sh`, 17 seconds): anvil, the contracts deployed from the built
  artifacts, the real relay on a scratch database. One project is launched, alice backs 2,400 and bob 100 at the lowest
  price, the round closes and settles. The signed record read over a NIP-98 `POST /query` says 2,500 raised of the
  10,000 cap, stage Backed, price 333,333.33 for the whole project, and bob's refund equals `Rounds.refundable(1, bob)`
  read from the chain at the record's block: **77.90 of each 100 on day 0** (77,900,000, or 77,899,994 when the record's
  block is two seconds after the close: the clock runs by the second) **and 58,639,010 (58.64 of each 100) on day 45** with
  check-ins every 10 days. Then bob takes his money back, the chain rolls that block back on anvil (deeper than the
  confirmations), and the reader deletes the rows and signs the record again without the refund, matching the chain.
- **Not in this part:** auction bids, pool trades, LiquidityHolder fees, the helper job (a design note is below), public
  reads of the record on invite-only servers, notices to backers. Details under "Not done".

## What was built

| Piece | File | What it does |
|---|---|---|
| Settings | `chain_reader/settings.rs`, `config.rs` | `BUZZ_CHAIN_*` (table below). Off without the RPC URL; half a configuration, or a value set but unreadable, stops startup instead of quietly turning the reader off |
| Event catalog and decoding | `chain_reader/events.rs` | 65 events written out from `contracts/next/src`, each named by **(emitting contract's role, first topic)**, never by topic alone: Rounds and Treasury share `FeesSwept` and `WoundDown`, and Rounds, Treasury and Finisher each have a different `Settled`. Decodes topics and data (static structs, the one dynamic `bytes` in `Pair.Proposed`) into JSON; every integer is kept as a 256-bit decimal string (`sqrtPriceX96` does not fit a u128) |
| Node access | `chain_reader/source.rs` | `ChainSource` trait over JSON-RPC (`eth_chainId`, `eth_blockNumber`, `eth_getBlockByNumber`, `eth_getLogs` with an address list and a `topics[0]` list) through the existing `buzz-evm-allowance` `EvmRpc`. Each call has a 20 s limit; at most 100 addresses a call; an answer of more than 10,000 logs is refused, never cut. Tests use a fake chain |
| Scanning and rollbacks | `chain_reader/scan.rs` | One pass: compare the newest stored block's hash with the chain; if it differs, walk the stored blocks (at most 2,048) to the newest one still on the chain (the fork point), delete every row past it, and read again from there. Then read up to 20 ranges of `BUZZ_CHAIN_LOG_RANGE` blocks. Inside a range, contracts found in a Launcher event are read from their discovery block in the same range (a project's own logs at launch, such as the founder's grant, come before the Launcher's event). A range is refused (and read again next pass) if the node marks a log `removed`, if a log names a block hash that is not the block's, if the first block does not follow the stored one, or if the last block changed while it was read |
| Tables | `chain_reader/store.rs`, `migrations/0065_chain_reader.sql`, `schema/` | Every write that moves the reader is one transaction under the reader's advisory lock and checks that the cursor is still where the pass read it (two relays reading the same chain cannot interleave; the slower one's work is dropped and read again) |
| The numbers | `chain_reader/numbers.rs` | Works out one project's numbers from its final logs (below) |
| Signing | `chain_reader/publish.rs`, `chain_reader/mod.rs` | Signs kind 39009 with the relay key, stores it with `replace_parameterized_event` (keyed by `d`, so each project keeps its own record), and sends it to live subscribers. Signs again only when something a reader would see changed: at once when an event changed the numbers, and for the time-moving part (refunds, the active clock) at most once per `BUZZ_CHAIN_REFRESH_SECS`. At most 100 records a pass. A project whose launch left the chain gets a record `{"removed": true}` |
| The relay task | `main.rs`, `chain_reader/mod.rs` | Spawned only when configured. Checks the node serves the configured chain id before every pass. A failed pass is logged and tried again after a pause that doubles up to 10 minutes; it never ends the relay |
| The kind | `buzz-core/src/kind.rs`, regenerated `packages/creaton-core/src/kinds.generated.ts` and `mobile/lib/shared/kinds.g.dart` | `KIND_PROJECT_NUMBERS = 39009`, in `ALL_KINDS` and `is_relay_only_kind`, with a compile-time check that it is addressable |

### What the reader works out (the chain cannot give it directly)

Each rule is copied from `contracts/next/src` and pinned by a test in `chain_reader/numbers_tests.rs`.

| Number | Rule |
|---|---|
| Total raised against the cap | Sum of `Rounds.RoundClosed.accepted` (= `Rounds.raised`), **not** of `Rounds.Settled.accepted` (scale-back dust and unsettled backers make that lower). Cap 10,000 (one person) or 50,000 once a Pair runs the project. Refunds do not reopen the cap |
| Each round's price | `RoundOpened.sharesPerRawDollar`, shown as dollars for all 1,000,000,000 Shares to the cent, rounded down (3e15 is 333,333.33; 166,666,666,666,666 is 6,000,000.00) |
| Average price paid | Money-weighted: total raised over the Shares those dollars bought (sum of accepted x each round's price). 1,000 at 6,000,000 then 3,000 at 333,333.33 averages 436,363.63 |
| Scale-back | `accepted / asked` as a percent when below 100 |
| Stage and since when | Solo until the first round closes with money; Backed from that close; Team from `PairMade` (or `RunnerChanged` to a Pair); Council from `Treasury.PoolOpened`; Open 365 days after `Vester.Started` once the pool opened |
| Eligible since | For the next stage: Backed from launch, Team from the Backed date, Council from the Team date, Open from its date; none after a wind-down |
| "No market" from | One year after the first money (or launch) while no pool opened |
| Quiet since | The wind-down time, the pause time, or the end of the check-in window (last check-in plus 14 days) once it has passed |
| Refund per 100 for each receipt | `Rounds.refundable` worked out exactly on the Rounds' **active clock**, not wall time: time counts only inside the Treasury's check-in window (14 days after the last check-in, or after the first sale money is settled), not while paused, never after a wind-down; modelled from `CheckedIn`, `Paused`, `WoundDown` and the Treasury's first `Settled` / `ReserveSaleSettled`, with `Rounds.sync`'s bookkeeping. Part = held money x Shares still held / Shares granted; released part rounded up; fee 5% (1% after a wind-down) rounded up. A refund ends the position. The modelled clock is checked against every `RoundClosed.activeAtClose` and a difference is logged |
| Held and free Shares per account | Held: Vester grants less claims, cancels and the founder's trim. Free: the project's Shares `Transfer` events. The project's own contracts, Pairs and auctions are left out |
| Treasury sums | Sale and reserve-sale money settled, top-ups, Share revenue, floor released, spent, Shares given, the stake, hand-backs (count, Shares, paid), refunds paid, the runner |

## Tables (migration 0065, mirrored in `schema/`)

All five are registered in `_operator_global_tables` (in the migration, in `schema/seeds/`, and, because pgschema skips
seed rows, in `scripts/reconcile-schema-after-pgschema.sql` with a live assertion). They hold public chain facts for the
whole deployment, one reader per `reader = '<chain id>:<launcher>'`, not one community's data; the records go into the
configured community's events.

| Table | Key | Holds |
|---|---|---|
| `chain_reader_cursor` | `reader` | The next block to read |
| `chain_blocks` | `(reader, number)` | Hash, parent hash and time of every block a stored log came from and of the last block of each range read (range ends without logs are dropped once more than `confirmations + 64` blocks old): what the fork point is found with |
| `chain_contracts` | `(reader, address)` | The Launcher and each project's contracts, with role, project key and the block they were found in (a rollback past it forgets them) |
| `chain_logs` | `(reader, block_number, log_index)` | Block hash, transaction hash, address, role, project key, event name, raw topics and data, and the decoded fields (JSONB). Deleted past a fork point |
| `chain_project_numbers` | `(reader, project_key)` | What was last signed: the newest final block it covers, digests of the event-derived part and of what a reader sees, the event id, when, and `stale` (set by a rollback past `source_block`, so the numbers are worked out again even when the new rows end at the same height). A failed signing leaves the old row, so the next pass tries again |

Only rows at least `BUZZ_CHAIN_CONFIRMATIONS` blocks under the head count in the numbers (the record's `asOf.block`).

## The record: kind 39009

Addressable (39000-39999), signed by the relay key, stored for the configured community. Tags: `["d", "<project key, 0x
+ 64 hex>"]`, `["chain", "<chain id>"]`, `["launcher", "<Launcher address>"]`. The key is the contracts' own:
`keccak256(abi.encode(founder, projectId))`. Content is JSON with `"version": 1`. Amounts are decimal strings in raw
units (dollars with 6 decimals, Shares with 18); times are unix seconds; prices for the whole project are dollars to the
cent. Everything outside `now` changes only with an event; `now` moves with time as of `asOf.time`, and `clock.runsUntil`
lets a reader carry the clock forward to the next event. Lists hold at most 200 entries; `receiptCount`, `holderCount` and
`truncated` say when a list was cut (a record stays under about 150 KB).

The day-45 record from the real loop (contracts and accounts are anvil's; the 200-million founder grant is the 20%):

```json
{
  "version": 1, "chainId": 31337, "launcher": "0x0165878a594ca255338adfa4d48449f69242eb8f",
  "key": "0x23ae9e81940f353d5fc623414c6b2604fdffc87ac3d53e7f45aa2fbef7804db3",
  "projectId": "0x5c186cdb2fc8a83f07601478d83a41afffaef603bbff5494414b6fd2cbfa481d",
  "founder": "0x70997970c51812dc3a010c7d01b50e0d17dc79c8", "launchedAt": 1794991748, "projectZero": false,
  "contracts": {"shares": "0xaf19…7695", "treasury": "0x20b6…0906", "vester": "0x2787…b78b",
                "finisher": "0x0593…ab17", "rounds": "0x3992…9ba0", "pair": null},
  "stage": {"name": "backed", "since": 1795078148, "openAt": null},
  "eligible": {"for": "team", "since": 1795078148},
  "noMarketFrom": 1826614148, "noMarketAt": null, "woundDownAt": null,
  "raised": {"total": "2500000000", "cap": "10000000000", "left": "7500000000"},
  "averagePrice": {"sharesPerRawDollar": "3000000000000000", "projectPrice": "333333.33"},
  "rounds": [{"round": 1, "size": "10000000000", "cap": "10000000000", "raisedBefore": "0",
              "sharesPerRawDollar": "3000000000000000", "projectPrice": "333333.33",
              "opensAt": 1794991748, "closesAt": 1795078148, "backers": 2, "asked": "2500000000",
              "closed": true, "closedAt": 1795078148, "accepted": "2500000000", "acceptedPercent": null,
              "activeAtClose": 86400, "settled": 2, "released": "0"}],
  "clock": {"lastCheckIn": 1798966148, "runsUntil": 1800175748, "paused": false, "woundDown": false},
  "receipts": [
    {"round": 1, "backer": "0x3c44…93bc", "accepted": "2400000000", "returned": "0",
     "shares": "7200000000000000000000000", "heldMoney": "1968000000",
     "sharesHeld": "7200000000000000000000000", "refunded": null},
    {"round": 1, "backer": "0x90f7…b906", "accepted": "100000000", "returned": "0",
     "shares": "300000000000000000000000", "heldMoney": "82000000",
     "sharesHeld": "300000000000000000000000", "refunded": null}],
  "receiptCount": 2,
  "holders": [
    {"account": "0x7099…79c8", "held": "200000000000000000000000000", "free": "0"},
    {"account": "0x3c44…93bc", "held": "7200000000000000000000000", "free": "0"},
    {"account": "0x90f7…b906", "held": "300000000000000000000000", "free": "0"}],
  "holderCount": 3, "truncated": false,
  "treasury": {"toppedUp": "375000000", "handedBackCount": 0, "runner": "0x7099…79c8"},
  "sale": null, "reserveSales": [],
  "asOf": {"block": 26, "time": 1798966148},
  "now": {"stage": "backed", "activeSeconds": 3974400, "quietSince": null,
          "refunds": [{"round": 1, "backer": "0x3c44…93bc", "refundable": "1407336263", "per100": "58.64"},
                      {"round": 1, "backer": "0x90f7…b906", "refundable": "58639010", "per100": "58.64"}]}
}
```

(Addresses shortened here; the record carries them in full. `toppedUp` 375 is the project's 15 of each 100 at once.)
After a launch that later leaves the chain the record becomes `{"version": 1, "chainId", "launcher", "key",
"removed": true, "asOf"}`.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `BUZZ_CHAIN_RPC_URL` | unset: the reader is off | An http(s) JSON-RPC node |
| `BUZZ_CHAIN_ID` | required with the URL | The chain the node must serve (checked before every pass) |
| `BUZZ_CHAIN_LAUNCHER` | required with the URL | The Launcher; every project's own contracts are found in its events |
| `BUZZ_CHAIN_START_BLOCK` | 0 | The first block to read (the Launcher's deployment block) |
| `BUZZ_CHAIN_CONFIRMATIONS` | 12 | Blocks under the head before a log counts; the reader reads no block above that, and never the newest 2 (a lower setting acts as 2) |
| `BUZZ_CHAIN_POLL_SECS` | 12 | Seconds between passes |
| `BUZZ_CHAIN_REFRESH_SECS` | 3600 (60 to 7 days) | How often a record whose time-moving numbers changed is signed again without a new event |
| `BUZZ_CHAIN_LOG_RANGE` | 2000 (at most 10,000) | Blocks per log request |
| `BUZZ_CHAIN_COMMUNITY_HOST` | the host of `BUZZ_RELAY_URL` | The community whose events receive the records |

Any `BUZZ_CHAIN_*` set without the URL, a missing chain id or Launcher, or a value that cannot be read stops startup.

## Tests and measured results

| Test | Where | Result |
|---|---|---|
| Catalog equals the built artifacts: every event of Launcher, Rounds, Vester, Treasury, Finisher, Pair and ShareToken (except `Approval`) is in the catalog under its role, and every catalog event is in the artifact | `events_tests.rs` | pass |
| Topics pinned to the M4 report (RoundOpened twice, ProjectZeroNamed, ProjectLaunched, the three `Settled`, both `PoolOpened`, HeldClaimed); shared topics decode by role | `events_tests.rs` | pass |
| Real ABI-encoded logs: `Rounds.Settled`, `Rounds.Refunded` (the day-45 58,639,010), `Finisher.PoolOpened` with a 2^160-1 price, `Pair.Proposed` with dynamic bytes (and a bad offset refused), `ProjectLaunched` with its three structs; one topic or one byte short is refused | `events_tests.rs` | pass |
| 27 logs captured from the anvil loop decode to the round's numbers | `events_tests.rs`, `testdata/anvil_logs.json` | pass |
| Worked 2,500 example: day 0 refund 77.90 of each 100, day 45 with check-ins every 10 days **58,639,010 (58.64)**; raised, cap, stage, eligible, price, average, holders | `numbers_tests.rs` | pass |
| Without check-ins the clock stops 14 days after the last one and "quiet since" says so; a pause freezes it; a wind-down drops the fee to 1% | `numbers_tests.rs` | pass |
| Total raised is `RoundClosed.accepted`, not the settled parts (3 x 2.333333 = 6.999999 of a 7-dollar round) | `numbers_tests.rs` | pass |
| Average price weighted by money; stages Solo, Backed, Team (cap 50,000), Council, Open | `numbers_tests.rs` | pass |
| A refund ends the position; after taking out half the held Shares the refund covers the other half, then nothing (this found and fixed a bug: the model kept offering a refund after a partial one) | `numbers_tests.rs` | pass |
| An auction is not listed as a holder; a list of 205 backers is cut to 200 and says so | `numbers_tests.rs` | pass |
| Settings: off by default; half a configuration and five bad values stop startup | `config.rs` | pass |
| Real Postgres and a fake chain: discovery inside one range, a rollback to block 1 deletes 3 logs and the record is signed again with 40 instead of 100 raised, nothing is signed again without a change | `postgres_tests.rs` (ignored without Postgres and Redis) | pass |
| Only logs past the confirmation depth count (head 3, 2 confirmations: the close in block 2 waits for block 4) | `postgres_tests.rs` | pass |
| A posted 39009 is refused through the real `ingest_event` seam (`relay-only`) | `postgres_tests.rs` | pass |
| Migration 0065 and the schema seeds and reconcile script register all five tables; the desired-state schema stays in parity with the migrations | `buzz-db` `runtime::migration` (29 tests incl. the Postgres ones, one thread) | pass |
| `./bin/pgschema apply --file schema/schema.sql` then the reconcile script on a scratch database | by hand | applied (384 statements), reconcile passed, 5 tables registered |
| **Real-server loop on anvil** | `scripts/chain-loop-e2e.sh` | **all checks pass in 17 s** (below) |

The loop (`FOUNDRY_BIN=<foundry bin dir> bash scripts/chain-loop-e2e.sh`; it starts Redis if needed, uses the local
Postgres, and drops its scratch database):

1. Deploys QuoteToken, FixedFeeController (3%), MinBid(1e6, 4, 720), MockFactory, MockStrategy, the MockGuard (code placed
   at an address ending in `0x2000` with `anvil_setCode`, its `authorized` slot set to the strategy), Parts and the
   Launcher, straight from `contracts/next/out` (no compiling).
2. Starts `target/debug/buzz-relay` with `BUZZ_CHAIN_CONFIRMATIONS=2`, `BUZZ_CHAIN_POLL_SECS=1`.
3. Launch, check-in, `openRound(key, 3e15)`, alice asks 2,400 and bob 100, 24 hours later close and settle both.
4. Before two more blocks the record is as of block 17 with the head at 19 (the close is not counted yet).
5. After them: signed by the relay; raised 2,500,000,000 of 10,000,000,000; stage `backed`; round and average price
   333,333.33; 2 receipts; alice's held Shares 7,200,000 x 1e18; **bob's refund = the chain's `refundable(1, bob)` at
   that block (77.90 of each 100; 77,900,000 or 77,899,994 raw across runs, by the seconds between the close and the
   record's block)**.
6. Check-ins on days 10, 20, 30, 40 and 45: **58,639,010 = the chain's (58.64 of each 100)**. 27 logs, 1 record.
7. Bob refunds (58,639,005 one second later); the record shows it and offers him nothing more. `evm_revert` to before it
   and a different block at the same height: the reader logs the rollback (fork 28, 4 logs removed), the refund's row is
   gone, and the record offers bob 58,639,010 again, equal to the chain at its block.
8. A 39009 posted by another key over `POST /events` is refused as relay-only.

## Gates (one cargo process at a time, `nice`, `CARGO_BUILD_JOBS=2`)

| Gate | Result |
|---|---|
| `cargo fmt --all -- --check` | clean |
| `cargo clippy -p buzz-relay -p buzz-core -p buzz-db --all-targets -- -D warnings` | clean |
| `cargo test -p buzz-core --lib` | 355 passed, 1 ignored |
| `cargo test -p buzz-relay --lib` | 1,698 passed, 570 ignored, **1 failed: `api::mesh_demo::tests::demo_join_forwarded_arm_round_trips_echo`** (answers 504 instead of 200; a QUIC peer-to-peer echo between two local endpoints, untouched here and not related to the reader; not re-run on the base commit) |
| `cargo test -p buzz-relay --lib chain_reader -- --include-ignored` (Postgres, Redis) | 27 of 28 pass at the end. The catalog test passed against the artifacts of the committed contracts earlier in this run; after another run rebuilt `contracts/next/out` from its uncommitted Launcher change, the catalog test fails with `Launcher.EarlierBackersFunded is missing from the catalog`, as designed (see "Not done") |
| `cargo test -p buzz-relay --test boot_lifecycle` (and its 3 Postgres tests with `--ignored`) | 9 passed; 3 passed |
| `cargo test -p buzz-db --lib runtime::migration -- --include-ignored --test-threads=1` (scratch database) | 29 passed |
| `node scripts/regen-kinds.mjs --check` | up to date |
| `scripts/chain-loop-e2e.sh` | every check passed |

Note for whoever runs the buzz-db Postgres tests: they drop and recreate the `public` schema of the database they are
pointed at and must run on one thread. Run in parallel against the local `buzz` database once here, five interfered with
each other and the local `buzz` database was reset (it is migrated again at 65); run on one thread against a scratch
database, all pass.

## Not done in part 1

- **Auction bids, pool trades and LiquidityHolder fees** (`BidSubmitted` and the rest of the vendored auction ABI, the
  pool's swaps, `LiquidityHolder.Collected` / `Owed` / `OwedSent`): part 2. The Finisher's `PoolOpened`, `Settled`,
  `PoolStep`, `SaleOpenedBy`, `Swept`, `SaleFailed` and `Abandoned` are indexed, and the record carries the sale's opening,
  settlement and pool.
- **The helper job:** design note below, nothing sent.
- **Public reads on invite-only servers:** `api/public_read.rs` serves only kinds 37001 and 47003 to people who are not
  members. On an open server (the default, and the loop) anyone signed in reads 39009. Serving it to visitors of an
  invite-only server needs a rule tying the chain key (`d`) to the project record's id (which is not the chain key) and a
  decision on what a visitor may see; left for the app milestone.
- **Notices to backers** when a lower-priced round opens or the auction starts below what they paid
  (`FOUNDER-PRICE.md`, server notes): not built; the record has what is needed (each round's price, each receipt).
- **"Raised before Creaton"** (the founder-signed earlier-raise record): not built.
- **No running totals:** a project's numbers are worked out from all of its final logs each time they are checked. Fine
  for hundreds of projects; a project with tens of thousands of logs would want a summary table kept as logs arrive.
- **The event list follows `testdata/next-events.json`** (since the review fixes). After an event changes in
  `contracts/next/src`, run `forge build` there and `node scripts/chain-reader-events.mjs`, and add the event to
  `events.rs`; CI does not build `contracts/next`, so `--check` against a fresh build is a local step.

## The helper job (design note, not built)

The plan's helper "closes rounds, delivers Shares, finishes sales and collects fees; every call is one anyone may make".
Proposed shape, for part 2:

- **What it calls**, each only when the reader's final rows say it is due, and each first tried with `eth_call` at the
  head so a call that would revert or do nothing is never sent:
  - `Rounds.close(id)` once 24 hours have passed since the round opened;
  - `Rounds.settleMany(id, backers)` for unsettled backers of a closed round (this puts their Shares into the Vester as
    held Shares; it does not take any out);
  - `Rounds.release(id)` weekly, `Rounds.returnUnsold()` once no round can open again, `Rounds.sweepFees()` and the
    Treasury's `sweepFees` / `release()`;
  - the Finisher's `openPool()`, `settle()` and `sweep()` after the auction ends (and `abandon()` only when its block has
    come); `LiquidityHolder.collect(tokenId)` for pool fees;
  - `Vester.claim(beneficiary)` for **plain** grants only: the founder's, gifts and the stake, once the clock started.
- **What it never calls:** `Vester.claimHeld` for a backer's held Shares. Taking held Shares out ends that backer's refund
  for them, so only the backer may do it (the contract refuses anyone else since the milestone 4 review, and the helper
  must not try). Never `refund`, `checkIn`, anything a runner or Pair signs, or anything that moves a person's money by
  choice.
- **How it runs:** one relay-held key with a small balance, set by its own variable and off by default; a durable job
  table (`chain_helper_jobs`: call, target, arguments, attempts, next try, last error, terminal state) so every failure
  leaves a retry record with a growing pause and a limit, never a silent drop; a gas and spend cap per day; one nonce
  owner (the advisory lock the reader already uses); calls built only from rows past the confirmation depth and dropped if
  a rollback removes the row that made them due.

## Commits

On `v4-governance-rework`, not pushed: `329e4accc` the kind; `c28c8d037` the tables; `5e9b54878` the reader and its
tests; then the real-server loop and this report. The other run's uncommitted contract work and its `econ/*.py` files are
not in these commits.

## Review fixes

Two reviews of part 1 found one blocker and seven important defects (B1 = F4, I1 = F3, I2 = F1, I3, I4, F2, F5) and
eight optional ones. Every blocker and every important defect that is a concrete failure is fixed below, each with a
test that fails without the fix. F5 (cost grows with history) is left, with the reason.

| Finding | What was wrong | Fix | Test that fails without it |
|---|---|---|---|
| **B1 / F4** (blocker) | Team and the 50,000 cap stayed on for good once any Pair was made for the project, while `Launcher.capOf` and `stageOf` follow the current runner. A Pair that hands the seat to one person left the record saying Team, cap 50,000, 40,000 too much room. A Pair made for another project (`isPair` is one list for the whole Launcher) was not seen at all. | Team now comes from the current runner (`Treasury.RunnerChanged`): a Pair made by this Launcher for any project, read from the stored `Launcher.PairMade` rows up to the final block, or a registered Council (`CouncilRegistered`). Team's "since" is when the current Pair (or Council) runner took the seat; handing the seat to one person goes back to Backed (or Solo) and the 10,000 cap. | `numbers_tests::a_pair_that_hands_the_seat_to_one_person_ends_team_and_the_bigger_cap` (pure: backed, cap 10,000, left 7,500 after the hand-over), `numbers_tests::a_pair_made_for_another_project_counts_as_a_pair_runner`, and through Postgres `review_postgres_tests::a_pair_made_for_another_project_raises_the_cap` |
| **I1 / F3** | A record due a refresh whose shown numbers had not changed was checked again on every pass (its `published_at` never moved), and the due list was in key order and cut at 100. With more than 100 quiet projects, the ones later in key order whose refund really moved were never signed again; below 100, every quiet project was worked out again every 12 seconds. | A check that finds nothing changed now moves `published_at` (the row's "signed or last checked" time) to now, so the project leaves the queue for the refresh time; the due list is ordered longest-unchecked first (to the microsecond). Changed projects still go first. | `review_postgres_tests::quiet_projects_do_not_starve_a_moving_one_of_its_refresh` (100 quiet projects with keys 1 to 100 and one backed project with key 0xfe: five days later its record is signed again as of the new block with a lower refund, and a quiet project is marked checked, not signed) |
| **I2 / F1** | A range answering more logs than allowed (the reader's own 10,000 limit or a node's `-32005 query returned more than N results`, "block range is too large", "log response size exceeded") failed the pass, and the next pass asked for the same range: the reader stopped for good. | The refusal is a typed error (`TooManyLogs`) or recognised by the node's words (not rate limits or timeouts); the reader halves the range and reads again, down to one block, then doubles back toward `BUZZ_CHAIN_LOG_RANGE` after ranges that pass, and keeps the size reached for the next pass. One block alone over the limit fails with a message that says so. | `review_postgres_tests::a_range_with_too_many_logs_is_read_in_smaller_ranges` (a node that refuses more than 5 logs, 10 logs in a 3-block range: read in pieces, cursor 3; and one 4-log block with a limit of 2 fails with "block 0 alone"); `source::tests::too_many_logs_is_told_apart_from_other_failures` |
| **F2** | The reader read up to the head. A load-balanced node whose log index trails its headers answers the newest block with no logs while every hash check passes; the cursor moved past it and those logs were never read. | The reader reads only up to the head less the confirmation depth, and never the newest `MIN_LAG` = 2 blocks even when `BUZZ_CHAIN_CONFIRMATIONS` is lower (a depth under 2 acts as 2). Nothing above the final block was used anyway. | `review_postgres_tests::a_log_index_behind_the_headers_loses_no_logs` (the node's log index misses the head block's logs throughout: the 100-dollar ask is in the record) |
| **I3** | A log whose event is in the list but does not decode was stored for good as `unknown` and left out of the signed numbers with only a warning. | The range fails with the event, block and log named ("does not decode ... the event list does not match the deployed contracts"), so nothing is stored and the pass is retried until the list is fixed. | `review_postgres_tests::a_known_event_that_does_not_decode_stops_the_reader` (an `Asked` with one data word: the pass fails, no row stored) |
| **I4** | The chain reader's pure tests ran in no CI lane, and the event-list test needed a local `forge build` of `contracts/next` (not built in CI) and failed whenever `out/` was rebuilt from other work. | `test(/^chain_reader::/)` is in the relay's infra-free lane of `just test-unit`, and a `chain_reader::` step is in `scripts/run-tests.sh`; the Postgres tests are `#[ignore]`d and named `*postgres_tests` so the PostgreSQL lane's `postgres_tests::` filter runs them. The event-list test now compares the reader's list with `testdata/next-events.json`, recorded from the `contracts/next` build by `node scripts/chain-reader-events.mjs` (`--check` compares the file with a fresh build). | `events_tests::the_catalog_matches_every_recorded_event` runs with no build |
| Events committed meanwhile | The other run committed its contract work (`fb0f84d75`): `Launcher.EarlierBackersNamed`, `Launcher.ProjectZeroSplit` and `Treasury.TeamPaid` (the `EarlierBackersFunded` of the earlier failure no longer exists). | Added to the event list (68 events) and to the record: `earlierBackers` (the claim contract, from backing, from the founder, team budget), `treasury.teamPaid` and `treasury.teamBudgetLeft`; the claim contract is not listed as a holder (it holds Shares for the people on its list). | `events_tests::project_zero_split_and_team_pay_decode` (data from `cast abi-encode`, topics from `cast sig-event`), `numbers_tests::project_zero_split_and_team_pay` |

Left, and why:

- **F5, cost grows with history.** Every check of a project loads all its final logs, Shares Transfers included, and
  `final_projects` groups every stored log. This is a scale limit, not a wrong number, and the volume that would hurt
  (every pool swap emits a Transfer) arrives with the pool trades in part 2. The fix belongs there: per-account balances
  kept as ranges are committed (with block-numbered changes a rollback undoes), Transfers left out of `project_logs`, and a
  per-project newest-log block instead of the grouping. I1's fix already stops quiet projects being worked out every pass.
- **O1** (Council from `Treasury.PoolOpened`, while `stageOf` waits for `Finisher.Swept` to set Done), **O2** (`noMarketFrom`
  shown after an abandoned sale or while the auction runs): optional; they belong with the auction and pool events of
  part 2 and are noted there.
- **O3 / F6** (two relay replicas both signing; a record the store keeps as superseded still remembered as signed):
  optional; one reader per chain and Launcher is the supported setup, and the next event heals it. To do with part 2's
  helper, which needs one writer anyway.
- **F7** (a node behind the stored blocks read as a rollback): optional; the reader now reads two blocks or more below the
  head, which makes it rarer. The cost is re-reading recent ranges, never a wrong number.
- **F8** (the Uniswap PoolManager listed as a holder once the pool opens): optional; with the pool trades in part 2.
- **F9** (a panic in the reader task ends it while the relay keeps serving the last records): optional; the reader has no
  `unwrap` or `expect` in its paths. A restart wrapper and a "last good pass" health number are for part 2.

### Re-run after the fixes

- `cargo fmt --all -- --check`: clean. `cargo clippy -p buzz-relay --all-targets -- -D warnings`: clean.
- `cargo test -p buzz-relay --lib chain_reader`: 30 passed, 8 ignored (the Postgres tests).
- With a local Postgres (migrated to 65) and Redis,
  `cargo test -p buzz-relay --lib chain_reader -- --include-ignored --test-threads=1`: 38 passed, 0 failed.
- `node scripts/chain-reader-events.mjs --check` against a fresh `contracts/next` build: the recorded list matches
  (68 events; the earlier backers' claim contract's own events are not followed, since the reader does not read that
  contract).
- Each fix was undone on its own and the review tests run again: reading up to the head fails
  `a_log_index_behind_the_headers_loses_no_logs` (the ask in block 1 is lost); storing an undecodable known event fails
  `a_known_event_that_does_not_decode_stops_the_reader`; failing at the first too-many-logs refusal fails
  `a_range_with_too_many_logs_is_read_in_smaller_ranges`; not marking an unchanged record as checked fails
  `quiet_projects_do_not_starve_a_moving_one_of_its_refresh` (the moving project stays at block 3). The Team tests fail
  against the old "a Pair was ever made" rule by construction (they assert Backed and the 10,000 cap after the hand-over).
