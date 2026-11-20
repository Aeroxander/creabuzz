//! Who may write in a project's holder room, decided by the server from the network.
//!
//! A room post is a kind 1 note and a room like a kind 7 reaction, with two more tags: the project's `a` coordinate and
//! `["t", "room:<chain key>"]` (see `docs/next-version/ROOM-AND-SEASON-RECORDS.md`, which is normative for the tags
//! and the sentences). This module is the rule `ingest.rs` runs for them. **It never reads a person's word**: whether
//! someone may write comes from the signer's linked wallets ([`super::wallet_binding`]) and the balances the chain
//! reader stored (`chain_balances`, `chain_balance_changes`), never from a tag, a profile or a post.
//!
//! # What is a room event
//!
//! A kind 1, 6, 7, 16 or 1111 event that carries a `room:` tag, **or whose `e` tags name a stored event that does**.
//! The app reads replies, likes and reposts by `#e`, so an untagged reply from a stranger would show inside a room's
//! thread and the team could not remove it; such an event must carry the room's own tags and pass the same rule.
//! Any other event is not one and nothing here runs for it, so an ordinary post is never slowed.
//!
//! # The steps
//!
//! In this order; the first that fails refuses with its sentence (the `*_SENTENCE` constants):
//! shape, the project, the signer's wallets, holding above a floor (in Shares, not dollars), a Team grant with
//! something left to claim (`claimable`, never `vested`), the grace after taking out, the team's mute, then rates and
//! the cap of accounts per wallet. The rule is **never lenient**: a lookup that fails refuses the write as a server
//! fault, and while the chain reader lags a holder in its rows is never shut out and a leaver's grace is measured on
//! the chain's own clock, so a lag lengthens it and never shortens it.

use std::sync::Arc;

use buzz_core::kind::{
    event_kind_u32, KIND_COMMENT, KIND_GENERIC_REPOST, KIND_LAUNCH_RECORD, KIND_LAUNCH_UPDATE,
    KIND_PROJECT_NUMBERS, KIND_REACTION, KIND_REPOST, KIND_TEXT_NOTE,
};
use buzz_core::tenant::{CommunityId, TenantContext};
use nostr::Event;
use serde_json::Value;
use sqlx::PgPool;

use super::ingest::IngestError;
use super::launch_update_authority::{internal, ProjectTeam};
use super::task_chain::{chain_key_of, AS_OF_SQL};
use super::wallet_binding::{
    accounts_of_wallets, linked_wallets, parse_wallet, wallet_text, Wallet,
};
use crate::api::manager::cost::project_id;
use crate::state::AppState;

/// Said on a server with no chain reader.
pub(crate) const NO_READER: &str = "restricted: rooms are not switched on on this server";
/// Said when the project the post names is not here (not found, not listed, removed, its founder banned or muted).
pub(crate) const NO_PROJECT: &str = "invalid: this project is not here";
/// Said when the tags are wrong.
pub(crate) const BAD_SHAPE: &str = "invalid: a room post names its project and its room";
/// Said when a room event carries a media tag.
pub(crate) const TEXT_ONLY: &str = "invalid: the room is for text; leave out pictures and files";
/// Said when a room event's body is too long.
pub(crate) const TOO_LONG: &str = "invalid: a room post is at most 2000 characters";
/// Said when the reader has not read the project's launch.
pub(crate) const NOT_READ_YET: &str =
    "retry: the server has not read this project yet; try again in a minute";
/// Said when the signer has no live wallet link.
pub(crate) const LINK_WALLET: &str =
    "restricted: link your wallet to your account first, so the server can see that you back this project";
/// Said when the signer's wallets hold nothing (and none took out lately).
pub(crate) const NOT_HOLDING: &str = "restricted: only people who back this project can write in its room. If you just backed it, wait about a minute and try again";
/// Said when the team has stopped the signer.
pub(crate) const MUTED: &str = "restricted: the team has stopped you writing in this room for now";
/// Said when the signer writes too fast.
pub(crate) const TOO_FAST: &str =
    "restricted: you are writing too fast; try again in a few minutes";
/// Said when too many accounts write through one wallet.
pub(crate) const TOO_MANY_ACCOUNTS: &str = "restricted: too many accounts write from this wallet";
/// Said when a reply, like or repost is not in the room of the post it answers.
pub(crate) const OUTSIDE_THE_ROOM: &str =
    "invalid: a reply belongs in the same room as the post it answers";

/// The smallest balance that opens a seat: 0.001 of a Share (`10^15` wei), the same for the Team token. It is in
/// Shares, not dollars, so a fall in the Share's price never shuts a real holder out; it is there so that one wei
/// moved over for the price of a fee does not open a seat.
pub(crate) const ROOM_MIN_SHARES: u128 = 1_000_000_000_000_000;
/// The most room posts (kinds 1 and 1111) one account may write in one room in an hour.
pub(crate) const POSTS_PER_HOUR: i64 = 12;
/// The most room events (posts, likes, reposts) one account may write in one room in a day.
pub(crate) const EVENTS_PER_DAY: i64 = 60;
/// The most accounts that may write in a room through one wallet.
pub(crate) const ACCOUNTS_PER_WALLET: usize = 5;
/// The longest a room post or comment may be, in characters (the app's own `MAX_POST_CHARS`).
pub(crate) const BODY_CHARS_MAX: usize = 2000;
/// The longest a room like may be, in characters.
pub(crate) const REACTION_CHARS_MAX: usize = 64;
/// The most `e` tags read on one event that may be a room event.
pub(crate) const E_TAGS_MAX: usize = 256;
/// The most `room-mute` records read for one person.
pub(crate) const MUTES_READ: i64 = 200;

