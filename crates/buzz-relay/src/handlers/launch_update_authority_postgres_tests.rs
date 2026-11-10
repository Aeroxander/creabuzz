//! Who may sign a project's update records (kind 47003), and what a kind 5
//! deletion may do to them, driven through the real `ingest_event` seam.
//! Removing the authority check from ingest, or the kind checks from deletion
//! validation, fails these tests. Ignored without infrastructure; run with
//! `cargo test -p buzz-relay --lib -- launch_update_authority_postgres_tests -- --ignored`.

use std::sync::Arc;

use buzz_core::kind::{KIND_DELETION, KIND_LAUNCH_RECORD, KIND_LAUNCH_UPDATE};
use buzz_core::tenant::TenantContext;
use nostr::{Event, EventBuilder, Keys, Kind, Tag, Timestamp};

use super::board_moderation_postgres_tests::{accept, community, refuse};
use super::launch_update_authority::{
    NOT_FOUNDER, NOT_HELPER, NOT_TEAM, NO_PROJECT, NO_TASK, OTHER_PROJECT, OWN_WORK,
};
use crate::state::AppState;

/// Signed `ahead` seconds from now: a project record replaces the one before
/// it only when it is newer, and two signed in the same second would tie.
fn signed_at(keys: &Keys, kind: u32, tags: &[&[&str]], ahead: u64) -> Event {
    let tags: Vec<Tag> = tags
        .iter()
        .map(|fields| Tag::parse(fields.to_vec()).expect("tag"))
        .collect();
    EventBuilder::new(Kind::Custom(kind as u16), "{}")
        .tags(tags)
        .allow_self_tagging()
        .custom_created_at(Timestamp::from(Timestamp::now().as_secs() + ahead))
        .sign_with_keys(keys)
        .expect("sign")
}

fn hex(keys: &Keys) -> String {
    keys.public_key().to_hex()
}

fn coordinate(founder: &Keys, d: &str) -> String {
    format!("37001:{}:{d}", hex(founder))
}

/// The project record, with `team` on it.
fn project(founder: &Keys, d: &str, team: &[&Keys], ahead: u64) -> Event {
    let members: Vec<String> = team.iter().map(|keys| hex(keys)).collect();
    let mut tags: Vec<Vec<&str>> = vec![vec!["d", d], vec!["name", "Orbit"]];
    for member in &members {
        tags.push(vec!["team", member, "engineer"]);
    }
    let tags: Vec<&[&str]> = tags.iter().map(|t| t.as_slice()).collect();
    signed_at(founder, KIND_LAUNCH_RECORD, &tags, ahead)
}

/// An update record on the project, with these tags after the `a` tag.
fn record(who: &Keys, coordinate: &str, tags: &[&[&str]]) -> Event {
    let a: [&str; 2] = ["a", coordinate];
    let mut all: Vec<&[&str]> = vec![&a];
    all.extend_from_slice(tags);
    signed_at(who, KIND_LAUNCH_UPDATE, &all, 0)
}

/// A task for `helper`. `what` also keeps two tasks signed in the same second from being one event.
fn task(who: &Keys, coordinate: &str, helper: &Keys, what: &str) -> Event {
    let helper = hex(helper);
    record(
        who,
        coordinate,
        &[
            &["l", "creaton-task"],
            &["task-part", "task"],
            &["p", &helper],
            &["task-helper", &helper],
            &["task-what", what],
            &["task-done", "A map anyone can read"],
            &["task-size", "small"],
        ],
    )
}

fn step(who: &Keys, coordinate: &str, part: &str, task: &Event, note: &str) -> Event {
    let id = task.id.to_hex();
    record(
        who,
        coordinate,
        &[
            &["l", "creaton-task"],
            &["task-part", part],
            &["e", &id],
            &["task", &id],
            // Keeps two steps of the same part by the same signer from being one event.
            &["note", note],
        ],
    )
}

