# Putting Creaton on a public test network (Sepolia)

For the person who runs the server. Plain numbered steps, in the order to do them. Everything here is **play money on a test
network**: the play dollar can be deployed only on chain 31337 (a local chain) or 11155111 (Sepolia), and its contract refuses
any other. Nothing here is legal or tax advice, and no figure in the app is a promise of any result.

No key, token or address of a real deployment is written in this repository, and none is written here. Every name below in
`<angle brackets>` is yours to fill in; every setting is named, never valued.

## What you need before you start

- A server with a host name of its own (DNS pointing at it), ports 80 and 443 open, Docker Compose v2.24.4 or newer, and room
  to build the image (several GB of memory and about 15 GB of disk for Docker; `deploy/compose/README.md`, "Creaton").
- A computer of your own for the contract deploy, with [Foundry](https://book.getfoundry.sh) (`forge`, `cast`) and this checkout.
- Sepolia test ether for two keys: the deploy key (a few hundredths is plenty) and the helper key (step 5). Any Sepolia faucet.
- Two Sepolia nodes: one for the page (every visitor's browser calls it) and one for the server (only your server calls it).
  Use your provider's request limits. They must not be the node your deploy key uses.
- For people who have no wallet app (a passkey account on a phone): an ERC-4337 bundler for EntryPoint 0.7 and a sponsor that
  pays the network fee, each behind an address that holds its own key (step 7). Leave this out and people send from a wallet in
  their browser.
- Your own finished terms and privacy note (step 10).

## 1. Get the code and the settings file

```bash
git clone <this repository> && cd <it>
cd deploy/compose
cat .env.example .env.creaton.example > .env       # one settings file for the server; keep it private (mode 0600)
```

`.env` is read only by your server and by `run.sh`. It is git-ignored and is never copied into the image (`.dockerignore`).
The lines for this guide are in the section "The Creaton app on a test network" of `.env.creaton.example`; they are commented
out. Leave them out and the server is the social app alone, with no money screens (investing is off by default).

## 2. Deploy contracts/pot with your own key

`contracts/pot/DEPLOYMENTS.md` is the reference for what is deployed and the settings. In short:

```bash
scripts/ensure-solc.sh 0.8.37                  # the compiler the contracts are pinned to
cd contracts/pot
forge build
cast wallet import <your keystore name> --interactive      # asks for the deploy key once and keeps it encrypted in your keystore
export SEPOLIA_RPC_URL=<your deploy node>
forge script script/DeployPot.s.sol --rpc-url sepolia --broadcast --account <your keystore name>     # or --ledger
```

- The key stays in your keystore or hardware wallet. Never paste it into a file or a command line, and never into this repository.
- On Sepolia the defaults are right for a trial: a new play dollar (6 decimals, a faucet of 1,000 once per account), a time unit
  of 7 days, a 2% platform fee. The sender is the platform's fee receiver and the settings admin; set `PLATFORM` and `ADMIN`
  to other addresses if you want that. Keep the 7 days for a public trial, so what people see is what a real project would do
  (`UNIT`, any multiple of 168 seconds, is allowed on a test network for a private try-out).
- It writes `contracts/pot/deployments/pot-11155111.json` (the chain id, the Launcher, the play dollar and the settings; git-ignored)
  and `contracts/pot/broadcast/DeployPot.s.sol/11155111/run-latest.json` (git-ignored). Keep both.
- Check the result as `DEPLOYMENTS.md` says: read `Launcher.platform()` and `Launcher.settingsHash()` and compare them with what
  you meant. `scripts/pot-chain-loop.sh` does the whole walk on a local chain and is the reference for the calls.
- The block to start the reader at is the earliest deploy block in the broadcast file (hex; `cast to-dec <it>`); the batch's
  first transaction is usually the play dollar's, and starting the reader a little before the Launcher is safe (it skips what
  is not one of its own). You need it in step 4.

### 2b. Step 4 and the Council round's switches (all off by default)

The same script has two switches and the earlier backers' claim, added in step 4. **Leave all of them alone and nothing about a
deployment changes**: no holder pause, no claim contract, every earlier test and screen exactly as before. A switch can be turned
on only by the deployer, once, inside the first hour after the deployment and before the first project is launched (a project is
born with the pause or without it for good), so set what you want in the deploy script's own run; after that hour it cannot be
turned on for that deployment.

| Setting | Default | What it does |
|---|---|---|
| `HOLDER_PAUSE` | `0` (off) | `1` also deploys the holder pause and binds it to the Launcher, so every project launched from then on has it. Holders park Shares; when parked Shares reach a third of the Shares backers hold, the team's draws from the allowance box and new task plans pause from one warning day later, for as long as a third stays parked. It never pays anyone, never moves money, and never stops or slows Take out. The founder is told so on the launch sheet, and it cannot be turned off for a project. The script prints the pause code's hash: publish it with your terms. |
| `COUNCIL` | `0` (off) | `1` turns the Council on for this deployment and **requires `HOLDER_PAUSE=1`** (`COUNCIL=1` with the pause off, or any value other than 0 or 1, stops the script before it sends anything). The script then deploys a `HolderVote` as the project's pause implementation — it *is* the pause, and it also counts votes — and a `Council` implementation, and binds both to the Launcher in the same broadcast, before any project can launch. Holders who parked backer Shares can elect the two Council seats that come up, and can open a replace vote with a list of five accounts; every result waits the Treasury's longest task notice and anyone can carry it out. Off by default and nothing shows on a project with no Council and no open vote; with it off a project sees no difference at all. It cannot be turned on after the first hour. The script prints the vote and Council code hashes: publish them with your terms. |
| `EARLIER_ROOT`, `EARLIER_TEXT_HASH`, `EARLIER_TOTAL`, `EARLIER_ROWS`, `EARLIER_FOUNDER`, `EARLIER_PROJECT_ID` | none of the six set (nothing is claimable) | **All six or none** (one set without the rest stops the script). They deploy the earlier backers' claim contract and bind it to the Launcher before any project can be launched; the project named by `EARLIER_FOUNDER` and `EARLIER_PROJECT_ID` (project zero) is born with a reserve of Team Shares for the list. `EARLIER_ROOT` is the list's one fingerprint (a Merkle root over rows of account and amount: the rows are never written down by this repository or the server), `EARLIER_TEXT_HASH` the fingerprint of the text a claimant accepts in the same call, `EARLIER_TOTAL` the pool in Team Share wei (the sum of the rows), `EARLIER_ROWS` the number of rows. The text, the consent words, the list and the pool's size are counsel's and the owner's: none is decided here. |
| `EARLIER_ALLOW_LARGE` | `0` | A pool above the founder's own Team pool limit (100,000,000 Shares) is refused unless this is `1`. The pool dilutes backers (and keeps diluting them after a wind-down: unclaimed rows never expire), so set it on purpose. |

The server needs **no setting** for either: it finds the pause, the Council and the vote contract from the contracts' own events
and writes what it reads into the signed numbers (null where a project has none). To check: `cast call <Launcher>
"holderPauseImpl()(address)"` is not the zero address with the pause on; `cast call <Launcher> "councilImpl()(address)"` is not the
zero address with the Council on; `cast call <Launcher> "earlier()(address)"` is not the zero address with the claim contract on.
`scripts/pot-full-loop.sh pot-pause.spec`, `pot-council.spec` (when the Council worlds land in that script) and
`pot-earlier.spec` run each on a local chain end to end, the last with an invented list made by `scripts/pot-earlier-list.mjs`.

**What the script prints, and where to publish it.** The run writes each code hash into `deployments/pot-<chain id>.json`
(`holderPauseCodehash`, `holderVoteCodehash`, `councilCodehash`, `earlierCodehash`, with the last three only when their switch
was on). Check each one against your own build before you publish it, in `contracts/pot`:

```bash
forge inspect HolderPause deployedBytecode | cast keccak     # must print holderPauseCodehash
forge inspect HolderVote deployedBytecode | cast keccak      # must print holderVoteCodehash
forge inspect Council deployedBytecode | cast keccak         # must print councilCodehash
forge inspect EarlierGrants deployedBytecode | cast keccak   # must print earlierCodehash
```

A hash that does not match is a stopped launch: the deployed code is not the code you built. Then publish the hashes with your
terms (step 10), on the page your terms live on, in the same words the script prints them: a person can then compare the code
their project runs on with what you published. Keep `deployments/pot-<chain id>.json` (it is git-ignored) with your own records.

For a **short test network**, deploy with `UNIT=1680` (a four-minute day) so a vote's stand window is four minutes, its voting
twelve, and its wait sixty-six minutes: a whole replace vote, wait and carry-out fits in about eighty-two minutes, and seat
elections come up every twelve hours. A real network uses the default seven-day unit and the same code.

## 3. Make the server's secrets, once

Follow `deploy/compose/README.md`, "First start", steps 1 to 3 (the host name in each setting) and step 2 (the secrets). They
must not change later. The three keys of this guide, and where each comes from:

| Key | Setting | Where it comes from |
|---|---|---|
| The server's signing key | `BUZZ_RELAY_PRIVATE_KEY` | `openssl rand -hex 32`, once. It signs everything the server publishes, including the numbers on every project page. Lose it and the server is a different server. |
| The operator's key | `RELAY_OWNER_PUBKEY` (the public half only) | Made with the built image, so after step 8 has built it and before step 12 starts the server: `docker run --rm --entrypoint buzz-admin <image> generate-key` (First start, step 6). The secret half stays on your own computer, in a password manager, never on the server. It signs in as the owner and starts seasons (`buzz launchpad seasons start`, with the key in the command's environment only). |
| The helper key | `BUZZ_CHAIN_HELPER_KEY` | A new key made for this, never one that holds anything else (step 5). |

