# Creaton: direction review

Status: a memo for the owner, not a plan and not built. Written 18 November 2026 on branch `v6` (against commit
534260406), outside research ran 18 to 19 November 2026, and it was revised on 19 November after an independent
review of its sources and of its claims about this repo. Repo facts are as of 19 November; other engineers were
committing while it was revised (HEAD was e74a65219 at the last look). It answers one question: can this become the
biggest launchpad for real projects, with the speed of pump.fun and the anti-rug protection of MetaDAO, and what
should change before more is built. Nothing here is legal or tax advice; legal points are questions for counsel
(section 9).

How to read the numbers. **(measured)** = a test, count or constant in this repo, file named; milestone-report
figures were not re-run for this memo, and "read today" means the constant was re-read in the source. **(reported)** =
from an outside source, key in square brackets, URL and date in section 10; "summary only" means the page refused to
load and the figure comes from a search summary. **(simulated)** = the plan's Python models. **(judgement)** = my
choice or my arithmetic; change it freely. **(estimate)** = a guess at size or time.

## 1. The answer in five lines

1. **Not as planned.** No rebuild is needed, but the goal, the build order and the design of milestone 9 are wrong.
2. Pump.fun is fast because of what it leaves out: no wait before trading, no money held for anyone, no lock, no
   identity. Those four absences are the protection. The two halves of the question cannot be added together.
3. MetaDAO has tried an open door beside its curated one. As of 18 September 2026 the curated door kept 45.4M dollars
   of 624.7M offered and the open door 568,000 of 44.0M (reported, [M1]). Distribution and vetting both differed
   between the doors, so this does not prove vetting alone did it. About 10 November 2026 MetaDAO's Backable moved
   from "permissionless" to "open, with some moderation" (reported, [M4] summary and Rootdata; exact date unverified,
   single outlet).
4. What Creaton can honestly be: the fastest **protected** place for small real projects. "Open a round in two
   minutes. Take your unpaid money back any day, with no vote." Biggest there means dozens to a few hundred funded
   projects a year, not a million coins a month (judgement). Nothing yet says why a backer would put real money into
   a small project's Shares after week 26 (gap 7); that is the fatal unknown, and the play-dollar test cannot answer it.
5. Change now: the promise; the order (a small closed founder cohort first, then the launch pack and demo day, both
   before the Council); and milestone 9 (rules that protect a holder who does nothing, in place of votes, with
   real-money auctions kept off until a simulation passes). The earlier idea of holding the 15 for 14 days is **not**
   recommended as written: it makes fake demand about five times cheaper (section 6, C2).

## 2. What pump.fun's speed really is

Launch on pump.fun is one form and one signature; the coin trades when that transaction confirms, "in under a
minute". Creating a coin is free apart from the Solana network fee, about 0.001 dollars per trade (reported, [P1];
older guides citing about 0.02 SOL are outdated). The speed is five things. Only the first survives protection.

