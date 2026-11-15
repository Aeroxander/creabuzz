# Can CREATE carry a billion dollars? A review of the whole product

Written 2026-11-15 for the owner. Seven analysts worked separately (token design, comparables, accelerator fit, bear
market, AI, growth, and a skeptic); this page joins their reports and says where they disagree. Nothing here is a
forecast of a price. Outside market figures are from web snapshots between July and 13 November 2026 that disagree
with each other; treat every one as a range. Read with [DIRECTION.md](DIRECTION.md), [MVP-READY.md](MVP-READY.md),
[CREATE-TOKEN.md](CREATE-TOKEN.md), [BEAR-MARKET-MONEY.md](BEAR-MARKET-MONEY.md) and [BACKING-POOL.md](BACKING-POOL.md).

## 1. The verdict in ten lines

1. **As designed, no.** CREATE has no claim on money, pays nothing for holding and has no buyback. Its only uses
   belong to a court that is hidden and frozen on test networks ([CREATE-TOKEN.md](CREATE-TOKEN.md), lines 10-22, 90).
2. One billion dollars is 1.00 dollar a token (supply is fixed at one billion, `contracts/src/CreateToken.sol`).
   The nearest working token of the same kind, a court deposit token, is worth about 6 to 8 million.
3. The platform takes in nothing today, on any money path. There is no income to send to any token design.
4. **As it could be, on its own work: roughly 100 to 180 million** at 10,000 active projects, on assumptions nobody
   has measured. That is about where the closest real-project launchpad token trades (79 to 130 million in 2026).
5. The rest of the way needs one of three things: about 25 to 100 million a year of platform income; a slice of
   projects worth 14 to 50 billion together; or a bull-market multiple. Two are slow. The third is the crypto cycle.
6. The one design that reached billions fast (every project priced in the platform token) fell about 89% and would
   put every project's money in a falling token. It defeats the bear-market aim. Reject it.
7. **It is not a community-run accelerator yet.** One part is built well: weekly accountability on a public record.
   Selection, a batch, one deal, a demo day, mentors, follow-on money and alumni are missing, on paper or switched off.
8. **The bear-market strength is real.** The built loop needs no network, no token and no price, and costs about
   110 to 120 dollars a month to run at pilot size. It is safe in a crash. It does not yet take in a cent.
9. The record is the product, and today it is self-graded. A founder marks their own promises and any second
   account on the team can confirm work. Fix that before the record gates anything of value.
10. No stranger has used the product. Run the pilot, then one season. Keep CREATE unlaunched until it has paid work
    to do. A pass proves a useful product, not a billion-dollar token.

## 2. What a billion dollars would require, in numbers

**The price.** 1,000,000,000 dollars / 1,000,000,000 tokens = 1.00 a token, counting every token. If only the 20%
sale share trades (200 million tokens), 1.00 a token is 200 million of traded value; one billion of traded value is
1,000 / 200 = 5.00 a token, which is 5 billion counting every token.

**Four routes, each with its bar.** Multiples are yardsticks taken from other tokens on one day, not a method.

| Route | What must be true for one billion | Arithmetic | Where Creaton is today |
|---|---|---|---|
| Income that reaches the token | 25 to 100 million a year of platform income | 1,000 / 40 = 25; 1,000 / 10 = 100. At the best-funded meme launchpad's 3 to 5.6 times it is 180 to 330 | 0. The owner memo's own sketch is 14,400 to 24,000 a year at 100 active projects (1,200 to 2,000 a month x 12, [BEAR-MARKET-MONEY.md](BEAR-MARKET-MONEY.md) lines 119-121) |
| The same, in paid work | 500 million to 3.3 billion a year of paid work through Creaton | 25 / 5% = 500; 100 / 3% = 3,333. The larger is about 83% of the biggest freelance marketplace's 2025 volume (about 4.03 billion) | 0. No money path in the hosted build |
| The same, in projects | 104,000 to 347,000 projects active at once | Memo income is 12 to 20 a project a month, so 144 to 240 a year. 25,000,000 / 240 = 104,167; 50,000,000 / 144 = 347,222 | 0 outside projects |
| Pay for judging (the design as written) | 100 to 200 million a year of juror fees | A juror wanting 10 to 20% a year: 1,000 x 0.10 to 0.20 | Court off. Test fee is 1 USDC a seat ([COURT.md](COURT.md)) |
| A slice of every project | Projects worth 14 to 50 billion together | 1,000 / 7% = 14.3; 1,000 / 2% = 50 | Creaton holds 0% of any project |
| Projects priced in CREATE | 1.12 billion standing in backing pools | The pool keeps 89.1% of each buy as reserve: 1,000 / 0.891 | Pool off, no audit, not deployed |

