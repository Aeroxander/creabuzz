# contracts/next

Milestone 1 of `docs/NEXT-VERSION-PLAN.md`: a separate Foundry project that proves the Uniswap route (sale, then a
Uniswap v4 pool, then a trade) with a plain test token. It has its own `foundry.toml`, remappings, `out/` and `cache/`,
so the existing contracts in `../` (and the bytecode pinned in the desktop app) are untouched. Findings are in
`docs/next-version/M1-FACTS.md` and `docs/next-version/M1-REPORT.md`.

`lib` is a symlink to `../lib`, so the vendored Uniswap sources are used from where they already are (nothing is
cloned). All code compiles with solc 0.8.26, the version the vendored Uniswap code is pinned to.

```bash
forge build
forge test                      # local suite; the fork suite skips with a message when SEPOLIA_RPC_URL is unset
SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com forge test   # adds the Sepolia fork suite
forge fmt --check
```

The public Sepolia node keeps only about the last 10,000 blocks (about 33 hours), so the pinned fork block ages
out. Foundry caches what a run reads under `~/.foundry/cache/rpc`, so a pinned run repeats offline on the same
machine; elsewhere, set `SEPOLIA_FORK_BLOCK` to a recent block (or use an archive node).
