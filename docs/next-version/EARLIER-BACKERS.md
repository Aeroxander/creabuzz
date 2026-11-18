# Creaton's earlier backers: from the old SAFTs to CREATE Shares

Design note for the owner, 18 November 2026. Nothing here is live or signed; section 11 says what is now built (local
tests only). Nothing goes on a real network before
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

## 5. The claim contract: `EarlierBackers` (built after the owner's yes: section 11)

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

## 11. Earlier backers: built (18 November 2026)

Built in `contracts/next` on branch `v4-governance-rework`, not pushed, not deployed anywhere. Local tests only; every
holder, amount, salt and address in the tests is made up (21 entries that add up to the real S1 total).

### The owner's decisions (18 November 2026, final)

1. **Size S1.** The earlier backers keep their old percent: 288,677,273 Shares (28.868%), less the owner's own seed
   entry if it is ever put on the list. The total is an input of the claim contract, not a constant.
2. **Source D, project zero only.** First the backing Shares Creaton's own rounds cannot use (Creaton keeps
   8,333,333.33 backing Shares, what the 50,000 Team cap buys at 6,000,000; the other 141,666,666.67 go to the list),
   then the founder's slice. Never the work pot, the reserve, the auction or the pool match. Never a rule for other
   founders.
3. **The teammate** gets the old Ambassadors line: 2.4M of the old 110M = 2.1818% = 21,818,182 Shares, from the work
   pot with Give Shares, on the same clock. Paid monthly by default (the plan text); one up-front gift also works. No
   contract change.
4. **One clock** for everyone (founder side, teammate, advisors, earlier backers): evenly over 365 days from the market
   opening (or a "no market" declaration), never faster, no cliff. The lock-up gate (no delivery before 365 days from
   each signature) is a setting, off by default, for counsel to switch on.
5. **The owner's team Shares go to the Treasury, not to the owner** (changed later the same day). The founder's
   remainder, 52,989,393.67 Shares (5.30%) at S1 with no owner seed entry, is not granted to the owner at launch: it
   lands in project zero's Treasury as a public, earmarked **team budget**, and the runner pays it out over time with
   the gift rules, about monthly, roughly 52.99M over 2 to 3 years if the owner stays. Project zero's founder Vester
   grant is zero. The runner at first is the DAO LLC's manager (central management, a Single runner or a Pair of the
   manager's keys), bounded by the existing caps.

### What changed, file by file

| File | Change |
|---|---|
| `src/EarlierBackers.sol` (new, 7,837 bytes runtime) | The claim contract of section 5, guards EB01 to EB28 plus EB29 (below) |
| `src/Launcher.sol` | Project zero only: `nameEarlierBackers(claim, keepBacking)` (admin, after `nameProjectZero`; checks the code hash, the Launcher and the key: LZ2; the cut fits its slices: LZ1); `launchHash(key)` covers the claim and the kept backing (LZ4); at launch the claim gets one Vester grant of the list's total (LZ3), the founder's Vester grant is zero, the rest of the founder's slice goes to the Treasury as `teamBudget` (LZ5), and every Share is minted to its place (LZ6). New events `EarlierBackersNamed` and `ProjectZeroSplit(key, claim, fromBacking, fromFounder, teamBudget)`. `ProjectLaunched` keeps its shape: project zero shows `founder` 0 and `backing` after the cut |
| `src/Parts.sol` | Records `keccak256(type(EarlierBackers).runtimeCode)`; the Launcher accepts only that code |
| `src/Vester.sol` | A zero founder grant makes no grant (project zero); a second plain grant at birth for the claim, never to nobody or to the founder |
| `src/Treasury.sol` | `teamBudget` (what is left, public), `payTeam(to, amount)` (runner only, never an agent; a gift's rules), event `TeamPaid(to, amount, left)` beside `SharesGiven`; `reserve()` leaves the team budget out; `countingSupply()` leaves out the claim's released but undelivered Shares |
| `scripts/mutate-guards.py` | Entries Q01 to Q97 (`--eb`); T10, T41, L13, N70 and NA1 re-pinned to the changed lines |

### Choices the note left open (the note's recommendation taken unless said)

- **Who pays the team budget:** the runner only, never an agent (smaller power; an agent may still give from the work
  pot inside its limit). The budget follows the seat: a successor or a Pair pays it.
- **With no earlier raise named,** project zero's whole founder slice (200M) is the team budget. The rule is "project
  zero has no founder grant", not "only when a list exists".
- **The cut may use the whole founder slice** (team budget zero); the draft's "the founder keeps some" check is dropped,
  because the remainder is no longer the founder's.
- **The lock-up gate** is a constructor setting (`minHoldFromConsent`, zero by default, at most 730 days), fixed when
  the list is fixed, so nobody can switch it on or off after a backer signs.
- **Long-stop:** at least 730 days after the contract is made (the note: at least 2 years); counsel sets the date.
- **No immutables** in `EarlierBackers`, so every copy has the same code hash and the Launcher can check it.
- **EB29 (new, found while building):** after the keeper voids a consent (a leaked key) and proposes a new holder, the
  voided key can neither agree again nor veto until the replacement applies. Without it the leaked key could re-sign
  just before day 30 each time and block the replacement for ever. The holder whose consent was voided but who has no
  replacement pending may sign again, so a mistaken void strands nobody.
- **Dropped as redundant** (each was covered by another check, so no test could fail without it): a zero receiver (no
  code and never the holder), "the entry is still open" in `applyHolder` (a replacement exists only for an open entry,
  and EB12 or EB29 settle any consent while one is pending).
- **The earlier raise is fixed at the launch:** `nameEarlierBackers` refuses once no project zero is named (before
  naming, and after the launch), so `earlierClaim()` keeps showing the claim project zero launched with.

### Numbers at S1 (measured, `EarlierLaunchTest`, `TeamBudgetTest`)

| What | Shares |
|---|---|
| The claim's Vester grant (the list's total) | 288,677,273 |
| of it from unused backing | 141,666,666.67 |
| of it from the founder's slice | 147,010,606.33 |
| Project zero's founder Vester grant | 0 |
| Treasury team budget | 52,989,393.67 (5.30%) |
| Backing kept for Creaton's rounds (a 6,000,000 Team round of 50,000 opens; one priced lower cannot) | 8,333,333.33 |
| Work pot, reserve, auction and pool match | 200M, 100M, 250M + 100M (unchanged) |

