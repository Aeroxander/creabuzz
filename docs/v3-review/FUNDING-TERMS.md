# A project's journey, and funding terms (D133, 2026-10-28)

Status: **built for test networks, contributor projects first** (contracts, the app, and a journey on a local chain and a
Sepolia fork). It decides how a project that started with contributors only can take investors' money, and what new units
may ever be created and why. It follows an outside review of the weekly-rounds plan
(2026-10-28), which found the transition from a contributor project to a funded one missing and the issuance story
inconsistent. The calls below are mine, made on your instruction to decide; each is a row in [DECISIONS.md](DECISIONS.md).

## The journey

1. **Start a project.** No money; Shares are earned through reviewed work (built: contributor projects, D65/D66).
2. **Earn ownership through reviewed work.** Work budgets, reviewers, award votes (built).
3. **Publish funding terms**, by vote, before anyone pays: what investors get and how much can ever be sold (built, D133).
4. **Optionally raise** under those terms: each sale its own vote (quantity, least price, end date), sold in weekly funding
   rounds (built, D133).
5. **Scheduled trading between holders** in the same rounds (built, D131/D132).
6. **Continuous trading** when demand supports it: a pool, by vote, beside the rounds (not built; see the end).

Projects started with the fundraising kit keep their own first step: the auction that sells out or refunds (D74), with
the team's Shares locked to milestones (D72). Later raises for them use the same funding terms.

## Three ways money moves

| Action | Who receives the money | What happens to ownership |
|---|---|---|
| Fund the project | The DAO's treasury | The investor receives units the funding terms authorised |
| Buy from a holder | The seller, less a fifth of the gain above the floor, which goes to the treasury | Existing units change hands |
| Leave | The holder, from the treasury | Their units are burned |

One weekly round can carry the first two, but they stay separate everywhere: separate authorisations (terms voted by the
DAO, against a holder's own offer), separate orders in the round, and separate lines on the page ("for the project",
"from holders").

## Two kinds of new units, kept apart

| | Earned | Sold |
|---|---|---|
| Why they exist | Pay for reviewed work | Money for the project |
| Who authorises each one | An award vote on reviewed work | Funding terms voted in advance |
| Limits today | Contributor projects: no yearly cap (D79); fundraising projects: 10% a year (D76) | None can be created today |
| Limits under this design | Unchanged | Only within published terms: a lifetime cap, tranches with a least price and an expiry |

There is no single "minting on or off" switch: it would blur pay for work and money for the project. Selling units is
simply impossible until terms exist, which is the safe default.

## Funding terms

A DAO publishes funding terms by vote:

- **The instrument.** By default investors receive **Loot**: the same exit and payouts as a Share, no vote. A project may
  instead choose voting Shares, decided in the terms and shown as "buyers get a vote". Decided this way because
  contributors would otherwise lose voting control as money arrives, even with their work allocation intact; reserving
  contributor tokens protects an allocation, not a share of control.
- **A funding limit**: the units that may be sold under these terms for now, shown as a number and as a share of all
  units at publication. It is the current authorised limit, not a lifetime promise: a later vote can raise it, with the
  same 30 days' notice, and can lower it at once.
- **The seller**: the one rounds contract that may sell under the terms, named in the vote (it must be a contract) and
  fixed for good. Choosing an exchange for holders' sales grants no power to sell new units (D134).
- **One asset in the treasury while selling** (D134): sales stop while the treasury holds ETH, or any token the DAO
  asked to be watched (up to eight), besides the round's own currency. A price set in one asset would otherwise give
  buyers part of the others for nothing: with 200 USDC, 10 ETH and 200 units, 40 Loot at 1.02 USDC would take about
  1.67 ETH from existing holders.
- **Tranches**, each its own vote within the cap: a quantity, a least price, and an expiry. Bids decide the price above
  the least. No automatic increase or decrease between tranches; that is revisited after real rounds.
- **Notice**: the first sale under new terms can happen only 30 days after the vote, as with opening trading (D77), so a
  holder who disagrees with the dilution can leave first.
- **Never below what leaving pays**: a tranche sells only at or above the floor plus 2% at the moment of sale, so selling
  units never lowers what an existing unit can take out. The floor is a unit's whole share of the treasury, before any
  exit fee.
- **An exit fee** (D135): a part of what leaving pays, at most 5% (the form suggests 2%), stays in the treasury for those
  who remain. It makes buying just before money lands and leaving just after it cost something; it is the redemption fee
  of a mutual fund, paid back into the fund, not to the team. It is set when the terms are first published, so buyers see
  it before paying; a vote can lower it at once but never raise it, and raising the limit keeps it. It is **not charged
  while terms are under notice**, the first 30 days and the 30 days after any raise, so a holder who would be diluted
  can still leave whole. Always on otherwise: a fee only "when there are no buyers" would be lifted by one tiny bid and
  could be timed by insiders. Selling to a new buyer in a round is not leaving and pays no exit fee. A DAO without terms
  charges none, so contributor projects keep a whole exit.

## Going from contributors-only to funded

What stays exactly as it is: every earned Share, the award rule (no yearly cap for contributor projects), the work
budgets, the reviewers, leaving, and the lock guard choice (contributor projects chose "no lock" for good, D73).

What contributors should know, said on the page when terms are proposed:

- Once money is in the treasury, every unlocked earned Share can leave with part of it. That is how the work gets a value,
  and it is also how contributors become sellers in the rounds.