/// The kinds a room carries.
const ROOM_KINDS: [u32; 5] = [
    KIND_TEXT_NOTE,
    KIND_REPOST,
    KIND_REACTION,
    KIND_GENERIC_REPOST,
    KIND_COMMENT,
];
/// The tags a text-only room refuses.
const MEDIA_TAGS: [&str; 14] = [
    "imeta", "x", "ox", "image", "thumb", "url", "m", "dim", "blurhash", "size", "file", "video",
    "audio", "media",
];

/// How many times the rule has run past the point of knowing an event is a room event (tests read this to show that
/// an ordinary post never reaches it).
#[cfg(test)]
pub(crate) static RULE_RUNS: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

/// What a room event's own tags say.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Scan {
    /// The values of the `t` tags that start with `room:`.
    pub(crate) room_tags: Vec<String>,
    /// The values of the `a` tags.
    pub(crate) a_tags: Vec<String>,
    /// The 32-byte ids of the `e` tags, lower case (an `e` tag that is not an id is left out and counted in `bad_e`).
    pub(crate) e_ids: Vec<[u8; 32]>,
    /// How many `e` tags did not hold an id.
    pub(crate) bad_e: usize,
    /// Whether a media tag is present.
    pub(crate) media: bool,
}

/// Read the tags the rule is about.
pub(crate) fn scan(event: &Event) -> Scan {
    let mut out = Scan::default();
    for tag in event.tags.iter() {
        let parts = tag.as_slice();
        let (Some(name), value) = (
            parts.first().map(String::as_str),
            parts.get(1).map(String::as_str).unwrap_or(""),
        ) else {
            continue;
        };
        match name {
            "t" if value.starts_with("room:") => out.room_tags.push(value.to_owned()),
            "a" => out.a_tags.push(value.to_owned()),
            "e" => match hex_id(value) {
                Some(id) => out.e_ids.push(id),
                None => out.bad_e += 1,
            },
            other if MEDIA_TAGS.contains(&other) => out.media = true,
            _ => {}
        }
    }
    out.e_ids.sort_unstable();
    out.e_ids.dedup();
    out
}

fn hex_id(value: &str) -> Option<[u8; 32]> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return None;
    }
    hex::decode(value).ok()?.try_into().ok()
}

/// The chain key a `room:` tag value names (`room:` and `0x` and 64 lower-case hex digits).
pub(crate) fn room_key(tag: &str) -> Option<[u8; 32]> {
    let digits = tag.strip_prefix("room:")?.strip_prefix("0x")?;
    hex_id(digits)
}

/// A project's address: `37001:<founder pubkey hex>:<d>`, split.
pub(crate) fn split_coordinate(coordinate: &str) -> Option<([u8; 32], &str)> {
    let mut parts = coordinate.splitn(3, ':');
    let (kind, author, d) = (parts.next()?, parts.next()?, parts.next()?);
    if kind != KIND_LAUNCH_RECORD.to_string() || d.is_empty() {
        return None;
    }
    Some((hex_id(author)?, d))
}

/// The room a stored or incoming event belongs to: its single project address and its single room tag. `None` when
/// the event does not name exactly one of each.
pub(crate) fn room_of(scanned: &Scan) -> Option<(&str, &str)> {
    match (scanned.a_tags.as_slice(), scanned.room_tags.as_slice()) {
        ([coordinate], [room]) => Some((coordinate.as_str(), room.as_str())),
        _ => None,
    }
}

/// What the rule needs to know about a signer to decide (read by [`enforce`], decided by [`may_write`]).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct Standing {
    /// Whether one of the signer's wallets holds backer Shares or Team Shares above the floor.
    pub(crate) holds: bool,
    /// Whether one of them is the member of a Team grant with something left to claim.
    pub(crate) grant_left: bool,
    /// The chain time of the newest decrease of any of their balances for the project (unix seconds), if any.
    pub(crate) last_decrease: Option<u64>,
    /// The project's time unit in seconds.
    pub(crate) unit: u64,
    /// The newest block time the reader has stored.
    pub(crate) as_of: u64,
}

/// Whether a signer in `standing` may write: holds, has a grant to claim, or took out less than one unit ago on the
/// chain's own clock.
pub(crate) fn may_write(standing: &Standing) -> bool {
    standing.holds
        || standing.grant_left
        || standing
            .last_decrease
            .is_some_and(|at| at.saturating_add(standing.unit) > standing.as_of)
}

