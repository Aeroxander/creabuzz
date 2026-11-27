# Buzz Docker Compose deployment

This is the single-node/VPS deployment bundle. It is intentionally separate from
the root `docker-compose.yml`, which remains local development infrastructure.

## Quick start

```bash
cd deploy/compose
cp .env.example .env
$EDITOR .env       # replace every CHANGE_ME value
./run.sh start
```

For a public VPS with automatic Let's Encrypt certificates, set
`BUZZ_COMPOSE_TLS=true` in `.env` (every command then includes Caddy), or for
one command:

```bash
cd deploy/compose
BUZZ_COMPOSE_TLS=true ./run.sh start
```

There is no bootstrap script yet. "First start" under Creaton below says how to
make each secret and the owner key.

## Production notes

- Requires Docker Compose v2.24.4 or newer; the TLS override uses Compose's
  `!reset` tag to remove the direct relay port when Caddy terminates HTTPS.
- Default `BUZZ_IMAGE` tracks `ghcr.io/block/buzz:main` for early testing. Pin it to `ghcr.io/block/buzz:sha-<7>` or a semver release tag for production once available.
- Keep `BUZZ_RELAY_PRIVATE_KEY`, `BUZZ_GIT_HOOK_HMAC_SECRET`, database/Redis,
  and S3 secrets stable across restarts.
- `RELAY_OWNER_PUBKEY` is intentionally not prefixed with `BUZZ_`; it must be a
  64-character hex Nostr pubkey when closed relay mode is enabled.
- `BUZZ_AUTO_MIGRATE` is opt-in. Set `BUZZ_AUTO_MIGRATE=true` or run
  `buzz-admin migrate` before starting the relay when bootstrapping a fresh
  database. Auto-migration requires an image that includes embedded SQLx
  migrations.
- The stack uses Postgres, Redis, MinIO, and a git data volume because
  those are real Buzz dependencies today. Minimal mode can simplify this later.
- Mobile push remains off by default. To use the public gateway, keep the
  template's explicit `BUZZ_PUSH_GATEWAY_DELIVERY_URL` and set
  `BUZZ_PUSH_ENABLED=true`. To use another gateway, replace the exact HTTPS
  `/v1/deliveries/apns` URL before enabling push.
- The bundled Compose stack fixes the relay endpoint to `http://minio:9000` and
  `BUZZ_S3_ADDRESSING_STYLE=path`: Docker DNS resolves `minio`, not
  `<bucket>.minio`. It is not configurable for an external S3 provider through
  `.env`; use the Helm chart or a custom Compose configuration for providers
  such as new Railway Storage Buckets that require `virtual` addressing.

Run `./run.sh backup-hint` for the backup checklist.

