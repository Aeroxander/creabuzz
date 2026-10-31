# Checking work before it is submitted, and a newcomer's first week: plan (2026-10-31)

**Status:** built: steps 1 to 3 (D166 to D168). The AI helpers appear only when the server's AI service is on.

## 1. A check before submitting

**Why.** Review should confirm the work, not be the first time anyone holds it up against the "done when". Deming:
build quality in rather than inspect it in. Most turn-downs so far would be caught by the person who did the work
reading the "done when" once more.

**Without AI.** The submit form gets a short section, **"How you checked it"**, above the submit button:

- The work area's "done when", shown again.
- **"How does your work meet it?"** One or two lines: the tests run, the link checked, what was compared.
- **"Anything it does not meet yet?"** Optional. Saying so up front is better than a turn-down.

The answers are added to the end of the evidence text, under a heading. The evidence is what the claim already commits
to by hash and publishes for reviewers (`lib/evidence.ts`), so this needs no new record and no server change.
Reviewers see "How they checked it" with the rest of the evidence.

**With the AI service on.** A **"Check my work against the 'done when'"** button asks the AI to compare the evidence text
with the "done when" words and list what looks missing or unclear. Its answer is shown only to the person submitting.
It is never published and never decides anything. It is plain about its limit: it reads only the text in the form, not
the pages a link points to. The person can then edit the work or the evidence, or submit as is.

**Removing a step before automating it.** When someone's evidence says an AI agent did the work, the check adds one more
optional question: **"Was every step needed?"** It is a reminder to cut before automating. It is not required.

## 2. A newcomer's first week

**Why.** A newcomer today sees "How it works" and Open work, and nothing that tells them how this team works or where
to begin. People who join and look around without a first step tend to leave.

**A "New here?" card** on a contributor project's Overview, for anyone with no Shares and no work taken on in it. It
shows three steps in order and ticks each one off from the records:

1. **Read the aim and Now.** Ticked once they have opened the project's Overview after the aim was set.
2. **Take on one small piece.** This links to Open work. Ticked by their first "taking this on" (D154).
3. **Read the latest check note, and the next one when it comes out.** Ticked once a note is published after they took
   something on.

The card goes away once they have taken work on and a check note has come out since. Nobody else sees it.

**The interviewer.** On "Take this on", a person who has never taken work on in this project gets **"Help me fill this
in"**:

- **Without AI:** two worked examples of a good "what you'll deliver / who will use it / by when", for this kind of
  work area.
- **With the AI service on:** the AI asks three short questions, one at a time. What are you good at, or want to get
  better at? How much time do you have this week? What in this work area do you care about? It then drafts the three
  fields from the answers and the work area's "done when". The person edits the draft before saving, as with every other
  AI draft here. The answers to its questions are not published.

## Build order

1. **"How you checked it" on submit, without AI.** It goes into the evidence. Tests: unit tests for the evidence
   section; a journey step where the contributor fills it in and the reviewer sees it.
2. **The "New here?" card** and the worked examples on "Take this on" (no AI).
3. **The AI check of the work** and **the AI interviewer**, when the AI service is on, tested with the stand-in service
   as in D162 and D165.

No step changes the server or the contracts.

## Decisions for you

1. **"How you checked it": required or optional?** I suggest the first answer is required ("How does your work meet
   it?"), since it costs one line and it is what review checks anyway, and the second is optional.
2. **The "New here?" card:** for anyone without Shares in the project (suggested), or also for holders who have never
   taken work on?
3. **The AI's check of the work:** shown only to the submitter (suggested), or also to reviewers as a note?
