# What to hand to the lawyer, and what to get back

## Send these four files

1. `docs/policies/TERMS-DRAFT.md`: the terms of use, as the drafts stand now.
2. `docs/policies/PRIVACY-DRAFT.md`: the privacy note.
3. `docs/policies/LAWYER-FEEDBACK-RESPONSE.md`: what we changed after the two reviews, and what is still open. The section "Order to settle things before the pilot" is the checklist.
4. `docs/operator-takedown-and-data-requests.md`: the steps the terms promise (takedowns, appeals, put-back, requests from authorities). Counsel should confirm the authority-request steps.

For the weekly-sales questions (needed before any real money, not for the test pilot), also send `docs/v3-review/LAWYER-BRIEF-WEEKLY-SALES.md`.

**Update, 21 November 2026:** the product changed (back and take out any day, one pot, a daily allowance, planned tasks, Team Shares). Both drafts were brought in line with it, and each starts with a bracketed change note saying that counsel has not reviewed the changes. Also send `docs/next-version/JOIN-LEAVE-DESIGN.md` (sections 1, 2 and 12 say what the product does and what is open). The section "The live questions" at the end of this page replaces the weekly-sales brief as the list to answer first; the brief is kept for the parts that still apply.

## Facts only you can give the lawyer (they go into the brackets)

- Your name and legal form, and your postal address.
- Contact emails: general, takedown and abuse, appeals, data requests.
- Hosting: OVH, United States. Backups run on the same server and are encrypted to a key held off the server.
- Whether the server disks are encrypted (ask OVH, or say "not known" and delete the line).
- Whether the AI helpers are switched on (today: no, unless you set it up) and whether error reporting is on (today: no).
- Services that see data: Alchemy (chain node), ZeroDev (passkey accounts), and the AI service if it is on.
- How long logs, reports and the security record are kept, and how often backups run and for how long they are kept.
- The mobile app is not offered in the pilot (so the mobile bracket can be deleted).

## What the lawyer decides (they go into the brackets)

Who the data controller is, and whether an EU or UK representative is needed. The legal basis for each use of data. The safeguard for sending data abroad, and each provider's role. The liability cap, governing law and courts. The copyright agent, the waiting period before put-back, the repeat-infringer rule, and the EU dispute body. Any age above 18, and the portable-copy scope.

## What to ask them to send back

Two finished files, `terms.md` and `privacy.md`:

