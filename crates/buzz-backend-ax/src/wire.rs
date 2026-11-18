//! The stdin/stdout JSON protocol (spec `docs/remote-agents.md` §Provider
//! Protocol). One process per operation: one JSON object in, one JSON object
//! out. Same contract shape as `buzz-backend-kubernetes`; the desktop is the
//! arbiter of the wire, so this file mirrors that provider's `wire.rs`.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// The wire-contract version this provider speaks (spec §Info).
pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum Request {
    Info,
    Deploy(Box<DeployRequest>),
}

#[derive(Debug, Deserialize)]
pub struct DeployRequest {
    pub agent: AgentPayload,
    #[serde(default)]
    pub provider_config: serde_json::Value,
}

#[derive(Debug, Deserialize)]
pub struct AgentPayload {
    pub relay_url: String,
    pub private_key_nsec: String,
    #[serde(default)]
    pub auth_tag: Option<String>,
    #[serde(default)]
    pub respond_to: Option<String>,
    #[serde(default)]
    pub respond_to_allowlist: Option<Vec<String>>,
    #[serde(default)]
    pub env_vars: BTreeMap<String, String>,
    #[serde(default)]
    pub launch: Option<LaunchBlock>,
}

#[derive(Debug, Default, Deserialize)]
pub struct LaunchBlock {
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub policy_env: BTreeMap<String, String>,
    #[serde(default)]
    pub owner_pubkey: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum Response {
    Info(InfoResponse),
    Deploy(DeployResponse),
    Error(ErrorResponse),
}

#[derive(Debug, Serialize)]
pub struct InfoResponse {
    pub ok: bool,
    pub name: &'static str,
    pub version: &'static str,
    pub protocol_version: u32,
    pub description: &'static str,
    pub config_schema: serde_json::Value,
}

#[derive(Debug, Serialize)]
pub struct DeployResponse {
    pub ok: bool,
    pub agent_id: String,
}

#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub ok: bool,
    pub error: String,
}

impl Response {
    pub fn error(message: impl Into<String>) -> Self {
        Response::Error(ErrorResponse {
            ok: false,
            error: message.into(),
        })
    }

    /// Pure — no cluster or `ax` CLI contact — because the desktop calls it
    /// to render the config form before any control plane is known to exist.
    pub fn info() -> Self {
        Response::Info(InfoResponse {
            ok: true,
            name: "ax",
            version: env!("CARGO_PKG_VERSION"),
            protocol_version: PROTOCOL_VERSION,
            description:
                "Runs agents as AX Tasks (Agent Substrate sandboxes) with an egress Gateway",
            config_schema: crate::config::config_schema(),
        })
    }

    pub fn deployed(agent_id: impl Into<String>) -> Self {
        Response::Deploy(DeployResponse {
            ok: true,
            agent_id: agent_id.into(),
        })
    }
}
