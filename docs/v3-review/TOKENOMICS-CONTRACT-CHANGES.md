# The tokenomics decisions as contract changes (write-up before the code, D72–D79, 2026-10-21)

You accepted T1 to T8 of [TOKENOMICS-PROPOSAL.md](TOKENOMICS-PROPOSAL.md) as written (D72–D79). As the plan asks of any
contract change, this says exactly what changes (revised after a second review the same day, D80, §0a), in which contract, what it must not break, how it is tested and what it
does to the audit, before any code is written. Nothing here is built yet.

| Decision | What | Contracts |
|---|---|---|
| D72 (T1) | Team Shares still locked are left out of the exit total | `MilestoneChallenge`, `MilestoneLock`, patched `Moloch.ragequit` |
| D73 (T2) | Leaving cannot be switched off or taken away | patched `Moloch` (remove `setRagequittable`; burns only while leaving), `Shares` (the lock guard decided at birth) |
| D74 (T3) | The sale sells out or refunds | `DaoLaunchKit` |
| D75 (T4) | Limits on the split and the milestones | `DaoLaunchKit` |
| D76 (T5) | New Shares only as pay for reviewed work, at most 10% a year; the DAO's own share sale, permits and allowances removed | `Shares`, `Loot`, patched `Moloch`, `DaoLaunchKit` |
| D77 (T6) | Shares cannot be sent between wallets, except to and from the auction; lifting that takes 30 days' notice | `Shares`, `DaoLaunchKit` |
| D78 (T7) | A revenue pledge into the treasury | none (app only) |
| D79 (T8) | The founder's limits in contributor projects | `ContributorKit` (and the D76 rule) |

## Built (2026-10-21)

All of §1 to §6 is built, on the local branch `tokenomics-proposal`, one commit per step, each starting from a test that
failed on the code before it, and each guard broken once by `scripts/contracts-mutation-check.mjs` (35 entries, all
caught). Where the build differs from the plan below, the plan was changed to what was built:

- **The lock factories are constructor arguments of the kit (§3).** The checks did not fit: the kit's creation code
  carried both lock factories and was 590 bytes over the 49,152-byte limit with them. Rather than a separate checking
  contract, the factories (permissionless; they record who made each lock) are deployed beside the kit and passed to its
  constructor. The kit's creation code is now 22,951 bytes. `DeployLaunchKit`, `dev-chain.sh` and the simulation deploy
  them.
- **The yearly cap is a kit constant, not a launch parameter (§4):** `DaoLaunchKit.YEARLY_ISSUANCE_BPS = 1000`, so the
  launch call's format, the shared encoder and its goldens did not change. A vote can lower it later.
- **Loot needs no call of its own (§4):** it refuses to mint whenever its DAO's Shares have the issuance rule on.
- **One call locks transfers (§5):** `Shares.lockTransfersWithNotice(exempt)` locks, names the exempt address and
  turns the 30-day notice on, once.

Sizes after: `Moloch` 22,090 bytes (2,486 spare), `Shares` 10,902, `Loot` 3,517, `DaoLaunchKit` 22,192 runtime and
22,951 creation code, `ContributorKit` 6,181. The Forge suite is 452 passed, 0 failed; the web unit tests 1,802; the
shared package 764; the mocked browser smoke suite passes; the simulation ran 3,000 steps (seed 7) with zero breaks,
every transfer refused by the lock; and these real-chain journeys pass on the new terms: web-challenge,
web-contributor, web-dao-launch, web-milestone, web-dao-journey, web-decisions, web-discussion, web-paid-work,
web-record, web-work, cli-milestone and cli-no-raise. Not run: web-economy (needs Postgres and Redis),
web-sepolia-fork (needs a Sepolia node), and the market journeys (LBAMM is evaluation-only, and with transfers locked
and no reserve they need the 30-day unlock and a new way to fund a pool).

The app pieces of §7 (the revenue pledge and the money that came in, the yearly allowance on the Work tab, the Open
trading decision with the 30-day notice, and the copy that leaving is permanent) are built too: D82.

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

## 0a. What a second review changed (2026-10-21)

Another AI reviewed the proposal and this write-up against the code. Each point was checked before anything here
changed; all of them hold, and one more turned up while checking them.

