//! The enforcing local Docker sandbox for check execution — the ONLY
//! execution path of `work-checks`. There is no host-execution fallback and
//! no escape valve: a locally available image is mandatory (resolved to its
//! immutable ID and run with `--pull never`), the declared checks run as argv
//! inside non-root containers with a fixed, non-negotiable shape —
//! `--network none`, read-only rootfs, `--cap-drop ALL`,
//! `--security-opt no-new-privileges`, `--pids-limit`, `--memory`, `--cpus`,
//! one bounded tmpfs, `--log-driver none`, Docker's own `--init` pid1 — and
//! the artifact reaches the container only as a bounded read-only snapshot
//! of regular files.
//!
//! `sandboxEnforced` is `true` only when a container actually ran AND the
//! daemon's read-back of its configuration matched every expected field; one
//! mismatch is a containment failure that stops the run for safety. A
//! timeout kills and removes the *container* (the check's whole process
//! namespace), never merely the docker client, and the kill, the stop, and
//! the removal are each verified against the daemon's own answers — a
//! management failure is uncertainty, never "gone" or "stopped".
//!
//! **The in-container deadline supervisor.** A genre of failure where this
//! CLI dies mid-run would leave a container running under its own bounds.
//! Every check therefore runs under a verified pid-1 supervisor: Docker's
//! built-in `--init` (its own shim) plus the image's busybox `/usr/bin/
//! timeout` wrapping the declared program with `-s KILL <deadline>`. The
//! profile is probe-verified against THIS daemon at prepare time (usage
//! dialect plus an actual enforced kill); a runtime where the probe fails is
//! refused and nothing runs. The declared argv stays the record's program
//! truth; supervision is a wrapper, not a rewrite.
//!
//! **Ownership.** Every created container — checks and supervisor probes — is
//! recorded in a durable ownership journal (keyed by this run's unique owner)
//! BEFORE it exists, and the entry is closed only after its removal is
//! confirmed. A container whose removal could not be confirmed keeps its
//! journal entry and the record names it for visible retry. Cleanup at a
//! command's start removes only journal-owned *finished* containers of this
//! owner or of a verified-dead owner; running containers, however labelled,
//! are never swept, and nothing without a journal entry is touched.
//!
//! Everything is argv to the docker CLI — no shell, no credential or
//! docker-config changes, no implicit pull (an absent local image is an
//! error, never a pull), no Docker socket into the container, no host home,
//! no extra flags, no `--privileged`, no host network.

use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};

use super::sandbox_ops as ops;
/// The probe-verified in-container deadline supervisor shape; the sandbox's
/// own ReadySandbox carries it and the tests bind its exact tokens.
pub(crate) use super::sandbox_ops::SupervisorProfile;
use super::snapshot::{snapshot_artifact, Snapshot};
use crate::error::CliError;

/// Fixed, non-negotiable sandbox shape — not configurable: configurable
/// confinement gets configured wrong, and these bounds are what the record
/// claims. `use super::sandbox::{...}` from runner/test code re-exports.
pub(crate) const SANDBOX_USER: &str = "65534:65534";
pub(crate) const SANDBOX_TMPFS: &str = "/tmp:rw,size=33554432";
pub(crate) const SANDBOX_TMPFS_BYTES: u64 = 33_554_432;
pub(crate) const SANDBOX_PIDS_LIMIT: u64 = 32;
pub(crate) const SANDBOX_MEMORY_BYTES: u64 = 128 * 1024 * 1024;
pub(crate) const SANDBOX_CPUS: &str = "1";
pub(crate) const SANDBOX_LOG_DRIVER: &str = "none";
/// The fixed read-only mount point of the artifact snapshot in the container.
pub(crate) const SANDBOX_ARTIFACT_MOUNT: &str = "/artifact";
pub(crate) const CONTAINER_LABEL: &str = "buzz.work-check-run";
const IMAGE_ID_TAIL: usize = 64;

/// The image as resolved locally: the immutable ID the containers run.
pub(crate) struct SandboxImage {
    pub reference: String,
    pub image_id: String,
    /// ENV keys the image itself declares; these are defaults of the chosen
    /// image, not of this process.
    pub image_env_keys: Vec<String>,
}

