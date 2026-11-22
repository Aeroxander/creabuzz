//! The sponsored-fee limit: `POST /sponsor`, a thin service in front of the operator's own sponsor.
//!
//! A phone account (a passkey with no wallet app) asks a sponsor to pay the network fee with the JSON-RPC call
//! `zd_sponsorUserOperation`. Nothing in the repository limited that, so this does, and it is the one place the per-account
//! daily limit on sponsored fees lives (`docs/next-version/PHONE-PATH-REPORT.md` said it "must be enforced at the sponsor,
//! or a thin service the operator runs in front of it").
//!
//! **Off unless the operator names an upstream** (`BUZZ_SPONSOR_UPSTREAM_URL`: their real sponsor, which may carry a key in
//! its address, so it is read from the environment, never written down and never logged or answered). Without it the path
//! does not exist. The app's `VITE_CREATON_SPONSOR_URL` then names `/sponsor` on this server.
//!
//! **What the server can and cannot trust.** The request is an unauthenticated JSON-RPC body, and the `sender` inside it is
//! a public address anyone can name. A count per sender can therefore be run up by anyone against anyone, and the app
//! retries a failed call, so a limit placed in front of an exit would let a stranger use up a phone person's day, or the
//! server's day, and stop them taking their money out. So:
//!
//! - **An exit is never refused by a limit and never counted against a person or the server.** The call data is read
//!   ([`calldata`]) and an operation is an exit when every call in it goes to a Treasury this reader follows and is
//!   `leave` or `leaveTeam`, or takes parked Shares back first (`unpark` of a holder pause this reader follows, at most
//!   one per pause, and at least one `leave` or `leaveTeam` in the batch). Exits count only against one generous per-address cap, which an attacker spends on their own
//!   address. The operator's own sponsor keeps its own spend cap as the last backstop.
//! - **The request is pinned.** Only the method `zd_sponsorUserOperation`, on this reader's chain, one operation per
//!   request, a body of at most 32 KB, no batch. Without this the path would be an open proxy to a keyed upstream.
//! - **Every other operation** (a Back, a claim, a send) counts per sender, per address and for the whole server, per UTC
//!   day; the targets must be contracts this reader follows (or the dollar token or the Launcher). A request reserves its
//!   count in the same statement that checks it and gives it back when the upstream refuses or fails.
//!
//! **A limit that stays, said plainly:** because the sender is not authenticated, ten requests naming a victim's address
//! can use up that person's day for Back and the like (not for exits). That is accepted: a Back can be made from a wallet,
//! one attacker's reach is bounded by the per-address limit, and the limit exists to cap the operator's spend. An
//! authenticated sponsor is the later fix.
//!
//! A refusal is a JSON-RPC error whose message the app turns into plain words (it looks for `polic`, `denied`, `forbid`,
//! `unauthor`, `not allowed`, `exceed` or `quota`): "daily limit exceeded" for the three limits and "not allowed" for
//! everything the pins and the allow-list refuse.

pub mod calldata;

use std::collections::HashSet;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Json, Response},
};
use chrono::{NaiveDate, Utc};
use serde_json::{json, Value};
use sqlx::PgPool;

use crate::state::AppState;

/// The path.
pub const PATH: &str = "/sponsor";
/// The one method this path forwards.
pub const METHOD: &str = "zd_sponsorUserOperation";
/// The largest body read: more is refused.
pub const BODY_MAX: usize = 32 * 1024;
/// The refusal for the three limits.
pub const LIMIT_EXCEEDED: &str = "daily limit exceeded";
/// The refusal for what the pins and the allow-list refuse.
pub const NOT_ALLOWED: &str = "not allowed";
/// What the app is told when the upstream cannot be reached.
const UPSTREAM_DOWN: &str = "the sponsor is not reachable right now";
/// The words the app's refusal text matches (`passkey-sender.ts`, `app/.env.example`): each refusal here holds one.
pub const APP_WORDS: [&str; 7] = [
    "polic",
    "denied",
    "forbid",
    "unauthor",
    "not allowed",
    "exceed",
    "quota",
];

