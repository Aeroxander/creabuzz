# Creaton's earlier backers: from the old SAFTs to CREATE Shares

Design note for the owner, 18 November 2026. Nothing here is built, live or signed. Nothing goes on a real network before
the outside audit and counsel. Labels: *measured* (from built contracts or tests), *simulated* (Python under
`docs/next-version/econ/`, run with `python3 -I`), *judgement*. Scripts: `saft_sheet.py` (sizes, options, market),
`earlier_claim.py` (claim contract accounting), `saft_legal.py` (rates, votes), `earlier_backer_list.py` and
`earlier_backer_journey.py` (list checks, presses). This note holds totals and counts only: no names, no addresses, no
single backer's amount. The working sheet with names and addresses is private and stays outside the repo.

## 1. What the owner told us

- Creaton is project zero; its Shares are CREATE. It raised before the platform existed, under SAFTs signed with an
  older LLC of the owner's, for an old 110,000,000-token supply and a Doppler launch. Doppler is no longer used: backing
  rounds, the one auction and the pool replace it.
- Raised (the sheet): seed 177,500 dollars from 3 entries at 0.02 = 8,875,000 old tokens; private 1,052,457 from 18
  entries at 0.046 = 22,879,500 old tokens. Total 1,229,957 dollars, 31,754,500 old tokens = 28.868% of the old supply.
- Price for the whole supply: seed 2.2M, private 5.06M, blended 4.26M. The "6M valuation" was the price of a third
  tranche ("Private 2", 0.055) that shows no sales. So "Creaton raised at 6M" in FOUNDER-PRICE.md is not right.
- The owner bought some seed tokens themselves and will put them back ("into the DAO/team treasury").
- The sheet's list: 2 entries share one address; 1 address has a line break inside it (invalid as typed); 6 entries
  have no address (all 3 seed among them); 2 private entries (320,100 dollars) are marked DONE. So 10 entries are clean
  as typed. Sheet formulas: the circulating total skips one row (its value was 0); one listing cell points at an empty
  cell; prices are typed as text; the "Private 1" amount (26M) disagrees with the allocation line (23M).
- Each backer will sign that the SAFT is cancelled and a Marshall Islands DAO LLC issues CREATE Shares instead.
  Backers were mainly promised a web3 social media with monetization.

