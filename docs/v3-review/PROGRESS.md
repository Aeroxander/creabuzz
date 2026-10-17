# Progress on the v3 review plan

Branch `v4-governance-rework`, local commits only. Decisions D1 to D10 are in [DECISIONS.md](DECISIONS.md). This file
says what is built, how it was checked, and what is not done, so nobody has to read the commit log to find out.

## Built and checked

| Piece | Where | How it was checked |
|---|---|---|
| Governor rework: movable Shares allocations, two lanes, hold time instead of conviction accrual, free opposition, DAO-held Shares outside voting supply and out of the ragequit denominator | `contracts/src/AllocationVoting.sol`, `majeur/MolochPatched.sol` | forge unit, invariant (256 runs) and journey tests; `scripts/simulate-voting-rules.mjs` with its pinned test |
| Safe summon defaults (the bricked web-summon DAO, F1) | `MolochPatched.sol` `init` | `SummonDefaults.t.sol` |
| One-transaction launch: the DAO, the team's Shares minted to the team and locked behind milestones, the sale on the real CCA, the raise paid to the DAO | `DaoLaunchKit.sol`, `MilestoneLock.sol`, `GraduationExecutor.sol` | `DaoLaunchKit.t.sol`, `DaoLaunchJourney.t.sol`; browser e2e on a real local chain (the founder holds the team Shares, the lock reports them locked, a transfer is refused) |
| Web launch: wizard option, Manage-panel launch, resume after failure or reload, recovery from the chain when a browser lost the hash | `packages/creaton-core/.../daoLaunch*.ts`, `web/.../DaoLaunchPanel.tsx` | 22 unit tests; `scripts/web-dao-launch-e2e.sh` (6 browser tests, including a full raise: bid, end, graduate, raise lands in the DAO) |
| Equity-only work: a mandate may carry a share budget and no money; zero-currency claims; awards are bounded by the project's share allowance and use the bounded lane | `TreasuryMandate.sol`, `ClaimStake.sol`, `AllocationVoting.boundedAction` | `EquityMandate.t.sol` (7 tests); full forge suite 311 passed |
| Dev chain deploys the launch kit | `scripts/dev-chain.sh` | `scripts/dev-chain.test.mjs`; run for real three times |
| Whole-number vote and trust-tier display (no more "0.2") | `web/src/features/feed/*` | web unit tests and `feed.spec.ts` |

## Also built and checked

