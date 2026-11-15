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

/// An invite-only community with a founder and a helper on its list, on a
/// server whose `BUZZ_PUBLIC_PROJECT_READS` is `public_reads`.
async fn world(public_reads: bool) -> World {
    world_with(public_reads, |_| {}).await
}

async fn world_with(
    public_reads: bool,
    configure: impl FnOnce(&mut crate::config::Config),
) -> World {
    let state = crate::test_support::test_state_with(move |config| {
        config.public_project_reads = public_reads;
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
    state
        .db
        .set_community_membership_required(community, true)
        .await
        .expect("close the community");
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
    let response = crate::router::build_router(w.state.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(path)
                .header(header::HOST, host)
                .header(header::CONTENT_TYPE, "application/json")
                .header("x-pubkey", who.public_key().to_hex())
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

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn with_the_setting_on_anyone_reads_a_public_projects_record() {
    let w = world(true).await;
    let [goal, update, offer] = project(&w, "nebula", r#"{"pitch":"A weekly map."}"#).await;

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
    assert_eq!(
        sorted(about),
        sorted(vec![goal.clone(), update.clone(), offer.clone()])
    );
    assert_eq!(events.len(), 4, "the record and three records about it");

    // Narrowed by who signed, by a referenced record, by a limit, and by the founder's key.
    let about = coordinate(&w, "nebula");
    let founder = w.founder.public_key().to_hex();
    let (_, body) = post(
        &w,
        &w.visitor,
        "/query",
        &json!([{"kinds": [47003], "#a": [about], "authors": [founder]}]),
    )
    .await;
    assert_eq!(ids(&body), sorted(vec![goal, update.clone()]));
    let (_, body) = post(
        &w,
        &w.visitor,
        "/query",
        &json!([{"kinds": [47003], "#a": [about], "#e": [update]}]),
    )
    .await;
    assert_eq!(ids(&body), vec![offer]);
    let (_, body) = post(
        &w,
        &w.visitor,
        "/query",
        &json!([{"kinds": [47003], "#a": [about], "limit": 1}]),
    )
    .await;
    assert_eq!(ids(&body).len(), 1);
    let (_, body) = post(
        &w,
        &w.visitor,
        "/query",
        &json!([{"kinds": [37001], "#d": ["nebula"], "authors": [founder]}]),
    )
    .await;
    assert_eq!(ids(&body).len(), 1);
    // The same id under a founder who has no such project: nothing.
    let (status, body) = post(
        &w,
        &w.visitor,
        "/query",
        &json!([{"kinds": [37001], "#d": ["nebula"],
                 "authors": [w.helper.public_key().to_hex()]}]),
    )
    .await;
    assert_eq!((status, body), (StatusCode::OK, json!([])));
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_project_the_preview_would_not_show_reads_as_nothing() {
    let w = world(true).await;
    let nothing = (StatusCode::OK, json!([]));

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
    assert_eq!(
        ids(&post(&w, &w.visitor, "/query", &record_read(&w, "gone"))
            .await
            .1)
        .len(),
        4
    );
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
    assert_eq!(
        ids(&post(&w, &w.visitor, "/query", &record_read(&w, "nebula"))
            .await
            .1)
        .len(),
        4
    );
    mute(&w, &w.founder).await;
    assert_eq!(
        post(&w, &w.visitor, "/query", &record_read(&w, "nebula")).await,
        nothing
    );
    unmute(&w, &w.founder).await;
    assert_eq!(
        ids(&post(&w, &w.visitor, "/query", &record_read(&w, "nebula"))
            .await
            .1)
        .len(),
        4
    );
    ban(&w, &w.founder).await;
    assert_eq!(
        post(&w, &w.visitor, "/query", &record_read(&w, "nebula")).await,
        nothing
    );
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_record_signed_by_someone_muted_or_banned_is_left_out() {
    let w = world(true).await;
    let [goal, update, offer] = project(&w, "nebula", "{}").await;
    let all = sorted(vec![goal.clone(), update.clone(), offer]);
    let about = json!([{"kinds": [47003], "#a": [coordinate(&w, "nebula")]}]);
    assert_eq!(ids(&post(&w, &w.visitor, "/query", &about).await.1), all);

    mute(&w, &w.helper).await;
    assert_eq!(
        ids(&post(&w, &w.visitor, "/query", &about).await.1),
        sorted(vec![goal.clone(), update.clone()])
    );
    unmute(&w, &w.helper).await;
    assert_eq!(ids(&post(&w, &w.visitor, "/query", &about).await.1), all);
    ban(&w, &w.helper).await;
    assert_eq!(
        ids(&post(&w, &w.visitor, "/query", &about).await.1),
        sorted(vec![goal, update])
    );
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
        let update = publish(
            &w,
            signed(
                &w.founder,
                KIND_LAUNCH_UPDATE,
                &[
                    &["a", &coordinate(&w, "nebula")],
                    &["update-part", "done", "Second map"],
                ],
                "{}",
                4,
            ),
        )
        .await;
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

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn public_reads_share_one_budget_a_minute_whoever_asks() {
    let w = world_with(true, |config| config.public_project_reads_per_min = 2).await;
    project(&w, "nebula", "{}").await;
    let read = record_read(&w, "nebula");
    // A new key for every request, as someone who is not signed in may use.
    for _ in 0..2 {
        let (status, _) = post(&w, &Keys::generate(), "/query", &read).await;
        assert_eq!(status, StatusCode::OK);
    }
    let (status, body) = post(&w, &Keys::generate(), "/query", &read).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
    // A request that is not a public read does not use the budget up, and members are not counted in it.
    let (status, _) = post(&w, &w.helper, "/query", &read).await;
    assert_eq!(status, StatusCode::OK);
}
