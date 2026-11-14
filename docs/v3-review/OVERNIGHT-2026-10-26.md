# Overnight, 2026-10-26: stage 2 and stage 3 of the next-gen DAO

You asked me to start N5, then N6, then to keep going through every N and make the calls myself. Everything is on
`v4-governance-rework`, committed locally, **not pushed**; everything that moves money is test networks only, and
mainnet stays off. Each call has a decision row you can reverse.

## What is where

| Piece | State | Decision | Doc |
|---|---|---|---|
| N5 sales between members | Built (Funds tab; a vote, 30 days, then signed offers filled whole) | D117 | NEXT-GEN-DAO.md §5 |
| N6 what $CREATE is | Decided: a work token; test token and faucet built; offered as a reviewer bond | D118 | CREATE-TOKEN.md |
| N7 the court | Built: our own small court with Kleros's rules; bounty appeals on posts; a Court page | D119 | COURT.md |
| N8 money forecasts | Built as a test-network experiment: two pools per bounty on a post | D120 | MONEY-FORECASTS.md |
| N9 pledges | Specified only (needs the funding curve) | D123 | PLEDGES-STATES.md |
| N10 payouts | Built for contributor projects: revenue split and voted payouts; a hook in the DAO | D122 | PAYOUTS.md |
| N11 where a project comes from | Built: built-on link, remix terms, licence fit, both pages | D121 | NEXT-GEN-DAO.md §11 |
| N12 the parent's share | Remix bond built (decided by the court); the locked share specified | D124 | REMIX-PARENT-SHARE.md |

Commits: `b3104118c`, `956d83e33`, `fea0b46c9` (N5), `873b20de2` (N6), `d60e0cf95` (N7), `d7610a56b` (N8),
`5d5812b18` (N11), `0d5b0cd2b` (N10), `039872e46` (N9, N12).

## Calls to check first

1. **Selling voting Shares** between members (N5) against CONTRIBUTOR-TOKEN-TRADING.md's advice to sell Loot.
2. **$CREATE's split** (40% work, 20% sale, 15% founders, 15% DAO, 10% juror pool) and whether there is a sale at all.
3. **The court is ours, not a Kleros fork**, on test networks; the fork-or-audit choice stays open for a main network.
4. **The DAO changed** for payouts (N10): a once-only payout module told of every change in who holds what (298 bytes,
   inside an existing patch region). Raise DAOs with locked team Shares are refused for now.
5. **Money forecasts** exist at all, even on test money.
6. Refunds on post bounties now wait three days after the deadline for appeals (unless nobody filed a claim).

## How it was checked

Each built piece has forge tests (with fuzz tests on the money), mutation entries (every guard removed is caught,
128 entries in all), core and web unit tests, and a real-chain journey:

- `scripts/web-contributor-e2e.sh`: a contributor sells Shares to a newcomer, the DAO votes payouts and the contributor
  collects, Field Guide is built on Docs Commons and posts a bond.
- `scripts/web-post-bounty-e2e.sh`: money forecasts on both sides; an appeal judged by a juror who staked test CREATE,
  then paid.

Last full run, on the final dev chain: forge 590 passed (2 skipped), core 834, web 1,956, the mocked browser suite 462
passed (45 skipped), both journeys 2 of 2, every mutation caught; web check, types, file sizes and the fork check clean.

**Not done:** your hand test (TEST-STEPS 4bl to 4bq); a Sepolia rehearsal of the deploy script (it changed for every
piece; the dev chain runs it end to end, the fork rehearsal needs a public node); an outside review.
