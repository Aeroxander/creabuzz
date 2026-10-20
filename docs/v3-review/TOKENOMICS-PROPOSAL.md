# Tokenomics for fundraising projects: a proposal (2026-10-21)

Status: **decided 2026-10-21**: you accepted T1 to T8 as written; they are D72 to D79 in [DECISIONS.md](DECISIONS.md), and
the contract changes are written up in [TOKENOMICS-CONTRACT-CHANGES.md](TOKENOMICS-CONTRACT-CHANGES.md). Nothing is built yet.
The text below is the proposal as you accepted it. A second review the same day corrected four things in it, marked where they
appear: the exit pays per Share, not per dollar (auction buyers pay different prices); the notice before a decision runs
is at least 3 days, not 3.5; the yearly cap is measured against the Shares that count on exit; two more ways to take
leaving away were closed; and the 30 days' notice before trading is now enforced by the contract, not only by the app. The write-up's §0a lists them. Each recommendation names the change it would need and what it does to the
audit scope ([AUDIT-SCOPE.md](AUDIT-SCOPE.md)).

It covers the six open questions about the raise: what a backer gets, limits on the split, dilution, trading after the
sale, the founder's control in contributor projects, and what needs a lawyer. The worked examples (a $50k film, a $250k
app, an open-source contributor project) are in §8, today's rules beside the proposed ones.

---

## The page to decide from

### What I found first: today's defaults are unfair to backers when a raise only meets its target

The launch form sets the sale's starting price so that the raise target is **15% of what the whole sale would bring in
at that price** (`SALE_PLANS["graduating-auction"].thresholdPercent = 15`, the default sale kind). The sale clears
at or above that price, so a raise that ends at its target has sold only about **15% of the Shares on sale**, and the
rest go to the DAO. The team's allocation does not shrink with it. With the standard split (20% sale, 20% team, 60% DAO):

| A raise that just meets its target, today's defaults | |
|---|---|
| Shares backers own | 3% of all Shares (15% of the 20% on sale) |
| Shares the team owns | 20% of all Shares |
| Shares the DAO holds itself | 77% (60% reserve plus the 17% that did not sell) |
| **Team's share of the votes** | **87%** (the DAO's own Shares do not vote) |
| **What $1,000 is worth if you leave on day one** | **$130** (leaving divides the treasury by every Share outside the DAO, locked team Shares included) |

Even a sale that sells out gives a backer only half their money back on day one, and the team half the votes. The
simulation never showed this because its bidders always bought nearly everything. None of this is a bug in a contract:
each contract does what it says. The trouble is the numbers they are given. It is the most important thing to settle
before the audit, because the fix touches the exit rule in the patched DAO.

### Decisions for you

| # | Question | Recommendation | Change | Audit scope |
|---|---|---|---|---|
| T1 | What does leaving pay? | **Team Shares still locked behind milestones are left out when the exit is worked out**, so a backer who leaves before any milestone takes their Shares' full proportional part of the money not yet spent (per Share, not per dollar: auction buyers pay different prices). The team's claim grows as each milestone unlocks. | Patched DAO `ragequit` (one more subtraction), a `totalLocked()` read on both milestone locks, the web exit preview | Changes one audited function a little; invariant 3 is rewritten |
| T2 | Can leaving be switched off? | **No. Remove the off switch** from DAOs made here. | Delete `setRagequittable` | Smaller |
| T3 | What does the sale have to sell? | **The sale sells out or refunds**: the target is the whole sale tranche at the starting price. A popular sale still clears higher and raises more. | App default (the existing "fixed price" line, 100%) and a kit check | One `require` in the kit |
| T4 | Limits on the split | **Sale at least 60% of all Shares, team at most 35%, DAO reserve at most 20% (default 0). All of the team's Shares behind 2 to 8 milestones, none worth more than half.** Defaults: 75 / 25 / 0. | Checks in `DaoLaunchKit` and the planner; new presets | A handful of `require`s in the kit |
| T5 | New Shares after the sale | **New Shares only as pay for reviewed work (an award), and at most 10% more Shares per year**, a number fixed at launch that can be set lower and never raised. Shares the DAO hands out of its own holding count the same as new ones. **Remove the DAO's built-in share sale**; a second raise is designed later. | A mint rule in `Shares` (and `Loot`), checked on every mint and every Share leaving the DAO; delete `setSale`/`buyShares`, and the unused permits and allowances | New rule in `Shares`, three DAO paths removed (frees the space T1 needs) |
| T6 | Trading after the sale | **No market for the first audited raises. Shares cannot be sent between wallets** (buyers can still collect theirs from the auction); leaving at your share of the treasury is the way out. A market opens later only by a vote that clears the bar in [CONTRIBUTOR-TOKEN-TRADING.md](CONTRIBUTOR-TOKEN-TRADING.md). | Lock transfers at launch; let the auction's claims through | Small rule in `Shares`; LBAMM and markets stay out of scope |
| T7 | Revenue for backers | **No automatic payouts. A team may pledge a share of its net receipts into the treasury**, written into the documents that say who holds the IP; that money raises every holder's exit value. | Launch form field and a "money that came in" card; no contract | None |
| T8 | Founder control in contributor projects | **The founder's starting Shares are at most a third of the first work budget, the founder is not on its review panel, and new Shares only come from reviewed awards** (T5's rule without the yearly cap). A rule that contributors must also agree to bigger changes comes later, once projects have contributors. | Two checks in `ContributorKit`; T5's mint rule | Two `require`s in an adjacent contract |

