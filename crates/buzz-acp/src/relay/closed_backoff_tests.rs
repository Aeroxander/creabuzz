//! A relay that ends a subscription with a CLOSED that is neither an auth
//! failure nor a rate limit (a failed history read) is retried on a capped,
//! jittered backoff — never straight away. Synthetic WebSocket fixtures only.
use super::tests::{seed_test_subscription, test_ws_pair};
use super::*;

const READ_FAILED: &str = "error: database error";

/// Feed one relay frame through the production message handler.
async fn dispatch(client: &mut WsStream, state: &mut BgState, frame: Value) -> bool {
    let (tx, _rx) = mpsc::channel(4);
    let (control_tx, _control_rx) = mpsc::channel(1);
    handle_ws_message(
        Message::Text(frame.to_string().into()),
        client,
        &tx,
        &control_tx,
        state,
        &Keys::generate(),
        "ws://127.0.0.1:1",
        "synthetic-agent",
        None,
    )
    .await
}

/// Collect the subscription ID of every REQ the harness writes, until the
/// client closes. Reading on its own task keeps the paused clock out of it.
fn collect_reqs(
    mut server: WebSocketStream<tokio::net::TcpStream>,
) -> tokio::task::JoinHandle<Vec<String>> {
    tokio::spawn(async move {
        let mut subs = Vec::new();
        while let Some(Ok(message)) = server.next().await {
            let Message::Text(text) = message else {
                continue;
            };
            let frame: Value = serde_json::from_str(&text).expect("parse harness frame");
            if frame[0] == "REQ" {
                subs.push(frame[1].as_str().expect("REQ subscription id").to_owned());
            }
        }
        subs
    })
}

fn wait_of(state: &BgState, sub: &str) -> Duration {
    state.closed_backoff[sub]
        .retry_at
        .duration_since(tokio::time::Instant::now())
}

#[test]
fn base_delay_doubles_from_one_second_and_caps_at_thirty() {
    let secs: Vec<u64> = (0..8)
        .map(|n| closed_retry_base_delay(n).as_secs())
        .collect();
    assert_eq!(secs, [1, 2, 4, 8, 16, 30, 30, 30]);
    // No overflow however long the relay keeps refusing.
    for attempts in [31, 32, 1_000, u32::MAX] {
        assert_eq!(closed_retry_base_delay(attempts), CLOSED_RETRY_MAX_DELAY);
    }
}

/// CLOSED parks the channel instead of re-sending; each further CLOSED waits
/// longer, up to the cap; EOSE puts the next wait back to the shortest one.
#[tokio::test(start_paused = true)]
async fn closed_channel_waits_longer_each_time_caps_and_resets_on_eose() {
    let (mut client, server) = test_ws_pair().await;
    let reqs = collect_reqs(server);
    let mut state = BgState::new();
    let channel = Uuid::new_v4();
    seed_test_subscription(&mut state, channel);
    let sub = channel_sub_id(channel);

    let mut waits = Vec::new();
    for round in 0..8u32 {
        assert!(dispatch(&mut client, &mut state, json!(["CLOSED", sub, READ_FAILED])).await);
        let wait = wait_of(&state, &sub);
        let base = closed_retry_base_delay(round);
        assert!(
            wait >= base.mul_f64(0.8) && wait <= base.mul_f64(1.2).min(CLOSED_RETRY_MAX_DELAY),
            "round {round}: waited {wait:?} for base {base:?}"
        );
        // Still waiting: the drain must not send it.
        tokio::time::advance(wait - Duration::from_millis(1)).await;
        assert!(!drain_parked(&mut client, &mut state, "synthetic-agent").await);
        assert!(state.rate_limited_pending.contains_key(&channel));
        // Wait over: exactly this channel is re-sent, and it stays subscribed.
        tokio::time::advance(Duration::from_millis(1)).await;
        assert!(drain_parked(&mut client, &mut state, "synthetic-agent").await);
        assert!(!state.rate_limited_pending.contains_key(&channel));
        assert!(state.active_subscriptions.contains_key(&channel));
        waits.push(wait);
    }
    assert!(waits[4] > waits[0] * 8, "the wait must grow: {waits:?}");
    assert!(waits[5..]
        .iter()
        .all(|wait| *wait >= Duration::from_secs(24) && *wait <= CLOSED_RETRY_MAX_DELAY));

    // The relay serves the subscription again: the ladder starts over.
    assert!(dispatch(&mut client, &mut state, json!(["EOSE", sub])).await);
    assert!(!state.closed_backoff.contains_key(&sub));
    assert!(dispatch(&mut client, &mut state, json!(["CLOSED", sub, READ_FAILED])).await);
    assert!(wait_of(&state, &sub) <= CLOSED_RETRY_BASE_DELAY.mul_f64(1.2));

    client.close(None).await.expect("close test websocket");
    assert_eq!(reqs.await.expect("join collector"), vec![sub; 8]);
}

