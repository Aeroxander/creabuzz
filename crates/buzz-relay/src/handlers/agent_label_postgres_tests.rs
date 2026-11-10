//! An agent account's label and what it limits, driven through the real
//! `ingest_event` seam: the label is a profile record (kind 0) stored through
//! ingest, and the limits are seen on project records (kind 47003) stored
//! through ingest afterwards. Removing the label check from ingest, the
//! "put on record" step, or the agent limit from the update authority fails
//! these tests. Ignored without infrastructure; run with
//! `cargo test -p buzz-relay --lib -- agent_label_postgres_tests -- --ignored`.

use std::sync::Arc;

use buzz_auth::Scope;
use buzz_core::kind::{KIND_LAUNCH_RECORD, KIND_LAUNCH_UPDATE, KIND_PROFILE};
use buzz_core::tenant::TenantContext;
use nostr::{Event, EventBuilder, Keys, Kind, Tag, Timestamp};
use uuid::Uuid;

use super::agent_label::{
    NOT_CONFIRMED, NOT_COVERED, NOT_YOUR_ACCOUNT, NO_OPERATOR, ONE_OPERATOR, OTHER_OPERATOR,
};
use super::board_moderation_postgres_tests::community;
use super::ingest::{ingest_event, IngestAuth, IngestError};
use super::launch_update_authority::{AGENT_LIMIT, NOT_FOUNDER, NOT_TEAM, OWN_WORK};
use crate::state::AppState;

fn hex(keys: &Keys) -> String {
    keys.public_key().to_hex()
}

/// Signed `ahead` seconds from now, so a newer profile or project record replaces the one before it.
fn signed(keys: &Keys, kind: u32, tags: Vec<Vec<String>>, body: &str, ahead: u64) -> Event {
    let tags: Vec<Tag> = tags
        .into_iter()
        .map(|fields| Tag::parse(fields).expect("tag"))
        .collect();
    EventBuilder::new(Kind::Custom(kind as u16), body)
        .tags(tags)
        .allow_self_tagging()
        .custom_created_at(Timestamp::from(Timestamp::now().as_secs() + ahead))
        .sign_with_keys(keys)
        .expect("sign")
}

fn strings(tags: &[&[&str]]) -> Vec<Vec<String>> {
    tags.iter()
        .map(|fields| fields.iter().map(|f| f.to_string()).collect())
        .collect()
}

