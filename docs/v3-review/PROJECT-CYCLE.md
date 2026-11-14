# A working cycle for teams that build with AI (proposal, 2026-10-31)

**Status:** the core cycle is built: the aim and predictions (D157), what was missing on a turn-down (D158), the check
note (D159 to D162), the challenge before money votes (D164, D165), checking work before submitting and newcomer
guidance (D166 to D168). D169 fixes record recovery and AI drafts that arrive after edits. AI parts appear only when
the server's AI service is on. The challenger on Now items, standing decision notes, and statistical variation charts
described below are not built. The current implementation map and the AI-era guardrails are in
[Deming in Creaton](DEMING-AI.md).

**Read for it:** *The Effective Executive* (Drucker), Deming's sayings as collected in *The Little Blue Book*, *The
AI-Driven Leader* (Woods), and a set of Agile certification notes (the gist you shared). One correction: the gist is not
about AI. It summarises Scrum, XP and Lean as taught in 2017, which made it a useful way to see which Agile habits still
hold when AI does most of the building.

## The shape: a learning cycle around continuous work

AI can reduce the time and cost of some building and experimentation. Integration, verification, deployment, customer
work and people's attention still cost time. This project cycle gives **people's judgement** a place in that work:
deciding what is worth doing, saying what "done" means, checking it, and learning from what happened. It does not
assume that an agent's output is correct or that building is free.

So the cycle should be built around judgement and learning, which is what Deming's cycle is for: **plan, do, study,
adjust**. Each plan can carry a prediction. Studying compares observations with that prediction. Adjusting can mean
keeping a method with a reason, changing it, or gathering more evidence. It does not demand a process change after
every result. This is Creaton's adaptation of [PDSA](https://deming.org/explore/pdsa/), not a replacement for its
emphasis on testing a theory and learning from the result.

**From Agile we keep:**
- a "done when" agreed before the work starts;
- at most three current project priorities;
- small, frequent deliveries;
- a regular look back;
- small experiments whose cost, including checking and rework, is understood.

**The app does not impose:**
- estimates or velocity targets;
- fixed sprint commitments;
- daily standups. Teams can choose a meeting when it helps; an agent's log alone does not establish shared understanding.

## The cycle

**Every two weeks, or weekly in a project's first month.** Work flows continuously between checks; the cycle is when the
team stops to learn, not a deadline.

### Plan: the founder, helped by an AI challenger

- **An aim** in one sentence: who the project is for and what it changes for them. Every Now item and work area links
  to it. Deming: without an aim there is no system. Drucker: results are outside the project.
- **Now** (at most three, built) gets two more fields: *why this, now*, and *what we expect to see, and by when* (a
  prediction someone can check).
- **Not doing** (built).
- **Before a money vote goes out (built),** an optional AI challenger asks one question at a time: what is this assuming,
  what is the strongest case against, what else could we do, and does the plan only work if everything goes right? Its
  answers are posted next to the proposal when supplied. The person opening the vote decides; the AI never does.
  The same prompt for a Now item remains a proposal. Woods calls this the AI's "challenger" role; Drucker calls it
  hearing the dissent before deciding.

### Do: people and agents

- People say what they are taking on (built). A prompt asking what moves down their list when taking on more work is
  still a proposal; saying so reserves nothing and does not exclude someone else's contribution.
- **Build quality in rather than only checking it at the end.** Before work is submitted, the person or their agent
  checks it against the "done when" and attaches the result: tests run, the link, what was checked.
- **Remove a step before automating it (guidance, not a built prompt).** Ask whether the step is needed, can be cut,
  or can be made simpler before paying to automate it.
- **Asking for help (guidance):** describe the situation and your own best answer before the founder or a reviewer steps
  in. People keep doing their own thinking; this is not a required form.
- **Newcomers:** an AI interviewer asks a new contributor a few questions and drafts their first "taking this on" for
  them to edit.

### Study: an agent drafts it, the founder confirms it

This is the step teams skip, and the one the app can do most for. At each check, an agent drafts a **check note** from
the project's own records. The founder edits and publishes it. It contains:

