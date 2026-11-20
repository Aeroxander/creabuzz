//! Public reads of a project's record on a server that requires membership.
//!
//! A project's record is made to be shown: what it promised, what it posted
//! each week, which promises it kept and which work was accepted. On an
//! invite-only server a caller who is not a member is refused every read, so a
//! shared scorecard link shows a stranger nothing. With
//! `BUZZ_PUBLIC_PROJECT_READS=1` the relay answers such a caller on
//! `POST /query`, and only there, under these rules, all enforced here:
//!
//! - **Which servers.** Only one whose operator made the whole server
//!   invite-only ([`AppState::public_project_reads`]). A community that chose
//!   invite-only for itself, on a server that lets communities choose, is not
//!   opened by the operator's setting.
//! - **Which kinds.** The project record (kind 37001) and records about a
//!   project (kind 47003); a project's holder room (kinds 1 and 7, only a filter
//!   that names one project's `#a` and the same project's `#t room:<chain key>`);
//!   the operator's seasons (kind 37021) and the season entries that name one
//!   season (kind 47003 with one `#t season-<n>`). Nothing else, whatever the
//!   filter asks for.
//! - **Which project.** Every filter names one project: a record filter by its
//!   id (`#d`), a filter for records about it by its address (`#a`). The
//!   project must pass [`crate::share_preview::public_standing`], the rule the
//!   link preview uses: listed, not removed, founder neither muted nor banned.
//!   A project that does not pass yields nothing, the same as one that does
//!   not exist. A project whose record states the terms of a sale is public
//!   like any other: the record is given whole, as its founder signed it, and
//!   a launchpad does not hide its launches.
//! - **Which records about it.** Kind 47003 holds many families of record, and
//!   most are for members. The ones served are listed, one by one, in
//!   [`is_served`]: the founder's goals and promises, the team's weekly
//!   updates and plain updates, and the three steps that make a piece of
//!   accepted work (the task, the work handed in, the team's confirmation),
//!   only once the work is confirmed and not sent back. Never served: work
//!   handed in that is still waiting or was sent back, the reasons given when
//!   sending work back, asks for more time, offers of help and the replies to
//!   them, answers to a team invitation, check notes, and every record about
//!   on-chain work (submitted evidence, a reviewer's reason, an agreement's
//!   words, a work area, a challenge). Only records stored for the whole
//!   community (never a room's), carrying the project's address, signed by
//!   someone who is neither muted nor banned.
//! - **How much.** At most [`MAX_FILTERS`] filters, [`MAX_LIMIT`] records per
//!   filter, a fixed number of lookups per project, one deadline, the caller's
//!   own request limit, a limit per client address, and one budget a minute
//!   for all public reads in the community (a caller who is not signed in can
//!   use a new key each time). What was read is kept for a short time
//!   ([`Kept`]) and only a read of the database is counted against the shared
//!   budget: everyone who is not a member gets the same answer.
//!
//! A request that is not exactly of this shape gets the membership refusal it
//! would have had without the setting. Writes never come here. With the
//! setting off this module is not reached.

use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::{
    http::{HeaderMap, StatusCode},
    response::Json,
};
use buzz_auth::LimitType;
use buzz_core::kind::{
    KIND_LAUNCH_RECORD, KIND_LAUNCH_UPDATE, KIND_REACTION, KIND_SEASON, KIND_TEXT_NOTE,
};
use buzz_core::{CommunityId, StoredEvent, TenantContext};
use buzz_db::DbError;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{api_error, db_read_error};
use crate::handlers::launch_update_authority::OPEN_WORK_KEYS;
use crate::share_preview::{public_standing, records_named, Founder, FOUNDER_PART};
use crate::state::AppState;

/// The kinds a caller who is not a member may be answered with.
pub(crate) const PUBLIC_KINDS: [u32; 5] = [
    KIND_LAUNCH_RECORD,
    KIND_LAUNCH_UPDATE,
    KIND_TEXT_NOTE,
    KIND_REACTION,
    KIND_SEASON,
];
/// The newest room posts (kind 1) read for one room, and the newest likes (kind 7). A room with more shows its newest.
const ROOM_POSTS_READ: i64 = 200;
const ROOM_LIKES_READ: i64 = 400;
/// How many signers of one room are checked for standing one by one (the signers of the records read are checked in
/// one query before that, so this only bounds what is looked up beyond them).
const ROOM_SIGNER_CHECKS: usize = 100;
/// The newest season records read, and the newest records of one season's lineup (500 entries and their leaves).
const SEASONS_READ: i64 = 50;
const ENTRIES_READ: i64 = 700;
/// The most filters one public read may carry.
pub(crate) const MAX_FILTERS: usize = 6;
/// The most records one filter is answered with.
pub(crate) const MAX_LIMIT: u64 = 200;
/// What a filter that names no limit is answered with.
const DEFAULT_LIMIT: u64 = 50;
/// The most values one list in a filter may hold (authors, labels, references).
const MAX_VALUES: usize = 50;
/// The longest a project id, label or reference may be.
const MAX_VALUE_CHARS: usize = 256;
/// How many project records under one id are checked for standing.
const MAX_STANDING_CHECKS: usize = 12;
/// How many signers, other than the founder, are checked for one project.
/// Records by signers past this are left out, never shown unchecked.
const MAX_SIGNER_CHECKS: usize = 40;
/// How many of a project's team are read for: the founder and the first of
/// the team its record lists. Records by anyone on the team past this are
/// left out.
const TEAM_READ: usize = 50;
/// How many of the team's newest confirmations and send-backs are read to
/// find the work that was accepted. Accepted work older than these is left out.
const ACCEPTED_READ: i64 = 500;
/// How many of the team's newest records about a project are read. A project
/// with more is "cut": see [`ReadError::TooLong`].
const TEAM_RECORDS_READ: i64 = 1000;
/// Longest one public read may take.
const DEADLINE: Duration = Duration::from_secs(5);
/// The window of the shared budget and of the limit per address, in seconds.
const BUDGET_WINDOW_SECS: u64 = 60;
/// How long an answer that is no longer fresh may still be given, and only
/// when the shared budget is spent: an old record is better than telling a
/// visitor to a popular link that nothing can be read.
const STALE_FOR: Duration = Duration::from_secs(300);
/// How long the server's example project is remembered per community.
const EXAMPLE_FOR: Duration = Duration::from_secs(60);
/// The most memory the kept answers may take, in bytes (an estimate).
const KEPT_BYTES: u64 = 64 * 1024 * 1024;

type Refusal = (StatusCode, Json<Value>);

/// What is kept in memory of public reads, per community: each project's
/// public record as last read, and the server's example project.
///
/// Everyone who is not a member is answered the same, so the database is read
/// once per project in `fresh` and every other request is answered from here
/// at no cost to the shared budget. The price is that a change (a new update,
/// a mute, a ban, a removal) reaches people who are not members up to `fresh`
/// later, and up to [`STALE_FOR`] later while the shared budget is spent.
/// With `fresh` zero nothing is kept.
pub(crate) struct Kept {
    fresh: Duration,
    sets: moka::sync::Cache<(CommunityId, SetKey), Arc<RecordSet>>,
    examples: moka::sync::Cache<CommunityId, Option<String>>,
}

impl Kept {
    /// Keep answers for `fresh_secs` seconds; zero keeps nothing.
    pub(crate) fn new(fresh_secs: u64) -> Self {
        Self {
            fresh: Duration::from_secs(fresh_secs),
            sets: moka::sync::Cache::builder()
                .max_capacity(KEPT_BYTES)
                .weigher(|_, set: &Arc<RecordSet>| set.bytes)
                .time_to_live(STALE_FOR)
                .build(),
            examples: moka::sync::Cache::builder()
                .max_capacity(10_000)
                .time_to_live(EXAMPLE_FOR)
                .build(),
        }
    }

    fn get(&self, community: CommunityId, key: &SetKey) -> Option<Arc<RecordSet>> {
        if self.fresh.is_zero() {
            return None;
        }
        self.sets.get(&(community, key.clone()))
    }

    fn put(&self, community: CommunityId, key: SetKey, set: Arc<RecordSet>) {
        if !self.fresh.is_zero() {
            self.sets.insert((community, key), set);
        }
    }

