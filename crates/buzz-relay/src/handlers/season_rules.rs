//! Seasons: the operator's season record (kind 37021) and how a project enters one.
//!
//! A season is a six-week group of projects with open entry, started by the platform's operator; demo day is the day
//! its projects are shown together. The records, the tags and the sentences are in
//! `docs/next-version/ROOM-AND-SEASON-RECORDS.md`. There are no rounds and no money here: an entry is a statement
//! the project's own team signs (kind 47003, family `season-entry`), and the operator's `season-remove` wins over it.
//!
//! # What is decided here
//!
//! - **The season record** ([`enforce_season_record`]): signed by an operator only, its number and dates in bounds.
//! - **An entry or a leave** ([`enforce_step`]): the season exists and is open, the project is the signer's team's
//!   own, is launched on the network, has at least [`ENTRY_MIN_ACCOUNTS`] counted accounts, is not already in, was not
//!   removed, and the season and the founder are within their caps. The count and the check of "already in" are made
//!   under one lock per season ([`SeasonLock`]) that the caller keeps until the record is stored, so two entries
//!   arriving together cannot both pass.
//! - **A removal** (`season-remove`): an operator's key, any time, for a season that exists.
//!
//! A lookup that fails refuses the write as a server fault: an outage never lets a record past a check.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use buzz_core::kind::{KIND_LAUNCH_UPDATE, KIND_SEASON};
use buzz_core::tenant::{CommunityId, TenantContext};
use nostr::Event;
use sqlx::PgPool;

use super::ingest::IngestError;
use super::launch_update_authority::internal;
use super::room_write::{launched_of, split_coordinate};
use crate::api::manager::cost::project_id;
use crate::state::AppState;

/// Said when someone who is not an operator signs a season record or a removal.
pub(crate) const NOT_OPERATOR: &str =
    "restricted: only the people who run this server can start a season";
/// Said when someone who is not an operator takes a project out of a season.
pub(crate) const NOT_OPERATOR_REMOVE: &str =
    "restricted: only the people who run this server can take a project out of a season";
/// Said when a season record's number or dates are wrong.
pub(crate) const BAD_SEASON: &str =
    "invalid: a season names its number, and its dates run start, demo day, end";
/// Said when the season an entry names does not exist.
pub(crate) const NO_SEASON: &str = "invalid: this season does not exist";
/// Said when an entry or a leave comes outside the season's open days.
pub(crate) const NOT_OPEN: &str = "restricted: this season is not open for entry";
/// Said when the project is not here.
pub(crate) const NO_PROJECT: &str = "invalid: this project is not here";
/// Said when the reader has not read the project's launch (or there is no reader).
pub(crate) const NOT_LAUNCHED: &str =
    "restricted: this project has not launched on the network yet";
/// Said when too few accounts back the project.
pub(crate) const TOO_FEW_BACKERS: &str =
    "restricted: at least 3 people have to back this project first";
/// Said when the project is already in the season.
pub(crate) const ALREADY_IN: &str = "restricted: this project is already in this season";
/// Said when the season has its 500 entries.
pub(crate) const SEASON_FULL: &str = "restricted: this season is full";
/// Said when the founder has entered three projects already.
pub(crate) const FOUNDER_FULL: &str =
    "restricted: a founder can enter at most 3 projects in one season";
/// Said when the operator took the project out of the season.
pub(crate) const REMOVED: &str = "restricted: this project was taken out of this season";
/// Said when a project has changed its place too often.
pub(crate) const TOO_OFTEN: &str =
    "restricted: this project has changed its place in this season too often";
/// Said when a season is being written by another entry right now and the lock did not come in time.
pub(crate) const BUSY: &str = "retry: this season is busy; try again in a moment";
/// Said on a leave of a project that is not in the season.
pub(crate) const NOT_IN: &str = "invalid: this project is not in this season";

/// The fewest counted accounts that let a project enter (a hint on a play network, where it costs nothing).
pub(crate) const ENTRY_MIN_ACCOUNTS: u64 = 3;
/// The most live entries in one season.
pub(crate) const ENTRIES_MAX: usize = 500;
/// The most live entries one founder may have in one season.
pub(crate) const PER_FOUNDER_MAX: usize = 3;
/// The most entry and leave records one project may have in one season.
pub(crate) const CHANGES_MAX: u64 = 12;
/// The most records of a season that are read before the season counts as full.
pub(crate) const RECORDS_READ_MAX: i64 = 5_000;
/// A season, as its record says (the bounds are `buzz_core::season`'s, shared with `buzz launchpad seasons start`).
pub(crate) use buzz_core::season::{season_d, Season, NUMBER_MAX};

