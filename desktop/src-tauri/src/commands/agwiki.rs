//! `agwiki_distill` Tauri command — the "Distill now" drive for
//! `buzz agwiki distill --space <space> --publish` through the bundled `buzz`
//! sidecar CLI.
//!
//! The env contract mirrors `org_classify.rs` exactly: classifier env
//! (`BUZZ_CLASSIFIER_API_URL` / `_API_KEY` / `_MODEL`) is passed **only** to
//! the child process — never logged and never returned to the webview
//! unmasked — relay identity (`BUZZ_RELAY_URL`) comes from the active
//! workspace override, and the signing key (`BUZZ_PRIVATE_KEY`) from the
//! keyring. Missing classifier URL/key is rejected up front with the same
//! "… is not configured" strings as `org_classify_task`.
//!
//! Terminal outcomes are **data**, not rejections (the frontend contract in
//! `features/org/agentWikiHooks.ts`): a completed run resolves
//! `{ ok, stdout, stderr }` for any exit code, and the pure classify seam in
//! `features/org/lib/agentWiki.ts` maps it to published | nothing-new |
//! failed. Rejections are reserved for invocation problems — missing
//! classifier config, missing CLI, spawn/wait failure — and the hard 180 s
//! timeout (`"distill timed out after 180s and was stopped"`). The Rust side
//! owns the timeout and kills the child: the frontend's `withTimeout` fence
//! cannot kill anything.

use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use nostr::ToBech32;
use serde::Serialize;
use tauri::State;

use crate::app_state::AppState;
use crate::managed_agents::resolve_command;
use crate::relay::relay_api_base_url_with_override;

/// Wall-clock cap for one `buzz agwiki distill --publish` invocation.
/// One distill run makes a single bounded LLM call plus relay reads.
const DISTILL_TIMEOUT: Duration = Duration::from_secs(180);

/// Classifier env vars passed through to the sidecar only.
const CLASSIFIER_API_URL_ENV: &str = "BUZZ_CLASSIFIER_API_URL";
const CLASSIFIER_API_KEY_ENV: &str = "BUZZ_CLASSIFIER_API_KEY";
const CLASSIFIER_MODEL_ENV: &str = "BUZZ_CLASSIFIER_MODEL";

/// Raw result of one `agwiki distill --publish` sidecar run (any exit code).
/// Field names match `AgentWikiDistillRun` in
/// `desktop/src/features/org/lib/agentWiki.ts`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgwikiDistillRun {
    /// Process exit code was 0.
    pub ok: bool,
    /// Child stdout (secret env values masked).
    pub stdout: String,
    /// Child stderr (secret env values masked).
    pub stderr: String,
}

#[tauri::command]
pub async fn agwiki_distill(
    space: String,
    state: State<'_, AppState>,
) -> Result<AgwikiDistillRun, String> {
    let space = space.trim();
    if space.is_empty() {
        return Err("space must not be empty".to_string());
    }
    let (mut command, secrets) = build_distill_command(&state)?;
    command.arg("--space").arg(space).arg("--publish");
    let (success, stdout, stderr) = run_buzz_distill(&mut command)?;
    Ok(AgwikiDistillRun {
        ok: success,
        stdout: mask_secrets(&stdout, &secrets),
        stderr: mask_secrets(&stderr, &secrets),
    })
}

/// The exact timeout rejection string — also the frontend's classification
/// fence (`classifyAgentWikiDistillError`), so both fences classify as one
/// `timeout` outcome. Kept as a function so tests bind the literal.
fn timeout_error() -> String {
    format!(
        "distill timed out after {}s and was stopped",
        DISTILL_TIMEOUT.as_secs()
    )
}