    /// The remembered example project of `community`: `None` when nothing is
    /// remembered, `Some(answer)` when it is (the answer itself may be "none").
    pub(crate) fn example(&self, community: CommunityId) -> Option<Option<String>> {
        if self.fresh.is_zero() {
            return None;
        }
        self.examples.get(&community)
    }

    /// Remember the example project of `community`.
    pub(crate) fn remember_example(&self, community: CommunityId, example: Option<String>) {
        if !self.fresh.is_zero() {
            self.examples.insert(community, example);
        }
    }
}

/// What one kept answer is about.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum SetKey {
    /// The public project records under one id, for one founder.
    Records { id: String, founder: Founder },
    /// Every record about one project that may be shown.
    About { coordinate: String },
    /// The posts and likes of one project's room that may be shown.
    Room { coordinate: String, room: String },
    /// The operator's season records (one number, or all).
    Seasons { number: Option<u32> },
    /// The entry, leave and removal records of one season.
    Entries { number: u32 },
}

/// Records that may be shown, newest first, as read at `read_at`.
struct RecordSet {
    events: Vec<nostr::Event>,
    /// The team has more records about the project than were read.
    cut: bool,
    read_at: Instant,
    bytes: u32,
}

impl RecordSet {
    fn new(mut events: Vec<nostr::Event>, cut: bool) -> Self {
        events.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(a.id.cmp(&b.id)));
        let bytes = events
            .iter()
            .map(|event| {
                400 + event.content.len()
                    + event
                        .tags
                        .iter()
                        .flat_map(|tag| tag.as_slice())
                        .map(|field| field.len() + 4)
                        .sum::<usize>()
            })
            .sum::<usize>();
        Self {
            events,
            cut,
            read_at: Instant::now(),
            bytes: u32::try_from(bytes).unwrap_or(u32::MAX).max(1),
        }
    }
}

/// Why a public read was not answered with records.
enum ReadError {
    Db(DbError),
    /// A limit was reached: the answer to give.
    Busy(Refusal),
    /// The project's team has more records than are read, and what was read
    /// does not fill the filter: an answer would pass for the whole record
    /// while older goals, updates or promises are missing from it.
    TooLong,
}

impl From<DbError> for ReadError {
    fn from(error: DbError) -> Self {
        Self::Db(error)
    }
}

/// One filter of a public read, already checked against the shape allowed.
#[derive(Debug, Clone, PartialEq, Eq)]
enum PublicFilter {
    /// The project record itself: `kinds: [37001]`, one `#d`, and at most one
    /// founder, named by a whole key (`authors`) or by the start of one as a
    /// scorecard address carries it (`founder_start`).
    Record {
        id: String,
        founder: Founder,
        limit: usize,
    },
    /// Records about one project: `kinds: [47003]`, one `#a`, optionally
    /// narrowed by who signed, a label, a referenced record and a time range.
    About {
        founder: String,
        id: String,
        coordinate: String,
        authors: Option<Vec<String>>,
        labels: Option<Vec<String>>,
        references: Option<Vec<String>>,
        since: Option<u64>,
        until: Option<u64>,
        limit: usize,
    },
    /// One project's holder room: `kinds` of 1 and 7, one `#a`, one `#t room:<chain key>`.
    Room {
        coordinate: String,
        room: String,
        kinds: Vec<u32>,
        since: Option<u64>,
        until: Option<u64>,
        limit: usize,
    },
    /// The operator's seasons: `kinds: [37021]`, optionally one `#d season-<n>`.
    Seasons { number: Option<u32>, limit: usize },
    /// One season's lineup: `kinds: [47003]`, one `#t season-<n>`, no `#a`; paged by `until`.
    Entries {
        number: u32,
        until: Option<u64>,
        limit: usize,
    },
}

fn is_hex(text: &str) -> bool {
    text.bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn is_key(text: &str) -> bool {
    text.len() == 64 && is_hex(text)
}

/// A non-empty list of at most [`MAX_VALUES`] short strings, or `None`.
fn strings(value: &Value) -> Option<Vec<String>> {
    let list = value.as_array()?;
    if list.is_empty() || list.len() > MAX_VALUES {
        return None;
    }
    list.iter()
        .map(|v| {
            v.as_str()
                .filter(|s| !s.is_empty() && s.chars().count() <= MAX_VALUE_CHARS)
                .map(str::to_string)
        })
        .collect()
}

fn limit_of(filter: &serde_json::Map<String, Value>) -> Option<usize> {
    match filter.get("limit") {
        None => Some(DEFAULT_LIMIT as usize),
        Some(value) => value
            .as_u64()
            .filter(|n| (1..=MAX_LIMIT).contains(n))
            .map(|n| n as usize),
    }
}

fn seconds(filter: &serde_json::Map<String, Value>, key: &str) -> Option<Option<u64>> {
    match filter.get(key) {
        None => Some(None),
        Some(value) => value.as_u64().filter(|n| *n <= i64::MAX as u64).map(Some),
    }
}

/// The number of `season-<n>`, when it is a canonical number from 1 to 9999.
fn season_number(text: &str) -> Option<u32> {
    let digits = text.strip_prefix("season-")?;
    let number: u32 = digits.parse().ok()?;
    (number.to_string() == digits && (1..=9_999).contains(&number)).then_some(number)
}

/// `37001:<founder key>:<project id>` taken apart, or `None`.
fn coordinate_parts(coordinate: &str) -> Option<(String, String)> {
    let rest = coordinate.strip_prefix(&format!("{KIND_LAUNCH_RECORD}:"))?;
    let (founder, id) = rest.split_once(':')?;
    (is_key(founder) && !id.is_empty()).then(|| (founder.to_string(), id.to_string()))
}

/// One filter, or `None` when it is anything but the two shapes allowed. Every
/// key is accounted for: a key this does not know makes the filter not public.
fn parse_filter(raw: &Value) -> Option<PublicFilter> {
    let filter = raw.as_object()?;
    let kinds: Vec<u32> = filter
        .get("kinds")?
        .as_array()?
        .iter()
        .map(|kind| u32::try_from(kind.as_u64()?).ok())
        .collect::<Option<_>>()?;
    let limit = limit_of(filter)?;
    let only = |allowed: &[&str]| filter.keys().all(|key| allowed.contains(&key.as_str()));

    // A holder room: posts and likes, of one project and its own room tag.
    if !kinds.is_empty()
        && kinds.len() <= 2
        && kinds
            .iter()
            .all(|k| matches!(*k, KIND_TEXT_NOTE | KIND_REACTION))
    {
        if !only(&["kinds", "#a", "#t", "since", "until", "limit"])
            || (kinds.len() == 2 && kinds[0] == kinds[1])
        {
            return None;
        }
        let [coordinate] = strings(filter.get("#a")?)?.try_into().ok()?;
        let [room] = strings(filter.get("#t")?)?.try_into().ok()?;
        coordinate_parts(&coordinate)?;
        crate::handlers::room_write::room_key(&room)?;
        return Some(PublicFilter::Room {
            coordinate,
            room,
            kinds,
            since: seconds(filter, "since")?,
            until: seconds(filter, "until")?,
            limit,
        });
    }
    let [kind] = kinds.as_slice() else {
        return None;
    };
    let kind = *kind;
    if kind == KIND_SEASON {
        if !only(&["kinds", "#d", "limit"]) {
            return None;
        }
        let number = match filter.get("#d") {
            None => None,
            Some(value) => {
                let [d] = strings(value)?.try_into().ok()?;
                Some(season_number(&d)?)
            }
        };
        return Some(PublicFilter::Seasons { number, limit });
    }
    // One season's lineup: records about projects, named by the season and not by a project.
    if kind == KIND_LAUNCH_UPDATE && filter.contains_key("#t") {
        if !only(&["kinds", "#t", "until", "limit"]) {
            return None;
        }
        let [topic] = strings(filter.get("#t")?)?.try_into().ok()?;
        return Some(PublicFilter::Entries {
            number: season_number(&topic)?,
            until: seconds(filter, "until")?,
            limit,
        });
    }

    if kind == KIND_LAUNCH_RECORD {
        if !only(&["kinds", "authors", "founder_start", "#d", "limit"]) {
            return None;
        }
        let [id] = strings(filter.get("#d")?)?.try_into().ok()?;
        let founder = match (filter.get("authors"), filter.get("founder_start")) {
            (None, None) => Founder::Anyone,
            (Some(value), None) => {
                let [author] = strings(value)?.try_into().ok()?;
                if !is_key(&author) {
                    return None;
                }
                Founder::Key(author)
            }
            (None, Some(value)) => {
                let start = value.as_str()?;
                if start.len() != FOUNDER_PART || !is_hex(start) {
                    return None;
                }
                Founder::Start(start.to_string())
            }
            (Some(_), Some(_)) => return None,
        };
        return Some(PublicFilter::Record { id, founder, limit });
    }
    if kind == KIND_LAUNCH_UPDATE {
        if !only(&[
            "kinds", "authors", "#a", "#l", "#e", "since", "until", "limit",
        ]) {
            return None;
        }
        let [coordinate] = strings(filter.get("#a")?)?.try_into().ok()?;
        let (founder, id) = coordinate_parts(&coordinate)?;
        let authors = match filter.get("authors") {
            None => None,
            Some(value) => {
                let authors = strings(value)?;
                if !authors.iter().all(|author| is_key(author)) {
                    return None;
                }
                Some(authors)
            }
        };
        let list = |key: &str| match filter.get(key) {
            None => Some(None),
            Some(value) => strings(value).map(Some),
        };
        return Some(PublicFilter::About {
            founder,
            id,
            coordinate,
            authors,
            labels: list("#l")?,
            references: list("#e")?,
            since: seconds(filter, "since")?,
            until: seconds(filter, "until")?,
            limit,
        });
    }
    None
}

/// The filters of a request body, or `None` when the body is not a public read.
fn parse(body: &[u8]) -> Option<Vec<PublicFilter>> {
    let raw: Vec<Value> = serde_json::from_slice(body).ok()?;
    if raw.is_empty() || raw.len() > MAX_FILTERS {
        return None;
    }
    raw.iter().map(parse_filter).collect()
}

/// The account a count is kept under: a hash of `label`, not a key anyone
/// made, so no caller can sign in as it and no real account's own limit shares
/// its counter.
fn counter_account(label: &str) -> Option<nostr::PublicKey> {
    (0u32..256).find_map(|n| {
        let digest = Sha256::digest(format!("buzz:public-project-reads:{label}:{n}"));
        nostr::PublicKey::from_slice(&digest).ok()
    })
}

/// The address the request came from, as the proxy in front of the relay
/// wrote it: the last entry of `X-Forwarded-For` (a proxy appends the address
/// it saw; anything before it is the client's own claim). An IPv6 address is
/// cut to its network, since one machine holds a whole one. `None` without
/// the header: such a request is held to the shared budget alone.
pub(crate) fn client_address(headers: &HeaderMap) -> Option<String> {
    let last = headers
        .get_all("x-forwarded-for")
        .iter()
        .next_back()?
        .to_str()
        .ok()?
        .rsplit(',')
        .next()?
        .trim();
    match last.parse::<IpAddr>().ok()? {
        IpAddr::V4(address) => Some(address.to_string()),
        IpAddr::V6(address) => {
            let network = address.segments();
            Some(format!(
                "{:x}:{:x}:{:x}:{:x}::/64",
                network[0], network[1], network[2], network[3]
            ))
        }
    }
}

/// Count one read under `label` in this community, against `limit` a minute.
async fn spend(
    state: &AppState,
    tenant: &TenantContext,
    label: &str,
    limit: u64,
) -> Result<(), crate::admission::AdmissionError> {
    let account = counter_account(label).ok_or(crate::admission::AdmissionError::Unavailable)?;
    crate::admission::check_principal(
        state.admission_rate_limiter.as_ref(),
        tenant,
        &account,
        LimitType::ApiCalls,
        BUDGET_WINDOW_SECS,
        limit,
    )
    .await
}

fn busy(error: crate::admission::AdmissionError) -> Refusal {
    match error {
        crate::admission::AdmissionError::Exceeded { reset_in_secs } => api_error(
            StatusCode::TOO_MANY_REQUESTS,
            &format!("rate-limited: public reads are busy; retry in {reset_in_secs}s"),
        ),
        crate::admission::AdmissionError::Unavailable => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "rate-limited: shared admission unavailable",
        ),
    }
}

