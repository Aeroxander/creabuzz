# Creaton: plan for the next version

Status: a plan, nothing built. Written 16 November 2026 on branch `v4-governance-rework`. Nothing is on a real
network; everything below is for Sepolia (the test network) first.

How to read the numbers. **(code)** = read in this repo's code, file and line given. **(counted)** = counted with a
tool. **(judgement)** = my choice, change it freely. **(estimate)** = a guess at size or time. Nothing was run for this
plan, so no gas or timing figure is measured. "Outside knowledge" = what I know of other products, not checked here.

## 1. The new version in five lines

1. One kind of project. One person starts it in about a minute with three typed answers.
2. Every project has 1,000,000,000 Shares, fixed for ever. The founder hands them out for work with one press.
3. One press opens a 24-hour public sale (the Uniswap auction already in this repo). When it ends, a Uniswap V4 pool
   opens by itself and Shares can be traded at once.
4. Most of the money raised is paid to the project day by day over a year. The part not yet paid is the **floor**: any
   holder can hand Shares back for their slice of it, any day.
5. The platform takes a small cut, in dollars, of raises, trades, exits and paid work.

- **Founder:** no reviewer, no second person, no address, no vote needed to start, hand out Shares or raise.
- **Backer:** type an amount, press Back. Shares arrive by themselves. Price, chart and floor are on the page. Leave by
  selling in the pool or by handing back at the floor.
- **Contributor:** join from a link, take a task, get Shares or money in the same press that accepts the work. Today
  that takes 13 to 15 days.

## 2. What was wrong

| Decision being reversed | Why it hurt | What replaces it |
|---|---|---|
| Shares locked between wallets; two votes and 30 days to unlock. Recorded as D77 in `docs/v3-review/DECISIONS.md`; `MolochPatched.sol:1630`, `:1982-1986` (code) | Five to six weeks at best, then still no market. The only way out drains the project's treasury | A plain token, never locked. Team Shares are held back by time instead |
| "No Uniswap V4 pool" (D12, D14, same file; `GraduationExecutor.sol:14`) | 100% of a raise went to the treasury, none to a market. The pool code sat unused in `contracts/lib` | The vendored Uniswap strategy opens a V4 pool when the sale ends |
| Founder may not be a reviewer and must name one (D79; `ContributorKit.sol:122`, `:131-133`) (code) | A person alone cannot set up Shares | No reviewers needed. Optional later |
| New Shares only as a reviewed award (D76) | 13 to 15 days to give a teammate Shares | "Give Shares": one press, capped, public log |
| Three starter kits, each sealed for ever (`docs/v3-review/CONTRIBUTOR-KIT.md`) | Projects stranded on old kits after ten days of testnet | One launcher; features are added later, not sealed out |
| The backing curve (`docs/v3-review/BACKING-POOL.md`; `BackingPool.sol:1104-1117`) | About 89 of every 100 paid never reaches the project | One sale, one pool |
| Weekly batch market (`docs/v3-review/CONTRIBUTOR-TOKEN-TRADING.md`) | 32 buyers a week, prices voted in advance | The always-open pool |
| Judged milestones on team Shares (two systems) | A solo founder must find judges before having a product | Release by time, 12 months |
| Heavy holder votes for routine things (`AllocationVoting.sol:160-161`) | Three or more days and 20% turnout for anything | Founder acts inside limits the contract enforces; votes only for two questions |
| The page never shows a price (`BackingBlock.tsx:1-5`); projects with sale terms hidden from visitors (`public_read.rs:483-516`) (code) | A launchpad that hides its launches | Price, chart and floor on every page, public |
| Leaving switched on for ever, fee read through an abandoned contract (D73; `MolochPatched.sol:1186`) | A buyer who left before the sale money arrived burned Shares for nothing (`:1203-1210`) | The exit right lives in a small treasury contract, refuses before the money has arrived, and winds down by itself |
| Features chosen by about 35 build settings | Investing means rebuilding the app | One build; the server says what is live |

## 3. One project's life

"Press" = one button. "Touch" = one passkey confirmation (a passkey is the fingerprint or face sign-in on your
device). Waits assume Sepolia, about 12 seconds a block. All numbers (judgement).

