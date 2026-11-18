//! AX backend provider for Buzz remote agents
//! (spec `docs/remote-agents.md`, design `docs/backend-ax.md`).
//!
//! One process per operation: read exactly one JSON request from stdin, write
//! exactly one JSON response to stdout, exit — the same contract shape as
//! `buzz-backend-kubernetes`.
//!
//! What this provider does differently from the Kubernetes binding, and why
//! (design doc `docs/backend-ax.md`):
//!
//! - **Always an explicit Gateway.** AX defaults to allow-all egress and
//!   applies egress policy warn-and-continue; this provider requires a
//!   non-empty allowlist and refuses to deploy without one.
//! - **Identity is a documented residual exposure.** AX v1alpha1 has no
//!   secretRef for Task env, so the nsec rides the Task environment (stored
//!   in AX control-plane state). The egress allowlist bounds exfiltration;
//!   the harness-outside-sandbox evolution (design doc §V2) removes the
//!   exposure entirely.
//! - **M1 respected via absence**: no `ax ssh`/debug in the production path
//!   (guest services default off), no status query after deploy — liveness
//!   is relay presence, stop is a relay message, per the five invariants.

mod config;
mod identity;
mod manifest;
mod wire;

use std::io::Read;
use wire::{Request, Response};

/// The provider a shared-compute agent resolves to (same backstop as the
/// Kubernetes binding): a mesh agent runs on the relay's compute.
const RELAY_MESH_PROVIDER: &str = "relay-mesh";

fn main() {
    let mut input = String::new();
    if let Err(e) = std::io::stdin().read_to_string(&mut input) {
        eprintln!("could not read the request from stdin: {e}");
        std::process::exit(1);
    }
    let response = respond(&input);
    println!(
        "{}",
        serde_json::to_string(&response).unwrap_or_else(|e| {
            format!(r#"{{"ok":false,"error":"could not serialize a response: {e}"}}"#)
        })
    );
}

fn respond(input: &str) -> Response {
    let raw: serde_json::Value = match serde_json::from_str(input) {
        Ok(value) => value,
        Err(e) => return Response::error(format!("request is not valid JSON: {e}")),
    };

    if let Some(provider) = raw
        .get("agent")
        .and_then(|a| a.get("provider"))
        .and_then(|p| p.as_str())
    {
        if provider.trim() == RELAY_MESH_PROVIDER {
            return Response::error(
                "deploy refused: this agent is configured for shared compute (relay-mesh), \
                 which runs on the relay rather than as an AX Task."
                    .to_string(),
            );
        }
    }

    let request: Request = match serde_json::from_value(raw) {
        Ok(request) => request,
        Err(e) => return Response::error(format!("could not understand the request: {e}")),
    };

    match request {
        Request::Info => Response::info(),
        Request::Deploy(deploy) => match deploy::deploy(&deploy) {
            Ok(agent_id) => Response::deployed(agent_id),
            Err(e) => Response::error(e),
        },
    }
}

/// The deploy operation. v1 shells out to the `ax` CLI (`ax apply -f -`),
/// which resolves the control plane from the ambient kube context unless
/// `ax_server` is set; the CLI is the operator's authenticated path, so the
/// provider holds no cluster credentials itself (I2 corollary).
mod deploy {
    use super::wire::DeployRequest;
    use crate::config::AxConfig;
    use crate::identity::AgentIdentity;
    use crate::manifest;

    /// Render + apply. `agent_id` is `<atespace>/<task-name>`.
    pub fn deploy(request: &DeployRequest) -> Result<String, String> {
        let cfg = AxConfig::parse(&request.provider_config)?;
        let identity = AgentIdentity::from_nsec(&request.agent.private_key_nsec)?;
        let manifest_yaml = manifest::render_manifest(
            &cfg,
            &identity,
            &request.agent,
            request.agent.launch.as_ref(),
        )?;

        let mut cmd = std::process::Command::new("ax");
        cmd.arg("apply")
            .arg("-f")
            .arg("-")
            .stdin(std::process::Stdio::piped());
        if let Some(server) = &cfg.ax_server {
            cmd.arg("--server").arg(server);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("could not run the ax CLI (is it installed and on PATH?): {e}"))?;
        use std::io::Write;
        child
            .stdin
            .as_mut()
            .expect("stdin piped above")
            .write_all(manifest_yaml.as_bytes())
            .map_err(|e| format!("could not write the manifest to ax: {e}"))?;
        let output = child
            .wait_with_output()
            .map_err(|e| format!("ax apply failed to run: {e}"))?;
        if !output.status.success() {
            // stderr is scrubbed upstream by the desktop (spec §Provider
            // Output Is Untrusted); pass it through unfiltered here.
            return Err(format!(
                "ax apply exited with {}: {}",
                output.status,
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        Ok(format!("{}/{}", cfg.atespace, identity.task_name()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::Response;

    #[test]
    fn info_is_pure_and_versioned() {
        let v = serde_json::to_value(Response::info()).unwrap();
        assert_eq!(v["ok"], true);
        assert_eq!(v["protocol_version"], 1);
        assert_eq!(v["name"], "ax");
        assert!(v["config_schema"]["required"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r == "egress_allowlist"));
    }

    #[test]
    fn relay_mesh_agents_are_refused() {
        let input = r#"{"op":"deploy","agent":{"provider":"relay-mesh","relay_url":"wss://r","private_key_nsec":"nsec1x"}}"#;
        let v = serde_json::to_value(respond(input)).unwrap();
        assert_eq!(v["ok"], false);
        assert!(v["error"].as_str().unwrap().contains("relay-mesh"));
    }

    #[test]
    fn invalid_json_is_an_in_band_error() {
        let v = serde_json::to_value(respond("not json")).unwrap();
        assert_eq!(v["ok"], false);
    }
}
