# The holder room and seasons: the records, the tags, the rules and the server's sentences

Status: normative for package P2 of `docs/next-version/STEP3-PLAN.md` (sections 4 and 5), written first so the app engineers
(A3: the room; A4: seasons) build from exact tags and exact sentences. Where this page and the plan differ, this page is what
the server does (each difference is listed in section 8). Nothing here changes a contract, a money rule or the legal line, and
nothing here is advice or a promise of any result for anyone. Posts and votes are public.

## 1. The room: which events, which tags

A room post is a **kind 1** note and a room like is a **kind 7** reaction, the events the app already writes, with two tags:

| Event | Tags besides the builder's own | Notes |
|---|---|---|
| Post (kind 1) | one `["a", "37001:<founder>:<id>"]`, one `["t", "room:<chain key>"]` | The chain key is the project record's `chain-key` tag: `0x` and 64 lower-case hex digits. Topic tags (`["t", "word"]`) may be added; none may start with `room:` |
| Reply (kind 1) | the NIP-10 `e` tags, the same `a`, the same `room:` tag | Every `e` tag must name a stored post of **this room** |
| Like (kind 7), repost (kind 6, 16), comment (kind 1111) | `e`, `p`, `k` as the builder writes, the same `a` and `room:` tag | |

**An event that answers a room post is a room event whatever tags it carries.** A kind 1, 6, 7, 16 or 1111 event whose `e` tags
name a stored event that carries a `room:` tag is a room event. It must carry the same `a` tag and the same `room:` tag as every
post it names, or it is refused with the sentence "a reply belongs in the same room as the post it answers". At most 256 `e`
tags are read on such an event; one with more is refused with the same sentence (a note that names 257 events is not a reply).
A room event with no room tag of its own that names a room post gets that sentence before any other; a room event whose tags
name more or fewer than one project and one room gets "a room post names its project and its room".
An event with no `room:` tag and no `e` tag that names a room post is not a room event and nothing here runs for it.