And what needs a lawyer before any of this goes live is in §7. In short: whether the Shares are securities where the
backers are (most likely yes, as designed), what registration exemption or licensed intermediary the raise would need,
a legal wrapper so holders are not personally liable for the DAO, the revenue pledge, tax on awards and exits, and
contributor agreements.

**What the proposal changes for a backer**, in the two raise examples of §8:

| | Today, raise just meets target | Proposed |
|---|---|---|
| $1,000 if you leave on day one (everyone paid the same average price) | $130 | $1,000 (less anything already spent) |
| The team's share of the votes on day one | 87% | 25% (film), 30% (app) |
| New Shares in two years | No limit; 77% of all Shares already sit in the DAO, handed out by one vote | Only for reviewed work; they can cut each Share's exit value by at most 9.1% a year (about 17% over two) |
| Who can switch off leaving | A vote | Nobody |
| Can Shares be sold to someone else | Yes, on any exchange anyone sets up | No, until a market is voted open under the bar |

**What I recommend not doing now**: a revenue share paid automatically to holders, buybacks, an exchange at the end of
the sale, a second raise, price-based unlocks, and team Shares that are free from day one. Each makes the audit larger and
the legal picture harder, and none is needed to run a first honest raise.

---

## 1. How a raise works today, in plain numbers

A fundraising project has one token, its **Shares**. Each Share is one vote on how the project's treasury is spent, and
a claim on part of the treasury when you leave. There are three groups of Shares when a project launches
([`daoLaunch.ts`](../../packages/creaton-core/src/launchpad/daoLaunch.ts), `planDaoLaunch`):

