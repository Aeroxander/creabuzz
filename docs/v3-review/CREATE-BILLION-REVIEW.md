# Can CREATE carry a billion dollars? A review of the whole product

Written 2026-11-15 for the owner. Seven analysts worked separately (token design, comparables, accelerator fit, bear
market, AI, growth, and a skeptic); this page joins their reports and says where they disagree. Nothing here is a
forecast of a price. Outside market figures are from web snapshots between July and 15 November 2026 that disagree with
each other; treat every one as a range. Revised the same day after three critics checked the sums and sources. Read with
[DIRECTION.md](DIRECTION.md), [MVP-READY.md](MVP-READY.md), [CREATE-TOKEN.md](CREATE-TOKEN.md),
[BEAR-MARKET-MONEY.md](BEAR-MARKET-MONEY.md) and [BACKING-POOL.md](BACKING-POOL.md).

## 1. The verdict in ten lines

1. **As designed, no.** CREATE has no claim on money, pays nothing for holding and has no buyback. Its only uses belong
   to a court that is hidden and frozen on test networks ([CREATE-TOKEN.md](CREATE-TOKEN.md), lines 10-22, 90).
2. One billion dollars is 1.00 dollar a token (supply is fixed at one billion, `contracts/src/CreateToken.sol`). The
   nearest working token of the same kind, a court deposit token, is worth about 6 to 8 million.
3. The platform takes in nothing today, on any money path. There is no income to send to any token design.
4. **As it could be under the recommended design: roughly 6 to 60 million dollars of deposit demand** at 10,000 active
   projects, about 65 with a slice for vouchers, on assumptions nobody has measured. That is dollars locked, not a
   market value. Fee income adds to it only if it buys or pays the token, which the recommendation rules out.
5. A billion needs one of three things: about 25 to 100 million a year of platform income that reaches the token; a
   slice of projects worth 14 to 50 billion together; or a bull-market multiple. Two are slow. The third is the crypto
   cycle. (Section 2 lists two more routes; one is switched off and the other is rejected.)
6. The one design that reached billions fast (every project priced in the platform token) saw its price fall about 87 to
   89% and would put every project's money in a falling token. It defeats the bear-market aim. Reject it.
7. **It is not a community-run accelerator yet.** One part is built well: weekly accountability on a public record.
   Selection, a batch, one deal, a demo day, mentors, follow-on money and alumni are missing, on paper or switched off.
8. **The bear-market strength is real.** The built loop needs no network, no token and no price, and costs about 110 to
   120 dollars a month to run at pilot size. It is safe in a crash. It does not yet take in a cent.
9. The record is the product, and today it is self-graded. A founder marks their own promises and any second account on
   the team can confirm work. Fix that before the record gates anything of value.
10. No stranger has used the product. Run the pilot, then one season. Keep CREATE unlaunched until it has paid work to
    do. A pass proves a useful product, not a billion-dollar token.

**Five things only you can decide this week.** ([MVP-READY.md](MVP-READY.md) holds a recommended answer for each of its
29 decisions; no separate pass over all 29 is written yet.)

| Decision | Recommended | If you choose otherwise |
|---|---|---|
| Is "make people work for it" a hard line: nothing for holding, and no slice of winning projects for holders? | Yes. Later, a small slice to vouchers only | Design (b) or (c) in section 4. (b) is a fund in law: choose it openly, with counsel first |
| Are the launch gates in change 1 the right ones? | Yes, with the figures edited to taste | CREATE can launch with almost no demand behind it |
| If Pilot A fails, stop or run a season? | Run one season with a deadline (section 5) | The weekly loop is rethought before any stranger is invited |
| May a small open panel select a batch? It changes "no cohort and no central selection" | Yes, for one hand-run season | No season. Creaton stays an open record tool and drops the accelerator claim |
| Does the accelerator goal go into [DIRECTION.md](DIRECTION.md) (change 11)? | Yes, one paragraph | Builders and reviewers keep working to a document that names no accelerator |

## 2. What a billion dollars would require, in numbers

**The price.** 1,000,000,000 dollars / 1,000,000,000 tokens = 1.00 a token, counting every token. If only the 20% sale
share trades (200 million tokens), one billion of traded value is 1,000 / 200 = 5.00 a token: 5 billion counting every
token.

**Four routes, each with its bar** (income, pay for judging, a slice, projects priced in CREATE; rows two and three
restate the income route). Multiples are yardsticks taken from other tokens on one day, not a method.

