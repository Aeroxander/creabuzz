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

## 4d. Running a DAO from the app, no command line

```bash
scripts/web-decisions-e2e.sh        # a decision opened elsewhere is read, backed, waited out and run in the page
scripts/web-dao-journey-e2e.sh      # budget -> project -> claim -> review -> payout -> award, all in pages
scripts/web-paid-work-e2e.sh        # the same with money: a paid claim with a deposit, and the contributor is paid
LBAMM_DIR=~/lbamm-examples scripts/web-market-journey-e2e.sh   # a market voted in, traded on the launch page, fees collected, a payment out
```

Working looks like `1 passed` for each. To try it by hand, run `just dev-chain`, build the web app with the env lines it
prints (`VITE_LAUNCHPAD_CHAIN_ID`, `VITE_LOCAL_USDC`, `VITE_DAO_LAUNCH_KITS`, and for a market `VITE_LBAMM_ADDRESSES` from
a local LBAMM), launch a project, open it, and use **Decisions** → **New decision**. Each form shows, in plain words and
before anything is sent, what would happen; a decision needs enough Shares to open (the DAO's minimum is shown if you
hold less), then holders back it, the review and support periods pass, someone starts the wait, and someone runs it. On a
test chain you can move time with `cast rpc anvil_increaseTime <seconds>` then `cast rpc anvil_mine`.

## 4e. The product pass (2026-10-09)

```bash
cd web && pnpm test && pnpm check                       # 1,315 unit tests; lint, copy, px-text
cd web && pnpm build && pnpm exec playwright test --project=smoke org-setup.spec.ts launchpad.spec.ts projects.spec.ts
E2E_TOUR=/tmp/tour pnpm exec playwright test --project=smoke tour.spec.ts   # one PNG per first-run page and step
scripts/web-dao-journey-e2e.sh                          # E2E_SHOTS=/tmp/dao saves the DAO's pages as PNGs
cargo test -p buzz-core -p buzz-relay -p buzz-cli -p buzz-db --lib --bins --tests
DATABASE_URL=postgres://buzz:buzz_dev@localhost:5432/<a copy of your dev database> cargo run -p buzz-admin -- migrate
```

By hand: open **Communities** on a server where you are the owner, then **Org**: you are offered "Start your
organization"; answer four short questions and the chart appears. Open a graduated project: it opens on "Where things
stand" and "Needs you", and the raise is folded under "About the raise this project came from".

## 4f. Boards and decision threads (2026-10-10)

```bash
cd web && pnpm test && pnpm check
cd web && pnpm build && pnpm exec playwright test --project=smoke board.spec.ts start-project.spec.ts
scripts/web-discussion-e2e.sh        # a REAL local chain: a discussion under a decision, its live state and the author's Shares
cargo test -p buzz-cli --lib templates   # the command line reads the same templates (boards, private channels)
```

By hand (a local server, `just relay-web`): open a community, press **New board** in the sidebar, post, reply, vote on
the post, then change the vote and press it again to take it back, and reload: the score must stay at zero. Open
**Start a project**, pick a team, and check the community now has a supporters board and a private founders board, each
with a first post. On the founders board press **People** and add someone by pasting their npub. On a project's
**Decisions** tab press **Start a discussion** under a decision, then open it from the list: the header must show where
the decision stands, and the board's votes must be labelled as not the DAO's vote. The proposal post must have no vote
arrows and show a state pill in the board's list; **Proposals** orders live decisions first. On the decision press **Copy
link** and paste it into a chat message or a post: a live card appears under it, and its button opens the Decisions tab
with that decision outlined.

## 4g. The track record (2026-10-12)

```bash
cd web && pnpm test && pnpm check
cd web && pnpm build && pnpm exec playwright test --project=smoke   # the DAO front page now uses the shared Figure
scripts/web-milestone-e2e.sh   # a REAL local chain: the team's milestones, who approved the claim, dates (no wallet)
scripts/web-record-e2e.sh      # a REAL local chain that moved MONEY: set aside, paid, waiting, a claim turned down
```

By hand (a local server and chain): open a project that became a DAO, press **Track record** (or **Open the track record** on
the front page). With **no wallet connected** you must see: the treasury balance, what the DAO set aside for work, what
was paid and what is waiting, the team's milestones (reached ones with a date), and a list of what happened with the
newest first. Press **Payments**: only the payments stay. Press **Copy link**, open it in a private window: same page.
Compare any figure with the contracts under **Technical details**: they must match. A team member who bound their wallet
on this server shows as `Name (0xabcd…1234)`; one who did not shows only the address.

## 4h. One door to start, and three sizes for a raise (2026-10-12)

```bash
cd web && pnpm test && pnpm check
cd web && pnpm build && pnpm exec playwright test --project=smoke home-checklist.spec.ts launchpad-presets.spec.ts
```

By hand: press **Start** in the top bar (on a phone, **All the ways to start** at the top of Home). The four steps must
appear in order with the first one marked **Next**. Press **Share an idea**: the idea dialog opens, and reloading the page
must not open it again. Publish an idea, come back to Start: the idea step says **Done** and **Raise money** is next. On
an idea press **Prepare the sale**: three sizes (**Small**, **Standard**, **Large**) appear above the target; pick one and
the target and sale length change, type your own target and no size stays highlighted. Open **Set up a sale** from the
Launchpad: the same three sizes are on the Raise step, and switching to ETH shows them in ETH.

## 4i. Starting a community of your own (2026-10-12)

```bash
cargo test -p buzz-relay --lib self_serve -- --include-ignored     # the server's rules (needs Postgres)
cd web && pnpm test && pnpm build && pnpm exec playwright test --project=smoke community-create.spec.ts
scripts/web-self-serve-e2e.sh      # REAL server on a scratch database + a real browser, nothing mocked
```

