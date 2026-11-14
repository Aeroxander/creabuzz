# Plain words: the guide for Creaton copy

For anyone rewriting text people read in the web app. It sits beside the repo rules in CLAUDE.md (User-facing
copy), which `pnpm check:copy` enforces. This guide covers what that check cannot: tone, jargon, and the words that
must not change. Built from the copy modules under `web/src/features/launchpad/lib`, `identity/lib/mode-copy.ts`,
`identity/lib/account-copy.ts` and a sample of screens. Where the app already has a majority word, use it.

## 1. The reader and the voice

The reader is sharp and has never used crypto, a DAO, a code host or a wallet. They know what a project, money, a
vote, a deadline and a contract are. Assume nothing else. Test: could they act on this line without asking anyone?

- Warm, direct, second person. "You" is the person; "the team", "the reviewers", "holders" are others.
- Short sentences, one idea each, about 20 words at most. Active voice, present tense. Sentence case.
- Say what it means for the person, then what to do next. Lead with the thing they care about.
- No hype, no exclamation marks, no emoji, no "simply", "just", "easily", "seamless". Clear beats cute.
- The product is Creaton, from `APP_NAME` in `shared/constants/brand.ts`. Say "server" not "relay", "secret key" not
  "nsec", "public key" not "npub". Never name an organisation, paper or competitor.
- Keep protocol detail (event kinds, NIP numbers, `.sol` references, Q96, key formats, raw errors, hashes) out of
  main copy. If a power user needs it, put it in `TechnicalDetails` (`shared/ui/technical-details.tsx`).
- Explain a word once, where it first appears on a screen: one short line, or a `MoreInfo` (`shared/ui/more-info.tsx`).
  Do not explain it again on the same screen. Use one word per idea on a screen, never two.
- Text sizes are rem tokens only (`text-sm`, `text-2xs`). Never add px or rem literals. Never add to the allowlist in
  `web/scripts/check-copy.mjs`; rewrite the text instead.

## 2. Scope of a copy pass

Change text only: string literals and JSX text. Do not touch logic, numbers, helper outputs, test ids, aria
labels that tests find, translations of units, or the `Shares` / `non-voting shares` choice. Reword whole
sentences, not single words, so the line still reads well. Keep the same placeholders (`${...}`) in the same
meaning. If a rewrite needs a fact you cannot see in the code, keep the original and report it.

## 3. Term table

"Say" is the plain replacement. "May stay" says when the original is fine; the first use on a screen then needs a
one-line explanation (the quoted line). Counts are rough usage in visible strings today; consistency beats novelty.

