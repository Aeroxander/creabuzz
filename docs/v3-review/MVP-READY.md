# Is it ready? One page for the owner

Written 2026-11-15, after the push that built Start in one press, the update loop, tasks with a finish line, share pictures,
Discover by kept promises, the AI project kit and the backing pool's leave and depth changes. Plain answer first.

**The loop is built and checked on a laptop. It has not been checked by a stranger on a hosted server, and nobody has
hand-tested the new screens.** What stands between this and three to five founders is a short list of things only you can
do (below), then Pilot A ([PILOT-RUNBOOK.md](PILOT-RUNBOOK.md)). The product is described in [DIRECTION.md](DIRECTION.md);
the status index is [STATUS.md](STATUS.md); each choice made while building is a row in [DECISIONS.md](DECISIONS.md)
(D189 to D199 are new).

## What a stranger can do today, in the app, in order

No chain, no Shares and no price are involved in any of these steps.

1. **Start in one press.** Open an invite link, type three answers (the project's name, its goal, and how everyone will know
   the goal was reached), press Start. If the person has no account yet, signing up finishes the start; there is no second
   press. The one-line pitch is made from the goal (editable under "Edit the one-liner"). The line "Free to start. No token
   needed." sits under the heading. The project opens on its page with a welcome card.
2. **Their first week, on the project page.** A welcome card with a share picture, a first-week list that asks for one thing
   at a time (post the first update, ask for help, add a person), and no empty cards. Other cards appear when the project uses them.
3. **Post the weekly update with the AI draft.** "Draft from the record" fills "What happened this week" from what the project
   has already recorded (promises answered, work accepted). It uses only the record, drops any line that cites a number,
   link, name, weekday or month the record does not have, and never writes "What's next". The founder reads and edits
   everything before signing. A weekly calendar reminder file (any calendar app) and an update day (kept in that browser) come
   with it. **Nothing is emailed or pushed from the app.** If the AI service's daily cap is reached, the person sees the
   server's own plain sentence instead of a vague error.
4. **Ask for help.** "Help needed" in the update becomes a request on the project; others offer; the project page and Work show them.
5. **Hand in work with numbers.** A helper hands in evidence and says how they checked it; they can report numbers (bounded
   the same way on the server and in the app) and cite a signed run record. The task shows those numbers labelled as the
   helper's own, with a reading against the limit written in "Done means" ("not stated" when it cannot tell). A plain hint under
   "Done means" and an AI proposal of sharper words help whoever writes the task. Someone other than the helper confirms.
6. **Accepted work.** After a confirm, the Record offers a share picture of the accepted work for that visit only.
7. **Share a picture.** The project, a kept promise and accepted work each have a 1200 by 630 picture (no price, no returns).
   "Post to Home" posts a plain note about the project with the picture. A pasted project link shows a real preview (name,
   pitch, goal) on an open server, never for a private project, and nothing on an invite-only server.
8. **Scorecard.** The public page of promised, delivered, missed and changed course. Its share words and pictures count weeks in a row only from
   at least 2 answered promises.
9. **Discover.** Opens on "Most reliable": a run of weeks paired with kept promises, never money. Cards show the project's
   latest one-line and a kept count. Chips: Software, AI agent or tool, Creative, Community, Other.
10. **Home.** A feed of records with a founder's cheer line, "Just started", an update-day rail and a week in review, so a
    quiet server does not look dead. It is the one place a price line may appear, and only if investing is on.
11. **A visitor with no invite** on an invite-only server is told so ("You need an invite to open this project", who to ask,
    a Sign in button). It no longer says "Couldn't open this project."

## What an AI project gets

- **Four starter kinds** under the "AI agent or tool" category: AI app, Agent or tool, Dataset or benchmark, AI media. Each
  has starter wording for goal ideas and "how we will know" with numbers, three first promises and starter tasks. **This is
  wording only**: the promises and tasks are shown, not written to the project.
- **A command line for an agent** (`buzz launchpad ...`): start a project, read its inbox, post an update from facts, hand in
  numbers, bind a run record. Written down as the worker loop in [docs/agents/WORKER-LOOP.md](../agents/WORKER-LOOP.md) and
  [JOINING.md](../agents/JOINING.md); a test checks that every command in them parses.
- **Run records.** A helper's signed run record for a piece of work is found and shown only if the helper signed it.
- **Agent rules, unchanged:** an agent account is labelled and names who runs it. It may offer, do work, hand in evidence and
  draft text. It may not vote, award Shares, move money or confirm its own work. It cannot sign a goal or a promise, so a
  person starts the project and adds the agent to the team (decision 5 below). The page says plainly when it cannot tell who
  runs an agent.
- **"Open to agents"** on Work narrows requests to AI-category projects. It is a filter, not a flag a founder sets.

## What is deliberately off

- **Investing and trading are off in every hosted build.** The switch is `VITE_INVESTING=1` with three addresses; how to turn
  it on, what it shows and what it does not do are in [INVESTING-SWITCH.md](INVESTING-SWITCH.md). Trading is a second,
  independent switch and stays off. Nothing in the pilot image names a market.
