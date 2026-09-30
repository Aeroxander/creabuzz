//! `org_ragequit` Tauri command — the "Exit (ragequit)" affordance on a
//! bound org (NIP-ORG "Opt-in onchain binding").
//!
//! Spawns the bundled `buzz` sidecar CLI (`org ragequit --dao <address>
//! [--shares N] [--token <addr>]`) with the value-layer environment
//! (`BUZZ_EVM_RPC_URL` / `BUZZ_SPENDER_KEY`). Those keys are passed **only**
//! to the child process environment — never logged, never persisted, never
//! returned to the webview. Sidecar pattern and bounds mirror
//! `org_classify.rs`: hard wall-clock timeout, drained pipes, secret
//! masking on error paths.
//!
//! DEV mapping (documented simplification): the configured spender key IS
//! the shareholder. The Nostr-holder ↔ EVM identity mapping is a protocol
//! question resolved by the later governance/DAO-proposal handover.

use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::managed_agents::resolve_command;

/// Wall-clock cap for one sidecar invocation (a ragequit waits for a
/// receipt; give it more room than a classify call).
const RAGEQUIT_TIMEOUT: Duration = Duration::from_secs(90);

/// Value-layer env vars passed through to the sidecar only.
const EVM_RPC_URL_ENV: &str = "BUZZ_EVM_RPC_URL";
const SPENDER_KEY_ENV: &str = "BUZZ_SPENDER_KEY";

/// Env vars that must never leak into returned/logged output.
const SECRET_ENV_VARS: [&str; 3] = [SPENDER_KEY_ENV, "BUZZ_PRIVATE_KEY", "BUZZ_NSEC"];

/// Whether the value-layer environment is configured for the exit flow.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgEvmStatus {
    /// `BUZZ_EVM_RPC_URL` is set.
    pub rpc_configured: bool,
    /// `BUZZ_SPENDER_KEY` is set.
    pub spender_configured: bool,
}

/// Result of a ragequit sidecar run.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgRagequitResult {
    /// Transaction hash of the settled `ragequit` call, `0x`-prefixed.
    pub tx_hash: String,
    /// The DAO contract address the exit was executed against.
    pub dao: String,
    /// Shares burned (decimal string — uint256 can exceed JS safe ints).
    pub shares_burned: String,
    /// Remaining shares/loot holdings after the burn (remainingOf-style
    /// member view read from the DAO's token registry).
    pub shares_remaining: String,
    pub loot_remaining: String,
}

#[tauri::command]
pub async fn org_evm_status() -> Result<OrgEvmStatus, String> {
    Ok(OrgEvmStatus {
        rpc_configured: env_var_trimmed(EVM_RPC_URL_ENV).is_some(),
        spender_configured: env_var_trimmed(SPENDER_KEY_ENV).is_some(),
    })
}

#[tauri::command]
pub async fn org_ragequit(
    dao: String,
    shares: Option<String>,
    tokens: Vec<String>,
) -> Result<OrgRagequitResult, String> {
    let mut command = build_ragequit_command(&dao, shares.as_deref(), &tokens)?;
    let (success, stdout, stderr) = run_buzz_ragequit(&mut command)?;
    if !success {
        return Err(clean_sidecar_error(&stdout, &stderr));
    }
    parse_ragequit_output(&stdout).ok_or_else(|| {
        format!(
            "ragequit succeeded but the CLI output was not parseable\n{}",
            trim_for_error(&stdout)
        )
    })
}

/// Resolve the bundled CLI and compose the sidecar env. The spender key
/// never leaves this function except into the child process environment.
fn build_ragequit_command(
    dao: &str,
    shares: Option<&str>,
    tokens: &[String],
) -> Result<Command, String> {
    // Fail closed on missing value-layer config BEFORE spawning: the hint
    // is the affordance contract ("configure EVM key", no gates).
    let rpc_url = env_var_trimmed(EVM_RPC_URL_ENV).ok_or_else(|| {
        format!(
            "{EVM_RPC_URL_ENV} is not configured — set the EVM node URL to enable the exit flow"
        )
    })?;
    let spender_key = env_var_trimmed(SPENDER_KEY_ENV).ok_or_else(|| {
        format!("{SPENDER_KEY_ENV} is not configured — the value-layer key IS the shareholder (dev mapping)")
    })?;

    let cli = resolve_command("buzz")
        .or_else(|| resolve_command("buzz-dev"))
        .ok_or_else(|| {
            "the buzz CLI is not available; run the app from a workspace build (cargo build -p buzz-cli)"
                .to_string()
        })?;

    let mut command = Command::new(cli);
    command
        .args(["org", "ragequit", "--dao", dao])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(shares) = shares {
        command.arg("--shares").arg(shares);
    }
    for token in tokens {
        command.arg("--token").arg(token);
    }
    crate::util::configure_no_window(&mut command);

    command.env(EVM_RPC_URL_ENV, &rpc_url);
    command.env(SPENDER_KEY_ENV, &spender_key);
    Ok(command)
}

