# Contract audit readiness — starting package

Status: 30 Sep 2026. This document hands an external auditor the launchpad
contract surface without a walkthrough. The launchpad stays **testnet-only**
until an audit and a legal posture for the token sale exist (the standing
rule in `docs/dao-os.md`).

## Surface under audit

All under `contracts/src/`, Solidity `^0.8.24`, compiled and pinned to
`solc 0.8.26` for `GraduationExecutor` and `AllowlistHook` (reproducible
embedded bytecode — `foundry.toml` `compilation_restrictions`).

| Contract | Role | Value at risk |
|---|---|---|
| `GraduationExecutor` | One-shot auction graduation: sweeps the raise, splits reserve/treasury, escrows the reserve until a TokenMaster pool is recorded | The full raise + unsold supply |
| `ClaimStake` | Milestone claims with staked submissions, verifier quorums, slashing, frozen-claim resolution | Staked funds + claim payouts |
| `OrgAllowance` | Allowance ledger enforcing spend ceilings per subject (`spendTo` with `transferFrom(treasury, …)`) | Treasury spending authority |
| `OrgBinding` | Summons a majeur/Moloch DAO bound to an org root; records existing DAO bindings | Governance control of the treasury |
| `VerifierSet`, `CCA`, `AllowlistHook`, `TrustGatedHook`, `AppToken` | Verifier quorums, vendored CCA interfaces, bid gating | Config/authority surfaces |

External dependency: the **majeur** library (Moloch DAO, `SafeSummoner`) and
the vendored **continuous-clearing-auction** (CCA) — audited separately; this
audit covers the integration assumptions listed below.

## Trust assumptions (accepted, documented)

1. **Push payouts.** A treasury that cannot receive ETH makes an ETH
   graduation revert atomically; the raise stays in the auction until it can.
   Payouts are amount-exact — force-sent ETH/ERC-20 is unrecoverable.
2. **One auction per executor.** `bindAuction` is one-shot and
   treasury-only; every entry point refuses any other address. A fake auction
   cannot drain the reserve (regression-tested).
3. **Reserve lock.** The reserve is committed to the recorded pool; only the
   treasury can `releaseReserve` (once, to the recorded pool) or
   `withdrawStuckReserve` (only after `reserveLockSeconds`, only while no
   pool was recorded).
4. **`bindDao` is a first-writer recorder.** The first binder of an unbound
   root wins permanently (griefing: a squatter can block a legitimate bind;
   they cannot alter an existing binding). Treated as a known design limit.
5. **Reentrancy.** `GraduationExecutor` writes all state before payouts and
   carries a reentrancy latch over the sweep window; `ClaimStake` records
   before pulling stake. Both are regression-tested with callback mocks.
6. **Governance defaults.** `OrgBinding.summonAndBind` enforces
   production-safe governance at summon (`NonProductionGovernance`): nonzero
   proposal threshold, TTL > timelock > 0 (summonFast preset: 1% threshold,
   3-day TTL, 1-day timelock), and reverts `GovernanceNotApplied` if the
   configured implementation does not apply them.

## Invariants the tests pin (each fails if its guard is removed)

- Graduation runs exactly once; a token-callback reentry cannot double-pay
  (`test_token_callback_reentry_cannot_double_run_graduation`, mutation-checked).
- A reverting `balanceOf` cannot burn the one-shot recovery flag
  (`test_reverting_balance_of_cannot_burn_the_recovery_flag`).
- The split equals the balance actually received (fee-on-transfer safe) and
  stray balances are never swept
  (`test_fee_on_transfer_split_matches_what_was_received`).
- Strangers cannot inject native currency; fake auctions cannot drain;
  only the treasury binds and releases (`OrgBinding.t.sol`, `GraduationExecutor.t.sol`).
- A reentrant same-id claim submit cannot orphan a stake
  (`test_reentrant_same_id_submit_cannot_orphan_the_stake`, mutation-checked).
- Every suite green: **16 suites, 191 tests, 0 failures** (`forge test`),
  mirrored in CI (`_ci-contracts.yml`, including the bytecode-embed drift gate
  `REQUIRE_CONTRACT_ARTIFACTS=1` — a stale embed cannot ship).

## Residual risks (out of scope or accepted)

- **Review-window truncation** in the relay's budget review tally
  (`LIMIT 5000/2000` newest-first) can undercount rejections at scale —
  documented, deferred.
- **DAO summon defaults** are enforced at the wrapper; a DAO summoned outside
  `OrgBinding` carries whatever its summoner configured.
- Hand-rolled EVM encoding in the Rust auth/allowance clients is pinned by
  golden vectors, not by a standard library (decision documented in the plan).
- Mainnet deployment additionally requires the legal posture for the token
  sale — a non-code gate.

## How to verify claims here

```
git submodule update --init --recursive
node scripts/check-foundry-lock.mjs
cd contracts && FOUNDRY_LINT_LINT_ON_BUILD=false forge test
```

The whole-loop acceptance run (`scripts/loop-test.sh`, 31 checks against a
live relay) and the real-chain browser suite (`scripts/web-auction-e2e.sh`,
6 journeys including ETH and USDC graduation) are the behavioral evidence.
