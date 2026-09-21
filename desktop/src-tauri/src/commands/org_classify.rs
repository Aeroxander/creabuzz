//! `org_classify_*` Tauri commands — the "Draft contribution" affordances.
//!
//! These spawn the bundled `buzz` sidecar CLI (`org contribute classify
//! --task <id> [--publish]` / `--all-done`) with the classifier environment
//! (`BUZZ_CLASSIFIER_API_URL` / `_API_KEY` / `_MODEL`). The classifier key is
//! passed **only** to the child process environment — it is never logged,
//! never persisted, and never returned to the webview. Relay identity
//! (`BUZZ_RELAY_URL`) comes from the active workspace override and the signing
//! key (`BUZZ_PRIVATE_KEY`) from the keyring, mirroring how managed agents
//! launch sidecars (`managed_agents/runtime.rs`).
//!
//! Every invocation is bounded by a hard wall-clock timeout and the child is
//! killed when that fires, so a slow or adversarial classifier/relay can
//! never pin a command thread indefinitely.

use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use nostr::ToBech32;
use serde::Serialize;
use tauri::State;

use crate::app_state::AppState;
use crate::managed_agents::resolve_command;
use crate::relay::relay_api_base_url_with_override;

/// Wall-clock cap for one sidecar invocation.
const CLASSIFY_TIMEOUT: Duration = Duration::from_secs(60);

/// Classifier env vars passed through to the sidecar only.
const CLASSIFIER_API_URL_ENV: &str = "BUZZ_CLASSIFIER_API_URL";
const CLASSIFIER_API_KEY_ENV: &str = "BUZZ_CLASSIFIER_API_KEY";
const CLASSIFIER_MODEL_ENV: &str = "BUZZ_CLASSIFIER_MODEL";

/// Env vars that must never leak into returned/logged output.
const SECRET_ENV_VARS: [&str; 2] = [CLASSIFIER_API_KEY_ENV, "BUZZ_PRIVATE_KEY"];

/// Result of a single-task classify invocation.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgClassifyResult {
    /// `"preview"` (draft JSON returned, nothing published) or `"published"`.
    pub mode: String,
    /// Task event id the record was drafted for (`d` tag of the record).
    pub task_event_id: String,
    /// The validated draft content (preview mode only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub draft: Option<serde_json::Value>,
    /// Published record event id (publish mode only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_id: Option<String>,
}

/// One per-task line from a batch run.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgClassifyBatchTask {
    /// `"ok"`, `"skip"`, or `"fail"` (mirrors the CLI line prefix).
    pub status: String,
    /// `ok` → `"published <event-id>"`, `skip`/`fail` → a short note.
    pub detail: String,
    /// The raw summary line as printed by the CLI.
    pub line: String,
}

/// Result of an `--all-done` batch run (the CLI continues on per-task error).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgClassifyBatchResult {
    pub ok: usize,
    pub skipped: usize,
    pub failed: usize,
    pub tasks: Vec<OrgClassifyBatchTask>,
}

#[tauri::command]
pub async fn org_classify_task(
    task_event_id: String,
    publish: bool,
    state: State<'_, AppState>,
) -> Result<OrgClassifyResult, String> {
    let mut command = build_classify_command(&state)?;
    command.arg("--task").arg(&task_event_id);
    if publish {
        command.arg("--publish");
    }
    let (success, stdout, stderr) = run_buzz_classify(&mut command)?;
    if !success {
        return Err(clean_sidecar_error(&stdout, &stderr));
    }
    if publish {
        let event_id = parse_first_json(&stdout)
            .and_then(|v| v.as_object().and_then(|o| o.get("event_id")).cloned())
            .and_then(|v| v.as_str().map(str::to_string));
        let event_id = event_id.ok_or_else(|| {
            "classifier published but the CLI did not return an event id; see relay logs"
                .to_string()
        })?;
        Ok(OrgClassifyResult {
            mode: "published".to_string(),
            task_event_id,
            draft: None,
            event_id: Some(event_id),
        })
    } else {
        let draft = parse_first_json(&stdout).ok_or_else(|| {
            format!(
                "classifier produced no draft output\n{}",
                trim_for_error(&stdout)
            )
        })?;
        Ok(OrgClassifyResult {
            mode: "preview".to_string(),
            task_event_id,
            draft: Some(draft),
            event_id: None,
        })
    }
}

