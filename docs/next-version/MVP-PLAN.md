# Creaton Lite: the plan to MVP

Status: plan, 27 November 2026, corrected after a critic's pass. Branch `lite` (0487c32bf). Not legal advice. Play dollars on a test network.
Marks: CHECKED = read or run by an auditor or the author. ASSUMED = estimate. Sizes: XS under half a day, S about a day,
M 2 to 4 days, L over a week (all estimates).

The owner's steer: as few steps and as little text as possible; features and words can come back later; a project must
still be able to raise and grow. So this plan is mostly subtraction. The two fixed sentences, the terms, the privacy
note, the age box and "Posts and votes are public" are never touched. `contracts/pot` is never edited (737 tests).

## 1. One page

**Where lite stands (CHECKED by running).** The Rust workspace is fmt, check and clippy clean. Relay lib tests
pass (1617), the app has 2113 passing tests, the build and bundle budget pass, `forge test` gives 737 passing, and
`scripts/pot-app-loop.sh`, `scripts/phone-loop.sh` and a full `scripts/pot-full-loop.sh` (5885 checks, 7 worlds) are
green. Red: (a) one flaky relay test, (b) the app's file-size gate cannot find a base on this branch. **Not verified
by anyone:** the Postgres-backed relay and db tests (about 900 ignored), `buzz-test-client` e2e, a Docker image build,
a Sepolia deploy, a real phone. Nothing found blocks a launch.

| Journey | Now | Target |
|---|---|---|
| Visitor: link to first Back | 7 screens, 10 presses, 2 fields, 3 passkey prompts, about 900 words | 4 screens, about 6 presses, 2 fields, about 350 words |
| Visitor: Back to Take out | 2 to 3 presses, about 230 words | 2 presses, about 100 words |
| Founder: Start to launched | 7 screens, 9 presses, 4 typed fields, about 1,050 words | 5 screens, 5 presses, 3 typed fields, about 300 words |

(Hand-trace, plus or minus 15%. Words exclude legal text.)

**The three biggest findings.**
1. About 11k lines of app source are never reached by the default build (legacy flag off), and about 20 more features
   are not needed for a first launch (tasks, room, brain, manager, seasons, push, seat, pause, and so on).
2. A signed-out visitor on a project page cannot sign up except through "Ask to join", which means something else
   (`app/src/features/project/JoinBox.tsx:94`; dead end `app/src/features/pot/use-pot.tsx:132-138`; CHECKED). A new
   project cannot be backed for about 2.5 minutes after Launch: the server waits 12 blocks
   (`crates/buzz-relay/src/chain_reader/settings.rs:136`; CHECKED; 12 s a block ASSUMED).
3. The launch is held up by things that are not code: finished terms and privacy (56 and 70 bracketed items, on 50 and
   56 lines; CHECKED), a bundler and sponsor vendor for phone accounts, a Sepolia deploy, the human phone test.

## 2. The cut list

**How.** Delete in the app (`v6.5-full` keeps everything; a hidden feature still costs tests, bundle and reading).
Leave server code in place for now (C13, optional). Migrations are never dropped. Contract features stay off by deploy
settings (`HOLDER_PAUSE=0`, no `EARLIER_*`; `DEPLOY-TEST-NETWORK.md:61-93`). TaskBook cannot be switched off (the
Launcher clones it, `contracts/pot/src/Launcher.sol:206-207`), so team tasks stay possible on chain (see D10).

**Order matters (CHECKED imports).** Room imports `posts/*`, `safety/*` and `room/room-words`, which saved, tags,
search and profile also use; Home, Profile and Post import posts and safety. So: step A (free cuts), step B (seasons,
brain, manager, alerts), step C (room, then social, with the Home rewrite), step D (the money path). One commit per
row; the tree builds after each.

