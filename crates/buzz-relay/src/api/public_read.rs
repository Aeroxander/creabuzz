//! Public reads of a project's record on a community that requires membership.
//!
//! A project's record is made to be shown: what it promised, what it posted
//! each week, which promises it kept and which work was accepted. On an
//! invite-only community a caller who is not a member is refused every read,
//! so a shared scorecard link shows a stranger nothing. With
//! `BUZZ_PUBLIC_PROJECT_READS=1` the relay answers such a caller on
//! `POST /query`, and only there, under these rules, all enforced here:
//!
//! - **Which kinds.** The project record (kind 37001) and the records about a
//!   project (kind 47003: its goals, weekly updates, promise answers, help
//!   requests and task steps). Nothing else, whatever the filter asks for.
//! - **Which project.** Every filter names one project: a record filter by its
//!   id (`#d`), a filter for records about it by its address (`#a`). The
//!   project must pass [`crate::share_preview::public_standing`], the rule the
//!   link preview uses: listed, not removed, founder neither muted nor banned.
//!   A project that does not pass yields nothing, the same as one that does
//!   not exist.
//! - **Which records.** Only records stored for the whole community (never a
//!   room's), carrying the project's address, and signed by someone who is
//!   neither muted nor banned.
//! - **How much.** At most [`MAX_FILTERS`] filters, [`MAX_LIMIT`] records per
//!   filter, a fixed number of lookups per request, one deadline, the caller's
//!   own request limit, and one budget a minute for all public reads in the
//!   community (a caller who is not signed in can use a new key each time).
//!
//! A request that is not exactly of this shape gets the membership refusal it
//! would have had without the setting. Writes never come here. With the
//! setting off this module is not reached.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;
use std::time::Duration;

use axum::{http::StatusCode, response::Json};
use buzz_auth::LimitType;
use buzz_core::kind::{KIND_LAUNCH_RECORD, KIND_LAUNCH_UPDATE};
use buzz_core::{CommunityId, StoredEvent, TenantContext};
use buzz_db::DbError;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{api_error, db_read_error};
use crate::share_preview::{public_standing, records_named, PublicProject};
use crate::state::AppState;

/// The kinds a caller who is not a member may be answered with.
pub(crate) const PUBLIC_KINDS: [u32; 2] = [KIND_LAUNCH_RECORD, KIND_LAUNCH_UPDATE];
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
/// How many project records one request may have checked for standing.
const MAX_STANDING_CHECKS: usize = 12;
/// How many signers, other than founders, one request may have checked.
/// Records by signers past this are left out, never shown unchecked.
const MAX_SIGNER_CHECKS: usize = 40;
/// Longest one public read may take.
const DEADLINE: Duration = Duration::from_secs(5);
/// The window of the community-wide budget, in seconds.
const BUDGET_WINDOW_SECS: u64 = 60;

type Refusal = (StatusCode, Json<Value>);

/// One filter of a public read, already checked against the shape allowed.
#[derive(Debug, Clone, PartialEq, Eq)]
enum PublicFilter {
    /// The project record itself: `kinds: [37001]`, one `#d`, at most one author.
    Record {
        id: String,
        author: Option<String>,
        limit: i64,
    },
    /// Records about one project: `kinds: [47003]`, one `#a`, optionally
    /// narrowed by who signed, a label, a referenced record and a time range.
    About {
        founder: String,
        id: String,
        coordinate: String,
        authors: Option<Vec<Vec<u8>>>,
        labels: Option<Vec<String>>,
        references: Option<Vec<String>>,
        since: Option<i64>,
        until: Option<i64>,
        limit: i64,
    },
}