- Plain Markdown, with headings, lists and paragraphs only. No tables (the server's pages do not show them).
- No `[bracket]` left. A bracket inside a code fence or a link is allowed, anything else makes the server refuse to start.
- A real date on the line `Last updated: …` at the top (not `[date]`).
- A sentence that promises something the software cannot do yet is deleted or reworded, not left in brackets.

## Then

Copy both to the server and run the command from the chat: it puts them in `deploy/compose/policies/`, sets `BUZZ_TERMS_FILE` and `BUZZ_PRIVACY_FILE`, records the text with `./run.sh policy-stamp`, and restarts the relay. Change the `Last updated` date whenever the text changes.

## The live questions (21 November 2026)

These are the questions in `docs/next-version/JOIN-LEAVE-DESIGN.md` section 12, for the product as it now stands. They are questions, not answers: nothing in the drafts decides any of them, and every passage that touches one is in brackets in the drafts. The first public launch is a test network with play dollars; none of this is meant to start real money. The legal line stays word for word as the app shows it: "Buyers acquire ownership only: governance and exit. No dividends or revenue share, ever, unless they contribute and earn one."

1. Does a pro-rata cash claim on a shared pot, open any day, change how the Shares are treated, with the line quoted as it stands?
2. Is a Team Share that can leave with money above what backers paid in a revenue share to the team (allowed for contributors under the line), pay, or another kind of interest?
3. Does taking 2% of money joining make Creaton a seller of an investment in some places?
4. The line says buyers get "governance and exit". Here governance is the notice and the right to leave, with no vote. Is an allowance plus noticed tasks, with no vote, acceptable disclosure for a team spending backers' money, and does the line still read true?
5. Is an insider who knows outside revenue is coming and joins first, then stays, a problem, and what notice or rule should stop it (the 7-day arriving bucket stops only the quick sandwich)?
6. Does money rising in the pot when outside payments arrive behave like a revenue share to buyers? (The design names this as the one place it may conflict with the line; the alternative is a separate income bucket.)
7. Does leaving by burning Shares change what a buyer acquires, and what must the page say?
8. Does a test network with play dollars avoid all of this for now, and what changes at the first real-money launch?
9. Which countries or buyers should the door stay shut to, and what may the platform host or moderate?
10. Earlier backers: may their signed terms (365 days from a market opening, ordinary Shares) be replaced by a Team grant that claims only above what backers put in, with a new text, a new fingerprint and a new consent?
11. Could a project's Shares be offered in the United States under the SEC's proposed Regulation Crypto Assets (proposed 18 August 2026, not final)? Is a Share with a cash claim on a shared pot a "covered" asset at all; is the project or the platform the issuer; does "no set fundraising amount" need a per-project ceiling on money in; what does the platform need for its own role?

Added by this update, for counsel to confirm (not in the design's list): whether letting any holder end a project that has been quiet for about six months, with no vote, is acceptable (see 4); whether an exit note, left to a holder who takes out while money is set aside for a task, is a separate kind of claim; and, in the privacy note, the roles and legal bases for alert subscriptions, the sponsored-fee counts, and the public holdings list and wallet link.

### Older questions the new model appears to make moot (for counsel to confirm)

- The weekly-sales brief's questions about the weekly sale itself, the single-price auction, escrow, bids and a member score deciding who may bid: appears moot, for counsel to confirm. There are no sales or auctions in this version (the design parks that code). Its classification and "who is the issuer" questions are still live in the new form, as 1, 3, 9 and 11 above.
- The plan's old points for counsel (`docs/PLAN-V2.md` section 10): a refundable fixed-price round that reads like a deposit, and CREATE's floor fed by fees on other people's raises: appear moot, for counsel to confirm (no rounds, no floor). "Creaton holding 2% of projects" appears moot too (the platform stake is dropped). "A wind-down splits what is left among holders" is replaced by the quiet wind-down above.
- The Uniswap licence point: matters only if a pool returns; appears moot for now, for counsel to confirm.
- The earlier-backers team budget questions (valuing team payments in Shares, related-party payments, disclosure of the budget, an unused budget if the manager stops): appear moot, for counsel to confirm, because the team budget is gone from the design. The earlier backers' own terms stay live as question 10.
- The automatic-decision question about a submission that lapses when nobody settles it, and the "no-burn rule" bracket for Shares paid for work: the old rules are gone, and the new automatic rules (the allowance, the notice, a task that lapses when not taken or accepted) raise the same question again, so the bracket stays in the terms in new words.
- Questions that depend on holders' votes: **no longer moot as of 22 November 2026.** The Council round adds a deploy switch (`COUNCIL`, off by default) under which holders vote to replace the runner and to elect two Council seats; with the switch off, nothing is voted on and the paragraph above still stands. **Question 4's premise therefore has two settings, and counsel is asked to answer it per setting** (see the section below).
- The lines about "nothing is voted on" elsewhere in this page read as the switch-off case; the switch-on case is the section below.

### The Council round's questions (22 November 2026), word for word from the plan

The first answer on the design's question 12.4 ("here governance is the notice and the right to leave, with no vote") assumed no vote.
With `COUNCIL=1` that premise is false; with it off it holds. **Counsel is asked for an answer per setting of the switch.** The legal
line is not edited.

- **C1.** With a real vote (replace the runner, elect seats), is "governance and exit" delivered in the stronger sense? Does that change the analysis of Shares themselves (voting rights as an indicium) or of the platform fee that buys a vote? Redo 12.4 for both settings of the switch.
- **C2.** Do voters who control who runs a pot, or Council seat holders (five accounts that decide the spending of others' money), face partnership, unincorporated-association, fiduciary or money-handling exposure? Does an AI agent holding a seat (V16 does not bar it) change that?
- **C3.** A candidate's text is a statement by someone seeking control of others' money, hosted in the platform's app. Is it a solicitation? What moderation, or "no promise of profit" rule, is required beyond the one plain line of V41, and should a text be removable after the fact?
- **C4.** Takeover disclosure: a holder of a third can take control for about the platform fee, and holders who do not look can lose about 12 in 100 within 30 days of the seat. What must the page and the terms say about that? The plan says only "taking out stays open".
- **C5.** Naming: "Council", "five accounts", "list". Is it misleading that five seats can be one person? Is showing the linked names of accounts that did not agree to be listed acceptable? Does the Council section's last line ("can do what a founder could do, with the same limits, and nothing more") read as reassurance?
- **C6.** Votes are public on a public chain and linked to accounts. Is "Posts and votes are public." enough for privacy and erasure rules?
- **C7.** The snapshot rule (only Shares parked before a vote opens count) means late joiners cannot take part. Is that fair, and does it need disclosure on the Back sheet (the plan shows the planned-change sentence there)?
- **C8.** The platform's helper presses `finish` and `carryOut`. Does automating a governance outcome make the platform a participant?
- **C9.** Play dollars on a test network: does a vote on play dollars avoid all of this, and what changes at the first real-money launch?
- **C10.** Questions 12.1, 12.7, 12.10 and 12.11 are not changed by this plan. The words "You can take your money out any time." alone (in an alert or a push, without the second half) are consistent with the existing planned-task push; counsel may want the pair kept together outside the app.
