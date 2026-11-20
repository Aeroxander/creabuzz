//! The device rows and the sweep against a real database. Ignored without infrastructure; run with
//! `cargo test -p buzz-relay --lib -- web_push::store_postgres_tests --include-ignored --test-threads=1`.

use chrono::{Duration, Utc};
use sqlx::Row;
use uuid::Uuid;

use super::store::{self, delete_subscriptions, endpoint_hash, upsert_subscription, NewDevice};
use super::test_support::{push_world, subscribed};

async fn community() -> (std::sync::Arc<crate::state::AppState>, Uuid) {
    let state = crate::test_support::test_state().await;
    let host = format!("push-{}.example", Uuid::new_v4().simple());
    let id = state
        .db
        .ensure_configured_community(&host)
        .await
        .expect("community")
        .id;
    (state, *id.as_uuid())
}

async fn count(state: &crate::state::AppState, community: Uuid, account: &[u8; 32]) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM web_push_subscriptions WHERE community_id = $1 AND pubkey = $2",
    )
    .bind(community)
    .bind(account.as_slice())
    .fetch_one(state.db.pool())
    .await
    .expect("count")
}

/// P5: at most the cap's devices stay and the oldest goes; the same address renews instead of adding; accounts are apart.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn p5_at_most_the_cap_of_devices_stay_and_the_oldest_goes() {
    let (state, community) = community().await;
    let (account, other) = ([1u8; 32], [2u8; 32]);
    let now = Utc::now();
    let device = [4u8; 65];
    let auth = [9u8; 16];
    for i in 0..5 {
        upsert_subscription(
            state.db.pool(),
            community,
            &account,
            NewDevice {
                endpoint: &format!("https://fcm.googleapis.com/fcm/send/{i}"),
                p256dh: &device,
                auth: &auth,
            },
            3,
            now + Duration::seconds(i),
        )
        .await
        .expect("keep");
    }
    upsert_subscription(
        state.db.pool(),
        community,
        &other,
        NewDevice {
            endpoint: "https://fcm.googleapis.com/fcm/send/0",
            p256dh: &device,
            auth: &auth,
        },
        3,
        now,
    )
    .await
    .expect("keep");
    assert_eq!(count(&state, community, &account).await, 3);
    let kept: Vec<String> = sqlx::query_scalar(
        "SELECT endpoint FROM web_push_subscriptions WHERE community_id = $1 AND pubkey = $2 ORDER BY created_at",
    )
    .bind(community)
    .bind(account.as_slice())
    .fetch_all(state.db.pool())
    .await
    .expect("kept");
    assert_eq!(
        kept,
        [
            "https://fcm.googleapis.com/fcm/send/2",
            "https://fcm.googleapis.com/fcm/send/3",
            "https://fcm.googleapis.com/fcm/send/4"
        ],
        "the two oldest went"
    );
    // The same address again renews it: the count does not grow and the expiry moves.
    upsert_subscription(
        state.db.pool(),
        community,
        &account,
        NewDevice {
            endpoint: "https://fcm.googleapis.com/fcm/send/4",
            p256dh: &device,
            auth: &auth,
        },
        3,
        now + Duration::days(40),
    )
    .await
    .expect("renew");
    assert_eq!(count(&state, community, &account).await, 3);
    let expires: chrono::DateTime<Utc> = sqlx::query_scalar(
        "SELECT expires_at FROM web_push_subscriptions WHERE community_id = $1 AND pubkey = $2 AND endpoint LIKE '%/4'",
    )
    .bind(community)
    .bind(account.as_slice())
    .fetch_one(state.db.pool())
    .await
    .expect("expiry");
    assert!(
        expires > now + Duration::days(40 + 89),
        "a renewal is good for 90 days from now"
    );
    assert_eq!(
        count(&state, community, &other).await,
        1,
        "another account is untouched"
    );
}

