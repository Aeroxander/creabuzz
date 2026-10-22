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

Working looks like: `ok` and a Moloch runtime size of 24,575 of 24,576 bytes (solc 0.8.37 since D70; it was 24,529 with
0.8.30). If forge says "No solc version exists that matches the version requirement: …, =0.8.37", your forge predates
that compiler: run `scripts/ensure-solc.sh` once.

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

Working looks like: 1 passing test in which five different wallets file, take on, review, finish and collect a claim, and
a reviewer then takes their bond back (D48). By hand as a reviewer on a bonded panel: on the Work tab press Ask for my bond
back, see "on its way back" with a date, and no button to take it; once the chain's clock is 14 days on (`anvil_increaseTime`
1,300,000 and mine a block) reload, press Take my bond back, and the bond card goes away.

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

**An interrupted milestone submission (D49).** Start submitting a milestone and cancel the wallet's second prompt (or close
the tab after the first). Reload: the milestone row says "Your last submission is not finished. Still to do: ...", shows
the text you wrote, and Continue submitting finishes the same claim (no second claim appears on the Work tab) and the
reviewers can read the evidence. Start over discards it.

**Submitting a milestone and reading the evidence (D45).** In the browser journey the founder submits the second milestone
from its own row on the Locked Shares card: an empty box is refused before the wallet is asked, then one box and one button
file the claim, name the milestone and send it to the panel's reviewers (three wallet confirmations, no vote and no project
manager). Working looks like: the row says "With the reviewers: 0 of 2 approvals" and the Shares stay locked. On the Work tab,
a reviewer sees "Evidence submitted" and the words it is judged against, with a line saying they match what the claim
committed to. A claim whose text was never published shows "No evidence has been published for this claim" and offers no
Approve button (Object stays); the person who filed it can publish the text again from that box.

### Holding a budget to account (D50)

```bash
scripts/web-economy-e2e.sh
```

Working looks like: 1 passing test. By hand as a holder on the DAO's Decisions tab: New decision, then Freeze a claim (pick an
approved claim inside its challenge window), put it to a vote, back it, let the waits pass, run it: the claim reads Frozen and
the contributor is offered no payout. Then Unwind a frozen claim: it reads Recovered, the contributor's deposit is back and
nothing was paid. Take a reviewer's bond and Close a work budget work the same way; closing returns what was not set aside to
the treasury. On the DAO's Overview, "Where the treasury's money went" splits reviewed budgets from direct payments, and a
direct payment's decision card is marked "No reviewer".

### The milestones, as a backer (D55)

With no wallet connected, open a milestone project and its Milestones tab (`?tab=milestones`). Working looks like: each milestone shows its words, how many tokens it holds back and where it stands; a milestone with the reviewers shows each reviewer as approved, objected or not having decided; an approved one shows when anyone can still object; the evidence the team submitted opens under each submitted milestone; the page says what the lock does not do, and what the team said about how its reviewers will work. The project Overview opens with the milestones and a link to this tab; after the sale the DAO's front page shows each milestone's stage. A wallet that was named a reviewer at launch (with no Shares) sees "Post your bond" under Waiting on you on Home, and the link opens the Work tab. On Home, signed in, a new account sees the backer list (look at a project, follow or back one); switching to "I'm building a project" shows publish and set up the funding agreement, with the workspace and helper marked optional.

### The failure cases (D54)

```bash
scripts/test-mvp-gate.sh          # the journey runner touches only what it started
scripts/mvp-gate.sh web-economy-e2e web-milestone-e2e
```

Working looks like: the economy journey makes the sale's currency unreadable once and checks no exit is offered until it can be read again, has a reviewer ask for their whole bond back and checks the DAO can still take part of it, and ends with a backer leaving for exactly the amount shown. The milestone journey makes the browser refuse to save the draft and checks nothing is sent. By hand: on the Decisions tab, Close a work budget with paid work still waiting for Shares and read the amber note before voting; open a freeze from a claim card, let that claim be paid in another tab, and check the form says the claim is no longer open instead of showing another one.

### Doubting a claim (D52)

On the Work tab, as anyone, find a claim that is still being judged or approved and inside its challenge window. Working looks like: under the claim, "Doubt this claim?" and a "Put a freeze to a vote" button; pressing it opens the Decisions tab with the freeze form open and that claim chosen. A claim past its challenge window or already paid shows no such line.

### Leaving the DAO with your share (D51)

By hand as a holder with Shares on a finished launch, on the Treasury tab: "Leave and take your share" lists the Shares you would give up, what you would take back now, and, if you are on a milestone-locked team, how many Shares stay locked. Working looks like: the amount you would take back is your Shares divided by the Shares held by everyone except the DAO, times the treasury; a holder whose Shares are all still locked sees "All of your shares are still locked" and no button; confirming the exit pays that amount and the record appears on the project.

The economy journey (`scripts/web-economy-e2e.sh`) ends with a backer leaving: it works out what the treasury owes from the chain's own numbers (their Shares over everything outstanding except the DAO's), checks the screen shows that, runs the exit, and checks their wallet received exactly that amount.

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

By hand (server started as in 4i, with `BUZZ_REQUIRE_RELAY_MEMBERSHIP=false`): press **Create community**. The dialog offers two buttons side by
side, **Anyone with the address** (already chosen) and **Only people I invite**; press the second, then create. Open **Org**: **People and access** shows you as the only person. Press **Make invite link** (1 week, one person) and copy it.
In a second browser (a different profile, so it is a different person) open `http://<name>.localhost:3000/c/<name>.localhost:3000`: it says **This
community is invite-only**. Open the invite link there and press **Join in browser**: the community opens, and your **Org** page now
lists two people. Use the same link in a third browser: it says the invite has reached its use limit. Back as the owner pick
**Anyone with the address** and confirm: the third browser, reloaded, gets in. Pick **Only people I invite** again: the warning says people who
are not on the list are signed out right away; confirm, reload the third browser: invite-only again, while the second browser (invited) is
still in. The Communities page (with `BUZZ_PUBLIC_COMMUNITY_DIRECTORY=1`) never lists the community while it is private, and lists it once it is open.
A community made without touching the choice is open: it is listed, and a stranger can look around and post without an invite.

Open an invite link in a browser with no account at all (a private window): it asks for a name and offers **Create an account and join**. Press it:
the community opens, and the owner's **People and access** lists the newcomer by that name.

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

## 4o. Who holds the Shares (2026-10-13)

```bash
cd web && node --experimental-strip-types --test src/features/launchpad/lib/holders-read.test.mjs
scripts/web-record-e2e.sh      # REAL local chain: the card's figures are checked against the chain (needs forge, anvil, a built buzz CLI)
```

By hand (a local chain with a project launched through the kit, as in 4g): open the DAO's **Track record**. **Who holds the Shares** lists the
largest holders: the team's wallet shows its share of all Shares, "held for …", and "x Shares held back until milestones are reached". Send
some Shares to a second wallet: it appears with "held for less than a day", and the first wallet's time does not change. A DAO made before
holding times were kept shows holdings without times.

## 4p. Waiting on you, on Home (2026-10-13)

```bash
scripts/web-decisions-e2e.sh      # REAL local chain: Home lists the open decision, its button opens it
```

