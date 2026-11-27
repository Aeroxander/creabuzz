# Step 4 plan: the holder pause (milestone 9 in the new model) and earlier grants

Status: a plan. **Nothing in it is built.** Written 21 November 2026 on branch `v6` at `1fed95002`, under the owner's standing
go (keep working, no questions); the owner may overrule any choice in section 7. It builds what two rounds of the design
left open: W1, the holder pause (the fallback the design names for counsel's question 4), and W2, the earlier backers'
protected grants (design section 6, choice C21). It adds server and app parts for both. It changes no existing money rule:
**with the pause switch off and no earlier-grant settings, every contract behaves as verified at `1fed95002`** (section 1.8
says how that is proved; the one measurable difference with the switch off is a little more gas on `draw`, `announceTask` and
`join`, section 1.6). **Second author's revision:** this version answers two reviews (a contracts review and a fit review) of
commit `bccfbf209`; section 8 lists every finding, whether it held, and what changed. Not legal or tax advice. No figure here is a promise or a forecast of any result for anyone.

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
- `docs/archive/EARLIER-BACKERS.md`: the old list, text, signing and claim design (now parked in `contracts/next`).
- `POT-STEP1A-REPORT.md`, `POT-STEP2-REPORT.md` and every file in `contracts/pot/src`, `contracts/pot/script/DeployPot.s.sol`,
  `contracts/pot/DEPLOYMENTS.md`, and the built sizes in `contracts/pot/out` (read, not rebuilt).
- `docs/next-version/RECORD-V2.md`, the chain reader (`crates/buzz-relay/src/chain_reader/`), the sponsor (`api/sponsor*`), `handlers/task_chain.rs`,
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
| Passkey account | sends a batch of calls as one operation, one passkey prompt (`sendCalls`) | `docs/next-version/PHONE-PATH-REPORT.md` |
| Sponsor | an operation is an "exit", never refused by a limit, only when **every call** is `leave` or `leaveTeam` on a followed Treasury | `api/sponsor/calldata.rs` `is_exit` |
| App entry chunk | 434,834 of 450,000 bytes | phone path report |

Because the Treasury has 999 bytes left and Parts has 1,445, **both features live in new contracts**, and the Treasury and
Vester take only the smallest hooks (section 1.2 and 3.2). Product check (`VISION.md`, `VISION_PROJECTS.md`): neither feature
touches the relay's workspace model; both add power to the people who put money in, which is the direction of the design
("governance and exit"). Two tensions, stated. (1) A holder pause is the nearest thing to a vote that the design allows, and the
design's default stays "no vote": **the switch is off in every deployment unless the deployer turns it on**. (2) `PLAN-V2.md`
called it "a stop backers cannot lose". **The code gives less than that and the plan says so:** a third parked stops the team's
draws and new plans, with no counter-vote, but anyone with money (the team included) can lift it by backing more, for the 2% fee
on the money that lifts it (section 2, rows 3 and 16). What is true is "nobody votes no, and nothing but money joining or
Shares coming back ends it". Every word of copy in the app uses that, never "cannot lose".

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
| `contracts/pot/src/Treasury.sol` | (a) `address public pauseGate;` appended after `arrivalTotal`; (b) `function bindPause(address gate) external` (only `salePath`, once, non-zero) emitting `PauseReady(address gate)`; (c) a private `_notPaused()` that does `if (pauseGate != address(0) && IHolderPause(pauseGate).paused()) revert Paused();`; (d) one call to it in `draw` (after the auth checks and `_settle()`, before any state change) and one in `announceTask` (after `_openWindow()`); (e) `error Paused();`; (f) in `_join`, **after** `shares.mint(to, n)`, `if (pauseGate != address(0)) IHolderPause(pauseGate).poke();` (the one place backer Shares are ever minted, so the one place the line can fall without a call of the pause's own; D3 and row 12) | **+400 to 500 bytes** (999 to spare today) |
| `contracts/pot/src/Interfaces.sol` | `IHolderPause { paused() }` and `bindPause` on a small `ITreasuryPause` | none |
| `contracts/pot/src/Launcher.sol` | `address public immutable deployer; uint64 public immutable deployedAt;` (set in the constructor); `address public holderPauseImpl;` and `bindPause(address impl)` (deployer only, once, within 1 hour of deployment, impl must have code; emits `HolderPauseBound(impl, impl.codehash)`; a project launched before the switch is bound simply has no pause, by design (D1), and a test says so); in `launch`, `if (holderPauseImpl != address(0))` clone it, `initialize` it, `Treasury.bindPause(clone)`; `settingsHash()` keeps its old formula when nothing is bound and adds the bound addresses when something is | +about 500 bytes (6,650 today) |
| `contracts/pot/script/DeployPot.s.sol`, `DEPLOYMENTS.md` | `HOLDER_PAUSE` setting (default 0); when 1: `new HolderPause()` and `launcher.bindPause(impl)` **in the same broadcast as the Launcher's own deployment, before any launch is possible** (DEPLOYMENTS.md states the order and lists the expected `HolderPause` code hash from the build, so a person can compare it with `HolderPauseBound`); the addresses go into `deployments/pot-<chain>.json` | none |

`Launcher.launch` has `via_ir` on (`foundry.toml`), so the extra locals of K1 and K2 carry no stack-too-deep risk (checked). `Treasury.initialize`, `Setup`, `Launcher.launch`'s signature and return values, `ProjectLaunched`, `Platform`, the constructor of
`Launcher` and every function not named above are unchanged, so every existing test compiles and passes untouched.

**The switch.** `holderPauseImpl == address(0)` is the default and means: no clone is made, `Treasury.pauseGate` stays zero, and
the three checks (`draw`, `announceTask`, `_join`) are one storage read that finds zero. The switch is set once, by the deployer, in the first hour, and can never
change; a project is born with or without a stop and keeps it (D1). (The deployer is an immutable set in the constructor; the
setter is sealed after one call or one hour, so a stolen key later cannot turn it on for new projects.)

### 1.3 The rule, exactly

- **B**, "the Shares that backers hold": `shares.totalSupply()`, the backer ShareToken's supply. It counts every backer Share in
  existence: in wallets, in contracts (a pool, a lender), and the ones parked. It never contains a Team Share, vested or not
  (that is another token), and it is not reduced by any contract's balance (D2: a contract's Shares cannot be told from a
  person's smart account; leaving them in B only makes the line higher, which protects the team).
- **parked (K)**: `HolderPause.parkedTotal`, the sum of what `park` put in and `unpark` has not taken out. Only `park(n)`
  changes it. Shares sent straight to the contract (a donation) are not parked and count nowhere.
- **The line**: `3 x K >= B` and `B != 0`, that is `K >= ceil(B / 3)` (`line()` returns `(B + LINE_DIVISOR - 1) / LINE_DIVISOR`,
  with the public constant `LINE_DIVISOR = 3`, so the record and the app can read "a third" instead of typing it). One third,
  rounded up.
- **Arming and the 24 hours.** `armedAt` is the second the line was first *seen* reached in an unbroken run. `park`, `unpark`
  and `poke()` (permissionless; **the Treasury also calls it in every `_join`**, section 1.2 (f)) each look first (a step
  called **observe**): if `3 x K < B` they clear `armedAt`; they then apply their change; then if the line is reached and
  `armedAt == 0` they set it to now. **Every way the ratio can fall is therefore seen at the moment it happens:** the ratio
  falls only when B rises (the one mint of backer Shares is `_join`, which calls `poke()` after the mint) or K falls
  (`unpark`, which observes). The ratio can rise without a call of the pause's own only when B falls (a `leave`); that can only
  *start* a clock late (nobody has armed it yet; `poke()` arms it, the helper does), never count a day that nobody saw. So **a
  pause never begins without a full, seen, unbroken day of the line** (D3; the review found that, without the join hook, a dip
  nobody poked left an old `armedAt` standing, which is what the hook closes).
- **Paused** (`paused()`, a view): `armedAt != 0 and now >= armedAt + day and 3 x K >= B and B != 0`, with **day = unit / 7**
  seconds (24 hours on a real network, where N is 7 days; 4 minutes when N is 1,680 s, so a demo works). The last two
  conditions are read live as a safeguard (with the join hook they cannot disagree with `armedAt` at the end of any
  transaction: invariant, section 2; `paused-not-live` is therefore an expected equivalent mutation, K1 records it as such unless
  a test finds a path).
- **It ends the moment** parked is under the line. There is no memory: a new reach is a new 24 hours.
- **What lifts it, said plainly.** Parked Shares coming back, or B rising: any `join`, by anyone, including the team, in the same
  transaction as a `draw` (row 16). The pause is a stop that holders can keep and that money can lift for the fee on the money
  that lifts it. It is not a stop "backers cannot lose".
- **No part of the rule counts**: an account, a count of people, a Treasury, Vester, Pair, TaskBook or Launcher balance, Team
  Shares, or any Share not put in by `park` from the caller's own wallet (`park` pulls from `msg.sender` only, with the
  caller's own allowance: there is no "from" argument and no way to park for someone else).

`HolderPause` functions (all external):

| Function | What it does | Reverts when |
|---|---|---|
| `initialize(IShares shares_, uint32 unit_)` | once, by the Launcher in the launch transaction; stores the token and `day = unit_/7` | already born; `unit_` zero or not a multiple of 168 |
| `park(uint256 n)` | observe; pull `n` of the caller's backer Shares (needs the caller's allowance to this contract); `parkedOf[caller] += n; parkedTotal += n`; arm if the line is reached | `n == 0`; no allowance or balance |
| `unpark(uint256 n)` | observe; `parkedOf[caller] -= n; parkedTotal -= n`; send `n` Shares back to the caller; disarm if under the line | `n == 0` or more than the caller parked. **No other condition: not the pause, not a door, not a wind-down, not a delay** |
| `poke()` | anyone, and the Treasury after every mint of backer Shares: observe and re-arm or disarm; changes nothing else; it cannot revert in the real contract (it reads one supply and writes one slot). A gate that does revert here stops joins as well as draws: it fails closed (D13), and never stops leaving | nothing (emits only when `armedAt` changed) |
| views | `LINE_DIVISOR()`, `parkedOf(a)`, `parkedTotal()`, `armedAt()`, `day()`, `line()`, `paused()`, `pausesFrom()` (`armedAt + day` or 0), `state()` (K, B, line, armedAt, pausesFrom, paused in one call) | |

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

The Treasury reads `IHolderPause(pauseGate).paused()` in two functions and calls `poke()` in `_join`. Gas (estimates from the EIP-2929
cold-access prices: 2,100 a storage read, 2,600 for a cold address; K1 measures them in `GasPause.t.sol` and the report states
the measured figures):

| Existing call | Switch off | Switch on, nothing armed | Switch on, line reached |
|---|---|---|---|
| `draw`, `announceTask` | about **+2,150** (one read of `pauseGate`, finds zero) | about +11,000 (gate read, clone call, delegate call, `armedAt` read) | about +18,500 (also `parkedTotal` and `shares.totalSupply()`) |
| `join` and the call-back join (both reach `_join`) | about **+2,150** (the same read) | about +9,000 (gate read, `poke()` that reads the slot and the totals) | about +20,000 (a first arming also writes `armedAt`) |
| every other Treasury, Vester, Pair, TaskBook, ShareToken call (`leave` and `leaveTeam` included) | **0** (no new instruction runs) | 0 | 0 |
| `Launcher.launch` | about +4,300 (two reads of a zero address, `holderPauseImpl` and `earlier`; K1 and K2 state the measured figure) | about +120,000 (clone, initialize, bind) | same |

Gates in the tests: off at most +2,500 on `draw`, `announceTask` and `join`; on at most +25,000. **The baseline is absolute, not
relative** (the review found no old-build number in the repo): before editing anything, K1 runs the existing `Gas.t.sol` and
`GasTasks.t.sol` at `1fed95002`, records the gas of `join`, `draw` and `announceTask` in the report, and `GasPause.t.sol`
pins `new <= recorded + 2,500` as constants.

### 1.7 Events

| Contract | Event | Meaning |
|---|---|---|
| `HolderPause` | `Parked(address indexed who, uint256 amount, uint256 parkedBy, uint256 parkedTotal, uint256 backerShares, uint64 armedAt)` | Shares were parked; the numbers after |
| `HolderPause` | `Unparked(address indexed who, uint256 amount, uint256 parkedBy, uint256 parkedTotal, uint256 backerShares, uint64 armedAt)` | Shares were taken back |
| `HolderPause` | `Observed(uint256 parkedTotal, uint256 backerShares, uint64 armedAt)` | `poke` found `armedAt` changed (emitted only then) |
| `Treasury` | `PauseReady(address gate)` | once, in the launch transaction: the reader finds the pause from it (as it finds the task book from `TasksReady`) |
| `Launcher` | `HolderPauseBound(address impl, bytes32 codehash)` | once, the deployment's switch; the code hash lets a person compare the bound code with the build |

The rule that a pause *starts* is a time and a ratio, not an event: the reader works it out from `armedAt`, `day` and the live
numbers, and checks the answer against the view `paused()` at the same block (as every other number).

### 1.8 With the switch off, nothing differs: the proof

1. **By construction:** every new instruction is behind `pauseGate != address(0)` or `holderPauseImpl != address(0)`. Both are
   zero when nothing is bound. What does change with the switch off, and is stated rather than hidden: the bytecode and ABI
   grow (additive: `pauseGate()`, `bindPause`, `PauseReady`, `Paused`, `holderPauseImpl`, the Vester's new functions), and
   `draw`, `announceTask` and `join` cost about 2,150 gas more (one storage read).
2. **By the old tests:** the 540 existing tests, the 11 invariants, the vectors, the 124 mutations and the chain loop's 24
   checks run **unchanged** (K1 edits no existing test file; new files only) and stay green.
3. **By a new differential test** (`OffIsOff.t.sol`): the same fuzzed sequence of 120 steps (joins, take-outs, draws, tasks,
   check-ins, grants, wind-down, lapses) runs on a stack with the switch off and on a stack with the switch on where nobody
   parks; after every step every public view of the Treasury, Vester, TaskBook and both tokens is equal. This proves the
   gate is inert unless Shares are parked (the review's point: it does **not** by itself prove the old bytecode's behaviour;
   that is what points 1, 2 and 4 are for, and the old 540 tests are the witness).
4. **By two literal checks:** `Treasury.pauseGate()` is zero on every project of a switch-off deployment, and
   `Launcher.settingsHash()` equals `keccak256(abi.encode(platform))` (the old formula) when nothing is bound.
5. **By the size gate:** `Size.t.sol` (existing, unchanged) must pass; a new `SizePause.t.sol` states how many bytes the
   Treasury, Launcher and the new contract took, and fails if the Treasury leaves under 300 bytes spare or Parts under 400.
6. **By the generated tables:** `the_table_is_the_forge_build` and the events table compare a recorded file, so they stay
   green until S1 regenerates them; the claim "the ABI the reader decodes is unchanged" is **not** made: it is additive.

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
up, not lost. **The benefit side (the review's point; the first version left it out):** while paused the box stays at its cap,
so what the allowance would have taken each day (0.10% of the pot a day; 0.20% at the ceiling) is returned to the pot, and it
is shared by every backer (and by the Team Shares, since it arrives as surplus: the backers' part of a surplus is `b / (b + g)`,
`PotMath.cash`). For a holder of a third of the backers' Shares, the daily gain is about `1/3 x 0.10% x 1.5 x P0 x b/(b+g)`, which
is **5 a day on a 10,000 pot and 500 a day on 1,000,000 (when `g` is small; about 14 percent less when `g` is a sixth of `b`)**.
Against a fee of 102 / 10,204 the break-even is **about 20 to 25 days** of keeping the pause on. So for any backer group the pause
is a net gain after about three weeks, whatever its intent, **and every other backer gains the same way and pays nothing**.
That changes row 3's defences: "anyone backs more to dilute it" asks a free rider to pay for what already pays them; only the
team, whose income it stops, has a reason to, and it can (row 16). The team's loss is the allowance it cannot draw. While paused the box stays at its seven-day cap, so the team
loses accrual beyond one week: 0.10% of the pot a day (0.20% at the ceiling) of the new pot. Arithmetic, plain Python; K1's
tests check the fee and round-trip numbers exactly (`HolderPauseAttacks.t.sol`).

| # | Attack | Cost to the attacker, pot 10,000 / 1,000,000 | What the team and other holders can do | Defence in the code | Test that holds it |
|---|---|---|---|---|---|
| 1 | **A late large buyer** (milestone 9's first) joins big to reach a third and park | Fee **102 / 10,204** (net in 5,000 / 500,000; gross 5,102 / 510,204), **recouped in about 20 to 25 days by the allowance the pause keeps in the pot** (benefit paragraph above). Money tied up, returned at face | Wait; talk to the holder; the box (up to 7 days of allowance) can still be drawn during the 24 hours; ask holders to back more (row 3); the project's money is never at risk | Pause only stops `draw` and `announceTask`; leaving is never slowed; 24 hours' warning; live ratio | `test_lateWhaleCostsOnlyTheFee`, `test_whaleRoundTripReturnsNinetyEightPerHundred`, `test_pauseStartsOnlyAfterADayOfSeeingTheLine` |
| 2 | **A founder with many accounts** (milestone 9's second): the team backs through 20 accounts to park a third and pause itself or a co-signer | No cheaper than one account: parking counts Shares, not accounts. Fee 2% of the money, same 102 / 10,204 for the same third | Nothing needed: the only target is the team's own spending. A founder cannot use accounts to *avoid* a pause either: Shares count, not heads | `park` counts Shares from `msg.sender` only; no per-account rule exists to dodge | `test_manyAccountsCostTheSameAsOne`, `test_splittingSharesAcrossAccountsChangesNothing` |
| 3 | **A whale parks to grief the team** and holds it | Fee **102 / 10,204** for the first third; to keep it as others add money, **half** of what they add (to stay at a third: `y >= x/2` for every `x` added), each with a 2% fee on new money. **But the whale is paid while it holds it** (the allowance the pause keeps in the pot, break-even about 20 to 25 days), so for the whale holding is net positive after that. Allowance cost to the **team**: up to 15 a day / 1,500 a day at 0.10% (30 / 3,000 at the ceiling) beyond the first week | **Dilute:** the team (or anyone) backs more so that parked falls under a third. Worked: the whale holds 40% (they put in 6,667 / 666,667, fee 136 / 13,605); the other side needs to add 3,333 / 333,333 net, fee **68 / 6,803**, to push the whale under a third, and that money is real backing the project keeps. The fee goes to the platform's address (a deployment setting; on a team-run deployment that is the team). Other backers have no reason to pay for it (they gain from the pause too): **the realistic defender is the team**. **Wait** for the whale to tire. **Leave**: a holder who dislikes the freeze takes their slice out at face, which lowers B and so *raises* the whale's share (row 11): leaving does not end a pause, it can strengthen it | The line is a live ratio of all backers' Shares; the pause pays nobody; nothing is locked for leavers | `test_dilutionEndsThePauseTheSameBlock`, `test_whaleAtFortyPerCentNeedsTwentyPerCentOfPotToBeDiluted`, `test_pausedAllowanceReturnsToPotAndRaisesEveryTakeOut` |
| 4 | **Park and un-park flapping around the line** to start and stop the pause, or to wear out the team's alerts | Gas only | A holder-side flapper cannot make a pause shorter than 24 hours of an unbroken line, nor keep one past a dip. **The team as flapper** (join, `poke`, leave in one transaction) can reset the clock each day for the fee on the margin: row 16. The app shows the state, not every flap (it reads the state, and the helper pokes at most once per project per 10 minutes) | Observe-first clears `armedAt` on any seen dip, **including the dip a join makes (the hook in `_join`)**; a pause needs the line live; a new reach is a new 24 hours | `test_flappingNeverPausesBeforeADayOfUnbrokenLine`, `test_aTopUpAfterAnUnseenDipRestartsTheDay` (binds D3), `test_pausedEndsTheSecondParkedFallsUnderTheLine` |
| 5 | **Parked Shares then sent** | The Shares are not in the wallet; they cannot be sent. Taking them back and sending them ends their count at once | Nothing needed | Custody; `unpark` returns only to the parker | `test_parkedSharesCannotBeSent`, `test_unparkThenSendEndsTheCount` |
| 6 | **Parked Shares then taken out** (to dump the stop while taking money) | None: Take out is never slowed; un-park and leave are one batch; the exit note is written to the holder | The line falls as B falls: a take-out by someone else can *bring a holder's parked Shares to a third*: row 11 | `unpark` has no condition; `leave` never reads the gate | `test_takeOutWithParkedSharesPaysTheQuoteInOneBatch`, `test_exitNotesGoToTheHolderNotThePause`, `test_unparkWorksWhenPausedWoundDownAndShut` |
| 7 | **A pause aimed at a task mid-notice** | None needed: it does not touch it | The task is taken, accepted, rejected and returned as if nothing happened | `takeTask`, `acceptTask`, `rejectTask`, `cancelTask`, `returnTask` and `claimNote` read no gate | `test_aTaskAnnouncedBeforeThePauseCanBeTakenAndPaidDuringIt`, `test_everyOtherCallWorksWhilePaused` |
| 8 | **The team parks its own vested Shares** | Team Shares are another token, never accepted by `park`, never in B or parked. A team member who also backed with their own money may park those backer Shares (fee 2%) and so pause the team (themselves, a co-signer, an agent) | A Pair's other signer can pause the first signer's draws only by paying the same price as anyone | `HolderPause` only handles the backer token; vested or unvested Team Shares appear on neither side | `test_teamSharesCannotBeParkedOrCounted`, `test_aTeamDonationOfTeamSharesChangesNothing` |
| 9 | **Parking through a contract** (a vault or lender parks what it holds; a smart account; a flash lender) | A contract that parks counts once, for the Shares it holds, like any holder. A flash-lent third cannot be held 24 hours (the loan must be repaid in the same transaction; a longer loan costs its interest, which is the same as buying). A contract cannot park Shares it was not given allowance for | Same as row 3 | Custody pulls only from `msg.sender`; the 24-hour unbroken line; a donation is not parked | `test_aContractParksOnlyWhatItHoldsAndItCountsOnce`, `test_aOneBlockLoanNeverArms`, `test_noOneCanParkForSomeoneElse`, `test_aDonationIsNotParked` |
| 10 | **Parking from a Pair, an agent or the Treasury** | Not special: only backer Shares a holder parks count; the Treasury, Vester, Pair and TaskBook hold none and cannot park | | | `test_projectContractsCannotChangeTheCount` |
| 11 | **Others leaving lets a small holder reach the line for free** (a ratio, not a bug) | 0: a holder at 27% of B reaches a third when holders of 25% of the Shares take out (B falls to 81% of before) | The team can back more; the holder was always going to be a third once others left | `3 x K >= B` is live; `poke()` makes it seen | `test_othersLeavingCanBringAHolderToTheLine` |
| 12 | **A hidden dip and recovery** (the review's finding: with no hook, a joiner pushes parked under the line, a leave brings it back, nobody calls anything, and the old `armedAt` starts a pause with no day of warning; a holder who takes out "because they dislike the freeze" does exactly the leave) | **Closed by the join hook:** the join that makes the dip calls `poke()`, which sees `3K < B` and clears `armedAt`; the later recovery arms a new clock; no pause starts before a new full day | Nothing needed; the helper's `poke` is now only for the leave direction (arming a clock late), not for correctness | `_join` calls `poke()` after the mint; observe-first in `park`, `unpark`, `poke` | `test_dipThroughAJoinIsRecordedWithoutAPoke`, `test_aDipByJoinThenLeaveNeverPausesWithoutANewDay`, `test_pokeArmsALineReachedByLeaving`, invariant "armedAt non-zero implies the line is reached" |
| 13 | **The gate fails or lies** | | A broken gate fails **closed**: `draw` and `announceTask` revert; no money is ever stuck (leaving does not read it). The real contract has no owner, no upgrade and one external read that cannot revert | `_notPaused` does not catch | `test_aRevertingGateStopsOnlyDrawAndAnnounce` (a mock gate bound through the Launcher) |
| 14 | **Using the pause to steal** | None possible: it holds no dollars and never calls the Treasury | | `HolderPause` has no payable function and no dollar address; Treasury buckets are equal before and after any park, unpark or poke | `test_parkMovesNoDollars`, the invariants (below) |
| 15 | **A task announced in the 24 hours of warning** | | It stands: its notice runs and it can be taken after, as in row 7. That is the price of "24 hours later". An announcement can be for up to 5% of the pot, each | | covered by row 7's test |
| 16 | **The team dilutes in the same transaction as the draw** (the review's finding; a passkey batch `[approve, join, draw, leave]`, or a contract, or three ordinary transactions: the Shares keep their face value, so there is no price risk) | The fee, on the margin only. With holders a margin `e` over the line the team must lift B by `e x B`: net in `e x P0`, fee `0.0204 x e x P0` (arithmetic). **Pot 10,000: 2 / 20 / 102** at margins 1% / 10% / 50%. **Pot 1,000,000: 204 / 2,041 / 10,204.** It unlocks the whole box (up to 0.7% of the pot: 70 / 7,000) and any number of `announceTask` | None needed: this is the team using the rule as written. Said plainly: **the stop's strength is how far over a third is parked; lifting it costs the fee on the margin to anyone, the team included.** The same sandwich with `poke()` resets the clock each day for that fee. A time-persistence rule would not help (a held dilution costs the same 2%) | The pause is not a promise that the team cannot spend. It cannot pay anyone and cannot touch Take out; it is a speed bump whose height is the parked margin | `test_oneTxJoinDrawLeaveLiftsAPause` and `test_oneTxSandwichResetsTheDay` (assert the exact cost, so the claim is pinned and cannot silently change), `test_teamDilutionCostMatchesTheFormula` |
| 17 | **The team appeases or is extorted** (a holder parks to obtain Team Shares or a grant) | None to the holder | The pause pays nobody, but `grantTeam` still works, so a team could choose to appease a holder. The plan does not prevent a team from choosing to; the holder gains nothing the contracts give | No payment path exists from the pause | covered by row 14's test |

**What a determined whale can still do, and what it costs them (said plainly).** For as long as they keep a third of all backers'
Shares parked and the team does not dilute them, a whale can **stop the team drawing its allowance and announcing new tasks**. They
cannot take any money, stop anyone taking money out, change a rule or touch a task already announced. It costs them the 2% fee on
the money they put in (102 on a pot of 10,000; 10,204 on a pot of 1,000,000, arithmetic) and the money tied up (5,102 or
510,204, returned at face if they leave); **and it pays them back** (the allowance stays in the pot: break-even about 20 to 25
days). If they buy a third from others on a market rather than at the door there is no fee at all and the cost is the pool's own
spread (a pool is not built by Creaton in version one). The team loses its allowance beyond the box's week: 15 a day or 1,500 a day
at 0.10%. **The only strong defence is more money joining**, and the party with a reason to pay for it is the team (row 16);
**the pause is a speed bump the team can pay to lift, and an attractive thing for any backer group to hold. Tell the owner both.**
It is not a stop "backers cannot lose". The words in the app never say parking protects anyone's money.

**Invariants (`HolderPauseInvariants.t.sol`, 256 runs of 200 steps, a handler with six actors and the whole stack; the handler's
actions include join, leave, park, unpark, poke, draw and time):** `parkedTotal`
equals the sum of every `parkedOf`; the contract holds at least `parkedTotal` Shares; `parkedTotal <= B`; **at the end of every
transaction `armedAt != 0` implies `3 x K >= B`** (the join hook's invariant: no unseen dip); `paused()` is never true
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
| `contracts/pot/src/Vester.sol` | `address public earlier; uint256 public earlierReserve; uint64 public earlierStart;` and `initializeWithEarlier(treasury_, team_, pool_, earlier_, earlierPool_)` (the same checks as `initialize`, funded `pool_ + earlierPool_`, only the Launcher in the launch transaction as today); `grantProtected(address member, uint256 amount)` (only `earlier`; needs `amount <= earlierReserve` else `NotFunded`; moves `amount` from the reserve into `committed`; makes a protected grant whose clock starts at **`earlierStart`, the project's birth**, not at the call); the ordinary `grant` now needs `balance >= committed + earlierReserve + amount`; `burnUngrantedAfterWindDown` leaves the reserve out. `grant` becomes a thin wrapper over a private `_grant`. **Two separate counters, `_ordinaryCount[member]` and `_protectedCount[member]` (the review's blocker B1, section 3.4):** `grant` checks only the ordinary count against `MAX_GRANTS_PER_MEMBER` (8, as today), `grantProtected` checks only the protected count against its own `MAX_PROTECTED_PER_MEMBER` (8, which only earlier claims can fill); `_ids[member]` keeps both kinds, so `exitAll`'s loop is bounded at 16 and skips protected ones. `initialize` is untouched | Vester +about 450 bytes (7,355); **Parts +about 450 (and +about 350 from K1's Treasury): about 48,500 of 49,152** |
| `contracts/pot/src/Launcher.sol` | `address public earlier; bytes32 public earlierKey;` and `bindEarlier(address earlier_)` (deployer only, once, first hour; `EarlierGrants(earlier_).launcher() == this`); `bindEarlier` **reverts if `_projects[earlierKey].treasury != address(0)`** (the review: a project zero launched before the claim contract was bound could never have the pool, and nothing would say so), and the deploy script binds in the same broadcast as the Launcher's deployment, before any launch; in `launch`, when `earlier != 0 and key == earlierKey`: the Team token is initialised with `terms.teamPool + earlier.total()` minted to the Vester (the token's own `initialize` amount), call `initializeWithEarlier`, then `EarlierGrants.bind(vester)`; `settingsHash` includes `earlier` when bound; events `EarlierBound(address earlier, bytes32 key)` and **`EarlierPoolFunded(bytes32 indexed key, address vester, uint256 amount)`** (emitted in the launch transaction, so the reader can seed the project's Team supply, section 4.3) | +about 500 bytes |
| `contracts/pot/src/Interfaces.sol` | `IVester.grantProtected`, `IEarlierGrants` | none |
| `contracts/pot/script/DeployPot.s.sol`, `DEPLOYMENTS.md` | the settings below | none |

The Treasury is **not** touched by this feature (it has too little room, and it needs nothing: it makes no protected grant).
(K1's pause edits to the Treasury and Launcher are separate and come first.) Team Shares counted in G include the earlier pool from birth, exactly as every unvested Team Share is, so a joiner's price and a
take-out are computed on the whole Team supply as today. `Treasury.agentTeam` (agent Team Share limit) is `terms.teamPool / 1000`
as now: the earlier pool never enlarges an agent's limit.

### 3.3 Which pool, and how it is funded at project zero's launch

A separate pool: **`earlierPool` Team Shares, minted to the Vester in the same `launch` transaction as `terms.teamPool`**, only
for the one project whose key is `earlierKey` (project zero, named by the deployer by its founder and project id). They are in
the Vester but not "committed", so the **reserve** (`earlierReserve`) keeps them out of reach: the runner, a Pair or an agent
cannot grant them with `grantTeam` (the ordinary grant checks the reserve). Each protected grant moves its amount out of the
reserve into `committed`. After a wind-down the reserve is not burned (a protected grant is never burned, and a claim after a
wind-down still works: `test_claimAfterWindDown` states it). The pool size is the
claim contract's `total` (a setting; the owner's number, not chosen here); `Launcher.MAX_EARLIER_POOL` = 1,000,000,000 Shares
(the old supply) bounds it, and **the deploy script refuses a pool over the founder cap (100,000,000 Shares) unless
`EARLIER_ALLOW_LARGE=1`** (the contract's cap is ten times the founder's; a default that large should be a stated choice).
**The team pool's own limit of 100,000,000 is unchanged and is separate** (D6).

**What the earlier pool does to the surplus, for ever (the review's point, with the contract's own formula `PotMath.cash`).**
The earlier pool counts in G from birth, claimed or not. A backer's take-out is `n x paidIn / b + n x s / (b + g)`: paid-in
first, then **only the part of any surplus `s` above paid-in is shared with every Team Share**. So backers keep their priority on
what they put in; what shrinks is their slice of the surplus, to `b / (b + g)`. Worked (backers' Shares `b` = 60 million, the
founder's Team pool 10 million, plain arithmetic): founder's pool only, backers get 85.7% of a surplus; with an earlier pool of
100 million (the script's default ceiling) 35.3%; with 1,000 million (the contract's ceiling) 5.6%. The unclaimed part is the
worry: it never burns, so after a wind-down it keeps a slice of the surplus that nobody will ever take (D7 and 3.6). K2's
`EarlierMoney.t.sol` computes and prints this split for the pool it tests, with every row unclaimed and with every row claimed,
and `test_afterWindDownUnclaimedReserveKeepsDiluting` pins the figure. The project page's line about the team side's share of a
surplus must read the Team supply that includes the earlier pool (S1 seeds it, 4.3); A5 checks that component for project zero.
The claim page does not mention the dilution; the owner must see the figures above before any real network (section 7).

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
**The grant limit, fixed after both reviews found the same hole.** In the first version a claimant holding 8 ordinary grants could
not claim, and the runner (or any agent inside its daily Team Share limit) can give any listed account 8 ordinary grants of one
whole Team Share each (`grantTeam` reaches `Vester.grant`, minimum one Share), which would make the row unclaimable for ever: it
defeats what a protected grant is for. So the earlier path has its own counter (section 3.2): ordinary grants fill only the
ordinary count, claims fill only the protected count (8 per member: two rows of one account and more are allowed up to 8). The
Vester's existing guards are otherwise unchanged: a protected grant can never be announced, forfeited, trimmed by a hand-over,
or burned after a wind-down (`ProtectedGrant` reverts stay as they are). Tests: `test_runnerFillsEightOrdinarySlotsThenTheClaimStillWorks`,
`test_ninthProtectedGrantReverts`, `test_ordinaryGrantsAreStillCappedAtEight`, and the mutation `protected-uses-ordinary-cap`.

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
alternative the task allows: **unclaimed rows stay claimable, with no end time and no sweep** (D7), **also after a wind-down**
(`claim` and `grantProtected` have no wind-down check; `burnUngrantedAfterWindDown` leaves the reserve out). Unclaimed Shares
stay in the Vester's reserve, count in G, and never become anyone else's; **after a wind-down they keep diluting the backers'
surplus for ever (section 3.3 gives the figure), where an ordinary ungranted pool would have burned** (the first version said only
"stay in G"). Two options, both for the owner and counsel: (a) as built, with the figure pinned and told; (b) an announced burn
after a stated time (a notice of one unit, joiners priced as burned, the forfeit path), **not built**. The app says nothing about
an end date: whether the grant ever ends is counsel's (section 3.8), and the page's words come from `earlier-grant-consent.ts`
(5.4).

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
- `EarlierVester.t.sol`: the B1 tests of 3.4; `grantProtected` only by `earlier` (not by the Treasury, the runner, an agent or a stranger); the
  vesting is **calendar from birth** (0 at birth, about half at day 182, all at day 365, no cliff, claimable in parts by anyone
  sending to the member); `GrantMade` kind 1; the ordinary `grant` and an agent's grant cannot spend the reserve (the runner
  grants the whole ordinary pool and the next grant reverts `NotFunded`); protected grants survive `announceForfeit`,
  `announceByRunner`, `exitAll` (the hand-over trim), `burnAfterWindDown` and the ungranted burn, which leaves the reserve;
  `initializeWithEarlier` only once and only with the funded amount.
- `EarlierLauncher.t.sol`: `bindEarlier` is deployer-only, once, inside the first hour, **refuses when project zero's key is already launched (`test_bindEarlierRefusesAfterTheKeyLaunched`)**, and checks the claim contract's launcher; `bindPause` after a launch leaves that project without a pause (`test_projectLaunchedBeforeBindPauseHasNoPause`); `EarlierPoolFunded` is emitted once, with the pool;
  launching under `earlierKey` mints pool plus earlier pool, calls `initializeWithEarlier` and `bind`; another key launches as
  before; the founder of `earlierKey` cannot be impersonated (`keyOf` uses `msg.sender`); `settingsHash` changes when bound and
  is the old formula when not; with nothing bound, a full launch gives `earlier() == 0` and `Vester.earlierReserve() == 0`.
- **A money test that must bind:** an earlier holder with everything vested and claimed leaves with `leaveTeam` while the pot is
  at or under paid-in and gets **zero**; above paid-in they get exactly the Team formula's share; backers' take-out value is
  unchanged by claims (`test_earlierSharesNeverReachBackersPaidIn`); `test_claimAfterWindDown` (a claim still works after a
  wind-down, and the grant is not burned) and `test_afterWindDownUnclaimedReserveKeepsDiluting` (the pinned split of 3.3).
- The invariants (`PotInvariants`, new `EarlierInvariants.t.sol` on a stack with the claim contract): the Vester always holds
  `committed + earlierReserve + ungranted`; `claimedTotal <= total`; Team supply never grows after birth.
- Gas: a claim with a proof of depth 20 is measured and stated.
- `DeployPotSettings.t.sol` (K1 writes it for the pause, K2 extends it; **new file, the review found the script had no test until A5's chain loop**): runs `new DeployPot().run()` in-process with `vm.setEnv`: default (nothing set) gives `holderPauseImpl() == 0` and `earlier() == 0`; `HOLDER_PAUSE=1` binds; **one earlier setting without the others reverts**; all set binds; `EARLIER_TOTAL` over the founder cap reverts unless `EARLIER_ALLOW_LARGE=1`; `deployer()` is the broadcaster and the binds land inside the first hour. Each of K1 and K2 also runs the script once against a local anvil and reports it.
- A pragma/licence check for the two new source files (`Pragma.t.sol` lists a fixed set of files and is not edited): a small test in `HolderPause.t.sol` and `EarlierGrants.t.sol` reads their own source and checks `pragma solidity 0.8.37`.

### 3.8 What is left to counsel, and why the code stays right whatever the text says

Left to counsel: **the text itself** (what it says about the old agreement, the clock, the limits of a Team Share, the market),
**the consent wording**, whether a transaction from the account is enough or a signature over structured data is also required
(the old design's typed message; not built here: the claim is the account's own transaction, which already proves control),
the entity that issues, jurisdictions, the long-stop, what the list is (counsel's attestation of its count and total; the
owner's numbers), **and every sentence in the app that asks for consent or speaks of permanence or an end date** (5.4). None of it
is in the repository.

List hygiene (outside this repository, the list builder's job, stated so it is not forgotten): the contract cannot check that
indexes in the tree are unique and below `rows`, so the builder asserts uniqueness, `index < rows` and a sum equal to `total`
(a duplicate index with two accounts would let the first claimant block the second). The leaf carries no chain id or contract
address, so one root used on two deployments is claimable on both; that is intended (a root is a list, a deployment is a
choice), and a list builder who wants it bound to one deployment would have to know the claim contract's address first, which
the deploy order does not allow.

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

All of it additive inside record version 2 ("adding a field never changes the version", `docs/next-version/RECORD-V2.md` section 1). No new
event kind, no new relay rule for pause or earlier grants.

### 4.1 Events the reader takes in

`scripts/chain-reader-events.mjs` regenerates `events_table.rs` from the contracts build (never hand-edited); `Role` gains two
roles:

| Role | Contract | Found from | Events |
|---|---|---|---|
| `Pause` | a project's `HolderPause` | the Treasury's `PauseReady(gate)` log (as `Tasks` from `TasksReady`) | `Parked`, `Unparked`, `Observed` |
| `Earlier` | the deployment's `EarlierGrants` | the Launcher's `EarlierBound(earlier, key)` log, tied to that project key | `Bound`, `Claimed` |

Also decoded: Launcher `HolderPauseBound`, `EarlierBound`, `EarlierPoolFunded`; Treasury `PauseReady`.

**The role names, and a migration (the review found "a text column: no migration" wrong).** `chain_logs.role` is plain text, but
`chain_contracts.role` has a CHECK constraint (migrations 0065, 0066, 0070, 0071; `schema/tables/public/chain_contracts.sql`) listing
`launcher, shares, team, treasury, vester, tasks, finisher, rounds, pair, earlier, auction, holder, pool_manager`. `pause` is not in
it, so the reader's insert would fail at runtime. Chosen: the pause uses a **new** role string `pause` (the reserved `holder` was
for the old vote and stays reserved); the claim contract reuses the **existing** string `earlier`, which the CHECK already allows
and **no Rust code uses yet** (`Role` has no `Earlier` today), so S1 adds `Role::Pause` and `Role::Earlier`. S1 owns, for this round
(W6 does not name them), the next free file in `migrations/` (0076 at the time of writing; whatever is next when S1 starts) that drops and
re-adds `chain_contracts_role_check` with `pause` added (as 0071 did), `schema/tables/public/chain_contracts.sql` (the constraint
and its header comment), and a migration test in the Postgres lane: a `pause` row and an `earlier` row insert; an unlisted role
still fails. `schema/seeds` need no change (the table's seed row is a description). The reconcile script
(`scripts/reconcile-schema-after-pgschema.sql`) is not affected (no seed DML or storage parameter changes).

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
| `pause.lineDivisor` | int | the line is `1/lineDivisor` of backers' Shares (3: "a third") | view `LINE_DIVISOR()` | 2 to 100 | the app says "a third" only when this is 3 |
| `pause.armedAt` | int or null | when the line was first seen reached in an unbroken run | view `armedAt()` | | |
| `pause.pausesFrom` | int or null | `armedAt + dayLength` | view `pausesFrom()` | | |
| `pause.paused` | bool | whether `draw` and `announceTask` refuse at `asOf.time` | view `paused()` at the block's own time | | the card reads "not paused" |
| `pause.since` | int or null | when it began: `pausesFrom` while paused | arithmetic on the two views | | |
| `pause.parkerCount` | int | accounts with parked Shares, a count only, never a name | events | at most 1,000,000 | |

No address of a parker, no per-person amount, no list. `docs/next-version/RECORD-V2.md` gets a section 13 with these tables.

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

`team` gains (additive, `null` when the project has no earlier pool): `team.earlierPool` (what the Launcher funded, from
`EarlierPoolFunded`) and `team.earlierReserve` (from `Vester.earlierReserve()` at `asOf.block`, the part the runner cannot grant),
and `team.ungranted` becomes `in_vester - promised - earlierReserve` (the first version would have shown the reserve as "Team Shares
you can grant"; the grant sheet reads the new `ungranted`). `team.pool` stays the founder's pool.

**What "never a row" means (scoped after the review; the first version contradicted the existing `holders[]`).** The server never
holds the list, so **no row that has not claimed appears anywhere**. The record, the feed, the explore index and every page the API
serves carry **no list of claims and no per-claim data**: `Claimed` rows are stored in `chain_logs` (public chain facts; that table
is read by the server's own code and by the operator, and **no route returns raw rows from it**; a test puts a `Claimed` row in the
table and checks that the record, the feed, the explore index, the alerts and every route of the sponsor and the task rules read
none of it) and are never copied into the record. A **claimed** amount appears only as any holder's Team Shares appear, because
it is a public chain fact: `holders[]` lists the account's Team Shares as it lists anyone's, and `grants[]` lists its protected
grant as it lists any (`kind: "protected"`, already in the record's definition; **this reverses the first version's "grants[]
omits kind 1", which would have broken the records' own identity `promised = sum of unfinished grants`**). `earlierGrants` carries
`rows` and `total`, which publish the list's size (public on the chain anyway). The planted-row test: a tree of invented rows,
one of them claimed; no byte of any **unclaimed** row (account, index, amount) appears in the signed record, the feed, the
explore index or any page; the claimed row appears only in the `holders`/`grants` shapes above.

The existing `contracts` object gains `pause` (address or null). `shares.backers` is unchanged and includes parked Shares.
**Fixtures (changed after the review: the fixture is one deployment with one Launcher, and the switch is per deployment, so
regenerating it with the switch on would delete the only switch-off replay).** The current fixture (`testdata/pot-run.json`,
`pot-events.json`, `pot-abi.json`) and `docs/next-version/record-v2-example.json` **stay as they are**, regenerated only when the contracts' events
table changes and then byte-identical in everything else (a test regenerates the default and compares). The same script gets a
second, small run with its own Launcher (`HOLDER_PAUSE=1` and invented earlier settings): `testdata/pot-run-pause.json` and a second
example `docs/next-version/record-v2-example-pause.json` (a populated `pause` and `earlierGrants`); the first keeps `pause: null`, `earlierGrants: null`
and no `PauseReady`. Which test replays which: the existing replay tests keep the off case; new tests replay the pause run.
All are produced by the scripts, never hand-edited; `chain-reader-example-check.py` (both examples) and the Rust test
`the_table_is_the_forge_build` must pass.

### 4.3 The reader and the numbers

**Team supply of project zero (the review found the ledger would be short by the whole earlier pool).** `Ledger::launched` seeds
`team: terms.teamPool` and cross-checks it against `team.totalSupply()` (`ledger.rs` 418 to 446 and the `teamSupply` check), but
`ProjectLaunched.terms.teamPool` is the founder's pool only: the Launcher mints `teamPool + earlier total` to the Vester. S1 seeds
the supply from the launch transaction's `EarlierPoolFunded` row (found by transaction hash, the same way the other same-launch
rows are), so `team += amount`; the Team token's `Transfer` mint is what the balances already see. The record's `team.pool`
stays the founder's pool; `team.earlierPool` and `team.earlierReserve` are new (4.2), and the reserve falls by each claim's amount
(`Claimed`) and is cross-checked with `Vester.earlierReserve()`. The test fixture with the claim contract bound asserts
`team.pool`, `team.earlierPool`, `team.earlierReserve`, `team.ungranted` and the supply checks.

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
closed list. **Global bound (review):** at most 3 `pause.poke` jobs per pass over all projects (a pass is 10 jobs, `JOBS_PER_PASS`), and the helper's existing daily gas and spend caps and its optional-calls slice apply (`poke` is an optional call), so a deployment with many projects at the line cannot create a burst. With the join hook the
poke is no longer needed for correctness (row 12); it only arms a clock the leave direction raised.

### 4.5 The sponsor must keep exits free

`api/sponsor/calldata.rs` `is_exit` and `api/sponsor.rs` `read_allowed`: an operation is an exit when every call is either
`leave` or `leaveTeam` on a followed Treasury **or `unpark(uint256)` on a followed pause contract** (role `pause`, a new
`allowed.pauses` list, no native value), and **at least one call is a `leave`**; **at most one `unpark` per followed pause contract,
and the batch stays inside the sponsor's existing call-count cap** (so `[unpark x N, leave]` cannot be used to burn the sponsor's
gas on a `leave` that reverts; the same hole exists for `leave` alone today, so this only tightens). A batch of `unpark` alone, `park`, `approve`, or
an `unpark` to another contract is not an exit and counts like any other operation. The pause contracts and the claim contract are
already allowed targets (every followed contract is). Tests: the exit selectors equal the generated ABI (as now); `[unpark,
leave]` is an exit; `[unpark]` and `[park]` are not; an `unpark` on a contract the reader does not follow is not; the day's counts
are never charged to an exit batch; a batch with two `unpark`s of one pause contract is not an exit.

### 4.6 W5 server item one: a box-paid task is "Paid" only when the network shows the payment (G7)

Verified open at `1fed95002`: with no plan on the network, `task_chain::decide_chain` returns `Ok` for `ChainLookup::Absent`, so a
`confirm` carrying any `task-paid` transaction is stored.

Change, in `crates/buzz-relay/src/handlers/task_chain.rs` (and its `_postgres_tests.rs`), plus the words in the same file:

- New lookup `box_payments_of(pool, reader, treasury, tx)`: **every** stored `AllowanceDrawn` row of **that project's Treasury**
  whose `tx_hash` equals the named transaction, each with its `to` and `amount` (a Pair's or a smart account's batch can hold
  several draws in one transaction: the lookup matches any row of the transaction, not "the" row).
- A `confirm` for a task with **no plan** that names `task-paid`: (a) the reader has not stored the project's launch: `retry:`
  (as now for a plan); (b) **no row of the transaction pays the worker's wallet (and the stated amount)**: if the reader's newest
  stored block time (`AS_OF_SQL`, already in the file) is at least **the confirm's own `created_at` plus 60 seconds** (a named
  constant), the reader has covered every block the worker could have been writing about, so `invalid:` "the network does not
  show that payment"; otherwise `retry:` (the server never guesses a block number, makes no chain call on the write path, and a
  confirm written with a `created_at` in the future only keeps getting `retry:`, which costs nobody but the writer);
  (c) a matching transaction exists but **no row pays the wallet the worker named under their own signature** (`task-pay-to`,
  read with `stored_pay_to`; **when the worker named none the confirm is `invalid:` "the worker has not named a wallet": the pay
  sheet pays to the worker's named wallet, so a task paid through the app always has one**): `invalid:` "the payment went to
  another wallet than the one the worker named"; (d) the amount is not the record's `task-usd` when it states one: `invalid:`;
  (e) **replay (the review): the draw has no task reference, so one draw could be cited by two confirms of equal amount.** The
  lookup also reads the stored confirms of this community that name the same `task-paid` (the file's tag-filter query, as
  `stored_pay_to` does) for **other** tasks; if the number of distinct tasks naming the transaction, this one included, is more
  than the number of matching draw rows in the transaction, `invalid:` "that payment already paid another task".
  Otherwise the record is stored. A `confirm` that names **no** payment (the "accepted without paying" path) is untouched.
- A lookup that fails is a server fault that refuses the write (as everywhere in this file).
- Reading side: the record the app reads is the stored one, so "Paid" can no longer be written without the network showing it.
  Rows already stored before this change keep reading as they did; the app's own chain search (`pay-lookup.ts`) is unchanged.

Tests (Postgres lane): a confirm with an invented transaction is refused (once the reader's newest block is a minute past the
confirm); with a real stored `AllowanceDrawn` to the worker's wallet it passes; to another wallet it is refused; a worker who
named no wallet is refused; a transaction of another project's Treasury is refused; a reader that has not caught up says
`retry:` (and, with the confirm's `created_at` after the reader's newest block, still `retry:`); **replay:** two tasks citing one
draw: the first passes, the second is refused; **batch:** one transaction with two draws to the worker's wallet and one with a draw
to another wallet and one to the worker's: each right confirm passes, a third confirm for the same transaction is refused; **the
guard is switched off once** (the new branch returns `Ok`) and the refusal, replay and batch tests must fail.

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
   the write. **Every refusal's words say how to clear it** (the review: a person who linked a wallet that a runner later set as
   an agent is caught by rules 1 to 3): "...; unlink that wallet from this account to clear this" (rules 1 and 3) and "...; label
   this account as a helper, or unlink the wallet" (rule 2). Tests: each rule refuses; each has a "label removed" or "wallet
   unlinked" case that passes (and one test per rule that **unlinking the wallet clears the refusal**); each guard switched off
   once makes its test fail.

---

## 5. The app (A5): every screen and every sentence

Phone first, light. The words are plain ("pause", "park", "Take out", "the project's money"); no event name, kind number or
error name in main copy; sizes are rem tokens; the name comes from the brand constant; the banner "You can take your money out
any time. Nothing here promises a profit." **follows the existing rule (one owner, no duplicate screen-reader stop):** pages get it
from the shell's banner; the sheets that speak of taking money out or show what it gives (Park sheet, Take out) carry it
through the existing constant (`TAKE_OUT_BANNER` in `pot-words.ts`, never a retyped copy), as the existing money sheets do; the
claim page is a page, so the shell's banner serves it, and a test with axe counts one banner per screen. The line "This can go up
or down. It is not a return." stands under any live money number (these sheets show Shares and percentages, so it appears on the sheets that
show what taking out gives, as now). **No sentence says or implies that parking stops a loss.** No new tab. The first download
stays under 450,000 bytes: the pause sheets and the claim page are lazy chunks; the parse of the two record keys and one card are
the only first-download code.

### 5.1 Where a holder parks and un-parks (two presses from the project page)

Shown only when the project's record has `pause` and the person holds backer Shares (wallet or parked).

On **Your Shares** (project page, `YourShares.tsx`), under the holding line, a secondary button and one line:

- **Park Shares** (opens the sheet), and, when some are parked, **Take back** (an inline button, **no sheet of its own**, to keep
  it light: one press shows "Take back {n} Shares to your wallet. Nothing is charged." with **Take back** and **Cancel**, then sends `unpark`).
- Line: "{p} of your {t} Shares are parked." (hidden when none).

**Park sheet** (`ParkSheet.tsx`, lazy):

- Title: "Park Shares".
- First line: "Parked Shares count toward pausing the team's spending. They stay yours: take them back or take them out any day." **followed on a passkey account by "In one press."; on a wallet that asks twice the sheet's own line below ("Your wallet is asked twice") sits directly under it and the words "in one press" are not shown** (the review: never a "one press" promise on a path that takes two confirmations; no EIP-5792 batching is built in this round: it is recorded in the report which wallets were tried, and the sender uses a batch only where the existing wallet adapter already offers one).
- Picker as Take out has it: "All of it", "Half", "A quarter" of the Shares in the wallet.
- Summary (read from the chain at the moment the sheet opens): "You park {n} Shares. After this, {x} of backers' Shares are parked. At {line}, the team's allowance and new task plans pause {wait} later." **`{line}` is "a third" only when the record's `pause.lineDivisor` is 3, else "1 in {n}"; `{wait}` is rendered from `pause.dayLength` ("one day" at 86,400 seconds, otherwise the duration in plain words, e.g. "4 minutes" on a demo network); `{x}` is the percent rounded down to one decimal, and a value under the line that would round to the line's own figure reads "just under a third"** (the review: rounding down to a whole percent read "33%" while a third was needed). Tests with a short `dayLength` and a `lineDivisor` that is not 3.
- Second line: "Parking does not move your money. Parked Shares cannot be sent until you take them back." (one clause, the review: the word "loss" could be read as protection).
- A line about the wallet: wallet, "Your wallet is asked twice: first to let the project hold them, then to park."; passkey account, "Your passkey is asked once."
- Button: "Park". The banner under it.
- After it: "Parked. You can take them back or take them out any time from Your Shares."
- A failure says what happened and what to do ("The network did not take it. Nothing moved. Try again.") from a copy module.

**Take out sheet** (`TakeOutSheet.tsx`, `takeout-read.ts`): when some Shares are parked the holding line reads "You hold {t}
Shares ({p} parked)." and a line "Taking out takes your parked Shares back first, in the same press." For an injected wallet
that cannot batch: "Your wallet is asked twice." The press is the batch of 1.5; the quote is the sum of the two quotes with the usual guard; nothing else changes.

### 5.2 What the project page says (the card `PauseCard.tsx`, shown only when `pause` exists)

**When the card shows (lighter, per the review):** only when something is parked, or the person holds backer Shares, or the team is
armed or paused. Otherwise the project page shows nothing for the pause except one line in the project's info ("Holders can pause
the team's spending: a third of Shares parked.") and the Park button on Your Shares.

Always, when shown: **"Holders can pause the team's spending."** then "If {line} of all backers' Shares are parked, the team's daily
allowance and new task plans pause {wait} later, for as long as that much stays parked. Parking does not move anyone's money.
You can take your money out any time." Then one state line from the record, with a meter (`role="meter"`,
with a text value, never colour alone). **Said in the card, one plain sentence, because the contract allows it:** "More Shares
joining can lower the parked share and end a pause." The wording follows the numbers in the same way as the Park sheet
(`{line}`, `{wait}`, `{x}`); the percent shown never reads as the line while under it. There is no "near" state (cut for lightness).

| State (from `pause`) | Sentence |
|---|---|
| under the line | "{x} of backers' Shares are parked. {Line} is needed." |
| armed (line reached, `pausesFrom` in the future) | "{Line} is parked. The team's allowance and new task plans pause on {date and time} if it stays there." |
| paused | "Paused since {date and time}. The team cannot draw its allowance or plan new tasks while {line} stays parked. Tasks already planned go on. Everyone can still take their money out." |
| record older than its refresh promise, or `pause` null while the Treasury has a pause | the existing "numbers are old" line; no pause claim is made |

A person with parked Shares also sees, in the card: "You have {p} Shares parked." with **Take back** (the inline button of 5.1).
The percent is rounded down; under 1% reads "less than 1%".

### 5.3 What the team sees

On the allowance section (`AllowanceSection.tsx`, `AllowanceSheets.tsx`) and the plan-a-task sheet
(`tasks/chain/team/PlanSheet.tsx`), for the runner, a Pair's signers and anyone who could press them:

- armed: "Holders have parked a third of all Shares. Your allowance and new task plans pause on {time} if it stays there. Until then you can draw what the box holds."
- paused: "Paused by holders since {time}. You cannot draw the allowance or plan a new task until fewer than a third of Shares are parked. You can still check in, finish tasks already planned, grant Team Shares and hand over."
- The **Draw** and **Plan a task** presses are disabled while paused, with that reason as their description (one owner of each label). If the chain refuses anyway (a stale read), the copy module maps the refusal to: "The team's spending is paused by holders. Try again when parked Shares fall below a third."
- The agents' screen (`AgentCaps.tsx`) adds one line while paused: "Helpers cannot draw while the team's spending is paused."
- **The Launch sheet (and the Start flow), when the deployment has the pause** (the review: a pause over the founder's own spending
  that cannot be removed must be said before the launch, not found afterwards): one plain sentence, "On this network holders can
  pause the team's spending when {line} of Shares are parked. You cannot turn this off for your project." The app knows from the
  Launcher's `holderPauseImpl()` (read where the sheet already reads `settingsHash`); nothing shows when it is zero. Files:
  `LaunchSheet.tsx` and the Start flow's launch step (added to A5's list).
- The Pair confirm sheet gets no new sentence (no new call kind); a `draw` or `announceTask` confirmed during a pause shows the refusal above.

### 5.4 The claim page for earlier grants (`app/src/features/earlier-grant/`, route `/earlier-grant`, lazy)

**Exists only where the build is given all three settings** (`VITE_CREATON_EARLIER_CONTRACT`, `VITE_CREATON_EARLIER_TEXT_HASH` and
**`VITE_CREATON_EARLIER_TEXT_URL`, now required, not optional**, in `app/.env.example`; the review: without a way to read the text
inside the app, a person could tick "I have read the text" with nothing to read). Without them the route is not in the router
tree, the address is a plain not-found, and no code of the page loads. (The old earlier page and its route stay behind the legacy flag.)

**Counsel owns every consent, permanence and end-date sentence (the review).** The first version wrote them in the page. Now every
sentence that asks for acceptance, speaks of consent, or says anything about permanence or an end date lives in **one copy module,
`app/src/features/earlier-grant/earlier-grant-consent.ts`**, marked at its top as provisional and neutral, to be replaced by
counsel's words; the page and its tests import only from it, and `pnpm check:copy` covers it. The table below shows the
**provisional** neutral sentences; the report says plainly that the checkbox and these sentences are placeholders for counsel.

A person gets their own link `/earlier-grant#<their row>`: the fragment carries their `index`, `amount` and `proof` (base64url
JSON), is never sent to any server, and is made by whoever holds the list. The page **never shows another person's row, never
lists rows, and the server holds none**.

| State | Sentences |
|---|---|
| Not signed in | "Sign in to see whether this link is for your account." (the existing sign-in) |
| No link, or the proof does not match the signed-in account and the network's fingerprint | "This link is not for the account you are using. Open it with the account it was made for." |
| Claims not open (`bound` false) | "Claims are not open yet." |
| The page's text fingerprint and the network's differ | "This page and the network name different texts. Do not accept. Tell the person who sent you the link." The press is not offered. |
| Row found | "Your grant: {amount} Team Shares." / "They unlock evenly over {clock} days counted from the day the project began, with no waiting period at the start. The team cannot cancel or burn this grant: the contract has no call for it." (the numbers read from the chain; the second sentence states what the contract does, and counsel may reword it) / "Taking Team Shares out pays only what the project holds above what backers put in. That can be nothing." |
| The text | "The text you accept has the fingerprint {short fingerprint, with a copy button}." and **"Read the text"** (opens the build's URL; the press stays disabled until it has been opened once in this visit, so the box is about a text the person was shown from the app). |
| Acceptance | a checkbox "I have read the text with this fingerprint." (labelled, keyboard reachable; a **placeholder** in the consent module) and the button **"Accept the text and claim"**, disabled until it is ticked **and the text has been opened**. Under it, neutral: "This records the fingerprint you name, from your account, on the network." (no "cannot be undone", no promise) |
| Already claimed | "This grant is already claimed. You can see it in Your Shares." |
| After the press | "Claimed. Your Team Shares unlock over time." |
| Counts | "{k} of {N} grants claimed." (a total, never a name) |
| End date | **nothing is said** (counsel's long-stop is open; the first version's "no end date" could become false) |

Presses: link, sign in (existing), tick, press: two on a phone with a passkey account (the passkey asked once; the sponsor pays),
the same with a wallet. The claim call data is built from the generated ABI, never by hand.

### 5.5 The joined-up loop and the other files

- **Every reader of a person's Shares adds the parked amount (the review).** A5 greps every `balanceOf` and every holder read in
  `app/` and `packages/` (Home's position hint, the room's rights hints, the Take out quote guard, "you back this", the project
  page's holding, the launch and agent screens), lists them in the report, and adds `parkedOf` (or the record's `holders[].shares`,
  which now include parked, 4.1) to each. A test: a person who parked **all** their Shares still sees "you back this", can post
  in the room and gets the right Take out amount.
- Parse (`money/numbers-read*.ts`, strict, with hostile-record tests): `pause` (including `lineDivisor`), `earlierGrants`,
  `team.earlierPool` and `team.earlierReserve`, `contracts.pause`; a hostile
  value (a parked total above the Shares, a `paused` that contradicts `pausesFrom`, a non-numeric field) makes the **key** null,
  never the whole record.
- `money/send-targets.ts`: `rememberSendTargets` gets the pause address and the claim contract; the sponsor follows them already.
- `packages/creaton-core/src/pot/`: regenerate the ABIs (`scripts/pot-app-abi.mjs`), then `parkCalls`, `unparkCalls`,
  `takeOutWithParkedCalls`, `earlierClaimCall` in `pot-calls.ts`, `parkedOf` and `pauseState` in `pot-reads.ts`, the take-out plan
  with parked Shares in `pot-plans.ts`. Their tests compare the encodings with the contracts' own build.
- `money/pot-copy.ts` (and the existing team error copy): the `Paused` refusal.
- Reuse the existing sender (`useSender`, `sendCalls`) for batches; the park flow is `approve` then `park` in one batch on the
  passkey account and two sends on an injected wallet, as the real-dollar Back is. The grant sheet uses the new `team.ungranted`
  (without the earlier reserve).
- **Resets.** The pause read is not cached at module level; if one is added, its reset goes into `resetCommunityState()` or the
  new app's equivalent in the same change.
- Accessibility: one owner per actionable label (the Park, Take back and claim buttons each have one name), no duplicate
  stops, the meter has a text value, the checkbox has a label, every control by keyboard, touch and pointer (tests for the
  keyboard and touch paths of the sheet and the checkbox-gated press).
- `scripts/pot-chain-loop.sh`: a second stage that deploys with `HOLDER_PAUSE=1` and invented earlier settings (it runs the script
  against anvil; K1 and K2 have already tested the script's settings in forge, so a script defect is found before this stage), parks, arms,
  waits a day (the loop's short unit), checks that `draw` and `announceTask` refuse and that a take-out batch works while
  paused, un-parks, checks the allowance comes back; claims an invented row from an invented account and checks the grant,
  the acceptance, the double-claim refusal and the vesting; `scripts/phone-loop.sh`: the same park, take-out batch and claim from
  the passkey account (one operation each).
- Playwright specs `pot-pause.spec.ts` and `pot-earlier-grant.spec.ts` at 390x844 with axe (pause card states, park, take back (inline),
  take out with parked Shares, the team's paused sentences, the claim page states including the fingerprint mismatch).
- Docs: `docs/next-version/TRY-IT.md` and `docs/next-version/DEPLOY-TEST-NETWORK.md` say how to turn the switch on (`HOLDER_PAUSE=1`) and how to set the earlier
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
`test/HolderPause.t.sol`, `HolderPauseAttacks.t.sol` (rows 1 to 17 of section 2), `HolderPauseInvariants.t.sol`,
`PauseEventsRebuild.t.sol`, `OffIsOff.t.sol`, `GasPause.t.sol`, `SizePause.t.sol`, `LauncherPause.t.sol`, `DeployPotSettings.t.sol`
(3.7), and a new helper
`helpers/PauseBase.sol` (extends the existing `StackBase`; no existing test or helper is edited).
Order of work: **first record the old absolute gas** (run the existing `Gas.t.sol` and `GasTasks.t.sol` before editing anything) and
run `check-mutations.py --check` (the existing mutations match source text in the files K1 and K2 edit, e.g. `min-grant` and
`draw-keeps-box`; any text that no longer occurs exactly once is adjusted, never dropped, and the report says which); then the
contract and its unit tests, the Treasury hooks and the Launcher wiring, the access tests, the attacks, the
differential, invariants and rebuild, the script's settings test and one run of the script against a local anvil, then the mutations.
Checks: `forge fmt --check src script test`; `forge build --sizes` (**Treasury delta stated; stop and report if it is over 650
bytes or the Treasury has under 300 spare; Parts under 49,000**); `forge test` whole (all 540 old tests green and unchanged,
new ones counted); invariants at 1,000 runs; the new fuzz and attack tests at 20,000 runs once; the mutation script with at
least these new entries, **each run once and each must be killed**, result written in the report: `line-floor` (`B/3` rounded
down), `no-b-zero-guard`, `delay-zero`, `no-hidden-dip-reset` (observe-first removed), `no-join-poke` (the hook in `_join` removed;
killed by `test_dipThroughAJoinIsRecordedWithoutAPoke`), `draw-ungated`, `announce-ungated`, `park-from-argument` (park pulls from a given account), `unpark-gated` (un-park
refused while paused), `bind-twice`, `gate-fails-open` (a catch), `count-donation`. `paused-not-live` (the live ratio dropped from `paused()`) is tried
once and is **expected to be an equivalent mutant** with the join hook (1.3); the report says whether it was killed.
`scripts/pot-chain-loop.sh` is A5's: K1 hands over the deploy settings and the ABI.
Report: sizes before and after, gas measured against the 1.6 estimates, the mutation list, the test counts.

### K2: contracts for earlier grants (contracts engineer, after K1)

Owns `contracts/pot/**` as K1: `src/EarlierGrants.sol` (new), `src/Vester.sol`, `src/Launcher.sol` (earlier part),
`src/Interfaces.sol`, `script/DeployPot.s.sol`, `DEPLOYMENTS.md`, `scripts/check-mutations.py`, new tests `EarlierGrants.t.sol`,
`EarlierVester.t.sol`, `EarlierLauncher.t.sol`, `EarlierMoney.t.sol`, `EarlierInvariants.t.sol`, `GasEarlier.t.sol`, helper
`helpers/EarlierBase.sol` (a tree built in memory from invented rows). Existing `Vester.t.sol`, `VesterUnit`, `Forfeit` and the
rest are not edited and must pass.
Checks: as K1, plus: **Parts creation code stated (stop under 49,000)**, the Vester's ordinary `grant` path unchanged (a test
that every old Vester test passes), `forge test` whole, the script's settings test (3.7) extended and one run against anvil, and the mutation script with one new entry per check of 3.4 (`no-text-check`,
`no-bitmap`, `no-double-hash`, `no-sender-in-leaf`, `no-index-bound`, `no-pool-bound`, `no-min-row`, `reserve-ignored` in
`grant`, `start-at-claim`, `cliff-on-protected`, `reserve-burned-after-wind-down`, `bind-twice`, `earlier-bound-by-anyone`, **`protected-uses-ordinary-cap`** (the B1 fix: `grantProtected` reads the
ordinary count), `bind-after-launch` (the launched-key refusal removed), `ordinary-ignores-protected-count`) each
killed once, result in the report. No real row anywhere: the report says how the invented rows were made.

### S1: the server (server engineer, after K2)

Owns `crates/**` and, for this round only (I assign them, since W6 does not), `scripts/chain-reader-events.mjs`,
`scripts/chain-reader-fixture.py`, `scripts/chain-reader-example-check.py`, `docs/next-version/RECORD-V2.md`,
`docs/next-version/record-v2-example.json` and `docs/next-version/record-v2-example-pause.json` (the examples are regenerated, not edited),
**the new migration for the `pause` role and `schema/tables/public/chain_contracts.sql` (4.1; the review found no path owned
them)**.
Files: `chain_reader/events.rs` (roles), `events_table.rs` and `testdata/*` (generated), `ledger.rs`, `held.rs`, `explore.rs`,
`record.rs`, `numbers.rs`, `views.rs`, `helper/calls.rs`, `helper/plan.rs`, `helper/mod.rs`, `api/sponsor.rs`,
`api/sponsor/calldata.rs`, `handlers/task_chain.rs`, `handlers/agent_label.rs`, `handlers/launch_update_authority.rs`,
`handlers/wallet_binding.rs`, `handlers/room_write.rs` (holding = balance + parked) and their tests; `config` only if a setting is
needed (none planned); `migrations/<next free number>_chain_pause_role.sql`.
Checks: `cargo fmt --all -- --check`; `cargo clippy -p buzz-relay -p buzz-cli --all-targets -- -D warnings`;
`cargo test -p buzz-relay --lib` with filters `chain_reader::`, `sponsor`, `task_chain`, `agent_label`; the Postgres lane
(`--ignored`) for the touched files; `node scripts/chain-reader-events.mjs --check`; the fixture regenerated and
`chain-reader-example-check.py` clean; `scripts/regen-kinds.mjs --check`; the migration test (4.1); the planted-row test (4.2); **each new guard switched off
once** (G7 check including replay and batch, the two label rules, the exit rule for `unpark`, the "no unclaimed row anywhere" filter,
the holding rule, the Team supply seed) with the named test failing, result in the report.

### A5: the app's screens for both, and the joined-up loop (app engineer, after S1)

Owns `app/**`, `packages/**`, `web/**` (not touched), `scripts/pot-*.sh`, `scripts/phone-loop.sh`, and the two docs `docs/next-version/TRY-IT.md`
and `docs/next-version/DEPLOY-TEST-NETWORK.md`.
Files: section 5. New: `app/src/features/pause/` (`PauseCard.tsx`, `ParkSheet.tsx`, `TakeBackButton.tsx`, `pause-words.ts`,
`use-pause.ts`, tests), `app/src/features/earlier-grant/` (`EarlierGrantPage.tsx`, `earlier-grant-state.ts`,
`earlier-grant-words.ts`, `earlier-grant-consent.ts` (counsel's, provisional), tests), `app/tests/e2e/pot-pause.spec.ts`, `pot-earlier-grant.spec.ts`. Edited: `project/ProjectPage.tsx`,
`pot/YourShares.tsx`, `pot/TakeOutSheet.tsx`, `pot/takeout-read.ts`, `pot/AllowanceSection.tsx`, `pot/AllowanceSheets.tsx`,
`tasks/chain/team/PlanSheet.tsx`, `tasks/AgentCaps.tsx`, `launch/LaunchSheet.tsx` and the Start flow's launch step, `money/numbers-read*.ts`, `money/numbers-types.ts`,
`money/send-targets.ts`, `money/pot-copy.ts`, `app/router.tsx`, `app/.env.example`, the copy-check allowlist only if a word
cannot be rewritten (reason given); `packages/creaton-core/src/pot/*` with the regenerated `abis.generated.ts`.
Checks: `biome check`, `tsc --noEmit`, `pnpm check:copy`, `check:px-text`, `check:file-sizes`, `knip`, `vitest` (all, count),
`vite build` and the bundle sizes (entry under 450,000 bytes), `scripts/pot-chain-loop.sh` (both stages), `scripts/phone-loop.sh`,
`scripts/pot-app-phone-e2e.sh`, the two new Playwright specs and the existing smoke project at 390x844 with axe (`pnpm build:e2e`
first, never `pnpm run build`), a screenshot set through `just desktop-screenshot` only if the screens run in the mock bridge.
Each guard switched off once with its named test failing: the fingerprint-mismatch refusal, the checkbox gate and the "text opened" gate on the claim press,
the "no row of another person" filter, the disabled Draw and Plan presses while paused, the take-out batch order
(`unpark` before `leave`), the parse's hostile-record nulling. The report states what a person on a real phone did not do.

---

## 7. Chosen under the owner's standing go; the owner may overrule

| # | Choice | Alternative and why not |
|---|---|---|
| D1 | The pause is **one switch per deployment, off by default**, set once by the deployer in the first hour; a project is born with or without it | A per-project founder choice (a founder could pick "no stop" for every project and the stop would mean nothing); a switch the admin can flip later (it would change terms for new projects without the founders' hash seeing it; the hash does see it, but a sealed switch is simpler to explain) |
| D2 | "The Shares that backers hold" is the whole backer supply `B`, contracts' balances included; Team Shares are neither counted nor parkable | Exclude contract balances (cannot tell a person's smart account from a pool); count vested Team Shares (they are a claim above paid-in, not money in, and the plan says never) |
| D3 | The line is `3K >= B`, rounded up (`LINE_DIVISOR = 3`), observed by `park`, `unpark`, `poke` **and by the Treasury in every `_join`**; paused needs the line live; a new reach is a new 24 hours; the "day" is `unit/7` | A hysteresis band (flapping defence, but it breaks "for as long as they stay parked"); a pause that needs continuous observation by a server (the first version relied on the helper's pokes, which the review showed leaves a dip unseen); a `lastSeen` rule inside `paused()` (needs the Treasury to call on leaves too: more bytes in a Treasury with 999 to spare, and a new call on Take out, which must stay untouched) |
| D4 | Custody, with Take out as an un-park-and-leave batch from the holder's own account (one press on a passkey account, two confirmations on a wallet that cannot batch) | A per-holder vault that can call `leave` itself (one transaction for every wallet, but about one more engineer-week, a clone per holder and a new place for exit notes to sit); letting the pause leave for the holder (exit notes would be written to the pause contract and need an attribution ledger) |
| D5 | **The further power (end at two thirds) is left out**: it lets a buyer burn the team's unvested claim for a profit (net +32,025 on a 2,000,000 pot, section 1.9) and kills a healthy project for the fee | Include it with a keep-accrued wind-down and an announced notice: needs its own attack review and counsel; not built |
| D6 | The earlier pool is **separate from, and in addition to**, the founder's Team pool (the 100,000,000 limit applies to the founder's pool only); it is bounded by `MAX_EARLIER_POOL` = 1,000,000,000 Shares and counts in G from birth | Cut it from the founder's pool (a founder with a small pool could never honour a long list); a larger cap (the old supply is the largest number this project ever had) |
| D7 | **Unclaimed rows stay claimable for ever**, with no stated end and no sweep, **also after a wind-down, where they keep diluting backers' surplus (3.3 gives the figures: 85.7% / 35.3% / 5.6% of a surplus in the worked case)** | A long-stop after which unclaimed Shares burn through a notice (counsel's long-stop and a joiner-pricing notice are needed; not built); the owner should decide this before any real network |
| D8 | The text is an **opaque fingerprint** in an immutable claim contract; a new text is a new contract. The claimant names the fingerprint they accept | A keeper who may publish a new text (a mutable text is the opposite of "what was accepted"); a wallet signature over structured data in addition (a counsel point) |
| D9 | The claim is **sent by the row's own account** (`msg.sender` in the leaf); no relayed or signed claim | A relayed claim with a signature (more code, a replay surface, nothing the sponsor does not already give a passkey account) |
| D10 | A protected grant vests from **project zero's birth**, not from the claim | From the claim (late claimers vest later than early ones, against C21's text) |
| D11 | A claim is refused for a row below one whole Team Share (`RowTooSmall`). **The 8-grant limit is split in two counters (ordinary 8, protected 8) so that nobody with grant rights can lock a listed account out of its claim** (the first version let a runner fill the 8 slots; both reviews found it) | Raise the minimum or drop the 8-grant limit (existing Vester rules; changing them is outside this round); let `claim` bypass the limit (unbounded `exitAll`) |
| D12 | The two switches bind through one-shot, deployer-only, first-hour setters on the Launcher, not through the constructor or the Platform struct | A new constructor (breaks every test that builds a Launcher); a new `Platform` field (changes `ProjectLaunched`, the settings hash and the server's decoder) |
| D13 | The pause check **fails closed**: a gate that reverts stops `draw` and `announceTask`, and, because the Treasury calls `poke()` in `_join`, joins as well; never leaving. The real gate cannot revert; a deployer-bound impl that could is covered by `settingsHash` and the code hash in `HolderPauseBound` | Catch and allow (a swallowed failure; the plan's rule 1) |
| D14 | While paused the box stays at its seven-day cap (accrual beyond a week is lost to the team, kept by holders); the pause does not stop settling | Stop accrual at the start of a pause (more bytes in the Treasury, which has 999 to spare) |
| D15 | The sponsor treats `[unpark, leave]` as an exit | Leave it as a normal operation (a person with parked Shares could be refused the fee on the one press that must never be refused) |
| D16 | Server: the record's pause and earlier keys are `null` on any failed check; no per-parker data and no list of claims ever; no unclaimed row anywhere (the server never has one); a claimed amount appears only as any holder's Team Shares do, and `grants[]` keeps protected grants (the first version omitted them, which broke the record's own identity) | Hide claimed grants (breaks `promised = sum of unfinished grants`); list claims (a list of who claimed what) |
| D17 | G7: a box-paid task's `confirm` needs the network to show a matching `AllowanceDrawn` (to the worker's named wallet, the stated amount; any row of a batch transaction; no draw counted for two tasks) or the write is refused with words; `invalid:` only once the reader's newest block is a minute past the confirm's own time | Check only that the transaction exists (any transaction would pass); a block-number rule (needs a chain call on the write path) |
| D18 | Agent labels tie to the chain through the **wallet binding** (an account's linked wallets), not through a new tag or kind | A new profile tag naming the wallet (another thing to forge); do nothing (the limits bind only if people keep the two apart by hand) |
| D19 | The helper pokes at most 6 times a day per project, once per 10 minutes, with a terminal state | Poke on every event (an unbounded loop) |
| D20 | New app words: "park" and "pause" (plain), "Team Shares" kept where they must be named; no protocol words | "Hold" or "freeze" ("hold" is already "you hold"; "freeze" sounds like money is stuck) |
| D21 | The claim page lives at `/earlier-grant`, lazy, only with the build settings; the old `/earlier` page stays behind the legacy flag | Reuse `/earlier` (two designs on one address) |
| D22 | Ownership: K1 and K2 own all of `contracts/pot/**` (script, scripts, DEPLOYMENTS.md included); S1 owns the reader's scripts, `docs/next-version/RECORD-V2.md`, the new migration and `schema/tables/public/chain_contracts.sql` for this round; A5 owns `docs/next-version/TRY-IT.md` and `docs/next-version/DEPLOY-TEST-NETWORK.md` | W6 does not name these |
| D23 | Roles: the pause is a **new** role string `pause` (migration); the claim contract reuses the existing `earlier` string, unused by Rust until S1 adds `Role::Earlier` | Reuse `holder` for the pause (reserved for the old vote); a distinct new name for the claim contract (a second migration for nothing) |
| D24 | The claim page's consent, permanence and end-date words live in one provisional, neutral, counsel-owned module; the claim press needs the text opened in the app and the build's text URL | Words written in the page (the first version; they are counsel's) |
| D25 | Known tension recorded: a contract that parks Shares it holds counts as a holder (D2), where PLAN-V2's 18 November wording said "from a person's own wallet"; a contract with no `unpark` path traps its depositors' Shares and the sheet cannot fix that | Exclude contracts (cannot tell a smart account from a vault: the same reasoning as D2) |
| D26 | A `HolderPauseBound` code hash is published; the Launcher does not hard-code it | Hard-code an allowed hash in the Launcher (a founder cannot judge code anyway; the deployer chose the impl, and `settingsHash` already covers it) |

**Milestone 9 of `PLAN-V2.md`, recorded as replaced.** `HolderVote` (park free Shares, pause at a third, seat election, replace
vote) becomes `HolderPause`: park and pause only. The Council, seat elections, a vote to replace the runner, the reserve sale, the
turnout floors that step up by stage, the supermajority for a wind-down, and the team-payer role (`payTeam`, the team budget)
**belong to the stages, the auction and the Council runner that the new model removed** (design sections 3 and 9); there is no
stage, no auction, no Council, no reserve and no team budget to hand to a vote, and the runner's powers are bounded by the
allowance ceiling, the task caps and the notice. The requirement "votes count only Shares parked from a person's own wallet" is
kept in full: only `park` from `msg.sender` counts, and nothing a Treasury, Vester, Pair, TaskBook, claim contract or Launcher
holds can.

**Not in this round.** The end-at-two-thirds power (D5; **both reviewers confirmed the exclusion and nobody could argue for it**); any rule for unclaimed rows after a stated time (D7, needs counsel); batching for injected wallets (EIP-5792: the sheets say "asked twice"); a
wallet signature over structured data for the acceptance; a per-holder vault for Take out in one transaction on every wallet
(D4); stopping allowance accrual during a pause (D14); alerts that tell a holder their parked Shares reached the line (the
existing in-app alerts do not carry it; a later step); the earlier list, its attestation, the text, the entity and the pool's
size (counsel's and the owner's: **the owner must set the pool size and see the team side's share of the surplus before any real
network**); any real network, any real money, the audit; the real phone and the operator's real services, never run in this
repo. Trading and investing stay off by default. The legal line is not reworded anywhere: the app shows it word for word where it
already does, and no new screen here changes or hides it.

---

## 8. Review record: what two reviewers found, and what became of each

Two reviewers read commit `bccfbf209` (a contracts review of sections 1 to 3 and 7; a fit review of the whole plan against the
owner's direction). Each finding was checked against the code in this tree by the second author. "Held" means the code bears it
out; the change column says where it went. Nothing was run (this stage builds nothing).

| Finding | Held? | Check against the code | Change |
|---|---|---|---|
| Contracts B1 and Fit B1: the runner can lock an earlier backer out of its claim by filling 8 grant slots | **Held** | `Treasury.grantTeam` (runner or agent) reaches `Vester.grant`; `Vester.sol:124` reverts at 8 per member; minimum one Share; rows never expire | Two counters (3.2, 3.4, D11); tests and mutation `protected-uses-ordinary-cap` |
| Contracts I1: the team can dilute in the same transaction as the draw; clock reset by `join; poke; leave` | **Held** | `Treasury.paused()` reads live supply; `leave` has no delay; fee is 2% of the gross (`feesOwed`) | Row 16 with costs at 10,000 and 1,000,000 and margins 1%, 10%, 50%; "cannot lose" reworded everywhere; tests `test_oneTxJoinDrawLeaveLiftsAPause`, `test_oneTxSandwichResetsTheDay` (1.3, 2, intro) |
| Contracts I2: the pause pays every backer (the allowance stays in the pot), so "cost = the fee" is wrong | **Held, with one correction** | `Treasury._settled` returns the excess accrual to the pot (`s.back`). The gain arrives as surplus, which `PotMath.cash` shares with all Team Shares, so the backers' part is `b/(b+g)`; the reviewer's 20-day break-even is "about 20 to 25 days" | Benefit paragraph, rows 1 and 3, `test_pausedAllowanceReturnsToPotAndRaisesEveryTakeOut` (2) |
| Contracts I3 and Fit I1: a hidden dip and recovery gives a pause with no day of warning | **Held** | `shares.mint` is called only in `_join`; `unpark` already observes; so a hook in `_join` closes every way the ratio falls | `poke()` in `_join`, size +400 to 500, invariant "armedAt non-zero implies the line is reached", D3 (1.2, 1.3, row 12). Fit's other option (a `lastSeen` rule) rejected: it needs a hook on `leave` |
| Contracts I4: the reader mis-states project zero's Team supply | **Held** | `ledger.rs` seeds `team: terms.teamPool`; the `teamSupply` cross-check and `numbers.rs` `ungranted` would fail or lie | `EarlierPoolFunded` event, ledger seed, `team.earlierPool`/`earlierReserve`, new `ungranted` (3.2, 4.2, 4.3) |
| Contracts I5 and Fit I8: unclaimed rows keep diluting for ever, also after a wind-down; a pool over the founder cap | **Held** | `claim` has no wind-down check; `PotMath.cash` divides surplus by `b + g` | Figures (85.7% / 35.3% / 5.6%), the pinned test, the script refuses a pool over the founder cap without `EARLIER_ALLOW_LARGE=1`, D7 and the owner list (3.3, 3.6) |
| Contracts I6: `bindEarlier` after the key launched | **Held** | `Launcher._projects[key].treasury` is set at launch | `bindEarlier` refuses; order in DEPLOYMENTS.md; tests (3.2, 3.7) |
| Fit B2: no migration for the `pause` role; no owner for migrations and `schema/` | **Held** | `chain_contracts.role` CHECK in 0065/0066/0070/0071 and `schema/tables/public/chain_contracts.sql` lists 13 roles without `pause`; `Role` has no `Earlier` | New role `pause`, reuse `earlier`, migration, schema file and test owned by S1 (4.1, 6, D22, D23) |
| Fit B3: the claim page writes counsel's consent wording, and offers the press without a way to read the text | **Held** | The plan's own 3.8 lists consent wording and the long-stop as counsel's | One provisional module `earlier-grant-consent.ts`; neutral sentences; text URL required; press needs the text opened; "no end date" and "cannot be taken away" removed (5.4, D24) |
| Fit I2: hand-copied "a third" and "one day" | **Held** | `day = unit/7`; the demo network uses short units; the record has `dayLength` | `LINE_DIVISOR`, `pause.lineDivisor`; wait rendered from `dayLength`; tests with a short day (1.3, 4.2, 5.1) |
| Fit I3: "never a row" contradicted by `holders[]` | **Held** | RECORD-V2 2.11 lists Team Shares per account | Promise scoped; `grants[]` keeps protected grants (reverses D16); `chain_logs` readers named; test (4.2) |
| Fit I4: `DeployPot` has no test until A5 | **Held** | only `Pragma.t.sol` mentions it | `DeployPotSettings.t.sol` in K1 and K2 plus one anvil run each (3.7, 6) |
| Fit I5: G7 replay, batches, unclear block rule | **Held** | `AllowanceDrawn(by, to, amount, boxAfter)` has no task; `AS_OF_SQL` gives the newest block time; `tag_filters` can find confirms by `task-paid` | Time rule (newest block a minute past the confirm), every row of the transaction, replay and batch rules and tests (4.6) |
| Fit I6: the one fixture is per deployment | **Held** | `chain-reader-fixture.py` plays one chain | Old fixture and example kept; a second small run and example for the pause (4.2) |
| Fit I7: "one press" for an injected wallet | **Partly** | The wallet adapter's `sendCalls` is not shown to batch | Copy rule (never "one press" next to a two-confirmation path); EIP-5792 recorded as not built (5.1, 7) |
| Fit I9: a founder must be told about the pause before launching | **Held** | `LaunchSheet.tsx` shows a fingerprint only | One sentence on the Launch sheet and the Start flow; files added to A5 (5.3, 6) |
| Fit I10: every reader of a person's Shares must add parked | **Held** | e.g. Home's hint, the room's hints, the quote guard | A5 greps and lists them; test with all Shares parked (5.5) |
| Contracts O1, O2, O3, O4, O5, O6 and Fit O1, O2, O3, O5, O6, O7 | **Adopted** | Sponsor batch bound; absolute gas baseline; "additive" wording; mutation `--check` first; pragma tests for the new files; code hash in the event; list hygiene; lighter app (no Take back sheet, card only when relevant, no "near" state, one-clause second line, no "just 33%"); banner rule (one owner); fee destination and extortion row; helper global bound; "unlink to clear"; legacy `earlier` role noted | as listed in sections 1 to 6 |
| Fit O4 (stack risk in `Launcher.launch`) | **Did not hold** | `foundry.toml` has `via_ir = true` | One sentence in 1.2 |
| Contracts O5 (hard-code an allowed code hash in the Launcher), O6 (address and chain in the leaf) | **Not adopted** | a founder cannot judge code; the leaf cannot contain the claim contract's address (the root is a constructor argument) | D26 and 3.8 say why |

**The further power of W1 (end at two thirds).** It was left out in the first version (1.9, D5) with a worked attack (a buyer burns
the team's unvested claim for a net +32,025 on a 2,000,000 pot). Neither reviewer found a hole in that reasoning or argued for
including it; the fit reviewer re-derived its arithmetic. **It stays out.**

**For the owner, in two sentences (so it is not lost in the tables).** The pause as built is a speed bump, not a lock: a third of
the backers' Shares parked stops the team's draws and new plans, and it pays the holders who keep it on (the allowance stays in
the pot, about 20 to 25 days to recoup the fee), while the team can lift it in one transaction for 2% of the margin. Project
zero's earlier pool, if large and mostly unclaimed, cuts the backers' share of any surplus to `b/(b+g)` for ever, also after a
wind-down; set the pool, and decide whether unclaimed rows may ever burn, before any real network.
