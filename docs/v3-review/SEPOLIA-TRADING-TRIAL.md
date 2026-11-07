# The Sepolia trading trial: one weekly sale, from nothing to collected

For the person running the trial on `creaton.io` (the OVHcloud server, Sepolia, test money). Eleven steps, with what to
check after each. The labels are the ones on the screen today.

**What this is.** A real run of the weekly sale of Shares, with the real timers, on a test network. The buyers pay in a
free test token that anyone can make more of, so **a price in it proves nothing**: this trial tests that the screens, the
chain and the keeper work together, not what Shares are worth. Nothing here is audited, and nothing here is a step towards
a real-money listing by itself: the gates in [SECONDARY-TRADING-RUNBOOK.md](SECONDARY-TRADING-RUNBOOK.md) (§1) still apply
to any project that carries real value.

**What was decided.**

- It runs on the same server as the pilot (`creaton.io`), with trading switched on for the trial. **Before real pilot people
  are invited, the image is rebuilt without the trial block** (end of this page).
- The trial build stays contributor-only: there are no raises, no sales of the project itself.
- Prices are in the free test token, named **tTEST** ("Creaton test token (free, worth nothing)"). The Trading card says
  it is free and worth nothing, and offers **Get test tokens** (1,000 a press).
- Real timers. The trial project is started a week before the testers arrive, so the first round is the operator's own
  rehearsal and the testers get the second.
- Trading stays off in every build that does not set both explicit switches (`VITE_SECONDARY_MARKET_FACTORY` and
  `VITE_TRADING_TRIAL=1`).

## Before you start

| Who | What | Where |
|---|---|---|
| Engineer | The contracts are on Sepolia (the new set) and the manifest `contracts/deployments/v5-sepolia-11155111.json` is committed | [docs/sepolia-testnet.md](../sepolia-testnet.md), "Trading" |
| Engineer | The server is built with the trial block in `deploy/compose/.env` (`./run.sh build`, `./run.sh restart`); `./run.sh build` printed `Trading: on` | [deploy/compose/.env.creaton.example](../../deploy/compose/.env.creaton.example) |
| Owner | ZeroDev gas policy: **sponsor every call, with a spending limit** | [docs/sepolia-testnet.md](../sepolia-testnet.md), "Trading", step 5 |
| Owner | The keeper's key, funded, and its timer on for the project's market | [deploy/ovh/keeper/README.md](../../deploy/ovh/keeper/README.md) |
| Owner | Three browser profiles or devices: founder, buyer, spare reviewer, each with its own invite link | step 1 below |

## Who you need

- **Two active accounts.** The **founder** is the seller: the founder holds all the Shares at birth, and the project itself
  cannot sell. The **buyer** is a second account.
- **Two passive accounts.** The Start form asks for reviewers who are not the founder. They sign nothing in this trial, so
  the buyer can be one and one more person who joined can be the other.
- **One owner can play all of them**: one browser profile (or device) per account. Each profile needs its own invite link
  from an admin, then **Set up passkey sign-in** in the profile menu. One passkey is one account. A browser wallet works
  instead, but it pays its own test gas.
- A third profile helps at step 11. One person may sell and buy in the same round.

## The timeline (real timers; none of it can be sped up)

Counted from the day the project starts (day 0):

| Day | What happens | Step |
|---|---|---|
| 0 | The founder starts the project and puts the listing to a vote | 2, 4 |
| 2 | The vote has had its 2-day review: **Start the wait** | 5 |
| 3 | After the 1-day wait: **Make it take effect**; then anyone can open round 1 | 5, 6 |
| 3 to 6 | Offers and bids (bidding is open 3 days) | 7, 8 |
| 6 | Bidding is over. Anyone settles it, within 2 days or the round goes void and everyone is refunded | 9 |
| 6 | Everyone collects. No wait, no deadline | 10, 11 |
| 10 | The next round can open (rounds are 7 days apart); it repeats on days 17, 24 and so on | 6 |