/// Per sender and day (`BUZZ_SPONSOR_PER_ACCOUNT_PER_DAY`).
pub const DEFAULT_PER_ACCOUNT: u32 = 10;
/// For the whole server per day (`BUZZ_SPONSOR_TOTAL_PER_DAY`).
pub const DEFAULT_TOTAL: u32 = 1_000;
/// Per client address and day (`BUZZ_SPONSOR_PER_IP_PER_DAY`).
pub const DEFAULT_PER_IP: u32 = 40;
/// Exits per client address and day (`BUZZ_SPONSOR_EXIT_PER_IP_PER_DAY`).
pub const DEFAULT_EXIT_PER_IP: u32 = 200;

const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(20);
const UPSTREAM_BODY_MAX: usize = 64 * 1024;

/// The sponsor's settings (`BUZZ_SPONSOR_*`). Present only when an upstream is named.
#[derive(Clone, PartialEq, Eq)]
pub struct SponsorConfig {
    upstream: String,
    /// Other operations per sender per UTC day.
    pub per_account_per_day: u32,
    /// Other operations for the whole server per UTC day.
    pub total_per_day: u32,
    /// Other operations per client address per UTC day.
    pub per_ip_per_day: u32,
    /// Exits per client address per UTC day: the only limit an exit meets.
    pub exit_per_ip_per_day: u32,
}

impl std::fmt::Debug for SponsorConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SponsorConfig")
            .field("upstream", &"[REDACTED]")
            .field("per_account_per_day", &self.per_account_per_day)
            .field("total_per_day", &self.total_per_day)
            .field("per_ip_per_day", &self.per_ip_per_day)
            .field("exit_per_ip_per_day", &self.exit_per_ip_per_day)
            .finish()
    }
}

const UPSTREAM_VAR: &str = "BUZZ_SPONSOR_UPSTREAM_URL";
const OTHER_VARS: [&str; 4] = [
    "BUZZ_SPONSOR_PER_ACCOUNT_PER_DAY",
    "BUZZ_SPONSOR_TOTAL_PER_DAY",
    "BUZZ_SPONSOR_PER_IP_PER_DAY",
    "BUZZ_SPONSOR_EXIT_PER_IP_PER_DAY",
];

fn var(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
}

fn number(name: &str, default: u32, max: u32) -> Result<u32, String> {
    match var(name) {
        None => Ok(default),
        Some(raw) => match raw.parse::<u32>() {
            Ok(v) if (1..=max).contains(&v) => Ok(v),
            _ => Err(format!(
                "{name} must be a whole number from 1 to {max} (got \"{raw}\")"
            )),
        },
    }
}

impl SponsorConfig {
    /// Read the settings; `Ok(None)` when no upstream is named. A limit without an upstream is half a configuration. The
    /// upstream's address never appears in an error.
    pub fn from_env() -> Result<Option<Self>, String> {
        let Some(upstream) = var(UPSTREAM_VAR) else {
            if let Some(set) = OTHER_VARS.iter().find(|name| var(name).is_some()) {
                return Err(format!(
                    "{set} is set but {UPSTREAM_VAR} is not; name the upstream sponsor, or set none of them"
                ));
            }
            return Ok(None);
        };
        let parsed = url::Url::parse(&upstream)
            .map_err(|_| format!("{UPSTREAM_VAR} must be an http(s) address"))?;
        if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
            return Err(format!("{UPSTREAM_VAR} must be an http(s) address"));
        }
        Ok(Some(Self {
            upstream,
            per_account_per_day: number(OTHER_VARS[0], DEFAULT_PER_ACCOUNT, 1_000_000)?,
            total_per_day: number(OTHER_VARS[1], DEFAULT_TOTAL, 100_000_000)?,
            per_ip_per_day: number(OTHER_VARS[2], DEFAULT_PER_IP, 1_000_000)?,
            exit_per_ip_per_day: number(OTHER_VARS[3], DEFAULT_EXIT_PER_IP, 1_000_000)?,
        }))
    }

    /// A configuration for a test, naming `upstream`.
    #[cfg(test)]
    pub fn for_test(upstream: &str) -> Self {
        Self {
            upstream: upstream.to_owned(),
            per_account_per_day: DEFAULT_PER_ACCOUNT,
            total_per_day: DEFAULT_TOTAL,
            per_ip_per_day: DEFAULT_PER_IP,
            exit_per_ip_per_day: DEFAULT_EXIT_PER_IP,
        }
    }
}

