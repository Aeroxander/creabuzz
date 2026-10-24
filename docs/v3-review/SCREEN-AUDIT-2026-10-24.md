# Screen audit, 2026-10-24

Every screen of the web app, opened as the people who use it, at desktop and phone width, with real data behind it, and
read for its words and its forms. Before this, the app had been checked mostly by unit tests, mocked browser specs and
chain simulations; the last screen pass (`SCREEN-AUDIT-2026-10-19.md`) covered eight pages on mocked data.

**The standard** (yours): plain words a person new to crypto understands, no over-explaining, nothing that sounds
machine-written. "DAO" and "wallet" stay; other technical words (relay, Nostr, gas, chain ids, hashes, explorers,
on-chain) leave the main text. Out-of-scope screens (sale, Markets, repositories, wiki, AI helpers) stay reachable and
were reviewed too.

## How it was done

`scripts/web-screen-audit.sh` builds a world on real components and photographs it:

- a dev chain with the contributor kit and the launch kit, the real server on a scratch database at `localhost:3199`
  serving a production build of the app;
- the social seeds (`seed.mjs`, `seed-social.mjs`, `seed-demo.mjs`), then `web/tests/e2e-real/audit-world.spec.ts`
  builds the rest through the pages: the Creaton contributor project from `CREATON-EXAMPLE-PROJECT.md` with its four
  work areas, one piece of work submitted, reviewed, finished and awarded by vote, another waiting for review, a
  newcomer's suggestion put to a vote that is still open, wallets connected to profiles, a supporters board with rules,
  a moderator, a pinned and a locked thread, replies and a report, a private room;
- `web/tests/e2e-real/screen-audit.spec.ts` opens 118 stops as eight people (a visitor, a brand-new account, a member,
  the founder, a reviewer, a contributor, a board moderator, the server's owner), each at 1280×800 and 390×844 (and
  dark for the top-level pages), and saves the PNG, the words on screen and an index with accessibility findings and
  sideways scroll.

`KEEP=1` leaves the world up for a look by hand. Screenshots: `test-results/screen-audit-2026-10-24/before/` and
`after/` (not committed).

## What was wrong, and what changed

### Signing up, signing in, signing out

