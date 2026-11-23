# Launch readiness: v6 → v7

Written 23 November 2026 on branch `v7`, for the owner and the lead. This is the readiness check the objective asked for:
is the `v6` line ready to launch from, and what had to change. Branch `v7` starts at the council round's tip (`c6ac44811`,
the branch `council-wip`) and carries the fixes below. Nothing here is legal or tax advice; no real network and no real
money is involved anywhere in this document.

## 1. The verdict

**Ready for a testnet trial with invited testers, from `v7` — not from `v6`/`council-wip` as they stood.** Four things
said "no" before this round and all four are now closed or named:

1. **The Council round left the seat-holder runner presses open.** A Council that won its seat could only hand the seat
   over: Draw, the rate, the door, check-in, Grant Team Shares, planning/accepting/cancelling a task, the helpers,
   withdrawing an offer and Wind down showed nothing to a seat holder (the report's own "App gaps, stated"). For a
   deployment with `COUNCIL=1` that is a Council that cannot run the project it was elected to run. Fixed in `v7`
   (`5b5fad4c0`): every runner press a seat holder reaches sends the same call a founder sends, as a Council proposal,
   through the one door the contract accepts (`Council.listed`), and the pay-from-the-box press carries its
   never-ask-twice guard to the Council's waiting calls.
2. **The money screens never said the contracts are unaudited.** The repo's own rule (launchpad R4; the old web app's
   `UnauditedNotice`) was unimplemented in the new app. Now one line on every money sheet, before the press
   (`ac38226a0`), and the terms step says the operator's own text must carry it beside the published code hashes.
3. **The deploy path had no account of its own failure modes.** An independent audit of `DEPLOY-TEST-NETWORK.md` found
   no blocker in the steps themselves (every command, setting name and safe default checks out against the code) but
   eight gaps around them: no unaudited disclosure, no way to check or publish the code hashes the script prints, no
   watch on the helper's gas, no key-compromise runbook, no rollback story, settings the guide tells you to fill in
   missing from the template, no monitoring step, and a stale "zero hash" claim. All twelve findings (eight gaps, four
   nits) are closed in `v7` (`ac38226a0`).
4. **The weekly check-in — the press that keeps a project alive — was unreachable for whoever did not start it.** It
   lived only on This week, which lists only a person's own projects: after a hand-over (the seat features' whole
   point) the new runner, a Pair's second signer, and every Council seat had no check-in press anywhere in the app,
   and the Money tab sent them to a page with nothing on it. The press now sits beside the runner's other presses on
   the Money tab for whoever runs the money (`7a162fd41`), asking the Council's other seats when a seat presses it.

What is **still not ready for a public launch**, and was not in scope to fix here: the legal questions (the counsel
question lists in `PLAN-V2.md` section 10 and `COUNCIL-REPORT.md` section 5), an outside audit of the contracts, and a
person actually using the app on a phone (nobody has; every report says so). The testnet trial is play money and the
safe defaults keep it that way.

## 2. What the verification found

The full check set at the base (`c6ac44811`) and again after the changes:

| Lane | Result |
|---|---|
| Contracts: `forge test` (contracts/pot) | 1,065 passed / 110 suites, 0 failed (invariants and fuzz included) |
| Contracts: `scripts/pot-chain-loop.sh` | 24 checks passed — the whole join-and-leave loop against deployed bytecode, real receipt gas |
| App: `pnpm check` (biome, tsc, copy, px-text, file-sizes) | exits 0 |
| App: `pnpm test` (vitest) | 243 files, 2,257 passed at base → 2,261 after the changes |
| App: `pnpm build` | passes; entry chunk 393 KiB against the 450,000-byte budget |
| `web/` + `packages/creaton-core` | `pnpm check` exits 0; 3,502 + 1,292 tests passed |
| Rust: `cargo fmt --all -- --check`, `cargo clippy -p buzz-relay --all-targets -- -D warnings` | both clean |
| `just test-unit` (every infra-free lane) | green after `v7`'s test fix (below) |

**The unit lane had two pre-existing failures at the base**, both in `scripts/test-compose-backup-encryption.sh`, both
now fixed in `v7`:

- A docker stand-in that answered `image inspect` with failure broke the script's `start` checks the day
  `require_image_built` landed (`dedf4e97f`, 21 Nov: `run.sh start` with no built image is refused). The stand-in now
  answers as a machine where the image exists, with `IMAGE_MISSING=1` for the refusal case, which
  `deploy/compose/test-app-settings.sh` covers itself.