| Piece | Where | How it was checked |
|---|---|---|
| CLI front doors for the contributor path: `buzz launchpad work mandate/project/award` (compose the votes), `claim/check/bind/attest/settle/payout` (send), `state` (read), plus the missing `queue` | `crates/buzz-cli/src/commands/launchpad_work.rs`, `launchpad_gov.rs` | 12 unit tests with calldata pinned to `cast`; `scripts/cli-no-raise-e2e.sh` runs the whole no-raise journey with the CLI alone against a real local chain (mandate, project, claim, recusal, challenge window, payout, over-budget award refused, award, 25 Shares held) |
| A higher, still bounded gas cap for executing a proposal (a mandate deploys three contracts) | `buzz-evm-allowance` `with_gas_cap`, ceiling 8M | unit test: refused by default, allowed when raised, never past the ceiling |
| `$TICKER` cashtags link to the launch that owns the ticker | `web/src/features/social` | tokenizer and ownership unit tests; `social-cashtag.spec.ts` |
| New launches default to the project's own Shares where a kit exists; vouchers hidden beside a DAO's Shares | web launchpad | `launchpad.spec.ts` 28 passed; two browser tests in `launchpad-dao-launch.spec.ts` (the default, and a wizard-made launch launching with the wizard's allocation on chain) |
| A **Work** tab: a DAO's work budgets, projects and claims read from the chain; file a claim for recognition, take a claim on, review, finish, take the payout, each from the person's own wallet | `web/src/features/launchpad/ui/WorkTab.tsx`, `FileClaimCard.tsx`, core `work.ts` / `workRead.ts` | 12 core unit tests (calldata and events pinned to `cast`, a fake-chain reader); `scripts/web-work-e2e.sh` runs the whole path in a browser against a real local chain (found and fixed a hook-order crash in the launch page) |
| A closed mandate awards no more Shares; a manager binds only the claim of the contributor they name (the contract refuses a claim someone else filed under the id) | `TreasuryMandate.sol` | `EquityMandate.t.sol` (9 tests); full forge suite 313 passed |

## Shares as an apptoken, and the milestone lock: built and checked

The DAO's Shares implement the ERC-20C interface, and a lock on a holder's Shares stops both selling and ragequit
without touching the governor. See `docs/token-voting-design.md` ("Shares as an apptoken") and
`SharesCreatorToken.t.sol` (13 tests), plus `scripts/shares-erc20c-e2e.sh` against the real validator.

On top of that, **founders hold and vote with their Shares from the first block, and a milestone unlocks a part**:

| Piece | Where | How it was checked |
|---|---|---|
| The lock (`lockedOf`, `unlock`, `forfeit`) and the soulbound `MilestoneBadge` receipt; a milestone is a reviewed claim in a work budget the DAO created, filed against exactly the milestone's words | `MilestoneLock.sol`, `MilestoneBadge.sol` | `MilestoneLock.t.sol` (10 tests); `DaoLaunchKit.t.sol` (the kit names the lock before the DAO exists and fails closed if it guessed wrong); full forge suite |
| Client: plan, calldata, event, receipt and panel text for a launch with milestones; read a holder's lock and the claims that can unlock it; `buzz launchpad work locks` / `work unlock` | core `daoLaunch.ts`, `milestoneLock.ts`; `launchpad_work.rs` | core tests with calldata pinned to `cast`; 17 CLI unit tests; both clients hash a milestone's words the same way (trimmed) |
| Work tab card "Your team Shares": what is locked, each milestone with its words, an Unlock button once the approved claim exists; nothing is shown to a wallet with nothing locked | `LockedSharesCard.tsx` | `scripts/web-milestone-e2e.sh` (browser, real chain) |
| The whole path on a real chain: launch through the kit, the founder voting alone with locked Shares, a transfer and a ragequit refused, a reviewed claim, a stranger sending the unlock, exactly the freed part moving and being ragequittable (the same call the lock had refused), the badge soulbound | `scripts/cli-milestone-e2e.sh` | runs green |

## Shares on a market, and prices from it: built and checked (local evaluation only)

LBAMM is evaluation-only, so all of this runs on a throwaway local chain with LBAMM cloned outside the repo
(`LBAMM_DIR`; see [LBAMM.md](LBAMM.md)).

| Piece | Where | How it was checked |
|---|---|---|
| A local LBAMM next to our contracts | `scripts/lib/lbamm-world.sh`, `lbamm-replay.mjs` | deploys on the dev chain; used by every script below |
| The DAO's vote that puts its Shares on the AMM (hook, fee, one-sided pool seeded with Shares); `market swap`; `market collect-fees` | `crates/buzz-cli/src/commands/launchpad_market.rs` | 12 unit tests with every call pinned to `cast calldata`; tick math checked against the contract's own values; `scripts/cli-market-e2e.sh` on a real chain (the vote, a buyer, a locked founder refused while a free holder sells with the same command, the fee reaches the treasury by a second vote) |
| A larger gas cap for opening a proposal, growing with the action's size and bounded | `launchpad_gov.rs` | unit test; needed because a six-call batch is bigger than the old flat cap |
| Price candles from the AMM's trades | `services/price-indexer` (Ponder) | 6 unit tests; `scripts/market-index-e2e.sh` (trades before and after it starts, the pool, candle prices, bad requests) |
| The launch page charts traded prices and a `$TICKER` chip shows the last trade, each labelled as what it is | `marketFeed.ts` (core), `use-market.ts`, `PriceChartCard.tsx`, `cashtag.ts` | 7 core and 4 web unit tests; `scripts/web-market-e2e.sh` (browser, real chain, real indexer); the 29 mocked specs that show bid prices still pass |

## Everything a person does is in the app, not the command line: built and checked

You said nobody will vote or set up decisions through a command line, so every step a person takes now has a page. Each
journey below runs in a real browser against a real local chain, each step as the wallet of the person whose job it is.

| What a person does | Where | Checked by |
|---|---|---|
| Launch a project into its own DAO, locking the team's Shares behind milestones | Manage tab / wizard | `scripts/web-dao-launch-e2e.sh` |
| See every decision the DAO has put to a vote, read from the chain (whoever opened it), with what it would do in plain words, where it stands, who backs it and the rules it must meet | **Decisions** tab | `scripts/web-decisions-e2e.sh` |
| Back, oppose or take back a vote; start the wait; run a decision | Decisions tab | same |
| **Put something to a vote** from a form: a work budget (Shares and/or money), a project, an award of Shares for a claim, putting Shares on the market, collecting the trading fees, paying from the treasury | Decisions tab, "New decision" | `scripts/web-dao-journey-e2e.sh`, `web-paid-work-e2e.sh`, `web-market-journey-e2e.sh` |
| File a claim for work, optionally asking to be paid with a deposit; the manager takes it on; reviewers approve; finish it; take the payout | Work tab | `web-work-e2e.sh`, `web-paid-work-e2e.sh` |
| Unlock a founder's locked Shares by milestone | Work tab | `web-milestone-e2e.sh` |
| Buy and sell the Shares on their market; a founder with locked Shares is told how many they may sell | Launch page, trade card | `web-market-journey-e2e.sh` |
| See the traded price on the chart and next to a `$TICKER` | Launch page, posts | `web-market-e2e.sh` |

How it holds up: the app only describes a decision as (say) a market, a work budget or a payment if its calls are aimed where a
real one's are (the DAO, its factory, its work budgets, its exchange) and a batch's approvals are exactly the budget's;
anything else is described as the steps it is, or as unknown, so a voter is never told more than the calls do. A decision
opened without its details says so and warns that nobody can tell what backing it would approve. The command line still
exists, for agents.

Not in a form yet (still the command line): changing the DAO's voting rules, who may open a decision, turning exit on or
off, closing a work budget, releasing a departed founder's locked Shares (a DAO-only power), a whitelist-only trading rule,
and anything custom. Desktop and mobile have none of the new pages.

## Product review pass: upstream sync and a friendlier web app (2026-10-09)

You asked whether the whole product makes sense, to bring in the latest Buzz, and to improve the web app (token forms, creating
an organization, the Paperclip ideas). The assessment is in [PRODUCT-REVIEW.md](PRODUCT-REVIEW.md); this is what was built and
how it was checked.

| Piece | Where | How it was checked |
|---|---|---|
| **block/buzz main merged** (106 commits; 25 conflicts resolved) | merge commit `0348d2c0a`, desktop fixes `32b7e6548` | `cargo test` for buzz-core, buzz-relay, buzz-cli and buzz-db: 2,887 passed, 0 failed; 28 Postgres-backed migration and schema tests; the 9 per-test-database tests run the way upstream's wrapper runs them; upstream's new source guard; `buzz-admin migrate` on a copy of the local dev database; every real-chain browser journey. Desktop `tsc` and `cargo check --tests` clean. |
| Our migrations renumbered 0054-0058 -> 0058-0062 (upstream took 0054-0057), with a startup repair for databases that recorded them under either older numbering | `migrations/`, `crates/buzz-db/src/runtime/migration.rs` | tests for both eras, a fresh database and a second run; the copy of the dev database went 54-58 -> 58-62 and upstream's four applied |
| Our three tables in upstream's one-file-per-table schema | `schema/tables/public`, `schema/triggers` | the desired-state vs migrations parity test |
| **Start an organization** on the web (name, first helper, how much helpers may do alone, review) | `web/src/features/fleet/` | 10 unit tests; `org-setup.spec.ts` (publishes, reads the records back; a refusing server gets a plain message and a retry) |
| A DAO's front page: where things stand, what needs you, treasury / Shares / yours, latest decisions | `DaoOverview.tsx`, `lib/dao-overview.ts` | 8 unit tests; the real-chain DAO journey asserts it |
| Sale wizard, token creation, Manage tab and dialogs in plain words; six tabs instead of seven; Home opens on what is yours | `web/src/features/launchpad`, `AppNav.tsx`, `feed/ui/HomeYours.tsx` | `pnpm test` 1,315 passed; `pnpm check` clean apart from the old `WikiView.tsx` size; the mocked browser suite: 179 pass, 26 skip, and the same 13 fail that fail on the commit before this work |
| `tour.spec.ts`: one screenshot per first-run page and creation step | `web/tests/e2e/tour.spec.ts` | opt-in: `E2E_TOUR=<dir> pnpm exec playwright test --project=smoke tour.spec.ts` |

## Clean-up pass: unused and repeated code (2026-10-09)

You asked for the cleaning to come from scanning the whole code rather than from tests. The method, what was removed
and what was merged into one copy are in [PRODUCT-REVIEW.md](PRODUCT-REVIEW.md#the-clean-up-pass-2026-10-09); the
decisions are D18-D22 in [DECISIONS.md](DECISIONS.md).

| Piece | Where | How it was checked |
|---|---|---|
| Proposal vault, simulation suite and two never-built funding paths retired | `contracts/`, `web/`, `scripts/` | Foundry suite, web typecheck and tests, the real-chain journeys |
| Paperclip bridge loop, five dead Rust helpers, two Cargo dependencies, an unused test constant | `crates/` | `cargo check --workspace --all-targets` with no warnings left; tests of every crate touched |
| 11 superseded plans moved to `docs/archive/`, links and code comments updated | `docs/`, `.github/`, `web/` | a script that resolves every relative markdown link (none broken) |
| Fourteen kinds of copy written once (tags, JSON content, sign-and-publish, the CLI's `eth_call`, wallet lookup, step reducer, wallet gate, Merkle levels, receipt read, graduation decoder, project card, hashtag row, task publisher, passkey base64) | `web/src/shared`, `packages/creaton-core`, `crates/buzz-cli` | each had tests already or got one; the whole web, core, desktop and CLI suites pass |
| **Bug found by the comparison:** the moderation queue and workflow run list never stopped polling | `web/src/shared/hooks/use-bounded-poll.ts` | `polling-bounds.spec.ts`, checked to fail on the old behaviour |
| **Bug found by the scan:** a trust-score test with no `#[test]` never ran | `crates/buzz-cli/src/commands/trustgraph.rs` | it runs now and passes |

## Differences from the plan

- **D2 (token architecture) was partly spiked.** The launch still sells the DAO's own Shares directly on the CCA, and
  nothing uses TokenMaster or LBAMM. But Shares now carry the apptoken (ERC-20C) interface and a lock guard, verified
  against the real transfer validator (above). The market venue (LBAMM, with Shares as the apptoken) is not
  integrated; what was read of it, and what it would take, is in [LBAMM.md](LBAMM.md).
- The curated bid-gate track is not supported in DAO mode (the panel says so).
- A launch record can launch once: the kit's addresses come from a per-launch salt, so relaunching after a failed raise
  needs a new record.
- The kit is deployed only on the local dev chain. No testnet deployment exists (that is a public action for you).

## Not started

- The decision forms for the rarer powers listed above, and desktop and mobile parity (D9).
- Social: merging Home and Social into one feed and one trust score service: **left alone for now, as you said**
  (Home reads launch discussion ranked by votes and Social reads a timeline, so merging them is a product redesign).
  A one-tap trade sheet on the `$TICKER` chip is not started either; the chip links to the launch, and the trade itself is
  `buzz launchpad market swap`.
- The cashtag registry rules (D5), and an indexer for the auction itself (the sale's bids come from the relay today).
- Doc updates (`docs/dao-os.md`), the agent review pass, and your own test run. The `buzz-review-completed` marker
  is yours to add.
- Whitelist-only trading of the Shares through LBAMM (a two-vote sequence: the list's id is only known after it exists),
  and reading the sale's clearing price into the market vote.

## Known open issues

- The recovery path that finds a launch again from the chain reads the kit's log from block 0. A public RPC that
  refuses a range that wide makes it fail with a retryable error rather than a wrong answer; it should start from the
  sale's start block.
- The Work tab reads whole-history logs the same way, bounded in count (8 budgets, 50 projects, 100 claims) but not in
  block range.

- **The founder's locked Shares vote from day one** (decided, D13). At a 20% sale / 20% team split the founder holds all
  of the voting supply until the sale ends, and then about half of it. The protections for everyone else are review
  time, hold time, the execution delay and exit rights. The launch panel says how much is locked; the exit screens
  elsewhere do not yet.
- A milestone is judged by a **project** whose acceptance check is the milestone's exact words, so each milestone
  needs a project the DAO votes in (the claim's check has to equal the project's to be bound). The Work tab says to
  file the claim "with these exact words"; it cannot yet create the project.
- The wizard's unlock step now says what happens for a launch into its own DAO (the reviewers of a work budget judge a
  milestone by its words, not the founder), and a "short vesting by time" plan is refused there with a plain reason.
  The unlock step of the old token-mint flow is unchanged.
- The DAO cannot burn or move a locked founder's Shares (a governance removal). `forfeit` (DAO-only) burns a departed
  founder's unearned tranches on the spot (D42); nothing else frees them.
- `ShareVesting.sol` is no longer used by the launch kit. It is kept as a standalone schedule; remove it if nobody
  wants plain time vesting.
- An unopposed holder above quorum can pass an action; review time, hold time, the execution delay and ragequit are the
  protection.
- The sell-rate gate is advisory (F8) and the TokenMaster reserve is not a price floor (see `PLAN.md` §3); both are unchanged.
- The mocked browser suite is 206 pass, 26 skipped (they need a local chain) and none failing. The 13 that failed
  before this work were looked at one by one on 2026-10-10: three were a real account-menu bug, two real wiki and
  publish problems, the rest out of date (see PRODUCT-REVIEW.md, "Hardening the front door"). The web file-size gate
  passes again.

- Start a project (templates in the browser), the three ways to run a helper, Home's checklist and the empty-community
  prompt are described in PRODUCT-REVIEW.md, "Making the first hour make sense". Build notes for hosting: set
  `VITE_CHAIN_RPC_URL`; after editing a template under `templates/` run `node scripts/regen-template-catalog.mjs`.
- Boards (posts, replies, votes), the supporters and founders boards in every template, adding people to a private board,
  and a discussion under each DAO decision are in PRODUCT-REVIEW.md, "Boards, and talking about decisions". Mocked browser
  suite: 224 pass, 28 skipped, 0 fail; `scripts/web-discussion-e2e.sh` runs the decision threads against a real local chain.
- Proposal posts without votes (ordered by decision state), one main discussion per decision, decision permalinks and live
  decision cards under messages, posts and replies: PRODUCT-REVIEW.md, "Proposal threads without votes, and decision links
  with live cards".
- A DAO's **track record** tab (public, no wallet needed): money in the treasury, set aside for work, paid and waiting; work
  filed, paid and turned down; the team's milestones and which were reached; and a dated list of what happened with who
  approved or objected. Everything is read from the chain (`web/src/features/launchpad/lib/record*.ts`, `ui/RecordTab.tsx`),
  and cut-short or undated history says so. Checked with 18 unit tests and two real-chain browser journeys
  (`scripts/web-milestone-e2e.sh`, `scripts/web-record-e2e.sh`). A wallet that exactly one person on this server has bound
  is shown as `Name (0xabcd…1234)`; unbound or doubly-claimed wallets stay addresses. Not done: a machine-readable export,
  and reading reviewers' history across DAOs.
- A **Start** page (`/start`, the green button in the top bar, and a link at the top of Home's checklist): the four steps in
  the order most projects take them (place to work, idea, raise, run it together), ticked only for what this person has
  done and pointing at the next. Each step opens the same screens as before; the Launchpad opens the idea or sale dialog
  from `?start=idea|sale`. **Three sizes for a raise** (Small, Standard, Large: a target and a sale length) on the quick
  sale an idea starts on and on the full wizard's Raise step; Standard is the app's own default. Checked with unit tests
  and `home-checklist.spec.ts` / `launchpad-presets.spec.ts`. Still two doors: Discover's **Pitch a project** (the pitch
  dialog is being reworked separately), and phones have no Start tab (they reach it from Home).
- **Self-serve communities** (`docs/self-serve-communities.md`): `POST /self-serve/communities` makes `<name>.<domain>` with the
  signer as owner; off unless `BUZZ_SELF_SERVE_COMMUNITY_DOMAIN` is set; bounded by name rules, reserved words, an attempt cap per
  key, an hourly cap for the deployment and the per-owner limit. The app has **Create a community** on the Communities page and in
  the Start page's first step. Checked: 24 server tests (12 against Postgres), 6 mocked browser tests, and
  `scripts/web-self-serve-e2e.sh` (real server, real browser: create, own, set up a team with **33 of 33** steps, name taken).
  Found and fixed on the way: a creator was not recognised as their community's owner (no member list was published unless
  membership was required), which refused every owner-only action; this also confirms the template's owner-only steps (team,
  helper seats, limits, automations, pages) on a real server. Not done: renaming, custom domains.
- **Holding age** (D23, first piece): the voting policy keeps each holder's weighted-average acquisition time of their Shares and
  `holdingAge(holder)` returns balance and age (`contracts/src/AllocationVoting.sol`, `docs/token-voting-design.md`). Receiving blends the age
  by amount, sending changes nothing, a fresh wallet cannot inherit age, a holder who sends everything loses the record. Checked: 13 unit and
  fuzz tests, a real-sale journey (a backer's holding starts at the claim, and passing Shares on hands over no age), the whole suite
  (325 passed), and three deliberate breakages each caught by a test. New DAOs only. Not built: the kit's list of its DAOs, the second
  version of the sale hook (a proof for the bidder and one per named DAO), and the screens.
- **What you hold** on the Portfolio: the Shares you hold in each DAO (from your connected wallet and passkey account), how long, and how
  many are still locked behind milestones. Read from the holding-age ledger; a DAO made before the ledger is left out, a read that fails
  says so. Checked: 8 unit tests and the real-chain milestone journey (the founder sees 200,000,000 held for 8 days with 120,000,000
  locked; a wallet with no Shares sees none). Not on public profiles yet: that waits for wallet linking.
- **Private communities and invite links** (`docs/self-serve-communities.md`, "Who may join"): each community decides for itself whether people must
  be members (`communities.membership_required`, migration 0063), asked through one question that the live connection, HTTP, git and audio
  all share; the server-wide switch still closes everything, and a read that fails counts as closed. **A new community is open unless its
  creator picks invite-only (changed from the other way round on 2026-10-13, D33)**, and an invite-only one is never open to strangers even for a moment. The owner (not an admin) can change it later with a signed
  `kind:9034`; closing also cuts off strangers who are already connected, on every server. A community's information document says
  `"access"`, and a private community is left out of the public directory. In the app: **Who can join?** when creating, and a **People and
  access** section on the Org page (who is in; the owner's choice with a plain warning before either change; owners and admins make invite
  links of a chosen length and size). A stranger who opens a private community is told it is invite-only instead of seeing a broken page,
  and an invite link now joins the community that served it even if the browser had another saved. Checked: 16 server tests (Postgres), 11 unit
  tests, 10 mocked browser tests, and `scripts/web-invite-only-e2e.sh` (real server, real browser: private by default, a stranger turned
  away, a one-person invite lets exactly one in and is refused for the next, open, close, directory) with seven deliberate breakages each
  caught by a test. Then: **list and end invites that are still out there** (`POST /api/invites/list` and `/revoke`; only a hash of each code is
  stored, so an old link is counted and ended, never shown again) and **remove a person** from the Org page (owner: admin or member; admin:
  member; a warning first), 8 more server tests and 9 more mocked browser tests, a third real-server journey, two more breakages caught.
  Not done: handing a community to a new owner from the app, and the connected EVM wallet on a profile (waits for wallet linking).
- **Reporting** (chat messages, Home posts and Social posts): a **Report** action on anything someone else wrote opens a dialog (seven plain-word
  reasons, an optional note, a promise that only the moderators see it and nothing is removed because of it) and sends the standard report
  record, which lands in the moderators' queue the web already had but nobody could feed. Not on boards or profiles yet (those files are
  being changed separately). Checked: 6 unit tests, 6 mocked browser tests, and a real-server journey (a member reports the owner's post,
  the owner sees it, with the reason and note, in the queue). **Found and fixed on the way:** every signed request without a body had no nonce, so
  two identical reads in the same second signed the same authorization and the second was turned away as a replay; the moderator check and
  the queue's first read are exactly that pair, so a moderator could see "Only community moderators can review reports" on their own queue.
- **Markets** (`/markets`, linked from Launches, which stays lit): the board of projects whose raise succeeded, each with the last traded price, the
  move over the last day, what was traded, a small chart and a link to its track record. Every figure comes from the price service's hourly
  candles (a price someone actually got); a project that has not traded says "Not traded yet", not zeros; projects without figures always sort
  last; with no price service in the build the page says so. Sorts: most traded, biggest move, newest. Checked: 10 unit tests for the arithmetic
  and formatting, 4 mocked browser tests in the standard build, and `scripts/web-markets-e2e.sh` (a build pointed at a stand-in price service that
  the spec answers with real-shaped pools and candles, both pool orientations). **Not checked against a real chain**: the LBAMM clone the real-chain
  market script needs is gone and I did not download it. Each traded project also shows what all its Shares are worth at the last price (price times the Shares' total supply, read from the chain; labelled as not what they could all be sold for), with a sort for it. Not built: a per-person trade history,
  and a trading P&L on the social feed (D6; waits for wallet linking, which says who a wallet is).
- **Error reporting** (`docs/error-reporting.md`): off unless the build sets `VITE_ERROR_REPORT_URL` to a collector you choose (https, or plain http on this
  machine). An uncaught error, a failed promise nobody listened to, or a crashed screen is posted as one small note (kind, message, stack, the page's
  path only, time, build label): keys, ids and wallet addresses are blanked first; no account, messages, cookies or query strings leave the browser;
  the same error is sent once, at most 5 a minute and 30 a visit, and a collector that is down changes nothing. Checked: 10 unit tests with a stand-in
  window and collector, and `scripts/web-error-report-e2e.sh` (a real browser: a real error and a real rejection arrive scrubbed; a dead collector
  leaves the page working). The destination is yours to choose; nothing is sent until you do.
- **Who holds the Shares** (a card on each DAO's Track record): the ten largest holders, each one's share of all Shares, how long they have held (the
  holding-age ledger: the average moment the Shares were acquired; buying more brings it down, passing Shares on does not carry the time along) and how much is
  still held back behind milestones. Balances are the Shares' own transfer history added up and checked against the total supply: if they do not
  agree the card says the list may be incomplete, and a read that fails says so instead of showing an empty list. A DAO made before the ledger is
  listed without times. Names appear only where one person on this server bound that wallet. Checked: 8 unit tests with a fake chain and the
  real-chain track-record journey (`scripts/web-record-e2e.sh`: the history adds up to the whole supply, the team's holding shows its age and the part held
  back, shares total 100%). Limits: a DAO with more than 20,000 transfers is not listed; this is D6's "supporters ranked by hold time" in its read-only form
  (nothing ranks or gates anyone by it yet: that is D23's sale gate, not built).
- **Waiting on you** at the top of Home: across the DAOs you hold Shares in (from the wallets you might hold in, as on the Portfolio) and the ones you started,
  what is waiting: a decision you can back, a claim to review, a payout to take, a step that moves a decision along, each naming the DAO and opening the place
  to do it. It reuses each DAO's own "needs you" logic, so Home and the DAO's page cannot disagree; at most six DAOs, newest first; a DAO that could not be read
  is left out rather than shown as "nothing". Checked on a real chain: with a decision open, the founder's Home lists it ("Open for your vote") and the button
  opens the decision (`scripts/web-decisions-e2e.sh`), and the mocked Home, feed, portfolio and first-run specs still pass.
- **Joining from an invite with no account** (the first users will not have one): the invite page, for someone with no account, asks for a name and offers **Create an account and join**:
  it makes an account in this browser, claims the invite signed by it, points the browser at the community, and only then publishes the name (a private community would refuse a
  stranger's profile; a refused name never undoes the join). Someone who already has an account sees the usual button. Checked: 5 mocked browser tests and a fourth real-server journey
  (no extension, no passkey, only the link; the owner sees them listed by name). The journey's helper used to return before the join had finished (the invite page's own address matched its
  "arrived" pattern), so the earlier real-server journeys quietly depended on timing; they now wait for the join and still pass.
- **Roles from the People list**: the owner can make a member an admin and an admin a member (never themselves or the owner); an admin or member is offered nothing. The server
  decides again (owner-only, in its words). Checked with unit tests, 3 mocked browser tests, and the real-server journey (an owner makes a newcomer an admin: they can now make
  invites and still cannot decide who may join). Handing a community to a new owner stays an operator action.
- **Ideas from the boards** (D37): on Work, the team turns a board post into a task (a reward, and a credit for whoever wrote it), a note is left under the post, and when the
  task is done the author claims the credit from their own Work page as a pending contribution a reviewer decides on. You cannot turn your own post into a task, the claim looks the
  post up so a task row cannot name someone else's, and a second claim is refused. Checked: 12 unit tests, 5 mocked browser tests (two guards mutation-checked: the authorship lookup and the own-post filter),
  and a real-server journey (`scripts/web-invite-only-e2e.sh`). Found on the way: the record builders cap a contribution id at 64 bytes (a longer id would have been refused by a reviewer's tools),
  and task rows made and changed within the same second tie, the lower id winning, which the journey paces around.
- **Who holds the IP** (D38, `docs/project-ip.md`): each launch records whether the IP is open-licensed, held by the founders for now (with an optional signed commitment to assign it to an entity later) or held by a named entity
  (through a signed assignment, optionally taking effect when the sale completes), with the documents linked and pinned by a fingerprint. The page says only what the documents support and
  whose statement it is; "holders direct the entity" appears only with the operating agreement linked. Checked: 14 unit tests, 6 mocked browser tests (the edit guard and the save's carry-through mutation-checked),
  and the real-chain economy, DAO-launch and paid-work journeys, which republish launch records. Found on the way: saving from the Manage panel erased the legal wrapper and the sale's
  distributor, claim-stake and verifier-set tags; fixed with a test that fails if any launch field is not carried by a save. Not built: the holder vote naming the entity, forming the entity,
  contributors accepting terms on a claim. Needs a lawyer before anyone relies on it.
- **Reviewers are independent and put a real bond behind their verdicts** (D39): a work budget refuses a reviewer whose Shares a milestone lock holds back, and can ask each reviewer for a bond in the
  claim's currency (posted before they may attest, back after a 14-day wait, slashable by the DAO in that time). The vote's summary and the Work tab show the panel, the bond and who has posted it, and a reviewer
  is offered no verdict until theirs is in. Checked: 11 new Forge tests (every guard broken one at a time to see a test fail) and the whole Forge suite (337 pass); cast-pinned encoders in the shared package and the CLI;
  mocked suite 352 pass; real-chain journeys: milestone (CLI and web), no-raise, work (now bonded), paid work, decisions, DAO journey, and the economy run, which first failed because its panel named the founder (a locked team
  member), which is the rule working on a wizard-launched DAO; its panel is now the outside backer alone, posting a 100 bond. Not built: the panel named in the launch, a vote that counts only unlocked Shares when naming the panel,
  reviewer pay, and screens for asking a bond back or slashing one.
- **A Sepolia testnet, rehearsed** (D40, `docs/sepolia-testnet.md`): `scripts/sepolia-deploy.sh` deploys our summoner and the launch kit on top of what Sepolia already has (rehearsal on a fork by default; `--broadcast` needs
  `SEPOLIA_RPC_URL` and a testnet-only `DEPLOYER_PRIVATE_KEY` in `.env`). Checked: a Forge journey on a fork of the real chain (launch with the real sale factory, Permit2 and Circle's USDC, bids, graduation, claims,
  ragequit; a bonded review, a milestone unlock and a slash), the computed Shares implementation equals a real DAO's, the rehearsal, and the whole browser economy journey on a fork (`scripts/web-sepolia-fork-e2e.sh`).
  That last run found a real bug: every event read began at block 0, which a real node refuses past about 50,000 blocks, so **My bids** could not list a bid on Sepolia; reads now fall back to pages and start at the block the kit
  was deployed (`VITE_HISTORY_FROM_BLOCKS`; 10 unit tests plus 5 on `ethGetLogs`, each guard broken once to see a test fail). The market is off on Sepolia on purpose (D40). Not done: the real deploy and hosting (need you), page-splitting in
  the CLI and desktop app.
- **The bond can be paid in any token the vote names** (D41): the work budget vote names the bond's token (the sale currency by default, the project's own token, or any other), with plain warnings for the weaker two; the factory,
  the shared encoder, the CLI (`--reviewer-bond-token`), the forms and the Work tab follow. Checked: 2 new Forge tests (each guard broken once), cast-pinned goldens, and the browser economy journey with a bond in the project's own Shares.
- **The team's lock is real whatever a vote does, and the milestone panel is named in the launch** (D42): the Shares' lock guard is set once; `forfeit` burns instead of freeing; the launch kit names the panel (reviewers, how many must
  agree, an optional bond) in the DAO's own initialization and the lock accepts no other; the panel holds nothing and its projects hold nothing; a team member cannot be on it. The launch panel (Manage tab) asks for it before the
  Launch button works and keeps what was typed across a reload; the Work tab lists the milestone panel; the project form offers the milestones. I did not build "count only unlocked Shares when naming a panel": a governor can wrap
  any call, so the only sound version reverses D13; the contract rules above make the commitments hold without it (see D42). Checked: 6 mutations of the new rules, each caught by a test; the whole Forge suite (347); cast-pinned
  launch calldata; and the real-chain launch, economy and milestone journeys. Found on the way: my own bond-token commit left `decision-forms.tsx` over the file-size limit (fixed by moving the work budget form into its own file).
  Not built: an exchange on the Sepolia fork (needs a clone of Limit Break's examples, outside this repo), page-splitting in the CLI and desktop app, screens for asking a bond back or slashing one.
- **Governance opens when the buyers can claim** (D43): another AI's product review pointed at the sale boundary (a team that votes from block one could pass a treasury drain during the sale and run it the moment the raise landed). A Forge
  test on the real kit reproduced it (the drain ran), so the DAO a launch makes now refuses every proposal until the auction's claim block (set once in its own initialization, checked against the auction). Checked: the reproduction
  turned into a passing test, four deliberate breakages each caught by a test, the whole Forge suite (349), cast-pinned launch calldata with the new field, and the real-chain launch, economy, milestone (CLI and web), DAO journeys and the
  economy journey on the Sepolia fork. The review's other findings are triaged in the conversation; its document is `MVP-PRODUCT-REVIEW-2026-10-16.md` (not mine, left uncommitted).
- **An approved claim waits a week before it pays or unlocks** (D44): the review found the dispute path could not beat the three-day payout window (a freeze needs 72 hours at the fastest). I measured it (73 hours against 72), set
  `TreasuryMandate.CHALLENGE_WINDOW` to seven days, and added two regression tests that fail if it goes back. Checked: the whole Forge suite (351), and the economy, milestone (CLI and web), work, paid-work, DAO, record and Sepolia-fork
  journeys with the longer wait. The CLI no-raise journey failed once in the dev-chain bootstrap and passed on a rerun (transient).
- **Reviewers read the evidence; a milestone is submitted from its row** (D45): the review found reviewers were asked to approve two hashes they could not read, and that a team's milestone went through the same project-and-manager flow as a paid task. Now the contributor's evidence and the words it is judged against are published as a signed update that names the claim, a reviewer sees them only if they hash to what the claim committed to on the chain, and Approve is offered only with that evidence in front of them. `TreasuryMandate.bindMilestone` lets a team member send their own free claim into the DAO's milestone panel with no project and no vote, and the Locked Shares row shows five steps with one box and one button. Checked: the whole Forge suite (353) with six deliberate breakages of `bindMilestone` each caught, the shared package (718), the app's unit tests (1559), the CLI tests (20), and the work, paid-work, milestone (CLI and web), DAO, economy, record, no-raise and Sepolia-fork journeys. The work journey now also checks that a reviewer who cannot read the evidence is offered no Approve, and the milestone journey submits the second milestone through the page.
- **The sale page says what is true** (D46): the review listed places where the page promised more than the launch does. Checked against the code and fixed: three shares for an own-DAO launch (sale, milestone-locked team, DAO reserve), a new launch is always the project's own Shares even where no launch kit exists, the main button follows the real sale (Place bid, Bidding closed, Claim tokens, Claim refund), the pre-trading price card shows the sale instead of a chart of bid limits, amounts print in the sale's currency, and the pricing, threshold, completed-sale and capital-return words were corrected. Checked: the app's unit tests, 31 launchpad browser specs including new ones for the three shares, the button states, the sale price card and the no-kit default; the DAO, economy, paid-work and Sepolia-fork journeys.
- **Reviewer continuity and the team's story on the sale page** (D47): the launch form says what happens if the reviewers cannot be reached (the Shares stay locked, only a DAO vote can burn them) and warns when nobody could be missing; the sale overview opens with an About card of the team's own statement. Checked: unit tests for the spare-reviewers rule, the mocked browser specs for the About card, and the DAO, economy and fork journeys with the new notes on the launch form.
- **A reviewer can take their bond back from the page** (D48): ask for it, wait out the 14 days, take it, with the pending amount and date shown. Checked: the shared encoders pinned to cast's output, the shared package (719 tests), and the work journey, which now asks for the bond, checks it cannot be taken early, moves the clock and takes it. Still to do from the review: the DAO-side recovery forms (resolve a frozen claim, close a budget).
- **Edge cases from the second review** (D49): reproduced the sale-button defect (a finished auction showed nothing while the record said Draft; a bid was offered at the end block) and rewrote the rule around the auction's own timing; milestone submissions are saved and resume after a cancel or reload; evidence is fetched per launch; an unreadable pending bond is reported, not hidden; the allocation text and powers card follow the lock plan; backers see the milestone panel; the signed-out homepage leads with funding and accountability. Checked: unit tests for each rule (sale button, resumable submission, evidence filter, bond read, allocation text), the mocked browser specs, and the milestone, work, paid-work, DAO, economy and CLI milestone journeys.
- **Spending by path, and holding a budget to account** (D50): the DAO's front page shows money set aside for reviewed work versus paid out directly with no reviewer, direct payments are marked and the pay form points to a work budget; freeze a claim, unwind a frozen claim, take part of a reviewer's bond and close a work budget are now decisions from forms. Checked: unit tests for the spending summary and the four builders (calldata pinned to cast), the mocked browser specs, and the economy journey, which now runs the whole dispute from the page (freeze, unwind, take 40 of a 100 bond, close and get 16,000 back), plus the paid-work journey for the direct-payment card.
- **Exit preview matches the chain, and a screen pass** (D51): the leave-and-take-your-share screen never loaded on a real chain (it asked the DAO for the Share supply, which only the Shares token knows); it now loads, leaves out the Shares the DAO holds itself and offers only unlocked Shares, so what it shows is what the chain pays; the sale stage and main button come from the chain; forms keep their state when a wallet connects; names replace addresses on the decision and treasury screens; the DAO treasury tab is one page. Chain reads retry a dropped answer, decisions are read with one log query, My bids and the holders list read in plain words. Checked: web and core unit tests (new cases pin the DAO-held and locked-Share rules and the supply read's target), the mocked browser specs (361 passed), and all nine real-chain journeys (`scripts/mvp-gate.sh`), including the Sepolia fork, where a backer now leaves with real USDC and gets exactly what the screen showed.
- **Doubting a claim starts on the claim** (D52): the Work tab's claim cards offer "Put a freeze to a vote" (or an unwind for a frozen claim) which opens that form with the claim chosen. Checked: the economy, work, milestone and paid-work journeys.
- **The sale page leads with the terms** (D53): contract addresses, proofs, trust gate and raw receipt counts are folded under Technical details and checks. Checked: launchpad mocked specs (36), economy, dao, record journeys.
- **Third-review failure cases** (D54): exit waits for the sale currency; slashing counts bond waiting to be taken back; the journey runner stops only what it started (and has its own test); spending says what it could not read; closing a budget says it ends Shares awards; a dispute never switches claims; a milestone submission is not sent unless saved; unreadable bond terms are not read as no bond; evidence is paged. Checked: unit tests (core 745, web 1,638), the economy, milestone, work, paid-work, record and dao journeys, `scripts/test-mvp-gate.sh`.
- **Pilot focus** (D55): `PILOT.md`; a public Milestones tab (criterion, tokens, stage, evidence, each reviewer's verdict, challenge deadline, release); backer and founder onboarding on Home; reviewer terms captured at launch and shown to backers; four more failure cases (runner state, sticky destructive targets, unknown token precision). Checked: unit tests (core 746, web 1,665), the runner self-test, the DAO launch, economy and milestone journeys.
- **Block dates survive a public node, and starting milestones are checkable** (2026-10-17): the record read asked for up to 200 block times at once, which a public node can answer with refusals and the dates silently vanish; they are now fetched eight at a time and a block that still cannot be had is left out, never invented (unit test counts the lookups in flight). The sale wizard told founders to write each milestone so a stranger could check it, then showed "Testnet live" as the example, filled in two-word templates and published them from the quick start; the three templates are now checkable statements, the box is a wider two-line field, and a unit test fails if a starting milestone is too short or does not say where it can be seen. Found on the way: the mocked browser specs are served from whatever build is in `web/dist`, so after a real-chain journey they run against that journey's build; run `pnpm build` (or `pnpm test:e2e:smoke`) first.
- **Plain counts and words** (2026-10-17, from a screen tour): "1 launches", "1 agents", "1 teams" and similar now use one shared helper (`shared/lib/count-of.ts`, tested) on Org, Discover, Launches, Work, the launch card tooltip and the milestone cards; the home composer's "public Nostr" box says what it does ("outside this server"); the founder's status line and the Discover and bid-saved messages no longer say "curated track", "chain undeployed" or "onchain". No behaviour changed. Checked: web unit tests (1,681), the full mocked suite (365 pass), the specs touching the changed text on the final build, and the DAO-launch and milestone journeys. The next Xcode update needs its license re-accepted (`sudo xcodebuild -license accept`) before `git` runs.
