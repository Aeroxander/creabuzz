# Production Guide

Five minutes, no jargon. Here's how this studio actually works.

## The three collaborators

| Who | What they do | How you wake them |
| --- | --- | --- |
| **@The Writer** | Story craft — loglines, beats, dialogue, scene polish | Mention them in #writers-room |
| **@The Producer** | Task breakdowns, schedule reality, decision logs and digests | Mention them in #production |
| **@The Scene Generator** | Scene briefs in, vivid descriptions and ready-to-paste AI prompts out | Mention them in #scene-gen |

The whole interaction model: **mention an agent with @ and it joins your thread.** Reply in the thread to keep going.

## The loop

1. **Write together** in #writers-room. Start the Story Bible doc (it has the template), then ask @The Writer for three logline ideas and pick one to chase.
2. **See it** in #scene-gen. Post your scene brief as a **new message** — every new top-level post is a brief and goes to the producer's approval queue. Reply in a thread to talk it over without starting a new review.
3. **Approve in the queue.** @The Producer reviews each brief against the Story Bible and the schedule. Approve it and the formatted scene prompt lands in your thread, ready to paste.
4. **Keep it honest** in #production. @The Producer breaks work into tasks on the Work Board (statuses: `open` → `assigned` → `in_progress` → `needs_approval` → `done`, priorities: `low` / `normal` / `high` / `urgent`) and posts digests of what moved, what's blocked, and what needs a decision. When a task lands, it goes to `done` — done tasks are what the standup is made of.
5. **Watch the standup appear.** Every weekday at 09:00 UTC the studio distills what landed — done tasks and contributions — into the standup page in the wiki (`default/standup`). It writes itself; there's nothing to fill in. The workflow that does it (`agwiki-nightly`) is the same nightly self-maintenance workflow the product's Agent Wiki settings manage — flipping that toggle turns this studio's standup on and off.

## Scene renders

@The Scene Generator writes prompts — you paste them into ComfyUI, Midjourney, MiniMax, or whatever your studio renders with. The prompts are written to paste cleanly (subject → action → setting → light → style), and the agent notes the tool settings each one needs.

**Extension point:** connect a scene-render service to auto-attach renders. Until then, the prompt is the deliverable — and a good one.

## Where things live

- **#writers-room** — the writing table (start here)
- **#production** — schedules, status, decisions
- **#scene-gen** — scene briefs and approved prompts
- **#standup** — the daily standup home
- **Story Bible** (doc) — the canon everything grounds in