| Problem | What changed |
|---|---|
| No way to sign out: the "Sign out" dialog existed, but nothing opened it, and it made a new empty account instead | **Sign out** at the bottom of the profile menu removes the account from this browser and goes to Home. Without a saved recovery key it says so and offers **Save recovery key** first |
| No way back in on a new browser: a recovery key could only be pasted when the stored key was unreadable | Sign-up has **I already have an account**: paste the recovery key (the 64 characters the app shows, or an `nsec1…` key from another app) |
| Sign-up read upside down: terms, then "Continue with a passkey (nothing to remember)", then "or without a passkey", then the title; placeholders instead of labels; "what you ask your AI helpers to do" | Title first, labelled **Name** and **About you (optional)**, the terms, **Create with a passkey** with one line on what a passkey is, then **Create without a passkey**; "Not now"; errors say what to do |
| The recovery-key note: the desktop app, "app signing activation", "the interim path" | Two sentences: what the key does, and that anyone who has it can act as you |
| "Unbind wallet … the binding is kept for audit" | **Disconnect wallet**: "It can no longer act for your account here." |
| A new account with no name showed its short key twice in the menu | It says "Your account" |
| The menu's "Save a recovery key (recommended)" wrapped and centred on a phone, right under a note saying the same | "Save a recovery key", aligned like the other items |
| Signed out, Home offered "Create your account" in the welcome and again in the line right under it | Once, in the welcome |
| On a phone the account menu opened downward from the bottom bar, off the screen: only its first line showed, so Edit profile, the recovery key and Sign out could not be reached | It opens upward, all of it on screen: a menu that opens "above" is pinned by its bottom edge, follows its button on every frame while open (it used to re-measure only on scroll and resize, so content loading late left it behind) and never goes past the bottom of the window |
| Home's **Get started** for a new account was about the raise: "I want to back projects", "Backing is a bid in an open sale; if the sale misses its minimum, every bid is refunded", "Back a project … put money in"; for founders, "Set up your funding agreement … the team's tokens" and "Put an AI helper to work" | **I want to help on projects**: add your name, look at a project, follow a project or a person. **I'm starting a project**: add your name, start your project (Go opens the contributor form). Nothing about money |
| Connecting a wallet: "Your wallet and Nostr account will both sign the link… proves control of the two keys… public transaction history"; "Sign and publish wallet"; a failure said only "Couldn't update your payment wallet." | **Connect payment wallet**: "Projects send what you earn to this wallet. Connecting it does not let anyone spend from it." A failure says what happened (cancelled, wrong network, or the wallet's own reason) |
| The wallet on a profile: "Both signatures verified · Local Anvil · Chain 31337 … linked to this Nostr account. Confirm the agreed amount, token and network before paying." | "Verified", the network's name, and "Before sending anything, check you are on the same network." |

### Home and the social side

| Problem | What changed |
|---|---|
| The signed-out welcome: "Back teams. Follow what they build." and tokens unlocking at milestones: the sale, not this release | "Find projects. Help build them." and three ideas: join the conversation, do useful work, earn a say |
| The right rail's "Trending launches" showed the contributor project as "Sale completed" with "No chain data" | "Trending projects"; a contributor project says "Looking for contributors" and shows no funding bar; no card says "No chain data" |
| The composer: "share outside this server, on public Nostr" | "Also share with other apps (copies there can't be deleted)" |
| Messages: "Let people on other Nostr apps message you here…" | "Let people using other apps message you here." |
| A profile's "Launches" tab | "Projects" |
| Not found: "That address does not match a page in this workspace." | "This page doesn't exist. It may have moved, or the link may be wrong." |
| A name followed by a wallet address everywhere in projects ("Frida Lund (0xf39f…2266)") | The name alone (the address stays in pickers, where it tells same-named people apart). This reverses an earlier choice that a test recorded on purpose; see "For you" |

### Phones

| Problem | What changed |
|---|---|
| No **Start** and no search on a phone; a signed-out visitor had no Explore either (the strip hid itself with one item) | Start is a tab in the bottom bar; the social strip always shows, with **Search** in it |

### Contributor projects (the core of this release)

| Problem | What changed |
|---|---|
| Tabs about money and sales on a project with neither: Treasury ("There is no DAO for this project yet", graduation splits, price floors, RPC, SubDAOs), Track record ("the team can sell theirs whenever they like", which is false), People & agents, Manage (the sale checklist and the auction set-up, with "floorPrice: floorPrice must be a whole number:") | A contributor project shows Overview, Contributions, Decisions, Work, Discussion and Updates; a link to another tab opens the Overview |
| The Overview: "Needs you: Connect your wallet…" for a visitor; "0 USDC in the treasury"; "Where the treasury's money went"; "Money that came in … besides the raise"; a workspace task board saying "No work is under way yet" beside "1 piece of work is in progress"; "About the raise this project came from" | Needs you only for someone with a wallet; the figures are Shares in all and what you hold; the money, task-board and raise cards are gone |
| The header: "No token sale at setup: it was made by the contributor kit." "Shares are locked: they cannot be sent between wallets." The back link said "Launchpad" | "No token sale." "New Shares come only from awards for reviewed work." "Shares can't be sold or sent to others." Back to **Discover** |
| Work: a broken sentence ("New Shares are only ever pay for accepted work"); a visitor told to install a wallet extension and shown the submit form; "(no explorer on this chain)"; "the text the claim committed to on the network"; "Reviewer bond: None: a reviewer risks nothing by approving carelessly"; the budget and the DAO by address | One-line intro; a visitor sees **Create your account** instead of the form, and no wallet line; transactions show only their id where the network has no public page; "These are the words it was submitted with."; "None"; "Work budget"; **Submitted work** |
| Decisions: "Judged by the check 0x6dcd8276…"; "In the work budget 0xda1a2e33…" in full; the rules in one dense sentence; "No side"; "Count me in, no side" | The work area's words when they were published; no address; "Passes when … for 6 hours in a row. It then waits 1 day…"; **Neutral** |
| The decision picker offered money decisions (pay, unwind, take a bond) on a project with no money | Not offered on a contributor project |
| A vote's progress: "10,800 more Shares needed to meet the bars. Support stays movable until it runs."; someone with no Shares was told they cannot vote, then shown the amount box and the three vote buttons | "10,800 more Shares need to take part" (or "need to back it", whichever is short) "Votes can change until it is carried out."; with no Shares only the sentence shows, and voting for someone who gave you their vote stays under its fold |
| Work explained the process three times (the tab, Ways to help, the submit form); every finished claim said "asks for Shares, not money" and "No money was asked for." on projects where no claim can ask for money; a short-name error said "claim" under a field called "Name your work" | Explained once, at the submit form; the money lines only where money is possible; "Give your work a short name, up to 32 characters." |
| Contributions: an over-explained intro; "about 43,515.15 more Shares"; evidence that is only a link quoted as a long raw address | Two short sentences; whole Shares; **Open what they delivered** |
| Start a contributor project: five bullets, Shares called "the token", "Every claim says it meets this" | Four short bullets that keep every promise the earlier review asked for; "A short code for the Shares"; "The reviewers check each submission against these words. They can't be changed later." |
| Work said "pick, do, submit" twice in a row (the tab's intro, then Ways to help); the form's examples were code-like names ("docs", "docs-es"), and the example project's work areas followed them ("bug-report", "first-hour-notes"), so they read like code wherever they appear | Ways to help says only "Each says what finished work looks like."; the examples are "Bug reports" and "Spanish guide"; `CREATON-EXAMPLE-PROJECT.md` names its work areas Your first hour, A plain guide, Phone check and Bug reports (the audit world still uses the old names) |
| Discover's project cards: small grey text below the contrast minimum | Darker |

### Communities and the rest

| Problem | What changed |
|---|---|
| Every community in the list was called "Buzz Relay — Buzz — private team communication relay" (the upstream server's built-in name) | The server calls itself Creaton; a community is shown by its address until it has a name |
| The invite page offered the desktop app ("Accept invite in Creaton", "Download it now", "Browse releases", the last two pointing at upstream Buzz's releases) and called the policies "Terms of Service" and "Privacy Policy" | No desktop app is offered unless a build sets `VITE_DESKTOP_APP=1`; "Terms of use" and "Privacy note", as everywhere else |
| Repositories: "Open this community in the Creaton desktop app to start pushing code." | "Code repositories pushed to this community show up here." |
| The projects board: "The launchpad turns a recorded ownership map into token allocations at launch." | "Ready to raise money later? The agreed shares carry over to the project's launch." |
| Accessibility: low-contrast grey and amber text (Discover, Manage, the recovery-key note), unlabelled picture uploads, a link told apart by colour only | Darker text, labels on the uploads, the link underlined |

### Kept from coming back

`scripts/check-copy-core.mjs` has a new rule, **plain-words**, that fails the build on "Nostr account/app/key", "on public
Nostr" and "no explorer" in text people read (the desktop app's two such sentences were rewritten too).

## For you

- **Names without addresses.** Lists now show "Frida Lund", not "Frida Lund (0xf39f…2266)". An earlier change kept the
  address "so the name is never the only thing to go on". Names are self-chosen, so two people can share one; pickers
  (reviewers, recipients) still show the address. Say if you want it back in lists.
- **"Claim" or "submission".** The forms now say "Submit your work" and "Submitted work", but statuses and decisions
  still say "claim" ("Award 8,000 Shares for the claim…"). One word throughout would be plainer; changing it touches many
  screens.
- **A community opens on "Select a channel to start reading."** Opening #general by default would be friendlier.
- **Members see Set up community, Wiki, AI helpers, Work and Org** in a community's sidebar. You chose to keep
  out-of-scope screens reachable; hiding them from members (not owners) would tidy the sidebar.
- **People and access** said "The list of people is not available here." for the server's owner in this world, and an
  open community offers no invite link. Worth checking on the hosted server before inviting people.
- **The demo passkey page** (`/identity-demo`) ships in production builds because the passkey tests use it. It is unlisted.
- **Account ids next to names** in the timeline ("ab5d2e79…168d") are still shown. They tell same-named people apart;
  hiding them is a product choice.

- **Two scrolling panels can't be reached by keyboard** on a phone: the wiki's page list and the AI helpers' roster. Both
  are out of scope for this release, so they were left.
- **A visitor sees "You hold —"** on a project's Overview. Hiding the figure until there is a wallet would be cleaner.

## Numbers

| | Before | After |
|---|---|---|
| Stops (screens, dialogs, forms, states) | 118 | 115 (the three money decisions are no longer offered on a contributor project) |
| Screenshots | 242 | 236 |
| Stops that could not be opened | 16 (the capture's own selectors, fixed first) | 0 |
| Screenshots with a serious or critical accessibility finding | 22 (contrast 10, missing labels 8, colour-only links 2, keyboard-unreachable scrolling 2) | 2 (the two out-of-scope panels above) |
| Sideways scroll on a phone | 0 | 0 |
| Words on the same 218 screenshots | 75,021 | 70,125 (−6.5%) |
| Words on the project pages alone (65 screenshots) | 39,386 | 30,436 (−23%) |

The stops touched by the last fixes (Home's Get started, the account menu, Work, Decisions, Discover) were shot again
after them. A shot taken while a list still said "Reading…" is now waited out; Home's Projects tab was the one caught
that way.

Checks run with these changes: `pnpm --dir web test` (1914, with the new home-steps, voting and recovery-key cases),
`pnpm --dir web check` (biome, copy, px text, kinds), `tsc`, the file-size gate, `cargo test -p buzz-relay --lib --
nip11 communities` (34), the mocked browser suite (`pnpm test:e2e:smoke`), and on a real chain or server
`scripts/web-contributor-e2e.sh` (2 journeys), `scripts/web-work-e2e.sh` and `scripts/web-social-e2e.sh` (22). The
phone-menu test fails against both earlier versions of the menu's placement: the first left its bottom edge at 1253 px
on an 844 px screen, the second stayed put when the bar under it moved. By hand, on a phone-sized window on the audit
world: sign up, Get started (both paths), the account menu, sign out with and without a saved key, a wrong key, signing
back in as the same person. Not run: the desktop app's browser suite (out of this release; one of its expected strings
was updated to match).
