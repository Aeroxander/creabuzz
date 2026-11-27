# Try it: your own test world, on a phone and a laptop

This is the one guide for trying the new join-and-leave app yourself. Everything runs on your computer with play dollars: nothing
here is real money, and nothing leaves your network. Where a step could not be tried by anyone yet, it says
**not tried by anyone yet**. Words in double quotes are the app's own words, copied from the screen; if your screen says
something else, that is a finding: write down the step and what the screen said.

Time: the ten-minute look takes ten minutes. The full test takes about an hour and a half. Part 1 is done once.

## 1. Install once

You need a Mac or a Linux computer. Do these in a terminal, in this repository's folder.

| What | Why | How |
|---|---|---|
| Node and pnpm | the app | `. ./bin/activate-hermit` (each new terminal), then `pnpm install` once |
| The libraries in the repository | the contracts | `git submodule update --init --recursive` once |
| Foundry (`anvil`, `cast`, `forge`) | the local chain | `curl -L https://foundry.paradigm.xyz \| bash`, then `foundryup` |
| `psql`, `redis-cli`, `jq`, `openssl`, `python3`, `curl` | the script's tools | Mac: `brew install libpq redis jq openssl python curl` then `brew link --force libpq`; Ubuntu: `sudo apt install postgresql-client redis-tools jq openssl python3 curl` |
| A Postgres and a Redis | the server | `docker compose up -d postgres redis` gives exactly what the script expects (any Postgres and Redis you run work too: set `POSTGRES_ADMIN_URL` and `REDIS_URL`) |
| The contracts, built | the chain | `scripts/ensure-solc.sh 0.8.37`, then `forge build` in `contracts/pot` |
| The server and the `buzz` command | the server, and the season command | `cargo build -p buzz-relay -p buzz-cli` once (the script never builds) |