**Where the analysts disagree on the multiple.** They used 5.6, 10, 20, 40 and 114 times yearly income. I use 10 to
40. The low figures come from one token that buys itself back with hundreds of millions a year in a falling market;
40 comes from the closest real-project launchpad in 2026 (about 79 million of value over about 1.96 million of
annualised income); 114 is one agent launchpad on one day and flatters everything. At any of them the gap is huge:
25,000,000 / 24,000 = about 1,000 times the memo's best case, and 180,000,000 / 14,400 = about 12,500 times its worst.

**The slice route in plain terms.** At a 2% slice, 50 billion of project value is about 420 companies of Y
Combinator's reported average (600 billion over about 5,000 companies = 120 million each; third-party figures, not
YC's own), or about 300,000 open-launchpad projects on a guessed spread of outcomes. It is a selection problem, not
a volume problem, and the value arrives years late. YC's own deal is 125,000 dollars for 7% plus 375,000 on a
second paper (ycombinator.com/deal, read 2026-11-15).

**What others are worth (ranges; snapshots disagree).**

| Who | What pays the token | Value found | When the market fell |
|---|---|---|---|
| Largest meme launchpad | Half of net income buys the token | 0.5 to 2.7 billion across snapshots; about 1.7 to 1.9 early Nov 2026 | Income fell about 80% Jan to Jul 2025; token about 68% under its sale price (Jul 2026) |
| Largest agent launchpad | Every agent token had to be paired with it | About 5 billion at peak (Jan 2025); about 370 to 400 million (Oct to Nov 2026) | Down about 89%; daily income fell from about 1 million to hundreds of dollars |
| Closest real-project launchpad | A fee on trades in launched tokens | Peak about 246 million (Oct 2025); 79 to 130 million in 2026 | Quarterly income fell about 70 to 80% in one quarter (sources differ) |
| A newer decision-market launchpad | Governance | About 25 to 36 million counting every token (Nov 2026) | Too new |
| Court deposit token (nearest to CREATE) | Court fees to jurors | About 6 to 8 million (Sep to Nov 2026) | Small throughout |
| Grants token for real work | Governance only | 6 to 15 million (2026) | Grants product closed Apr 2025 |
| A fundraising platform, no token | Sold to an exchange | 375 million, cash and stock (Oct 2025) | Not applicable |

No launchpad token whose product is a record, not trading, has come near a billion. Every one that did had large
income used to buy the token, a rule forcing projects to hold it, or a hot story in a rising market.

## 3. What CREATE is today and what demand it has

**What it is.** A fixed supply of one billion, created once to one holder, with no owner, no further creation, no
pause and vote checkpoints (`contracts/src/CreateToken.sol`, checked). Only a test token and a faucet exist.
[CREATE-TOKEN.md](CREATE-TOKEN.md) says "these are my calls": the design (D118) was the assistant's overnight
decision. Only "make people work for it" traces to the owner. The outside tokenomics brief leaves CREATE and the
court out of scope ([TOKENOMICS-REVIEWER-BRIEF.md](TOKENOMICS-REVIEWER-BRIEF.md)), so the piece meant to carry the
largest value is the one piece nobody outside has checked.

**Its uses, and their state.**

