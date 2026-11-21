# Deployments

Nothing here has been deployed anywhere but a throwaway local chain (the chain loop). This note says what an operator runs,
with their own key, to put the money contracts on a network. No key is in this repository or in the script, and the script
reads none: the sender comes from the command line. `contracts/pot/deployments/` (where the script writes the addresses) is
git-ignored.

## What gets deployed

`script/DeployPot.s.sol` deploys, in this order: the dollar (PlayDollar on a test network, or an existing 6-decimal token
you name), `Parts` (the five implementations the Launcher clones: Treasury, Vester, Pair, the share token and the TaskBook), and the
`Launcher` with the platform settings (the dollar, who receives the platform fee, the fee, the time unit, the default daily
dollar limit of an agent), and, only when `HOLDER_PAUSE=1`, the holders' pause implementation bound to the Launcher. It writes `deployments/pot-<chainid>.json` with the addresses. Projects are then launched by
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
`holderPauseCodehash` the zero hash, when the switch was off). To check the result: call `Launcher.settingsHash()` and
`Launcher.platform()` and compare them with what you meant; launch a throwaway project and take a play dollar through the
faucet. `scripts/pot-chain-loop.sh` (repo root) does all of that against a local chain and is the reference for the calls.

## What is not done

No network has the contracts. The platform fee receiver, the admin and the dollar for a real network are the operator's to choose.
The server and the app do not read these contracts yet (build steps 1b to 1d); they still read `contracts/next`.