### 3b. If a key leaks

None of these can be repaired quietly; each is a short public runbook, and all four end with telling the people using the
server what happened.

| The key | What it can do in the wrong hands | What you do |
|---|---|---|
| The server's signing key (`BUZZ_RELAY_PRIVATE_KEY`) | Sign anything the server signs, including project numbers. | Stop the server. Make a new key (`openssl rand -hex 32`), set it, restart. The server is from then on a different signer: say so, and treat every number the old key signed as untrusted. |
| The operator's key (the secret half of `RELAY_OWNER_PUBKEY`) | Sign in as the owner, start seasons. | Make a new key, set `RELAY_OWNER_PUBKEY` to its public half, restart. The old key's rights end with the setting. |
| The helper key (`BUZZ_CHAIN_HELPER_KEY`) | Spend the helper's ether on calls anyone may make (nothing else). | Set a new key, restart, send the new one a little ether, and sweep what is left from the old one. |
| The backups' key (`BUZZ_BACKUP_AGE_RECIPIENT`'s secret half) | Read every backup ever made to that key. | Make a new pair, set the new public key. Backups already made must be treated as readable by whoever holds the leaked key: move anything of value they hold and say so. |

## 4. Tell the server which chain to read

In `.env`, uncomment and fill in. These are read by the running server and are **not** built into the page.

