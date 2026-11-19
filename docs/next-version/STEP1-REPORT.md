# Step 1, joined up: the contracts, the server and the app run together in a real browser

Branch `v6`, 19 November 2026. This is the report of the joined-up run: `scripts/pot-full-loop.sh` starts a local chain, deploys
`contracts/pot`, starts the real server (relay) with its chain reader and helper on that chain, builds the app for it and lets the server
serve it, and walks one project through everything step 1 offers, in Chromium. Nothing is pushed. **No person has tested any of
this: every run below was made by an agent. The human test is the owner's and is still to do (the steps are in section 5).** This is
not legal or tax advice, and no figure here is a promise of any result for anyone. Every amount is play money on a local test chain.

Companion pages: the contracts (`contracts/pot/README.md`, `POT-STEP1A-REPORT.md`), the one specification of the record both sides
use (`RECORD-V2.md` and `record-v2-example.json`), the server's report (`READER-V2-REPORT.md`) and the app's (`APP-POT-REPORT.md`).

## 1. What step 1 gives a person now

**A backer** (a person with a wallet in their browser):

- Opens a project's page and sees, in plain words, "The project's money", "What one Share gives if taken out now", where the
  project stands (open, quiet, dormant, can be wound down, wound down), what the team may take each day, and the line "This can go
  up or down. It is not a return." The first line of the Money tab says this is a test network and the dollars are play money; the
  legal line is on the page word for word.
- Gets play dollars from a faucet (once per account, 1,000 of them): two presses, one wallet prompt.
- Backs: types an amount (1 box), presses Back, reads the sheet (what they pay, the 2% to the platform, the Shares they get, what
  taking out right now would give), presses once more. **Two presses and one wallet prompt.** Where a dollar cannot pay and call in one
  step it is two prompts (approve, then join); the play dollar always can.
- Sees the new Shares and the take-out value at once (read from the chain), and the project's own money a few seconds later, once the
  server has read the block.
- Takes out: presses Take out, reads the cash the sheet shows, presses once more. **Two presses and one wallet prompt.** It is open
  whatever the door, the allowance or the state of the project, and it still works when the server's numbers cannot be read.

**A founder:** starts a project in three answers; opens it to backers from its page (a card, a sheet with two numbers, the daily
allowance and the Team pool, each with a plain sentence for backers, and one signature); posts the week's update and checks in on the network with one press from This week;
draws from the allowance box to an address of their choice (the sheet says how much the box holds); lowers the rate at once or
announces a raise and applies it after the wait; opens or closes the door; grants Team Shares to a member who linked a wallet; hands the seat to a teammate, asks one to run it together (a Pair) and winds the
project down. A task accepted and paid draws its money from the box in the same press when the box holds enough; when it does not (or a
Pair runs the project) the work is accepted now and every reader sees "Accepted, pay owed: X", never "paid", until the payment's
transaction is on the task's record; the task then offers "Pay from the box", and for a Pair the other signer reads which task the draw is for.

**A team member** sees their grants, claims what has unlocked, and can give up the rest; **a second signer** of a project run by two
reads each waiting call in a sentence before confirming it.

**The server** reads every project from the chain, publishes the numbers record (version 2) at every change and at its promised
cadence, collects the platform's fee once a week and settles outside money that has all arrived, and prices the hosted manager from the
new fee events (zero on play dollars unless the operator sets a floor).

**Not in step 1:** the task queue, notice, take, return and exit notes (step 2); alerts; the holder room and social parts (step 3).
A founder can launch from the app. This run does it in the browser (section 2, step 2).

## 2. What the joined-up run did, and the exact result

`scripts/pot-full-loop.sh`, run on this machine on 19 November 2026 (4 CPUs, shared; anvil, the relay built at
`target/debug/buzz-relay`, Postgres and Redis already running, Chromium 1243 from `/opt/pw-browsers`):