fn tag_value<'a>(event: &'a nostr::Event, name: &str) -> Option<&'a str> {
    event.tags.iter().find_map(|tag| {
        let fields = tag.as_slice();
        (fields.first().map(String::as_str) == Some(name))
            .then(|| fields.get(1).map(String::as_str))
            .flatten()
    })
}

fn has_tag(event: &nostr::Event, name: &str, value: &str) -> bool {
    event.tags.iter().any(|tag| {
        let fields = tag.as_slice();
        fields.first().map(String::as_str) == Some(name)
            && fields.get(1).map(String::as_str) == Some(value)
    })
}

/// Whether a stored record is one the public read of the project at
/// `coordinate` may look at: a record about a project, kept for the whole
/// community (one stored for a room is the room's, whatever address it
/// carries), and carrying this project's address.
fn is_the_projects_own(record: &StoredEvent, coordinate: &str) -> bool {
    u32::from(record.event.kind.as_u16()) == KIND_LAUNCH_UPDATE
        && record.channel_id.is_none()
        && has_tag(&record.event, "a", coordinate)
}

/// A project's founder and the team its record lists, as far as it is read for.
struct Team {
    founder: String,
    /// The founder and up to [`TEAM_READ`] - 1 others, as keys in hex.
    members: Vec<String>,
}

impl Team {
    /// The founder is the record's author; the team is every
    /// `["team", <key>, <role>]` tag, as the write check and the web app read it.
    fn of(record: &nostr::Event) -> Self {
        let founder = record.pubkey.to_hex();
        let mut members = vec![founder.clone()];
        for tag in record.tags.iter() {
            let fields = tag.as_slice();
            if members.len() >= TEAM_READ {
                break;
            }
            if fields.len() >= 3
                && fields[0] == "team"
                && is_key(&fields[1])
                && !members.contains(&fields[1])
            {
                members.push(fields[1].clone());
            }
        }
        Self { founder, members }
    }

    fn has(&self, who: &str) -> bool {
        self.members.iter().any(|member| member == who)
    }

    fn keys(&self) -> Vec<Vec<u8>> {
        self.members
            .iter()
            .filter_map(|member| hex::decode(member).ok())
            .collect()
    }
}

/// The work a project's team accepted: handed-in pieces a team member
/// confirmed and nobody on the team sent back.
#[derive(Default)]
struct Accepted {
    /// The handed-in records (`task-part` = evidence), by id.
    pieces: HashSet<String>,
    /// The tasks those pieces answer, by id.
    tasks: HashSet<String>,
    /// Task id to the helper its task record names.
    helpers: HashMap<String, String>,
}

