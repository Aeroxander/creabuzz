# Does the product make sense? (2026-10-09)

Written after reading the first-run screens as a newcomer would meet them (screenshots from `web/tests/e2e/tour.spec.ts`)
and the DAO's own pages on a real local chain (the journey specs, run with `E2E_SHOTS=<dir>`), not from the code alone.

## The short answer

The loop makes sense. It is written down in [`docs/dao-os.md`](../dao-os.md): **start** a project, **staff** it with
people and agents, let them **work**, **approve** what agents ask for, **fund** it with a sale, **govern** it as a DAO,
**reward** the work. Every step has a contract or a record behind it and most have a real-chain browser test.

The app did not show that loop. It showed the order in which the pieces were built. Reading the screens:

- **Seven top-level tabs** (Home, Social, Communities, Discover, Launches, Projects, Portfolio) where two of them
  (Discover and Projects) listed the same projects.
- **Five ways to start something** that look alike: "Start an idea", "Set up a sale", "Pitch a project", "Form the DAO"
  (from a project) and the DAO option inside the sale wizard. There was no way to start an *organization* on the web at
  all; the Org page was a read-only chart.
- **A founder's first screens were written for the contract.** The sale wizard's steps were "Token, Sale, Unlocks, DAO"
  and talked about a "verifier-set picker", "summoning from the Project Board" and an "Equity map". The Manage tab opened
  on trust-score publishing and how the contract sweeps funds.
- **A DAO's page was the raise it came from**, long after the raise ended: "Back this launch", "Raised —", "What happens
  at the end", "Auction contract: not set". The things people come back for (what needs me, what is going on) were
  tabs away.
- **The Org page was broken**: its header overlapped the budgets, and once an org existed its chart collapsed to zero
  height. The tests only checked that the text was in the page.
- **Dialogs were see-through** and a toast in the corner could sit on top of the Continue button and stay there while the
  pointer was over it.

## What changed in this pass

| What | Where | Why |
|---|---|---|
| Upstream block/buzz merged (106 commits) | `0348d2c0a`, `32b7e6548` | See "The upstream merge" below. |
| Dialogs are an opaque card; toasts at the top | `globals.css`, `Modal.tsx`, `sonner.tsx` | Text showed through forms; a toast covered the button it was about. |
| **Start an organization** from the Org page, in four short steps (name, first helper, how much helpers may do alone, review) | `fleet/lib/org-setup.ts`, `fleet/ui/OrgSetup.tsx` | The web could not create an org; the desktop's asks for grants, verbs and epoch windows. Only limits the server really counts are offered. |
| The Org page works: header, chart, health checks tucked away, "Helper" not "Agent_seat" | `fleet/ui/OrgView.tsx` | See above. |
| The sale wizard in plain words: Project, Raise, Your Shares, Rules | `wizard.ts`, `WizardSteps.tsx`, `CreateLaunchDialog.tsx` | A founder should not need the contract's vocabulary. |
| Creating the token in plain words, command line folded away | `TokenMintPanel.tsx`, `mint-flow.ts` | Same. |
| Manage tab: what is left before the sale opens, then the actions, then terms; operator tools under "Expert tools" | `ManagePanel.tsx` | It opened on tools nobody needs on day one. |
| **A DAO's front page**: where things stand, needs you, treasury / Shares / yours, latest decisions; the raise folded underneath | `DaoOverview.tsx`, `lib/dao-overview.ts` | The Paperclip questions: what is happening, does it need me, what do I do about it. |
| Home opens on your organizations and what waits for you | `feed/ui/HomeYours.tsx` | Someone who runs a project needs that before a feed. |
| Six tabs: Projects moved under Discover; Portfolio is a phone tab; a DAO's tabs lead with Decisions and Work | `AppNav.tsx`, `LaunchDetailPage.tsx` | See above. |

## What I did not change, and what you may want to decide

These are product calls, so they are yours. Each is a way the app still has two answers to one question.

