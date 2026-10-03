# Web app MVP audit — what is there, what is CLI-only, what to build next

Written against `claude/org-graph-social` (off `feat/org-graph`), using the real
app against a seeded relay (`web/tests/e2e-real/seed-demo.mjs`). The product
contract is [dao-os.md](dao-os.md); this file is about whether the **web client**
lets a person walk that loop without a terminal or the desktop app.

## The loop a person must be able to finish in the browser

1. **Arrive** and understand what this is.
2. **Sign up** (passkey), get a name and a face.
3. **Discover** launches, projects and people.
4. **Back** a launch, follow it, talk about it.
5. **Start** something: pitch a project, publish a launch with a real split.
6. **Run** it: updates, a work board, proposals, treasury.

## What changed in this pass

| Area | Before | Now |
| --- | --- | --- |
| Look | Buzz's olive/navy wash, left icon rail, Inter | Creaton violet-black palette, mint action, Figtree, top bar with search |
| Token split ("equity") | Six inputs in a 3-column grid inside a hidden *Advanced* drawer; hints of different lengths pushed rows out of line; no total | One aligned list on the first wizard step: colour bar, % input per row, token count per row, running total; a split that does not add up blocks *Continue* where it is fixed |
| Launch identity | No cover, no topic; pitch only reachable inside *Advanced* (so wizard launches often published with none) | Pitch, cover (upload or link) and category on step one; one `LaunchCard` everywhere |
| Launch page | A page title over spec tables | Cover, founder, pitch, target / share for sale / raised, then the tables |
| Home | A feed with an empty "trending" rail | Welcome (visitors) or a verifiable getting-started checklist (new accounts) |
| Discover | Mixed list cards | Launch cards in a grid, live launches first, empty DAO section last |

## Starting a launch: idea first, sale later

A launch is a progression where each step earns the next one, and money comes last.

| Step | What the founder does | Commitment |
| --- | --- | --- |
| Idea | *Start an idea*: name, one sentence, optional cover. About a minute. | None. Publishes a public page and creates the team and supporters rooms. |
| Gather | Post updates; supporters click *I'd back this* (free: it follows the launch and joins the supporters room). | None. |
| Prepare the sale | Token, split, price (the wizard), nudged at 10 supporters; can be skipped. | Terms, still editable. Creates the gated backers room. |
| Sale | Mint, deploy, open. | Real money. |

An idea is the same launch record with every economic field empty (`isIdea`);
preparing the sale republishes the same record id with the terms set.

### Preparing the sale: two choices

From an idea, *Prepare the sale* opens a quick setup: how much to raise and how
long it runs. Everything else is defaulted and listed (standard supply split,
product-project milestone unlocks, DAO if the target is met, no monthly budget);
*Customize the details* opens the full steps with the same values, and *Quick
setup* comes back. The direct *Set up a sale* button keeps the full steps.

### The founder's path

The founder always has a next step on the launch page: the idea checklist
(announce it, gather supporters, prepare the sale), then once the sale is
prepared a second checklist (deploy, open the sale, tell supporters) derived from
the record (`lib/sale-steps.ts`). An idea's page hides the money tabs and says
what happens next. *Notifications* has a "Your launches" section: new supporters
since the founder last looked, and backers waiting for the backers room. The
Launchpad has an *Ideas* filter. The announcement step opens the feed composer
pre-filled and tagged to the launch.

### What the Anvil journey test found and fixed

`web/tests/e2e-real/journey.spec.ts` drives idea → quick sale setup →
commitments → link token → deploy → go live → a backer bids → the founder admits
them, on a real relay and a real chain
(`E2E_SPEC=tests/e2e-real/journey.spec.ts E2E_CONFIG=playwright.local-chromium.config.ts scripts/web-auction-e2e.sh`).
Writing it exposed seams the mocked specs hid:

- A quick-setup sale could never go live: going live needs a long story, an update
  cadence and a monthly budget, which the quick setup does not ask. The founder's
  checklist now has a *Make your commitments* step with a small inline form, and a
  *Go live* button.
- The deploy panel was disabled by a missing treasury with no way forward. It now
  offers the connected wallet as the treasury in one click, and the treasury box on
  the token-link panel is no longer ignored.
- Two saves of a launch in the same second could tie, and the relay may keep the
  older one. Records are now stamped one second past the one they replace.
- The create dialog defaulted to Sepolia even when the build targets another chain;
  it now follows the configured default chain (`VITE_LAUNCHPAD_CHAIN_ID`, local
  Anvil in dev builds).
- Sending a bid and recording it were two clicks, and only a recorded bid opens the
  backers room. Sending now records the bid; the manual button stays as a retry.

