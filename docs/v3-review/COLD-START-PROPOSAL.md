# An easier cold start: start alone, ask for help, let a lead choose helpers (proposal)

Status: proposal for owner decision, 2026-11-09. Branch `v4-governance-rework`. Nothing here is built, pushed, deployed or
enabled. D186 stands (peers advise, holders decide, Shares are votes). The build freeze (D137) is lifted only for the social
layer, so decision 1 asks whether the new records below count as that layer. No economic number changes.

## Summary

You asked for an app a stranger can use: start a project alone, ask for help, let someone offer to help for Shares, then
hand that person a part of the job, who can hand part of it on. I checked three designs for this against the code, the
contracts and prior art, and I agree with most of the shape and reject three of its parts. The real wall for a person with
no friends is not the form. It is that no Share can exist without reviewers who are not the founder, and a stranger knows
none. None of the three designs solves that; two of them hide it (a second account the founder controls checks their own
work, or "assume it is solved"). My answer is a **reviewer pool**: people who say, in a signed record, "I will check work
for new projects". Start then shrinks to a name, one sentence and one tap on a suggested panel, and no rule that D153 or D139
set is lifted. On top of that sit a request, an offer and an accept record, a "lead" who may choose helpers for one capped,
expiring part of the job, and plain-word changes across the app. **No contract change is needed for any of it.** Handing
the job on is worth doing one level deep now, two levels only after the pilot shows it works, and never as an open-ended
chain.

## Words, defined once

- **Shares**: votes in a project, earned by work the reviewers accepted. **Work budget**: the most Shares a project may award
  in 90 days. **Work area**: an opening on the network with fixed words for "done", a Shares limit, an end day and one
  person who accepts work into it (today called its manager; this proposal says **lead**).
- **Reviewers / panel**: the people who check finished work; usually 3, 2 must agree. **Objection period**: the 7 days after
  review when anyone holding Shares may object (the app says "challenge window" today).
- **Help request**: a signed note, before any work area exists, saying what is needed and what finished looks like.
  **Offer**: a signed note from a helper. **Accept**: the poster's signed note that they will ask holders to award a number of
  Shares if the work passes review. None of the three creates Shares.
- **Reviewer pool**: a public list of people who volunteered to check work for new projects. **Starter panel**: three pool
  members the server's operator names for the pilot, shown as such, until a project has its own.
- **Vouch**: D186's signed "I know them and would trust them with a small job". **Hand over your votes**: the existing card
  that moves voting power; a lead moves none.

## 1. Verdict: would "delegate further" be a good way to grow a DAO?

**Only with limits.** One level yes, a second level only after evidence, open depth no.

Evidence for a limited version (`c-priorart.md` is the scratchpad paper with sources; "fetched" there means opened):

- Every working example stops at one level. Questbook's one-level allocators moved about $4m to many small teams in a year
  (Arbitrum forum report, fetched). Moloch lets any outsider submit and any member sponsor, with a deposit at risk. Nouns tried
  sponsor-by-delegation, found sub-delegation unsupported and fragile, and replaced it with signatures (V3 spec, fetched).
- Where it grew, power flowed down in scoped, expiring slices and a holder could not raise their own scope (Colony, Hats).

Evidence against an open chain:

- I found no source showing a DAO that grew from a solo founder by letting helpers pass on the right to propose, level after
  level, and was then judged a success. That is a negative result from the sources opened, UNVERIFIED for the whole field.
- Delegation pools power. Optimism's top 20% of delegates held 82% of delegated tokens in 2023; in 2025 three tiers held over
  85% and five to seven delegates met quorum. The German Pirate Party's transitive chains made 38 voters with over 100
  delegations (no abuse found). Arbitrum: 0.63% of delegates carried about 98% of power, with 132 high-power delegates silent
  on an average vote. Delegators go quiet, so an inactive lead is the normal case, not the exception.
- Rewards tied to recruiting or levels are what the SEC (Forsage, 2022) and FTC staff guidance on multi-level selling (2024)
  describe. The FTC text is about product-selling plans, not DAOs, and I draw no legal conclusion. It matters because the
  shape (levels, people choosing people) invites the question. Counsel reads it (section 9).

Facts from the contracts (`b-contracts.md`, plus lines I re-read):

- A lead is a work area's manager. Only a holder vote creates one (`TreasuryMandate.approveProject` is `onlyDAO`,
  `TreasuryMandate.sol:313-333`). A manager cannot create sub-areas or be changed. So one level needs no contract change;
  a second level costs another vote of about 2.5 days, or a contract change.
- A contract change that makes nesting real is small in code (about 40 lines) but forces a new factory, voting policy,
  Summoner and kit, and only new projects can use it (section 7, C1).
- Shares cannot be taken back (D73), so every brake must act before the award.
- Delegation moves workload, not control. Awards are holder votes; with the default numbers the founder alone passes the
  lighter vote until others hold about 82% of the founder's own stake, and others alone pass against the founder only once
  about 122,000 Shares are awarded (`b-contracts.md` section 4, my arithmetic not measured).

So the owner's chain helps the founder's workload and the stranger's wait. It does not by itself grow the number of
people who finish pieces, and it concentrates choosing power. Limits I recommend are in section 5.

