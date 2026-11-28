# Try it: your own test world, on a phone and a laptop

This is the one guide for trying the new join-and-leave app yourself. Everything runs on your computer with play dollars: nothing
here is real money, and nothing leaves your network. Where a step could not be tried by anyone yet, it says
**not tried by anyone yet**. Words in double quotes are the app's own words, copied from the screen; if your screen says
something else, that is a finding: write down the step and what the screen said.

Time: the ten-minute look takes ten minutes. The full test takes about half an hour (an estimate). Part 1 is done once.

The full loop is **one world** with **one journey**: `scripts/pot-full-loop.sh` with no argument starts one chain, one server and one
database, then runs one browser journey in it (a project from its start to a Take out; 48 seconds in the browser here). With
`--serve` it leaves that same world running for you, with one demo project in it.

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
| The server | the server | `cargo build -p buzz-relay` once (the script never builds) |

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

Which address to give `SERVE_HOST` depends on where you will open the app:

- **A laptop browser with a wallet extension (the easiest way, nothing else needed):** `SERVE_HOST=localhost`. The page is
  "secure" on this computer, so everything works except what needs a real certificate (part 5).
- **A phone on your home network:** `SERVE_HOST=` your computer's address on that network (Mac: `ipconfig getifaddr en0`, or System
  Settings, Wi-Fi, Details; Linux: `hostname -I`). The script finds it itself when it can and asks for it when it cannot.
- **An Android phone on a cable:** `SERVE_HOST=localhost`, then `adb reverse tcp:<app port> tcp:<app port>` and the same for the
  chain's port, and open `http://localhost:<app port>` on the phone. **Not tried by anyone yet.**

**On a home network the page is plain `http`.** I opened it that way here and the browser says so: a passkey cannot exist there, the
Copy press cannot copy, and a phone wallet may refuse a chain address that is not `https`. What you see:
sign-up says "The passkey did not work in this browser. Try again, or create without a passkey." and its press is "Create without a
passkey"; the Share sheet's "Copy link" says "Your browser would not copy it. Select the link above and copy it." If your phone's wallet
will not take the chain address, use a wallet that allows it, or the Android cable above, or use the laptop with its extension and
keep the phone as a visitor (it needs no wallet to look).

### The wallet

