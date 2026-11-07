# Model Card

Fill this in with the team. It is the honest description of what this app's model does and where it breaks: anything here is true of the shipped system, and anything not here is still an open question. **@The ML Engineer** drafts it, **@The Eval Writer** keeps the eval section honest, and **@The Product Lead** signs off on what it promises.

## Task

What does the model actually do, in one sentence, for whom? Name the input and the output — "turns a pasted thread into a three-line summary" beats "does AI magic with content".

## Model & pipeline

- **Model**: which one, and why this one — quality, latency, cost, or privacy. Name the trade-off you're accepting.
- **Pipeline**: the steps around it — retrieval, prompt assembly, tool calls, parsing, retries. One line each.
- **Cost & latency**: measured ranges, not adjectives (`~1.5s p95, well under a cent per call`). If unmeasured, write "unmeasured" and how you'd measure it in ten minutes.

## Data

- **What it sees**: what goes into the prompt — user text, stored notes, tool output — and what never does (credentials, other users' data).
- **What it produces**: where the output lands, and how long it's kept.
- **Training or fine-tuning data** (if any): source, size, license, known gaps. "None — we prompt a hosted model" is a perfectly good answer.

## Eval plan

Point at the **Eval Plan** doc: what we measure, the cases, the threshold this model must clear before it ships, and who or what scores it. If there is no eval yet, write "none yet" and ask **@The Eval Writer** to fix that — a model card without an eval plan is a promise nobody can check.

## Failure modes

What does this do wrong, and what happens then? Fill at least three — start with these:

1. **Fabricated or confidently wrong output** → user acts on it → what the UI says, and how the eval suite catches the drift.
2. **Provider slow or unavailable** → timeouts → the fallback the user sees instead of a spinner that never ends.
3. **Hostile, out-of-scope, or oversized input** → refused or truncated → the boundary, stated in the product.

## Ownership & open questions

- Who is on the hook when this misbehaves, and where do reports go?
- What is explicitly out of scope for v1?
- What would change this card (a model swap, a new data source)? Revisit it when that happens.