| Step | What the person does | Wait |
|---|---|---|
| Start alone | Start, passkey touch, three fields (name, goal, how you will know), Start. 3 presses, 3 fields | None. Nothing goes on the chain yet, so junk projects cost the platform nothing |
| First work | Post an update (1 press, 1 field). Add a task (2 fields). An agent can do both from the command line | None |
| Add people | Copy the project link. The other person opens it, makes a passkey, presses Join. 2 presses | None if the project is "open to join" (default); else until the founder presses Accept |
| Give Shares, alone | Give Shares, pick a person by name, pick an amount, Send. The first time, this press also creates the project's chain parts | About 15 to 30 seconds |
| Raise | Open backing, pick a size (Standard preselected), Confirm. 2 presses, 0 fields | Sale runs 24 hours |
| Back | Type an amount, Back, touch. The app sets your top price at 4 times the current price and shows it | None |
| Sale ends | Nobody presses. The server's helper finishes the sale, opens the pool and delivers Shares | About 1 to 5 minutes |
| Trade | Buy or Sell in the same box. 1 field, 2 presses | None |
| Exit | Sell (the app takes the better of pool or floor), or Hand back at the floor. 2 presses | None |
| Sale fell short | Under the minimum everyone is refunded in full by the auction itself. Founder may try again with any size | 24 hours before retry |
| Bear market | Price drifts to the floor. Traders who buy below it and hand back hold it there. Backers who leave take only unpaid money; the project keeps what it was already paid and the pool stays | None |
| Scale | Later sales from the reserve (plain auction, money to the treasury), 28 days apart. After 365 days holders may vote to replace who runs the project | Vote: 3 days |

What Shares exist at birth (judgement): 40% first sale, 10% paired in the pool, 20% founder, 20% work pot, 10% reserve
for later sales.

Limits on the team, all enforced by the contract:
- Founder's 20%: released evenly over 365 days from the day the pool opens.
- Shares given **before** the pool opens follow the same 365-day release and cannot be handed back until released.
  This is what stops a dump at the first block.
- Shares given **after** the pool opens are free at once, at most 1% of all Shares per 30 days per project.
- Reserve leaves only through a public sale.

## 4. Money rules

All (judgement) unless marked.

**Each 100 paid into a sale**
- 3 to the platform.
- 22 into the Uniswap V4 pool with matching Shares at the sale's final price.
- 15 to the project at once.
- 60 into the floor, paid to the project evenly over 365 days (0.164 a day).

**Sale sizes:** goal 4,000 / 10,000 / 50,000. Minimum to go through: 2,000 / 2,500 / 12,500. No maximum; more demand
lifts the price. Smallest bid 1 dollar.

**Who owns the pool liquidity:** nobody. It sits in a contract with no way to take it out. Only trading fees leave.

**Fees**
- Raise: 3%, taken through the auction's own fee setting. We deploy our own copy of the vendored factory and fee
  controller (`ContinuousClearingAuctionFactory.sol:14-22`) (code), so no new fee code and Uniswap cannot change the
  rate under us. The vendored controller lets its owner set anything up to 100% (`ProtocolFeeController.sol:44-45`)
  (code), which is why we do not use Uniswap's deployed one. The licence of the vendored code must be checked first.
- Pool trades: 1%. Dollar side: half platform, half project. Shares side: burned.
- Exit: 5%. 4 stays in the floor for those who remain, 1 to the platform.
- Paid tasks: worker gets the full amount; the payer pays 2.5% on top. Shares given for work: no fee.

**The exit right and its floor.** Floor per Share = floor money divided by Shares in people's hands (Shares the project
holds and Shares not yet released are left out, as today's code does at `MolochPatched.sol:1148-1166`). Worked example,
10,000 raised at the Standard floor price: 6,000 floor money over 500,000,000 Shares = 48% of the sale price on day
one, 45.6% after the fee. It falls every day as the project is paid and reaches zero after 12 months unless the
project adds money ("Share revenue" puts money into the floor; that part never melts).

**Anti-drain rules**
1. Only the floor can be handed back against. Never the 15 paid at once, never money already paid out, never the pool.
2. The 5% fee means buy-and-hand-back only pays when the price is more than about 5% under the floor.
3. Each exit takes only its own slice; the 4% left behind lifts the floor for the rest.
4. Refused until the sale money has arrived.

**Stopping a founder who goes quiet.** The daily payment only runs for 14 days after a "check-in". The weekly update
button sends the check-in in the same press. Stated plainly: the chain cannot read an update, so a junk update keeps
money flowing. The answer to that is the Stop vote (section 5) and the always-open exit.

**Accepted, not fixed:** in a bear market the sensible move for many holders is to hand back early, and that takes the
project's future budget. A project could end with its 15 plus a few weeks of payments. That is backers taking unspent
money back, which is the point of the right. The knob to turn is "15 up, 60 down".

**What the platform takes, honestly sized.** In a bear year of 200 sales averaging 5,000, 3,000,000 traded and 100,000
of paid tasks, about 50,000 dollars (my arithmetic). About 85% of it still comes from raises and trades. It covers a
server and cheap-network fees, not a team.

**What CREATE is for.** Creaton itself becomes project number zero on its own launcher and CREATE is its Shares. All
platform fees go to that project's treasury: half into its floor, half spendable on running costs. So CREATE has the
same two lines as any project, a price and a floor made of real fee income. The court, juror stakes, bonds and the
faucet go. This does not make CREATE valuable; it makes it honest.

## 5. The contract set

