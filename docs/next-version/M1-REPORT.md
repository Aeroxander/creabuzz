# Milestone 1 report: the Uniswap route works

Written 16 November 2026, branch `v4-governance-rework`. For the owner. Plain words first; the technical facts behind
each line are in `M1-FACTS.md`, and the tests are in `contracts/next/test`.

## The short answer

**Yes: a sale ends, a Uniswap pool opens right after it with no one needing to be trusted, and people can trade in it.**
This was run end to end against the real Uniswap code on Sepolia (a copy of the live network on the test machine, using
Uniswap's own deployed pool manager and position manager), and again on a local copy that has the same Uniswap code. A
stranger starts the pool step. Bidders collect their Shares. A trade goes through the new pool, both through Uniswap's
real trade router on Sepolia and through Uniswap's test router. At every step the balances were checked to the last
unit: every dollar and every Share is somewhere I can name.

Nothing here is on a real network. Nothing was deployed anywhere. The only thing I could not do, and did not try, is
hold keys or send a real transaction.

## What worked

1. **The route.** Open a sale, take bids from several accounts, end it, anyone starts the pool step, bidders
   collect, a trade goes through. Ran in four forms: local and Sepolia copy, with the dollar sorted before and after
   the Share (Uniswap prices the pool differently for the two orders).
2. **3% to the platform, through the auction's own fee setting.** Exactly 3% of what was raised (610.750707 of
   20,358.356920 in the test sale), paid by the auction itself when the raise is swept. No fee code of ours runs on
   the money, only a 40-line controller that tells the auction the rate.
3. **22 of every 100 raised go into the pool.** 4,478.838054 of 20,358.356920 is 22.000%, to within a ten-thousandth of
   a dollar (the rate is a whole number of ten-millionths, 22/97 rounded).
4. **The rest comes back as one transfer** to the address we name (the project treasury): 75 of every 100, plus the
   Shares the pool did not need. The stand-in treasury split it 15 : 60 and the numbers came out right:
   3,053.75 spendable and 12,215.01 floor, which are 15.000% and 60.000% of the raise.
5. **The pool's position belongs to the address we name** (the future `LiquidityHolder`). The strategy never owns it.
6. **The attacks the plan promised tests for all fail to hurt**, each with a test that fails when its guard is taken
   away (see "How sure am I"):
   * stranger creates the pool first;
   * stranger calls the pool step first, or twice, or with a chosen amount of gas;
   * dust bids; bids with a silly top price;
   * a sale under its minimum (everyone refunded in full, to the unit, by the auction);
   * a partial sale (5,000 of a 10,000 goal: the price stays at the floor, half the Shares sell, the pool opens);
   * the sweeps nobody but the named recipient may call;
   * gifts of dollars and Shares to the strategy or auction before the pool step;
   * the swallowed pool-step failure.
