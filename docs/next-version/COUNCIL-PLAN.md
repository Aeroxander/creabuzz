# Council plan: the Council runner, seat elections and the replace vote (milestone 9, in the new model)

Status: a plan, **revised once after two independent reviews (contracts, and fit with the product)**. **Nothing in it is built.**
Written 22 November 2026 on branch `v6` at `4c36f73d6`, under the owner's standing go (keep working, no questions); the owner may
overrule any choice in section 8. It builds what step 4 left out on the engineers' judgement: the Council, the seat elections and
the vote to replace the runner. It changes no existing money rule: **with its one switch off, every contract behaves as at
`4c36f73d6`** (section 4 says how that is proved, and says plainly which helper file gains two views). Section 9 says what each
review finding changed, and which did not hold. Not legal or tax advice. No figure here is a promise or a forecast of any result
for anyone.

How to read the numbers. **measured** = counted in a file or build output in this tree (sizes come from `contracts/pot/out`, read,
not rebuilt). **arithmetic** = worked by hand or in plain Python from the contracts' own formulas and the design's own table
(not run against contracts). **estimate** = my guess from EVM gas rules or sizes; the engineer measures and the report says what was
measured. **choice (V#)** = a point I chose; section 8 lists each with its alternative.

**Why this round exists, in the owner's words.** "Initially it should work for the solo AI builder but eventually a project should
slowly transition to a bigger and bigger DAO" (17 November); "need to make sure we can slowly decentralize the governance" (18
November); "the product should be dynamic, not with too many set parameters, so that it is easy for a project to mature on its own
time" and "we should not carbon copy MetaDAO" (19 November). So: a project is run by a founder, then a Pair, then a Council, when it
chooses or when its holders vote, on no schedule and with no cap. The new model has a reason for a holder vote that the old one did not:
**exit alone does not let holders keep a project they like and change who runs it.** Taking out is always open, and stays so; the
replace vote is for the holders who stay.

---

## 0. What was read, and what it says