(Only the full run, `scripts/pot-full-loop.sh` with no argument, also needs Playwright's Chromium: `pnpm exec playwright install
chromium` in `app/`.) The script checks all of this first and says in one sentence what is missing and how to get it. On a Mac it needs neither `timeout`
nor `hostname -I`.

## 2. Start your world

```
. ./bin/activate-hermit
SERVE_HOST=<this computer's address> scripts/pot-full-loop.sh --serve
```

It takes about two minutes, then prints the app's address, the chain's address and the steps. **Leave the window open**; Ctrl-C
stops everything and removes it. Use a network you trust: the chain's accounts are public.

To start a season with a key of your own, put it in the environment first (`OPERATOR_KEY=<64 hex characters>`): the server's operator
is then that key's account, and the key is read from the environment, never written to a file and never printed. Without one the
script makes up a key for this world and prints the whole season command (step 4.3).

Which address to give `SERVE_HOST` depends on where you will open the app:

- **A laptop browser with a wallet extension (the easiest way, nothing else needed):** `SERVE_HOST=localhost`. The page is
  "secure" on this computer, so everything works except what needs a real certificate (part 5).
- **A phone on your home network:** `SERVE_HOST=` your computer's address on that network (Mac: `ipconfig getifaddr en0`, or System
  Settings, Wi-Fi, Details; Linux: `hostname -I`). The script finds it itself when it can and asks for it when it cannot.
- **An Android phone on a cable:** `SERVE_HOST=localhost`, then `adb reverse tcp:<app port> tcp:<app port>` and the same for the
  chain's port, and open `http://localhost:<app port>` on the phone. **Not tried by anyone yet.**

**On a home network the page is plain `http`.** I opened it that way here and the browser says so: a passkey cannot exist there, the
Copy press cannot copy, alerts cannot be turned on, and a phone wallet may refuse a chain address that is not `https`. What you see:
sign-up says "The passkey did not work in this browser. Try again, or create without a passkey." and its press is "Create without a
passkey"; the Share sheet's "Copy link" says "Your browser would not copy it. Select the link above and copy it." If your phone's wallet
will not take the chain address, use a wallet that allows it, or the Android cable above, or use the laptop with its extension and
keep the phone as a visitor (it needs no wallet to look).

### The wallet

Add the network the script prints: name `Local test network`, the chain address, chain id 31337, symbol ETH. A wallet that has not
heard of it is offered it by the app (see step 3.2). Then import accounts from anvil's public development accounts. **They count from
0.** Use **2, 3, 6, 8, 9**; do **not** use 0, 1, 4, 5 or 7 (the contracts, the demo project's first backer and worker, and the server's
helper use them). The key of account 2 is printed by

```
cast wallet private-key --mnemonic "test test test test test test test test test test test junk" --mnemonic-index 2
```

(change the last number for another account). These keys are public and worth nothing: never import a real account's key anywhere
near this.

**People.** In the full test each person is a browser profile with its own wallet account (a Chrome profile each; a private window
works if your wallet extension is allowed in it):

| Person | Account | Browser | Does |
|---|---|---|---|
| Fay, the founder | 2 | profile 1 | starts and runs the project |
| Abe | 3 | the phone (a fifth profile if the app is on `localhost`) | backs first with no sign-up, then signs up |
| Bea | 6 | profile 2 | backs with the room box ticked, takes out later |
| Cy | 9 | profile 3 | a third backer (only the season needs him) |
| Wes, the worker | 8 | profile 4 | takes the tasks |

Each account can use the faucet once, so a second Back by the same account uses the play dollars it already has.

## 3. The ten-minute look (on the phone, with the demo project "Lantern")

1. Open the printed app address on the phone, in its ordinary browser first. **Working:** the project's name, "Lantern", then "The
   project's money", "This can go up or down. It is not a return.", "This is a test network. The dollars are play money, not real
   money." and "You can take your money out any time. Nothing here promises a profit." A browser with no wallet shows, where the Back
   box would be: "Open this page in a browser with a wallet to back this project."
2. Open the same address in the wallet's own browser. **Working:** "Connect your wallet to back this project." and a press
   "Connect your wallet". Press it and the wallet asks for the account (import account 3 on the phone for Abe). If the wallet is on
   another network the Money tab says "Your wallet is on another network. Switch it to this project's test network to see your
   Shares." and has the press "Switch network"; a wallet that does not know the network is asked to add `Local test network` with the
   chain address and ETH, and you say yes in the wallet.
3. Open the **Money** tab. **Working:** "Your Shares", "Play dollars you hold", "Get play dollars". Press it, then the sheet's
   "Get 1,000 play dollars". The wallet asks once.
4. Type 25 in "How many dollars?" and press "Back". **Working:** a sheet "Back Lantern" with "You pay", "Fee to the platform, part of
   that", "You get" and "Taking out right now would give you", and, because you have no account, "To write in this project's room you
   need an account first. You can back now without one." Press "Back with 25 dollars". The wallet asks once. "You hold" shows about
   2,450 Shares.
5. Press "Take out", then the sheet's button. **Working:** "Take out of Lantern", one wallet question, then "Taken out. The money is
   in your wallet." and "You hold no Shares in this project yet. Back it to get some."
6. Under the project's money read the demo's planned task. **Working:** "A planned task", "The team plans to pay up to 2 dollars to Demo
   worker for “Paint the lamp shades”", "You can take your money out before then. 2 dollars is the most; it can be less if people take
   out first." and "This task cannot be taken unless the team checks in before". Lantern is for looking only: its team is a key nobody
   holds, so nobody can plan, take or pay its tasks (the full test below uses a project of your own).

## 4. The full test, on a project you launch

Name the project **Beacon**. All clock moves below are made from your computer with the chain address the script printed, followed by
two seconds of waiting for the next block. A "week" in this world is a real week.

**Side effects of moving the clock (all expected).** The server's record and the page keep their own clocks, so after a move the
record reads as old: the page says "as of ... This may be out of date: the server has not refreshed this project since." and Back
waits ("The door to new backing is shut right now. Look again in a moment.") until the team checks in again and the server has read the
block (up to a minute). The feed rounds to 100 dollars, so small Backs read "Some amounts were too small to show, so there is no
total." After a move the **This week** card can also say "No check-in yet." and an old "Last check-in" date for a short while after a
check-in (the page's own clock, and the old record). The terms and privacy note this world serves are the operator's drafts with
bracketed items for counsel: that is expected on a test world. Never move the clock when a step does not ask for it.

### 4.1 Launch (Fay, profile 1)

1. Open the app address, then `/welcome`, and sign up (name Fay, the two boxes "I am 18 years of age or older." and "I agree to the
   Terms of use and have read the Privacy note. Posts and votes are public.", then "Create without a passkey" on plain http).
2. Press **Start**. **Working:** "Start a project" and "Three answers. You can change them later, and nothing costs anything." Name it
   Beacon, answer "What will you make?" and "How will people know it worked?", press "Start".
3. On Beacon's page press "Connect your wallet" (account 2). The card headed "Open Beacon to backers" then has the press "Launch".
   **Working:** the sheet "Launch Beacon" with "Daily allowance, percent a day" (0.10) and "Team pool, Team Shares" (10,000,000).
   Press its button "Launch Beacon"; the wallet asks once.
   **Working:** "It is on the network. Tying your page to it now." and then "Your project is open to backers." Until the server has read
   the block the Money tab says "No numbers yet" and shows no figure.

### 4.2 Backers, and the room both ways

The other profiles find Beacon on **Home**, where the new project is listed (or paste the address from Fay's address bar).

1. **Abe, on the phone, signed out:** open Beacon's address, Money tab, connect account 3 (he already has play dollars from part 3: the
   faucet gives them once per account), Back 10. (Two presses are called "Back" on a project's page: the one with the arrow at the top left
   goes to the last page; the one you want sits under "How many dollars?".) **Working:** no box in the sheet, only "To write in this project's room you need an account first. You can back now without one."
2. **Bea, profile 2:** sign up, open Beacon, connect account 6, "Get play dollars", Back 100. In the sheet the box "Let me write in
   this project's room" starts unticked, with "This links your wallet to your account. Anyone on this server can see the link, and so
   can see how many Shares that wallet holds." Tick it and press "Back with 100 dollars". **Working:** the wallet asks twice (the Back,
   then once more to confirm the account is the wallet's); the Room tab then offers "Write to the people who back this" under "Posts
   and votes are public."
3. **Cy, profile 3:** sign up, connect account 9, "Get play dollars", Back 20 (tick or not). Three people now back it.
4. **Abe's one press in the room:** on the phone sign up (name Abe), open Beacon's Room tab. **Working:** "To tell that you back this
   project, the server needs this account confirmed." and the press "Confirm this account backs the project". Press it, sign once in
   the wallet, and "Write to the people who back this" opens. Write "Hello" and press "Post".

### 4.3 Check-in and the season

1. **Fay:** **This week**. **Working:** "Ten minutes a week: say what you did, and check in." Press "Post this week's update and check in",
   write a line, press "Post and check in" and sign once. "Updated today" shows.
2. **Start a season** with the command the script printed under "To start a season" (run it in this folder, in a second terminal). If
   you gave the script an `OPERATOR_KEY` in the environment, the command names `$OPERATOR_KEY` and the key is never printed: set
   `OPERATOR_KEY` again in the second terminal before you run it (`export OPERATOR_KEY=<the same 64 hex characters>`); if not, the
   script made up a key for this world and printed the whole command. **Working:** it prints "Season 1", three dates, and
   `{"accepted":true,...`.
3. **Fay:** Home. **Working:** "Season 1 is open. Projects can enter until demo day on" a date six weeks away, and "Enter Beacon". Press it.
   "Beacon is in." If it says "At least 3 people have to back this project first.", three people do not hold it yet (do this step
   before anyone takes out).

### 4.4 Two tasks, planned with their notice

1. **Fay**, Tasks tab: "Post a task", "What needs doing" `Translate the stall guide`, "It pays (dollars)" 4, "Post". Again:
   `Paint the shop sign`, 3.
2. **Wes, profile 4:** sign up, connect account 8, open Beacon's Tasks tab and press "Take this task" on each. **Working:** each
   reads "Being worked on" and "You have it." and the card offers "Hand in the work".
3. **Fay**, Tasks tab, press "Plan the pay of 4 dollars". **Working:** the sheet "Plan the pay for “Translate the stall guide”" says
   "Nothing moves yet. Holders get notice first.", who is paid ("Pay to", Wes's address), "Up to 4 dollars", the notice ("Holders get 15
   days"), "If nobody takes it within 7 days, it lapses and nothing moves.", "Once taken, it is due 14 days later." and "The last
   check-in counts until" a date. Press "Plan this task"; the wallet asks once. Do the same for the 3 dollars. The notice is two weeks
   plus a little for the size of the task; keep each task under 6% of the project's money so one clock move covers it.
4. **Bea**, Beacon's page: above the tabs **working:** "A planned task", "The team plans to pay up to 4 dollars to Wes for “Translate
   the stall guide”", "You can take your money out before then. 4 dollars is the most; it can be less if people take out first.",
   "4 dollars would be set aside today (a share of the project's money). This can go up or down. It is not a return." and a press
   "Take out before" the date. On **You**: "NEWS ABOUT YOUR PROJECTS" with a row for each plan. Signed out, the same two lines show.
5. **Abe takes out before the notice ends:** Money tab, "Take out", the sheet "Take out of Beacon" ("All of it", "Half", "A quarter"),
   "Take out" with the amount. One wallet question. **Working:** "You hold no Shares in this project yet. Back it to get some." Then
   Abe's Room tab says "You took out" and a date, then "You can write here for 7 days more, then this room is read only for you."

### 4.5 The clock moves: the worker, the allowance, the note

1. Move the clock past the notice (this is a little over 17 days, which covers both plans):
   `cast rpc --rpc-url <the chain address> evm_increaseTime 1500000`, wait two seconds.
2. **Look at what the pages say now (all expected):** the project page says "as of" a December date with "This may be out of date: the
   server has not refreshed this project since." and "The door to new backing is shut right now. Look again in a moment." Abe's room
   still shows the writing box (the page judges the week by its own clock), and a post is answered "Not ready yet. Try again in a
   minute." The room goes read only for someone who took out only after a real week of the page's clock: that cannot be tried by hand.
3. **Fay:** **This week**, "Check in only", sign once. Wait up to a minute for the server to read it.
4. **Wes**, Tasks tab: **working:** "Can be taken now, until" a date, then the press "Set the money aside" on each task. Press it; the
   sheet "Set the money aside for “Translate the stall guide”" says "You are named for this task: 4 dollars at most.", "Set aside now,
   about", and the box "Take it only if the whole 4 dollars is set aside" ("Nothing is taken if less would be set aside."). The wallet
   asks once. **Working:** "Taken, due" a date 14 days away and "4 dollars are set aside for it." Do both tasks. **On the second task, untick the box** "Take it only if the whole 3 dollars is set aside": the first one
   lowered the project's money a little, so the whole 3 dollars is no longer available (the sheet says "about 2.93 dollars today", the
   amount follows from your numbers), and with the box ticked the app answers "The project's money moved, so only 2.93 dollars would
   be set aside, less than the 3 dollars you asked for. Nothing was taken. Look again and press again." every time. Unticked, it
   says "2.93 dollars are set aside for it." (about; yours follows from the project's money). Press "Hand in the
   work" on the first, write what you did under "What you did", and send it.
5. **The allowance draw (Fay):** Money tab, section "The allowance", whose first line says what the team can take a day and how much the box "holds"
   now. Press "Draw from the box". **Working:** the sheet "Draw from the allowance box" with "The box holds about ... now.
   You can draw up to that". Put your own address (account 2) in "Draw to which account?" and an amount clearly under what the sheet says
   the box holds, and under "The box holds at most" on the Money tab (0.5 is safe; money set aside for tasks has just lowered that
   cap), in "How many dollars?". The press then reads "Draw" and the amount (for 0.5, "Draw 0.50 dollars"); press it and sign once:
   "Drawn from the allowance box." If you type more than the box holds, the sheet says "The box holds about ... dollars now. Draw that
   or less." and the "Draw" press stays disabled, so nothing can be sent. The box fills at 0.10% a day of the project's
   money and stops at a cap, so it never holds more than the Money tab says.
6. **Bea takes out while money is set aside:** Money tab, "Take out". **Working:** besides the usual sheet, "Part of the project's money
   is set aside for a task, for up to 14 days. You get ... dollars now, and up to ... dollars more if the task is not paid in full." and
   "Where you claim it". Press the button, sign once. Her Money tab then lists "Money you can claim".
7. **Pay part (Fay):** Tasks tab, on the first task press "Pay for the work". **Working:** the sheet "Pay for the work on “Translate the
   stall guide”": "Pay to", "Set aside", "How much to pay": "Pay all 4 dollars" or "Pay part". Choose "Pay part", write 3 in "Amount to
   pay, in dollars" ("At least 1 dollar and at most 4 dollars."), and read "What is left goes back to the project and to the people
   who took out while it was set aside. 1 dollar goes back." Press "Pay 3 dollars". One wallet question. If the page says "This task was
   paid on the network, but the record on the team's list does not say so yet." press "Save that it was paid" (nothing is paid twice).
8. **Bea claims (exit note):** Money tab, "Money you can claim": "you took out while 4 dollars were set aside for it. The task is
   ended." and the press "Claim" with an amount. Press it. **Working:** the sheet "Claim" with the amount for “Translate the stall guide”, with "Set aside
   when you took out", "Came back from it", "Your part of what came back", then "Claimed. The money is in your wallet." (The press reads "Claim" and an amount: her part of what came back. In one walk it was about 0.50 dollars, in another about
   0.83; yours follows from who still held Shares, so do not expect these figures.)

### 4.6 The task that runs out

Nobody pays the second task ("Paint the shop sign"). Move the clock past its due date (14 days after it was taken):
`cast rpc --rpc-url <the chain address> evm_increaseTime 1300000`, wait two seconds. **Bea's Money tab:** either "This task ran out. You can
claim 1.50 dollars now; claiming returns the money first." with the press "Claim 1.50 dollars", or, if the server's helper has already
returned the money, "The task is ended. You can claim 2.44 dollars now." with "Claim 2.44 dollars" (the amounts are from two walks; yours
follow from who still held Shares, so read them as "about"); press it and sign once. **Fay's Tasks
tab** says "“Paint the shop sign” ran out. Nothing was paid; the money went back." and under "Ended plans" the first one:
"Paid 3 dollars of the 4 dollars set aside; the rest went back." (The server's helper also returns the money by itself about a minute
and a half later, with nobody pressing: the full run, `scripts/pot-full-loop.sh pot-tasks.spec`, proves that.)

### 4.7 Demo day

1. Home reads the season's dates when it opens, so reload it after the next step. Move the season's dates so that demo day is two
   minutes away: the same command as in 4.3, with `--replace --starts "$(python3 -c "import datetime as d;print((d.datetime.now(d.timezone.utc)-d.timedelta(seconds=86400-120)).strftime('%Y-%m-%dT%H:%M:%SZ'))")" --days 1` added after `--number 1`.
2. Wait two minutes and reload Home. **Working:** "Demo day: 1 project shows what it made." and the link "See demo day".
3. Press it. **Working:** "Season 1", "PROJECTS SHOWING WHAT THEY MADE", Beacon's card with "Open project", and "Being on this page is
   not advice and is not a promise."

### 4.8 The holders' pause (a world made for it)

The pause is **off unless the world is made with it**. Stop the world (Ctrl-C) and start it again with the switch in front of the
same command: `WORLD_KIND=pause SERVE_HOST=<this computer's address> scripts/pot-full-loop.sh --serve` (the script runs the deploy
script with `HOLDER_PAUSE=1`). Then do 4.1 to 4.3 again (Beacon, Abe, Bea, Cy) and come back here. Nothing below can be seen in a
world made without the switch: the page then says nothing about a pause at all, and that is correct.

1. **Fay, in 4.1, before she signs the launch:** the sheet "Launch Beacon" has the sentence "On this network holders can pause the
   team's spending when a third of Shares are parked. You cannot turn this off for your project." (Said before she signs, because the
   project is born with it for good.)
2. **Cy, Money tab:** a card headed "Holders can pause the team's spending." says: "If a third of all backers' Shares are parked, the
   team's daily allowance and new task plans pause one day later, for as long as that much stays parked. Parking does not move anyone's
   money. You can take your money out any time.", then "None of backers' Shares are parked. A third is needed." with a meter, and
   "More Shares joining can lower the parked share and end a pause." Under **Your Shares** there is the press **Park Shares**.
3. **Cy presses "Park Shares".** **Working:** the sheet "Park Shares": "Parked Shares count toward pausing the team's spending. They
   stay yours: take them back or take them out any day.", then (on a wallet) "Your wallet is asked twice: first to let the project hold
   them, then to park." (on a phone with a passkey account: "In one press." and "Your passkey is asked once."), the choice "All of it",
   "Half", "A quarter", and "You park 1,960 Shares. After this, 15.3% of backers' Shares are parked. At a third, the team's allowance
   and new task plans pause one day later." (your numbers follow from what you backed with). Press "Park", sign twice. **Working:**
   "Parked. You can take them back or take them out any time from Your Shares." and the line "1,960 of your 1,960 Shares are parked."
   Your Shares still reads 1,960 Shares: **parked Shares are still yours**, and Take out still offers them.
4. **Abe parks all of his, then Bea parks "A quarter" of hers.** After Bea's press the record needs up to a minute; reload the Money
   tab. **Working:** "A third is parked. The team's allowance and new task plans pause on <a date and time> if it stays there." The
   word "stopped" is not said yet. **Fay's Money tab, "The allowance":** "Holders have parked a third of all Shares. Your allowance and
   new task plans pause on <the same time> if it stays there. Until then you can draw what the box holds." and "Draw from the box" still
   works.
5. **Move the clock past the day:** `cast rpc --rpc-url <the chain address> evm_increaseTime 87000`, wait two seconds, then up to a
   minute for the server. **Working (Cy's card):** "Paused since <time>. The team cannot draw its allowance or plan new tasks while a
   third stays parked. Tasks already planned go on. Everyone can still take their money out. It ends when <n> fewer Shares are
   parked." **Fay's allowance card:** "Paused by holders since <time>. You cannot draw the allowance or plan a new task until fewer
   than a third of Shares are parked. You can still check in, finish tasks already planned, grant Team Shares and hand over." and the
   press "Draw from the box" is off, with that sentence as its description. In a plan's sheet the press is off with the same sentence.
   (If a stale page lets a press through anyway, the chain refuses and the page says "The team's spending is paused by holders. Try
   again when parked Shares fall below a third.")
6. **Take back, one press:** Cy's Your Shares has **Take back**. Press it: no sheet opens, the line "Take back 1,960 Shares to your
   wallet. Nothing is charged." appears with **Take back** and **Cancel**. Cancel sends nothing; Take back asks the wallet once.
7. **Take out with Shares parked, one press:** Abe's Take out: the sheet says "You hold 980 Shares (980 parked).", "Taking out takes
   your parked Shares back first, in the same press." and (on a wallet) "Your wallet is asked twice." Press the button once: his parked
   Shares come back and are taken out. It works while the pause is on. **Working:** the parked share falls. With the walk's numbers it
   is still above a third after Abe's take-out (4,410 of 11,760 are still parked), so the card still says "Paused": **Cy then takes
   his parked Shares back** (step 6), and once the share is under a third the card says "<n>% of backers' Shares are parked. A third
   is needed." and Fay's "Draw from the box" is back (the server needs up to a minute).
8. **The warning day that did not start (only if you see it):** if the share parked is at a third but no warning day is running (a
   join cleared it, or others took out, and nobody has parked or taken back since), the card says "A third is parked, but the
   warning day has not started. Press "Start the day" and, if it stays there, the team's allowance and new task plans pause one day
   later." with the press **Start the day**. Anyone may press it; it moves no money. It is hard to make on purpose in this walk
   (a join that lowers the parked share clears the day, and a later take-out by others brings it back to the line); the app's tests
   make it.

**Not tried by anyone:** this on a real phone with a passkey account (the loop proves the one-press batch with a software passkey,
`scripts/phone-loop.sh`); the same with real people over days; any real money. **Walked at 360 x 640** by the loop's journey
(`scripts/pot-full-loop.sh pot-pause.spec`, checked for anything sticking out sideways and for the named parts being on the screen)
in Chromium.

## 5. What cannot be tried without an `https` address

A passkey, alerts when the app is closed, and the Copy and Share presses need a real certificate (the address of a test deployment:
`docs/next-version/DEPLOY-TEST-NETWORK.md`). A laptop browser on `http://localhost` is secure enough for alerts in principle. Tried
here, in Chromium with no connection to a push service: you sign up, back with the room box ticked (or press "Confirm this account backs the project" in the room: alerts are offered only to an account
linked to its wallet; before that the **You** page says "To tell which projects you back, the server needs this account confirmed."), open **You** (the server has a push key when you start the
script with `WORLD_PUSH=1 SERVE_HOST=localhost`), and under "Alerts when you are away" press "Turn on alerts". **What I saw:** the
press ended with "Alerts could not be turned on. Try again." because a test browser has no push service. In a desktop Chrome with a
connection it is **not tried by anyone yet**. The server's side of alerts (the message, its encryption, the three fixed sentences) is
proved by `scripts/pot-full-loop.sh pot-push.spec`, which uses a local stand-in for the push service.

## 6. When a step fails

- **The page says "The server didn't answer." or "No numbers yet":** wait a minute and reload; the server reads a block about every
  two seconds and signs a record about every half minute.
- **"Your wallet is on another network.":** press "Switch network".
- **The wallet is asked and says no, or you close it:** nothing was sent; press again.
- **A press is missing after a clock move:** the team has to check in again ("This week", "Check in only") and the server needs up to a
  minute.
- **Back says the door is shut:** same cause; check in, wait, reload.
- **The script stopped or the chain restarted:** everything in that world is gone; start again from part 2 (browser profiles keep
  their old account: use fresh ones).
- **Anything else:** the server's last lines are in the script's window; copy them with the step and what the screen said.
