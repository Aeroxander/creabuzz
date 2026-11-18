//! Relay-owned LLM gateway for browser agents.
//!
//! Browser agents cannot carry API keys and cannot call arbitrary hosts
//! through CORS. These narrow endpoints let client code send an
//! OpenAI-compatible `/chat/completions` payload to the relay; the relay
//! injects the operator's upstream URL + bearer key and relays the response.
//! The key never leaves the relay host, and only NIP-98-authenticated relay
//! members can use the gateway (same auth as `/query`).
//!
//! The gateway spends the operator's money, so it is metered (DAO OS rule R2/R6):
//! a per-caller per-minute rate limit, the caller's `llm_calls` budget (falling
//! back to a daily operator cap when no budget covers them), a daily cap for the
//! whole community whoever asks, a clamped `max_tokens`, an operator-pinned
//! `model`, forced non-streaming responses, and a hard cap on the upstream body
//! the relay will buffer.
//!
//! Every refusal is a 429 whose `error` is a sentence the person can act on
//! (what ran out, when it comes back, that they can write it themselves) with a
//! stable `code` (`ai_too_fast`, `ai_limit_account`, `ai_limit_community`,
//! `ai_limit_spend`) and `retry_after_secs`, so a client can show the words as
//! they are.

use std::sync::Arc;
use std::time::Duration;

use axum::{
    body::Bytes,
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::{Json, Response},
};
use buzz_auth::LimitType;

use crate::state::AppState;

use super::{api_error, bridge, relay_members};

