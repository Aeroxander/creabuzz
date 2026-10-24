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

For a public VPS with automatic Let's Encrypt certificates:

```bash
cd deploy/compose
BUZZ_COMPOSE_TLS=true ./run.sh start
```

The bootstrap script should eventually replace manual `.env` editing for normal
users. It is responsible for generating stable secrets and, optionally, an owner
keypair.

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
- Contributor projects need the addresses `scripts/sepolia-deploy.sh --broadcast` prints (`docs/sepolia-testnet.md`).
  Without them the server is the social app alone. Changing them means `./run.sh build` and `./run.sh restart`: they
  are read when the app is built.
- The server turns on read state (`BUZZ_V1_ENABLED`, unread markers) and the app's page routes (`BUZZ_WEB_SPA=full`),
  and shows the terms and privacy note named by `BUZZ_TERMS_FILE` and `BUZZ_PRIVACY_FILE` at sign-up. `run.sh` refuses
  a policy file that still has a draft's `[placeholders]`.
- Building takes a machine with several GB of memory and about 15 GB of disk for Docker (Rust's release build). A small
  server can load an image built elsewhere instead: `docker save creaton-relay:local | ssh <host> docker load`, built
  for the server's architecture (`docker build --platform linux/amd64 ...` from an Apple silicon Mac is slow but works).
- `./run.sh upgrade` on a Creaton stack backs up first, then pulls the other images, builds and restarts.

## Backups

```bash
./run.sh backup                      # into backups/<UTC time>/ while the server runs
./run.sh verify-backup backups/<dir> # checks every file against the backup's manifest
./run.sh restore backups/<dir> --yes # stops the server, restores, starts it, waits until it is ready
```

A backup is one folder: `postgres.dump` (the whole database), `media/` (the bucket's objects), `git.tar.gz` (the git
data), `env` (this `.env`), `policies/` (the policy files, if set), `about.txt` (when, which image and revision, the
database migration, how many events) and `MANIFEST.sha256`. The database is dumped first, so the media and git copies
taken after it hold everything it refers to. Redis is not backed up (presence, rate windows and caches only); a restore
empties it.

- **Copy each backup off the machine**, and keep it where only the operator can read it: it holds every secret in
  `.env` and every message that is not end-to-end encrypted. Nothing here schedules backups or deletes old ones; a
  cron line such as `0 3 * * * cd /srv/creaton/deploy/compose && ./run.sh backup >>backups/backup.log 2>&1` and a
  retention you state in the privacy note do that.
- **Restore on a new machine:** check out the same revision, `cp backups/<dir>/env .env` (and change what differs on
  this machine), `./run.sh build`, then `./run.sh restore backups/<dir> --yes`. Restore refuses when `.env` has a
  different `BUZZ_RELAY_PRIVATE_KEY` from the backup's: the server would come back as a different server.
- **Practise a restore** before you rely on the backups, and after upgrades that change the database: a backup that has
  never been restored is a hope, not a backup.

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