**Per-cut check, every time:** `cd app && pnpm check && pnpm test && pnpm build`, then from the repo root
`pnpm exec knip --no-progress` (knip fails from `app/`; `Justfile:414-416`), including orphans in
`packages/creaton-core` (delete what knip lists). `app/tests/helpers/legal-words.ts` must pass at every commit. A cut
that drops a dependency (`isomorphic-git`, `@isomorphic-git/lightning-fs`, `app/package.json:26,32`) updates
`pnpm-lock.yaml` in the same commit (the image installs with `--frozen-lockfile`, `Dockerfile:137`).
Browser specs that need a chain skip silently without anvil and `contracts/pot/out`
(`app/tests/e2e/helpers/live-chain.ts:41-54`); run them with `REQUIRE_CHAIN=1`. The phone spec runs through
`scripts/pot-app-phone-e2e.sh`.

Sizes are lines under `app/src/features/*` counted by the corrector (CHECKED), source / tests.

| Id | Step | Cut | Evidence and files | Saves | Watch out |
|---|---|---|---|---|---|
| C1 | A | Legacy-screens cluster: `app/src/legacy`, `features/market`, `features/earlier`, `features/team` except `use-wallets.ts` (still used by `pot/ProjectMoney.tsx:17`), `LinkWallet.tsx` too (its only caller is `YouPage.tsx:60,165`; fix `money/passkey-words.test.tsx:13`), money v1 files (`Receipts`, `OpenBacking`, `OpenRounds`, `BackBox`, `MoneyTab`, `calls-v1`, `numbers-v1`, `use-money-v1`, `numbers-market`), `project/StageLine*`, routes `/earlier`, `/launchpad/$id`, `lib/legacy.ts`, core `launchpad/earlier-claim.ts`, `pot/earlier-proof.ts`, `scripts/pot-earlier-list.mjs` | Flag off by default (`app/src/lib/legacy.ts`); reachability scan found about 10.9k unreached lines | about 8.6k src, 4.8k tests (ASSUMED, from the scan) | `legacy-boundary.test.ts` goes with it |
| C2 | A | Earlier grants and Established: `features/earlier-grant`, `project/Established*`, e2e `pot-earlier`, world in `e2e-pot-full` | Route needs three VITE settings that stay unset | about 0.8k src | none |
| C14 | A | Multi-community leftovers: `crates/buzz-test-client/tests/conformance_multitenant.rs` (2,945 lines, 19 tests, all `#[ignore]`), `docs/multi-tenant-conformance.md`, `.env.example:152-153`, dead script names in `loop-test.sh`, `m8-agent-week.sh`, `pot-app-loop.sh`, `pot-app-phone-e2e.sh`, `deploy/compose/README.md` | Nothing runs them | about 3.2k | **Leave `docker-compose.yml` alone** (keycloak/adminer/prometheus back `Justfile:68-76,174` and `scripts/dev-setup.sh:74`); `cargo check --workspace --all-targets` |
| C15 | A | Docs: move reports (STEP1 to 4, M1 to M8, PLANV2, EARLIER-BACKERS, `econ/`, `design/`) to `docs/archive/`. Add one line at the top of `MVP-V6-5.md`: its line 12 (tasks, pay, a Pair) is replaced by this plan | 311k words in `docs/next-version`; about 42k needed | none in code | Keep JOIN-LEAVE-DESIGN, DEPLOY-TEST-NETWORK, TRY-IT, RECORD-V2, LITE, MVP-V6-5, this plan |
| C3 | B | Seasons, Ranked: `features/season`, Home Ranked section and band (`home/HomePage.tsx:24-26,128`), `/season/$n` route, `project/use-project.ts` import of `season/season-records`, e2e `pot-seasons`, world | Band shows only when a season exists | 1.3k src, 1.5k tests | Home rewrite is in C7 |
| C4 | B | Brain: `features/brain`, `BrainOffer` in `start/StartPage.tsx`, row on `ProjectPage.tsx`, `?brain=setup`, e2e `brain.spec.ts` | 28 words on Start, 30 on every project page | 0.8k src, 0.6k tests | `isomorphic-git` leaves the bundle; lockfile |
| C5 | B | AI manager: `features/manager`, manager panel in `week/WeeklySheet.tsx`, e2e `manager.spec.ts` | LLM settings stay unset | 0.5k src, 0.3k tests, 0.24k e2e | `pot-week.spec.ts` |
| C6 | B | Alerts, push, news: `features/alerts`, `features/notifications`, tab-bar badge, push card on You, e2e `pot-alerts`, `pot-push`, world; `scripts/web-push-loop*` | Push needs VAPID keys that stay unset | about 2.5k src (ASSUMED) | `useMarkProjectSeen`, `YouPage`, `TabBar`; keep `/sponsor` routes |
| C10 | C | Room: `features/room`, Back-sheet checkbox, `use-link-after-back`, `use-room-standing`, e2e `pot-room`, world, `scripts/room-loop*` | 45-word public-wallet checkbox on the Back sheet | 3.2k src, 3.6k tests | `ConfirmAccount`; must go before C7 |
| C7 | C | Social extras: `features/posts` (keep what `UpdatesTab` needs), `tags`, `search`, `saved`, `messages`, `pictures`, most of `safety`, `project/share-card*.ts`, `SenderChoice`, routes `/u/$pubkey` and `/post/$id`, e2e `search`, `bookmarks`, `pictures`, `messages-key`, `mutes`. **Home rewrite (M):** a plain newest-first project list; drop `PostCard`, `use-hidden`, follows. Keep `LazyComposer` for founder updates, which means trimming `Composer.tsx` (it imports `pictures/*`) | None is on a journey | about 4.7k src, 3k tests (ASSUMED); core `social/` orphans (board, mute, nip17, notifications, pictures, bookmark, message-servers) go too | `HomePage.tsx` is rewritten, not just cut; phone-loop |
| C9 | D | Holder pause UI: `features/pause` | Contract off by `HOLDER_PAUSE=0` | about 2.5k incl. tests | `readParked` in `pot/TakeOutSheet.tsx` and `YourShares.tsx`, `launchSentence`, `TeamPauseLine`. **Touches Take out** |
| C8 | D | Seat card (hand over, Pair, wind down): `features/seat`, `pot/PairWaiting*`, `team/PairCard`, e2e `pot-seat` | Founder-only, rare. Contracts keep wind-down | 0.9k src, 0.9k tests | `SeatSection` in `pot/ProjectMoney.tsx` |
| C11 | D | Tasks, **team side only** (see D10): post, accept and pay, pay box, agent caps, `TasksTab`, `TaskCard`, task calls and records, e2e `pot-tasks`, `pot-plan`, world. **Keep** the holder side that a leaver needs: `tasks/chain/holder/*` (planned strip, note claim, take gate), `tasks/chain/{duration,state,types,words}.ts`, `use-tasks.ts` | `pot/pot-words.ts:6`, `pair-terms.ts:13-25`, `project/unit-words.ts:5`, `project-top-words.ts:7`, `feed/feed-words.ts:9` import the chain helpers; `ProjectMoney.tsx:13-16` imports holder pieces | up to 9.1k src, 10.6k tests if all of tasks goes; less with D10 (not measured) | Hide the Tasks tab. **Touches Take out and Back.** `pot-words.ts:16` holds a fixed sentence: never reworded |
| C16 | D | Harness for the cut features: `app/tests/anvil` (6.6k lines: edit `pot-task*`, `pot-team`, `pot-settled`, `passkey-team`, `passkey-pause`, `pot-tasks-scene`), `app/tests/helpers/{chain-task-answers,chain-task-shape,notes-scene,plan-scene,take-scene}.ts`, `app/tests/e2e-pot-full` (7 specs, 5,036 lines: keep `pot-full`, `seed`, a smaller `world.ts`), `scripts/pot-full-loop.sh:15-99,280-300`, `.github/workflows/mvp-gate.yml` | `pot-app-loop.sh` runs the anvil tests, so these are edits on the money path, not deletions | about 8k lines (ASSUMED) | After this, "pot-full-loop green" is one world: say so |
| C12 | D | Slop inside core: one money-copy module for the five overlapping ones (`money/pot-copy.ts`, `money-copy.ts`, `pot/pot-words.ts`, `pot-copy-step4.ts`, `team/team-copy.ts`); one `Line` and one `Row` helper; one `NO_RECORD`. Keep `legal-words.ts` | 33 copy files, 4.5k lines | about 2k | The merge must carry `NOT_A_RETURN` and the take-out sentence byte for byte |
| C13 | later | Server and CLI, optional: relay `task_chain`, `task_takes`, `chain_agent_link`, `agent_label`, `room_write`, `wallet_binding`, `api/manager`, `llm_gateway`, `web_push`, `handlers/season_rules.rs`, `chain_reader/explore.rs`, `record_step4.rs`; CLI `launchpad_tasks/brain/manager/inbox/facts`. Keep `chain_reader` core, `launch_update_authority`, `sponsor`, join-policy routes in `api/invites.rs` | About 20k relay and 5k CLI lines serve only cut features | large | High risk: tests share files with the reader. Clippy, relay tests, Postgres tests, full loop |

