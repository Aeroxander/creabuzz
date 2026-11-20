# Record version 2: the project numbers (kind 39009)

The one specification the server and the app both build against for steps 1 and 2 of `docs/next-version/JOIN-LEAVE-DESIGN.md` (step 2's
additions, the task queue and the exit notes, are section 10). The server
(`crates/buzz-relay/src/chain_reader`) writes this record; the app (`app/src/features/money/numbers.ts` and everything that reads
it) reads it. The contracts are `contracts/pot`; their events and views are listed in `docs/next-version/POT-STEP1A-REPORT.md`
sections 7 and "Review fixes". **The contracts are the truth.** Where this page and a contract disagree, the contract is right and
this page is wrong: report it.

One complete, valid example is `docs/next-version/record-v2-example.json`. Both tracks test against that one file (section 7), so
they cannot drift apart. It was made by running the real contracts, not by hand (section 7.2).

Status: a specification, and the server writes it as it stands (step 1 and, since step 2, the additions of section 10). Choices the design left open are marked **(S#)** and collected in section 9; the
owner may overrule any of them. This is not legal or tax advice, and no figure here is a promise of any result for anyone.

## 1. What the record is, and the rules that hold for every field

- **Kind 39009**, addressable, signed by the server's own key, one per project. Tags: `d` = the project's chain key (lower-case
  `0x` and 64 hex), `chain` = the chain id, `launcher` = the Launcher address. The app believes a record only when it is signed by
  the server's key, the `d` tag equals the chain key the founder's project record names, and `founder` and `projectId` in the
  content hash to that key (`numbersBelongTo`, unchanged from version 1).
- **`version` is the number 2.** The app ignores any record whose version it does not know (it shows "no numbers yet", never a half
  parse), exactly as version 1's parser ignored everything but 1. A version 1 record is never read by the new parser.
- **Adding a field never changes the version** (a reader ignores fields it does not know). Removing a field, renaming one, or
  changing what one means is version 3. Step 2 (tasks, notice, exit notes) only adds fields (section 8).
- **Types.** Amounts are **decimal strings** of whole numbers in the smallest unit, never JSON numbers (as in version 1). Dollars
  have **6 decimals** (1 dollar = `"1000000"`). Shares and Team Shares have **18 decimals** (1 Share = `"1000000000000000000"`).
  Times are unix seconds, JSON integers. Counts, block numbers, `ratePpm` and the unit-counts in `limits` are JSON integers.
  Addresses and 32-byte values are lower-case `0x` text. Booleans are `true` or `false`. `null` means "there is none"; a field that
  is listed as required is always present.
- **One block.** Every number in the record is as of **one final block**, `asOf.block`: every view is called at that block number
  (never at "latest"), and every event is read up to and including it. A view that depends on the time (the settled pot, `doorOpenNow`)
  is worked out at that block's own time, `asOf.time`, which is the block's timestamp. A record is never a mix of two blocks.
- **Removed.** A project whose launch left the chain gets `{"version":2,"key":"0x…","removed":true,"asOf":{"block":n,"time":t}}`
  and nothing else (as in version 1).
- **Size.** About 120 KB at the worst caps (200 holders at about 110 bytes, 200 grants at about 450, 50 agents at about 160), well
  under the relay's 512 KB frame. The example is 5.6 KB.
- **Plain words are the app's job.** This page uses the contracts' words ("pot", "paid-in", "Team Shares"). The app shows "the
  project's money", "what you would get if you took out now", "Back", "Take out" and never the field names.

## 2. The record, field by field

"From" says exactly where the server gets the value: **view** is a call at `asOf.block`, **event** is read from the logs,
**settled** is the roll-forward of section 3. Nothing a view returns is computed by the server (S2 is the one exception, and it is
checked against views on every build).

### 2.1 Identity, network, contracts

| Field | Type | Meaning in one sentence | From |
|---|---|---|---|
| `version` | `2` | The version of this record. | constant |
| `chainId` | int | The network the project lives on. | `eth_chainId` of the configured node |
| `launcher` | address | The Launcher that made the project. | configuration; emitter of `ProjectLaunched` |
| `key` | bytes32 | The project's chain key, `keccak256(abi.encode(founder, projectId))`, equal to the `d` tag. | event `ProjectLaunched.key` |
| `projectId` | bytes32 | The id the founder chose; it links the record to the founder's project post. | event `ProjectLaunched.projectId` |
| `founder` | address | Who launched the project. | event `ProjectLaunched.founder` |
| `launchedAt` | int | When the project was born. | event `ProjectLaunched.project.launchedAt` |
| `playMoney` | bool | True when the dollar is play money on a test network: every money screen must say so. | view `Launcher.testNetwork()` (S7) |
| `contracts.treasury` | address | The project's money contract. | event `ProjectLaunched.project.treasury` |
| `contracts.shares` | address | The backer Shares token. | `project.shares` |
| `contracts.team` | address | The Team Shares token. | `project.team` |
| `contracts.vester` | address | The contract that holds and unlocks the Team pool. | `project.vester` |
| `contracts.dollar` | address | The dollar token (6 decimals). | `ProjectLaunched.platform.quote` |
| `contracts.pair` | address or null | The project's Pair, once a second person accepted the seat; the first `PairMade` for this key. | event `Launcher.PairMade` |
| `unit` | int | The time unit N in seconds: 604,800 (7 days) on a real network, a multiple of 168 on a test network. A "day" in every rate is `unit / 7` seconds. | view `Treasury.unit()` |
| `fee.bps` | int | The platform fee on money going in, in ten-thousandths (200 = 2%). Nothing is charged on taking out. | view `Treasury.feeBps()` |

`playMoney` is the safe default: **a record or a parser that does not know the answer treats it as `true`**, and the app shows
the play-money line on every money screen unless the record says `false` and the app's real-money switch is on (the real-money
switch is not part of step 1).

### 2.2 Where and when it was built

| Field | Type | Meaning | From |
|---|---|---|---|
| `asOf.block` | int | The final block every number is read at. | the reader's newest final block |
| `asOf.time` | int | That block's timestamp: the moment the money numbers describe. | block header |
| `builtAt` | int | The server's clock when it signed the record; equal to the event's `created_at` (the relay may add one second to keep a record newer than the stored one, and then `builtAt` is that value). The app uses `builtAt`. | server clock |
| `refreshEverySecs` | int | How often the server promises to sign a fresh record for this project: 600 while the allowance is accruing, outside money is arriving or any task is open (announced or taken), otherwise 3600 (section 6). Never more than 43200. | server rule |

### 2.3 The project's money (all dollar amounts, 6 decimals)

| Field | Type | Meaning | From |
|---|---|---|---|
| `money.pot` | amount | What taking out can reach now: the project's money. | **settled** (section 3), checked against views |
| `money.paidIn` | amount | What backers put in after the fee and have not taken back (A). | view `paidIn()` |
| `money.arriving` | amount | Outside money that has been paid in and has not yet reached the pot. | **settled** |
| `money.arrivalEnd` | int or null | When the last of it has arrived; null when `arriving` is `"0"`. | view `arrivalEnd()` when `arriving` is not zero |
| `money.feesOwed` | amount | The platform's fee waiting to be collected; not part of the pot. | view `feesOwed()` |
| `money.locked` | amount | Money set aside for taken tasks that are still running at `asOf.time`: the stayers' claims. **Settled** (section 3): what ran out is back in `pot`. This is the line the Back sheet's price counts at face. | view `locked()` less `book.dueC(asOf.time)` |
| `money.notesOwed` | amount | What is held for exit notes: the face of the notes against open tasks plus what is left to claim on tasks that ended. | view `notesOwed()` |
| `money.held` | amount | Every dollar the Treasury holds: `pot + box + arriving + feesOwed + locked + notesOwed` (plus any donation nobody can claim). | view `dollar.balanceOf(treasury)` |
| `allowance.box` | amount | The daily allowance accrued and not yet drawn; at most `boxCap`; not part of the pot. | **settled** |
| `allowance.boxCap` | amount | The most the box can hold, seven days of accrual. | view `boxCap()` |

### 2.4 Shares

| Field | Type | Meaning | From |
|---|---|---|---|
| `shares.backers` | amount (18 dec) | Backer Shares in existence, B. All of them are in hands (there are no held Shares in this design). | view `shares.totalSupply()` |
| `shares.teamCounted` | amount (18 dec) | Team Shares counted, G: the pool set at birth, vested or not, less any already burned. A Share announced to burn is still counted here until the burn runs. | view `team.totalSupply()` |
| `shares.announcedBurn` | amount (18 dec) | Team Shares announced to burn, Z: a join is priced as if they were already gone; a take-out still pays on all of them. | view `Treasury.Z()` |

### 2.5 What one Share is worth if you took out now

| Field | Type | Meaning | From |
|---|---|---|---|
| `value.leaveValue` | amount (dollar units per **1e18** Share units) | What one whole backer Share would get in cash if taken out at `asOf.time`: backers are paid first up to paid-in, anything above is shared with Team Shares. `"0"` with no backers. | view `Treasury.leaveValue()` |
| `value.teamValue` | amount (dollar units per **1e18** Team Share units) | What one whole Team Share would get: only what is in the pot above paid-in, shared by all Shares. Usually `"0"` or tiny. `"0"` with no Team Shares. | view `Treasury.teamValue()` |

These are for lists and pages ("a Share is worth about 0.010058 now"). **They are one whole Share, in dollar units of 1e-6, so
they carry at most 6 decimals and lose precision as a Share gets cheaper.** A person's own figure is never `shares × leaveValue`:
it is `quoteTakeOut` read from the chain at the moment of the sheet (section 5).

### 2.6 The allowance and its rate

| Field | Type | Meaning | From |
|---|---|---|---|
| `allowance.ratePpm` | int | The daily allowance as parts per million of the pot a day (1000 = 0.10%). | view `ratePpm()` |
| `allowance.pending` | object or null | A raise that was announced and has not been applied; null when there is none. | views `pendingRatePpm()`, `pendingAt()` |
| `allowance.pending.ratePpm` | int | The rate it will become. | `pendingRatePpm()` |
| `allowance.pending.proposedAt` | int | When it was announced. | `pendingAt()` |
| `allowance.pending.applicableAt` | int | The first moment anyone may apply it: `proposedAt + unit`. | arithmetic on two views (equals `RateProposed.applicableAt`) |
| `allowance.drawnLastDay` | amount | What was drawn from the box in the last day (`unit / 7` seconds before `asOf.time`), by the runner and by agents. | event `AllowanceDrawn.amount`, summed by block time |

### 2.7 The weekly check-in, the door and the quiet states