| Setting | Value and where it comes from |
|---|---|
| `BUZZ_INVESTING` | `true`. The money screens need this and the build's network (step 8). Off unless you say `true`; `false` turns them off whatever the build says, with no rebuild. |
| `BUZZ_CHAIN_RPC_URL` | Your server's node (an `https://` address). It must serve `eth_chainId`, `eth_blockNumber`, `eth_getBlockByNumber`, `eth_getLogs` over a range of `BUZZ_CHAIN_LOG_RANGE` blocks (default 2,000; set it lower if the node refuses), `eth_call` at a block a few blocks behind the head, and, for the helper, `eth_getTransactionCount`, `eth_estimateGas`, `eth_maxPriorityFeePerGas`, `eth_sendRawTransaction`, `eth_getTransactionByHash` and `eth_getTransactionReceipt`. A free public node usually refuses large log ranges and past-block calls: use a provider key and a request limit. The address holds a key, so it stays in `.env` and out of the page. |
| `BUZZ_CHAIN_ID` | `11155111`. |
| `BUZZ_CHAIN_LAUNCHER` | The `launcher` in `deployments/pot-11155111.json`. |
| `BUZZ_CHAIN_START_BLOCK` | The deploy block from step 2. Left out, the server starts at block 0 and reads the whole chain first. |
| `BUZZ_CHAIN_CONFIRMATIONS` | Optional, default 12: how many blocks old a log must be before the numbers count it. |
| `RELAY_URL` | Already set in step 3 (`wss://<host>`). The numbers are signed into the community of that host; `BUZZ_CHAIN_COMMUNITY_HOST` names another if you need one. |

