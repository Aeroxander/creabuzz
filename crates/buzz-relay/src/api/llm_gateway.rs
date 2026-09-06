//! Relay-owned LLM gateway for browser agents.
//!
//! Browser agents cannot carry API keys and cannot call arbitrary hosts
//! through CORS. These narrow endpoints let client code send an
//! OpenAI-compatible `/chat/completions` payload to the relay; the relay
//! injects the operator's upstream URL + bearer key and relays the response.
//! The key never leaves the relay host, and only NIP-98-authenticated fleet
//! members can use the gateway (same auth as `/query`).

use std::sync::Arc;
use std::time::Duration;

use axum::{
    body::Bytes,
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::{Json, Response},
};

use crate::state::AppState;

use super::{api_error, bridge, relay_members};

/// Dedicated upstream client. Redirects disabled: a provider 3xx must never
/// replay a key-bearing request to an attacker-chosen host.
pub fn build_llm_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(UPSTREAM_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("static LLM HTTP client configuration")
}

pub(crate) const LLM_CHAT_PATH: &str = "/llm/chat/completions";
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(240);
const MAX_REQUEST_BODY_BYTES: usize = 1 * 1024 * 1024;
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
        return Err(api_error(StatusCode::NOT_FOUND, "LLM gateway is not configured"));
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

    // Forward to the upstream, injecting the server-side key.
    let client = build_llm_http_client();
    let mut request = client
        .post(llm.proxy_url())
        .body(body)
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(key) = llm.api_key() {
        request = request.header(
            header::AUTHORIZATION,
            format!("Bearer {key}"),
        );
    }
    let response = request.timeout(UPSTREAM_TIMEOUT).send().await.map_err(|error| {
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
    let upstream_body = response.bytes().await.map_err(|_| {
        api_error(StatusCode::BAD_GATEWAY, "LLM provider returned an unreadable body")
    })?;
    if upstream_body.len() > MAX_RESPONSE_BYTES {
        return Err(api_error(StatusCode::BAD_GATEWAY, "LLM provider response too large"));
    }

    Ok(Response::builder()
        .status(upstream_status)
        .header(header::CONTENT_TYPE, content_type)
        .body(axum::body::Body::from(upstream_body))
        .map_err(|_| api_error(StatusCode::INTERNAL_SERVER_ERROR, "response construction failed"))?)
}
