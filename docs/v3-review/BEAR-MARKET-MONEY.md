# Money options for a quiet market (memo for the owner, 2026-11-15)

Status: **a memo, on paper only.** It changes no contract, no app screen and no number. Nothing here is built, offered or
promised to anyone. Every figure marked "proposal" is mine and needs your yes. Every option that moves money needs counsel
before it touches real money, and says so below.

It follows the direction of 2026-11-10 ([DIRECTION.md](DIRECTION.md)): Creaton is where a project states a goal, does its
work in the open and lets anyone see whether it kept its promises. It uses the run model for the backing pool
(a float model of the pool's own buy and sell rules, rerun with `python3 run_model.py`; it is a model, not the contract)
and the analysts' notes for this push.

## Rules for the words, first

These hold for every option below and for any screen or page that ever describes one.

- **Nothing is described as returns, profit, growth or a safe place for money.** A supporter gives, a sponsor funds a
  task, a project is paid for accepted work. None of that is an investment, and no page says or hints that it is.
- **Shares are a thanks for work that was accepted.** Say "thanks", never "pay" or any word of winning, next to Shares.
  Backing units are not Shares and carry no vote.
- **Price and returns appear only in the Home feed.** The numbers in this memo are for you. They do not go on a project
  page, a Start screen or a sponsor page.
- **Trading and investing stay off by default.** Nothing here turns either on.
- **Legal lines stay whole.** The terms, the privacy note, the age box and "Buyers acquire ownership only..." are not
  reworded, shortened or moved by anything in this memo.
- **Creaton never holds anyone's money.** In every option below the money goes from the person who gives it to the person
  who is paid, or into a contract that nobody at Creaton controls. That is the posture the lawyer brief already rests on
  (no custody by the operator, [LAWYER-BRIEF-WEEKLY-SALES.md](LAWYER-BRIEF-WEEKLY-SALES.md)). An option that breaks it
  needs its own counsel round.

## The short answer

1. **Today Creaton takes in nothing, and the money path pays a project very little when few people buy.** The only money
   path built (the backing pool, not deployed, off by default) sends a project 1% of each buy and sale at once and holds
   10% of the rest, which is released a quarter at a time no sooner than 28 days in. The fee never goes to Creaton. The
   hosted build has no money path at all.
2. **Creaton's costs are real and nobody has written them down.** A server, backups, the AI service and (only if a network
   with real money is ever used) sponsored network fees. The first three are small and bounded. Until an income line
   works, you pay them.
3. **A quiet market cannot be fixed by tuning the pool.** What holds in a quiet market is work that gets paid when it is
   accepted, small amounts in a stable currency, and sponsors who want a theme finished. None of the three needs a price
   curve.
4. **Recommended order:** free to start and a written cost line now; sponsors by hand next; a paid hosted tier after Pilot A
   shows what founders value; the money steps (supporter pledges, "pay when accepted", "fund this task") only with a chain,
   counsel and, for the last, an audit; the pool and its changes only if you ever turn investing on.

## 1. How Creaton sustains itself, and from what

### What comes in today

| Source | What the repository says | Income to Creaton |
|---|---|---|
| Backing pool | 1% of each buy and each sale goes to the project's treasury, "never to an operator" ([BACKING-POOL.md](BACKING-POOL.md)) | 0 |
| Old weekly rounds and funding terms | The sale of new units paid the project's treasury "with no cut". The exit fee (suggested 2%, at most 5%) stays in the project's treasury "for those who remain, not to the team" ([FUNDING-TERMS.md](FUNDING-TERMS.md), now history: deprecated in D185) | 0 |
| Weekly sales between holders | Built and checked locally, off by default, "no fee in the candidate" ([STATUS.md](STATUS.md)) | 0 |
| Forecast pools | "No platform or DAO money." Pools were people's own money, capped at 1,000 per wallet per bounty, and were removed in D150 and D151 ([MONEY-FORECASTS.md](MONEY-FORECASTS.md), history) | 0 |
| The hosted build | Contributor and project loop only. No raise, no sale, no market | 0 |

Every money line in those documents pays the project, never the platform. So this is not a bear-market problem that gets
worse; the platform line was always zero. A bear market only takes away the hope that trading would pay for it.

### What a project gets from the pool when few people buy