/// Whether a record about a project is one a caller who is not a member may
/// be given. This is the whole list; anything it does not name is not served.
///
/// | the record                                   | served when                                   |
/// |----------------------------------------------|-----------------------------------------------|
/// | a goal, a promise, a promise's answer        | the founder signed it                         |
/// | a weekly update (`update-part`, `update-kind`, `help-needed`) | the founder or the team signed it |
/// | a plain update (no family tag; body holds only `title`, `body`, `links`) | the founder or the team signed it |
/// | a task (`task-part` = task)                  | the team signed it and its work was accepted, |
/// |                                              | or it is open to anyone (no `task-helper`, a  |
/// |                                              | `task-usd`), so a visitor sees a task to take |
/// | work handed in (`task-part` = evidence)      | the task's helper signed it and it was accepted |
/// | a confirmation (`task-part` = confirm)       | the team signed it, for work that was accepted |
/// | anything else                                | never                                         |
///
/// "Accepted" is [`Accepted`]: confirmed by the team and not sent back. A
/// record whose body carries one of [`OPEN_WORK_KEYS`] or a `check` is about
/// on-chain work or is a check note, and is never served whatever its tags
/// say; nor is one that carries tags of two families the table keeps apart.
fn is_served(event: &nostr::Event, team: &Team, accepted: &Accepted) -> bool {
    let signer = event.pubkey.to_hex();
    let mut founders = false;
    let mut weekly = false;
    let mut steps: Vec<&str> = Vec::new();
    for tag in event.tags.iter() {
        let fields = tag.as_slice();
        match fields.first().map(String::as_str) {
            Some("goal" | "promise" | "promise-mark") => founders = true,
            Some("update-part" | "update-kind" | "help-needed") => weekly = true,
            // An offer of help, the team's reply to one, "help found", an answer to a team invitation, an ask to join.
            Some(
                "help-offer" | "help-reply" | "help-found" | "team-answer" | "join-ask"
                | "join-decline",
            ) => return false,
            Some("task-part") => steps.push(fields.get(1).map(String::as_str).unwrap_or("")),
            _ => {}
        }
    }
    let body = serde_json::from_str::<Value>(event.content.as_str()).ok();
    let body = body.as_ref().and_then(Value::as_object);
    if body.is_some_and(|body| {
        body.contains_key("check") || OPEN_WORK_KEYS.iter().any(|key| body.contains_key(*key))
    }) {
        return false;
    }

    match steps.as_slice() {
        [] => {}
        [step] if !founders && !weekly => {
            let id = event.id.to_hex();
            return match *step {
                "task" => {
                    team.has(&signer) && (accepted.tasks.contains(&id) || is_open_task(event))
                }
                "confirm" => {
                    team.has(&signer)
                        && tag_value(event, "task-evidence")
                            .is_some_and(|piece| accepted.pieces.contains(piece))
                }
                "evidence" => {
                    accepted.pieces.contains(&id)
                        && tag_value(event, "task")
                            .and_then(|task| accepted.helpers.get(task))
                            .is_some_and(|helper| *helper == signer)
                }
                // Sent back, more time asked or granted, given up, cancelled, a helper's yes: for members.
                _ => false,
            };
        }
        _ => return false,
    }
    if founders {
        return signer == team.founder;
    }
    if weekly {
        return team.has(&signer);
    }
    // No family tag: a plain update, and only when its body is nothing but one.
    team.has(&signer)
        && body.is_some_and(|body| {
            body.keys()
                .all(|key| matches!(key.as_str(), "title" | "body" | "links"))
        })
}

/// Whether a task record is open to anyone: it names no helper and says what it pays. Takes are signed by people
/// outside the team and are not served, so a visitor may see a task someone has already taken; the taker's work, once
/// accepted, is not served either (the report of milestone 8 lists both).
fn is_open_task(event: &nostr::Event) -> bool {
    tag_value(event, "task-helper").is_none() && tag_value(event, "task-usd").is_some()
}

/// What one request has looked up, so no project is read twice in it.
struct Lookups<'a> {
    state: &'a AppState,
    tenant: &'a TenantContext,
    community: CommunityId,
    sets: HashMap<SetKey, Arc<RecordSet>>,
}

/// Whether records by each signer may be shown (neither muted nor banned),
/// for the signers of one project, at most [`MAX_SIGNER_CHECKS`] of them.
struct Signers<'a> {
    state: &'a AppState,
    community: CommunityId,
    known: HashMap<[u8; 32], bool>,
    checks: usize,
    /// How many signers are asked about.
    max: usize,
}

impl Signers<'_> {
    /// Look up every signer in `signers` that is not known yet in one query, so a room or a season of any number of
    /// signers is judged whole (the one-by-one bound is for what is read signer by signer). One check is counted.
    async fn prefetch(
        &mut self,
        signers: impl IntoIterator<Item = [u8; 32]>,
    ) -> Result<(), DbError> {
        let mut asked: Vec<[u8; 32]> = signers
            .into_iter()
            .filter(|signer| !self.known.contains_key(signer))
            .collect();
        asked.sort_unstable();
        asked.dedup();
        if asked.is_empty() {
            return Ok(());
        }
        self.checks += 1;
        let list: Vec<Vec<u8>> = asked.iter().map(|signer| signer.to_vec()).collect();
        let restricted = self
            .state
            .db
            .moderation_restricted_among(self.community, &list)
            .await?;
        for signer in asked {
            self.known
                .insert(signer, !restricted.contains(signer.as_slice()));
        }
        Ok(())
    }

    async fn shown(&mut self, signer: [u8; 32]) -> Result<bool, DbError> {
        if let Some(known) = self.known.get(&signer) {
            return Ok(*known);
        }
        // Past the bound nothing more is checked, and what is not checked is not shown.
        if self.checks >= self.max {
            return Ok(false);
        }
        self.checks += 1;
        let restriction = self
            .state
            .db
            .moderation_restriction_state(self.community, &signer)
            .await?;
        let shown = !restriction.banned && restriction.muted_until.is_none();
        self.known.insert(signer, shown);
        Ok(shown)
    }
}

impl<'a> Lookups<'a> {
    fn new(state: &'a AppState, tenant: &'a TenantContext) -> Self {
        Self {
            state,
            tenant,
            community: tenant.community(),
            sets: HashMap::new(),
        }
    }

    /// The records `key` names: from this request, from what is kept while it
    /// is fresh, or read from the database, which is the one step counted
    /// against the community's shared budget. When the budget is spent, what
    /// is kept is given a while longer ([`STALE_FOR`]) rather than nothing.
    async fn set(&mut self, key: SetKey) -> Result<Arc<RecordSet>, ReadError> {
        if let Some(set) = self.sets.get(&key) {
            return Ok(set.clone());
        }
        let kept = self.state.public_reads.get(self.community, &key);
        let set = match kept {
            Some(set) if set.read_at.elapsed() < self.state.public_reads.fresh => set,
            kept => {
                let spent = spend(
                    self.state,
                    self.tenant,
                    "budget",
                    self.state.config.public_project_reads_per_min,
                )
                .await;
                match (spent, kept) {
                    (Ok(()), _) => {
                        let set = Arc::new(match &key {
                            SetKey::Records { id, founder } => {
                                RecordSet::new(self.read_records(id, founder).await?, false)
                            }
                            SetKey::About { coordinate } => self.read_about(coordinate).await?,
                            SetKey::Room { coordinate, room } => {
                                self.read_room(coordinate, room).await?
                            }
                            SetKey::Seasons { number } => {
                                RecordSet::new(self.read_seasons(*number).await?, false)
                            }
                            SetKey::Entries { number } => {
                                RecordSet::new(self.read_entries(*number).await?, false)
                            }
                        });
                        self.state
                            .public_reads
                            .put(self.community, key.clone(), set.clone());
                        set
                    }
                    (Err(crate::admission::AdmissionError::Exceeded { .. }), Some(set)) => set,
                    (Err(error), _) => return Err(ReadError::Busy(busy(error))),
                }
            }
        };
        self.sets.insert(key, set.clone());
        Ok(set)
    }

    /// The project records under `id` for `founder` that may be shown.
    async fn read_records(
        &self,
        id: &str,
        founder: &Founder,
    ) -> Result<Vec<nostr::Event>, DbError> {
        let mut shown = Vec::new();
        // Past the bound nothing more is checked, and what is not checked is not shown.
        for record in records_named(self.state, self.community, id, founder)
            .await?
            .into_iter()
            .take(MAX_STANDING_CHECKS)
        {
            if let Some(project) = public_standing(self.state, self.community, record).await? {
                shown.push(project.record);
            }
        }
        Ok(shown)
    }

    async fn about(
        &self,
        coordinate: &str,
        team: &Team,
        step: Option<&str>,
        ids: Option<Vec<Vec<u8>>>,
        limit: i64,
    ) -> Result<Vec<StoredEvent>, DbError> {
        let mut tag_filters = vec![("a".to_string(), vec![coordinate.to_string()])];
        if let Some(step) = step {
            tag_filters.push(("task-part".to_string(), vec![step.to_string()]));
        }
        let stored = self
            .state
            .db
            // The writer, as the link preview reads: a copy that lags could still hold a record its signer deleted.
            .query_events(&buzz_db::EventQuery {
                kinds: Some(vec![KIND_LAUNCH_UPDATE as i32]),
                // Work handed in is asked for by id; everything else only from the team.
                authors: ids.is_none().then(|| team.keys()),
                ids,
                tag_filters,
                global_only: true,
                limit: Some(limit),
                ..buzz_db::EventQuery::for_community(self.community)
            })
            .await?;
        // Asked of the database (`global_only`: a room's records are not read at all, so however many a room holds
        // they cannot fill the limit and crowd the project's own records out), and checked again on what came back.
        Ok(stored
            .into_iter()
            .filter(|record| is_the_projects_own(record, coordinate))
            .collect())
    }

