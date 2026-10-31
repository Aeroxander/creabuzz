# The challenger before a vote: plan (2026-10-31)

**Status:** build step 1 done (D164); steps 2 and 3 not built. Step 1 publishes the answers before the vote opens (its id is read from the DAO first), so it needs no retry queue: an answer whose vote never opened is never shown. It is step 4 of [PROJECT-CYCLE.md](PROJECT-CYCLE.md). It builds on the check note
(D159 to D162) and on the same server AI service (`api/llm_gateway.rs`).

## What it is

Before someone opens a vote that commits the project to something, they are asked to argue against it for a minute.
The questions come one at a time. The answers are published with the vote, so holders can see the case against next to
the proposal. Drucker: a decision without dissent is not yet understood. Woods: use AI to challenge your thinking, not
to confirm it.

It is a prompt, not a gate. A vote can still go out unchallenged, but its card then says "Not challenged before it went
out". Holders can weigh that, as they weigh a missing check note.

## Which votes

Votes that commit money or Shares, as the check-note link already defines them: a work budget, a work area, an award,
a payment. Changes to the voting settings are already flagged on their own card (D153), so they are left out. Later,
optionally: the founder's Now items (step 3 below).

## How it works

### Without AI: three fixed questions (works everywhere)

The composer's last step, before "Open the vote", asks:

1. **What has to go right for this to work?** If the answer is "everything", say so: the plan only works by a miracle.
2. **What is the strongest case against it?** Write the best argument someone who disagrees would make.
3. **What else could we do instead?** At least one alternative, even if it is "wait".

Each answer is one or two lines. "Skip" is allowed, and a skipped question shows as skipped.

### With the AI service on: the same three, then up to two follow-ups

The AI acts as an interviewer and asks one question at a time. It starts from the three fixed questions, then asks up to
two follow-ups that press on the weakest answer. For example, "You said nobody else could do this work; what would it
take to find someone?"

- **What it sees:** the proposal's own words, the project's aim, Now, and the latest check note.
- **Its rules:** add nothing it was not given, name and rank no one, and decide nothing. The same rules as the check
  note's AI draft (D162).
- **At the end:** it drafts a three-line summary (what must go right, the case against, the alternative). The proposer
  must accept or edit it, as with the check note's summary.
- **Cost:** at most four calls per challenge, on the proposer's metered allowance.

## The record and where it shows

- **When it is published.** The challenge belongs to a specific vote, but a vote's id exists only once it is opened. So
  the answers are kept in the browser while the composer is open, and published the moment the vote opens.
- **The record.** A launch update (kind 47003), signed by the proposer, with a `challenge` object: the decision id, the
  questions and answers (skips included), and the summary. No server change is needed.
- **If publishing fails.** It joins the queue that already publishes a vote's work-area words (`pending-words.ts`). Its
  author sees it under Decisions until the server accepts it, so a challenge is never lost after the vote opened.
- **On the vote's card.** Next to the latest check note, holders see one of:
  - "Challenged before it went out", folded, with the summary and each question and answer;
  - "Not challenged before it went out".

  Only a challenge from the person who opened the vote counts.

## Build order

1. **The three questions without AI.** In the composer for the four money kinds: the record, the publish-after-open
   step with the pending queue, and the card's "Challenged" / "Not challenged". Tests: unit tests for the record and
   for matching a challenge to its vote; a mocked composer spec; a contributor-journey step (award vote).
2. **The AI follow-ups and summary,** when the AI service is on, tested with a stand-in service as in D162.
3. **Optionally,** the same three questions when the founder adds a Now item.

## Decisions for you

1. **Prompt or gate?** I suggest a prompt plus a visible "Not challenged", not a requirement.
2. **Which votes:** the four money kinds (suggested), or every vote?
3. **Who answers:** the person opening the vote (suggested). Or can any holder add a challenge to an open vote? That
   would be a second, later step.
4. **Now items** (build step 3): worth doing, or is the check note's "would you start it today?" enough?