/// A relay that closes every REQ it is sent, for five minutes, on a channel
/// and on both control subscriptions. The harness keeps trying, but the number
/// of REQs is bounded by the backoff: about one per 30 s per subscription once
/// the ladder is climbed, not one per CLOSED.
#[tokio::test(start_paused = true)]
async fn persistent_closed_sends_a_bounded_number_of_reqs() {
    const SIMULATED: Duration = Duration::from_secs(300);
    // 1+2+4+8+16 s then 30 s each, each at least 0.8x: 5 retries in the first
    // 24.8 s, then at most one per 24 s → 16 in 300 s. One spare for rounding.
    const MAX_REQS_PER_SUB: usize = 17;
    // At most 1.2x each: 5 retries within 37.2 s, then one per 30 s → 13.
    const MIN_REQS_PER_SUB: usize = 10;

    let (mut client, server) = test_ws_pair().await;
    let reqs = collect_reqs(server);
    let mut state = BgState::new();
    let channel = Uuid::new_v4();
    seed_test_subscription(&mut state, channel);
    state.membership_sub_active = true;
    state.observer_control_sub_active = true;
    let channel_sub = channel_sub_id(channel);
    let subs = [
        channel_sub.as_str(),
        MEMBERSHIP_NOTIF_SUB_ID,
        OBSERVER_CONTROL_SUB_ID,
    ];

    let steps = SIMULATED.as_millis() / REQ_PACING_INTERVAL.as_millis();
    for _ in 0..steps {
        // The relay refuses every subscription that is on the wire, i.e. every
        // one the harness is not currently holding back.
        for sub in subs {
            let parked = match sub {
                MEMBERSHIP_NOTIF_SUB_ID => state.membership_resub_needed,
                OBSERVER_CONTROL_SUB_ID => state.observer_resub_needed,
                _ => state.rate_limited_pending.contains_key(&channel),
            };
            if !parked {
                assert!(
                    dispatch(&mut client, &mut state, json!(["CLOSED", sub, READ_FAILED])).await
                );
            }
        }
        // One main-loop drain pass per pacing interval, as the loop runs it.
        drain_parked(&mut client, &mut state, "synthetic-agent").await;
        tokio::time::advance(REQ_PACING_INTERVAL).await;
    }

    client.close(None).await.expect("close test websocket");
    let sent = reqs.await.expect("join collector");
    for sub in subs {
        let count = sent.iter().filter(|s| s.as_str() == sub).count();
        assert!(
            (MIN_REQS_PER_SUB..=MAX_REQS_PER_SUB).contains(&count),
            "{sub}: {count} REQs in {SIMULATED:?} of persistent CLOSED"
        );
    }
    assert_eq!(state.closed_backoff.len(), subs.len());
}

/// A subscription waiting out its backoff holds nothing else back: another
/// channel's pending resubscribe goes out on the next drain pass, and the
/// loop's wake-up is the parked deadline, not "never".
#[tokio::test(start_paused = true)]
async fn parked_subscription_does_not_hold_back_others() {
    let (mut client, server) = test_ws_pair().await;
    let reqs = collect_reqs(server);
    let mut state = BgState::new();
    let (closed, other) = (Uuid::new_v4(), Uuid::new_v4());
    seed_test_subscription(&mut state, closed);
    seed_test_subscription(&mut state, other);
    let sub = channel_sub_id(closed);

    assert!(dispatch(&mut client, &mut state, json!(["CLOSED", sub, READ_FAILED])).await);
    assert!(
        dispatch(
            &mut client,
            &mut state,
            json!(["CLOSED", MEMBERSHIP_NOTIF_SUB_ID, READ_FAILED])
        )
        .await
    );
    let wake = state.next_parked_retry_at().expect("a parked wake-up");
    let wait = wake.duration_since(tokio::time::Instant::now());
    assert!(wait >= Duration::from_millis(800) && wait <= Duration::from_millis(1_200));

    state.resubscribe_retry.insert(other);
    assert!(drain_parked(&mut client, &mut state, "synthetic-agent").await);
    assert!(!state.resubscribe_retry.contains(&other));
    assert!(state.rate_limited_pending.contains_key(&closed));
    assert!(state.membership_resub_needed);

    // Unsubscribing forgets the backoff, so the map cannot grow with churn.
    state.active_subscriptions.remove(&closed);
    state.clear_channel_state(&closed);
    assert!(!state.closed_backoff.contains_key(&sub));

    client.close(None).await.expect("close test websocket");
    assert_eq!(
        reqs.await.expect("join collector"),
        vec![channel_sub_id(other)]
    );
}