| Route | What must be true for one billion | Arithmetic | Where Creaton is today |
|---|---|---|---|
| Platform income (whether or not it reaches the token) | 25 to 100 million a year of platform income | 1,000 / 40 = 25; 1,000 / 10 = 100. At the largest meme launchpad's 3 to 5.6 times (unverified) it is 180 to 330 | 0. The owner memo's own sketch is 14,400 to 24,000 a year at 100 active projects (1,200 to 2,000 a month x 12, [BEAR-MARKET-MONEY.md](BEAR-MARKET-MONEY.md) lines 119-121) |
| ↳ the same, in paid work | 500 million to 3.3 billion a year of paid work through Creaton | 25 / 5% = 500; 100 / 3% = 3,333. The larger is about 83% of the biggest freelance marketplace's 2025 volume (about 4.03 billion) | 0. No money path in the hosted build |
| ↳ the same, in projects | 104,000 to 694,000 projects active at once | Memo income on all lines is 12 to 20 a project a month, so 144 to 240 a year. 25,000,000 / 240 = 104,167; 100,000,000 / 144 = 694,444 | 0 outside projects |
| Pay for judging (the design as written) | 200 million a year of juror fees | A juror wanting 20% a year, the return used in section 3: 1,000 x 0.20 | Court off. Test fee is 1 USDC a seat ([COURT.md](COURT.md)) |
| A slice of every project | Projects worth 14 to 50 billion together | 1,000 / 7% = 14.3; 1,000 / 2% = 50 | Creaton holds 0% of any project |
| Projects priced in CREATE | 1.12 billion standing in backing pools would be enough. It is sufficient, not necessary: a market can price a token above what is locked | The pool keeps 89.1% of each buy as reserve: 1,000 / 0.891 | Pool off, no audit, not deployed |

**Where the analysts disagree on the multiple.** They used 5.6, 10, 20, 40 and 114 times yearly income (5.6 and 114 are
unverified). I use 10 to 40 and show both ends. 40 is the closest real-project launchpad in 2026: about 79 million of
value over about 1.96 million of annualised income (556 + 377 + 534 thousand in three quarters of 2026, x 4/3; a public
data page, read through a search summary). At its highest 2026 snapshot, about 150 million, the same sum gives 77. That
income goes to its treasury, not to holders, and whether the value counts every token is not known. **Every multiple is
set by the crypto market and fell with it; no figure built on one is bear-market-proof.** At any of them the gap is
huge: 25,000,000 / 24,000 = about 1,000 times the memo's best case; 180,000,000 / 14,400 = about 12,500 times its worst.

**The slice route in plain terms.** At a 2% slice, 50 billion of project value is about 310 to 420 companies of Y
Combinator's average. YC's own press page says over 5,000 companies and over 600 billion, and 800 billion in another
place: 600 / 5,000 = 120 million each, 800 / 5,000 = 160 million (estimates, not audited; read through a search summary,
2026-11-15). Or it is about 300,000 open-launchpad projects on a guessed spread of outcomes. It is a selection problem,
not a volume problem, and the value arrives years late. YC's own deal is 125,000 dollars for 7% plus 375,000 on a second
paper (ycombinator.com/deal, read 2026-11-15).

**What others are worth (ranges; snapshots disagree).**

| Who | What pays the token | Value found | Basis | When the market fell |
|---|---|---|---|---|
| Largest meme launchpad | Half of net income buys the token since 28 April 2026, for one year; nearly all of it before (about 370 million bought and destroyed) | About 0.5 billion circulating and about 1.5 billion counting every token (one undated snapshot); "1.7 to 1.9 early Nov 2026" is unverified | Both, as stated | Income fell about 80% Jan to Jul 2025; token about 68% under its sale price (Jul 2026) |
| Largest agent launchpad | Every agent token had to be paired with it | Jan 2025 peak: about 5 billion counting every token (5.07 a token x 1 billion), about 3.3 billion circulating (x about 656 million tokens, a later supply figure). 2026: about 400 to 450 million circulating | Both, as stated | Price down about 87 to 89%; daily income fell from about 1 million to under 500 dollars by April 2025 |
| Closest real-project launchpad | A fee on trades, kept by its treasury; nothing is paid to holders | Peak about 246 million (Oct 2025); 79 to about 150 million in 2026 | Not known | Quarterly income fell about 70 to 80% in one quarter (sources differ) |
| A newer decision-market launchpad | Governance | About 25 to 36 million (Nov 2026; unverified) | Every token | Too new |
| Court deposit token (nearest to CREATE) | Court fees to jurors | About 6 to 8 million (Sep to Nov 2026) | Not known | Small throughout |
| Grants token for real work | Governance only | 6 to 15 million (2026) | Not known | Software arm and grants tool wound down (announced Apr 2025, ended May 2025); the grants rounds continue |
| A fundraising platform, no token | Sold to an exchange | 375 million, cash and stock (Oct 2025) | Sale price of a company | Not applicable |

