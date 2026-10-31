# A working cycle for teams that build with AI (proposal, 2026-10-31)

**Status:** proposal, not built. It follows [PROJECT-STRUCTURE.md](PROJECT-STRUCTURE.md), whose step 1 (taking work
on, Now and Not doing) is built (D154), and reorders that document's remaining steps around one cycle.

**Read for it:** *The Effective Executive* (Drucker), Deming's sayings as collected in *The Little Blue Book*, *The
AI-Driven Leader* (Woods), and a set of Agile certification notes (the gist you shared). One correction: the gist is not
about AI. It summarises Scrum, XP and Lean as taught in 2017, which made it a useful way to see which Agile habits still
hold when AI does most of the building.

## The short answer: not Agile sprints. A learning cycle instead.

Agile was designed when people's building time was the scarce thing, so it measures and protects that time: estimates in
story points, a velocity chart, fixed two-week sprints, a daily standup. When agents do much of the building, building
time stops being scarce. What becomes scarce is **people's judgement**: deciding what is worth doing, saying what "done"
means, checking the work, and learning from what happened.

So the cycle should be built around judgement and learning, which is what Deming's cycle is for: **plan, do, study,
adjust**. Each plan carries a prediction. Studying compares what happened with what was predicted, and adjusting
changes the plan and fixes the way the team works, not only the work.

**From Agile we keep:**
- a "done when" agreed before the work starts;
- a limit on how much is in progress (Now holds three);
- small, frequent deliveries;
- a regular look back;
- cheap experiments, which agents make nearly free.

**We drop:**
- estimates and velocity;
- fixed sprint commitments;
- the daily standup (an agent's log already says what it did; people only need to raise what is stuck).

## The cycle

**Every two weeks, or weekly in a project's first month.** Work flows continuously between checks; the cycle is when the
team stops to learn, not a deadline.

### Plan: the founder, helped by an AI challenger

- **An aim** in one sentence: who the project is for and what it changes for them. Every Now item and work area links
  to it. Deming: without an aim there is no system. Drucker: results are outside the project.
- **Now** (at most three, built) gets two more fields: *why this, now*, and *what we expect to see, and by when* (a
  prediction someone can check).
- **Not doing** (built).
- **Before a Now item or a budget vote goes out,** an AI challenger asks one question at a time: what is this assuming,
  what is the strongest case against, what else could we do, and does the plan only work if everything goes right? Its
  notes are posted next to the proposal. The founder decides; the AI never does. Woods calls this the AI's
  "challenger" role; Drucker calls it hearing the dissent before deciding.

### Do: people and agents

- People say what they are taking on (built). When someone takes on something new while holding other work, the form
  asks what moves down their list, rather than letting work pile up.
- **Build quality in rather than only checking it at the end.** Before work is submitted, the person or their agent
  checks it against the "done when" and attaches the result: tests run, the link, what was checked.
- **Remove a step before automating it.** Before an agent is set to automate a task, a short prompt asks whether the
  step is needed at all, whether it can be cut, and whether it can be made simpler.
- **Asking for help:** describe the situation and your own best answer before the founder or a reviewer steps in. People
  keep doing their own thinking.
- **Newcomers:** an AI interviewer asks a new contributor a few questions and drafts their first "taking this on" for
  them to edit.

### Study: an agent drafts it, the founder confirms it

This is the step teams skip, and the one the app can do most for. At each check, an agent drafts a **check note** from
the project's own records. The founder edits and publishes it. It contains:

- For each Now item: what was predicted, and what happened.
- What was finished, what is stuck, and who could unstick it.
- **Why work was sent back, by reason, across the whole project.** Reasons include "the 'done when' was unclear",
  "missing access", "the agent lacked context", and "quality". A reviewer picks a reason when sending work back. Deming:
  most problems come from how the work is set up, not from the person, and only whoever runs the project can fix those.
- **Time to finish and sent-back rates over time, with their normal range.** Only points outside that range are
  flagged. People are never ranked, and an ordinary slow week is not treated as a problem.
- What changed for the people the project is for, which is the first line of the note.

Holders read the latest check note before they vote on a budget. An outside reviewer can be invited to comment on it.

### Adjust: the founder

- For each Now item: keep it, change it, or drop it (dropping moves it to Not doing). The question is whether you would
  start it today, knowing what you know now.
- **Fix one thing in how the team works each cycle.** For example: rewrite an unclear "done when", give an agent
  better context, or change a review rule.
- What keeps happening becomes a standing rule (the decision notes in PROJECT-STRUCTURE.md).

Whatever comes out of Adjust becomes the next Plan.

## Who does what

| Who | Owns | Checks |
|---|---|---|
| Founder | The aim, Now and Not doing, and how the team works | The check note; one improvement each cycle |
| Contributors (with their agents) | Their own work and their own thinking | Their work against the "done when", before submitting |
| Reviewers | Whether work meets the "done when" | The work, giving a reason when it falls short |
| Holders | Budgets and awards | The check note, before voting |
| AI | Drafts and questions: challenger, interviewer, check-note drafter, pre-submit checker | Nothing on its own. A person decides every time |

## What the app must not do

All three books warn against these:

- **No leaderboards, rankings, quotas, or claims-per-week targets.** These are management by numbers.
- **No public count of anyone's rejected work.** Send-backs are private to the person and counted only as reasons
  across the whole project.
- **No measuring output volume as success.** That includes agent tasks closed, lines written, and the token price.
- **No reacting to a single result that is within the normal range.**
- **No AI deciding, and no AI output passed on unchecked.** The AI drafts and asks; people edit and decide.
- **No rituals copied for their own sake.** That includes daily standups, sprint ceremonies, and recurring meetings.
- **Nothing designed to keep people engaged for its own sake.**

## One tension to decide

Deming argued against paying individuals for individual merit. Creaton's economics are built on exactly that: Shares
awarded per piece of reviewed work. We don't need to give that up, but we can soften it:

- Judge awards by what the work did for the aim, not by volume.
- Show the project's progress as a team's.
- Never rank contributors.

Larger shared awards for a whole work area are possible, but they are a bigger change and should wait for the pilots.

## Order to build in (replacing PROJECT-STRUCTURE.md's steps 2 to 5)

1. **The aim, plus the *why* and *expected* fields on Now.** Small: two fields on records that already exist.
2. **Send-back reasons**, chosen by the reviewer and counted across the project.
3. **The check note:** drafted by an agent from the records, confirmed by the founder, read by holders before votes.
   It replaces the weekly check-in in the earlier proposal.
4. **The AI challenger** on Now items and budget votes, together with decision notes.
5. **The pre-submit check and the "remove before automating" prompt** for agents, and the newcomer interviewer.

Steps 3 to 5 need an AI agent the project can call. The agent features are switched off in the contributor-only build
(see the hidden list in PROJECT-STRUCTURE.md), so step 3 also decides how a project gets its agent.