- **The sale**: sold to backers in the auction (Uniswap's continuous clearing auction). The money goes into the
  project's treasury, which the holders govern. Unsold Shares go to the DAO.
- **The team**: given to the founders at launch. They vote from the first block (D13). The part tied to milestones
  cannot be sold or taken out until each milestone stands (holders can object; D56).
- **The DAO reserve**: Shares the DAO holds itself. They do not vote and do not count when someone leaves (the D51
  patch). The DAO can hand them out by a vote.

The only rule on the split today is that the three add up to 100% and the sale is not zero. The standard split is
20 / 20 / 60 (`STANDARD_DAO_ALLOCATION`), with a billion Shares, 200 million on sale, and a starting price set from the
raise target as above (`floorFromRaiseTarget`). The milestones may lock any part of the team's Shares from none to all
(the default plan locks all of them, in three equal parts).

**Leaving** ("ragequit", in the code): a holder burns some of their free Shares and receives that fraction of the
treasury. The fraction is: your Shares, divided by every Share that exists except the ones the DAO holds
([`MolochPatched.sol`](../../contracts/src/majeur/MolochPatched.sol), `ragequit`). The team's locked Shares are in that
total even though they can never leave. Money the DAO already put into a work budget is not in the treasury, so it is
not part of anyone's exit: it is committed to the work.

**Votes**: a treasury decision (the "full vote") needs 20% of the voting Shares to take part and two thirds of those
voting for or against to agree, after a 48-hour review (the 12-hour hold runs inside it) and a one-day wait
(`AllocationVoting`): at least 3 days from opening to running. The team votes with all its Shares. Anything nobody votes
against passes once the team alone clears the turnout bar. What protects the backers is those 3 days in which they can
see a decision coming and leave.

Put together: **the exit is the backer's only real protection, and today the team's free allocation dilutes it**
(a backer who leaves on day one gets back half when the sale sells out, 13% when it only meets its target), **while the team's votes decide everything.**

---

## 2. Gap 1: what a backer gets

A backer gets two things today: a vote, and their share of what is left in the treasury when they leave. They get no
share of revenue. Two questions: should leaving be worth more, and should there be revenue?

### 2a. What leaving pays

**Options**

1. **Keep the rule, say it on the page.** The exit preview already shows the exact amount (D51). Cheapest, but the
   number is the problem: half (sold out) to 13% (at target) of the backer's money on day one, before anything is spent.
   A project would have to explain why a backer who leaves the next morning loses most of their money.
2. **Leave locked team Shares out of the exit total (recommended).** The total becomes: every Share except the DAO's own
   and the team's still-locked ones. On day one a backer can leave with their Shares' full part of the unspent money. Each time
   a milestone unlocks, those team Shares join the total and the team's claim grows, as it does in the votes. If backers
   leave before a milestone, they take their money with them, and the team's later Shares claim only what is left. This
   is the old Moloch idea (everyone who leaves takes their fair part) applied to Shares that were not paid for.
3. **Team Shares never claim the treasury at all**, only votes and later revenue. Fairest to backers, but the
   contracts cannot tell a team Share from a bought one once Shares move, and the team's unlocked Shares would be
   worth nothing to them except as votes. It needs a second kind of Share and more code. Not worth it now.

**Recommendation: option 2 (T1), together with T2** (leaving cannot be switched off). With transfers locked (T6),
leaving is the only way out, so it has to stay on. Today a vote can switch it off (`setRagequittable`), and the money
paths invariants even test that door. (A review found two more ways a vote could take leaving away, a lock guard
installed later and a burn of a holder's Shares; both are closed in the write-up, §2a.)

**What it needs**

- `MilestoneChallenge` and `MilestoneLock` each gain `totalLocked()` (the sum of `lockedOf` over the team, at most 16
  seats).
- The patched `ragequit` subtracts `totalLocked()` from the total when a lock is set (one call to the Shares' lock
  guard), alongside the D51 subtraction.
- `setRagequittable` is deleted from the patched DAO; every DAO made here is born with leaving on (the kit already
  passes `ragequittable = true`).
- The patched DAO is 1 byte under the size limit (24,575 of 24,576). Removing the unused share sale, permits and
  allowances (T5) frees far more than these changes need. Measure with `forge build --sizes` before deciding the order.
- The web exit preview (`ragequit-position.ts`) subtracts the same amount, so the screen still matches the chain.

**Audit scope**: `ragequit` was already the first item on the auditors' list; the change is a few lines in it and two
small views. Invariant 3 ("leaving pays exactly what the screen says") and `RagequitPreviewFfi` are rewritten for the
new total, and the mutation check gains "locked Shares counted again". Removing `setRagequittable` deletes a door the
invariant handler tries today.

### 2b. Revenue

Revenue a project earns usually reaches it off the chain: a film's licence fee, an app's subscriptions. The question is
whether any of it reaches the holders, and how.

Note first what already happens: **any money paid into the treasury raises the exit value of every Share.** So the
simplest revenue share is just the team paying revenue into the treasury. Nothing new is needed on the chain for that.

**Options**

1. **A revenue pledge into the treasury (recommended).** At launch the team may state "X% of net receipts paid into the
   treasury every quarter, for as long as the project earns". It is written into the signed documents the launch already
   links (who holds the IP, D38), shown on the sale page as the team's own statement, and every payment shows on the
   DAO's front page as money that came in. Holders who want the money leave with their part; those who stay keep it in
   the treasury to fund the next work. No new contract and no payout machine. What it cannot do: force a team to pay.
   That is a legal question (§7), and the page says so.
2. **Payouts voted by the holders.** A decision kind "pay every holder their share of $N", backed by a small
   distribution contract that records who held what at a block and lets each claim. It is a dividend in all but name:
   more contract code, more legal weight, and no benefit over leaving with your part except that you keep your Shares.
3. **An automatic, capped revenue share** (revenue-based financing): the treasury pays backers a share of revenue until
   they have received, say, 1.5 times what they paid, then it stops. The clearest promise to a backer, and the most
   obviously an investment. It also needs revenue to arrive on the chain on a schedule, which is the hard part.

The retired royalty design ([token-lifecycle-design.md](../token-lifecycle-design.md), retired by D18) went another way:
income only for holders who are also contributors, never transferable, so a buyer could not buy a yield. That is pay for
work, not a return on money, and it may come back one day for contributor projects. It does not answer what a backer
gets.

**"Without making it worse as a security."** Be clear about this: a Share that is bought with money, gives a claim on a
treasury and gains value from the team's work already has the features regulators look for. Adding revenue does not
change the category; it adds to the expectation of profit. What makes it **worse** is anything that looks like a return
promised by the team or paid automatically: scheduled payouts, buybacks, talk of price, a market the project promotes.
Option 1 keeps revenue inside the treasury, leaves every payout a holder's own decision to leave, and promises nothing on
the chain. That is the least, not a safe harbour. §7 lists the questions.

**Recommendation: option 1 (T7).** App only: a launch field (percent of net receipts, how often, until when, and in
which signed document), a card on the DAO's front page listing money that came in, and copy that says "the team's
pledge, not enforced by the contracts". **Audit scope: none.**

---

## 3. Gap 2: limits on the split

Today any split that adds to 100% is allowed, a team's milestones can lock none of its Shares, and the default sale
needs only 15% of its tranche sold to succeed. Three ways a launch can be unfair to backers without anyone noticing:

- **A large team share.** 50% team and 50% sale means backers own half the votes and, today, half the exit.
- **Team Shares outside the milestones.** Whatever the milestones leave out is free on day one. A team member with free
  Shares can leave on the day the raise lands and take their part of the backers' money: with today's at-target numbers
  and nothing locked, that is 87% of it. The default plan locks everything, but the planner and the kit allow none.
- **A sale that barely sells.** As above: at the target, 15% of the tranche is sold.

**Options**

1. **Limits in the app only.** The form refuses or warns outside the limits. No audit change, but anyone launching from
   the command line or another front end can still pick any numbers, and the sale page would have to judge each launch.
2. **Limits in the launch kit (recommended).** The same limits, but the kit refuses a launch outside them. Every project
   launched with this kit then has terms a backer can rely on without reading each one closely.
3. **Fixed templates only.** Three or four preset splits, nothing else. Easiest to compare, but a film and an app
   need different teams and timelines, and the presets would still have to be enforced somewhere.

**Recommendation: option 2 with presets in the form (T3, T4).** The limits:

| Limit | Value | Why |
|---|---|---|
| The sale sells out or refunds | target = the whole tranche at the starting price | So the split a backer reads is the split that exists. A sale that draws more demand clears higher and raises more; one that draws less refunds everyone. The existing "fixed price" line (100%) already does this; it becomes the default for DAO launches. |
| Sale | at least 60% of all Shares | Backers hold most of the votes on day one. |
| Team | at most 35% of all Shares | With T1 the team's Shares do not dilute the exit until milestones; this keeps their votes below backers' even after every unlock. |
| DAO reserve | at most 20%, default 0 | With T5 a reserve is the same as Shares not yet created, so it is simpler to have none. A project that wants one (for a later market, say) can keep a little; whatever it hands out counts against the yearly limit. |
| Team Shares behind milestones | all of them | Free team Shares are a direct claim on the raise. Pay for the team's time comes from work budgets, which holders vote and reviewers check. |
| Milestones | 2 to 8, none above 50% of the team's Shares | One milestone holding everything has nothing ahead of it to burn after a late objection (D58). |

Presets: **Standard** 75 / 25 / 0 with three milestones (the form's default), **Small team** 80 / 20 / 0, **Large
team** 65 / 35 / 0. All three use the same limits.

A note on fairness to founders: 25% of the Shares can sound low next to a startup, where founders keep most of the
company. The difference is that here the backers' money is not handed to the founders: it sits in a treasury the
backers can leave with, and the team is paid from it for its work, through budgets. The team's Shares are its share of
whatever the project builds up beyond that (revenue, IP, a later market), and its votes.

**What it needs**: in `DaoLaunchKit`, checks that the launch's numbers are inside the limits (shares of the total, the
milestones adding to exactly 100%, each at most 50%, between 2 and 8) and that the raise target is at least the floor
price times the sale tranche. The same checks in `planDaoLaunch` so the form says what is wrong before a wallet prompt;
the form's default sale kind for an own-DAO launch becomes the 100% line; the new presets in `allocation.ts` and
`raise-presets.ts`. The CCA's own rules decide how "sells out" plays out block by block; an auditor should confirm that a
graduated sale with a 100% line leaves at most dust unsold, and the simulation should add a sale that only just
graduates.

**Audit scope**: a handful of `require`s in the kit, each with a test that fails without it. Nothing else.

---

## 4. Gap 3: dilution

Today new Shares can come from four places, all decided by a full vote with no limit on the size:

- an award for reviewed work (`awardContribution`, which mints), the normal one;
- any direct mint the DAO votes (`shares.mintFromMoloch` as a decision);
- the DAO's built-in share sale (`setSale`, `buyShares`), which the app never shows;
- the DAO handing out its own Shares, which do not count while it holds them and count in full once they leave.

The last one is the biggest: at a raise that just meets its target, 77% of all Shares sit in the DAO. One vote the team
can pass alone can hand them out, which cuts a backer's 3% to almost nothing.

**Options**

1. **A hard yearly limit on new Shares (recommended).** No more than 10% more Shares in any year after the claim block,
   counting every way a Share can appear (minted, or leaving the DAO's own holding). The number is fixed at launch:
   it can be set lower, never raised. Simple to state, easy to check, and a vote cannot get around it.
2. **A higher bar for any decision that creates Shares**: its own voting lane, say 75% agreement, 30% turnout and a
   7-day review. Flexible, but votes are exactly what the team controls when turnout is low, and a lane is easier to
   get around (two smaller decisions) than a number.
3. **First refusal for existing holders**: new Shares are offered to holders pro rata before anyone else, at no less
   than the exit value per Share. Protects backers' share of a later raise, but it needs a sale mechanism the DAO does
   not have yet, and it does nothing about Shares given for work.

**Recommendation: option 1, plus "only for reviewed work" (T5).**

- Every new Share in a project made here comes from an award for a reviewed claim. Hiring someone becomes a project in
  a work budget, like any other work. "Your Shares are only diluted by Shares paid for accepted work, and by at most 10%
  a year" is one sentence a backer can hold a project to.
- The DAO's built-in share sale goes, together with the permits and allowances nothing here uses (AUDIT-SCOPE.md §6,
  item 4, already suggested it). A second raise would be its own design later, with first refusal and a price no lower
  than the exit value per Share, so a new buyer never takes value from those who stayed.
- The yearly 10% is measured against the Shares that count when someone leaves, so new Shares can cut each Share's
  exit value by at most 9.1% a year (1 − 1/1.1), about 17% over two years; unlocks are separate and shown milestone by
  milestone. The page shows how much of this year's allowance is left.

**What it needs**

- In `Shares` (and `Loot`, whose units also count when someone leaves): a mint is accepted only while the DAO is inside
  `awardContribution` (a flag the DAO sets for that call), and is counted against the year's allowance; a transfer out
  of the DAO's own holding counts too, except to an auction or lock set at launch. Launch-time mints (team, sale,
  reserve) are before the claim block and do not count. `Shares` is its own contract with its own size budget; the flag
  is a few bytes in the DAO.
- In the patched DAO: delete `setSale`, `buyShares`, `setPermit`, `spendPermit`, `setAllowance`, `spendAllowance`.
  `OrgAllowance` has its own allowances and does not use these. The projects page's raw summon dialog mentions
  `buyShares` for later joins (`summon-composer.ts`); that path would go too, or stay only for DAOs not made by the kits.
- In the kit: the yearly percentage in the launch parameters, set into `Shares` during the DAO's initialization and
  read back.
- In the app: the remaining allowance on the DAO's front page and in the work-budget form (an award that would go over
  the limit fails, and the claim waits for the next year), and the planner's checks.

