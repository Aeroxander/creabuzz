//! Test support for web push: a community with the run's project (the holder room's world), a push configuration of the
//! test's own (a throwaway VAPID key made at run time, never written anywhere), a **local stand-in for a push service**,
//! and the task rows the alert maker reads.
//!
//! The stand-in is an `axum` server on `127.0.0.1:<random port>` whose address the test puts in the operator's list of
//! extra hosts (`BUZZ_WEB_PUSH_EXTRA_HOSTS`, for this test only). It is scripted per request (`201`, `404`, `410`, `429`
//! with `Retry-After`, `500`, a slow answer, a redirect, a refusal of the VAPID token). It **decrypts** what it receives
//! with the key pair the test made for that device (so the test reads the real payload) and checks the VAPID token against
//! the public key. No real push service, device or key is used anywhere in these tests.

use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use nostr::Keys;
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::SecretKey;

use super::vapid::{verify_token, Claims, VapidKey};
use super::{ece, WebPushConfig};
use crate::handlers::room_support::{room_world_with, RoomWorld};

/// A chain reader's settings of the test's own (its Launcher is random, so the rows it reads are the only rows there are).
pub(crate) fn reader_config() -> crate::chain_reader::ChainReaderConfig {
    let mut launcher = [0u8; 20];
    launcher.copy_from_slice(&uuid::Uuid::new_v4().as_bytes()[..16].repeat(2)[..20]);
    crate::chain_reader::ChainReaderConfig {
        rpc_url: "http://127.0.0.1:1".into(),
        chain_id: 31_337,
        launcher,
        start_block: 0,
        confirmations: 12,
        poll_secs: 12,
        refresh_secs: 3_600,
        active_refresh_secs: 600,
        log_range: 2_000,
        community_host: None,
        helper: None,
    }
}

/// A VAPID key made for this test.
pub(crate) fn throwaway_vapid() -> VapidKey {
    loop {
        let bytes: [u8; 32] = rand::random();
        if let Ok(key) = VapidKey::from_base64url(&B64.encode(bytes)) {
            return key;
        }
    }
}

/// A push configuration of the test's own, with the stand-in's address as the one extra host.
pub(crate) fn config_for(extra_hosts: Vec<String>) -> WebPushConfig {
    WebPushConfig {
        vapid: throwaway_vapid(),
        subject: "mailto:operator@example.org".to_owned(),
        daily_cap: super::settings::DEFAULT_DAILY_CAP,
        max_per_account: super::settings::DEFAULT_MAX_PER_ACCOUNT,
        extra_hosts,
    }
}

/// A device: the keys a browser would make, and the address the stand-in answers for it.
#[derive(Clone)]
pub(crate) struct Device {
    pub(crate) endpoint: String,
    pub(crate) p256dh: [u8; 65],
    pub(crate) auth: [u8; 16],
}

/// What the stand-in did with one request.
#[derive(Debug, Clone)]
pub(crate) struct Received {
    pub(crate) path: String,
    pub(crate) topic: Option<String>,
    pub(crate) ttl: Option<String>,
    pub(crate) urgency: Option<String>,
    pub(crate) content_encoding: Option<String>,
    pub(crate) content_length: usize,
    /// The decrypted message, or why it did not decrypt.
    pub(crate) payload: Result<String, String>,
    /// The VAPID claims when the token verified against the public key the stand-in was given, or why not.
    pub(crate) vapid: Result<Claims, String>,
}

/// How the stand-in answers one request.
#[derive(Debug, Clone)]
pub(crate) enum Script {
    /// This status.
    Status(u16),
    /// This status with a `Retry-After` of so many seconds.
    RetryAfter(u16, u64),
    /// This status after a pause.
    Slow(Duration, u16),
    /// A redirect to this address (a push service must never make the server follow it).
    Redirect(String),
}

struct Inner {
    scripts: VecDeque<Script>,
    default: Script,
    received: Vec<Received>,
    devices: HashMap<String, (SecretKey, [u8; 16])>,
    vapid_public: Vec<u8>,
}

/// The stand-in push service.
pub(crate) struct StandIn {
    pub(crate) addr: SocketAddr,
    inner: Arc<Mutex<Inner>>,
    server: tokio::task::JoinHandle<()>,
}

impl Drop for StandIn {
    fn drop(&mut self) {
        self.server.abort();
    }
}