| Use | State | Does the built loop need it? |
|---|---|---|
| Deposit to judge cases | Court built for test networks, hidden in [DIRECTION.md](DIRECTION.md), frozen | No |
| Reviewer bonds | Optional per work budget; USDC works as well | No |
| Bond for a project built on another | On paper | No |
| Court fees | Payable in CREATE or USDC | No |
| Votes on court settings | Checkpoints built; the vote itself is later | No |

No step of Start, weekly update, promises, tasks or Discover touches CREATE. The token paper's own words: if the
court is not adopted, CREATE "has no reason to exist yet".

**Lasting demand if every written use were live** (the token analyst's arithmetic; case rate, seat fee and the
return a juror wants are assumptions, not measurements).

| Active projects | Base case | Generous case | How |
|---|---|---|---|
| 100 | about 58,500 | about 0.5 million | Juror fees a project a year: 3.85 seats x 1 case x 20 dollars = 77 (base); x 5 cases x 50 dollars = 962.50 (generous). Deposit a juror would hold at a 20% return = fees / 0.2. Plus reviewer bonds (150 a project) and remix bonds (50 a project) |
| 1,000 | about 585,000 | about 5.0 million | Same, x 10 |
| 10,000 | about 5.85 million | about 50 million | Same, x 100 |

Average seats a case: 3 + 10% x 7 + 1% x 15 = 3.85 ([COURT.md](COURT.md) panel sizes).

**The supply works against it.** 40% of supply is to be paid out for work. At 1.00 a token that is 400 million
dollars of pay that workers must sell to live on, against at most about 50 million of locked demand at 10,000
projects. The court also holds at most 1,024 jurors.

## 4. The token designs compared, a recommendation, and the smallest first step

| Design | Supportable value at 10,000 active projects | In an 80% crypto fall | Breaks which current rule | Legal exposure, one line |
|---|---|---|---|---|
| **(a) Work token as written** | About 6 to 50 million | Unaffected, and small | None | Least; the 20% sale is the part most likely to be read as a securities offering |
| **(b) Treasury holds a slice of every project** | About 33.5 million at 2% on a guessed spread (0.09 x 250,000 + 0.009 x 5 million + 0.001 x 100 million = 167,500 a project; x 2% = 3,350; x 10,000) | Best of the five if projects are real | "No claim on any treasury"; Shares only from reviewed awards | A token over a pooled set of project stakes looks like an investment fund; heaviest of the five |
| **(c) Fee income buys back CREATE or pays holders** | About 55 to 84 million (1.38 to 2.1 million a year x 40) | A fee on trades dies with volume; a fee on paid work in a stable currency falls less | "No buybacks and no holder dividends"; "no fee on trades, ever" if on trades | The plainest "profit from others' work" pattern; a fee on other people's payments raises money-handling questions |
| **(d) Deposit CREATE to vouch for projects in a batch** | About 50 million locked (1% slice worth 1,675 a project / 30% wanted return = about 5,600; rounded to 5,000 x 10,000) | Holds if deposits are sized in dollars and the reward is not new CREATE | "Not now: the vouch"; "no cohort and no central selection" | A deposit on how someone else's project turns out can read as a wager, or an investment if the reward is a piece of the project |
| **(e) CREATE as the currency of pools and rounds** | About 89 million locked (0.891 x 10,000 dollars x 10,000) | Every project's reserve, held money and refunds fall 80% together | "Free to start. No token needed."; the bear-market aim itself | Making people buy the platform token to back a project strengthens the investment reading |

**Where the analysts disagree, and my choice.** The comparables analyst would give a CREATE-governed treasury a 2 to
5% slice of every project, because that is how an accelerator is worth anything. The token analyst would pay a small
slice only to the people who vouched for that project, never to holders. I choose the second as the first step. It
keeps the owner's one traced line ("make people work for it"), it carries less legal weight, and a plain holder
index is still worth only about 33.5 million at 10,000 projects on these guesses. Be clear about the cost: under
that choice the value reaches workers, not holders, so the token is worth its deposit demand and little more. If
the owner wants holders to own the winners, that is design (b), a fund in law, and it should be chosen openly.

