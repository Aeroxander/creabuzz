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

- `HolderPause.poke()` is now called by the app ("Start the day"). If the contracts fixer makes `leave` poke the pause as well, the "reached" state will rarely show and the press stays valid; **do not change `poke()`'s signature**. The sponsor's allow list is by contract address and the pause is on it, so the sponsor lets a passkey account's `poke` through; it is an ordinary operation, not an exit, so it counts against that account's daily limit (and the address and server limits) like a Back, and a person who has used their day's operations is told so in the sponsor's "daily limit" words. A wallet person pays the network fee. Proven by `sponsor::tests::a_start_the_day_poke_is_allowed_and_counts_like_any_other_operation` (section 10).
- The app no longer writes a copy of the post into a repost. Nothing on the server needs to change; a server that deletes reposts of a deleted post would close the same gap for other apps' reposts.
- **`deploy/compose/run.sh`, `deploy/compose/compose.creaton.yml` and the Dockerfile** needed `VITE_CREATON_EARLIER_CONTRACT`, `_TEXT_HASH` and `_TEXT_URL` added to their setting lists: done in the second fix round (section 9).
- The money and server reviewers' findings (G7 race, helper-limit padding, test coverage of the new server guards) are not in the app's paths and were not touched.

## 8. Review fixes (contracts and server)

By the contracts and server fixer, against the five reviewers' findings. **Nothing in `contracts/pot` changed and no ABI, event, migration, record key or generated file changed**, so nothing was regenerated and `forge test` was not run (no `.sol` file is touched). Every change is in `crates/buzz-relay`. For the app fixer: no ABI or record field to follow. Two new refusal sentences can reach the app, both through prefixes it already reads: `invalid: this account has linked more wallets than the server can check against the helpers on the network; use another account for this` (a manager's profile or a task step, `chain_agent_link::TOO_MANY_WALLETS`), and, when two confirms of one payment arrive together, the loser can get `retry: this season is busy; try again in a moment` (the existing `season_rules::BUSY` words, `retry:` prefix, after about 7 seconds of waiting for the other one to be stored). Show both through the existing prefix handling.

### 8.1 Closed