| Finding | Checked | What changed here |
|---|---|---|
| A vote can still close leaving: `Shares.setLockGuard` accepts any contract while the slot is empty, and contributor projects and teamless raises are born without a guard. A guard that reverts in `lockedOf` (or, after D72, reports more than exists in `totalLocked`) blocks every exit, for good | Yes (`MolochPatched.sol` 1495: set once, any contract with code) | §2: the guard is decided at birth, including "none", and cannot be set after. Both kits test it |
| **Found while checking:** a vote can call `Shares.burnFromMoloch(holder, amount)` directly. It is `onlyDAO`, and its only intended caller is `ragequit`, so a passed proposal can burn any holder's free Shares: their exit taken away without leaving ever being switched off | Yes (1540; the only call in the DAO is from `ragequit`, 1045) | §2: Shares accept a burn only while the DAO is inside `ragequit`, the same transient-flag pattern as D76's awards |
| "$1,000 back on day one" is wrong for a buyer who paid more than others. The auction sells each block at that block's price, so early buyers pay less per Share, and the exit pays per Share, not per dollar (the reviewer's local run: $50 and $100 for 50 Shares each, both leave with $75) | Yes: that is how the auction works; the worked examples assumed one price | The promise is a proportional claim on the pooled proceeds; the proposal's tables say what they assume; a regression case in §1's tests |
| The notice before a decision runs is 72 hours, not 84: the hold runs inside the review (`AllocationVoting.earliestApproval` takes the later of review end and hold end), then the one-day delay | Yes (`AllocationVoting.sol` 453) | Copy and docs say "at least 3 days" for the full vote (2 for the lighter one). No contract change: 72 hours is enough to send one exit transaction, and a longer wait costs every honest decision |
| The 30 days' notice before trading was app policy: a raw proposal could lift the transfer lock at once | Yes | §5: lifting the lock takes effect 30 days after it is announced, in `Shares`. The audit, legal read and track record stay app policy, and the page says which is which |
| The yearly cap was measured against Shares that include locked team Shares, which the exit leaves out: 10 new Shares on 65 backer Shares and 35 locked cut each Share's exit value by 13.3%, not 10% | Yes | §4: the base is the same total the exit uses, so new Shares can cut each Share's exit value by at most 1 − 1/1.1 ≈ 9.1% a year; unlocks are separate and shown on their own |
| D79 compares the founder with a budget that may never be awarded | Yes | §6 says it is a starting limit, not contributor control; founder-led governance stays a stated dependency until ownership actually spreads |
| Closing Loot for good conflicts with the trading note's later Shares-to-Loot idea | Partly: no such conversion exists in the contracts, and the clones cannot be upgraded, so it needs new code and a migration (or a separate token) whether or not Loot is closed | §4 says so; nothing speculative is added now |

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

**What it promises, exactly.** Every Share that counts gets the same part of the pooled treasury. Buyers in the auction
pay different prices (earlier blocks clear lower), so the promise is "your Shares' proportional part of what is left",
not "the money you paid": a buyer who paid more than the average per Share gets back less than they paid even before
anything is spent, and an earlier buyer more. Protecting each buyer's own principal would need a different sale or
per-buyer accounting; that is not proposed. The sale page and the exit screen show the buyer's own average price next to
the exit value per Share, so the difference is visible.

**The app.** `ragequit-position.ts` reads `totalLocked()` from the Shares' lock guard and subtracts it, so the exit
screen still shows exactly what the chain pays (invariant 3). The Milestones tab says that an unlock lowers the exit
value of every other Share, and when the next one could happen.

