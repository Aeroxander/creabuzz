# Price indexer

Reads a Limit Break AMM's pools and swaps and keeps them as price candles, so the app can chart a project's Shares and
show the last trade beside a `$TICKER`. It is a [Ponder](https://ponder.sh) app, and it is **local evaluation only**: the
AMM is evaluation-only software (see `docs/v3-review/LBAMM.md`), so there is no network this is pointed at except a test
chain.

It is a separate package on purpose: it is not part of the pnpm workspace and installs on its own.

```bash
cd services/price-indexer
pnpm install --ignore-workspace
LBAMM_ADDRESS=0x… PONDER_RPC_URL=http://127.0.0.1:8545 pnpm dev      # serves on :42069
```

| Variable | Meaning |
|---|---|
| `LBAMM_ADDRESS` | The AMM to index. Required: there is no default, because indexing the wrong contract is worse than not starting. |
| `PONDER_RPC_URL` | The chain's RPC. Default: a local node. |
| `PONDER_CHAIN_ID` | The chain's id. Default: 31337. |
| `PONDER_START_BLOCK` | The block the AMM was deployed in. Default: 0. |

## What it serves

Public market data, readable from any origin:

- `GET /pools?token=0x…` — the pools that trade a token, newest first.
- `GET /candles?pool=0x…&interval=60|300|3600|86400&from=&to=&limit=` — the pool's candles, oldest first.

Prices are **token1 per token0 in base units**, and which token sorts first is decided by the addresses; the app turns
them into whole currency per Share (`packages/creaton-core/src/launchpad/marketFeed.ts`). A price is the price a swap
actually got, so it includes the fees that swap paid.

## Checking it

```bash
pnpm test                    # the price arithmetic
pnpm typecheck
```

`scripts/market-index-e2e.sh` runs the whole thing against a real local chain: trades, the indexer, and what its API
says about them (see `docs/v3-review/TEST-STEPS.md`).