fn deletion(who: &Keys, target: &Event, k: Option<&str>) -> Event {
    let id = target.id.to_hex();
    let mut tags: Vec<&[&str]> = vec![];
    let e: [&str; 2] = ["e", &id];
    tags.push(&e);
    let k_tag: [&str; 2] = ["k", k.unwrap_or("")];
    if k.is_some() {
        tags.push(&k_tag);
    }
    signed_at(who, KIND_DELETION, &tags, 0)
}

async fn stored(state: &Arc<AppState>, tenant: &TenantContext, event: &Event) -> bool {
    state
        .db
        .get_event_by_id(tenant.community(), &event.id.to_bytes())
        .await
        .expect("read event")
        .is_some()
}

/// The author's deletions, as the web app reads them to say what was removed:
/// `{kinds:[5], authors:[author]}`.
async fn deletions_by(state: &Arc<AppState>, tenant: &TenantContext, author: &Keys) -> Vec<String> {
    state
        .db
        .query_events(&buzz_db::EventQuery {
            kinds: Some(vec![KIND_DELETION as i32]),
            pubkey: Some(author.public_key().to_bytes().to_vec()),
            limit: Some(50),
            ..buzz_db::EventQuery::for_community(tenant.community())
        })
        .await
        .expect("query deletions")
        .into_iter()
        .map(|stored| stored.event.id.to_hex())
        .collect()
}

struct People {
    founder: Keys,
    mate: Keys,
    stranger: Keys,
    helper: Keys,
}

