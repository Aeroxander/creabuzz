# How to test what was built, yourself

Agents exercised all of this (see [PROGRESS.md](PROGRESS.md)); the repository's rule is that a human then tests it
too. Every command below runs against a throwaway local chain and cleans up after itself. Nothing is sent to a real
network and nothing is pushed.

Set up once: `. ./bin/activate-hermit`, then make sure Foundry (`forge`, `cast`, `anvil`) is on your `PATH`.

## 1. The contracts

```bash
cd contracts && forge test
```

Working looks like: `339 tests passed, 0 failed, 1 skipped` (the skip needs a fork RPC). The fork checker and the
Moloch size check:

```bash
node scripts/check-majeur-fork.mjs
cd contracts && forge build --sizes | grep -E "Moloch "
```

Working looks like: `ok` and a Moloch runtime size of 24,529 of 24,576 bytes.

## 2. A project that never raised, with the command line alone

```bash
scripts/cli-no-raise-e2e.sh
```

Working looks like: a list of steps ending in `PASS: work with no money in it earned 25 Shares through the CLI alone`.
It includes three refusals you can read in the script: a reviewer cannot approve their own claim, a claim filed by
someone else is not bound, and an award above the project's allowance fails.

## 3. Launching a project into its own DAO, in a browser

```bash
scripts/web-dao-launch-e2e.sh
```

Working looks like: 8 passing browser tests, including that the founder ends up holding the team's Shares (they vote
with them) while the lock reports them locked and a transfer from the founder's wallet is refused. Then try it by hand:

```bash
just dev-chain                      # prints the kit address and a VITE_DAO_LAUNCH_KITS line
cd web && VITE_LAUNCHPAD_CHAIN_ID=31337 VITE_LOCAL_USDC=<dUSDC address from dev-chain> \
  VITE_DAO_LAUNCH_KITS='<the line dev-chain printed>' pnpm dev
```

Import anvil's first dev key into a browser wallet on chain 31337 (the dev-chain output lists it), open
`/launchpad`, press **Set up a sale**: "Project Shares" should be the selected token. Publish the launch, open it,
**Manage**, **Launch project**. Working looks like: three steps turn to Done, the page shows the DAO, its Shares and the
sale, and your wallet holds the team Shares (the milestone-tied part says it is locked). Reload midway through a launch and the page offers **Finish saving**, never a
second launch.

## 4. The Work tab

```bash
scripts/web-work-e2e.sh
```

Working looks like: 1 passing test in which five different wallets file, take on, review, finish and collect a claim.

## 4a. The team's milestone lock, from launch to unlock

```bash
scripts/cli-milestone-e2e.sh      # the command line, on a real local chain
scripts/web-milestone-e2e.sh      # the Work tab's Unlock button, in a browser
```

Working looks like: `PASS: the team's Shares were theirs to vote with, locked until a reviewed milestone freed exactly its
part`, and 1 passing browser test. Read the script to see the sequence: a project is launched through the kit, the founder
passes the DAO's own votes with locked Shares, a transfer and a ragequit of locked Shares are refused, a milestone claim
is approved by reviewers, **a stranger** sends the unlock, exactly the first milestone's part moves (and can be taken
out of the DAO: the same call the lock refused before), and the founder holds a badge that cannot be transferred.

By hand, after a `scripts/cli-milestone-e2e.sh`-style world, `buzz launchpad work locks --dao <dao>` lists each milestone
with its state and what to do next.

## 4b. Shares as an apptoken

```bash
scripts/shares-erc20c-e2e.sh
```

Working looks like: `PASS: Shares are an apptoken under Limit Break's real validator…`. It uses the real canonical
transfer validator the dev chain bootstraps, and every setting is chosen by a DAO vote through the CLI.

## 4c. Shares on a market, and the prices from it (local evaluation only)

The Limit Break AMM is evaluation-only software, so this needs a clone of it **outside this repository** (details in
[LBAMM.md](LBAMM.md)), and one install of the price indexer:

```bash
git clone --recurse-submodules https://github.com/limitbreakinc/lbamm-examples.git ~/lbamm-examples
export LBAMM_DIR=~/lbamm-examples
(cd services/price-indexer && pnpm install --ignore-workspace)

scripts/cli-market-e2e.sh
scripts/market-index-e2e.sh
scripts/web-market-e2e.sh
```

Working looks like: `PASS: the DAO's Shares trade on the AMM, the lock still binds, and the fee reaches the treasury`;
`PASS: the indexer turned the AMM's trades into candles, live`; and 2 passing browser tests. Read the first script for the
sequence: the DAO votes a market for 100,000,000 Shares at \$0.01, a buyer trades in, a founder whose Shares are locked is
refused (a holder with free Shares sells with the very same command), and the fee the hook charged reaches the treasury by
a second vote. The browser tests show the launch page charting the traded prices and a `$NEB` in a post showing the last
trade, each labelled as what it is.

## 5. Cashtags

Post `Backing $NEB today` on a community that has a launch whose token symbol is `NEB`: the `$NEB` becomes a chip that
links to the launch and shows a price line only if bids exist. Hover or read its label: it says the price is a bid
price, not a market trade. Once the token trades and a price service is configured it shows the last trade instead (4c). An unclaimed `$ZZZ` and a price like `$5` stay plain text.

## 6. Everything else the agents ran

```bash
cd web && pnpm test && pnpm check && pnpm typecheck
cd desktop && pnpm test && pnpm typecheck
cd packages/creaton-core && pnpm test
cargo test -p buzz-cli --lib -p buzz-evm-allowance   # includes the lock commands, calldata pinned to cast
node --test scripts/dev-chain.test.mjs scripts/simulate-voting-rules.test.mjs
```

Known failures that are not from this work (the 13 browser specs fail identically on the commit before it): in the
full mocked browser suite (`cd web && pnpm test:e2e:smoke`) 176 pass, 15 skip and 13 fail: `feed.spec.ts` "posts are
only copied to public relays…", six wiki/multi-user specs and five in `smoke.spec.ts`. Also the web file-size ratchet
on `WikiView.tsx` and `cargo clippy` findings in other crates.

When you are satisfied, adding the `buzz-review-completed` marker to a pull request description is yours to do.
