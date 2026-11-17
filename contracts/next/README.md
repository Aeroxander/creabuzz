# contracts/next

Milestones 1 to 3 of `docs/NEXT-VERSION-PLAN.md`: the Uniswap route (M1), Shares, Treasury, Vester (M2) and the whole sale into a
pool with the floor, the exit, fees and the way out of a pool that never opens (M3). Milestone 1 of `docs/NEXT-VERSION-PLAN.md`: a separate Foundry project that proves the Uniswap route (sale, then a
Uniswap v4 pool, then a trade) with a plain test token. It has its own `foundry.toml`, remappings, `out/` and `cache/`,
so the existing contracts in `../` (and the bytecode pinned in the desktop app) are untouched. Findings are in
`docs/next-version/M1-FACTS.md` and `docs/next-version/M1-REPORT.md`.

`lib` is a symlink to `../lib`, so the vendored Uniswap sources are used from where they already are (nothing is
cloned). All code compiles with solc 0.8.26, the version the vendored Uniswap code is pinned to.

```bash
forge build                     # first: the tests load the Deployer and Permit2 from their build output
forge test                      # local suites; the Sepolia fork suites skip with a message when SEPOLIA_RPC_URL is unset
SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com forge test   # adds the Sepolia fork suites (see the table below)
scripts/check-fork-degrades.sh   # checks the fork suites skip or move, not fail, on nodes that cannot serve the pin
forge fmt --check src test
```

Layout: `src/` is the code: milestone 3 (`Launcher`, `Finisher`, `LiquidityHolder`, `Pinned`), milestone 1 (`FixedFeeController`, `MinBid`, `PoolGuard`, `HookSalt`) and milestone 2
(`ShareToken`, `Vester`, `Treasury`, `RollingCap`, `Interfaces`); `test/helpers/` builds the Uniswap stack
(local twin or Sepolia fork) and a sale, and holds the milestone 2 base contract and invariant handler; `test/*.t.sol`
are the tests; `test/mocks/` holds a stand-in treasury, plain tokens, a dollar token that can misbehave and a call-back
attacker. Test compiles are slow (via-IR): `Deployer.sol` exists so each test file does
not recompile the whole Uniswap stack.

## Plan version 2, milestone 4: the money rules

