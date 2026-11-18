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