fn is_key(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
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

fn limit_of(filter: &serde_json::Map<String, Value>) -> Option<i64> {
    match filter.get("limit") {
        None => Some(DEFAULT_LIMIT as i64),
        Some(value) => value
            .as_u64()
            .filter(|n| (1..=MAX_LIMIT).contains(n))
            .map(|n| n as i64),
    }
}

fn seconds(filter: &serde_json::Map<String, Value>, key: &str) -> Option<Option<i64>> {
    match filter.get(key) {
        None => Some(None),
        Some(value) => value.as_i64().filter(|n| *n >= 0).map(Some),
    }
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
    let kinds = filter.get("kinds")?.as_array()?;
    let [kind] = kinds.as_slice() else {
        return None;
    };
    let kind = u32::try_from(kind.as_u64()?).ok()?;
    let limit = limit_of(filter)?;
    let only = |allowed: &[&str]| filter.keys().all(|key| allowed.contains(&key.as_str()));

    if kind == KIND_LAUNCH_RECORD {
        if !only(&["kinds", "authors", "#d", "limit"]) {
            return None;
        }
        let [id] = strings(filter.get("#d")?)?.try_into().ok()?;
        let author = match filter.get("authors") {
            None => None,
            Some(value) => {
                let [author] = strings(value)?.try_into().ok()?;
                if !is_key(&author) {
                    return None;
                }
                Some(author)
            }
        };
        return Some(PublicFilter::Record { id, author, limit });
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
            Some(value) => Some(
                strings(value)?
                    .iter()
                    .map(|author| is_key(author).then(|| hex::decode(author).ok()).flatten())
                    .collect::<Option<Vec<_>>>()?,
            ),
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

/// The account all public reads of one community are counted under. Nobody
/// holds its secret key (it is a hash, not a key anyone made), so no caller can
/// sign in as it and no real account's own limit shares its counter.
fn budget_account() -> Option<&'static nostr::PublicKey> {
    static ACCOUNT: OnceLock<Option<nostr::PublicKey>> = OnceLock::new();
    ACCOUNT
        .get_or_init(|| {
            (0u32..256).find_map(|n| {
                let digest = Sha256::digest(format!("buzz:public-project-reads:{n}"));
                nostr::PublicKey::from_slice(&digest).ok()
            })
        })
        .as_ref()
}

/// Count this read against the community's budget for public reads.
async fn spend_budget(state: &AppState, tenant: &TenantContext) -> Result<(), Refusal> {
    let unavailable = || {
        api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "rate-limited: shared admission unavailable",
        )
    };
    let account = budget_account().ok_or_else(unavailable)?;
    match crate::admission::check_principal(
        state.admission_rate_limiter.as_ref(),
        tenant,
        account,
        LimitType::ApiCalls,
        BUDGET_WINDOW_SECS,
        state.config.public_project_reads_per_min,
    )
    .await
    {
        Ok(()) => Ok(()),
        Err(crate::admission::AdmissionError::Exceeded { reset_in_secs }) => Err(api_error(
            StatusCode::TOO_MANY_REQUESTS,
            &format!("rate-limited: public reads are busy; retry in {reset_in_secs}s"),
        )),
        Err(crate::admission::AdmissionError::Unavailable) => Err(unavailable()),
    }
}

/// What one request has looked up, so no project or signer is checked twice
/// and the number of lookups stays bounded.
struct Lookups<'a> {
    state: &'a AppState,
    community: CommunityId,
    /// Project address to its record when it may be shown, `None` when not.
    standing: HashMap<String, Option<PublicProject>>,
    standing_checks: usize,
    /// Signer to "may be shown" (neither muted nor banned).
    signers: HashMap<[u8; 32], bool>,
    signer_checks: usize,
}

impl<'a> Lookups<'a> {
    fn new(state: &'a AppState, community: CommunityId) -> Self {
        Self {
            state,
            community,
            standing: HashMap::new(),
            standing_checks: 0,
            signers: HashMap::new(),
            signer_checks: 0,
        }
    }

    /// The public projects stored under `id`, by `author` when one is named.
    async fn projects(
        &mut self,
        id: &str,
        author: Option<&str>,
    ) -> Result<Vec<PublicProject>, DbError> {
        let mut found = Vec::new();
        for record in records_named(self.state, self.community, id).await? {
            let founder = record.pubkey.to_hex();
            if author.is_some_and(|wanted| wanted != founder) {
                continue;
            }
            let coordinate = format!("{KIND_LAUNCH_RECORD}:{founder}:{id}");
            if let Some(known) = self.standing.get(&coordinate) {
                found.extend(known.clone());
                continue;
            }
            // Past the bound nothing more is checked, and what is not checked is not shown.
            if self.standing_checks >= MAX_STANDING_CHECKS {
                continue;
            }
            self.standing_checks += 1;
            let project = public_standing(self.state, self.community, record).await?;
            // A founder who may be shown needs no second check as a signer.
            if let Some(project) = &project {
                self.signers.insert(project.record.pubkey.to_bytes(), true);
            }
            found.extend(project.clone());
            self.standing.insert(coordinate, project);
        }
        Ok(found)
    }

    /// Whether records signed by `signer` may be shown.
    async fn signer_shown(&mut self, signer: [u8; 32]) -> Result<bool, DbError> {
        if let Some(known) = self.signers.get(&signer) {
            return Ok(*known);
        }
        if self.signer_checks >= MAX_SIGNER_CHECKS {
            return Ok(false);
        }
        self.signer_checks += 1;
        let restriction = self
            .state
            .db
            .moderation_restriction_state(self.community, &signer)
            .await?;
        let shown = !restriction.banned && restriction.muted_until.is_none();
        self.signers.insert(signer, shown);
        Ok(shown)
    }
}