**Not cut, and why:** `buzz-deletion`, `buzz-conformance`, `community_id` columns (49 tables), the deployment-community
setup at startup (`crates/buzz-relay/src/main.rs:551-590`), `api/invites.rs` as a whole. `app/src/features/money` (7.2k
src, 5.6k tests), `profile`, `feed`, `you` are not cut here: they are the core, and C12 and section 3 are the only
shrink. That is the honest limit of this plan.

Rule for the money-path steps (C9, C8, C11, C16): `pot-takeout`, `pot-phone`, then `scripts/pot-full-loop.sh`, all
with `REQUIRE_CHAIN=1`. If a cut needs a contract change, stop and leave the feature off.

## 3. Copy budget and screens to shorten

Maximums (legal text never counted, never changed): page first view 60 words; a sheet 40 words plus its legal block;
a sentence 20; an error one sentence. Money-design lines on sheets (unaudited, play money, ownership) stay until counsel
agrees. When the project top shows what a Take out would give ("worth Y"), keep "This can go up or down. It is not a
return." beside it (`JOIN-LEAVE-DESIGN.md`, five sentences, point 5).

| Screen (file) | Now | Max | What goes |
|---|---|---|---|
| Launch card and sheet (`launch/LaunchSheet.tsx`, `launch-terms.ts`) | about 520 | 40 | Both fields as silent defaults (rate 0.10%, pool 10,000,000; see D10), the "same for every project" list, technical lists |
| Money tab, founder (`pot/ProjectMoney.tsx`, `AllowanceSection.tsx`) | about 400 | 100 | Stage meanings, team line, allowance paragraph, announced-rate, Door, Pair line, check-in block. Keep Draw and (D10) one change-rate row |
| Back sheet (`pot/BackSheet.tsx`) | about 140 | 40 | Fee lines, Details list, room checkbox |
| Take out sheet (`pot/TakeOutSheet.tsx`) | about 100 | 25 | Portion picker: one press takes it all |
| Project page (`project/ProjectPage.tsx`, `ProjectTop.tsx`) | about 130 | 60 | Details fold, facts list, brain row, chips |
| Sign-up (`account/SignUpPage.tsx`) | about 82 | 30 | Two helper paragraphs |
| Start (`start/StartPage.tsx`) | about 110 | 45 | Lead sentence, brain offer |
| This week (`week/*`) | about 153 | 50 | Manager panel |
| You (`YouPage`) | about 160 | 40 | Wallet choice, news |
| Faucet (`pot/FaucetCard.tsx`) | about 85 | 20 | Used-already and explanatory text |
| Recovery key sheet | about 55 | 0 now | Ask later from You (D6) |

