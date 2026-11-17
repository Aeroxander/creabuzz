# First-principles check of the next-version plan

Written 17 November 2026, branch `v4-governance-rework`. For the owner. Three designers wrote a product from scratch
without seeing `docs/NEXT-VERSION-PLAN.md`. This compares their answers with the plan and with what milestones 0 to 3
built. Plan and report claims were checked against the files; nothing was run.

One caution first: the three specs agree with each other a lot, but all three were given the same measured facts
(thin pools, founder self-bidding, floor drain). Their agreement is one argument made three times, not three proofs.

## 1. The verdict

1. **Partly.** The record side (start alone, weekly update, join link, passkeys, founder never holds the money) is what
   first principles would build.
2. The money side is not. All three specs put no market on a raise of 2,500 to 50,000 dollars; the plan puts an
   auction and a pool on every raise from 2,000 dollars up.
3. **Biggest disagreement: when a tradable market appears.** Plan: at the first raise. Specs: only after a project is
   large (a pool with roughly 40,000 to 50,000 dollars in it, 150 to 200 holders).
4. Second: the plan has two states of control (founder decides; holders may stop or replace). The owner asked for a
   slow path to a bigger and bigger DAO. The steps in between are missing.
5. Nothing built is wasted. The auction and pool become the last stage instead of the first.

## 2. The from-scratch product

**One sentence:** a solo AI builder starts a project in two minutes, ships in public every week inside a six-week
group of peers, takes small dollar backing that is released as they ship and can be taken back while unreleased, and
hands over control one step at a time as people and money arrive.

**Five screens:** Start. Project page (record, stage, Back). This week (the founder's ten minutes). Season (the
group, the board, demo day). My backing and ownership.

**Where the specs disagreed with each other:**
- Release time: 12 weeks (two specs) or 26 weeks (one).
- Leaving: free at any time (two) or 4 weeks' notice and a 5% fee (one).
- Money on day one: none (two) or up to 1,000 dollars (one).
- Votes: by head, by track record, or by dollars backed. All admit fake accounts beat it.
- One spec pays 10% of project income to Share holders. That contradicts the legal line the plan refuses to touch
  ("No dividends or revenue share, ever"), so I leave it out.

## 3. Topic by topic

| Topic | Blind specs | The plan | Verdict | What I would change |
|---|---|---|---|---|
| First users | Solo AI builders with a demo, small audience, a monthly model bill; first backers are each other | Not named. Sizes start at a 4,000 goal | Agree in spirit | Name them in section 1 |
| Starting and joining | Passkey, a few fields, share link, no money | Same; built (8 presses, 4 fields; join 4 and 1). No human phone test yet (`docs/v3-review/STATUS.md`) | Agree | Do the phone test now |
| Weekly record | Kept or missed, a link per claim, labelled "founder's word" or "seen by N" | Weekly update with check-in; a junk update keeps money flowing; outside confirmation only at milestone 8 | Agree, plan is late | Move the evidence label before any money |
| When a token appears | Never for most; a ledger entry until the last stage | At the first Give Shares; tradable at the first sale | Disagree | See section 4, item 3 |
| Auction and pool at small sizes | None. Fixed price, per-backer caps | 24-hour auction, pool from 2,000. Measured: a 100-dollar buy moves a Small pool 23.7%; a founder's second account can leave honest bidders 9% of their Shares | Disagree | No pool below a size bar |
| Floor and exit | The payer takes back their own unreleased money | Any holder hands back for a slice of the floor, 5% fee, over 365 days | Half agree | Keep the floor; it is the same right once there is no market to buy cheaply in |
| Backer protection | Refund, caps, no resale, pause after missed updates | Floor, 14-day check-in, bid rules, Stop vote (not built; milestone 7) | Half agree | Add per-backer caps in a fixed-price round |
| Solo to DAO | Five stages: Solo, Backed, Team (second signature, no self-checking), Council (budget, elected seats), Open. Raise caps force each step | Founder acts inside limits; Stop vote any time; replace who runs it after 365 days or 28 silent days | Disagree | Add the stages below |
| Accelerator | Open entry; a six to eight week group; peers must try or check each other's work; demo day; a matching pot; AI manager drafts | Optional Demo Day and boards at milestone 8. `MANAGEMENT-LAYER.md` has the manager and itself lists "peer cohort and deadline (the real YC value)" as not covered | Disagree on timing | Bring the group forward; it needs no contract |
| Agents | May work; may not confirm, promise or set goals | Drops the bans on goals and promises | Disagree | Keep the bans until the test |
| Platform income | 45,000 to 70,000 a bear year; 5% fee, paid manager, 2% of each project; no platform token | About 50,000; 3% plus trade fees; CREATE as project zero | Agree on size | Defer CREATE; it is milestone 8 anyway |
| Web app | A new thin app of 8,000 to 15,000 lines | Delete from about 233,000 to about 70,000 | Open | Decide at milestone 5 |