fn names_project(stored: &StoredEvent, coordinate: &str) -> bool {
    stored.event.tags.iter().any(|tag| {
        let tag = tag.as_slice();
        tag.first().map(String::as_str) == Some("a")
            && tag.get(1).map(String::as_str) == Some(coordinate)
    })
}

/// The records `filter` is answered with.
async fn answer_filter(
    lookups: &mut Lookups<'_>,
    filter: &PublicFilter,
) -> Result<Vec<nostr::Event>, DbError> {
    match filter {
        PublicFilter::Record { id, author, limit } => Ok(lookups
            .projects(id, author.as_deref())
            .await?
            .into_iter()
            .map(|project| project.record)
            .take(*limit as usize)
            .collect()),
        PublicFilter::About {
            founder,
            id,
            coordinate,
            authors,
            labels,
            references,
            since,
            until,
            limit,
        } => {
            if lookups.projects(id, Some(founder)).await?.is_empty() {
                return Ok(Vec::new());
            }
            let mut tag_filters = vec![("a".to_string(), vec![coordinate.clone()])];
            if let Some(labels) = labels {
                tag_filters.push(("l".to_string(), labels.clone()));
            }
            if let Some(references) = references {
                tag_filters.push(("e".to_string(), references.clone()));
            }
            let time = |secs: &Option<i64>| {
                secs.and_then(|secs| chrono::DateTime::from_timestamp(secs, 0))
            };
            let stored = lookups
                .state
                .db
                // The writer, as the link preview reads: a copy that lags could still hold a record its signer deleted.
                .query_events(&buzz_db::EventQuery {
                    kinds: Some(vec![KIND_LAUNCH_UPDATE as i32]),
                    authors: authors.clone(),
                    tag_filters,
                    since: time(since),
                    until: time(until),
                    global_only: true,
                    limit: Some(*limit),
                    ..buzz_db::EventQuery::for_community(lookups.community)
                })
                .await?;
            let mut shown = Vec::with_capacity(stored.len());
            for record in stored {
                // Asked of the database, and checked again on what came back: only this kind, only a record kept
                // for the whole community (never a room's), only one that carries this project's address.
                if u32::from(record.event.kind.as_u16()) != KIND_LAUNCH_UPDATE
                    || record.channel_id.is_some()
                    || !names_project(&record, coordinate)
                {
                    continue;
                }
                if lookups.signer_shown(record.event.pubkey.to_bytes()).await? {
                    shown.push(record.event);
                }
            }
            Ok(shown)
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
    body: &[u8],
    refusal: Refusal,
) -> Result<Json<Value>, Refusal> {
    // Only "you are not a member" may be answered another way: a ban, a failed lookup or anything else stands.
    if !state.config.public_project_reads || !super::relay_members::is_membership_refusal(&refusal)
    {
        return Err(refusal);
    }
    let Some(filters) = parse(body) else {
        return Err(refusal);
    };
    spend_budget(state, tenant).await?;
    // A ban turns a person away from the community whole; it does not lapse because they are also not a member.
    let caller_state = state
        .db
        .moderation_restriction_state(tenant.community(), caller.as_bytes())
        .await
        .map_err(|e| db_read_error("public read: caller standing", &e))?;
    if caller_state.banned {
        return Err(refusal);
    }

    let read = async {
        let mut lookups = Lookups::new(state, tenant.community());
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
        Ok::<_, DbError>(events)
    };
    match tokio::time::timeout(DEADLINE, read).await {
        Ok(Ok(events)) => Ok(Json(Value::Array(events))),
        Ok(Err(e)) => Err(db_read_error("public read", &e)),
        Err(_) => Err(api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            super::QUERY_TIMED_OUT,
        )),
    }
}

#[cfg(test)]
mod postgres_tests;

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
            {"kinds": [47003], "#a": [coordinate], "authors": [FOUNDER], "#l": ["task"],
             "#e": ["ff"], "since": 1, "until": 2, "limit": 200},
        ])))
        .expect("public filters");
        assert_eq!(
            filters[0],
            PublicFilter::Record {
                id: "nebula".into(),
                author: None,
                limit: DEFAULT_LIMIT as i64
            }
        );
        assert_eq!(
            filters[1],
            PublicFilter::Record {
                id: "nebula".into(),
                author: Some(FOUNDER.into()),
                limit: 1
            }
        );
        assert_eq!(
            filters[2],
            PublicFilter::About {
                founder: FOUNDER.into(),
                id: "nebula".into(),
                coordinate,
                authors: Some(vec![hex::decode(FOUNDER).expect("hex")]),
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
    fn the_budget_account_is_stable_and_is_nobodys_key() {
        let account = budget_account().expect("an account");
        assert_eq!(budget_account(), Some(account));
        // Not the key of the secret 1, the one account anyone could sign as.
        assert_ne!(
            account.to_hex(),
            "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
        );
    }
}