From the pool's own rules: 1% fee at once; 10% of what is left after the fee is held in the person's name; a quarter of
the held money goes to the project at each milestone; the first milestone can be posted 28 days after opening, then
7 days to leave and up to 7 days to release, so the first part arrives between about day 35 and day 42; then one every
28 days.

| Backers put in | Fee at once (1%) | Held for the project (9.9%) | First part, about day 35 to 42 (a quarter of held) |
|---|---|---|---|
| 300 | 3 | 29.7 | about 7 |
| 1,000 | 10 | 99 | about 25 |
| 3,000 | 30 | 297 | about 74 |
| 10,000 | 100 | 990 | about 248 |
| 50,000 | 500 | 4,950 | about 1,238 |

Reading it:

- **To pay one contributor 2,000 a month from held money** you need about 80,800 standing in the pool for the first part
  (2,000 divided by 2.475%), and each later part is 75% of the one before it. Over a full year of 13 milestones the project
  gets about 9.7% of what backers put in, and only from backers who stay at every milestone.
- **To pay 2,000 a month from fees alone** you need about 200,000 of buying and selling every month (2,000 divided by 1%).
  A quiet market does not do that.
- **A round has to clear its minimum.** The default minimum is 2,500, the whole round at the opening price. Under it, every
  bidder is refunded and nothing opens. In a quiet week that is the likely outcome.

Source for the pool numbers: [BACKING-POOL.md](BACKING-POOL.md) "Every setting and its default" and the run model, section
H. Those are testnet defaults, not production terms, and the pool is deployed nowhere.

### What it costs Creaton, month by month

I could not find a single invoice figure in the repository, so the money column is yours to fill. These are the lines:

| Line | What drives it | Bound today | Your monthly figure |
|---|---|---|---|
| Server | One rented machine (the setup notes describe a single OVHcloud server) | One server | to fill |
| Backups | Encrypted copies kept off the machine, plus a restore rehearsal | Storage you choose | to fill |
| AI service | Calls to the language model for drafts and checks | 500 calls a day per account and 2,000 a day for the whole community, so at most 60,000 calls a month (`BUZZ_LLM_MAX_CALLS_PER_DAY` and `BUZZ_LLM_MAX_CALLS_PER_DAY_TOTAL`); times your price per call | to fill |
| Domain, mail, monitoring | Outside uptime check and the address | Fixed | to fill |
| Sponsored network fees | Only when a network with real money is used. The hosted build has no chain, so it is zero today | Today one global spending limit on the test network, not per account | 0 until a chain is on |

The AI line has a hard ceiling (the community cap), so a bear market cannot make it grow without bound. The network fees
line does not have one per account yet. See decision 7.

### Four ways Creaton could take in money, with numbers

Scale used below: a project "funded" this month moves 300 through Creaton (my assumption, not data).