**Start the test project a week before the testers arrive.** Then round 1 (days 3 to 6) is the operator's full rehearsal,
with the keeper doing the settling, and round 2 can open on day 10, three days into the testers' week. They find the
listing already approved and the screens already used; they only wait for the round to open. A project a tester starts
themselves needs the 3 days before its first round can open, and 6 days to the first collect. Nothing on Sepolia can be
warped: the compressed click-through in `scripts/web-trading-e2e.sh` runs only on a local chain.

## The 11 steps

The Funds tab is a project's page with `?tab=treasury`. The Trading card is on it.

### 1. Operator: the server shows trading

Open the site. Open any project made on the new set, then its **Funds** tab.

- **Check:** the Trading card says "Trading is off: the project has no open listing." and not "Trading isn't set up on this
  network". If it says that, the build names the market factory for another network; if the card has no market at all, the
  project is not on the new set (a project from the 5 Nov kit never gets a market).
- **Check:** `./run.sh build` printed `Trading: on` and `Free test token: on`.

### 2. Founder: start the project

Start, then **Start the project**. Under "Weekly sale of Shares":

- **Shares in one lot**: leave 100, or set what you like. People offer and bid in whole lots.
- **Days before you can sell any of your Shares**: 0.
- **Days over which your Shares unlock**: 180. Your Shares unlock evenly, so on day 3 you can offer about 1.7% of your
  starting Shares (100,000 x 3 / 180 = 1,666 Shares, 16 lots of 100); the card shows "You can offer up to N lots now".

