# Plan version 2, milestone 7: Team and the auction in the app

Written 19 November 2026 on branch `v6`, for the owner and the lead. The plan is `docs/PLAN-V2.md` (section 9 row 7:
"Pair, hand over, wind down, bid, finish, trade, hand back"; sections 3, 4, 6, 7 and 11 are the spec). The contracts in
`contracts/next/src` are the source of truth for every call. Nothing here is deployed and nothing was pushed. No file in
`crates/`, `migrations/`, `schema/` or `contracts/next/src` was changed by this work (another engineer's relay work sits
uncommitted beside it and is not part of it).

## The short answer

A person can now run a project from 10,000 alone to 50,000 with a second person to a market, entirely in the new app:
add a second person, hand over the runner seat, give Shares, wind down, put a project on the network, bid in the
auction, press the finishing steps anyone may press, see the pool's price beside its depth and the floor as a melting
line, hand Shares back to the floor, and (behind a switch that no server turns on yet) buy and sell in the pool. An
earlier backer has a page of their own: their line only, the agreement shown only when it is the one the contract
holds, one agreement in 2 presses, and the delivery press afterwards.

The same calls are proven on a real EVM: an anvil loop deploys the real contracts from `contracts/next/out` and drives
the whole path through the app's own call builders and wallet code, so the calldata the screens send is the calldata
the contracts accept (6 scenarios, 4 files).

What it does not do, in order of how much it matters: **there is still no way to act from a phone that has no wallet
browser** (the passkey sender was assessed, not moved; see Open items 1), **Buy and Sell are proven by calldata and
screen tests only, not against a real router** (the Universal Router is not in the build and no fork was run), and the
**holder-control pieces of milestone 9 do not exist**, so wind down after a market is not offered at all.

## What was built, and where

Everything below is in `app/src` unless a path says otherwise. Tests sit beside the code.