7. **Uniswap's real trade router is on Sepolia and trades in our pool.** `0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b`.
   A wallet-style swap (token to Permit2, Permit2 to the router, one `execute`) bought Shares for exactly 100 dollars
   and sold them back for more than 90 of those 100 dollars (the rest is the 1% pool fee both ways and the price move in a small pool). So no new trade code is needed; the web app can use the real router.
   (Uniswap's test router, `PoolSwapTest`, is also on Sepolia and worked too.)

## Where the plan was wrong, with evidence

| # | Plan said | What is true | Evidence |
|---|---|---|---|
| 1 | "10 percent of Shares paired into the pool" (section 3) | The pool takes **22 of every 100 dollars raised, with the Shares that match that money at the sale's final price**. That is `0.22 x dollars raised / final price` Shares: 59.7 million (6.0%) in the test sale, at most 88 million (8.8%) if every Share sold at the final price. It is never 10% at 22 dollars. The unused part of the 100 million reserve comes back to the treasury as ordinary Shares (40.3 million in the test) | `Route.t.sol`, `test_route_saleThenPoolThenTrade`: pool Shares 59,717,840.7; reserve returned 40,282,159.3; also `M1-FACTS.md` 5. To put all 100 million in, the pool would need 25 of every 100 dollars |
| 2 | "We deploy our own copy of the vendored factory and fee controller, so no new fee code" (section 4) | Redeploying the vendored **controller** does not fix the rate: the auction asks the controller **again at every sweep** and the controller's owner can change the rate to 100% at any time, including in the middle of a sale. We need a controller with no owner. It is 40 new lines (`FixedFeeController`). Uniswap's own deployed factories on Sepolia use no controller at all (zero fee) | `ContinuousClearingAuction.sol:133,662`; `Pieces.t.sol` `test_fee_theVendoredControllerLetsItsOwnerTakeEverything`, `test_fee_nobodyCanChangeIt`; `ForkFacts` |
| 3 | "The strategy at a searched address" and "LBPStrategy factory" (task text) | v3.0.0 has **one strategy contract per network, no factory**, and **no deployment of it on Sepolia** is listed anywhere. We deploy it once ourselves, at a mined address, and every project shares it. Its factory input is our auction factory, so the chain is: fee controller, then auction factory, then strategy, then pool guard. Changing the fee recipient later means redeploying all four | `LBPStrategy.sol:54`; `DeploymentGuide.md:175-189` is only the deprecated v2 factories; `ForkFacts.test_fork_v2StrategyFactoryIsNotTheV3Strategy` |
| 4 | "No pool opens if one already exists, even a plain one" (section 9 fact 2) | Right at open time, but the strategy has a fallback the plan did not mention: if a plain pool appears **after** the sale opened, the pool step still works and puts the project's pool under a second key (the strategy's own hook). Then two pools for the one token exist at two prices. The guard is therefore needed for two reasons: stopping the opening being blocked, and keeping one single market | `Attacks.t.sol`: `test_poolFirst_withoutGuard_*` (both cases), `test_poolFirst_withGuard_*` |
| 5 | "PoolGuard ~30 lines" | 15 lines, because the vendored hook already does the whole job | `src/PoolGuard.sol` |
| 6 | "The auction's only minimum bid is not zero ... the app sets 4 times" | There is no on-chain cap on a top price except a number around 4 x 10^22 dollars per Share (so none in practice). Nothing but the app stops a silly top price. The smallest hook that can do it is the same contract as `MinBid`: it reads the auction's current price. Built and tested (`maxPriceMultiple = 4`) | `Measure.t.sol` limits; `Pieces.t.sol` `test_minBid_*` |
| 7 | "A reviewer guessed 4 to 5 million gas" to open a sale | Measured **4,272,797 gas** for the call that opens the sale (auction plus strategy). About 3.6 million of it is the one-off cost of storing the auction contract (18,061 bytes at 200 gas a byte) | `Measure.t.sol`; sizes from `forge build --sizes` |
| 8 | "Pinned block, cached" fork tests | The public Sepolia node keeps about 10,000 blocks of history and only the last few dozen blocks of state, and for blocks a few thousand old its back ends disagree. The pin can be forked only from Foundry's local cache on the one machine that filled it, or from an archive node, and even then the node must be **reachable**. The first version of the suite failed hard everywhere else. Fixed in the fix round below: the suites now skip or move to a recent block with a message | M1-FACTS 8, `contracts/next/README.md`, `test/ForkPick.t.sol`, `scripts/check-fork-degrades.sh` |
| 9 | "The finish reads the pool and refuses to split without one (`NoPool`)" (item 3 below, as first written) | True only when the sale uses the pool guard. With no guard the key is the plain pool, a stranger can create it at any price after the sale opens, and the stand-in treasury took that pool for the project's: it split 97 of every 100 as 15 : 60 with nothing in a pool (77.6 of every 100 raised in the floor). The strategy itself accepts a sale with no guard. Fixed in the stand-in; the guard is now **mandatory** (see item 3 below) | `Attacks.t.sol` `test_swallowedFailure_withoutAGuardAStrangersPlainPoolDoesNotFoolTheFinish` |

