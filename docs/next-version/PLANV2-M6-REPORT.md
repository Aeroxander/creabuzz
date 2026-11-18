# Plan version 2, milestone 6, part 1: the new phone-first app

Written 17 November 2026 on branch `v4-governance-rework`, for the owner and the lead. The plan is `docs/PLAN-V2.md`
(section 6 "The app" is the spec; section 9 row 6 the milestone). The design is option F in
`docs/next-version/design/DIRECTION.md`. The code is in `app/` (package `@creaton/app`). **Nothing is deployed, nothing
was pushed, `web/` still builds and runs as before.**

## The short answer

A new app beside `web/`, same stack (Vite, React 19, TypeScript, TanStack Router and Query, Tailwind 4, Radix), built
phone first in the chosen design: the dark purple gradient with its glows, glass panes, Geist and Geist Mono, and the
glossy green 48 px button with option F's spring press. It installs on a phone (manifest, icons, standalone, a
service worker that keeps the shell only). The social side people liked is carried over and restyled: Home, posts and
comments, profiles, private messages and notifications. Sign-up and sign-in with a passkey are the same code `web/` runs,
moved into `packages/creaton-core`, with the legal text word for word. A project page has the stage line and Updates,
Tasks and People (and Money where the server turns investing on), where Updates and People work from the server and
Tasks and Money say plainly that they are coming. Start is three answers and one press. Join is 4 presses and 1 field for a new person, and the founder accepts in
1 press, each held by a test.

What part 1 does not do: anything with money (no Back box, no rounds, no receipts; they need the chain reader of
milestone 5), the weekly update with check-in on This week, tasks, and a run against a real server.

## Review fixes (second round, 17 November 2026)

Two reviews came back: a design and accessibility review at 360, 390 and 1280, and a code review. The code review's
text reached the fixer only up to its third finding plus the start of a fourth (the manifest and icons); the rest was
cut off, so any later finding of that review is not covered here and should be re-sent.

| Finding | What changed | Held by |
|---|---|---|
| **Blocker:** with investing on, a team that never raised money showed Backed as done | The stage line marks only stages actually reached (`reachedStages`); no money stage is reached until the chain reader exists. Screen readers hear "done" or "not reached" per stage | `StageLine.test.tsx`; smoke "with investing on, a team that never raised money is not shown as backed" |
| **Blocker:** component CSS was unlayered, so utilities in `className` were ignored (Back and Close green, Like always green, the chat box 96 px with a grip) | All component rules sit in `@layer components`; Like is muted until liked | screenshots 08, 13 |
| **Blocker:** a failed profile read on You published an empty profile over the old one | A failed read stops the save with "Your profile could not be read, so nothing was changed. Try again."; where a profile was shown, a read that finds none also stops it; only sign-up starts from empty | `profile-save.test.ts` (4 cases) |
| Sign-out kept the old account's messages and follows in memory | Sign-out removes `buzz.identity.backedUp` and reloads the page, as `web/` does | smoke "signing out reloads the page" |
| The service worker could store an image or a markdown file as the offline app; the manifest and icons never updated | Only `text/html`, non-redirected responses become the shell; unhashed files under `/assets/` (manifest, icons) go network first; cache name bumped to v2 | checked by hand against the build's file names |
| The green link buttons had no press | `ButtonLink` (TanStack `createLink`) carries the press; used for Start a project, Create your account and Message | `button.test.tsx` (touch, Enter, reduced motion) |
| Money tab shown with investing off; four tabs cut off at 360 | Money is left out when investing is off; at 360 "soon" becomes a small dot (the word stays from 380 px up), tab padding 10 px | smoke checks the rail does not scroll at 360 |
| Muted text under 4.5:1 over the bright lower half | Muted is `hsl(262 50% 90%)`, problem text `hsl(4 92% 80%)`, and panes with small text (cards, lists, empty states, the tab rail, the Messages row) add a 45% dark tint under the same frost; the sign-up footer sits on the calm pane | re-measured on the real pixels: no failing small text left at 390 or 360 except two at 4.3 to 4.5 at the 5th percentile (medians 6 to 7) and the page behind an open sheet |
| Focus hidden under the tab bar; invisible tab panel stop; "Taskssoon" | `scroll-padding-bottom` on `html`; tab panels have the green ring; the tab reads "Tasks (coming soon)" | smoke uses the tab's accessible name |
| Headings | One h1 per screen: an sr-only "Home" when signed in, BackHeader's title is plain text where the screen has its own h1, the name on You is an h2; Home sections use `aria-labelledby` | |
| Touch targets under 44 px | Small buttons and tabs keep their 40 px look with a 44 px touch area; byline names grow their touch area | |
| Tab bar labels over unblurred text | The bar is 97% solid | |
| Empty Home offered nothing; Start disabled with no reason | Empty Home has a secondary Start a project; Start stays pressable and says which answers are missing, moving to the first; placeholders begin "For example:" | smoke "Start pressed with answers missing" |
| Links used the browser's focus ring | One green ring for every link (base layer) | |
| White initials under 3:1 on some avatar colours | Avatar colours darker (40% to 28% lightness): the worst is now 4.06:1 | |