**Recommendation: a mix, and no launch yet.**

1. Keep CREATE a work token, with no buyback and no payout for holding.
2. Widen the paid work from judging to **selecting and checking projects in a batch**: a deposit to vouch, settled
   on work checked by someone outside the team, with the court as the appeal.
3. Pay that work from a **visible 3 to 5% fee on funded work, in a stable currency**, per piece of work done. Keep
   "no fee on trades, ever".
4. Later, with counsel and the outside reviewer: a batch project that opts in gives 1 to 2% as locked, non-voting
   units to those who vouched for it, part to a Creaton endowment that funds work budgets.
5. Reject CREATE as the currency of pools and rounds, and write that down.

On the analysts' assumptions this mix supports about 111 to 184 million at 10,000 active projects (base: 3.85 court
+ 2 bonds + 50 vouch deposits + 55 fees at 40 times = 111; generous: 48.1 + 2 + 50 + 84 = 184; the deposit and fee
lines partly overlap, so this leans high). That is one-ninth to one-fifth of a billion.

**The smallest first step costs no contract and no token.** During Pilot A, let invited outsiders make signed,
no-money forecasts on one question per project: "will this founder post a third weekly update without being asked?"
Score them against the pilot's own table. If outside vouches do not predict records better than chance, design (d)
and the accelerator claim for the token have no work to pay for, and CREATE stays unlaunched with bonds in a stable
currency, as its own paper already says. (The token analyst says a no-money forecast record is already built; I did
not check that it can be used this way.)

## 5. Is it a community-run YC yet: built, designed, missing

**No, and the repository says so.** "Y Combinator" appears in one document, which also says "There is no cohort and
no central selection" ([TOKENOMICS-REVIEWER-BRIEF.md](TOKENOMICS-REVIEWER-BRIEF.md) lines 9-13, checked).
[DIRECTION.md](DIRECTION.md) names no accelerator, batch, selection or demo day. The top-level vision files
([../../VISION.md](../../VISION.md), [../../VISION_PROJECTS.md](../../VISION_PROJECTS.md)) describe the upstream
workspace, not the launchpad. The owner's stated end goal is in no vision or direction document.

| Accelerator part | State | Note |
|---|---|---|
| Weekly accountability | **Built**, tested on a laptop only | Goal, weekly update, promises marked kept, missed or changed, tasks with a finish line, a check by someone else, a public scorecard |
| Selection | **Missing, on purpose** | Anyone can start. The owner hand-picks Pilot A. The vouch is on paper |
| A batch with a deadline | **Missing** | A weekly rhythm exists; no shared start, end or peers |
| One standard deal | **Designed several times, none live** | The pool is the nearest: fixed terms, off, not deployed, no audit |
| Demo day | **Missing** | Scorecard and share pictures exist; on an invite-only server no outsider can open them |
| Follow-on money | **Built or designed, all off** | Pool, weekly sales, auction raise, card payments. No investor side |
| Mentors and office hours | **Missing as people** | AI drafts and questions stand in. No terms for advisors |
| Alumni and brand | **Empty** | Profiles carry a track record; no project has finished anything |

**The pool is not an accelerator cheque.** Over a year of 13 milestones a project receives about 10.7% of what
backers put in: 1% fee + 9.9% held x (1 - 0.75^13 = 0.976) = 1% + 9.66%. A round at the default minimum of 2,500
gives the project 25 at once and about 62 at the first milestone (2,500 x 0.99 x 0.10 / 4). To deliver 125,000,
about 1.17 million must stand in the pool through every milestone (125,000 / 0.1066). And a holder who cares only
about price does best by leaving at the first milestone, which cuts the project's take to about 1.9% (10 + 8.91 per
1,000). Numbers are from [BACKING-POOL.md](BACKING-POOL.md) and its model; no one reran them for this review.

