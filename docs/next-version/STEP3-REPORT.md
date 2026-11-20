# Step 3, joined up: the project page, the live feed, the holder room, the badge, the ranking, seasons and alerts, run together in a real browser

Branch `v6`, 20 November 2026. This is the report of the last package of `STEP3-PLAN.md` (A5): the joined-up loops, the cross-language
check and this page. Step 3 puts four things in front of people on top of step 1's money and step 2's task queue: **a project's page that
can be understood on one phone screen** (with a share link, a share picture and an "Established" chip), **a live feed and a room for the
people who hold it**, **a ranking of the money that has stayed 30 days or more and seasons with a demo day**, and **short alerts on a
phone that is away from the app**. The server (P1 to P3) reads it all from the chain and the relay's own rules; the app (A1 to A4) draws
it. Everything is committed on local branch `v6`; **nothing is pushed**. **No person has tested any of this: every run below was made by
an agent. The human test is the owner's and is still to do (the steps are in section 9).** This is not legal or tax advice, and no figure
here is a promise of any result for anyone. Every amount is play money on a local test chain; nothing here changes a contract or a money
rule. The legal line, quoted as it stands: "Buyers acquire ownership only: governance and exit. No dividends or revenue share, ever,
unless they contribute and earn one."

Companion pages: the plan (`STEP3-PLAN.md`), the record's one specification (`RECORD-V2.md`, sections 11 and 12, and
`record-v2-example.json`, the server's own output), the room and seasons (`ROOM-AND-SEASON-RECORDS.md`), the server's report
(`READER-V2-REPORT.md`, its step 3 sections), alerts (`../web-push-deployment.md`), and the earlier steps' (`STEP1-REPORT.md`,
`STEP2-SERVER-APP-REPORT.md`).

## 1. What is built, in one page

