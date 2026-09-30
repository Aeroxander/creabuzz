---
name: eval-craft
description: Write falsifiable evals — task, cases, scoring rule, and a fail threshold defined before the change, so "better" is recognizable by anyone.
---

# Eval Craft

An eval is a promise about how you will recognize success. Write it before the change, not after — a threshold chosen once the results exist is a story, not a gate.

## The four parts

1. **Task** — one sentence: input → output, for whom. If the task needs a paragraph, it is two evals.
2. **Cases** — ten to twenty real inputs, the awkward ones included (empty, ambiguous, hostile, long). A case that cannot fail is not a case.
3. **Scoring rule** — exact match, a rubric with anchors, or a judge prompt with fixed criteria. Write it so a stranger gets the same verdict; if two graders disagree, the rule is wrong, not the graders.
4. **Threshold** — the number that ships and the number that reverts, written down before any result exists.

## Falsifiability checks

Before you call it an eval, answer yes to all three:

- Could a specific, concrete result make it **fail**?
- Could someone who wasn't in the room **run it and reach the same verdict**?
- Would you know **what to revert** if it failed?

"Feels better", "more helpful", "higher quality" fail all three. Rewrite them as observable outcomes: what a reader sees, counts, or loses.

## Case design

- Pull inputs from real use — threads, tickets, probes the team wrote. Synthetic-easy cases flatter every version equally.
- Keep the suite small and sharp. Twelve honest cases beat a hundred vague ones, and a suite nobody runs is a document, not a guard.
- Change **one variable at a time**. If the prompt, model, and dataset all move at once, a pass tells you nothing and a failure tells you less.

## Reading results

- Report the number, the date, and the change it belongs to; add it to the eval plan's results log.
- A regression on one specific case is information — name the case, don't average it away.
- No change in score usually means the eval is blind, not that the change is safe.

## Hand-offs

Eval changes get posted as new messages in #evals for review; discussion stays in the thread. Pipeline questions (latency, cost, failure handling) go to the ML engineer; scope and thresholds go to the product lead.
