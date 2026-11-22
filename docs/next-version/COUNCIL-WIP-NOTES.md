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
| K1: the Council contract and the Treasury's recognition of it | stopped part-way; the last commit on this branch is that unfinished work, as it stood. It may not build |
| K2: seat elections and the replace vote | not started |
| Contract attack and mutation pass, contract fixes | not started |
| S1: the server (reader, record fields, helper, alerts) | not started |
| A1: the app's screens, the joined-up loop, `COUNCIL-REPORT.md` | not started |
| Four reviewers, two fixers, the full verification | not started |

To continue: review K1's unfinished files against the plan's K1 section and finish them rather than starting over, then run
the remaining parts in the order above. Nothing from this branch goes to `v6` until an independent verifier has run the full
set of checks and found no blocker.
