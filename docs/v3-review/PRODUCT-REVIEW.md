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

- 13 browser tests fail on the commit before this work too (nine wiki and multi-user tests, three in `smoke.spec.ts`, one
  in `feed.spec.ts`). They are not caused by anything here; they need their own look.
- `web/src/features/wiki/ui/WikiView.tsx` is 1,040 lines and the file-size gate allows 1,000.

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
the desktop typecheck, `cargo fmt`, the whole Rust workspace with `cargo check --all-targets` (no warnings left), 744
CLI tests, the Paperclip, agwiki and provider tests, and the mocked browser suite: 180 pass, 26 are skipped (they need
a local chain), and the same 13 fail that failed before this work started.

## What would help next

In this order: (1) your call on the six items above; (2) a "Set up a work budget" shortcut on the DAO's front page when it
has none, so the first thing a new DAO shows is one button, not an empty list; (3) the audit-log page, since every
change to an org is already signed and chained; (4) forms for the rarer DAO powers still on the command line.
