# Deployments

Nothing here has been deployed anywhere but a throwaway local chain (the chain loop). This note says what an operator runs,
with their own key, to put the money contracts on a network. No key is in this repository or in the script, and the script
reads none: the sender comes from the command line. `contracts/pot/deployments/` (where the script writes the addresses) is
git-ignored.

## What gets deployed

`script/DeployPot.s.sol` deploys, in this order: the dollar (PlayDollar on a test network, or an existing 6-decimal token
you name), `Parts` (the five implementations the Launcher clones: Treasury, Vester, Pair, the share token and the TaskBook), and the
`Launcher` with the platform settings (the dollar, who receives the platform fee, the fee, the time unit, the default daily
dollar limit of an agent), and, only when `HOLDER_PAUSE=1`, the holders' pause implementation bound to the Launcher, and, only when `COUNCIL=1`, a `HolderVote` as the pause implementation (so every project launched from then on counts its holders' votes in the pause's own custody, and gets a `HolderVote` clone as its pause) and the `Council` implementation, both bound to the Launcher, and, only when the six `EARLIER_*` settings are all given, the earlier backers' claim contract bound to the Launcher. It writes `deployments/pot-<chainid>.json` with the addresses. Projects are then launched by
founders through `Launcher.launch`; each gets its own Treasury, Vester, TaskBook (the task queue; its address is `Treasury.tasks()`) and two tokens.

## Settings (environment variables, all optional)

