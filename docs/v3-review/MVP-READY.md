# Is it ready? One page for the owner

Written 2026-11-15, after the push that built Start in one press, the update loop, tasks with a finish line, share pictures,
Discover by kept promises, the AI project kit and the backing pool's leave and depth changes. **Updated later the same day:**
you asked the assistant to make this page's owner decisions itself and work on them. Each call is now a line in "Decided"
below, with whether it is built; what is left for you is under "Still yours". Plain answer first.

**The loop is built and checked on a laptop. It has not been checked by a stranger on a hosted server, and nobody has
hand-tested the new screens.** What stands between this and three to five founders is a short list of things only you can
do (below), then Pilot A ([PILOT-RUNBOOK.md](PILOT-RUNBOOK.md)). The product is described in [DIRECTION.md](DIRECTION.md);
the status index is [STATUS.md](STATUS.md); each choice made while building is a row in [DECISIONS.md](DECISIONS.md)
(D189 to D199 record the first push as built; D200 to D217 record the calls of 2026-11-15 and what was built from them).

## What a stranger can do today, in the app, in order

No chain, no Shares and no price are involved in any of these steps.

1. **Start in one press.** Open an invite link, type three answers (the project's name, its goal, and how everyone will know
   the goal was reached), press Start. If the person has no account yet, signing up finishes the start; there is no second
   press. The one-line pitch is made from the goal (editable under "Edit the one-liner"). The line "Free to start. No token
   needed." sits under the heading. The project opens on its page with a welcome card.
2. **Their first week, on the project page.** A welcome card with a share picture, a first-week list that asks for one thing
   at a time (post the first update, ask for help, add a person), and no empty cards. Other cards appear when the project uses
   them. In the Pilot A build, which names no contributor kit, the next steps say nothing about Shares (D214).
3. **Post the weekly update with the AI draft.** "Draft from the record" fills "What happened this week" from what the project
   has already recorded (promises answered, work accepted). It uses only the record, drops any line that cites a number,
   link, name, weekday or month the record does not have, and never writes "What's next". The founder reads and edits
   everything before signing. A weekly calendar reminder file (any calendar app) and an update day (kept in that browser) come
   with it. **Nothing is emailed or pushed from the app.** If the AI service's daily cap is reached, the person sees the
   server's own plain sentence instead of a vague error.
4. **Ask for help.** "Help needed" in the update becomes a request on the project; others offer; the project page and Work show them.
5. **Hand in work with numbers.** A helper hands in evidence and says how they checked it; they can report numbers (bounded
   the same way on the server and in the app) and cite a signed run record. The task shows those numbers labelled as the
   helper's own, with a reading against the number written in "Done means" (a plain line when there is no number to compare
   with). A plain hint under "Done means" and an AI proposal of sharper words help whoever writes the task. Someone other than
   the helper confirms. **One exception, built in this push and not yet approved by you:** a founder with nobody else on the
   project may press "Mark as done" on their own work; it is shown as checked by them alone and counted apart from work
   someone else accepted (D217).
6. **Accepted work.** After someone else confirms, the Record offers a share picture of the accepted work for that visit only.
7. **Share a picture.** The project, a kept promise and accepted work each have a 1200 by 630 picture (no price, no returns).
   "Post to Home" posts a plain note about the project with the picture. A pasted project link shows a real preview (name,
   pitch, goal) on an open server, and on an invite-only server only when the server lets anyone read public records (step
   11). Never for a private project.
8. **Scorecard.** The public page of promised, delivered, missed and changed course. Its share words and pictures count weeks in a row only from
   at least 2 answered promises.
9. **Discover.** Opens on "Most reliable": a run of weeks paired with kept promises, never money. Cards show the project's
   latest one-line and a kept count. Chips: Software, AI agent or tool, Creative, Community, Other. Where no sales are offered
   (the pilot build) it is one list, and every entry is counted as a project, not an idea (D213).
10. **Home.** Opens on Updates, the feed of project records, for everyone, signed in or not; a tab a person picked is kept in
    their browser (D212). The feed has a founder's cheer line, "Just started", an update-day rail and a week in review, so a
    quiet server does not look dead. It is the one place a price line may appear, and only if investing is on.