Add the network the script prints: name `Local test network`, the chain address, chain id 31337, symbol ETH. A wallet that has not
heard of it is offered it by the app (see step 3.2). Then import accounts from anvil's public development accounts. **They count from
0.** Use **2, 3, 6, 8 or 9**; do **not** use 0, 1, 4, 5 or 7 (the contracts, the demo project's founder and first backer and plan, and the server's
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
| Bea | 6 | profile 2 | backs |

Each account can use the faucet once, so a second Back by the same account uses the play dollars it already has.

## 3. The ten-minute look (on the phone, with the demo project "Lantern")

1. Open the printed app address on the phone, in its ordinary browser first. **Working:** the project's name, "Lantern", then "The
   project's money", "This can go up or down. It is not a return.", "This is a test network. The dollars are play money, not real
   money." and "You can take your money out any time. Nothing here promises a profit." A browser with no wallet shows, under "Back this
   project", "Open this page in a browser with a wallet to back this project." (**Home**, the first tab, lists Lantern too.)
2. Open the same address in the wallet's own browser. **Working:** "Connect your wallet to back this project." and a press
   "Connect your wallet". Press it and the wallet asks for the account (import account 3 on the phone for Abe). If the wallet is on
   another network the Money tab says "Your wallet is on another network. Switch it to this project's test network to see your
   Shares." and has the press "Switch network"; a wallet that does not know the network is asked to add `Local test network` with the
   chain address and ETH, and you say yes in the wallet.
3. Under "How many dollars?" is "Get play dollars" (until the account has used the faucet, once). Press it. **Working:** the wallet
   asks once; "You have your play dollars." and the press goes away. The **Money** tab's "Your Shares" then shows "Play dollars you
   hold".
4. Type 25 in "How many dollars?" and press "Back" (the primary press for someone who holds nothing). **Working:** a sheet "Back Lantern" with "You pay", "You get", "Taking out now would give",
   the team's daily limit and, while the platform keeps a fee, "Creaton keeps 2% of what you pay." There is no box to tick. Press "Back with 25 dollars". The wallet asks
   once; "Backed. Your new Shares show on this page." The top of the page shows "You hold 2,450 Shares".
5. At the top of the page, "You hold 2,450 Shares, worth" an amount, with "This can go up or down. It is not a return." and a press
   "Take out" (Back is then the second press). Press "Take out", then the sheet's button ("Take out 2,450 Shares"). **Working:** "Take
   out of Lantern" with "You take out" and "You get" (one press takes all of it), one wallet question, then "Taken out. The money is in your wallet." and
   the line about what you hold goes away.
6. Read the demo's planned task, above the tabs and again on the Money tab under "Planned and running tasks". **Working:** "A planned
   task", "The team plans to pay up to 2 dollars to" an address "for a task, from" a date about two weeks away, "You can take your
   money out before then. 2 dollars is the most; it can be less if people take out first.", "2 dollars would be set aside today (a
   share of the project's money). This can go up or down. It is not a return." and "This task cannot be taken unless the team checks
   in before" a date. While you hold Shares there is a press "Take out before" the date. The app has no screen to plan, take or pay a
   task: this one plan was made on the chain by the script, to show what a holder sees.

## 4. The full test, on a project you launch

Name the project **Beacon**. The two clock moves below are made from your computer with the chain address the script printed,
followed by two seconds of waiting for the next block. A "week" in this world is a real week.

**Side effects of moving the clock (all expected).** The server's record and the page keep their own clocks, so after a move the
record reads as old: the page says "as of ..." with "This may be out of date: the server has not refreshed this project since."
until the server has read the next block (up to a minute). The terms and privacy note this world serves are the operator's drafts
with bracketed items for counsel: that is expected on a test world. Never move the clock when a step does not ask for it.

### 4.1 Launch (Fay, profile 1)

1. Open the app address, then `/welcome`, and sign up (name Fay, the two boxes "I am 18 years of age or older." and "I agree to the
   Terms of use and have read the Privacy note. Posts and votes are public.", then "Create without a passkey" on plain http).
2. Press **Start**. **Working:** "Start a project" and three boxes. Name it
   Beacon, answer "What will you make?" and "How will people know it worked?", press "Start".
3. On Beacon's page, under "Open Beacon to backers", press "Connect your wallet" (account 2). The card then has the press "Launch".
   **Working:** the sheet "Launch Beacon" with nothing to type: "The team may take 0.10% of the project's money a day. Team pool:
   10,000,000 Team Shares. You sign once." and, while the platform keeps a fee, "Creaton takes 2% of the money people put in." Press its button "Launch Beacon"; the wallet asks once.
   **Working:** "It is on the network. Tying your page to it now." and then "Your project is open to backers." For a few seconds, until
   the server has read the block, the Money tab can say "No numbers yet" and shows no figure.

### 4.2 Backers

The other profiles find Beacon on **Home** (or paste the address from Fay's address bar).

1. **Abe, on the phone, signed out:** open Beacon's address, Money tab, connect account 3 (he already has play dollars from part 3: the
   faucet gives them once per account), Back 10. (Two presses are called "Back" on a project's page: the one with the arrow at the top left
   goes to the last page; the one you want sits under "How many dollars?".) **Working:** no box in the sheet; one wallet question.
2. **Bea, profile 2:** sign up, open Beacon, connect account 6, press "Get play dollars" (one press), Back 100. **Working:** one wallet question for the
   Back and no second one: Back does not link the account to the wallet.

### 4.3 This week, and the allowance (Fay)

1. **This week**. **Working:** "This week" with Beacon's card and the presses "Post this
   week's update and check in" and "Check in only". Press the first, write a line under "What did you do this week?", press "Post and
   check in" and sign once. **Working:** "Posted and checked in. The allowance keeps running." and "Updated today".
2. Beacon's **Money** tab, section "The allowance": "In the box" and "Daily rate" (0.10%), then the presses "Draw from the box" and
   "Change the rate". The box starts nearly empty: it fills at 0.10% a day of the project's money. The check-in is on This week.
3. Move the clock a day: `cast rpc --rpc-url <the chain address> evm_increaseTime 87000`, wait two seconds, wait up to a minute for
   the server and reload. **Working:** the box holds about 0.09 dollars (yours follows from the project's money).
4. Press "Draw from the box". **Working:** the sheet "Draw from the allowance box": "The box holds about ... dollars now.",
   "Draw to which account?" and "How many dollars?". Put your own address (account 2) and
   0.05, press "Draw" and sign once: "Drawn from the allowance box.", and "Play dollars you hold" shows 0.05 more. If you type more than
   the box holds, the sheet says "The box holds about ... dollars now. Draw that or less." and the press stays off.
5. Grant Team Shares (section "Team Shares", press "Grant Team Shares") lists only people on the team and needs a teammate; it is not
   walked here.

### 4.4 The project goes quiet

1. Move the clock past the check-in window with no check-in: `cast rpc --rpc-url <the chain address> evm_increaseTime 1300000`, wait
   two seconds and up to a minute, reload. **Working:** where the Back box was, "The team has not checked in since" a date, "so new backing is paused until it does."
2. **Fay:** This week, "Check in only", sign once. **Working:** "Checked in. The allowance keeps running."; up to a minute later
   the Back box is there again.

**Not tried by anyone:** this on a real phone with a passkey account (the loop proves the one-press batch with a software passkey,
`scripts/phone-loop.sh`); the same with real people over days; any real money. **Walked at 360 x 640** (the narrowest phone the app
holds) in Chromium: every screen above, signed out and signed in, and every sheet, with nothing sticking out sideways.

## 5. What cannot be tried without an `https` address

A passkey and the Copy and Share presses need a real certificate (the address of a test deployment:
`docs/next-version/DEPLOY-TEST-NETWORK.md`).

## 6. When a step fails

- **The page says "The server didn't answer." or "No numbers yet":** wait a minute and reload; the server reads a block about every
  two seconds and signs a record about every half minute.
- **"Your wallet is on another network.":** press "Switch network".
- **The wallet is asked and says no, or you close it:** nothing was sent; press again.
- **A press is missing after a clock move:** the team has to check in again (This week, "Check in only") and the server needs up to a minute.
- **Back says the door is shut:** same cause; check in, wait, reload.
- **The script stopped or the chain restarted:** everything in that world is gone; start again from part 2 (browser profiles keep
  their old account: use fresh ones).
- **Anything else:** the server's last lines are in the script's window; copy them with the step and what the screen said.