fn profile(keys: &Keys, tags: Vec<Vec<String>>, ahead: u64) -> Event {
    signed(keys, KIND_PROFILE, tags, r#"{"name":"Mapper"}"#, ahead)
}

fn agent_tag(keys: &Keys) -> Vec<String> {
    vec!["agent".into(), hex(keys)]
}

/// The operator's signature for `agent`, as `buzz agents confirm` prints it.
fn auth_tag(operator: &Keys, agent: &Keys, conditions: &str) -> Vec<String> {
    let json = buzz_sdk::nip_oa::compute_auth_tag(operator, &agent.public_key(), conditions)
        .expect("sign");
    serde_json::from_str(&json).expect("tag")
}

/// The label as `buzz agents label` writes it.
fn label(agent: &Keys, operator: &Keys, ahead: u64) -> Event {
    profile(
        agent,
        vec![agent_tag(agent), auth_tag(operator, agent, "")],
        ahead,
    )
}

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

/// Who the server has on record as running `account`, if anyone.
async fn on_record(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    account: &Keys,
) -> Option<String> {
    state
        .db
        .get_agent_channel_policy(tenant.community(), &account.public_key().to_bytes())
        .await
        .expect("read the account")
        .and_then(|(_, operator)| operator)
        .map(::hex::encode)
}

async fn stored(state: &Arc<AppState>, tenant: &TenantContext, event: &Event) -> bool {
    state
        .db
        .get_event_by_id(tenant.community(), &event.id.to_bytes())
        .await
        .expect("read event")
        .is_some()
}

struct People {
    founder: Keys,
    /// On the project's team; becomes an agent in some tests.
    mate: Keys,
    /// Not on the team; the helper tasks name.
    helper: Keys,
    operator: Keys,
    stranger: Keys,
}

async fn world() -> (Arc<AppState>, TenantContext, People, String) {
    let p = People {
        founder: Keys::generate(),
        mate: Keys::generate(),
        helper: Keys::generate(),
        operator: Keys::generate(),
        stranger: Keys::generate(),
    };
    let (state, tenant) = community(&[
        (&p.founder, "member"),
        (&p.mate, "member"),
        (&p.helper, "member"),
        (&p.operator, "member"),
        (&p.stranger, "member"),
    ])
    .await;
    let mate = hex(&p.mate);
    accept(
        &state,
        &tenant,
        signed(
            &p.founder,
            KIND_LAUNCH_RECORD,
            strings(&[
                &["d", "orbit"],
                &["name", "Orbit"],
                &["team", &mate, "member"],
            ]),
            "{}",
            0,
        ),
        "the project record",
    )
    .await;
    let coordinate = format!("37001:{}:orbit", hex(&p.founder));
    (state, tenant, p, coordinate)
}

/// A project record of the update kind with these tags after the `a` tag.
fn record(who: &Keys, coordinate: &str, tags: &[&[&str]]) -> Event {
    let mut all = vec![vec!["a".to_string(), coordinate.to_string()]];
    all.extend(strings(tags));
    signed(who, KIND_LAUNCH_UPDATE, all, "{}", 0)
}

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

fn step(who: &Keys, coordinate: &str, part: &str, task: &Event, extra: &[&[&str]]) -> Event {
    let id = task.id.to_hex();
    let label: [&str; 2] = ["l", "creaton-task"];
    let part_tag: [&str; 2] = ["task-part", part];
    let e_tag: [&str; 2] = ["e", &id];
    let task_tag: [&str; 2] = ["task", &id];
    let mut tags: Vec<&[&str]> = vec![&label, &part_tag, &e_tag, &task_tag];
    tags.extend_from_slice(extra);
    record(who, coordinate, &tags)
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_label_takes_the_agents_key_and_the_operators() {
    let (state, tenant, p, _) = world().await;
    let agent = &p.helper;

    // A profile that says nothing about agents is stored and puts nothing on record.
    accept(
        &state,
        &tenant,
        profile(agent, vec![], 0),
        "a plain profile",
    )
    .await;
    assert_eq!(on_record(&state, &tenant, agent).await, None);

    // Saying "agent" with nobody's signature, or with a signature made for another account: refused, nothing stored,
    // nothing on record.
    let alone = profile(agent, vec![agent_tag(agent)], 1);
    refuse(
        &state,
        &tenant,
        alone.clone(),
        NO_OPERATOR,
        "a label naming nobody",
    )
    .await;
    let borrowed = profile(
        agent,
        vec![agent_tag(agent), auth_tag(&p.operator, &p.stranger, "")],
        1,
    );
    refuse(
        &state,
        &tenant,
        borrowed.clone(),
        NOT_CONFIRMED,
        "a label claiming an operator who signed for someone else",
    )
    .await;
    // Without the claim to be an agent too: an unsigned operator is never stored on a profile.
    refuse(
        &state,
        &tenant,
        profile(agent, vec![auth_tag(&p.operator, &p.stranger, "")], 1),
        NOT_CONFIRMED,
        "a profile claiming an operator who signed for someone else",
    )
    .await;
    refuse(
        &state,
        &tenant,
        profile(
            agent,
            vec![agent_tag(agent), auth_tag(&p.operator, agent, "kind=1")],
            1,
        ),
        NOT_COVERED,
        "a label whose operator signed for other records only",
    )
    .await;
    refuse(
        &state,
        &tenant,
        profile(
            agent,
            vec![
                agent_tag(agent),
                auth_tag(&p.operator, agent, ""),
                auth_tag(&p.mate, agent, ""),
            ],
            1,
        ),
        ONE_OPERATOR,
        "a label naming two operators",
    )
    .await;
    // Nobody labels another account: the stranger's profile naming the helper as the agent.
    refuse(
        &state,
        &tenant,
        profile(
            &p.stranger,
            vec![agent_tag(agent), auth_tag(&p.operator, &p.stranger, "")],
            1,
        ),
        NOT_YOUR_ACCOUNT,
        "a label for someone else's account",
    )
    .await;
    for refused in [&alone, &borrowed] {
        assert!(!stored(&state, &tenant, refused).await);
    }
    assert_eq!(on_record(&state, &tenant, agent).await, None);
    assert_eq!(on_record(&state, &tenant, &p.stranger).await, None);

    // Both keys: stored, and the account is on record as run by the operator.
    let labelled = label(agent, &p.operator, 2);
    accept(&state, &tenant, labelled.clone(), "the label").await;
    assert!(stored(&state, &tenant, &labelled).await);
    assert_eq!(
        on_record(&state, &tenant, agent).await,
        Some(hex(&p.operator))
    );

    // Saying it again is fine; naming a different operator afterwards is not, and changes nothing.
    accept(
        &state,
        &tenant,
        label(agent, &p.operator, 3),
        "the label again",
    )
    .await;
    let moved = label(agent, &p.mate, 4);
    refuse(
        &state,
        &tenant,
        moved.clone(),
        OTHER_OPERATOR,
        "a label naming a second operator",
    )
    .await;
    assert!(!stored(&state, &tenant, &moved).await);
    assert_eq!(
        on_record(&state, &tenant, agent).await,
        Some(hex(&p.operator))
    );
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_labelled_agent_does_a_helpers_work_and_nothing_that_needs_a_person() {
    let (state, tenant, p, coord) = world().await;
    // Two agents: the helper (not on the team) and the mate (on the team), both run by the operator.
    accept(
        &state,
        &tenant,
        label(&p.helper, &p.operator, 1),
        "the helper's label",
    )
    .await;
    accept(
        &state,
        &tenant,
        label(&p.mate, &p.operator, 1),
        "the mate's label",
    )
    .await;

    // A helper's whole path is open to an agent: offer, accept, hand in, ask for more time, give up.
    let asked = record(&p.founder, &coord, &[&["help-needed", "A map"]]);
    accept(&state, &tenant, asked.clone(), "the request").await;
    let asked_id = asked.id.to_hex();
    accept(
        &state,
        &tenant,
        record(
            &p.helper,
            &coord,
            &[&["e", &asked_id], &["help-offer", &asked_id]],
        ),
        "an agent's offer",
    )
    .await;
    let made = task(&p.founder, &coord, &p.helper, "Draw the map");
    accept(&state, &tenant, made.clone(), "the task").await;
    accept(
        &state,
        &tenant,
        step(&p.helper, &coord, "accept", &made, &[]),
        "an agent accepts its task",
    )
    .await;
    let work = step(
        &p.helper,
        &coord,
        "evidence",
        &made,
        &[&["task-link", "https://example.org/map"]],
    );
    accept(&state, &tenant, work.clone(), "an agent hands work in").await;
    let ask = step(
        &p.helper,
        &coord,
        "more-time",
        &made,
        &[&["task-due", "2030-01-01"]],
    );
    accept(&state, &tenant, ask.clone(), "an agent asks for more time").await;

    // What needs a person: checking work and granting more time, even for an agent on the team.
    let work_id = work.id.to_hex();
    let ask_id = ask.id.to_hex();
    let confirm = step(
        &p.mate,
        &coord,
        "confirm",
        &made,
        &[&["task-evidence", &work_id]],
    );
    refuse(
        &state,
        &tenant,
        confirm.clone(),
        AGENT_LIMIT,
        "an agent on the team checking work",
    )
    .await;
    assert!(!stored(&state, &tenant, &confirm).await);
    refuse(
        &state,
        &tenant,
        step(
            &p.mate,
            &coord,
            "grant",
            &made,
            &[&["task-ask", &ask_id], &["task-due", "2030-01-01"]],
        ),
        AGENT_LIMIT,
        "an agent on the team granting more time",
    )
    .await;
    // The team's other steps stay the agent's, as for any team member.
    accept(
        &state,
        &tenant,
        record(
            &p.mate,
            &coord,
            &[&["update-part", "done", "Drafted the notes"]],
        ),
        "an agent on the team posts an update",
    )
    .await;
    accept(
        &state,
        &tenant,
        step(
            &p.mate,
            &coord,
            "send-back",
            &made,
            &[&["task-evidence", &work_id]],
        ),
        "an agent on the team sends work back",
    )
    .await;
    // A person on the team checks it. (The operator is not on this team; were they, they could not check their
    // own agent's work.)
    accept(
        &state,
        &tenant,
        step(
            &p.founder,
            &coord,
            "confirm",
            &made,
            &[&["task-evidence", &work_id]],
        ),
        "the founder checks the agent's work",
    )
    .await;
    accept(
        &state,
        &tenant,
        step(&p.helper, &coord, "give-up", &made, &[]),
        "an agent gives up",
    )
    .await;

    // An agent out of place is told what anyone out of place is told.
    refuse(
        &state,
        &tenant,
        record(&p.helper, &coord, &[&["goal", "g1"]]),
        NOT_FOUNDER,
        "an agent stranger's goal",
    )
    .await;
    refuse(
        &state,
        &tenant,
        step(
            &p.helper,
            &coord,
            "confirm",
            &made,
            &[&["task-evidence", &work_id]],
        ),
        NOT_TEAM,
        "the agent checking its own work",
    )
    .await;
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn goals_and_promises_need_a_person_even_from_the_founder() {
    let (state, tenant, p, coord) = world().await;
    let goal: &[&[&str]] = &[
        &["goal", "g1"],
        &["goal-level", "main"],
        &["goal-state", "open"],
    ];
    let promise: &[&[&str]] = &[
        &["update-part", "next", "Ship the map"],
        &["promise", "p1", "Ship the map"],
    ];

    // Before any label the founder signs both, exactly as today.
    accept(
        &state,
        &tenant,
        record(&p.founder, &coord, goal),
        "the founder's goal",
    )
    .await;
    accept(
        &state,
        &tenant,
        record(&p.founder, &coord, promise),
        "the founder's promise",
    )
    .await;

    accept(
        &state,
        &tenant,
        label(&p.founder, &p.operator, 1),
        "the founder's label",
    )
    .await;
    let after: &[&[&str]] = &[
        &["goal", "g2"],
        &["goal-level", "main"],
        &["goal-state", "open"],
    ];
    let more: &[&[&str]] = &[&["update-part", "next", "More"], &["promise", "p2", "More"]];
    let mark: &[&[&str]] = &[&["promise-mark", "p1", "kept"]];
    for (tags, what) in [
        (after, "a goal"),
        (more, "a promise"),
        (mark, "a promise mark"),
    ] {
        let refused = record(&p.founder, &coord, tags);
        refuse(&state, &tenant, refused.clone(), AGENT_LIMIT, what).await;
        assert!(!stored(&state, &tenant, &refused).await, "{what}");
    }
    // An update without promises is still the agent founder's to post.
    accept(
        &state,
        &tenant,
        record(&p.founder, &coord, &[&["update-part", "done", "Shipped"]]),
        "an agent founder's update",
    )
    .await;
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn the_operator_cannot_check_work_its_labelled_agent_did() {
    let (state, tenant, p, coord) = world().await;
    // The mate runs the helper, by the helper's own label.
    accept(&state, &tenant, label(&p.helper, &p.mate, 1), "the label").await;
    let made = task(&p.founder, &coord, &p.helper, "Draw the map");
    accept(&state, &tenant, made.clone(), "the task").await;
    let work = step(
        &p.helper,
        &coord,
        "evidence",
        &made,
        &[&["task-link", "https://example.org/map"]],
    );
    accept(&state, &tenant, work.clone(), "the agent hands work in").await;
    let work_id = work.id.to_hex();
    refuse(
        &state,
        &tenant,
        step(
            &p.mate,
            &coord,
            "confirm",
            &made,
            &[&["task-evidence", &work_id]],
        ),
        OWN_WORK,
        "the operator checking its agent's work",
    )
    .await;
    accept(
        &state,
        &tenant,
        step(
            &p.founder,
            &coord,
            "confirm",
            &made,
            &[&["task-evidence", &work_id]],
        ),
        "someone else checks it",
    )
    .await;
}
