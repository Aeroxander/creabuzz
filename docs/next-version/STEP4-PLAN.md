# Step 4 plan: the holder pause (milestone 9 in the new model) and earlier grants

Status: a plan. **Nothing in it is built.** Written 21 November 2026 on branch `v6` at `1fed95002`, under the owner's standing
go (keep working, no questions); the owner may overrule any choice in section 7. It builds what two rounds of the design
left open: W1, the holder pause (the fallback the design names for counsel's question 4), and W2, the earlier backers'
protected grants (design section 6, choice C21). It adds server and app parts for both. It changes no existing money rule:
**with the pause switch off and no earlier-grant settings, every contract behaves as verified at `1fed95002`** (section 1.8
says how that is proved). Not legal or tax advice. No figure here is a promise or a forecast of any result for anyone.

How to read the numbers. **measured** = counted in a file or report in this tree. **arithmetic** = worked by hand or in plain
Python from the contracts' own formulas (not run against contracts; `scratchpad` scripts, not in the repo). **estimate** = my
guess from EVM gas rules or from sizes; the engineer measures and the report says what was measured. **choice (D#)** = a point
I chose; section 7 lists each with its alternative.

## 0. What was read, and what it says

- `docs/PLAN-V2.md`: milestone 9 (`HolderVote`, `Council`, reserve sale; "a third parked pauses payments"), the 18 November
  requirement ("votes count only Shares parked from a person's own wallet", never a Treasury, Vester, claim-contract, Rounds or
  Finisher balance), the "Stop vote backers cannot win" line ("when parked Shares reach a third of free Shares, payments pause 24
  hours later for as long as they stay parked. Nobody votes no") and the earlier backers' paragraph (decision 7).
- `docs/next-version/JOIN-LEAVE-DESIGN.md`: sentence 3 and "three things to know" 2 (there is no vote; counsel's question 4 is
  whether notice plus the right to leave counts as "governance"; the fallback is a holder power), section 2.3 (the box, the caps,
  the notice), 2.4 (Team Shares, protected grants), section 6 (project zero and the earlier backers), section 9 (what is replaced:
  milestone 9 "has nothing to vote on"), section 10, section 12 (counsel's questions 4 and 10) and choices C11 and C21.
  (There is no numbered section 1.5; the page's one-line model is section 1 and the project-zero text is the last part of section 6.)
- `docs/next-version/EARLIER-BACKERS.md`: the old list, text, signing and claim design (now parked in `contracts/next`).
- `POT-STEP1A-REPORT.md`, `POT-STEP2-REPORT.md` and every file in `contracts/pot/src`, `contracts/pot/script/DeployPot.s.sol`,
  `contracts/pot/DEPLOYMENTS.md`, and the built sizes in `contracts/pot/out` (read, not rebuilt).
- `RECORD-V2.md`, the chain reader (`crates/buzz-relay/src/chain_reader/`), the sponsor (`api/sponsor*`), `handlers/task_chain.rs`,
  `handlers/agent_label.rs`, and the app's pot, project, money and earlier folders.

Measured facts that shape every choice below:

| Fact | Value | Source |
|---|---|---|
| Treasury runtime size | **23,577 of 24,576 bytes (999 to spare)** | `forge build --sizes` in the step 2 report; same in `out/` now |
| Parts creation code | **47,707 of 49,152 (1,445 to spare)** | same |
| Vester, Launcher, TaskBook runtime | 7,355; 6,650; 10,369 | same |
| Tests at `1fed95002` | 55 suites, 540 tests, 11 invariants, 124 mutations (123 killed, 1 equivalent) | step 2 report |
| The Treasury's rule | `leave` burns **`msg.sender`'s own** Shares, exit notes are written to `msg.sender` | `Treasury.sol` 375 to 390 |
| Protected grants | exist in the Vester (`grant(member, amount, true)`), **no caller makes one** (the Treasury passes `false`); they start at the grant's own time, not at birth | `Vester.sol` 122 to 141 |
| Passkey account | sends a batch of calls as one operation, one passkey prompt (`sendCalls`) | `PHONE-PATH-REPORT.md` |
| Sponsor | an operation is an "exit", never refused by a limit, only when **every call** is `leave` or `leaveTeam` on a followed Treasury | `api/sponsor/calldata.rs` `is_exit` |
| App entry chunk | 434,834 of 450,000 bytes | phone path report |

Because the Treasury has 999 bytes left and Parts has 1,445, **both features live in new contracts**, and the Treasury and
Vester take only the smallest hooks (section 1.2 and 3.2). Product check (`VISION.md`, `VISION_PROJECTS.md`): neither feature
touches the relay's workspace model; both add power to the people who put money in, which is the direction of the design
("governance and exit"). The one tension, stated: a holder pause is the nearest thing to a vote that the design allows, and the
design's default stays "no vote": **the switch is off in every deployment unless the deployer turns it on**.

---

## 1. The holder pause as a contract design

### 1.1 Shape (the smallest change)

One new contract, **`HolderPause`** (`contracts/pot/src/HolderPause.sol`), one small clone per project, made by the Launcher only
when the deployment's switch is on. Holders **park** backer Shares in it (custody: the Shares move into the contract and the
contract records whose they are); anyone can read whether a third of the backers' Shares are parked; the Treasury asks the
contract one question (`paused()`) before the two things that pause. The Treasury and the Launcher get a few lines each; the
Vester, the ShareToken, the TaskBook, the Pair, Parts and PotMath are not touched by the pause.

Why custody and not a "mark": the ShareToken has no hooks (design: plain token, no call-backs), so a mark on a balance cannot
be kept true. A holder could mark Shares, send them to a second account and mark them again. Custody counts each Share once,
and it is the only reading of "Shares parked from a person's own wallet" (`PLAN-V2.md`, 18 November) that cannot be gamed.

### 1.2 Exactly what changes

| File | Change | Size effect (estimate; measured by K1) |
|---|---|---|
| `contracts/pot/src/HolderPause.sol` | **new**: the clone, about 130 lines | about 2.2 KB runtime |
| `contracts/pot/src/Treasury.sol` | (a) `address public pauseGate;` appended after `arrivalTotal`; (b) `function bindPause(address gate) external` (only `salePath`, once, non-zero) emitting `PauseReady(address gate)`; (c) a private `_notPaused()` that does `if (pauseGate != address(0) && IHolderPause(pauseGate).paused()) revert Paused();`; (d) one call to it in `draw` (after the auth checks and `_settle()`, before any state change) and one in `announceTask` (after `_openWindow()`); (e) `error Paused();` | **+300 to 400 bytes** (999 to spare today) |
| `contracts/pot/src/Interfaces.sol` | `IHolderPause { paused() }` and `bindPause` on a small `ITreasuryPause` | none |
| `contracts/pot/src/Launcher.sol` | `address public immutable deployer; uint64 public immutable deployedAt;` (set in the constructor); `address public holderPauseImpl;` and `bindPause(address impl)` (deployer only, once, within 1 hour of deployment, impl must have code; emits `HolderPauseBound(impl)`); in `launch`, `if (holderPauseImpl != address(0))` clone it, `initialize` it, `Treasury.bindPause(clone)`; `settingsHash()` keeps its old formula when nothing is bound and adds the bound addresses when something is | +about 500 bytes (6,650 today) |
| `contracts/pot/script/DeployPot.s.sol`, `DEPLOYMENTS.md` | `HOLDER_PAUSE` setting (default 0); when 1: `new HolderPause()` and `launcher.bindPause(impl)`; the addresses go into `deployments/pot-<chain>.json` | none |

`Treasury.initialize`, `Setup`, `Launcher.launch`'s signature and return values, `ProjectLaunched`, `Platform`, the constructor of
`Launcher` and every function not named above are unchanged, so every existing test compiles and passes untouched.

**The switch.** `holderPauseImpl == address(0)` is the default and means: no clone is made, `Treasury.pauseGate` stays zero, and
the two checks are one storage read that finds zero. The switch is set once, by the deployer, in the first hour, and can never
change; a project is born with or without a stop and keeps it (D1). (The deployer is an immutable set in the constructor; the
setter is sealed after one call or one hour, so a stolen key later cannot turn it on for new projects.)

### 1.3 The rule, exactly

- **B**, "the Shares that backers hold": `shares.totalSupply()`, the backer ShareToken's supply. It counts every backer Share in
  existence: in wallets, in contracts (a pool, a lender), and the ones parked. It never contains a Team Share, vested or not
  (that is another token), and it is not reduced by any contract's balance (D2: a contract's Shares cannot be told from a
  person's smart account; leaving them in B only makes the line higher, which protects the team).
- **parked (K)**: `HolderPause.parkedTotal`, the sum of what `park` put in and `unpark` has not taken out. Only `park(n)`
  changes it. Shares sent straight to the contract (a donation) are not parked and count nowhere.
- **The line**: `3 x K >= B` and `B != 0`, that is `K >= ceil(B / 3)` (`line()` returns `(B + 2) / 3`). One third, rounded up.
- **Arming and the 24 hours.** `armedAt` is the second the line was first *seen* reached in an unbroken run. `park`, `unpark`
  and the permissionless `poke()` each look first (a step called **observe**): if `3 x K < B` they clear `armedAt`; they then
  apply their change; then if the line is reached and `armedAt == 0` they set it to now. So a dip that any call sees restarts
  the clock, including a top-up that finds the line had been lost (D3: the "hidden dip" is closed).
- **Paused** (`paused()`, a view): `armedAt != 0 and now >= armedAt + day and 3 x K >= B and B != 0`, with **day = unit / 7**
  seconds (24 hours on a real network, where N is 7 days; 4 minutes when N is 1,680 s, so a demo works). The last two
  conditions are read **live**: a join that pushes parked under the line stops the pause with no call, and a leave that brings
  it back restarts it with no new wait (the 24 hours were already served; D3 records the cost: an unseen dip and recovery is
  not a dip, and anyone can call `poke()` to make it seen).
- **It ends the moment** parked is under the line. There is no memory: a new reach is a new 24 hours.
- **No part of the rule counts**: an account, a count of people, a Treasury, Vester, Pair, TaskBook or Launcher balance, Team
  Shares, or any Share not put in by `park` from the caller's own wallet (`park` pulls from `msg.sender` only, with the
  caller's own allowance: there is no "from" argument and no way to park for someone else).

`HolderPause` functions (all external):

| Function | What it does | Reverts when |
|---|---|---|
| `initialize(IShares shares_, uint32 unit_)` | once, by the Launcher in the launch transaction; stores the token and `day = unit_/7` | already born; `unit_` zero or not a multiple of 168 |
| `park(uint256 n)` | observe; pull `n` of the caller's backer Shares (needs the caller's allowance to this contract); `parkedOf[caller] += n; parkedTotal += n`; arm if the line is reached | `n == 0`; no allowance or balance |
| `unpark(uint256 n)` | observe; `parkedOf[caller] -= n; parkedTotal -= n`; send `n` Shares back to the caller; disarm if under the line | `n == 0` or more than the caller parked. **No other condition: not the pause, not a door, not a wind-down, not a delay** |
| `poke()` | anyone: observe and re-arm or disarm; changes nothing else | nothing (emits only when `armedAt` changed) |
| views | `parkedOf(a)`, `parkedTotal()`, `armedAt()`, `day()`, `line()`, `paused()`, `pausesFrom()` (`armedAt + day` or 0), `state()` (K, B, line, armedAt, pausesFrom, paused in one call) | |

Storage: slot 0 holds `shares` (20 bytes), `day` (4) and `armedAt` (8) so one read answers the first test; slot 1 `parkedTotal`;
a mapping `parkedOf`. No owner, no admin, no upgrade, no payable function, no call into the Treasury, no dollars.

### 1.4 What pauses, and what does not

Pauses (while `paused()`): **`Treasury.draw`** (the runner, a Pair's both signers, and every agent: all go through `draw`) and
**`Treasury.announceTask`** (new task plans, by the runner or a Pair).

Does not pause, each with a test: `join` and the door; `leave`, `leaveTeam` and `unpark` (never slowed); `settle` and the
allowance's accrual into the box (the box stays at its seven-day cap; the team loses accrual beyond a week, see section 2);
`checkIn`; `takeTask`, `acceptTask`, `rejectTask`, `cancelTask`, `returnTask` and `claimNote` (**a task whose notice has begun is
never touched**: it can be taken, paid and returned while the pause is on); `grantTeam`, the Vester's claims and forfeits;
`proposeRate`, `applyRate`, `setRate`, `setDoor`, `handOver`, `takeSeat`, the agents' set-up, `addRevenue`, `collectFees`,
`windDown`. The pause **cannot pay anyone** (it holds no dollars and never calls the Treasury), **cannot move money** (it only
makes two functions refuse), and **cannot slow Take out** (neither `leave` nor `unpark` reads it).

### 1.5 Take out with parked Shares: one press

A holder's Shares are in two places: the wallet and the pause. The Treasury burns `msg.sender`'s own Shares, so Take out
cannot be done *by* the pause without writing the holder's exit notes to the pause contract. So the rule is: **un-park and take
out in one transaction from the holder's own account**. The app builds the batch `[unpark(p), leave(w + p, minCash, to)]`
(p parked, w in the wallet), which a passkey account sends as one operation with one prompt, and which an injected wallet sends
as two confirmations (the app says so before the press; D4). `unpark` has no condition and no delay, so the batch cannot be held
up by the pause, a wind-down, a shut door or a quiet project. Exit notes are written to the holder, because the holder is the
caller of `leave`.

Reading the quote before the press: `Treasury.quoteTakeOut(holder, n)` only needs `n` at most the holder's balance, and its
answer does not depend on the holder. The app reads `quoteTakeOut(me, w)` and `quoteTakeOut(<the pause contract>, p)` and adds
the two, then applies its usual guard (`minCash` a thousandth under, never below the call's own floor). The two floors can
differ from one `leave(w + p)` by at most two units; a test binds that the batch pays at least the guard. The server's sponsor
must keep treating this batch as an exit (section 4.5), or a person with parked Shares could be refused the sponsored fee on the
one press that must never be refused.

**Un-parking** is `unpark(n)` or the batch above. It returns the Shares to the caller at once, with no fee. After it, if parked
is under the line the pause ends in the same block.

### 1.6 What the Treasury reads, and what it costs

The Treasury reads exactly one thing, `IHolderPause(pauseGate).paused()`, in two functions. Gas (estimates from the EIP-2929
cold-access prices: 2,100 a storage read, 2,600 for a cold address; K1 measures them in `GasPause.t.sol` and the report states
the measured figures):

| Existing call | Switch off | Switch on, nothing armed | Switch on, line reached |
|---|---|---|---|
| `draw`, `announceTask` | about **+2,150** (one read of `pauseGate`, finds zero) | about +11,000 (gate read, clone call, delegate call, `armedAt` read) | about +18,500 (also `parkedTotal` and `shares.totalSupply()`) |
| every other Treasury, Vester, Pair, TaskBook, ShareToken call | **0** (no new instruction runs) | 0 | 0 |
| `Launcher.launch` | about +4,300 (two reads of a zero address, `holderPauseImpl` and `earlier`; K1 and K2 state the measured figure) | about +120,000 (clone, initialize, bind) | same |

Gates in the tests: off at most +2,500 on `draw` and `announceTask`; on at most +25,000.

### 1.7 Events

| Contract | Event | Meaning |
|---|---|---|
| `HolderPause` | `Parked(address indexed who, uint256 amount, uint256 parkedBy, uint256 parkedTotal, uint256 backerShares, uint64 armedAt)` | Shares were parked; the numbers after |
| `HolderPause` | `Unparked(address indexed who, uint256 amount, uint256 parkedBy, uint256 parkedTotal, uint256 backerShares, uint64 armedAt)` | Shares were taken back |
| `HolderPause` | `Observed(uint256 parkedTotal, uint256 backerShares, uint64 armedAt)` | `poke` found `armedAt` changed (emitted only then) |
| `Treasury` | `PauseReady(address gate)` | once, in the launch transaction: the reader finds the pause from it (as it finds the task book from `TasksReady`) |
| `Launcher` | `HolderPauseBound(address impl)` | once, the deployment's switch |

The rule that a pause *starts* is a time and a ratio, not an event: the reader works it out from `armedAt`, `day` and the live
numbers, and checks the answer against the view `paused()` at the same block (as every other number).

### 1.8 With the switch off, nothing differs: the proof

1. **By construction:** every new instruction is behind `pauseGate != address(0)` or `holderPauseImpl != address(0)`. Both are
   zero when nothing is bound.
2. **By the old tests:** the 540 existing tests, the 11 invariants, the vectors, the 124 mutations and the chain loop's 24
   checks run **unchanged** (K1 edits no existing test file; new files only) and stay green.
3. **By a new differential test** (`OffIsOff.t.sol`): the same fuzzed sequence of 120 steps (joins, take-outs, draws, tasks,
   check-ins, grants, wind-down, lapses) runs on a stack with the switch off and on a stack with the switch on where nobody
   parks; after every step every public view of the Treasury, Vester, TaskBook and both tokens is equal. So the gate is inert
   unless Shares are parked.
4. **By two literal checks:** `Treasury.pauseGate()` is zero on every project of a switch-off deployment, and
   `Launcher.settingsHash()` equals `keccak256(abi.encode(platform))` (the old formula) when nothing is bound.
5. **By the size gate:** `Size.t.sol` (existing, unchanged) must pass; a new `SizePause.t.sol` states how many bytes the
   Treasury, Launcher and the new contract took, and fails if the Treasury leaves under 300 bytes spare or Parts under 400.

### 1.9 The further power: the project ends when two thirds stay parked for a full quiet period. **Leave it out.**

Design (so it can be reconsidered): `HolderPause` also tracks `endArmedAt`, set the same way as `armedAt` but for `3 x K >= 2 x
B`; after a **full quiet period** (26 time units, the design's quiet wind-down wait, 182 days on a real network) anyone calls
`endProject()`, which calls a new Treasury hook that runs the existing `_windDown(3)` (box back to the pot, door shut, tasks
returned, leaving open, the Vester's burns after one more unit).

My attacks, which the plan's reviewers would find too:

1. **It lets a buyer take the team's unvested claim.** In a wind-down the unvested Team Shares burn (`Vester.burnAfterWindDown`).
   When the pot is above what backers put in (outside money), those Shares were a claim on the surplus, and burning them hands it
   to the backers, in proportion to their Shares. A buyer who joins at the quote and holds two thirds of the backers' Shares
   for 26 weeks takes two thirds of that. Arithmetic (the contracts' own formulas, plain Python, backers' paid-in 600,000, 60
   million backer Shares, a Team pool of 10 million of which 8 million are unvested, outside money lifting the pot to
   2,000,000): the buyer puts in 3,600,000, pays a 73,469 fee, and the burn lifts what their Shares can take out by **105,495**,
   a **net +32,025** with no price risk, because they can leave at face any day. At a pot of 5,000,000 it is +153,129; at
   20,000,000, +758,645. With no outside money the pot is at paid-in, the burn gains nothing, and the attack only costs the fee.
   The design closes the same trap elsewhere (a forfeit is announced a unit ahead and joiners are priced as if burned; the
   door is shut before a quiet wind-down). Neither defence applies here: the project is active, the door is open, and nothing
   is announced for 26 weeks.
2. **It kills a healthy project for the price of the fee.** Two thirds of a 1,000,000 pot costs about 40,000 in fee (2% of the
   gross) and then returns at face; the project's allowance, its plans and its team's unvested grants are gone.
3. **It breaks the rule that a grant is lost only by the member's own exit or both signers** (design C19), for the first time,
   by a power anyone can buy.
4. **It is not needed for the aim.** A holder who wants out takes out. A pause already stops the team's spending. The quiet
   wind-down already ends an abandoned project after 182 days.

I could break it, so by the owner's own test ("only if the plan's reviewers cannot break it") it is **left out** (D5). If it
is ever reconsidered, the fix to try first is that the burn never applies to a holder-ended project (a wind-down by choice
keeps every accrued part), plus an announced-ahead notice with joiners priced as if it had happened; that needs its own
attack review and counsel (question 4) and is not in this round.

---

## 2. The attack table for the pause

Cost model, so the table can be checked. Pot P0 is money backers put in and nobody has taken out (no surplus, so a Share costs
what taking it out gives). A newcomer who must hold a third of the backers' Shares after joining needs `n >= B0 / 2`, so puts in
net `m = P0 / 2`; gross `a = m / 0.98`; the 2% fee is `a - m`; the pot after is `1.5 x P0`. They can take their money out any
day at face (98.00 per 100 of what they paid in total, the design's round trip), so the **cost is the fee**; the money is tied
up, not lost. The team's loss is the allowance it cannot draw. While paused the box stays at its seven-day cap, so the team
loses accrual beyond one week: 0.10% of the pot a day (0.20% at the ceiling) of the new pot. Arithmetic, plain Python; K1's
tests check the fee and round-trip numbers exactly (`HolderPauseAttacks.t.sol`).

| # | Attack | Cost to the attacker, pot 10,000 / 1,000,000 | What the team and other holders can do | Defence in the code | Test that holds it |
|---|---|---|---|---|---|
| 1 | **A late large buyer** (milestone 9's first) joins big to reach a third and park | Fee **102 / 10,204** (net in 5,000 / 500,000; gross 5,102 / 510,204). First day's allowance share about 5 / 500 (a third of 0.10% of the new pot) before the pause bites. Money tied up, returned at face | Wait; talk to the holder; the box (up to 7 days of allowance) can still be drawn during the 24 hours; ask holders to back more (row 3); the project's money is never at risk | Pause only stops `draw` and `announceTask`; leaving is never slowed; 24 hours' warning; live ratio | `test_lateWhaleCostsOnlyTheFee`, `test_whaleRoundTripReturnsNinetyEightPerHundred`, `test_pauseStartsOnlyAfterADayOfSeeingTheLine` |
| 2 | **A founder with many accounts** (milestone 9's second): the team backs through 20 accounts to park a third and pause itself or a co-signer | No cheaper than one account: parking counts Shares, not accounts. Fee 2% of the money, same 102 / 10,204 for the same third | Nothing needed: the only target is the team's own spending. A founder cannot use accounts to *avoid* a pause either: Shares count, not heads | `park` counts Shares from `msg.sender` only; no per-account rule exists to dodge | `test_manyAccountsCostTheSameAsOne`, `test_splittingSharesAcrossAccountsChangesNothing` |
| 3 | **A whale parks to grief the team** and holds it | Fee **102 / 10,204** for the first third; to keep it as others add money, **half** of what they add (to stay at a third: `y >= x/2` for every `x` added), each with a 2% fee on new money. Allowance cost to the **team**: up to 15 a day / 1,500 a day at 0.10% (30 / 3,000 at the ceiling) beyond the first week | **Dilute:** anyone (the team included) backs more so that parked falls under a third. Worked: the whale holds 40% (they put in 6,667 / 666,667, fee 136 / 13,605); the other side needs to add 3,333 / 333,333 net, fee **68 / 6,803**, to push the whale under a third, and that money is real backing the project keeps. **Wait** for the whale to tire (they pay time, not money). **Leave**: a holder who dislikes the freeze takes their slice out at face, and the whale's own line moves down as others leave (see row 11) | The line is a live ratio of all backers' Shares; the pause pays nobody; nothing is locked for leavers | `test_dilutionEndsThePauseTheSameBlock`, `test_whaleAtFortyPerCentNeedsTwentyPerCentOfPotToBeDiluted` |
| 4 | **Park and un-park flapping around the line** to start and stop the pause, or to wear out the team's alerts | Gas only | A flapper cannot make a pause shorter than 24 hours of an unbroken line, nor keep one past a dip. The app shows the state, not every flap (it reads the state, and the helper pokes at most once per project per 10 minutes) | Observe-first clears `armedAt` on any seen dip; a pause needs the line live; a new reach is a new 24 hours | `test_flappingNeverPausesBeforeADayOfUnbrokenLine`, `test_aTopUpAfterAnUnseenDipRestartsTheDay` (binds D3), `test_pausedEndsTheSecondParkedFallsUnderTheLine` |
| 5 | **Parked Shares then sent** | The Shares are not in the wallet; they cannot be sent. Taking them back and sending them ends their count at once | Nothing needed | Custody; `unpark` returns only to the parker | `test_parkedSharesCannotBeSent`, `test_unparkThenSendEndsTheCount` |
| 6 | **Parked Shares then taken out** (to dump the stop while taking money) | None: Take out is never slowed; un-park and leave are one batch; the exit note is written to the holder | The line falls as B falls: a take-out by someone else can *bring a holder's parked Shares to a third*: row 11 | `unpark` has no condition; `leave` never reads the gate | `test_takeOutWithParkedSharesPaysTheQuoteInOneBatch`, `test_exitNotesGoToTheHolderNotThePause`, `test_unparkWorksWhenPausedWoundDownAndShut` |
| 7 | **A pause aimed at a task mid-notice** | None needed: it does not touch it | The task is taken, accepted, rejected and returned as if nothing happened | `takeTask`, `acceptTask`, `rejectTask`, `cancelTask`, `returnTask` and `claimNote` read no gate | `test_aTaskAnnouncedBeforeThePauseCanBeTakenAndPaidDuringIt`, `test_everyOtherCallWorksWhilePaused` |
| 8 | **The team parks its own vested Shares** | Team Shares are another token, never accepted by `park`, never in B or parked. A team member who also backed with their own money may park those backer Shares (fee 2%) and so pause the team (themselves, a co-signer, an agent) | A Pair's other signer can pause the first signer's draws only by paying the same price as anyone | `HolderPause` only handles the backer token; vested or unvested Team Shares appear on neither side | `test_teamSharesCannotBeParkedOrCounted`, `test_aTeamDonationOfTeamSharesChangesNothing` |
| 9 | **Parking through a contract** (a vault or lender parks what it holds; a smart account; a flash lender) | A contract that parks counts once, for the Shares it holds, like any holder. A flash-lent third cannot be held 24 hours (the loan must be repaid in the same transaction; a longer loan costs its interest, which is the same as buying). A contract cannot park Shares it was not given allowance for | Same as row 3 | Custody pulls only from `msg.sender`; the 24-hour unbroken line; a donation is not parked | `test_aContractParksOnlyWhatItHoldsAndItCountsOnce`, `test_aOneBlockLoanNeverArms`, `test_noOneCanParkForSomeoneElse`, `test_aDonationIsNotParked` |
| 10 | **Parking from a Pair, an agent or the Treasury** | Not special: only backer Shares a holder parks count; the Treasury, Vester, Pair and TaskBook hold none and cannot park | | | `test_projectContractsCannotChangeTheCount` |
| 11 | **Others leaving lets a small holder reach the line for free** (a ratio, not a bug) | 0: a holder at 27% of B reaches a third when holders of 25% of the Shares take out (B falls to 81% of before) | The team can back more; the holder was always going to be a third once others left | `3 x K >= B` is live; `poke()` makes it seen | `test_othersLeavingCanBringAHolderToTheLine` |
| 12 | **A hidden dip and recovery** keeps an old `armedAt` | A joiner pushes parked under the line and a leave brings it back without any call: the pause starts at `armedAt + day` though the line was lost in between | Anyone calls `poke()` during the dip (the team's helper does, bounded); then the clock restarts | Observe-first in `park`, `unpark`, `poke`; the server helper pokes when its numbers disagree with the view | `test_pokeDuringADipRestartsTheDay`, helper tests (section 4.4) |
| 13 | **The gate fails or lies** | | A broken gate fails **closed**: `draw` and `announceTask` revert; no money is ever stuck (leaving does not read it). The real contract has no owner, no upgrade and one external read that cannot revert | `_notPaused` does not catch | `test_aRevertingGateStopsOnlyDrawAndAnnounce` (a mock gate bound through the Launcher) |
| 14 | **Using the pause to steal** | None possible: it holds no dollars and never calls the Treasury | | `HolderPause` has no payable function and no dollar address; Treasury buckets are equal before and after any park, unpark or poke | `test_parkMovesNoDollars`, the invariants (below) |
| 15 | **A task announced in the 24 hours of warning** | | It stands: its notice runs and it can be taken after, as in row 7. That is the price of "24 hours later" | | covered by row 7's test |

**What a determined whale can still do, and what it costs them (said plainly).** For as long as they keep a third of all backers'
Shares parked and nobody dilutes them, a whale can **stop the team drawing its allowance and announcing new tasks**. They cannot
take any money, stop anyone taking money out, change a rule or touch a task already announced. It costs them the 2% fee on the
money they put in (102 on a pot of 10,000; 10,204 on a pot of 1,000,000, arithmetic), the money tied up (5,102 or 510,204,
returned at face if they leave), and the loss of the project's other upside, nothing else. If they buy a third from others on a
market rather than at the door there is no fee at all and the cost is the pool's own spread (a pool is not built by Creaton in
version one). The team loses its allowance beyond the box's week: 15 a day or 1,500 a day at 0.10%. **The only strong defence is
more money joining or the whale giving up;** the pause is a stop, not a verdict. Parking does not stop a loss, and the words never say so.

**Invariants (`HolderPauseInvariants.t.sol`, 256 runs of 200 steps, a handler with six actors and the whole stack):** `parkedTotal`
equals the sum of every `parkedOf`; the contract holds at least `parkedTotal` Shares; `parkedTotal <= B`; `paused()` is never true
when `3 x K < B`; the Treasury's dollar buckets are never changed by park, unpark or poke; the two paused functions always
revert while `paused()` and never otherwise because of it. `PauseEventsRebuild.t.sol` replays 400 random steps and checks that a
ledger built from `Parked`, `Unparked` and `Observed` alone holds the same `parkedTotal`, per-holder amounts and `armedAt`.

---

## 3. Earlier grants as a contract design

### 3.1 What it is

Project zero's earlier backers receive **Team Shares on a protected grant** (design C21): a protected grant vests on calendar
time over 365 days with no cliff and can never be forfeited, burned or paused, and it claims only the surplus above what
backers put in (a Team Share never reaches a backer's money). The list is **one fingerprint, a Merkle root** over rows of
(index, account, amount). The rows are never in the repository. A claimant claims with their own proof and, in the same call,
accepts a text whose fingerprint is a deployment setting; the acceptance is recorded on the network. Nothing is claimable unless
the deployer set both fingerprints.

### 3.2 Exactly what changes

| File | Change | Size effect (estimate) |
|---|---|---|
| `contracts/pot/src/EarlierGrants.sol` | **new**, one contract per deployment (not a clone), about 110 lines | about 2.5 KB |
| `contracts/pot/src/Vester.sol` | `address public earlier; uint256 public earlierReserve; uint64 public earlierStart;` and `initializeWithEarlier(treasury_, team_, pool_, earlier_, earlierPool_)` (the same checks as `initialize`, funded `pool_ + earlierPool_`, only the Launcher in the launch transaction as today); `grantProtected(address member, uint256 amount)` (only `earlier`; makes a protected grant whose clock starts at **`earlierStart`, the project's birth**, not at the call); the ordinary `grant` now needs `balance >= committed + earlierReserve + amount`; `burnUngrantedAfterWindDown` leaves the reserve out. `grant` becomes a thin wrapper over a private `_grant`. `initialize` is untouched | Vester +about 450 bytes (7,355); **Parts +about 450 (and +about 350 from K1's Treasury): about 48,500 of 49,152** |
| `contracts/pot/src/Launcher.sol` | `address public earlier; bytes32 public earlierKey;` and `bindEarlier(address earlier_)` (deployer only, once, first hour; `EarlierGrants(earlier_).launcher() == this`); in `launch`, when `earlier != 0 and key == earlierKey`: mint `terms.teamPool + earlier.total()` to the Vester, call `initializeWithEarlier`, then `EarlierGrants.bind(vester)`; `settingsHash` includes `earlier` when bound; event `EarlierBound(address earlier, bytes32 key)` | +about 500 bytes |
| `contracts/pot/src/Interfaces.sol` | `IVester.grantProtected`, `IEarlierGrants` | none |
| `contracts/pot/script/DeployPot.s.sol`, `DEPLOYMENTS.md` | the settings below | none |

The Treasury is **not** touched by this feature (it has too little room, and it needs nothing: it makes no protected grant).
Team Shares counted in G include the earlier pool from birth, exactly as every unvested Team Share is, so a joiner's price and a
take-out are computed on the whole Team supply as today. `Treasury.agentTeam` (agent Team Share limit) is `terms.teamPool / 1000`
as now: the earlier pool never enlarges an agent's limit.

### 3.3 Which pool, and how it is funded at project zero's launch

A separate pool: **`earlierPool` Team Shares, minted to the Vester in the same `launch` transaction as `terms.teamPool`**, only
for the one project whose key is `earlierKey` (project zero, named by the deployer by its founder and project id). They are in
the Vester but not "committed", so the **reserve** (`earlierReserve`) keeps them out of reach: the runner, a Pair or an agent
cannot grant them with `grantTeam` (the ordinary grant checks the reserve). Each protected grant moves its amount out of the
reserve into `committed`. After a wind-down the reserve is not burned (a protected grant is never burned). The pool size is the
claim contract's `total` (a setting; the owner's number, not chosen here); `Launcher.MAX_EARLIER_POOL` = 1,000,000,000 Shares
(the old supply) bounds it. **The team pool's own limit of 100,000,000 is unchanged and is separate** (D6). The earlier pool
counts in G from birth, so "the team side gets x% of anything above what backers paid in" is larger for project zero; the app
already shows that line from the live numbers and the owner must see the figure before any real network (open point, section 7).

### 3.4 The claim call and what it checks

`EarlierGrants(address launcher, bytes32 root, bytes32 textHash, uint256 total, uint32 rows, bytes32 key)`: the script passes the
Launcher's address, and `bindEarlier` checks that the claim contract names this Launcher. The constructor refuses a zero
root, a zero text fingerprint, a zero total, zero rows or a total over `MAX_EARLIER_POOL`.

```
claim(uint256 index, uint256 amount, bytes32[] calldata proof, bytes32 acceptedText) -> uint256 grantId
```

Checks, in this order, each with its own error and its own test:

1. the project's vester is bound (`NotBound`);
2. `acceptedText == textHash` (`WrongText`): **the claimant names the fingerprint they accepted; a page that shows another
   text cannot make them accept it**;
3. `index < rows` and `proof.length <= 32` (`BadRow`);
4. the row was not claimed (`AlreadyClaimed`; a bitmap by index: **a row can be claimed once**);
5. `MerkleProof.verifyCalldata(proof, root, leaf)` with `leaf = keccak256(bytes.concat(keccak256(abi.encode(index, msg.sender,
   amount))))` (the double hash, so an inner node can never pass as a row; `msg.sender` is in the leaf, so **only the row's own
   account can claim it**, and nobody can claim for someone else or front-run a claim) (`BadProof`);
6. `amount >= Vester.MIN_GRANT` (one whole Team Share) (`RowTooSmall`; a smaller row could never be granted);
7. `claimedTotal + amount <= total` (`OverPool`).

Then it marks the row, adds to `claimedTotal` and `claimedRows`, records the acceptance (`acceptedAt[msg.sender]`,
`acceptedText[msg.sender]`: first acceptance, never overwritten), calls `Vester.grantProtected(msg.sender, amount)` and emits
`Claimed(index, account, amount, grantId, textHash, claimedRows, claimedTotal)`. No dollars, no refund path, no fee, no vote, no
call into the Treasury, no admin, no sweep.

**Protected grant through the Vester.** `grantProtected` calls the private `_grant(member, amount, true)` with `start =
earlierStart`. So a claimant who comes on day 400 has a fully vested grant at once and one on day 100 has about 27%: the clock
is the same for everyone, 365 days from project zero's birth, calendar time, no cliff, as design C21 says (not from the claim).
The existing guards apply: at most 8 grants per member (a claimant who already has 8 cannot claim; the list is made for accounts
that have none; K2 tests the revert), a protected grant can never be announced, forfeited, trimmed by a hand-over, or burned
after a wind-down (`ProtectedGrant` reverts stay as they are).

### 3.5 Deploy settings and the default

Settings (environment variables of `DeployPot.s.sol`), **all empty by default, and with them empty nothing is claimable and
nothing changes**:

| Variable | Meaning |
|---|---|
| `EARLIER_ROOT` | the list's fingerprint (bytes32) |
| `EARLIER_TEXT_HASH` | the text's fingerprint (bytes32) |
| `EARLIER_TOTAL` | the earlier pool in Team Share wei (the sum of the rows; the owner's number) |
| `EARLIER_ROWS` | the number of rows |
| `EARLIER_FOUNDER`, `EARLIER_PROJECT_ID` | who will launch project zero and under which id (they give `earlierKey = keccak256(abi.encode(founder, projectId))`) |

The script deploys `EarlierGrants` and calls `launcher.bindEarlier` **only if both `EARLIER_ROOT` and `EARLIER_TEXT_HASH` are
set**, and refuses (the script reverts) if one is set without the other or without the rest; the contract also refuses a zero of
either. The default of a deployment is therefore: no claim contract, `Launcher.earlier() == 0`, project zero born as any project.

### 3.6 Events and unclaimed rows

Events: `EarlierGrants.Bound(address vester)`, `EarlierGrants.Claimed(...)` (above), `Launcher.EarlierBound(address earlier, bytes32
key)`, and the Vester's existing `GrantMade(..., kind 1)`.

**Unclaimed rows.** The design says only that a stated time (counsel's long-stop, "at least two years", `EARLIER-BACKERS.md`
section 5) decides what becomes of unclaimed Shares, and that nothing is swept before it. So the rule here is the plain
alternative the task allows: **unclaimed rows stay claimable, with no end time and no sweep** (D7). Unclaimed Shares stay in the
Vester's reserve, count in G, and never become anyone else's. A rule that burns or reassigns them after a stated time needs
counsel and a notice of one unit with joiners priced as burned (the forfeit path); it is **not** built (section 7). The app says
"These stay open to you; there is no end date on this network."

### 3.7 Tests (invented rows only)

The test builds a small Merkle tree **in memory** from invented accounts (`makeAddr("row-1")` and so on) and invented amounts
(for example 1,000, 2,500 and 40 Team Shares of different sizes, and a row below one Share). No row, list file or fingerprint of
a real list exists anywhere in the repository; the only fingerprints are computed in the tests and the loop.

- `EarlierGrants.t.sol`: every check of 3.4 reverts with its own error and a test **fails when that check is switched off**
  (the mutation script, section 6); a valid claim makes exactly one protected grant of exactly that amount to exactly that
  account; two rows of one account (different index) each claim once; the same row twice reverts; a proof for another
  account, another index or another amount reverts; **a second-preimage attempt** (submitting an inner node as a leaf) reverts;
  claim before `bind` reverts; the acceptance record and the event carry the fingerprint; `claimedRows` and `claimedTotal`
  match; `OverPool` when a bad list's rows exceed the pool.
- `EarlierVester.t.sol`: `grantProtected` only by `earlier` (not by the Treasury, the runner, an agent or a stranger); the
  vesting is **calendar from birth** (0 at birth, about half at day 182, all at day 365, no cliff, claimable in parts by anyone
  sending to the member); `GrantMade` kind 1; the ordinary `grant` and an agent's grant cannot spend the reserve (the runner
  grants the whole ordinary pool and the next grant reverts `NotFunded`); protected grants survive `announceForfeit`,
  `announceByRunner`, `exitAll` (the hand-over trim), `burnAfterWindDown` and the ungranted burn, which leaves the reserve;
  `initializeWithEarlier` only once and only with the funded amount.
- `EarlierLauncher.t.sol`: `bindEarlier` is deployer-only, once, inside the first hour, and checks the claim contract's launcher;
  launching under `earlierKey` mints pool plus earlier pool, calls `initializeWithEarlier` and `bind`; another key launches as
  before; the founder of `earlierKey` cannot be impersonated (`keyOf` uses `msg.sender`); `settingsHash` changes when bound and
  is the old formula when not; with nothing bound, a full launch gives `earlier() == 0` and `Vester.earlierReserve() == 0`.
- **A money test that must bind:** an earlier holder with everything vested and claimed leaves with `leaveTeam` while the pot is
  at or under paid-in and gets **zero**; above paid-in they get exactly the Team formula's share; backers' take-out value is
  unchanged by claims (`test_earlierSharesNeverReachBackersPaidIn`).
- The invariants (`PotInvariants`, new `EarlierInvariants.t.sol` on a stack with the claim contract): the Vester always holds
  `committed + earlierReserve + ungranted`; `claimedTotal <= total`; Team supply never grows after birth.
- Gas: a claim with a proof of depth 20 is measured and stated.

### 3.8 What is left to counsel, and why the code stays right whatever the text says

Left to counsel: **the text itself** (what it says about the old agreement, the clock, the limits of a Team Share, the market),
**the consent wording**, whether a transaction from the account is enough or a signature over structured data is also required
(the old design's typed message; not built here: the claim is the account's own transaction, which already proves control),
the entity that issues, jurisdictions, the long-stop, and what the list is (counsel's attestation of its count and total; the
owner's numbers). None of it is in the repository.

How the code stays right whatever the text says: (1) the contract treats the text as **an opaque 32-byte fingerprint**; a new text
is a new fingerprint and a new deployment of a new claim contract (nothing mutable, no keeper, no `publishText`), so no one can
change what was accepted; (2) the acceptance is checked against the fingerprint the claimant names, and the app also refuses to
offer the press when the build's fingerprint and the contract's differ; (3) the clock, the amounts and the limits are read from the
chain, never typed into the app (the 365 days from the Vester's `PROTECTED_LENGTH`, the amount from the proof, the pool from
`total`), so a page can never promise a clock the contract does not keep; if counsel's text wants another clock, that is a
constant in the Vester changed **before** the deployment, and the fingerprint changes with the text; (4) the money rule that a
Team Share claims only the surplus is the contract's, and the page says so from the formulas' live numbers.

---

## 4. The server (S1)

All of it additive inside record version 2 ("adding a field never changes the version", `RECORD-V2.md` section 1). No new
event kind, no new relay rule for pause or earlier grants.

### 4.1 Events the reader takes in

`scripts/chain-reader-events.mjs` regenerates `events_table.rs` from the contracts build (never hand-edited); `Role` gains two
roles:

| Role | Contract | Found from | Events |
|---|---|---|---|
| `Pause` | a project's `HolderPause` | the Treasury's `PauseReady(gate)` log (as `Tasks` from `TasksReady`) | `Parked`, `Unparked`, `Observed` |
| `Earlier` | the deployment's `EarlierGrants` | the Launcher's `EarlierBound(earlier, key)` log, tied to that project key | `Bound`, `Claimed` |

Also decoded: Launcher `HolderPauseBound`, `EarlierBound`; Treasury `PauseReady`. `chain_contracts.role` and `chain_logs.role`
take the two new names (a text column: no migration of data; K/S1 check `Role::parse`).

**Holdings.** A parked Share must not make its owner stop being a holder. The reader's ledger keeps its balance per account per
token as now (so the pause contract appears as a holder, and is **left out of every list** with the zero address, Treasury,
Vester, the tokens, the dollar and the Launcher), plus `parked[owner]` from `Parked` and `Unparked`. **An account's holding is
`balance + parked`**, and that is what `holders[]`, `holderCount`, the Established badge's `held` windows
(`held.rs`), the room's write rule (`room_write.rs`) and the feed's joins and take-outs use. A park or an un-park is not a join
or a take-out and never moves a "held since" date. Because a park is two events in one transaction (a Transfer to the pause, then
`Parked`), `held.rs` takes the account's holding **at the end of each block**, never in the middle. Reader tests: parking never
lowers `held`, never removes a holder from the lists, never appears in the feed; the sum of holdings equals `totalSupply()` less
the pause contract's unparked donations.

### 4.2 The additive record keys

Always present as keys, `null` when the project has none (the step 3 rule: never `0`, never `[]`, a failure of one key signs
that key `null`, logs one error line naming project and key, and signs the rest).

`pause` (`null` unless the project has a `HolderPause`):

| Field | Type | Meaning | From | Bound | When absent the app shows |
|---|---|---|---|---|---|
| `pause.contract` | address | the project's pause | `PauseReady` | | no stop card, no Park button |
| `pause.parkedTotal` | amount (18 dec) | Shares parked | view `parkedTotal()` at `asOf.block` | at most `shares.backers` (the reader checks and signs `null` if not) | "the stop could not be read" only on the holder's own sheet; elsewhere nothing |
| `pause.line` | amount (18 dec) | the Shares that make a third, `ceil(B/3)` | view `line()` | 0 to `shares.backers` | |
| `pause.dayLength` | int seconds | the pause's "day": the wait of 24 hours on a real network | view `day()` | `unit / 7` | |
| `pause.armedAt` | int or null | when the line was first seen reached in an unbroken run | view `armedAt()` | | |
| `pause.pausesFrom` | int or null | `armedAt + dayLength` | view `pausesFrom()` | | |
| `pause.paused` | bool | whether `draw` and `announceTask` refuse at `asOf.time` | view `paused()` at the block's own time | | the card reads "not paused" |
| `pause.since` | int or null | when it began: `pausesFrom` while paused | arithmetic on the two views | | |
| `pause.parkerCount` | int | accounts with parked Shares, a count only, never a name | events | at most 1,000,000 | |

No address of a parker, no per-person amount, no list. `RECORD-V2.md` gets a section 13 with these tables.

`earlierGrants` (`null` unless this project's key is the Launcher's `earlierKey`):

| Field | Type | Meaning | From | Bound |
|---|---|---|---|---|
| `earlierGrants.contract` | address | the claim contract | `EarlierBound` | |
| `earlierGrants.bound` | bool | the project's vester is bound (claims can start) | event/view | |
| `earlierGrants.root` | bytes32 | the list's fingerprint | view `root()` | |
| `earlierGrants.textHash` | bytes32 | the text's fingerprint | view `textHash()` | |
| `earlierGrants.total` | amount (18 dec) | the pool | view `total()` | at most 1e27 |
| `earlierGrants.rows` | int | the number of rows | view `rows()` | at most 2^32 |
| `earlierGrants.claimedRows` | int | rows claimed | view `claimedRows()` | at most `rows` |
| `earlierGrants.claimedTotal` | amount (18 dec) | Team Shares granted by claims | view `claimedTotal()` | at most `total` |
| `earlierGrants.clockSecs` | int | the protected clock, seconds | Vester `PROTECTED_LENGTH()` | |

**Never a row.** The record, the feed, the explore index and the logs the API serves carry **no** account, index or amount of any
row; `Claimed` is stored (it is public on the chain) but never copied into the record; `grants[]` leaves out `kind == 1` grants
so the per-grant list never shows a protected earlier grant, and `holders[]` lists Team Shares as it lists any (a claimant who
holds Team Shares is a holder like any other; the record has no mark on them). A test plants invented rows and checks that no byte of
any row, account or amount appears in the signed record (like the existing planted-record checks).

The existing `contracts` object gains `pause` (address or null). `shares.backers` is unchanged and includes parked Shares.
The fixture (`testdata/pot-run.json`, `pot-events.json`, `pot-abi.json`) and `record-v2-example.json` are **regenerated** by
`scripts/chain-reader-fixture.py` and the chain loop with the switch on, never hand-edited; `chain-reader-example-check.py` and the
Rust test `the_table_is_the_forge_build` must pass.

### 4.3 The reader and the numbers

`numbers.rs` and `record.rs`: the two new blocks are read at `asOf.block`, with the same batching, bounds and "fail to null"
rules as `tasks`. `paused` is **read from the view** and checked against the arithmetic of 4.2 (a disagreement signs `pause:
null` and logs). The refresh promise (`refreshEverySecs`) drops to 600 while a pause is armed or paused (so the pause start shows
within ten minutes).

### 4.4 The helper: one new permissionless call

`helper/calls.rs`, `helper/plan.rs`: a job `pause.poke` (`HolderPause.poke()`, no value, no money): when the ledger's `armedAt`
disagrees with the line (the line is reached and `armedAt` is 0, or it is armed and the line is lost) the helper pokes, **once per
project per 10 minutes, at most 6 a day, with backoff, and a terminal state** (a project that fails 5 times in a row is left
alone for 24 hours and logged). The helper still never leaves, refunds or claims for a person (its list of calls is closed;
`poke` moves nothing). Tests: the planner (arm, disarm, no job when they agree, bounds, no job without a pause contract) and the
closed list.

### 4.5 The sponsor must keep exits free

`api/sponsor/calldata.rs` `is_exit` and `api/sponsor.rs` `read_allowed`: an operation is an exit when every call is either
`leave` or `leaveTeam` on a followed Treasury **or `unpark(uint256)` on a followed pause contract** (role `pause`, a new
`allowed.pauses` list, no native value), and **at least one call is a `leave`**. A batch of `unpark` alone, `park`, `approve`, or
an `unpark` to another contract is not an exit and counts like any other operation. The pause contracts and the claim contract are
already allowed targets (every followed contract is). Tests: the exit selectors equal the generated ABI (as now); `[unpark,
leave]` is an exit; `[unpark]` and `[park]` are not; an `unpark` on a contract the reader does not follow is not; the day's counts
are never charged to an exit batch.

### 4.6 W5 server item one: a box-paid task is "Paid" only when the network shows the payment (G7)

Verified open at `1fed95002`: with no plan on the network, `task_chain::decide_chain` returns `Ok` for `ChainLookup::Absent`, so a
`confirm` carrying any `task-paid` transaction is stored.

Change, in `crates/buzz-relay/src/handlers/task_chain.rs` (and its `_postgres_tests.rs`), plus the words in the same file:

- New lookup `box_payment_of(pool, reader, treasury, tx)`: the stored `AllowanceDrawn` row of **that project's Treasury** whose
  `tx_hash` equals the named transaction, with its `to` and `amount`.
- A `confirm` for a task with **no plan** that names `task-paid`: (a) the reader has not stored the project's launch: `retry:`
  (as now for a plan); (b) the transaction has no `AllowanceDrawn` row of this Treasury, and the reader's newest stored block is
  at or after the block that holds that transaction (or 40 blocks past the latest the reader has, never guessed): `invalid:` with
  words "the network does not show that payment"; before that block is stored: `retry:`; (c) a row exists but `to` is not the
  wallet the worker named under their own signature (`task-pay-to`, read with `stored_pay_to`): `invalid:` "the payment went to
  another wallet than the one the worker named"; (d) the amount is not the record's `task-usd` when it states one: `invalid:`.
  Otherwise the record is stored. A `confirm` that names **no** payment (the "accepted without paying" path) is untouched.
- A lookup that fails is a server fault that refuses the write (as everywhere in this file).
- Reading side: the record the app reads is the stored one, so "Paid" can no longer be written without the network showing it.
  Rows already stored before this change keep reading as they did; the app's own chain search (`pay-lookup.ts`) is unchanged.

Tests (Postgres lane): a confirm with an invented transaction is refused; with a real stored `AllowanceDrawn` to the worker's
wallet it passes; to another wallet it is refused; a transaction of another project's Treasury is refused; a reader that has not
caught up says `retry:`; **the guard is switched off once** (the new branch returns `Ok`) and the refusal tests must fail.

### 4.7 W5 server item two: tie the agents' limits to the server's labels (open item 4 of `PLANV2-M8-REPORT.md`)

Verified still open at `1fed95002`: `agent_label.rs` mentions neither `wallet_binding` nor `AgentSet`. Chain limits bind an
**address** (`Treasury.setAgent`), the labels bind a **Nostr account**; the one link the server has is the wallet binding
(`handlers/wallet_binding.rs`, an account proves control of a wallet by signature, as the room rule already uses).

Change, minimal and in these files only: `handlers/agent_label.rs` (the new check and its words), `handlers/launch_update_authority.rs`
(call it where the manager and worker roles are judged), `handlers/wallet_binding.rs` (one read: the wallets an account has linked,
already `linked_wallets`), their `_postgres_tests.rs`, and the chain read of live agents from `chain_logs` (`AgentSet`, last event
per agent and project, as `ledger.rs` already keeps it):

1. A profile that writes `agent-role = manager` is refused when any wallet the account has linked is an agent that the chain
   shows as switched on (last `AgentSet.active`) in any project this reader follows: `invalid:` "a manager account cannot also be
   an agent with spending limits".
2. A task step signed by an account that is **not** labelled an agent, whose linked wallet is a live chain agent of **that**
   project, is refused with `restricted:` "this wallet is set as a helper on the network; label this account as a helper first"
   (it closes "a team key that is an agent but has no label" for every key that has linked its wallet; an unlinked key stays a
   stated limit).
3. An agent-labelled account that posts an open task: the dollar amount is held to the **smaller** of the server's existing cap
   and, when its linked wallet is a live chain agent of that project, that agent's daily dollar limit (`AgentSet.usdCap`), closing
   "agents posting open tasks of up to 100,000 dollars".
4. Everything is a refusal at write time from stored rows; no chain call is made on the write path; a lookup that fails refuses
   the write. Tests: each rule refuses; each has a "label removed" or "wallet unlinked" case that passes; each guard switched off
   once makes its test fail.

---

## 5. The app (A5): every screen and every sentence

Phone first, light. The words are plain ("pause", "park", "Take out", "the project's money"); no event name, kind number or
error name in main copy; sizes are rem tokens; the name comes from the brand constant; the banner "You can take your money out
any time. Nothing here promises a profit." is the shell's and each new sheet carries it; the line "This can go up or down. It is
not a return." stands under any live money number (these sheets show Shares and percentages, so it appears on the sheets that
show what taking out gives, as now). **No sentence says or implies that parking stops a loss.** No new tab. The first download
stays under 450,000 bytes: the pause sheets and the claim page are lazy chunks; the parse of the two record keys and one card are
the only first-download code.

### 5.1 Where a holder parks and un-parks (two presses from the project page)

Shown only when the project's record has `pause` and the person holds backer Shares (wallet or parked).

On **Your Shares** (project page, `YourShares.tsx`), under the holding line, a secondary button and one line:

- **Park Shares** (opens the sheet), and, when some are parked, **Take back**.
- Line: "{p} of your {t} Shares are parked." (hidden when none).

**Park sheet** (`ParkSheet.tsx`, lazy):

- Title: "Park Shares".
- First line: "Parked Shares count toward pausing the team's spending. They stay yours: take them back or take them out any day, in one press."
- Picker as Take out has it: "All of it", "Half", "A quarter" of the Shares in the wallet.
- Summary (read from the chain at the moment the sheet opens): "You park {n} Shares. After this, {x}% of backers' Shares are parked. At a third, the team's allowance and new task plans pause one day later."
- Second line: "Parking does not stop a loss and does not move your money. Parked Shares cannot be sent until you take them back."
- A line about the wallet: wallet, "Your wallet is asked twice: first to let the project hold them, then to park."; passkey account, "Your passkey is asked once."
- Button: "Park". The banner under it.
- After it: "Parked. You can take them back or take them out any time from Your Shares."
- A failure says what happened and what to do ("The network did not take it. Nothing moved. Try again.") from a copy module.

**Take back sheet**: "Take back Shares" / "Take back {n} Shares to your wallet. Nothing is charged." / button "Take back".

**Take out sheet** (`TakeOutSheet.tsx`, `takeout-read.ts`): when some Shares are parked the holding line reads "You hold {t}
Shares ({p} parked)." and a line "Taking out takes your parked Shares back first, in the same press." For an injected wallet
that cannot batch: "Your wallet is asked twice." The press is the batch of 1.5; the quote is the sum of the two quotes with the usual guard; nothing else changes.

### 5.2 What the project page says (the card `PauseCard.tsx`, shown only when `pause` exists)

Always: **"Holders can pause the team's spending."** then "If a third of all backers' Shares are parked, the team's daily
allowance and new task plans pause one day later, for as long as a third stays parked. Parking does not stop a loss and does not
move anyone's money. You can take your money out any time." Then one state line from the record, with a meter (`role="meter"`,
with a text value, never colour alone):

| State (from `pause`) | Sentence |
|---|---|
| none or little parked | "{x}% of backers' Shares are parked. A third is needed." |
| near (parked at least three quarters of the line, below it) | "Close to the line: {x}% parked, a third pauses the team's spending." |
| armed (line reached, `pausesFrom` in the future) | "A third is parked. The team's allowance and new task plans pause on {date and time} if it stays there." |
| paused | "Paused since {date and time}. The team cannot draw its allowance or plan new tasks while a third stays parked. Tasks already planned go on. Everyone can still take their money out." |
| record older than its refresh promise, or `pause` null while the Treasury has a pause | the existing "numbers are old" line; no pause claim is made |

A person with parked Shares also sees, in the card: "You have {p} Shares parked." with **Take back**. The percent is rounded
down; under 1% reads "less than 1%".

### 5.3 What the team sees

On the allowance section (`AllowanceSection.tsx`, `AllowanceSheets.tsx`) and the plan-a-task sheet
(`tasks/chain/team/PlanSheet.tsx`), for the runner, a Pair's signers and anyone who could press them:

- armed: "Holders have parked a third of all Shares. Your allowance and new task plans pause on {time} if it stays there. Until then you can draw what the box holds."
- paused: "Paused by holders since {time}. You cannot draw the allowance or plan a new task until fewer than a third of Shares are parked. You can still check in, finish tasks already planned, grant Team Shares and hand over."
- The **Draw** and **Plan a task** presses are disabled while paused, with that reason as their description (one owner of each label). If the chain refuses anyway (a stale read), the copy module maps the refusal to: "The team's spending is paused by holders. Try again when parked Shares fall below a third."
- The agents' screen (`AgentCaps.tsx`) adds one line while paused: "Helpers cannot draw while the team's spending is paused."
- The Pair confirm sheet gets no new sentence (no new call kind); a `draw` or `announceTask` confirmed during a pause shows the refusal above.

### 5.4 The claim page for earlier grants (`app/src/features/earlier-grant/`, route `/earlier-grant`, lazy)

**Exists only where the build is given the settings** (`VITE_CREATON_EARLIER_CONTRACT` and `VITE_CREATON_EARLIER_TEXT_HASH`, in
`app/.env.example`, with an optional `VITE_CREATON_EARLIER_TEXT_URL`). Without them the route is not in the router tree, the
address is a plain not-found, and no code of the page loads. (The old earlier page and its route stay behind the legacy flag.)

A person gets their own link `/earlier-grant#<their row>`: the fragment carries their `index`, `amount` and `proof` (base64url
JSON), is never sent to any server, and is made by whoever holds the list. The page **never shows another person's row, never
lists rows, and the server holds none**.

| State | Sentences |
|---|---|
| Not signed in | "Sign in to see whether this link is for your account." (the existing sign-in) |
| No link, or the proof does not match the signed-in account and the network's fingerprint | "This link is not for the account you are using. Open it with the account it was made for." |
| Claims not open (`bound` false) | "Claims are not open yet." |
| The page's text fingerprint and the network's differ | "This page and the network name different texts. Do not accept. Tell the person who sent you the link." The press is not offered. |
| Row found | "Your grant: {amount} Team Shares." / "They unlock evenly over {clock} days counted from the day the project began, with no waiting period at the start. They cannot be taken away." (both numbers read from the chain) / "Taking Team Shares out pays only what the project holds above what backers put in. That can be nothing." |
| The text | "The text you accept has the fingerprint {short fingerprint, with a copy button}." and, if the build has a URL, "Read the text" (opens it). Without a URL: "The person who sent you this link gave you the text." |
| Acceptance | a checkbox "I have read the text with this fingerprint." (labelled, keyboard reachable) and the button **"Accept the text and claim"**, disabled until it is ticked. Under it: "Pressing this records on the network, under your account, that you accept the text with this fingerprint. It cannot be undone." |
| Already claimed | "This grant is already claimed. You can see it in Your Shares." |
| After the press | "Claimed. Your Team Shares unlock over time." |
| Counts | "{k} of {N} grants claimed." (a total, never a name) |
| No end | "These stay open to you; there is no end date on this network." |

Presses: link, sign in (existing), tick, press: two on a phone with a passkey account (the passkey asked once; the sponsor pays),
the same with a wallet. The claim call data is built from the generated ABI, never by hand.

### 5.5 The joined-up loop and the other files

- Parse (`money/numbers-read*.ts`, strict, with hostile-record tests): `pause`, `earlierGrants`, `contracts.pause`; a hostile
  value (a parked total above the Shares, a `paused` that contradicts `pausesFrom`, a non-numeric field) makes the **key** null,
  never the whole record.
- `money/send-targets.ts`: `rememberSendTargets` gets the pause address and the claim contract; the sponsor follows them already.
- `packages/creaton-core/src/pot/`: regenerate the ABIs (`scripts/pot-app-abi.mjs`), then `parkCalls`, `unparkCalls`,
  `takeOutWithParkedCalls`, `earlierClaimCall` in `pot-calls.ts`, `parkedOf` and `pauseState` in `pot-reads.ts`, the take-out plan
  with parked Shares in `pot-plans.ts`. Their tests compare the encodings with the contracts' own build.
- `money/pot-copy.ts` (and the existing team error copy): the `Paused` refusal.
- Reuse the existing sender (`useSender`, `sendCalls`) for batches; the park flow is `approve` then `park` in one batch on the
  passkey account and two sends on an injected wallet, as the real-dollar Back is.
- **Resets.** The pause read is not cached at module level; if one is added, its reset goes into `resetCommunityState()` or the
  new app's equivalent in the same change.
- Accessibility: one owner per actionable label (the Park, Take back and claim buttons each have one name), no duplicate
  stops, the meter has a text value, the checkbox has a label, every control by keyboard, touch and pointer (tests for the
  keyboard and touch paths of the sheet and the checkbox-gated press).
- `scripts/pot-chain-loop.sh`: a second stage that deploys with `HOLDER_PAUSE=1` and invented earlier settings, parks, arms,
  waits a day (the loop's short unit), checks that `draw` and `announceTask` refuse and that a take-out batch works while
  paused, un-parks, checks the allowance comes back; claims an invented row from an invented account and checks the grant,
  the acceptance, the double-claim refusal and the vesting; `scripts/phone-loop.sh`: the same park, take-out batch and claim from
  the passkey account (one operation each).
- Playwright specs `pot-pause.spec.ts` and `pot-earlier-grant.spec.ts` at 390x844 with axe (pause card states, park, take back,
  take out with parked Shares, the team's paused sentences, the claim page states including the fingerprint mismatch).
- Docs: `TRY-IT.md` and `DEPLOY-TEST-NETWORK.md` say how to turn the switch on (`HOLDER_PAUSE=1`) and how to set the earlier
  settings, and that **both are off by default**.

---

## 6. Packages, one after another, one owner per path

Order: **K1, then K2** (both edit `Launcher.sol` and `Interfaces.sol`), **then S1** (needs the final ABI, events and the
regenerated fixture), **then A5**. Every package commits small, finished commits with the trailer; each runs the machine's wait
script before any forge or cargo command and uses `nice -n 10 timeout 1500`, cargo with `CARGO_BUILD_JOBS=2 CARGO_INCREMENTAL=0`.
Each stops and says so if free disk falls under 1.5 GB.

### K1: contracts for the pause (contracts engineer)

Owns `contracts/pot/**`: `src/HolderPause.sol` (new), `src/Treasury.sol`, `src/Launcher.sol` (pause part), `src/Interfaces.sol`,
`script/DeployPot.s.sol`, `DEPLOYMENTS.md`, `scripts/check-mutations.py`, and new test files only:
`test/HolderPause.t.sol`, `HolderPauseAttacks.t.sol` (rows 1 to 15 of section 2), `HolderPauseInvariants.t.sol`,
`PauseEventsRebuild.t.sol`, `OffIsOff.t.sol`, `GasPause.t.sol`, `SizePause.t.sol`, `LauncherPause.t.sol`, and a new helper
`helpers/PauseBase.sol` (extends the existing `StackBase`; no existing test or helper is edited).
Order of work: the contract and its unit tests, the Treasury hook and the Launcher wiring, the access tests, the attacks, the
differential, invariants and rebuild, then the mutations.
Checks: `forge fmt --check src script test`; `forge build --sizes` (**Treasury delta stated; stop and report if it is over 600
bytes or the Treasury has under 300 spare; Parts under 49,000**); `forge test` whole (all 540 old tests green and unchanged,
new ones counted); invariants at 1,000 runs; the new fuzz and attack tests at 20,000 runs once; the mutation script with at
least these new entries, **each run once and each must be killed**, result written in the report: `line-floor` (`B/3` rounded
down), `no-b-zero-guard`, `delay-zero`, `no-hidden-dip-reset` (observe-first removed), `paused-not-live` (the ratio not
rechecked), `draw-ungated`, `announce-ungated`, `park-from-argument` (park pulls from a given account), `unpark-gated` (un-park
refused while paused), `bind-twice`, `gate-fails-open` (a catch), `count-donation`. `scripts/pot-chain-loop.sh` is A5's: K1 hands
over the deploy settings and the ABI.
Report: sizes before and after, gas measured against the 1.6 estimates, the mutation list, the test counts.

### K2: contracts for earlier grants (contracts engineer, after K1)

Owns `contracts/pot/**` as K1: `src/EarlierGrants.sol` (new), `src/Vester.sol`, `src/Launcher.sol` (earlier part),
`src/Interfaces.sol`, `script/DeployPot.s.sol`, `DEPLOYMENTS.md`, `scripts/check-mutations.py`, new tests `EarlierGrants.t.sol`,
`EarlierVester.t.sol`, `EarlierLauncher.t.sol`, `EarlierMoney.t.sol`, `EarlierInvariants.t.sol`, `GasEarlier.t.sol`, helper
`helpers/EarlierBase.sol` (a tree built in memory from invented rows). Existing `Vester.t.sol`, `VesterUnit`, `Forfeit` and the
rest are not edited and must pass.
Checks: as K1, plus: **Parts creation code stated (stop under 49,000)**, the Vester's ordinary `grant` path unchanged (a test
that every old Vester test passes), `forge test` whole, and the mutation script with one new entry per check of 3.4 (`no-text-check`,
`no-bitmap`, `no-double-hash`, `no-sender-in-leaf`, `no-index-bound`, `no-pool-bound`, `no-min-row`, `reserve-ignored` in
`grant`, `start-at-claim`, `cliff-on-protected`, `reserve-burned-after-wind-down`, `bind-twice`, `earlier-bound-by-anyone`) each
killed once, result in the report. No real row anywhere: the report says how the invented rows were made.

### S1: the server (server engineer, after K2)

Owns `crates/**` and, for this round only (I assign them, since W6 does not), `scripts/chain-reader-events.mjs`,
`scripts/chain-reader-fixture.py`, `scripts/chain-reader-example-check.py`, `docs/next-version/RECORD-V2.md` and
`docs/next-version/record-v2-example.json` (the example is regenerated, not edited).
Files: `chain_reader/events.rs` (roles), `events_table.rs` and `testdata/*` (generated), `ledger.rs`, `held.rs`, `explore.rs`,
`record.rs`, `numbers.rs`, `views.rs`, `helper/calls.rs`, `helper/plan.rs`, `helper/mod.rs`, `api/sponsor.rs`,
`api/sponsor/calldata.rs`, `handlers/task_chain.rs`, `handlers/agent_label.rs`, `handlers/launch_update_authority.rs`,
`handlers/wallet_binding.rs`, `handlers/room_write.rs` (holding = balance + parked) and their tests; `config` only if a setting is
needed (none planned).
Checks: `cargo fmt --all -- --check`; `cargo clippy -p buzz-relay -p buzz-cli --all-targets -- -D warnings`;
`cargo test -p buzz-relay --lib` with filters `chain_reader::`, `sponsor`, `task_chain`, `agent_label`; the Postgres lane
(`--ignored`) for the touched files; `node scripts/chain-reader-events.mjs --check`; the fixture regenerated and
`chain-reader-example-check.py` clean; `scripts/regen-kinds.mjs --check`; the planted-row test; **each new guard switched off
once** (G7 check, the two label rules, the exit rule for `unpark`, the "no row in the record" filter, the holding rule) with the
named test failing, result in the report.

### A5: the app's screens for both, and the joined-up loop (app engineer, after S1)

Owns `app/**`, `packages/**`, `web/**` (not touched), `scripts/pot-*.sh`, `scripts/phone-loop.sh`, and the two docs `TRY-IT.md`
and `DEPLOY-TEST-NETWORK.md`.
Files: section 5. New: `app/src/features/pause/` (`PauseCard.tsx`, `ParkSheet.tsx`, `TakeBackSheet.tsx`, `pause-words.ts`,
`use-pause.ts`, tests), `app/src/features/earlier-grant/` (`EarlierGrantPage.tsx`, `earlier-grant-state.ts`,
`earlier-grant-words.ts`, tests), `app/tests/e2e/pot-pause.spec.ts`, `pot-earlier-grant.spec.ts`. Edited: `project/ProjectPage.tsx`,
`pot/YourShares.tsx`, `pot/TakeOutSheet.tsx`, `pot/takeout-read.ts`, `pot/AllowanceSection.tsx`, `pot/AllowanceSheets.tsx`,
`tasks/chain/team/PlanSheet.tsx`, `tasks/AgentCaps.tsx`, `money/numbers-read*.ts`, `money/numbers-types.ts`,
`money/send-targets.ts`, `money/pot-copy.ts`, `app/router.tsx`, `app/.env.example`, the copy-check allowlist only if a word
cannot be rewritten (reason given); `packages/creaton-core/src/pot/*` with the regenerated `abis.generated.ts`.
Checks: `biome check`, `tsc --noEmit`, `pnpm check:copy`, `check:px-text`, `check:file-sizes`, `knip`, `vitest` (all, count),
`vite build` and the bundle sizes (entry under 450,000 bytes), `scripts/pot-chain-loop.sh` (both stages), `scripts/phone-loop.sh`,
`scripts/pot-app-phone-e2e.sh`, the two new Playwright specs and the existing smoke project at 390x844 with axe (`pnpm build:e2e`
first, never `pnpm run build`), a screenshot set through `just desktop-screenshot` only if the screens run in the mock bridge.
Each guard switched off once with its named test failing: the fingerprint-mismatch refusal, the checkbox gate on the claim press,
the "no row of another person" filter, the disabled Draw and Plan presses while paused, the take-out batch order
(`unpark` before `leave`), the parse's hostile-record nulling. The report states what a person on a real phone did not do.

---

## 7. Chosen under the owner's standing go; the owner may overrule

| # | Choice | Alternative and why not |
|---|---|---|
| D1 | The pause is **one switch per deployment, off by default**, set once by the deployer in the first hour; a project is born with or without it | A per-project founder choice (a founder could pick "no stop" for every project and the stop would mean nothing); a switch the admin can flip later (it would change terms for new projects without the founders' hash seeing it; the hash does see it, but a sealed switch is simpler to explain) |
| D2 | "The Shares that backers hold" is the whole backer supply `B`, contracts' balances included; Team Shares are neither counted nor parkable | Exclude contract balances (cannot tell a person's smart account from a pool); count vested Team Shares (they are a claim above paid-in, not money in, and the plan says never) |
| D3 | The line is `3K >= B`, rounded up, observed by `park`, `unpark` and `poke`; paused needs the line **live**; a new reach is a new 24 hours; the "day" is `unit/7` | A hysteresis band (flapping defence, but it breaks "for as long as they stay parked"); a pause that needs continuous observation by a server (the helper's pokes are a help, not a rule) |
| D4 | Custody, with Take out as an un-park-and-leave batch from the holder's own account (one press on a passkey account, two confirmations on a wallet that cannot batch) | A per-holder vault that can call `leave` itself (one transaction for every wallet, but about one more engineer-week, a clone per holder and a new place for exit notes to sit); letting the pause leave for the holder (exit notes would be written to the pause contract and need an attribution ledger) |
| D5 | **The further power (end at two thirds) is left out**: it lets a buyer burn the team's unvested claim for a profit (net +32,025 on a 2,000,000 pot, section 1.9) and kills a healthy project for the fee | Include it with a keep-accrued wind-down and an announced notice: needs its own attack review and counsel; not built |
| D6 | The earlier pool is **separate from, and in addition to**, the founder's Team pool (the 100,000,000 limit applies to the founder's pool only); it is bounded by `MAX_EARLIER_POOL` = 1,000,000,000 Shares and counts in G from birth | Cut it from the founder's pool (a founder with a small pool could never honour a long list); a larger cap (the old supply is the largest number this project ever had) |
| D7 | **Unclaimed rows stay claimable for ever**, with no stated end and no sweep | A long-stop after which unclaimed Shares burn through a notice (counsel's long-stop and a joiner-pricing notice are needed; not built) |
| D8 | The text is an **opaque fingerprint** in an immutable claim contract; a new text is a new contract. The claimant names the fingerprint they accept | A keeper who may publish a new text (a mutable text is the opposite of "what was accepted"); a wallet signature over structured data in addition (a counsel point) |
| D9 | The claim is **sent by the row's own account** (`msg.sender` in the leaf); no relayed or signed claim | A relayed claim with a signature (more code, a replay surface, nothing the sponsor does not already give a passkey account) |
| D10 | A protected grant vests from **project zero's birth**, not from the claim | From the claim (late claimers vest later than early ones, against C21's text) |
| D11 | A claim is refused for a row below one whole Team Share (`RowTooSmall`), and for an account already holding 8 grants | Raise the minimum or drop the 8-grant limit (existing Vester rules; changing them is outside this round) |
| D12 | The two switches bind through one-shot, deployer-only, first-hour setters on the Launcher, not through the constructor or the Platform struct | A new constructor (breaks every test that builds a Launcher); a new `Platform` field (changes `ProjectLaunched`, the settings hash and the server's decoder) |
| D13 | The pause check **fails closed**: a gate that reverts stops `draw` and `announceTask`, never leaving | Catch and allow (a swallowed failure; the plan's rule 1) |
| D14 | While paused the box stays at its seven-day cap (accrual beyond a week is lost to the team, kept by holders); the pause does not stop settling | Stop accrual at the start of a pause (more bytes in the Treasury, which has 999 to spare) |
| D15 | The sponsor treats `[unpark, leave]` as an exit | Leave it as a normal operation (a person with parked Shares could be refused the fee on the one press that must never be refused) |
| D16 | Server: the record's pause and earlier keys are `null` on any failed check; no per-parker or per-row data ever; `grants[]` omits kind-1 grants | List them (rows in the record) |
| D17 | G7: a box-paid task's `confirm` needs the network to show a matching `AllowanceDrawn` (to the worker's named wallet, the stated amount) or the write is refused with words | Check only that the transaction exists (any transaction would pass) |
| D18 | Agent labels tie to the chain through the **wallet binding** (an account's linked wallets), not through a new tag or kind | A new profile tag naming the wallet (another thing to forge); do nothing (the limits bind only if people keep the two apart by hand) |
| D19 | The helper pokes at most 6 times a day per project, once per 10 minutes, with a terminal state | Poke on every event (an unbounded loop) |
| D20 | New app words: "park" and "pause" (plain), "Team Shares" kept where they must be named; no protocol words | "Hold" or "freeze" ("hold" is already "you hold"; "freeze" sounds like money is stuck) |
| D21 | The claim page lives at `/earlier-grant`, lazy, only with the build settings; the old `/earlier` page stays behind the legacy flag | Reuse `/earlier` (two designs on one address) |
| D22 | Ownership: K1 and K2 own all of `contracts/pot/**` (script, scripts, DEPLOYMENTS.md included); S1 owns the reader's scripts and `RECORD-V2.md` for this round; A5 owns `TRY-IT.md` and `DEPLOY-TEST-NETWORK.md` | W6 does not name these |

**Milestone 9 of `PLAN-V2.md`, recorded as replaced.** `HolderVote` (park free Shares, pause at a third, seat election, replace
vote) becomes `HolderPause`: park and pause only. The Council, seat elections, a vote to replace the runner, the reserve sale, the
turnout floors that step up by stage, the supermajority for a wind-down, and the team-payer role (`payTeam`, the team budget)
**belong to the stages, the auction and the Council runner that the new model removed** (design sections 3 and 9); there is no
stage, no auction, no Council, no reserve and no team budget to hand to a vote, and the runner's powers are bounded by the
allowance ceiling, the task caps and the notice. The requirement "votes count only Shares parked from a person's own wallet" is
kept in full: only `park` from `msg.sender` counts, and nothing a Treasury, Vester, Pair, TaskBook, claim contract or Launcher
holds can.

**Not in this round.** The end-at-two-thirds power (D5); any rule for unclaimed rows after a stated time (D7, needs counsel); a
wallet signature over structured data for the acceptance; a per-holder vault for Take out in one transaction on every wallet
(D4); stopping allowance accrual during a pause (D14); alerts that tell a holder their parked Shares reached the line (the
existing in-app alerts do not carry it; a later step); the earlier list, its attestation, the text, the entity and the pool's
size (counsel's and the owner's: **the owner must set the pool size and see the team side's share of the surplus before any real
network**); any real network, any real money, the audit; the real phone and the operator's real services, never run in this
repo. Trading and investing stay off by default. The legal line is not reworded anywhere: the app shows it word for word where it
already does, and no new screen here changes or hides it.
