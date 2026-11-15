# Marketing plan: sell the record, not the token

Written 2026-11-15 for the owner. It follows [CREATE-BILLION-REVIEW.md](CREATE-BILLION-REVIEW.md) and sells only what
that review says is true. Read with [DIRECTION.md](DIRECTION.md), [MVP-READY.md](MVP-READY.md) and
[PILOT-RUNBOOK.md](PILOT-RUNBOOK.md). Nothing here forecasts a price. No stranger has used the product, so every
rate and target below is a guess with its arithmetic shown, to be replaced by the first real count.

Each item carries a mark: **[Today]** possible now; **[After A]** possible once Pilot A has run; **[Waits: x]**
waiting on the named thing.

## 0. The verdict

1. **Market the record. Keep CREATE out of every public word for these 12 weeks.** The review found no reason to
   hold CREATE today, and the first audience (builders) leaves when a token is the headline.
2. **There is nothing to market to strangers yet.** On the pilot's invite-only server a shared link ends at "You
   need an invite", and the founder who shared it cannot make one. Weeks 1 to 4 are quiet on purpose.
3. **The plan is three steps:** prove the habit with 5 founders (Pilot A), open the door, then run one season of
   about ten strangers as the first public event. The season starts Monday 4 January 2027, when people make promises anyway.
4. **Cost:** about 500 dollars of fixed spend over 12 weeks plus the owner's 6 to 12 hours a week (section 10).
5. **What a pass proves:** that people use a public record in a quiet market. It does not prove a token. Say so.

## 1. The one sentence and four hooks

**The sentence** (from [DIRECTION.md](DIRECTION.md), unchanged): Creaton is where a project states a goal, does its
work in the open, and lets anyone see whether it kept its promises.

| For | Hook | Mark | Why it is true |
|---|---|---|---|
| A founder | "Say your goal. Post once a week. Get a public page that shows what you promised and what you did. Free to start. No token needed." | [Today] for invited founders; the word "public" [Waits: public reads] | Start, the weekly update, promises and the scorecard are built |
| A helper | "Pick a task with a clear finish line. Someone other than you checks it. Keep a record of the work that was accepted." | [Today] | Tasks, evidence and the check are built. Do not say "paid": no pay exists |
| A backer | "Before you back anything, see which projects kept their promises. The misses stay on the page." | [Waits: public reads] | Investing is off, so this hook offers reading and following only |
| An AI builder | "Give your agent a real task with a finish line a machine can read. Someone who is not the agent checks the work, and the agent's record names who runs it." | [Today] by the command line, built from source | Server rules and the worker loop are built ([../agents/WORKER-LOOP.md](../agents/WORKER-LOOP.md)) |

Two honest limits to keep beside the hooks. Today the founder marks their own promises, so say "the founder says"
until an outside account can confirm (review, change 4). And a founder running their own agent cannot confirm that
agent's work, so the AI hook always comes with "bring one person to check".

## 2. What we do not say

| Do not say | Why | Say instead |
|---|---|---|
| Anything about returns, profit, price, or a token "going" anywhere | Investing is off; a promise of gain next to a token is the plain pattern of a securities offering | Nothing. The pictures already carry no price |
| "A billion-dollar token", any valuation of CREATE, any date for it | The review's verdict is "as designed, no" | Section 8's four lines, only when asked |
| "A decentralized Y Combinator" or "community-run accelerator" in public | It is not one yet (review, section 5); using that name invites a trademark complaint | "A season: ten projects, eight weeks, every promise on the record" |
| "Verified", "audited", "proven" | Promises are self-marked; numbers on hand-ins are the helper's own; the contracts have no outside audit | "The founder says", "reported by the helper", "checked by someone else on the team" |
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

Not yet: backers as a group. With investing off there is nothing for them to do but read, and nothing brings a
reader back until email exists.

## 4. The loops the product has, and one number each

