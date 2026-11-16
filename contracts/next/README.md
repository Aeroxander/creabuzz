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
SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com forge test   # adds the Sepolia fork suites
forge fmt --check src test
```

Layout: `src/` is the new code (`FixedFeeController`, `MinBid`, `PoolGuard`, `HookSalt`); `test/helpers/` builds the
Uniswap stack (local twin or Sepolia fork) and a sale; `test/*.t.sol` are the milestone's tests; `test/mocks/` holds
a stand-in treasury and a plain token. Test compiles are slow (via-IR): `Deployer.sol` exists so each test file does
not recompile the whole Uniswap stack.

The public Sepolia node keeps only about the last 10,000 blocks of history and a few dozen blocks of state, so a pinned
fork block (`SEPOLIA_PIN` in `test/helpers/Stack.sol`) is repeatable only from Foundry's cache under
`~/.foundry/cache/rpc` on the machine that first ran it. Elsewhere set `SEPOLIA_FORK_BLOCK` to a recent block (or use
an archive node). Nothing in the tests depends on which block it is.