### Rooms

| Room | Who | How they get in |
| --- | --- | --- |
| Team | The people building it | Private; the founder adds them |
| Supporters | Anyone excited about the project | **Open**: one click (kind 9021), no money |
| Backers | People who recorded a bid | **Private and gated**: the founder admits each one with one click (kind 9000), created when the sale is prepared |

The record names them in `content.chat` (`{team, supporters, backers}`, only rooms
that exist) and in `buzz-channel` tags. Supporter counts read people's bookmark
lists (no extra write to forge). Rooms are server-managed encryption: the operator
can read them (TEE or Marmot hardening is a later decision).

## CLI-only or desktop-only today (web has no path)

Checked by running `buzz --help` for every command group and searching the web
client for the matching action.

| CLI group | Web | Verdict |
| --- | --- | --- |
| `launchpad` list/show/curate/delete/update/bid/vote/propose/process | ✅ all present | Fine. (`mint-token` shells out to Foundry, dev-only on purpose.) |
| `royalty show/claim/settle` | ✅ `RoyaltyStatementCard` | Fine. `publish-*`/`watch` are operator tools; stay CLI. |
| `trustgraph` | ✅ curator panel | Fine. |
| `projects` (NIP-MP create/update/add-repo) | ⚠️ web "projects" are NIP-37015 pitches, a different record | Decide whether multi-repo projects belong in the web at all. |
| `templates list/show/apply` | ❌ | **Gap.** "A founder applies a project template" is step 1 of the product loop and is terminal-only. |
| `issues`, `pr`, `patches` (NIP-34) | ❌ repos are read-only; the empty state says "open in the desktop app" | **Gap** for any code-hosting story. |
| `repos create/protect/bind/default-branch` | ❌ | Gap, same story. |
| `workflows create/update/trigger/approve` | ⚠️ runs panel only | Approvals are the "peak moment" of the loop (see the 2026-09-22 audit). |
| `org node/grant/budget/contribution` | ⚠️ org chart + budget form + portfolio share; no contribution review or grant editing | Partial. |
| `channels` admin (members, add-policy, archive) | ⚠️ create + read | Partial. |
| `moderation` | ❌ | Needed before anyone but the team uses a public relay. |
| invites / join policy | ⚠️ redeem only; creating an invite is not in the CLI either | Gap in both. |
| `canvas`, `gifs`, `emoji`, `mem`, `agwiki`, `pack`, `diag`, `team` | not applicable to a browser MVP | Leave. |

## MVP gaps, in the order I would close them

1. **Start from a template (web).** One button on *Pitch a project* that applies a
   template (channels, agents, wiki, org seat, default budget). Highest value:
   it is the front door of the loop. Needs the template manifests served or
   embedded for the browser and a publish sequence mirroring
   `crates/buzz-cli/src/commands/templates`.
2. **Approvals and workflow control in the browser.** The approve/deny buttons
   exist in the desktop; the web shows runs read-only.
3. **A way in.** Invites: create a link (owner), set join policy, see pending
   requests. Today a second person cannot join a community without a terminal.
4. **Backing a launch needs a chain.** Every card shows "no chain data" without an
   RPC. The sandbox is the only keyless path. For an MVP demo, either ship the
   sandbox as the default "Try it" on Home, or provide a public testnet RPC
   default so progress and bids are real.
5. **Moderation** (report, mute-in-community, remove) for any relay that is not
   private.
6. **Code collaboration** (issues, PRs) only if code hosting is part of the MVP;
   otherwise hide *Communities → repos* behind the desktop note instead of an
   empty page.
7. **Two feeds.** *Home* (launch discussion, vote-ranked) and *Social*
   (Twitter-style) both list kind-1 posts. Pick one story: Home = "about
   launches", Social = "everything", and say so in the page copy.

## Smaller details found while looking

- The logo is still Buzz's bee in a few places (favicon, `/c` empty state). The
  new top-bar mark is a stand-in drawn in SVG (`shared/ui/CreatonMark.tsx`)
  because the Figma asset could not be exported from this environment.
- Launch cards read "No chain data" when there is no RPC; cards now say nothing
  instead, the launch page keeps the honest line.
- `Overview` on the launch page is still a wall of tables. A "Details" fold for
  *Proven commitments / Track record / Contracts* would help backers.
- The wizard form controls use hard-coded `black/white` opacity classes in many
  places; they read fine on the new palette but should move to tokens over time.
- Pre-existing test failures on `feat/org-graph` (unrelated, fail identically
  without this branch): 11 smoke specs (wiki, a11y, a Safari download test,
  public-relay mirror) and 3 real-relay specs.