| Finding | What changed | Test that fails without it |
|---|---|---|
| Money I1 / Server I1: two confirms naming one box payment, sent together, both passed (G7 race) | `task_chain::enforce` takes an advisory lock on the project and the payment (`creaton-box:<project>:<tx>`, the season lock's own helper) before it counts the other tasks naming the payment, and returns it; `launch_update_authority` returns it to `ingest_event`, which keeps it until the record is stored | `task_chain_postgres_tests::two_confirms_sent_together_cannot_both_be_paid_by_one_draw` (three confirms of three tasks, one draw, `tokio::join!`, six rounds: exactly one accepted, two `already paid`). With the lock dropped before the store it fails; restored it passes |
| Server I2: the helper-limit rules looked at 8 wallets in address order, so 8 lower throwaway wallets hid a helper wallet | new `wallet_binding::all_linked_wallets` (every live wallet read, up to 20 records, and whether the read reached the end); rules 1, 2 and 3 use it. An account whose records fill the read (20 or more, revoked ones count) is refused (`TOO_MANY_WALLETS`) because a live helper wallet could be past the read. `linked_wallets` (room, web push, the take caps) is unchanged and still returns 8 | `chain_agent_link_postgres_tests::a_helper_wallet_cannot_be_hidden_among_eight_lower_throwaway_wallets` (rules 1, 2 and 3 each with the helper wallet behind 8 lower ones) and `an_account_with_more_wallet_records_than_one_read_holds_is_refused_not_trusted`. Both fail with the cut back to 8 and with `decide_complete` returning `Ok` |
| Server optional 4: a phone with a slow clock got the final "not shown" while the reader had not stored the draw's block | the confirm is judged by the later of its own time and the server's time | `a_confirm_from_a_slow_clock_is_asked_again_until_the_reader_is_a_minute_past_its_arrival` (fails with the server time dropped) |
| Server I3: guards no test protected | see 8.2 | each row of 8.2 |

### 8.2 Guards that now have a test (each switched off once, the named test failed)

| Guard | Test |
|---|---|
| `from_box` for a plan past its deadline and unpaid | `task_chain_postgres_tests::a_payment_named_for_a_plan_that_ran_out_unpaid_is_held_to_the_network_too` |
| `launched == project_id` filter in `box_lookup` | `a_draw_is_not_counted_under_a_launch_made_for_another_record` |
| `decide_box`: launch not stored, no draw (ask again, then not shown), no wallet, other wallet, other amount, one draw one task, a batch of two pays two | `task_chain::tests::a_box_payment_is_judged_by_the_launch_the_draws_the_wallet_the_amount_and_the_other_tasks` (a pure test; the `!lookup.launched` arm fails it) |
| every rule of `record_step4::pause_from` (13 rows: reads of another contract, parked total, backer Shares, parked over backers, divisor 1 and 101, line, day, zero day, armedAt against the events and against the block, pausesFrom, parkers) | `record_step4_tests::each_rule_of_the_pause_key_leaves_it_null_when_broken` (each broken row gives `None` with the rule's words; the unbroken run gives the key). Removing the day, `armedAt`-after-block and `pausesFrom` rules failed it |
| every rule of `record_step4::earlier_from` (12 rows: no pool, other claim contract, pool not the funded one, empty pool, pool past its bound, 0 rows, too many rows, claimed rows over rows, claimed over pool, events against contract, bound against events, Vester not the project's) | `each_rule_of_the_claim_key_leaves_it_null_when_broken` (removing the Vester rule and the rows rule failed it) |
| `apply_park` sum check and the `Observed` check | `a_pause_event_that_disagrees_with_the_events_before_it_is_refused` (five bent events; both checks off fail it) |
| sponsor `read_allowed` `"pause"` arm (without it `[unpark, leave]` is not an exit on a live server) | `sponsor_postgres_tests::the_allow_list_has_the_treasuries_and_the_pauses_of_the_reader_and_no_others` (reads real `chain_contracts` rows; checks another reader's rows are not used; checks `[unpark, leave]` is an exit with the lists it read) |
| `store::reveals` returning `PauseReady` (late discovery of the pause) | `scan_pause_postgres_tests::the_stored_rows_that_name_the_pause_and_the_claim_contract_are_found_again` (with `PauseReady` out of the query it fails) |

### 8.3 What ran

- `cargo fmt -p buzz-relay --check`: clean. `cargo clippy -p buzz-relay --all-targets -- -D warnings`: clean.
- The relay tests of every module touched, with the Postgres ones (`--include-ignored --test-threads=1`, filters `task_chain chain_agent_link sponsor scan_pause room_ season launch_update wallet_binding record_step4 ledger calldata chain_reader`): **376 passed, 0 failed**.
- The whole relay lib without the Postgres tests: 1946 passed, 1 failed, 742 ignored. The failure is `api::mesh_demo::tests::demo_join_forwarded_arm_round_trips_echo` (HTTP 504 from the sandbox's outbound proxy; the file is not in this round, and the server reviewer saw the same).
- Not re-run: the anvil loops (`chain-loop-pot.sh`, `pot-chain-loop.sh`): nothing they exercise changed (no contract, no record field, no migration, and a record with no box payment takes the same path).

### 8.4 Declined or left, with the reason

- **Money I2 (a disarmed pause has no way back; the card says the wrong thing).** Not fixed in a contract, on purpose: `leave` must never read the pause (the rule that Take out cannot be slowed), so `leave` does not poke it. The app fixer built the press ("Start the day", `HolderPause.poke()`), which closes the gap for people. Two facts for it: `poke()` is permissionless and cannot revert; and the sponsor needs no entry for it: its allow list is by contract address, every contract the reader follows (the pause included) is on it, so the sponsor lets a passkey account's `poke` through, counted against the per-account, per-address and server-wide daily limits like any non-exit call (never as an exit, so it can be refused by a limit; a Take out never is). One statement, the same as section 7.4. The keeper's `pause.poke` job (the role is allowed by migration 0076, no code builds it) was **not built**: it needs a new `HelperCall`, a planner rule, a head check and their tests in the helper, a larger change than the finding asks for, and a missed arm costs no one money; it is the next step if the owner wants the day to start without anyone pressing.
- **G7 draw not tied to the task's own time (Money and Server optional).** Not built. A draw made before the worker took the task can be cited for a later task of the same wallet and amount. Each draw is cited by one task only, only the team signs a confirm, and nothing is paid by it; fixing it needs the take's time against the draw's block time. For the owner.
- **No reader configured: box payments are not checked** (Server optional 6). Unchanged (the module says so); a start-up log line was not added.
- **The `crowded` guard of `box_lookup`** (64 stored confirms read means "paid enough") had no test here; the third round added one (section 10).
- **The 1,000,000-parker bound** of the pause key has no test: it needs a million-entry map. Left (the rule is one comparison).
- **Rule 1 looks at live helpers in every project the reader follows** (Server optional 7): a founder can `setAgent` a wallet a manager has linked. Left, as the reviewer rated it low harm; the refusal says how to clear it.
- **A failed pause or claim read signs the key as `null`; a stream that disagrees (`apply_park`, `Observed`) fails the project's record** (Server optional 8). As RECORD-V2 13.7 says; noted only.
- **Unclaimed earlier rows dilute backers' surplus for ever, also after a wind-down** (Money optional): plan D7, the owner's decision before a real network.

### 8.5 Chosen under the owner's standing go; the owner may overrule

- An account whose binding records fill one read (20 or more, revoked ones included, because a revoked record is still a record and cannot be removed) is refused for a manager profile and for every task step in a chain-following project, rather than trusted. A real person has a handful. The other choice was to ask the network the other way round (which accounts hold each live helper wallet) and refuse nobody; it needs a read per helper and was not cheap.
- The lock on a box payment waits as the season lock does (up to about 7 seconds) and then answers with the season lock's `retry:` words. A confirm that names no payment, or one for a task with a plan the network paid, takes no lock.

## 9. The second fix round (all languages, one engineer)

Against the verifiers' second review: two blockers and the important items that were cheap and safe. No contract, ABI, event, migration, record field or generated file changed, so nothing was regenerated and `forge test` was not run (no `.sol` file is touched).

### 9.1 Closed, each with a test that fails without it

| Finding | What changed | Test, and the result of switching the guard off once |
|---|---|---|
| Blocker: the web test of a repost still parsed an embedded copy | `web/.../social.test.mjs` now asserts an empty content and the `e` and `p` tags; the stale header line of `packages/creaton-core/src/social/post-events.ts` says so | that test (a repost that writes a copy of the post back into the content fails it) |
| Blocker: `biome check` in `packages/creaton-core` failed | `picture-bytes.ts` formatted (one blank line) | `pnpm check` there exits 0 |
| Pre-existing: the image's web settings test failed | the test read only the first of the Dockerfile's two loops that unset an empty setting; it now reads both (the old app's and the new app's) | with a name taken out of the second loop it fails; restored it passes |
| The claim page's three settings were not passed on by the deploy files | the Dockerfile (ARG and the unset loop), `compose.creaton.yml` and `run.sh`'s list now carry `VITE_CREATON_EARLIER_CONTRACT`, `_TEXT_HASH` and `_TEXT_URL`; the guide says so; `deploy/compose/test-app-settings.sh` passes | the same image-settings test (the three names are in its one list); not built as an image (no docker here) |
| App guard: the claim list's total must equal the team's earlier pool | the existing test set a total of 1, which the claimed-total check refused first; it now sets a total above the claims, so only the pool check can refuse | `numbers-step4.test.ts`: with the pool check out, 1 of 31 fails |
| App guard: Take out of parked Shares looked up after a replaced call counts the parked Shares | `park-flows.test.tsx`: a take-out goes out, is replaced and does not land; wallet 600 and parked 400 are still 1,000 held, so it is not taken for landed and a new call is sent | with the parked term multiplied by zero, that test fails |
| App guard: the claim page re-checks the wallet's account before it sends | `earlier-grant.test.tsx`: the wallet shows another account at the press; nothing is sent and the page says the link is not for it | with the re-check out, that test fails |
| App guard: a brain copy that downloaded but cannot be read is wiped | new `brain-git-wipe.test.ts` (the git library and the file store are stand-ins that count) | with the wipe out, the test fails |
| Text, not markup, on posts | `post-text.test.tsx` (a post with an image tag and a script tag is drawn as its own characters) and `post-actions.test.tsx` (the same in a quoted post). The search, topic and saved lists draw posts with the same component | with `dangerouslySetInnerHTML` in `PostText` the new test fails (biome's rule `noDangerouslySetInnerHtml` also refuses it) |
| Server guard: the warning-day rule of `record_step4::pause_from` was caught by no test | three rows in `each_rule_of_the_pause_key_leaves_it_null_when_broken`: a day that is not a seventh of the unit with `pausesFrom` moved with it; a day of nothing with `pausesFrom` moved with it; a day of nothing on a unit of 0. The rows now match the day rule's own words ("a seventh of the"); the pausesFrom rule also says "warning period", which is why the old rows passed with the day rule out | with `p.day != ledger.unit / 7` out the test fails; with `p.day == 0` out it fails; both with the unbroken book giving the key |
| Server test: the box-payment lock test was timing dependent | the three confirms now run on separate threads (`multi_thread`, `tokio::spawn`) for 32 rounds, not three futures on one task for 6 | with the lock released before the lookup (no lock at all) it fails in the first round, twice in two runs. With the lock released only just before the record is stored (the narrowest window), 16 rounds failed in 2 of 3 runs: a single green run is weak evidence for that mutation, and the test says so in its comment; run it a few times when the lock is touched |
| A refusal that gave advice that cannot work | `TOO_MANY_WALLETS` said "unlink the ones you do not use", but a revoked record cannot be removed. It now says "use another account for this". Tests use the constant | the tests that name it |

### 9.2 What ran

- `app`: `biome check .` clean, `tsc --noEmit` clean, `check:copy`, `check:px-text` and `check:file-sizes` (with `CHECK_FILE_SIZES_BASE` set, because this sandbox has no `origin/main`) pass; **vitest: 227 files, 2,092 tests, all passed**.
- `web`: `biome check .` clean (0 errors); **`pnpm test`: 3,502 tests, 3,501 passed, 0 failed, 1 skipped** (the failing image-settings test and the repost test now pass).
- `packages/creaton-core`: `pnpm check` exits 0; **`pnpm test`: 1,283 tests, 1,282 passed, 0 failed, 1 skipped**.
- `deploy/compose/test-app-settings.sh`: PASS.
- `buzz-relay`: `cargo fmt --check` clean; `cargo clippy -p buzz-relay --all-targets -- -D warnings` clean. The relay tests of every module touched, with the Postgres ones (`--include-ignored --test-threads=1`, filters `task_chain chain_agent_link sponsor scan_pause season launch_update wallet_binding record_step4 ledger calldata chain_reader`): 334 passed and 1 failed: `chain_agent_link::tests::every_refusal_says_how_to_clear_it`, which required the word "unlink" in the changed sentence. It now requires "unlink" in the three sentences it is true for and "use another account" (and no "unlink") in `TOO_MANY_WALLETS`; `chain_agent_link` was run again: its 4 non-Postgres tests pass (its Postgres tests were in the 334). The lock test alone, on the final code: passed twice in a row (36 seconds each, 32 rounds).

### 9.3 Not built, and why (for the owner)

- **The brain download's inflation bound.** The download is capped at 1 MiB, but nothing bounds what a crafted pack inflates to in the viewer's browser tab (up to about 1 GB by the format's own ratio). It happens only after a person presses to open a project's brain and only if the server serves a hostile repository; the result is a tab that crashes, not lost money or data. The real fix is a size-limited read on the server (or a pack-stream bound in the library); neither is small. Open.
- **Avatars.** Unchanged: an https avatar makes the viewer's phone ask that website for it. The owner chooses between server-only avatars and saying it in the privacy text (section 7.3).
- **An account with 20 or more wallet binding records** (revoked ones count) is refused for a manager profile and for every task step in a chain-following project, and cannot clear it (a revoked record cannot be removed). The sentence no longer says it can; a cleanup path (or asking the network the other way round) is the owner's choice. A real person has a handful.

### 9.4 Chosen under the owner's standing go; the owner may overrule

- The second loop of the Dockerfile is read by the image-settings test as a second list of the same kind, rather than the two loops being merged into one: the old app's names and the new app's names stay in their own stages.
- The claim page's three settings are passed on without the Dockerfile checking them (the app checks them itself and fails closed: a wrong or half-set value means no claim page, with no message at build time). Checking them in the Dockerfile too would be a second copy of the rule.
- The sentence for too many linked wallets tells the person to use another account, the one remedy that works.

## 10. Third round

Against the third verification: three test-only failures, nine test gaps and three smaller items. No contract, ABI, event, migration, record field or generated file changed, so nothing was regenerated and `forge test` was not run. The only production change is a seam that exists in test builds only (`task_chain::box_seam`, behind `#[cfg(test)]`); the lock itself is untouched.

### 10.1 Closed

| Item | What changed | Result of switching the guard off once |
|---|---|---|
| B1: `check-mutations.py --check` failed | the "no-text-check" entry named the claim's old variable (`acceptedText`); it now names `accepted`, which the source has used since the rename | `--check`: every entry applies, exit 0; `--only no-text-check`: killed by `EarlierGrants.t.sol` |
| B2: the browser journey quoted the old words | `pot-plan.spec.ts` now expects "has not named an account to be paid at" (the server's own sentence still says "wallet": the app maps it to the "account" words, as the app's copy file does) | the other places that quote it already used the new words |
| B3: the image-settings test | it already passed at the start of this round (the second round had fixed it). It now also reads each Dockerfile stage on its own: the old app's stage holds no `VITE_CREATON_*` name, the new app's stage holds only those, and each stage's arguments are exactly the names its own loop unsets | with one name taken out of the new app's loop, the test fails |
| G1 quoted post waits for the hidden list | new `QuotedPost.test.tsx` (the quoted post arrives at once, the hidden list 600 ms late: the card says "loading", never the words, then "You hid this post.") | `!ready` removed: fails |
| G2 text as text | new `safety/text-as-text.test.tsx`: a post, a quoted post, a person's about line in search, a post found by search, a topic's list and the saved list each draw `<img ...><b>..</b><script>` as the characters written | an about line and a quoted post drawn as markup: each fails |
| G3 take back | `park-flows.test.tsx`: a wallet that shows another account at the second press sends nothing and says so; a take-back that went out and did not land is sent again, and one that landed under another hash (fewer Shares parked) is not sent a third time | account check off: fails; "landed" check always false or always true: fails |
| G4 pause words and record rules | `team-pause.test.tsx`: a record that names a pause but no pause contract shows nothing and reads nothing; `numbers-step4.test.ts`: two rows where only the "since" rule is wrong (paused with a since that is not the start; armed and not yet paused with a since set); the "earlierGrants.total equals the team's earlier pool" row already existed and fails with the check out | `has` without the contract: fails; since rule out: both rows fail |
| G5 claim page | `earlier-grant.test.tsx`: a record that names another claim contract than the build's is never used; the largest place and amount are readable and one past either is no link (the link is made with the page's own link maker: the older list of bad links is made with `btoa`, whose padding is refused for its shape, so those rows do not test the bounds); the account re-check test already existed | contract check out, the two bounds out (also at the edge): each fails; account check out: fails |
| G6 take out and brain | `park-flows.test.tsx`: a take-out that landed under another hash (wallet and parked both smaller) is not sent twice, beside the existing test that parked Shares count as held; `brain-git-wipe.test.ts` already covered the wipe | `inWallet + parked` without parked: fails; always false: fails; wipe out: fails |
| G7 warning-day rule | already covered by the second round (cases that change the day and pausesFrom together); checked again | day rule out: `each_rule_of_the_pause_key_leaves_it_null_when_broken` fails |
| G8 the "crowded" guard | new `a_payment_that_sixty_four_confirms_already_name_has_paid_enough`: 63 stored confirms for one task paid elsewhere let the next confirm through, 64 refuse it (the other-task count alone would not) | guard out: fails; new `only_a_task_that_names_no_helper_offers_its_pay_to_the_helper_limit` for the task-helper early return: early return out, fails |
| G9 the lock test depended on timing | the test no longer runs 32 rounds hoping for the race. Each of the three confirms waits at `box_seam::counted` (after its count, before its store, inside the lock) until all three are there, or one second passes. With the lock only one can be there; without it all three arrive together and all are stored. One round, about 2 seconds | each confirm given a lock of its own: fails, every time |
| O2 | section 7.4 and 8.4 now say the same true thing about "Start the day" for a passkey person: the sponsor lets it through (the pause is on its allow list by address); it is an ordinary operation, so it counts against the daily limits and can be refused by one, which a Take out never is. New `sponsor::tests::a_start_the_day_poke_is_allowed_and_counts_like_any_other_operation`. `DEPLOY-TEST-NETWORK.md` says in one sentence that the "Paid" check on box payments works only where the server's chain reader is on. The header of `post-events.ts` already said a repost has empty content and an `e` tag (corrected in the second round); nothing more to change | |

### 10.2 Not done

- **O1, a bound on what the brain download inflates to: not built.** isomorphic-git (1.38.10) inflates every object of the pack inside `listpack` (`pako.Inflate`, pushed chunk by chunk) while it indexes, and checks the inflated length against the length the pack states only after the whole object is inflated; it offers no option, callback or stream the app could use to stop earlier (`onProgress` reports object counts, not bytes). What would be needed: a change to the library's `listpack` (carried in `patches/isomorphic-git.patch`, which today only fixes the package's export map) that stops an object once `inflator.strm.total_out` passes its stated length and stops the pack once the stated lengths pass a cap, with the lock file's patch hash regenerated by `pnpm install`; that also changes the old web app, which uses the same library. The alternative is a size-limited read of the four fixed files by the server. The 1 MiB cap on the download stays, and so does the worst case of about 1 GB in a tab.

### 10.3 What stays open for the owner

- **Avatars from any https address**: drawing a person's picture makes the viewer's phone contact that address. Either draw avatars from this server only, or say it in the privacy text.
- **An account with 20 or more wallet records** is refused for a manager profile and for chain task steps, and cannot clear it (a revoked record cannot be removed).
- **Unclaimed earlier rows stay claimable with no end time**, and keep diluting backers' surplus, also after a wind-down.
- **The pause's far bound of one million parkers is untested** (it would need a million-entry map; the rule is one comparison).

### 10.4 Chosen under the owner's standing go; the owner may overrule

- The seam for the lock test lives in `task_chain.rs` behind `#[cfg(test)]` rather than in a separate test-only crate: it is a small test-only module and two lines that are not compiled into the server.
- The one-second wait in that seam is a time limit on a barrier, not a sleep: with the lock in place the barrier can never fill, so the limit is what ends the wait.
- B3 was already green at the start of the round; the test was tightened instead of left as it was, so that the old app's list cannot quietly gain a new-app name.