### How the Treasury's count and the founder trim interact

- `countingSupply()` (the exit's denominator and the gift cap's base) leaves out the Treasury's whole balance (so the
  team budget never counts until paid), the Vester's unreleased Shares (the claim's grant before release), and the
  claim's released but undelivered Shares (open entries, the 21-day window, the lock-up gate). Measured: 365 days after
  the market, with nobody signed, the count is the auction buyers' 350M only. Delivered Shares count at once.
- The founder trim cuts only the founder's grant. Project zero has none, so a leaving founder's hand-over cuts nothing,
  and it can never reach the claim's grant (a separate grant) or the team budget (the Treasury's, which follows the
  seat). Measured in `test_trim_leavesTheClaimAndTheTeamBudgetWhole`.

### Votes (for milestone 9; HolderVote is not built)

Held earlier-backer Shares never sit in a backer's wallet before delivery: they are in the Vester (unreleased) or the
claim contract (released, undelivered). The team budget is in the Treasury. So a vote that counts only Shares a person
parks from their own wallet cannot count them. Milestone 9 must keep it that way: HolderVote counts parked Shares only,
never a balance of the Treasury, Vester, claim contract, Rounds or Finisher, and never `countingSupply` as a stand-in
for turnout.

### Team pay, monthly (measured, `TeamBudgetTest`)

- Before the market, each payment goes into the Vester and releases over 365 days from the market opening; after it,
  each arrives at once, inside the one cap of 1% of the Shares in people's hands in any 30 days that every gift shares.
- The manager's plan, run in a test: 30 monthly payments (12 before the market, 18 after), with the teammate paid from the
  work pot in the same months. The budget is used up exactly; the work pot falls by the teammate's 21,818,182 only; the
  reserve does not move.
- **Finding:** the cap remembers a gift for 30 to 33 days. On a strict 30-day step after the market, the last month's
  payment still counts, so two months count at once: at 2 years (3.12M a month for the owner and the teammate together,
  with 350M Shares in hands) the second payment is refused. Pay on a 33-day step, or keep each month under half the cap.
  Before the market there is no cap.
- A Pair of the manager's keys pays with both signatures; one signer alone cannot.

### Events for the server (milestone 5)