| Result | |
|---|---|
| Checks | **213 checks passed**, 1 journey passed, 0 failed (the browser part 42 s; the whole script about a minute with the relay already built) |
| Of those | 65 field-by-field comparisons of the record with the contracts, made twice (at the last block of the journey and a week later), by the existing checker `scripts/chain-loop-pot-check.py`, which calls every contract view at the record's own block and works the settled money forward on its own |
| Earlier runs | 6 full passes before the launch moved into the browser (194, 209, 210, 210, 211 and 211 checks); then, with the app's own launch, one run that failed at its last check (the helper's stored call names had changed to `treasury.collectFees` and `treasury.settle` with the server's migration 0070; the expectation followed) and the pass reported above |
| Left behind | nothing: the script stops anvil, the relay and the miner, drops its scratch database, removes its temporary folder and the app build (checked after each run: no process, no `/tmp` folder, no database) |

What the journey does, in order (each line is checked; the output has one `ok` line each):

1. The server says it offers investing and names its own signing key.
2. A **founder** signs up in the app (hosted sign-up with the age box and terms, as every real-server run does), starts "Lantern" in
   its three answers, and the project's link opens. The founder (a public anvil development account in the page's wallet) **opens it to
   backers from the project's page**: the launch card, the sheet with its defaults (0.10% a day, 10,000,000 Team Shares), **2 presses,
   1 wallet prompt**. The app then signs the founder's record naming the launch itself (the `chain-key` tag).
3. The server's record appears: version 2, play money, the project's Treasury, the founder's account, signed by the server's own key.
4. A first backer (outside the browser, through the app's own Back plan) puts in 50 play dollars. The server reads it: 49 paid in.
5. A **stranger**, signed out, opens the project page. The page's "project's money" and "what one Share gives if taken out now" are
   the record's, and so are the allowance sentence (rate, amount a day, what the box holds), the Team's part and "where it stands".
   The play-money line, the legal line and "This can go up or down. It is not a return." are on the page.
6. The stranger's browser gets a wallet (a real account on the chain), presses Get play dollars (2 presses, 1 prompt; 1,000 on the
   chain and on the page), types 100 and Backs: **2 presses, 1 box, 1 prompt, one `transferAndCall` on the play dollar**. The sheet's
   Shares are the Shares that landed. The page shows them (9,800) and the take-out value, which is the chain's quote to within the
   guard. Then the server's numbers move: 147 paid in, and the list of holders has the backer with exactly the chain's Shares.