Where the basis is not known, a multiple taken from that row may be off by the ratio of all tokens to circulating
tokens. No launchpad token whose product is a record, not trading, has come near a billion. Every one that did had large
income used to buy the token, a rule forcing projects to hold it, or a hot story in a rising market.

## 3. What CREATE is today and what demand it has

**What it is.** A fixed supply of one billion, created once to one holder, with no owner, no further creation, no pause
and vote checkpoints (`contracts/src/CreateToken.sol`, checked). Only a test token and a faucet exist.
[CREATE-TOKEN.md](CREATE-TOKEN.md) says "these are my calls": the design was the assistant's overnight decision. Only
"make people work for it" traces to the owner. The outside tokenomics brief leaves CREATE and the court out of scope
([TOKENOMICS-REVIEWER-BRIEF.md](TOKENOMICS-REVIEWER-BRIEF.md)), so nobody outside has checked the piece meant to carry
the largest value.

**Its uses, and their state.**

| Use | State | Does the built loop need it? |
|---|---|---|
| Deposit to judge cases | Court built for test networks, hidden in [DIRECTION.md](DIRECTION.md), frozen | No |
| Reviewer bonds | Optional per work budget; USDC works as well | No |
| Bond for a project built on another | On paper | No |
| Court fees | Payable in CREATE or USDC | No |
| Votes on court settings | Checkpoints built; the vote itself is later | No |

No step of Start, weekly update, promises, tasks or Discover touches CREATE. The token paper's own words: if the court
is not adopted, CREATE "has no reason to exist yet".

**Lasting demand if every written use were live** (the token analyst's arithmetic; case rate, seat fee and the 20%
return a juror wants are assumptions, not measurements).

| Active projects | Low: 0.1 cases a project a year | One case a project a year (unmeasured; high against the comparable) | Generous: 5 cases at 50 a seat |
|---|---|---|---|
| 100 | about 3,850 | 38,500 | about 481,000 |
| 1,000 | 38,500 | 385,000 | about 4.8 million |
| 10,000 | about 0.4 million | 3.85 million | about 48.1 million |

How: juror fees a project a year = 3.85 seats x cases x seat fee: 7.70 (0.1 x 20 dollars), 77 (1 x 20), 962.50 (5 x 50).
The deposit a juror would hold = fees / 0.2: 38.50, 385 and 4,812.50 a project. Average seats a case: 3 + 10% x 7 + 1% x
15 = 3.85 ([COURT.md](COURT.md) panel sizes). One case a project a year is 10,000 cases a year at 10,000 projects, far
more than the comparable court is known to handle. Bonds are left out: reviewer bonds (150 a project) and remix bonds
(50) can be posted in USDC, so they are demand for CREATE only if a rule forces them into CREATE. That would add 2
million.

**The supply works against it.** 40% of supply is to be paid out for work. At 1.00 a token that is 400 million dollars
of pay that workers must sell to live on, against at most about 63 million of locked demand at 10,000 projects (section
4). The court also holds at most 1,024 jurors.

## 4. The token designs compared, a recommendation, and the smallest first step

