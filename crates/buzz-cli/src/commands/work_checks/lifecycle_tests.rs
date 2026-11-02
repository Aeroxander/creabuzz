//! Lifecycle tests for the enforcing sandbox — the seams the parent review
//! flagged. Each binds a production code path and is falsifiable:
//!
//! * a MANAGEMENT failure (fake docker daemon answers) is never read as
//!   "absent"/"removed" — `remove_and_confirm` errors on uncertainty;
//! * an image that declares writable VOLUMES is refused at prepare, before
//!   any container can start;
//! * a declared CREDENTIAL environment pair is refused before any container
//!   is created (docker-visible: nothing with the feature label exists);
//! * killing the host docker CLI mid-run leaves the container's fate to the
//!   in-container deadline supervisor, and the container (its forked
//!   descendants included) is GONE by the deadline;
//! * cleanup touches ONLY journal-owned finished containers of this owner or
//!   of a host-verified-dead owner — a concurrent live bystander is never
//!   touched, and nothing without a journal entry exists at all after a run;
//! * the bounded reader records read errors and never blocks forever: broken
//!   or hung output capture becomes a failed/unknown honest record.

use std::io::Read;
use std::time::{Duration, Instant};

use super::checks::{CheckSpec, RunnerOptions};
use super::sandbox;
use super::sandbox_ops as ops;
use super::tests::{checks_decls, docker_available, docker_lock, opts, FIXTURE_IMAGE};

/// Make an executable shell-script stand-in for the docker CLI with the
/// given body. Nothing on the host is affected beyond one leaked temp dir.
fn fake_docker(name: &str, body: &str) -> std::path::PathBuf {
    let keep = Box::leak(Box::new(tempfile::tempdir().unwrap()));
    let path = keep.path().join(format!("fake-{name}"));
    let script = format!("#!/bin/sh\n{body}\n");
    std::fs::write(&path, script).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    path.to_path_buf()
}

// ── management failure is NEVER absence ─────────────────────────────────────

/// A daemon that answers the removal probe with an error other than the
/// authentic not-found (genuine outage, timeout, auth failure) means
/// UNKNOWN, not gone: `remove_and_confirm` must refuse to declare success.
#[test]
fn a_management_failure_is_never_read_as_absent() {
    let _guard = docker_lock();
    let binary = fake_docker(
        "outage",
        "echo 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock' >&2; exit 1",
    );
    let bin = binary.to_str().unwrap();
    let err = ops::remove_and_confirm(bin, "buzz-wcr-never-there").unwrap_err();
    assert!(
        err.contains("uncertainty, not absence"),
        "an outage must be uncertainty, not absence: {err}"
    );

    // A NOT-FOUND answer (rc 1 + the daemon's "no such object" text) is the
    // only confirmed absence.
    let binary = fake_docker(
        "notfound",
        "echo 'error: no such object: buzz-wcr-never-there' >&2; exit 1",
    );
    let bin = binary.to_str().unwrap();
    assert!(
        ops::remove_and_confirm(bin, "buzz-wcr-never-there").is_ok(),
        "the authentic not-found is a confirmed absence"
    );

    // A probe that never answers within its bound is an error too (the fake
    // sleeps well past the bounded probe).
    let binary = fake_docker("slowest", "sleep 30");
    let bin = binary.to_str().unwrap();
    let err = ops::remove_and_confirm(bin, "buzz-wcr-never-there").unwrap_err();
    assert!(
        err.contains("uncertainty, not absence"),
        "a probe timeout is an error, not absence: {err}"
    );
}

/// `docker rm -f` failing keeps the container present: an error that commands
/// the retry path, not a quiet "removed".
#[test]
fn a_failed_removal_is_an_error() {
    let _guard = docker_lock();
    let binary = fake_docker(
        "rmfail",
        "if [ \"$1\" = inspect ]; then echo true; exit 0; \
         else echo 'removal refused: no such privilege' >&2; exit 1; fi",
    );
    let bin = binary.to_str().unwrap();
    let err = ops::remove_and_confirm(bin, "buzz-wcr-present").unwrap_err();
    assert!(
        err.contains("docker rm -f failed"),
        "a failed rm is an error: {err}"
    );
}

