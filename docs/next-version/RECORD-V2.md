# Record version 2: the project numbers (kind 39009)

The one specification the server and the app both build against for step 1 of `docs/next-version/JOIN-LEAVE-DESIGN.md`. The server
(`crates/buzz-relay/src/chain_reader`) writes this record; the app (`app/src/features/money/numbers.ts` and everything that reads
it) reads it. The contracts are `contracts/pot`; their events and views are listed in `docs/next-version/POT-STEP1A-REPORT.md`
sections 7 and "Review fixes". **The contracts are the truth.** Where this page and a contract disagree, the contract is right and
this page is wrong: report it.

One complete, valid example is `docs/next-version/record-v2-example.json`. Both tracks test against that one file (section 7), so
they cannot drift apart. It was made by running the real contracts, not by hand (section 7.2).

Status: a specification. Nothing here is built yet. Choices the design left open are marked **(S#)** and collected in section 9; the
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
| `refreshEverySecs` | int | How often the server promises to sign a fresh record for this project: 600 while the allowance is accruing or outside money is arriving, otherwise 3600 (section 6). | server rule |

### 2.3 The project's money (all dollar amounts, 6 decimals)

| Field | Type | Meaning | From |
|---|---|---|---|
| `money.pot` | amount | What taking out can reach now: the project's money. | **settled** (section 3), checked against views |
| `money.paidIn` | amount | What backers put in after the fee and have not taken back (A). | view `paidIn()` |
| `money.arriving` | amount | Outside money that has been paid in and has not yet reached the pot. | **settled** |
| `money.arrivalEnd` | int or null | When the last of it has arrived; null when `arriving` is `"0"`. | view `arrivalEnd()` when `arriving` is not zero |
| `money.feesOwed` | amount | The platform's fee waiting to be collected; not part of the pot. | view `feesOwed()` |
| `money.locked` | amount | Money set aside for a taken task. Always `"0"` in step 1. | view `locked()` |
| `money.notesOwed` | amount | Exit notes owed. Always `"0"` in step 1. | view `notesOwed()` |
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
true.

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
| `agents` | array | Accounts the runner set as helpers with daily limits, live ones first, at most 50. | events `AgentSet` (the addresses), then views |
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
| `firstBackedAt` | int or null | The time of the project's first `Joined` (every join has money in it, the minimum is 1 dollar); null before. The AI manager's "free while the founder posts weekly" gate and the hosted allowance start from it (L6). | event `Joined`, the first |

The totals obey one identity, which the example test checks: `joined + outside = fees + tookOut + drawn + pot + box + arriving
+ locked + notesOwed`.

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

`ledger.{lastSettle, pot, box, arriving, arrivalEnd, activeSeconds}` are the stored numbers at `asOf.block` as of the last time
anyone settled, from which section 3 works the figures above forward. They are what the events rebuild exactly (section 4). **The app
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
if arriving != 0:          released = t >= arrivalEnd() ? arriving : mulDiv(arriving, t - last, arrivalEnd() - last)
                           arriving -= released;  pot += released
active = activeSeconds() + dt
```

(`pot`, `box`, `arriving`, `activeSeconds()` on the right are the stored views at `asOf.block`.) The results are `money.pot`,
`allowance.box`, `money.arriving` and `clock.activeSeconds`.

**Check on every build, no exceptions:** the worked-forward values (the final `pot` and `box`, after the release) must satisfy
`mulDiv(pot + box, rate * 7, 1e6) == boxCap()` and `active == activeNow()`. If either differs the record is **not published** (section 4.3). Both views are the contract's own
settled numbers, so a formula slip, a changed contract or a mis-set time cannot pass. (The two money views `leaveValue()` and
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
`CHECK_IN_MULT`, `WIND_MULT`. Vester: `grantCount`, `grantOf`, `vestedOf`, `committed`, and the constants `CLIFF_MULT`, `VEST_MULT`,
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
   `team.balanceOf(vester)`. And the settled snapshot must match `boxCap()` and `activeNow()` (section 3).
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
- while the allowance is accruing (`rate > 0`, the pot is above zero and `asOf.time < clock.activeUntil`) or `money.arriving` is not
  zero, a new record at least every **600 seconds** (R = 600);
- otherwise at least every **3600 seconds** (R = 3600): a heartbeat, so a quiet project is not mistaken for a dead server.

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

`docs/next-version/record-v2-example.json`: a complete, valid version 2 record, as it would be signed at **2026-11-19 12:00:00 UTC**
(block 41, `asOf.time` 1795089600; built 131 seconds later). One project, "Demo Project", on a local chain (31337) with the real
time unit (7 days), play money:

- **two backers** (5,000 and 2,000 play dollars joined; the second took out a tenth of his Shares at day 60);
- **a founder grant past its cliff** (2,000,000 Team Shares granted at day 0, claimed in part: `cliff.passed` true, `claimable` above
  zero), **a grant with a forfeit notice running** (a member's own exit: kept part vested and claimable, the rest announced to burn
  in one day) and **a live grant before its cliff** (`cliff.endsAtIfActive` set);
- **outside money arriving** (3,000 paid in at day 104, 28% arrived so far, the rest by 2026-11-24) and the pot above paid-in,
  so `teamValue` is above zero;
- **a rate raise waiting** (0.10% to 0.15%, applicable from 2026-11-23);
- a live agent that drew 5 play dollars the same day, an allowance box not empty, platform fees owed;
- the runner is one person, so `runner.isPair` is false and `contracts.pair` is null. Variants a fixture can make by changing the
  file: a Pair runner (`contracts.pair` = an address, `runner.isPair` true, `runner.signers` = two addresses); a project past 14
  quiet days (`quiet.state` `"quiet"`, `door.openNow` false, `box` stops growing); a wound-down project (below); a project with no
  backers (`holders: []`, `value.leaveValue` `"0"`).

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

By running the real contracts, not by hand. A scratch copy of `contracts/pot` was deployed with its own deploy script to a fresh
anvil chain (clock set to 2026-08-05 10:00 UTC, chain id 31337, time unit 604,800), then one project was launched and played for 106
days with `cast`, each transaction mined at an exact timestamp:

| Day | What |
|---|---|
| 0 | Launch: rate 1000 ppm (0.10%), Team pool 10,000,000. Day 0 + 1 h: the founder grants himself 2,000,000 Team Shares (grant 0). |
| 0 + 2 h | Backer one backs 5,000 in one signature (`transferAndCall`). Day 1: backer two backs 2,000 (approve, then `join`). |
| 7, 14, … 105 | The founder checks in every week with a different hash. The project is active the whole time (active seconds equal 106 days). |
| 14.5, 35.5, 56.5, 77.5, 98.5 | The runner draws 30 play dollars from the allowance. |
| 20 | Grant 1: 400,000 Team Shares to a member. Day 70: grant 2: 100,000 to another member. |
| 60 | Backer two takes out a tenth of his Shares. |
| 95 | The founder claims what grant 0 has vested. |
| 100 | The first member announces his own exit from grant 1 (keeps what has accrued, the rest burns after a unit). |
| 103 | The runner proposes the rate 0.15%. |
| 104 | An outsider pays in 3,000 play dollars (approve, then `addRevenue`). |
| 105 | The founder authorises an agent; the agent draws 5 play dollars about 1.2 h before the record. |
| 106, 12:00 UTC | One empty block is mined at that exact time, and the record is built from it. |

Everything was read at that block and **asserted while it was built**: the ledger from the events equals the stored views; the
section 3 roll-forward equals `boxCap()` and `activeNow()`; the formulas of `PotMath` equal `leaveValue()` and `teamValue()`; every
holder balance sums to the supplies; `held` equals the buckets and the totals identity holds. The whole run was done twice on two
fresh chains and the two files are **byte-for-byte identical**. The generator and an independent checker were scratch scripts and are
not part of the repository (section 9, item 11).

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
   `totals.joined + totals.outside == totals.fees + totals.tookOut + totals.drawn + pot + box + arriving + locked + notesOwed`.
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
- **S4.** Freshness: R is 600 s while money moves and 3600 s otherwise; the app measures `now - builtAt`, shows "as of" past `3R + 60`
  s and hides money figures past 24 hours (section 6).
- **S5.** "Dormant" is a display state at 13 units: the 13 is a server constant, because the contracts have no number for it.
- **S6.** One merged `holders` list (backer Shares first), cut at 200; grants listed unless finished; agents at 50.
- **S7.** `playMoney` is `Launcher.testNetwork()`, and an unknown value means play money.
- **S8.** The `ledger` block ships in every record, marked for checks only.
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
  change).
- The earlier-backers block is parked: version 2 has none (L1).
- The generator and the checker are in the build session's scratch folder only (item 11 below).

11. **The scripts.** `make_example.py` (the generator, about 400 lines) and `check_example.py` (the independent checker, 34 checks)
   were run from the session's scratch folder; they are not in the repository because this track owns only this page and the
   example. If wanted they can be committed beside the contracts' vectors as `contracts/pot/scripts/`; the example can be rebuilt
   byte for byte from them on a fresh anvil.