`docs/PLAN-V2.md` section 9 row 4; report `docs/next-version/PLANV2-M4-REPORT.md`. New: `Rounds` (backing rounds at 3,000 Shares a
dollar, the 26-week release, the personal refund), `Pair` (the Team runner), `Parts` (the five implementations the Launcher's clones
copy). Rewritten: `Launcher` (birth 20/20/15/25/10/10, stage caps, the one auction of 250M Shares with a 100,000 minimum, the
stake, "no market", wind down, the reserve sale, the Council seam). Changed: `Treasury` (the runner seat, check-in by the runner,
the exit fee's 4 to spendable, Share revenue shared by every Share, the gift cap on Shares in hands, pause, wind down), `Vester`
(backer grants, the founder's trim), `MinBid` (the cap is 4 times the starting price, absolute). The milestone 3 sale tests below
now run at the one auction's size and open it through a Pair.

```bash
forge test --match-path 'test/{Rounds,RoundsFuzz,RoundsWorked,RoundsReentry,PairStages,GasM4}.t.sol'   # backing rounds, Team, stages
forge test --match-contract RoundsInvariantsTest                                                          # the rounds' invariants
forge test --match-path test/AuctionV2.t.sol -vv   # the one auction: 100,000 example, 10x demand, self-bid, Council, reserve sale
python3 scripts/mutate-guards.py --m4               # remove each milestone 4 guard once, see a test fail, put it back
```

## Milestone 3: the sale into a pool

`Launcher` (replaces the milestone 2 stub: no chain refusal, nothing a founder or an admin can point at a strategy, a guard, an
opener or a sale path), `Finisher` (one clone per project; holds the sale Shares, receives the sale's dollars, runs the
three-step finish, and is the only address the Treasury believes about the pool), `LiquidityHolder` (owns every pool position for
good; collects and splits trading fees), `Pinned.sol` (our fixed view of the vendored Uniswap code), and the Treasury's abandoned
state. **Nothing is deployed anywhere; a strategy and a pool guard must be mined to hook addresses per network** (see
`script/DeployPlatform.s.sol` and the report). The licence of the vendored strategy is still for counsel.

```bash
forge build                      # ALWAYS first: tests load the vendored contracts and our 0.8.26 files from their build output
forge test                       # the local suites (no RPC); fork suites skip with a message
SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com forge test   # adds the Sepolia fork suites
forge test --match-path test/PinnedDrift.t.sol   # the one version-drift test
python3 scripts/mutate-guards.py --m3            # remove each milestone 3 guard once, see a test fail, put it back
```

`forge test --match-path ...` compiles only what that path needs, so it can run against a stale build output of the 0.8.26
files (the Deployer, the fee controller, the bid hook, the guard) that the 0.8.37 tests load by path. After changing any of those,
run a plain `forge build` first.

## Milestone 2: Shares, Treasury, Vester (the Launcher of that milestone was replaced in milestone 3)

Milestone 2 files are first-party and need no Uniswap code, so they build with the repo's production compiler (solc
0.8.37, optimizer 200 runs, see the last restriction in `foundry.toml`) while the milestone 1 files and everything vendored
stay on 0.8.26. The two never share a compile unit; the Launcher reaches the pool guard through a one-function interface.
Report: `docs/next-version/M2-REPORT.md`.

```bash
forge test --no-match-path 'test/{Attacks,ForkFacts,ForkPick,Measure,Pieces,Route,UniversalRouter}.t.sol'   # milestone 2 only
forge test --match-contract TreasuryInvariantsTest      # the three written rules, 256 runs of depth 200
forge test --match-path test/Gas.t.sol -vv              # gas, printed
```

`block.timestamp` cannot be read after `vm.warp` in the same test (the optimizer reuses the first value); the tests use
`vm.getBlockTimestamp()` through `_now()`.

## Running the Sepolia fork suites elsewhere

The fork suites need `SEPOLIA_RPC_URL` set to a **live** node (forking contacts the node first, even when everything it
would read is cached). The public node keeps state for only a few dozen blocks and its back ends disagree about older
blocks, so the pinned block `SEPOLIA_PIN` (12,146,937, read on 16 November 2026) can be forked only from an archive
node, or from Foundry's local cache on the machine that first ran it. `test/helpers/ForkPick.sol` decides what to do:

| Situation | What the suites do |
|---|---|
| no `SEPOLIA_RPC_URL` | fork suites skip with a message; the local twin runs |
| the node does not answer | fork suites skip with a message (even if the cache holds the pin) |
| the node serves the pin (archive node, or a fresh pin) | fork at the pin |
| the node cannot serve the pin and no block is named | fork at a recent block (head minus 3) and say so; nothing in the tests depends on the block, but numbers quoted in the reports were read at the pin |
| `SEPOLIA_FORK_BLOCK` names a block the node cannot serve | fork suites skip with a message |
| `SEPOLIA_FORK_TRUST_CACHE=true` | fork at the pin (or the named block) without asking the node whether it serves it: only for a machine whose Foundry cache holds that block; a read the cache does not hold will fail the test with a database error |

`scripts/check-fork-degrades.sh` runs these situations against a real node and fails if any suite fails instead of
skipping; set `CHECK_CACHED_PIN=1` to add the cache-only repeat of the pin.

The pin's cache is **keyed to the machine and the Foundry build** (`~/.foundry/cache/rpc/sepolia/12146937`), filled by a
first run with a node that could serve it. This repo's cache was filled with `forge 1.4.3-v1.4.3` (commit `fa9f934`,
built 2025-10-22). Do not read "pinned" as "repeatable anywhere": it repeats where that file exists.
