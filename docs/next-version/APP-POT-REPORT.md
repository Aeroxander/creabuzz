# App on the pot contracts, pass A: the layer under the screens

Written 19 November 2026 on branch `v6`, by builder A of three on the app track, for the lead and for builders B and C. The
contracts are `contracts/pot` (not edited); the record is `docs/next-version/RECORD-V2.md` (not edited, still valid). Nothing
is pushed. This pass builds no new screen: it builds the ABIs, the record reader, the call builders and quotes, the words
for every refusal, the network config and the flag that puts the old design out of reach, and proves them on a real chain.
This is not legal or tax advice, and no figure here is a promise of any result for anyone.

## What was built

| # | Part | Where |
|---|---|---|
| 1 | The ABIs of the Treasury, Vester, Launcher, Pair, Share token and play dollar, read from forge's output by a committed generator; a test builds the contracts fresh and fails when the generated file differs (skipped with a plain message when `forge` is absent) | `scripts/pot-app-abi.mjs`, `packages/creaton-core/src/pot/abis.generated.ts`, `abi-fresh.test.mjs` |
| 2 | Record version 2 parser (strict), replacing version 1 in `numbers.ts`; the old parser lives on as `numbers-v1.ts` behind the flag | `app/src/features/money/numbers.ts`, `numbers-read.ts`, `numbers-types.ts` |
| 3 | The ONE build flag `VITE_CREATON_LEGACY_SCREENS=1` (off by default) and the gating of the old stage, round, auction, market, hand-back, receipts, earlier-backers and old Team screens | `app/src/lib/legacy.ts`, `app/src/legacy/*` |
| 4 | Call builders and quote readers for both senders, and plans that set the guard from the chain's own quote | `packages/creaton-core/src/pot/pot-calls.ts`, `pot-reads.ts`, `pot-plans.ts`, `abi-codec.ts`; `app/src/features/money/runner.ts` |
| 5 | A sentence for every custom error of the six ABIs, with a test that walks them all | `app/src/features/money/pot-copy.ts`, `pot-copy.test.ts` |
| 6 | The test-network config, from the build's environment or a deployments file | `packages/creaton-core/src/pot/network.ts`, `app/src/lib/pot-network.ts`, `app/src/lib/deployments-env.ts`, `app/vite.config.ts` |
| 7 | The old chain loop retired; a new one that drives the app's own builders on the real contracts | `scripts/pot-app-chain-loop.sh`, `app/tests/anvil/pot-loop.test.ts`, `pot-chain.ts`, `passkey-back.test.ts` |

Commits (all signed off, on `v6`): `73521d0fa` (ABIs, builders, quotes, network), `f89eb78cc` (the words), `5c3a02c70` (record
version 2, the flag, the pages, the weekly flow, tasks, the chain loops), `d21ad2571` (deployments file, Tasks tab loads late).

## Gates, as run

| Gate | Result |
|---|---|
| `tsc --noEmit` (app, including `tests/`) | clean |
| vitest (app) | 54 files, 346 tests passed, 0 failed (baseline before this work: 44 files, 280) |
| biome (app) | clean |
| `check:copy`, `check:px-text`, `check:file-sizes` (base `c30824c81`) | pass |
| core tests (`packages/creaton-core`, `node --test`, with forge on PATH) | 1,195 passed, 0 failed, 0 skipped (the fresh-ABI test builds `contracts/pot` sources in about 15 seconds); without forge the same run has 1 skipped, which says why |
| `node scripts/pot-app-abi.mjs --check` | current |
| fresh-ABI test is falsifiable | one function renamed in the generated file: the test failed with "differs from a fresh build"; the file was restored |
| knip (unused exports) | clean |
| `vite build` with `CREATON_DEPLOYMENTS_FILE` | builds; the launcher address from the file is in the built code; entry chunk 398 KB against the 450 KB budget (before: 427 KB) |
| `scripts/pot-app-chain-loop.sh` (real anvil, real `contracts/pot` bytecode) | 1 test passed: faucet, launch, Back in one signature and in two, Take out with its guard, check-in with a hash, door, raise that must wait, a draw, a Team grant claimed as it vests, a member's own exit with its notice, outside money, a Team take-out, each refusal read in the app's words |
| `scripts/phone-loop.sh` | 33 claims proven, including a Back from a passkey account on the real Treasury: one operation, one prompt, no approve step, minted exactly the quoted Shares, refusal read in the app's words, no network coin held |
| Playwright | not run: no browser is installed on this machine (see "Not done") |

## What builder B needs (the surface, by file)