- When it is on: backers leave at a milestone **without selling** (they keep their units, get back the money held for the
  project, less a small fee that never costs more than staying one more step); units that already left are tracked
  separately; the founder picks the curve depth from seven tiers when opening backing. The contracts have no outside audit
  and counsel's questions are open: test networks only.
- Also off: raises, weekly sales, the court, forecasts with money, boards as a separate place, the desktop and mobile apps.
- Reminders are in-app and calendar only. Link previews carry only the project's own words.

## What the numbers are

Reported by the engineers who built each part, on their own machines; none is a hosted run, an audit or a hand test.

| What | Result | What it does not prove |
|---|---|---|
| Web unit tests (`pnpm test`) | 3,338 pass, 0 fail (backing batch); 3,418 run in the first-week batch with 1 failure it then fixed | Not re-run as one final pass after the last commits |
| Core package tests | 1,001 pass, 0 fail | The page is not exercised, only the logic |
| Contracts (`forge test`) | 100 suites, 1,115 pass, 0 fail, 2 skipped (Sepolia fork) | Nobody outside the team has read the Solidity |
| Rust (relay, CLI, core) | Relay link preview and AI cap: 166 unit tests and 9 database tests; CLI 822 unit tests; hand-in bounds 4 + 12 + 7 | The whole workspace and `just test` were not run as one |
| Mocked browser specs | Each batch ran its own: Start 6 of 6, project page 27 of 27, first week 14 of 14, update loop 7 of 7, share pictures 7 of 7, tasks 10 of 10, Home 12 tests, Discover 4 of 4 | A mocked page is not a real server; the full mocked suite was not run in one go |
| Real-chain backing journey | 5 of 5 against a local chain, including a real leave that keeps units | The depth picker is exercised only in the mocked spec, not from the page against real contracts |
| Project loop on a real server | 10 of 10 open and 10 of 10 invite-only, on 2026-11-15 **before** the first-week page, Start in one press and the new Discover tab | **Not re-run since.** The specs for those pages were edited without a real server; run `scripts/real-loop-e2e.sh` first |
| Pilot gate (`scripts/mvp-gate.sh --pilot`, 11 journeys) | Each journey passed alone earlier; the set in one run was never run, and no CI run is recorded | A green gate does not replace the hand checks in [PILOT-TEST-GUIDE.md](PILOT-TEST-GUIDE.md) |
| Guards (copy, text sizes, types, lint) | Passed by each engineer on their files; the full `pnpm check` (which includes knip) was not run by anyone | Run it before merging |