| Part of the speed | What it does on pump.fun | Can a real-project launchpad have it? | Creaton |
|---|---|---|---|
| One form, one press, no review | anyone launches in a minute (reported, [P1]) | **Yes** | Start: 2 presses, 3 fields, for a signed-in reader (measured, `smoke.spec.ts`, "Start: three answers..."); hosted sign-up and join add 4 presses, 1 field (measured, `press-counter.ts` JOIN_PATH_HOSTED_BUDGET); Open backing 1 press (measured, [R3]) |
| Trading in the creating transaction | creator and bots buy first; of 18,202 graduations in 1 to 28 August 2026, 49.9% happened in the minute of creation and 72.0% within five (reported, [P2]) | **No.** Equal entry needs a window | 24-hour round, same percent for all (measured, `Rounds.sol` WINDOW, read today) |
| No money raised for the creator | nothing to hold, release or refund | **No.** Funding work needs custody and a release over time | 3 / 15 / 82 over 182 days (measured, `Rounds.sol`, read today) |
| Free, anonymous, repeatable | wallets with 100 or more launches each (1,170 of 223,339 deployer wallets) made 414,244 of 1,032,440 launches, 40.1%, in 1 to 28 August 2026 (reported, [P2]) | **No**, not without a visible history | no limit per person found (measured, grep of plan and `Launcher.sol` by the repo review) |
| A moving price and instant exit | the fun; also where 49% to 50.6% of about 1.4M trading wallets ended March 2026 in losses and about 96% lost or earned under 500 dollars (reported, [P6]; an anonymous analyst's Dune dashboard) | **No** below a real market | fixed price; no market under a 100,000 auction (measured, `Launcher.sol` line 180, read today) |

What this means:

- **Time to an open round: the page matches it; the whole path was never timed.** Start is 2 presses signed in and
  Open backing is 1 press (measured, [R3]). The seconds PressCounter prints are estimates from assumed reading, typing
  and press speeds, not stopwatch times (judgement: "minutes"). A stranger also needs a browser wallet, test gas, a
  launch and then Open backing; the app flow for launch existed only in an unpushed milestone 7 commit (6c18b1ceb)
  when read, and no one has timed the path (measured, [R3] open item 1).
- **Time to a tradable price: we never will.** About one day at the very best, and only with a second signer and
  100,000 dollars of bids; never for most projects (judgement, from the constants in section 4).
- **The count is the wrong yardstick.** Pump.fun's roughly 37,500 launches a day (reported, [P2]) are mostly machine
  output (judgement; the source does not say so), and 1.8% graduate (reported, [P2]). A vendor report found 98.6% of
  about 7 million tokens (January 2024 to March 2025, tokens with at least five trades) fell below 1,000 dollars of
  liquidity, which it labels pump-and-dump or rug pull; pump.fun's spokesperson contested it (reported, [P5], [P5b]).
  Liquidity under a threshold does not show intent.
- **The fast end is shrinking, though not to zero.** Revenue (as The Block labels it; check) fell from 4.8M dollars a
  day around December 2025 to 0.8M a day in part of June 2026, about 83% (reported, [P3]). Search summaries (not read
  in full) say weekly revenue was still 15.16M dollars in September 2026, about 2.2M a day (judgement, arithmetic):
  recovered from the low, still under half the earlier peak. Pump.fun has since added USDC pairs (21 May 2026,
  reported, [P11]) and perps, run through Hyperliquid (October 2026, reported, [P10], summary only; one report says
  US users are blocked). No official pump.fun source was found.
- **Real projects on fast rails went badly where found, on different measures.** The $BELIEVE token is down about
  99.8% from its high (reported, SolanaFloor, [P8]); a class action was filed in March 2026 (Lee v. Pasternak,
  S.D.N.Y., [P8b]), allegations unproven. Zora's protocol revenue fell about 98% from Q3 2025 (5.64M dollars) to Q2
  2026 (106,540), a revenue measure not a price (reported, DefiLlama via [P9]). Bags fees were reported down about
  65%, undated and unverified ([F8]). Base's lead said in July 2026 that Base's experiments with Farcaster, Zora,
  miniapps and creator coins "disintegrated completely", one executive's post, not a product statement (reported,
  [F7]; the page's own summary line contradicts its body).

## 3. What MetaDAO's protection really is, against ours

MetaDAO's curated door: an intake form and a reply from a MetaDAO co-founder, a legal entity created at launch, and a
4-day sale (reported, [M5] [M7]). Sales are weighted by amount and time, founders choose how much to accept, and
soft commits can get guaranteed places. A week of public build-up was not found in the docs and is not claimed. About
1.4 sales a month and about 32M dollars a year (judgement: 23 sales and 45.4M dollars from [M1], over about 17 months
from an April 2025 first sale, which is the start date I assumed). "Same code on both doors" is what [M1] says
("same contracts and the same fees"); the refund rules differ by door as I read them, and I did not check how the
624.7M and 45.4M split between doors. The last column asks one thing: who protects a backer who never votes, never
trades a decision and never proposes anything?

| Mechanism | MetaDAO (reported, [M5] [M6] unless marked) | Creaton (measured, file named) | Stronger for the backer who never votes |
|---|---|---|---|
| Raise misses its minimum | all money refunded by code; Hurupay raised 2,003,593 against a 3M minimum (ICO opened 3 February 2026, failure reported 9 February) and all funds were returned ([M10]) | auction under its minimum refunds everyone; a backing round has no minimum to miss (`Launcher.sol`) | Equal |
| Too much money offered | founder chooses how much to accept; share weighted by amount and time; funds may get guaranteed places | everyone gets the same percent ([R2]). Weakness: one fake ask of 94,000 burned a 10,000 cap for 2,077.40 ([R2]) | Creaton, slightly |
| Money after the raise, if nobody acts | stays in the treasury; team draws a monthly budget of at most one sixth of the minimum raise | 15 at once; 82 over 26 weeks while a person checks in every 14 days; stops by itself after 14 silent days ([R2], `Treasury.sol`) | **MetaDAO** above the minimum; Creaton for an abandoned project |
| Getting money back from a bad project | a holder stakes 1% to 15% of sale supply (200,000 to 1.5M of 10M tokens) to propose; the stake is spam prevention only, with no lockup and no slashing, and one proposal is live at a time; the market runs about 3 days (per [M9], not the docs) and a proposal must pass by 3%, while a team-sponsored proposal passes at -3% ([M6] twaps); then everyone is paid. Ranger returned about 5.05M USDC, about 0.78 a token ([M1]); the sale price was not found, so no recovery percentage is claimed; staff and vendors went unpaid ([M9]) | personal refund, 2 presses, no one else needed: 77.90 per 100 on day 0, 38.95 at week 13, 0 at week 26 ([R2]) | **Creaton** if the backer watches. **MetaDAO** if a crowd exists and the backer sleeps. Neither if both fail |
| Does a crowd exist? | median about 12 traders a decision; one passed with 2; 23 of 51 tokens ever traded a decision ([M1]) | not needed before a market | **Creaton** for a 20-backer project |
| Exit after a market opens | liquidation draws on treasury and liquidity | hand-back pays 46.7% of the sale price on day one (49.2% floor less 5%, [R2]); about 27% at day 90, 15% at day 182, 0 at day 365 (judgement, arithmetic on built constants); the pool's 22 can never come back ([R1]) | **MetaDAO**, by more than half |
| Team's own Shares | optional; 5 tranches at 2x, 4x, 8x, 16x, 32x the sale price, earliest unlock 18 months, plus a 3-month TWAP | mandatory hold, but time only: 365 days from the market, no cliff (`Vester.sol`, read today); released founder Shares can be handed back against the buyers' floor (`Treasury.sol` handBack, read today) | Creaton before a market; **MetaDAO** after |
| New Shares | new token issuance needs a passed proposal ([M5]); that the mint moves to the treasury was not confirmed | fixed 1,000,000,000; nobody can mint ([R2]) | **Creaton** |
| Liquidity | 20% of the money plus 2.9M tokens, owned by the treasury | 22 of each 100 in a pool nobody can withdraw ([R1]) | Creaton against a pulled market; MetaDAO for recovery |
| Stopping a bad runner | decision market. Umbra's UMBRA-004 (31 July 2026) sought about 1.57M USDC, the whole treasury, and failed with PASS 17% below FAIL; about 358,000 traded across 237 swaps, number of traders not reported; the attacker's own sells briefly drove FAIL to 0.26, so the market was briefly manipulable, and the reversal came from 67 trades in eight minutes after an 86,000 PASS sale ([M8]); thin elsewhere | not built. Planned "park a third" needs about 39% of non-founder free Shares at day 90 (judgement, arithmetic) | **MetaDAO**, weakly |
| Vetting and honest claims | the MetaDAO team picks; it did not catch Ranger's alleged misstatement ([M9]) | none; stage names prove no vetting ([R1]) | **MetaDAO**. This is where the money went |
| Legal entity and IP | per-project entity created at launch; holders may sue or compel registrars; no court test found ([M7]) | none | MetaDAO on paper; question for counsel |

Reading the table: before a market, at 5,000 to 50,000 dollars, Creaton protects a watching backer better than
MetaDAO, because nobody else has to show up. After a market Creaton is clearly weaker, and the planned fix depends on
the turnout MetaDAO's own record says will not come. MetaDAO's edge is not its mechanism. It is the vetting, and its
audience.

## 4. Where we are today

**Speed.** Presses are (measured, [R3] and the unpushed milestone 7 tests); wallet confirmations are not counted;
seconds are PressCounter estimates.

| Step | Presses, fields | Wait | Gate |
|---|---|---|---|
| Start a project (signed in) | 2 presses, 3 fields | none | none. Hosted sign-up and join: 4 presses, 1 field (`press-counter.ts`) |
| Put it on the network | 1 press + 1 confirmation | one block | browser wallet; test-network gas; 1,386,281 gas ([R2]) |
| Open backing | 1 press, 0 fields | 24 hours to close | lowest price only in the app (`OpenBacking.tsx` line 17) |
| Back a project | 2 presses, 1 field + 2 confirmations | up to 24 hours | browser wallet; **a phone without a wallet browser cannot back, refund or check in**, and the passkey path is not in the new app (`wallet.ts` header, read today; [R3] open item 2) |
| Money to the founder | none | 15 at once, 82 over 182 days | check-in every 14 days |
| Above 10,000 in total | 2 presses each side | none | a second signer; cap 50,000 (`Launcher.sol` lines 175-177, read today) |
| A market | Bid 2 presses, 1 field | 7,200 blocks: 24 hours at 12-second blocks, 4 hours at 2 seconds (measured `Pinned.sol`; hours are judgement) | 100,000 of bids; a Council on every chain but Sepolia and local, and no Council exists (`Launcher.sol` lines 431, 611, read today) |
| Backer's Shares can move | none | 365 days of release from the market; with no market, 365 days to declare it plus 365 of release | a market, or a "no market" declaration |

Blunt reading (judgement): the page is pump.fun-fast. Everything involving money is slow, by design, and for a
stranger today it is slower than designed: a browser wallet, test gas, two confirmations, nothing to share from
inside the app, nothing that calls them back.

**Protection, by who enforces it.**

- **By contract, tested** (measured: 585 local tests passed and 35 fork twins skipped, with the Launcher at 21,788
  bytes and 2,788 left, [R5]; the Sepolia fork suite last passed 136 tests, [R2], a run that predates the
  earlier-backers Launcher and Vester changes and was not re-run; contracts are unchanged since c54e3f6e9 of 18
  November): fixed supply; the caps; the 3 / 15 / 82 split and the personal refund; the 365-day hold on every
  pre-market Share; auction refund under the minimum; the 4-times bid cap; the sealed pool; the floor hand-back; 500 a
  week per signer; agent daily caps; payments stopping after 14 silent days.
- **By server** (measured, [R4]): the relay-signed project numbers; the helper's allow-list, which can never refund,
  check in or take out a backer's Shares.
- **By promise, or not built:** what a check-in contains (a junk update keeps money flowing, [R1]); notices to
  backers ([R4]); pause, elections, Council, replace vote (no such contracts in `contracts/next/src`, listed today);
  the 28-day takeover; task money set aside; Creaton never handing its stake back.
- **Measured weaknesses the reports admit** ([R2]): a founder bidding 50,000 or 100,000 in their own auction beside
  100,000 honest ends 14.59 or 5.46 of each 100 ahead if holders stay passive. 350M held Shares release into a pool
  of 55M; selling 30 days of release drops price 58% for a default project (simulated, [R8]; 57.8% for project zero
  with 364.55M held Shares, `EARLIER-BACKERS.md` row D).

## 5. The gaps that change direction, most serious first

1. **The goal steers toward a product that cannot exist.** Evidence: section 2. No source shows speed plus
   protection working at scale. Aiming at "biggest" and "fastest" pulls the build toward trading, charts and counts.
   The fast-rail examples found did badly on different measures: Believe's token down about 99.8% from its high,
   Zora's protocol revenue down about 98% over four quarters, Bags fees reported down about 65% (undated,
   unverified); see section 2 for sources. Pump.fun itself still reported large revenue in September 2026 (summary
   only), so "the fast end is dead" is not claimed.
