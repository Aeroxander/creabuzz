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
| 7 | The old chain loop retired; a new one that drives the app's own builders on the real contracts | `scripts/pot-app-loop.sh`, `app/tests/anvil/pot-loop.test.ts`, `pot-chain.ts`, `passkey-back.test.ts` |

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
| `scripts/pot-app-loop.sh` (real anvil, real `contracts/pot` bytecode) | 1 test passed: faucet, launch, Back in one signature and in two, Take out with its guard, check-in with a hash, door, raise that must wait, a draw, a Team grant claimed as it vests, a member's own exit with its notice, outside money, a Team take-out, each refusal read in the app's words |
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

---

# Pass B: the screens

Written 19 November 2026 on branch `v6` by builder B of three on the app track. Pass A (above) built the layer under the screens; this
pass builds the screens on it. Nothing is pushed. The contracts (`contracts/pot`), the record specification and `crates/**` are not
touched. This is not legal or tax advice, and no figure here is a promise of any result for anyone.

## What was built

All new screens live in `app/src/features/pot/`. Every one is phone-first, says the dollars are play money, and carries the legal line word for word
where money moves.

| # | Screen | Files | What it does |
|---|---|---|---|
| 1 | Project page (the Money tab) | `ProjectMoney.tsx`, `MoneyFacts.tsx` | The project's money; what one Share gives if taken out now with "This can go up or down. It is not a return."; the daily allowance in words; the Team's part; where it stands (open, quiet, dormant, can be wound down, wound down) and what that means for a person; the record's age ("Numbers as of", or a stale card that pauses Back and leaves Take out open). Replaces the placeholder `MoneyNow.tsx` (deleted). |
| 2 | Back sheet | `BackCard.tsx`, `BackSheet.tsx`, `back-read.ts` | An amount and one button (two presses in all). The sheet reads the chain when it opens and shows what you pay, the fee to the platform, the Shares you get and what taking out right now would give; the minimum-Shares guard comes from that same quote; the calls sent are the ones the sheet was made from. One signature when the dollar can pay and call, two when it cannot (said in words, passkey wording too). A shut door (record or chain), an amount under the smallest, an amount that buys nothing, too few play dollars and an unreadable price each say what to do. After it lands the page shows the new Shares. |
| 3 | Take out sheet | `TakeOutSheet.tsx`, `takeout-read.ts` | One press, one signature: all, half or a quarter of what is held. Shows the cash now, what is kept, outside money still arriving (not paid now) and any note; the minimum-cash guard comes from the chain's quote. Open whatever the door, the allowance or the project's state. Team Shares have their own sheet that says it is an estimate and that they pay only money above what backers put in. |
| 4 | Your Shares | `YourShares.tsx`, `YourSharesList.tsx`, `FaucetCard.tsx`, `own-history.ts` | On the project: Shares held, what taking out gives now (chain), what this browser paid in, play dollars held, a Take out button while Shares are held, a "Get play dollars" sheet (faucet, once per account) and the account's own Backs and Take outs. On You (replaces the old receipts): every project whose record lists the account, with the chain's figures, and the history across projects. |
| 5 | Allowance (runner and a Pair's signers) | `AllowanceSection.tsx`, `AllowanceSheets.tsx` | The box, its limit, the rate, the ceiling, an announced raise with its date, the weekly check-in's state and what happens if it lapses (dated). Sheets: draw to an address, change the rate (lower at once, or announce a raise), apply an announced raise (only after the wait), open or close the door. |
| 6 | Team Shares | `TeamSharesSection.tsx`, `GrantSheet.tsx`, `MyGrants.tsx` | The runner grants from the pool to a team member who linked a wallet (each grant on its own clock, said in words with the dates); a member sees their grants (granted, unlocked, claimable, dates), claims, and can give up what has not unlocked (says what is kept and what is removed after the notice), and finishes it after the notice. Says everywhere that Team Shares claim only the project's money above what backers put in. |
| 7 | Pair confirm sheet | `pair-terms.ts`, `use-pair-waiting.ts`, `PairWaiting.tsx` | The waiting calls are read from the Pair's own log and chain state. Each is said in a sentence naming what happens, to whom (name and full address) and how much: draw, rate (lower, raise, apply), grant (with its clock), door, hand over, wind down, forfeit, and the helper calls. Confirming sends exactly the target, data and number proposed. A call to anywhere but this project's contracts, or one with no sentence, is shown as unknown, cannot be confirmed from here, and can be withdrawn by whoever asked. |
| 8 | Tasks | `app/src/features/tasks/*` (pass A) | Accept and pay draws from the box and is offered only when the box holds enough; otherwise it says how much the box holds and how much goes in each day. The paid journal and its recovery are unchanged. For a project run by two it now points to the Money tab's draw (which the second signer confirms). |

The shared pieces: `PotSheet.tsx` (the one sheet every press goes through), `use-pot.tsx` (`WalletGate`: no wallet, connect, wrong network, build
without a network), `pot-words.ts` (every figure and sentence that is a function of numbers), `runner-calls.ts`, `target.ts`,
`ChainOnlyShares.tsx` (Take out when the record cannot be read: the contracts are read from the Launcher by the chain key).

## How the rules held

- **The numbers on a sheet are the numbers in the call.** Each sheet's read returns the displayed figures and the calls together; the press sends those calls. Tests decode the calldata of each press and compare it with what the sheet showed (Back one-call and two-call, Take out all and half, Team take-out, draw, rate, door, grant, claim, exit, Pair propose and confirm).
- **Numbers come from the chain at that moment, never from the record** on a sheet that moves money. The page itself shows the record, with its age. One exception, said plainly below: the allowance box.
- **A double press sends once.** The press is off while a step runs, and a second press while it runs does nothing; a step that went out and has not landed is looked up (not sent again) and the sheet says so.
- **A failed send** shows what happened in plain words, sends nothing, and leaves the same press to try again. Every refusal text is pass A's `potProblem`.
- **A send that may have landed** is checked on the chain first: a call replaced in the wallet is checked by the Shares held now (Back, Take out).
- **The account the numbers were read for is the account that sends.** A press is refused if the wallet now shows another account. In one call the Shares go to whoever pays.
- **Accessibility.** One owner per label, labelled fields and buttons, regions with headings, radio groups with legends, native `details` for "Details", sheets are labelled dialogs; Escape closes and focus returns (see the shared-sheet fix below). axe runs on every screen and every open sheet with no serious or critical finding (colour contrast and layout are for a real browser); a deliberately nameless button proves the check can fail.
- **Words.** `check:copy` passes; sizes are rem tokens; no protocol word, event name or contract name reaches a person.

## Gates, as run

| Gate | Result |
|---|---|
| `tsc --noEmit` (app, including `tests/`) | clean |
| vitest (app) | 66 files, 472 tests passed, 0 failed (pass A left it at 54 files, 346) |
| biome (app `src`, `tests`), `check:copy`, `check:px-text`, `check:file-sizes` (base `68309b077`), knip | clean |
| core tests (`node --test`, forge on PATH, including the fresh-ABI test) | 1,204 passed, 0 failed, 0 skipped (pass A left 1,195) |
| `vite build` with `CREATON_DEPLOYMENTS_FILE=contracts/pot/deployments/pot-31337.json`, then `check-bundle-size` | builds; entry chunk 389 KiB against the 450 KB budget. The Money tab is a lazy chunk (41 KB) so the contract ABIs stay out of the first download |
| `scripts/pot-app-loop.sh` (real anvil, real `contracts/pot` bytecode) | 2 files, 2 tests passed: pass A's 20-step loop and the new `pot-screens.test.ts` (below) |
| Playwright | not run: no browser is installed on this machine |

`app/tests/anvil/pot-screens.test.ts` runs, on the real contracts, the Back sheet's own reader and plan (fee, door, quote, one signature, Shares equal to the
quote), the Take out sheet's reader (half, cash at least the guard), the allowance state against the Treasury's own views, a grant and what a member
keeps on an exit, a project's parts from the Launcher (and an unknown key refused), the faucet's use and amount, and a Pair's whole round: the founder
offers the seat, the second signer makes the Pair, the founder proposes a draw, the waiting call is read from the Pair's log and said in words, the second signer
confirms exactly it, and it is no longer waiting after it ran.

## Chosen under the owner's standing go; the owner may overrule

1. **Take out is all, half or a quarter** of what is held (three choices), not a typed amount. The press stays one tap.
2. **"What was paid in" and the history are kept in this browser**, per account, for the account's own steps only (nothing about anyone else). They are labelled "from this browser" / "Kept in this browser". A reading of the chain's own logs (which would also show steps made elsewhere) is not built: it needs the project's launch block, which neither the record nor the Launcher gives.
3. **The allowance box is said as the larger of the Treasury's stored box and the record's**, with "about". The Treasury keeps the box as of its last settle and has no view that returns the settled value (RECORD-V2 section 9, item 1), so on a quiet project its `box()` reads 0 while a draw would settle first and pay. The record works the box forward to its own time. The chain still decides when a draw is sent.
4. **A grant goes to a team member who linked a wallet** (the existing wallet link), chosen from a list; there is no free address field for a grant. A draw goes to a typed address.
5. **A member's own exit says what the contract does**: they keep everything built up so far (no first-unlock wait), and the rest is removed after the notice. (The design draft said "vested part plus a pro-rata part"; the built Vester's own-exit keeps the accrued amount.)
6. **The Back form is hidden when the record says the door is shut**, with the reason; the chain is asked at the sheet when the record says open. A project whose record is stale shows no Back (it says why) and leaves Take out open.
7. **The runner's allowance screen is gone for a wound-down project** (it has nothing to run; the box went back to the pot).
8. **The Money tab and You's Shares list load when opened** (lazy), to keep the first download under budget.
9. **The shared sheet gives focus back** to what opened it (`app/src/ui/sheet.tsx`). Radix returns focus only to its own trigger, and these sheets are opened from state, so focus was lost to the page. This also fixes every older sheet.
10. **A rate is typed as a percent a day** ("0.10"); a lower rate is set at once, a higher one announced (the sheet says which it will be).
11. **Test ids** of the new Back box are `backing-box`, `backing-amount`, `backing-review` so the old design's ids stay unique to it.

