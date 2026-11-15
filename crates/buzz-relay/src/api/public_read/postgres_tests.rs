//! Public project reads through the real router (`POST /query`), a real
//! community and real records. Needs Postgres and Redis:
//! `cargo test -p buzz-relay --lib -- api::public_read::postgres_tests --ignored`.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use buzz_auth::Scope;
use buzz_core::kind::{KIND_DELETION, KIND_LAUNCH_RECORD, KIND_LAUNCH_UPDATE};
use buzz_core::tenant::TenantContext;
use nostr::{Event, EventBuilder, Keys, Kind, Tag, Timestamp};
use serde_json::{json, Value};
use tower::ServiceExt;
use uuid::Uuid;

use crate::handlers::ingest::{ingest_event, IngestAuth};
use crate::state::AppState;

struct World {
    state: Arc<AppState>,
    tenant: TenantContext,
    founder: Keys,
    /// A member who is not on any project's team.
    helper: Keys,
    /// Someone with a key and no place on the member list.
    visitor: Keys,
}

/// A community with a founder and a helper on its list, on a server its
/// operator made invite-only and whose `BUZZ_PUBLIC_PROJECT_READS` is
/// `public_reads`. Nothing is kept between requests unless a test asks.
async fn world(public_reads: bool) -> World {
    world_with(public_reads, |_| {}).await
}

async fn world_with(
    public_reads: bool,
    configure: impl FnOnce(&mut crate::config::Config),
) -> World {
    let state = crate::test_support::test_state_with(move |config| {
        config.public_project_reads = public_reads;
        config.require_relay_membership = true;
        config.public_project_reads_cache_secs = 0;
        config.new_account_posts_per_hour = 0;
        configure(config);
    })
    .await;
    let host = format!("public-read-{}.example", Uuid::new_v4().simple());
    let community = state
        .db
        .ensure_configured_community(&host)
        .await
        .expect("community")
        .id;
    let founder = Keys::generate();
    let helper = Keys::generate();
    for member in [&founder, &helper] {
        state
            .db
            .add_relay_member(community, &member.public_key().to_hex(), "member", None)
            .await
            .expect("member");
    }
    World {
        state,
        tenant: TenantContext::resolved(community, host),
        founder,
        helper,
        visitor: Keys::generate(),
    }
}

fn signed(keys: &Keys, kind: u32, tags: &[&[&str]], body: &str, ahead: u64) -> Event {
    let tags: Vec<Tag> = tags
        .iter()
        .map(|t| Tag::parse(t.to_vec()).expect("tag"))
        .collect();
    EventBuilder::new(Kind::Custom(kind as u16), body)
        .tags(tags)
        .allow_self_tagging()
        .custom_created_at(Timestamp::from(Timestamp::now().as_secs() + ahead))
        .sign_with_keys(keys)
        .expect("sign")
}

async fn publish(w: &World, event: Event) -> String {
    let id = event.id.to_hex();
    let auth = IngestAuth::Nip42 {
        pubkey: event.pubkey,
        scopes: Scope::all_known(),
        channel_ids: None,
        conn_id: Uuid::new_v4(),
    };
    let result = ingest_event(&w.state, &w.tenant, event, auth)
        .await
        .expect("accepted by the server");
    assert!(result.accepted, "{}", result.message);
    id
}

fn coordinate(w: &World, id: &str) -> String {
    format!("37001:{}:{id}", w.founder.public_key().to_hex())
}

/// A listed project with a goal, one weekly update and an offer of help from
/// the helper. Returns the ids of the goal, the update and the offer.
async fn project(w: &World, id: &str, body: &str) -> [String; 3] {
    publish(
        w,
        signed(
            &w.founder,
            KIND_LAUNCH_RECORD,
            &[&["d", id], &["name", "Nebula"]],
            body,
            0,
        ),
    )
    .await;
    let coordinate = coordinate(w, id);
    let goal = publish(
        w,
        signed(
            &w.founder,
            KIND_LAUNCH_UPDATE,
            &[
                &["a", &coordinate],
                &["goal", "g1"],
                &["goal-level", "primary"],
                &["goal-text", "Publish 12 maps"],
                &["goal-how", "We will count them"],
                &["goal-state", "open"],
            ],
            "{}",
            0,
        ),
    )
    .await;
    let update = publish(
        w,
        signed(
            &w.founder,
            KIND_LAUNCH_UPDATE,
            &[
                &["a", &coordinate],
                &["update-part", "done", "Shipped the first map"],
            ],
            r#"{"title":"Week 1"}"#,
            1,
        ),
    )
    .await;
    let offer = publish(
        w,
        signed(
            &w.helper,
            KIND_LAUNCH_UPDATE,
            &[
                &["a", &coordinate],
                &["e", &update],
                &["help-offer", &update],
            ],
            r#"{"note":"I can draw"}"#,
            2,
        ),
    )
    .await;
    [goal, update, offer]
}

/// `POST <path>` on the community's host as `who`, the way a browser without
/// a sign-in reaches it. Returns the status and the JSON body.
async fn post(w: &World, who: &Keys, path: &str, body: &Value) -> (StatusCode, Value) {
    post_on(w, w.tenant.host(), who, path, body).await
}

async fn post_on(
    w: &World,
    host: &str,
    who: &Keys,
    path: &str,
    body: &Value,
) -> (StatusCode, Value) {
    post_from(w, host, who, path, body, None).await
}

/// As [`post_on`], through a proxy that saw the request come from `address`.
async fn post_from(
    w: &World,
    host: &str,
    who: &Keys,
    path: &str,
    body: &Value,
    address: Option<&str>,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method("POST")
        .uri(path)
        .header(header::HOST, host)
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-pubkey", who.public_key().to_hex());
    if let Some(address) = address {
        request = request.header("x-forwarded-for", address);
    }
    let response = crate::router::build_router(w.state.clone())
        .oneshot(
            request
                .body(Body::from(serde_json::to_vec(body).expect("json")))
                .expect("request"),
        )
        .await
        .expect("response");
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 22)
        .await
        .expect("body");
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

