# Takedowns and data requests

For whoever runs a Creaton server on the bundled compose stack (`deploy/compose/README.md`). It covers what the app
cannot do for you: taking a post's pictures off the server, illegal content, a copyright counter-notice and putting
content back, requests from the police or a court, and a person who asks to see or delete what the server holds
about them. Every command runs in `deploy/compose`. This is a working guide for the operator, not legal advice: where
counsel must decide, the text says so in square brackets, and you ask counsel before you act on that point.

Three facts shape all of it:

- **Removing a post hides it; it does not delete it.** A moderator's **Remove** takes the post off every screen and
  tells its author, but the server keeps the row, marked removed, for appeals and the moderation log.
- **Pictures are separate files, and removing a post leaves them.** Each one is stored once, by its hash, in the media
  store, and anyone with its address (`https://<host>/media/<hash>.<ext>`) can still open it. The server has no way to
  delete a file; `./run.sh remove-media` does it in the store directly.
- **Backups hold everything until they are pruned** (`./run.sh prune-backups DAYS`, README "Backups"). Nothing below
  reaches into an existing backup. Backups are encrypted, which protects them from being read; it does not remove
  anything from them.

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
   "Do not keep a copy" means no local storage beyond what the report and the authorities require. It does not
   mean the report may leave the material out: the report to the hotline or to NCMEC itself transmits the material,
   it is required, and you send what they ask you to send (step 2). [Exactly what to send, what to keep afterwards
   and for how long, for the country where the server runs: counsel to confirm.]
2. **Report it**, as the law where you run the server requires. Child sexual abuse material goes to the national
   hotline (inhope.org lists them) or the police; in the United States, providers must report it to NCMEC's
   CyberTipline, and that report is what carries the material to NCMEC. Write down the date and any reference number
   in `~/takedowns` (see "Requests from the police, a court or another authority" for the folder and the log).
3. **Purge it** from the server, once the hotline or the police have it and have not asked you to hold anything:
   `./run.sh remove-media <hash> --yes` for each picture, then the post itself:

   ```bash
   ./run.sh psql -v id=<post id> <<'SQL'
   DELETE FROM events WHERE id = decode(:'id', 'hex');
   VACUUM events;
   SQL
   ```

   If it was posted on purpose, ban the account too (**Moderate** → **Ban … from the community…**, or
   `./run.sh remove-member <public key>` to take them off the server).

   `DELETE` and `VACUUM` are not a scrub; see "What deleting does not reach" below.
4. **Backups:** the ones taken before the purge still hold it, until `prune-backups` deletes them. Where the law or the
   authority wants it gone sooner, delete those backups (the `.tar.age` files and their `.sha256` sidecars) here and every copy off the machine, then take a new
   backup at once (`./run.sh backup`), so a restore point still exists.

## A copyright counter-notice, and putting content back

This is the operator's side of "Copyright claims" in `docs/policies/TERMS-DRAFT.md`. The terms promise four things:
a person whose content was removed because of a copyright notice can send a counter-notice to the same address; we
pass it to whoever complained; we wait a set time; and if the complainant has not told us they went to court in that
time, we may put the content back. Read that section before you act, and keep this one and the terms in step.

### What you can and cannot put back today

Check this before you promise anyone a put-back.

| What was done | Can it be undone? | How |
| --- | --- | --- |
| A ban | Yes | People and access → the banned list → **Lift ban**. The server records it in the moderation log but sends the person **no message**: tell them yourself. |
| A mute (timeout) | Yes | Lift it from the board's moderation panel, or end it early from People and access. The server refuses when it has already ended. |
| A person taken off the server (`remove-member`) | Yes, if their data is still there | `./run.sh add-member <public key>`. Anything you deleted with the purge steps below is gone. |
| A post, reply or message **Remove** | **Not with any command.** | Nothing in the app, `run.sh` or the admin tool clears the removed mark. The only tested route is a new post by the author (see below). |
| A picture deleted with `remove-media` | **No.** | The file, its thumbnail and its records are gone from the store. The person uploads it again; the terms already say so. |
| A post purged with `DELETE` | **No.** | Restoring a whole backup would bring it back and also undo everything since, so it is not a put-back tool. |