/// Dedicated upstream client. Redirects disabled: a provider 3xx must never
/// replay a key-bearing request to an attacker-chosen host.
///
/// Built once at startup and stored on `AppState`; a build failure is
/// reported there and the route answers 503 rather than panicking.
pub fn build_llm_http_client() -> Result<reqwest::Client, reqwest::Error> {
    reqwest::Client::builder()
        .timeout(UPSTREAM_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
}

pub(crate) const LLM_CHAT_PATH: &str = "/llm/chat/completions";
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(240);
const MAX_REQUEST_BODY_BYTES: usize = 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

/// OpenAI-compatible chat completion passthrough.
///
/// Body: any JSON OpenAI `chat.completions` request. The upstream URL + key
/// come from relay config; the client's `Authorization` header, if present, is
/// replaced. Upstream status + `content-type` are relayed with the body.
pub async fn chat_completions(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, (StatusCode, Json<serde_json::Value>)> {
    let Some(llm) = state.config.llm.as_ref() else {
        return Err(api_error(
            StatusCode::NOT_FOUND,
            "LLM gateway is not configured",
        ));
    };

    if body.len() > MAX_REQUEST_BODY_BYTES {
        return Err(api_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "LLM request body too large",
        ));
    }

    // NIP-98 auth: only relay members may use the gateway.
    let raw_host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let tenant = crate::tenant::bind_community(&state.db, raw_host)
        .await
        .map_err(|_| {
            api_error(
                StatusCode::NOT_FOUND,
                "relay: no community is configured for this host",
            )
        })?;
    let expected_url = bridge::nip98_expected_url(&state.config.relay_url, &tenant, LLM_CHAT_PATH);
    let bridge::VerifiedBridgeAuth {
        pubkey,
        event_id_bytes,
        signed_created_at,
    } = bridge::verify_bridge_auth_with_options(
        &headers,
        "POST",
        &expected_url,
        Some(&body),
        true,
        true,
    )?;
    bridge::enforce_http_admission(&state, &tenant, &pubkey).await?;
    bridge::check_nip98_replay(&state, &tenant, event_id_bytes).await?;
    relay_members::enforce_relay_membership(
        &state,
        tenant.community(),
        &pubkey.to_bytes(),
        relay_members::extract_auth_tag_header(&headers),
        signed_created_at,
    )
    .await?;

    // Metering: rate limit, then the caller's llm_calls budget (or the
    // operator's daily cap), then the community's daily total, then request
    // sanitising — all before any spend.
    enforce_llm_rate_limit(&state, &tenant, &pubkey, llm.rate_per_min()).await?;
    enforce_daily_caps(
        &state,
        &tenant,
        &pubkey.to_hex(),
        llm.max_calls_per_day(),
        llm.max_calls_per_day_total(),
    )
    .await?;
    // LLM spend budgets: refuse now if the caller is already at its limit, and
    // charge the real cost once the upstream reports it. With no price table a
    // cost budget cannot be metered, so refuse instead of running unmetered.
    let cost_meter =
        crate::handlers::budget_enforcement::begin_llm_cost(&state, &tenant, &pubkey.to_hex())
            .await
            .map_err(spend_error_response)?;
    let prices = llm.pricing();
    if cost_meter.is_some() && prices.is_none() {
        return Err(api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "an LLM spend budget applies, but this relay has no LLM prices configured \
             (BUZZ_LLM_PRICE_INPUT_CENTS_PER_MTOK / BUZZ_LLM_PRICE_OUTPUT_CENTS_PER_MTOK)",
        ));
    }
    let body = sanitize_request(&body, llm.max_tokens(), llm.model())?;
    let request_len = body.len();

    // Forward to the upstream, injecting the server-side key.
    let Some(client) = state.llm_http_client.as_ref() else {
        return Err(api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "LLM gateway HTTP client is unavailable",
        ));
    };
    tracing::info!(caller = %pubkey.to_hex(), bytes = body.len(), "LLM gateway call");
    let mut request = client
        .post(llm.proxy_url())
        .body(body)
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(key) = llm.api_key() {
        request = request.header(header::AUTHORIZATION, format!("Bearer {key}"));
    }
    let response = request
        .timeout(UPSTREAM_TIMEOUT)
        .send()
        .await
        .map_err(|error| {
            tracing::warn!(timeout = error.is_timeout(), "LLM upstream request failed");
            api_error(StatusCode::BAD_GATEWAY, "LLM provider is unavailable")
        })?;

    let upstream_status = response.status();
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/json")
        .to_string();
    let upstream_body = read_capped(response).await?;
    if upstream_status.is_client_error() || upstream_status.is_server_error() {
        let preview: String =
            String::from_utf8_lossy(&upstream_body[..upstream_body.len().min(400)]).into_owned();
        tracing::warn!(
            status = upstream_status.as_u16(),
            "LLM upstream error: {preview}"
        );
    }

    // Charge the call. Only a successful answer costs anything; the reported
    // `usage` is authoritative, and when an upstream omits it the request size
    // and the `max_tokens` cap give a conservative overestimate.
    if let (Some(meter), Some((price_in, price_out))) = (cost_meter.as_ref(), prices) {
        if upstream_status.is_success() {
            let cost = llm_cost_millicents(
                &upstream_body,
                request_len,
                llm.max_tokens(),
                price_in,
                price_out,
            );
            crate::handlers::budget_enforcement::record_llm_cost(&state, &tenant, meter, cost)
                .await
                .map_err(spend_error_response)?;
        }
    }

    Response::builder()
        .status(upstream_status)
        .header(header::CONTENT_TYPE, content_type)
        .body(axum::body::Body::from(upstream_body))
        .map_err(|_| {
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "response construction failed",
            )
        })
}

/// What one gateway call cost, in milli-cents (thousandths of a US cent).
///
/// Uses the upstream's `usage.prompt_tokens` / `usage.completion_tokens`. When
/// either is missing it falls back to a conservative estimate — the request
/// body length over three bytes per token for the prompt, and the `max_tokens`
/// cap for the completion — so an upstream that hides usage cannot make calls
/// free. Prices are milli-cents per million tokens; the result rounds up.
pub(crate) fn llm_cost_millicents(
    response: &[u8],
    request_len: usize,
    max_tokens_cap: u64,
    price_in: u64,
    price_out: u64,
) -> u64 {
    let usage = serde_json::from_slice::<serde_json::Value>(response)
        .ok()
        .and_then(|v| v.get("usage").cloned());
    let field = |name: &str| {
        usage
            .as_ref()
            .and_then(|u| u.get(name))
            .and_then(serde_json::Value::as_u64)
    };
    let prompt = field("prompt_tokens").unwrap_or((request_len as u64).div_ceil(3));
    let completion = field("completion_tokens").unwrap_or(max_tokens_cap);
    // Saturating: an upstream that reports absurd token counts must cost a lot,
    // never wrap or panic.
    let micro = u128::from(prompt)
        .saturating_mul(u128::from(price_in))
        .saturating_add(u128::from(completion).saturating_mul(u128::from(price_out)));
    u64::try_from(micro.div_ceil(1_000_000)).unwrap_or(u64::MAX)
}

