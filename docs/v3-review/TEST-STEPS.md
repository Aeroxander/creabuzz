# How to test what was built, yourself

Agents exercised all of this (see [PROGRESS.md](PROGRESS.md)); the repository's rule is that a human then tests it
too. Every command below runs against a throwaway local chain and cleans up after itself. Nothing is sent to a real
network and nothing is pushed.

Set up once: `. ./bin/activate-hermit`, then make sure Foundry (`forge`, `cast`, `anvil`) is on your `PATH`.

## 1. The contracts

```bash
cd contracts && forge test
```

Working looks like: `313 tests passed, 0 failed, 1 skipped` (the skip needs a fork RPC). The fork checker and the
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

Working looks like: 8 passing browser tests. Then try it by hand:

```bash
just dev-chain                      # prints the kit address and a VITE_DAO_LAUNCH_KITS line
cd web && VITE_LAUNCHPAD_CHAIN_ID=31337 VITE_LOCAL_USDC=<dUSDC address from dev-chain> \
  VITE_DAO_LAUNCH_KITS='<the line dev-chain printed>' pnpm dev
```

Import anvil's first dev key into a browser wallet on chain 31337 (the dev-chain output lists it), open
`/launchpad`, press **Set up a sale**: "Project Shares" should be the selected token. Publish the launch, open it,
**Manage**, **Launch project**. Working looks like: three steps turn to Done, the page shows the DAO, its Shares and the
sale, and your wallet holds no Shares. Reload midway through a launch and the page offers **Finish saving**, never a
second launch.

## 4. The Work tab

```bash
scripts/web-work-e2e.sh
```

Working looks like: 1 passing test in which five different wallets file, take on, review, finish and collect a claim.

## 5. Cashtags

Post `Backing $NEB today` on a community that has a launch whose token symbol is `NEB`: the `$NEB` becomes a chip that
links to the launch and shows a price line only if bids exist. Hover or read its label: it says the price is a bid
price, not a market trade. An unclaimed `$ZZZ` and a price like `$5` stay plain text.

## 6. Everything else the agents ran

```bash
cd web && pnpm test && pnpm check && pnpm typecheck
cd desktop && pnpm test && pnpm typecheck
cd packages/creaton-core && pnpm test
cargo test -p buzz-cli --lib -p buzz-evm-allowance
node --test scripts/dev-chain.test.mjs scripts/simulate-voting-rules.test.mjs
```

Known failures that are not from this work (the 13 browser specs fail identically on the commit before it): in the
full mocked browser suite (`cd web && pnpm test:e2e:smoke`) 176 pass, 15 skip and 13 fail: `feed.spec.ts` "posts are
only copied to public relays…", six wiki/multi-user specs and five in `smoke.spec.ts`. Also the web file-size ratchet
on `WikiView.tsx` and `cargo clippy` findings in other crates.

When you are satisfied, adding the `buzz-review-completed` marker to a pull request description is yours to do.
