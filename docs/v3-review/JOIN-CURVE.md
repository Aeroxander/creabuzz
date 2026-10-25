# Raise with the auction, then a funding curve (proposal, 2026-10-25)

Status: **a proposal for you to decide on. Nothing here is accepted, built or deployed.** It changes no decision in
[DECISIONS.md](DECISIONS.md) until you accept it, and then it would need its own decision rows, contract work and audit
scope. An outside review on 2026-10-25 recommended it as the direction for a **feasibility specification**, not for
production as it stood; this revision answers that review (see [What the review changed](#what-the-review-changed)).
Its blocking point, which assets leaving pays out, **you decided on 2026-10-25: option A, one claimable asset (D112).**
The proposal as a whole is still not accepted.

## In one paragraph

A new fundraising project raises with the auction (CCA) as today: the price clears block by block while Shares are
released gradually, earlier blocks usually clear lower, and the raise sells out or refunds (D74). Once the auction has
succeeded and its money has reached the DAO, a **funding curve** opens: anyone can buy Shares from an allocation
declared at launch, at a price that rises as that allocation sells and never below what a Share pays when leaving, and
every payment goes straight into the DAO's treasury. There is no market and no pool: Shares stay non-transferable
(D77), and the only way out is leaving with your part of the treasury, which cannot be switched off (D73). It takes
what is good about pump.fun (instant buys, a price anyone can compute, a progress bar, small amounts) and keeps what
Creaton promises (money funds the project, leaving is an honest floor, team Shares stay locked to milestones).

In the app the paid action is **Fund this project** (buying Shares), kept visibly separate from joining the community
and from doing contributor work, which cost nothing. "Join curve" is only this document's name for the contract.

## Where this fits

What is decided today:

- **D77:** the first raises have no market. Shares cannot be transferred; leaving is the way out.
- **D12 and D14** (both on hold): when a project does want a market, it opens by a DAO vote (D14), on LBAMM with
  Shares as an apptoken (D12).

So today a raise ends at the auction. This proposal adds one step after it, and leaves the market question where D14
put it: a later vote. It is not "auction, then curve, then pool": a pool is itself a curve, and pump.fun needs a
separate curve stage only because a new token starts with no money and no price. After an auction there are both.

**Scope of a first version:** only new fundraising DAOs that declare the funding allocation before their auction. No
retrofit to existing projects (their contracts cannot be changed), and no sale added to a contributor project (its
Shares are earned through reviewed work; buying them would buy votes).

## Why leaving, not selling back into the curve

The real choice is where buyers' money lives. Selling back into a curve needs a reserve held by the curve, so that
sellers can be paid; leaving pays from the treasury. A dollar cannot be in both, so this is a choice, not an add-on.

**Selling back into a curve:**

- The project gets only the fee. On pump.fun nearly all the money ends up in the reserve and then the pool.
- Each sale lowers the price for the next, so a loss of confidence becomes a race: the first out gets the top price,
  the last gets the bottom, and those who stay lose value.
- Sales can be front-run.
- What you get depends on timing and on everyone else, not on what the project holds.

**Leaving by ragequit:**

- All the money people pay goes to the treasury and funds work, by vote.
- Leaving is neutral for those who stay: you take exactly your part, so the treasury per remaining Share is unchanged.
  The first and the last to leave get the same per Share if nothing is spent in between.
- There is no price to crash and nothing to front-run.
- What leaving pays is the treasury divided by the Shares that count, readable on chain by anyone.
- No secondary market, so a simpler legal picture (not a substitute for a legal review of selling Shares).

It does not stop people leaving all at once. A mass exit drains the treasury, not the value of those who stay; that is
the accountability: a team that loses its backers loses its runway.

**What it gives up, said openly:**

- No upside above the treasury's value without a market, which stays a later DAO vote (D14).
- Buyers pay at least what leaving pays, usually more (in the example: $0.15 a Share, leaving pays about $0.094), so
  the page shows both numbers side by side. Leaving is your current part of the treasury, not a promise to get back
  what you paid.
- Leaving before a voted payment runs, or before a milestone unlocks, pays more than leaving after. That is by design
  and on a schedule the page shows, not a race between sellers.
- The gain existing holders see as others buy is funded by those later purchases, not earned by the project's work.
  The page says so.

## How it works

1. **At launch** the kit sets aside the funding allocation (say 15% of all Shares) and gives it to a new `JoinCurve`
   contract made for this DAO, bound once at birth. These are launch-time Shares, like the auction's: nothing is
   minted later. A DAO without a curve records that explicitly, so no address can be added later.
2. **It opens only after a successful auction has handed over.** All of these must hold, checked by the contract:
   - its bound auction has reached its claim block **and graduated** (sold out);
   - the graduation executor has run the handoff for that auction to **this** DAO;
   - the auction's final clearing price and currency can be read.
   Anyone can run the handoff today (`executeGraduation` is open to all); the curve does not depend on a keeper. A
   failed auction never opens the curve: its allocation is retired (step 6).
3. **Buying:** a person names how many Shares they want, the most they will pay, and a deadline. The contract prices
   the whole order (see [Pricing](#pricing)), takes exactly that in the sale's currency, sends it to the DAO's treasury
   and the Shares to the buyer in the same transaction.
4. **Leaving** is unchanged: anyone can give up Shares for their part of the treasury. Unsold funding Shares count
   neither in votes nor in what leaving pays, so they dilute no one until they are sold.
5. **The window is finite**, declared at launch (for example 90 days). A perpetual curve is possible but makes the
   asset question below harder to live with.
6. **After the window, or after a failed auction,** anyone can retire what was never sold: the curve burns its own
   never-sold allocation, and nothing else. Retired Shares never collect any treasury, and no one's held Shares can be
   burned this way.

## Pricing

Let `p(s)` be the scheduled price after `s` funding Shares are sold (linear from the auction's final price to twice it
over the allocation, as a starting model, not a proven preset). Let `B` be the DAO's balance of the sale's currency and
`E` the Shares that count when leaving, both read **before** the payment. Each Share in an order costs the larger of
the schedule at that point and `B / E`:

`cost(s, x) = ∫ from s to s+x of max(p(t), B/E) dt`

Why this rule and not "the larger of the whole order's schedule cost and `x · B/E`":

- **Splitting an order changes nothing.** While the floor applies, a buyer pays exactly `B/E` per Share, so `B/E` is the
  same after their order; once the schedule is above the floor it stays above it (a purchase above `B/E` moves `B/E`
  toward the price paid but never past it, and the schedule only rises with sales). So one order, two halves or fifteen small ones cost the same. Checked:
  1,500 Shares after 119,250 sold, with leaving at $0.18, cost **$270.1875** whether bought at once, in two orders or in
  fifteen. The whole-order rule charged $270.00 at once but $270.1875 in two halves: the price depended on batching.
- **Joining and leaving at once never takes from members** in the sale's currency: each Share paid at least what it
  takes out.
- **Rounding** is up for what the buyer pays and down for Shares out, in base units, with exact balance checks
  (`mulDiv`), so many tiny orders cannot gain.
- **No Shares that count (`E = 0`):** buying is refused. Any restart would be its own decision.
- **The quote is not monotonic.** The schedule rises with sales, but the floor follows the treasury: after spending or
  a team unlock it can fall, and the quote with it. The app shows the quote, not "the price only goes up".

## The asset question (decided: option A, D112)

The floor above counts only the sale's currency. Leaving today pays a share of **every** asset the leaver lists, ETH
and any token included (`MolochPatched.sol`, `ragequit`). So if the DAO holds anything else, a buyer pays the floor in
USDC and leaves with USDC **plus** a share of the rest, taken from existing holders. Example: 1,000 Shares, 1,000 USDC
and 1 ETH; 10 Shares cost 10 USDC and can leave with 10 USDC and about 0.0099 ETH. A wait before leaving changes the
timing, not the price; refusing sales while "other assets" are present cannot work in general (a token balance cannot
be listed, and a dust transfer would stop sales). Three options:

| | What it means | Cost |
|---|---|---|
| **A. One claimable asset** (**chosen**, D112) | For DAOs with a funding curve, leaving pays only the sale's currency, enforced by `ragequit`. Anything else the DAO receives (ETH, other tokens) becomes claimable only once the DAO converts it by vote. | A `ragequit` check against a list fixed at birth. It narrows what leaving pays, though leaving stays always on (D73): a decision of its own. |
| B. Proportional basket | A closed list of claimable assets fixed at birth (say USDC and ETH); a buyer pays their proportional part of **each** in kind, plus the schedule's premium in USDC. No price feed needed. | Buyers must hold every listed asset; more contract and screen complexity. |
| C. Keep the curve off | No funding curve until A or B is accepted. | None; the feature waits. |

A promise to "hold only USDC" in practice is not a contract guarantee, so it is not an option.

**What option A means in practice** (your choice, 2026-10-25):

- In a DAO born with a funding curve, `ragequit` pays only the sale's currency, fixed at birth; asking for any other
  asset is refused. DAOs born without a curve keep today's rule (every asset the leaver lists).
- Leaving stays always on (D73); what changes is what it pays.
- Anything else the DAO receives (ETH, another token, a grant paid in something else) is for the members who stay
  until a vote converts it into the sale's currency. Converting needs a swap the DAO can call by proposal; where none
  exists on that network, the asset stays unclaimable, and the page says so.
- So the floor is exact: each Share bought pays at least its part of everything leaving can pay out.
- Shown on the project page and before leaving: "Leaving pays your part of the project's USDC. Anything else the project
  holds is paid out only after the members vote to convert it."

## A worked example

One million Shares: **600,000** in the auction, **150,000** for the curve, **250,000** for the team, locked behind
milestones. Prices are in USDC. The schedule rises evenly from **$0.10** (the auction's final price) to **$0.20** at
sell-out. Auction buyers paid **$0.09** on average (earlier blocks clear lower). The treasury holds only USDC.

| Moment | Money in from the curve | Treasury | Shares that count when leaving | Leaving pays per Share | Quote now |
|---|---|---|---|---|---|
| Auction hands over | — | $54,000 | 600,000 | **$0.0900** | $0.10 |
| Half the curve sold (75,000) | $9,375 | $63,375 | 675,000 | **$0.0939** | $0.15 |
| All 150,000 sold | $22,500 | $76,500 | 750,000 | **$0.1020** | sold out |
| Then a milestone unlocks 50,000 team Shares (D72) | — | $76,500 | 800,000 | $0.0956 | — |
| Or, instead, the DAO spends $30,000 on work | — | $46,500 | 750,000 | $0.0620 | — |

Who gains and who pays:

- **Auction buyers** gain as others buy: 10,000 Shares that cost $900 can leave with **$1,020** once the curve sells
  out (+13%). That gain is paid by later buyers, not earned by the project.
- **Early curve buyers** pay a little above what their Shares can leave with: 10,000 Shares at the start cost
  **$1,033**; they can leave with $939 at the halfway point and **$1,020** at sell-out. You buy to take part and to vote.
- **Spending is visible.** Money spent on work is no longer in the treasury, so leaving pays less. The page says so.

### What the floor guarantees, and what it does not

Say the project receives **$60,000** (revenue, a grant) when half the curve is sold. Leaving now pays **$0.1828** a
Share but the schedule asks only **$0.15**. Without the floor, someone buys 47,000 Shares for **$7,786** and leaves at
once with **$8,538**: **$752** taken from the members. With the floor they pay $0.1828 a Share and gain nothing.

The precise promise: **in the supported asset, with nothing else changing, buying and immediately leaving cannot take
value from existing holders.** It does not stop:

- **buying just before money is known to arrive.** 1,500 Shares bought at the start cost **$150.75**; if a $60,000 grant
  then lands, they can leave with about **$284.67**. Grants and revenue that can be ordered after a purchase are an
  ordering risk the page discloses;
- **buying before other buyers pay their premium**, which is how every holder gains from later purchases;
- **several wallets** acting as one, which the per-block limit slows but cannot identify.

Every order names the most it will pay and a deadline, so a quote that moved is refused, not charged.

## The rules that keep it honest

1. **It opens only after a successful handoff** (above), and starts at the auction's final price.
2. **Every payment goes to the treasury in the same transaction.** Payments are forwarded; anything else sent to the
   curve (USDC, ETH) is ignored by its accounting and never changes a price or an allocation.
3. **Each Share costs at least what it takes out when leaving**, in the supported asset (see Pricing and the asset
   question).
4. **A fixed allocation declared at launch.** No minting. The curve keeps its own counts: the starting allocation,
   Shares sold, Shares retired; what it may still sell is the first less the other two, never its raw balance.
5. **A one-way exemption.** Shares may move **from** the curve to a buyer (and to retirement), never **to** it from a
   holder, so nobody can add to its allocation or move its price by sending Shares.
6. **Limits** of, say, 1% of the allocation per order and per block. These slow one buyer; they do not prove distinct
   people, and the allocation cap is a limit on how much can be bought, not on control (see [Control](#control)).
7. **No owner.** No pause, no withdrawal, no setting changes after launch. The curve, its schedule and its place in
   every exclusion are fixed when the DAO is made.

## Control

The allocation cap limits the Shares that can be bought, not a buyer's share of the votes. It is a share of the
**starting** supply, and others can leave. A teamless launch with 800,000 Shares in the auction and 200,000 for the
curve: if auction holders leave until 100,000 remain, someone who buys all 200,000 holds two-thirds of the votes. And
a holder can steer decisions well below a majority when others do not vote. So:

- The page shows live ownership: what share of the votes the largest holders have, and each decision's voting bars.
- Proposals already open keep their electorate (it is fixed when a proposal opens); tests check later proposals after
  purchases and exits.
- If a hard ceiling on purchased control is a requirement, it needs a separate mechanism; it cannot be inferred from the
  allocation cap.

## The schedule: Shares sold, or Shares still held

| | **Shares sold** (recommended for a first version) | **Shares still held** |
|---|---|---|
| What sets the schedule | How many curve Shares have been sold | Curve Shares sold, less Shares that have left since the curve opened |
| After 75,000 sold, then 30,000 Shares leave | Still **$0.15** | Falls to **$0.13** |
| What the contract must know | Its own sales | How many Shares left by leaving, told apart from team forfeits (burns too) and from awards (mints) |
| Contract cost | Nothing beyond the curve | A counter of Shares burned by leaving, in contracts already near their size limits |
| Risk | The schedule can stall high if buying stops | Leaving and buying again to move the price (the floor makes it unprofitable, but it is more to prove) |

In our conversation I leaned to "Shares still held"; working through the contracts changed my mind for a first
version. If buying stalls in practice, a **VRGDA** (variable-rate gradual Dutch auction, Paradigm) fits better: the
price rises when Shares sell faster than a published schedule and drifts down when they sell slower, using only the
curve's own sales and the clock. Deferred until real data shows the need.

## No shorting on Shares (recommended)

- **Empty voting.** Shorting means borrowing Shares, and borrowed Shares carry votes, so someone can vote while betting
  against the project. It is a known attack on companies and DAOs, and the worst incentive in a product where Shares
  decide spending and awards. Banning only naked shorts does not help: covered shorts have the same problem.
- **Nothing to short.** Shares cannot be transferred (D77) and have no market price. Borrowing needs transfers and a
  lending market, which bring back everything leaving by ragequit avoids.
- **Leaving holds a team to account better than a short does.** A short profits from a decline but leaves the
  project's money where it is; leaving takes money away from a team that is not delivering (the MolochDAO idea).

If a market is ever voted in, shorting through a separate venue could be reconsidered only if Shares held as
collateral or lent out cannot vote. That is hard to enforce; see the open questions.

## Holding a project to account without a market

What shorting promises (a way for a skeptic to act on doubt) can come from tools that touch neither Shares nor votes:

- **Objections with a deposit (milestones: already built).** A holder who is not on the team posts a deposit and puts
  a milestone to a vote of holders; if the objection is upheld, they get their deposit back and half the team's bond
  ([milestone-challenge.md](../milestone-challenge.md)). It is a short aimed at one claim, with no borrowed votes. For
  work approvals the equivalent exists only partly: freezing or unwinding a submission and taking a reviewer's bond are
  DAO votes, and the bond goes to the DAO, with no reward for whoever raised it. A bounty there would be a new decision.
- **Milestone forecasts (proposal).** "Will milestone 2 be delivered by <date>?", settled by what the chain records.
  It brings skeptics' information in without touching Shares or votes. Start with reputation only, no money:
  real-money prediction markets are regulated in most places.
- **Visible exit signals (proposal).** The project page shows how many Shares left this month and how the treasury
  moved. Mass leaving is the verdict, made easy to read.

## What changes in the contracts

| Where | Change |
|---|---|
| `JoinCurve` (new, one per DAO) | Holds the allocation and its counts; checks the handoff before opening; `buy(shares, maxSpend, deadline)` with the pricing above; forwards each payment; `retire()` for never-sold Shares after the window or a failed auction; no owner. |
| `Shares` | **A one-way exemption** for the curve (out of it only), beside the auction's two-way one (D77). **One place that computes what counts when leaving**: every Share, less the DAO's own, less what the milestone lock holds (D72), less what the curve may still sell (from its counts, not its balance). The kit keeps the excluded holders apart (the curve can never be a team seat or another system address), and each subtraction is guarded. |
| `Moloch.ragequit` | Uses that total (today it subtracts the lock's `totalLocked` itself, D72), and in a DAO with a curve refuses any asset but the sale's currency, set once at birth (D112). Measure first: Moloch has room after D73/D76 removed seven functions. |
| Voting policy (`AllocationVoting`) | No code change: the curve joins the existing list of holders that do not count toward a vote's supply (the auction is already on it, D69). |
| `DaoLaunchKit` | The allocation, schedule, window and limits in its parameters; the curve's predicted address bound once (or an explicit "none"); the exemption, exclusions and read-backs. **Its creation code was 2,626 bytes under the limit at D69**: measure first; the curve may need its own factory. |
| App and command line | Fund this project screen and the project page (below); `buzz launchpad fund` with machine-readable results that work by direct calls without our server; the simulation (`scripts/simulate-raise.sh`) extended with buying and leaving. |

## What it changes in the decisions

| Decision | Effect |
|---|---|
| **D77** (no market, transfers locked) | Stays: no market, no pool, holders cannot send Shares to each other. **One addition:** the curve is a one-way exempt address, and the invariant becomes "while locked, Shares outside the DAO move only by collection from the auction, purchase from the curve, mint and burn". The 30 days' notice to lift the lock is unchanged. |
| **D76** (new Shares only for reviewed work, at most 10% a year) | No Shares are minted by buying, but this is a **fixed future sale declared at launch**, separate from the 10% award allowance, and selling the allocation changes everyone's share of the votes; the launch page states it. The yearly base must leave out what the curve may still sell. Correction to the earlier draft: the base is fixed when an award year starts, so purchases during a year do not raise that year's allowance. |
| **D72** (locked team Shares left out of the exit) | Extended: what the curve may still sell is left out too. |
| **D69** (the auction does not count toward a vote's supply) | Extended to the curve, through the same list. |
| **D75** (limits on the split) | **The auction itself keeps at least 60%**; the curve's allocation does not count toward it (it may never sell), and is at most 20%. Example preset: 60 / 15 / 25 (auction / curve / team). Lowering the auction's minimum would be a separate decision, not part of this. |
| **D73** (leaving cannot be switched off) | Leaving stays always on. In DAOs with a funding curve it pays only the sale's currency (D112, decided). |
| **D74, D43** | Unchanged: the auction still sells out or refunds, governance still opens at the claim block. |
| **D12, D14** (market venue, market by vote) | Unchanged and still on hold. If a project later opens a market, the curve and the market coexist; nobody buys from the curve above the market price. |

## What people see

Plain words, following the copy standard (no protocol terms in the main text):

- **Project page:** "Fund this project: $0.15 a Share now. Leaving pays $0.094 a Share today." A progress bar ("75,000
  of 150,000 Shares bought"), the window's end, the largest holders' share of the votes, and a list of purchases. A
  purchase shows a person's name only when their wallet is verifiably linked to their account; otherwise the short
  account.
- **Fund:** how many Shares, the total, the most you will pay, and the consequences in the actual numbers: "You pay
  $150 for 1,000 Shares. If you left right away you would get $94. Your money goes to the project's treasury; these
  Shares vote." No unconditional "less than you pay".
- **After buying:** what you hold, what leaving would pay, your average price, and your share of the votes.
- **Ordering risk:** "Money the project receives later can change what leaving pays, for everyone who holds Shares."
- **Window over or sold out:** "Funding is closed."

A read that fails says it could not be read and offers to try again; it never shows a quote that could then be charged
differently, or a zero.

## Tests that would decide it

- **Invariants:** starting allocation = sold + retired + still for sale; every purchase forwards exactly its price to
  the DAO and nothing else moves the curve's counts; each Share is paid at least what it takes out (supported asset);
  what counts when leaving = every Share less the DAO's own, the lock's and the curve's still for sale; no Shares minted
  by buying; excluded holders disjoint.
- **Pricing:** the same total for one order and any split of it (property test, including the floor/schedule
  crossover); rounding never favours the buyer; `E = 0` refused.
- **Activation:** before the claim block, after a failed auction, before the handoff, with a handoff to another DAO, or
  with an unreadable final price: buying refused; a failed auction's allocation retired, never sold.
- **Hostile cases:** buy then leave in the same block; buy just after money arrives; Shares sent to the curve refused;
  USDC or ETH sent to the curve ignored; a stale browser quote refused by the maximum; per-block limits; retirement that
  tries to touch held Shares refused; `ragequit` in a DAO with a curve refuses every asset but the sale's currency,
  and in a DAO without one still pays every listed asset.
- **Every guard falsified:** each test fails when its check is removed (Review-Proven Rule 3).
- **The simulation** with buying and leaving over many runs, in dollars per participant; then a public testnet run with
  real people before any public network.

## Trust (CROPS)

No reserve held by a third party and no liquidity pool to depend on; the curve still holds valuable Shares and changes
who governs and who can leave, so its source, ABI, factory and bindings are published and inspectable. Buying, leaving
and reading the evidence work by direct contract calls even if our server refuses someone. Purchases and holdings are
public. Stablecoin freezes and RPC providers remain outside risks; alternate RPC endpoints keep working. No later
choice by an administrator can change an exclusion, the schedule or custody, so nothing sold can be taken back that way.

## Open questions for you

1. ~~**The asset question.**~~ Decided 2026-10-25: option A, leaving pays only the sale's currency in DAOs with a
   funding curve (D112).
2. **The allocation.** 15% by default, at most 20%, with the auction keeping its own 60%?
3. **The window.** Finite (say 90 days, recommended) or perpetual?
4. **The schedule.** "Shares sold" with a 2x endpoint as a starting model, VRGDA later if needed?
5. **Retirement.** After the window, anyone can retire never-sold Shares (recommended), or the DAO votes it?
6. **Contributor projects.** Not in a first version (recommended): their Shares are earned through work, and buying them
   would buy votes. Revisit later?
7. **Legal.** Selling Shares continuously after the raise is a continuous offering, even without a market. A lawyer
   should read it before any public network.
8. **Shorting.** Recommended: no. If a market is ever voted in, would you consider shorting on a separate venue, and
   only if lent or pledged Shares cannot vote? (Hard to enforce; the default stays no.)
9. **The accountability tools.** A bounty for an upheld challenge to a work approval? Milestone forecasts? Exit signals
   on the project page? Each is a small decision of its own.

## What the review changed

An outside review (2026-10-25) judged the direction a better fit than an alternative launch format and recommended a
feasibility specification first. Its points and what this revision does:

| Review point | This revision |
|---|---|
| A USDC-only floor does not protect a treasury holding other assets (blocking) | [The asset question](#the-asset-question-decided-option-a-d112), decided: leaving pays only the sale's currency in these DAOs (D112) |
| The claim block alone is not a safe start | Opens only after a successful, handed-over auction; never after a failed one |
| The whole-order price depended on batching | [Pricing](#pricing) applies the floor Share by Share; checked equal for any split |
| A two-way exemption lets holders send Shares to the curve; counts and exclusions needed exact boundaries | One-way exemption, the curve's own counts, a binding fixed at birth, disjoint exclusions, retirement of never-sold Shares only |
| "Joining can never buy control" was wrong | [Control](#control), with the counterexample and live ownership on the page |
| "Sniping does not pay" was too strong | The precise guarantee, with the grant-ordering example |
| The join allocation should not count toward the auction's 60% | The auction keeps its own 60% |
| CCA does not charge everyone one price; the quote can fall | Wording corrected throughout |
| "Join" for a paid action | **Fund this project** in the app |

## If you accept it

1. Question 1 is decided (D112); decide the others, with decision rows for each, and an update to
   [TOKENOMICS-CONTRACT-CHANGES.md](TOKENOMICS-CONTRACT-CHANGES.md).
2. A feasibility specification: exact state, callers, rounding, asset policy and size measurements, reviewed before
   any contract code.
3. Contract proof on a local chain: `JoinCurve`, the `Shares` and `ragequit` changes, the kit. Unit, property,
   invariant and mutation tests, each failing before its check exists.
4. The simulation and the command line, then the app.
5. The audit scope ([AUDIT-SCOPE.md](AUDIT-SCOPE.md)) updated; an independent review of the composition; a public
   testnet run with real people before any public network.