| Option | How it would work | Number (proposal) | At 10 projects | At 30 | At 100 | What it needs |
|---|---|---|---|---|---|---|
| **A. A small fee on funded work** | 3 to 5% taken as a separate, visible transfer when a task is paid or a pledge is sent. Never on a trade | 3 to 5% of 300 a project a month | 90 to 150 | 270 to 450 | 900 to 1,500 | The money steps in section 2 must exist first. Counsel before real money (fees on other people's funds). No contract change if taken in the send step |
| **B. A paid hosted tier** | Extra agent seats, private drafts and the AI drafting that costs us money | 20 to 30 a month; assume one project in ten pays 25 (my assumption) | 25 | 75 | 250 | A payment provider, terms for the tier, a privacy-note change counsel reads. No chain, no contract |
| **C. Sponsored seasons** | A sponsor funds 3,000 to 10,000 of task money for a theme (for example tools for AI projects). Creaton keeps a handling fee | 5 to 10% of one season a quarter: 150 to 1,000 a season | about 50 to 330 a month, any number of projects | same | same | Sponsor agreements, counsel on the fee, hand-run payouts to start. No contract, no chain to begin with |
| **D. A fee on trades** | Not proposed | None | 0 | 0 | 0 | See below |

Why not a fee on trades: it dies with volume, which is the thing a quiet market does not have; trading is off by default;
and "no fee, no operator in the flow" is part of what keeps the exchange questions in the lawyer brief small. Write it down
as a rule (decision 4).

Taken together, at about 100 active projects and everything built, A, B and C are of the order of 1,200 to 2,000 a month,
**none of it before the steps they depend on exist.** At 10 projects, A and B are under 200 a month in total, which does
not pay for a server and an AI service on its own. Plan on paying the costs yourself for the length of the pilots.

### The free allowance for sponsored network fees

Only matters when a network with real money is used. The hosted build has none today. When it does, "free to start" can
be run up by spam, and a quiet market is when spam is cheapest compared with what it wins. Proposal: a per-account weekly
allowance of about 50 sponsored steps, shown to the person, then "add your own fee or wait". Today the limit is one global
number on the provider's side. It is a setting at the provider plus a small hint on screen, not a contract change. Your
number to choose (decision 7).

## 2. How a project is funded when backers are scarce

Six ways, from least to most. Each says what it needs and what can go wrong. "Chain" means a network that holds real
money, which the hosted build does not have.

| # | Option | What it is | Counsel | Audit | Contract change | Chain | Main risk |
|---|---|---|---|---|---|---|---|
| 1 | **Free, no-money start** | Start asks for a goal; no token, no raise, no fee. The record is the product. Built | No | No | No | No | No money for helpers, so work leans on volunteers and agents |
| 2 | **Small minimum raises** | Offer "small start" (minimum about 250), "standard" (500) and "big" (2,500, today's) for the pool's round | Yes, it is a sale | No (terms only) | No: the founder can already lower the minimum; the app would offer the presets | Yes | A small raise pays a project very little (table above); founders may be let down. Only matters if the pool is on |
| 3 | **Shorter rounds, faster first release** | A 3-day round and a first release at day 7 to 14 for small pools | Yes | Yes (a new factory with different terms) | Yes: the round length must divide 10,000,000 blocks, so 3 days is not on today's grid; new terms mean a new factory | Yes | Releasing sooner gives backers less time to leave. Only if the pool is on |
| 4 | **Grants and sponsors** | A public list of sponsors with open pots, for example 25 for each accepted task up to 10 tasks a project. Start by hand: three sponsors listed by hand, each pays the helper directly, the payout link is recorded on the project's record | Yes, wording ("thanks", a grant is not a sale) and Creaton's fee | No | No | Not to start (a sponsor can pay by any method and post the proof); yes to show it as a network transfer | A sponsor who does not pay; mitigated because the record shows "accepted, unpaid" |
| 5 | **Monthly patronage in a stable currency** | A "support monthly" pledge: a signed promise that says "I will send X a month while this project keeps posting". The app reminds; the supporter sends. No automatic debit, nothing held | Yes: it must say "a pledge, not a contract" and never imply a return | No | No (a new kind of record on the server) | Yes for the send | Pledges are not binding and may be read as a guarantee. The pledge shows "paused" after two weeks without an update, so silence costs the project |
| 6 | **Pay when accepted** | (a) The founder pays an accepted task from their own account and the transfer link is posted to the task. (b) "Fund this task": a supporter funds a fixed amount held by a contract, paid to the helper after the independent check, refunded otherwise | (a) light, (b) yes | (a) no, (b) yes | (a) no, (b) yes: the bounty contracts are frozen on test networks | Yes | (a) The founder may not pay (not held in advance); the record shows it. (b) Money moves: it needs the frozen contracts unfrozen, audited and wired to the same "accepted" signal the Work page uses |

What fits a bear market best is 4, 5 and 6, because they pay for work that was done or for a project that keeps posting,
and none of them needs anyone to want to buy a price.

One more way that costs no money: **agents as helpers.** A helper is an account, labelled as an agent. A small project that
cannot pay people can still get tasks done at the cost of the AI service. That lowers the money a project needs, but it
does not remove it, and an agent never moves money or accepts its own work.

### Questions to put to counsel, option by option

- **Fee on funded work (A):** is a visible 3 to 5% on a task payment a money-handling activity if Creaton never holds the
  money? Does it change if the fee is a separate transfer or a deduction?
- **Sponsored seasons (C, 4):** is a sponsor's pot a grant, a prize or a promotion, and what does Creaton owe the sponsor
  and the helpers? Can the handling fee be a flat sum instead of a share?
- **Supporter pledges (5):** with no money held and nothing debited, is a signed monthly promise a gift flow? What must the
  words say so it is not a promise of anything back?
- **Pay when accepted (6a):** does a public "accepted, unpaid" line about a named founder raise defamation or fairness
  questions, and what notice should the founder get first?
- **Fund this task (6b):** the usual questions for money held by a contract and paid on a check: who decides "accepted",
  and what happens to the money when nobody decides?
- **A paid tier (B):** consumer terms, refunds and tax, and whether paid private boards sit against "does its work in the
  open" in the terms.

## 3. If investing is ever turned on: what the run model found

This section is on file only. The pool stays off, nothing here is built, and the plan's decision is that no contract
changes in this push. If you ever turn the pool on, read this first.

### Why the shape of the price curve matters in a thin market

The pool sells units along a price curve. Each buy moves the price up and each sale moves it down. How much one trade moves
it depends on the curve's **depth**: a deep curve is like a deep pond, where a big seller makes small waves; a shallow one is
like a shallow dish, where the same seller sends a wave over the rim.

Today the depth is the same for every pool (25,000), whatever it raised. That is fine for a pool that raised about 10,000
and bad for a pool that raised much more. In a thin market there are few buyers to catch a seller, so the price falls
until the curve itself is the only buyer, and a falling price makes the next holder sell. That chain is what a run is.

The drop in the price when half of all units are sold, at today's fixed depth (run model, section A):

| Backers put in | Price drop if half the units are sold | Same, with depth set at 100,000 |
|---|---|---|
| 2,500 | 8.3% | 2.2% |
| 5,000 | 15.7% | 4.3% |
| 10,000 | 28.0% | 8.3% |
| 25,000 | 52.1% | 19.0% |
| 50,000 | 72.0% | 33.1% |
| 100,000 | 87.1% | 52.1% |
| 250,000 | 96.6% | 77.6% |

The better rule is to set the depth to about twice what the project expects to raise. Then the drop is the same, about
33%, at any size (section B):

| Depth, as a multiple of the raise | Price drop if half is sold | How far the price rises over the raise |
|---|---|---|
| 1 | 52.1% | 3.58 times |
| 1.5 | 40.6% | 2.54 times |
| 2 | 33.1% | 2.09 times |
| 3 | 24.2% | 1.68 times |
| 4 | 19.0% | 1.50 times |
| 8 | 10.3% | 1.24 times |

Three things follow:

- **A deeper curve is calmer and duller.** At depth 2 the price rises about 2.1 times over the raise; at 8, 1.24 times.
  Stability costs excitement, which is the right trade in a quiet market.
- **A fixed depth is too deep for small raises and too shallow for large ones.** A 3,000 raise moves the price only 1.22
  times at 25,000, which looks dead. At a depth of 6,000 (twice the raise) it moves 2.09 times and a half-sale drops it
  33%.
- **The founder cannot know the raise in advance.** If the raise comes in at three times what was expected, the drop at
  "depth 2" returns to 64%. A menu of depths (5,000 up to 500,000) with a plain "how much do you hope to raise?" question
  narrows this; it does not remove it.

### Why the leave change matters

*Note, 2026-11-15, later the same day: the leave change is built (see [BACKING-POOL.md](BACKING-POOL.md), "Why leaving has a
fee"). "Today" in this section means the old exit that sold the units. The built fee is 1% of what the units that carry
held money are worth, capped at the leaver's own part of the next tranche, so leaving never costs more than staying and
always returns most of the held money. The deployer is now 23,548 of 24,576 bytes.*

Today, when a milestone is posted, a backer who does not want to fund it can leave and take their held money back. Leaving
also **sells all of that person's units** on the curve. So the milestone itself becomes the moment the price drops: the
people who leave dump their units together.

The change: leaving gives back the held money and the person **keeps their units**. Nothing is sold, so the milestone
cannot move the price (section C, 50,000 raised):

| Leave | Sell | Drop today, depth 25,000 | Drop with the change | Today, depth 100,000 | With the change |
|---|---|---|---|---|---|
| 20% | 10% | 57.5% | 28.0% | 22.2% | 8.3% |
| 30% | 10% | 65.9% | 28.0% | 28.0% | 8.3% |
| 30% | 0% | 57.5% | 0% | 22.2% | 0% |
| 50% | 0% | 72.0% | 0% | 33.1% | 0% |

("Leave 30%, sell 0%" today means 30% of units are sold, by the leavers alone. With the change nobody sold anything, so the
price does not move. The analysts' note quotes this case as 66%; the model gives 57.5%, and 65.9% is the 30% leave plus
10% sell row. I used the model's own rows.)

### Why you need both together, and what the pair costs

The model also lets half the holders panic at different levels of price drop (anywhere from 3% to 40%), with a first 3% of
units sold to start it (section E). At 50,000 raised:

| What changes | Final price drop | Share of holders who sold |
|---|---|---|
| Neither (today, depth 25,000) | 77.2% | 62% |
| The leave change only (depth 25,000) | 72.6% | 51% |
| Depth 100,000 only (leave sells as today) | 37.2% | 59% |
| Both | **2.6%** | **3%** |

On a shallow curve the 3% who start the slide are enough to tip everyone else, even when leavers sell nothing. On a deep
curve with leavers who sell, 37 to 42% falls anyway. Only the pair stops the slide, and the same holds at 100,000 and
250,000 raised when the depth is twice the raise.

The catch with the leave change: **it makes leaving nearly free.** Staying costs a backer 2.48% of their position at the
first milestone, 1.86% at the second and 1.39% at the third, about 9.7% over a year of 13 milestones. If leaving costs
nothing and the person keeps their units, anyone who is only trading would leave at every milestone, and the only money
that reaches the project is the fee. The remedy is a price on leaving. A notional 1% fee, taken from the money handed back
and never more than that money, roughly matches today's cost but does not stop most holders from leaving each time. A
larger fee funds more and holds back more. That is a decision for you if the pool ever turns on (decision 11).

### Two ideas the model says are not worth it

- **A fee that falls as units age** (extra 7% in the first day, then falling to nothing by day 14). A same-day flipper gets
  back 82.0% of what they put in instead of 88.2%, and a sandwich trade of 5,000 loses 627 instead of 294. But in a run by
  people who have held a while it moves the final drop by under half a point. It is a tool against flipping, not against
  runs. It also does not fit in the contract today (below).
- **A surcharge on net sales in the last day.** With the best settings tried it improves the final price by 1.9 points after
  a 30% run, and it widens the gap between the first seller and the tenth (the first keeps 95.6% of their value, the tenth
  47.9%, against 55.3% with no surcharge). It rewards being first to sell. Recommend not building it.

### The contract has little spare size

The deployer of the pool is 23,588 bytes of a 24,576 limit, which is 988 spare. The leave change saves about 0.4 KB; the
age-based fee adds 1.2 to 1.8 KB and will not fit unless something moves out first. The launch also uses 14.8 million of a
16.8 million gas cap on some networks, so adding a depth choice has to be measured. This is one more reason this is a
decision for later rather than a quick edit now.

### A line to show backers, if the pool is on

If a founder opens a pool with 300 raised, they and their backers should be told in plain words that this gives the project
about 3 at once and about 7 around day 42, and that an ordinary sale leaves the held money behind (a quick buy and sell
returns about 88%). The legal lines stay exactly as they are, and this goes beside them, not in place of them.

## 4. Recommended order

1. **Now, no money, no chain.** Say "free to start, no token needed" (the screen copy belongs to another batch). Fill in the
   cost table above from your invoices. Run Pilot A. Tell nobody about income yet.
2. **Sponsors by hand.** List two or three sponsors for one theme. Each pays the helper directly; the payout link goes on
   the record. Creaton takes no fee on the first season. Counsel reads the wording first. This tests whether money wants in,
   at no build and no custody.
3. **A paid hosted tier,** only after Pilot A shows which of the AI drafts and agent seats founders use. Keep the record public
   by default; sell convenience, not privacy for the record.
4. **Pay when accepted, as a recorded transfer (6a),** once a chain exists and tasks are being accepted in the pilot.
5. **Monthly supporter pledges (5),** as a signed record with a reminder, after counsel reads the words.
6. **A fee on funded work (A)** only here, on steps 4 and 5, 3% to start, visible and separate.
7. **"Fund this task" (6b),** only with the bounty contracts unfrozen, audited and counsel's yes. Not before the pilots.
8. **The pool and its changes (2, 3 and section 3),** only if you ever turn investing on. Then the leave change and the
   depth menu go together, or not at all.

## 5. Not now, and why

From the plan for this push. Each is real work worth doing later; each is held back for the reason given.

| Item | Why not now |
|---|---|
| Contract changes from the run model (leave keeps units, depth tiers, age-based fee, contract size, test rewrites, rewriting BACKING-POOL.md) | DIRECTION says nothing changes a contract and lists new contracts as not now. Investing is off by default. The numbers are on file in section 3 and are revisited only if you turn the pool on |
| Fixed-price "Fund this task" bounties, monthly supporter pledges, a seed-grant pot, "Pay when accepted" transfers as built features | Each moves money, needs counsel and an audit, and the hosted build has no money path. They are described here only |
| A per-account weekly limit on sponsored fees | The hosted image has no chain. Revisit when a network with real money is planned; the allowance is decision 7 |
| Backing screens: the cushion meter, the tier picker in Start, the "If this stays small" box, the leave-window countdown | Each shows pool or return facts on a project page, or matters only when investing is on. Price and returns belong only in Home, and the legal lines stay whole |
| Hiding Shares, budget and cap fields behind "Advanced" on the older contributor Start | Quick Start already asks only for a goal. Leave those defaults alone in this push |
| A one-line "ship note" that counts toward Moving now | It would blur DIRECTION's one number (the second and third weekly update). Revisit if the pilot shows founders want a lighter post |
| Agent profile skill tags and matching | Self-declared and low value before an agent actually joins. Revisit after the first agent-run project |
| Email or browser push reminders | Needs contact details, a provider and a privacy-note change counsel must read. The calendar file and the daily owner list cover Pilot A |
| A per-project generated preview image and its dependency | Ship plain share tags first |

## 6. Decisions for you

Each one has my recommendation. None is made.

1. **Who pays Creaton's costs until income exists?** Recommendation: you, up to a monthly ceiling you set after filling in
   the cost table, reviewed when Pilot A ends. Do not promise income to anyone.
2. **Is "free to start, no token needed" the headline?** Recommendation: yes. It is true today and costs nothing.
3. **Charge a fee on funded work, and how much?** Recommendation: charge nothing until a money step exists. When one does,
   3%, as a separate visible transfer, after counsel. Revisit the rate after 20 funded projects.
4. **Write down "no fee on trades, ever"?** Recommendation: yes. A fee that depends on trading volume is the one most
   likely to vanish in a quiet market and the one that most invites exchange questions.
5. **A paid hosted tier?** Recommendation: decide after Pilot A. If yes, 20 to 30 a month for agent seats and AI drafting.
   Keep a project's record public by default. Do not sell privacy for the record.
6. **Sponsored seasons?** Recommendation: yes, one season by hand with two or three sponsors. Sponsor pays helpers directly.
   No Creaton fee on the first season, 5% after counsel has read it.
7. **The free allowance for sponsored fees, when a chain is used.** Recommendation: about 50 sponsored steps per account per
   week, shown on the account menu, set at the provider. Not needed while the hosted build has no chain.
8. **Unfreeze the bounty contracts for "Fund this task"?** Recommendation: no, not now. Reopen after Pilot A, an audit quote
   and counsel's view on fees. Start with "pay when accepted" as a recorded transfer.
9. **Build monthly supporter pledges?** Recommendation: not yet. Ask counsel first; build the signed record only once a
   pilot founder asks for it.
10. **Build founder "Pay when accepted"?** Recommendation: yes, once a chain exists, as a recorded transfer with no contract.
    It is the smallest step that lets accepted work be paid.
11. **If investing is ever turned on: which changes ship?** Recommendation: the leave change and the depth menu together or
    not at all, with a price on leaving (start at the notional 1% fee and test), no age-based fee, no net-sales
    surcharge. Free up contract size first. Do not start any of it now.
12. **Which questions go to counsel first, and when?** Recommendation: one batch, after Pilot A, before any money step:
    the fee on funded work, sponsored seasons, supporter pledges and the paid tier's terms (the question list is in
    section 2). Start with sponsored seasons: they are the first thing in the order that touches money.

## What I did not check

- No hosting, backup or AI-service price is in the repository, so the cost table has no figures and the income-against-cost
  comparison is by scale only.
- The income numbers (3 to 5%, 20 to 30 a month, 5 to 10% of a season, 300 a project, one project in ten paying) are
  proposals and assumptions, not measurements. Nothing has been sold yet.
- The run numbers come from a float model of the pool's rules, not from the deployed contract, which does not exist yet.
  The tables reproduce your own figures; the cascade needs assumptions about how people behave (half of holders panic at
  thresholds from 3% to 40%) that no pilot has measured.
- The first part of a pool's money arrives between about day 35 and day 42. The analysts' note says "about day 42"; I gave
  the window because the post, the 7-day leave window and the up to 7 days to release add up to that range.
