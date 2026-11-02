//! The per-check container lifecycle for the enforcing sandbox: pre-start
//! gates (a declared credential is refused before any container exists),
//! the durable ownership journal write, the attached run, the bounded wait,
//! the daemon-verified timeout stop, the configuration read-back (now also
//! over the daemon's MOUNTS shape: exactly the one read-only artifact bind,
//! nothing anonymous or unexpected), the verified removal, and the journal
//! closing. Every failure path attempts its own bounded cleanup and leaves
//! either a confirmed-gone container or a named recovery record — never a
//! silent success, never an unrecorded leak.

use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::checks::{now_secs, CheckSpec, RunnerOptions};
use super::runner::CheckOutcome;
use super::sandbox::{
    PreparedSandbox, ReadySandbox, SandboxTelemetry, CONTAINER_LABEL,
    SANDBOX_ARTIFACT_MOUNT, SANDBOX_CPUS, SANDBOX_LOG_DRIVER, SANDBOX_MEMORY_BYTES,
    SANDBOX_PIDS_LIMIT, SANDBOX_TMPFS, SANDBOX_TMPFS_BYTES, SANDBOX_USER,
};
use super::sandbox_ops as ops;
use super::sandbox_ops::CLIENT_KILL_WAIT;
use crate::error::CliError;

// The remaining lifecycle bodies of sandbox.rs, moved here verbatim below
// this header (refs `super::runner::` and `super::sandbox_ops` resolve the
// same at this depth as at the sibling's).

/// Execute one check inside the sandbox. Returns the honest outcome, updates
/// telemetry, and (through telemetry) a containment failure that stops the
/// rest of the run for safety.
pub(crate) fn exec(
    spec: &CheckSpec,
    seq: usize,
    options: &RunnerOptions,
    sandbox: &PreparedSandbox,
    per_check: Duration,
    telemetry: &mut SandboxTelemetry,
) -> Result<CheckOutcome, CliError> {
    let started_at = now_secs();
    match sandbox {
        PreparedSandbox::Ready(ready) => {
            run_container(spec, seq, options, ready, per_check, started_at, telemetry)
        }
        PreparedSandbox::Unavailable(reason) => {
            if telemetry.unavailable_reason.is_none() {
                telemetry.unavailable_reason = Some(reason.clone());
            }
            Ok(CheckOutcome {
                name: spec.name.clone(),
                argv: spec.argv.clone(),
                criterion: spec.criterion,
                note: spec.note.clone(),
                status: super::runner::STATUS_NOT_RUN,
                exit_status: None,
                stdout: String::new(),
                stderr: String::new(),
                stdout_truncated: false,
                stderr_truncated: false,
                started_at,
                ended_at: now_secs(),
                duration_ms: 0,
                failure: Some(format!(
                    "Not run: the sandbox runtime was unavailable when this command \
                     started ({reason}). Nothing ran anywhere, and the result is unknown; \
                     the record keeps it unknown."
                )),
            })
        }
    }
}

/// Unique container identity for THIS run only: the run's owner key, the
/// declared feature label, and a per-run sequence. Names and labels are
/// unique across concurrent runs; cleanup acts on journal entries, never a
/// broad sweep.
fn container_name(seq: usize) -> String {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    use std::sync::atomic::Ordering;
    let index = COUNTER.fetch_add(1, Ordering::Relaxed);
    let _ = seq;
    format!("buzz-wcr-{}-{index}", ops::owner_key())
}

