# What was hidden, retired or merged on 2026-10-31, and what waits on you

A survey of what no longer fits the MVP (the server, the web app and contributor projects, with no raise and no desktop:
D137), followed by a re-check of the D146 screen audit. Item ids are the survey's (#1 to #38) and the re-check's
("STILL #n" for an earlier screen finding not yet fixed, "NEW1" to "NEW32"). The rule for this pass: a feature still used
in raise builds is **hidden in the contributor-only build**, not deleted; anything that removes code a raise build uses,
or reverses a decision you took, is left for you below. The contracts stay frozen (D137). The current index is
[STATUS.md](STATUS.md).

## Done in this pass

**Hidden in the contributor-only build** (raise builds unchanged). The web areas took these; each area's report has the
detail and anything it could not finish.

- Idea pages: no sale checklist or bidder tools under Manage, and no D60 project-ops surfaces (helpers tab, the
  workspace work board) (#1, #2).
- Remixes step one on Start and project overviews (#3).
- Routes that opened by address with no gate: the court, the passkey demo, the desktop link-device page, the Projects
  board with its % seats, and repositories (#4).
- Start's "Set up a place to work" step, which led nowhere on an invite-only server (#5).
- AI helpers, helper budgets and the template and room-dialog helper pickers where no helper can run (#6).
- The work-board Points card on Your work for people without points (#7).

**Removed:** the Discussion tab's thread-summary switch and button, a stub that always failed (#8); the orphaned desktop
hand-off card, with the fixture generator moved out of the app (#27); code with no production caller (#28), where its
area confirmed it by search.

**Merged or renamed:** one idea-to-project path and one project list (#10, #11); one place for private messages and
notices (#13); one navigation (#14); one meaning each for "Work", "points" and "Projects" (#15); one rule for naming a
person with no profile name (#16); one set of error words (#17); the record-only Proposals tab beside Decisions (#25),
where taken. The screen re-check's open items (STILL #10 to STILL #96, NEW1 to NEW32) went to the web areas by screen.

**Scripts and documents** (this area):

- **#9** [CREATON-EXAMPLE-PROJECT.md](CREATON-EXAMPLE-PROJECT.md) now matches the runbook: reviewers added by name after
  they show their name with their account, three reviewers with two of three deciding (or two with "Let any one
  decide", where the first answer decides; D145), two work areas, and an invitation that says the founder accepts each
  piece for review and someone presses Finish the review to start the 7 days. The runbook names
  `scripts/web-social-hosted-e2e.sh` for the automated social run.
- **#18** written down, with no code change: `VITE_CONTRIBUTOR_ONLY=1` (read by `raisesOffered()`) is the hosted MVP's
  switch, set only by the image's Dockerfile; every other build offers raises ([STATUS.md](STATUS.md), "The hosted
  build"; `deploy/compose/README.md`; `web/README.md`).
- **#31, #32** the gate: `scripts/mvp-gate.sh --pilot` runs what the pilot depends on (the hosted social suite, invite
  links, error reports, the contributor journeys from the command line, pages and passkey accounts, work and paid work);
  `--later` runs the raise, milestone and optional-feature journeys; `--list` shows the set. Invite links and error
  reports were not in the gate before. The hosted social run now fails on a missing social spec or a media store that
  is down (the picture test used to skip). As of 2026-10-31 nothing ran the gate on its own and its last recorded pass
  was from 2026-10-28. Since 2026-11-01 `.github/workflows/mvp-gate.yml` runs `--pilot` on pull requests and `--later`
  nightly on the fork; the gate now holds 27 journeys, and its last recorded full pass is 2026-10-31
  ([STATUS.md](STATUS.md), "The gates").
- **#33** `scripts/sepolia-deploy.sh` prints the pilot's settings alone, and the optional features' only with
  `--optional`; `just dev-chain` prints a contributor-only build's settings first (with `VITE_CONTRIBUTOR_ONLY=1`), and
  the rest only with `DEV_CHAIN_ALL=1`. Both still deploy everything: a pilot-only deploy would change the Forge deploy
  script, which is frozen with the contracts.
- **#34** `scripts/dogfood-loop.sh` deleted (nothing referred to it); `launchpad-anvil-fork.sh`, `web-decisions-e2e.sh`,
  `web-discussion-e2e.sh` and `web-passkey-wallet-e2e.sh` carry a "not in any gate" banner saying what replaced them.
- **#35** [STATUS.md](STATUS.md) is the current index, short and up to D146; [STATUS-2026-10-22.md](STATUS-2026-10-22.md)
  stays as history behind a pointer.
- **#36** [PILOT-TEST-GUIDE.md](PILOT-TEST-GUIDE.md) orders the hand tests before and during the pilot and points into
  [TEST-STEPS.md](TEST-STEPS.md), which stays a log.
- **#37** freeze or history banners on the superseded proposals and review records (JOIN-CURVE, MARKETS-AND-EXIT-PLAN,
  POST-LAUNCH-CURVE-INTEGRATION-PLAN, NEXT-GEN-DAO, CONTRIBUTOR-TOKEN-TRADING, the five October review records, and the
  older plans under `docs/`). The no-desktop scope is written on D9 and in STATUS.md.
- **#38** [ROUND-PRICE-HISTORY.md](ROUND-PRICE-HISTORY.md) was built on its own branch as D147 and merged on 2026-10-31;
  weekly rounds stay off in the pilot image.
- **NEW6** the screen audit captures what each stop is named for: sign-up and sign-in open from the controls a phone
  actually has, the decision forms pick their kind from the phone's list and are photographed on their own, a stop
  fails when it does not reach its state, the hosted build checks that the sale screens are absent or lead elsewhere
  instead of photographing a copy of another page, "Loading …" lines are waited out, and `scripts/screen-audit-unique.mjs`
  fails the run on two equal pictures unless one is a redirect or declared to look like the other.

## Waiting on you

Rows marked done were removed on 2026-10-31 (D150); the commit before them is tagged `pre-deprecation-2026-10-31`.

| Item | What | Recommendation |
|---|---|---|
| #12 | Two discussion systems on one project (feed notes and board posts), three vote widgets, three composers | Done in D156, before the pilot as you asked: each project has its own board, which is its Discussion tab; older notes stay read-only under it. One vote control (take back, change, muted reason) everywhere; the feed composer is gone, leaving Home's and a board's. |
| #19 | Matched exits and weekly rounds compete for one exchange slot | Done in D152: matched exits retired (contract, kind 47009, screens, deploy steps, the journey's sale step); weekly rounds keep the slot. |
| #20 | Four send paths and two modules named one hyphen apart | Done in D150: `useWalletSend` wraps `useChainSend`; the passkey sender renamed `passkey-sender.ts`; the picker marked raise-only; an unused governance sender deleted. |
| #21 | 43 web files that only re-export the core package | Done in D155: the 36 that held nothing else are gone and their importers name the core module; `shared/constants/kinds.ts` stays as the tested way into the event kinds, and six files that add their own code stay. |
| #22 | The LBAMM market and price stack (page, decisions, price sparkline, indexer, scripts, specs, CLI command) | Done in D150, tag `pre-deprecation-2026-10-31`. The sale's own price card stays on raise pages. The contracts went in D151: `SellRateGate`, `TieredSellRouter`, `BuybackKeeper` and the `DeployRoyalty` and `JourneyFloat` scripts. No submodule was removed: `lib/tm-tokenmaster` and `apptoken-dev` still serve the dev chain, and the two unused creator-token submodules are for you to remove. |
| #23 | The pre-kit raise path (mint or imported token, the manual auction deploy, their journeys) | Done in D150: chain setup split to `scripts/apptoken-infra.sh`; mint, import and hand-deployed auctions removed from the web app; old minted launches open read-only. Desktop keeps its copy. D151 removed `AuctionLauncher` and `AppTokenLBPInitializer`; `DeployAppToken.s.sol` stays for the hidden `buzz launchpad mint-token`. |
| #24 | Pre-v3 tokenomics: royalties, float mode, buyback | Done in D150 for the app, the CLI and the float journey. The core royalty code stays while desktop imports it. D151 removed the float and buyback contracts; `RoyaltyDistributor.sol` stays byte-identical because `ClaimStake` imports its interface. |
| #26 | Money forecasts (N8) | Done in D150; the no-money forecasts stay. D151 removed `ForecastPool`, its tests, mutation cases and deploy steps. |
| #29 | No check for unused exports or orphan files | Done in D150: knip (`knip.jsonc`) runs as `pnpm -C web check:unused`, part of `pnpm -C web check` and CI. |
| #30 | The CLI's launchpad commands are raise-era and lack the contributor flow | Half done in D150: `buzz launchpad market` removed, raise commands hidden unless `BUZZ_DEV_RAISE_COMMANDS=1`. Still open: contributor-kit and work-area commands before agents join a pilot. |
