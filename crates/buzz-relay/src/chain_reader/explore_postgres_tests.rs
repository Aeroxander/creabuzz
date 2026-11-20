//! The ranking index against real Postgres and the real run of the contracts (IX2 and IX3 of
//! `docs/next-version/STEP3-PLAN.md` section 9.2): which rows are read, how a project is tied to its
//! coordinate, how the index is signed and when it is signed again. Ignored without infrastructure; run with
//! `cargo test -p buzz-relay --lib chain_reader::explore -- --include-ignored --test-threads=1`.

use nostr::{EventBuilder, Keys, Kind, Tag};

use super::super::fixture::Fixture;
use super::super::numbers::AsOf;
use super::super::scan_postgres_tests::{read_all, setup};
use super::super::source::ChainSource as _;
use super::super::word::hex0x;
use super::{build, publish, Index};
use buzz_core::kind::{KIND_LAUNCH_RECORD, KIND_PROJECT_NUMBERS};

const NOW: i64 = 1_900_000_000;

/// A project record of kind 37001 by `founder` under the id `id`, naming the chain key `key`.
async fn project_record(
    state: &crate::state::AppState,
    community: buzz_core::tenant::CommunityId,
    founder: &Keys,
    id: &str,
    key: &[u8; 32],
) -> String {
    let event = EventBuilder::new(
        Kind::Custom(KIND_LAUNCH_RECORD as u16),
        r#"{"title":"A project"}"#,
    )
    .tags([
        Tag::parse(["d", id]).expect("tag"),
        Tag::parse(["chain-key", &hex0x(key)]).expect("tag"),
    ])
    .sign_with_keys(founder)
    .expect("signed");
    state
        .db
        .replace_parameterized_event(community, &event, id, None)
        .await
        .expect("stored");
    format!(
        "{KIND_LAUNCH_RECORD}:{}:{id}",
        founder.public_key().to_hex()
    )
}