**Where Creaton is already stronger than an accelerator.** The record is public and signed, and misses stay
visible. Start is free and open, with no token. Agents are labelled helpers with limited powers and a command line.
Nobody grades their own work. The loop needs no network. The platform takes no slice of the founder's project.
That last strength is also the hole in the token case: an accelerator is worth what it owns of its winners.

**Why selection matters (outside evidence, from search summaries).** A permissionless sibling of the closest
real-project launchpad used much the same mechanics as its curated launches: 2 of 54 projects met their goal by
mid-March 2026, later 13 of 95. Of 41 launchpad token sales since 2025, 6 were above their sale price on 31 March
2026, and four of the six came from the one platform where raised money stays under holder control (press coverage
of an analyst's post; the data set was not opened). An open door alone does not produce fundable projects. A record
of kept promises is a real selection edge, and today it gates nothing.

**The smallest loop that makes the claim true: one hand-run season.** A fixed start and eight weeks. Entry opened
by the record (two or three weekly updates under the existing ranking rule) and confirmed by about five members with
accepted work, in the open, with a one-line reason each. One deal on one page: with no network, a sponsor pot paid
per accepted task (25 a task, up to 10 tasks, is at most 250 a project and 2,500 for ten). A weekly thread where
season founders question each other's updates. A public page of the season's scorecards on the last day. A season
mark on project and profile; finishing a season is how one joins the next panel. None of this needs a contract.

**A tension to decide.** Pilot A asks whether founders post "without being asked". An accelerator works by asking:
a batch, peers and a deadline. If Pilot A fails, the cheapest next test is a season with a deadline, not a stop.
Do not add a demo day to Pilot A itself; the deadline would spoil its one number.

## 6. What keeps working in a bear market, and the scoreboard that is not price

**What keeps working.** Start, the weekly update, promises, help requests, tasks with an independent check, the
record, Discover by kept promises and the agent command line involve no network, no Shares and no price
([MVP-READY.md](MVP-READY.md), "What a founder can do today"). An 80% fall changes nothing about how they work or
what they cost. Nothing yet shows the loop grows in a quiet market; no stranger has used it.

**What it costs.** About 110 to 120 dollars a month at pilot size: 88 for the server (`deploy/ovh/README.md`,
checked; the money memo says no figure is in the repository, but this one is), plus about 20 for backups, a domain
and an uptime check and about 4 for AI at pilot use (both guesses). The AI service has a call ceiling and no money
ceiling: 2,000 calls a day x 30 = 60,000 a month, which is 600 to 1,200 dollars at a guessed 1 to 2 cents a call.

**What would cover it, without trading.** About 3,800 a month of paid work at a 3% fee (115 / 0.03; about 13
projects moving 300 each), or 5 projects on a 25-dollar hosted tier (115 / 25 = 4.6), or one 6,000 sponsored season
a quarter at 6% (360 a quarter). One full-time person at a guessed 8,000 a month is a different size: 8,000 / 0.03 =
about 267,000 a month of paid work, about 890 projects. **None of these lines exists.** The owner pays through the
pilots.

**What is still tied to the cycle.** The pool, its opening round and CREATE. All are off by default. Keep them off
the scorecard, the share pictures and the Discover ranking, so a failed round or a falling price cannot mark a
project's record. The pool's currency is chosen when it is deployed; write down that it is a stable currency only.

**The scoreboard that is not price.** Most of these are already computed by the operator commands
([PILOT-REPORT.md](PILOT-REPORT.md), `./run.sh founders`).

| Number | Why it holds in a quiet market | Can it be faked cheaply? |
|---|---|---|
| Live projects (an update in the last 8 days) | Posting needs no price | Yes, by the founder alone |
| Founders still posting at week 4 and week 12 | Measures habit, not a launch-day spike | Costs twelve weeks of effort |
| Promises kept, missed, changed, unanswered | The record itself; show misses too | Yes today: the founder marks their own |
| Work accepted after a check by someone outside the team | The helper's proof of work | Two free accounts are enough today |
| **Stable-currency pay for accepted work, from a payer who is not the helper** | The one money number that needs nobody to want a price | Costs real money |
| Projects started through someone else's shared record | The only measure of spread | Not counted today: no source tag, no counter |

Make the pay line the headline; every later income line is a share of it. Today none of these can be shown to the
world: the hosted server is invite-only and a shared link is a dead end for a reader without an invite. A
signed-out page of totals only (no names, no price) is the cheapest fix.

## 7. The AI angle: what is real, what to add, what is a trap

**Real, and enforced by the server** (`crates/buzz-relay/src/handlers/launch_update_authority.rs`, checked).

- An agent account is labelled with two signatures, its own and its operator's. It may not confirm work, grant more
  time, or sign goals, promises or promise marks. Nobody confirms work done by an agent they run.
- A machine-readable work loop through the command line, with one data format and a test that fails the build when a
  documented command no longer parses ([../agents/WORKER-LOOP.md](../agents/WORKER-LOOP.md)).
- A hand-in can carry bounded numbers and a signed run record from a locked-down sandbox.
- The weekly-update AI draft cites only items on the record and never writes "What's next".

**Only wording today.**

- "Measured" results are the helper's own report. Nobody else reruns anything, and the helper picks the checks.
- The four AI project kinds are starter text; nothing is written to the project.
- "Open to agents" is a category filter. Every request is already open to agents.
- The "labour market for agents" is a record book: no pay, the record lives on one server, the operator can delete it.
- Labelling costs an agent powers and gains it nothing; an unlabelled account is treated as a person.
- **A solo founder running their own agents can never get that work accepted**, because the operator may not confirm
  it. The "one person plus agents" case has a hole in the middle.

**Worth adding, in order.** (1) Checks fixed on the task before work starts, rerun and signed by the checker, shown
side by side with the helper's run. (2) A ready-made help request, "Someone to check my agent's work", and a team
role that only confirms or sends back. (3) The AI kind's starter tasks written to the project as drafts (tasks yes,
promises no). (4) An agent work card: accepted pieces, on how many projects, by how many different checkers, who
runs it; no score. (5) A lower daily AI cap for labelled agents: four accounts at 500 calls use the whole 2,000.