async fn handle(State(inner): State<Arc<Mutex<Inner>>>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let bytes = axum::body::to_bytes(body, 16 * 1024)
        .await
        .unwrap_or_default();
    let header = |name: &str| {
        parts
            .headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
    };
    let path = parts.uri.path().to_owned();
    let (script, record) = {
        let mut guard = inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let payload = match guard.devices.get(&path) {
            Some((secret, auth)) => ece::decrypt(&bytes, secret, auth)
                .map_err(|e| e.to_string())
                .and_then(|plain| String::from_utf8(plain).map_err(|e| e.to_string())),
            None => Err("no device is registered at this path".to_owned()),
        };
        let vapid = header("authorization")
            .ok_or_else(|| "no Authorization header".to_owned())
            .and_then(|value| {
                let rest = value.strip_prefix("vapid ").ok_or("not a vapid header")?;
                let token = rest
                    .split(", ")
                    .find_map(|p| p.strip_prefix("t="))
                    .ok_or("no t=")?;
                let key = rest
                    .split(", ")
                    .find_map(|p| p.strip_prefix("k="))
                    .ok_or("no k=")?;
                let key_bytes = B64
                    .decode(key)
                    .map_err(|_| "k is not base64url".to_owned())?;
                if key_bytes != guard.vapid_public {
                    return Err("k is not the operator's public key".to_owned());
                }
                verify_token(token, &key_bytes)
            });
        let record = Received {
            path,
            topic: header("topic"),
            ttl: header("ttl"),
            urgency: header("urgency"),
            content_encoding: header("content-encoding"),
            content_length: bytes.len(),
            payload,
            vapid,
        };
        guard.received.push(record.clone());
        let script = guard
            .scripts
            .pop_front()
            .unwrap_or_else(|| guard.default.clone());
        (script, record)
    };
    let _ = record;
    match script {
        Script::Status(code) => StatusCode::from_u16(code)
            .unwrap_or(StatusCode::OK)
            .into_response(),
        Script::RetryAfter(code, secs) => (
            StatusCode::from_u16(code).unwrap_or(StatusCode::OK),
            [("retry-after", secs.to_string())],
        )
            .into_response(),
        Script::Slow(pause, code) => {
            tokio::time::sleep(pause).await;
            StatusCode::from_u16(code)
                .unwrap_or(StatusCode::OK)
                .into_response()
        }
        Script::Redirect(to) => (StatusCode::FOUND, [("location", to)]).into_response(),
    }
}

impl StandIn {
    /// Start the stand-in; it checks every VAPID token against `vapid_public`. By default it answers 201.
    pub(crate) async fn start(vapid_public: Vec<u8>) -> Self {
        let inner = Arc::new(Mutex::new(Inner {
            scripts: VecDeque::new(),
            default: Script::Status(201),
            received: Vec::new(),
            devices: HashMap::new(),
            vapid_public,
        }));
        let app = axum::Router::new()
            .fallback(handle)
            .with_state(Arc::clone(&inner));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind the stand-in on a random port");
        let addr = listener.local_addr().expect("the stand-in's address");
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Self {
            addr,
            inner,
            server,
        }
    }

    /// The operator's list of extra hosts for this stand-in.
    pub(crate) fn extra_hosts(&self) -> Vec<String> {
        vec![format!("127.0.0.1:{}", self.addr.port())]
    }

    /// A new device the stand-in will decrypt for.
    pub(crate) fn device(&self) -> Device {
        let secret = loop {
            let bytes: [u8; 32] = rand::random();
            if let Ok(secret) = SecretKey::from_slice(&bytes) {
                break secret;
            }
        };
        let public = secret.public_key().to_encoded_point(false);
        let mut p256dh = [0u8; 65];
        p256dh.copy_from_slice(public.as_bytes());
        let auth: [u8; 16] = rand::random();
        let path = format!("/push/{}", uuid::Uuid::new_v4().simple());
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .devices
            .insert(path.clone(), (secret.clone(), auth));
        Device {
            endpoint: format!("http://{}{path}", self.addr),
            p256dh,
            auth,
        }
    }

    /// Answer the next requests as scripted, then as the default.
    pub(crate) fn script(&self, scripts: impl IntoIterator<Item = Script>) {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .scripts
            .extend(scripts);
    }

    /// Answer every request after the scripted ones with this.
    pub(crate) fn default_answer(&self, script: Script) {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .default = script;
    }