/// Read a season record's tags and content and hold them to their bounds. Pure: who signed it is not asked here.
pub(crate) fn parse_season_record(event: &Event) -> Result<Season, &'static str> {
    buzz_core::season::parse_record(event).map_err(|_| BAD_SEASON)
}

/// Whether `pubkey_hex` is one of the server's operators: a key in `RELAY_OPERATOR_PUBKEYS`, or the relay's owner
/// when that list is empty (the one rule `api::admin` uses; there is no second list).
pub(crate) fn is_operator(state: &AppState, pubkey_hex: &str) -> bool {
    crate::api::admin::is_config_backed_pubkey(&state.config, pubkey_hex)
}

/// Refuse a season record (kind 37021) that an operator did not sign or whose number and dates are wrong.
pub(crate) fn enforce_season_record(state: &AppState, event: &Event) -> Result<(), IngestError> {
    if !is_operator(state, &event.pubkey.to_hex()) {
        return Err(IngestError::AuthFailed(NOT_OPERATOR.into()));
    }
    parse_season_record(event)
        .map(drop)
        .map_err(|reason| IngestError::Rejected(reason.into()))
}

/// The season `number` as the newest record of a current operator says, if there is one.
pub(crate) async fn read_season(
    state: &AppState,
    community: CommunityId,
    number: u32,
) -> Result<Option<Season>, buzz_db::DbError> {
    let rows = state
        .db
        .query_events_for_event_write(&buzz_db::EventQuery {
            kinds: Some(vec![KIND_SEASON as i32]),
            d_tag: Some(season_d(number)),
            global_only: true,
            limit: Some(20),
            ..buzz_db::EventQuery::for_community(community)
        })
        .await?;
    Ok(rows
        .iter()
        .filter(|stored| is_operator(state, &stored.event.pubkey.to_hex()))
        .filter_map(|stored| {
            parse_season_record(&stored.event).ok().map(|season| {
                (
                    stored.event.created_at.as_secs(),
                    stored.event.id.to_hex(),
                    season,
                )
            })
        })
        .max_by(|a, b| (a.0, &a.1).cmp(&(b.0, &b.1)))
        .map(|(_, _, season)| season))
}

/// Which of the three season families a 47003 record is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Family {
    /// The team puts the project in.
    Entry,
    /// The team takes it out again.
    Leave,
    /// The operator takes it out, for good.
    Remove,
}

impl Family {
    fn tag(self) -> &'static str {
        match self {
            Self::Entry => "season-entry",
            Self::Leave => "season-leave",
            Self::Remove => "season-remove",
        }
    }
}

/// What a season family record says: which one, and for which season.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Step {
    /// The family.
    pub(crate) family: Family,
    /// The season's number.
    pub(crate) number: u32,
}

/// Read a 47003 record's season family. `Ok(None)` when it carries none of the three tags; `Err` for one that claims a
/// family but is not well formed: exactly one family tag, its number canonical and equal to the one in the one
/// `season-<n>` topic tag.
pub(crate) fn classify_step(event: &Event) -> Result<Option<Step>, String> {
    let mut families: Vec<(Family, &str)> = Vec::new();
    let mut topics: Vec<&str> = Vec::new();
    for tag in event.tags.iter() {
        let parts = tag.as_slice();
        let value = parts.get(1).map(String::as_str).unwrap_or("");
        match parts.first().map(String::as_str) {
            Some("season-entry") => families.push((Family::Entry, value)),
            Some("season-leave") => families.push((Family::Leave, value)),
            Some("season-remove") => families.push((Family::Remove, value)),
            Some("t") if value.starts_with("season-") => topics.push(value),
            _ => {}
        }
    }
    let [(family, number)] = families.as_slice() else {
        return if families.is_empty() {
            Ok(None)
        } else {
            Err(
                "a record can carry only one of `season-entry`, `season-leave` and `season-remove`"
                    .into(),
            )
        };
    };
    let Some(number) = buzz_core::season::parse_number(number) else {
        return Err(format!(
            "`{}` must hold a season number from 1 to {NUMBER_MAX}",
            family.tag()
        ));
    };
    if topics != [season_d(number).as_str()] {
        return Err(format!(
            "a season record carries one `t` tag, `season-{number}`, and the same number in `{}`",
            family.tag()
        ));
    }
    Ok(Some(Step {
        family: *family,
        number,
    }))
}