## 2. Where the three designs fall short (the judge's notes)

**d-solo (a ladder that needs only the founder).** Keep: the ladder idea, the public ledger, an "Ask for help" button,
starting with zero work areas (the chain allows it, `ContributorKit.sol:207-222`; the web refuses it, `contributor-project.ts:292-293`).
Reject:

- *Route A, a "founder check account".* The founder's own second account sits alone on the panel. D139 says "a founder cannot
  name a second account of theirs as a reviewer" (`DECISIONS.md:147`); D153 gave the reason: with one reviewer deciding
  alone, the founder decides every award (`contributor-project.ts:51-55`). Labels do not make it independent review, and
  the chain shows an unfamiliar single reviewer. It also needs an unconfirmed second-account spike. The sentence "new
  Shares are only given for work the reviewers accepted" becomes hollow, which is a counsel flag, not a copy fix.
- *Stage 3 is reachable by sock accounts.* "Three awarded people" are awarded by the founder's own votes, 1,500 Shares each
  under the 25,000 cap. They then become the panel, and the cap lifts to the whole 300,000. The vouch clause only helps if
  the vouchers are independent, which is what is missing.
- *"No money in" is a hidden card.* The treasury accepts a transfer from anyone; hiding "Send money" in one client protects
  nobody. The 25,000 cap is the same: an app promise.

**d-delegate (request, offer, choice, slice).** Keep: the records, the kept-promise line ("5 chosen, 5 awarded as agreed"),
the rule that nothing is rewarded for choosing or passing on, the report path, the worked example's honesty about the
15-day wait. Reject or shrink:

- It assumes the reviewers problem "is solved" (its section 10). A stranger on an empty server still stops there.
- The standing "Help wanted" work area with generic words weakens the only on-chain check on what "done" means. A
  per-request work area made by one prefilled vote costs about 2.5 days, which runs while the helper does the work.
  I choose that (decision 6).
- Five record kinds, eleven app-kept rules and a Phase A that cannot lower a work area's cap (a trimmed lead's Shares stay
  set aside until day 90) is too much for a first run. Below the first hop the caps are app promises.
- Its example gets Shares to a stranger on day 17, and the founder still votes every award. That is honest and correct.

**d-friendly (the whole app).** Keep: collapse never remove, leaving always visible to a holder, disclosures stay beside their
button, unknown shows more, a "Show all sections" switch, one next-step card, the word fixes. Shrink:

- Five kinds of person rest on hooks the design admits it did not find (has this person posted?). Three facts are enough:
  holds Shares, started a project, took something on.
- On an empty server its cards have nothing to point at ("Find a project that needs help" leads to "No projects on this
  server yet", `DiscoverPage.tsx:306`). Section 4 handles that.
- Renaming "work area" (116 lines) and "manager" (71 lines in 28 files) pins many tests. Do it with the new screens, not as a sweep.
- The checklist it replaces was removed in `392c7df` for a reason the commit does not record; ask before reviving it.

## 3. The cold-start walk: the top frictions

From `a-walk.md` (read from code, not run). A stranger with no invite, no follows and no Shares:

| # | Friction | Where | Covered by D186? | This proposal |
|---|---|---|---|---|
| 1 | The hosted server is invite-only and the sign-up dialog does not say so or take a code; the account made "can't read or post" | `InviteOnlySignUpNotice.tsx:20-24`; `PILOT-RUNBOOK.md:103-105` | No | Slice 0 says it first; "Ask for an invite" and a guest option are your call (decision 12) |
| 2 | A project needs 3 reviewers (2 agree) and none may be the founder | `contributor-project.ts:56-57,436-478` | No | Reviewer pool and starter panel (section 4) |
| 3 | The reviewer picker is empty on a young server: it lists only people who linked their name to a payment account | `use-people.ts:25-45` | In part (vouch line) | Link the name in the sign-up passkey step |
| 4 | Start has 12 boxes, 9 of them numbers or rules | `ContributorStartPage.tsx:514-654` | Yes (point 5) | Section 8 |
| 5 | "How you know each reviewer", 10 to 2000 characters, about people you have not met | `contributor-project.ts:481` | Yes (point 5) | Deleted, as D186 says |
| 6 | The founder is the only door: sole manager, sole holder, the only one who can approve new work | `contributor-flow.ts:93`; `ContributorKit.sol:113-117` | In part (seats) | Leads (section 5) |
| 7 | About 15 days from "submitted" to Shares, mostly waiting, nothing leaves the app | `PILOT-RUNBOOK.md:140-146` | No | Say it at Submit; a progress strip; email or push is server work for later |
| 8 | Four account steps: sign up, "Set up passkey sign-in" again, "Show your name", unlock each session; "without a passkey" cannot start, submit or be paid | `OnboardingDialog.tsx:256-292`; `contributor-gate.ts:123-134` | No | One path, "Continue with a passkey" |
| 9 | A helper must name a price in a project they have never seen; only a holder with 1% of the founder's Shares can put it to a vote | `SuggestedWork.tsx:140-215`; `proposal-gate.ts:27-60` | No | "Offer to help" with no price |
| 10 | Nine project tabs and words that change by screen ("challenge window", "Finish the review" next to "Mark it finished") | `launch-tabs.ts:33-43`; `dao-overview.ts:376,454` | No | Section 6 |

## 4. The solo ladder, and what a stranger sees on an empty server

**The keystone: a reviewer pool.** A pool entry is a signed, withdrawable record: "I will check work for new projects",
visible to members, with a limit of 5 live panels per person (a guess, to protect their time). A founder's Start shows three
pool members as a suggested panel, least loaded first, with the vouch line; they can swap any. Pool members agreed in
advance, so nobody is named without consent. The chain needs only addresses (`ContributorKit.sol:122,132`); 3 reviewers and
2 agreeing stays a web rule (D153) and I do not lower it. This is a server record like the vouch (effort UNVERIFIED).

**Starter panel for the pilot.** A young server has no pool. The operator names three willing people (you plus two testers is
my suggestion; you choose). The project page says "Checked by this server's starter reviewers". It is honest but it makes
the operator the gatekeeper of every stranger's first Shares, so it ends for a project when three other people hold awards,
and counsel reads it (section 9).

**Real controls against a founder awarding themselves everything.** I will not claim more than these:

1. The chain: no Share exists without a claim the panel approved (`awardContribution`, `settleAgreement`; `b-contracts.md`
   section 1). With an independent panel this is a real gate.
2. App rule: the award form leaves out the founder's acting account and every address their name is linked to (D139's list).
3. A public ledger on the project header: who holds what, "Founder: 97%", who checked.
4. Dilution shown at Start: if the whole work budget is awarded the founder holds 25%.
5. Not controlled: unlinked sock accounts. A founder with two unlinked accounts and two sock pool members can still pass
   awards to themselves. Today's 3-reviewer rule does not stop that either. Say so on screen: "Accounts the founder has not
   linked to their name cannot be counted."

