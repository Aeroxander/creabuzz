## Summary

Implements the v5 governance and agreed-rewards work: contributors accept an exact,
capped Share reward before starting work, an independent panel reviews the
submission, and settlement pays exactly that amount — with no award vote and no
discretionary step. Secondary trading ships built and **off by default**, with a
separate market per DAO and a founder sale schedule.

The branch is 64 commits on `8fecc3258` (the tip of `v4-governance-rework`, which this PR is based on), all DCO signed.

### What is in it

**Agreed rewards (the primary flow).** A work area's manager proposes an exact
Share quantity with the work's own criteria words; the named beneficiary accepts
those exact terms (the reservation lands); they submit once; two reviewers
approve; finishing the review opens a challenge window; after it, anyone settles
and the chain mints exactly the agreed amount. `agreementOfClaim` binds the claim
so the discretionary award path cannot touch it. Legacy `ContributorKit`
deployments keep their old behaviour exactly.

**Secondary market, off by default.** One market per DAO, created by the
factory with bytecode-pinned provenance. A DAO must publish a listing before any
round can open, and the founder's schedule must have released units before
anything is sellable. Shares stay transfer-locked at birth with the market as the
only exempt path.

**Activation and maturity.** Voting weight is a frozen pair: ownership at
`B-1` plus a maturity cutoff fixed when the proposal opens, used for both voter
weight and the quorum denominator.

**Trading in the app, still off by default.** A Trading card on the Funds tab (open the week's round, offer, bid, take an
order back, settle, collect), a listing form that publishes through a DAO vote, and a reader that never turns a failed
read into "this DAO has no market". Prices use the market's own quote token decimals and symbol. The card re-reads every
30 seconds while a round is live and tells an order-holder that anyone can settle it and by when. A hosted build shows
"Trading isn't set up on this network" unless it names a market factory. `scripts/secondary-keeper.sh` settles closed
rounds (and, only when told to, opens the week's) for the hours nobody is looking.

**Tooling.** A local fixture that deploys the creation version as real
transactions and reads every binding back from node state; an agreement
finalizer that settles on a real chain; an artifact check runner that executes
declared checks inside an enforced Docker sandbox with a trusted PID-1
supervisor.

### Testing

Verified locally, each by its own command and exit status:

| Gate | Result |
|---|---|
| `forge test --offline --root contracts` | **742 passed, 0 failed, 2 skipped** (71 suites) |
| `cargo test --workspace --exclude buzz-voice` | **6783 passed, 13 failed, 1384 ignored** — all 13 proven pre-existing at base `8fecc3258` |
| `just clippy-offline` | exit 0 (whole workspace, including `buzz-voice`) |
| `pnpm -C web test` | **2598 passed, 0 failed** |
| `just web-check`, `fmt-check`, `file-size-check`, `majeur-fork-check` | all exit 0 |

Eleven browser or script journeys pass against a real local chain or relay:
`web-challenge-e2e`, `web-record-e2e`, `web-post-bounty-e2e`,
`web-milestone-e2e`, `web-dao-journey-e2e`, `web-rounds-e2e`,
`shares-erc20c-e2e`, `web-self-serve-e2e`, `web-economy-e2e`,
`web-dao-launch-e2e` (9/9 tests), plus `web-trading-e2e` (one full trading round in the app) and
`secondary-keeper-e2e` (the keeper through a round's whole life).

The app-driven agreed-reward journey settles with `terminalKind = 1`, the claim
`Paid`, exactly `7e18` Shares minted, `agreementOfClaim` unchanged, and four
distinct screenshots.

`web-sepolia-fork-e2e` could not run here: it needs a Sepolia RPC and this host
has no DNS.

### Review of the market

A separate agent pass (not an outside human audit, which is still outstanding) read `SecondaryMarket.sol` and `SecondaryMarketFactory.sol`
in full and found three real defects, all now fixed with regression tests that
fail when each fix is reverted:

- **F1 (medium)** `claimQuote` marked a seller's order paid before settlement, so
  anyone could burn a seller's proceeds permanently.
- **F2 (low)** order removal swapped the last entry in, so leftover lots did not
  follow the lowest order id as documented.
- **F3 (medium–high)** a DAO-chosen Shares transfer validator could freeze
  escrowed Shares, blocking `cancelSell`, the unsold-lot return and void-round
  claims.

`SecondaryListingVote.t.sol` also publishes a listing through a real DAO vote (open, vote, review, delay, execute)
instead of pranking the DAO as the other tests do; the browser journey still impersonates the DAO for that step.

The review packet is `docs/v3-review/SECONDARY-TRADING-REVIEW.md`, including the
seven open questions and what the tests do **not** cover.

### Related issue

N/A — no matching issue found.

### Testing (human)

Agent-run evidence only. The author waived a personal walkthrough of the
agreed-reward flow. Trading has **no outside security audit or legal view yet**
and the software does not check for either: trading is off by default because a
listing starts disabled and no hosted build names a market factory, and the
review and legal view are release gates owned by people. The market review above
was an agent pass; the author should say here if a human reviewed it. A production build of the hosted image
(social app only) was run locally and loads; the contributor build against Sepolia
has not been run.

### Checklist

- [x] `buzz-review-completed` is **not** claimed: the human testing step above has
      not happened, so this stays a draft until it does.
- [ ] Desktop and mobile are untouched by design; CI is the only place their
      checks run for this branch.
