# Two designs for later (not to be built yet)

> **Frozen 2026-10-28 (D137).** No new mechanisms until a contributor pilot and the milestone test have run
> ([PILOT-RUNBOOK.md](PILOT-RUNBOOK.md)): no volume or price unlocks, no pool, no premium-only team sale. These notes keep
> what was worked out so far, with the requirements any later build has to meet. Neither is a promise to build.

## (a) A premium-only sale of locked team Shares

**The idea.** Part of a team's milestone-locked Shares could be sold before its milestones, but only for what buyers pay
above a unit's share of the treasury. The treasury share of each sold unit goes into the treasury, so the backing behind
every other unit stays the same; the team keeps only the premium (less the rounds' cut). If everyone wants out, rounds
clear at the floor and the team gets nothing; trading with yourself only pays your own premium back to you.

**Requirements**

- **At most about a fifth of the team's allocation**, fixed at launch.
- **The floor is taken at settlement**, as funding rounds do (D134), never the holder rounds' floor fixed at opening: money
  arriving during bidding must not let units sell below what they take out.
- **The one-asset check** over everything the treasury holds: no ETH, nothing on the watch list, and any holder can flag a
  token (D136), as for funding rounds.
- **What sells is used up for good.** It never also unlocks at a milestone: the milestone's tranche shrinks by what was
  sold from it, so the team cannot sell a Share and later have it unlocked again.
- **Rules for every path**, settled before building: a cancelled offer goes back under the lock; a forfeit (a milestone
  turned down for good, an upheld late objection) burns what is still offered, never what already sold; Shares waiting
  in a round do not vote; payouts while they wait follow the D136 pattern (the team's until settlement, the buyer's
  after).
- **Chosen at launch and published before anyone invests**, never switched on later by vote: it changes what
  `MilestoneLock` promises backers ("locked until the milestone").
- **Buyers risk the premium.** The page shows the treasury behind each unit first and the premium as what it is: a bet on
  the team's future work. A price can be manufactured by self-trading, so it says little on its own.

## (b) An open-trading stage

**The idea.** A project that has outgrown weekly rounds lets its units move freely, while keeping what makes it safe to
hold them.

**Requirements**

- **A DAO vote with 30 days' notice** unlocks transfers, so anyone who disagrees can leave first.
- **The app suggests a track record before offering the vote**: rounds that actually traded, how many distinct holders,
  the treasury's size. A suggestion, not a gate.
- **Leaving and funding rounds stay, for good.** Leaving is the floor every holder can count on; new units still sell
  only through funding terms.
- **Holder rounds become optional block auctions**, like an exchange's opening and closing auctions: a once-a-week price
  for large trades beside continuous trading elsewhere.
- **No pool seeded from the treasury by default.** If a DAO wants one, it is its own vote with its own terms.
- **Voting Shares bought on the market may need a minimum holding time** before they vote, so that a vote cannot be bought
  the day before it closes.
- **Milestone locks do not change.** Locked team Shares stay locked; open trading moves only what is already free.
- **Listing units that can be redeemed from a treasury on an exchange is a legal question first.** It goes to the lawyer
  before any design work.