/// What a caller who is not a member is told today, to the byte.
fn refusal() -> (StatusCode, Value) {
    (
        StatusCode::FORBIDDEN,
        json!({
            "error": "relay_membership_required",
            "message": "You must be a relay member to access this relay"
        }),
    )
}

/// The record filter and the filter for records about the project.
fn record_read(w: &World, id: &str) -> Value {
    json!([
        {"kinds": [KIND_LAUNCH_RECORD], "#d": [id]},
        {"kinds": [KIND_LAUNCH_UPDATE], "#a": [coordinate(w, id)], "limit": 200},
    ])
}

fn ids(body: &Value) -> Vec<String> {
    let mut ids: Vec<String> = body
        .as_array()
        .unwrap_or_else(|| panic!("a list of records, not {body}"))
        .iter()
        .map(|event| event["id"].as_str().expect("id").to_string())
        .collect();
    ids.sort();
    ids
}

fn sorted(mut ids: Vec<String>) -> Vec<String> {
    ids.sort();
    ids
}

async fn mute(w: &World, who: &Keys) {
    w.state
        .db
        .timeout_community_member(
            w.tenant.community(),
            &who.public_key().to_bytes(),
            &Keys::generate().public_key().to_bytes(),
            chrono::Utc::now() + chrono::Duration::hours(1),
            None,
        )
        .await
        .expect("mute");
}

async fn unmute(w: &World, who: &Keys) {
    w.state
        .db
        .untimeout_community_member(
            w.tenant.community(),
            &who.public_key().to_bytes(),
            &Keys::generate().public_key().to_bytes(),
        )
        .await
        .expect("unmute");
}

async fn ban(w: &World, who: &Keys) {
    w.state
        .db
        .ban_community_member(
            w.tenant.community(),
            &who.public_key().to_bytes(),
            &Keys::generate().public_key().to_bytes(),
            None,
            None,
        )
        .await
        .expect("ban");
}

/// Put `who` on the member list.
async fn member(w: &World, who: &Keys) {
    w.state
        .db
        .add_relay_member(
            w.tenant.community(),
            &who.public_key().to_hex(),
            "member",
            None,
        )
        .await
        .expect("member");
}