2. **There is no answer to "why would anyone trust an unvetted project".** As of 18 September 2026 ([M1]): 22 of 23
   vetted MetaDAO sales completed and kept 45.4M of 624.7M offered; about 90 open sales ran and 9 cleared (the
   chart caption says 83 settled and 74 refunded), keeping 568,000 of 44.0M. Six weeks later, as of 6 October,
   [M2] counts twelve successful open-door raises totalling about 728,000 dollars and 44.2M of commitments from 2,407
   backers. On 9 November an Apps Program raise (curated, 1609SAT) closed with 7.9M committed from 227 backers
   against a 100,000 cap, scaled down proportionally with the rest refunded (reported, [M4b], summary only; use
   "committed", not "drew"). Good projects are scarce, not buyers: 13.8 dollars offered per dollar accepted at the
   vetted door, about 14.5 across both doors (judgement, arithmetic on [M1]). The curated door also had its own
   audience, so a shelf may not copy its result without distribution. Creaton's Home has no shelf and no ranking,
   and demo day is the last milestone (measured, grep by the repo review).
3. **After a market, protection needs a crowd, and milestone 9 builds exactly that.** Park-a-third needs about 39%
   of non-founder free Shares at day 90, more than half if the founder bought a third of the auction (judgement,
   arithmetic). The Council is elected by free Shares, the very Shares a self-bidding founder holds (measured, [R2]).
   MetaDAO, with real money and a known name, gets a median of 12 traders (reported, [M1]). Three weeks would buy
   governance that looks like protection and is not.
4. **Real time to first money is not fast, and a phone without a wallet browser cannot back.** The passkey account
   with sponsored gas, reported as about 2,700 lines in the milestone 6 report (the six files it names count 2,469
   lines, measured), is still in the old app ([R7]). No play-dollar token or faucet exists; the only token is a test
   mock, `contracts/next/test/mocks/QuoteToken.sol`, which has an open mint and switches that block addresses,
   charge fees or hook transfers, so it cannot be used on a public test (measured). The deploy script has never been
   broadcast; it has only been simulated against a Sepolia fork and run on a local anvil (measured, its header and
   `app/tests/anvil/deploy.ts`).
5. **The refund expires in silence.** It falls to 38.95 at week 13 and 0 at week 26 (measured, [R2]) while the
   founder only has to touch check-in. The server sends no email or push and notices are not built (measured, [R4]).
   The one protection that beats MetaDAO only works if the backer is told.
6. **The 15 paid at once is a small, repeatable rug, but a bigger hole sits beside it.** If every backer refunds in
   the first minute the project still keeps 18.28 of each 100 (15 plus 4% of the 82; judgement, arithmetic on
   `Rounds.sol` constants read today): 1,828 dollars at the Solo cap, only in that all-refund case. A founder who
   posts a junk check-in every 14 days collects the whole 82 over 26 weeks, which is the larger leak ([R1] section 10
   admits a junk update keeps money flowing). Pump.fun's co-founder wrote on X that creator fees "may have skewed
   incentives toward low-risk coin creation instead of high-risk trading" (reported, [P4]; a hedge, not an
   admission). A 14-day hold on the 15 targets the smaller leak and costs more than it saves (C2).
7. **Below the auction, a backer ends up holding something with no use, and nothing says why they would pay.** After
   week 26 there is no refund, no vote, no market and no claim; Shares stay held for at least a year, likely two
   (measured, [R1] section 3). Most real small projects will live here for good. The app does not say so at Back.
   Pump.fun offers a moving price and MetaDAO a liquid token with treasury claims; the only backer-side upside this
   memo has is perks, deferred to counsel. "Dozens to a few hundred funded projects a year" is judgement, and the
   bear-year model it leans on assumes 200 funded rounds. Real-money backer demand for these Shares is the unknown
   most worth testing, and a play-dollar test with free grants cannot show it.
8. **It is not yet a business.** Bear year: 27,830 dollars of income, about 14,000 spendable, no wage (simulated,
   [R1]). That bear year assumes 200 funded rounds; the nearest rival funded twelve in about seven months (judgement,
   from 3 March to 5 October 2026, [M2] with [M3]; [M2] gives twelve raises of about 728,000 dollars in total and no
   time span). A team of four needs 25 to 30M raised a year (simulated), close to MetaDAO's whole vetted door, about
   32M a year (judgement, see section 3). MetaDAO's gross protocol revenue fell from 1.82M in Q4 2025 to 556,000 in
   Q1 2026 and 376,500 in Q2 2026 (reported, [M1]); a DefiLlama summary gives about 112,000 for Q3 2026 but its
   monthly pages imply more, so that figure is unreconciled (reported, [M11], summary only).
9. **The large-raise tier is where we are weakest.** Uniswap's web app has offered a guided auction-launch flow since
   24 June 2026 on Ethereum, Base, Arbitrum and Unichain, with more chains "coming soon" (reported, [F3a]; fees not
   stated; press calls it no-code). Its example is Aztec's November 2025 sale: about 17,000 bidders in 191 countries,
   96% under 10,000 dollars, mean about 4,000 (reported, [F3]). Coinbase and Kraken own distribution (reported, [F5]
   [F6], summary only). Public sales in Q2 2026 were about 85% below Q1 in CryptoRank's early-June snapshot (58M
   dollars, 37 sales against 105), later revised to about 40M across 47 sales (reported, [F2]). Nothing between
   50,000 and 100,000 can be raised (measured, [R1]).
10. **A refund that stays open after trading starts can become a run.** A rival launchpad's research reports
    founders privately disclosing that 60% to 95% of announced capital was refunded (about 80% typical; 20 or more
    founders, no published dataset), and that 11 of 16 verifiable sales traded below sale price during the refund
    window, which the article says measures refund incentive, not refunded volume (reported, [F1]). The authors'
    sister product is a non-refundable launchpad. The plan keeps the refund for held Shares after a market opens
    ([R1] section 4). Not simulated.
11. **The network and the legal route are both undecided,** and both gate real money (sections 8 and 9).

## 6. Recommended course

**One course: keep the product, change the promise, launch the strong half first, and make protection work for the
backer who does nothing.** Short name: *backed in public*. Milestones 7 to 10 stay in the plan, as the owner decided,
but this memo moves and defers parts of them; section 7 lists exactly which, and names the owner decisions that
overrides.

**KEEP (already right)**

- **The backing round with a personal refund.** It is the one protection that beats MetaDAO for small projects, it
  is built, and it needs no crowd. Build the promise around it.
- **One-press Open backing and the 24-hour round.** This is the honest "pump.fun speed". Make the window louder
  (countdown, asked against size); do not shorten it.