/// Hold one account's recent room writes against the limits.
pub(crate) fn within_rates(
    is_post: bool,
    posts_this_hour: i64,
    events_today: i64,
) -> Result<(), &'static str> {
    if (is_post && posts_this_hour >= POSTS_PER_HOUR) || events_today >= EVENTS_PER_DAY {
        return Err(TOO_FAST);
    }
    Ok(())
}

/// The bounds on the body of a room event of `kind`.
pub(crate) fn body_ok(kind: u32, content: &str) -> Result<(), &'static str> {
    let max = if kind == KIND_REACTION {
        REACTION_CHARS_MAX
    } else {
        BODY_CHARS_MAX
    };
    if content.chars().count() > max {
        return Err(TOO_LONG);
    }
    Ok(())
}

/// The reader's launch row of a project: what ties its key to its coordinate, and its time unit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Launched {
    /// The launch's `projectId` (lower-case `0x` and 64 hex digits): the hash of the project record's address.
    pub(crate) project_id: String,
    /// The project's time unit in seconds.
    pub(crate) unit: u64,
}

/// The project's launch as the reader stored it, or `None` when the reader has not read it yet.
pub(crate) async fn launched_of(
    pool: &PgPool,
    reader: &str,
    chain_key: &[u8; 32],
) -> Result<Option<Launched>, sqlx::Error> {
    let row: Option<(Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT lower(decoded->>'projectId'), decoded->'platform'->>'unit' FROM chain_logs \
         WHERE reader = $1 AND project_key = $2 AND role = 'launcher' AND event = 'ProjectLaunched' \
         ORDER BY block_number, log_index LIMIT 1",
    )
    .bind(reader)
    .bind(chain_key.as_slice())
    .fetch_optional(pool)
    .await?;
    let Some((Some(project_id), unit)) = row else {
        return Ok(None);
    };
    let unit = unit
        .and_then(|text| text.parse::<u64>().ok())
        .ok_or_else(|| sqlx::Error::Decode("a stored launch has no time unit".into()))?;
    Ok(Some(Launched { project_id, unit }))
}

/// The newest block time the reader has stored (the chain's own clock), `0` when it has stored none.
pub(crate) async fn as_of(pool: &PgPool, reader: &str) -> Result<u64, sqlx::Error> {
    let at: Option<i64> = sqlx::query_scalar(AS_OF_SQL)
        .bind(reader)
        .fetch_optional(pool)
        .await?;
    Ok(u64::try_from(at.unwrap_or(0)).unwrap_or(0))
}

/// The wallets of `wallets` that hold at least [`ROOM_MIN_SHARES`] of the project's backer Shares or Team Shares.
async fn holding_wallets(
    pool: &PgPool,
    reader: &str,
    key: &[u8; 32],
    wallets: &[Wallet],
) -> Result<Vec<Wallet>, sqlx::Error> {
    let accounts: Vec<Vec<u8>> = wallets.iter().map(|w| w.to_vec()).collect();
    let rows: Vec<Vec<u8>> = sqlx::query_scalar(
        "SELECT DISTINCT account FROM chain_balances \
         WHERE reader = $1 AND project_key = $2 AND token IN ('shares', 'team') \
           AND account = ANY($3) AND balance >= $4::numeric",
    )
    .bind(reader)
    .bind(key.as_slice())
    .bind(accounts)
    .bind(ROOM_MIN_SHARES.to_string())
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|account| <Wallet>::try_from(account.as_slice()).ok())
        .collect())
}

/// The chain time of the newest decrease of any of `wallets`' balances of the project, if there is one. Only a
/// decrease of at least [`ROOM_MIN_SHARES`] counts, the size of the stake that opens a seat: a smaller move (one wei
/// sent to a second wallet and back, for the price of a fee) must not start a new grace for a person who holds
/// nothing, or a past holder could write for ever.
pub(crate) async fn last_decrease_time(
    pool: &PgPool,
    reader: &str,
    key: &[u8; 32],
    wallets: &[Wallet],
) -> Result<Option<u64>, sqlx::Error> {
    let accounts: Vec<Vec<u8>> = wallets.iter().map(|w| w.to_vec()).collect();
    let block: Option<i64> = sqlx::query_scalar(
        "SELECT max(x.b) FROM unnest($3::bytea[]) AS w(a) \
         CROSS JOIN (VALUES ('shares'), ('team')) AS t(tok) \
         CROSS JOIN LATERAL ( \
             SELECT c.block_number AS b FROM chain_balance_changes c \
             WHERE c.reader = $1 AND c.project_key = $2 AND c.token = t.tok AND c.account = w.a \
               AND c.delta <= -($4::numeric) \
             ORDER BY c.block_number DESC LIMIT 1) x",
    )
    .bind(reader)
    .bind(key.as_slice())
    .bind(accounts)
    .bind(ROOM_MIN_SHARES.to_string())
    .fetch_one(pool)
    .await?;
    let Some(block) = block else {
        return Ok(None);
    };
    let time: Option<i64> =
        sqlx::query_scalar("SELECT block_time FROM chain_blocks WHERE reader = $1 AND number = $2")
            .bind(reader)
            .bind(block)
            .fetch_optional(pool)
            .await?;
    Ok(time.map(|t| u64::try_from(t).unwrap_or(0)))
}