/// Resolve the bundled CLI and compose the shared env (relay identity,
/// signing key, classifier env). Returns the injected secret values so the
/// caller can mask them out of anything that reaches the webview.
fn build_distill_command(state: &AppState) -> Result<(Command, Vec<String>), String> {
    // `buzz` is the canonical sidecar name; dev builds register the CLI
    // symlink as `buzz-dev` (build_identity::cli_name), so try both.
    let cli = resolve_command("buzz")
        .or_else(|| resolve_command("buzz-dev"))
        .ok_or_else(|| {
            "the buzz CLI is not available; run the app from a workspace build (cargo build -p buzz-cli)"
                .to_string()
        })?;

    let mut command = Command::new(cli);
    command
        .args(["agwiki", "distill"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::util::configure_no_window(&mut command);

    // Fail closed on a missing classifier config (mirrors the CLI contract).
    let api_url = env_var_trimmed(CLASSIFIER_API_URL_ENV)
        .ok_or_else(|| format!("{CLASSIFIER_API_URL_ENV} is not configured"))?;
    let api_key = env_var_trimmed(CLASSIFIER_API_KEY_ENV)
        .ok_or_else(|| format!("{CLASSIFIER_API_KEY_ENV} is not configured"))?;
    command.env(CLASSIFIER_API_URL_ENV, &api_url);
    command.env(CLASSIFIER_API_KEY_ENV, &api_key);
    if let Some(model) = env_var_trimmed(CLASSIFIER_MODEL_ENV) {
        command.env(CLASSIFIER_MODEL_ENV, model);
    }

    // Relay identity: active workspace override beats env, like every relay op.
    command.env("BUZZ_RELAY_URL", relay_api_base_url_with_override(state));

    // Signing key from the keyring — same seam as `get_nsec`.
    let keys = state.signing_keys()?;
    let nsec = keys
        .secret_key()
        .to_bech32()
        .map_err(|e| format!("encode nsec: {e}"))?;
    command.env("BUZZ_PRIVATE_KEY", &nsec);

    Ok((command, vec![api_key, nsec]))
}

/// Run the sidecar with a hard timeout, draining stdout/stderr on background
/// threads (a chatty CLI must not deadlock on a full pipe). Kills the child
/// when the deadline fires — the process-tree kill is this side's job.
fn run_buzz_distill(command: &mut Command) -> Result<(bool, String, String), String> {
    let mut child = command
        .spawn()
        .map_err(|e| format!("failed to start the buzz CLI: {e}"))?;

    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    let stdout_thread = std::thread::spawn(move || read_pipe_lossy(stdout_pipe));
    let stderr_thread = std::thread::spawn(move || read_pipe_lossy(stderr_pipe));

    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if started.elapsed() > DISTILL_TIMEOUT {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = stdout_thread.join();
                    let _ = stderr_thread.join();
                    return Err(timeout_error());
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("failed to wait for the distill run: {e}"));
            }
        }
    };

    let stdout = stdout_thread.join().unwrap_or_default();
    let stderr = stderr_thread.join().unwrap_or_default();
    Ok((status.success(), stdout, stderr))
}

fn read_pipe_lossy(pipe: Option<impl std::io::Read>) -> String {
    let Some(mut pipe) = pipe else {
        return String::new();
    };
    let mut bytes = Vec::new();
    let _ = std::io::Read::read_to_end(&mut pipe, &mut bytes);
    String::from_utf8_lossy(&bytes).to_string()
}

fn env_var_trimmed(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Mask every injected secret value out of text headed for the webview.
fn mask_secrets(text: &str, secrets: &[String]) -> String {
    let mut out = text.to_string();
    for secret in secrets {
        if !secret.is_empty() {
            out = out.replace(secret, "***");
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeout_rejection_matches_the_frontend_fences() {
        // Both the Rust kill fence and the frontend's `withTimeout` produce
        // this literal; `classifyAgentWikiDistillError` classifies it as one
        // `timeout` outcome via TIMEOUT_PATTERN.
        assert_eq!(
            timeout_error(),
            "distill timed out after 180s and was stopped"
        );
    }

    #[test]
    fn run_result_wire_shape_matches_the_frontend_contract() {
        let run = AgwikiDistillRun {
            ok: true,
            stdout: "out".to_string(),
            stderr: "err".to_string(),
        };
        let value = serde_json::to_value(&run).unwrap_or_else(|e| panic!("serializes: {e}"));
        assert_eq!(value["ok"], true);
        assert_eq!(value["stdout"], "out");
        assert_eq!(value["stderr"], "err");
        assert_eq!(value.as_object().map(|o| o.len()), Some(3));
    }

    #[test]
    fn mask_secrets_never_leaks_child_env_values() {
        let key = "sk-test-9876543210";
        let nsec = "nsec1testsecrethex";
        let text = format!("boom {key} in stderr and {nsec} too");
        let masked = mask_secrets(&text, &[key.to_string(), nsec.to_string()]);
        assert!(!masked.contains(key));
        assert!(!masked.contains(nsec));
        assert_eq!(masked.matches("***").count(), 2);
    }
}