/// The fixed run shape: the TRUSTED supervisor as TRUE PID 1 (no `--init`,
/// no tini — a same-UID check cannot stop it), the deadline it owns first in
/// argv, and ONLY THEN the declared program exactly as declared (the record's
/// argv truth stays `spec.argv`); requested env pairs only, exactly TWO
/// read-only binds (the artifact snapshot and the hash-pinned helper copy),
/// no capabilities, no network, no new privileges, bounded everything, no
/// pull, no other mounts of any kind.
pub(crate) fn container_argv(
    ready: &ReadySandbox,
    name: &str,
    spec: &CheckSpec,
    envs: &[(String, String)],
    deadline_secs: u64,
) -> Vec<String> {
    let mut argv = vec![
        String::from("run"),
        String::from("--pull"),
        String::from("never"),
        String::from("--name"),
        name.to_string(),
        String::from("--label"),
        format!("{CONTAINER_LABEL}=1"),
        String::from("--label"),
        format!("{}={}", ops::OWNER_LABEL, ops::owner_key()),
        String::from("--user"),
        SANDBOX_USER.to_string(),
        String::from("--network"),
        String::from("none"),
        String::from("--read-only"),
        String::from("--cap-drop"),
        String::from("ALL"),
        String::from("--security-opt"),
        String::from("no-new-privileges"),
        String::from("--pids-limit"),
        SANDBOX_PIDS_LIMIT.to_string(),
        String::from("--memory"),
        String::from("128m"),
        String::from("--cpus"),
        SANDBOX_CPUS.to_string(),
        String::from("--tmpfs"),
        SANDBOX_TMPFS.to_string(),
        String::from("--log-driver"),
        SANDBOX_LOG_DRIVER.to_string(),
        // The trusted helper is the entrypoint AND PID 1; the image's own
        // entrypoint is untrusted and never used. The declared program runs
        // as its direct child with its exact argv, SIGKILLed at the deadline
        // through a watchdog the check cannot stop, with the whole PID
        // namespace ending at PID 1's exit even if this CLI process is gone.
        String::from("--entrypoint"),
        ready.supervisor.entrypoint.clone(),
        String::from("-v"),
        format!(
            "{}:{SANDBOX_ARTIFACT_MOUNT}:ro",
            ready.snapshot.dir.display()
        ),
        String::from("-v"),
        format!(
            "{}:{}:ro",
            ready.supervisor.host_copy.display(),
            ready.supervisor.entrypoint,
        ),
        String::from("-w"),
        SANDBOX_ARTIFACT_MOUNT.to_string(),
    ];
    for (key, value) in envs {
        // All options and the env pairs precede the image: docker treats
        // anything after the image as the command, and this env pair must be
        // a flag, not part of the check's argv.
        argv.push(String::from("--env"));
        argv.push(format!("{key}={value}"));
    }
    argv.push(ready.image_id.clone());
    argv.push(deadline_secs.to_string());
    for argument in &spec.argv {
        argv.push(argument.clone());
    }
    argv
}

/// Environment keys that must never reach a container — checked BEFORE any
/// container starts (no artifact-bound process can see one in the first
/// place) and again at read-back; also consulted at image resolution when an
/// image itself declares credential-named defaults.
pub(crate) const CREDENTIAL_ENV_KEYS: &[&str] = &[
    "BUZZ_PRIVATE_KEY",
    "BUZZ_AUTH_TAG",
    "BUZZ_RELAY_URL",
    "BUZZ_SPENDER_KEY",
    "BUZZ_API_TOKEN",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GITHUB_TOKEN",
    "AWS_SECRET_ACCESS_KEY",
];