11. **A visitor with no invite** on an invite-only server reads a public project's record, when the server allows it (D201).
    They see the goal, the run of weekly updates, promises kept, missed and changed, the latest update and accepted work, with
    the line "Anyone can read this project's record. To follow it, help or post, you need an invite." and a Sign in button.
    They cannot follow, help or post. Work still waiting for a check, offers of help, the reasons work was sent back and
    anything from a room are never sent to them, and a project whose record states the terms of a sale stays closed to them.
    A busy server says "This project's record can't be opened right now." with Try again. With the setting off, or for a
    project the server does not open to visitors (not listed, removed, its founder muted or banned, or one with sale terms),
    they get the earlier words: "You need an invite to open this project", who to ask, and Sign in.
    The setting is on in the deploy example for Creaton's own server ("What is deliberately off" says how to turn it off).
12. **A visitor with no account on Home** is offered "See a record", which opens the project the server names as its example
    (D202). That name is not filled in yet: it waits for Creaton's own project ("What only you can do", 9).

## What an AI project gets

- **Four starter kinds** under the "AI agent or tool" category: AI app, Agent or tool, Dataset or benchmark, AI media. Each
  has starter wording for goal ideas and "how we will know" with numbers, three first promises and starter tasks. **Nothing
  is written for the founder.** Since this push the first weekly update offers the four kinds by name, and one press fills an
  empty "What's next" with that kind's three promises; the task form offers the kind's starter tasks the same way. The founder
  reads, edits and signs (D206). The kind picked on Start is not stored, which is why the founder picks it again there.
- **A command line for an agent** (`buzz launchpad ...`): start a project, read its inbox, post an update from facts, hand in
  numbers, bind a run record. Written down as the worker loop in [docs/agents/WORKER-LOOP.md](../agents/WORKER-LOOP.md) and
  [JOINING.md](../agents/JOINING.md); a test checks that every command in them parses. On an AI project's page those commands
  now sit under "For agents: the commands", closed until someone opens it (D203).
- **Run records.** A helper's signed run record for a piece of work is found and shown only if the helper signed it.
- **Agent rules, unchanged:** an agent account is labelled and names who runs it. It may offer, do work, hand in evidence and
  draft text. It may not vote, award Shares, move money or confirm its own work. It cannot sign a goal or a promise, so a
  person starts the project and adds the agent to the team (decision 5 below). For a proven operator the page says they
  answer for the agents, and no longer that they sign the promises (decision 7). The page says plainly when it cannot tell
  who runs an agent.
- **"Open to agents"** on Work narrows requests to AI-category projects. It is a filter, not a flag a founder sets (decision 6).

## What is deliberately off

- **Investing and trading are off in every hosted build.** The switch is `VITE_INVESTING=1` with three addresses; how to turn
  it on, what it shows and what it does not do are in [INVESTING-SWITCH.md](INVESTING-SWITCH.md). Trading is a second,
  independent switch and stays off. Nothing in the pilot image names a market.
- When it is on: backers leave at a milestone **without selling** (they keep their units, get back the money held for the
  project, less a small fee that never costs more than staying one more step); the leave form says before the press that
  selling the kept units later is a separate step with its own fee; units that already left are tracked separately; the
  founder picks the curve depth from six tiers when opening backing (10,000 the shallowest, 25,000 the usual; the 5,000 tier
  was dropped, D208). The contracts have no outside audit and counsel's questions are open: test networks only.
- **A server with no money shows no money cards.** In a build with no sales, investing off and no contributor kit (the Pilot A
  image), Portfolio's "Project Shares you hold" card, the profile's payment wallet card and the Score are hidden. No legal
  text is hidden by this (D214).
- **Reading without an invite is a server setting, off unless the operator sets it.** `BUZZ_PUBLIC_PROJECT_READS=true` is in
  `deploy/compose/.env.creaton.example` for Creaton's own server; set it to false and restart, and a visitor with no invite
  is told to ask for one, as before. It opens only the records listed in step 11, only on a server the operator made
  invite-only as a whole, and never a project that states the terms of a sale. Counsel has not read it ("Still yours", 4).
- Also off: raises, weekly sales, the court, forecasts with money, boards as a separate place, the desktop and mobile apps.
- Reminders are in-app and calendar only. Link previews carry only the project's own words.

## What the numbers are

Reported by the engineers who built each part, on their own machines; none is a hosted run, an audit or a hand test.

