# The check note: plan (2026-10-31)

**Status:** build steps 1 and 2 done (D159, D160); steps 3 and 4 not built. It is step 3 of [PROJECT-CYCLE.md](PROJECT-CYCLE.md), building on D154 (taking work on;
Now and Not doing), D157 (the aim, why, what we expect and a check day) and D158 (what was missing on a turn-down).

## What it is

Every two weeks (weekly in a project's first month) the founder publishes a short **check note**: what the team
expected, what happened, and what changes next. It is the "study" and "adjust" half of the cycle, and the one place a
holder reads before voting on money. It is drafted for the founder from the project's own records; the founder edits
and confirms it. It replaces the "weekly check-in" in PROJECT-STRUCTURE.md.

## How a project gets its AI: it doesn't need its own

The server already has a metered AI service for browser features (`api/llm_gateway.rs`). Only members can use it, the
key stays on the server, and it has a per-person rate limit, a budget and a daily cap. The operator turns it on.
Nothing else is needed:

- **Without it, the note still works.** Every fact in the note comes from records the app already reads, so the draft is
  assembled without AI.
- **With it, the AI adds two things, both marked as drafts the founder must edit or accept:** a short summary, and one
  question per Now item ("Would you start this today? Here is what argues against it"). It never publishes and never
  decides.

So the open question from PROJECT-CYCLE.md ("how does a project get its agent") does not block this step. It matters
again for steps 4 and 5 (the challenger before votes, pre-submit checks), which can use the same service.

## What the note contains

Most of it is filled in automatically; the founder writes the first line and the last two.

| Section | Source | Who |
|---|---|---|
| Since (date range) | the previous note | automatic |
| **What changed for the people we serve** | | founder, required |
| For each Now item: what we expected, by when; **did it happen?** (yes, partly, no, not yet) and a line on why | focus record (D157) | founder answers; the expectation is filled in |
| Finished: work awarded or approved, with who did it | the chain (claims, awards) | automatic |
| Stuck: work waiting on someone, and who could unstick it | the Overview's "Waiting on someone else" | automatic, editable |
| Turned down, by cause | D158's tally, for this period | automatic |
| Taken on and lapsed: people whose date passed without a submission (no names, a count) | D154 records | automatic |
| **For each Now item: keep, change, or drop** | | founder |
| **One thing we change in how we work** | suggested from the causes (an unclear "done when" suggests rewriting it) | founder, required |

Rankings, per-person counts and anything measuring output volume are deliberately left out (PROJECT-CYCLE.md, "What
the app must not do").

## Where it lives and who sees it

- **The record:** a founder-signed launch update (kind 47003, which already means exactly that) with a structured
  `check` object beside its text. It needs no new kind and no server change, and it appears in the project's Updates
  like any update.
- **The Overview:** "Last check: 3 days ago". When one is due, "Check due" shows to everyone, and in "Needs you" for the
  founder. After 21 days with none (35 in the first month), the project card says "No check since …".
- **Decisions:** a budget or award vote shows "Read the latest check note" beside its vote buttons, with its date. It
  is a link, not a gate.

## Adjust: one action, applied in order

Publishing the note also applies its keep/change/drop answers to Now and Not doing. That is two records: the note, then
the updated focus. They are written in that order, so the note (the record of the decision) always exists. If the
focus update fails, the note shows "Apply to Now" until it succeeds, so nothing is lost and nothing is applied twice
(review-proven rules 1 and 5).

## Build order

1. **The note without AI:** the form, the automatic sections, publishing, reading it in Updates, "Last check" and
   "Check due" on the Overview, and "Needs you". The automatic sections are pure functions with unit tests. A mocked
   spec covers the form, and a contributor-journey step publishes a note and sees it applied to Now.
2. **Adjust:** keep, change and drop applied to the focus record, with the "Apply to Now" recovery.
3. **The link from votes** to the latest note, and "No check since …" on project cards.
4. **The AI draft,** when the server's AI service is on: a summary and a question per Now item, both shown as drafts.
   It is tested against a stand-in service in the mocked specs. The cost is on the operator's metered budget.

Steps 1 to 3 have no AI and no server change. Step 4 needs the AI service turned on for the pilot server.

## Decisions for you

1. **Cadence:** every two weeks, and weekly in the first month? Or let the founder choose at the start?
2. **Is the note required?** I suggest not: the reminders and "No check since …" make a missing note visible without
   blocking anything.
3. **The AI service on the pilot server:** turn it on (and set a budget) for step 4, or leave the note AI-free for the
   pilot?
4. **Holders' reading:** a link beside the vote buttons (my suggestion), or something stronger, such as a confirmation
   that you have read it?