Two things that I checked and the plan had **right**: the strategy's pool step is open to anyone, works once and
swallows a failure; the vendored controller allows 100%. Line numbers in the plan were off by one or two only.

## The measured numbers

Compiler: solc 0.8.26, via-IR, optimizer 11,111 runs (the auction's own setting; the factory it builds is exactly the same
size, 24,214 bytes, as the one Uniswap deployed on Sepolia). Gas is from `Measure.t.sol`, the same on the local copy and
the Sepolia copy to within 1,000.

| Step | Gas | Notes |
|---|---|---|
| Open a sale (`strategy.initializeDistribution`) | **4,272,797** | creates the auction, moves the Shares, registers the pool. ~85% is the one-off storage of the auction's code |
| A plain token deploy (stand-in for the Share token) | 581,395 | the real `ShareToken` will be similar |
| Bid, first of the sale, new price level | 353,207 | cold start |
| Bid, new price level, later | 232,631 to 274,916 | with the lowest price level as the hint |
| Bid, price level that exists, same block as another bid | 108,614 | |
| Walking 25 price levels because the hint was the lowest one | +7,045 | about 280 gas a level; the app should pass the nearest level below |
| Final checkpoint after the end | 86,125 | anyone, once |
| **Pool step** (`strategy.migrate`) | **675,243** | sweeps the raise, pays the fee, creates the pool, mints the position |
| Stand-in treasury: split, sweep unsold | 60,600 and 30,888 | |
| Bidder collects: exit and claim | 29,559 and 31,210 | the bid that was outbid needs hints, see below |
| Trade (buy), Uniswap's test router, with an approval | 130,386 | sell back 118,582 |
| Trade (buy), the real UniversalRouter, with both approvals | 150,096 | |

**A passkey account sending "start a project and open a sale" as one batched action** would cost about
4.27 million (open) + 0.58 million (token) + the treasury copy and the first Give Shares (not built yet, I
guess 0.2 to 0.4 million) = about **5 million gas**, and the three approvals around it (about 0.1 million). That is
about 8% of a 60 million block (a typical limit of current test networks; **outside knowledge**), and under the
16.7 million per-transaction cap that Ethereum added in late 2025 (**outside knowledge**, not checked here). Whether a
particular sponsor accepts a 5 million gas operation I could not test: sponsors differ, and the per-operation caps I
remember (a few million to ten million or more of call gas, some by dollar value instead of gas) are **outside
knowledge**. On a real network the dollar cost is gas price times 5 million: at 1 gwei that is about 0.005 ETH. The
dominant part is storing the auction contract (3.6 million), which the vendored code cannot share between sales.
Building with 200 optimizer runs instead of 11,111 makes the auction 15,721 bytes instead of 18,061, saving about
470,000 gas (**estimate from sizes**, not measured). Bidding is cheap by comparison: a bid is about 0.1 to 0.35 million.

### Price limits for a 6-decimal dollar against an 18-decimal Share, 1,000,000,000 supply

| | Value |
|---|---|
| Smallest floor price the auction accepts | 2^32 + 1 = 4,294,967,297 in the auction's price units = **$0.0000000542 per Share**, i.e. all 1,000,000,000 Shares worth **$54.21** |
| So the smallest possible 400M-Share sale | **$21.68** |
| Largest top price the auction accepts for 400M Shares | 3.26 x 10^39 units = about **$4.1 x 10^22 per Share** (no practical limit) |
| A Standard sale's floor | $0.000025 per Share (all 1B Shares: $25,000), floor price = tick number 100 |
| Tick spacing I used | 1% of the floor = $0.00000025 per Share. The 4x top-price cap is tick 400, so there are **300 price levels** above the floor to bid at. The floor price must be an exact multiple of the tick |
| Route tested at sale goals | $22, $100, $1,000, $10,000, $1 million, $1 billion, $1 trillion and $1 quadrillion: the sale and the pool step worked at all eight. The only limit hit is the lower one above |

