# Phase 1 report (lite branch)

Start of the work: `3812ff4fa`. Plan: `MVP-PLAN.md`. The tag `v6.5-full` holds everything the cuts removed. Nothing was pushed
by this work. Money is play dollars on a test network; nothing here is legal or tax advice.

## 1. What was cut

One commit per plan row; the tree built and passed after each. Row ids are the plan's.

| Row | Commit | What |
|---|---|---|
| C1 | `1703c3da9` | Legacy-screens cluster (old stages, rounds, market, Team screens, v1 money files, `LinkWallet`) |
| C2 | `5448eca1e` | Earlier grants and the Established chip |
| C14 | `9e2a1d140` | Multi-community conformance suite and doc; dead script names |
| C15 | `67febbe8a` | Reports, econ scripts and design notes moved to `docs/archive/` |
| C3 | `e4a2ec120` | Seasons and the Ranked section on Home |
| C4 | `07f950d8c` | Project brain and the git library it carried (isomorphic-git, lightning-fs, patches) |
| C5 | `7645194fb` | AI manager panel on the weekly update |
| C6 | `82531639c` | Alerts, push, news on You, tab-bar badge |
| C10 | `f8b46a59e` | Holder room and the wallet-link box on Back |
| C7 | `142bb6078`, `2925008da`, `f8cca1607`, `8c3081a04`, `7342437b0`, `9765244c8` | Messages; Home as a plain newest-first list; search; posts, topics, saved, profiles, hiding, reporting, pictures; Share without a picture; words that named messages |
| P1.4 | `64585e08e` | Back while signed out goes to sign-up and returns to the same project and amount |
| C9 | `22d90c2d5` | Holder pause screens |
| C8 | `3c01c22e0` | Seat card (hand over, Pair, wind down) |
| C11 | `ff7b99d69` | Team side of tasks (the holder side that a Take out needs stays) |
| C16 | `cd5ed6898`, `fa49a7152` | Harness: one full-loop world; specs and guides no longer test cut features |
| P1.6 | `dcb6030ee` | Page top "You hold X, worth Y. Take out"; Get play dollars is one press |
| P1.7 | `936b05a87`, `645bc2f14`, `2019bd2e5` | Recovery key no longer blocks sign-up; Launch asks for nothing; one Start press survives sign-up |
| C12 | `c869affcc` | One money-copy module for the words, one for the refusals; one `Row`, one `NO_RECORD` |
| P1.8 | `a9aeeea5d`, `fb2d6f9c3`, `554404eba` | Copy pass to the plan's budgets; specs say what the pages say; the plan's copy table counted after |

Review round (this step), each a signed commit:

| Commit | What |
|---|---|
| `9a6b88b51` | A node's refusal keeps its error data (see 5, finding R2-1) |
| `b5f99d5ef` | Format two core test files the cuts left unformatted |
| `b49e80ba6` | Sign-up: no name needed, label "Your name", plain account only where it can send |
| `a5f37f8ae` | Back sheet carries the play-dollar press and a press that stays on screen; visitor's Money tab; focus after the last Take out; shut-door pointer; "Go back" label |
| `397d805e0` | Operator guides stop naming cut features; code comments point at `docs/archive/` |
| `16a23202b` | Phone spec launches a project from a passkey account |
| `6d68a217e`, `5655fba9d` | Founder budget back to 3 typed boxes; launch spec reads the shorter wait sentence; one import formatted |

Lines, `3812ff4fa..HEAD` (729 files; +3,370 / -89,201). By area, added / removed:

| Area | Added | Removed |
|---|---|---|
| `app/src` | 2,477 | 65,891 |
| `app/tests` | 500 | 12,917 |
| `packages/creaton-core/src` | 51 | 4,705 |
| `crates` (Rust, one deleted suite and comments) | 13 | 2,960 |
| scripts, deploy, CI | 71 | 1,648 |
| docs (moves to the archive count as renames) | 250 | 466 |
| other (lockfile, config) and `app` config | 8 | 614 |

