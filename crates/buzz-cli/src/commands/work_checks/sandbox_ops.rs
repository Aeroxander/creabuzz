//! Docker management plumbing for the enforcing sandbox: bounded client
//! captures, the authentic stop/removal confirmation sequence (a management
//! failure is never read as "gone"), unique per-run ownership with a durable,
//! hardened journal (0700 private root, validated owner/mode, 0600 entries
//! persisted atomically + fsynced BEFORE a container exists, verified against
//! the daemon's own container labels/image before any recovery removal,
//! malformed entries retained with visible notes, bounded directory reads),
//! and the trusted PID-1 deadline supervisor: an operator-prepared standalone
//! Rust binary, sha-pinned against its paired manifest, copied to a private
//! host path, and probe-verified against THIS daemon — including the exact
//! malicious stop-everything-the-watchdog repro — before anything runs.
//! Every surprise fails closed; there is no fallback anywhere.

use std::fs::{DirBuilder, File};
use std::io::{Read as _, Write as _};
use std::os::unix::fs::{DirBuilderExt as _, PermissionsExt as _};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use sha2::{Digest as _, Sha256};

use crate::error::CliError;
use hex;

use super::runner;

// ----------------------------------------------------------------------------
// Client plumbing
// ----------------------------------------------------------------------------

/// One bounded byte cap for every docker client capture taken into this
/// process; beyond it bytes are discarded, never read into memory twice.
pub(crate) const DOCKER_CLIENT_CAPTURE_CAP: usize = 64 * 1024;

pub(crate) const CLIENT_KILL_WAIT: Duration = Duration::from_secs(5);
pub(crate) const REMOVE_WAIT: Duration = Duration::from_secs(15);

/// How long a bounded reader join may take; beyond it the capture is
/// recorded as failed, never as an empty success.
const READER_JOIN_WAIT: Duration = Duration::from_secs(10);

/// The trusted supervisor's fixed container path; only this path may be the
/// container's entrypoint.
pub(crate) const SUPERVISOR_MOUNT: &str = "/buzz-wcr-supervisor";

/// The journal/supervisor roots' enforced private mode.
const ROOT_MODE: u32 = 0o700;

/// The exact malicious stop-everything repro the supervisor must survive —
/// the untrusted check stops every process in its PID namespace except PID 1
/// and itself, then sleeps past the deadline. This is the shape the replaced
/// `--init` + busybox-watchdog version demonstrably failed on.
const MALICIOUS_STOP_SCRIPT: &str = "for p in /proc/[0-9]*; do pid=${p#/proc/}; \
if [ \"$pid\" != 1 ] && [ \"$pid\" != \"$$\" ]; then kill -STOP \"$pid\" 2>/dev/null \
|| true; fi; done; sleep 60";

/// PATH for spawning the docker CLI itself (the operator's machine; the
/// container's environment is separate and empty beyond the image's own
/// defaults and the requested `--env` values).
fn docker_path() -> String {
    std::env::var_os("PATH")
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin".into())
}