/// Per-caller per-minute rate limit (`BUZZ_LLM_RATE_PER_MIN`).
async fn enforce_llm_rate_limit(
    state: &AppState,
    tenant: &buzz_core::TenantContext,
    pubkey: &nostr::PublicKey,
    limit_per_min: u64,
) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    match crate::admission::check_principal(
        state.admission_rate_limiter.as_ref(),
        tenant,
        pubkey,
        LimitType::LlmCalls,
        60,
        limit_per_min,
    )
    .await
    {
        Ok(()) => Ok(()),
        Err(crate::admission::AdmissionError::Exceeded { reset_in_secs }) => Err(refusal(
            StatusCode::TOO_MANY_REQUESTS,
            "ai_too_fast",
            too_fast_words(reset_in_secs),
            reset_in_secs,
        )),
        Err(crate::admission::AdmissionError::Unavailable) => Err(api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "The AI helper is not available right now. Try again in a minute, or write this yourself.",
        )),
    }
}

/// Counter the community's whole-day AI calls are added to. It is not an
/// account's counter: [`counter_limit`](crate::handlers::budget_enforcement::counter_limit)
/// reads no budget for this name, so only the operator's configured total binds it.
const COUNTER_LLM_CALLS_COMMUNITY: &str = "llm_calls_total";
/// The row the community's counter is kept under. Not a public key, so it can
/// never be an account's own row or carry a budget.
const COMMUNITY_COUNTER_SUBJECT: &str = "llm-community-total";
const DAY_SECS: u64 = 86_400;

/// Both daily call caps, the account's then the community's.
///
/// The account is checked first on purpose: a call refused because that
/// account is out of its own allowance must not use up one of the community's
/// calls, or one person hammering a closed door would drain it for everyone.
pub(crate) async fn enforce_daily_caps(
    state: &Arc<AppState>,
    tenant: &buzz_core::TenantContext,
    caller_pubkey_hex: &str,
    account_cap: u32,
    community_cap: u32,
) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    let now = chrono::Utc::now().timestamp();
    crate::handlers::budget_enforcement::enforce_llm_call(
        state,
        tenant,
        caller_pubkey_hex,
        account_cap,
    )
    .await
    .map_err(|error| account_cap_response(error, now))?;
    crate::handlers::budget_enforcement::enforce_counter_with_fallback(
        state,
        tenant,
        COMMUNITY_COUNTER_SUBJECT,
        COUNTER_LLM_CALLS_COMMUNITY,
        Some(crate::handlers::budget_enforcement::FallbackLimit {
            window: "day",
            limit: i64::from(community_cap),
        }),
    )
    .await
    .map_err(|error| community_cap_response(error, now))?;
    Ok(())
}

/// Seconds until the daily window rolls over. Windows are the fixed UTC days
/// the budget counters use (`unix / 86400`), so this is time to midnight UTC.
fn secs_until_next_day(now_unix: i64) -> u64 {
    let into_day = u64::try_from(now_unix.rem_euclid(DAY_SECS as i64)).unwrap_or(0);
    DAY_SECS - into_day
}

/// "at midnight UTC, in about 5 hours": when a daily limit comes back.
fn comes_back_words(retry_after_secs: u64) -> String {
    let hours = retry_after_secs.div_ceil(3600);
    match hours {
        0 | 1 => "at midnight UTC, within the hour".to_string(),
        n => format!("at midnight UTC, in about {n} hours"),
    }
}

fn too_fast_words(wait_secs: u64) -> String {
    format!(
        "You are asking the AI helper too quickly. Wait {} and try again.",
        match wait_secs {
            0 | 1 => "a second".to_string(),
            n => format!("{n} seconds"),
        }
    )
}

fn account_cap_words(retry_after_secs: u64) -> String {
    format!(
        "You have used all of today's AI help for your account. It comes back {}. \
         You can write this yourself in the meantime.",
        comes_back_words(retry_after_secs)
    )
}

