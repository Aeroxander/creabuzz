# Takedowns and data requests

For whoever runs a Creaton server on the bundled compose stack (`deploy/compose/README.md`). It covers what the app
cannot do for you: taking a post's pictures off the server, illegal content, and a person who asks to see or delete
what the server holds about them. Every command runs in `deploy/compose`.

Three facts shape all of it:

- **Removing a post hides it; it does not delete it.** A moderator's **Remove** takes the post off every screen and
  tells its author, but the server keeps the row, marked removed, for appeals and the moderation log.
- **Pictures are separate files, and removing a post leaves them.** Each one is stored once, by its hash, in the media
  store, and anyone with its address (`https://<host>/media/<hash>.<ext>`) can still open it. The server has no way to
  delete a file; `./run.sh remove-media` does it in the store directly.
- **Backups hold everything until they are pruned** (`./run.sh prune-backups DAYS`, README "Backups"). Nothing below
  reaches into an existing backup.

## Taking down a post and its pictures

1. **Remove it in the app.** Board post or reply: **Moderate** → **Remove post…** (or **Remove reply…**). Room
   message: **Remove message**. Do this first: it works at once, for everyone.
2. **Find its pictures.** The post's id is in its link (`…/b/<board>?post=<id>`); a picture's hash is the 64 characters
   after `/media/` in its address. To list every picture in a post:

   ```bash
   ./run.sh psql -At -v id=<post id> <<'SQL'
   SELECT DISTINCT m[1] FROM events e, regexp_matches(e.content || ' ' || e.tags::text, '/media/([0-9a-f]{64})', 'g') AS m
    WHERE e.id = decode(:'id', 'hex');
   SQL
   ```

   No link? Find a removed post by its words:
   `SELECT encode(id, 'hex'), created_at, left(content, 80) FROM events WHERE content ILIKE '%<words>%' AND deleted_at IS NOT NULL ORDER BY created_at DESC LIMIT 20;`
3. **Delete each picture:** `./run.sh remove-media <hash>` lists the file, its thumbnail and its records (and prints
   who uploaded it, when upload records are on); `./run.sh remove-media <hash> --yes` deletes them. A file is stored
   once per hash, so this removes it everywhere it was used, a profile picture included. People who already opened it
   may still have it in their browser.

That is enough for an ordinary takedown (spam, abuse, a picture someone wants gone). The removed text stays in the
database, visible to nobody but you.

## Illegal content

Remove it in the app first (step 1 above), so nobody else sees it. Then, in this order:

1. **Preserve** what an authority will ask for, in a folder only you can read, outside `backups/` and outside the git
   checkout:

   ```bash
   mkdir -p ~/takedowns && chmod 700 ~/takedowns
   ./run.sh psql -At -v id=<post id> >~/takedowns/<date>-post.json <<'SQL'
   SELECT row_to_json(e) FROM (SELECT encode(id, 'hex') AS id, encode(pubkey, 'hex') AS pubkey, kind, created_at,
          received_at, community_id, channel_id, tags, content, encode(sig, 'hex') AS sig, deleted_at
     FROM events WHERE id = decode(:'id', 'hex')) e;
   SELECT row_to_json(r) FROM moderation_reports r WHERE target_event_id = decode(:'id', 'hex');
   SQL
   ./run.sh remove-media <hash> >~/takedowns/<date>-media.txt   # what is stored, and who uploaded it
   ```

   That keeps who posted it, when, where and what it said, without the picture. **For child sexual abuse material, do
   not download, copy or keep the picture, and look at it no more than you must**: in many countries holding a copy
   is a crime even for the person running the server. Keep only what the hotline or the police tell you to.
2. **Report it**, as the law where you run the server requires. Child sexual abuse material goes to the national
   hotline (inhope.org lists them) or the police; in the United States, providers must report it to NCMEC's
   CyberTipline. Write down the date and any reference number in `~/takedowns`.