New: `Launcher.EarlierBackersNamed(key, claim, keepBacking)`, `Launcher.ProjectZeroSplit(key, claim, fromBacking,
fromFounder, teamBudget)`, `Treasury.TeamPaid(to, amount, left)` (always beside `SharesGiven`), and the claim
contract's `Bound`, `Consented`, `Voided`, `Delivered`, `HolderProposed`, `HolderReplaced`, `ReplacementCancelled`,
`TextPublished`, `ListClosed`, `SentToReserve`, `KeeperChanged`. Unchanged in shape: `ProjectLaunched` (project zero
reads founder 0 and the backing after the cut) and `SharesGiven`. The chain reader should read the team budget from
`ProjectZeroSplit` and `TeamPaid`, and the public "k of N agreed" from `consentedCount()` and `entryCount()`.

### Tests (78 new, every one passes)

| File | What |
|---|---|
| `test/EarlierBackers.t.sol` | Launch at S1 (LZ1 to LZ6, the split event, the 6M Team round, ordinary launches unchanged and unable to use it, no second project zero, the trim); the constructor; the typed data checked field by field; consent by EOA, in person, a 1271 wallet, a Kernel-style account, a 2-of-3 Safe-style wallet and a contract holder's direct call; wrong chain, contract, text version, holder version, deadline, leaf, amount or salt fails; receivers; void, replacement, veto, EB29, keeper hand-over; delivery (never early, exact at the end, only to the receiver, an outside `Vester.claim` changes nothing); the Treasury's count with and without undelivered Shares; the close and the reserve with a stray; the lock-up gate on |
| `test/EarlierBackersFuzz.t.sol` | Fuzz: one leaf per entry; pro-rata delivery at any time and any set of signers; delivered plus sent to the reserve never above released; the sum guard on a list padded 60M over its total, in any order. The attack findings: a leaked key signs first; a receiver with no code; a chain-less replay; no early sweep and waiting thins nobody; D is not a general rule; the keeper cannot redirect. Gas |
| `test/TeamBudget.t.sol` | The budget apart from the reserve and the work pot; runner only, never an agent; not more than the budget; bad receivers; held before the market, free after it under the shared cap; a Pair runner; 30 monthly payments with the teammate; the 33-day finding; the teammate's up-front gift; a reserve sale cannot take it; the budget follows the seat; the Treasury's birth check |
| `test/helpers/EarlierBase.sol`, `test/mocks/Wallets.sol` | The S1 world with 21 made-up entries; the wallet mocks |

### Gas (measured, `EarlierGasTest`)

