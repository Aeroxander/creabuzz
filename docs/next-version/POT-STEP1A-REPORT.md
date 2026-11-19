# Step 1a report: the money contracts of the join-and-leave design

Branch `v6`, 19 November 2026. Build step 1 of `docs/next-version/JOIN-LEAVE-DESIGN.md` section 8 (the contracts, play dollars, the
deploy script and the chain loop), built in three passes: A (tokens, play dollars, the Treasury), B (Team Shares, Vester, forfeit,
Pair, Launcher, wind-down, agents) and C (invariants, fuzz, vectors, deploy script, chain loop, this report). Everything is in
`contracts/pot` (a new Foundry project; `contracts/next` is untouched, so the server and app that read it stay green), plus
`scripts/pot-chain-loop.sh`. Nothing is pushed, and no network has these contracts. This is not legal or tax advice, and no figure
here is a promise of any result for anyone.

**Status.** Everything in the scope of step 1 is built and green: `forge build`, `forge test` (310 tests in 30 suites passed, 0 failed), the vector test, the
mutation check (24 deliberate changes, 24 caught) and the chain loop (17 checks, run on the real bytecode). Pass C found and fixed one defect in the
contracts (section 4). Commits (pass C): `00382c01a` (the credit fix), `a5e9ea231` (invariants, fuzz, must-bind, rebuild, gas), `5b0b09873` (vectors and the mutation check), `1df69799f` (deploy script, loop, README), and the commit that adds this report; passes A and B are `13dafac86`, `a39354ff9`, `4c20f5089`, `7e3722f22`, `d11d039e4`, `166ad745e`.

## 1. What is built

| Part | Where | What |
|---|---|---|
| Treasury | `src/Treasury.sol` | pot, Back (`join`, also `onTransferReceived` for a one-signature join), Take out (`leave`), `leaveTeam`, quotes (`quoteBack`, `quoteTakeOut`, `feeFor`, `leaveValue`, `teamValue`), settle, the daily allowance with its box and seven-day cap, check-in with a record hash, rate propose / apply / lower, outside money through the arriving stream, the door, platform fee owed and collected, wind-down (by choice, or by anyone after 26 quiet units), agents inside daily limits, hand over / take the seat |
| Vester | `src/Vester.sol` | the Team pool, grants with a cliff (13 units) inside 104 units of active-time vesting, claim, forfeit with a notice of one unit, protected grants (exist, no step 1 path makes one), the burns after a wind-down |
| ShareToken | `src/ShareToken.sol` | two instances: backer Shares and Team Shares; only the Treasury mints and burns a holder's own tokens |
| Pair | `src/Pair.sol` | two signers for every money call, either signer may check in, no one-signer spend lane |
| Launcher, Parts | `src/Launcher.sol`, `src/Parts.sol` | birth with rate and Team pool and the settings-hash commitment, Pair, wind-down forwarder, platform settings |
| PlayDollar | `src/PlayDollar.sol` | test network only: faucet (1,000 once per account), `transferAndCall` |
| Formulas | `src/PotMath.sol` | the integer formulas shared by quotes and actions |
| RollingCap | `src/RollingCap.sol` | copied unchanged |
| Deploy script | `script/DeployPot.s.sol`, `DEPLOYMENTS.md` | PlayDollar (or a given dollar), Parts, Launcher; N from `UNIT` (default 7 days); no key in any file |
| Chain loop | `scripts/pot-chain-loop.sh` | anvil, deploy, the whole loop with `cast`, numbered PASS lines |
| Model and vectors | `contracts/pot/model/` | the exact-decimal model (copied), its extension, the generator, `vectors.json` (52 scenarios, 1,805 operations) |

Not built (step 2, as decided): the task queue, notice, take, accept, return, exit notes. In step 1 a task is paid by `draw()`
from the box. Storage leaves room: `locked` and `notesOwed` are declared (always zero, counted in `unaccounted()`), the `note`
fields of `Left` and `TeamLeft` are zero, and step 2 appends its fields after the marked line in the Treasury's storage.

## 2. Measured

**Contract lines** (`src/`, measured by counting; "code" = not blank, not a comment):