/// The contracts this reader follows and the dollar tokens its projects use: what an operation may call.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Allowed {
    /// Every address of the reader's contract table, the Launcher and the dollar tokens.
    pub targets: HashSet<[u8; 20]>,
    /// The Treasuries (an exit goes to one of them).
    pub treasuries: Vec<[u8; 20]>,
    /// The projects' holder pauses (an exit may take Shares back from one of them first: `unpark`).
    pub pauses: Vec<[u8; 20]>,
}

/// How long the allow-list is kept before it is read again.
const ALLOWED_TTL: Duration = Duration::from_secs(30);

static ALLOWED: LazyLock<moka::sync::Cache<String, Arc<Allowed>>> = LazyLock::new(|| {
    moka::sync::Cache::builder()
        .max_capacity(8)
        .time_to_live(ALLOWED_TTL)
        .build()
});

/// Read the allow-list from the reader's rows.
pub async fn read_allowed(
    pool: &PgPool,
    reader: &str,
    launcher: &[u8; 20],
) -> Result<Allowed, sqlx::Error> {
    let rows: Vec<(Vec<u8>, String)> =
        sqlx::query_as("SELECT address, role FROM chain_contracts WHERE reader = $1")
            .bind(reader)
            .fetch_all(pool)
            .await?;
    let dollars: Vec<Option<String>> = sqlx::query_scalar(
        "SELECT DISTINCT lower(decoded->'platform'->>'quote') FROM chain_logs \
         WHERE reader = $1 AND role = 'launcher' AND event = 'ProjectLaunched'",
    )
    .bind(reader)
    .fetch_all(pool)
    .await?;
    let mut allowed = Allowed::default();
    allowed.targets.insert(*launcher);
    for (address, role) in rows {
        if let Ok(address) = <[u8; 20]>::try_from(address.as_slice()) {
            allowed.targets.insert(address);
            match role.as_str() {
                "treasury" => allowed.treasuries.push(address),
                "pause" => allowed.pauses.push(address),
                _ => {}
            }
        }
    }
    for dollar in dollars.into_iter().flatten() {
        if let Some(address) = crate::chain_reader::word::parse_fixed::<20>(&dollar) {
            allowed.targets.insert(address);
        }
    }
    Ok(allowed)
}

async fn allowed_of(state: &AppState) -> Result<Arc<Allowed>, sqlx::Error> {
    let Some(reader) = state.config.chain_reader.as_ref() else {
        return Ok(Arc::new(Allowed::default()));
    };
    let name = reader.reader_id();
    if let Some(found) = ALLOWED.get(&name) {
        return Ok(found);
    }
    let read = Arc::new(read_allowed(state.db.pool(), &name, &reader.launcher).await?);
    ALLOWED.insert(name, Arc::clone(&read));
    Ok(read)
}

/// A request that passed the pins.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Parsed {
    /// The JSON-RPC id to answer with.
    pub id: Value,
    /// The account named in the operation, lower case. Not authenticated.
    pub sender: String,
    /// Whether the operation is an exit.
    pub exit: bool,
}