| Design | Dollars of demand the design can explain at 10,000 active projects (not a market value) | In an 80% crypto fall | Breaks which current rule | Legal exposure, one line |
|---|---|---|---|---|
| **(a) Work token as written** | About 0.4 to 48 million of juror deposits (section 3); 2 more only if bonds must be CREATE | Unaffected, and small | None | Least; the 20% sale is the part most likely to be read as a securities offering |
| **(b) Treasury holds a slice of every project** | About 33.5 million of project stakes at 2% on a guessed spread (0.09 x 250,000 + 0.009 x 5 million + 0.001 x 100 million = 167,500 a project; x 2% = 3,350; x 10,000) | Best of the five if projects are real | "No claim on any treasury"; Shares only from reviewed awards | A token over a pooled set of project stakes looks like an investment fund; heaviest of the five |
| **(c) Fee income buys back CREATE or pays holders** | 1.08 to 1.8 million a year of fees: 300 a month x 12 x 3 to 5% = 108 to 180 a project a year (memo option A), x 10,000. At 10 times: 11 to 18 million; at 40 times: 43 to 72. Needs 36 million a year of paid work through Creaton (10,000 x 3,600), unmeasured | A fee on trades dies with volume; a fee on paid work in a stable currency falls less | "No buybacks and no holder dividends"; "no fee on trades, ever" if on trades | The plainest "profit from others' work" pattern; a fee on other people's payments raises money-handling questions |
| **(d) Deposit CREATE to vouch for projects in a batch** | About 6 million locked. A voucher locks at most the reward's value today: a 1% slice worth 1,675 a project, after a 4-year wait at 30% a year, is 1,675 / 1.3^4 = about 590; x 10,000 projects vouched once. Less if vouchers share the slice with an endowment. The spread is from open launchpads, not a picked batch | Holds if deposits are sized in dollars and the reward is not new CREATE | "Not now: the vouch"; "no cohort and no central selection" | A deposit on how someone else's project turns out can read as a wager, or an investment if the reward is a piece of the project |
| **(e) CREATE as the currency of pools and rounds** | About 89 million locked (0.891 x 10,000 dollars x 10,000) | Every project's reserve, held money and refunds fall 80% together | "Free to start. No token needed."; the bear-market aim itself | Making people buy the platform token to back a project strengthens the investment reading |

These are dollars locked or taken in, not the value of all one billion tokens. A market may price the token above or
below them; that difference is the crypto cycle. The locked dollars also sit against the 40% work share in section 3.

**Where the analysts disagree, and my choice.** The comparables analyst would give a CREATE-governed treasury a 2 to 5%
slice of every project, because that is how an accelerator is worth anything. The token analyst would pay a small slice
only to the people who vouched for that project, never to holders. I choose the second as the first step. It keeps the
owner's one traced line ("make people work for it"), it carries less legal weight, and a plain holder index is still
worth only about 33.5 million at 10,000 projects on these guesses. Be clear about the cost: under that choice the value
reaches workers, not holders, so the token is worth its deposit demand and little more. If the owner wants holders to
own the winners, that is design (b), a fund in law, and it should be chosen openly.

**Recommendation: a mix, and no launch yet.**

1. Keep CREATE a work token, with no buyback and no payout for holding.
2. Widen the paid work from judging to **selecting and checking projects in a batch**: a deposit to vouch, settled on
   work checked by someone outside the team, with the court as the appeal.
3. Pay that work from a **visible 3 to 5% fee on funded work, in a stable currency**, per piece of work done. No fee on
   trades, ever.
4. Later, with counsel and the outside reviewer: a batch project that opts in gives 1 to 2% as locked, non-voting units
   to those who vouched for it, part to a Creaton endowment that funds work budgets.
5. Reject CREATE as the currency of pools and rounds, and write that down.

**What the mix supports at 10,000 active projects: deposits only.** A fee paid to people who do the work is their pay,
not income to the token. So it is counted by the section 3 method, as the deposit a worker would hold to get that pay:
1.08 / 0.2 = 5.4 million; 1.8 / 0.2 = 9 million. In millions, steps 1 to 3 are court deposits plus these: 0.4 + 5.4 =
5.8 (low, 0.1 cases); 3.85 + 5.4 = 9.3 (one case); 48.1 + 9 = 57.1 (generous). Step 4 adds the 5.9 of design (d): 11.7,
15.2 and 63. That is roughly 6 to 60 million without a slice and up to about 65 with one: 0.6% to 6.5% of a billion, and
it is dollars locked, not a market value. Add 2 if bonds must be CREATE. The fee is counted once, as the vouchers'
reward. The 40-times line (43 to 72 million) belongs only to design (c), which is rejected here.

**The smallest first step costs no contract and no token.** Ask outsiders for signed, no-money forecasts on one question
per project: "will this founder post a third weekly update without being asked?" In Pilot A this is only a rehearsal of
the method. Keep it from the founders until day 14, because being watched is a form of being asked. The deciding test is
the strangers of weeks 5 to 12 and the season: at least 5 forecasters and 30 forecast projects. Below that the result is
"not known". If outside vouches then do not predict records better than chance, design (d) has no work to pay for and
CREATE stays unlaunched, with bonds in a stable currency, as its own paper already says. The marketing plan needs
matching steps: five outsiders invited in week 2, one forecast a new project from week 5. (A no-money forecast record is
said to be built; I did not check it fits this use.)

