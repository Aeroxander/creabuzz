# Marketing plan: sell the record, not the token

Written 2026-11-15 for the owner, corrected the same day after three critics' checks. It follows
[CREATE-BILLION-REVIEW.md](CREATE-BILLION-REVIEW.md) and sells only what that review says is true. Read with
[DIRECTION.md](DIRECTION.md), [MVP-READY.md](MVP-READY.md) and [PILOT-RUNBOOK.md](PILOT-RUNBOOK.md). Nothing here
forecasts a price. No stranger has used the product, so every rate and target below is a guess with its arithmetic
shown, to be replaced by the first real count.

Each item carries a mark: **[Today]** possible now; **[After A]** possible once Pilot A has run; **[Waits: x]**
waiting on the named thing.

## 0. The verdict

1. **Market the record. Keep CREATE out of every public word for these 12 weeks.** The review found no reason to
   hold CREATE today. In our judgment (no data) builders, the first audience, leave when a token is the headline.
2. **There is nothing to market to strangers yet.** On the pilot's invite-only server a shared link ends at "You
   need an invite", and the founder who shared it cannot make one. Weeks 1 to 4 are quiet on purpose.
3. **The plan is three steps:** prove the habit with three to five founders (Pilot A, day 0 on Monday 23 November),
   then run one season of up to ten projects from Monday 4 January 2027, and open the door when it is ready.
4. **The season starts invite-only, on the build as it stands.** Public reads, the ranking fix and counsel's answer
   on public misses have no date. The public posts (1, 5 and 6) run when the door opens, not before.
5. **If Pilot A fails, the owner decides, in writing, before day 1:** (a) stop, as [DIRECTION.md](DIRECTION.md)
   says, or (b) run one invite-only season with nothing new built, as the last test. The review recommends (b).
   Weeks 5 to 12 as written below apply only on a pass.
6. **Cost:** about 530 dollars of fixed spend to the season's end, plus 10 to 18 owner hours a week (section 10).
7. **What a pass proves:** that people use a public record in a quiet market. It does not prove a token. Say so.

## 1. The one sentence and four hooks

**The sentence** (from [DIRECTION.md](DIRECTION.md), unchanged): Creaton is where a project states a goal, does its
work in the open, and lets anyone see whether it kept its promises.

| For | Hook | Mark | Why it is true |
|---|---|---|---|
| A founder | "Say your goal. Post once a week. Get a public page that shows what you promised and what you did. Free to start. No token needed." | [Today] for invited founders; the word "public" [Waits: public reads] | Start, the weekly update, promises and the scorecard are built |
| A helper | "Pick a task with a clear finish line. Someone other than you checks it. Keep a record of the work that was accepted." | [Today] | Tasks, evidence and the check are built. Do not say "paid": no pay exists |
| A supporter | "See which projects kept their promises before you give one your time. Misses are shown, and the page says how many records a founder deleted. Promises are marked by each founder." | [Waits: public reads] | Investing is off, so this hook offers reading and following only |
| An AI builder | "Give your agent a real task with a finish line a machine can read. Someone who is not the agent checks the work, and the agent's record names who runs it." | [Today] by the command line, built from source | Server rules and the worker loop are built ([../agents/WORKER-LOOP.md](../agents/WORKER-LOOP.md)) |

Two honest limits to keep beside the hooks. Today the founder marks their own promises, so say "the founder says"
until an outside account can confirm (review, change 9). And a founder running their own agent cannot confirm that
agent's work, so the AI hook always comes with "bring one person to check".

## 2. What we do not say