- **The 365-day hold on pre-market Shares.** Without it a self-filling founder takes about 45% of honest auction
  money (simulated by the attacker on a 50,000 auction, not re-run at the plan's size, [R1]). The milestone 4 re-run
  measured a different attack, the founder bidding in their own sale (45.41 lost at once, 14.59 gained if holders stay
  passive), not the self-filled-rounds case.
- **The caps as the brake, the open door at the bottom, and Home never sorted by money.**
- **No trading below a real auction, no trading at creation, no pay to founders on trade volume.**
- **Work and money in one place:** weekly updates, tasks paid to strangers on accept, agents under caps. No rival
  found combines them (judgement). "Paid for a task today" is the nearest thing to an instant reward.
- **Payments that stop by themselves, a runner who can never spend the floor, fixed supply.**
- **Rule-based exits, not decision markets.** The repo already chose this; MetaDAO's record supports it.
- **Test network first, with play dollars,** as the owner decided.
- **Measuring attacks and writing down what failed.** Keep those admissions in the app's words too.

**CHANGE NOW**

| # | Change | Cost (estimate) | What it breaks in built code and tests | Lands in |
|---|---|---|---|---|
| C0 | **Step 0: a closed founder cohort before anything else is built.** Deploy for real on Sepolia, add the play-dollar token and faucet (C3 part 1), hand-pick 10 to 20 founders on desktop wallets, run 2 to 4 weeks, and measure week-2 and week-4 posting before committing to the phone path (C3 part 2), share (C5) and the shelf (C6) | 1 to 2 weeks of builder time to open it, then 2 to 4 weeks of running while C4 is built | nothing built; it delays C3 part 2, C5 and C6 until founders are shown to come | now |
| C1 | **New promise and yardstick.** Drop "speed of pump.fun" and "biggest launchpad". Say: "Open a round in two minutes. Backers can take unpaid money back any day." Steer by three numbers: funded projects still posting at week 26; share of backer money refunded; time from Start to an open round | days; no contract | nothing built: neither slogan appears in the repo. `docs/PLAN-V2.md` section 1 reads "A community-run accelerator for solo AI builders" and Home's welcome (`HomePage.tsx` lines 100-110) reads "Real projects, built in the open... shows whether it kept its word". C1 is new wording for both, checked by `check:copy` | now |
| C2 | **Decide the 15 and the cap together, after a simulation. Do not ship "hold the 15 for 14 days" alone.** The idea: the 15 pays at the first check-in on or after day 14, and a refund inside those 14 days carries only the platform's 1. Day-0 refund would rise from 77.90 to about 96 per 100 (judgement, arithmetic). Its effects are below | simulation 1 to 2 days; if shipped, about 1 to 2 weeks (a lower bound of 5 days was the first guess; the list below shows why it is higher) (estimate) | see below | before real money; **not in the launch pack** |
| C3 | **Play dollars first, then the phone.** Part 1 (C0): a new play-dollar token (mint only by a faucet with a per-account and per-device limit, no blocklist or fee switches) and the faucet. Part 2: move the passkey account with sponsored gas into the new app, and send approve and ask as one confirmation. New test budget: nothing to "backed a project" in under 2 minutes on a phone, confirmations counted | part 1 about 1 week; part 2 2 to 3 weeks (estimate) | `app/src/features/money/wallet.ts` sender; press budgets that exclude confirmations; "sponsored fees off until a global cap" in [R1] section 10 (decide for the test network); the helper's allow-list grows by one call. A grant at every sign-up is farmable | part 1 in C0; part 2 in the launch pack |
| C4 | **Tell the backer.** Notices: no update for 10 days; "your refund is X today and falls Y this week"; many backers left this week. In-app first, then email or push. Put the same facts beside the refund button with the work evidence. This is the protection for the junk-update leak, so it is the first thing to build | 1 to 2 weeks, server and app | one more field or prompt at sign-up against the join budget; honest founders will see refunds triggered by reminders | built during C0 |
| C5 | **Something to share and something to watch.** Share on a project and on an open round; an "opens on (date)" record; round card shows a countdown; "kept its word N weeks running"; a "closing today" list | 1 to 2 weeks | the share card rule "no price, no returns, no counts" in `share_preview.rs` if a count is added. Today the Back box already shows "X dollars asked so far by N backers, of Y this round holds" from the first minute (`BackBox.tsx` lines 100-103, testid `back-asked`) and already computes the scale-back (lines 62-63, 175-179), contrary to the plan's rule in section 4 that the amount asked shows after 12 hours (a judgement row). Decide: hide asks until hour 12 (a change to `BackBox` and its tests) or drop that plan rule. "Times over-asked" is partly built | after the cohort shows founders come |
| C6 | **A picked front shelf, and demo day before the Council.** Keep the open door. Add a shelf ranked by evidence the app holds: weeks shipped, tasks paid, refund rate, with self-paid tasks and same-device backers excluded. Move seasons, demo day and "Creaton backs its picks" ahead of milestone 9 | 2 to 3 weeks (plan's own figure for milestone 10), moved earlier | the order in [R1] section 9; nothing built. The owner's picks become a visible endorsement (question for counsel). Every signal is forgeable at near-zero cost unless excluded (section 8). The shelf also needs a named first-500-backers plan (section 8) | milestone 10, now before 9, after the cohort |
| C7 | **Redesign milestone 9 as refund-first** (below), simulation first | 1 week of design and simulation, then 3 to 5 weeks, more than the 3 already planned because of the new Launcher and Treasury entry points (estimate) | owner decisions 4 (park a third) and 6 (Council before an auction); the whole 18 November progressive-decentralization requirement (section 7); the Vester's "no cliff"; `Launcher.sol` lines 431 and 611 and their tests | milestone 9, last |
| C8 | **Say what the backer holds.** On the Back box: "After week 26 you hold Shares that only gain a use if this project opens a market. They may not be sellable for up to two years." Show each founder key's earlier projects and their refund rate | days | the Back screen word budget; a new server-signed number per founder key. One key only; accounts are free, and the page should say so | launch pack |
| C9 | **Decide what a backer gets below the auction, before the promise "backed in public" is made with real money.** Options: perks or milestone-gated releases, a small guaranteed hand-back or exit for unsold Shares, an early small market. The first real evidence would be a counsel-cleared real-money micro-pledge, for example 20 backers at a few dollars. C8's warning is the minimum, not the answer | about 1 week of design after counsel's first answers (estimate) | nothing built; touches the 365-day hold and the refund design | before real money |

**What C2 (hold the 15 for 14 days) does, so the owner can see why it is held back**

- **It makes fake demand about five times cheaper.** Refunds never lower `raised` (`Rounds.sol` comment), so one fake
  ask burns a cap for good. Today that costs the faker 22.1 per 100 accepted: 3 + 15 + 5% of 82, measured as 2,077.40
  on a 10,000 cap (`RoundsWorked.t.sol` line 163, `AttackPlanV2M4.t.sol` line 131,
  `test_attack_fakeDemandForcesAScaleBack_measured`). Inside 14 days it would be about 3 + 1% of 97, roughly 4 per 100
  (judgement, arithmetic): about 370 dollars on the 9,400 the faker had accepted.
- **It creates a refund cliff.** About 96 per 100 at day 0 and about 90 at day 13 drop to about 72 once the first
  check-in on or after day 14 pays the 15, 18 or more points at a moment the founder chooses (judgement, arithmetic).
  That makes gap 5 worse.
- **It does not stop the junk check-in.** A junk update on day 14 releases the same 15. It also does not delay the
  weekly release: the held 82 releases evenly from close (`Rounds.sol`: held times elapsed over 182 days, about 0.45
  per 100 a day), so an honest founder who checks in waits 14 days only for the 15, and is paid about 6.3 of the 82
  per 100 by day 14.
- **It breaks a long list.** Rust tests `numbers_tests.rs`, `postgres_tests.rs`, `review_postgres_tests.rs`; the
  app's duplicate of the split in `calls.ts` lines 141-160 (the 15n/100 and 8,200 constants); `BackBox.tsx` line 248;
  `numbers.test.ts`; `money-screens.test.tsx`; the strings asserted in `money.spec.ts` ("3.75 to the project now, and
  20.50 released", "At most 19.47 of your 25"); 23 contract test files that reference Rounds; owner decisions 2 and 4
  in [R1]; `test_refund_thePlansNumbers`; the anvil loop's pinned refund values; plan section 4 examples. The server
  decodes `Rounds.Settled.toProject` (`events.rs`), so the event or its meaning changes, and Rounds needs a new way to
  learn the first check-in from the Treasury. The "21-word budget" is printed by PressCounter and recorded in the
  milestone 6 report; nothing asserts it.
- **What to decide with it.** Whether refunded money reopens a cap once (which makes the burn attack pointless
  whatever it costs); a fixed first-round limit for a brand-new founder key; a check-in that must carry something
  checkable; a backer-triggered pause for the 82 (C4's notices are its first half). Simulate the cap-burn cost with
  each, then decide. On a play-dollar network none of this costs money, so the test launch can ship today's numbers
  and learn from them.

**C7 in detail: milestone 9, refund-first.** Not decision markets, and not the plan as written.

- **Pause by exits, not by parking.** When Shares handed back in a trailing 30 days pass a set part of the Shares in
  people's hands (start the review at 10%, judgement), the release pauses by itself and the hand-back fee drops to
  the platform's 1. If exits continue through the pause, the project winds down by itself with the floor frozen for
  holders. Nobody votes. A holder who does nothing is protected by those who leave. This needs new entry points:
  after a market `Launcher.windDown` is Council-only (line 661) and `openReserveSale` is Council-only (line 677);
  `Treasury.markWoundDown` and `setPauser` are callable only by the Launcher or the council maker, and nothing but a
  registered Council passes the Launcher's Council checks. The pause hook itself exists (`Treasury.setPaused` and the
  pauser, built in milestone 4) and can be reused.
- **What bounds a runner after a market today.** There is no "default budget" in `contracts/next/src`: the only
  budgets are project zero's team budget and the agents' daily caps. The Council's budget (6% per 30 days) is plan
  text for an unbuilt contract. After a market the runner can `Treasury.spend` all of `spendable`; the floor is not
  reachable, and the melting floor is released by check-in. The design must say what limits spending in a project with
  no Council, or add a limit.
- **A 12-month cliff on the founder's own grant after a market opens,** counted in active time. In year one the
  founder is paid in money and founder Shares never meet the buyers' floor. This is new design: today the trim runs
  only before the clock starts (`Vester.sol` header; the `Treasury.handOver` comment says "before a market only"), and
  milestone 4 finding 7 says a founder leaving after the market is not trimmed, because a trim would have to undo
  released Shares. A cliff in active time also couples the Vester to the Treasury's active-time clock, which it has no
  link to now, and reverses the owner's final 18 November decision "one clock, never faster, no cliff". Today the
  founder can reach about 12% of the remaining floor by day 90 and 20% by day 182 (judgement, arithmetic). The 10 to
  30 lines first guessed are a floor, not an estimate, given the coupling.
- **Drop the Council requirement for opening an auction only after the simulation passes.** It blocks every network
  but Sepolia and local today and contradicts "auction buyers elect the Council". Until the exit-counted pause passes
  simulation, **real-money auctions stay off, or stay Council-gated**, which with no Council built means off. The
  Pair running an auction under a budget needs the budget above to exist first.
- **The Council, when it comes, may only loosen what the contract already bounds** (spending limit, raises, goal). It
  can never unpause, speed a release, touch the floor or change exit rights.
- **Make the auction window a time, not a block count: optional, defer until a chain is chosen.** The window is block
  constants in `SaleParams` (`Pinned.sol` lines 192-209: SALE_BLOCKS 7,200, BID_CLOSING_BLOCKS 720,
  ABANDON_DELAY_BLOCKS 50,400), used in `Launcher.sol` lines 618, 698 and 927-928, `Finisher.sol` line 246, MinBid's
  closing-blocks argument and the auction's endBlock and claimBlock; `Launcher.RESERVE_SALE_GAP_BLOCKS` is 201,600.
  `Pinned.sol` is the pinned interface file guarded by `PinnedDrift.t.sol`, about 10 test files (19 references) use
  the constants, and the deploy script sets them. The change is whether block time becomes a per-chain constructor
  input.
- **Launcher size.** The Launcher has 2,788 bytes left ([R5]). Removing the gate frees some; the new pause and
  wind-down entry points use some. The net is unknown and must be measured before the design is fixed.
- **Known costs.** A market panic can pause an honest project for 30 days. A rival can force a pause by buying and
  burning about 10% of Shares. The first estimate of a loss of roughly 5,000 to 7,000 dollars on a 100,000 auction
  only reproduces if the rival buys about 30M Shares from holders at the sale price (30.5M at 0.0004, less the
  hand-back at 0.000187, about 6,500). The only market is a pool of 22,000 dollars and 55M Shares where a 2,500 buy
  moves the price +23.7% (milestone 4 report); buying that many from the pool would cost roughly 25,000 dollars or
  more (judgement). So 5,000 to 7,000 is a floor under favourable assumptions. Both costs must be simulated before
  anything is built.
- **If the simulation fails: no real-money auction.** Not "auction with disclosure". Shipping the 100,000-plus tier
  with the gate removed would leave a self-bidding founder 14.59 or 5.46 of each 100 ahead if holders stay passive,
  and a 46.7% day-one hand-back (judgement, arithmetic), with nothing in front of it: the pump.fun outcome this memo
  says to avoid.

**DEFER or CUT**

- **Cut:** the phrases "speed of pump.fun", "biggest launchpad" and anything like "cannot be rugged". Decision
  markets for any holder decision. "Park a third" as the pause rule. The Council gate on the auction, but only once the
  pause rule passes simulation (see C7).
- **Public test season 1: auction, pool, Buy and Sell off. Closed "attack and play" cohort: on, in play dollars.**
  Play dollars are the one risk-free place to attack the exit machinery, and the C7 inputs (10% trigger, 30-day
  window, cost of forcing a pause) are all judgement that only real behaviour can calibrate. So a closed cohort gets
  the auction and trading on, with all copy saying the money is play, and the server logs exits, pauses and
  self-bid attempts. The public season stays simple. Status of the switches: only Buy and Sell have one (`tradingOn()`
  in `app/src/lib/server.ts`, read from `serverTrading()`); the relay has no `trading` setting at all (`config.rs`
  mentions only `investing`), so trading is off only because nothing sends it. Bid, Open auction (`PairCard.tsx`), the
  pool box and hand-back sit under `investing` and Team with no off switch. Cost: a server setting for the auction and
  hand-back, a relay field to send `trading`, and the app tests that assume market screens appear at Team, about 3 to
  5 days (estimate).
- **Defer until a project has real holders:** seat elections, the replace vote, stepped turnout floors, reserve sales
  in the app (this overrides the 18 November requirement; section 7).
- **Defer:** CREATE as project zero on any public surface until the plan's own gate is met. Founder-set price chips
  until after the first demo day (needed before project zero; the default price is the fast path).
- **Defer, but decide before real money:** letting Team rounds run to 100,000 to close the 50,000 to 100,000 hole;
  whether pool dollars may move to the frozen floor in a wind-down; whether refunded money reopens a cap once (now part
  of C2); whether large raises are sent to an existing auction venue instead of owning that tier.
- **Defer, but write down now:** a paid tier for the workspace and the AI manager, and the 12-month income number
  below which the launchpad tier is paused and the workspace is kept. No paid tier or billing exists in the relay
  manager, the app or `MANAGEMENT-LAYER` (no billing code found), so "paying users" cannot be a test signal until one
  is built.

**Do not copy**

- **From pump.fun:** trading in the creating transaction; paying creators on volume; a board sorted by money; free
  repeat launching with no visible history; the words "fair launch".
- **From MetaDAO:** decision markets for small projects; an optional team lock; a refund that needs a proposer's
  stake; a monthly budget on time alone (the whole minimum can be spent in six months with nobody agreeing); private
  places for funds before a sale; a forced return of money with no minimum the builders can count on (Ranger's staff
  and vendors went unpaid, reported, [M9]); the word "permissionless" (Backable moved off it itself, [M4]).

**The two strongest alternatives, and why they lose**

- **A. Go fast: add instant trading below the auction** (a curve from the first minute, protections layered on top).
  It is the literal reading of the owner's question. It loses because instant trading is where the rug lives (half of
  graduations in the creating minute, [P2]), it undoes the 365-day hold, every attempt found ended badly or faded
  (section 2), pump.fun's own revenue fell hard through mid-2026 ([P3]), and "fair launch" wording is now in front of
  a US court ([P7]).
- **B. Go MetaDAO: vetted only, decision markets, a legal entity per project, large raises.** It follows the money.
  It loses because it is slow (2 to 3 weeks at the very fastest, months in practice; judgement), it puts a newcomer
  against MetaDAO, Coinbase, Kraken and a Uniswap launch flow with no distribution, its markets are thin even there,
  and it gives up the one thing Creaton does better: a small backer who can leave alone.

The fallback, if the stop number in "Defer" is hit: keep the workspace and the AI manager, pause the launchpad tier.

## 7. What this means for milestones 9 and 10 and the test-network launch

Order becomes: finish 7 and 8, then step 0 (the closed cohort), then the launch pack, then 10 with the public test,
then the closed attack season, then 9. **Things are moved, deferred and cut.** What this changes against the plan and the owner's
decision to keep milestones 7 to 10:

- **Moved:** milestone 10 ahead of milestone 9; the phone path, share and shelf after the cohort.
- **Deferred or cut from milestone 9:** HolderVote's parking pause, seat elections, the replace vote, reserve sales in
  the app, the Council gate on the auction (only after simulation), the turnout-floor requirement.
- **Out of milestone 10:** CREATE as project zero.
- **Off for the public test:** the auction, pool, Buy and Sell.
- **Owner decisions this overrides, to be confirmed by the owner:** the whole 18 November progressive-decentralization
  requirement (`PLAN-V2.md` section 9, owner decision 5: holders can pause the release and replace the runner from the
  market, votes count only parked Shares, the manager's powers end by stage, and `EARLIER-BACKERS.md` section 11 "Votes",
  which says milestone 9 must keep it); owner decisions 4 and 6; and the Vester's "one clock, no cliff".

**Finish first (days).** Push and report milestones 7 and 8; commit the AI manager. Untracked today (measured by the
review pass on 19 November, the earlier 2,224 figure did not reproduce): `manager/*.rs` 2,683 lines,
`launchpad_manager.rs` 312, `docs/agents/MANAGER-LOOP.md` 219, `scripts/m8-planted-eval.sh` 37, plus a 62-line
`planted_record.json`; tracked files add about 517 inserted lines across 16 modified files. Name `docs/PLAN-V2.md` as
the launchpad's product contract, since `VISION.md` and `VISION_PROJECTS.md` say nothing about Shares or backing
(measured, full read by the repo review).

**Step 0: the closed founder cohort (estimate: 1 to 2 weeks of builder time to open, then 2 to 4 weeks running).**

1. Run `DeployPlatform.s.sol` on Sepolia for real (it has never been broadcast); re-run the fork suite (136 tests
   at the last run, [R2], which predates the earlier-backers changes; 585 local passes, [R5]).
2. A new play-dollar token on the test network with a faucet limited per account and per device; state plainly in the
   app that it is play money. The test mock cannot be used (gap 4).
3. Server settings: chain address, helper key, investing on, a `trading` field on both sides, a switch for the auction
   and hand-back, and the operator's real-money ceiling `BUZZ_MANAGER_MAX_CENTS_PER_90_DAYS` (the hosted manager is
   funded by a cap of 10% of platform fees, `cost.rs`, and on a play-dollar network those fees are play dollars).
4. Funnel counters and the written pass lines in section 8.
5. 10 to 20 hand-picked founders on desktop wallets with a plain faucet balance. Read week-2 and week-4 posting before
   spending the phone path, share and shelf weeks. Meanwhile build the notices (C4) and write the first-500-backers
   plan (section 8).

**Launch pack, after the cohort shows founders come (estimate: serial 6 to 9 weeks for one builder from the
sum of its parts, C3 part 2 at 2 to 3, C4 1 to 2, C5 1 to 2, C8 days, token and faucet about 1, switches 3 to 5 days,
plus the phone and screen-reader walk; 3 to 5 weeks with two builders in parallel (judgement)).**

1. **No contract change before the first deploy.** C2 is a decision after simulation, not a pack item. Today's
   numbers run on the test network.
2. Passkey account with sponsored gas in the new app; one confirmation to back; a daily cap on sponsored gas (C3).
3. Backer notices and the facts beside the refund button (C4).
4. Share, the "opens on" record, the countdown and the weeks-kept line (C5).
5. The Back-box sentence and the founder-history line (C8).
6. A human on a real phone, and a screen-reader walk, as milestone 6 left open ([R3]).

**Milestone 10, moved ahead of 9 and changed (estimate: 2 to 3 weeks).**

1. Seasons and demo day: a batch of backing rounds opening the same day, announced ahead. Server and app only.
2. The picked shelf, ranked by evidence with self-paid tasks and same-device backers excluded, never by money raised.
   Gated on the first-500-backers plan.
3. Creaton backs its picks as an ordinary backer, in play dollars for now.
4. Founder-set price chips in the app (after the first demo day).
5. Its test, "a week-long public test", becomes the public launch itself: one season, one demo day.
6. **Out of milestone 10 for now:** CREATE as project zero. Run Creaton as an ordinary project on the test network.

**Milestone 9, last, and redesigned (estimate: 1 week of simulation, then 3 to 5 weeks).**

1. Simulate first, calibrated by the closed attack season's logs: the exit-counted pause in a bear run; the cost of
   forcing a pause; how often an honest project is paused; the refund staying open after a market opens (gap 10).
   Real-money auctions stay off until this passes.
2. `Treasury.sol` and `Launcher.sol`: exit counter, automatic pause, automatic wind-down, with the new entry points
   (about 60 to 90 lines in the Treasury as first guessed, plus the Launcher entry points; estimate). Re-measure the
   Launcher's 2,788-byte margin.
3. `Vester.sol`: the founder cliff in active time, as new post-market design with the Treasury clock coupling.
   Check project zero and the earlier backers' contract are unaffected.
4. `Launcher.sol`: remove the Council gate only if item 1 passes. The auction window as a time is optional, deferred.
5. Project zero's team-payer role stays as the owner decided on 18 November.
6. A reduced Council that can only loosen, built after the first real-money auction, not before.
7. **Not built in milestone 9:** HolderVote's parking pause, seat elections, the replace vote, reserve sales in the
   app. They gate nothing on the test network; the exit rule and the cliff gate any real-money auction.

**The test-network launch.** What goes public (season 1): Start, Open backing, Back, refund, weekly updates, tasks,
the feed, follows, seasons and demo day, in play dollars, on a phone. What stays off for the public: auction, pool,
Buy and Sell, which run only in the closed attack cohort. It is full on the work and social side and narrow on the
money side. That is the right shape for "simple, fun, full, soon": the strong half is the built half. Read its
results as founder-side evidence only (section 8).

**Decisions this asks of the owner.** (1) Drop the two slogans. (2) Do not ship the 14-day hold on the 15 alone;
simulate it with a cap rule. (3) Step 0, then the launch pack and milestone 10, before milestone 9. (4) Milestone 9
refund-first, replacing "park a third" and the Council gate, overriding the 18 November decentralization requirement
and "no cliff"; real-money auctions off until a simulation passes. (5) Auction and trading off for the public season,
on in a closed play-dollar attack cohort. (6) Decide the backer-return question (C9) before real money. (7) Brief
counsel now, beside the build.

## 8. What would have to be true to be the biggest for real projects

- **Distribution.** Backers must arrive and come back, and there must be a trust signal money follows. Today there
  is neither, and nothing in the launch pack brings backers: share buttons and a shelf do not. **A first-500-backers
  plan, naming who they are and where each source is, is a gate on the shelf and on demo day.** It is not written;
  the owner must name the sources with a number each. The shelf, demo day and the work record are the bet. Do not
  depend on another platform's reach: Kaito, a rewards platform and not a launchpad, sunset its Yaps product and
  leaderboards on 15 January 2026 after X said it would no longer allow apps that reward users for posting and
  revoked API access; its token fell about 17% and its community on X was banned within days (reported, [F9]).
- **Chain.** One network family chosen, with cheap, fast presses, the auction contracts present (Uniswap's launch flow
  is live on Ethereum, Base, Arbitrum and Unichain since 24 June 2026, [F3a]), and a dollar token whose freeze risk is
  understood: a frozen address stops every project at once (measured, M3 fix round, cited in [R1]).
- **Liquidity.** A market that is not a slow bleed. At the 100,000 minimum the pool holds about 22,000 dollars; a
  2,500 sell moves it 19.2% (measured, [R2]), and older Shares outweigh it six to one (measured constants). Either
  large raises go where depth already is, or the product says plainly that most projects never get a market.
- **Law.** A cleared route to real dollars for a founder with no company, in at least one large market (section 9).
- **Income.** Money that does not depend on a steady flow of new raises. Launch fees alone did not carry even the
  category leader (reported, [M1]).
- **Backer return.** A reason a backer puts real money into a small project's Shares (C9). Play dollars cannot
  show it.
- **Proof.** Funded projects still shipping at week 26, shown in public. Nobody publishes that number. It can be ours.

**Earliest evidence after the test launch.** Play dollars test the flow, not demand. Backing totals are not
evidence either way. Look for these; the pass lines are (judgement) and should be written down before launch. **An
"outside founder" is one not known to the team, on a distinct device and referral chain.** Every shelf signal and pass
line excludes self-paid tasks and same-device backers, and play-dollar grants are capped per device or invite, because
accounts are free and every signal here can otherwise be forged cheaply.

| Signal | Why it is real | Pass line to argue about |
|---|---|---|
| Phone: nothing to "backed" | measures friction, not appetite | under 2 minutes for most who start |
| Share to sign-up | distribution without a paid channel | rises week on week through the season |
| Outside founders who open a round | founder supply is the scarce thing | 25 in the first six-week season: the bear year's pace of 200 a year is about 23 a season (arithmetic on [R1]); for the closed cohort, at least 10 of 20 open a round |
| Founders still posting at weeks 2, 4, 8 | the work record is the product | more than half at week 4 |
| Refunds after a notice | the anti-rug loop works end to end | quiet projects lose backers faster than active ones |
| "I would back this with real money" marks, and each founder's stated real amount | weak, but the only backer-side hint | labelled as intentions, never as demand |
| Exits, pauses and self-bid attempts in the attack cohort | calibrates C7 | enough events to set the 10% and 30-day numbers |
| Manager runs inside its cost cap | the AI manager can be run at all | cost per active project under the operator ceiling (no paid tier exists, so paying users are not a signal) |
| Unprompted requests for a demo-day place | pull, not push | more requests than places by season two |

If founders do not come or do not keep posting, more mechanism will not fix it. If they do, the next step is a small,
lawful real-money round, with counsel's answers and the C9 decision, not the auction tier.

## 9. Questions for counsel

None of this is advice. Brief counsel now; the answers may change the refund, the name "Shares" and who may back.

1. Who is the issuer when a solo founder has no company, and who files anything that must be filed? In the EU an
   offeror under the small-offer exemptions must still be a legal person (MiCA Article 4(2), reported, [L3]).
2. Are Shares that fund a named founder's work investment contracts? On 31 August 2026 Senior Judge McMahon
   (S.D.N.Y., Aguilar v. Baton Corporation Ltd., No. 1:25-cv-00880) held two meme coins, FRED and GRIFFAIN, not
   securities as pleaded, because no common enterprise was pleaded; the order is fact-specific, and the same report
   says tokens that pool proceeds to fund a real enterprise could still be securities, which is Creaton's situation
   (reported, [P7]; secondary, pull the docket).
3. Is the platform a broker, a portal or a licensed service provider when it holds and releases backers' dollars?
   The same ruling let an unlicensed money transmission claim proceed against the Baton defendants, pump.fun's
   operator, but not against the Solana defendants, and let a "fair launch" wire-fraud predicate and RICO counts
   proceed for two plaintiffs (reported, [P7]).
4. Is a refundable fixed-price round a deposit? If C2 is ever shipped, does holding the 15 for 14 days make that
   better or worse?
5. EU: does each project fit an exemption (under 1,000,000 euros in 12 months, or fewer than 150 persons per member
   state, or qualified investors only)? The exemptions are lost if admission to trading is sought (Article 4(4)), so
   does a Uniswap pool count? The offeror must also draft marketing communications and meet the Article 14 offeror
   requirements (reported, [L3]). Does a 14-day right of withdrawal apply? (MiCA Article 13; outside knowledge, may
   be out of date.)
6. US: could a project use the SEC's proposed startup exemption ("Regulation Crypto Assets", proposed 18 August 2026:
   up to 5M over four years, issuer may be an entity, individual or group, a Form NOR notice, website disclosures,
   general solicitation, no accredited-investor requirement)? Comments closed 20 October 2026 and final rules are not
   expected before the first half of 2027 (reported, [L2]). The CLARITY Act stalled: Senate cloture failed 49-50 on 15
   September 2026 and passage this Congress is seen as unlikely (reported, [L1], 2 October 2026; [L1] covers the
   stall, not offering exemptions). Who is the filer?