/// One bounded capture of a management docker call's streams: capped and
/// bounded in time, killed on timeout. Management calls never own running
/// containers, so this kill is client-only by design. `code` keeps the real
/// exit status; `ok: false` covers BOTH a nonzero status and a client that
/// was killed on the time bound, and callers must treat every `ok: false`
/// as an error to investigate, never as a negative answer they wanted.
pub(crate) struct ClientCapture {
    pub ok: bool,
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

pub(crate) fn docker_call(
    docker_bin: &str,
    args: &[&str],
    timeout: Duration,
) -> Result<ClientCapture, CliError> {
    let mut command = Command::new(docker_bin);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_clear()
        .env("PATH", docker_path());
    let child = command
        .spawn()
        .map_err(|e| CliError::Other(format!("could not start {docker_bin}: {e}")))?;
    wait_client(child, timeout)
}

/// The first stderr line of a failing capture, for bounded error text.
pub(crate) fn first_line(capture: &ClientCapture) -> String {
    capture
        .stderr
        .lines()
        .next()
        .filter(|line| !line.is_empty())
        .unwrap_or("no detail from docker")
        .to_string()
}

/// `docker_call` carries no exit code distinction between "the daemon said
/// no such object" and any other failure; this is the authentic not-found
/// marker the daemon emits on stdout/stderr. Anything else — a timeout, a
/// connection refusal, an auth failure — is uncertainty, never absence.
pub(crate) fn is_authentic_not_found(capture: &ClientCapture) -> bool {
    let text = format!("{} {}", capture.stdout, capture.stderr).to_lowercase();
    text.contains("no such object")
}

pub(crate) fn wait_client(
    mut child: std::process::Child,
    timeout: Duration,
) -> Result<ClientCapture, CliError> {
    let deadline = Instant::now() + timeout;
    let cap = DOCKER_CLIENT_CAPTURE_CAP;
    let stdout_handle = runner::spawn_reader(child.stdout.take(), cap);
    let stderr_handle = runner::spawn_reader(child.stderr.take(), cap);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout = runner::join_reader(stdout_handle, READER_JOIN_WAIT);
                let stderr = runner::join_reader(stderr_handle, READER_JOIN_WAIT);
                return Ok(ClientCapture {
                    ok: status.success(),
                    code: status.code(),
                    stdout: stdout.text,
                    stderr: stderr.text,
                });
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    drain_client(child, stdout_handle, stderr_handle);
                    return Ok(ClientCapture {
                        ok: false,
                        code: None,
                        stdout: String::new(),
                        stderr: String::from("the docker client did not answer in time"),
                    });
                }
            }
            Err(e) => {
                drain_client(child, stdout_handle, stderr_handle);
                return Err(CliError::Other(format!(
                    "waiting for the docker client failed: {e}"
                )));
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Bounded after-kill drain of a docker client child and its readers: no
/// unbounded `wait`/`join` on a path that already failed. The readers report
/// whatever they got; the caller treats a missing capture as unknown output.
fn drain_client(
    mut child: std::process::Child,
    stdout_handle: runner::ReaderHandle,
    stderr_handle: runner::ReaderHandle,
) {
    let deadline = Instant::now() + Duration::from_secs(2);
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
    let _ = runner::join_reader(stdout_handle, READER_JOIN_WAIT);
    let _ = runner::join_reader(stderr_handle, READER_JOIN_WAIT);
}

/// The daemon's `State.Running` for a container, or `Ok(None)` only when the
/// inspect was AUTHENTIC not-found. Any other failure is uncertainty and
/// propagates as an error — never as "absent".
pub(crate) fn container_state(docker_bin: &str, name: &str) -> Result<Option<bool>, String> {
    let capture = docker_call(
        docker_bin,
        &["inspect", "--format", "{{.State.Running}}", name],
        CLIENT_KILL_WAIT,
    )
    .map_err(|e| format!("container state probe failed for {name:?}: {e}"))?;
    if !capture.ok {
        if is_authentic_not_found(&capture) {
            return Ok(None);
        }
        let how = if capture.code.is_none() {
            "the client gave no exit status (it was killed on its time bound)"
        } else {
            "the client ended with an error"
        };
        return Err(format!(
            "the state probe for {name:?} did not have the daemon's answer; this is \
             uncertainty, not absence ({how}): {}",
            first_line(&capture)
        ));
    }
    match capture.stdout.trim() {
        "true" => Ok(Some(true)),
        "false" => Ok(Some(false)),
        "" => Ok(None),
        other => Err(format!(
            "the state probe for {name:?} answered with an unreadable state {other:?}"
        )),
    }
}

/// Require the container actually stopped: a running container is killed and
/// its death bounded-verified against the daemon. Stopping is verified, never
/// assumed from a kill call that merely did not error loudly.
pub(crate) fn confirm_stopped(docker_bin: &str, name: &str) -> Result<(), String> {
    let started = Instant::now();
    loop {
        match container_state(docker_bin, name)? {
            None | Some(false) => return Ok(()),
            Some(true) => {
                let killed = docker_call(docker_bin, &["kill", name], CLIENT_KILL_WAIT)
                    .map_err(|e| format!("docker kill for {name:?} failed: {e}"))?;
                if !killed.ok {
                    return Err(format!(
                        "docker kill for {name:?} did not stop the container: {}",
                        first_line(&killed)
                    ));
                }
                if Instant::now() >= started + CLIENT_KILL_WAIT {
                    return Err(format!(
                        "the container {name:?} was still running after the bounded \
                         {}s stop wait",
                        CLIENT_KILL_WAIT.as_secs()
                    ));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
}

/// Remove the container and assert, bounded, that it is gone. Absence is
/// confirmed only by the daemon's authentic not-found answer; a daemon that
/// timed out or errored leaves this an ERROR — unknown, never "removed".
pub(crate) fn remove_and_confirm(docker_bin: &str, name: &str) -> Result<(), String> {
    let started = Instant::now();
    loop {
        match container_state(docker_bin, name)? {
            None => return Ok(()),
            Some(_) => {
                let removed = docker_call(docker_bin, &["rm", "-f", name], Duration::from_secs(10))
                    .map_err(|e| format!("container removal failed for {name:?}: {e}"))?;
                if !removed.ok {
                    return Err(format!(
                        "docker rm -f failed for {name:?}: {}",
                        first_line(&removed)
                    ));
                }
                if Instant::now() >= started + REMOVE_WAIT {
                    return Err(format!(
                        "the container {name:?} was still present after {}s of removal \
                         attempts",
                        REMOVE_WAIT.as_secs()
                    ));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
}

/// Stop (only if still running, bounded) and remove. The whole lifecycle
/// end: used after normal exits and on every error path alike.
pub(crate) fn stop_and_remove(docker_bin: &str, name: &str) -> Result<(), String> {
    confirm_stopped(docker_bin, name)?;
    remove_and_confirm(docker_bin, name)
}

/// Read a container's identity the daemon holds: its immutable image pointer
/// and its label set. Every recovery removal is gated on this matching the
/// journal entry — a name collision or a forged entry must never delete a
/// container that does not carry the claimed ownership.
pub(crate) fn container_identity(
    docker_bin: &str,
    name: &str,
) -> Result<Option<(String, String, String)>, String> {
    let capture = docker_call(
        docker_bin,
        &[
            "inspect",
            "--format",
            "{{.Image}}|{{json .Config.Labels}}",
            name,
        ],
        CLIENT_KILL_WAIT,
    )
    .map_err(|e| format!("container identity probe failed for {name:?}: {e}"))?;
    if !capture.ok {
        if is_authentic_not_found(&capture) {
            return Ok(None);
        }
        return Err(format!(
            "the identity probe for {name:?} did not have the daemon's answer; this \
             is uncertainty, not absence: {}",
            first_line(&capture)
        ));
    }
    let misread = format!("the identity probe for {name:?} answered with an unreadable shape");
    let (image, labels_json) = capture
        .stdout
        .trim()
        .split_once('|')
        .ok_or_else(|| misread.clone())?;
    let labels: Value = serde_json::from_str(labels_json.trim())
        .map_err(|_| format!("{misread}: labels were not a label set"))?;
    let owner = labels
        .get(OWNER_LABEL)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    Ok(Some((image.to_string(), owner, labels_json.to_string())))
}

// ----------------------------------------------------------------------------
// Ownership: unique keys, a hardened durable journal, bounded cleanup
// ----------------------------------------------------------------------------

/// The ownership label every sandbox container carries: the run's unique
/// key, so cleanup can never touch a container it cannot attribute.
pub(crate) const OWNER_LABEL: &str = "buzz.wcr.owner";

/// Durable journal root: one JSON entry per created container. Entries are
/// written BEFORE the container is created (a container that cannot be
/// recorded is not created) and removed only after its removal is confirmed.
pub(crate) fn journal_root() -> PathBuf {
    std::env::temp_dir().join(".buzz-wcr-journal")
}

/// The trusted supervisor's private copy root (the runtime helper is copied
/// here, hash-pinned, before it can be bound into any container).
pub(crate) fn supervisor_root() -> PathBuf {
    std::env::temp_dir().join(".buzz-wcr-supervisor")
}

/// Ensure a private root exists and STAYS private: created 0700; an existing
/// path must be a real directory (no symlink), mode 0700, and owned by the
/// same account this process runs as (checked against the uid this process
/// itself writes into it — std has no geteuid, and a 0700 root owned by
/// another account cannot accept our file anyway, so the equality is the
/// usable proof). Any other shape is REFUSED — never silently adopted.
fn ensure_private_root(root: &Path, what: &str) -> Result<PathBuf, String> {
    match std::fs::symlink_metadata(root) {
        Ok(existing) => {
            if existing.file_type().is_symlink() {
                return Err(format!(
                    "refusing {what} root: {root:?} is a symlink, not a private \
                     directory — a link could be walked to attacker-chosen files"
                ));
            }
            if !existing.is_dir() {
                return Err(format!(
                    "refusing {what} root: {root:?} is not a directory"
                ));
            }
            let mode = existing.permissions().mode() & 0o777;
            if mode != ROOT_MODE {
                return Err(format!(
                    "refusing {what} root: {root:?} carries mode {mode:o}, not the \
                     required private 0700"
                ));
            }
            // Owner proof: write our probe file in it and require the dir's
            // uid to equal OUR file's uid (0700-only access holds otherwise).
            let probe_path = root.join(".owned-by-this-process");
            if let Some(reason) = try_probe_owner(root, &probe_path) {
                return Err(format!("refusing {what} root: {reason}"));
            }
        }
        Err(_) => {
            DirBuilder::new()
                .mode(ROOT_MODE)
                .create(root)
                .map_err(|e| format!("could not create the private {what} root: {e}"))?;
        }
    }
    Ok(root.to_path_buf())
}

/// Owner proof: write our probe file in it and require the dir's uid to
/// equal OUR file's uid (a 0700-only root held by another account could not
/// accept this file anyway, so the equality is the usable std-only proof).
fn try_probe_owner(root: &Path, probe_path: &Path) -> Option<String> {
    let marker = std::fs::File::create(probe_path).ok()?;
    drop(marker);
    let _ = std::fs::remove_file(probe_path);
    let file_metadata = std::fs::metadata(probe_path).ok()?;
    let dir_metadata = std::fs::metadata(root).ok()?;
    use std::os::unix::fs::MetadataExt as _;
    if file_metadata.uid() != dir_metadata.uid() {
        Some(format!(
            "the directory is not owned by this process's account (dir uid {}, \
             this process's files uid {})",
            dir_metadata.uid(),
            file_metadata.uid()
        ))
    } else {
        None
    }
}

/// A unique per-process owner: the pid plus a start-time token, so names and
/// labels never collide across runs of this feature.
pub(crate) fn owner_key() -> String {
    static KEY: OnceLock<String> = OnceLock::new();
    KEY.get_or_init(|| {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default() as u64;
        let mixed =
            nanos ^ ((std::process::id() as u64) << 21) ^ (std::ptr::from_ref(&nanos) as u64);
        format!("pid{}-{:x}", std::process::id(), mixed & 0xffff_ffff)
    })
    .clone()
}

fn journal_path(owner: &str, name: &str) -> PathBuf {
    journal_root().join(format!("{owner}__{name}.json"))
}

/// Record ownership BEFORE the container is created. Every failure in the
/// persist path — the entry write, its fsync, its rename, the directory
/// fsync — is an error that propagates: an unrecorded or unsynchronized
/// container would be untraceable by design, so the CALLER refuses to create
/// it. Nothing is allowed to pass silently here.
pub(crate) fn record_owned(owner: &str, name: &str, image_id: &str) -> Result<(), String> {
    record_owned_in(&journal_root(), owner, name, image_id)
}

/// The journal write with the injected root (tests exercise the fail paths
/// against their own roots; production always passes the hardened journal
/// root). Steps: validate/create the private root; build the bounded entry;
/// write a 0600 temp file IN the root; fsync the FILE; atomically rename
/// onto the entry path; fsync the DIRECTORY — only then the entry is durable
/// and only then does the caller create the container.
pub(crate) fn record_owned_in(root: &Path, owner: &str, name: &str, image_id: &str) -> Result<(), String> {
    let root = ensure_private_root(root, "journal")?;
    let body = json!({
        "name": name,
        "owner": owner,
        "imageId": image_id,
        "pid": std::process::id(),
        "createdAt": now_secs(),
    });
    persist_entry_atomic(&root, &entry_path_in(&root, owner, name), &body.to_string())
        .map_err(|e| format!("the ownership entry for {name:?} could not be durably \
                              recorded (no container was created): {e}"))
}

fn entry_path_in(root: &Path, owner: &str, name: &str) -> PathBuf {
    root.join(format!("{owner}__{name}.json"))
}

/// One atomic, fsync-before-rename entry write. The entry lands with mode
/// 0600; both the FILE and the containing DIRECTORY are synced before this
/// returns success. A failed directory sync removes the just-renamed entry:
/// a record whose durability could not be claimed must not be treated as one.
fn persist_entry_atomic(root: &Path, dest: &Path, body: &str) -> Result<(), String> {
    if body.len() > 64 * 1024 {
        return Err("the journal entry exceeds its 64 KiB bound".into());
    }
    let unique = format!(
        ".tmp-{}-{}-{}",
        std::process::id(),
        now_nanos(),
        body.len()
    );
    let tmp = root.join(&unique);
    let mut file = File::create(&tmp).map_err(|e| format!("could not create the entry temp: {e}"))?;
    std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("could not confine the entry temp: {e}"))?;
    file.write_all(body.as_bytes())
        .map_err(|e| format!("could not write the entry: {e}"))?;
    file.flush()
        .map_err(|e| format!("could not flush the entry: {e}"))?;
    file.sync_all()
        .map_err(|e| format!("could not fsync the entry: {e}"))?;
    drop(file);
    std::fs::rename(&tmp, dest).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("could not atomically place the entry: {e}")
    })?;
    // The rename only becomes durable after its directory is synced.
    let dir = File::open(root).map_err(|e| format!("could not open the journal dir: {e}"))?;
    dir.sync_all()
        .map_err(|e| {
            let _ = std::fs::remove_file(dest);
            format!("could not fsync the journal dir (the placed entry was withdrawn; \
                     the record is NOT durable, so nothing may proceed): {e}")
        })
}

fn now_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default()
}

fn now_secs() -> u64 {
    now_nanos() as u64
}

/// A recorded container entry as cleanup reads it. Every field is required;
/// anything unreadable, truncated, or without an image pointer is a
/// CORRUPT RECORD that stays on disk with a visible note.
struct OwnedEntry {
    name: String,
    owner: String,
    image_id: String,
    pid: u32,
}

fn parse_entry(path: &Path) -> Result<OwnedEntry, String> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("could not read the entry: {e}"))?;
    let value: Value = serde_json::from_str(&raw)
        .map_err(|e| format!("the entry is not a parseable record: {e}"))?;
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .ok_or("the entry lacks a container name")?
        .to_string();
    let owner = value
        .get("owner")
        .and_then(Value::as_str)
        .ok_or("the entry lacks an owner")?
        .to_string();
    let image_id = value
        .get("imageId")
        .and_then(Value::as_str)
        .ok_or("the entry lacks an image pointer")?
        .to_string();
    let pid = value
        .get("pid")
        .and_then(Value::as_u64)
        .ok_or("the entry lacks an owner pid")? as u32;
    Ok(OwnedEntry {
        name,
        owner,
        image_id,
        pid,
    })
}

/// The daemon's ACTUAL image pointer and ownership label for a named
/// container, matched against an entry. Only a full match (owner label AND
/// the recorded immutable image pointer) authorizes a recovery removal.
/// Any management uncertainty propagates — never a removal.
fn entry_matches_container(
    docker_bin: &str,
    entry: &OwnedEntry,
) -> Result<bool, String> {
    let (image, owner, _labels) = match container_identity(docker_bin, &entry.name)? {
        None => return Ok(false),
        Some(identity) => identity,
    };
    Ok(owner == entry.owner && !entry.image_id.is_empty() && image == entry.image_id)
}

/// Liveness of a journal owner's pid, if the host can answer at all. `None`
/// means "the host could not say", and cleanup leaves those alone.
fn pid_alive(pid: u32) -> Option<bool> {
    let output = Command::new("ps")
        .args(["-p", &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    Some(output.status.success())
}

/// At command start, sweep the durable journal: OWN leftovers (and those of
/// dead owners) get their *finished*, OWNERSHIP-VERIFIED containers removed
/// and their entries closed. Running containers are never touched mid-flight
/// — neither ours while this process is alive, nor another live run's under
/// any condition. Nothing without a journal entry is ever touched, and a
/// forged entry whose container does not actually carry the claimed
/// ownership label and image pointer is retained with a visible note. Corrupt
/// records are retained and reported, never deleted. Returns a bounded set
/// of plain notes for the record.
pub(crate) fn cleanup_finished(docker_bin: &str, own_owner: &str) -> Vec<String> {
    cleanup_finished_in(&journal_root(), docker_bin, own_owner)
}

pub(crate) fn cleanup_finished_in(root: &Path, docker_bin: &str, own_owner: &str) -> Vec<String> {
    let mut notes: Vec<String> = Vec::new();
    // The journal read is bounded: at most this many entries per sweep, the
    // rest left for the next command (and reported).
    const MAX_ENTRIES_PER_SWEEP: usize = 128;
    let mut paths: Vec<PathBuf> = Vec::new();
    let mut overflow = 0usize;
    match std::fs::read_dir(root) {
        Ok(dir) => {
            for entry in dir.filter_map(|e| e.ok()) {
                let path = entry.path();
                if path.extension().is_some_and(|e| e == "json") {
                    if paths.len() >= MAX_ENTRIES_PER_SWEEP {
                        overflow += 1;
                        continue;
                    }
                    paths.push(path);
                }
            }
        }
        Err(_) => return notes,
    }
    if overflow > 0 && notes.len() < 16 {
        notes.push(format!(
            "{overflow} journal entr{} beyond the {}-entry sweep bound were left for \
             the next command",
            if overflow == 1 { "y" } else { "ies" },
            MAX_ENTRIES_PER_SWEEP
        ));
    }
    let mut corrupt = 0usize;
    for path in paths {
        let entry = match parse_entry(&path) {
            Ok(entry) => entry,
            Err(reason) => {
                corrupt += 1;
                if notes.len() < 16 {
                    notes.push(format!(
                        "a corrupt journal record at {:?} was RETAINED for visible \
                         retry, not deleted: {reason}",
                        path.file_name().map(|n| n.to_string_lossy().into_owned())
                            .unwrap_or_default()
                    ));
                }
                continue;
            }
        };
        if entry.owner != own_owner {
            match pid_alive(entry.pid) {
                Some(true) => continue, // a live run's container: never ours to touch
                None => {
                    if notes.len() < 16 {
                        notes.push(format!(
                            "a journal entry for {:?} could not have its owner verified \
                             as gone by this host, so it was left alone",
                            entry.name
                        ));
                    }
                    continue;
                }
                Some(false) => {}
            }
        }
        // Finished (or gone) containers of an owner we can own: verify the
        // daemon's ACTUAL ownership matches the entry BEFORE removing, then
        // close the entry once removal is confirmed. A mismatch is a forged
        // (or renamed) record: RETAINED, named, never removed.
        let removal = match entry_matches_container(docker_bin, &entry) {
            Err(reason) => Err(reason),
            Ok(false) => {
                if notes.len() < 16 {
                    notes.push(format!(
                        "the record for {:?} does NOT match the daemon's actual \
                         ownership (label/image) of that container; it is retained \
                         untouched and names nothing for recovery",
                        entry.name
                    ));
                }
                Ok(false)
            }
            Ok(true) => match container_state(docker_bin, &entry.name) {
                Ok(None) => Ok(true),
                Ok(Some(false)) => remove_and_confirm(docker_bin, &entry.name).map(|_| true),
                Ok(Some(true)) => {
                    if notes.len() < 16 {
                        notes.push(format!(
                            "the container {:?} is still running and is left alone \
                             mid-flight; its owner is gone and the trusted supervisor \
                             will end it",
                            entry.name
                        ));
                    }
                    Ok(false)
                }
                Err(reason) => Err(reason),
            },
        };
        match removal {
            Ok(true) => {
                let _ = std::fs::remove_file(&path);
                if notes.len() < 16 {
                    notes.push(format!(
                        "the verified finished container {:?} was removed and confirmed \
                         gone; its journal entry closed",
                        entry.name
                    ));
                }
            }
            Ok(false) => {}
            Err(reason) => {
                if notes.len() < 16 {
                    notes.push(format!(
                        "the journal entry for {:?} stays open because its removal \
                         could not be confirmed: {reason}",
                        entry.name
                    ));
                }
            }
        }
    }
    if corrupt > 0 && notes.len() < 16 {
        notes.push(format!(
            "{corrupt} corrupt journal record{} were retained for visible retry",
            if corrupt == 1 { " was" } else { "s were" }
        ));
    }
    notes
}

/// Remove one specific journal entry after its removal was confirmed inside
/// `remove_and_confirm`/a verified not-found. Best effort: a stale entry is
/// swept (and retried) by `cleanup_finished` later, never silently dropped.
pub(crate) fn drop_owned(owner: &str, name: &str) {
    let _ = std::fs::remove_file(journal_path(owner, name));
}

// ----------------------------------------------------------------------------
// The trusted PID-1 deadline supervisor
// ----------------------------------------------------------------------------

/// The trusted supervisor, as prepared for a run: the operator's PRE-BUILT
/// standalone binary (built once OFFLINE by scripts/build-check-supervisor.sh
/// with the cached rust image — the CLI never builds or pulls anything), its
/// paired manifest's source and binary sha256, the bounded size, and the
/// private host copy the container binds read-only.
#[derive(Debug, Clone)]
pub(crate) struct SupervisorProfile {
    /// The fixed container path the binary is bound to read-only; the only
    /// entrypoint any check may run under.
    pub entrypoint: String,
    /// The private host copy (0700 root, disowned from the operator's tree).
    pub host_copy: PathBuf,
    /// The manifest's pinned source sha256 (recorded in telemetry).
    pub source_sha256: String,
    /// The manifest's pinned binary sha256 — verified against the bytes of
    /// the ACTUAL COPY that gets bind-mounted, never the tree it came from.
    pub binary_sha256: String,
    /// The bounded size, as recorded and re-measured on the copy.
    pub size_bytes: u64,
}

/// Trust-pipeline bounds.
const HELPER_MAX_BYTES: u64 = 16 * 1024 * 1024;
const MANIFEST_MAX_BYTES: usize = 4_096;
/// The pinned helper profile this CLI accepts; a manifest naming any other
/// profile is refused.
const TRUSTED_PROFILE: &str = "trusted-rust-pid1-v1";

/// Load the operator-provided helper and its paired manifest, verify every
/// declared fact against the bytes, and place a PRIVATE copy for the run.
/// The manifest path is the paired sibling `<binary>.manifest.json`.
/// Failures are specific and fail closed.
///
/// Facts tied down here:
/// * the binary is a REGULAR file (no symlink), owner-executable, no
///   setuid/setgid bits, at most 16 MiB and EXACTLY the manifest's size;
/// * the pair is 64-hex sha256s of the SOURCE and of the BINARY, and the
///   copy's own sha256 — hashed from the bytes we are about to bind, not the
///   origin — matches the manifest's binary hash exactly;
/// * the manifest names the trusted profile and nothing else.
pub(crate) fn load_trusted_supervisor(binary_path: &Path) -> Result<SupervisorProfile, String> {
    let file_name = binary_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or("the supervisor path has no file name")?;
    let manifest_path = binary_path
        .parent()
        .unwrap_or(Path::new("/"))
        .join(format!("{file_name}.manifest.json"));
    read_verified_manifest(binary_path, &manifest_path)
}

fn read_verified_manifest(
    binary_path: &Path,
    manifest_path: &Path,
) -> Result<SupervisorProfile, String> {
    let manifest_meta = std::fs::symlink_metadata(manifest_path)
        .map_err(|e| format!("the supervisor manifest is not readable ({e})"))?;
    if manifest_meta.file_type().is_symlink() {
        return Err(
            "refusing the supervisor manifest: it is a symlink, which could be \
             walked away from the pinned pair"
                .into(),
        );
    }
    if manifest_meta.len() > MANIFEST_MAX_BYTES as u64 {
        return Err(format!(
            "refusing the supervisor manifest: {} bytes over the bound",
            manifest_meta.len()
        ));
    }
    let manifest_raw = std::fs::read_to_string(manifest_path)
        .map_err(|e| format!("the supervisor manifest is not readable: {e}"))?;
    let manifest: Value = serde_json::from_str(&manifest_raw)
        .map_err(|e| format!("the supervisor manifest is not a parseable record: {e}"))?;
    if manifest.get("profile").and_then(Value::as_str) != Some(TRUSTED_PROFILE) {
        return Err(format!(
            "refusing the supervisor manifest: it does not name the trusted profile \
             {TRUSTED_PROFILE:?}"
        ));
    }
    let binary_sha = pinned_sha(manifest.get("binarySha256"), "binary")?;
    let source_sha = pinned_sha(manifest.get("sourceSha256"), "source")?;
    let size = manifest
        .get("sizeBytes")
        .and_then(Value::as_u64)
        .ok_or("the supervisor manifest lacks a size bound")?;
    if size == 0 || size > HELPER_MAX_BYTES {
        return Err(format!(
            "refusing the supervisor manifest: its size bound {size} is outside \
             1..={HELPER_MAX_BYTES}"
        ));
    }

    // The binary itself: regular, executable, unprivileged bits, bounded.
    let binary_meta = std::fs::symlink_metadata(binary_path)
        .map_err(|e| format!("the supervisor binary is not readable ({e})"))?;
    if binary_meta.file_type().is_symlink() {
        return Err(
            "refusing the supervisor binary: it is a symlink, which could be walked \
             away from the pinned artifact"
                .into(),
        );
    }
    if !binary_meta.file_type().is_file() {
        return Err(
            "refusing the supervisor binary: it is not a regular file".into(),
        );
    }
    let mode = binary_meta.permissions().mode();
    let privilege_bits = mode & (0o4000 | 0o2000);
    if privilege_bits != 0 {
        return Err(
            "refusing the supervisor binary: it carries setuid/setgid privilege bits"
                .into(),
        );
    }
    if mode & 0o100 == 0 {
        return Err(
            "refusing the supervisor binary: it is not owner-executable".into(),
        );
    }
    if binary_meta.len() != size {
        return Err(format!(
            "refusing the supervisor binary: it carries {} bytes, but the manifest \
             pins {}",
            binary_meta.len(),
            size
        ));
    }

    // The private copy: written, re-measured, and re-hashed — the manifest
    // has to match what we are actually ABOUT to mount, not what the source
    // tree held a moment ago.
    let root = ensure_private_root(supervisor_root().as_path(), "supervisor")?;
    let copy_path = root.join(format!("supervisor-{:.16}", binary_sha_prefix(&binary_sha)));
    std::fs::copy(binary_path, &copy_path)
        .map_err(|e| format!("could not copy the supervisor into the private bind root: {e}"))?;
    std::fs::set_permissions(&copy_path, std::fs::Permissions::from_mode(0o755))
        .map_err(|e| format!("could not set the supervisor copy's mode: {e}"))?;
    let copied = File::open(&copy_path)
        .map_err(|e| format!("could not open the private copy: {e}"))?;
    copied
        .sync_all()
        .map_err(|e| format!("could not fsync the private copy: {e}"))?;
    drop(copied);
    let copy_meta = std::fs::metadata(&copy_path)
        .map_err(|e| format!("could not re-measure the private copy: {e}"))?;
    if copy_meta.len() != size {
        return Err(format!(
            "refusing the supervisor copy: {} bytes, but the manifest pins {size}",
            copy_meta.len()
        ));
    }
    let copy_sha = sha256_file(&copy_path)?;
    if copy_sha != binary_sha {
        return Err(format!(
            "refusing the supervisor copy: its bytes hash {copy_sha}, not the \
             manifest-pinned {binary_sha}"
        ));
    }
    Ok(SupervisorProfile {
        entrypoint: SUPERVISOR_MOUNT.into(),
        host_copy: copy_path,
        source_sha256: source_sha,
        binary_sha256: binary_sha,
        size_bytes: size,
    })
}

fn binary_sha_prefix(sha: &str) -> String {
    sha.get(..16).unwrap_or(sha).to_string()
}

fn pinned_sha(value: Option<&Value>, what: &str) -> Result<String, String> {
    let sha = value
        .and_then(Value::as_str)
        .ok_or_else(|| format!("the supervisor manifest lacks a {what} sha256"))?;
    if sha.len() != 64 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(format!(
            "refusing the supervisor manifest: its {what} sha256 {sha:?} is not \
             64 hex characters"
        ));
    }
    Ok(sha.to_ascii_lowercase())
}

/// sha256 of a file's bytes, bounded by the helper bound.
fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path)
        .map_err(|e| format!("could not open {:?} for hashing: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut remaining = HELPER_MAX_BYTES;
    let mut chunk = [0u8; 16_384];
    loop {
        let read = file
            .read(&mut chunk)
            .map_err(|e| format!("could not read {path:?} for hashing: {e}"))?;
        if read == 0 {
            break;
        }
        if remaining < read as u64 {
            return Err(format!("the file at {path:?} exceeds the 16 MiB helper bound"));
        }
        remaining -= read as u64;
        hasher.update(&chunk[..read]);
    }
    // Plain sha256 hex (no 0x prefix) — byte-identical with the manifest's.
    Ok(hex::encode(hasher.finalize()))
}

/// Verify the trusted supervisor against THIS daemon before anything runs.
/// Two probes, both with the FULL enforced shape (pull never, network none,
/// read-only rootfs, caps dropped, non-root, no-new-privileges, bounded
/// everything, log-driver none, helper bound read-only as the only extra
/// mount) and the helper as the (PID 1) entrypoint:
/// 1. EXEC: `<secs> /bin/true` must exit 0 — the helper really runs in an
///    enforced container as PID 1;
/// 2. THE MALICIOUS REPRO: a check that SIGSTOPs every other process in the
///    namespace then sleeps must STILL end by the deadline (exit 124) — this
///    is the exact proof the replaced busybox watchdog failed.
/// Any wrong rc, surviving container, or management uncertainty fails the
/// sandbox closed.
pub(crate) fn verify_supervisor(
    docker_bin: &str,
    image_id: &str,
    profile: &SupervisorProfile,
    owner: &str,
) -> Result<SupervisorProfile, String> {
    let exec = probe_supervisor(
        docker_bin,
        image_id,
        profile,
        owner,
        "exec",
        &["5", "/bin/true"],
    )?;
    if exec.code != Some(0) {
        return Err(format!(
            "the trusted supervisor's exec probe did not run the check cleanly \
             (exit code {:?} instead of 0); the supervisor is refused and nothing \
             runs: {}",
            exec.code,
            first_line(&exec)
        ));
    }
    let stop_proof = probe_supervisor(
        docker_bin,
        image_id,
        profile,
        owner,
        "stop",
        &["2", "/bin/sh", "-c", MALICIOUS_STOP_SCRIPT],
    )?;
    if stop_proof.code != Some(124) {
        return Err(format!(
            "the trusted supervisor did not enforce the deadline against a check \
             that stopped every other process in the namespace (exit code {:?} \
             instead of the deadline's 124); the supervisor is refused and nothing \
             runs: {}",
            stop_proof.code,
            first_line(&stop_proof)
        ));
    }
    Ok(profile.clone())
}

/// One bounded probe container with the FULL enforced shape plus `--rm`; the
/// helper is bound read-only at its fixed path and is the entrypoint (PID
/// 1). Recorded in the ownership journal before creation and closed when its
/// removal is confirmed. Returns the capture; callers interpret it against
/// this probe's purpose.
fn probe_supervisor(
    docker_bin: &str,
    image_id: &str,
    profile: &SupervisorProfile,
    owner: &str,
    tag: &str,
    helper_args: &[&str],
) -> Result<ClientCapture, String> {
    // A per-invocation sequence makes the probe name unique even when several
    // prepares run in one process (Docker's name release after `--rm` is not
    // synchronous, so an owner-only name can collide with its own predecessor).
    let seq = {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        SEQ.fetch_add(1, Ordering::Relaxed)
    };
    let name = format!("buzz-probe-{tag}-{owner}-{seq}");
    record_owned(owner, &name, image_id)?;
    let args = probe_argv(image_id, profile, owner, &name, helper_args);
    let args_ref: Vec<&str> = args.iter().map(String::as_str).collect();
    let capture = match docker_call(docker_bin, &args_ref, Duration::from_secs(30)) {
        Ok(capture) => capture,
        Err(e) => {
            let confirmed = remove_and_confirm(docker_bin, &name).is_ok();
            if confirmed {
                drop_owned(owner, &name);
            }
            return Err(format!("the supervisor probe did not answer: {e}"));
        }
    };
    // `--rm` handles the normal end; confirm anyway and only then close the
    // journal entry, so an --rm failure stays visible for recovery.
    if let Ok(()) = remove_and_confirm(docker_bin, &name) {
        drop_owned(owner, &name);
    }
    Ok(capture)
}

/// The probe's exact argv: every flag the enforced shape carries, the helper
/// bound READ-ONLY as the container's entrypoint, and the deadline+p rogram
/// arguments through to the supervisor.
pub(crate) fn probe_argv(
    image_id: &str,
    profile: &SupervisorProfile,
    owner: &str,
    name: &str,
    helper_args: &[&str],
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "run".into(),
        "--rm".into(),
        "--pull".into(),
        "never".into(),
        "--name".into(),
        name.to_string(),
        "--label".into(),
        format!("{}=1", super::sandbox::CONTAINER_LABEL),
        "--label".into(),
        format!("{OWNER_LABEL}={owner}"),
        "--user".into(),
        super::sandbox::SANDBOX_USER.into(),
        "--network".into(),
        "none".into(),
        "--read-only".into(),
        "--cap-drop".into(),
        "ALL".into(),
        "--security-opt".into(),
        "no-new-privileges".into(),
        "--pids-limit".into(),
        super::sandbox::SANDBOX_PIDS_LIMIT.to_string(),
        "--memory".into(),
        "128m".into(),
        "--cpus".into(),
        super::sandbox::SANDBOX_CPUS.into(),
        "--tmpfs".into(),
        super::sandbox::SANDBOX_TMPFS.into(),
        "--log-driver".into(),
        super::sandbox::SANDBOX_LOG_DRIVER.into(),
        "-v".into(),
        format!("{}:{SUPERVISOR_MOUNT}:ro", profile.host_copy.display()),
        "--entrypoint".into(),
        profile.entrypoint.clone(),
        image_id.to_string(),
    ];
    args.extend(helper_args.iter().map(|s| s.to_string()));
    args
}

/// Spawn one `docker run` child running the prebuilt argv with the shared
/// client plumbing (null stdin, both streams piped, cleared env).
pub(crate) fn spawn_run(docker_bin: &str, args: &[String]) -> std::io::Result<std::process::Child> {
    let mut command = Command::new(docker_bin);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_clear()
        .env("PATH", docker_path());
    command.spawn()
}
