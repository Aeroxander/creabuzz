//! Public reads of a holder room, of the operator's seasons and of a season's lineup through the real router
//! (`POST /query`), with the real run's chain rows (`handlers::room_support`). Needs Postgres and Redis:
//! `cargo test -p buzz-relay --lib -- public_read::room_postgres_tests --include-ignored --test-threads=1`.

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use nostr::{Event, Keys};
use serde_json::{json, Value};
use tower::ServiceExt;

use crate::handlers::room_support::{
    add_member, example_record, ingest, room_world_with, signed, tag, RoomWorld,
};

const HOLDER: usize = 3;
const OTHER_HOLDER: usize = 4;

async fn world() -> (RoomWorld, Keys, Keys) {
    let operator = Keys::generate();
    let hex = operator.public_key().to_hex();
    let w = room_world_with(true, move |c| {
        c.public_project_reads = true;
        c.require_relay_membership = true;
        c.public_project_reads_cache_secs = 0;
        c.relay_operator_pubkeys = vec![hex];
    })
    .await;
    add_member(&w.state, &w.tenant, &operator).await;
    w.seed_to(w.fx.head()).await;
    w.numbers_record(&example_record()).await;
    (w, operator, Keys::generate())
}

async fn query(w: &RoomWorld, who: &Keys, body: &Value) -> (StatusCode, Value) {
    let response = crate::router::build_router(w.state.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/query")
                .header(header::HOST, w.tenant.host())
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

fn refusal() -> (StatusCode, Value) {
    (
        StatusCode::FORBIDDEN,
        json!({
            "error": "relay_membership_required",
            "message": "You must be a relay member to access this relay"
        }),
    )
}

fn ids(body: &Value) -> Vec<String> {
    let mut ids: Vec<String> = body
        .as_array()
        .unwrap_or_else(|| panic!("a list of records, not {body}"))
        .iter()
        .map(|event| event["id"].as_str().expect("id").to_owned())
        .collect();
    ids.sort();
    ids
}

fn sorted(mut ids: Vec<String>) -> Vec<String> {
    ids.sort();
    ids
}

async fn accept(w: &RoomWorld, event: Event, what: &str) {
    if let Err(reason) = ingest(&w.state, &w.tenant, event).await {
        panic!("{what}: refused: {reason}");
    }
}

fn room_read(w: &RoomWorld) -> Value {
    json!([{"kinds": [1, 7], "#a": [w.coordinate], "#t": [w.room()], "limit": 200}])
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn r18_anyone_reads_a_room_by_its_project_and_its_tag_and_nothing_wider() {
    let (w, _operator, visitor) = world().await;
    let holder = w.account().await;
    w.link(&holder, HOLDER, 3_600).await.expect("link");
    let post = w.post(&holder, "a room post");
    accept(&w, post.clone(), "a post").await;
    let reply = w.reply(&holder, &post, "a reply");
    accept(&w, reply.clone(), "a reply").await;
    let like = w.like(&holder, &post);
    accept(&w, like.clone(), "a like").await;
    let want = sorted(vec![post.id.to_hex(), reply.id.to_hex(), like.id.to_hex()]);

    // Someone who is not a member reads the room with the one filter that names the project and its own room.
    let (status, body) = query(&w, &visitor, &room_read(&w)).await;
    assert_eq!((status, ids(&body)), (StatusCode::OK, want.clone()));
    // Posts only, and likes only, are the same room.
    let (_, posts) = query(
        &w,
        &visitor,
        &json!([{"kinds": [1], "#a": [w.coordinate], "#t": [w.room()]}]),
    )
    .await;
    assert_eq!(
        ids(&posts),
        sorted(vec![post.id.to_hex(), reply.id.to_hex()])
    );
    let (_, likes) = query(
        &w,
        &visitor,
        &json!([{"kinds": [7], "#a": [w.coordinate], "#t": [w.room()]}]),
    )
    .await;
    assert_eq!(ids(&likes), vec![like.id.to_hex()]);

    // Anything wider is the membership refusal it always was.
    for filters in [
        json!([{"kinds": [1], "#a": [w.coordinate]}]),
        json!([{"kinds": [1], "#t": [w.room()]}]),
        json!([{"kinds": [1, 7], "#t": [w.room()]}]),
        json!([{"kinds": [1], "authors": [holder.public_key().to_hex()]}]),
        json!([{"kinds": [1, 7, 47003], "#a": [w.coordinate], "#t": [w.room()]}]),
        json!([{"kinds": [1], "#a": [w.coordinate], "#t": [w.room()], "#e": [post.id.to_hex()]}]),
        json!([{"kinds": [1], "#a": [w.coordinate], "#t": [w.room(), "room:0xab"]}]),
        json!([{"kinds": [1], "#a": [w.coordinate], "#t": ["orbit"]}]),
        json!([{"kinds": [1], "#a": [w.coordinate], "#t": [w.room()], "limit": 201}]),
        json!([{"kinds": [1], "#a": [w.coordinate], "#t": [w.room()], "search": "room"}]),
    ] {
        assert_eq!(query(&w, &visitor, &filters).await, refusal(), "{filters}");
    }

    // A room tag that is not the project's own reads as nothing, and so does a project that is not here.
    let other = format!("room:0x{}", hex::encode(w.fx.projects["B"].key));
    let (status, body) = query(
        &w,
        &visitor,
        &json!([{"kinds": [1], "#a": [w.coordinate], "#t": [other]}]),
    )
    .await;
    assert_eq!((status, ids(&body)), (StatusCode::OK, Vec::<String>::new()));
    let nowhere = format!("37001:{}:nowhere", w.founder.public_key().to_hex());
    let (status, body) = query(
        &w,
        &visitor,
        &json!([{"kinds": [1], "#a": [nowhere], "#t": [w.room()]}]),
    )
    .await;
    assert_eq!((status, ids(&body)), (StatusCode::OK, Vec::<String>::new()));
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn r18_a_project_that_fails_standing_a_muted_signer_and_a_removed_post_are_not_served() {
    let (w, _operator, visitor) = world().await;
    let (a, b) = (w.account().await, w.account().await);
    w.link(&a, HOLDER, 3_600).await.expect("link");
    w.link(&b, OTHER_HOLDER, 3_600).await.expect("link");
    let (pa, pb) = (w.post(&a, "from a"), w.post(&b, "from b"));
    accept(&w, pa.clone(), "a post").await;
    accept(&w, pb.clone(), "a post").await;
    let (_, body) = query(&w, &visitor, &room_read(&w)).await;
    assert_eq!(ids(&body), sorted(vec![pa.id.to_hex(), pb.id.to_hex()]));

    // A signer the server muted is left out.
    w.state
        .db
        .timeout_community_member(
            w.tenant.community(),
            &a.public_key().to_bytes(),
            &Keys::generate().public_key().to_bytes(),
            chrono::Utc::now() + chrono::Duration::hours(1),
            None,
        )
        .await
        .expect("mute");
    let (_, body) = query(&w, &visitor, &room_read(&w)).await;
    assert_eq!(
        ids(&body),
        vec![pb.id.to_hex()],
        "a muted signer's post is not served"
    );

    // A post the team removed is gone.
    accept(
        &w,
        signed(
            &w.founder,
            9005,
            &[
                tag(&["e", &pb.id.to_hex()]),
                tag(&["public_reason", "Spam"]),
            ],
            "",
            0,
        ),
        "the team removes it",
    )
    .await;
    let (_, body) = query(&w, &visitor, &room_read(&w)).await;
    assert_eq!(ids(&body), Vec::<String>::new());

    // A project the founder unlisted reads as nothing, rooms included.
    let key = format!("0x{}", hex::encode(w.key));
    accept(
        &w,
        signed(
            &w.founder,
            37001,
            &[tag(&["d", "orbit"]), tag(&["chain-key", &key])],
            &json!({ "listing": "unlisted" }).to_string(),
            3,
        ),
        "the founder unlists",
    )
    .await;
    let (status, body) = query(&w, &visitor, &room_read(&w)).await;
    assert_eq!((status, ids(&body)), (StatusCode::OK, Vec::<String>::new()));
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn m7_seasons_and_a_seasons_lineup_are_read_by_number_and_page_by_until() {
    let (w, operator, visitor) = world().await;
    let t = u64::try_from(chrono::Utc::now().timestamp()).expect("now");
    let day = 86_400u64;
    let season = |number: u32, ahead: u64| {
        signed(
            &operator,
            37021,
            &[tag(&["d", &format!("season-{number}")])],
            &json!({ "v": 1, "number": number, "startsAt": t - 3_600, "demoDayAt": t - 3_600 + 42 * day, "endsAt": t - 3_600 + 49 * day }).to_string(),
            ahead,
        )
    };
    let (one, two) = (season(1, 0), season(2, 0));
    accept(&w, one.clone(), "season 1").await;
    accept(&w, two.clone(), "season 2").await;

    let (status, body) = query(&w, &visitor, &json!([{"kinds": [37021]}])).await;
    assert_eq!(
        (status, ids(&body)),
        (
            StatusCode::OK,
            sorted(vec![one.id.to_hex(), two.id.to_hex()])
        )
    );
    let (_, body) = query(
        &w,
        &visitor,
        &json!([{"kinds": [37021], "#d": ["season-2"]}]),
    )
    .await;
    assert_eq!(ids(&body), vec![two.id.to_hex()]);

    // The lineup: entries are read by their season alone and page by `until`.
    let entry = |who: &Keys, coordinate: &str, family: &str, ahead: u64| {
        signed(
            who,
            47003,
            &[
                tag(&["a", coordinate]),
                tag(&["t", "season-1"]),
                tag(&[family, "1"]),
            ],
            "{}",
            ahead,
        )
    };
    let first = entry(&w.founder, &w.coordinate, "season-entry", 0);
    accept(&w, first.clone(), "an entry").await;
    let second_project = w.extra_project(&w.mate, "second").await;
    let second = entry(&w.mate, &second_project, "season-entry", 4);
    accept(&w, second.clone(), "another entry").await;
    let removal = entry(&operator, &second_project, "season-remove", 8);
    accept(&w, removal.clone(), "a removal").await;
    let (status, body) = query(
        &w,
        &visitor,
        &json!([{"kinds": [47003], "#t": ["season-1"], "limit": 200}]),
    )
    .await;
    assert_eq!(
        (status, ids(&body)),
        (
            StatusCode::OK,
            sorted(vec![
                first.id.to_hex(),
                second.id.to_hex(),
                removal.id.to_hex()
            ])
        )
    );
    // Paging: the newest first, and `until` the oldest of the page before.
    let (_, page) = query(
        &w,
        &visitor,
        &json!([{"kinds": [47003], "#t": ["season-1"], "limit": 1}]),
    )
    .await;
    assert_eq!(ids(&page), vec![removal.id.to_hex()]);
    let until = first.created_at.as_secs();
    let (_, older) = query(
        &w,
        &visitor,
        &json!([{"kinds": [47003], "#t": ["season-1"], "until": until}]),
    )
    .await;
    assert_eq!(ids(&older), vec![first.id.to_hex()]);
    // Another season's topic and the team's own records are not mixed in.
    let (_, none) = query(
        &w,
        &visitor,
        &json!([{"kinds": [47003], "#t": ["season-2"]}]),
    )
    .await;
    assert_eq!(ids(&none), Vec::<String>::new());

    for filters in [
        json!([{"kinds": [47003], "#t": ["season-1", "season-2"]}]),
        json!([{"kinds": [47003], "#t": ["season-01"]}]),
        json!([{"kinds": [47003], "#t": ["orbit"]}]),
        json!([{"kinds": [47003], "#t": ["season-1"], "#a": [w.coordinate]}]),
        json!([{"kinds": [37021], "#d": ["season-1", "season-2"]}]),
        json!([{"kinds": [37021], "#d": ["orbit"]}]),
        json!([{"kinds": [37021], "authors": [operator.public_key().to_hex()]}]),
        json!([{"kinds": [37021, 47003]}]),
    ] {
        assert_eq!(query(&w, &visitor, &filters).await, refusal(), "{filters}");
    }
}