**The ladder.** Each rung is shown from public records, never voted on, and unlocks no money, trading or votes.

| Rung | What it is | People needed | Who checks | Moves up when |
|---|---|---|---|---|
| 0 Idea | Exists today: a name and one sentence, no reviewers, no Shares. New: Ask for help and offers can be posted on it | 1 | nobody yet | You press "Make it a project" |
| 1 Project | Start (section 8): 100,000 Shares to you, work budget as today, starter or pool panel | founder plus the panel | the panel, 2 of 3 | One outside person's piece is awarded |
| 2 First helper | A lead may be named for one request (hop 1) | 2 plus the panel | same | Three outside people awarded, shown with their vouch lines |
| 3 Own panel | At the next 90-day work budget the panel is pre-filled from helpers and the pool (D186 point 7); holders vote it | 4 plus | helpers | Eight members: Thanks advice (D186 point 10) |

The people needed before the first Shares fall from five today (founder, three reviewers, a contributor) to the founder
plus a helper, with the panel supplied by the pool.

**What a stranger sees on an empty server.** `a-walk.md` step 3: a signed-in newcomer on Home sees a feed that says "Nothing
here yet", four tabs, six nav items and no suggestion. None of the three designs fills that. Fix, in order:

1. Seed the server before inviting anyone: the Creaton example project (`CREATON-EXAMPLE-PROJECT.md`) already exists as seed
   content with its reviewers. Add two real help requests to it. Then Discover is never empty.
2. The signed-out welcome says "invite-only for now" before the dialog (slice 0).
3. The first-run card (section 6) points at that project's requests. On a truly empty server it offers only "Share an idea".
4. If a person has no invite, an account that cannot read or post is a dead end. A "guest" membership, read and post only, is
   a server setting I did not read; whether it exists is UNVERIFIED. Decision 12.

## 5. The request, offer and lead loop: what I recommend

**The loop, in your words.** You start a project alone (section 8). You post a help request. Someone offers, with no price.
You accept an offer; the helper confirms. The app opens the existing "Approve a work area" vote prefilled with the request's
exact words, so the check on "done" is a hash on the network; the vote runs while the helper works. The helper submits, you
accept it into review, the panel checks, the 7-day objection period runs, the helper confirms it is done, you open the award
vote prefilled with the accepted number, holders vote. About 15 to 17 days, as today. Shares come only from that vote.

**What changes for each person.** Founder: from four taps per piece (choose, accept, open the vote, vote) toward fewer once a
lead exists. Helper: no price needed, one place to see where the piece is. Reviewer: sees the request's own words beside the
submission. Holder: sees "chosen 1,500, awarded 1,500" so a promise is compared with what happened.

**A lead.** A person the founder names for one request or one limit of Shares, until a date. In the first run a lead can
*choose helpers*: read offers, recommend one, post follow-up requests. That is advice; the founder still accepts and votes.
Later, with a prefilled vote, a lead can also be made the work area's manager ("run it"), which is real network authority
and costs one vote. A lead gets Shares only for their own accepted piece, chosen by someone above them.

**Limits I recommend** (all are guesses for the pilot; none is an economic parameter. The 2% figure sets aside part of the
work budget that you defined, so confirm it, decision 9):