Today: about 15,900 lines in `contracts/src` (counted), including a 3,090-line forked DAO. After: about 1,900 lines of
our own (estimate; an earlier draft said 950, reviewers showed that was low by half), on top of Uniswap code that is
vendored and used as it is.

**New**

| Contract | Job | Size (estimate) |
|---|---|---|
| Launcher | One per network. Creates a project's token and treasury in order, tied to the project's signed record. Opens the sale by filling in every auction setting itself. Holds platform defaults, changeable for new projects | 400 |
| ShareToken | Plain standard token, fixed supply, holder can burn own. No lock, no call-backs | 40 |
| Treasury | One small copy per project. Floor and spendable buckets, daily release with check-in, exit right, Give Shares with caps, spend, agent daily caps, top-up | 550 |
| Vester | Holds founder Shares and pre-pool gifts; releases over 365 days from pool open | 150 |
| LiquidityHolder | Holds every pool position for good; splits trading fees | 120 |
| PoolGuard | Tiny pool-creation guard built on the vendored `InitializerHook` (56 lines, code). Only the strategy may create a project's pool. Does nothing on trades | 30 |
| MinBid | Bid check for the auction: refuses bids under 1 dollar | 40 |
| Tasks | Money set aside per task; pay on accept; refund after the deadline. Reshaped from WorkAreaBounty | 200 |
| HolderVote | Park Shares for 3 days to vote. Two questions: Stop payments (any time; more than half yes, 20% of Shares in people's hands, all founder Shares may vote, payments pause while it is open, nothing is burned). Replace who runs the project (only after 365 days or 28 days of silence) | 220 |
| Pinned interfaces | Our fixed view of the strategy and V4 pieces, with a test that fails if upstream changes | 150 |

**Finishing a sale** is three separate steps, each safe to repeat and each fine if a stranger did the previous one:
open the pool, settle the treasury from the auction's own reported total, sweep unsold Shares. Reason: anyone may call
the strategy's pool step (`LBPStrategy.sol:212`), it works only once (`:237`), and a failure inside it is swallowed and
looks like success (`:251-252`) (code). The app reads the outcome from the strategy's event and says plainly "this
project has no pool" in the rare failed case.

**Current contracts**

| Contract | Fate |
|---|---|
| CCA.sol, TestQuoteToken.sol | Keep |
| WorkAreaBounty | Change into Tasks |
| OrgAllowance | Merge into Treasury (agent caps) |
| Payouts | Merge into Treasury ("Share revenue") |
| ShareVesting | Merge into Vester |
| DaoLaunchKit | Merge: its one-transaction, founder-never-holds-the-money property moves to Launcher; the rest is deleted |
| majeur/MolochPatched (and the `lib/majeur` submodule) | Delete. Two ideas carried over: the exit right and its two exclusions |
| GraduationExecutor | Delete (cannot work beside the strategy). Freeze the desktop copy of the launchpad first; it embeds this contract |
| ContributorKit, V2, V3 | Delete |
| AllocationVoting, ActivationVoting, VotingWeight | Delete |
| BackingPool, BackingPoolFactory, BackingClaim | Delete |
| SecondaryMarket, SecondaryMarketFactory, ISecondaryPolicy | Delete |
| TreasuryMandate, MandatePartsFactory, ClaimStake, VerifierSet | Delete |
| MilestoneLock, MilestoneLockFactory, MilestoneChallenge, MilestoneChallengeFactory, MilestoneBadge | Delete |
| OpenBounty, FundingTerms, WeeklyRounds, RoyaltyDistributor, OrgBinding | Delete |
| CreateToken, CreateFaucet, CreateCourt, RemixBond | Delete |
| hooks/AllowlistHook, hooks/TrustGatedHook | Delete |
| Vendored LimitBreak libraries | Delete (nothing in `src` imports them) |

## 6. The web app

**Five screens.** Home (projects moving now, sales in progress on top). Project (one page for every project: price,
small chart with the floor line and its dotted future, a Back / Buy / Sell / Hand back box, then Updates, Tasks,
People, Money). Start. Work. You.

**Deleted from the web app:** the sale wizard, bid screens, graduation and launch panels, weekly trading, curve
backing, court, challenges, the agreed-reward lane, work budgets and areas, the ten decision forms, milestone screens,
forecasts, trust graph, check notes, the sandbox, the old projects board, the timeline pages, rooms, boards, wiki,
code browser and helper fleet (these last five remain in the desktop app), the wallet-or-passkey picker, every field
asking a person for an ID or address, every browser-posted receipt, and the hand-typed contract calls (replaced by
calls generated from the contract build; outside knowledge: viem is the usual library, check its size). Each feature is
deleted together with its tests in the step that replaces it. Target: from about 233,000 lines to about 70,000
(estimate).

**Fun, honest mechanics only**
- A live price beside the delivery record, on every project and every link preview.
- Two lines on the chart: price and floor. Real events marked on it; the page never says an update caused a move.
- The sale as a 24-hour event with a countdown; optional weekly "Demo Day" start, worded "about", shown from block
  numbers.
- Later (milestone 8): one-press calls on weekly promises, streaks, boards. Boards never sort by price. A call or a
  "confirmed" mark counts only from an account that has held that project's Shares for 7 days, because free scores get
  farmed.
- Home is never sorted by money raised alone; a founder's own bid can inflate that.

**AI projects**
- An agent can run a project's week from the command line: updates with check-in, tasks, hand-ins, gifts and payments
  inside daily caps its runner sets (default 25 dollars and 0.1% of Shares a day).
- Keep one agent rule: an agent never confirms its own work, its runner's, or a sibling agent's
  (`launch_update_authority.rs:531-534`). Drop the bans on agents setting goals and promises; show "set by an agent
  run by (person)". Turn agent sign-in on.
- Opening a sale needs the runner's one touch. Agents pay their own network fee in this version.
- One server answer to "is this an agent" and "open to agents".

**Press and field budgets, each held by a test** (the pattern in `web/tests/helpers/press-counter.ts`): Start 3 and 3.
Give Shares 4 and 0. Post a task 2 and 2. Accept and pay 1. Open backing 2 and 0. Back, Buy, Sell, Hand back 2 and 1.
Join 2 and 0. Weekly update 2 and 1. Collect after a sale 0 (a Collect button is the fallback, and the normal route for
a bid that was outbid).

**Legal lines.** The line "Buyers acquire ownership only: governance and exit. No dividends or revenue share, ever,
unless they contribute and earn one." (`web/src/features/launchpad/ui/widgets.tsx:198-199`) and the terms, privacy and
age texts are not reworded or hidden by this plan. This plan changes what Shares are (tradable, in a pool, with money
that can be put into the floor), so those lines need the owner's and counsel's read before anything about them
changes.

## 7. Server and records

1. **Open the door.** Set `BUZZ_REQUIRE_RELAY_MEMBERSHIP=false`, which is the server's own default
   (`config.rs:1021-1023`) (code). Extend the first-day posting limit to project records.
2. **Join link.** Today only a server owner or admin can make an invite (`invites.rs:350-369`) (code). New: the project
   link opens on Join; an "ask to join" record anyone may sign; one-press accept. Team list kept by the server (cap of
   19 lifted).
3. **Public by default.** Delete the rule hiding projects that state sale terms. Previews carry price and raised.
4. **The server reads the chain** (new). One job follows launcher, token, auction, pool and treasury events into new
   tables, remembers its place so a chain rollback is handled, and signs one "project numbers" record per project.
   Browser-posted copies of bids and receipts are refused; today anyone can forge them.
5. **Helper job.** Finishes sales, delivers Shares, collects pool fees. Every call is one anyone may make. It skips
   bids under a set size, has a daily spending cap, and records each step before trying it.
6. **Settings from the server.** The deploy script writes one file; the server serves it. One setting, "investing:
   off", hides Back, Trade and Open backing without a rebuild.
7. **Network fees.** A global daily budget that fails closed with a plain message. Opening a sale is sponsored once per
   account per week. Until our own gateway exists, keep the current fee service with a list of allowed contracts.
8. **Project is not one person's key.** The project's id is its launcher number once on chain; the server keeps "who
   may sign for this project".
9. **Accounts.** Keep the passkey's public sign-in data on the server so a synced passkey works on a second device with
   one touch. Second passkey as back-up before any real network.
10. Unique project names per server and a report-and-hide path for copycats.

## 8. Build order

Every size is an (estimate) for one experienced builder. Each milestone runs on Sepolia.

| # | Milestone | Size | Proves | Tested by |
|---|---|---|---|---|
| 0 | Open sign-up, join link, public pages, settings from the server. No contract change | 1 week | A stranger reads a project and joins in 2 presses | Server tests, real-server loop, a human on a phone |
| 1 | Prove the Uniswap route with a plain test token: our own factory and fee controller, the strategy at a searched address, PoolGuard, MinBid; sale, pool, one trade | 1.5 weeks | "Pool right after the auction" works; measured gas for opening a sale from a passkey account; whether Uniswap's trade router is on Sepolia; price limits for a 6-decimal dollar | Fork tests against real Uniswap code, including: stranger creates the pool first, stranger calls the pool step first, dust bids, sale under minimum, partial sale |
| 2 | ShareToken, Treasury, Vester, Launcher start and Give Shares | 2 weeks | One person makes Shares and gives them, alone | Unit and fuzz tests on three written rules: buckets equal the balance; an exit never pays more than its slice; project-held and unreleased Shares never count |
| 3 | Sale into pool: open, three-step finish, LiquidityHolder, floor, exit, check-in | 2 weeks | The 3 / 22 / 15 / 60 split and the floor behave as written | Fork tests, plus named attack tests: buy below floor and hand back; founder dump at pool open; hand back before settle |
| 4 | Server: chain reader, project numbers, helper job | 4 to 6 weeks | A visitor sees live numbers; Shares arrive with nobody pressing | Server tests, real-server loop on a local chain |
| 5 | Web money path: generated calls, one sender, Start, project page, Back box; old screens and their tests deleted here | 4 weeks | Budgets in section 6 hold with a passkey | About ten real journeys with press budgets; a human on a phone |
| 6 | Tasks, agent caps, agent rule changes, command-line updates | 2 weeks | An agent runs a week unattended; a stranger is paid on accept | Unit tests, real-server loop |
| 7 | HolderVote, project signer list, second-device sign-in, back-up passkey | 2 weeks | Holders stop payments in 3 days | Unit tests, attack test: late buyer tries to seize a project |
| 8 | Fun layer, Creaton as project zero, later-round sales | 3 weeks | Something to do on a quiet day; fees show as CREATE's floor | Real-server loop, a week-long public test |

In parallel: 0 beside 1; 4 beside 2 and 3 once the launcher's events are agreed; 6 and 7 beside 5. Roughly four to five
months of work in all (estimate).

## 9. Off until an outside audit, and what could still go wrong

**Off until an outside review of the roughly 1,900 lines:** any real network; real dollars; CREATE as a real token;
sponsored fees without the global cap; later-round sales.

**Still open**
- Not measured: gas to open a sale (a fresh auction contract per sale; a reviewer guessed 4 to 5 million) and whether
  a fee sponsor accepts it. Milestone 1 answers this.
- Not verified: that Uniswap V4, its trade router and the v3.0.0 strategy are live on Sepolia. We plan to deploy the
  strategy ourselves; if the router is missing we need a small trade helper of our own, which is new money code.
- Small pools: a 2,500 sale puts about 550 dollars in the pool. Prices will jump and can be pushed around. No pool
  opens below the 2,000 minimum sale.
- Nobody checks that an update is true. The record beside the price is self-reported.
- The floor can be misread as a guarantee. It melts; the page must draw the melting line.
- A backer with only a passkey has no dollars on a real network. Not solved here.
- Founders can bid in their own sale through a second account. The 4-times rule is against the price at the time of each bid, not the floor, so bids
  some blocks apart climb 4x, 16x, 64x, 256x (measured); what limits it is cost, 25 of every 100 spent is gone for good. It limits it, it does not prevent it.
- A lost passkey is lost Shares until the back-up passkey ships.
- Existing Sepolia projects and all three contract generations are abandoned. During testnet, a bug in a project's
  treasury copy means relaunching that project.
- Which real network is undecided; costs depend on it.

## 10. Decisions for the owner

1. **Money split:** of each 100 raised, 3 platform, 22 locked pool, 15 to the project at once, 60 floor paid over 12
   months with a 14-day check-in. Recommended: yes.
2. **Team Shares:** founder 20% released over 12 months; work pot 20% with one-press gifts (held back the same way
   before the pool opens, 1% a month after); reserve 10% only by public sale. Recommended: yes.
3. **Exit right:** kept, 5% fee, floor only, winds down as the money is paid out; no pool hook for it; holders can stop
   payments by a 3-day vote; no change of who runs a project in the first year unless the founder is silent 28 days.
   Recommended: yes.
4. **CREATE:** Creaton becomes project zero, CREATE is its Shares, all fees go to its treasury; court, bonds and faucet
   are deleted. Recommended: yes.
5. **Clean break:** drop current Sepolia projects and contracts; open sign-up; price shown everywhere; the web app is
   only the launchpad; counsel reads the legal lines before they change. Recommended: yes.

## What I verified for this plan

Read in code, nothing run:
1. The vendored strategy's pool step is open to anyone, works once, and swallows a failure (`LBPStrategy.sol:212`,
   `:237`, `:251-252`); it is built with compiler 0.8.26 (`:2`).