## 4. The phases

### Phase 0: get lite green (about 1 day)

| Id | Item | Owner | Size | Files | Done when |
|---|---|---|---|---|---|
| P0.1 | Flaky `composition_log_does_not_leak_issuer_url` (about 30% under parallel `cargo test`): add `-- --test-threads=1` to the binary-test line | agent | XS | `scripts/run-tests.sh:279` (test at `crates/buzz-relay/src/main.rs:4322`) | passes 10 times in a row |
| P0.2 | File-size gate has no base (`origin/main` shares no history): fall back to `origin/lite`, then `HEAD^1`. Fix or drop `check-branch-skew.sh:14` | agent | XS | `scripts/check-file-sizes-core.mjs:54-61`, `lefthook.yml` | `cd app && pnpm check` exits 0; `node --test scripts/check-file-sizes-core.test.mjs` 10 of 10 |
| P0.3 | Stale text that misleads a deploy: `DEPLOY-TEST-NETWORK.md:190,204`, `deploy/compose/README.md:246`, `docs/policies/README.md:70-73`, `.env.example:222,224,263`, `packages/creaton-core/package.json:5`, `knip.jsonc:27-29`, README Railway link | agent | S | as listed | grep for `web/`, `desktop`, `mobile` finds no live instruction |
| P0.4 | Run what no one has run, on a machine with room: `just ci`, `just test`, `buzz-test-client` e2e, `mvp-gate.yml` once, one `docker build` of the image (not on the 4 GB box) | engineer | M | `Justfile`, `scripts/run-tests.sh` | green, or a fix list |