**Text only.** The tags `imeta`, `x`, `ox`, `image`, `thumb`, `url`, `m`, `dim`, `blurhash`, `size`, `file`, `video`, `audio`
and `media` are refused on a room event, and so is a body over 2,000 characters (the app's `MAX_POST_CHARS`). A like's body is
at most 64 characters. Plain text with a link in it is allowed and is only text on the screen.

**Reading the room.** One filter reads it, with the `#t` value exactly the tag the posts carry:
`{"kinds":[1,7], "#a":["37001:<founder>:<id>"], "#t":["room:<chain key>"]}`. Replies are read by the `#t` tag only, never by `#e`,
so an event that does not carry the tag never shows in a room.

## 2. Who may write: decided by the server from the network

For a room event the server runs these steps in this order; the first that fails refuses with its sentence (section 3).
**It never reads a person's word.** A tag, a profile or a post changes none of it.

1. **Shape.** Exactly one `a` tag naming a kind 37001 coordinate, exactly one `room:` tag, no media tag, the body within its
   bound, and every `e` tag naming a stored post of this room (above).
2. **The project.** The project record (kind 37001) the coordinate names: found, listed, not removed, its founder neither banned
   nor muted; its `chain-key` equals the `room:` tag's key; the chain reader has read the project's launch and the launch's
   `projectId` equals the hash of the coordinate. A server with no chain reader answers "rooms are not switched on".
3. **The signer's wallets.** The signer's kind 37017 records (at most 20 read), the newest per address, not revoked, the
   attestation not expired at the server's clock, and on the reader's chain (the record's `chain` tag, or the attestation's
   domain when the tag is absent). At most 8 wallets are used. None: the "link your wallet" sentence.
4. **Holding, above a floor.** Any of those wallets holds at least **0.001 of a Share** (`10^15` wei) in backer Shares or in Team
   Shares at the reader's last committed block (`BUZZ_CHAIN_CONFIRMATIONS` deep, 12 by default). The floor is in Shares, not
   dollars, so a fall in the Share's price never shuts a real holder out. It keeps a seat from costing one wei.
5. **A Team grant with something left to claim.** If none holds in hand: the project's newest signed numbers record
   (kind 39009, signed by the server, `d` = the chain key) is read, and a grant whose `member` is one of the wallets and whose
   **`claimable` is not `"0"`** counts as holding. (`vested` does not: it stays above zero for a member who claimed and left.)
   A grants list that was cut and does not list the wallet reads as "does not hold".
6. **Grace after taking out.** If none holds: the time of the newest decrease of any of those wallets' balances for the project
   (backer or Team Shares) is read. The write is allowed while `thatTime + unit > asOf`, where `unit` is the project's own time
   unit (the launch's `platform.unit`) and `asOf` is the newest block time the reader has stored (the chain's own clock). After
   that the person is read-only: "not holding". A person with no decrease on record who does not hold has never held, or backed
   after the reader's last block; both read "not holding", whose sentence says to wait a minute if they just backed.
7. **Not muted by the team.** The newest unexpired `room-mute` record for the signer's key, or for any account whose newest
   record lists a wallet the signer has bound (section 4), refuses the write.
8. **Not too fast, not too many voices.** At most **12 room posts an hour** and **60 room events a day** per account per room
   (kinds 1 and 1111 are posts; every room event counts toward the day), and at most **5 accounts may write in a room through one
   wallet** (the number of live bindings of the wallet that matched at step 4).

Global bans, mutes and timeouts of the whole server apply before all of this, unchanged.

**What the rule reads and how fresh.** Holding comes from the reader's committed balances (the final block); a person who backed a
few seconds ago is "not holding yet" until the reader stores their Back. While the reader lags the rule keeps deciding from the
rows it has: a holder in those rows is never shut out by lag, and a leaver's grace is measured on the chain's own clock, which
does not move while the reader lags, so a lag lengthens it and never shortens it. The rule is **never lenient**. A lookup that
fails (a database error) refuses the write as a server fault; it never lets one pass.

## 3. The server's sentences (the app maps each by its tail; the prefix is the relay's)

| Where | Sentence |
|---|---|
| no chain reader | `restricted: rooms are not switched on on this server` |
| project not found, not listed or removed | `invalid: this project is not here` |
| tag or shape wrong | `invalid: a room post names its project and its room` |
| media | `invalid: the room is for text; leave out pictures and files` |
| body too long | `invalid: a room post is at most 2000 characters` |
| the reader has not read the launch | `retry: the server has not read this project yet; try again in a minute` |
| no linked wallet | `restricted: link your wallet to your account first, so the server can see that you back this project` |
| not holding | `restricted: only people who back this project can write in its room. If you just backed it, wait about a minute and try again` |
| muted by the team | `restricted: the team has stopped you writing in this room for now` |
| too fast | `restricted: you are writing too fast; try again in a few minutes` |
| too many accounts on one wallet | `restricted: too many accounts write from this wallet` |
| reply to something outside the room | `invalid: a reply belongs in the same room as the post it answers` |
| a database error | `error: db error ...` (a server fault, never a pass) |

## 4. Team tools: mute, remove, perks

The team is the project's founder plus the `team` tags the founder lists on the project record. **The founder alone controls that
list**; there is no acceptance step, so a team's power over a room is the founder's power. A muted person keeps the right to
read and to take money out.

**Stop a person writing for a while (kind 47003, family `room-mute`).** Tags: `["a", coordinate]`, `["room-mute", "<pubkey hex>"]`,
up to 8 `["room-mute-wallet", "<address>"]` (lower-case `0x` and 40 hex digits: the wallets the person had linked, read by the
team's app from the person's kind 37017 records), exactly one `["expiration", "<unix seconds>"]`. Content `{}`. Signed by the founder
or a listed team member. The expiration is at most 30 days after the server's clock; one in the past lifts the mute. The newest
record naming a person (by `created_at`, then id) is that person's state. A team cannot mute the founder, an operator of the
server, or its own signer. Refusals: `restricted: only this project's team can post this`, `invalid: a room mute names one
person, up to 8 wallets and an end within 30 days`, `restricted: the founder and the people who run this server cannot be
stopped from writing`.

**Remove a post.** The existing kind 9005 request with no `h` tag and one `e` tag and a public reason (at most 280 characters).
It now also works for **the founder or a listed team member of the project the post's `a` tag names, when the post carries that
project's own `room:` tag**. The soft delete, the audit row and the public log entry (kind 45004, naming the author in `p`) are
the existing transaction; the log entry's `role` is `project_team`. A team member cannot remove the founder's post or another team
member's post (only the founder removes a team member's post), cannot remove an operator's post, and cannot remove a post outside
their room. A like (kind 7) is not a post kind and is not removable; a muted person's likes stop because their writes stop.
Community owners and admins keep their power over every post, unchanged. Refusals:
`restricted: only the people who keep this room can remove a post from it`,
`restricted: a team member cannot remove the founder's post or another team member's post`.