| Limit | Recommended | Why |
|---|---|---|
| Depth | 1 hop (founder to lead) in the second pilot run; 2 hops only after the evidence gate below; never 3 | Every working example stops at one level |
| Evidence gate for hop 2 | At least 5 strangers awarded through hop 1, kept-promise rate 80% or more, no stop condition hit | Hop 2 adds a person who must act and a delay |
| Width | At most 3 live leads per project; one live role per person; no cycles | Bounds who can be a hub |
| Size | One lead's limit at most 2% of the work budget (6,000 by default); the sum of live leads at most 6% | Dilution stays small and visible |
| Time | A lead's role ends at its date, default 30 days, never after the work budget's end | The founder's renewal is the review |
| Consent | A role is live only after the person says yes | Nobody is named to a commitment unasked |
| Self-dealing | Nobody chooses themselves; the lead's own piece is chosen and accepted by the person who named them | Matches the manager rule on the network |
| Proof | A lead needs one piece the reviewers accepted here, or a vouch from the giver; the founder may override at hop 1 with a visible "not yet proven" label | Vouches alone can be faked by two accomplices (`SOCIAL-FIRST-PROPOSAL.md:103-108`) |
| Pace | 5 live offers per person, 5 live requests per poster | Bounds spam and reviewer load |
| Reward | **Nothing is awarded, counted, ranked or shown for choosing helpers, passing a role on or inviting anyone.** A product rule and a test | The line the evidence supports |

**Rejected:**

- Open depth, or depth 3 and deeper (Hats allows 14; that is a tooling ceiling).
- Any Share, rank, badge, counter or leaderboard for recruiting, inviting, choosing or delegating.
- Paying leads to show up (Arbitrum and Uniswap paid delegates raised attendance with unproven quality, `c-priorart.md` C3).
- Mode B, the agreed-reward path that lets a manager fix an exact award anyone can settle with no holder vote. It is marked
  "not deployed" (`TreasuryMandate.sol:87`), turns a manager into someone who can create Shares with only the panel's say,
  and awards cannot be undone.
- A standing generic "Help wanted" work area; a founder self-check account; any "solo mint" path.
- A stage badge computed in the browser as the only evidence of independence.

**The MLM-looking shape, said plainly.** Levels of people each choosing the next, with Shares at the bottom, looks like the
structures regulators describe. What differs here is that no level is paid for the level below; the only way to get Shares is
an accepted piece. Two real risks remain. One is the appearance, which counsel reads. The other is not money but votes:
Shares are votes, so a lead who chooses helpers builds a bloc of people who owe them. The brakes are that holders vote
every award, the project page shows "Awards by lead" and stops the loop if over 40% of awards sit under one lead.

