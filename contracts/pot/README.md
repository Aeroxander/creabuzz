# contracts/pot

The money contracts of the join-and-leave design (`docs/next-version/JOIN-LEAVE-DESIGN.md`, build step 1). A separate
Foundry project: `contracts/next` is not edited, so the server and app that still read it stay green until they move over.
Library code is not copied: `lib` is a symlink to `../lib` (forge-std and OpenZeppelin 5), like `contracts/next/lib`.

## What is here

| File | What it is |
|---|---|
| `src/ShareToken.sol` | One token code, two instances: backer Shares and Team Shares. Only the Treasury mints and burns. |
| `src/PlayDollar.sol` | The dollar of the test network: faucet (1,000 once per account), `transferAndCall`. Test chains only. |
| `src/Treasury.sol` | The pot: join (Back), leave (Take out), quotes, settle, the daily allowance, check-in, rate, outside money, door, fees. |
| `src/Vester.sol` | Holds the whole Team pool. Grants with a clock each (active time, cliff 13 units inside 104), claim, forfeit with a notice of one unit, protected grants, the burns after a wind-down. |
| `src/Pair.sol` | The two-signer runner: every money call needs both, either signer alone may check in, `bothSigned()` is true only while a confirmed proposal runs. |
| `src/Launcher.sol` | Birth (two tokens, Treasury, Vester as clones), the platform settings and their hash, Pairs, `windDown(key)`. |
| `src/Parts.sol` | Makes the four implementations the Launcher clones. |
| `src/PotMath.sol` | The integer formulas the Treasury uses for quotes and actions alike. |
| `src/RollingCap.sol` | Copied unchanged from `contracts/next`: a limit on use in any stretch of time. |
| `model/` | The exact-decimal reference model the contracts are tied to by vectors. |

Parked for later passes and steps: invariants, fuzz, vectors and the deploy script (pass C), and the task queue, notice,
take, accept, return and exit notes (step 2).

## Run

```bash
cd contracts/pot
forge build --sizes     # Treasury must stay under 24,576 bytes
forge test
```

Units: dollars have 6 decimals, Shares and Team Shares 18. The time unit N is fixed at deployment (7 days on a real network).
