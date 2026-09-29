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
//! back to a daily operator cap when no budget covers them), a clamped
//! `max_tokens`, an operator-pinned `model`, forced non-streaming responses, and
//! a hard cap on the upstream body the relay will buffer.

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
    // operator's daily cap), then request sanitising — all before any spend.
    enforce_llm_rate_limit(&state, &tenant, &pubkey, llm.rate_per_min()).await?;
    crate::handlers::budget_enforcement::enforce_llm_call(
        &state,
        &tenant,
        &pubkey.to_hex(),
        llm.max_calls_per_day(),
    )
    .await
    .map_err(ingest_error_response)?;
    let body = sanitize_request(&body, llm.max_tokens(), llm.model())?;

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
        Err(crate::admission::AdmissionError::Exceeded { reset_in_secs }) => Err(api_error(
            StatusCode::TOO_MANY_REQUESTS,
            &format!("rate-limited: LLM quota exceeded; retry in {reset_in_secs}s"),
        )),
        Err(crate::admission::AdmissionError::Unavailable) => Err(api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "rate-limited: LLM admission unavailable",
        )),
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
    fn non_object_or_non_json_bodies_are_rejected() {
        for body in ["not json", "[1,2]", "\"x\""] {
            let err = sanitize_request(body.as_bytes(), 10, None).unwrap_err();
            assert_eq!(err.0, StatusCode::BAD_REQUEST, "{body}");
        }
    }
}