**Traps. Do not build.** Tokens for agents (the category leader is about 89% below its peak; an offering question
for each one). An agent score or ranking (cheap to farm while a friend can confirm a friend). An AI that accepts
work (in a March 2026 outside study, about half of benchmark-passing changes would have been rejected by
maintainers). Paying agents in CREATE (the 40% work share would go to accounts that confirm each other). Hosting
benchmarks or compute (a running cost with no income line).

**Does AI help the token?** No AI feature creates a reason to hold CREATE. It helps the bear-market case more
narrowly: agents lower the cash a project needs, and AI tool companies' budgets do not follow crypto prices, which
makes them the right first sponsors.

## 8. How it fails, and the 90-day evidence for and against

| How it fails | Likelihood (judgment) | What is true today | Cheapest answer |
|---|---|---|---|
| A token with no demand | Certain as designed | Section 3 | Keep CREATE on paper until one paid use needs it |
| The record is self-graded | High once ranking matters | Only the founder makes and marks promises | An account outside the team confirms a kept promise; until then say "the founder says" |
| "Changed" is a free way out, and honesty ranks last | High | The rule counts kept + missed + changed toward the 2 answered, then needs kept >= missed + unanswered (`web/src/features/discover/lib/leaderboard.ts` lines 125-127, checked). All "changed" passes; 3 kept and 4 missed scores 0 | Need at least one kept; do not count "changed" toward the 2; show the changed count |
| Easy promises and deleted misses rank higher | High | Up to 10 promises an update; Discover does not show deletions | Cap promises counted a week; rank on the last 8 weeks; show records deleted |
| The scoreboard empties with growth | Certain with growth | One read of 500 records for 60 projects (`use-leaderboard.ts`, checked): about 8 a project | Read each project's updates separately |
| Fake accepted work between two accounts | High once profiles matter | The founder names the team; a second account can confirm | Show who confirmed; count only outside checkers in a public track record |
| Founders will not post misses | High | [DIRECTION.md](DIRECTION.md) lists it first | Measure "not done" against "changed" in the pilot |
| Supporters have nothing at stake | High | With investing off, nothing brings a reader back; with it on, price depends only on later buyers | Test money that pays only on accepted work, before any price curve |
| Empty rooms | Certain in Pilot A | Only founders are invited | One narrow group; about three helpers a founder (a proposal) |
| One owner doing everything | High | 29 open decisions, 11 built but not approved, no scheduled backups, the owner is the reminder service ([MVP-READY.md](MVP-READY.md)) | Freeze everything outside the weekly loop; one more person before a second batch |
| A copy with more users | High if the idea shows pull | The loop is open-licensed server records | A body of long, real records in one niche, before any token talk |