Tick spacing note: a coarser tick makes bids bunch up on fewer levels (cheaper bids, rougher price steps); a finer one gives
more levels. 1% looks right for a 10,000-dollar sale. A bid has to be placed above the current price, at a level on the grid.

## What milestone 2 and 3 must do differently

1. **Do not promise "10 percent of Shares in the pool".** Promise "22 of every 100 raised, with matching Shares at the
   final price". Decide what the returned part of the reserve is: it comes back to the treasury as plain Shares, so
   "reserve" is 10 percent plus whatever the pool did not take. Or burn it. That is a decision for you (open
   question 2).
2. **The treasury must be the `recipient` and the auction's `tokensRecipient`**, and must have public functions that
   (a) run the pool step if not done, (b) split new money, (c) sweep unsold Shares, each safe to repeat. A working
   shape is `test/mocks/MockTreasury.sol` (about 80 lines).
3. **Step 2 of the finish must read the pool, never the events, and the pool guard is mandatory.** The strategy reports
   a failed pool step as a successful transaction, emits the same "currency swept" and "tokens swept" events as a
   success, and has already sent 97 of every 100 dollars and the whole 100 million reserve to the treasury. A 15 : 60
   split of that would put 77 of every 100 dollars in the floor. The stand-in treasury refuses to split with no pool
   (`NoPool`) **only because it counts just the guarded pool**: the strategy accepts a sale whose pool settings name no
   hook (`MigratorParams.validateHook` does not check a zero hook), and then the project's key is the plain pool that
   any stranger may create, at any price, after the sale opens. So, for milestones 2 and 3:
   * the **Launcher refuses to open a sale whose pool hook is the zero address**, and refuses a hook that is not a
     guard naming the strategy as its only creator (`authorized() == strategy`);
   * the **Treasury reads the pool through `StateLibrary.getSlot0` on the pool manager**, not a copied storage index (the
     stand-in used `extsload` with the constant 6 before this fix), **and checks that the key it reads carries that
     guard**, so it cannot be pointed at a pool someone else made;
   * what to do with the money when the pool step failed is still open question 3.
   The only way I found to make the step fail is a quote token that can freeze the pool manager's address; a real
   stablecoin can do that.
4. **`positionRecipient` is the `LiquidityHolder`, from the start**, and it must exist before the sale opens (its
   address is in the sale's settings).
5. **The server helper needs the auction's hints.** A bid that was outbid cannot be exited with one number: the call needs
   the last fully-filled checkpoint and the block it was outbid (found by walking the auction's checkpoint list;
   `SaleBase._exit` does it in 20 lines). A bid above the final price is `exitBid(bidId)` with no hints. Anyone may call
   either, and the Shares and the refund always go to the bidder.
6. **A bid takes two approvals**, not one: dollars to Permit2 once, and Permit2 to the auction **for each sale**
   (the auction address is new every sale). A passkey account can send the second approval and the bid as one batch.
7. **Deploy order per network** (all mined where marked): fee controller, auction factory, strategy (mined),
   pool guard (mined), bid hook. Any change to the fee controller means a new factory, a new strategy and a new
   guard, because each holds the one before as an immutable. Put the salt-finding (`HookSalt`) in the deploy
   script; mining takes well under a second.
8. **Quote token care.** The platform's fee recipient and every named recipient must be able to receive the dollar
   token; a frozen recipient makes the sweep revert, which the strategy then swallows. Use an address that cannot be
   frozen for the fee, or accept that risk and monitor it.
9. **Settings I chose** (change freely): pool fee 1% with tick spacing 200; one full-range position (no extra
   ranges); migration allowed from one block after the end; bidders may claim from one block after the end.
10. **The strategy's own code is 473 lines I did not write and have not audited.** The vendored docs list audits for the
    launcher only up to v2.0.0; the strategy comes from v3.0.0 and I found no audit listed for it (M1-FACTS 10). The
    plan's "off until an outside review" list should name it and the auction (audited at v2.0.0, vendored at v2.1.0 plus
    two commits) explicitly. **Licence:** the strategy's source graph includes two BUSL-1.1 Uniswap files and one of their
    functions very likely lands in the strategy's bytecode, so "MIT, which allows it" was wrong; it is a counsel
    question with a change date of 2027-06-15 (M1-FACTS section 10).

