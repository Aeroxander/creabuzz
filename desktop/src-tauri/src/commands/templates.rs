//! `templates_list` / `templates_show` / `templates_apply` Tauri commands —
//! the "Start a project" picker's sidecar surface.
//!
//! These spawn the bundled `buzz` sidecar CLI exactly like `team.rs` /
//! `org_classify.rs`: `buzz templates list --format json`, `buzz templates
//! show <id>`, `buzz templates apply <id> [--resume]`. Relay identity comes
//! from the active workspace override and the signing key from the keyring,
//! mirroring every other sidecar spawn.
//!
//! The CLI prints exactly one JSON value on stdout per invocation (the list
//! array, the template object, or the apply report) — including on partial
//! failure, where the report enumerates every step — so these commands pass
//! that JSON through verbatim (snake_case, the CLI's normalized write shape)
//! and only fall back to a masked error string when no JSON is parseable.
//! A non-zero exit with a parseable report is therefore NOT an error at this
//! boundary: the report's `status` field is authoritative and the frontend
//! renders the partial/resume UI from it.
//!
//! Hard wall-clock timeouts: browsing is local registry work (30s); an apply
//! is a bounded https skill fetch (10s each) plus a relay round-trip per
//! step (180s). The child is killed when the deadline fires.

use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use nostr::ToBech32;
use serde_json::Value;
use tauri::State;

use crate::app_state::AppState;
use crate::managed_agents::resolve_command;
use crate::relay::relay_api_base_url_with_override;

/// Wall-clock cap for `buzz templates list` / `show`.
const TEMPLATES_BROWSE_TIMEOUT: Duration = Duration::from_secs(30);
/// Wall-clock cap for `buzz templates apply` (skill fetches + relay writes).
const TEMPLATES_APPLY_TIMEOUT: Duration = Duration::from_secs(180);

/// Env vars that must never leak into returned/logged output.
const SECRET_ENV_VARS: [&str; 1] = ["BUZZ_PRIVATE_KEY"];

#[tauri::command]
pub async fn templates_list(state: State<'_, AppState>) -> Result<Value, String> {
    let mut command = build_templates_command(&state)?;
    command.arg("list").arg("--format").arg("json");
    let value = run_json(&mut command, TEMPLATES_BROWSE_TIMEOUT)?;
    Ok(value)
}

#[tauri::command]
pub async fn templates_show(id: String, state: State<'_, AppState>) -> Result<Value, String> {
    if id.trim().is_empty() {
        return Err("template id must not be empty".to_string());
    }
    let mut command = build_templates_command(&state)?;
    command.arg("show").arg(&id);
    let value = run_json(&mut command, TEMPLATES_BROWSE_TIMEOUT)?;
    Ok(value)
}

/// Apply (or `--resume`) a template. Returns the CLI's apply report verbatim:
/// `{status, template_id, resumed, steps: [...], failed_step?, welcome?}`.
#[tauri::command]
pub async fn templates_apply(
    id: String,
    resume: bool,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    if id.trim().is_empty() {
        return Err("template id must not be empty".to_string());
    }
    let mut command = build_templates_command(&state)?;
    command.arg("apply").arg(&id);
    if resume {
        command.arg("--resume");
    }
    let value = run_json(&mut command, TEMPLATES_APPLY_TIMEOUT)?;
    Ok(value)
}

/// CLI resolution + stdio wiring + relay identity + keyring signing key
/// (mirrors `team.rs::build_team_base`).
fn build_templates_command(state: &AppState) -> Result<Command, String> {
    let cli = resolve_command("buzz")
        .or_else(|| resolve_command("buzz-dev"))
        .ok_or_else(|| {
            "the buzz CLI is not available; run the app from a workspace build (cargo build -p buzz-cli)"
                .to_string()
        })?;

    let mut command = Command::new(cli);
    command
        .arg("templates")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::util::configure_no_window(&mut command);

    command.env("BUZZ_RELAY_URL", relay_api_base_url_with_override(state));
    let keys = state
        .signing_keys()
        .map_err(|e| format!("no signing key available: {e}"))?;
    let nsec = keys
        .secret_key()
        .to_bech32()
        .map_err(|e| format!("encode nsec: {e}"))?;
    command.env("BUZZ_PRIVATE_KEY", &nsec);
    Ok(command)
}

