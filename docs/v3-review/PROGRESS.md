# Progress on the v3 review plan

Branch `v4-governance-rework`, local commits only. Decisions D1 to D10 are in [DECISIONS.md](DECISIONS.md). This file
says what is built, how it was checked, and what is not done, so nobody has to read the commit log to find out.

## Built and checked

| Piece | Where | How it was checked |
|---|---|---|
| Governor rework: movable Shares allocations, two lanes, hold time instead of conviction accrual, free opposition, DAO-held Shares outside voting supply and out of the ragequit denominator | `contracts/src/AllocationVoting.sol`, `majeur/MolochPatched.sol` | forge unit, invariant (256 runs) and journey tests; `scripts/simulate-voting-rules.mjs` with its pinned test |
| Safe summon defaults (the bricked web-summon DAO, F1) | `MolochPatched.sol` `init` | `SummonDefaults.t.sol` |
| One-transaction launch: the DAO, the team's Shares minted to the team and locked behind milestones, the sale on the real CCA, the raise paid to the DAO | `DaoLaunchKit.sol`, `MilestoneLock.sol`, `GraduationExecutor.sol` | `DaoLaunchKit.t.sol`, `DaoLaunchJourney.t.sol`; browser e2e on a real local chain (the founder holds the team Shares, the lock reports them locked, a transfer is refused) |
| Web launch: wizard option, Manage-panel launch, resume after failure or reload, recovery from the chain when a browser lost the hash | `packages/creaton-core/.../daoLaunch*.ts`, `web/.../DaoLaunchPanel.tsx` | 22 unit tests; `scripts/web-dao-launch-e2e.sh` (6 browser tests, including a full raise: bid, end, graduate, raise lands in the DAO) |
| Equity-only work: a mandate may carry a share budget and no money; zero-currency claims; awards are bounded by the project's share allowance and use the bounded lane | `TreasuryMandate.sol`, `ClaimStake.sol`, `AllocationVoting.boundedAction` | `EquityMandate.t.sol` (7 tests); full forge suite 311 passed |
| Dev chain deploys the launch kit | `scripts/dev-chain.sh` | `scripts/dev-chain.test.mjs`; run for real three times |
| Whole-number vote and trust-tier display (no more "0.2") | `web/src/features/feed/*` | web unit tests and `feed.spec.ts` |

## Also built and checked