/// One stored season record, read for the lineup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Row {
    /// The project's address.
    pub(crate) coordinate: String,
    /// Which family.
    pub(crate) family: Family,
    /// When it was signed, and its id (the tie-break of two signed in one second).
    pub(crate) at: (u64, String),
}

/// What a season's stored records say about who is in.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Lineup {
    removed: HashSet<String>,
    /// Per project: whether its newest entry-or-leave is an entry, and how many entries and leaves it has.
    places: HashMap<String, (bool, u64)>,
}

/// Work out the lineup from a season's records.
pub(crate) fn lineup(rows: &[Row]) -> Lineup {
    let mut out = Lineup::default();
    let mut newest: HashMap<&str, (&(u64, String), bool)> = HashMap::new();
    for row in rows {
        match row.family {
            Family::Remove => {
                out.removed.insert(row.coordinate.clone());
            }
            Family::Entry | Family::Leave => {
                let is_entry = row.family == Family::Entry;
                out.places
                    .entry(row.coordinate.clone())
                    .or_insert((false, 0))
                    .1 += 1;
                let slot = newest
                    .entry(row.coordinate.as_str())
                    .or_insert((&row.at, is_entry));
                if row.at > *slot.0 {
                    *slot = (&row.at, is_entry);
                }
            }
        }
    }
    for (coordinate, (_, is_entry)) in newest {
        if let Some(place) = out.places.get_mut(coordinate) {
            place.0 = is_entry;
        }
    }
    out
}

impl Lineup {
    /// The projects that are in: entered, not left since, not removed.
    pub(crate) fn live(&self) -> Vec<&str> {
        let mut live: Vec<&str> = self
            .places
            .iter()
            .filter(|(coordinate, (in_now, _))| *in_now && !self.removed.contains(*coordinate))
            .map(|(coordinate, _)| coordinate.as_str())
            .collect();
        live.sort_unstable();
        live
    }

    /// Whether an entry for `coordinate` may be taken now.
    pub(crate) fn may_enter(&self, coordinate: &str) -> Result<(), &'static str> {
        if self.removed.contains(coordinate) {
            return Err(REMOVED);
        }
        let live = self.live();
        if live.contains(&coordinate) {
            return Err(ALREADY_IN);
        }
        if self
            .places
            .get(coordinate)
            .is_some_and(|(_, changes)| *changes >= CHANGES_MAX)
        {
            return Err(TOO_OFTEN);
        }
        if live.len() >= ENTRIES_MAX {
            return Err(SEASON_FULL);
        }
        let founder = founder_of(coordinate);
        if live
            .iter()
            .filter(|other| founder_of(other) == founder)
            .count()
            >= PER_FOUNDER_MAX
        {
            return Err(FOUNDER_FULL);
        }
        Ok(())
    }

    /// Whether a leave for `coordinate` may be taken now.
    pub(crate) fn may_leave(&self, coordinate: &str) -> Result<(), &'static str> {
        if self
            .places
            .get(coordinate)
            .is_some_and(|(_, changes)| *changes >= CHANGES_MAX)
        {
            return Err(TOO_OFTEN);
        }
        if self.live().contains(&coordinate) {
            Ok(())
        } else {
            Err(NOT_IN)
        }
    }
}

/// The founder a project's address names (its second part).
fn founder_of(coordinate: &str) -> &str {
    coordinate.split(':').nth(1).unwrap_or("")
}

/// A lock on one season, held from before the checks of an entry until its record is stored. Dropping it lets go
/// (on its own task: the record is stored by then, which is what the next entry's checks must see).
#[derive(Debug)]
pub(crate) struct SeasonLock {
    conn: Option<sqlx::pool::PoolConnection<sqlx::Postgres>>,
    name: String,
}