**The stages the plan is missing.** The plan jumps from "founder alone" to "holders can replace the founder after a
year". Missing in between: (a) a second signature on large spending once a second person has joined; (b) an end to
self-checking at that point; (c) a small council that approves a budget once there are about 50 backers; (d) raise
caps tied to each step, so more money always means more shared control; (e) a public "eligible for the next stage
since" line, so stalling is visible. Also, in the plan's Stop vote all founder Shares may vote, so early on a founder
with 20% can block it alone.

**Where the specs are naive.**
- Shares that cannot move are what the plan reversed on purpose (the old lock, D77). The specs' version unlocks at a
  public bar and not by two votes, but it is still a lock, and it needs new contract code.
- "Take back your own stream" is harder than it sounds when backers arrive at different times. The built Treasury
  already does a pro-rata version, tested.
- A fixed price removes self-bidding but brings a queue: who gets in when a round fills in a minute.
- Hand-kept ledgers and card payments carry their own legal weight. A refund right does not make backing less of an
  investment.

**Where the plan is over-built.** Three attack-tested fix rounds on an auction for raises that, by its own numbers,
put 550 to 2,200 dollars in a pool, with zero users and no phone test.

## 4. Changes before milestone 4, ranked

1. **Run the two-week test first (section 6).** Reason: every disagreement above rests on untested guesses about
   people. Cost: two weeks, almost no code. Milestone 0 is kept and is the thing being tested.
2. **Start milestone 4 smaller.** Build now only what every version needs: the reader for Launcher, ShareToken and
   Treasury events, the signed "project numbers" record, settings from the server. Hold the auction and pool reading
   and the helper that finishes sales until the test reports. Cost: none; it saves two to four weeks if the answer
   goes against small markets (estimate). Milestones 2 and 3 kept.
3. **Add a plain backing round with no auction and no pool below a size bar.** Fixed price, per-backer cap, money into
   the existing Treasury split, where the floor is the unreleased money and handing back is the refund. Shares stay
   an ordinary token, so nothing built is reversed; the app does not open a market. The built auction and pool become
   the step for projects above the bar (first guess: the Large size). Cost: a new sale path in the Launcher, perhaps
   150 to 250 lines and its tests (estimate). The Launcher must be replaced anyway, because the reserve is sealed in
   it (milestone 3 finding). Milestone 2 kept; milestones 1 and 3 parked, not wasted. Build only if the test says so.
4. **Write the stage ladder into the plan.** On paper now (two days). Build the second signature first, the rest when
   a real project nears a trigger. Milestone 7's HolderVote becomes the last stage.
5. **Bring the six-week group and the evidence label forward** from milestone 8. Server and web only.

**Should milestone 4 start now?** Start smaller, in parallel with the test. Do not start the four to six week version.

## 5. What should not change

- **Start alone, nothing on chain until needed, join link, open sign-up.** All three specs chose the same.
- **Share token, Treasury and Vester.** The floor with a check-in is the specs' "released as you ship, refundable"
  idea, already tested under random use.
- **The founder never holds the money**, and the three-step finish any stranger may run.
- **The auction-to-pool route.** The specs' own pool for big projects opens at a fixed price and, as one admits, has
  had no attack test. The built one has. Keep it for the last stage.
- **No vote needed for routine acts.** The specs agree: before a council exists, leaving is the vote.

## 6. The two-week test with 10 real founders

**Do.** Recruit 10 solo AI builders by hand. Each signs up with a passkey on their own phone, starts a project on the
built flow, makes one promise, shares the link. Put them in groups of three who must try each other's demos. Open
backing in week 1 as pledges or small real stablecoin (at most 100 dollars a person), recorded by hand, unreleased
part returned on request. Tell every backer plainly: this cannot be sold. Show all ten founders the stage ladder and
both money designs. Nothing unaudited is used.

**Measure.** Sign-up failures. Second updates posted unprompted. Backers the founder did not already know. Each
backer's first question. Why people who looked did not back. Which stage founders would refuse.

**Read the result.** Ten founders is a signal, not proof.
- **Change course** (item 3, market only above a bar): 20 or more stranger backers across at least 5 projects, and
  fewer than half ask first how to sell.
- **Go ahead with the plan as written:** fewer than 10 stranger backers, and most who declined say "I cannot sell
  it", and most founders prefer the auction.
- **Stop money work:** more than 2 of 10 fail sign-up, or fewer than 5 post a second update. Then the record loop is
  the problem and no money design fixes it.

## 7. Decisions for the owner

1. **Run the test before the auction and pool half of milestone 4?** Recommended: yes.
2. **A market only above a size bar, with a plain backing round below it?** Recommended: yes if the test says
   "change course"; otherwise keep the plan.
3. **Adopt the five stages (Solo, Backed, Team, Council, Open) with raise caps?** Recommended: yes on paper now;
   build each stage when a real project needs it.
4. **Web app: new thin app or delete down?** Recommended: decide at milestone 5; lean to a thin new app that reuses
   the passkey and sending code (judgement, not measured).
