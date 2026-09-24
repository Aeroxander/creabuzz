//! Shared LLM transport for the Agent Wiki distill loop.
//!
//! Both hosts (CLI and relay) call the same OpenAI-compatible classifier
//! endpoint contract — request shape, timeout, temperature, and the one-shot
//! 429 back-off live here so the two surfaces cannot drift. Hosts map
//! [`LlmError`] onto their own error types (the CLI keeps its `Network`
//! error-code fidelity).
//!
//! Configuration reuses the contribution-classifier env vars (no config
//! sprawl): `BUZZ_CLASSIFIER_API_URL`, `BUZZ_CLASSIFIER_API_KEY` (both
//! required — fail closed, no silent local fallback),
//! `BUZZ_CLASSIFIER_MODEL` (default [`DEFAULT_CLASSIFIER_MODEL`]).

use crate::{truncate, AGWIKI_429_BACKOFF, AGWIKI_TEMPERATURE};

/// Environment variable: OpenAI-compatible classifier base URL.
pub const ENV_CLASSIFIER_API_URL: &str = "BUZZ_CLASSIFIER_API_URL";
/// Environment variable: classifier API key.
pub const ENV_CLASSIFIER_API_KEY: &str = "BUZZ_CLASSIFIER_API_KEY";
/// Environment variable: classifier model id.
pub const ENV_CLASSIFIER_MODEL: &str = "BUZZ_CLASSIFIER_MODEL";
/// Default classifier model used when [`ENV_CLASSIFIER_MODEL`] is unset.
pub const DEFAULT_CLASSIFIER_MODEL: &str = "deepseek-v4-flash-0731";

/// Resolved LLM endpoint configuration.
#[derive(Debug, Clone, PartialEq)]
pub struct LlmTarget {
    /// OpenAI-compatible base URL (no trailing `/chat/completions`).
    pub api_url: String,
    /// API key sent as a bearer token.
    pub api_key: String,
    /// Model id sent in the request body (also recorded in page provenance).
    pub model: String,
}

/// Failures from one chat-completion call.
#[derive(Debug, thiserror::Error)]
pub enum LlmError {
    /// Transport-level failure (connect, timeout, DNS). Hosts map this to
    /// their typed network error so error codes stay faithful.
    #[error(transparent)]
    Http(#[from] reqwest::Error),
    /// Endpoint answered, but unusably (non-2xx, non-JSON, or persistently
    /// rate-limited). The message is rendered for direct user display.
    #[error("{0}")]
    Message(String),
}

/// Read the LLM target through a provider function (injectable for tests).
///
/// The API URL and API key are mandatory — missing either is a hard error
/// (no silent local fallback). The model defaults to
/// [`DEFAULT_CLASSIFIER_MODEL`].
pub fn classifier_target_from_provider(
    get: impl Fn(&str) -> Option<String>,
) -> Result<LlmTarget, String> {
    // Whitespace-only values are as good as missing (trim, then filter empties).
    let get_trimmed = |name: &str| {
        get(name)
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    let api_url = get_trimmed(ENV_CLASSIFIER_API_URL).ok_or_else(|| {
        format!("{ENV_CLASSIFIER_API_URL} is required (OpenAI-compatible classifier base URL)")
    })?;
    let api_key = get_trimmed(ENV_CLASSIFIER_API_KEY).ok_or_else(|| {
        format!("{ENV_CLASSIFIER_API_KEY} is required; classify fails closed without it")
    })?;
    let model =
        get_trimmed(ENV_CLASSIFIER_MODEL).unwrap_or_else(|| DEFAULT_CLASSIFIER_MODEL.to_string());
    Ok(LlmTarget {
        api_url,
        api_key,
        model,
    })
}

/// Read the LLM target from the process environment (fail-closed).
pub fn classifier_target_from_env() -> Result<LlmTarget, String> {
    classifier_target_from_provider(|name| std::env::var(name).ok().filter(|v| !v.is_empty()))
}

/// One HTTP round trip to `{api_url}/chat/completions` with 429 back-off.
///
/// `http` is supplied by the caller so the caller owns client construction
/// (and its failure message). On HTTP 429 the call backs off once and
/// retries; a persistently rate-limited endpoint fails loudly.
pub async fn chat_completion(
    http: &reqwest::Client,
    target: &LlmTarget,
    system: &str,
    user: &str,
    max_tokens: u32,
) -> Result<serde_json::Value, LlmError> {
    let url = format!("{}/chat/completions", target.api_url.trim_end_matches('/'));
    let body = serde_json::json!({
        "model": target.model,
        "temperature": AGWIKI_TEMPERATURE,
        "max_tokens": max_tokens,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user },
        ],
    });
    for attempt in 0..2 {
        let resp = http
            .post(&url)
            .bearer_auth(&target.api_key)
            .json(&body)
            .send()
            .await?;
        let status = resp.status();
        let text = resp.text().await?;
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS && attempt == 0 {
            // Back off once, then fail loudly if the endpoint stays limited.
            tokio::time::sleep(AGWIKI_429_BACKOFF).await;
            continue;
        }
        if !status.is_success() {
            return Err(LlmError::Message(format!(
                "agent wiki API error {status}: {}",
                truncate(&text, 400)
            )));
        }
        return serde_json::from_str(&text)
            .map_err(|e| LlmError::Message(format!("agent wiki returned non-JSON: {e}")));
    }
    Err(LlmError::Message(
        "agent wiki endpoint stayed rate-limited (429) after one retry".to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifier_target_fails_closed_without_url_or_key() {
        let missing_url = classifier_target_from_provider(|name| {
            (name == ENV_CLASSIFIER_API_KEY).then(|| "k".to_string())
        });
        let err = missing_url.unwrap_err();
        assert!(err.contains(ENV_CLASSIFIER_API_URL), "got: {err}");

        let missing_key = classifier_target_from_provider(|name| {
            (name == ENV_CLASSIFIER_API_URL).then(|| "http://x".to_string())
        });
        let err = missing_key.unwrap_err();
        assert!(err.contains(ENV_CLASSIFIER_API_KEY), "got: {err}");

        // Whitespace-only values are treated as missing (fail closed).
        let blank_key = classifier_target_from_provider(|name| match name {
            ENV_CLASSIFIER_API_URL => Some("http://x".to_string()),
            ENV_CLASSIFIER_API_KEY => Some("   ".to_string()),
            _ => None,
        });
        assert!(blank_key.is_err());

        let ok = classifier_target_from_provider(|name| match name {
            ENV_CLASSIFIER_API_URL => Some("http://x".to_string()),
            ENV_CLASSIFIER_API_KEY => Some("k".to_string()),
            _ => None,
        });
        let target = ok.expect("target resolves");
        assert_eq!(target.model, DEFAULT_CLASSIFIER_MODEL);
    }
}
