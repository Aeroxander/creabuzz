//! Tasks open to anyone, paid on accept, and manager agents, driven through the real `ingest_event` seam: a stranger
//! takes a task, a second take is refused, the taker hands in, a person on the team confirms with the payment's
//! transaction, and nobody confirms their own work, their runner's or a sibling's. Removing the take checks, the taker
//! lookup or the manager refusal from the update authority fails these tests. Ignored without infrastructure; run with
//! `cargo test -p buzz-relay --lib -- task_takes_postgres_tests -- --ignored`.

use std::sync::Arc;

use buzz_core::kind::{KIND_LAUNCH_RECORD, KIND_LAUNCH_UPDATE, KIND_PROFILE};
use buzz_core::tenant::TenantContext;
use nostr::{Event, EventBuilder, Keys, Kind, Tag, Timestamp};

use buzz_auth::Scope;
use uuid::Uuid;

use super::agent_label::ROLE_FIXED;
use super::board_moderation_postgres_tests::community;
use super::ingest::{ingest_event, IngestAuth, IngestError};
use super::launch_update_authority::{
    AGENT_LIMIT, MANAGER_LIMIT, NOT_FOUNDER, NOT_HELPER, NOT_TEAM, OWN_WORK, TAKEN,
    TAKING_TOO_MUCH, TEAM_TAKES,
};
use crate::state::AppState;

const PAID: &str = "0x00000000000000000000000000000000000000000000000000000000000000ab";
const PAY_TO: &str = "0x00000000000000000000000000000000000000cd";

/// Ingest as the signer, with the scopes a signed-in app has (profiles included).
async fn ingest(state: &Arc<AppState>, tenant: &TenantContext, event: Event) -> Result<(), String> {
    let auth = IngestAuth::Nip42 {
        pubkey: event.pubkey,
        scopes: vec![
            Scope::UsersWrite,
            Scope::ChannelsWrite,
            Scope::MessagesWrite,
        ],
        channel_ids: None,
        conn_id: Uuid::new_v4(),
    };
    match ingest_event(state, tenant, event, auth).await {
        Ok(result) if result.accepted => Ok(()),
        Ok(result) => Err(result.message),
        Err(IngestError::Rejected(reason)) | Err(IngestError::AuthFailed(reason)) => Err(reason),
        Err(other) => panic!("refused oddly: {other:?}"),
    }
}

async fn accept(state: &Arc<AppState>, tenant: &TenantContext, event: Event, what: &str) {
    if let Err(reason) = ingest(state, tenant, event).await {
        panic!("{what}: refused: {reason}");
    }
}

async fn refuse(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    event: Event,
    expected: &str,
    what: &str,
) {
    match ingest(state, tenant, event).await {
        Ok(()) => panic!("{what}: should be refused"),
        Err(reason) => assert!(
            reason.contains(expected),
            "{what}: refused for the wrong reason: {reason}"
        ),
    }
}

fn hex(keys: &Keys) -> String {
    keys.public_key().to_hex()
}

fn signed(keys: &Keys, kind: u32, tags: &[&[&str]], ahead: u64, body: &str) -> Event {
    let tags: Vec<Tag> = tags
        .iter()
        .map(|fields| Tag::parse(fields.to_vec()).expect("tag"))
        .collect();
    EventBuilder::new(Kind::Custom(kind as u16), body)
        .tags(tags)
        .allow_self_tagging()
        .custom_created_at(Timestamp::from(Timestamp::now().as_secs() + ahead))
        .sign_with_keys(keys)
        .expect("sign")
}

fn record(who: &Keys, coordinate: &str, tags: &[&[&str]]) -> Event {
    let a: [&str; 2] = ["a", coordinate];
    let mut all: Vec<&[&str]> = vec![&a];
    all.extend_from_slice(tags);
    signed(who, KIND_LAUNCH_UPDATE, &all, 0, "{}")
}

/// A task open to anyone, paying `usd`. `what` keeps two tasks signed in one second apart.
fn open_task(who: &Keys, coordinate: &str, what: &str, usd: &str) -> Event {
    record(
        who,
        coordinate,
        &[
            &["l", "creaton-task"],
            &["task-part", "task"],
            &["task-what", what],
            &["task-done", "A map anyone can read"],
            &["task-size", "small"],
            &["task-usd", usd],
        ],
    )
}

fn step(who: &Keys, coordinate: &str, part: &str, task: &Event, extra: &[&[&str]]) -> Event {
    let id = task.id.to_hex();
    let (l, p, e, t) = (
        ["l", "creaton-task"],
        ["task-part", part],
        ["e", id.as_str()],
        ["task", id.as_str()],
    );
    let mut tags: Vec<&[&str]> = vec![&l, &p, &e, &t];
    tags.extend_from_slice(extra);
    record(who, coordinate, &tags)
}