/// A container that is running cannot be "stopped" by a kill call that the
/// daemon answered with an error: `confirm_stopped` verifies the death.
#[test]
fn a_failed_kill_is_never_a_stop() {
    let _guard = docker_lock();
    let binary = fake_docker(
        "killfail",
        "if [ \"$1\" = inspect ]; then echo true; exit 0; \
         else echo 'kill refused: container is in flight' >&2; exit 1; fi",
    );
    let bin = binary.to_str().unwrap();
    let err = ops::confirm_stopped(bin, "buzz-wcr-running").unwrap_err();
    assert!(
        err.contains("docker kill"),
        "a failed kill is not a verified stop: {err}"
    );
}

// ── prepare-time refusals (real daemon, cached fixture image) ───────────────

/// An image that declares writable VOLUMES is refused at prepare, before
/// anything runs: a check could fill an unbounded disk on the host.
#[test]
fn unsafe_image_with_declared_volumes_is_refused() {
    if !docker_available() {
        eprintln!("skip: docker not available");
        return;
    }
    let _guard = docker_lock();
    let tag = "buzz-test-volimg:never-run";
    let built = std::process::Command::new("docker")
        .args(["build", "--pull=false", "-t", tag, "-"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .and_then(|mut child| {
            use std::io::Write;
            child
                .stdin
                .as_mut()
                .unwrap()
                .write_all(b"FROM alpine:3.20\nVOLUME /writable-declared\n")
                .ok();
            child.wait_with_output()
        });
    match built {
        Ok(output) if output.status.success() => {}
        _ => {
            eprintln!("skip: the volume image could not be built locally");
            return;
        }
    }
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("artifact.txt"), "the artifact").unwrap();
    // The volume refusal happens at image resolution, before any governor or
    // helper is touched: an unused path proves no hidden dependency.
    let sandbox = sandbox::prepare(
        "docker",
        tag,
        dir.path().to_str().unwrap(),
        "/definitely-not-a-supervisor-with-this-run",
    );
    let unavailable = match &sandbox {
        sandbox::PreparedSandbox::Unavailable(reason) => reason.clone(),
        other => panic!("an image with declared volumes must be unavailable: {other:?}"),
    };
    assert!(
        unavailable.contains("writable container volumes"),
        "{unavailable}"
    );
    let _ = std::process::Command::new("docker")
        .args(["rmi", tag])
        .status();
}

/// Prepare with the trusted supervisor fixture (built once offline per
/// process; a blocked or failing fixture build turns into an `Unavailable`
/// so callers skip with a printed reason instead of counting as a pass).
fn prepare_with_fixture(dir: &std::path::Path) -> sandbox::PreparedSandbox {
    let supervisor = match super::tests::supervisor_fixture() {
        Some(path) => path,
        None => {
            return sandbox::PreparedSandbox::Unavailable(
                "skip: no trusted supervisor fixture (the offline build could not \
                 run)"
                    .into(),
            );
        }
    };
    sandbox::prepare(
        "docker",
        super::tests::FIXTURE_IMAGE,
        dir.to_str().unwrap_or_default(),
        supervisor.to_str().unwrap_or_default(),
    )
}

fn unpack_prepared_skip_if_unavailable(prepared: &sandbox::PreparedSandbox) -> bool {
    match prepared {
        sandbox::PreparedSandbox::Ready(_) => true,
        sandbox::PreparedSandbox::Unavailable(reason) => {
            eprintln!("skip: sandbox prepare refused ({reason}); nothing to prove here");
            false
        }
    }
}

/// A declared credential environment pair is refused BEFORE any container
/// exists — visible on the daemon: no container with the feature label.
#[test]
fn explicit_credential_env_is_denied_before_start() {
    if !docker_available() {
        eprintln!("skip: docker not available");
        return;
    }
    let _guard = docker_lock();
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("artifact.txt"), "the artifact").unwrap();
    let declaration = checks_decls(&[(
        "seeks-token",
        vec!["/bin/sh", "-c", "printenv GITHUB_TOKEN || true"],
    )]);
    let options = RunnerOptions {
        artifact_dir: dir.path().display().to_string(),
        envs: vec![("GITHUB_TOKEN".to_string(), "leaky-value".to_string())],
        per_check: Duration::from_secs(30),
        total_cap: Duration::from_secs(120),
        output_cap: 64 * 1024,
    };
    let prepared = prepare_with_fixture(dir.path());
    if !unpack_prepared_skip_if_unavailable(&prepared) {
        return;
    }
    let mut telemetry = sandbox::SandboxTelemetry::default();
    let outcome = sandbox::exec(
        &declaration.checks[0],
        0,
        &options,
        &prepared,
        Duration::from_secs(30),
        &mut telemetry,
    )
    .unwrap();
    assert_eq!(outcome.status, "failed");
    let failure = outcome.failure.as_ref().unwrap();
    assert!(
        failure.contains("Refused before it could run"),
        "the refusal happens before any container exists: {failure}"
    );
    // Nothing ran and nothing was created anywhere.
    assert!(!telemetry.ran_any);
    assert!(telemetry.config.is_none());
    assert_eq!(
        telemetry.containers_stopped_cleanly, 0,
        "no container means no cleanup either"
    );
    let feature_names = std::process::Command::new("docker")
        .args([
            "ps",
            "-a",
            "--filter",
            "label=buzz.work-check-run=1",
            "--format",
            "{{.Names}}",
        ])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();
    assert!(
        !feature_names.contains("buzz-wcr-"),
        "a refused check must not have started any container: {feature_names:?}"
    );
}

