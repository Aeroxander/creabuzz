# Step 4 report: the carry-over, the holder pause, earlier grants, and the joined-up proof

Written by the last builder of the round (the app engineer, package A5), 21 November 2026, from the reports of the engineers before
(contracts K1 and K2, server S1, app A4), the plan (`STEP4-PLAN.md`) and `git log 1fed95002..HEAD`. Everything here ran on a local chain
with play dollars, with a software passkey and in Chromium. **No real phone, no real passkey, no real network and no real money was
used, and no person has tried any of it.** Nothing here is legal or tax advice, and no sentence of the app was written by counsel.

The decided design (`JOIN-LEAVE-DESIGN.md`) is unchanged: nobody votes, joining is fast, leaving is easy any day, and nothing promises a
profit. This round built what the final audit found still buildable. **With the pause switch off and no earlier-grant settings (the
default of every deployment) the contracts behave exactly as verified at 1fed95002 and every earlier test passes unchanged.**

## 1. What this round built, package by package

### Social features the new app did not have (W3, app engineers, commits before this report's package)
Search and topics, saved posts, hidden people and reports for any post (`a111d73f6`, `afd6630f3`, `38bc525c2`); pictures in posts (made
clean of hidden details in the browser, size and count capped, alt text), editing and deleting your own post, reposts and quotes, the
message server list and downloading the recovery key (`468c8aef9`, `0e4a3319b`, `d7da94af9`, `220ca65ca`). No server change.

### The project brain in the app (W4, `119be0d82`, `bf002d4fe`)
A read-only reader of a project's notes (nothing is fetched until opened, drawn as plain text, long files cut with "Read on") and Start's
one optional line offering the brain to a founder. The recorded-run skill (B4) stays declined: it waits for real founders using the
brain by hand.

### The phone path and small items (W5, app engineer A4: `e4465ab75`, `703b1a699`, `46c660b4d`; server S1)
Founder and team presses (launch, check in, draw, plan a task, accept and pay, grant Team Shares, hand over, take the seat) proven from a
passkey account on the real contracts, the account's address worked out on the phone and compared with the node's (a mismatch is
refused, nothing signed), "account" instead of "wallet" for a passkey person, the room's "no more posts" and "removed, and why", the cut
list of stopped people said, distinct names on same-name task buttons, focus after a sheet closes. Server side (S1): a task paid from
the box reads Paid only when the network shows the payment to that task's worker (G7), and the agents' limits are tied to the server's
labels (open item 4 of `PLANV2-M8-REPORT.md`, now closed).

### K1, contracts: the holder pause (`69297d190`, `75175f0e0`, generated files `d587c97d6`)
`HolderPause` (a small clone per project), the Treasury's checks in `draw`, `announceTask` and its poke after every mint of backer
Shares, the Launcher's one-shot, deployer-only, first-hour binding, `HolderPauseBound`, the deploy script's `HOLDER_PAUSE` switch. Off by
default. The commit says: with the switch off a 154-log journey gives the same digest on both builds; a fuzzed differential finds no
difference with the switch on and nobody parking; attack rows 1 to 17, invariants, event rebuild, gas and size gates and a test of the
deploy script's settings are included; 30 mutation entries, each killed once (`paused-not-live` only through a planted stale clock).
I did not re-run the contracts' suites (they are not my paths); the numbers are the engineer's.

