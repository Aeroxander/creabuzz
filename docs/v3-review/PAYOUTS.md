# Payouts to holders (N10, built for test networks on 2026-10-26 as D122)

Status: **built for test networks, for contributor projects.** `contracts/src/Payouts.sol` (the module and its
factory), a hook in the patched DAO, a Payouts card on the Funds tab and a "Pay holders" decision. It revises D78 (no
automatic payouts) and D82 (the revenue pledge was a statement only) on test networks. **This piece needs counsel more
than any other** before real money.

## How money reaches holders

- **Revenue.** The project's revenue address is its payout module. Money sent there is revenue, and nothing else is:
  raise money, refunds, returned budgets and moves between the project's own accounts never land there. Anyone presses
  **Split it now**: the split (say 50%) is credited to holders, the rest goes to the treasury.
- **A payout the DAO votes.** "Pay holders 100 USDC from the treasury": one batch approves the module and declares it,
  all for holders.

## Who counts, and from when

Every Share and Loot outside the DAO's own holding: what leaving pays out on. The DAO tells the module of every change in
who holds what (transfers, mints, burns, sales in weekly rounds, leaving), through the same notice it already sends the
voting ledger. So units count from the moment they are held: a buyer gets nothing for payouts made before they bought,
and a seller, someone who left or someone banned keeps what was credited to them and collects it themselves.

Money moves out of the treasury when it is credited, so leaving cannot pay it twice.

## What stops it from going wrong

| Rule | How |
|---|---|
| Chosen once | The DAO names its module with one vote, and cannot rename it: a module that stopped being told of changes would pay the wrong people |
| Only a module of known code | The DAO accepts only a module its own work budget factory's payouts factory made for it. A module saying whose it is proves nothing: one that refused every notice would stop every transfer and exit (D129, D130) |
| Making it early changes nothing | Anyone can make the module before the vote; it is the same contract, and the vote's batch finds it made instead of failing (D129) |
| Nothing paid before it is told of changes | The module refuses to split or declare until the DAO has named it |
| The split changes only with notice | A vote announces a new split; it takes effect 30 days later, pressed by anyone |
| Leaving is never blocked | The notice the DAO sends is plain arithmetic bounded so it cannot overflow: a payout that would push the running total past its bound is refused instead |
| A payout needs someone to pay | At least one whole unit must count |
| Rounding | Each holder's share rounds down, by at most one cent's millionth; what is set aside always covers every holder |

## What differs from the proposal

- **Contributor projects only.** A DAO with locked team Shares needs every unlock and forfeit counted (the milestone
  lock does not tell anyone today); the module refuses a DAO whose Shares have a lock guard, or that has not yet chosen "no lock" for good (D129).
- **One module per DAO, chosen once.** The split can change with notice; the module cannot.
- **No expiry on unclaimed payouts** (open question 4 in NEXT-GEN-DAO.md): what was credited stays claimable.
- **Not tied to work.** As the proposal says, making people forecast or work to receive a payout does not change what
  it is.

## Open, for you and counsel

Whether payouts exist at all on a main network; locked-Share DAOs; an expiry for unclaimed payouts; how revenue that
arrives off-chain gets sent to the revenue address (still up to the team, as D78 says).