**Why there is no restore for a Remove.** A Remove marks the row removed and takes one off the reply count of the post
it answered and one off the thread's total (`crates/buzz-db/src/store/event.rs`, `soft_delete_event_and_update_thread`).
Nothing writes those counts back, and nothing clears the mark outside tests. Clearing the mark by hand in the
database would show the text again but leave the counts one or two low and say nothing to the author or to anyone
who already loaded the page. Nobody has tested that, so this guide does not offer it as a step. [Open code item: a
Restore action for a removed post that clears the mark, puts the counts back, writes the moderation log and tells
the author. Until it is built, a put-back of a post means the author posts it again, with a new time and without the
replies and votes on the old one. Owner to decide whether to build it before the pilot, and counsel whether the
terms may promise a put-back of a post at all. If it is not built, the terms sentence that says we may put the
content back needs to say the author may post it again.]

Because neither a removed post nor a deleted picture can be restored today, think before you run `remove-media` for a
copyright claim. [Whether to Remove the post first and delete the picture file only after the waiting window below,
or delete both on a valid notice: counsel to decide. The terms say pictures stay in the store until you remove them
by hand, and the commitment to take content down on a valid notice is counsel's.] Tell the person who posted it,
by hand, when you delete a picture: the app sends no message for that, and the terms mark this as not built yet.

### When a counter-notice arrives

1. **Open a case** in `~/takedowns` (folder and log: see the next section) of type `counter`, and file the counter-notice
   as received. Note which case holds the original notice.
2. **Check it has what the terms ask for:** what was removed and where it was; that the person believes in good faith it
   was removed by mistake; their name, address and email; and [the consent to a court's authority that a
   counter-notice must contain: counsel to set the wording]. Check it comes from the person who posted it, the
   same way as for a data request (a message from their account). If a part is missing, write back and say which. [Whether
   an incomplete counter-notice starts the waiting window: counsel to decide.]
3. **Pass it to the complainant** at the contact in their notice, and write the date and what you sent in the log. The
   terms tell the person this will happen. [What may be left out of the copy you pass on, such as a home address:
   counsel to decide.]
4. **Start the window and put the end date in your calendar and the log:** [10 to 14 business days, counsel to set].
   [Which day it starts from, and which days are business days: counsel to decide.] Leave the content as it is while it
   runs.
5. **If the complainant sends proof they went to court** ([what counts as proof: counsel to decide]), do not put anything back. Tell the person who posted it, and log the date.
6. **If the window ends and you have heard nothing,** the terms say we *may* put the content back. [Whether you will
   always put it back or may decline: counsel to decide.] Put it back with the table above: lift a ban or mute; ask
   the author to post the text again (and upload the picture again); `add-member` if they were taken off the server.
   Tell the person who posted it, and tell the complainant. Log both dates.
7. **Keep a ledger per account** in `~/takedowns/repeat-infringers.md`: one line for each valid notice, each counter-notice
   and its outcome, with the date. The server counts nothing for you. [How many valid notices close an account, and
   whether a successful counter-notice cancels one: counsel to choose; counsel's current lean is three valid notices,
   with a successful counter-notice cancelling one, which is not final.] Closing an account is a ban (see the table).

## Requests from the police, a court or another authority

A letter, email or call that says it comes from an authority and asks for data about a person, or for you to keep
it or hide it. Do not hand anything over on the first message. The aim is: only real legal process, only what it
compels, a written record, and the person told unless the order says you must not.

**Ask counsel first** when a request is unusual: it comes from another country, it asks for a great deal (a whole
server, every account in a project, backups, or any key or secret from `.env`), it says you must keep it secret, it
claims an emergency, or you are not sure it is real. [Counsel's name and contact for requests from authorities: owner
to fill.] Where the request is the ordinary kind below, you may do the steps yourself and tell counsel afterwards.
[Which kinds counsel wants to see before any reply: counsel to say.]

### 1. Log it the day it arrives

One folder per request, so each request is one file set. Names are `YYYY-MM-DD-<type>-<short name>`, where the date is
the day it arrived and `<type>` is one of `authority`, `preservation`, `copyright`, `counter`, `illegal`, `person` or
`other`:

```bash
mkdir -p ~/takedowns && chmod 700 ~/takedowns
CASE=~/takedowns/$(date -u +%F)-authority-<short name>      # e.g. 2027-03-04-authority-county-court
mkdir -m 700 "$CASE" "$CASE/request" "$CASE/response" "$CASE/data"
cp ../../docs/operator-takedown-log-template.md "$CASE/LOG.md"   # fill it in as you go
```

Put the request exactly as received in `request/` (the whole email with its headers, or a scan), what you sent in
`response/`, and any export in `data/`. Fill in `LOG.md`: one page, template in
`docs/operator-takedown-log-template.md`. Write to the log when you do each step, not afterwards. The folder is outside
`backups/` and outside the git checkout, so no backup or commit picks it up. That also means nothing backs it up:
keep a private copy of it in a place only you can reach. It holds personal data and sometimes an order not to disclose,
so share it with nobody but counsel. [How long to keep a closed case folder: counsel and owner to decide.]

### 2. Check that it is valid legal process

An email that says "please send us the details" is a request, not an order. You may be asked for more than the law
lets you give. Check, and write each answer in the log:

- **Who issued it.** A named court, prosecutor or agency, with an official address, a signature or stamp and a case or
  reference number. Find their switchboard or website yourself and ask them to confirm it; do not use the phone number
  or link in the message.
- **The legal basis.** What kind of document it is (a court order, warrant, subpoena or summons, a formal preservation
  letter, or only an informal request) and the law it relies on. Ask them to say so if it does not. An informal
  request is not an order: [whether and when to answer an informal request from police at all, and what for an
  emergency request: counsel to decide].
- **The scope.** Which person or account, which kinds of data, which dates. If it names a person by a name and not a
  public key, find the key first (see "A person asks to see or delete their data") and confirm with the authority that
  it is the same person.
- **The deadline, and how to answer.** Write the date in the log and your calendar. Ask for more time in writing if you
  need it.
- **Whether it reaches you.** Whether this authority has power over a server run from where you run it is not for you
  to judge. [Which requests from outside the country of the server to answer, and under what process: counsel to
  decide.]

If any answer is missing or unclear, write back and ask; say nothing about the person in that reply.

### 3. Answer with only what it compels

- Take the export commands under "To see it" below and narrow them to the person, the kinds of data and the dates the
  order names. Do not send the whole `data-<key>.ndjson`, other people's posts, or anything beyond the order. Leave out
  the security record and reports about the person unless the order names them; [whether to give those, and in what
  form: counsel to decide].
- If the server does not hold what they ask for, say so, and do not try to get it. For example, the server cannot read a
  message that is end-to-end encrypted. The privacy note says what the server holds; do not promise more than that.
- Never send backups, the contents of `.env`, the relay key or any password or private key, even if asked.
- Send it by a means the authority names that is also secure (not plain email with the data in the body). Record a
  `sha256sum` of each file you sent in the log, and keep the exact copy in `response/`.
- If an order seems too wide, tell counsel before the deadline and say nothing yet to the authority beyond asking for
  time. [Whether to object or ask the authority to narrow it: counsel to decide.]

### 4. Tell the person, unless the order forbids it

Tell the affected person what was asked, by whom, and what you gave, in the app from the operator's account (the
server has no tool for this; the log records that you did). Do it before you hand the data over where the deadline
allows, and otherwise as soon as you have. If the order forbids telling them, or you cannot tell whether it does, do
not tell them: write the order's wording and the date it stops (if it says) in the log, and ask counsel. When a ban on
telling ends, tell them then. [Whether to ask the authority for permission to notify, and whether to push back on a
gag order: counsel to decide.]