#[tauri::command]
pub async fn org_classify_all_done(
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> Result<OrgClassifyBatchResult, String> {
    let mut command = build_classify_command(&state)?;
    command.arg("--all-done");
    if let Some(limit) = limit {
        command.arg("--limit").arg(limit.to_string());
    }
    let (success, stdout, stderr) = run_buzz_classify(&mut command)?;
    let result = parse_batch_result(&stdout);
    if !success && result.tasks.is_empty() {
        // No per-task lines at all: the process failed before any task ran
        // (e.g. missing classifier config or an unreachable relay).
        return Err(clean_sidecar_error(&stdout, &stderr));
    }
    // Per-task failures are surfaced inline (ok/failed counts), so a
    // partial failure is still a structured result — the CLI exit code 2
    // only says "at least one task failed".
    Ok(result)
}

/// Resolve the bundled CLI and compose the shared env (relay identity,
/// signing key, classifier env) — nothing key-related ever leaves this
/// function except into the child process environment.
fn build_classify_command(state: &AppState) -> Result<Command, String> {
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
        .args(["org", "contribute", "classify"])
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
/// threads (a chatty classifier must not deadlock on a full pipe). Kills the
/// child when the deadline fires.
fn run_buzz_classify(command: &mut Command) -> Result<(bool, String, String), String> {
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
                if started.elapsed() > CLASSIFY_TIMEOUT {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = stdout_thread.join();
                    let _ = stderr_thread.join();
                    return Err(format!(
                        "classifier timed out after {}s and was stopped",
                        CLASSIFY_TIMEOUT.as_secs()
                    ));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("failed to wait for the classifier: {e}"));
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
        "classifier failed with no output".to_string()
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

/// Parse the first complete JSON value in a stream (the CLI prints one JSON
/// value per invocation — the draft in preview mode, the write response in
/// publish mode — followed by human text).
fn parse_first_json(text: &str) -> Option<serde_json::Value> {
    use serde_json::Deserializer;
    Deserializer::from_str(text)
        .into_iter::<serde_json::Value>()
        .next()
        .and_then(Result::ok)
}

/// Parse the per-task summary lines of a batch run (falls back to zeros when
/// the CLI shape changes — the summary line text is still surfaced raw).
fn parse_batch_result(stdout: &str) -> OrgClassifyBatchResult {
    let mut result = OrgClassifyBatchResult {
        ok: 0,
        skipped: 0,
        failed: 0,
        tasks: Vec::new(),
    };
    for line in stdout.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("[ok]") {
            result.ok += 1;
            let rest = rest.trim();
            let detail = rest
                .rsplit_once(" -> published ")
                .map(|(_, event_id)| format!("published {event_id}"))
                .unwrap_or_else(|| "drafted".to_string());
            result.tasks.push(OrgClassifyBatchTask {
                status: "ok".to_string(),
                detail,
                line: line.to_string(),
            });
        } else if line.starts_with("[skip]") {
            result.skipped += 1;
            result.tasks.push(OrgClassifyBatchTask {
                status: "skip".to_string(),
                detail: "record already exists".to_string(),
                line: line.to_string(),
            });
        } else if let Some(rest) = line.strip_prefix("[fail]") {
            result.failed += 1;
            result.tasks.push(OrgClassifyBatchTask {
                status: "fail".to_string(),
                detail: rest.trim().to_string(),
                line: line.to_string(),
            });
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_preview_draft_from_stream_output() {
        let stdout = "{\n  \"action\": \"Refactored retries\",\n  \"dimensions\": {\"build\": 0.8},\n  \"humanVsAi\": {\"human\": 0.7, \"ai\": 0.3},\n  \"reviewStatus\": \"pending\"\n}\npreview only; pass --publish to sign and publish (d=abc)";
        let value = parse_first_json(stdout).unwrap_or_else(|| panic!("draft parses"));
        assert_eq!(value["action"], "Refactored retries");
        assert_eq!(value["reviewStatus"], "pending");
    }

    #[test]
    fn parses_published_event_id_from_write_response() {
        let stdout = "{\"event_id\":\"aabbcc\",\"accepted\":true,\"message\":\"\"}";
        let value = parse_first_json(stdout).unwrap_or_else(|| panic!("response parses"));
        assert_eq!(value["event_id"], "aabbcc");
    }

    #[test]
    fn parses_batch_summary_lines_and_counts() {
        let stdout = "[ok]     1234abcd Ship it -> published aabbcc\n[skip]    deadbeef Old task (37013 record with d = task id already exists)\n[fail]    cafebabe Broken task: classifier API error 500\nbatch summary: 1 drafted, 1 skipped (record exists), 1 failed";
        let result = parse_batch_result(stdout);
        assert_eq!(result.ok, 1);
        assert_eq!(result.skipped, 1);
        assert_eq!(result.failed, 1);
        assert_eq!(result.tasks.len(), 3);
        assert_eq!(result.tasks[0].detail, "published aabbcc");
        assert_eq!(result.tasks[1].status, "skip");
        assert!(result.tasks[2].detail.contains("classifier API error"));
    }

    #[test]
    fn empty_batch_output_is_zeroes() {
        let result = parse_batch_result("");
        assert_eq!(result.ok, 0);
        assert_eq!(result.failed, 0);
        assert!(result.tasks.is_empty());
    }

    #[test]
    fn error_masking_never_leaks_the_key() {
        let key = "sk-test-1234567890";
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
