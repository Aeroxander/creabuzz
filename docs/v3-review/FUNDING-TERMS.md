# A project's journey, and funding terms (D133, 2026-10-28)

Status: **specified, not built.** It decides how a project that started with contributors only can take investors'
money, and what new units may ever be created and why. It follows an outside review of the weekly-rounds plan
(2026-10-28), which found the transition from a contributor project to a funded one missing and the issuance story
inconsistent. The calls below are mine, made on your instruction to decide; each is a row in [DECISIONS.md](DECISIONS.md).

## The journey

1. **Start a project.** No money; Shares are earned through reviewed work (built: contributor projects, D65/D66).
2. **Earn ownership through reviewed work.** Work budgets, reviewers, award votes (built).
3. **Publish funding terms**, by vote, before anyone pays: what investors get, how much can ever be sold, at what least
   price, until when (this document; not built).
4. **Optionally raise** under those terms, in weekly rounds (the round contract is built, D131/D132; selling under terms
   is not).
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

A DAO publishes funding terms by vote. They hold, and cannot later be widened:

- **The instrument.** By default investors receive **Loot**: the same exit and payouts as a Share, no vote. A project may
  instead choose voting Shares, decided in the terms and shown as "buyers get a vote". Decided this way because
  contributors would otherwise lose voting control as money arrives, even with their work allocation intact; reserving
  contributor tokens protects an allocation, not a share of control.
- **A lifetime cap**: the most units that can ever be sold under these terms, shown as a number and as a share of all
  units at publication. Raising it means new terms, with the same notice.
- **Tranches**, each its own vote within the cap: a quantity, a least price, and an expiry. Bids decide the price above
  the least. No automatic increase or decrease between tranches; that is revisited after real rounds.
- **Notice**: the first sale under new terms can happen only 30 days after the vote, as with opening trading (D77), so a
  holder who disagrees with the dilution can leave first.
- **Never below what leaving pays**: a tranche sells only at or above the floor plus 2% at the moment of sale, so selling
  units never lowers what an existing unit can take out.

## Going from contributors-only to funded

What stays exactly as it is: every earned Share, the award rule (no yearly cap for contributor projects), the work
budgets, the reviewers, leaving, and the lock guard choice (contributor projects chose "no lock" for good, D73).

What contributors should know, said on the page when terms are proposed:

- Once money is in the treasury, every unlocked earned Share can leave with part of it. That is how the work gets a value,
  and it is also how contributors become sellers in the rounds.
- Investors' Loot dilutes each Share's part of the treasury and of payouts, not its vote (with the default instrument).
- No team milestone lock can be added afterwards: investors in a contributor project see that there is none.

## How a tranche is sold

In a weekly round, as its own kind of order: the funding contract offers the tranche at its least price; at the claim,
the units are created for the buyer and the money goes straight to the treasury, with no cut. Holders' offers compete
with it on price, as now, so a holder asking less fills first. The tranche ends at its expiry or when it is sold.

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

## What would change in the contracts

| Contract | Change | Room |
|---|---|---|
| Patched DAO (`Moloch`) | Name a funding contract by vote, switched on 30 days later (as the exit exchange is); a transient `funding()` flag set only while that contract creates units | 1,912 bytes spare |
| `Loot` | Under the issuance rule, accept a mint only while `funding()` is up | 21,059 bytes spare |
| `Shares` | The same, only when the terms chose Shares | 13,044 bytes spare |
| New `FundingTerms` | Terms per DAO: instrument, lifetime cap, tranches (quantity, least price, expiry), the notice; it is what the DAO names | new |
| `WeeklyRounds` | A primary order type: offered by the funding contract, units created at the claim, money to the treasury, no cut | redeploy (test networks) |
| `DaoLaunchKit` | Nothing for the first raise; later tranches use the same terms | 701 bytes spare: no room to add anything |

Tests that would decide it: no unit is created outside an award or a live tranche; a tranche never sells below the floor
plus 2% at the moment of sale nor past its quantity, cap or expiry; terms cannot be widened, and nothing sells within 30
days of the vote; holders' offers and a tranche in the same round settle at one price with each paid where it should be;
investors' Loot cannot vote. The audit scope grows by `FundingTerms` and the three patches.

## Later: continuous trading

When a project is busy enough, a pool can sit beside the rounds: small trades continuously, exits, large blocks and
tranches in the rounds at one price, with traders keeping the two close. It needs its first liquidity from the treasury
by vote, transfer permissions for the pool that keep the lock's other promises, and rounds that can run more often (new
parameters). None of that is designed yet.

## Open questions

- Whether contributor projects may choose voting Shares for investors at all, or Loot only.
- Whether a tranche needs a least amount to raise (sell enough or sell nothing), as the first auction has.
- The 30-day notice for terms, the 2% above the floor and the cap's display: first values, to revisit after a pilot.
