//! Seasons through the real `ingest_event` seam: the operator's record, who may enter a project and when, the bar of
//! counted accounts, the caps, the operator's removal and 600 entries sent at once. The chain rows come from the real
//! run (`room_support`); the counted accounts of a project come from the run's own example record. Ignored without
//! infrastructure; run with
//! `cargo test -p buzz-relay --lib -- season_rules_postgres_tests --include-ignored --test-threads=1`.

use std::collections::HashSet;
use std::sync::Arc;

use nostr::{Event, Keys};
use serde_json::json;

use super::room_support::{
    add_member, example_record, ingest, room_world_with, signed, tag, RoomWorld,
};
use crate::state::AppState;

use super::season_rules::{
    read_season, ALREADY_IN, BAD_SEASON, CHANGES_MAX, ENTRIES_MAX, ENTRY_MIN_ACCOUNTS,
    FOUNDER_FULL, NOT_IN, NOT_LAUNCHED, NOT_OPEN, NOT_OPERATOR, NOT_OPERATOR_REMOVE, NO_PROJECT,
    NO_SEASON, PER_FOUNDER_MAX, REMOVED, SEASON_FULL, TOO_FEW_BACKERS, TOO_OFTEN,
};

const DAY: u64 = 86_400;

fn now() -> u64 {
    u64::try_from(chrono::Utc::now().timestamp()).expect("now")
}

/// A world whose server lists one operator, with the run read to its end and the example numbers record signed for
/// the project (it says 3 accounts back it).
async fn season_world() -> (RoomWorld, Keys) {
    let operator = Keys::generate();
    let hex = operator.public_key().to_hex();
    let w = room_world_with(true, move |c| c.relay_operator_pubkeys = vec![hex]).await;
    add_member(&w.state, &w.tenant, &operator).await;
    w.seed_to(w.fx.head()).await;
    w.numbers_record(&example_record()).await;
    (w, operator)
}

fn season(operator: &Keys, number: u32, start: u64, demo: u64, end: u64, ahead: u64) -> Event {
    signed(
        operator,
        37021,
        &[tag(&["d", &format!("season-{number}")])],
        &json!({ "v": 1, "number": number, "startsAt": start, "demoDayAt": demo, "endsAt": end })
            .to_string(),
        ahead,
    )
}

/// A season that is open now: it began an hour ago and runs six weeks to demo day, then a week.
fn open_season(operator: &Keys, number: u32, ahead: u64) -> Event {
    let start = now() - 3_600;
    season(
        operator,
        number,
        start,
        start + 42 * DAY,
        start + 49 * DAY,
        ahead,
    )
}

fn family(who: &Keys, coordinate: &str, number: u32, family: &str, ahead: u64) -> Event {
    signed(
        who,
        47003,
        &[
            tag(&["a", coordinate]),
            tag(&["t", &format!("season-{number}")]),
            tag(&[family, &number.to_string()]),
        ],
        "{}",
        ahead,
    )
}

async fn accept(w: &RoomWorld, event: Event, what: &str) {
    if let Err(reason) = ingest(&w.state, &w.tenant, event).await {
        panic!("{what}: refused: {reason}");
    }
}

async fn refuse(w: &RoomWorld, event: Event, expected: &str, what: &str) {
    refuse_with(&w.state, w, event, expected, what).await;
}