/// Two requests at once cannot leave more than the cap.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn p5_requests_at_once_cannot_leave_more_than_the_cap() {
    let (state, community) = community().await;
    let account = [3u8; 32];
    let mut tasks = Vec::new();
    for i in 0..12 {
        let pool = state.db.pool().clone();
        tasks.push(tokio::spawn(async move {
            upsert_subscription(
                &pool,
                community,
                &account,
                NewDevice {
                    endpoint: &format!("https://fcm.googleapis.com/fcm/send/c{i}"),
                    p256dh: &[4u8; 65],
                    auth: &[1u8; 16],
                },
                5,
                Utc::now(),
            )
            .await
            .expect("keep");
        }));
    }
    for task in tasks {
        task.await.expect("task");
    }
    assert_eq!(count(&state, community, &account).await, 5);
}

/// P6 (store): a person's removal takes their rows, and their outbox rows with them; another account's stay.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn p6_removing_a_device_removes_its_rows_and_only_that_accounts() {
    let pw = push_world().await;
    let (alice, device_a) = subscribed(&pw, 3).await;
    let (bob, _device_b) = subscribed(&pw, 3).await;
    let second = pw.stand_in.device();
    super::test_support::keep(&pw, &alice, &second).await;
    let (pool, community) = (pw.w.state.db.pool(), *pw.w.tenant.community().as_uuid());
    // An outbox row for each of Alice's devices.
    super::alerts::make_alerts(&pw.w.state, &pw.config, Utc::now())
        .await
        .expect("cursor");
    let (head, t0) = (pw.w.fx.head(), pw.w.time_of(pw.w.fx.head()));
    super::test_support::task_event(&pw.w, head + 1, t0 + 100, "TaskAnnounced", 1, None).await;
    super::alerts::make_alerts(&pw.w.state, &pw.config, Utc::now())
        .await
        .expect("alert");
    let outbox = |account: Vec<u8>| async move {
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM web_push_outbox o JOIN web_push_subscriptions s \
             ON s.community_id = o.community_id AND s.id = o.subscription_id \
             WHERE s.community_id = $1 AND s.pubkey = $2",
        )
        .bind(community)
        .bind(account)
        .fetch_one(pool)
        .await
        .expect("count")
    };
    let (a, b) = (alice.public_key().to_bytes(), bob.public_key().to_bytes());
    assert_eq!((outbox(a.to_vec()).await, outbox(b.to_vec()).await), (2, 1));
    // One device by its address.
    let removed = delete_subscriptions(
        pool,
        community,
        &a,
        Some(&endpoint_hash(&device_a.endpoint)),
    )
    .await
    .expect("delete");
    assert_eq!(removed, 1);
    assert_eq!(
        (
            count(&pw.w.state, community, &a).await,
            outbox(a.to_vec()).await
        ),
        (1, 1)
    );
    // Then all of them.
    assert_eq!(
        delete_subscriptions(pool, community, &a, None)
            .await
            .expect("delete"),
        1
    );
    assert_eq!(
        (
            count(&pw.w.state, community, &a).await,
            outbox(a.to_vec()).await
        ),
        (0, 0)
    );
    assert_eq!(
        (
            count(&pw.w.state, community, &b).await,
            outbox(b.to_vec()).await
        ),
        (1, 1),
        "Bob's are untouched"
    );
}