**Delegate capture and inactive leads.** An inactive lead stalls only their own choices: they have no network power in the
first run, and the founder accepts any matching submission. A lead who goes bad can recommend fake accounts; each needs a
panel approval and a separate award vote that shows "new here, no vouches". The worst case is the lead's limit, not the
budget (if all 6,000 Shares were awarded, the founder's part would fall from 100% to about 94%: 100,000 of 106,000). Taking a role back is a signed
note: complete for the advice-only lead, partial for a manager lead until the contract change in section 7.

## 6. The consumer-friendly map

Rules every row obeys: collapse, never remove; leaving (D73) is always one click from a holder, even at zero balance;
every disclosure stays beside the button it guards (`PLAIN-WORDS.md` section 4, rule 3); if a fact cannot be read, show
more, not less; the switch "Show all sections" in the account menu restores today's navigation; nothing that must be
reliable lives in the browser.

| Area | Holds no Shares and started nothing | Holds Shares | Founder |
|---|---|---|---|
| Top bar | Home, Projects (was Discover), Start a project, search, account | plus Your projects (was Your work) | same |
| Home | Feed plus one next-step card | plus "Waiting on you" above the card | plus their projects |
| Project tabs | Overview, Work, Discussion; Contributions after the first award; the rest by link | plus Decisions, Funds (leave panel always) | all, as today |
| Funds | read-only, shown only if the project holds money | always visible; "Hand over your votes" moves to Decisions | yes |
| Decisions list | Award, Approve a work area, Set aside a work budget | same | same; freeze, reject, bond, close under "Raise a concern" |
| Court, forecasts, trading, bounties | off in the hosted build; no card ever points at them | same | same |
| Communities | hidden when the server has one community; kept in the account menu | same | same |

**The next-step card** replaces nothing that waits on you. Rules: one card, one reason, one button, one "Not now";
chosen from facts the app has read, never ticked by the person; shown only when nothing is waiting on you; never about money,
trading or returns; never rewards anyone for inviting. First tried to last: save your recovery key (if you hold anything);
add your name; see a project that needs help; take on a request; "Your piece is due"; "You hold N Shares: they are votes,
and you can leave" (the leave line copied from the leave panel unchanged); not voting, so hand over your votes; ask for
help (founder); "Your first work budget ends on <date>" (founders are not told today, UNVERIFIED). The old checklist was
removed for an unrecorded reason, so decision 13 asks first.

**Words.** One chain of verbs a person learns once: request, offer, accept, submit, check, award. Keep Shares, reviewers, award.
Say "objection period" for the 7 days and "Shares for work" wherever a newcomer reads "work budget". "Lead" for manager and
"help request" for the pre-network ask, added to the term table. "Slice", "run", "delegate" and "stage" stay out of screens;
"delegate" already means handing over votes. Replace "earn" beside Shares only after counsel reads it (`HomeHero.tsx:61-63`,
`contributor-start-copy.ts:21-23`).

## 7. Slices, in order

Each is small, web or server records only, and shippable on the Sepolia pilot in a second run, not the running one (changing
the form mid-run would spoil the D137 comparison). Sizes are my guesses; nobody has sized the server code.

| # | Slice | Needs | Size | Gate to start the next |
|---|---|---|---|---|
| 0 | Words and gates only: "invite-only" on the welcome; "about two weeks, most of it a 7-day wait" at Submit; "Continue with a passkey" as the primary button; "Accept this piece" / "Start the objection period" / "Confirm it is done"; "objection period"; Discover to Projects; Your work to Your projects; hand-over card to Decisions; fold rare decision kinds | Update the tests that pin sentences, in the same commit | S, a day or two | Copy read once by a human |
| 1 | The front door: link the name at sign-up so the picker lists everyone; the vouch (D186); the reviewer pool and starter panel; Start cut to name, sentence and panel | Two server records (vouch, pool) | M to L, UNVERIFIED | Testers can say back "a vouch is not a score" |
| 2 | Help request, offer, accept; prefilled work-area vote; progress strip on each piece; kept-promise line; zero first work areas | Two or three records | L, UNVERIFIED | Requests get offers within 7 days |
| 3 | The map: three tabs for newcomers, "Show all sections", the next-step card (if decision 13 is yes) | Web only | M | Newcomers act within 10 minutes of arriving |
| 4 | Leads, hop 1, advice only; then "run it" through the existing vote | Records; one prefilled vote | M | Evidence gate in section 5 |
| 5 | Hop 2; stage strip; the paper Thanks round (D186 point 10, independent) | Records | S | Counsel read; stop conditions clear |

The vouch and picker line stay as D186 decided them. Slice 0 can ship as soon as a human has read the copy; "earn" waits.

**Contract changes, listed separately. None is needed for slices 0 to 5.**

| # | Change | Why | Audit cost | Verdict |
|---|---|---|---|---|
| C1 | `delegateWorkArea`: a manager carves part of a work area's Shares limit into a child area, depth at most 3, with `parentOf`/`depthOf` and an event; add `reclaim` and a DAO-only `revokeWorkArea` (about 70 lines together) | A second hop with no vote; limits that add up by construction; real takeback | Small code, large blast radius: `TreasuryMandate` changes, so a new factory, voting policy implementation, Summoner and kit, new projects only (existing DAOs cannot adopt it, `AllocationVoting.sol:229-236`). Needs a delta audit of `TreasuryMandate` plus re-checking the wiring and new invariants (the sum of limits over a subtree is constant; depth at most 3; no cascading loops). Factory headroom about 3.5 KB (UNVERIFIED, sizes may be stale); gas about 150,000 to 250,000 per carve (a guess). No price: needs a quote | Develop nothing yet; ask for a quote; decide after hop-1 data (decision 11). D174 lifts the freeze for development only |
| C2 | DAO-only add, remove and quorum calls on a live panel | Switch panels in minutes | Same rebuild; breaks the "panel fixed per budget" rule and in-flight claims | Not recommended; the 90-day cycle does the job |
| C3 | Let the founder sit on the panel | The honest on-chain form of self-check | Reverses a launch-time check the audit assumed (`ContributorKit.sol:131-133`, D79) | Rejected |
| C4 | Deploy the agreed-reward path | Binding awards with no vote | Already in audit scope, reviewed status UNVERIFIED (`AUDIT-SCOPE.md`); biggest shift of authority | Not in the first runs |
| C5 | Shorten the 7-day objection window | Faster Shares | Constant at `TreasuryMandate.sol:46`; shortening needs audit | Rejected; shorten the process around it |

## 8. The Start form, field by field

Now: 12 boxes (`a-walk.md` step 5; `SOCIAL-FIRST-PROPOSAL.md:250` says eleven). New: two typed answers and one tap. D186
points 5 and 9 stand.

| # | Field today (rule, source) | New | Where it goes |
|---|---|---|---|
| 1 | Project name, 2 to 60 (`contributor-project.ts:393-397`) | Same | Screen 1 |
| 2 | What it is, 10 to 140 | Same, "In one sentence, what is it?" | Screen 1 |
| 3 | Short name, 2 to 8 letters or digits | Filled from the name; hidden | Under "Change the starting numbers" |
| 4 | Your starting Shares, 100,000, at most a third of box 5 | Unchanged, stated in the summary | Always in the summary; editable under the fold |
| 5 | Shares available for work, 300,000 | Unchanged | Same |
| 6 | Most for one work area, 25,000 | Unchanged | Same |
| 7 | Reviewers, 3 to 32 pasted or picked addresses | Three suggested from the pool or the starter panel; swap any | Screen 2, "Your checkers" |
| 8 | How many must agree, blank means more than half, at least 2 | Unchanged rule, hidden | Under the fold |
| 9 | How you know each reviewer, 10 to 2000 characters | Deleted; replaced by the derived tie line and an optional "declare a conflict" line | Project page |
| 10 | First work area name | Optional | "Ask for help" |
| 11 | What finished looks like, 5 to 280, fixed on the network | Optional | "Ask for help" |
| 12 | First work area Shares | 25,000 default, hidden | Under the fold; set per request |
| 13 | At least one first work area | Zero allowed (a web rule, not a chain rule) | Skip link; costs about 2.5 days at the first accepted offer and the screen says so |
| 14 | Who accepts work | The founder, unchanged | Lead, later |
| 15 | Account: sign up, then "Set up passkey sign-in" again | Asked once, at the last button; answers kept | Signed-out Start |
| 16 | First work budget and area last 90 days (not shown) | Shown with the date on the done screen | Done screen, plus a reminder 15 days before |
| 17 | Weekly-sale fields | Unchanged while the trial runs (D186 point 9); never on this form | Trial kit only |

The two disclosures stay beside the button, rewritten, never hidden: "You start with 100,000 Shares. Shares are votes in the
project. Nobody else has any yet" and "If every Share is awarded, you would hold 25% of the votes." One more line, on
checking: "Your project is checked by three reviewers; two must agree." Existing line under the button: "Shares can't be sold
at first." The button reads "Create your account to start" when signed out.

## 9. What to say to counsel (flags only, no conclusions; trading stays off)

1. **Pool and starter panel.** Naming volunteers as reviewers of strangers' work; whether the operator seeding the pilot
   panel makes the operator an issuer's gatekeeper; whether unpaid reviewers who approve carelessly face any duty; whether
   a public list of who volunteered is personal data.
2. **"Shares are only given for work the reviewers accepted"** (Powers card and others). Does it stay accurate when the
   panel is a starter panel the operator chose? (Route A, a founder-held reviewer, is rejected partly for this reason.)
3. **Offers "for Shares".** A number quoted before work, and "accept" ("I will ask holders to award 1,500") may read as a
   promise or a price. Draft copy avoids "earn", "grow", "benefit"; existing Home and Start copy has "earn" next to Shares.
4. **Leads.** Authority to choose who is asked for Shares, held by people who hold none, in levels. Read against the SEC and
   FTC material in `c-priorart.md` C5, which describes what regulators weighed in other schemes and is not a rule for DAOs.
   Confirm a plain "send the link" prompt is not a recruiting incentive.
5. **Public records** of offers, accepts, vouches and pool entries: personal data, erasure against a tamper-evident log, and
   whether a withdrawn record still identifies someone.
6. **Naming and taking back** a lead, and any visible "taken back" line: accuracy and defamation duties.
7. **A lead's bloc.** Whether giving people choosing power over who is awarded votes raises any voting-rights question.
8. **Ledger and stage lines** ("Founder: 97%", "Checked by the starter reviewers") are public statements about independence;
   who answers for their accuracy when computed from public records.
9. **Agents and minors** as helpers, reviewers or leads; whether a web sign-up can be told from an agent (UNVERIFIED).
10. **Tax and reporting** for people awarded Shares, even at zero value on a test network.
11. **Dilution** when a budget holds money: new Shares reduce what each Share gets back on leaving. No effect today.

## 10. Risks and stop conditions

| Risk | Stop or rethink if |
|---|---|
| The pool is empty or tiny, so Start stalls at the panel | Fewer than 5 volunteers in the second run, or median time to a full panel over 2 days: fall back to the idea rung and the starter panel only |
| Reviewer overload or a few reviewers deciding everything (a hub) | Any person on more than 5 live panels, or median review time over 4 days |
| Sock accounts: a founder with unlinked accounts or pool socks | Any award cluster where the recipients vouched for each other or share a founder link; any screen treats the graph as proof of one person |
| A lead builds a bloc | Over 40% of awards sit under one lead |
| Promises not kept | Kept-promise rate under 80% ("chosen N, awarded N as agreed") |
| Drift toward paying for recruiting | Any field, counter, rank or reward for choosing, passing on or inviting |
| The "agreed" number read as a guarantee | Fewer than 4 of 5 testers can say back that holders vote and a vote can say no; or that a lead gives no votes and no Shares |
| Founder away: nothing can be awarded | A founder with a piece waiting over 7 days; add a second holder path sooner |
| Complexity returns | Start is not clearly faster than today; a tester needs more than three new words explained |
| Empty-server dead end | Under half of new accounts take one action within 10 minutes |
| Measurement spoiled | The form changes inside the first run |
| Server operator hides a record | A signed record proves who wrote it, not that the server shows it (`NEXT-GEN-DAO.md`, Trust); label it "what members recorded here" |

**Overall stop:** if the second run is not faster to start and the new words need explaining, go back to the D186 form.
Measures to publish beside D186's: time to finish Start; days from Start to first offer and to first Shares; strangers whose
piece was awarded; kept-promise rate; founder taps per piece; awards by lead; reports per lead; reviewer disagreements.

## 11. Decisions for you, each with my recommendation

1. **Do the pool, requests, offers, accepts and leads count as the social layer D186 lifted the freeze for?** They need no
   contract, no money and no change to the running pilot, but D186 named only the vouch, the picker line and the shorter
   Start. Yes, second pilot run only.
2. **Reject the founder self-check account** (d-solo route A) and use the pool and a starter panel instead? Yes.
3. **Keep 3 reviewers and 2 agreeing** (D153)? Yes. The chain would accept 1 and 1; the web rule is the only gate.
4. **Who are the three starter reviewers for the pilot?** Your call; you plus two testers is my suggestion.
5. **Allow a project to start with zero work areas** (a web rule, `contributor-project.ts:292-293`)? Yes, with the cost said on screen.
6. **One work area per accepted request, made by a prefilled vote**, not a standing generic area? Yes.
7. **Awards stay holder votes; the agreed-reward path stays off** in the first runs? Yes.
8. **Depth:** one hop in the second run, two after the evidence gate, never three? Yes. The word "lead" and the term-table entries? Yes.
9. **Limits:** 3 live leads, 2% of the work budget each (6,000 by default), 30 days, 5 offers and 5 requests per person. These are
   record limits, but the 2% sets aside part of your work budget. Confirm or change.
10. **Make "nothing for choosing, passing on or inviting" a product rule and a test?** Yes.
11. **Contract C1 (nested areas):** develop nothing now; ask for an audit quote; decide after hop-1 data. Agree?
12. **The invite door:** add "Ask for an invite" to the sign-up and decide whether a read-and-post guest membership exists for
    the next public run. It is a server setting; this is yours.
13. **A successor to the removed checklist, as one next-step card?** First tell me why it was removed. If it was noise, yes with the rules above.
14. **Renames:** Discover to Projects and Your work to Your projects now; "lead" and "help request" with the new screens; "earn" after counsel? Yes.
15. **Give counsel section 9 before slice 2 ships.** Yes.

## 13. Task rewards: what you decided on 2026-11-09, and what it needs

You told me how you want pay for work to feel. Three choices, then what each one needs.

1. **Hand-set Shares per task, with recommended values.** The recommendation falls as the project grows: it is a share of all
   Shares in existence per task size (Small, Medium, Large), shown as a default the person posting the task can change. The
   percentages are guesses to test; this document sets no real number.
2. **A quick-release window for small tasks**, to cut waiting where it can be cut.
3. **Bounties first, vesting later.** New people earn by finishing tasks. People who have finished several can be offered a
   seat with a vesting grant, which holders vote on (D186 point 7).

**What each needs, honestly**

- **(1) is web only.** A price list per work area, with the recommendation worked out from the Shares in existence at that
  moment. It needs no contract change. The task still ends in the existing award vote.
- **(2) is the one that collides with section 7.** Today Shares land after review plus a 7-day objection period, and then a
  holder vote. I rejected shortening that period (C5) because the constant sits in an audited contract. The on-chain way to pay
  exact, pre-agreed terms with no vote is the agreed-reward path (C4), which I kept out of the first runs. So a shorter
  window for small tasks needs C4 or C5 and an audit. **For the second pilot run I propose the honest middle:** show the
  countdown ("Shares arrive on 16 Nov if nobody objects"), pre-fill the award vote at accept time so the holder only
  confirms, and make the three steps (done, checked, awarded) one tap each. The pilot treasury holds no money, so waiting
  costs time, not safety. Decide C4 after the pilot, with the audit quote.
- **Late tasks stay soft:** the due date is a hint; a late helper writes why and asks for more time; the lead grants it; after
  24 extra hours the task reopens for others with no penalty, or the lead recommends a partial award. This is a web rule on top
  of the help-request records in section 5.
- **A cooling-off on cashing out new awards** (ragequit waits, say, 30 days, but the Shares vote at once) only matters once a
  treasury holds money, and today awards arrive with no lock. It needs a contract change and an audit. Decide before any
  project holds real money, not for the pilot.
- **(3) vesting** is the later rung: a grant that unlocks monthly while the person keeps working and stops when they stop.
  Counsel reads it first (it resembles pay for ongoing service). Not in the second pilot run.

**Decisions added**

16. **Record the three choices above as the product direction?** Yes (taken by you in conversation on 2026-11-09).
17. **For the second pilot run, use the countdown plus the prefilled award vote instead of a shorter window; ask for an audit
    quote on C4 and C5 after the pilot?** Yes.
18. **Defer the cooling-off on cash-outs and the vesting seats until counsel has read section 9 and before any project holds
    real money?** Yes.

## 14. Corrections after an independent double check (2026-11-09)

Three reviewers who had not seen this document's reasoning checked it against the code, the two Sepolia deployments and the
plan itself. Where this section and an earlier one disagree, this section is right.

**Facts that were wrong**

1. **The agreed-reward path is already on Sepolia.** Sections 5, 7 (C4) and 13 and decisions 7 and 17 say it is not deployed
   and that paying exact agreed terms without a vote needs a contract change. Both are false. Both work budget factories on
   Sepolia (5 Nov and 7 Nov sets) contain it (checked in their on-chain code), the source note "not deployed" at
   `TreasuryMandate.sol:87` is stale, and the web Work tab shows the lane whenever the chain reports it, with no build switch
   found. So on a pilot project today the work-area manager can propose agreed terms, the helper accepts, the panel approves,
   and after the 7 days anyone can settle with no holder vote. "The founder still votes every award" describes the app's
   usual path, not a rule of the chain. What this changes: quick, exact pay per task needs a **product and audit decision**,
   not a deploy; and keeping it off would need a web gate that does not exist. It is unaudited either way.
2. **The 3 reviewers, 2 agreeing, founder-off-the-panel and 90-day rules bind only the first work budget.** A later budget is
   an ordinary vote and the shared form accepts 1 to 32 reviewers, any quorum, any end date, with no founder exclusion. A
   founder who is the only voter can vote in a second budget of any size with one reviewer of their choosing in about 3.5
   days. Section 4's "real controls", decision 3 and rung 3 overstate the protection. It is a first-budget default.
3. **The 7 days start when the review is finished and released,** not when the reviewers reach agreement. An unbound
   submission stays open 30 days. Votes handed over to someone do not count toward the 1% needed to open a vote.
4. **A cooling-off on cashing out can never be added to existing projects,** only to projects made by a new kit (the
   "no guard" choice is final). Shares in contributor projects cannot be transferred but can vote and leave at once.
5. Small cites: `DiscoverPage.tsx:306` reads "No projects yet. Start one and it shows up here."; "earn" is at
   `contributor-start-copy.ts:13-15`; the tabs are at `launch-tabs.ts:31-41`; `ContributorKit.sol:208-224` and `:113-117`
   (the 1% threshold). Record kinds 37021 to 37025 are free. Linking a name at passkey sign-up is an added step.

**Where the plan itself was weak (the second opinion)**

- **The reviewer pool moves the cold start, it does not solve it.** On an invite-only server the pool is whoever the operator
  invited. It is an operated service: say so, name the reviewers, promise a response time, and write when it ends.
- **Slice order.** The vouch should not ship before a stranger can see anything. Better: the invite door and a seeded example
  project with real requests; then request, offer, accept; then notifications (there is none outside the app today); then
  the vouch.
- **Too much for a pilot of 5 to 25 people.** Leads, the second hop, ladder rungs, standing rules and Thanks rounds wait until
  one question passes: can an invited stranger get from the link to accepted work with no hand-holding?
- **Two weeks of silence before a first reward is too long.** Show a visible acknowledgement when work is accepted.
- **Decisions 1 to 15 of this document are not taken.** D186 lifted the freeze only for the vouch, the picker line and the
  shorter Start. These are the owner's to take in person.
- **Ask for the audit quote and counsel's read now,** not after the pilot. The pilot runbook describes two reviewers while
  the code enforces three; reconcile them before the second run.

## 12. Unverified facts

1. Server work for the vouch, pool, request, offer and accept records is unsized. Kind numbers 37021 to 37025 looked free to
   one reader; assign them together with the vouch.
2. Whether a name link can be made in the sign-up passkey step (`passkey-identity.ts:222-262`, not read by me); whether
   "Set up passkey sign-in" on the Start form skips the terms boxes.
3. What a signed-out visitor or an account without an invite can read on creaton.io; whether a guest membership exists.
4. Whether the web screens work with zero first work areas (the chain allows it; I did not trace the screens).
5. Which summoner and policy variant the pilot uses; whether its budget has the agreed-reward functions; gas of the legacy
   hosted launch; gas and size of C1; whether `contracts/out` sizes are current; whether `TreasuryMandate` has had an external audit.
6. How long an unbound submission stays open (the rescue if a lead goes quiet); whether fee sponsorship covers a non-founder
   manager's "Accept for review"; whether delegated votes count toward the 1% threshold to open a vote.
7. Whether the founder is told that the first work budget ends in 90 days; why the old checklist was removed (`392c7df`).
8. That creaton.io's live build matches the Dockerfile defaults (no bounties, court or trading). I read build arguments.
9. All limit numbers, rung thresholds and sizes in sections 5, 7 and 10 are guesses to test.
10. Prior art marked "search only" or UNVERIFIED in `c-priorart.md` (Dework, the Questbook quarterly review, Compound's final
    outcome, the 2026 Arbitrum and Uniswap delegate claims, Zodiac role depth) is not relied on beyond what it states.
11. Checked by me directly: `ContributorKit.sol:122,130-132` (one reviewer and a quorum of one are the chain's floor; the
    launching account cannot be on the panel); `contributor-project.ts:56-57,292-293,474-481`; `DECISIONS.md` D139, D153, D174,
    D186. Everything else about code is from `a-walk.md`, `b-contracts.md` and the three designs, which I did not re-run. I ran
    no browser, no `forge` and no relay.

Sources: `VISION.md`, `VISION_PROJECTS.md`, `PLAIN-WORDS.md`, `SOCIAL-FIRST-PROPOSAL.md`, `NEXT-GEN-DAO.md` (rules and Trust),
`PILOT-RUNBOOK.md:95-150`, `CREATON-EXAMPLE-PROJECT.md`, `DECISIONS.md`; scratchpad papers `a-walk.md`, `b-contracts.md`,
`c-priorart.md`, `d-solo.md`, `d-delegate.md`, `d-friendly.md` (not in the repository).