7. Is any wording such as "fair", "protected" or "cannot be cheated" safe, given the "fair launch" claims in [P7]?
8. What does it mean, legally, when the owner picks projects for the shelf or backs them on demo day?
9. Is a test network with play dollars outside all of this? Does anything done there bind the later real structure?
   Does a counsel-cleared real-money micro-pledge (C9) change the answer?
10. The word "Shares"; the four tensions with the app's legal line and the two BUSL-1.1 files already listed in
    [R1] section 10; perks or milestone-gated releases for backers, before either is designed.
11. Who could enforce anything for holders, in which court, if Creaton later adds a legal entity per project?
12. What happens to every project if the dollar token freezes an address?

## 10. Sources

Outside sources were read on 18 to 19 November 2026, most through a summarising fetch tool, and the review pass re-read
many of them; recheck exact figures on the linked pages before quoting them in public. Pump.fun's own fee pages
refused automated reading. Sources belong in this document, never in app copy.

**Pump.fun and fast launchpads**
- [P1] https://madeonsol.com/blog/how-to-use-pump-fun (27 Mar 2026, updated 30 Sep 2026)
- [P2] https://madeonsol.com/blog/pump-fun-deployer-stats-august-2026 (28 Aug 2026; publisher's own chain data, 1 to 28 August)
- [P3] https://theblock.co/news/ecosystems/2026-06-16-pump-fun-activity-craters-80-three-months-solana-fees-lower-traders-rotate-perps-404806 (16 Jun 2026; page does not say whether 4.8M is revenue or fees)
- [P4] https://www.theblock.co/post/384975/pump-fun-overhauls-creator-fees-token-launches-highest-daily-count-since-september (9 Jan 2026; quoting a co-founder's X post)
- [P5] https://www.soliduslabs.com/reports/solana-rug-pulls-pump-dumps-crypto-compliance (May 2025; vendor report; uses 98.6%, 98.7% and 98% in different places)
- [P5b] https://hotfix.coindesk.com/business/2025/05/07/98-of-tokens-on-pump-fun-have-been-rug-pulls-or-an-act-of-fraud-new-report-says (7 May 2025, the original coverage; the pump.fun rebuttal piece was not read)
- [P6] https://crypto.news/pump-fun-data-shows-49-of-march-traders-in-the-red-as-platform-locks-fees/ (30 Mar 2026; Dune dashboard by an anonymous analyst, about 1.4M wallets)
- [P7] https://ourcryptotalk.com/news/judge-clears-solana-pump-fun-lawsuit-rico-survives (1 Sep 2026; secondary)
- [P8] https://solanafloor.com/news/pasternak-s-arrest-is-the-final-nail-in-coffin-for-believe-app (about May 2026);
  https://crypto.news/class-action-claims-believe-founder-collected-54m-while-diluting-token-holders/ (29 Apr 2026; no filing date)