## 5. Is it a community-run YC yet: built, designed, missing

**No, and the repository says so.** "Y Combinator" appears in one document, which also says "There is no cohort and no
central selection" ([TOKENOMICS-REVIEWER-BRIEF.md](TOKENOMICS-REVIEWER-BRIEF.md) lines 9-13, checked).
[DIRECTION.md](DIRECTION.md) names no accelerator, batch, selection or demo day. The owner's stated end goal is in no
vision or direction document.

| Accelerator part | State | Note |
|---|---|---|
| Weekly accountability | **Built**, tested on a laptop only | Goal, weekly update, promises marked kept, missed or changed, tasks with a finish line, a check by someone else, a public scorecard |
| Selection | **Missing, on purpose** | Anyone with an invite can start; on an open server, anyone. The owner hand-picks Pilot A. The vouch is on paper |
| A batch with a deadline | **Missing** | A weekly rhythm exists; no shared start, end or peers |
| One standard deal | **Designed several times, none live** | The pool is the nearest: fixed terms, off, not deployed, no audit |
| Demo day | **Missing** | Scorecard and share pictures exist; on an invite-only server no outsider can open them |
| Follow-on money | **Built or designed, all off** | Pool, weekly sales, auction raise, card payments. No investor side |
| Mentors and office hours | **Missing as people** | AI drafts and questions stand in. No terms for advisors |
| Alumni and brand | **Empty** | Profiles carry a track record; no project has finished anything |

**The pool is not an accelerator cheque.** Over a year of 13 milestones a project receives about 10.7% of what backers
put in: 1% fee + 9.9% held x (1 - 0.75^13 = 0.976) = 1% + 9.66%. A round at the default minimum of 2,500 gives the
project 25 at once and about 62 at the first milestone (2,500 x 0.99 x 0.10 / 4). To deliver 125,000, about 1.17 million
must stand in the pool through every milestone (125,000 / 0.1066). And a holder who cares only about price does best by
leaving at the first milestone, which cuts the project's take to about 1.9% (10 + 8.91 per 1,000). Numbers are from
[BACKING-POOL.md](BACKING-POOL.md) and its model; no one reran them for this review.

**Where Creaton is already stronger than an accelerator.** The record is public and signed. A miss stays unless the
founder deletes the whole update; the project page shows how many records were deleted, Discover does not
(`web/src/features/launchpad/lib/promises.ts`, checked). Start is free with no token, for anyone with an invite. Agents
are labelled helpers with limited powers and a command line. A helper never confirms their own task. Promises are still
marked by the founder who made them (section 8). The loop needs no network. The platform takes no slice of the founder's
project. That last strength is also the hole in the token case: an accelerator is worth what it owns of its winners.

**Why selection matters (outside evidence, from search summaries).** On a permissionless sibling of the closest
real-project launchpad, 2 of 54 projects met their goal by mid-March 2026, later 12 of 95 (5 October 2026; 82 missed,
one not yet open). In November 2026 one report said it would drop the word "permissionless" and moderate at platform
level. A further claim, that 6 of 41 launchpad token sales since 2025 were above their sale price on 31 March 2026, is
unverified and nothing here rests on it. An open door alone does not produce fundable projects. A record of kept
promises is a real selection edge, and today it gates nothing.

**The smallest loop that makes the claim true: one hand-run season.** A fixed start and eight weeks. Entry opened by the
record (two or three weekly updates under the ranking rule as fixed in change 3) and confirmed by about five members
with accepted work, in the open, with a one-line reason each. Before the panel meets, the owner or one panel member
opens the evidence for each applicant's kept promises and writes one line; nothing is built for this. One deal on one
page: with no network, a sponsor pot paid per accepted task (25 a task, up to 10 tasks, is at most 250 a project and
2,500 for ten). A weekly thread where season founders question each other's updates. A public page of the season's
scorecards on the last day. A season mark on project and profile; finishing a season is how one joins the next panel.
None of this needs a contract. Add no demo day to Pilot A itself; a deadline would spoil its one number.

## 6. What keeps working in a bear market, and the scoreboard that is not price