#[derive(Debug)]
pub(crate) enum PreparedSandbox {
    /// The verified runtime pair, boxed so the offline `Unavailable` variant
    /// (the common failure path) never carries the big struct's weight.
    Ready(Box<ReadySandbox>),
    Unavailable(String),
}

#[derive(Debug)]
pub(crate) struct ReadySandbox {
    pub docker_bin: String,
    pub reference: String,
    pub image_id: String,
    pub image_env_keys: Vec<String>,
    pub snapshot: Snapshot,
    /// The probe-verified in-container deadline supervisor.
    pub supervisor: SupervisorProfile,
}

/// Telemetry across the run. `enforced_verified` (computed by `record_telemetry`)
/// is `true` only when a container actually ran AND every running container
/// passed the configuration read-back AND no containment failure occurred.
#[derive(Default, Debug)]
pub(crate) struct SandboxTelemetry {
    pub ran_any: bool,
    /// Successful config read-backs (one shape is recorded).
    pub verified: usize,
    pub verify_failures: usize,
    pub config: Option<Value>,
    /// Honest, bounded notes the record's limitations carry.
    pub notes: Vec<String>,
    pub budget_skips: usize,
    pub containers_stopped_cleanly: usize,
    pub containment_failure: Option<String>,
    pub unavailable_reason: Option<String>,
    /// Containers this run created whose removal could not be confirmed;
    /// journal entries stay open and the next command's cleanup retries.
    pub recovery_needed: Vec<String>,
}

impl SandboxTelemetry {
    /// The record's `sandboxEnforced` truth: only verified confinement counts.
    pub fn enforced_verified(&self) -> bool {
        self.ran_any
            && self.verify_failures == 0
            && self.containment_failure.is_none()
            && self.unavailable_reason.is_none()
            && self.verified > 0
    }

    /// The bounded `sandbox` block the record carries.
    pub fn sandbox_json(&self, ready: Option<&ReadySandbox>) -> Value {
        let mut body = json!({
            "runtime": "docker",
            "enforced": self.enforced_verified(),
            "logDriver": SANDBOX_LOG_DRIVER,
        });
        if let Some(ready) = ready {
            body["image"] = json!(ready.reference);
            body["imageId"] = json!(ready.image_id);
            body["supervisor"] = json!({
                "kind": "trusted-rust-pid1-v1 (standalone operator-built helper, \
                         true PID 1; a same-UID check cannot stop the watchdog)",
                "entrypoint": ready.supervisor.entrypoint,
                "hostCopyHashCheck": "the private copy that is bound read-only is \
                                      re-hashed at prepare and must equal the \
                                      manifest's pinned binary",
                "sourceSha256": ready.supervisor.source_sha256,
                "binarySha256": ready.supervisor.binary_sha256,
                "sizeBytes": ready.supervisor.size_bytes,
                "bind": format!(
                    "{}:ro (read-only, the only helper mount)",
                    ready.supervisor.host_copy.display()
                ),
                "verified": "executed in an enforced container and proven against \
                             the exact malicious stop-every-other-process repro at \
                             prepare; a failed probe refuses the whole sandbox",
                "deadlineExit": 124,
            });
            body["snapshot"] = json!({
                "files": ready.snapshot.files,
                "bytes": ready.snapshot.bytes,
                "digest": ready.snapshot.digest,
            });
            body["user"] = json!(SANDBOX_USER);
            body["bounds"] = json!({
                "network": "none",
                "rootfs": "read-only",
                "capDrop": "ALL",
                "noNewPrivileges": true,
                "pidsLimit": SANDBOX_PIDS_LIMIT,
                "memoryBytes": SANDBOX_MEMORY_BYTES,
                "cpus": SANDBOX_CPUS,
                "tmpfs": { "/tmp": { "sizeBytes": SANDBOX_TMPFS_BYTES } },
                "artifactMount": format!("{SANDBOX_ARTIFACT_MOUNT}:ro"),
            });
        }
        if let Some(value) = &self.config {
            body["verifiedConfigExample"] = value.clone();
        }
        if let Some(reason) = &self.unavailable_reason {
            body["unavailableReason"] = json!(reason);
        }
        if !self.recovery_needed.is_empty() {
            body["recovery"] = json!(self.recovery_needed);
        }
        body
    }
}