| Loop | State | The one number | Can it be counted today? |
|---|---|---|---|
| A. Promise, weekly update, mark kept or missed, promise again | Built. The only outside reminder is the owner | Share of founders with a third update, with no message from the owner in the two days before | Yes: `./run.sh founders` and `./run.sh due` |
| B. Founder shares the project picture or scorecard, a reader starts a project | Pictures built; link is a dead end on an invite-only server; every project has the same preview image | Projects started through a shared link in a week, divided by live projects the week before | No. [Waits: public reads, a source tag on links, a server-side count] |
| C. Help request, offer, accepted work, the helper shares it | Built up to the confirm; the picture goes to the confirmer for one visit only, not to the helper | Share of help requests with an offer from outside the team within 7 days | By hand from the record today; the helper's picture [Waits: MVP-READY decision 17] |
| D. A reader follows and comes back | Follow needs an account; nothing is emailed | Followers who open a second weekly digest | No. [Waits: email] |
| E. An agent takes a task and builds a track record | Command line built; installs from source only; no card to show | Labelled agents with one piece accepted by a checker outside their operator | By hand today |
| F. "This week on Creaton" | Worked out in the visitor's browser; published nowhere | Opens of the weekly page or email | [Today] as a hand-made post; counting [Waits: a public page or email] |

Live projects (an update in the last 8 days) is the headline count. Loop B's ratio is the only measure of spread;
0.15 by week 12 is a guess to beat, not a known rate.

## 5. Twelve weeks, week by week

Dates assume the owner starts Monday 16 November 2026. Owner hours are estimates. "The assistant" means the AI
assistant working in this repository; "the product" means what the app or the operator commands produce unaided.

### Before Pilot A (weeks 1 and 2)

| Week | Owner does | Hours | The assistant or the product produces | Mark |
|---|---|---|---|---|
| 1 (16 to 22 Nov) | Finish the owner-only chores in [MVP-READY.md](MVP-READY.md) (server, backups, restore rehearsal, uptime alert). Pick 5 founders, at least one with an AI project, an agent and a second person to check it. Write the yes line in the report header. Post Creaton's own first update | 10 | The invite message, the 15-minute call script and the five interview questions as drafts; Creaton's own "just started" picture | [Today] |
| 2 (23 to 29 Nov) | Onboarding calls. Start a plain progress thread on X about building this, with no link to the app. List 100 people from audience 1 for week 5. Read the "6 of 41" original | 8 | A weekly draft of the owner's thread from the repository's change log; the list template | [Today] |

### During Pilot A (weeks 3 and 4)

| Week | Owner does | Hours | The assistant or the product produces | Mark |
|---|---|---|---|---|
| 3 (30 Nov to 6 Dec) | Day 0 of Pilot A. Send reminders by hand from `./run.sh due`. Note every message sent (the one number depends on it). Post Creaton's own update, with a miss if there is one | 6 | `./run.sh founders --csv` each Monday; a first "This week on Creaton" drafted from it, for members only | [Today] |
| 4 (7 to 13 Dec) | Day 14 interviews. Ask each founder: who did you send your link to, and what did they see? Ask leave to quote them and to show their project in public. Decide go or stop (section 9). Approach three AI-tool companies for a season pot | 8 | The pilot report filled from the table; share pictures for each kept promise; a one-page sponsor note as a draft | [Today]; the sponsor note [Waits: counsel on grant or prize wording] |

No public launch words in these two weeks. Pilot A is not called a season, and no deadline is added to it, because
a deadline would spoil its one number (review, section 5).

### The public opening (weeks 5 to 12)