    /// The posts and likes of the room `room` of the project at `coordinate` that may be shown: none unless the project
    /// passes [`public_standing`] and the room tag is the project's own chain key; the newest [`ROOM_POSTS_READ`] posts
    /// and [`ROOM_LIKES_READ`] likes (a room with more is `cut`), by signers who are neither muted nor banned.
    async fn read_room(&self, coordinate: &str, room: &str) -> Result<RecordSet, DbError> {
        let nothing = || RecordSet::new(Vec::new(), false);
        let Some((founder, id)) = coordinate_parts(coordinate) else {
            return Ok(nothing());
        };
        let Some(record) = self
            .read_records(&id, &Founder::Key(founder))
            .await?
            .into_iter()
            .next()
        else {
            return Ok(nothing());
        };
        let own_room = crate::handlers::task_chain::chain_key_of(&record)
            .map(|key| format!("room:0x{}", hex::encode(key)));
        if own_room.as_deref() != Some(room) {
            return Ok(nothing());
        }
        let mut signers = Signers {
            state: self.state,
            community: self.community,
            known: HashMap::from([(record.pubkey.to_bytes(), true)]),
            checks: 0,
            max: ROOM_SIGNER_CHECKS,
        };
        let (mut shown, mut cut) = (Vec::new(), false);
        for (kind, read) in [
            (KIND_TEXT_NOTE, ROOM_POSTS_READ),
            (KIND_REACTION, ROOM_LIKES_READ),
        ] {
            let stored = self
                .state
                .db
                .query_events(&buzz_db::EventQuery {
                    kinds: Some(vec![kind as i32]),
                    tag_filters: vec![
                        ("a".to_string(), vec![coordinate.to_string()]),
                        ("t".to_string(), vec![room.to_string()]),
                    ],
                    global_only: true,
                    limit: Some(read),
                    ..buzz_db::EventQuery::for_community(self.community)
                })
                .await?;
            cut |= stored.len() as i64 >= read;
            signers
                .prefetch(stored.iter().map(|post| post.event.pubkey.to_bytes()))
                .await?;
            for post in stored {
                let event = post.event;
                if post.channel_id.is_none()
                    && has_tag(&event, "a", coordinate)
                    && has_tag(&event, "t", room)
                    && signers.shown(event.pubkey.to_bytes()).await?
                {
                    shown.push(event);
                }
            }
        }
        Ok(RecordSet::new(shown, cut))
    }

    /// The season records (one number, or the newest of all) signed by a current operator of the server.
    async fn read_seasons(&self, number: Option<u32>) -> Result<Vec<nostr::Event>, DbError> {
        let stored = self
            .state
            .db
            .query_events(&buzz_db::EventQuery {
                kinds: Some(vec![KIND_SEASON as i32]),
                d_tag: number.map(crate::handlers::season_rules::season_d),
                global_only: true,
                limit: Some(SEASONS_READ),
                ..buzz_db::EventQuery::for_community(self.community)
            })
            .await?;
        Ok(stored
            .into_iter()
            .map(|record| record.event)
            .filter(|event| {
                crate::handlers::season_rules::is_operator(self.state, &event.pubkey.to_hex())
                    && crate::handlers::season_rules::parse_season_record(event).is_ok()
            })
            .collect())
    }

    /// One season's entry, leave and removal records, newest first, at most [`ENTRIES_READ`], by signers who are
    /// neither muted nor banned. The app checks each against the project's own team.
    async fn read_entries(&self, number: u32) -> Result<Vec<nostr::Event>, DbError> {
        let stored = self
            .state
            .db
            .query_events(&buzz_db::EventQuery {
                kinds: Some(vec![KIND_LAUNCH_UPDATE as i32]),
                tag_filters: vec![(
                    "t".to_string(),
                    vec![crate::handlers::season_rules::season_d(number)],
                )],
                global_only: true,
                limit: Some(ENTRIES_READ),
                ..buzz_db::EventQuery::for_community(self.community)
            })
            .await?;
        let mut signers = Signers {
            state: self.state,
            community: self.community,
            known: HashMap::new(),
            checks: 0,
            max: ROOM_SIGNER_CHECKS,
        };
        signers
            .prefetch(stored.iter().map(|record| record.event.pubkey.to_bytes()))
            .await?;
        let mut shown = Vec::new();
        for record in stored {
            let event = record.event;
            let is_entry = matches!(
                crate::handlers::season_rules::classify_step(&event),
                Ok(Some(step)) if step.number == number
            );
            if record.channel_id.is_none()
                && is_entry
                && signers.shown(event.pubkey.to_bytes()).await?
            {
                shown.push(event);
            }
        }
        Ok(shown)
    }

    /// Every record about the project at `coordinate` that may be shown: see [`is_served`].
    async fn read_about(&self, coordinate: &str) -> Result<RecordSet, DbError> {
        let nothing = || RecordSet::new(Vec::new(), false);
        let Some((founder, id)) = coordinate_parts(coordinate) else {
            return Ok(nothing());
        };
        let Some(record) = self
            .read_records(&id, &Founder::Key(founder))
            .await?
            .into_iter()
            .next()
        else {
            return Ok(nothing());
        };
        let team = Team::of(&record);
        let mut signers = Signers {
            state: self.state,
            community: self.community,
            // A founder who may be shown needs no second check as a signer.
            known: HashMap::from([(record.pubkey.to_bytes(), true)]),
            checks: 0,
            max: MAX_SIGNER_CHECKS,
        };

        // The work that was accepted: what the team confirmed, less what the team sent back.
        let mut accepted = Accepted::default();
        let mut task_of_piece: HashMap<String, String> = HashMap::new();
        for confirmation in self
            .about(coordinate, &team, Some("confirm"), None, ACCEPTED_READ)
            .await?
        {
            let event = &confirmation.event;
            if !team.has(&event.pubkey.to_hex()) || !signers.shown(event.pubkey.to_bytes()).await? {
                continue;
            }
            if let (Some(piece), Some(task)) =
                (tag_value(event, "task-evidence"), tag_value(event, "task"))
            {
                task_of_piece.insert(piece.to_string(), task.to_string());
            }
        }
        if !task_of_piece.is_empty() {
            for sent_back in self
                .about(coordinate, &team, Some("send-back"), None, ACCEPTED_READ)
                .await?
            {
                if team.has(&sent_back.event.pubkey.to_hex()) {
                    if let Some(piece) = tag_value(&sent_back.event, "task-evidence") {
                        task_of_piece.remove(piece);
                    }
                }
            }
        }
        accepted.tasks = task_of_piece.values().cloned().collect();
        accepted.pieces = task_of_piece.into_keys().collect();

        let own = self
            .about(coordinate, &team, None, None, TEAM_RECORDS_READ)
            .await?;
        let cut = own.len() as i64 >= TEAM_RECORDS_READ;
        for task in &own {
            let id = task.event.id.to_hex();
            if accepted.tasks.contains(&id) && has_tag(&task.event, "task-part", "task") {
                if let Some(helper) = tag_value(&task.event, "task-helper") {
                    accepted.helpers.insert(id, helper.to_string());
                }
            }
        }
        let pieces: Vec<Vec<u8>> = accepted
            .pieces
            .iter()
            .filter_map(|piece| hex::decode(piece).ok())
            .collect();
        let handed_in = if pieces.is_empty() {
            Vec::new()
        } else {
            let limit = pieces.len() as i64;
            self.about(coordinate, &team, Some("evidence"), Some(pieces), limit)
                .await?
        };

        let mut seen = HashSet::new();
        let mut shown = Vec::new();
        for record in own.into_iter().chain(handed_in) {
            let event = record.event;
            if !seen.insert(event.id) || !is_served(&event, &team, &accepted) {
                continue;
            }
            if signers.shown(event.pubkey.to_bytes()).await? {
                shown.push(event);
            }
        }
        Ok(RecordSet::new(shown, cut))
    }
}