/// The label `buzz agents label` writes, with `role` added when given.
fn label(agent: &Keys, operator: &Keys, role: Option<&str>, ahead: u64) -> Event {
    let json = buzz_sdk::nip_oa::compute_auth_tag(operator, &agent.public_key(), "").expect("sign");
    let auth: Vec<String> = serde_json::from_str(&json).expect("tag");
    let auth: Vec<&str> = auth.iter().map(String::as_str).collect();
    let me = hex(agent);
    let agent_tag = ["agent", me.as_str()];
    let mut tags: Vec<&[&str]> = vec![&agent_tag, &auth];
    let role_tag;
    if let Some(role) = role {
        role_tag = ["agent-role", role];
        tags.push(&role_tag);
    }
    signed(agent, KIND_PROFILE, &tags, ahead, r#"{"name":"Agent"}"#)
}

struct People {
    founder: Keys,
    mate: Keys,
    stranger: Keys,
    other: Keys,
}

async fn world() -> (Arc<AppState>, TenantContext, People, String) {
    let p = People {
        founder: Keys::generate(),
        mate: Keys::generate(),
        stranger: Keys::generate(),
        other: Keys::generate(),
    };
    let (state, tenant) = community(&[
        (&p.founder, "member"),
        (&p.mate, "member"),
        (&p.stranger, "member"),
        (&p.other, "member"),
    ])
    .await;
    let mate = hex(&p.mate);
    accept(
        &state,
        &tenant,
        signed(
            &p.founder,
            KIND_LAUNCH_RECORD,
            &[
                &["d", "orbit"],
                &["name", "Orbit"],
                &["team", &mate, "engineer"],
            ],
            0,
            "{}",
        ),
        "the project record",
    )
    .await;
    let coordinate = format!("37001:{}:orbit", hex(&p.founder));
    (state, tenant, p, coordinate)
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_stranger_takes_an_open_task_hands_it_in_and_a_person_on_the_team_accepts_and_pays() {
    let (state, tenant, p, coord) = world().await;
    let task = open_task(&p.founder, &coord, "Draw the map", "40");
    accept(
        &state,
        &tenant,
        task.clone(),
        "the founder posts an open task",
    )
    .await;
    refuse(
        &state,
        &tenant,
        open_task(&p.stranger, &coord, "Mine now", "40"),
        NOT_TEAM,
        "a stranger posts a task",
    )
    .await;

    // Nobody hands in before a take; the team does not take.
    refuse(
        &state,
        &tenant,
        step(
            &p.stranger,
            &coord,
            "evidence",
            &task,
            &[&["note", "early"]],
        ),
        NOT_HELPER,
        "work before a take",
    )
    .await;
    refuse(
        &state,
        &tenant,
        step(&p.mate, &coord, "take", &task, &[]),
        TEAM_TAKES,
        "a team member takes",
    )
    .await;

    accept(
        &state,
        &tenant,
        step(
            &p.stranger,
            &coord,
            "take",
            &task,
            &[&["task-pay-to", PAY_TO]],
        ),
        "the stranger takes it",
    )
    .await;
    refuse(
        &state,
        &tenant,
        step(&p.other, &coord, "take", &task, &[]),
        TAKEN,
        "a second take while one is live",
    )
    .await;
    refuse(
        &state,
        &tenant,
        step(&p.other, &coord, "evidence", &task, &[&["note", "mine"]]),
        NOT_HELPER,
        "someone else hands in",
    )
    .await;
    accept(
        &state,
        &tenant,
        step(
            &p.stranger,
            &coord,
            "evidence",
            &task,
            &[&["note", "the map"]],
        ),
        "the taker hands in",
    )
    .await;

    // The taker never confirms; a person on the team does, with the payment's transaction.
    refuse(
        &state,
        &tenant,
        step(
            &p.stranger,
            &coord,
            "confirm",
            &task,
            &[&["task-paid", PAID]],
        ),
        NOT_TEAM,
        "the taker confirms",
    )
    .await;
    accept(
        &state,
        &tenant,
        step(
            &p.founder,
            &coord,
            "confirm",
            &task,
            &[&["task-paid", PAID]],
        ),
        "the founder accepts and pays",
    )
    .await;
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_task_given_up_opens_again_but_not_for_whoever_gave_it_up() {
    let (state, tenant, p, coord) = world().await;
    let task = open_task(&p.founder, &coord, "Write the guide", "25");
    accept(&state, &tenant, task.clone(), "the task").await;
    accept(
        &state,
        &tenant,
        step(&p.stranger, &coord, "take", &task, &[]),
        "taken",
    )
    .await;
    accept(
        &state,
        &tenant,
        step(
            &p.stranger,
            &coord,
            "give-up",
            &task,
            &[&["note", "no time"]],
        ),
        "given up",
    )
    .await;
    refuse(
        &state,
        &tenant,
        step(&p.stranger, &coord, "take", &task, &[&["note", "again"]]),
        TAKEN,
        "taking again after giving up",
    )
    .await;
    accept(
        &state,
        &tenant,
        step(&p.other, &coord, "take", &task, &[]),
        "someone else takes it",
    )
    .await;
    // A cancelled task cannot be taken.
    let stopped = open_task(&p.founder, &coord, "Stopped", "5");
    accept(&state, &tenant, stopped.clone(), "a second task").await;
    accept(
        &state,
        &tenant,
        step(
            &p.mate,
            &coord,
            "cancel",
            &stopped,
            &[&["note", "not needed"]],
        ),
        "cancelled",
    )
    .await;
    refuse(
        &state,
        &tenant,
        step(&p.stranger, &coord, "take", &stopped, &[]),
        TAKEN,
        "taking a cancelled task",
    )
    .await;
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn takes_are_a_few_a_day() {
    let (state, tenant, p, coord) = world().await;
    for n in 0..20 {
        let task = open_task(&p.founder, &coord, &format!("Job {n}"), "1");
        accept(&state, &tenant, task.clone(), "a task").await;
        accept(
            &state,
            &tenant,
            step(&p.stranger, &coord, "take", &task, &[]),
            "a take",
        )
        .await;
    }
    let task = open_task(&p.founder, &coord, "One more", "1");
    accept(&state, &tenant, task.clone(), "a task").await;
    refuse(
        &state,
        &tenant,
        step(&p.stranger, &coord, "take", &task, &[]),
        TAKING_TOO_MUCH,
        "the twenty-first take today",
    )
    .await;
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn agents_never_check_their_own_their_runners_or_a_siblings_work_and_a_manager_takes_nothing()
{
    let (state, tenant, p, coord) = world().await;
    // Two worker agents run by the mate (who is on the team), one of them on the team; and a manager run by the
    // founder.
    let worker = Keys::generate();
    let sibling = Keys::generate();
    let manager = Keys::generate();
    for keys in [&worker, &sibling, &manager] {
        state
            .db
            .ensure_user(tenant.community(), &keys.public_key().to_bytes())
            .await
            .expect("user row");
    }
    accept(
        &state,
        &tenant,
        label(&worker, &p.mate, None, 0),
        "a worker label",
    )
    .await;
    accept(
        &state,
        &tenant,
        label(&sibling, &p.mate, None, 0),
        "a sibling label",
    )
    .await;
    accept(
        &state,
        &tenant,
        label(&manager, &p.founder, Some("manager"), 0),
        "the manager's label",
    )
    .await;
    // The role is set once, either way.
    refuse(
        &state,
        &tenant,
        label(&manager, &p.founder, None, 5),
        ROLE_FIXED,
        "a manager becoming a worker",
    )
    .await;
    refuse(
        &state,
        &tenant,
        label(&worker, &p.mate, Some("manager"), 5),
        ROLE_FIXED,
        "a worker becoming a manager",
    )
    .await;
    let (sib, man) = (hex(&sibling), hex(&manager));
    accept(
        &state,
        &tenant,
        signed(
            &p.founder,
            KIND_LAUNCH_RECORD,
            &[
                &["d", "orbit"],
                &["name", "Orbit"],
                &["team", &hex(&p.mate), "engineer"],
                &["team", &sib, "agent"],
                &["team", &man, "manager"],
            ],
            10,
            "{}",
        ),
        "the team with two agents",
    )
    .await;

    let task = open_task(&p.founder, &coord, "Fix the build", "30");
    accept(&state, &tenant, task.clone(), "the task").await;
    refuse(
        &state,
        &tenant,
        step(&manager, &coord, "evidence", &task, &[&["note", "drafted"]]),
        MANAGER_LIMIT,
        "the manager hands in",
    )
    .await;
    refuse(
        &state,
        &tenant,
        open_task(&manager, &coord, "Manager's task", "9"),
        MANAGER_LIMIT,
        "the manager posts a task",
    )
    .await;
    accept(
        &state,
        &tenant,
        step(&worker, &coord, "take", &task, &[]),
        "the worker agent takes it",
    )
    .await;
    accept(
        &state,
        &tenant,
        step(&worker, &coord, "evidence", &task, &[&["note", "fixed"]]),
        "the worker hands in",
    )
    .await;
    for (who, reason, what) in [
        (&p.mate, OWN_WORK, "the worker's runner confirms"),
        (&sibling, AGENT_LIMIT, "a sibling agent confirms"),
        (&manager, MANAGER_LIMIT, "the manager confirms"),
    ] {
        refuse(
            &state,
            &tenant,
            step(who, &coord, "confirm", &task, &[&["task-paid", PAID]]),
            reason,
            what,
        )
        .await;
    }
    accept(
        &state,
        &tenant,
        step(
            &p.founder,
            &coord,
            "confirm",
            &task,
            &[&["task-paid", PAID]],
        ),
        "the founder, a person, accepts and pays",
    )
    .await;

    // Agents still set no goals or promises, the manager included.
    for who in [&manager, &sibling] {
        refuse(
            &state,
            &tenant,
            record(who, &coord, &[&["goal", "g9"], &["goal-text", "More"]]),
            NOT_FOUNDER,
            "an agent sets a goal",
        )
        .await;
    }
}