**Tests** (each must fail on today's code first):

- day one, after the sale: a backer leaving receives their sale Shares' share of the whole treasury;
- after one milestone unlocks, the exit uses the unlocked tranche; a forfeit and an upheld late objection leave every
  other holder's exit unchanged;
- a guard that reports more locked than exists makes `ragequit` revert, not pay;
- two buyers at different auction prices (the reviewer's case: $50 and $100 for 50 Shares each, $150 in the treasury)
  each leave with $75: the exit pays per Share, and the test pins it so the copy cannot drift back to "your money";
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

### 2a. D73 also covers the two other ways a vote could take leaving away

Removing the switch is not enough on its own (§0a):

- **The lock guard is decided at birth.** `Shares` gains `bool lockGuardSet`; `setLockGuard(guard)` may be called once,
  with a lock **or with zero for "no lock"**, and either way the choice is final. Today zero leaves the slot open, and a
  later vote can fill it with any contract, which could refuse every exit. `DaoLaunchKit` calls it with the lock, or
  with zero for a teamless raise; `ContributorKit` calls it with zero; both read `lockGuardSet` back. A DAO made without
  a kit keeps today's behaviour until it chooses.
- **Shares are burned only by their owner leaving.** `Shares.burnFromMoloch` (and `Loot.burnFromMoloch`) accept a burn
  only while the DAO is inside `ragequit`: `ragequit` sets a transient flag (as D76's award flag, `leaving()`), and the
  burn requires it. `ragequit` only ever burns from `msg.sender`, so no vote can burn a holder's Shares. Burns that are
  meant to happen are unaffected: forfeits and upheld late objections go through `burnForfeited`, which only the lock
  can call. A teamless or contributor DAO has no such path, so in those DAOs nobody's Shares can be burned except by
  their owner.

Both are a few bytes (the flag in `ragequit`, a `require` in two burns, a bool in `Shares`). After them, the only way a
holder's exit can shrink is the money leaving the treasury by a passed vote, which is the governance the product
describes, and the holder's own notice of at least three days to leave first.

**Tests**: through both kits, a passed vote to set a lock guard reverts (including after a launch that chose none); a
passed vote to burn a holder's Shares reverts; a holder can still leave, and a forfeit and an upheld late objection
still burn. New invariant: "a holder's free Shares fall only by their own transfer or their own exit". Mutations: the
burn flag check removed; the guard settable twice.

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
the kit if it fits with at least 500 bytes left. (Built differently: see "Built" above. The lock factories moved out of
the kit's creation code instead, and the checks stayed in the kit.)

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
  now with `yearBase` = **the Shares that count when someone leaves** (Shares outside the DAO, less what the lock still
  holds: the same total as D72's exit) and `issuedThisYear = 0`; then `issuedThisYear += amount` and
  `issuedThisYear × 10,000 ≤ yearBase × issuanceCapBps`, or the award reverts.
- What the cap therefore protects, precisely: new Shares can lower each existing Share's part of the treasury by at most
  1 − 1/1.1 ≈ 9.1% in a year (about 17% over two). It does not cover unlocks, which lower it too, by design and on a
  schedule the page shows milestone by milestone. A first version measured the cap against all Shares outside the DAO,
  locked ones included; with 65 backer Shares and 35 locked, 10 new Shares would have cut each Share's exit value by
  13.3%, more than "10%" suggests (§0a).
- Launch-time Shares are not counted: `Shares.init` mints with `_mint`, not `mintFromMoloch`, and the rule is set by
  the DAO's initialization calls after it.

**In `Loot`** (built as: Loot refuses to mint while its DAO's Shares have the rule on, so no call is needed):
`closeMinting()`, `onlyDAO`, set once; after it `mintFromMoloch` reverts. The kits call it at birth, so
no Loot ever exists in these DAOs. (`convertLootToShares` then has nothing to convert; an award with `convert` set
fails, which the app never sends.) The trading note's later idea of turning Shares into non-voting Loot to sell is not
foreclosed by this any more than it is today: no such conversion exists in the contracts and the clones cannot be
upgraded, so it would need new contract code and a migration, or a separate token, either way. Nothing for it is added
now.

**In the patched `Moloch`**: `awardContribution` sets a transient flag around its mint (`tstore` before, cleared
after), and `awarding()` reads it. The flag is set after `consumeContribution` returns and cleared right after the
mint, so the only calls made while it is on are to the DAO's own Shares (or Loot) and, through them, the DAO's own
ownership callback and voting policy: no contract outside the DAO runs while a mint is allowed. Measured with D72: +36
bytes.

**In the kits** (built as a kit constant, `YEARLY_ISSUANCE_BPS = 1000`, so the launch call is unchanged):
`DaoLaunchKit.Params` gains `uint16 yearlyCapBps`, required to be at most 1,000 (10%), set into `Shares` and
`Loot.closeMinting()` in the initialization calls, and read back after the summon.

**Choices made here, which you may want to see**: the year is a fixed window from the first new Share, not a rolling
twelve months (no history to keep). So 10% at the end of one year and 10% at the start of the next is possible, which
the page says ("at most 10% in each year since the first award"). The base is the Shares that count when someone
leaves, so the cap is a cap on what new Shares take from an exit. `Shares` reads the lock's `totalLocked()` (D72) for
it.

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

**The change, in `Shares`** (built as one call, `lockTransfersWithNotice(exempt)`, which locks, names the exempt address
and turns the notice on, once): `address public transferExempt`, set once by `setTransferExempt(address)` (`onlyDAO`), and
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

**Lifting the lock: 30 days' notice, in the contract.** Opening a market stays the project's decision, but a holder who
disagrees must have time to leave first, and a raw proposal must not be able to skip that (§0a). So, once the lock is on
in a DAO made by a kit, `Shares` lifts it in two steps:

- `announceTransferUnlock()` (`onlyDAO`, a passed vote) records the time; `cancelTransferUnlock()` withdraws it;
- `setTransfersLocked(false)` succeeds only 30 days or more after an announcement still standing. Locking again is
  immediate. The 30 days are a constant, not a setting.

The kit turns this on with the lock (`setTransfersLocked(true)` plus a set-once `unlockNoticeRequired`), so the patched
DAO's `setTransfersLocked(bool, bool)` keeps its signature and simply fails early. Loot is closed (§4) and has no
holders, so it needs no notice.

**What the contract enforces, and what stays app policy.** The contract enforces: transfers locked from birth, the
auction the only exemption, 30 days between announcing and lifting. The rest of the trading bar (an audited venue, a
legal read, a track record, mainnet) cannot be checked by a contract. The app offers "Open trading" as its own decision
kind only when they are met, and the Powers card says plainly that a vote could still announce an unlock without them,
and that holders would then have 30 days to leave. The `market seed` command line path (D14) cannot run while Shares are
locked.

**Tests** for the notice: lifting without an announcement, or 29 days after one, reverts; 30 days after succeeds; a
cancelled announcement does not count; locking again is immediate.

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
passed vote reverts, an award still mints. The kit also sets the lock guard to "none" for good (§2a).

**What it is, and what it is not.** It is a limit at the start: it keeps a founder from beginning with an outsized
stake. It does not make contributors the majority: the budget it is measured against may never be awarded, and the
founder still decides alone until enough of it is. So founder-led governance stays an accepted dependency of a
contributor project until ownership actually spreads, and the Start page and the Contributions tab say so in those
words. The rule that contributors must also agree to larger changes (option 3 of the proposal's §6) is what would
change that, and is still to be written up.

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
- DAOs not made by the kits (the raw summon) keep upstream behaviour except for the removed functions and the burn rule:
  no issuance rule, no transfer lock unless they vote one.

What stays true after all of it, and stays on the pages: a passed vote can still commit or spend the treasury (the
holder's protection is at least three days' notice and the exit, now permanent); who owns what and how everyone voted is
public on the chain; and the currency's issuer can block payments to an address (the contracts keep that money for its
owner, D67, D68, but cannot make the issuer release it). The launch order is unchanged: the social MVP, then contributor
projects, then the audited raise.

## 9. The audit scope after this

| File | Change |
|---|---|
| `src/majeur/MolochPatched.sol` (`Moloch`) | seven functions removed; `ragequit` subtracts what is locked and sets the leaving flag; the award flag. Smaller than today |
| `src/majeur/MolochPatched.sol` (`Shares`, `Loot`) | the issuance rule, the award-only mint and transfer-out, the transfer exemption and the 30-day unlock notice, the guard decided once, burns only while leaving; Loot's closed minting |
| `src/MilestoneChallenge.sol`, `src/MilestoneLock.sol` | the `totalLocked` counter |
| `src/DaoLaunchKit.sol` | the launch checks, the issuance and transfer initialization; the lock factories become constructor arguments |
| `src/ContributorKit.sol` (adjacent) | two checks, two setup calls |

AUDIT-SCOPE.md §6 item 4 (the vote-granted share sale, permits and allowances) is resolved by removal. The invariants
grow from 12 to 17 (`totalLocked`, award-only issuance, the yearly cap, the transfer lock, free Shares fall only by
their owner's own action); invariant 3 is rewritten.
LBAMM and the market contracts stay out. The freeze tag comes after all of it.

## 10. The order of the work

1. The removals (§2) and the two exit protections (§2a): the suite, the fork checker, the invariants and the
   simulation with the doors gone.
2. D72 (§1): the counter, the subtraction, the exit preview, invariant 3.
3. D76 (§4): `Shares`, `Loot`, the flag.
4. D77 (§5): the exemption.
5. D74, D75 and D79 (§3, §6): the kit checks, measured against the 2,644 bytes.
6. The app (§7): planner, presets, sale line, exit preview, allowance, pledge, copy, journeys.
7. All gates again: `forge test` with `REQUIRE_CONTRACT_ARTIFACTS=1`, the invariants, the mutation check with its new
   entries, `scripts/simulate-raise.sh` with three seeds, the journeys, the size test; then a DECISIONS update per step
   and the freeze tag in AUDIT-SCOPE.md.

Each step starts with a test that fails on the code before it, as D67–D70 did.