/// The records `filter` is answered with.
async fn answer_filter(
    lookups: &mut Lookups<'_>,
    filter: &PublicFilter,
) -> Result<Vec<nostr::Event>, ReadError> {
    match filter {
        PublicFilter::Record { id, founder, limit } => {
            let set = lookups
                .set(SetKey::Records {
                    id: id.clone(),
                    founder: founder.clone(),
                })
                .await?;
            Ok(set.events.iter().take(*limit).cloned().collect())
        }
        PublicFilter::About {
            coordinate,
            authors,
            labels,
            references,
            since,
            until,
            limit,
            ..
        } => {
            let set = lookups
                .set(SetKey::About {
                    coordinate: coordinate.clone(),
                })
                .await?;
            let any_of = |name: &str, values: &Option<Vec<String>>, event: &nostr::Event| {
                values
                    .as_ref()
                    .is_none_or(|values| values.iter().any(|value| has_tag(event, name, value)))
            };
            let shown: Vec<nostr::Event> = set
                .events
                .iter()
                .filter(|event| {
                    let at = event.created_at.as_secs();
                    authors
                        .as_ref()
                        .is_none_or(|authors| authors.contains(&event.pubkey.to_hex()))
                        && any_of("l", labels, event)
                        && any_of("e", references, event)
                        && since.is_none_or(|since| at >= since)
                        && until.is_none_or(|until| at <= until)
                })
                .take(*limit)
                .cloned()
                .collect();
            if set.cut && shown.len() < *limit {
                return Err(ReadError::TooLong);
            }
            Ok(shown)
        }
        PublicFilter::Room {
            coordinate,
            room,
            kinds,
            since,
            until,
            limit,
        } => {
            let set = lookups
                .set(SetKey::Room {
                    coordinate: coordinate.clone(),
                    room: room.clone(),
                })
                .await?;
            Ok(set
                .events
                .iter()
                .filter(|event| {
                    let at = event.created_at.as_secs();
                    kinds.contains(&u32::from(event.kind.as_u16()))
                        && since.is_none_or(|since| at >= since)
                        && until.is_none_or(|until| at <= until)
                })
                .take(*limit)
                .cloned()
                .collect())
        }
        PublicFilter::Seasons { number, limit } => {
            let set = lookups.set(SetKey::Seasons { number: *number }).await?;
            Ok(set.events.iter().take(*limit).cloned().collect())
        }
        PublicFilter::Entries {
            number,
            until,
            limit,
        } => {
            let set = lookups.set(SetKey::Entries { number: *number }).await?;
            Ok(set
                .events
                .iter()
                .filter(|event| until.is_none_or(|until| event.created_at.as_secs() <= until))
                .take(*limit)
                .cloned()
                .collect())
        }
    }
}

/// Answer a caller the membership check turned away, when the server lets
/// anyone read a public project's record and the request is exactly such a
/// read; otherwise hand back `refusal`, the answer they would have had.
pub(crate) async fn answer(
    state: &AppState,
    tenant: &TenantContext,
    caller: &nostr::PublicKey,
    headers: &HeaderMap,
    body: &[u8],
    refusal: Refusal,
) -> Result<Json<Value>, Refusal> {
    // Only "you are not a member" may be answered another way: a ban, a failed lookup or anything else stands.
    if !state.public_project_reads() || !super::relay_members::is_membership_refusal(&refusal) {
        return Err(refusal);
    }
    let Some(filters) = parse(body) else {
        return Err(refusal);
    };
    // One machine first: it must not be able to spend what everyone shares.
    if let Some(address) = client_address(headers) {
        spend(
            state,
            tenant,
            &format!("address:{address}"),
            state.config.public_project_reads_per_address_min,
        )
        .await
        .map_err(busy)?;
    }
    // A ban turns a person away from the community whole; it does not lapse because they are also not a member.
    // Asked before anything is counted against the shared budget: someone turned away spends none of it.
    let caller_state = state
        .db
        .moderation_restriction_state(tenant.community(), caller.as_bytes())
        .await
        .map_err(|e| db_read_error("public read: caller standing", &e))?;
    if caller_state.banned {
        return Err(refusal);
    }

    let read = async {
        let mut lookups = Lookups::new(state, tenant);
        let mut seen = HashSet::new();
        let mut events = Vec::new();
        for filter in &filters {
            for event in answer_filter(&mut lookups, filter).await? {
                if !PUBLIC_KINDS.contains(&u32::from(event.kind.as_u16())) || !seen.insert(event.id)
                {
                    continue;
                }
                if let Ok(value) = serde_json::to_value(&event) {
                    events.push(value);
                }
            }
        }
        Ok::<_, ReadError>(events)
    };
    match tokio::time::timeout(DEADLINE, read).await {
        Ok(Ok(events)) => Ok(Json(Value::Array(events))),
        Ok(Err(ReadError::Db(e))) => Err(db_read_error("public read", &e)),
        Ok(Err(ReadError::Busy(answer))) => Err(answer),
        Ok(Err(ReadError::TooLong)) => Err(api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable: this project's record is too long to read without an invite",
        )),
        Err(_) => Err(api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            super::QUERY_TIMED_OUT,
        )),
    }
}