| Scope | What | Where |
|---|---|---|
| 1. Team | Add a second person (offer a seat, accept it), the Pair's card (waiting calls, confirm, withdraw, open a round, open the auction), hand over the runner seat (with the founder's "I am leaving" choice), take the seat, Give Shares (held and free), wind down | `features/team/` (`team-calls.ts`, `pair.ts`, `use-team.ts`, `TeamTop.tsx`, `PairCard.tsx`, `TeamMoney.tsx`, `PersonTeamActions.tsx`, `MemberActions.tsx`, `SendSheet.tsx`, `team-copy.ts`) |
| 2. On the chain | One press puts a project on the network (the Launcher's `launch`), then writes the founder's record naming it; "Finish linking" covers a launch whose record write failed | `features/team/LaunchProject.tsx`, `launch.ts`; `packages/creaton-core/src/launchpad/project-chain.ts` |
| 3. Auction | Disclosure before bidding (held Shares, accounts, price, release dates, from the record), bid, finish steps, pool view (price beside depth), floor as a melting line, Hand back, Buy and Sell behind the trading flag | `features/market/` (`market-calls.ts`, `market-math.ts`, `use-market.ts`, `MarketTop.tsx`, `MarketMoney.tsx`) |
| 4. Chain proof | Anvil loop: solo to pair to 50,000 to auction to pool to hand-back; the runner seat; a failed sale; the earlier backers' claim | `app/tests/anvil/`, `scripts/m7-chain-loop.sh`, `app/vitest.anvil.config.ts` |
| 5. Earlier backers | The claim as plain data (typed consent, calls, reads, link fragment); the page `/earlier`; the record's counts | `packages/creaton-core/src/launchpad/earlier-claim.ts`; `features/earlier/` (`EarlierPage.tsx`, `earlier-state.ts`, `use-earlier.ts`); `features/money/numbers-market.ts` |

Added or changed since the first part of this milestone (the commits after `534260406`):

- **Runner seat tests** (`team-runner.test.tsx`): Hand over sends exactly `handOver(next, false)` from a lone runner and
  `handOver(next, true)` only when the founder ticks leaving; as a signer of the Pair it is a proposal; Take the seat sends
  `takeSeat()`; Wind down sends `windDown(key)`; no button for a non-runner, none once wound down, none at Council or Open.
- **Close a sale under its minimum with the pool step first**, and Sell's calldata and its worst-fill refusal
  (`market-trade.test.tsx`, `market-calls.test.ts`).
- **Journeys** (`team-seat.spec.ts`): hand over, take the seat, wind down, launch, and launch whose record write fails.
- **Chain proofs** (`seat.test.ts`, `failed.test.ts`, `earlier.test.ts`): see "The anvil loop" below.
- **The earlier backers' page** and its journey with axe (`earlier.spec.ts`).
- **Screenshots** of milestone 7's screens (`screens-team.spec.ts`).
- **Copy** for every refusal of the earlier backers' contract, in `team-copy.ts`, held by `team-copy.test.ts`, which
  walks every error in the build's ABIs and fails on any name, code or hex that would reach a person.
- A wallet stand-in for journeys can now change its answers after it has sent something (`afterSend`), so a journey can
  show the chain moving on after a press.

## Budgets, as measured

Held by Playwright journeys at 390x844 (`PressCounter`). A press is one tap; a field is one box typed in.

| Journey | Presses | Fields | Plan budget |
|---|---|---|---|
| Add a second person (founder) | 2 | 0 | 2 and 0 |
| Add a second person (accepting) | 2 | 0 | 2 and 0 |
| Give Shares (through the Pair) | 4 | 0 | 4 and 0 |
| Bid | 2 | 1 | 2 and 1 |
| Hand back | 2 | 1 | 2 and 1 |
| Buy, Sell | calls and screens tested; no browser journey (off by default) | | 2 and 1 |
| Finish (anyone may press) | 1 | 0 | none set |
| Confirm a waiting call of the other signer | 1 | 0 | none set |
| Open a round at Team | 1 | 0 | none set |
| Hand over the runner seat | 4 | 0 | none set |
| Take the runner seat | 2 | 0 | none set |
| Wind down | 3 | 0 | none set |
| Put a project on the network | 2 (the tab, then one press) | 0 | none set |
| Earlier backer agrees | 2 | 0 | 2 and 0 (the design's own figure) |

Where the plan sets no budget the journey holds what was measured from growing. Buy and Sell have no browser journey
because the trading switch is off in the build the journeys run on; a journey would need a build with the router's
address, which would change what the other smoke tests see. Their calls are pinned against `cast calldata` and their
sheets are tested through the components.

## The anvil loop

`bash scripts/m7-chain-loop.sh` starts a throwaway anvil (chain 31337, a free port, no history kept), deploys the real
contracts from `contracts/next/out` (no compile, no test double: Permit2, the pool manager, position manager, dollar
token, auction factory, strategy, pool guard, bid rules, parts, Launcher), and runs `app/tests/anvil` with vitest in Node,
sending every call through the app's own builders and `injectedWallet`.

| Scenario | What it proves |
|---|---|
| `loop.test.ts` | 10,000 alone, a second person, 50,000, the auction, the pool and a hand-back, with the app's calldata |
| `seat.test.ts` (3) | A hand-over is only an offer until the successor takes the seat, and nobody else can; a leaving founder's Shares are cut to the days served out of 365 and the rest returns to the work pot; a Pair's proposal withdrawn can never be confirmed, and a check-in through the Pair works |
| `failed.test.ts` | A sale under its minimum closes with one step, every bid is paid back in full, and no market opens |
| `earlier.test.ts` | Project zero named with a made-up list and launched; the app's reads of the list; the digest the app builds equals the contract's `consentDigest`; a consent in person; a consent by a wallet's typed-data signature that a stranger submits; an EOA receiver other than the holder is refused and the app says so in plain words; the keeper's replacement is vetoed once by the holder; a delivery inside 21 days is refused in plain words; after the release clock starts, anyone's `deliver` sends exactly what is due to the receiver only |

Result: 4 files, 6 tests, all pass in about 20 seconds.

One earlier finding the loop made, already fixed before this part: a call that is mined and reverts is now asked again as a
read, so the person is told the contract's reason, not a bare failure.

**Not proven on a real EVM:** Buy and Sell through the Universal Router. The router is not in `contracts/next/out`, so
the plain anvil loop swaps through the pool manager's test router, not the app's calls. A fork of a public test network
was not tried in this run (see Open items 2). Also not covered: a Vester claim by a plain grant through the app, the
reserve sale, and the Pair's `spend`.

## Gates, as run on 19 November 2026

| Gate | Result |
|---|---|
| `tsc --noEmit` (app) | clean |
| biome (app, my files) | clean; one unformatted file of the other engineer's manager feature is left to them |
| `pnpm check:copy`, `check:px-text` | pass |
| `check:file-sizes` | pass (needs `CHECK_FILE_SIZES_BASE=3d7ecf83d` in this clone, which has no `origin/main`; plain `pnpm check` stops there, an environment failure and not a product one) |
| vitest (app) | 190 passed in 27 files |
| `pnpm build` and the bundle budget | entry 417 KiB of 450; the earlier backers' page loads only when opened |
| knip | clean for this work (the unused exports it lists are the manager feature's) |
| core node tests (`packages/creaton-core`) | 1,031 passed |
| `node scripts/regen-kinds.mjs --check` | up to date (no kind was added) |
| anvil loop | 6 tests pass |
| Playwright smoke at 390x844, axe on every new screen | 69 passed (5.1 minutes, one worker) |
| forge | not run: no file was added under `contracts/next/test` or `script` |

The new screens that axe covers, at 390 and 360, light and dark: the second seat and its sheet, the seat offer and its
sheet, the Pair's card, Give Shares, hand over and wind down, the bid box and sheet, the disclosure before bidding, the
pool, hand back, the floor line, and the earlier backer's page (also with "another wallet" open).

## Screenshots

`pnpm screens` writes them to `app/test-results/screens/` (not committed): `m7-01-second-seat`, `m7-02-hand-over`,
`m7-03-pair-card`, `m7-04-bid-box`, `m7-05-before-you-bid`, `m7-06-pool`, `m7-07-hand-back`, `m7-08-floor-line`. All eight
hashes are different. The pool shot reads "Depth: Not read yet" because the stand-in wallet does not answer the pool's
storage read; the real chain does.

## The earlier backers' page

`/earlier#entry=..&holder=..&amount=..&salt=..` (the fragment never leaves the browser). It reads only the line the link
names (`leaf`, `entryOf` and `due` for that one index) plus the list's own fixed facts; a test asserts the exact reads and
that no other index is ever asked for. The server's record gives only counts and totals ("3 of 21 lines agreed, 15
Shares agreed, 0 sent"); it never carries an entry, holder or amount.

- The agreement and one-line summary are served as `/earlier-text.json` and shown **only when their fingerprints are the
  ones the contract holds now**. If the file is missing the page says so and offers nothing; if it does not match it says
  so and offers nothing. Nothing is reworded.
- The agree press is held until the person ticks "I have read all of this", then sends the contract's `consent` in person
  from the holder's wallet, to the holder or to a wallet they type. A typed address is checked as an address before the
  press is allowed; the contract's own refusals (a receiver that is neither the holder nor a wallet with code) read as
  sentences.
- After agreeing: the 21-day wait and what has been sent and what is ready, and a one-press "Send my released Shares"
  that anyone may use on their own line.
- A replacement the keeper has proposed is told to the holder with the date it applies; the holder's one veto is a press;
  after it is used, or for a wallet the keeper voided, the page says only agreeing stops it.
- Wrong wallet, closed list, list not yet funded, a link that does not match the stored line, a half link, investing off:
  each says so in words and offers no press.

What it needs from others (nothing here can be built without them):

- **Counsel** writes the real agreement text and the one-line summary, and the long-stop; the page and the contract take
  their fingerprints. No real text, name, address or amount is in the repository: the tests use made-up values.
- **The server** needs the one-use link token the design describes (the page today takes the line's own data from the
  fragment, which anyone holding the link can use); that is work in `crates/`, not here. The link tool that writes the
  fragment for each line is the owner's own and was not built.
- **Signing without sending:** the core builds the typed data and a test proves a wallet's signature over it is accepted by
  the contract, but the page offers only the in-person call. "Sign now, someone else submits" needs a place to hand the
  signature to, which is a product decision.

## For a person to try

1. In a shell with the toolchain: `cd app && pnpm build`, then `pnpm exec playwright test --project=smoke
   team.spec team-seat market earlier` (about 4 minutes). It should end with every test passing and print the press
   counts in the table above.
2. `bash scripts/m7-chain-loop.sh` (needs `anvil` on the path, or `ANVIL=/path/to/anvil`): 6 tests pass in about 20
   seconds, and nothing is left on disk.
3. In the app against a local server with investing on and a wallet in the browser: open a project you started, Project >
   Money; "Put it on the network" is one press, then the wallet asks once. Then Project > People > "Make second signer"
   with a teammate who linked their wallet on You > Your wallet. Working looks like: the teammate sees an offered seat above
   the tabs, takes it in two presses, and the Pair's card lists the calls waiting for the other signer.
4. For the earlier backers' page: serve `/earlier-text.json` (`{"version":1,"text":"..","summary":".."}` whose fingerprints
   match the contract) and open `/earlier#entry=..` with the line's own values from the wallet it was made for. Working
   looks like the text, a tick, one Agree press, then the 21-day note.

## Decisions pending the owner

1. **The link from a project's record to its launch** (the record's `chain-key` tag; the project id on the chain is the
   hash of the record's address). It is the lead's proposal and is written exactly as proposed. If the owner changes it,
   `team/launch.ts`, `launchpad/project-chain.ts` and every launched fixture change. The note lives in code comments
   and here, never on a screen. A launch is two writes (the chain, then the record); "Finish linking" covers the torn
   state and a test holds it.
2. **Whether winding down needs a supermajority of holders** (the plan's question 19). The app offers wind down to the
   runner alone, before a market; the question is a comment in `TeamMoney.tsx` and a question for counsel here, not words
   on a screen.
3. **The trading switch.** Buy and Sell show only when the server says `trading: true` and the build names the router.
   No server says so yet, so both are off by default.

## Open items

1. **The passkey sender (the top item).** Every Team, launch, bid, hand-back and trade press needs a browser-injected
   wallet, and every Team read (the Pair's signers, waiting calls, an offered seat) is disabled without one. On an ordinary
   phone browser a second person cannot even see the seat that was offered. The fix is the passkey account sender that
   `web/` already has (about 2,500 lines under `web/src/features/identity/lib/`: the sponsored sender, the Kernel
   encoding, the bundler and paymaster client, the user-operation encoder and the passkey wallet, with their tests). It
   needs a bundler and paymaster key and the network, so it could not be proven here, and moving it half-way would leave
   a sender that looks finished and is not. It would be moved into `packages/creaton-core` with a one-line re-export at
   the old path (the pattern of commit 715fd0b25) and wrapped as the app's `MoneyWallet`, loaded lazily so the entry
   stays under its budget. Changing where an earlier backer's Shares go also depends on that account existing on the
   network.
2. **Buy and Sell against a real router.** The router lives on public test networks but not in the build. A public Sepolia
   RPC answered a chain id request when scouted, but public nodes do not serve old state, so the pinned block the Foundry
   fork tests use will not work, and a fork at the head was not tried in this run. If the network refuses, the item
   stays open with the error; no work-around was made.
3. **Wind down after a market is not offered**, because the Launcher requires a Council runner for it and Council is
   milestone 9. See `docs/next-version/DIRECTION-REVIEW.md` for whether Council is still the plan.
4. **Waiting calls older than the scan window are invisible.** The Pair's proposals are found by reading its `Proposed`
   logs back through the person's wallet, at most 50,000 blocks (about 7 days at 12 seconds). Older proposals never expire
   on the chain but stop being listed; the card says the list may be incomplete. The record carries no Pair signers,
   proposals or pending runner; that is server work.
5. **The record lacks the quote token and the Pair's signers**, so the app reads them from the chain through the wallet.
6. **The earlier backers' inputs from others**: counsel's text, summary and long-stop; the server's one-use link token;
   the owner's link tool; and a decision on signing without sending (above).
7. **Not covered by the anvil loop**: the app's own Buy and Sell calls, a Vester claim of a plain grant, the reserve sale,
   the Pair's spend, and a hand-over with the founder leaving after a market.
8. **A bid on a sale that failed cannot be collected from the app once a second auction replaces it in the record**
   (the record keeps one sale). The contract still lets the bidder collect; it is a server record question (keep every
   sale), and it is the first thing a failed first auction would show.
9. **A very busy auction can have more than 512 checkpoints between a bid and the end**; the app stops there and says
   the bid cannot be collected from here, rather than guess its hints. Not seen on anvil; a fork of a real busy auction
   would show whether 512 is enough.
10. **Machine note.** The full smoke run is one worker and takes several minutes; do not run it during a cargo build.

## Review fixes

Two reviews of the milestone found no wrong calldata (targets, selectors, units, the Pair's limits and the gift rules held),
but several defects in what the screens said and allowed around those calls. Each fix below names the test that binds it;
where a test did not exist before, one was written, and the ones that guard a fix were checked by undoing the fix once and
seeing the test fail.

| Finding | Fix | Test that binds it |
|---|---|---|
| The launch journey failed in a clean checkout: the card was dropped as soon as the record named the launch, and the confirmation said from the press was dropped with it | The confirmation is said from the mutation itself, not from the press | `team-screens.test.tsx` "says it is on the network even when the page drops the card..." (fails without the fix) and the `team-seat.spec.ts` journey, which passes |
| A sale that missed its minimum could never be opened again from the app: the record keeps it as the one sale | The app reads `Finisher.stage()` and `retryBlock()` (`useSaleStage`). A failed sale shows "did not reach its minimum", and the Pair may open backing or an auction again, the auction only from the retry block, which the card names | `failed-sale-retry.test.tsx` (3 tests) and the anvil test `failed.test.ts`, which now opens the auction again from the retry block with the app's own proposal and confirm, and sees it refused before |
| The wind-down sheet promised a floor holders can hand back against; before a market there is none | The bullet now says no auction or market can open afterwards | `winddown-copy.test.tsx` |
| A remembered waiting call answered a different amount ("Your bid is in" with nothing sent) | The step's own input is part of its key: the amount of a bid, a hand-back or a trade, the Shares chosen and who for in a gift, who is offered the seat and whether the founder leaves, the second signer named, and the sale's stage for Finish | `waiting-call-amount.test.tsx` and "Give Shares with a gift already waiting" run the real path: a first press whose wait runs out, the call landing, then a different amount. Both fail when the amount is taken out of the key |
| The co-signer confirmed a round or an auction without seeing its price | A waiting call now says its terms ("1 dollar buys 3,000 Shares", "starting at 0.0004 dollars a Share") and says so loudly when they are not the usual ones | `proposal-terms.test.ts` |
| Bid copy promised everyone one price, the one the auction ends at | The sheet says the price moves as bids come in, a bid is filled at the price of each moment it is live, and no Share costs more than the top price. The done message no longer says it | `bid-disclosure.test.tsx` |
| The disclosure before an auction was only on the Money tab | It is one component (`AuctionDisclosure.tsx`) shown on the Money tab and in the bid sheet. Held Shares, accounts, prices, release dates | `bid-disclosure.test.tsx` |
| A wallet on another network made a live auction read as ended | Every project read waits until the wallet is on the project's network (`useWalletOnChain`), and the page falls back to the record's block. Sending still asks the wallet to switch | `wrong-network.test.tsx` |
| Bid did nothing when the wallet had shared no account | The press asks the wallet to share one first, then opens the sheet; a refusal is said in words | `bid-connect.test.tsx` (2 tests) |
| Every app bid is at the top price, so an oversubscribed auction left every bid "partly filled" and the app could not collect it | `exit-plan.ts` reads the bid and the auction's checkpoint list at the press and gives the auction its two hints (the last checkpoint under the bid's price, and the outbid block, or 0). A sale's bids can be collected only once the sale is finished (the auction reads as not graduated until its pool step ran) | `exit-plan.test.ts` (the plan, the walk's bound), `market-partial-bid.test.tsx`, calldata pinned against `cast`, and the anvil test `oversubscribed.test.ts`: five bids, 480,000 dollars, every bid partly filled, each settled with the app's hints on a real EVM; a wrong hint makes the contract refuse it |
| The agreement file with a missing or fractional version blanked the page | Reads as "does not match" | `text-version.test.tsx` |
| Optional: the Finish box on a sale already finished on the network | Says it is finished and offers no press | `finish-stage.test.tsx` |
| Optional: Give Shares offered 10,000,000 Shares after a market, which the monthly limit always refuses | Not offered after a market | "Give Shares after a market" in `team-screens.test.tsx` |
| Optional: the earlier backer's line was cached by entry only | The link's own leaf is part of the key | none: no test was added for the cache key itself (the existing `earlier.test.tsx` suite passes) |

Two weak patterns in the anvil tests were also fixed: `failed.test.ts` threw its own error inside a `try` whose `catch` then
checked the message, so a refusal that never happened would have passed. Both now assert the refusal happened.

### Gates after the review fixes

`tsc`, biome, `check:copy`, `check:px-text` and `check:file-sizes` (with `CHECK_FILE_SIZES_BASE=3d7ecf83d`) are clean. Vitest:
232 passed in 40 files (the manager feature's tests are in that count). `pnpm build`: entry 417 KiB of 450. knip: nothing
new from this work (`mineSalt` in `tests/anvil/deploy.ts` and the helpers it lists were there before). The anvil loop
(`scripts/m7-chain-loop.sh`): 7 tests in 5 files pass, the new one being `oversubscribed.test.ts`. Playwright smoke at
390x844: 73 passed in 5.1 minutes with axe, including the launch journey the first review found failing; the press counts
are unchanged (Bid 2 presses and 1 field, Hand back 2 and 1, Give Shares 4 and 0, Add a second person 2 and 0, launch 2 and 0).
`node scripts/regen-kinds.mjs --check`: up to date. No forge test was added and no contract source was touched.

CLAUDE.md step 3 is still outstanding: a person has to try these flows, and nothing here is marked ready.

### Declined, with the reason

- **Seat offer and second-seat card need the wallet's account before they show** (first review, finding 2): a stranger who
  has not shared an account cannot be known to be offered a seat, and a card for everyone who has no account would be noise
  on every project. The person offered a seat links their wallet on You, which shares it. Bid, where a visitor does have a
  reason to press, now connects.
- **The hand-back estimate uses the stored melting floor and a fixed 5 of each 100 fee** (both reviews, optional): the text
  says "about", the Treasury pays what its own rule says, and reading the fee settings and pending release would add reads
  to every screen for a few percent. The estimate stays; the settings can differ from the default and the screen does not
  read them. An item for the owner when fees become settable.
- **The launch sheet states 3% and 2% as text while the call pins whatever the Launcher says** (second review, optional):
  the pinned hash makes the call revert if settings move between render and press (it is read at press time), so no money
  moves on terms the person did not see; the text can then be out of date until reloaded.
- **Buy and Sell read the price up to 15 seconds before the press** (first review, optional): trading is off by default and
  unproven against a real router; to be fixed when it is switched on, with a fork test.

## A note for the direction review

`docs/next-version/DIRECTION-REVIEW.md` (the lead's memo) asks whether this can have pump.fun's speed and MetaDAO's
protection. What this milestone's build says about it, as facts and not judgements: opening backing is 1 to 2 presses
and a round takes 24 hours; getting to a market needs the Team stage, a 24-hour auction (7,200 blocks) and a 100,000-dollar
minimum; trading is off by default; every money press needs a wallet browser until the passkey sender lands; and the
protections that exist today are caps, the personal refund, the 365-day hold, the locked pool and the floor hand-back.
Holder control in the MetaDAO sense (a holders' vote, the council, pausing, replacing the runner by vote) is milestone 9
and does not exist.
