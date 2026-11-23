# Council round: where it stopped

This branch is unfinished and unverified work. Do not deploy from it. The verified state is `v6` at `4c36f73d6`.

The round builds milestone 9 in the new model (a Council as a project's runner, seat elections, a replace vote, all off by
default), the brain reader's unpack bound and the brain's recorded-run skill. The plan is `docs/next-version/COUNCIL-PLAN.md`
(second draft, with both plan reviews worked in). It names the packages K1, K2, S1 and A1.

| Part | State |
|---|---|
| Plan, two reviews, corrected plan | done, committed |
| Brain reader: bound on what a download unpacks to | built and committed by its engineer; not independently verified |
| Brain: recorded-run skill (`buzz launchpad brain skill`) | built and committed by its engineer; not independently verified |
| K1: the Council contract and the Treasury's recognition of it | **finished**: `forge test` green, sizes in the gates (Treasury 24,153 of 24,576; Parts 173 spare), 73 mutations run and killed, the switch-off proof (golden digest, differential) green |
| K2: seat elections and the replace vote | **finished**: `HolderVote` is the pause (pause bytecode byte-identical), the count with the snapshot and the fall, both ballot kinds, the wait and carry-out, the deploy setting off by default; 37 mutation entries (35 killed, 2 proved equivalents); the attack table with the takeover dollars and a control; invariants and the event ledger |
| Contract attack and mutation pass, contract fixes | done: `HolderVoteAttacks.t.sol` (19, incl. the control), the 128-bit packing hole it found is fixed with a guard test, and every new guard's mutation is killed |
| S1: the server (reader, record fields, helper, alerts) | **finished and verified**: reader roles, record keys, ledger, helper jobs, candidacy family, alerts, migration 0077; generated tables/ABIs/fixtures and all three examples regenerated and field-checked against a fresh anvil replay (423 + 48 + 71 checks); unit lanes 266 passed, Postgres lane 66 passed, `buzz-db` migration tests 2 passed, clippy `-D warnings` and `cargo fmt --check` clean; the whole relay lib suite is 1,980 passed with one failure (`api::mesh_demo`, untouched here and recorded as a sandbox condition in the M5 and M8 reports) |
| A1: the app's screens, the joined-up loop, `COUNCIL-REPORT.md` | **screens done and green** (vote card, stand sheet, Council section, waiting list, hand-over, opener's line, Back-sheet line, alerts; `pnpm check`, 2,250 tests and the build pass; Playwright `pot-council.spec.ts` 7/7). The Council and replace-vote worlds in `pot-full-loop.sh` are built and pass (23 and 19 checks: `pot-council.spec`, `pot-replace.spec`); the passkey path is in the phone loop (`phone-loop.sh`, 59 claims), and the seat-holder runner presses beyond "Hand over the seat" are open. `COUNCIL-REPORT.md` is written |
| Four reviewers, two fixers, the full verification | **not started**: no independent verifier has run the plan's full check set; nothing from this branch goes to `v6` until one does |

To continue: run the server's Rust lane (`cargo fmt --all -- --check`, clippy on `buzz-relay` with `-D warnings`, the chain
reader/helper/web-push/handlers tests, and the Postgres lane), regenerate the third example with `UPDATE_EXAMPLE=1` and check all
three examples; wire the remaining seat-holder runner presses and the Council worlds in the two loop scripts; then an independent
verifier runs the plan's full check set. Nothing from this branch goes to `v6` until that verifier finds no blocker.

**Branch `v7` (23 November 2026) picks up from here** and finishes the "to continue" line above: the seat-holder runner
presses are wired (`5b5fad4c0`, every runner press a seat reaches sends the call `Council.listed` accepts, with the
never-ask-twice guard carried to the Council's waiting calls) **and reached in the app** (`7a162fd41`, the weekly check-in
press beside the runner's other presses — the This-week page lists only a person's own projects, so before this a seat or a
Pair's second signer could not check in at all), the Council worlds in the two loop scripts run by journey name
(`77614af82`: `scripts/pot-full-loop.sh pot-council.spec` and `pot-replace.spec` pick their world like `pot-pause.spec`
does, which the single-journey form never did before), and the council journey presses Check in and Draw from a seat through
the app and runs each to `Executed` (**27 checks green**). The unit lane's two pre-existing holes are fixed (`461a7a65f`), and
`docs/next-version/LAUNCH-READINESS.md` is the account of what is verified and what is still open — including the
independent verifier's pass, which is still owed. `v7` is the branch to test from; nothing here promotes this round to `v6`
on its own.