The server refuses to start on a half-set group (a chain setting without the node, a launcher that is not an address).

## 5. The helper key

The helper sends five calls anyone may make on a project: collect the platform's fee, settle money that has arrived, apply a
proposed allowance rate once its wait has ended, close a team grant's notice once its time has come (`Vester.execute`), and
burn a grant after a wind-down (`Vester.burnAfterWindDown`). **With the Council switched on** (`COUNCIL=1`, step 2b) it sends
four more, at each project's vote contract: open the seat election that is due, record a ballot's result once its vote has
ended, carry out a won result once its wait has run, and mark one that ran out. It never checks in, takes out, draws, claims
or winds a project down for anyone: winding down a quiet project is a person's press (a test lists every call it must never
be able to send).

Each call is simulated against the chain first and sent only if it will succeed. The last three are held to tighter limits so
that a stranger who opens projects cannot make the helper spend its gas: 3 failed attempts end a job, at most 3 of them are
looked at in a pass, at most 8 are sent for one project in a day, and together they may use at most 20% of the daily gas and
spend caps, so the fee and the settle keep their room. A failure is recorded in `chain_helper_jobs.last_error` and in the
`buzz_chain_helper_failed_total` counter.

1. Make a new key (`cast wallet new`), put its secret in `.env` as `BUZZ_CHAIN_HELPER_KEY`, and send its address a little Sepolia
   ether (0.05 lasts a long time; its daily spend is capped by `BUZZ_CHAIN_HELPER_DAILY_SPEND_WEI`, default 0.01 ether, and
   `BUZZ_CHAIN_HELPER_DAILY_GAS`). **Watch its balance and top it up**: when the key is dry the fee collection and the settles
   stop without anyone being told. `cast balance <the helper's address> --rpc-url <your node>` says what is left; the server
   records every failed call in `chain_helper_jobs.last_error` and counts them in `buzz_chain_helper_failed_total`, so a run of
   failures that is not a bad job is usually an empty key.
2. The key is read from the server's environment and from nowhere else; it is never logged. Do not reuse a key that holds
   anything. Left out, the helper is off and fees are collected only when somebody calls `collectFees` by hand.

## 6. Wallet links for phone accounts