| Do not say | Why | Say instead |
|---|---|---|
| Anything about returns, profit, price, or a token "going" anywhere | Investing is off; a promise of gain next to a token is the plain pattern of a securities offering | Nothing. The pictures already carry no price |
| "A billion-dollar token", any valuation of CREATE, any date for it | The review's verdict is "as designed, no" | Section 8's four lines, only when asked |
| "No token", flat | Not true: a test token and a token paper are in the open repository | "No token needed", "nothing to buy or trade" |
| "A decentralized Y Combinator" or "community-run accelerator" in public | It is not one yet (review, section 5); the name may invite a trademark complaint (not checked with counsel) | "A season: up to ten projects, eight weeks, every promise on the record" |
| "Verified", "audited", "proven" | Promises are self-marked; numbers on hand-ins are the helper's own; the contracts have no outside audit | "The founder says", "reported by the helper", "checked by someone else on the team" |
| "Misses stay on the page", "cannot be deleted" | A founder can delete the update that holds a miss (`web/src/features/launchpad/lib/promises.ts`, checked). The project page counts deleted records; Discover does not | "Misses are shown, and the page says how many records a founder deleted" |
| "Get paid for tasks" | No money path in the hosted build | "A record of accepted work"; in the season, "a sponsor pays the helper directly" only once a sponsor has signed |
| "Invest in projects", "back with money", "trade" | All off in every hosted build | "Follow", "I can help" |
| "Labour market for agents", agent scores or rankings | It is a record book with no pay (review, section 7) | "A track record for an agent, checked by a person" |
| "Thousands of projects", "growing fast", any count not on the record | No stranger has used it | The real counts, small as they are, misses included |
| A named founder's miss, without their yes | Defamation and fairness | Totals, or a founder who agreed to be quoted |
| Competitors by name | A fight we lose on reach; some outside figures are unverified | "Most launches show a price. This shows a record." |
| "Earn" beside Shares, in any sentence | Repository rule ([PLAIN-WORDS.md](PLAIN-WORDS.md), section 4) | "Shares are how a project thanks people whose work was accepted" |

One outside fact is strong but unverified: press coverage of an analyst's post says 6 of 41 launchpad token sales
since 2025 were above their sale price on 31 March 2026. The data set was not opened. **[Waits: the owner reads
the original]** before it appears in any post.

## 3. The first audience and where they are

This ranking is judgment, not measurement. It matches the review's advice: one narrow group, where founders can be
each other's helpers and readers.

