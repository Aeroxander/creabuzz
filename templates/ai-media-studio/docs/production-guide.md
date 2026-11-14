# Production Guide

Five minutes, no jargon. Here's how this studio actually works — for a film, a series, a music video, a brand film, or an audio drama.

## The six collaborators

| Who | What they do | How you wake them |
| --- | --- | --- |
| **@The Writer** | Story craft — loglines, beats, dialogue, format-aware structure | Mention them in #writers-room |
| **@The Script Editor** | Scene structure, page format, pacing — a dialog-driven polish pass | Mention them in #writers-room |
| **@The Producer** | Task breakdowns, schedule reality, decision logs, digests, approvals | Mention them in #production |
| **@The Scene Generator** | Scene briefs in, vivid descriptions and ready-to-paste visual prompts out | Mention them in #scene-gen |
| **@The Sound & Music** | Score, sound design, foley prompts, and audio-drama voice scripts | Mention them in #scene-gen |
| **@The Continuity Keeper** | Canon enforcement — every asset checked against the Story Bible | Mention them anywhere |

The whole interaction model: **mention an agent with `@` and it joins your thread.** Reply in the thread to keep going. The full production role map — what ships and what's an open role to hire — lives in the **Role Catalog** doc.

## The loop

1. **Write together** in #writers-room. Start with the genre-flavor question — film, series, music video, ad, or audio drama — then fill in the Story Bible (it has the template) and ask @The Writer for three logline ideas. When the draft needs page craft, hand it to @The Script Editor.
2. **See it** in #scene-gen. Post your scene or sound brief as a **new message** — every new top-level post is a brief and goes to the producer's approval queue. Reply in a thread to talk it over without starting a new review. Visual briefs go to @The Scene Generator; sound and music briefs go to @The Sound & Music.
3. **Approve in the queue.** @The Producer reviews each brief against the Story Bible and the schedule. Approve it and the formatted prompt lands in your thread, ready to paste.
4. **Keep it honest** in #production. @The Producer breaks work into tasks on the Work Board (statuses: `open` → `assigned` → `in_progress` → `needs_approval` → `done`, priorities: `low` / `normal` / `high` / `urgent`) and posts digests of what moved, what's blocked, and what needs a decision. When a task lands, it goes to `done` — done tasks are what the standup is made of.
5. **Keep the canon clean.** Any time two assets disagree, mention @The Continuity Keeper: they quote the conflict, quote the bible, and propose the fix. Canon changes only land when the team writes them into the Story Bible.
6. **Watch the standup appear.** Every weekday at 09:00 UTC the studio distills what landed — done tasks and contributions — into the standup page in the wiki (`default/standup`). It writes itself; there's nothing to fill in. The workflow that does it (`agwiki-nightly`) is the same nightly self-maintenance workflow the product's Agent Wiki settings manage — flipping that toggle turns this studio's standup on and off.

## Prompts: visual and sound

@The Scene Generator and @The Sound & Music write prompts — you paste them into ComfyUI, Midjourney, MiniMax, or whatever your studio renders or synthesizes with. Both write to paste cleanly (subject → action → setting → light → style; genre → instrumentation → arc), and both note the tool settings each prompt needs.

**The craft is a skill.** The studio ships `visual-prompt-craft` — lens, lighting, composition, style dialects, negative prompts, and consistency anchors — bound to the agents so any of them can write a prompt the tool will respect. @The Scene Generator follows it and keeps its spine inline, so prompts stay good even if the skill isn't bound.

**Extension point:** connect a render or audio service to auto-attach outputs. Until then, the prompt is the deliverable — and a good one.

## Where things live

- **#writers-room** — the writing table (start here)
- **#production** — schedules, status, decisions
- **#scene-gen** — scene and sound briefs, approved prompts
- **#standup** — the daily standup home
- **Story Bible** (doc) — the canon everything grounds in
- **Role Catalog** (doc) — who makes an AI film, and who you still need