| Term | Say instead | May stay when |
|---|---|---|
| treasury | the project's money | Tab or heading name, if the first line says "The money the project holds together." |
| quorum | the share of votes needed for a decision to count | Never in main copy. |
| vesting | unlock over time; unlock schedule | Never in main copy. "Unlock" is already the app's word (92 uses). |
| ragequit | leave with your share | Code and test ids only. The app already says "leave" and "exit". |
| allowance | one of four things. Yearly limit on new Shares; Shares left for a work area; spending approval; AI usage limit. Name which. | Never bare. "Spending approval: what you let the market take from your account." |
| slashing, slash | lose part of the deposit; the deposit is taken | Never. |
| escrow | held; set aside until | Never. "Holds" is the app's word in rounds and bids. |
| on-chain, onchain | on the network; recorded publicly; enforced by the network's rules | Technical details only. "Network" is the app's word (110 uses). |
| gas | network fees; fees | Never. "Fees are covered" is the app's phrase. |
| transaction, tx | payment (if money moves); step; request | Technical details only. Never show "tx". |
| hash, id string | confirmation ID | "ID" is fine. Say what it is for: "Keep it to look the record up later." |
| signature, sign (a request) | approve; confirm with your passkey | "Sign in" and "Sign out" are fine: they mean logging in and out. |
| wallet | your account (passkey); "a wallet app" for an outside app | When the person must connect an outside app: "A wallet is an app that holds your money and proves it is you." |
| payment wallet | where you get paid | The profile field name, with that explanation under it. |
| address | account address | "Like an account number for the network. Share it only to get paid." |
| passkey | passkey | Keep. First use: "A passkey signs you in with your fingerprint, face or device PIN." |
| recovery key | recovery key | Keep (21 uses). First use: "The only way back into your account if this browser forgets you. Keep it private." |
| smart account, sponsored account, UserOp | passkey account; "we cover the fees" | Technical details only. |
| DAO | the project; the project's shared rules and money | Start-flow explainer and Discover headings, once: "A DAO is a project run by its holders' votes, with its money held in the open." |
| delegate, delegation | hand your votes to someone; your votes: handed to Sam | Never as a heading alone. |
| mandate | work area (105 uses) | Never. Code only. |
| budget, work budget | work budget | Keep. First use: "A limit on how many Shares the project can award for work." |
| bond | bond | Keep (88 uses vs 12 for deposit). First use: "A bond is a deposit you lose if you act carelessly." Use one word per screen. |
| deposit (court, claims) | deposit | Keep. Say who gets it back and when. |
| tranche | batch (sales); part (milestones) | Never. |
| milestone | milestone | Keep. "A step with a check before its Shares unlock." |
| claim (work) | submission; piece of work | Never for work. Contracts say "claim"; screens say "submission". |
| claim (receive) | collect | Keep "collect" for taking what you are owed after a round or sale. |
| claim (a holder's challenge) | objection | Keep "objection". "Challenge" only as a button if the card already says so. |
| bounty | bounty | Keep. "Money set aside for one piece of work." |
| epoch | period; "about a week (7 to 8 days)" | Operator tools only, with its real length in days. |
| round, weekly round | weekly round | Keep. First use: "Once a week, holders who want out are matched with people who want in, at one price." |
| settle (a round) | settle | Keep (button). First use: "Settling works out the price and who gets what. Anyone can do it." |
| lot, step, floor, grid | lot: a fixed bundle of Shares; step: one price level; floor: the lowest price | Keep "lot" and "floor price", each explained once. Say "grid" never. |
| listing, market | weekly market; "the project's weekly market listing" | Keep both (market 42, listing 19). Explain once. |
| graduation, kit, summon, launch (verb) | set up; make the project; start | Technical details only. "Launch" as a noun is the page's name: keep. |
| remix | a project built on another | Keep. "Builds on another project and says so on both pages." |
| court, juror, appeal, uphold | keep all four | First use: "Jurors are people who put down a deposit to decide a dispute." Say "uphold" as "agree with". |
| stake (court) | deposit | Keep with CREATE and seat explained. See section 4 for stake as ownership. |
| seat | seat | Keep in court. "A seat is the smallest deposit a juror can hold." |
| burn | destroy; remove for good | Never. |
| mint, minted | create; created | Never. |
| unearned Shares | Shares not yet earned | Keep. |
| pro rata | in proportion to what each holds | Never. |
| token | token | Keep. "A token is a unit the project issues; Shares are its voting token." |
| USDC, ETH, CREATE | same, always after the number | Keep exactly. Explain once: "USDC is a digital dollar." CREATE: "the court's deposit token." |
| network | the network; "the test network" | Keep. Never "chain". |
| contract | contract | Keep: the reader knows contracts. "A program that holds and moves the money by fixed rules." |
| RPC, calldata, nonce, root, proof | (delete) | Never in main copy. |
| gate, program (trust scores) | a requirement; a scoring program | Operator panels only, one explanation line. |

## 4. Legally loaded terms: never rename, soften or drop

These carry legal meaning. A copy pass must not rename them, weaken them, or delete a line that contains them.

**Terms:** Shares, non-voting shares, sale, sell, buy, bid, offer, price, floor price, invest, return, profit,
dividend, payout, refund, guarantee, own, owner, holder, stake as ownership ("Stake allocation" in a pitch), fees on
exit, vote (what a Share does), and anything inside a risk or sale disclosure.

**Rules**
1. Simplify the sentence around the term. Never change what it says or how strongly.
2. Keep capital-S "Shares" (the voting kind) and lower-case "non-voting shares" exactly as the app uses them.
   `roundUnit` in `rounds-copy.ts` picks between them on purpose.
3. Never delete a disclosure. Never move one away from the action it guards. Never shorten a risk line to fit.
4. Never add a promise or a hint of returns. In sale, market or Share copy, add no "earn", "grow", "benefit",
   "upside", "safe" or "protected".
5. Keep every number, percentage, date and unit as the code produces it. Do not change an economic parameter.
6. Trading stays off by default in hosted and pilot builds. Do not touch that switch or imply trading is on.
7. If a legal wording looks too technical, change nothing. Put it in your report under `needs_human` with the file,
   the current wording, your proposed plain version and why. A human and counsel decide.
8. Tests such as `trading-copy.test.mjs` pin sentences. Change a pinned sentence only when the meaning is
   identical, and update the test in the same commit. Never loosen a test to get green.

**Disclosures to leave untouched** (examples, not a full list): the buyer notes and trading limits in
`launchpad/lib/trading-copy.ts` ("You may get back less than you paid", "The market's code has not had an outside
security or legal review yet", "Do not trade with money you cannot lose"); "Shares held in a round don't vote and
don't earn payouts"; the refund lines in `launchpad/lib/amounts.ts` ("Nothing is lost but the transaction fees"); and
the entity and IP lines in `launchpad/lib/ip-record.ts` ("Holders have no claim on it"). Where such a line holds a
technical word (code, transaction fees), record it for a human; do not swap it.

## 5. Patterns

**Errors.** Say what happened, then what to do. If money or a request may or may not have moved, say which.
- Shape: "Couldn't save your profile. Try again." (`identity/ui/ProfileMenu.tsx`). Cause, then step.
- With a cause: "This browser could not save your account. Check that it allows site data, then try again."
- With money: say "Nothing was sent." or "Your payment went through." Never leave the person guessing.
- Not blame ("You entered..."), not "Something went wrong", not "Failed to", "Invalid" or "Error:".
- Raw words (server codes, hashes) go in `TechnicalDetails` through `failureWords`, never in the sentence.
- One way forward: Try again, a named fix, or who to ask. Never "contact support" with nothing else.

**Empty states.** Say what belongs here, then how to get the first one. "No ideas yet. Share one and it shows up
here." (`discover/ui/DiscoverPage.tsx`). Never "No data" or "Nothing found". If it fills on its own, say when.

**Buttons.** Two or three words, verb first, naming the object when two could be confused ("Settle the round", not
"Settle"). The busy label ends in an ellipsis: "Collecting…". No "OK", "Yes", "Submit" alone. The destructive
button repeats the action ("Sign out", "Take it off"), never "Confirm".

**Confirmations.** Title is a question naming the object: "Sign out of this browser?". Body states the consequence
and how to undo it: "This browser forgets your passkey too. To sign back in, you need your recovery key."
(`identity/ui/ProfileMenu.tsx`). Say if it cannot be undone. For money, name the amount, who gets it, and when.

**Amounts.** Number, space, unit symbol: "12.5 USDC", "2.5%", "4 Shares". Keep the decimals the helper shows. Never
round, convert or reword a unit. "A Share" for per-unit prices. Say "about" only where the original does.

**Dates and times.** A deadline someone must act before carries the time and the zone, as `deadline()` in
`challenge-copy.ts` does ("Nov 5, 2:00 PM PST"). A past event may be a day: "Nov 5, 2026". Spans use `span()`: "7
days", "less than 2 hours". Never "tomorrow", "soon" or "in 24 hours" for a deadline. Follow-up for a human:
`date()` in `rounds-copy.ts` shows a time without a zone, while `trading-copy.ts` includes the zone.

**Plurals.** Always handle one: "1 seat", "2 seats", "1 lot", "3 lots". Numerals for counts. No "(s)". For zero,
use words: "You have nothing staked.", "No reports right now."

## 6. Before and after (real strings)

After-text keeps every number and name the code fills in. Placeholders show as X. Check the surrounding screen
before you apply one: the meaning must still hold.

| # | File | Before | After |
|---|---|---|---|
| 1 | launchpad/ui/TreasuryTab.tsx | Read the treasury's balance of the launch token over RPC. | Check how much of the project's token the project holds. |
| 2 | launchpad/ui/ManagePanel.tsx | Onchain step sent. The hash above is filled in. | Sent. The confirmation ID above is filled in. |
| 3 | launchpad/ui/ManagePanel.tsx | The onchain submit was not sent. | Your submission was not sent. Try again. |
| 4 | launchpad/ui/ManagePanel.tsx | This launch isn't set up for onchain milestones yet. Link its milestone contracts on the launch record first. | This project can't hold milestone payments yet. Link its milestone contracts on its project page first. |
| 5 | budgets/lib/budgetForm.ts | Only an on-chain allowance can stop spending. | Only a spending limit built into the contract can stop spending. |
| 6 | launchpad/ui/DelegationCard.tsx | Delegation landed (tx 0x12ab…) but it could not be saved to this project's record. It still counts. | Your votes were handed over (confirmation 0x12ab…), but we could not save that to the project's record. They still count. |
| 7 | launchpad/ui/DelegationCard.tsx | The delegation was not sent. | Your votes were not handed over. Try again. |
| 8 | launchpad/ui/ClaimPaidLine.tsx | Paid; its payout transaction was not found in the history this page reads. | Paid. We could not find the payment in the records this page reads. Refresh in a moment. |
| 9 | launchpad/ui/TxLink.tsx | This network has no public page for transactions, so only its id is shown. | Only the record's ID is shown. Keep it if you need to look the record up later. |
| 10 | launchpad/ui/decision-forms.tsx | That is more new Shares than this year allows: X are left to award. | That is more than this year's limit on new Shares. X can still be awarded this year. |
| 11 | launchpad/ui/decision-forms.tsx | This changes what the DAO can do or spend, so it takes the full vote. | This changes what the project can do or spend, so it needs the full vote. |
| 12 | launchpad/ui/ChallengeMilestoneCard.tsx | You post a deposit of X. You get it back, with half of the team's bond, if holders uphold your objection. If they do not, it goes to the DAO. | You put down a deposit of X. If holders agree with your objection, you get it back plus half of the team's bond (the deposit it put down). If they do not, it goes to the project. |
| 13 | start/lib/contributor-gate.ts | Connect a wallet. It holds your starting Shares and sends the one transaction that makes the project. | Connect a wallet app. It holds your starting Shares and confirms the one step that makes the project. |
| 14 | launchpad/lib/unlock-plans.ts | Short vesting is 3 or 6 months. | A short unlock schedule is 3 or 6 months. |
| 15 | launchpad/lib/unlock-plans.ts | Milestone tranches must add up to 100% of the milestone allocation (they add up to X%). | The milestone parts must add up to 100% of the Shares set aside for milestones (they add up to X%). |
| 16 | launchpad/lib/unlock-plans.ts | Milestone payouts can be enforced onchain: each milestone becomes a claim whose payout is held in escrow and released only when enough verifiers approve it. | The network can enforce milestone payouts: each milestone becomes a submission, its payout is set aside, and it is released only when enough reviewers approve it. |
| 17 | launchpad/ui/PowersCard.tsx | Give up a team member's unearned Shares. They are burned, never released for sale. | Take back a team member's unearned Shares. They are destroyed and never put up for sale. |
| 18 | start/lib/start-steps.ts | After a raise the project becomes a DAO: owners vote on decisions, work is paid when reviewers approve it, and a public track record shows what happened. | After a raise the project is run by its owners: they vote on decisions, work is paid when reviewers approve it, and a public track record shows what happened. |
| 19 | launchpad/lib/sale-plans.ts | The whole tranche sells at the price you set or every bid refunds. | The whole batch sells at the price you set, or every bid is refunded. (Refund stays; only tranche changes.) |
| 20 | launchpad/ui/create-wizard/AdvancedFields.tsx | Receives the minted supply. Optional now. | Receives the newly created supply. Optional for now. |
| 21 | launchpad/ui/FundingFlagForm.tsx | Does the treasury hold another token? | Does the project's money include another token? |
| 22 | discover/ui/DiscoverCards.tsx | · minted at summon | · set when the project was made |
| 23 | launchpad/ui/OverviewTab.tsx | Vesting package | Unlock schedule |
| 24 | launchpad/ui/OverviewTab.tsx | Parameter hash | Settings ID |
| 25 | identity/ui/PaymentWalletCard.tsx | This account linked a smart account, which has to be checked on the network, and that check could not be made just now. Try again in a moment. | This account uses a wallet that can only be checked on the network, and the check did not go through. Try again in a moment. |
| 26 | identity/lib/siwe.ts | The wallet signature did not match your account. Sign with an ordinary wallet, not a smart-contract one. | Your wallet's approval did not match your account. Use a standard wallet app, not a contract-based one, then try again. |
| 27 | identity/ui/PaymentWalletCard.tsx | Waiting for signatures… / Sign with my passkey account | Waiting for your approval… / Approve with my passkey account |
| 28 | start/lib/contributor-flow.ts | this site cannot confirm that this project's kit made the DAO at the address this project would use. Nothing was sent. | We could not confirm that this project was made at the address we expect. Nothing was sent. |
| 29 | launchpad/ui/enforcement-forms.tsx | That reviewer no longer holds a bond that could be taken. Choose which one you mean. | That reviewer has no bond left that could be taken. Pick the reviewer you mean. |
| 30 | launchpad/ui/LaunchPanelFields.tsx | Each reviewer posts this before judging, and loses it if the DAO finds they approved carelessly. | Each reviewer puts this down before judging, and loses it if the project finds they approved carelessly. |
| 31 | discover/ui/DiscoverPage.tsx | No DAOs yet. A project's DAO shows up here once it is set up. | No projects with shared funds yet. One shows up here once it is set up. |
| 32 | launchpad/lib/challenge-copy.ts | ...holders upheld it: the team's remaining locked Shares were burned. | ...holders agreed: the team's remaining locked Shares were destroyed. |
| 33 | launchpad/lib/court-copy.ts | Take out all of it, or leave at least X CREATE: one seat. | Take out all of it, or leave at least X CREATE: one seat, the smallest deposit a juror can hold. |
| 34 | launchpad/ui/PowersCard.tsx | Switch leaving off, or burn a holder's Shares: this DAO was made before those powers were removed. | Switch leaving off, or destroy a holder's Shares: this project was made before those powers were removed. |

**Leave as is** (already plain, or legally loaded): `launchpad/lib/rounds-copy.ts` "Leaving now pays about X a Share,
after the Y% exit fee."; `launchpad/lib/trading-copy.ts` "You may get back less than you paid."; `launchpad/lib/post-bounty-copy.ts`
"Nothing was agreed by the deadline."; `launchpad/ui/create-wizard/WizardSteps.tsx` "What one
token costs, in ETH. 0.000004 is four millionths of an ETH."; `identity/lib/account-copy.ts` "Create your account".

## 7. Checklist before you commit

1. Could someone who has never used crypto act on every line, with no outside help?
2. Is each jargon word either replaced, or explained once where it first appears?
3. One word per idea on the screen. Same word the rest of the app uses (check the term table first).
4. Every legally loaded term and every disclosure is exactly as strong as before. Nothing added that hints at returns.
5. Every number, unit, percentage, date and time zone is unchanged. Plurals still handle 1.
6. Each error says what happened and what to do next. Each button is a verb. Each confirmation states the consequence.
7. No exclamation marks, emoji, hype, citations, protocol names, `relay`, `nsec`, `npub`, or product name typed by hand.
8. No new px or rem text sizes. No new allowlist entries.
9. Tests that pin a changed sentence are updated in the same commit, never loosened. Test ids and code are untouched.
10. `pnpm check:copy` passes from `web/`. Unsure items are in your `needs_human` report, not edited.