| Week | Owner does | Hours | The assistant or the product produces | Mark |
|---|---|---|---|---|
| 5 (14 to 20 Dec) | Turn on public reads for projects whose founders agreed, and the fixed ranking. Announce the season and its entry rule. Begin hand contact: 10 people a working day | 12 | The season page text; the pilot write-up with real counts and misses; per-project pictures | [After A]; [Waits: public reads, ranking fix (review changes 3 and 5), counsel on public misses] |
| 6 (21 to 27 Dec) | Light week. Keep hand contact going; answer every new founder within a day | 6 | "This week on Creaton" as a public post; "just started" pictures | [After A] |
| 7 (28 Dec to 3 Jan) | Entry closes Sunday 3 January. The panel (about five members with accepted work; in season 1 mostly pilot founders) picks about ten in the open, one line of reason each | 8 | The eligibility list from the record (two updates, at least 2 answered promises, under the fixed rule) | [After A]; [Waits: ranking fix] |
| 8 (4 to 10 Jan) | Season 1, day 1. Post the ten and the last-day date (Friday 26 February). Open the weekly thread where season founders question each other's updates. Name the sponsors if any signed | 10 | A season picture per project; the season's "help wanted" list | [After A]; the sponsor line [Waits: a signed sponsor] |
| 9 (11 to 17 Jan) | One wide post: Show HN (open source, signed records, no token). Stay in the thread all day | 12 | The Show HN text and a first-hour answer sheet as drafts; weekly digest | [Waits: public reads, open sign-up with limits, a ready-built download of the command line] |
| 10 (18 to 24 Jan) | Helper week: post the season's open tasks in the builder rooms; publish the one-page "give your agent a task" guide | 8 | The guide from [../agents/JOINING.md](../agents/JOINING.md); accepted-work pictures for helpers | [After A]; helper pictures [Waits: decision 17] |
| 11 (25 to 31 Jan) | Mid-season page: every season scorecard, in record order, misses shown. Ask two founders for a quoted line | 8 | The page text from the record; the first sponsor payment line if one was paid | [After A] |
| 12 (1 to 7 Feb) | Count against section 9. Write the week-12 report and decide: continue to the last day, or stop | 8 | The report tables; the cohort table (started, 2nd, 3rd, 6th update) | [After A] |

The season runs eight weeks, so its last day (26 February 2027) falls three weeks after this plan ends. Weeks 13
to 15 are the last-day page, a Product Hunt launch on that day, and the season report.

**Every week, with little owner time:** "This week on Creaton" (counts of updates, promises kept and missed, work
accepted, new projects), the top five of "Most reliable", a help-wanted list, and Creaton's own update. Today the
owner runs one command and the assistant drafts the post; an unattended version [Waits: a public page or email].

## 6. Channels, first three actions each, and draft words

| Channel | Fit | First three actions | Mark |
|---|---|---|---|
| Hand contact in builder Discords and Telegram groups | Best. The only channel fully in the owner's control | (1) List 100 people in week 2. (2) Send post 2 below, 10 a working day, from week 5. (3) Ask each new founder for two names | [Today] for invites |
| X | Good. The pictures are made for it | (1) Owner's weekly thread from week 2, no link. (2) Post 1 in week 5. (3) Repost each founder's kept-promise picture, with their yes | [Today] for the thread; links [Waits: public reads] |
| GitHub | Good and cheap for audience 1 | (1) Rewrite the repository's opening lines around the one sentence. (2) Publish the agent guide as a one-page file. (3) A scorecard badge for a README | (1) and (2) [Today]; (3) [Waits: public reads, a badge address] |
| Show HN | One shot. Readers there punish token talk | (1) Draft post 6 by week 7. (2) Post in week 9, Tuesday morning US time. (3) Answer every comment that day | [Waits: public reads, open sign-up] |
| AI-tool companies as sponsors | The right first payers: their budgets do not follow crypto prices | (1) List ten in week 3. (2) Send post 8 to three in week 4. (3) Put the first signed sponsor on the season page | [After A]; [Waits: counsel on wording] |
| Weekly email | Needed for readers to return | (1) Choose one provider. (2) Four messages only: update due, someone offered, work accepted, weekly digest. (3) Follow by email without an account | [Waits: email, the privacy-note change] |
| Product Hunt | One shot, on the season's last day | (1) Page ready by week 12. (2) Launch 26 February. (3) Founders comment with their own scorecards | [Waits: season end] |
| Farcaster, podcasts, paid placements | Later, later, never on this budget | None in these 12 weeks | Not now |

**Draft words.** Square brackets are filled from the record on the day. Nothing is posted with an empty bracket.