**Perks.** One tag on the founder's project record: `["perks", "<text, at most 600 characters>"]`. Words, never money. The relay only
bounds its length (the record's own size rule). The app shows the fixed line under it.

## 5. Seasons

A season is a six-week group of projects with open entry, started by the platform's operator. Demo day is the day its projects are
shown together. Creaton backing a project is an ordinary Back by the owner and needs no code.

**The season record (kind 37021).** Parameterized replaceable, global (no `h`). Tags: exactly one `["d", "season-<n>"]` with `n`
a canonical decimal from 1 to 9999. Content, JSON, at most 1,024 bytes:
`{"v":1,"number":<n>,"startsAt":<unix>,"demoDayAt":<unix>,"endsAt":<unix>}`. Signed by an operator only: a key in
`RELAY_OPERATOR_PUBKEYS`, or the relay's owner key when that list is empty. Rules at write: `d` equals `season-<number>`;
`startsAt < demoDayAt <= endsAt`; `demoDayAt - startsAt` from 1 day to 56 days; `endsAt - demoDayAt` at most 14 days; whole
seconds, `startsAt` not before 1 January 2020 and `endsAt` before 1 January 2100. One record per number: publishing the same `d`
again replaces it (that is how a date moves). Refusals: `restricted: only the people who run this server can start a season`,
`invalid: a season names its number, and its dates run start, demo day, end`.

**Entry (kind 47003, families `season-entry`, `season-leave`, `season-remove`).** Tags: `["a", "37001:<founder>:<id>"]`,
`["t", "season-<n>"]`, and exactly one of `["season-entry", "<n>"]`, `["season-leave", "<n>"]`, `["season-remove", "<n>"]`, the
number equal to the one in the `t` tag. Content `{}`, at most 1 KB, at most 8 tags.

- `season-entry` and `season-leave` are signed by the founder or a listed team member of the project the `a` tag names. A season
  cannot be entered for someone else's project. The newest of the two (by `created_at`, then id) is the project's state.
- `season-remove` is signed by an operator key only. It wins over any entry of that project in that season, before or after;
  a removed project cannot re-enter. It is public and dated.
- Entry and leave are accepted only while the server's clock is in `[startsAt, demoDayAt)` of the newest season record `season-<n>`.
- Entry also needs: the project is listed and not removed; it is launched on the network (the reader has read its launch and
  `projectId` equals the hash of the coordinate); at least **3 counted accounts** back it (`held.countedAccounts` of its newest
  numbers record: a hint on a play network, where it costs nothing; the operator's removal is the real brake); the project has no
  live entry in this season; the season has fewer than **500 live entries**; the founder has fewer than **3 live entries** in
  the season; the project has not changed its place more than **12 times** in the season. The count and the checks are made under
  one lock per season held until the record is stored, so two entries arriving together cannot both pass.
- Entries are read with `{"kinds":[47003], "#t":["season-<n>"], "limit":200}` and paged: the app follows `until` (the oldest
  `created_at` returned) while a page is full, at most 3 pages. It re-checks every entry against the project's own record.

Refusals: `restricted: only this project's team can post this`; `restricted: only the people who run this server can take a
project out of a season`; `invalid: this season does not exist`; `restricted: this season is not open for entry`;
`invalid: this project is not here`; `restricted: this project has not launched on the network yet`;
`restricted: at least 3 people have to back this project first`; `restricted: this project is already in this season`;
`restricted: this season is full`; `restricted: a founder can enter at most 3 projects in one season`;
`restricted: this project was taken out of this season`; `restricted: this project has changed its place in this season too
often`; `retry: this season is busy; try again in a moment`; `invalid: this project is not in this season`
(a leave with no live entry).

## 6. Reading without an account

When the operator set `BUZZ_PUBLIC_PROJECT_READS`, a visitor who is not a member reads: kind 37001 and 47003 as before; kinds 1 and 7
**only when the filter names one project's `#a` and the same project's `#t room:<chain key>`**; and kind 37021 (one `#d`
`season-<n>`, or none, bounded). 47003 season entries are read with one `#t season-<n>` and no more than one season per filter.
Posts and likes served this way are the stored ones whose signer is neither muted nor banned, and never for a project that does
not pass the project's public standing. A post the team or the operator removed is gone from the database's answer.

## 7. What the app sends, and what it must expect

| Action | Kind and tags |
|---|---|
| Write in a room | kind 1: `["a", coordinate]`, `["t", "room:<key>"]` |
| Reply | kind 1 with NIP-10 `e` tags to room posts, plus the same `a` and `room:` tags |
| Like | kind 7 with the `e`, `p`, `k` tags and the same `a` and `room:` tags |
| Link the wallet | kind 37017, as built today (the server reads `d`, `address`, `chain`, `revoked`, `attestation.attestation.expires`, `attestation.domain.chain_id`) |
| Stop a person | kind 47003: `a`, `room-mute`, `room-mute-wallet` (0 to 8), `expiration` |
| Remove a post | kind 9005: one `e`, `public_reason`, no `h` |
| Set perks | the founder's kind 37001 record, every tag kept, `perks` set or cleared |
| Enter or leave a season | kind 47003: `a`, `t season-<n>`, `season-entry` or `season-leave` |
| Start a season (operator) | kind 37021 with `d` and the JSON above, by `buzz launchpad seasons start` |

## 8. Where this page differs from the plan, and why

- **Rate limits** follow C24 as one sentence: 12 posts an hour and 60 events a day, per account and per room (section 4.2 step 8 of
  the plan says "per hour and per day" for both numbers).
- **An `e` tag that names an event the server does not hold** on a room event is refused with "a reply belongs in the same room as the
  post it answers" (the plan says the root must be a room post of this room; an event that is not stored cannot be).
- **Leave** is accepted in the same window as entry, so the list on demo day cannot change except by the operator.
- **A project that changes its place more than 12 times** in a season is refused (the plan caps entries and not toggles; a team that
  enters and leaves without end would fill the season's read).
- **The audit row of a team removal** records the authority `board_moderator` (the closest value the table allows without a migration);
  the public log entry says `project_team`.
- **Who is "the operator".** A key in `RELAY_OPERATOR_PUBKEYS`, or the relay's owner key (`RELAY_OWNER_PUBKEY`) when that list is
  empty: the one rule `api::admin` uses (`is_config_backed_pubkey`), not a second list.
- **The accounts of a wallet** are counted from the live kind 37017 bindings of that wallet (at most 64 read). A wallet with more than
  5 live bindings stops writing for all of them, the first five included (only the wallet's owner can bind it, so a stranger cannot
  do this to a holder).
- **Public reads of a room** serve the newest 200 posts (kind 1) and 400 likes (kind 7) of one room; a season read serves at most 50
  records; a lineup read serves the newest 700 records of one season. A room with more shows its newest.
- **The wallet link is read as the app writes it**: `d` (lower-case address), `chain`, `content.revoked`,
  `content.attestation.attestation.expires` and `content.attestation.domain.chain_id`. The wire test builds it with the app's own
  `wallet-proof.ts` and an anvil key's signature.

## 9. What was run

| What | Result |
|---|---|
| `cargo test -p buzz-relay --lib -- handlers::room_write handlers::wallet_binding handlers::season_rules handlers::room_removal handlers::launch_update_authority handlers::home_moderation handlers::task_chain handlers::task_takes public_read --include-ignored --test-threads=1` | 149 passed, 0 failed (with Postgres and Redis) |
| `cargo test -p buzz-relay --lib -- --skip mesh_demo` (no infrastructure) | 1867 passed, 0 failed |
| `cargo test -p buzz-cli -p buzz-core` | 844 + 358 passed, 0 failed |
| `scripts/room-loop.sh` (a real anvil chain, the real contracts, a real relay, signed records over `POST /events`, the real `buzz` command) | 55 checks passed |

Each guard was switched off once and a named test failed:

| Guard switched off | Failing test |
|---|---|
| the floor of 0.001 Share | `the_floor_is_in_shares_for_both_tokens_one_wei_short_is_no_seat_and_the_floor_is` |
| `claimable` (read `vested` instead) | `r4_and_r5b_a_grant_counts_for_what_is_left_to_claim_and_not_for_what_vested`, `a_grant_counts_for_what_is_left_to_claim_not_for_what_vested` |
| the end of the grace after taking out | `r6_a_leaver_writes_for_one_unit_on_the_chains_clock_and_is_then_read_only` |
| an event that names a room post is a room event | `r12_r17_and_r24_whatever_answers_a_room_post_is_in_its_room_and_passes_its_rule` |
| the mute follows the wallet | `r15_and_r25_a_team_mute_holds_until_it_ends_follows_the_wallet_and_can_be_lifted` |
| text only | `r11_the_room_is_text_only_and_bounded` |
| 5 accounts per wallet | `r14_at_most_five_accounts_write_through_one_wallet` |
| the rates | `r13_the_hourly_limit_of_posts_and_the_daily_limit_of_events` |
| a failed lookup refuses the write | `r21_a_lookup_that_fails_refuses_the_write_and_never_lets_it_pass` |
| the operator's season record | `m1_only_an_operator_starts_a_season_its_dates_are_bound_and_a_later_record_replaces_it` |
| the days entry is open | `m2_entry_is_open_from_the_start_up_to_demo_day` |
| the bar of 3 counted accounts, the tie to the launch | `m4_the_project_must_be_launched_listed_not_removed_and_backed_by_enough_accounts` |
| the operator's removal | `m5_a_project_is_in_once_can_leave_and_enter_again_and_the_operators_removal_wins` |
| the lock on a season | `m6_600_entries_sent_at_once_store_exactly_500_and_no_project_twice` |
| the mute's protected people and its 30 days | `a_mute_is_the_teams_alone_and_never_of_the_founder_a_server_operator_itself_or_over_30_days` |
| the removal guard rails and the keepers' check | `r19_and_r20_the_team_removes_posts_in_its_own_room_with_a_public_reason_and_a_log_entry` |
| the muted signer left out of a public room read | `r18_a_project_that_fails_standing_a_muted_signer_and_a_removed_post_are_not_served` |

The check that a public room read names the project's own room tag is defence in depth: the query is already by that tag, so
switching the check off changes no answer (nothing can be stored under a tag the project does not own).

## 10. Chosen under the owner's standing go; the owner may overrule

- Kind **37021** is taken: it is used nowhere in the tree, and `docs/v3-review/COLD-START-PROPOSAL.md` (lines 448 and 467) only says it
  "looked free" for other records that no decision has been taken on. Moving it is one constant in `buzz-core` and `just regen-kinds`.
- An `e` tag that names a stored post which is **not** in the event's own room makes the event "outside the room" (the plan said the
  root must be a room post of this room; the same rule is applied to every `e` tag, so a quote of an outside post cannot be a way round it).
- Rates: 12 posts an hour and 60 events a day, per account and per room (C24).
- The team's removal is recorded in the audit row as the authority `board_moderator` (no migration), and in the public log as `project_team`.
- A leave is accepted only while entry is (so the lineup cannot change on and after demo day except by the operator).
- A project may change its place in a season (enter and leave) 12 times; the plan capped entries and not toggles.
- A season record that replaces another must be signed in a later second than the one it replaces (a replaceable record is replaced by a newer one).