By hand: start the server with `BUZZ_SELF_SERVE_COMMUNITY_DOMAIN=localhost:3000` and `RELAY_OPERATOR_API_ORIGIN=http://localhost:3000`
(see `docs/self-serve-communities.md`), open `/c`, press **Create a community**, type `My Film`: the address must read
`my-film.localhost:3000`. Create it: you land in an empty community that says **Nothing here yet**. Press **Set up
community**, keep the team, press the setup button: **33 of 33 done** under **What was set up**. Try `login` (refused as
kept for the service), a 2-letter name (refused), and the same name from another browser (taken).

## 4j. Holding age on the portfolio (2026-10-13)

```bash
forge test --root contracts --match-contract HoldingAgeTest         # the ledger (the whole suite also runs the sale journey)
cd web && pnpm test && pnpm build && pnpm exec playwright test --project=smoke portfolio.spec.ts
scripts/web-milestone-e2e.sh    # a REAL local chain: the founder's portfolio shows the Shares, how long, and what is locked
```

By hand (a local chain with a project launched through the kit): connect the founder's wallet and open **Portfolio**. **What
you hold** must list the DAO with the team's Shares, how long they have been held, and how many are still locked behind
milestones. Send some Shares to a second wallet: that wallet shows them as held for "less than a day", and the first
wallet's time does not change.

## 4k. Private communities and invite links (2026-10-13)

```bash
cargo test -p buzz-relay --lib -- --include-ignored --test-threads=1 community_access relay_admin self_serve nip11   # the rules (needs Postgres)
cargo test -p buzz-db --lib -- the_public_directory --test-threads=1
cd web && pnpm test && pnpm build && pnpm exec playwright test --project=smoke community-access.spec.ts community-create.spec.ts
scripts/web-invite-only-e2e.sh      # REAL server on a scratch database + a real browser, nothing mocked
```

By hand (server started as in 4i, with `BUZZ_REQUIRE_RELAY_MEMBERSHIP=false`): create a community and leave **Only people I invite**
selected. Open **Org**: **People and access** shows you as the only person. Press **Make invite link** (1 week, one person) and copy it.
In a second browser (a different profile, so it is a different person) open `http://<name>.localhost:3000/c/<name>.localhost:3000`: it says **This
community is invite-only**. Open the invite link there and press **Join in browser**: the community opens, and your **Org** page now
lists two people. Use the same link in a third browser: it says the invite has reached its use limit. Back as the owner pick
**Anyone with the address** and confirm: the third browser, reloaded, gets in. Pick **Only people I invite** again: the warning says people who
are not on the list are signed out right away; confirm, reload the third browser: invite-only again, while the second browser (invited) is
still in. The Communities page (with `BUZZ_PUBLIC_COMMUNITY_DIRECTORY=1`) never lists the community while it is private.

Then: make another link (**Anyone who has it**): it appears under **Invites that still work** as "0 used". Press **End invite** and
open that link in a fourth browser: it says the invite has expired. Make a fresh one-person link, join with it in a fifth browser,
then as owner press **Remove** next to that person and confirm: the list drops them, and reloading their browser shows the
invite-only notice again.

## 4l. Reporting (2026-10-13)

```bash
cd web && pnpm test && pnpm build && pnpm exec playwright test --project=smoke report.spec.ts
scripts/web-invite-only-e2e.sh      # includes report.spec.ts: a member reports a post, the owner sees it in Moderation
```

By hand (an owner and one invited person, as in 4k): the owner posts on **Social**. The invited person sees **Report** under it (the owner's
own post has none), picks **Spam or a scam**, adds a note and sends: "Thanks. The moderators have been told." The post is still there. As the
owner open the community and press **Moderation** in the sidebar: one report shows "Spam", the note, and who sent it.

## 4m. Markets (2026-10-13)

```bash
cd web && pnpm test && pnpm build && pnpm exec playwright test --project=smoke markets.spec.ts   # the standard build: no price service
scripts/web-markets-e2e.sh      # a build pointed at a stand-in price service; run `pnpm build` after it
scripts/web-market-e2e.sh       # the REAL chain and price indexer (needs LBAMM_DIR); also visit /markets afterwards
```

By hand (a local chain with a project launched through the kit and its Shares put on the AMM, the indexer running and the app built with
`VITE_PRICE_INDEXER_URL`, as in 4h): open **Launches**, press **Markets**. Each project that graduated is a row; the one that traded shows
its last price, "+x% today" (or a fall), what was traded today and a small chart; one with no trades says "Not traded yet". Switch **Sort by**
between **Most traded**, **Biggest move today** and **Newest**. **Track record** under a name opens that project's record. Without the
price-service address in the build the page says prices are not available and lists the projects without prices.

## 4n. Error reporting (2026-10-13)

```bash
cd web && node --experimental-strip-types --test src/shared/lib/error-report.test.mjs
scripts/web-error-report-e2e.sh      # a real browser and a stand-in collector; run `pnpm build` after it
```

By hand: build with `VITE_ERROR_REPORT_URL=http://localhost:9000/errors`, run any listener on that port (for example `nc -l 9000`), open the
app, and in the browser console run `setTimeout(() => { throw new Error("test") })`: one small JSON note arrives with the page's path and no
query string. Without the setting set, nothing is sent.

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

Expected results: the full mocked browser suite (`cd web && pnpm test:e2e:smoke`) is 194 pass, 26 skip (they need a
local chain) and 0 fail, including `first-run.spec.ts`; `just file-size-check` passes. `cargo clippy` still reports
older findings in other crates.

When you are satisfied, adding the `buzz-review-completed` marker to a pull request description is yours to do.