| Call | Gas |
|---|---|
| `consent`, EOA signature, the first on the list (fresh totals) | 180,379 |
| `consent`, EOA signature, a later entry, a contract wallet receiving | 112,146 |
| `deliver`, one entry (it also pulls the claim's released Shares from the Vester) | 140,943 |
| `deliverMany`, all 21 entries | 1,157,816 |
| `deliverMany`, 64 entries (the most a list may have) | 3,723,464 |
| `Treasury.countingSupply` with the claim | 25,871 |
| `payTeam` before the market (held in the Vester) | 95,319 |
| `payTeam` after the market (free, under the cap) | 110,656 |

The note estimated about 95k for a consent; it is higher because each consent writes six fresh storage slots. It is
paid once per entry, by whoever submits (the server's relayer).

### Guard removals (`python3 scripts/mutate-guards.py --eb`, one at a time, no RPC)

| Id | Removed or broken | n | A test that fails |
|---|---|---|---|
| Q01 | EarlierBackers EB01: bind twice | 1 | `test_launch_emitsTheSplitAndBinds` |
| Q02 | EarlierBackers EB01: bind before the launch | 1 | `test_consent_EB25_notBeforeTheLaunch` |
| Q03 | EarlierBackers EB02: an entry out of range | 1 | `test_consent_EB02_EB03_theLeaf` |
| Q04 | EarlierBackers EB03: the leaf is not checked | 2 | `testFuzz_oneLeafPerEntry` |
| Q05 | EarlierBackers EB04: an entry with no holder | 1 | `test_consent_EB04_noHolderNoConsent` |
| Q06 | EarlierBackers EB05: an empty signature from anyone | 1 | `test_consent_EB05_emptySignatureOnlyFromTheHolder` |
| Q07 | EarlierBackers EB06: the signature is not checked | 8 | `test_1271_kernelStyle_ownWrapperOnly` |
| Q08 | EarlierBackers EB07: the domain leaves out the chain | 3 | `test_attack_chainlessReplayRefused` |
| Q09 | EarlierBackers EB07: the domain leaves out this contract | 2 | `test_consent_EB07_otherContractFails` |
| Q10 | EarlierBackers EB07: the message leaves out the text version | 1 | `test_consent_EB07_EB22_newTextVoidsOldSignatures` |
| Q11 | EarlierBackers EB07: the message leaves out the summary | 1 | `test_digest_matchesTheTypedDataByHand` |
| Q12 | EarlierBackers EB07: the message leaves out the holder version | 1 | `test_replace_EB21_holderVersionBindsTheSignature` |
| Q13 | EarlierBackers EB07: the message leaves out the project | 1 | `test_digest_matchesTheTypedDataByHand` |
| Q14 | EarlierBackers EB08: no deadline | 1 | `test_consent_EB08_expired` |
| Q15 | EarlierBackers EB09: an entry agreed to twice | 2 | `test_consent_EB09_oncePerEntry` |
| Q16 | EarlierBackers EB10: consent after the close | 1 | `test_close_EB10_EB17` |
| Q17 | EarlierBackers EB11: a receiver with no code that is not the holder | 3 | `test_attack_receiverWithoutCodeRefused` |
| Q18 | EarlierBackers EB11: the claim contract itself as receiver | 1 | `test_consent_EB11_receiver` |
| Q19 | EarlierBackers EB11: the Launcher as receiver | 1 | `test_consent_EB11_receiver` |
| Q20 | EarlierBackers EB11: the Shares contract as receiver | 1 | `test_consent_EB11_receiver` |
| Q21 | EarlierBackers EB11: the Treasury as receiver | 1 | `test_consent_EB11_receiver` |
| Q22 | EarlierBackers EB11: the Vester as receiver | 1 | `test_consent_EB11_receiver` |
| Q23 | EarlierBackers EB11: the Rounds as receiver | 1 | `test_consent_EB11_receiver` |
| Q24 | EarlierBackers EB11: the Finisher as receiver | 1 | `test_consent_EB11_receiver` |
| Q25 | EarlierBackers EB12: a consent leaves a pending replacement | 1 | `test_replace_EB12_consentCancelsIt` |
| Q26 | EarlierBackers EB13: delivery ignores the clock | 8 | `testFuzz_closeNeverAboveReleased` |
| Q27 | EarlierBackers EB14: delivery to the caller | 5 | `testFuzz_proRataDelivery` |
| Q28 | EarlierBackers EB13: a delivery is not recorded | 4 | `testFuzz_closeNeverAboveReleased` |
| Q29 | EarlierBackers EB16: the reserve gets its part only, not the strays | 1 | `test_close_openEntriesAndStraysToTheReserve` |
| Q30 | EarlierBackers EB17: close before the long-stop | 2 | `test_close_EB10_EB17` |
| Q31 | EarlierBackers EB17: close twice | 1 | `test_close_EB10_EB17` |
| Q32 | EarlierBackers EB17: to the reserve before the close | 2 | `test_attack_noEarlySweep_andWaitingThinsNobody` |
| Q33 | EarlierBackers EB18: anyone may propose a holder | 1 | `test_replace_EB18_to_EB21` |
| Q34 | EarlierBackers EB18: a replacement for an entry out of range | 1 | `test_replace_EB18_to_EB21` |
| Q35 | EarlierBackers EB18: a replacement by nobody | 1 | `test_replace_EB18_to_EB21` |
| Q36 | EarlierBackers EB19: a replacement for an agreed entry | 1 | `test_replace_EB18_to_EB21` |
| Q37 | EarlierBackers EB20: no 30-day wait | 1 | `test_replace_EB18_to_EB21` |
| Q38 | EarlierBackers EB21: anyone may veto | 1 | `test_replace_EB18_to_EB21` |
| Q39 | EarlierBackers EB21/EB29: the voided holder may veto | 1 | `test_replace_EB29_aVoidedKeyCannotBlockIt` |
| Q40 | EarlierBackers EB21: the holder version does not grow | 2 | `test_replace_EB18_to_EB21` |
| Q41 | EarlierBackers EB21: apply with nothing pending | 3 | `test_attack_keeperCannotRedirect` |
| Q42 | EarlierBackers EB22: the text version does not grow | 1 | `test_consent_EB07_EB22_newTextVoidsOldSignatures` |
| Q43 | EarlierBackers EB22: anyone may publish a text | 1 | `test_consent_EB07_EB22_newTextVoidsOldSignatures` |
| Q44 | EarlierBackers: a consent names an old text | 1 | `test_consent_EB07_EB22_newTextVoidsOldSignatures` |
| Q45 | EarlierBackers EB23: anyone may offer the keeper role | 1 | `test_keeper_EB23_twoSteps` |
| Q46 | EarlierBackers EB23: anyone may take the keeper role | 1 | `test_keeper_EB23_twoSteps` |
| Q47 | EarlierBackers EB24: no sum guard | 1 | `testFuzz_sumGuard` |
| Q48 | EarlierBackers EB25: consent before the grant is funded | 1 | `test_consent_EB25_notBeforeTheLaunch` |
| Q49 | EarlierBackers EB26: delivery inside the challenge window | 3 | `testFuzz_proRataDelivery` |
| Q50 | EarlierBackers EB27: the lock-up gate is ignored | 1 | `test_deliver_EB27_holdFromTheSignature` |
| Q51 | EarlierBackers: delivery for an open entry | 1 | `test_deliver_EB13_EB14_EB26` |
| Q52 | EarlierBackers EB28: anyone may void | 1 | `test_void_EB28` |
| Q53 | EarlierBackers EB28: void after the window | 1 | `test_void_EB28` |
| Q54 | EarlierBackers EB28: void an open entry | 1 | `test_void_EB28` |
| Q55 | EarlierBackers: a void keeps the receiver | 2 | `test_attack_keeperCannotRedirect` |
| Q56 | EarlierBackers EB29: the voided holder agrees again while a replacement is pending | 2 | `test_attack_leakedKeyConsentsFirst` |
| Q57 | EarlierBackers: undelivered counts what was delivered | 4 | `testFuzz_proRataDelivery` |
| Q58 | EarlierBackers: a keeper of nobody | 1 | `test_constructor_refusesBadSettings` |
| Q59 | EarlierBackers: no list or more than 64 entries | 1 | `test_constructor_refusesBadSettings` |
| Q60 | EarlierBackers: a Launcher of nobody | 1 | `test_constructor_refusesBadSettings` |
| Q61 | EarlierBackers: a total of nothing | 1 | `test_constructor_refusesBadSettings` |
| Q62 | EarlierBackers: a long-stop under two years | 1 | `test_constructor_refusesBadSettings` |
| Q63 | EarlierBackers: a hold over two years | 1 | `test_constructor_refusesBadSettings` |
| Q70 | Launcher LZ5: project zero's founder slice stays a Vester grant (no team budget) | 5 | `setUp` |
| Q71 | Launcher LZ6: the backing slice is not cut | 3 | `setUp` |
| Q72 | Launcher LZ1: more backing kept than the backing slice | 1 | `test_name_LZ1_partsFitTheirSlices` |
| Q73 | Launcher LZ1: a cut larger than the founder's slice | 1 | `test_name_LZ1_partsFitTheirSlices` |
| Q74 | Launcher LZ2: any code as the claim | 1 | `test_name_LZ2_codeLauncherAndKey` |
| Q75 | Launcher LZ2: a claim made for another Launcher | 1 | `test_name_LZ2_codeLauncherAndKey` |
| Q76 | Launcher LZ2: a claim made for another project | 4 | `test_attack_notAGeneralRule` |
| Q77 | Launcher: anyone may name the earlier raise | 1 | `test_name_onlyTheAdmin` |
| Q78 | Launcher LZ4: the launch hash leaves out the cut | 1 | `test_launch_LZ4_theHashCoversTheCut` |
| Q79 | Launcher: naming project zero again keeps the old claim | 1 | `test_name_projectZeroAgainClearsTheClaim` |
| Q80 | Launcher: the launch does not bind the claim | 43 | `testFuzz_closeNeverAboveReleased` |
| Q81 | Launcher: the Treasury is not told about the claim | 3 | `test_attack_noEarlySweep_andWaitingThinsNobody` |
| Q82 | Launcher: the Treasury is not told the team budget | 14 | `test_budget_followsTheSeat` |
| Q83 | Launcher LZ3: the claim's grant leaves out the founder's part | 44 | `testFuzz_closeNeverAboveReleased` |
| Q84 | Parts: the code hash is not the claim's | 8 | `setUp` |
| Q85 | Vester: the claim grant may go to nobody or to the founder | 1 | `test_vester_claimGrantRules` |
| Q86 | Vester: a zero founder grant is still made (project zero cannot launch) | 6 | `setUp` |
| Q87 | Launcher: the earlier raise may be renamed after the launch (or before project zero is named) | 1 | `test_name_notAfterTheLaunch` |
| Q90 | Treasury: anyone may pay the team | 3 | `test_budget_followsTheSeat` |
| Q91 | Treasury: the team budget may be overdrawn (error kind) | 2 | `test_launch_ordinaryProjectUnchanged` |
| Q92 | Treasury: team pay does not lower the budget | 4 | `test_budget_followsTheSeat` |
| Q93 | Treasury: the reserve includes the team budget | 4 | `test_budget_isPublicAndApart` |
| Q94 | Treasury: the team budget is not stored | 14 | `test_budget_followsTheSeat` |
| Q95 | Treasury: the birth check leaves out the team budget | 1 | `test_init_theTeamBudgetMustBeHeld` |
| Q96 | Treasury: team pay skips the gift checks | 1 | `test_payTeam_badInputs` |
| Q97 | Treasury: undelivered earlier-backer Shares count | 2 | `test_attack_noEarlySweep_andWaitingThinsNobody` |
| T10 | Treasury: the Vester counts in the exit denominator (its whole balance leaves the count, claimed or not) | 11 | `testFuzz_attack_donatingSharesToTheProjectNeverPaysTheDonor` |
| T41 | Treasury: the reserve ignores Shares returned or donated to it | 12 | `test_close_openEntriesAndStraysToTheReserve` |
| L13 | Launcher: launch ignores the settings hash the founder saw | 3 | `test_attack_theAdminCanChangeTheSettingsInTheBlockBeforeALaunch` |
| N70 | Treasury: the Finisher's Shares count as in hands | 2 | `test_attack_aFounderFillsTheirOwnRoundsThroughManyAccounts_andCannotSellBeforeRelease` |
| NA1 | Launcher: the backing Shares are minted to the Treasury | 40 | `test_ask_aTokenThatDeliversLessIsRefused` |

The first run found the constructor checks (Q58 to Q63) failing no test: `vm.expectRevert` does not notice a creation
from inline assembly that succeeds. The test now checks the failed creation and its error itself; all six fail it.
Q70, Q71, Q84 and Q86 break project zero's launch, so every suite's `setUp` fails.

### Gates (18 November 2026, one forge process at a time, `nice`, another engineer building the Rust server meanwhile)

| Gate | Result |
|---|---|
| `forge fmt --check src test script` | clean |
| Local suite, no RPC (`env -u SEPOLIA_RPC_URL forge test`) | **572 passed, 0 failed, 35 skipped** in 125 suites (the 35 are the Sepolia fork twins); the invariants at 256 runs x depth 200 among them |
| `forge build --sizes` | exits 1 for the milestone 1 test helper `Deployer` only (unchanged). Launcher 21,807 runtime / 37,749 creation (was 20,062 / 35,901; 2,769 bytes left under 24,576), EarlierBackers 7,837 / 8,533, Treasury 14,703 / 14,748, Vester 3,787 / 3,831, Parts 506 / 42,068 (creation limit 49,152) |
| Guard removals | the 89 new entries (Q..) and the 5 re-pinned ones, one at a time: every one fails at least one test (table above) |
| Sepolia fork suite | not run this time (no contract the fork tests read changed shape; run it before any deploy) |

### Not built, and open

- The app page, the owner's list and status screens, the records and the export, the public "Raised before Creaton"
  card (section 6); the milestone 5 server reading the new events.
- Fixing the leaves (counsel's checks, wallet proofs, attestation) and the real text, summary, long-stop and lock-up
  setting. The owner's own seed amount (the list total is an input).
- HolderVote and Council (milestone 9), with the progressive-decentralization requirement in `docs/PLAN-V2.md`.
- **Questions for counsel** (questions only; nothing here is legal advice):
  1. How does the DAO LLC value and record each team payment in Shares when there is no market yet (before the
     auction) and after it?
  2. The manager of the DAO LLC paying a company its owner controls is a related-party payment: what approval, conflict
     rule, record or disclosure do the Marshall Islands DAO Act and the LLC agreement need, and should a second signer
     (the Pair) or an outside check be required for each payment?
  3. How must the team budget be disclosed to the earlier backers (the SAFT replacement text, section 4) and to auction
     buyers (the auction page), and is a public on-chain earmark enough?
  4. Is the unpaid team budget a liability of the DAO LLC or only an earmark? If the manager stops working before it is
     used up, who decides what happens to the rest, and should it then return to the reserve?
  5. Does paying for services in Shares, monthly, raise securities questions (an offer and sale each month, US and
     non-US rules), and does the answer change before and after the market?
  Each person's own tax treatment of team pay is a matter for their own adviser and is not recorded here.
