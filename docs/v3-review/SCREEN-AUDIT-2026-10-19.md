# Screen audit, 2026-10-19

A pass over the screens a newcomer meets, looking for too much text, two words for one thing, things that cannot be
reached, and empty states that say nothing useful. It is a record of what was looked at and what was done, not a rulebook.

## What was looked at, and how

- The guided tour (`E2E_TOUR=<dir> pnpm exec playwright test --project=smoke tour.spec.ts`): the eight top-level pages at
  1280 and 390 wide, the sale wizard, "start an organization", an idea's page and a raising project as a backer sees it. These
  run on mocked data, so they show real layouts but not a busy server.
- The running app (signed in, empty server): Home, Discover, Launchpad, Start, Portfolio, Markets, community setup.
- Word counts for the top-level pages on an empty server: Discover 83, Launchpad 108, Portfolio 182, Start 201, Markets 56.
  None of those is long. The weight is in the pages that have data: the sale page, the idea page, the DAO page.

**Not looked at** (they need real data or more time): the launch page's Treasury, Decisions and Work tabs with live records, the
DAO overview, Markets with prices, repositories, the wiki editor, agent and fleet screens, the notifications panel, settings.

## Fixed tonight (each is a commit with a test)

| Screen | Problem | What changed |
|---|---|---|
| Community setup | A long list of everything a team adds, five teams to choose between, three paragraphs of explanation | Two plain cards (Creative, Technical), the rest under "More kinds of team", everything a team adds behind one line |
| Start page, empty community | Still said "ready-made team" | Says "a creative or a technical project" |
| Launchpad, nothing launched | Eleven filter chips all reading zero above "No launches yet" | Chips appear once there is something to filter |
| Discover on a phone | "Pitch a project" was cut off at the right edge (every page header with several buttons could do this) | The button row wraps inside the page; a phone test measures all four buttons |
| Home | Two search boxes on one screen (top bar and right rail) | One, in the top bar |
| Chat on a phone | Reply, Report and Delete only appeared on hover, which a touch screen cannot do | Always shown on touch, and they wrap instead of overflowing |
| Messages | No way to report or mute the person writing to you; a muted person's conversation stayed in the inbox | Report and Mute in the conversation, Report on profiles, muted conversations leave the inbox |
| Post box | The first key typed after choosing a mention landed at the end of the text | Fixed, with a test that fails without the fix |
| Idea and project pages | "Team-signed task records", "approval and payment not implied", "a bounded selection of linked work" | Plain sentences |
| Project board | "Ownership grant (revocable until the project's DAO adopts it…)" | "Your share is recorded. It is not a legal contract, and it can be undone until the project's DAO takes it on." |
| Top bar | Nothing said this was a test version | A small "Testnet" tag beside the logo (it goes away when a build enables mainnet) |

## Found and not changed, with a recommendation

1. **Three names for the same place.** The top bar says Workspaces; the page says Communities; setup, invites and the people
   list say community. The top bar says Discover; the page behind its Launches button says Launchpad. Recommendation: pick
   one word for each (I would use Community and Discover) and change the labels together. It touches many tests, so it is a
   decision for you, not a drive-by.
2. **The "What can and cannot be changed" card on the sale page is the longest block a backer meets.** It is long on purpose:
   reviewers asked that everything a vote can and cannot do is said before a bid. Recommendation: keep the guarantees
   ("No vote can undo…") and the list of what holders can change visible, and fold the mechanics of the objection window
   (days, thresholds, bond) behind "How objections work". That needs your yes because it moves honesty text.
3. **An idea's page has four explanatory cards before its content** ("Your idea is live", "This is an idea", "Building
   together", "Latest project progress"). For a founder with no work yet, "Building together" is an empty card that repeats the pitch.
   Recommendation: show it only once there is linked work or a milestone.
4. **A first visitor sees an empty server.** Discover, Launchpad and the project board all say "nothing yet". The fix is a
   real first project: `CREATON-EXAMPLE-PROJECT.md` has the text for Creaton itself, to publish from your account.
5. **Portfolio on a new account** repeats "connect your wallet" three times, in three cards. One note at the top would do.
6. **Home's right rail is empty** on a server with no launches and few people, which is where the pilot starts.
   Recommendation: leave it; it fills as people arrive.

## How to repeat this

```bash
. ./bin/activate-hermit
pnpm --dir web build
E2E_TOUR=/tmp/tour pnpm --dir web exec playwright test --project=smoke tour.spec.ts
```

Then open the PNGs in `/tmp/tour`. `page-*` are 1280 wide and `phone-*` are 390 wide.