- [P8b] https://assets.alm.com/91/96/5ba52cf14399854e7ecc2a46b2c4/lee-v-pasternak-complaint-u-s-district-court-for-the-southern-district-of-new-york.pdf (the complaint, found in search, not opened)
- [P9] https://www.mitrade.com/insights/news/live-news/article-3-2073705-20260910 (10 Sep 2026; DefiLlama revenue)
- [P10] https://cryptobriefing.com/pumpfun-launches-perpetual-futures-hyperliquid/ (Oct 2026; perps only; summary only)
- [P11] https://thedefiant.io/news/defi/pump-fun-launches-usdc-paired-liquidity-pools-gi72da (May 2026; USDC pairs; found in search, not read in full)

**MetaDAO**
- [M1] https://alearesearch.substack.com/p/raise-in-public-spend-in-public (18 Sep 2026)
- [M2] https://cryptobriefing.com/metadao-launches-backable-solana-fundraising/ (6 Oct 2026)
- [M3] https://cryptobriefing.com/futardio-44m-commitments-metadao-sourcing/ (14 Sep 2026; Futardio start 3 Mar 2026; URL says 44M, body says 43M)
- [M4] https://solanacompass.com/news/metadaos-backable-removes-percolator-raise-and-drops-permissionless-for-platform-moderation (Nov 2026; summary only, page refused to load); Rootdata, https://www.rootdata.com/news/822434 (about 10 Nov 2026 removal of the Percolator raise; ZachXBT's objection 8 Nov; Backable says it rejects a curator role and will call itself "open")
- [M4b] https://solanacompass.com/news/metadaos-1609sat-raise-closes-79x-oversubscribed-with-79m-committed-as-mori-finance-raise-opens (9 Nov 2026; summary only)
- [M5] https://docs.metadao.fi/how-launches-work/sale.md and https://docs.metadao.fi/how-launches-work/create.md (fetched 18 Nov 2026)
- [M6] https://docs.metadao.fi/governance/proposals.md, https://docs.metadao.fi/governance/twaps.md, https://docs.metadao.fi/governance/markets.md (fetched 18 to 19 Nov 2026)
- [M7] https://docs.metadao.fi/benefits/investors.md and https://docs.metadao.fi/benefits/ownership-coins.md (fetched 18 Nov 2026)
- [M8] https://blockworks.com/newsletter/0xresearch/issue/post_e32e717c-c367-4b57-a451-70cae583c47c (4 Aug 2026)
- [M9] https://solanafloor.com/news/ranger-finance-liquidation-divides-opinions-on-futarchic-markets and https://solanafloor.com/news/ranger-finance-winds-down (2026, undated pages; snapshot 12 March; about 5.04M USDC removed)
- [M10] https://phemex.com/news/article/metadaos-hurupay-ico-fails-to-meet-3m-target-raises-203m-59219 (9 Feb 2026)
- [M11] https://defillama.com/token/meta (read Nov 2026 through a search summary; Q3 2026 gross protocol revenue about 112,000, contradicted by its protocol page's monthly figures)