### 5. Preserve data when asked formally

A preservation request asks you to keep what you hold about a person or content for a period. It is not a request
to hand it over. Keep it for the period named, or until the authority releases it in writing. [How long to keep when
the request names no period: counsel to say.] Write each step in the log.

1. **Keep the rows.** Export them into the case folder as in "Illegal content" step 1, widened to the person's
   account (their posts including removed ones, their `users` row, and the moderation log and reports about them):

   ```bash
   WHO=<public key from the order>
   ./run.sh psql -At -v who="$WHO" >"$CASE/data/rows.ndjson" <<'SQL'
   SELECT row_to_json(e) FROM (SELECT encode(id, 'hex') AS id, kind, created_at, community_id, channel_id, tags, content,
          deleted_at FROM events WHERE pubkey = decode(:'who', 'hex') ORDER BY created_at) e;
   SELECT row_to_json(u) FROM users u WHERE pubkey = decode(:'who', 'hex');
   SELECT row_to_json(a) FROM moderation_actions a WHERE target_pubkey = decode(:'who', 'hex') OR actor_pubkey = decode(:'who', 'hex');
   SELECT row_to_json(r) FROM moderation_reports r WHERE target_pubkey = decode(:'who', 'hex') OR reporter_pubkey = decode(:'who', 'hex');
   SQL
   sha256sum "$CASE/data/rows.ndjson" >>"$CASE/LOG.md"
   ```

   Hold any pictures the same way: `./run.sh remove-media <hash>` (without `--yes`) lists the objects without
   deleting them. To keep the files themselves, ask counsel first; they may be material you must not copy.
