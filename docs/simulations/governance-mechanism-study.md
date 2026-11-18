# Governance mechanism study

> **Superseded 2026-10-08.** The voting rule this document describes (accruing conviction against bars set as a
> fraction of all Shares) was replaced after review: see [the current design](../token-voting-design.md), [the voting-rules
> study](voting-v2-study.md) and [the review](../v3-review/PLAN.md). Kept as the record of why.

Run: `. ./bin/activate-hermit; node scripts/simulate-dao-governance.mjs`.
Seed: 20261008. This models governance incentives; local-EVM journeys separately verify implementation.

## Observations and refinements

The conserved-credit minority wins the depleted-majority example. A current-support floor prevents that outcome without charging participation. Withdrawal removes conviction immediately and new allocations start at zero. A pre-approved mandate bounds the total funds a lower-support project vote can expose.

For stable support, the minimum 48-hour review dominates every tested half-life. A shorter half-life helps newly arriving support after that review; it cannot repair insufficient participation. The majority requirement deliberately causes low-turnout unrestricted proposals to fail. Delegation and better notices may help participation; they do not prove independent representation or honest votes.

A 12-hour half-life with 48-hour review for unrestricted actions and 24-hour review for bounded projects is the candidate to validate on the actual governor. This is a safety/latency choice, not an empirical claim of optimal governance.

## A late majority and the opposition refinement

An earlier candidate required matured FOR to exceed matured AGAINST. A new 50.1% majority facing 49.9% opposition that had accumulated for 48 hours needed 95 more hours with a 12-hour half-life. Current opposition plus the FOR conviction floor needs 12 hours. We removed the matured-opposition veto: AGAINST counts immediately in current backing, while FOR must accumulate the captured conviction floor. This avoids historical opposition entrenchment. The execution delay is still additional.

| Half-life hours | Former matured-opposition gate | Refined approval hours after change |
| --- | --- | --- |
| 6 | 48 | 6 |
| 12 | 95 | 12 |
| 24 | 182 | 24 |
| 48 | 335 | 48 |

## Participation and half-life sweep

| Participation probability | Half-life hours | Approved / 1000 | Median approval hours |
| --- | --- | --- | --- |
| 0.3 | 6 | 24 | 48 |
| 0.3 | 12 | 31 | 48 |
| 0.3 | 24 | 24 | 48 |
| 0.3 | 48 | 28 | 48 |
| 0.5 | 6 | 240 | 48 |
| 0.5 | 12 | 231 | 48 |
| 0.5 | 24 | 243 | 48 |
| 0.5 | 48 | 221 | 48 |
| 0.7 | 6 | 644 | 48 |
| 0.7 | 12 | 638 | 48 |
| 0.7 | 24 | 613 | 48 |
| 0.7 | 48 | 620 | 48 |
| 0.9 | 6 | 920 | 48 |
| 0.9 | 12 | 926 | 48 |
| 0.9 | 24 | 939 | 48 |
| 0.9 | 48 | 940 | 48 |

All approval times exclude the additional execution delay. Economic self-dealing by a governing majority and collusion among delivery reviewers remain possible. Outcomes are contingent on the stated participant behavior, not evidence about real users.