#[cfg(test)]
mod postgres_tests;
#[cfg(test)]
mod room_postgres_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const FOUNDER: &str = "ab12cd34ef56ab78ab12cd34ef56ab78ab12cd34ef56ab78ab12cd34ef56ab78";

    fn body(filters: Value) -> Vec<u8> {
        serde_json::to_vec(&filters).expect("json")
    }

    #[test]
    fn the_two_shapes_are_read() {
        let coordinate = format!("37001:{FOUNDER}:nebula");
        let filters = parse(&body(json!([
            {"kinds": [37001], "#d": ["nebula"]},
            {"kinds": [37001], "#d": ["nebula"], "authors": [FOUNDER], "limit": 1},
            {"kinds": [37001], "#d": ["nebula"], "founder_start": "ab12cd34ef56ab78"},
            {"kinds": [47003], "#a": [coordinate], "authors": [FOUNDER], "#l": ["task"],
             "#e": ["ff"], "since": 1, "until": 2, "limit": 200},
        ])))
        .expect("public filters");
        assert_eq!(
            filters[0],
            PublicFilter::Record {
                id: "nebula".into(),
                founder: Founder::Anyone,
                limit: DEFAULT_LIMIT as usize
            }
        );
        assert_eq!(
            filters[1],
            PublicFilter::Record {
                id: "nebula".into(),
                founder: Founder::Key(FOUNDER.into()),
                limit: 1
            }
        );
        // A scorecard address carries the start of the founder's key: the read names it, so the server can look
        // for that founder alone.
        assert_eq!(
            filters[2],
            PublicFilter::Record {
                id: "nebula".into(),
                founder: Founder::Start("ab12cd34ef56ab78".into()),
                limit: DEFAULT_LIMIT as usize
            }
        );
        assert_eq!(
            filters[3],
            PublicFilter::About {
                founder: FOUNDER.into(),
                id: "nebula".into(),
                coordinate,
                authors: Some(vec![FOUNDER.into()]),
                labels: Some(vec!["task".into()]),
                references: Some(vec!["ff".into()]),
                since: Some(1),
                until: Some(2),
                limit: 200,
            }
        );
    }

    #[test]
    fn anything_else_is_not_a_public_read() {
        let coordinate = format!("37001:{FOUNDER}:nebula");
        let not_public = [
            // No filter, too many filters, not a list, not objects.
            json!([]),
            json!([
                {"kinds": [37001], "#d": ["a"]}, {"kinds": [37001], "#d": ["a"]},
                {"kinds": [37001], "#d": ["a"]}, {"kinds": [37001], "#d": ["a"]},
                {"kinds": [37001], "#d": ["a"]}, {"kinds": [37001], "#d": ["a"]},
                {"kinds": [37001], "#d": ["a"]}
            ]),
            json!({"kinds": [37001], "#d": ["nebula"]}),
            json!(["kinds"]),
            // No kinds, an empty list, another kind, two kinds, a kind beside an allowed one.
            json!([{"#d": ["nebula"]}]),
            json!([{"#a": [coordinate]}]),
            json!([{"kinds": [], "#d": ["nebula"]}]),
            json!([{"kinds": [1], "#a": [coordinate]}]),
            json!([{"kinds": [0], "authors": [FOUNDER]}]),
            json!([{"kinds": [37001, 47003], "#d": ["nebula"]}]),
            json!([{"kinds": [47003, 1], "#a": [coordinate]}]),
            json!([{"kinds": ["37001"], "#d": ["nebula"]}]),
            // A record filter that names no project, or several, or reaches by id.
            json!([{"kinds": [37001]}]),
            json!([{"kinds": [37001], "authors": [FOUNDER]}]),
            json!([{"kinds": [37001], "#d": ["a", "b"]}]),
            json!([{"kinds": [37001], "#d": [""]}]),
            json!([{"kinds": [37001], "#d": ["nebula"], "ids": ["ff"]}]),
            json!([{"kinds": [37001], "#d": ["nebula"], "authors": [FOUNDER, FOUNDER]}]),
            json!([{"kinds": [37001], "#d": ["nebula"], "authors": ["not a key"]}]),
            json!([{"kinds": [37001], "#d": ["nebula"], "#a": [coordinate]}]),
            // The start of a founder's key: the length a scorecard address carries, lowercase, and not beside a key.
            json!([{"kinds": [37001], "#d": ["nebula"], "founder_start": "ab12"}]),
            json!([{"kinds": [37001], "#d": ["nebula"], "founder_start": "AB12CD34EF56AB78"}]),
            json!([{"kinds": [37001], "#d": ["nebula"], "founder_start": ["ab12cd34ef56ab78"]}]),
            json!([{"kinds": [37001], "#d": ["nebula"], "founder_start": "ab12cd34ef56ab78",
                    "authors": [FOUNDER]}]),
            json!([{"kinds": [47003], "#a": [coordinate], "founder_start": "ab12cd34ef56ab78"}]),
            // Records about a project that name no project, several, or something that is not a project.
            json!([{"kinds": [47003]}]),
            json!([{"kinds": [47003], "authors": [FOUNDER]}]),
            json!([{"kinds": [47003], "#a": [coordinate, coordinate]}]),
            json!([{"kinds": [47003], "#a": ["30023:".to_string() + FOUNDER + ":nebula"]}]),
            json!([{"kinds": [47003], "#a": ["37001:short:nebula"]}]),
            json!([{"kinds": [47003], "#a": [format!("37001:{FOUNDER}:")]}]),
            json!([{"kinds": [47003], "#e": ["ff"]}]),
            // Keys outside the shape: ids, other tags, search, and the bridge's own extensions.
            json!([{"kinds": [47003], "#a": [coordinate], "ids": ["ff"]}]),
            json!([{"kinds": [47003], "#a": [coordinate], "#h": ["room"]}]),
            json!([{"kinds": [47003], "#a": [coordinate], "#p": [FOUNDER]}]),
            json!([{"kinds": [47003], "#a": [coordinate], "search": "x"}]),
            json!([{"kinds": [47003], "#a": [coordinate], "top_level": true}]),
            json!([{"kinds": [47003], "#a": [coordinate], "feed_types": ["activity"]}]),
            json!([{"kinds": [47003], "#a": [coordinate], "before_id": "ff"}]),
            json!([{"kinds": [47003], "#a": [coordinate], "consistency": "strong"}]),
            // Bounds: the limit, the lists, the times.
            json!([{"kinds": [47003], "#a": [coordinate], "limit": 0}]),
            json!([{"kinds": [47003], "#a": [coordinate], "limit": 201}]),
            json!([{"kinds": [47003], "#a": [coordinate], "limit": "5"}]),
            json!([{"kinds": [47003], "#a": [coordinate], "authors": []}]),
            json!([{"kinds": [47003], "#a": [coordinate], "authors": ["AB12"]}]),
            json!([{"kinds": [47003], "#a": [coordinate], "#l": [1]}]),
            json!([{"kinds": [47003], "#a": [coordinate], "since": -1}]),
            json!([{"kinds": [47003], "#a": [coordinate], "until": "now"}]),
            json!([{"kinds": [47003], "#a": [coordinate],
                    "#l": (0..51).map(|n| n.to_string()).collect::<Vec<_>>()}]),
            // One filter outside the shape refuses the whole read.
            json!([{"kinds": [37001], "#d": ["nebula"]}, {"kinds": [1]}]),
        ];
        for filters in not_public {
            assert_eq!(parse(&body(filters.clone())), None, "{filters}");
        }
        assert_eq!(parse(b"not json"), None);
    }

    #[test]
    fn a_counting_account_is_stable_differs_by_label_and_is_nobodys_key() {
        let budget = counter_account("budget").expect("an account");
        assert_eq!(counter_account("budget"), Some(budget));
        assert_ne!(counter_account("address:203.0.113.7"), Some(budget));
        assert_ne!(
            counter_account("address:203.0.113.7"),
            counter_account("address:203.0.113.8")
        );
        // Not the key of the secret 1, the one account anyone could sign as.
        assert_ne!(
            budget.to_hex(),
            "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
        );
    }

    #[test]
    fn the_client_address_is_the_one_the_proxy_wrote() {
        let with = |values: &[&str]| {
            let mut headers = HeaderMap::new();
            for value in values {
                headers.append("x-forwarded-for", value.parse().expect("header"));
            }
            client_address(&headers)
        };
        assert_eq!(with(&[]), None);
        assert_eq!(with(&["203.0.113.7"]), Some("203.0.113.7".into()));
        // What the client claimed comes first; the proxy's own entry is the last one.
        assert_eq!(
            with(&["10.0.0.1, 198.51.100.2 , 203.0.113.7"]),
            Some("203.0.113.7".into())
        );
        assert_eq!(
            with(&["10.0.0.1", "203.0.113.9"]),
            Some("203.0.113.9".into())
        );
        // One machine holds a whole IPv6 network: its addresses count as one.
        assert_eq!(
            with(&["2001:db8:1:2:aaaa::1"]),
            with(&["2001:db8:1:2:bbbb::2"])
        );
        assert_ne!(with(&["2001:db8:1:2::1"]), with(&["2001:db8:1:3::1"]));
        assert_eq!(with(&["not an address"]), None);
    }

    fn record(keys: &nostr::Keys, tags: &[&[&str]], body: &str) -> nostr::Event {
        nostr::EventBuilder::new(nostr::Kind::Custom(KIND_LAUNCH_UPDATE as u16), body)
            .tags(
                tags.iter()
                    .map(|tag| nostr::Tag::parse(tag.to_vec()).expect("tag")),
            )
            .allow_self_tagging()
            .sign_with_keys(keys)
            .expect("sign")
    }

    /// A record kept for a room is the room's, whatever address it carries; so is anything of another kind or about
    /// another project. This is the check made again on what the database gave back.
    #[test]
    fn only_a_record_kept_for_the_whole_community_about_this_project_is_looked_at() {
        let founder = nostr::Keys::generate();
        let coordinate = format!("37001:{}:nebula", founder.public_key().to_hex());
        let about = record(
            &founder,
            &[&["a", &coordinate], &["update-part", "done", "x"]],
            "{}",
        );
        assert!(is_the_projects_own(
            &StoredEvent::new(about.clone(), None),
            &coordinate
        ));
        assert!(
            !is_the_projects_own(
                &StoredEvent::new(about.clone(), Some(uuid::Uuid::new_v4())),
                &coordinate
            ),
            "stored for a room"
        );
        assert!(
            !is_the_projects_own(
                &StoredEvent::new(about, None),
                &format!("37001:{}:other", founder.public_key().to_hex())
            ),
            "about another project"
        );
        let note = nostr::EventBuilder::new(nostr::Kind::TextNote, "words")
            .tags([nostr::Tag::parse(["a", coordinate.as_str()]).expect("tag")])
            .sign_with_keys(&founder)
            .expect("sign");
        assert!(
            !is_the_projects_own(&StoredEvent::new(note, None), &coordinate),
            "another kind"
        );
    }

    /// A task open to anyone is served from the team, before anyone has taken it; its take never is.
    #[test]
    fn an_open_task_is_served_from_the_team_and_a_take_is_not() {
        let founder = nostr::Keys::generate();
        let stranger = nostr::Keys::generate();
        let project =
            nostr::EventBuilder::new(nostr::Kind::Custom(KIND_LAUNCH_RECORD as u16), "{}")
                .tags([nostr::Tag::parse(["d", "nebula"]).expect("tag")])
                .sign_with_keys(&founder)
                .expect("sign");
        let team = Team::of(&project);
        let nothing = Accepted::default();
        let open: &[&[&str]] = &[&["task-part", "task"], &["task-usd", "40"]];
        assert!(is_served(&record(&founder, open, "{}"), &team, &nothing));
        assert!(!is_served(&record(&stranger, open, "{}"), &team, &nothing));
        // A named task that nobody accepted yet, and a take, are for members.
        let named: &[&[&str]] = &[
            &["task-part", "task"],
            &["task-helper", "ab"],
            &["task-usd", "4"],
        ];
        assert!(!is_served(&record(&founder, named, "{}"), &team, &nothing));
        let take: &[&[&str]] = &[&["task-part", "take"], &["task", "ab"]];
        assert!(!is_served(&record(&stranger, take, "{}"), &team, &nothing));
        assert!(!is_served(&record(&founder, take, "{}"), &team, &nothing));
    }

    /// The list in [`is_served`], family by family and signer by signer.
    #[test]
    fn only_the_listed_families_are_served_and_only_from_the_right_signer() {
        let founder = nostr::Keys::generate();
        let teammate = nostr::Keys::generate();
        let helper = nostr::Keys::generate();
        let teammate_key = teammate.public_key().to_hex();
        let project =
            nostr::EventBuilder::new(nostr::Kind::Custom(KIND_LAUNCH_RECORD as u16), "{}")
                .tags([
                    nostr::Tag::parse(["d", "nebula"]).expect("tag"),
                    nostr::Tag::parse(["team", teammate_key.as_str(), "member"]).expect("tag"),
                ])
                .sign_with_keys(&founder)
                .expect("sign");
        let team = Team::of(&project);
        assert!(team.has(&founder.public_key().to_hex()) && team.has(&teammate_key));
        assert!(!team.has(&helper.public_key().to_hex()));
        let helper_key = helper.public_key().to_hex();
        let update = r#"{"title":"Week 1","body":"Shipped","links":[]}"#;

        let task = record(
            &teammate,
            &[&["task-part", "task"], &["task-helper", &helper_key]],
            "{}",
        );
        let task_id = task.id.to_hex();
        let piece = record(
            &helper,
            &[&["task-part", "evidence"], &["task", &task_id]],
            r#"{"title":"Work handed in","body":"Here it is"}"#,
        );
        let piece_id = piece.id.to_hex();
        let confirm = record(
            &founder,
            &[
                &["task-part", "confirm"],
                &["task", &task_id],
                &["task-evidence", &piece_id],
            ],
            "{}",
        );
        let nothing = Accepted::default();
        let accepted = Accepted {
            pieces: HashSet::from([piece_id.clone()]),
            tasks: HashSet::from([task_id.clone()]),
            helpers: HashMap::from([(task_id.clone(), helper_key.clone())]),
        };

        let served = |event: &nostr::Event, accepted: &Accepted| is_served(event, &team, accepted);
        // Goals and promises: the founder's alone.
        for tags in [
            &[&["goal", "g1"][..]][..],
            &[&["promise", "0", "Ship a map"]],
            &[&["promise-mark", "ff:0", "done", ""]],
            &[&["update-part", "done", "x"], &["promise", "0", "Ship"]],
        ] {
            assert!(
                served(&record(&founder, tags, update), &nothing),
                "{tags:?}"
            );
            assert!(
                !served(&record(&teammate, tags, update), &nothing),
                "{tags:?}"
            );
            assert!(
                !served(&record(&helper, tags, update), &nothing),
                "{tags:?}"
            );
        }
        // Weekly updates and plain updates: the founder's or the team's.
        for tags in [
            &[&["update-part", "done", "x"][..]][..],
            &[&["update-kind", "weekly"]],
            &[&["update-part", "next", "y"], &["help-needed", "A logo"]],
            &[],
        ] {
            assert!(
                served(&record(&founder, tags, update), &nothing),
                "{tags:?}"
            );
            assert!(
                served(&record(&teammate, tags, update), &nothing),
                "{tags:?}"
            );
            assert!(
                !served(&record(&helper, tags, update), &nothing),
                "{tags:?}"
            );
        }
        // A record with no family tag is served only when its body is a plain update and nothing more.
        for body in [
            r#"{"title":"Evidence","body":"PRIVATE","claim":{"id":"0x1"}}"#,
            r#"{"title":"Review","review":{"reason":"too thin"}}"#,
            r#"{"agreement":{"words":"x"}}"#,
            r#"{"agreementCorrections":{}}"#,
            r#"{"workArea":{"id":"0x1"}}"#,
            r#"{"challenge":{"answers":[]}}"#,
            r#"{"claim":"not even an object"}"#,
            r#"{"title":"Check","check":{"v":1}}"#,
            r#"{"title":"x","note":"something else"}"#,
            "not json",
            "[]",
        ] {
            for signer in [&founder, &teammate, &helper] {
                assert!(!served(&record(signer, &[], body), &nothing), "{body}");
                // Nor under a family's tag: what the body says it is wins.
                if body.starts_with('{') && !body.contains("note") {
                    assert!(
                        !served(
                            &record(signer, &[&["update-part", "done", "x"]], body),
                            &nothing
                        ),
                        "{body}"
                    );
                }
            }
        }
        // Help offers and replies, "help found", answers to a team invitation: never, whoever signs.
        for tags in [
            &[&["help-offer", "ff"][..]][..],
            &[&["help-reply", "ff"]],
            &[&["help-found", "ff"]],
            &[&["team-answer", "yes"]],
            &[&["join-ask", "abc123"]],
            &[&["join-decline", "abc123"]],
            &[&["update-part", "done", "x"], &["help-reply", "ff"]],
        ] {
            for signer in [&founder, &teammate, &helper] {
                assert!(
                    !served(&record(signer, tags, update), &accepted),
                    "{tags:?}"
                );
            }
        }

        // The three steps of accepted work, and only once it is accepted.
        for step in [&task, &piece, &confirm] {
            assert!(served(step, &accepted));
            assert!(!served(step, &nothing), "not before the work is accepted");
        }
        // Another piece the same helper handed in on the same task (an earlier try, sent back or still waiting) is
        // not the piece that was accepted.
        let earlier = record(
            &helper,
            &[&["task-part", "evidence"], &["task", &task_id]],
            r#"{"title":"Work handed in","body":"A first try"}"#,
        );
        assert!(!served(&earlier, &accepted));
        // Work handed in by someone the task does not name, though the team confirmed it.
        let stray = record(
            &teammate,
            &[&["task-part", "evidence"], &["task", &task_id]],
            "{}",
        );
        let stray_accepted = Accepted {
            pieces: HashSet::from([stray.id.to_hex()]),
            tasks: HashSet::from([task_id.clone()]),
            helpers: HashMap::from([(task_id.clone(), helper_key.clone())]),
        };
        assert!(!served(&stray, &stray_accepted));
        // A task or a confirmation signed by someone who is not on the team.
        let outsiders_task = record(
            &helper,
            &[&["task-part", "task"], &["task-helper", &helper_key]],
            "{}",
        );
        assert!(!served(
            &outsiders_task,
            &Accepted {
                tasks: HashSet::from([outsiders_task.id.to_hex()]),
                ..Accepted::default()
            }
        ));
        assert!(!served(
            &record(
                &helper,
                &[
                    &["task-part", "confirm"],
                    &["task", &task_id],
                    &["task-evidence", &piece_id]
                ],
                "{}"
            ),
            &accepted
        ));
        // Every other step is for members, even on a task whose work was accepted.
        for step in [
            "send-back",
            "accept",
            "more-time",
            "grant",
            "give-up",
            "cancel",
            "something-new",
        ] {
            for signer in [&founder, &teammate, &helper] {
                let event = record(
                    signer,
                    &[
                        &["task-part", step],
                        &["task", &task_id],
                        &["task-evidence", &piece_id],
                    ],
                    r#"{"title":"Sent back","body":"Not good enough yet"}"#,
                );
                assert!(!served(&event, &accepted), "{step}");
            }
        }
        // Two steps at once, or a step under a founder's or weekly tag: no family, so not served.
        assert!(!served(
            &record(
                &founder,
                &[
                    &["task-part", "confirm"],
                    &["task-part", "send-back"],
                    &["task-evidence", &piece_id]
                ],
                "{}"
            ),
            &accepted
        ));
        assert!(!served(
            &record(
                &founder,
                &[
                    &["goal", "g1"],
                    &["task-part", "confirm"],
                    &["task-evidence", &piece_id]
                ],
                "{}"
            ),
            &accepted
        ));
    }
}
