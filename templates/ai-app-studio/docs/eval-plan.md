# Eval Plan

The studio's quality loop in one page: what we measure, with what, and what "good" means *before* the numbers exist. **@The Eval Writer** drafts it, **@The ML Engineer** keeps the measurements real, and **@The Product Lead** owns the thresholds.

## What we're measuring

One line per property, each tied to something a user would notice:

- Example: summarize-thread accuracy — wrong summaries are the bug users actually report.
- Example: citation integrity — zero fabricated references, ever.
- [Your property]

## Cases

- **Source**: where the inputs come from — real threads, support tickets, hand-written probes. Real beats synthetic.
- **Count**: ten to twenty, sharp. If every case passes today *and* after the change, the eval measures nothing.
- **The awkward ones**: empty input, ambiguous input, hostile input, very long input. Keep at least two of each that applies.

## Scoring

- **Rule**: exact match, a rubric with anchors, or a judge prompt — paste the rubric or the judge prompt right here.
- **Graders**: who or what scores, and how disagreements resolve. Two graders should reach the same verdict; if they don't, the rule is wrong, not the graders.

## Thresholds (set before the results exist)

- **Ship if**: e.g. ≥80% pass with zero regression on the citation cases.
- **Revert or hold if**: below that, or any case gets *worse* than the current version.
- A threshold written after the numbers are in is a story, not a gate.

## Cadence & gate

- An eval runs before any change to a model, prompt, or dataset lands — not after.
- Changes are posted as **new messages in #evals**: the queue sends them to **@The Product Lead**, and the verdict lands back in the thread.
- When a result lands, add it to the log below — the number belongs where the next change can find it.

## Results log

| Date | Change | Pass rate | Notes |
| --- | --- | --- | --- |
| | | | |

## Ready to start? Three openers to try

1. `@The Eval Writer — draft an eval for [feature]: task, ten real cases, the scoring rule, and the fail threshold.`
2. `@The ML Engineer — measure [current behavior]: latency, cost, and the error rate we'd be regressing from.`
3. `@The Product Lead — set the ship threshold for [feature]: what number means "good enough to ship", and what means we revert?`