- `docs/PLAN-V2.md`: the stage lines (section 3, the table row "Who decides" and the Council rules: "5 seats, 3 of 5", "Two seats
  come up every 6 months; a vote lasts 3 days; each parked Share backs one candidate"), milestone 9's rows (section 9: `HolderVote`,
  `Council`, reserve sale; the status table's row 9), and the list after the status table ("Votes count only Shares parked from a
  person's own wallet", "a majority of the Shares that voted ... provided turnout reaches a floor", "the manager's powers are
  bounded now and end by stage").
- `docs/next-version/JOIN-LEAVE-DESIGN.md` sections 1, 2 (2.2 leave, 2.3 the allowance and tasks and the table of what a sleeping
  backer loses), 6 (built code), 9 (what is replaced), 10, 12 (counsel's question 4: is notice plus the right to leave "governance"),
  and choices C11, C13, C14, C18, C19.
- `docs/next-version/STEP4-PLAN.md` and `STEP4-REPORT.md`: the pause as built, its attack table, its switch (D1, D12), its server and
  app parts, and its list of what the first reviewers found.
- The contracts in `contracts/pot/src`: `Treasury.sol` (the runner seat, `onlyRunner`, `_isRunnerBothSigned`, `_isTeamSeat`,
  `_founderAgrees`, `handOver`, `takeSeat`, `announceForfeit`), `Pair.sol`, `HolderPause.sol`, `Launcher.sol` (`makePair`,
  `windDown`, `settingsHash`, the first-hour binders), `Vester.sol` (only for what a vote must not reach), `TaskBook.sol`
  (`noticeFor`), `Interfaces.sol`, `Parts.sol`; the tests' switch-off proof (`OffIsOff.t.sol`: a 154-log journey with a golden
  digest, and a 120-step differential), `SizePause.t.sol`, `PauseBase.sol`, the deploy script and `DEPLOYMENTS.md`.
- The server and app places that already exist for the pause and the Pair: `chain_reader/` (roles, ledger, `record_step4.rs`),
  `handlers/launch_update_authority.rs` (the families of kind 47003), `web_push/`, `app/src/features/pause`, `team` (`pair.ts`,
  `PairCard.tsx`), `seat`, `alerts`, `room` (`PUBLIC_LINE`).
- `VISION.md` and `VISION_MODERATION.md` (the other governance in this repository is a community's owners and admins moderating
  posts). A holder vote on a project's money seat touches none of it: no tension.

Measured facts that shape every choice below:

| Fact | Value | Source |
|---|---|---|
| Treasury runtime size now | **24,080 of 24,576 bytes (496 to spare)** (it was 23,577 before step 4) | `contracts/pot/out/Treasury.sol/Treasury.json` |
| Parts creation code now | **48,810 of 49,152 (342 to spare)**; step 4's stop line was "at least 152 spare" | same, `Parts.json` |
| Launcher runtime | 8,724 (15,852 to spare); Pair 2,558; HolderPause 2,662; Vester 7,955; TaskBook 10,369 | same |
| Tests now | 73 files, 735 test and invariant functions (counted by grep) | `contracts/pot/test` |
| Longest task notice | `noticeFor(500)` = 2N + ceil(500 N / 1400) = **16.5 days when N is 7 days** (1,425,600 s); N is the time unit | `TaskBook.sol` 430 to 436, `MAX_SHARE_BPS = 500` |
| The pause's "day" | `unit / 7` (24 hours on a real network, 240 s when the unit is 1,680 s) | `HolderPause.initialize` |
| What a hostile runner takes from backers who never look | 12.4 / 32.8 / 54.9 of every 100 after 30 / 90 / 180 days at the default allowance (15.0 / 38.6 / 62.3 at the ceiling), every limit binding | JOIN-LEAVE-DESIGN 2.3, "simulated" there |
| App entry chunk | 449,719 of 450,000 bytes: **281 to spare** | `STEP4-REPORT.md`, review fixes (app) |
| Next free migration | 0077 | `migrations/` |

Two consequences before anything is designed. (1) The Treasury has 496 bytes and Parts 342, so **the Council and the vote are new
contracts**; the Treasury, Pair and Launcher take only the smallest hooks, and one of those hooks (`isSeat`, 1.2) makes the Treasury
*smaller*, not larger. (2) The entry chunk of the app has 281 bytes; the first thing the app package does is make room (section 6.8).

**Product check.** The vote is Creaton's, not the relay's: no workspace model is touched. It adds a say to the people who put the
money in, the direction of `JOIN-LEAVE-DESIGN.md` ("governance and exit"). One tension, stated: the design's default is "no vote"
(C11), and counsel's question 4 is still open. **The whole round is behind a switch that is off in every deployment unless the
deployer turns it on**, as the pause is. A second tension: a Council is five accounts, and accounts are free, so a Council is a
structure, not a safeguard (section 3, row 5, and the last line of 6.4).

---

## 1. The Council as a contract design

### 1.1 Shape

One new contract, **`Council`** (`contracts/pot/src/Council.sol`), one small clone per Council, made by the Launcher and holding the
Treasury's runner seat the way a Pair does: the Treasury's runner address is the Council contract; the Council calls the Treasury
only from inside `agree` when three of five seats have agreed to exactly that call. **It has no power a runner does not already
have, and fewer than a Pair** (1.8). Every limit of the Treasury binds it unchanged: the allowance ceiling and the box, the task
caps and the notice, the check-in window, the pause. It holds no dollars, has no owner, no upgrade, no payable function.

Five seats, three of five needed. A seat is an account. An action is **proposed** by one seat (which counts as its agreement), sent
the moment a third seat has **agreed**, can be **taken back** by an agreeing seat any time before that, and **runs out** 2 time
units after it was proposed (14 days on a real network, as a Pair's does). Seats cannot be sold or lent: the contract has no
transfer of a seat; a seat holder can only give it up.

### 1.2 Exactly what changes

| File | Change | Size effect (estimate; the engineer measures) |
|---|---|---|
| `contracts/pot/src/Council.sol` | **new**, about 250 lines (1.3 to 1.6) | about 5 KB runtime; it is not in Parts (V4) |
| `contracts/pot/src/Pair.sol` | one view, `function isSeat(address a) external view returns (bool) { return a == first \|\| a == second; }` | +about 45 bytes of Parts creation code |
| `contracts/pot/src/Interfaces.sol` | `ILauncherPairs` gains `runnerKindOf(address) returns (uint8)` (0 = not a runner contract, 1 = a Pair, 2 = a Council) and keeps `isPair`; `IPairSigners` gains `isSeat(address) returns (bool)`; `ITreasuryRunner` gains `pauseGate()` (the Council reads it at birth; the Treasury already has it as a public variable); new `ICouncilVote` and `IVoteSeat` (what the Council and the vote ask of each other) | none |
| `contracts/pot/src/Treasury.sol` | **(a)** `_isRunnerBothSigned` (line 982): `if (!isPair(r)) return true;` becomes `if (runnerKindOf(r) == 0) return true;`; **(b)** `_isTeamSeat` (lines 996 and 997): the `isPair` test becomes `runnerKindOf(r) == 0` and the last line becomes `return IPairSigners(r).isSeat(a);` (one call in place of two); **(c)** a private `_seat(address to, bool trim, bool clean)` that is the body `takeSeat` has today (set the runner, clear `pendingRunner`, `pendingTrim`, `pendingSeatAt`, `++agentEpoch`, emit `RunnerChanged`, trim the founder's grants when `trim`) plus, when `clean`, `(pendingRatePpm, pendingAt) = (0, 0)`; `takeSeat` becomes `_seat(msg.sender, trim, false)` (the same effects in the same order as now); **(d)** one new function `seatByVote(address council)` after `takeSeat`: only `pauseGate` (and only when it is not zero) may call it, `runnerKindOf(council)` must be 2, then `_seat(council, false, true)`. It does not ask who holds the seat now (2.7). **Not changed, on purpose:** `announceForfeit` (801), `_founderAgrees` (1047 and 1048) and `checkIn` (507): they keep asking `isPair`, so a Council can never announce a forfeit and can never mark "founder leaves" (1.8) | (a) and (b) save about 100 bytes, folding `takeSeat` into `_seat` saves about 60, (d) adds about 150: **net about +0 to +100**; gate: grows by at most 190 bytes, keeps at least 300 spare (SizeCouncil, section 7 K1) |
| `contracts/pot/src/Launcher.sol` | `mapping(address => uint8) public runnerKindOf` **replaces** `mapping(address => bool) public isPair`; `isPair(a)` becomes a view that returns `runnerKindOf[a] == 1` (same selector, same answer; `makePair` writes `runnerKindOf[pair] = 1`, the same one storage write as today) and `isCouncil(a)` returns `== 2`; so the Treasury's check is still **one** storage read of the Launcher, as now (no gas difference for a founder or a Pair runner; K1 measures `draw` and `announceTask` against the recorded baseline). New: `address public councilImpl` and `bindCouncil(impl)` (deployer only, once, first hour, impl has code, the pause is bound; emits `CouncilBound(impl, codehash)`); `makeCouncil(key, members, salt)` and `councilAddress(key, members, salt)` (the hand-over path; address committed to the project, the five accounts and the salt); K2 adds `councilByVote(key, members, ballotId)` (the vote path, 2.8; its own address space, salted by the ballot, so the same five can be elected again); `isProjectAccount(key, a)` (true for the project's Treasury, Vester, both tokens, pause gate, the Launcher, the Council implementation and any registered runner contract: such an account can never act, so neither `makeCouncil`, `councilByVote` nor the vote's standing accepts it as a seat; smart accounts, which passkey accounts are, stay allowed); `windDown` (line 291) asks `runnerKindOf[runner] != 0 && !IPair(runner).bothSigned()`; `settingsHash()` gets a fourth form when a Council is bound (4.2) | +about 1,100 bytes (8,724 now) |
| `contracts/pot/test/helpers/Mocks.sol` | **additive only, two small stubs, no assertion in any test changes:** `MockSalePath` (it implements `ILauncherPairs`, so it must) gains `runnerKindOf` (1 for an address registered as a Pair, 2 for one registered with a new `setCouncilLike`, else 0); `MockPair` gains `isSeat` (`a == first \|\| a == second`). Without them every runner-only call of 23 existing test files would revert, because `Treasury` now asks `runnerKindOf` of the mock | test code only |
| `contracts/pot/script/DeployPot.s.sol`, `DEPLOYMENTS.md` | the `COUNCIL` setting (4.3) | none |

**`isPair` stays true for Pairs only.** The server's `runner.isPair`, the app's Pair card and `announceForfeit` read it. `runnerKindOf`
is the union and is the only thing the two runner-seat checks of the Treasury now ask. For every Pair, `_isRunnerBothSigned` and
`_isTeamSeat` give exactly what they gave (the golden journey has a Pair); for a founder alone they give what they gave.

### 1.3 The Council's state and calls

State: `treasury`, `launcher`, `vote` (the Treasury's `pauseGate()` at birth; zero when the project has no pause), five seat
accounts, five `seatedAt` times (when the account took the seat; zero = open seat), five `lastUp` times (when the seat last came up
for a vote or changed; the order of rotation), `generation` (a counter that goes up whenever any seat changes), `nextElection`
(when two seats next come up), `nonce`, `PROPOSAL_TTL` (2 time units, read from the Treasury as the Pair does), a mapping from
proposal id to `{at, generation, mask}` (one storage slot; `mask` has one bit per seat that agreed), and a transient `_executing`.

| Call | Who | What it does | Reverts when |
|---|---|---|---|
| `initialize(treasury_, launcher_, members, takeSeat_)` | the Launcher, in the transaction that creates the clone | stores the five distinct non-zero accounts as the seats, all seated now (`seatedAt = lastUp = now`); `nextElection = now + 26 units`; reads `pauseGate()`; with `takeSeat_` calls `treasury.takeSeat()` (the hand-over path: the Council takes the seat the runner offered to its address, as a Pair does); with `takeSeat_` false (the vote path) the vote contract seats it by `Treasury.seatByVote` in the same transaction (2.8) | already born or the locked implementation; a seat zero or repeated |
| `propose(target, data)` | a seat | checks the call is on the list (1.4); stores the proposal with this seat's agreement; emits `Proposed` (the same signature as the Pair's, so the app reads both the same way) | not a seat; target not the Treasury or the Launcher; selector or argument not on the list |
| `agree(target, data, n)` | a seat | the id commits to the Council, target, bytes and number; adds this seat's agreement. **When the count reaches three it deletes the record first, then sets `_executing`, runs the call, clears `_executing`, and emits `Executed`** (the same order as the Pair's `confirm`: a proposal runs once, and seats 4 and 5 find no record and revert). The runner checks see `bothSigned()` true only inside that call. The third seat pays the gas. A call that fails reverts everything, the deleted record included (so it stays pending, as the Pair's does), with its own error | unknown call (also one that already ran); this seat already agreed; older than `PROPOSAL_TTL`; the generation moved; `_executing` is set (re-entry, for example a seat that is a contract receiving a draw) |
| `withdraw(id)` | a seat that agreed | takes its agreement back, before the call has run; a proposal with no agreement left is deleted (`Cancelled`) | not agreed by this seat; unknown |
| `resign()` | a seat | the seat becomes open (`seatedAt` zero), `generation` goes up | not a seat |
| `bothSigned()`, `isSeat(a)` (**false for the zero address**, which is how an open seat is stored), `seatOf(i)`, `seatList()`, `agreedCount(id)`, `callId(...)`, `upNext()` | views | | |
| `openElection()` | the project's vote contract only (`msg.sender == vote`) | requires `now >= nextElection`; sets `nextElection = now + 26 units`; sets `lastUp` of the two seats that come up to now (so rotation moves on whatever the result); returns the two seat numbers (1.5) | not the vote contract; not due |
| `seat(upA, upB, winnerA, winnerB)` | the vote contract only | `upA`, `upB` are the ballot's two up seats (distinct, 0 to 4); puts the winners in them (1.5 says which seat each takes; a zero winner leaves that seat's holder); `seatedAt` of a changed seat is now; `generation` goes up; emits `SeatsSet` | not the vote contract; a winner already holds a seat that is not up |

The Council has **no function that moves a token, an approval or a dollar**; it can only call the Treasury or the Launcher, and only
with a call on the list.

### 1.4 What the Council may call (the list)

`propose` accepts a call only if its target and selector are one of these. The list is the plan's reading of X1's "every runner
action", plus what the runner needs to run the helpers (V2). It is a table in the contract, tested against the Treasury's built ABI
(1.9).

| Target | Allowed | Not allowed (and why) |
|---|---|---|
| Treasury | `draw`, `checkIn`, `proposeRate`, `setRate`, `setDoor`, `announceTask`, `acceptTask`, `rejectTask`, `cancelTask`, `grantTeam`, `setAgent`, `authoriseAgent`, `revokeAgent`, `handOver` (only with `founderLeaves` false: an argument check), `windDown` | `announceForfeit` (a Pair-only power, 1.8); every call the runner cannot make anyway (`join`, `leave`, `settle`, `takeTask`, `claimNote`, ...) |
| Launcher | `windDown(bytes32)` | everything else (`makePair`, `makeCouncil`, the admin calls) |

`checkIn` needs three of five, as every runner action does (X1; V3 records the lighter choice).

### 1.5 How seats change hands

Only these four ways (V15). There is no "remove a seat" call: three seats cannot push out the other two.

1. **At the start**, by a hand-over or a replace vote (2.8): five accounts are seated together.
2. **By election** (2.9): two seats come up every 26 time units, **the two seats that have gone longest without coming up** (`lastUp`;
   a seat that is open counts as time zero, so open seats are first; a new seat counts from the day it was filled; ties go to the
   lower number). `openElection` says which two (`upA`, `upB`) and moves their `lastUp` to now. The result is put in by the vote
   contract's `seat`. **Which seat a winner takes:** a winner who now holds one of the two up seats stays in it; any other winner
   takes an up seat nobody has just kept, the lower-numbered first; an up seat with no winner keeps its holder. An account that
   holds a seat which is **not** up cannot stand (2.3), so a winner never holds two seats. If nobody stands, or turnout is short,
   or nobody beats "keep", nothing changes but the two `lastUp` times.
3. **By resigning**: a seat holder gives up their own seat. An open seat comes up first at the next election.
4. **As a whole**, by the runner seat itself: the Council may hand the seat on (`handOver`, which any runner may do, and which a
   replace vote may also do to a Council from outside), and a replace vote moves the seat to a new Council (2.8).

An account holds one seat only (checked at `initialize`, at `seat`, and at standing). The zero address is never a seat holder
(`isSeat(0)` is false, and an open seat is the zero address). Whenever a seat changes, `generation` goes up and **every older
proposal is dead**: an agreement given by a seat holder who has since left the seat can never be counted.

**What a seat holder cannot do.** Be paid for tasks or take one: `Treasury._isTeamSeat` now asks the runner contract `isSeat`, so all
five accounts are barred from `takeTask` and from being a payee or an accept-recipient, exactly as a Pair's two signers are. (This is
not a defence against a hostile Council: it takes tasks through a sixth account, and the attack figures assume that, section 3.) A
worker who is elected while holding an open taken task cannot be paid for it, the same as a Pair signer (V43).

### 1.6 Events

| Contract | Event | Meaning |
|---|---|---|
| `Council` | `Proposed(bytes32 indexed id, address indexed by, address target, bytes data, uint256 nonce)` | the Pair's own signature, so one decoder reads both |
| `Council` | `Agreed(bytes32 indexed id, address indexed by, uint8 count)` | a seat agreed; `count` after |
| `Council` | `Withdrawn(bytes32 indexed id, address indexed by, uint8 count)` | an agreement was taken back |
| `Council` | `Executed(bytes32 indexed id, address indexed by)` | the third agreement came and the call ran |
| `Council` | `Cancelled(bytes32 indexed id)` | the last agreement was taken back |
| `Council` | `SeatsSet(address[5] seats, uint64[5] seatedAt, uint32 generation, uint64 nextElection)` | at birth and after every seat change: the whole picture, so a reader never rebuilds seats from deltas |
| `Council` | `Resigned(uint8 seat, address indexed who)` | |
| `Launcher` | `CouncilBound(address impl, bytes32 codehash)` | the switch, once |
| `Launcher` | `CouncilMade(bytes32 indexed key, address indexed council, address[5] members, bool byVote)` | a Council exists; the reader finds it from this |
| `Treasury` | `RunnerChanged(from, to)` | unchanged: a Council taking the seat, by hand-over or by vote, is this event |

### 1.7 Gas and size (estimates), and the planned fallback

`propose` about 85,000 (one new slot); the first `agree` after it about 35,000; the third `agree` adds the call it runs. `makeCouncil`
about 450,000 (a clone, the seats in a few slots, `takeSeat`). Gates, measured by K1 in `GasCouncil.t.sol`: `propose` at most
130,000, `agree` (not the one that runs) at most 60,000, `makeCouncil` at most 600,000; **`draw` and `announceTask` by a founder and by
a Pair cost the same as the baseline K1 records first** (the Treasury still reads one Launcher slot). Size gates (`SizeCouncil.t.sol`):
Treasury grows at most 190 bytes and keeps at least 300 spare; Parts creation code keeps at least 152 spare (the Pair may grow at
most 190); Council runtime under 24,576 with at least 3,000 spare; Launcher under 24,576.

**Planned fallback if the Treasury will not fit (so a stop is a branch, not a failure).** K1 measures first, after (a), (b) and (c)
above. If `seatByVote` still does not fit under the gate: (1) fold the shared bumps further into `_seat` and drop the `clean` branch
into `seatByVote` alone; (2) if still over, **ship the Council by hand-over only**: K1 completes without `seatByVote`, K2 is not
started in this round, S1 and A1 build the `council` role, the Team section and the hand-over sheet, and the report says plainly that
X2(b), the replace vote and the elections, were not built and why, with the measured bytes. This order is agreed now.

### 1.8 What a Council can and cannot do that a Pair cannot

| | Pair | Council |
|---|---|---|
| Money and rule calls (draw, plan, accept, reject, cancel, rate, door, grant, agents, hand over, wind down) | both signers | three of five |
| Check in | either signer alone | three of five (V3) |
| Announce a forfeit of a member's grant without their say (`announceForfeit`) | both signers | **cannot**: not on the list, and the Treasury asks `isPair` for it |
| Mark a hand-over "founder leaves" (trims the founder's grants) | the founder, as a signer | **cannot**: not on the list, and `_founderAgrees` asks `isPair` |
| Call any Launcher function | yes (target Launcher) | only `windDown` |
| Be replaced by its holders' vote | **yes** | **yes** (the replace vote moves any runner, a Council included) |
| Have seats rotate by election | no | **yes**: two seats every 26 units |
| Take a seat's place when a signer's key is lost | cannot (a lost key is a dead Pair) | three seats can still act; with fewer than three live seats the project goes quiet, and anyone may wind it down after 26 quiet units |

Nothing a Council can do moves a limit: it cannot raise the allowance past 0.20% a day, cannot take more than 5% for one task or 10%
of the pot in 28 days, cannot shorten a notice, cannot reach the box beyond 7 days of allowance, cannot touch a grant, cannot stop a
Take out, and cannot make the pause go away.

### 1.9 Tests that bind it (K1)

`Council.t.sol` (unit), `CouncilAccess.t.sol` (every Treasury function is either on the list and works through three seats, or is
off the list and reverts through the Council; the list is compared with the ABI in `out/`; **both `announceForfeit` and `handOver(.., true)` are
proposed through the Council and `propose` reverts**, and separately a Council-like test contract that is registered as kind 2 and
executes the same calls with `bothSigned` true is refused by the Treasury itself), `CouncilSeats.t.sol` (one seat at a time, resign,
generation fence, `_isTeamSeat` for each of the five seats, `isSeat(address(0))` false, which seat a winner takes, `agree` reverts
while `_executing`, a record is gone after it ran so seats 4 and 5 cannot run it again), `LauncherCouncil.t.sol` (including a project
account refused as a seat), `CouncilInvariants.t.sol`, `CouncilEventsRebuild.t.sol`, `GasCouncil.t.sol`, `SizeCouncil.t.sol`,
`OffIsOffCouncil.t.sol` (section 4), a Treasury test of `seatByVote` (only the gate; only a kind-2 address; the offer, the helpers
and the pending rate cleared; **a puppet offered the seat during the wait cannot take it after the vote seated**). Falsifiability:
every guard named in section 7 K1's mutation list is switched off once and a named test must fail. **Test runs are chunked** (by
`--match-path` groups, each under `nice` and `timeout 1500`), so a timeout is never mistaken for a failure.

---

## 2. Elections and the replace vote

### 2.1 Where votes are counted: inside the pause's custody, in a contract that extends it

Votes count only Shares parked in the pause. The smallest change that is also correct is therefore **a contract that is the pause
and also holds the ballots**: `HolderVote is HolderPause` (new file `contracts/pot/src/HolderVote.sol`). It is the project's
`pauseGate` when the deployment's switch is on (4.3), so the Treasury still asks it `paused()` and tells it `poke()` exactly as
before, and nothing new is added to the Treasury for counting.

`HolderPause` itself changes by **three lines and two empty functions**: `park` and `unpark` each call `_beforeChange(who)`,
`unpark` also calls `_afterUnpark(who, newParked)`, and both are `internal virtual` with empty bodies in `HolderPause`. With
`bytecode_hash = "none"` and `via_ir`, empty internal functions compile to nothing; `HolderPause`'s behaviour, events and gas are
unchanged (the whole pause suite, unedited, is the witness, and `GasPause.t.sol` still holds). This is what lets "where votes are
counted" be a place a vote cannot be bypassed: a Share can only leave the custody through `unpark`, and `unpark` runs the hook.

Alternatives (V5): a separate vote contract that the pause calls (a call-out from `unpark` that must never revert, a new place to
bind and a new trust edge); a copy of the pause with ballots added (a second 100 lines to keep equal); counting from checkpoints of
every account (a history array per account, paid by every parker whether or not a vote exists).

`HolderVote` also calls two things: the Launcher (`councilByVote`, to make a Council) and the Treasury (`seatByVote`, to seat it),
only in `carryOut` (2.8). It still holds no dollars and has no payable function.

### 2.2 The counting rule: a snapshot and a fall, with no loop over voters

A ballot has one **snapshot moment**, the second it opens. For each account a ballot needs one number, **its eligible weight**: the
fewest Shares the account had parked at any moment from the snapshot until now. That makes both of X3's rules true at once:

- *Shares parked after the vote opens do not count*: parking can only raise the balance, never the fewest-since-open.
- *A Share that leaves custody stops counting*: an unpark lowers the fewest-since-open, and lowers the weight already cast.

How it is kept without history and without a loop: per account the contract keeps `(stamp, low)`, packed in one slot. `stamp` is the
id of the ballot `low` belongs to. `_beforeChange(who)` runs before every park and unpark while a ballot is live: if `stamp != id`
it writes `(id, parkedOf[who])`, the balance at the snapshot (nothing could have changed it since, or `stamp` would already be
`id`). `_afterUnpark(who, newParked)` sets `low = min(low, newParked)` and, if the account has a weight cast in this ballot above
`newParked`, lowers it to `newParked` and takes the difference off its option's tally, emitting `Fell`. `weightOf(who)` is `low`
when `stamp == id`, and `parkedOf[who]` otherwise (untouched since the snapshot, so equal to its balance then).

- **A hook that cannot block taking out.** `unpark` is "never slowed" (STEP4-PLAN 1.5; the batch `[unpark, leave]` is a Take out).
  The hook has no external call, no loop and no allocation; its arithmetic is guarded by an invariant (a tally is the sum of the
  weights cast on it, so a weight can always come off), and a test fuzzes `unpark` with every ballot shape and state, and asserts it
  never reverts for a ballot's reason (K2, invariant 1). It runs **only while `now < voteEnd`** (the same test `castVote` uses; both are tested at the exact second): after the vote ends the tallies are
  frozen, and an unpark changes nothing in them (the result stands, 2.5).
- **Cost to the people who never vote.** Outside a live ballot the hook reads one storage slot (the ballot's end time) and returns.
  Inside one, the first park or unpark of an account writes one slot; later ones write nothing unless the account has a vote cast.
- **A vote moves with the voter.** Casting again moves the account's whole eligible weight to another option until the vote ends.
  There is no partial weight: one account, one option, all of what counts (V8).

### 2.3 Ballots, options and who stands

One ballot at a time per project. A ballot is one of two kinds. Its options are numbered; **option 0 is always "keep"** (replace:
keep things as they are; seats: keep the two seats' holders), and each Share counted is on exactly one option.

| | Seat election (`seats`) | Replace vote (`replace`) |
|---|---|---|
| Decides | who holds the two seats that come up | whether to move the runner seat to a new Council of five, and who they are |
| Options | 0 keep; then the accounts that stood (at most 12), each one account | 0 keep; then lists (at most 4), each five distinct accounts and a short text |
| Opened by | anyone, when `nextElection` has passed (the helper does); nobody is entered at opening | a holder, **with their own list in the same call**: `openReplace(members, recordHash)`. A ballot with nothing to choose between is never opened |
| Who stands | the account itself: `stand(recordHash)` | any parked holder: `standList(members, recordHash)` |
| A Share counts for | keep, or one person | keep, or one list |
| Open to | any Council project, when the two seats are due | any project that has a pause and a vote contract, when holders ask (2.10) |

**Standing.** For the first **1 day** of a ballot (`STAND_DAYS`; a day is `unit / 7`) names may be put forward; then the list is
fixed and **voting runs for the next 3 days** (`VOTE_DAYS`: "a vote lasts three days"). `castVote` is refused before the list is
fixed and from `voteEnd` on, so a flash loan or a one-block holder can never open, stand and vote in one transaction. To stand, an
account (for a list, the proposer) needs an eligible weight of at least one thousandth of the Shares at the snapshot (`STAND_DIVISOR
= 1000`) and may stand once per ballot. An account that holds a seat which is not up cannot stand for a seat. A list's five
accounts must be distinct, non-zero and **not an account that can never act** (the project's own contracts: `Launcher.isProjectAccount`,
1.2; a ballot's winning list can then never make `carryOut` revert); they need not be holders and nobody asks them.

**Places are ranked by stake, so junk cannot crowd out honest names.** When all places are taken (4 lists, 12 people), a new entry
whose proposer's eligible weight is **strictly larger** than the smallest stake already standing takes that entry's place (the same
option number; the earlier entry's proposer may not stand again in this ballot); an equal stake never displaces. This happens only
inside the stand window, when every tally is zero, so no vote is ever cut. `Stood` names the displaced proposer (zero when none).
Holders who do not like any name vote "keep", which is always there.

**Voting.** `castVote(option)`: an account with an eligible weight of at least one whole Share (`MIN_VOTE`; so a dust account cannot
fill the logs) puts all of it on one option; again before `voteEnd` it moves (2.2).

**The candidate's short text** is a signed record tied to the vote (5.4): the chain keeps only its hash (`recordHash`, the signed
event's id, as a weekly check-in keeps its record's hash), so a text can never be swapped after people have voted.

### 2.4 Every number, in one table

All are named constants of the contract, read by the server from views and carried to the app in the record's `vote.rule` block
(5.2), so **no screen types a number**. Dollar columns are what the Shares are worth at face on a pot of 10,000 and of 1,000,000 with
no surplus (arithmetic, rounded).

| Number | Rule | 10,000 | 1,000,000 | Why |
|---|---|---|---|---|
| Stand window | `STAND_DAYS = 1` day after the ballot opens | | | holders can see a ballot before names are final |
| Vote length | `VOTE_DAYS = 3` days, after the stand window | | | the owner's "a vote lasts three days" |
| Snapshot | the second the ballot opens (2.2) | | | X3: a late large buyer cannot swing it |
| To open a replace vote | caller's eligible weight at least 1 in 1,000 (`STAND_DIVISOR`) **and** the Shares parked in all at least 1 in 20 (`OPEN_DIVISOR = 20`), and the caller's own list in the same call | 500 parked | 50,000 parked | a crowd has parked, not one idle account |
| **One turnout floor for both ballots** | Shares cast at least a third of the backers' Shares at the snapshot (`LINE_DIVISOR`, the pause's own constant) | 3,333 | 333,333 | X3: start from the pause's own line. One floor, not two: a lower floor for seats would be a cheap way round the replace vote's (V9) |
| Smallest vote | `MIN_VOTE` = one whole Share of eligible weight | | | bounds the vote logs |
| A list wins | its Shares are **more than half of all Shares cast** (keep and every list counted), and the floor is met | | | a split opposition cannot let a minority list through; not voting is never "no" |
| A person wins a seat | the floor is met, the person's tally is **strictly more than "keep"**, at least one whole Share, and among the top two persons; a tie for the last seat leaves that seat as it is | | | holders can always answer "keep"; a tie never replaces anyone |
| To stand | eligible weight at least 1 in 1,000 (`STAND_DIVISOR`) | 10 | 1,000 | a ballot with 4 list places and 12 person places is not filled for free |
| Places | at most 4 lists, at most 12 people; when full a strictly larger stake takes the smallest stake's place (2.3) | | | bounded loops; junk cannot crowd honest names out |
| The wait | `WAIT` = the Treasury's `noticeFor(500)` first value, read at the ballot's opening: **16.5 days** at a 7-day unit | | | X4: as long as the longest task notice |
| Result takes effect | `effectiveAt = voteEnd + WAIT`, fixed at opening | | | nobody can speed or delay it by when they call |
| A result nobody carried out | lapses 2 time units after `effectiveAt` | | | no ballot can block the next one for ever |
| Replace cooldown | 4 time units (28 days) after the end of a replace vote **that ended "kept" with the floor met** (holders answered). **None** after a vote that fell short, one that moved the seat, or one that lapsed | | | a real "no" from holders is not repeated at once; a junk ballot cannot hold the door, and a counter-vote can open the day after a takeover is carried out |
| Seats come up | 2 seats every 26 time units (182 days), the two that have gone longest without a vote first | | | PLAN-V2: "two seats every 6 months" |

On a test network with a unit of 1,680 seconds: the day is 240 s, stand 4 minutes, vote 12 minutes, the wait 66 minutes, so a result
takes effect 82 minutes after opening; a Council's proposals last 56 minutes and seats come up every 12 hours (arithmetic). The
server's record refresh and the helper's pace on such a network are a quarter of the stand window, never more than 600 seconds
(5.3, 5.5), so a demo voter sees the card for the whole vote.

### 2.5 One replace vote, in time (unit 7 days; arithmetic)

| When | What happens | What a holder sees and can do |
|---|---|---|
| day 0 | someone opens the vote with their own list; the snapshot is taken | the project page shows the vote card ("A vote on who runs this project"); an alert reaches every holder; **take out** |
| day 0 to 1 | more lists are put forward, each with a short text | read them; stand a list if you have parked; take out |
| day 1 to 4 | holders vote (each account once, movable) | vote with the Shares you had parked at day 0; take out |
| day 4 | the vote ends; the tallies freeze. **The server reads the result from the frozen tallies at once and shows it** (it does not wait for anyone to press anything); the helper then records it on the network (`finish`) | the card says the result and the date it takes effect, in the same words as a planned task: "take your money out before then"; the alert and the push go the same hour |
| day 4 to 20.5 | **the wait**: the present runner still runs the project, under the same limits | take out at the value before the new runner can do anything (a Take out pays the pot, which never includes the allowance box) |
| day 20.5 | the helper (or anyone, from any wallet: the call is open) carries the result out; a Council of the five is made and takes the seat; agents set by the old runner stop; **pending offers and a pending rate are cleared** | the Team tab shows the Council. **A counter-vote may open from this day** (2.4: no cooldown after a result that moved) |

A person who looks every 7 days always has at least 13.5 days left before the seat is taken (the vote opens at the earliest just after
their look, they see it by day 7, the seat is at day 20.5); one who looks every 14 days at least 6.5. A person who looks only every 21
days can be caught (the whole span is 20.5 days). The card's last line (6.2) says "if you will be away, you can take your money out first".
**The least time a hostile Council can hold a seat it took by vote** is the next vote's own length: a counter-vote opened on day 20.5
ends on day 24.5 and takes effect on day 41, so the seat is held for **at least 20.5 days** (arithmetic). The design's figure for what a
runner takes is simulated at 30 days (12.4 of every 100); for 20.5 days it is lower and is not simulated here, so 12.4 is stated as the
upper bound.

### 2.6 Results, exactly

At `voteEnd` the tallies are final. **Two readers say the result and they must agree:** the contract's `finish(id)` (anyone, once; any
later `openX` or `carryOut` also does it first) and the server's reader, which computes the same result from the frozen tallies and the
floor (5.2) and shows it the moment `voteEnd` passes. `finish` is the confirmation on the network, not the trigger for the warning.

- replace: if the Shares cast are under the floor, outcome **short**; else if one list has more than half of all Shares cast,
  **moved** to that list; else **kept**. Kept and short change nothing; only a kept result with the floor met starts the cooldown.
- seats: if the Shares cast are under the floor, **short**; else the persons whose tally is strictly more than "keep" and at least
  one whole Share are ranked by tally and the top two take the two seats (**seated**, or **seated one** if only one qualified; a tie
  for the last seat leaves that seat as it is); nobody qualifying is **unchanged**.

A win starts the wait; `effectiveAt` was fixed at opening. **Seat results wait too** (V12): one rule everywhere, "every result takes
effect after the same wait and is shown like a planned task", easier to say and test than one rule for seats and another for lists.

### 2.7 What holders can do during the wait (and what they cannot)

They can take out, any day, in one press as today. They can vote nothing more (the ballot is closed). They cannot cancel a result
(V11: a cancel by a counter-vote would be a second vote with a second snapshot; the answer for a holder who disagrees is exit; a
counter-vote can open once this result has been carried out, 2.5). The present runner keeps every power it has, with the same limits:
it may draw its box, plan tasks, grant Team Shares, hand the seat to someone else, **or wind the project down by choice, in which case
the result lapses and nothing is seated** (an existing power, stated in the residual risk, section 3). **None of that is new**:
`carryOut` puts the new Council in the seat whoever holds it then (`Treasury.seatByVote` does not ask who holds the seat), **clears an
offer the old runner made to a puppet and a rate it proposed** (so neither can reach the new Council), and stops the old runner's
agents. A replace vote **never touches a grant**: there is no path from the vote contract to the Vester, and a test says so.

### 2.8 How a project gets its first Council

**By a hand-over (the present runner chooses).** The runner is a founder alone or a Pair with both signers. In the Team tab "Hand over
to a Council": the app asks for five accounts (the founder may be one) and an optional salt, works out the Council's address
(`Launcher.councilAddress(key, members, salt)`, which commits to the project, all five accounts and the salt), and sends
`Treasury.handOver(thatAddress, false)` (as a Pair proposal when the runner is a Pair). Then anyone calls
`Launcher.makeCouncil(key, members, salt)`: the clone is made at that address, initialised, and takes the seat in the same call
(`takeSeat`, exactly as a Pair does; the offer lasts 2 time units). A third party cannot change the five accounts: the address would
differ, and an offer to the real address would not be taken. No wait, no vote, no cost but gas. The founder's Team Shares are not
touched (`founderLeaves` is false). A hand-over to a wrong address cannot lock the seat: the offer runs out and nothing takes it.

**By a replace vote (the holders choose).** Anyone with enough parked Shares opens a replace vote (2.3 to 2.6). If a list wins, then
at `effectiveAt` anyone calls `carryOut(id)`: the vote contract asks the Launcher for a Council of the winning five
(`councilByVote(key, members, ballotId)`, which the Launcher allows only for the project's own vote contract, checked through the
Treasury's `pauseGate()`), and then calls `Treasury.seatByVote(council)`, which only the project's `pauseGate` may call and which only
accepts a kind-2 address the Launcher made. Both in one transaction: either the Council is seated or nothing happened. **The vote
path has its own address space:** the Council's address is derived from `(key, members, ballotId)` with a tag no hand-over salt can
equal, so the same five accounts can win a vote twice, or win after an earlier hand-over Council of the same five, without the address
being taken (a test says so). The vote may name any runner as the one being replaced: a founder alone, a Pair, or a Council (removal, 2.11).

### 2.9 Seat elections

Once a Council is the runner, two seats come up every 26 time units. Anyone may open the election when it is due (the helper does,
5.5); opening calls the Council's `openElection` (which says which two seats, moves the next date on, and moves those two seats'
`lastUp`), and a ballot of kind `seats` begins with "keep" as option 0. Standing, voting, the one floor and the wait are as above. At
`effectiveAt` anyone calls `carryOut(id)`: the winners are put in by the Council's `seat` (1.5 says which seat each takes). **When nobody
stands, turnout is short, or nobody beats "keep", the seats stay as they are** and the rotation moves on. If the helper is off nothing
opens by itself, and the election waits until anyone opens it: nothing is lost. Election order for a fresh Council: seats 0 and 1, then
2 and 3, then 4 and 0, and so on.

**Taking control by elections alone** needs three seats, so two elections won, 26 units apart: control comes about 385 days after the
Council was seated (arithmetic: the second election opens at 52 units, its vote ends 4 days later, the wait is 16.5 days), at the same
cost as the replace vote (row 21 of section 3), and holders see each election coming, can answer "keep" in each, and can leave at any
time. The replace vote is the fast way and has the same floor and the same wait.

### 2.10 Who may open a vote, and how often (spam)

- **One ballot at a time.** A new one can open only when the last has been finished and carried out, or has fallen short or been kept
  or unchanged (nothing to carry out), or has lapsed.
- **Replace**: the caller's eligible weight is at least 1 in 1,000 of the Shares, the Shares parked in all are at least 1 in 20, the
  caller puts a list in the same call, no ballot is live, the replace cooldown (only after a "kept" result with the floor met, 2.4) is
  over, and the project is not wound down. Cost of opening: nothing but gas and the parked Shares' time; the bound is that each ballot
  takes 4 days and needs the 5% of the Shares parked first, that holders who answer "keep" and meet the floor hold the door for 28 days, and that
  the server sends at most one "a vote is open" push per project per time unit.
- **Seats**: any account, only when `now >= council.nextElection()`; so once per 26 units, by the clock.
- **Standing**: once per account per ballot; at most 4 lists and 12 people; a larger stake takes the smallest stake's place (2.3).
- **A residual (stated, not hidden):** a project can have a replace ballot after a replace ballot with nothing between them, so a
  steady opener can keep elections from opening (an election can open only when no ballot is live). Each such ballot is visible, takes
  4 days, changes nothing, and costs the opener the parked 5% for as long as it is parked. Holders who want a vote on seats open it
  themselves the moment a ballot ends (the call is open to anyone). V13 records the alternative (letting seats block replace votes)
  and why it was not chosen: it would hide the holders' recovery behind a helper.

### 2.11 Terminal states, and a Council's removal

Every ballot ends in one of: `short`, `kept`, `unchanged` (finished, nothing to carry out), `carried out`, or `lapsed` (a won result nobody
carried out within 2 time units after `effectiveAt`, or whose project was wound down in the meantime, or, for seats, whose Council is no longer the runner; anyone calls `lapse(id)`).
`finish`, `carryOut` and `lapse` are permissionless and none moves a dollar. A failed `carryOut` leaves the ballot as it was and can be
retried until the lapse; that is the durable retry record (rule 1), and the helper retries with backoff and a terminal state (5.5).
**If the helper is off, a won result is not lost until the lapse:** anyone may call `carryOut` from any wallet or tool in that time
(the app has no press for it, V33); after the lapse the old runner simply stays, which is the safe default for holders.

**Removing a seated Council** has four doors, all visible and none by the Council's own say: (1) a replace vote moves the seat to a
new Council (2.8); (2) elections rotate seats, two per 26 units; (3) a seat holder resigns; (4) the Council itself may hand the seat
on. Holders can always take out first. A Council with fewer than three live seats can do nothing, goes quiet after 14 days with no
check-in, and anyone may wind it down after 26 quiet units; a replace vote also remains open to holders (it needs no help from the
Council), subject to "one ballot at a time" and to the cooldown only after a real "kept".

### 2.12 Events and views

| Contract | Event | Meaning |
|---|---|---|
| `HolderVote` | `BallotOpened(uint32 indexed id, uint8 kind, uint64 openedAt, uint64 standEnd, uint64 voteEnd, uint64 effectiveAt, uint256 supply, uint256 floor, uint8 upA, uint8 upB, address by)` | a ballot opened; every number a reader needs; `upA`, `upB` are the two seats for a seat election |
| `HolderVote` | `Stood(uint32 indexed id, uint8 option, address indexed by, address[5] members, uint8 count, bytes32 recordHash, address displaced)` | a person or a list was put forward at `option`; `displaced` is the proposer whose place it took (zero when none), so a reader replaces that option's entry |
| `HolderVote` | `Voted(uint32 indexed id, address indexed who, uint8 option, uint256 weight, uint256 optionTally, uint256 castTotal, uint8 fromOption, uint256 fromTally)` | a voter's weight went to `option`; the tallies after, absolute: `optionTally` for the new option and, when this was a **move**, `fromOption` (255 when the vote was new) and `fromTally` for the option it left, so a reader needs no per-voter state |
| `HolderVote` | `Fell(uint32 indexed id, address indexed who, uint8 option, uint256 weight, uint256 optionTally, uint256 castTotal)` | a voter took Shares back during the vote and their weight fell to `weight` |
| `HolderVote` | `BallotFinished(uint32 indexed id, uint8 outcome, uint8 winner, uint8 winnerB, uint256 castTotal)` | the result; outcome 1 short, 2 kept, 3 moved, 4 seated, 5 unchanged |
| `HolderVote` | `BallotCarriedOut(uint32 indexed id, address council)` | the result was put in |
| `HolderVote` | `BallotLapsed(uint32 indexed id)` | a won result nobody carried out |

Views: `isVote()` (true; the Launcher checks it), `ballot(id)`, `optionOf(id, i)`, `ballotOf(who)` (the voter's own id, option, cast weight and
eligible weight now), `weightOf(who)`, `canOpenReplace()` and `nextReplaceAt()`, `canCarryOut(id)`, and every constant above.

### 2.13 Gas and size (estimates; K2 measures and states)

`openReplace` (the opening and the opener's list in one call) about 400,000; `standList` about 230,000 (a list is five accounts), a
displacing one about 250,000; `stand` about 130,000; `castVote` about 100,000 the first time, 40,000 to move; `finish` about 80,000 (at most
13 options); `carryOut` about 650,000 (a Council clone, the seats, the Treasury call). `unpark` with a ballot live: at most 60,000 above
a plain `unpark` (the first touch writes one slot, a cast weight cut writes two); `park` with a ballot live: at most 30,000 above.
**With no ballot live:** `HolderPause` itself is unchanged by the hooks (empty internal functions compile to nothing; K2 proves it by
comparing `HolderPause`'s runtime bytecode before and after, and states it); a `HolderVote` clone adds one storage read to `park` and
`unpark` (a cold read, at most 2,300 gas), gated in `GasVote.t.sol`, and `GasPause.t.sol`'s limits are re-run on a `HolderVote` clone with
that allowance. Gates in `GasVote.t.sol`. `HolderVote` runtime about 10 KB (the pause is 2.7 KB); gate: under 24,576 with 3,000 spare.
Nothing in the Treasury is added for counting.

---

## 3. The attack table

Cost model, so the table can be checked (arithmetic, plain Python; K2's `HolderVoteAttacks.t.sol` pins the exact numbers). Pot P0
is money backers put in and nobody has taken out (no surplus, so a Share costs what taking it out gives); the platform fee is a
setting (default 2% of what a person pays in, `feeBps = 200`; at most 5%), so at 2% for a net `m` the gross is `m / 0.98` and **the fee
is `0.0204 x m`** (at 5%: `0.0526 x m`). Money put in comes back at face on any day, less what a hostile runner has taken from the pot
in the meantime. **Holding a third of the backers' Shares after joining needs `m = P0 / 2`:** fee **102 / 10,204** (at 5%: 263 /
26,316), money tied up 5,102 / 510,204, pot after 15,000 / 1,500,000. "Sleepers" are holders who never look and never take out. What
a hostile runner can take from them is the design's own table (JOIN-LEAVE-DESIGN 2.3, simulated there, every limit binding): **12.4 of
every 100 after 30 days, 32.8 after 90, 54.9 after 180 at the default allowance; 15.0 / 38.6 / 62.3 at the ceiling.** On pots of 10,000
and 1,000,000 that is **1,240 / 124,000** after 30 days (1,500 / 150,000 at the ceiling), 3,280 / 328,000 after 90, 5,490 / 549,000
after 180. The first task money moves 16.5 days after a plan; the box moves the day the seat is taken. A whale with a third who takes
everything gets back from the pot what its own third loses, so its gain from the others is the sleepers' loss: **1,240 less the fee 102
= +1,138** (10,000) and **124,000 less 10,204 = +113,796** (1,000,000) after 30 days of the seat, **+3,178 / +317,796** after 90
(arithmetic). It happens only if every other holder sleeps for the 20.5 days of the vote and the wait and then for the 30 more. The
same figures hold if the whale takes its money out right after `voteEnd` (row 22): the sleepers' loss does not depend on where the whale's
own money sits.

| # | Attack | Cost to the attacker, pot 10,000 / 1,000,000 | The most that can be taken, 10,000 / 1,000,000 | What holders can do | Defence in the code | Test that holds it |
|---|---|---|---|---|---|---|
| 1 | **A whale with a third, everyone else asleep** (including the buyer who joins and parks one block before the vote opens: that buyer is this row, not row 3) parks before the vote opens, opens it with its own list, votes it | Fee **102 / 10,204**; money tied up 5,102 / 510,204 for at least 4 days (until the vote ends; it can leave any day after). Nothing else | From sleepers after the seat: **1,240 / 124,000** in 30 days, 3,280 / 328,000 in 90, 5,490 / 549,000 in 180 (nobody leaves). Whale's net after the fee in 30 days: +1,138 / +113,796 | **Take out.** Everyone who looks has at least 13.5 days (weekly looker) before the seat; the pot a leaver is paid on is the pot before the new runner can act; a leaver loses nothing. Park and vote "keep" before a vote opens (a parked majority wins) | Only parked Shares count and only from the snapshot; floor of a third; a list needs more than half of Shares cast; the wait is the longest task notice; the runner's own limits bind the new Council | `test_aWhaleWithAThirdWinsOnlyWithTheFloorAndAMajority`, `test_theSeatComesOnlyAfterTheWait`, `test_aLeaverIsPaidTheSameOnTheDayOfTheSeat`, `test_theCouncilMeetsEveryRunnerLimit` |
| 2 | **The same whale, but holders wake up and leave** | Same fee, and its own money is the only money left | **0** from others; the whale's tied-up money is all that is in the pot | Take out (the pot shrinks, the whale's third becomes the whole) | the wait; Take out never slowed by a ballot | `test_leaversDuringTheWaitLeaveTheWhaleAlone` |
| 3 | **A late large buyer** joins **after** the vote opens to swing it or to raise the floor | Fee on what they put in: 2.04%: 204 / 20,408 for a put-in as large as the whole pot | **0 / 0**: their Shares are not counted and the floor was fixed at the snapshot | Nothing needed | Snapshot at opening (2.2): a join after opening is not parked; the floor is read once | `test_aLateBuyerCannotSwingAVote`, `test_theFloorIsFixedAtTheSnapshot` |
| 4 | **A founder with many accounts**: backs through 20 accounts to win a replace vote for its own list, or to out-vote holders who want it gone | No cheaper than one account: Shares count, not accounts. Fee 2.04% of the money in: **102 / 10,204** for a third | **0 / 0 more than it can take today as the runner** (a founder already holds the seat; a Council of five of its own accounts adds nothing it did not have, row 5); to keep a seat against a real removal it needs the third and more than half of the Shares cast | Same as row 1 | `park` and the weight count Shares from `msg.sender` only | `test_manyAccountsCostTheSameAsOne`, `test_splittingSharesChangesNothing` |
| 5 | **A founder hands the seat to a Council of five accounts it owns** (a hand-over, no vote) | 0 (gas) / 0 | **Nothing more than it could take alone**: the same limits, the same notice; the Council is a different shape, not a different power | Take out; the page says "five accounts", and nothing says they are independent | A Council has no power a runner lacks (1.8); the app never calls a Council independent | `test_aCouncilOfOnePersonHasTheRunnersLimitsOnly` |
| 6 | **A team that parks its own vested Shares** to vote | Team Shares are another token: `park` only takes backer Shares, so **it cannot** (0 / 0 of weight). A team member's own backer Shares count like anyone's (fee 2.04% to buy them, 204 per 10,000 put in) | Same as row 1 if they reach a third | Same as row 1 | `HolderVote` counts the backer token's custody only; vested or unvested Team Shares are on no side of any count | `test_teamSharesCannotBeParkedOrCounted`, `test_aTeamDonationOfTeamSharesChangesNothing` |
| 7 | **A hostile Council once seated** (by a hand-over, a vote, or turned bad) | 0 / 0 | The runner's own limits and no more: 12.4 of every 100 from sleepers in 30 days (1,240 / 124,000), 32.8 in 90, 54.9 in 180 (15.0 / 38.6 / 62.3 at the ceiling). It cannot burn a grant, cannot raise the allowance in under a time unit. **It can take tasks through a sixth account, and the figures assume it does; the bar on the five seats is not a defence** | Take out; a replace vote (a counter-vote opens the day the first was carried out, ends 4 days later and takes effect 16.5 days after: **the seat is held at least 20.5 days**; after a real "kept" result the next vote waits 28 days); two seats rotate every 26 units, and a "keep" answer is always there; anyone winds down a quiet project after 26 units | The Treasury's caps and notices, the list of calls the Council may make | `test_aHostileCouncilCannotBreakAnyTreasuryLimit`, `test_theCouncilCannotForfeitOrTrim`, `test_aCounterVoteOpensAfterCarryOut` |
| 8 | **Vote spam**: open votes over and over to wear holders out or to jam elections | Gas, and 5% of the Shares parked first: net 526 / 52,632, fee **10.7 / 1,074** (27.7 / 2,770 at a 5% fee). **Paid once**: the parked 5% serves every later ballot | Nothing | Wait; the app shows only the one open vote; at most one "a vote is open" push per project per time unit | One ballot at a time; floor of 1 in 20 parked and 1 in 1,000 from the opener, who must put a list in; the cooldown after a real "kept"; seats open only on the clock | `test_oneBallotAtATime`, `test_replaceCooldown`, `test_openFloor`, `test_seatsOnlyOnTheClock`, `test_pushAtMostOncePerUnit` (S1) |
| 9 | **Ballot stuffing**: fill the four list places or twelve person places with junk so honest names cannot stand | Each place needs 0.1% parked at the snapshot: four list places net **40 / 4,016** (fee 0.8 / 82), twelve person places net **121 / 12,146** (fee 2.5 / 248) | Nothing: junk gets no votes **and an honest holder with a larger stake takes the smallest junk place** (2.3); an honest holder with a smaller stake than every junk stake votes "keep", which is always there | Vote "keep", stand with a bigger stake, or take out | Standing needs 1 in 1,000 parked; one per account; caps; stake-ranked displacement in the stand window; "keep" always present | `test_standingNeedsAStake`, `test_oneListPerAccount`, `test_capsHold`, `test_aLargerStakeDisplacesTheSmallest`, `test_anEqualStakeNeverDisplaces` |
| 10 | **Parking during the vote** to add weight | The fee on the money | **0**: not counted | | `_beforeChange` snapshots the balance at the first touch; `low` never rises | `test_parkingAfterOpeningAddsNothing`, `test_unparkThenParkAgainDoesNotRestoreWeight` |
| 11 | **Taking Shares back during the vote** and still being counted | None | **0**: the weight falls the same transaction; after the vote ends it no longer matters | | `_afterUnpark` lowers the cast weight and the tally; hooks stop at `voteEnd` (`now < voteEnd` in the hook and in `castVote`, both tested at the exact second) | `test_unparkLowersTheCountTheSameBlock`, `test_unparkAfterTheEndKeepsTheResult`, `test_theExactSecondOfTheEnd` |
| 12 | **A flash loan** to open, stand and vote in one transaction | Interest, and it cannot finish | **0** | | Voting starts after the stand window, a day later; the snapshot is at opening | `test_noOneTransactionVote` |
| 13 | **Old agreement counted after a seat changed**, a proposal replayed after it ran out, or **run twice** | | | | `generation` fence; `PROPOSAL_TTL`; one agreement per seat; the record is deleted before the call runs; the re-entry guard | `test_aReplacedSeatsAgreementIsDead`, `test_expiredProposalCannotRun`, `test_aSeatCannotAgreeTwice`, `test_aProposalRunsOnce`, `test_agreeCannotReenter` |
| 14 | **One account on two seats**, the zero address as a seat, or a project contract as a seat | | | | One seat per account at `initialize`, `seat`, `stand`; `isSeat(0)` false; `Launcher.isProjectAccount` refused at the Launcher and at standing | `test_oneSeatPerAccount`, `test_theZeroAddressIsNoSeat`, `test_aProjectAccountCannotBeASeat` |
| 15 | **A seat sold or lent** | Off-chain trust only | The buyer's trust, nothing more than a seat | The page says nothing about independence | The contract has no seat transfer; resign only | `test_noSeatTransfer` |
| 16 | **The old runner reacts during the wait** (draws its box, grants Team Shares, hands the seat to a puppet, proposes a rate, winds down) | | The same powers and limits it always had; **a puppet offer and a pending rate are cleared at the seat**; a wind-down by choice makes the vote lapse | | `seatByVote` does not ask who holds the seat and clears the offer, the agents and the rate; the Vester has no path from a vote | `test_theVoteSeatsWhoeverHoldsTheSeat`, `test_aPuppetOfferDiesAtTheSeat`, `test_aPendingRateDiesAtTheSeat`, `test_aVoteNeverTouchesAGrant` |
| 17 | **The helper fails or nobody carries out a result** | | | `carryOut` is open to anyone from any wallet until the lapse; after it the old runner stays | `lapse` after 2 units; `carryOut` retryable | `test_aWonResultNobodyCarriesOutLapses`, `test_aFailedCarryOutCanBeRetried` |
| 18 | **A hook that reverts** to stop Take out or to trap Shares | | | | The hook has no external call; `unpark` is fuzzed against every ballot shape | `test_unparkNeverRevertsForABallot` (invariant) |
| 19 | **A candidate's text swapped after votes, or a text that promises a profit** | | | | The chain stores the text's hash at standing; the page shows only a text whose hash matches; the stand sheet says plainly that no profit may be promised (6.2). Nothing hides a text after the fact: counsel's question C3 (section 10) | `test_candidateHashIsOnTheChain` (K2); the server's match test (5.4) |
| 20 | **A Council or a vote used to burn or trim a grant** | | | | The Council list excludes `announceForfeit` and `founderLeaves`; the Treasury asks `isPair` for both | `test_theCouncilCannotForfeitOrTrim` (at `propose`, and again at the Treasury) |
| 21 | **A seat-election takeover**: a holder of a third parks, stands alone and wins both seats, twice | The same as row 1: fee **102 / 10,204**, money tied 5,102 / 510,204 at each snapshot (it may leave after each vote); **control comes about 385 days after the Council was seated** (two elections 26 units apart, then 4 days and 16.5 days) | What row 7 says, from then on: 1,240 / 124,000 in 30 days of control | "keep" in either election (a person needs strictly more than "keep" and a third of the Shares must vote); take out; a replace vote at any time | One floor for both ballots; "keep" in every seat ballot; the wait; the in-app alert and the push for a seat election too (5.6) | `test_aSeatElectionNeedsTheFloorAndMoreThanKeep`, `test_aTieNeverReplacesASeat`, `test_twoElectionsAreNeededForThree` |
| 22 | **Winners unpark after `voteEnd`** and are seated by Shares no longer in custody | Less than row 1: tied up for the 4 days only | The same as row 1: sleepers' loss does not depend on where the whale's own money sits | Take out; the card still shows the planned change (the record does not depend on the winners staying parked) | Tallies freeze at `voteEnd` (V7); a re-check at `carryOut` was weighed and not adopted (V35) | `test_unparkAfterTheEndKeepsTheResult`; S1: `a_vote_still_signs_after_the_winners_unpark` |
| 23 | **A junk ballot holds the door** so holders cannot open a real one, or squats right after the cooldown | The row 8 stake, once | Nothing | Honest holders who parked before it opened stand and vote in it; a "short" or "moved" ballot leaves no cooldown, so the next one can open the day it ends | The cooldown follows only a "kept" with the floor met | `test_aShortBallotLeavesNoCooldown`, `test_aMovedBallotLeavesNoCooldown`, `test_aKeptBallotWithTurnoutStartsTheCooldown` |

**The residual risk of the replace vote, in one paragraph (for the owner).** The replace vote cannot be made safe for holders who do
not look. Anyone who can hold a third of the backers' Shares for 4 days (and be parked at the moment the vote opens) can, if enough
other holders neither vote "keep" nor take out, seat five accounts of their own after 20.5 days, and from then on can take from the holders
who are still there what any runner under the caps could: about 12 of every 100 in the first 30 days and about 55 of every 100 in 180 (the
design's table), which on a pot of 1,000,000 is 124,000 in the first 30 days against a fee of 10,204. The plan makes it slow, visible and
avoidable, not impossible: the money in is at face and can leave on any day; a person who looks weekly always has at least 13.5 days;
every result is shown like a planned task, from the frozen tallies and without waiting for anyone's press, and sent as an alert; the
buyer's money is tied up for 4 days at least; late buyers cannot swing it; a counter-vote can open the day the seat is taken, so a
hostile Council holds a seat at least 20.5 days; and nothing a Council can do goes past a runner's limits. What it does not do is
protect a holder who is away for three weeks, or stop a patient holder of a third who is willing to wait for a quiet month, or stop a
runner who sees the vote coming from winding the project down (an existing power, which makes the vote lapse). The seat-election
road to the same place costs the same and takes a year. A project whose holders mostly never look is as takeable by the vote as it
already is by a founder who turns bad. I could not find a wait that protects the sleeping holder without making the vote useless to
the awake ones, so the plan builds the wait X4 asks for (the longest task notice, read from the Treasury), the floor of a third, a list
needing more than half of Shares cast, "keep" in every ballot, and **says in the app that a vote only changes who runs the project and
that taking out stays open** (6.2's last line) instead of promising protection.

---

## 4. The switch, and the proof that with it off nothing differs

### 4.1 One switch, beside the pause

`COUNCIL` (default 0) in the deploy script, beside `HOLDER_PAUSE` (V4). It is not the same switch as the pause, for three reasons:
a deployment can keep the pause exactly as shipped (the most cautious step is still available); `HolderVote` **replaces** the pause's
code in every project, so the pause's own switch cannot mean both; and the sentence the founder reads before launching differs. With
`COUNCIL=1` the script requires `HOLDER_PAUSE=1` (it stops before sending anything otherwise), deploys `HolderVote` instead of
`HolderPause` and `Council`, and binds both to the Launcher in the same broadcast as the Launcher's own deployment, before any project can
launch. Once bound, a project is born with a `HolderVote` as its pause and keeps it; it can hand its seat to a Council or have its
holders replace the runner. Nothing can turn it on later (first hour, deployer only, once: the pause's own rule).

### 4.2 The Launcher's side

`bindCouncil(impl)`: deployer only, once, inside the first hour, `impl` has code, the holder pause is bound, and (K2) the bound pause
implementation answers `isVote()` (so a Council cannot be bound beside a plain pause by mistake); emits `CouncilBound(impl, codehash)`.
In `launch`, when a Council is bound, after the pause is bound: `HolderVote(gate).bindProject(treasury, key)` (once; it records the
Launcher, the Treasury and the key). `settingsHash()` keeps its three old forms when no Council is bound and gains a fourth when one is:
**the Council test comes first in the function** (before the claims branch, which returns at line 316 today), and returns
`keccak256(abi.encode(platform, pause, claims, council))` (a zero where the claims contract is off), so a founder who read the hash before the switch
is refused at launch and reads it again, and a Launcher with both claims and a Council bound gives the four-part hash (a test per form,
the claims-and-Council case included).

### 4.3 The deploy script and `DEPLOYMENTS.md`

`DeployPot.s.sol` reads `COUNCIL` (0 or 1, anything else stops the script before it sends anything); with 1 and `HOLDER_PAUSE=1` it
deploys `HolderVote` (as the pause implementation) and `Council`, calls `bindPause(holderVote)` and `bindCouncil(council)`; `Deployed`
gains `holderVote` and `council` (appended: existing tests compile) and the JSON file `deployments/pot-<chainid>.json` gains the same two
keys, `null` when off. `DEPLOYMENTS.md` gets a section "The Council switch": the order, that it is off by default, that `HolderVote` replaces
`HolderPause` in new projects when on, the expected code hash of `HolderVote` and `Council` (and of `HolderPause`, if K2's hook lines changed it) from the build (`forge inspect <C> deployedBytecode
| cast keccak`, compiler and settings as the pause's section gives them), the events to check, and that a project launched before the
switch has neither. `DeployPotSettings.t.sol` is extended (a new file `DeployCouncilSettings.t.sol`): `COUNCIL=2` stops; `COUNCIL=1`
without `HOLDER_PAUSE=1` stops; both on binds both; off binds neither and the Launcher's `councilImpl()` is zero. One run of the
script against a local chain.

### 4.4 The proof that with it off nothing differs

1. **By construction.** Every new instruction in a project is behind `councilImpl != 0`, a Council address, or a ballot being live.
   With the switch off the Launcher's `councilImpl` is zero, no project has a `HolderVote`, no Council is ever made, and `runnerKindOf`
   is 0 or 1 for every address. What does change, and is stated: the bytecode and ABI grow (additive: `runnerKindOf`, `isCouncil`,
   `councilImpl`, `bindCouncil`, `makeCouncil`, `councilAddress`, `councilByVote`, `isProjectAccount`, `seatByVote`, `isSeat`; `isPair`
   becomes a view over `runnerKindOf` with the same selector and answer); the Treasury's two seat checks ask the Launcher a different
   name for the same answer (`runnerKindOf(r) == 0` equals `!isPair(r)` while no Council exists) and ask a Pair one question where they
   asked two. **No gas difference is expected and K1 measures it** (one Launcher storage read, as now); the engineer states the numbers.
2. **By the golden journey (the old proof, unedited).** `OffIsOff.t.sol`'s journey runs on the new code and must give the same
   digest, `0x33368c2e...043a` over 154 logs, the value recorded at the earlier build. That journey includes a Pair, a forfeit, a
   hand-over trim, tasks, notes and a wind-down: it binds the Treasury, Pair and Launcher edits (`runnerKindOf`, `isSeat`,
   `windDown`, `_seat`). The constant is not edited; if it moves the edit is wrong.
3. **By a new differential** (`OffIsOffCouncil.t.sol`): the same fuzzed 120-step sequence runs on a stack with every switch off and on
   a stack with `COUNCIL=1` where **nobody opens a ballot and nobody makes a Council** (it parks and unparks); after every step every
   public view of the Treasury, Vester, TaskBook and both tokens is equal and every step succeeds or fails alike. As before, this
   proves the new contracts are inert unless used; the old tests and the golden digest are the witness for the old bytecode.
4. **By the old tests, with one helper file growing.** **No test function and no existing test file is edited; one helper file,
   `test/helpers/Mocks.sol`, gains two views that return what the Treasury was told before** (`MockSalePath.runnerKindOf` and
   `MockPair.isSeat`, 1.2). That is stated rather than hidden: without them 23 test files could not run, because the Treasury asks one
   more question of the Launcher stand-in. Every existing test file passes and **the whole pause suite is re-run with a `HolderVote`
   clone as the project's pause** (three thin new classes, one per pause test file, that inherit the existing test contract and
   override only the line that makes the pause; a new `VoteBase` helper where the old helper has no seam; no old file is edited).
   That is the proof that `HolderVote` is the pause and the two hooks are inert. Because the stand-in grew, **the golden digest and
   `OffIsOffCouncil` carry the proof for the real Launcher.**
5. **By literal checks:** with no `bindCouncil`, `councilImpl()` is zero, `makeCouncil` and `councilByVote` revert, the project's
   `pauseGate` is whatever the deployment bound, and `settingsHash()` equals each of its three old formulas (a test per formula).
   `HolderPause`'s runtime bytecode is compared before and after K2's three hook lines; if the hash differs, the pause's recorded
   hash in `DEPLOYMENTS.md` is updated and the report says so (4.3).
6. **By the size gates** (1.7, 2.13) and the generated tables (the ABI tables and the events table are regenerated by their scripts,
   not edited, and the old recorded file still passes).

---

## 5. The server

All of it is additive inside record version 2 ("adding a field never changes the version", RECORD-V2.md section 1). One new migration
for one role; one new family of an existing record kind; no new event kind and no new relay rule beyond that family.

### 5.1 Events the reader takes in

`scripts/chain-reader-events.mjs` regenerates `events_table.rs` from the contracts build (never hand-edited).

| Role | Contract | Found from | Events |
|---|---|---|---|
| `pause` (existing role; the contract is a `HolderVote` when the switch is on) | the project's pause | the Treasury's `PauseReady(gate)` | `Parked`, `Unparked`, `Observed` (as before) and the vote's `BallotOpened`, `Stood`, `Voted`, `Fell`, `BallotFinished`, `BallotCarriedOut`, `BallotLapsed` |
| `council` (new) | a project's Council | the Launcher's `CouncilMade` | `Proposed`, `Agreed`, `Withdrawn`, `Executed`, `Cancelled`, `SeatsSet`, `Resigned` |

Also decoded: `Launcher.CouncilBound`, `CouncilMade`; `Treasury.RunnerChanged` (already). The one migration (S1 takes the next free
number, 0077 at the time of writing) drops and re-adds `chain_contracts_role_check` with `council` added (as 0076 did for `pause`),
with `schema/tables/public/chain_contracts.sql` and a Postgres-lane migration test (a `council` row inserts; an unlisted role still
fails). A decoder reads a `HolderVote`'s pause events with the pause ABI and the vote events with the vote ABI at the same address (one
role, two event tables), and a log of an unknown topic at that address is ignored, never an error.

**The ledger holds totals, never voters.** `Voted` carries the new option's absolute tally and, for a move, the old option's
(`fromOption`, `fromTally`); `Fell` carries the option's absolute tally; both carry the cast total after. So the ledger **sets**
`tally[option]`, `tally[fromOption]` and `cast` from them and keeps **no per-voter state**, and a moved vote leaves no stale tally
(a test replays 400 random votes, moves and unparks and compares every tally with the contract's). A `Stood` that names a `displaced`
proposer replaces that option's entry. A parked Share still counts as the holder's holding (`holdings = balance + parked`, as in step
4): a vote moves no holding.

### 5.2 The additive record keys

Always present as keys; `null` when the project has none; a failed check of one key signs that key `null`, logs one error line naming
the project and the key, and signs the rest.

`runner.kind` (string `"single"`, `"pair"` or `"council"`): the kind of the runner, from the Launcher's `runnerKindOf` at
`asOf.block`. `runner.seats` (int or null): for a Council, the number of distinct non-zero live seats (used by the Established rule,
5.8). When `kind` is absent the app reads `runner.isPair` as before. `runner.isPair` and `runner.signers` are unchanged (true and set
only for a Pair).

`council` (null unless the runner is a Council):

| Field | Type | Meaning | From | Bound | When absent the app shows |
|---|---|---|---|---|---|
| `council.contract` | address | the Council | `CouncilMade` | | no Council section |
| `council.seats` | array of 5 of `{account: address or null, seatedAt: int or null}` | the five seats in order; null for an open seat | view `seatList()` | exactly 5 | "The Council could not be read right now" in the Team section, no press |
| `council.needed` | int | how many seats must agree | view `THRESHOLD()` | 1 to 5 | |
| `council.generation` | int | goes up when any seat changes | view `generation()` | | |
| `council.nextElection` | int | when two seats next come up | view `nextElection()` | | the line about the next vote is left out |
| `council.upSeats` | `[int, int]` | which two seats come up | view `upNext()` | each 0 to 4 | |
| `council.waiting.count` | int | proposals still open (not run, not taken back to nothing, not expired, this generation) | events at `asOf.time` | at most 200; `truncated` true above | nothing about waiting actions |
| `council.waiting.kinds` | array of `{kind: string, count: int}` | the same, by kind: `draw`, `checkIn`, `rate`, `door`, `plan`, `accept`, `reject`, `cancel`, `grant`, `helper`, `handOver`, `windDown`, `other` | the selector of each proposal's call | at most 13 | |

Accounts are shown as the network already shows them (an address, and the name the account has linked, which the app resolves as it
does for a Pair's signers). **Never the waiting calls' bytes or amounts** (the app reads those from the Council's own `Proposed` logs for a
seat holder, as it does for a Pair, `pair.ts`).

`vote` (null when the project has no `HolderVote` bound to a Launcher with a Council; otherwise an object):

| Field | Type | Meaning | From | Bound | When absent the app shows |
|---|---|---|---|---|---|
| `vote.contract` | address | the vote contract (the pause's address) | `PauseReady` | | |
| `vote.rule` | object | **every number a sentence needs**: `standSecs`, `voteSecs`, `waitSecs`, `floorDivisor`, `openDivisor`, `standDivisor`, `cooldownSecs`, `seatsEverySecs`, `proposalTtlSecs`, `needed`, `seats`, `maxLists`, `maxPeople`, `minVote` | the contract's constants and views at `asOf.block` | `waitSecs` equals the Treasury's `noticeFor(500)` read at the same block; `standSecs` and `voteSecs` are the pause's day times 1 and 3 | no sentence that needs a number is shown |
| `vote.open` | object or null | the newest ballot that is not yet carried out, lapsed or finished without effect more than 3 days ago | views at `asOf.block` | | nothing about a vote |
| `vote.open.id` | int | | `BallotOpened` | | |
| `vote.open.kind` | `"seats"` or `"replace"` | | event | | |
| `vote.open.phase` | `"standing"`, `"voting"`, `"counting"`, `"waiting"`, `"carried-out"`, `"ended"`, `"lapsed"` | from the four times and the flags at `asOf.time`; `ended` = short, kept or unchanged; `waiting` starts at `voteEnd` whether or not anyone has recorded the result | arithmetic | | |
| `vote.open.openedAt`, `standEnd`, `voteEnd`, `effectiveAt` | int | the four times | event | `openedAt < standEnd < voteEnd < effectiveAt` (checked) | |
| `vote.open.supply` | amount (18 dec) | the backers' Shares at the snapshot | event | | |
| `vote.open.floor` | amount | the Shares that must be cast | event, checked against `supply / floorDivisor` rounded up | at most `supply` | |
| `vote.open.cast` | amount | the Shares cast so far | event `Voted`/`Fell` | **while `asOf.time < voteEnd`: at most `pause.parkedTotal`; from `voteEnd` on: at most `supply` only** (the tallies freeze, and winners may take their Shares out at once) | |
| `vote.open.options` | array | `{index: int, kind: "keep" or "list" or "person", members: [address] (up to 5), proposer: address or null, recordHash: bytes32 or null, tally: amount}` | `Stood`, `Voted`, `Fell` | at most 13; the tallies add up to `cast` (always, before and after `voteEnd`) | the card shows no rows |
| `vote.open.result` | object or null | `{outcome: "short"\|"kept"\|"moved"\|"seated"\|"unchanged", winners: [int] (up to 2), recorded: bool}` **derived by the reader from the frozen tallies and the floor from `voteEnd` on** (2.6); `recorded` is true once `BallotFinished` is seen, and when it is seen it must equal the derived result (else `vote` is null and one error is logged) | tallies, floor | | |
| `vote.open.carriedOutAt` | int or null | | `BallotCarriedOut` | | |
| `vote.next.seatsAt` | int or null | when two seats may be opened | `Council.nextElection` | | |
| `vote.next.replaceFrom` | int or null | when a replace vote may next open (the cooldown's end; the present time when there is none) | view `nextReplaceAt()` | | |
| `vote.next.openFloor` | amount | the parked Shares needed to open a replace vote now (1 in 20 of the supply) | view | | the opener's line is not shown |

A text of a candidate or a list (`recordHash`) is joined in the app from the signed records (5.4); the server's record carries only the
hash. **No address of a voter, no per-voter amount, never a row per voter.** Checks before signing: the tallies add up to `cast`; the
times are in order; `cast <= pause.parkedTotal` **only while `asOf.time < voteEnd`**, and `cast <= supply` always; `effectiveAt - voteEnd` equals the Treasury's longest notice read at the same block
(`noticeFor(500)`); `floor` equals the rule; the derived result equals a recorded one; any failure signs `vote: null` and logs. A vote
therefore **stays in the record through the whole wait even if every winner has taken their Shares out** (a named test: the whale unparks
the second after `voteEnd`, the record still shows the planned change, and switching the `cast <= parkedTotal` limit to always makes it
fail). `RECORD-V2.md` gets a section 14 with these tables.

**Fixtures.** The existing fixtures and examples stay as they are and are regenerated byte-identical in everything else when the events
table changes (a test regenerates the default and compares); the same script gets a third small run with its own Launcher (`HOLDER_PAUSE=1`,
`COUNCIL=1`): `testdata/pot-run-council.json` and `record-v2-example-council.json` (a Council runner, a ballot open, one carried out, one
**moved** vote, one **moved** after a voter's move, and one where the winner unparked after the end). The
reader's `the_table_is_the_forge_build` and `chain-reader-example-check.py` pass for all examples. **A test compares the record's
`vote.rule` with the built contract's constants** (so the app's numbers are the contract's).

### 5.3 The reader and the numbers

`record_council.rs` (new, beside `record_step4.rs`) builds the blocks; `numbers.rs` and `views.rs` read the views at `asOf.block`
with the same batching and "fail to null" rules as `pause`. `refreshEverySecs` drops to **the smaller of 600 and a quarter of
`standSecs`** while a ballot is live or a result is waiting (so a vote opening shows within ten minutes on a real network, and within
a minute on a test network with a 1,680 s unit).

### 5.4 The candidate's short text: a tag on an existing kind

**No new kind.** A short text is a kind 47003 record (`KIND_LAUNCH_UPDATE`) of a new family `candidacy`, as `room-mute` and
`season-entry` are families of the same kind (`launch_update_authority.rs`). Tags: `["a", "37001:<founder>:<id>"]`, `["candidacy",
"<ballot id>"]`, `["t", "vote:<chain key>:<ballot id>"]` (so a reader finds a vote's texts with one filter on a single-letter tag, as
the room does with `room:`), one `["proposer", "<address>"]`, one or five `["candidate", "<address>"]` (the list's seat order), one
`["expiration", "<unix seconds>"]` (at most 30 days out). Content `{"v":1,"text":"<at most 280 characters>"}`, at most 1,024 bytes.
**Who may sign:** any signed-in account (a stranger may stand) that has a live linked wallet equal to `proposer` (the wallet-binding
records, as the room's write rule uses them), that the server does not have on record as an agent (an agent may not sign a
candidacy: the same limit as goals and promises), at most 3 a day per account and 10 per ballot. The relay does **not** read the chain
at write (as for tasks); the check that a text belongs to a real candidate happens when it is read: **the app and the server show a
text only when its record id equals the `recordHash` the chain stored at `Stood` for that option, the signer's linked wallet equals the
chain's proposer and the `candidate` tags equal the chain's members.** A text with no matching option is never shown anywhere. Order for
a person: sign the record, then `stand(recordId)` (as the weekly record comes before the check-in); the same order for `standList` and `openReplace`. The app keeps the signed record's id so a failed second step is retried without signing again.

### 5.5 The helper: permissionless calls anyone may make

`helper/calls.rs`, `plan.rs`, `mod.rs`: four jobs, each a call with no value and no dollars moved, inside the helper's existing bounds
(at most 3 per pass over all projects, once per project per 10 minutes **or a quarter of `standSecs` when that is smaller**, at most 6 a
day per project, backoff, a terminal state: five failures in a row leave that project alone for 24 hours and log it, the global daily
gas and spend caps, `JOBS_PER_PASS`): `vote.openSeats` (when `nextElection` has passed, no ballot is live and the Council exists),
`vote.finish` (when `voteEnd` has passed and the result is not recorded), `vote.carryOut` (when `effectiveAt` has passed on a won
ballot, not lapsed), `vote.lapse` (when a won ballot is 2 time units past `effectiveAt`). **The helper never opens a replace vote** (that
is a holder's act). `carryOut` makes a Council (a clone): the planner reads the contract's `canCarryOut` view first and its gas is inside
the daily cap. The helper still never leaves, refunds or claims for a person; its list of calls is closed and a test pins it. **The
helper is the only normal path** for these four calls; each is open to anyone, so a person can make it from any wallet (the app has no
press for it, V33). With the helper off, a seat election simply waits and a won result lapses to the old runner. Tests: the planner for
each job (due, not due, bounds, terminal state, no job without a vote contract, the shorter pace on a short unit), the closed list.

### 5.6 Sponsor, relay rules, alerts

- **Sponsor.** The Councils the reader follows and the vote contract are followed contracts, so a passkey account's presses
  (`stand`, `standList`, `openReplace`, `castVote`, `propose`, `agree`, `withdraw`, `makeCouncil`) are ordinary sponsored operations; none is an
  exit; the exit rule (`[unpark, leave]`) is unchanged and tested still to hold with a ballot live.
- **Relay.** `handlers/launch_update_authority.rs` gains the family `candidacy` (5.4) with its tests; `handlers/agent_label.rs` gains
  the limit that an agent signs no candidacy; `room_write.rs` needs nothing (a parked Share already counts as a holding).
- **Alerts (the way a planned task does).** `web_push/alerts.rs` classifies `BallotOpened` (**either kind**: a seat election changes who runs
  the project too, and comes twice a year, so it is not noise) as a new push kind `vote`, and a result that is **moved or seated** as a new kind `moved`. **The
  `moved` alert is made from the reader's derived result (2.6, 5.2), not from `BallotFinished`**, by the first pass after `voteEnd`
  that sees it, once per (project, ballot, kind), whether or not anyone has pressed `finish` (a named test: no `BallotFinished` row
  exists, the alert is made). The alert's own 24-hour life counts from `voteEnd`. S1 reads how a task row becomes a `Candidate` and
  how its outbox row is keyed, then makes this fit; if the existing path can only carry a row read from `chain_logs`, S1 adds a small
  step to the reader's refresh pass that makes the candidate with `serial` = the ballot id, and says so in the report. They go only
  to accounts that hold the project (balance plus parked) and have turned alerts on, with fixed words (no names, no amounts, no dates;
  `web_push/mod.rs` and `app/public/sw.js` hold the same words and a test holds them equal); **at most one `vote` push per project per
  time unit** (a stream of junk ballots cannot become a stream of pushes). In the record the same facts are the `vote.open` block, from
  which the app builds the in-app alerts (6.7).

### 5.7 Tests and guards (S1)

Reader: every event of both roles replays to the record (a fixture run); the tallies add up, **including after moved votes**; a `Fell`
lowers a tally; a result is never `moved` without a majority of the cast; a vote **still signs after the winners unpark, in phase
`waiting`**; the planted-voter test (a voter's address and amount, placed as a `Voted` row in `chain_logs`, appear in no record, no
explore row, no feed row, no alert and no route); hostile and stale values null the key. Relay: the `candidacy` rules (shape, wallet
binding, agent, rate, expiration). Each new guard is switched off once and the named test must fail: the tally-add-up check, the
`cast <= parkedTotal`-before-the-end limit (made unconditional: the unpark-after-end test fails), the `effectiveAt` check, the derived
result against the recorded one, the planted-voter filter, the candidacy wallet binding, the agent limit, the helper's closed list,
the push classification, the one-push-per-unit limit.

### 5.8 The Established badge counts a Council

`record_social.rs`'s `two_signers` (line 599) is true only for a Pair. A project that grows into a Council must not lose, or never
reach, "Established" (V23): `two_signers` also holds for a Council with at least 3 distinct non-zero live seats (`runner.kind ==
"council"` and `runner.seats >= 3`), read from the runner record, so `established_of` and `check_established` keep their signatures. The key
keeps its name `established.twoSigners` (RECORD-V2.md says what it now means: "the project is run by more than one account"). Tests in
`record_social_tests.rs`: a Pair that hands the seat to a Council keeps the badge; a Council with 2 live seats does not have it; one
with 5 does; the guard switched off (a Council never counts) fails the first.

---

## 6. The app

Phone first, light, plain. **Nothing new shows on a project with no Council and no open vote.** The words are "vote", "list", "seat",
"Council", "park", "take out", "the project's money"; **"Back" stays the word for putting money in** (so the button is "Vote", never "Back
this list"); no protocol word, event name, kind number or error name in main copy; sizes are rem tokens (`pnpm check:px-text`); the
name comes from the brand constant; legal text is never hidden or reworded. Two sentences are reused through their existing
constants, never retyped: "You can take your money out any time. Nothing here promises a profit." (`TAKE_OUT_BANNER`, shown by the
shell's banner on pages, and carried by any sheet that speaks of taking money out, with the existing one-owner rule so a screen reader
meets it once) and "Posts and votes are public." (`PUBLIC_LINE` in `room-words.ts`, **shown word for word where a person votes,
stands or agrees to an action**). The line "This can go up or down. It is not a return." stays under any live money number as now (these
screens show Shares and percentages, not money, so it is not added). **No sentence says or implies that a vote protects money; they say
taking out stays open.** The words never used: protect, safe, secure, guarantee, independent, decentralised. **A Council is always "five
accounts", never "five people"** (an account can be anyone, or one person with several, and a list names accounts nobody asked); the
fields are "Seat 1" to "Seat 5". **Every number in a sentence (days, percents, how many must agree, the wait) is built from the
record's `vote.rule` and `council.needed`; none is typed in a word file** (a test builds each sentence from a record and from a
changed record and compares).

### 6.1 Who sees what

| Person | Sees |
|---|---|
| **A visitor** (not signed in, or holds nothing) | A project with no vote and no Council: nothing new. With an open vote: the vote card, read only: what is decided, when it ends, the count so far, the lists and their texts, with "Only people who back this project can vote." and no press |
| **A holder with Shares in the wallet** (not parked before the vote opened) | The card, and "You can't vote in this one. Only Shares parked before it opened count. You can take your money out any time." (the second sentence is the shell banner's). No vote press; Take out as always |
| **A holder who parked before it opened** (eligible) | The card with a "Vote for this" press on each row; if they have enough, "Put forward a list" (replace) or "Stand for a seat" (seats) during the first day |
| **A candidate** | Their own row marked "You are standing." (a name cannot be taken off once put forward: the contract has no such call, and the stand sheet says so before the press) |
| **A seat holder** | The Team section's "Waiting for your agreement" list; the vote card as a holder |
| **The present runner** (a founder alone, a Pair signer, or a Council seat) | A line in the Team tab while a result is waiting: "Holders voted to change who runs this project on {date}. Until then you still run it."; "Hand over to a Council" in the seat section |
| **Anyone who backs after a result that moved** | The same planned-change sentence on the Back sheet (they have no vote in it, and must see it before they put money in) |

### 6.2 The vote card (project page, `VoteCard.tsx`, shown only when `vote.open` exists)

One card, between the allowance section and Your Shares. Title by kind, then a state line, then rows, then the press. Seats are
shown as the account's linked name when it has one **and always its short address beside it**.

**Replace vote**

- Title: "A vote on who runs this project".
- "Holders are choosing between keeping things as they are and a new Council of five accounts."
- Standing (first day): "Anyone with parked Shares can put forward a list of five accounts until {time}. Voting starts then." and, for
  an eligible holder, the press **Put forward a list**.
- Voting: "Voting ends {time}." and one row per option: "Keep things as they are" and "List {n}: {account, account, account, account,
  account}", each with its percent of Shares cast ("{x}%", plain text), the short text under it (plain text, 280 characters, shown whole),
  "Put forward by {proposer}. Nobody on a list has to agree to it." on a list, and the press **Vote for this** (the accessible name is
  "Vote to keep things as they are" or "Vote for list {n}: {first account}"). A voter's current choice is marked "Your vote"; the press on
  another row is the same **Vote for this** and moves the vote.
- The count, one line: "{a}% of Shares have voted. The vote counts when at least {b}% do, and a list wins with more than half of
  those." (percents of all Shares at the moment the vote opened, rounded down, from `vote.rule`; a value under the floor never reads as
  the floor).
- Under the card, for anyone who can vote or stand: **"Posts and votes are public."**
- After the vote, before it takes effect (the **planned change**, shown with the same weight as a planned task, **from the moment the vote ends and whether or not anyone has recorded it**):
  "Holders voted to change who runs this project. On {date and time} {account, account, account, account, account} take over from
  {the founder / the two-person team / the Council}. You can take your money out before then. Taking out stays open." If the result was
  kept or short: "The vote ended. Nothing changes." for 3 days, then the card is gone.
- Last line, always on a replace card (V28): "A vote only changes who runs this project. Taking out stays open: if you will be away, you can
  take your money out first."

**Seat election**

- Title: "Two seats on the Council are up".
- "Two of the five seats are being voted on. Anyone with parked Shares can stand until {time}." with the press **Stand for a seat**; rows
  "Keep the two seats as they are" and "{account}" with percent, text and **Vote for this**; the count line; "Seats stay as they are if too
  few Shares vote, or if nobody gets more votes than keeping them." and the same public line.
- After: "The vote ended. {account} and {account} take their seats on {date}. You can take your money out before then." or "The vote ended.
  The seats stay as they are."

**Stand sheet** (`StandSheet.tsx`, lazy; one sheet for standing a person, standing a list, and opening a replace vote): a labelled text
box "Say in a few words who you are and what you would do" (up to 280 characters, a live count that is read out politely; the press is
disabled when empty) with one plain line under it, **"Do not promise anyone a profit or a return."**; for a list five labelled fields
"Seat 1" to "Seat 5" (an account's name from the accounts already shown on the project, or a pasted address; each field says what it
understood and shows its short address; keyboard: Tab moves, Enter adds, a paste of five addresses fills them); then "You cannot take
your name off once you stand.", **"Posts and votes are public."** and the banner, and the press **Stand** / **Put forward this list** / **Open the vote**.
In the opening mode one more sentence, built from `vote.rule`: "This opens a vote. For the first day anyone with parked Shares can put
forward a list. Then holders vote for three days. Nothing changes for {wait} after that, so anyone can take their money out first. Parked
Shares also count toward pausing the project's spending." Two steps behind one press: the app signs the text, then sends the call (a
passkey account is asked once, a wallet twice); **the signed record's id is kept in the sheet's state, so a failed second step is retried
without signing again**. A failure says what happened and what to do, from a copy module.

**When a press is refused, in plain words** (one copy module, `council-words.ts`, mapped from the network's own refusal, never
the refusal's name; each says what happened and what to do):

| Refused because | The sentence |
|---|---|
| a vote cast by someone whose Shares were not parked before it opened | "You can't vote in this one. Only Shares parked before it opened count. You can take your money out any time." |
| the vote ended while the press was open | "This vote has ended. Nothing was sent. The result is on the project page." |
| voting before the names are final | "Voting starts at {time}, when the names are final." |
| standing with too little parked | "To stand you need at least {n} Shares parked from before the vote opened." |
| standing twice, or a list with the same account twice | "You already put a name forward in this vote." / "A list needs five different accounts." |
| a list that names an account of the project itself | "These accounts belong to the project and cannot hold a seat." |
| a seat held by one of the five already | "{account} already holds a seat." |
| a place that a larger stake took | "Your name was replaced by one with more Shares parked. You can still vote." |
| opening a vote too soon | "A vote can't open yet: holders said no to the last one less than {n} days ago." / "Not enough Shares are parked yet." / "A vote is already open." |
| an agreement that ran out or a seat that changed | "This ran out or the seats changed. Propose it again if it is still needed." |
| a signed-in account the server marks as a helper | "This account is marked as a helper. A person has to stand." |
| an offer to a Council that ran out | "The offer ran out. Offer the seat again." |

### 6.3 Where a replace vote is opened (nothing new until it can be)

In the existing pause card (which shows only when something is parked, the line is reached or the person holds Shares) one extra
line and one press appear **only when `vote.next.openFloor` is met by `pause.parkedTotal`, no ballot is open, the cooldown is over, and the
person has parked Shares**: "Enough Shares are parked to ask holders who should run this project." and **Ask holders**, which opens the
stand sheet in its opening mode (6.2), so there is no second sheet. Nothing shows to anyone else, and nothing shows on a project without a
vote contract.

### 6.4 The Council section (Team tab, `CouncilSection.tsx`, shown only when `runner.kind` is `council`)

One short section above the existing team presses.

- "The Council" and "Five accounts run this project together. {needed} of them must agree to every action." (`council.needed`)
- The five seats: the account's name (or the start of the address) and its short address, "You" on your own, "Open seat" for a vacant one, and the date each took the seat.
- "Two seats come up for a vote on {date}." (from `council.nextElection`; "now" while a vote is open).
- For a seat holder, **Waiting for your agreement**: one row per waiting action in plain words (the same sentences the Pair's confirm
  sheet uses, `describeProposal`, extended for the Council's list), "{k} of {needed} have agreed", **Agree** with **"Posts and votes are
  public."** under the list, and if you agreed, a small **Take back my agreement** link; an action that ran out says "This ran out; propose
  it again if it is still needed."
- The existing presses (Draw, Plan a task, Accept and pay, Grant Team Shares, Check in, the rate, the door, helpers, Hand over, Wind
  down) work as they do for a Pair: a seat holder's press becomes a proposal ("This asks the other seats to agree. It runs when {needed}
  of five have agreed."), the other seats see it above. A person who is not a seat holder sees the seats and nothing to press.
- **No "Give up my seat" in the app this round** (the contract has `resign`; V40).
- One last line: "A Council is five accounts. It can do what a founder could do, with the same limits, and nothing more. Taking out stays open." (counsel reads this line, section 10, C5)

### 6.5 Hand over to a Council (seat section, `HandOverCouncilSheet.tsx`, lazy; for the present runner only)

A third choice in the existing "Hand over" sheet, beside "Hand over to one person": **Hand over to a Council**. Five account fields
("Seat 1" to "Seat 5", as in 6.2; the runner may be one), then: "Once they take the seat, any {needed} of the five must agree to what you could do alone. Your Team Shares are
not changed. This takes two steps: you offer the seat, then anyone can make the Council." The presses: **Offer the seat** (a Pair
runner's press becomes a proposal, as today), then, once offered, **Make the Council** (one press by anyone; the app shows it to all five
and to the runner for the offer's life). A failure says that the offer ran out and offers it again.

### 6.6 What each screen shows when a record is absent, old or hostile

| What it meets | What it does |
|---|---|
| No `vote`, no `council`, no `runner.kind` (an older record) | Nothing new anywhere; Pair behaviour as before |
| `runner.kind` is `council` and `council` is null or malformed | The Team section says "The Council could not be read right now."; no press |
| `vote` null while the project has a vote contract | Nothing about a vote; Take out and Park work as before |
| A hostile `vote` (tallies that do not add up, times out of order, a floor that is not the rule) | The key is null and the rest stands |
| A record older than its own promise | The card says "These numbers are older than the server promises, so nothing is said here about where the vote stands now." |
| A text whose id does not match the chain's | Not shown; the row reads "No text" |

### 6.7 Alerts

`alerts.ts` gains two kinds made from the record, as the task alerts are (no event, no server write): **vote** ("A vote on who runs
{project} is open. It ends {date}. You can take your money out any time.", urgent until it ends; either kind) and **moved** ("Holders voted to change who
runs {project}. On {date} a new Council takes over. You can take your money out before then.", urgent until `effectiveAt`; the id changes
when the state does, so it is unseen again; it comes from `vote.open.result`, so it appears at `voteEnd` even if nobody recorded the result).
The push words (`push-words.ts` and `public/sw.js`, held equal by an existing test) gain: "A vote
on who runs a project you back is open. You can take your money out any time." and "Holders voted to change who runs a project you back.
You can take your money out first."

### 6.8 Files, sizes, resets, accessibility, presses

- **First the room.** The entry chunk has **281 bytes** to spare (449,719 of 450,000). Before anything else A1 moves the step-4 parse
  and its helpers (`numbers-step4.ts`) behind the same lazy boundary as the pause card, so the parse of `vote`, `council` and
  `runner.kind` (a new `numbers-step9.ts`) is lazy too. The entry chunk must end no larger than it began; the report states both numbers.
- New: `app/src/features/council/` (`VoteCard.tsx`, `StandSheet.tsx`, `CouncilSection.tsx`, `WaitingActions.tsx`, `HandOverCouncilSheet.tsx`,
  `council-words.ts`, `vote-words.ts`, `use-vote.ts`, `use-council.ts`, `proposals.ts`, tests), `money/numbers-step9.ts`,
  `app/tests/e2e/pot-council.spec.ts`. Edited: `project/ProjectPage.tsx`, `pause/PauseCard.tsx` (the opener's line), the Back sheet (the
  planned-change sentence), `project/project-top-words.ts` and its tests (the badge line for a Council: "Several accounts run it."; the
  words for a Pair and a single founder are unchanged), `team/TeamTop.tsx` or the Team tab's section list, `seat/SeatSection.tsx` and
  `seat/OfferSheet.tsx` (the third choice), `team/team-calls.ts` and `team/pair.ts` (the runner kinds: single, pair, council; the same
  `Proposed` decoder), `alerts/alerts.ts`, `alerts/alert-words.ts`, `alerts/push/push-words.ts`, `public/sw.js`, `money/send-targets.ts`
  (the Council and vote addresses), `money/pot-copy.ts` (the vote and Council refusals in plain words), `app/.env.example` only if a
  setting is needed (none planned).
- `packages/creaton-core/src/pot/`: regenerate the ABIs (`scripts/pot-app-abi.mjs`, which lists `HolderVote` and `Council` now), then calls
  (`openReplaceCall`, `openSeatsCall`, `standCall`, `standListCall`, `castVoteCall`, `finishCall`, `carryOutCall`, `lapseCall`,
  `councilProposeCall`, `councilAgreeCall`, `councilWithdrawCall`, `resignCall`, `makeCouncilCall`, `councilAddressOf`), reads (`ballotOf`,
  `weightOf`, `councilSeats`, the proposals from logs), tests comparing the encodings with the contracts' own build.
- **Community reset.** No new module-level cache is planned; if one is added, its reset goes into `resetCommunityState()` in the same change.
- **Accessibility (rule 7).** One owner per actionable label (each Vote press has one distinct name: "Vote to keep things as they are",
  "Vote for list 2: {first account}"; one Agree per row, named "Agree: {what}"); no duplicate stops (the banner once per screen, counted by axe);
  every field labelled; the percent has a text value; sheets move focus in and out; the percent is rounded down and never reads as the floor
  while under it.
- **Every input path (rule 8).** Keyboard (Enter and Space on each press, Tab order, Escape closes a sheet), touch (44 px targets at 360 x 640),
  pointer, paste into the five-account fields, a screen reader's list of options. Each differs only where listed and each is tested where it
  does: the five-account fields' paste and keyboard add; the stand sheet's text count; the radio-like row presses.
- **Press budgets, each held by a test.** Vote: 1 press (a passkey account is asked once; a wallet once). Stand: 2 presses and one text
  (sign, then send, behind one press). Agree: 1. Take back: 1. Ask holders: 2 (the line, then Open the vote in the sheet). Hand over to a
  Council: offer 1, make 1.
- **What the round adds, counted so a later round sees drift** (A1 puts the final numbers in `COUNCIL-REPORT.md`): cards or sections 3
  (the vote card, the Council section, the pause card's line), sheets 2 (the stand sheet in three modes, the hand-over sheet), presses
  about 10, alert kinds 2 in the app and 2 for push; nothing at all on a project with no Council and no vote.

### 6.9 The joined-up loop

`scripts/pot-chain-loop.sh` gains a stage with `HOLDER_PAUSE=1 COUNCIL=1` (a Council by hand-over, a three-of-five draw, a seat
election with the short unit, a replace vote end to end with the wait, a carry out); `scripts/phone-loop.sh` the same presses from a
passkey account (one operation each); `scripts/pot-full-loop.sh` gains two worlds, **council** (hand-over, agreements, the Team section, a seat
election) and **replace** (park, open, stand a list, vote, the planned-change card and alert, a Take out during the wait,
carry out, the new Council in the Team tab); each world reads the signed record against the chain field by field. Playwright
`pot-council.spec.ts` at 390x844 with axe for the card in each phase, the stand sheet, the Council section and the hand-over sheet,
at 360 x 640 as well. Docs: `TRY-IT.md` part 4.10 and `DEPLOY-TEST-NETWORK.md` say how to turn `COUNCIL=1` on and that it is **off by
default**.

---

## 7. Packages, one after another, one owner per path

Order: **K1, then K2** (both edit `Launcher.sol`, `Interfaces.sol`, `DeployPot.s.sol`, `DEPLOYMENTS.md` and the mutation script), **then
S1** (needs the final ABI, events and fixture), **then A1**. K1 and K2 are the contracts engineers (and, after a review, the contracts
fixer takes the same paths); S1 is the server engineer (and the server fixer); A1 is the app engineers (and the app fixer). No package
touches `crates/buzz-cli`: the brain skill is a separate item. Each package commits small, finished commits with the trailer; each
runs the machine's wait script before any forge or cargo command and `nice -n 10 timeout 1500`, cargo with `CARGO_BUILD_JOBS=2
CARGO_INCREMENTAL=0` and `-p <crate>` with a test filter; each stops and says so if free disk falls under 1.5 GB; a Playwright result
folder or an anvil, relay or preview server it started is stopped and deleted before it finishes. **The suites are large (about 25 new
test files, about 60 mutation entries): run `forge test` in chunks by `--match-path`, the mutation script with `--only` per group, and
say in the report which chunk each count came from; a timeout is not a failure and is rerun smaller.**

### K1: the Council and the Treasury's recognition of it (contracts engineer)

Owns `contracts/pot/**`: `src/Council.sol` (new), `src/Pair.sol` (`isSeat`), `src/Treasury.sol` (1.2 (a) to (d)), `src/Interfaces.sol`,
`src/Launcher.sol` (the Council part, `runnerKindOf`, `isProjectAccount`), `script/DeployPot.s.sol` (`COUNCIL` with a Council only: the
vote part waits for K2), `DEPLOYMENTS.md`, `scripts/check-mutations.py`, **`test/helpers/Mocks.sol` (additive: the two stubs of 1.2, nothing
else)**, and **new test files**: `Council.t.sol`, `CouncilAccess.t.sol`, `CouncilSeats.t.sol`, `LauncherCouncil.t.sol`,
`CouncilInvariants.t.sol`, `CouncilEventsRebuild.t.sol`, `GasCouncil.t.sol`, `SizeCouncil.t.sol`, `OffIsOffCouncil.t.sol`,
`DeployCouncilSettings.t.sol`, a helper `helpers/CouncilBase.sol` (extends the existing `StackBase`; a test Council-like contract for the
Treasury-side refusals; no other existing test or helper is edited), and a mock gate for `seatByVote` (the Treasury's `pauseGate` is a
test contract that calls it).
Order of work: **first run `check-mutations.py --check`** (every existing mutation's text must still occur exactly once in the files
this package edits; adjust, never drop) and record the old absolute gas of `join`, `draw`, `announceTask` (by a founder and by a Pair);
then `Pair.isSeat`, the Launcher's `runnerKindOf`, the Treasury edits and their size check **before anything else is written**; if the
gates of 1.7 are missed, take the **planned fallback of 1.7** (it is a branch, not a failure); then `Council`, the Launcher, the tests,
the script, the mutations.
Checks: `forge fmt --check src script test`; `forge build --sizes` (Treasury delta and spare, Parts spare, Council and Launcher
stated); `forge test` whole, in chunks (every old test green and unedited; the new ones counted); invariants at 1,000 runs; the new fuzz at
20,000 runs once; one run of the deploy script on a local chain; the mutation script with at least these new entries, **each run once and
each killed** (none is accepted as surviving), the result in the report: `council-threshold-two`, `council-no-generation`,
`council-no-expiry`, `council-withdraw-ignored`, `council-any-selector`, `council-handover-trim-allowed` and `council-forfeit-allowed`
(**both killed at `propose`**, by the tests of 1.9 that propose `handOver(.., true)` and `announceForfeit` through the Council),
`treasury-forfeit-accepts-council` and `treasury-founderagrees-accepts-council` (the Treasury's own `isPair` checks turned into
`runnerKindOf != 0`; killed by the Council-like contract test), `council-no-delete-on-run` (the record kept after the third agreement:
seats 4 and 5 run the call again), `council-no-reentry-guard`, `council-double-seat`, `council-seat-anyone` (`seat` or `openElection`
callable by anyone), `council-isseat-zero` (`isSeat(0)` true), `treasury-teamseat-pair-only` (`_isTeamSeat` reverts to `isPair` and two
signers), `treasury-runnerkind-true` (the `bothSigned` check dropped for a Council), `treasury-seatbyvote-anyone`,
`treasury-seatbyvote-any-address` (no kind-2 check), `treasury-seatbyvote-keeps-agents` (the epoch not bumped),
`treasury-seatbyvote-keeps-offer` (a puppet's offer survives), `treasury-seatbyvote-keeps-rate`, `launcher-bindcouncil-anyone`,
`launcher-bindcouncil-twice`, `launcher-windDown-council-bypass`, `launcher-council-member-project-account` (a project account accepted as a seat),
`settingshash-council-missing`, `settingshash-council-after-claims` (the Council form tested after the claims branch),
`pair-isseat-second-missing`. Report: sizes before and after, gas measured against 1.7 (including `draw` and `announceTask` against the
baseline), the mutation list, the test counts, the Treasury bytes, and whether the fallback was taken.

### K2: elections and the replace vote (contracts engineer, after K1)

Owns `contracts/pot/**` as K1: `src/HolderVote.sol` (new), `src/HolderPause.sol` (the three hook lines and two empty functions,
nothing else; the runtime bytecode is compared before and after and the result stated), `src/Council.sol` (only what the vote needs, if K1
left it), `src/Launcher.sol` (`councilByVote`, `bindCouncil`'s vote check, the `bindProject` call in `launch`, the fourth `settingsHash`
form), `src/Interfaces.sol`, `script/DeployPot.s.sol`, `DEPLOYMENTS.md`, `scripts/check-mutations.py`; new test files: `HolderVote.t.sol`,
`HolderVoteCount.t.sol` (the snapshot and the fall), `HolderVoteStanding.t.sol` (stake, displacement, project accounts, the opener's
list), `HolderVoteResults.t.sol` (floor, majority, keep in seats, ties, which seat a winner takes, cooldown after kept, short and moved),
`HolderVoteBoundary.t.sol` (the exact second of `voteEnd` for `castVote` and for the hooks), `HolderVoteAttacks.t.sol` (rows 1 to 23 of
section 3, with the numbers), `HolderVoteInvariants.t.sol`, `VoteEventsRebuild.t.sol`, `GasVote.t.sol`, `SizeVote.t.sol`,
`LauncherVote.t.sol`, `DeployVoteSettings.t.sol`, `HolderPauseOnVote.t.sol` (the pause suite on a `HolderVote`, 4.4 point 4), `OffIsOffVote.t.sol`,
and helpers `helpers/VoteBase.sol`, `helpers/VoteHandler.sol`. Existing tests are not edited; K2 may edit K1's new test files only where
K2's tightening of `bindCouncil` requires it, and says so.
Checks: as K1, plus: **`HolderPause` itself costs the same gas for `park` and `unpark` (the hooks compile to nothing) and a
`HolderVote` clone adds at most 2,300 gas with no ballot live** (`GasPause.t.sol`'s limits re-run on a clone with that allowance, in a new
file); `unpark` with a ballot live within its gate; invariants at 1,000 runs (section 2.2's list: **the sum of tallies equals the sum of
cast weights; while `now < voteEnd` the sum of tallies never exceeds the parked total and a weight never exceeds the account's parked
Shares; after `voteEnd` the tallies are frozen and only "adds up to the cast total" and "at most the supply at the snapshot" hold; `unpark`
never reverts for a ballot's reason; no ballot is live implies the hooks write nothing; at most one live ballot; the Treasury's buckets
are the same before and after any vote call; `runner` changes only by `handOver`/`takeSeat`/`seatByVote`**); the event rebuild (a ledger
from `BallotOpened`, `Stood`, `Voted`, `Fell`, `BallotFinished`, `BallotCarriedOut`, `BallotLapsed`, `SeatsSet` and `CouncilMade` alone
gives the same tallies, phases and seats as the views, over 400 random steps **that include vote moves**); the same five accounts
elected twice; a hand-over Council of the same five existing first; and the mutation script with at least these entries, each run once
and each killed: `snapshot-missing` (late parking counts), `low-not-min` (a re-park restores weight), `fall-not-applied`,
`hook-after-end`, `hook-reverts-on-underflow`, `floor-low`, `floor-not-snapshot`, `majority-half-inclusive` (`>` becomes `>=`),
`seat-beats-keep-inclusive`, `keep-missing-in-seats`, `opener-list-missing`, `displace-by-wrong-end`, `displace-on-equal`,
`cooldown-after-short`, `cooldown-after-moved`, `cooldown-missing`, `wait-zero`, `wait-from-finish`, `carryout-before-effective`,
`open-floor-missing`, `stand-stake-missing`, `min-vote-missing`, `list-duplicate-members`, `list-project-account`, `double-seat-winner`,
`seats-up-wrong-order`, `winner-takes-wrong-seat`, `tie-takes-the-seat`, `team-shares-counted`, `finish-twice`, `lapse-early`,
`late-stand`, `vote-before-standend`, `vote-at-voteend` (`<` becomes `<=`), `cast-twice-overcounts`, `voted-from-fields-missing` (the
move's old tally not emitted: the rebuild test fails), `vote-salt-missing` (the same five cannot be elected twice),
`seatbyvote-skips-launcher`, `carryout-not-atomic`, `bind-project-twice`, `isvote-missing` (the Launcher's own check also refuses a
plain pause, so this one may be an equivalent mutant: if it survives the report says why, and shows the other test that binds it).
Report: sizes, gas against 2.13, the Treasury unchanged by K2 (stated, with its bytes), the HolderPause bytecode comparison, the
mutation list.

### S1: the server (server engineer, after K2)

Owns `crates/**` and, for this round only (I assign them, since X8 does not), `migrations/<next free>_chain_council_role.sql`,
`schema/tables/public/chain_contracts.sql`, `scripts/chain-reader-events.mjs`, `scripts/chain-reader-fixture.py`,
`scripts/chain-reader-example-check.py`, `docs/next-version/RECORD-V2.md`, `record-v2-example-council.json` (regenerated by the script, not
edited). Files: `chain_reader/events.rs` (the role), `events_table.rs` and `testdata/*` (generated), `ledger.rs` and a new
`ledger_council.rs`, `record.rs`, a new `record_council.rs`, **`record_social.rs` and `record_social_tests.rs` (the Established rule, 5.8)**,
`numbers.rs`, `views.rs`, `scan.rs` (a Council is found from `CouncilMade`), `helper/calls.rs`, `plan.rs`, `mod.rs`, `api/sponsor.rs`,
`handlers/launch_update_authority.rs`, `handlers/agent_label.rs`, `web_push/alerts.rs`, `web_push/mod.rs`, and their tests. Checks: `cargo fmt
--all -- --check`; `cargo clippy -p buzz-relay -p buzz-cli --all-targets -- -D warnings`; `cargo test -p buzz-relay --lib` with filters
`chain_reader::`, `sponsor`, `launch_update`, `agent_label`, `web_push`; the Postgres lane (`--ignored`) for the touched files and the
migration; `node scripts/chain-reader-events.mjs --check`; the fixture regenerated and `chain-reader-example-check.py` clean for every
example; `scripts/regen-kinds.mjs --check`; **each new guard switched off once with the named test failing** (5.7), result in the report.

### A1: the app, the joined-up loop and the report (app engineers, after S1)

Owns `app/**`, `packages/**`, `patches/**`, `scripts/pot-*.sh`, `scripts/phone-loop.sh`, and (assigned here) `docs/next-version/TRY-IT.md`,
`DEPLOY-TEST-NETWORK.md`, the milestone 9 row of `docs/PLAN-V2.md`, and the round's report `docs/next-version/COUNCIL-REPORT.md`, **which
carries section 10's counsel questions word for word and the counts of 6.8** (the lead adds section 10 to the design's section 12).
Files: section 6.8. Order: make room in the entry chunk (6.8), then core, parse (`vote.rule` first, so no sentence types a number), card,
Council section, hand-over, alerts, the Back sheet line, the badge words, loops.
Checks: `biome check`, `tsc --noEmit`, `pnpm check:copy`, `check:px-text`, `check:file-sizes`, `knip`, `vitest` (all, counted), `pnpm build`
with the entry chunk named, `scripts/pot-chain-loop.sh` (every stage), `scripts/phone-loop.sh`, `scripts/pot-app-loop.sh`,
`scripts/pot-full-loop.sh` in full, the Playwright `smoke` project and `pot-council.spec.ts` at 390x844 and 360x640 with axe (`pnpm
build:e2e` first, never `pnpm run build`). Each guard switched off once with its named test failing: the vote press hidden for a person
who was not parked at opening, the stand sheet's text and field limits, the "text matches the chain" filter, the Agree press for a
non-seat, the hostile-record nulling, the opener's line shown only when the floor is met, the alert's urgency, **a sentence built from
a changed `vote.rule` (the number follows the record)**, **the planned-change card still shown when the record has a result and no
recorded finish**. The report states what a person on a real phone did not do, the entry chunk before and after, and every choice from
section 8 the app touched.

---

## 8. Chosen under the owner's standing go; the owner may overrule

| # | Choice | Alternative and why not |
|---|---|---|
| V1 | The Council is a runner contract: one clone per Council, five seats, three of five, recognised by the Treasury through the Launcher's `runnerKindOf` (0, 1 for a Pair, 2 for a Council; `isPair` is kept and is true for Pairs only) | Register Councils in `isPair` (then `announceForfeit` and `_founderAgrees` would treat a Council as a Pair at the Treasury; the Council's own list would be the only guard); a second name beside `isPair` (a second storage read on every runner call) |
| V2 | The Council may call only a list of Treasury selectors and `Launcher.windDown`, and the list includes `setAgent`, `authoriseAgent`, `revokeAgent` (X1's list does not name them; helpers are a runner's tool) | Any call as the Pair allows (it would reach `announceForfeit`); leave out helper set-up (a Council could not run a helper at all) |
| V3 | A check-in needs three of five (X1), though a Pair lets either signer check in | One seat may check in (a project would not go quiet for want of three accounts; costs nothing in money, since a check-in only keeps the window open) |
| V4 | One switch, `COUNCIL`, beside `HOLDER_PAUSE`, off by default, requiring the pause, replacing the pause's code with `HolderVote`; a Council implementation is bound by `bindCouncil` (deployer, once, first hour) and **is not put in Parts** (342 bytes spare) | The same switch as the pause (one switch cannot mean two things; the plain pause would be gone); a per-project founder choice (a founder could pick "no Council ever" and the replace vote would mean nothing) |
| V5 | `HolderVote` extends `HolderPause`; the pause gets three hook lines and two empty functions | A separate vote contract called out of `unpark` (a call that must never revert, a new trust edge); a copy (two codes to keep equal); per-account checkpoints (a cost on every parker) |
| V6 | The snapshot is "the fewest parked since the vote opened", kept lazily as `(stamp, low)` per account | Checkpoint history (more storage, a binary search); an enlist call before opening (holders cannot know when) |
| V7 | A hook lowers a vote when Shares leave custody **while the vote runs**; tallies freeze at `voteEnd` and an unpark after that changes nothing | Keep the vote fixed once cast (a vote that outlives its Shares); recount at the end (a loop over voters) |
| V8 | One account, one option, all of its eligible weight; a vote can be moved until the end | Split weight across options (more state, rarely used); fixed once cast |
| V9 | **One floor for both ballots: a third of the backers' Shares at the snapshot** (the pause's own constant); opening a replace vote needs 1 in 20 of the Shares parked in all and 1 in 1,000 from the caller; standing needs 1 in 1,000 | PLAN-V2's 5/10/15% floors by stage (no stage exists); a tenth for seats (the first draft: a holder of a tenth could win both seats in two elections for about a fiftieth of the sleepers' loss, so the cheap road round the replace vote's floor was shut) |
| V10 | The replace vote's turn: a list wins only with more than half of all Shares cast (keep included); **every seat ballot also has "keep", and a person needs strictly more than "keep"** | A separate yes/no on moving and a separate election of five seats (two ballots and two snapshots); a plurality (a split opposition lets a minority through; honest holders could only abstain) |
| V11 | The result is frozen at `voteEnd` and cannot be cancelled during the wait; the answer for a holder is exit; a counter-vote opens once the result is carried out | A counter-vote or a veto during the wait (a second snapshot, a second turnout rule) |
| V12 | Every result, seats included, takes effect `WAIT` after the vote ends; `effectiveAt` is fixed at opening | A wait for lists only (two rules to explain) |
| V13 | One ballot at a time; **the replace cooldown (4 units) follows only a result that ended "kept" with the floor met**; none after short, moved or lapsed; seats open only by the clock; **a replace vote does not wait for a due election** | A cooldown after every ballot (a junk ballot could hold the door; a takeover could not be answered for 28 days); no cooldown (spam of "kept" ballots); a due election that blocks a replace vote (holders' recovery would hang on the helper) |
| V14 | Two seats up per 26 units, the two that have gone longest without a vote first (`lastUp`), open seats first, ties to the lower seat; the two seats' `lastUp` moves at opening, so rotation moves on whatever the result | A fresh full election each time (the Council could change in one day); rotation by `seatedAt` (a seat's display date would be reset by an election) |
| V15 | Seats change only by election, replace vote, resign, or a whole hand-on; the other seats cannot remove one | A seat removed by three of five (a majority could silence the other two for good) |
| V16 | Agents are not barred from a seat on the chain (the contract cannot tell an agent from a person, as with a Pair); the server refuses a candidacy signed by an agent and the app marks an account the server labels an agent | A contract check on `Treasury.agents` (it only sees an agent of the present runner) |
| V17 | A Council cannot announce a forfeit or mark "founder leaves" | Allow it for three of five (a trim or burn of someone's grant by a majority, against C19) |
| V18 | `carryOut` makes the Council and seats it in one transaction, so there is never a Council nobody seated or a seat nobody made | Two calls (a window in which the Council exists but is not seated) |
| V19 | App words: "Vote", "list", "seat", "Council", "Ask holders"; "Back" is kept for putting money in; **a Council is "five accounts", fields "Seat 1" to "Seat 5"** | "Back this list" (collides with putting money in, design C22); "five people" (an account can be anyone, or one person with five) |
| V20 | A candidate's text is a kind 47003 record of a new family `candidacy` with a `t` tag `vote:<key>:<id>`, bound to the chain by its id | A new kind (a new relay rule, a new table); text on the chain, or inside the event (permanent and unremovable, which counsel's question C3 may want to be able to take down) |
| V21 | Four permissionless helper jobs (open seats, finish, carry out, lapse) and never "open a replace vote" | A helper that also opens replace votes (a discretionary act) |
| V22 | **Alerts and pushes for either ballot's opening and for a moved or seated result**; a person who holds the project and has alerts on gets at most one "a vote is open" push per project per time unit | No push for seats (the weakest warning on the cheapest road); a push for every ballot without a limit (noise) |
| V23 | **The Established badge counts a Council with at least 3 live seats** (`established.twoSigners` keeps its name and means "run by more than one account") | Count only a Pair (a project that grows would lose the badge, against "mature on its own time") |
| V24 | A replace vote changes who runs; it never trims or burns a grant, and there is no path from the vote to the Vester | A vote that can also mark "founder leaves" |
| V25 | A replace vote is opened from the pause card, and only when it can be (the floor met, no ballot, the cooldown over, the person parked); nothing else shows | A permanent "Ask holders" link on every project (it would show on every project that has a pause) |
| V26 | Votes are public on the network (the chain shows each vote); the record carries totals only, and the app says "Posts and votes are public." where a person votes, stands or agrees | Hide votes (not possible on a public chain) |
| V27 | Test-network timing scales from the unit: stand and vote lengths and the result's wait come from the same constants as on a real network; the record refresh and the helper's pace are a quarter of the stand window when that is under 600 s | Fixed seconds (a demo network could not show a vote) |
| V28 | The card's last sentence on a replace vote is "A vote only changes who runs this project. Taking out stays open: if you will be away, you can take your money out first." | A sentence about protection (false); say nothing (the residual risk of section 3 would be hidden) |
| V29 | The wait is the Treasury's own longest notice, read when the ballot opens, so it follows any change of the notice rule | Hand-copy 16.5 days (a number that could go stale) |
| V30 | Ownership of the docs, the migration and the generated-file scripts as in section 7 (X8 names none) | |
| V31 | A seat holder's `bothSigned` is named as the Pair names it (so the Treasury reads both the same way) | A new name (a second interface to the same idea) |
| V32 | **The opener of a replace vote puts their own list in the opening call; places are ranked by stake and a strictly larger stake takes the smallest place** | First come, first served (an opener could stuff every place with its own accounts in one transaction and shut honest names out) |
| V33 | **No app press for `finish`, `carryOut`, `lapse` or opening a seat election**: the helper is the normal path, each is open to anyone from any wallet, and without the helper a seat election waits and a won result lapses to the old runner | A "Put the result in" press on the card (one more press, one more record field, for a case the helper covers) |
| V34 | **The server derives the result from the frozen tallies and shows it at once; `BallotFinished` confirms it** | Show the result only after `finish` (a down helper would hide a takeover for 16.5 days) |
| V35 | The tallies freeze at `voteEnd` and the result is not re-checked at `carryOut` against the winners' still-parked Shares | Re-check at `carryOut` (a winner would have to stay parked 20.5 days: honest winners too; it would mix "leaves custody during a vote stops counting" with a rule after it; the sleepers' loss is the same either way) |
| V36 | The vote path's Council address is salted by the ballot id and tagged so no hand-over salt equals it | The same salt space (the same five could never win twice) |
| V37 | `seatByVote` clears the pending offer, the helpers' epoch and the pending rate; `takeSeat` is unchanged and shares the body | Clear only the helpers (a puppet offer or a pending rate from the old runner would reach the new Council) |
| V38 | The Launcher refuses a seat that is one of the project's own contracts (`isProjectAccount`), at making and at standing; a smart account stays allowed | Only "distinct and non-zero" (a winning list could seat the Treasury and `carryOut` would revert for ever) |
| V39 | `castVote` needs one whole Share of eligible weight; a tie for the last seat leaves that seat as it is | No minimum (dust accounts could fill the logs); a tie goes to who stood first (the opener controls that) |
| V40 | No "Give up my seat" in the app; the contract has `resign`. "Take back my agreement" stays, as a small link | Both in the app (two more presses for rare acts) |
| V41 | The stand sheet carries one plain line, "Do not promise anyone a profit or a return."; nothing hides a text later (counsel's C3) | Hide texts by the founder's mute (the runner being replaced could mute the challengers); say nothing |
| V42 | One sheet for standing and for opening (the opening mode adds one sentence); no separate "Ask holders" sheet | A second sheet (more to build, the same fields) |
| V43 | A worker elected to a seat while holding a taken task cannot be paid for it (the same rule as a Pair signer); the contract does not stop them standing | Refuse standing to an account with an open task (the vote contract cannot see the task book) |
| V44 | Two review items the plan did **not** take: build the Council by hand-over first and the vote in a later round (the lead's brief asks for both, so a **planned fallback** in 1.7 gives the same cut if the Treasury will not fit); put the candidate's text inside the event (V20) | |

**What is not in this round, and why.**

- **The reserve sale** (milestone 9's third part) is not built, on the owner's own words of 19 November: "not having set
  fundraising amounts" and the daily allowance in place of funding each task "perhaps through an auction". In the new model the door is
  open any day at the leave-value, so there is no reserve to sell and no sale to approve.
- **The stage ladder** (Solo, Backed, Team, Council, Open) with its raise caps is replaced by "mature on its own time": a project is run by
  a founder, then a Pair, then a Council, when it chooses (a hand-over) or when its holders vote (a replace vote), with no stage, cap, date or
  eligibility line. The turnout floors that stepped up by stage are one fixed number, a third.
- The supermajority for a wind-down by holders, the team-payer role and `payTeam` (the team budget is gone in the new model, design 6),
  holders voting on a task, a holder-run wind-down, term limits, seat pay, delegation, signed (gasless) votes, voting with Team Shares.
- The end-at-two-thirds power (STEP4-PLAN D5) stays out.
- Any real network, any real money, the audit, and counsel's reading of whether this counts as "governance" (design 12.4; section 10 lists
  what counsel is now asked). Trading and investing stay off by default. The legal line is not reworded anywhere: the app shows it word
  for word where it already does and no screen here changes or hides it.

**For the owner, in two sentences.** The Council adds a shape, not a power: five accounts, three to agree, with every limit of a founder
unchanged, and five accounts can be one person. The replace vote cannot protect a holder who is away for three weeks; it gives everyone
who looks at least 13.5 days and a plain page, and the answer to a vote you dislike is the one press that always works.

**Open for the builders (where I am least sure).** (1) Whether the Treasury's `seatByVote` fits in 190 bytes (K1 measures first; the
fallback of 1.7 is agreed). (2) That the hook in `unpark` can never revert: the invariant must be written against every ballot shape,
not a few. (3) Whether "a list wins with more than half of all Shares cast" should instead be more than half of the Shares at the
snapshot (harder for a whale, harder for honest holders too). (4) The 4-unit cooldown after a real "kept": long enough to stop a repeat,
short enough not to trap holders with a hostile Council. (5) Whether three of five for a check-in will leave real Councils quiet (V3).
(6) The `moved` push made from a derived result: S1 reads the alert path first and says how it fitted (5.6).

---

## 9. What the two reviews changed

Two independent reviews (contracts, and fit with the product) attacked the first plan (`98d73fc24`). Each finding was checked against
the code. **All of the following held and are fixed above.**

| Finding | What it was, in the code | Where fixed |
|---|---|---|
| Both: the Treasury edits break `test/helpers/Mocks.sol` | `MockSalePath` implements only `isPair`, `MockPair` only `first`, `second`, `bothSigned`; 23 test files use them through `PotBase`, `Treasury.t.sol`, `Tasks.t.sol`, `Quiet.t.sol`. The old "no helper edited" was false | 1.2 (the two stubs), 4.4 point 4, K1 |
| Both: `cast <= parkedTotal` hides the planned-change card after the winners unpark | tallies freeze at `voteEnd`, unparking then lowers `parkedTotal` below the frozen `cast`, so the signed record would have `vote: null` for the whole 16.5-day wait | 5.2 checks, 2.2 and K2 invariants, row 22 |
| Contracts B3: `Voted` cannot rebuild a moved vote | it carried only the new option's tally; a move lowers the old option's too | 2.12 (`fromOption`, `fromTally`), 5.1 |
| Contracts I1: a record that survives the run, no re-entry guard | the Pair deletes before the call and has `_executing`; the plan did not | 1.3, 1.9, K1 mutations |
| Contracts I2: a puppet offer survives `seatByVote` | `takeSeat` clears the offer; the plan's `seatByVote` did not say so | 1.2 (`_seat`), 2.7, row 16 |
| Contracts I9: a pending rate survives a seat change | `proposeRate` state is not cleared by `takeSeat` | 1.2 (`clean`), row 16 |
| Both: the vote path has no salt (Contracts I3, Fit I3) | `cloneDeterministic` reverts for an address already taken | 2.8, V36 |
| Both: a seat election is the cheapest takeover | a tenth as the floor, plurality, two seats an election | one floor of a third, "keep" in every seat ballot, table row 21, V9, V10 |
| Contracts I5, Fit I2: slot stuffing, a junk ballot that holds the door, a takeover that cannot be answered for 28 days | first-come places; the cooldown ran after every ballot | 2.3 (the opener's list, stake-ranked places), 2.4 (the cooldown only after a real "kept"), 2.5 (the 20.5-day minimum), rows 9, 23, V13, V32 |
| Contracts I6: the result visible only after `finish` | the warning would come only when the helper pressed it | 2.6, 5.2 (`result` derived), 5.6, V34 |
| Contracts I7: `isSeat(0)` and unseatable accounts | an open seat is the zero address; a list could name the Treasury | 1.3, 1.2 (`isProjectAccount`), row 14, V38 |
| Contracts I8: row 7 listed the task bar as a defence | it covers five accounts and a hostile Council uses a sixth | row 7, 1.5 |
| Contracts O2/O3, O11, O12 | `seatByVote` accepted any runner contract; one extra Launcher read per runner call; `pauseGate()` missing from `ITreasuryRunner`; which seat a winner takes | `runnerKindOf` (1.2), 1.2 interfaces, 1.5 |
| Contracts O4, Fit I12 | the hooks may change the recorded pause hash; "same gas" was false for a `HolderVote` clone | 2.13, 4.4 point 5, K2 |
| Contracts O5 (part), O6, O7, O8, O10 | row 8's fee is paid once; a joiner after a moved result must see it; the exact second of `voteEnd`; ties; a runner can wind down during the wait | row 8, 6.1 and 6.8 (the Back sheet), row 11, V39, 2.7 and the residual paragraph |
| Fit I4: "five people", unconsenting lists | copy said "people" and "Person 1" | 6, V19 (accounts, "Seat 1", "Put forward by", short addresses) |
| Fit I5: the Established badge | `two_signers` is Pair-only, so a project that grows loses it | 5.8, V23 |
| Fit I6: "anyone can press carry out" with no press | the app had none | 2.11, 5.5, V33 |
| Fit I7: a profit promise in a candidate's text | no rule, no line | 6.2 (the plain line), row 19, V41, section 10 C3 |
| Fit I8: numbers hand-copied into words | "four weeks", "three of them", "first day" | 5.2 `vote.rule`, 6 (a test builds every sentence from the record) |
| Fit I10, I11: no fallback for the Treasury's bytes; two mutants accepted as survivors | | 1.7, K1 (both killed at `propose` and at the Treasury) |
| Fit: lightness, the refresh pace on a test network, one-Share minimum, per-unit push limit | | 6 (cuts), 5.3, 5.5, V39, 5.6 |

**What did not hold, or was not taken, and why.**

- **Contracts O5, "the six places cost 6,006 net, and the plan's 6,036 matches neither":** the plan's figure was right. Each of six
  accounts needs one thousandth of the supply that includes all six, so each puts in `P0 / 994` and six put in 6,036 net on 1,000,000
  (gross 6,159; fee 123). The table now shows four list places (net 4,016) and twelve person places (net 12,146) with the same formula.
- **Contracts O1 (re-check at `carryOut` that the winners are still parked):** not taken (V35). It would make honest winners stay parked
  for 20.5 days, would mix the rule "a Share that leaves custody during a vote stops counting" with a rule after the vote, and changes
  no figure: the sleepers' loss is the same either way. It is in the attack table as row 22.
- **Fit Cut 1 (build the Council by hand-over now and the vote later):** not taken as the plan, because the brief asks for both. The
  **planned fallback of 1.7** gives exactly that cut if the Treasury's bytes require it. **Fit Cut 2's** idea of putting the candidate's
  text inside the event: not taken (V20: permanent and unremovable text).
- **Fit I2's "make the cooldown per opening account":** not taken: accounts are free. The cooldown follows only a real "kept".
- **Fit's "five people" copy fix and the Established rule were taken, but not by dropping the Council's own sentence "can do what a
  founder could do"**: it is true by the contract; counsel reads it (section 10, C5).
- **Contracts I4's "consider a majority for seats":** met by "strictly more than keep" and one floor, which is a majority test against
  the holders who answered "keep" rather than against all Shares cast.
- **Contracts' check that `settingsHash` has four forms only if the claims branch also adds the Council:** held, and is now stated (4.2:
  the Council test comes first).

---

## 10. Questions for counsel (hand to the lead for design section 12; A1 copies them into `COUNCIL-REPORT.md` word for word)

The first answer on the design's question 12.4 ("here governance is the notice and the right to leave, with no vote") assumed no vote.
With `COUNCIL=1` that premise is false; with it off it holds. **Counsel is asked for an answer per setting of the switch.** The legal
line is not edited.

- **C1.** With a real vote (replace the runner, elect seats), is "governance and exit" delivered in the stronger sense? Does that change
  the analysis of Shares themselves (voting rights as an indicium) or of the platform fee that buys a vote? Redo 12.4 for both settings
  of the switch.
- **C2.** Do voters who control who runs a pot, or Council seat holders (five accounts that decide the spending of others' money), face
  partnership, unincorporated-association, fiduciary or money-handling exposure? Does an AI agent holding a seat (V16 does not bar it)
  change that?
- **C3.** A candidate's text is a statement by someone seeking control of others' money, hosted in the platform's app. Is it a
  solicitation? What moderation, or "no promise of profit" rule, is required beyond the one plain line of V41, and should a text be
  removable after the fact?
- **C4.** Takeover disclosure: a holder of a third can take control for about the platform fee, and holders who do not look can lose
  about 12 in 100 within 30 days of the seat. What must the page and the terms say about that? The plan says only "taking out stays open".
- **C5.** Naming: "Council", "five accounts", "list". Is it misleading that five seats can be one person? Is showing the linked names of
  accounts that did not agree to be listed acceptable? Does the Council section's last line ("can do what a founder could do, with the
  same limits, and nothing more") read as reassurance?
- **C6.** Votes are public on a public chain and linked to accounts. Is "Posts and votes are public." enough for privacy and erasure rules?
- **C7.** The snapshot rule (only Shares parked before a vote opens count) means late joiners cannot take part. Is that fair, and does it
  need disclosure on the Back sheet (the plan shows the planned-change sentence there)?
- **C8.** The platform's helper presses `finish` and `carryOut`. Does automating a governance outcome make the platform a participant?
- **C9.** Play dollars on a test network: does a vote on play dollars avoid all of this, and what changes at the first real-money launch?
- **C10.** Questions 12.1, 12.7, 12.10 and 12.11 are not changed by this plan. The words "You can take your money out any time." alone (in
  an alert or a push, without the second half) are consistent with the existing planned-task push; counsel may want the pair kept
  together outside the app.
