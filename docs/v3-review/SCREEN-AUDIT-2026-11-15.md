# Screen audit, 2026-11-15

The new surfaces of the project loop (Start in one press, a project's first week, the weekly update and its record, help and
tasks with a finish line, Work, Home on a quiet server, Discover's scoreboard, the public scorecard) opened as the people who
use them, at desktop (1280) and phone (390) width, on a real server with records behind them, and read for words and layout.
Method and standard as in [SCREEN-AUDIT-2026-10-24.md](SCREEN-AUDIT-2026-10-24.md): plain words for a reader new to crypto,
no price or returns outside the Home feed, nothing that reads as guilt, no "earn" next to Shares.

## How it was done

`WEB_FEATURES=mvp SKIP_BUILD=1 scripts/web-screen-audit.sh` builds the world on the hosted (contributor-only) build, then
photographs it. What is new since 2026-10-24:

- **The weekly loop's world** (`audit-world.spec.ts`, "the weekly loop's world", through the pages: Start, Post update, I can
  help, Make the task, Hand in, Confirm; the people are in `audit-people.mjs`):
  - Ines's *Street Library Map*, started twelve days ago (her project record names its first day; the app has no way to
    back-date one), with two weekly updates (the second answers the first's three promises: two kept, one missed, "Ran out of
    time"), two help requests, and four tasks, each with a "Done means": Hugo's photographs accepted, Hugo's proofreading in
    progress, and Tess's two pieces handed in (one with a reported number) and waiting for a check;
  - Pia's *Dye Garden*, a project that has just been started and has posted nothing;
  - Ravi's *Reply Helper*, started with the "AI agent or tool" chip;
  - a second, **invite-only server** (its own scratch database, started by the script) for the stop of a signed-out visitor who
    opens a project's link on a server like the pilot's.
- **30 new stops** (`j01` to `j52`), each at both widths, with dark for six. Stops that make something (Start pressed, an update
  posted, a check confirmed) are last, so what they add is not on the screens before them.
- **The pictures are the whole page.** The app scrolls inside its own panes, so the old "full page" picture was only the
  window. The window is now made as tall as the longest pane (up to 5,000 px) for the picture. A dialog is photographed in its
  own window.
- **People who "signed up" have agreed to the terms.** The audit's browsers are made from a bare key; since the terms-again
  dialog was added, every stop was covered by "Please agree to the terms" (the world could not even be built). Each browser now
  holds the agreement a real sign-up leaves.
- **The index says when the accessibility scan could not run** (`accessibilityScanFailed`), so "no findings" cannot mean "not
  looked at".
- `ONLY=^j` picks stops by prefix (several, split by commas); the capture waits out "Looking for open work…" as it did
  "Reading …".

## Numbers

| | |
|---|---|
| Stops in the full capture (mvp build) | 137 captured and 10 checked without a picture (hosted absences and redirects) |
| Screenshots, full run | 285 (22 of them dark) |
| Words on those screenshots | 100,355 (the 29 weekly-loop stops: 24,319) |
| Stops that could not reach their state, full run | 3, all in the harness: `b01-signup` and `b02-signup-name` on a phone (the button they pressed is gone from the welcome; see finding 1), `e07-community-setup` (the hosted build does not offer it; now checked as absent) |
| Equal pictures with no reason | 3 pairs (Discover opened as the loop's `j06` and as `a15`; the decision composer opened and its first kind chosen; `e07` and `e08`), each now declared |
| Sideways scroll | none, at 390 px |
| Accessibility scan | no serious or critical finding in the full run. That run had no marker for a scan that failed to run; the scan works (checked against a page with a missing label, low contrast and a missing image text, which it names), and the rerun below records any failure |

Stops touched after the full run (the harness fixes, the sign-up and `e07` stops, `j06`, `g19`, and every `j` stop for the
whole-page pictures and the scan marker) were run again: see "Rerun".

## What each stop shows

Severity: **High** blocks a person or contradicts the direction; **Medium** confuses or hides a way forward; **Low** polish.
"Fixed" names the commit's subject.

### Signed out

| Stop | Good | Wrong |
|---|---|---|
| `j01` project link on an invite-only server | Says it in three short sentences: "You need an invite to open this project", ask the person who sent the link, "Already on this server? Sign in." A way forward at both widths. | The header still offers **Sign up** on desktop, which on this server leads to the same refusal (Low). The page shows the same words for a project that does not exist, so it cannot be told apart: that is the point. |
| `j02` scorecard, light and dark | Goal, "2 of 3" kept, one **Missed** with its reason ("Ran out of time"), last update with what was said last time, the team, a share picture that says only what the record says ("2 of 3 promises kept"), no price and no "earn". Dark is clean. | The update text is plain lines: its parts ("What happened this week", "What's next") are not set apart and the list items keep their "- " (Low). **Post to Home** is offered to a signed-out visitor (Low, it leads to sign-up). "Weekly updates: 1 week so far" for a 12-day-old project whose two updates are the same day: true, and the world's limit (see "Limits"). |
| `j03` scorecard of a project with nothing yet | "No run yet", "None answered yet", "No promise has been answered yet. Each weekly update says what is next, and the one after says what came of it.", "No update yet." No guilt wording. | The share picture is offered for an empty record (read from the words only; Low). |
| `j04`, `j05` Work, signed out | One request, its size, "asked 1 minute ago", **I can do this**; the "Open to agents" note says an agent can offer on any request. The empty filter says "No AI project is asking for help right now. Follow a project and you'll see when it asks." | The sizes (Small, Medium, Large) are never said in words (Low). |
| `j06`, `j07`, `j08` Discover | Opens on **Most reliable**, with its rule in one sentence; the AI chip narrows the cards to Reply Helper ("1 shown"); **Looking for help** lists the one project with open requests. Cards are one line each with promises kept. No money anywhere. | **View launch** on a card for a project with nothing to launch (Medium, fixed). "1 project · 3 ideas": the loop's three Quick Start projects are counted as ideas and sit under **Ideas**, while only the contributor project is a "project" (Medium, owner decision 3). "CONTRIBUTOR PROJECT", "DAO", "Set up the standard way" on the Creaton card are the second pilot's words (Low). |

### A new account on Start

| Stop | Good | Wrong |
|---|---|---|
| `j10` Start | "Say what you are aiming for. You can start alone, in about a minute." Labelled fields, three example chips, the kind chips. | "Three answers make a public project page" while Home's welcome says "Four answers and it's live" (Low, owner decision 2). "Free to start. No token needed." mentions a token nobody had mentioned (Low, owner decision 7). |
| `j11` AI chip | Says "An agent can do work for your project, but a named person answers for it", offers four kinds, with goal ideas and numbers to aim for. | A lot of text for an optional chip (Low). |
| `j12`, `j50` before and after pressing Start | After Start the page is the founder's, with "Your project is live", a link, a recovery-key prompt for a key-only account. | Layout on a phone, see `j34`. |

### Home

| Stop | Good | Wrong |
|---|---|---|
| `j20`, `j22` Home as a helper, the Updates tab | The strips read true: "Update day. 3 projects have posted, none are due." (a count, no names), **Just started** with a Follow each, **This week on Creaton** ("4 updates posted, 2 promises kept, 1 promise missed, 1 piece of work accepted, 3 new projects"), cards for accepted work and help wanted that know "You offered to help today" and "The team made a task from your offer, and you said yes." No price, no returns. | A signed-in person lands on **Everyone** (the social timeline), so none of this is there until they open **Updates** (owner decision 1). |
| `j21` Home as a new account | One welcome with three ways in: Start a project, Find work, Just follow some projects, with "Not now". | The same Everyone timeline under it. |
| `a01` Home, signed out (full run) | "Real projects, built in the open." Start a project, Find work. Update day, the week in review. The Updates tab is the visitor's landing, as intended. | On a phone: "Create your account to follow the ones you care about" had nothing to press, and the welcome's own button is gone (High for a visitor on a phone, fixed, finding 1). **See a record** appeared nowhere in this world: it needs the server's own example project, which here is the contributor one. |

### A founder

| Stop | Good | Wrong |
|---|---|---|
| `j30` Ines's project page, light and dark | Goal and "How we'll know", last update with its answers, the help request with who offered and what became of each offer, tasks with "Done means", **Promises and goals**: "3 pieces of work accepted", "2 kept, 1 missed, 0 changed", each line with its date; the miss stays with its reason. | **Not listed yet** as the button under "Listed. Anyone on this server can find this project…" (Medium, fixed). The back link said **Launchpad** (Medium, fixed). The Tasks and Promises intros are dense: "A project's team can change: steps count by who is on the team now" (Medium, owner decision 6). Two requests for help each appear twice on the page (in the update, and under "Help still wanted") (Low). Dates are `11/15/2026` here and `Nov 15` on Work and `Due Jan 15, 2099` on Work but `Due 1/15/2099` here (Low). "No supporters yet" beside **Follow**: two words for one idea (Low). |
| `j31`, `j32` update dialog | The dialog opens on last week's promises, each with Done / Not done / Changed, then **Draft from the record**, the accepted work since the last update with **Leave out**, the three promise lines, "Write freely instead". "Add a title to publish." says what is missing. Without an AI service, **Draft from the record** says "The AI service didn't answer. Write it yourself, or try again later." | The note beside **Draft from the record** was squeezed to a column of a few words on a phone (Medium, fixed). **Changed** is never explained (Low). |
| `j33` Your projects | Last update, promises, open requests, and "Needs you now: Work is waiting for your check in…" with **Check the work**. | "Project Shares you hold … a wallet: an app that holds your money and proves it is you" on a server with no money (Medium, owner decision 4). |
| `j34`, `j35` fresh from Start | "Your project is live", the link, a calendar reminder, "Ask three people to follow"; **First week** with four steps, one ticked; **Set up more** opens Tasks, Team and Promises with what to do next, each empty card saying how to fill it. | The first update's due date was said twice (Medium, fixed). On a phone the link box was shrunk to about 70 px beside three buttons (Medium, fixed). The card **Next steps → Set up Shares for people who help** offers a second-pilot path on the first day (owner decision 5). The page is long before its tabs: welcome, listing, goal, first week, next steps, chat (Low). |
| `j51` update posted | "Update posted. That's week one. Post again next week and your run begins." **Share your record**, **Done**, reminder. | On Ravi's AI project a card prints `buzz launchpad updates facts reply-helper …` commands in the page (Low, owner decision 8). |

### A helper

| Stop | Good | Wrong |
|---|---|---|
| `j40` Work | "Waiting on you", "Your work" as four steps (Offered, Said yes, Handed in, Checked) with dates, then Open work. The stop now waits out "Looking for open work…". | The helper's own yes was called **Accepted**, next to **Work accepted**, which is the team taking the work (Medium, fixed: **Said yes**). |
| `j41`, `j42` a task, and a hand-in with reported numbers | "Done means" shown before anything starts; "What you hand in is public"; the numbers form says "Everyone sees it as reported by you, not run by anyone else". A checker's page shows the numbers as "Reported by the helper, not run by anyone else". | The line under them read "Meets the stated threshold: not stated" (Medium, fixed: "“Done means” has no number to compare with."). |
| `j43` accepted work | "Done by Hugo Lang. Checked by Ines Ortiz. Done meant: …" with the link. | none |
| `j44` a helper's profile, Record tab | "1 piece of work accepted, on 1 project, confirmed by 1 person", with who confirmed. | "Nobody is scored or ranked" sits under a header that says **Score 0** (owner decision 4). The paragraph is long and says "signed records" (Low). |
| `j52` accepted share | "You accepted this work … Share it as a picture", **Not now**. | none |

### The rest of the capture (a to i)

Read for what the loop changed (Start, the project page, Discover). The contributor project (*Creaton*, built through the
contributor form) still has **no goal**, and its page says "This project has not set a goal yet." beside "Updated today": the
contributor form does not ask for one (second pilot, owner decision 9). Everything else in a to i is as the 2026-10-24 audit
left it, apart from what the harness had to change: the sign-up stops, the "Set up community" stop (not offered in the hosted
build) and the three declared look-alikes.

## What was fixed

| # | Finding | Severity | Fix |
|---|---|---|---|
| 1 | On a phone a signed-out visitor was told "Create your account to follow the ones you care about" with no button (the bar has Sign in only, the welcome's button is gone) | Medium | **Create your account** under that sentence on a phone; test: phone shows it and it opens the sign-up, a wide screen hides it (fails without the button and without `sm:hidden`) |
| 2 | A project's back link said **Launchpad** (leads to Discover, called Projects in the bar); contributor projects said "Discover" | Medium | **Projects** where no sale is offered; hosted-build check in the screen audit (fails when the link says Launchpad) and a node test |
| 3 | A project card said **View launch** | Medium | **Open project** where no sale is offered; same checks |
| 4 | The founder's button read **Not listed yet** under "Listed." | Medium | **Take it off the lists**; mocked spec asserts it (fails with the old word) |
| 5 | The welcome card's link was squeezed to about 70 px on a phone | Medium | minimum width; spec measures it at 390 px (fails without it) |
| 6 | **Draft from the record**'s note was a few words wide on a phone | Medium | minimum width; spec measures it (fails without it) |
| 7 | "Your first update is due in 7 days." twice on a new project's page | Low | the first-week card says it only when the welcome card is not on the page; node test and spec (both fail without the rule) |
| 8 | "Meets the stated threshold: not stated" | Medium | "Meets the number in “Done means”: yes/no", or "“Done means” has no number to compare with."; node test and mocked spec |
| 9 | Work: the helper's own yes was **Accepted** | Medium | **Said yes**; node test (fails with the old word) |

Each test was shown to fail against the broken code and to pass against the fix (listed in the report that came with this
audit). Not fixed, on purpose: anything below.

## For you (owner decisions)

1. **Where a signed-in person lands on Home.** Everyone (the social timeline) for someone signed in, the project records for a
   visitor (`routes/index.tsx` says this on purpose). The direction makes Home the feed of project records, and Just started,
   Update day and This week are all under Updates. A helper or founder opens Home and sees none of it.
2. **"Three answers" or "four".** Start says "Three answers make a public project page"; Home's welcome says "Four answers and
   it's live"; the direction says four. The form asks name, goal and how we'll know, with an optional one-liner.
3. **What is a project and what is an idea in Discover.** The Projects/Ideas filter counts the loop's Quick Start projects as
   ideas ("1 project · 3 ideas") and the contributor project as the one project.
4. **Money cards on a server with no money.** Portfolio ("Project Shares you hold … a wallet"), the profile's "Payment wallet:
   No verified payment wallet has been shared." and **Score 0** next to "Nobody is scored or ranked".
5. **Next steps → Set up Shares** on a project's first day, the second pilot's path.
6. **The long sentences about a changing team** on the Tasks and Promises cards and the profile's track record ("steps count by
   who is on the team now", "signed records"). They came from the outside review; shortening them is yours and counsel's.
7. **"Free to start. No token needed."** on Start.
8. **The command text** (`buzz launchpad updates facts …`) printed on an AI project's page.
9. **The contributor form has no goal**, so the server's own example project reads "This project has not set a goal yet."
10. **The weekly update's layout**: its parts and "- " lists are plain lines on the scorecard and the project page. A design
    task, not a copy one.
11. **Date style and one word for followers.** `11/15/2026`, `Nov 15` and `Jan 15, 2099` beside each other; "supporters" next to
    **Follow**.

## Limits of this audit

- **Every record in the world is dated today** (the app posts at the time of posting and the world is built in minutes), so no
  project has a run of weeks: **Most reliable** is exercised but never ranks by a run, and "weeks in a row" never appears. Only
  the project's start is back-dated.
- **No AI service** is on in the world, so the AI features are photographed as an owner without one sees them.
- **The words and pictures can differ at load time**: a byline can read "By Someone" for a moment before the name arrives (an
  eight-second wait read "By Ines Ortiz"); a capture is taken after the page's own waiting, so some pictures hold that moment.
- **The invite-only stop is the same for any link**, as it should be; it was not tried with a signed-in member of that server.
- **Dark** was captured for six of the new stops and the older ones; read in full only for the scorecard.
- **By hand, not done**: no keyboard walk of the new dialogs and no screen reader; only the automatic scan.
- Not run: the pilot gate (`mvp-gate.sh`), the other real-server journeys, the desktop and mobile apps.

## Rerun

`ONLY='^j,b01,b02,e07,e08,a15,g18,g19'` on a fresh world, with the fixed code: 37 stops passed (75 pictures), none failed, the
equal-picture check passed, no accessibility finding, no scan that failed to run, no sideways scroll. The sign-up stops
reach their dialog on a phone, `e07` is checked as absent in the hosted build, and the welcome card's link is a readable width
at 390 px. The rest of a to i was not photographed again after the fixes (nothing in them changed).
