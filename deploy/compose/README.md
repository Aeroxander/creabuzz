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

The upstream image (`ghcr.io/block/buzz`) serves Buzz: it has neither the Creaton web app nor Creaton's database
migrations. A Creaton server builds its own image from this checkout, through `compose.creaton.yml`:

```bash
cd deploy/compose
cat .env.example .env.creaton.example > .env
$EDITOR .env               # every CHANGE_ME; the Creaton part says what each setting does
./run.sh build             # builds creaton-relay:local (the relay, the web app inside it)
./run.sh start             # BUZZ_COMPOSE_CREATON=true in .env adds compose.creaton.yml to every command
```

- The image's build prints what the web app will offer (network, chain node, contributor projects, sponsored gas,
  error reports) and stops on settings that do not fit together (`web/scripts/check-deploy-env.mjs`). The first release
  offers contributor projects only: the image takes no setting for test raises, nor the mainnet switch.
- Contributor-only is one build setting, `VITE_CONTRIBUTOR_ONLY=1`, which the repository's `Dockerfile` sets for this
  image. The web app reads it through `raisesOffered()` (`web/src/features/launchpad/lib/raises-offered.ts`), and it is
  the hosted MVP's switch for more than money: it also decides what Start, Discover, Your work and the side rails offer.
  Every other build (a developer's, the mocked browser suite, CI) leaves it off and offers raises
  (`docs/v3-review/STATUS.md`, "The hosted build").
- The image is contributor-only, and its people act from passkey accounts alone, so with contributor projects on the
  build stops unless the ZeroDev settings (`VITE_ZERODEV_PROJECT_ID`, a UUID, and `VITE_ZERODEV_CHAIN_ID`) are set. Any
  `VITE_*` value still holding `CHANGE_ME` stops it too: `./run.sh build` refuses before Docker starts, and the image's
  own check refuses again. The server's secrets may still be `CHANGE_ME` at a first build; `start` refuses those.
- Contributor projects need the addresses `scripts/sepolia-deploy.sh --broadcast` prints (`docs/sepolia-testnet.md`).
  Without them the server is the social app alone. With them, `./run.sh build` first asks `VITE_CHAIN_RPC_URL` which
  network it is on and for the contributor kit's history from `VITE_HISTORY_FROM_BLOCKS` (15 seconds at most each), and
  stops with the reason when it is on another network, does not answer, or refuses that history. A node that takes only
  a small range is allowed (the page reads in pages); the build says so, and section 3 of `docs/sepolia-testnet.md` says
  how to check that its range lasts. The image's own check then warns when `VITE_ERROR_REPORT_URL` is empty: the build
  goes on, but nobody is told when a step fails for people. Changing them, or any other `VITE_*` setting, means `./run.sh build`
  and then `./run.sh restart`: they are read when the app is built, and `restart` alone keeps serving the old page.
- The server turns on read state (`BUZZ_V1_ENABLED`, unread markers) and the app's page routes (`BUZZ_WEB_SPA=full`),
  and shows the terms and privacy note named by `BUZZ_TERMS_FILE` and `BUZZ_PRIVACY_FILE` at sign-up. `run.sh` refuses
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
  first, from the database; `./run.sh reports --all` lists every report. The web app's list (Moderation, "Escalated
  reports") needs `BUZZ_ADMIN_HOST`, a host name of its own for the admin API, which this HTTPS (Caddy) stack does not
  serve: it serves `BUZZ_DOMAIN` alone, so the admin API is never on the public host. Check `./run.sh reports` every
  morning and evening of a pilot run, and act on each in the web app the same day.
- Taking down a post and its pictures, illegal content, and a person's request to see or delete their data:
  [docs/operator-takedown-and-data-requests.md](../../docs/operator-takedown-and-data-requests.md).

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
   (`https://<host>`), and a Sepolia node in `BUZZ_EVM_RPC_URL`. `start` refuses while any of them still says
   `CHANGE_ME_HOST`, or `buzz.example.com` (an older example's host).
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
sidecar `backups/<UTC time>.sha256`, and only then removes the folder. The folder holds `postgres.dump` (the whole
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