async fn world() -> (Arc<AppState>, TenantContext, People, String) {
    let people = People {
        founder: Keys::generate(),
        mate: Keys::generate(),
        stranger: Keys::generate(),
        helper: Keys::generate(),
    };
    let (state, tenant) = community(&[
        (&people.founder, "member"),
        (&people.mate, "member"),
        (&people.stranger, "member"),
        (&people.helper, "member"),
    ])
    .await;
    accept(
        &state,
        &tenant,
        project(&people.founder, "orbit", &[&people.mate], 0),
        "the project record",
    )
    .await;
    let coordinate = coordinate(&people.founder, "orbit");
    (state, tenant, people, coordinate)
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn goals_updates_and_offers_are_stored_only_from_the_right_signer() {
    let (state, tenant, p, coord) = world().await;
    let goal: &[&[&str]] = &[
        &["goal", "g1"],
        &["goal-level", "main"],
        &["goal-state", "open"],
        &["goal-text", "A thousand readers"],
    ];
    let update: &[&[&str]] = &[&["update-part", "done", "Shipped the map"]];

    accept(
        &state,
        &tenant,
        record(&p.founder, &coord, goal),
        "founder's goal",
    )
    .await;
    let forged = record(&p.mate, &coord, goal);
    refuse(
        &state,
        &tenant,
        forged.clone(),
        NOT_FOUNDER,
        "a team member's goal",
    )
    .await;
    assert!(
        !stored(&state, &tenant, &forged).await,
        "a refused record is not stored"
    );
    refuse(
        &state,
        &tenant,
        record(&p.stranger, &coord, &[&["promise-mark", "p1", "kept"]]),
        NOT_FOUNDER,
        "a stranger answering the founder's promise",
    )
    .await;

    accept(
        &state,
        &tenant,
        record(&p.mate, &coord, update),
        "a team member's update",
    )
    .await;
    let junk = record(&p.stranger, &coord, update);
    refuse(
        &state,
        &tenant,
        junk.clone(),
        NOT_TEAM,
        "a stranger's update",
    )
    .await;
    assert!(!stored(&state, &tenant, &junk).await);

    // An offer is anyone's to make; only the team answers it or marks the request found.
    let asked = record(&p.founder, &coord, &[&["help-needed", "A designer"]]);
    accept(&state, &tenant, asked.clone(), "the request").await;
    let asked_id = asked.id.to_hex();
    let offer = record(
        &p.stranger,
        &coord,
        &[&["e", &asked_id], &["help-offer", &asked_id]],
    );
    accept(&state, &tenant, offer.clone(), "a stranger's offer").await;
    let offer_id = offer.id.to_hex();
    let reply: &[&[&str]] = &[&["e", &offer_id], &["help-reply", &offer_id]];
    refuse(
        &state,
        &tenant,
        record(&p.stranger, &coord, reply),
        NOT_TEAM,
        "a stranger replying as the team",
    )
    .await;
    accept(
        &state,
        &tenant,
        record(&p.mate, &coord, reply),
        "the team's reply",
    )
    .await;
    refuse(
        &state,
        &tenant,
        record(&p.helper, &coord, &[&["help-found", &asked_id]]),
        NOT_TEAM,
        "a stranger closing the request",
    )
    .await;

    // Records of no known family are stored from anyone, as before: submitted work, a review note.
    accept(
        &state,
        &tenant,
        record(&p.stranger, &coord, &[]),
        "a record with only the `a` tag",
    )
    .await;
    // A family record that cannot be read as one is refused whoever signs it.
    refuse(
        &state,
        &tenant,
        record(&p.founder, &coord, &[&["help-reply", "nope"]]),
        "invalid: `help-reply` tag must hold the id",
        "a reply that names nothing",
    )
    .await;
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn membership_is_checked_when_the_record_is_written() {
    let (state, tenant, p, coord) = world().await;
    let update = |who: &Keys, words: &str| record(who, &coord, &[&["update-part", "done", words]]);

    let while_member = update(&p.mate, "While on the team");
    accept(
        &state,
        &tenant,
        while_member.clone(),
        "an update while on the team",
    )
    .await;
    refuse(
        &state,
        &tenant,
        update(&p.helper, "Not yet on the team"),
        NOT_TEAM,
        "an update before joining",
    )
    .await;

    // The founder swaps the team: the mate leaves, the helper joins.
    accept(
        &state,
        &tenant,
        project(&p.founder, "orbit", &[&p.helper], 2),
        "the new team",
    )
    .await;

    refuse(
        &state,
        &tenant,
        update(&p.mate, "After leaving"),
        NOT_TEAM,
        "a former member's update",
    )
    .await;
    accept(
        &state,
        &tenant,
        update(&p.helper, "After joining"),
        "a new member's update",
    )
    .await;
    // What was stored while they were on the team stays: the check is not run again.
    assert!(stored(&state, &tenant, &while_member).await);
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_family_record_needs_its_project_on_the_server() {
    let (state, tenant, p, _) = world().await;
    // The stranger names a project of their own that was never published.
    let nowhere = coordinate(&p.stranger, "ghost");
    refuse(
        &state,
        &tenant,
        record(&p.stranger, &nowhere, &[&["goal", "g1"]]),
        NO_PROJECT,
        "a goal for a project that is not there",
    )
    .await;
    // Even an offer, which anyone may make, needs a project to be made to.
    let id = "a".repeat(64);
    refuse(
        &state,
        &tenant,
        record(&p.stranger, &nowhere, &[&["help-offer", &id]]),
        NO_PROJECT,
        "an offer to a project that is not there",
    )
    .await;
    // Another founder's id under this founder's key is not this project either.
    refuse(
        &state,
        &tenant,
        record(
            &p.founder,
            &coordinate(&p.founder, "other"),
            &[&["goal", "g1"]],
        ),
        NO_PROJECT,
        "a goal for another id",
    )
    .await;
    // Unchanged: a record of no known family is not looked up at all.
    accept(
        &state,
        &tenant,
        record(&p.stranger, &nowhere, &[]),
        "a plain record for a project that is not there",
    )
    .await;
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn task_steps_are_stored_only_from_the_team_or_the_named_helper() {
    let (state, tenant, p, coord) = world().await;

    refuse(
        &state,
        &tenant,
        task(&p.stranger, &coord, &p.stranger, "Pay me"),
        NOT_TEAM,
        "a stranger handing themselves a task",
    )
    .await;
    let made = task(&p.founder, &coord, &p.helper, "Draw the map");
    accept(&state, &tenant, made.clone(), "the founder's task").await;

    refuse(
        &state,
        &tenant,
        step(&p.stranger, &coord, "evidence", &made, "forged"),
        NOT_HELPER,
        "a stranger handing work in",
    )
    .await;
    refuse(
        &state,
        &tenant,
        step(&p.mate, &coord, "accept", &made, "for them"),
        NOT_HELPER,
        "the team accepting for the helper",
    )
    .await;
    accept(
        &state,
        &tenant,
        step(&p.helper, &coord, "accept", &made, "yes"),
        "the helper accepts",
    )
    .await;
    accept(
        &state,
        &tenant,
        step(&p.helper, &coord, "evidence", &made, "here it is"),
        "the helper hands work in",
    )
    .await;

    refuse(
        &state,
        &tenant,
        step(&p.helper, &coord, "confirm", &made, "looks good to me"),
        NOT_TEAM,
        "the helper confirming their own work",
    )
    .await;
    refuse(
        &state,
        &tenant,
        step(&p.stranger, &coord, "send-back", &made, "no"),
        NOT_TEAM,
        "a stranger sending work back",
    )
    .await;
    accept(
        &state,
        &tenant,
        step(&p.mate, &coord, "confirm", &made, "checked"),
        "a team member confirms",
    )
    .await;

    // A step that names a task the server does not hold.
    let never_sent = task(&p.founder, &coord, &p.helper, "Never sent");
    refuse(
        &state,
        &tenant,
        step(&p.helper, &coord, "evidence", &never_sent, "x"),
        NO_TASK,
        "work for a task that is not there",
    )
    .await;
    // A record that is there but is not a task.
    let plain = record(&p.helper, &coord, &[]);
    accept(&state, &tenant, plain.clone(), "a plain record").await;
    refuse(
        &state,
        &tenant,
        step(&p.helper, &coord, "evidence", &plain, "x"),
        NO_TASK,
        "work for a record that is not a task",
    )
    .await;

    // A task from another project: the stranger's own, where they are founder and helper.
    accept(
        &state,
        &tenant,
        project(&p.stranger, "mine", &[], 0),
        "the stranger's own project",
    )
    .await;
    let theirs = coordinate(&p.stranger, "mine");
    let foreign = task(&p.stranger, &theirs, &p.stranger, "My own");
    accept(
        &state,
        &tenant,
        foreign.clone(),
        "a task on their own project",
    )
    .await;
    refuse(
        &state,
        &tenant,
        step(&p.stranger, &coord, "evidence", &foreign, "smuggled"),
        OTHER_PROJECT,
        "a step on this project naming a task from another",
    )
    .await;

    // A task whose record was deleted is no longer there to take steps.
    let gone = task(&p.mate, &coord, &p.helper, "Soon removed");
    accept(&state, &tenant, gone.clone(), "a second task").await;
    accept(
        &state,
        &tenant,
        deletion(&p.mate, &gone, Some("47003")),
        "its maker removes it",
    )
    .await;
    refuse(
        &state,
        &tenant,
        step(&p.helper, &coord, "evidence", &gone, "late"),
        NO_TASK,
        "work for a removed task",
    )
    .await;
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn whoever_runs_the_helper_cannot_confirm_its_work() {
    let (state, tenant, p, coord) = world().await;
    // The helper is an agent the mate runs, as the relay's own records say.
    let community = tenant.community();
    for keys in [&p.mate, &p.helper] {
        state
            .db
            .ensure_user(community, &keys.public_key().to_bytes())
            .await
            .expect("user row");
    }
    assert!(state
        .db
        .set_agent_owner(
            community,
            &p.helper.public_key().to_bytes(),
            &p.mate.public_key().to_bytes(),
        )
        .await
        .expect("set owner"));

    let made = task(&p.founder, &coord, &p.helper, "Draw the map");
    accept(&state, &tenant, made.clone(), "the task").await;
    accept(
        &state,
        &tenant,
        step(&p.helper, &coord, "evidence", &made, "done"),
        "the agent hands work in",
    )
    .await;
    refuse(
        &state,
        &tenant,
        step(&p.mate, &coord, "confirm", &made, "my agent did well"),
        OWN_WORK,
        "the agent's owner confirming its work",
    )
    .await;
    // The owner is still on the team for everything else, and someone else may confirm.
    accept(
        &state,
        &tenant,
        step(&p.mate, &coord, "send-back", &made, "try again"),
        "the owner sends it back",
    )
    .await;
    accept(
        &state,
        &tenant,
        step(&p.founder, &coord, "confirm", &made, "checked"),
        "the founder confirms",
    )
    .await;

    // Being run by a team member does not put the agent on the team.
    refuse(
        &state,
        &tenant,
        record(
            &p.helper,
            &coord,
            &[&["update-part", "done", "As my owner"]],
        ),
        NOT_TEAM,
        "an agent posting as its owner's team",
    )
    .await;
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_deletion_hides_the_record_and_stays_readable_itself() {
    let (state, tenant, p, coord) = world().await;
    let update = record(&p.founder, &coord, &[&["update-part", "done", "Oops"]]);
    accept(&state, &tenant, update.clone(), "the update").await;

    // A `k` tag that names another kind: refused, and nothing is removed.
    refuse(
        &state,
        &tenant,
        deletion(&p.founder, &update, Some("1")),
        "`k` tag names kind 1 but the target is kind 47003",
        "a deletion that misnames its target",
    )
    .await;
    assert!(stored(&state, &tenant, &update).await);

    let removal = deletion(&p.founder, &update, Some("47003"));
    accept(&state, &tenant, removal.clone(), "the founder removes it").await;
    // Readers no longer get the record; the deletion itself is found by its author and kind.
    assert!(!stored(&state, &tenant, &update).await);
    assert_eq!(
        deletions_by(&state, &tenant, &p.founder).await,
        vec![removal.id.to_hex()]
    );

    // Deleting the deletion: refused with or without a `k`, and the removal still shows.
    for k in [None, Some("5")] {
        refuse(
            &state,
            &tenant,
            deletion(&p.founder, &removal, k),
            "a deletion cannot be deleted",
            "a deletion of a deletion",
        )
        .await;
    }
    assert_eq!(
        deletions_by(&state, &tenant, &p.founder).await,
        vec![removal.id.to_hex()]
    );

    // Should one reach the side effect anyway, it changes nothing either.
    super::side_effects::handle_side_effects(
        &tenant,
        KIND_DELETION,
        &deletion(&p.founder, &removal, None),
        &state,
    )
    .await
    .expect("side effect runs");
    assert_eq!(
        deletions_by(&state, &tenant, &p.founder).await,
        vec![removal.id.to_hex()]
    );
    assert!(
        !stored(&state, &tenant, &update).await,
        "the update stays removed"
    );

    // Without a `k` a deletion works as before, and only the author may send one.
    let second = record(&p.founder, &coord, &[&["update-part", "done", "Again"]]);
    accept(&state, &tenant, second.clone(), "a second update").await;
    refuse(
        &state,
        &tenant,
        deletion(&p.stranger, &second, Some("47003")),
        "must be event author",
        "a stranger's deletion",
    )
    .await;
    accept(
        &state,
        &tenant,
        deletion(&p.founder, &second, None),
        "a deletion with no `k`",
    )
    .await;
    assert!(!stored(&state, &tenant, &second).await);
}