impl SeasonLock {
    /// Take the lock on season `d`, trying for a few seconds. A connection is held only once the lock is had: a
    /// crowd of entries waiting for their turn must not use up the pool the one that holds the lock reads with.
    async fn acquire(pool: &PgPool, d: &str) -> Result<Self, IngestError> {
        Self::acquire_named(pool, format!("creaton-season:{d}")).await
    }

    /// Take the advisory lock called `name` (the same way, with the same wait). The holder room uses it to make one
    /// account's count of its recent posts and the store of the next one a single step.
    pub(crate) async fn acquire_named(pool: &PgPool, name: String) -> Result<Self, IngestError> {
        for pause_ms in [
            0u64, 5, 10, 20, 40, 80, 160, 320, 640, 1_000, 1_000, 1_000, 1_000, 1_000, 1_000, 1_000,
        ] {
            if pause_ms > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(pause_ms)).await;
            }
            let mut conn = pool
                .acquire()
                .await
                .map_err(|e| internal("taking a lock on the season", e))?;
            let got: bool =
                sqlx::query_scalar("SELECT pg_try_advisory_lock(hashtextextended($1, 0))")
                    .bind(&name)
                    .fetch_one(&mut *conn)
                    .await
                    .map_err(|e| internal("taking a lock on the season", e))?;
            if got {
                return Ok(Self {
                    conn: Some(conn),
                    name,
                });
            }
        }
        Err(IngestError::Rejected(BUSY.into()))
    }
}

impl Drop for SeasonLock {
    fn drop(&mut self) {
        let Some(mut conn) = self.conn.take() else {
            return;
        };
        let name = std::mem::take(&mut self.name);
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => {
                runtime.spawn(async move {
                    let unlocked: Result<bool, _> =
                        sqlx::query_scalar("SELECT pg_advisory_unlock(hashtextextended($1, 0))")
                            .bind(&name)
                            .fetch_one(&mut *conn)
                            .await;
                    if !unlocked.unwrap_or(false) {
                        // The lock could not be let go: close the connection, which lets it go.
                        drop(conn.detach());
                    }
                });
            }
            // No runtime to let go on: closing the connection lets the lock go.
            Err(_) => drop(conn.detach()),
        }
    }
}

/// One stored 47003 record of the season, as a [`Row`] (`None` for one that is not a season family record).
fn row_of(event: &Event) -> Option<Row> {
    let step = classify_step(event).ok().flatten()?;
    let coordinate = event.tags.iter().find_map(|tag| {
        let parts = tag.as_slice();
        (parts.first().map(String::as_str) == Some("a")).then(|| parts.get(1).cloned())?
    })?;
    Some(Row {
        coordinate,
        family: step.family,
        at: (event.created_at.as_secs(), event.id.to_hex()),
    })
}

/// The records of season `number`, at most [`RECORDS_READ_MAX`]; `None` when there are more (the season counts as full).
async fn read_rows(
    state: &AppState,
    community: CommunityId,
    number: u32,
) -> Result<Option<Vec<Row>>, buzz_db::DbError> {
    let stored = state
        .db
        .query_events_for_event_write(&buzz_db::EventQuery {
            kinds: Some(vec![KIND_LAUNCH_UPDATE as i32]),
            global_only: true,
            tag_filters: vec![("t".to_owned(), vec![season_d(number)])],
            limit: Some(RECORDS_READ_MAX + 1),
            max_limit: Some(RECORDS_READ_MAX + 1),
            ..buzz_db::EventQuery::for_community(community)
        })
        .await?;
    if i64::try_from(stored.len()).is_ok_and(|n| n > RECORDS_READ_MAX) {
        return Ok(None);
    }
    Ok(Some(
        stored.iter().filter_map(|s| row_of(&s.event)).collect(),
    ))
}

/// The counted accounts of the project's newest numbers record (`held.countedAccounts`); `0` when it says none or says
/// nothing (a project the server has no record for cannot meet the bar).
async fn counted_accounts(
    state: &AppState,
    community: CommunityId,
    key: &[u8; 32],
) -> Result<u64, buzz_db::DbError> {
    Ok(super::room_write::numbers_record(state, community, key)
        .await?
        .and_then(|record| record.get("held")?.get("countedAccounts")?.as_u64())
        .unwrap_or(0))
}