| Piece | Where | How it was checked |
|---|---|---|
| CLI front doors for the contributor path: `buzz launchpad work mandate/project/award` (compose the votes), `claim/check/bind/attest/settle/payout` (send), `state` (read), plus the missing `queue` | `crates/buzz-cli/src/commands/launchpad_work.rs`, `launchpad_gov.rs` | 12 unit tests with calldata pinned to `cast`; `scripts/cli-no-raise-e2e.sh` runs the whole no-raise journey with the CLI alone against a real local chain (mandate, project, claim, recusal, challenge window, payout, over-budget award refused, award, 25 Shares held) |
| A higher, still bounded gas cap for executing a proposal (a mandate deploys three contracts) | `buzz-evm-allowance` `with_gas_cap`, ceiling 8M | unit test: refused by default, allowed when raised, never past the ceiling |
| `$TICKER` cashtags link to the launch that owns the ticker | `web/src/features/social` | tokenizer and ownership unit tests; `social-cashtag.spec.ts` |
| New launches default to the project's own Shares where a kit exists; vouchers hidden beside a DAO's Shares | web launchpad | `launchpad.spec.ts` 28 passed; two browser tests in `launchpad-dao-launch.spec.ts` (the default, and a wizard-made launch launching with the wizard's allocation on chain) |
| A **Work** tab: a DAO's work budgets, projects and claims read from the chain; file a claim for recognition, take a claim on, review, finish, take the payout, each from the person's own wallet | `web/src/features/launchpad/ui/WorkTab.tsx`, `FileClaimCard.tsx`, core `work.ts` / `workRead.ts` | 12 core unit tests (calldata and events pinned to `cast`, a fake-chain reader); `scripts/web-work-e2e.sh` runs the whole path in a browser against a real local chain (found and fixed a hook-order crash in the launch page) |
| A closed mandate awards no more Shares; a manager binds only the claim of the contributor they name (the contract refuses a claim someone else filed under the id) | `TreasuryMandate.sol` | `EquityMandate.t.sol` (9 tests); full forge suite 313 passed |

## Shares as an apptoken, and the milestone lock: built and checked

The DAO's Shares implement the ERC-20C interface, and a lock on a holder's Shares stops both selling and ragequit
without touching the governor. See `docs/token-voting-design.md` ("Shares as an apptoken") and
`SharesCreatorToken.t.sol` (13 tests), plus `scripts/shares-erc20c-e2e.sh` against the real validator.

On top of that, **founders hold and vote with their Shares from the first block, and a milestone unlocks a part**:

| Piece | Where | How it was checked |
|---|---|---|
| The lock (`lockedOf`, `unlock`, `forfeit`) and the soulbound `MilestoneBadge` receipt; a milestone is a reviewed claim in a work budget the DAO created, filed against exactly the milestone's words | `MilestoneLock.sol`, `MilestoneBadge.sol` | `MilestoneLock.t.sol` (10 tests); `DaoLaunchKit.t.sol` (the kit names the lock before the DAO exists and fails closed if it guessed wrong); full forge suite |
| Client: plan, calldata, event, receipt and panel text for a launch with milestones; read a holder's lock and the claims that can unlock it; `buzz launchpad work locks` / `work unlock` | core `daoLaunch.ts`, `milestoneLock.ts`; `launchpad_work.rs` | core tests with calldata pinned to `cast`; 17 CLI unit tests; both clients hash a milestone's words the same way (trimmed) |
| Work tab card "Your team Shares": what is locked, each milestone with its words, an Unlock button once the approved claim exists; nothing is shown to a wallet with nothing locked | `LockedSharesCard.tsx` | `scripts/web-milestone-e2e.sh` (browser, real chain) |
| The whole path on a real chain: launch through the kit, the founder voting alone with locked Shares, a transfer and a ragequit refused, a reviewed claim, a stranger sending the unlock, exactly the freed part moving and being ragequittable (the same call the lock had refused), the badge soulbound | `scripts/cli-milestone-e2e.sh` | runs green |

## Shares on a market, and prices from it: built and checked (local evaluation only)

LBAMM is evaluation-only, so all of this runs on a throwaway local chain with LBAMM cloned outside the repo
(`LBAMM_DIR`; see [LBAMM.md](LBAMM.md)).

| Piece | Where | How it was checked |
|---|---|---|
| A local LBAMM next to our contracts | `scripts/lib/lbamm-world.sh`, `lbamm-replay.mjs` | deploys on the dev chain; used by every script below |
| The DAO's vote that puts its Shares on the AMM (hook, fee, one-sided pool seeded with Shares); `market swap`; `market collect-fees` | `crates/buzz-cli/src/commands/launchpad_market.rs` | 12 unit tests with every call pinned to `cast calldata`; tick math checked against the contract's own values; `scripts/cli-market-e2e.sh` on a real chain (the vote, a buyer, a locked founder refused while a free holder sells with the same command, the fee reaches the treasury by a second vote) |
| A larger gas cap for opening a proposal, growing with the action's size and bounded | `launchpad_gov.rs` | unit test; needed because a six-call batch is bigger than the old flat cap |
| Price candles from the AMM's trades | `services/price-indexer` (Ponder) | 6 unit tests; `scripts/market-index-e2e.sh` (trades before and after it starts, the pool, candle prices, bad requests) |
| The launch page charts traded prices and a `$TICKER` chip shows the last trade, each labelled as what it is | `marketFeed.ts` (core), `use-market.ts`, `PriceChartCard.tsx`, `cashtag.ts` | 7 core and 4 web unit tests; `scripts/web-market-e2e.sh` (browser, real chain, real indexer); the 29 mocked specs that show bid prices still pass |

## Everything a person does is in the app, not the command line: built and checked

You said nobody will vote or set up decisions through a command line, so every step a person takes now has a page. Each
journey below runs in a real browser against a real local chain, each step as the wallet of the person whose job it is.

| What a person does | Where | Checked by |
|---|---|---|
| Launch a project into its own DAO, locking the team's Shares behind milestones | Manage tab / wizard | `scripts/web-dao-launch-e2e.sh` |
| See every decision the DAO has put to a vote, read from the chain (whoever opened it), with what it would do in plain words, where it stands, who backs it and the rules it must meet | **Decisions** tab | `scripts/web-decisions-e2e.sh` |
| Back, oppose or take back a vote; start the wait; run a decision | Decisions tab | same |
| **Put something to a vote** from a form: a work budget (Shares and/or money), a project, an award of Shares for a claim, putting Shares on the market, collecting the trading fees, paying from the treasury | Decisions tab, "New decision" | `scripts/web-dao-journey-e2e.sh`, `web-paid-work-e2e.sh`, `web-market-journey-e2e.sh` |
| File a claim for work, optionally asking to be paid with a deposit; the manager takes it on; reviewers approve; finish it; take the payout | Work tab | `web-work-e2e.sh`, `web-paid-work-e2e.sh` |
| Unlock a founder's locked Shares by milestone | Work tab | `web-milestone-e2e.sh` |
| Buy and sell the Shares on their market; a founder with locked Shares is told how many they may sell | Launch page, trade card | `web-market-journey-e2e.sh` |
| See the traded price on the chart and next to a `$TICKER` | Launch page, posts | `web-market-e2e.sh` |

How it holds up: the app only describes a decision as (say) a market, a work budget or a payment if its calls are aimed where a
real one's are (the DAO, its factory, its work budgets, its exchange) and a batch's approvals are exactly the budget's;
anything else is described as the steps it is, or as unknown, so a voter is never told more than the calls do. A decision
opened without its details says so and warns that nobody can tell what backing it would approve. The command line still
exists, for agents.

Not in a form yet (still the command line): changing the DAO's voting rules, who may open a decision, turning exit on or
off, closing a work budget, releasing a departed founder's locked Shares (a DAO-only power), a whitelist-only trading rule,
and anything custom. Desktop and mobile have none of the new pages.

## Differences from the plan

- **D2 (token architecture) was partly spiked.** The launch still sells the DAO's own Shares directly on the CCA, and
  nothing uses TokenMaster or LBAMM. But Shares now carry the apptoken (ERC-20C) interface and a lock guard, verified
  against the real transfer validator (above). The market venue (LBAMM, with Shares as the apptoken) is not
  integrated; what was read of it, and what it would take, is in [LBAMM.md](LBAMM.md).
- The curated bid-gate track is not supported in DAO mode (the panel says so).
- A launch record can launch once: the kit's addresses come from a per-launch salt, so relaunching after a failed raise
  needs a new record.
- The kit is deployed only on the local dev chain. No testnet deployment exists (that is a public action for you).

## Not started

- The decision forms for the rarer powers listed above, and desktop and mobile parity (D9).
- Social: merging Home and Social into one feed and one trust score service: **left alone for now, as you said**
  (Home reads launch discussion ranked by votes and Social reads a timeline, so merging them is a product redesign).
  A one-tap trade sheet on the `$TICKER` chip is not started either; the chip links to the launch, and the trade itself is
  `buzz launchpad market swap`.
- The cashtag registry rules (D5), and an indexer for the auction itself (the sale's bids come from the relay today).
- Doc updates (`docs/dao-os.md`), the agent review pass, and your own test run. The `buzz-review-completed` marker
  is yours to add.
- Whitelist-only trading of the Shares through LBAMM (a two-vote sequence: the list's id is only known after it exists),
  and reading the sale's clearing price into the market vote.

## Known open issues

- The recovery path that finds a launch again from the chain reads the kit's log from block 0. A public RPC that
  refuses a range that wide makes it fail with a retryable error rather than a wrong answer; it should start from the
  sale's start block.
- The Work tab reads whole-history logs the same way, bounded in count (8 budgets, 50 projects, 100 claims) but not in
  block range.

- **The founder's locked Shares vote from day one** (decided, D13). At a 20% sale / 20% team split the founder holds all
  of the voting supply until the sale ends, and then about half of it. The protections for everyone else are review
  time, hold time, the execution delay and exit rights. The launch panel says how much is locked; the exit screens
  elsewhere do not yet.
- A milestone is judged by a **project** whose acceptance check is the milestone's exact words, so each milestone
  needs a project the DAO votes in (the claim's check has to equal the project's to be bound). The Work tab says to
  file the claim "with these exact words"; it cannot yet create the project.
- The wizard's unlock step now says what happens for a launch into its own DAO (the reviewers of a work budget judge a
  milestone by its words, not the founder), and a "short vesting by time" plan is refused there with a plain reason.
  The unlock step of the old token-mint flow is unchanged.
- The DAO cannot burn or move a locked founder's Shares (a governance removal) until it calls `forfeit` for them first;
  that is deliberate, and `forfeit` is a DAO-only call.
- `ShareVesting.sol` is no longer used by the launch kit. It is kept as a standalone schedule; remove it if nobody
  wants plain time vesting.
- An unopposed holder above quorum can pass an action; review time, hold time, the execution delay and ragequit are the
  protection.
- The sell-rate gate is advisory (F8) and the TokenMaster reserve is not a price floor (see `PLAN.md` §3); both are unchanged.
- Pre-existing failures, checked by running the same specs on the commit before this work (they fail identically
  there): 13 of the 204 mocked browser specs (`feed.spec.ts` "posts are only copied to public relays…", six
  wiki/multi-user specs, and five in `smoke.spec.ts` such as "home page loads with Creaton branding"), and the web
  file-size ratchet on `WikiView.tsx`. The other 176 pass, 15 are skipped (they need a local chain).