Name reviewers (none of them the founder). The form asks the node what the launch needs; it is about 10.8 million gas
against a limit of 16.8 million. If the live node refuses, the form says so in words and sends nothing; then use the
fallback in [docs/sepolia-testnet.md](../sepolia-testnet.md) ("Trading", step 3), which starts the project from a wallet
(it does not publish the project's page record, so use the form when you can).

- **Check:** the project page and its Funds tab appear for every invited profile. The Trading card says no round has opened.
  `cast call <market> 'listing()(bool,uint128,uint128,uint32)'` is all zero and `roundCount()` is 0.

### 3. Buyer: join, and get test tokens

Join by invite, **Set up passkey sign-in**, open the project, then **Funds**. On the Trading card press **Get test tokens**
(1,000 tTEST a press; the card only shows it when the project's price token is the free test token). The buyer's account
address is shown at the foot of the card.

- **Check:** the buyer's tTEST balance is 1,000 (`balanceOf` on the account address). The buyer holds no test ETH and can
  still act, because the gas is sponsored.

### 4. Founder: put the listing to a vote

Decisions, **New decision**, **Publish a weekly market listing**. Under "The listing" choose **Publish prices and steps (or
change them)**, then:

- **Lowest price per lot (tTEST)**: 0.10
- **Highest price per lot (tTEST)**: 3.30
- **Price steps**: 32

Then **Put it to a vote**, and **Back it** (leave Shares empty: the founder holds everything and carries it alone).

- **Check:** the decision shows "Collecting support" with a review date, and "Your vote" says the founder backs it with all
  Shares. The form may show an amber note, "This market has not been independently reviewed"; that stays true.
- **Time:** the review is 2 days.

### 5. Founder, or anyone: start the wait, then make it take effect

When the decision card says it is approved, press **Start the wait**. After one more day the card says "Ready to take
effect": press **Make it take effect**.

- **Check:** the decision reads "Done". The card says "Trading is on" and gives the prices and the 32 steps. `listing()`
  returns `(true, 100000..., 3300000..., 32)` in the token's units.
- **Time:** 1 day between the two presses.

### 6. Anyone: open the week's round

The card says "No round has opened yet." Press **Open this week's round**. (The keeper does not do this: it settles only.)

- **Check:** `roundCount()` is 1; the card says offers and bids close on a date 3 days away; the founder and the buyer both
  see **Offer Shares** and **Bid for Shares**.
- **Time:** later rounds open at least 7 days after the last one.

### 7. Founder: offer Shares

**Offer Shares**: **Lots to offer** 3, **Lowest price a lot (tTEST)** 0.10, then **Offer them**. Offer on or after day 3,
and no more than "You can offer up to N lots now" allows.

- **Check:** the card says "You offer 3 lots at ..."; the market holds the offered Shares; the founder's balance dropped by
  that much.

### 8. Buyer: bid

**Bid for Shares**: **Lots to buy** 3, **Highest price a lot (tTEST)** 3.30, then **Place the bid**. The card says the bid
holds 9.9 tTEST until the round settles.

- **Check:** the card says "You bid for 3 lots at up to ..."; the market holds 9.9 tTEST of the buyer's.
- **Optional:** during bidding the founder can **Take my Shares back**, and the buyer **Take my bid back**.

### 9. Anyone: settle the round

After the close the card says "Bidding is over. Anyone can settle it until <date>." Press **Settle the round**. If the keeper
is on, it does this within half an hour; look at its log instead (`deploy/ovh/keeper/install.sh status`).

- **Check:** the card says "Settled: 3 lots traded at 0.10 tTEST a lot" and notes that one person's offer sets the price.
- **Time:** only after bidding closes, and within 2 days, or the round goes void. A void round refunds everyone: nothing is
  lost, but that round is wasted (**Collect from an earlier round** takes things back).

### 10. Founder and buyer: collect

The founder presses the **Collect** button, which names the amount (0.3 tTEST). The buyer presses **Collect** for the Shares
(3 lots of 100 is 300 Shares) and then **Collect** for the money back (9.6 tTEST: 9.9 held, 0.3 paid at the lowest step).

- **Check:** the buyer's Shares are up by 3 lots, the buyer's tTEST is up 9.6, the founder's tTEST is up 0.3; the buttons
  disappear and focus stays in the card; the market holds nothing of this round.

### 11. A third profile: the Funds tab

Any other profile opens the Funds tab.

- **Check:** it shows the settled price and the note that one person sets the price, with no collect button. A collect from
  that profile would be refused as having nothing to claim.

**Round 2.** From day 10 the card shows **Earlier rounds** and **Check older rounds**. Run steps 6 to 11 again with the other
account as the seller if you like; a seller who is not the founder needs Shares first (an award vote).

## What the gas sponsor must cover

Passkey accounts send through ZeroDev. The gas policy must allow every call in this list, on contracts that are new for
every project, so an address list cannot work. Use **sponsor everything, with a spending limit** and watch the limit.

| Target | Calls | Steps |
|---|---|---|
| The weekly-sale kit | the project launch (about 10.8 million gas, only if sent from a passkey) | 2 |
| The project's DAO | open a decision, vote, queue, execute | 4, 5 |
| The project's market | open a round, offer, bid, cancel, settle, collect | 6 to 11 |
| The project's Shares | approve (batched before an offer) | 7 |
| The test token | mint (Get test tokens), approve (batched before a bid) | 3, 8 |

Settling and both collects can be sent by anyone, so the keeper (a plain account) pays for settling and it needs no sponsor.

## What to write down

Every transaction on sepolia.etherscan.io, by the sender account; the time of each step; and any "Technical details" text a
screen showed when something failed. Send those to the engineer.

## When something is wrong

- "Trading isn't set up on this network": the build names the market factory for another network.
- No **Offer Shares**: the listing is not in effect (steps 4, 5), no round is open (step 6), or the account is not signed in.
- "You can offer up to 0 lots": the founder's Shares have not unlocked enough for one lot yet. A smaller lot, or a later day.
- Settle refused: the round has not closed yet, or it is more than 2 days past (void). Check the date on the card.
- The project would not start from a passkey account: the bundler refused the big launch. Start it from a wallet (the
  fallback in `docs/sepolia-testnet.md`).

## Switching trading off again

Before real pilot people are invited: remove the trial block lines from `deploy/compose/.env` (at least
`VITE_SECONDARY_MARKET_FACTORY` and `VITE_TRADING_TRIAL`, and `VITE_TEST_QUOTE_TOKENS`; see the sepolia-testnet page for
which others to put back to the pilot's values), run `./run.sh build` (it must print `Trading: off`) and `./run.sh restart`.
Switch the keeper timers off (`sudo systemctl disable --now creaton-keeper@<market>.timer`). Projects started on the trial
keep their on-chain listing, but the pilot's page no longer shows trading.