/// Run the sidecar with a hard timeout and return its stdout JSON. A
/// parseable report is returned even when the child exited non-zero (partial
/// apply); an unparseable failure surfaces the masked error text.
fn run_json(command: &mut Command, timeout: Duration) -> Result<Value, String> {
    let (success, stdout, stderr) = run_buzz_templates(command, timeout)?;
    if let Some(value) = parse_first_json(&stdout) {
        return Ok(value);
    }
    if success {
        return Err("buzz templates produced no JSON output".to_string());
    }
    Err(clean_sidecar_error(&stdout, &stderr))
}

/// Run the sidecar with a hard timeout, draining stdout/stderr on background
/// threads (a chatty CLI must not deadlock on a full pipe). Kills the child
/// when the deadline fires. Mirrors `team.rs::run_buzz_team`.
fn run_buzz_templates(
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
                        "buzz templates timed out after {}s and was stopped",
                        timeout.as_secs()
                    ));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("failed to wait for buzz templates: {e}"));
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

/// Wrap stderr/stdout into a human error message, masking any secret env
/// value that a misbehaving tool echoed back.
fn clean_sidecar_error(stdout: &str, stderr: &str) -> String {
    let secrets: Vec<String> = SECRET_ENV_VARS
        .iter()
        .filter_map(|name| std::env::var(name).ok())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .collect();
    mask_secrets(&format!("{stderr}\n{stdout}"), &secrets)
}

/// Pure masking + trimming seam (tested directly).
fn mask_secrets(combined: &str, secrets: &[String]) -> String {
    let mut combined = combined.to_string();
    for value in secrets {
        combined = combined.replace(value, "***");
    }
    let combined = combined.trim();
    if combined.is_empty() {
        "buzz templates failed with no output".to_string()
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

/// Parse the first complete JSON value in the stdout stream. The CLI prints
/// exactly one JSON value on stdout for every `templates` verb, so this is
/// the report/list/template passthrough. The outermost opener wins, so a
/// list's array is parsed whole rather than one object inside it.
fn parse_first_json(text: &str) -> Option<Value> {
    use serde_json::Deserializer;
    let start = [text.find('{'), text.find('[')]
        .into_iter()
        .flatten()
        .min()?;
    Deserializer::from_str(&text[start..])
        .into_iter::<Value>()
        .next()
        .and_then(Result::ok)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_first_json_reads_object_report() {
        let stdout = "{\"status\":\"partial\",\"steps\":[]}";
        assert_eq!(
            parse_first_json(stdout).unwrap(),
            serde_json::json!({"status": "partial", "steps": []})
        );
    }

    #[test]
    fn parse_first_json_reads_array_list() {
        assert_eq!(
            parse_first_json("[{\"id\":\"demo\"}]").unwrap(),
            serde_json::json!([{ "id": "demo" }])
        );
    }

    #[test]
    fn parse_first_json_tolerates_leading_noise() {
        let stdout = "warning: something\n{\"status\":\"ok\"}";
        assert_eq!(
            parse_first_json(stdout).unwrap(),
            serde_json::json!({"status": "ok"})
        );
    }

    #[test]
    fn parse_first_json_garbage_is_none() {
        assert!(parse_first_json("not json at all").is_none());
    }

    #[test]
    fn error_masking_never_leaks_the_key() {
        let secrets = vec!["secret-abc123".to_string()];
        let msg = mask_secrets("secret-abc123 exploded", &secrets);
        assert!(!msg.contains("secret-abc123"), "{msg}");
        assert!(msg.contains("***"), "{msg}");
    }

    #[test]
    fn parse_first_json_list_is_not_the_inner_object() {
        assert_eq!(
            parse_first_json("[{\"id\":\"demo\"}]").unwrap(),
            serde_json::json!([{ "id": "demo" }])
        );
    }
}