| Field | Type | Meaning | From |
|---|---|---|---|
| `clock.lastCheckIn` | int | When the runner last checked in (the birth time if never). | view `lastCheckIn()` |
| `clock.lastRecordHash` | bytes32 or null | The hash of the weekly record signed with that check-in; null if the project never checked in after birth. | event `CheckedIn.recordHash` (the newest) |
| `clock.activeUntil` | int or null | The end of the check-in window: when the allowance, vesting and the door stop unless the runner checks in again. Null once wound down. | view `activeEnd()` (zero becomes null) |
| `clock.activeSeconds` | int | Active time so far, the clock vesting runs on. | view `activeNow()` |
| `door.switchOn` | bool | The founder's door switch. | view `doorFlag()` |
| `door.openNow` | bool | Whether a join would be accepted at `asOf.time`. | view `doorOpenNow()` |
| `door.shutsAt` | int or null | The door shuts by rule at this time whatever the switch says; equals `clock.activeUntil`. | `activeEnd()` |
| `quiet.state` | `"active"`, `"quiet"`, `"dormant"`, `"may_wind_down"` or `"wound_down"` | Where the project is at `asOf.time`: checked in within the window; past the window (allowance, vesting stop, door shut); past 13 units; past 26 units (anyone may wind it down); wound down. | worked out from the three times below and `windDown` |
| `quiet.since` | int | When the current state started. | `lastCheckIn`, `quietFrom`, `dormantFrom`, `windableFrom` or `windDown.at` |
| `quiet.quietFrom` | int or null | When "quiet" starts: `lastCheckIn + 2 units`. | view `activeEnd()` |
| `quiet.dormantFrom` | int or null | When "dormant" starts: `lastCheckIn + 13 units`. A display state with no rule behind it. | `lastCheckIn + 13 x unit` (S5: 13 is a server constant, the contracts have none) |
| `quiet.windableFrom` | int or null | When anyone may wind the project down: `lastCheckIn + 26 units`. | `lastCheckIn + WIND_MULT() x unit` |
| `quiet.next` | `{state, at}` or null | The next state and when it starts; null after "may_wind_down" and after a wind-down. | the same times |
| `windDown` | `{kind, at}` or null | Set once the project is wound down: kind 1 by choice, kind 2 after 26 quiet units. | views `windDownKind()`, `windDownAt()` (kind 0 becomes null) |

When the project is wound down, `clock.activeUntil`, `door.shutsAt`, `quiet.quietFrom`, `dormantFrom`, `windableFrom` and `next` are
null, `door.openNow` is false, `allowance.box` is `"0"` (it went back to the pot) and `quiet.state` is `"wound_down"`.

The app does not store the state: it keeps the three times and works out the state at its own clock for words only:
`windDown ? wound_down : now < quietFrom ? active : now < dormantFrom ? quiet : now < windableFrom ? dormant : may_wind_down`.
What the door and the allowance actually do is decided by the chain, and the sheets ask it (section 5).

### 2.8 Who runs it

| Field | Type | Meaning | From |
|---|---|---|---|
| `runner.address` | address | Who may check in, draw and change the rules: the founder, whoever took the seat, or the Pair. | view `runner()` |
| `runner.isPair` | bool | True when the runner is a Pair the Launcher made (two signers for every money call, either may check in). | view `Launcher.isPair(runner)` |
| `runner.signers` | `[address, address]` or null | The Pair's two signers, in order; null when the runner is not a Pair. | views `Pair.first()`, `Pair.second()` |

A seat offer, a Pair's waiting calls and the agent screen's form stay chain reads in the app, as today.

### 2.9 Team Shares and grants

| Field | Type | Meaning | From |
|---|---|---|---|
| `team.pool` | amount (18 dec) | The Team pool set at birth. | event `ProjectLaunched.terms.teamPool` |
| `team.inHands` | amount | Team Shares already sent to members (claimed): `teamCounted - inVester`. | views |
| `team.inVester` | amount | Team Shares still held by the Vester: unvested, unclaimed, announced to burn, or not yet granted. | view `team.balanceOf(vester)` |
| `team.promised` | amount | Of those, what is promised to someone and not yet sent or burned. | view `Vester.committed()` |
| `team.ungranted` | amount | The rest of the pool nobody was granted: `inVester - promised`. | arithmetic on two views |
| `team.grantCount` | int | Grants made so far, for life. | view `Vester.grantCount()` |
| `team.grants` | array | Every grant that is not finished (below), by id, at most 200. | below |

A grant is **finished** when it is closed and everything it keeps has been claimed; finished grants are left out of the list (they
still count in `grantCount`). If more than 200 are not finished, the first 200 by id are listed and the top-level `truncated` is
true. The cut is deterministic and never favours a finished grant: finished grants are not candidates at all, so one that is not
finished is never left out for one that is.

| Grant field | Type | Meaning | From |
|---|---|---|---|
| `id` | int | The grant's id in the Vester. | event `GrantMade.id` |
| `member` | address | Who it is for. | `grantOf(id).member` |
| `kind` | `"normal"` or `"protected"` | A protected grant vests on calendar time, has no cliff and cannot be forfeited. No step 1 call makes one. | `grantOf(id).protected_` |
| `state` | `"live"`, `"announced"` or `"closed"` | Vesting; the unvested part announced to burn; or settled (what stays is fixed). | `grantOf(id).state` |
| `granted` | amount | What was granted. | event `GrantMade.amount` |
| `keeps` | amount | What the member keeps: equal to `granted` while live; after an announce or a close, what stays. | `grantOf(id).total` |
| `claimed` | amount | Already sent to the member. | `grantOf(id).claimed` |
| `vested` | amount | Unlocked so far, claimed or not. For an announced or closed grant all of `keeps`. | view `vestedOf(id)` |
| `claimable` | amount | What the member can claim now: `vested - claimed`. Anyone may call the claim; the Shares go to the member. | view `claimable(id)` |
| `startActive` | int | The active-time reading at the grant: vesting runs from it. | `grantOf(id).start` |
| `cliff` | object or null | Live, normal grants only. | below |
| `cliff.passed` | bool | Whether the cliff (13 units of active time) has passed. | `activeSeconds - startActive >= cliffUnits x unit` |
| `cliff.endsAtIfActive` | int or null | When it passes if the project keeps checking in: `asOf.time + remaining active seconds`. Null once passed, and null when wound down. Vesting runs on active time, so this is not a promise. | arithmetic |
| `fullyVestedAtIfActive` | int or null | The same for the end of vesting (104 units). Null once fully vested, and null when wound down. For a protected grant: the calendar end, `startActive + PROTECTED_LENGTH`. | arithmetic |
| `forfeit` | object or null | Set only while `state` is `announced`. | event `ForfeitAnnounced` and view |
| `forfeit.amount` | amount | The unvested part announced to burn. | `grantOf(id).burn` |
| `forfeit.burnAt` | int | When anyone may run the burn. | `grantOf(id).burnAt` |
| `forfeit.byMember` | bool | True for the member's own exit, false when both signers announced it. | event `ForfeitAnnounced.byMember` |

Remaining active seconds for the cliff are `max(0, startActive + cliffUnits x unit - clock.activeSeconds)` (and the same with
`vestUnits` for full vesting); `cliffUnits` and `vestUnits` come from `limits`.

### 2.10 Agents, limits, totals, backers

| Field | Type | Meaning | From |
|---|---|---|---|
| `agents` | array | Accounts the runner set as helpers with daily limits, live ones first, at most 50. The cut is deterministic: the server reads at most 100 accounts, taking first those the events show as switched on under the current runner and then the rest, each group by address; the list is those read, live (by the views) first, then by address. `truncated` is true when an account was left out. | events `AgentSet` (the addresses), then views |
| `agents[].agent` | address | The helper's account. | `AgentSet.agent` |
| `agents[].live` | bool | Whether it can act now: switched on **and** set under the current runner. A hand-over switches every agent off without an event. | views `agents(addr).active` and `agentEpochOf(addr) == agentEpoch()` |
| `agents[].usdCap`, `teamCap` | amount | Its daily limits: dollars out of the box, Team Share wei granted. | view `agents(addr)` |
| `agents[].usdUsed`, `teamUsed` | amount | Used inside the current daily limit. | views `agentUsdUsed`, `agentTeamUsed` |
| `limits.minJoin` | amount | The smallest Back, fee included. | view `MIN_JOIN()` |
| `limits.minOutsidePayment` | amount | The smallest outside payment. | view `MIN_REVENUE()` |
| `limits.maxRatePpm` | int | The allowance ceiling (2000 = 0.20% a day). | view `MAX_RATE_PPM()` |
| `limits.checkInWindowUnits` | int | The check-in window in units (2). | view `CHECK_IN_MULT()` |
| `limits.windDownUnits` | int | Quiet units after which anyone may wind down (26). | view `WIND_MULT()` |
| `limits.cliffUnits`, `vestUnits` | int | Vesting cliff and length in units of active time (13 and 104). | views `Vester.CLIFF_MULT()`, `VEST_MULT()` |
| `limits.minGrant` | amount (18 dec) | The smallest grant: one whole Team Share. | view `Vester.MIN_GRANT()` |
| `limits.maxGrantsPerMember` | int | Grants one member can ever get (8). | view `Vester.MAX_GRANTS_PER_MEMBER()` |
| `limits.agentUsdPerDay`, `agentTeamPerDay` | amount | The default daily limits a new agent gets. | views `Treasury.agentUsd()`, `agentTeam()` |
| `totals.joined` | amount | Everything ever paid in to Back, fee included. | event `Joined.paid`, summed |
| `totals.fees` | amount | The platform fee on those (collected or owed). | event `Joined.fee`, summed |
| `totals.tookOut` | amount | Everything ever paid out to Take out, backers and Team Shares. | events `Left.cash`, `TeamLeft.cash`, summed |
| `totals.drawn` | amount | Everything ever drawn from the allowance. | event `AllowanceDrawn.amount`, summed |
| `totals.outside` | amount | Everything ever paid in from outside. | event `RevenueAdded.amount`, summed |
| `totals.paidToWorkers` | amount | Everything paid to workers for tasks (step 2). | event `TaskResolved.pay`, summed |
| `totals.noteClaims` | amount | Everything paid out for claimed exit notes (step 2). | event `NoteClaimed.paid`, summed |
| `firstBackedAt` | int or null | The time of the project's first `Joined` (every join has money in it, the minimum is 1 dollar); null before. The AI manager's "free while the founder posts weekly" gate and the hosted allowance start from it (L6). | event `Joined`, the first |

The totals obey one identity, which the example test checks: `joined + outside = fees + tookOut + drawn + paidToWorkers +
noteClaims + pot + box + arriving + locked + notesOwed` (a worker's payment leaves through `TaskMoney` kind 2 and a claimed note
through kind 6; neither is in `drawn`; the dust of a last note goes to the pot).

### 2.11 Holders (the lists as version 1 carried them)