2. Opening a sale is refused if the pool already exists, even a plain one (`MigratorParams.sol:142-147`); anyone can
   create a pool (`v4-core/src/PoolManager.sol:117`); the vendored guard hook exists (`InitializerHook.sol`, 56 lines).
3. The auction's only minimum bid is "not zero" (`ContinuousClearingAuction.sol:473`); exit and collection have no
   owner check (`:495`, `:617`); the two sweeps are recipient-only (`:665`, `:689`).
4. The factory is made to be redeployed with another fee controller (`ContinuousClearingAuctionFactory.sol:14-22`).
5. Today's lock, 30-day notice and exit code as cited in section 2, and the reserve-for-a-pool always set to zero
   (`DaoLaunchKit.sol:325`).
6. A passkey account already sends several chain steps as one approved action
   (`web/src/features/identity/lib/sponsoredSender.ts:22-51`).
7. The server rules cited in section 7 and the legal line's location.

## Milestone 1 findings (16 November 2026)

Built in `contracts/next` (a separate Foundry project; the existing contracts are untouched). Report:
`docs/archive/M1-REPORT.md`; facts read from the vendored code and checked on Sepolia:
`docs/archive/M1-FACTS.md`. Everything below was run (96 tests at the last count, on a local copy of the Uniswap code and on a Sepolia
fork against Uniswap's real pool manager, position manager and trade router) unless it says "outside knowledge".

- **Section 8, row 1 is proven.** Sale, then pool, then a trade works, with exact balances at each step, with the dollar
  sorted before and after the Share. Uniswap's UniversalRouter is on Sepolia (`0x3A9D48AB...F98b`) and trades in the pool.
  The v3.0.0 strategy has **no Sepolia deployment and no factory**; we deploy one per network at a mined address.
- **Sections 3 and 4, the 10 percent in the pool, is wrong.** The pool takes 22 of every 100 dollars raised and the
  Shares that match them at the **final** price: 59.7 million Shares (6.0%) in the test sale, at most 8.8% if all sale
  Shares sell at the final price. The unused part of the 100 million reserve returns to the treasury as plain Shares.
- **Section 4, fees, needs 40 lines of new code, not none.** The auction asks its fee controller again at every sweep and
  the vendored controller's owner can set 100%, so redeploying it fixes nothing. `FixedFeeController` has no owner and no
  setters. The 3 percent is paid by the auction itself to the controller's recipient; the 22 percent goes into the pool
  through the strategy's own schedule (one bracket, rate 2,268,041 of 10,000,000); the leftover 75 percent plus unused
  reserve Shares arrive at one address in one transfer, which splits 15 : 60.
- **Section 5, the swallowed failure, is reproduced**, and a second hazard follows from it: after a failed pool step the
  treasury already holds 97 of every 100 dollars, so step 2 of the finish must read the pool (not events) and refuse to
  split 15 : 60 when there is none. Gas-chosen attacks on the pool step did not produce the failure in 85 tries.
- **Section 9, "not measured: gas to open a sale", is now measured: 4,272,797 gas** (auction plus strategy; about 3.6 million of it is storing
  the auction's code); pool step 675,243; a bid 108,614 to 353,207; a trade about 130,000. A passkey-account batch to
  start a project and open a sale is about 5 million gas by my sum. Sponsor limits remain unchecked (outside knowledge
  only).
- **Price limits**: smallest floor price $0.0000000542 per Share (all 1,000,000,000 Shares: $54.21; smallest 400M-Share
  sale $21.68); largest top price about $4.1e22 per Share. The route worked at sale goals from $22 to $1 quadrillion.
  The auction has no maximum-bid rule except that; the 4-times cap is not on chain unless a bid hook adds it (`MinBid` does).
- **Public Sepolia nodes cannot replay an old pinned block** (about 10,000 blocks of history, a few dozen of state), so fork
  tests repeat only from Foundry's local cache or an archive node.

## Milestone 0 fix round (16 November 2026)

A reviewer checked milestone 0 and the code was changed (details in `docs/v3-review/STATUS.md`). Where this plan's numbers
were wrong:

- **Sections 3, 6 and 8, "Join 2 and 0" and "joins in 2 presses", left out the sign-up.** A person with no account on the
  hosted settings does Ask to join, types a name, ticks the age box and the terms, and presses Create: **4 presses and 1 typed
  field**; with no terms on the server 2 and 1; already signed in 1 and 0. The ask is sent by itself after sign-up. The
  founder's Accept stays 1 and 0. These are held by tests.
- **Section 7, item 2, "an ask to join record anyone may sign"**, needed three limits the plan did not name: the ask is at most
  1 KB, its `p` tag must be the founder, and the founder needs a way to turn an ask away (Decline), because a stranger's ask
  costs nothing to make.
- **Section 7, item 1, "extend the first-day posting limit to project records"**, is not enough on its own: the limits are per
  account and accounts are free. Uploads have no byte quota yet, so the hosted example closes uploads to first-day accounts.

## Milestone 1 review fixes and open points (16 November 2026)

A reviewer checked milestone 1; the fixes are in `contracts/next`. Three things the plan must now say:

- **The pool guard is mandatory.** Without a guard hook, a stranger's plain pool at the same price makes the finish think a
  pool exists when it is not the project's pool. The Launcher (milestone 2) must refuse to open a sale with no guard, and
  the finish counts only a pool whose hook is the guard. Today this is enforced only in the test stand-in; no Launcher exists.
- **The licence is not cleared.** The strategy's code includes two BUSL-1.1 files from Uniswap's pool code
  (`Pool.sol`, `Position.sol`; change date 2027-06-15). Section 4's "the licence of the vendored code must be checked first"
  is still open. Counsel must say whether we can deploy a strategy we compiled before that date, or we use a deployment
  built by Uniswap if one is published. Nothing is deployed anywhere.
- **Fork tests repeat only where a cache exists.** The pinned block repeats from Foundry's local cache or an archive
  node; elsewhere the fork tests now skip with a clear message instead of failing, and the local suite (47 tests) is what a
  new machine runs.

Also still open for the owner: what the unused part of the Share reserve becomes after the pool step; what happens to the
money if the pool step fails (the treasury holds 97 of 100 dollars with no pool, and the plan now refuses to split it);
whether to build with 11,111 optimizer runs (Uniswap's setting) or 200 (about 470,000 gas cheaper to open a sale); and
whether the vendored strategy and auction versions are inside the audits Uniswap lists (they list audits only up to the
earlier versions).

## Milestone 2 findings (16 November 2026)

Built in `contracts/next` (`ShareToken`, `Vester`, `Treasury`, `Launcher`, `RollingCap`); 159 new tests, 206 in all, 0 failed. Report:
`docs/archive/M2-REPORT.md`. Where this plan was wrong or loose:

- **Section 4, anti-drain rule 2, is exact only for small holders.** The 4% of an exit that stays "for those who remain" also reaches the
  leaver's own remaining Shares, so exiting in many pieces recovers part of the fee: 20% holder +0.43% in 100 exits, 80% holder +2.4% in 400
  exits (measured); a sole holder in the limit pays about 1% instead of 5%. Buy-and-hand-back needs a smaller discount than 5% for a whale.
- **Section 4, the 15 : 60 split**, is fixed in each Treasury at birth (copied from the Launcher), not given per call: `settle` is open to
  any stranger, so a per-call ratio would let a stranger set how much the founder may spend.
- **Section 4, the floor per Share example (48% on day one)** counts only the 500,000,000 Shares held by buyers. Shares inside the pool (about
  6% in milestone 1's test sale) are held by neither the project nor the Vester, so by the rule as specified they count and lower it. Milestone 3
  needs your call on that.
- **Section 4, "refused until the sale money has arrived"**, is checked as "the Treasury has split money at least once". A stranger can split a
  small part first, so milestone 3 must prove the pool and split the whole amount in one transaction.
- **Section 5, sizes**: the four contracts are 615 lines of code against 1,140 estimated; `ShareToken` is 78 against 40. Project start costs about
  0.73 million gas (three clones and the allocation), a gift about 0.09 million.
- **Section 3, "1% of all Shares per 30 days"** and the agents' daily caps are exact but a used amount counts up to one part longer: 24 to 28
  hours for daily caps, 30 to 33 days for the monthly gift cap.

## Milestone 3 findings (16 November 2026)

Built in `contracts/next` (`Launcher` replaced, `Finisher`, `LiquidityHolder`, `Pinned`, two additions to `Treasury`). Report: `docs/archive/M3-REPORT.md`.
Everything below was run on a local copy of Uniswap and on the real Uniswap contracts on a Sepolia fork unless it says otherwise. Where this
plan was wrong or loose:

- **Section 8, row 3, is proven.** A sale of 20,358.356920 dollars split exactly 3.000 / 22.000 / 15.000 / 60.000 of each 100 (610.75 to the platform,
  4,478.84 into the pool with 59.7 million Shares, 3,053.75 spendable, 12,215.01 floor); every Share and dollar was accounted for at every
  step; the dollar token on either side of the Share in the pool.
- **Section 5, "settle the treasury from the auction's own reported total", cannot be exact.** The pool may take less than its budget (the Shares
  side can limit it), so the Treasury receives what the Finisher holds; the auction's figure is the least that must be there. The "a stranger
  splits a small part first" window of milestone 2 is closed because only the project's Finisher can mark the pool open and the money reaches
  the Treasury only in that same transaction.
- **Section 5, "the app reads the outcome from the strategy's event", is wrong**, as milestone 1 showed: the outcome is `Finisher.poolIsOpen()`, read
  from the pool manager.
- **Section 4, "buy and hand back pays when the price is more than about 5% under the floor"**: measured, it stops paying a little above 6% under
  for a 20-dollar trade (7.6% in the steps I tried), and does not pay at all for 200 dollars or more in a 2,200-dollar pool, because the pool's 1% fee
  and the price the trade moves come on top of the 5% exit fee.
- **Section 4, the floor per Share example (48%)**, counting the pool's Shares as the rule says: 49.2% of the opening price for a sale at its goal,
  35.4% when demand lifted the price 3x. Leaving the pool's Shares out would give 60.0% and 40.7%.
- **Sections 3 and 9, thin pools:** a 100-dollar buy moves a Small pool (880 dollars) up 23.7% and a 2,500-dollar buy multiplies its price by 14.5;
  at the Standard size 9.2% and 4.5x. A founder's second account can pull the price to the 4-times limit in one block and leave the other bidders 9% of the Shares
  their money would have bought, at a cost of 25% of the extra spend. (The fix round below corrects this: over several blocks the price can go far past 4x.)
- **Section 5, "Launcher: opens the sale", needs a Finisher per project** (one clone each): the strategy returns the money left after the pool to one
  address, and any stranger may run the pool step directly, so only a per-project address can tell whose money it is.
- **A way out of a pool that never opens was missing.** Seven days (50,400 blocks) after the sale, anyone may abandon: of each 100 raised 3 to the platform,
  15 spendable, 82 into the floor; all Shares back to the Treasury; the founder's Shares start releasing.
- **Not in the plan, and easy to forget:** the Treasury's only sale path is the Launcher and this Launcher has no function that takes reserve Shares, so the
  reserve (10% plus the unsold and unused pool Shares) cannot leave. Later sales (milestone 8) need a function in a Launcher deployed before any real
  project, or a new Launcher and new projects.
- **Gas, measured:** open a sale 4,380,084; start a project and open its sale as one batched call 5,262,795; the three finish steps 766,203, 271,524 and 67,081;
  collect pool fees 262,173; abandon 306,784 (724,725 when it runs the failing pool step itself); deploy the Launcher 7,503,861. The strategy and pool guard are
  found in about 14,000 to 24,000 tries on average (15 and 5 milliseconds with `cast create2`).

## Milestone 3 fix round (17 November 2026)

A reviewer and an attacker-tester went through milestone 3. Nothing in sections 3 and 4 (the split, the fee, the exit rule, the gift rules) was
changed. Where this plan was wrong or loose, and what was done:

- **Section 5, the bid rules, were wrong about the 4-times cap.** The rule is "a top price of at most 4 times the clearing price at the time of that bid",
  not 4 times the floor. Bids placed some blocks apart can each name 4 times the price the one before set: a ladder of four bids 20 blocks apart took a
  Standard sale to 4x, 16x, 64x and 256x the floor (2.5 million dollars spent by the second account, 25 of every 100 of it gone for good). The defence
  is cost, not the rule. The report and the Launcher say so now. Making the cap absolute (4 times the floor) is an owner decision: it would also limit
  honest late bidders when demand is real.
- **A new rule: no bids in the last 720 blocks of a sale** (a tenth of it, 2.4 hours at 12 seconds; `MinBid`, checked by the Launcher's constructor).
  Reason: the pool opens at the price the sale ends at, and a bid in the last blocks can only buy the last blocks' supply, so a few dollars lifted the
  final price to the 4-times limit (5.66 dollars for 4x on a 10,000-dollar sale, 493 for 256x), which shrank the pool's Shares and let a holder of cheap Shares
  take 64% to 99% of the pool's dollars: other bidders' money, and a founder's second account gained 1,909 dollars (21% of the honest raise) that way. With the
  window, the last bid that counts is 720 blocks before the end and must pay the lifted price on every block after it: the same attack placed at the edge
  cost more than all the dollars in the pool at every size (1 bid: 1,139 to 14,233 dollars lost on Small to Large, 4 bids: 82,473 to 1,030,916 lost). The cost
  to honest bidders: they cannot bid or raise a bid in the last 2.4 hours; a sale just under its minimum when the window opens cannot be topped up.
- **Section 5, "a pool exists", was not enough.** "Liquidity at the guarded key" is also true of a pool someone else makes there through the strategy after a
  failed pool step (any holder of the project's Shares can). The Finisher now also asks that the pool step took this sale's money: at least half of the pool's
  dollar budget is missing from what the strategy returned (a failed step returns all of it). After step 2 the answer stays true, so a gift cannot reopen
  the way out. Limit, measured: dollars sent to the Finisher before step 2 hide a real pool if they are more than half the pool's budget (11 of each 100
  raised); the sender loses them to the project, and exits still open after seven days.
- **Section 5, abandon, does not cover everything.** It covers a pool step that never ran and one that failed and was swallowed. It does not cover a
  dollar token that freezes the fee recipient (the 3%): the auction pays that fee only through the strategy, so the pool step reverts (it is not swallowed),
  and `abandon` and `openPool` revert with it, for every project at once. Treat a freezable dollar token, and a freezable fee recipient address, as a single point of failure for the platform
  when the token is chosen.
- **Events are the contract with the server (milestone 4), so every one is now asserted with its figures**; `Finisher.PoolOpened` (pool id, price, dollars, Shares) is new. `PoolStep` may be
  missing (a stranger can run the strategy's `migrate` directly), `PoolOpened` and `Settled` come from step 2 always. After an abandon the Treasury's first `Settled` is the
  floor-only part, followed by the ordinary one.
- **Still open for the owner:** the sealed reserve (no function takes reserve Shares out of this Launcher), the closing window's length and whether the cap should be absolute, the dollar token, B3.