| What | Result | What it does not prove |
|---|---|---|
| Web unit tests (`pnpm test`) | 3,432 of 3,433 pass, 0 fail, 1 skipped, run as one pass on the final tree (2026-11-15), with the type check and the full `pnpm check` (knip included) | The page is not exercised by these |
| Core package tests | 1,002 pass, 0 fail | The page is not exercised, only the logic |
| Contracts (`forge test`) | 100 suites, 1,115 pass, 0 fail, 2 skipped (Sepolia fork) | Nobody outside the team has read the Solidity |
| Rust (relay, CLI, core) | Relay link preview and AI cap: 166 unit tests and 9 database tests; CLI 822 unit tests; hand-in bounds 4 + 12 + 7 | The whole workspace and `just test` were not run as one |
| Mocked browser specs | Each batch ran its own: Start 6 of 6, project page 27 of 27, first week 14 of 14, update loop 7 of 7, share pictures 7 of 7, tasks 10 of 10, Home 12 tests, Discover 4 of 4 | A mocked page is not a real server; the full mocked suite was not run in one go |
| Real-chain backing journey | 5 of 5 against a local chain, including a real leave that keeps units | The depth picker is exercised only in the mocked spec, not from the page against real contracts |
| Project loop on a real server | 10 of 10 open on the final tree (2026-11-15), after Start in one press, the first-week page and the new Discover tab; 10 of 10 invite-only on the tree before the last screen-audit fixes | Not a hosted server and not a stranger; the invite-only run was not repeated after the last small web fixes |
| Pilot gate (`scripts/mvp-gate.sh --pilot`, 11 journeys) | Each journey passed alone earlier; the set in one run was never run, and no CI run is recorded | A green gate does not replace the hand checks in [PILOT-TEST-GUIDE.md](PILOT-TEST-GUIDE.md) |
| Guards (copy, text sizes, types, lint) | `pnpm check` (includes knip) and the type check pass on the final tree | The mocked browser suite and CI were not run as a whole |
| The decisions push, later on 2026-11-15 (the tier change, public reads, the screen items), as its engineers reported it; the lead corrects the final numbers | Contracts after the tier change: 1,117 pass. Relay tests for public reads, previews and the server's information: 71 pass, 0 fail, database tests included. The whole relay library: 1,667 pass, 1 fail (a mesh demo test this push did not touch), run before the last relay commit. Web unit tests over the changed features: 2,210 pass, 0 fail. Mocked browser specs, in batches: every failure but one came from Home's new opening tab and was fixed; `dao-os.spec.ts:167` still fails on a label that changed in an earlier commit; the pilot build's set: 21 pass, 1 skipped. Project loop on a real server, now eleven steps: 11 of 11 invite-only with public reads on, 11 of 11 with them off, 11 of 11 open | Not a hosted server and not a stranger. The full mocked suite, the investing specs and `pnpm check` were not run as a whole. The public-read limits were not load-tested. A signed-in person who is not a member was not tried in a browser. The founder-alone change (D217) was reported to this page by no engineer: its tests are named in its commits only |