A passkey account is a contract, so the server asks the chain to check its signature when a person links their account to the
wallet that backs. In `.env`, uncomment the three lines in "Wallet links": `BUZZ_EVM_AUTH=1`, `BUZZ_EVM_CHAIN_ID=11155111`
and `BUZZ_EVM_RPC_URL` (a node; it may be the server's node from step 4). They also switch on the server's sign-in with an
Ethereum wallet, so set them only for phone accounts. Without them the app says plainly that the room and
alerts are not switched on for phone accounts. Needed only when you turn phone accounts on (step 7).

## 7. Phone accounts: the bundler and the sponsor

Skip this step and people with a wallet in their browser can still back; a phone with no wallet app cannot.

- **Bundler** (`VITE_CREATON_BUNDLER_URL`): an ERC-4337 bundler for EntryPoint 0.7 (`eth_sendUserOperation`,
  `eth_getUserOperationReceipt`, `eth_getUserOperationByHash`). The account is Kernel 0.3.3.
- **Sponsor**: pays the network fee, so a new account needs no ether. It must speak `zd_sponsorUserOperation`.
- **Both addresses end up in the page every visitor downloads**, so neither may hold a key, a password or a token (the app and
  the build refuse an address that does). Put each behind a small proxy of yours that adds its key. This repository ships no such
  proxy; its tests use a stand-in.
- The server has a daily limit built in, in front of your sponsor: set `BUZZ_SPONSOR_UPSTREAM_URL` to the real sponsor's
  address (in `.env`, never in the build), and point `VITE_CREATON_SPONSOR_URL` at `https://<your host>/sponsor`, which carries no
  key. Limits (all optional): `BUZZ_SPONSOR_PER_ACCOUNT_PER_DAY` (10), `BUZZ_SPONSOR_TOTAL_PER_DAY` (1,000),
  `BUZZ_SPONSOR_PER_IP_PER_DAY` (40), `BUZZ_SPONSOR_EXIT_PER_IP_PER_DAY` (200). A way out (taking money out) is never refused by
  the per-account or server limit. The sponsor needs the chain reader (step 4); the server refuses to start with one and not the
  other. Fund the sponsor's paymaster with test ether and set its own spending cap there as well.

## 8. Build settings for the app

These are read **when the app is built** and are public in the page. In `.env`:

| Setting | Meaning |
|---|---|
| `CREATON_DEPLOYMENTS_FILE` | Path from `deploy/compose` to the file from step 2, for example `../../contracts/pot/deployments/pot-11155111.json`. `run.sh` takes the three values below from it. |
| `VITE_CREATON_CHAIN_ID`, `VITE_CREATON_LAUNCHER`, `VITE_CREATON_DOLLAR` | The chain, the Launcher and the play dollar. Set by hand instead of the file, or to override it (a value set by hand wins). The build refuses one of the first two without the other. |
| `VITE_CREATON_RPC_URL` | The page's node ("What you need before you start"): called from every visitor's browser, so it must be a read-only node with a request limit. `run.sh build` asks it which network it is on and whether the Launcher has code, and stops if not. |
| `VITE_CREATON_EARLIER_CONTRACT`, `VITE_CREATON_EARLIER_TEXT_HASH`, `VITE_CREATON_EARLIER_TEXT_URL` | The earlier backers' claim page (step 2b): the claim contract's address, the same text fingerprint the deploy was given, and an http or https address where a person can read that text (no name or password in it). **All three, or the page does not exist**: without them `/earlier-grant` is a plain "not found" and none of its code loads. `deploy/compose/run.sh`, `compose.creaton.yml` and the Dockerfile pass these three on (one list, held together by `web/src/features/launchpad/lib/deploy-env-image.test.mjs`), so `.env` reaches the build; the build does not check them beyond the app's own rule, which fails closed (a wrong or half-set value means no claim page and no message). A person is sent their own link, `<app>/earlier-grant#<their row>`, by whoever holds the list; the part after the `#` is never sent to any server. |
| `VITE_CREATON_PASSKEY_ACCOUNT=1`, `VITE_CREATON_BUNDLER_URL`, `VITE_CREATON_SPONSOR_URL` | Phone accounts (step 7). The switch needs the chain, the page's node and the bundler. The sponsor address is optional (the fee is then asked at the bundler). |

With none of these the app is built with no network and shows no money screens, whatever the server says.

Then:

```bash
./run.sh build        # checks the settings, asks the page's node, then builds creaton-relay:local (the relay, with the app inside it)
```

`build` refuses before Docker starts on a half-set network, a malformed address, a key in an address, a phone-account switch
without its bundler, and any `VITE_*` value still holding `CHANGE_ME`. The image's own build checks the same again and then
checks its output: the page, its manifest, the service worker, and the Launcher inside the code. The old web app
(`web/`) is not built into this image; `CREATON_IMAGE_TARGET=runtime` builds it instead.

## 9. Alerts away from the app (optional)

Needs the chain reader (step 4) and https (step 11). Make your own key and put your own contact beside it
(`docs/web-push-deployment.md` has the command and what is stored about a device): `BUZZ_WEB_PUSH_VAPID_PRIVATE_KEY` (43
characters; a secret that stays in `.env`) and `BUZZ_WEB_PUSH_SUBJECT` (`mailto:<your address>`). Both or neither. Without them
there are no alerts and the app shows none.

## 10. The terms and the privacy note

People see both at sign-up, with the box "I am 18 years of age or older" (`BUZZ_AGE_ATTESTATION_REQUIRED`, on by default; leave it
on unless counsel says otherwise). They must be **your** finished text, reviewed by your own counsel, before anyone outside your
team is invited. Say in them that **the money contracts are new and have not been audited**, beside the code hashes you published
from step 2b: the app's money sheets say the same sentence on their own, but the terms are where a person is asked to accept it. `docs/policies/` has drafts to start from; they are drafts, not advice. Put your copies in
`deploy/compose/policies/` and set `BUZZ_TERMS_FILE` and `BUZZ_PRIVACY_FILE` to their paths. The app shows the text word for word;
nothing in it is hidden or reworded.

`run.sh` refuses (for `start`, `restart`, `upgrade` and the other commands that run the server):

- a file that is named but not there;
- a file that still has a draft's `[placeholders]` or a stray bracket (it lists each line);
- a file with no `Last updated: <date>` line, or with no date on it;
- a file whose text changed under the same date, and a file with no stamp or a new date with no new stamp. Once the approved text
  is in and its `Last updated` date is right, run `./run.sh policy-stamp`.

If neither file is set, `start` still works and prints a red warning every time: that is for a private test only. Do not invite
anyone to a public test network with either missing.

## 11. https and the host name

Passkeys and alerts work only over https. `BUZZ_COMPOSE_TLS=true` (already in `.env.creaton.example`) puts Caddy in front with a
certificate for `BUZZ_DOMAIN`; `start` refuses a published relay port beside it.

## 12. Start

```bash
./run.sh start
```

Then follow the rest of `deploy/compose/README.md`, "First start", from step 7 (sign in as the owner on your own device), the
backup key (step 9) and the first backup (step 10).

## 13. What to check after the start

1. `./run.sh status` shows every service healthy. `curl -fsS https://<host>/health` answers `ok`.
2. `curl -fsS https://<host>/info` (it is the server's information document). It says `"investing": true`, and, when you set
   them, `"webPush": {"publicKey": ...}` and `"smartAccountLinks": true`.
3. `./run.sh logs relay` has the line `chain reader started` (with the reader's name, `11155111:<the Launcher>`) and, with a helper
   key, `chain helper on` with the helper's address. A line saying the node refused a range means `BUZZ_CHAIN_LOG_RANGE` is too
   large for it. A message at start that names a setting is a half-set group: fix it and `./run.sh restart`.
   The "Paid" check on a task paid out of the allowance box (the server looks for that payment on the network before it saves it) only works where this chain reader is on; with no reader the server cannot check and saves the payment as the team wrote it.
4. The app's files: `curl -sI https://<host>/sw.js` answers 200 with a JavaScript type; `https://<host>/assets/manifest.webmanifest`
   answers 200; a page that is not a file, `https://<host>/welcome`, answers the app's page (not a 404).
5. In a phone's browser, open `https://<host>`: sign-up shows your terms and privacy note and the age box; once signed in the
   banner "You can take your money out any time. Nothing here promises a profit." is on every page.
6. With a founder account: start a project and launch it (one wallet signature, or one passkey prompt). Open its link from
   another account that is signed out: the page shows the name and the numbers the server signed.
7. With a second account: get play dollars (the faucet), Back, and a minute later see the Shares and the pot move on the page
   (the server reads the block after `BUZZ_CHAIN_CONFIRMATIONS`). Take out and see the money come back. Each step is one press
   and one signature.
8. `./run.sh backup`, and practise the restore on another machine before you rely on it.

## 14. Changing something later

| You changed | You do |
|---|---|
| Anything built into the page (`VITE_CREATON_*`, the network) | `./run.sh build`, then `./run.sh restart`. `restart` alone keeps serving the old page. |
| Anything the server reads (`BUZZ_CHAIN_*`, `BUZZ_INVESTING`, the helper, the sponsor, push, the policies) | `./run.sh restart`. No rebuild. |
| A new deploy of the contracts | A new Launcher means a new network for the app: step 8 again (a new build), step 4 for the server, and the old projects stay on the old Launcher. |
| The code | `./run.sh upgrade` (it backs up first, then builds and restarts). Read the row below first if the code carries new migrations. |
| New migrations in the code | They apply themselves when the server starts. One case stops it: this repository renumbers its migrations from time to time (when upstream is merged in), and a database migrated before a renumbering fails on the moved file ("relation ... already exists"). If the server stops that way after an upgrade, restore the pre-upgrade backup (below), ask whoever built the image which migrations moved, and let them reconcile the database before starting again. A fresh database never hits this. |

**Going back after a bad change.** `./run.sh upgrade` and `./run.sh backup` leave you a backup to go back to; a bad upgrade is
undone by restoring it: `AGE_IDENTITY_FILE=<the key file> ./run.sh restore backups/<the newest>.tar.age --yes` stops the server,
restores and starts it again (do this on the machine the backup was made on, or follow `deploy/compose/README.md`'s restore on a
new one). A wrong contract deploy is not undone: the contracts have no owner and no upgrade. Say so before invitations go out —
the only move is a new deploy (step 2), the app and the server pointed at it (the table's second-to-last row), and every project
of the old one staying where it is. Nothing here rolls a chain back, and nothing here should ever need to.

## 15. Watching the server

The one-time checks of step 13 say the server started well; they say nothing about the day after. Keep three things watched:

1. **It is up.** `deploy/compose/README.md`'s "Uptime check" and "Logs" sections say what to point at this server and what to
   look for in `./run.sh logs relay`. `/health` answering `ok` is the smallest check that counts.
2. **The helper is fed and working.** Step 5: its balance, `chain_helper_jobs.last_error` and the `buzz_chain_helper_failed_total`
   counter. A run of failures is either a bad job or an empty key, and both stop the fee collection and the settles.
3. **The chain reader is keeping up.** `./run.sh logs relay` with no "refused a range" lines, and the numbers on a project page
   being as fresh as the record promises (the page says "Numbers as of" when they are older). The metrics endpoint
   (`BUZZ_METRICS_PORT`, 9102 by default) is there for whatever you already watch with.

## What was proven here, and what was not

- The app's build stage was proven by running the same commands outside Docker, in a folder holding only what the Dockerfile
  copies: `pnpm install --frozen-lockfile --filter "@creaton/app..."`, then the stage's own checks and `pnpm -C app build` (type check,
  Vite build, the bundle budget), with no settings, with a whole set of settings for a local chain, and with each refused
  combination. The output had `index.html`, `sw.js` and `assets/manifest.webmanifest`, and the Launcher inside the code when one
  was named.
- **The Docker image itself was not built here** (there was no Docker daemon, and no room for one). The `COPY` paths were read one
  by one against the tree. Build it once on your server (`./run.sh build`) before you rely on it.
- `deploy/compose/test-app-settings.sh` checks `run.sh`'s part with stand-ins for Docker and the node.
- Nothing was deployed to Sepolia from here, and no bundler, sponsor or push service was used outside tests.