**What keeps working.** Start, the weekly update, promises, help requests, tasks with an independent check, the record,
Discover by kept promises and the agent command line involve no network, no Shares and no price
([MVP-READY.md](MVP-READY.md), "What a founder can do today"). An 80% fall changes nothing about how they work or what
they cost. Nothing yet shows the loop grows in a quiet market; no stranger has used it.

**What it costs.** About 110 to 120 dollars a month at pilot size: about 88 list price for the recommended machine
(`deploy/ovh/README.md`; the real invoice is not in the repository), plus about 20 for backups, a domain and an uptime
check and about 4 for AI at pilot use (both guesses). The AI service has a call ceiling and no money ceiling: 2,000
calls a day x 30 = 60,000 a month, which is 600 to 1,200 dollars at a guessed 1 to 2 cents a call.

**What would cover it, without trading.** About 3,800 a month of paid work at a 3% fee (115 / 0.03; about 13 projects
moving 300 each), or 5 projects on a 25-dollar hosted tier (115 / 25 = 4.6). A sponsored season does not cover it: 2,500
a quarter at 5% is 125 a quarter, about 42 a month, and the first season carries no Creaton fee. Until AI has a money
ceiling the line to cover is higher: (115 + 600 to 1,200) / 0.03 = about 24,000 to 44,000 a month of paid work. One
full-time person at a guessed 8,000 a month is a different size: 8,000 / 0.03 = about 267,000 a month of paid work,
about 890 projects. **None of these lines exists.** The owner pays through the pilots.

**What is still tied to the cycle.** The pool, its opening round and CREATE. All are off by default. Keep them off the
scorecard, the share pictures and the Discover ranking, so a failed round or a falling price cannot mark a project's
record. The pool's currency is chosen when it is deployed; write down that it is a stable currency only.

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

Make the pay line the headline; every later income line is a share of it. Today none of these can be shown to the world:
the hosted server is invite-only and a shared link is a dead end for a reader without an invite. A signed-out page of
totals only (no names, no price) is the cheapest fix.

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
- The four AI project kinds are starter text. "Open to agents" is a filter; every request is already open to agents.
- The "labour market for agents" is a record book: no pay, the record lives on one server, the operator can delete it.
- Labelling costs an agent powers and gains it nothing; an unlabelled account is treated as a person.
- **A solo founder running their own agents can never get that work accepted**, because the operator may not confirm it.
  The "one person plus agents" case has a hole in the middle.

**Worth adding, in order.** (1) Checks fixed on the task before work starts, rerun and signed by the checker, shown side
by side with the helper's run. (2) A ready-made help request, "Someone to check my agent's work", and a team role that
only confirms or sends back. (3) The AI kind's starter tasks written to the project as drafts (tasks yes, promises no).
(4) An agent work card: accepted pieces, on how many projects, by how many different checkers, who runs it; no score.
(5) A lower daily AI cap for labelled agents: four accounts at 500 calls use the whole 2,000.

**Traps. Do not build.** Tokens for agents (the category leader's price is about 87 to 89% below its peak; an offering
question for each one). An agent score or ranking (cheap to farm while a friend can confirm a friend). An AI that
accepts work (in a March 2026 outside study, about half of benchmark-passing changes would have been rejected by
maintainers). Paying agents in CREATE (the 40% work share would go to accounts that confirm each other). Hosting
benchmarks or compute (a running cost with no income line).

**Does AI help the token?** No AI feature creates a reason to hold CREATE. It helps the bear-market case more narrowly:
agents lower the cash a project needs. AI tool companies are the planned first sponsors on the assumption that their
budgets do not follow crypto prices. That is not shown, and they have a funding cycle of their own, so change 8 asks for
at least one sponsor outside both crypto and AI tools.

## 8. How it fails, and the 90-day evidence for and against