/// A budget that asks a person before it refuses says so, and so do the words.
fn with_approval_note(words: String, message: &str) -> String {
    if message.contains("approval request") {
        format!("{words} A request for more has been sent to the people who set the limit.")
    } else {
        words
    }
}

fn community_cap_words(retry_after_secs: u64) -> String {
    format!(
        "The AI helper has reached today's limit for this whole server, so it is paused for \
         everyone. It comes back {}. You can write this yourself in the meantime.",
        comes_back_words(retry_after_secs)
    )
}

/// A 429 (or other refusal) with a plain-words `error`, a stable `code` and
/// the seconds until a retry can work.
fn refusal(
    status: StatusCode,
    code: &str,
    message: String,
    retry_after_secs: u64,
) -> (StatusCode, Json<serde_json::Value>) {
    (
        status,
        Json(serde_json::json!({
            "error": message,
            "code": code,
            "retry_after_secs": retry_after_secs,
        })),
    )
}

/// The account's own allowance ran out (its budget or the operator's per-account cap).
fn account_cap_response(
    error: crate::handlers::ingest::IngestError,
    now_unix: i64,
) -> (StatusCode, Json<serde_json::Value>) {
    use crate::handlers::ingest::IngestError;
    let retry = secs_until_next_day(now_unix);
    match error {
        IngestError::Rejected(message) if message.starts_with("budget exceeded: llm_calls") => {
            refusal(
                StatusCode::TOO_MANY_REQUESTS,
                "ai_limit_account",
                with_approval_note(account_cap_words(retry), &message),
                retry,
            )
        }
        other => ingest_error_response(other),
    }
}

/// The community's daily total ran out.
fn community_cap_response(
    error: crate::handlers::ingest::IngestError,
    now_unix: i64,
) -> (StatusCode, Json<serde_json::Value>) {
    use crate::handlers::ingest::IngestError;
    let retry = secs_until_next_day(now_unix);
    match error {
        IngestError::Rejected(message)
            if message.starts_with(&format!("budget exceeded: {COUNTER_LLM_CALLS_COMMUNITY}")) =>
        {
            refusal(
                StatusCode::TOO_MANY_REQUESTS,
                "ai_limit_community",
                community_cap_words(retry),
                retry,
            )
        }
        other => ingest_error_response(other),
    }
}

/// An AI spending limit (a budget with a cost) ran out.
fn spend_error_response(
    error: crate::handlers::ingest::IngestError,
) -> (StatusCode, Json<serde_json::Value>) {
    use crate::handlers::ingest::IngestError;
    match error {
        IngestError::Rejected(message)
            if message.starts_with("budget exceeded: LLM spend limit") =>
        {
            refusal(
                StatusCode::TOO_MANY_REQUESTS,
                "ai_limit_spend",
                with_approval_note(
                    "The AI spending limit set for your account is used up. Ask the person who \
                     set it to raise it, or write this yourself."
                        .to_string(),
                    &message,
                ),
                secs_until_next_day(chrono::Utc::now().timestamp()),
            )
        }
        other => ingest_error_response(other),
    }
}

/// Map a budget-enforcement rejection onto an HTTP answer: an exceeded budget
/// is a 429 carrying the relay's explanation (and, for `require-approval`
/// budgets, the approval request it created); anything else is a 500 that does
/// not leak internals.
fn ingest_error_response(
    error: crate::handlers::ingest::IngestError,
) -> (StatusCode, Json<serde_json::Value>) {
    use crate::handlers::ingest::IngestError;
    match error {
        IngestError::Rejected(message) | IngestError::AuthFailed(message) => {
            api_error(StatusCode::TOO_MANY_REQUESTS, &message)
        }
        IngestError::Internal(message) => {
            tracing::warn!("LLM gateway budget check failed: {message}");
            api_error(StatusCode::INTERNAL_SERVER_ERROR, "budget check failed")
        }
        IngestError::CanvasConflict(message) => api_error(StatusCode::CONFLICT, &message),
    }
}

