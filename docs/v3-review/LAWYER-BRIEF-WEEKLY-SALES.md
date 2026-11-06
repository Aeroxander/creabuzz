# Weekly sales of existing Shares: a brief for counsel and for an outside auditor

Written 2026-11-05 on branch `v4-governance-rework`. The market described here (the V2 launch kit, the market factory
and the market) is not deployed or switched on anywhere. One older contract that this brief names, the frozen
`WeeklyRounds`, is deprecated on our side (D185): our scripts no longer deploy it and the app no longer offers it. One
copy made on 5 November 2026 sits unused on the Sepolia test network (section 8, item 18).
Updated later the same day, after the ten low-severity batches (B15 to B24) were run (section 5.6): line counts, test
counts and the open lists in sections 5, 6 and 8 were re-measured or rewritten then.
Updated 2026-11-06 after counsel's second round: section 7 now opens with the decision on where the market may be
offered (7.0) and a record of counsel's preliminary views (7.1), and adds sections on the EU crypto-asset rules (7.2),
money transmission (7.3) and the platform as a payer (7.4); section 8 adds items 17 to 20. No code, contract or
parameter was changed. Sections 1 to 6 and the questions numbered 1 to 25 keep their numbers.
Updated 2026-11-06, later (D185): the owner decided to show price history on the weekly sale, with the permanent label,
and to deprecate the old `WeeklyRounds` contract on our side. The Trading card now has an "Earlier rounds" list
(`9eecfcb`); the deploy script, the web app and the launch documents no longer carry `WeeklyRounds` (`4d90bb1`,
`34353a7`). Items 18 and 19, section 1.7 and the places that cite them were rewritten, and the line numbers this brief
cites were read again at that point. No economic parameter changed.
This brief is engineering material, not legal advice.

**Who this is for.** A securities and technology lawyer who has not seen the code, and an outside smart-contract
auditor who has not seen the product. Each section says what is true, names the file it comes from, and says what
was not checked. Where a statement rests on a test, the test is named so it can be found. Where something is a
proposal or an open choice, it is labelled as one.

**How the evidence in this brief was produced.** The code was written and checked by AI agents working under the
product owner's direction (the "author" below). Agents read the code, wrote tests, tried to break each other's
findings, and fixed what held up. That is an internal review. It is not an audit, it was not done by a person with
audit credentials, and nothing here should be described to anyone as "audited" or "independently reviewed". Section 6
lists what has not been done.

---

## 1. What the feature is, in plain words

### 1.1 The one-sentence version

Once a week, people who already hold Shares in a project can offer some of them for sale, other people can bid to buy,
and after three days a single price is computed from all the offers and bids, and everyone who traded trades at that
one price.

### 1.2 Terms used

| Term | Meaning here |
|---|---|
| **Project** | A contributor project created through the V2 launch kit. It has a DAO (a smart contract governed by votes of its Shares holders), a Shares token, and (new in this work) one secondary market contract. |
| **Shares** | The project's voting token. Holding Shares gives a vote on the project's DAO and a pro-rata right to leave the project with a share of what its treasury holds (the "exit", also called ragequit). The product copy describes this as ownership; whether it is a security is question 1 in section 7. |
| **Quote token** | The one ERC-20 token that buyers pay with and sellers are paid in. Chosen by the founder at launch and fixed for that market for ever. |
| **Lot** | The unit of trading. The lot size is fixed at launch (the test fixtures use 1 Share, written 1e18 base units). Every order is a whole number of lots. |
| **Round** | One weekly trading window. It opens, takes orders for 3 days, then can be settled by anyone within the next 2 days. |
| **Escrow** | Shares and quote tokens an order puts into the market contract while it waits. They stay there until the round is settled or void and the owner collects. |
| **Settle** | The public call that computes the single price and the fills. It can be made by anyone. |
| **Collect (claim)** | Taking back what is owed after settlement: the unsold Shares, the sale money, the bought Shares, the unspent bid money. Anyone can trigger a collect for an order, and the money or Shares always go to the order's owner, never to the caller. |

### 1.3 Who sells to whom

- **Sellers** are existing holders offering Shares they already own. That means: the founder (only as the founder's
  sale schedule releases Shares, section 3.4), contributors who were awarded Shares through the project's reviewed
  award flow, and earlier buyers who have collected Shares and are offering them again in a later round
  (`test_the_buyer_resells_what_they_claimed_in_a_later_round`).
- **Buyers** are anyone who holds the quote token and a wallet. The contract has no allowlist, no identity check and
  no country check (a search of `SecondaryMarket.sol` for allowlist, KYC and sanctions terms found nothing, and the
  trading card text mentions no country restriction). Any limit on who may buy would have to be added.
- **The project itself (the DAO) cannot sell.** A call from the DAO address to offer Shares reverts
  (`DaoCannotSell`, `SecondaryMarket.sol` line 276; tests `test_the_dao_and_the_market_cannot_sell_inventory`). Shares
  held by the DAO leave it only as reviewed awards, so no route moves DAO-held Shares into the market.
- **Shares cannot otherwise move between holders.** At birth the Shares token is locked against transfers and the
  market is the single named exception (`transfersLocked() == true`, `transferExempt() == market`, set once, at
  creation, and never changeable). So the market is the only place where Shares change hands, until the DAO takes
  the separate, slower step of lifting the lock (it requires a 30-day public notice, `UNLOCK_NOTICE`).

### 1.4 What is escrowed

- A **sell order** moves exactly `lots x lotSize` Shares from the seller into the market, measured by the market's
  own balance before and after (if the amount received differs by one unit, the order is refused). Only Shares the
  seller is currently allowed to sell can be offered (`policy.saleCapacity`).
- A **bid** moves exactly `lots x limit price` of the quote token into the market, measured the same way. A token
  that skims a fee on transfer is therefore refused rather than accepted at a lower value
  (`test_a_quote_that_delivers_less_than_asked_is_refused`).
- Escrow is held per order and per round. Each order has its own recorded right, each round has its own totals
  (`sharesIn`, `quoteIn`), and every payout is checked against both. One market holds one project's tokens only, and
  no round can pay from another round's money.