/// The per-check container lifecycle: pre-start gates → journal → spawn
/// attached → bounded wait → (timeout: stopped via the daemon, verified) →
/// verify config → remove → verify-gone → close the journal entry. `--rm` is
/// deliberately unused so the configuration can be read back before removal.
fn run_container(
    spec: &CheckSpec,
    seq: usize,
    options: &RunnerOptions,
    ready: &ReadySandbox,
    per_check: Duration,
    started_at: u64,
    telemetry: &mut SandboxTelemetry,
) -> Result<CheckOutcome, CliError> {
    let wall = Instant::now();
    // Pre-execution gate: a declared credential pair is refused before any
    // container exists, so nothing artifact-bound can ever see it. This is
    // not a containment failure — a clean refusal.
    for (key, _) in &options.envs {
        if CREDENTIAL_ENV_KEYS.contains(&key.as_str()) {
            telemetry.notes.push(format!(
                "the requested environment key {key:?} is a credential name; the \
                 check {:?} was refused before any container was created",
                spec.name
            ));
            return Ok(not_started_outcome(
                spec,
                started_at,
                wall.elapsed().as_millis() as u64,
                format!(
                    "Refused before it could run: {key:?} is a credential key, and \
                     the sandbox never passes credentials to a check. Fix the \
                     declaration (name it differently or pass it another way)."
                ),
            ));
        }
    }
    let owner = ops::owner_key();
    let name = container_name(seq);
    // The deadline the supervisor owns (a CLI-death backstop; the host kill
    // below remains the authority while this process lives). A sub-second
    // remaining budget still gets a 1s backstop; the host deadline fires
    // first in every case where this process is alive.
    let supervisor_secs = per_check.as_secs().max(1);
    let argv = container_argv(ready, &name, spec, &options.envs, supervisor_secs);

    // Ownership is recorded BEFORE the container exists: a container that
    // cannot be recorded is not created.
    if let Err(reason) = ops::record_owned(&owner, &name, &ready.image_id) {
        containment_fail(
            telemetry,
            format!("the ownership journal for {name:?} could not be written ({reason})"),
            format!(
                "Sandbox note: a container could not be safely created for {:?}; \
                 nothing ran for it. ({reason})",
                spec.name
            ),
        );
        return Ok(not_started_outcome(
            spec,
            started_at,
            wall.elapsed().as_millis() as u64,
            format!(
                "Failed before it could run: the sandbox could not durably record \
                 the container's ownership ({reason}), so no container was created."
            ),
        ));
    }

    let mut child = match ops::spawn_run(&ready.docker_bin, &argv) {
        Ok(child) => child,
        Err(e) => {
            ops::drop_owned(&owner, &name);
            containment_fail(
                telemetry,
                format!(
                    "the sandbox could not start the container for {:?} ({e})",
                    spec.name
                ),
                format!(
                    "Sandbox note: the container for {:?} could not be started ({e}); \
                     nothing ran for it.",
                    spec.name
                ),
            );
            return Ok(not_started_outcome(
                spec,
                started_at,
                wall.elapsed().as_millis() as u64,
                format!(
                    "Failed before it could run ({e}): the sandbox refused to start \
                     the container. It stays failed."
                ),
            ));
        }
    };

    let cap = options.output_cap;
    let stdout_handle = runner4cap::spawn(&mut child.stdout, cap);
    let stderr_handle = runner4cap::spawn(&mut child.stderr, cap);

    let deadline = wall + per_check;
    let mut timed_out = false;
    let exit_code: Option<i64>;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                exit_code = status.code().map(i64::from);
                break;
            }
            Ok(None) => {}
            Err(e) => {
                // The client wait broke: stop the container through the
                // daemon (verified), keep or recover the journal entry, and
                // end the run's safety there.
                runner4cap::stop_child(&mut child);
                let stdout = runner4cap::join(stdout_handle);
                let stderr = runner4cap::join(stderr_handle);
                let (stop_note, stopped) =
                    bounded_stop_and_recover(telemetry, ready, &owner, &name);
                containment_fail(
                    telemetry,
                    format!("could not wait for the container {name:?} ({e})"),
                    format!(
                        "Sandbox note: the container for {:?} could not be waited on; \
                         the record reports failed and the run stops there for safety. \
                         {stop_note}",
                        spec.name
                    ),
                );
                return Ok(CheckOutcome {
                    name: spec.name.clone(),
                    argv: spec.argv.clone(),
                    criterion: spec.criterion,
                    note: spec.note.clone(),
                    status: super::runner::STATUS_FAILED,
                    exit_status: None,
                    stdout: stdout.text,
                    stderr: stderr.text,
                    stdout_truncated: stdout.truncated,
                    stderr_truncated: stderr.truncated,
                    started_at,
                    ended_at: now_secs(),
                    duration_ms: wall.elapsed().as_millis() as u64,
                    failure: Some(format!(
                        "Could not wait for the container ({e}). {stopped} and the \
                         record reports failed."
                    )),
                });
            }
        }
        if !timed_out && Instant::now() >= deadline {
            timed_out = true;
            // Timeout kills the check's whole process namespace THROUGH the
            // daemon. The kill AND the death are verified against the
            // daemon's own answers; a management failure is uncertainty and
            // becomes a containment failure, never "stopped".
            if let Err(reason) = ops::confirm_stopped(&ready.docker_bin, &name) {
                timer_kill_failed(telemetry, ready, &owner, &name, spec, &reason);
                runner4cap::stop_child(&mut child);
                let stdout = runner4cap::join(stdout_handle);
                let stderr = runner4cap::join(stderr_handle);
                return Ok(CheckOutcome {
                    name: spec.name.clone(),
                    argv: spec.argv.clone(),
                    criterion: spec.criterion,
                    note: spec.note.clone(),
                    status: super::runner::STATUS_TIMED_OUT,
                    exit_status: None,
                    stdout: stdout.text,
                    stderr: stderr.text,
                    stdout_truncated: stdout.truncated,
                    stderr_truncated: stderr.truncated,
                    started_at,
                    ended_at: now_secs(),
                    duration_ms: wall.elapsed().as_millis() as u64,
                    failure: Some(format!(
                        "Timed out after {:.1}s, and the container could not be \
                         verified stopped ({reason}). Read everything here as the \
                         contributor's own account; the sandbox was not verified \
                         for this check.",
                        per_check.as_secs_f32()
                    )),
                });
            }
        }
        if timed_out && Instant::now() >= deadline + CLIENT_KILL_WAIT {
            // The docker client has not reported the container's exit after
            // the verified kill. The daemon, however, is still reachable
            // from here: stop and remove THROUGH the daemon and verify both.
            // If that verification lands, enforcement held — the client
            // stall is a reporting failure, not lost containment; the
            // configuration read-back still cannot happen, so the run keeps
            // `sandboxEnforced: false`.
            runner4cap::stop_child(&mut child);
            let stdout = runner4cap::join(stdout_handle);
            let stderr = runner4cap::join(stderr_handle);
            let outcome = match ops::stop_and_remove(&ready.docker_bin, &name) {
                Ok(()) => {
                    ops::drop_owned(&owner, &name);
                    telemetry.notes.push(format!(
                        "the docker client stalled after the timeout kill of {name:?}; \
                         the daemon confirmed the container stopped and removed"
                    ));
                    telemetry.verify_failures += 1;
                    Some(
                        "Timed out, and the client did not report the stop; the daemon \
                         confirmed the container stopped and removed (containment held; \
                         the stuck client is this report's own limitation). Read \
                         everything here as the contributor's own account."
                            .into(),
                    )
                }
                Err(reason) => {
                    record_recovery(telemetry, &owner, &name, &reason);
                    telemetry.containment_failure = Some(format!(
                        "the docker client did not report the stopped container {name:?} \
                         within the bounded wait, and the daemon-side stop/remove could \
                         not be confirmed: {reason}"
                    ));
                    Some(
                        "Timed out, and the sandbox could not confirm the stop (containment \
                         failure). Read everything here as the contributor's own account."
                            .into(),
                    )
                }
            };
            return Ok(CheckOutcome {
                name: spec.name.clone(),
                argv: spec.argv.clone(),
                criterion: spec.criterion,
                note: spec.note.clone(),
                status: super::runner::STATUS_TIMED_OUT,
                exit_status: None,
                stdout: stdout.text,
                stderr: stderr.text,
                stdout_truncated: stdout.truncated,
                stderr_truncated: stderr.truncated,
                started_at,
                ended_at: now_secs(),
                duration_ms: wall.elapsed().as_millis() as u64,
                failure: outcome,
            });
        }
        if timed_out {
            // after kill, poll fast for the client's exit
            std::thread::sleep(Duration::from_millis(25));
        } else {
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    let stdout = runner4cap::join(stdout_handle);
    let stderr = runner4cap::join(stderr_handle);
    let capture_failed = stdout.error.is_some() || stderr.error.is_some();

    // Verify the actual configuration BEFORE removal, then remove and verify
    // it is gone. A mismatch or a failed removal is a containment failure.
    match verify_container(
        ready,
        &name,
        spec,
        &options.envs,
        timed_out,
        supervisor_secs,
    ) {
        Ok(actual) => {
            telemetry.ran_any = true;
            telemetry.verified += 1;
            if telemetry.config.is_none() {
                telemetry.config = Some(actual);
            }
        }
        Err(reason) => {
            telemetry.verify_failures += 1;
            if telemetry.containment_failure.is_none() {
                telemetry.containment_failure = Some(reason.clone());
            }
            telemetry.notes.push(format!(
                "sandbox verification of the container for {:?} failed: {reason}",
                spec.name
            ));
        }
    }
    match ops::stop_and_remove(&ready.docker_bin, &name) {
        Ok(()) => {
            ops::drop_owned(&owner, &name);
            telemetry.containers_stopped_cleanly += 1;
        }
        Err(reason) => {
            record_recovery(telemetry, &owner, &name, &reason);
            telemetry.verify_failures += 1;
            if telemetry.containment_failure.is_none() {
                telemetry.containment_failure = Some(reason.clone());
            }
            telemetry.notes.push(format!(
                "the container {name:?} could not be confirmed removed: {reason}"
            ));
        }
    }

    // Statuses are never rewritten into a pass: a client killed before it
    // reported the container's exit is an unknown result, and a failed
    // output capture is never a silent pass either.
    let (status_word, reason): (&'static str, Option<String>) = if timed_out {
        (
            super::runner::STATUS_TIMED_OUT,
            Some(format!(
                "Timed out after {:.1}s: the container (the check's whole process \
                 namespace, including its forked descendants) was verified stopped \
                 by the daemon and then removed. What it would have shown by now is \
                 unknown, and the record reports it as unknown.",
                per_check.as_secs_f32()
            )),
        )
    } else if exit_code.is_none() {
        (
            super::runner::STATUS_FAILED,
            Some(
                "The docker client was killed before it could report the container's \
                 exit: the result is unknown, and the record keeps it unknown (not a \
                 pass)."
                    .into(),
            ),
        )
    } else if exit_code == Some(0) && !capture_failed {
        (super::runner::STATUS_PASSED, None)
    } else if exit_code == Some(0) && capture_failed {
        (
            super::runner::STATUS_FAILED,
            Some(
                "The container exited with status 0, but the sandbox could not capture \
                 the check's output cleanly; the result is recorded as unknown/failed, \
                 never as a silent pass."
                    .into(),
            ),
        )
    } else {
        (
            super::runner::STATUS_FAILED,
            Some(
                "Exited with a non-zero status. It is failed, and the record keeps it \
                 failed."
                    .to_string(),
            ),
        )
    };
    if capture_failed {
        telemetry.notes.push(format!(
            "output capture for the check {:?} was incomplete ({:?}); the check's \
             recorded output is bounded to what did arrive",
            spec.name,
            stdout
                .error
                .clone()
                .or_else(|| stderr.error.clone())
                .unwrap_or_else(|| "capture ended unknown".into()),
        ));
    }
    Ok(CheckOutcome {
        name: spec.name.clone(),
        argv: spec.argv.clone(),
        criterion: spec.criterion,
        note: spec.note.clone(),
        status: status_word,
        exit_status: exit_code,
        stdout: stdout.text,
        stderr: stderr.text,
        stdout_truncated: stdout.truncated,
        stderr_truncated: stderr.truncated,
        started_at,
        ended_at: now_secs(),
        duration_ms: wall.elapsed().as_millis() as u64,
        failure: reason,
    })
}