**The field**
- [F1] https://blog.innmind.com/refundable-crypto-launchpad-risks-founders/ (31 Jul 2026; authors' sister product is a non-refundable launchpad)
- [F2] https://cryptorank.io/insights/analytics/q2-2026-the-worst-ico-quarter (early June 2026 snapshot, later revised; the beincrypto mirror refused to load)
- [F3] https://blog.uniswap.org/aztec-cca (10 Feb 2026; the Aztec example only)
- [F3a] https://blog.uniswap.org/launch-auctions-from-uniswap-web-app (24 Jun 2026; date and chains)
- [F5] https://www.theblock.co/post/378177/coinbase-public-token-sales-ico-platform-monad-first (Nov 2025; summary only)
- [F6] https://www.theblock.co/post/371244/kraken-token-sales-legion-new-launch-platform (18 Sep 2025; summary only)
- [F7] https://www.theblock.co/news/ecosystems/2026-07-15-coinbases-jesse-pollak-hands-base-app-leadership-cobie-social-bets-fell-short-408504 (15 Jul 2026; Pollak's X post)
- [F8] https://defillama.com/protocol/bags (page refused to load; unverified; a Defiant item seen in search, undated, said Bags fees fell about 65%)
- [F9] https://bex.co/blog/2026/04/29/kaito-yaps-sunset-attention-markets-pivot-infofi-platform-fragility/ (29 Apr 2026; the old blockeden.xyz link redirects here)