By hand (a local chain with a project launched through the kit and a decision opened, as in 4f, and the founder's wallet connected): open **Home**.
**Waiting on you** lists the DAO's name and "Open for your vote: …" with a **Vote** link that opens the decision. Back it until it is no longer
open for votes: the line goes away. With no wallet connected, or no DAO, the section is not there at all.

## 4q. Names instead of keys (2026-10-13)

```bash
cd web && pnpm build && npx playwright test --project=smoke tests/e2e/passkey.spec.ts tests/e2e/report.spec.ts
```

The passkey spec uses a virtual authenticator, so no real passkey is needed. By hand: on a fresh browser, **Create account**, type a name, then choose
**Continue with a passkey**. After the page reloads, open the account menu and **Edit profile**: the name you typed is already there, and a post you
make shows that name, not a string of letters and numbers. (Before this, the passkey and wallet routes kept the name only as the passkey's own label.)
Signed in as a moderator, **Moderation** shows "Reported by" followed by the reporter's name. A person who never set a name still shows as a short
key everywhere; the reminder on Home to add a name stays until they do.

## 4r. Banning people (2026-10-13)

```bash
cd web && pnpm build && npx playwright test --project=smoke tests/e2e/community-access.spec.ts tests/e2e/report.spec.ts
scripts/web-invite-only-e2e.sh -g "banned person"   # REAL server and browser; needs Postgres and Redis
```

By hand, as the owner of a community with two people in it: **Org**, **People and access**. Each other person has **Ban** next to Remove. Press it:
the form says they are signed out right away, cannot get back in even with an invite link, and are told your reason. Choose **7 days**, type a reason,
**Ban**. **Banned (1)** appears under the list with the time left and your reason. In the other person's browser, reload: the page says "You are
banned from this community" and offers nothing to retry; opening the invite link again does not help. Press **Lift ban**: they can use the community
again. An admin is offered Ban only for members, never for the owner or another admin; a member is offered none. In an open community, a message and
a post by someone who is not on the list have **Ban** too (owner and admins only).

## 4s. Linking a passkey account as a payment wallet (2026-10-14)

```bash
node scripts/kernel-1271-live-check.mjs      # a REAL deployed Kernel 0.3.3 account on Sepolia judges the proof (read-only, public RPC)
scripts/web-passkey-wallet-e2e.sh            # real browser, virtual passkey, a stand-in chain that judges like the validator
cargo test -p buzz-evm-auth --features rpc --lib
cargo test -p buzz-relay --lib -- evm_binding smart_account the_account_decides a_revocation_by_a_smart
```

By hand (a build with `VITE_ZERODEV_CHAIN_ID` and a chain RPC set, a server with `BUZZ_EVM_AUTH=1`, `BUZZ_EVM_RPC_URL` and `BUZZ_EVM_CHAIN_ID`): sign up
with a passkey, open your profile, **Link payment wallet**, tick the box. A second button, **Sign with my passkey account**, is there next to the
browser-wallet one. Press it: one passkey prompt, then the card shows your account's address with "Both signatures verified". On a first-time account
the app creates it first, with one sponsored empty operation. Turn the network off and reload: the card says the check could not be made just now and
shows no address and no Copy button. **Remove public wallet** withdraws it without any chain call.

## 4t. A small economy, run by several people at once (2026-10-14)

```bash
scripts/web-economy-e2e.sh            # REAL server + REAL chain + three browsers at once; needs Postgres, Redis and foundry
node --experimental-strip-types --test web/tests/helpers/key-wallet.test.mjs web/tests/helpers/key-wallet-anvil.test.mjs
```

The script boots a throwaway dev chain, a scratch database with the real relay in front of it (its own community at its address, self-serve
communities on, wallet sign-in on the chain's id) and the web app built against both, then plays a founder, a labor contributor and a capital
contributor, each in a browser of their own with a brand-new account made in the app and a brand-new private-key wallet that signs for
itself. They make a community, link their wallets, launch a project into its own DAO from the wizard, bid and graduate the sale, vote a work
budget and a project, file and review a claim, and the labor contributor is paid from the treasury. It takes about 30 seconds.
`E2E_SHOTS=<dir>` saves screenshots of the steps. The passkey path is not in it (a dev chain has no Kernel or bundler): see 4s.

By hand, the same story: open the app on a fresh server, **Sign up** with a name before any community exists (it works: the name is kept), make a
community, and in two other browsers open its address and **Join in browser**: each person's name shows in the community (a profile follows
the person into a community that has none for them). In the wizard, leave the track alone: a project that will be a DAO is on the open sale, so
**Launch project** works without hunting for the setting.

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

## 4u. Ideas from the boards (2026-10-14)

```bash
scripts/web-invite-only-e2e.sh        # REAL server; its last spec is board-ideas.spec.ts. Needs Postgres and Redis.
cd web && pnpm build && npx playwright test --project=smoke board-ideas.spec.ts   # the mocked specs (5)
node --experimental-strip-types --test web/src/features/fleet/lib/task-source.test.mjs
```

The real-server spec makes a community and its two starter boards, has a member post an idea on **supporters**, and has the owner open **Work**,
open **Ideas from the boards**, press **Make a task** (reward 20, so the credit for the author defaults to 2) and move the task to Done. The member
sees the note under their post ("1 reply"), their own page lists the task as done with **Claim 2 points**, the claim is taken, and after a reload a
second claim is refused ("This credit has already been claimed."). About 9 seconds.

By hand: as one person, post an idea on a board; as another (the owner or a team member), open **Work**, **Ideas from the boards**, find it, **Make a task**.
You are not offered your own posts. As the first person, open **Work**: **Your suggestions** shows the task; when it is done, **Claim N points** appears.
Someone else never sees that button. The claim shows up in the contribution review like any other. Move the task to Done at least a second after making it
(task rows are stamped to the second, and a tie goes to the lower id).

## 4v. Who holds the IP (2026-10-14)

```bash
cd web && pnpm build && npx playwright test --project=smoke launchpad-ip-record.spec.ts   # 6 mocked browser tests
node --experimental-strip-types --test web/src/features/launchpad/lib/ip-record.test.mjs web/src/features/launchpad/lib/record-input.test.mjs
```

By hand: open a launch you made (**Launchpad**, your project). Under the raise terms, **Who holds the IP** says the project has not said who holds its IP.
**Edit**: it starts on *No entity yet: the founders hold it*. Fill in a title, an https link and a fingerprint (or choose the file and the fingerprint
fills itself) and **Save**: the card now says the founders have committed to assign it, and shows the document with its fingerprint. Choose *A legal entity
holds it*, name it and its place, and link an assignment: it says the IP is to be assigned when the raise completes, and *assigned* only once the sale has
graduated. It never says holders own anything except when the entity's operating agreement is linked, and then it says that is the project's statement.
A half-filled document is refused. Someone who is not the author sees the card and no **Edit**. Check that saving kept the rest of the launch: the Manage tab's
legal wrapper and the sale's contract links are unchanged.

## 4w. Reviewer independence and the reviewer bond (2026-10-15)

```bash
cd contracts && forge test --match-path 'test/ReviewerBond.t.sol'     # 11 tests, each guard mutation-checked
scripts/web-work-e2e.sh                                               # REAL chain: reviewers post a 25 bond in the page, then approve
scripts/web-economy-e2e.sh                                            # REAL server + chain: a wizard-launched DAO, a one-reviewer panel that posts a 100 bond
cd packages/creaton-core && node --experimental-strip-types --test src/launchpad/work.test.mjs src/launchpad/workRead.test.mjs src/launchpad/daoActions.test.mjs
```

By hand: on a launched DAO's **Decisions** tab choose **Work budget**, name a reviewer and fill **Bond each reviewer must post**: the summary beside the
vote says "Each reviewer posts a bond of N" (or "Reviewers post no bond"). Name the founder as a reviewer on a DAO with milestone-locked team Shares and the
vote cannot run: the contract refuses a team member on the panel. Once the budget exists, the **Work** tab lists the panel ("bond not posted yet"), and
the reviewer sees "Post my bond" and no Approve until they have posted it (an approval, then the bond: two wallet confirmations). Asking the bond back
(`requestUnbond`, then `withdraw` after 14 days) and the DAO slashing it (`slashReviewer`) are contract functions with no screen yet.

## 4x. A Sepolia testnet (2026-10-15)

```bash
scripts/sepolia-deploy.sh                       # rehearsal on a local fork of Sepolia: no key, nothing public changes
cd contracts && forge test --match-contract 'SepoliaLaunchForkTest|DeployLaunchKitTest' --fork-url https://ethereum-sepolia-rpc.publicnode.com -vv
scripts/web-sepolia-fork-e2e.sh                 # three browsers play a founder, a worker and a backer on the fork, incl. a bonded reviewer
cd web && node --experimental-strip-types --test src/features/launchpad/chain.test.mjs src/features/launchpad/lib/log-pages.test.mjs
```

Without a fork URL the Forge fork tests skip rather than fail. By hand, once you have put `SEPOLIA_RPC_URL` and a testnet-only `DEPLOYER_PRIVATE_KEY` in `.env`
(see `docs/sepolia-testnet.md`): `scripts/sepolia-deploy.sh --broadcast`, build the web app with the settings it prints, host it with the server, and walk the story once:
make a community, launch a project, back it from a second browser (Circle's faucet gives test USDC), open **My bids**, exit and claim. The market card should say the
exchange could not be verified and offer nothing.

## 4y. The bond can be paid in any token the vote names (2026-10-15)

```bash
cd contracts && forge test --match-contract ReviewerBondTest        # 13 tests: bond in another token, a slash pays in that token, a bond and its token come together
cd packages/creaton-core && node --experimental-strip-types --test src/launchpad/daoActions.test.mjs src/launchpad/workRead.test.mjs
scripts/web-economy-e2e.sh                                          # the reviewer posts a bond in the project's own Shares, from the page
```

By hand: on **Decisions** choose **Work budget**, fill **Bond each reviewer must post**, and open **Bond paid in**. The sale currency is marked recommended;
**The project's own token** and **Another token** each show a plain warning, and the summary beside the vote says which token ("a bond of 100 of the project's own
token"). Paste a token address under **Another token**: the form reads its decimals, and says so if the address is not a token on this network.

## 4z. The milestone panel is named in the launch, and the lock cannot be voted away (2026-10-15)

```bash
cd contracts && REQUIRE_CONTRACT_ARTIFACTS=true forge test         # whole suite (the kit tests need every artifact): 347 pass
scripts/web-dao-launch-e2e.sh                                       # REAL chain: the launch is refused until reviewers are named, a team member is refused, the panel is on chain
scripts/web-economy-e2e.sh                                          # REAL server + chain: the Work tab lists the milestone panel with its bond
scripts/cli-milestone-e2e.sh && scripts/web-milestone-e2e.sh        # REAL chain: a milestone is judged by the launch's panel and unlocks the founder's Shares
```

By hand: open **Manage** on a launch whose team Shares are locked behind milestones. **Who judges your milestones** appears above the Launch button and the button
stays off until you name reviewers outside your team (picked by name, or pasted). Reload before launching: what you typed is still there. After launching, the **Work**
tab lists **Milestone panel**, with its reviewers and bond. To approve a milestone project, **Decisions** ▸ **Approve a work area** ▸ choose the milestone panel: it asks
which milestone, not for Shares or words. Try the three things a vote cannot do (they are contract rules, tested in Forge): set the lock guard again, name a second
panel, or unlock a milestone through any other budget.

## 4aa. Nothing can be voted on during the sale (2026-10-16)

```bash
cd contracts && REQUIRE_CONTRACT_ARTIFACTS=true forge test         # whole suite; the kit tests include the sale-boundary drain and the once-only setter
scripts/web-dao-launch-e2e.sh && scripts/web-economy-e2e.sh        # REAL chain: a launch still goes through, and the DAO votes after the sale
```

By hand: launch a project and, before its sale's claim block, try to open any decision on the **Decisions** tab: the chain refuses. After the claim block the same decision opens.
Backers: claim promptly after the claim block; a decision opened right then has no unclaimed buyers in its electorate, and the review plus the execution delay (at least three days) is the time to claim and leave.


## 4ab. Milestones that unlock unless holders object (D56, D57, 2026-10-18)

```bash
cd contracts && REQUIRE_CONTRACT_ARTIFACTS=true forge test      # the whole suite (397 tests); the lock has 39 of its own and the kit launches one end to end
scripts/web-challenge-e2e.sh                                    # REAL chain, real browsers: the whole story below, about a minute
```

Working looks like: `1 passed` and the lines `the founder launched a project whose milestones go to the holders`, `an unreadable
lock was shown as unknown, not as a panel`, `the holders turned the milestone down`, `the milestone unlocked and the team's
first 40% is free`, `the late objection was upheld and the remaining locked Shares were burned`. Read
`web/tests/e2e/launchpad-challenge.spec.ts` for the sequence; every step is a button and a transaction, checked against the chain.
Set `E2E_SHOTS=<dir>` to save screenshots of the screens as they are met.

**By hand, in the browser** (three wallets: a founder and two backers; run the journey's world with `scripts/dev-chain.sh` or the
Sepolia testnet in `docs/sepolia-testnet.md`):

1. **Launch.** On the launch's **Manage** tab the form opens on **Holders can object**; the Launch button works with nothing to
   name. Choose **Named reviewers** and it asks for people (and goes off again); choose **Holders can object** to come back.
2. **Before the buyers can claim,** the founder's **Milestones** tab says publishing opens at the claim block and offers nothing to send.
3. **Backers bid, the sale ends, graduation runs, backers collect their Shares** as before.
4. **The founder publishes milestone one.** Type the evidence and press **Publish this milestone**: three wallet prompts (the
   text is published first, then the bond is approved, then the milestone is sent). The card says **Open to objections** and the
   date and time it closes, with the time zone. The next milestone says milestones go in order and offers nothing.
5. **A backer sees it.** On Home the line **Read the evidence** is waiting; it opens the milestone. Open **Evidence the team
   published**: it says it is the text the team committed to. Try pulling the network cable (or stopping the server) and reload:
   the card says it **could not look for the evidence just now, which does not mean the team did not publish it**, with **Try again**.
6. **A backer objects.** **Object to this milestone** asks you to confirm and shows the deposit you post. After it, the card says
   **Holders are voting** with the tally. A second backer who already had the page open sees **Vote against / for the milestone**
   appear without reloading (within about 15 seconds). The founder is offered no vote and no objection.
7. **Let the vote end** (on a local chain: `cast rpc evm_increaseTime <seconds>` then `cast rpc anvil_mine`). Anyone presses
   **Settle the vote**. If the objection stood, the milestone says **Turned down**, the objector has their deposit back and half of
   the founder's bond, and the retry window is twice as long.
8. **The founder publishes again; nobody objects; time passes.** A backer's open page changes to **Ready to finish** on its own,
   and the founder's Home says so. **Finish it and unlock the tokens** (anyone can): the team's part unlocks, a badge is minted,
   and the founder can move exactly that part and not one Share more.
9. **A month after, the bond comes back** with **Return the team's bond** (not before).
10. **A late objection.** Inside the month a backer can object once more. If holders uphold it, **the milestones still ahead are
    burned** (they were locked, because milestones go in order) and what already unlocked stays. While that month runs, the
    founder's card for the next milestone says **Holders can still object to milestone N until <date and time>** and offers no
    Publish button; once the month and any vote are over it opens.

What to check a person understands (the pilot's questions, `PILOT-RUNBOOK.md`): the page says a milestone nobody objects to
unlocks, the team's own tokens do not count in the vote, a backer can still leave with their share while one waits, and the last
milestone is protected only by its bond.


## 4ac. Connected DAO OS and project progress (D60, 2026-10-18)

```bash
. ./bin/activate-hermit
pnpm --dir web test
pnpm --dir web build
pnpm --dir web exec playwright test --project=smoke dao-os.spec.ts
scripts/web-work-e2e.sh --retries=0
scripts/web-challenge-e2e.sh --retries=0
pnpm --dir web build  # restore the standard build after local-chain journeys
```

By hand, using a test project and development wallets:

1. **Find the project.** Main navigation has Home, Discover, Workspaces and Portfolio on desktop and phone. Discover offers Launches and Markets. The existing Communities page is still reachable through Workspaces. Home offers People & posts.
2. **Share actual progress.** Open your project and Post update. Name a shipped artifact or demo, include its URL, credit contributors and say what comes next. Include only artifacts intended for the project's update feed. Home's Project progress shows your signed team report with its author and an artifact link. A report is not shown as independently verified work.
3. **Follow and catch up.** Follow a second project. Its reports appear in Following & yours. All projects remains available. Open a project's overview, leave, then publish another update and return: the new loaded report is labeled New to you. Mark shown updates as read; a reload preserves that in this browser. Another account or relay has separate reading history. A failed read is reported and offers Retry rather than a reassuring empty feed.
4. **Link work.** In Workspaces, open Work, choose a task in List view, then Delivery & payment. Choose its project and paste an output link. Save: a signed task update is sent, and the page says no payment was sent. Reload and verify the links remain. An older agent status row that omits delivery metadata must not erase them. A refused write leaves the draft for another attempt.
5. **Link a claim explicitly.** On the project's network, select an existing claim and save the reference. Its status is read from the chain. Open project claim takes you to that exact claim. Saving the link or marking the task done never sends a payment transaction, approves the claim or awards Shares. Payment remains the claim workflow's explicit action.
6. **Supervise helpers.** Open People & agents. See the founder-managed community seats, team-recorded tasks, outputs, heartbeat recency and review needs. Only team-signed task rows appear here; outside participants’ updates remain on the community Work board. An outside task naming the project or assigning a teammate must not appear in the overview or introduce a helper. Outside evidence posts must not appear as team progress. Recorded limits in this view must be signed by the founder. If a read fails, Reload records recovers without leaving the tab or reloading the document. Recorded budgets show their enforcement labels; they are not presented as measured costs. Follow the links to the existing Org budget/permission/emergency-stop controls and to the tab helper's run/stop control. An unknown role or limit stays unknown.
7. **Review urgency and layout.** A claim approaching expiry appears before a vote with a later deadline and explains how an unanswered claim can lapse. On Home, personal actions appear above onboarding. In a completed DAO, actions and treasury figures precede the compact progress feed. On a phone, project destinations scroll rather than wrap into several rows; milestone rules expand without hiding the current milestone or transaction confirmations.

Working looks like: all of these destinations are reachable from the project, failed reads/writes have recovery, reading history is local, and every financial action still has its separate authorization step. The remaining investor execution/data-provider work is not implied by these screens.

## 4ad. Reporting and removing on boards (moderation plan A3, 2026-10-18)

```bash
. ./bin/activate-hermit
pnpm --dir web test
pnpm --dir web build
pnpm --dir web exec playwright test --project=smoke board.spec.ts   # 34 tests, 5 of them for this
```

By hand, on a board with posts and replies by two other people:

1. **Report.** Open a post. Someone else's post and each of their replies show **Report**; your own show none. Choose a
   reason, send. The report reaches the moderators' queue (and nowhere else). Signed out, **Report** asks you to make an
   account and sends nothing.
2. **Remove (a board's owner or admin only).** Plain members see no **Remove**. An owner or admin sees it on other people's
   posts and replies, never on their own (they have **Delete**). It asks before it removes, says it is for everyone on the
   board, and goes at once.
3. **Other readers.** With the same board open on a second screen, a post or reply you remove disappears there without a
   reload, and stays gone after one. A removal that comes from anyone who is not one of the board's owners or admins is ignored.
   **Roster changes.** Keep a board open as an ordinary reader. From another session make someone a board admin, and have them
   remove a post or reply: the first reader loses it without a reload. Then withdraw that admin's role: what they removed
   stays gone, and a new removal from them is ignored (the server refuses it too). If the reader had missed the role change,
   the first removal from someone it does not know makes it check the roster again.
4. **Ban (the community's owner or admin only).** The button appears beside Remove for them, and not for anyone else.

Not done yet: a visible marker where something was removed and the sanitized room action log (A5), room restrictions
(dropped for the pilot), and removal by a community owner or admin from the board itself (they use the moderation queue).

## 4ae. One Home, two starting points, a Testnet tag (D61, 2026-10-19)

```bash
. ./bin/activate-hermit
pnpm --dir web test
pnpm --dir web build
pnpm --dir web exec playwright test --project=smoke feed.spec.ts start-project.spec.ts first-run.spec.ts social-mention.spec.ts launchpad-empty.spec.ts responsive-surfaces.spec.ts
```

By hand, signed in on a phone-sized window and on a wide one:

1. **Home is the social page.** Open `/`: the composer, Everyone / Following / Projects, and under the top bar a "Get started"
   card. `/social` goes to `/`. Post something with a `#tag`: it shows in Everyone, in the tag's page, and after a reload. Like,
   reply and repost it from a second account. There is one search box (the top bar), not two.
2. **Setup.** Workspaces → open the community → Set up community. Two cards (Creative project, Technical project); "More
   kinds of team" opens the other two; "See everything it adds" opens the long list. Pick Technical, set it up, and the first
   channel opens. On a phone nothing is cut off.
3. **Testnet.** A small "Testnet" tag sits beside the logo on a wide window. It is not there on a phone (the top bar is not).
4. **Mentions.** In the post box type `@` and the start of a name you follow, choose them, then keep typing at once: the words
   come out in order behind the mention.
5. **Empty launchpad.** On a server with no launches, Launchpad shows "No launches yet" and the sandbox, and no row of
   filters. Add a launch and the filters appear.

## 4af. Removing a chat message, and acting on a person (2026-10-19)

```bash
. ./bin/activate-hermit
pnpm --dir web test
pnpm --dir web build
pnpm --dir web exec playwright test --project=smoke chat-removal.spec.ts social-safety.spec.ts report.spec.ts
scripts/web-invite-only-e2e.sh        # real server: chat and board removal, reporting a post and a person
```

By hand, with two accounts in one community (one an owner or admin, one a member):

1. **Remove.** The owner opens a room where the member wrote something. On the member's message there is **Remove** (never on
   the owner's own). It asks first and says the person stays. Confirm: the message becomes "message removed by a moderator".
2. **The member's screen.** With the same room open as the member, the message goes without a reload, and a reload does not
   bring it back. The member is offered no Remove on anything.
3. **Roster.** Make the member an admin from the owner's account; they now see Remove. Withdraw it: they see none again.
4. **Phone.** On a phone-sized window, the actions under a message (Copy, Link, Reply, Report, Remove, Ban, Delete) are always
   visible and wrap; nothing is cut off at the right edge.
5. **Report a person.** Open someone's profile: a flag button next to Mute. Choose a reason, send. The owner's moderation queue
   shows it with the reason and the note. Your own profile has neither Mute nor Report.
6. **Mute from a conversation.** Open a private conversation: Mute and Report are in the title bar. Mute, go back to Messages:
   the conversation is gone, with a line saying how many are hidden. Unmute from their profile and it returns.

Not done: removing a whole thread at once, and a room action log.

## 4ag. Boards in the feed (D63, 2026-10-19)

```bash
. ./bin/activate-hermit
pnpm --dir web test
pnpm --dir web build
pnpm --dir web exec playwright test --project=smoke board-feed.spec.ts board.spec.ts
```

By hand, against the local server (`just relay`, then the web app), signed in, in a community with at least two boards
(the workspace sidebar's **New board** makes one):

1. **Boards tab.** Home → **Boards**. Every board's posts are in one list; each shows a large picture, the author, the
   board's name, the time, the title and the first lines. **Hot / New / Top** re-order it. The board chips open a board.
2. **Post from Home.** **New post**, pick a board in "Post on", write a title and some text, Post. You land on the post on
   that board's own page (the address is `/b/…?post=…`), with your picture large above the title.
3. **Vote.** Back (the arrow in the title bar) returns to the Boards tab, not Everyone. Press the up arrow on someone's post:
   the score goes up and the arrow stays pressed; the list does not jump. Press it again to take it back.
4. **Reply.** Open a post, reply; the reply shows your picture beside your name.
5. **Everyone.** Home → **Everyone**: "Hot on the boards" shows up to three recent board posts above the short posts.
   **See all boards** switches to the Boards tab.
6. **Workspace.** The same board in the community workspace's sidebar shows the same posts and the same forum layout.
7. **Phone.** On a phone-sized window the Boards tab, the chips and the cards fit with no sideways scrolling.

Not done: joining a board, anyone creating a board, pictures in posts, Top by period, live updates on the front page
(see SOCIAL-MVP-ROADMAP-2026-10-19.md).

## 4ah. Joining boards, starting boards, pictures, Top by period, live posts (D64, 2026-10-19)

```bash
. ./bin/activate-hermit
pnpm --dir web test
pnpm --dir web build
pnpm --dir web exec playwright test --project=smoke board-feed.spec.ts board.spec.ts
cargo test -p buzz-relay --lib -- board_limit --ignored     # needs Postgres + Redis
```

By hand, against the local server, with two accounts (two browsers, or a normal and a private window):

1. **Start a board.** As the first account, Home → Boards → **Start a board**, give it a name and a line about it. You land
   on the board; its header says **Yours**.
2. **Post with a picture and a link.** **New post**, **Add a picture**, then a link in the text. In the Boards tab the
   post shows the picture small beside the title and the link's site (for example "itch.io") under it.
3. **Join.** As the second account, Boards tab → it starts on **All boards** (you joined nothing) → open the board →
   **Join**. Back on the Boards tab it now starts on **Your boards**, and the board's chip is highlighted. Press
   **Joined** on the board to leave; Your boards then says how to join one.
4. **Live.** Keep the second account on the Boards tab. Post on any board as the first account: "1 new post. Show" appears
   within a second or two, the list does not move, and **Show** brings the post in.
5. **Top.** Choose **Top**: a time menu appears (Today / This week / This month / All time) and changes what is listed.
6. **Older posts.** With more than 100 posts, **Show older posts** at the bottom adds the next 100.
7. **Limit.** As an account that is not a community owner or admin, start a sixth board in a day: it is refused with
   "You can start 5 boards a day; try again tomorrow." and the name stays in the box.

Not checked locally: the picture upload itself (the local media store did not answer). If uploads fail the same way in
chat, it is the media store setup.

## 4ai. Contributor projects: no sale, Shares for accepted work, ready on day one (D65, D66, 2026-10-19)

```bash
. ./bin/activate-hermit
(cd contracts && forge test --match-contract ContributorKitTest)
pnpm --dir web test
pnpm --dir web build
pnpm --dir web exec playwright test --project=smoke contributor-project.spec.ts
scripts/web-contributor-e2e.sh        # the whole journey in pages, on a throwaway local chain (about 5 minutes)
```

The journey script boots its own chain and builds the app for it. To try it by hand, boot a dev chain
(`scripts/dev-chain.sh`; its summary prints the line), then build the web app with the contributor kit and the dev
currency it reports:
`VITE_LAUNCHPAD_CHAIN_ID=31337 VITE_LOCAL_USDC=<currency> VITE_CONTRIBUTOR_KITS='{"31337":"<contributor-kit-31337.json>"}'`.
Use a wallet on the local chain (account 0 as the founder; two other accounts as reviewers, a third as a contributor).

1. **Start.** Start → **Start a contributor project**. The first box says the project cannot raise money, that there is
   no sale, that Shares are earned only for accepted work, that people can claim work as soon as it exists, and that
   Shares cannot be sent between wallets.
2. **Preview.** Type a name: the short name fills itself in. Change "Shares to earn": the line under the form says what
   share of all Shares contributors would hold if the whole budget were awarded.
3. **Make it.** Name two reviewers, a first project ("docs") and what finished work looks like, and press **Start the
   project**. The wallet asks **once**. Both steps tick, and **Open the project's work** appears.
4. **Reload part way.** Start another project with the server stopped (or offline after the wallet approved), so the
   project is made but not published. Reopen Start: it offers **Finish setting it up**, and pressing it publishes without
   asking the wallet to make a second project.
5. **The page.** The header says **Contributor project** (not "Sale completed"), the right side says "Nothing is for
   sale", and the second tab is **Contributions**, which says nobody has earned Shares yet and counts your starting
   Shares as "not from work". **Decisions** is empty: nothing needed a vote.
6. **Work on day one.** As the contributor, Work → file a claim in "docs" with the same check words. As the founder,
   take it on. As the two reviewers, approve it. Finish it, wait out the challenge window (on a local chain:
   `cast rpc anvil_increaseTime 700000` and `cast rpc anvil_mine 1`), and take it as the contributor.
7. **Award.** As the founder, Decisions → **Award Shares for a claim**, back it, let the review and wait pass, run it.
   The Contributions tab then shows the contributor, the Shares awarded, "write-docs in the work area docs", and what they
   hold now.
8. **Locked.** In a wallet, try to send some Shares to another address: the network refuses it.
9. **Market.** On a build with a market configured (`VITE_LBAMM_ADDRESSES`), **New decision** offers "Put Shares on the
   market" for a DAO that raised, and not for this project (no automated test covers this yet).

Sepolia: the same journey runs on a fork of Sepolia (4al). The contributor kit has not been broadcast to the real Sepolia, so a
hosted Sepolia build says "Contributor projects cannot be started on Sepolia yet" until it is.

## 4aj. Audit groundwork: invariants, the simulation, the mutation check (2026-10-19)

What the raise's money paths must keep, and how each is tested, is in [AUDIT-SCOPE.md](AUDIT-SCOPE.md) §5. Three
commands rerun all of it; each cleans up after itself and touches no real network.

1. **The invariant and fuzz tests.**

   ```bash
   cd contracts && forge test --match-path "test/invariant/*"
   ```

   Working looks like: eight `invariant_…` tests `(runs: 64, calls: 12800, reverts: 0)`, plus
   `testFuzz_exit_pays_exactly_what_the_screen_shows` (65 runs; it calls `node`, so the web's own exit preview is what
   the chain is held to) and `testFuzz_slash_takes_at_most_what_is_held` (256 runs), all passing. `-vv` prints, per run,
   which paths were reached (`milestone.lateUpheld`, `govern.executed`, `work.payout`, …). The whole suite
   (`forge test`) then reports 419 passed, 0 failed, 2 skipped (D67 added
   `test/MilestoneChallengeBlocklist.t.sol`, D68 `test/ClaimStakeCurrency.t.sol`, D69 a launch-kit test). Since D70 every
   first-party contract compiles with solc 0.8.37; if forge says no such version exists, run `scripts/ensure-solc.sh`
   once.
2. **The simulation on a real chain.**

   ```bash
   scripts/simulate-raise.sh --steps 3000 --seed 7
   ```

   It boots its own anvil, launches projects through the launch kit, runs their sales with two dozen bidders (one sale
   misses its target on purpose), settles every bid with the web's own "Your bids and tokens" logic, then takes 3,000
   random steps (transfers, exits through the web's exit screen code, proposals and votes, milestones and objections,
   work budgets, bonds, the currency's issuer blocking people, an attacker, time passing), starting a fresh project whenever one's milestones are settled.
   Working looks like: a line per sale ("raise met; bidders paid … USDC, DAO holds …" and one "raise missed; bidders paid
   0 USDC"), `3000 steps, 3000 invariant checks, 0 breaks`, exit code 0, and a report in
   `target/simulate-raise/report.json`. About two minutes. Any other `--seed` gives a different history.
3. **The mutation check** (several minutes per guard; run it with no uncommitted changes in `contracts/src`):

   ```bash
   node scripts/contracts-mutation-check.mjs
   ```

   It removes each of sixteen guards in turn (the lock, D51, D57, D58, the vote bars, the slash, the claim window, the
   clawback, the D67 and D68 fallbacks, the escrow's SafeERC20, the D69 auction exclusion, and two in the web exit
   preview), runs step 1 (plus the test that pins that fix; the kit's runs the whole suite), and restores the file.
   Working looks like: sixteen lines ending in `caught (…)` and `every mutation was caught`.
4. **A blocked objector (D67).** `cd contracts && forge test --match-path test/MilestoneChallengeBlocklist.t.sol`: an
   upheld objection (and an upheld late one) settles although the currency now blocks the objector; the objector's
   bounty waits in `owed`, nobody else can take it, and it is theirs once unblocked. The invariant handler and the
   simulation also have the currency's issuer block and unblock people at random.

Not covered here: the panel lock (`MilestoneLock`) is held by its own tests, not by the invariants; the simulation
uses the holder challenge only. Sepolia and mainnet are not touched.

## 4ai. One timeline: General, Following, votes and threads (D71, 2026-10-20)

```bash
. ./bin/activate-hermit
pnpm --dir web test
pnpm --dir web build
pnpm --dir web exec playwright test --project=smoke home-timeline.spec.ts board.spec.ts feed.spec.ts
```

By hand against the local server (the `relay-3001` and `web-3001` entries in `.claude/launch.json`), with two accounts:

1. **Everyone.** Home → Everyone shows short posts and board posts together; a board post has its board's name, a bold
   title and the first lines. **Hot / New / Top** reorder it; Top has Today / This week / This month / All time.
2. **Votes.** On a short post press the up arrow: the score goes to 1. Press down: it goes to −1. Press down again: 0.
   Reload: still 0. The same works on a board post in the timeline.
3. **Post to.** In the composer pick **Post to: a board**: a Title box appears, the public-Nostr option goes away. Post: it
   shows at the top of Everyone (New) with the board's name. Switch back to **General** and post a short post.
4. **Threads.** Open a short post, reply, then press **Reply** on that reply: a box opens right under it. Send: the answer
   sits under the reply it answers, with a line down the left.
5. **Following.** As the second account follow the first: Following shows their short posts and their board posts.
6. **Boards.** The Boards tab lists every board with what it is for and how busy it is, **Join** (or **Yours** on a board
   you started), and **Start a board**.
7. **Profile.** Open the first account's profile: Posts shows both kinds; the score counts the second account's votes
   (your own votes on your own posts do not count).

## 4aj. Board notifications, terms at sign-up, new-account limit, board search (D83, 2026-10-21)

```bash
. ./bin/activate-hermit
pnpm --dir web test
pnpm --dir web build
pnpm --dir web exec playwright test --project=smoke social-mvp.spec.ts first-run.spec.ts home-timeline.spec.ts
cargo test -p buzz-relay --lib -- new_account_limit board_limit --ignored   # needs Postgres + Redis
```

By hand against the local server. The `relay-3001` entry in `.claude/launch.json` loads the drafts in `docs/policies/`,
so the terms show at sign-up. Use two accounts (two browsers, or a normal and a private window):

1. **Terms.** Sign out (or use a private window) and press **Create your account**: a box says "I agree to the Terms of
   use and have read the Privacy note"; the links open each as a page. Passkey, wallet and Create account stay greyed
   out until it is ticked.
2. **Board notifications.** As the second account reply to the first account's board post and press its up arrow. As
   the first account open **Notifications**: "replied on a board" with the reply, and "upvoted your board post" with the
   title; each opens the post on its board.
3. **Search.** Search for a word in a board post's title: the board post shows with its board's name, beside any short
   posts with the word.
4. **New-account limit.** With a brand-new account, post more than 20 short posts within an hour (or start the server
   with `BUZZ_NEW_ACCOUNT_POSTS_PER_HOUR=2` to see it sooner): the next one is refused with "New accounts can post …
   times an hour for their first day; try again later." and your text stays in the box. Votes still work.

## 4ak. Several first projects, starting from the Projects board, suggested work (D84, 2026-10-21)

```bash
. ./bin/activate-hermit
(cd contracts && forge test --match-contract ContributorKitTest)
pnpm --dir web test
pnpm --dir web build
pnpm --dir web exec playwright test --project=smoke contributor-project.spec.ts projects.spec.ts
scripts/web-contributor-e2e.sh        # two journeys in pages on a throwaway local chain (about 10 minutes)
```

The journey script now runs two journeys: the one-contributor journey of 4ai, and a project where several people earn:
two first projects at Start, a contributor claiming in one, a newcomer with no Shares suggesting work for 5% of the
project, the founder putting that to a vote, the newcomer claiming in the project it became, both claims reviewed and
paid, two award votes, and the Contributions tab showing both people. To try it by hand, set up the local chain and build
as in 4ai, then use account 0 as the founder, accounts 1 and 2 as reviewers, and accounts 3 and 4 as two contributors
(account 4 with a second Creaton account, so the suggestion is someone else's):

1. **Several first work areas.** Start → Start a contributor project. Under **First work area**, press **Add another
   work area**: the heading becomes "First work areas" and each has its own name, Shares and "what finished work looks
   like". Lower "Most for one work area": one still at the old number follows it; one you typed keeps yours, and if it
   is now too big the form says which ("“docs” can award at most 40 Shares, the most for one work area."). Start it: the
   wallet asks once, and the Work tab lists every work area. (D84 called these first projects; D88 renamed them.)
2. **From the Projects board.** Discover → Project Board → a pitch you posted with roles (say a writer at 12% and a
   designer at 8%). The card at the bottom says **Start it as a contributor project**; press it. Start opens filled in:
   1,000,000 Shares are the whole project, your declared stake is your starting Shares, each role is a first work area of
   its stake (a 12% role is 120,000 Shares) whose check names the person in it, and the budget is at least three times
   your start, with the spare room said in the "From the Projects board" box. Someone else opening the same link is told
   only the person who posted it can start it. Once started, the board's card says **This project is running** and links
   to its work.
3. **Suggest work.** As account 4, open the project's Work tab: **Suggested work** says anyone can suggest work and name
   their price. Press **Suggest work**, fill in what you will do, a short name ("guide-es"), what finished looks like,
   and **5** with "% of the project" chosen: the line under it says how many Shares that is ("11 Shares: 5.2% of the
   project once they are added to the 200 that exist now…"). Switch to Shares to type a number instead. **Suggest it**
   posts it on a board, so it also shows on that board and in Home's timeline.
4. **Put it to a vote.** As the founder, the suggestion has **Put to a vote**: it opens Decisions with **Approve a work
   area** already filled in (name, Shares, check) and a note that it came from a suggestion. Back it, let the review
   and the wait pass (`cast rpc anvil_increaseTime 90000`, `cast rpc anvil_mine 1` each time), run it. The suggestion
   then says **Approved as a work area**, and it is in the Work tab's list.
5. **Earn it.** As account 4, submit work with the suggestion's exact check words. As the founder, accept each
   submission in its own work area (**Accept for review in guide-es**). Both reviewers approve, the founder finishes the
   review, wait out the challenge window, and each contributor marks theirs finished. Two award decisions later, the
   Contributions tab shows both people with the Shares they were awarded, what they hold now, and the work each was
   for.

## 4al. Contributor projects on a Sepolia fork, ready for the testnet (D85, 2026-10-21)

```bash
. ./bin/activate-hermit
scripts/sepolia-deploy.sh                          # rehearsal on a fork: deploy, checks, the per-transaction gas cap, today's cost
scripts/web-contributor-e2e.sh --sepolia-fork      # both contributor journeys (4ai, 4ak) in pages on a fork, built like a hosted Sepolia build
scripts/web-contributor-e2e.sh                     # the same spec on a local dev chain
cd web && node --experimental-strip-types --test src/features/launchpad/lib/test-network.test.mjs
```

The fork journey forks Sepolia into a local anvil (`--prune-history=500`), deploys with the Sepolia deploy's own Forge
script from a deployer key of its own, turns everyone in the story into a plain account with 0.1 test ETH (on the real
Sepolia anvil's public dev accounts carry strangers' EIP-7702 delegations), and builds the web app with
`VITE_LAUNCHPAD_CHAIN_ID=11155111`, `VITE_CHAIN_RPC_URL`, `VITE_CONTRIBUTOR_KITS`, `VITE_DAO_LAUNCH_KITS` and
`VITE_HISTORY_FROM_BLOCKS`. Before the browser starts it asks the kit itself, from the founder: 200 starting Shares against a
600 budget with two other reviewers goes through; 201 is refused with `InvalidTerms`; the founder on the panel is refused with
`InvalidTerms`. It ends with the gas each person used. Nothing public changes, and the manifest and broadcast record it wrote
are removed.

By hand on a hosted Sepolia build (`docs/sepolia-testnet.md` §3), with a founder wallet, two reviewer wallets and a
contributor wallet, each with a little Sepolia ETH and no USDC:

1. **The notice.** Start → **Start a contributor project**. Under "This project cannot raise money" a line says Sepolia is a
   test network and Shares earned there are test records that will not move to a real network automatically. Hover the
   Testnet tag beside the logo: it says the same.
2. **The founder limits, in the form.** Leave "Shares to earn" at 300,000 and type 100,001 as your starting Shares, fill in
   the rest and press **Start the project**: it says to start with at most a third, and the wallet is not asked. Put it back
   to 100,000, add your own wallet address to the reviewers and press again: it says you cannot review the first budget's
   work yourself. Remove it.
3. **Start it.** Press **Start the project**: the wallet asks once. Open the project's work.
4. **Work.** As the contributor, file a claim in the first project with its check words. As the founder, take it on. As
   both reviewers, approve it. As the founder, finish it. The challenge window is a week on a real network: come back
   after it and take it as the contributor.
5. **Award.** As the founder, Decisions → **Award Shares for a claim**, back it, start the wait once the review has passed,
   run it once the wait has passed (on a real network the review and the wait take about a day each).
6. **Contributions.** Open the Contributions tab with no wallet: the contributor, the Shares, the claim and the project, and
   the same test-records line under "Who earned the Shares".
7. **Locked.** Try to send some Shares from the contributor's wallet to another address: the network refuses it.

Not covered: the real Sepolia (the deploy needs your key and go-ahead), the real relay (the spec stubs it in the page, as
every mocked spec does; the raise journey `scripts/web-sepolia-fork-e2e.sh` covers the relay on a fork), passkey accounts
sending the contributor launch through a bundler, and the week-long waits in real time.
## 4am. The outside review's fixes: the launch kit, the exit and money screens, who decides (D86, D87, 2026-10-21)

```bash
. ./bin/activate-hermit
cd contracts && REQUIRE_CONTRACT_ARTIFACTS=1 forge test      # the whole suite: the kit's tests need its artifacts
node scripts/contracts-mutation-check.mjs                     # 42 guards, each must be caught (no uncommitted src changes)
pnpm --dir web test
pnpm --dir web exec tsc --noEmit
pnpm --dir web build && pnpm --dir web exec playwright test --project=smoke launchpad.spec.ts \
  launchpad-challenge.spec.ts launchpad-work.spec.ts launchpad-record.spec.ts launchpad-milestone.spec.ts
scripts/web-dao-launch-e2e.sh                                 # the real-chain launch journey
```

1. **The kit (D86).** In the Forge output, `DaoLaunchKitTest` has seven new tests: percentages without checks, unpaired
   counts on both paths, a split the milestones cannot divide (`kit: team lock`), a moved auction tuple with a one-unit
   target (`UnfairTerms(6)`), the same with a fair target (it launches and the auction has the real floor), an
   overflowing floor (`UnfairTerms(6)`, not a panic), and two fuzz tests. `PinnedInterfacesTest` has
   `test_the_kits_auction_parameters_match_upstream_field_for_field`. Filtered runs skip the kit's tests (they need the
   artifacts of a full build).
2. **An older DAO's exit.** The unit test `ragequit-position.test.mjs` drives the real reader against a chain whose lock
   has no `totalLocked()`: a DAO made before D72 gets a preview counted the old way, and the panel says "This DAO was
   made before Shares still locked behind milestones were left out of an exit"; a DAO made after with such a lock says
   "This app can't tell what leaving would pay" and offers no exit.
3. **Money in.** On a DAO's Overview, "Money that came in" lists each payment with its day and transaction (the link
   opens the explorer on Sepolia; on the local chain it shows the hash and "no explorer on this chain"), and "Show all"
   when there are more than five. Stop the chain node while the page loads: the card says "Couldn't tell what came into
   the treasury just now" with Try again, never a figure.
4. **Spending and claims.** "Where the treasury's money went" shows, for each direct payment, the day its decision ran
   and the transaction. On the Work tab a paid claim says "Paid <day> · <transaction>" (one that asked for no money says
   "Finished <day> · <transaction> · No money was asked for.", D88); the Track record's payouts
   carry the same link.
5. **Powers and who decides.** On a DAO launch page, "If a decision goes against you" gives today's notice from the
   DAO's settings and says a vote can shorten them. "Who decides right now" says what share of the votes the team holds,
   whether it can pass a decision alone, and how many sale Shares still wait to be claimed. On a contributor project's
   Contributions tab the same card speaks of the biggest holder (the founder, until awards spread the Shares).

## 4an. Plainer contributor copy, work areas, finished claims, confirmed awards, every voting bar (D88, 2026-10-21)

```bash
. ./bin/activate-hermit
(cd packages/creaton-core && pnpm test)       # claim words and status labels
pnpm --dir web test                           # contributions.test.mjs, vote-control.test.mjs among them
pnpm --dir web build && pnpm --dir web exec playwright test --project=smoke contributor-project.spec.ts
scripts/web-contributor-e2e.sh                # both contributor journeys on a local chain
scripts/web-work-e2e.sh                       # a Shares-only claim from filing to finished
```

By hand, as in 4ai (account 0 the founder, 1 and 2 reviewers, 3 a contributor):

1. **Start.** Start's first card is **Build with contributors**, "Start without a token sale…". On the contributor page
   the box is **Starts without a token sale**: no sale and no way to start one here, but the treasury can still receive
   payments; you start with Shares and may at first hold every Share that votes; approval alone gives no Shares;
   transfers start locked and opening them takes two votes at least 30 days apart. Under the form, **At the start** says
   you hold all of your Shares and the budget's Shares do not vote yet; **If the whole work budget is awarded** is
   labelled an illustration. Reviewers' help says reviewing gives no Shares or votes.
2. **Work areas.** The form says **First work area**, the Work tab lists **Work areas**, the decision is **Approve a work
   area**, and an award reads "… in the work area docs".
3. **Submit and finish.** As the contributor, the form is **Submit your work**. As the founder, the button is **Accept
   for review in docs**. After both reviewers approve, the review is finished and the challenge window passes
   (`cast rpc anvil_increaseTime 700000`, `cast rpc anvil_mine 1`), the contributor's button is **Mark it finished**
   (not "Claim payment"); afterwards the claim says **Finished**, never Paid, with "No money was asked for." A claim that
   asked for money still says Paid.
4. **Contributions.** After the award vote runs, the tab shows "Shares awarded over time", **Starting Shares** (your 200,
   from the token's own mint), and for the contributor "25 Shares awarded" and "Holds 25 now (… of all Shares now)". An
   award recorded without its Shares (only a vote crafted to call the work budget's `consumeContribution` directly can
   make one; the app's award form never does) shows "Award recorded; the Shares were not found reaching them", sits
   under **Recorded, not confirmed**, and is not added to what was awarded: `contributions.test.mjs` and
   `contributor-project.spec.ts` cover it, since the app offers no way to make one by hand.
5. **Who decides.** On the Contributions tab, "Who decides right now" uses the DAO's own turnout settings and minimum
   in favour as well as the lanes'. With the defaults nothing changes; a DAO whose `minYesVotesAbsolute` is above the
   founder's Shares no longer says the founder can pass a decision alone.

## 4ao. Ways to help and the next-action queue (D89, 2026-10-22)

```bash
. ./bin/activate-hermit
pnpm --dir web test                           # ways-to-help.test.mjs, dao-overview.test.mjs, record-input.test.mjs
scripts/web-contributor-e2e.sh                # both journeys submit from Ways to help, and use Needs you
```

By hand, as in 4ak (account 0 the founder, 1 and 2 reviewers, 3 a contributor, 4 a newcomer):

1. **Ways to help.** Start a contributor project with a work area "docs". As the contributor (no Shares), open the
   project: the Overview says "Ways to help: 1 work area is open for submissions. You need no Shares to submit work."
   **See ways to help** opens the Work tab, where **Ways to help** lists "docs" with "Finished looks like: …" (the
   words you typed at Start), who manages it, how many Shares it can still award, and until when.
2. **Submit work for this.** Press it: the submit form scrolls into view on that work area with the words filled in
   and "These are docs's exact words, checked against the network." Type a name and where the work is, and submit.
3. **Waiting on someone else.** On the contributor's Overview: "Your “…” is waiting for a work area's manager to
   accept it for review." Later it says how many reviewers approved, then when the challenge window ends, then that
   Shareholders decide on an award.
4. **Needs you.** As the founder, the Overview's **Needs you** says "… submitted “…”. Accept it for review in one of
   your work areas." Its button opens the Work tab on that claim. Once both reviewers approve, the contributor and the
   founder are each told anyone can now finish the review.
5. **A voted work area.** As the founder, approve a new work area by a vote (Decisions → Approve a work area, typing what
   finished work looks like). Once the vote opens, its words are published beside it; after it passes, Ways to help
   lists the new area with those words. If publishing them fails, the Decisions tab says so with **Publish them
   again**.
6. **Unpublished words.** A work area whose words were never published (one approved before this change) shows "Its
   exact words are not published here. Ask its manager for them before you submit."

## 4ap. Contribution stories, the project header and overview, joining copy (D90, 2026-10-22)

```bash
. ./bin/activate-hermit
pnpm --dir web test                           # contribution-story.test.mjs among them
pnpm --dir web build && pnpm --dir web exec playwright test --project=smoke contributor-project.spec.ts projects.spec.ts
scripts/web-contributor-e2e.sh                # the stories, the header and Needs you on a real chain
```

By hand, after the award in 4ai or 4ak:

1. **A story.** Open the Contributions tab (no wallet needed). Under each award: "Awarded <day> · <transaction> ·
   approved by 2 of 2 reviewers", and "In their words: “…”" with **Open what they delivered**. Edit nothing on the
   chain; if someone published different words for the same claim, they are not shown as theirs.
2. **The header.** A contributor project says "No token sale at setup. New Shares come only from awards for reviewed
   work." and below it "Shares are locked: they cannot be sent between wallets." After an Open trading announcement it
   gives the date a second vote can open it.
3. **The overview.** **Ways to help** is there even with no open work area ("Ask the team what would help"), with
   **Join the discussion** opening the Discussion tab.
4. **Joining a role.** On the Projects board, Request to join a role: the dialog says an approval is a record the
   founder can take back, not Shares, and that in a contributor project the role becomes a work area whose Shares are
   earned as work is accepted.
5. **Profile points.** Hover the points on a profile: they are feedback on posts, not votes in any project, not Shares.

## 4aq. Fixes from the outside review of D88 to D90 (D91, 2026-10-22)

```bash
. ./bin/activate-hermit
pnpm --dir web test        # pending-words, ways-to-help, dao-overview, contribution-story, contributor-status tests
scripts/web-contributor-e2e.sh   # includes a refused word publish, a reload and the retry
```

By hand, with the accounts of 4ak:

1. **Words kept after a failed publish.** Stop the server (or go offline) right after opening an "Approve a work area"
   vote: Decisions says the words are not published yet, with **Publish the words**. Reload: the note is still there.
   Start the server and press it: the note goes, the words are published, and the vote list has no second copy.
2. **The submit form.** On Work, pick a work area with published words, then one whose words are not published: the
   words box empties. Type wrong words for an area and submit: it says these are not that area's words, and nothing
   goes to the wallet. Submit under a name with wrong words while nobody has accepted it, then submit again under the
   same name with the right words: the words are corrected (one more wallet prompt), not refused.
3. **Accept for review.** As a manager of only one work area, a submission whose words are another area's is not
   offered under Needs you, and its claim has no **Accept for review** button; nor in a closed budget or an ended area.
4. **A milestone claim** you filed but did not submit shows under Needs you as "Finish submitting", opening Milestones.
5. **Stories.** With the server stopped, the Contributions tab says "Couldn't read its evidence just now" with Try
   again, never "No evidence was published". Approvals read "2 approvals, 2 needed".
6. **The header.** On a contributor project: "No token sale at setup: it was made by the contributor kit.", "New Shares
   come only from awards for reviewed work." and "Shares are locked…". On a build without the contributor kit set, it
   says only what the record says, and with the network unreachable, that the Shares' rules could not be read.
7. **Copy.** Joining a role and starting from the board say approval does not guarantee Shares; the form's button says
   **Submit work**; on a phone, tapping a profile's points explains them.

## 4ar. The words queue never drops unpublished words; Communities in the top bar (D92, 2026-10-22)

```bash
. ./bin/activate-hermit
pnpm --dir web test   # pending-words.test.mjs: a full list refuses and keeps the oldest; a stale publish keeps newer words
```

By hand: the top bar says **Communities**. The queue's limits are covered by the unit tests (50 unpublished work areas in
one browser is not something to do by hand); its everyday path (a refused publish, reload, Publish the words) is 4aq
step 1.


## 4as. Board moderation: lock, pin, rules, board-only mutes, appointed moderators, the public log (D94, 2026-10-22)

```bash
. ./bin/activate-hermit
cargo test -p buzz-relay --lib moderation_authz          # the standing order and guard rails, table-tested
cargo test -p buzz-relay --lib board_moderation_tests -- --ignored   # needs Postgres and Redis: the real ingest path
pnpm --dir web test                                      # board-moderation.test.mjs
pnpm --dir web exec playwright test --project=smoke tests/e2e/board-moderation.spec.ts
```

By hand, on a local server with three accounts (an owner who started the board, a moderator, a member), each in its
own browser:

1. **Rules.** As the owner, open the board: "This board has no rules yet. Write them". Write two lines, save. The member
   sees **Board rules** above the posts and cannot change them.
2. **Pin and lock.** The member posts twice. The owner opens the first post and presses **Pin**, then **Lock**: in the
   list it is first, marked Pinned and Locked. The member opens it: "This thread is locked by the board's moderators.
   No new replies", and no reply box. The owner can still reply. **Unlock**: the member can reply again.
3. **Appoint.** The owner opens **Moderation**, pastes the moderator's npub, **Appoint for 90 days**. The moderator, on
   reload, sees Lock, Pin and **Mute here** on the member's post, but not on the owner's (equal or higher standing), and
   no appoint form.
4. **Mute.** The moderator mutes the member for 14 days with a reason: the dialog says it needs a second moderator, and
   the log says "muted … until (7 days). A longer mute waits for a second moderator". The member sees "You are muted on
   this board until …" and cannot post, reply or vote there, but can post on another board. The owner lifts the mute
   from the log (**Lift mute**); the member can post again.
5. **Remove.** The moderator removes the member's reply: the thread says "1 reply was removed by moderators", and the
   log names who and when. The moderator gets no Remove on the owner's post.
6. **Step down.** The moderator presses **Step down** in Moderation; on reload they have no moderation controls.

Working looks like: every action appears once in the Moderation log in plain words, the server refuses what the app
does not offer (with a sentence, not a code), and a reload shows the same state.

## 4at. A board's roster changes reach an open board live (D95, 2026-10-22)

```bash
. ./bin/activate-hermit
cargo test -p buzz-relay --lib board_roster_records     # only an #h subscription hears a roster change
pnpm --dir web exec playwright test --project=smoke tests/e2e/board.spec.ts -g "roster|newly appointed admin"
```

By hand, on a local server with two accounts: the first opens an open board and stays on it. The second presses **Join**
on the same board, then **Joined** to leave. Working looks like: the first account's board re-reads its members each
time without a reload (in the browser's network panel, a new request for kind 39002 right after each change).

## 4au. Access changing while the app is open: timeouts, bans, removal (D96, 2026-10-22)

```bash
. ./bin/activate-hermit
pnpm --dir web test   # refusal-text, reconnect, live-scope, relay-failure
pnpm --dir web exec playwright test --project=smoke tests/e2e/access-refused.spec.ts tests/e2e/live-scope.spec.ts
```

By hand, on a local server with two accounts, the first a community admin (`buzz-admin add-member --role admin`, with
`RELAY_URL` set to the server's address). The second opens a board and leaves it open throughout.

1. **Timeout.** The admin reports the second account's profile and, in the community's Moderation queue, presses
   **Time out** → 1 hour. The second account tries to post: "You are timed out in this community until (date and
   time). You can still read; you can post again then." No unix numbers, no `restricted:`.
2. **Ban.** The admin presses **Ban** on one of their posts, 1 day. Without reloading, the second account's board says
   "You are banned from this community." under the header within a few seconds, and still says it later (no
   "Reconnecting…"). Posting says the same. Reloading shows "Couldn't load this board / You are banned from this
   community." The admin lifts it under Org → People; the board loads again.

Removal from a private board while it is open is step 2 of 4av.

## 4av. Taking someone off a private board (D97, 2026-10-22)

```bash
. ./bin/activate-hermit
cargo test -p buzz-relay --lib channel_authz
cargo test -p buzz-relay --lib board_moderation_tests -- --ignored   # needs Postgres and Redis
pnpm --dir web exec playwright test --project=smoke tests/e2e/board.spec.ts -g "takes someone off"
```

By hand, with two accounts and a private board where the first is owner or admin and the second a member (a community
with no boards offers a private founders board):

1. The first opens the board, **People**: **Remove** shows beside the member, never beside the owner (for an admin) or
   themself. Pressing it asks first.
2. The second has the board open. After the first confirms, the second's board says "You no longer have access to this
   room or board. Live updates stopped." without a reload, and the first's list no longer shows them.