**Still unknown:** whether any price was before or after the money; the exact final list (who, which wallet, the
owner's own amount); which law governs the SAFTs and what they say on amendment, assignment and dissolution; any side
letters, discounts or bonus terms; whether any backer already got anything (the DONE marks); the old LLC's state and
standing; where the money is now.

## 2. The problem in one paragraph

Keeping each backer's percent (S1) is 288.68M Shares, 28.87% of all (simulated). Counting all the money at 6M (S2) is
204.99M (20.50%). The plan's answer, work-pot Shares through Give Shares, cannot carry either: the whole work pot is 200M
and it also has to pay advisors and every future contributor. So the Shares must come from somewhere else, and wherever
they come from changes who holds what when Creaton's market opens.

## 3. Options and recommendation

Sizes (simulated, `saft_sheet.py` 1): **S1** keep their percent, 288.68M (seed 80.68M, private 208.00M; 0.00426 a Share,
4.26M for the whole project). Mapping each group at its own old price gives exactly S1. **S2** all money at 6M after the
money, 204.99M (a 29% cut each backer must sign). **S2p** 6M before the money, 170.12M (a 41% cut).

| Source (at S1 unless marked) | Founder keeps | Reserve after market | Held at market, x the pool's 55M | 30 days of held release sold | Floor per Share, day 180 | Day-365 voters: auction / backers / founder | Contract change |
|---|---|---|---|---|---|---|---|
| No earlier backers (baseline) | 20% | 286.67M | 222.88M, 4.05x | -43.4% | 18.3% | 53 / 0 / 42% | - |
| A. Founder's grant only | short 88.68M (fits only S2p: 2.99%) | 286.67M | 4.05x | -43.4% (S2p) | 18.3% | 53 / 36 / 6% (S2p) | Launcher split |
| B. Work pot only (Give Shares) | short 88.68M (S2: short 4.99M) | 286.67M | 7.69x | - | - | - | none |
| C+. Unused backing, reserve, then founder | 15.30% | 45M | 464.55M, 8.45x | -64.9% | 14.2% | 35 / 40 / 21% | Launcher, reserve power for project zero |
| **D. Unused backing (141.67M), then founder** | **5.30%** (S2: 13.67%) | **145M** | **364.55M, 6.63x** | **-57.8%** | **15.7%** | **41 / 47 / 9%** | **Launcher cut + claim contract** |

All simulated (`saft_sheet.py` 3 to 7) except the share sizes (arithmetic on the sheet). A default project holds 370M at
market (6.73x). Creaton keeps 8.33M backing for its own 6M rounds (the 50,000 Team cap, measured).

**Recommendation (judgement): D at S1, for project zero only, paid through a claim contract.**
- S1 is what the backers bought; it needs no repricing signature. The step from 4.26M to Creaton's 6M rounds (1.41x)
  is a normal step for people who took the risk years earlier with no refund.
- D is the only route that pays S1 without emptying the reserve or the work pot. Every extra Share for the backers
  comes from the founder's own grant, so whoever builds the list pays for any padding.
- Honest framing: against Creaton's own baseline, D raises held Shares at market from 222.88M to 364.55M and lowers the
  reserve after the market from 286.67M to 145M, because unused backing would otherwise have joined it. The overhang
  equals a default project's, not less.
- After one year the backers are the biggest bloc (47% of voters) and, with the founder, a majority. The owner can be
  out-voted, including on replacing the runner.
- Project zero only: as a rule for every founder, an unchecked "earlier raise" would be a free route to fill 150M
  backing Shares into one's own accounts and to escape the founder trim. If an outside founder ever needs it: charge the
  3% fee on the declared money and cap it at 3,000 Shares a dollar (the lowest price), checked by counsel.
- Fallback: S2 with each backer's written consent (founder 13.67%, same market numbers).
- Owner's own seed purchase: left off the list. Each 10,000 dollars of it is 4.55M Shares the founder keeps (simulated).
- Release: the one clock, evenly over 365 days from market open, no refund. Never faster. The old sheet's steps would
  free 72.17M on one day (-81% if sold) (simulated); the agreement must say this is slower than the 3 to 7 months promised.

## 4. The signed SAFT swap

**Route (for counsel; legal lane option 1):** one three-party agreement per backer: the SAFT ends with a mutual release
and the New Issuer grants a fixed number of Shares. The old LLC and the New Issuer sign a standing offer for each entry
first, so **the backer's signature is the last act** and nothing can lapse after Shares move. Every backer gets the same
text. A new text version is allowed only for counsel's non-material fixes, or it is offered again to everyone.

**Signing and storage:** two signatures, a conventional electronic signature on the text and one wallet signature over
the single typed-data message the claim contract checks (section 5). The app shows the text and its fingerprint side by
side. The server keeps, append-only: the text (stored once; its fingerprint must match), the typed data, the signature,
the recovered signer or contract-wallet check, where the Shares go, the time, and any void or replacement. About 1.8 KB
a record, 35 KiB in all (simulated). Export for counsel: texts, records as JSON, a summary CSV, and how to check each
signature offline. No names or emails on the server.

**DRAFT FOR COUNSEL, NOT FINAL, NOT LEGAL ADVICE. Not to be sent.** (Legal lane draft, corrected for the attack review.)

> **Ending your SAFT and receiving CREATE Shares instead.**
> 1. *Who signs.* You ([backer's legal name or entity]); [old LLC legal name and state] (the "Old Company"); and
> [Creaton DAO LLC], a Marshall Islands DAO LLC (the "New Issuer"), which exists before anyone signs.
> 2. *What you had.* On [date] you signed a Simple Agreement for Future Tokens (SAFT) with the Old Company and paid
> [amount] dollars at [0.02 / 0.046] a token for [old tokens] tokens of a planned 110,000,000-token supply. No tokens
> were delivered. The launch the SAFT was written for (a Doppler launch) will not happen.
> 3. *What ends.* The Old Company and the New Issuer have already signed this agreement. It takes effect when you sign
> it. Your SAFT then ends and you give up every right under it, including any right to tokens, to a refund, or to
> anything the SAFT says happens if the Old Company dissolves, winds up or never launches. The Old Company and you
> release each other from all claims under the SAFT [counsel: scope of the release].
> 4. *What you receive.* [X] CREATE Shares of the 1,000,000,000 that will ever exist ([x]% of all Shares). Worked out
> as [your old tokens x 9.0909]. You pay nothing more. Every earlier backer receives the same terms.
> 5. *Where they are held.* Your Shares are held for you in a claim contract at [network, address], which receives them
> from the Vester contract. They release evenly over 365 days from the day CREATE's market opens (the day its auction
> succeeds and its pool opens) and are sent to the wallet you name. [Counsel: if needed, none before 365 days from your
> signature.] Until released you cannot send, sell, vote with or hand back a Share. The CREATE token itself is an
> ordinary token and is never locked.
> 6. *The market may open late, or never.* It will not open until 25 outside projects have raised money on the platform
> and kept it for 90 days, 2,500 dollars of fees have come in within 90 days, an outside security audit is done, and
> counsel has cleared the network. Nobody can promise when. If it has not opened by [long-stop date], [counsel: what
> happens]. This replaces the SAFT's timing of about 3 to 7 months after launch.
> 7. *What Shares give you.* Buyers acquire ownership only: governance and exit. No dividends or revenue share, ever,
> unless they contribute and earn one. Once released, a Share can be parked to vote, sold in CREATE's pool, or handed
> back for its slice of CREATE's floor, less the hand-back fee, under the contracts' rules. [Counsel: whether Shares are
> membership interests in the New Issuer.]
> 8. *No promise of profit.* Shares may be worth nothing. Nobody promises a price, a market, a buyer or a return.
> Earlier prices (0.02 and 0.046 an old token, 6,000,000 for the whole project) are not values.
> 9. *What you were promised, and what exists now.* You backed a plan for a web3 social media with monetization. On
> [date] Creaton is a community workspace: channels, forums, direct messages and AI agents, where builders start
> projects in public, post weekly updates, raise money from backers who receive Shares, and pay people for tasks. It
> runs on a test network until an outside audit and legal review are done. Dropped from the old plan: the staking and
> rewards line, the airdrop, a DAO treasury of 36.4% under a DAO vote, and delivery within 3 to 7 months. [Owner and
> counsel: list every other difference honestly.]
> 10. *What becomes public.* When you sign, your signing wallet, the wallet that receives your Shares and your Share
> count are recorded on a public network. Anyone can work out from them what you paid.
> 11. *Your wallet.* You confirm you control [address] and sign this with it. Shares go only to that wallet or to a
> wallet that already exists on [network]. If you lose the key before signing, [counsel: the recovery process].
> 12. *Your statements.* You sign for yourself or the entity named. Nobody has promised you anything not written here.
> [US person or not; accredited or not; sanctions; you handle your own taxes.]
> 13. *Signing.* (a) An electronic signature on this text; (b) a signature from your wallet over a structured message
> containing this text's fingerprint, the New Issuer, your Share count, your wallet, the network, the contract address
> and a deadline. [Counsel: whether (b) alone counts.]
> 14. *Law and disputes.* [counsel]

## 5. The claim contract: `EarlierBackers` (not built; build only after the owner's yes)

**Shape.** One contract for project zero's earlier raise. At launch the Launcher's cut (below) makes one plain Vester
grant to it, separate from the founder's grant, so the founder trim never reaches it. Each consented entry receives
`amount x vester.released(this) / total - taken`. No refund path, no money, no fee, no vote, park or hand-back function.

**Changes elsewhere (estimates):** `nameProjectZero(key, Cut{claim, fromBacking, fromFounder})`: at launch the Vester
receives the founder's 200M plus `fromBacking` and makes two grants; the Rounds receive 150M less `fromBacking`
(at most 141.67M, so a 6M Team round still opens); project zero's launch hash covers the cut. Launcher +600 to +900
bytes on 20,062 of 24,576 (measured size, estimated growth); Vester +150 to +250 bytes. **Treasury:** `countingSupply`
also leaves out the claim contract's released but undelivered Shares (about 8 lines), so unsigned entries, the challenge
window and any lock-up gate thin nobody's exit (without it: up to 9.0% thinner if a quarter never sign, simulated).

**Interface.** Constructor `(launcher, key, bytes32[] leaves, total, textHash, summaryHash, longStop, minHoldFromConsent,
keeper)`; refuses a zero keeper, more than 64 entries, `longStop` under 2 years. One leaf per entry
`keccak256(entry, holder, amount, salt)`: duplicates are impossible and addresses stay hidden until each consent.
Writes: `bind()` (once, after launch); `consent(entry, holder, amount, salt, receiver, validUntil, signature)` (anyone
submits; empty signature only from the holder itself, else ECDSA or EIP-1271); `deliver(entry)`, `deliverMany(ids)`
(anyone; only to the receiver); `voidConsent(entry, evidence)` (keeper, inside the 21-day challenge window, back to open,
never redirected); `proposeHolder(entry, next, evidence)`, `cancelHolder(entry)`, `applyHolder(entry)` (30-day wait;
the holder can veto unless the keeper voided that holder's consent); `publishText(...)` (keeper, before any consent or
for non-material fixes); `close()` and `toReserve()` (anyone, after `longStop`); `offerKeeper`, `takeKeeper`. Views:
`consentDigest`, `due`, `undelivered`, `closeAt`, `funding`. Events: Bound, Consented (entry, holder, receiver, amount,
textHash), Voided, Delivered, HolderProposed, HolderReplaced, ReplacementCancelled, TextPublished, ListClosed,
SentToReserve, KeeperChanged.

**Typed data, the only one** (app, text and contract all use it): domain `Creaton earlier backers`, version 1,
chainId, verifyingContract; `Consent(entry, holder, amount, receiver, project, textHash, textVersion, summary,
holderVersion, validUntil)`, with `summary` a one-line plain sentence counsel writes. No chain-less or plain-text
signatures, no counterfactual (6492) wallets.

**Guards (each needs a test that fails when it is removed).** From the contract lane: EB01 bind once after launch; EB02
entry in range; EB04 holder not zero; EB05 empty signature only from the holder; EB06 signature valid (ECDSA or 1271);
EB07 the digest binds project, text, version, summary, holder version, chain and contract; EB08 `validUntil`; EB09 one
consent per entry; EB10 none after close; EB12 consent clears a pending replacement; EB13 the due formula; EB14 delivery
only to the receiver; EB16 strays measured as balance less what is owed; EB17 close only at `longStop`; EB18 to EB21
replacement rules (keeper only, open entry, 30 days, veto, holder version up); EB22 text version grows; EB23 two-step
keeper. Added by the attack review: EB03 the leaf matches the stored hash for that entry (replaces the Merkle proof);
EB11 the receiver is not zero or a project contract, and has code on this chain or is the holder itself with no code;
EB24 consented total never above `total`; EB25 no consent until bound and `funding() == total`; EB26 nothing is
delivered before `consentAt + 21 days`; EB27 nothing is delivered before `consentAt + minHoldFromConsent`; EB28 void only
inside the window and only by the keeper. Launcher: LZ1 cut parts within their slices; LZ2 claim code, key and launcher
match; LZ3 `claim.total() == fromBacking + fromFounder`; LZ4 the launch hash covers the cut; LZ5 the founder grant is
200M less `fromFounder`, the claim grant separate; LZ6 amounts minted to Vester, Rounds and Treasury match.

**Tests.** Consent by EOA, direct call, a 1271 mock, a Kernel account and a Safe-style mock; wrong chain, contract, text
version or replaced holder fails; expired, wrong amount or salt fails; a relayer and a front-runner give the same
result; two entries, one wallet. Delivery never early (fuzz), exact at the end, an outside `Vester.claim` changes
nothing, strays go to the reserve. Challenge window: void then re-consent; delivery refused inside it. Receiver without
code refused. Launcher: allocation numbers, two Vester grants, a 6M Team round opens at 141.67M and `CannotOpen` above;
the founder trim leaves the claim grant whole; a cut not in the hash reverts. Treasury: `countingSupply` with and
without undelivered claim Shares. Invariant: delivered + sent to reserve <= released. Gas for `deliverMany(30)`.

**Size (estimates; forge not run).** About 280 to 330 lines, 6.5 to 8 KB runtime, 1.3 to 1.6M gas to deploy; consent
about 95k gas (EOA) plus 25k to 40k for 1271; delivery 70k to 90k.

## 6. The app and server journey

- **Before any link:** counsel checks every entry with no usable address against the signed SAFT and the payment
  record; each backer proves a wallet by signing from it; counsel signs that the list's count and total match the SAFT
  records, and its fingerprint is published. Then the leaves are fixed. Owner-only confirmation and empty-holder
  entries are not allowed for real money.
- **The link** is `/earlier#<token>`: the fragment carries a one-use token and the display name, so the server never sees
  the name; it stores a hash of the token. The owner sends links and reminders from their own email; the status page marks
  reminders due on days 7, 21 and 45, at most 4.
- **The page** (loaded separately; the entry bundle is untouched): a plain card (what you paid, what replaces it, N
  Shares of 1,000,000,000, held and released over 365 days from market open, who gives them); the full text on the
  reading pane with its fingerprint; where your Shares go (default: the wallet you paid from); sign-up if needed; "I have
  read all of this"; one button, "Sign with the wallet you paid from". Secondary: Sign another way, I have a question,
  I don't agree. Afterwards a receipt, "Download your copy", and a notice for the 21-day window.
- **Presses** (in-app / typed fields / steps outside Creaton), simulated (`earlier_backer_journey.py`): signed in,
  computer 2 / 0 / 2; new, computer 5 / 0 / 3; new, phone 7 / 0 / 5 (the account is made in the phone's browser, then a
  deep link signs in the wallet app); signed in, phone 4 / 0 / 4; another way (a direct call from a hardware wallet or
  any tool) 4 / 1 paste / 1, a little gas; Safe 2 per owner. Changing where Shares go adds 2 presses and a signature
  from that wallet, which must exist on the claim's network (the app deploys a passkey account first if needed).
- **Owner's side:** 3 presses to load the list, 1 per link (about 20); deliveries run on the server's daily job.
- **Code reuse, no new dependency:** move `web/src/features/identity/lib/wallet-proof.ts` and
  `web/src/features/launchpad/use-connected-wallet.ts` into `packages/creaton-core`; checks reuse `crates/buzz-evm-auth`.
  No WalletConnect unless real backers cannot sign without it.
- **Public view:** a "Raised before Creaton" card on Creaton's page: the total, N backers, "agreed k of N", the 4.26M
  blended price, and each grant as a short address with an "earlier backer" label. k, N and the total are read from the
  contract, not the server. Never names or per-person dollars. The auction page says plainly that 28.87% of Shares went
  for money raised and spent before Creaton, that they can hand back against the floor, and that the backers can out-vote
  the founder after a year.

## 7. The legal entity layer (needs counsel; not legal advice)

What we read (the statute host kept failing, so from extracts and secondary sources; counsel must check the text):
the Marshall Islands DAO Act 2022 (amended 2023) allows for-profit and non-profit DAO LLCs and Series DAO LLCs with
separate assets and liabilities; membership can be read from a smart contract; a "beneficial member" (25% of interests
or votes, or effective control; some say 10%) must be identified; a governance token with no economic rights is not a
security there; a for-profit pays 3% on gross revenue. MIDAO is the registered agent: about 9,500 dollars to set up
(Creaton's raise is over the 250,000 small tier) and 2,000 to 5,000 a year; at most 30 days, or 24 hours for 10,000
more; no published series price.

- **Creaton's own entity now (recommended, judgement):** a standalone Creaton DAO LLC, formed before any backer signs,
  probably for-profit, because the hand-back against a fee-funded floor is an economic right (likely outside the
  governance-token carve-out). It issues CREATE and is the New Issuer. Servers, staff and app-store accounts sit in a
  separate operating company under a service agreement. The owner suggested a series for Creaton; a standalone entity
  keeps CREATE's issuer apart from every project's liabilities.
- **A series per project:** offered only at the auction / Council stage, after identity checks and Creaton's review,
  under a platform parent that is not CREATE's issuer; confirmed only by a Creaton-signed series record. At Open backing
  the app records only "none" or "own entity (the founder's statement)". A Solo project raising 2,500 would pay more
  than its raise in yearly fees, so never at joining or Start. The project pays from its raise (judgement).
- **Bring your own** (a Cayman, Wyoming or other entity) at any stage, shown as the founder's statement.
- **How votes map (a series' LLC agreement):** before the market the founder or both Pair signers are sole manager; at
  Council the 5 seats are managers and the Council contract's decisions are the series' decisions; HolderVote (park,
  replace, wind-down) is the member vote; at Open holders elect all 5. Agents never hold a seat or a manager role. Under
  D, no holder crosses 25% (the largest entry peaks between 5% and 10% of voters, simulated), so the founder is
  identified by control.
- **Securities (US):** a new issuer means a new offer and sale (the same-issuer exchange exemption does not apply), so
  Reg D 506(b) for US accredited backers and Reg S for others; the one-year holding period may restart. Hence the
  optional gate in section 5: no delivery before 365 days from each signature, in the claim layer, never on the token.
- Sources: pacliirms.austlii.edu.au/mh/legis/consol_act/daoa2022415.pdf;
  pacliirms.austlii.edu.au/mh/legis/num_act/daoa2023pl832023585.pdf; coindesk.com (30 Oct 2023, Marshall Islands DAO
  law); midao.org; legalnodes.com (Marshall Islands LLC as a DAO wrapper); 15 U.S.C. 7006 (govinfo.gov); sec.gov
  33-8869 (Rule 144); legal.thomsonreuters.com (Regulation S); orrick.com (April 2026 SEC crypto guidance; October 2026
  CLARITY Act); cahill.com (2 September 2026, proposed Regulation Crypto Assets). Full list in the legal lane's output.

## 8. Attack findings and how each is handled

| Finding | Handling |
|---|---|
| Owner (or a keeper they control) decides who receives entries with no address: 64.9% of the S1 Shares (simulated on the sheet) | Counsel verifies those entries and each backer signs from a wallet before the list is fixed; counsel attests count and total; at most one keeper signer is the owner or the owner's employee; no empty-holder or account-only entries |
| Three different signed messages, one chain-less | One typed-data schema with chainId and contract address, used by the app, the text and the contract |
| Shares could move while the replacement had lapsed | The old LLC and the New Issuer sign first; the backer's signature completes it; no lapse clause |
| No uniqueness or sum guard on the list | One stored leaf per entry; EB24 consented total <= total; EB25 consent only when fully funded; LZ3 funding equals total |
| A receiver with no code on the claim's network can be captured | EB11: code on this network, or the holder itself; the app checks a passkey account on the target network |
| An old leaked key consents first | 21-day challenge window; the keeper can void (never redirect) with public evidence; the app notifies on each consent |
| Holdouts swept while their SAFT survives | No sweep until counsel's long-stop (at least 2 years); undelivered Shares do not count, so waiting thins nobody; a choice of a partial refund goes to counsel |
| Held overhang and floor against Creaton's own baseline | Stated in section 3 and on the auction page; any money left from the old raise goes into Creaton's floor or treasury at launch (owner question 12); a 730-day clock can be offered as a trade |
| D as a general rule = free self-fill and trim escape | Project zero only; any general version needs the fee and the 3,000-a-dollar cap |
| Lock-up against "never lock the token" | Optional per-entry gate in the claim layer (EB27); any longer restriction is a promise by the person, never on the token |
| Disclosure gaps (where Shares are held, public amounts, owner's purchase, dropped lines, same terms) | Fixed in the draft text (sections 3, 4, 5, 9, 10) and owner question 3 |
| Series offered too early and under CREATE's issuer | Series only at auction / Council, under a separate platform parent |
| List must be final before Creaton's real launch; public counts from the server | "List final and attested" is a launch-checklist step; k of N read from the contract |
| Lane number slips (founder 200M in the vote model; 56.3% was money, not Shares) | Section 3 and section 7 use D's figures and Shares |

## 9. What to build, in order

1. **Now, no counsel needed:** this note; the private sheet `Creaton_Distribution_v2.xlsx` (scratchpad, not the repo);
   the owner's answers below; correct FOUNDER-PRICE.md and PLAN-V2 decision 7 (done: pointers to this note).
2. **Owner to counsel (private):** every SAFT and side letter, the old LLC's details, the meaning of DONE, the owner's
   own amount, backers' countries and accreditation records, what was promised in messages or decks.
3. **On the owner's yes, Sepolia only:** `EarlierBackers`, the Launcher cut, the Vester second grant, the Treasury
   counting change; every guard with its removal test; re-run the guard-removal script. Then the app page, the founder-only
   list and status screen, the records and the export, the public card read from the chain. Rehearse with test accounts
   only; never send test Shares to real backers' addresses, and backers never sign the real text on a test network.
4. **Waits for counsel:** the route and the final text and summary line; the long-stop and the lock-up gate; the entity
   formed; the exemption and any filings; collecting wallet proofs from real backers; fixing the leaves with counsel's
   attestation.
5. **Waits for counsel and the outside audit:** any real-network deploy, any real signature, Creaton's launch.

## 10. Owner questions, each with a recommended answer

1. *Which conversion?* **S1, their percent kept (288.68M, 28.87%).** S2 (204.99M) only with each backer's written consent.
2. *Accept D: unused backing first, then your founder grant, leaving you 52.99M (5.30%)?* **Yes**, for project zero
   only. Alternatives: 13.67% at S2, or 15.30% with C+, which empties the reserve (not recommended).
3. *How much seed did you buy yourself, and where do its Shares go?* **Tell counsel the amount; leave it off the list
   and disclose it. The Shares are simply not cut from your grant (the team side, as your note says)**, unless you want
   them in the reserve, which needs one more number in the cut.
4. *What does DONE mean on the 2 entries (63.26M Shares at S1)?* **Leave them off until counsel sees proof either way.**
5. *Addresses (6 missing, 1 broken, 1 shared by 2 entries)?* **Every backer proves a wallet by signing from it; counsel
   checks each against the SAFT and payment; no guessed addresses.**
6. *Advisors (two at 0.5% each named; a small table of 4, one marked "no")?* **Only signed promises stand, as percent of
   all Shares (0.5% = 5M), from the work pot before the market, on the same clock.** The sheet uses 14.55M until you say.
7. *Release clock?* **One clock, 365 days from market open, never faster; offer 730 days only as a negotiated trade.**
8. *If the market never opens?* **The text says so plainly; counsel writes the long-stop and what happens at it.**
9. *Keep 8.33M backing for Creaton's own 6M rounds?* **Yes.** With none, you keep 8.33M more.
10. *Deadline for unsigned entries?* **Counsel's long-stop from the SAFT's limitation period, at least 2 years; their
    Shares stay claimable until then and do not count meanwhile.**
11. *Who is the keeper?* **A 2-of-3 Safe: counsel, one independent person, and you; at most one signer yours.**
12. *Where are the 1,229,957 dollars, and does anything remain?* **Tell counsel; whatever remains goes into Creaton's
    floor or treasury at launch, and counsel decides whether backers get a choice of a pro-rata refund instead.**
13. *Creaton's entity?* **A standalone Creaton DAO LLC now (probably for-profit), separate from the operating company;
    counsel decides.** Budget for US and Marshall Islands counsel plus MIDAO (about 9,500, then 2,000 to 5,000 a year).
14. *Series for other projects?* **Only at auction / Council, under a separate platform parent, paid by the project; or
    their own entity.**
15. *Old LLC, SAFT form and law, side letters, countries, accreditation?* **Give all of it to counsel, never the repo.**
16. *Anyone else from the old Team line owed Shares?* **Only signed promises, from the work pot, not your grant.**
17. *Lock-up gate (no delivery before 365 days from each signature)?* **Build it as a setting; counsel decides on or off.**
18. *Disclose on the auction page the 4.26M blended price and that the backers can out-vote you after a year?* **Yes.**
19. *Milestone 9: a supermajority and minimum turnout for a wind-down at Open?* **Yes.**
20. *Order: links only after the Shares rule, counsel's text and the entity are settled?* **Yes.**