/// One "nothing ran, nothing was created" failed outcome.
fn not_started_outcome(
    spec: &CheckSpec,
    started_at: u64,
    duration_ms: u64,
    failure: String,
) -> CheckOutcome {
    CheckOutcome {
        name: spec.name.clone(),
        argv: spec.argv.clone(),
        criterion: spec.criterion,
        note: spec.note.clone(),
        status: super::runner::STATUS_FAILED,
        exit_status: None,
        stdout: String::new(),
        stderr: String::new(),
        stdout_truncated: false,
        stderr_truncated: false,
        started_at,
        ended_at: now_secs(),
        duration_ms,
        failure: Some(failure),
    }
}

/// On a timeout whose daemon-side stop FAILED: containment is marked, the
/// client child is stopped by the caller; what remains is an honest, visible
/// recovery record (the journal entry stays open for the next command) plus
/// a best-effort removal attempt so a fixable case does not wait for it.
fn timer_kill_failed(
    telemetry: &mut SandboxTelemetry,
    ready: &ReadySandbox,
    owner: &str,
    name: &str,
    spec: &CheckSpec,
    reason: &str,
) {
    telemetry.containment_failure = Some(format!(
        "timeout for {name:?}: the container could not be verified stopped ({reason})"
    ));
    match ops::stop_and_remove(&ready.docker_bin, name) {
        Ok(()) => {
            ops::drop_owned(owner, name);
            telemetry.notes.push(format!(
                "after the failed stop verification, a second daemon-side attempt \
                 verified {name:?} stopped and removed; containment stayed marked \
                 because the first answer was uncertainty, not the absence it later \
                 confirmed for {:?}",
                spec.name
            ));
        }
        Err(recover_reason) => {
            record_recovery(telemetry, owner, name, &recover_reason);
        }
    }
}

