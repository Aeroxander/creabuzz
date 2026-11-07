# What $CREATE is (N6, decided 2026-10-26 as D118)

Status: **decided for test networks, proposed for a main network.** You asked to start N6 and then to decide everything
overnight, so these are my calls; each says what would change it. The test token and its faucet are built
(`contracts/src/CreateToken.sol`, `contracts/src/CreateFaucet.sol`). Nothing about a real $CREATE launches before
counsel, a legal entity and an audit, and mainnet stays off.

## In one paragraph

$CREATE is **the platform's work token**: a separate ERC-20 that people stake to judge cases in the court (N7), post
as a bond where a work budget or a remix asks for one, and earn by doing that work. It is not the Shares of any DAO, it
has no claim on any treasury, and holding it pays nothing. Fees go to the people who judge, never to holders for
holding. The supply is fixed at one billion, minted once, with no owner.

## What it is not

- **Not a Share.** Shares are a project's ownership: votes, leaving with part of a treasury, locked transfers (D73,
  D77). A court stake must move freely into staking and have a market price; a token that could also be cashed out of
  a treasury would tie the court to that DAO's exits.
- **No claim on any money.** No leaving, no payout for holding (N10's payouts are for a project's Shares, not
  $CREATE), no buyback, no revenue share. Fees reach people only as pay for judging.
- **No admin.** No owner, no mint after deploy, no pause, no blocklist, no upgrade.

## What it is for

| Use | How | Status |
|---|---|---|
| **Judging** | Stake to be drawn as a juror; the stake is what is slashed for voting against the final ruling or not revealing; a stake covers a capped total of open cases | N7, built next |
| **Reviewer bonds** | A work budget can name $CREATE as its reviewers' bond token. The contracts already take any token per budget (`TreasuryMandate`, D39); the vote form now offers $CREATE | Built (form) |
| **Remix bonds** | A remix posts a bond in $CREATE at launch, paid to the parent if the court rules the remix broke its terms | N12 |
| **Court fees** | A case's service fee can be paid in $CREATE or USDC | N7 |
| **Platform votes** | The court's settings (fees, panel sizes, timeouts) change by a $CREATE vote with notice, never for an open case. The token keeps vote checkpoints from its first transfer so this needs no migration | Later; checkpoints built |
| Parked | Stakes to feature a bounty on Home, curation stakes, founder launch bonds, vouching, early auction access | See NEXT-GEN-DAO.md, Parked |

## Where fees go

- A case's **service fee pays the jurors who served it**, split among those who revealed.
- A share of any **platform fee** (the court's own share, and later a fee on raises if one is decided) goes to a **juror
  reward pool**, paid out per case served, not per token held.
- **No buybacks and no holder dividends.** Paying holders for holding is what makes a token look like an investment in
  the platform's work; paying people for judging is pay for work. This is the line the earlier conversation drew ("make
  people work for it").

## Sizing bonds

A bond only deters while it is worth something, and a $CREATE bond falls with its price.

- **Test networks:** stakes and bonds are fixed $CREATE amounts. There is no price.
- **Main network (proposed):** a bond is sized in dollars when it is posted, from a time-weighted average of the
  $CREATE/USDC pool over at least 30 minutes, refused if that price is older than an hour. When the price falls, a
  juror tops up or is drawn for no new cases; **cases already assigned are never abandoned**. Cases that move large sums
  also need USDC collateral (NEXT-GEN-DAO.md, Collateral). This answers open question 2 for the design; the threshold
  is set with the court's settings.

## Supply and first holders

**One billion, fixed.** Proposed for a main network, for counsel:

| Share | Who | How it is first held |
|---|---|---|
| 40% | Work | Held by the Creaton DAO and paid for reviewed work through ordinary work budgets whose currency is $CREATE: the same review, window and award as any project |
| 20% | Sale | Sold in Creaton's own auction, the platform's raise, after that path is audited |
| 15% | Founders and early team | Under the same milestone lock every project's team has (D42, D72) |
| 15% | Creaton DAO treasury | For grants and the court's start; spent by the DAO's votes |
| 10% | Juror reward pool | Paid per case served while fees are still small |

So $CREATE is mostly **earned** by doing work on Creaton, and only a fifth is sold. The Creaton project itself
([CREATON-EXAMPLE-PROJECT.md](CREATON-EXAMPLE-PROJECT.md)) stays a contributor project with Shares; a main-network
Creaton DAO would hold the work share and pay it out.

## Test networks now

- **Test CREATE** (`tCREATE`): the same contract with a test name. The whole supply goes into a faucet with no owner,
  which gives each wallet 1,000 a day. Nothing on a test network carries over.
- Deployed by `DeployLaunchKit` on Sepolia and a local chain only (never on a main network), and by the dev chain;
  `VITE_CREATE_TOKENS` and `VITE_CREATE_FAUCETS` name them for the web app.

## What waits for a main network

1. **Counsel and a legal entity.** Whether a work token that pays jurors is treated as an investment depends on how it
   is sold and described; the sale share is the part most likely to change.
2. **An audit** of the court and the token's use in it (the token itself is OpenZeppelin's ERC-20 with votes and
   permit, unchanged).
3. **The price source** above, and a pool for it.
4. **Your calls:** the split above, whether there is a sale at all, and whether founders get a share.

## What would change these calls

- If counsel says a sale makes it an investment contract: drop the sale share and earn it all through work and judging.
- If the court is not adopted (N7): $CREATE has no reason to exist yet; keep bonds in USDC.
- If staking in Shares is preferred to a platform token: not recommended (above), but the court contract takes its
  stake token as a constructor argument, so it can run on any token.