- The script's `RM_FAIL_DIR` simulation compared a raw path string against the one `backup.sh` normalizes
  (`cd "$dir" && pwd`), and a macOS `TMPDIR` with a trailing slash made the two differ by a doubled slash. The
  stand-in `rm` therefore never refused, so the container-removal path and its two failure checks never ran (they
  were silent holes until `age` was installed on this machine: at the base commit the script fails 5 checks with
  `age` present and skips its best half without it). The test normalizes its temp dir the way `backup.sh` does; all
  82 checks of the script now pass.

## 3. What `v7` changed on top of the council round

| Commit | What |
|---|---|
| `5b5fad4c0` | A Council seat sends every runner press through the Council (`runnerRole` gains the seat role; `asRunner` routes to `councilProposeCall` for a seat; the check-in too). The pay-from-the-box and plan presses never ask twice: `council/waiting-read.ts` keeps only proposals the Council's own record still holds (`proposals(id)`, `PROPOSAL_TTL`, the seat generation), so an old, taken-back, ran-out or generation-killed call may be proposed again and a live one never is. Every runner sheet says who must agree in the record's own numbers (`RunnerAskNote`). "Accept and pay" still accepts first and asks after, in words built from the threshold. |
| `05016de73` | The copy pass (14 findings, independently reviewed): every bare money figure says "dollars"; accounts are counted as accounts, never people; one thing keeps one name (the give-up line says "built up", the claim line says "unlocked", and they are two different lines in `Vester`); the vote's count line says how a choice wins in full; the fee is named (Creaton, from the brand constant); a candidate's words say "looking" / "could not be read" / "No text" only when the read is done; a waiting call the app cannot describe offers no agree press and says who to ask (a seat that already agreed can always take its agreement back — the one press that is never hidden); the stand sheet says why its press is greyed out; the Take out sheet says how long outside money keeps arriving (from the record's own clock); "What you put in", not "paid in"; the Council-unreadable line says what to do next. |
| `6d8829ed6` | One name for an account wherever it is named (Back sheet and vote card shared `namedAccount`; `pot/member-names.ts` holds the lookup). **A seat holder can give up their seat** (the contract's `resign`, from the seat's own account), with what it does said first: the seat comes up at the next vote, every waiting call stops and must be proposed again, nothing else changes. |
| `ac38226a0` | The launch-docs pass: the unaudited line on every money sheet (one sheet, one place, so no flow is left without it); the code hashes are a step (check each against the build, publish with the terms, a mismatch is a stopped launch); the helper's balance and failure counter are watched; a runbook per leaked key; the rollback story; a watching-the-server step; every setting the guide names is in `.env.creaton.example` with its default; `BUZZ_INVESTING`'s example line is `true`. |
| the next commit | The unit lane's two pre-existing failures, fixed at their cause (the docker stand-in and the path comparison). |

## 4. What a person on a real phone has not done, and what else is open

- **No person has used the app on a phone.** Every report says this and it stays true. The testnet trial is where that
  changes; `docs/next-version/TRY-IT.md` is the guide.
- **The seat presses' end-to-end run.** The Council world in `scripts/pot-full-loop.sh` now presses "Check in only"
  and "Draw from the box" from a seat through the app and runs each to `Executed` (`pot-council.spec.ts`); the run of
  that world on `v7` is the last proof and is recorded here when it lands.
- **The independent verifier's full pass over the council round** (`COUNCIL-WIP-NOTES.md`'s last row) is still the
  step that promotes the round to `v6`; this readiness check ran the check set but it is the same agent's run, not an
  independent one.
- **Counsel questions are unanswered**: `COUNCIL-REPORT.md` section 5 (C1–C10) and `PLAN-V2.md` section 10. The
  `COUNCIL=1` switch changes the legal line's premise and both settings need an answer before real money.
- **The contracts are unaudited** (now said on every money sheet). No mainnet, no real dollars until an outside audit
  and a legal posture exist — the repo's rule R4 and `PLAN-V2.md` section 10 both say so.
- The wider world outside this repo (`buzz-releases`, `sprout-oss`, the Terraform stacks) was not touched or checked
  here; a testnet trial on one operator's server does not need them.

## 5. The safe defaults, checked in the code

The deploy audit verified each claim by reading the enforcement, not the docs: the play dollar deploys only on chain
31337 and 11155111 (`PlayDollar.sol`); the platform fee ceiling is enforced in the Launcher's constructor; the unit is
7 days off a test network; `COUNCIL=1` refuses without `HOLDER_PAUSE=1` and both refuse outside the deployer's first
hour before any project launches; the earlier claim needs all six settings or none, and an oversized pool needs
`EARLIER_ALLOW_LARGE=1`; the helper cannot check in, take out, draw, claim or wind down (a test lists every call it
must never send) and its spend is capped a day. With every switch off, nothing about a deployment changes and no
screen shows anything new.