This review round alone, `554404eba..HEAD`: 47 files, +366 / -150. App source files under `app/src`: 596 at the start, 235 now.
Migrations, `contracts/pot`, `Cargo.toml` and `Cargo.lock` have no diff.

## 2. What was verified, and how

Every run below is on the final tree unless said otherwise. Chain runs used `REQUIRE_CHAIN=1`, anvil and forge from the scratch
folder, Node 22.

| Check | Result |
|---|---|
| `cd app && pnpm check` (biome, tsc, copy, rem-only text, file sizes) | clean |
| `cd app && pnpm test` | 90 files, 754 tests, all pass |
| `cd app && pnpm build` and the bundle budget | ok; index 364 KiB, all scripts 845 KiB |
| `pnpm exec knip --no-progress` from the root | nothing listed |
| `packages/creaton-core` tests | 268 tests, 267 pass, 0 fail, 1 skipped |
| `cargo fmt --all --check`; `cargo build -p buzz-relay -p buzz-cli` | ok (the Rust edits since the cuts are comments only) |
| `scripts/check-cross-language.mjs` | 7 checks passed |
| `deploy/compose/test-app-settings.sh`, `scripts/test-compose-age-box.sh`, `test-compose-build-settings.sh`, `test-mvp-gate.sh` | all pass |
| `scripts/pot-app-loop.sh` | 11 tests passed, 0 failed, 0 skipped, in 10 files |
| `scripts/phone-loop.sh` | 42 claims proven |
| `scripts/pot-full-loop.sh` (relay built first) | 698 checks passed, one world, one journey |
| `scripts/pot-app-phone-e2e.sh` | 2 passed: faucet 1 press and 1 passkey prompt; Back 2 presses, 1 field, 1 prompt, 1 call in one operation; Take out 2 presses, 1 prompt; then a launch from the passkey account |
| Playwright `--project=smoke --workers=1`, build with `CREATON_DEPLOYMENTS_FILE` | 84 tests: 82 passed, 1 skipped by design, 1 failed. The failure was the launch spec reading the old wait sentence; fixed, and that spec file re-run: 6 passed |

The one skip is `pot-phone.spec.ts`, which needs the bundler, sponsor and phone build that `pot-app-phone-e2e.sh` starts; it ran there
and passed. The smoke project was run once in full before the spec fix; the files changed after it are `pot-launch.spec.ts`,
`press-counter.ts` (read only by that spec) and `pot-phone.spec.ts`, and the first and last were re-run.

Guards shown to fail without their fix (the fix put back by hand, the old code restored, the test run, the fix restored):
- `kernel033.ts` keeping `error.data`: the core test, the app test `launch-read.test.ts` and the phone spec's launch step all fail
  on the old file. The phone spec failed at its "launch read failed" assertion.
- Focus after the last Take out: `take-out.test.tsx` fails with the new effect in `HoldingTop.tsx` removed.

New tests not mutation-run (they assert things that did not exist before, so they cannot pass on the old code): no name needed to
sign up; no plain account on a passkey phone without a wallet, and offered again with one; the faucet press inside a short Back
sheet; no Your Shares card for a signed-out phone, and the card still shown with its sentence to a signed-in person; the Back
press inside a 360 by 640 screen (in `pot-back.spec.ts`).

## 3. Journeys, before and after

Before is the plan's hand-trace (plus or minus 15%) and the reviewers' counts on the tree at `554404eba`; after is what the specs
measure now. Words exclude legal text.

