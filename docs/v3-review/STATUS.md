# Where Creaton stands

Updated 2026-11-02 (v5 development scope; prior v4 validation remains historical); the weekly-sales items in Scope, Known gaps and Waiting on you were updated 2026-11-05, and again the same day after the low-severity run. The index to start from; it replaces [STATUS-2026-10-22.md](STATUS-2026-10-22.md), kept as history.
Each decision is a row in [DECISIONS.md](DECISIONS.md) (through D182). The hand tests for the pilot, in order, are in
[PILOT-TEST-GUIDE.md](PILOT-TEST-GUIDE.md); every hand test ever written is in [TEST-STEPS.md](TEST-STEPS.md), a log in
date order. What the 2026-10-31 pass hid or retired, and what waits on your call, is in
[DEPRECATION-2026-10-31.md](DEPRECATION-2026-10-31.md).

The branch `v4-governance-rework` is pushed to the fork (https://github.com/Aeroxander/creabuzz, since 2026-11-01); draft PR Aeroxander/creabuzz#1 runs CI against `ci-base`, not the fork's `main`, which still holds 12 older SIWE commits this branch reworked. D146 to D150 are committed locally (D150 removed the LBAMM market, the pre-kit raise path, the old tokenomics and money forecasts from the app; tag `pre-deprecation-2026-10-31` keeps them).

A plain-words copy pass rewrote the web app's user-facing text for readers new to crypto and DAOs (no number, economic setting or trading switch changed); what changed, and the legal lines left for you and counsel, is in [COPY-PASS-1.md](COPY-PASS-1.md).

## Scope

- **The MVP is the server, the web app and contributor projects**: no raise, no sale, no market (D137). New Shares come
  only from reviewed work and an award vote.
- **No desktop or mobile app in the MVP.** The desktop and mobile apps in this repository are not kept level with the web
  app and are not part of any pilot; D9's "desktop and mobile parity after" waits until after the pilots (noted on D9).
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
| Every screen, read as the pilot sees it | D108 to D111, D146 | `WEB_FEATURES=mvp scripts/web-screen-audit.sh`; [SCREEN-AUDIT-2026-10-24.md](SCREEN-AUDIT-2026-10-24.md) |
| Sepolia readiness: the deploy rehearsed on a fork, every contract checked, the largest transaction under the gas cap | D85, D140 | `scripts/sepolia-deploy.sh` (rehearsal); `web-contributor-e2e.sh --sepolia-fork` |
| Test networks only, off in the hosted build and frozen: bounties, forecasts, CREATE and the court, money forecasts (removed from the app in D150 and from the contracts in D151, see tag pre-deprecation-2026-10-31), matched exits (retired in D152), payouts, remixes, weekly rounds, funding terms | D113 to D136 | Forge suite, mutation check, `web-post-bounty-e2e.sh`, `web-rounds-e2e.sh` |
| The raise, as far as it goes (after the audit) | D72 to D82, D86, D87, D102 | Forge suite, simulation, the gate's later set |

## The gates

- **Run `scripts/mvp-gate.sh --pilot` green on the build you host** (ten journeys: the pilot build's screens, the
  social suite as the pilot server runs it, invite links, error reports, the command-line and page contributor
  journeys, the passkey one, work and paid work, and `web-restricted-holder-e2e`: a muted, then banned, holder keeps
  their rights on a real server, plus `web/tests/e2e-real/passkey-sign-in.spec.ts`, passkey sign-up and sign-in again
  against that real server). Under `--pilot` the page contributor journey (`web-contributor-e2e`) runs in the
  contributor-only build the pilot ships (`PILOT_BUILD=1`, since 2026-11-01). `scripts/mvp-gate.sh` runs all
  27 (10 pilot, then 17 later), the pilot set first;
  `--later` runs the raise, milestone, optional-feature, self-serve and weekly-sales (secondary market) journeys alone
  (17); `--list` shows what
  would run; `--outside` lists the four journey scripts no set runs, each with its reason. A journey script in no set
  and with no reason is printed as a warning on every run ([MVP-GATE-CI.md](MVP-GATE-CI.md)).
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

0. **Weekly sales (D181, D182), in this order:** read the brief's section 8 and decide the open items (price-token policy, a floor
   for the founder schedule, whether the old rounds contract may be named as an exit exchange, order caps, the allocation
   rule, wash-trade wording, quorum floors, listing notice, which kit pilots use, the pilot build's Trading card, now hidden there, so say whether to keep that);
   send [LAWYER-BRIEF-WEEKLY-SALES.md](LAWYER-BRIEF-WEEKLY-SALES.md) and the review packet to counsel and to the outside
   reviewer; walk the changed trading flows yourself (`scripts/web-trading-e2e.sh` shows what the agents drove); decide whether the
   fixes from the low-severity run get a second look (a review of them has not been run); and only then consider a release decision, which is never bundled with a
   deployment.
1. **Run the gate** on the build you host, as above (CI runs it on the fork's pull requests).
2. **The rest of the calls in [DEPRECATION-2026-10-31.md](DEPRECATION-2026-10-31.md)**: what to remove, merge or keep, one line each.
3. **Broadcast to Sepolia:** `scripts/sepolia-deploy.sh --broadcast`, with your own key in `.env`.
4. **Host the server** with `deploy/compose` (the image, read state, terms at sign-up, backups): a machine, a domain, the
   filled-in `.env`, and one restore rehearsal ([RESTORE-REHEARSAL.md](RESTORE-REHEARSAL.md)).
5. **The policy drafts** in `docs/policies/`, with a lawyer.
6. **The social run, then the contributor run** ([PILOT-RUNBOOK.md](PILOT-RUNBOOK.md)), with the first project typed in
   from [CREATON-EXAMPLE-PROJECT.md](CREATON-EXAMPLE-PROJECT.md) and a few boards with real first posts.
7. **The card onramp** on the local branch `onramp-options`: waiting on provider keys, not merged.

## Only a hosted pilot can show

A founder, independent reviewers and several contributors (one new to crypto, one doing non-technical work, one who
joins late), on their own devices, with no walkthrough: how people find work, the first submission, how long review
takes, a turn-down, the 7-day window, the award vote, coming back a day later, and recovering an account on another
device. What to measure is in [PILOT-REPORT.md](PILOT-REPORT.md).

## Known gaps, not yet designed

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