/// Rewrite the caller's `chat.completions` body so it cannot exceed what the
/// operator agreed to pay for: `stream` is forced off, `max_tokens` is clamped
/// to `max_tokens_cap` (and defaulted to it when absent), and `model` is
/// replaced when the operator pinned one.
pub(crate) fn sanitize_request(
    body: &[u8],
    max_tokens_cap: u64,
    pinned_model: Option<&str>,
) -> Result<Bytes, (StatusCode, Json<serde_json::Value>)> {
    let mut value: serde_json::Value = serde_json::from_slice(body)
        .map_err(|_| api_error(StatusCode::BAD_REQUEST, "LLM request body must be JSON"))?;
    let Some(object) = value.as_object_mut() else {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "LLM request body must be a JSON object",
        ));
    };
    object.insert("stream".to_string(), serde_json::Value::Bool(false));
    let requested = object
        .get("max_tokens")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(max_tokens_cap);
    object.insert(
        "max_tokens".to_string(),
        serde_json::Value::from(requested.min(max_tokens_cap)),
    );
    // The newer field would bypass the clamp above on providers that honour it.
    object.remove("max_completion_tokens");
    if let Some(model) = pinned_model {
        object.insert(
            "model".to_string(),
            serde_json::Value::String(model.to_string()),
        );
    }
    serde_json::to_vec(&value)
        .map(Bytes::from)
        .map_err(|_| api_error(StatusCode::INTERNAL_SERVER_ERROR, "request rewrite failed"))
}

