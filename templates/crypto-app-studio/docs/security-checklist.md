# Security Checklist

@The Security Reviewer's standing floor. Work this list on every change that touches value, permissions, or state transitions — and add a line here when this project discovers a new class of failure it should never ship twice.

For each item: **finding / pass / not applicable**, with the line or call path that justifies it. "Pass" without a reason is not a pass.

## Access control

- [ ] Every state-changing entry point names who may call it, and the check is *inside* the function, not in the UI.
- [ ] Owner/admin powers are enumerated in the Protocol Bible — nothing grants a power the bible doesn't list.
- [ ] Init/setup functions cannot be re-run to re-grant or re-initialize.
- [ ] Renounce/transfer ownership paths behave when called twice or by the wrong party.

## Value flow and math

- [ ] Value in equals value out; rounding direction is decided and tested (who absorbs the dust?).
- [ ] Supply/balance invariants hold under adversarial input — fuzz the math, don't eyeball it.
- [ ] Decimals handled from the token, never hard-coded.
- [ ] Non-standard tokens tolerated (no-bool-return transfers, fee-on-transfer, rebasing).
- [ ] No path mints, burns, or transfers without a matching accounting entry.

## External calls and reentrancy

- [ ] State is written before external calls, or access is guarded (checks-effects-interactions).
- [ ] Reentrancy tested on every function that calls out and still moves value.
- [ ] Failed calls revert or are handled — no silently skipped work.
- [ ] External protocol assumptions are fork-tested, or explicitly marked unverified here.

## Oracles and market data

- [ ] Spot DEX price is never used as an oracle.
- [ ] Oracle freshness and deviation bounds are specified and enforced.
- [ ] What happens if the oracle stops updating, returns zero, or returns stale data?

## Signatures and replay

- [ ] Nonces and deadlines enforced; a signature cannot be replayed across chains, contracts, or versions.
- [ ] Signer is verified against the intended key, not a value the caller supplies.
- [ ] Digest construction cannot be confused with another message type.

## Ordering and MEV

- [ ] Sandwichable operations have slippage limits or user-set bounds.
- [ ] Ordering assumptions (block number, timestamp, tx ordering) are documented and justified.
- [ ] No user-visible action where a griefer profits at the user's expense.

## Proxies and upgrades

- [ ] Which pattern, who can upgrade, and what storage layout guarantees exist.
- [ ] No storage collision risk; initialize-cannot-be-re-run.
- [ ] Upgrade cannot silently change an invariant listed in the Protocol Bible.

## Denial of service and griefing

- [ ] Unbounded loops over user-supplied or unbounded collections.
- [ ] Anyone-triggerable operations cannot brick a state machine others depend on.
- [ ] Pausing stops the danger without trapping user funds.

## Consistency

- [ ] Events match state; an off-chain reader reconstructing from logs reaches the same truth.
- [ ] Frontend reads the same contract the backend writes (Protocol Bible registry).
- [ ] Every Protocol Bible invariant has a failing-when-broken test.

## Severity

- **High**: reachable now, funds or permissions lost, or an invariant broken.
- **Medium**: reachable under stated assumptions, limited loss or DoS.
- **Low**: real but hard to reach, or no loss — still recorded.

A finding with an open high severity blocks approval. Anything you could not verify (no fork test, no simulation) is recorded as *unverified*, not as a pass.