## Open questions for you

1. Is **5 million gas** to open a sale acceptable to the fee sponsor we will use? This needs the sponsor's own limits,
   which I cannot see from here.
2. The Shares the pool does not take (40 million of 100 million in the test) come back to the treasury. Keep them as
   reserve, burn them, or send them to the pool in later rounds?
3. If a pool step ever fails (a frozen dollar token, a bug in Uniswap), the treasury holds 97 of every 100 dollars and
   100 million Shares with no pool. What should happen? My stand-in simply refuses to split, so the money sits whole
   and the project page says "this project has no pool".
4. The pool opens at the sale's **final price**. In the test sale that is 3x the floor, while the average buyer paid
   2.04x (20,358 dollars for 400 million Shares at the end, not all at the final price). Early buyers are in profit the
   moment the pool opens and late buyers are not. That is how the auction works; the page has to say it plainly.
5. Which dollar token on the real network? Its freezing rules decide how risky item 8 above is.
6. Optimizer setting: 11,111 runs (matches Uniswap's build and bids are cheaper) or 200 runs (about 470,000 gas
   cheaper to open a sale)?

## Fix round (16 November 2026, after review)

A reviewer found three problems in the first version of this milestone. I checked each one first; all three were real.

**I-1. The fork suites failed hard on any node that could not serve the pinned block.** Reproduced before changing
anything: with `SEPOLIA_FORK_BLOCK=12140000` against the public node every fork suite died in `setUp` with "Archive
requests require a personal token"; with `SEPOLIA_RPC_URL=http://127.0.0.1:1` (dead node, pin cached on this machine)
every fork suite died with "could not instantiate forked environment". So "cache-only repeat" also needs a reachable
node, which the first report did not say. What I changed:
* `test/helpers/ForkPick.sol` decides, and the suites ask the node before forking: a dead node skips with a message; a
  named block the node cannot serve skips with a message; an unserved pin with no block named runs at a recent block
  (head minus 3) and says so; `SEPOLIA_FORK_TRUST_CACHE=true` forks at the pin without asking, for the machine whose cache
  holds it. Table in `contracts/next/README.md`.
* The public node answers a block a few thousand blocks old inconsistently (one read passes, the next fails, a different
  account fails each run, measured at block 12,140,000), so a single probe read was not enough: my first version of the
  probe let 2 to 5 of 7 suites through and they then failed in the middle. The probe now needs 16 unrelated accounts to
  answer (64 for a block more than 256 behind the head) and one answer is shared by all suites of a run.
* The README now says the pin is keyed to the machine and the Foundry build, and records this machine's build:
  `forge 1.4.3-v1.4.3`, commit `fa9f934`, built 2025-10-22. I no longer claim the pin repeats anywhere else.
* **What this does not give:** a guarantee. The probe is a test of a flaky node, not a proof; a node that passes it and
  then fails a later read would still fail a test. With the final probe I ran blocks 12,146,000, 12,140,000 and
  12,130,000 against the public node, twice each (6 runs of the fork suites; every suite skipped, none failed). With an
  earlier 16-account-only probe, 12,140,000 skipped in 4 of 4 runs and 12,100,000 in 1 of 1, but 12,146,000 failed one
  suite once, which is why old blocks now need 64.
