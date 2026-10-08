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

- Web composer for the DAO's own votes (a new work budget, a project, an award) and for claims that ask for money
  (they need a currency approval): both stay on the command line. Desktop parity (D9).
- Social: merging Home and Social into one feed, one trust score service, prices and charts on the `$TICKER` chip,
  one-tap trade sheet. Home (launch discussion, vote-ranked) and Social (a timeline) read different data, so merging
  them is a product redesign rather than a refactor; I left it for you to decide.
- Ponder indexer for LBAMM prices and the auction; the cashtag registry rules (D5).
- Doc updates (`docs/dao-os.md`), the agent review pass, and your own test run. The `buzz-review-completed` marker
  is yours to add.
- A graduation step into an LBAMM pool (create the pool at the clearing price, seed it, set the token hook and the
  transfer ruleset). It needs a local LBAMM deployment, which needs further repositories downloaded: your yes first.

## Known open issues

- The recovery path that finds a launch again from the chain reads the kit's log from block 0. A public RPC that
  refuses a range that wide makes it fail with a retryable error rather than a wrong answer; it should start from the
  sale's start block.
- The Work tab reads whole-history logs the same way, bounded in count (8 budgets, 50 projects, 100 claims) but not in
  block range.

- **The founder's locked Shares vote from day one.** At a 20% sale / 20% team split the founder holds all of the voting
  supply until the sale ends, and then about half of it. That is what "founders vote but cannot sell" means, and it is
  the point to decide on: the alternative is for locked Shares not to vote until they unlock. The launch panel says
  how much is locked; the exit screens elsewhere do not yet.
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