| Field | Type | Meaning | From |
|---|---|---|---|
| `holders` | array | Accounts that hold backer Shares or Team Shares in hand, biggest backer Shares first (then Team Shares, then address), at most 200. | events `Transfer` of the two tokens |
| `holders[].account` | address | The holder. | |
| `holders[].shares` | amount (18 dec) | Backer Shares in hand. | |
| `holders[].teamShares` | amount (18 dec) | Team Shares in hand (claimed). The Vester's own stock is not listed. | |
| `holderCount` | int | Accounts holding backer Shares (the full count, also when the list is cut). | |
| `teamHolderCount` | int | Accounts holding Team Shares. | |
| `truncated` | bool | True when a list was cut at its cap (holders 200, grants 200, agents 50). "None" is never said about a cut list. | |

Left out of the lists: the zero address, the Treasury, the Vester, the two tokens, the dollar and the Launcher (Shares sent there are
stuck, nobody holds them). A server keeps a running balance per account **per token** (the existing `chain_balances` table has no
token column: it needs one), and checks that the sum of all balances equals each token's `totalSupply()`.

### 2.12 The ledger (for checks only)

`ledger.{lastSettle, pot, box, arriving, arrivalEnd, arrivalStart, arrivalTotal, activeSeconds, locked, notesOwed}` are the stored
numbers at `asOf.block` as of the last time anyone settled, from which section 3 works the figures above forward
(`arrivalStart` is a time and `arrivalTotal` an amount; both stay at their old values when `arriving` is `"0"`; `locked` is the
stored figure, before what ran out is returned). They are what the events rebuild exactly (section 4). **The app
must not show or read them**: they are older than the figures and would mislead. They exist so a test can redo section 3 from the
record alone. `ledger.arrivalEnd` is null when `ledger.arriving` is `"0"`.

### 2.13 Per-holder positions: read from the chain, not from the record (S1)

"Your Shares and what taking out gives now" is **never read from the record**. The Take-out sheet and the "you hold" line read, at
the moment they open, from the chain: `shares.balanceOf(me)`, `team.balanceOf(me)`, `Vester.idsOf(me)` with `claimable(id)` and
`vestedOf(id)`, and then `quoteTakeOut(me, n)`. Reasons:

1. **The record's list is cut at 200** (and a cut list says nothing about a holder). A busy project would show some people no position.
2. **The record is minutes old and a transfer moves Shares at once.** A figure on a money screen must be the one the press will use.
3. **Taking out is the one exit and must not depend on the server.** With the record missing, late or wrong, Take out still works:
   a guard that hides the only recovery affordance is a defect (Review-Proven Rule 6).
4. **One person has several addresses** (the wallet and the passkey account); the sheet reads each from the chain.

The record's `holders` list is used for two things only: the count ("N backers") and a *hint* on lists (Home's "you back this"),
listed holders being shown first. When `truncated` is true and the person is not listed, the hint says nothing; the project page
confirms with a chain read when it opens. If the chain read fails, the sheet says so and offers to try again; it never falls back to
the record's list.

## 3. The settled snapshot (the one place the server repeats a contract formula) (S2)

`Treasury.pot()`, `box()`, `arriving()` and `activeSeconds()` are the numbers **as of the last settle**, not as of now: the allowance
and the arriving money move inside every action, so between actions the stored pot is too high by the allowance not yet moved and too
low by money not yet released (by as much as the outside money still arriving). There is **no view** that returns
the settled pot (the contracts only have it in a private function). The record needs it, so until the Treasury has one (section 9,
item 1) the server works it forward from the stored numbers, **exactly** as `Treasury._settled()` does, in integers (`mulDiv` is
`a * b / c`, rounded down):

```
t      = asOf.time
last   = lastSettle()                       end  = activeEnd()                  (0 once wound down)
upto   = min(t, end)                        dt   = upto > last ? upto - last : 0
cap    = mulDiv(pot + box, rate * 7, 1e6)               (rate = ratePpm())
if dt != 0 and rate != 0:  toBox = mulDiv(pot, rate * dt, 1e6 * (unit / 7));  box += toBox;  pot -= toBox
if box > cap:              pot += box - cap;  box = cap
if arriving != 0:          target   = t >= arrivalEnd() ? arrivalTotal() : mulDiv(arrivalTotal(), t - arrivalStart(), arrivalEnd() - arrivalStart())
                           released = max(target - (arrivalTotal() - arriving), 0)
                           arriving -= released;  pot += released
dueC   = book.dueC(t)                       (the stayers' claims of taken tasks whose deadline is <= t; 0 with no book)
pot   += dueC;  locked = locked() - dueC    (tasks that ran out come back LAST, after the allowance and the release)
active = activeSeconds() + dt
```

(`pot`, `box`, `arriving`, `locked`, `activeSeconds()` and the stream's `arrivalStart()`, `arrivalTotal()`, `arrivalEnd()` on the right
are the stored views at `asOf.block`.) The results are `money.pot`, `allowance.box`, `money.arriving`, `money.locked` and
`clock.activeSeconds`. Step 2 changed two things here. **Outside money arrives on its own stream**: `addRevenue` stores
`arrivalStart` (the block time) and `arrivalTotal` (what had not arrived plus the new money), and what has been released is one
rounding of one formula on those two, so settling every second gives what settling once gives (the step 1 formula,
`mulDiv(arriving, t - last, end - last)`, did not). **Tasks that ran out come back last**: the returned money is not charged
allowance for time it was not in the pot.

**Check on every build, no exceptions:** the worked-forward values (the final `pot` and `box`, after the release) must satisfy
`mulDiv(pot + box, rate * 7, 1e6) == boxCap()` (with the final pot, the returned claims included; the clamp above uses the pot before them,
as the contract does) and `active == activeNow()`. If either differs the record is **not published** (section 4.3). Both views are the contract's own
settled numbers, so a formula slip, a changed contract or a mis-set time cannot pass. `boxCap` is a floor division on the sum, though, and it is
zero at a rate of zero, so two more exact checks run on every build: the worked-forward `locked` and `arriving` must equal the two settled lines of
`quoteBack(1 dollar)` (`lockedLine`, `arrivingLine`), the only views that return them. With those two exact, the settled pot and box together are
exact too (they differ from the stored ones only by what arrived and what ran out). (The two money views `leaveValue()` and
`teamValue()` are also checked, by the example test (section 7.3), not on every build.)

When the Treasury gains a `snapshot()` view that returns the settled `(pot, box, arriving, active)`, the server reads it, deletes this
section's code, and the record does not change.

## 4. What the server reads

### 4.1 Events

Four addresses per project (Treasury, Shares, Team Shares, Vester) plus the one Launcher. Every state change carries the resulting
state, so a reader rebuilds without redoing the math; `contracts/pot/test/EventsRebuild.t.sol` is the executable recipe (a ledger
built from these events alone equals the contracts after each of 400 random steps). Fields are in event order; indexed fields are
topics.

**Launcher**

| Event | Fields | What it updates |
|---|---|---|
| `ProjectLaunched` | indexed `key`, `projectId`, `founder`; `Project{founder, shares, team, treasury, vester, launchedAt}`, `Terms{ratePpm, teamPool}`, `Platform{quote, platform, feeBps, unit, agentUsd}` | Creates the project row: identity, `contracts`, `launchedAt`, `team.pool`, the first rate, `runner = founder`, G = `teamPool`, door on, `lastCheckIn = lastSettle = launchedAt`. |
| `PairMade` | indexed `key`, `pair`; `first`, `second` | `contracts.pair` (the first one), `runner.signers` while that Pair is the runner. |
| `WoundDown` | indexed `key`, `runner` | Nothing: the Treasury's own `WoundDown` is the authority. |
| `SettingsChanged`, `AdminChanged`, `AdminOffered` | | Nothing: they change projects launched later only. |

