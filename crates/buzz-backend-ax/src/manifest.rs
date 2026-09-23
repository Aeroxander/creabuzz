//! AX manifest generation — the pure, cluster-free core of this provider.
//!
//! Emits the multi-document YAML that `ax apply` consumes: one Gateway
//! (explicit egress allowlist — AX's no-Gateway default is allow-all), one
//! Task binding that Gateway, with the identity environment and the harness
//! command. Generation is a pure function from (config, payload, identity),
//! so the security-relevant properties are unit-testable without a cluster:
//!
//! - the Gateway exists and its allowlist is exactly the configured one;
//! - the Task references the Gateway;
//! - identity variables come from the top-level payload fields, never from
//!   user `env_vars` (the reserved-key rule, spec §Deploy);
//! - `spec.debug` defaults off (guest services are a diagnostic, not the
//!   production tool boundary);
//! - the durable `/workspace` volume is where suspend/resume state lives.

use crate::config::AxConfig;
use crate::identity::AgentIdentity;
use crate::wire::{AgentPayload, LaunchBlock};
use std::collections::BTreeMap;

/// Identity + launch environment for the Task. Built from the top-level
/// payload fields (reserved-key rule) plus the desktop-resolved `launch`
/// layering; user `env_vars` are merged last and validated against the
/// reserved names.
///
/// Env contract mirrors `buzz-backend-kubernetes/src/env.rs`: the runner
/// image's entrypoint reads `BUZZ_ACP_AGENT_COMMAND`/`_ARGS` (comma-joined —
/// an argument containing a comma is unrepresentable in both paths), the
/// owner gate requires `auth_tag` or `launch.ownerPubkey` (without one the
/// agent cannot honor `!shutdown`), and the respond-to gate modes are
/// validated provider-side.
pub fn task_env(
    payload: &AgentPayload,
    launch: Option<&LaunchBlock>,
    inactivity_seconds: u64,
) -> Result<BTreeMap<String, String>, String> {
    // Reserved identity keys: constructed ONLY from the top-level fields.
    let mut env = BTreeMap::new();
    env.insert(
        "BUZZ_PRIVATE_KEY".to_string(),
        payload.private_key_nsec.clone(),
    );
    env.insert(
        "NOSTR_PRIVATE_KEY".to_string(),
        payload.private_key_nsec.clone(),
    );
    if let Some(tag) = &payload.auth_tag {
        env.insert("BUZZ_AUTH_TAG".to_string(), tag.clone());
    }
    env.insert("BUZZ_RELAY_URL".to_string(), payload.relay_url.clone());
    env.insert(
        "BUZZ_ACP_EXIT_AFTER_INACTIVITY".to_string(),
        inactivity_seconds.to_string(),
    );

    // Owner gate: at least one of auth_tag / launch.ownerPubkey must resolve,
    // or the agent cannot honor `!shutdown` (spec §Stop).
    let owner = launch.and_then(|l| l.owner_pubkey.as_deref());
    if payload.auth_tag.is_none() && owner.is_none() {
        return Err(
            "deploy refused: neither auth_tag nor launch.ownerPubkey resolved — \
                    without an owner the agent cannot honor !shutdown"
                .to_string(),
        );
    }
    if let Some(o) = owner {
        env.insert("BUZZ_ACP_AGENT_OWNER".to_string(), o.to_string());
    }

    if let Some(l) = launch {
        // Policy env (tier 1) then launch env (tier 2) — user env (tier 3)
        // wins, matching the local spawn's layering.
        for (k, v) in &l.policy_env {
            env.insert(k.clone(), v.clone());
        }
        for (k, v) in &l.env {
            env.insert(k.clone(), v.clone());
        }
        if let Some(command) = l.command.as_deref().filter(|c| !c.is_empty()) {
            env.insert("BUZZ_ACP_AGENT_COMMAND".to_string(), command.to_string());
        }
        if !l.args.is_empty() {
            env.insert("BUZZ_ACP_AGENT_ARGS".to_string(), l.args.join(","));
        }
        env.insert("BUZZ_ACP_MCP_COMMAND".to_string(), "buzz-dev-mcp".into());
    }

    // Respond-to gate: modes are the harness's; allowlist mode requires a
    // non-empty list (stale lists are harmless — the key is authoritative and
    // tier 3 clears it — so the validation mirrors the K8s provider's soft
    // stance on everything but the mode itself).
    const RESPOND_TO_MODES: [&str; 4] = ["owner-only", "allowlist", "anyone", "nobody"];
    if let Some(mode) = payload.respond_to.as_deref().filter(|s| !s.is_empty()) {
        if !RESPOND_TO_MODES.contains(&mode) {
            return Err(format!(
                "deploy refused: respond_to {mode:?} is not a mode the harness accepts \
                 (expected one of: {})",
                RESPOND_TO_MODES.join(", ")
            ));
        }
        env.insert("BUZZ_ACP_RESPOND_TO".to_string(), mode.to_string());
        if let Some(list) = payload
            .respond_to_allowlist
            .as_ref()
            .filter(|l| !l.is_empty())
        {
            env.insert("BUZZ_ACP_RESPOND_TO_ALLOWLIST".to_string(), list.join(","));
        }
    }

    // Reserved-key collision check: a user-supplied key that collides with an
    // identity variable would reconstruct the identity through the wrong path.
    const RESERVED: [&str; 4] = [
        "BUZZ_PRIVATE_KEY",
        "NOSTR_PRIVATE_KEY",
        "BUZZ_AUTH_TAG",
        "BUZZ_RELAY_URL",
    ];
    for k in payload.env_vars.keys() {
        if RESERVED.contains(&k.as_str()) {
            return Err(format!(
                "env_vars contains reserved identity key '{k}': the desktop strips reserved \
                 keys before merge; refusing to deploy a task whose identity could be \
                 reconstructed from user env"
            ));
        }
    }
    for (k, v) in &payload.env_vars {
        env.insert(k.clone(), v.clone());
    }
    Ok(env)
}

