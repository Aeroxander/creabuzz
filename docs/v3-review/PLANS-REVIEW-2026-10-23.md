# Do the plans still add up? (2026-10-23)

You asked me to look over the plan documents I work from and check that they all make sense together. This is what I
found, what I changed, and what is left for you. The short answer: the order of release and the current index
([STATUS-2026-10-22.md](STATUS-2026-10-22.md)) are sound, but several older plans still speak as if they were current,
the pilot documents still describe the raise as the first thing people meet, and the one check that runs every
journey left out the contributor project.

## Which documents are current

| Document | What it is now |
|---|---|
| [STATUS-2026-10-22.md](STATUS-2026-10-22.md) | **The index.** What is built and checked, what only a pilot can show, what waits on you |
| [SOCIAL-MVP-ROADMAP-2026-10-19.md](SOCIAL-MVP-ROADMAP-2026-10-19.md) | **The order of release** (social, then contributor projects, then the audited raise). Section 2 was out of date; refreshed today |
| [DECISIONS.md](DECISIONS.md) | The record of every decision. A record, not a rulebook (as PILOT.md says). Four rows now say what replaced them |
| [TEST-STEPS.md](TEST-STEPS.md) | How to check each decision by hand. Current |
| [PILOT-RUNBOOK.md](PILOT-RUNBOOK.md) | How to run a pilot with real people. Now opens with the social and contributor runs, which come first; the raise scripts follow |
| [BOARD-MODERATION-DESIGN-2026-10-22.md](BOARD-MODERATION-DESIGN-2026-10-22.md), [CONTRIBUTOR-KIT.md](CONTRIBUTOR-KIT.md), [CONTRIBUTOR-TOKEN-TRADING.md](CONTRIBUTOR-TOKEN-TRADING.md), [CREATON-EXAMPLE-PROJECT.md](CREATON-EXAMPLE-PROJECT.md) | Current designs and seed content |
| [AUDIT-SCOPE.md](AUDIT-SCOPE.md), [TOKENOMICS-PROPOSAL.md](TOKENOMICS-PROPOSAL.md), [TOKENOMICS-CONTRACT-CHANGES.md](TOKENOMICS-CONTRACT-CHANGES.md) | Current for the raise path, which comes last. The two tokenomics papers said "nothing is built yet"; it was built (D81, D82), and they now say so |
| [PILOT.md](PILOT.md) | What a raise pilot is. Still right for the raise; it now says the raise is the third step, not the first |
| [PLAN.md](PLAN.md), [PROGRESS.md](PROGRESS.md), [PRODUCT-REVIEW.md](PRODUCT-REVIEW.md), [MODERATION-AND-PRELAUNCH-PLAN-2026-10-18.md](MODERATION-AND-PRELAUNCH-PLAN-2026-10-18.md), [MODERATION-AND-PRELAUNCH-PLAN-V2-2026-10-18.md](MODERATION-AND-PRELAUNCH-PLAN-V2-2026-10-18.md), [CONNECTED-DAO-OS-2026-10-18.md](CONNECTED-DAO-OS-2026-10-18.md), [SCREEN-AUDIT-2026-10-19.md](SCREEN-AUDIT-2026-10-19.md), [LBAMM.md](LBAMM.md) | **History.** Each now opens with a line saying when it stopped being current and where to look instead |
| The six outside reviews not in git (`FIRST-PRINCIPLES-REVIEW`, `FOLLOWUP-REVIEW` ×2, `D58-D59-FOLLOWUP-REVIEW`, `DAO-OS-OVERVIEW-AND-D57-REVIEW`, `MVP-PRODUCT-REVIEW`) | Inputs, answered by D52 to D59 and later rows. Left as they are and uncommitted: they are not mine to file |

## What did not add up, and what I did

1. **The pilot documents put the raise first.** PILOT.md and PILOT-RUNBOOK.md describe a sale, milestones and exits
   as what testers meet. Since 2026-10-19 the order is the social MVP, then contributor projects, then the raise, and
   STATUS says the next step is a small hosted pilot of a contributor project. There was no script for that pilot at
   all. **Done:** PILOT-RUNBOOK.md now opens with two runs that come first (the social run, and the contributor run with
   a founder, two reviewers and contributors, one new to crypto and one doing non-technical work), with the questions
   to ask and what success looks like; the raise scripts follow, marked as the third step. PILOT.md says the same in
   one line at the top.
