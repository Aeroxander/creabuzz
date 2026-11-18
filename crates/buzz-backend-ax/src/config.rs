//! `provider_config` parsing and the UI config schema (spec §Info, §I2).
//!
//! I2 (no secrets in configuration) is enforced upstream by the desktop's
//! validator; this provider adds its own fail-closed rules:
//!
//! - `egress_allowlist` is REQUIRED and non-empty. AX defaults to allow-all
//!   egress when a Task carries no Gateway, and applies policy
//!   warn-and-continue on failure (upstream `reconciler.go`); this provider
//!   therefore always emits an explicit Gateway and refuses to deploy
//!   without one. The allowlist is the tool-boundary in miniature: the
//!   sandbox reaches the relay and the model API, nothing else.
//! - `image` is REQUIRED and must be digest-pinned — this Task holds the
//!   agent's identity env (residual exposure documented in
//!   docs/backend-ax.md §Secrets).

use serde::Deserialize;

/// Parsed provider configuration.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AxConfig {
    /// AX control-plane address. Empty/absent = let the `ax` CLI resolve it
    /// from the ambient kube context (its `ax ctx` behavior).
    #[serde(default)]
    pub ax_server: Option<String>,
    /// AX atespace to deploy into (one deployment scope per I4).
    #[serde(default = "default_atespace")]
    pub atespace: String,
    /// Digest-pinned runner image (sprig-based, buzz-acp runtime ABI).
    pub image: String,
    /// Egress allowlist as `host:port` host rules. REQUIRED, non-empty.
    pub egress_allowlist: Vec<String>,
    /// Task command entrypoint override. Defaults to the runner image's own
    /// entrypoint (buzz-acp launched by the image's bootstrap).
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default = "default_cpu_request")]
    pub cpu_request: String,
    #[serde(default = "default_memory_request")]
    pub memory_request: String,
    #[serde(default = "default_cpu_limit")]
    pub cpu_limit: String,
    #[serde(default = "default_memory_limit")]
    pub memory_limit: String,
    /// Idle self-termination bound (seconds) — I5's timer.
    #[serde(default = "default_inactivity")]
    pub inactivity_seconds: u64,
    /// AX `spec.debug` — serves guest services (arbitrary exec into the
    /// sandbox). Off by default; debug is an operator diagnostic, never the
    /// production tool boundary.
    #[serde(default)]
    pub debug: bool,
}

fn default_atespace() -> String {
    "default".to_string()
}
fn default_cpu_request() -> String {
    "500m".to_string()
}
fn default_memory_request() -> String {
    "1Gi".to_string()
}
fn default_cpu_limit() -> String {
    "2".to_string()
}
fn default_memory_limit() -> String {
    "4Gi".to_string()
}
fn default_inactivity() -> u64 {
    // Mirrors the Kubernetes binding's default idle bound (docs/remote-agents.md §Auto-Stop).
    15 * 60
}

impl AxConfig {
    pub fn parse(value: &serde_json::Value) -> Result<Self, String> {
        let cfg: AxConfig = serde_json::from_value(value.clone())
            .map_err(|e| format!("invalid provider_config: {e}"))?;
        if cfg.egress_allowlist.is_empty() {
            return Err(
                "egress_allowlist is required and must be non-empty: a Task without an                  explicit Gateway gets allow-all egress from AX"
                    .into(),
            );
        }
        for host in &cfg.egress_allowlist {
            if host.trim().is_empty() {
                return Err("egress_allowlist entries must be non-empty host[:port] rules".into());
            }
        }
        if !cfg.image.contains("@sha256:") {
            return Err(
                "image must be digest-pinned (name@sha256:...): this Task carries the \
                 agent's identity environment"
                    .into(),
            );
        }
        if cfg.atespace.trim().is_empty() {
            return Err("atespace must be non-empty".into());
        }
        Ok(cfg)
    }
}

/// The UI config form (spec §Info — `config_schema`).
pub fn config_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "ax_server": {
                "type": "string",
                "title": "AX control plane address",
                "description": "gRPC address of the ax-server control plane. Leave empty to let the ax CLI resolve it from your kube context."
            },
            "atespace": {
                "type": "string",
                "title": "AX atespace",
                "description": "Deployment scope. One live Task per agent key per atespace.",
                "default": "default"
            },
            "image": {
                "type": "string",
                "title": "Runner image",
                "description": "Digest-pinned image with the buzz-acp runtime ABI and an ax-task-runner entrypoint, e.g. ghcr.io/block/buzz-sprig@sha256:<digest>.",
                "default": ""
            },
            "egress_allowlist": {
                "type": "array",
                "items": { "type": "string" },
                "title": "Egress allowlist (host[:port])",
                "description": "REQUIRED. The Task may reach only these hosts — at minimum your relay host and the model API host. AX allows all egress when no Gateway is set, so this provider refuses to deploy without an explicit allowlist."
            },
            "command": {
                "type": "string",
                "title": "Command override",
                "description": "Optional entrypoint override inside the runner image."
            },
            "cpu_request": { "type": "string", "title": "CPU request", "default": "500m" },
            "memory_request": { "type": "string", "title": "Memory request", "default": "1Gi" },
            "cpu_limit": { "type": "string", "title": "CPU limit", "default": "2" },
            "memory_limit": { "type": "string", "title": "Memory limit", "default": "4Gi" },
            "inactivity_seconds": {
                "type": "number",
                "title": "Idle self-termination (seconds)",
                "default": 900
            },
            "debug": {
                "type": "boolean",
                "title": "Enable AX guest services (ax ssh)",
                "description": "Serves arbitrary exec/file access inside the sandbox. Diagnostic only — leave off in production.",
                "default": false
            }
        },
        "required": ["image", "egress_allowlist"]
    })
}