Every new test was shown to fail when the production code it guards was broken (the engineers' mutation checks are in their reports).
**Not reviewed:** an independent review of the backing contract found 1 blocker and 3 important points; all four were fixed
(commit 871b0e8, a20d191) and the fixes were not reviewed again. 14 optional points are left, mostly about the leave fee
following the live price (the app sets a limit from the pool's own quote so a payout cannot silently go to zero).
A review of the public reads found 1 blocker (every record about a project was served, evidence under review included) and 4
important points; all five were fixed with tests (ce3c66e, 6aa9a53, 27f86c4), and no second review of those fixes is reported.

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
   founder choosing the depth make the founder more clearly the issuer). Since this push also the public record on an
   invite-only server ("Still yours", 4). Legal text in the app is untouched.
8. **Sepolia redeploy.** The pool contract changed (leave keeps units, six depth tiers, a new event), so any copy already on
   Sepolia is out of date. Needed only for the investing switch or the contributor run, not for Pilot A. Ask the assistant for
   the exact command.
9. **Start Creaton's own project** from [CREATON-EXAMPLE-PROJECT.md](CREATON-EXAMPLE-PROJECT.md) before the first invite. Then
   put the end of its shared address (what follows `/p/`) in `BUZZ_EXAMPLE_PROJECT` in the server's `.env` and restart, so a
   visitor with no account is offered "See a record" on Home (D202). Until then that button is not shown to them.

## Owner decisions

You asked the assistant to make these calls itself and work on them. It did, on 2026-11-15. The numbers are the ones this
page has always used, so older references still point at the right line. "Kept" means what was already built stays and
nothing new was needed. Each call can still be reversed by you; its row in [DECISIONS.md](DECISIONS.md) says what was built
and what was left out.

### Decided

**The 29 questions**

| # | Question | The call | Built? | Row |
|---|---|---|---|---|
| 1 | Run Pilot A (founders, no chain) before the contributor run? | Yes | Nothing to build | D200 |
| 2 | Will you post weekly on Creaton's own project for the whole run? | **Still yours** (recommended: yes) | | D200 |
| 3 | What counts as a yes for the one number? | At least 3 founders with a third update, and at most 1 of those after a message from you | Written in the header of [PILOT-REPORT.md](PILOT-REPORT.md) | D200 |
| 4 | What does a visitor without an invite get on an invite-only server? | They read a public project's record, when the server's setting is on | Built, and on for Creaton's own server in the deploy example. Counsel has not read it | D201 |
| 5 | Agent-started projects have no goal, because only a person can sign one | Keep the rule: a person starts the project and adds the agent | Kept | D203 |
| 6 | What should "Open to agents" mean? | A filter | Kept | D203 |
| 7 | Agent line wording | "answers for them" only | Built | D203 |
| 8 | Show the reading against the number in "Done means"? | Yes, labelled as the helper's own number | Kept | D204 |
| 9 | Check lines and "Was every step needed?" as labelled words or bounded tags? | Labelled words | Kept | D204 |
| 10 | May the AI "sharper words" button suggest placeholders like [how many]? | Yes | Kept | D204 |
| 11 | Keep the pitch field dropped? | Yes | Kept | D205 |
| 12 | Write the AI kinds' first promises and starter tasks into the project? | Partly: offered as an editable prefill of the first update and as one-press task suggestions; nothing is sent without the founder's signature | Built, with no change to any record's shape. The founder picks the kind by name, because Start does not store it | D206 |
| 13 | Retire the older "AI agents" category? | Yes, later | Not built | D205 |
| 14 | Save the update day on the server? | Not before Pilot A; the default weekday is right | Not built: it stays in the browser | D205 |
| 15 | Is the public chip "Update late by N days" neutral enough? | Keep it | Kept | D205 |
| 16 | Is a plain note right for "Post to Home"? | Yes | Kept | D205 |
| 17 | Where should the accepted-work picture live? | Leave it where it is | Kept | D205 |
| 18 | Confirm the ranking rule | Confirmed | Kept | D207 |
| 19 | How is the server's own example project found by a signed-out visitor? | The server names it, in a server setting | Built. The name is not filled in until Creaton's own project exists | D202 |
| 20 | Should the founder's cheer line also reach the bell and Notifications? | No | Kept | D207 |
| 21 | When does "This week on Creaton" start counting? | From the oldest project, Creaton's own included | Kept | D207 |
| 22 | The pool's leave fee | Keep the cap | Kept | D209 |
| 23 | Depth tiers | Drop the 5,000 tier: six tiers, 10,000 the shallowest, 25,000 the usual | Built. A hard bound on the price multiple is not built | D208 |
| 24 | Does the "Suits raising up to about X" line count as showing price? | No | Kept | D209 |
| 25 | Offer the depth picker on Start's one-step launch? | No | Kept | D209 |
| 26 | Keep the extra `DepthChosen` event? | Yes | Kept | D209 |
| 27 | Leave then sell costs the ordinary 1% twice | Keep it, and say so before the press | Built: the leave form says it | D209 |
| 28 | The AI service caps | Keep them | Kept | D210 |
| 29 | Who pays Creaton's costs until income exists, and the other money questions | **Still yours**: it is your own money | | D211 |

**From the screen audit's list** ([SCREEN-AUDIT-2026-11-15.md](SCREEN-AUDIT-2026-11-15.md), "For you", by its own numbers)

| # | Question | The call | Built? | Row |
|---|---|---|---|---|
| A1 | Where a signed-in person lands on Home | On the feed of project records | Built | D212 |
| A2 | "Three answers" or "four" | Three, everywhere | Built | D213 |
| A3 | What is a project and what is an idea in Discover | Where no sales are offered, a Start project is a project | Built | D213 |
| A4 | Money cards on a server with no money | Hidden | Built | D214 |
| A5 | "Set up Shares" on a project's first day | Offered only after accepted work | Built; the step opening is covered by a unit test only | D214 |
| A6 | The long sentences about a changing team | Kept as they are, for counsel | Kept | D216 |
| A7 | "Free to start. No token needed." | Kept | Kept | D216 |
| A8 | The command text on an AI project's page | Under "For agents: the commands", closed by default | Built | D203 |
| A9 | The contributor form has no goal | Kept | Kept | D216 |
| A10 | The weekly update's layout | Not among the calls: a design task, still open | | D216 |
| A11 | Date style, and one word for followers | One way to write a day; "followers" | Built on the weekly loop's pages; rooms named "Supporters" keep their names | D215 |

### Still yours

Only what the assistant could not or should not decide for you.

1. **Your weekly posting promise (decision 2).** Will you post weekly on Creaton's own project for the whole run? Recommended:
   yes. If no, say so before the run and the example project is taken down, not left silent.
2. **Your money and the cost ceiling (decision 29).** Who pays Creaton's costs until income exists is yours, with the other
   eleven money questions in [BEAR-MARKET-MONEY.md](BEAR-MARKET-MONEY.md), section 6. The one to settle before the door
   opens is a monthly ceiling: the real invoices written down, and a ceiling in money at the AI provider, which the
   repository cannot set for you (the daily call caps are kept, D210).
3. **The token design choices.** They are in [CREATE-BILLION-REVIEW.md](CREATE-BILLION-REVIEW.md), "Five things only you can
   decide this week": whether "make people work for it" is a hard line, the launch gates for CREATE, what happens if Pilot A
   fails, whether a small open panel may select a batch, and whether the accelerator goal goes into DIRECTION.md. That review
   also proposes work that touches decisions 14, 18 and 28 (its section 9, changes 6, 3 and 4): the update day saved on the
   server after Pilot A, a ranking that is harder to game, and a money ceiling for the AI service. Only the ranking change
   would alter a call made here. None of it is decided here.
4. **Counsel's reads.** The list in "What only you can do", 7, and now the public record on an invite-only server before the
   pilot server starts with it on: misses made public about named people, and accepted work's handed-in words, links, files
   and reported numbers reaching anyone. [HOLDER-ACCESS-MODEL.md](HOLDER-ACCESS-MODEL.md) still says evidence text is for
   members only; that sentence is about on-chain submissions, which stay members only, and the document needs a line saying so.
5. **Public reads: what the engineers left for you (D201, D202).**
   - Keep it on for the pilot server, or turn it off until counsel has read it.
   - A project that states the terms of a sale is closed to visitors. Keep that, or allow sale terms to be public.
   - The project record is sent whole, so a visitor's browser also receives the team's account ids, chain addresses, the
     funding stance, the revenue pledge, the token plan, the supply split and the unlock plan. Should any of those also keep
     a project closed?
   - A muted founder's project is hidden from visitors for as long as the mute lasts. Keep, or hide only on a ban.
   - Records by people since taken off the member list are still shown when they are on the project's team or did accepted
     work, as members see them. Confirm.
   - A community that chose invite-only for itself cannot turn public records on. Build that setting, or leave it.
   - The limits are guesses: 300 database reads a minute shared, 120 a minute for one address, an answer kept 30 seconds.
6. **AI kinds: store the kind chosen on Start?** Today the founder picks the kind again on the first update and in the task
   form. Storing it is a new field on the project's record (D206).
7. **The pool: a hard bound on the price multiple.** Dropping the 5,000 tier does not bound it; a raise many times the depth
   still moves the price many times, at any tier. Not built (D208). Investing stays off either way.
8. **A founder alone may mark their own work as done (D217).** Built in this push, and it bends DIRECTION's rule that nobody
   grades their own work. It is shown and counted as checked by the founder alone. Keep it, or take it out.
9. **Smaller calls on words and screens.** The Score is hidden where a server has no money: should it stay visible elsewhere,
   beside "Nobody is scored or ranked"? In a build with a contributor kit, keep the one line saying when "Set up Shares for
   people who help" opens, or show nothing until it does? Rename the rooms and the starter board called "Supporters" to match
   "followers"? Keep "Share an idea" on Discover, and the "idea" badge in a Start project's own header, where no sales are
   offered? And the weekly update's layout (A10), which nobody has designed.
