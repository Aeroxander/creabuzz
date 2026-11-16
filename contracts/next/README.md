# contracts/next

Milestone 1 of `docs/NEXT-VERSION-PLAN.md`: a separate Foundry project that proves the Uniswap route (sale, then a
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

Layout: `src/` is the new code: milestone 1 (`FixedFeeController`, `MinBid`, `PoolGuard`, `HookSalt`) and milestone 2
(`ShareToken`, `Vester`, `Treasury`, `Launcher`, `RollingCap`, `Interfaces`); `test/helpers/` builds the Uniswap stack
(local twin or Sepolia fork) and a sale, and holds the milestone 2 base contract and invariant handler; `test/*.t.sol`
are the tests; `test/mocks/` holds a stand-in treasury, plain tokens, a dollar token that can misbehave and a call-back
attacker. Test compiles are slow (via-IR): `Deployer.sol` exists so each test file does
not recompile the whole Uniswap stack.

## Milestone 2: Shares, Treasury, Vester, Launcher

**This Launcher is for local tests only. Do not deploy it anywhere else.** It can start projects, but it has no way to move
the 500,000,000 Shares it holds for each project's sale and pool, so any project launched on it has half its Shares
locked for ever. Its constructor refuses any chain but 31337 (the local test chain) for that reason. Milestone 3 ships a
new Launcher; projects born on this one are not carried over. Its `opener` and `salePath` settings are plain addresses
(stubs with access control), and the admin can change them for new projects at will (a founder's `launch` carries the
hash of the settings they saw), so nothing real may be built on it while they stay plain addresses.

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