/// A containment-failure record when stop/remove could not be verified: the
/// journal entry stays open (the next command retries visibly) and the run
/// record names the container.
fn record_recovery(telemetry: &mut SandboxTelemetry, owner: &str, name: &str, reason: &str) {
    if !telemetry.recovery_needed.contains(&name.to_string()) {
        telemetry.recovery_needed.push(name.to_string());
    }
    telemetry.notes.push(format!(
        "the container {name:?} is recorded in the durable ownership journal under \
         {owner:?}; the next work-checks command will retry its removal, and until \
         then its state is: {reason}"
    ));
}

/// Best-effort bounded stop+remove on an error path after containment was
/// already flagged; returns the note and whether the removal was verified
/// (only then does the journal entry close).
fn bounded_stop_and_recover(
    telemetry: &mut SandboxTelemetry,
    ready: &ReadySandbox,
    owner: &str,
    name: &str,
) -> (String, bool) {
    match ops::stop_and_remove(&ready.docker_bin, name) {
        Ok(()) => {
            ops::drop_owned(owner, name);
            (
                format!(
                    "The container {name:?} was verified stopped and removed by the \
                     daemon immediately after."
                ),
                true,
            )
        }
        Err(reason) => {
            record_recovery(telemetry, owner, name, &reason);
            (
                format!(
                    "The container {name:?} could not be confirmed removed ({reason}); \
                         its journal entry stays open for the next command's recovery."
                ),
                false,
            )
        }
    }
}