## Carried over, new, placeholder

| Area | What it is | Where |
|---|---|---|
| **Carried over (moved, unchanged)** | Passkey and account: the WebAuthn and PRF key derivation (HKDF info `buzz-nostr-v1`), the session, the stored key, the recovery key and its offer, the terms and age policy, the record of what was agreed. Storage keys `buzz.passkey.*` and `buzz.identity.*` are byte-identical, so accounts made in `web/` work in the app at the same address | `packages/creaton-core/src/account/` |
| | Relay client and record signing: `queryEvents`, `publishEvent` (with the terms guard on every send), NIP-42 sign-in, refusal wording, relay URL, server settings (`serverInvesting()`) | `packages/creaton-core/src/client/` |
| | Social and project records: posts, replies and votes, threads, engagement, follow lists, NIP-17 private messages and the inbox read, notifications, profile names, join asks, team answers, goals | `packages/creaton-core/src/social/`, `.../project/` |
| | Brand constant `APP_NAME = "Creaton"` | `packages/creaton-core/src/brand.ts` |
| **Rebuilt in the new design** | Sign-up (passkey or not, sign-in with the passkey or the recovery key), the recovery key sheet, the terms-changed prompt, the passkey unlock bar; Home; post card, composer, a post with its comments; profile with Follow and Message; messages list and conversation; notifications on You | `app/src/features/` |
| **New** | Design system F as tokens and components (Button, Field, TextArea, Sheet, Dialog, Tabs, Avatar, Card, EmptyState, Toast); the four-tab bar; the stage line; a thin reader of project records (instead of web's 991-line model); Start's three answers; installability | `app/src/ui/`, `app/src/app/`, `app/src/features/project/`, `app/public/` |
| **Placeholder** | Open rounds on Home (shown only where the server turns investing on); Tasks tab; Money tab (says "No money on this server" when investing is off; with it on, says what will show and carries the ownership line); Backing receipts on You (investing on only); This week (lists your projects with Post an update; the update with check-in is part 2) | as named |

How the move was done: each file went from `web/src` to `packages/creaton-core/src` with only its relative imports
rewritten, and a one-line `export * from "@creaton/core/..."` shim stayed at the old path, the pattern
`web/src/shared/constants/kinds.ts` already used. No `web/` screen changed. Three `web/` tests read source files: the
account-paths and guarded-senders scans now follow a shim to the moved file, and the seen-state test points at the moved
notifications file. `nostr-tools` was added to core's dependencies.

## The screens

Five screens as the plan names them, reached from a bottom tab bar of four (a project opens from Home):

- **Home.** Signed out: "Real projects, built in the open." and the one green button, Start a project. Then Open
  rounds (investing only), Projects you follow, Shipping now (newest activity first, never by money), and Posts (from
  people you follow, else everyone). Post opens the composer in a sheet.
- **Project** (`/p/<id>-<founder16>`, the link shape `web/` shares and the server's link previews know; the older
  `/launchpad/<id>?author=` opens it too). Name, line, founder; the stage line (Solo and Team from the record without
  money; all five stages where investing is on) with "A stage says what a project has done, not that anyone checked
  it."; Ask to join, or "Asked to join. The founder will see it.", or "You're on the team"; Follow; the four tabs.
  Updates: the team's update records and goals (only from people who speak for the project) and posts that name it.
  People: founder and team with where each stands; for the founder, the asks with Accept.
- **Start.** Name, What will you make?, How will people know it worked?, Start. Publishes the same two records as
  `web/`'s Start (the project, then its main goal) and opens the project. The draft survives sign-up.
- **This week.** Your projects, each with Post an update. Placeholder for the update with check-in.
- **You.** Profile with Edit, Messages, then Notifications (replies, likes, follows, asks to join your projects; the
  count shows on the tab), Projects, Account (save your recovery key, sign out).

One green button per screen is checked by the smoke tests on every screen they open.

## Design system F as built

Values are option F's from `type-and-buttons-options.html`, unchanged: gradient `hsl(266 66% 13%)` to `hsl(266 62% 24%)`
to `hsl(262 60% 40%)` to `hsl(210 55% 42%)` at 155deg with the violet glow top left and the green glow bottom right;
glass white at 12 to 22% with `blur(14px) saturate(1.5)`; primary `linear-gradient(180deg, #63c88e, #47a873)` with dark
ink; 48 px (40 px small), 12 px corners, 16 px semibold. The press is `scale(0.965)` in 0.07 s and back in 0.3 s on
`cubic-bezier(0.34, 1.56, 0.64, 1)`. Touch browsers do not all report `:active`, so a class (`is-pressed`) holds the
press on pointer down and on Space or Enter, and lets go on up, leave, cancel, key up and blur; it is never set under
reduced motion or while disabled, and the stylesheet turns transition and transform off under reduced motion. Geist and
Geist Mono are self-hosted from `@fontsource-variable` (the CSP allows fonts from this origin only). Mono is used for
counts and figures, not for "5 hours ago". Text sizes are rem tokens only. Long reading (posts, comments, updates,
messages) sits on a calmer, darker pane, the open point DIRECTION.md left.

## Gates, as run on 17 November 2026

| Gate | Result |
|---|---|
| `tsc --noEmit` (app) | clean |
| `biome check` (app) | clean |
| Copy check (`app/scripts/check-copy.mjs`) over `app/src` and the moved core folders | passes (the shared rules plus key-format and the old product name) |
| px-text check | passes |
| File sizes (600 lines for `src`) | passes |
| `vite build` + bundle budget | entry 386 KiB (121 KiB gzip) under the 450 KiB budget; every screen but Home and Project loads on first open; only `index.html`, `sw.js` and `assets/` in `dist` |
| Unit tests (`vitest`, 2 workers) | **38 passed**: the press (pointer, touch leave and cancel, Space, Enter, blur, right button ignored, reduced motion, disabled, caller handlers kept) on the button and the link button, option F's values in the stylesheet, Field, Avatar, Card, EmptyState, Tabs, Sheet, Toast, the stage line, the profile save, the project record reader, Start's records |
| Playwright, phone 390x844, touch, one worker (`smoke`) | **12 passed** (with Join): sign-up shows the boxes word for word and waits for them; Home; investing switch; Project stage, updates, people, Tasks placeholder, no Money tab without investing; with investing on at 360, Backed not done and four tabs fit; a post with comments; You signed in and out; sign-out reloads; Start with answers missing; Start within 3 presses and 3 fields; Join |
| Join budget (`join.spec.ts`) | a new person on the hosted settings: **4 presses, 1 field** (Ask, name, age tick, terms tick, Create); the ask is sent by itself after sign-up, once, and not again on reload. The founder: **1 press** (Accept); the person is then on the team and the stage reads Team |
| `knip` (whole repo, app added) | clean |
| `web/`: `tsc --noEmit`, node tests, `vite build`, copy and px-text checks | clean; **3594 passed, 0 failed** (1 skipped, as before) |
| `packages/creaton-core` node tests | **1004 passed, 0 failed** |

Not run: `just ci` (it runs cargo and the whole repo; the machine is shared), cargo, forge, the real-server loop.
The review fixes touched only `app/`, so `web/` and core were not re-run after them.

## Screenshots

`pnpm --dir app screens` writes these at 390x844, twice the pixels, into `app/test-results/screens/` (ignored by git);
every file hash is distinct:

`01-home`, `02-home-signed-out`, `03-project`, `04-project-people`, `05-start`, `06-you`, `07-sign-up`, `08-post`,
`09-messages`, `10-messages-list`, `11-home-investing-on`.

After the review fixes they were retaken, with three more at 360x740 from the review's own run:
`12-project-investing-on-360` (Backed not done, four tabs fit), `13-conversation-empty-360` (white Back, one-row
message box) and `14-start-missing-answers-360`. The set is in the session scratchpad folder `m6-screens/`.

## For a person to try

1. `cd app && pnpm build && pnpm preview` and open `http://127.0.0.1:4174` on a phone or at phone width. Without a server
   behind it, reads fail and say so with Try again; to see data, serve `app/dist` from a local relay (`BUZZ_WEB_DIR`
   pointed at `app/dist`) or run `VITE_RELAY_URL=ws://localhost:3000 pnpm dev`.
2. Press a green button: it sinks a little and springs back. Turn on Reduce motion in the phone's settings: it no
   longer moves.
3. You → Make your account: the age and terms boxes say exactly what `web/` says; Create stays off until both are
   ticked. With a passkey on the phone, Create with a passkey is the green one.
4. Start: three answers and Start open the new project's page.
5. On another account, open that project's link and press Ask to join; on the founder's account, People → Accept.
6. On Android Chrome: Install app from the menu. The app opens full screen with the Creaton icon.

## Open items

1. **The service worker under the relay.** The relay serves only `/assets/*` as files; `/sw.js` gets the app shell, so
   the worker does not register there (the app works without it; it registers under `vite preview` and any static host).
   The relay needs to serve `/sw.js` from `BUZZ_WEB_DIR`, or serve `/assets/sw.js` with `Service-Worker-Allowed: /`. The
   manifest and icons are under `/assets/` and work today. Out of this part's scope (relay code).
2. **Which app the relay serves.** It serves one `BUZZ_WEB_DIR`. Switching from `web/dist` to `app/dist` is a deploy
   decision for when the app covers `web/`'s journeys.
3. **Real-server loop.** `scripts/real-loop-e2e.sh` builds and tests `web/`. The app needs its own copy that sets
   `BUZZ_WEB_DIR=app/dist` and runs the join and Start journeys against a scratch database.
4. **Passkey end to end.** The passkey code is `web/`'s, unchanged, and its node tests pass; the app's Playwright runs use
   the plain account. A spec with Chrome's virtual authenticator (as `web/tests/e2e/passkey.spec.ts`) should follow.
10. **The rest of the code review.** Its findings after the fourth did not reach the fixer (see Review fixes).
5. **Not carried yet from the social side:** reposts and quotes, bookmarks, mute lists, search and hashtags, explore,
   reporting a post, editing and deleting a post, publishing the DM server list (kind 10050), the recovery key download,
   images in posts. The record code for most of these is now in core.
6. **Milestone 6 part 2:** the Back box and refund receipts (after milestone 5's chain reader), This week's update with
   check-in (2 presses, 1 field), Tasks, and the remaining budgets, which are already listed as `PLAN_V2_BUDGETS` in
   `app/tests/helpers/press-counter.ts`.
7. **Accessibility pass.** Every control has a name, the tab bar marks the current tab, tabs use Radix, the like is a
   toggle with `aria-pressed`, avatars are hidden from screen readers. An axe run and a VoiceOver walk are still to do.
8. **The moved files' copy.** `web/`'s copy check no longer sees the moved core files; the app's copy check scans them
   instead.
9. **The stage line without money** shows Solo and Team only, and reads Team once a second person has said yes on the
   record. The plan's Team stage also needs the on-chain second signer; that comes with milestone 7.

# Part 2: money, This week, and the open items (18 November 2026)

Written on branch `v6`. **Nothing is deployed and nothing was pushed.** Investing stays off by default: with the
server's `investing` unset or false, the app asks for no project numbers and shows nothing about money (a smoke test
counts the server's requests and finds none for kind 39009).

## The short answer

Where the server turns investing on, the app now reads each project's numbers from the server's reading of the chain
(milestone 5's kind 39009 record) and shows them on the Project page and on Home; a person can back an open round in 2
presses and 1 field, take money back from a receipt on You in 2 presses, and a founder can open a backing round in 1
press. This week posts the founder's weekly update (the same record `web/` reads) in 2 presses and 1 field, with the
check-in on the network in the same press when this wallet runs the project. Each of those budgets is held by a
press-counted Playwright journey. The app also has an axe run on every screen (nothing serious or critical found), a
passkey spec on Chrome's virtual authenticator, and a real-server loop that serves `app/dist` from the relay and runs
Join and Start against a scratch database.

What part 2 does not do: put a project on the chain (launch), send money from a phone (the passkey wallet), Give Shares,
and the budgets whose contracts or screens belong to milestones 7 and 8. Each is listed under open items with the
reason.

## A decision for the lead: how a project record names its launch

Milestone 5 left no link from a project's own record (kind 37001, `d` = a word, signed by the founder's Nostr key) to its
project on the chain (39009 `d` = `keccak256(abi.encode(founderEvm, projectId))`). The contracts say `projectId` is "the
id in the founder's signed project record", so part 2 takes, in `packages/creaton-core/src/launchpad/project-chain.ts`:

- `projectId = keccak256(utf8("37001:<founder pubkey>:<d>"))`, the hash of the record's address;
- the founder's record names its launch in a `["chain-key", "0x…"]` tag (`recordWithTeam` keeps it when the team changes);
- the app believes a 39009 only when (1) it is signed by the server's own key (NIP-11 `self`, now read by
  `serverRelaySigner()`), (2) its `d` is the record's `chain-key`, (3) `keccak256(abi.encode(founder, projectId))` from
  its own content equals `d`, and (4) that `projectId` is the hash of this record's address.

Checks 3 and 4 together mean a record that points at someone else's launch shows nothing, and a launch someone else
made for this record's id (from another wallet) shows nothing either. The golden vector is milestone 5's record (founder
`0x7099…79c8`, id `0x5c18…481d`, key `0x23ae…4db3`). Nothing writes the `chain-key` tag yet, because nothing in the app
launches a project (open item 1); until then a project shows "No backing yet". Reading by the `d` tag only: multi-letter
tag filters are not indexed by the server.

## What was built, and where

| Piece | Where | What it does |
|---|---|---|
| The server's own key | `packages/creaton-core/src/client/server-settings.ts` | `relaySignerFromInfo` / `serverRelaySigner()` from the information document's `self`; node test |
| The chain-key link | `packages/creaton-core/src/launchpad/project-chain.ts` | `projectIdOf`, `chainKeyOf`, `chainKeyFromTags`, `numbersBelongTo`; node test with the milestone 5 vector |
| Weekly update record | `packages/creaton-core/src/project/{weekly-update,record-date,promises}.ts` | Moved from `web/src/features/launchpad/lib/` unchanged, with one-line `export *` shims at the old paths (part 1's pattern); `web/`'s own tests of them still run through the shims |
| Project numbers | `app/src/features/money/numbers.ts` | Parses 39009 (version 1, amounts as bigint, `removed`, `truncated`), the open round, the 12-hour lowering window, receipts, refunds and holdings by address, the runner; words for dollars, Shares and prices |
| Calls | `app/src/features/money/calls.ts` | approve then `ask`, `refund`, `claimHeld`, `checkIn`, `openRound` at exactly 3e15, `quote()`; dollar parsing from 1 dollar (no upper limit: a round may be asked for more than it holds); built with core's hand-rolled ABI encoder, so no viem. Calldata pinned against `cast calldata` |
| Wallet | `app/src/features/money/wallet.ts` | The browser's injected wallet behind web's sender shape (`getAddress`, `sendCalls`, `isAvailable`) plus `connectedAddress` (no prompt) and `readCall`. Switches to the record's chain, sends one call at a time and waits (bounded: about two minutes) for each to land before the next; reports how many landed |
| Copy | `app/src/features/money/money-copy.ts` | Every refusal these calls can meet (`WrongPhase`, `BadAmount`, `NothingToRefund`, `NotAllowed`, `CannotOpen`, `TokenMisbehaved`, `CapReached`, `WrongStage`, the token's balance and allowance errors) and every wallet stop, as sentences, by action; found by selector or name anywhere in a provider's error. A test walks them and checks no name, code or hex leaks |
| Reads | `app/src/features/money/use-money.ts` | One project's numbers by `#d`; the server's 100 newest records for Home and You; all gated on investing |
| Project page | `ProjectPage.tsx`, `StageLine.tsx`, `money/MoneyTab.tsx`, `money/BackBox.tsx`, `money/OpenBacking.tsx` | The stage line marks Backed only when money came in, Council and Open from the chain; the current stage is the later of the record's and the chain's. Money tab: stage and since, eligible since, raised of the cap with a bar, the open round, every round's price ("1 dollar buys 3,000 Shares (333,333.33 for the whole project)"), Shares already held and by how many accounts and when they release, the check-in clock or "Quiet since", "As of", and the ownership line. The Back box sits above the tabs while a round is open (Back is then the screen's one green button, Ask to join steps back). Open backing shows for the founder when no round is open and the cap has room |
| Home | `money/OpenRounds.tsx` | Open rounds, soonest closing first, never by money; "No round is open right now" otherwise |
| You | `money/Receipts.tsx` | Without a wallet: how to see receipts. With a wallet that shares no account: Connect your wallet. Then per project: "Paid X dollars in round N", "Can still take back Y dollars (Z of each 100), as of <time>", Take money back (sheet, then confirm), Shares held and free, and after a market Take out released Shares (ends their refund). A list the server cut at 200 is never called empty |
| This week | `week/WeekPage.tsx`, `week/WeeklySheet.tsx`, `week/use-week.ts` | Per project: when it last had an update, the check-in clock, one press to open the sheet, one box ("What did you do this week?"), one press to post. Where this wallet runs the project the press also checks in. A failed check-in after the update posted says "Your update is posted; the check-in did not go through." with the reason, keeps the update, and offers only Check in again; the card keeps a Check in only button, and the chain's own last check-in is what says whether one is still needed |

Copy: every money sentence is plain words, the ownership line is word for word wherever money is offered (Money tab, the
Back sheet, Open backing, each receipt), the refund is a property of the receipt and never of a Share, and "earn" never
stands next to Shares (the copy check's `no-earn-shares` rule runs over all of it).

Accessibility: `app/tests/e2e/a11y.spec.ts` runs axe (serious and critical fail) and the no-sideways-scroll check on
Home signed in and out, the Project page with each tab, the Back sheet, You with receipts, the refund sheet, Start,
Messages, a conversation, a post, a profile, This week and its sheet, sign-up and You signed out, at 390 and 360 wide,
light and dark. It found nothing serious or critical, so nothing needed fixing; a throwaway check confirmed the helper
does fail on a nameless button and low contrast. A VoiceOver walk is still to do.

Passkey: `app/tests/e2e/passkey.spec.ts` signs up with a passkey on Chrome's virtual authenticator (PRF) on the
`localhost` origin, sees the recovery key offered, reloads, unlocks to the same account, and checks that the browser keeps
only `buzz.passkey.{credentialId,mode,pubkey,r1,salt}` and no secret key.

Real server: `scripts/app-real-loop-e2e.sh` builds the app into a temporary folder, takes a hard link of the existing
`target/debug/buzz-relay` (it never runs cargo; exit 2 when there is no relay), boots it on a scratch database (dropped on
exit) with `BUZZ_WEB_DIR=<app dist>`, `BUZZ_WEB_SPA=full` and the hosted terms, privacy note and age box, and runs
`app/playwright.real-relay.config.ts` over `app/tests/e2e-real/`: Join (a stranger on the link, 4 presses and 1 field,
the ask sent by itself; the founder accepts in 1; the stranger reads "You're on the team" and Team) and Start then the
week's update. An open server: milestone 5 found the numbers are not publicly readable on invite-only servers.

## Budgets, as measured

| Budget (plan section 6) | Plan | Measured | Held by |
|---|---|---|---|
| Start | 3 and 3 | 2 presses, 3 fields (mocked and on the real server) | `smoke.spec.ts`, `e2e-real/start.spec.ts` |
| Join, new person, hosted settings | 4 and 1 | 4 and 1 (mocked and real); founder's Accept 1 | `join.spec.ts`, `e2e-real/join.spec.ts` |
| Open backing | 1 and 0 | 1 and 0, the call is `openRound(key, 3e15)` exactly | `money.spec.ts` |
| Back | 2 and 1 | 2 and 1 (21 words to read, about 9 s); calls are approve then ask, exactly | `money.spec.ts` |
| Take money back | 2 and 0 | 2 and 0 (15 words, about 6 s); the call is `refund(round)` | `money.spec.ts` |
| Weekly update with check-in | 2 and 1 | 2 and 1 (about 16 s), the update record plus `checkIn()`; 2 and 1 on the real server without a launch | `money.spec.ts`, `e2e-real/start.spec.ts` |
| Give Shares | 4 and 0 | not built | open item 4 |
| Add a second person | 2 and 0 | not built (the Pair, milestone 7) | open item 5 |
| Post a task, Accept and pay | 2 and 2, 1 | not built (no Tasks contract; milestone 8) | open item 5 |
| Bid, Buy, Sell, Hand back | 2 and 1 | not built (the auction and pool, milestone 7) | open item 5 |

Wallet confirmations are the wallet's own and are not counted as presses in the app; each journey checks the exact
calls the wallet was asked to send through a stand-in `window.ethereum` that records them.

## Gates, as run on 18 November 2026

| Gate | Result |
|---|---|
| `tsc --noEmit` (app), `biome check` (app and the changed core files) | clean |
| Copy check (app, over `app/src` and core's account, client, social and project folders), px-text, file sizes (600 lines) | pass |
| `vite build` + bundle budget | entry 384 KiB (part 1: 386) under 450; the money screens are in the Project page (entry) and in the You and This week chunks |
| Unit tests (`vitest`, 2 workers) | **63 passed** (part 1: 38): numbers, calls against `cast`, the wallet's ordering, bounded wait and network switch, every money sentence, the stage line from the chain, the weekly update record |
| Playwright `smoke`, 390x844 touch, one worker | **36 passed**: part 1's 12 (Join included), money 11 (numbers, a wrong signer, investing off, Back, a refusal, Take money back, Connect, Open backing, the weekly update with check-in, a failed check-in, no launch), axe 12, passkey 1 |
| Playwright `screens` | 9 passed; 18 shots, every hash distinct |
| `scripts/app-real-loop-e2e.sh` | 2 journeys passed; scratch database dropped, temporary build removed |
| `knip` (whole repo) | clean |
| `node scripts/regen-kinds.mjs --check` | up to date |
| `web/`: `tsc --noEmit`, node tests, copy check | clean; **3596 passed, 0 failed, 1 skipped** |
| `packages/creaton-core` node tests | **1010 passed, 0 failed** |

Not run: cargo, forge, `just ci` (the machine is shared; nothing in `crates/` or `contracts/` changed here).

## Screenshots

`pnpm --dir app screens` adds `11-home-investing-on` (now with an open round), `15-project-back-box`,
`16-project-money`, `17-back-sheet`, `18-you-receipts`, `19-refund-sheet`, `20-week` and `21-weekly-sheet` to part 1's
set, in `app/test-results/screens/` (ignored by git); all 18 hashes are distinct.

## For a person to try

1. `scripts/app-real-loop-e2e.sh` (Postgres and Redis local, `target/debug/buzz-relay` built): both journeys pass.
2. Money needs a server with investing on, the chain reader running (milestone 5) and a project whose record carries
   its `chain-key`. Until launch exists in the app (open item 1) that record is written by hand; the mocked journeys in
   `app/tests/e2e/money.spec.ts` show each screen.

## Open items after part 2

1. **Putting a project on the chain.** No app flow calls `Launcher.launch(projectId, name, symbol, expectedSettingsHash)`
   and republishes the record with its `chain-key`. It needs the Launcher's address in the app (the record of numbers
   carries it, but no record exists before launch: the information document or the build must say it), a symbol rule,
   and `launchHash(keyOf(founder, projectId))` read first. Open backing works for a launched project.
2. **The phone wallet.** The app sends through the browser's injected wallet only. The passkey account with sponsored gas
   (`web/src/features/identity/lib/{sponsoredSender,kernel033,zerodev,aa-kernel,kernel-signature,passkey-wallet}.ts`,
   about 2,700 lines with ZeroDev configuration) should move into core behind the same sender shape; until then a phone
   without a wallet browser cannot back, refund or check in on the network. Web's own injected sender
   (`web/src/features/launchpad/lib/wallet-sender.ts`) was not moved: its copy is about bids, and `money/wallet.ts` waits
   for each call to land, which web's does not.
3. **The dollar token's address is not in the record.** The app reads `Rounds.quote()` through the wallet before the
   approval. Adding `quote` to the record's `contracts` is server work (milestone 5 part 2).
4. **Give Shares (4 and 0).** `Treasury.giveShares(to, amount)` exists, but the app has no source for the recipient's
   wallet address (the account-to-wallet link record is not read in the app yet) and no agreed amount choices. Not built.
5. **Budgets for later milestones:** add a second person (Pair, milestone 7), bid, buy, sell and hand back (the auction and
   the pool, milestone 7), post a task and accept and pay (no Tasks contract; milestone 8).
6. **Wallet account changes.** The You page reads the wallet's account once a minute at most; switching accounts in the
   wallet shows the new receipts after a reload.
7. **The refund numbers are as of the record's time.** The sheet says so; the chain pays the exact amount. A live
   `refundable(id, backer)` read before the press would make the number exact.
8. Part 1's items still open: the service worker under the relay (1), which app the relay serves (2), the social
   features not carried yet (5), the moved files' copy (8), the stage line's Team without the on-chain second signer (9),
   a VoiceOver walk (7), and **the rest of part 1's code review**, whose findings after the fourth never arrived (10).
   Part 1's items 3 (real-server loop), 4 (passkey end to end) and 6 (milestone 6 part 2) are done above, except as
   listed here.

## Review fixes (part 2, 18 November 2026)

Two reviews of part 2 found 3 blockers (F1 to F3), 4 important findings (F4 to F7), 2 optional ones (F8, F9) and 10
attacks on the money screens (A1 to A10). Every blocker and every important finding is fixed, and both optional ones
too. Most fixes have a test that fails on 3c2f6ab37: the unit tests in `app/src/features/money/money-screens.test.tsx`
(15, all failing on the reviewed screens), `wallet.test.ts`, `money-copy.test.ts` and `numbers.test.ts`, and the
journeys in `app/tests/e2e/money-review.spec.ts` (F1, F2; now in the `smoke` project). The reviewers' untracked
proving files were adopted into those files and removed.

**Corrected after a review of these fixes:** this section first said that every fix had such a test. Four did not.
F5's gate (only the runner's wallet gets the button, Team is not offered) was covered only by `money-copy.test.ts`,
which checks the sentences, not who sees the button; A8's Project-page half (no Open backing while a round is not
closed) only through the `anyRoundUnclosed` helper in `numbers.test.ts`, not through the page; F9 had no test (the
`parseNumbers` check named below is not the fix, which is the candidate loop in `Receipts.tsx`); and the weekly sheet's
double-submit guard (A1's second half) had none. Removing any of those four guards failed no test. Each now has one,
listed under "Review of the review fixes" below, and each was seen to fail with its guard removed. A10's fix also left
a way to ask twice (a call sped up in the wallet), fixed there too.

| Finding | Fix | Test |
|---|---|---|
| F1 Back fails from a wallet on another network | `MoneyWallet.ensureChain` runs before the calls are built, so the dollar token is read on the project's network | `money-review.spec.ts` F1 (wallet starts on chain 1); `money-screens` F1 |
| F2 numbers cached by chain key alone | the project's coordinate is part of the query key; each record is checked on its own | `money-review.spec.ts` F2 |
| F3 a failed receipt lookup said "Nothing changed" | a failed lookup is one more poll; any error once a hash exists is "not landed yet" with that hash, never "nothing changed" | `wallet.test.ts` (2 cases) |
| F4, A4 You and Home read only the 100 newest records | You reads up to 5 pages of 100 (bounded); when older records were left unread, You and Home say so instead of "has not backed" or "no round is open right now"; a refund missing from a cut list reads "not in the newest numbers yet", not "Nothing left" | `money-screens` A4 (2 cases) |
| F5 Open backing offered to the wrong wallet and at Team | shown only at Solo and Backed; only the wallet that runs the project gets the button, others are told which wallet can; `NotRunner()` and `WrongRunner(uint8)` have their own sentence | `money-copy.test.ts` F5 (the sentences only); who gets the button had none at first, now `money-gates.test.tsx` F5 and `ProjectPage.test.tsx` (Team) |
| F6 the gas error read as "not enough dollars" | the node's "insufficient funds" now asks for a little of the network's own coin; dollar refusals match by selector | `money-copy.test.ts` F6 |
| F7 `join.spec.ts` failed biome | formatted; `biome check` re-run on the whole app | gate below |
| F8 "held for more than N accounts" | `holderCount` is the full count; "At least" only on the Share total and only when the list is shorter than the count | `money-screens` F8 |
| F9 a copy could hide a project's name on receipts | every record naming a chain key is kept, and the one that checks out is used | none at first (see the correction above); now `money-gates.test.tsx` F9 |
| A1 a quick double press sent two backings | each money step has one in-flight guard, set before the mutation starts; the weekly submit has its own | `money-screens` A1; the weekly submit had none at first, now `WeeklySheet.test.tsx` |
| A2 a taken-back receipt was misread | `refunded` is parsed as the server writes it, `{paid, at}`, and the receipt says how much came back | `money-screens` A2 |
| A3 a backer cut from the holders list was told 0 Shares | when the list is cut before this wallet, the card says so and gives the Shares its receipts set aside | `money-screens` A3 |
| A5 the refund line read as 95 of each 100 back | the sheet now says at most 77.90 of each 100 can come back, falling over 26 weeks of check-ins to nothing (`mostBack` in `calls.ts`) | `money-screens` A5, `numbers.test.ts`, `money.spec.ts` |
| A6 a cheaper earlier round was never named | the Back box names every earlier round priced differently | `money-screens` A6 |
| A7 an oversubscribed round promised full Shares | the box shows dollars asked so far of the round's size; the sheet's Shares estimate and "about N of each 100" use what has been asked | `money-screens` A7 |
| A8 a round past its 24 hours read "open now" | rounds are open, waiting to be closed, or closed; Open backing is hidden while any round is not closed | `money-screens` A8, `numbers.test.ts`; the Project page's half had none at first, now `ProjectPage.test.tsx` |
| A9 taking out released Shares was one unreviewed press | a sheet first, naming the Shares and the refund it ends (about X dollars as of the record's time); 2 presses | `money-screens` A9 |
| A10 a retry after "not landed yet" sent a second ask | a sent call whose outcome is unknown is remembered per step (`pending-sends.ts`, this browser's storage, at most 50); the next press looks it up and sends again only if the network says it reverted or never saw it, and only the calls after the last one that landed | `money-screens` A10 (3 cases, now in `money-sends.test.tsx`), `wallet.test.ts`. A call sped up in the wallet was still asked twice: fixed under "Review of the review fixes" |

None was declined.

### Gates after the review fixes

| Gate | Result |
|---|---|
| app `tsc --noEmit`, `biome check .` | clean |
| app copy check, px-text, file sizes (`CHECK_FILE_SIZES_BASE=3d7ecf83d`) | pass |
| app `vitest` | **85 passed** (part 2: 63) |
| app `vite build` + bundle budget | entry 389 KiB of 450 (part 2: 384) |
| Playwright `smoke`, 390x844 touch | **38 passed** (part 2: 36; `money-review.spec.ts` adds F1 and F2). On the first full run the passkey spec failed once (the unlock bar did not show within 20 seconds of the reload, right after the 12 axe runs); it passed alone and in a full re-run. Recorded as possibly flaky |
| Playwright `screens` | 9 passed; 18 shots, every hash distinct |
| `knip` (whole repo) | clean |
| `node scripts/regen-kinds.mjs --check` | up to date |

`packages/creaton-core` and `web/` did not change in these fixes, so their gates were not re-run. Not run: cargo, forge.

### Still open after the review fixes

- The steps waiting to be looked up live in this browser's storage. A backer who switches devices while a call is
  pending is not protected from a second ask there; reading `Rounds.positionOf(round, me)` before every ask would be
  (it is now read only when a waiting ask's place was taken by another call, below).
- The passkey spec failed once in a full smoke run and passed on both re-runs; if it repeats, look at the reload's
  timing after the axe runs.
- You reads at most 500 records of numbers. Past that it says the list may be incomplete; reading a backer's projects
  directly needs a backer index on the record (server work).

### Review of the review fixes (18 November 2026)

A review of the fixes above found one more way to ask twice (A10), the four missing tests named in the correction
above, and an optional finding about pending-send keys. All are fixed. Each guard below was removed once and its test
seen to fail, then put back.

| Finding | Fix | Test |
|---|---|---|
| A10 left over: a call sped up in the wallet lands under a new hash; the old hash reads "unknown" and the step was sent again | the wallet keeps the sending account and the call's nonce (from the network's copy of the call, else the account's count before sending) with the waiting step. A gone hash whose nonce was used reads "replaced"; one whose nonce another waiting call holds reads "waiting"; a nonce not known is never taken as "never sent". For Back, a replaced ask is looked for in `Rounds.positionOf(round, me)` first (found when this account's ask there is at least the waiting amount); other steps are not sent again and the person is told to look in the wallet | `money-sends.test.tsx` (sped up: found, cancelled, a smaller earlier ask, a replacement still waiting; a refund not sent again), `wallet.test.ts` (outcomes, nonce kept, nonce fallback) |
| Pending-send keys left out the sender and Back's amount | a step is kept per action and sending account (`sendKey`), so another account's call is never taken for this one's. A Back keeps its amount: the sheet names a waiting amount that differs from the one typed, the toast names the amount that landed, and an approval of another amount is sent again rather than skipped | `money-sends.test.tsx` (account switch, amount change, approval of another amount) |
| F5 had no test of who gets the button | none needed in code | `money-gates.test.tsx` F5 (a wallet other than the runner: the runner line, no press), `ProjectPage.test.tsx` (no Open backing at Team) |
| A8's Project-page half had no test | none needed in code | `ProjectPage.test.tsx` (a round past its 24 hours and not closed: no Back box, no Open backing; Backed with every round closed as the control) |
| F9 had no test | none needed in code | `money-gates.test.tsx` F9 (a copy naming the same launch listed before, and after, the real record: the receipt keeps the real name; the first fails with the candidate loop taking the first record, the second with the code before F9) |
| The weekly sheet's double-submit guard had no test | none needed in code | `WeeklySheet.test.tsx` (a quick double press posts once, and checks in once) |

The money screens' shared test harness moved to `app/tests/helpers/money-harness.tsx`, and the waiting-call tests
from `money-screens.test.tsx` to `money-sends.test.tsx`.

Gates after these fixes (app only; nothing outside `app/` changed): `biome check .`, `tsc --noEmit`, copy check,
px-text and file sizes (`CHECK_FILE_SIZES_BASE=3d7ecf83d`) clean; `vitest` **104 passed** (16 files; was 85);
`pnpm build` with the bundle budget, entry 391 KiB of 450; Playwright `smoke` at 390x844 touch, **38 passed**.

Still open from that review: when the record's `truncated` flag comes from the holders list alone, Receipts says the
refund is not known yet. Telling which list was cut needs the record to say so (server work). The weekly sheet and
Check in only share the check-in's waiting call but not the in-flight guard, which lives in each button's hook. The
sheet is modal and cannot close while it sends, but a person who presses Check in only and then opens the sheet and
posts while that check-in is still in flight sends a second check-in (it costs a second fee and changes nothing else).
