//! `team_run` / `team_reflect` Tauri commands — the "Run strategy" and
//! "Reflect" affordances on the org Teams surface.
//!
//! These spawn the bundled `buzz` sidecar CLI exactly like `org_classify_*`
//! (see org_classify.rs): `buzz team run --strategy <id> --problem <text>
//! [--org-node <node-d>] --publish` / `buzz team reflect --run <run-id>
//! --publish`. The classifier environment (`BUZZ_CLASSIFIER_API_URL` /
//! `_API_KEY` / `_MODEL`) is passed **only** to the child process
//! environment — never logged, never persisted, never returned to the
//! webview. Relay identity comes from the active workspace override and the
//! signing key from the keyring, mirroring org_classify.
//!
//! Hard wall-clock timeouts: a strategy run executes several LLM turns and
//! can take minutes (600s); reflection is a single LLM call (120s). The
//! child is killed when the deadline fires. Failures surface the CLI's text
//! verbatim (secrets masked): nothing partial is ever published — the CLI
//! only publishes the 44021 run head after every 44022 turn persisted, and
//! reflection only publishes a fully-validated revision.

use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use nostr::ToBech32;
use serde::Serialize;
use tauri::State;

use crate::app_state::AppState;
use crate::managed_agents::resolve_command;
use crate::relay::relay_api_base_url_with_override;

/// Wall-clock cap for one `buzz team run --publish` invocation. Runs execute
/// up to 6 phases against a live classifier — minutes, not seconds.
const TEAM_RUN_TIMEOUT: Duration = Duration::from_secs(600);
/// Wall-clock cap for one `buzz team reflect --publish` invocation (one
/// classifier call, bounded retry).
const TEAM_REFLECT_TIMEOUT: Duration = Duration::from_secs(120);

/// Classifier env vars passed through to the sidecar only.
const CLASSIFIER_API_URL_ENV: &str = "BUZZ_CLASSIFIER_API_URL";
const CLASSIFIER_API_KEY_ENV: &str = "BUZZ_CLASSIFIER_API_KEY";
const CLASSIFIER_MODEL_ENV: &str = "BUZZ_CLASSIFIER_MODEL";

/// Env vars that must never leak into returned/logged output.
const SECRET_ENV_VARS: [&str; 2] = [CLASSIFIER_API_KEY_ENV, "BUZZ_PRIVATE_KEY"];

/// Result of a published strategy run.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamRunResult {
    pub run_id: String,
    /// The authoritative kind:44021 event id.
    pub event_id: String,
    /// Published turn count (from the CLI summary line).
    pub turns: usize,
}

/// Result of a published reflection revision.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamReflectResult {
    /// New revision `d` (`<original-id>-rev<N>`).
    pub revision_d: String,
    /// Published revision event id.
    pub event_id: String,
    /// The revised strategy content (already validated by the CLI schema).
    pub revised: serde_json::Value,
}

#[tauri::command]
pub async fn team_run(
    strategy_id: String,
    problem: String,
    org_node: Option<String>,
    state: State<'_, AppState>,
) -> Result<TeamRunResult, String> {
    if strategy_id.trim().is_empty() {
        return Err("strategy id must not be empty".to_string());
    }
    let mut command = build_team_command(&state)?;
    command
        .arg("run")
        .arg("--strategy")
        .arg(&strategy_id)
        .arg("--problem")
        .arg(&problem);
    if let Some(node) = org_node.as_deref().filter(|n| !n.trim().is_empty()) {
        command.arg("--org-node").arg(node);
    }
    command.arg("--publish");

    let (success, stdout, stderr) = run_buzz_team(&mut command, TEAM_RUN_TIMEOUT)?;
    if !success {
        return Err(clean_sidecar_error(&stdout, &stderr));
    }
    let event_id = parse_first_json(&stdout)
        .and_then(|v| v.as_object().and_then(|o| o.get("event_id")).cloned())
        .and_then(|v| v.as_str().map(str::to_string))
        .ok_or_else(|| {
            "team run published but the CLI did not return an event id; see relay logs".to_string()
        })?;
    // The run id comes from the CLI summary's own log line ("published run
    // <run-id>: N turn(s)…"), not from re-deriving the timestamp scheme.
    let (run_id, turns) = parse_run_summary(&stdout);
    Ok(TeamRunResult {
        run_id,
        event_id,
        turns,
    })
}

