# Where Creaton stands

Updated 2026-11-02 (v5 development scope; prior v4 validation remains historical); the weekly-sales items in Scope, Known gaps and Waiting on you were updated 2026-11-05, and again the same day after the low-severity run. **"Scope", "The gates" (the project-loop journey) and "Waiting on you" were rewritten 2026-11-15 to the direction of 2026-11-10 ([DIRECTION.md](DIRECTION.md)), and refreshed again on 2026-11-15 after the MVP push (Start in one press, the update loop, tasks with a finish line, share pictures, Discover, the AI project kit, the backing pool's leave and depth changes).** **Later on 2026-11-15 the assistant made the owner decisions at your request and built on them: see "2026-11-15, later: the decisions push" below.** **For a one-page answer to "is it ready, and what is left for me", read [MVP-READY.md](MVP-READY.md).** The index to start from; it replaces [STATUS-2026-10-22.md](STATUS-2026-10-22.md), kept as history.
Each decision is a row in [DECISIONS.md](DECISIONS.md) (through D217; D189 to D199 record the MVP push as built; D200 to D217 record the calls the assistant made at your request on 2026-11-15 and what was built from them). The hand tests for the pilot, in order, are in
[PILOT-TEST-GUIDE.md](PILOT-TEST-GUIDE.md); every hand test ever written is in [TEST-STEPS.md](TEST-STEPS.md), a log in
date order. What the 2026-10-31 pass hid or retired, and what waits on your call, is in
[DEPRECATION-2026-10-31.md](DEPRECATION-2026-10-31.md).
How Creaton pays its way and how a project is funded when backers are scarce, on paper, with the decisions waiting on you:
[BEAR-MARKET-MONEY.md](BEAR-MARKET-MONEY.md).

The branch `v4-governance-rework` is pushed to the fork (https://github.com/Aeroxander/creabuzz, since 2026-11-01); draft PR Aeroxander/creabuzz#1 runs CI against `ci-base`, not the fork's `main`, which still holds 12 older SIWE commits this branch reworked. D146 to D150 are committed locally (D150 removed the LBAMM market, the pre-kit raise path, the old tokenomics and money forecasts from the app; tag `pre-deprecation-2026-10-31` keeps them).

A plain-words copy pass rewrote the web app's user-facing text for readers new to crypto and DAOs (no number, economic setting or trading switch changed); what changed, and the legal lines left for you and counsel, is in [COPY-PASS-1.md](COPY-PASS-1.md).

## Next-version milestone 0 (2026-11-16): the door, the join link, public pages, settings from the server

First slice of [../NEXT-VERSION-PLAN.md](../NEXT-VERSION-PLAN.md) (D219 to D223), no contract change; nothing pushed or
deployed. **Open sign-up:** the Creaton compose example now sets `BUZZ_REQUIRE_RELAY_MEMBERSHIP=false` (the relay's own default is
unchanged; invite-only is one line away); an account the server first heard from less than a day ago may save at most 60 project
records in that day (`BUZZ_NEW_ACCOUNT_PROJECT_RECORDS_PER_DAY`). **Join link:** anyone signed in may ask to join a project from
its link with one press ("Ask to join", kind 47003 with a `join-ask` tag; no new kind), and may do nothing else there; an account
may ask one project 3 times and 20 projects a day; the founder accepts from the Team card or Notifications in one press (the
project record is saved again with the person on it; their own yes is inside the ask); an agent account may ask and cannot accept;
teams may have 200 people (it was 19 in the web app and 64 on the server); the Team card has "Copy link to invite people". **Public
by default:** a project that states the terms of a sale is no longer hidden from someone who is not a member (public reads and link
previews); no price is added anywhere. **Settings from the server:** `BUZZ_INVESTING=true|false` is advertised as `investing` in the
server's information document and decides the investing and trading switches, in both directions, with no rebuild; unset says
nothing and the build's switches decide (off unless built on). The addresses those screens read still come from the build, and
`run.sh build` still refuses a build that names them without `VITE_INVESTING=1`: relaxing that is a call for later. Budgets held by
tests: the solo path (8 presses, 4 fields) is unchanged; a stranger on a project link is "Asked to join" in at most 2 presses and 0
fields after sign-up (1 once signed in); the founder accepts in 1. Not done here: a human's phone test.

## 2026-11-15, later: the decisions push

You asked the assistant to make the owner decisions in [MVP-READY.md](MVP-READY.md) itself and work on them. It did, the same
day. Every call is a row in [DECISIONS.md](DECISIONS.md) (D200 to D217) and a line in MVP-READY's "Decided" tables; what is
left for you is its "Still yours" list. Nothing was pushed, deployed or turned on, and investing and trading stay off.

- **Built from the calls:** anyone can read a public project's record on an invite-only server when the operator's setting
  is on, and the server can name its own example project (D201, D202; on for Creaton's own server in the deploy example,
  and counsel has not read it); the 5,000 depth tier is dropped, six remain, and the leave form says leaving then selling
  pays a fee twice (D208, D209); Home opens on the feed of project records for everyone (D212); Start says three answers
  everywhere, and Discover counts a Start project as a project where no sales are offered (D213); a server with no money
  shows no money cards, and "Set up Shares for people who help" waits for accepted work (D214); one way to write a day and
  "followers" on the weekly loop's pages (D215); the agent line says "answers for them" and the agent commands sit under a
  closed disclosure (D203); an AI project's starter promises and tasks are offered as a one-press prefill, never written for
  the founder (D206).
- **Decided for later, not built:** retiring the older AI category, and saving the update day on the server (D205).
  **Not built, and yours to call:** a public-reads setting each community's owner can change, a hard bound on the pool's
  price multiple, and storing the AI kind chosen on Start.
- **Kept as built, nothing new:** decisions 5, 6, 8 to 11, 15 to 18, 20 to 22, 24 to 26 and 28; and the long team sentences,
  "Free to start. No token needed." and the contributor form with no goal (D216).
- **Also in the tree from this push, reported to this record by no engineer:** a founder with nobody else on the project may
  mark their own work as done, shown and counted as checked by them alone (D217, not yet approved by you); and an idea's
  Manage tab is the plain settings in every build (1b13a90).
- **Checked, as the engineers reported** (numbers in the last row of MVP-READY's table): the contract suite after the tier
  change; the relay's public-read tests, with a mutation for each guard; the web unit tests over the changed features; mocked
  browser specs in batches; and the project loop on a real server, now eleven steps: 11 of 11 invite-only with public reads
  on, 11 of 11 with them off, 11 of 11 open. **Not run:** the pilot gate as a whole, the full mocked suite in one go, the
  investing specs, `pnpm check` as a whole, any hosted server, any hand test.
- **Found and fixed on the way:** the first version of public reads served every record about a project, evidence under
  review included. A review caught that and four more important points; all five were fixed with tests. No second review
  of those fixes is reported.
- **Still yours:** your weekly posting promise, your money and the cost ceiling, the token design choices
  ([CREATE-BILLION-REVIEW.md](CREATE-BILLION-REVIEW.md)), counsel's reads (now with public reads among them), and the smaller
  calls the engineers left ([MVP-READY.md](MVP-READY.md), "Still yours").
- **Not yet brought in line with this push** (other people's files): "What a visitor gets" in
  [PILOT-RUNBOOK.md](PILOT-RUNBOOK.md), which still says shared links reach members only;
  [HOLDER-ACCESS-MODEL.md](HOLDER-ACCESS-MODEL.md); the dated "Decision for you" under the loop findings in
  [PILOT-REPORT.md](PILOT-REPORT.md); [CREATON-EXAMPLE-PROJECT.md](CREATON-EXAMPLE-PROJECT.md), which has no step for
  `BUZZ_EXAMPLE_PROJECT` (the step is in "Waiting on you" 4); and the repository's root `.env.example`, which lacks the two
  public-read settings.

## Scope

**The product, as the owner set it on 2026-11-10 ([DIRECTION.md](DIRECTION.md)):** Creaton is where a project states a goal,
does its work in the open, and lets anyone see whether it kept its promises. Every project has four things: a goal, a weekly
update, tasks with a finish line, and a record (promised, delivered, missed, changed course). Shares follow the record; they
are not the point of it. Nothing in DIRECTION.md changes a contract or an economic number.

- **The MVP is the server, the web app and the project loop**: Start in one press (three answers: name, goal, how we will
  know; D192), a first-week page, weekly updates with promises that the next update marks kept, missed or changed (with an AI
  draft that uses only the record, D194, and a calendar reminder, D195), help requests with offers, tasks with a finish line,
  reported numbers and an independent check, share pictures (D197), the public scorecard, Home as a feed of project records,
  Discover opened on "Most reliable" (D196), and Work. **It needs no chain.** These are records on the
  server (`scripts/real-loop-e2e.sh` plays them against a real server, open and invite-only); no raise, no sale, no market
  (D137). The first step is [PILOT-RUNBOOK.md](PILOT-RUNBOOK.md), "Pilot A": three to five founders, onboarded by hand,
  and one number, whether they post a second and a third weekly update without being asked.
- **Ready for agents, not built for them.** A helper is an account, labelled as an agent when it is one, with limited powers:
  it may offer, do work, submit evidence and draft text; it may not vote, award Shares, move money or accept its own work.
  Since 2026-11-15 an agent has a command line for the loop (start, inbox, hand in numbers, bind a run record;
  [docs/agents/WORKER-LOOP.md](../agents/WORKER-LOOP.md)) and AI projects get four starter kinds, as wording only (D193).
  An agent cannot sign a goal, so a person starts the project and adds the agent ([MVP-READY.md](MVP-READY.md), decision 5).
- **Price and returns appear only in the Home feed.** Trading and investing are off by default in every hosted build (no
  market factory in the image, a listing starts disabled, `VITE_INVESTING` unset; how to turn investing on is
  [INVESTING-SWITCH.md](INVESTING-SWITCH.md)). Share pictures and link previews show no price (D197, D199). Hidden until a project needs them: the
  court, forecasts with money, trading, Explore, boards as a separate place. Not now: leads and delegation levels, Thanks
  rounds, ladder stages, the vouch, new contracts.
- **Contributor projects (a chain, reviewers, Shares given for accepted work) are the second pilot, not the first**
  ([PILOT-RUNBOOK.md](PILOT-RUNBOOK.md), "Second"). Their setup (a Sepolia deploy, a ZeroDev project, a node, synced
  passkeys) waits for what Pilot A shows. New Shares come only from reviewed work and an award vote.
- **No desktop or mobile app in the MVP.** The desktop and mobile apps in this repository are not kept level with the web
  app and are not part of any pilot; D9's "desktop and mobile parity after" waits until after the pilots (noted on D9).
- **Operator tooling is part of the MVP, because notifications outside the app are not yet built:** `./run.sh founders`,
  `due` and `daily` (who posted, who is late, what is waiting), encrypted backups with a restore rehearsal, and an outside
  uptime check ([deploy/compose/README.md](../../deploy/compose/README.md)). Creaton's own project
  ([CREATON-EXAMPLE-PROJECT.md](CREATON-EXAMPLE-PROJECT.md), Part A) is on the server so the first page is not empty; it is
  left out of every number.

**Also in development, off the MVP's path** (the contract work of the earlier direction; none of it is deployed or on by
default):

- **The backing pool (investing, off by default; D188 to D191, D208, D209).** Backers leave at a milestone without selling and keep their
  units; the leave fee is capped at what staying one more step costs; units that already left are tracked separately; a
  founder picks the curve depth from six tiers (seven when built; the 5,000 tier was dropped later on 2026-11-15, D208;
  [BACKING-POOL.md](BACKING-POOL.md), [INVESTING-SWITCH.md](INVESTING-SWITCH.md)).
  Built and checked on 2026-11-14 and 2026-11-15: the full contract suite (100 suites, 1,115 passed, 0 failed, 2 skipped;
  1,117 passed after the tier change, as its engineer reported),
  the real-chain backing journey 5 of 5 on a local chain, the mocked investing journey (32 specs: 31 passed and 1 skipped with
  the switch on). Not audited, not deployed (the pool changed, so any copy on Sepolia is out of date), not hand-tested.
  An independent review found 1 blocker and 3 important points; all were fixed (871b0e8, a20d191), the fixes have had no
  second review, and 14 optional points remain.
- **Contract development continues under D174's lift and the D180 handoff.** Work is in progress on
  `v5-governance-rework`; no v5 deployment or activation has occurred. Phase-by-phase evidence and the
  existing/new contract capability matrix belong in [V5-IMPLEMENTATION.md](V5-IMPLEMENTATION.md).
  Prior v4 test results below are not evidence for the unfinished v5 candidate.
- **Weekly sales of existing Shares (the secondary listing) are a development candidate, built and checked locally, not
  deployed, and off by default (D181, D182).** Existing holders sell existing Shares to buyers in weekly rounds; there is no
  minting, no primary raise and no fee in the candidate. The old `WeeklyRounds.sol` stays frozen and unrepaired (D179).
  The candidate is `SecondaryMarket.sol` (665 lines), `SecondaryMarketFactory.sol` (201), `ActivationVoting.sol` (835) and
  `ContributorKitV2.sol` (365), with the Trading card and its reader in `web/src/features/launchpad`, the keeper and the
  local fixture. On 2026-11-05, after the ten low-severity batches, the secondary, voting, kit, founder-schedule and
  related contract suites ran 26 suites, 278 tests, 0 failed (the whole suite, fork tests excluded: 882 passed, 0
  failed, as reported by the final gate run); the trading browser journeys passed 5 of 5 on a local chain and the
  pilot-build check 11 of 11. Zero fee, the 7 to 8 day vote delay and the 180-day founder
  schedule are your proposals and were not changed. Read first: [LAWYER-BRIEF-WEEKLY-SALES.md](LAWYER-BRIEF-WEEKLY-SALES.md)
  (for counsel and an outside auditor), then [SECONDARY-TRADING-REVIEW.md](SECONDARY-TRADING-REVIEW.md). Trading in
  hosted and pilot builds stays off: the image names no market factory and a listing starts disabled.
- **Pilot preparations continue separately from candidate development.** The contributor pilot retains its deployed
  manual/discretionary flow. The requested future direction is contribution-earned ownership followed by secondary
  trading; an additional primary fundraising path is not a new product commitment.

## The hosted build

- **One switch**, `VITE_CONTRIBUTOR_ONLY=1`, set by the repository's `Dockerfile` for the Creaton image (D140). In the
  web app, `raisesOffered()` (`web/src/features/launchpad/lib/raises-offered.ts`) reads it and is false in that build;
  listings follow `contributor-only.ts` beside it. It is the hosted MVP's switch in general, not only for money: Start's
  steps, Discover, Your work, the side rails, the repos link and onboarding words all check it.
- **Every other build offers raises by default**: a developer's `pnpm dev`, the mocked browser suite and CI. What they
  show is not what ships; the screen audit's `WEB_FEATURES=mvp` and the passkey-contributor journey build like the image.
- `VITE_DAO_LAUNCH_KITS` also says whether a raise can be launched, and the image takes none. In a hand-made build the
  two can disagree; every screen that checks `raisesOffered()` follows the contributor-only setting.
- The image takes only the chain, its node, the contributor kit, where history starts, ZeroDev and error reports
  ([deploy/compose/README.md](../../deploy/compose/README.md), "Creaton"; [docs/sepolia-testnet.md](../sepolia-testnet.md)).
  `scripts/sepolia-deploy.sh` and `just dev-chain` print those settings alone; their optional features' settings only
  with `--optional` or `DEV_CHAIN_ALL=1`.

## Built and checked locally

Checks are local: unit tests, the mocked browser suite, journeys on a throwaway chain (and a Sepolia fork where said),
and screens captured on a real server. None of it is an audit or a hosted run with real people.

| Area | Decisions | Checked by |
|---|---|---|
| Social: one timeline with votes, boards, notifications, terms at sign-up, mute everywhere, unread rooms, pictures on the server, Home posts removed with a reason | D63, D64, D71, D83, D100, D101, D105, D142, D143 | smoke suite; relay tests; `scripts/web-social-hosted-e2e.sh` |
| Board moderation and access changing while the app is open | D93 to D99, D106 | relay Postgres tests; `board-moderation.spec.ts`, `board-reports.spec.ts`, `access-refused.spec.ts` |
| Invite-only server, invite links, reports, error reports | D107, D140 | `scripts/web-invite-only-e2e.sh`, `scripts/web-error-report-e2e.sh` |
| Contributor projects: start (no sale), work areas, Ways to help, submit, accept for review, review, finish the review, turn-downs, award vote, Needs you, contributions | D65, D66, D84, D88 to D91, D144, D145 | `scripts/web-contributor-e2e.sh`, `web-work-e2e.sh`, `web-paid-work-e2e.sh`, `cli-no-raise-e2e.sh` |
| Passkey accounts for every contributor step, fees covered, money sent out | D139, D141 | `scripts/web-passkey-contributor-e2e.sh` (Sepolia fork, built like the image) |
| The hosted image and server: first start, backups, contributor-only build | D107, D140 | `scripts/test-compose-backup.sh` (a scratch stack); `deploy-env` tests; your own backup only by [RESTORE-REHEARSAL.md](RESTORE-REHEARSAL.md), not yet run |
| The project loop: Start, weekly updates and promises, help requests and offers, tasks and their checks, the scorecard, Home and Work; and the owner's `./run.sh founders`, `due` and `daily` | DIRECTION.md (2026-11-10) | `scripts/real-loop-e2e.sh` (open and invite-only; run before the 2026-11-15 pages below), `scripts/test-pilot-commands.sh` |
| The MVP push of 2026-11-15: Start in one press and AI project kinds, the first-week page, the update loop (AI draft, update day, calendar file), tasks with reported numbers and run records, share pictures, Home that feels alive, Discover by kept promises, the invite-only visitor words, link previews, the AI service's daily caps, the agent command line | D192 to D199 | Each part by its own mocked browser spec, unit tests and mutation checks (numbers in [MVP-READY.md](MVP-READY.md)); the real server only for the visitor words and the command line. **Not run since the pages changed: `real-loop-e2e`, the pilot gate as a whole, the full `pnpm check`** (the loop has been run since, in the decisions push: next row) |
| The decisions push, later on 2026-11-15: public reads on an invite-only server and the server's example project, Home's opening tab, three answers, Discover with no ideas where no sales are offered, no money cards on a server with no money, the date format and "followers", the AI starters as a prefill, the founder-alone check | D200 to D217 | Relay Postgres and unit tests with mutation checks, web unit tests, mocked browser specs in batches, and `scripts/real-loop-e2e.sh` (eleven steps; invite-only with public reads on and off, and open), as the engineers reported ([MVP-READY.md](MVP-READY.md), last table row). **Not run: the pilot gate as a whole, the full mocked suite, `pnpm check` as a whole** |
| The backing pool's leave, units that left and depth tiers (investing, off by default) | D188 to D191, D208, D209 | Forge suite (1,115 passed; 1,117 after the 5,000 tier was dropped, as reported), `scripts/web-backing-e2e.sh` (5 of 5, local chain), `scripts/web-investing-mock-e2e.sh` |
| Every screen, read as the pilot sees it | D108 to D111, D146 | `WEB_FEATURES=mvp scripts/web-screen-audit.sh`; [SCREEN-AUDIT-2026-10-24.md](SCREEN-AUDIT-2026-10-24.md) |
| Sepolia readiness: the deploy rehearsed on a fork, every contract checked, the largest transaction under the gas cap | D85, D140 | `scripts/sepolia-deploy.sh` (rehearsal); `web-contributor-e2e.sh --sepolia-fork` |
| Test networks only, off in the hosted build and frozen: bounties, forecasts, CREATE and the court, money forecasts (removed from the app in D150 and from the contracts in D151, see tag pre-deprecation-2026-10-31), matched exits (retired in D152), payouts, remixes, weekly rounds, funding terms | D113 to D136 | Forge suite, mutation check, `web-post-bounty-e2e.sh`, `web-rounds-e2e.sh` |
| The raise, as far as it goes (after the audit) | D72 to D82, D86, D87, D102 | Forge suite, simulation, the gate's later set |

## The gates

- **Run `scripts/mvp-gate.sh --pilot` green on the build you host** (eleven journeys: the pilot build's screens, the
  social suite as the pilot server runs it, invite links, error reports, the command-line and page contributor
  journeys, the passkey one, work and paid work, `web-restricted-holder-e2e`: a muted, then banned, holder keeps
  their rights on a real server, plus `web/tests/e2e-real/passkey-sign-in.spec.ts`, passkey sign-up and sign-in again
  against that real server, and, since 2026-11-15, **`real-loop-e2e`, the project loop** (below)). Under `--pilot` the page
  contributor journey (`web-contributor-e2e`) runs in the
  contributor-only build the pilot ships (`PILOT_BUILD=1`, since 2026-11-01). `scripts/mvp-gate.sh` runs all
  29 (11 pilot, then 18 later; investing's two journeys, `web-backing-e2e` and `web-investing-mock-e2e`, are later because
  the hosted image keeps investing off), the pilot set first;
  `--later` runs the raise, milestone, optional-feature, self-serve, investing and weekly-sales (secondary market) journeys alone
  (18); `--list` shows what
  would run; `--outside` lists the four journey scripts no set runs, each with its reason. A journey script in no set
  and with no reason is printed as a warning on every run ([MVP-GATE-CI.md](MVP-GATE-CI.md)).
- **The project loop in the gate (2026-11-15).** `real-loop-e2e` (`scripts/real-loop-e2e.sh`, `web/tests/e2e-real/project-loop.spec.ts`)
  runs Quick Start, weekly updates and promises, help requests and offers, tasks with a finish line, the scorecard, Home and
  Work against a real server and database, in three browsers, the `buzz` command line and a socket, with nothing mocked. It is
  in the pilot set and takes about six minutes on a laptop (planned at ten in CI; no CI run of it is recorded yet). Run
  locally on 2026-11-15: **10 of 10 on an open server and 10 of 10 on an invite-only one**
  (`BUZZ_REQUIRE_RELAY_MEMBERSHIP=true`, an invite link per browser). The invite-only run found that a signed-out visitor
  at a project's shared address got "Couldn't open this project." and no word about an invite. **Fixed later the same day:**
  the page now says "You need an invite to open this project", who to ask, and offers Sign in (checked against a real
  invite-only server by hand, and the journey's visitor step now demands those words; see "Waiting on you" 5 and
  [PILOT-REPORT.md](PILOT-REPORT.md), "Findings from the loop journey"). **That 10 of 10 ran before the first-week page,
  Start in one press and the new Discover tab; the journey's spec was edited for them without a real server and has not been
  run since.** **Run again in the decisions push, later on 2026-11-15, as its engineer reported: the journey now has eleven
  steps (the eleventh is a founder working alone), and it passed 11 of 11 on an invite-only server with public reads on, 11
  of 11 with them off, and 11 of 11 on an open server.** Still run `scripts/real-loop-e2e.sh` (open and invite-only) on the
  build you host before relying on it. `scripts/test-mvp-gate.sh` passes (its one
  check that a stopped stand-in is gone failed in a container that never reaps orphans, a zombie answering `kill -0`; it now
  reads the process's state). `scripts/test-pilot-commands.sh` passes against seeded records. The gate as a whole (the 11
  pilot journeys in one run) was not run.
- **Pilot set, 2026-11-01: all ten pass locally; nine of ten in CI.** The first CI run (`.github/workflows/mvp-gate.yml`,
  pushed to the fork with draft PR Aeroxander/creabuzz#1) passed every journey but `web-social-hosted-e2e`. There,
  `follow-notify.spec.ts` lost one of two follows clicked within a second (twice, on the slower runner). It passed
  locally. **Follow-notify fix, 2026-11-02 (commit 8fecc32): awaits a CI confirmation.** The spec now waits for the
  first follow to show as pending before it clicks the second; it has passed only locally so far, and no CI run since
  is recorded here. The spec keeps its trace (what Bob's page sent and heard), printed when the follow check fails, so
  a repeat failure names its cause. The hashtag-and-mention test in `social.spec.ts` (it waits 15 seconds for the
  mention list) was flaky in both places and has no recorded root cause; it now prints the same kind of trace (follow
  list and profile frames, the options shown, the server's follow list for Dev) when that wait fails, and the next
  failure should be read from that output. A local run hit a Redis outage
  (Docker Desktop had quit) on the two journeys that start a server; rerun with Redis up, both passed.
- **Last full pass: 2026-10-31**, the 16 journeys of that day after the D150, D151 and D152 removals. No full pass of
  all 27 is recorded since. Added after it and not yet in a full pass: `web-pilot-e2e` (pilot set) and, in the later
  set, `web-rounds-e2e`, `web-post-bounty-e2e`, `web-self-serve-e2e` and `shares-erc20c-e2e` (no gate ran them
  before), then `web-project-story-e2e`, `work-check-query-e2e`, `v5-local-fixture`, `web-trading-e2e` and
  `secondary-keeper-e2e`.
- **The CI job runs on the fork:** `.github/workflows/mvp-gate.yml` runs `--pilot` on pull requests that touch the
  web app, server crates, packages, contracts, scripts, deployment config or the database, and `--later` nightly,
  with Postgres, Redis, MinIO, Foundry and a browser, and uploads every log. It is pushed: the workflow is in
  `origin/v4-governance-rework` (the fork) since 2026-11-01, and its first run was that day (above). This file records
  no result of a nightly `--later` run.
- **Not covered by it**, so checked by hand ([PILOT-TEST-GUIDE.md](PILOT-TEST-GUIDE.md)): a reviewer acting from a
  passkey account, the name link against a real invite-only server, "Your work" read from a real server, a
  passkey-account holder whose access is restricted (the browser-wallet holder is `web-restricted-holder-e2e`), the
  image's own build, and the restore rehearsal.
- **Fixed 2026-11-01, the contributor journey's build:** `web-contributor-e2e.sh` used to build with the optional
  features on under `--pilot` too. Now `--pilot` runs it with `PILOT_BUILD=1` (built as the hosted image is, no
  optional feature named) and its spec reads `E2E_PILOT_BUILD`: it expects the pilot's words, checks the remix, sale-chip,
  bounty and payout screens are absent, and skips their steps; any other run plays the optional features as before. Both
  modes passed on 2026-11-01 (2 of 2 tests each). Still not the pilot's in that journey: a browser wallet, a server
  stubbed in the page, and a stand-in AI service the pilot server does not run ([MVP-GATE-CI.md](MVP-GATE-CI.md)).
- **`web-restricted-holder-e2e` is green (2026-11-01, 2 of 2: `passkey-sign-in.spec.ts` and `restricted-holder.spec.ts`).**
  It was red because `buzz org ragequit` capped gas at 300,000 and a real ragequit needs about 336,000 (fixed in the
  CLI, `ragequit_gas_cap`). With that fixed, the spec then failed reading the CLI's answer: `org ragequit` prints two
  JSON lines (the result, then the member view the desktop app reads) and the spec parsed them as one document. The spec
  now reads both lines and also checks the Shares left in the member view.
- **The screen audit** fails a stop that does not reach its state, and two stops that saved the same picture
  (`scripts/screen-audit-unique.mjs`), unless one is a redirect or declared to look like the other.

## Waiting on you

Rewritten 2026-11-15 to the direction of 2026-11-10, refreshed after the MVP push, and again after the decisions push. The
first four are what stands between the repository and inviting three to five founders; the rest wait on what that run shows.
**[MVP-READY.md](MVP-READY.md) is the same list as one page for you: nine chores only you can do, the 29 decisions and the
screen audit's list as the assistant made them at your request on 2026-11-15 (each marked built or not), and a short "Still
yours" list.**

1. **Decided 2026-11-15 (D200): Pilot A (founders, no chain) runs before the contributor run, and the yes line for its one
   number is written in the header of [PILOT-REPORT.md](PILOT-REPORT.md).** This changes the old item 6, which put the
   social run and then the contributor run first. Pilot A needs none of the contributor run's setup (no Sepolia deploy, no
   ZeroDev project, no chain node, no synced passkeys, no reviewers). It is written as
   [PILOT-RUNBOOK.md](PILOT-RUNBOOK.md), "Pilot A", with the day-by-day plan, the questions and what counts as a yes; you may
   still change the yes line, but only before day 1. **Still yours: approve the operator posting weekly on Creaton's own
   project for the whole pilot** (the runbook's "operator's cadence"): if you will not, say so before the run and the example project is
   taken down rather than left to go quiet.
2. **Run the gate** on the build you host: `scripts/mvp-gate.sh --pilot` (eleven journeys; the project loop is one of them),
   and the loop again on an invite-only server, as the pilot is: `BUZZ_REQUIRE_RELAY_MEMBERSHIP=true scripts/real-loop-e2e.sh`.
   CI runs the first on the fork's pull requests. **Run the loop first**: its last full run (10 of 10, twice) came before the
   first-week page, Start in one press and the new Discover tab, and its spec was edited for them without a real server.
3. **Host the server** with `deploy/compose` (the image, terms at sign-up, backups): a machine, a domain, the filled-in
   `.env` **without** the Sepolia lines, and these two that only you can do, with exact steps written down:
   - **One restore rehearsal on a second machine**, with your real backup and your private backup key
     ([RESTORE-REHEARSAL.md](RESTORE-REHEARSAL.md), which opens with what to do in order; about two hours). Not run, and an
     agent cannot run it: it needs your server's backup, your key and a second machine.
   - **An outside uptime check with an alert on your phone**, tested once
     ([deploy/compose/README.md](../../deploy/compose/README.md), "Uptime check": two monitors, an alert after two failed
     checks, a test monitor that fails on purpose). Not set up: it needs your account with a monitoring service and your phone.
4. **Start Creaton's own project** from [CREATON-EXAMPLE-PROJECT.md](CREATON-EXAMPLE-PROJECT.md), Part A, before inviting
   anyone: Start's three answers, a first update, a label ("the server's own") in its sentence, and your key (or
   `BUZZ_PILOT_EXCLUDE`) so it stays out of the pilot's numbers. Then put the end of its shared address in
   `BUZZ_EXAMPLE_PROJECT` and restart, so a visitor with no account is offered "See a record" on Home (D202). Then the
   invites, one per founder ([PILOT-RUNBOOK.md](PILOT-RUNBOOK.md), "Pilot A").
5. **Decided and built 2026-11-15 (D201, D202): a visitor with no account may read a public project's record on an
   invite-only server, when the server's setting is on.** `BUZZ_PUBLIC_PROJECT_READS=true` is set for Creaton's own server in
   `deploy/compose/.env.creaton.example`; with it off the page says "You need an invite to open this project", who to ask,
   and offers Sign in, as before. The visitor is sent the project's own record, the founder's goals and promises, the team's
   updates and accepted work, and nothing else (a project that states the terms of a sale was closed to them until next-version
   milestone 0 made it public like any other); a private project's name is never shown. Link previews and the server's example project follow the same setting. **Still yours:**
   counsel's read before the pilot server starts with it on (invite-only was chosen for abuse and moderation reasons, D107),
   and the calls listed in [MVP-READY.md](MVP-READY.md), "Still yours" 4 and 5. [HOLDER-ACCESS-MODEL.md](HOLDER-ACCESS-MODEL.md)
   and the runbook's "What a visitor gets" still describe reads for members only and are not yet brought in line.
6. **The policy drafts** in `docs/policies/`, with a lawyer. Since the lawyer's review (D183, D184) the web app asks members to agree again when the text changes, the age box is on by default in the compose stack, the start guard is stricter and backups are encrypted to a key kept off the server; the desktop and mobile apps (decide: offer no mobile build), the pin and days-ahead of a change notice and every owner or counsel bracket are still open (see "Counsel's second round" and the Code follow-ups in `docs/policies/LAWYER-FEEDBACK-RESPONSE.md`). Showing returns, even only in Home's feed, is for counsel to read before it ships. Also for counsel: the words "Thanks for saying so", "Good luck" and "Cheer" on Home, and questions 9 and 10 added to [BACKING-POOL.md](BACKING-POOL.md) (is a fee on units that never sold a sale fee; does the founder choosing the curve depth make the founder more clearly the issuer).

**Later, not before Pilot A has been read:**

7. **Weekly sales (D181, D182), in this order:** read the brief's section 8 and decide the open items (price-token policy, a floor
   for the founder schedule, whether the old rounds contract may be named as an exit exchange, order caps, the allocation
   rule, wash-trade wording (you chose price history with a standing line saying one person can set a round's price, under the latest round and the earlier-rounds list, D185; its words are counsel's and not approved; the old WeeklyRounds contract is deprecated on our side, and sealing the exit-exchange slot is still open), quorum floors, listing notice, which kit pilots use, the pilot build's Trading card, now hidden there, so say whether to keep that);
   send [LAWYER-BRIEF-WEEKLY-SALES.md](LAWYER-BRIEF-WEEKLY-SALES.md) and the review packet to counsel and to the outside
   reviewer; walk the changed trading flows yourself (`scripts/web-trading-e2e.sh` shows what the agents drove); decide whether the
   fixes from the low-severity run get a second look (a review of them has not been run); and only then consider a release decision, which is never bundled with a
   deployment.
8. **The rest of the calls in [DEPRECATION-2026-10-31.md](DEPRECATION-2026-10-31.md)**: what to remove, merge or keep, one line each.
9. **Broadcast to Sepolia:** `scripts/sepolia-deploy.sh --broadcast`, with your own key in `.env`; then the contributor run
   ([PILOT-RUNBOOK.md](PILOT-RUNBOOK.md), "Second"). The backing pool contract changed on 2026-11-14 and 2026-11-15 (leave
   keeps units, depth tiers, a new event), so a copy already on Sepolia is out of date and the investing switch needs a fresh
   deploy; ask the assistant for the exact command. Not needed for Pilot A.
10. **The card onramp** on the local branch `onramp-options`: waiting on provider keys, not merged.

## Only a hosted pilot can show

A founder, independent reviewers and several contributors (one new to crypto, one doing non-technical work, one who
joins late), on their own devices, with no walkthrough: how people find work, the first submission, how long review
takes, a turn-down, the 7-day window, the award vote, coming back a day later, and recovering an account on another
device. What to measure is in [PILOT-REPORT.md](PILOT-REPORT.md).

## Known gaps, not yet designed

- **The MVP push of 2026-11-15 has had no hand test, no hosted run and no review of the web changes.** Every check is an agent's,
  mocked or on a laptop (see [MVP-READY.md](MVP-READY.md), "What the numbers are"). Specific gaps the engineers recorded:
  six older browser specs for the project page were updated for the new first-week cards, and the full mocked suite was not
  run in one go; the page's depth picker is exercised only by the mocked spec, not against the real contracts; the run-record
  and reported-numbers reads were checked against a mocked server only (several piece ids in one read are unchecked on a real
  server); the "Draft from the record" button is only in the founder's update dialog; the update day is kept in the browser;
  the first promises and starter tasks of an AI kind are offered as a one-press prefill, with the kind picked again by name
  because Start does not store it (D206); "Open to agents" is a category filter; the accepted-work picture is offered once, to the person who confirmed; the link preview carries no counts;
  the agent command line cannot set a goal for an agent-started project.
- **The backing pool fixes (871b0e8, a20d191) were not reviewed again**, 14 optional review points remain (mostly that the leave
  fee follows the live price, bounded by the tranche cap and the app's limit), the 5,000 depth tier is dropped (D208) but
  nothing bounds the price multiple itself when a raise comes in at many times the depth, and the review's advice to ask for a confirmation when a founder picks a tier below the rule of thumb is not
  recorded as built.

- **The decisions push of later 2026-11-15 has had no hand test and no hosted run, and counsel has not read public reads.**
  Gaps its engineers recorded: public reads are one setting for the whole server, with no setting a community's owner can
  change; the limits are guesses and were not load-tested, and the limit for one address trusts the proxy's forwarded
  address; a change (a new update, a mute, a removal) reaches visitors up to 30 seconds late, and up to 5 minutes late while
  the shared budget is spent; a visitor to a project the server does not open sees the same invite sentence as for a project
  that does not exist; a signed-in person who is not a member was not tried in a browser; there is no mocked browser spec for
  the public record page; `dao-os.spec.ts:167` fails on a label that changed in an earlier commit; a relay test for the mesh
  demo (`demo_join_forwarded_arm_round_trips_echo`) fails on the engineers' machine and was not looked into; the step where
  "Set up Shares for people who help" opens has a unit test only; and the founder-alone check (D217) is recorded from its
  commits, not from a report.

- **Weekly sales: not audited, not legally reviewed, not released, not deployed, not hand-tested (D181, D182).** Every
  check is an agent's, on a scratch chain. No outside party has read the code; no lawyer has read the copy or the brief;
  no person has clicked through the changed flows; `check:file-sizes` could not run (no `origin/main` in this clone).
  Sepolia Shares are test records. The ten low-severity batches (B15 to B24) were run on 2026-11-05 (D182). A review of
  them found 11 points (2 medium, 9 low), all fixed in follow-up commits; **those follow-up fixes were not reviewed
  again (no delta review).** Still open from that run: the V2 kit still accepts the older launch call, which makes a
  sealed project with no market (waits for your kit decision, brief section 8 item 12); the exit-exchange slot is not
  sealed (item 3); no sentence about a fee on the card (item 6); the keeper test is not run by CI and the keeper's
  raw-key option remains with a warning; focus after collecting from an earlier round and one misplaced comment in the
  browser test were not confirmed fixed; `forge fmt` is not enforced and differs in 9 of 32 contract sources.

- **A record reader independent of community membership**: a holder banned from a community must still be able to read
  the evidence needed to object, vote and leave ([BOARD-MODERATION-DESIGN-2026-10-22.md](BOARD-MODERATION-DESIGN-2026-10-22.md) §5).
  Not built. For the testnet pilot: the model, what still works for a banned holder, a manual fallback ("Mute
  everywhere" instead of a ban for holders; evidence sent privately and checked against its hash on the chain; the
  command line for browser-wallet holders; a mute window for passkey holders) and its hand test are in
  [HOLDER-ACCESS-MODEL.md](HOLDER-ACCESS-MODEL.md). The hand test has not been run, so this stays open until it passes.
- **Recovery on a hosted server** (passkeys and devices, wallet binding, backups) has not been run end to end. The
  backup half is written as [RESTORE-REHEARSAL.md](RESTORE-REHEARSAL.md): your real backup, restored and checked on
  another machine.
- **The raise's currency reserve does not apply**: the launch kit gives its executor a zero reserve, and the contract
  already has a treasury fallback ([RESERVE-APPLICABILITY.md](RESERVE-APPLICABILITY.md)). Nothing to build.
- **A forecast's time is its device's clock** (D116), accepted within 15 minutes. No money rides on it.
- **Words in browser storage:** a work area's words that failed to publish are kept only in the browser that opened the
  vote; the suggestion or filed evidence also carry them.

## Deferred on purpose (D137)

- **Plans and proposals, frozen until the pilots have run:** [MARKETS-AND-EXIT-PLAN.md](MARKETS-AND-EXIT-PLAN.md),
  [NEXT-GEN-DAO.md](NEXT-GEN-DAO.md) (N1 to N12 decided as D113 to D124, built for test networks only),
  [JOIN-CURVE.md](JOIN-CURVE.md) (D112 decided its asset question; eight questions open),
  [POST-LAUNCH-CURVE-INTEGRATION-PLAN.md](POST-LAUNCH-CURVE-INTEGRATION-PLAN.md),
  [CONTRIBUTOR-TOKEN-TRADING.md](CONTRIBUTOR-TOKEN-TRADING.md) (recommendation 3 open: voting Shares or Loot for sale
  between members), [LATER-DESIGN-NOTES.md](LATER-DESIGN-NOTES.md), [ROUND-PRICE-HISTORY.md](ROUND-PRICE-HISTORY.md)
  (built as D147; weekly rounds stay off in the pilot image), [LBAMM.md](LBAMM.md) (evaluation only: its licence rules out live use; the app, indexer and scripts for it were removed in D150, see tag `pre-deprecation-2026-10-31`).
- **The project helper** (an AI assistant on a project): only if the pilot shows questions that Ways to help and Needs
  you do not answer.
- **Fundraising explanations and the raise itself:** after the audit, a verified deployment and a legal read
  ([AUDIT-SCOPE.md](AUDIT-SCOPE.md), [PILOT.md](PILOT.md)). A no-sale mainnet deployment needs the audit too.
- **Board moderation, later steps:** the record reader, then moderators chosen by a project's DAO only if appointed
  moderators are not enough. No token rewards for engagement.