fn yaml_escape(s: &str) -> String {
    // User-supplied values: emit as a double-quoted YAML scalar with the
    // two YAML-required escapes (backslash and double quote).
    let bs = char::from_u32(0x5C).unwrap();
    let quote = char::from_u32(0x22).unwrap();
    let escaped = s
        .chars()
        .map(|c| match c {
            x if x == bs => format!("{bs}{bs}"),
            x if x == quote => format!("{bs}{quote}"),
            x => x.to_string(),
        })
        .collect::<String>();
    format!("{quote}{escaped}{quote}")
}

/// Generate the full `ax apply` multi-document YAML.
pub fn render_manifest(
    cfg: &AxConfig,
    identity: &AgentIdentity,
    payload: &AgentPayload,
    launch: Option<&LaunchBlock>,
) -> Result<String, String> {
    let env = task_env(payload, launch, cfg.inactivity_seconds)?;
    let task_name = identity.task_name();
    // Provenance header: the pubkey the provider decoded itself (spec §Deploy
    // step 0) — the same key the Task's identity env carries.
    let mut out = String::new();
    out.push_str(&format!("# buzz agent pubkey: {}\n", identity.pubkey_hex()));

    // ── Gateway: explicit egress allowlist. Never omitted — AX's default is
    //    allow-all, and its policy-apply failure path is warn-and-continue
    //    (upstream reconciler.go), so the allowlist MUST be deliberate.
    out.push_str("---\n");
    out.push_str("apiVersion: ax.io/v1alpha1\nkind: Gateway\nmetadata:\n");
    out.push_str(&format!("  name: {task_name}-egress\n"));
    out.push_str(&format!("  atespace: {}\n", cfg.atespace));
    out.push_str("spec:\n  egress:\n    allowlist:\n      hosts:\n");
    for host in &cfg.egress_allowlist {
        let (h, port) = match host.rsplit_once(':') {
            Some((h, p)) if p.chars().all(|c| c.is_ascii_digit()) => (h, p),
            _ => (host.as_str(), "443"),
        };
        out.push_str(&format!("        - host: {h}\n          port: {port}\n"));
    }

    // ── Task.
    out.push_str("---\n");
    out.push_str("apiVersion: ax.io/v1alpha1\nkind: Task\nmetadata:\n");
    out.push_str(&format!("  name: {task_name}\n"));
    out.push_str(&format!("  atespace: {}\n", cfg.atespace));
    out.push_str("spec:\n");
    out.push_str(&format!("  image: {}\n", yaml_escape(&cfg.image)));
    // Optional entrypoint override (ax-native). The harness command itself
    // flows through the env contract above, mirroring the K8s binding's
    // fixed-entrypoint shape.
    if let Some(cmd) = &cfg.command {
        out.push_str(&format!("  command: [{}]\n", yaml_escape(cmd)));
    }
    out.push_str(&format!(
        "  resources:\n    requests:\n      cpu: {}\n      memory: {}\n    limits:\n      cpu: {}\n      memory: {}\n",
        yaml_escape(&cfg.cpu_request),
        yaml_escape(&cfg.memory_request),
        yaml_escape(&cfg.cpu_limit),
        yaml_escape(&cfg.memory_limit)
    ));
    out.push_str(&format!("  gateway: {}-egress\n", task_name));
    out.push_str(&format!("  debug: {}\n", cfg.debug));
    if !env.is_empty() {
        out.push_str("  env:\n");
        for (k, v) in &env {
            out.push_str(&format!(
                "    - name: {}\n      value: {}\n",
                yaml_escape(k),
                yaml_escape(v)
            ));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::AgentPayload;

    fn payload() -> AgentPayload {
        AgentPayload {
            relay_url: "wss://relay.example:3000".into(),
            private_key_nsec: "nsec1gacf85jt420223rrh3v0eu2tzp7gkvxa2474qhdcys6pfqw9hcvqdhuzes"
                .into(),
            auth_tag: Some("\"tag-json\"".into()),
            respond_to: None,
            respond_to_allowlist: None,
            env_vars: Default::default(),
            launch: None,
        }
    }

    fn cfg() -> AxConfig {
        AxConfig {
            ax_server: None,
            atespace: "default".into(),
            image: "ghcr.io/block/buzz-sprig@sha256:abc".into(),
            egress_allowlist: vec!["relay.example:3000".into(), "api.openai.com".into()],
            command: None,
            cpu_request: "500m".into(),
            memory_request: "1Gi".into(),
            cpu_limit: "2".into(),
            memory_limit: "4Gi".into(),
            inactivity_seconds: 900,
            debug: false,
        }
    }

    #[test]
    fn manifest_contains_gateway_and_allowlist() {
        let identity = AgentIdentity::from_nsec(&payload().private_key_nsec).unwrap();
        let m = render_manifest(&cfg(), &identity, &payload(), None).unwrap();
        assert!(m.contains("kind: Gateway"));
        assert!(m.contains("host: relay.example"));
        assert!(m.contains("port: 3000"));
        assert!(m.contains("host: api.openai.com"));
        assert!(m.contains("port: 443"));
    }

    #[test]
    fn task_references_gateway_and_defaults_debug_off() {
        let identity = AgentIdentity::from_nsec(&payload().private_key_nsec).unwrap();
        let m = render_manifest(&cfg(), &identity, &payload(), None).unwrap();
        assert!(m.contains("kind: Task"));
        assert!(m.contains("debug: false"));
        assert!(m.contains(&format!("gateway: {}-egress", identity.task_name())));
    }

    #[test]
    fn identity_env_comes_from_top_level_fields_only() {
        let identity = AgentIdentity::from_nsec(&payload().private_key_nsec).unwrap();
        let m = render_manifest(&cfg(), &identity, &payload(), None).unwrap();
        assert!(m.contains("BUZZ_PRIVATE_KEY"));
        assert!(m.contains("BUZZ_RELAY_URL"));
        assert!(m.contains("value: \"wss://relay.example:3000\""));
    }

    #[test]
    fn reserved_keys_in_user_env_are_refused() {
        let mut p = payload();
        p.env_vars
            .insert("BUZZ_PRIVATE_KEY".to_string(), "nsec1evil".into());
        let identity = AgentIdentity::from_nsec(&p.private_key_nsec).unwrap();
        assert!(render_manifest(&cfg(), &identity, &p, None)
            .unwrap_err()
            .contains("reserved identity key"));
    }

    #[test]
    fn launch_command_flows_through_env_contract() {
        let mut p = payload();
        p.launch = Some(LaunchBlock {
            command: Some("buzz-acp".into()),
            args: vec!["--relay".into(), "wss://relay.example:3000".into()],
            env: Default::default(),
            policy_env: Default::default(),
            owner_pubkey: None,
        });
        let identity = AgentIdentity::from_nsec(&p.private_key_nsec).unwrap();
        let m = render_manifest(&cfg(), &identity, &p, p.launch.as_ref()).unwrap();
        assert!(m.contains("BUZZ_ACP_AGENT_COMMAND"));
        assert!(m.contains("BUZZ_ACP_AGENT_ARGS"));
        assert!(m.contains("buzz-acp"));
    }

    #[test]
    fn task_name_is_deterministic_per_key() {
        let a = AgentIdentity::from_nsec(&payload().private_key_nsec).unwrap();
        let b = AgentIdentity::from_nsec(&payload().private_key_nsec).unwrap();
        assert_eq!(a.task_name(), b.task_name());
        assert!(a.task_name().starts_with("buzz-"));
    }

    #[test]
    fn owner_gate_requires_auth_tag_or_owner() {
        let mut p = payload();
        p.auth_tag = None;
        let identity = AgentIdentity::from_nsec(&p.private_key_nsec).unwrap();
        assert!(render_manifest(&cfg(), &identity, &p, None)
            .unwrap_err()
            .contains("owner"));

        p.launch = Some(LaunchBlock {
            owner_pubkey: Some("deadbeef".into()),
            ..Default::default()
        });
        assert!(render_manifest(&cfg(), &identity, &p, p.launch.as_ref()).is_ok());
    }

    #[test]
    fn respond_to_mode_is_validated() {
        let mut p = payload();
        p.respond_to = Some("nonsense".into());
        let identity = AgentIdentity::from_nsec(&p.private_key_nsec).unwrap();
        assert!(render_manifest(&cfg(), &identity, &p, None)
            .unwrap_err()
            .contains("respond_to"));

        let mut p = payload();
        p.respond_to = Some("allowlist".into());
        p.respond_to_allowlist = Some(vec!["b".repeat(64)]);
        let identity = AgentIdentity::from_nsec(&p.private_key_nsec).unwrap();
        let m = render_manifest(&cfg(), &identity, &p, None).unwrap();
        assert!(m.contains("BUZZ_ACP_RESPOND_TO"));
        assert!(m.contains("BUZZ_ACP_RESPOND_TO_ALLOWLIST"));
    }

    #[test]
    fn provenance_header_carries_decoded_pubkey() {
        let identity = AgentIdentity::from_nsec(&payload().private_key_nsec).unwrap();
        let m = render_manifest(&cfg(), &identity, &payload(), None).unwrap();
        assert!(m.contains(&format!("# buzz agent pubkey: {}", identity.pubkey_hex())));
    }
}