| How it fails | Likelihood (judgment) | What is true today | Cheapest answer |
|---|---|---|---|
| A token with no demand | Certain as designed | Section 3 | Keep CREATE on paper until one paid use needs it |
| The record is self-graded | High once ranking matters | Only the founder makes and marks promises | For season 1 a panel member opens the evidence by hand (change 7); build the outside confirm after it (change 9); until then say "the founder says" |
| "Changed" is a free way out, and honesty ranks last | High | The rule counts kept + missed + changed toward the 2 answered, then needs kept >= missed + unanswered (`web/src/features/discover/lib/leaderboard.ts` lines 125-127, checked). All "changed" passes; 3 kept and 4 missed scores 0 | Need at least one kept; do not count "changed" toward the 2; show the changed count |
| Easy promises and deleted misses rank higher | High | Up to 10 promises an update; Discover does not show deletions | Cap promises counted a week; rank on the last 8 weeks; show records deleted |
| The scoreboard empties with growth | Certain with growth | One read of 500 records for 60 projects (`use-leaderboard.ts`, checked): about 8 a project | Read each project's updates separately |
| Fake accepted work between two accounts | High once profiles matter | The founder names the team; a second account can confirm | Show who confirmed; count only outside checkers in a public track record |
| Founders will not post misses | High | [DIRECTION.md](DIRECTION.md) lists it first | Measure "not done" against "changed" in the pilot |
| Supporters have nothing at stake | High | With investing off, nothing brings a reader back; with it on, price depends only on later buyers | Test money that pays only on accepted work, before any price curve |
| Empty rooms | Certain in Pilot A | Only founders are invited | One narrow group; about three helpers a founder (a proposal) |
| One owner doing everything | High | 29 open decisions, several already built and awaiting a yes, no scheduled backups, the owner is the reminder service ([MVP-READY.md](MVP-READY.md)) | Freeze everything outside the weekly loop; one more person before a second batch |
| A copy with more users | High if the idea shows pull | The loop is open-licensed server records | A body of long, real records in one niche, before any token talk |

**The planned test cannot settle the question.** Pilot A is three to five founders the owner picks, for 14 days, on an
invite-only server. It measures whether people who promised the owner two weeks kept that promise. Two analysts would
run it as written; the skeptic would replace it. My choice: run it as written, because it is cheap and tests the one
built part, then follow it at once with strangers. Do not count a Pilot A pass as evidence for the token.

**90 days: write the lines down before day 1** (thresholds are proposals with no data behind them). Even a full pass
shows a product people use in a quiet market, not a reason to hold CREATE.

| Evidence the thesis is alive | Evidence it is wrong |
|---|---|
| At least 10 founders the owner did not know start, and half post in 6 of their first 8 weeks unprompted | Fewer than half do, or none starts except by personal invitation |
| About 15% or more of answered promises are marked "not done" | Fewer than 1 in 10, or "changed" outnumbers "not done" |
| 3 in 10 help requests get an outside offer within a week; 10 tasks accepted between strangers | No outside offers; fewer than 5 such tasks |
| One outside sponsor pays 1,000 or more for accepted tasks, and at least one sponsor is outside both crypto and AI tools | No money arrives without a price chart, or only from one sector |
| Income to Creaton itself: three founders pay for a hosted tier | Nobody pays Creaton anything; a sponsor pot alone leaves platform income at zero |
| 5 projects start from someone else's shared record | Founders say they would stay only if a token or a raise came with it |
| Outside no-money vouches predict third updates better than chance, on at least 30 projects from at least 5 forecasters | They do not: the token has no selecting work to pay for. Fewer than 30 projects: "not known" |

## 9. The ordered list of changes