1. **Two ways to form a DAO.** The Project board can "summon" one from a pitch (the older path, with an equity map of
   recorded stakes); the launch kit forms the DAO, locks the team's Shares behind milestones and runs the sale in one
   transaction (the current path). *Suggestion:* the kit is the only way to form a DAO; the Project board stays for
   roles and recorded stakes.
2. **Two proposal systems.** The recorded "Proposals" tab and the chain-read "Decisions" tab. For a DAO whose decisions
   are read from the chain, Proposals now only appears if it has something in it. *Suggestion:* retire it for kit DAOs.
3. **Milestone attestation** (staked claims settled by a verifier set) is the older answer to what the milestone lock now
   does with the DAO's own reviewers. It is under "Expert tools". *Suggestion:* remove it once no launch without the kit
   needs it.
4. **Authority grants (delegation chains) have no web page.** The relay enforces them and the CLI and desktop can write
   them; the web's setup deliberately does not offer them. *Suggestion:* leave it there until someone asks.
5. **Two social feeds** (Home and Social), as agreed: left alone for now.
6. **`/identity-demo`** is a test harness, reachable only by address. Fine.
7. **Desktop and mobile** were merged but are not being worked on. The desktop typechecks and `cargo check --tests`
   passes; its tests and the mobile app were not run.

## Paperclip: what was taken, what was not

Taken (their principles, not their pixels): one question at a time to get to a first success (the org setup), "what is
happening / does it need me / what do I do" as the order of a front page (the DAO overview, Home), words that name the
action ("Start the organization", "Review it", not "Submit"), and honest empty states.

Not taken, because the web has no data for them yet: run activity and agent heartbeat charts, a task board with a column
per role, an audit-log page, agent memory on the org card. `docs/paperclip-parity-status.md` lists them as the open gaps.

## The upstream merge

106 commits since the last sync. 25 files conflicted. The two that mattered:

- **Migration numbers.** Upstream took 0054-0057, which our fork's five migrations also used. They are now 0058-0062
  (byte-identical files, so their checksums are unchanged). A database that recorded them under either older numbering
  (the org-graph fork's 0045-0049, or the first merge's 0054-0058) is repaired at startup, matched on version *and*
  description so upstream's own rows are never touched. Your local `buzz` database is at the first-merge numbering, so
  it will be repaired the first time the relay starts.
- **The schema is now one file per table.** Our three tables moved into upstream's layout; the parity test against the
  migrations passes.

Checked: all unit tests of the four crates we changed (2,887 passed, none failed), the Postgres-backed migration and
schema tests (28) and the nine that need their own databases, upstream's new source guard, and every real-chain browser
journey (DAO, decisions, paid work, work, milestone, DAO launch). Not run: `cargo nextest` (not installed), the market
journey (needs LBAMM cloned outside the repo), desktop and mobile tests.

## Things that were already broken, found on the way

Both items below were fixed afterwards, in the hardening pass (see the end of this document): the 13 failing browser
tests turned out to hide a real bug in the account menu, and `WikiView.tsx` is now under the file-size limit.

## The clean-up pass (2026-10-09)

You asked for the cleaning to come from reading the whole code, not from the tests. What was run, over all of `web/`,
`packages/creaton-core/`, `crates/` and `scripts/` (the desktop for the parts we added):

- a TypeScript-compiler scan that follows imports from the app's entry point (files nothing reaches) and every
  `export` (declarations nobody imports), cross-checked against everything that mentions the name: tests, scripts,
  Rust, Solidity and docs, because the golden tests reach code through one-line re-exports;
- Knip (run with `npx`, not added to the repo), which agreed with the scan on the web app and found nothing it missed;
- a token-level clone finder (runs of 60 or more identical tokens in different files, ignoring comments and string
  contents), run over web, core, the Rust crates and the scripts, then again after each round of fixes;
- rustc's own dead-code warnings for the whole workspace, an identifier count for public Rust items, and an unused
  Cargo dependency check.

**Removed because nothing used it**