**Audit scope**: a new rule in `Shares` and `Loot` (in scope already) and a new invariant ("in any year after the claim
block, Shares created plus Shares the DAO handed out are at most the allowance"; "no mint outside an award"), each in
the mutation check. Six DAO functions are removed, which takes three vote-granted ways out of the treasury off the
auditors' list.

---

## 5. Gap 4: trading after the sale

Today the app offers no market after the sale (LBAMM is for evaluation only, D12, D14). But raise Shares can be sent
between wallets, so anyone can set up a pool for them on any exchange and the project cannot stop it (D12 explains why
on Uniswap). So there is no market *in the app*, but there can be one outside it, with nothing the project chose.

**Options**

1. **No market at first; leaving is the way out (recommended).** Lock transfers at launch, as contributor projects do
   (D66). Buyers still collect their Shares from the auction; leaving at your share of the treasury works as before,
   and with T1 and T2 it is a real, permanent floor. A market opens later only by a vote that clears the bar in
   CONTRIBUTOR-TOKEN-TRADING.md (an audited venue, a legal read, a track record, 30 days' notice).
2. **A market at the end of the sale**, seeded by the DAO from the raise and the reserve, on LBAMM (the plan of D12, D14)
   or on a standard Uniswap pool. Backers can sell for more than the exit value if the project is doing well, and prices
   show what people think of it. But the market contracts join the audit, the treasury's money in the pool loses value
   when the price moves (and to traders buying below the exit value and leaving), and an open secondary market for
   something that is probably a security is the largest legal step in this whole list.
3. **Holders matched with each other**: a board where a holder offers Shares and a buyer takes them at the offered price,
   through a small escrow contract. Some liquidity without a pool, but it is a new contract, still a secondary market,
   and thin markets like that mostly show wide gaps.

**Recommendation: option 1 (T6).** For a first audited raise, an honest floor that cannot be switched off is worth more
than a price that can fall below it. The cost is real: a backer whose project is doing well cannot sell for more than
the exit value, and a holder cannot move Shares to a new wallet of their own (passkey wallets recover the same account;
a move to a new address would need the DAO's help). Say both on the sale page.

**What it needs**: the kit sets the transfer lock during the DAO's initialization, as `ContributorKit` does, and names
the auction as the one wallet allowed to send Shares out (so buyers can collect them). `Shares` gains that one exempt
sender, set once. A later "open trading" decision is its own decision kind with the bar's checks and copy.

**Audit scope**: one rule in `Shares` and a kit line, plus an invariant ("while locked, Shares only move by collection
from the auction, minting and burning"). LBAMM, the market contracts and any pool stay out of scope, as now.

---

## 6. Gap 5: the founder's control in contributor projects

A contributor project (D65, D66) starts with the founder as its only holder. The founder chooses how many Shares they
start with, there is no limit, and every decision passes on the founder's votes until other people hold more than about
a third of the Shares. Every award goes through a vote the founder controls; the founder can also vote a new work
budget with reviewers of their choice, or mint Shares directly by a full vote. Contributors' Shares cannot be sold
(transfers are locked) and the treasury is usually empty, so what is at stake is not money but **the contributors' share
of the project, which the founder can dilute**, and who decides what happens to it.

**Options**

1. **Limit the founder's starting stake (recommended).** The founder's starting Shares are at most a third of the first
   work budget, so once that budget is awarded the founder holds at most a quarter (more if they earn awards themselves,
   which go through reviewers like anyone's). Control passes to contributors as work is done, which is the point of a
   contributor project. Two checks in the kit.
2. **Weight limits on the founder's votes**, for example no holder counts for more than 40% in any vote. It sounds
   direct, but it can be got around with awards to a second wallet, and while the founder is the only holder it changes
   nothing.
3. **Contributors must also agree** to decisions other than routine awards (new Share budgets, changing the reviewers,
   lifting the transfer lock): such a decision passes only if a majority of the non-founder Shares that vote also agree,
   the way milestone votes leave the team out. The strongest protection, but a new voting rule in `AllocationVoting`,
   and it matters only once contributors hold a real share.

**Recommendation: option 1, with T5's "only for reviewed work" rule, now (T8); option 3 written up later**, once
contributor projects have contributors, and before any contributor project may open a market.

- The founder's starting Shares are at most a third of the first budget's Shares (`founderShares * 3 <= shareBudget`).
- The founder is not on the first budget's review panel (a reviewer already cannot judge their own claim; this keeps
  the founder from judging everyone else's at the start).
- New Shares only from reviewed awards: no direct mints, even by a vote the founder carries. No yearly limit, because
  in a contributor project awards are how every Share comes to exist.
- The Contributions tab shows the founder's share over time and, while the founder alone can pass a vote, says so.

**What it needs**: two checks in `ContributorKit`, the same `Shares` mint rule as T5 set in its initialization (without
a yearly limit), and copy on the Start page and the Contributions tab. **Audit scope**: two `require`s in an adjacent
contract (it is outside the raise path, AUDIT-SCOPE.md §2) and the shared `Shares` rule.

---

## 7. Gap 6: what needs a lawyer

None of these can be settled by design. They should be answered for the places the first backers and founders are,
before the first real raise. Questions, not conclusions:

**The raise and the platform**

1. **Are the Shares securities** (in the US under the Howey test; in the EU, financial instruments under MiFID II, which
   would put them outside MiCA; in the UK and Switzerland, their equivalents)? Bought with money, a claim on a treasury,
   value from a team's work: most likely yes, and the proposal is written assuming so. Does T6 (no transfers, exit only)
   or T7 (no payouts) change that, or only the paperwork?
2. **Which exemption or route**: a crowdfunding route with a licensed intermediary (US Regulation Crowdfunding, the EU
   crowdfunding regulation), sales to qualified investors only, or no sales to some countries? Each sets caps, disclosures
   and checks of who the buyer is.
3. **Creaton's own role**: is running the launch pages and sale an intermediary's job (a funding portal, a broker, a
   crowdfunding service provider) that needs a licence? Does the open-source code, or "unaudited, testnet only", change
   that?
4. **Redeemable Shares**: a treasury that every holder can leave at their share of the money, governed by votes, may
   look like a collective investment fund. Is it one?

**The DAO**

5. **A legal wrapper** so holders are not jointly liable for what the DAO does (US courts have treated some DAOs as
   general partnerships). Which form fits a project's DAO (an association, a DAO-specific company form, a foundation),
   and who signs contracts for it?
6. **The IP**: the documents behind "who holds the IP" (D38): an assignment to the entity, its operating agreement, and
   how holders' votes bind the entity. For a film also the chain of title and errors-and-omissions insurance, which
   distributors require.

**Money in and out**

7. **The revenue pledge (T7)**: can it be written so it binds the team, who can enforce it, and does it change how the
   Shares are classified?
8. **Tax**: on leaving (a return of capital, or a gain?), on revenue paid into the treasury, and on the DAO itself.
9. **Sanctions and identity checks** on bidders, and what happens when the currency's issuer blocks a holder (the
   contracts already hold their money for them, D67, D68).

**Contributors**

10. **Awards for work**: income tax when Shares are awarded (at what value, with no market?), whether contributors are
    contractors or employees somewhere, and contributor terms that assign the work's IP.
11. **Opening a market** for a contributor project's or a raise's Shares: everything in item 1 again, for trading.

**Words**: the pages say "back", "leave with your share" and "team tokens unlock", never "invest" or "return". Have the
lawyer check the sale page, the agreement and the exit screen together.

---

## 8. Worked examples

Assumptions for all three: amounts in USDC; nothing happens that the table does not list; "$1,000 at exit" is what a
backer who paid $1,000 at the sale's average price would receive by leaving at that moment (the exit pays per Share,
so a buyer who paid more than the average per Share gets less, an earlier, cheaper buyer more). Spending is counted when the money
goes into a work budget, because from then on it is not in the treasury. Today's rules use the standard 20 / 20 / 60
split, a billion Shares, and a raise that meets its target exactly (15% of the tranche sold). The proposed rules use T1
to T6. The numbers come from a short script (the formula in §1); each row is one event.

### 8a. A $50,000 film raise

**Proposed terms**: 1,000,000 Shares. Sale 750,000 at $0.0667 (75%), team 250,000 (25%: director 150,000, producer
100,000), all locked behind three milestones (a teaser and the first ten minutes public, 33%; the festival cut screened,
33%; the film released at a public link, 34%). No reserve. New Shares at most 10% a year. A pledge of 50% of net receipts
into the treasury. A $1,000 backer holds 15,000 Shares.

**Today's terms, same raise**: 1,000,000,000 Shares; 200,000,000 on sale at $0.00167, of which 30,000,000 sell at the
target; the team holds 200,000,000; the DAO 770,000,000. A $1,000 backer holds 600,000 Shares.

| Month | What happens | Treasury | $1,000 at exit, proposed | $1,000 at exit, today | Team's votes, proposed / today |
|---|---|---|---|---|---|
| 0 | The raise lands | $50,000 | $1,000 | $130 | 25% / 87% |
| 1 | Holders vote the production budget: $38,000 and 20,000 Shares for the crew | $12,000 | $240 | $31 | 25% / 87% |
| 4 | Milestone 1 stands (82,500 team Shares unlock); 10,000 Shares awarded to crew | $12,000 | $214 | $30 | 25% / 83% |
| 8 | Milestone 2; the budget closes with $2,000 unspent; 10,000 more awarded | $14,000 | $225 | $34 | 25% / 80% |
| 10 | Festival fees paid by a vote, $4,000 | $10,000 | $160 | $24 | 25% / 80% |
| 14 | Milestone 3: the film is released | $10,000 | $147 | $24 | 25% / 80% |
| 18 | A streaming licence of $30,000; half paid in under the pledge | $25,000 | $368 | $60 | 25% / 80% |
| 24 | 10,000 Shares awarded to an editor for the festival tour | $25,000 | $364 | $58 | 24% / 77% |

**Dilution over two years.** Proposed: 30,000 new Shares (3%), all awarded for reviewed work; backers go from 75.0% of
all Shares to 72.8%. The most the rules would have allowed is 1,210,000 Shares in all, leaving backers 62%. Today: the
same crew awards, but nothing stops a vote from handing out the DAO's 770,000,000 Shares, and the team's votes alone
pass it.

**What the backer should read from it.** The exit is not "your money back": money spent on making the film is gone, and
that is the point of backing it. What the exit gives is protection against a team that does not spend well. Proposed,
a backer who paid the average price and loses confidence before the production budget passes can leave with all of
their $1,000. Today, the same
backer leaves with $130, and the team, with 87% of the votes, decides the budget.

### 8b. A $250,000 app raise

**Proposed terms**: 10,000,000 Shares. Sale 7,000,000 at $0.0357 (70%), team 3,000,000 (30%, three founders), all locked
behind three milestones (a public beta, 30%; the first paying customers, 30%; version 1.0, 40%). No reserve. New Shares
at most 10% a year. Net revenue paid into the treasury (the DAO's entity holds the app). A $1,000 backer holds 28,000
Shares.

**Today's terms, same raise**: 1,000,000,000 Shares, 30,000,000 sold at $0.00833, team 200,000,000, DAO 770,000,000.
A $1,000 backer holds 120,000 Shares. Awards scaled by the same percentages.

| Month | What happens | Treasury | $1,000 at exit, proposed | $1,000 at exit, today | Team's votes, proposed / today |
|---|---|---|---|---|---|
| 0 | The raise lands | $250,000 | $1,000 | $130 | 30% / 87% |
| 1 | Budget A: $100,000 and 300,000 Shares for six months of building | $150,000 | $600 | $78 | 30% / 87% |
| 5 | Beta milestone (900,000 team Shares unlock); 150,000 Shares awarded | $150,000 | $522 | $73 | 30% / 82% |
| 7 | Budget A closes ($10,000 back, 150,000 more awarded); budget B: $90,000, 300,000 Shares | $70,000 | $239 | $32 | 29% / 77% |
| 11 | Paying-customers milestone (900,000 unlock); 200,000 awarded | $70,000 | $211 | $30 | 29% / 71% |
| 13 | Budget B closes (100,000 more awarded); first revenue $2,500; budget C: $50,000, 250,000 Shares | $22,500 | $67 | $9 | 28% / 69% |
| 18 | Version 1.0 (1,200,000 unlock); a hire's first project awarded 400,000; 150,000 from C; revenue $12,500 | $35,000 | $88 | $12 | 27% / 58% |
| 24 | Revenue $15,000 more; the rest of C awarded (100,000) | $50,000 | $124 | $17 | 27% / 56% |

**Dilution over two years.** Proposed: 1,250,000 new Shares: 500,000 in the first year (5%) and 750,000 in the second
(7.1% of 10.5 million), both under the 10% limit. Backers go from 70.0% to 62.2%. The most the rules allow is 12,100,000
Shares, leaving backers 57.9%. Today the same awards leave backers holding 8.5% of the Shares outside the DAO, and there
is no limit.

**What the backer should read from it.** Proposed, the team's Shares join the exit only as the beta, the customers and
the release happen, and a backer who leaves before each step takes their full part of what is left. By month 13 most of
the raise has been spent on the work, which is what it was for; from then on revenue is what raises the exit value. A
team that wanted to pay itself the treasury instead would need backers not to vote against it, and everyone who noticed
in the 3 days could leave with their full part first.

### 8c. An open-source contributor project (no raise)

**Proposed terms**: the founder starts with 1,000,000 Shares; the first work budget holds 3,000,000 Shares (the most the
founder could start with is a third of it), at most 100,000 per claim, three reviewers who are not the founder, two of
whom must agree. Transfers locked. New Shares only from reviewed awards.

**Today's terms**: the same, except the founder could start with any number. The example uses 10,000,000, which nothing
stops.

| Month | What happens | Founder's share, proposed | Founder's share, today |
|---|---|---|---|
| 0 | The project starts; the first budget is open for claims | 100% | 100% |
| 6 | 1,100,000 Shares awarded to 9 people (100,000 of them to the founder, for reviewed claims) | 52% | 91% |
| 12 | 2,200,000 awarded in all (founder 200,000); a second budget of 3,000,000 Shares is voted | 38% | 84% |
| 15 | A foundation grants the project $40,000, paid into the treasury | 38% | 84% |
| 16–24 | $28,000 spent (a security audit, hosting); 2,500,000 more awarded (founder 300,000) | 26% | 71% |

At month 24 there are 5,700,000 Shares. The largest contributor holds 450,000 (7.9%) and could leave with $947 of the
$12,000 left in the treasury (today, with the founder's 10,000,000, $367). The founder decides alone until about month 6;
after month 12, a vote the contributors oppose needs a third of them voting against to fail. With option 3 of §6 later,
new Share budgets would also need a majority of contributors who vote.

---

## 9. What it all does to the audit

| Change | Contracts | Size | Tests to add | Net effect on scope |
|---|---|---|---|---|
| T1 locked Shares out of the exit | patched DAO `ragequit`; `MilestoneChallenge`, `MilestoneLock` (`totalLocked`) | a few dozen bytes in the DAO | invariant 3 and the ffi preview rewritten; mutation "locked Shares counted again" | same functions, small change |
| T2 leaving cannot be switched off | patched DAO (delete `setRagequittable`) | saves bytes | handler door removed; test that no call turns it off | smaller |
| T3 sells out or refunds | `DaoLaunchKit` (one check) | tiny | a launch with a lower line reverts; a just-graduating sale in the simulation | same |
| T4 split limits | `DaoLaunchKit` (checks) | small | one failing launch per limit | same |
| T5 new Shares only by award, at most 10% a year; built-in sale, permits and allowances removed | `Shares`, `Loot` (mint rule, allowance); patched DAO (flag in `awardContribution`, six functions deleted); kit (sets it) | the DAO shrinks, likely by more than a kilobyte (measure) | invariants "no mint outside an award" and "at most the allowance a year"; mutation entries | larger in `Shares`, smaller in the DAO |
| T6 transfers locked, the auction exempt | `Shares` (one exempt sender), kit | small | invariant "while locked, Shares move only by collection, mint and burn" | LBAMM and markets stay out |
| T7 revenue pledge | none (app) | — | web unit tests | none |
| T8 founder limits in contributor projects | `ContributorKit` (two checks), `Shares` rule | tiny | two failing launches | adjacent contract only |

The order I would build them in, if you accept them: T5's removals first (they free the space in the patched DAO), then
T1 and T2, then T5's mint rule, then the kit checks (T3, T4, T6, T8), then the app (planner, presets, exit preview,
allowance, pledge, copy). Each contract change gets its write-up and a test that fails without it, then the full suite,
the simulation and the mutation check again, then the freeze tag in AUDIT-SCOPE.md. The simulation should gain sales that
only just meet the target, many exits before the first milestone, and award years that hit the limit.

What I have not checked and would before building: the CCA's block-by-block behaviour on a sale that only just reaches
a 100% line (T3), and the patched DAO's size after the removals.

---

## 10. Plain words for the pages

| Say | Instead of |
|---|---|
| Your share of what is left in the treasury, whenever you want to leave | Ragequit, NAV, redemption |
| The team's Shares count toward leaving only once their milestone stands | Vesting |
| At most 10% more Shares a year, and only for accepted work | Inflation cap, dilution |
| Nothing is for sale after the auction; you can always leave with your share | Illiquid |
| The team pledges X% of what the project earns to the treasury. The contracts do not enforce it. | Revenue share, dividend |
| The founder decides alone until other people hold a third of the Shares | Founder-controlled governance |
