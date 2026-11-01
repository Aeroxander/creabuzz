# Restore rehearsal: the real backup, on another machine

Written 2026-11-01 (outside review A 1.3, with the critique's correction 5). Not yet run: the hosted server does not
exist yet. Run it once before inviting anyone (PILOT-TEST-GUIDE.md step 6), and again after any upgrade that changes the
database. Write the date, the backup's folder name and every check's result in [PILOT-REPORT.md](PILOT-REPORT.md).

**What this proves, and what it does not.** `scripts/test-compose-backup.sh` stays as it is: separate, automated
coverage that backup, verify and restore work on a scratch stack it builds itself, with its own post, image and git
data. Running it on the rehearsal machine would prove nothing about your server: it never reads your backup. This
rehearsal is the other half: that **your** backup, copied off the machine, restores into a working server holding
**your** data. It does not check the source server itself (a backup can only hold what the source had when it was
taken), and passkeys are not part of it (they belong to the server's address; device recovery is its own hand test).

Commands below run in `deploy/compose` unless they say otherwise. `$PROD` is the pilot server's address
(`https://<host>`), `$REHEARSAL` the rehearsal machine's (`https://<rehearsal host>`).

## 0. Before: write down what the backup must bring back

On the pilot server, at a quiet moment, write down (in the report, not in the backup folder):

- three real posts: a Home post, a board post with a picture, a reply. Open each and note its address (the post id is
  the last part) and, for the picture, its address in the browser's network panel (the 64-character hash is the last
  part).
- the server's identity: `curl -fsS -H 'Accept: application/nostr+json' "$PROD/" | jq '{self, pubkey}'`.
- the policies: `curl -fsS "$PROD/api/join-policy"` (its version) and `curl -fsS "$PROD/api/join-policy/terms" >
  terms-prod.html`.
- who is in: `./run.sh list-members > members-prod.txt`, and who is banned or muted (People and access, or
  `buzz moderation restricted`).
- one repository's latest commit, if the pilot uses repositories (the repository page shows it).

Optional, scripted: a rehearsal marker. As a test member (a key made for this, kept in your password manager, invited
like anyone else), from the repository root:
`(cd web && node tests/deploy/backup-data.mjs seed "$PROD" <test member hex key>) > marker.json`. It puts one post and one
small picture on the server and prints what to look for afterwards. Delete the post afterwards if you like.

## 1. Take the backup and copy it off the machine

1. `./run.sh backup`. Note the folder it names (`backups/<UTC time>`) and the events count it prints.
2. `./run.sh verify-backup backups/<UTC time>` on the server: every file matches its manifest.
3. Copy the whole folder off the machine, to where you keep backups (`scp -r` or `rsync -a` over SSH; never through a
   chat or a shared drive: it holds every secret in `.env` and every private message).
4. On the copy, wherever it now is: `sha256sum MANIFEST.sha256` matches the server's, and, from a checkout of the same
   revision, `deploy/compose/run.sh verify-backup <copy>` passes. A copy that fails here is the finding: stop.

## 2. Restore it on another machine, with the deployment's own commands

On a second machine (a fresh VM is fine) with Docker:

1. Check out the revision in the backup's `about.txt` (`source_revision`).
2. `cd deploy/compose && cp <copy>/env .env`. Change only what differs on this machine: `BUZZ_DOMAIN`, `RELAY_URL`,
   `BUZZ_MEDIA_BASE_URL`, `BUZZ_MEDIA_SERVER_DOMAIN`, `BUZZ_CORS_ORIGINS` to the rehearsal host. Leave
   `BUZZ_RELAY_PRIVATE_KEY` and every password as they are.
3. Copy the policy files: `mkdir -p policies && cp <copy>/policies/* policies/`.
4. `./run.sh build`.
5. `./run.sh restore <copy> --yes`. It stops the server, puts back the database, media and git data, starts it and
   waits until it is ready. (It refuses a `.env` whose server key differs from the backup's: that would be a
   different server.)
6. `./run.sh status`: every service up.

Keep the rehearsal private: do not share its address. It holds every member's messages.

## 3. Check what came back

| Check | How | Passes when |
|---|---|---|
| The posts | `./run.sh psql -Atc "select count(*) from events"` | Equal to `events=` in the backup's `about.txt` (a few more in `about.txt` if people posted during the backup) |
| The three posts | Sign in on `$REHEARSAL` as the owner (Sign up, then I already have an account, the owner's secret key) and open each post by its id | Each is there, with its words and replies |
| The pictures | `(cd <copy>/media && find . -type f | wc -l)`, then the same count from the restored bucket: `docker compose --env-file .env -f compose.yml -f compose.creaton.yml run --rm --no-deps -T --entrypoint /bin/sh minio-init -c 'mc alias set local http://minio:9000 "$BUZZ_S3_ACCESS_KEY" "$BUZZ_S3_SECRET_KEY" >/dev/null && mc ls --recursive "local/$BUZZ_S3_BUCKET" | wc -l'` (add `-f compose.caddy.yml` if the server uses it) | The two counts match |
| A picture, served | With the marker: `(cd web && node tests/deploy/backup-data.mjs check "$REHEARSAL" <test member hex key> "$(cat marker.json)")` | "the post and the image are there, unchanged" |
| **Not a check** | Old pictures showing in the browser on `$REHEARSAL` | Posts name the pilot server's address, so the browser may load them from there. Look at the network panel: only a request to the rehearsal host counts |
| Identity | `curl -fsS -H 'Accept: application/nostr+json' "$REHEARSAL/" | jq '{self, pubkey}'` | Same as step 0 |
| The owner | Signed in with the owner's key, Moderation shows "Escalated reports" | It does: the server still knows its owner |
| The policies | `curl -fsS "$REHEARSAL/api/join-policy"` and `diff terms-prod.html <(curl -fsS "$REHEARSAL/api/join-policy/terms")` | Same version, no difference |
| Who is in | `./run.sh list-members | diff members-prod.txt -` | No difference |
| Bans and mutes | People and access, or `buzz moderation restricted` against the rehearsal | Same people as step 0 |
| Invite-only | A private window with no account, then a new account with no invite link | Turned away |
| Git data | `mkdir -p /tmp/git-backup && tar -xzf <copy>/git.tar.gz -C /tmp/git-backup && (cd /tmp/git-backup && find . -type f -exec sha256sum {} + | LC_ALL=C sort) | sha256sum`, then inside the restored server: `docker compose --env-file .env -f compose.yml -f compose.creaton.yml run --rm --no-deps -T --user 0 --entrypoint /bin/sh relay -c 'cd /data/git && find . -type f -exec sha256sum {} + | LC_ALL=C sort' | sha256sum` | The two sums match; and the repository from step 0 shows the same latest commit |

## 4. Write new data, then take it down

1. As the owner on `$REHEARSAL`: write a post with a picture, reply to an old one, and reload: both stay.
2. `./run.sh backup` on the rehearsal machine, then `./run.sh verify-backup` on that new folder: backups work there too.
3. Take it down: `./run.sh stop`, `docker compose --env-file .env -f compose.yml -f compose.creaton.yml down -v`, delete
   the rehearsal's `.env`, `backups/` and the copy (or keep the copy only where your other backups are kept, on the same
   deletion schedule), and the marker files.

A rehearsal that needed a step not written here is a finding: add the step to
[deploy/compose/README.md](../../deploy/compose/README.md) ("Backups").