/// Check the request against the pins and the allow-list. `Err` is the id to answer with and the refusal. Pure.
pub fn classify(
    body: &[u8],
    chain_id: u64,
    allowed: &Allowed,
) -> Result<Parsed, (Value, &'static str)> {
    if body.len() > BODY_MAX {
        return Err((Value::Null, NOT_ALLOWED));
    }
    let value: Value = serde_json::from_slice(body).map_err(|_| (Value::Null, NOT_ALLOWED))?;
    // A batch (an array) is refused: one operation per request.
    let Value::Object(request) = &value else {
        return Err((Value::Null, NOT_ALLOWED));
    };
    let id = match request.get("id") {
        Some(id @ (Value::Number(_) | Value::String(_))) => id.clone(),
        _ => Value::Null,
    };
    let fail = |why: &'static str| (id.clone(), why);
    if request.get("method").and_then(Value::as_str) != Some(METHOD) {
        return Err(fail(NOT_ALLOWED));
    }
    let params = request
        .get("params")
        .and_then(Value::as_array)
        .filter(|p| p.len() == 1)
        .ok_or_else(|| fail(NOT_ALLOWED))?;
    let first = params[0].as_object().ok_or_else(|| fail(NOT_ALLOWED))?;
    if first.get("chainId").and_then(Value::as_u64) != Some(chain_id) {
        return Err(fail(NOT_ALLOWED));
    }
    let user_op = first
        .get("userOp")
        .and_then(Value::as_object)
        .ok_or_else(|| fail(NOT_ALLOWED))?;
    let sender = user_op
        .get("sender")
        .and_then(Value::as_str)
        .map(str::to_ascii_lowercase)
        .filter(|s| crate::chain_reader::word::parse_fixed::<20>(s).is_some())
        .ok_or_else(|| fail(NOT_ALLOWED))?;
    let call_data = user_op
        .get("callData")
        .and_then(Value::as_str)
        .and_then(|text| text.strip_prefix("0x"))
        .and_then(|digits| hex::decode(digits).ok())
        .ok_or_else(|| fail(NOT_ALLOWED))?;
    // Call data that cannot be read is refused: the allow-list could not be applied to it.
    let calls = calldata::decode(&call_data).map_err(|_| fail(NOT_ALLOWED))?;
    if calldata::is_exit(&calls, &allowed.treasuries, &allowed.pauses) {
        return Ok(Parsed {
            id,
            sender,
            exit: true,
        });
    }
    if calls.is_empty() || !calls.iter().all(|call| allowed.targets.contains(&call.to)) {
        return Err(fail(NOT_ALLOWED));
    }
    Ok(Parsed {
        id,
        sender,
        exit: false,
    })
}

/// What to count one request against, in the order they are taken: `(key, limit)`.
pub fn counters(
    config: &SponsorConfig,
    parsed: &Parsed,
    address: &str,
    reader: &str,
) -> Vec<(String, u32)> {
    if parsed.exit {
        return vec![(format!("exit-ip:{address}"), config.exit_per_ip_per_day)];
    }
    let mut keys = vec![
        (
            format!("acct:{}", parsed.sender),
            config.per_account_per_day,
        ),
        (format!("all:{reader}"), config.total_per_day),
        (format!("ip:{address}"), config.per_ip_per_day),
    ];
    // A fixed order, so two requests at once cannot wait for each other's rows.
    keys.sort();
    keys
}

/// Take one count from each key in one transaction. `Ok(true)` when all were taken; `Ok(false)` when any key was at its
/// limit, and then none is taken. The check and the count are the same statement.
pub async fn reserve(
    pool: &PgPool,
    day: NaiveDate,
    keys: &[(String, u32)],
) -> Result<bool, sqlx::Error> {
    let mut tx = pool.begin().await?;
    for (key, limit) in keys {
        let taken: Option<i32> = sqlx::query_scalar(
            "INSERT INTO sponsor_usage (day, key, count) VALUES ($1, $2, 1) \
             ON CONFLICT (day, key) DO UPDATE SET count = sponsor_usage.count + 1 \
             WHERE sponsor_usage.count < $3 RETURNING count",
        )
        .bind(day)
        .bind(key)
        .bind(i32::try_from(*limit).unwrap_or(i32::MAX))
        .fetch_optional(&mut *tx)
        .await?;
        if taken.is_none() {
            tx.rollback().await?;
            return Ok(false);
        }
    }
    tx.commit().await?;
    Ok(true)
}