| Order | Who | What they want this week | Where they are |
|---|---|---|---|
| 1 | Solo builders of AI tools and agents with a side project under a year old, who already post progress | A reason to ship on a schedule, a few readers, one helper | Build-in-public threads on X; Discord servers of agent frameworks and AI coding tools; GitHub repositories with about 50 to 2,000 stars |
| 2 | Teams in the two weeks after a hackathon | A way to keep going once the prize is decided | Hackathon Discords and the organisers' lists |
| 3 | Crypto founders who do not want to launch a token in a quiet market | A way to show work without a price | Farcaster; founder Telegram groups |
| Helpers | People from group 1 who want proof of work, and their agents | A clear task and a record | The same rooms. Aim for three helpers a founder (the review's proposal, not data) |

Not yet: supporters as a group. With investing off there is nothing for them to do but read. Email is not built in
these 12 weeks, so the only thing that brings a reader back is the Monday post (post 5).

## 4. The loops the product has, and one number each

| Loop | State | The one number | Can it be counted today? |
|---|---|---|---|
| A. Promise, weekly update, mark kept or missed, promise again | Built. The only outside reminder is the owner | Founders with a third update, and how many of those came after a logged message from the owner (the runbook's wording) | Yes: `./run.sh founders` and `./run.sh due`, plus the owner's message log |
| B. Founder shares the project picture or scorecard, a reader starts a project | Pictures built; link is a dead end on an invite-only server; every project has the same preview image | New founders who name a shared record when asked "how did you hear?" | By hand: the owner asks each new founder. A counted ratio [Waits: public reads and its count of link opens (review, change 5)] |
| C. Help request, offer, accepted work, the helper shares it | Built up to the confirm; the picture goes to the confirmer for one visit only, not to the helper | Share of help requests with an offer from outside the team within 7 days | By hand from the record today; the helper's picture [Waits: MVP-READY decision 17] |
| D. A reader follows and comes back | Follow needs an account; nothing is emailed | None in these 12 weeks | No. Cut: email is review change 6 and no week here builds it |
| E. An agent takes a task and builds a track record | Command line built; installs from source only; no card to show | Labelled agents with one piece accepted by a checker outside their operator | By hand today |
| F. "This week on Creaton" | Worked out in the visitor's browser; published nowhere | Replies to the weekly post | [Today] as a hand-made post for members; public [Waits: public reads] |

Live projects (an update in the last 8 days) is the headline count. Loop B is the only measure of spread, and
until the door opens it is a hand count of answers, not a rate.

## 5. Twelve weeks, week by week

Dates assume the owner starts Monday 16 November 2026. Pilot days follow [PILOT-RUNBOOK.md](PILOT-RUNBOOK.md): day 0
invites, day 1 calls, day 7 and day 14 reminders, day 15 count and decision. Owner hours are a floor (section 10).
"The assistant" means the AI assistant working in this repository; "the product" means what the app or the operator
commands produce unaided.

### Before and during Pilot A (weeks 1 to 4)

| Week | Owner does | Hours | The assistant or the product produces | Mark |
|---|---|---|---|---|
| 1 (16 to 22 Nov) | Finish the owner-only chores in [MVP-READY.md](MVP-READY.md) (server, backups, restore rehearsal, uptime alert). Hand-check the new screens with [PILOT-TEST-GUIDE.md](PILOT-TEST-GUIDE.md). Set a monthly money ceiling at the AI provider before any invite (review, change 4). Pick three to five founders, at least one with an AI project, an agent and a second person to check it. Write the yes line and the answer to "if it fails: stop, or one invite-only season" in the report header. Ask counsel for a price and a date for one batch of three questions. Post Creaton's own first update | 15 | The invite message, the 15-minute call script and the five interview questions as drafts; Creaton's own "just started" picture | [Today] |
| 2 (23 to 29 Nov) | Day 0, Monday 23 November: send the invites. Day 1, Tuesday 24: the onboarding calls. Start a plain progress thread on X about building this, with no link to the app. List 100 people from audience 1 for week 5. Read the "6 of 41" original | 10 | A weekly draft of the owner's thread from the repository's change log; the list template | [Today] |
| 3 (30 Nov to 6 Dec) | Day 7, Monday 30 November: `./run.sh due`, one neutral message to founders on that list only. Log every message sent (the one number depends on it). Post Creaton's own update, with a miss if there is one. List ten possible sponsors | 6 | `./run.sh founders --csv`; a first "This week on Creaton" drafted from it, for members only | [Today] |
| 4 (7 to 13 Dec) | Day 14, Monday 7 December: last reminder, logged. Day 15, Tuesday 8: the count. 8 to 11 December: one call each. Ask who they sent their link to and what that person saw; ask leave to quote them and to show their project in public. Decide go or stop (section 9). Send counsel the batch (public misses, sponsor wording, privacy note). Ask three companies the no-commitment question (post 8) | 10 | The pilot report filled from the table; share pictures for each kept promise; a one-page sponsor note as a draft | [Today]; counsel in one batch after Pilot A (MVP-READY decision 29) |

No public launch words in these four weeks. Pilot A is not called a season, and no deadline is added to it, because
a deadline would spoil its one number (review, section 5). Nothing new is built until the decision on day 15.

### The season (weeks 5 to 12), on a pass

| Week | Owner does | Hours | The assistant or the product produces | Mark |
|---|---|---|---|---|
| 5 (14 to 20 Dec) | Send post 2 to all 100 people this week, 20 a working day, with post 9 for invited people. Tell the assistant to start review changes 3 and 5 | 14 | The season page text; the pilot write-up with real counts and misses; the first build of the ranking fix | [After A] |
| 6 (21 to 27 Dec) | Light week. Answer every new founder within a day and set each one up by hand. Sunday 27 December is the last day to start and still post two weekly updates | 6 | "This week on Creaton" for members; "just started" pictures | [After A] |
| 7 (28 Dec to 3 Jan) | Entry closes Sunday 3 January. The owner or one panel member opens the evidence for each kept promise and writes one line. The panel gives its reasons in the open (section 7). Hand-test the ranking fix if it is built | 10 | The eligibility list from the record (two weekly updates, at least 2 answered promises) | [After A]; the fixed rule [Waits: ranking fix]; without it the panel reads the promises by hand |
| 8 (4 to 10 Jan) | Season 1, day 1. Post the projects and the last-day date (Friday 26 February) to members. Open the weekly thread where season founders question each other's updates. Name the sponsors if any signed | 10 | A season picture per project; the season's "help wanted" list | [After A]; the sponsor line [Waits: a signed sponsor] |
| 9 (11 to 17 Jan) | Door check. Hand-test public reads signed out. Open the door only if all four hold: built, hand-tested, counsel has answered on public misses, the cost ceiling is set. If it opens, run posts 1 and 5 | 10 | The public pages; the take-down rule as a draft | [Waits: review changes 3, 4 and 5; counsel]. No date is promised |
| 10 (18 to 24 Jan) | Helper week: post the season's open tasks in the builder rooms (as text if the door is shut); publish the one-page "give your agent a task" guide | 8 | The guide from [../agents/JOINING.md](../agents/JOINING.md) | [After A] |
| 11 (25 to 31 Jan) | Mid-season page: every season scorecard, in record order, misses and deleted counts shown. Ask two founders for a quoted line. One wide post, Show HN (post 6), only if the door has been open a week and open sign-up exists; otherwise it moves to after the season | 10 | The page text from the record; the Show HN text and a first-hour answer sheet as drafts | [After A]; Show HN [Waits: public reads, open sign-up with limits] |
| 12 (1 to 7 Feb) | Count against section 9. Write the week-12 report and decide: continue to the last day, or stop | 8 | The report tables; the cohort table (started, 2nd, 3rd, 6th update) | [After A] |

The season runs eight weeks, so its last day (26 February 2027) falls three weeks after this plan ends. Weeks 13
to 15 are the last-day page and the season report, about 8 owner hours a week.

**What must be built, by which week, and what is cut if it is not.** The review says to freeze everything outside
the weekly loop, so anything not in its list is cut here unless the owner approves it.

| Item | In the review's list? | Needed by | If it is not done |
|---|---|---|---|
| AI money ceiling and the real invoices | Change 4, days | Week 1, before any invite | No invite is sent |
| Ranking fix | Change 3, 1 to 2 weeks | Week 7 | The panel reads promises by hand; "Most reliable" stays out of every post |
| Public reads, totals page, count of link opens | Change 5, weeks; counsel on public misses | No date; week 9 at the earliest | The season stays invite-only. The last-day page is made by hand, with each founder's yes |
| "Copy an invite" label fix | No. Small | Week 5 | Tell each founder by hand that the link does not open for outsiders |
| Open sign-up with limits | No. Owner decides | Show HN | Show HN moves to after the season |
| Ready-built download of the command line | No | Post 4 | Post 4 says "build it from source" |
| Season mark on project and profile | Named in section 5; no change row | Cut | One line of text on the season page |
| Email, follow by email | Change 6, after Pilot A, weeks | Cut for these 12 weeks | The Monday post; reminders by hand from `./run.sh due` |
| README badge; the helper's own picture (decision 17) | No | Cut | A plain link |

**Every week:** "This week on Creaton" (counts of updates, promises kept and missed, work accepted, new projects),
a help-wanted list, Creaton's own update, and two lines for the owner: money spent this month against the ceiling,
and owner hours this week. The owner runs one command and the assistant drafts the post.

## 6. Channels, first three actions each, and draft words

| Channel | Fit | First three actions | Mark |
|---|---|---|---|
| Hand contact in builder Discords and Telegram groups | Best. The only channel fully in the owner's control | (1) List 100 people in week 2. (2) Send post 2 to all of them in week 5. (3) Ask each new founder for two names | [After A], invite-only wording until the door opens |
| X | Good. The pictures are made for it | (1) Owner's weekly thread from week 2, no link. (2) Post 1 when the door opens. (3) Repost each founder's kept-promise picture, with their yes | [Today] for the thread; links [Waits: public reads] |
| GitHub | Good and cheap for audience 1 | (1) Rewrite the repository's opening lines around the one sentence. (2) Publish the agent guide as a one-page file. (3) A scorecard badge for a README | (1) and (2) [Today]; (3) cut |
| Show HN | One shot. Readers there punish token talk | (1) Draft post 6 by week 9. (2) Post in week 11, Tuesday morning US time, or after the season. (3) Answer every comment that day | [Waits: public reads, open sign-up] |
| Sponsors: two or three companies, at least one outside both crypto and AI tools (review, change 8) | AI-tool companies are the likely first payers; that their budgets do not follow crypto prices is an assumption | (1) List ten in week 3. (2) Ask three the week-4 question. (3) Put the first signed sponsor on the season page | The question [After A]; a signed deal [Waits: counsel on wording] |
| Weekly email | Needed for readers to return | None in these 12 weeks | Cut (review, change 6) |
| Product Hunt | One shot, on a last day | None in season 1. First on the cut list | Not now |
| Farcaster, podcasts, paid placements | Later, later, never on this budget | None in these 12 weeks | Not now |

**Draft words.** Square brackets are filled from the record on the day. Nothing is posted with an empty bracket.

**Post 1. X, the opening, when the door opens.**
> I asked [N] founders to do one thing for two weeks: say a goal, post an update each week, and mark every promise
> kept or missed, where others can read it.
> [N] of them posted a third update. [N] promises were kept. [N] were marked missed, in the open.
> Now it is open to more projects. Free to start. No token needed.
> Here is one of the records: [link]

**Post 2. Direct message to a builder, week 5.**
> Hi [name]. I saw [their project] and your progress posts. I am building Creaton: you state a goal, post once a
> week, and each promise is later marked kept or missed on a page other members can read. [Once the door is open:
> "on a public page".] It is free, and there is nothing to buy.
> On 4 January up to ten projects are due to start an eight-week season together. Two weekly updates before then
> make you eligible, so the last day to start is 27 December.
> Would you try it for two weeks? Starting takes three answers. I will set you up myself. [invite link]

**Post 3. For helpers, in a builder room, week 10.**
> [N] projects on Creaton have open tasks this week. Each task says what "done" means before you start. Someone who
> is not you checks the work, and accepted work goes on your record with the project's name on it.
> No pay is promised by Creaton. [If a sponsor signed: "[Sponsor] pays [25] dollars per accepted task on season
> projects, straight to the helper."] The list: [link, or the tasks as text while the door is shut]

**Post 4. For AI builders, week 10.**
> If your agent can run a command line, it can take a real task: read the task and its finish line as data, hand in
> the work with numbers, and attach a record of the run that cannot be changed afterwards.
> Two rules. The agent's account says it is an agent and names who runs it. And neither the agent nor the person who
> runs it can confirm the work; a second person does. Guide: [link, or the guide as a file]

**Post 5. The weekly post, every Monday (members only until the door opens).**
> This week on Creaton. [N] projects posted an update. [N] promises kept, [N] missed, [N] changed, [N] not yet
> answered. [N] pieces of work accepted. [N] projects started.
> Most weeks in a row: [project], [N] weeks. Help wanted: [task], [task]. Promises are marked by each founder.
> Full list: [link]

**Post 6. Show HN, week 11 or after the season.**
> Title: Show HN: Creaton, a public record of what a project promised and what it did
> Each project has a goal, a weekly update, and promises that the next update marks kept, missed or changed. Tasks
> state what "done" means first; someone other than the worker checks them. Records cannot be quietly edited. A
> founder can delete an update, and the page shows how many were deleted.
> It is open source. No token is needed, and there is nothing to buy or trade. What is weak today: founders mark
> their own promises, [N] projects exist, and it has run in public for [N] weeks. I would like to hear where the
> record can be gamed. [link]

**Post 7. Creaton's own update, with a miss (any week).**
> Creaton, week [N]. Last week we promised [N] things. [Promise]: [done, or not done and why]. [Promise]: [done,
> or not done and why]. Next week: [promise], [promise].

**Post 8. To a possible sponsor. First the week-4 question, which commits nobody.**
> Hello [name]. On 4 January up to ten small projects are due to start eight weeks of open work on Creaton. We are
> choosing them now from projects with a record; I expect most to be AI tools. Would [company] consider helping?
> Which is easier for you: product credits for season projects, or one payment to each project's founder, who pays
> helpers and posts proof? I am not asking for a commitment yet.

**Post 8, signed version, after counsel.**
> Would [company] fund a small pot: [25] dollars per accepted task, up to [10] tasks a project, so at most [2,500]
> dollars for ten projects? It pays only for tasks confirmed by an account outside the project's team, on a list
> you approve before paying. If fewer projects start, the pot is smaller. Creaton never holds the money and takes
> no fee. Each payment is listed on the season page beside your name.

**Post 9. Season announcement, week 5, to invited people.**
> Season 1 starts Monday 4 January. Up to ten projects, eight weeks, one last day: Friday 26 February, when every
> scorecard goes on one page, with misses and the count of deleted records shown.
> How to get in: start a project by 27 December, post two weekly updates, answer at least two of your own promises.
> If more than ten qualify, a small panel picks in the open and gives a reason for each. No fee. No token needed.

Marks: the signed post 8 [Waits: counsel on grant, prize and tax wording]. Posts 1, 5 (public) and 6 [Waits: public
reads]. Posts 2, 3, 4 and 9 use the invite-only wording, and send lists as text, until the door opens.

## 7. The season as the marketing event

The review recommends one hand-run season as the smallest thing that makes the end goal true (section 5). Whether
it also runs after a failed Pilot A is the owner's decision (section 0, item 5). A panel that selects changes the
repository's line "no cohort and no central selection"; the review lists that as an owner decision too. As
marketing the season supplies what the product lacks: a date, peers, and a last day with an audience.

| Part | What it is | Mark |
|---|---|---|
| Start date | Monday 4 January 2027. If fewer than 5 projects are eligible on 3 January, the start moves once, to Monday 18 January, and later dates move two weeks (this plan's proposal) | [After A] |
| Entry | Opened by the record: two weekly updates and at least 2 answered promises by Sunday 3 January. The owner or one panel member opens the evidence for each kept promise and writes one line | [After A]; the fixed ranking rule [Waits: change 3] |
| Size | Up to ten. If ten or fewer are eligible, all enter and the season page says no selection took place. If more, the panel picks ten, one line of reason each | [After A] |
| Panel, season 1 | The pilot founders who posted a third update, plus the owner. The review asks for members with accepted work; Pilot A invites founders only, so that is required from season 2. Pilot projects may enter under the same rule. A panel member gives no reason and no vote on a project they work on | [After A]; an exception for the owner to approve |
| The deal, on one page | A sponsor pot paid per accepted task: 25 a task x 10 tasks = at most 250 a project, 2,500 for ten. Paid only for tasks confirmed by an account outside the project's team, on a list the sponsor approves first. Payments are listed by hand on the season page. No Creaton fee. If no sponsor signs, the page says "no money this season" | [Waits: a sponsor; counsel]. The outside confirm and a payment line on the record are not built (review, changes 8 and 9) |
| Weekly thread | Season founders question each other's updates | [After A] |
| Last day | Friday 26 February: one page of the season's scorecards in record order, a short recorded demo each. No price on the page and no round opens that day. A project that stopped stays on the page, shown as stopped | Made by hand, with each founder's yes, if public reads are not open |
| Season mark | One line of text on the season page; finishing is how one joins the next panel | [After A] |

Legal exposure, one line each: a panel refusing a named founder on a public record raises fairness and defamation
questions; a sponsor pot may be a prize or promotion with tax-reporting duties. Paying up to 100 people 25 dollars
each is also hard for a company's payments team, which is why the week-4 question offers two easier forms.

## 8. How CREATE is and is not talked about

**Rule: CREATE appears in no post, page, picture, bio or pitch during these 12 weeks.** It is not a secret; the
code is open. It is not a subject.

If someone asks, the whole answer is four lines, and the owner alone gives it:

> There is a test token (tCREATE) and a test court, on test networks only.
> It is not for sale. It has no price and no date.
> You do not need it, or any token, to use Creaton.
> It may never exist on a main network. If that changes, the conditions will be published first.

| Never | Why |
|---|---|
| A valuation, a price, a supply split, or the word "billion" | The review's answer is no as designed; the 20% sale share is the part most likely to be read as a securities offering |
| "Early", "points", "airdrop", a waitlist for the token, rewards for inviting | Each reads as a promise of later gain; the cold-start proposal already rules out rewards for inviting |
| "Hold CREATE to ..." anything | No built step uses it |
| "No token", flat, or any line about what a launched token would be used for | The first is untrue; the second can be read as an assurance about its value |
| The token and the season in the same message | It would make the season look like a sale |

What may be said in public once the owner has written the launch gates into [CREATE-TOKEN.md](CREATE-TOKEN.md)
(review, change 1): the gates themselves, as a plain page, with no date. **[Waits: the owner's edit]**

## 9. Numbers to aim for, and when to stop

All targets are proposals. Write them in the report before day 1 and do not move them afterwards.

| When | Aim | Arithmetic or source | Stop and rethink if |
|---|---|---|---|
| Week 4 (day 15, Tuesday 8 December) | At least 3 founders with a third update, and at most 1 of those after a logged message from the owner. This plan adds two proposals: at least 1 promise marked missed; every founder asked who they shared with | The first: MVP-READY decision 3 and the runbook. The other two: this plan | Fewer than 3. Then the owner's written choice applies: (a) stop, or (b) one invite-only season with no public reads, no ranking change, no email and no wide post |
| Week 8 (season day 1) | 10 founders the owner did not know have started; 13 to 15 projects in all; 10 live; 3 help requests with an outside offer | 100 hand contacts x 1 in 10 starting (a guess, and they are asked in the week before the holidays) = 10; plus 3 to 5 from Pilot A | Nobody starts except by personal call: the offer is wrong, not the reach. Rewrite the hooks before any wide post |
| Week 12 (season week 5) | 15 to 25 projects started; 12 live; of strangers who started by week 7, half posted in 4 of their first 5 weeks; 10 tasks accepted between strangers; 15% or more of answered promises marked "not done"; one outside sponsor has committed 1,000 or more in writing and paid for every accepted season task so far; 5 new founders name a shared record when asked; 2 labelled agents with outside-checked work | The review's 90-day table, scaled to 5 weeks of the season. Sponsor: 10 tasks x 25 = 250 paid by week 12; the review's "pays 1,000" is 40 tasks x 25 and is scored at the season's end. 25 = 15 + about 10 by hand and by word of mouth (a guess) | Fewer than half keep posting; "changed" outnumbers "not done"; no outside offers; no money arrives; founders say they would stay only for a token or a raise |

Product credits from a sponsor count as a sponsor's yes, but not as the money test. Email followers are not a
target: nothing in these weeks builds email.

A larger figure was sketched by the growth analyst: about 200 projects started by week 12. Its own inputs do not
reach it. One vendor's guide gives a front-page Show HN 5,000 to 30,000 visits and 50 to 400 sign-ups (unverified;
it cites no data set). At a 30% start rate that is 50 x 0.3 = 15 to 400 x 0.3 = 120 projects. Single reports
found by search on 2026-11-15 run from no sign-ups (about 500 direct visitors) to about 300 (11,000 visitors).
Nobody can promise a front page. If Show HN runs and lands fairly, 25 to 40 projects is the guess; plan on 15 to 25.

**Do not count as success:** visits, followers on X, sign-ups with no project, or a Pilot A pass taken as evidence
for the token.

## 10. Budget lines

The budget runs to the season's end: four months from 16 November, which covers weeks 13 to 15.

| Line | 4 months | Arithmetic or source | Sure? |
|---|---|---|---|
| Server | 352 | 88 a month x 4 (`deploy/ovh/README.md`) | From the repository; not confirmed as the rented machine |
| Backups, domain, uptime check | 80 | 20 a month x 4 | Guess |
| AI service | at most 100 | A ceiling of 25 a month x 4, set at the provider in week 1 (the figure is a proposal). Pilot size is about 4 a month | The ceiling is the owner's to set. Without one, the call cap allows 600 to 1,200 a month at 1 to 2 cents a call |
| **Fixed total** | **about 530** | 352 + 80 + 100 = 532 | |
| Season pot from the owner, only if no sponsor signs | 0 to 1,000 | 25 x 10 tasks x 4 projects | Optional. It gives helpers a reason but does **not** test whether outside money arrives |
| Spare | 500 | | |
| Counsel (public misses, sponsor wording, privacy note) | Not priced | No quote in the repository; a price is asked for in week 1 | Unknown, and likely the largest line |
| Email provider; paid adverts, newsletters or posts | 0 | | Email is cut for these weeks; adverts are not on this budget |

Most likely spend without counsel: about 530 to 2,000. The owner's time is the real cost. The Hours column adds to
117 over 12 weeks (15 + 10 + 6 + 10 + 14 + 6 + 10 + 10 + 10 + 8 + 10 + 8), plus about 24 for weeks 13 to 15. That is
a floor. It leaves out moderation, reminders by hand for 13 to 15 projects, counsel calls and checking what the
assistant builds. Plan on 10 to 18 hours in a working week.

**If hours run short, cut in this order:** the README badge, Product Hunt, the mid-season page, then Show HN. Hand
contact and Creaton's own weekly update are never cut.

## 11. Risks to this plan

| Risk | Likelihood (judgment) | What it does to the plan | Answer |
|---|---|---|---|
| The door does not open during the season (public reads are uncommitted work; counsel has not read public misses) | High | Posts 1, 5 and 6 do not run; loop B stays a hand count | Already the default: an invite-only season with a hand-made last-day page |
| The owner is the reminder, the moderator, the poster and the seller | High | A missed week by the owner is a public miss on Creaton's own record | Post the miss (post 7). One more person before a second season |
| The owner is ill or away for a week | Medium | No reminders, no weekly post | Name one person before day 0 who can run `./run.sh due` and post |
| The ranking is farmed the day the season makes it matter | High | Entry by record rewards easy promises and "changed" | Fix the rule first (review, change 3); the panel reads the promises, not the count |
| Founders will not post misses, or delete them | High | The record reads as an advert | Measure "not done" against "changed" in Pilot A; say the deleted count out loud; lead with Creaton's own misses |
| Accepted work is faked between two accounts once money is paid for it | High once the pot exists | The first real money goes to a signal the review calls easy to fake | Pay only outside-confirmed tasks from a list the sponsor approves |
| Empty rooms | Certain at first | Help requests go unanswered; new founders see nothing happening | One narrow group; three helpers a founder; the owner answers every request in weeks 5 to 7 |
| The holidays (weeks 6 and 7) | Certain | Few replies; fewer than ten may qualify | All 100 messages go out in week 5; the start moves once if fewer than 5 qualify |
| A season founder drops out | Likely for some | A gap on the last-day page | The project stays on the page, shown as stopped |
| Abuse once reads are public or sign-up opens | Medium | The owner is the only moderator | A daily check of reports and a written take-down rule before the door opens |
| A founder asks for a public miss to be removed | Medium | A fairness or erasure claim | A removal rule written with counsel before the door opens; until then, take the page down on request and keep the count |
| Show HN does not run, or lands on the token | Medium | 15 to 25 projects, not 40 | Hand contact carries the plan. The post says "nothing to buy" in its second paragraph |
| A reader finds the test token and the "billion" review in the open repository | Medium | A screenshot beside the season post | Section 8's four lines, and the review's own verdict, which is candid. Never say "no token" |
| No sponsor signs | Medium to high | The one money test is not run | Say "no money this season" on the deal page; ask again at the last day with real records |
| Sign-in loses ordinary people (a passkey or a 64-character recovery key; no email) | Medium | Lower start rate outside audience 1 | Stay with builders for these 12 weeks |
| The app tells founders to share links that do not open ("Copy an invite") | Certain until fixed | Pilot founders look foolish to their friends | Tell pilot founders plainly on day 1; fix the label by week 5 |
| A copy with more users | Low within 12 weeks | None yet | A body of real records in one group, first |

## What could not be verified

- No usage exists. Every rate here is a guess: 1 in 10 contacted start; half keep posting; 5 name a shared record.
- Nothing was run. "Built" rests on [MVP-READY.md](MVP-READY.md), the review and the analysts' code reading.
- Checked in the repository on 2026-11-15: the pilot's day table, decisions 3 and 29, the deletion note in
  `promises.ts`, and the test token's name in `contracts/script/DeployLaunchKit.s.sol`.
- When public reads will work signed out, and when counsel will answer on public misses. Neither has a date.
- The Show HN range comes from one vendor's guide with no data set; single reports vary widely (section 9).
- The "6 of 41" figure is press coverage of an analyst's post; the data set was not opened.
- Prices for backups, AI calls and counsel are not in the repository.
- Whether any company will fund a pot, in money or in credits: none has been asked.
- Whether "This week on Creaton" can be drafted from `./run.sh founders --csv` alone was taken from the report template, not tried.
- Whether a second weekly update can be posted fewer than seven days after the first. The 27 December date assumes not.