* **A consequence I hit:** my own new fork test (I-2) reads state at the pin that was never cached, so a cache-only run
  at the pin fails that one test (48 of 49; the failure is "Archive requests require a personal token" on a Permit2
  storage slot). The finding predicted exactly this. The check script excludes that one test in its cache-only case and
  says why; every earlier test still repeats from the cache.

**I-2. The finish's "NoPool" protection depended on the pool guard.** Reproduced with a new test before fixing: with no
guard, a stranger creates the plain pool at price 1.0 after the sale opens, the pool step fails (a dollar token that
refuses the position manager), and the stand-in treasury's `poolIsOpen` said "yes" because it only tested that the plain
key had a price. Settling then splits the 97 of every 100 as 15 : 60, which puts 9,312 of 12,000 raised (77.6%) in the
floor with nothing in a pool. The strategy itself accepts a sale with no guard. What I changed: the stand-in now counts
only a pool at a key whose hook is a guard that names this strategy as its only creator, and it reads the price with
`StateLibrary.getSlot0` instead of a copied slot index. The Launcher and Treasury of milestones 2 and 3 do not exist yet,
so the rule for them is written into "What milestone 2 and 3 must do differently" item 3 above: the Launcher refuses a
zero hook, the Treasury reads the guarded key through the state library. **The plan text was not edited by me** (it is
outside the paths I own); lines to add to `docs/NEXT-VERSION-PLAN.md` section 5, "Finishing a sale", and section 9:
"The pool guard is mandatory: the Launcher refuses a sale whose pool hook is the zero address, and the finish counts
only the guarded pool." The test is `Attacks.t.sol`
`test_swallowedFailure_withoutAGuardAStrangersPlainPoolDoesNotFoolTheFinish`, local and on the Sepolia copy.

**I-3. "MIT, which allows it" was not an answer.** The strategy's source graph is 76 files, 74 MIT and 2 BUSL-1.1
(`v4-core` `Pool.sol` and `Position.sol`). I went further than the reviewer: `PositionPlanner.resolve` calls the
BUSL function `Pool.tickSpacingToMaxLiquidityPerTick` (an internal function, so it is compiled into the caller), and the
strategy calls that path. So a BUSL function very likely reaches the strategy's bytecode. I did **not** confirm it in the
compiled bytes. The auction factory (which carries the auction), `PoolGuard`, `MinBid` and `FixedFeeController` have only
MIT files. Change Date of the BUSL grant: 2027-06-15 or an earlier date set on chain; the Additional Use Grant is an
on-chain reference I could not read. M1-FACTS section 10 is rewritten; this is now a counsel question, not a cleared item.

**Guards I removed once in this round to see the tests fail** (all four were applied in one build, then restored with
`git checkout`; each row names the test or script case that is attributable to that one change):

| What I broke | What failed |
|---|---|
| `poolIsOpen` stops checking for a guard (I-2) | `test_swallowedFailure_withoutAGuardAStrangersPlainPoolDoesNotFoolTheFinish` (local) |
| `ForkPick`: a dead node no longer skips (I-1) | `ForkPickTest.test_aDeadNodeSkipsEvenWhenTheCacheIsTrusted`; script cases "dead node" and "dead node, cache trusted" (7 failures each instead of 7 skips) |
| `ForkPick`: an unserved pin is forked anyway, no recent-block fallback (I-1) | `ForkPickTest.test_anUnservedPinMovesToARecentBlockWithAMessage` |
| `Stack`: the probe's answer ignored, node always "serves" (I-1) | script case "named block too old": 21 failures instead of 7 skips (the unit tests cannot see this one, the probe is wired in `Stack`) |

I did not mutate the `FORK_TRUST_CACHE` branch or the 16/64-account probe size separately: the first is covered by
`ForkPickTest.test_trustingTheCacheForksTheUnservedPin` and the script's cache case, the second only by the repeated runs
above (evidence, not a test).

