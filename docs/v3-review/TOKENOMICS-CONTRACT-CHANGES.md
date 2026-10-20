# The tokenomics decisions as contract changes (write-up before the code, D72–D79, 2026-10-21)

You accepted T1 to T8 of [TOKENOMICS-PROPOSAL.md](TOKENOMICS-PROPOSAL.md) as written (D72–D79). As the plan asks of any
contract change, this says exactly what changes, in which contract, what it must not break, how it is tested and what it
does to the audit, before any code is written. Nothing here is built yet.

| Decision | What | Contracts |
|---|---|---|
| D72 (T1) | Team Shares still locked are left out of the exit total | `MilestoneChallenge`, `MilestoneLock`, patched `Moloch.ragequit` |
| D73 (T2) | Leaving cannot be switched off | patched `Moloch` (remove `setRagequittable`) |
| D74 (T3) | The sale sells out or refunds | `DaoLaunchKit` |
| D75 (T4) | Limits on the split and the milestones | `DaoLaunchKit` |
| D76 (T5) | New Shares only as pay for reviewed work, at most 10% a year; the DAO's own share sale, permits and allowances removed | `Shares`, `Loot`, patched `Moloch`, `DaoLaunchKit` |
| D77 (T6) | Shares cannot be sent between wallets, except to and from the auction | `Shares`, `DaoLaunchKit` |
| D78 (T7) | A revenue pledge into the treasury | none (app only) |
| D79 (T8) | The founder's limits in contributor projects | `ContributorKit` (and the D76 rule) |

## 0. Measured first

Built in a scratch copy of `contracts/` at `1bcb885c0` (solc 0.8.37, `via_ir`, 200 runs), nothing committed:

| Contract | Today | Limit | Note |
|---|---|---|---|
| `Moloch` (runtime) | 24,575 | 24,576 | 1 byte spare |
| `Moloch` without `setPermit`, `spendPermit`, `setAllowance`, `spendAllowance`, `setSale`, `buyShares`, `setRagequittable` | **21,806** | 24,576 | 2,769 bytes freed |
| The same plus a prototype of D72's subtraction and D76's award flag | **21,842** | 24,576 | +36 bytes; 2,734 spare |
| `Summoner` (creation code, carries `Moloch`) | 43,336 → 40,603 | 49,152 | follows `Moloch` |
| `Shares` (runtime) | 8,653 | 24,576 | room for D76 and D77 |
| `Loot` (runtime) | 3,088 | 24,576 | |
| `DaoLaunchKit` (creation code) | 46,508 | 49,152 | **2,644 spare**: the tightest; see §3 |
| `ContributorKit` (runtime) | 5,193 | 24,576 | |
| `MilestoneChallengeFactory` (runtime, carries the lock) | 17,415 | 24,576 | |
| `MilestoneLockFactory` (runtime) | 9,078 | 24,576 | |

So the removals of D73 and D76 come first: they make the room every other change in the patched DAO needs.

The auction question the proposal left open is answered by its source: the auction prices each block from the supply
still left divided by the blocks still left (`ContinuousClearingAuction.sol`, `DemandLib.currencyRaisedAtPrice` with
`remainingSupply` and `MPS - cumulativeMps`), so supply that found no buyer early is offered again later, and the
clearing price never falls. A sale whose target is the whole tranche at the floor can only graduate if, by its end,
bidders paid at least the floor for every Share; at the floor that means all of them, and above it the price only rose
because demand covered the supply. What is left unsold is rounding dust. The simulation gains a sale that only just
graduates to check it on a real chain (§7).

## 1. D72: the exit leaves out Shares still locked

**Today.** `ragequit` pays `pool × burned / total`, where `total` is every Share and Loot unit less the DAO's own (the D51
patch). A team member's locked Shares are in `total` though they can never leave.

**The change.**

- `MilestoneChallenge` and `MilestoneLock` each keep `uint256 public totalLocked`: the sum of every tranche at
  construction, less each tranche when it unlocks and when it is forfeited (both functions already mark the tranche;
  the counter moves in the same place). A stored counter, not a loop: `lockedOf` loops over a member's tranches, and a
  loop over 16 seats × 8 tranches would cost about 270,000 gas in every exit.