**Calls** (`@creaton/core/pot/pot-calls.ts`): every builder returns `{to, data, value: "0x0"}`, the shape both senders take.
`backCalls({dollar, treasury, amount, minShares, to?, payAndCall})` (one `transferAndCall` with exactly 64 bytes of data, or
approve then join), `leaveCall`, `leaveTeamCall`, `checkInCall(treasury, hash)`, `pairCheckInCall(pair, hash)`, `drawCall`,
`setRateCall`, `proposeRateCall`, `applyRateCall`, `setDoorCall`, `grantTeamCall`, `authoriseAgentCall`, `setAgentCall`,
`revokeAgentCall`, `handOverCall`, `takeSeatCall`, `claimGrantCall`, `announceForfeitCall`, `executeForfeitCall`,
`addRevenueCalls` (approve then add), `collectFeesCall`, `faucetCall`, `launchCall`, `makePairCall`, `windDownCall`, and a Pair's
`pairProposeCall`, `pairConfirmCall`, `pairCancelCall`.
**Runner calls through a Pair**: `app/src/features/money/runner.ts` has `runnerRole(numbers, me)`, `asRunner(numbers, me, call)`
(straight for the runner, a proposal for one of a Pair's signers, null for anyone else) and `checkInFor`.

**Reads at the moment of a sheet** (`pot-reads.ts`, each takes the sender's `readCall`): `quoteBack`, `feeFor`, `doorOpenNow`,
`quoteTakeOut`, `teamValue`, `balanceOf`, `allowanceOf`, `grantIdsOf`, `claimableOf`, `vestedOf`, `dollarHasPayAndCall`. A bad
or short answer throws; a sheet says so and never falls back to the record.

**Plans** (`pot-plans.ts`): `planBack(read, {dollar, treasury, amount, to?, payAndCall?})` reads the quote, asks the dollar
whether it has pay-and-call (unless told), sets `minShares` from the quote and returns `{quote, minShares, calls, oneSignature}`
(null when the amount buys nothing); `planTakeOut` returns `{quote, minCash, call}` (null when the quote is zero);
`planTeamTakeOut` returns an estimate and a wider guard (null when the estimate is zero). Guards are 0.5% under the quote
(2% for Team Shares, which have no exact quote).

**The record** (`numbers.ts`): `parseNumbers(event, signer, project?)`; `ProjectNumbers` mirrors RECORD-V2.md section 2 field
for field (bigints for amounts, numbers for times). Helpers: `isRunner`, `signsForRunner`, `holdingHint` (a hint only; a cut
list says nothing about someone it does not list), `quietStateAt`, `freshnessOf` (fresh / as-of / stale by section 6),
`allowancePerDay`, `dollarsText`, `sharesText`, `dayText`, `timeText`, `DOLLAR`. Reads: `useProjectNumbers`,
`useRecentNumbers`, `matchNumbers` in `use-money.ts`. Test fixture: `tests/helpers/numbers-v2-fixture.ts` builds a record for a
project from the one example file (shifted in time, identity rewritten), `numbers-v2-parse.ts` reads the example itself.
Typed amounts: `parseDollarAmount(text, min)` in `calls.ts` takes the smallest from `numbers.limits.minJoin`.

**Words**: `potProblem(error, action)` (`pot-copy.ts`), `action` one of back, take-out, take-out-team, check-in, draw, rate, door,
grant, claim, forfeit, revenue, faucet, agent, seat, launch, link, wind-down, pair. The sender's own stops (no wallet, wrong
network, still waiting) read as they do everywhere (`money-copy.ts`). `MoneyNow.tsx` holds the play-money line and the
freshness words; `mustSayPlayMoney` (core) is the one rule for the play-money line; `OwnershipLine` is the legal line, word for word.

**Network**: `potNetwork()` (`app/src/lib/pot-network.ts`). Build with `CREATON_DEPLOYMENTS_FILE=contracts/pot/deployments/pot-31337.json`
or set `VITE_CREATON_CHAIN_ID`, `_LAUNCHER`, `_DOLLAR` (and `_RPC_URL`); a value set by hand wins over the file.

**What a screen of B's must still do**: take the numbers it shows in a sheet from the chain (`quote*`), say "play money" on
every money screen (`mustSayPlayMoney(numbers.playMoney)`), and use `freshnessOf` on lists and pages.

## What changed in the pages (moved to version 2, or behind the flag)

| Page | Now |
|---|---|
| Project | reads version 2. Without the flag: no stage line, no round, no auction, no market, no Pair card; the Money tab is `MoneyNow` (the project's money, "Numbers as of", the day-old line, the play-money line, the legal line). The Tasks tab loads when opened |
| Home | no "Open rounds" section without the flag |
| You | no backing receipts without the flag |
| This week | reads version 2 (`quiet`, `clock`); the update is signed and posted first, then the check-in carries that record's id; "Check in only" carries the newest weekly update's id, or 32 zero bytes when none is known |
| Tasks | Accept and pay draws from the allowance box (`draw`), only when the record's box holds the pay; otherwise the screen says how much the box holds and about how much goes in each day. A project run by a Pair says a draw needs both signers (the Pair path is not built). The agent form reads its default limits from `numbers.limits` and says Team Shares |
| `/earlier` | not a route without the flag |

With the flag off, a boundary test (`app/src/legacy/legacy-boundary.test.ts`) fails when a live file imports a legacy file, and
the live files reach `src/legacy/*` only through a lazy `import()` that `legacyScreensOn()` guards. Page tests check that none of
the old design's test ids is on the project page (flag off) and that Home has no rounds section (off) and has one (on).
`legacy-project.test.tsx` runs the old Open backing tests with the flag on.

## Chosen under the owner's standing go; the owner may overrule

1. **Guards.** Back's `minShares` and Take out's `minCash` are 0.5% under the chain's quote; a Team take-out's `minCash` is 2% under
   its estimate, and is never zero (a guard of zero would hide a payment of nothing). They are constants in `pot-plans.ts`.
2. **One signature or two is read from the dollar** (ERC-165 `supportsInterface` for ERC-1363), not from the record's
   `playMoney`; a dollar that does not answer gets approve then join.
3. **Check in only** (no new update) carries the newest weekly update's id, or 32 zero bytes, said plainly as "no record", when none is known.
4. **A Pair-run project's task payment** is not offered (it needs both signers; one press cannot do it). The screen says so.
5. **The old design's code stays in its feature folders** and is reached only through `src/legacy/*` glue; it was not moved. `numbers-v1.ts`,
   `calls-v1.ts`, `use-money-v1.ts` and `use-team-v1.ts` are the renamed originals.
6. **The parser is stricter than RECORD-V2.md says it must be** on cross-field facts that cannot be true together (a notice on a grant
   that is not announced, `claimable` not equal to `vested - claimed`, a Pair with no signers, money arriving with no end time,
   `wound_down` without a wind-down). A record that breaks one reads as "cannot read". Amounts must fit 2^128, times 2^40, lists their caps.
   `playMoney` is the one lenient field: missing or not `false` means play money (S7). `ledger` is never read.
7. **A build with no network config offers no money step** (`potNetwork()` is null); the passkey send list now also holds `VITE_CREATON_DOLLAR` (for the faucet).
8. **The Playwright specs of the old design are kept and skipped** unless the build and the run set `VITE_CREATON_LEGACY_SCREENS=1`
   (`tests/e2e/helpers/legacy-build.ts`). The mixed specs (`smoke`, `join`, `screens`) skip only their old-design parts; `a11y.spec.ts` is skipped whole.
9. **`packages/creaton-core/biome.json`** (a nested config) excludes the generated ABI file from the formatter, so it stays byte-for-byte what the generator writes.

## Found while building (for the lead)

- **`Treasury.join` does not read the zero address as "the payer"; `onTransferReceived` does.** A two-call Back with `to = 0` would be
  refused by the Shares token (`ZeroRecipient`). Not a defect in what the contract says (the report documents zero only for the one-call
  form), but a trap: `backCalls` now refuses an approve-then-join Back with no named receiver. The real-chain loop found it.
- **`contracts/pot/out` is git-ignored build output and was already built**; the fresh-ABI test builds into a throwaway folder (`$TMPDIR/creaton-pot-abi-check`) so it never touches the tree.
- **No spec change was needed**: RECORD-V2.md and its example are untouched and the example parses and passes all ten checks of section 7.3 in the app's tests.
- `packages/creaton-core`'s `biome check .` has one error that predates this work (`src/launchpad/evmAbiDecode.test.mjs` is not formatted); not touched.
- `scripts/phone-loop.sh` (not in this track) still tests for `contracts/next/out` only; `passkey-back.test.ts` now also needs `contracts/pot/out` built. `scripts/phone-e2e.sh` runs `phone-back.spec.ts`, which was removed with the old chain loop it needed: it must be re-based on the pot contracts.

## Not done

- **No new screen** (this was the layer under them): Back, Take out, the allowance page, grants, door and rate screens, the Pair's second signer for the new calls, launching on the new Launcher (the old `LaunchProject` is behind the flag; `launchCall` is ready), the "you back this" hint on Home. The Money tab is a placeholder (`MoneyNow`) for B to replace.
- **Playwright was not run** (no browser here). The specs that remain live (`smoke`, `join`, `screens`, `passkey`, `manager`) were edited only where they referred to the stage line, rounds or the Money tab; they typecheck but were not run. The real-browser phone Back is gone (above).
- **a11y of the new screens** is for the screens' builders; the old a11y spec is skipped without the legacy build.
- **Step 2** (task queue, notice, take, return, exit notes) is not started, as decided (L3).
- The server side (`crates/**`) is not touched.