/// Prepare the sandbox: daemon availability, the image, the trusted deadline
/// supervisor (operator-provided, hash-pinned, probe-verified against the
/// malicious stop-everything repro), and the snapshot. Any of the four
/// failing leaves every check un-run with the reason recorded — nothing ran,
/// and nothing will.
pub(crate) fn prepare(
    docker_bin: &str,
    image_ref: &str,
    artifact_dir: &str,
    supervisor_path: &str,
) -> PreparedSandbox {
    if image_ref.is_empty() || image_ref.contains(char::is_whitespace) {
        return PreparedSandbox::Unavailable(
            "the sandbox image was not named (--sandbox-image is required; nothing is \
             pulled implicitly, so unnamed means nothing can run)"
                .into(),
        );
    }
    if let Err(reason) = daemon_available(docker_bin) {
        return PreparedSandbox::Unavailable(format!(
            "the sandbox runtime ({docker_bin}) is not reachable: {reason}"
        ));
    }
    let image = match resolve_image(docker_bin, image_ref) {
        Ok(image) => image,
        Err(reason) => {
            return PreparedSandbox::Unavailable(format!(
                "the sandbox image {image_ref:?} is not available locally (nothing \
                 is pulled, ever): {reason}"
            ))
        }
    };
    if let Some(cred) = image
        .image_env_keys
        .iter()
        .find(|key| CREDENTIAL_ENV_KEYS.contains(&key.as_str()))
    {
        return PreparedSandbox::Unavailable(format!(
            "the image {image_ref:?} itself declares a credential-named environment \
             default ({cred}); its defaults would be a leak the checks could read, \
             so it is refused"
        ));
    }
    let supervisor = match ops::load_trusted_supervisor(Path::new(supervisor_path)) {
        Ok(supervisor) => supervisor,
        Err(reason) => {
            return PreparedSandbox::Unavailable(format!(
                "the trusted deadline supervisor is refused (nothing will run \
                 without one): {reason}"
            ))
        }
    };
    let verified =
        match ops::verify_supervisor(docker_bin, &image.image_id, &supervisor, &ops::owner_key()) {
            Ok(verified) => verified,
            Err(reason) => {
                return PreparedSandbox::Unavailable(format!(
                    "no verified in-container deadline supervisor on {image_ref:?}: \
                 {reason} — without a supervisor that an untrusted check cannot \
                 stop and that survived the malicious process-stop probe, a running \
                 check could outlive this command, so this image is refused (fail \
                 closed)"
                ))
            }
        };
    match snapshot_artifact(Path::new(artifact_dir)) {
        Ok(snapshot) => PreparedSandbox::Ready(Box::new(ReadySandbox {
            docker_bin: docker_bin.to_string(),
            reference: image.reference,
            image_id: image.image_id,
            image_env_keys: image.image_env_keys,
            snapshot,
            supervisor: verified,
        })),
        Err(reason) => {
            PreparedSandbox::Unavailable(format!("the artifact snapshot was refused: {reason}"))
        }
    }
}