### Phase 1: cuts and the launch set (about 2 weeks, estimate)

| Id | Item | Owner | Size | Depends | Done when |
|---|---|---|---|---|---|
| P1.1 | Step A: C1, C2, C14, C15 | agent | S | P0.2 | each row's check |
| P1.2 | Step B: C3 to C6 | agent | M | P1.1 | each row's check; `pot-app-loop.sh`, `phone-loop.sh` green |
| P1.3 | Step C: C10 then C7, with the Home rewrite | agent | M | P1.2 | same, plus Home shows projects with no season, no posts |
| P1.4 | Fix the sign-up dead end: Back while signed out goes to `/welcome` with `next` and returns to the same amount (as `JoinBox.tsx` does for its press) | agent | S | none | `pot-phone.spec.ts` extended: a signed-out visitor backs without "Ask to join" |
| P1.5 | Step D: C9, C8, C11, C16 | agent | M to L | P1.3 | `pot-full-loop.sh` green (one world), with `REQUIRE_CHAIN=1` |
| P1.6 | Back on the top of the page shows "You hold X, worth Y. Take out" (with the not-a-return sentence beside it). Faucet: first try one separate "Get play dollars" press; fold it into Back only if the press counter needs it | agent | M | P1.5 | budgets in `app/tests/helpers/press-counter.ts:42-44` (start, back) lowered and met |
| P1.7 | One Start press that survives sign-up; Launch with no fields; recovery sheet no longer blocks (D6) | agent | M | C4 | founder journey at 5 presses |
| P1.8 | Copy pass to section 3 with C12 | agent | M | P1.5 | `pnpm check` and `legal-words` green; words re-counted |
| P1.9 | `BUZZ_CHAIN_CONFIRMATIONS=2` on the test network (D8) | owner decides | XS | none | Launch to Back box under 1 minute |
| P1.10 | **Docker build after the cuts**, then `deploy/compose/run.sh` start on a scratch host | engineer | S | P1.8 | step-13 checks of `DEPLOY-TEST-NETWORK.md:247-266` pass |
| P1.11 | Agent review under AGENTS.md "Reviewing", then the human test | agent, owner | S | all | `buzz-review-completed` only after the human has tested |
| P1.12 | C13, optional | agent | L | P1.11 | after Phase 3 if at all |

### Phase 2: human test and test-network deploy (about 1 to 2 weeks, mostly waiting)

Step numbers are those of `DEPLOY-TEST-NETWORK.md`.

