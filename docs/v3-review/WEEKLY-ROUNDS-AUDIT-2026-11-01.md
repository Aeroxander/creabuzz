# Weekly rounds: can they ship in the MVP? (internal review, 2026-11-01)

**Short answer: no. Launch the MVP without weekly rounds.** Keep them on test networks, behind `VITE_WEEKLY_ROUNDS`, which stays off in the hosted build.

The review found **three ways to steal money or Shares from the rounds contract.** Anyone can use them, they cost only gas, and they hit every DAO that uses the contract. A fourth issue lets two people use the contract to trade locked Shares with each other at any time. All four must be fixed in the contract before rounds hold anyone's real money, even between existing members. After the fixes, rounds still need an outside audit and a securities lawyer's opinion before any public round.

This was an internal review: AI agents reading the code and writing tests. **It is not an audit.** It found serious problems, which shows it was worth doing. It does not show that nothing else is wrong. An outside audit is still required.

---

## How the review was done

- Five angles on `contracts/src/WeeklyRounds.sol` and how it connects to the rest:
  - money held by the contract
  - the clearing price
  - who can call what, and when
  - how it works with the DAO (`MolochPatched`, `ContributorKit`, `FundingTerms`, `Payouts`)
  - economics and MVP fit
- For each finding, two separate checks tried to disprove it. A finding is listed here only if at least one check could not. Most were confirmed by both, usually with a forge test that passes against the current code.
- Where the checks lowered a severity or corrected a number, this page uses the corrected version.
- The proof tests are kept in [weekly-rounds-audit-poc/](weekly-rounds-audit-poc/) (paths in the appendix). They are not in `contracts/test` yet; moving each in, with the fix that makes it fail, is part of the work below.

---

## What a contributor-only MVP would actually be exposed to

Three facts narrow the question:

1. **Contributor DAOs have no funding terms** (D66: budget in Shares only, no raise). So everything below about *funding rounds* does not reach a contributor DAO. It matters only once raises are turned on.
2. **No DAO has rounds until it votes them on.** It then waits 30 days before the first round can open. `ContributorKit` does not name the rounds contract at creation. A new contributor DAO therefore could not trade in its first month anyway.
3. **One rounds contract is shared by every DAO on a chain**, and every DAO's escrow sits in it. A flaw that drains the contract drains everyone's escrow, whichever DAO opened the round.

Point 3 is why the stealing findings block rounds for contributor DAOs too. The attacker does not need to be a member of any DAO.

---

## Findings, in order of how much they matter

### Must fix before rounds hold real value (blockers)

**1. A fake DAO can empty the whole contract.** Critical. Three reviewers found this independently.
`open(dao)` checks only that the "DAO" names this contract as its exchange, and a fake DAO can claim that. The contract then trusts the fake DAO's payout module to say how much payout each unit has earned, and pays that amount out of its own balance.
- **Proof:** an attacker opens a round for a fake DAO, offers 1 unit, then says each unit has earned 1,300 USDC and cancels. They receive all 1,300 USDC of an honest round's bid escrow. Naming a real DAO's Shares as the payout "currency" takes that DAO's 1,000 escrowed Shares the same way. The transfer lock does not stop it, because the transfer comes from the named exchange. Afterwards the honest buyer's claim fails.
- **Impact:** every open and unclaimed round, for every DAO, for gas only. Stolen Shares also carry votes and the right to leave with treasury money.

**2. Fake funding terms can hand out another DAO's escrowed Shares at no cost.** Critical.
`openFunding` trusts whatever funding-terms contract the fake DAO points to, and whatever token it says it is selling. The attacker names a real DAO's Shares, bids at the lowest price, and settles. The "payment" goes to their own fake DAO, so it comes back to them. They then claim the real Shares out of the shared escrow.
- **Proof:** against the real Moloch Shares with transfers locked, the attacker ended with 50 escrowed Shares at a net cost of 0 USDC. The honest seller's claim then failed.