/// Read the upstream body without ever buffering more than
/// [`MAX_RESPONSE_BYTES`]: a declared oversize is rejected up front and a
/// chunked stream is cut off as soon as it crosses the cap.
async fn read_capped(
    mut response: reqwest::Response,
) -> Result<Vec<u8>, (StatusCode, Json<serde_json::Value>)> {
    let too_large = || api_error(StatusCode::BAD_GATEWAY, "LLM provider response too large");
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(too_large());
    }
    let mut buf = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if buf.len() + chunk.len() > MAX_RESPONSE_BYTES {
                    return Err(too_large());
                }
                buf.extend_from_slice(&chunk);
            }
            Ok(None) => return Ok(buf),
            Err(_) => {
                return Err(api_error(
                    StatusCode::BAD_GATEWAY,
                    "LLM provider returned an unreadable body",
                ))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cost_uses_the_reported_usage_and_rounds_up() {
        // 1,000 prompt tokens at 300 mc/Mtok + 500 completion at 1,500 mc/Mtok:
        // 1,000*300 + 500*1,500 = 1,050,000 micro-units → 1.05 → 2 (rounds up).
        let body = br#"{"usage":{"prompt_tokens":1000,"completion_tokens":500}}"#;
        assert_eq!(llm_cost_millicents(body, 10_000, 4096, 300, 1500), 2);
        // Exactly one milli-cent: no spurious round up.
        let body = br#"{"usage":{"prompt_tokens":1000,"completion_tokens":0}}"#;
        assert_eq!(llm_cost_millicents(body, 10_000, 4096, 1000, 1500), 1);
        // A free (unpriced) direction costs nothing.
        assert_eq!(llm_cost_millicents(body, 10_000, 4096, 0, 1500), 0);
    }

    #[test]
    fn cost_never_treats_missing_usage_as_free() {
        // No usage block: prompt ≈ request bytes / 3, completion = the cap.
        // 3,000 bytes → 1,000 tokens; 4,096 completion tokens.
        let cost = llm_cost_millicents(b"{}", 3000, 4096, 1_000_000, 1_000_000);
        assert_eq!(cost, 1000 + 4096);
        // Garbage or non-JSON upstream bodies are estimated the same way.
        assert_eq!(
            llm_cost_millicents(b"not json", 3000, 4096, 1_000_000, 1_000_000),
            cost
        );
        // A partial usage block falls back only for the missing side.
        let partial = br#"{"usage":{"prompt_tokens":10}}"#;
        assert_eq!(
            llm_cost_millicents(partial, 3000, 100, 1_000_000, 1_000_000),
            10 + 100
        );
    }

    #[test]
    fn cost_does_not_overflow_on_absurd_inputs() {
        let body = br#"{"usage":{"prompt_tokens":18446744073709551615,"completion_tokens":18446744073709551615}}"#;
        assert_eq!(
            llm_cost_millicents(body, 0, 0, u64::MAX, u64::MAX),
            u64::MAX
        );
    }

    fn rewritten(body: &str, cap: u64, model: Option<&str>) -> serde_json::Value {
        let out = sanitize_request(body.as_bytes(), cap, model).expect("sanitises");
        serde_json::from_slice(&out).expect("valid JSON")
    }

    #[test]
    fn max_tokens_is_clamped_and_defaulted() {
        assert_eq!(
            rewritten(r#"{"max_tokens": 999999}"#, 4096, None)["max_tokens"],
            4096
        );
        assert_eq!(
            rewritten(r#"{"max_tokens": 100}"#, 4096, None)["max_tokens"],
            100
        );
        assert_eq!(
            rewritten(r#"{"messages": []}"#, 4096, None)["max_tokens"],
            4096,
            "an absent max_tokens becomes the cap, never unbounded"
        );
    }

    #[test]
    fn streaming_is_forced_off_and_the_newer_token_field_is_dropped() {
        let v = rewritten(
            r#"{"stream": true, "max_completion_tokens": 1000000}"#,
            512,
            None,
        );
        assert_eq!(v["stream"], false);
        assert!(v.get("max_completion_tokens").is_none());
    }

    #[test]
    fn the_operator_model_overrides_the_callers() {
        assert_eq!(
            rewritten(r#"{"model": "expensive"}"#, 10, Some("cheap"))["model"],
            "cheap"
        );
        assert_eq!(rewritten(r#"{"model": "mine"}"#, 10, None)["model"], "mine");
    }

    #[test]
    fn a_daily_limit_says_when_it_comes_back() {
        // 19:00 UTC: five hours to midnight.
        let seven_pm = 19 * 3600;
        assert_eq!(secs_until_next_day(seven_pm), 5 * 3600);
        assert_eq!(
            secs_until_next_day(0),
            86_400,
            "a fresh day has all of it left"
        );
        assert_eq!(secs_until_next_day(86_399), 1);
        assert_eq!(
            comes_back_words(5 * 3600),
            "at midnight UTC, in about 5 hours"
        );
        assert_eq!(
            comes_back_words(5 * 3600 - 1),
            "at midnight UTC, in about 5 hours",
            "partial hours round up, never down to a promise of sooner"
        );
        assert_eq!(comes_back_words(90), "at midnight UTC, within the hour");
    }

    #[test]
    fn the_refusals_are_plain_words_with_a_code() {
        use crate::handlers::ingest::IngestError;
        let now = 19 * 3600;
        let account = account_cap_response(
            IngestError::Rejected("budget exceeded: llm_calls limit 500 reached".into()),
            now,
        );
        assert_eq!(account.0, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(account.1 .0["code"], "ai_limit_account");
        assert_eq!(account.1 .0["retry_after_secs"], 5 * 3600);
        let words = account.1 .0["error"].as_str().expect("words");
        assert!(words.contains("your account") && words.contains("write this yourself"));
        assert!(
            !words.contains("llm_calls") && !words.contains("budget"),
            "no internal names in what a person reads: {words}"
        );

        let community = community_cap_response(
            IngestError::Rejected("budget exceeded: llm_calls_total limit 2000 reached".into()),
            now,
        );
        assert_eq!(community.1 .0["code"], "ai_limit_community");
        let words = community.1 .0["error"].as_str().expect("words");
        assert!(
            words.contains("whole server") && words.contains("everyone"),
            "{words}"
        );
        assert!(!words.contains("llm_calls"), "{words}");

        let spend = spend_error_response(IngestError::Rejected(
            "budget exceeded: LLM spend limit of 5 cents reached".into(),
        ));
        assert_eq!(spend.1 .0["code"], "ai_limit_spend");

        // A budget that asks a person first says a request was sent.
        let asked = account_cap_response(
            IngestError::Rejected(
                "budget exceeded: llm_calls limit 3 reached — a budget approval request was recorded; it must be granted before this action can proceed".into(),
            ),
            now,
        );
        assert!(asked.1 .0["error"]
            .as_str()
            .expect("words")
            .contains("A request for more has been sent"));

        // Anything else keeps its own status: a database fault is not "you ran out".
        let broken = account_cap_response(IngestError::Internal("db down".into()), now);
        assert_eq!(broken.0, StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[test]
    fn asking_too_fast_names_the_wait() {
        assert_eq!(
            too_fast_words(12),
            "You are asking the AI helper too quickly. Wait 12 seconds and try again."
        );
        assert!(too_fast_words(0).contains("a second"));
    }

    /// The caps through the real counters. Needs Postgres:
    /// `cargo test -p buzz-relay --lib -- llm_gateway -- --ignored`.
    mod postgres_tests {
        use super::super::*;
        use uuid::Uuid;

        const ALICE: &str = "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1";
        const BOB: &str = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";

        async fn world() -> (Arc<AppState>, buzz_core::TenantContext) {
            let state = crate::test_support::test_state().await;
            let host = format!("ai-cap-{}.example", Uuid::new_v4().simple());
            let community = state
                .db
                .ensure_configured_community(&host)
                .await
                .expect("create community")
                .id;
            (state, buzz_core::TenantContext::resolved(community, host))
        }

        fn code(refused: &(StatusCode, Json<serde_json::Value>)) -> String {
            refused.1 .0["code"].as_str().unwrap_or("").to_string()
        }

        #[tokio::test]
        #[ignore = "requires Postgres and Redis"]
        async fn the_whole_community_stops_at_its_daily_total_whoever_asks() {
            let (state, tenant) = world().await;
            // Each account may make 5 calls; the community only 3 in all.
            enforce_daily_caps(&state, &tenant, ALICE, 5, 3)
                .await
                .expect("1");
            enforce_daily_caps(&state, &tenant, ALICE, 5, 3)
                .await
                .expect("2");
            enforce_daily_caps(&state, &tenant, BOB, 5, 3)
                .await
                .expect("3");
            for who in [ALICE, BOB] {
                let refused = enforce_daily_caps(&state, &tenant, who, 5, 3)
                    .await
                    .expect_err("the community total is used up for everyone");
                assert_eq!(refused.0, StatusCode::TOO_MANY_REQUESTS);
                assert_eq!(code(&refused), "ai_limit_community");
                assert!(refused.1 .0["retry_after_secs"].as_u64().unwrap_or(0) > 0);
            }
        }

        #[tokio::test]
        #[ignore = "requires Postgres and Redis"]
        async fn one_account_at_its_own_cap_does_not_use_up_the_communitys_calls() {
            let (state, tenant) = world().await;
            // Each account may make 1 call; the community 2 in all.
            enforce_daily_caps(&state, &tenant, ALICE, 1, 2)
                .await
                .expect("alice 1");
            for _ in 0..4 {
                let refused = enforce_daily_caps(&state, &tenant, ALICE, 1, 2)
                    .await
                    .expect_err("alice is out of her own allowance");
                assert_eq!(code(&refused), "ai_limit_account");
            }
            // Four refused tries later the community still has its second call.
            enforce_daily_caps(&state, &tenant, BOB, 1, 2)
                .await
                .expect("a refused account must not burn the community's calls");
            let refused = enforce_daily_caps(&state, &tenant, BOB, 1, 2)
                .await
                .expect_err("bob is now at his own cap");
            assert_eq!(code(&refused), "ai_limit_account");
        }

        /// The whole route, as the web app calls it: a signed request in, a fake
        /// provider behind. Once the community's total is used up the answer is
        /// a 429 in plain words, and the provider is never asked again.
        #[tokio::test]
        #[ignore = "requires Postgres and Redis"]
        async fn the_route_refuses_in_plain_words_and_stops_calling_the_provider() {
            use axum::body::Body;
            use axum::http::Request;
            use base64::Engine;
            use nostr::{EventBuilder, Keys, Kind, Tag, TagKind};
            use sha2::{Digest, Sha256};
            use std::sync::atomic::{AtomicUsize, Ordering};
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            use tower::ServiceExt;

            // A provider that answers every call and counts them.
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                .await
                .expect("bind provider");
            let provider = format!(
                "http://{}/v1/chat/completions",
                listener.local_addr().unwrap()
            );
            let calls = Arc::new(AtomicUsize::new(0));
            let seen = calls.clone();
            tokio::spawn(async move {
                loop {
                    let Ok((mut socket, _)) = listener.accept().await else {
                        return;
                    };
                    seen.fetch_add(1, Ordering::SeqCst);
                    tokio::spawn(async move {
                        let mut buffer = vec![0u8; 16 * 1024];
                        let _ = socket.read(&mut buffer).await;
                        let body = r#"{"choices":[{"message":{"content":"a draft"}}],"usage":{"prompt_tokens":3,"completion_tokens":2}}"#;
                        let reply = format!(
                            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                            body.len()
                        );
                        let _ = socket.write_all(reply.as_bytes()).await;
                    });
                }
            });

            let state = crate::test_support::test_state_with(move |config| {
                config.llm = Some(crate::config::LlmConfig::for_test(provider, 100, 2));
            })
            .await;
            let host = format!("ai-route-{}.example", Uuid::new_v4().simple());
            state
                .db
                .ensure_configured_community(&host)
                .await
                .expect("community");

            let ask = |who: Keys, n: usize| {
                let state = state.clone();
                let host = host.clone();
                async move {
                    let body = format!(r#"{{"messages":[{{"role":"user","content":"hi {n}"}}]}}"#);
                    let url = format!("https://{host}{LLM_CHAT_PATH}");
                    let payload = hex::encode(Sha256::digest(body.as_bytes()));
                    let auth = EventBuilder::new(Kind::HttpAuth, "")
                        .tags([
                            Tag::parse(["u", url.as_str()]).unwrap(),
                            Tag::parse(["method", "POST"]).unwrap(),
                            Tag::parse(["payload", payload.as_str()]).unwrap(),
                            Tag::custom(TagKind::custom("nonce"), [Uuid::new_v4().to_string()]),
                        ])
                        .sign_with_keys(&who)
                        .expect("sign");
                    let header = format!(
                        "Nostr {}",
                        base64::engine::general_purpose::STANDARD
                            .encode(serde_json::to_string(&auth).expect("json"))
                    );
                    let response = crate::router::build_router(state)
                        .oneshot(
                            Request::post(LLM_CHAT_PATH)
                                .header(header::HOST, host)
                                .header(header::CONTENT_TYPE, "application/json")
                                .header(header::AUTHORIZATION, header)
                                .body(Body::from(body))
                                .expect("request"),
                        )
                        .await
                        .expect("response");
                    let status = response.status();
                    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
                        .await
                        .expect("body");
                    (
                        status,
                        serde_json::from_slice::<serde_json::Value>(&bytes).unwrap_or_default(),
                    )
                }
            };

            let (alice, bob) = (Keys::generate(), Keys::generate());
            let (status, _) = ask(alice.clone(), 1).await;
            assert_eq!(status, StatusCode::OK, "the first call goes through");
            let (status, _) = ask(bob.clone(), 2).await;
            assert_eq!(status, StatusCode::OK, "so does a second account's");
            assert_eq!(calls.load(Ordering::SeqCst), 2);

            for (who, n) in [(alice, 3), (bob, 4)] {
                let (status, body) = ask(who, n).await;
                assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
                assert_eq!(body["code"], "ai_limit_community");
                let words = body["error"].as_str().expect("words");
                assert!(
                    words.contains("whole server") && words.contains("write this yourself"),
                    "{words}"
                );
                assert!(body["retry_after_secs"].as_u64().unwrap_or(0) > 0);
            }
            assert_eq!(
                calls.load(Ordering::SeqCst),
                2,
                "a refused call must never reach the provider"
            );
        }

        #[tokio::test]
        #[ignore = "requires Postgres and Redis"]
        async fn one_communitys_total_is_not_anothers() {
            let (state, one) = world().await;
            let (_, two) = world().await;
            enforce_daily_caps(&state, &one, ALICE, 5, 1)
                .await
                .expect("one");
            assert_eq!(
                code(
                    &enforce_daily_caps(&state, &one, ALICE, 5, 1)
                        .await
                        .expect_err("full")
                ),
                "ai_limit_community"
            );
            enforce_daily_caps(&state, &two, ALICE, 5, 1)
                .await
                .expect("another community has its own total");
        }
    }

    #[test]
    fn non_object_or_non_json_bodies_are_rejected() {
        for body in ["not json", "[1,2]", "\"x\""] {
            let err = sanitize_request(body.as_bytes(), 10, None).unwrap_err();
            assert_eq!(err.0, StatusCode::BAD_REQUEST, "{body}");
        }
    }
}