One correction in the product's favour: the scoreboard's code comment says a run of weeks can be back-dated. The
server refuses any record dated more than 15 minutes from its own clock (`handlers/ingest.rs`,
`MAX_TIMESTAMP_DRIFT_SECS = 900`, checked). The growth analyst repeated the comment; the skeptic is right.

**The planned test cannot settle the question.** Pilot A is three to five founders the owner picks, for 14 days, on
an invite-only server. It measures whether people who promised the owner two weeks kept that promise. Two analysts
would run it as written; the skeptic would replace it. My choice: run it as written, because it is cheap and tests
the one built part, then follow it at once with strangers. Do not count a Pilot A pass as evidence for the token.

**90 days: write the lines down before day 1** (thresholds are proposals with no data behind them).

| Evidence the thesis is alive | Evidence it is wrong |
|---|---|
| At least 10 founders the owner did not know start, and half post in 6 of their first 8 weeks unprompted | Fewer than half do, or none starts except by personal invitation |
| About 15% or more of answered promises are marked "not done" | Fewer than 1 in 10, or "changed" outnumbers "not done" |
| 3 in 10 help requests get an outside offer within a week; 10 tasks accepted between strangers | No outside offers; fewer than 5 such tasks |
| One outside sponsor pays 1,000 or more for accepted tasks, or three founders pay for a hosted tier | No money arrives without a price chart |
| 5 projects start from someone else's shared record | Founders say they would stay only if a token or a raise came with it |
| Outside no-money vouches predict third updates better than chance | They do not: the token has no selecting work to pay for |

Even a full pass shows a product people use in a quiet market. It does not show a reason to hold CREATE.

## 9. The ordered list of changes