2. **Stop deletions that would destroy it.** Do not run the purge steps, `remove-media --yes` or "To delete it" on
   that person or content while the hold lasts. If the person asks you to delete their data in that time, tell counsel
   before you answer. [What to say to a person who asks for deletion during a hold: counsel to decide.]
3. **Stop the prune job for the period.** If you scheduled `./run.sh prune-backups` from cron (README "Backups"), open
   `crontab -e` and remove or comment out only the `prune-backups` part of the line, keeping `./run.sh backup`, and
   write the date in the log. Do not run `prune-backups` by hand either. Put it back when the hold is released, and
   write that date in the log. Copies kept off the machine need the same pause.
4. **Hold the backups that matter.** Pruning only looks at items directly inside `backups/` (`prune_backups` in
   `run.sh`). Copy the backup files (the `.tar.age` and its `.sha256`) that cover the period into
   `$CASE/backups/` with `cp -p`, which keeps their age. You cannot read inside a backup on the server (the key is
   not there), so choose by the time in the file name. Hold the same files off the machine. A held backup also
   holds everyone else's data and the server's secrets; keep it as private as the key you decrypt it with.
5. **Logs roll away.** Server logs are kept by size, not by days. If the order names logs or a time they would cover,
   copy them now: `./run.sh logs relay >"$CASE/data/relay.log"` prints what is kept and then goes on following; stop it
   with Ctrl-C once it goes quiet. Do the same for other services (`caddy`) if they are named.

### 6. Close the loop

When you answer, write in `LOG.md` the date, what you sent (and its hash), who received it, whether and when the person
was told, and what is still held. Keep a copy of the authority's last message. When a hold is released, write the
release, put the prune job back, and then run any deletion you postponed.

## What deleting does not reach

A `DELETE` and a `VACUUM events` remove a row from the database as the app sees it. They do not scrub the server's
write-ahead log (the file Postgres keeps of recent changes, which is recycled on its own schedule), a replica if you
have added one, a copy on someone's computer, or any copy off the machine. Encrypted backups still hold deleted rows
until they age out under `prune-backups`, and so do the off-machine copies of them. When you tell someone a thing is
gone, say it is gone from the live server now and from backups on the date the last backup that held it is pruned.
[How and when a deletion is truly final where the law needs it, such as an order to erase: counsel to decide.]

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
   Say too that deleting here does not scrub the write-ahead log or any copy off the machine at once ("What deleting
   does not reach"). Check first that no preservation request or order covers this person ("Requests from the police,
   a court or another authority", step 5).

Answer within the time your privacy note promises, and keep a line in `~/takedowns` saying what you did and when.
