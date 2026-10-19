# When can a contributor project's token be traded? (recommendation, 2026-10-19)

Written for D65. Nothing here is built. It answers the roadmap's open question for contributor projects (section 4 of
[SOCIAL-MVP-ROADMAP-2026-10-19.md](SOCIAL-MVP-ROADMAP-2026-10-19.md)): when, if ever, should Shares that were earned for
work become something people can buy and sell?

## Short answer

**Not during the contributor phase, and never as voting Shares.** Keep contributor projects' Shares untradable until
the raise path has been audited. Even then, open a market only by a vote that clears the bar below. If a project does
trade, it should trade a non-voting claim on the treasury, not the Shares that steer it.

## What is true today

- A contributor project has **no sale**. Its DAO is made by `OrgBinding.summonAndBind`, which sets no sale price, and the
  app offers no way to set one (`sales(currency)` is empty; the journey checks it).
- The app **offers no market** for it: the "Put Shares on the market" and "Collect the trading fees" decisions are
  hidden for a contributor project, Markets lists no pool for it, and the page says "Nothing is for sale".
- The Shares are still **ordinary transferable tokens**. Anyone holding them can send them to another wallet, and
  someone could sell them privately or put them into a pool outside the app. The Start page says this plainly ("Shares
  can still be sent from one wallet to another. There is no market for them here."). Today the protection against
  trading is the app's design. The contracts do not enforce it.

## Recommendation 1: lock transfers when the project is born (small, next)

The patched DAO's Shares have `setTransfersLocked(bool)`, callable only by the DAO. While it is on, a transfer is
refused unless it goes to or from the DAO itself. **Minting and burning are not affected**: an award still mints Shares
to the contributor, and leaving with your share of the treasury (ragequit) still burns them. So locking takes nothing
away from the contributor path.

The first decision a contributor project opens can carry the lock with the work budget, in one batch:
`batchCalls([factory.createMandate(...), shares.setTransfersLocked(true)])`. This needs **no contract change**. It is a
change to `firstBudgetDecision` in `web/src/features/start/lib/contributor-project.ts`, plus one assertion in the journey
(a transfer between two contributors reverts once the budget ran). It would make "there is no market" true on the chain
rather than only in the app. Until that first vote runs, transfers stay open, but during those days only the founder
holds Shares.

A later vote could switch the lock off. That is right: it is the project's decision. The app should then treat it as
opening a market (Recommendation 2), with its own decision kind and copy, not as a technical setting.

## Recommendation 2: the bar for opening a market

Open trading only when all of these hold:

1. **The contracts are audited.** That means the Shares token and its lock guard, the transfer validator, the work
   budgets, and the market itself (the exchange is evaluation-only today, see [LBAMM.md](LBAMM.md)). This is the same
   audit the raise needs (roadmap section 5), so no contributor project trades before the raise path is audited.
2. **A legal read for the project.** Work paid in a token that can then be sold looks like pay in kind. The award is
   income at its market value, and once a market exists there is a value to tax. A token whose price depends on the team's
   continued work is also the shape regulators call an investment contract. Without a market, both questions are much
   smaller, which is why contributor projects ship before the raise.
3. **A track record on the page.** The Contributions tab should show the token spread by work, not concentrated. As a
   starting rule: at least 3 months since the first award, at least 5 people with awards, and no one but the founders
   holding more than 20% of all Shares. The founders' starting Shares are shown apart from Shares earned for work, so
   anyone can check this.
4. **A vote with notice.** Opening a market is a full-vote decision, announced on the project page for 30 days before
   it can run. A holder who disagrees has those 30 days to leave with their share of the treasury.
5. **Mainnet is on.** Today mainnet is off and stays off.

## Recommendation 3: trade a claim, not control

A Share is a vote on how the work budgets are spent and who reviews claims. If Shares can be bought, control of the
project can be bought: anyone with money can outvote the people who did the work. The DAO already has a second,
non-voting token, Loot, which counts toward the treasury on exit like a Share but carries no vote. Today the contracts
only turn Loot into Shares (`convertLootToShares`, used by an award with `convert`), not the other way round.

So if a contributor project ever trades, the market should be in **Loot**: contributors keep their voting Shares,
and could turn some into Loot to sell. Voting stays with the people who earned it. That needs a contract path that the
DAO allows (Shares into Loot, at one for one), a decision kind for it, and a market on the Loot token. None of it is
designed or built. It belongs after the audit, and it would be a contract change to write up first.

## What a contributor project should never do

Sell new Shares from the project. That is a raise. It has its own path (the sale, the milestone lock, the reviewer
bond), its own audit and its own copy. A contributor project that wants money becomes a project with a raise. It does
not get a sale added to it.
