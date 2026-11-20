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
use super::{build, publish, Index, RESIGN_SECS, RETRY_SECS};
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
    // B has money that stayed too but only a thief's record names it: it is counted in `seen` and is one of the `cut`.
    assert_eq!((index.seen, index.cut), (2, 1));
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
    // The app shows no index older than a day, so the same entries must be signed again well inside it.
    const _: () = assert!(RESIGN_SECS <= 12 * 3_600);
    // The same entries, but the live index is half a day old: signed again, so the app, which shows no index older
    // than a day, keeps a ranking that is still right.
    assert!(
        !publish(
            &state,
            &tenant,
            31337,
            &reader.config.launcher,
            &index,
            NOW + RESIGN_SECS - 1
        )
        .await
        .expect("publishes"),
        "not yet half a day"
    );
    assert!(
        publish(
            &state,
            &tenant,
            31337,
            &reader.config.launcher,
            &index,
            NOW + RESIGN_SECS
        )
        .await
        .expect("publishes"),
        "the same entries are signed again when the live index is half a day old"
    );
    let (_, _, resigned_id, _) = live(&state, community).await.expect("an index is live");
    assert_ne!(first_id, resigned_id);
    let first_id = resigned_id;
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
        NOW + RESIGN_SECS + 599
    )
    .await
    .expect("publishes"));
    assert!(publish(
        &state,
        &tenant,
        31337,
        &reader.config.launcher,
        &changed,
        NOW + RESIGN_SECS + 601
    )
    .await
    .expect("publishes"));
    let (_, _, second_id, now_live) = live(&state, community).await.expect("an index is live");
    assert_ne!(first_id, second_id);
    assert_eq!(now_live, changed);

    // A build that fails keeps the old index and is counted; the records are signed all the same.
    super::FAIL_BUILD.with(|f| f.set(true));
    {
        let mut schedule = reader.schedule();
        schedule.explore_after = 0;
        // The passes before this one looked at an index with nothing to list (no record named a key yet): their
        // misses made the pause grow, so this look starts from none.
        schedule.explore_misses = 0;
    }
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
    // A look that failed is repeated in about a minute, not in ten, and the pause doubles with each miss in a row.
    let wait = reader.schedule().explore_after - chrono::Utc::now().timestamp();
    assert!(
        (1..=i64::try_from(RETRY_SECS).expect("secs") + 5).contains(&wait),
        "a failed look is repeated soon: {wait}"
    );
    assert_eq!(reader.schedule().explore_misses, 1);
    let (_, _, kept_id, kept) = live(&state, community).await.expect("the old index stays");
    assert_eq!((kept_id, kept), (second_id, changed));
    // The next pass after the pause tries again and is not stopped by the one that failed.
    reader.schedule().explore_after = 0;
    let report = reader.publish_pass(head).await.expect("a pass");
    assert_eq!(report.explore_failed, 0, "{report:?}");
    assert!(report.explore_signed <= 1, "{report:?}");
}

/// The index finds a project's record by its key, whatever else is stored: 150 newer records of thieves naming the
/// same key push the honest one past the first page of the search, and 120 launched projects with more money and no
/// record that their launch names (they could be made for the price of holding the money) push it past the first
/// page of rows. Both leave the project listed, and `seen` and `cut` say what was left out.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn the_index_finds_a_record_among_many_and_a_project_among_richer_ones_with_no_record() {
    let fx = Fixture::load();
    let (reader, chain, state) = setup(&fx).await;
    chain.serve_books(&fx, &["A_end", "B_end"]);
    read_all(&reader, &chain).await;
    let pool = state.db.pool();
    let id = reader.reader_id().to_owned();
    let tenant = reader.tenant().await.expect("tenant").expect("a community");
    let community = tenant.community();
    let a = fx.projects["A"].key;
    let as_of = AsOf {
        chain_id: 31337,
        launcher: reader.config.launcher,
        block: fx.head(),
        time: fx.time_of(fx.head()),
    };
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
    // Newer records of other keys' thieves naming A's key.
    for n in 0..(super::RECORDS_PAGE + 50) {
        project_record(
            &state,
            community,
            &Keys::generate(),
            &format!("clone-{n}"),
            &a,
        )
        .await;
    }
    // Launched projects with more money than A and nothing that ties them to a record.
    sqlx::query(
        "INSERT INTO chain_project_numbers (reader, project_key, source_block, facts_digest, content_digest, \
             event_id, rank_money, rank_accounts, rank_window_secs, reached, launched_at) \
         SELECT reader, sha256(project_key || int4send(g)), source_block, facts_digest, content_digest, event_id, \
             rank_money * 10, rank_accounts, rank_window_secs, reached, launched_at \
         FROM chain_project_numbers, generate_series(1, 120) g WHERE reader = $1 AND project_key = $2",
    )
    .bind(&id)
    .bind(a.as_slice())
    .execute(pool)
    .await
    .expect("richer projects with no record");
    let index = build(&state, &tenant, &id, &as_of).await.expect("builds");
    let listed: Vec<&str> = index.entries.iter().map(|e| e.a.as_str()).collect();
    assert_eq!(
        listed,
        [coordinate.as_str()],
        "the honest project is listed: {index:?}"
    );
    assert!(
        index.seen >= 121 && index.cut == index.seen - 1,
        "what was left out is counted: seen {}, cut {}",
        index.seen,
        index.cut
    );
}