## How sure am I

**What I ran** (all in `contracts/next`; commands at the end):
* `forge build`: passes.
* `forge test`: after the fix round, **96 tests in 13 suites, 0 failed**, on a local copy of the Uniswap code and on the
  Sepolia copy (public node, no block named, so the pin was not served and the run used a recent block). Without
  `SEPOLIA_RPC_URL`: 47 passed, 0 failed, 7 skipped (the fork setUps skip with a message).
* `forge fmt --check src test`: clean.
* `git diff --stat` against the commit before my first one: nothing changed under `contracts/` outside `contracts/next/`.

**Guards I removed once to see the tests fail** (then restored; `git status` clean after each). Test names that failed:

| What I broke | Tests that failed |
|---|---|
| Fee controller returns zero | 6, including the route test (the platform fee is asserted to the unit) |
| Fee ceiling removed / a setter that does not refuse | 1 each |
| Bid hook: no minimum | 2 (dust bids) |
| Bid hook: no top-price cap | 2 |
| Pool guard replaced by one that accepts everybody | 3 (stranger can create the pool, in 2 places and in the all-together test) |
| Treasury splits money with no pool | 2 |
| Treasury sweep / pool step not safe to repeat | 1 and 2 |

Not removed, because the guard lives in vendored code that I may not edit: the strategy's one-shot pool step, its
`OnlySelfCall`, the auction's recipient-only sweeps and its `NotGraduated` refusal. Those tests assert the vendored
behaviour. For the pool-step caller-gas attack the test scans 85 gas limits (400,000 to 12,000,000) and finds only
"whole call reverted" or "pool opened", never the swallowed failure. That is evidence, not a proof; the reason it
holds is that the recovery path needs far more gas than the inner step, so any limit that starves the inner step also
starves the recovery and reverts everything.

**A mistake I made and caught:** the first time I broke the pool guard, every test still passed. The tests load a helper
contract from a build file, and `forge test` was not rebuilding it. I fixed that by making the tests import the helper
so it is always rebuilt, then repeated the break: three tests failed. Without that fix the mutation checks (and any
future guard change) would have silently tested an old build.

**What I did not run or did not check:**
* Nothing on a real network or with a real key. Nothing was deployed.
* The old suite in `contracts/` was not run; only the diff proves it was not touched.
* Sepolia pins: the first version's fork tests ran against block 12,146,937 (16 November 2026). That block can be forked
  again only from Foundry's cache on this machine (`forge 1.4.3`) with a reachable node, or from an archive node; after
  the fix round a plain `forge test` with the public node runs at a recent block instead. I ran the cache-only repeat of
  the pin once (48 of 49 passed; the one failure is the new test whose reads were never cached, see the fix round).
  I did not run an archive node. The local copy needs no network at all.
* The 200-run optimizer saving is an estimate from sizes, not a measurement.
* Sponsor limits, block-limit figures and the 16.7 million transaction cap are from memory (outside knowledge).
* Fuzz and invariant tests were not written (the plan puts them in milestone 2).
* The `ShareToken`, `Treasury`, `LiquidityHolder`, `Launcher` named in the plan do not exist yet; the stand-in treasury is test code.
* Real money behaviour of a pool this small: a 2,500-dollar sale puts about 550 dollars in the pool; I did not model the
  price jump a trade makes there, beyond the test sale's 100-dollar trade (it moved the price by a few percent in a
  4,500-dollar pool).

Commands (from `contracts/next`):
```
forge build
forge test                                            # local; fork suites skip without an RPC
SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com forge test
forge fmt --check src test
scripts/check-fork-degrades.sh                        # fork suites skip or move, never fail, on nodes that cannot serve the pin
CHECK_CACHED_PIN=1 scripts/check-fork-degrades.sh     # plus the cache-only repeat of the pin (this machine only)
```