/// Whether the newest numbers record of the project lists a Team grant of one of `wallets` with something left to
/// claim. A record that does not read, or a grants list that was cut and does not list the wallet, reads as no.
pub(crate) fn grant_left_in(record: &Value, wallets: &[Wallet]) -> Vec<Wallet> {
    let Some(grants) = record
        .get("team")
        .and_then(|team| team.get("grants"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    let mut found: Vec<Wallet> = grants
        .iter()
        .filter_map(|grant| {
            let member = parse_wallet(grant.get("member")?.as_str()?)?;
            let claimable = grant.get("claimable")?.as_str()?;
            // `vested` stays above zero for a member who claimed everything and left: only what is still to claim counts.
            let left = claimable.bytes().all(|b| b.is_ascii_digit())
                && !claimable.is_empty()
                && claimable.bytes().any(|b| b != b'0');
            (left && wallets.contains(&member)).then_some(member)
        })
        .collect();
    found.sort_unstable();
    found.dedup();
    found
}

/// The project's newest numbers record (kind 39009, signed by this server, `d` = the chain key), parsed.
pub(crate) async fn numbers_record(
    state: &AppState,
    community: CommunityId,
    key: &[u8; 32],
) -> Result<Option<Value>, buzz_db::DbError> {
    let relay = state.relay_keypair.public_key().to_bytes().to_vec();
    let rows = state
        .db
        .query_events_for_event_write(&buzz_db::EventQuery {
            kinds: Some(vec![KIND_PROJECT_NUMBERS as i32]),
            pubkey: Some(relay),
            d_tag: Some(format!("0x{}", hex::encode(key))),
            global_only: true,
            limit: Some(1),
            ..buzz_db::EventQuery::for_community(community)
        })
        .await?;
    Ok(rows
        .into_iter()
        .next()
        .and_then(|stored| serde_json::from_str(&stored.event.content).ok()))
}

/// The project record a coordinate names, as it stands.
pub(crate) async fn project_record(
    state: &AppState,
    community: CommunityId,
    author: &[u8; 32],
    d: &str,
) -> Result<Option<Event>, buzz_db::DbError> {
    Ok(state
        .db
        .query_events_for_event_write(&buzz_db::EventQuery {
            kinds: Some(vec![KIND_LAUNCH_RECORD as i32]),
            pubkey: Some(author.to_vec()),
            d_tag: Some(d.to_owned()),
            global_only: true,
            limit: Some(1),
            ..buzz_db::EventQuery::for_community(community)
        })
        .await?
        .into_iter()
        .next()
        .map(|stored| stored.event))
}

/// How a person's mute of `signer` reads from the team's `room-mute` records: whether it holds now.
///
/// `records` are the project's `room-mute` records that name the signer's key or one of the signer's wallets;
/// `newest_per_person` finds, for each person such a record names, that person's newest record. The signer is muted
/// when their own newest record, or the newest record of any person it names by wallet, has not ended.
pub(crate) fn mute_holds(
    records: &[MuteRecord],
    signer: &str,
    signer_wallets: &[Wallet],
    now: u64,
) -> bool {
    let mut newest: std::collections::BTreeMap<&str, &MuteRecord> =
        std::collections::BTreeMap::new();
    for record in records {
        let slot = newest.entry(record.person.as_str()).or_insert(record);
        if (record.created_at, &record.id) > (slot.created_at, &slot.id) {
            *slot = record;
        }
    }
    newest.values().any(|record| {
        record.until > now
            && (record.person == signer
                || record
                    .wallets
                    .iter()
                    .any(|wallet| signer_wallets.contains(wallet)))
    })
}

/// One `room-mute` record, read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MuteRecord {
    /// The person it stops (hex pubkey).
    pub(crate) person: String,
    /// The wallets that person had linked when the team signed it.
    pub(crate) wallets: Vec<Wallet>,
    /// When it ends (unix seconds).
    pub(crate) until: u64,
    /// When it was signed.
    pub(crate) created_at: u64,
    /// Its id (hex), the tie-break of two records signed in one second.
    pub(crate) id: String,
}

/// Read a `room-mute` record's tags. `None` when it is not one or does not read.
pub(crate) fn mute_record_of(event: &Event) -> Option<MuteRecord> {
    let mut person = None;
    let mut until = None;
    let mut wallets = Vec::new();
    for tag in event.tags.iter() {
        let parts = tag.as_slice();
        let value = parts.get(1)?.as_str();
        match parts.first().map(String::as_str)? {
            "room-mute" => person = Some(value.to_owned()),
            "room-mute-wallet" => wallets.push(parse_wallet(value)?),
            "expiration" => until = value.parse::<u64>().ok(),
            _ => {}
        }
    }
    Some(MuteRecord {
        person: person?,
        wallets,
        until: until?,
        created_at: event.created_at.as_secs(),
        id: event.id.to_hex(),
    })
}

/// The project's `room-mute` records that carry `value` in their `name` tag (`room-mute` or `room-mute-wallet`), newest
/// first, at most [`MUTES_READ`], **signed by someone on the project's team now**: a mute outlives neither the member
/// who signed it nor a founder's change of mind, so a record from a person the founder has taken off the team is not
/// read, and the older record of a current member decides again.
async fn read_mutes(
    state: &AppState,
    community: CommunityId,
    team: &ProjectTeam,
    coordinate: &str,
    name: &str,
    values: Vec<String>,
) -> Result<Vec<MuteRecord>, buzz_db::DbError> {
    let query = buzz_db::EventQuery {
        kinds: Some(vec![KIND_LAUNCH_UPDATE as i32]),
        global_only: true,
        tag_filters: vec![
            ("a".to_owned(), vec![coordinate.to_owned()]),
            (name.to_owned(), values),
        ],
        limit: Some(MUTES_READ),
        ..buzz_db::EventQuery::for_community(community)
    };
    Ok(state
        .db
        .query_events_for_event_write(&query)
        .await?
        .iter()
        .filter(|stored| team.has(&stored.event.pubkey.to_hex()))
        .filter_map(|stored| mute_record_of(&stored.event))
        .collect())
}

/// Whether the team has stopped `signer` writing in the room of `coordinate` right now.
async fn is_muted(
    state: &AppState,
    community: CommunityId,
    team: &ProjectTeam,
    coordinate: &str,
    signer: &str,
    wallets: &[Wallet],
    now: u64,
) -> Result<bool, buzz_db::DbError> {
    // The records that name the signer, and the records that name a wallet the signer has bound.
    let mut records = read_mutes(
        state,
        community,
        team,
        coordinate,
        "room-mute",
        vec![signer.to_owned()],
    )
    .await?;
    let by_wallet = if wallets.is_empty() {
        Vec::new()
    } else {
        read_mutes(
            state,
            community,
            team,
            coordinate,
            "room-mute-wallet",
            wallets.iter().map(wallet_text).collect(),
        )
        .await?
    };
    // For each person a wallet names, that person's newest record decides (it may have lifted the mute or changed
    // the wallets), so read them all.
    let mut people: Vec<String> = by_wallet.iter().map(|r| r.person.clone()).collect();
    people.sort();
    people.dedup();
    people.retain(|person| person != signer);
    if !people.is_empty() {
        records.extend(read_mutes(state, community, team, coordinate, "room-mute", people).await?);
    }
    Ok(mute_holds(&records, signer, wallets, now))
}

/// The stored events the `e` tags name that are room events: `(room tag, coordinate)` of each stored one that has
/// exactly one of each; a stored event with room tags that do not read as one room carries `None`.
async fn named_stored(
    state: &AppState,
    community: CommunityId,
    ids: &[[u8; 32]],
) -> Result<Vec<Option<(String, String)>>, buzz_db::DbError> {
    let rows = state
        .db
        .query_events_for_event_write(&buzz_db::EventQuery {
            ids: Some(ids.iter().map(|id| id.to_vec()).collect()),
            limit: Some(i64::try_from(ids.len()).unwrap_or(i64::MAX)),
            ..buzz_db::EventQuery::for_community(community)
        })
        .await?;
    Ok(rows
        .iter()
        .filter_map(|stored| {
            let scanned = scan(&stored.event);
            if scanned.room_tags.is_empty() {
                return None;
            }
            Some(room_of(&scanned).map(|(a, t)| (t.to_owned(), a.to_owned())))
        })
        .collect())
}

/// How many stored events (all of them, deleted ones too) `signer` has written in a room: `(posts in the last hour,
/// events in the last day)`.
async fn recent_writes(
    pool: &PgPool,
    community: CommunityId,
    signer: &[u8],
    room: &str,
) -> Result<(i64, i64), sqlx::Error> {
    let kinds: Vec<i32> = ROOM_KINDS.iter().map(|k| *k as i32).collect();
    sqlx::query_as(
        "SELECT \
             count(*) FILTER (WHERE kind IN (1, 1111) AND received_at > now() - interval '1 hour')::bigint, \
             count(*) FILTER (WHERE received_at > now() - interval '1 day')::bigint \
         FROM events \
         WHERE community_id = $1 AND pubkey = $2 AND kind = ANY($3) \
           AND created_at > now() - interval '26 hours' AND tags @> $4::jsonb",
    )
    .bind(community.as_uuid())
    .bind(signer)
    .bind(kinds)
    .bind(serde_json::json!([["t", room]]).to_string())
    .fetch_one(pool)
    .await
}

fn refuse(reason: &'static str) -> IngestError {
    if reason.starts_with("restricted:") {
        IngestError::AuthFailed(reason.into())
    } else {
        IngestError::Rejected(reason.into())
    }
}

/// Run the room rule on an event about to be stored, if it is a room event. Called from `ingest.rs` after the
/// signer, the scope and the server-wide bans and timeouts are judged.
///
/// A room event that passes returns the lock on its writer's count, which the caller keeps until the event is stored.
pub(crate) async fn enforce(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    event: &Event,
) -> Result<Option<super::season_rules::SeasonLock>, IngestError> {
    let kind = event_kind_u32(event);
    if !ROOM_KINDS.contains(&kind) {
        return Ok(None);
    }
    let scanned = scan(event);
    if scanned.room_tags.is_empty() && scanned.e_ids.is_empty() && scanned.bad_e == 0 {
        return Ok(None);
    }
    if scanned.e_ids.len() + scanned.bad_e > E_TAGS_MAX {
        return Err(IngestError::Rejected(OUTSIDE_THE_ROOM.into()));
    }
    let community = tenant.community();

    // Which stored events the `e` tags name, and whether any of them is a room post.
    let named = if scanned.e_ids.is_empty() {
        Vec::new()
    } else {
        named_stored(state, community, &scanned.e_ids)
            .await
            .map_err(|e| internal("reading the posts this one answers", e))?
    };
    if scanned.room_tags.is_empty() && named.is_empty() {
        // Not a room event: it names no room post and carries no room tag.
        return Ok(None);
    }
    #[cfg(test)]
    RULE_RUNS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);

    // An event that names a room post and carries no room tag of its own is not in that room.
    if scanned.room_tags.is_empty() {
        return Err(IngestError::Rejected(OUTSIDE_THE_ROOM.into()));
    }

    // 1. Shape.
    let Some((coordinate, room)) = room_of(&scanned) else {
        return Err(IngestError::Rejected(BAD_SHAPE.into()));
    };
    let (Some(key), Some((author, d))) = (room_key(room), split_coordinate(coordinate)) else {
        return Err(IngestError::Rejected(BAD_SHAPE.into()));
    };
    if scanned.media {
        return Err(IngestError::Rejected(TEXT_ONLY.into()));
    }
    body_ok(kind, &event.content).map_err(refuse)?;
    // Every post this answers is a stored post of this very room (the same room tag and the same project).
    let answers_in_room = named.len() == scanned.e_ids.len()
        && scanned.bad_e == 0
        && named.iter().all(|stored| {
            stored
                .as_ref()
                .is_some_and(|(t, a)| t == room && a == coordinate)
        });
    if !answers_in_room {
        return Err(IngestError::Rejected(OUTSIDE_THE_ROOM.into()));
    }
    // A like or a repost names what it is about and nothing else.
    if kind == KIND_REACTION && scanned.e_ids.is_empty() {
        return Err(IngestError::Rejected(BAD_SHAPE.into()));
    }

    // 2. The project.
    let Some(config) = state.config.chain_reader.as_ref() else {
        return Err(refuse(NO_READER));
    };
    let reader = config.reader_id();
    let record = project_record(state, community, &author, d)
        .await
        .map_err(|e| internal("reading the project record", e))?;
    let Some(record) = record else {
        return Err(IngestError::Rejected(NO_PROJECT.into()));
    };
    let standing = crate::share_preview::public_standing(state, community, record)
        .await
        .map_err(|e| internal("reading the project's standing", e))?;
    let Some(project) = standing else {
        return Err(IngestError::Rejected(NO_PROJECT.into()));
    };
    if chain_key_of(&project.record) != Some(key) {
        return Err(IngestError::Rejected(BAD_SHAPE.into()));
    }
    let pool = state.db.pool();
    let launched = launched_of(pool, &reader, &key)
        .await
        .map_err(|e| internal("reading the project's launch", e))?;
    let Some(launched) = launched else {
        return Err(IngestError::Rejected(NOT_READ_YET.into()));
    };
    if launched.project_id != project_id(coordinate).to_lowercase() {
        return Err(IngestError::Rejected(BAD_SHAPE.into()));
    }

    // 3. The signer's wallets.
    let signer_bytes = event.pubkey.to_bytes();
    let wallets = linked_wallets(state, community, &signer_bytes)
        .await
        .map_err(|e| internal("reading the signer's linked wallets", e))?;
    if wallets.is_empty() {
        return Err(refuse(LINK_WALLET));
    }

    // 4 to 6. Holding, a grant to claim, the grace after taking out.
    let holding = holding_wallets(pool, &reader, &key, &wallets)
        .await
        .map_err(|e| internal("reading the signer's balances", e))?;
    let mut standing = Standing {
        holds: !holding.is_empty(),
        unit: launched.unit,
        ..Standing::default()
    };
    let mut via = holding;
    if !standing.holds {
        let record = numbers_record(state, community, &key)
            .await
            .map_err(|e| internal("reading the project's numbers", e))?;
        let granted = record
            .as_ref()
            .map(|record| grant_left_in(record, &wallets))
            .unwrap_or_default();
        if !granted.is_empty() {
            standing.grant_left = true;
            via = granted;
        } else {
            standing.last_decrease = last_decrease_time(pool, &reader, &key, &wallets)
                .await
                .map_err(|e| internal("reading when the signer took out", e))?;
            standing.as_of = as_of(pool, &reader)
                .await
                .map_err(|e| internal("reading the chain's clock", e))?;
            via = wallets.clone();
        }
    }
    if !may_write(&standing) {
        return Err(refuse(NOT_HOLDING));
    }

    // 7. Not muted by the team. The founder and the people who run the server are never stopped, whatever a record
    // says (a record that lists their wallet is refused when it is written; this is the same rule at the read).
    let now = u64::try_from(chrono::Utc::now().timestamp()).unwrap_or(0);
    let signer_hex = event.pubkey.to_hex();
    let team = ProjectTeam::from_record(&project.record);
    if !team.is_founder(&signer_hex)
        && !super::season_rules::is_operator(state, &signer_hex)
        && is_muted(
            state,
            community,
            &team,
            coordinate,
            &signer_hex,
            &wallets,
            now,
        )
        .await
        .map_err(|e| internal("reading the team's mutes", e))?
    {
        return Err(refuse(MUTED));
    }

    // 8. Rates, and not too many voices behind one wallet. The count and the store are one step for one account in
    // one room: the lock is kept until the event is stored, so a crowd sent at once cannot all pass the same count.
    let lock = super::season_rules::SeasonLock::acquire_named(
        pool,
        format!("creaton-room:{signer_hex}:{room}"),
    )
    .await?;
    let (posts, events) = recent_writes(pool, community, &signer_bytes, room)
        .await
        .map_err(|e| internal("counting the signer's recent room posts", e))?;
    let is_post = matches!(kind, KIND_TEXT_NOTE | KIND_COMMENT);
    within_rates(is_post, posts, events).map_err(refuse)?;
    let mut under_cap = false;
    for wallet in &via {
        let accounts = accounts_of_wallets(state, community, std::slice::from_ref(wallet))
            .await
            .map_err(|e| internal("counting the accounts behind a wallet", e))?;
        if accounts.len() <= ACCOUNTS_PER_WALLET {
            under_cap = true;
            break;
        }
    }
    if !under_cap {
        return Err(refuse(TOO_MANY_ACCOUNTS));
    }
    Ok(Some(lock))
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind, Tag};
    use serde_json::json;

    const KEY: &str = "0xabababababababababababababababababababababababababababababababab";
    const AUTHOR: &str = "1111111111111111111111111111111111111111111111111111111111111111";

    fn event(kind: u32, content: &str, tags: &[&[&str]]) -> Event {
        let tags: Vec<Tag> = tags
            .iter()
            .map(|parts| Tag::parse(parts.to_vec()).expect("tag"))
            .collect();
        EventBuilder::new(Kind::Custom(kind as u16), content)
            .tags(tags)
            .sign_with_keys(&Keys::generate())
            .expect("sign")
    }

    #[test]
    fn the_scan_reads_the_room_tag_the_project_and_what_it_answers() {
        let room = format!("room:{KEY}");
        let coordinate = format!("37001:{AUTHOR}:orbit");
        let post = event(
            1,
            "hello",
            &[
                &["a", &coordinate],
                &["t", &room],
                &["t", "topic"],
                &["e", AUTHOR, "", "root"],
                &["e", "nothex"],
            ],
        );
        let scanned = scan(&post);
        assert_eq!(scanned.room_tags, vec![room.clone()]);
        assert_eq!(scanned.a_tags, vec![coordinate.clone()]);
        assert_eq!(scanned.e_ids.len(), 1);
        assert_eq!(scanned.bad_e, 1);
        assert!(!scanned.media);
        assert!(scan(&event(1, "", &[&["imeta", "url x"]])).media);
        assert!(scan(&event(1, "", &[&["url", "https://x"]])).media);
        // Topic tags typed as words never look like the room tag.
        assert!(scan(&event(1, "", &[&["t", "orbit"]])).room_tags.is_empty());
        assert_eq!(room_key(&room), Some([0xab; 32]));
        assert_eq!(room_key("room:abab"), None);
        assert_eq!(room_key(KEY), None);
        assert_eq!(split_coordinate(&coordinate), Some(([0x11; 32], "orbit")));
        assert_eq!(split_coordinate("30023:abc:d"), None);
    }

    #[test]
    fn a_room_event_names_exactly_one_project_and_one_room() {
        let room = format!("room:{KEY}");
        let coordinate = format!("37001:{AUTHOR}:orbit");
        let ok = scan(&event(1, "", &[&["a", &coordinate], &["t", &room]]));
        assert!(room_of(&ok).is_some());
        for tags in [
            vec![vec!["t", room.as_str()]],
            vec![vec!["a", coordinate.as_str()]],
            vec![
                vec!["a", coordinate.as_str()],
                vec!["a", coordinate.as_str()],
                vec!["t", room.as_str()],
            ],
            vec![
                vec!["a", coordinate.as_str()],
                vec!["t", room.as_str()],
                vec!["t", "room:0xcd"],
            ],
        ] {
            let tags: Vec<&[&str]> = tags.iter().map(Vec::as_slice).collect();
            assert!(room_of(&scan(&event(1, "", &tags))).is_none(), "{tags:?}");
        }
    }

    #[test]
    fn a_holder_a_grant_and_a_leaver_inside_the_unit_may_write_and_nobody_else() {
        let none = Standing {
            unit: 100,
            as_of: 1_000,
            ..Standing::default()
        };
        assert!(!may_write(&none));
        assert!(may_write(&Standing {
            holds: true,
            ..none.clone()
        }));
        assert!(may_write(&Standing {
            grant_left: true,
            ..none.clone()
        }));
        // Took out at 950: the unit ends at 1050, so at 1000 the person may still write; at 1050 they may not.
        let left = |as_of| Standing {
            last_decrease: Some(950),
            as_of,
            ..none.clone()
        };
        assert!(may_write(&left(1_000)));
        assert!(may_write(&left(1_049)));
        assert!(!may_write(&left(1_050)));
        assert!(!may_write(&left(5_000)));
    }

    #[test]
    fn the_limits_are_an_hour_of_posts_and_a_day_of_events() {
        assert_eq!(within_rates(true, 11, 59), Ok(()));
        assert_eq!(within_rates(true, 12, 12), Err(TOO_FAST));
        // A like is not a post: the hourly cap of posts does not stop it, the day's cap does.
        assert_eq!(within_rates(false, 12, 12), Ok(()));
        assert_eq!(within_rates(false, 0, 60), Err(TOO_FAST));
    }

    #[test]
    fn the_body_is_bounded_in_characters_not_bytes() {
        assert_eq!(body_ok(1, &"é".repeat(2_000)), Ok(()));
        assert_eq!(body_ok(1, &"é".repeat(2_001)), Err(TOO_LONG));
        assert_eq!(body_ok(7, &"+".repeat(64)), Ok(()));
        assert_eq!(body_ok(7, &"+".repeat(65)), Err(TOO_LONG));
    }

    #[test]
    fn a_grant_counts_for_what_is_left_to_claim_not_for_what_vested() {
        let (a, b) = (
            parse_wallet("0x00000000000000000000000000000000000000aa").expect("wallet"),
            parse_wallet("0x00000000000000000000000000000000000000bb").expect("wallet"),
        );
        let record = json!({ "team": { "grants": [
            { "member": "0x00000000000000000000000000000000000000aa", "vested": "500", "claimed": "500", "claimable": "0" },
            { "member": "0x00000000000000000000000000000000000000bb", "vested": "9", "claimed": "0", "claimable": "9" },
        ] } });
        // `a` claimed everything and may have left: vested is above zero but nothing is left to claim.
        assert_eq!(grant_left_in(&record, &[a]), Vec::<Wallet>::new());
        assert_eq!(grant_left_in(&record, &[a, b]), vec![b]);
        assert_eq!(grant_left_in(&json!({}), &[a]), Vec::<Wallet>::new());
        assert_eq!(
            grant_left_in(
                &json!({ "team": { "grants": [{ "member": "x", "claimable": "1" }] } }),
                &[a]
            ),
            Vec::<Wallet>::new()
        );
    }

    #[test]
    fn a_mute_follows_the_wallet_until_it_ends_and_the_newest_record_per_person_decides() {
        let wallet = parse_wallet("0x00000000000000000000000000000000000000aa").expect("wallet");
        let other = parse_wallet("0x00000000000000000000000000000000000000bb").expect("wallet");
        let record = |person: &str, wallets: Vec<Wallet>, until, created_at, id: &str| MuteRecord {
            person: person.into(),
            wallets,
            until,
            created_at,
            id: id.into(),
        };
        let muted = vec![record("old", vec![wallet], 2_000, 10, "a")];
        // The same person by key, and a new account of theirs by the wallet.
        assert!(mute_holds(&muted, "old", &[], 1_000));
        assert!(mute_holds(&muted, "new", &[wallet], 1_000));
        assert!(!mute_holds(&muted, "new", &[other], 1_000));
        assert!(!mute_holds(&muted, "new", &[], 1_000));
        // It ends.
        assert!(!mute_holds(&muted, "old", &[wallet], 2_000));
        // A newer record lifts it (an end in the past), and an older record cannot bring it back.
        let lifted = vec![
            record("old", vec![wallet], 2_000, 10, "a"),
            record("old", vec![wallet], 5, 20, "b"),
        ];
        assert!(!mute_holds(&lifted, "old", &[wallet], 1_000));
        assert!(!mute_holds(&lifted, "new", &[wallet], 1_000));
        // The newest record decides which wallets follow.
        let moved = vec![
            record("old", vec![wallet], 2_000, 10, "a"),
            record("old", vec![other], 2_000, 20, "b"),
        ];
        assert!(!mute_holds(&moved, "new", &[wallet], 1_000));
        assert!(mute_holds(&moved, "new", &[other], 1_000));
    }

    #[test]
    fn a_mute_record_reads_its_person_wallets_and_end() {
        let record = event(
            47003,
            "{}",
            &[
                &["a", "37001:x:y"],
                &["room-mute", "abc"],
                &[
                    "room-mute-wallet",
                    "0x00000000000000000000000000000000000000aa",
                ],
                &["expiration", "1234"],
            ],
        );
        let read = mute_record_of(&record).expect("a mute");
        assert_eq!((read.person.as_str(), read.until), ("abc", 1_234));
        assert_eq!(read.wallets.len(), 1);
        assert!(mute_record_of(&event(47003, "{}", &[&["room-mute", "abc"]])).is_none());
        assert!(mute_record_of(&event(
            47003,
            "{}",
            &[&["room-mute", "abc"], &["expiration", "soon"]]
        ))
        .is_none());
    }
}