| What | Why it could go |
|---|---|
| The proposal vault (contract, tests, panel, library, its browser journey, the "simulate" suite) and the two funding paths that only it served (D18) | Nothing in the product reached it; the Shares are how people join |
| 50 exported declarations and 4 files in web and core | No importer anywhere, tests included |
| The Paperclip two-way bridge loop (D19) | Already marked deprecated; `sync`, `apply` and `invite` stay |
| `quorumWatch` and the agent nudge message beside it | The cards compute the same badge with `votingRuleWatch`; nothing sent the nudge |
| The web's Inter font package, two unused Cargo dependencies, five Rust helpers, an unused test constant | Never imported |
| The five `contracts/deployments/*.json` files (D20) | Output of local runs; now ignored |
| 11 superseded plans and audits moved to `docs/archive/` (D22) | Their decisions are made |

**Written once instead of two to fourteen times** (the first column is how many copies there were)

| Copies | What | Now lives in |
|---|---|---|
| 14 | "first value of this tag" | `web/src/shared/lib/event-fields.ts` |
| 6 | "content as a JSON object" | same file |
| 12 | sign as the user, send, and refuse on a "no" | `web/src/shared/lib/publish-as-user.ts` |
| 4 | the read-only `eth_call` helper of the CLI's chain clients | `crates/buzz-cli/src/commands/evm_read.rs` |
| 4 | the connected-wallet lookup | `useConnectedWallet` |
| 3 | the step-by-step money-action reducer (exit, ragequit, summon) | `packages/creaton-core/src/launchpad/step-flow.ts` |
| 3 | "a wallet is connected and on the right chain" | `walletGate` in core |
| 2 each | the token-deploy builder, the Merkle level builder, the graduation record decoder, the receipt read, the project card, the hashtag row, the task publisher, the passkey base64 helpers, the in-flight/failed bookkeeping of two lists, and six modules that existed in both the web and desktop apps | one copy each |

Net effect on code (docs, lockfiles and archived plans left out): about 9,000 fewer lines in 171 files, 41 files
deleted, 17 added (the shared helpers and their tests).

**Two real defects the comparison turned up**

- The moderation queue and the workflow run list were meant to stop refreshing themselves after fifteen minutes. A
  timer tick called the same function the Refresh button calls, and that function restarted the fifteen minutes, so
  both polled forever and the "paused" message could not appear. They share `useBoundedPoll` now, and
  `polling-bounds.spec.ts` runs sixteen faked minutes through the run list. I checked that it fails on the old
  behaviour.
- `input_order_does_not_change_the_root` in the trust-score composer had no `#[test]` attribute, so it never ran. It
  does now, and passes.

**Looked at and kept, on purpose**

- Two near-identical project cards used to exist; the Project Board and Discover still both exist (you decided to keep
  both), they just share the card.
- `buzz-backend-ax` (a skeleton provider for a third-party sandbox, with a design doc) uses nothing and nothing uses
  it, but it is a deliberate new provider, not leftover code. Say the word and it goes; it is in git either way.
- The legacy token and royalty path (`dao-os.md` still documents it), `ShareVesting.sol`, the sandbox launch, the
  kernel and ZeroDev scripts (they check a live test network, and nothing else runs them).
- The social feed copies (`NoteCard` / `PostCard`): Home and Social stay separate for now (decided earlier).
- Upstream's own repeated test setup in the relay: it is upstream's, and rewriting it would only create merge
  conflicts.
- The TanStack Query refetch timers in the web app: they pause in a hidden tab and the data is live while you look.

**Checked after the last change:** web typecheck, 1,224 web unit tests, 680 core tests, the web checks (`pnpm check`),
the desktop typecheck and its 8,119 unit tests, seven real-chain browser journeys (work, paid work, DAO launch, DAO,
decisions, milestone, auction), `cargo fmt`, the whole Rust workspace with `cargo check --all-targets` (no warnings left), 744
CLI tests, the Paperclip, agwiki and provider tests, and the mocked browser suite: 194 pass and 26 are skipped (they
need a local chain); the 13 that failed before this work were fixed afterwards (see the next section).

## What would help next