| Journey | Plan "now" | Plan target | At `554404eba` (reviewer's count) | Now |
|---|---|---|---|---|
| Visitor: link to first Back | 10 presses, 2 fields, 3 passkey prompts, about 900 words | about 6 presses, 2 fields, about 350 words | hosted 8 presses, 2 fields, 3 prompts; open server 6 | hosted 6 presses, open 4, 1 field, 3 prompts (counted from the flow, not run end to end: the first sheet now carries the faucet press) |
| Visitor: Back to Take out | 2 to 3 presses, about 230 words | 2 presses, about 100 words | 4 presses with the faucet, 76 words | 4 presses, 1 field, 76 words read (measured, `pot-takeout.spec.ts`); Back 2 presses, Take out 2 presses on their own |
| Founder: Start to launched | 9 presses, 4 fields, about 1,050 words | 5 presses, 3 fields, about 300 words | 5 presses open server (7 hosted, two ticks), 4 fields, about 190 words | 5 presses, 3 fields (measured, `pot-launch.spec.ts`, budget lowered back to 3); hosted adds the two ticks |

## 4. Copy counts

Counted by the plan's counter (jsdom, the example record, legal text out). Before is the tree at `2019bd2e5`, before the pass.

| Screen | Before | Max | After the pass |
|---|---|---|---|
| Launch card and sheet | 24 and 255 | 40 | 39 |
| Money tab, runner | 256 | 100 | 74 |
| Back sheet | 51 | 40 | 40 |
| Take out sheet | 58 | 25 | 17 |
| Project page, top (visitor, holder) | 176, 187 | 60 | 32, 43 (with the Lately feed 99, 110) |
| Sign-up | 82 | 30 | 30 |
| Start | 57 | 45 | 40 |
| This week | 45 | 50 | 45 |
| You | 25 | 40 | 25 |
| Faucet | 3 | 20 | 3 |

This round changed a few words and did not recount: sign-up label "Your name" (one word more) and one paragraph and button fewer on a
passkey phone; the short-money line on the Back sheet lost "Get play dollars first." and gained the faucet press; the wait line on the
Money tab lost two sentences. The reviewer's real-browser counts are higher than the jsdom counter because the counter leaves out
lists and history: You 103 after one Back and Take out, the whole project page 113 for a visitor. Those two are over the maximum
and are not trimmed.

## 5. The review round: what was found, what was done

Three reviewers reported. Text of each report was cut in what I was given (R1 after its state section, R2 after its finding 16, R3
after its F3), so findings past those points were not seen.

Done:
- **R2-1 (blocker): a passkey founder could never launch.** The chain client built its error from `error.message` and dropped
  `error.data`, so the Launcher's `UnknownProject` (data `0x6631410f`) was read as "the network could not be asked" and the Launch
  press never appeared. Fixed in `kernel033.ts`; guards above. Not caused by the cuts.
- R2-2 first Back sheet was a dead end: the faucet press now sits in the sheet when the money is short; R2-3 the press was below
  the fold at 360 by 640: it is sticky, and `pot-back.spec.ts` asserts it is on screen; R2-4 "Create without a passkey" trap: shown
  only with a wallet in the browser or when the device cannot make a passkey; R2-6 a signed-out phone's Money tab: no card;
  R2-7 shorter wait sentence on the founder's Money tab; R2-8 and R2-9 the sign-up name is optional and labelled "Your name" (the
  founder types 3 boxes); R2-10 focus after the last Take out goes to the page heading; R2-11 the header's Back is named "Go back".
- R1-I1 (a holder with a not-yet-connected wallet on a shut door): the shut-door line now says they can still take money out from the
  Money tab, where Connect is. The wrong-contracts line already said so. R1-3 the short-money line no longer ends in a dead end.
- R3-F1 operator guides: the "start seasons", room, alerts, AI helpers and wallet-link text is gone or one line ("skip"; steps keep
  their numbers). R3-F2 two format errors. R3-F3 pointers to archived reports.

Declined or left to the owner:
- **R2-5 Grant Team Shares is dead** (no screen writes the wallet link a grant needs, since `LinkWallet` and the Back checkbox went).
  True. Either cut the grant section (about 600 lines and its specs) or let the founder paste an address; both change what a team
  can be paid in, so it is the owner's. Not done.
- **R1-I2 no recovery-key prompt after a Back** (D6): left as decided; counsel was to see it before real money.
- R2-12 "Ask to join" weight, R2-13 the Unlock press before Start, R2-15 You page words, R1-4 to R1-6 (wallet-prompt counts on
  sheets, the parked-Shares sentence, an unreachable sentence): optional, and each adds or moves words against the steer.