// ── the in-container deadline supervisor (host-CLI death) ───────────────────

/// Kill the host docker CLI mid-run: the container — forked descendants and
/// all — must END by the in-container deadline via the verified supervisor
/// (`--init` pid1 + `/usr/bin/timeout -s KILL <secs>`), even though nothing
/// host-side is watching it. The production seams bound here: the real
/// `container_argv` (with its full enforced flag set) and `spawn_run`.
#[test]
fn the_deadline_survives_host_cli_death() {
    if !docker_available() {
        eprintln!("skip: docker not available");
        return;
    }
    let _guard = docker_lock();
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("artifact.txt"), "the artifact").unwrap();
    let prepared = prepare_with_fixture(dir.path());
    let ready = match &prepared {
        sandbox::PreparedSandbox::Ready(ready) => ready,
        other => {
            eprintln!("skip: sandbox prepare refused ({other:?})");
            return;
        }
    };
    let spec = CheckSpec {
        name: "hangs-and-forks".into(),
        argv: vec![
            "/bin/sh".into(),
            "-c".into(),
            "echo started; ( sleep 100 ) & echo forked; sleep 100; wait".into(),
        ],
        criterion: None,
        note: None,
    };
    let deadline_secs: u64 = 2;
    let owner = ops::owner_key();
    let name = format!("buzz-wcr-survtest-{owner}");
    // Ownership recorded BEFORE creation, exactly like the real lifecycle.
    ops::record_owned(&owner, &name, &ready.image_id).unwrap();
    let argv = sandbox::container_argv(ready, &name, &spec, &[], deadline_secs);
    // The exact token shape is asserted in tests.rs; here assert the
    // supervisor's OWN argv is exactly [deadline, declared program...].
    let image_at = argv.iter().position(|w| w.starts_with("sha256:")).unwrap();
    assert_eq!(
        &argv[image_at + 1..image_at + 3],
        &["2".to_string(), "/bin/sh".to_string()],
        "the helper's own argv is the deadline then the declared program, \
         exactly: {:?}",
        &argv[image_at + 1..]
    );

    let mut child = ops::spawn_run(&ready.docker_bin, &argv).unwrap();
    // Let the container actually start (its first output), then kill ONLY the
    // host CLI — the daemon-side container keeps running, unsupervised by the
    // fork()ed client: exactly the failure mode a subagent demonstrated.
    std::thread::sleep(Duration::from_millis(400));
    let _ = child.kill();
    let _ = child.wait();
    drop(child);

    // The namespace must END by the deadline (the trusted helper kills the
    // check and its forked descendants die with the pid namespace) even
    // though nothing host-side removes the container object afterwards.
    let started = Instant::now();
    loop {
        match ops::container_state("docker", &name) {
            Ok(Some(false)) | Ok(None) => {
                assert!(
                    started.elapsed().as_millis() >= deadline_secs as u128 * 1000 - 400,
                    "the container must actually have run to its deadline, not die \
                     early (elapsed from the CLI kill: {:?})",
                    started.elapsed()
                );
                break;
            }
            Ok(Some(true)) => {
                assert!(
                    started.elapsed().as_millis() < deadline_secs as u128 * 1000 + 5_000,
                    "the container survived its in-container deadline without any \
                     host supervisor: {}s",
                    started.elapsed().as_secs_f32()
                );
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(e) => panic!("the daemon itself was unreachable during the wait: {e}"),
        }
    }
    // The dead container's object is the journal's to close: cleanup removes
    // this run's own finished leftover and closes the entry.
    let notes = sandbox::cleanup_finished("docker", &owner);
    match ops::container_state("docker", &name) {
        Ok(None) => {}
        other => panic!(
            "the journal-owned finished leftover must be removed right away \
             ({other:?}); notes {notes:?}"
        ),
    }
    ops::drop_owned(&owner, &name);
}