Bundled object storage uses [Silo](https://silo.pgsty.com/download/), a maintained
MinIO fork, with matching `pgsty/silo` and `pgsty/mc` release images pinned by
multi-platform digest. Both images allow anonymous pulls and support Linux
amd64 and arm64; the upstream Quay MinIO images no longer allow anonymous pulls.
The existing `minio` names and `MINIO_*` settings remain compatible. Keep the
Helm and Compose pins aligned when upgrading, and run Buzz's
[object-store conformance probe](../../docs/git-on-object-storage.md#conformance-admitting-a-backend-for-a3)
against the new release before deploying it.

For an existing MinIO data volume, follow Silo's
[migration guide](https://silo.pgsty.com/compatibility/migration/) and take a
backup before upgrading. Replacing the container image upgrades the storage
server as well as changing its registry.

## Creaton

The upstream image (`ghcr.io/block/buzz`) serves Buzz: it has neither the Creaton app nor Creaton's database
migrations. A Creaton server builds its own image from this checkout, through `compose.creaton.yml`. The image carries
the phone-first app (`app/`, built by the Dockerfile's `app-builder` stage into target `runtime-creaton`, which is also
the default target `runtime`). To put the app on a public test network (Sepolia), follow
[docs/next-version/DEPLOY-TEST-NETWORK.md](../../docs/next-version/DEPLOY-TEST-NETWORK.md), step by step.

```bash
cd deploy/compose
cat .env.example .env.creaton.example > .env
$EDITOR .env               # every CHANGE_ME; the Creaton part says what each setting does
./run.sh build             # builds creaton-relay:local (the relay, the Creaton app inside it)
./run.sh start             # BUZZ_COMPOSE_CREATON=true in .env adds compose.creaton.yml to every command
```

- The app's network settings (`VITE_CREATON_*` in `.env.creaton.example`) are read when the app is built and are public in
  the page. With none of them the app shows no money screens, and the server's own switch (`BUZZ_INVESTING`, off unless
  `.env` says `true`) must be on as well before anyone sees one. `./run.sh build` checks them before Docker starts (a
  Launcher without its chain, a phone-account switch without its bundler, a key in an address, a `CHANGE_ME`), asks the
  page's node (`VITE_CREATON_RPC_URL`) which network it is on and whether the Launcher has code (15 seconds at most each),
  and prints what the app will offer. The image's own build checks the same settings again, then checks its output (the page,
  its manifest, the service worker, and the Launcher inside the code). `CREATON_DEPLOYMENTS_FILE` names the file the deploy
  script wrote, and `run.sh` takes the chain id, Launcher and dollar from it; a value set by hand wins. Changing any
  `VITE_*` setting means `./run.sh build` and then `./run.sh restart`: they are read when the app is built, and `restart`
  alone keeps serving the old page.
- The server has no admin API or admin bundle (`./run.sh reports` lists the reports passed on to the owner).
- Any `VITE_*` value still holding `CHANGE_ME` stops the build. The server's secrets may still be `CHANGE_ME` at a first
  build; `start` refuses those.
- The server turns on the app's page routes (`BUZZ_WEB_SPA=full`), and shows the terms and privacy note named by `BUZZ_TERMS_FILE` and `BUZZ_PRIVACY_FILE` at sign-up. `run.sh` refuses
  a policy file that still has a draft's `[placeholders]`.
  It also shows the "I am 18 years of age or older" box at sign-up (`BUZZ_AGE_ATTESTATION_REQUIRED=true` in the Creaton
  part of `.env`; `compose.creaton.yml` turns it on even when `.env` leaves it out). Set it to `false` only if counsel
  says the box is not needed; `scripts/test-compose-age-box.sh` checks the default.
- It also raises the per-person request limit (`BUZZ_RATE_LIMIT_HUMAN_WS_EVENTS_PER_SEC`, default 40;
  `BUZZ_RATE_LIMIT_HUMAN_MESSAGES_PER_MIN`, default 300): the web app's reads count against it, and one person may have
  two tabs open. Someone over it is told to wait a few seconds. `HOSTED=1 SOCIAL_FRAME_REPORT=1
  scripts/web-social-e2e.sh` runs the social suite under these values and prints the busiest five seconds it saw.
- Building takes a machine with several GB of memory and about 15 GB of disk for Docker (Rust's release build). A small
  server can load an image built elsewhere instead: `docker save creaton-relay:local | ssh <host> docker load`, built
  for the server's architecture (`docker build --platform linux/amd64 ...` from an Apple silicon Mac is slow but works).
- `./run.sh upgrade` on a Creaton stack backs up first, then pulls the other images, builds and restarts. Caddy is
  pinned to one version (`compose.caddy.yml`); moving to a newer one is an edit there, then `./run.sh upgrade`.
- Agents signing in for a member (`BUZZ_ALLOW_NIP_OA_AUTH`) are off in the Creaton part of `.env`: the web app never
  signs in that way, and the pilot runs no agents. Turn it on only when you run command-line or hosted agents here.
- **Escalated reports** (the ones a community's moderators pass on to you): `./run.sh reports` lists them, newest
  first, from the database; `./run.sh reports --all` lists every report. The server has no admin API, so this command is the
  only place they are listed. Check `./run.sh reports` every morning and evening of a pilot run, and act on each in the
  web app the same day.
- **The owner's pilot commands** (read the database, change nothing; `.env` must be filled in, as for `reports`):
  - `./run.sh due` lists the founders whose last weekly update is 7 or more days old (`--days N` changes the 7), with
    the day of it and how many days late: the list to message by hand. A project with no update yet counts from the day
    it began.
  - `./run.sh founders` is one row per founder's project: weekly updates, how many weeks of the project's life had one,
    when the second and third came (and "after late flag" when it was over 7 days after the one before, which is when
    the project was on `due`), promises kept, missed, changed and never answered, help requests and offers, tasks made and
    accepted. Under it, the totals the pilot's one question needs: how many founders posted a second and a third update,
    and how many of those were after a late flag. `--csv` prints the table alone, for [PILOT-REPORT.md](../../docs/v3-review/PILOT-REPORT.md).
  - `./run.sh daily` is the one list for each morning and evening of a pilot: `due`, what happened in the last 24 hours
    (projects started, weekly updates, offers) and the reports passed on to you. A part that cannot be read is said, the
    rest still prints, and the command exits non-zero, so a failed part never looks like an empty one.
  - Your own project is left out of every number: the keys in `RELAY_OWNER_PUBKEY` and `RELAY_OPERATOR_PUBKEYS`, and
    any (comma-separated, 64-character hex) in `BUZZ_PILOT_EXCLUDE` in `.env`. Set that one when Creaton's own project
    was started from an account that is not the owner's. Records are counted as the web app counts them (weekly updates
    by the founder's own records, deleted ones ignored); a task counts as accepted when its helper handed work in and the
    founder or a listed team member confirmed it and nobody on the team sent it back, which is the app's rule less its
    edge cases: the project's page decides in a dispute. `scripts/test-pilot-commands.sh` checks every number against
    records it seeds.
- Taking down a post and its pictures, illegal content, and a person's request to see or delete their data:
  [docs/operator-takedown-and-data-requests.md](../../docs/operator-takedown-and-data-requests.md).

### AI helpers (optional, no rebuild)

The AI work check, the check-note draft and the newcomer interviewer call the server's own `/llm/chat/completions`, which
forwards to an OpenAI-compatible provider you choose and keeps the key on the server. Without the first line below the
buttons stay hidden. Put these in the server's part of `.env` (not the `VITE_` part), then `./run.sh restart`:

```
BUZZ_LLM_PROXY_URL=https://<your provider>/v1/chat/completions
BUZZ_LLM_API_KEY=<the provider's key>
BUZZ_LLM_MODEL=<the model name to use>
```

Set `BUZZ_LLM_MODEL`: the hosted web app sends no model name, so this one is used. Each call costs the owner money: set a
spending cap at the provider too. The server also caps its own use so a busy day cannot run up the bill: each account
gets `BUZZ_LLM_MAX_CALLS_PER_DAY` calls a day (default 500), and the whole community gets `BUZZ_LLM_MAX_CALLS_PER_DAY_TOTAL`
(default 2000); both reset at midnight UTC. When a cap is reached the person sees a plain sentence saying what ran out and
when it comes back, and can still write the text themselves. Other optional limits (`BUZZ_LLM_RATE_PER_MIN`, default 20;
`BUZZ_LLM_MAX_TOKENS`, 4096) and the price lines for budgets that carry a cost limit are described in the repository's root
`.env.example`. The key sits in `.env` in plain text and is inside the encrypted backup: keep `.env` mode 0600 and treat the
key as one you can replace.

### Link previews

A project's link (`/p/<project>-<founder>` and `/launchpad/<project>`) shows the project's name, pitch and main goal, with
the Creaton card as the image, when it is pasted into a chat app. The server writes these into the page itself, so nothing
needs setting: the image is served from the web bundle (`/assets/share-card.png`) and the proxy only has to pass the
`Host` and `X-Forwarded-Proto` headers, which Caddy does. A preview shows only what a signed-out visitor could already read:
on a server where people must be members to read (invite-only) the link shows the plain Creaton page, unless public
records are on (next section); and so does a project that is removed, not listed, or whose founder is muted or banned.
A preview carries a project's own words and never a price.

### Public project records on an invite-only server

`BUZZ_PUBLIC_PROJECT_READS=true` in `.env` (it is on in `.env.creaton.example`) lets anyone read a public project's
record while everything else stays for members. Someone with no invite who opens a project's link (`/p/<project>-<founder>`
or `/launchpad/<project>`) sees that project's goal, its weekly updates, which promises were kept and missed, and the work
that was accepted, read only, with one line saying that taking part needs an invite and a Sign in button. The same link
shows a real preview in a chat app. It covers only projects the preview rule above allows (listed, not removed, founder not
muted or banned); a project that states the terms of a sale is public like any other. Such a visitor cannot browse: they
need the link. While a project is not covered (for example for as long as its founder is muted), a visitor to its link
is told "You need an invite to open this project", the same as for a project that is not there; the server does not say
why, and members see the project as before.

What the server gives someone with no invite is a fixed list, checked record by record on the server, not only what the
page happens to show:

- The project's own record, whole. Besides the name, pitch and picture it holds the account ids of the team and, for a
  project that has them, its chain addresses and, when it states them, the terms of a sale (a price floor or price step,
  an amount to raise, a monthly budget, Shares that unlock at a multiple of the price, or a sale's address). Anyone who
  asks the server directly gets the record as the founder signed it, so nothing can be left out of it. The page shows only
  the name, picture and goal, and a link's preview never carries a price. (Until this change a project that stated the
  terms of a sale was not given to someone with no invite at all; a launchpad that hides its launches is not one.)
- The founder's goals and promises with their answers, and the updates the founder or the team posted.
- For work the team accepted and nobody on the team sent back: the task, the work handed in (its words, links and files)
  and the confirmation.

Everything else stays for members: work handed in that is still waiting or was sent back, and the reasons given; asks for
more time; offers of help and the replies to them, asks to join; check notes; every record about on-chain work (submitted evidence,
reviewers' reasons, agreements, work areas, challenges); rooms, boards, direct messages, profiles, Home and every list;
and posting anything. Records signed by someone muted or banned are left out.

It opens records only on a server whose operator made the whole server invite-only (`BUZZ_REQUIRE_RELAY_MEMBERSHIP=true`,
as the bundle's `.env.example` does), and there it covers every community the server hosts: it is one setting for the
server, not one per community. A
community that chose invite-only for itself is not opened by this setting: its owner decided who reads there, and has no
way yet to choose public records.

To turn it off, set `BUZZ_PUBLIC_PROJECT_READS=false` (or delete the line) and run `./run.sh restart`. No rebuild is
needed. A visitor with no invite is then told "You need an invite to open this project", and previews go back to the plain
page.

Limits, so a crowd of strangers cannot slow the server for members:

- A project's public record is read from the database once in `BUZZ_PUBLIC_PROJECT_READS_CACHE_SECS` (default 30; 0 keeps
  nothing) and every visitor is answered from that copy. A link many people open costs one read. The price: a new update,
  a mute, a ban or a removal reaches visitors up to that many seconds later.
- Only those database reads count against the budget all visitors share, `BUZZ_PUBLIC_PROJECT_READS_PER_MIN` (default
  300). When it is spent, a project read in the last 5 minutes is still answered from the older copy; any other gets "This
  project's record can't be opened right now" with Try again, not the invite sentence.
- One address may make `BUZZ_PUBLIC_PROJECT_READS_PER_ADDRESS_MIN` (default 120) public reads a minute, counted before the
  shared budget, so one machine cannot spend it for everyone. The address is the last entry of `X-Forwarded-For`, which
  the bundled Caddy writes. Behind a different proxy, make sure it sets that header itself and does not pass on what the
  client sent; with no such header only the shared budget applies.

`BUZZ_EXAMPLE_PROJECT=<what follows /p/ in the project's shared address>` names the server's own example project. With
it, someone with no account who lands on Home is offered "See a record", which opens that project's public record. Set it
once Creaton's own project exists and run `./run.sh restart`. The server offers it only while a visitor could open that
project (so not when public records are off on an invite-only server, and not when the project is removed or not listed);
unset, the button is not shown to them. The server refuses to start on a value that is not such an address.

### First start

On the server, with the host name's DNS pointing at it and ports 80 and 443 open:

1. `cat .env.example .env.creaton.example > .env`. The Creaton part already has `BUZZ_COMPOSE_TLS=true` (HTTPS through
   Caddy; passkeys need it).
2. Make each secret once and paste it over its `CHANGE_ME` line. They must not change later:

   ```bash
   echo "BUZZ_RELAY_PRIVATE_KEY=$(openssl rand -hex 32)"
   echo "BUZZ_GIT_HOOK_HMAC_SECRET=$(openssl rand -hex 32)"
   echo "POSTGRES_PASSWORD=$(openssl rand -hex 32)"
   echo "REDIS_PASSWORD=$(openssl rand -hex 32)"
   echo "BUZZ_S3_ACCESS_KEY=$(openssl rand -hex 10)"   # 20 and 40 characters: the sizes
   echo "BUZZ_S3_SECRET_KEY=$(openssl rand -hex 20)"   # scripts/test-compose-backup.sh runs the media store with
   ```

3. Put the host name in place of `CHANGE_ME_HOST` in `BUZZ_DOMAIN`, `RELAY_URL` (`wss://<host>`),
   `BUZZ_MEDIA_BASE_URL` (`https://<host>/media`), `BUZZ_MEDIA_SERVER_DOMAIN` (`<host>`) and `BUZZ_CORS_ORIGINS`
   (`https://<host>`). `start` refuses while any of them still says `CHANGE_ME_HOST`, or `buzz.example.com` (an older
   example's host). The three `BUZZ_EVM_*` lines (a Sepolia node) are commented out in `.env.creaton.example`: leave them
   so for the founders' pilot, which needs no chain (docs/v3-review/PILOT-RUNBOOK.md, "Pilot A"), and uncomment them,
   with a node in `BUZZ_EVM_RPC_URL`, only for contributor projects or for phone accounts on a test network.
4. `mkdir -p policies && cp ../../docs/policies/TERMS-DRAFT.md policies/terms.md && cp
   ../../docs/policies/PRIVACY-DRAFT.md policies/privacy.md`, fill in every `[placeholder]` (the privacy note's log
   and backup periods should match "Logs" and "Backups" below), and set `BUZZ_TERMS_FILE=policies/terms.md` and
   `BUZZ_PRIVACY_FILE=policies/privacy.md`. The filled-in files are git-ignored: they hold your name and address.
   Once the lawyer-approved text is in and each file's `Last updated` line has its date, run `./run.sh policy-stamp`.
   After that `start` and `upgrade` refuse a file whose text changed without a new `Last updated` date (change the
   date, then run `policy-stamp` again); the stamps sit in `policies/.stamps/` and `./run.sh backup` keeps them.
5. `./run.sh build`. It needs only `.env` to exist, so it runs before the owner key is in.
6. Make the owner key with the image you just built:

   ```bash
   docker run --rm --entrypoint buzz-admin creaton-relay:local generate-key   # or the name in CREATON_IMAGE
   ```

   Put the `Public key` in `RELAY_OWNER_PUBKEY`. Keep the `Secret key` offline, in a password manager, not in `.env` or
   anywhere on the server: whoever has it owns the server. (Ignore the line about `BUZZ_PRIVATE_KEY`: that is for the
   command-line tool.)
7. `./run.sh start`, then open `https://<host>`, choose **Sign up**, then **I already have an account**, and paste the
   secret key (the 64 characters). You are signed in as the owner; give the account a name. Do this on your own
   device: the browser keeps the account.
8. Invite people one at a time: in the community's sidebar, **People** opens People and access. **Make invite link**
   with "One person", and send each person their own link. Nobody gets in without one.
9. Make the backup key, on your own computer, not on the server. Backups are encrypted to a public key, so the server
   holds only the public half and a nightly backup needs no secret there:

   ```bash
   age-keygen -o creaton-backup.key   # brew install age (Mac); sudo apt-get install -y age (Ubuntu)
   ```

   It prints `Public key: age1...`. Put that line's key in `.env` as `BUZZ_BACKUP_AGE_RECIPIENT=age1...`. Keep
   `creaton-backup.key` in your password manager and never copy it to the server: with it, whoever holds a backup can
   read every secret and private message in it, and without it a backup cannot be opened by anyone. Keep a second copy
   somewhere safe too (a lost key means lost backups). The server needs the `age` program: `sudo apt-get install -y age`
   (cloud-init in `deploy/ovh/` installs it). `./run.sh backup` (and `upgrade`, which backs up first) refuses until the
   key is set; `start` and `restart` do not need it.
10. `./run.sh backup`, and practise a restore on another machine (below), with the private key, before inviting anyone.

## Backups

Backups are encrypted at rest with [age](https://age-encryption.org), to a public key: `BUZZ_BACKUP_AGE_RECIPIENT` in
`.env` (First start, step 9). The server holds only that public key, so a backup it made (or a copy of one that leaks)
cannot be opened without the private key, which lives on your own computer.

```bash
./run.sh backup                                  # backups/<UTC time>.tar.age and .sha256, while the server runs
./run.sh verify-backup backups/<time>.tar.age    # checks the file against its sidecar hash; needs no key
AGE_IDENTITY_FILE=~/creaton-backup.key ./run.sh verify-backup backups/<time>.tar.age   # also opens it, checks the manifest
AGE_IDENTITY_FILE=~/creaton-backup.key ./run.sh restore backups/<time>.tar.age --yes   # stops the server, restores, starts it
```

`backup` builds one folder, checks it against its manifest, packs it into `backups/<UTC time>.tar.age`, writes the
sidecar `backups/<UTC time>.sha256`, and removes the folder. If the backup fails or is stopped (an error, Ctrl-C, a TERM
from cron) before the encrypted file exists, it removes the unfinished folder too, because the folder holds every secret
in `.env`. The media files come from a container that runs as root, so if the operator cannot delete the folder the
script removes it through a root container; if that fails as well it prints the folder's name, tells you to delete it
(`sudo rm -rf <folder>`) and exits with an error, so cron sees a failure. A power cut or `kill -9` cannot run that cleanup. After a failed night, look in `backups/` for a
plain dated folder and delete it. The folder holds `postgres.dump` (the whole
database), `media/` (the bucket's objects), `git.tar.gz` (the git data), `env` (this `.env`), `policies/` (the policy
files, if set), `about.txt` (when, which image and revision, the database migration, how many events) and
`MANIFEST.sha256`. The database is dumped first, so the media and git copies taken after it hold everything it refers
to. Redis is not backed up (presence, rate windows and caches only); a restore empties it. The sidecar holds the
`.tar.age`'s hash (so `verify-backup` can tell a damaged or changed copy without the key) and the hash of the
`MANIFEST.sha256` packed inside (which `verify-backup` and `restore` check after decrypting). Nothing on the server can
decrypt a backup, so there is no trial decrypt there: the check that a backup opens is `verify-backup` with the key,
on your own computer, and the rehearsal below.

- **The key.** Without `BUZZ_BACKUP_AGE_RECIPIENT` (or while it still says `CHANGE_ME`), `backup` and `upgrade` refuse and
  say how to make it. `BUZZ_BACKUP_ALLOW_UNENCRYPTED=true` in `.env` or the shell makes a plain folder instead, for a
  local test or rehearsal only; the command says the backup is not encrypted. Plain folders made earlier still verify and
  restore (`verify-backup backups/<dir>`, `restore backups/<dir> --yes`). `restore` of a `.tar.age` decrypts into a
  temporary folder under `$TMPDIR` (or `/tmp`; it needs room for the backup's size) and removes it when it ends, also
  when it fails.
- **Copy each backup off the machine**: both files, the `.tar.age` and its `.sha256`. Encrypted, a copy is safe to keep in
  a bucket; the key must be kept elsewhere. Backups still hold every secret in `.env` and every message that is not
  end-to-end encrypted, so only whoever has the private key can read them. `backups/` is git-ignored, so a backup is
  never committed by accident.
- **Schedule them, and delete old ones.** The privacy note says how long backups are kept; `./run.sh prune-backups
  DAYS` deletes the `backups/<UTC time>` folders and `.tar.age` files (with their sidecars) older than that. A cron line
  that does both, every night:

  ```cron
  0 3 * * * cd /srv/creaton/deploy/compose && ./run.sh backup >>backups/backup.log 2>&1 && ./run.sh prune-backups 14 >>backups/backup.log 2>&1
  ```

  Copies kept off the machine need the same: delete them on the same schedule.
- **Restore on a new machine:** check out the same revision, unpack the backup in an empty folder with your key
  (`age -d -i creaton-backup.key <file>.tar.age | tar -xf -`), `cp <folder>/env .env` (and change what differs on this
  machine), `./run.sh build`, then `AGE_IDENTITY_FILE=<the key file> ./run.sh restore <file>.tar.age --yes`. Restore
  refuses when `.env` has a different `BUZZ_RELAY_PRIVATE_KEY` from the backup's: the server would come back as a
  different server.
- **Practise a restore** before you rely on the backups, and after upgrades that change the database: a backup that has
  never been restored is a hope, not a backup. Use your real backup, copied off the machine, on a second machine, and
  check what came back (posts, pictures, policies, the server's identity, members, git data) before writing new data:
  the steps and checks are in
  [docs/v3-review/RESTORE-REHEARSAL.md](../../docs/v3-review/RESTORE-REHEARSAL.md).
  `scripts/test-compose-backup.sh` is separate, automated coverage: it builds a scratch stack of its own, backs it up
  (as a plain folder) and restores it. It never reads your backup, so running it anywhere says nothing about your
  server's backups. `scripts/test-compose-backup-encryption.sh` covers the encrypted form with a stand-in `docker`
  (it needs the `age` program, not Docker).

## Uptime check (from outside, with an alert on your phone)

Nothing on the server tells you when the server is down: the error reports come from people's
browsers and need people. Set up one external monitor before inviting anyone, from a service that checks from outside your
network and sends push notifications to your phone (for example UptimeRobot's free plan: HTTPS checks every 5 minutes, a
phone app with push alerts; check the plan's current limits yourself). The two checks below cost nothing and say different
things:

| Check | URL | Passes when | What a failure means |
|---|---|---|---|
| The server answers | `https://<host>/health` | status 200 and the text `ok` | The relay process, Caddy, the certificate or the machine is down. (`/health` answers for the process alone: it does not touch Postgres, Redis or the media store.) |
| The server can read its database | `https://<host>/info` | status 200 and the keyword `access` in the body | The relay is up but its database is not: `/info` carries the community's `access` setting (`invite_only` here) only when it could be read from Postgres. This is the check to trust for "can people sign in". |

Set both to alert after **two** failed checks in a row (a single dropped check is not an outage), with the alert going to
your phone's push notifications and, as a second route, your email. Then **test the alert once**, without taking the
server down: add a third monitor on `https://<host>/health-test` (a page that does not exist, so it fails), wait for the
phone to buzz, then delete the monitor. An alert that was never tested is not an alert.

Also in the monitor: a certificate-expiry warning if it offers one (Caddy renews by itself; a failed renewal is quiet
until the day the certificate ends). When an alert comes: `./run.sh status` for what is up, `./run.sh logs` for why, and
`./run.sh restart` for a relay that is wedged. What the monitor cannot see is a slow server or a server that answers
but refuses people; `./run.sh daily` and the error reports are for those.

## Logs

Every service keeps at most 5 log files of 10 MB (`x-logging` in `compose.yml`) and drops the oldest first. Docker
limits logs by size, not by age, and the relay's request log (`tower_http=info` in `RUST_LOG`) has a line for every
page and API call. So on a quiet server 50 MB can hold more than the privacy note's period. To keep that period true,
recreate the relay on it (`./run.sh restart` does, with a few seconds offline, and that empties its log), for example
weekly:

```cron
0 4 * * 0 cd /srv/creaton/deploy/compose && ./run.sh restart >/dev/null 2>&1
```

or turn the request log down (`tower_http=warn`) and state the period by size.

## Validation

Before sharing an install link publicly, verify a fresh install with:

```bash
cd deploy/compose
cp .env.example .env
$EDITOR .env
./run.sh config
./run.sh start
curl -fsS "http://127.0.0.1:$(grep -E '^BUZZ_HTTP_PORT=' .env | cut -d= -f2-)/_liveness"
./run.sh status
```

With `BUZZ_COMPOSE_TLS=true` the relay's port is not published; check `curl -fsS https://<host>/_liveness` instead.