**Treasury** (the project's)

| Event | Fields | What it updates |
|---|---|---|
| `Joined` | indexed `who` (the payer), `to`; `paid, fee, shares, credit, potAfter, paidInAfter, sharesAfter` | Ledger pot, paid-in, B; `feesOwed += fee`; `totals.joined`, `totals.fees`; `firstBackedAt` (the first one); manager gate and fee sums (L6). |
| `Left` | indexed `who`, `to`; `shares, cash, note, potAfter, paidInAfter, sharesAfter` | Ledger pot, paid-in, B; `totals.tookOut += cash`. |
| `TeamLeft` | indexed `who`, `to`; `shares, cash, note, potAfter, teamAfter` | Ledger pot, G; `totals.tookOut += cash`. |
| `AllowanceDrawn` | indexed `by`, `to`; `amount, boxAfter` | Ledger box; `totals.drawn`; `drawnLastDay`. |
| `Settled` | `toBox, backToPot, released, potAfter, boxAfter, arrivingAfter, activeSecondsAfter, time` | Ledger pot, box, arriving, active seconds, `lastSettle = time`. Emitted by any action that moved time or money. |
| `RateProposed` | `ppm, applicableAt` | `allowance.pending` (a new one replaces the old). |
| `RateSet` | `ppm, previousPpm, raised` | `allowance.ratePpm`; clears `pending`. |
| `CheckedIn` | indexed `by`; `recordHash, time` | `clock.lastCheckIn`, `clock.lastRecordHash`. |
| `RevenueAdded` | indexed `from`; `amount, arrivingAfter, arrivalEnd` | Ledger arriving and its end; `totals.outside`. |
| `RevenueReleased` | `amount, arrivingAfter` | Ledger arriving. |
| `DoorSet` | `open` | `door.switchOn`. |
| `WoundDown` | indexed `by`; `kind, time, boxReturned` | `windDown`; ledger `pot += boxReturned`, box 0 (it follows a `Settled`). |
| `FeesCollected` | indexed `to`; `amount` | `feesOwed -= amount`. |
| `RunnerChanged` | indexed `from`, `to` | `runner.address`; agents set before are off (see `AgentSet` below). |
| `SeatOffered` | indexed `by`, `next`; `founderLeaves` | Nothing in step 1 (the app reads an offer from the chain). |
| `AgentSet` | indexed `agent`; `active, usdCap, shareCap` | The list of agent addresses (the values come from views: a hand-over switches agents off with no event). |
| `BurnAnnounced` | `amount, zAfter` | Ledger Z. |

**Vester**

| Event | Fields | What it updates |
|---|---|---|
| `GrantMade` | indexed `id`, `member`; `amount, startActive, kind` | A grant row: `granted`, `startActive`, `kind` (0 normal, 1 protected). |
| `ForfeitAnnounced` | indexed `id`, `member`; `amount, byMember, burnAt, zAfter` | `forfeit.byMember`; ledger Z. |
| `Forfeited` | indexed `id`, `member`; `burned, zAfter, teamAfter` | Ledger Z and G. |
| `GrantClaimed` | indexed `id`, `member`; `amount` | Nothing the record needs (claimed comes from the view). |
| `UngrantedBurned` | `amount, teamAfter` | Ledger G. |

**Tokens** (Shares and Team Shares, each its own role): `Transfer(indexed from, indexed to, value)` updates a per-token,
per-account balance; a mint is from the zero address and a burn is to it. `Approval` is not read.

**Not read in step 1:** the Pair's `Proposed`, `Executed`, `Cancelled` (the app reads waiting calls from the chain as it does today)
and the dollar's `Faucet`, `Transfer`, `Approval`.

### 4.2 Views (all at `asOf.block`)

Treasury: `pot`, `paidIn`, `box`, `arriving`, `arrivalEnd`, `feesOwed`, `locked`, `notesOwed`, `ratePpm`, `pendingRatePpm`,
`pendingAt`, `lastSettle`, `lastCheckIn`, `activeSeconds`, `activeEnd`, `activeNow`, `doorFlag`, `doorOpenNow`, `windDownKind`,
`windDownAt`, `Z`, `runner`, `unit`, `feeBps`, `boxCap`, `leaveValue`, `teamValue`, `agentUsd`, `agentTeam`, `agentEpoch`,
`agentEpochOf`, `agents`, `agentUsdUsed`, `agentTeamUsed`, and the constants `MIN_JOIN`, `MIN_REVENUE`, `MAX_RATE_PPM`,
`CHECK_IN_MULT`, `WIND_MULT`, and (step 2) `arrivalStart`, `arrivalTotal`, `nextExpiry`, `tasks`. Task book (when the project has
one): `openCount`, `nextSerial`, `windowSumBps`, `takeRoomBps`, `dueC(asOf.time)`, `noticeFor(1)`, the constants `MAX_OPEN`,
`MAX_SHARE_BPS`, `CAP_BPS`, `MIN_TASK`, `CAP_WINDOW_MULT`, and for each listed row `taskOf(serial)` (a 17-word struct whose field
order is read from the contracts build, never typed), `noteOf(serial, holder)` for each listed note holder and `claimableNote`
for the largest holder of each row with notes (a second batch at the same block: the cut needs `CAP_WINDOW_MULT`). Vester: `grantCount`, `grantOf`, `vestedOf`, `committed`, and the constants `CLIFF_MULT`, `VEST_MULT`,
`MIN_GRANT`, `MAX_GRANTS_PER_MEMBER`, `PROTECTED_LENGTH`. Tokens: `totalSupply`, `balanceOf(vester)`. Dollar: `balanceOf(treasury)`.
Launcher: `testNetwork`, `isPair`. Pair: `first`, `second`. These are about 45 calls plus 3 per grant and 5 per agent; send them as
one JSON-RPC batch at the one block number. If the node cannot serve that block, **the record is not built** (never fall back to a
later block).

### 4.3 Which wins when they disagree

1. **A number a view returns comes from the view**, called at `asOf.block`. The server never computes it. The numbers the contracts
   expose as views (`unit`, fees, minimums, ceilings, cliff and vest length, windows, `boxCap`, `leaveValue`, `teamValue`, the
   agents' limits) are read, never copied into the server or the app (L5).
2. **A number with no view comes from the events:** the lists, the histories, the sums in `totals`, `firstBackedAt`,
   `lastRecordHash`, `byMember`, `granted`, the agent addresses, the holders' balances.
3. **Cross-checks, on every build.** The ledger rebuilt from the events must equal the stored views at `asOf.block`: `pot`, `paidIn`,
   `box`, `arriving`, `feesOwed`, `Z`, `activeSeconds`, B (`shares.totalSupply()`) and G (`team.totalSupply()`), and the ledger's `lastSettle` must not be later than the view's (a settle that moves nothing emits no `Settled`, so the events can only lag it; the record carries the view's `lastSettle`). The two
   tokens' summed balances must equal their `totalSupply()`. The Vester's Team balance from `Transfer`s must equal
   `team.balanceOf(vester)`. And the settled snapshot must match `boxCap()`, `activeNow()`, and `quoteBack`'s `lockedLine` and `arrivingLine` exactly (section 3).
4. **If any cross-check fails, the views are right and the record is not published.** The previous record stays, the server logs an
   error that names each field and both values, and tries again on the next pass. A stuck project shows its age to the app
   (section 6) and Take out keeps working, because it never depended on the record. A server never publishes a number it could not
   check, and never turns a failed read into an empty or zero result.

## 5. What the app asks the chain, and when

The record is for **lists and pages**. A **sheet shows only numbers read from the chain at the moment it opens** (and again whenever
the amount changes). It may add record facts that are not money, such as the allowance rate or the date the door shuts.

| Screen | Reads from the chain, at that moment | May use from the record |
|---|---|---|
| Back sheet | `doorOpenNow()`; `quoteBack(amount)` returning `(shares, takeOutNow, lockedLine, arrivingLine)`; `feeFor(amount)`; the dollar's `balanceOf(me)` and `allowance(me, treasury)` | `limits.minJoin`, `allowance.ratePpm` and `pending`, `fee.bps`, `playMoney` |
| Take-out sheet | `shares.balanceOf(me)`; `quoteTakeOut(me, n)` returning `(cashNow, note, arrivingLeftBehind)` | `playMoney` |
| Team take-out | `team.balanceOf(me)`; `Vester.claimable(id)`; `teamValue()` (there is no exact Team quote view, section 9 item 4) | grants' `vested`, `cliff` |
| "You hold" line, Home's position hint | the balances above | `holders` as a hint (section 2.13) |

For Back, `takeOutNow` is the line "what you would get if you took out now", and the Back button sets `minShares` from the quote. For
Take out, `cashNow` sets `minCash`. If the chain read fails the sheet says so and does not guess.

## 6. Freshness: when the app must say a record is old

**The server's promise** (the record's `refreshEverySecs`, R):

- a changed fact (any event in a final block) is signed at the next pass, within about a minute of the block becoming final;
- while the allowance is accruing (`rate > 0`, the pot is above zero and `asOf.time < clock.activeUntil`), `money.arriving` is not
  zero **or any task is open** (`tasks.openCount > 0`: a notice ends, a take window closes, room comes back in the cap, and what a take
  would set aside moves with the pot), a new record at least every **600 seconds** (R = 600);
- otherwise at least every **3600 seconds** (R = 3600): a heartbeat, so a quiet project is not mistaken for a dead server.

The two numbers are the server's settings (`BUZZ_CHAIN_ACTIVE_REFRESH_SECS`, `BUZZ_CHAIN_REFRESH_SECS`). Each may be set from 5 to
43200 seconds (half a day), and a larger setting is refused when the server starts; the record never promises more than 43200 whatever
the settings say. The app's own rule does not change: it accepts a
record's stated `refreshEverySecs` from 5 to 86400 seconds and calls a record stale once it is older than a day. The server's range ends at
half a day because a server set to a full day would leave every record stale for part of each cycle.

**The app measures `age = now - builtAt`** (an app clock behind the server counts as age 0) and acts on it:

| Age | What the app shows |
|---|---|
| up to `3 x R + 60` seconds | Nothing special: "as of" sits in the Details fold. |
| past that, up to 24 hours | "Numbers as of 14:05" next to every money figure on lists and pages (`asOf.time`, as a time of day, or "yesterday"). The sheets are not affected. |
| over 24 hours | Lists show no money figures. The project page replaces its money block with: "We have not been able to refresh this project's numbers since 18 Nov. Your money is not affected: you can take it out any time." The Take-out entry stays. |

`builtAt` is the age of the server's work; `asOf.time` is what the numbers describe. They differ by the confirmation lag and the pass
interval (about two minutes in the example). On a test chain that has produced no block for a while, `asOf.time` is old and `builtAt`
is not: the numbers are shown "as of" that time and no stricter rule applies (S4).

The record's time-moving numbers (`money.pot`, `allowance.box`, `money.arriving`, `value.*`, `door.openNow`) are never carried
forward by the app: it shows the record's value with its "as of", or reads the chain. The state words (`quiet.state`) are the one
exception, because the three times are fixed between check-ins.

## 7. The example

### 7.1 The file

`docs/next-version/record-v2-example.json`: a complete, valid version 2 record, **the server's own output** for the fixture's project A
(the run `scripts/chain-reader-fixture.py` plays on anvil and `crates/buzz-relay/src/chain_reader/testdata/pot-run.json` holds), built
at the block and time the file's own `asOf` names (the run's clock, not the wall clock; `builtAt` is a little after `asOf.time`). It is not a hand-built
file: the test `the_example_is_what_the_server_writes` builds the record from the run's logs and the real chain's answers and
compares it byte for byte with the file, and running the tests with `UPDATE_EXAMPLE=1` rewrites it. One project on a local chain
(31337) with the real time unit (7 days), play money:

- **two backers** (5,000 and 2,000 play dollars joined; the second took out a tenth of his Shares at day 60, the first a fifth at
  day 77 and a tenth just before the block), and **a late buyer** (on day 88 the first backer gives 2% of its Shares to a third account, which has held them only a short while) and **an account that took everything out at day 97**;
- **a founder grant past its cliff** (2,000,000 Team Shares granted at day 0, claimed in part: `cliff.passed` true, `claimable` above
  zero), **a grant with a forfeit notice running** (a member's own exit: kept part vested and claimable, the rest announced to burn
  in one day) and **a live grant before its cliff** (`cliff.endsAtIfActive` set);
- **outside money arriving**: 3,000 paid in at day 98 and 1,000 merged into the same stream at day 100.5, so `arrivalStart` is the
  second payment's time and `arrivalTotal` what had not arrived plus the new money (`arrivalEnd` is after `asOf.time`);
- **a rate raise waiting** (0.10% to 0.15%), an allowance box not empty, platform fees owed;
- **the task queue** (section 10): nine tasks were planned. The list shows eight, three of them open: task 6 **taken** with a leaver's
  note outstanding, task 7 **in its notice**, task 8 **announced** for a task record that task 2 already planned (`repeatOf: 2`);
  and five ended: task 2 **paid in part** (60%, its leaver's note claimed), task 3 **sent back** (an open task a stranger took), task 4
  **ran out** (returned by someone else's take-out, its note left unclaimed: `claimable` above zero), task 5 **lapsed**, task 9
  **withdrawn**. Task 1, withdrawn on day 20, is older than 28 days with no notes left and is not listed (the cut, section 10).
  `tasks.cap.frees` has two entries and `tasks.next` is the date room comes back in the cap;
- the runner is one person, so `runner.isPair` is false and `contracts.pair` is null. Variants a fixture can make by changing the
  file: a Pair runner (`contracts.pair` = an address, `runner.isPair` true, `runner.signers` = two addresses); a project past 14
  quiet days (`quiet.state` `"quiet"`, `door.openNow` false, `box` stops growing); a wound-down project (below); a project with no
  backers (`holders: []`, `value.leaveValue` `"0"`); a project with no task book (`tasks: null`).

A wound-down project differs only here (everything else keeps its shape):

```json
"windDown": {"kind": 1, "at": 1795000000},
"quiet": {"state": "wound_down", "since": 1795000000, "quietFrom": null, "dormantFrom": null, "windableFrom": null, "next": null},
"clock": {"lastCheckIn": 1794700000, "lastRecordHash": "0x…", "activeUntil": null, "activeSeconds": 9000000},
"door": {"switchOn": true, "openNow": false, "shutsAt": null},
"allowance": {"ratePpm": 1000, "pending": null, "box": "0", "boxCap": "0", "drawnLastDay": "0"}
```

Addresses are the public anvil test addresses (index 0 platform and deployer, 1 founder and runner, 2 and 3 the two backers, 4 and 7
the two members, 5 the outside payer, 6 the agent); the contract addresses are what a fresh local chain gives them, the same as
`scripts/pot-chain-loop.sh` prints. There are no real names, wallets or per-person amounts anywhere in it.

### 7.2 How the numbers were made

By running the real contracts. `scripts/chain-reader-fixture.py` deploys `contracts/pot` with its own deploy script to a fresh anvil
chain (chain id 31337, time unit 604,800), plays two projects with `cast`, each transaction mined at an exact timestamp, and writes
every header, every log and the raw answer of every view call the builder makes at named blocks. Project A is played for 115 days:
a launch, grants, backers, weekly check-ins, draws, outside money twice, a rate raise, an agent, a member's exit, a seat hand-over,
the task queue (section 10), and a wind-down by choice. The example block (`A_example`) is the one right after a leaver's take-out
writes a note against the task that is taken, with one task in its notice and another announced again.

At that block the builder reads the ledger from the events and the views from the (replayed) chain and **asserts while it builds**: the
ledger from the events equals the stored views; the section 3 roll-forward equals `boxCap()` and `activeNow()`; the held identity and the
totals identity hold. The test `the_example_obeys_every_rule_of_section_7_3` then checks the file itself with the contracts' integer
formulas, independent of the builder, and `scripts/chain-reader-fixture.py --check` fails when the run is not the file (the same bytes
every run).

### 7.3 What both tracks must test against the example

Each test reads only `record-v2-example.json` and uses the contracts' integer formulas (`mulDiv(a, b, c) = a * b / c`, rounded
down). This is a check on the file and on the parsers, **not** a place to copy formulas into production code (L5).

1. Types: every amount is a decimal string; addresses and 32-byte values are lower-case `0x`; times are integers; `version` is 2;
   `launchedAt <= asOf.time <= builtAt`.
2. **Roll-forward** (section 3) from `ledger` gives `money.pot`, `allowance.box`, `money.arriving`, `clock.activeSeconds`.
3. `mulDiv(pot + box, ratePpm * 7, 1e6) == allowance.boxCap`.
4. With `a1 = min(pot, paidIn)`: `value.leaveValue == mulDiv(1e18, a1, B) + mulDiv(1e18, pot - a1, B + G)` and
   `value.teamValue == mulDiv(1e18, max(pot - paidIn, 0), B + G)` (B and G are `shares.backers`, `shares.teamCounted`).
5. `money.held == pot + box + arriving + feesOwed + locked + notesOwed`; and
   `totals.joined + totals.outside == totals.fees + totals.tookOut + totals.drawn + totals.paidToWorkers + totals.noteClaims + pot + box + arriving + locked + notesOwed`.
6. `team.inHands + team.inVester == shares.teamCounted`; `team.ungranted == team.inVester - team.promised >= 0`.
7. Not truncated: the holders' `shares` sum to `shares.backers`, their `teamShares` sum to `team.inHands`, and the two counts match.
8. Each grant: `claimable == vested - claimed`; a live grant's `vested` is `0` before the cliff and `mulDiv(keeps, elapsed, vestUnits x unit)`
   after (`elapsed = clock.activeSeconds - startActive`, capped at the length); `cliff.passed`, `cliff.endsAtIfActive` and
   `fullyVestedAtIfActive` follow section 2.9; the sum over grants of `keeps - claimed + forfeit.amount` equals `team.promised`; the
   sum of `forfeit.amount` equals `shares.announcedBurn`.
9. `quiet.quietFrom == clock.activeUntil == clock.lastCheckIn + checkInWindowUnits x unit`;
   `quiet.windableFrom == lastCheckIn + windDownUnits x unit`; `quiet.dormantFrom == lastCheckIn + 13 x unit`; `quiet.state` is the
   word the three times give at `asOf.time`; `door.openNow == (door.switchOn and asOf.time < door.shutsAt)`.
10. `allowance.pending.applicableAt == proposedAt + unit`; `money.arrivalEnd > asOf.time` while `arriving` is not zero.
11. (Step 2) The task queue, section 10: the open rows are the open count, serials are unique, open rows first (serial ascending) then ended
    rows (serial descending); `setAside == stayerClaim + noteFace` while taken; `pay + returned == setAside` when paid; `pay == 0` and
    `returned == setAside` when sent back or run out; every money field `"0"` for announced, withdrawn and lapsed rows; `atMostNow` is
    `min(maxDollars, mulDiv(money.pot, shareBps, 10000))` while an announced task can still be taken and null otherwise; `cap.usedBps` is the
    sum of `capBps` of the takes inside the window, less a taken task past its deadline; `usedBps + roomBps == limits.capBps`; the `frees`
    add up to `usedBps`; `next` is the earliest of the dates after `asOf.time`; `money.locked` is the sum of `stayerClaim` over the taken
    rows that have not run out; `money.notesOwed` is the sum of `noteFace` of open rows and `notesLeft` of ended rows (equal when
    `cut.notesRowsDropped` is `0`, otherwise at least that); a holder's `claimable` is `mulDiv(face, returned, setAside)` for an ended row
    and `0` for an open one, except a taken row past its deadline, where it is the whole `face`; a row's `deadline` is `takenAt + dueSecs`;
    `usedBps` is the sum of `capBps` of the rows taken inside the window (less a taken row past its deadline), and `frees` are those
    takes' `takenAt + capWindowSecs` and `capBps` (equal when nothing was cut: `cut.endedDropped` and `cut.notesRowsDropped` are `0`);
    `nextExpiry` is the least `expiresAt` of the open rows; `repeatOf` of a later live row of the same `what` names an earlier plan.

12. (Step 3) The social keys, section 11: each of `held`, `feed`, `streaks` and `established` is an object or `null`, never `0` or `[]`;
    `held.windows` are `30 x (unit / 7)` and `13 x unit` seconds; `held.rank.bps` and `held.badge.bps` are
    `floor(10000 x shares / shares.backers)`; `held.rank.money` is `mulDiv(held.rank.shares, value.leaveValue, 1e18)`; `held.badge.shares`
    is at most `held.rank.shares`, which is at most `shares.backers`; `held.rank.accounts <= held.countedAccounts <= holderCount`; the feed
    has 48 hours, each `at` a multiple of `feed.bucketSecs` (`unit / 168`) and the last one holds `asOf.time`; every `net.amount` is a
    multiple of `feed.roundTo` and `net.dir` is `even` exactly when it is `"0"`; `feed.items` are newest first, at most 30, all inside the last
    28 days of the unit, and carry a `serial` exactly for the `task_*` kinds; `streaks.updates.weeks <= longest` and `lastAt <= clock.lastCheckIn`;
    `established.reached` is `heldBps >= rule.minHeldBps and accounts >= rule.minAccounts and twoSigners` (and `null` when `held.badge` is);
    `established.rule.heldSecs == held.windows.badgeSecs`. **No address and no per-account figure is in any of the four.**

The **server** also runs the example through its builder's cross-check functions (the section 4.3 rules) in both directions: the
example passes, and a copy with `money.pot` raised by one unit is refused. The **app** parses the example with the new parser, shows
every screen that reads the record from it, and a record with `version` 1 or 3, with a missing required field, or with a bad
address parses to null.

## 8. What is gone from version 1, and what the app must stop reading

Gone for good from the record (they stay in git history; the old stage, round, auction, market, hand-back and earlier-backers
screens go behind the one build flag, L2). With the flag off nothing of them is reachable, and no test depends on a version 1 record
being published.

| Version 1 field | Why it is gone | What read it | Now |
|---|---|---|---|
| `stage`, `eligible`, `now.stage`, `noMarketFrom`, `noMarketAt` | No stages, no market clock | Home, Project page, Team (`TeamTop`, `TeamMoney`), the stage line | `quiet.state` is the only status; the Team screen shows by `runner` |
| `raised`, `averagePrice`, `rounds[]` | No rounds, no target, no cap | Project page, `OpenBacking`, `OpenRounds`, `BackBox`, Home | `money.pot`, `shares.*`, `value.leaveValue` |
| `receipts[]`, `receiptCount`, `now.refunds[]` | No receipts, no refund | `Receipts`, Home, You | The chain (section 2.13) |
| `holders[].held`, `holders[].free` | No held Shares | `MoneyTab`, `AuctionDisclosure` | `holders[].shares`, `holders[].teamShares` |
| `clock.runsUntil`, `clock.paused`, `clock.woundDown`, `now.quietSince` | Replaced | `WeekPage` (`ClockLine`), Team | `clock.activeUntil`, `windDown`, `quiet.since` |
| `contracts.rounds`, `contracts.finisher` | The contracts are not built | Anything that sent to them | gone; `contracts.team`, `contracts.dollar` are new |
| `treasury.*` sums (`saleSettled`, `spent`, `teamPaid`, `teamBudgetLeft`, `sharesGiven`, `stakeGranted`, `handedBack*`, `toppedUp`, `shareRevenue`, `floorReleased`, …) | Their events are gone | `MoneyTab`, `TeamMoney` | `totals.*`, `allowance.drawnLastDay` |
| `treasury.runner` | Moved | `isRunner`, Tasks (`payRoute`), Team | `runner.address` |
| `sale`, `reserveSales`, `bids`, `pool`, `earlierBackers`, `projectZero`, and the Pair read through `market.pair` | No auction or market; the earlier block is parked (L1) | `numbers-market.ts`, `MarketTop`, `MarketMoney`, `AuctionDisclosure`, `use-earlier`, `PairCard`, `usePair` | `contracts.pair`, `runner.isPair`, `runner.signers` |

Same names, same meaning (the app keeps reading them): `version` (now 2), `chainId`, `launcher`, `key`, `projectId`, `founder`,
`launchedAt`, `contracts.treasury`, `contracts.shares`, `contracts.vester`, `holderCount`, `truncated`, `asOf`, `clock.lastCheckIn`,
and the `removed` form.

`numbers-market.ts` and `numbers-earlier.ts` have no version 2 counterpart. The new parser is `numbers.ts` for version 2 only
(the old one may be moved behind the flag for its own tests; it is never called with the flag off).

## 9. Open points, awkward things in the contracts, and choices made

**Chosen under the owner's standing go; the owner may overrule:**

- **S1.** A person's position is read from the chain, never the record (section 2.13).
- **S2.** The settled snapshot is worked forward by the server and checked against `boxCap()` and `activeNow()` on every build; no
  record is published when it differs (sections 3 and 4.3).
- **S3.** A failed cross-check blocks the publish rather than publishing with a warning flag.
- **S4.** Freshness: R is 600 s while money moves or a task is open and 3600 s otherwise; the app measures `now - builtAt`, shows "as of" past `3R + 60`
  s and hides money figures past 24 hours (section 6).
- **S5.** "Dormant" is a display state at 13 units: the 13 is a server constant, because the contracts have no number for it.
- **S6.** One merged `holders` list (backer Shares first), cut at 200; grants listed unless finished; agents at 50.
- **S7.** `playMoney` is `Launcher.testNetwork()`, and an unknown value means play money.
- **S8.** The `ledger` block ships in every record, marked for checks only.
- **S10 to S14 (step 3, section 11).** The social keys are each right or `null`, and a failed one never stops the record (unlike the task
  section); the badge's constants (60 percent, 13 units, 10 accounts, two signers) ship in the record; the 30-day and the 91-day windows are
  counted apart (either may be `null`); the feed carries hour buckets and a net rounded to 100, never a per-event row and never volume; the
  streak counts launch-aligned windows (stricter than the contract's rule, on purpose).
- **S9.** `totals` (five sums) and `firstBackedAt` ship now: the first serves the allowance page and the manager's gate, the second
  the manager's gate (L6); both are plain sums of events.

**What the contracts made awkward** (none is a defect in what they do; items 1 and 4 are what I would change):

1. **No view returns the settled pot, box, arriving money or active time.** `pot()`, `box()`, `arriving()` and `activeSeconds()` are
   as of the last settle, and `_settled()` is private. `leaveValue()`, `boxCap()` and `activeNow()` are settled but give only a
   derived number. So the record needs section 3, the one hand-repeated contract formula in the system. A `snapshot()` view
   returning `(pot, box, arriving, activeSeconds)` from `_settled()` would remove it (section 3 says what changes).
2. **Settled views depend on the block's time.** `leaveValue`, `boxCap`, `activeNow` and `doorOpenNow` are right only for the block
   they are called at; the record can say so (`asOf.time`), and the app must not treat them as "now".
3. **`leaveValue()` and `teamValue()` are per whole Share in 6-decimal dollars**, so 4 significant digits at a one-cent Share, and
   fewer as the Share gets cheaper. Fine for a list; a position uses `quoteTakeOut`.
4. **There is no `quoteTeamTakeOut(holder, n)`.** `leaveTeam` pays `teamCash` on the settled pot at the time of the transaction, and
   the app can only estimate with `teamValue()` and guard with `minCash`. A view like `quoteTakeOut` for Team Shares would make that
   sheet as exact as the other.
5. **A hand-over switches every agent off with no event** (`agentEpoch` moves; `AgentSet` is not emitted), so an event-only reader
   would show dead agents as live. The record uses `agents(addr).active` together with `agentEpochOf(addr) == agentEpoch()`.
6. **"Dormant" and the box's 7 days have no contract constant.** `boxCap()` hides the 7; the record carries `boxCap`, so the app
   never needs the 7. Dormant is S5.
7. **A grant's cliff and full-vesting dates are in active time, not wall time.** A date can only be "if the project keeps checking in"
   (`cliff.endsAtIfActive`); the app words it that way.
8. **No view lists grants or agents.** The reader walks `0 .. grantCount()` (3 calls each) and takes agent addresses from `AgentSet`
   logs. Bounded by the caps (200 grants, 50 agents) and sent as one batch.
9. **The Team pool at birth is only in the `ProjectLaunched` event** (`Terms.teamPool`); no view returns it.
10. **`Joined.who` is the payer, not the Share receiver** (`to`); holders therefore come from `Transfer`s, not from `Joined`.

**Not done here, for the tracks:**

- The server's balance table needs a token column (section 2.11) and a new role for the Team token; the Rounds, Finisher, receipts,
  bids, sale and refund-formula code go (L1).
- The record has no tasks, notice, take or notes: step 2 adds `tasks` and fills `money.locked` and `money.notesOwed` (no version
  change; done, section 10).
- The earlier-backers block is parked: version 2 has none (L1).
- The generator and the checker are in the build session's scratch folder only (item 11 below).

11. **The scripts.** `make_example.py` (the generator, about 400 lines) and `check_example.py` (the independent checker, 34 checks)
   were run from the session's scratch folder; they are not in the repository because this track owns only this page and the
   example. If wanted they can be committed beside the contracts' vectors as `contracts/pot/scripts/`; the example can be rebuilt
   byte for byte from them on a fresh anvil.

## 10. Step 2 additions: the task queue and the exit notes (`tasks`)

Additive inside version 2: nothing is removed, renamed or re-meant (`money.locked` and `money.notesOwed` were `"0"` in step 1 and now
carry their values). An older app ignores `tasks`; a step 2 app with no `tasks` (or `null`) shows the step 1 tasks flow and no queue.
The plan these tables come from is `docs/next-version/STEP2-SERVER-APP-PLAN.md` (sections 1.3 to 1.6 and the choices C1 to C37); the
record is the server's, the contracts are the truth. Amounts are decimal strings of dollar units (6 decimals), times unix seconds,
counts and shares JSON integers, addresses and 32-byte values lower-case `0x` text. **`tasks` is `null` for a project with no task
book** (never guessed: the book's address is the Treasury's own `TasksReady` log, section 4.1).

### 10.1 `tasks`

| Field | Type | Meaning |
|---|---|---|
| `tasks.book` | address | The project's task book (checked against the view `Treasury.tasks()`; a difference publishes nothing). |
| `tasks.bookBlock` | int | The block of `TasksReady`: the first block the book can have logs in. The app scans for a person's notes from here. |
| `tasks.nextSerial` | int | The serial the next plan gets. Serials start at 1 and never repeat; a book whose serial passes 2^53 fails the build. |
| `tasks.openCount` | int | Tasks announced or taken, not ended (at most 8). |
| `tasks.nextExpiry` | int or null | The earliest second an open task runs out (the end of a take window, or a deadline); null when none is open. |
| `tasks.limits` | object | `maxOpen` (8), `maxShareBps` (500: the most one task may ask for, in ten-thousandths of the pot), `capBps` (1000: the most that may be taken in any rolling window), `minTask` (amount), `capWindowSecs` (`CAP_WINDOW_MULT x unit`), `takeWindowSecs` (how long a task can be taken after its notice), `dueSecs` (how long after a take it is due). All read from the book's views. |
| `tasks.cap` | object | The 28-day cap **settled at `asOf.time`**: `usedBps` (the takes counted in the window now, in ten-thousandths of the pot at each take, less the share the next settle gives back for a taken task past its deadline), `roomBps` (`limits.capBps - usedBps`), `frees` (at most 16 `{at, bps}`, oldest first: when each counted take stops counting, `at = takenAt + capWindowSecs`; they add up to `usedBps`). |
| `tasks.next` | `{at, kind, serial}` or null | The next date something can happen, strictly after `asOf.time`: `kind` is `can_be_taken` (an announced task's notice ends), `lapses` (its take window ends), `due` (a taken task's deadline) or `cap_room` (the first `frees.at`, serial 0). Ties go in that order, then the lowest serial. |
| `tasks.list` | array | The rows (10.2): open tasks first (serial ascending), then ended ones (serial descending); at most 8 open and 32 ended. |
| `tasks.cut` | object | `{maxEnded: 32, endedWithinSecs, endedDropped, notesRowsDropped}`: the rule that chose the ended rows and how many it left out (10.3). |
| `tasks.truncated` | bool | True when `endedDropped > 0`, `notesRowsDropped > 0` or a row's note list was cut. A cut list never says "none". Separate from the top-level `truncated` (holders, grants, agents) on purpose. |

### 10.2 A task row (`tasks.list[]`)

| Field | Type | Meaning |
|---|---|---|
| `serial` | int | The task's number, never reused. |
| `what` | bytes32 | The hash tied to the team's task record: the record's event id. |
| `payee` | address or null | Who may take it; null when open to anyone. |
| `state` | `announced`, `taken`, `paid`, `rejected`, `returned`, `cancelled` or `lapsed` | Where it is on the network at `asOf.block`. `returned` is a task that ran out or was swept by a wind-down. A taken task whose `deadline <= asOf.time` is still `taken` here until someone settles; the app words it from the dates. |
| `shareBps` | int | The share of the pot it may ask for (1 to 500). |
| `maxDollars` | amount | The most it may set aside. |
| `atMostNow` | amount or null | While an announced task's take window has not ended (`asOf.time < expiresAt`): `min(maxDollars, mulDiv(money.pot, shareBps, 10000))`, the most a take would set aside at this pot once its notice has ended (a take is refused while the notice still runs, but the figure is shown during it so a holder sees what would be set aside); null otherwise. |
| `announcedAt`, `noticeEnd`, `expiresAt` | int | Announce time; the first second it can be taken; the end of the take window while announced, the deadline once taken. |
| `takenBy` | address or null | Who took it, and the only address a payment goes to. |
| `takenAt`, `deadline` | int or null | When taken; when due. |
| `setAside` | amount | L: what the take moved out of the project's money (`"0"` before a take; kept after the end, because notes are paid against it). |
| `stayerClaim` | amount | C: the stayers' claim while taken (`"0"` otherwise). |
| `noteFace` | amount | N: the face of the notes against it (`"0"` when paid in full). |
| `pay` | amount | What the worker was paid (`"0"` unless `paid`). |
| `returned` | amount | What came back when it ended: `setAside - pay`. |
| `notesLeft` | amount | What is still held for the claims of its notes. |
| `capBps` | int | What this take still counts in the cap (the take's share less what was given back; 0 when never taken or when it ended unpaid). |
| `resolvedAt`, `resolvedTx` | int or null, bytes32 or null | When it ended (the block time of the event) and the transaction that ended it. |
| `repeatOf` | int or null | The serial of the earlier plan of the same task record that this row repeats: the lowest-serial row with this `what` in state announced, taken or paid, when it is smaller than this row's serial. Set only for a row that is itself announced, taken or paid (a plan that ended unpaid binds nothing). One rule for the server, the relay and the app. |
| `notes` | object or null | Null when `noteFace` is `"0"` and nothing is held, or when the task was paid in full (its notes are void). Otherwise `{faceTotal, holders: [{account, face, claimable}], holdersCut}`. `faceTotal` is `noteFace`. `claimable` is `"0"` while the task is open (a taken task past its deadline that nobody settled counts as ended: its holders' `claimable` is the whole `face`, as a claim settles first) and `mulDiv(face, returned, setAside)` once it ended. At most 20 holders (largest `face` first, then address), listed for the 8 rows with the most still to claim (`notesLeft`, then newest; an open taken task counts by `noteFace`); the other rows carry `holders: []` and `holdersCut: true` and still have `faceTotal`. |

The rows are a hint for lists and for alerts. A press always reads the chain first (`taskOf(serial)`, `noteOf`, `claimableNote`): the
record is minutes old.

### 10.3 The cut

Open rows are always listed. Ended rows are chosen in this order, stopping at 32: (1) rows with `notesLeft > 0` (money a leaver can still
claim), largest `notesLeft` first then newest, at most 24, **whatever their age**; (2) rows that moved money (paid, rejected, returned) and
ended within `max(capWindowSecs, 28 days)`, newest first; (3) cancelled and lapsed rows within that time, at most 4. The list is then
written newest serial first. `cut.endedDropped` counts the ended rows that were eligible and did not fit; a row that aged out (older than
the window, nothing left to claim) is not counted. `cut.notesRowsDropped` counts rows with notes still to claim that did not fit. A team
that announces and cancels many tasks cannot push a leaver's note out: rows with money to claim rank first, rows that moved nothing last
with a cap of 4. Notes never expire, so this is the one place where the record cannot be the whole answer: the rest is found from the
person's own history of take-outs and by scanning the book from `bookBlock`.

### 10.4 The numbers that changed

`money.pot` and `money.arriving` follow the contract's arrival stream and the return of tasks that ran out (section 3), and
`money.locked` is the settled figure. `refreshEverySecs` is 600 while the allowance accrues, outside money arrives **or any task is open**,
and 3600 otherwise, and never more than 43200 (the ceiling of the server's settings, section 6). `totals` gains `paidToWorkers` and `noteClaims` (section 2.10). `ledger` gains `arrivalStart`, `arrivalTotal`, `locked`
and `notesOwed` (checks only, section 2.12).

### 10.5 What the server checks before it signs (step 2)

Every check below runs on every build, at the one block the record is true for. **Any failure anywhere in the task section fails the
whole build** (C33): nothing is published, the project's previous record stays (so every money field of the project freezes with it,
and the app's age rules say so), and the reader logs the task, the field and both values at error level. A record with the task
section dropped would hide a planned task from holders, which is the worse failure; leaving needs no record.

**The events against the views** (`numbers_tasks.rs`; the view is right):

- `Treasury.tasks()` is the book the `TasksReady` event named; `openCount`, `nextSerial`, `windowSumBps` (read at the block's time),
  `takeRoomBps` (which must equal `capBps` less the window sum), the Treasury's `nextExpiry`, `arrivalStart`, `arrivalTotal` and
  `arrivalEnd` equal what the events rebuild; the open count is at most `MAX_OPEN`.
- **Every listed row, every field of `taskOf`** (17 words, in the order the contracts' build gives): `what`, `payee`, `state`,
  `shareBps`, `ringIdx`, `takenBy`, `announcedAt`, `noticeEnd`, `expiresAt`, `takenAt`, `deadline`, `maxDollars`, `locked` (the amount
  set aside), `stayer`, `noteFace`, `returned`, `notesLeft`. A task one unit off names itself, the field and both values.
- **Every listed holder's note** equals `noteOf(serial, holder)`, and **the largest holder's claim** of each row with notes equals
  `claimableNote` (a taken row past its deadline that nobody settled: the view says `0`, the record says the whole face, as a claim
  settles first).
- **The sums, over every task the ledger holds** (not only the listed rows): the stayers' claims of taken tasks equal `locked()`; the
  note faces of open tasks plus what is left for the notes of ended ones equal `notesOwed()`; for each task the holders' notes add up to
  `noteFace`, while taken `setAside == stayerClaim + noteFace`, and when ended `pay + returned == setAside` (and `pay == 0` unless paid).
- The settled pot and the box still satisfy `boxCap()` and `activeNow()` with the returned claims in the pot (section 3).

**The record against itself** (`validate`, redone from the record alone): the roll-forward from `ledger` and the rows; `money.locked` is
what the running rows hold; the totals identity with `paidToWorkers` and `noteClaims`; open rows are the open count and at most 8, listed
first by serial, then ended rows newest first, no serial twice and every serial below `nextSerial`; each row's shape for its state
(announced, withdrawn and lapsed rows have no take and every money field `"0"`; a taken row has its take, a deadline of `takenAt +
dueSecs` and `setAside == stayerClaim + noteFace`; an ended row after a take has `pay + returned == setAside`); `atMostNow`;
`notes` present exactly when something is held, `faceTotal == noteFace`, holders largest first, their claims; `money.notesOwed` against
the rows; `cap.usedBps + cap.roomBps == limits.capBps`, the `frees` ascending and adding up to `usedBps`, and both equal to the takes of the
listed rows still in the window; `nextExpiry`; `next` (redone from the rows); `cut.endedWithinSecs`, at most 24 ended rows with notes and 4
that moved nothing, no ended row older than the cut keeps unless it has notes, and `truncated` exactly when the cut left something out;
`repeatOf` smaller than the row's serial and set on every later live row of the same `what`.

**What a build costs the node** (one project, at the one block): 51 view calls for the Treasury, the Vester and the tokens, the book's
twelve (`tasks()`, `openCount`, `nextSerial`, `windowSumBps`, `takeRoomBps`, `dueC`, `noticeFor(1)` and the five constants), three per
unfinished grant and four per agent account (as in step 1), plus one `taskOf` per listed row (at most 40), one `noteOf` per listed note
holder (at most 160) and one `claimableNote` per row with notes (at most 8). The
rows and holders are read in a second batch at the same block, because the cut needs the cap's window, which is a view. The reader's own
pass is not constant (it reads a project's stored rows each pass, as for Joined and Left); a pass that takes longer than half the shortest
refresh time logs an error.

## 11. Step 3 additions: how long money has stayed, the feed, the streak and the badge (`held`, `feed`, `streaks`, `established`)

Additive inside version 2: no field is removed, renamed or re-meant, so the version stays 2. Four new keys at the top level, **always present
as keys**. A key the server could not work out is **`null`** ("not known here"), never `0` and never `[]`; a failure of one of them (a database
error, a window over its cap, a failed check of its own) signs that key as `null`, logs one error line naming the project, the key and the
reason, and signs the rest of the record as usual. They are display only: no screen unlocks a power from them and no money rule reads them.
The plan these tables come from is `docs/next-version/STEP3-PLAN.md` (section 2 and the choices C11 to C17, C43); amounts are decimal strings,
times unix seconds. **No address and no per-account figure is in any of them** (the feed and the picture round and aggregate); a person's own
weeks held are worked out on their own device and are not in the record.

### 11.1 `held`: how long money has stayed

The lowest balance each account had at any moment of a window, summed over accounts: Shares that were held **without a fall** for the whole
window. Moving Shares between accounts cannot raise it (the sender's lowest balance falls by what the receiver's starts from); selling and
buying back lowers it. A window is the last `windows.*Secs` seconds up to `asOf.time`; a change counts as inside it when its block's time is
later than the window's start.

| Field | Meaning |
|---|---|
| `windows.rankSecs` | `30 x (unit / 7)`: the ranking window (30 days) |
| `windows.badgeSecs` | `13 x unit`: the badge window (the design's 13N) |
| `rank` | `null` when this window could not be counted; else the object below |
| `rank.shares` | backer Shares held without a fall for `rankSecs` (18 decimals) |
| `rank.bps` | `floor(10000 x rank.shares / shares.backers)` |
| `rank.money` | what `rank.shares` would get at `value.leaveValue` (6 decimals): `mulDiv(rank.shares, value.leaveValue, 1e18)`; for lists and words, never for a sheet |
| `rank.accounts` | accounts whose lowest balance is worth at least `limits.minJoin` at `value.leaveValue` |
| `badge` | `null` when this window could not be counted; else `{shares, bps}` as above for `badgeSecs` |
| `countedAccounts` | accounts that hold **now** at least `limits.minJoin` at `value.leaveValue` (never cut at 200 like `holders`) |

The accounts nobody holds for are left out (the zero address, the Treasury, the Vester, the two tokens, the dollar and the Launcher), the same
list `holders` leaves out. **The bound:** a window is counted by the database from this project's balance changes inside it, at most
`500000` rows and `20000` accounts; a window over either is `null`, never a smaller number (the two windows are counted apart).

**The floor.** Only accounts that hold **now** at least the fewest Shares a smallest Back buys at `value.leaveValue` (`ceil(limits.minJoin x 1e18 /
value.leaveValue)`) are counted: an account below it is not worth a Back, is not in `rank.accounts`, and is left out of the `20000` accounts, of
the result and of the sums (the sums fall short of it by less than one smallest Back for each such account). Without it one person holding a few
Shares could send one wei to 20,001 fresh addresses and cut a rival's windows for a month; with it, making a window `null` by accounts costs 20,001
smallest Backs held at the end. What still cuts a window is the `500000` rows (one sender moving 250,000 times, each move gas on the chain): the
cut is stated by the `null`, never hidden, and what is lost is a ranking row or a badge, both display only.

### 11.2 `established`: the badge

| Field | Meaning |
|---|---|
| `rule.minHeldBps` | 6000: at least 60 percent of the money held for the badge window |
| `rule.heldSecs` | equals `held.windows.badgeSecs` |
| `rule.minAccounts` | 10 |
| `heldBps` | `held.badge.bps`; `null` when `held.badge` is |
| `accounts` | `held.countedAccounts`; `null` when `held` is |
| `twoSigners` | the runner is a Pair with two different non-zero signers |
| `reached` | `heldBps >= rule.minHeldBps and accounts >= rule.minAccounts and twoSigners`; `null` when `heldBps` is |

The thresholds are server constants (the contracts have no number for them) and ship in the record, so an app reads and does not copy them.

The badge is the design's own rule and it can be made with money (design 2.6): the money check is over the badge window, the head count is of accounts
that hold **now** the smallest Back. Nine accounts that backed yesterday with the smallest Back each, beside one old holder, make the head count; what
it costs is those nine Backs and the fee on them. Counting only accounts that held for the whole window would need a new field of `held.badge` and a
change to the app's words, and is left open (the review's optional finding, declined in the step 3 review fixes).

### 11.3 `feed`: joins and take-outs by the hour, and what else happened

| Field | Meaning |
|---|---|
| `roundTo` | the rounding step, 100 dollars (6 decimals) |
| `bucketSecs` | `unit / 168`: one hour on a 7-day unit, a proportionally short one on a test network |
| `hours[]` | the last 48 hours ending at the one that holds `asOf.time`, oldest first, **every hour present** (a quiet hour is a zero bucket) |
| `hours[].at` | the hour's first second |
| `hours[].joins` | backs in it (**events, not accounts**: one account that backs twice in an hour is two, as the chain shows it) |
| `hours[].tookOut` | take-outs in it (a Team Share take-out counts the same: equal weight) |
| `hours[].net` | `{dir, amount}`: the absolute net money in, `Sum(Joined.paid - Joined.fee) - Sum(Left.cash + TeamLeft.cash)`, **rounded half up to `roundTo` once per hour** (never per event); `dir` is `in`, `out` or `even` (exactly when `amount` is `"0"`) |
| `items[]` | up to 30 things that are not money flows, newest first, inside the last `28 x (unit / 7)` seconds |
| `items[].kind` | `task_planned`, `task_taken`, `task_paid`, `task_ended` (sent back, lapsed or ran out), `task_withdrawn`, `update` (a check-in) |
| `items[].at` | the block's time |
| `items[].serial` | the task's number for the `task_*` kinds, else `null` |
| `items[].date` | for `task_planned` the end of the notice; for `task_taken` the deadline; else `null` |
| `cut` | how many items inside the window were left out because of the 30 |

**Volume is not published:** no hour carries money in and money out apart, so for an hour with both it cannot be worked out. An hour with
joins and no take-outs has a net equal to its volume to within 50 dollars; the chain is public and shows it already. Rate raises and wind-downs
are not items: the money screens say them.

### 11.4 `streaks`: the project's weeks of updates

`streaks.updates.weeks` is the number of consecutive windows, newest first, that each hold at least one check-in. Windows are one unit long and
**aligned to the launch** (window `k` is `[launchedAt + k x unit, launchedAt + (k + 1) x unit)`), so two passes inside one window give the same
answer. The window that holds `asOf.time` is still open: empty, it is skipped; with a check-in, it counts; the first empty **closed** window ends
the run. It is stricter than the contract's rule (one check-in in two units keeps a project live) on purpose. `longest` is the longest such run in
the project's life; `lastAt` the newest check-in (or `null`).

### 11.5 What the server checks before it signs these keys

Each runs on every build; a failure makes **that key** `null` (above). `held`: `badge.shares <= rank.shares <= shares.backers`;
`rank.accounts <= countedAccounts <= holderCount`; both `bps` and `rank.money` equal their arithmetic; the walk is over rows at or below the
final block. `feed`: 48 hours, aligned, the last holding `asOf.time`; every amount a multiple of `roundTo`; `dir` even exactly when the amount
is `"0"`; at most 30 items, newest first, a `serial` for the `task_*` kinds only; **every hour is counted again from the rows by a second,
separate function** (joins, take-outs and net, and the sum over the window), and so are the items. `streaks`: `weeks <= longest`; `lastAt` is
the newest check-in row. `established`: its inputs are `held`'s, its rule is the server's, `reached` equals the rule. `validate` repeats the
checks that need only the record, so a record whose verdict contradicts its inputs is refused. The four keys are out of the digest of facts
(they move with the clock; each event that changes one already changes a field in it), so they never make the server sign again by themselves.

**What the app shows when a key is absent, wrong or old** is in `STEP3-PLAN.md` section 2.7: a missing or `null` key is "not known here" (no
ranking row, no chip, no feed), never "none" or "0"; the figures hide with the other money figures after 24 hours.

### 11.6 The ranking index (`d = explore`)

One small record per community the server signs next to the project records, so Home reads one record and then the few projects it names.
Kind 39009, tags `d = explore`, `chain`, `launcher`, signed by the relay's key. Content:
`{"version": 1, "kind": "explore", "asOf": {"block", "time"}, "entries": [...], "seen": n, "cut": n}`; an entry is
`{"key", "a", "launchedAt", "windowSecs", "money", "accounts", "reached"}` (`money` is `held.rank.money`, `accounts` is `held.rank.accounts`,
`reached` is `established.reached`, which may be `null`, `a` is `37001:<founder>:<id>`).

- **The rule.** Sorted by `money` (most first), then `accounts` (most first), then `launchedAt` (older first), then `key`. A project with no
  `held.rank` or with `money` zero is not listed. At most **20** entries (about 4 KB); `seen` counts the projects that have money that
  stayed and `cut` those not in the entries, **whatever the reason** (past the 20, no stored record that the launch names, not listed, removed, a
  founder who is banned or muted). **Never the pot, the price of a Share, joins, volume or anything in the feed**: it is money held, valued at what a
  take-out would give now, and it carries no name, address or per-person figure.
- **The tie.** A project is listed only when `ProjectLaunched.projectId` equals the hash of the coordinate of a stored, listed project record
  (kind 37001) that names its chain key: a founder cannot claim another project's key, and nobody's word
  decides who is eligible. The record is looked for **by its key**, one search for each candidate (newest first, in pages of 100, at most 500
  records of that key), never in a window of the community's newest records, so how many records the community holds decides nothing; the rows are
  read best first, a page of 50 at a time, until 20 are kept, 500 rows are looked at or 100 standing checks are used. A project whose founder is banned or muted, whose record was removed or is not listed is left out.
- **The rows.** Five nullable columns of the reader's `chain_project_numbers` row (`rank_money`, `rank_accounts`, `rank_window_secs`, `reached`,
  `launched_at`) are written by the statement that records a signing, all null when the record has no `held.rank`; a row marked stale by a
  rollback is not read.
- **When.** At the end of a publishing pass, looked at no oftener than every 600 s, signed again when the entries differ from the live
  index's and the live one is at least 600 s old, **and when the entries are the same and the live one is 12 hours old** (the app shows no index
  older than a day, so a quiet network keeps its ranking); with nothing to list and no index live, none is signed. A look that listed nothing or
  failed is repeated after 60 s, then 120, 240 and so on up to 600, so the first index is not ten minutes late. A failed build is logged and counted
  (`explore_failed`), the old index stays, and nothing else is affected.
- **The app** checks that the relay's key signed it, hides it past 24 hours, sorts by the same rule itself (it never trusts the order), reads the
  records of the first ten entries by coordinate and drops an entry whose record is missing, unlisted or removed.

## 12. Step 3 additions outside the record: what the server says about phone links, alerts and the sponsored fee

Three things the app reads from the server that are not in a numbers record. Nothing here changes a money field or a contract; the record stays
version 2. The full account of the server side is in `docs/web-push-deployment.md` (for an operator) and `docs/next-version/STEP3-PLAN.md`
section 6 (for the reasons). Rooms and seasons (package P2) are in `docs/next-version/ROOM-AND-SEASON-RECORDS.md`.

### 12.1 Two keys of the information document (`GET /info`, `Accept: application/nostr+json`)

| Key | When present | Meaning |
|---|---|---|
| `webPush` | **Only** when the operator turned web push on (`BUZZ_WEB_PUSH_VAPID_PRIVATE_KEY` and `BUZZ_WEB_PUSH_SUBJECT` both set). Absent otherwise: the app does not draw the opt-in card and never invents a way to switch alerts on. | `{"publicKey": "<base64url, 65 bytes, uncompressed P-256>"}`: the key a browser subscribes with (`applicationServerKey`). Nothing else about push is published. |
| `smartAccountLinks` | Whenever the server has a chain reader. | `true` when the server can check a **phone account's** wallet link (it has `BUZZ_EVM_AUTH` and `BUZZ_EVM_RPC_URL`); `false` otherwise. With `false` a phone account cannot link a wallet, so it cannot write in a room and cannot be alerted: the app says so in plain words before a person tries and draws no button that cannot work. Absent on a server with no chain reader. |

### 12.2 The two subscription paths (HTTP, because a subscription is a bearer capability and must not become a stored, public event)

Both are signed per request with the person's own key (NIP-98: method, address and the body's SHA-256 in a `payload` tag; the same
`Authorization: Nostr <base64 event>` header the app already sends to `/events`), and a request cannot be played twice.

| Call | Body | Answer |
|---|---|---|
| `PUT /push/web` | what a browser's `PushSubscription.toJSON()` gives: `{"endpoint": "...", "keys": {"p256dh": "<base64url>", "auth": "<base64url>"}}` | `200 {"ok": true}`: the device is kept for the signer's account (or renewed when the account already has that address; the oldest of more than five goes). |
| `DELETE /push/web` | `{"endpoint": "..."}` removes that device; **no body** removes every device of the account | `200 {"ok": true, "removed": n}` |

Answers: `404 {"error": "Alerts are not switched on for this server."}` when push is off (and nothing is read or written); `401` for an unsigned or
replayed request; `400 {"error": "<a sentence for the person>"}` for an address that is not allowed, a key that is not a point on the curve or a
secret that is not 16 bytes (nothing is written); `413` for a body over 4,096 bytes; `429` after 10 requests an hour for one account. A person
**turns alerts off** with `DELETE /push/web` and the browser's own `unsubscribe()`; what the server kept for the device is deleted at once. A
subscription is good for 90 days; the app asks again when a device is opened and the row is older than 30 days (a `PUT` of the same address
renews it).

### 12.3 What a push carries (the service worker reads exactly this)

After decryption the message is `{"v": 1, "k": "planned" | "taken" | "ended", "r": "<project link ref>"}`, at most 200 bytes. `r` is the part of the
project's link after `/p/`. **No amount, no name, no date and no project name**, ever. A worker shows one of three fixed sentences by `k`, opens
the news page when pressed, and drops a message of any other shape without showing anything. An alert is made only from the chain's own task rows
(planned, taken, ended; a plan withdrawn before anyone took it makes none, and neither does its withdrawal) and goes only to an account that proved the wallet that holds Shares in
the project (at least 0.001 of a Share, backer Shares or Team Shares); a person with no linked wallet gets none and is told why in the opt-in.

### 12.4 The sponsored fee (`POST /sponsor`, when the operator sets it up)

A phone account's network fee is asked for with the JSON-RPC call `zd_sponsorUserOperation`. When the operator names an upstream sponsor the
server answers the same call at `POST /sponsor` (the app's `VITE_CREATON_SPONSOR_URL` then names that path; it carries no key) and limits it: per
sender (10), per client address (40) and for the whole server (1,000) per UTC day for ordinary operations; **a take out (`leave`, `leaveTeam`) is
never refused by the per-account or the server limit and never counted against them**, only by one generous per-address cap (200). A refusal is a
JSON-RPC error answered with HTTP 200 whose message is `daily limit exceeded` (a limit) or `not allowed` (a method, a chain, a batch, a body over
32 KB, call data that cannot be read, or a target that is not a contract the server follows), both of which hold a word the app turns into plain
words (`exceed`, `not allowed`). Said plainly, one limit stays: because the `sender` in the request is not authenticated, ten requests naming a
victim's address use up that person's day for a Back and the like (not for taking out).