/// The live ranking index: its event's author, its `d` tag and its content.
async fn live(
    state: &crate::state::AppState,
    community: buzz_core::tenant::CommunityId,
) -> Option<(String, String, Vec<u8>, Index)> {
    let rows = state
        .db
        .query_events(&buzz_db::EventQuery {
            kinds: Some(vec![KIND_PROJECT_NUMBERS as i32]),
            d_tag: Some("explore".to_owned()),
            global_only: true,
            limit: Some(5),
            ..buzz_db::EventQuery::for_community(community)
        })
        .await
        .expect("query");
    assert!(
        rows.len() <= 1,
        "the index replaces itself: one live record"
    );
    rows.into_iter().next().map(|stored| {
        let event = stored.event;
        let d = event
            .tags
            .iter()
            .find_map(|t| match t.as_slice() {
                [n, v, ..] if n == "d" => Some(v.clone()),
                _ => None,
            })
            .expect("a d tag");
        (
            event.pubkey.to_hex(),
            d,
            event.id.as_bytes().to_vec(),
            serde_json::from_str(&event.content).expect("the index reads back"),
        )
    })
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn ix2_and_ix3_the_index_lists_tied_projects_and_is_signed_only_when_it_changes() {
    let fx = Fixture::load();
    let (reader, chain, state) = setup(&fx).await;
    chain.serve_books(&fx, &["A_end", "B_end"]);
    read_all(&reader, &chain).await;
    let pool = state.db.pool();
    let id = reader.reader_id().to_owned();
    let tenant = reader.tenant().await.expect("tenant").expect("a community");
    let community = tenant.community();
    let (a, b) = (fx.projects["A"].key, fx.projects["B"].key);
    let as_of = AsOf {
        chain_id: 31337,
        launcher: reader.config.launcher,
        block: fx.head(),
        time: fx.time_of(fx.head()),
    };

    // The columns the pass kept beside A's record: it has money that stayed.
    let (money, stale): (Option<String>, bool) = sqlx::query_as(
        "SELECT rank_money::text, stale FROM chain_project_numbers WHERE reader = $1 AND project_key = $2",
    )
    .bind(&id)
    .bind(a.as_slice())
    .fetch_one(pool)
    .await
    .expect("A's row");
    assert!(
        money.is_some_and(|m| m != "0") && !stale,
        "A has money that stayed"
    );

    // No project record names the keys yet: nobody is listed (the key alone decides nothing).
    let none = build(&state, &tenant, &id, &as_of).await.expect("builds");
    assert!(none.entries.is_empty(), "no record, no entry: {none:?}");

    // The honest founder's record names A's key, and A's launch names the hash of its coordinate.
    let honest = Keys::generate();
    let coordinate = project_record(&state, community, &honest, "alpha-project", &a).await;
    sqlx::query(
        "UPDATE chain_logs SET decoded = jsonb_set(decoded, '{projectId}', to_jsonb($3::text)) \
         WHERE reader = $1 AND project_key = $2 AND role = 'launcher' AND event = 'ProjectLaunched'",
    )
    .bind(&id)
    .bind(a.as_slice())
    .bind(crate::api::manager::cost::project_id(&coordinate))
    .execute(pool)
    .await
    .expect("A's launch names the coordinate");
    // A thief's records claim A's key and B's key; neither coordinate hashes to what the launch named.
    let thief = Keys::generate();
    project_record(&state, community, &thief, "alpha-clone", &a).await;
    project_record(&state, community, &thief, "beta-clone", &b).await;

    let index = build(&state, &tenant, &id, &as_of).await.expect("builds");
    let listed: Vec<(&str, &str)> = index
        .entries
        .iter()
        .map(|e| (e.key.as_str(), e.a.as_str()))
        .collect();
    assert_eq!(
        listed,
        vec![(hex0x(&a).as_str(), coordinate.as_str())],
        "only A, only with the coordinate its launch names: {index:?}"
    );
    assert_eq!((index.seen, index.cut), (1, 0));
    assert_eq!(index.as_of.block, fx.head());

    // IX2: a stale row is not read (a rollback marked it).
    sqlx::query(
        "UPDATE chain_project_numbers SET stale = true WHERE reader = $1 AND project_key = $2",
    )
    .bind(&id)
    .bind(a.as_slice())
    .execute(pool)
    .await
    .expect("stale");
    let stale_index = build(&state, &tenant, &id, &as_of).await.expect("builds");
    assert!(stale_index.entries.is_empty(), "a stale row is not listed");
    sqlx::query(
        "UPDATE chain_project_numbers SET stale = false WHERE reader = $1 AND project_key = $2",
    )
    .bind(&id)
    .bind(a.as_slice())
    .execute(pool)
    .await
    .expect("fresh");
    // A founder who is not listed has no public face: an unlisted record is not an entry.
    let unlisted = Keys::generate();
    let event = EventBuilder::new(
        Kind::Custom(KIND_LAUNCH_RECORD as u16),
        r#"{"listing":"unlisted"}"#,
    )
    .tags([
        Tag::parse(["d", "hidden"]).expect("tag"),
        Tag::parse(["chain-key", &hex0x(&b)]).expect("tag"),
    ])
    .sign_with_keys(&unlisted)
    .expect("signed");
    state
        .db
        .replace_parameterized_event(community, &event, "hidden", None)
        .await
        .expect("stored");
    sqlx::query(
        "UPDATE chain_logs SET decoded = jsonb_set(decoded, '{projectId}', to_jsonb($3::text)) \
         WHERE reader = $1 AND project_key = $2 AND role = 'launcher' AND event = 'ProjectLaunched'",
    )
    .bind(&id)
    .bind(b.as_slice())
    .bind(crate::api::manager::cost::project_id(&format!(
        "{KIND_LAUNCH_RECORD}:{}:hidden",
        unlisted.public_key().to_hex()
    )))
    .execute(pool)
    .await
    .expect("B's launch names the unlisted record");
    let index = build(&state, &tenant, &id, &as_of).await.expect("builds");
    assert_eq!(
        index.entries.len(),
        1,
        "an unlisted project is not listed: {index:?}"
    );

    // IX3: the first signing; the record is the relay's, its d tag is `explore`, and it reads back.
    assert!(live(&state, community).await.is_none());
    assert!(
        publish(&state, &tenant, 31337, &reader.config.launcher, &index, NOW)
            .await
            .expect("publishes"),
        "the first index is signed"
    );
    let (author, d, first_id, read_back) = live(&state, community).await.expect("an index is live");
    assert_eq!(
        author,
        state.relay_keypair.public_key().to_hex(),
        "signed by the relay's key"
    );
    assert_eq!(d, "explore");
    assert_eq!(read_back, index);
    // The same entries: nothing is signed again, whatever the time.
    assert!(!publish(
        &state,
        &tenant,
        31337,
        &reader.config.launcher,
        &index,
        NOW + 10_000
    )
    .await
    .expect("publishes"));
    // Different entries inside ten minutes: not yet; after: yes, and the live record is the new one.
    let mut changed = index.clone();
    changed.entries.clear();
    changed.seen = 0;
    assert!(!publish(
        &state,
        &tenant,
        31337,
        &reader.config.launcher,
        &changed,
        NOW + 599
    )
    .await
    .expect("publishes"));
    assert!(publish(
        &state,
        &tenant,
        31337,
        &reader.config.launcher,
        &changed,
        NOW + 601
    )
    .await
    .expect("publishes"));
    let (_, _, second_id, now_live) = live(&state, community).await.expect("an index is live");
    assert_ne!(first_id, second_id);
    assert_eq!(now_live, changed);

    // A build that fails keeps the old index and is counted; the records are signed all the same.
    super::FAIL_BUILD.with(|f| f.set(true));
    reader.schedule().explore_after = 0;
    let head = chain.head().await.expect("head");
    let report = reader
        .publish_pass(head)
        .await
        .expect("the pass itself works");
    super::FAIL_BUILD.with(|f| f.set(false));
    assert_eq!(
        (report.explore_failed, report.explore_signed, report.failed),
        (1, 0, 0),
        "{report:?}"
    );
    let (_, _, kept_id, kept) = live(&state, community).await.expect("the old index stays");
    assert_eq!((kept_id, kept), (second_id, changed));
    // The next pass after the pause tries again and is not stopped by the one that failed.
    reader.schedule().explore_after = 0;
    let report = reader.publish_pass(head).await.expect("a pass");
    assert_eq!(report.explore_failed, 0, "{report:?}");
    assert!(report.explore_signed <= 1, "{report:?}");
}
