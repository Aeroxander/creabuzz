# Where Creaton stands

Updated 2026-11-01 (the gates, the restore rehearsal, restricted holders, the reserve). The index to start from; it replaces [STATUS-2026-10-22.md](STATUS-2026-10-22.md), kept as history.
Each decision is a row in [DECISIONS.md](DECISIONS.md) (D1 to D152). The hand tests for the pilot, in order, are in
[PILOT-TEST-GUIDE.md](PILOT-TEST-GUIDE.md); every hand test ever written is in [TEST-STEPS.md](TEST-STEPS.md), a log in
date order. What the 2026-10-31 pass hid or retired, and what waits on your call, is in
[DEPRECATION-2026-10-31.md](DEPRECATION-2026-10-31.md).

Everything is on the local branch `v4-governance-rework`, not pushed. D146 to D150 are committed locally (D150 removed the LBAMM market, the pre-kit raise path, the old tokenomics and money forecasts from the app; tag `pre-deprecation-2026-10-31` keeps them).

## Scope

- **The MVP is the server, the web app and contributor projects**: no raise, no sale, no market (D137). New Shares come
  only from reviewed work and an award vote.
- **No desktop or mobile app in the MVP.** The desktop and mobile apps in this repository are not kept level with the web
  app and are not part of any pilot; D9's "desktop and mobile parity after" waits until after the pilots (noted on D9).
- **No new mechanisms until the pilots have run (D137).** The contracts are frozen; what the pilots find gets fixed.
- **Order of release:** the social run, then a contributor project, then a milestone test on a test network, then the
  audited raise ([PILOT-RUNBOOK.md](PILOT-RUNBOOK.md)).

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
  twenty-two, the pilot set first;
  `--later` runs the raise, milestone, optional-feature and self-serve journeys alone (twelve); `--list` shows what
  would run; `--outside` lists the four journey scripts no set runs, each with its reason. A journey script in no set
  and with no reason is printed as a warning on every run ([MVP-GATE-CI.md](MVP-GATE-CI.md)).
- **Last full pass: 2026-10-31**, the 16 journeys of that day after the D150, D151 and D152 removals. Added since and
  not yet in a full pass: `web-pilot-e2e` (pilot set) and, on 2026-11-01, `web-rounds-e2e`, `web-post-bounty-e2e`,
  `web-self-serve-e2e` and `shares-erc20c-e2e` (later set; no gate ran them before).
- **A CI job is written, not pushed:** `.github/workflows/mvp-gate.yml` runs `--pilot` on pull requests that touch the
  web app, server crates, packages, contracts, scripts, deployment config or the database, and `--later` nightly,
  with Postgres, Redis, MinIO, Foundry and a browser, and uploads every log. It has never run; publishing it is your
  call, and any pull request stays a draft. Until then nothing runs the gate on its own: run it again after any change
  to what `dev-chain` deploys or to words journeys assert.
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

1. **Run the gate** on the build you host, as above, and decide whether to publish its CI job (`.github/workflows/mvp-gate.yml`, written, not pushed).
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