## Found while building (for the lead)

- **Contract/record limitation, not a bug in either:** `Treasury.box()` (and `pot()`, `arriving()`, `activeSeconds()`) are as of the last settle. Pass A's draw check and the allowance screen would have read an empty box on a quiet project. The screens now say the larger of the chain's and the record's figure (choice 3). A `snapshot()` view would remove the need (RECORD-V2 section 9, item 1).
- **Radix does not return focus for a sheet with no trigger.** Fixed in the shared sheet (choice 9).
- **History note:** the first commit of this pass (`a4988fa99`) also carries the deletion of `MoneyNow.tsx`, which the project page still imported until the second commit (`f003e5aab`). That one commit does not build alone; the pair does.
- **A pending step leaks between tests** through `pending-sends.ts`'s page memory, which `localStorage.clear()` does not reach; a test that leaves a step pending forgets it by its key.
- **Passkey sender and sheets.** The sheets use the same `useMoneySend` as every other money press, so the passkey sender is reached through it; the Back details say "Your passkey is asked once" for it. This is covered by pass A's phone loop for the calls, not by a browser run of these screens.

## Not done

- **Playwright was not run** (no browser here), and no new Playwright spec was written for the new screens. Their states are covered by the vitest files above, which render the real components against a stand-in wallet that decodes every call with the generated ABIs.
- **Screens that propose or take the other money calls:** hand over, take the seat, wind down (by the runner or by anyone after a long quiet) and launching a project on the new Launcher have no screen. The second signer's sheet already says every one of them in words, and `launchCall`, `handOverCall`, `takeSeatCall`, `windDownCall` and `makePairCall` are built and tested.
- **A task payment from a project run by two** is not one press (a draw needs both signers). The Tasks screen points to the Money tab's draw; accepting such a task without paying is not offered when it has a payee.
- **The "you back this" hint on Home** is not built.
- **Chain-log history** of an account's steps (choice 2).
- Step 2 (task queue, notice, take, return, exit notes) and `crates/**` are untouched.

## What builder C must exercise

On a local relay and a local chain, in a real browser, with the injected wallet and with the passkey account:

1. **The 30-second stranger test** from the design (section 2.8): open a project page signed out, find Back, read the sheet, press. Then Take out on a second visit. Read both sheets aloud: every figure on them should be explainable from the page.
2. **Back, both senders.** Wallet: one signature on play dollars; with a dollar that cannot pay and call, two. Passkey account: one prompt, no approve step, Shares equal to the quote. Press twice quickly: one call. Reject in the wallet: the words, then press again. Close the wallet's window mid-send, reopen the sheet: "Look for your backing".
3. **Take out in every state**: door shut (founder closed it), quiet (let the check-in lapse on a short time unit), dormant, can be wound down, wound down, and a stale record (stop the server). Zero Shares. Outside money still arriving (add outside money, then Take out): the sheet says that part stays.
4. **The record cannot be read**: stop the server, open a project you hold Shares in: Take out must still work from the Launcher.
5. **Allowance**: draw (more than the box is refused in words), lower the rate, announce a raise and try to apply it early (refused with its date), apply after the wait, close and open the door, and let the check-in lapse: the dates on the screen should match. Note the box on a project nobody has touched for a while (choice 3).
6. **Team Shares**: grant to a member who linked a wallet and to one who did not; as the member see the grant, claim after the first unlock, announce the exit and finish it after the notice; as a stranger see none of it. Team Shares take-out of an estimate that is nothing.
7. **A Pair**: a signer asks for a draw, a grant, a rate change, the door; the other signer sees each sentence with the right names and numbers and confirms; withdraw one; a call from a stranger's contract must show as unknown with no confirm.
8. **Focus and keyboard**: open each sheet from the keyboard, Escape closes it and focus is back on the button that opened it; Tab stays inside the sheet.
9. **You** lists the held project with the chain's figures and shows the history after a Back and a Take out; reload and check the history is still there (and gone in a private window, said as "kept in this browser").
10. **Phone width** (360 px) and large text: nothing is cut off or has to be scrolled sideways.
11. Specs to re-base: `scripts/phone-e2e.sh` (runs the retired `phone-back.spec.ts`) and `scripts/phone-loop.sh` (checks `contracts/next/out` only), as pass A noted.

---

# Pass C: the proof (a real chain, a real browser)

Written 19 November 2026 on branch `v6`, by builder C of three on the app track. Nothing is pushed. This pass adds no screen. It
proves passes A and B on a real local chain and in a real browser, fixes what the browser showed, and measures the presses and
signatures. **No person has tested this**: every run below was made by an agent. A person's own test is still to be done (the
steps are at the end). This is not legal or tax advice, and no figure is a promise of any result for anyone.

