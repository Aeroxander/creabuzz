# A next-gen DAO: seven pieces beyond the contributor launch (proposal, 2026-10-25)

Status: **a proposal. Nothing here is decided or built.** Each piece below is separate, with its own proposed decision
row (N1 to N7), its own contract work, audit scope and, where money moves, a legal read. Accepting one does not
accept the others. It follows the funding curve proposal ([JOIN-CURVE.md](JOIN-CURVE.md), asset rule decided as
D112), the forecasts plan ([MARKETS-AND-EXIT-PLAN.md](MARKETS-AND-EXIT-PLAN.md)) and two outside reviews on
2026-10-25, whose corrections are listed in [What the reviews changed](#what-the-reviews-changed).

## In one paragraph

What sets Creaton apart is the whole route: find collaborators, do reviewed work, own a part of what you build,
show delivery, raise again on delivery. These seven pieces strengthen that route. A **court of $CREATE stakers**
judges disputed milestones and submissions, so the people deciding an outcome are not the project's own holders.
**Money forecasts** on delivery then become possible, settled by the court's final ruling. **Runway and matched
exits** let holders turn Shares into cash by selling to someone who wants in, without the treasury paying.
**Payouts** share routed revenue with holders. **Pledges to the next milestone** fund delivery in stages.
**$CREATE services** give the platform token paid jobs. **Launching $CREATE** is its own decision.

## Where we stand against MetaDAO and Umia

| | MetaDAO | Umia | Creaton today | With these pieces |
|---|---|---|---|---|
| Big decisions | Markets on the token's price: a proposal passes when its pass market beats its fail market | Markets on the token's price over a three-day average, against a do-nothing market, with a threshold | Votes of holders | Votes, informed by forecasts on delivery |
| Insiders paid | Performance packages that unlock as the price rises | Vesting over time or at price milestones | Milestone locks on team Shares, checked by a panel or holder objections | The same, with disputes judged by the court |
| Getting money out | Sell on the market; holders can pass a decision to return capital | Sell on the market; markets decide liquidation | Leave at any time with your part of the treasury | Also sell to a buyer at no less than that part, and payouts |
| Work by contributors | Not part of the system | Not part of the system | Reviewed submissions earn Shares | The same, with a second opinion from the court |
| Discussion and moderation | External channels | External channels | Built in: Home, boards, rooms, moderation | Moderation appeals go to the court |
| Legal entity | IP assigned to an entity the market controls | Cayman entity on MetaLex BORG | An IP record only (D38) | **Still a gap**; needed before raises |

Their decision markets measure what traders expect the price to do. For an early project the price mostly measures
attention, and Umia's own guide says early results may be noisy. Our forecasts settle on whether the work was done.

## Rules every piece keeps

1. **Leaving stays as it is** (D73): anyone can give up Shares for their part of the treasury at any time. No queue,
   payout, bonus or market can block it.
2. **Earned claims survive everything social.** A payout, a forecast win or a court fee stays claimable after a
   ban, a removal or leaving the community.
3. **Every step has a deadline and a way to finish without us.** Rulings, refunds, releases and payouts can be
   triggered by anyone once their time has come.
4. **Collateral matches what is at stake.** $CREATE is the stake that makes someone eligible for a paid job and the
   first thing slashed. A stake covers a capped total of open cases, not each case in full. Cases that move large
   sums also need sale-currency collateral. Bonds are sized in dollars from a price source with rules for stale or
   missing prices (refuse new cases; never abandon assigned ones). A $CREATE-only mode is allowed for small cases and
   says so.
5. **Testnet first, the "unaudited" notice on every launch flow, mainnet off** until audits and counsel.

## 1. The $CREATE court (N1)

### What it decides

- **Team milestones (raise path).** Today a holder objects to a milestone with a deposit (10% of the team's bond,
  which is 1% of the raise target) and holders vote; an upheld objection pays the objector the deposit back plus half
  the bond ([MilestoneChallenge.sol](../../contracts/src/MilestoneChallenge.sol)). With the court, the objection and
  its deposit stay, and the **court rules** instead of a vote of holders. Holders who bet against a milestone can no
  longer vote to uphold their own bet. Leaving before every unlock stays (D72). This changes an agreed backer
  protection and needs its own row.
- **Contributor submissions.** A second opinion when someone disputes a reviewer's approval or rejection. The DAO's
  freeze vote stays as it is (`TreasuryMandate.freezeClaim`).
- **Moderation appeals** (piece 6) and **curation disputes** (piece 6).

Every case is judged against words fixed in advance: a milestone's check, a submission's acceptance check
(`checkHash`, set when it is filed), a board's rules.

### How it works

Build on [Kleros v2](https://github.com/kleros/kleros-v2) rather than design a court from a feature list: it has
courts, draws weighted by stake, sealed votes (commit, then reveal), appeals to larger panels, deadlines, redraws
for jurors who do not reveal, and a random number fallback. A verified Kleros v2 contract is marked MIT; **check the
whole repository's license** before adapting it. Certora has [audited Kleros v2](https://www.certora.com/reports/kleros-v2).

- **Stake:** $CREATE, locked while a juror is assigned and for a period after.
- **Pay:** whoever opens a case pays a fee (in USDC or $CREATE), returned if they win; jurors who vote with the final
  ruling share the fee and part of the stake of those who did not.
- **Appeals:** each round draws a larger panel and costs more; the last round has a fixed deadline, after which the
  ruling is final.
- **Integration through the standard arbitration interface,** so a project can name the Creaton court (default) or
  another court, Kleros's own included.

Today's [VerifierSet](../../contracts/src/VerifierSet.sol) is an owner-approved reviewer list with a quorum and
slashing the owner authorizes, for checkable misconduct only. It has none of the above; the court is a new trust
model, not an extension.

### Limits we accept and show

- **Stake buys influence.** Draws are weighted by stake: with three seats drawn with replacement, someone holding 30%
  of the stake holds at least two seats 21.6% of the time. Larger panels for larger cases and appeals reduce this;
  nothing removes it. Several wallets are not several people.
- **Losing on appeal is not proof of lying.** Jurors are paid for agreeing with the final ruling, which rewards
  guessing what others will think. Kleros's own research covers lazy voting and uncommon but correct answers.
- **A bribe can exceed a stake.** Hence the exposure caps in the rules above, and the market caps in piece 2.
- **A team can still deliver late on purpose.** The court judges what was delivered, not why.

### Contract work

The court (adapted), its staking with exposure caps, a price source for dollar sizing, and an adapter so
`MilestoneChallenge` and the work budgets can send a case and read a final ruling.

## 2. Money forecasts (N2)

### Questions, and how they settle

| Question | Settles on |
|---|---|
| "Will this submission be released by date D and still stand when its 7-day challenge window ends?" | `releasedAt` and the submission's status at the end of its window; if disputed, the court's final ruling |
| "Will tranche 2 be accepted, with its evidence submitted by date D?" | When the evidence was submitted, and the final ruling on it |

Settling on **when evidence was submitted** and **the final ruling** means a dispute that takes weeks cannot flip a
result that would otherwise be Yes. Two contract gaps first: a submission records `releasedAt` but not when it was
frozen, so its status on a past date cannot be rebuilt; and the milestone lock must record when evidence was
submitted. If there is no final ruling by a deadline, everyone is refunded.

### The market

- **Two-sided pools in USDC first:** Yes and No pools, winners split the losing pool. No market maker, no selling of
  positions (so refunds are simple), no DAO money.
- **Betting closes when evidence is published.** The court draws jurors after that and skips anyone holding a
  position in that market.
- **Barred:** the team, that submission's reviewers, and drawn jurors. The contract checks wallets; second wallets
  cannot be stopped, and the page says so.
- **Caps:** per wallet, and per question no more than the court stake that would decide it.
- **Later:** a market maker funded from platform fees (piece 6), with a fixed worst-case cost (about $347 for a
  price-impact setting of 500 on a yes/no question).

### Rewards for accuracy

Pay a **fixed amount per point of score**, `k × (1 − (forecast − outcome)²)`, never a share of a pool: a share of a
pool can reward shading a forecast away from what you believe (an honest 60% expects 50 of a 100 prize against a 60%
rival; reporting 55% expects about 50.08). A fixed rate keeps honesty best because nobody else's forecast changes
your pay. Each question has a capped budget. **To be eligible, an account stakes a small amount of $CREATE**, so a
hundred accounts cost a hundred stakes; this makes farming expensive without claiming to identify people.

### Order

Testnet with the pilot group, then audit scope and a legal read, then real USDC. Contributor submissions come first
(a freeze takes a DAO vote); team milestones after the court exists.

## 3. Runway and matched exits (N3)

### Why successful projects lose cash

Leaving is the only way to get cash out while transfers are locked (D77). Holders who believe in a project still leave
when they need money. Leaving does not lower anyone else's part: with 100,000 USDC and 1,000 Shares, one holder leaving
with 100 Shares takes 10,000 and leaves 90,000 for 900 Shares, still 100 each. What it lowers is the project's cash
for future work.

### Runway on the DAO's front page

Money that came in (the D82 card), money committed to work, spendable cash, spending over the last three months, and
months left at that rate. **Committed means moved**: an approved work budget leaves the DAO when its mandate is
created ([TreasuryMandate.sol](../../contracts/src/TreasuryMandate.sol), `safeTransferFrom` into the mandate), so
leaving cannot take it. A label or a pending proposal does not protect anything, and no vaguely named reserve is
quietly left out of what leaving pays.

### Matched exits

A holder who wants out posts an offer; a buyer who wants in fills it. The treasury is not touched.

- **Atomic:** USDC to the seller and Shares to the buyer in one transaction, from Shares held by the exit contract.
- **Price:** the seller's minimum, never below what leaving would pay at the moment of the fill.
- **Expiry and cancel;** no offer can be filled twice. Cancelling is one step, and the seller can then leave directly.
- **Votes:** the seller's placed support is trimmed as on any change of ownership (`ownershipChanged`); the buyer
  starts with none and cannot vote on proposals opened before the purchase (their snapshot predates it).
- **One narrow exemption** in `Shares` for the exit contract. In a DAO with a funding curve, the same contract can
  sell both kinds, keeping one exemption.
- **Buyers choose** between buying from the project (the curve, which funds it) and buying from a leaver (which pays
  the leaver). The page says which one funds the project. No rule makes buyers serve leavers first. A matched sale is
  never reported as money raised.

For contributor projects this matters most: their treasuries are often small, so leaving pays little, and a matched
sale is how earned Shares become cash. It opens a controlled market for those Shares, so it has to meet the bar in
[CONTRIBUTOR-TOKEN-TRADING.md](CONTRIBUTOR-TOKEN-TRADING.md).

### Optional exit fee

New projects only, set at launch, at most 2%, may be lowered but never raised: direct leaving keeps the fee in the
treasury for those who stay. It applies only to leaving directly, not to matched sales, so it nudges a leaver to look
for a buyer first. Existing projects keep the exit they were promised.

## 4. Payouts (N4)

A $10,000 payout lowers the treasury exactly as a $10,000 exit does. What it adds: the DAO controls when and how
much, and holders get cash without giving up Shares. This revises **D78** (no automatic payouts) and **D82** (the
revenue pledge is a statement the contracts do not enforce).

### What counts as revenue

Only money that arrives at a **revenue address** the project publishes for customers and payment services. A
contract can route money it receives; it cannot make an offchain business send money, so remitting stays a written
commitment (the pledge, D78, in the documents behind D38). Raise proceeds, refunds, returned budgets, recovered bonds
and transfers between the project's own accounts never count.

### The split

Set at launch, changeable by vote with notice: for example a part to work budgets, a part to payouts, the rest to the
treasury. One-off payouts can also be declared by a vote.

### Who is paid

The same base leaving uses: every Share **and Loot**, less the DAO's own, less locked team Shares (D72), less what the
funding curve may still sell. **Locked team Shares earn nothing until their milestone unlocks.**

### How it is paid without paying twice

- A declared payout **moves into the payout contract when it is declared**, so it is no longer in the DAO's balance
  and leaving cannot pay it again.
- A running total per Share, updated on every change of ownership through the same hook the DAO already calls for
  Shares and Loot (`ownershipChanged`), credits whoever held at the moment of each payout.
- A credited amount stays claimable after leaving, bans and moderation. Unclaimed amounts after a period (open
  question) return to the treasury.

### Stay bonus (optional)

Holders can commit to stay 3, 6 or 12 months for a bigger share of a set slice of each payout. The Shares stay in
their wallet; leaving early forfeits the unclaimed bonus, never the base payout. It rewards holding; it does not
promise runway, because holders can still leave.

### Kept separate

Work fees (court, review, forecasting) are pay for work; payouts are returns on ownership. Making people forecast to
receive a payout does not change what the payout is, and would fill forecasts with low-effort entries. **This piece
needs counsel more than any other.**

## 5. Pledges to the next milestone (N5)

Backers pledge USDC toward the next milestone. The pledge sits in escrow and:

- **is released to the treasury** when the milestone before it is accepted (the court's final ruling or the lock's
  unlock) by its deadline, and the backer receives Shares **from the funding curve's allocation** at the price fixed
  in the pledge's terms; no new Shares are made (D76);
- **is refunded** to the backer if that milestone is not accepted by the deadline;
- **can be withdrawn** until the milestone's evidence is submitted, then waits for the ruling.

Release and refund can be triggered by anyone. A follow-on raise can work the same way: the curve opens a new part of
its allocation only after a verified milestone. Projects without a curve need another source of Shares (open
question). Legal terms per pledge.

## 6. $CREATE services (N6)

Each use is a job with a fee and a stake at risk for defined failures. Newcomers can pay for these services in USDC
without holding $CREATE.

| Use | The job | Paid by | Slashed for |
|---|---|---|---|
| Juror stake (piece 1) | Judging cases | Case fees | Voting against the final ruling; not revealing |
| Forecast eligibility (piece 2) | Forecasting with a stake per account | Accuracy rewards | Nothing; the stake only makes farming expensive |
| Moderation appeals | A removal or ban on a board can be appealed to the court, judged against the board's rules | Appeal fee | As jurors |
| Curation | Stake behind a project to list it in a separate "Backed by curators" section of Discover; never a ranking by stake alone | Part of the platform's launch fee once the project's first milestone is accepted | A court ruling that the launch record made false claims |
| Founder launch bond | Proportionate, returned at the first accepted milestone or after a set time without a fraud ruling | Nothing | A fraud ruling |
| Reviewer and contributor bonds | $CREATE by default (USDC accepted, D39); small, and a work budget chooses whether to ask for them | Review fees | As today |
| Platform fees | Launch, court and market fees split between active stakers (for their work), buying back and burning $CREATE, and the platform treasury | | |
| Platform governance | Fees, court rules and listing standards; never a project's own decisions | | |

**Vouching, defined narrowly.** A staker can vouch for an account. What is banned is claiming the same reward twice
through two accounts; separate personal, work and agent accounts are allowed. A challenge needs evidence of that
double claim. Nothing here promises "one person".

**Deferred:** a backstop pool that repays backers after fraud (an insurance system with reserves, exclusions and
correlated losses), early auction access for stakers (fairness and onboarding cost), and markets that choose
contributors (advisory only until their own mechanism is designed).

## 7. Launching $CREATE (N7)

A separate decision, after the raise path is audited, counsel has advised and a legal entity exists. Questions to
answer there:

- **What $CREATE is.** A separate token, or the Shares of a Creaton DAO (with that DAO's exit floor, and trading
  opened by vote), so the platform runs on its own tools. The court needs $CREATE to move into its staking contract
  and needs a price for dollar sizing, so either way it must be transferable.
- **How it is first held.** Sold through Creaton's own auction and funding curve, earned through work on Creaton, or
  both. The example project ([CREATON-EXAMPLE-PROJECT.md](CREATON-EXAMPLE-PROJECT.md)) is a testnet project with no
  sale, and its test records will not carry over.
- **Before $CREATE has a market,** court stakes use fixed amounts and the $CREATE-only mode for small cases.

## Order

The launch order stays: social MVP, then contributor projects, then the audited raise.

1. **With contributor projects:** the runway card; money forecasts on submissions (testnet); the court as a second
   opinion on disputed submissions and for moderation appeals; matched exits once they meet the trading bar.
2. **With the audited raise:** the court for team milestones; payouts; pledges; curation and founder bonds.
3. **Before any of it on mainnet:** the legal entity, counsel on payouts, forecasts and $CREATE, and audits.

## Proposed decision rows

| ID | Question | Proposal | Why | Risk |
|---|---|---|---|---|
| N1 | Who judges disputed milestones and submissions? | A $CREATE court adapted from Kleros v2: stake-weighted draws, sealed votes, appeals, deadlines; objections keep their deposit, the court rules instead of a holder vote | Separates who decides an outcome from who owns or bets on it | High: a new trust model, the largest new contract surface |
| N2 | Money forecasts on delivery? | USDC two-sided pools settling on submission time and the final ruling; team, reviewers and drawn jurors barred; caps tied to court stake; testnet first | Lets skeptics act on doubt with money without borrowing Shares | High: legal, manipulation by people who control outcomes |
| N3 | How do holders get cash without draining a project? | A runway card; matched exits at no less than what leaving pays, buyers choosing curve or leaver; an optional exit fee for new projects | Turns cash needs into sales to newcomers, not withdrawals | Medium: a narrow exemption to D77, a controlled market |
| N4 | Revenue payouts to holders? | A revenue address with a launch-set split; payouts moved out at declaration; Shares and Loot on the exit base; locked team Shares excluded; claims survive everything; optional stay bonus. Revises D78 and D82 | Holders get cash without leaving; the DAO controls the outflow | High: legal weight, accounting |
| N5 | Fund delivery in stages? | Pledges released on an accepted milestone by a deadline, refunded otherwise; Shares from the curve allocation | Money follows delivery, not promises | Medium |
| N6 | What does $CREATE do? | Paid jobs with stakes: jurors, forecast eligibility, moderation appeals, curation, founder and reviewer bonds; fees to active stakers and buyback; platform governance | Utility from services people need | Medium: correlated collateral, which the shared rules cap |
| N7 | How does $CREATE launch? | Its own decision after the audited raise, counsel and an entity | The token's form decides much of the legal answer | High |

## Tests that would decide it

- **Court:** every case reaches a final ruling or a refund by its deadline; a juror's stake cannot leave while
  assigned; open exposure never exceeds a juror's cap; a juror holding a position in the market is never drawn.
- **Forecasts:** payouts never exceed what was staked plus any reward budget; a dispute's length never changes a
  result; refunds work with no operator.
- **Matched exits:** a fill is atomic; no offer fills twice; the price is never below what leaving pays; direct
  leaving works with an open offer (after cancelling) and with no buyers; the treasury is unchanged by a fill.
- **Payouts:** the DAO's balance plus the payout contract's balance is unchanged by declaring; leaving after a payout
  does not pay it again; locked team Shares accrue nothing; a claim survives leaving and a ban.
- **Pledges:** release only after acceptance by the deadline; refund after it, triggered by anyone; no Shares beyond
  the curve allocation.

## Trust (CROPS)

- **Censorship resistance:** the court, its appeals and every refund finish without the operator; moderation never
  touches earned claims or direct leaving.
- **Open:** contracts, event formats, scoring and ruling rules published with the source; a project can name another
  court.
- **Free:** Kleros v2's license to be checked before adapting it; first-party contracts stay MIT.
- **Privacy:** forecasts, disputes and vouches can link accounts; participation is voluntary, visibility is stated,
  separate accounts are allowed.
- **Security:** stake concentration and the $CREATE price can weaken judging and collateral together; the exposure
  caps, sale-currency collateral for large cases and deadlines are the limits. Accounting keeps payouts and leaving
  from paying the same money twice.

## Open questions

1. Does the court replace the holder vote on objections for every new project, or does a project choose at launch?
2. Which price source sizes $CREATE bonds, and what is the threshold above which a case needs sale-currency
   collateral?
3. Which contract records when evidence was submitted and when a submission was frozen?
4. How long do unclaimed payouts stay claimable?
5. Where do pledge Shares come from in a project without a funding curve?
6. Is $CREATE a separate token or the Shares of a Creaton DAO?
7. How large is the court's first juror pool, and who is in it before $CREATE has a market?

## What the reviews changed

From the review of the forecasts plan:

- Money markets are their own decision (N2), on testnet first and only once their settlement rules are fixed; an
  advisory pilot in signed posts, without money, can run beside them.
- The cap on market size against the objection deposit is gone: an upheld objection is paid, so it set no cost.
- Raising the objection bar when a market exists is gone: a forecast cannot weaken a backer protection.
- The rule that backers of a spend must wait to leave is dropped. Leaving already trims support, a lost threshold
  resets the queue, and the vote is checked again before a spend runs, so a departed backer's vote is not kept.
- "Approved and not frozen by D" cannot be rebuilt from today's records; the contract gaps are listed in piece 2.

From the review of the follow-up conversation:

- A court improves separation; it does not make forecasts safe. Its limits are listed in piece 1.
- VerifierSet is not a court; the court is a new trust model, built on Kleros v2's prior work.
- $CREATE collateral is capped by exposure and backed by sale-currency collateral for large cases.
- Paying a share of a pool by score is not truth-telling; a fixed rate per point is (piece 2).
- Leaving does not lower anyone else's part; it lowers the project's cash. A payout lowers it just as much.
- Committed money is money moved into a mandate, not a label.
- A matched sale raises nothing for the project and is never reported as money raised; buyers choose.
- The exit fee is for new projects only; the stay bonus is not runway.
- Payouts include Loot, exclude locked team Shares and are moved out at declaration so they cannot be paid twice.
- Vouching bans double claims, not separate accounts.
- No claim that competitors lack a community; the difference is the route from work to verified ownership.
- Launching $CREATE is its own decision; the example project is a testnet project with no sale.

## Sources

[MetaDAO docs](https://www.metadao.com/docs), [Variant on MetaDAO](https://variant.fund/articles/investing-in-metadao/),
[Lightspeed on MetaDAO launches](https://lightspeed-4bed7b.beehiiv.com/p/unruggable-icos),
[Umia docs](https://umia.finance/docs), [Umia decision markets](https://umia.finance/docs/decision-markets),
[Kleros whitepaper](https://kleros.io/whitepaper.pdf),
[Kleros research on juror incentives](https://blog.kleros.io/incentivizing-jurors-to-honestly-report-uncommon-answers-deposit-sizes-lazy-strategies-and-peer-prediction/),
[Kleros v2](https://github.com/kleros/kleros-v2), [Certora's Kleros v2 report](https://www.certora.com/reports/kleros-v2),
[Forecasting competition research](https://pubsonline.informs.org/doi/10.1287/mnsc.2022.4410),
[LMSR](https://mason.gmu.edu/~rhanson/mktscore.pdf), and the SEC interpretation the second review cites
([March 2026](https://www.sec.gov/files/rules/interp/2026/33-11412.pdf)).