- R3-F4 untracked scratch files breaking `pnpm check`: none were present when this step began.
- `docs/web-push-deployment.md` still describes push (server code stays by D2). `contracts/pot` READMEs and comments name
  `docs/next-version/POT-STEP*-REPORT.md`; contracts are never edited. `WeeklySheet.test.tsx` names a report by file name only.

## 6. Where the plan was wrong

- C11 says keep the "take gate" and D10 says the gate is the worker's side of a task and goes; they disagree. The work followed D10.
  It does not touch Take out.
- The plan called wallet links moot once the room was cut. Grants need them (R2-5).
- `team/team-copy.ts` did not exist after C1; two modules the C12 row did not name were part of the overlap. Five copy modules became
  two, not one, because the table of refusals alone is about 330 lines and the file-size gate is 600.
- The plan's journey table said the first Back needs about 6 presses; the tree at `554404eba` needed 8 hosted, because the faucet was
  behind the sheet. The 5-press founder target was met only with a wallet and the plain account; with a passkey it is 7 hosted.
- The plan's 2,113 app tests predate the cuts; 754 pass now (about 1,360 tests went with the features they guarded).
- The plan says the phone path signs up, backs and launches; the phone spec never launched, which is why R2-1 was not seen.
- The plan's word counts are jsdom counts; real screens are longer (section 4).

## 7. Chosen under the owner's standing go; the owner may overrule

D1 to D10 as the plan recommends. And, in this step:
1. Sign-up name optional, label "Your name"; a blank name saves nothing.
2. The plain account is hidden on a phone that makes passkeys and has no wallet. If the device cannot make a passkey it still shows.
3. The Back sheet shows the faucet press itself when short, and the page keeps its own faucet card.
4. The sheet's press is sticky at the bottom of any sheet (a solid colour behind it, in `app.css`).
5. A signed-out phone gets no Your Shares card.
6. The founder's wait sentence is shortened, not replaced by a Share press.
7. The shut-door line gets the Money-tab sentence instead of a connect prompt for every visitor.
8. "Go back" is the accessible name of the header's back press; the visible word stays.
9. Operator guide steps 6 and 9 stay as one-line "skip" so later step numbers and links hold.
10. Grant Team Shares left as it is until the owner chooses (R2-5).
11. The phone spec presses Unlock before Start, as a person must after a reload.

## 8. What stays open

- **P1.9** `BUZZ_CHAIN_CONFIRMATIONS` for the test network (a new project waits about 2.5 minutes at 12 blocks): the owner's setting.
- **P1.10** Docker image build after the cuts and `deploy/compose/run.sh` on a scratch host. No daemon here. The Dockerfile's app stage
  was run by a reviewer with the build step stubbed (exit 0, with and without the chain settings).
- **P1.11** The human test, and `buzz-review-completed` only after it (AGENTS.md).
- **C13** Server and CLI cleanup (relay task, room, wallet-binding, manager, push handlers; `docs/web-push-deployment.md`).
- Owner decisions: Grant Team Shares (R2-5); the recovery key after a first Back (R1-I2); whether the Lately feed (64 words) stays;
  the You page and whole project page over their maximums; the Unlock press before Start.

## 9. The checks the owner runs

1. `cd app && pnpm check && pnpm test && pnpm build`, then `pnpm exec knip --no-progress` from the repo root.
2. With anvil and forge on the path and `REQUIRE_CHAIN=1`: `scripts/pot-app-loop.sh`, `scripts/phone-loop.sh`,
   `scripts/pot-app-phone-e2e.sh`, then (after `cargo build -p buzz-relay -p buzz-cli`) `scripts/pot-full-loop.sh`.
3. On a real phone, `TRY-IT.md` part 4.1: sign up with a passkey, open a project link, Back with too little money and press the faucet
   inside the sheet, Back, Take out, then Start and Launch a project. Look for: the sheet's press visible on a small screen; Unlock
   once after a reload; a wallet browser on a project with a shut door.
4. The Docker build and a compose start (P1.10).
5. Decide the four owner points in section 8.
