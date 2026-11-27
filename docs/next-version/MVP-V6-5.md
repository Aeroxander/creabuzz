# v6.5: the simple MVP line

> The line under "What the line is" (tasks and pay, a Pair) no longer holds on lite: `MVP-PLAN.md` replaces it.

Written 26 November 2026 on branch `v6.5`. It starts at `v6` (`4c36f73d6`) and takes only what a simple first trial needs from
`v7`. **The Council round (a Council that can hold the runner seat, seat elections, the replace vote, and their server and app
parts, about 38,000 lines in 193 files) is not on this line.** It stays on `v7` and `council-wip`, switched off by default
there, for after a first trial has shown that a project wants it. Nothing here is legal or tax advice.

## What the line is

`v6`'s money model as it stands (back a project, take your money out, the weekly check-in, tasks and pay, a Pair), run in play
dollars on a test network. No Council, no seat elections, no replace vote.

## What came across from `v7`

| v6.5 commit | From v7 | What |
|---|---|---|
| `162fc7012`, `1deb98a9f`, `365613225` | `461a7a65f`, `46217d8fd`, `f2c252c1d` | Test-lane fixes at their cause (backup encryption script, journal writer, env guard). No production change. |
| `f4c44f5c3` | `ac38226a0` | The unaudited line on the pot sheet; the deploy guide's missing steps (publish and check the code hashes, watch the helper's gas, key-leak runbooks, rollback, monitoring, settings in the example env file). Council parts left out. |
| `c408762f5` | `77614af82` | "Creaton's settings", not "the platform's". |
| `6de7bf8c4` | `7a162fd41` (adapted) | The weekly check-in press on the Money tab, for whoever runs the money: after a hand-over the new runner, and a Pair's second signer, had no check-in press anywhere. The Council seat path is removed. |
| `db509f975` | the uncommitted v7 work | Sign-up without a passkey offers the recovery key and says what it risks; short addresses in the words a payer reads; one shared `lib/short-address`; the check-in press refreshes the allowance and is a 44 px target. |

## What was left behind on purpose

- `5b5fad4c0`, `6d8829ed6`, `cc80ee66f` and the Council notes: Council only.
- `05016de73` (the copy pass): it mixes Council screens with general copy. The general parts (every bare money figure says
  "dollars", the vote line, "What you put in") are a candidate for a separate, small port.
- `281a31dd3` (a draw or grant is never asked of the runner twice): written for the Council's waiting calls; check whether a
  Pair needs it before porting.
- `3050370f3`'s 8 px gap on the project top: it only mattered once the copy pass made the money lines longer.
- `LAUNCH-READINESS.md`: it describes `v7`.

## Checks at this commit

`pnpm check` exits 0; `pnpm test` 230 files, 2,113 tests passed; `pnpm build` passes (entry chunk 391 KiB). The mock Playwright smoke (`pnpm test:e2e`): 73 passed, 90 skipped, 0 failed. The 90 skipped are the pot journeys, which
need a local chain build (`v6` and `v7` ran them that way); they have not been run on this line, so the money screens' press
budgets (phone 360, 44 px) are checked by unit tests only here.

## Still open (the same list `v6` and `v7` carry)

No person has used the app on a phone. Counsel's questions are unanswered. The contracts are unaudited. No Sepolia deploy has
been made, and the closed first cohort, the plan for the first 500 backers, and the answer to "why would a backer put real
money in" (`DIRECTION-REVIEW.md` C0, C9) are not done. The cheapest remaining protection for a backer who is not watching is a
"no check-in for N days" notice.