A browser was available this time (Playwright's Chromium 153 at `/opt/pw-browsers`), so the Playwright specs of passes A and B
that were never run, and the new ones, were run.

## What was built (commits `dff0ce257`, `3eda658d2`, `683522672`)

| # | Part | Where |
|---|---|---|
| 1 | The chain harness is now `scripts/pot-app-loop.sh` (renamed from `pot-app-chain-loop.sh`; `m7-chain-loop.sh` was already gone). It runs four harness files on a throwaway anvil and prints one count line | `scripts/pot-app-loop.sh` |
| 2 | New harness file: Take out with the door shut by the team, after the team stopped checking in (2 units), with outside money arriving, after a wind-down by anyone (26 quiet units) and by the runner; a Back refused in words in each; a second wind-down and a check-in after a wind-down refused; a Pair call refused for its own proposer and for a second confirm | `app/tests/anvil/pot-states.test.ts` |
| 3 | Browser specs that start their own anvil, deploy the pot contracts in the deploy script's order (same addresses every time, so the one build works) and launch a project with the app's own call builders | `app/tests/e2e/helpers/live-chain.ts`, `live-browser.ts`, `pot-*.spec.ts` |
| 4 | A wallet in the page that forwards every call to the real anvil through the harness provider (no key in any file), counts each prompt, can say no, can be slow | `app/tests/e2e/helpers/live-browser.ts` |
| 5 | The server's record for a project, made from the real chain: every figure read from the Treasury, Vester and token views, the settled money worked forward by RECORD-V2 section 3, the totals summed from the Treasury's events, the quiet times from the check-in | `app/tests/e2e/helpers/live-record.ts` |
| 6 | The passkey path in a real browser (virtual authenticator, EntryPoint v0.7, the Kernel stack, a stand-in bundler and sponsor at two addresses) re-based on the pot contracts | `scripts/pot-app-phone-e2e.sh`, `app/playwright.pot-phone.config.ts`, `app/tests/e2e/pot-phone.spec.ts` |
| 7 | One fix the browser found: a sheet's parts shrank under long text (the press was 32 px high at 360 px with larger text) and its close button was 40 px | `app/src/ui/sheet.tsx` |

The record in item 5 stands in for the server's chain reader (the server track proves that reader on its own with
`scripts/chain-loop-pot.sh`). The page under test sees a record signed by the "server" key and cannot tell the difference, but the
reader itself is not exercised by these specs. The record example file is unchanged; `RECORD-V2.md` was not touched by this pass
(it shows as modified in the tree: that is another engineer's change).

## How it was proven

| Run | Result |
|---|---|
| `scripts/pot-app-loop.sh` (real anvil, real `contracts/pot` bytecode) | **6 tests passed, 0 failed, 0 skipped, in 4 files**: `pot-loop` (1), `pot-screens` (1), `pot-states` (3), `passkey-back` (1) |
| Playwright `--project=smoke --trace off` (the build made with `CREATON_DEPLOYMENTS_FILE=../contracts/pot/deployments/pot-31337.json`) | **45 passed, 0 failed, 59 skipped** (the skipped are the old design's specs, which need the legacy flag, and the passkey spec of the phone script). Before this pass the same project gave 14 passed, 58 skipped. Of the 45, 30 are new `pot-*.spec.ts` tests |
| `scripts/pot-app-phone-e2e.sh` (passkey, real browser) | **1 passed** (faucet, Back and Take out from a passkey account) |
| app `tsc --noEmit` (including `tests/`) | clean |
| app vitest | **66 files, 472 tests passed, 0 failed** (the same as pass B) |
| biome (app `src`, `tests`, configs), `check:copy`, `check:px-text` | clean |
| `check:file-sizes` (`CHECK_FILE_SIZES_BASE=68309b077`, there is no `origin/main` here) | clean |
| `pnpm build` with the deployments file, then the bundle-size check | ok; entry chunk 389 KiB against the 450 KB budget |
| repository `knip` | clean |

The new browser tests, by file (each starts its own anvil; a project per test):

- `pot-back.spec.ts` (5): Back with the wallet; a second backer; a wallet that says no and then yes; a double press; an amount under the
  smallest and more than the person holds.
- `pot-takeout.spec.ts` (11): Take out all; half then a quarter; the project open, the door closed by the team, quiet, dormant, open to
  a wind-down, wound down (the page's word for the state is checked each time, and what the Back box says instead of a form); outside
  money arriving; no Shares; the server's numbers unreadable (Take out from the Launcher).
- `pot-states.spec.ts` (5): a record two days old (figures gone, Back paused, Take out works), one a few hours old ("Numbers as of"), a
  server that cannot be read then comes back ("Try again"), a project the server has not read yet, and the play-money notice on the
  Money tab, the faucet, Back, draw, rate and door sheets, the Take out sheet and You.
- `pot-stranger.spec.ts` (3): a browser with no wallet reads the money, the risk line and the legal line; a wallet with no play dollars
  reads the faucet sheet and the Back sheet and sends nothing; the whole first visit.
- `pot-a11y.spec.ts` (3): axe, colour contrast included, on the Money tab (holder and runner), the Back sheet (also with Details
  open), the Take out sheet, the faucet, the draw, rate and door sheets, and a quiet project with an old record: no serious or critical
  violation. Tab and Shift+Tab stay inside the Take out and Back sheets, Escape closes them, focus returns to the button that opened
  them (opened with the keyboard).
- `pot-layout.spec.ts` (3): at 390 wide, at 360 wide with text 125% larger, and at 1280 wide: the Money tab, the Back, Take out, draw, rate
  and door sheets and You do not scroll sideways, every press inside them is at least 44 px, and each sheet's press is on the screen.
  Screenshots are written to `app/test-results/pot-screens/` (ignored by git) and were looked at.
- `pot-phone.spec.ts` (1, run by the phone script): sign up with a passkey, faucet, Back, Take out.

What a quote means on a live chain (a note for anyone reading the tests): the price moves a little every second because the allowance
flows out of the pot, so what lands is the quote read a moment before to within the guard the sheet sends (0.5%), never below it. The
tests say exactly that (`>= 99.5%` and `<= 100.5%` of the quote); for the first backer, whose price cannot move, they say `equal`.

## Presses and signatures, measured

"Press" is a tap on a button, "field" a box typed in, "signature" one prompt to the person (a wallet prompt, or a passkey prompt). Counted by
the repo's `PressCounter` on the real screens, from the project's Money tab, with the wallet already connected.

| Step | Presses | Fields | Wallet: signatures | Passkey account: signatures | The plan's budget |
|---|---|---|---|---|---|
| Back (a play-dollar Back is one call) | 2 (Back, then the sheet's press) | 1 (the amount) | 1 | 1 | 2 presses, 1 field |
| Back where the dollar cannot pay and call (approve, then join) | 2 | 1 | 2 (not run in a browser: the play dollar always can; the two calls are proven in the harness) | 1 (both calls in one operation; not run) | |
| Take out (all, the sheet's default) | 2 (Take out, then the sheet's press) | 0 | 1 | 1 | 2 presses |
| Get play dollars (the test network's faucet, once) | 2 | 0 | 1 | 1 | none |
| Back then Take out, the "30-second stranger" path | 4 | 1 | 2 | 2 | about 28 s by the repo's reading estimate (85 words read) |
| The whole first visit of a wallet with no play dollars | 6 | 1 | 3 | 3 | about 39 s by the same estimate |

The design says "Take out is one press and one signature". The measured press is one signature, but two presses: the button on the page
opens the sheet (which shows the cash and the guard) and the sheet's press sends. That is the same count the plan's budget
(`takeMoneyBack`: 2 presses) allows, and the sheet is where the person reads what they will get, so I did not remove it. If the owner
wants a literal one press, the sheet would have to go.

A wallet that is not yet connected adds one press (Connect your wallet) and one wallet prompt to the first step; that was not measured
in a browser here (the unit tests of the gate cover it).

## Found while proving it (fixed or for the lead)

1. **Fixed:** a sheet is a scrolling column, so its children were squeezed when the text was long: at 360 px with 125% text the sheet's
   press was 32 px high (under a 44 px target) and its close button was 40 px. `app/src/ui/sheet.tsx` now keeps the parts at their size
   and makes the close button 44 px. This also fixes the older sheets.
2. **Not fixed (not on a money screen):** the pages' own chrome is 40 px high: the project page's Back, Follow and tab strip, You's Edit,
   Link this wallet and tab strip. The layout spec leaves them out and says so. A small global change to the small button would fix them.
3. On a test chain the time unit is 28 minutes, so the sentences "If it has not checked in again by 19 Nov 2026" and "The team checked in on
   19 Nov 2026" show the same day. On the real network a unit is a week. Not a defect; a person trying this on a local chain will see it.
4. The Back sheet says "You hold 0.00 play dollars" for an account with none (other places say "0"). Harmless.
5. `passkey.spec.ts` (old, in the smoke project) failed once in the first full run, with the machine busy (the unlock bar did not show
   after a reload), and passed alone and in the last full run. I take it for a timing flake; I did not change it.
6. No defect found in `contracts/pot`. The Treasury's stored `box()`, `pot()` and `arriving()` are as of the last settle (pass B found
   this); the live-record helper works them forward by the document's formula, and the live specs show the screens agree with the chain.
7. `scripts/phone-e2e.sh` and `scripts/phone-loop.sh` are not on this track. `phone-e2e.sh` runs `phone-choice.spec.ts`, which is skipped
   without the legacy flag and needs the old contracts; `phone-loop.sh` checks only `contracts/next/out`, while
   `passkey-back.test.ts` needs `contracts/pot/out`. `scripts/pot-app-phone-e2e.sh` and `scripts/pot-app-loop.sh` replace what they proved on
   the new contracts. The lead should retire or re-point the two old scripts.

## Chosen under the owner's standing go; the owner may overrule

1. "The stranger reads the two sheets" is taken as the Back sheet and the faucet sheet (a stranger holds nothing, so has no Take out
   sheet); a holder's Take out sheet is read in the Take out specs.
2. The browser specs use the mock server of the existing set-up with a record made from the chain, not the real relay and reader (they need
   a database, a cache and a long Rust build; the server track proves its reader with `scripts/chain-loop-pot.sh`).
3. The specs start their own anvil per file and skip, with a stated reason, when `anvil` or `contracts/pot/out` is missing. They need the app
   built with the Launcher and dollar of a fresh anvil (`CREATON_DEPLOYMENTS_FILE=../contracts/pot/deployments/pot-31337.json pnpm build`
   gives them); a spec checks the build names the chain's Launcher and fails with that sentence when it does not.
4. When a spec moves the chain's clock (a project that goes quiet), the page's clock is moved to the chain's (Playwright's clock), so the
   browser and the chain agree what day it is.
5. The passkey path lives in its own script and config (a build with the passkey settings and a port-specific bundler address cannot share
   the normal build), not in the smoke project.
6. "Where the dollar cannot pay and call" is proven in the harness only: the play dollar always can, and a second token would be a test
   token, not the network's.
7. The layout check judges a press by its own box, or its label for a radio or a tick box, at 44 px, and leaves the pages' chrome out
   (finding 2).

## Not done

- Not exercised in a browser: the allowance screens beyond opening their sheets (an over-draw refused in words, lowering the rate,
  announcing a raise and applying it early and after the wait, the door, a lapsed check-in), Team Shares (a grant, a claim, a member's
  exit, what a stranger sees), a Pair's waiting call confirmed or withdrawn, and a wallet closed mid-send then the sheet opened again
  ("Look for your backing"). Their contract side is proven in the harness (`pot-loop`, `pot-screens`, `pot-states`) and their screens by
  the unit tests of pass B; a refused prompt and a double press are proven in the browser.
- Keyboard and focus were checked on the Take out and Back sheets only, not on every sheet.
- Take out with the wallet on another network, and the passkey path for a Back where the dollar cannot pay and call, were not run in a browser.
- Not run: a real relay with the real chain reader under a browser; a real phone; a real wallet app.
- Step 2 and `crates/**` are untouched.

## Steps for a person to try it on their own phone against a local chain

I have not done these on a phone, and I have not run the relay part on this machine, so they may need small changes. Nothing here uses a
real key or real money: the chain is a local test chain and the dollars are play money.

What you need on the computer: Foundry (`anvil`, `forge`, `cast`), Node and pnpm, Postgres and Redis for the server, and a phone on the
same network. A passkey needs a secure address (https, or `localhost`), so a phone on a plain `http://<computer>:port` address cannot make
a passkey account: use a phone browser that has a wallet (its own wallet browser) and, in that wallet, add a custom network (chain 31337,
the computer's address and port as its RPC) and import one of anvil's public development accounts. The wallet shows that account's
secret key only on the computer; do not type a real account's key anywhere.

1. On the computer, in `contracts/pot`: `forge build`. Start the chain so the phone can reach it:
   `anvil --host 0.0.0.0 --port 8545 --chain-id 31337`.
2. In another terminal, in `contracts/pot`, deploy with the deploy script from anvil's first account (see `contracts/pot/DEPLOYMENTS.md`
   for the flags): `UNIT=1680 forge script script/DeployPot.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --unlocked --sender
   <anvil's first account>`. It writes `contracts/pot/deployments/pot-31337.json`. `UNIT=1680` makes a time unit 28 minutes, so you
   can see a check-in lapse in an afternoon; leave it out for the real week.
3. Start the server (relay) with the chain reader reading that chain and that Launcher. The settings it needs are the server track's:
   see `scripts/chain-loop-pot.sh` for how it starts the relay and the reader against this same chain. Note the server's address.
4. Build and serve the app for the phone, from `app/`:
   `CREATON_DEPLOYMENTS_FILE=../contracts/pot/deployments/pot-31337.json pnpm build` then `pnpm exec vite preview --host 0.0.0.0 --port 4174`.
   Open `http://<the computer's address>:4174` on the phone and point it at your server.
5. On the phone: create a project (or open one the founder account launched with `cast`), open its Money tab.
   - **What working looks like:** the page says in its first line that this is a test network and the dollars are play money. It shows
     "The project's money", "What one Share gives if taken out now", "This can go up or down. It is not a return.", and the legal line word for word.
   - Press **Get play dollars**, then the sheet's button: your wallet asks once, and you hold 1,000 play dollars.
   - Type an amount (for example 25), press **Back**: the sheet shows what you pay, the fee, the Shares you get and what taking out now
     would give. Press its button: the wallet asks **once**, the sheet closes, and "Your Shares" shows the new Shares.
   - Press **Take out**, then the sheet's button: the wallet asks **once**, the dollars come back (a little less than you paid, because of the
     fee), and "Your Shares" says you hold none.
   - With a second account, Back the same project and see that the first backer's Shares do not change.
   - Stop checking in for two time units (56 minutes on a 28-minute unit): the page says the project is quiet, Back says why it is paused
     and that you can still take your money out, and Take out still works. After 26 units anyone can wind it down, and Take out still works.
   - Stop the server and reload: the page says the numbers could not be read and still lets you take your Shares out.

## Review fixes

Two independent reviews of the whole track (the app, `packages/creaton-core/src/pot`, `scripts/pot-app-*`) were checked one finding at a
time against the code. Each fix has a test on the production path that fails without it. The reviewers' scratch tests were turned into
proper tests (listed) and the scratch files deleted: none is left, tracked or untracked.

### Fixed

| Finding | What was wrong | Fix | Test that fails without it |
|---|---|---|---|
| Review 1 B1 | The date of an announced raise was `Treasury.pendingAt()`, which is when it was announced. The contract applies it one time unit later (`applyRate` reverts `NotYet`). The card said "the wait is over" at once and Apply was refused. | `readAllowanceState` reads `Treasury.unit()` and returns `applicableAt = pendingAt + unit` (`pot-state.ts`). The e2e record helper had the same two numbers wrong and was fixed too. | `pot-state.test.mjs` (a real announcement shape); `allowance.test.tsx` (an announced raise waits for its date, with a real `pendingAt`); `tests/anvil/pot-allowance.test.ts` on the real Treasury: the app's date equals the `RateProposed` log's `applicableAt`, `applyRate` is refused before it and works after (`passTime`) |
| Review 1 I1 | The Pair sentence for a forfeit described `Vester.announceByRunner`, which a Pair can never hold (a Pair proposes only to the Treasury or the Launcher). The call a Pair really holds, `Treasury.announceForfeit(uint256)`, read as "unknown", so the second signer could not confirm it. | `pair-terms.ts` has a Treasury case for `announceForfeit(uint256)` (the member's own wording and the notice length); the Vester branch is gone, and a Vester call now reads as unknown. New builder `runnerForfeitCall` in `pot-calls.ts`. | `pair-terms.test.ts` (the Treasury call reads as a forfeit; the Vester calls read as unknown); `pot-calls.test.mjs`; `pot-screens.test.ts` on the real chain: a Pair proposes the forfeit, the app reads it as a forfeit with the exact sentence, the second signer confirms, the grant is announced (state 1) |
| Review 1 I2, Review 2 B1 | A record with `playMoney:false` took the play-money line off the Back, Take out, Draw, Grant and allowance sheets, while the page said it. | `PotSheet` says it through `mustSayPlayMoney(record flag)` (always, in step 1); `targetOf` does the same; the faucet follows. The Tasks tab and the Accept-and-pay press say it too (Review 2 I7). | `back-sheet.test.tsx` and `take-out.test.tsx` (a record with `playMoney:false`); `AcceptAndPay.test.tsx` (two) |
| Review 1 I3, Review 2 I4 | A typed 25.123456 showed "You pay 25.12 dollars" and the call carried 25123456; the fee line floored the same way. | New `exactDollarsText` (every non-zero decimal to six, never rounded) for the pay line, the press label, the "not enough" line, the fee line and the history. Page figures that are estimates keep cents. | `back-sheet.test.tsx` (25.123456 shown in full and carried as 25123456; 10.005 is not "10"); `pot-words.test.ts` |
| Review 1 I5 | The Accept button's gate said the record's box is "a safe floor". It is not: a draw by the runner or an agent after the record lowers it, and the record can be over a day old. | The gate uses the larger of the record's box and the chain's own box (new core read `boxOf`); the press reads the chain again before sending and stops with the number if it is short. | `AcceptAndPay.test.tsx` (a short record with a full chain is offered; a chain that fell after the page was drawn stops before any send); `pot-state.test.mjs` |
| Review 1 I4 (the part that is a regression) | A project run by two people, or with a short box, could not accept a paid task at all (the button was hidden), so the task stayed "submitted". | The work can now be accepted without paying from here: a second, plainly worded choice (two presses, the same as for a task with no payee), pointing to "Draw from the box" on the Money tab. A wallet that does not run the project still gets no press. | `AcceptAndPay.test.tsx` (the Pair case and the short-box case) |
| Review 1 I6 | The Pair proposal time limit was copied (14 days) and the look-back was a fixed 50,000 blocks (about 28 hours on a 2-second chain), so a call proposed three days ago dropped out, and "now" was the browser's clock. | The limit is read from `Pair.PROPOSAL_TTL` (new core read `proposalTtl`); "now" and the pace of blocks are read from the chain (`blockTime`, an optional method of the wallet); the look-back covers the limit at that pace, to a cap, and says so (not complete) when it cannot. A sender that cannot say block time (the passkey account) keeps the old fixed window and the browser's clock. | `pair-waiting.test.tsx` (a chain 20 days behind the browser keeps a call proposed 3 days before its own now; a one-day limit read from the Pair drops a 2-day-old call; the window function at 2 s, 12 s and unknown pace) |
| Review 2 B2 | A passkey account could not Take out when the server's record could not be read: the passkey sender only sends to contracts the app has read, and the Launcher fallback never told it. | `readHolding` (every Take out goes through it, from the record or from the Launcher) remembers the project's contracts as send targets. | `passkey-takeout.test.tsx` (the take-out reaches the passkey sender, a stand-in impl; fails without the line) |
| Review 2 I1 | `readHolding` failed whole when the play-dollar balance, the Team Shares balance or the quote failed, and then showed no Take out. | Only the Shares balance gates Take out; the rest are read on their own and left out when unreadable. The sheet reads its own quote. | `take-out.test.tsx` (the dollar balance fails; the quote fails once) |
| Review 2 I2 | A record naming another Launcher or dollar than the build's still showed the Back box and sent money to them. | `recordFitsBuild` (use-pot.tsx): the Back box is off with words when the record's Launcher, or its dollar when the build names one, is not the build's; the faucet and dollar line go with it. Take out is not blocked. | `back-sheet.test.tsx` (two) |
| Review 2 I3 | "10,5" was read as 105 dollars. | A comma is accepted only as a proper thousands mark. | `calls.test.ts` |
| Review 2 I5 | The history wrote the quote down as what was received. | The line says "got about …" for the Shares of a Back and the dollars of a Take out; what was paid in is exact. | `take-out.test.tsx` (the dollars that landed differ from the quote); the two existing history tests were updated |
| Review 2 I6 | While a send was pending, Escape and the close button did nothing: a wallet prompt that never answers locked the sheet. | Closing is always possible; the step that went out is looked up (never sent twice) when the sheet opens again. | `back-sheet.test.tsx` (the wallet never answers; Escape closes) |
| Review 2 I8 | `rateWords` showed 1049 ppm as "0.10%" and 4 ppm as "0.00%". | Every digit the rate has (a part per million is 0.0001%), at least two decimals, never 0.00% above nothing. | `pot-words.test.ts` |
| Review 1 O1, Review 2 O2 | `freshnessOf` tested "fresh" before the day's limit, and a record built far ahead of the clock was fresh for ever. | The day's limit first; a record more than 10 minutes ahead of the clock is "stale". | `numbers.test.ts` (two) |
| Review 1 O3 | After a part (a quarter) that quotes nothing, the choice vanished and the person had to close the sheet. | The choice stays while something is held (a new answer, "that part is too small", keeps it); the "no Shares" line is only for holding none. | `take-out.test.tsx` |
| Review 1 O4 | The WeekPage clock line used the record's own state word. | It works the state out at the device's clock (`quietStateAt`). | `clock-line.test.tsx` |
| Review 1 O8 | `WalletGate` rendered inside a `ul`. | The list is a plain `div` list. | covered by `your-shares-list.test.tsx` |
| Review 2 O1 | The fee percent came from the record, the fee from the chain. | The percent is worked out from the chain's fee on the typed amount. | `back-sheet.test.tsx` |
| Review 2 O4 | The quote that arrives after the sheet opens was not announced. | The Back and Take out bodies sit in a polite live region. | `back-sheet.test.tsx` |

Scratch tests kept as proper tests: `hostile-record.test.tsx` (extreme but parseable records show no NaN, Infinity or Invalid Date) and
`money/refusal-shapes.test.ts` (contract refusals in the shapes wallets give them read as plain sentences). The reviewers' other scratch
tests (typed amounts, rounding draft, play money, passkey, history, focus, live region, launcher mismatch, Take out gating, Tasks) are now
the tests named in the table; the rounding draft asserted the bug and is gone.

### Declined, with the reason

- **Review 1 I4, the missing screens (launch, hand over, take the seat, wind down, Home's "you back this" hint).** Not a defect in what was
  built; a decision on scope (the lead's L2 and L3 put the old stage, round and team screens behind the flag, and the design's step 1d is
  for the lead to schedule). The builders (`launchCall`, `handOverCall`, `takeSeatCall`, `windDownCall`, `makePairCall`) are built and
  tested; no screen uses them. Left open for the lead, below.
- **Review 1 O5, the legacy chunks ship in the flag-off build (about 90 KB).** Dropping them at build time needs a compile-time constant at
  every `lazy()` site; the legacy tests switch the flag on at run time, so that change would break them. Not reachable or loaded at run
  time; carried weight only. Kept.
- **Review 1 O6, Take out is two presses.** Accepted as built (the sheet carries the numbers a person must see); L7's wording of "one press"
  should read "one signature, two presses". A note for the lead.
- **Review 1 O7, a team take-out is refused when one Team Share rounds to nothing.** Conservative on purpose: there is no exact Treasury view
  for it. The sheet already says the figure is an estimate that can be nothing.
- **Review 1 O9, state sentences with wall time ("quiet for months").** On a test network a unit can be 28 minutes, so those words can be
  wrong there. Left as written; the dates in the same sentences come from the record.
- **Review 1 O10, the legal line and "take your money out any time" on every sheet, the faucet too.** The legal text is never hidden; the
  faucet sheet keeps it.
- **Review 1 O11, "landed" judged by a balance.** A look-up aid, not a send guard. Kept.
- **Review 1 O2 (a wallet gate that offers no step in a build with no network).** The take-out needs the network the record or the Launcher
  names; a build that names none cannot be told which chain to use. Kept as chosen.
- **Review 1 O12, O13, Review 2 O5, O6.** O12 is the server track. O13 (the two old phone scripts) is not on this track's paths: reported
  again to the lead. Review 2 O5 (re-read the quote at the press) costs a failed signature at worst, because the contract refuses a move
  over 0.5% with words. Review 2 O6 (a just-backed project missing from You until the next record) is read from the server's holders list
  by design; the project page and its Take out are unaffected.
- **Review 2 O3 (focus after taking out everything).** Not done: the sheet cannot know the opener is gone without a structural change in
  `ui/sheet.tsx`. Focus lands on the page, not lost to nothing. Left open.

### Still open

1. The screens for launch, hand over, take the seat, wind down and a Pair's creation (Review 1 I4): the lead's decision.
2. The passkey sender has no block time, so a Pair's waiting calls on a phone use the browser's clock and the fixed window.
3. The passkey phone script (`scripts/pot-app-phone-e2e.sh`) was not run after these changes; the changes do not touch the passkey sender
   (only `wallet.ts` got an optional method).
4. `scripts/phone-e2e.sh` and `scripts/phone-loop.sh` still need to be retired or re-pointed (not on this track).

### What was run after the fixes

| Run | Result |
|---|---|
| `cd app && npx vitest run` | 70 files, 524 passed, 0 failed |
| core `node --experimental-strip-types --test src/pot/*.test.mjs` (forge on PATH, includes the fresh-ABI test) | 68 passed, 0 failed, 0 skipped |
| `scripts/pot-app-loop.sh` (real anvil, real `contracts/pot` bytecode) | 7 tests passed, 0 failed, 0 skipped, in 5 files |
| Playwright `--project=smoke --trace off` on the six `pot-*.spec.ts` files (a build made with `CREATON_DEPLOYMENTS_FILE`) | 30 passed, 0 failed |
| `tsc --noEmit`, `biome check .`, `check:copy`, `check:px-text`, `check:file-sizes` (base 68309b077), `pnpm build` and the bundle check | clean; entry chunk 390 KiB against the 450 KB budget |

---

# Second round, app engineer A: launching a project and who runs the money

Written 19 November 2026 on branch `v6` by app engineer A of the second round. Nothing is pushed. The contracts (`contracts/pot`), the
record specification and `crates/**` are not touched. This is not legal or tax advice, and no figure here is a promise of any result for
anyone. **No person has tested any of this: every run below was made by an agent.** Every amount is play money on a local test chain.

This round closes the largest gap of step 1: a founder could not launch from the new app, and the runner's seat (hand over, take the
seat, a second signer, wind down) had call builders and no screens.

## What was built

| # | Part | Where |
|---|---|---|
| 1 | **Launch.** A card on the page of a project that is not on the network ("Open Lantern to backers", for its founder only, where investing is on and the build names a network). It opens the launch sheet: the two numbers (daily allowance, start 0.10% and at most 0.20%; Team pool, start 10,000,000 and at most 100,000,000) each with one plain sentence of what it means for a backer, the limits every project has, what cannot be changed later and what can, a sentence that says what pressing will send, and "Technical details" with the settings fingerprint. One call, one signature with either sender | `app/src/features/launch/` (`LaunchCard`, `LaunchSheet`, `launch-terms`, `launch-plan`, `launch-read`, `launch-ids`) |
| 2 | **The settings fingerprint.** Read from the Launcher when the sheet opens and again right before the press; if it moved, nothing is sent, the sheet shows the new settings and says so in words. The contract's own refusal (settings moved after the check) is said in words too | `PotSheet.recheck` (new optional prop), `launch-terms.SETTINGS_MOVED_WORDS` |
| 3 | **A launch that landed is never repeated.** The card asks the Launcher (not the server) whether this wallet already launched the page's project: if so only "Finish linking" is offered. A read that fails offers nothing and says so. The sheet's own pending-send memory and a chain look-up cover a call that went out and was replaced in the wallet | `launch-read.isLaunched`, `LaunchCard` |
| 4 | **After the launch.** The page is tied to the launch (the founder's record names it), the page moves to the Money tab, and until the server's record arrives the tab says "No numbers yet ... until then no figures are shown. This page looks again every few seconds" and shows no zero. The record query now looks again every 5 seconds while it has none. A page with no launch at all says "Not open to backers yet" | `ProjectMoney`, `use-money.ts` |
| 5 | **Who runs the money** (a section on the Money tab). For anyone: who runs it, and what running it together means in one sentence. For the person the seat is offered to: take it (two presses). For the person asked to run it together: accept the second seat. For the runner (or one of a Pair): offer the seat to one team member (the founder may say they are leaving), ask one team member to run it together (a Pair), withdraw an offer, wind down. For anyone, once the team has been quiet half a year: wind down | `app/src/features/seat/` (`SeatSection`, `OfferSheet`, `SeatSheets`, `WindDownSheet`, `use-seat`, `seat-words`) |
| 6 | **The offer's lifetime** is read from the Treasury (2 time units) and said on the offer sheet and on the sheet of the person offered; an ended offer says so and nobody is offered a press for it | `seat-words`, `use-seat` |
| 7 | **Wind down says first what it does to backers**: taking out stays open (the first line), it is for good, the door and the allowance stop and the box goes back to the project's money, and what happens to Team Shares (by choice: what each member has built up stays; after a long quiet: only what has unlocked). Two presses | `WindDownSheet`, `seat-words.windDownWords` |
| 8 | **With a Pair as runner** every runner step is a proposal and the sheet says "This project is run by two. Pressing asks the other signer: nothing happens until they confirm the same step." The other signer's sentence for withdrawing an offer is new (before it read "offer the seat to 0x000..."), and for a wind-down it no longer says Team Shares "that have not unlocked" (a wind-down by choice keeps what has built up) | `pair-terms.ts` |
| 9 | Core reads: `readLaunchOffer` (the settings hash, the platform's limits and the rules every project is born with, read from the contracts a project is cloned from, so no limit is copied into the app), `readSeatState`, `pairAddressOf`; `treasuryWindDownCall` | `packages/creaton-core/src/pot/pot-state.ts`, `pot-calls.ts` |
| 10 | The old Team browser specs (hand over, take the seat, wind down, the second person, the Pair's shares, their accessibility and screenshots) are deleted; they only ran with the old-screens build. `team/launch.ts` (old) now re-exports the live `launch/launch-ids.ts` | `app/tests/e2e` |

## How it held to the rules

- **The numbers on each sheet are the numbers in the call.** The launch sheet's call is `launchCallFor(...)`, the one function the sheet and the
  chain loop both call; the vitest decodes the call and compares every argument with what the sheet showed (defaults, typed numbers, zero,
  the hash it read, a changed hash). The offer sheet names the person with their address in its sentence and sends the address the Launcher
  gave for a pair; the loop and the browser spec decode every call.
- **One owner per actionable label, no duplicate screen-reader stops.** Each button has a name of its own; fields are labelled; sheets are
  labelled dialogs; Escape closes and focus returns to the opener. axe: no serious or critical finding in jsdom on every sheet and in a real
  browser (colour contrast included) on the launch card and sheet, the runner's section and the wind-down sheet; layout at 360 px has no
  sideways scroll and the sheet's press is at least 44 px.
- **A double press cannot send twice; a failed send says what happened and leaves the press; a send that may have landed is checked on the
  chain.** All of this is the shared `PotSheet` (a wallet that says no, a refusal in words, a call that went out and is looked up, never
  sent again), tested once more for the new sheets (double press on the launch sheet in a browser: one wallet prompt, one call).
- **Words.** `check:copy` passes; sizes are rem tokens; no event, contract or error name reaches a person (the fingerprint is under
  "Technical details"); the play-money line and the legal line are on every one of these sheets (PotSheet), word for word.

## Presses and signatures, measured (real browser, real local chain)

| Step | Presses | Fields | Wallet signatures |
|---|---|---|---|
| Launch from the project's page, the defaults | 2 (Launch, then the sheet's press) | 0 | 1 |
| Launch, both numbers typed | 2 | 2 | 1 |
| Wind down (runner alone) | 2 | 0 | 1 |
| Offer the seat to a teammate | 2 | 1 (chosen from a list) | 1 |
| Take the seat (the teammate's page) | 2 | 0 | 1 |
| Ask a teammate to run it together | 2 | 1 (chosen from a list) | 1 |
| Accept the second seat | 2 | 0 | 1 |
| A wind-down through a Pair: one proposes / the other confirms | 2 / 2 | 0 / 0 | 1 / 1 |

## Gates, as run

| Gate | Result |
|---|---|
| `tsc --noEmit` (app, including `tests/`) | clean |
| vitest (app) | 75 files, 588 tests passed, 0 failed (the round began at 66 files, 472 tests in pass B; 72 files, 552 tests after the launch screens) |
| biome (app, core `src/pot`), `check:copy`, `check:px-text`, `check:file-sizes` (`CHECK_FILE_SIZES_BASE=855c585a0`), repository `knip` | clean |
| core tests (`pnpm test` in `packages/creaton-core`, forge on PATH, including the fresh-ABI test) | 1,211 passed, 0 failed, 0 skipped |
| `pnpm build` with `CREATON_DEPLOYMENTS_FILE`, then the bundle check | builds; entry chunk 390 KiB against the 450 KB budget; the launch and seat screens load with the Money tab and the launch card (lazy), not in the first download |
| `scripts/pot-app-loop.sh` (real anvil, real `contracts/pot` bytecode) | 12 tests passed, 0 failed, 0 skipped, in 6 files (the new `pot-team.test.ts` has 5) |
| Playwright `--project=smoke --trace off` (the build made with the deployments file; each spec starts its own anvil) | 54 passed, 0 failed, 42 skipped. The 9 new tests: `pot-launch.spec.ts` (5), `pot-seat.spec.ts` (4). Before this round the same project gave 45 passed, 59 skipped; the 17 deleted skipped tests were the old Team specs |

`pot-team.test.ts` drives the real contracts only through the app's own launch reader, terms and call, its seat reader and its call builders:
the defaults and typed numbers launch what they say (the rate and the Team pool are read back from the chain); the ceiling is refused by the
sheet and by the contract; the same project twice is refused in words; a platform setting changed by the admin between the sheet and the
signature is refused with "settings changed" and nothing is created, and read again the same press launches under the new settings; an
offer of the seat is read as the person's own, as another person's, or as a pair with them; it is taken, withdrawn, left to run out (after
two time units it cannot be taken, in words, and a new offer replaces it) and made with the founder leaving; a Pair is made from an offer
to the address the Launcher gives for the two, a call from the proposer alone is refused in words, the other signer reads the wind-down in
words and confirms exactly it, a second wind-down is refused, and the backer still takes everything out; a wind-down by a stranger is refused
before 26 time units of quiet and works after.

The browser specs: `pot-launch.spec.ts` goes through the real Start screen, the launch card, the sheet, one wallet prompt, the call on the
chain, and the wait for the server's record (a record is then seeded and the page, looking again on its own, shows the project's money); also
the settings change, a wallet that says no, a double press, a launch whose page was never tied to it, and the keyboard, axe and 360 px.
`pot-seat.spec.ts` winds a project down as its runner and then lets a backer take everything out in the same browser; winds a quiet project
down as a stranger; hands the seat to a teammate (offer, withdraw, offer again, the teammate takes it from their own page) and makes a Pair
(ask, accept, two run it together, one proposes the wind-down, the other reads it in words and confirms it). Screenshots are written to
`app/test-results/pot-screens/` (ignored by git) and were looked at.

## Chosen under the owner's standing go; the owner may overrule

1. **Where the screens are.** The launch card is on the project page above the tabs (a founder who just pressed Start lands on it). The seat,
   Pair and wind-down controls are one section of the **Money tab** ("Who runs the money"), not a new fifth tab: four tabs already fit at 360 px,
   and the Money tab holds the allowance, the grants and a Pair's waiting calls. A separate "Team" tab is a small move if the owner wants one.
2. **The seat and a second signer go only to a team member who linked a wallet**, chosen from a list (as grants do); there is no typed address.
   The person is shown with their full address in the sentence before the press.
3. **"I am leaving" is a tick box shown only to the founder, off by default,** on a hand-over (not on a Pair offer: the founder stays).
4. **Typed numbers.** The allowance is a percent a day with up to four decimals ("0" switches it off); the Team pool is a whole number of Team
   Shares ("0" for none), commas allowed. Anything else, or above the Launcher's ceiling, is refused in words and nothing can be sent.
5. **The limits on the launch sheet are read from the contracts** (`readLaunchOffer`: the Launcher's own constants, its platform settings and
   the constants of the contracts a project is cloned from), never typed into the app. A project does not exist yet at that moment, so
   the implementations are asked.
6. **The fingerprint is checked twice** (when the sheet opens and right before the press) and then by the contract; a change refuses with
   words and shows the new settings.
7. **A pair is offered by naming the person:** the offer goes to the address `Launcher.pairAddress(key, runner, person)`; the person's page and
   the runner's page recognise it by working that address out for each teammate with a linked wallet (a few reads when the section opens).
8. **A wind-down by anyone** (after 26 time units of quiet) is the Treasury's own call; its words keep only what has unlocked. By choice it
   goes through the Launcher and its words keep what each member has built up (what `Vester.burnAfterWindDown` does).
9. **The record query looks again every 5 seconds while the server has no record of a launched project** (and stops when it has one).
10. **The four old Team browser specs were deleted, not rewritten**, because pot-launch and pot-seat cover the same journeys on the new
    contracts (hand over, take the seat, wind down, launch, the Pair) in the default build. Their old-design helpers (`team-world.ts`,
    `chain-wallet.ts`) stay: `earlier.spec.ts` and `market.spec.ts` still use them.

## Found while building

- **The new Launcher refuses an unknown key** (`UnknownProject`) instead of returning an empty project, which the old launch card's check
  assumed. `isLaunched` reads a refusal as "not launched" and any other failure as "could not tell" (no launch is offered on a guess).
- **`platform()` is on the Launcher (five answers) and on the Treasury (one).** The test wallet answers by function name, so
  `installPotChain` takes a `launcher` address to answer the Launcher's own first. The wallet harness for the chain loop needed nothing.
- **The contract's refusal for changed settings says "press again",** which on a sheet built from one read would send the old fingerprint
  again. The sheet's recheck makes "press again" read the new settings first.
- **The live record reads a Pair from the chain** (`isPair`, the Pair's two signers), so a browser spec shows what the server will.
- **History note:** the launch commit (`09b570d44`) uses `readLaunchOffer`'s `rules`, which landed in `4d98a6b9f` (the core commit
  `2b4210776` before it had the reads without `rules`). Those commits build together, not each alone.
- Two `vite preview` processes of other engineers (ports 47312 and 47313) were running during this work; mine used port 4391 and left nothing.

## Not done

- **A passkey account launching in a real browser or on the stand-in bundler** (the phone path). A jsdom test sends the launch as one
  operation with one call through the passkey sender, and the seat sheets use the same `PotSheet` as Back and Take out, which the phone
  script already proves; `scripts/pot-app-phone-e2e.sh` was not extended or run.
- **The launch is not yet in `scripts/pot-full-loop.sh`** (the joined-up run with the real server): it still launches with the call builder
  outside the browser. That script is not on this agent's paths. The browser launch against a real server and reader has not been run.
- **A hand-over or a Pair with someone who is not on the team list** (no typed address), and a Pair's own hand-over to a new Pair.
- **No person has tried any of it on a phone.**
- **Stale browser specs that remain skipped** (not mine, for the lead and app engineer B under F5): `a11y.spec.ts` (12), `money.spec.ts` (11),
  `earlier.spec.ts` (6), `tasks.spec.ts` (5), `market.spec.ts` (3), `money-review.spec.ts` (2), two in `smoke.spec.ts`, and `pot-phone.spec.ts`
  (1, which the phone script runs).

## What app engineer B must know

- **`PotSheet`** has a new optional `recheck` (an async read right before the send that can stop the press with a sentence). Use it where a
  sheet stands on numbers that can move (a sheet for paying a task from the box could re-read the box).
- **New shared reads** in `@creaton/core/pot/pot-state.ts`: `readLaunchOffer`, `readSeatState`, `pairAddressOf`; `readSeatView` in
  `app/src/features/seat/use-seat.ts` (who the seat is offered to, whether as a Pair with this account). `treasuryWindDownCall` in `pot-calls.ts`.
- **`ProjectMoney` now renders `SeatSection`** between Team Shares and the waiting Pair calls; it needs only the wallet's account, never asks
  anyone to connect, and reads the chain when it shows. `pair-terms.ts` has the withdraw-offer sentence.
- **`useProjectNumbers` polls every 5 s while it has no record.** A test that renders a page with a chain key and no record sees "No numbers
  yet" and a refetch every 5 s; tests with fake timers should expect that.
- **Test helpers:** `tests/helpers/seat-harness.ts` (the example project run alone or by a pair, a team with linked wallets, the chain's
  answers about the seat); `installPotChain({ launcher })`; `tests/e2e/helpers/live-team.ts` (`seedTeamServer`: a project with a teammate who
  linked an anvil account, for browser specs with two people); `live-record.ts` reads a Pair.
- **The browser specs share `app/dist`.** Build it with `CREATON_DEPLOYMENTS_FILE=../contracts/pot/deployments/pot-31337.json pnpm build`
  and run with your own `E2E_PORT`; a spec checks the build names the chain's Launcher. Each spec file starts its own anvil.
- **Deleted:** `team-seat.spec.ts`, `team.spec.ts`, `a11y-team.spec.ts`, `screens-team.spec.ts` and their entries in `playwright.config.ts`.
  The remaining skipped specs are listed above.
- `features/team/launch.ts` (old, legacy list) re-exports from `features/launch/launch-ids.ts`; live code must import the latter.

---

# Third round, app engineer B: accept now and pay later, the stale browser specs, the passkey flake, the joined-up run

Written 19 November 2026 on branch `v6`. Nothing is pushed. `contracts/pot`, `crates/**` and the record specification are not touched. This
is not legal or tax advice, and no figure here is a promise of any result for anyone. **No person has tested any of this: every run below
was made by an agent.** Every amount is play money on a local test chain.

## What was built

| # | Part | Where |
|---|---|---|
| 1 | **Accepted now, paid later (F2).** An accepted task with a pay and no payment on its record reads "Accepted, pay owed: 40 dollars." to every reader and is never shown as paid; "Paid 40 dollars." shows only when a payment's transaction is on the record. The reader takes the first confirmation of the accepted piece that names a payment, so a payment recorded after the acceptance counts. The runner's task offers **Pay from the box** (a draw to the wallet the worker named, then a second confirmation naming the transaction; a payment whose record failed is kept and the next press only writes the record). Before anything moves the task and the box are read again and the chain is searched for a draw of exactly this pay to this wallet made after the acceptance: such a payment is offered as the task's pay ("Save that it was paid"), never paid twice, and a payment another task already carries is never offered. With a Pair as runner the press is **Ask for the pay from the box** (a proposal); the other signer's list on the Money tab names the task in the sentence ("..., the pay for the task "Translate the guide""), and once confirmed the payment is found and saved on the task. The secondary press on Accept now reads "Accept now, pay 40 dollars later" and says what will show | `app/src/features/tasks/` (`PayFromBox`, `pay-lookup`, `task-record`, `TaskCard`, `tasks-copy`, `AcceptAndPay`), `pot/pair-terms.ts`, `PairWaiting`, `ProjectMoney` |
| 2 | **No browser spec stays skipped.** New in the default build: `pot-week` (3), `pot-tasks` (6), `pot-review` (4); rewritten: `a11y` (12 run), `smoke` (the four tabs at 360), `join`, `screens`; deleted: `earlier`, `market`, `money`, `money-review`, `tasks` (lists below) | `app/tests/e2e` |
| 3 | The seam the verifier found uncovered: a record with `playMoney` false on a network this build knows is play money still shows the play-money line, the faucet and the sheet's line. Fails when `mustSayPlayMoney`'s rule is removed | `pot/project-money.test.tsx` |
| 4 | **The passkey flake, at its cause.** After a reload the app drew before the passkey signer had been registered (it loads lazily and `registerPasskeySigner` was fire-and-forget); until then the stored passkey account reads as nobody, nothing told the page when the signer arrived, so on some reloads the unlock bar never appeared (about 1 run in 4 here: 7 failures in 25). `registerPasskeySigner` now returns its promise, the app waits for it before the first draw, and it tells listeners when it is done. A vitest fails without the notification | `packages/creaton-core/src/account/passkey-identity.ts`, `app/src/main.tsx`, `app/src/lib/account.test.tsx` |
| 5 | `scripts/phone-e2e.sh` retired (it ran one spec that needed the old-screens flag; that spec, the You page's wallet-or-passkey choice, runs without the flag under `scripts/pot-app-phone-e2e.sh`); `scripts/phone-loop.sh` and the sender tests take their test dollar from `contracts/pot/out` (the same source file as under `contracts/next`) | `scripts/`, `app/tests/anvil/rpc.ts` |
| 6 | **A defect found by the rewrite:** after "Switch network" the money screens went on saying "Your wallet is on another network" (nothing asked the wallet again, and the page does not refetch on focus). Fixed, with a vitest that fails without it | `pot/use-pot.tsx`, `pot/wallet-gate.test.tsx` |
| 7 | **The joined-up run launches from the app** and `STEP1-REPORT.md` is true again (launch exists; the exact steps for a person to try it, the helper's call names, the refresh range) | `app/tests/e2e-pot-full`, `docs/next-version/STEP1-REPORT.md` |

## Specs: what was rewritten and what was deleted, and why

| Spec (tests) | What happened | Why |
|---|---|---|
| `money.spec` weekly update with check-in, its failure, and without a launch (3) | rewritten as `pot-week.spec` on a real chain: the update is signed first, the check-in carries its id (checked against the Treasury's own `CheckedIn` log); a refused check-in keeps the update and offers only the check-in again with the same hash; a project not on the network posts alone | the journey exists in the default build |
| `tasks.spec` post, take, hand in, accept and pay (1) | rewritten in `pot-tasks.spec`: the draw and the record name the same transaction (read back from the chain) | the old test checked `Treasury.spend` of the old design |
| `tasks.spec` agent limits (2), agent never offered Accept, money off (2) | rewritten in `pot-tasks.spec`; the limits are read back from the Treasury | live screens |
| new in `pot-tasks.spec` | accepted now with the box short, "pay owed" to everyone, "Pay from the box" once the box holds enough and the payment written on the same task; a Pair's ask, the other signer's sentence naming the task, the payment found and saved | F2 |
| `money-review.spec` F1 (wallet starts on another network) and `money.spec` "wallet shares no account" | rewritten in `pot-review.spec` (and found the switch defect above) | live screens |
| `money-review.spec` F2 (a record copying a chain key) and `money.spec` "numbers signed by another key" | rewritten in `pot-review.spec`; each fails when its guard (`numbersBelongTo`, the signer check) is removed | security properties that must stay covered |
| `a11y.spec` (12) | rewritten for the default build (Home, the project's four tabs, You, Start, Messages, Post, Profile, This week and its sheet, signed out, at 390 and 360, light and dark) | the money parts of the old sweep are in `pot-a11y.spec` |
| `smoke.spec` four tabs at 360 (1), `join.spec`, `screens.spec` | rewritten or trimmed (their stage-line branches and the old money screenshots removed) | the stage line is not in the default build. `smoke.spec`'s "Home shows projects and posts" (line 141) is not skipped and passes in the default build |
| `smoke.spec` open rounds slot (1) | deleted | Home's open round does not exist in the default build |
| `earlier.spec` (6), `market.spec` (3) | deleted | the earlier backers' page and the auction are not in the default build; their code stays under the legacy flag with its vitest |
| `money.spec` numbers on the page and an open round (1), investing off (1), Back (2), take money back (1), open backing (1) | deleted | the screens they drove (rounds, receipts, refund, open backing) are gone; `pot-back`, `pot-takeout`, `pot-stranger`, `pot-states` cover Back, Take out and the numbers on the page on the new contracts, `smoke.spec` covers investing off |
| helpers `legacy-build`, `team-world`, `chain-wallet` | deleted; `money-world` cut to what is used | only the deleted specs used them |

The smoke project now has one skipped test: `pot-phone.spec`, which `scripts/pot-app-phone-e2e.sh` runs (it needs the phone build).

## Gates, as run

| Gate | Result |
|---|---|
| `tsc --noEmit` (app including `tests/`) | clean |
| vitest (app) | 78 files, 614 tests passed, 0 failed (before this round: 75 files, 588) |
| biome (app), `check:copy`, `check:px-text`, `check:file-sizes` (`CHECK_FILE_SIZES_BASE=855c585a0`), repository `knip` | clean |
| core tests (`pnpm test` in `packages/creaton-core`, forge on PATH, the fresh-ABI test included) | 1,211 passed, 0 failed, 0 skipped |
| `pnpm build` with `CREATON_DEPLOYMENTS_FILE`, then the bundle check | builds; entry chunk 390 KiB against 450 |
| `scripts/pot-app-loop.sh` | 13 tests passed, 0 failed, 0 skipped, in 7 files (the new `pot-task-pay.test.ts`: real `AllowanceDrawn` logs found by payee and amount after the acceptance, not another amount, wallet or task's payment, not one made before the acceptance, and the draw a Pair's second signer made by confirming) |
| `scripts/phone-loop.sh` | 3 files, 13 tests, 33 claims |
| `scripts/pot-app-phone-e2e.sh` | 2 passed (the You page's choice, and faucet, Back and Take out from a passkey account: 2, 2 and 2 presses, 1 prompt each) |
| Playwright `--project=smoke --trace off`, full run | see the final line of the report that carried this section (the run after the last commit) |
| `scripts/pot-full-loop.sh` (chain, real server, real app build, Chromium) | **213 checks passed**, 1 journey passed, 0 failed; everything it started was stopped (checked with `ps`) |
| `passkey.spec.ts` | 7 failures in 25 runs before the fix; 30 passes in a row, then 20 in a row, after |

Falsifiability, each by removing the guard and watching the test fail: the payment journal, the fresh task check, the "payment found" stop,
"never shown as paid" (vitest); the payment record's `task-paid` and the weekly check-in's hash (browser); the chain-key and signer
checks (browser); the wallet-gate invalidation, the registration notification and `mustSayPlayMoney` (vitest).

## Chosen under the owner's standing go; the owner may overrule

1. **The pay is a second confirmation of the same piece**, titled "Pay recorded", not a new kind of record: the server accepts any number of
   confirmations and the reader takes the first one that names a payment. Another reader that takes only the first confirmation sees the
   task as accepted without a payment (the safe way round).
2. **A Pair's pay is linked after the fact, from the chain.** A proposal carries only the call, so the other signer's page cannot name a
   transaction at the proposal; once confirmed, anyone on the team who is not the worker finds the payment (payee, exact amount, after the
   acceptance) and presses "Save that it was paid". Nothing is saved on its own.
3. **The search reads the last 30,000 blocks** (three pieces of 10,000). A payment older than that is not found, and the task goes on
   reading "pay owed" (never "paid"). If the search cannot be read the press goes on (the task and the box are still read again).
4. **A second ask for a Pair's pay from another device or by the other signer** is not blocked (the proposal is only a proposal); the other
   signer reads two sentences naming the same task. Not built: a hard stop for a duplicate proposal.
5. **The founder alone checking their own work** keeps the same limits for paying as for accepting.
6. **The task's words in a Pair sentence** are cut at 60 characters and quotes in them are replaced, so they sit inside the sentence.
7. **The passkey fix waits for the signer before the first draw** (a few milliseconds for a chunk already on the page) rather than redrawing
   after it; the notification stays for a page that drew earlier.
8. **`phone-choice.spec` joins the pot phone script** rather than being deleted: the You page's choice is a live screen.

## Found while doing it

- The wrong-network gate bug (above) and the passkey race (above): both real defects, not test mistakes.
- `STEP1-REPORT.md` said the helper's stored call names were the old ones; migration 0070 renamed them, and the joined-up run's last check
  had to follow (`treasury.collectFees`, `treasury.settle`).
- `packages/creaton-core/src/pot` was already formatted; the one unformatted file in the package was a test under `launchpad`, now formatted.
  `abis.generated.ts` is excluded from the package's biome by its own config.
- Playwright restarts its worker after a failed test, and the live specs start a chain per worker: a spec that shares one chain between its
  tests must not assume the play dollars of an earlier test (the faucet gives each account 1,000 once).

## Not done

- A passkey account launching, accepting or paying in a real browser (the phone script covers faucet, Back and Take out).
- The task, pay-from-the-box, seat and launch screens against the **real server and reader** in one browser run: the joined-up run covers
  the launch, Back, check-in, draw and Take out; the task and seat screens are driven on a real chain with the server's record stood in.
- A hard stop for a duplicate Pair proposal for the same task, and a typed wallet for a task whose worker named none (it stays "pay owed").
- No person has tried any of it on a phone.

---

# Fourth round: fixes after the independent review of the finish track

Two independent reviews of commits `855c585a0..e66b2c927` were checked finding by finding against the code. No blocker was found by the
first review; the second named the editable sheet as a blocker, and it is real, so it was fixed first. Their scratch tests were turned
into proper tests and the scratch files deleted: none is left, tracked or untracked.

## Review fixes

### Fixed (each with a test on the production path that fails without it, shown by removing the fix)

1. **What is shown is what is signed (both reviews; the blocker of the second).** `PotSheet` wraps everything the person can change in a
   `fieldset` that is disabled while the press checks or the wallet is asked, so the Launch rate and pool, the hand-over choice, the "I am
   leaving" tick and a Pair's second signer cannot change under a signature already asked for. Tests: `launch/launch-press.test.tsx` (the
   boxes are disabled; the call carries 1000 parts per million, the 0.10% the sheet said) and `seat/seat-sheets.test.tsx` (the choice is
   shut; the offer goes to the person the sheet names). Without the fix both fail.
2. **A task pay could go out twice when the search for an earlier payment could not be read or did not reach back far enough.**
   `findPayment` now throws (never "nothing found") when the logs cannot be read, and throws `PaymentSearchShort` when it found nothing and
   its window of 30,000 blocks starts after the acceptance (or the start's time is not known). `PayFromBox` then offers no bare "Pay from
   the box": it says so and offers "Look again"; a press whose search fails after the page was drawn stops with a sentence and sends
   nothing. A young chain whose window starts at block 0 is complete. Tests: five in `tasks/PayFromBox.test.tsx` (logs cannot be read;
   failure at the press; window starts hours after the acceptance; window starts before it; no block time given).
3. **A Pair's pay could be asked twice** (second review). Before proposing, `PayFromBox` reads what is waiting in the Pair (the same
   reader the Money tab uses, now exported as `readPairWaiting`); the same draw already waiting means nothing new is asked and the task
   says it is asked; a read that fails stops the ask. This covers a reload and the other signer asking from their own page. Tests: two
   in `PayFromBox.test.tsx`.
4. **A payment kept for task X was offered for task Y** (second review). The journal's transactions of other tasks are added to the ones
   never offered. Test: `PayFromBox.test.tsx` (fails without it).
5. **The "no record yet" poll never ended.** It now asks every 5 s for 30 s, every 15 s until 2 minutes, then stops (a reload asks again;
   the card says so). Measured: at most about 12 reads, against 721 in a simulated hour. A launch's link to the page starts a new wait
   (the key changes). Tests: `money/use-money-poll.test.tsx`; the card's words changed in `launch/launch-page.test.tsx`.
6. **A Pair's second signer read "the pay for the task X" as fact.** The sentence is now the page's own record, with who accepted the task and
   who took it: "..., the pay for the task "X" (accepted by A, taken by B), as the project's page records it." A task its proposer wrote,
   had a throwaway account take, and accepted reads as exactly that. Tests: `tasks/owed-task-names.test.ts`, `pot/pair-terms.test.ts`,
   `pot/pair-waiting.test.tsx`; the browser spec's substring still holds.
7. **An earlier launch with other numbers was not named** (second review). The launch sheet now passes the two numbers as the press's
   detail, so the sheet's own "a step you sent earlier" sentence shows and a landed earlier launch says its numbers cannot be changed.
   Test: `launch/launch-press.test.tsx`.
8. **"About half a year" was written on money screens for a test network.** The wait is now this project's own (26 units of its unit): "about
   12 hours" on the test network's 28-minute unit, "about half a year" on a real one (`quietWaitWords`; the Money tab card and the state
   words). Test: `seat/seat-sheets.test.tsx`; the browser spec's text follows.
9. **Formatting** (first review): `app/tests/e2e-pot-full/pot-full.spec.ts` is formatted; `biome check .` is clean.
10. Optional, taken: the passkey signer is waited for at most 3 seconds before the first draw (`main.tsx`; a late arrival is still announced
    to the surfaces that drew); the launch sheet lists the helper's Team Shares limit (one part in 1,000 of the pool a day, read from the
    Launcher) beside its dollars limit (test in `launch-press.test.tsx`); `REQUIRE_CHAIN=1` makes the live browser specs fail, not skip,
    when there is no chain.
11. **Paying an old accepted task from the box was a dead end (verifier's blocker, third round).** `findPayment` read only the newest
    30,000 blocks, threw `PaymentSearchShort` when it found nothing and the window began after the acceptance, and `PayFromBox`
    then showed a sentence and "Look again" for ever: any unpaid task accepted more than about 16 hours earlier on a 2-second chain
    could not be paid from its card. Now (a) the search goes back in pieces of 10,000 blocks until a piece begins at or before the
    acceptance (an hour of skew allowed), up to 40 pieces, and finds an old payment in an older piece; (b) when the bound is reached
    first, or the network gives no block times, the card says the work was accepted too long ago for the search and offers "Nothing
    was paid for this"; pressing it brings back the bare "Pay from the box", and the press still searches (a payment that has
    appeared meanwhile stops it with the usual sentence); (c) a read that fails (node refuses) is not "too old": it offers only
    "Look again". Tests: `tasks/PayFromBoxSearch.test.tsx` (new file, the search tests moved out of `PayFromBox.test.tsx` to keep
    files under 600 lines): goes back 30 pieces to an acceptance 300,000 blocks old and pays; finds a payment in an older piece;
    the way out beyond the bound, and the press then sends once and writes the paid record; the way out with no block times; no way
    out for an unreadable node; a payment appearing after the person's word still stops the press. Without the fix the first
    fails (shown by putting the old `findPayment` back); on the real chain `tests/anvil/pot-task-pay.test.ts` now mines 35,000
    blocks and finds the first payment still, and says "nothing" (not "short") for a wallet never paid.
12. **knip: unused export (verifier).** `PaymentSearchShort` is now imported by `PayFromBox` (it tells "too old" from a failed read),
    so `cd web && pnpm check:unused` passes (exit 0).

### Declined, with the reason

- **Any teammate can make an accepted task read "Paid" with an invented transaction (second review, I3).** Real as a trust gap, not fixed
  here: limiting the "paid" confirmation to the person who accepted would break the intended flow, where the runner (who may be another
  teammate, or a Pair's signer) pays a task someone else accepted, and the record the runner writes must count. The effect is a label
  only: it moves no money (the Treasury moves money only on a signed draw), and only team members can write it, the same people who
  can already accept. The fix that closes it is to check the recorded transaction on the network (a draw to the worker's wallet of exactly
  the pay); that needs a receipt reader the wallet does not have today. Kept open below.
- **Confirming a duplicate proposal that already exists (second review, I1 second half).** Not added: the press no longer makes a duplicate
  (fix 3), and a duplicate made at the same moment from two devices is the case the Pair's own two-signer rule is for. The other signer's
  sheet still shows the task's name only while the pay is owed.
- **Browser build for the passkey signer timeout** has no browser test: `main.tsx` is the bootstrap and has no seam; the three-second cap
  follows the one beside it for the settings.
- **O3 (brand constant for "Creaton takes 2%"), O5 (a moment of "one step is left" while the link runs), second review O2 to O6**: not
  taken; none is a few lines, and none touches money. O6 (a wind-down by the runner keeps what has accrued, no cliff) is the contract's
  design and the sheets say it.

### Still open

- The recorded payment of a task is not checked on the network (above). Before real money.
- The refresh ceiling: the settings range still ends at 86400 seconds (the lead's decision, F3). The app calls a record stale once it is
  older than a day, so a server set to the ceiling leaves each record stale for as long as the next pass takes. The comment on
  `MAX_REFRESH_SECS` now says to use at most half a day (43200). Not changed in behaviour.
- A task accepted so long ago that the search (40 pieces of 10,000 blocks, about 9 days on a 2-second chain) cannot reach back to its
  acceptance: no payment is offered on a guess; the person is shown the sentence and may say "Nothing was paid for this" (see fix 11).
  That word is theirs, and a payment that appears afterwards still stops the press.
- Launch is checked per key (wallet plus project); a launch made from another wallet of the same founder is not seen by the card.
- Focus after the seat is taken, loading cards without status text, and a person offered the seat who has not connected a wallet (second
  review O3 to O5).

## Chosen under the owner's standing go; the owner may overrule

1. The search window is widened, not fixed: it goes back piece by piece (10,000 blocks each) until a piece begins at or before the
   acceptance, at most 40 pieces (an upper bound on node requests). Past that, or on a network that gives no block times, a person's
   own word "Nothing was paid for this" brings the bare press back (the second option the verifier gave; chosen so a guard never removes
   the only way to pay, rule 6). The word is not stored; it holds for this open card only.
2. The poll's end is a fixed two minutes, not "after a launch the page itself made": linking the page to its launch changes the key, which
   starts a new wait.
3. The Pair sentence names who accepted and who took the task instead of dropping the claim.
4. `REQUIRE_CHAIN=1` is opt-in, so a machine without a chain still skips the live specs as before.

## Gates, as run after the fixes

| Check | Result |
|---|---|
| `tsc --noEmit` (app) | clean |
| `biome check .` (app) | 334 files, no fixes needed |
| `vitest run` (app, whole) | 81 files, **629 passed, 0 failed** |
| `check:copy`, `check:px-text`, `check:file-sizes` (base `855c585a0`) | all pass |
| `scripts/pot-app-loop.sh` (real contracts on anvil) | **13 passed, 0 failed, 0 skipped**, 7 files |
| Playwright on a private build with the 31337 deployments (`pot-launch`, `pot-review`, `pot-seat`, `pot-week`, `pot-tasks`) | **22 passed, 0 failed** |
| `cargo test -p buzz-relay --lib refresh` (the refresh settings; the Rust change is one comment) | 1 passed, 0 failed (the Postgres-backed one needs a database and was not run) |

Everything started was stopped (checked with `ps`); the private build was deleted.

## Gates, third fix round (the paid-later dead end)

| Check | Result |
|---|---|
| `tsc --noEmit`, `biome check .`, `check:copy`, `check:px-text` (app) | clean |
| `check:file-sizes` (app; no `origin/main` in this tree, so `CHECK_FILE_SIZES_BASE` was set to an earlier commit) | pass |
| `vitest run` (app, whole) | 82 files, **632 passed, 0 failed** |
| `scripts/pot-app-loop.sh` (real contracts on anvil, with the new 35,000-block look-back case) | **13 passed, 0 failed, 0 skipped**, 7 files |
| `cd web && pnpm check:unused` (knip) | exit 0 |
| `pot-full-loop.sh`, the phone scripts, the Postgres-backed reader tests | not re-run in this round: none of their code changed (the changes are in `app/src/features/tasks`, one anvil test and this report). The verifier ran all three on the earlier commit and they passed. |

Not changed, as the verifier noted: the two edits outside the track's list (`JOIN-LEAVE-DESIGN.md` question for counsel, `PLANV2-M5P2-REPORT.md` helper
settings) stay as committed; the recorded payment of a task is still not checked on the network (before real money); the refresh ceiling stays at
86400 seconds (F3).