7. The **founder** posts the week's update and checks in from This week. The check-in names that update, which the server holds. Two
   days pass on the chain (time moved on the chain, the page's clock left alone); the founder checks in again, the allowance box
   fills (0.29 play dollars), and the founder **draws 0.10** to their own account from the box, through the sheet.
8. **Outside money** arrives (200 play dollars from a stranger); the server shows it arriving. A day later part of it has arrived.
9. The backer **Takes out**: 2 presses, 1 prompt. The sheet says outside money is still arriving and stays for the people who stay.
   The sheet's cash (98.02) is what the chain paid, within the guard; the backer holds nothing afterwards; the page says so.
10. The server's helper has collected the platform's fee with nobody pressing. **Every number on the page equals the record
    the server signed** (both browsers show the same record, block by block), **which equals the contracts' own views at that
    block** (65 checks). The Shares left are exactly the first backer's.
11. A week passes on the chain. The helper collects the rest of the fee (the platform holds all 3 play dollars) and settles the outside
    money that has all arrived. The page and the record are compared with the contracts again (65 more checks). The helper's jobs
    are exactly its two permitted calls (collect the fee, settle), all done, none failed, and every transaction from its address is one
    of them. It checked in for nobody.
12. The server never refused to sign a record at any point of the run (its log is searched for the refusal line after the run).

Measured on the way (one run, local chain with a block a second, two blocks to be final, a pass a second):

| Step | Presses | Boxes typed | Wallet prompts |
|---|---|---|---|
| Get play dollars | 2 | 0 | 1 |
| Back | 2 | 1 | 1 |
| Take out | 2 | 0 | 1 |
| The server's numbers move after a Back | 3.5 s after the press, with a block a second and two blocks to be final; with 12-second blocks the two blocks alone take about 24 s, so expect about half a minute | | |

"Take out is one press and one signature" in the design is two presses in the app (the button on the page opens the sheet that shows the
cash, the sheet's button sends) and one signature. This is the budget the plan allows; I did not remove the sheet.

## 3. Where the sides disagreed, and what was done

The record specification was followed exactly in every field the run reads: the same example file is parsed by the server's types and by
the app's parser (their own tests), and in this run the app read the server's real records at every step. One point disagreed:

1. **`refreshEverySecs` (timing).** *(Closed: the server's range now ends at 86,400 seconds, the range the app accepts.)* The app refused a record that promises a refresh faster than 60 seconds; the server's setting allows
   5 (its report's choice 6, so a loop can show the cadence). The specification says 600 or 3600 and names no floor, so the app's
   floor was the departure: a record signed with a 30-second promise read as "No numbers yet". **Fixed in the app** (`numbers-read.ts`:
   the floor is 5, the server's own); the test `numbers-hostile.test.ts` accepts 5 and refuses 4 (and 0 and a week as before).
   The server's setting allowed up to 7 days while the app reads at most 24 hours; the server track has since ended its range at 86,400.

Other things the joined-up run showed that are not disagreements:

2. **The node must serve state a few blocks back.** The reader calls every view at the record's own block (a few blocks behind the
   head). A node that keeps only the latest state refuses ("block height is 7 but requested was 4"); the run first failed on an anvil
   started with `--prune-history`. Any normal node keeps recent state; an operator must not point the reader at a provider that does not.
3. **The helper collects the platform's fee once a week**, as built (its job key is the week). The first fee is collected right after the
   first join; the second backer's fee waited for the next week (the run moves the chain a week to show it). The platform sees its fee up
   to a week late. If the owner wants it per join, it is a rule change in the helper's planner.
4. **A launch counts as a check-in.** On a new project the record has `lastCheckIn` = the launch time and no record hash; the page says
   "The team checked in on <the launch day>". Nothing wrong; it can read oddly to a founder who has not checked in yet.
5. **Server-signed record timing is wall-clock.** `builtAt` is the server's own time while `asOf.time` is the chain's. When the chain's
   time is moved forward (this run moves it 11 days) the page's age words still read the record as fresh, because they compare with
   `builtAt`. Correct for a real chain; it is why the run leaves the page's clock alone.
6. In `--serve` the first attempt asked the server through `localhost` while its own address was the network address, and found no
   records; asking through the server's own address worked. I did not look into the cause (most likely each address is its own
   community, so the records are kept under the address in `BUZZ_RELAY_URL`); it is why `--serve` reads and seeds through the public address.

## 4. What was proven by this run, and what was not

**Proven here (real chain, real server, real browser, real app build):**

- The contracts' events and views, the server's reader, the signed record, the app's parser and its screens agree on every figure the
  Money tab shows, at every step above, for one project with two backers, a founder, a draw, outside money, a take-out and a week.
- Back and Take out as the app sends them (the injected wallet path) land exactly what their sheets said, within the stated guard, in
  the stated number of presses and prompts, and a double press and a refused prompt are covered by the app's own browser specs.
- The server signs only what passes its own checks, and its helper sends only the two calls it may.
- The run's build is the default one, with the old-design flag off; the app's own tests check that the old stage, round, auction and
  market screens are not reachable then (this run does not look for them).

**Not proven (and why):**

- **A real phone, a real wallet app, a real network.** Chromium in a phone-sized window with an injected wallet stands in for all three.
  Block times of 12 seconds, slow nodes, a provider with rate limits, a reorganisation of the chain and a node that lags were not run
  end to end (the server's own tests cover reorganisations and a stepping-back head).
- **The passkey path against the real server.** It was proven on the pot contracts with stand-ins for the bundler and the sponsor
  (`scripts/pot-app-phone-e2e.sh`, `scripts/pot-app-loop.sh`), not in this joined-up run; here the wallet is the injected one.
- **The founder's and team's other screens on the real server:** Team Shares grant and claim, a member's own exit, the rate and door
  sheets, the seat (hand over, a Pair, wind down), the task payment from the box (alone, owed and later, through a Pair) and agent
  limits. Each is driven in a real browser on a real local chain with the server's record stood in by the spec
  (`app/tests/e2e/pot-seat.spec.ts`, `pot-tasks.spec.ts`, `pot-week.spec.ts`), not with the real server and reader. This run uses the
  launch, the check-in, the draw and the Money tab's founder view.
- **A passkey account launching** (the phone path) was proven for the contracts and as one operation in a unit test, not in a browser;
  **more than a handful of projects**, **two relays at once**, **the hosted manager** against a real model, and **a launch on Sepolia**
  were not run.
- **The `--serve` mode on a network address other than the computer's own**: the sandbox this ran in routes the browser's connection to
  its own network address through a proxy that answers 502, so the phone path was tried with `SERVE_HOST=127.0.0.1` (the page, the
  wallet, the faucet and a Back of 25 play dollars worked: 2 wallet prompts in all, 2,450 Shares). Whether the phone reaches the
  computer is for the owner's network to say.

## 5. Try it on a phone (the human test is yours; nothing below was done on a phone)

What you need on the computer: Foundry (`anvil`, `cast`, `forge`), Node and pnpm, Postgres and Redis, the relay built once
(`cargo build -p buzz-relay`; the script never builds), `contracts/pot` built once (`forge build` in `contracts/pot`), and a phone on
the same network with a **browser that has a wallet** (a wallet app's own browser). A passkey account needs `https` and a bundler and
sponsor, so it cannot be tried this way.

1. In the repository: `. ./bin/activate-hermit`, then `scripts/pot-full-loop.sh --serve`. Add `SERVE_HOST=<the computer's address on
   your network>` if its first address is not the one the phone reaches. It takes about two minutes, then prints the app's address
   (for example `http://192.168.1.20:45835/p/lantern-…`), the chain's address, and the account to import. It leaves one project,
   "Lantern", with 50 play dollars in it. Leave the window open: Ctrl-C stops and removes everything.
   The chain's development accounts are public and unlocked, so anyone on that network can send play-money transactions to it while
   it runs: use a network you trust.
2. In the phone's wallet add a network: any name, the printed RPC address, chain id 31337, symbol ETH. Import account number 2 of the
   development accounts: the script prints the command that shows its key (run it on the computer; the key is public and worth
   nothing; never put a real account's key anywhere near this).
3. Open the printed app address in the wallet's browser.
   **What working looks like:** the project page opens; the Money tab's first line says this is a test network and the dollars are play
   money; it shows "The project's money" (about 49, a little less each minute as the allowance flows out), "What one Share gives if
   taken out now" (about 0.01), "Where it stands: Open", "This can go up or down. It is not a return." and the legal line word for word.
4. Press **Get play dollars**, then the sheet's button. The wallet asks **once**. "Play dollars you hold" shows 1,000.
5. Type 25, press **Back**. The sheet shows: you pay 25 dollars, the fee to the platform (0.5), you get about 2,450 Shares, and
   "Taking out right now would give you" about 24.5 dollars. Press the sheet's button. The wallet asks **once**. The sheet closes and
   "You hold" shows about 2,450 Shares, with "What you would get if you took out now" about 24.5 dollars.
6. Reload after a few seconds: "The project's money" has grown by what you paid in, less the fee (about 73 now).
7. Press **Take out**, then the sheet's button. The wallet asks **once**. You get back about 24.5 dollars (the fee is not returned), and
   "You hold no Shares in this project yet." shows.
8. Optional: with a second wallet account, Back the same project and see that the first account's Shares do not change; stop the
   script's server (not the chain) and reload: the page says the numbers could not be read and still lets you take your Shares out.

9. Optional, as a founder: sign up on the phone's browser, press **Start** and answer the three questions, then on the project's page
   press **Open <name> to backers**, read the sheet (two numbers, the limits, what cannot be changed later) and press its button. The
   wallet asks **once**. The page then moves to the Money tab and says "No numbers yet" until the server has read the block (a few
   seconds on this chain, about half a minute with 12-second blocks); no figure shows until then. The account must be one the wallet
   holds with play dollars on this network; the sheet says plainly that the dollars are play money.

If something differs from what is written here, that is a finding: write down the step and what the screen said.

## 6. What a test-network launch still needs that no engineer here can do

1. **A chosen network.** The play dollar deploys only on chain 31337 (local) or 11155111 (Sepolia). The owner picks one.
2. **Deployed contracts and their addresses.** An operator deploys `contracts/pot` with their own key held in a keystore or a hardware
   wallet (`contracts/pot/DEPLOYMENTS.md`): the platform's fee receiver and the settings admin are theirs to name. The deployments
   file then feeds the app's build (`CREATON_DEPLOYMENTS_FILE`) and the server's settings (`BUZZ_CHAIN_*`: node address, chain id,
   Launcher, start block).
3. **A node the reader may use.** One that serves state a few blocks back (section 3, item 2), with a rate limit that allows about 50
   calls a pass per project.
4. **Keys and money for the server:** the server's own signing key; the helper's key, funded with the network's coin (it pays gas for
   two calls); the settings for its daily gas and spend caps. None of these exists in this repository, by rule.
5. **An operator's bundler and sponsor,** if the passkey phone path is to be on: their two addresses and a funded sponsor, and the
   build switch `VITE_CREATON_PASSKEY_ACCOUNT=1`, over `https`. Without them a phone needs a browser with a wallet.
6. **Hosting and the legal parts:** a public address with `https`, the hosted terms of use, privacy note and the age box (already
   supported and used by the run), the operator's own monitoring of the reader's lag, and counsel's answers to the questions in
   `JOIN-LEAVE-DESIGN.md` section 12 before any real money is ever offered. The test network avoids them; real money must not start
   until they are answered.

## 7. How to run it again

```bash
. ./bin/activate-hermit
cargo build -p buzz-relay                 # once; the script never builds
( cd contracts/pot && forge build )       # once
scripts/pot-full-loop.sh                  # the journey; prints "pot-full-loop: N checks passed."
scripts/pot-full-loop.sh --serve          # the same world left running for a phone (section 5)
# helpful: FOUNDRY_BIN=<folder with anvil, cast, forge>  SHOTS_DIR=<folder for the journey's screenshots>  RELAY_LOG_COPY=<file>
```

Files: `scripts/pot-full-loop.sh` (the world and the cleanup), `app/playwright.pot-full.config.ts`,
`app/tests/e2e-pot-full/pot-full.spec.ts` (the journey), `world.ts` (the server over HTTP, the chain, the checker),
`seed.spec.ts` (what `--serve` leaves behind). The wallet in the page moved to `app/tests/e2e/helpers/live-wallet.ts` so the two
kinds of spec share it. The journey reads the server with signed HTTP requests, keeps no key anywhere (the founder's account key
is read from the browser's own storage and used in memory to sign one record), and uses only anvil's public development accounts.

Gates, as run: see the end of `APP-POT-REPORT.md` ("Third round, app engineer B"). No file under `crates/` or `contracts/` was touched.

## 8. Chosen under the owner's standing go; the owner may overrule

1. **The browser journey is one test, in a new folder** (`app/tests/e2e-pot-full`), with its own config, beside `e2e-real`, so the
   existing real-server run (`scripts/app-real-loop-e2e.sh`, no chain) is unchanged.
2. **The first backer, the outside payer and the chain's clock are driven from the test, not the browser,** with the app's own call
   builders. The browser does what a person does: sign up, start, get play dollars, Back, check in, draw, Take out.
3. **The chain mines a block a second during the journey** (the test does it) so the server can read what it must, as a live chain
   would. The server's settings for the run are its fastest (a pass a second, two confirmations, a fresh record at least every 30 s).
4. **The field-by-field comparison uses the server track's checker unchanged** (`chain-loop-pot-check.py`), on the record the page
   showed: the page is first shown to equal that very record (read before and after the page is read; it tries again when the server
   signed a new one meanwhile), then the record to equal the contracts.
5. **`--serve` still launches the project for the person** (a throwaway founder key made in memory and never printed or stored) so a
   phone starts with a project to look at; the browser journey itself launches from the app. A person can also start and launch a
   project of their own from the phone (section 5, step 9).
6. **The app's refresh floor moved to the server's** (section 3, item 1) rather than the server's floor up to the app's, because the
   specification names no floor and the server's setting is what the owner's operator sees.
7. **The one `Chosen` item I did not decide:** whether the platform's fee should be collected per join instead of per week
   (section 3, item 3). The run shows the rule as built.