#[tauri::command]
pub async fn team_reflect(
    run_id: String,
    state: State<'_, AppState>,
) -> Result<TeamReflectResult, String> {
    if run_id.trim().is_empty() {
        return Err("run id must not be empty".to_string());
    }
    let mut command = build_team_command(&state)?;
    command
        .arg("reflect")
        .arg("--run")
        .arg(&run_id)
        .arg("--publish");

    let (success, stdout, stderr) = run_buzz_team(&mut command, TEAM_REFLECT_TIMEOUT)?;
    if !success {
        return Err(clean_sidecar_error(&stdout, &stderr));
    }
    // The CLI prints the revised strategy JSON first, then the write
    // response — parse the revision head, then the published event id, then
    // the revision d from its own log line.
    let revised = parse_first_json(&stdout).ok_or_else(|| {
        format!(
            "reflection produced no revised strategy\n{}",
            trim_for_error(&stdout)
        )
    })?;
    let event_id = parse_json_at(&stdout, 1)
        .and_then(|v| v.as_object().and_then(|o| o.get("event_id")).cloned())
        .and_then(|v| v.as_str().map(str::to_string))
        .ok_or_else(|| {
            "reflection published but the CLI did not return an event id; see relay logs"
                .to_string()
        })?;
    let revision_d = parse_revision_summary(&stdout).ok_or_else(|| {
        "reflection published but the CLI did not report the revision d".to_string()
    })?;
    Ok(TeamReflectResult {
        revision_d,
        event_id,
        revised,
    })
}

/// Resolve the bundled CLI and compose the shared env (relay identity,
/// signing key, classifier env) — nothing key-related ever leaves this
/// function except into the child process environment.
fn build_team_command(state: &AppState) -> Result<Command, String> {
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
        .arg("team")
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

    Ok(command)
}

/// Run the sidecar with a hard timeout, draining stdout/stderr on background
/// threads (a chatty CLI must not deadlock on a full pipe). Kills the child
/// when the deadline fires.
fn run_buzz_team(
    command: &mut Command,
    timeout: Duration,
) -> Result<(bool, String, String), String> {
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
                if started.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = stdout_thread.join();
                    let _ = stderr_thread.join();
                    return Err(format!(
                        "buzz team timed out after {}s and was stopped",
                        timeout.as_secs()
                    ));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("failed to wait for buzz team: {e}"));
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

/// Wrap stderr/stdout into a human error message, masking any secret env
/// value that a misbehaving tool echoed back.
fn clean_sidecar_error(stdout: &str, stderr: &str) -> String {
    let mut combined = format!("{stderr}\n{stdout}");
    for name in SECRET_ENV_VARS {
        if let Some(value) = env_var_trimmed(name) {
            combined = combined.replace(&value, "***");
        }
    }
    let combined = combined.trim();
    if combined.is_empty() {
        "buzz team failed with no output".to_string()
    } else {
        trim_for_error(combined)
    }
}

fn trim_for_error(text: &str) -> String {
    let text = text.trim();
    if text.chars().count() > 600 {
        let cut: String = text.chars().take(600).collect();
        format!("{cut}…")
    } else {
        text.to_string()
    }
}

/// Parse the first complete JSON value in a stream (the CLI prints JSON
/// values amid human text that precedes them — "reflected on run …" lines
/// come before the revised strategy JSON).
fn parse_first_json(text: &str) -> Option<serde_json::Value> {
    parse_json_at(text, 0)
}