Every new test was shown to fail when the production code it guards was broken (the engineers' mutation checks are in their reports).
**Not reviewed:** an independent review of the backing contract found 1 blocker and 3 important points; all four were fixed
(commit 871b0e8, a20d191) and the fixes were not reviewed again. 14 optional points are left, mostly about the leave fee
following the live price (the app sets a limit from the pool's own quote so a payout cannot silently go to zero).

## What only you can do

Written steps exist for most of these. For anything that needs a key or a command with an address in it, **ask the assistant
for the exact command**; nothing here contains a key.

1. **Restore rehearsal** on a second machine with your real backup and private backup key ([RESTORE-REHEARSAL.md](RESTORE-REHEARSAL.md), about two hours).
2. **Backups** scheduled and old ones pruned ([deploy/compose/README.md](../../deploy/compose/README.md), "Backups").
3. **Outside uptime check with an alert on your phone**, tested once ("Uptime check").
4. **Database rebuild:** this push changed no migration or schema file (checked), so it adds no new step. The one you need is a
   restored copy from the rehearsal above. The brief for this page listed a "database rebuild" chore; if you meant something
   else, say so.
5. **Email provider:** nothing in this push sends email. You need one only if you later want reminders outside the app; today
   you are the reminder (`./run.sh due`, then a message from you, logged).
6. **Token revocations and key restrictions:** revoke any development or test keys that were ever pasted into a chat, a
   terminal or a file, and make each new key as narrow as the provider allows (the AI service key, the chain node key, the
   ZeroDev key if you use one). These came from the brief, not from a file in the repository; I checked none of them.
7. **Legal reads, with counsel:** the policy drafts; showing returns in Home's feed; the words "Thanks for saying so", "Good
   luck" and "Cheer"; and questions 9 and 10 added to BACKING-POOL.md (is a fee on units that never sold a sale fee; does the
   founder choosing the depth make the founder more clearly the issuer). Legal text in the app is untouched.
8. **Sepolia redeploy.** The pool contract changed (leave keeps units, depth tiers, a new event), so any copy already on
   Sepolia is out of date. Needed only for the investing switch or the contributor run, not for Pilot A. Ask the assistant for
   the exact command.
9. **Start Creaton's own project** from [CREATON-EXAMPLE-PROJECT.md](CREATON-EXAMPLE-PROJECT.md) before the first invite.

## Owner decisions

Each has the question, my recommendation, and what changes if you say no. Where I built something, the recommendation is to keep it.

**The pilot**

1. **Run Pilot A (founders, no chain) before the contributor run?** Yes. No: the social run goes first as before, and Pilot A waits.
2. **Will you post weekly on Creaton's own project for the whole run?** Yes. No: say so before the run and the example project is taken down, not left silent.
3. **What counts as a yes for the one number?** At least 3 founders with a third update, and at most 1 of those after a message from you; written in the report header before day 1. No: pick your own line, but before day 1.
4. **What does a visitor without an invite get on an invite-only server?** Keep what is built: told plainly and offered Sign in, shared links reach members only, a private project's name never shown. No (open public reads of the scorecard): a counsel and moderation question, and the preview and example-project link would then work signed out (D107, [HOLDER-ACCESS-MODEL.md](HOLDER-ACCESS-MODEL.md)).

**Agents and tasks**

5. **Agent-started projects have no goal, because only a person can sign one.** Keep the rule: a person starts the project and adds the agent. No: the web app needs a "set the goal for my agent" path, which widens what an agent account can cause.
6. **What should "Open to agents" mean?** Keep the filter for the pilot. No: a founder-set flag on a help request, which changes the update record, the update dialog and the command line.
7. **Agent line wording.** For a proven operator the page says they "answer for them and sign the promises", but a promise is signed by the founder alone. Recommend "answers for them" only. No: the line stays and can be literally untrue when operator and founder differ.
8. **Show "meets the stated threshold" at all?** Yes, labelled as the helper's own number; it says "not stated" when unsure. No: show the numbers and the limit with no reading.
9. **Check lines and "Was every step needed?" as labelled words (built) or as bounded tags?** Keep the words for the pilot. No: new tags and bounds in the server rules and the command line.
10. **May the AI "sharper words" button suggest placeholders like [how many]?** Yes. No: it must then say nothing when a number is missing.

**Start, updates, sharing**

11. **Keep the pitch field dropped (the one-liner is made from the goal)?** Yes. No: one flag, `pitchOpen`, brings the field back.
12. **Write the AI kinds' first promises and starter tasks into the project?** Not yet. Yes: needs a decision on the record's shape and the update and task work.
13. **Retire the older "AI agents" category** once old projects are retagged? Yes, later. No: the picker keeps two AI choices.
14. **Save the update day on the server** so it follows the founder to another device? Not before Pilot A. Is the default (the weekday the project started) right? Yes.
15. **Is the public chip "Update late by N days" neutral enough** next to the founder's "due" wording? Keep for now. No: it says "due" too.
16. **Is a plain note on Home the right post for "Post to Home"** (not an official update)? Yes. No: marked as an official update, which only the founder could post.
17. **Where should the accepted-work picture live so it outlasts the confirm?** Leave it. No: the Record line for everyone, the helper's profile, or a notice to the helper.

**Home and Discover**

18. **Confirm the ranking rule:** weeks in a row count only with at least 2 answered promises and kept at least missed plus unanswered; "a real update" means it makes or answers a promise, or its one-line is 24 characters or more; "Most reliable" is the default tab. Yes. No: ranking falls back to recency and the thresholds change.
19. **How is the server's own example project found by a signed-out visitor?** Members only for now. No: publish the owner key in the server's public info, or add a build setting naming the project.
20. **Should the founder's cheer line also reach the bell and Notifications?** No, not yet. Yes: it joins "mentions or notices in your rooms", which was kept clear on purpose.
21. **When does "This week on Creaton" start counting?** From the oldest project, Creaton's own included. No: from the first founder's project.

**Cost and money (investing stays off)**

22. **The pool's leave fee.** Built: capped at the leaver's own part of the next release, so leaving is cheaper than staying at the first milestone and about equal from the fifth at a flat price. Keep. No: a higher rate or a floor tied to the release share (not built).
23. **Depth tiers** 5k, 10k, 25k, 50k, 100k, 250k, 500k with 25k as the usual, and the rule "pick one about twice what you hope to raise". Confirm; consider dropping the 5k tier before any real money, because it gives early buyers a large price multiple. No: change the list in the factory before the next deploy.
24. **Does the "Suits raising up to about X" line count as showing price?** No, it shows an amount in the quote token, not a price. Yes: it moves to Home's feed or goes.
25. **Offer the depth picker on Start's one-step launch?** No, the usual depth. Yes: more to explain on the first screen.
26. **Keep the extra `DepthChosen` event** (about 1.4k gas per opening)? Yes. No: drop it, the depth cannot be read back for a round pool after it seeds.
27. **Leave then sell costs the ordinary 1% twice (about 1.8%).** Keep and say so. No: lower the leave fee or add a one-step helper.
28. **The AI service caps** (500 calls a day per account, 2,000 a day for the whole community; no per-project cap). Keep. No: change `BUZZ_LLM_MAX_CALLS_PER_DAY` and `..._TOTAL`.
29. **Who pays Creaton's costs until income exists, and the other money questions** ([BEAR-MARKET-MONEY.md](BEAR-MARKET-MONEY.md), 12 questions). Recommended: you, up to a monthly ceiling, reviewed after Pilot A; "free to start, no token needed" as the headline; no fee on trades, ever; one hand-run sponsored season; counsel in one batch after Pilot A. No: each of those stays open and nothing is built on it.