/// Give back what [`reserve`] took (the upstream refused or failed).
pub async fn release(
    pool: &PgPool,
    day: NaiveDate,
    keys: &[(String, u32)],
) -> Result<(), sqlx::Error> {
    let names: Vec<&str> = keys.iter().map(|(key, _)| key.as_str()).collect();
    sqlx::query(
        "UPDATE sponsor_usage SET count = GREATEST(count - 1, 0) WHERE day = $1 AND key = ANY($2)",
    )
    .bind(day)
    .bind(&names)
    .execute(pool)
    .await?;
    Ok(())
}

fn rpc_error(id: &Value, message: &str) -> Response {
    // HTTP 200 with a JSON-RPC error: the app reads the message, and a 4xx or 5xx would be retried or hidden.
    (
        StatusCode::OK,
        Json(
            json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32000, "message": message } }),
        ),
    )
        .into_response()
}

static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(UPSTREAM_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap_or_default()
});

/// What the upstream answered: its status and body (bounded).
struct Upstream {
    status: StatusCode,
    body: Vec<u8>,
}

async fn forward(config: &SponsorConfig, body: Vec<u8>) -> Option<Upstream> {
    // Errors from here are never printed: a reqwest error carries the address, which may carry a key.
    let mut response = HTTP
        .post(config.upstream.as_str())
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
        .ok()?;
    let status = StatusCode::from_u16(response.status().as_u16()).ok()?;
    let mut collected = Vec::new();
    while let Ok(Some(chunk)) = response.chunk().await {
        collected.extend_from_slice(&chunk);
        if collected.len() > UPSTREAM_BODY_MAX {
            return None;
        }
    }
    Some(Upstream {
        status,
        body: collected,
    })
}

/// Whether an upstream answer is a success the count should stay for: a 2xx whose JSON-RPC body has a result and no error.
fn is_success(upstream: &Upstream) -> bool {
    if !upstream.status.is_success() {
        return false;
    }
    serde_json::from_slice::<Value>(&upstream.body)
        .map(|v| v.get("error").is_none_or(Value::is_null) && v.get("result").is_some())
        .unwrap_or(false)
}