/// Parse the Nth complete JSON value in a stream (0-based). Deserialization
/// starts at the first `{` so leading human text never poisons the stream.
fn parse_json_at(text: &str, index: usize) -> Option<serde_json::Value> {
    use serde_json::Deserializer;
    let start = text.find('{')?;
    Deserializer::from_str(&text[start..])
        .into_iter::<serde_json::Value>()
        .map(Result::ok)
        .flatten()
        .nth(index)
}

/// `published run <run-id>: N turn(s), M tokens, model X` — the run d and
/// the published turn count. Defensive: defaults keep the result usable if
/// the CLI's log line shape drifts (the event id is already authoritative).
fn parse_run_summary(stdout: &str) -> (String, usize) {
    for line in stdout.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("published run ") {
            if let Some((run_id, tail)) = rest.split_once(':') {
                let turns = tail
                    .split_whitespace()
                    .next()
                    .and_then(|n| n.parse::<usize>().ok())
                    .unwrap_or(0);
                return (run_id.trim().to_string(), turns);
            }
        }
    }
    (String::new(), 0)
}

/// `published revision <d> (parent <id>)` — the new revision's d tag.
fn parse_revision_summary(stdout: &str) -> Option<String> {
    for line in stdout.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("published revision ") {
            if let Some((d, _)) = rest.split_once(" (parent ") {
                let d = d.trim();
                if !d.is_empty() {
                    return Some(d.to_string());
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_run_summary_line() {
        let stdout = "{\"event_id\":\"aabbcc\",\"accepted\":true,\"message\":\"\"}\npublished run sat-smoke-2-1750000000: 4 turn(s), 1732 tokens, model deepseek-v4-flash-0731";
        let (run_id, turns) = parse_run_summary(stdout);
        assert_eq!(run_id, "sat-smoke-2-1750000000");
        assert_eq!(turns, 4);
    }

    #[test]
    fn parses_run_summary_with_org_node_warning_lines() {
        let stdout = "advisory: participant would exceed runs budget (50/30)\npublished run my-strategy-123: 2 turn(s), 800 tokens, model m";
        let (run_id, turns) = parse_run_summary(stdout);
        assert_eq!(run_id, "my-strategy-123");
        assert_eq!(turns, 2);
    }

    #[test]
    fn parses_revision_summary_line() {
        let stdout = "\nrevised strategy JSON:\n{...}\n{\"event_id\":\"ccdd\",\"accepted\":true,\"message\":\"\"}\npublished revision sat-smoke-2-rev1 (parent sat-smoke-2)";
        assert_eq!(
            parse_revision_summary(stdout),
            Some("sat-smoke-2-rev1".to_string())
        );
    }

    #[test]
    fn parse_first_json_and_second_json() {
        let stdout = "reflected on run r1 (strategy s): 500 tokens\nrevised strategy JSON:\n{\"v\":1,\"name\":\"New\",\"roles\":{\"agent-0\":\"x\"},\"steps\":[{\"participants\":[\"agent-0\"],\"rounds\":1,\"flow\":\"local\",\"prompt\":\"p\"}],\"finalWriter\":\"agent-0\"}\n{\"event_id\":\"e1\",\"accepted\":true,\"message\":\"\"}\npublished revision s-rev1 (parent s)";
        let first = parse_first_json(stdout).unwrap();
        assert_eq!(first["name"], "New");
        let second = parse_json_at(stdout, 1).unwrap();
        assert_eq!(second["event_id"], "e1");
        assert_eq!(parse_json_at(stdout, 2), None);
    }

    #[test]
    fn error_masking_never_leaks_the_key() {
        let key = "sk-team-test-123";
        std::env::set_var(CLASSIFIER_API_KEY_ENV, key);
        let msg = clean_sidecar_error(
            &format!("boom {key} in stdout"),
            &format!("more {key} in stderr"),
        );
        assert!(!msg.contains(key));
        assert!(msg.contains("***"));
        std::env::remove_var(CLASSIFIER_API_KEY_ENV);
    }
}