fn refuse(reason: &'static str) -> IngestError {
    if reason.starts_with("restricted:") {
        IngestError::AuthFailed(reason.into())
    } else {
        IngestError::Rejected(reason.into())
    }
}

/// Hold a season family record to the rules of its family. The signer's place on the team is judged by the caller
/// (`launch_update_authority`); this asks the operator for a removal, the season and the network for an entry.
///
/// Returns the season's lock for an entry or a leave: the caller keeps it until the record is stored.
pub(crate) async fn enforce_step(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    event: &Event,
    step: Step,
    project: &Event,
    coordinate: &str,
) -> Result<Option<SeasonLock>, IngestError> {
    let community = tenant.community();
    let now = u64::try_from(chrono::Utc::now().timestamp()).unwrap_or(0);
    if step.family == Family::Remove {
        if !is_operator(state, &event.pubkey.to_hex()) {
            return Err(IngestError::AuthFailed(NOT_OPERATOR_REMOVE.into()));
        }
        read_season(state, community, step.number)
            .await
            .map_err(|e| internal("reading the season", e))?
            .ok_or_else(|| IngestError::Rejected(NO_SEASON.into()))?;
        return Ok(None);
    }
    let season = read_season(state, community, step.number)
        .await
        .map_err(|e| internal("reading the season", e))?
        .ok_or_else(|| IngestError::Rejected(NO_SEASON.into()))?;
    if !season.is_open(now) {
        return Err(refuse(NOT_OPEN));
    }
    if step.family == Family::Entry {
        let listed = crate::share_preview::public_standing(state, community, project.clone())
            .await
            .map_err(|e| internal("reading the project's standing", e))?;
        if listed.is_none() {
            return Err(IngestError::Rejected(NO_PROJECT.into()));
        }
        let (Some(config), Some(key)) = (
            state.config.chain_reader.as_ref(),
            super::task_chain::chain_key_of(project),
        ) else {
            return Err(refuse(NOT_LAUNCHED));
        };
        let launched = launched_of(state.db.pool(), &config.reader_id(), &key)
            .await
            .map_err(|e| internal("reading the project's launch", e))?;
        let tied = launched.is_some_and(|l| l.project_id == project_id(coordinate).to_lowercase());
        if !tied || split_coordinate(coordinate).is_none() {
            return Err(refuse(NOT_LAUNCHED));
        }
        let accounts = counted_accounts(state, community, &key)
            .await
            .map_err(|e| internal("reading the project's numbers", e))?;
        if accounts < ENTRY_MIN_ACCOUNTS {
            return Err(refuse(TOO_FEW_BACKERS));
        }
    }
    // The checks that depend on the other entries are made under the season's lock.
    let lock = SeasonLock::acquire(state.db.pool(), &season_d(step.number)).await?;
    let rows = read_rows(state, community, step.number)
        .await
        .map_err(|e| internal("reading the season's entries", e))?;
    let Some(rows) = rows else {
        return Err(refuse(SEASON_FULL));
    };
    let lineup = lineup(&rows);
    match step.family {
        Family::Entry => lineup.may_enter(coordinate),
        _ => lineup.may_leave(coordinate),
    }
    .map_err(refuse)?;
    Ok(Some(lock))
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::season::{CONTENT_MAX, DAY};
    use nostr::{EventBuilder, Keys, Kind, Tag};
    use serde_json::json;

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

    fn season_event(number: u32, d: &str, start: u64, demo: u64, end: u64) -> Event {
        event(
            KIND_SEASON,
            &json!({ "v": 1, "number": number, "startsAt": start, "demoDayAt": demo, "endsAt": end }).to_string(),
            &[&["d", d]],
        )
    }

    const T0: u64 = 1_800_000_000;

    #[test]
    fn a_season_record_holds_its_number_and_its_dates_to_their_bounds() {
        let ok = |event: Event| parse_season_record(&event);
        let good = ok(season_event(
            3,
            "season-3",
            T0,
            T0 + 42 * DAY,
            T0 + 49 * DAY,
        ))
        .expect("a season");
        assert_eq!(
            good,
            Season {
                number: 3,
                starts_at: T0,
                demo_day_at: T0 + 42 * DAY,
                ends_at: T0 + 49 * DAY
            }
        );
        // The shortest (a day to demo day) and the longest (56 days, then 14 more) stand.
        assert!(ok(season_event(1, "season-1", T0, T0 + DAY, T0 + DAY)).is_ok());
        assert!(ok(season_event(
            1,
            "season-1",
            T0,
            T0 + 56 * DAY,
            T0 + 70 * DAY
        ))
        .is_ok());
        for bad in [
            season_event(3, "season-4", T0, T0 + 42 * DAY, T0 + 49 * DAY),
            season_event(0, "season-0", T0, T0 + 42 * DAY, T0 + 49 * DAY),
            season_event(10_000, "season-10000", T0, T0 + 42 * DAY, T0 + 49 * DAY),
            season_event(1, "season-1", T0, T0, T0 + DAY),
            season_event(1, "season-1", T0, T0 + DAY - 1, T0 + DAY),
            season_event(1, "season-1", T0, T0 + 57 * DAY, T0 + 60 * DAY),
            season_event(1, "season-1", T0, T0 + 42 * DAY, T0 + 42 * DAY - 1),
            season_event(1, "season-1", T0, T0 + 42 * DAY, T0 + 57 * DAY + 1),
            season_event(
                1,
                "season-1",
                1_500_000_000,
                1_500_000_000 + DAY,
                1_500_000_000 + DAY,
            ),
            season_event(
                1,
                "season-1",
                4_102_444_000,
                4_102_444_000 + DAY,
                4_102_444_000 + 2 * DAY,
            ),
        ] {
            assert_eq!(parse_season_record(&bad), Err(BAD_SEASON), "{bad:?}");
        }
        // A missing `v`, two `d` tags, a leading zero, a body that is not JSON and a body over 1 KB.
        let no_v = event(
            KIND_SEASON,
            &json!({ "number": 1, "startsAt": T0, "demoDayAt": T0 + DAY, "endsAt": T0 + DAY })
                .to_string(),
            &[&["d", "season-1"]],
        );
        let two_d = event(
            KIND_SEASON,
            &json!({ "v": 1, "number": 1, "startsAt": T0, "demoDayAt": T0 + DAY, "endsAt": T0 + DAY }).to_string(),
            &[&["d", "season-1"], &["d", "season-1"]],
        );
        let not_json = event(KIND_SEASON, "soon", &[&["d", "season-1"]]);
        let long = event(
            KIND_SEASON,
            &" ".repeat(CONTENT_MAX + 1),
            &[&["d", "season-1"]],
        );
        for bad in [no_v, two_d, not_json, long] {
            assert_eq!(parse_season_record(&bad), Err(BAD_SEASON), "{bad:?}");
        }
    }

    #[test]
    fn entry_is_open_from_the_start_up_to_demo_day() {
        let season = Season {
            number: 1,
            starts_at: 100,
            demo_day_at: 200,
            ends_at: 300,
        };
        assert!(!season.is_open(99));
        assert!(season.is_open(100));
        assert!(season.is_open(199));
        assert!(!season.is_open(200));
        assert!(!season.is_open(300));
    }

    #[test]
    fn a_season_family_record_names_one_family_and_the_same_season_twice() {
        let a = "37001:aa:orbit";
        let step = |tags: &[&[&str]]| classify_step(&event(47003, "{}", tags));
        assert_eq!(
            step(&[&["a", a], &["t", "season-2"], &["season-entry", "2"]]),
            Ok(Some(Step {
                family: Family::Entry,
                number: 2
            }))
        );
        assert_eq!(
            step(&[&["a", a], &["t", "season-2"], &["season-leave", "2"]])
                .expect("read")
                .map(|s| s.family),
            Some(Family::Leave)
        );
        assert_eq!(
            step(&[&["a", a], &["t", "season-2"], &["season-remove", "2"]])
                .expect("read")
                .map(|s| s.family),
            Some(Family::Remove)
        );
        // Not a season record at all.
        assert_eq!(step(&[&["a", a], &["t", "orbit"]]), Ok(None));
        for bad in [
            // Two families, a number that is not canonical, a topic of another season, two topics, no topic.
            vec![
                vec!["season-entry", "2"],
                vec!["season-leave", "2"],
                vec!["t", "season-2"],
            ],
            vec![vec!["season-entry", "02"], vec!["t", "season-02"]],
            vec![vec!["season-entry", "0"], vec!["t", "season-0"]],
            vec![vec!["season-entry", "2"], vec!["t", "season-3"]],
            vec![
                vec!["season-entry", "2"],
                vec!["t", "season-2"],
                vec!["t", "season-3"],
            ],
            vec![vec!["season-entry", "2"]],
        ] {
            let tags: Vec<&[&str]> = bad.iter().map(Vec::as_slice).collect();
            assert!(step(&tags).is_err(), "{bad:?}");
        }
    }

    fn row(coordinate: &str, family: Family, at: u64, id: &str) -> Row {
        Row {
            coordinate: coordinate.into(),
            family,
            at: (at, id.into()),
        }
    }

    #[test]
    fn the_newest_of_entry_and_leave_is_the_projects_place_and_a_removal_beats_both() {
        let p = "37001:f1:orbit";
        let rows = vec![
            row(p, Family::Entry, 10, "a"),
            row(p, Family::Leave, 20, "b"),
        ];
        let out = lineup(&rows);
        assert_eq!(out.live(), Vec::<&str>::new());
        assert_eq!(out.may_enter(p), Ok(()));
        assert_eq!(out.may_leave(p), Err(NOT_IN));
        // Two records in one second: the larger id wins.
        let tie = vec![
            row(p, Family::Entry, 10, "z"),
            row(p, Family::Leave, 10, "a"),
        ];
        assert_eq!(lineup(&tie).live(), vec![p]);
        // Entered again after leaving.
        let again = vec![
            row(p, Family::Entry, 10, "a"),
            row(p, Family::Leave, 20, "b"),
            row(p, Family::Entry, 30, "c"),
        ];
        assert_eq!(lineup(&again).live(), vec![p]);
        assert_eq!(lineup(&again).may_enter(p), Err(ALREADY_IN));
        assert_eq!(lineup(&again).may_leave(p), Ok(()));
        // The operator's removal wins whenever it was signed.
        for removed in [
            vec![
                row(p, Family::Remove, 5, "r"),
                row(p, Family::Entry, 10, "a"),
            ],
            vec![
                row(p, Family::Entry, 10, "a"),
                row(p, Family::Remove, 15, "r"),
            ],
            vec![
                row(p, Family::Entry, 10, "a"),
                row(p, Family::Remove, 15, "r"),
                row(p, Family::Entry, 30, "c"),
            ],
        ] {
            let out = lineup(&removed);
            assert_eq!(out.live(), Vec::<&str>::new());
            assert_eq!(out.may_enter(p), Err(REMOVED));
        }
    }

    #[test]
    fn a_season_takes_500_entries_a_founder_3_and_a_project_12_changes() {
        let mut rows: Vec<Row> = (0..ENTRIES_MAX)
            .map(|n| row(&format!("37001:f{n}:p"), Family::Entry, 10, &format!("{n}")))
            .collect();
        assert_eq!(lineup(&rows).may_enter("37001:fnew:p"), Err(SEASON_FULL));
        // One fewer and there is room, one of them having left.
        rows.push(row("37001:f0:p", Family::Leave, 20, "x"));
        assert_eq!(lineup(&rows).may_enter("37001:fnew:p"), Ok(()));
        // Three projects of one founder.
        let founder: Vec<Row> = ["a", "b", "c"]
            .iter()
            .map(|d| row(&format!("37001:f1:{d}"), Family::Entry, 10, d))
            .collect();
        assert_eq!(lineup(&founder).may_enter("37001:f1:d"), Err(FOUNDER_FULL));
        assert_eq!(lineup(&founder).may_enter("37001:f2:d"), Ok(()));
        // A project that toggles twelve times is refused a thirteenth change, either way.
        let toggles: Vec<Row> = (0..CHANGES_MAX)
            .map(|n| {
                let family = if n % 2 == 0 {
                    Family::Entry
                } else {
                    Family::Leave
                };
                row("37001:f1:p", family, 10 + n, &format!("{n:02}"))
            })
            .collect();
        assert_eq!(lineup(&toggles).may_enter("37001:f1:p"), Err(TOO_OFTEN));
        let mut live = toggles;
        live.push(row("37001:f1:p", Family::Entry, 100, "zz"));
        assert_eq!(lineup(&live).may_leave("37001:f1:p"), Err(TOO_OFTEN));
    }
}