    /// Everything received so far.
    pub(crate) fn received(&self) -> Vec<Received> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .received
            .clone()
    }

    /// What was received at one device's address.
    pub(crate) fn received_at(&self, device: &Device) -> Vec<Received> {
        let path = device
            .endpoint
            .split_once(&self.addr.to_string())
            .map_or("", |(_, rest)| rest);
        self.received()
            .into_iter()
            .filter(|r| r.path == path)
            .collect()
    }
}

/// The holder room's world with push switched on, a stand-in push service and the reader's position stored.
pub(crate) struct PushWorld {
    pub(crate) w: RoomWorld,
    pub(crate) stand_in: StandIn,
    pub(crate) config: WebPushConfig,
}

/// Build the world: the run's project stored up to its end, push configured with the stand-in as an extra host.
pub(crate) async fn push_world() -> PushWorld {
    let vapid = throwaway_vapid();
    let stand_in = StandIn::start(vapid.public_bytes().to_vec()).await;
    let mut config = config_for(stand_in.extra_hosts());
    config.vapid = vapid;
    let configured = config.clone();
    let w = room_world_with(true, move |c| c.web_push = Some(configured)).await;
    // The queue is one for the whole deployment: rows other runs left in this test database are none of this test's.
    sqlx::query("DELETE FROM web_push_outbox WHERE state IN ('pending', 'sending')")
        .execute(w.state.db.pool())
        .await
        .expect("an empty queue");
    w.seed_to(w.fx.head()).await;
    set_reader_next(&w, w.fx.head() + 1).await;
    PushWorld {
        w,
        stand_in,
        config,
    }
}

/// Where the chain reader says it will read next.
pub(crate) async fn set_reader_next(w: &RoomWorld, next: u64) {
    sqlx::query(
        "INSERT INTO chain_reader_cursor (reader, next_block) VALUES ($1, $2) \
         ON CONFLICT (reader) DO UPDATE SET next_block = EXCLUDED.next_block",
    )
    .bind(&w.reader)
    .bind(i64::try_from(next).expect("block"))
    .execute(w.state.db.pool())
    .await
    .expect("the reader's position");
}

/// A block after the run's, at `time` (the chain's clock).
pub(crate) async fn add_block(w: &RoomWorld, number: u64, time: u64) {
    sqlx::query(
        "INSERT INTO chain_blocks (reader, number, hash, parent_hash, block_time) VALUES ($1, $2, $3, $3, $4) \
         ON CONFLICT (reader, number) DO UPDATE SET block_time = EXCLUDED.block_time",
    )
    .bind(&w.reader)
    .bind(i64::try_from(number).expect("block"))
    .bind(vec![(number % 251) as u8; 32])
    .bind(i64::try_from(time).expect("time"))
    .execute(w.state.db.pool())
    .await
    .expect("a block");
}

/// A task row of project A in `block` (the block must exist): `TaskAnnounced`, `TaskTaken` or `TaskResolved` (with its
/// `state`), for `serial`.
pub(crate) async fn add_task_row(
    w: &RoomWorld,
    block: u64,
    log_index: i32,
    event: &str,
    serial: u64,
    state: Option<u64>,
) {
    let mut decoded = serde_json::json!({ "serial": serial.to_string() });
    if let Some(state) = state {
        decoded["state"] = serde_json::json!(state.to_string());
    }
    sqlx::query(
        "INSERT INTO chain_logs (reader, block_number, log_index, block_hash, tx_hash, address, role, project_key, \
         event, topics, data, decoded) VALUES ($1, $2, $3, $4, $4, $5, 'tasks', $6, $7, $8, $9, $10) \
         ON CONFLICT DO NOTHING",
    )
    .bind(&w.reader)
    .bind(i64::try_from(block).expect("block"))
    .bind(log_index)
    .bind(vec![(block % 251) as u8; 32])
    .bind(vec![0x44u8; 20])
    .bind(w.key.as_slice())
    .bind(event)
    .bind(Vec::<Vec<u8>>::new())
    .bind(Vec::<u8>::new())
    .bind(&decoded)
    .execute(w.state.db.pool())
    .await
    .expect("a task row");
}

/// The vote contract's address in the alert tests: project A's pause, once `PauseReady` has named it. Not one of the
/// run's contracts, so nothing else in the seeded rows claims it.
pub(crate) const VOTE_GATE: [u8; 20] = [0x77; 20];