// ── ownership-scoped cleanup ────────────────────────────────────────────────

/// Cleanup removes ONLY finished containers a durable journal entry owns
/// (this owner, or a host-verified-dead owner). A concurrent run's live
/// container — however labelled — is never touched, and a finished container
/// with NO journal entry is left for its own owner's record.
#[test]
fn cleanup_touches_only_journalled_finished_containers() {
    if !docker_available() {
        eprintln!("skip: docker not available");
        return;
    }
    let _guard = docker_lock();
    // Clear every fixture this test could have left behind in an earlier
    // interrupted run: containers and their journal files.
    for stale in [
        "buzz-wcr-bystander-live",
        "buzz-wcr-unowned-finished",
        "buzz-wcr-dead-owner-finished",
        "buzz-wcr-own-finished",
    ] {
        let _ = std::process::Command::new("docker")
            .args(["rm", "-f", stale])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    if let Ok(entries) = std::fs::read_dir(ops::journal_root()) {
        for entry in entries.filter_map(|e| e.ok()) {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.ends_with(".json")
                && (name.contains("-bystander__")
                    || name.contains("deadowner__bitmap")
                    || name.contains("-deadowner__")
                    || name.contains("bystander2__"))
            {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    // A live bystander belonging to ANOTHER owner whose pid is alive (this
    // process): cleanup must leave it running.
    let other_owner = format!("pid{}-bystander", std::process::id());
    let bystander = "buzz-wcr-bystander-live";
    // Clear any stale fixture from a previous interrupted run.
    let _ = std::process::Command::new("docker")
        .args(["rm", "-f", bystander])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    let started = std::process::Command::new("docker")
        .args([
            "run",
            "-d",
            "--pull",
            "never",
            "--label",
            "buzz.work-check-run=1",
            "--label",
            &format!("buzz.wcr.owner={other_owner}"),
            "--name",
            bystander,
            "--network",
            "none",
            FIXTURE_IMAGE,
            "sleep",
            "120",
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    if !started.map(|s| s.success()).unwrap_or(false) {
        eprintln!("skip: could not start the bystander container");
        return;
    }
    write_journal_entry(
        &other_owner,
        bystander,
        // The bystander journal says its owner is this very process: alive.
        std::process::id(),
    );
    // A finished container that NO journal entry owns: never swept.
    let _ = std::process::Command::new("docker")
        .args([
            "run",
            "--pull",
            "never",
            "--label",
            "buzz.work-check-run=1",
            "--name",
            "buzz-wcr-unowned-finished",
            "--network",
            "none",
            FIXTURE_IMAGE,
            "true",
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    let notes = sandbox::cleanup_finished("docker", &ops::owner_key());
    assert!(
        container_running("buzz-wcr-bystander-live"),
        "a live bystander of another owner must be untouched: {notes:?}"
    );
    assert!(
        container_exists("buzz-wcr-unowned-finished"),
        "a journal-less container is nobody's to sweep: {notes:?}"
    );

    // A finished container whose journal owner's pid is verifiably DEAD is
    // removed, and its journal entry closes.
    let dead_owner = "pid2147483000-deadowner".to_string();
    let dead_name = "buzz-wcr-dead-owner-finished";
    let _ = std::process::Command::new("docker")
        .args([
            "run",
            "--pull",
            "never",
            "--label",
            "buzz.work-check-run=1",
            "--label",
            &format!("buzz.wcr.owner={dead_owner}"),
            "--name",
            dead_name,
            "--network",
            "none",
            FIXTURE_IMAGE,
            "true",
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    write_journal_entry_with_image(&dead_owner, dead_name, 2_147_483_000, &fixture_image_id());
    let notes = sandbox::cleanup_finished("docker", &ops::owner_key());
    assert!(
        !container_exists(dead_name),
        "a dead owner's finished container is recovered: {notes:?}"
    );
    assert!(
        !ops::journal_root()
            .join(format!("{dead_owner}__{dead_name}.json"))
            .exists(),
        "the closed entry leaves the journal"
    );
    assert!(
        notes.iter().any(|n| n.contains(dead_name)),
        "the recovery is reported for the record: {notes:?}"
    );

    // Cleanup again: the bystander is STILL untouched.
    let _ = sandbox::cleanup_finished("docker", &ops::owner_key());
    assert!(
        container_running(bystander),
        "a second cleanup still leaves the live bystander alone"
    );
    // Our own finished leftover (journal owner = this run) is removed: the
    // container carries the same owner label the journal records, so the
    // daemon's actual ownership can be verified before removal.
    let own_leftover = "buzz-wcr-own-finished";
    let own_owner = ops::owner_key();
    let own_label = format!("{}={own_owner}", ops::OWNER_LABEL);
    let _ = std::process::Command::new("docker")
        .args([
            "run",
            "--pull",
            "never",
            "--label",
            "buzz.work-check-run=1",
            "--label",
            &own_label,
            "--name",
            own_leftover,
            "--network",
            "none",
            FIXTURE_IMAGE,
            "true",
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    ops::record_owned(&own_owner, own_leftover, &fixture_image_id()).unwrap();
    let _ = sandbox::cleanup_finished("docker", &ops::owner_key());
    assert!(
        !container_exists(own_leftover),
        "an own finished leftover is recovered"
    );

    // Manual teardown of fixture-external state.
    let _ = std::process::Command::new("docker")
        .args(["rm", "-f", bystander, "buzz-wcr-unowned-finished"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    let _ =
        std::fs::remove_file(ops::journal_root().join(format!("{other_owner}__{bystander}.json")));
}

fn write_journal_entry(owner: &str, name: &str, pid: u32) {
    write_journal_entry_with_image(owner, name, pid, "")
}

fn write_journal_entry_with_image(owner: &str, name: &str, pid: u32, image_id: &str) {
    let entry = serde_json::json!({
        "name": name,
        "owner": owner,
        "imageId": image_id,
        "pid": pid,
        "createdAt": 0,
    });
    std::fs::create_dir_all(ops::journal_root()).unwrap();
    let path = ops::journal_root().join(format!("{owner}__{name}.json"));
    std::fs::write(path, entry.to_string()).unwrap();
}

/// The immutable fixture image pointer, read from the daemon (the journal's
/// pinned imageIds must match what the containers REALLY ran).
fn fixture_image_id() -> String {
    std::process::Command::new("docker")
        .args(["image", "inspect", "--format", "{{.Id}}", "alpine:3.20"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

fn container_exists(name: &str) -> bool {
    std::process::Command::new("docker")
        .args(["inspect", "--format", "{{.Id}}", name])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn container_running(name: &str) -> bool {
    std::process::Command::new("docker")
        .args(["inspect", "--format", "{{.State.Running}}", name])
        .output()
        .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == "true")
        .unwrap_or(false)
}

// ── the bounded reader: errors are records, hangs are bounded ───────────────

/// A stream that errors mid-read is an unknown record, never a silently
/// empty EOF.
struct FailingStream;
impl Read for FailingStream {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let first = buf.get_mut(0).map(|b| {
            *b = b'x';
            1
        });
        match first {
            Some(_) => Err(std::io::Error::other("injected stream failure")),
            None => Ok(0),
        }
    }
}

#[test]
fn a_broken_output_stream_is_recorded_not_eof() {
    let record = super::runner::join_reader(
        super::runner::spawn_reader(Some(FailingStream), 64),
        Duration::from_secs(2),
    );
    let error = record
        .error
        .as_ref()
        .unwrap_or_else(|| panic!("a failed read must be recorded: {:?}", record));
    assert!(error.contains("stream could not be read"), "{error}");
}

/// A stream that never returns blocks at most the bound: the join reports
/// unknown output and the caller's thread is free.
struct HangingStream;
impl Read for HangingStream {
    fn read(&mut self, _buf: &mut [u8]) -> std::io::Result<usize> {
        loop {
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

#[test]
fn a_hung_output_capture_is_bounded() {
    let start = Instant::now();
    let record = super::runner::join_reader(
        super::runner::spawn_reader(Some(HangingStream), 64),
        Duration::from_millis(250),
    );
    let error = record
        .error
        .as_ref()
        .unwrap_or_else(|| panic!("a hung capture must be recorded as unknown: {:?}", record));
    assert!(error.contains("did not finish"), "{error}");
    assert!(
        start.elapsed() < Duration::from_secs(3),
        "the join is bounded: {:?}",
        start.elapsed()
    );
}

/// An empty-but-closed stream keeps the honest empty record with NO error
/// (end-of-stream is exactly that), and truncation still marks.
#[test]
fn a_closed_stream_is_not_an_error() {
    let record = super::runner::join_reader(
        super::runner::spawn_reader(Some(EmptyStream), 64),
        Duration::from_secs(2),
    );
    assert!(record.error.is_none(), "{:?}", record.error);
    assert!(record.text.is_empty());
}

struct EmptyStream;
impl Read for EmptyStream {
    fn read(&mut self, _buf: &mut [u8]) -> std::io::Result<usize> {
        Ok(0)
    }
}

// ── the feature's own leftovers never leak an unrecorded container ─────────

/// A normal timed-out check under the supervisor leaves NO container running
/// (by the feature label) and no bystander of the run around: the bounded
/// lifecycle closes what it creates, and the concurrent bystander stays.
#[test]
fn timeout_own_container_removed_and_bystander_untouched() {
    if !docker_available() {
        eprintln!("skip: docker not available");
        return;
    }
    let _guard = docker_lock();
    // Bystander: another owner, live pid (whole process serves as owner).
    let other_owner = format!("pid{}-bystander2", std::process::id());
    let bystander = "buzz-wcr-bystander-timeout";
    // Clear any stale fixture from a previous interrupted run.
    let _ = std::process::Command::new("docker")
        .args(["rm", "-f", bystander])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    let started = std::process::Command::new("docker")
        .args([
            "run",
            "-d",
            "--pull",
            "never",
            "--label",
            "buzz.work-check-run=1",
            "--label",
            &format!("buzz.wcr.owner={other_owner}"),
            "--name",
            bystander,
            "--network",
            "none",
            FIXTURE_IMAGE,
            "sleep",
            "120",
        ])
        .output();
    match started {
        Ok(output) if output.status.success() => {}
        _ => {
            if let Ok(output) = started {
                eprintln!(
                    "skip: could not start the bystander container: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            return;
        }
    }
    write_journal_entry(&other_owner, bystander, std::process::id());

    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("artifact.txt"), "the artifact").unwrap();
    let declaration = checks_decls(&[(
        "hangs",
        vec![
            "/bin/sh",
            "-c",
            "( sleep 100 ) & echo forked; sleep 100; wait",
        ],
    )]);
    let options = opts(dir.path(), 2_000, 120_000, 64 * 1024);
    let prepared = prepare_with_fixture(dir.path());
    let ready = match &prepared {
        sandbox::PreparedSandbox::Ready(_) => true,
        other => {
            eprintln!("skip: prepare refused ({other:?})");
            false
        }
    };
    if !ready {
        let _ = std::process::Command::new("docker")
            .args(["rm", "-f", bystander])
            .status();
        return;
    }
    let (outcomes, telemetry) =
        super::runner::run_checks(&declaration, &options, &prepared).unwrap();
    let outcome = &outcomes[0];
    assert_eq!(outcome.status, "timed-out", "{:?}", outcome.failure);
    // Nothing of THIS run's owner is running any more (the bystander belongs
    // to another owner and stays up by design).
    let own_running = std::process::Command::new("docker")
        .args([
            "ps",
            "-a",
            "--filter",
            "label=buzz.work-check-run=1",
            "--filter",
            &format!("label=buzz.wcr.owner={}", ops::owner_key()),
            "--format",
            "{{.Status}}|{{.Names}}",
        ])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();
    assert!(
        own_running.trim().is_empty(),
        "the timed-out container (and its forked descendant) must be gone: \
         {own_running:?} — telemetry {telemetry:?}"
    );
    assert!(
        container_running(bystander),
        "the concurrent bystander's run must be untouched, all the way through"
    );
    let _ = std::process::Command::new("docker")
        .args(["rm", "-f", bystander])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    let _ =
        std::fs::remove_file(ops::journal_root().join(format!("{other_owner}__{bystander}.json")));
}

// ── B1: the trusted supervisor against the MALICIOUS stop repro ─────────────

const STOP_ALL_OTHERS: &str = "for p in /proc/[0-9]*; do pid=${p#/proc/}; \
if [ \"$pid\" != 1 ] && [ \"$pid\" != \"$$\" ]; then kill -STOP \"$pid\" 2>/dev/null \
|| true; fi; done; sleep 60";

/// THE reproduction the parent proved on the replaced busybox-watchdog: an
/// untrusted check SIGSTOPs every other process in its namespace and sleeps.
/// Under the trusted PID-1 supervisor the deadline still lands: the check is
/// `timed-out`, and nothing of this owner is left running. Real docker, the
/// FULL production shape (through `run_container`, journal included).
#[test]
fn the_untrusted_check_cannot_stop_the_watchdog() {
    if !docker_available() {
        eprintln!("skip: docker not available");
        return;
    }
    let _guard = docker_lock();
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("artifact.txt"), "the artifact").unwrap();
    let declaration = checks_decls(&[(
        "stops-watchdog-then-hangs",
        vec!["/bin/sh", "-c", STOP_ALL_OTHERS],
    )]);
    let options = opts(dir.path(), 2_000, 120_000, 64 * 1024);
    let prepared = prepare_with_fixture(dir.path());
    if !unpack_prepared_skip_if_unavailable(&prepared) {
        return;
    }
    let (outcomes, telemetry) =
        super::runner::run_checks(&declaration, &options, &prepared).unwrap();
    let outcome = &outcomes[0];
    assert_eq!(
        outcome.status, "timed-out",
        "the malicious check must end at its deadline, not hang: {:?}",
        outcome.failure
    );
    // Containment is about processes that are still RUNNING: after the
    // deadline the check's whole namespace must be ended. (`-a` would also
    // count a finished container another test in this process deliberately
    // left for the journal-recovery path.)
    let own_running = std::process::Command::new("docker")
        .args([
            "ps",
            "--filter",
            "label=buzz.work-check-run=1",
            "--filter",
            &format!("label=buzz.wcr.owner={}", ops::owner_key()),
            "--format",
            "{{.Status}}",
        ])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();
    assert!(
        own_running.trim().is_empty(),
        "the stopped watchdogs' namespace must be gone: {own_running:?} — telemetry \
         {telemetry:?}"
    );
}

/// The COMBINED worst case: the malicious stop-everything check AND the host
/// docker CLI killed mid-run — nothing host-side is watching, and the
/// untrusted check is actively fighting the deadline. The trusted PID-1
/// supervisor still ends the container by its deadline.
#[test]
fn the_deadline_survives_host_cli_death_during_a_malicious_stop() {
    if !docker_available() {
        eprintln!("skip: docker not available");
        return;
    }
    let _guard = docker_lock();
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("artifact.txt"), "the artifact").unwrap();
    let prepared = prepare_with_fixture(dir.path());
    let ready = match &prepared {
        sandbox::PreparedSandbox::Ready(ready) => ready,
        other => {
            eprintln!("skip: sandbox prepare refused ({other:?})");
            return;
        }
    };
    let spec = CheckSpec {
        name: "stops-watchdog-and-forks".into(),
        argv: vec![
            "/bin/sh".into(),
            "-c".into(),
            // `wait` keeps the shell alive after the fork: the check must run
            // to its deadline (a shell that merely backgrounds and exits is a
            // finished check, not a hanging one).
            format!("( sleep 100 ) & {STOP_ALL_OTHERS}"),
        ],
        criterion: None,
        note: None,
    };
    let deadline_secs: u64 = 3;
    let owner = ops::owner_key();
    let name = format!("buzz-wcr-evilcli-{owner}");
    ops::record_owned(&owner, &name, &ready.image_id).unwrap();
    let argv = sandbox::container_argv(ready, &name, &spec, &[], deadline_secs);
    let mut child = ops::spawn_run(&ready.docker_bin, &argv).unwrap();
    // The container starts, starts STOPping everything and forks; the CLI dies.
    std::thread::sleep(Duration::from_millis(500));
    let _ = child.kill();
    let _ = child.wait();
    drop(child);
    // Nothing host-side is alive to enforce the deadline; the helper must.
    let started = Instant::now();
    loop {
        match ops::container_state("docker", &name) {
            Ok(Some(false)) | Ok(None) => {
                assert!(
                    started.elapsed().as_millis() >= deadline_secs as u128 * 1000 - 400,
                    "the container must actually run to its deadline, not die early: \
                     {:?}",
                    started.elapsed()
                );
                break;
            }
            Ok(Some(true)) => {
                assert!(
                    started.elapsed().as_millis() < deadline_secs as u128 * 1000 + 5_000,
                    "the malicious check outlived its deadline even with the trusted \
                     PID-1 supervisor in the namespace: {}s",
                    started.elapsed().as_secs_f32()
                );
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(e) => panic!("the daemon itself was unreachable during the wait: {e}"),
        }
    }
    // The finished record goes to the journal for cleanup.
    let notes = sandbox::cleanup_finished("docker", &owner);
    assert!(
        matches!(ops::container_state("docker", &name), Ok(None)),
        "the journal-owned finished leftover must close right away: {notes:?}"
    );
    ops::drop_owned(&owner, &name);
}

/// An arbitrary operator binary cannot masquerade as the supervisor: even
/// with a self-consistent manifest the enforced-shape probes refuse it — the
/// deadline proof (exit 124 at the deadline) is what a masquerading payload
/// cannot produce. A helper without its manifest is refused outright.
#[test]
fn an_untrusted_helper_is_refused_fail_closed() {
    if !docker_available() {
        eprintln!("skip: docker not available");
        return;
    }
    let _guard = docker_lock();
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("artifact.txt"), "the artifact").unwrap();
    // (a) No manifest beside the binary at all.
    let refused = sandbox::prepare(
        "docker",
        FIXTURE_IMAGE,
        dir.path().to_str().unwrap(),
        "/definitely-not-a-supervisor2",
    );
    match &refused {
        sandbox::PreparedSandbox::Unavailable(reason) => {
            assert!(
                reason.contains("trusted deadline supervisor"),
                "a missing manifest must fail the supervisor closed: {reason}"
            );
        }
        other => panic!("no manifest means no sandbox: {other:?}"),
    }
    // (b) A masquerading helper WITH a self-consistent manifest that really
    // executes (a shell script exits 0 for any argv) but enforces no deadline:
    // the exec probe passes, and the deadline probe refuses it because it
    // cannot produce the supervisor's exit 124.
    let masquerade = tempfile::tempdir().unwrap();
    let fake_bin = masquerade.path().join("buzz-check-supervisor");
    let payload = "#!/bin/sh\nexit 0\n";
    std::fs::write(&fake_bin, payload).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake_bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let manifest = masquerade
        .path()
        .join("buzz-check-supervisor.manifest.json");
    let sha = super::tests::sha256_hex(&fake_bin);
    std::fs::write(
        &manifest,
        serde_json::json!({
            "profile": "trusted-rust-pid1-v1",
            "sourceSha256": sha,
            "binarySha256": sha,
            "sizeBytes": payload.len(),
        })
        .to_string(),
    )
    .unwrap();
    let refused = sandbox::prepare(
        "docker",
        FIXTURE_IMAGE,
        dir.path().to_str().unwrap(),
        fake_bin.to_str().unwrap(),
    );
    match &refused {
        sandbox::PreparedSandbox::Unavailable(reason) => {
            assert!(
                reason.contains("did not enforce the deadline"),
                "an arbitrary exec-capable helper must fail the deadline probe \
                 closed: {reason}"
            );
        }
        other => panic!("a masquerading helper must not open the sandbox: {other:?}"),
    }
}
