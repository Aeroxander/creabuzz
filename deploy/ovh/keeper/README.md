# The settlement keeper (Sepolia trial)

A weekly sale round closes by the clock. Anyone may settle it for two days after it closes; if nobody does, the round goes
void and everyone takes back what they put in, so the trial week is wasted. A browser cannot settle while nobody has the
page open, so on the server a small timer does it: every 30 minutes it reads the market and, only if a round has closed
and is not settled yet, sends the one `settle` transaction. The contract lets anyone send it, so the key behind the timer
has no power over orders, prices or who may trade. It pays the network fee and nothing else.

What it is: `scripts/secondary-keeper.sh` (bash plus Foundry's `cast`) run once per pass by a systemd timer, **on the
server itself, outside the Creaton image** (the image has no `cast`, and the keeper must not see the server's `.env`).

- **One timer per market.** Every project has its own market, so every new trial project needs its own timer
  (`install.sh enable <market>`, below). Projects started on the 5 Nov kit have no market.
- **Settle only.** `KEEPER_OPEN=0`: it never opens the week's round. Opening stays a deliberate act (a person presses
  "Open this week's round"), because an opened round with stale terms can burn a week and costs gas for a round that may
  get no orders. To let one market's timer open rounds as well, see "Opening rounds" at the end.
- **Gas only.** A settle has measured at most 3.6 million gas. At Sepolia's usual price that is a fraction of a cent of
  real money, and it is test money anyway. Keep about 0.05 Sepolia ETH on the key.

## What you do (the owner), in order

You need a computer with Foundry (`cast`) on it: <https://book.getfoundry.sh/getting-started/installation>. The key never
touches the server in the clear and never goes in chat, in this repository or in any file you commit.

### 1. Make a throwaway key, on your own computer

```bash
cast wallet new
```

It prints an address and a private key. Write the **address** down. Keep the private key on your screen only until the next
command, then close the window. This key is for the keeper alone: it must never own Shares, a project or anything else.

```bash
cast wallet import keeper --interactive
```

Paste the private key when asked (nothing is shown), then choose a password and type it twice. Cast writes an encrypted
file, `~/.foundry/keystores/keeper`. That file is what goes to the server, and it is useless without the password.

### 2. Fund it

Send about 0.05 Sepolia ETH to the address from step 1: a Sepolia faucet (the Google Cloud Web3 faucet, or a proof-of-work
faucet) or your own test wallet. It holds nothing else, so there is nothing to protect beyond that.

### 3. Install the program on the server

On the server, from the checkout (the deploy copies it to `/srv/creaton`):

```bash
cd /srv/creaton
sudo deploy/ovh/keeper/install.sh
```

It downloads `cast` 1.4.3 from the official Foundry release (the version this repository is pinned to) and refuses it
unless its checksum matches the one written in `install.sh`; installs the keeper script root-owned in
`/usr/local/lib/creaton-keeper/`; installs the service and timer units; and creates `/etc/creaton-keeper/` (root only)
with a settings file to fill in. It touches nothing of the Creaton stack, and it is safe to run again.

### 4. Put the keystore on the server

From your own computer:

```bash
scp ~/.foundry/keystores/keeper ubuntu@<server>:/tmp/keeper-keystore
```

On the server:

```bash
sudo install -m 0600 -o root -g root /tmp/keeper-keystore /etc/creaton-keeper/keystore.json
sudo shred -u /tmp/keeper-keystore
```

### 5. Give the server the password, sealed

Run this on the server and type the password when asked (it is not shown, and it is never on a command line):

```bash
sudo bash -c 'read -rsp "Keystore password: " p; echo; printf %s "$p" | systemd-creds encrypt --name=password - /etc/creaton-keeper/password.cred; unset p'
sudo chmod 0600 /etc/creaton-keeper/password.cred
```

systemd keeps the password sealed in that file and hands it to the keeper only while a pass runs, in a private in-memory
folder. **Honest limit:** this server has no hardware security chip (TPM), so the file is sealed with a key stored on the
same disk (`/var/lib/systemd/credential.secret`). Anyone who is already root on the machine can still open it. What it
protects against is a copied unit file, a stray backup or a pasted log. The real protection is that the key is a throwaway
holding a few cents of test gas.

If `systemd-creds` is not wanted: put the password in `/etc/creaton-keeper/password` (root, mode 0600; `printf %s` it, no
newline needed) and install with `sudo deploy/ovh/keeper/install.sh --plain-password`. The unit then reads that file
instead. Same limit, one less tool.

### 6. Tell it which node to use

```bash
sudo nano /etc/creaton-keeper/keeper.env
```

Replace `CHANGE_ME_SEPOLIA_NODE_URL` with a Sepolia node address (`https://...`). It can be the same provider as the
server's `BUZZ_EVM_RPC_URL`, ideally with a key of its own and a request limit. `cast` is given the address on its command
line, so other people who can sign in to this machine could see it in the process list: only you should be able to.

### 7. Rehearse, sending nothing

Each project has its own market. The scripted launch (`LaunchV5TrialProject.s.sol`) prints `market:`. For any project, list
the markets the market factory has made, newest last (the factory address is `VITE_SECONDARY_MARKET_FACTORY`, the block is
`VITE_HISTORY_FROM_BLOCKS`; the second address on each line is the market):

```bash
cast logs --from-block <that block> --address <market-factory> \
  'MarketCreated(address indexed dao, address indexed market, address indexed sharesToken, address policy, address quote, uint256 lotSize)' \
  --rpc-url "$NODE"
```

or, with the project's DAO address: `cast call <market-factory> 'marketOf(address)(address)' <dao> --rpc-url "$NODE"`.

Then:

```bash
sudo deploy/ovh/keeper/install.sh dry-run <market>
```

That starts the real unit with `KEEPER_DRY_RUN=1` inside the same sandbox as the real thing, so it proves the credentials load
and the node answers; it says what it would settle and sends nothing. Working looks like a log line
`secondary-keeper: dry run: would send settle(round N)` when a round has closed, or no lines at all when there is nothing to
do, and then `the dry run passed`.

To prove the key and the password too, run one real pass (it sends something only if a closed, unsettled round exists, which
is exactly its job):

```bash
sudo systemctl start creaton-keeper@<market>.service
sudo journalctl -u creaton-keeper@<market>.service -n 20 --no-pager -o cat
```

A wrong keystore, password or key stops the pass at once with `the keeper key could not be read`.

### 8. Switch it on

```bash
sudo deploy/ovh/keeper/install.sh enable <market>
```

Do this for every trial project's market, once, when the project starts. Check any time with
`deploy/ovh/keeper/install.sh status`.

## Watching it

There is no alert path yet; deciding where alerts go is the owner's call. Until then, look at the timers once a day while
a round is live:

```bash
deploy/ovh/keeper/install.sh status          # timers, anything failed, and the last log lines
systemctl --failed                           # a keeper pass that was refused shows here, red
journalctl -u 'creaton-keeper@*' --since '2 days ago' --no-pager
```

A pass **fails** (the unit turns red) when a transaction was refused for a real reason (the key has no gas, the node is
down) or the market could not be read; exit code 1 or 2 in `scripts/secondary-keeper.sh`. A pass that finds a round already
settled by someone else, or a round not yet closed, is **not** a failure. Refill the key and the next pass settles; a round
is only lost if it stays unsettled two days after it closes.

Note the keeper files are not in `./run.sh backup` (it saves `.env`, policies and data). If the machine is rebuilt, make a
new key (steps 1 to 5); there is nothing worth recovering.

## Opening rounds (optional, not the default)

Opening each week's round stays a person's action. If you decide the keeper should open them too for one market, add a
drop-in for that market only:

```bash
sudo systemctl edit creaton-keeper@<market>.service
```

and put in it:

```ini
[Service]
Environment=KEEPER_OPEN=1
```

(`systemctl edit` writes `/etc/systemd/system/creaton-keeper@<market>.service.d/override.conf`). Settings in
`/etc/creaton-keeper/keeper.env` win over the unit's own, so a `KEEPER_OPEN=1` line there turns it on for every market at
once; leave it out. Opening spends your gas on a round that may get no orders.

## Switching it off

```bash
sudo systemctl disable --now creaton-keeper@<market>.timer
```

To remove everything: disable each timer, delete `/etc/systemd/system/creaton-keeper*`, `/etc/creaton-keeper/` and
`/usr/local/lib/creaton-keeper/`, then `sudo systemctl daemon-reload`.

## What was and was not checked

Checked in this repository, without a server (`deploy/ovh/keeper/test.sh`): `install.sh` stages every file with the right
modes and is safe to run twice; the units are settle-only, take the key and password as credentials and put nothing secret
on a command line; `systemd-analyze verify` (systemd 255) accepts the units and knows every option; the real keeper script,
run with exactly the unit's environment against a stand-in `cast`, says what it would settle and sends nothing.
`scripts/secondary-keeper-test.sh` and `scripts/secondary-keeper-e2e.sh` (a real local chain) still pass.

**Not checked** (needs the server): that the unit's sandbox lets `cast` resolve the node's name (the `RestrictAddressFamilies`
and `SystemCallFilter` lines are the first to loosen if the dry run cannot reach the node); `systemd-creds encrypt` without a
TPM on Ubuntu 24.04 (it should create its host key on first use; if it complains, run `sudo systemd-creds setup` once, or
use `--plain-password`); the `cast` download from this machine; the gas of `openRound`, which the repository has not
measured (watch the first one if you switch opening on).