| Id | Item | Owner | Size | Depends | Done when |
|---|---|---|---|---|---|
| P2.1 | Server with DNS and ports 80/443, Sepolia ether, two node URLs (steps 0, 4) | owner | S plus wait | none | host answers over https |
| P2.2 | Decide the switches: `HOLDER_PAUSE=0`, no `EARLIER_*`, `FEE_BPS` (read at `DeployPot.s.sol:68`). One-way after the first hour (`DEPLOY-TEST-NETWORK.md:63-67`) | owner | XS | none | written down |
| P2.3 | Deploy `contracts/pot` to Sepolia (step 2); keep the deployments JSON | engineer | S | P2.1, P2.2 | `Launcher.platform()` and `settingsHash()` read back as set |
| P2.4 | Secrets, chain settings, build settings, `./run.sh build`, `./run.sh start` (steps 3, 4, 8, 12) | engineer | S-M | P1.10, P2.3 | step-13 checks pass |
| P2.5 | Phone accounts: bundler for EntryPoint 0.7 plus sponsor behind a small proxy that holds the vendor key (step 7). Not skippable for a phone-first launch | outside, engineer | M | P2.4 | a phone with no wallet app backs and takes out |
| P2.6 | Finished `terms.md` and `privacy.md`, no brackets, dated (step 10). Owner sends counsel the operator facts first (`docs/policies/HANDOVER-TO-COUNSEL.md:14-23`). Remove the desktop and mobile brackets | owner, counsel | wait | none | zero brackets (grep) |
| P2.7 | Backup key, first backup, restore on another machine (step 13) | engineer, owner | S | P2.4 | restore rehearsed |
| P2.8 | **Human test on a real phone over https**: use `TRY-IT.md` section 4.1 (launch) and the back and take-out parts of 4.2; skip the room, season and task parts (they are cut). An agent cannot mark this done | owner plus one other | S | P2.4 to P2.6 | owner confirms in writing |

Skipped, and what it costs a user:

| Skipped | Cost |
|---|---|
| Holder pause (step 2b) | Holders cannot pause team spending; Take out is their protection. Permanent for this deployment |
| Earlier grants | None for new users |
| Helper key (step 5) | Fees uncollected unless someone calls `collectFees`. Back and Take out do not depend on it (ASSUMED on lite) |
| Wallet links (step 6) | Moot once the room is cut |
| Alerts (step 9) | No away alerts; a backer sees news only when opening the app |
| Seasons | No demo day |

### Phase 3: public test-network week