3. **Purge it** from the server: `./run.sh remove-media <hash> --yes` for each picture, then the post itself:

   ```bash
   ./run.sh psql -v id=<post id> <<'SQL'
   DELETE FROM events WHERE id = decode(:'id', 'hex');
   VACUUM events;
   SQL
   ```

   If it was posted on purpose, ban the account too (**Moderate** → **Ban … from the community…**, or
   `./run.sh remove-member <public key>` to take them off the server).
4. **Backups:** the ones taken before the purge still hold it, until `prune-backups` deletes them. Where the law or the
   authority wants it gone sooner, delete those backup folders here and every copy off the machine, then take a new
   backup at once (`./run.sh backup`), so a restore point still exists.

## A person asks to see or delete their data

**Check it is them.** Ask for the request from inside the app (a message to you from their account), or ask them to
post a word you give them. An email alone does not prove the account is theirs. Then find their public key (64
characters, lowercase) from their name:

```bash
./run.sh psql -At -c "SELECT encode(pubkey, 'hex'), display_name FROM users WHERE display_name ILIKE '%<name>%';"
```

### To see it

```bash
WHO=<their public key>
./run.sh psql -At -v who="$WHO" >"data-$WHO.ndjson" <<'SQL'
SELECT row_to_json(e) FROM (SELECT encode(id, 'hex') AS id, kind, created_at, community_id, channel_id, tags, content,
       deleted_at FROM events WHERE pubkey = decode(:'who', 'hex') ORDER BY created_at) e;
SELECT row_to_json(u) FROM users u WHERE pubkey = decode(:'who', 'hex');
SELECT row_to_json(m) FROM relay_members m WHERE pubkey = :'who';
SELECT row_to_json(w) FROM evm_identities w WHERE pubkey = :'who';
SELECT row_to_json(a) FROM join_policy_acceptances a WHERE pubkey = :'who';
SELECT row_to_json(r) FROM moderation_reports r WHERE reporter_pubkey = decode(:'who', 'hex');
SQL
```

That is everything they wrote (posts, messages, their profile, records of work they submitted, removed posts too), their
membership, the wallet addresses linked to them, when they accepted the terms, and the reports they made. Send the file
to them privately, then delete your copy. Pictures they posted are listed by hash in their posts; send those files too
if they ask.

### To delete it

1. **List their pictures first**, while their posts still say which ones:

   ```bash
   ./run.sh psql -At -v who="$WHO" <<'SQL'
   SELECT DISTINCT m[1] FROM events e, regexp_matches(e.content || ' ' || e.tags::text, '/media/([0-9a-f]{64})', 'g') AS m
    WHERE e.pubkey = decode(:'who', 'hex');
   SQL
   ```

2. **Take them off the server:** People and access → **Remove**, or `./run.sh remove-member "$WHO"`.
3. **Delete what they wrote**, in one transaction (if any line fails, nothing is deleted):

   ```bash
   ./run.sh psql -v ON_ERROR_STOP=1 -v who="$WHO" <<'SQL'
   BEGIN;
   DELETE FROM events WHERE pubkey = decode(:'who', 'hex');
   DELETE FROM reactions WHERE pubkey = decode(:'who', 'hex');
   DELETE FROM channel_members WHERE pubkey = decode(:'who', 'hex');
   DELETE FROM personal_read_accounts WHERE actor = decode(:'who', 'hex');
   DELETE FROM evm_identities WHERE pubkey = :'who';
   DELETE FROM subscriptions WHERE owner_pubkey = decode(:'who', 'hex');
   DELETE FROM users WHERE pubkey = decode(:'who', 'hex');
   COMMIT;
   VACUUM events;
   SQL
   ```

4. **Delete their pictures:** `./run.sh remove-media <hash> --yes` for each hash from step 1. A picture someone else
   also posted is the same file, so check before you delete one that is not plainly theirs.
5. **Tell them what stays, and when it goes:** backups until they are pruned (say the date); the moderation log and
   reports about them (kept so moderation can be checked and bans hold); anything on the chain (contributions, awards
   and votes on a project are public records there, and nobody can delete them); and what other people quoted or saved.
   Reply counts on other people's threads may read one or two high where their replies were.

Answer within the time your privacy note promises, and keep a line in `~/takedowns` saying what you did and when.