/// Run the sidecar with a hard timeout, draining stdout/stderr on background
/// threads (a chatty CLI must not deadlock on a full pipe). Kills the child
/// when the deadline fires.
fn run_buzz_ragequit(command: &mut Command) -> Result<(bool, String, String), String> {
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
                if started.elapsed() > RAGEQUIT_TIMEOUT {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = stdout_thread.join();
                    let _ = stderr_thread.join();
                    return Err(format!(
                        "ragequit timed out after {}s and was stopped; check the DAO for a \
                         settled transaction before retrying",
                        RAGEQUIT_TIMEOUT.as_secs()
                    ));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("failed to wait for the ragequit: {e}"));
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
        "ragequit failed with no output".to_string()
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

/// Parse the CLI's two JSON lines: the settlement summary (txHash, dao,
/// burned) and the remainingOf-style member view (sharesRemaining,
/// lootRemaining).
fn parse_ragequit_output(stdout: &str) -> Option<OrgRagequitResult> {
    let mut values: Vec<serde_json::Value> = serde_json::Deserializer::from_str(stdout)
        .into_iter::<serde_json::Value>()
        .filter_map(Result::ok)
        .collect();
    values.reverse();
    let summary = values
        .iter()
        .find(|v| {
            v.get("txHash").is_some() && v.get("status").and_then(|s| s.as_str()) == Some("ok")
        })?
        .clone();
    let member_view = values.iter().find_map(|v| v.get("memberView")).cloned();
    let tx_hash = summary.get("txHash")?.as_str()?.to_string();
    let dao = summary
        .get("dao")
        .and_then(|d| d.as_str())
        .unwrap_or_default()
        .to_string();
    let shares_burned = summary
        .get("burned")
        .and_then(|b| b.get("shares"))
        .and_then(|s| s.as_str())
        .unwrap_or_default()
        .to_string();
    let shares_remaining = member_view
        .as_ref()
        .and_then(|m| m.get("sharesRemaining"))
        .and_then(|s| s.as_str())
        .unwrap_or_default()
        .to_string();
    let loot_remaining = member_view
        .as_ref()
        .and_then(|m| m.get("lootRemaining"))
        .and_then(|s| s.as_str())
        .unwrap_or_default()
        .to_string();
    Some(OrgRagequitResult {
        tx_hash,
        dao,
        shares_burned,
        shares_remaining,
        loot_remaining,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_settlement_and_member_view_from_stream_output() {
        let stdout = concat!(
            "{\"status\":\"ok\",\"txHash\":\"0xabc\",\"dao\":\"0xdao\",",
            "\"burned\":{\"shares\":\"700\",\"loot\":\"0\"},\"tokens\":[\"0x00\"]}\n",
            "{\"memberView\":{\"dao\":\"0xdao\",\"sharesToken\":\"0x11\",",
            "\"lootToken\":\"0x22\",\"sharesRemaining\":\"300\",\"lootRemaining\":\"5\"}}\n",
            "second line is the member view"
        );
        let result = parse_ragequit_output(stdout).expect("parses");
        assert_eq!(result.tx_hash, "0xabc");
        assert_eq!(result.dao, "0xdao");
        assert_eq!(result.shares_burned, "700");
        assert_eq!(result.shares_remaining, "300");
        assert_eq!(result.loot_remaining, "5");
    }

    #[test]
    fn missing_member_view_is_not_a_failure() {
        let stdout = "{\"status\":\"ok\",\"txHash\":\"0xabc\",\"burned\":{\"shares\":\"700\"}}";
        let result = parse_ragequit_output(stdout).expect("parses");
        assert_eq!(result.tx_hash, "0xabc");
        assert_eq!(result.shares_remaining, "");
    }

    #[test]
    fn output_without_a_settlement_line_is_none() {
        assert!(parse_ragequit_output("boom").is_none());
    }

    #[test]
    fn error_masking_never_leaks_the_spender_key() {
        let key = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
        std::env::set_var(SPENDER_KEY_ENV, key);
        let msg = clean_sidecar_error(
            &format!("boom {key} in stdout"),
            &format!("more {key} in stderr"),
        );
        assert!(!msg.contains(key));
        assert!(msg.contains("***"));
        std::env::remove_var(SPENDER_KEY_ENV);
    }
}