**Law and rules (reported, not advice)**
- [L1] https://www.orrick.com/Insights/2026/10/The-CLARITY-Act-Stalls-in-the-Senate-Whats-Next-for-Digital-Asset-Regulation (2 Oct 2026)
- [L2] https://www.mintz.com/insights-center/viewpoints/2026-08-27-secs-proposed-crypto-offering-framework-good-first-step-or (27 Aug 2026)
- [L3] https://www.esma.europa.eu/publications-and-data/interactive-single-rulebook/mica/article-4-offers-public-crypto-assets-other (2026; page loaded)

**This repo (read 18 to 19 Nov 2026; nothing was built or run for this memo)**
- [R1] `docs/PLAN-V2.md` (plan of record, 17 to 18 Nov 2026)
- [R2] `docs/next-version/PLANV2-M4-REPORT.md` (refund numbers, attacks, gas, self-bidding re-runs, the 136-test fork run)
- [R3] `docs/next-version/PLANV2-M6-REPORT.md` (press budgets, open items)
- [R4] `docs/next-version/PLANV2-M5P2-REPORT.md` (server: what is open)
- [R5] `docs/next-version/EARLIER-BACKERS.md` section 11 (585 local passes, Launcher size, "Votes")
- [R6] `contracts/next/src/` `Launcher.sol`, `Rounds.sol`, `Treasury.sol`, `Vester.sol`, `Pinned.sol` (constants read today)
- [R7] `app/src/features/money/wallet.ts`, `app/src/features/money/OpenBacking.tsx`, `web/src/features/identity/lib/`
- [R8] `docs/next-version/FOUNDER-PRICE.md` (the 58% for a default project)

## 11. Objections considered

Reviewers' findings were all taken except where noted here.

- **Run the cohort on the existing app with a manually granted balance (no new work).** Taken in spirit, not to the
  letter: the existing app cannot run a cohort without a real deploy and a safe token, because the only token is the
  test mock with an open mint and freeze switches. So step 0 includes the deploy, the token and the faucet, and nothing
  else.
- **Turn the auction and trading on in the public season.** Declined for the public season, accepted for a closed
  cohort. The public launch must stay simple, the Team tier needs a second signer, and the switches for the auction
  and hand-back do not exist yet. The closed cohort gets the calibration data the reviewer wanted.
- **Make a counsel-cleared real-money micro-pledge the first real evidence.** Kept as the first real-money step but
  placed after counsel's first answers; the owner chose a play-dollar test network and nothing here brings real money
  forward.
- **Design the backer-return mechanism now (perks, a small guaranteed hand-back, an early market).** Declined as
  design in this memo. It is raised as a required decision (C9), with the options named, because each option changes
  the 365-day hold, the refund and the legal question, and counsel should see them first.
- **Drop the shelf because its signals can be forged.** Declined; the shelf stays, with an "outside founder"
  definition, exclusions and a distribution gate, because without a trust signal the product has none.
- **Do not ship C2 at all.** Taken: it moves out of the launch pack to a simulated decision with a cap rule, and the
  test network runs today's numbers. It is not cut from the plan entirely, since the 15 paid at once is still a real
  leak on a real-money network.
- **Pick between hiding asks until hour 12 and dropping that plan rule.** Left as a decision for the owner (C5),
  because either choice changes `BackBox` and its tests.