| File | Lines | Code lines |
|---|---|---|
| `Treasury.sol` | 788 | 557 |
| `Launcher.sol` | 311 | 200 |
| `Vester.sol` | 299 | 195 |
| `ShareToken.sol` | 122 | 76 |
| `Pair.sol` | 120 | 71 |
| `PotMath.sol` | 97 | 51 |
| `Interfaces.sol` | 79 | 38 |
| `PlayDollar.sol` | 53 | 29 |
| `RollingCap.sol` | 46 | 25 |
| `Parts.sol` | 29 | 15 |
| **`src/` total** | **1,944** | **1,257** |

Also: `script/DeployPot.s.sol` 92 lines; the tests (37 Solidity files with helpers and mocks) 6,444 lines, 5,476 of code;
`model/pot_ext.py` 236, `model/gen_vectors.py` 472, `scripts/pot-chain-loop.sh` 270, `scripts/check-mutations.py` 139. The design
estimated about 2,100 lines for all contract code including the parked 810; step 1 is 1,257 code lines (the Treasury 557 against an
estimate of about 800).

**Runtime sizes** (`forge build --sizes`; the limit is 24,576): Treasury 17,645 (6,931 to spare), Vester 7,300, Launcher 6,238, PlayDollar 3,497, ShareToken 2,823, Pair 2,186, Parts 358 (its creation code, which holds the four implementations, is 30,789 against the 49,152 limit).

**Tests.** `forge test` in `contracts/pot`: **30 suites, 310 tests passed, 0 failed, 0 skipped** (fuzz tests 1,000 runs each unless stated;
the invariants 256 runs of 200 steps, 51,200 steps each; the 200-holder runs 8 to 12 runs). Pass A left 155 tests, pass B 274, pass C
adds 36 and ends at 310. Per suite: Agents 14, Allowance 25, EmptyJoin 3, Events 7, EventsRebuild 1, Fees 5, Forfeit 15, Gas 5,
Join 30, Launcher 17, Leave 11, LeaveTeam 7, ModelVectors 13 (a completeness check and 12 chunks of five scenarios), MustBind 3,
Pair 16, PlayDollar 7, PotFuzz 3, PotInvariants 8, PotMath 8, Quiet 11, Reentrancy 3, Revenue 15, ShareToken 10, Team 4,
Treasury 19, Vester 9, VesterFuzz 1, VesterUnit 25, WindDown 11, Worked 4. `forge fmt --check` is clean.

**Invariants** (`test/PotInvariants.t.sol` with `test/helpers/PotHandler.sol`, 256 runs of 200 steps each, 8 invariants): the
handler drives joins, take-outs, Team take-outs, outside payments arriving, grants, vesting (active time), own-exit forfeits and
their burns, draws by the runner and by an agent, rate changes, check-ins, lapses of up to 400 days, a wind-down, fee collection and
a full-exit probe, from six actors. Checked: dollars held always cover the buckets, and (no donations) equal dollars in less
dollars out exactly; B and G equal the sum of token balances (the Treasury stores neither); paid-in is zero with no backers and
never above what joins credited; the box is within its cap after every step; Z is exactly the announced, unburned grants and
within G; the Vester always holds what it owes; Team Shares are never created after birth. And, inside each step, the rules
that need a before and an after: no step but time (the allowance) or a fee lowers a backer Share's worth by more than one unit;
the Team never reaches backers' paid-in money; a joiner who leaves at once gets no more than they paid after the fee, beyond what
the quote offset allows; earlier holders lose on a join no more than that allowance; a full exit of everyone in a shuffled order
pays each backer what the first would have been paid, to within the rounding of the run, and never more than the pot held.
`test/PotFuzz.t.sol` adds the formulas against a plain reference, a join-then-leave round trip from a random state, and 40 runs of
120 random steps of every kind. `test/EventsRebuild.t.sol` replays 400 random steps and checks, after each, that a ledger built
from the Treasury's and the Vester's events alone holds the same pot, paid-in, Shares, Team Shares, burn queue, box, arriving
money, active seconds and fees owed as the contracts.

