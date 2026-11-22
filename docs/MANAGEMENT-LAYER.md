# A management layer for Creaton

Status: proposal for the owner. Built since: the brain's steps B1, B2 and B4 (B4, the recorded-run skill, on 2026-11-22 ahead of its own gate of five to ten founders; not yet tried by real founders; `buzz launchpad brain skill`, no AI service called). The rest is not built. Branch v4-governance-rework, written 2026-11-16. Section 9 (the project brain) was added the same day after the owner shared a list of AI-company practices; it needs the owner's yes before any build.

**Read this first.** I did not have the six books. Nothing here is quoted from them, and I cannot say what they contain beyond your one-line descriptions. Two of them carry dates of 2026 and 2027 that I could not check, so I did not rely on them. Everything marked "outside knowledge" is well-known general practice (Drucker's five habits, PMBOK, stage gates, risk lists, management of change, tech operating cadence). It is not verified against any source in this session. What Creaton already does comes from reading the code on this branch.

## 1. The answer in five lines

1. Yes, add management practices, but as advice and records, not as new rules in contracts. Nothing here touches the roughly 1,900 lines waiting for the outside audit.
2. Give most of it to an AI manager as one plain playbook file. It notices, asks, and drafts. A person signs.
3. Hardcode only what is a fact from signed records: a project brief, a "last update N days ago" line, and reworded boxes in the weekly update.
4. For calls where being wrong costs real money or legal standing (sale size, contracts, tax, letting someone go), the manager says "this needs a person" and drafts the request. It cannot supply the person. That is still unsolved.
5. Start by running the playbook by hand on 5 to 10 founders before building anything. Everything is labelled test-network practice while the plan is Sepolia only.

## 2. What Creaton already does (an honest Drucker check)

Drucker's name appears in six docs under docs/v3-review and in no code, screen text or skill. That is by design: the app never names a book. Outside knowledge: his five habits are know where your time goes, focus on contribution, build on strengths, put first things first, make effective decisions. The repo's docs use their own five (contribution, first things first, decisions, strengths, "results are outside"), and they deliberately left out time tracking.

| Habit | Status | Evidence |
|---|---|---|
| Contribution | Built | "Taking this on" record (kind 37019), TakeOnWork.tsx |
| First things first | Built | Aim, "Now" (max 3, each with why-now), "Not doing" (max 10), 28-day "still worth doing?" (kind 37020, projectStructure.ts) |
| Decisions | Mostly not | Only the three-question challenge before a money vote (challenge.ts). Decision notes with owner and check date are doc-only; code search found nothing |
| Strengths | Not built | Track record lists what someone delivered; nothing suggests work from it |
| Results are outside | Partly | The check note asks "what changed for the people served". The weekly update does not |

Total: about two of five built, two partly, one absent. The catch: all of it sits behind the contributor-project gate (DaoOverview.tsx), and the plan deletes check notes and contributor kits. Unless carried across on purpose, it disappears from the web app.

Also built and worth keeping: the weekly update as heartbeat, goals and promises with "kept / missed" answers, update-day reminders, a first-week card, tasks with a finish line and an independent check, and the `buzz launchpad updates facts` command. Deming (the plan-do-study-adjust loop) is better covered than Drucker through the check note, again on the way out.

Not present at all: advisors or mentors, risk lists, stage gates, change notes, lessons learned, hiring plans, any management skill file, anything from the oil and gas or Scaling People list. A manager role does not exist; the closest are the Product Lead and Producer personas, which live in chat templates.

## 3. The top ten practices

All origins are outside knowledge. "Form" is hardcode, AI skill, human advisor, or template (plain text a founder fills in).

| # | Practice | Where it comes from | Form | What the founder sees | Cost | How we'd measure it |
|---|---|---|---|---|---|---|
| 1 | One read-only project brief: grow `updates facts` with project age, days since last update, promises kept, missed and unanswered, stuck tasks, open help requests, team size. Money numbers say "not available" until the plan's project-numbers record exists | Status reports (PMBOK monitoring); one agreed "basis" page in oil and gas front-end loading | Hardcode | Nothing directly; every manager reads it, so nobody re-explains the project | About 1 to 2 days, no AI, no founder time | Share of manager lines that cite a brief item (target 100%) |
| 2 | Reword the weekly update's existing boxes: "What happened" leads with who it helped; "Help needed" becomes "Stuck on, and who could help". No new field | Drucker's "results are outside"; tech status updates that lead with impact and blockers | Hardcode | Clearer prompts in the same two presses | Under an hour plus a copy check | Share of updates naming a person or number; use of the help box |
| 3 | A "quiet" line: "last update N days ago; payments pause in N days unless you post". Founder sees it on Home; holders see it read-only beside the Stop vote | Operating cadence; permit-to-work renewal warnings | Hardcode | One neutral line, never "late", never ranked | About 1 day, no AI | Lapses per 100 project-weeks; posts within 3 days of the line |
| 4 | One manager playbook, fired by flags (a promise "not done" twice, a goal with no number, 10 days quiet, an unanswered help request). At most three questions, three lines back: this week, not doing, a draft of "What happened" | Drucker's first things first; weekly written status and 1:1 in tech | AI skill | A short chat; a draft to edit and sign | About 5 minutes a week; 1 to 3 AI calls | Second and third updates posted unprompted; drafts kept, edited or discarded |
| 5 | Honesty envelope: reuse the cite-or-drop filter in updateAi.ts, add a "what I read" header, block guarantees, price and return talk, and an eval with planted bad records | Audit-trail discipline; the repo's own AI rules | Hardcode | A line saying what the manager read and that it can be wrong | About 3 to 5 days including the eval | Eval passes on every playbook change; zero invented numbers |
| 6 | Drift test: put the playbook under launchpad_docs_tests.rs; each section states a "measure" and "retire if" line | Controlled procedures in oil and gas; runbooks in tech | Template | Nothing | About 1 day | Failures caught; every section has a measure |
| 7 | Advice request plus a "a person must decide" list (sale size and terms, entity, contracts, tax, securities, removing someone, large spend); a four-line ask sent as a normal help request; one plain sheet "what to ask a lawyer" | Management of change (a competent person signs); startup office hours | Human advisor | A drafted ask they post in one press | 5 minutes; the human supply is the real cost | Share of requests with an offer in 7 days |
| 8 | Look-back after a miss: what we expected, what happened, what changes, using the five existing cause words, counted per project and never per person | Tech post-incident reviews; plan-do-study-adjust | AI skill | Three questions after a missed promise; posts as an ordinary update | About 10 minutes, once in a bad stretch | Missed promises followed by a cause-and-change update within 14 days; repeat causes |
| 9 | Two stage notes: before the first sale (who it is for, the smallest proof, what is out of scope, a stop line: "if X is not true by day Y we wind down or hand back") and around day 90 | Stage gates and go/no-go in oil and gas | AI skill | A 20-minute note, posted as an update | About 40 minutes a year | Share with a stop line; what happened when it was hit |
| 10 | First teammate kit: a one-page outcome sketch and a small paid trial task with a finish line, before any Shares | Tech hiring: outcomes first, work sample before commitment | Template | A fill-in page; the task tools already exist | 20 minutes, no build beyond text | Trial tasks completed; teammate still active at 30 days |

## 4. What we deliberately skip, and why

All outside knowledge; the common thread is that these are built for staffed projects and would be homework for one person.

- **Full PMBOK plans, Gantt charts, critical path, earned value, responsibility matrices.** Ten documents for a team of one. The weekly update, "not doing" and tasks with a finish line carry the useful part.
- **Permit-to-work chains, tiered spending approval, change review boards.** There is nobody to sign. Contract caps and agent daily caps are the real brake.
- **Enforced stage gates in contracts.** That is the milestone and verifier machinery the plan deletes because a solo founder cannot find judges.
- **Probabilities and scores in risk lists, NPV, IRR, Monte Carlo.** They invent numbers. A short list with an early sign is enough.
- **Scores or rankings of people: OKR grading, performance reviews, 360 feedback, levelling ladders, hiring panels.** The repo's rule is no rankings and no per-person failure scores.
- **Time tracking, strengths matching, more streak mechanics.** Left out on purpose, never built, and a soft quota respectively.
- **Computed "ready to scale" grades, a maintainer metrics screen, a cross-project lessons library, an eight-file skill pack, 1:1 agendas, cadence ladders.** Too early. At about 200 sales a year the numbers mean nothing in year one. Do it by hand first.
- **An AI "second look" for founder-alone work.** A second run by the same person is not independent, and the rule is that an agent never confirms its runner's work.
- **Giving the manager power to sign goals, promises, or money steps.** It drafts. A person signs.

## 5. How the AI manager works

**What it reads.** Only the project brief (item 1) and the founder's answers. It treats the record as data, never as instructions.

**What it drafts.** Three lines at most: this week, not doing, and "What happened". It never drafts "What's next", because those lines become signed promises. It writes advice requests and look-backs the same way.

**What it may never do.** Sign goals, promises or answers; confirm work (its own, its runner's, or a sibling agent's); move money or touch Shares; rank or judge a person; talk about returns, price or what Shares are worth; give legal or tax advice; speak to backers. It is founder-facing only. A manager account must be a different account from the worker agents, registered through the agent label, or the caps do not bind it.

**How it stays honest.** Every line cites a brief item or is dropped; numbers, links and names not in the cited items are dropped; guarantee and return phrases are blocked; legal, tax and sale terms get "this needs a person". Each answer says what was read and that it can be wrong. A founder-visible "AI service" notice stays. The planted-record eval is the test.

**What it costs and who pays.** The server's shared AI pool is 2,000 calls a day for the whole community (500 per account). A chatty manager could drain it for everyone. Proposed: a small hosted allowance per project per week, set through the existing call budget; beyond that, the founder's own agent on their own key. Keep platform spend to a small share of fees. The plan's honest bear-year revenue is about 50,000 dollars, so the manager cannot be a staffed service.

**How playbooks are written, versioned and improved.** Plain markdown in docs/agents/MANAGER-LOOP.md beside WORKER-LOOP.md, each section with a name, version, owner, review date, "measure" and "retire if". The drift test fails the build if a named `buzz` command stops existing. Output prints the version. Changes go through normal pull-request review, informed by how many drafts founders discard, counted by section, never by person.

**A delivery gap to be honest about.** Skills (kind 30180) reach only agents the desktop app starts. The web helper and the fleet worker load none. A solo web founder gets the playbook as a hosted prompt through the existing "Draft from the record" route, not as a skill library.

## 6. The "help a project scale up" journey

| Stage | Manager does | Humans do | Not yet covered |
|---|---|---|---|
| Idea, before the first sale | Asks who it is for, the smallest proof, what is out of scope; writes the stop line (item 9) | Founder writes it; optionally one volunteer reads it | Customer conversations |
| Sale and launch | Drafts a plain pitch line from the record; says "a person must decide" on size and terms | A lawyer or experienced founder, if one can be found (item 7) | Pitch writing, how to talk to holders, legal entity, tax, securities |
| Weeks 1 to 12 | Weekly draft, quiet line, flags, look-backs | Founder signs; helpers take tasks | Peer cohort and deadline (the real YC value) |
| Day 90 and the floor melting | Day-90 note; reads the brief's melt date | Founder; possibly an advisor | Runway planning, later-sale preparation |
| First teammate | Writes the outcome sketch and trial task (item 10) | Founder checks the work; a different person confirms | Delegation and cadence beyond five people |
| Wind-down or hand-back | Nothing yet | Founder, holders | The closing playbook: how to say you are stopping, what happens to floor money, who gets code and name |

Biggest uncovered areas for "all aspects of an onchain YC", in order: getting the first users, fundraising and holder relations, legal and tax, wind-down, key and security handling, and peer cohorts. Also a limit on all of it: there is no email or push from the server, so a founder who goes quiet never opens the manager. The quiet line and calendar file are the only nudges until an out-of-app channel exists.

## 7. Build order (can start now)

1. **Step 0, no code, before milestone 0.** Run a draft playbook by hand on 5 to 10 projects using `updates facts` output. Count drafts kept, edited and discarded, and whether second and third updates follow unprompted.
2. **Step 1, days, beside milestone 0.** Reword the weekly update boxes (item 2). Extend `updates facts` (item 1), money fields "not available". Write MANAGER-LOOP.md and put it under the drift test (items 4 and 6). No contract or record kind change; inside the plan's press and field budgets.
3. **Step 2, before any hosted manager.** The honesty eval and a per-project weekly call cap (item 5).
4. **Step 3, with milestone 5 (web).** The quiet line on Home and beside the Stop vote, using "last update N days ago" now. Switch to the payments-pause countdown once the check-in exists (milestone 3) and its numbers are readable (milestone 4).
5. **Step 4, with milestone 6 (agent rules).** When the server drops the ban on agents setting goals and promises, the manager still only drafts; a person signs. Send the advice-request wording and "what to ask a lawyer" sheet to counsel first (item 7).
6. **Step 5.** Look-back, two stage notes, teammate kit (items 8 to 10), then write the missing customer and wind-down playbooks.
7. **Step 6, only with 20 or more founders and four weeks of data.** Decide what to hardcode: ungating Now and Not doing, a founder-pairing prompt, a cadence tip.

## 8. Decisions only you can make (management layer)

1. **Who pays for the manager's AI?** Recommended: a small hosted allowance per project per week from the operator, then the founder's own agent and key. This protects the shared 2,000-a-day pool.
2. **Do we carry the Drucker code across?** Now, Not doing and the 28-day review are built but gated to the contributor projects the plan retires. Recommended: no for now; the manager asks the same questions in words. Revisit at Step 6 with evidence.
3. **Where do human advisors come from, and are they paid?** Recommended: volunteers (backers and past founders) through existing help requests, and paid advice as an ordinary task in dollars. No wording about giving Shares for advice until counsel reads it. Note: Shares given after the pool opens are free at once, so they do not vest.

## 9. The project brain

**Where this comes from.** A widely shared list of practices for running a company with AI agents (outside knowledge; the tool names in it were not checked, only the principles are used). Its core idea: the models are the same for everyone, so the only part that is yours is your context, kept as plain files that agents read before any task. Most of the list is either already how this repo is built, or aimed at a staffed company, or at outbound marketing we would rather not automate. Four ideas fit Creaton and belong in the product for founders.

**What it is.** When a founder presses Start, the project gets one folder of plain markdown files in git, the project's brain. Git gives every change a history for free, and the founder owns and can take the folder away.

| File | What it holds | Who writes it |
|---|---|---|
| `AGENTS.md` | One instruction file at the top: read these files before any task, never overwrite, always date what you add, and the rules an agent on this project follows (it drafts, a person signs) | Template, founder may edit |
| `facts.md` | True statements about the project that an agent is allowed to say: what it does, who it is for, real numbers with a date, what is explicitly not claimed. Anything not here, or not in the project brief, is dropped from drafts | Founder; the manager proposes additions, the founder approves |
| `voice.md` | A few posts the founder likes, a few they dislike, and words they never use. Used only to draft "What happened" | Founder |
| `decisions.md` | Dated one-line decisions with the reason. The manager asks "what did you decide and why" after a missed promise | Founder, drafted by the manager |
| `playbooks/` | The project's own repeatable jobs, one small file per job (when to use it, steps, checks, mistakes to avoid) | Founder, from a recorded run |

**Why a facts file matters most.** Made-up claims are the main failure of an AI that drafts public updates. The honesty envelope in section 5 already drops numbers and names that are not in the project brief. The facts file gives it a second, founder-owned source of allowed statements, and it is also the cleanest way to keep a founder's public claims from drifting into promises of returns. The same idea applies to Creaton itself: a facts file of what we may say about the product, including the existing legal lines word for word, would give our own marketing and agents a checked source. Counsel owns that file, not us.

**How the manager uses it.** It reads `facts.md`, `voice.md` and `decisions.md` together with the project brief (item 1). Every drafted line must cite a brief item or a facts-file line, or it is dropped. It drafts "What happened" in the voice file's style and never drafts "What's next", which stays typed by the founder because those lines become signed promises. It may propose a new line for `facts.md` but cannot write it.

**What is already in the repo, and what is not (code check).** `buzz repos create` and the relay's git hosting exist (`crates/buzz-cli/src/commands/repos.rs`), and a repository's access depends on a channel binding there. Not checked: whether a project already has a channel to bind to, and whether Start can create the repository in the same press. Both are to be verified at step B1 below. Nothing else about the brain exists today.

**Build steps (small, can start beside milestone 0, no contract or record-kind change).**
1. **B1, text and one command.** Write the five templates; a `buzz` command that scaffolds the folder into a project's repository; verify the channel binding question above. Test: the scaffold creates exactly these files and refuses to overwrite.
2. **B2, the manager reads it.** Extend the brief fetch to include the three files; extend the honesty eval with planted records so a claim absent from `facts.md` is dropped and a claim present passes.
3. **B3, Start offers it.** One optional line on the first-week card ("Keep a project brain"), no new field, inside the press and field budgets.
4. **B4, the recorded-run skill.** After a founder does a job once while explaining it (voice note or text), the manager drafts a `playbooks/<job>.md`. Only after 5 to 10 founders have used B1 to B3 by hand. *Status 2026-11-22: built ahead of that gate, on the lead's decision, for text only: `buzz launchpad brain skill` turns notes under headings into a skeleton the founder reads before `--save`; no AI service is called and no audio is read. Not yet tried by real founders.*

**Risks, plainly.**
- A stale facts file makes the manager quietly wrong. Each fact carries a date, and the quiet line also shows "facts last checked N days ago".
- The facts file can turn into marketing copy. The template says what is not claimed, and the legal lines are not editable in it.
- Secrets or private data pasted into a repository. The scaffold warns once, says nothing in it is private if the repository is public, and refuses files that look like keys.
- Founders never open it. That is why the manager reads it, not the founder.
- Whether the repository should be public by default is a decision, below.

**What we skip from the list, and why.** Outbound that runs itself, AI ad loops and AI-made video or UGC at scale: a launchpad sells trust, and ad platforms restrict financial promotion. A data warehouse and a local model: too early. A never-off orchestrator: one standing manager per project is enough. A pile of marketing skill packs: install none until a founder asks.

**One extra decision for you.** Public or private by default for the project brain? Recommended: the folder is public with the project, except `voice.md` and any file the founder marks private, because the public record is the point and `facts.md` is only useful if it is the same text the public can read.
