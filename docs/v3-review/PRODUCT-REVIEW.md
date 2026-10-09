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

## What would help next

In this order: (1) your call on the six items above; (2) a "Set up a work budget" shortcut on the DAO's front page when it
has none, so the first thing a new DAO shows is one button, not an empty list; (3) the audit-log page, since every
change to an org is already signed and chained; (4) forms for the rarer DAO powers still on the command line.