**Vectors** (`test/ModelVectors.t.sol`, `model/vectors.json`): 52 scenarios (32 fixed: the two worked examples of 2.1 and 2.2,
the later-joins run, nine sandwiches, four honest leavers while money arrives, early joiners, round trips, cyclers, 40 holders
leaving in a shuffled order, the allowance (rate lowered, raised after a unit, a lapse), the ceiling, a 60-day lapse, two payments
merging, the Team surplus, a forfeit, outside money before the first backer, and the Team's leftover; and 20 seeded mixed runs), 1,805 operations, 17,201 numbers compared after the
real calls. The worst deviation is 24% of its stated allowance (a first join of 2,000.0007 dollars whose platform fee
rounds by one unit, a part in 2e9 of the Shares it mints). Tolerance, in the test header: `4k` dollar units (`8k` wei for Shares)
after `k` operations plus the same relative term of `4k` over the smallest money in the quote while there were backers, or the
smallest join. The Treasury's own quote equals what the action then gives, exactly, in every vector. No vector is excluded.
The test fails if a formula changes: `scripts/check-mutations.py` changes 16 formulas one at a time in a scratch copy and each
makes the vector test fail (section 2, mutation check).

**Mutation check** (`contracts/pot/scripts/check-mutations.py`; 24 single changes, each must fail its tests): **24 run, 24 killed, 0 survived** (the first run left two alive, the announced burn in the join price and the first-backer credit: no vector had a surplus with a forfeit, or money before the first backer; two scenarios were added and both are now killed).

```
offset-dollar          KILLED  (ModelVectors.t.sol: the virtual dollar in the quote)
offset-shares          KILLED  (ModelVectors.t.sol: the virtual Shares in the quote)
quote-team             KILLED  (ModelVectors.t.sol: the surplus shared with Team Shares in the price)
cash-team              KILLED  (ModelVectors.t.sol: the surplus shared with Team Shares in a take-out)
teamcash               KILLED  (ModelVectors.t.sol: a Team take-out)
paid-in-cut            KILLED  (ModelVectors.t.sol: what leaves paid-in on a take-out)
fee                    KILLED  (ModelVectors.t.sol: the platform fee)
credit                 KILLED  (ModelVectors.t.sol: paid-in credited on a join)
accrual                KILLED  (ModelVectors.t.sol: the allowance accrual)
box-cap                KILLED  (ModelVectors.t.sol: the seven-day box cap)
release                KILLED  (ModelVectors.t.sol: the outside money release)
merge                  KILLED  (ModelVectors.t.sol: the weighted-average arrival of two payments)
window                 KILLED  (ModelVectors.t.sol: the two-unit check-in window)
z-in-quote             KILLED  (ModelVectors.t.sol: the announced burn in the join price)
empty-credit           KILLED  (ModelVectors.t.sol: the slice a first backer pays for money already in the project)
vesting                KILLED  (ModelVectors.t.sol: the 104-unit vesting length)
leave-cut              KILLED  (PotInvariants.t.sol: paid-in is not cut on a take-out)
team-takes-paid-in     KILLED  (PotInvariants.t.sol: Team Shares reach backers' paid-in money)
box-over-cap           KILLED  (PotInvariants.t.sol: the box is not cut back to its cap)
fee-not-owed           KILLED  (PotInvariants.t.sol: the platform fee is not booked)
draw-keeps-box         KILLED  (PotInvariants.t.sol: a draw does not empty the box)
full-credit            KILLED  (PotInvariants.t.sol: a join is credited its whole payment as paid-in)
late-settle-checkin    KILLED  (MustBind.t.sol: a check-in that writes the window before it settles)
burn-anyone            KILLED  (ShareToken.t.sol: anyone can burn another's Shares (the burn authority))

24 mutations run, 0 survived
```

**Chain loop** (`scripts/pot-chain-loop.sh`, real bytecode on anvil, N = 7 days, run on 19 November 2026):

```
PASS 01  deployed PlayDollar 0x5FbDB2315678afecb367f032d93F642f64180aa3 and the Launcher 0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0 (time unit 604800 seconds, platform fee 2%)
PASS 02  launched a project: Treasury 0x75537828f2ce51be7289709686A69CbFDbB714F1, Shares 0xE451980132E65465d0a498c53f0b5227326Dd73F, Team Shares 0x5392A33F7F677f59e833FEBF4016cDDD88fF9E67, Vester 0xa783CDc72e34a174CCa57a6d9a74904d0Bec05A9, rate 0.10% a day, Team pool 10,000,000
PASS 03  the stranger took 1,000 play dollars from the faucet, and the faucet refused a second time
PASS 04  backed with 100 play dollars in one transaction (transferAndCall, 225516 gas): got 9800000000000000000000 wei of Shares = the quote; pot 98, fee 2
PASS 05  a second backer put in 50 with approve then join (134108 gas) and got 4900000000000000000000 wei of Shares, the quote within a part in a million (the pot moves a unit a second)
PASS 06  the founder checked in with a record hash; the window is open (door open: true)
PASS 07  after 5 days the box holds 735000 (about 5 x 0.10% of 146265000; cap 1029000); drawing one unit more than the box is refused
PASS 08  the founder drew exactly the box (735000 units) from the allowance
PASS 09  500 dollars of outside money were added: it sits in 'arriving' and half (250000000 units) was in the pot after half a time unit
PASS 10  after one time unit all 500 dollars have arrived: arriving 0, pot 644367915
PASS 11  a grant of 1,000,000 Team Shares has vested nothing after 12 time units of active time, and a claim is refused
PASS 12  after the 13-unit cliff 125000015898453398453398 wei of the grant (12.5%) vested and was claimed to the member
PASS 13  two time units without a check-in: the door is shut (a join is refused) and 10 more days add nothing to the box (4523855) or to active time
PASS 14  the member took out half their vested Team Shares and got 3087593 units = n x (pot - paid-in) / (B + G): only the surplus; paid-in is untouched
PASS 15  the stranger took out ALL their Shares while the project is quiet (107330 gas): paid 98484155 units = quoteTakeOut (98484155), more than the 98 paid in
PASS 16  the last backer took out too (97742 gas): paid 49242417 = the quote; no Shares and no paid-in are left
PASS 17  dollars are conserved: the Treasury holds 498450835 units and owes exactly that; the platform collected its fees (3: 2% of 150 paid in)

pot-chain-loop: 17 checks passed.
gas (real receipts): back by transferAndCall (first backer) 225516; back by approve + join (second backer) 134108;
                     take out (others remain) 107330; take out (last backer) 97742
```

**Gas.** From real receipts on a local chain (the whole transaction): back by `transferAndCall` with no other backer 225,516;
back by approve then `join` with another backer 134,108; take out with others remaining 107,330; take out as the last
backer 97,742. Measured inside the call with cold storage (`test/Gas.t.sol`, not counting the transaction's own 21,000
and calldata): join with another backer 142,123 (approve path); leave a quarter 129,570; leave the rest with others remaining 83,406; leave Team Shares 126,354; draw 97,162; check in 22,927; settle after two days 32,855; add outside money 81,283; grant Team Shares 192,728; claim 96,271.

## 3. The must-bind tests of design section 6

Numbers 1, 4 and 8 wait for step 2 (serial notes, the 28-day cap on takes, a part-paid accept): there is no task queue yet.

| # | The rule | Where it is bound |
|---|---|---|
| 2 | A 60-day lapse then a check-in grows the box by no more than the time inside the old window | `MustBind.test_no2_aLapseThenACheckInGrowsTheBoxByTheOldWindowOnly` (real stack; at the ceiling a late settle would fill the cap); `Allowance.test_checkInSettlesBeforeItMovesTheWindow`, `Allowance.testFuzz_idleThenCheckInGrowsTheBoxByAtMostTheTimeInsideTheOldWindow`; mutation `late-settle-checkin` breaks it |
| 3 | With the quote offset on, a run pays first and last leaver the same | `MustBind.testFuzz_no3_aRunAfterRealSpendingPaysFirstAndLastTheSame` (200 equal holders, the pot really spent to about 60% of paid-in by the allowance, shuffled order: per Share the first and last differ by at most one unit, the cash of any two by at most 8 units); `Leave.testFuzz_aRunPaysFirstAndLastTheSame`; the handler's full-exit probe |
| 5 | A join, outside payment and take-out in one block nets -2.00 per 100 | `Revenue.test_theSandwichNetsOnlyTheFee`, `Revenue.test_theSandwichWithATeamPoolNetsOnlyTheFee` (payments of 10, 25 and 50% of the pot, joiners of 0.1, 1 and 3 times the pot); nine vector scenarios `sandwich-R*-W*` |
| 6 | A forfeit's join price counts it as burned | `Forfeit.test_aForfeitsJoinPriceCountsItAsBurned`, `Treasury.test_aJoinIsPricedWithTheAnnouncedBurnTakenOut`; mutation `z-in-quote`; vector `forfeit` |
| 7 | Later joins give the Team nothing | `Team.test_laterJoinsGiveTheTeamNothing`, `Worked.test_worked_laterJoinsGiveTheTeamNothing`; vectors `later-joins-10M` and `later-joins-100M` (the Team take-out must revert as paying nothing) |
| 9 | Only the holder's own `leave` can burn | `ShareToken.test_onlyControllerBurns`, `ShareToken.test_noPublicBurnOrBurnFromSelector`, `Forfeit.test_onlyTheTreasuryMintsOrBurnsAndNobodyBurnsAnothersShares` (every token function tried as the Treasury, the Vester, the runner and a stranger), `Leave.test_onlyTheCallersOwnSharesAreBurnt`; mutation `burn-anyone` |
| 10 | Dollars are conserved | `MustBind.test_no10_dollarsAreConservedExactly` (ghost sums), invariants `everyDollarIsInOneBucket` and `theTreasuryHoldsAtLeastWhatItOwes` over 51,200 steps each, `Treasury.test_dollarsAreConservedThroughAMixedScript`, the loop's last check |

Also bound, beyond the list: the vectors (above); every guard of passes A and B was removed one at a time in a scratch copy (41 and
63 changes, all killed or fixed, in their reports).

## 4. What pass C found

1. **A first backer into a project that already held money was credited too much (a defect; fixed).** The invariant run found a
   sequence: outside money paid in before the first backer (or the Team's leftover after the last backer left), then a first join.
   The price charges the joiner for a slice of that money (it is surplus the Team Shares own), but the credit gave the joiner the
   whole payment as paid-in, so taking out at once paid back the payment *and* the slice (in the found run about 5,600 dollars of a
   6,400 dollar leftover, on a join of about 980,000 dollars, taken from the Team). Fix: with no backers the credit is the payment less the price of
   that slice, `n x (pot + arriving) / (100 virtual Shares + Team Shares counted)` rounded up (`PotMath.credit`, one added
   argument set). With nothing in the project the slice costs nothing, so a pristine first join still counts 98 of 100 as paid-in.
   Regression tests: `EmptyJoin.t.sol` (three), the handler's round-trip rule, mutation `empty-credit`. This changes a number the
   plan's item 2 had accepted ("a first join into leftover money pays face for it"): it did pay face in the price, and then was
   given the face back.
2. **The price a joiner is quoted is not monotone on a join (the plan's invariant "the quote value never falls on a join" does not
   hold exactly).** The quote adds one virtual dollar to paid-in and 100 virtual Shares; the credit uses the real paid-in per Share. On
   a join with a credit below the payment the quoted price can dip, by about a part in 1e13 with 76 million Shares, about 6e-4 at one
   million Shares, and by tens of percent with a few hundred Shares and a join much larger than the pot (a search over random states).
   It does not hurt holders: what the plan's item 6.1 bounds is the holders' total value, and the invariants check that bound (earlier
   holders lose on a join at most 100 Shares' worth less one dollar) and that a joiner who leaves at once gets no more than they
   paid after the fee plus the same allowance. The test checks those two instead of the price.
3. **Sequential leavers see the box flow back.** The allowance box above its cap returns to the pot at the next settle, and every
   take-out shrinks the cap, so in a run of take-outs the later leavers are paid slightly more: a part of the box has come back.
   This is by design (the plan's item 6) but it breaks a naive "everyone is paid what the first was" check, so the full-exit probe
   sets the rate to zero first and compares from there.
4. **The plan's "to the unit" for first and last leaver** holds per whole Share (at most one unit); the totals of two equal holders
   differ by at most 8 units, the rounding dust of 200 floors that all lands on the last leaver (pass A had measured this).
5. **A mutation not killed at first (builders' sweeps)** is in their reports; pass C's own 24 changes are all killed (above).

## 5. Choices made under the owner's standing go (the owner may overrule)

Pass A (the Treasury): the box cap is seven days of accrual on pot and box together, not on the pot alone (so a second settle in
the same second moves nothing); `Settled.toBox` may include money the same settle returns as `backToPot`; `onTransferReceived`
refuses a third party's transfer (operator must be the sender), data other than exactly 64 bytes, and money not yet accounted;
`quoteBack` returns `(shares, takeOutNow, lockedLine, arrivingLine)` and the fee is the separate view `feeFor`; `quoteTakeOut`
returns zeros for more than the holder holds; a third Vester hook `burnAfterWindDown`; the Treasury itself demands both signers when
the runner is a Pair; `takeSeat` is not reentrancy-guarded (the Vester's trim calls the guarded hooks); after a wind-down check-in,
rate changes revert and a draw reverts as too much (the box is zero) while take-outs, outside money and fee collection work; the
solc `at` keyword warning avoided with `time`, while `leave` (the design's name) gives a warning only; zero cash on a take-out
reverts `NothingToPay`; a Team pool of 0 is accepted; the quote-offset bound is tested as a dollar bound, not per Share.

Pass B (Team and the rest): `launch(projectId, name, symbol, Terms{ratePpm, teamPool}, expectedSettingsHash)`; the platform settings
(`quote, platform, feeBps, unit, agentUsd`) are what the hash covers; the door and hand-over stay in the Treasury; vesting is 104
units linear with the 13-unit cliff inside it (own exit and a wind-down by choice keep what has accrued, both-signer forfeit and a
quiet wind-down keep what has vested); one notice period of N for a forfeit (announce sets Z and `burnAt` together; Z is one number
in the Treasury, `burnAt` per grant); no automatic grant to the founder at birth; eight grants per member for life; the ungranted rest
of the pool also burns after a wind-down; the protected grant exists in the Vester but no step 1 call can make one; an agent may grant
itself Team Shares inside its pool/1000 daily limit; `Pair.initialize` no longer checks the launcher address (a caller can name
itself; the protection is clone-and-initialise in one transaction).

Pass C:
1. The credit rule for a first backer into existing money (section 4.1), the one change to the contracts.
2. The quote price is not asserted monotone; two bounds on holders' value and on a round trip are (section 4.2).
3. Vector tolerance as stated in the test header; scenarios use real Team grants vested over 104 units, and force a pot and paid-in
   by storage writes only for the two worked examples; a generated outside payment whose arrival end sits within a few units of a
   whole second is dropped rather than loosening a bound.
4. The full-exit probe removes the allowance box first (section 4.3).
5. The deploy script's defaults (platform fee 2%, agent limit 25 dollars, platform and admin = the sender) and the loop's real
   N = 7 days; in the loop a second backer's quote is checked to a part in a million (the pot moves a unit a second), and the exact
   equality of quote and result is checked where time cannot move it (the first backer, and the take-outs while quiet).
6. Gas is reported as real receipts plus in-call measurements with cold storage.
7. The reference outputs in `model/` are copied files; `pot_ext.py` re-implements the contracts' rules a second time in Python, so a
   vector binds the contracts to that second reading of the design, written independently of the Solidity.

## 6. Not done

- The step 2 parts: task queue, notice, take, accept, return, exit notes, and the three must-bind tests 1, 4 and 8.
- The server and the app do not read these contracts yet (steps 1b to 1d); no network has them.
- The protected grant (earlier backers' Team Shares) has no Treasury or Launcher path; it is for step 4 and counsel.
- Counsel's questions of the design's section 12 are untouched.
- Invariants run with an EOA runner; a Pair as the runner is covered by unit tests (`Pair`, `Treasury`, `Agents`), not by a
  second handler.
- Fork tests, a gas-optimisation pass and an external audit.

## 7. What the server (events and views) and the app (calls and quotes) must use next

**Events to read** (Treasury, Vester, Launcher; every state change carries the resulting state, so a reader rebuilds without redoing
the math; `test/EventsRebuild.t.sol` is the executable recipe):

- Launcher `ProjectLaunched(key, projectId, founder, Project{founder, shares, team, treasury, vester, launchedAt}, Terms{ratePpm, teamPool}, Platform)`, `PairMade`, `WoundDown`, `SettingsChanged`, `AdminChanged`. The Team pool at birth is `Terms.teamPool`; the Treasury's `unit` is `Platform.unit`.
- Treasury: `Joined(who, to, paid, fee, shares, credit, potAfter, paidInAfter, sharesAfter)`, `Left(..., note, potAfter, paidInAfter, sharesAfter)`, `TeamLeft(..., potAfter, teamAfter)`, `AllowanceDrawn(by, to, amount, boxAfter)`, `RateProposed`, `RateSet`, `CheckedIn(by, recordHash, time)`, `RevenueAdded(from, amount, arrivingAfter, arrivalEnd)`, `RevenueReleased`, `DoorSet`, `WoundDown(kind, by, time, boxReturned)`, `FeesCollected`, `BurnAnnounced(amount, zAfter)`, `SeatOffered`, `RunnerChanged`, `AgentSet(agent, active, usdCap, shareCap)` (the shape the app's agent screen already reads).
- `Settled(toBox, backToPot, released, potAfter, boxAfter, arrivingAfter, activeSecondsAfter, time)`: without it pot, box, arriving money and active time cannot be rebuilt, because the allowance and the release move money inside any call.
- Vester: `GrantMade(id, member, amount, startActive, kind)`, `ForfeitAnnounced(id, member, amount, byMember, burnAt, zAfter)`, `Forfeited(id, member, burned, zAfter, teamAfter)`, `GrantClaimed`, `UngrantedBurned`. Vesting is `GrantMade.startActive` against `Settled.activeSecondsAfter` (plus the active slice since the last `Settled`: up to the last check-in plus 2N).
- Pair: `Proposed`, `Executed`, `Cancelled`. PlayDollar: `Transfer`, `Approval`, `Faucet`. The share tokens: `Transfer`, `Approval` (holders' lists).

**Views for the record** (the new `numbers` record, version 2): Treasury `pot`, `paidIn`, `box`, `boxCap`, `arriving`, `arrivalEnd`, `feesOwed`, `ratePpm`, `pendingRatePpm`, `pendingAt`, `lastCheckIn`, `activeEnd`, `activeNow`, `activeSeconds`, `doorOpenNow`, `windDownKind`, `windDownAt`, `Z`, `runner`, `leaveValue` (cash for one whole Share), `teamValue`, `unaccounted`, `agents`, `agentUsdUsed`, `agentTeamUsed`; Vester `grantCount`, `grantOf`, `idsOf`, `vestedOf`, `accruedOf`, `claimable`, `committed`; Launcher `project`, `projectByKey`, `settingsHash`, `platform`, `keyOf`, `pairAddress`, `isPair`. B and G are the two tokens' `totalSupply()`: read them, do not store them.

**Calls and quotes for the app:**

- Back in one signature: `PlayDollar.transferAndCall(treasury, amount, abi.encode(minShares, to))` (`to` zero means the payer; exactly 64 bytes; the sender's own money only). Otherwise approve then `Treasury.join(amount, minShares, to)`. Before it, `quoteBack(amount)` returns `(shares, takeOutNow, lockedLine = 0 until step 2, arrivingLine)`; `feeFor(amount)` is the platform's part; show "what you would get if you took out now" from `takeOutNow`. The minimum is 1 dollar; the door can be shut: read `doorOpenNow()` first.
- Take out: `quoteTakeOut(holder, n)` returns `(cashNow, note = 0, arrivingLeftBehind)`, then `leave(n, minCash, to)`. It always works (door shut, quiet, wound down) and is paid from the pot only: not the box, not money still arriving. Team Shares: `leaveTeam(n, minCash, to)`; it pays only above paid-in.
- Runner: `checkIn(bytes32 recordHash)` (the record signed first), `draw(to, amount)`, `setRate(ppm)` (lower, at once), `proposeRate(ppm)` then anyone `applyRate()` after one unit, `setDoor(open)`, `grantTeam(member, amount)`, `setAgent`/`authoriseAgent`/`revokeAgent`, `handOver`/`takeSeat`, `Launcher.windDown(key)`. A Pair runner needs both signers for each of these except `checkIn`; the app's confirm sheet needs a sentence for each call.
- Member: `Vester.claim(id)` (anyone may call, the Shares go to the member), `Vester.announceForfeit(id)` (own exit), `Vester.execute(id)` (anyone, after the notice).
- Outside money: `approve` then `addRevenue(amount)` (at least 1 dollar), anyone. Fees: `collectFees()`, anyone.
- Launch: read `Launcher.settingsHash()` and pass it to `launch(...)`.
- Errors the app must put in words (custom errors, selectors in the ABI): `DoorShut`, `BelowMinimum`, `ZeroMint`, `TooFewShares`, `TooLittleCash`, `NothingToPay`, `TooMuch`, `NotAllowed`, `NotYet`, `AlreadyWoundDown`, `TooManyShares`, `TokenMisbehaved`, `BadInput`.

## 8. How to run it again

```bash
cd contracts/pot
forge build --sizes && forge test                      # all tests, vectors and invariants included
bash scripts/check-vectors.sh                          # the vector file is what the model says
python3 scripts/check-mutations.py                     # 24 deliberate breaks, each caught
bash ../../scripts/pot-chain-loop.sh                   # the loop on a local chain (anvil, cast, forge, jq)
```
