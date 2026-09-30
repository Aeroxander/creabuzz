# `_unconverted` — paper strategies held back from the kind:44020 banks

Holding pen for strategies from *Self-Organizing Agent Teams Learn to Reason
Together* (arXiv [2609.22682](https://arxiv.org/html/2609.22682v1),
Appendix A) that could not be transcribed faithfully into the product's
strategy schema. The rule for this directory: **a strategy that violates a
product bound is filed here with a note — never silently trimmed to fit.**

## Status: 0 strategies held back for bound violations

All 20 Appendix A strategies (10 in A.1 AIME-2024, 10 in A.2 GPQA-Diamond)
converted cleanly. Product bounds (`TeamStrategy::validate`,
`crates/buzz-cli/src/commands/team_run.rs`) vs. the observed maxima across
the 20 converted files:

| Field | Product bound | Observed max |
|---|---|---|
| roles | 1..=6 slots | 3 |
| phases (`steps`) | 1..=6 | 5 (`option_conditions_and_absence_audit`, `provisional_consensus_cross_validation`) |
| rounds per phase | 1..=4 | 1 |
| participants per phase | 1..=6 | 3 |
| name | ≤128 chars | 39 |
| description | ≤1024 chars | 223 |
| teamworkPrompt | ≤8192 chars | 505 |
| role prompt | ≤4096 chars | 598 |
| step prompt | ≤4096 chars | 823 |
| per-agent prompt | ≤4096 chars | 102 |

Every converted file passes the product's own strict validator; the table
test in `team_run.rs` (`bank_files_validate_strictly`) re-checks all 20 files
on every `cargo test -p buzz-cli`, so a future bound tightening fails loudly
here instead of silently.

## Not converted (deliberately out of scope, not bound violations)

Appendix A's Figure 8 documents two further strategies from earlier searches.
The paper states both were "not selected for either final bank and were not
used in reported deployment", so neither belongs to the *deployed* banks this
directory ports:

- `forced_role_reversal` — Figure 8(a): blind vote, temporary advocacy for an
  answer other than one's own, cross-examination, re-vote.
- `overlapping_pairwise_verification` — Figure 8(b): overlapping member-pair
  verification with a full-team re-solve on a detected flaw.

They are listed in `strategies/index.json` under `excluded` with the same
reason. If a future slice wants them, transcribe them into this directory as
full strategy files with `_source` provenance — do not improvise them from the
caption alone.