| # | Change | Effort | What it proves | Needs |
|---|---|---|---|---|
| 1 | Write CREATE's hold and launch gates into [CREATE-TOKEN.md](CREATE-TOKEN.md): no sale, no main-network token, no token in marketing, until (for example) 100 projects with 12 weekly updates, a stated yearly sum of paid accepted work, and a stated number of real cases. Reject CREATE as pool currency in the same edit | Days | That the goal and the design stop contradicting each other | Owner |
| 2 | Run Pilot A as written, with the no-money vouch forecasts added, and the yes line in the report before day 1 | 2 weeks | Whether founders post a third update unprompted, and whether outsiders can predict who will | Owner |
| 3 | Fix the ranking before strangers see it: at least one kept promise, "changed" not counted toward the 2, a weekly cap, last 8 weeks, deleted and changed counts shown, per-project reads | 1 to 2 weeks | That "Most reliable" cannot be farmed for free | Owner (changes decision 18) |
| 4 | A second pair of eyes: an outside account confirms a kept promise; every accepted task shows who confirmed; the outside-checker request for a solo founder's agents | Weeks | That the record is more than its subject's claim | Owner |
| 5 | Open the door after Pilot A: public reads of listed projects whose founders agreed, a signed-out page of totals, a preview that carries the record, plain server-side counts of shared-link opens. The read side is uncommitted work in the tree (`crates/buzz-relay/src/api/public_read.rs`) | Weeks | Whether a shared record brings the next founder | Owner; counsel on public misses about named people (defamation, erasure) |
| 6 | Reminders outside the app: one email provider, four messages, the update day saved on the server (decision 14: yes, after Pilot A) | Weeks | That retention does not depend on the owner messaging by hand | Owner; counsel on the privacy note |
| 7 | Season 1 by hand: about ten strangers, eight weeks, entry by record and a small open panel, one deal page, a public last day | 8 to 10 weeks | Whether a batch, peers and a deadline do what "without being asked" did not | Owner |
| 8 | One sponsor pot inside the season: two or three sponsors from outside crypto pay helpers directly per accepted task; proof of payment on the record; no Creaton fee the first time | Weeks | Whether money arrives with no price chart: the whole bear-market claim | Owner; counsel on prize, grant and tax wording |
| 9 | Write the costs down and cap them: the real invoices, a monthly ceiling, a cheap pinned model, a per-project AI share, a lower cap for agent accounts (decision 28: keep the caps, add these) | Days | That the one cost that can jump is bounded in money | Owner |
| 10 | Freeze contract work the weekly loop does not need (pool changes, court, weekly sales, governance rework); write "stable currency only" and "no fee on trades, ever" into [DECISIONS.md](DECISIONS.md); correct "seven tiers" in [MVP-READY.md](MVP-READY.md) to the six in `BackingPoolFactory.sol` (checked) | Days | Nothing; it stops spend and decisions that answer no open question | Owner. Audit spend waits |
| 11 | Put the end goal in [DIRECTION.md](DIRECTION.md) in one paragraph, and add CREATE and the court to the outside reviewer's scope with the demand tables above | Days | That builders and reviewers work to the goal the owner states | Owner |
| 12 | Only after a season passes: a one-page choice on what CREATE may capture: vouching deposits, the fee on funded work paid per piece of work, and a locked slice to vouchers or to a treasury. Then build the first as a contract | Months | Whether paid selecting and checking gives the token real work | Owner, counsel and an audit |

## 10. What was not checked

- **No usage data exists.** No hosted server, outside founder, court case or paid task. Every project count, case
  rate, fee, deposit size, conversion rate and threshold in this review is an assumption with its arithmetic shown.
- **Nothing was run.** No build, test, model, server or browser, by instruction. "Built" rests on the repository's
  own documents and on reading code. Pool figures are the repository's model; only the quoted arithmetic was checked.
- **What I read myself:** `CreateToken.sol`, the ranking rule and read limits, the 15-minute clock rule, the agent
  rules header, the six depth tiers, the server price, the "no cohort" line, the invite-only preview rule, and the
  income lines in the money memo. The rest of the analysts' file references I took as given.
- **Outside figures** are web snapshots, many read through search summaries because the pages refused a direct
  read. Sources disagree on the meme launchpad's value (0.5 to 2.7 billion), the real-project launchpad's income
  fall (69 to 80%) and its value (79 to 142 million). Y Combinator's 600 billion and company count are third-party
  figures. One named reference point, Fomo, was found only as a private company valued at 550 million on about 33
  million of yearly trading income (June 2026); it has no token to compare.
- **The value spread** used for open-launchpad projects (90% nothing, 9% at 250,000, 0.9% at 5 million, 0.1% at 100
  million) is a guess. Designs (b) and (d) move tenfold either way with it.
- **Legal lines** are plain flags from the repository's notes and general knowledge. No lawyer has read them and no
  country was assessed. No legal text in the repository was reworded here.
- **Whether the owner holds "make people work for it" as a hard line** is recorded nowhere I found. Section 4 turns on it.
- **The marketing plan and the full pass over the 29 decisions** in [MVP-READY.md](MVP-READY.md) are separate
  pieces of work. This review touches decisions 4, 12, 14, 18, 19, 28 and 29 only where they bear on the token, the
  record or the bear-market case. On 29 (no fee on trades; one hand-run sponsored season): yes.