- For each Now item: what was predicted, and what was observed. A yes, partly or no answer to a prediction includes
  what the founder saw; "not yet" remains a valid answer when the result is not known.
- What was finished, what is stuck, and who could unstick it.
- **Why work was sent back, by reason, across the whole project.** Reasons include "the 'done when' was unclear",
  "missing access", "the agent lacked context", and "quality". A reviewer picks a reason when sending work back. Deming:
  look at how work was set up before blaming the person. A cause tally is a report of reviewers' reasons, not proof of
  causation or of a statistical trend.
- **Variation over time (not built).** Time to finish and sent-back rates would need comparable observations and a
  justified method before any normal range or signal is shown. Until then, the app must not invent statistical
  confidence. A single slow week does not by itself establish that a process changed; a verified defect or safety
  problem still warrants action without waiting for more samples.
- What changed for the people the project is for, which is the first line of the note.

Holders are offered the latest check note beside money votes; reading it is not enforced. An outside reviewer can be
invited to comment on the project's board.

### Adjust: the founder

- For each Now item: keep it, change it, or drop it (dropping moves it to Not doing). The question is whether you would
  start it today, knowing what you know now.
- **Say how the team works next.** Keep the method and explain why, try one change, or say what must be learned before
  deciding. A concrete change might rewrite unclear words, give an agent better context, or change a review rule.
  An ordinary result is not a requirement to invent an improvement.
- What keeps happening can inform a standing rule. Structured decision notes in PROJECT-STRUCTURE.md remain a proposal;
  the team can record a decision on its board today.

Whatever comes out of Adjust becomes the next Plan.

## Who does what

| Who | Owns | Checks |
|---|---|---|
| Founder | The aim, Now and Not doing, and how the team works | The check note; a reasoned keep, change or learning decision |
| Contributors (with their agents) | Their own work and their own thinking | Their work against the "done when", before submitting |
| Reviewers | Whether work meets the "done when" | The work, giving a reason when it falls short |
| Holders | Budgets and awards | The check note, before voting |
| AI | Drafts and questions: challenger, interviewer, check-note drafter, pre-submit checker | Nothing on its own. A person decides every time |

## What the app must not do

The design avoids these:

- **No leaderboards, rankings, quotas, or claims-per-week targets.** These are management by numbers.
- **No individual failure leaderboard.** Work claims, verdicts and published reasons can already be visible in the
  contribution record and onchain. They are not private coaching records. Use the project-wide causes to help the team,
  without turning those records into per-person failure scores.
- **No measuring output volume as success.** That includes agent tasks closed, lines written, and the token price.
- **No treating a single result as proof of a statistical trend.** There is no calculated normal range today.
- **No AI deciding, and no AI output passed on unchecked.** The AI drafts and asks; people edit and decide.
- **No rituals copied for their own sake.** That includes daily standups, sprint ceremonies, and recurring meetings.
- **Nothing designed to keep people engaged for its own sake.**

## One tension to decide

Deming's criticism of merit ratings and quotas creates a tension with Shares awarded per piece of reviewed work:
contributors may optimise for countable claims instead of helping the whole project. Reviewed compensation is not
automatically a quota, but the incentive needs to be observed rather than declared solved:

- Judge awards by what the work did for the aim, not by volume.
- Show the project's progress as a team's.
- Never rank contributors.

Larger shared awards for a whole work area are possible, but they are a bigger change and should wait for the pilots.

## Original build order and the remaining parts

1. **The aim, plus the *why* and *expected* fields on Now.** Small: two fields on records that already exist.
2. **Send-back reasons**, chosen by the reviewer and counted across the project.
3. **The check note:** drafted by an agent from the records, confirmed by the founder, read by holders before votes.
   It replaces the weekly check-in in the earlier proposal.
4. **The AI challenger:** money votes are built; Now items and structured decision notes remain proposals.
5. **The pre-submit check and newcomer interviewer** are built. The "remove before automating" prompt remains guidance.

The optional AI parts use the server's existing metered AI service when the operator enables it; a project does not
need its own agent. The cycle still works without AI. This does not enable the separate helper-management surfaces
hidden from the contributor pilot, and it does not change awards, voting or treasury rules.