/// `POST /sponsor`.
pub async fn sponsor(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: axum::body::Body,
) -> Response {
    let (Some(config), Some(reader)) = (
        state.config.sponsor.as_ref(),
        state.config.chain_reader.as_ref(),
    ) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    // The body is read up to the cap and no further.
    let Ok(bytes) = axum::body::to_bytes(body, BODY_MAX + 1).await else {
        return rpc_error(&Value::Null, NOT_ALLOWED);
    };
    let allowed = match allowed_of(&state).await {
        Ok(allowed) => allowed,
        Err(e) => {
            tracing::warn!(error = %e, "sponsor: the allow-list could not be read");
            return (StatusCode::SERVICE_UNAVAILABLE, "try again shortly").into_response();
        }
    };
    let parsed = match classify(&bytes, reader.chain_id, &allowed) {
        Ok(parsed) => parsed,
        Err((id, why)) => return rpc_error(&id, why),
    };
    let address = super::public_read::client_address(&headers).unwrap_or_else(|| "none".to_owned());
    let keys = counters(config, &parsed, &address, &reader.reader_id());
    let day = Utc::now().date_naive();
    let pool = state.db.pool();
    match reserve(pool, day, &keys).await {
        Ok(true) => {}
        Ok(false) => {
            metrics::counter!("buzz_sponsor_refused_total", "why" => if parsed.exit { "exit_address" } else { "limit" }).increment(1);
            return rpc_error(&parsed.id, LIMIT_EXCEEDED);
        }
        Err(e) => {
            tracing::warn!(error = %e, "sponsor: the count could not be taken");
            return (StatusCode::SERVICE_UNAVAILABLE, "try again shortly").into_response();
        }
    }
    let answer = forward(config, bytes.to_vec()).await;
    match answer {
        Some(upstream) => {
            if !is_success(&upstream) {
                // The upstream refused: the count is given back.
                if let Err(e) = release(pool, day, &keys).await {
                    tracing::warn!(error = %e, "sponsor: a count could not be given back");
                }
            }
            (
                upstream.status,
                [(axum::http::header::CONTENT_TYPE, "application/json")],
                upstream.body,
            )
                .into_response()
        }
        None => {
            if let Err(e) = release(pool, day, &keys).await {
                tracing::warn!(error = %e, "sponsor: a count could not be given back");
            }
            (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "jsonrpc": "2.0", "id": parsed.id,
                    "error": { "code": -32000, "message": UPSTREAM_DOWN } })),
            )
                .into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn address(n: u8) -> [u8; 20] {
        [n; 20]
    }

    fn text(a: &[u8; 20]) -> String {
        format!("0x{}", hex::encode(a))
    }

    fn operation(sender: &str, calls: &[calldata::Call]) -> Value {
        json!({ "chainId": 31337, "userOp": { "sender": sender, "callData": format!("0x{}", hex::encode(calldata::encode(calls))) },
                "entryPointAddress": "0x0000000071727de22e5e9d8baf0edac6f37da032" })
    }

    fn request(method: &str, params: Value) -> Vec<u8> {
        json!({ "jsonrpc": "2.0", "id": 7, "method": method, "params": params })
            .to_string()
            .into_bytes()
    }

    fn call(to: [u8; 20], signature: &str) -> calldata::Call {
        let mut data = calldata::selector(signature).to_vec();
        data.extend_from_slice(&[0u8; 96]);
        calldata::Call {
            to,
            value: [0u8; 32],
            data,
        }
    }

    fn allowed() -> Allowed {
        Allowed {
            targets: HashSet::from([address(1), address(2), address(3)]),
            treasuries: vec![address(1)],
            pauses: vec![address(2)],
        }
    }

    #[test]
    fn a_good_back_passes_and_an_exit_is_known_for_what_it_is() {
        let back = request(
            METHOD,
            json!([operation(
                &text(&address(9)),
                &[call(address(2), "join(uint256,uint256,address)")]
            )]),
        );
        let parsed = classify(&back, 31337, &allowed()).expect("a back passes");
        assert_eq!(parsed.id, json!(7));
        assert_eq!(parsed.sender, text(&address(9)));
        assert!(!parsed.exit);
        let exit = request(
            METHOD,
            json!([operation(
                &text(&address(9)),
                &[call(address(1), calldata::LEAVE_SIGNATURE)]
            )]),
        );
        assert!(
            classify(&exit, 31337, &allowed())
                .expect("an exit passes")
                .exit
        );
        let team = request(
            METHOD,
            json!([operation(
                &text(&address(9)),
                &[call(address(1), calldata::LEAVE_TEAM_SIGNATURE)]
            )]),
        );
        assert!(classify(&team, 31337, &allowed()).expect("passes").exit);
        // A sender in capitals is the same sender.
        let upper = request(
            METHOD,
            json!([operation(
                &text(&address(0xab)).replace("ab", "AB"),
                &[call(address(2), "join(uint256,uint256,address)")]
            )]),
        );
        assert_eq!(
            classify(&upper, 31337, &allowed()).expect("passes").sender,
            text(&address(0xab))
        );
    }

    /// "Start the day" (`poke()` of a holder pause) by a passkey account: the pause is a contract the reader follows, so the
    /// call is on the allow-list by its address and is let through; it is an ordinary operation, not an exit, so it counts
    /// against the per-account, per-address and whole-server daily limits like a Back does. A poke to a contract the reader
    /// does not follow is refused.
    #[test]
    fn a_start_the_day_poke_is_allowed_and_counts_like_any_other_operation() {
        let press = |to: [u8; 20]| {
            request(
                METHOD,
                json!([operation(&text(&address(9)), &[call(to, "poke()")])]),
            )
        };
        let parsed = classify(&press(address(2)), 31337, &allowed()).expect("a poke to the pause");
        assert!(!parsed.exit, "a poke is not an exit");
        let config = SponsorConfig::for_test("http://127.0.0.1:1/");
        assert!(
            counters(&config, &parsed, "203.0.113.5", "reader")
                .iter()
                .any(|(key, _)| key.starts_with("acct:")),
            "it counts against the account's day"
        );
        assert!(classify(&press(address(7)), 31337, &allowed()).is_err());
    }

    /// A Take out of parked Shares is one press that takes them back first: `[unpark, leave]` is an exit (never refused by
    /// a limit, never counted), and `unpark` alone is an ordinary operation that counts like any other.
    #[test]
    fn an_unpark_then_a_take_out_is_an_exit_and_an_unpark_alone_is_not() {
        let unpark = |to: [u8; 20]| {
            let mut data = calldata::selector(calldata::UNPARK_SIGNATURE).to_vec();
            data.extend_from_slice(&[0u8; 32]);
            calldata::Call {
                to,
                value: [0u8; 32],
                data,
            }
        };
        let press = |calls: &[calldata::Call]| {
            request(METHOD, json!([operation(&text(&address(9)), calls)]))
        };
        let both = press(&[
            unpark(address(2)),
            call(address(1), calldata::LEAVE_SIGNATURE),
        ]);
        assert!(
            classify(&both, 31337, &allowed()).expect("passes").exit,
            "a take out of parked Shares"
        );
        let alone = press(&[unpark(address(2))]);
        assert!(
            !classify(&alone, 31337, &allowed()).expect("passes").exit,
            "an unpark alone counts like any other operation"
        );
        let twice = press(&[
            unpark(address(2)),
            unpark(address(2)),
            call(address(1), calldata::LEAVE_SIGNATURE),
        ]);
        assert!(!classify(&twice, 31337, &allowed()).is_ok_and(|parsed| parsed.exit));
    }

    /// K9 (the pins): a method other than the one, a batch array, a body over 32 KB, another chain, two operations, and
    /// call data that cannot be read are refused with "not allowed"; so is a target that is off the list.
    #[test]
    fn the_request_is_pinned() {
        let op = operation(
            &text(&address(9)),
            &[call(address(2), "join(uint256,uint256,address)")],
        );
        let refused = |body: Vec<u8>| classify(&body, 31337, &allowed()).expect_err("refused").1;
        assert_eq!(
            refused(request("eth_sendUserOperation", json!([op.clone()]))),
            NOT_ALLOWED
        );
        assert_eq!(refused(request("eth_call", json!([]))), NOT_ALLOWED);
        let batch =
            json!([{ "jsonrpc": "2.0", "id": 1, "method": METHOD, "params": [op.clone()] }]);
        assert_eq!(refused(batch.to_string().into_bytes()), NOT_ALLOWED);
        assert_eq!(
            refused(request(METHOD, json!([op.clone(), op.clone()]))),
            NOT_ALLOWED,
            "one operation per request"
        );
        assert_eq!(refused(request(METHOD, json!([]))), NOT_ALLOWED);
        assert_eq!(refused(request(METHOD, json!({"userOp": 1}))), NOT_ALLOWED);
        assert_eq!(refused(b"not json".to_vec()), NOT_ALLOWED);
        assert_eq!(refused(Vec::new()), NOT_ALLOWED);
        let mut other_chain = op.clone();
        other_chain["chainId"] = json!(1);
        assert_eq!(refused(request(METHOD, json!([other_chain]))), NOT_ALLOWED);
        let mut no_sender = op.clone();
        no_sender["userOp"]["sender"] = json!("0x12");
        assert_eq!(refused(request(METHOD, json!([no_sender]))), NOT_ALLOWED);
        let mut bad_data = op.clone();
        bad_data["userOp"]["callData"] = json!("0xdeadbeef");
        assert_eq!(refused(request(METHOD, json!([bad_data]))), NOT_ALLOWED);
        let off_list = operation(
            &text(&address(9)),
            &[call(address(77), "join(uint256,uint256,address)")],
        );
        assert_eq!(refused(request(METHOD, json!([off_list]))), NOT_ALLOWED);
        let mixed = operation(
            &text(&address(9)),
            &[
                call(address(2), "join(uint256,uint256,address)"),
                call(address(77), "join(uint256,uint256,address)"),
            ],
        );
        assert_eq!(
            refused(request(METHOD, json!([mixed]))),
            NOT_ALLOWED,
            "every call's target must be on the list"
        );
        let mut huge = request(METHOD, json!([op]));
        huge.resize(BODY_MAX + 1, b' ');
        assert_eq!(refused(huge), NOT_ALLOWED, "a body over 32 KB");
        // The id is echoed when there is one.
        let bad_with_id = request("eth_call", json!([]));
        assert_eq!(
            classify(&bad_with_id, 31337, &allowed())
                .expect_err("refused")
                .0,
            json!(7)
        );
    }

    #[test]
    fn an_exit_meets_only_the_address_cap_and_every_other_operation_meets_three() {
        let config = SponsorConfig::for_test("http://127.0.0.1:1/");
        let exit = Parsed {
            id: Value::Null,
            sender: text(&address(9)),
            exit: true,
        };
        let other = Parsed {
            exit: false,
            ..exit.clone()
        };
        assert_eq!(
            counters(&config, &exit, "1.2.3.4", "31337:0xabc"),
            vec![("exit-ip:1.2.3.4".to_owned(), DEFAULT_EXIT_PER_IP)],
            "an exit is never counted against a person or the server"
        );
        let keys = counters(&config, &other, "1.2.3.4", "31337:0xabc");
        assert_eq!(keys.len(), 3);
        assert!(keys
            .iter()
            .any(|(k, l)| k.starts_with("acct:") && *l == DEFAULT_PER_ACCOUNT));
        assert!(keys
            .iter()
            .any(|(k, l)| k == "all:31337:0xabc" && *l == DEFAULT_TOTAL));
        assert!(keys
            .iter()
            .any(|(k, l)| k == "ip:1.2.3.4" && *l == DEFAULT_PER_IP));
        let mut sorted = keys.clone();
        sorted.sort();
        assert_eq!(keys, sorted, "a fixed order");
    }

    /// The two refusals carry a word the app's list knows (`app/.env.example`, `passkey-sender.ts`), and nothing here
    /// shows the upstream.
    #[test]
    fn each_refusal_holds_a_word_the_app_turns_into_plain_words() {
        for sentence in [LIMIT_EXCEEDED, NOT_ALLOWED] {
            assert!(APP_WORDS.iter().any(|w| sentence.contains(w)), "{sentence}");
        }
        let config = SponsorConfig::for_test("https://sponsor.example/v1/secretkeyvalue");
        assert!(!format!("{config:?}").contains("secretkeyvalue"));
    }

    #[test]
    fn success_is_a_result_without_an_error() {
        let up = |status: u16, body: &str| Upstream {
            status: StatusCode::from_u16(status).expect("status"),
            body: body.as_bytes().to_vec(),
        };
        assert!(is_success(&up(
            200,
            r#"{"jsonrpc":"2.0","id":1,"result":{"callGasLimit":"0x1"}}"#
        )));
        assert!(!is_success(&up(
            200,
            r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32500,"message":"policy"}}"#
        )));
        assert!(!is_success(&up(400, r#"{"result":{}}"#)));
        assert!(!is_success(&up(200, "not json")));
        assert!(!is_success(&up(200, r#"{"jsonrpc":"2.0","id":1}"#)));
    }
}

#[cfg(test)]
#[path = "sponsor_postgres_tests.rs"]
mod postgres_tests;