/// The sweep: expired devices go with their rows; delivered and dropped rows after 7 days, failed after 30, alerts after
/// 31 when nothing refers to them; nothing younger.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn the_sweep_removes_only_what_is_old() {
    let pw = push_world().await;
    let (_k, _device) = subscribed(&pw, 3).await;
    let pool = pw.w.state.db.pool();
    let community = *pw.w.tenant.community().as_uuid();
    super::alerts::make_alerts(&pw.w.state, &pw.config, Utc::now())
        .await
        .expect("cursor");
    let (head, t0) = (pw.w.fx.head(), pw.w.time_of(pw.w.fx.head()));
    for serial in 1..=5u64 {
        super::test_support::task_event(
            &pw.w,
            head + serial,
            t0 + serial * 100,
            "TaskAnnounced",
            serial,
            None,
        )
        .await;
    }
    super::alerts::make_alerts(&pw.w.state, &pw.config, Utc::now())
        .await
        .expect("alerts");
    // Rows in each state, at ages that straddle the keeping times.
    let ids: Vec<Uuid> = sqlx::query_scalar("SELECT o.id FROM web_push_outbox o JOIN web_push_alerts a ON a.id = o.alert_id WHERE a.reader = $1 ORDER BY a.serial")
        .bind(&pw.w.reader)
        .fetch_all(pool)
        .await
        .expect("ids");
    assert!(ids.len() >= 4, "{}", ids.len());
    let set = |id: Uuid, state: &'static str, days: i64| async move {
        sqlx::query("UPDATE web_push_outbox SET state = $2, done_at = now() - make_interval(days => $3::int) WHERE community_id = $4 AND id = $1")
            .bind(id).bind(state).bind(days as i32).bind(community)
            .execute(pool).await.expect("set");
    };
    set(ids[0], "delivered", 8).await; // old: swept
    set(ids[1], "delivered", 6).await; // young: kept
    set(ids[2], "failed", 29).await; // young for a failed row: kept
    set(ids[3], "failed", 31).await; // old: swept
    let swept = store::sweep(pool, Utc::now()).await.expect("sweep");
    assert_eq!((swept.finished, swept.failed), (1, 1), "{swept:?}");
    assert_eq!(swept.expired, 0);
    // An alert is swept only when it is old and nothing refers to it.
    sqlx::query(
        "UPDATE web_push_alerts SET created_at = now() - interval '40 days' WHERE reader = $1",
    )
    .bind(&pw.w.reader)
    .execute(pool)
    .await
    .expect("age the alerts");
    let swept = store::sweep(pool, Utc::now()).await.expect("sweep");
    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM web_push_alerts WHERE reader = $1")
        .bind(&pw.w.reader)
        .fetch_one(pool)
        .await
        .expect("count");
    assert!(swept.alerts >= 1, "{swept:?}");
    assert!(left >= 2, "alerts that rows still refer to stay ({left})");
    // An expired device goes, with its rows.
    sqlx::query("UPDATE web_push_subscriptions SET expires_at = now() - interval '1 second' WHERE community_id = $1")
        .bind(community)
        .execute(pool)
        .await
        .expect("expire");
    let swept = store::sweep(pool, Utc::now()).await.expect("sweep");
    assert_eq!(swept.expired, 1);
    let rows: i64 =
        sqlx::query("SELECT count(*) AS n FROM web_push_outbox WHERE community_id = $1")
            .bind(community)
            .fetch_one(pool)
            .await
            .expect("count")
            .get("n");
    assert_eq!(rows, 0, "its rows went with it");
}

/// I3: a community keeps at most its cap of live devices: a new device is refused when it is full, a device the account
/// already has is renewed, an expired one does not count, and a removed one makes room.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn i3_a_community_keeps_at_most_its_cap_of_live_devices() {
    let (state, community) = community().await;
    let now = Utc::now();
    let (p256dh, auth) = ([4u8; 65], [9u8; 16]);
    let keep = |account: u8, n: u8, at: chrono::DateTime<Utc>| {
        let state = state.clone();
        async move {
            store::upsert_subscription_capped(
                state.db.pool(),
                community,
                &[account; 32],
                NewDevice {
                    endpoint: &format!("https://fcm.googleapis.com/fcm/send/{account}-{n}"),
                    p256dh: &p256dh,
                    auth: &auth,
                },
                5,
                3,
                at,
            )
            .await
            .expect("keep")
        }
    };
    for account in 1..=3 {
        assert_eq!(keep(account, 0, now).await, store::Kept::Kept);
    }
    assert_eq!(
        keep(4, 0, now).await,
        store::Kept::CommunityFull,
        "a fourth account's device is refused"
    );
    assert_eq!(count(&state, community, &[4u8; 32]).await, 0);
    assert_eq!(
        keep(1, 0, now + Duration::seconds(5)).await,
        store::Kept::Kept,
        "a device already kept is renewed even when the community is full"
    );
    assert_eq!(
        keep(1, 1, now).await,
        store::Kept::CommunityFull,
        "a second device of a full community is a new one"
    );
    delete_subscriptions(state.db.pool(), community, &[2u8; 32], None)
        .await
        .expect("removed");
    assert_eq!(
        keep(4, 0, now).await,
        store::Kept::Kept,
        "a removal makes room"
    );
    // Devices past their end do not count.
    let later = now + Duration::days(store::SUBSCRIPTION_LIFETIME_DAYS + 1);
    assert_eq!(keep(5, 0, later).await, store::Kept::Kept);
}
