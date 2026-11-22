# Council round report: the Council runner, seat elections and the replace vote

Status: **unfinished round, branch `council-wip`, not merged, not deployed, no real network and no real money.** The verified
state of the repository before this round is `v6` at `4c36f73d6`; nothing here goes to `v6` until an independent verifier has
run the plan's full check set and found no blocker (`docs/next-version/COUNCIL-WIP-NOTES.md`). This report is the round's own
account of what was built, what ran, what was measured, what was chosen and what is open. It is not legal or tax advice.

The plan is `docs/next-version/COUNCIL-PLAN.md` (second draft, with both reviews worked in). The packages are K1 (the Council
contract and the Treasury's recognition of it), K2 (seat elections and the replace vote), the attack pass, S1 (the server) and
A1 (the app, the joined-up loop and this report).

---

## 1. What was built

### K1: the Council, a runner like a Pair

One new contract, `contracts/pot/src/Council.sol`: a clone per Council, five seats, **three of five** for every action. It holds
the Treasury's runner seat the way a Pair does — the Treasury's `runner` is the Council contract, and the Council calls the
Treasury only from inside `agree` when the third seat has agreed to exactly that call (`bothSigned()` true only inside it). It
holds no dollars, has no owner, no upgrade, no payable function and no way to move a token or an approval.

- An action is proposed by one seat (which counts as its agreement), runs the moment a third seat agrees, can be taken back by
  an agreeing seat before that, and runs out two time units after it was proposed. The record is deleted before the call runs,
  so it runs once; a call that fails reverts everything (the record included) and stays pending. A generation fence kills every
  older proposal whenever a seat changes. A re-entry guard refuses an agreement made from inside a running call.
- The call list: `draw`, `checkIn`, `proposeRate`, `setRate`, `setDoor`, `announceTask`, `acceptTask`, `rejectTask`,
  `cancelTask`, `grantTeam`, `setAgent`, `authoriseAgent`, `revokeAgent`, `handOver` (only without the founder-leaves flag) and
  `windDown` on the Treasury, and `Launcher.windDown`. **`announceForfeit` and a trimming hand-over are Pair-only** and are
  refused at `propose`; the Treasury asks `isPair` for both, so a Council cannot reach them by another door either (tests
  propose both through a Council and separately drive a kind-2 runner contract that says `bothSigned` true, and the Treasury
  itself refuses).
- Every Treasury limit binds the Council unchanged: the allowance ceiling and box, the task caps and notice, the check-in
  window, the pause. It cannot trim or burn a grant, cannot stop a Take out, cannot make the pause go away.
- Seats: five distinct non-zero accounts at birth; a seat changes only by election, a replace vote, resigning, or the Council
  handing the whole seat on. Three seats cannot remove the other two. An account holds one seat; the zero address is never a
  seat; an open seat is the zero address and comes up first at an election. No seat holder can take a task or be a payee (the
  Treasury asks the runner `isSeat`, as it asks a Pair), and a Council cannot announce a forfeit or mark "founder leaves".
- The Treasury's changes are the smallest hooks: its two runner-seat checks ask the Launcher's `runnerKindOf` (0 none, 1 a Pair,
  2 a Council) instead of `isPair`, and ask a runner contract one question (`isSeat`) where they asked a Pair two; `takeSeat`
  shares one private `_seat` body with a new `seatByVote(council)`, which only the project's pause gate may call and which clears
  the pending offer, the pending rate and the earlier runner's agents. **`announceForfeit`, `_founderAgrees` and `checkIn` keep
  asking `isPair`.**
- The Launcher: `runnerKindOf` replaces the `isPair` mapping (`isPair` becomes a view over it, same selector and answer),
  `bindCouncil(impl)` (deployer, once, first hour, code, pause first, and the pause must answer `isVote()`), `makeCouncil` and
  `councilAddress` (the hand-over path, address commits to the project, the five accounts and the salt), `councilByVote` (the
  vote path, salted by the ballot id in its own address space), and `isProjectAccount` (the project's own contracts and any
  runner contract can never be a seat; a smart account stays allowed). `windDown` asks `runnerKindOf != 0` and `bothSigned`.
  `settingsHash()` gains a fourth form when a Council is bound, with the Council test first, so a founder who read the hash
  before the switch is refused at launch and reads it again.

### K2: the vote, counted in the pause's own custody

One new contract, `contracts/pot/src/HolderVote.sol`, which **is** the pause (`HolderVote is HolderPause`). `HolderPause`
changes by three lines and two empty internal functions (`_beforeChange` in `park` and `unpark`, `_afterUnpark` in `unpark`);
with `via_ir` and `bytecode_hash = none` they compile to nothing: **`HolderPause`'s runtime bytecode is byte-identical to the
code before the round** (hash `0x968400a4…ccdf`, held by a test). On a deployment with `COUNCIL=1` the pause implementation is a
`HolderVote`, so every project launched from then on has a pause that also holds its ballots; the Treasury still asks it
`paused()` and tells it `poke()` exactly as before, and nothing was added to the Treasury for counting.

- **Counting rule (plan 2.2).** A ballot has one snapshot: the second it opened. For each account the contract keeps, in one
  slot, the fewest Shares it had parked at any moment since the snapshot, lazily: `(ballot id << 128) | low`. Parking raises the
  balance but never the fewest; an unpark lowers it and, in the same transaction, lowers any cast weight and its tally. Shares
  parked after opening add nothing; a vote moves with the voter; the hooks stop at `voteEnd`, so the tallies freeze and the
  result stands. There is no history array and no loop over voters.
- **Ballots (plan 2.3-2.6).** A replace vote (whether the runner seat moves to a new Council of five, opened by a parked holder
  with its own list in the same call) and a seat election (the two seats the Council says are due, opened by anyone). One
  ballot at a time. Option 0 is always "keep". A one-day stand window, then three days of voting. Standing needs a thousandth of
  the Shares at the snapshot; at most four lists and twelve people; when the places are full a strictly larger stake takes the
  smallest place and the displaced proposer may not stand again. A list needs **more than half of all Shares cast**, with the
  floor met. A person needs **strictly more than "keep"**, one whole Share, and a place in the top two; a tie for the last seat
  leaves that seat as it is. One floor for both ballots: **a third of the backers' Shares at the snapshot**. Opening a replace
  vote needs the Shares parked in all to be a twentieth of the snapshot and the caller's own weight a thousandth; a cooldown of
  four time units follows only a "kept" result that met the floor.
- **The wait and the result (plan 2.5-2.7).** A won result waits the Treasury's own longest task notice, read at the ballot's
  opening (`noticeFor(500)`: **16.5 days at a 7-day unit**); `effectiveAt` is fixed at opening. Anyone may record the result
  (`finish`), carry it out (`carryOut`, open to any wallet) or let it go when it has lapsed two time units after it was due
  (`lapse`). For a replace vote, `carryOut` makes the Council of the winning five through the Launcher and seats it through the
  Treasury in one transaction (both or nothing); for a seat election it puts the two winners in the two seats (which seat each
  takes is the Council's rule). The server derives the same result from the frozen tallies from `voteEnd` on, so the card and the
  alert show it without anyone pressing anything.
- **The switch (plan 4).** `COUNCIL` is a deploy setting, **off by default**, beside `HOLDER_PAUSE` and requiring it. With it on
  the script deploys a `HolderVote` as the pause implementation and a `Council`, binds both in the same broadcast as the
  Launcher's own deployment, and records `holderVote` in the deployment JSON. With it off nothing differs: no Council can be
  made, `councilImpl()` is zero, the settings hash is each of its three old formulas, and `OffIsOff.t.sol`'s golden journey gives
  the digest it gave at `4c36f73d6` with the constant unedited.

### The attack pass

`HolderVoteAttacks.t.sol` covers the plan's attack table where the vote is the defence (19 tests, each named after its row,
with the plan's cost figures): the whale with a third, leavers during the wait, a late buyer, many accounts, team Shares, vote
spam, ballot stuffing, parking and unparking during the vote, a one-block flash loan, ballot replay, the old runner's puppet
offer and pending rate dying at the seat, permissionless carry-out and retry, an unpark that never reverts (fuzz), the
candidate's text pinned by its hash, seat elections needing two elections for three seats, winners unparking after the end,
and the cooldown. A **control** test lowers the wait to zero and the floor to one with `vm.store`, reads the storage back, and
shows the same attack then moves the seat at the exact `voteEnd` second: the wait and the floor are what stop it.

The takeover numbers the plan asks for (arithmetic, asserted in the test): on a pot of **10,000** a whale's net `m = 5,000`
costs a fee of **102.04** and ties up **5,102.04**; the sleepers' loss in 30 days of the seat is **1,240**, so the whale keeps
**+1,137.96** after the fee. On **1,000,000**: fee **10,204.08**, capital **510,204.08**, sleepers' loss **124,000**, keeps
**+113,795.92**. On the test project the seat moves only at `effectiveAt`; a holder who takes out at `voteEnd` is paid the same
value to within the old runner's capped allowance (asserted ≥ 99.5%).

**Finding that came out of the attack pass (fixed).** The first build packed a parked weight in 96 bits; an account holding more
than 2^96 wei of Shares (permitted by `MAX_SHARES = 1e30`) carried weight into the ballot id, so the hook's early return kept a
cast weight after the Shares left custody — attack row 11 would have been non-zero at very large projects. The fields are now 128
bits in the same one slot, and the huge-account case is a guard test. **Second finding (stated, not fixed):** the plan's row 8
spam cost ("5% parked first, paid once") is not enforced — the opener may unpark the stake the same block and the ballot still
lives four days; the plan itself concedes the jamming in 2.10, so this is a correspondence between the table and the code.

---

## 2. What ran, with counts

### Tests

`forge test` on the completed contracts: **1,065 passed, 0 failed, 0 skipped, 110 suites** (baseline `v6`: 737; the round adds
328; `v6`'s 737 test functions are
still present; the only existing helper edited is `test/helpers/Mocks.sol`, additively (two stubs, as plan 1.2 says). K1's own
test files are bound to a `HolderVote` where the switch is on (K2's tightening of `bindCouncil` requires it) and those edits are
stated in the commits.

New contract test files and their counts: `Council` 32,
`CouncilAccess` 12, `CouncilSeats` 21, `CouncilInvariants` 8, `CouncilEventsRebuild` 1, `CouncilKinds` 2, `LauncherCouncil` 20,
`SeatByVote` 9, `OffIsOffCouncil` 2, `HolderVote` 26, `HolderVoteCount` 8, `HolderVoteBoundary` 6, `HolderVoteResults` 14,
`HolderVoteAttacks` 19, `LauncherVote` 11, `DeployVoteSettings` 1, `GasVote` 7, `SizeVote` 4, `HolderPauseOnVote` 95 (the whole
existing pause suite re-run on a `HolderVote` clone), `OffIsOffVote` 2, `HolderVoteInvariants` 11 (ten invariants at 1,000 runs ×
200,000 calls), `VoteEventsRebuild` 5 (a 400-step fuzz and four replays).

### The switch-off proof

- `OffIsOff.t.sol`'s 154-log golden journey runs on the new code and gives the recorded digest, constant unedited.
- `OffIsOffCouncil.t.sol` and `OffIsOffVote.t.sol`: the same fuzzed differential between a stack with every switch off and one
  with `HOLDER_PAUSE=1 COUNCIL=1` where nobody makes a Council and nobody opens a ballot: every public view of the Treasury,
  Vester, TaskBook and both tokens equal after every step, and every step succeeds or fails alike.
- `HolderPause`'s runtime bytecode hash is exactly the v6 one (`0x968400a4…ccdf`), held by `SizeVote.t.sol`; the whole pause
  suite passes on a `HolderVote` clone (`HolderPauseOnVote.t.sol`, 95 tests).
- The only changes a deployment sees with the switch off are additive: new views and functions, and the two Treasury seat
  checks asking the Launcher a different name for the same answer.

### Sizes (plan 1.7/2.13 gates)

| Contract | Before (v6) | After | Gate | Result |
|---|---|---|---|---|
| Treasury runtime | 24,080 (496 spare) | **24,153 (+73, 423 spare)** | grow ≤ 190, keep ≥ 300 | pass |
| Parts creation code | 48,810 (342 spare) | **48,979 (173 spare)** | keep ≥ 152 | pass |
| Pair runtime | 2,558 | 2,654 (+96) | grow ≤ 190 | pass |
| Council runtime | — | **6,541 (18,035 spare)** | ≥ 3,000 spare | pass |
| HolderVote runtime | — | **17,730 (6,846 spare)** | ≥ 3,000 spare | pass |
| Launcher runtime | 8,724 | **11,839** (+3,115; estimate was +1,100) | under 24,576 | pass |

The fallback in 1.7 was **not** taken: `seatByVote` fits (the Treasury grew 73 bytes).

### Gas (plan 1.7/2.13; measured by `GasVote.t.sol` and `GasCouncil.t.sol`)

The K1 baseline was re-measured here against a fresh build of `4c36f73d6` with the same scenarios and cold set: `join`
133,298, a founder's `draw` 102,121, a founder's `announceTask` 217,942, a Pair's `draw` 116,101 and `announceTask` 232,295 —
**exactly the constants the K1 tests record**, so "no cost regression for a founder or a Pair" is a measured claim, and all
current measurements are at or under them.

| Call | Plan estimate | Measured | Gate |
|---|---|---|---|
| `openReplace` | 400,000 | 448,325 | 470,000 |
| `standList` | 230,000 | 275,559 | 300,000 |
| a displacing `standList` | 250,000 | 113,878 | 320,000 |
| `stand` | 130,000 | 149,558 | 160,000 |
| `castVote` first | 100,000 | 73,701 | 85,000 |
| `castVote` move | 40,000 | 50,736 | 56,000 |
| `finish` | 80,000 | 5,451 | 30,000 |
| `carryOut` | 650,000 | 402,097 | 450,000 |
| a `HolderVote` clone's `park`, no ballot | +2,300 | +2,121 | 2,300 |
| a `HolderVote` clone's `unpark`, no ballot | +2,300 | **+2,901** | 3,200 (plan asks 2,300; the extra is the hooks' second cold read) |
| `unpark` with a ballot live | +60,000 | +39,114 | 60,000 |
| `park` with a ballot live | +30,000 | +17,203 | 30,000 |

`openReplace`, `standList`, `stand` and a moved `castVote` come in **over the plan's estimates** (by 12%, 20%, 15% and 27%) and
the clone's `unpark` by 601 gas over the plan's 2,300 allowance; the gates are the measured values with a margin, and the
report states the differences rather than hiding them. The plan's estimates were estimates.

### Mutations (plan section 7's falsifiability rule)

- **K1: 73 mutations run, 73 killed, 0 survived.**
- **K2: 37 entries, 35 killed, 2 recorded as proved equivalents, 0 unexplained survivors.** The two equivalents: a "short"
  ballot cannot start the cooldown because the same condition already requires the cast total to meet the floor; the hook's
  `unchecked` subtraction is unreachable, guarded by the invariant that a tally is the sum of the weights cast on it.
- `python3 contracts/pot/scripts/check-mutations.py --check` exits 0 (every entry's text occurs exactly once); the script now
  copies `script/` too, so a deployment test that imports the deploy script can be a mutation's witness, and `--check` no longer
  needs test files that are not written yet.

---

### The app (A1)

Built on the record keys of section 5.2 and the ABI the server regenerates. **Nothing new shows on a project with no Council and
no open vote**, and nothing shows with the switch off: every new component returns null on an older or absent record.

- **The vote card** (`app/src/features/council/VoteCard.tsx`, plan 6.2): title by kind, state line, one row per option with the
  plain percent, the candidate's text only when its signed id equals the hash the chain stored (else "No text"), the proposer
  line, "Your vote", "You are standing.", a distinct accessible press per row, the count line built from `vote.rule`, the
  planned-change block from `voteEnd` whether or not anyone recorded the result, "The vote ended. Nothing changes." for three
  days, the last line on every replace card, and read-only sentences with no press for a visitor or a holder who was not parked
  before the vote opened. "Posts and votes are public." shows once, where a person can vote or stand.
- **The stand sheet** (`StandSheet.tsx`): one sheet with three modes (stand a person, stand a list, open the vote), a labelled
  text box with a live polite count, the "Do not promise anyone a profit or a return." line, five "Seat N" fields (name or pasted
  address, a five-address paste, Tab/Enter), "You cannot take your name off once you stand.", the public line and the banner
  once, the presses of 6.2, and the opening sentence built from `vote.rule`. One press signs the candidacy record and then sends
  the call; the signed id is kept so a failed second step retries without signing again.
- **The Council section** (`CouncilSection.tsx`, in the Money tab above the runner presses) and **WaitingActions.tsx**: the five
  seats with linked names and short addresses, "You"/"Open seat", the next election line ("now" while a seats ballot is live), the
  seat holder's waiting list with `{k} of {needed} have agreed`, one Agree press per row with one accessible name, "Take back my
  agreement", and the plan's last line about five accounts and the same limits. It draws only when `runner.kind` is `council`; a
  Council the record cannot read shows "The Council could not be read right now." with no press.
- **Hand over to a Council** (`HandOverCouncilSheet.tsx`, lazy, present runner only): a third choice beside "Hand over to one
  person", five fields, the plan's sentences, "Offer the seat", then "Make the Council" once the offer is on the Treasury, and
  the offer-ran-out failure that offers again.
- **The opener's line** in the pause card (plan 6.3): one line and "Ask holders", only when the record's `vote.next.openFloor` is
  met by the pause's parked total, no ballot is open, the cooldown is over and the person has parked Shares; it opens the stand
  sheet in its opening mode, so there is no second sheet. **The planned-change sentence on the Back sheet** (plan 6.1) for anyone
  backing during a wait.
- **Alerts** (`alerts.ts`, `alert-words.ts`): a `vote` kind (either ballot, urgent until it ends) and a `moved` kind from the
  record's derived result (urgent until `effectiveAt`, the id changes when the state does so it is unseen again), plus the badge
  line "Several accounts run it." only for a Council and the plan's two push sentences in `public/sw.js` and `push-words.ts`.
- **Data and words**: `numbers-step9.ts` (behind the same lazy boundary as the step-4 parse, so the entry chunk does not carry
  either parser), `numbers-step9-vote.ts`, `vote-words.ts`, `council-words.ts`, `use-vote.ts`, `use-council.ts`, `proposals.ts`,
  `pot-copy-vote.ts`; every number a sentence needs comes from `vote.rule`/`council.needed`, and a test builds each sentence from a
  record and from a changed `vote.rule` and checks the number follows. The core package gains 14 calls and 3 reads with tests
  against the contracts' own ABI.

**App checks:** `pnpm check` (biome, `tsc --noEmit`, check:copy, check:px-text, check:file-sizes) exits 0; `pnpm test` **243 files,
2,250 tests, 0 failed**; `pnpm build` passes, entry chunk **402,430 B (393 KiB)** against the 450,000 budget — **47,570 B under**,
but **1,600 B larger than this tree's own start (400,830 B)** because 6.7's alert kinds live in `alerts.ts`, which is in the entry
chunk. The plan's "281 bytes to spare / 449,719" is stale for this tree. `core` tests 1,292 pass. Playwright
`pot-council.spec.ts`: **7/7** at 390×844 with axe (card in standing, voting, waiting and ended states; both sheets) plus a
360×640 run; each showed a 48 px press height. The E2E record builder cannot yet bind a `HolderVote`/`Council` on the local chain,
so that spec binds a real `HolderPause` and patches the record's milestone-9 keys; the sheets' send paths are covered by vitest,
not sent on chain in E2E.

**App gaps, stated:** of the existing runner presses, only "Hand over the seat" works as a Council proposal; Draw, the rate, the
door, check-in, Grant Team Shares, planning/accepting/cancelling a task, the helpers, withdrawing an offer and Wind down are not
wired for a seat holder this round (they still show nothing to a seat, so no press looks usable and fails). "Make the Council" is
shown on the present runner's seat section; a Pair runner whose co-signer confirms an offer later has no re-entry press for the
make step until it lands. `send-targets.ts`'s module-level set is still reset only by tests, not `resetCommunityState()` (pre-existing;
the vote and Council addresses now join it).

---

### The server (S1)

All of it is additive inside record version 2.

- **Reader.** `scripts/chain-reader-events.mjs` regenerates the events table from the contracts build (never hand-edited): the
  pause role now decodes a `HolderVote` (its pause events plus `BallotOpened`, `Stood`, `Voted` with the new option's absolute tally
  and, for a move, the old option's, `Fell`, `BallotFinished`, `BallotCarriedOut`, `BallotLapsed`), and a new `council` role is
  found from `Launcher.CouncilMade` and decodes `Proposed`, `Agreed`, `Withdrawn`, `Executed`, `Cancelled`, `SeatsSet`, `Resigned`.
  An unknown topic at a vote address is ignored, never an error. The ledger **sets** tallies from the absolute numbers in the
  events and keeps **no per-voter state**; a `Stood` naming a displaced proposer replaces that option's entry.
- **Record.** `runner.kind` ("single"/"pair"/"council"), `runner.seats`, the `council` block (contract, the five seats with
  `seatedAt`, `needed`, `generation`, `nextElection`, `upSeats`, the waiting actions by kind with a bound) and the `vote` block
  (contract, `rule` with every number a sentence needs, the open ballot's kind/phase/four times/supply/floor/cast/options/result,
  and the next-times) are always present and null when absent; a failed check signs that key null, logs one line naming the
  project and the key, and signs the rest. The checks are plan 5.2's: the tallies add up; the times are in order; `cast ≤
  parkedTotal` only while the vote runs and `cast ≤ supply` always; `effectiveAt − voteEnd` equals the Treasury's longest notice at
  the same block; the floor equals the rule; the derived result equals a recorded `BallotFinished` (else `vote: null`). **No voter
  address and no per-voter amount is ever in a record, an explore row, a feed row or an alert** (a planted-voter test), and a vote
  stays in the record through the whole wait even after every winner has taken their Shares out.
- **The result from the frozen tallies (V34).** The reader derives the same result the contract does, from `voteEnd` on, so the card
  and the alert show a moved or seated result with nobody pressing `finish`; `BallotFinished` only confirms it. The refresh drops to
  `min(600 s, standSecs/4)` while a ballot is live or a result waits.
- **The candidate's text (5.4).** A new `candidacy` family of kind 47003: the plan's tags, content at most 280 characters and
  1,024 bytes, signed by any signed-in account whose live linked wallet is the proposer, never by an account the server marks as an
  agent, at most 3 a day per account and 10 per ballot, one expiration at most 30 days out. The relay does not read the chain at
  write; the app and the server show a text only when its id equals the hash the chain stored at `Stood` and the proposer/candidate
  tags match.
- **The helper (5.5).** Four permissionless jobs — `vote.openSeats`, `vote.finish`, `vote.carryOut`, `vote.lapse` — inside the
  existing bounds (at most 3 per pass, a project's own pace of 10 minutes or a quarter of the stand window when smaller, at most 6 a
  day, backoff, and five failures in a row leave that project alone for 24 hours and log it), never opening a replace vote, with the
  closed list pinned by a test. The helper reads `canCarryOut`/`canOpenSeats` in its head check (a pure planner has no node, so that
  is a stated deviation).
- **Alerts (5.6).** Two new push kinds: `vote` for either ballot's opening (urgent until it ends; at most one per project per time
  unit, so a stream of junk ballots cannot become a stream of pushes) and `moved` for a moved or seated result, made from the
  reader's derived result by the first pass after `voteEnd` and once per (project, ballot, kind), with the plan's words held equal
  between `web_push/mod.rs` and `app/public/sw.js` by a test. Sponsor follows the Council and the vote contract, so a passkey
  account's presses are ordinary sponsored operations; the exit rule (`[unpark, leave]`) is unchanged and still tested with a ballot
  live.
- **Established (5.8).** `two_signers` also holds for a Council with at least three distinct non-zero live seats; the key keeps its
  name and now means "the project is run by more than one account".
- **One migration.** `migrations/0077_chain_council_role.sql` widens the three check lists the new rows write into (`chain_contracts`
  gains `council`, `chain_helper_jobs` the four vote jobs, `web_push_alerts` the two kinds), with the `schema/tables/public` files and
  a Postgres-lane migration test.

**Server checks.** `node scripts/chain-reader-events.mjs --check`, `node scripts/pot-app-abi.mjs --check`, all three fixture runs
(`--check` for the default, the pause and the new council run) and the two older examples pass; `app/src/features/alerts/push/push-sw.test.ts`
is 32/32 with the five words. The third example (`record-v2-example-council.json`) is written by a Rust test with `UPDATE_EXAMPLE=1`
and was still pending, as were `cargo fmt --all -- --check`, clippy and the Rust test lanes: the shared cargo target directory was
under a cold third-party build for over an hour with two agents queued behind it, so this report states them as **not yet run**
rather than as passed. Postgres and a local Redis were started for the `--ignored` lane, which also did not reach a result. Nothing
of the server is verified by a run yet beyond the generated-file checks above.

---

## 3. Choices, deviations and findings

- The plan's four seat-tie cases are implemented exactly: two tied at the top take both seats; a tie for the second seat
  between second and third place leaves that seat as it is; a person tied with "keep" does not take a seat; a winner already
  holding an up seat keeps it. The first build got two of them wrong and the count/result tests found it; the fix is in this
  round and the tests that found it are kept.
- Weight packs in 128 bits (the attack pass's finding, section 1).
- `seatByVote` clears the pending rate itself rather than a `clean` flag on a shared `_seat` (plan 1.2(c)/(d)); the effects and
  their order are the same and it saves bytes.
- Person places displace by stake as well as list places, which is what plan 2.3's sentence says; the first build only displaced
  list places.
- `DeployCouncilSettings` cases live inside `DeployPotSettings.t.sol` rather than a separate file: the script reads process
  environment variables and test contracts run in parallel, so a second file setting `COUNCIL`/`HOLDER_PAUSE` would race it
  (stated in the test). The plan's file list allowed either reading.
- Extra views for the server and the tests: `ballot(id)`, `optionCount`, `castOf`, `resultOf`, `canOpenSeats`, `weightOf`,
  `ballotOf`. They are additive and read-only.
- The Launcher's growth (+3,115 bytes) is well over plan 1.2's +1,100 estimate (its gate was the 24,576 limit, which holds
  with 12,737 spare).
- A moved result leaves `nextReplaceAt` at a past timestamp rather than clearing it; harmless (the check is "now ≥ that") and
  stated.
- The plan's row-8 spam-cost figure is not enforced (see section 1).

## 4. Not built, and open

**Not built, with the reason (plan 8, "What is not in this round"):** the reserve sale (there is no reserve in the new model),
the stage ladder and its stepped turnout floors (no stage exists), a supermajority wind-down, the team-payer role (no team
budget to pay), the end-at-two-thirds power (`STEP4-PLAN` 1.9), term limits, seat pay, delegation, signed votes, voting with
Team Shares, and no "Give up my seat" press in the app (the contract has `resign`). No real network, no real money, no audit.

**Open (plan 8, "Open for the builders"):** whether "more than half of all Shares cast" should be "more than half of the
snapshot" (harder for a whale and for honest holders); the 4-unit cooldown's calibration; whether three of five for a check-in
leaves real Councils quiet; and the two review items the plan did not take.

## 5. Questions for counsel, word for word (plan section 10)

With `COUNCIL=1` the premise of the design's question 12.4 ("here governance is the notice and the right to leave, with no
vote") is false; with it off it holds. **Counsel is asked for an answer per setting of the switch.** The legal line is not
edited.

- **C1.** With a real vote (replace the runner, elect seats), is "governance and exit" delivered in the stronger sense? Does that change the analysis of Shares themselves (voting rights as an indicium) or of the platform fee that buys a vote? Redo 12.4 for both settings of the switch.
- **C2.** Do voters who control who runs a pot, or Council seat holders (five accounts that decide the spending of others' money), face partnership, unincorporated-association, fiduciary or money-handling exposure? Does an AI agent holding a seat (V16 does not bar it) change that?
- **C3.** A candidate's text is a statement by someone seeking control of others' money, hosted in the platform's app. Is it a solicitation? What moderation, or "no promise of profit" rule, is required beyond the one plain line of V41, and should a text be removable after the fact?
- **C4.** Takeover disclosure: a holder of a third can take control for about the platform fee, and holders who do not look can lose about 12 in 100 within 30 days of the seat. What must the page and the terms say about that? The plan says only "taking out stays open".
- **C5.** Naming: "Council", "five accounts", "list". Is it misleading that five seats can be one person? Is showing the linked names of accounts that did not agree to be listed acceptable? Does the Council section's last line ("can do what a founder could do, with the same limits, and nothing more") read as reassurance?
- **C6.** Votes are public on a public chain and linked to accounts. Is "Posts and votes are public." enough for privacy and erasure rules?
- **C7.** The snapshot rule (only Shares parked before a vote opens count) means late joiners cannot take part. Is that fair, and does it need disclosure on the Back sheet (the plan shows the planned-change sentence there)?
- **C8.** The platform's helper presses `finish` and `carryOut`. Does automating a governance outcome make the platform a participant?
- **C9.** Play dollars on a test network: does a vote on play dollars avoid all of this, and what changes at the first real-money launch?
- **C10.** Questions 12.1, 12.7, 12.10 and 12.11 are not changed by this plan. The words "You can take your money out any time." alone (in an alert or a push, without the second half) are consistent with the existing planned-task push; counsel may want the pair kept together outside the app.

## 6. What a person on a real phone has not done

Nobody has used any of this. The contracts ran on a local chain and in tests only; no deployment, no Council, no ballot has
been made on a test network or by a person. The app screens and the joined-up loop are the second half of the round (S1/A1);
this section says what they did or did not do when they land. The plan's "what a person on a real phone did not do" line stays
true for everything in this report.