- `ISharesLockGuard` gains `totalLocked()`.
- `Moloch.ragequit`, a new patch block after the D51 one:

  ```solidity
  address guard = _shares.lockGuard();
  if (guard != address(0)) {
      uint256 lockedTotal = ISharesLockGuard(guard).totalLocked();
      require(lockedTotal <= total, NotOk());
      total -= lockedTotal;
  }
  ```

  `ragequit` runs inside `unchecked`, so the `require` is what keeps a wrong counter from wrapping the total.

**Why it holds.** Locked Shares are always held by team members (the lock guard keeps each balance at or above
`lockedOf`), and the DAO's own Shares are never locked (`_requireUnlocked` returns early for the DAO), so nothing is
subtracted twice, **provided no team seat is the DAO itself**. The kit therefore refuses a team seat that is the
predicted DAO, the executor, the auction or the kit (§3). What moves the total:

| Event | Locked total | Shares in existence | Exit total |
|---|---|---|---|
| A milestone unlocks | down | same | **up**: the team's claim begins |
| The DAO forfeits a departed member's tranches (burned) | down | down by the same | same |
| An upheld late objection burns what is still locked | down | down by the same | same |
| A team member leaves with free Shares | same | down | down, as for anyone |

A holder who leaves just before an unlock takes more than one who leaves just after. That is the intended effect ("leave
before each milestone with your full part"), not a race to fix.

**The app.** `ragequit-position.ts` reads `totalLocked()` from the Shares' lock guard and subtracts it, so the exit
screen still shows exactly what the chain pays (invariant 3). The Milestones tab says that an unlock lowers the exit
value of every other Share, and when the next one could happen.

**Tests** (each must fail on today's code first):

- day one, after the sale: a backer leaving receives their sale Shares' share of the whole treasury;
- after one milestone unlocks, the exit uses the unlocked tranche; a forfeit and an upheld late objection leave every
  other holder's exit unchanged;
- a guard that reports more locked than exists makes `ragequit` revert, not pay;
- `totalLocked == Σ lockedOf(team)` after every step, in `MoneyPaths` as a new invariant;
- invariant 3 and `RagequitPreviewFfi.t.sol` rewritten for the new total;
- mutations: the subtraction removed; the counter not decreased on unlock; the counter not decreased on forfeit.

## 2. D73 and D76 (first half): the removals

Removed from the patched `Moloch`, in the fork's additive style (the upstream text stays in a comment inside a
`@@CREABUZZ PATCH` block, as `openProposal` already does, so `scripts/check-majeur-fork.mjs` still passes):

| Function | Why |
|---|---|
| `setRagequittable` | D73: nobody can switch leaving off. A DAO is born with leaving on or off and stays so; both kits pass `true` |
| `setSale`, `buyShares` | D76: the DAO's own share sale minted or handed out Shares at any price a vote chose. A second raise will be its own design |
| `setPermit`, `spendPermit` | Vote-granted ways to run calls later; nothing here uses them (AUDIT-SCOPE.md §6, item 4) |
| `setAllowance`, `spendAllowance` | Vote-granted ways out of the treasury; nothing here uses them. `OrgAllowance` is a separate contract with its own allowances and is not affected |

Storage stays where it is (`sales`, `allowance`, `isPermitReceipt`): the clones are not upgradeable, but keeping the
layout keeps the diff small. The `isPermitReceipt` checks in the badge transfers stay and are always false.

**What else uses them, and changes with them.** The invariant handler's attack doors for allowances, permits and
`setRagequittable` (`MoneyPathsHandler.sol`) and the simulation's (`simulate-raise.mjs`) become checks that those calls
now fail. The projects page's raw summon (`summon-composer.ts`) mentions `buyShares` for later joins and offers a
"leaving" toggle: the join path goes, and the toggle says that the choice is permanent. Nothing in the web app's
decision forms uses any of them.

**Tests**: a proposal calling each removed selector cannot move money or change the setting (the test pins whether the
call reverts or does nothing); the full suite and the simulation still pass with the doors gone.

## 3. D74 and D75: the launch kit refuses unfair terms

New checks in `DaoLaunchKit._launch`, before anything is created. `total` is the team's Shares plus the sale tranche
plus the DAO's own:

| Check | Rule |
|---|---|
| Sale | `saleSupply × 10,000 ≥ 6,000 × total` |
| Team | `Σ teamShares × 10,000 ≤ 3,500 × total` |
| DAO reserve | `daoShares × 10,000 ≤ 2,000 × total` |
| Milestones, when there is a team | 2 to 8 of them; `milestoneBps` add up to exactly 10,000; none above 5,000 |
| Team seats | none is zero, the predicted DAO, the executor, the predicted auction or the kit (D72's safety) |
| Sells out or refunds | the auction's `requiredCurrencyRaised ≥ floorPrice × saleSupply / 2^96` (the whole tranche at the floor), worked out with `Math.mulDiv` so it cannot overflow |

A team of zero stays possible (no milestones then, as today).

**The size.** The kit has 2,644 bytes of creation code to spare, and it carries the executor's creation code. Reading
the floor and the required amount means decoding `AuctionParameters` from `auctionConfig`, which has a dynamic field. If
the checks do not fit, they move to a small separate contract, `LaunchTerms`, with one `view` function the kit calls
(deployed once beside the kit, holding nothing, no roles); the kit's own change is then one call. Measure first; prefer
the kit if it fits with at least 500 bytes left.

**The app.** `planDaoLaunch` runs the same checks so the form names the field before a wallet prompt; the own-DAO
launch uses the 100% line by default (the existing "fixed price" line; the release shape stays a separate choice);
`allocation.ts` gains the presets Standard 75 / 25 / 0, Small team 80 / 20 / 0 and Large team 65 / 35 / 0; the
milestone templates keep three milestones (33 / 33 / 34 passes the 50% rule).

**Tests**: one failing launch per rule, at the edge (60% passes and 59% fails, and so on); a team seat equal to the
predicted DAO reverts; a config with the 15% line reverts; the existing kit tests move to terms inside the limits.

## 4. D76 (second half): new Shares only for reviewed work, at most 10% a year

**Today.** `Shares.mintFromMoloch` mints whatever the DAO asks, from any passed proposal; the DAO can hand out the Shares
it holds by a transfer; `Loot.mintFromMoloch` likewise.

**The change, in `Shares`** (its own contract, 8,653 bytes):

- New state: `uint16 issuanceCapBps` (`type(uint16).max` while there is no rule), `bool awardsOnly`,
  `uint64 yearStart`, `uint128 yearBase`, `uint128 issuedThisYear`.
- `setIssuanceRule(uint16 capBps)`, `onlyDAO`. The first call turns `awardsOnly` on for good and sets the cap. Later
  calls may only lower it. `NO_CAP` (`type(uint16).max`) means awards only with no yearly limit (contributor projects,
  D79); a lower number can be adopted later by vote, never a higher one. Zero means no new Shares at all.
- While `awardsOnly`, `mintFromMoloch` requires `Moloch(DAO).awarding()` (below), and so does any transfer out of the
  DAO's own holding. Outside an award the DAO can neither mint nor hand out Shares.
- Under an award, `mintFromMoloch` first moves Shares from the DAO's own holding, if it has any, then mints the rest. A
  reserve (D75 allows up to 20%) is therefore spent on reviewed work before anything new is created, and both count.
- Counting: on each counted amount, if a year has passed since `yearStart` (or no year has started), a new year starts
  now with `yearBase` = Shares outside the DAO at that moment and `issuedThisYear = 0`; then
  `issuedThisYear += amount` and `issuedThisYear × 10,000 ≤ yearBase × issuanceCapBps`, or the award reverts.
- Launch-time Shares are not counted: `Shares.init` mints with `_mint`, not `mintFromMoloch`, and the rule is set by
  the DAO's initialization calls after it.

**In `Loot`**: `closeMinting()`, `onlyDAO`, set once; after it `mintFromMoloch` reverts. The kits call it at birth, so
no Loot ever exists in these DAOs. (`convertLootToShares` then has nothing to convert; an award with `convert` set
fails, which the app never sends.)

**In the patched `Moloch`**: `awardContribution` sets a transient flag around its mint (`tstore` before, cleared
after), and `awarding()` reads it. The flag is set after `consumeContribution` returns and cleared right after the
mint, so the only calls made while it is on are to the DAO's own Shares (or Loot) and, through them, the DAO's own
ownership callback and voting policy: no contract outside the DAO runs while a mint is allowed. Measured with D72: +36
bytes.

**In the kits**: `DaoLaunchKit.Params` gains `uint16 yearlyCapBps`, required to be at most 1,000 (10%), set into
`Shares` and `Loot.closeMinting()` in the initialization calls, and read back after the summon.

**Choices made here, which you may want to see**: the year is a fixed window from the first new Share, not a rolling
twelve months (no history to keep). So 10% at the end of one year and 10% at the start of the next is possible, which
the page says ("at most 10% in each year since the first award"). The base is the Shares outside the DAO, which is what
a backer's share is measured against.

**What happens to an award over the limit.** `consumeContribution` runs first and the mint then reverts, so the whole
award reverts: the claim stays paid and not yet awarded, and the same award can be voted again in the next year. The
Work tab shows the year's remaining allowance before an award is proposed.

**Tests**: a passed proposal that mints directly reverts; one that transfers out of the DAO's holding reverts; an award
inside the limit mints; an award over it reverts and the claim can still be awarded later; the year rolls; the cap can
be lowered, not raised, and `awardsOnly` cannot be turned off; an award draws on the DAO's holding first; Loot cannot be
minted after closing. New invariants in `MoneyPaths`: "after the claim block, Shares outside the DAO grow only inside
`awardContribution`" and "within each year, what was issued is at most the cap of that year's base". Mutations: the
`awarding()` check removed; the count removed; the transfer-out check removed.

## 5. D77: Shares stay where they are, except to and from the auction

**Today.** `Shares.setTransfersLocked` exists (contributor projects use it). While it is on, a transfer must go to or
from the DAO. A raise cannot use it as is: the executor funds the auction and buyers collect from it.

**The change, in `Shares`**: `address public transferExempt`, set once by `setTransferExempt(address)` (`onlyDAO`), and
`_checkUnlocked` also lets a transfer through when it goes to or from that address. In a raise it is the auction, so:

| Move | Allowed |
|---|---|
| Executor funds the auction | yes (to the auction) |
| A buyer collects their Shares | yes (from the auction) |
| The auction sweeps unsold Shares to the executor, the executor to the DAO | yes (from the auction; to the DAO) |
| The kit passes the DAO's own Shares to it | yes (to the DAO) |
| A holder sends Shares to anyone else, or to a pool | **no** |
| Leaving (a burn), awards (a mint or a move from the DAO under D76) | yes: the transfer lock does not touch them |

Anyone can still send Shares *to* the auction; they would be stuck there. That harms only the sender, and is cheaper
than a narrower exemption.

**In the kit**: two more initialization calls, `setTransfersLocked(true, true)` on the DAO and
`setTransferExempt(predictedAuction)` on the Shares, both read back. The auction's address is already predicted (D69)
and checked after creation.

**Later**: lifting the lock stays a vote (`setTransfersLocked(false, …)`), because opening a market is the project's
decision. The app treats it as "open trading", its own decision kind, which it offers only when the bar of
CONTRIBUTOR-TOKEN-TRADING.md is met. The `market seed` command line path (D14) cannot run while Shares are locked;
it waits for that decision.

**Tests**: a holder-to-holder transfer reverts; collecting from the auction, sweeping and graduating all work on the
real auction (`DaoLaunchKit.t.sol` and the challenge journey); the exemption is set once; a new invariant "while locked,
Shares outside the DAO move only by collection from the auction, mint and burn". The simulation's 872 transfers become
refusals it expects.

## 6. D79: the founder's limits in a contributor project

In `ContributorKit.launch`, before anything is made: `founderShares × 3 ≤ shareBudget` and no reviewer is the caller,
else `InvalidTerms`. Two more setup calls: `Shares.setIssuanceRule(NO_CAP)` (awards only, no yearly limit) and
`Loot.closeMinting()`, both read back with the rest. The Start page says the founder can start with at most a third of
the first budget, and the Contributions tab shows the founder's share over time and whether the founder alone can still
pass a vote. Tests: a founder stake above a third reverts, a founder named as a reviewer reverts, a direct mint by a
passed vote reverts, an award still mints.

## 7. D78 and the app (no contract)

- **Revenue pledge**: a launch field (percent of net receipts, how often, until when, the signed document it is in),
  shown on the sale page as the team's own statement, and a card on the DAO's front page listing money that came into
  the treasury (currency transfers into the DAO, read from the chain), labelled "the contracts do not enforce the
  pledge".
- **Copy**: "while leaving is switched on" becomes "whenever you want to leave" for DAOs made by the kits; the exit
  screen, the agreement and PILOT.md follow. The new limits, the allowance and the transfer lock appear in the Powers
  card ("what can and cannot be changed").
- **Journeys and the simulation**: the challenge journey and the economy journey move to terms inside the limits; the
  simulation adds a sale that only just graduates (and checks sold ≥ tranche less dust), many exits before the first
  milestone, award years that hit the limit, and transfer refusals.

## 8. What does not change

- Locked team Shares still vote from the first block (D13); the milestone rules (D56–D58), the voting lanes, the work
  budgets and the reviewer bonds are untouched.
- `GraduationExecutor` and `AllowlistHook` are untouched, so the bytecode embedded in the desktop app stays valid.
- The auction and its factory are upstream and untouched.
- DAOs not made by the kits (the raw summon) keep upstream behaviour except for the removed functions: no issuance rule,
  no transfer lock unless they vote one.

## 9. The audit scope after this

| File | Change |
|---|---|
| `src/majeur/MolochPatched.sol` (`Moloch`) | seven functions removed; `ragequit` subtracts what is locked; the award flag. Smaller than today |
| `src/majeur/MolochPatched.sol` (`Shares`, `Loot`) | the issuance rule, the award-only mint and transfer-out, the transfer exemption; Loot's closed minting |
| `src/MilestoneChallenge.sol`, `src/MilestoneLock.sol` | the `totalLocked` counter |
| `src/DaoLaunchKit.sol` (or a new `src/LaunchTerms.sol`) | the launch checks, the issuance and transfer initialization |
| `src/ContributorKit.sol` (adjacent) | two checks, two setup calls |

AUDIT-SCOPE.md §6 item 4 (the vote-granted share sale, permits and allowances) is resolved by removal. The invariants
grow from 12 to 16 (`totalLocked`, award-only issuance, the yearly cap, the transfer lock); invariant 3 is rewritten.
LBAMM and the market contracts stay out. The freeze tag comes after all of it.

## 10. The order of the work

1. The removals (§2): the suite, the fork checker, the invariants and the simulation with the doors gone.
2. D72 (§1): the counter, the subtraction, the exit preview, invariant 3.
3. D76 (§4): `Shares`, `Loot`, the flag.
4. D77 (§5): the exemption.
5. D74, D75 and D79 (§3, §6): the kit checks, measured against the 2,644 bytes.
6. The app (§7): planner, presets, sale line, exit preview, allowance, pledge, copy, journeys.
7. All gates again: `forge test` with `REQUIRE_CONTRACT_ARTIFACTS=1`, the invariants, the mutation check with its new
   entries, `scripts/simulate-raise.sh` with three seeds, the journeys, the size test; then a DECISIONS update per step
   and the freeze tag in AUDIT-SCOPE.md.

Each step starts with a test that fails on the code before it, as D67–D70 did.