| Part | What it does | Where |
|---|---|---|
| Server: the reader (P1) | four new keys in the signed numbers record, all from logs and bounded: `held` (the lowest balance of each account over a window, worked out inside Postgres with the limit inside the read), `feed` (48 hourly buckets of joins and take-outs, the net rounded to the nearest 100, and up to 30 items), `streaks` (updates in weeks in a row) and `established` (the badge's three inputs and the server's verdict); one small signed **ranking index** (`d = explore`, at most 20 entries, about 1.4 KB for three); two indexes and five columns (migration 0073); the example and fixture regenerated, an independent Python recomputation | `crates/buzz-relay/src/chain_reader` |
| Server: the rules (P2) | who may write in a project's room is decided from the network (holding at least 0.001 Share now, or a Team grant with something left to claim, or one time unit after taking out), never from a person's word; an event that answers a room post is a room event whatever tags it carries; the team removes a post or stops a person writing (and the stop follows the person's linked wallets); seasons: the operator's record (kind 37021), entry and leave by the project's team, an operator's removal, 500 per season and 3 per founder under one lock; public reads; `buzz launchpad seasons start/show/remove` | `crates/buzz-relay/src/handlers`, `crates/buzz-cli` |
| Server: alerts and the fee limit (P3) | web push, off unless the operator sets a key and a contact: subscriptions kept by a signed call, an alert maker that starts at the chain's position (never the history), a sender with backoff, a terminal state and a pause when the service refuses the operator's key; encryption per RFC 8291 and 8292 proved against the RFCs' own vectors; a daily limit on sponsored fees that never counts or refuses a way out | `crates/buzz-relay/src/web_push`, `api/sponsor*` |
| App: the page (A1) | the banner "You can take your money out any time. Nothing here promises a profit." on every page and sheet, once; the project page in the order name, money with "This can go up or down. It is not a return.", what taking out now would give, play money, banner, then Back and Share; the share sheet and a picture drawn on the device; the Established chip and its sheet; "Money that stayed" on Home from the server's one index | `app/src/features/{project,home,money,pot}`, `app/src/app` |
| App: the feed (A2) | "Lately": the team's items, "Last 2 days: 2 backed, 1 took out.", one net sentence, hours behind a press; and "You have held it for N weeks", worked out on the device from the person's own transfers | `app/src/features/{feed,pot}` |
| App: the room (A3) | the room tab (anyone reads; who may write is shown from the same rules the server applies), composer with "Posts and votes are public.", cards with author-named actions, report, hide with Undo and "Hidden people", team remove and stop, perks, the "New" dot, and Back ending by linking the account to the wallet (a phone account signs the link with its passkey) | `app/src/features/{room,posts,team}` |
| App: seasons and alerts (A4) | the season band on Home (enter and leave by the team), the demo day page (24 at a time, a hash order that is never money), the alerts card on You, the worker's three fixed sentences | `app/src/features/{season,alerts}`, `app/public/sw.js` |
| This package (A5) | the three joined-up journeys against a real relay and a real chain, the cross-language check, the passkey link proven on the real account contract, this report | `app/tests/e2e-pot-full`, `scripts` |

## 2. What this package built

1. **`app/tests/e2e-pot-full/pot-room.spec.ts`**: one journey, 300 checks. A founder starts "Lantern" in the app and launches it. A visitor
   with no account and no wallet opens its link: name, "This can go up or down. It is not a return." under the money, what taking out now
   would give for each Share, the play-money line, the banner once word for word, exactly one Back box, all in view on the first phone
   screen; Share gives the project's own link and a picture whose description has no amount or gain; the server's own link preview names
   the project and carries no amount. Two people back it in the app (each Back ends by linking the account to its wallet with no extra
   screen) and one takes out. The feed reads "Last 2 days: 2 backed, 1 took out." and "About 100 dollars more came in than went out.";
   every amount in the record is a whole 100 dollars; no name, no address, no "volume"; joins and take-outs have the very same classes.
   An account with no linked wallet and a stranger are refused in the server's own words; the two holders write (Control+Enter), a
   visitor reads both, the team removes one post (the server stops serving it) and sets perks (every other tag of the project record
   unchanged, the chain key still there). The person who took out writes again inside the unit; after one time unit on the chain's clock
   the server refuses them ("only people who back this project can write in its room") and the app shows the room read only; a holder
   still writes a week later. The record is compared with the contracts' own views (`scripts/chain-loop-pot-check.py`, which also
   recomputes the four step 3 keys from the node's raw logs, 261 checks at that stop).
2. **`app/tests/e2e-pot-full/pot-seasons.spec.ts`**: one journey, 1,691 checks. One founder starts Alpha (ten holders and a Pair), Beta (ten
   holders, one signer) and Gamma (three holders). The operator starts season 1 with the real `buzz` command; the founder enters Alpha and
   Beta from Home; a stranger's entry for Gamma is refused. A month on the chain: no project has the badge (Alpha has its ten accounts and
   its two signers but its money has not stayed 91 days; held 0 of 6,000 bps). Home ranks Beta, Gamma, Alpha by money that stayed 30 days
   or more with the number of different accounts beside each ("by 10 people", "by 3 people") from the one signed index (1,417 bytes plus six project
   records of 3,860 bytes; the page's whole traffic from the server was 8,411 bytes). A late buyer makes Gamma's pot the biggest and the ranking does not
   move. A quarter in: the badge appears on Alpha only (10,000 bps held 91 days, ten accounts, two signers); Beta has the money and the
   accounts but one signer; Gamma has too few accounts; for each project and at each stop, the server's `reached` equals the rule applied
   to its own three inputs and the page shows the chip exactly when it is true. On demo day (the season's own clock) Home says "Demo day:
   2 projects show what they made.", the page lists exactly the two entered projects in the season's hash order with each one's money from
   its signed record and last update, once the banner and once the line, and not Gamma. 1,648 of the checks are the field-by-field
   comparison with the contracts at three stops.
3. **`app/tests/e2e-pot-full/pot-push.spec.ts`**: one journey, 28 checks, in a world whose relay has web push switched on from its
   environment (a key made for the run, never written to a file) and a local stand-in for a push service
   (`scripts/web-push-standin.mjs`). The browser's push manager is a small fake that hands the app the stand-in's own device; everything
   else is real. A holder backs in the app and turns alerts on from You (the browser is asked once, the server keeps one device). The team
   plans a task. The stand-in receives one message and decrypts it with the device's keys: exactly `v`, `k` and `r`, kind `planned`, the
   link people already share, under 200 bytes, a verified operator token, a 32-character topic, TTL one day. The real `app/public/sw.js`
   (run as a browser runs it) shows its fixed title and the fixed sentence for `planned`, opens the project, drops a kind it does not know
   and shows nothing the message adds. The same news is on You in the app's longer words (see choice A5-2). After "Turn off" the server
   keeps no device; a second plan makes an alert and reaches nobody, and no send is written.
4. **`app/tests/e2e-pot-full/world.ts`**, **`scripts/pot-full-loop.sh`**: the helpers (start and launch in the app, Back in the app, the
   operator's `buzz` command, the stand-in, the server's database counts, the page clock) and five worlds in one run (step 1's, step 2's
   and these three), each with its own chain and server. The loop makes a key for the operator and one for push per run (in the
   environment only), moves anvil to 14 accounts (ten holders), and raises the browser run's limit to 1,500 seconds (the seasons journey
   waits for the server's own ten-minute pace).
5. **`scripts/check-cross-language.mjs`**: 14 checks that tie what exists in two languages: the room's 2,000-character limit (Rust and
   the app's `MAX_POST_CHARS`, which the composer uses), the three alert kinds (the server, the worker file run as a browser runs it, the
   app's words) with the worker's three sentences and title equal to the app's, the message's three keys, and the sponsor's refusal words (the
   server's list equals the app's own pattern and each refusal holds one; "not reachable" is not taken for a refusal).
6. **A passkey account's link on the real account contract** (`app/tests/anvil/passkey-sender.test.ts`, run by `scripts/phone-loop.sh`):
   the account is deployed, the passkey is asked once for the link, and the account's own ERC-1271 check says yes for that link and no for a
   link naming another Nostr account. Until now only fake assertions had been tested.

## 3. What ran, and the exact results

All on this machine (4 CPUs), Node 22, anvil and forge from the scratchpad's Foundry, Postgres and Redis running, the relay and `buzz`
built from HEAD's Rust (the binary is newer than every Rust source except one test file).

| Run | Result |
|---|---|
| `scripts/pot-full-loop.sh` (five worlds, from the committed state) | **4,375 checks passed**, 0 failed: step 1's journey 699 (37.6 s), step 2's 1,657 (1.3 min), the room 300 (1.1 min), seasons 1,691 (10.3 min), push 28 (42.5 s); the reader never refused to sign in any world. The checks of the last four worlds that compare the record with the contracts are counted in these numbers (261 in the room, 1,648 in seasons) |
| `scripts/pot-app-loop.sh` | 17 tests passed, 0 failed, 0 skipped, in 11 files (the app's own call builders and readers against the real contracts, including "how long you have held it") |
| `scripts/chain-loop-pot.sh` (a real relay on a real chain, the social check at every stop) | 2,936 checks passed |
| `scripts/phone-loop.sh` | 14 tests passed in 3 files; **35 claims proven**, including the two new ones (a passkey account's link, accepted by the account itself and refused for another account's link) |
| `scripts/web-push-loop.sh` (P3's loop, real relay, stand-in) | 28 checks passed |
| `scripts/room-loop.sh` (P2's loop, over the wire with the real `buzz` command) | 55 checks passed |
| `node --experimental-strip-types scripts/check-cross-language.mjs` | 14 checks passed |
| `app`: `tsc --noEmit` | clean |
| `app`: `vitest run --maxWorkers=2` | 179 files, **1,678 tests passed**, 0 failed |
| `app`: `biome check .` | clean, 588 files |
| `app`: `check:copy`, `check:px-text` | pass |
| `app`: `check:file-sizes` with `CHECK_FILE_SIZES_BASE=35ea0a894` (this clone has no `origin/main`) | pass |
| `app`: `pnpm build` with `CREATON_DEPLOYMENTS_FILE` set, and its bundle budget | built; entry chunk 416 KiB against the budget of 450,000 bytes ("ok"); all scripts 1,233 KiB |
| `packages/creaton-core`: `pnpm test` (not changed by this package) | 1,239 tests, 1,238 passed, 0 failed, 1 skipped |
| `cd web && pnpm check:unused` (knip) | no findings |
| Playwright `smoke` project, `--trace off`, a random port, the real anvil | 127 listed, **126 passed, 0 failed, 1 skipped** (`pot-phone`, which skips in this build), in 8.8 minutes |

Not run in this package: `cargo` anything (no Rust file was changed here; the relay and `buzz` binaries are those built from HEAD's Rust, and
the Rust test counts are in the server reports above), `just ci`.

## 4. The journeys, step by step

See section 2 for the three; the checks are printed one line each by `scripts/pot-full-loop.sh` (`ok NNN ...`). Step 1's and step 2's
journeys ran again unchanged on the step 3 app and passed (section 3), so the new page, banner and room did not break the old flows.

## 5. Why five worlds

The chain's clock is moved by days in most journeys, and the server dates a record by its own wall clock: a chain that is a month ahead
cannot be reused for a journey that expects a fresh record. The push world is the only one with a stand-in and a push key. The seasons
journey takes about ten minutes because the server looks at its ranking index every ten minutes of its own time (finding F1).

## 6. What the loops showed

**F1. The first ranking can come ten minutes late (server, P1; not fixed).** The first run of the seasons journey failed with "the server
never signed its ranking index" after waiting two minutes for it. The reader looks at the index every 600 seconds and spends that turn
even when nothing could be listed yet (`chain_reader/mod.rs`, `explore_after`), so on a new server the first index appears up to ten
minutes after the first money has stayed 30 days, and after a change the next one waits ten minutes (this is the plan's own pace). On a real
network that is invisible; in a loop it is the longest wait. The journey now waits up to twelve minutes and says so. A fix would
look again soon (say a minute) while the last build found nothing; it is a few lines in `mod.rs` and a change to the test of the schedule
(IX3), and needs a Rust build and the Postgres tests, which this package did not run, so it is left to P1 or P2.

**F2. An unchanged ranking index is never signed again, so it hides after a day (server, P1; not fixed; found by A1, confirmed here by
reading the code).** `explore::publish` returns at once when the entries are the same as the live index's. Home hides an index older than 24
hours. On a quiet network the ranking therefore disappears after a day. The fix (sign again when the live index is older than about
twelve hours even if the entries are the same, and change IX3) is about five lines; it was not made for the same reason as F1. The loops
cannot show it (it needs a day of the server's own clock).

**F3. A page's clock cannot be moved before it loads (test world, not a defect).** To show "one time unit after taking out" the browser's
clock has to be a week ahead of the computer's, because the app judges the unit by the page's own clock while the chain's clock was moved. A
page loaded with a clock a week ahead cannot sign in at all (the server refuses a sign-in dated that far ahead). The journey moves the
clock in place on a page that is already signed in, then opens the room again. The app and the server agree: read only.

**F4. "Back this project" is the heading of the Back box, not a button (spec, not the app).** The first run of the room journey looked for a
button of that name. The app has one Back box (a region with that heading, an amount and a button "Back"); the journey now checks
exactly one box and one heading.

**F5. What Home reads for the ranking.** One index record (1,417 bytes for three entries; at most about 4 KB for twenty) and the project
records of the entries it names (six project records, 3,860 bytes, for three projects: the page's own project list and the ranking's
entries); no numbers record at all for the ranking, because the line under each name comes from the index. The plan's bound (the index and
at most ten project records) holds.

**F6. The push for a plan is shorter than the news in the app, by design.** The device shows "A task was planned on a project you back. You
can take your money out first." The news on You says who would be paid how much and from when. Both end with the way out. The brief asked
for "the same words"; the plan (6.4 and 7.8) says the push carries no amount, name or date, so it cannot be the same words. They are the
same news at two lengths, and the journey checks that the kind, the project and the way out match (choice A5-2).

No defect was found in the app by these journeys: the app files were not changed by this package. Step 1's and step 2's journeys, the
room, the feed, the badge, the ranking, the season and the alert all did on a real server what the app's own browser specs
(which use a mock server) had shown.

## 7. Guards switched off once each (A5's), and the result

| Guard | Switched off by | Result |
|---|---|---|
| the room's limit is one number in two languages | the server's limit set to 2,001 | `check-cross-language` fails: "the room's limit on the server equals the app's MAX_POST_CHARS: got 2001, expected 2000" |
| the worker shows exactly the server's alert kinds | the worker's key `planned` renamed | fails twice (the kinds, and the three sentences equal the app's) |
| the server's kinds are the app's | the server's `taken` renamed `took` | fails three times (server, worker, app) |
| the sponsor's refusal words are the app's pattern | two words taken out of the app's pattern | fails twice (the list, and "daily limit exceeded" is recognised) |
| the message has three keys | a fourth key added on the server | fails |
| joins and take-outs have equal weight | the join count given a larger text class in the app | the room journey fails: "joins and take-outs are drawn with the very same classes (equal weight): got num font-semibold text-lg, expected num font-semibold" |
| the room is read only after one unit (the app) | the unit after taking out never ends in the app's standing | the room journey fails at "the composer is gone" (expected 0, received 1) |

The server and app guards of P1 to P3 and A1 to A4 were each switched off once by their own engineers (tables in their reports, and in
`READER-V2-REPORT.md`); this package did not repeat them.

## 8. Choices made under the owner's standing go (the owner may overrule), gathered from every report

**Chosen under the owner's standing go; the owner may overrule**

*This package (A5)*
- A5-1. The default run is five worlds, one journey each, and the seasons journey takes about ten minutes because of F1. The browser run's limit is 1,500 seconds.
- A5-2. "The same words as the in-app alert" is read as "the same news": the device's alert is the plan's fixed sentence for the kind (no amount, no name, no date), the app's alert is the longer one. The journey ties the kind, the project link and the way out, and ties the worker's sentences to the app's words by value.
- A5-3. The Established badge is shown in a real world for all three of its inputs failing one at a time (money not held long enough, one signer, too few accounts) and for all three holding. A project with ten accounts is made from anvil's accounts 2 to 6 and 8 to 12 (the chain now has 14); the Pair is made the way the app makes it (an offer to the Pair's address, then the other signer's acceptance).
- A5-4. The seasons' demo day is made to come four minutes after the operator starts the season by starting it one day less four minutes ago with `--days 1` (the shortest the rule allows).
- A5-5. The push world's browser has a fake push manager that gives the app the stand-in's own device; the real service worker file is run in an isolated context (as `push-sw.test.ts` does) because headless Chromium here refuses to show a notification.
- A5-6. A second plan after "Turn off" is made on the chain by the team's wallet (the same call the Tasks tab sends) and not through the Tasks tab again: what is under test is the server's refusal to send, not the form.
- A5-7. The alert on the phone opens the project (A4's choice 1), not You.

*P1 (the reader)*
The changes index holds `log_index` too (the plan's index sorted every row of the window before the limit, so its bound was not real); the window's first block is a scalar subquery; the first-block index is `(reader, block_time)` and does not hold `number`; `seen` of the ranking index counts projects that passed the tie and standing is asked down the sorted list, at most 100 asks; no index is signed when there is nothing to list; a change at exactly the window's start belongs to the start balance; a database error in the held count counts as a failed key. Held windows are 30 × (unit ÷ 7) and 13 × unit seconds; the caps are 500,000 change rows and 20,000 accounts per window, and a window over a cap gives null for that window only, never a smaller number. A person can push a project's `held.badge` to null with many one-wei moves (display only).

*P2 (the rules)*
Kind 37021 is taken for the season record (it is used nowhere in the tree; moving it is one constant and `just regen-kinds`). Every `e` tag of a room event must name a stored post of the same room, not only the root. Rate limits follow the plan's C24 (12 posts an hour and 60 events a day per account per room). A team removal is recorded as the authority `board_moderator` in the audit row and `project_team` in the public log. Leave is accepted only while entry is open. A project may change its place 12 times per season. A wallet with more than 5 live bindings stops writing for all its accounts. Public room reads serve the newest 200 posts and 400 likes of one room; a season read serves at most 50 records; a lineup read the newest 700.

*P3 (alerts and the sponsor)*
Any 2xx counts as delivered; a row's age is measured on the chain's clock; a plan the chain already shows as withdrawn makes no alert; a `gone` device and its rows are deleted together; no `failures` column on the device row; operator-listed extra hosts may be plain http and may resolve to a private address (for a local stand-in only); the 10-requests-an-hour limiter is per process; the audience cut is counted up to 100,000; `/sponsor` is an exact path in the NIP-FI exempt list and `/push/web` is not; the sponsor total key is per reader; push and the sponsor each need the chain reader.

*A1 (the page)*
At 360 × 640 "in view" means above the fixed tab bar, so the page was compacted (smaller title, chips on the money card's first line, play-money line inside the money card, Back and the amount in one row); the founder-line filter on the card also drops lines that mention money, cash, income, wealth, rich, doubling, interest or passive; the shell's banner sits in flow above the tab bar, not fixed; the top of the page has its own stale-money id; an empty ranking says "that long" when no window is known; "weeks in a row" is said literally even on a test chain with a short unit; Details always has "What “Established” means".

*A2 (the feed)*
Five items first, ten more per press; "Last {window}" is built from the record's own buckets; a net that rounds to nothing with one side only says "The amounts were too small to show."; task dates carry the time; items older than the record's hours are not re-dated; the weeks line is not drawn when the sender cannot say a block's time; the feed's "as of" is one line under the title; a holding that went to zero and back within one block does not reset.

*A3 (the room)*
The sheet's own corner Close is the visible Close (form sheets also have "Not now"); "More actions" opens a sheet of presses; when the app cannot read what the person's wallets hold the room shows the read-only line and Back, not a composer; a "not holding" refusal for a person offered a composer is said as "Not ready yet. Try again in a minute." and retried once; Back in the room scrolls to and focuses the Back box (not drawn twice); the hide confirmation is an inline note with Undo; "Hidden people" lists everyone on the person's own private mute list; answers are written inline; Control or Command with Enter posts; the "30 days" stop runs 5 minutes short; the pinned notice is the newest of the team's updates and work handed in; the "New" dot reads ", new"; the unsent draft is kept in `sessionStorage` per project; the five report choices map to the server's types with no note field; the room names writers from a profile read of at most 100.

*A4 (seasons and alerts)*
A press on the alert opens the project (the plan says You); the device shows the three fixed sentences, not the in-app words; the band shows demo day first, then open entry, then the next start, then the last season that ended; demo-day order is a 53-bit hash of the season and the project's address (it can be ground by choosing a project id: one position on one page that carries no money rule); the first pass over entries is a candidate rule and the second is the exact check, so the first batch of 24 can hold fewer than 24 cards while "Show more" is still offered; the band offers at most 5 of a person's projects; visible "Leave" and "Open project" with longer accessible names that contain them; turning alerts off stops the browser first and a server that cannot be reached is remembered and retried; the device is saved again after 30 days when the app is opened (no `pushsubscriptionchange` handler, because the worker cannot sign); "needs a link" applies only when the link is none or expired; on Show more the keyboard goes to the first new card; the demo card shows the pot as the project's page does and nothing for a record older than a day; where investing is off, `/season/$n` says seasons are not shown here and reads nothing.

## 9. Try it on a phone on a local network (the human test is yours; nothing below was done on a phone)

What you need on the computer: Foundry (`anvil`, `cast`, `forge`), Node and pnpm, Postgres and Redis, the relay and the `buzz` command built once
(`cargo build -p buzz-relay -p buzz-cli`; the scripts never build), `contracts/pot` built once, and a phone on the same network with a
**browser that has a wallet** (a wallet app's own browser). Part A uses the step 2 script and its Lantern project.

**Part A: the page, the feed and the room (about fifteen minutes).**

1. In the repository: `. ./bin/activate-hermit`, then `scripts/pot-full-loop.sh --serve` (add `SERVE_HOST=<the computer's address on your
   network>` if its first address is not the one the phone reaches). It takes about two minutes and prints the app's address, the chain's
   address and the steps. Leave the window open: Ctrl-C stops and removes everything. Use a network you trust (the chain's accounts are public).
2. In the phone's wallet add the network the script prints (chain id 31337) and import development account number 2 (the script prints the
   command that shows its key; it is public and worth nothing).
3. Open the app's address in the wallet's browser **without signing up**. **What working looks like:** the project's name, then its money
   with "This can go up or down. It is not a return.", "Taking out now would give {an amount} for each Share.", a line that this is a test
   network and the dollars are play money, the banner "You can take your money out any time. Nothing here promises a profit.", and a box
   "Back this project" with an amount and a Back button, all without scrolling on a phone. Press **Share**: the project's link, a Copy press
   and a picture with the name and nothing about money.
4. Open the **Room** tab: "Anyone can read this room. Only people who back the project can write here." and no place to write.
5. Sign up, get play dollars, Back with 25. After the second press, wait a few seconds: the app asks the wallet to sign **once more** (this
   confirms that your account is the wallet's) and then the Room tab offers a place to write under "Posts and votes are public." Write
   something. Another browser with no account can read it.
6. Under the money, **Lately** reads "Last 2 days: N backed, M took out." (N counts the project's first backing too) and a sentence about
   how much more came in than went out, with "Amounts are rounded to the nearest 100 dollars. No names are shown." Nobody is named.
7. Press **Take out**. The room still lets you write for one time unit ("You took out ... You can write here for ... more"). A unit is a
   week on this chain: from the computer run `cast rpc --rpc-url <the printed chain address> evm_increaseTime 700000`, wait two seconds,
   and reload: the room is read only for you ("Only people who back this project can write here.") and the server refuses a post.

**Part B: what you cannot try this way, and the full run.** A season needs the operator's key and ten accounts, an alert needs a secure
address (a service worker and a push service need `https`), and a passkey account needs a bundler and a sponsor: none of these can be
tried on a local network from a phone. The full run, `scripts/pot-full-loop.sh`, does them with a stand-in for the push service and the
real server, chain and app in a computer's browser; section 10 says how to run it again. Seasons are only in the full run (the operator's key is made inside the run and is never written down).

If something differs from what is written here, that is a finding: write down the step and what the screen said.

## 10. How to run it again

- Everything: `scripts/pot-full-loop.sh` (five worlds, about 25 minutes). One journey: `scripts/pot-full-loop.sh pot-room.spec` (also
  `pot-seasons.spec`, `pot-push.spec`, `pot-full.spec`, `pot-tasks.spec`); `SHOTS_DIR=<folder>` keeps its screenshots.
- The step 3 chain-only checks: `scripts/chain-loop-pot.sh`, `scripts/room-loop.sh`, `scripts/web-push-loop.sh`, `scripts/pot-app-loop.sh`,
  `scripts/phone-loop.sh`, `node --experimental-strip-types scripts/check-cross-language.mjs`.
- The app's checks: in `app/`, `CHECK_FILE_SIZES_BASE=<a commit> pnpm check`, `pnpm exec vitest run --maxWorkers=2`, `pnpm build` with
  `CREATON_DEPLOYMENTS_FILE` set (the bundle budget), `pnpm exec playwright test --project smoke --trace off` (build first); `cd web && pnpm check:unused`.

## 11. Declined, with the reason

- **Email alerts.** They would mean holding people's addresses; web push keeps only a device's own capability.
- **An authenticated sponsor.** It needs the app's account client to sign each request; the one limit that stays is that a stranger can use up a victim's non-exit day (an exit is never counted).
- **A remedy for dust-nulling `held.badge`** (about 250,000 one-wei moves): said plainly in the record's specification; display only.
- **A link-preview filter.** The server's preview carries only the founder's own words, no amount and no count (checked in the room journey: no `$`, "dollar" or `%`).
- **A per-project hourly post cap.** One attacker could fill it and silence the room.
- **A "This week" line on You**, and **a banner on the room's moderation sheets** (they show no money).
- **`state != closed` for Team grants.** A closed grant with something left to claim is still the member's Shares.
- **Points, an airdrop, a ranking by price or volume, anything unlocked by a streak, money tied to live attention, a prize or a matching pot in a season**: the design's limits, held.
- **Making the push words the in-app words**: the push carries no amount, name or date by design.
- **Fixing F1 and F2 in this package**: each needs a Rust build and the Postgres tests of the reader, which this package did not have the room to run on a shared machine with about 4 GB free.

## 12. Still open

- **F1 and F2** (section 6): the first ranking can be ten minutes late, and an unchanged ranking disappears after a day. Both are small and in `chain_reader/explore.rs` and `mod.rs`.
- **No real push service and no real device** was used anywhere: headless Chromium here refuses to show a notification, so the real worker file is run in an isolated context, and the browser's push manager is a fake. The first human test on Chrome, Firefox and Apple is still to do, and it needs an `https` address.
- **A passkey account in the room and in alerts against a real relay** is not run end to end: the account's link is proven on the real contract (section 2, item 6) but the relay's own ERC-1271 check (`BUZZ_EVM_AUTH`, `BUZZ_EVM_RPC_URL`) is not switched on in these worlds, so a phone account's wallet link is refused there ("`smartAccountLinks` false") exactly as the plan says.
- **What the app says when its read-only judgement and the server's disagree** (the app judges the unit by the page's clock; the server by the chain's): in the journey they agree; a person whose device clock is far wrong could be offered a composer and told "Not ready yet". Not tried.
- **Mute** (a stop on a person, following their wallets) is proven by P2's loop (`scripts/room-loop.sh`) but is not in the browser journey; removal and perks are.
- **The Established badge was shown for a Pair made the app's way on a chain with a real week**; the chain's time unit on a real network, 91 days of real use and a ranking over real money are not tried.
- **Counsel's list** gains three notes, none answered: a holders-only room with perks text, a ranking by money that stayed, and push messages about tasks. Real money stays off until the outside audit and counsel.
- **The human tests of the pull request checklist are not done and are not marked.** Nothing here carries the `buzz-review-completed` mark.

## Review fixes (the app's side)

Five independent reviews of step 3 (record, room, page, social, fit) were taken. This section is the app fixer's: every finding that
concerns `app/`, `packages/creaton-core/`, `scripts/pot-app-*` and `scripts/pot-full-loop.sh`. Server findings (the ranking index's
window and cuts, dust and `held`, the index's re-signing, the room's grace and mute rules, push alerts, the sponsor, the visitor's
signer check) are the other fixer's and are not repeated here. Commits: `c0d274917` (page, card, feed, ranking) and `ab021d62d`
(room, wallet link, sign-out); `7ea0d67c5` (the journeys' spec text and this page). The reviewers' scratch files of this side
(`review-s3-*`, 13 files) are deleted; their useful cases are now ordinary tests (listed with each fix) and none remains, tracked
or not. Each guard below was switched off once, alone, and a named test failed (section "Guards switched off", at the end).

### What ran after the fixes (the app's side)

- `tsc --noEmit`: clean. `biome check`: clean. `check:copy`, `check:px-text`: pass. `check:file-sizes` with `CHECK_FILE_SIZES_BASE=35ea0a894`: pass.
  `node scripts/pot-app-abi.mjs --check`: "pot ABIs are current."
- `vitest run`: 184 files, 1722 tests passed, 0 failed (it was 179 files, 1678 tests before; the reviewers' scratch files are gone).
- The build with `CREATON_DEPLOYMENTS_FILE=contracts/pot/deployments/pot-31337.json`: the entry chunk is 417 KiB, inside its budget ("ok"); all scripts 1240 KiB.
- `pnpm -C packages/creaton-core test`: 1240 tests, 1239 passed, 0 failed (one skipped). `cd web`: `pnpm check:unused` clean; its tests 3502, 3501 passed, 0 failed (shared code changed).
- `scripts/pot-app-loop.sh`: 17 tests passed, 0 failed, 0 skipped, in 11 files. `scripts/phone-loop.sh`: 14 tests passed, 0 failed, in 3 files.
- Playwright, project `smoke`, `--trace off`, one worker, a random port: 126 passed, 1 skipped, 0 failed; no spec failed, so none was re-run.
- `scripts/pot-full-loop.sh` with the relay built from the server fixer's commits (`d6d30a8d1`), after those were in: all five worlds
  passed, "4375 checks passed." (the same count as before the fixes). Two of the worlds had also been run earlier on the relay built
  before the server's fixes (pot-room 300 checks, pot-seasons 1691 checks): the app's changes did not depend on the server's.

### Fixed

The page's top, card, feed, ranking (reviews "page" and "fit"):

- **The share picture carried founder text (page B1, fit R4).** The name was drawn unfiltered and the line was filtered by a deny list.
  Now both are folded to plain characters (a full-width `＄500` is `$500`) and left off when they carry a currency sign or word, a
  percent, a multiple (`10x`, `ten times`, `...fold`), a word about price, gain, return or making money, or a figure (a name may keep a
  short plain number such as "Studio 54"; a line may keep none). A name that fails is drawn as "A new project", and the system-share
  title and text use the same filtered name. `share-card.ts`; tests in `share-card.test.ts` (eight hostile names, seven hostile lines,
  the plain ones kept).
- **A stale record's run of updates on the picture (page I1).** The run is only said for a record not past a day. Test: a 90-day-old
  record gives no fact.
- **"About as much came in as went out" (page I2, fit R3).** The server rounds each hour on its own, so the sum of the hours is not a
  net. When any hour with a join or a take-out rounded to nothing, the line now says "Some amounts were too small to show, so there is no
  total." (also for an hour with both). Tests: `feed-words.test.ts` (the reviewers' five-and-one case) and `ProjectFeed.test.tsx` (drawn).
- **An exact amount of one person's money (page I3).** `keptLine` and the Home row print the money that stayed to the nearest 100
  dollars ("about 1,200 dollars", "under 100 dollars"), as the feed rounds; the page and Home use one function (`keptMoney`).
- **The feed's rounding was not checked (page I4).** The feed is now believed only when `roundTo` is the server's 100 dollars, every net
  is a multiple of it, hours are exactly one bucket apart and the last holds the record's own time, items run newest first and none is
  dated after the record. Tests in `numbers-social.test.ts` (one each).
- **The "Open to back" chip against the Back box (page I5).** The chip asks the same question as the box, for the same moment
  (`doorChip(numbers, now)`).
- **"weeks" said for any unit (page I6).** `unitCount` says weeks only for a 604,800-second unit and otherwise the unit's own length
  ("14 periods of 28 minutes"), on the page's update line and the card.
- **"The link shows no amounts" (page I7).** The server's preview carries the founder's own words, so the sheet now says "The link shows
  only what the founder wrote."
- **Cross-checks of the four keys (page O1).** A run of updates longer than the project has lived, money that stayed above all of the
  project's money, a badge whose inputs are not `held`'s own figures, and (Home) an index whose entries have different windows are each
  not believed (the part is null; the money is untouched). Tests in `numbers-social.test.ts` and `ranking.test.ts`.
- **A planned task's "You can take your money out first" after its date (page O3).** Said only while the notice runs.
- **A failed lazy chunk takes the page down (page O4).** A small `ChunkBoundary` (`ui/chunk-boundary.tsx`) around the Back box, the
  Money, Tasks and Room tabs says "This part of the page could not load. Your money is not affected." with a reload press; the two
  sheets and the alert renewal draw nothing when they fail. Tests: the boundary alone, and the page with `BackSection` failing (the
  Money tab and Take out stay).
- **The word "earns" next to Shares in a comment (page O6, fit)**; **duplicate feed keys (page O8).**

The room, the link and sign-out (reviews "social" and "fit"):

- **A composer the server would refuse (social B1).** The room now counts what the *linked* wallet holds, never the wallet the browser
  happens to be connected to. Shares in a connected wallet the account is not linked to offer the Confirm press, not a composer; the
  team-grant and the take-out grace use the same one wallet. `use-room-standing.ts`; tests in `use-room-standing.test.tsx`.
- **A failed balance read sent a holder to Back again (social B2).** A failed read or a wallet on another network is a new standing,
  "could not check", with a plain sentence and a Try again press; "Back this project" is only shown when the read worked and the balance
  is below the floor. Tests: the pure rule, the hook (and the retry), and the drawn room.
- **Sign-out left alerts on (social B3).** Sign out turns this device's alerts off first (browser, then the server's row, bounded at 5 seconds, never throws, only for a device this
  account saved) and drops the tab's unsent room posts. Test: `sign-out-alerts.test.tsx` (the real You page; another account's device is left alone).
- **Back published the wallet link without saying so (fit R1).** The Back box now says, beside a labelled tick box ("Let me write in this project's room"), that the link
  is public ("Anyone on this server can see the link, and so can see how many Shares that wallet holds"), and the Confirm press in the room says the same.
  The Back box offers it only where it could be made; unticked, Back signs nothing more. Tests: `back-links-account.test.tsx`, `link-after-back.test.tsx`.
- **Composer (social I1, O1, O2, I5; fit R5).** A held or repeated Control+Enter posts once; words typed while a post is on its way
  are kept (only what was sent is cleared); an answer keeps its words per post when closed with Escape; a draft and the room's "New"
  dot are the account's own, not the tab's or the device's. Tests: `room-composer.test.tsx`, `room-fixes.test.tsx`, `use-room-news.test.tsx`.
- **Quiet failures (social I3, I4, O8).** A refused like says so in the room's plain words and a second press waits for the first;
  Undo and "Show again" that are not saved say so; a hide list that could not be opened is said. Tests in `room-fixes.test.tsx`.
- **The removal sheet's promise (social I2).** The app shows no public log, so the sheet now says "The reason you give is kept in a
  public log" instead of "Everyone can see...". (A visible log in the room needs a project tag on the server's entry: open, below.)
- **Bidirectional controls in post text (social O3).** `displayText` takes out the right-to-left overrides and isolates (shared
  code; web's tests and `check:unused` pass).

### Declined, with the reason

- **Page O2** (the Home chip is from the index alone and up to a day old): it is a hint beside a link to the page, which reads its own
  record; it can only be stale, not wrong. **Page R2 / O1(e) second half** (an index whose own block time is old while its signing time
  is fresh): a quiet test network's chain legitimately has an old last block, and the server's own re-signing will keep the signing
  time fresh; refusing it would hide a valid ranking there. **Page O5, O7** (wording of a few first-screen lines, empty-state noise):
  the kept line was reworded by I3; the rest is taste and changes nothing the design asks for.
- **Held-since line says "weeks" for any unit (page I6, third place).** Step 2 decided and tested on the real chain that a unit is "the
  project's week" in that one line (`held-since.test.ts`, `tests/anvil/held-since.test.ts`, `pot-feed.spec.ts`); the new step 3
  sentences (the update line and the card) use the exact unit. The two now differ on a test network; changing the older one is a copy
  decision for the owner.
- **Social O4** (the worker drops a malformed push without showing): the server's messages are well formed, the plan fixes the three
  sentences, and a worker that showed a notice for an unreadable message would turn any garbage into an alert; a test holds the drop.
- **Social O6** (Home band prefers demo day over open entry; a listed but not yet accepted member is offered "Enter"): the server
  refuses the second and the first is A4's choice 3.
- **Social O7** (the room reads the newest 200 posts and 500 likes; a team stop can fall out of the 200 newest team records): the server
  still enforces, and a busy room is not the first launch. Recorded as open below.
- **The "cut" list of the social review** (take away report categories, hidden people, stops, the link states, demo-day batching, the
  taken and ended alerts, the perks sheet): each is in the design or in the owner's list (V1 names "planned, taken or ended"; V3 names report, mute, perks);
  the part that was really heavy and wrong was the silent link, which now has one tick box and one sentence. Nothing was cut.
- **Fit: "Leave is accepted only while entry is open" and "an uppercase hex `e` tag"**: server side; not the app's.

### Still open

- **The phone path of the room against a real relay (fit R6).** A passkey Back followed by writing in the room is proven on the real
  contract (`phone-loop.sh`) and in the app's tests, not through a relay with the chain connection and smart-account links on.
  The first human test must cover it.
- **The room's list of the team's stops** comes from the newest 200 team records (social O7), and "Show earlier posts" can run out
  without saying so.
- **A visible reason for a removed post.** The server's public log entry carries no project tag, so the room cannot cheaply show it.
- **The server's findings** (ranking index window and cuts, dust and `held`, re-signing, the room's grace, the team's mute reaching the
  founder, push decoys, sponsor, visitor signer checks) are the other fixer's; the app reads whatever they sign. `app/` waits for none
  of them: the checks the app makes on the record (above) are the same whether or not the server's fix is in.

### Chosen under the owner's standing go; the owner may overrule

- **The wallet link tick box starts ticked.** Back is as fast as before, and the sentence is next to the box, but the default
  publishes a link. Unticked by default would be the safest; the cost is one more press in the room for most holders.
- **Money that stayed is "about N dollars", to the nearest 100, on the page and on Home**, so a one-person project says nothing exact.
  A project with less than 50 dollars kept says "under 100 dollars".
- **A feed with any other rounding than 100 dollars is not drawn at all** (a constant in the app; a server that changes it needs the app changed).
- **A name the card cannot carry is drawn as "A new project"**, never cut or blurred.
- **The number words ("ten times", "a hundred") are left off a founder's line; "one" and "two" are not**, so a line such as "One lamp at a time" stays.

### Guards switched off once each (the app fixer's)

Each line was removed alone, the named tests run, and the file put back; every one made at least one test fail (the count is "failed of run"):

- The composer's in-flight check (1 of 4), the held-key check (1 of 4), clearing only what was sent (1 of 4): `room-composer.test.tsx`.
- Counting the linked wallet before the connected one (2 of 11): `use-room-standing.test.tsx`. The "could not check" standing (3 of 22): `room-standing.test.ts`, `use-room-standing.test.tsx`.
- The like's in-flight check (1 of 9), the account in the draft's key (1 of 9), the hide-list notice (1 of 9): `room-fixes.test.tsx`. The account in the "New" key (2 of 4): `use-room-news.test.tsx`.
- Turning the device's alerts off before sign-out (1 of 2): `sign-out-alerts.test.tsx`. Passing the person's tick to the link (1 of 3): `back-links-account.test.tsx`.
- The filtered name on the card (1 of 10), the freshness of the run of updates (2 of 10), the money-and-multiple words (2 of 10): `share-card.test.ts`.
- The "no total" sentence (3 of 21), the date of a planned task (1 of 8): `feed-words.test.ts`, `ProjectFeed.test.tsx`.
- The feed's 100-dollar rounding (1 of 22), one bucket apart (1 of 22), the run longer than the project's life (1 of 22), the badge's inputs equal to `held` (1 of 22): `numbers-social.test.ts`.
- The chip agreeing with the box (1 of 20), the rounded kept money (2 of 20), the unit's own length (2 of 20): `project-top-words.test.ts`. One window per ranking index (1 of 12): `ranking.test.ts`.
- The chunk boundary around the Back box (1 of 1): `chunk-failed.test.tsx`.

## 13. Commits

The step 3 work, oldest first, after step 2's `35ea0a894` (the plan `eb5b1a4b9`, its reviewed revision):

- `ac66c8370` docs: the step 3 plan: project page, holder room, feed, streaks, badge, ranking, seasons, web push
- `eb5b1a4b9` docs: the step 3 plan, revised after two reviews: the room answers rule, the index of the ranking, exits never limited, the one-screen order
- `0a5ab0ab2` reader: a test that fails without the ranking of ended rows that hold unclaimed notes
- `f5132a2c4` app: tests that fail when the last-look guards are removed (plan unknown, state, worker, pay-to, taker)
- `96f1094db` app: plainer words on five screens the 360 px read found unclear; the step 2 report says it is pushed
- `9be5ad6f3` relay: the plan-reads index test no longer depends on the size of the shared table
- `69774f967` reader: one list of accounts that nobody holds for (Ledger::excluded)
- `9b273c587` reader: the record's four new keys: held, feed, streaks and established
- `2cfba852f` db: migration 0073, the indexes of the held-for-a-window query and the ranking columns
- `c4ad81fad` reader: the held window is bounded in the database, and the signed ranking index
- `ce02098a6` scripts: one independent recomputation of the social keys for the example and the chain loop
- `1c58511d4` docs: RECORD-V2 section 11, the four social keys and the ranking index
- `791622be5` scripts: the loop's social check compares objects with their keys in any order
- `3892d9d0f` db: the migration count is 73 and migration 0073 is held to the desired-state schema
- `97e5dc71d` db: the first-block index does not hold the block number, so it cannot compete for the newest-block read
- `503d49dbb` reader: tests that bind the recount from the rows and the balance-fit error
- `dbc10363e` docs: the reader report's step 3 section for package P1
- `01313c978` app: read the four step 3 keys of a record (held, feed, streaks, established) apart from the money
- `9495716f1` app: the take-out banner on every page and sheet, word for word
- `d979cef15` app: the project page's top, in one screen on a phone, with the Established chip and Share
- `1d80ca1e5` app: Money that stayed on Home, from the server's one signed index
- `0dd768a9b` app: keyboard and width checks for the page's top and Home; drop exports nothing uses
- `675f5c005` core: kind 37021, the operator's season record
- `deab02fd5` docs: the holder room and seasons, the tags, the rules and the server's sentences
- `db90821c4` relay: the holder room's write rule, the team's tools, and seasons
- `267690673` app: a passkey account can say a block's time, so the holding line reads on a phone
- `0c5568055` app: how long you have held it, worked out on the device from your own transfers
- `3ca47c125` app: the live feed (Lately) on the project page, joins and take-outs at equal weight
- `f1ce830c4` cli: buzz launchpad seasons (start, show, remove), with the season's bounds shared with the server
- `90cc5699f` core: the holder room's tags on the feed's builders, and the server's word on phone-account links
- `2f56902c4` app: the holder room stays out of the other feeds, private hiding of people, and author-named like and comment presses
- `d9dbc33cc` app: a phone account can link its wallet to its account, and the link is checked on the network
- `e5569d0de` scripts: the room and seasons on a real relay and a real chain, over the wire
- `7d36cea45` app: the holder room's rules, words and records
- `a919d809a` app: the holder room on the project page
- `f6e4a69db` app: Back ends by linking the account to its wallet, so the room opens
- `4828ecde5` app: the room loads with its tab, names its writers, and its New dot is cleared by anything newer
- `8854f38e0` app: a browser spec for the holder room against a real chain
- `b9cd4f9f6` app: a stop on a person leaves a margin under 30 days, so a clock a little ahead is not refused
- `8d17341da` core: the server's web push key from its information document, read only as a usable point
- `95d42340b` app: seasons on Home and a demo day page, with entry and leave by the team, each entry checked against its project
- `d11b77550` db: migration 0074 for web push alerts and the sponsored-fee counts
- `6b51d18f4` app: alerts away from the app: one question on You, the worker shows three fixed sentences and opens the project
- `c995491a7` app: the worker and the alert words pass the linter
- `630c68a87` app: demo day reads in parts of ten, puts the keyboard on the first new card, and has a browser spec
- `1d93a62f5` relay: web push alerts and the sponsored-fee limit, both off unless the operator sets them
- `073b387a5` app: a browser spec for the alerts card with a fake push manager and the two signed calls
- `a6bb09295` app: seasons tests bind every guard; the band leaves the investing check to its read
- `d6b3385ab` docs: RECORD-V2 section 12 and the reader report's step 3 section for web push and the sponsor
- `521e93b28` app: the band's investing-off test waits long enough to catch a read
- `b3f32ad01` app: the page limit of a season's entries is the season code's own
- `e5f1f18aa` scripts: one check ties the room's limit, the alert kinds and the sponsor's refusal words across Rust, the worker and the app
- `36bc92c80` app: a passkey account's link to the person's account is signed with the passkey and accepted by the deployed account itself
- `d22bec35d` scripts: the page, feed, room, badge, ranking, season and alert journeys against a real relay and chain
- (this page, and nothing else, is in the last commit)