/// The records about `id` a visitor is answered with.
async fn about(w: &World, id: &str) -> Value {
    let (status, body) = post(
        w,
        &w.visitor,
        "/query",
        &json!([{"kinds": [47003], "#a": [coordinate(w, id)], "limit": 200}]),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}

/// A weekly update on `id` signed by `who`.
async fn update(w: &World, who: &Keys, id: &str, words: &str, ahead: u64) -> String {
    publish(
        w,
        signed(
            who,
            KIND_LAUNCH_UPDATE,
            &[&["a", &coordinate(w, id)], &["update-part", "done", words]],
            r#"{"title":"Week"}"#,
            ahead,
        ),
    )
    .await
}

/// One step of a task on `id`: `tags` beside the project's address and the task label.
async fn step(w: &World, who: &Keys, id: &str, tags: &[&[&str]], body: &str, ahead: u64) -> String {
    let coordinate = coordinate(w, id);
    let address = ["a", coordinate.as_str()];
    let mut all: Vec<&[&str]> = vec![&address, &["l", "creaton-task"]];
    all.extend_from_slice(tags);
    publish(w, signed(who, KIND_LAUNCH_UPDATE, &all, body, ahead)).await
}

/// A task for the helper with work handed in. Returns the task and the handed-in piece.
async fn handed_in(w: &World, id: &str, words: &str, ahead: u64) -> [String; 2] {
    let helper = w.helper.public_key().to_hex();
    let task = step(
        w,
        &w.founder,
        id,
        &[
            &["task-part", "task"],
            &["task-helper", &helper],
            &["p", &helper],
            &["task-what", "Draw the logo"],
            &["task-done", "A logo we can print"],
            &["task-size", "small"],
        ],
        "{}",
        ahead,
    )
    .await;
    let piece = step(
        w,
        &w.helper,
        id,
        &[&["task-part", "evidence"], &["task", &task], &["e", &task]],
        &json!({"title": "Work handed in", "body": words}).to_string(),
        ahead + 1,
    )
    .await;
    [task, piece]
}

/// The team's word on a handed-in piece: `part` is `confirm` or `send-back`.
async fn answered(
    w: &World,
    who: &Keys,
    id: &str,
    part: &str,
    [task, piece]: &[String; 2],
    ahead: u64,
) -> String {
    step(
        w,
        who,
        id,
        &[
            &["task-part", part],
            &["task", task],
            &["e", task],
            &["task-evidence", piece],
        ],
        r#"{"title":"Checked","body":"REASON-FOR-MEMBERS"}"#,
        ahead,
    )
    .await
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn with_the_setting_off_someone_who_is_not_a_member_is_refused_as_before() {
    let w = world(false).await;
    project(&w, "nebula", "{}").await;
    assert_eq!(
        post(&w, &w.visitor, "/query", &record_read(&w, "nebula")).await,
        refusal()
    );
    // A member reads the same thing, as always.
    let (status, body) = post(&w, &w.helper, "/query", &record_read(&w, "nebula")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(ids(&body).len(), 4);
}

/// The operator's setting opens records where the operator made the server
/// invite-only. A community whose own owner chose invite-only, on a server
/// that lets communities choose, is not opened by it.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_community_that_chose_invite_only_itself_is_not_opened_by_the_servers_setting() {
    let w = world_with(true, |config| config.require_relay_membership = false).await;
    w.state
        .db
        .set_community_membership_required(w.tenant.community(), true)
        .await
        .expect("the owner closes the community");
    w.state.forget_membership_policy(w.tenant.community());
    project(&w, "nebula", "{}").await;
    assert_eq!(
        post(&w, &w.visitor, "/query", &record_read(&w, "nebula")).await,
        refusal()
    );
    let (status, body) = post(&w, &w.helper, "/query", &record_read(&w, "nebula")).await;
    assert_eq!((status, ids(&body).len()), (StatusCode::OK, 4));
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn with_the_setting_on_anyone_reads_a_public_projects_record() {
    let w = world(true).await;
    let [goal, update, _offer] = project(&w, "nebula", r#"{"pitch":"A weekly map."}"#).await;

    let (status, body) = post(&w, &w.visitor, "/query", &record_read(&w, "nebula")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let events = body.as_array().expect("records");
    let record = events
        .iter()
        .find(|e| e["kind"] == json!(KIND_LAUNCH_RECORD))
        .expect("the project record");
    assert_eq!(record["pubkey"], json!(w.founder.public_key().to_hex()));
    assert!(record["content"]
        .as_str()
        .expect("content")
        .contains("A weekly map."));
    let about: Vec<String> = events
        .iter()
        .filter(|e| e["kind"] == json!(KIND_LAUNCH_UPDATE))
        .map(|e| e["id"].as_str().expect("id").to_string())
        .collect();
    assert_eq!(sorted(about), sorted(vec![goal.clone(), update.clone()]));
    assert_eq!(events.len(), 3, "the record, its goal and its update");

    // Narrowed by who signed, by a limit (newest first), by time, and by the founder's key or its start.
    let about = coordinate(&w, "nebula");
    let founder = w.founder.public_key().to_hex();
    let read = |filter: Value| {
        let w = &w;
        async move { post(w, &w.visitor, "/query", &json!([filter])).await.1 }
    };
    assert_eq!(
        ids(&read(json!({"kinds": [47003], "#a": [about], "authors": [founder]})).await),
        sorted(vec![goal.clone(), update.clone()])
    );
    assert_eq!(
        read(json!({"kinds": [47003], "#a": [about],
                    "authors": [w.helper.public_key().to_hex()]}))
        .await,
        json!([])
    );
    assert_eq!(
        ids(&read(json!({"kinds": [47003], "#a": [about], "limit": 1})).await),
        vec![update.clone()],
        "the update was signed a second after the goal"
    );
    let far = Timestamp::now().as_secs() + 3600;
    assert_eq!(
        read(json!({"kinds": [47003], "#a": [about], "since": far})).await,
        json!([])
    );
    assert_eq!(
        ids(&read(json!({"kinds": [47003], "#a": [about], "until": far})).await).len(),
        2
    );
    assert_eq!(
        read(json!({"kinds": [47003], "#a": [about], "#l": ["creaton-task"]})).await,
        json!([])
    );
    assert_eq!(
        ids(&read(json!({"kinds": [37001], "#d": ["nebula"], "authors": [founder]})).await).len(),
        1
    );
    assert_eq!(
        ids(
            &read(json!({"kinds": [37001], "#d": ["nebula"], "founder_start": &founder[..16]}))
                .await
        )
        .len(),
        1
    );
    // The same id under a founder who has no such project: nothing.
    let helper = w.helper.public_key().to_hex();
    assert_eq!(
        read(json!({"kinds": [37001], "#d": ["nebula"], "authors": [helper]})).await,
        json!([])
    );
    assert_eq!(
        read(json!({"kinds": [37001], "#d": ["nebula"], "founder_start": &helper[..16]})).await,
        json!([])
    );
}

/// Kind 47003 holds many families of record. Only the ones the public page is
/// made of are served; the rest stay for members, though they carry the same
/// project address and a member reads them with the same filter.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn records_kept_for_members_are_not_served_to_someone_who_is_not_one() {
    let w = world(true).await;
    let teammate = Keys::generate();
    member(&w, &teammate).await;
    let about_project = coordinate(&w, "nebula");
    publish(
        &w,
        signed(
            &w.founder,
            KIND_LAUNCH_RECORD,
            &[
                &["d", "nebula"],
                &["name", "Nebula"],
                &["team", &teammate.public_key().to_hex(), "member"],
            ],
            "{}",
            0,
        ),
    )
    .await;
    let weekly = update(&w, &teammate, "nebula", "Shipped the first map", 1).await;
    let plain = publish(
        &w,
        signed(
            &w.founder,
            KIND_LAUNCH_UPDATE,
            &[&["a", &about_project]],
            r#"{"title":"A note","body":"Plain words","links":[]}"#,
            2,
        ),
    )
    .await;

    // For members: records about work on the chain, which anyone on the list may sign.
    let mut kept = Vec::new();
    for (who, body) in [
        (
            &w.helper,
            json!({"title": "Evidence: logo", "body": "SECRET-EVIDENCE-UNDER-REVIEW https://drive.example/private",
                   "claim": {"id": "0x01"}}),
        ),
        (
            &w.helper,
            json!({"title": "Review", "body": "SECRET-REVIEWERS-REASON", "review": {"verdict": "no"}}),
        ),
        (
            &w.founder,
            json!({"title": "Agreement", "body": "SECRET-AGREEMENT-WORDS", "agreement": {"v": 1}}),
        ),
        (
            &teammate,
            json!({"title": "Area", "body": "SECRET-WORK-AREA", "workArea": {"id": "0x02"}}),
        ),
        (
            &w.founder,
            json!({"title": "Check", "body": "SECRET-CHECK-NOTE", "check": {"v": 1}}),
        ),
    ] {
        kept.push(
            publish(
                &w,
                signed(
                    who,
                    KIND_LAUNCH_UPDATE,
                    &[&["a", &about_project]],
                    &body.to_string(),
                    3,
                ),
            )
            .await,
        );
    }
    // The same under a weekly update's tag: what the body says the record is decides, not the tag beside it.
    kept.push(
        publish(
            &w,
            signed(
                &teammate,
                KIND_LAUNCH_UPDATE,
                &[&["a", &about_project], &["update-part", "done", "x"]],
                r#"{"title":"Evidence","body":"SECRET-EVIDENCE-UNDER-A-WEEKLY-TAG","claim":{"id":"0x03"}}"#,
                3,
            ),
        )
        .await,
    );
    // A record with no family tag whose body is more than a plain update: nothing says it is for everyone.
    kept.push(
        publish(
            &w,
            signed(
                &w.founder,
                KIND_LAUNCH_UPDATE,
                &[&["a", &about_project]],
                r#"{"title":"Something newer","body":"x","terms":"SECRET-FIELD-OF-A-LATER-FAMILY"}"#,
                3,
            ),
        )
        .await,
    );
    // For members: an offer of help with its note, and the team's reply to it.
    let offer = publish(
        &w,
        signed(
            &w.helper,
            KIND_LAUNCH_UPDATE,
            &[
                &["a", &about_project],
                &["e", &weekly],
                &["help-offer", &weekly],
            ],
            r#"{"note":"SECRET-OFFER-NOTE"}"#,
            4,
        ),
    )
    .await;
    kept.push(offer.clone());
    kept.push(
        publish(
            &w,
            signed(
                &w.founder,
                KIND_LAUNCH_UPDATE,
                &[
                    &["a", &about_project],
                    &["e", &offer],
                    &["help-reply", &offer],
                ],
                r#"{"title":"Reply","body":"SECRET-REPLY"}"#,
                5,
            ),
        )
        .await,
    );

    // Work still waiting for the team's word, work sent back, and work two people on the team disagree about.
    let waiting = handed_in(&w, "nebula", "SECRET-WORK-WAITING", 10).await;
    let returned = handed_in(&w, "nebula", "SECRET-WORK-SENT-BACK", 20).await;
    let sent_back = answered(&w, &w.founder, "nebula", "send-back", &returned, 22).await;
    let disputed = handed_in(&w, "nebula", "SECRET-WORK-DISPUTED", 30).await;
    let disputed_yes = answered(&w, &w.founder, "nebula", "confirm", &disputed, 32).await;
    let disputed_no = answered(&w, &teammate, "nebula", "send-back", &disputed, 33).await;
    kept.extend(waiting.iter().chain(&returned).chain(&disputed).cloned());
    kept.extend([sent_back, disputed_yes, disputed_no]);
    // The helper asks for more time on the task that is waiting.
    kept.push(
        step(
            &w,
            &w.helper,
            "nebula",
            &[
                &["task-part", "more-time"],
                &["task", &waiting[0]],
                &["e", &waiting[0]],
                &["task-due", "2030-01-01"],
            ],
            r#"{"title":"More time","body":"SECRET-REASON-FOR-MORE-TIME"}"#,
            12,
        )
        .await,
    );

    // Accepted: confirmed by the team, sent back by nobody.
    let done = handed_in(&w, "nebula", "The logo, as a file", 40).await;
    let confirmed = answered(&w, &teammate, "nebula", "confirm", &done, 42).await;

    // A task whose helper is on the team: a first try sent back, a second accepted. Everything the team signed
    // about the project is read, so the first try is there to be given; only the piece that was accepted is.
    let mate = teammate.public_key().to_hex();
    let guide = step(
        &w,
        &w.founder,
        "nebula",
        &[
            &["task-part", "task"],
            &["task-helper", &mate],
            &["p", &mate],
            &["task-what", "Write the guide"],
            &["task-done", "A guide a newcomer can follow"],
            &["task-size", "small"],
        ],
        "{}",
        60,
    )
    .await;
    let mut tries = Vec::new();
    for (words, ahead) in [("SECRET-FIRST-TRY", 61), ("The guide, second version", 63)] {
        tries.push(
            step(
                &w,
                &teammate,
                "nebula",
                &[
                    &["task-part", "evidence"],
                    &["task", &guide],
                    &["e", &guide],
                ],
                &json!({"title": "Work handed in", "body": words}).to_string(),
                ahead,
            )
            .await,
        );
    }
    let first_try = [guide.clone(), tries[0].clone()];
    let second_try = [guide.clone(), tries[1].clone()];
    kept.push(tries[0].clone());
    kept.push(answered(&w, &w.founder, "nebula", "send-back", &first_try, 62).await);
    let guide_confirmed = answered(&w, &w.founder, "nebula", "confirm", &second_try, 64).await;

    // A member reads every one of them with this filter, so they are there to be leaked.
    let filter = json!([{"kinds": [47003], "#a": [about_project], "limit": 200}]);
    let (status, body) = post(&w, &w.helper, "/query", &filter).await;
    assert_eq!(status, StatusCode::OK);
    let members_read = ids(&body);
    for id in &kept {
        assert!(members_read.contains(id), "a member reads {id}");
    }

    let body = about(&w, "nebula").await;
    assert_eq!(
        ids(&body),
        sorted(vec![
            weekly,
            plain,
            done[0].clone(),
            done[1].clone(),
            confirmed.clone(),
            guide,
            tries[1].clone(),
            guide_confirmed,
        ]),
        "the updates and the three steps of each piece of accepted work, and nothing else"
    );
    let text = body.to_string();
    assert!(!text.contains("SECRET"), "{text}");
    assert!(text.contains("The logo, as a file"));

    // The page's own second read, for what the helpers a task names signed: the accepted piece alone.
    let (_, body) = post(
        &w,
        &w.visitor,
        "/query",
        &json!([{"kinds": [47003], "#a": [about_project], "#l": ["creaton-task"],
                 "authors": [w.helper.public_key().to_hex()], "limit": 200}]),
    )
    .await;
    assert_eq!(ids(&body), vec![done[1].clone()]);
    // By the task it answers.
    let (_, body) = post(
        &w,
        &w.visitor,
        "/query",
        &json!([{"kinds": [47003], "#a": [about_project], "#e": [done[0]]}]),
    )
    .await;
    assert_eq!(ids(&body), sorted(vec![done[1].clone(), confirmed.clone()]));

    // Sent back afterwards by someone on the team: no longer accepted, and its steps go back to members.
    answered(&w, &w.founder, "nebula", "send-back", &done, 50).await;
    let body = about(&w, "nebula").await;
    assert_eq!(
        ids(&body).len(),
        5,
        "the two updates and the guide's three steps: {body}"
    );
    assert!(!body.to_string().contains("The logo, as a file"));
}

/// A record about a project that was stored for a room is the room's, not the
/// project's public record, whatever address it carries.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_record_stored_for_a_room_is_never_served() {
    let w = world(true).await;
    let [goal, weekly, _] = project(&w, "nebula", "{}").await;
    let room = w
        .state
        .db
        .create_channel(
            w.tenant.community(),
            "team-room",
            buzz_db::channel::ChannelType::Stream,
            buzz_db::channel::ChannelVisibility::Private,
            None,
            &w.founder.public_key().to_bytes(),
            None,
        )
        .await
        .expect("a members-only room")
        .id;
    // The founder's own update, of a family that is served, kept for the room.
    let in_room = signed(
        &w.founder,
        KIND_LAUNCH_UPDATE,
        &[
            &["a", &coordinate(&w, "nebula")],
            &["h", &room.to_string()],
            &["update-part", "done", "SECRET-ROOM-WORDS"],
        ],
        r#"{"title":"For the room"}"#,
        3,
    );
    let (stored, _) = w
        .state
        .db
        .insert_event(w.tenant.community(), &in_room, Some(room))
        .await
        .expect("stored for the room");
    assert_eq!(stored.channel_id, Some(room));

    let body = about(&w, "nebula").await;
    assert_eq!(ids(&body), sorted(vec![goal.clone(), weekly.clone()]));
    assert!(!body.to_string().contains("SECRET-ROOM-WORDS"));

    // A room's records are not read at all, so however many it holds they cannot fill the read and crowd the
    // project's own records out of it: as many as one read takes, every one newer than the goal and the update.
    for n in 0..super::TEAM_RECORDS_READ as u64 {
        let in_room = signed(
            &w.founder,
            KIND_LAUNCH_UPDATE,
            &[
                &["a", &coordinate(&w, "nebula")],
                &["h", &room.to_string()],
                &["update-part", "done", &format!("SECRET-ROOM-WORDS {n}")],
            ],
            r#"{"title":"For the room"}"#,
            4 + n % 50,
        );
        w.state
            .db
            .insert_event(w.tenant.community(), &in_room, Some(room))
            .await
            .expect("stored for the room");
    }
    let body = about(&w, "nebula").await;
    assert_eq!(
        ids(&body),
        sorted(vec![goal, weekly]),
        "the room's records took no place in the read"
    );
}

/// A project whose record states the terms of a sale (a price floor, an amount
/// to raise) is for the people the server let in: someone who is not a member
/// is given neither its record, which would carry the price, nor anything
/// about it.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_project_that_states_the_terms_of_a_sale_is_not_given_to_someone_who_is_not_a_member() {
    let w = world(true).await;
    let terms = r#"{"pitch":"A weekly map.","currency":"0xabc","floorPrice":"792281625140000","requiredRaised":"299999999998"}"#;
    project(&w, "nebula", terms).await;
    // A member reads it whole, as before: the record, its goal, its update and the offer.
    let (status, body) = post(&w, &w.helper, "/query", &record_read(&w, "nebula")).await;
    assert_eq!((status, ids(&body).len()), (StatusCode::OK, 4));
    assert!(body.to_string().contains("792281625140000"));

    let founder = w.founder.public_key().to_hex();
    for read in [
        record_read(&w, "nebula"),
        json!([{"kinds": [37001], "#d": ["nebula"], "authors": [founder]}]),
        json!([{"kinds": [37001], "#d": ["nebula"], "founder_start": &founder[..16]}]),
        json!([{"kinds": [47003], "#a": [coordinate(&w, "nebula")], "limit": 200}]),
    ] {
        assert_eq!(
            post(&w, &w.visitor, "/query", &read).await,
            (StatusCode::OK, json!([])),
            "{read}"
        );
    }

    // The founder takes the terms off the record: it is a project like any other again.
    publish(
        &w,
        signed(
            &w.founder,
            KIND_LAUNCH_RECORD,
            &[&["d", "nebula"], &["name", "Nebula"]],
            r#"{"pitch":"A weekly map.","floorPrice":""}"#,
            5,
        ),
    )
    .await;
    let (status, body) = post(&w, &w.visitor, "/query", &record_read(&w, "nebula")).await;
    assert_eq!((status, ids(&body).len()), (StatusCode::OK, 3), "{body}");
    assert!(!body.to_string().contains("792281625140000"));
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_project_the_preview_would_not_show_reads_as_nothing() {
    let w = world(true).await;
    let nothing = (StatusCode::OK, json!([]));
    let shown = |id: &'static str| {
        let w = &w;
        async move { ids(&post(w, &w.visitor, "/query", &record_read(w, id)).await.1).len() }
    };

    // Not listed: the page opens for members from its link, and nobody else is told it exists.
    project(&w, "quiet", r#"{"listing":"unlisted","pitch":"Hush"}"#).await;
    assert_eq!(
        post(&w, &w.visitor, "/query", &record_read(&w, "quiet")).await,
        nothing
    );
    // A project that was never there reads the same.
    assert_eq!(
        post(&w, &w.visitor, "/query", &record_read(&w, "never")).await,
        nothing
    );

    // Removed by its founder.
    project(&w, "gone", "{}").await;
    assert_eq!(shown("gone").await, 3);
    publish(
        &w,
        signed(
            &w.founder,
            KIND_DELETION,
            &[&["a", &coordinate(&w, "gone")]],
            "",
            5,
        ),
    )
    .await;
    assert_eq!(
        post(&w, &w.visitor, "/query", &record_read(&w, "gone")).await,
        nothing
    );

    // A founder who is muted, and one who is banned.
    project(&w, "nebula", "{}").await;
    assert_eq!(shown("nebula").await, 3);
    mute(&w, &w.founder).await;
    assert_eq!(
        post(&w, &w.visitor, "/query", &record_read(&w, "nebula")).await,
        nothing
    );
    unmute(&w, &w.founder).await;
    assert_eq!(shown("nebula").await, 3);
    ban(&w, &w.founder).await;
    assert_eq!(
        post(&w, &w.visitor, "/query", &record_read(&w, "nebula")).await,
        nothing
    );
}

/// A project whose record lists `count` people on its team, each of whom
/// signed one weekly update. Returns the team and their updates, in order.
async fn team_project(w: &World, id: &str, count: usize) -> (Vec<Keys>, Vec<String>) {
    let team: Vec<Keys> = (0..count).map(|_| Keys::generate()).collect();
    let keys: Vec<String> = team.iter().map(|k| k.public_key().to_hex()).collect();
    let mut tags: Vec<Vec<&str>> = vec![vec!["d", id], vec!["name", "Nebula"]];
    for key in &keys {
        tags.push(vec!["team", key, "member"]);
    }
    let tags: Vec<&[&str]> = tags.iter().map(Vec::as_slice).collect();
    publish(w, signed(&w.founder, KIND_LAUNCH_RECORD, &tags, "{}", 0)).await;
    let mut updates = Vec::new();
    for (n, teammate) in team.iter().enumerate() {
        member(w, teammate).await;
        updates.push(update(w, teammate, id, "Shipped", 1 + n as u64).await);
    }
    (team, updates)
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_record_signed_by_someone_muted_or_banned_is_left_out() {
    let w = world(true).await;
    let (team, updates) = team_project(&w, "nebula", 2).await;
    let all = sorted(updates.clone());
    assert_eq!(ids(&about(&w, "nebula").await), all);

    mute(&w, &team[0]).await;
    assert_eq!(ids(&about(&w, "nebula").await), vec![updates[1].clone()]);
    unmute(&w, &team[0]).await;
    assert_eq!(ids(&about(&w, "nebula").await), all);
    ban(&w, &team[0]).await;
    assert_eq!(ids(&about(&w, "nebula").await), vec![updates[1].clone()]);

    // Work the team accepted from a helper who is then muted: the helper's piece is left out.
    let done = handed_in(&w, "nebula", "The logo", 10).await;
    let confirmed = answered(&w, &w.founder, "nebula", "confirm", &done, 12).await;
    let with_work = sorted(vec![
        updates[1].clone(),
        done[0].clone(),
        done[1].clone(),
        confirmed.clone(),
    ]);
    assert_eq!(ids(&about(&w, "nebula").await), with_work);
    mute(&w, &w.helper).await;
    assert_eq!(
        ids(&about(&w, "nebula").await),
        sorted(vec![updates[1].clone(), done[0].clone(), confirmed.clone()])
    );

    // Work whose only confirmation is from a teammate who is then muted is not accepted work for a visitor: none of
    // its steps is given, though the founder made the task and the helper may be shown.
    unmute(&w, &w.helper).await;
    let poster = handed_in(&w, "nebula", "The poster", 20).await;
    let by_teammate = answered(&w, &team[1], "nebula", "confirm", &poster, 22).await;
    let shown = ids(&about(&w, "nebula").await);
    for id in [&poster[0], &poster[1], &by_teammate] {
        assert!(shown.contains(id), "accepted, so given: {id}");
    }
    mute(&w, &team[1]).await;
    assert_eq!(
        ids(&about(&w, "nebula").await),
        sorted(vec![done[0].clone(), done[1].clone(), confirmed])
    );
}

/// Anyone on the member list may offer help on a project, as often as they like. Records from outside the team
/// are not read at all, so however many there are they cannot fill the read and crowd the team's records out.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn records_from_outside_the_team_take_no_place_in_the_read() {
    let w = world(true).await;
    let [goal, weekly, _] = project(&w, "nebula", "{}").await;
    // As many as one read takes, every one newer than the goal and the update.
    for n in 0..super::TEAM_RECORDS_READ as u64 {
        let offer = signed(
            &w.helper,
            KIND_LAUNCH_UPDATE,
            &[
                &["a", &coordinate(&w, "nebula")],
                &["e", &weekly],
                &["help-offer", &weekly],
            ],
            &json!({"note": format!("Offer {n}")}).to_string(),
            4 + n % 50,
        );
        w.state
            .db
            .insert_event(w.tenant.community(), &offer, None)
            .await
            .expect("stored");
    }
    assert_eq!(ids(&about(&w, "nebula").await), sorted(vec![goal, weekly]));
}

/// Each signer's standing is one lookup. Past the bound a signer is not looked
/// up, and what is not checked is not shown.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn signers_past_the_bound_are_not_looked_up_and_their_records_are_left_out() {
    let w = world(true).await;
    let (_, updates) = team_project(&w, "nebula", 45).await;
    let founders = update(&w, &w.founder, "nebula", "The founder's own", 100).await;
    let shown = ids(&about(&w, "nebula").await);
    assert!(shown.contains(&founders), "the founder costs no lookup");
    assert_eq!(
        shown.iter().filter(|id| updates.contains(id)).count(),
        super::MAX_SIGNER_CHECKS,
        "40 of the team's 45 signers were looked up"
    );
    assert_eq!(shown.len(), super::MAX_SIGNER_CHECKS + 1);
}

/// Anyone on the member list can publish a project under an id that is
/// taken. However many do, a read that names the founder finds the founder.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn other_founders_under_the_same_id_do_not_hide_the_one_a_read_names() {
    let w = world(true).await;
    let [goal, weekly, _] = project(&w, "nebula", "{}").await;
    // Twenty-five newer projects under the same id: more than are checked for standing, and more than one read of
    // an id returns.
    for n in 0..25u64 {
        let other = Keys::generate();
        member(&w, &other).await;
        publish(
            &w,
            signed(
                &other,
                KIND_LAUNCH_RECORD,
                &[&["d", "nebula"], &["name", "Impostor"]],
                "{}",
                10 + n,
            ),
        )
        .await;
    }
    let founder = w.founder.public_key().to_hex();
    // As a scorecard address names the founder, and as a project page address does.
    for named in [
        json!({"kinds": [37001], "#d": ["nebula"], "founder_start": &founder[..16]}),
        json!({"kinds": [37001], "#d": ["nebula"], "authors": [founder]}),
    ] {
        let (status, body) = post(&w, &w.visitor, "/query", &json!([named])).await;
        assert_eq!(status, StatusCode::OK);
        let events = body.as_array().expect("records");
        assert_eq!(events.len(), 1, "{named}: the founder's record alone");
        assert_eq!(events[0]["pubkey"], json!(founder));
    }
    // And the records about the founder's project are still read.
    assert_eq!(ids(&about(&w, "nebula").await), sorted(vec![goal, weekly]));
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn nothing_else_is_read_by_kind_by_id_by_author_or_by_tag() {
    let w = world(true).await;
    let [_, update, _] = project(&w, "nebula", "{}").await;
    let about = coordinate(&w, "nebula");
    let founder = w.founder.public_key().to_hex();
    // A post on Home about the project, and the founder's profile: both are the community's, not the record's.
    let note = publish(
        &w,
        signed(&w.founder, 1, &[&["a", &about]], "Members only words", 3),
    )
    .await;
    publish(&w, signed(&w.founder, 0, &[], r#"{"name":"Founder"}"#, 3)).await;
    // The member sees them, so they are there to be leaked.
    let (status, body) = post(
        &w,
        &w.helper,
        "/query",
        &json!([{"kinds": [1], "#a": [about]}]),
    )
    .await;
    assert_eq!((status, ids(&body)), (StatusCode::OK, vec![note.clone()]));

    for filters in [
        // Another kind: by the project's tag, by author, by id.
        json!([{"kinds": [1], "#a": [about]}]),
        json!([{"kinds": [1], "authors": [founder]}]),
        json!([{"kinds": [1], "ids": [note]}]),
        json!([{"kinds": [0], "authors": [founder]}]),
        json!([{"kinds": [5], "authors": [founder]}]),
        json!([{"kinds": [47003, 1], "#a": [about]}]),
        // No kinds at all: by id, by author, by tag, and bare.
        json!([{"ids": [note]}]),
        json!([{"ids": [update]}]),
        json!([{"authors": [founder]}]),
        json!([{"#a": [about]}]),
        json!([{}]),
        // An allowed kind without the project, or reaching by id.
        json!([{"kinds": [47003]}]),
        json!([{"kinds": [47003], "authors": [founder]}]),
        json!([{"kinds": [47003], "ids": [update]}]),
        json!([{"kinds": [47003], "#a": [about], "ids": [update]}]),
        json!([{"kinds": [37001]}]),
        json!([{"kinds": [37001], "authors": [founder]}]),
        // More than the bound, a search, and a public filter beside one that is not.
        json!([{"kinds": [47003], "#a": [about], "limit": 201}]),
        json!([{"kinds": [47003], "#a": [about], "search": "map"}]),
        json!([{"kinds": [37001], "#d": ["nebula"]}, {"kinds": [1], "#a": [about]}]),
    ] {
        assert_eq!(
            post(&w, &w.visitor, "/query", &filters).await,
            refusal(),
            "{filters}"
        );
    }
    // Counting is not reading the record: refused as before.
    assert_eq!(
        post(&w, &w.visitor, "/count", &record_read(&w, "nebula")).await,
        refusal()
    );
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_write_from_someone_who_is_not_a_member_is_still_refused() {
    for public_reads in [false, true] {
        let w = world(public_reads).await;
        project(&w, "nebula", "{}").await;
        let update = update(&w, &w.founder, "nebula", "Second map", 4).await;
        // An offer of help is the one record about a project anyone on the list may sign.
        let offer = signed(
            &w.visitor,
            KIND_LAUNCH_UPDATE,
            &[
                &["a", &coordinate(&w, "nebula")],
                &["e", &update],
                &["help-offer", &update],
            ],
            "{}",
            5,
        );
        let offer_id = offer.id.to_hex();
        let (status, body) = post(
            &w,
            &w.visitor,
            "/events",
            &serde_json::to_value(&offer).expect("event"),
        )
        .await;
        assert_eq!(
            (status, body),
            refusal(),
            "public reads {public_reads}: a write is for members"
        );
        // And it was not stored.
        let (_, body) = post(
            &w,
            &w.helper,
            "/query",
            &json!([{"kinds": [47003], "ids": [offer_id]}]),
        )
        .await;
        assert_eq!(body, json!([]));
    }
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_banned_caller_and_another_communitys_host_read_nothing() {
    let w = world(true).await;
    project(&w, "nebula", "{}").await;
    // Someone banned from the community is turned away here too, member or not.
    let banned = Keys::generate();
    ban(&w, &banned).await;
    assert_eq!(
        post(&w, &banned, "/query", &record_read(&w, "nebula")).await,
        refusal()
    );
    // A member who is banned is told so, as before: the public read is not a way round a ban.
    ban(&w, &w.helper).await;
    let (status, body) = post(&w, &w.helper, "/query", &record_read(&w, "nebula")).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_ne!((status, body.clone()), refusal(), "the ban's own words");
    assert!(body.get("error").is_some(), "{body}");
    assert!(!body.is_array());
    // The same read on another community's address finds no such project.
    let other = world(true).await;
    assert_eq!(
        post_on(
            &other,
            other.tenant.host(),
            &w.visitor,
            "/query",
            &record_read(&w, "nebula")
        )
        .await,
        (StatusCode::OK, json!([]))
    );
}

/// The read of one project's own record: one read of the database.
fn one_read(id: &str) -> Value {
    json!([{"kinds": [KIND_LAUNCH_RECORD], "#d": [id]}])
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn public_reads_share_one_budget_a_minute_whoever_asks() {
    let w = world_with(true, |config| config.public_project_reads_per_min = 2).await;
    project(&w, "nebula", "{}").await;
    // A new key for every request, as someone who is not signed in may use.
    for _ in 0..2 {
        let (status, _) = post(&w, &Keys::generate(), "/query", &one_read("nebula")).await;
        assert_eq!(status, StatusCode::OK);
    }
    let (status, body) = post(&w, &Keys::generate(), "/query", &one_read("nebula")).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
    // A request that is not a public read does not use the budget up, and members are not counted in it.
    let (status, _) = post(&w, &w.helper, "/query", &one_read("nebula")).await;
    assert_eq!(status, StatusCode::OK);
}

/// Someone banned is turned away before anything is counted: they cannot use
/// up what everyone else shares.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_banned_caller_spends_none_of_the_shared_budget() {
    let w = world_with(true, |config| config.public_project_reads_per_min = 1).await;
    project(&w, "nebula", "{}").await;
    let banned = Keys::generate();
    ban(&w, &banned).await;
    for _ in 0..3 {
        assert_eq!(
            post(&w, &banned, "/query", &one_read("nebula")).await,
            refusal()
        );
    }
    let (status, body) = post(&w, &w.visitor, "/query", &one_read("nebula")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(ids(&body).len(), 1);
}

/// Everyone who is not a member gets the same answer, so it is read once and
/// kept: a link many people open costs the shared budget one read, not one a
/// visitor.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_kept_answer_costs_the_shared_budget_nothing() {
    let w = world_with(true, |config| {
        config.public_project_reads_per_min = 2;
        config.public_project_reads_cache_secs = 30;
    })
    .await;
    let [goal, weekly, _] = project(&w, "nebula", "{}").await;
    project(&w, "other", "{}").await;
    // The record and the records about it: two reads of the database, the whole budget.
    let (status, first) = post(&w, &Keys::generate(), "/query", &record_read(&w, "nebula")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(ids(&first).len(), 3);
    for _ in 0..5 {
        let (status, again) =
            post(&w, &Keys::generate(), "/query", &record_read(&w, "nebula")).await;
        assert_eq!((status, &again), (StatusCode::OK, &first));
    }
    // Narrowed another way, the same kept records answer: nothing new is read.
    let (status, body) = post(
        &w,
        &Keys::generate(),
        "/query",
        &json!([{"kinds": [47003], "#a": [coordinate(&w, "nebula")], "limit": 1}]),
    )
    .await;
    assert_eq!((status, ids(&body)), (StatusCode::OK, vec![weekly.clone()]));
    // What is kept is what was there when it was read: a new update is not in it yet.
    update(&w, &w.founder, "nebula", "Second map", 5).await;
    assert_eq!(ids(&about(&w, "nebula").await), sorted(vec![goal, weekly]));
    // A project nobody has read yet needs the database, and the budget is spent.
    let (status, body) = post(&w, &Keys::generate(), "/query", &one_read("other")).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
}

/// With the budget spent, a kept answer that is no longer fresh is still
/// given: an older record, not "nothing can be read".
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn with_the_budget_spent_an_older_kept_answer_is_given_rather_than_none() {
    let w = world_with(true, |config| {
        config.public_project_reads_per_min = 1;
        config.public_project_reads_cache_secs = 1;
    })
    .await;
    project(&w, "nebula", "{}").await;
    project(&w, "other", "{}").await;
    let (status, first) = post(&w, &Keys::generate(), "/query", &one_read("nebula")).await;
    assert_eq!(status, StatusCode::OK);
    tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
    let (status, later) = post(&w, &Keys::generate(), "/query", &one_read("nebula")).await;
    assert_eq!((status, &later), (StatusCode::OK, &first));
    // Nothing is kept for this one.
    let (status, _) = post(&w, &Keys::generate(), "/query", &one_read("other")).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
}

/// One machine is held to its own limit before the shared budget is touched,
/// so it cannot spend it for everyone, however many keys it makes.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn one_address_cannot_spend_what_everyone_shares() {
    let w = world_with(true, |config| {
        config.public_project_reads_per_address_min = 2;
        config.public_project_reads_per_min = 4;
    })
    .await;
    project(&w, "nebula", "{}").await;
    let from = |address: &'static str, id: &'static str| {
        let w = &w;
        async move {
            post_from(
                w,
                w.tenant.host(),
                &Keys::generate(),
                "/query",
                &one_read(id),
                Some(address),
            )
            .await
            .0
        }
    };
    // Projects that do not exist, a new key each time: the cheapest way to try to use the budget up.
    assert_eq!(from("203.0.113.7", "no-such-1").await, StatusCode::OK);
    assert_eq!(from("203.0.113.7", "no-such-2").await, StatusCode::OK);
    for _ in 0..4 {
        assert_eq!(
            from("203.0.113.7", "no-such-3").await,
            StatusCode::TOO_MANY_REQUESTS
        );
    }
    // What the client itself wrote in front of the proxy's entry does not make it someone else.
    assert_eq!(
        from("198.51.100.1, 203.0.113.7", "nebula").await,
        StatusCode::TOO_MANY_REQUESTS
    );
    // Everyone else still reads: two of the four shared reads are left.
    assert_eq!(from("203.0.113.8", "nebula").await, StatusCode::OK);
    assert_eq!(from("203.0.113.9", "nebula").await, StatusCode::OK);
}