| Variable | Default | Meaning |
|---|---|---|
| `UNIT` | `604800` (7 days) | The time unit N in seconds. Every day-count of the design derives from it (check-in window 2N, cliff 13N, vesting 104N, notice N, arrival N, quiet wind-down 26N). **On a network that is not a test network it must be exactly 7 days**: the Launcher refuses anything else. On a test network any multiple of 168 seconds works (1680 is N = 28 minutes). |
| `QUOTE` | a new PlayDollar | The dollar token, 6 decimals. PlayDollar can be deployed only on chain 31337 (local) or 11155111 (Sepolia); its constructor reverts elsewhere. |
| `PLATFORM` | the sender on a test network; **required** elsewhere | Who receives the platform fee (collected by anyone calling `collectFees` on a Treasury). |
| `ADMIN` | the sender on a test network; **required** elsewhere | Who may change the platform settings for projects launched after the change. |
| `FEE_BPS` | `200` (2%) | The platform fee on a join. The contract ceiling is 500 (5%). |
| `AGENT_USD` | `25000000` (25 dollars) | An agent's default daily dollar limit. |
| `HOLDER_PAUSE` | `0` (off) | `1` turns on the holders' pause (step 4, `docs/next-version/STEP4-PLAN.md`): the script also deploys `HolderPause` and binds it to the Launcher (`bindPause`) **in the same broadcast as the Launcher's own deployment, before any project can be launched**. Every project launched from then on is born with its own pause (a clone), and keeps it. Anything other than 0 or 1 makes the script stop before it sends anything. |
| `COUNCIL` | `0` (off) | `1` turns on the Council (`docs/next-version/COUNCIL-PLAN.md`): the script also deploys the `Council` implementation and binds it to the Launcher (`bindCouncil`) in the same broadcast, before any project can be launched. **It needs `HOLDER_PAUSE=1`** (a Council reads its project's pause as its vote contract); `COUNCIL=1` with the pause off, or any value other than 0 or 1, makes the script stop before it sends anything. A runner (a founder alone, or a Pair) can then hand the seat to a Council of five accounts. The round's second part (the holders' vote) is not part of this setting yet. |

| `EARLIER_ROOT`, `EARLIER_TEXT_HASH`, `EARLIER_TOTAL`, `EARLIER_ROWS`, `EARLIER_FOUNDER`, `EARLIER_PROJECT_ID` | none of them set (nothing is claimable) | The earlier backers' claim (step 4, `STEP4-PLAN.md` section 3): **all six or none**. Together they make the script deploy `EarlierGrants` and bind it to the Launcher (`bindEarlier`) in the same broadcast as the Launcher's own deployment, before any project can be launched. The first two are fingerprints (bytes32): the list's Merkle root and the text a claimant accepts; the list and the text themselves are never in this repository. `EARLIER_TOTAL` is the pool in Team Share wei (the sum of the rows) and `EARLIER_ROWS` the number of rows. `EARLIER_FOUNDER` and `EARLIER_PROJECT_ID` (bytes32) name the one project, by who launches it and under which id, that is born with the pool. Any of them set without the others makes the script stop before it sends anything. |
| `EARLIER_ALLOW_LARGE` | `0` | `1` allows `EARLIER_TOTAL` above 100,000,000 Shares (the founder's own Team pool limit); the claim contract itself caps it at 1,000,000,000. A pool that large is a stated choice. Anything other than 0 or 1 stops the script. |

### The holders' pause switch

Off by default, and with it off nothing about a deployment differs from before (`OffIsOff.t.sol` runs a 154-log journey on the
old and the new build and compares the digest). It is a switch of the **deployment**, not of a project:

- The Launcher remembers who deployed it (`deployer()`) and when (`deployedAt()`). `bindPause(impl)` works only for that
  address, once, and only inside the first hour; a key stolen later cannot turn the pause on for new projects. Because the script
  binds it in the same broadcast, a project launched before the binding cannot exist on a script-made deployment. (A project
  launched before the switch, on a hand-made deployment, is born without a pause and has none for good.)
- Once bound, `settingsHash()` covers it (`keccak256(abi.encode(platform, holderPauseImpl))`; with nothing bound the old formula
  `keccak256(abi.encode(platform))`), so a founder who read the hash before the switch is refused at launch and reads it again.
  The app reads `holderPauseImpl()` and tells the founder before the Launch press that holders can pause the team's spending.
- The Launcher publishes `HolderPauseBound(impl, codehash)`. To check what is bound, compare that hash with the build:
  `forge inspect HolderPause deployedBytecode | cast keccak`. The Launcher does not hard-code an allowed hash (a founder cannot
  judge code; the deployer chose the implementation and `settingsHash()` already covers it). From the build at this commit
  (solc 0.8.37, optimizer 200 runs, `via_ir`, `evm_version = cancun`, `bytecode_hash = none`): `0x968400a44b9da42191d6e20ab5f47532e161ee3255d508c807d49f82f0a3ccdf`.
- The pause holds no dollar and has no owner. Its one effect is that `draw` and `announceTask` of that project's Treasury refuse
  while a third of the backers' Shares are parked and have been for a day; take-outs are never touched.

### The Council switch

Off by default, and with it off nothing about a deployment or a project differs from before: `Launcher.councilImpl()` is zero,
`makeCouncil` reverts, no address is ever registered as a Council, and `settingsHash()` is each of its three old formulas (the
tests of `LauncherCouncil.t.sol` check each). `OffIsOff.t.sol`'s golden journey still gives the digest it gave at 4c36f73d6, and
`OffIsOffCouncil.t.sol` runs the same 120-step differential on a stack with the pause and the Council bound where nobody makes a
Council. It is a switch of the **deployment**:

- `bindCouncil(impl)` works for the deployer only, once, inside the first hour, for an address with code, and only after the
  pause is bound; the Launcher publishes `CouncilBound(impl, codehash)`. The script binds it in the same broadcast as the
  Launcher's own deployment.
- Once bound, `settingsHash()` has a **fourth form** that the Council test decides first: `keccak256(abi.encode(platform, pause, claims,
  council))`, with a zero where the claim contract is off. A founder who read the hash before the switch is refused at launch and
  reads it again.
- A Council is a clone of `impl`: five seats, three of five needed for every action. It has no power a runner does not have;
  every limit of the Treasury binds it. `Launcher.makeCouncil(key, members, salt)` makes the one the runner offered the seat to
  (`Treasury.handOver(Launcher.councilAddress(key, members, salt), false)` first); the Launcher registers it as runner kind 2
  (`runnerKindOf`), and publishes `CouncilMade(key, council, false)` (the five accounts are in the Council's own `SeatsSet`, emitted in the same transaction).
- **The vote contract replaces the pause.** With `COUNCIL=1` the deployment binds `HolderVote` as `holderPauseImpl`, so every
  project launched from then on has a `HolderVote` clone as its pause (`Treasury.pauseGate()`): it *is* the pause (the Treasury
  asks it `paused()` and `poke()` exactly as before, and taking out is never slowed) and it *also* holds the ballots. The Launcher
  checks it answers `isVote()` before it binds a Council, so a Council can never be bound beside a plain `HolderPause` (there would
  be no way to elect or replace it). `bindCouncil` therefore needs `HOLDER_PAUSE=1`; the script stops before it sends anything
  otherwise.
- **The replace vote and the seat elections.** A parked holder opens a replace vote with its own list (`openReplace`); a seat
  election is opened by anyone when the Council says two seats are due (`openSeats`, normally by the helper). Votes count only
  Shares parked in the pause from the second the ballot opened. A won result waits the Treasury's longest task notice (16.5 days
  at a 7-day unit), then anyone may carry it out (`carryOut`, no press in the app): the Launcher makes the Council of the winning
  five (`councilByVote`, only the project's own vote contract) and the Treasury seats it (`seatByVote`, only the pause gate, only
  a kind-2 address), both or neither. `finish` records the result; `lapse` lets go of a won result nobody carried out within two
  time units after it was due.
- The expected code hashes of the implementations, from the build at this commit (solc 0.8.37, optimizer 200 runs, `via_ir`,
  `evm_version = cancun`, `bytecode_hash = none`; `forge inspect <C> deployedBytecode | cast keccak`):
  `HolderVote` `0xe328211dc9b43535b262794003aad06db06e7e214cbc87bd111abe8fc1ca4fc0`,
  `Council` `0x4acf0462b41421ef2ed413fbe8e824a30036bb60cc53441785698ca0bcb5a849`. **`HolderPause` is byte-identical to the
  code before this round** (`0x968400a4...ccdf`, above): its three hook calls and two empty internal functions compile to nothing
  (`git diff` on `src/HolderPause.sol` shows only those five lines), and the whole pause suite is re-run on a `HolderVote` clone to
  prove the vote contract is the pause.
- The deployment JSON gains `holderVote` (and `holderVoteCodehash` when on), `null` when the switch is off; `holderPause` names the
  pause implementation, which is the `HolderVote` when the switch is on and the `HolderPause` when it is off.
- Events to check after a deployment with it on: `CouncilBound` on the Launcher (one), and on a made Council `SeatsSet` (the five
  seats), the Treasury's `RunnerChanged` and the Launcher's `CouncilMade`; on a ballot, `BallotOpened`, `Stood`, `Voted`,
  `BallotFinished`, `BallotCarriedOut`. A project launched before the switch has a plain pause and no vote contract, and cannot get
  one; a project of a deployment that has the switch on can hand its seat to a Council by hand-over whenever it was launched.

### The earlier backers' claim

Off by default: with none of the six settings given there is no claim contract, `Launcher.earlier()` is zero, project zero is born
like any project, `settingsHash()` is the formula above, and nothing is claimable. A deployer who sets all six gets:

- `EarlierGrants(launcher, root, textHash, total, rows, key)`, immutable: no owner, no admin, no way to change the list, the text
  or the pool. A new text or list is a new contract. `key` is `Launcher.keyOf(EARLIER_FOUNDER, EARLIER_PROJECT_ID)`.
- `Launcher.bindEarlier(claim)`: deployer only, once, inside the first hour, only while `key` has not launched, and only for a claim
  contract that names this Launcher. `settingsHash()` then covers it (`keccak256(abi.encode(platform, holderPauseImpl, earlier))`,
  with a zero where the pause is off), so a founder who read the hash earlier is refused at launch and reads it again. The Launcher
  publishes `EarlierBound(earlier, key)`.
- When the founder named in the settings launches under that id, the Team token is minted `teamPool + total` to the Vester (the
  extra `total` is a reserve only the claim contract can spend), the Launcher ties the claim contract to the Vester and publishes
  `EarlierPoolFunded(key, vester, total)`. The earlier pool counts in the Team supply from birth, claimed or not: it takes a slice
  of every surplus whether or not anyone claims (`EarlierMoney.t.sol` prints the figure; the owner must see it before any real
  network). It is **not** burned after a wind-down.
- A listed account claims its row with `EarlierGrants.claim(index, amount, proof, acceptedText)`, sent by that account, naming the
  fingerprint of the text it accepts. The row can be claimed once. The claim is a protected Team Share grant: 365 days of calendar
  time counted from the project's birth, no cliff, never forfeited, trimmed or burned. Unclaimed rows stay claimable, also after a
  wind-down; there is no end time and no sweep (what should happen to Shares nobody claims is counsel's and the owner's to decide).
- The list never touches the repository: the tests use invented rows. A list builder asserts that indexes are unique and below
  `EARLIER_ROWS` and that the amounts add up to `EARLIER_TOTAL`; the contract cannot check it. Two more assertions are the
  builder's, because a row that can never be claimed keeps its share of the pool in the Team supply for good (the reserve is
  never burned, so it dilutes backers forever): **at most 8 rows per account** (one account holds at most eight protected
  grants, so a ninth row reverts and its flag stays free) and **every row at least 1e18** (one whole Team Share; a smaller
  row reverts and stays unclaimed). `EARLIER_ROWS` can be at most 4,294,967,295; more stops the script.

The script order, when both switches are on: Launcher, then `bindPause`, then the claim contract and `bindEarlier`, all in one
broadcast. The Launcher's own code hash does not depend on either switch.

The founder's two numbers (the allowance rate, at most 0.20% a day, and the Team pool) are chosen at launch and are not
settings of the platform. A founder's launch is refused if the platform settings changed since the founder saw them
(`settingsHash`), so a project is never born on terms its founder did not agree to.

## What an operator runs

On a local test chain (anvil), to try it:

```bash
cd contracts/pot
UNIT=1680 forge script script/DeployPot.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --private-key <the anvil key you start with>
```

On Sepolia (play dollars, N = 7 days), with your own key held in a keystore or a hardware wallet, never pasted into a file:

```bash
cd contracts/pot
export SEPOLIA_RPC_URL=<your node>
forge script script/DeployPot.s.sol --rpc-url sepolia --broadcast --account <your keystore name>     # or --ledger
```

On a real network, with a real dollar token and the platform's own addresses:

```bash
QUOTE=<token> PLATFORM=<fee receiver> ADMIN=<settings admin> forge script script/DeployPot.s.sol --rpc-url <rpc> --broadcast --ledger
```

After a deploy, read `deployments/pot-<chainid>.json` for the addresses (`holderPause` is the zero address, and
`holderPauseCodehash` the zero hash, when the switch was off; `earlierGrants` and `earlierKey` are zero when no claim contract was bound). To check the result: call `Launcher.settingsHash()` and
`Launcher.platform()` and compare them with what you meant; launch a throwaway project and take a play dollar through the
faucet. `scripts/pot-chain-loop.sh` (repo root) does all of that against a local chain and is the reference for the calls.

## What is not done

No network has the contracts. The platform fee receiver, the admin and the dollar for a real network are the operator's to choose.
The server and the app do not read these contracts yet (build steps 1b to 1d); they still read `contracts/next`.
