//! JSON-RPC transport for the allowance guard.
//!
//! A single generic `call` keeps the trait minimal; the client maps methods
//! onto it. Every round-trip is bounded by an explicit timeout passed in by
//! the caller (the client's configured ceiling), so a stalled node can only
//! delay a decision by that much — never hang the spend path.

use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::error::AllowanceError;

/// The RPC surface the allowance guard needs.
#[async_trait]
pub trait EvmRpc: Send + Sync {
    /// Issue one JSON-RPC call and return its `result` value.
    ///
    /// `method` names the RPC method (also used in error reporting); the
    /// caller supplies the per-call timeout so every transport path is
    /// bounded by construction.
    async fn call(
        &self,
        method: &'static str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, AllowanceError>;
}

/// HTTP JSON-RPC transport for a bare node URL (e.g. an anvil dev chain at
/// `http://127.0.0.1:8545`).
pub struct HttpEvmRpc {
    client: reqwest::Client,
    url: String,
}

impl HttpEvmRpc {
    /// Build a transport. The connection phase is bounded at 2s here; the
    /// per-call ceiling is enforced by [`EvmRpc::call`].
    pub fn new(url: impl Into<String>) -> Result<Self, AllowanceError> {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(2))
            .build()
            .map_err(|e| AllowanceError::Rpc {
                method: "client_build",
                detail: format!("http client build failed: {e}"),
            })?;
        Ok(Self {
            client,
            url: url.into(),
        })
    }
}

#[async_trait]
impl EvmRpc for HttpEvmRpc {
    async fn call(
        &self,
        method: &'static str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, AllowanceError> {
        let body = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params,
        });
        let send = self.client.post(&self.url).json(&body).send();
        let resp = tokio::time::timeout(timeout, send)
            .await
            .map_err(|_| AllowanceError::Timeout {
                method,
                timeout_ms: timeout.as_millis() as u64,
            })?
            .map_err(|e| AllowanceError::Rpc {
                method,
                detail: format!("transport: {e}"),
            })?;
        let parsed: Value = tokio::time::timeout(timeout, resp.json())
            .await
            .map_err(|_| AllowanceError::Timeout {
                method,
                timeout_ms: timeout.as_millis() as u64,
            })?
            .map_err(|e| AllowanceError::Rpc {
                method,
                detail: format!("bad response body: {e}"),
            })?;
        if let Some(err) = parsed.get("error") {
            return Err(AllowanceError::Rpc {
                method,
                detail: err.to_string(),
            });
        }
        parsed
            .get("result")
            .cloned()
            .ok_or_else(|| AllowanceError::Rpc {
                method,
                detail: "response missing result".into(),
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_build_is_fallible_not_panic() {
        // Any URL is fine at build time; the point is that construction is
        // fallible and reported, never unwrapped.
        assert!(HttpEvmRpc::new("http://127.0.0.1:8545").is_ok());
    }
}