**3. Leaving with a booby-trapped "token" steals payouts owed to other people's escrowed units.** Rated high by both checks (the reviewer filed it as critical).
When someone leaves from escrow, the contract measures its own balance before and after the leave and hands over the difference. The leaver can list a fake token whose transfer function pulls in the payouts held for *other* people's escrowed Shares, during the leave. That money lands inside the measuring window and goes to the leaver.
- **Proof** (200 units, a 20 USDC payout declared while Alice's 50 Shares were escrowed): Mal leaves 1 unit and gets 6 USDC instead of about 1. Alice's 5 USDC of payouts is then paid out of other people's bid money. The contract is left with 15 USDC while Ben is owed a 20 USDC refund. Ben's claim fails until someone donates the 5 USDC shortfall.
- **Applies only if** the DAO has a payout module in the round's currency.

**4. Fake-DAO rounds over a real DAO's locked Shares.** Medium. Same root cause and same fix as 1.
Two people can open a fake round over a real contributor DAO's transfer-locked Shares, on any day, as often as they like, with a floor of 0 and the 20% cut going to their own fake DAO.
- **Proof:** three rounds in one day, 10 locked Shares moved each time, 0.10 to 2 USDC of cut each round sent to the fake DAO. The real treasury got nothing.
- **Effect:** once a DAO names the rounds contract, its transfer lock and the weekly rhythm stop meaning anything.

### Should fix before rounds go to real users

**5. Turning the exchange off strands uncollected rounds.** Medium, though both checks rated it low.
"Turn off Shares sales" (`clearExitExchange`) takes effect at once. Replacing the exchange has the same effect after its 30 days. After that, buyers' Shares and sellers' unsold Shares cannot leave the rounds contract, because Shares are locked again. The sale money is paid in the same transaction, so it is stuck too. The only way out today is to leave at the floor, or to wait for a new vote plus 30 days.
- **Correction to the original report:** the claimed "71% loss" is not caused by the stranding. Once sales are off, a buyer who had already collected faces the same floor. The real harm is:
  - sellers cannot collect sale money without leaving;
  - escrowed votes are frozen;
  - the decision text does not warn anyone.
- **Fix:** pay the money separately from the units, and let a former exchange still send out the units it holds. Or refuse "turn off" while a round holds units. Either way, the decision text should list uncollected rounds.

**6. Leaving from a round pays only USDC.** Low to medium.
The contract refuses ETH, and the app lists only the round's currency. Someone who leaves from escrow loses their share of any ETH or other tokens in the treasury, which goes to the members who stay. In the test, Ben gave up 0.25 ETH.
- The other-token part is an app fix: list every token the treasury holds, the way the exit screen already does.
- The ETH part needs a contract change.

**7. The round card's wording is wrong about the floor.** Low to medium. This is a wording fix.
The card says the price "never goes below what leaving the project pays". The floor is actually read once, when the round opens.
- **Proof:** if 200 USDC lands in the treasury during bidding, a seller at 1.02 receives 50.80 for Shares that leaving would have paid 100 for, and the buyer leaves with 100.05.
- **Fix:** change the wording to "never below what leaving paid when the round opened", and warn sellers with live offers when the floor rises past their price. Optionally, check the floor again at settle.

**8. Rounds work poorly for an empty treasury, which is every contributor DAO.** Low, but it decides product fit.
With no USDC in the treasury, leaving pays 0, each price step is one cent, and the highest possible price is 10.23 USDC per Share. A seller offering at 0 can give Shares away whenever offers exceed bids. The 20% cut becomes 20% of the whole price.
- For a project worth more than about 10 USDC a Share, rounds cannot show its price.
- **Fix:** a step size suited to each project, or steps that grow as the price rises, and no sell orders at 0 when the floor is 0.

**9. The buyer is never told what they are buying.** Low. This is a wording fix.
The round card shows what leaving pays. It does not say:
- that bought Shares cannot be sent to anyone and can only be sold in a later round;
- that they carry votes;
- that contributor DAOs can award new Shares with no yearly limit;
- that a buyer may get back far less than they paid.

Only the funding card has a "Before you buy" section.

**10. Votes can be bought.** Info. This is a product decision.
Rounds are the one path by which a contributor DAO's locked, voting Shares change hands. One buyer can collect a majority over a few rounds. With awards uncapped, control then includes the power to dilute everyone else. Members opt in by vote, and leaving always works, so this is not a defect. But it cuts against "contributors keep control" (D133) and the app does not mention it.
- **Options:** sell non-voting Loot in holders' rounds, cap what one buyer can take, or at least say it plainly in the decision text.

### Funding rounds only (not reachable by contributor-only DAOs)

These matter only once raises are turned on.

**11. A funding round that clears at its lowest step almost never settles.** Medium.
The price step is rounded down but settle checks a full 2%, so step 2 passes only when the floor is an exact multiple of 100 base units.
- **Proof:** with a floor of 1,000,050 or 1,234,567, settle fails with a misleading "below what leaving pays" error. The round goes void and the next try is a week later.
- **Fix:** compute the lowest step the same way at opening and at settle. Add a fuzz test over floors that are not multiples of 100.

**12. One wei of ETH sent to the DAO blocks every funding settle.** Medium.
The vote to accept a token does not cover ETH. Anyone can repeat this every week. A holder can do the same with a junk token they flag. This repeats R1/R2 from FUNDING-REVIEW-2026-10-31; the new detail is that ETH cannot be accepted. No money is lost, because the round goes void and buyers are refunded.

**13. Funding terms fix the rounds contract forever.** Low.
A DAO that publishes terms naming today's rounds contract can never move to a fixed one. **Deploy the fixed contract before any DAO publishes funding terms.**

**14. Smaller funding issues.** Low.
- Units can be created up to 5 days after a tranche's voted end date.
- A void round that nobody has finished makes the DAO's own tranche votes fail until anyone calls `finishFunding`. That is already designed, and the app has the button.

### Low and informational (fix when convenient, or document)

- **USDC blocklist.** If USDC blocklists the DAO's address, sellers who sold above the floor cannot claim until the block is lifted, because their cut is pushed to the DAO in the same transaction. Fix: let the DAO pull its cuts.
- **Wrong tie-break claim.** WEEKLY-ROUNDS.md:25-26 says that among equal volumes the rule favours sellers. It does not: ties and excess supply clear at the *lower* price. Fix the sentence.
- **Dead votes in escrow.** Escrowed Shares keep their votes inside the rounds contract, where they can never be cast, and still count in the quorum base. Fix: exclude the rounds contract in the same vote that turns rounds on.
- **Spoofed live price.** "If bidding ended now" can be spoofed by a large bid cancelled in the last second. With few sellers, a buyer usually pays their own highest price. Fix: say both on the bid form.
- **1-wei wash trade.** For 1 micro-USDC, a self-trade of 1 wei prints a "Last trade" at the top price. Fix: ignore tiny rounds in the last-trade and history lines.
- **DAO selling its own Shares.** This lowers what leavers get while those Shares are in escrow. The issuance rule makes it unreachable in kit DAOs. Simplest fix: refuse DAO sell orders.
- **Settle timing.** Whoever settles decides whether payouts waiting in the module go to the seller or the buyer. The amount is small and either side can act first. Document it.
- **Rounding dust.** A few millionths of a dollar per round stays in the contract. This surplus is part of what keeps the contract solvent. Leave it as is.

---

## What it would take to ship rounds, in order

1. **Wording and app fixes (can start now, no contract change):**
   - the floor wording (7);
   - a buyer "Before you buy" list (9);
   - vote and dilution wording on the decision and bid forms (10);
   - list every treasury token when leaving from a round (6);
   - an uncollected-rounds warning on "Turn off Shares sales" (5);
   - hide tiny rounds from the last-trade line;
   - fix the tie-break sentence in WEEKLY-ROUNDS.md.

2. **Contract fixes (needed before anyone's real money is in escrow):**
   - **(1, 2, 4) Only real DAOs.** Accept only DAOs made by our own summoner or kits, and check that `Shares.DAO() == dao`. Read the payout module once at open, check it came from the payouts factory for that DAO, and store it in the round. Require `terms` to be the one known `FundingTerms`, and the sold token to be that DAO's own Shares or Loot.
   - **(1, 2, 3) Per-round bookkeeping.** For each token, track what each round received. No round can pay out more of a token than it took in, and payouts passed on are capped at what was actually withdrawn from that module.
   - **(3) Stop paying "whatever the balance went up by".** Best: give the DAO a leave that pays the holder directly, callable only by the named exchange for units it holds. At least: withdraw owed payouts first, and accept only the round's currency plus tokens the DAO has accepted.
   - **(5)** Pay money separately from units, and keep undeliverable units as owed and collectable later. Or let a former exchange send out escrow.
   - **(6)** Accept ETH from the DAO during a leave and forward it.
   - **(8)** A minimum price when the floor is 0, and a step size suited to each project.
   - **(11, 12) Before raises:** make the step arithmetic match at opening and at settle; ignore ETH and token dust; let ETH be accepted.

3. **Tests to add** (move the scratch proofs into `contracts/test` as regression tests):
   - a fake DAO with a lying payout module;
   - fake funding terms naming another DAO's Shares;
   - a callback "token" during leaving;
   - the exchange cleared, then sellers collect their money;
   - ETH in the treasury when leaving from a round;
   - a fuzz test of floors that are not multiples of 100;
   - an invariant: for every token, the contract's balance is at least what all its rounds still owe;
   - entries in `scripts/contracts-mutation-check.mjs` for each new check, so that removing a guard fails a test.

4. **An outside audit** of `WeeklyRounds`, `FundingTerms`, `Payouts` and the `MolochPatched` changes they rely on: exit exchange, transfer lock bypass, exit fee and `mintForFunding`. AUDIT-SCOPE.md lists them as test-network contracts today. They must move into the audited scope.

5. **Legal review.** Rounds are public sales of voting Shares for USDC. The platform matches orders, publishes prices and keeps the order book, and the DAO takes a cut of every gain. That probably counts as offering securities and running a market for them, which can bring in rules on exchanges or brokers, buyer checks (KYC, sanctions), tax reporting and disclosures, in the US, the EU and elsewhere. A securities lawyer has to sign off before any public round. Restricting by country or by type of buyer may be needed.

6. **Deployment and gating:**
   - deploy the fixed contract, and do it before any DAO publishes funding terms (13);
   - choose the step size per project size;
   - update the "for test networks" NatSpec and the docs;
   - keep `VITE_WEEKLY_ROUNDS` off in the hosted image until steps 1 to 5 are done. Turning it on also needs `VITE_CHAIN_RPC_URL`.
   - Someone has to settle each round within 2 days, or it goes void.

---

## Recommendation

**Launch the MVP without weekly rounds.** This matches D137 and the current hosted build. Nothing in the contributor MVP depends on them.

Options in between, from safest to least safe:

- **Test-network pilot only (recommended next step).** Keep running rounds on Sepolia with test money. Fix blockers 1 to 4 before inviting outside testers, because anyone on the test network can empty the current contract. That breaks the pilot even if the money is fake.
- **Rounds only between existing members.** This does not help on its own. The theft in findings 1 to 3 needs no membership, and the contract cannot limit buyers to members today. Such a limit could be added later, after the fixes, as a way to reduce legal exposure: it is a private, members-only secondary market rather than a public one. It still needs the lawyer.
- **Rounds with real money:** only after the contract fixes, the new tests, an outside audit, a legal opinion and a fresh deployment.

---

## Appendix: proofs

In [weekly-rounds-audit-poc/](weekly-rounds-audit-poc/), file names flattened (`poc/test/Poc.t.sol` is `poc_test_Poc.t.sol`):

| Finding | Test |
|---|---|
| 1 (fake DAO drains escrow) | `poc/test/Poc.t.sol` `test_fake_dao_drains_every_round_escrow` |
| 2 (fake funding terms) | `fakedao/test/FakeDaoReal.t.sol` `test_fake_dao_steals_real_escrow` (real Moloch Shares); `poc/test/Poc2.t.sol` (mock tokens) |
| 3 (callback token) | `funds-lens/test/FundsLens.t.sol` `test_leaver_steals_escrowed_payouts_and_strands_a_refund` |
| 4 (anytime trading of locked Shares) | `proj/test/FakeDaoRound.t.sol`; `fd-schedule/test/FakeDaoSchedule.t.sol` |
| 5 (exchange turned off) | `funds-lens/test/ClearedExchange.t.sol`, `funds-lens/test/ClearedExchangeRefute.t.sol`, `strand/Strand.t.sol` |
| 6 (ETH left behind) | `eth/test/EthLeave.t.sol` |
| 7 (floor read at opening) | `ZZStaleFloorPoc.t.sol` |
| 8 (empty treasury) | `ScratchEmptyCap.t.sol` |
| 11 (step 2 cannot settle) | `price-lens/test/Price.t.sol`, `step2/test/Step2.t.sol`, `v2/test/Step2.t.sol` |
| 12 (1 wei of ETH) | `eth1wei/test/Eth1Wei.t.sol`, `OneWeiEthPoc.t.sol`, `t/Dust.t.sol` |
| USDC blocklist | `blockproj/test/Blocklist.t.sol`, `Blk.t.sol` |
| Escrowed votes | `ZzScratchEscrowVote.t.sol` |
| Funding expiry | `ws/test/Expiry.t.sol`, `Expiry.t.sol` |
| Wash trade | `Wash.t.sol` |
| Settle timing | `proj/test/SettleTiming.t.sol` |
| DAO selling its own Shares | `proj/test/DaoEscrow.t.sol` |

Housekeeping: untracked symlink loops `contracts/src/src` and `contracts/lib/lib` appeared in the repo during the review, left by another agent's scratch setup. Delete them before committing.