# Deployments

Nothing here has been deployed anywhere but a throwaway local chain (the chain loop). This note says what an operator runs,
with their own key, to put the money contracts on a network. No key is in this repository or in the script, and the script
reads none: the sender comes from the command line. `contracts/pot/deployments/` (where the script writes the addresses) is
git-ignored.

## What gets deployed

`script/DeployPot.s.sol` deploys, in this order: the dollar (PlayDollar on a test network, or an existing 6-decimal token
you name), `Parts` (the five implementations the Launcher clones: Treasury, Vester, Pair, the share token and the TaskBook), and the
`Launcher` with the platform settings (the dollar, who receives the platform fee, the fee, the time unit, the default daily
dollar limit of an agent). It writes `deployments/pot-<chainid>.json` with the addresses. Projects are then launched by
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

After a deploy, read `deployments/pot-<chainid>.json` for the addresses. To check the result: call `Launcher.settingsHash()` and
`Launcher.platform()` and compare them with what you meant; launch a throwaway project and take a play dollar through the
faucet. `scripts/pot-chain-loop.sh` (repo root) does all of that against a local chain and is the reference for the calls.

## What is not done

No network has the contracts. The platform fee receiver, the admin and the dollar for a real network are the operator's to choose.
The server and the app do not read these contracts yet (build steps 1b to 1d); they still read `contracts/next`.
