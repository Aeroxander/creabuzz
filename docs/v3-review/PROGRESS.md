# Progress on the v3 review plan

Branch `v4-governance-rework`, local commits only. Decisions D1 to D10 are in [DECISIONS.md](DECISIONS.md). This file
says what is built, how it was checked, and what is not done, so nobody has to read the commit log to find out.

## Built and checked

| Piece | Where | How it was checked |
|---|---|---|
| Governor rework: movable Shares allocations, two lanes, hold time instead of conviction accrual, free opposition, DAO-held Shares outside voting supply and out of the ragequit denominator | `contracts/src/AllocationVoting.sol`, `majeur/MolochPatched.sol` | forge unit, invariant (256 runs) and journey tests; `scripts/simulate-voting-rules.mjs` with its pinned test |
| Safe summon defaults (the bricked web-summon DAO, F1) | `MolochPatched.sol` `init` | `SummonDefaults.t.sol` |
| One-transaction launch: DAO, vesting vaults, sale on the real CCA, raise paid to the DAO | `DaoLaunchKit.sol`, `ShareVesting.sol`, `GraduationExecutor.sol` | `DaoLaunchKit.t.sol`, `DaoLaunchJourney.t.sol`; browser e2e on a real local chain |
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
| New launches default to the project's own Shares where a kit exists; vouchers hidden beside a DAO's Shares | web launchpad | `launchpad.spec.ts` 28 passed (the default only flips in a build that names a kit; that flip itself has no browser test) |

## Differences from the plan

- **D2 (token architecture) was not spiked.** The launch sells the DAO's own Shares directly on the CCA. It does not
  wrap them in an apptoken, so there are no programmable transfer or fee hooks on them, and nothing here uses
  TokenMaster or LBAMM. The spike in `PLAN.md` §5 (can a DAO's Shares be an apptoken?) is still open.
- The curated bid-gate track is not supported in DAO mode (the panel says so).
- A launch record can launch once: the kit's addresses come from a per-launch salt, so relaunching after a failed raise
  needs a new record.
- The kit is deployed only on the local dev chain. No testnet deployment exists (that is a public action for you).

## Not started

- Web (and later desktop) screens for mandates, claims, attestation and awards (D9: CLI first).
- Social: merging Home and Social into one feed, one trust score service, prices and charts on the `$TICKER` chip,
  one-tap trade sheet. Home (launch discussion, vote-ranked) and Social (a timeline) read different data, so merging
  them is a product redesign rather than a refactor; I left it for you to decide.
- Ponder indexer for LBAMM prices and the auction; the cashtag registry rules (D5).
- Doc updates (`docs/dao-os.md`, `contracts/README.md`), the agent review pass, and your own test run. The
  `buzz-review-completed` marker is yours to add.

## Known open issues

- The founder's vested Shares dilute what backers can leave with. The launch panel now says by how much; the exit
  screens elsewhere do not yet.
- An unopposed holder above quorum can pass an action; review time, hold time, the execution delay and ragequit are the
  protection.
- The sell-rate gate is advisory (F8) and the TokenMaster reserve is not a price floor (see `PLAN.md` §3); both are unchanged.
- Pre-existing failures: `feed.spec.ts` "posts are only copied to public relays when the author opts in", and the web
  file-size ratchet on `WikiView.tsx`.