fn containment_fail(telemetry: &mut SandboxTelemetry, reason: String, note: String) {
    if telemetry.containment_failure.is_none() {
        telemetry.containment_failure = Some(reason);
    }
    telemetry.notes.push(note);
}

/// Read the container's ACTUAL configuration from the daemon and require it
/// to match the enforced shape, field by field — including the mount set:
/// the ONE read-only artifact bind, nothing else. A daemon-supplied writable
/// volume (an image's declared Volumes would create one) is a containment
/// mismatch, caught here as well as refused at prepare time. One mismatch
/// is a containment failure; the verified shape is only recorded when
/// everything matches.
#[allow(clippy::too_many_arguments)]
fn verify_container(
    ready: &ReadySandbox,
    name: &str,
    spec: &CheckSpec,
    envs: &[(String, String)],
    timed_out: bool,
    supervisor_secs: u64,
) -> Result<Value, String> {
    let capture = ops::docker_call(
        &ready.docker_bin,
        &["inspect", "--format", "{{json .}}", name],
        Duration::from_secs(10),
    )
    .map_err(|e| format!("docker inspect: {e}"))?;
    if !capture.ok {
        return Err(format!(
            "the container {name:?} could not be read back from the daemon before \
             removal; enforcement could not be confirmed ({})",
            ops::first_line(&capture)
        ));
    }
    let parsed: Value = serde_json::from_str(capture.stdout.trim())
        .map_err(|e| format!("docker inspect output was not parseable: {e}"))?;
    // `docker inspect` prints one object per target (not a JSON array).
    let inspected = if parsed.is_array() {
        parsed
            .as_array()
            .and_then(|items| items.first())
            .ok_or_else(|| format!("docker inspect returned no container for {name:?}"))?
            .clone()
    } else {
        parsed
    };

    let config = &inspected["Config"];
    let host = &inspected["HostConfig"];
    let mut failures: Vec<String> = Vec::new();
    let str_of = |value: &Value| -> String { value.as_str().unwrap_or_default().to_string() };

    if str_of(&config["Image"]) != ready.image_id {
        failures.push("Config.Image is not the resolved image ID".into());
    }
    if str_of(&host["NetworkMode"]) != "none" {
        failures.push("NetworkMode is not none".into());
    }
    if host["ReadonlyRootfs"].as_bool() != Some(true) {
        failures.push("ReadonlyRootfs is not true".into());
    }
    let cap_drop = host["CapDrop"]
        .as_array()
        .map(|drop| drop.iter().any(|d| str_of(d) == "ALL"))
        .unwrap_or(false);
    if !cap_drop {
        failures.push("CapDrop does not include ALL".into());
    }
    let security = host["SecurityOpt"]
        .as_array()
        .map(|options| options.iter().any(|o| str_of(o) == "no-new-privileges"))
        .unwrap_or(false);
    if !security {
        failures.push("SecurityOpt does not include no-new-privileges".into());
    }
    if host["PidsLimit"].as_i64() != Some(SANDBOX_PIDS_LIMIT as i64) {
        failures.push("PidsLimit is not the fixed bound".into());
    }
    if host["Memory"].as_u64() != Some(SANDBOX_MEMORY_BYTES) {
        failures.push("Memory is not the fixed 128m bound".into());
    }
    if host["NanoCpus"].as_u64() != Some(1_000_000_000) {
        failures.push("the CPU bound is not the fixed 1-cpu bound".into());
    }
    let tmpfs = str_of(&host["Tmpfs"]["/tmp"]);
    if !tmpfs.contains(&format!("size={SANDBOX_TMPFS_BYTES}")) {
        failures.push("the bounded /tmp tmpfs is missing or wrong".into());
    }
    let binds = host["Binds"]
        .as_array()
        .map(|binds| {
            binds
                .iter()
                .map(str_of)
                .filter(|b| !b.is_empty())
                .collect::<Vec<String>>()
        })
        .unwrap_or_default();
    // EXACTLY TWO read-only binds: the artifact snapshot and the hash-pinned
    // trusted supervisor copy. Anything else — a host home, a socket, a
    // writable helper — is a containment failure.
    let expected_binds = [
        format!(
            "{}:{SANDBOX_ARTIFACT_MOUNT}:ro",
            ready.snapshot.dir.display()
        ),
        format!(
            "{}:{}:ro",
            ready.supervisor.host_copy.display(),
            ready.supervisor.entrypoint,
        ),
    ];
    if binds.len() != 2 || binds.as_slice() != expected_binds.as_slice() {
        failures.push(format!(
            "the bind mounts are not exactly the read-only artifact snapshot and \
             the read-only trusted supervisor (expected {expected_binds:?}, found \
             {binds:?})"
        ));
    }
    // The daemon-shaped mount set: exactly the two read-only binds, no
    // daemon-created writable volume, nothing anonymous or unexpected.
    let mounts = inspected["Mounts"].as_array().cloned().unwrap_or_default();
    let mut artifact_binds = 0usize;
    let mut supervisor_binds = 0usize;
    for mount in &mounts {
        let kind = str_of(&mount["Type"]);
        let destination = str_of(&mount["Destination"]);
        let rw = mount["RW"].as_bool().unwrap_or(true);
        match (kind.as_str(), destination.as_str()) {
            ("bind", d) if d == SANDBOX_ARTIFACT_MOUNT => {
                artifact_binds += 1;
                if rw {
                    failures.push("the artifact bind is not read-only at the daemon".into());
                }
                if str_of(&mount["Source"]) != ready.snapshot.dir.display().to_string() {
                    failures.push("the artifact bind's source is not the snapshot".into());
                }
            }
            ("bind", d) if d == ready.supervisor.entrypoint => {
                supervisor_binds += 1;
                if rw {
                    failures.push(
                        "the trusted supervisor bind is not read-only at the daemon"
                            .into(),
                    );
                }
                if str_of(&mount["Source"])
                    != ready.supervisor.host_copy.display().to_string()
                {
                    failures.push(
                        "the trusted supervisor bind's source is not the prepared \
                         private hash-pinned copy"
                            .into(),
                    );
                }
            }
            ("tmpfs", "/tmp") => {}
            (other, destination) => {
                failures.push(format!(
                    "the container carries an unexpected {other} mount at \
                     {destination:?}; the only other allowed surfaces are the \
                     bounded /tmp tmpfs and the two read-only binds"
                ));
            }
        }
    }
    if mounts.is_empty() || artifact_binds != 1 || supervisor_binds != 1 {
        failures.push(format!(
            "the mount set is not exactly the two read-only binds (got \
             artifact={artifact_binds}, supervisor={supervisor_binds}, \
             total={}/{})",
            artifact_binds + supervisor_binds,
            mounts.len()
        ));
    }
    if str_of(&config["User"]) != SANDBOX_USER {
        failures.push("the container user is not the fixed non-root user".into());
    }
    // The trusted supervisor IS pid 1: Docker's own init must be absent. A
    // --init container would wrap the helper in tini and no longer satisfy
    // the stop-resistance shape that was verified.
    if host["Init"].as_bool() == Some(true) {
        failures.push(
            "the container runs Docker's --init shim; the trusted supervisor must \
             BE the pid 1 itself (the verified stop-resistant shape is refused \
             with anything else)"
                .into(),
        );
    }
    let entrypoint = config["Entrypoint"]
        .as_array()
        .and_then(|e| e.first())
        .map(&str_of)
        .unwrap_or_default();
    if entrypoint != ready.supervisor.entrypoint {
        failures.push(
            "the entrypoint is not the trusted supervisor at its fixed read-only \
             path"
                .into(),
        );
    }
    let command_words = config["Cmd"]
        .as_array()
        .map(|c| c.iter().map(str_of).collect::<Vec<String>>())
        .unwrap_or_default();
    // The supervisor's OWN argv is the deadline it owns first, then the
    // declared program exactly as declared (the record's argv truth is
    // spec.argv; supervision is a wrapper, not a rewrite).
    let mut expected_cmd = vec![supervisor_secs.to_string()];
    expected_cmd.extend(spec.argv.iter().cloned());
    if command_words != expected_cmd {
        failures.push(
            "the container's command is not the deadline first and the declared \
             argv after it (supervision is a wrapper, not a rewrite)"
                .into(),
        );
    }
    // Container env: the image's own declared defaults plus the requested
    // pairs — never this process's environment, never a credential key.
    let container_env = config["Env"]
        .as_array()
        .map(|e| e.iter().map(str_of).collect::<Vec<String>>())
        .unwrap_or_default();
    let requested: std::collections::HashSet<&str> = envs.iter().map(|(k, _)| k.as_str()).collect();
    let image_defaults: std::collections::HashSet<&str> =
        ready.image_env_keys.iter().map(String::as_str).collect();
    let mut env_extras: Vec<String> = Vec::new();
    for entry in &container_env {
        if let Some((key, _)) = entry.split_once('=') {
            if key == "PATH" || requested.contains(key) || image_defaults.contains(key) {
                continue;
            }
            env_extras.push(key.to_string());
        }
    }
    if !env_extras.is_empty() {
        failures.push(format!(
            "the container environment carries keys beyond the image defaults and the \
             request: {env_extras:?}"
        ));
    }
    for denied in CREDENTIAL_ENV_KEYS {
        if container_env
            .iter()
            .any(|entry| entry.split('=').next() == Some(*denied))
        {
            failures.push(format!(
                "a credential environment key {denied} leaked into the container"
            ));
        }
    }
    if host["Privileged"].as_bool() == Some(true) {
        failures.push("the container is privileged".into());
    }
    if str_of(&host["LogConfig"]["Type"]) != SANDBOX_LOG_DRIVER {
        failures.push("the log driver is not none (daemon-side logs would persist)".into());
    }
    if timed_out && str_of(&inspected["State"]["Status"]) == "running" {
        failures.push("the container was still running after its timeout stop".into());
    }

    if let Some(first) = failures.first() {
        return Err(first.clone());
    }
    // The verified shape, bounded, recorded.
    Ok(json!({
        "user": SANDBOX_USER,
        "imageId": ready.image_id,
        "network": "none",
        "rootfs": "read-only",
        "capDrop": "ALL",
        "noNewPrivileges": true,
        "pidsLimit": SANDBOX_PIDS_LIMIT,
        "memoryBytes": SANDBOX_MEMORY_BYTES,
        "cpus": SANDBOX_CPUS,
        "tmpfs": { "/tmp": { "sizeBytes": SANDBOX_TMPFS_BYTES } },
        "artifactMount": format!("{SANDBOX_ARTIFACT_MOUNT}:ro"),
        "logDriver": SANDBOX_LOG_DRIVER,
        "initPid1": true,
        "supervisor": ready.supervisor.entrypoint,
        "envCarried": envs.iter().map(|(k, _)| k.clone()).collect::<Vec<_>>(),
    }))
}

/// Small private re-exports for the wait loops (spawn/join bounded, named to
/// be obviously about capture): keeps the run loop readable.
mod runner4cap {
    use super::super::runner;
    use std::process::Child;
    use std::time::{Duration, Instant};
    /// spawn a bounded reader over one child stream.
    pub(super) fn spawn<R>(pipe: &mut Option<R>, cap: usize) -> runner::ReaderHandle
    where
        R: std::io::Read + Send + 'static,
    {
        runner::spawn_reader(pipe.take(), cap)
    }
    /// join a bounded reader, quietly.
    pub(super) fn join(handle: runner::ReaderHandle) -> runner::CappedRead {
        runner::join_reader(handle, Duration::from_secs(10))
    }
    /// Kill the docker client child and reap it on a bounded schedule — no
    /// unbounded `wait()` and no unbounded reader join on a failed path.
    pub(super) fn stop_child(child: &mut Child) {
        let deadline = Instant::now() + Duration::from_secs(2);
        let _ = child.kill();
        loop {
            match child.try_wait() {
                Ok(Some(_)) | Err(_) => break,
                Ok(None) => {
                    if Instant::now() >= deadline {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
        }
    }
}
