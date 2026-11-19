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