- Cancelling is free while bidding is open. After the close, an order cannot be withdrawn; it is settled.
- A seller can never be paid before settlement, and no one other than the owner can redirect a payout. (A defect that
  let anyone burn a seller's proceeds before settlement was found and fixed, see F1 in section 5.)

### 1.5 How a round is priced and settled

**Prices.** When the project votes to publish a listing, it sets a lowest price, a highest price and a number of
steps (at most 64). The price of a lot is a whole number of quote units: the lowest price plus the step number times
a fixed step. The range must divide exactly into steps, so every price is a whole number. The terms are copied into
each round when it opens and cannot change for that round.

**Orders.** A seller names the lowest step at which they will sell. A buyer names the highest step at which they will
buy. Each side has at most 32 orders per round, one order per address per side.

**The price.** For each step, count the lots sellers would sell at or below it and the lots buyers would buy at or
above it. The traded amount at a step is the smaller of the two. The round clears at the step that trades the most
lots; if several steps tie, the lowest one wins. Everyone who trades pays and receives that one step's price.

**Who fills.** On the short side (the side with fewer lots), every order that crosses is filled in full. On the long
side, all crossing orders share the traded amount in proportion to their size, in whole lots, with any odd leftover
lots going one each to the earliest orders (lowest order number). The sellers' filled lots always equal the buyers'
filled lots exactly.

**Settlement.** Anyone calls `settle` between the close of bidding and two days later. If nobody settles in that
window the round is *void*: nobody trades, and everyone collects back everything they put in.

**Worked example** (from the test `test_clearing_fills_whole_crossers_and_shares_the_oversubscribed_side_exactly`,
`SecondaryMarketFlowsClearing.t.sol`). One lot is 1 Share. Prices are whole units of the test price token: lowest
1,600, highest 5,600, 8 steps, so step n costs 1,600 + 500 x n (step 0 is 1,600, step 4 is 3,600, step 8 is 5,600).
The test does not give those units a currency value.

| Order | Side | Lots | Limit |
|---|---|---|---|
| S1 | sell | 40 | from step 0 (1,600) |
| S2 | sell | 30 | from step 4 (3,600) |
| S3 | sell | 20 | from step 8 (5,600) |
| B1 | buy | 25 | up to step 1 (2,100) |
| B2 | buy | 35 | up to step 4 (3,600) |
| B3 | buy | 10 | up to step 8 (5,600) |

- At step 4 (3,600): sellers offering at or below it are S1 and S2, 70 lots; buyers willing to pay at least it are B2
  and B3, 45 lots. Traded amount: 45. No other step trades more (steps 1 to 3 trade 40; steps above 4 trade 10). The
  round clears at step 4, price 3,600 a lot.
- Supply (70) exceeds demand (45), so buyers fill in full (B2 35, B3 10) and sellers share the 45 in proportion:
  S1 40 x 45 / 70 = 25.7, so 25 whole lots; S2 30 x 45 / 70 = 19.3, so 19; that is 44; the one leftover lot goes to the
  earlier order, S1, giving **S1 26, S2 19** (the test asserts 26 and 19). S3 sells nothing.
- Money: S1 receives 26 x 3,600 = 93,600; S2 receives 19 x 3,600 = 68,400; together 162,000 = 45 x 3,600. B2 pays
  35 x 3,600 = 126,000. B3 escrowed 10 x 5,600 = 56,000, pays 36,000, and gets 20,000 back (the test asserts the
  20,000 refund). B1 never crossed and gets all 52,500 back. Money in equals money out; the test asserts the market
  ends with zero quote and zero Shares ledger for the round.
- Unsold Shares come back by collect: S1 14 lots, S2 11, S3 20. A second collect of the same thing is refused.

### 1.6 What the DAO can and cannot do

The DAO is the project's own governance contract. At birth the founder holds every Share, so the founder alone can
pass the project's proposals, after the project's review period, hold period and execution delay. New Shares are
issued only as reviewed awards within a yearly limit, which dilutes existing holders; that is a standing feature of
the project, not of the market.

Toward the market the DAO has exactly one power:

| Can | Cannot |
|---|---|
| Publish a listing with a price range and a step count (`configureListing`, DAO only, `SecondaryMarket.sol` line 228). Publishing is what allows rounds to open. | Change a round that is already open: terms are frozen at opening. |
| Switch the listing off. That stops new rounds and new offers and bids, including in a round already open. | Stop settlement, refunds, returns or collection. These stay open whatever the DAO does (`test_disabling_stops_new_activity_never_settlement`). |
| Change the terms again for the next round, any time. | Sell Shares, mint Shares, take a fee (the fee is fixed at zero in the code), move anyone's escrow, cancel anyone's order, or pause collection. |

One thing the DAO *could* do and no longer can: set a transfer validator on the Shares that refuses the market's
transfers, which would have frozen sellers' escrow. This was a real defect found in review (F3, section 5). The market
is now exempt from the validator.

Not closed: the DAO can name an *exit exchange* for the Shares, a separate older feature, with 30 days' notice. The
older, frozen `WeeklyRounds` contract could be named in that slot, and so could a copy of it deployed by someone else.
It is the contract with the theft defects in `WEEKLY-ROUNDS-AUDIT-2026-11-01.md`. The owner has deprecated it on our
side (D185): our scripts no longer deploy it and the app no longer offers it. That does not stop the slot from naming a
copy deployed by someone else; the V2 contracts still accept any non-zero address there. An unused copy is on the
Sepolia test network, and counsel's preliminary view is that naming it on a value-bearing network must be made
impossible, not prevented by process (section 8, item 18).

### 1.7 What the app tells people

The trading card sits on the project's Treasury tab. In plain words, it:

- says whether trading is set up on this network, whether the project has published a listing, and whether the
  market can be read right now. A failed read is shown as a failure, never as "no market".
- shows the round, its prices in the price token's own units and symbol (read from the token), the time orders close
  and the time settling ends, and the viewer's own orders and what they can collect. A round that settled with
  nothing crossed says "nothing traded" and prints no price.
- lists the earlier rounds under the Trading card ("Earlier rounds", `TradingHistory.tsx`), newest first, 12 at a time
  with a "Show older rounds" step. Each row has the opening date and time with the time zone, then "N lots traded at P
  TOKEN a lot", or "No trade" for a round nobody settled or where nothing crossed. A failed read says "Could not load
  earlier rounds. Try again." with a retry. The list shows only when the price token's units are known.
- shows a standing label wherever a settled price is printed: "One person can set a round's price. An account can sell
  and buy in the same round, and one person can hold more than one account." It sits under the latest round's line and
  once under the earlier-rounds list (section 8, item 19). Counsel owns the wording and has not approved it.
- shows the price token's short address next to its symbol, and warns when it is not the project's recorded sale
  currency, because a token can call itself anything.
- before an offer or a bid is sent, says what it holds ("This holds N lots ... until the round settles"), that an
  order "may be filled in part, or not at all", and that bought Shares can vote only after about a week.
- under "Before you trade", lists five limits (exact text in `trading-copy.ts`, `tradingLimits()`): Shares held in a
  round do not vote and do not earn payouts until collected; bought Shares can vote about a week (7 to 8 days) after
  collection; for now these weekly rounds are the only way to sell Shares here; orders can be filled in part; and
  "The market's code has not had an outside security or legal review yet."
- under "How trading works": trading "moves existing Shares between people: it does not raise money for the project,
  and it does not promise a next buyer."
- on the listing vote form, shows "This market has not been independently reviewed. Do not trade with money you
  cannot lose." (a switch, `MARKET_REVIEWED = false`, that is flipped only at the release decision).

Known gaps in what the app says (section 6): the "How trading works" paragraph still says a buyer's money above the
price "comes back to them", while it in fact comes back only when the buyer collects it; the two disclosure blocks
are collapsed by default; the app does not say that one person can set a round's price (wash trades, section 6);
there is no fee sentence (deliberately, section 3). The text has not been reviewed by counsel.

---

## 2. What it deliberately is not

- **No minting.** The market has no function that creates Shares. A mint straight to the market reverts. A full-round
  test asserts total supply is unchanged (`test_a_full_round_mints_no_shares`).
- **No primary raise.** The market never sells Shares the project holds and never receives money for the project. It
  moves existing Shares between holders. The sale money goes to the sellers, not to the project treasury. Selling does
  not fund the project; the screens say so.
- **No fee in the candidate.** The fee is a constant of zero (`FEE_BPS = 0`); `test_the_zero_fee_leaves_every_unit_to_the_parties`
  asserts the DAO receives nothing. The older 20% premium cut of the frozen rounds contract is not carried over.
  This is a proposal (section 3), and the contract comment says the zero fee is "never a production promise".
- **No guaranteed liquidity, price or next buyer.** An order may not fill at all. A round that nobody settles in
  time is void. The price is whatever that round's orders produce, and one person using two addresses can set it
  (section 6, wash trades).
- **No custody by the operator.** Neither the person who runs the app, nor the person who runs the keeper, nor the
  launch kit, nor the factory holds anyone's Shares or money, can move them, or can pause collection. The only holder
  of escrow is the market contract, which has no owner and no administrator, and whose only privileged caller (the
  DAO) can switch listing terms but cannot touch escrow. The market is immutable: it cannot be upgraded.
- **No approvals to an operator.** The only approvals are those a user gives the market itself for the exact
  amount of their own order. The market grants no approvals to anyone.
- **No repair of the old rounds contract.** `contracts/src/WeeklyRounds.sol` has the defects in the D179 review. It is
  frozen, not repaired and, since D185, marked deprecated in a source comment; its code is unchanged. The new market is a
  separate contract and shares none of its code.
- **Not an exchange operated by the project.** There is no order book run by an operator, no matching done off-chain,
  and no custody. Matching is the contract's deterministic arithmetic, which anyone can run. Whether that matters
  legally is for counsel (section 7).

---

## 3. The proposed parameters

**These are proposals, not approved terms.** They are owned by the product owner. The agents did not change them, and
the review only reported where one might be unsafe or unclear. None has been approved for a real-money launch, and
none has been reviewed by counsel.

### 3.1 The three economic parameters

| Parameter | Proposal | Where | Alternative considered or raised in the review |
|---|---|---|---|
| **Fee** | Zero. A fixed constant; no fee is taken from sellers, buyers or the project. | `SecondaryMarket.sol` `FEE_BPS = 0` | The frozen rounds contract took a 20% cut of the premium over its floor; the specification says that is "not an approved default". A non-zero fee or a minimum order size would also raise the cost of the wash trades and slot-squatting described in section 6, but any such rule is the owner's choice and is not designed. The review also flagged that a UI sentence "No fee is taken" would read as a promise the contract comment disclaims; no fee sentence is shown. |
| **Voting maturity of bought Shares** | 7 days, rounded up to the next daily boundary, so a bought amount cannot vote for 7 to 8 days. Each bought amount ages separately. | `ActivationVoting.sol` (`EPOCH` one day, `MATURITY_EPOCHS = 8`); the app derives its wording from the same number and a test compares the two | The spec records that a post-vote lock on leaving "is a separate decision" and does not belong here. The review notes this parameter interacts with two open choices: the quorum denominator (a small mature minority can govern while a large new group cannot yet vote) and the fact that selling through the market sends the seller's oldest units first. No longer or shorter delay was evaluated in the repository. |
| **Founder sale schedule** | Zero waiting period then linear release over 180 days. It restricts only the founder's own *sales*; the founder can still leave (exit) with any Shares at any time. It is sale eligibility, not conventional vesting. | `ContributorKitV2.sol` and `ActivationVoting.configureSecondary`; the 180-day figure appears in the local fixture and tests, not as a minimum in the contract | The contract only requires a non-zero duration, so a launch could set a 1-second schedule and release the founder's whole grant immediately. Options logged for the owner: a minimum duration enforced in the kit, a minimum pinned at construction, or leave it free and always show the schedule on every screen. |

### 3.2 Other fixed constants (also proposals)

| Constant | Value | Note |
|---|---|---|
| Bidding window | 3 days | `BIDDING` |
| Settle window | 2 days, then the round is void | `SETTLE_WINDOW` |
| Rounds | At most one opening per 7 days | `EVERY`. The listing may be on and no round opened until someone calls open. |
| Orders per side | 32 sellers, 32 buyers, 1 order per address per side | Bounds the loops. Also lets someone fill the seats with cheap cancellable orders (section 6). |
| Price steps | At most 64 | |
| Founder-sale clock | Absolute (does not shift with sales) | |
| Market per project | Exactly one, created only by the launch kit | |

### 3.3 Parameters whose safety the review could not settle

- **No on-chain minimum for the founder schedule** (above).
- **Allocation among crossing orders.** The long side is shared in proportion to *stated* size, with no price
  priority, and over-ordering is free because unfilled escrow comes back. So someone who states a very large order
  takes lots from honest orders (an example is in `SECONDARY-TRADING-REVIEW.md` section 6). Options: keep and
  disclose, or add price priority or a per-order cap.
- **Free cancellation until the close** lets an actor fill all 32 buyer or seller seats and withdraw at the last
  second.
- **The price token is whatever the founder names** (the contract checks only that it has code).

---

## 4. Who operates what, and every key

Nothing is deployed, so this describes the design and the scripts in the repository, not a running organization.
The repository does not name a legal entity that will run the app, host the relay, deploy the contracts or hold any
key below. That is itself a question for counsel (section 7, questions 5 to 7 and 24).

### 4.1 The parts

| Part | What it is | Who runs it, as the repository describes it |
|---|---|---|
| **The contracts** | The V2 launch kit, the market factory, the per-project market, the voting policy, the Shares token and the DAO. | Deployed by whoever holds a deployer key. No deploy script for the V2 kit, factory or market exists for a public network: `sepolia-deploy.sh` and `DeployLaunchKit.s.sol` do not deploy them. Only `V5LocalFixture.s.sol` does, and it refuses to run unless the chain id is 31337 (a local test chain). |
| **The web app** | The page with the trading card. | Built and hosted by the operator. The build decides which chain and which market factory the page talks to. The hosted image does not name any market factory, so the card shows no trading there. |
| **The relay (server)** | The community server for posts, boards and notifications. It holds no chain funds. | The operator, on one rented server (the repository's setup notes describe a single OVHcloud machine). |
| **The keeper (optional)** | A small script that calls `settle` on closed rounds, and optionally `openRound`, so rounds are not missed. | Whoever runs it. It is not required: anyone can call both. |

### 4.2 Every privileged address or key

"Privileged" means: able to do something others cannot, or whose misbehaviour could hurt users. Test keys are listed
so nothing is left out.

| # | Address or key | Held by | What it can do | What it cannot do | Source |
|---|---|---|---|---|---|
| 1 | **DAO contract** of each project | Controlled by votes of that project's Shares holders; the founder alone at birth | Call `configureListing` on the market (publish, change, or switch off a listing). Award new Shares through the reviewed award flow within a yearly limit. Set a transfer validator on the Shares (ordinary transfers only). Announce unlocking of transfers (30 days' notice) or an exit exchange (30 days' notice). | Touch market escrow, change a live round, sell, take a fee, pause collection, or mint outside the award flow. Burn anyone's Shares (only a holder's own exit burns). Change the one-time settings made at creation. | `SecondaryMarket.sol:228`; `MolochPatched.sol` (`onlyDAO` functions) |
| 2 | **Founder wallet** | The person who launches the project | Chooses the quote token, lot size, sale schedule and first budget at launch. Holds every Share at birth, so can pass proposals alone. Can offer Shares as the schedule releases them. Can leave with any Shares at any time. | Offer Shares the schedule has not released. | `ContributorKitV2.launch`, `ActivationVoting.saleCapacity` |
| 3 | **Launch kit** (`ContributorKitV2`) | A contract; no key | At launch only: creates the DAO, token, policy and market in one transaction, and is the only caller the factory accepts. | Keeps no role after the launch, holds nothing, has no administrator. | `ContributorKitV2.sol`, `SecondaryMarketFactory.sol:134` |
| 4 | **Market factory** | A contract; no key | Creates a market, once per DAO, only after proving the DAO, Shares and policy against pinned code. | No administrator, no setters, holds nothing. | `SecondaryMarketFactory.sol` |
| 5 | **Summoner** (the DAO factory) | A contract; no key | Creates DAO clones. Each DAO can be initialised only by it. | The review passes reported no administrator role. `Summoner.summon` is public (anyone can create a DAO clone), which is why the market factory accepts only the kit. I did not read the Summoner line by line. | `MolochPatched.sol` |
| 6 | **Market contract** | A contract; no key | Holds escrow. Is the only address exempt from the Shares transfer lock. Calls two hooks on the voting policy to keep voting weight right. | Has no owner, no upgrade, no function to send funds anywhere except to an order's owner. Its 38 external entries (functions, public variables and constants) are pinned to a reviewed list (`test_the_market_abi_matches_the_reviewed_allowlist`). | `SecondaryMarket.sol` |
| 7 | **Voting policy** (`ActivationVoting` clone) | A contract; no key | Tracks which bought amounts may vote. One-time setup by the DAO in the creation block. Two hooks callable only by the project's market. | Cannot be reconfigured after the creation block. | `ActivationVoting.sol:269`, `:829` |
| 8 | **Deployer key(s)** for the kit, factory, summoner | Whoever deploys | Choose which code is deployed. After deployment the V2 contracts keep no deployer role in the code read. | Not applicable on a local chain. For a public chain this is undecided: no script exists. The Sepolia script uses `DEPLOYER_PRIVATE_KEY`, "a testnet-only key", and deploys the older kits, not the V2 kit. It deployed the frozen `WeeklyRounds` to Sepolia on 5 November 2026 and no longer does (section 8, item 18). | `scripts/sepolia-deploy.sh`, `DeployLaunchKit.s.sol` |
| 9 | **Keeper key** (`KEEPER_PRIVATE_KEY`) | The keeper operator | Pays the network fee to call `settle` and, only if enabled, `openRound`. | Nothing else: it holds no approvals, no Shares, no quote. The calls are open to anyone. The script does not print the key; it does pass it on the command line to a local tool, so it is visible to other users of the same machine. | `scripts/secondary-keeper.sh` |
| 10 | **Anyone** | Any address | Open a round (after a week), settle a closed round, trigger collection for any order. | Direct a payout anywhere but the order's owner. | `SecondaryMarket.sol` |
| 11 | **Quote token issuer or admin** | Whoever controls the token the founder chose | If the token can freeze, blacklist or pause, payouts in it can be blocked for an address or for all. Settlement, cancellation and Shares collection still work; only the quote payout waits (`test_a_blocked_quote_strands_no_payout`). | Not applicable to Shares. | The token's own code (not in this repository) |
| 12 | **Relay owner key** (`RELAY_OWNER_PUBKEY`; secret key kept offline by the operator) | The relay operator | Administers the community server (accounts, moderation, takedowns). | Has no chain power over any market, Shares or quote. | `deploy/compose/README.md` |
| 13 | **Server login and build settings** | The operator | Whoever can change the hosted page or its build settings controls what users see and which contracts the page talks to. A user signing through a changed page could be shown the wrong thing. This is a standard web trust point, not specific to this market. | Move escrowed funds directly. | `Dockerfile`, `deploy/ovh/README.md` |
| 14 | **Passkey-account service** (ZeroDev project id, API key, bundler URL) | A third-party provider and the operator's account with it | The app is set up so users can sign with passkeys and have fees covered. The provider can decline or delay relaying transactions. | The repository does not show it can move a user's funds; custody terms of that provider were not reviewed. | `Dockerfile` (`VITE_ZERODEV_*`, `VITE_BUNDLER_URL`) |
| 15 | **Local test keys** | Public Anvil development keys | Local test chain only. | Have no value anywhere else. The fixture refuses chain ids other than 31337. | `V5LocalFixture.s.sol`, `scripts/v5-local-fixture.sh` |

**What no key can do.** There is no key that can move users' Shares or quote out of the market, change a live round,
pause collection, or upgrade the market. This is by construction (no such function exists) and is pinned by tests
named in section 5, not by a promise.

---

## 5. What is built and tested, and the defects fixed in this run

### 5.1 What is built

| Piece | File | Lines (2026-11-05) |
|---|---|---|
| The market | `contracts/src/SecondaryMarket.sol` | 665 |
| Market factory | `contracts/src/SecondaryMarketFactory.sol` | 201 |
| Voting maturity, founder schedule, escrow accounting | `contracts/src/ActivationVoting.sol` | 835 |
| V2 launch kit | `contracts/src/ContributorKitV2.sol` | 365 |
| Frozen old rounds contract (not repaired, deprecated) | `contracts/src/WeeklyRounds.sol` | 632 (a deprecation comment added; code unchanged) |
| Trading card and listing form | `web/src/features/launchpad/ui/TradingCard.tsx`, `TradingListingForm.tsx` plus `TradingEarlier.tsx`, `TradingOrderForms.tsx`, `TradingHistory.tsx` | 671, 215, 255, 376, 129 |
| App data and wording | `use-secondary.ts` 165, `lib/secondary-read.ts` 426, `lib/trading-orders.ts` 112, `lib/trading-copy.ts` 1053, `lib/trading-history-copy.ts` 71, `lib/round-history.ts` 168, `lib/trading-offered.ts` 20, `chain-config.ts` 488; shared reader `packages/creaton-core/src/launchpad/secondary.ts` 796 | |
| Keeper and local scripts | `scripts/secondary-keeper.sh` 247, `web-trading-e2e.sh` 182, `v5-local-fixture.sh` 415 | |

### 5.2 Tests, with counts

Counts below are from commands run on 2026-11-05, after the low-severity batches; the commands are in
`V5-IMPLEMENTATION.md`, "Weekly-sales hardening: gate results" and "Low-severity run". "I ran" means the writer of this
revision ran it again at the final commit; "reported" means a gate run or a batch reported it and it was not re-run for
this revision.

- **Contract tests for the secondary suites** (`forge test --offline` over `Secondary*`, `ActivationVoting*`,
  `ContributorKitV2*`, `FounderSaleEligibility*`, `HoldingAge*`, `ExitExchange*`, `WeeklyRounds*`, `PayoutsMarket*`,
  `TransferLock*`; I ran it): **26 suites, 278 tests passed, 0 failed, 0 skipped.** The previous revision of this brief
  said 270; the increase is not attributed test by test here. The market's own tests run twice, once against a
  simplified stand-in for the voting policy and once against the real policy launched through the real kit.
- **Full contract suite** (fork tests excluded), reported by the final gate run: **80 suites, 882 tests passed, 0
  failed, 0 skipped** (the previous revision said 874). I did not re-run the full suite.
- **Mutation checks**: a script that removes one guard at a time from the contracts and requires a named test to fail.
  **261 entries**; its node test passes 62 of 62 and `--check` reports every entry well formed (I ran both). The one
  entry added in the low-severity run (the market's lot-size bound) was checked only for form: the script refuses to
  run on a dirty working tree, so it was not run live. The batch instead reverted the two bound constants by hand and
  saw the kit and market boundary tests fail. Earlier entries were run by their batches; I did not re-run all 261
  mutants.
- **App tests**: the full web unit suite, reported by the final gate run: **2,741 tests, 2,740 passed, 0 failed, 1
  skipped.** The two cancelled subtests that earlier revisions reported in `src/features/invite/accept-policy.test.mjs`
  were a defect in that test (a stand-in server that never answers, with nothing keeping the test's event loop open);
  it is fixed in `787f315` and no product code changed. The shared reader and decision package
  (`packages/creaton-core`) passed 963 of 963 (reported by a batch, at `a710d42`).
- **Browser tests against a real local chain**: `scripts/web-trading-e2e.sh`, 5 of 5 passed (a full round, a void
  round, a part-filled seller, a round where nothing crosses, keyboard and screen-reader use), reported by the final
  gate run; the pilot-build check `scripts/web-pilot-e2e.sh` passed **11 of 11** (the new eleventh asserts the Funds tab
  of a contributor project has no Trading element). Both needed `PW_CHROMIUM_PATH` here because the browser build
  Playwright pins is not installed.
- **Keeper**: `scripts/secondary-keeper-test.sh` (stubbed node and clock): all checks passed (I ran it);
  `scripts/secondary-keeper-e2e.sh` on a real local chain passed, including an unfunded keeper that exits 1 and signing
  from a keystore (reported by the keeper batch).
- **Script hygiene**: `scripts/test-e2e-script-hygiene.sh` (24 checks; runs the real scripts against a real local chain
  with stand-in browser and dev server; wired into the `mvp-gate` workflow) passed in its batch; the 13 port-probe checks
  added later passed in a scratch harness, and the whole script was not re-run after them. `scripts/test-mvp-gate.sh`
  passes except one check ("the chain the journey leaked is stopped") that fails the same way on untouched code in
  this environment. `node --test scripts/agreement-finalizer.test.mjs`: 40 of 40 (I ran it).
- **Local deployment**: `scripts/v5-local-fixture.sh` deploys the whole set on a scratch chain, reads every value back,
  and asserts the listing is disabled at birth; it passed on a local chain in the status-document batch. Its own
  self-test (`scripts/test-v5-local-fixture.sh`, 33 checks) passed in the batch that wrote it and was not re-run.
What the contract tests pin, by theme (names exist in `contracts/test`): escrow conservation under random order
flows (`SecondaryMarketInvariant`, rewritten; see section 5.4); exact clearing and the leftover rule; one reentry test
per entrypoint; a blocked quote token; unattributed deposits; stray ETH; exit-exchange independence, with a real
exchange that refuses transfers installed and replaced, and one cleared in the middle of a round, on the simplified
and the real policy; one test per factory provenance guard; the lot-size limit at its largest allowed value and one
above it, in the kit, the factory and the market; a fuzz over odd price-grid terms (the intake is paid out exactly on
any floor and step); the market's exact function list; the founder schedule; voting maturity; and the real-policy gas
ceiling (section 5.4).

### 5.3 Defects found and fixed before this run (internal review pass)

| | In plain words | Fixed by |
|---|---|---|
| F1 | Anyone could permanently burn a seller's proceeds by calling collect before settlement. | `test_a_sellers_proceeds_survive_a_pre_settle_claimQuote` |
| F2 | Leftover lots did not follow order number as documented, so transaction ordering could win a lot. | `test_leftovers_follow_order_id_after_a_cancellation` |
| F3 | The DAO could set a Shares transfer validator that froze sellers' escrow. | `test_a_dao_validator_cannot_freeze_the_markets_escrow` |

### 5.4 Defects found and fixed in this run, in plain words

Commit hashes are on branch `v4-governance-rework`. "Test" means the regression test that fails when the fix is
reverted, as reported by the batch that made it.

**Contract changes (code under review changed)**

- **Settlement could not fit in one transaction at full size (`9ce0656`).** Measured against the real voting policy,
  settling a full round (32 sellers, 32 buyers, 64 prices) cost 11.3 to 20.9 million gas, above the 16.8 million
  per-transaction cap (2^24) some networks enforce. A round that cannot be settled goes void (nobody loses funds,
  but nobody trades, and an attacker could make it happen on purpose). Fixed by moving the return of unsold Shares
  from `settle` to each seller's own collect. Re-measured: 2.4 to 3.6 million gas (at most about 21% of the cap).
  Tests: `test_a_part_filled_seller_claims_the_unsold_remainder_after_settle_exactly_once`,
  `test_an_unclaimed_remainder_survives_the_settle_window_and_the_next_round`, and the real-policy gas
  ceilings in `SecondaryMarketRealGas` (found in `532a793`). Consequence people should know: a seller's unsold Shares
  stay in the market, not voting and not earning payouts, until they (or anyone for them) collect.
- **Voting policy broke exit and transfers if not configured (`9b5ab7d`).** A project launched through the older
  entry point on the new kit address ended up with a half-built voting ledger; a fresh award holder's exit panicked.
  Fixed so an unconfigured policy behaves exactly like the older one. Tests in `ActivationVoting.t.sol` and
  `ContributorKitV2.t.sol`.
- **Market-held Shares were counted as payout units (`256ade0`).** Shares sitting in escrow earned a payout share that
  went to the market address with no way out. Fixed in `Payouts.sol`. Tests: `PayoutsMarket.t.sol`.
- **A second cancel of the same bid caused an arithmetic panic instead of a clear refusal (`a455a1c`).** Found by a
  strict fuzz walk. Test: `test_a_second_cancelBid_is_refused_as_no_order_not_a_panic`. The evidence does not show a
  loss of funds.
- **Agreement state reported "ready to settle" for every open claim on a real clock (`d108614`).** This is the
  agreed-rewards feature rather than trading, in the same branch. Tests in `ContributionAgreement.t.sol`.

**Tests that did not test what they claimed (fixed by rewriting)**

- **The two escrow invariants were empty (`4ff3f56`).** Every random call reverted, so the properties compared zero
  with zero. Rewritten to drive real orders; a canary fails the suite if no order is ever accepted.
- **The reentrancy test passed with the guard removed (`cae1342`).** Replaced by one test per entrypoint
  (`test_reentry_into_sell_is_refused` and six more); deleting any single guard fails its own test.
- **The counterfeit-DAO test used an address with no code (`b6ab248`).** Replaced by one test per factory guard
  (`SecondaryMarketProvenance`, `SecondaryMarketDaoPin`).
- **Nothing exercised the real policy under attack (`532a793`).** The adversarial, review and resolution suites now
  also run on the real policy; a deliberately re-ordered settle failed only the new test.
- **The "cleared or replaced exit exchange" tests never named an exchange (`680eaec`).** Now an installed exchange
  that refuses every transfer, and a replaced one, are tested
  (`test_claims_survive_an_installed_exit_exchange_that_reverts`,
  `test_claims_survive_an_exit_exchange_replaced_after_the_notice`, `test_void_round_claims_survive_a_replaced_exit_exchange`).
- **Several guards had no test (`9c2031d`, `8b2c09e`, `4d63a2a`, `071dcf9`).** Added tests and mutation entries for
  the bidding-window, settle-once, zero-levels, cancel-bid, quote-delta, accounting and kit read-back guards, and fixed
  stale entries.

**App and wording fixes**

- A holder's money or Shares in an *earlier* round had no collect button once a later round opened
  (`2b98a5e`, extended by `3369b99` to page back through older rounds, `5d14d62` for a part-filled seller's unsold
  remainder).
- A round that settled with nothing crossed was shown as "Settled at <lowest price> a lot" (`1c50b49`).
- The order forms could approve and then silently fail (huge lot counts, no Shares, no balance), and sent two
  separate steps (`ab8be71`): now checked first and sent as one batch where the account allows it.
- A listing vote was described in the wrong price scale (a 10^12 error) and any contract with the same function was
  described as a listing (`7989215`).
- The card disappeared on a failed refresh and a missing token name blocked collecting (`4333ac2`).
- Keyboard and screen-reader gaps (`f6cbda9`, `f1d720c`); plain-words refusals and a "Before you trade" list
  (`d949b1a`); earlier-rounds line and collect wording (`3084b5d`); the failure note survives a refresh (`2e307b2`);
  the price token's address shown and mismatch warned (`cb64d74`).
- Tooling: the local fixture hard-coded one developer's macOS path and left processes running (`b05ecc7`); the keeper
  gave up on opening rounds and counted a lost settle race as a failure (`e89fbd4`).
- Documents that overstated: the review packet described DAO-held "sale inventory" the code does not have and cited
  empty tests (`3c5895e`); the internal agent pass was called an outside review (`8c394b8`); founder-schedule, gas and
  vocabulary claims were aligned with the code (`fffd75d`).

### 5.5 Reviewed and found sound (the review's own words, not an audit)

The agent passes found no path by which the six D179 theft routes recur against the new market: a counterfeit DAO
cannot get a market; terms cannot name another project's Shares; there is no balance-difference payout; locked
Shares reach buyers only through an enabled listing, weekly, inside the window and within sale capacity; switching the
listing off cannot strand collection; the lowest step settles; stray ETH is irrelevant. These are read-and-test
conclusions by the same family of agents that wrote the code. They are exactly what an outside auditor should
challenge.

### 5.6 Low-severity fixes (the second run, the same day)

The owner chose high and medium severity first; the ten low-severity batches (B15 to B24) were run afterwards on the
same branch, with the same method (a fix, a test that fails when the fix is reverted, a note of what could not run).
A review of those commits then confirmed 11 points (2 medium test gaps and 9 low) and refuted one more; the confirmed
points were fixed in follow-up commits. **The follow-up fixes were not reviewed again: no delta review was run.** No
economic parameter changed and the run raised no new item for the owner (its needs-human list was empty). One contract
constant changed (the first row). Commits are on branch `v4-governance-rework`.

| Batch | In plain words | Commits |
|---|---|---|
| B15, kit and factory | One lot-size limit everywhere. The market and the V2 kit used to accept a lot size one above the largest the factory accepts, so such a launch passed the kit and then failed inside the factory with an unrelated error; all three now accept up to the largest number that fits in 128 bits and refuse one more (`SecondaryMarket.MAX_LOT_SIZE` changed from 2^128 to 2^128 - 1). Two kit comments were wrong and were corrected (the older launch is not "unchanged" on the V2 kit; a seller does approve the market), and the older kit's comment no longer claims a project's address cannot be taken first (anyone can make a DAO at a predicted address; the launch then fails and the founder retries with a new salt). A test launches through the older entry point on the V2 address and checks the project has no market, closed transfers, working award and exit. The web start flow now takes over a project found at its predicted address only if the DAO factory's log names the kit as its maker, and otherwise stops before sending or publishing anything; a node whose log trails its code is asked again (about eight seconds in all) before that refusal. | `bb5dbad`, `212afc2`, `6fbd706` |
| B16, Trading card | A live round now shows the terms it opened with (the listing's current terms are shown as the next round's); a round still open under a listing the DAO switched off no longer says offers and bids are taken; the card renders nothing in the contributor-only hosted build and in any build that names no market factory (a build naming a factory only for another network still shows "not set up on this network"). The refresh when the next-round time passes and the note saying why a button is off were already fixed earlier; the note is covered in the trading browser spec. | `d5a67fa`, `8e959f9` |
| B17, wording | Shares counts use correct singular and plural and enough precision for tiny lot sizes; times name their time zone; a standing line says trading does not fund the project, outside the collapsed blocks; buyer notes and the order plan lines were rewritten. Not added: any sentence about a fee (item 6 in section 8). | `a710d42`, `8e959f9` |
| B18, accessibility | "Try again" buttons no longer sit inside status text; the settle notice and the failed-refresh note are always-present polite regions that are empty until there is something to say. | `e4a5a42`, `8e959f9` |
| B19, exit exchange | Claims survive an exchange installed and then cleared in the middle of a round, and one replaced after the notice, using exchanges that try to pull Shares, on the simplified and the real policy; a kit-level test too. | `1556ef6` |
| B20, grid fuzz | A fuzz over odd price floors and steps checks that the intake is paid out exactly. The 64-step cap pin and the exact function-list test already existed. | `75ca683` |
| B21, keeper | The keeper exits 1 when a settle is refused (0 only if the round turns out to be settled); it signs from a keystore so no private key appears in the process list (the raw-key option remains and warns); a refused opening because the listing is off is benign; the exit paths of the one-shot mode are tested. | `dab2c8a`, `1862cf7` |
| B22, scripts | The trading and keeper journeys start their own chain on a checked port, build the web app honestly, and no longer refuse a port that is only in its closing wait state; a mistyped port number is reported as one. | `63d7967`, `77150fa` |
| B23, finalizer | `agreement-finalizer.mjs`: a retry exits 2 (never 0), usage errors exit 1, a locked journal 3, a malformed journal 9. | `bd1fdfd` |
| B24, documents | Status documents, gate counts and size figures refreshed; the flaky mention-list spec prints a trace when it fails. | `5e22ddc` |
| Review follow-ups | Every clause of the trading card's "differs from the live round" test is bound; the production check that a DAO was made by the kit has its own tests. | `105dbb9`, `212afc2` |
| Gate fix | The invite accept-policy test no longer outlives its event loop. | `787f315` |

---

## 6. What is NOT done

### 6.1 Not done, by kind

1. **No independent security audit.** The tests are the author's. No outside party has read the code.
2. **No jurisdiction-specific legal review.** No opinion exists on whether Shares are securities, whether the weekly
   sales are an exchange, brokerage or offering, or on any registration, exemption, disclosure, tax, sanctions or
   know-your-customer duty. The product copy and the questions in section 7 are unreviewed. Counsel's second-round
   comments (2026-11-06) are recorded in 7.1 as preliminary views; they are not an opinion.
3. **No human release decision.** The product's documents define the release decision as a person's act that is never
   bundled with a deployment. It has not been made.
4. **No human test of the changed behaviour.** The project's own checklist requires a person to try the changed flows.
   Agents drove them in a browser against a local chain; a person has not.
5. **The market is not deployed anywhere.** Not the V2 kit, the factory or the market, on any public or test network,
   and not hosted. (Corrected 2026-11-06: an earlier revision said nothing at all was deployed. The older frozen
   `WeeklyRounds` contract, deprecated since, has an unused copy on the Sepolia test network, section 8, item 18.) Shares on the Sepolia test network are
   test records with no value. All evidence about the market is from local scratch chains and unit tests.
6. **Trading is off by default** (a listing starts disabled, the hosted build names no market factory). That is
   configuration, not a legal or technical barrier a determined operator could not remove.
7. **No review of the latest fixes.** The ten low-severity commits were reviewed; the commits that fixed what that
   review found (`212afc2`, `1862cf7`, `8e959f9`, `105dbb9`, `6fbd706`, `77150fa`) were not. A delta review was not run.

### 6.2 Open engineering items

The low-severity batches (B15 to B24) that stood here as deferred were run and are described in section 5.6. What is
still open after them:

- **The V2 kit still exposes the older launch entry point.** It builds a project with no market and no way to get one
  (sealed, by design, and now tested and documented in the kit's comments). Making the V2 kit refuse it needs the
  pilot-kit decision (section 8, item 12), because the page encodes only the older launch call and a V2 kit named in
  the page's kit list would stop working.
- **The exit-exchange slot is not sealed**, so the two document lines that tie to it (the packet's section 6 and a
  comment in the market) are unchanged, and there is no test pinning that the old rounds contract stays attachable or
  is refused. Both wait for section 8, item 3, which item 18 now extends.
- **Card wording not done:** any sentence about a fee (item 6), and the wording of the round line near its close. Whether
  the card belongs in the default (non-pilot) build under D137 as against D180 was not examined. Browser specs for the
  default build were not run in the low-severity run (the trading spec and the pilot spec were, in the final gate).
- **Card tests pin source structure, not a mounted page**, because the component cannot be mounted in a plain node test.
  The new announcements were not traced in a real screen reader. The older-rounds paging is likewise tested as logic and
  wiring.
- **Keeper:** the keeper test is not run by CI (the new script-hygiene test is). The raw-key option remains because
  `cast` cannot take a key off its command line; the claim sweep, reading the `EVERY` constant and a chain-id allow-list
  were skipped as optional or refuted. The keeper test's BSD `sed` change could not be run on macOS and bash 3.2 was not
  available.
- **`agreement-finalizer.mjs`:** exit code 8 is declared but cannot be reached from the command line, and `retryJob`
  returns a promise in a note field (the command line does not use it). Both left alone.
- **Not confirmed fixed by this run's evidence:** focus after collecting from an earlier round lands on the current
  round's status line; one misplaced code comment in the browser test.
- **Unverified here:** the repository's file-size check could not run (it needs a local `origin/main` reference this
  clone does not have). `forge build --sizes` exits non-zero because two *test* helper contracts exceed the creation
  size limit (`FakeV3Policy` 49,419 and `KitDeployProbe` 60,408 against 49,152); no deployed contract does. Solidity
  formatting (`forge fmt`) is not enforced; at the final gate it differed in 9 of 32 source files and nothing was
  reformatted. Fork tests (Sepolia fork, mainnet fork) were excluded, and the whole `just ci` and the desktop and mobile
  surfaces were not run. The new mutation entry was not run live (above), and the trace added to the flaky mention-list
  spec has not been seen on a real failing run. Measured gas depends on a Foundry cheat code and on two storage slot
  numbers the test reads; the test fails loudly if a layout changes, but the figures are not chain measurements. The cap
  itself is chain-dependent.- **Known design limits, stated rather than fixed:** a free cancellable order can occupy a seat (32 per side); an
  order's size can be overstated at no cost; a bid can move the price and be pulled in the last second; one person
  using two addresses can set a round's price and print it; Shares held in escrow cannot exit or vote while there
  (about five days at most for a sold or void order, and for unsold Shares until someone collects them, which has no deadline); the quote token is unvetted; a quote token that blacklists the market
  delays quote payouts.

### 6.3 Dependencies outside this repository

The quote token's own code; the passkey-account provider; the Foundry and Solidity toolchain versions pinned in the
repository; the underlying DAO framework (a patched Moloch/Shares fork) whose patches are checked by a policy script
(`check-majeur-fork`), not independently audited.

---

## 7. Questions for counsel

Each is stated so it can be answered "yes, no, or only if X".

**Order of work (a proposal, following counsel's second-round advice).** First the owner decides where the market
may be offered (7.0, which is question 20). Then counsel answers questions 5 to 7 (issuer, intermediary, DevCo split),
because every other answer depends on who the regulated person is, if anyone. Then the rest.

### 7.0 Decision for the owner before counsel is engaged: where may the market be offered (question 20)

**What exists today.** Nothing limits who can use the market. The contract has no allowlist, no identity check and no
country check (section 1.3). A search of `web/src`, `deploy` and `docs/policies` for geofence, geoblock and country
found no check in the web app; the only hits were two policy drafts. The card is off in the hosted build because the
image names no market factory (section 5.6, B16), which is configuration, not a country limit.

**The options** (the owner's choice; each changes which later questions are live):

| Option | What it means | What it does to the questions |
|---|---|---|
| (a) Test network only | No real value anywhere. This is the pilot today. | Sections 7.2 to 7.4 stay dormant, but they must be answered before this option changes. |
| (b) United States only, including Puerto Rico | Everyone else excluded, and the exclusion has to be built (page, and a decision on question 18). | Takes the EU questions (26 to 30) out of the first opinion; keeps questions 1 to 17 and 31 to 34 (US parts). |
| (c) United States and United Kingdom | As (b) plus the UK. | Adds a UK review that this brief has not set out. |
| (d) United States and named EU member states | As (b) plus the countries named. | Makes 7.2 live in full, and the EU part of 7.4. |
| (e) Open to everyone except sanctioned places | The posture the contract has today. | Every question is live in every place. Nothing has been designed for it. |

**Proposal (labelled as one, not advice).** Stay at (a) until counsel has answered questions 5 to 7. Then name one
value-bearing target, and the smallest is (b): it keeps the MiCA question written down (7.2) without making it the
first thing counsel must close. Whoever enforces the exclusion (question 20, second half) is a separate decision that
this option list does not settle.

### 7.1 Counsel's preliminary views (second round, 2026-11-06)

**How to read this.** These are counsel's comments as relayed to the author in condensed form. They are counsel's
preliminary views. They are not a formal opinion, they are not this brief's conclusions, and nothing in sections 1 to
6 was changed to fit them. The brief does not turn any of them into final text. Counsel also asked that the instruction
in the preamble, never to describe the internal review as an audit, stay as written; it is unchanged.

- **Classification.** Counsel's preliminary view is that work-earned Shares are the strongest defence under the Howey
  test, and bought Shares the weakest (money goes in, the buyer is exposed to the treasury, and there is a resale
  venue). The two facts counsel thinks cut hardest toward a security are the resale market and the treasury exit right
  tied to others' continued work. Counsel's preliminary view is that "no dividend, no fee, and the sale money goes to
  the sellers" does not close the question.
- **The market as an exchange.** Counsel's preliminary view is that non-custody and non-discretion narrow the exchange
  analysis, but that definitions on both sides of the Atlantic do not obviously require an operator. Responsibility
  would follow whoever hosts the page, runs the keeper, or deploys and curates the kit.
- **Order.** Counsel asked that questions 5 to 7 be answered first, because every other answer depends on who the
  regulated person is, if anyone.
- **Gaps counsel named.** No EU crypto-asset question (now 7.2). No money-transmission question (now 7.3). Tax reporting
  stopping at holders, with no question on the platform as a payer (now 7.4). Two go-live conditions (section 8,
  items 18 and 19).
- **Counsel's preliminary view on the order of work before any real money:** the securities opinion on this brief, with
  the MiCA gap closed first; the exit-exchange slot sealed; and the platform-as-payer tax question answered. Before the
  pilot itself, the points in counsel's list for the policy drafts apply; they are outside this brief.

### Questions

**Classification**

1. Are the project's Shares, as the code defines them (a vote on the project's DAO and a pro-rata right to leave with
   a share of the treasury, with no dividend), securities, investment contracts or another regulated instrument in the
   United States (including Puerto Rico), and in each other place the product will be reachable? Does the answer
   depend on whether the project has a treasury, on what the treasury holds, or on whether the project is described
   as a work collective?
2. Does the answer differ between the founder's Shares, Shares earned as a reward for work, and Shares bought in a
   weekly sale?
3. Are the weekly sales themselves "securities transactions"? The sellers are existing holders; the project receives
   nothing and takes no fee. Does that bring the sales within a resale exemption, or does it still involve an issuer
   offering, a broker, an exchange, or an alternative trading system?
4. Does a single-price auction run by public contract code (matching done by arithmetic anyone can run, no operator
   discretion, no operator custody) change the analysis for exchange, broker or marketplace registration, compared
   with an operator-run order book?

**Who is the issuer and who is the intermediary**

5. Who is the "issuer" of the Shares: the founder, the DAO as a collective, the entity that built the launch kit, or
   no one? Who is the "intermediary", if any: the person who hosts the web page, the person who runs the keeper, the
   person who wrote the contracts, or the deployer?
6. Which of those people would be regulated by the roles in the answer to 5, and what do they need to do or avoid
   (for example, not host the page, not charge a fee, not select projects, not curate)?
7. What changes if a technology company ("DevCo") builds and hosts the product while a separate non-profit foundation
   owns the contracts, holds the keys in section 4, or runs the keeper? Which roles move to which entity, and does a
   split help or hurt?

**US persons and Puerto Rico**

8. If US persons, or people in Puerto Rico, may be sellers, buyers or founders, what registration, exemption, filing,
   legend, holding-period or resale rule applies to Shares sold to them or by them?
9. Is there a different answer for Puerto Rico because of local securities law, or tax incentives that interact with
   token income?
10. Is the founder's receipt of Shares at launch, and Shares awarded for work, taxable or reportable events, and does
    the product need to produce any tax or information reporting?

**Transfer restrictions and resale**

11. The Shares cannot be transferred at all except through the weekly market, and the founder's own sales are
    restricted by a 180-day proposal. Does that make the Shares "restricted" in the legal sense? Does a legend, a
    notice or a holding period need to appear on the screen where the Shares are acquired?
12. The founder can always exit (leave with a pro-rata share of the treasury) even with Shares the schedule has not
    released for sale. Does that undercut the restriction in a way a regulator would care about, and must it be
    disclosed prominently?
13. A buyer's Shares cannot vote for 7 to 8 days and cannot be sent to others, only offered in a later weekly round.
    Does that affect the classification or what has to be said?

**What the interface may show, and to whom**

14. What may the trading screen show about prices (a "settled at" price, a round history, a "last price"), and what
    must it say alongside it, given that one person with two addresses can set a round's price?
15. May the screen describe Shares as ownership, as a claim on the treasury, or as a vote, and what wording is
    forbidden (for example "investment", "return", "liquidity")?
16. Is the current copy ("trading moves existing Shares between people: it does not raise money for the project, and
    it does not promise a next buyer", the five limits, "has not had an outside security or legal review yet") enough
    as a risk disclosure, too much, or itself risky? Where and how prominently must it appear (the two blocks are
    collapsed by default)?
17. May the app show the trading card to people who are not holders, or only to holders? May it show it before
    sign-in?

**Geofencing and eligibility**

18. Is geofencing the web page enough, or must the contracts also restrict who may bid or offer? Today the contract
    has no allowlist and any address can bid; anyone can also call the contract directly without the page.
19. Do sanctions screening or know-your-customer checks apply to the operator who hosts the page, to the keeper
    operator, or to sellers and buyers? If so, at which point (sign-in, first order, each order)?
20. Which countries or categories of person must be excluded, and who is responsible for enforcing it? (The owner
    decides the target list first, with the options in 7.0; this question then asks what that list requires.)

**Record keeping and disclosures**

21. What records must be kept of rounds, orders and collections, by whom, and for how long? (The chain is public and
    permanent; the app also stores nothing about orders beyond what is on the chain.)
22. What disclosures must exist before a project publishes a listing (the "market-opening summary" in the
    specification), what must the founder disclose about their own schedule and holdings, and who is liable if a
    project's page is inaccurate?
23. Must a project give notice before it publishes a listing, as it must give 30 days before unlocking transfers? The
    market is exempt from the transfer lock from birth, so it does not today.
24. If the quote token is a stablecoin issued by a third party, does its issuer's status affect who is involved? If
    the founder may choose any token, does the founder or operator owe vetting duties?
25. The product copy and docs call the DAO's treasury exit "leaving" and the Shares "ownership". Is that terminology
    acceptable, or does it need to be changed across the product?

### 7.2 EU crypto-asset and anti-money-laundering rules (MiCA and AMLR)

Added after counsel's second round, which found this missing. Whether EU users are in scope is an owner decision (7.0,
options (d) and (e)); this section sets out the facts counsel needs and asks the questions. This brief does not
interpret either regulation.

**Counsel's preliminary view (not an opinion).** If EU users are in scope, operating a venue that brings together
multiple third-party buying and selling interests in crypto-assets is a crypto-asset service provider (CASP) service
that needs authorization, and the no-operator-custody posture does not obviously exempt it.

**The facts, with sources.**

- *Who hosts the page.* The operator, on one rented server (`deploy/ovh/README.md`, `deploy/compose/README.md`). The
  hosted image names no market factory, so it shows no trading (section 5.6, B16).
- *Who runs the keeper.* Whoever chooses to run `scripts/secondary-keeper.sh`. It is optional, and the repository
  names no one (section 4.1). Anyone can call `settle` and `openRound`.
- *Who deploys.* Whoever holds a deployer key. No public-network deploy script for the V2 kit, factory or market exists
  (section 4.1, 4.2 row 8). That entity is undecided.
- *Who deploys and curates the kit.* The kit is a contract with no key (`ContributorKitV2.sol`). A founder launching a
  project chooses the price token, lot size and sale schedule, and the project's DAO decides whether to publish a
  listing (section 4.2, rows 1 and 2). Which kit addresses the page offers is a build setting of the operator
  (`VITE_CONTRIBUTOR_KITS`, `deploy/compose/.env.creaton.example`). I did not check whether any project is selected or
  promoted on the Discover pages (`web/src/features/discover`), which counsel's list of "curates" may reach.
- *What the contract does.* It takes Shares and the price token into escrow, computes one price by arithmetic anyone
  can run, lets anyone settle, and pays each order's owner only (sections 1.4, 1.5; 7.3 below). Shares cannot move
  between holders except through it while transfers are locked (section 1.3), so it is the only place they are traded.
- *What the contract does not do.* It takes no fee (`FEE_BPS = 0`, `SecondaryMarket.sol:80`), has no owner or
  administrator, holds nothing for the operator, and has no allowlist, identity check, sanctions check or country check.
  Nobody screens buyers or sellers at any point.
- *The price token.* It is whatever token the founder names (section 3.3). It may be a stablecoin issued by a third
  party. Whether that brings its own rules was not examined.
- *What was not checked.* Any text of MiCA, of the AMLR or of the EU's transfer-of-funds rules, and whether the Shares
  are a crypto-asset under MiCA or a financial instrument under the EU's markets rules.

**Questions.**

26. Are the Shares, as the code defines them, a crypto-asset within MiCA, or a financial instrument that takes them
    outside it (and into the EU's trading-venue rules instead)? Does the answer differ between work-earned, founder
    and bought Shares (question 2)?
27. If MiCA applies and EU users are in scope: is the weekly market an operation of a trading platform for
    crypto-assets, and who is the provider (the page host, the keeper operator, the deployer, the kit's author, or
    no one)? Does non-custody or the absence of operator discretion change the answer for any of them?
28. If a CASP service is involved, what does authorization require of this operator, and what is the smallest
    arrangement that avoids needing it (for example, excluding the EU under option (b) or (c), and how that exclusion
    must be done for it to count)?
29. Does admitting the Shares to trading on the market bring any white-paper or admission duty, and on whom? Does the
    founder's choice of price token bring any duty because of the token's own status?
30. Do the EU's anti-money-laundering rules (AMLR) make anyone here an obliged entity, with customer checks, and from
    what size or point (sign-in, first order, each order)? What does the operator owe if it is not an obliged entity but
    hosts the page?

### 7.3 Money transmission

Counsel's preliminary view (not an opinion) is that, because the escrow moves price tokens peer to peer, is
non-custodial and pays only an order's owner, the market is likely outside money transmission, but that the paymaster
fee-sponsorship arrangement deserves one line of analysis.

**The escrow facts, read from `contracts/src/SecondaryMarket.sol`.**

- A bid moves exactly `lots x limit price` of the price token from the bidder into the market contract
  (`bid`, line 302; `quote.safeTransferFrom(msg.sender, address(this), escrow)`, line 312). The amount received is
  checked, so a token that skims a fee is refused (section 1.4).
- `settle` makes no token transfer. It records fills (the function's own comment, around lines 372 to 380).
- The only transfers out of the market are to an order's owner: `claimQuote(id, who)` pays `who` the proceeds of
  that one order or the refund of that one bid (`quote.safeTransfer(who, amount)`, line 476); `claimShares` pays `who`
  Shares (lines 414 to 440); `cancelSell` returns Shares to the caller (line 349). `claimQuote` and `claimShares` can
  be called by anyone, and the money or Shares go to the order's owner, never the caller. Each amount is bounded by
  that order's own escrow and the round's own ledger.
- There is no function to send the price token to any other address, no fee, and no owner or administrator. The exact
  external function list is pinned by `test_the_market_abi_matches_the_reviewed_allowlist` (section 4.2, row 6).
- The operator is not in the flow. If the price token's issuer can freeze or block, a payout waits (section 4.2, row 11);
  nothing the operator does can redirect it.

**The paymaster, from the repository.** Passkey accounts send through a ZeroDev paymaster that pays the network fee
(`web/src/features/identity/lib/sponsoredSender.ts`, header). On Sepolia the fee is paid under a gas policy on a ZeroDev
project the operator holds, set to sponsor every operation with a spending limit (`docs/sepolia-testnet.md:122`); when
that limit is spent the paymaster refuses and the app says so (`docs/error-reporting.md:50`). The paymaster pays the
network fee only. The repository does not show it can move a user's price tokens or Shares (section 4.2, row 14), and
custody terms of that provider were not reviewed. On Sepolia the fee is paid in test ETH, which has no value. Who would
fund the policy on a value-bearing network is not decided anywhere in the repository. Whether sponsored operations would
include market orders was not traced; the order forms take the same sender type
(`web/src/features/launchpad/ui/TradingOrderForms.tsx:30`), and the pilot policy is described as sponsoring every
operation. The keeper's own fee is paid by the keeper's key (section 4.2, row 9) and is not sponsored.

**Questions.**

31. Is a non-custodial market that escrows the price token in a contract and pays only an order's owner outside
    money-transmission and similar licensing, in the United States (including Puerto Rico) and in each place chosen in
    7.0? Does anything in section 4.2 (the factory, the kit, the keeper) change that?
32. If the operator funds network fees for users' market orders through the paymaster, does that make the operator a
    party to, or a facilitator of, each transfer, or a subsidiser of traders? Would it change the intermediary analysis
    in questions 5 and 6, and should fee sponsorship be excluded from market orders?

### 7.4 The platform as a payer (real-money terms worklist)

Counsel's second round noted that tax reporting in this brief (question 10) stops at holders. When real money arrives
the platform may itself be a payer with reporting duties of its own.

**What is known.** The operator pays no one today. The terms draft says the service does not yet pay anyone money and
that Shares cannot yet be sold or bought through it (`docs/policies/TERMS-DRAFT.md:56`); the policy response table says
the same and requires separate real-money terms first (`docs/policies/LAWYER-FEEDBACK-RESPONSE.md`, point 12). In the
pilot the only reward a project can award is Shares, which have no value on a test network
(`docs/policies/TERMS-DRAFT.md:60`). The bounty contracts exist on Sepolia and are paid in Circle's test USDC
(`contracts/script/DeployLaunchKit.s.sol:135`); the money in them is posted by others, and the operator does not hold
or send it. The market takes no fee and the operator receives no sale money (section 2).

**Questions to add to the real-money terms worklist.**

33. In the United States, when contributors are paid in money or in Shares that have value, is the platform (the
    operator, or a DevCo in question 7) a payer with information-reporting duties (for example the 1099 family of
    forms), or only the project or the DAO? Does the answer change if the platform hosts the page but never touches
    the money, or if a contract the platform deployed makes the payment?
34. In the EU, does the crypto-asset reporting regime (DAC8) put a duty on the platform or on anyone else here, and from
    what point (first user, first transfer, a threshold)? Does it matter whether the platform is a CASP at all (7.2)?
35. Are Shares awarded for work, and Shares bought and sold, reportable by anyone other than the holder, and is
    anything the app can show a holder (for example their history of orders and collections) needed to meet that duty?
    Question 10 asks the holder-side version.

### 7.5 The worklist these questions join

The real-money terms worklist is the one in `docs/policies/LAWYER-FEEDBACK-RESPONSE.md` (point 12: employment, tax,
consumer rules, age). Questions 33 to 35 are to be added to it by the owner (section 8, item 20). That file is outside
this brief and was not edited.

---

## 8. Open items the owner must decide

These come from the review's "needs a human" list. None was changed by the agents. Each shows the options the review
recorded. The low-severity run raised no new item; it touched items 3, 6, 12 and 14, which are annotated below. Items
17 to 20 were added on 2026-11-06 after counsel's second round; items 18 and 19 are counsel's two go-live conditions
for any value-bearing network.

1. **Which tokens may be a market's price token.** Today any contract with code works, and the page prints whatever
   name the token gives itself (the page now also shows its short address and warns when it differs from the sale
   currency, but not when the project has no recorded token sale currency). Options: pin one vetted token (or a short
   list) at launch; require it to equal the project's sale currency; leave open and warn; accept founder trust.
2. **Floor for the founder's sale schedule** (section 3). Options: minimum duration in the kit; minimum fixed at
   construction; leave free and always display it.
3. **Whether the old rounds contract may still be named as an exit exchange.** Options: seal the exit-exchange slot
   at birth for new-flow projects; leave it and document that the old contract must never be deployed on a value-bearing
   network; either way add a test. Still open: the low-severity run added exit-exchange tests but did not seal the slot
   or pin either outcome. Update 2026-11-06: the owner deprecated the old contract on our side (D185); that does not seal
   the slot, which stays open for counsel (section 8, item 18).
4. **Order caps and seat squatting.** Options: accept and state; minimum order size; refundable seat bond; let a
   larger order displace the smallest. Any of these is an economic rule.
5. **Allocation rule and size inflation.** Options: keep proportional sharing and document; price priority with
   rationing at the margin; a cap on order size relative to the round; largest-remainder rule for leftovers.
6. **Wash trades and the "settled at" price.** Options: copy that says one person can set a round's price; reject an
   address that both offers and bids in a round (does not stop two addresses); show no price history (the owner chose to
   show it, with the label: section 8, item 19); a non-zero fee
   or minimum order (a change to the owner's fee parameter). Also: whether to say "no fee" on screen (conflicts with
   the contract comment that zero is not a production promise). The low-severity run added no sentence about a fee.
7. **Quorum floors that exceed eligible supply.** A proposal opened in a dip of eligible voting supply can be
   unpassable until supply recovers. Options: cap the floors in the voting policy; strengthen the warning; accept.
8. **Which Shares leave first when selling through the market.** The market sends a seller's oldest (most mature)
   Shares; ordinary transfers and exits send the newest. A holder with old and new Shares who sells can end up unable
   to vote for about a week. Options: disclose; switch to newest-first (a contract change).
9. **Quorum when most voting supply is new.** The quorum is a share of *eligible* supply with no floor, so a small
   mature minority can govern while a large new group cannot yet vote. Options: add a floor tied to outside supply;
   change the delay or review times (parameters you own); accept and disclose.
10. **Listing notice period.** Publishing a listing takes effect at once, unlike unlocking transfers (30 days).
    Options: add an announce step; or record that the market needs none because it is exempt from birth.
11. **Agreement review deadline.** An approved agreed-reward attempt can expire one second after its review deadline
    because the expiry ignores a standing approval. Options: refuse expiry when approval stands; settle on the
    approving vote; keep and document.
12. **Which launch kit pilots use.** The page's contributor flow still encodes the older launch call, and the local
    fixture's kit is the V2 kit. Options: keep the older entry point on V2 and fix wording; make V2 refuse it and add a
    V2 launch call to the page; keep pilots on the older kit. After the low-severity run: the page refuses to adopt a project at its predicted
    address unless the kit made it, and the older launch on the V2 address is tested and documented as making a
    sealed project with no market; the V2 kit still accepts that call.
13. **Command-line support for agreements and markets.** The command-line tool has no commands for agreements,
    listings or the market, so agents cannot use these flows. Options: build them before agents join the pilot, or
    record that agents stay on the web path.
14. **Whether the pilot build may show an inert "Trading" card.** Today the hosted pilot build renders a card
    saying trading is not set up. Options: hide it where no market factory is named; hide it in the contributor-only
    build; keep it and add a test that it offers no actions. Status: the first option was applied in `d5a67fa` (the card renders
    nothing where no market factory is named and in the contributor-only build), with a pilot browser test; it stays
    your call whether to keep that.
15. **Settle capacity.** The settle fix (section 5) keeps 32 sellers per round. Remaining options if the owner wants
    more headroom: lower the cap, or make settle resumable.
16. **Whether to silence or soften the price-token mismatch warning** for projects with no recorded token sale
    currency (the warning is silent there).
17. **Where the market may be offered (question 20), decided first.** The options and a proposal are in 7.0: (a) test
    network only, (b) United States including Puerto Rico only, (c) United States and United Kingdom, (d) United States
    and named EU member states, (e) everyone except sanctioned places. Proposal: stay at (a) until counsel has answered
    questions 5 to 7, then name (b) as the first value-bearing target. This is the owner's decision; counsel's second
    round asked that it be made before counsel is engaged, and the EU questions in 7.2 stay dormant or become live
    according to it.
18. **Go-live condition 1: the frozen `WeeklyRounds` and the exit-exchange slot (extends item 3). The old contract is
    deprecated on our side; sealing the slot is still open for counsel.**
    *Counsel's preliminary view:* the slot must be sealed, or the defective contract made undeployable on a value-bearing
    network, so that naming a contract known to have theft defects is impossible, not prevented by process.
    *The owner's decision (2026-11-06, D185): deprecate the old contract on our side, until counsel confirms that is
    enough.* What that means, in this repository:
    - **Not deployed.** `DeployLaunchKit.s.sol` no longer deploys it and the manifest has no `weekly-rounds` role;
      `scripts/dev-chain.sh` and `scripts/sepolia-deploy.sh` no longer deploy, check or print settings for it (`4d90bb1`).
    - **No card.** The old weekly-rounds card on a project's Funds tab, its decision form, its settings (`VITE_WEEKLY_ROUNDS`)
      and its journey test were removed from the web app and the core package (`34353a7`). The hosted image never had them.
    - **Source kept, marked deprecated.** `contracts/src/WeeklyRounds.sol` has a deprecation comment at the top and no code
      change. Its tests and the audit record `WEEKLY-ROUNDS-AUDIT-2026-11-01.md` stay until counsel confirms deprecation
      is enough. The exit-exchange and funding-terms tests still use it as the one real live exchange.
    - **The Sepolia copy is unused.** `0xE684Bb57c31Faa4b8e854DAB9d141D06144899A2` (block 12072551, manifest
      `contracts/deployments/dao-launch-kit-11155111.json`, committed in `7d915f2`) stays on the chain, because a chain
      cannot be edited, and stays listed in that manifest as history. Nothing points at it. It pays in Circle's test USDC
      (`DeployLaunchKit.s.sol:135` names that token), so the value at risk on that network is nil.
    - **What this does NOT do.** It does not make the exit-exchange slot unable to name a copy of the contract deployed
      by someone else. `announceExitExchange(address)` (`contracts/src/majeur/MolochPatched.sol`, line 1679) still accepts
      any non-zero address, and anyone can switch it on 30 days later (`activateExitExchange`, line 1688). No test pins
      that the old contract is refused. Deprecation removes our own routes to it (script, app, documents). It is not a
      barrier in the contracts, and counsel's view is that process is not enough.
    - Freeze: the Forge script's header now says D174 lifted the contract freeze for development and that dropping the
      contract from the script was the owner's decision (D185). A comment in `scripts/sepolia-deploy.sh` (lines 22 to 25)
      still calls that Forge script frozen with the contracts (D137); it was not changed.
    *Options for what is left* (counsel and the owner decide):
    1. **Seal the exit-exchange slot at birth for new-flow projects** (a contract change: the V2 kit makes the slot
       permanently unusable, so no DAO made that way can ever name any exchange). This is the only option that makes
       naming impossible, for the old contract and for any copy of it. The market does not need the slot (it uses the
       transfer exemption, section 1.3). Projects created before the change keep the slot they were made with. Needs a
       test that pins the refusal, a mutation entry, and the pilot-kit decision in item 12. **This option stays open.**
    2. **A chain-id guard in `DeployLaunchKit.s.sol`.** No longer needed: the script does not deploy the contract at all.
    3. **A chain-id guard in the `WeeklyRounds` constructor** (a change to a frozen, deliberately unrepaired file): the
       repository's source then cannot be deployed on a value-bearing chain by any route. A modified copy still can.
    4. **Deprecate and document it** (today's state). Counsel's preliminary view is that this is not enough by itself.
    *Recommendation (a proposal, the owner decides):* option 1 before any value-bearing network, with its test. Deprecation
    is the interim step, already taken. Not option 3 or 4 alone.
19. **Go-live condition 2: the wash-trade price (question 14, extends item 6). The owner chose to show price history on
    the weekly sale, with the permanent label. It is built.** One person using two addresses can set a round's price
    (section 6.2), and a screen that prints a self-dealt price is, in counsel's words as relayed, a standing manipulation
    exhibit.
    *Counsel's preliminary view:* resolve it conservatively: no price history, or a persistent label that one person
    can set this price.
    *The owner's decision (2026-11-06, D185):* show price history on the weekly sale, with the label below wherever a
    price is printed (the label route counsel named, built first in `4c132a0`, extended to the history in `9eecfcb`).
    *The label, exactly* (`priceSetterLine` in `web/src/features/launchpad/lib/trading-copy.ts`, line 217, shown by one
    plain paragraph component, `PriceSetterNote.tsx`): "One person can set a round's price. An account can sell and buy
    in the same round, and one person can hold more than one account." It is visible text, not collapsed, not a tooltip
    and not dismissible, and it says what the market allows (section 6.2) and nothing about what a price means or is
    worth. **Counsel owns the wording. Counsel has not approved it.** It is the builder's draft.
    *Where it appears.* Two places, both on the Trading card on the project's Treasury tab:
    1. Under the latest round's line "Settled: N lots traded at P a lot, after offers closed ..." (`roundLine`,
       `trading-copy.ts` line 222, called at `TradingCard.tsx` line 461; the label at line 473, only when `roundShowsPrice`,
       line 206, is true: a settled round that matched lots).
    2. Once under the "Earlier rounds" list (`TradingHistory.tsx`: each row from `earlierPriceRow`, line 66; the label at
       line 84, whenever any row prints a price).
    The old weekly-rounds card, which also printed a last trade and a history table, is gone (item 18), so it carries no
    label because it does not exist. "How trading works" (collapsed by default) still does not say it (section 1.7);
    the label does not depend on it.
    *The earlier-rounds list exists now.* It shows rounds before the latest, newest first, in blocks of 12 with a "Show
    older rounds" step (`round-history.ts`, `trading-history-copy.ts`, `use-secondary.ts`). Each row has the opening date
    with its time zone, then "N lots traded at P TOKEN a lot", or "No trade" for a round nobody settled or where nothing
    crossed (no price is printed for those). A failed read says "Could not load earlier rounds. Try again." with a retry,
    so a failure is never shown as an empty history. There is still no chart, candle line or last-price headline on the
    V2 market card.
    *Where no weekly price prints:* the listing form and the order forms (`TradingListingForm.tsx`,
    `TradingOrderForms.tsx`) show the price range and the prices a person types, which are not trades;
    `TradingEarlier.tsx` prints what a holder can collect, not a round price; `web/src/features/launchpad/lib/candles.ts`
    draws candles from the bids people recorded for a primary sale (bid prices, not trades) and feeds `SalePriceCard.tsx`
    and `PostContent.tsx`, not the market. `MARKET_REVIEWED` (`trading-copy.ts`, line 613) is not a price: it is the
    switch behind "This market has not been independently reviewed. Do not trade with money you cannot lose." on the
    listing form, and it stays false until the release decision.
    *What enforces it.* `web/src/features/launchpad/ui/priceLabelContract.test.mjs` (4 tests, passing) lists the two
    price printers (`roundLine`, `earlierPriceRow`) and the two screens that call them, and fails if a new screen calls
    a printer without the label, if the label is hidden or turned into a tooltip, or if the sentence is repeated outside
    `trading-copy.ts`. The builder reports that removing the label from the list failed two source tests. Not pinned: a
    new price printer with a different name, or a chart, would not be caught by that test.
    *Options as they stood:* (1) no price history and no printed price; (2) a persistent label wherever a settled price
    prints, **chosen**; (3) keep the price and the collapsed explanation (counsel: not conservative); (4) change the
    economics with a fee or minimum order (an owner parameter, not a screen fix; not done).
    *Still open:* counsel's approval or rewording of the sentence; counsel's confirmation that showing history with this
    label meets the condition; and, if counsel prefers, a return to option 1. Plain words follow `PLAIN-WORDS.md`
    (section 4: do not weaken a disclosure, add no hint of returns).
20. **Add the platform-as-payer questions to the real-money terms worklist** (questions 33 to 35 in 7.4). The worklist is
    in `docs/policies/LAWYER-FEEDBACK-RESPONSE.md` (point 12). Options: add them there now; or hold them until the
    jurisdiction list (item 17) is chosen. Recommendation (a proposal): add them now, since counsel asked for them and
    the pilot pays no one, so nothing changes today. The operator-side answer (does the platform pay anyone) is "no" in the
    pilot.

Items that are the owner's economic parameters (fee, maturity, founder schedule) are in section 3 and were not
changed.

---

This brief is engineering material, not legal advice.