/// Resolve the immutable image ID the run will use, plus the config the
/// image *declares* (env keys, writable volumes) — read from the resolved
/// id, not from the mutable tag again, so the verified config is the config
/// that runs. `docker image inspect` never pulls: a missing local image is
/// an error, and no credential helper is ever asked to fetch.
pub(crate) fn resolve_image(docker_bin: &str, image_ref: &str) -> Result<SandboxImage, CliError> {
    let id_raw = docker_stdout_id(
        docker_bin,
        &["image", "inspect", "--format", "{{.Id}}", image_ref],
        IMAGE_RESOLVE_TIMEOUT,
    )?;
    let image_id = id_raw.trim().to_string();
    let hex_tail = &image_id["sha256:".len().min(image_id.len())..];
    if !image_id.starts_with("sha256:")
        || image_id.len() != "sha256:".len() + IMAGE_ID_TAIL
        || !hex_tail.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(CliError::Other(format!(
            "docker image inspect returned no sha256 image ID for {image_ref:?} (got \
             {image_id:?}); refusing to run against an unresolvable image"
        )));
    }
    // Everything below is read from the IMMUTABLE id: the tag could still be
    // re-pointed between the two reads, and the verified shape must be the
    // shape that runs. Unreadable or malformed answers are REFUSED — nothing
    // here is assumed (an unreadable env list is not a permission to assume
    // there are no credential defaults, and an unreadable volume list is not
    // a permission to assume there are no writable volumes).
    let env_json = docker_stdout_id(
        docker_bin,
        &[
            "image",
            "inspect",
            "--format",
            "{{json .Config.Env}}",
            &image_id,
        ],
        IMAGE_RESOLVE_TIMEOUT,
    )?;
    let env_entries: Vec<String> = match serde_json::from_str::<Vec<String>>(env_json.trim()) {
        Ok(entries) => entries,
        Err(e) => {
            return Err(CliError::Other(format!(
                "the image's own environment could not be read (got {e}); refusing \
                 to run a check against an image whose credential-bearing defaults \
                 cannot be proven clean"
            )))
        }
    };
    let keys: Vec<String> = env_entries
        .into_iter()
        .filter_map(|entry| entry.split('=').next().map(str::to_string))
        .collect();
    let volumes_json = docker_stdout_id(
        docker_bin,
        &[
            "image",
            "inspect",
            "--format",
            "{{json .Config.Volumes}}",
            &image_id,
        ],
        IMAGE_RESOLVE_TIMEOUT,
    )?;
    let volumes: Value = match serde_json::from_str(volumes_json.trim()) {
        Ok(value) => value,
        Err(e) => {
            return Err(CliError::Other(format!(
                "the image's declared volumes could not be read (got {e}); refusing \
                 to run a check against an image whose writable mounts cannot be \
                 proven absent"
            )))
        }
    };
    match volumes.as_object() {
        None => {}
        Some(map) if map.is_empty() => {}
        Some(map) => {
            return Err(CliError::Other(format!(
                "the image declares writable container volumes ({:?}); a check could \
                 fill an unbounded disk on the host, so the image is refused. This \
                 sandbox grants only the bounded /tmp tmpfs.",
                map.keys().collect::<Vec<_>>()
            )))
        }
    }
    Ok(SandboxImage {
        reference: image_ref.to_string(),
        image_id,
        image_env_keys: keys,
    })
}

fn docker_stdout_id(
    docker_bin: &str,
    args: &[&str],
    timeout: Duration,
) -> Result<String, CliError> {
    let captured = ops::docker_call(docker_bin, args, timeout)?;
    if !captured.ok {
        return Err(CliError::Other(format!(
            "{}: {}",
            args.first().copied().unwrap_or("docker"),
            ops::first_line(&captured),
        )));
    }
    Ok(captured.stdout)
}

const IMAGE_RESOLVE_TIMEOUT: Duration = Duration::from_secs(15);

fn daemon_available(docker_bin: &str) -> Result<(), CliError> {
    docker_stdout_id(
        docker_bin,
        &["info", "--format", "{{.ServerVersion}}"],
        ops::REMOVE_WAIT,
    )?;
    Ok(())
}

/// The exact container-argv shape (pinned token-for-token by the shape test).
#[cfg(test)]
pub(crate) use super::sandbox_run::container_argv;
/// The lifecycle lives in `sandbox_run` (this file stayed over the reader's
/// 1000-line bound after the ownership/supervisor work); the public seam of
/// the sandbox keeps its name here.
pub(crate) use super::sandbox_run::exec;
pub(crate) use super::sandbox_run::CREDENTIAL_ENV_KEYS;

/// At command start, remove containers this feature left *finished* behind —
/// only via the durable ownership journal (this owner, or an owner whose pid
/// the host verified dead); running containers and journal-less containers
/// are never swept. Returns bounded notes for the record.
pub(crate) fn cleanup_finished(docker_bin: &str, own_owner: &str) -> Vec<String> {
    ops::cleanup_finished(docker_bin, own_owner)
}

/// This run's unique owner key (pid + start-time token), used for container
/// names, the ownership label, and the journal.
pub(crate) use ops::owner_key;