/// A row of the project's owner contract in `block`: `PauseReady` on the Treasury (naming `gate`) or, with `role` and
/// `address`, any other role's row. The block must exist.
pub(crate) async fn add_vote_row(
    w: &RoomWorld,
    block: u64,
    log_index: i32,
    role: &str,
    address: [u8; 20],
    event: &str,
    decoded: serde_json::Value,
) {
    sqlx::query(
        "INSERT INTO chain_logs (reader, block_number, log_index, block_hash, tx_hash, address, role, project_key, \
         event, topics, data, decoded) VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9, $10, $11) \
         ON CONFLICT DO NOTHING",
    )
    .bind(&w.reader)
    .bind(i64::try_from(block).expect("block"))
    .bind(log_index)
    .bind(vec![(block % 251) as u8; 32])
    .bind(address.as_slice())
    .bind(role)
    .bind(w.key.as_slice())
    .bind(event)
    .bind(Vec::<Vec<u8>>::new())
    .bind(Vec::<u8>::new())
    .bind(&decoded)
    .execute(w.state.db.pool())
    .await
    .expect("a vote row");
}

/// The Treasury's `PauseReady`, naming `VOTE_GATE`: the ledger then knows the project's pause (its vote contract).
pub(crate) async fn add_pause_ready(w: &RoomWorld, block: u64) {
    add_vote_row(
        w,
        block,
        0,
        "treasury",
        w.fx.projects["A"].treasury,
        "PauseReady",
        serde_json::json!({ "gate": format!("0x{}", hex::encode(VOTE_GATE)) }),
    )
    .await;
}

/// One `BallotOpened` of project A's vote contract at `gate`, with the ballot's times and numbers (all strings, as the
/// reader stores them).
pub(crate) async fn ballot_opened(
    w: &RoomWorld,
    block: u64,
    log_index: i32,
    gate: [u8; 20],
    id: u32,
    kind: u8,
    opened_at: u64,
    vote_end: u64,
    supply: u128,
    floor: u128,
) {
    add_vote_row(
        w,
        block,
        log_index,
        "pause",
        gate,
        "BallotOpened",
        serde_json::json!({
            "id": id.to_string(),
            "kind": kind.to_string(),
            "openedAt": opened_at.to_string(),
            "standEnd": (opened_at + 1).to_string(),
            "voteEnd": vote_end.to_string(),
            "effectiveAt": (vote_end + 1).to_string(),
            "supply": supply.to_string(),
            "floor": floor.to_string(),
            "upA": "0",
            "upB": "0",
        }),
    )
    .await;
}

/// One `Voted` row: the absolute tally of `option` and the cast total after it (no voter is named anywhere).
pub(crate) async fn voted(
    w: &RoomWorld,
    block: u64,
    log_index: i32,
    gate: [u8; 20],
    id: u32,
    option: u8,
    option_tally: u128,
    cast_total: u128,
) {
    add_vote_row(
        w,
        block,
        log_index,
        "pause",
        gate,
        "Voted",
        serde_json::json!({
            "id": id.to_string(),
            "option": option.to_string(),
            "fromOption": u8::MAX.to_string(),
            "optionTally": option_tally.to_string(),
            "castTotal": cast_total.to_string(),
        }),
    )
    .await;
}

/// Add one block holding one task row and tell the reader it has read up to it. Returns the block.
pub(crate) async fn task_event(
    w: &RoomWorld,
    at: u64,
    time: u64,
    event: &str,
    serial: u64,
    state: Option<u64>,
) -> u64 {
    add_block(w, at, time).await;
    add_task_row(w, at, 0, event, serial, state).await;
    set_reader_next(w, at + 1).await;
    at
}

/// A holder account linked to the run's account `n`, with a device the stand-in answers for.
pub(crate) async fn subscribed(pw: &PushWorld, n: usize) -> (Keys, Device) {
    let keys = pw.w.account().await;
    pw.w.link(&keys, n, 3_600).await.expect("the link");
    let device = pw.stand_in.device();
    keep(pw, &keys, &device).await;
    (keys, device)
}

/// Keep `device` for `keys`' account (the store, not the path).
pub(crate) async fn keep(pw: &PushWorld, keys: &Keys, device: &Device) {
    super::store::upsert_subscription(
        pw.w.state.db.pool(),
        *pw.w.tenant.community().as_uuid(),
        &keys.public_key().to_bytes(),
        super::store::NewDevice {
            endpoint: &device.endpoint,
            p256dh: &device.p256dh,
            auth: &device.auth,
        },
        pw.config.max_per_account,
        chrono::Utc::now(),
    )
    .await
    .expect("keep a device");
}