- Investors' Loot dilutes each Share's part of the treasury and of payouts, not its vote (with the default instrument).
- No team milestone lock can be added afterwards: investors in a contributor project see that there is none.

## How a tranche is sold

In a funding round of the weekly rounds the terms name: the tranche is the only offer, at its least price and two steps
above the floor or more, and buyers bid as in any round. Settling does three things in one transaction (D134): it checks
the price is at least two steps above what leaving pays at that moment and that the treasury holds one asset, has the
terms create the units sold, and pays the treasury for them, with no cut. Buyers then collect existing units, or leave
with them at once. Nothing arriving between settling and collecting changes what they were sold against: revenue that
lands then is shared by every holder, the new ones included.

A round nobody settles is void: buyers take back their money, and anyone can finish it, which gives the tranche back so
the DAO can sell or close it again (D134). The tranche ends at its expiry or when it is sold.

## Corrections to what I said earlier (2026-10-27)

- **"The DAO sells Shares it holds in a round" does not work on any DAO the kits make.** Under the issuance rule both kits
  set, Shares leave the DAO's holding only as awards (D76). `WeeklyRounds` allows it only for a DAO without that rule;
  a test now pins that a kit-made DAO is refused. Funding terms replace it.
- **A single minting switch** was the wrong shape; see the two kinds above. Contributor projects award without a yearly
  cap; fundraising projects award within 10% a year; neither can sell new units.
- **The automatic 5% rise** contradicted itself (it fell again after weak rounds, so "the DAO never sells cheaper later"
  was false) and does not stop strategic waiting. Dropped: each tranche has a least price, bids decide the rest.
- **The floor is not protection of what someone paid.** It falls as the project spends, and it moves as units are
  created or unlocked. It is what leaving pays now.
- **A pool cannot start from fees.** Fees grow liquidity that exists; the first liquidity has to come from somewhere (the
  treasury, by vote). Pools beside rounds also need transfer permissions that work with both.
- **Daily rounds are not a setting.** The round contract fixes three days of bidding and a week between openings; faster
  rounds need those to become parameters, in a new deployment.
- **Weekly rounds gather demand; they do not create it.** When buyers are scarce, leaving is the fallback and it costs
  runway.

## What was built

| Contract | Change |
|---|---|
| New `FundingTerms` | Terms per DAO (instrument, funding limit, the seller, the exit fee, 30 days' notice restarted by raising, sold so far), the tokens it watches, one tranche at a time (quantity, least price, expiry), and what an open funding round holds. Settling creates the units sold. `exitFeeOf(dao)` says the fee leaving pays now (none without terms or under notice); `lowerExitFee` only lowers it. Made by the work budget factory, one per summoner |
| `Shares`, `Loot` | `mintForFunding`, accepted only from their summoner's `FundingTerms`. The award rule and its yearly allowance are untouched, and under the issuance rule this is the only way Loot appears. Loot also moves through the exchange the DAO named, as Shares do (D134) |
| The DAO (`MolochPatched`) | Leaving asks its summoner's `FundingTerms` for the exit fee and leaves that part of each payout in the treasury (D135); 591 bytes to spare under the size limit |
| `WeeklyRounds` | Funding rounds (`openFunding`): the tranche is the only offer; settling checks the floor, has the units created and pays the treasury at once; buyers collect existing units or leave with them; `finishFunding` lets anyone give back a void round's tranche. Holders' rounds are unchanged |
| `TreasuryMandateFactory` | Makes the summoner's `FundingTerms` |

Checked by `FundingTerms.t.sol` (13 tests on a DAO under the issuance rule as the kits make them, including one per issue
the outside review found and three on the exit fee), the exit-screen fuzz test (`RagequitPreviewFfi.t.sol`, now with a
fee), twenty-seven mutation entries, and from pages by `scripts/web-rounds-e2e.sh` on a local chain and a Sepolia fork:
the journey ends with a buyer leaving through the exit screen, paid exactly their share less 2%.

In the app: a **Sell new units for the project** decision (publish terms with an exit fee; then open a sale, stop it,
raise or lower the funding limit, lower the exit fee, or name tokens to watch) and a **Funding the project** card on contributor projects' Funds tab: the terms,
how much has sold of the current limit, the exit fee, the sale open now with a **Before you buy** list (the limit can be
raised; contributor awards have no yearly limit; earned Shares can leave with money raised; no milestone locks; what Loot
is and that it can't yet be sold in a round; the exit fee), its funding rounds, a button to give back a void round's tranche, and every earlier
round where you still have something to collect (the holders' card lists those too). Fundraising-kit projects are not
offered it yet.

Not yet: Loot holders selling in holders' rounds, which trade Shares. Their way out today is leaving. Loot can now move
through the exchange, which is the step that makes Loot rounds possible.

## Later: continuous trading

When a project is busy enough, a pool can sit beside the rounds: small trades continuously, exits, large blocks and
tranches in the rounds at one price, with traders keeping the two close. It needs its first liquidity from the treasury
by vote, transfer permissions for the pool that keep the lock's other promises, and rounds that can run more often (new
parameters). None of that is designed yet.

## Open questions

- Whether contributor projects may choose voting Shares for investors at all, or Loot only.
- Whether a tranche needs a least amount to raise (sell enough or sell nothing), as the first auction has.
- The 30-day notice for terms, the 2% above the floor and the cap's display: first values, to revisit after a pilot.
- The exit fee's suggested 2% and its 5% ceiling, and whether a raised limit should be the only free window (an
  unrelated vote a holder dislikes, such as a large budget, still charges the fee).