| Id | Item | Owner | Size | Done when |
|---|---|---|---|---|
| P3.1 | Invited testers first (D3): 3 to 5 founders, a few dozen backers | owner | wait | tester list |
| P3.2 | Watch relay logs, sponsor budget, chain reader lag, backup. One person on call | engineer | S per day | daily tick |
| P3.3 | Collect where testers stop, in the app's own steps | owner | S | a short list |
| P3.4 | Only if P3.3 shows a need: the "no check-in for N days" notice (`HYBRID-DIRECTION.md:122-139`; on `MVP-V6-5.md`'s own open list). Until then a founder who forgets loses the allowance silently: tell invited founders by hand | engineer | M | notice shows on a quiet project |
| P3.5 | Decide from P3.3 what to add back from `v6.5-full` | owner | S | list |

## 5. Can a project raise and grow? (Journey B walked)

Path: Start, Launch, share, update, weekly check-in, draw, backers Back and Take out. It works.

| Need | Provided by | Keep as |
|---|---|---|
| Found it | Start (3 answers), Launch | `start/`, `launch/` |
| Share it | Copy link and Share; the server makes the link-preview card (`crates/buzz-relay/src/share_preview.rs`) | drop "Save the picture" (C7) |
| Be found | Plain newest-first list on Home (rewrite in C7) | drop Ranked |
| Show life | Founder updates plus the weekly check-in | `UpdatesTab` composer, `WeekPage` |
| Get paid | Allowance draw to any account | `AllowanceSection`, Draw |
| Leave | Take out, one press | `TakeOutSheet` |

**Limits to say out loud:**
1. **Growth ceiling.** At the fixed 0.10% a day, a project holding 10,000 dollars can draw about 10 a day, roughly 3% a
   month. The design lets the founder go up to 0.20% (`JOIN-LEAVE-DESIGN.md:179,407`) and its own table puts
   allowance plus tasks at about three times that (`:250`). This plan removes the launch fields and the task screens, so
   that is the real "grow" limit. D10 decides it.
2. **No reminder** for a founder to check in (P3.4).
3. **Team spending beyond the allowance is invisible** if D10 is answered "cut all of tasks": TaskBook still lets the team
   plan tasks (up to 5% of the pot each, 10% per 28 days, notice of at least 14 days), and a leaver can still be owed a
   note. Both are protections in `JOIN-LEAVE-DESIGN.md:41-46`.
4. **"Built for the age of AI work"** has no AI-work feature left in the app (tasks, agent caps, manager and brain are
   cut). Say it in the launch words or put tasks back later.

**Raise goal: deferred.** The earlier draft added an optional goal box (about 230 lines). Dropped, for three reasons:
the owner asked for less; a project already raises without it; "X of Y dollars" would use `paidIn`
(`app/src/features/money/numbers-types.ts:81`), which is what backers put in after the fee and have not taken back
(`JOIN-LEAVE-DESIGN.md:92`), so it falls when people leave and reads as a target not met, and any progress line toward
a target sits badly with "no funding target, no deadline" (`:27-29`). A gate on team draws would need a new contract
(about 700 to 1,000 lines, re-verification) and holding back the fee edits the verified Treasury: neither is built.
If founders ask, ship the tag-only form later.

## 6. Decisions the owner must make

| # | Question | Recommendation | Cost of the other option |
|---|---|---|---|
| D1 | Rebase on v7? | No. Stay on lite. Take no v7 commit unless the brain stays (then 982ca0153, `pnpm-lock.yaml` hunk by hand); skip 281a31dd3 unless the seat card stays | A rebase collides with 467 cut crate files, adds migration 0077, changes Launcher bytecode (the 737 set no longer applies), brings Council |
| D2 | DELETE or HIDE? | DELETE in the app, server code stays for now | HIDE keeps bundle, tests and reading cost |
| D3 | Public or invited testers first? | Invited, 3 to 5 founders | Public first: support load and unfinished legal text exposed |
| D4 | `FEE_BPS=0` on the test network? | Yes, but run one zero-fee journey first (ASSUMED to work end to end) | 2% stays: one more sentence on the launch and back sheets |
| D5 | Raise goal | None in the MVP (section 5) | Tag-only goal later, about 230 lines |
| D6 | Drop the blocking recovery sheet at sign-up? | Yes, ask later from You. Needs counsel's view: a lost passkey with no key means lost money | Keeping it costs a screen and 55 words before any value |
| D7 | Avatars from any https site expose a viewer's address | Hide them (C7 removes pictures) | Needs a privacy-text line |
| D8 | `BUZZ_CHAIN_CONFIRMATIONS=2` on the test network | Yes | Default 12 is about 2.5 minutes of dead page after Launch |
| D9 | Phone accounts vendor | Buy, do not build; a small proxy only | Only wallet-browser users can back |
| D10 | Founder spending: how much of tasks and the rate field stays? | Keep the one change-rate row on the Money tab (default 0.10%, ceiling 0.20%), and keep the read-only holder side of tasks (planned strip, note claim). Cut all team-side task screens | Cutting both: a project draws about 3% of its pot a month, and a leaver cannot see or claim a task note |

## 7. Tenancy: a new server per community? microVMs?

**No to both for the MVP.** One server is one community, set by the host name, and Creaton needs no more: a project is a
contract on chain plus a record. Money sits in each project's own contract, so a bug between projects cannot move
funds. The server runs no foreign code (its only subprocess is `git`), so there is nothing for a microVM to contain,
and nothing in the repo supports them. Do now: one compose stack, one community; remove the dead multi-community code
and docs (C14). Keep the `community_id` columns (49 tables). A second community is possible only by raw SQL and would
get no chain numbers, helper or alerts (CHECKED). Later: if two independent operators each want their own keys, run a
second compose stack (about 300-400 MB RAM, ASSUMED); build microVMs only if the server starts running founder- or
agent-supplied code.

## 8. Risks, and the checklist

| Risk | Mitigation |
|---|---|
| Cutting C11 or C9 breaks Back or Take out | Money-path loops with `REQUIRE_CHAIN=1` after each; one commit per cut |
| A "green" browser run was a silent skip | `REQUIRE_CHAIN=1`; check the skipped count |
| First Docker build or Sepolia deploy surprises | Build once now (P0.4 on a big machine) and again after the cuts (P1.10); scratch host first |
| Counsel text is late | The long pole: send the facts in week 1 |
| Phone vendor is late | Launch is wallet-browser only: say so, or wait |
| Copy cut touches a legal sentence | `legal-words.ts` green at every commit; never allowlist around it |
| Cut makes the app look empty | Intended. Add back from `v6.5-full` after P3.3 |

**Checklist (owner ticks):**

- [ ] P0.1 flaky test fixed; P0.2 `pnpm check` green; P0.4 full gates run on a machine with room
- [ ] D1 to D10 answered
- [ ] Steps A to C cut, loops green; sign-up dead end fixed (P1.4)
- [ ] Step D cut, `pot-full-loop.sh` green with `REQUIRE_CHAIN=1`
- [ ] Journeys at target: visitor about 6 presses, founder about 5; copy at section 3 maximums, legal text unchanged
- [ ] Docker image built from the cut tree and started once
- [ ] Sepolia deploy, switches written down; bundler and sponsor working
- [ ] Terms and privacy finished by counsel, zero brackets
- [ ] Backup and restore rehearsed
- [ ] Real-phone test done by the owner; only then `buzz-review-completed`
- [ ] Invited testers in; one person on call

## After the MVP: pool depth (not in the MVP)

Read in the public docs of Mosh, Zora and Doppler (second-hand, not verified; their contract source was not read).
None of them is a base to build on: Mosh locks capital with no exit, Zora's hook is heavy per swap and states no audit,
Doppler's core is BUSL 1.1 and documents no tight range around a moving price. Reasons it stays out of the MVP: no
trading volume exists without a pool, trading is off by default, the treasury already gives an exit at the
leave-value, and the pool price is pinned to about 0.98 to 1.02 times the leave-value by Take out and Back, so a pool
adds convenience, not upside, while the door is open.

Order, later: (1) anyone may already create a plain Uniswap pool for a project's Shares, no hook; (2) when a project is
Established, link to it; (3) only if volume appears, a small hook of our own that adds fee-funded depth inside the
band and is recentred on the leave-value by a keeper (Zora's 20% of a 1% fee going to depth is the reference);
(4) simulate first with test-network Back and Take out flows. Depth is bounded by slippage below (about
`V >= 2*w*s/d`, w band width, s trade size, d slippage) and by liquidity-provider yield above; it scales with trading
volume, not project size. Fee income, not backers' money, should fund it, so the treasury stays fully takeable.
Counsel first: a pool is a secondary market.

## Corrections (after the critic's pass)

Changed, each CHECKED against the repository: the "host binding at `main.rs:1532-1540`" claim was wrong (those lines are
the deletion-lease reaper); the deployment-community setup is at `main.rs:551-590`. Sizes now separate source from tests
and the manager figure is 0.8k, not 5.2k. Bracketed items are 56 (terms) and 70 (privacy), not 50 and 56. The press
budgets are at `press-counter.ts:42-44`, not 49-56. knip runs from the repo root; chain-backed specs skip without
`REQUIRE_CHAIN=1`; the phone spec runs through `scripts/pot-app-phone-e2e.sh`. `LinkWallet.tsx` is now cut with C1
(only `YouPage` uses it); `use-wallets.ts` stays. Cuts are reordered so the tree builds (room before social; helpers
kept for tasks). Added: the Home, Profile and Post rewrite, the harness row (C16: anvil tests, `e2e-pot-full`,
`pot-full-loop.sh`, `mvp-gate.yml`), core-package orphans, the lockfile and Docker rebuild after the cuts, a note that
`MVP-V6-5.md` is replaced, the not-a-return sentence beside "worth Y", `TRY-IT.md` section 4.1 for the phone test, the
growth ceiling, the invisible team spending, the AI-work gap, D10. The raise goal is dropped (the critic's reasons hold).
The faucet fold-in is now "try a separate press first". The "no check-in" notice moved to "only if needed".

Not changed, and why: C14 does not touch `docker-compose.yml` (the dev stack uses it; a safe edit was not verified).
The tasks sizes under D10 are not measured. Contracts are untouched, as the instruction requires.