**Post 1. X, week 5, the opening.**
> I asked [5] founders to do one thing for two weeks: say a goal, post an update each week, and mark every promise
> kept or missed, where others can read it.
> [N] of them posted a third update. [N] promises were kept. [N] were marked missed, in the open.
> Now it is open to more projects. Free to start. No token needed.
> Here is one of the records: [link]

**Post 2. Direct message to a builder, week 5.**
> Hi [name]. I saw [their project] and your progress posts. I am building Creaton: you state a goal, post once a
> week, and each promise is later marked kept or missed on a public page. It is free and there is no token to buy.
> On 4 January ten projects start an eight-week season together. Two weekly updates before then make you eligible.
> Would you try it for two weeks? Starting takes three answers. I will set you up myself. [invite link]

**Post 3. For helpers, in a builder room, week 10.**
> [N] projects on Creaton have open tasks this week. Each task says what "done" means before you start. Someone who
> is not you checks the work, and accepted work goes on your record with the project's name on it.
> No pay is promised by Creaton. [If a sponsor signed: "[Sponsor] pays [25] dollars per accepted task on season
> projects, straight to the helper."] The list: [link]

**Post 4. For AI builders, week 10.**
> If your agent can run a command line, it can take a real task: read the task and its finish line as data, hand in
> the work with numbers, and attach a signed record of the run.
> Two rules. The agent's account says it is an agent and names who runs it. And neither the agent nor the person who
> runs it can confirm the work; a second person does. Guide: [link]

**Post 5. The weekly post, every Monday from week 6.**
> This week on Creaton. [N] projects posted an update. [N] promises kept, [N] missed, [N] changed, [N] not yet
> answered. [N] pieces of work accepted. [N] projects started.
> Most weeks in a row: [project], [N] weeks. Help wanted: [task], [task]. Promises are marked by each founder.
> Full list: [link]

**Post 6. Show HN, week 9.**
> Title: Show HN: Creaton, a public record of what a project promised and what it did
> Each project has a goal, a weekly update, and promises that the next update marks kept, missed or changed. Tasks
> state what "done" means first; someone other than the worker checks them. Records are signed and misses stay.
> It is open source. There is no token to buy and nothing to trade. What is weak today: founders mark their own
> promises, [N] projects exist, and it has run in public for [N] weeks. I would like to hear where the record can
> be gamed. [link]

**Post 7. Creaton's own update, with a miss (any week).**
> Creaton, week [N]. Last week we promised three things. Reminders by email: not done; it needs a privacy-note
> change first. Public project pages: done. The ranking fix: done. Next week: [promise], [promise].

**Post 8. To a sponsor, week 4.**
> Hello [name]. On 4 January ten small projects, most of them AI tools, start eight weeks of public work on Creaton.
> Would [company] fund a small pot: [25] dollars per accepted task, up to [10] tasks a project, so at most [2,500]
> dollars for ten projects? You pay each helper directly. Creaton never holds the money and takes no fee. Every
> payment is shown on the project's record beside your name. I can send the list of projects and tasks.

**Post 9. Season announcement, week 5.**
> Season 1 starts Monday 4 January. About ten projects, eight weeks, one last day: Friday 26 February, when every
> scorecard goes on one page, misses included.
> How to get in: start a project, post two weekly updates, answer at least two of your own promises. A panel of
> five members picks from that list in the open and gives a reason for each. No fee. No token.

Post 8 [Waits: counsel on grant, prize and tax wording]. Posts 1, 5, 6 and 9 [Waits: public reads].

## 7. The season as the marketing event

The review recommends one hand-run season as the smallest thing that makes the end goal true (section 5), and as
the next test whether Pilot A passes or fails. As marketing it supplies what the product lacks: a date, a small
number of places, peers, and a last day with an audience.

| Part | What it is | Mark |
|---|---|---|
| Start date | Monday 4 January 2027 | [After A] |
| Entry | Opened by the record (two weekly updates, at least 2 answered promises), confirmed by about five members with accepted work, one line of reason each | [Waits: ranking fix; an outside check that kept promises were real] |
| Size | About ten. Scarcity is the point | [After A] |
| The deal, on one page | A sponsor pot paid per accepted task: 25 a task x 10 tasks = at most 250 a project, 2,500 for ten. No Creaton fee. If no sponsor signs, the page says "no money this season" | [Waits: a sponsor; counsel] |
| Weekly thread | Season founders question each other's updates | [After A] |
| Last day | Friday 26 February: one public page of the ten scorecards in record order, a short recorded demo each. No price on the page and no round opens that day | [Waits: public reads] |
| Season mark | On project and profile; finishing is how one joins the next panel | [Waits: a small build] |

Legal exposure, one line each: a panel refusing a named founder on a public record raises fairness and defamation
questions; a sponsor pot may be a prize or promotion with tax-reporting duties.

## 8. How CREATE is and is not talked about

**Rule: CREATE appears in no post, page, picture, bio or pitch during these 12 weeks.** It is not a secret; the
code is open. It is not a subject.

If someone asks, the whole answer is four lines, and the owner alone gives it:

> There is a test token called CREATE on a test network. On paper it is the court's deposit token.
> It is not for sale. It has no price and no date.
> You do not need it, or any token, to use Creaton.
> If it ever exists on a main network, it will be because there is paid work for it to do, and the conditions will be written down first.

| Never | Why |
|---|---|
| A valuation, a price, a supply split, or the word "billion" | The review's answer is no as designed; the 20% sale share is the part most likely to be read as a securities offering |
| "Early", "points", "airdrop", a waitlist for the token, rewards for inviting | Each reads as a promise of later gain; the cold-start proposal already rules out rewards for inviting |
| "Hold CREATE to ..." anything | No built step uses it |
| The token and the season in the same message | It would make the season look like a sale |

What may be said in public once the owner has written the launch gates into [CREATE-TOKEN.md](CREATE-TOKEN.md)
(review, change 1): the gates themselves, as a plain page, with no date. **[Waits: the owner's edit]**

## 9. Numbers to aim for, and when to stop

All targets are proposals. Write them in the report before day 1 and do not move them afterwards.

| When | Aim | Arithmetic or source | Stop and rethink if |
|---|---|---|---|
| Week 4 (end of Pilot A) | At least 3 of 5 founders with a third update, at most 1 of those after a message; at least 1 promise marked missed; 5 founders asked who they shared with | MVP-READY decision 3 | Fewer than 3. Then skip the wide posts and run the season anyway as the next test, with the deadline doing the asking |
| Week 8 (season day 1) | 10 founders the owner did not know have started; 15 projects in all; 10 live; 3 help requests with an outside offer | 100 hand contacts x 1 in 10 starting (a guess) = 10; plus 5 from Pilot A | Nobody starts except by personal call: the offer is wrong, not the reach. Rewrite the hooks before Show HN |
| Week 12 | 25 to 40 projects started; 15 live; of strangers who started by week 7, half posted in 4 of their first 5 weeks; 10 tasks accepted between strangers; 15% or more of answered promises marked "not done"; 1 sponsor has paid 1,000 or more; 5 projects started from a shared record; 100 email followers; 2 labelled agents with outside-checked work | The review's 90-day table, scaled to 5 weeks of the season; 25 = 15 + about 10 from one wide post that lands badly, 40 if it lands fairly | Fewer than half keep posting; "changed" outnumbers "not done"; no outside offers; no money arrives; founders say they would stay only for a token or a raise |

A larger figure exists: the growth analyst sketched about 200 projects started by week 12. That needs a
front-page Show HN (one vendor's guide gives 5,000 to 30,000 visits and 50 to 400 sign-ups) and a 30% start rate.
Nobody can promise a front page. Treat 200 as luck, and plan on 25 to 40.

**Do not count as success:** visits, followers on X, sign-ups with no project, or a Pilot A pass taken as evidence
for the token.

## 10. Budget lines

| Line | 12 weeks | Arithmetic or source | Sure? |
|---|---|---|---|
| Server | 264 | 88 a month x 3 (`deploy/ovh/README.md`) | From the repository; not confirmed as the rented machine |
| Backups, domain, uptime check | 60 | 20 a month x 3 | Guess |
| AI service | 100 | About 4 a month at pilot size, more once strangers arrive; pin a cheap model and set a money ceiling first | Guess; the call cap allows 600 to 1,200 a month at 1 to 2 cents a call |
| Email provider | 60 | 20 a month x 3 | Guess; no provider chosen |
| **Fixed total** | **about 480** | 264 + 60 + 100 + 60 = 484 | |
| Season pot from the owner, only if no sponsor signs | 0 to 1,000 | 25 x 10 tasks x 4 projects | Optional. It gives helpers a reason but does **not** test whether outside money arrives |
| Spare | 500 | | |
| Counsel (public misses, sponsor wording, privacy note) | Not priced | No quote in the repository | Unknown, and likely the largest line |
| Paid adverts, paid newsletters, paid posts by others | 0 | | Not on this budget, and not before loop B can be counted |

Most likely spend without counsel: about 500 to 2,000. The owner's time is the real cost: 6 to 12 hours a week,
about 104 hours over the 12 weeks (10 + 8 + 6 + 8 + 12 + 6 + 8 + 10 + 12 + 8 + 8 + 8).

## 11. Risks to this plan

| Risk | Likelihood (judgment) | What it does to the plan | Answer |
|---|---|---|---|
| The door does not open by week 5 (public reads are uncommitted work; counsel has not read public misses) | High | Weeks 5 to 12 slide. Posts 1, 5, 6 and 9 cannot run | Slide the whole plan, never the order. The season can start invite-only with a public last-day page only |
| The owner is the reminder, the moderator, the poster and the seller | High | A missed week by the owner is a public miss on Creaton's own record | Post the miss (post 7). One more person before a second season |
| The ranking is farmed the day the season makes it matter | High | Entry by record rewards easy promises and "changed" | Fix the rule first (review, change 3); the panel reads the promises, not the count |
| Founders will not post misses | High | The record reads as an advert | Measure "not done" against "changed" in Pilot A; lead with Creaton's own misses |
| Empty rooms | Certain at first | Help requests go unanswered; new founders see nothing happening | One narrow group; three helpers a founder; the owner answers every request in week 5 to 7 |
| The holidays (weeks 6 and 7) | Certain | Half-speed outreach | Planned as light weeks; 4 January is the reason to wait |
| Show HN does not land, or lands on the token | Medium | 25 projects, not 40 | Hand contact carries the plan. The post says "no token" in its second paragraph |
| A reader finds the test token and the "billion" review in the open repository | Medium | A screenshot beside the season post | Section 8's four lines, and the review's own verdict, which is candid |
| No sponsor signs | Medium to high | The one money test is not run | Say "no money this season" on the deal page; ask again at the last day with real records |
| Sign-in loses ordinary people (a passkey or a 64-character recovery key; no email) | Medium | Lower start rate outside audience 1 | Stay with builders for these 12 weeks |
| The app tells founders to share links that do not open ("Copy an invite") | Certain until fixed | Pilot founders look foolish to their friends | Tell pilot founders plainly; fix the label before week 5 |
| A copy with more users | Low within 12 weeks | None yet | A body of real records in one group, first |

## What could not be verified

- No usage exists. Every rate here is a guess: 1 in 10 contacted start; half keep posting; 0.15 for loop B.
- Nothing was run. "Built" rests on [MVP-READY.md](MVP-READY.md), the review and the analysts' code reading.
- Whether public reads work signed out, and when counsel will read public misses, sets the date of week 5.
- Channel figures for Show HN and Product Hunt come from one vendor's guides, read on 2026-11-15.
- The "6 of 41" figure is press coverage of an analyst's post; the data set was not opened.
- Prices for email, backups, AI calls and counsel are not in the repository.
- Whether any AI-tool company will fund a pot: none has been asked.
- Whether "This week on Creaton" can be drafted from `./run.sh founders --csv` alone was taken from the report template, not tried.
