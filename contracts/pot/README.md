# contracts/pot

The money contracts of the join-and-leave design (`docs/next-version/JOIN-LEAVE-DESIGN.md`, build step 1). A separate
Foundry project: `contracts/next` is not edited, so the server and app that still read it stay green until they move over.
Library code is not copied: `lib` is a symlink to `../lib` (forge-std and OpenZeppelin 5), like `contracts/next/lib`.
What was built, what was measured and what is left is in `docs/next-version/POT-STEP1A-REPORT.md`.

Units: dollars have 6 decimals (1 dollar = 1,000,000 units), Shares and Team Shares have 18. The time unit N is fixed at
deployment: 7 days on a real network, and on a test network any multiple of 168 seconds.

## What each contract does, in plain words

| File | What it does |
|---|---|
| `src/Treasury.sol` | One project's pot. **Back** (`join`): pay dollars, get Shares at the price the money in the project sets this second; the platform keeps 2%. **Take out** (`leave`): burn your own Shares for your slice of the pot, any day, no vote, even when the door is shut or the project is quiet. Quotes (`quoteBack`, `quoteTakeOut`) run the very code the actions run. The team reaches the money only through the daily allowance: a small share of the pot each day moves into a box (never more than seven days' worth) and the runner, or an agent inside its own daily limit, draws from the box. A check-in every week keeps the project "active"; two units without one shuts the door and stops the allowance and vesting; 26 units lets anyone wind it down. Outside money arrives in the pot over one time unit. Team Shares (a second token) can take out only what the pot holds above what backers paid in. |
| `src/TaskBook.sol` | One project's task queue, one clone per project, holding no dollars: a task is announced (a payee or open to anyone, a dollar maximum, a share of the pot up to 5%), waits out a notice of 14 days plus 12 hours for every 1%, is taken (only then does money move, the smaller of the dollars and the share, out of the pot), and is then paid in full, paid in part, rejected, or returned when its deadline (2 units after the take) passes. At most 10% of the pot may be taken in any 28 days, at most 8 tasks are open, and a task's serial is never reused. The Treasury is its only caller. |
| `src/Vester.sol` | Holds the whole Team pool. A grant has its own clock in active time, a cliff of 13 units inside 104 units of vesting, and can be forfeited with a notice of one unit (the announced burn is priced into every join from the announcement). |
| `src/ShareToken.sol` | One token code, two instances (backer Shares and Team Shares). Only the Treasury mints; the only burn is the Treasury burning a holder's own tokens in their take-out. |
| `src/Pair.sol` | The two-signer runner: every money call needs both signers; either signer alone may check in; there is no one-signer way to spend. |
| `src/Launcher.sol` | Birth: clones the Treasury, two tokens and the Vester in one transaction, checks the founder saw the platform settings (a hash), makes Pairs, forwards a wind-down. |
| `src/Parts.sol` | Makes the four implementations the Launcher clones. |
| `src/PotMath.sol` | The integer formulas (price, Shares minted, cash paid, fee), shared by quotes and actions. Every division rounds toward those who stay, except the platform fee, which rounds up by at most one unit. |
| `src/PlayDollar.sol` | The dollar of the test network: a faucet (1,000 once per account) and `transferAndCall`, so a join is one signature. The constructor refuses to deploy anywhere but a test chain. |
| `src/RollingCap.sol` | Copied unchanged from `contracts/next`: a limit on use in any stretch of time (an agent's daily limit). |
| `script/DeployPot.s.sol` | Deploys PlayDollar (or uses a given dollar), Parts and the Launcher. Reads no key. See `DEPLOYMENTS.md`. |
| `model/` | The exact-decimal reference model, its extension to what the contracts define, the vector generator and `vectors.json`. See `model/README.md`. |
| `scripts/check-mutations.py`, `scripts/check-vectors.sh` | Break the contracts on purpose and see the tests notice; check the vector file is current. |

Step 2 (this tree): the task queue (`announceTask`, `takeTask`, `acceptTask`, `rejectTask`, `cancelTask`, `returnTask`) with its
notice, caps and deadline, the money set aside for taken tasks (`locked`), the return of a task that ran out inside every `settle()`,
and the **exit notes**: a holder who takes out while money is set aside is paid cash on the pot without it and written a note for the
rest, keyed by the task's serial; when the task ends the worker is paid first and what is left comes back at one ratio to the stayers
and to every note (`claimNote`); a task paid in full has no claimable note. A task can still be paid by `draw()` from the box, the
other door. What was built, measured, chosen and declined is in `docs/next-version/POT-STEP2-REPORT.md`.

## Run it

All from `contracts/pot` unless noted. Put the Foundry binaries (`forge`, `anvil`, `cast`) on `PATH`.

```bash
forge build --sizes               # Treasury and TaskBook under 24,576 bytes, Parts' creation code under 49,152 (test/Size.t.sol binds them)
forge test                        # everything: unit, fuzz (1,000 runs), invariants (256 runs x 200 steps), vectors, event rebuild
forge test --match-path test/ModelVectors.t.sol -vv    # the vectors alone, with the worst deviation printed
forge test --match-path test/PotInvariants.t.sol       # the invariants alone

python3 -I model/gen_vectors.py   # regenerate model/vectors.json (after a change to the model or its scenarios)
bash scripts/check-vectors.sh     # fail if vectors.json is not what the model says

python3 scripts/check-mutations.py                     # break 118 formulas, guards, rules and orders, one at a time, see each caught
bash ../../scripts/pot-chain-loop.sh                    # the whole loop on a local chain with cast (needs anvil, cast, forge, jq)
```

The chain loop starts anvil on a free port, runs the deploy script, walks one project through launch, faucet, a one-signature
join, check-in, the allowance, outside money, vesting, going quiet, a Team take-out and a take-out, prints a numbered `PASS` line
per check and exits non-zero on the first failure. It stops anvil when it ends.

## Where each kind of test lives

| Kind | Files |
|---|---|
| Units and edge cases | `Join`, `Leave`, `LeaveTeam`, `Allowance`, `Revenue`, `Fees`, `Quiet`, `Treasury`, `Reentrancy`, `PotMath`, `ShareToken`, `PlayDollar`, `EmptyJoin`, `Worked` (the design's worked numbers) |
| Team, vesting, forfeit, agents, Pair, Launcher | `Vester`, `VesterUnit`, `VesterFuzz`, `Team`, `Forfeit`, `WindDown`, `Agents`, `Pair`, `Launcher` |
| The task queue | `TaskBook` (the book alone), `Tasks`, `TasksCaps` (5%, 10% in 28 days, 8 open, must-bind 4), `TasksExpiry` (a task that ran out is returned inside every action), `Size`, `GasTasks`, `Arrival` (settle every second equals settle once), `OwnBurn`, `Pragma` |
| Exit notes | `Notes` (the worked case through a real leave, claims, dust, reentrancy, Team take-outs), `NotesMustBind` (the eight slots cycled twenty times with random take-outs, joins, paths and claims), `NotesFuzz`, `PairTasks` (a real Pair through the queue and a note) |
| Events | `Events` (each event's fields), `EventsRebuild` (a ledger of events alone rebuilds the project step by step, tasks and notes included), `TasksRebuild` (the same on a scripted run that walks every path); the ledger is `helpers/TaskLedger.sol` |
| Invariants and fuzz | `PotInvariants` with `helpers/PotHandler.sol` (many actors, every kind of step, ghost sums), `MustBind` |
| Model vectors | `ModelVectors` replays `model/vectors.json`: 83 scenarios (tasks and notes included), every number compared |
