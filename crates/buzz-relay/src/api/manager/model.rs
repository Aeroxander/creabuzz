//! The model behind the manager: one seam, so the honesty envelope and the route are tested with a fake that obeys every
//! planted instruction, and the server calls the operator's OpenAI-compatible service through the same gateway client
//! (pinned model, clamped tokens, no redirects, the key from configuration only).

use async_trait::async_trait;
use axum::http::header;

use crate::config::LlmConfig;

/// The longest reply a draft may ask for, in tokens: three short parts of JSON.
pub(crate) const MAX_DRAFT_TOKENS: u64 = 800;

/// What one call answered and cost.
#[derive(Debug)]
pub(crate) struct ModelReply {
    pub(crate) text: String,
    /// What the call cost in milli-cents (0 when the service has no prices set).
    pub(crate) cost_mc: u64,
}

/// Why a call gave no reply.
#[derive(Debug)]
pub(crate) enum ModelError {
    /// The service did not answer, or answered with an error.
    Unavailable,
}

/// A model that drafts from a prompt.
#[async_trait]
pub(crate) trait ManagerModel: Send + Sync {
    async fn draft(&self, system: &str, user: &str) -> Result<ModelReply, ModelError>;
}

/// The operator's service, through the relay's gateway client.
pub(crate) struct HostedModel<'a> {
    pub(crate) client: &'a reqwest::Client,
    pub(crate) config: &'a LlmConfig,
}

#[async_trait]
impl ManagerModel for HostedModel<'_> {
    async fn draft(&self, system: &str, user: &str) -> Result<ModelReply, ModelError> {
        let max_tokens = MAX_DRAFT_TOKENS.min(self.config.max_tokens());
        let mut body = serde_json::json!({
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": user },
            ],
            "max_tokens": max_tokens,
            "temperature": 0,
            "stream": false,
        });
        if let Some(model) = self.config.model() {
            body["model"] = serde_json::Value::String(model.to_string());
        }
        let bytes = serde_json::to_vec(&body).map_err(|_| ModelError::Unavailable)?;
        let request_len = bytes.len();
        let mut request = self
            .client
            .post(self.config.proxy_url())
            .header(header::CONTENT_TYPE, "application/json")
            .body(bytes);
        if let Some(key) = self.config.api_key() {
            request = request.header(header::AUTHORIZATION, format!("Bearer {key}"));
        }
        let response = request.send().await.map_err(|error| {
            tracing::warn!(
                timeout = error.is_timeout(),
                "manager: AI service did not answer"
            );
            ModelError::Unavailable
        })?;
        if !response.status().is_success() {
            tracing::warn!(
                status = response.status().as_u16(),
                "manager: AI service refused"
            );
            return Err(ModelError::Unavailable);
        }
        let raw = response
            .bytes()
            .await
            .map_err(|_| ModelError::Unavailable)?;
        if raw.len() > 1 << 20 {
            return Err(ModelError::Unavailable);
        }
        let cost_mc = self
            .config
            .pricing()
            .map(|(price_in, price_out)| {
                crate::api::llm_gateway::llm_cost_millicents(
                    &raw,
                    request_len,
                    max_tokens,
                    price_in,
                    price_out,
                )
            })
            .unwrap_or(0);
        let text = serde_json::from_slice::<serde_json::Value>(&raw)
            .ok()
            .and_then(|v| {
                v.pointer("/choices/0/message/content")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string)
            })
            .ok_or(ModelError::Unavailable)?;
        Ok(ModelReply { text, cost_mc })
    }
}

/// The most a draft can cost, in milli-cents: the whole prompt and every token it may write, at the set prices.
pub(crate) fn worst_cost(config: &LlmConfig, prompt_len: usize) -> Option<u64> {
    let (price_in, price_out) = config.pricing()?;
    let max_tokens = MAX_DRAFT_TOKENS.min(config.max_tokens());
    Some(crate::api::llm_gateway::llm_cost_millicents(
        b"{}", prompt_len, max_tokens, price_in, price_out,
    ))
}