In this order: (1) your call on the six items above; (2) a "Set up a work budget" shortcut on the DAO's front page when it
has none, so the first thing a new DAO shows is one button, not an empty list; (3) the audit-log page, since every
change to an org is already signed and chained; (4) forms for the rarer DAO powers still on the command line.

## Hardening the front door (2026-10-10)

You asked for the product to be made production-ready. The first piece was the 13 mocked browser tests that had been
failing since before this work and were taken for old noise. Looking at each one:

| What was wrong | Real or out of date |
|---|---|
| **The account menu closed under the mouse.** Edit profile, Appearance, Back up key, Unbind wallet and Sign out did nothing for a person with a mouse. The menu had been moved out of the top bar so its blur would not trap it, but the click-outside check still only knew the old place. One line; three of the failing tests. | **Real** |
| The wiki's page list never refreshed and ignored deletions, so another person's delete or new page only showed after a reload | **Real** |
| A server that hung up without answering left a post waiting about twelve seconds, and held up the optional copy to the second public relay | **Real** |
| Seven tests that still looked for things that had moved: the logo (now in the top bar), the connect-to-a-relay form (now on the repositories page), the wiki list items, the delete message ("Moved … to Recently deleted"), who may delete a page (its author), and a reconnect test that counted requests though the page keeps six live subscriptions (it counts reconnect rounds now, and still fails on a one-second loop) | Out of date |

Also found and fixed on the way:

- **A deployed site would have read the chain from each visitor's own computer.** With no chain endpoint configured,
  chain reads defaulted to a local test chain (`127.0.0.1:8545`). That default now applies only to a page served from
  this machine; elsewhere the page says it is not connected to a chain yet until the build sets `VITE_CHAIN_RPC_URL`.
  **For hosting: set `VITE_CHAIN_RPC_URL` (and the chain id) in the production build.**
- `WikiView.tsx` was over the repo's file-size limit and would have blocked a push; its delete, permanent delete and
  restore flow is now its own hook (893 lines, no behaviour change).

New: `web/tests/e2e/first-run.spec.ts` is a newcomer's first visit (sign up with a name, use the account menu, start an
organization, reload and find it) and fails on any uncaught error or console error. It was checked to fail without the
menu fix. The mocked browser suite is now 194 pass, 26 skipped (they need a local chain), 0 fail.

What the first screens say to the people you named (musicians, filmmakers, programmers, web2 teams) is the next piece:
Home still reads as a launchpad feed ("Trending launches", "Also share on public Nostr", "Closing soon / Graduated"), and
sign-up talks about identities, keys and wallets.


## Making the first hour make sense (2026-10-10)

The next piece after the front door: what a newcomer sees and can do in the first hour, for the people you named.

**Plain words.** Home, sign-up and the account menu now talk about an account and a recovery key, not an identity, a
key or a wallet. The wording lives in one file (`web/src/features/identity/lib/account-copy.ts`) so the buttons, the
nudges ("Create your account (top right) to …") and the dialogs say the same thing. Home's welcome is three ideas:
start from a ready-made team, AI helpers that ask first, share what you build when you're ready.

**Start a project, in the browser.** The four bundled teams (AI media studio, AI app studio, crypto app studio, web &
app studio) can be started from the web app: pick one, see in plain words what you get (channels, AI helpers, shared
pages, a limit for helpers), and it is written to the server as you, step by step with progress. If the server refuses
a step, it says which and what to do, keeps what went through, and the same button picks up from there without writing
anything twice. It is the same plan as `buzz templates apply`, ported to TypeScript (`packages/creaton-core/src/templates/`)
with tests that compare it to the Rust one. The templates under `templates/` are bundled by
`node scripts/regen-template-catalog.mjs` (`pnpm check` fails when they are stale). Two differences from the command
line: shared pages are saved as wiki pages (the CLI writes long-form notes), and a skill fetched from a web address
needs the command line (the screen says so).

**Three ways to run a helper.** A team comes with a seat per helper (The Writer, The Producer, …). The AI helpers page
lists the seats and describes the three ways to run one, each with what is true on *this* server right now:

| Way | What it does | Status |
|---|---|---|
| In this tab | Runs under the helper's own name and prompt while the tab is open. The owner's account signs the record that puts it in its seat. One helper per tab. Needs the server to have an AI service (`/llm/chat/completions`); the page checks and says if not. | Built and tested here |
| On the server | `buzz-fleet-worker` next to the server keeps helpers working with every laptop closed. The page shows when one is running and the settings it needs. | Existing worker; the page detects and explains it |
| On your computer | The desktop app / command line / `buzz-community-mcp` for Claude or ChatGPT desktop. | Existing; the page points to it, no new setup flow |

Because the browser community is where we want people to work, the browser and the page do the work for the first two;
the third is for people who already use a desktop assistant.

**Home's "Get started" list** asks for a name, a project and a helper (the way in); following someone and raising money
are optional and never hold the list open. Each box is ticked only for something that happened in this browser.
An empty community you are connected to opens the app with a "Start a project" prompt instead of a "Join in browser"
card that only reloaded the same page.

Tests: `start-project`, `helpers` and `home-checklist` specs; the mocked browser suite is 206 pass, 26 skipped, 0 fail.

**Not done, and why.**
- Minting a key and authorization for a helper in the browser so Claude or ChatGPT desktop can connect from a button:
  I could not verify it without a live server, so the page links to the existing route instead.
- Only the mocked server has exercised these writes. A run against a real server (org and persona records accepted, a
  second tab seeing the seat) is yours or the next pass.
- A helper only knows a tab is running it when that tab does; "on the server" and "on your computer" are reported from
  what the helper announces, so a worker that is down for under a minute still looks running.
- A seeded demo organization for people who just want to look around is not built.

## Boards, and talking about decisions (2026-10-10)

The question was how Twitter-style posts, a Reddit-style forum and Slack-style chat should fit together, and where a DAO
discusses its proposals (most use Discourse). The call: three surfaces with one job each, and the forum is the missing
one. The server already had it (forum posts, votes and comments, a forum channel type, a desktop view); the web app
let you create a "forum" channel but showed it as a plain chat. The jobs: microblog posts are for reach and stay
standard notes any Nostr client can read; a board is for belonging and memory, community by community (the lasting
discussion, supporters' questions, a DAO's proposal threads); chat is for what only matters this hour. What was built:

- **Boards in the web app.** A forum channel opens as a board: posts with a title and details, replies, one vote per
  person on each. Sorts are Active (default), New and Top. The page is live but holds still while it is read: counts
  change in place, a post does not jump because someone replied, other people's new posts wait behind a "show" button,
  and your own post goes straight to the top. A post links (`?channel=…&post=…`). Records are the existing forum kinds,
  written exactly as the Rust SDK does, so desktop and mobile read them; a title is the first line as a Markdown heading.
- **A vote bug found by testing:** changing a vote and then taking it back deleted only the newest vote record, so the
  earlier one counted again. Changing or taking back a vote now deletes every earlier record of the reader's (unit test,
  browser test, and checked on the real server: both records end up deleted).
- **Two boards per project.** Every bundled template now makes an open *supporters* board and a private *founders* board,
  each with a first post (`type: board` and `visibility: private` in `template.yaml`; the Rust command line and the
  TypeScript engine changed together and both have tests). A community with no boards gets a one-click "Add supporters
  and founders boards". A private board shows who can read it ("People") and lets its owner or an admin add someone by
  pasting an npub or picking someone who has spoken in the community. **Found by a failing test:** applying a template a
  second time would have posted the board first-posts twice, because the "what is already there" read only looked for
  chat messages.
- **Discussion under each decision.** On the Decisions tab every decision lists the threads about it and has "Start a
  discussion". A thread names its decision with two topic tags; opening one shows the decision's live state from the
  chain, a link back to the vote, and each person's share of the DAO's Shares beside their name. A post's tag is only a
  claim, so the header and the figures appear only for a DAO that a launch the app knows has settled into; otherwise it
  says the post could not be checked. Board votes are labelled as not the DAO's vote and are never weighted.