/// Auth failures still ask for a reconnect and rate limits still arm the
/// gate; neither starts a CLOSED backoff.
#[tokio::test(start_paused = true)]
async fn auth_and_rate_limit_closed_keep_their_own_handling() {
    let (mut client, _server) = test_ws_pair().await;
    let mut state = BgState::new();
    let channel = Uuid::new_v4();
    seed_test_subscription(&mut state, channel);
    let sub = channel_sub_id(channel);

    assert!(
        !dispatch(
            &mut client,
            &mut state,
            json!(["CLOSED", sub, "auth-required: not authenticated"])
        )
        .await,
        "an auth CLOSED must ask for a reconnect"
    );
    assert!(
        dispatch(
            &mut client,
            &mut state,
            json!(["CLOSED", sub, "rate-limited: retry in 7s"])
        )
        .await
    );
    assert!(state.check_rate_gate().is_some());
    assert!(state.rate_limited_pending.contains_key(&channel));
    assert!(state.closed_backoff.is_empty());
}

/// Next REQ's subscription ID within `within`, answering pings meanwhile.
async fn next_req(
    server: &mut WebSocketStream<tokio::net::TcpStream>,
    within: Duration,
) -> Option<String> {
    let deadline = tokio::time::Instant::now() + within;
    loop {
        let message = tokio::time::timeout_at(deadline, server.next())
            .await
            .ok()?
            .expect("test websocket closed")
            .expect("read test websocket frame");
        match message {
            Message::Ping(payload) => server.send(Message::Pong(payload)).await.expect("pong"),
            Message::Text(text) => {
                let frame: Value = serde_json::from_str(&text).expect("parse harness frame");
                assert_eq!(frame[0], "REQ", "unexpected frame {frame}");
                return frame[1].as_str().map(str::to_owned);
            }
            other => panic!("unexpected {other:?}"),
        }
    }
}

/// The running socket task wakes itself for a parked subscription (nothing
/// else arrives to wake it), and a Shutdown during the wait ends it at once.
#[tokio::test]
async fn socket_task_resends_after_the_wait_and_shuts_down_during_it() {
    let (client, mut server) = test_ws_pair().await;
    let (tx, _rx) = mpsc::channel(4);
    let (control_tx, _control_rx) = mpsc::channel(1);
    let (cmd_tx, cmd_rx) = mpsc::channel(8);
    let task = tokio::spawn(run_background_task(
        client,
        VecDeque::new(),
        tx,
        control_tx,
        cmd_rx,
        Keys::generate(),
        "ws://127.0.0.1:1".into(),
        "synthetic-agent".into(),
        None,
    ));
    let channel = Uuid::new_v4();
    cmd_tx
        .send(RelayCommand::Subscribe {
            channel_id: channel,
            filter: super::tests::test_channel_filter(),
            replay_since: Some(1_000),
        })
        .await
        .expect("send subscribe");
    let sub = channel_sub_id(channel);
    let closed = Message::Text(json!(["CLOSED", sub, READ_FAILED]).to_string().into());

    let first = next_req(&mut server, Duration::from_secs(1)).await;
    assert_eq!(first.as_deref(), Some(sub.as_str()));
    server.send(closed.clone()).await.expect("send CLOSED");
    let closed_at = Instant::now();

    // Nothing for most of a second, then the same subscription again.
    assert_eq!(
        next_req(&mut server, Duration::from_millis(600)).await,
        None
    );
    let again = next_req(&mut server, Duration::from_secs(2)).await;
    assert_eq!(
        again.as_deref(),
        Some(sub.as_str()),
        "the parked subscription must be re-sent without other traffic"
    );
    assert!(closed_at.elapsed() >= Duration::from_millis(800));

    // Second CLOSED: a ~2 s wait. Shutdown must not sit behind it.
    server.send(closed).await.expect("send CLOSED");
    tokio::time::sleep(Duration::from_millis(100)).await;
    cmd_tx
        .send(RelayCommand::Shutdown)
        .await
        .expect("send shutdown");
    timeout(Duration::from_millis(500), task)
        .await
        .expect("shutdown must not wait for the backoff")
        .expect("join socket task");
}