### K2, contracts: earlier grants (`5f65696d2`, `547cbd821`, generated files `bd776482a`)
`EarlierGrants` (a Merkle root over rows of index, account and amount; the claimant names the text fingerprint in the same call; one
claim per row, by the row's own account), the Vester's reserve and its two grant counters (ordinary and protected, so nobody who may grant
can lock a listed account out of its claim), the Launcher's `bindEarlier` and the funded launch of project zero, the deploy script's six
`EARLIER_*` settings (all or none). Nothing is claimable by default. Tests use invented rows only.

### S1, server (`90026c454`, `eb35430ec`, `22dcff880`, `09f74639f`, `558f96c9a`)
The reader follows the pause and the claim contract; the signed record (still version 2) gains `pause`, `earlierGrants`,
`contracts.pause`, `team.earlierPool` and `team.earlierReserve`, each null where a project has none; holdings count parked Shares; a Take
out of parked Shares is one sponsored press; G7; the label rules; migration 0076; a second fixture and example. Its counts are in the hand-over
(372 relay tests, 62 db tests, the chain loop's 2,977 and 4,143 checks, 17 guard mutations each killed) and were not re-run here, except that
the loops below run its relay.

### A5, app and loops (this package; `a5a2cf1aa`, `83a04c7de`, `ac5906955`, `4c10a81a3` and the commit of this report)
- **Core** (`packages/creaton-core/src/pot`): the ABIs of `HolderPause` and `EarlierGrants` (generated from forge's output by
  `scripts/pot-app-abi.mjs`, which now lists them), `parkCalls`, `unparkCall`, `takeOutWithParkedCalls`, `earlierClaimCall`, `parkedOf`,
  `pauseState`, `pauseGateOf`, `pauseRules`, the claim reads, `quoteParkedTakeOut` and `planTakeOutParked`, `earlier-proof.ts` (the list's
  leaf, proof check and tree, pinned against `cast keccak`), and the launch offer's `holderPause`.
- **The parse** (`numbers-step4.ts`): `pause`, `earlierGrants`, `contracts.pause` and the team's pair, each read apart; absent, null,
  malformed and stale each handled (section 3). Leaving works whatever the record says.
- **The holder's presses** (`app/src/features/pause`): the card on the project page, **Park Shares** (the sheet), **Take back** (inline,
  no sheet), Take out with parked Shares, and the sentences about parked Shares and a paused team.
- **What the team sees**: the armed and paused sentences on the allowance card, Draw off with the sentence as its description, a new plan
  refused with the same sentence, one line on the helpers' card, the chain's refusal read in the plan's words, and the sentence on the
  launch sheet before a founder signs.
- **The earlier-grant claim page** (`app/src/features/earlier-grant`, route `/earlier-grant`): in the router only for a build given its
  three settings; its consent, permanence and end-date sentences are in one provisional file for counsel.
- **"Paid" follows the server's check** (`tasks-copy.ts`, `task-record.ts`, `PayFromBox.tsx`, `AcceptAndPay.tsx`, `use-save-paid.ts`): the
  server's new refusals for a box payment read in plain words, "not read yet" reads as "press again in a few minutes", the payment's transaction is written in
  lower case, and a task is never marked Paid on a refusal (the payment is kept and only its record is retried).
- **Parked Shares are held** everywhere a person's Shares are read: Your Shares and You, the Take out quote, "held since", the room's rights,
  the alerts. The record's own `holders[]` (server side) already counts them.
- **The loops**: `scripts/pot-full-loop.sh` gains two worlds (section 2), `scripts/pot-earlier-list.mjs` makes the invented list,
  `app/tests/anvil/passkey-pause.test.ts` joins `scripts/phone-loop.sh`, and `app/tests/anvil/pot-chain.ts` can deploy with either switch.
- **Docs**: `TRY-IT.md` parts 4.8 and 4.9, `DEPLOY-TEST-NETWORK.md` step 2b and the build settings, `PLAN-V2.md` milestone 9 and a row for step 4.

## 2. What ran, with exact results

All on this machine (4 CPUs, shared), against local chains and a local server, in Chromium and in Node, with play dollars.

| What | Result |
|---|---|
| `tsc --noEmit` (app) | clean |
| `biome check .` (app, 718 files) | clean |
| `check:copy`, `check:px-text` | pass |
| `check:file-sizes` (`CHECK_FILE_SIZES_BASE=35ea0a894`) | pass |
| `knip` (the unused-exports check, repository root) | clean (it found 7 words I had exported and nothing used; unexported or deleted) |
| `node scripts/pot-app-abi.mjs --check` | the generated ABIs are what `contracts/pot/out` says (and see the core run below) |
| app `vitest run` | **225 files, 2,073 tests, all passed** (A4 left 218 files and 1,966 tests) |
| `packages/creaton-core` tests | **1,278 run, 1,278 passed, 0 failed, 0 skipped**; with Foundry on the path `abi-fresh.test.mjs` builds the contracts fresh into a throwaway folder and finds the committed ABIs identical |
| entry chunk (`pnpm build`) | see "Review fixes (app)": this line read "439 KiB of 450", a mix of units (the budget is 450,000 bytes = 439.5 KiB); the real figure was 449,719 bytes, 281 under the budget; the Park sheet, the pause words and the claim page are separate lazy chunks |
| `scripts/phone-loop.sh` | **52 claims proven** (46 left by A4, 6 new, in `passkey-pause.test.ts`), 6 files, 18 tests, all passed |
| `scripts/pot-app-loop.sh` | 11 files, **17 tests passed, 0 failed, 0 skipped** (unchanged: the new anvil test is in the phone loop) |
| **`scripts/pot-full-loop.sh`, in full** | **7 journeys, each in a world of its own: 5,885 checks passed, exit 0.** The two new worlds alone, when run by name: `pot-pause.spec` 868 checks (1.0 min), `pot-earlier.spec` 580 checks (15 s). Each world's reader also never refused to sign |
| Playwright `smoke` project (a mock server, `pnpm build` first) | the files `smoke, join, a11y, passkey, manager, search, bookmarks, mutes, report, brain, pictures, messages-key`: **54 passed, 3 skipped by their own conditions, 0 failed** (57 tests, 4.0 min). The live `pot-*.spec.ts` files of that project start their own chain and are not run through it: `pot-full-loop.sh` is their joined-up form |
| leftovers | no anvil, relay, preview server, `dist`, Playwright results or temporary folder left; disk 4.6 GB free |

**What the two new journeys prove, in the browser, on the real chain and the real server** (`pot-pause.spec.ts`, `pot-earlier.spec.ts`):
- *Pause world (`HOLDER_PAUSE=1`).* The launch sheet says, before the founder signs, that holders can pause the team's spending and that it cannot be
  turned off. A big holder (from the chain) and two holders in the app back; the first parks all of theirs (a quarter of the Shares: the card says a third is
  needed, nothing is armed, the record names no one, 280 field-by-field checks against the contracts); the second parks half of theirs (past the line:
  the record says the pause starts exactly one day later, the card and the team's allowance card say so, and Draw still works); the chain's clock moves past
  the day; the record, the card (paused since, "Everyone can still take their money out"), the team's sentence and a disabled Draw agree (280 checks); a draw
  and a new plan are refused by the chain and read in the app's own words; the first holder presses Take out ONCE and the parked Shares come back and are taken
  out in that press (the wallet is asked twice, as the sheet said), the pause ends, the team's Draw is back (280 checks); the pause part of the record names no
  address but the pause contract's. Walked at 360 x 640: no overflow, and the card, Your Shares, the Park sheet, the Take out sheet and the team's card show their named parts.
- *Earlier world (six `EARLIER_*` settings for an invented four-row list, an app built with the claim page's three).* Project zero's id, key and fingerprint match the
  deploy; the record carries the list's one fingerprint, the pool and the row count and no row; a listed account opens its own link and reads its grant, what the
  contract does, the count and the fingerprint, with the banner once and no other row's amount; ticking alone and opening the text alone do not offer the
  claim, both do; the claim asks the wallet once; the row is claimed on the chain, the account holds a protected grant of exactly its row, the record counts
  it and lists it as a protected grant (277 checks); another account with that link is told it is not for it and is offered no press; the contract refuses
  that account's claim (both a row already claimed and a row it is not in) and the app says so in words; opening the claimed row's link again says it is already
  claimed, and the count reads one of four. Walked at 360 x 640.

**Each guard switched off once** (the file changed, the named test run, the file put back; script kept outside the repository). All fourteen were killed:

| Guard | Test that failed with it off |
|---|---|
| the page, record and network must name one text (the record's text) | `earlier-grant.test.tsx`: a record that names another text than the build is refused |
| the network's own text fingerprint check | `earlier-grant.test.tsx`: what the page decides to show (2 tests) |
| the checkbox gate on the claim press | `earlier-grant.test.tsx`: offers the press only after the text is opened and the box ticked |
| the "text opened" gate on the claim press | the same test |
| no row of another person (the proof check) | `earlier-grant.test.tsx` (2 tests): a link that is another account's reads as not for this account |
| Draw disabled while paused | `team-pause.test.tsx` (2 tests) |
| a new plan refused while paused | `plan-gate.test.ts`: a pause that holders have put on the team's spending refuses a new plan |
| Draw's own sheet blocked while the chain says paused | `team-pause.test.tsx`: Draw's own sheet (written for this: it survived the first run, which showed no test reached it) |
| the take-out batch is un-park before leave | `park-flows.test.tsx` (2 tests) and `passkey-pause.test.ts` (a leave first would be refused by the contract) |
| hostile record: a parked total above the Shares | `numbers-step4.test.ts` |
| hostile record: `paused` that contradicts the record's own numbers | `numbers-step4.test.ts` (2 tests) |
| where Shares are approved to is the Treasury's own answer | `park-flows.test.tsx`: a pause the Treasury does not name the way the record does is never approved to |
| the payment's transaction written in lower case | `PayFromBox.test.tsx`: writes the payment's transaction in lower case |
| the room counts Shares parked | `use-room-standing.test.tsx`: a person who parked all of theirs still writes in the room |

**What was not run by me:** the contracts' forge suites and mutation script (K1, K2), the server's cargo tests and chain-loop scripts (S1): their numbers are theirs. Axe in a
real browser on the new screens (only jsdom axe: `pause-a11y.test.tsx`, 3 tests). Anything on a real phone.


## 3. What the app shows when a record is absent, null, malformed or old

| What it meets | What it does |
|---|---|
| A record signed before step 4 (no `pause`, no `contracts.pause`, no earlier keys) | Nothing about a pause or a claim. The app never guesses that a pause exists. `numbers-step4.test.ts` (31 tests) |
| `pause: null` and `contracts.pause: null` | The same. The project's info says nothing; there is no Park button |
| `contracts.pause` set and `pause` null or malformed | Your Shares shows Park Shares; its sheet says "The stop could not be read right now, so nothing can be parked", with no press. Take back and Take out still work |
| A hostile `pause` (parked above the Shares, a line that is not the Shares over the divisor, a day that is not a seventh of the unit, `paused` that contradicts `pausesFrom` and the numbers, a count of parkers that disagrees with the total, a contract that is not the record's own) | That key is null, the rest of the record stands |
| A record older than its own promise | The card says "These numbers are older than the server promises, so nothing is said here about where the pause stands now." |
| `lineDivisor` not 3 | "1 in n", never "a third" |
| The record says the project has a pause and the Treasury names another, or names none | Nothing is approved to the record's address; the sheet says it could not be read |
| The record says the project has a pause and its read fails | Your Shares says what you hold could not be read (your money is not affected) and offers Try again, instead of showing fewer Shares |

## 4. Chosen under the owner's standing go; the owner may overrule

From the plan (`STEP4-PLAN.md` section 7, D1 to D26, unchanged): one switch per deployment, off by default; the line is a third of the
whole backer supply (contract balances counted, Team Shares not), observed by park, un-park, poke and every join; custody, with Take out
as an un-park-and-leave batch from the holder's own account; the further power (end at two thirds) left out; a separate earlier pool
bounded at 1,000,000,000 Shares; unclaimed rows stay claimable for ever, also after a wind-down, where they keep diluting backers'
surplus; the text is an opaque fingerprint in an immutable contract; the claim is sent by the row's own account; a protected grant vests
from project zero's birth; ordinary and protected grants are counted apart; the pause fails closed; the box stays at its cap while paused;
the roles `pause` (new) and `earlier` (reused); the claim page's words are one provisional counsel-owned file. (The owner must set the
earlier pool's size and see what share of a surplus the team side takes before any real network: STEP4-PLAN section 3.3.)

From S1 (its hand-over): holdings folded at store time (a park moves nothing); any disagreement on the pause or claim key signs that key
null with a log line, and only the Vester's reserve refuses the record; G7 waits 60 s after the confirm's own time, counts per wallet and
needs the `task-paid` tag in lower case; the label rule 2 applies to every task step by an unlabelled account; sponsor: `unpark` must be
exactly 36 bytes; a second fixture and example keep the first the switch-off replay.

From A4 (its hand-over): the address is derived on the phone and compared with the node's; refusal sentences that name "the wallet that
runs this project" say "the account" for everyone; removal reasons come from the newest 100 public log entries filtered to the room,
signed by the server; task press names are "<visible words>: <task>"; focus goes to the page heading when a sheet's opener is gone; words for
`Paused`, `BindClosed` and `NotDeployer` (the first now replaced, below).

From this package (A5):
1. **Where Shares are approved to is always the Treasury's own `pauseGate()`**, never the record's address. The record's `contracts.pause`
   is only a hint: with it a failed read is a stop, without it a failed read is "no pause" (a Treasury from before the pause has no such call).
2. **A part of a Take out that the wallet covers does not touch parked Shares.** The plan's batch was `[unpark(p), leave(w + p)]` for "all of
   it"; for a part the press un-parks only what the wallet cannot cover. The sheet says "Taking out takes your parked Shares back first" only
   when the press does that. The quote is the sum of two chain quotes (the holder's for the wallet part, the pause contract's for the parked part).
3. **One Take back, in Your Shares.** The plan put a Take back in the card as well; one owner of each label wins (rule 7), so the card shows
   the project's numbers and Your Shares shows the person's.
4. **The card shows only when something is parked, the line is reached or the person holds Shares**; otherwise one plain line in the page.
5. **The paused sentence adds "It ends when n fewer Shares are parked."** (RECORD-V2 13.9 asks for it; the plan's table had no such clause).
6. **The team's state is the chain's own answer when it can be read**, the record's otherwise: a pause that ended or began since the record
   is shown as it is. The helpers' card reads the record only (it reads nothing from the network).
7. **The `Paused` refusal says "a third"** (the plan's sentence, word for word): the copy module has no record and the contract's line is a
   constant of the code this build is made for. Every sentence that has the record says "1 in n" for another divisor.
8. **The launch sentence needs the launch offer's read of `holderPauseImpl` and the code's `LINE_DIVISOR`**; the offer fails to read when
   either fails (the sheet already says nothing can be sent). There is no launch step in Start: launching is the project page's sheet.
9. **The claim page's press is the signed-in sender's own account**, and the row's proof is checked against the record's list fingerprint
   for that account before any press. The link is `/earlier-grant#<base64url of {index, amount, proof}>`. The text counts as opened when the link is
   clicked or middle-clicked in this visit (a "copy link" does not count). The page needs the server's record for the counts and the clock; without it it says it
   could not read and offers Try again.
10. **A box payment's refusal never leaves a task marked Paid**: the payment is remembered, only its record is retried, and the sentence says what the network showed.
11. **The loops**: the pause world leaves the page's own clock alone (a page set to the chain's clock, days ahead, would read every record as old);
    the earlier world's project-zero key is a throwaway made from a public string, so the deploy can be told its id before the journey runs; the text is
    served from the app's `assets` folder because the relay serves nothing else static.
12. `scripts/pot-app-abi.mjs` (not a `pot-*.sh` path) was edited to list the two new contracts, because the plan puts the regenerated ABIs in my package.

## 5. Declined, and why

- **The further power of W1** (the project ends when two thirds stay parked for a full quiet period): left out, as the plan decided. A buyer could burn the
  team's unvested claim for a profit; neither reviewer could argue for it.
- **A "stop backers cannot lose"**: not built and not said anywhere. A join can lower the parked share and end a pause; the card says so.
- **The vote, the Council, seat elections, a vote to replace the runner, the reserve sale** (milestone 9 of `PLAN-V2.md`): replaced by
  the new model; the reason is in the status table.
- **A unified "one press" for a wallet that cannot batch** (EIP-5792): not built; the sheets say "asked twice" for a wallet and "one press"
  only for a passkey account.
- **A per-holder vault, and stopping the allowance's accrual during a pause**: not built (plan D4, D14).
- **The helper's `pause.poke` job** (S1): not built; the Treasury already pokes on every join, so correctness never needed it.
- **The two Playwright specs of the plan (`pot-pause.spec.ts`, `pot-earlier-grant.spec.ts` in `app/tests/e2e`, with axe in a real browser at 390 x 844)**: replaced by
  the two live journeys (`app/tests/e2e-pot-full/pot-pause.spec.ts`, `pot-earlier.spec.ts`, which also check 360 x 640) and by jsdom axe tests
  (`pause-a11y.test.tsx`). **Axe has not been run in a real browser on the new screens.**
- **The recorded-run skill (B4)**: waits for real founders using the brain by hand.

## 6. What is still open

- **A person on a real phone**: no passkey on a real phone, no real bundler or sponsor, no real wallet app, no real day. The browser journeys use an injected test wallet on a
  local chain; the passkey proof uses a software passkey and a stand-in bundler.
- **Counsel's words**: the text a claimant accepts, the consent and end-date sentences, the list, its attestation, the entity and the pool's size are not decided or
  written. `earlier-grant-consent.ts` is a neutral placeholder. Whether notice plus the right to leave counts as "governance" is still counsel's question (design 12.4).
- **An end date for unclaimed rows**: none exists; they stay claimable and keep diluting backers' surplus, also after a wind-down (STEP4-PLAN section 3.3 gives the figures).
  The owner should decide this before any real network.
- **The plan's new-plan press in a real browser**: the plan sheet's paused block is unit-tested and the chain's refusal of a plan is read in words on the real chain, but no
  journey presses "Plan" in the browser while a pause is on.
- **A failed read of the pause where there is no record** (the project's page could not be read, so Your Shares comes from the Launcher
  alone): the read is taken as "no pause", so for that moment a holder with Shares parked sees only the Shares in the wallet. Nothing is
  lost or held back, and Take back and the rest return with the record, but it is the one place a failed read reads as "none".
- **A parked Shares alert**: nothing tells a holder that parked Shares reached the line (the in-app alerts do not carry it).
- **A real-network check of the sponsor** with the batch `[unpark, leave]`: S1 proved it as a classification and the loop proves the batch lands; the operator's real sponsor has not seen it.
- **The legacy screens** behind the old-model flag are untouched (their words were not changed).
- **A person's tax or company affairs, real backer names, amounts and addresses**: nowhere in the repository; the lists in the tests and loops are invented.


## 7. Review fixes (app)

Five reviewers (money, server, social, phone, fit) read `1fed95002..50f4beaf0`. This section is what the app fixer did with the findings in the app's paths
(`app/`, `packages/creaton-core`, the docs named below). The contracts and server fixer owns the rest; what it must know is at the end of this section.

### 7.1 Closed, each with a test that fails without the fix

| Finding | What was done | Test, and what happens with the fix switched off |
|---|---|---|
| **Phone BLOCKER 1**: a 32-letter `#topic` made Home, a post page, a topic page and Search scroll sideways at 360 px | The topic link in a post (`PostCard.tsx`) and the two links on Search take `max-w-full` / `min-w-0` and `break-all` | `tests/e2e/search.spec.ts` "the longest topic ...": walks Home, the post page, the topic page and Search at 360 px. Off: **fails, "Home with a very wide topic: the page scrolls sideways (471px wide in a 360px window)"**. On: passes |
| **Social 2**: nothing tested that a picture address on another host never gets the signed read | New `packages/creaton-core/src/client/media-url.test.mjs` (8 hostile addresses, the good shapes, userinfo, paths, other schemes) | Origin check removed: 2 of 3 pass, **1 fails**. Restored: 3 of 3 |
| **Social 1**: deleting a post left every repost holding its whole text and picture addresses (kind 6 content) | `buildRepost` now writes an empty content (the app already reads the original by id); `DELETE_CANNOT` also says a repost made in another app may keep a copy | New `post-events.test.mjs`; `post-actions.test.tsx` expects empty content. Off (content restored): fails |
| **Social 3**: a small download could inflate to gigabytes in the brain reader | **Partly.** The download cap falls from 5 MiB to 1 MiB (a brain is a few text files; deflate expands at most about 1000 to 1, so the worst case falls from about 5 GB to about 1 GB), and a copy that fails after cloning is wiped. The inflate bound itself is **not built**: isomorphic-git inflates every object while it indexes the pack, so only a bound on the stream or a size-limited read by the server closes it (see 7.3) | `brain-git.test.ts` pins the cap and the count across requests; with the cap back at 5 MiB: **2 fail** |
| Social 11 (optional, cheap): a file name with direction marks was drawn as written | Names from the repository go through the same cleaning as text; a name that changes is not read | `brain-read.test.ts` "never draws a file name with direction marks"; cleaning off: **fails** |
| **Phone 3**: "You hold no Shares in your wallet to park." to a passkey person; "your wallet" in a refusal | `parkNone(own)` says "your account" for a passkey; `potProblem` says "your account" for a passkey sender wherever it said "your wallet"; **Park Shares is offered only when Shares sit in the wallet** (a holder who parked everything is offered Take back only) | `pot-copy.test.ts` (every action, no "wallet" for a passkey sender), `pause-words.test.ts`, `park-flows.test.tsx`. Each off: **fails** |
| **Phone 2**: Take back's Cancel and success dropped focus to the page | Cancel returns focus to the Take back press; success puts focus on the card's "Your Shares" heading (which stays; the control goes away) | `park-flows.test.tsx` (two checks). Each off: **fails** |
| **Phone 4 and 5**: a locked passkey account was told "Unlock" inside sheets that cover the bar, with no press | One `UnlockPress` (also the bar's), now inside the recovery-key sheet and the writing box (typed words are kept) | `unlock-press.test.tsx`, `composer.test.tsx`. Each off: **fails** |
| **Money IMPORTANT 2**: a line reached with no warning day running (a join cleared it, then others took out) read "A third is needed" and the app had no way back | New state "reached": "A third is parked, but the warning day has not started. Press "Start the day" and, if it stays there, the team's allowance and new task plans pause one day later." and the press **Start the day**, which sends `poke()` to the pause contract the Treasury names (never one a record names; anyone may press it; no money moves). New `pokeCall` in creaton-core, checked against the real selector `0x18178358` | `pause-card.test.tsx`, `park-flows.test.tsx` (one poke to the right contract; nothing sent to a pause the Treasury does not name), `pot-calls.test.mjs`. State off: **fails** |
| Social 5: on a direct link a hidden person's post drew in full until the list loaded, then folded | `FoldedPost` draws a quiet placeholder until the hidden list has been read (or has failed) | `post-page-hidden.test.tsx` (a slow list). Off: **fails** |
| Social 6: Edit was offered while a post's comments were unknown (a failed read) and would have orphaned them | Edit is off, with the reason, until the counts are read | `post-more.test.tsx`. Off: **fails** |
| Social 7: a second room check in `use-topic.ts` that no test protected | Removed (the page's `visiblePosts` is what keeps room posts out, tested with a room post under the topic) | the existing topic-page tests still pass |
| **Fit 3**: the claim page's permanence sentence ("the team cannot cancel or burn this grant: the contract has no call for it") contradicted its own file header | The sentence is removed from the page, the test, `pot-earlier.spec.ts` and TRY-IT 4.9; the guard now also matches "cannot cancel / burn / be taken" | `earlier-grant.test.tsx` guard. With the sentence back: **fails** |
| **Fit 1**: the first-load budget had 281 bytes of headroom | The project page loads when a project is opened (`router.tsx`), `QuotedPost` is lazy. Entry chunk **449,719 to 400,830 bytes** of the 450,000 budget (**49 KB of headroom**). The report's "439 KiB of 450" was a unit mix; fixed above | `pnpm build` runs `check-bundle-size`; 55 browser tests still pass with the lazy page |
| **Fit 5 / FOLD 1**: Save on every post | Save moves into More ("Save this post" / "Remove from saved"): Like, Comments, More on each post (about 20 fewer tab stops on Home). Saved posts stays two presses from You; save is two presses from a post | `post-more.test.tsx`, `bookmarks.spec.ts` (counts 2 presses). It did **not** change the entry chunk (0.7 kB): the bundle fix is the lazy page |
| Fit 2: DEPLOY-TEST-NETWORK says the claim page's three settings go in `.env` | The guide now says plainly that the compose files do not pass them on yet, so a compose-built image has no claim page (fails closed); who must change the deploy files is in 7.4. 2b now says when a switch can be turned on (only by the deployer, in the first hour, before the first project) | doc |
| Fit (optional): TRY-IT 4.8 step 7 ended before the draw was back | Step 7 now says Cy takes his Shares back too; new step 8 for the "Start the day" state | doc |

### 7.2 What ran

| What | Result |
|---|---|
| `tsc --noEmit`, `biome check .` (721 files), `check:copy`, `check:px-text`, `check:file-sizes` (`CHECK_FILE_SIZES_BASE=35ea0a894`), `knip` | all clean |
| app `vitest run` | **226 files, 2,086 tests, all passed** (the earlier run of this round had 225 files, 2,073) |
| `packages/creaton-core` tests | **1,283 run, 1,282 passed, 0 failed, 1 skipped** |
| Playwright `smoke` project, the mock-server files (`smoke, join, a11y, passkey, manager, search, bookmarks, mutes, report, brain, pictures, messages-key`) | **55 passed, 3 skipped by their own conditions, 0 failed** (4.5 min), with the new long-topic test and the bookmarks changes. The live `pot-*.spec.ts` files of the project need an app built for a deployed Launcher: they are run by `pot-full-loop.sh`, not through this command (run bare, 17 of them fail with "the app in dist was not built for the Launcher", as expected) |
| `scripts/phone-loop.sh` | **52 claims proven**, as before |
| `scripts/pot-app-loop.sh` | **17 tests passed, 0 failed, 0 skipped**, 11 files |
| `scripts/pot-full-loop.sh` | **not run this time** (it builds the relay with cargo and the machine is shared). The two pause and earlier worlds are unchanged except: Park Shares is no longer offered once everything is parked (neither spec presses it then), the claim page lost one sentence (spec updated), the pause card has a new state |
| Guards switched off once each (vitest, restored from a copy each time) | 12 of 12 killed: `forSender`, the `wallet > 0n` rule, the "reached" state, the focus after Cancel, the focus after a take-back, `FoldedPost` waiting, Edit with unknown counts, the Composer's Unlock, the Recovery sheet's Unlock, file-name cleaning (the first test I wrote for this one did not kill it: the name did not pass the file filter. Fixed, then killed), the pause named by a record only, the 1 MiB cap |

### 7.3 Declined or left open, with the reason

- **Brain inflate bound (social 3), the rest of it.** Needs either a bound on the pack as it is read (isomorphic-git inflates objects while indexing, before any file is read) or a size-limited read of the four fixed files by the server. Server work; the cap is lowered meanwhile.
- **Avatars (social 4).** An author's profile picture can be any https address, so drawing it asks that website for it (the phone's address is visible to it; the `Referer` is not sent). This is the app's behaviour since before this round and changing it removes a feature (pictures set in other apps). I softened the two comments that said a post never asks another website for anything; **the owner decides**: draw avatars from this server only, or say it in the privacy text (counsel's words).
- **Same-name buttons on posts (phone 9).** Two posts by one author give two buttons with the same name ("Like Fay Founder's post"). Fixing it renames the buttons in about 40 selectors across unit and browser tests; the cards are separate groups for a screen reader. Left, and noted.
- **Fit FOLD 2 to 4** (message-server card into You, "keep a brain" card for a founder who declined, "Hide X's posts" on a profile). Each moves a working feature to a place that needs new tests and press counts; the founder's brain card is the only path to set a brain up for a founder who said no in Start. Not done; nothing in them is a defect.
- **Social 9** ("Only you can see this list"): the sealed list is readable only by its owner, so the words are true; opening Saved does ask the server for those posts by id, which the operator can see. Not reworded; counsel's privacy text should say it.
- **Social 8, 10, 12 and phone 6 to 8, 10 to 14** (edit deletes the old post and the saved copy; the preview address leak when the sheet closes early; the big-picture decode; reports kept at 500; claim-page jargon "contract", "fingerprint" in counsel's placeholder file; the signed-out claim page's two instructions; focus on opening sheets; tap sizes of 40 px; "You hid this post" for a reported post; the disabled Edit not focusable; the destructive look of Delete; live regions for the key reveal): optional, none a defect that loses money or data. Left for the owner.
- **Fit 4** (HANDOVER-TO-COUNSEL and the policy drafts): not in the app fixer's list of files. For the lead: counsel's hand-over needs the pause's words ("Holders can pause the team's spending", "You cannot turn this off for your project", "Parking does not move anyone's money"), the claim page's consent, permanence (now removed) and end-date sentences, that unclaimed rows never expire and keep diluting backers also after a wind-down, the public message-server list (kind 10050), reposts and quotes being public, that the saved and hidden lists are sealed to the person's key, that the reported-posts list is kept on the phone, and the fingerprint a claim writes on the network.

### 7.4 What the contracts and server fixer, and the lead, must know

- `HolderPause.poke()` is now called by the app ("Start the day"). If the contracts fixer makes `leave` poke the pause as well, the "reached" state will rarely show and the press stays valid; **do not change `poke()`'s signature**. The sponsor's allow list has no entry for `poke` (it was not needed before): a passkey account's press is sponsored only if the operator's list allows it; a wallet person pays the network fee.
- The app no longer writes a copy of the post into a repost. Nothing on the server needs to change; a server that deletes reposts of a deleted post would close the same gap for other apps' reposts.
- **`deploy/compose/run.sh`, `deploy/compose/compose.creaton.yml` and the Dockerfile** need `VITE_CREATON_EARLIER_CONTRACT`, `_TEXT_HASH` and `_TEXT_URL` added to their setting lists (outside every path of this round). The guide says so.
- The money and server reviewers' findings (G7 race, helper-limit padding, test coverage of the new server guards) are not in the app's paths and were not touched.
