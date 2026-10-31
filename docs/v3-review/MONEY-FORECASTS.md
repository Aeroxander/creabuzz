# Money forecasts (N8, built for test networks on 2026-10-26 as D120)

> **Removed from the app in D150 (2026-10-31), see tag pre-deprecation-2026-10-31.** The "Money on it" panel, `VITE_FORECAST_POOLS` and the app's reader are gone; the contract
> `contracts/src/ForecastPool.sol` and its forge tests stay until the contracts clean-up (D137 freezes Solidity). The
> rest of this page is the historical record.

Status: **an experiment, on test networks only.** `contracts/src/ForecastPool.sol` and a "Money on it" panel under each
bounty on a post. It does not gate the audited raise, and nothing about it goes near a main network without counsel.

## What it is

One question per bounty on a post: **will it be paid?** Two pools of people's own money, one on "paid" and one on "not
paid". When it settles, those who were right take back what they put in plus a share of the other pool in proportion to
it. If nobody was on the winning side, everyone takes back their own. No market maker, no selling a position, no
platform or DAO money, and no reward for accuracy beyond the pools (N8 drops money accuracy rewards, which could be
farmed).

## The rules

| Rule | Why |
|---|---|
| Bets close a day before the deadline, and while any run is on | Nobody bets on what is already being decided |
| The bounty's creator and anyone with an open claim can only bet "paid" | The people who can stop it being paid cannot profit from stopping it |
| At most 1,000 per wallet per bounty | Keeps one wallet from dominating a test pool; **not** proof against manipulation (wallets are not people) |
| It settles on the bounty itself: paid is yes, refunds open is no | No oracle and no vote: the same chain state everyone sees. An appeal (N7) is waited for, because refunds wait for it |
| Anyone can settle, and anyone can send a bettor what they are owed; the money only goes to the bettor | Every step finishes without us |

## What differs from the proposal

N8 proposed per-person questions ("will a claim filed by D be paid?"). Built: one question per bounty, which needs no
list of who could claim and settles on what the contract already records. A bet can come back after a run ends, since
the contract does not record when the first run began; the page's free forecasts (N3) still close at the first run.

## Limits we accept and show

- **Not manipulation-proof.** A coalition, second wallets, or someone whose payment depends on the bounty can be worth
  more than a pot. The cap and the bars make it harder, not impossible.
- **Legal weight.** Money on outcomes is the most regulated thing here. Test money only, and the page says so.

## Open, for you

Whether N8 stays at all past the test networks; per-person questions; whether pools should exist for work-area
bounties (they need a cutoff at the first released submission, which the chain does not record directly).