2. **The check that runs every journey skipped the contributor project.** `scripts/mvp-gate.sh` ran eleven chain
   journeys, nearly all of them for the raise, and not `web-contributor-e2e`, the journey for the product that ships
   second. **Done:** added. The gate was run tonight; the result is at the end of this file.
3. **The roadmap's list of what boards still lack was out of date.** Pin and lock, rules, reply notifications and
   search are built (D83, D93 to D99). **Done:** section 2 now lists only what is still missing.
4. **Older plans spoke in the present tense.** PLAN.md said "nothing in this plan has been implemented"; PROGRESS.md
   listed "merging Home and Social" as not started (done in D61 and D71) and two log-range issues that are fixed (reads
   now fall back to pages from the build's starting block); the moderation plans of 18 October listed personal block,
   the room action log, the Testnet chip and the welcome posts as "not built" when most are. **Done:** a dated line at
   the top of each, and for the moderation plan the current state of each Phase A item.
5. **Decisions that were replaced did not say so.** D61 (likes on short posts) and D63 (a Boards tab and a "hot on the
   boards" strip) were replaced by D71 (one timeline, votes on every post). D12 and D14 (the market venue and how Shares
   get a market) are on hold while D77 keeps the first raises without a market. D2 says a spike result is "recorded in
   `SPIKE-token.md`"; that file was never written; PROGRESS.md records the outcome instead. **Done:** a short note in
   each of those rows.

## What the review led to tonight

- **A personal mute only worked in some places** (D100). Muting someone hid them from Home, reply threads and
  messages, but not on boards, in notifications or in chat rooms. Now it does, everywhere the reader meets them.
- **Rooms and boards had no unread markers on the web** (D101). They now do, from the server's own read-state API, which
  has to be switched on for the hosted server (`BUZZ_V1_ENABLED=true`).
- **The social path had no real-server run anyone could start** (D101). `scripts/web-social-e2e.sh` now runs the
  real-server social suite (22 cases) and a new board-moderation journey in one command. Running it found that the
  suite had drifted since D71 (it still looked for "liked your post") and that two of its seed scripts were incomplete
  or never exited; all fixed, and it passes.
- **The MVP gate**, now with the contributor journey, ran tonight and caught two real bugs on the raise path, one of
  which also hit contributor projects: Quick start priced the sale for the default supply whatever supply was typed, so
  the launch was refused later (D102); and a reviewer's bond in the project's own Shares could never be posted, because
  the kits lock Shares against transfers from birth, and for a contributor project with no payment currency that was the
  form's default (D103). Both fixed; see the end of this file.

## Still open, for you

- **The appeal route** (the moderation plan's A0): who someone writes to when they think a moderator was wrong, other
  than the moderator. Terms and a privacy note exist as drafts; an appeal contact does not.
- **Block, beyond mute.** Mute hides someone from you. Nothing stops them sending you a direct message or mentioning
  you. Whether "Block" should do that (and whether the list is public) is a product choice; the moderation plan left it
  undefined.
- **What a "work or fun" board is** (roadmap section 2): still only an idea you mentioned.
- **Read state on the hosted server:** set `BUZZ_V1_ENABLED=true` there, or the unread markers stay hidden.

## The gate run tonight

`scripts/mvp-gate.sh`, with the contributor journey added, run once from start to finish (2026-10-23, about two hours
on this machine):

| Journey | First run | After tonight's fixes |
|---|---|---|
| cli-no-raise, web-contributor, cli-milestone, web-record, web-milestone, web-work, web-paid-work, web-dao-launch, web-challenge, web-dao-journey | passed | (not rerun; nothing they use changed except the work-budget form's bond choice) |
| web-economy | failed: "Launch project" stayed disabled | passed, after D102, D103 and bringing the journey up to date with D72, D74 and D77 |
| web-sepolia-fork (the economy journey on a fork of Sepolia) | failed at the same place | passed (12 minutes on the fork) |

The economy journey had not been run since the tokenomics decisions (D72 to D82) and still described the old sale: a
billion Shares, a raise that graduates at 15%, a bond in Shares, an exit that counted locked team Shares. Updating it
found the two bugs above. Other real-server checks run tonight: `scripts/web-social-e2e.sh` (22 passed) and the whole
mocked browser suite (448 passed, 41 skipped by design).