async fn refuse_with(
    state: &Arc<AppState>,
    w: &RoomWorld,
    event: Event,
    expected: &str,
    what: &str,
) {
    match ingest(state, &w.tenant, event).await {
        Ok(()) => panic!("{what}: should be refused"),
        Err(reason) => assert!(
            reason.contains(expected),
            "{what}: refused for the wrong reason: {reason}"
        ),
    }
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn m1_only_an_operator_starts_a_season_its_dates_are_bound_and_a_later_record_replaces_it() {
    let (w, operator) = season_world().await;
    let stranger = w.account().await;
    refuse(
        &w,
        open_season(&stranger, 1, 0),
        NOT_OPERATOR,
        "a stranger's season",
    )
    .await;
    // Not even the founder of a project is an operator.
    refuse(
        &w,
        open_season(&w.founder, 1, 0),
        NOT_OPERATOR,
        "a founder's season",
    )
    .await;
    let t = now();
    for (what, bad) in [
        (
            "a demo day before the start",
            season(&operator, 1, t, t - DAY, t, 0),
        ),
        (
            "a demo day a minute in",
            season(&operator, 1, t, t + 60, t + 60, 0),
        ),
        (
            "a demo day 57 days out",
            season(&operator, 1, t, t + 57 * DAY, t + 58 * DAY, 0),
        ),
        (
            "an end 15 days after demo day",
            season(&operator, 1, t, t + 2 * DAY, t + 17 * DAY, 0),
        ),
        (
            "a start before 2020",
            season(
                &operator,
                1,
                1_500_000_000,
                1_500_000_000 + 2 * DAY,
                1_500_000_000 + 3 * DAY,
                0,
            ),
        ),
    ] {
        refuse(&w, bad, BAD_SEASON, what).await;
    }
    // A record whose `d` is not its number.
    let wrong_d = signed(
        &operator,
        37021,
        &[tag(&["d", "season-2"])],
        &json!({ "v": 1, "number": 1, "startsAt": t, "demoDayAt": t + 2 * DAY, "endsAt": t + 3 * DAY }).to_string(),
        0,
    );
    refuse(&w, wrong_d, BAD_SEASON, "a `d` that is not the number").await;

    // The operator's record stands; a later record with the same `d` replaces it, and the entry rules read the newest.
    let entrant = w.founder.clone();
    accept(
        &w,
        season(&operator, 1, t - 10 * DAY, t - 8 * DAY, t - 7 * DAY, 0),
        "a season in the past",
    )
    .await;
    refuse(
        &w,
        family(&entrant, &w.coordinate, 1, "season-entry", 0),
        NOT_OPEN,
        "entry to a season whose demo day has passed",
    )
    .await;
    accept(
        &w,
        open_season(&operator, 1, 3),
        "the operator moves the dates",
    )
    .await;
    accept(
        &w,
        family(&entrant, &w.coordinate, 1, "season-entry", 5),
        "entry after the dates moved",
    )
    .await;
}

/// The same server with another list of operators (the stored events and everything else are the same).
fn with_operators(w: &RoomWorld, operators: Vec<String>) -> Arc<AppState> {
    let mut config = (*w.state.config).clone();
    config.relay_operator_pubkeys = operators;
    config.relay_owner_pubkey = None;
    let mut state = (*w.state).clone();
    state.config = Arc::new(config);
    Arc::new(state)
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn m1b_a_season_reads_only_from_a_current_operators_record() {
    let (w, operator) = season_world().await;
    let community = w.tenant.community();
    accept(&w, open_season(&operator, 1, 20), "the operator's season").await;
    assert!(
        read_season(&w.state, community, 1)
            .await
            .expect("the read")
            .is_some(),
        "a current operator's record reads"
    );

    // The signer is no longer an operator (the list holds somebody else): the season reads as missing, and an entry is
    // refused as for a season that does not exist.
    let other = Keys::generate();
    let later = with_operators(&w, vec![other.public_key().to_hex()]);
    assert!(
        read_season(&later, community, 1)
            .await
            .expect("the read")
            .is_none(),
        "a record whose signer is no longer an operator is not a season"
    );
    refuse_with(
        &later,
        &w,
        family(&w.founder, &w.coordinate, 1, "season-entry", 0),
        NO_SEASON,
        "an entry into the former operator's season",
    )
    .await;

    // The new operator's own record for the same number wins, although the former operator's is newer.
    add_member(&later, &w.tenant, &other).await;
    let start = now() - 3_600;
    let theirs = season(&other, 1, start, start + 2 * DAY, start + 3 * DAY, 0);
    if let Err(reason) = ingest(&later, &w.tenant, theirs).await {
        panic!("the new operator's season: refused: {reason}");
    }
    let read = read_season(&later, community, 1)
        .await
        .expect("the read")
        .expect("the new operator's season");
    assert_eq!(
        read.demo_day_at,
        start + 2 * DAY,
        "only the current operator's dates are read, not the newer record of a former one"
    );
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn m2_entry_is_open_from_the_start_up_to_demo_day() {
    let (w, operator) = season_world().await;
    let t = now();
    refuse(
        &w,
        family(&w.founder, &w.coordinate, 7, "season-entry", 0),
        NO_SEASON,
        "a season that does not exist",
    )
    .await;
    accept(
        &w,
        season(
            &operator,
            8,
            t + 3_600,
            t + 3_600 + 2 * DAY,
            t + 3_600 + 3 * DAY,
            0,
        ),
        "a season that has not begun",
    )
    .await;
    refuse(
        &w,
        family(&w.founder, &w.coordinate, 8, "season-entry", 0),
        NOT_OPEN,
        "before the start",
    )
    .await;
    accept(
        &w,
        season(&operator, 9, t - 5 * DAY, t - 3 * DAY, t - 2 * DAY, 0),
        "a season that is over",
    )
    .await;
    refuse(
        &w,
        family(&w.founder, &w.coordinate, 9, "season-entry", 0),
        NOT_OPEN,
        "from demo day on",
    )
    .await;
    accept(&w, open_season(&operator, 10, 0), "an open season").await;
    accept(
        &w,
        family(&w.founder, &w.coordinate, 10, "season-entry", 0),
        "inside the days",
    )
    .await;
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn m3_only_the_projects_own_team_enters_it() {
    let (w, operator) = season_world().await;
    accept(&w, open_season(&operator, 1, 0), "a season").await;
    let stranger = w.account().await;
    refuse(
        &w,
        family(&stranger, &w.coordinate, 1, "season-entry", 0),
        "only this project's team",
        "a stranger enters the project",
    )
    .await;
    // Another founder's own project, entered by someone who is not on its team.
    let other = w.account().await;
    let other_project = w.extra_project(&other, "other").await;
    refuse(
        &w,
        family(&w.founder, &other_project, 1, "season-entry", 0),
        "only this project's team",
        "one founder enters another's project",
    )
    .await;
    // The team member who is not the founder may enter and leave.
    accept(
        &w,
        family(&w.mate, &w.coordinate, 1, "season-entry", 0),
        "a team member enters",
    )
    .await;
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn m4_the_project_must_be_launched_listed_not_removed_and_backed_by_enough_accounts() {
    let (w, operator) = season_world().await;
    accept(&w, open_season(&operator, 1, 0), "a season").await;

    // Not launched on the network: the project record names a chain key the reader has no launch for.
    let unlaunched = format!("37001:{}:unlaunched", w.founder.public_key().to_hex());
    accept(
        &w,
        signed(
            &w.founder,
            37001,
            &[
                tag(&["d", "unlaunched"]),
                tag(&[
                    "chain-key",
                    &format!("0x{}", hex::encode(w.fx.projects["B"].key)),
                ]),
            ],
            "{}",
            0,
        ),
        "a project record",
    )
    .await;
    refuse(
        &w,
        family(&w.founder, &unlaunched, 1, "season-entry", 0),
        NOT_LAUNCHED,
        "an unlaunched project",
    )
    .await;
    // A project record that names no launch at all.
    let nokey = format!("37001:{}:nokey", w.founder.public_key().to_hex());
    accept(
        &w,
        signed(&w.founder, 37001, &[tag(&["d", "nokey"])], "{}", 0),
        "a record with no chain key",
    )
    .await;
    refuse(
        &w,
        family(&w.founder, &nokey, 1, "season-entry", 0),
        NOT_LAUNCHED,
        "a project with no chain key",
    )
    .await;

    // A project the founder has not listed yet.
    let unlisted = w.extra_project(&w.founder, "hidden").await;
    accept(
        &w,
        signed(
            &w.founder,
            37001,
            &[
                tag(&["d", "hidden"]),
                tag(&[
                    "chain-key",
                    &format!("0x{}", hex::encode(sha2_key(&w, "hidden"))),
                ]),
            ],
            &json!({ "listing": "unlisted" }).to_string(),
            2,
        ),
        "the founder unlists it",
    )
    .await;
    refuse(
        &w,
        family(&w.founder, &unlisted, 1, "season-entry", 0),
        NO_PROJECT,
        "an unlisted project",
    )
    .await;

    // Fewer counted accounts than the bar (the example record's own figure less one), and none at all.
    let example = example_record();
    let counted = example["held"]["countedAccounts"]
        .as_u64()
        .expect("the example counts accounts");
    assert!(
        counted >= ENTRY_MIN_ACCOUNTS,
        "the example is above the bar"
    );
    let mut short = example.clone();
    short["held"]["countedAccounts"] = json!(ENTRY_MIN_ACCOUNTS - 1);
    tokio::time::sleep(std::time::Duration::from_millis(1_100)).await;
    w.numbers_record(&short).await;
    refuse(
        &w,
        family(&w.founder, &w.coordinate, 1, "season-entry", 0),
        TOO_FEW_BACKERS,
        "a project below the bar",
    )
    .await;
    let mut unknown = example.clone();
    unknown["held"] = json!(null);
    tokio::time::sleep(std::time::Duration::from_millis(1_100)).await;
    w.numbers_record(&unknown).await;
    refuse(
        &w,
        family(&w.founder, &w.coordinate, 1, "season-entry", 1),
        TOO_FEW_BACKERS,
        "a project whose held figures are not known",
    )
    .await;
    tokio::time::sleep(std::time::Duration::from_millis(1_100)).await;
    w.numbers_record(&example).await;
    accept(
        &w,
        family(&w.founder, &w.coordinate, 1, "season-entry", 2),
        "a project at the bar",
    )
    .await;
}

/// The chain key `extra_project` gave the project named `d` of the world's founder.
fn sha2_key(w: &RoomWorld, d: &str) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    Sha256::digest(format!(
        "{}:{}:{d}",
        w.reader,
        w.founder.public_key().to_hex()
    ))
    .into()
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn m5_a_project_is_in_once_can_leave_and_enter_again_and_the_operators_removal_wins() {
    let (w, operator) = season_world().await;
    accept(&w, open_season(&operator, 1, 0), "a season").await;
    let p = &w.coordinate;
    refuse(
        &w,
        family(&w.founder, p, 1, "season-leave", 0),
        NOT_IN,
        "a leave before any entry",
    )
    .await;
    accept(&w, family(&w.founder, p, 1, "season-entry", 1), "the entry").await;
    refuse(
        &w,
        family(&w.mate, p, 1, "season-entry", 2),
        ALREADY_IN,
        "a second entry",
    )
    .await;
    accept(&w, family(&w.mate, p, 1, "season-leave", 3), "the leave").await;
    refuse(
        &w,
        family(&w.mate, p, 1, "season-leave", 4),
        NOT_IN,
        "a second leave",
    )
    .await;
    accept(&w, family(&w.founder, p, 1, "season-entry", 5), "in again").await;

    // The operator takes it out; a stranger cannot.
    let stranger = w.account().await;
    refuse(
        &w,
        family(&stranger, p, 1, "season-remove", 6),
        NOT_OPERATOR_REMOVE,
        "a stranger's removal",
    )
    .await;
    refuse(
        &w,
        family(&w.founder, p, 1, "season-remove", 6),
        NOT_OPERATOR_REMOVE,
        "the founder's own removal is not an operator's",
    )
    .await;
    accept(
        &w,
        family(&operator, p, 1, "season-remove", 7),
        "the operator's removal",
    )
    .await;
    refuse(
        &w,
        family(&w.founder, p, 1, "season-entry", 8),
        REMOVED,
        "an entry after the removal",
    )
    .await;
    refuse(
        &w,
        family(&w.founder, p, 1, "season-leave", 9),
        NOT_IN,
        "a leave of a removed project",
    )
    .await;

    // A removal signed before any entry wins too, and only for that season.
    let second = w.extra_project(&w.founder, "second").await;
    accept(
        &w,
        family(&operator, &second, 1, "season-remove", 0),
        "a removal first",
    )
    .await;
    refuse(
        &w,
        family(&w.founder, &second, 1, "season-entry", 1),
        REMOVED,
        "entry after an earlier removal",
    )
    .await;
    accept(&w, open_season(&operator, 2, 0), "another season").await;
    accept(
        &w,
        family(&w.founder, &second, 2, "season-entry", 0),
        "the same project in the next season",
    )
    .await;
    // A removal names a season that exists.
    refuse(
        &w,
        family(&operator, &second, 9, "season-remove", 2),
        NO_SEASON,
        "a removal of a season that does not exist",
    )
    .await;
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn m6_a_founder_has_three_projects_in_a_season_and_a_project_twelve_changes() {
    let (w, operator) = season_world().await;
    accept(&w, open_season(&operator, 1, 0), "a season").await;
    let mut mine = vec![w.coordinate.clone()];
    for d in ["one", "two", "three"] {
        mine.push(w.extra_project(&w.founder, d).await);
    }
    for (n, p) in mine.iter().take(PER_FOUNDER_MAX).enumerate() {
        accept(
            &w,
            family(&w.founder, p, 1, "season-entry", n as u64),
            "inside the founder's three",
        )
        .await;
    }
    refuse(
        &w,
        family(&w.founder, &mine[PER_FOUNDER_MAX], 1, "season-entry", 9),
        FOUNDER_FULL,
        "a fourth project of one founder",
    )
    .await;
    // One that leaves frees a place.
    accept(
        &w,
        family(&w.founder, &mine[0], 1, "season-leave", 10),
        "one leaves",
    )
    .await;
    accept(
        &w,
        family(&w.founder, &mine[PER_FOUNDER_MAX], 1, "season-entry", 11),
        "the fourth takes its place",
    )
    .await;

    // A project that enters and leaves without end is stopped.
    let toggler = w.extra_project(&w.mate, "toggler").await;
    for n in 0..CHANGES_MAX {
        let name = if n % 2 == 0 {
            "season-entry"
        } else {
            "season-leave"
        };
        accept(
            &w,
            family(&w.mate, &toggler, 1, name, 20 + n),
            "a change inside the twelve",
        )
        .await;
    }
    refuse(
        &w,
        family(&w.mate, &toggler, 1, "season-entry", 40),
        TOO_OFTEN,
        "the thirteenth change",
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires Postgres and Redis"]
async fn m6_600_entries_sent_at_once_store_exactly_500_and_no_project_twice() {
    let (w, operator) = season_world().await;
    accept(&w, open_season(&operator, 1, 0), "a season").await;
    // 200 founders with three projects each: the founders' cap is not what fills the season.
    let mut entries: Vec<Event> = Vec::new();
    for f in 0..200 {
        let founder = w.account().await;
        for p in 0..PER_FOUNDER_MAX {
            let coordinate = w.extra_project(&founder, &format!("p{f}-{p}")).await;
            entries.push(family(&founder, &coordinate, 1, "season-entry", 0));
        }
    }
    assert_eq!(entries.len(), 600);
    let mut tasks = Vec::new();
    for event in entries {
        let (state, tenant) = (w.state.clone(), w.tenant.clone());
        tasks.push(tokio::spawn(async move {
            // The app asks again when the season is busy; so does the test.
            for _ in 0..400 {
                match ingest(&state, &tenant, event.clone()).await {
                    Err(reason) if reason.contains("busy") => {
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    }
                    other => return other,
                }
            }
            Err("still busy".to_owned())
        }));
    }
    let mut accepted = 0usize;
    let mut full = 0usize;
    for task in tasks {
        match task.await.expect("the task ran") {
            Ok(()) => accepted += 1,
            Err(reason) if reason.contains(SEASON_FULL) => full += 1,
            Err(other) => panic!("refused for another reason: {other}"),
        }
    }
    assert_eq!(accepted, ENTRIES_MAX, "the season took its cap and no more");
    assert_eq!(full, 600 - ENTRIES_MAX);
    // What is stored: 500 entries, each project once.
    let stored = w
        .state
        .db
        .query_events(&buzz_db::EventQuery {
            kinds: Some(vec![47003]),
            tag_filters: vec![("t".to_owned(), vec!["season-1".to_owned()])],
            limit: Some(1_000),
            ..buzz_db::EventQuery::for_community(w.tenant.community())
        })
        .await
        .expect("the season's records");
    assert_eq!(stored.len(), ENTRIES_MAX);
    let projects: HashSet<String> = stored
        .iter()
        .filter_map(|s| {
            s.event.tags.iter().find_map(|t| {
                let parts = t.as_slice();
                (parts.first().map(String::as_str) == Some("a")).then(|| parts[1].clone())
            })
        })
        .collect();
    assert_eq!(projects.len(), ENTRIES_MAX, "no project is in twice");
}
