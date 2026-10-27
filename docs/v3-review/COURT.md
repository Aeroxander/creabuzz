# The $CREATE court (N7, built for test networks on 2026-10-26 as D119)

Status: **built for test networks.** `contracts/src/CreateCourt.sol`, appeals in `contracts/src/OpenBounty.sol`, the
Court page (`/court`, reached from Portfolio's Judging section), and an appeal step on bounties on posts. Decided
overnight with your go-ahead; the open calls are at the end.

## What it decides

**Bounty appeals first** (NEXT-GEN-DAO.md, N7 item 1): after a bounty's deadline, if nothing was agreed, a claimant can
take their claim to the court within three days, before refunds open. The court judges the work against the words the
bounty fixed when it opened. Upheld: anyone pays the claimant the whole pot. Anything else (against, no ruling, a case
that found no jurors): the bounty goes on as it was and refunds open.

Second opinions on contributor submissions and milestones for new projects (items 2 and 3) need changes to
`TreasuryMandate` and the milestone lock and are **not built**; the court takes any contract of the same shape
(`IArbitrable.rule`), so they can be added without changing it.

## How a case runs

| Step | Time | Who |
|---|---|---|
| Open | when the claimant appeals; the bounty pays the fee (3 seats × 1 USDC) from the claimant | the claimant |
| Evidence | 2 days; anyone can add a link or a note (kept in an event) | anyone |
| Draw | after the evidence time: 3 seats drawn by stake, with replacement | anyone presses it |
| Seal | 2 days: each drawn juror seals for or against | drawn jurors |
| Open | 2 days, or sooner once everyone sealed | drawn jurors |
| Appeal | 2 days: anyone can pay for a larger panel (7, then 15 seats); it is drawn at once | anyone |
| Settle | after the appeal time (at once after the third round) | anyone presses it |

Jurors who opened a vote with the final ruling share each round's fee and the stake of the others in that round, by
seats. A juror who voted against it, or never opened a vote, loses the stake each seat held (100 CREATE). With no ruling
(a tie, nobody opening, or a timeout) everyone who opened a vote counts as with it. A round nobody judged well puts its
fee and the taken stake in a pool; a tenth of each pool is added to every round that has jurors who judged well.

A case that cannot find enough free seats for 14 days times out. A first round nobody judged ends with no ruling and its
fee joins the pool. An appeal no panel could hear leaves the ruling it appealed: earlier rounds are settled against it
and whoever paid for the appeal is paid back, so appealing into a court too small to hear it cannot undo a ruling (D129).

Settling never waits on the contract that asked: if it does not take the ruling, the case is still settled and its
jurors paid and freed, and anyone can hand the ruling over again (**Hand over the ruling**, D129).

## Stakes

- 100 CREATE is one seat. A drawn seat holds its 100 until the case is settled, so open cases never take more than a
  juror staked, and only free seats can be drawn or taken out.
- Draws pick among free seats with a tree (at most 1,024 jurors), so each draw costs the same however many jurors there
  are. A first stake is at least one seat, taking out leaves nothing or at least one seat, and a juror whose stake reaches
  zero gives their place back for the next one, so small stakes cannot fill the court (D129).
- Fees and taken stake are owed, and each juror withdraws their own.

## Sealed votes without keeping secrets in the browser

A vote's seal is `keccak256(choice, secret, juror, case, round)`. The page makes the secret from the juror's wallet
signing fixed words for that case and round, so opening the vote only needs the same wallet to sign again; which way it
went is found by trying both choices against the seal on the chain. Nothing has to survive in the browser, and nobody
sees a vote before it is opened.

## How it differs from Kleros, and why

The proposal said to fork a pinned Kleros v2 commit. For test networks I built a small court with Kleros's rules instead:

| | Kleros v2 | This court |
|---|---|---|
| Size | thousands of lines, proxies, sub-courts, dispute kits | about 510 lines, one court, no proxy |
| Powers | governor, guardian, pause | none (settings are fixed per deployment) |
| Randomness | RNG module with fallback | the block's (`prevrandao`): fine for testing, not for real money |
| Appeal funding | each side crowdfunds | the appellant pays the next round |
| Redraw on a juror who does not open | yes | no: they lose their stake and the round is decided by the rest |
| Sub-courts, policies | yes | one court |

Bounties call the court through the same shape Kleros uses, so the choice is still open for a main network: fork
Kleros v2 (more code, more powers to strip, an audit trail of its own) or audit this one (smaller, missing randomness and
redraws). **Decide before a main network; the test networks will show which features people miss.**

## Limits we accept and show

- **Stake buys influence.** With three seats drawn by stake with replacement, someone holding 30% of the stake holds at
  least two seats 21.6% of the time; appeals to 7 and 15 seats reduce it, nothing removes it.
- **Jurors may have interests.** Nothing stops a funder or the claimant from staking; second wallets remain.
- **Losing on appeal is not proof of lying.** Jurors are paid for agreeing with the final ruling, which rewards
  guessing what others will think.
- **Test randomness** can be bent by whoever makes the block.

## Open, for you

1. Kleros fork or our own audited court, before a main network.
2. Whether jurors who funded or claimed on a bounty should be barred from its case (needs a check at the draw).
3. The settings: 100 CREATE a seat and 1 USDC a seat per round are test values.
4. Items 2 and 3 of what it decides (contributor submissions, new projects' milestones).