**Checked on a real server** (the local one, through the app): create a board, post, reply, vote, change the vote and
take it back (the server soft-deletes the records; a reload stays at zero), two boards created back to back, and a
template run, which got through all six channels (two of them boards, one private), both board first-posts, the skill
and all six helpers in about a second. **Checked on a real local chain** (`scripts/web-discussion-e2e.sh`): a discussion
written under a decision, listed there, and opened with the decision's state and the author's Shares read from the chain,
and a post naming an unknown DAO getting neither. The mocked browser suite is 224 pass, 28 skipped, 0 fail (plus the new
board tests added after that run, which pass).

**Not done, or not verified**
- A template's team, budget, automation, wiki-page and welcome steps still have only run against the mock server: the
  real server (correctly) refused the team step because my test account was not the community owner, and I did not
  grant it that. The screen said so in plain words.
- **The launch's chat rooms overlap with the boards.** A launch already makes a *team* chat (private), a *supporters*
  chat (open) and a *backers* chat (private, gated). With boards there are now two places for supporters and two for the
  team. I left the chat rooms alone; the decision is whether those rooms should become boards, or stay as the live
  counterpart of them.
- "Start a proposal from a thread" is not built: the decision forms are structured (amounts, addresses) and have no place
  for a rationale, so there is nothing for a thread to fill in. A thread is started *after* a decision exists.
- A board reads its newest 200 posts, 1,000 replies and 3,000 votes and says so; no pagination yet. There are no unread
  markers, notifications, pinning or moderation tools for boards in the web app, and the desktop forum does not show
  votes (it never had them), so a vote made on the web is not visible there.
- Pre-existing and not mine: `cargo clippy -D warnings` fails in `crates/buzz-skillopt` (two lints), which will stop
  `just ci` and the pre-push hook until it is fixed.

### Proposal threads without votes, and decision links with live cards (2026-10-10)

Where proposals live: on the chain, in the DAO's voting contract. The app reads them (Decisions tab, the DAO front page,
and now board threads); no server record is a copy of one, so there was nothing to link or embed. Changes:

- **Proposal posts are not ranked by votes.** A post that names a decision has no vote arrows (a vote on a board is not
  the DAO's vote and would read as support); in the list it shows a "Proposal" badge and where the decision stands
  ("Collecting support", "Ready to run", "Done"), read from the chain. The "Proposals" view is ordered like a forum: decisions
  that can still change first, then latest activity, and its sort buttons are hidden. Under "Top", votes never move a
  proposal. Replies in a thread stay oldest first and can still be voted on.
- **One main discussion per decision.** The first thread started about a decision is its main discussion; the Decisions
  tab lists it first with the others alongside ("Start another thread" once one exists), and a thread says whether it is
  the main one or links to it.
- **A decision has an address.** `/launchpad/<launch>?author=…&tab=decisions&decision=<id>` opens the project's
  Decisions tab with that decision outlined and scrolled into view; every decision has a "Copy link" button. The link
  names a launch and a decision id and never a DAO address: the DAO comes from the launch record the app already knows,
  so a link cannot point the app at a contract of its writer's choosing.
- **A link becomes a live card.** Under any chat message, board post or reply, or social post that contains such a link
  there is a small card: where the decision stands, what it would do, who backs it, and "Open the decision". Everything is
  read from the chain. A link to a launch the app does not know, or one with no DAO, is left as a plain link.

Checked: unit tests for the link format (rejects other sites and malformed ids, never reads a DAO), the ordering, the
status logic; the mocked browser suite; and on a real local chain (`scripts/web-discussion-e2e.sh`, now three tests): the
state pill in the list, no arrows, "Copy link" giving the exact address, a chat message turning into a card with the
chain's state and title, an unknown project's link staying a link, and the card opening the highlighted decision.

Not done: wiki pages do not show the cards (the editor needs its own node type); the public page and link preview for
other platforms, an embeddable card and an announcement note for other Nostr clients (the app is a single-page app, so
a preview needs the server to answer with page metadata: that is hosting work); a sentiment poll inside a thread.
