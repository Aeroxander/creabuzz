# Team pay: Shares owed later, or token options

Design note for the owner, 18 November 2026. Nothing here is built, live or signed. **This is not tax or legal
advice.** The writer is not a lawyer or tax adviser. Every legal or tax point below is a reading of a public source, with
its link, for a Puerto Rico tax adviser, US counsel and Marshall Islands counsel to check. Labels: *firm* (the source
says it plainly), *judgement* (our reading), *open* (nobody has answered it yet), *estimate* (not built or measured).

## 1. The owner's question

The owner of Creaton (project zero, Shares = CREATE) made no 83(b) election. They take their team Shares as active income
in their Puerto Rico LLC, which invoices the Marshall Islands DAO LLC (CREATE's issuer, still to be formed) every month.
Project zero's team budget, 52,989,394 Shares (5.30%), sits in the Treasury at launch, earmarked and public. The DAO
LLC's manager pays it out monthly over about 2 to 3 years with `payTeam`, which follows the Give Shares rules: before
the market the Shares go into the Vester and release over 365 days from market open; after the market they arrive free
at once, inside the shared cap of 1% of Shares in people's hands per 30 days. They ask: could Shares work like stock
options, so that receiving them does not trigger tax at once when they cannot be sold yet? The same tool should work for
teammates, advisors and paid contributors on any project.

**Short answer.** Yes, but not by holding Shares in the Vester. A rule that only stops a sale does not delay US tax. Tax
waits only if the Shares can still be lost, or if the person holds only an unfunded, unsecured promise. The tool that
fits is **Shares owed later** (like a restricted stock unit): a public promise, no Shares set aside per person,
delivered after the market opens. Token options fit worse. Nothing should be built before counsel answers section 8.

## 2. Why held Shares can be taxed now (US rules)

- *Firm.* Property received for services is taxed in the first year it is transferable or not at substantial risk of
  forfeiture, valued ignoring restrictions that will lapse (IRC 83(a), https://www.law.cornell.edu/uscode/text/26/83).
  The risk must come from a service condition or one tied to the transfer's purpose; Example 6 treats a lock-up as no
  such risk (Reg 1.83-3(c)(1), (c)(4), https://www.law.cornell.edu/cfr/text/26/1.83-3).
- *Firm.* "Property" leaves out "an unfunded and unsecured promise to pay money or property in the future" but includes
  assets "transferred or set aside from the claims of creditors", for example in escrow (Reg 1.83-3(e), same link;
  rabbi-trust practice, Rev. Proc. 92-64, https://benefitslink.com/src/irs/revproc92_64.html).
- *Firm.* Tokens received for services are income at fair value when received: self-employment income for contractors,
  wages for employees (Notice 2014-21, A-10, A-11, https://www.irs.gov/pub/irs-drop/n-14-21.pdf). With no market
  price, value comes from the services (https://www.irs.gov/individuals/international-taxpayers/frequently-asked-questions-on-virtual-currency-transactions).
- *Judgement.* Today's pre-market path (`_gift` → `vester.grant`) puts Shares in a contract that pays only that person
  and can never take them back (project zero has no founder grant to trim). That looks like escrow, so for a US taxpayer
  it is very likely taxed at grant value although it cannot be sold. An 83(b) election changes nothing: it matters only
  for property that can still be lost (Reg 1.83-2, https://www.law.cornell.edu/cfr/text/26/1.83-2).
- *Judgement.* On other projects, `Vester.trimFounder` (a departing founder keeps days served / 365) is a service-based
  forfeiture, so a US founder's 83(b) election within 30 days of launch may be a real choice (copy to the payer: Reg
  1.83-2(d)).
- **So:** never tell anyone that a pre-market gift "is not taxed until it can be sold".

## 3. The two tools, and how monthly invoices map onto each

**A. Shares owed later.** A public on-chain promise: N Shares to this address on these dates after CREATE's market
opens. No Shares move per person until delivery; the Shares stay in the team budget or work pot as DAO assets.

- *Firm.* Restricted token units are taxed at settlement, at the value then, with no 83(b) election (EisnerAmper,
  https://eisneramper.com/insights/cryptocurrency-insights/restricted-token-units-tax-considerations-0125).
- *Firm.* Under section 409A a risk of forfeiture can be "a condition related to a purpose of the compensation", with
  "completion of an initial public offering" as the example; payment by the 15th day of the third month after the year
  the risk lapses is a short-term deferral (Reg 1.409A-1(b)(4), (d)(1), https://www.law.cornell.edu/cfr/text/26/1.409A-1).
  *Judgement:* "CREATE's market opens by a long-stop date" is close to the IPO example, as in double-trigger RSUs
  (https://www.bakermckenzie.com/-/media/files/insight/guides/2022/doubletrigger-rsus-and-the-question-of-the-sevenyear-term.pdf).
- *Firm.* A risk of forfeiture added after the right to the pay exists is disregarded (Reg 1.409A-1(d)(1), same link).
  So a dollar invoice for a finished month must **not** be converted into units afterwards. The form of pay must be
  fixed in the pay agreement before the service period starts.

**B. Token options.** A right to buy N Shares at a fixed price later.

- *Firm.* An option with no readily ascertainable fair value is taxed at exercise, not grant (Reg 1.83-7,
  https://www.law.cornell.edu/cfr/text/26/1.83-7). But 409A's option exclusion covers only options on "service
  recipient stock" with a strike never below fair value at grant (Reg 1.409A-1(b)(5), link above), and tokens are
  probably not such stock (https://www.toku.com/article/why-can-token-option-agreements-be-problematic-under-us-law;
  https://www.thelawverse.com/p/read-the-fine-print-token-compensation). Orrick keeps token warrants for investors, not
  staff or advisors (https://blogs.orrick.com/blockchain/?p=487).
- The holder pays the strike. 52,989,394 Shares at the 6M round price (0.006 a Share) would cost the owner 317,936
  dollars to receive their own team budget (arithmetic). That is a purchase, not pay.

**Example, 52,989,394 Shares over 30 months** (arithmetic): 1,766,313 Shares a month, worth about 10,598 dollars a
month at 0.006 (about 7,524 at the 4.26M blended price of 0.00426; about 707 at the 0.0004 auction floor).

| | Tool A, Shares owed later | Tool B, token options |
|---|---|---|
| Agreement | Signed before the period: "1,766,313 units for month M, delivered on dates D after the market opens, lapse if no market by L" | "Option over 1,766,313 Shares at strike K, exercisable only after the market" |
| Each month | One `owe()` record, no Shares move | One `grantOption()` record |
| Invoice | States units, not dollars | Does not settle an invoice; the holder pays K |
| Tax (US, judgement) | At delivery, at value then | At exercise, on the spread, but 409A risk |
| After the market | Keep using `payTeam`: free Shares can be sold to pay tax | Same |

## 4. Puerto Rico points (needs a Puerto Rico tax adviser)

- *Firm.* A bona fide Puerto Rico resident for the whole year excludes Puerto Rico-source income from US income tax
  (IRC 933, https://www.law.cornell.edu/uscode/text/26/933; residence tests, https://www.law.cornell.edu/uscode/text/26/937).
  Pay for services is sourced where the work is done; US days are US-source (Reg 1.937-2,
  https://www.law.cornell.edu/cfr/text/26/1.937-2; https://www.hklaw.com/en/insights/publications/2025/11/puerto-ricos-act-60-income-sourcing-and-irs-scrutiny).
- *Firm.* US self-employment tax still applies to a bona fide resident if their LLC is disregarded or a partnership for US
  purposes (IRC 1402(a)(6), Form 1040-SS, https://www.irs.gov/pub/irs-pdf/i1040ss.pdf).
- *Firm.* Act 60 export services: 4% fixed tax on eligible export-services income, 100% exemption on distributions from
  it (https://reichardescalera.com/wp-content/uploads/2021/10/March-9-2020-Tax-Incentives-for-Export-Services-and-Export-Commerce-under-the-Incentives-Code.pdf).
- *Firm, urgent.* Act 38-2026: Individual Resident Investor applications received by **31 December 2026** keep 0% on
  gains accrued after residency until 2035; from 1 January 2027 the rate is 4%. The decree does not cover pay for
  services (DDEC Bulletin 2026-004, https://docs.pr.gov/files/DDEC/Aviso%20Pu%CC%81blico/Informative%20Bulletin%20DDEC%20NO.%202026-004%20Final.pdf;
  https://reichardescalera.com/wp-content/uploads/2026/03/Tax-Update-PR-Amends-the-Incentives-Code-for-Resident-Individual-Investors.pdf).
- *Open.* We found no primary Puerto Rico rule like section 83. When Puerto Rico taxes their LLC on Shares (at invoice on
  the accrual method, at delivery on the cash method, or at grant) is the real question for them.
- *Judgement.* For them, deferral may be worth little: 4% of about 10,598 dollars a month is about 424 dollars a month at
  a low pre-market value. The US tool matters mostly for US-taxed teammates and advisors. They manage the DAO they invoice,
  so arm's-length pricing needs records (https://www.hklaw.com/en/insights/publications/2026/06/act-60-tax-compliance-irs-scrutiny).
- *Open.* The opposite route: add a service-based forfeiture to the pre-market gift, so an 83(b) election at the low
  value becomes possible. The Puerto Rico adviser should weigh it.

## 5. Contract design (estimate; nothing built, no build run)

### A. Shares owed later (reshaped after the attack review, section 6)

In `Treasury.sol`, beside `giveShares` and `payTeam`, after the other engineer's team-budget and EarlierBackers changes
land. No Launcher or Vester change.

- Storage: `struct Owed { address to; uint96 amount, delivered; uint40 recordedAt, workUntil, expires; uint32 afterOpen;
  bool fromTeam, premarket; uint8 status; }` in `mapping(uint256 => Owed) owed`. No reservation counter by default.
- `owe(to, amount, fromTeam, afterOpen, workUntil, expires, terms) returns (id)`: runner only, never an agent. The
  grant date is `block.timestamp`, emitted; no past dates. `terms` is the hash of the signed pay agreement. After the
  market, the 1%-per-30-days gift cap is charged here, at recording, not at delivery.
- `deliverOwed(id)`: anyone; Shares go only to `to`. Each award runs on its own 365-day clock, the Vester formula:
  deliverable = amount × min(now − (start + afterOpen), 365 days) / 365 days − delivered, with partial deliveries.
  It draws from `teamBudget` or `workPot`; if the source is short it reverts and can be retried.
- `forfeitOwed(id, reason)`: runner only, before `workUntil`, taking back only the part not yet served (pro rata, like
  `trimFounder`), after a 14-day notice the recipient can see. Ending moves no Shares: none were set aside.
- `declineOwed(id)`: recipient only, and only before the market opens.
- `lapseOwed(id)`: anyone, at or after `expires`, if no real market (`poolOpen && !noMarket && !abandoned`) came.
- `proposeTo` / `applyTo`: the recipient (never the runner) moves the award to a new address in two steps with a 30-day
  wait, like EarlierBackers' `proposeHolder` / `applyHolder`.
- Views: `dueNow(id)`, `owedOutstanding(premarket)` for the auction page, sale summary and chain reader.
- Events `SharesOwed`, `OwedDelivered`, `OwedEnded(id, why, amount, reason)`; errors `NoMarketYet`, `NotDue`,
  `OwedClosed`, `AlreadyServed`, `NotLapsed`, plus the existing `WorkPotShort`, `TeamBudgetShort`, `BadInput`.

**Guards** (each with a test that fails when the guard is removed, listed in `scripts/mutate-guards.py`): OW01 runner
only. OW02 `to` passes `_checkGift`. OW03 amount at most the source when recorded. OW04 now < expires ≤ now + 10 years,
afterOpen ≤ 5 years. OW05 no delivery before a real market (nothing ever goes to the Vester). OW06 per-award clock.
OW07 Shares only to `to`. OW08 cap charged at recording after the market. OW09 each part delivered or ended once. OW10
forfeit only the unserved part, before workUntil, after notice. OW11 decline only by `to`, before the market. OW12 lapse
only if no market by expiry. OW13 nothing amends amount or dates; no early payout. OW14 no re-award within 12 months of
a decline or forfeit without a second signer. OW15 awards to the runner or a Pair signer need a second signer. OW16 for
a US person, `workUntil` at or after each delivery date (457A, section 6).

**How owed Shares count.** Until delivery they stay in the Treasury, outside `countingSupply`: no floor slice, no
hand-back, no vote. Hand-over: awards survive; a new runner may cancel, within 30 days, unsigned awards from the 30 days
before.

**Tests.** Recording from each source, short-source reverts, agent refused, `countingSupply` and `reserve()` exact; no
delivery before a market or after noMarket/abandoned; `NotDue` one second early; a stranger delivers to `to`; fuzz that
no award exceeds its own linear schedule; deliveries never blocked by other gifts; partial forfeit equals the unserved
part; decline refused after the market; lapse refused once a market opened in time; short-source delivery retries;
address change waits 30 days; ABI test that nothing amends dates. Invariant: a delivery lowers `teamBudget` or `workPot`
by exactly what it sends; open awards are claims, not balances. Add the events to the M5 chain reader and the app.

**Size** (estimate from artifacts older than the current sources; forge not run): about 90 to 110 lines, Treasury
runtime +2.0 to 2.8 KB (14.5 of 24.6 KB). The binding limit is Parts' creation code (41,799 of 49,152 bytes), which
embeds the Treasury and about 7.8 KB of EarlierBackers code; the other engineer could pass that code hash in instead.

### B. Token options (not recommended)

`grantOption(holder, amount, fromTeam, sharesPerRawDollar, start, expiry, workUntil, terms)`, `exercise(id, n)` (holder
only, after a real market; pays ceil(n / price) through `_pull`, split 3 platform / 15 spendable / 82 floor, inside the
1% cap), `forfeitOption`, `lapseOption`, view `strikeFloor()` (latest round price, then clearing price). Guards OP01 to
OP17 mirror A plus strike, exercise-window, cost and split checks. About 100 to 130 lines, +2.4 to 3.4 KB; with A, Parts
would keep about 1.6 to 3.3 KB (estimate).

## 6. Attack review: what broke and the fix

| Finding | Failure | Fix (in section 5) |
|---|---|---|
| Shared pre-market pace allowance | Runner pads it with a large award they later forfeit; their own award arrives ~10× faster than 365 days | Per-award 365-day clock |
| `owe()` unlimited after the market | Runner about to be replaced promises the whole work pot and budget to themselves | Cap charged at recording; second signer for self-awards; successor cancel window |
| Reservation counter + no amendment + only-to-`to` | Looks like escrow (Reg 1.83-3(e)); whole award taxed when the market opens | No per-person reservation unless counsel approves in writing |
| Converting finished-month dollar invoices | Late condition disregarded (Reg 1.409A-1(d)(1)); 409A 20% additional tax | Units fixed in the agreement before the period; no per-grant choice for recipients |
| Section 457A ignored | For a "nonqualified entity" only future service counts; units taxed when served (https://www.law.cornell.edu/uscode/text/26/457A) | US persons: service continues to each delivery date, or paid through another entity |
| Decline and re-award, blocked deliveries | Payee picks the tax year (Reg 1.409A-3(d), https://www.law.cornell.edu/cfr/text/26/1.409A-3); cap griefing | No decline after the market; 12-month re-award block; cap at recording; income arises at the due date (Reg 1.451-2(a), https://www.law.cornell.edu/cfr/text/26/1.451-2) |
| Backdated `at` | Delivery pulled forward; wrong grant-date values | Grant date = block time |
| Whole-award forfeit by a successor | Served months taken back after a replace vote | Pro rata, 14-day notice |
| Hidden overhang | Auction bidders miss owed Shares | `owedOutstanding` shown with held overhang |
| Lost wallet | Shares delivered to a dead address | Recipient's two-step address change |
| B: strike floor, budget, fees | Runner opens a 1-dollar round at 3,000 Shares a dollar, grants themselves options at 0.000333, then exercises and hands back for ~8× strike from the melting floor; budget tied up 10 years; 15% of the strike returns to their spendable; a new platform fee | Do not build B |
| Cited sources | The 4%-president example is in Reg 1.83-3(c)(3), not 1.409A-1(d)(3); the 83(b) copy rule is 1.83-2(d); A is also a securities offer, and Rule 701 covers natural persons only (https://www.law.cornell.edu/cfr/text/17/230.701) | Corrected here |
| "Any project" | Another project has no entity or a different one; the tax analysis does not carry over | No tax claim in the app: "This is a promise to deliver Shares later. When tax applies depends on your situation and your project's legal entity. Get advice." |

## 7. Recommendation (judgement, not advice)

1. **Now, all projects:** Give Shares and Pay team screens and pay agreements must never say held Shares are untaxed
   until they can be sold. No contract change.
2. **Project zero now:** keep `payTeam` unchanged. Before choosing tax now or later, have the Puerto Rico adviser answer
   the timing and LLC-type questions, and raise the 31 December 2026 investor-decree deadline this month. Consider
   stating the monthly invoice in units, in an agreement signed before each period.
3. **Build first: tool A, reshaped as in section 5**, as the shared tool for teammates, advisors and paid contributors
   on every project, from the team budget (project zero) or the work pot (any project). Build only after US counsel
   approves the 409A and 457A shape and the Puerto Rico adviser answers the timing question. Until then, the zero-code
   fallback is a signed off-chain unit letter paid after the market with `payTeam` or Give Shares.
4. **Do not build tool B.** If counsel ever wants advisor options: a strike field on the A record, at least the highest
   round price of 12 months, the clearing price and an independent valuation; exercise only after the market.
5. Nothing reaches a real network before counsel and the outside audit.

## 8. Questions

**Puerto Rico tax adviser.** (1) Does the 2011 Code have a rule like IRC 83 (transferable or at risk of forfeiture, an
83(b)-style election, unfunded promises not taxed)? Which section? (2) My LLC invoices the DAO LLC monthly and is paid in
CREATE Shares. If they sit in a contract that can pay only my LLC over 365 days after a market opens, is it taxed at
invoice, when they are set aside, or at delivery? Does the cash or accrual method change that? (3) If the agreement
states units owed later instead of dollars, when and on what value am I taxed, and how is a Share with no market valued
(the 0.006 round price, lower because team Shares have no refund right, or an appraisal)? (4) Is my LLC a corporation
or a partnership in Puerto Rico, and how does that change the 4% rate and the 100% distribution exemption? (5) Is pay
in tokens export-services income under my decree, and does managing the DAO from Puerto Rico create a Puerto Rico nexus
or a Puerto Rico business for the DAO? (6) If my LLC holds Shares and later sells or distributes them, how is each
taxed? (7) Should I apply for an Individual Resident Investor decree before 31 December 2026, and does the Oversight
Board question affect Act 38-2026? (8) What withholding, informative returns (480.6A/B) and arm's-length records are
needed? (9) Would a service-based forfeiture on pre-market Shares, with an 83(b)-style election at the low value, cost
less than tax at delivery?

**US counsel.** (1) Am I a bona fide Puerto Rico resident under IRC 937, and is all my DAO work Puerto Rico-source,
including days in the US? (2) Is my LLC disregarded, a partnership or a corporation for US purposes, and what
self-employment tax or Form 5471/8858 filings follow? (3) For US-taxed teammates, is a pre-market Vester grant property
transferred at grant under Reg 1.83-3(e), and is the earmarked team budget "set aside" for anyone? (4) Is an award on
the Treasury's general budget, with no per-person reservation, an unfunded and unsecured promise, and what must the DAO
keep for that to hold? (5) Does "CREATE's market opens by a long-stop date" count as a 409A risk of forfeiture like an
IPO, given I manage the DAO and partly control whether the market opens? Which long-stop and delivery window keep
short-term deferral? (6) Is the Marshall Islands DAO LLC a "nonqualified entity" under IRC 457A? If so, must units for
US persons require service until each delivery, or should US persons be paid through another entity? (7) Are token
options over CREATE outside 409A's option exclusion, and if ever granted, what exercise rules and valuation? (8) What
US reporting and withholding does the DAO LLC have when it pays US contractors or employees in Shares (W-9, 1099-NEC,
W-2), given Reg 1.6041-4(a)(2) (https://www.law.cornell.edu/cfr/text/26/1.6041-4)? (9) Is a grant of units to my PR
LLC an offer of securities, and which exemption applies, given Rule 701 covers natural persons only? (10) Should
founders of other projects be told about an 83(b) election within 30 days of launch because of `trimFounder`?

**Marshall Islands counsel.** (1) Does the DAO LLC have any withholding, reporting or gross-revenue consequence when it
pays non-resident contractors in its own tokens or records units or options? Please confirm the 3% gross revenue tax
base against the DAO Act and the Income Tax Act 1989 (we have only a secondary source:
https://www.legal500.com/intelligence/marshall-islands/transport/exploring-the-marshall-islands-dao-llc-a-revolutionary-dao-legal-structure).
