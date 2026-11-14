# Creaton on one OVHcloud server

One Ubuntu 24.04 machine runs everything (relay and web app, Postgres, Redis, media, git data, Caddy) through the
`deploy/compose` bundle. Start there for what each setting means: [../compose/README.md](../compose/README.md), section
"Creaton". This folder only gets you a prepared machine.

## 1. The machine

OVHcloud Public Cloud, US-East (Virginia), flavor **b3-16** (4 vCPU, 16 GB, 100 GB; about $0.12 an hour, about $88 a
month), image Ubuntu 24.04, hourly billing. The size fits the Rust build as well as the running stack; b3-8 runs the
stack but builds slowly.

Create it with `cloud-init.yaml` as the instance's user data (replace `GITHUB_USER` first). It installs Docker and
Compose, allows only SSH, HTTP and HTTPS through the firewall, turns off password sign-in, adds 4 GB of swap, applies
security updates on its own, and writes `/var/lib/creaton-bootstrap/done` when finished (a few minutes after first
boot). Sign in as `ubuntu` with the key you listed.

## 2. The name

Point the host name's DNS (an A record) at the server's public address, and wait until `dig +short <host>` shows it.
Caddy fetches the certificate on the first start and needs ports 80 and 443 reachable.

## 3. Deploy

From your own machine (the code is private, so it is copied rather than cloned):

```bash
rsync -az --delete --exclude node_modules --exclude target --exclude .git ./ ubuntu@<server>:/srv/creaton/
ssh ubuntu@<server>
cd /srv/creaton/deploy/compose
```

Then follow "First start" in [../compose/README.md](../compose/README.md#first-start), steps 1 to 10. The ones people
miss:

- The build needs the ZeroDev project id, the chain node URL and the contract addresses in `.env` (the build lists
  what is missing). Run it once the contracts are deployed to Sepolia (`docs/sepolia-testnet.md`).
- Keep the owner's secret key off the server. Only its public key goes in `.env`.
- `policies/terms.md` and `policies/privacy.md` come from your lawyer; the server refuses draft placeholders.

## 4. The weekly-sale trial (optional)

For a Sepolia trial of the weekly sale of Shares on this same machine (`docs/sepolia-testnet.md`, "Trading"; the trial script
is `docs/v3-review/SEPOLIA-TRADING-TRIAL.md`). Trading is off unless the trial block below is set. The real pilot wants
neither of these:

- **The trial block in `deploy/compose/.env`.** After `scripts/sepolia-deploy-v5.sh --broadcast`, paste the lines it prints
  (`VITE_SECONDARY_MARKET_FACTORY`, `VITE_TRADING_TRIAL=1`, `VITE_TEST_QUOTE_TOKENS`, the new kit, work bounty and payouts
  factory, and the 5 Nov addresses it reuses; `.env.creaton.example` shows the shape), then `./run.sh build` (it must print
  `Trading: on`) and `./run.sh restart`. A half-set block stops the build. The image stays contributor-only.
- **The settlement keeper**, a systemd timer on the host, outside the Docker stack, with its own throwaway key:
  [keeper/README.md](keeper/README.md). One timer per project's market; settle only.

**Before real pilot people are invited**, remove the trial block lines, rebuild (it must print `Trading: off`), restart, and
switch the keeper timers off (`docs/sepolia-testnet.md`, "Trading", section 7). Keep the trial and the pilot out of each
other's way: never push a trial image under the pilot's name.

The optional AI helpers also live on this machine (`deploy/compose/README.md`, "AI helpers"): three lines in `.env` and a
`./run.sh restart`, no rebuild.

## 5. Backups

Backups are encrypted to a public key, so the server can make them every night and holds nothing that opens them. The
private key lives on your own computer (First start, step 9, makes it). The `age` program must be on the server:
cloud-init installs it, and a server made before that runs `sudo apt-get install -y age`.

Nightly, plus a copy that leaves the machine. (The keeper's key and password are not in these backups; if the machine is
rebuilt, make a new throwaway key.) On the server:

```cron
0 3 * * * cd /srv/creaton/deploy/compose && ./run.sh backup >>backups/backup.log 2>&1 && ./run.sh prune-backups 14 >>backups/backup.log 2>&1
```

Each night adds `backups/<UTC time>.tar.age` and its `.sha256` sidecar. Copy both somewhere else every day (an OVH
object-storage bucket, or `rsync` to another machine), and rehearse a restore on a second machine, with the private key,
before inviting anyone: [../../docs/v3-review/RESTORE-REHEARSAL.md](../../docs/v3-review/RESTORE-REHEARSAL.md).

## 6. Later

- Moving the database to a managed service, or the app to Kubernetes, is a change of `.env` and compose, not of the
  application; the single machine is the right start.
- A bigger machine is a resize in the OVH panel (a restart).