| # | Change | Effort | What it proves | Needs |
|---|---|---|---|---|
| 1 | Write CREATE's hold and launch gates into [CREATE-TOKEN.md](CREATE-TOKEN.md). Proposed figures, for the owner to edit: no main-network token, no sale and no token in marketing until all three hold for two quarters in a row: 1,000 projects with 12 or more weekly updates; 1 million dollars a year of stable-currency pay for accepted work from payers who are not the helper; 100 real cases decided. And counsel has read the sale. Reject CREATE as pool currency in the same edit | Days | That the goal and the design stop contradicting each other | Owner |
| 2 | Run Pilot A as written, with the yes line in the report before day 1. Collect no-money forecasts only as a rehearsal, kept from the founders until day 14; they decide nothing | 2 weeks | Whether founders post a third update unprompted | Owner |
| 3 | Fix the ranking before strangers see it: at least one kept promise, "changed" not counted toward the 2, a weekly cap, last 8 weeks, deleted and changed counts shown, per-project reads | 1 to 2 weeks | That "Most reliable" cannot be farmed for free | Owner (changes decision 18) |
| 4 | Write the costs down and cap them **before the door opens**: the real invoices, a monthly money ceiling at the AI provider, a cheap pinned model, a per-project AI share, a lower cap for agent accounts (decision 28: keep the caps, add these) | Days | That the one cost that can jump is bounded in money | Owner |
| 5 | Open the door after Pilot A and after change 4: public reads of listed projects whose founders agreed, a signed-out page of totals, a preview that carries the record, plain server-side counts of shared-link opens. The read side is uncommitted work in the tree (`crates/buzz-relay/src/api/public_read.rs`) | Weeks | Whether a shared record brings the next founder | Owner; counsel on public misses about named people (defamation, erasure) |
| 6 | Reminders outside the app: one email provider, four messages, the update day saved on the server (decision 14: yes, after Pilot A) | Weeks | That retention does not depend on the owner messaging by hand | Owner; counsel on the privacy note |
| 7 | Season 1 by hand: about ten strangers, eight weeks, entry by record and a small open panel, kept promises checked by hand before the panel meets, one forecast a project, one deal page, a public last day | 8 to 10 weeks | Whether a batch, peers and a deadline do what "without being asked" did not | Owner |
| 8 | One sponsor pot inside the season: two or three sponsors, at least one from outside both crypto and AI tools, pay helpers directly per accepted task; proof of payment on the record; no Creaton fee the first time | Weeks | Whether money arrives with no price chart. It does not test income to Creaton; the hosted-tier line in section 8 does | Owner; counsel on prize, grant and tax wording |
| 9 | After the season, build the second pair of eyes: an outside account confirms a kept promise; every accepted task shows who confirmed; the outside-checker request for a solo founder's agents | Weeks | That the record is more than its subject's claim | Owner |
| 10 | Freeze contract work the weekly loop does not need (pool changes, court, weekly sales, governance rework); write "stable currency only" and "no fee on trades, ever" into [DECISIONS.md](DECISIONS.md); correct "seven tiers" in [MVP-READY.md](MVP-READY.md) to the six in `BackingPoolFactory.sol` (checked) | Days | Nothing; it stops spend and decisions that answer no open question | Owner. Audit spend waits |
| 11 | Put the end goal in [DIRECTION.md](DIRECTION.md) in one paragraph, and add CREATE and the court to the outside reviewer's scope with the demand tables above | Days | That builders and reviewers work to the goal the owner states | Owner |
| 12 | Only after a season passes: a one-page choice on what CREATE may capture: vouching deposits, the fee on funded work paid per piece of work, and a locked slice to vouchers or to a treasury. Then build the first as a contract | Months | Whether paid selecting and checking gives the token real work | Owner, counsel and an audit |

## 10. What was not checked

- **No usage data exists.** No hosted server, outside founder, court case or paid task. Every project count, case rate,
  fee, deposit size, conversion rate and threshold in this review is an assumption with its arithmetic shown.
- **Nothing was run.** No build, test, model, server or browser, by instruction. "Built" rests on the repository's own
  documents and on reading code. Pool figures are the repository's model; only the quoted arithmetic was checked.
- **What I read myself:** `CreateToken.sol`, the ranking rule and read limits, the 15-minute clock rule, the agent rules
  header, the six depth tiers, the server list price, the "no cohort" line, the invite-only preview rule, the
  promise-deletion note, and the income lines in the money memo. The analysts' other file references I took as given.
- **Outside figures** are web snapshots, many read through search summaries because the pages refused a direct read.
  Checked again by search on 2026-11-15: the 28 April 2026 buyback rule, the wound-down grants tool, 2 of 54 and 12 of
  95, zero holder income at the real-project launchpad, and YC's press page. Marked "unverified" in the text: the
  multiples 3 to 5.6 and 114, the 25 to 36 million, 6 of 41, and the early-November meme launchpad value. Sources
  disagree on the real-project launchpad's income fall (69 to 80%). One named reference point, Fomo, is a private
  company valued at 550 million (June 2026); its income figures are company claims, from about 50 to over 200 million a
  year, unverified. It has no token.
- **The value spread** used for open-launchpad projects (90% nothing, 9% at 250,000, 0.9% at 5 million, 0.1% at 100
  million) is a guess. Designs (b) and (d) move tenfold either way with it.
- **Legal lines** are plain flags from the repository's notes and general knowledge. No lawyer has read them and no
  country was assessed. No legal text in the repository was reworded here.
- **The owner's hard line and the 29 decisions.** Whether "make people work for it" is a hard line is recorded nowhere I
  found. The marketing plan is [MARKETING-PLAN.md](MARKETING-PLAN.md). This review touches decisions 4, 12, 14, 18, 19,
  28 and 29 of [MVP-READY.md](MVP-READY.md) only where they bear on the token, the record or the bear-market case. On 29
  (no fee on trades; one hand-run sponsored season): yes.
