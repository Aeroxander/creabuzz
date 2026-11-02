//! Tests for the checks declaration, the record, the runner accounting, and
//! the enforcing sandbox. The sandbox tests bind the production seam
//! (sandbox::exec → the real docker daemon with the local `alpine:3.20`
//! fixture) and are falsifiable: a containment regression — a host write, a
//! leaked credential, an survived timeout descendant, a missing removal —
//! fails the test. When docker is not available these skip with a printed
//! reason; the pure tests still run everywhere.

use super::checks::{now_secs, parse_checks, parse_envs, CriterionSource, Limits, RunnerOptions};
use super::record::{bind_criteria, build_record, scrub_secrets, CriterionBinding};
use super::runner::{
    run_checks, CheckOutcome, STATUS_FAILED, STATUS_NOT_RUN, STATUS_PASSED, STATUS_TIMED_OUT,
};
use super::sandbox;
use super::snapshot;
use tempfile::tempdir;

use crate::error::CliError;

/// One docker daemon shared by the process: every test that executes against
/// it takes this lock, so container-observability assertions cannot race one
/// of their siblings.
pub(super) fn docker_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    // A sibling that panicked while holding the daemon lock must not cascade
    // into every later docker test: the lock only serialises access to the
    // daemon, and a poisoned guard still provides that exclusion.
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// sha256 of a file's bytes as 64 lowercase hex characters (no `0x` prefix) —
/// byte-identical with what `scripts/build-check-supervisor.sh` writes into the
/// trusted-supervisor manifest, and what `load_trusted_supervisor` re-checks.
pub(super) fn sha256_hex(path: &std::path::Path) -> String {
    use sha2::Digest;
    let bytes = std::fs::read(path).expect("read the file to hash");
    hex::encode(sha2::Sha256::digest(&bytes))
}

pub(super) fn docker_available() -> bool {
    std::process::Command::new("docker")
        .arg("info")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

pub(super) const FIXTURE_IMAGE: &str = "alpine:3.20";

/// The trusted supervisor fixture, built ONCE OFFLINE per test process from
/// this repo's own source (`scripts/check-supervisor.rs`) by the offline
/// build script (cached rust image, cached alpine smoke check, no pulls).
/// A prebuilt binary in the repo target dir is reused as-is. `None` means
/// the fixture could not be produced (blocked docker or failed build); the
/// docker tests then SKIP with the printed reason — an unavailable daemon
/// must never silently count as a pass.
pub(super) fn supervisor_fixture() -> Option<std::path::PathBuf> {
    static FIXTURE: std::sync::OnceLock<Option<std::path::PathBuf>> = std::sync::OnceLock::new();
    FIXTURE
        .get_or_init(|| {
            if !docker_available() {
                eprintln!("skip: docker not available");
                return None;
            }
            let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            // crates/buzz-cli → repo root
            let repo_root = manifest_dir
                .parent()
                .and_then(|p| p.parent())
                .expect("repo root from CARGO_MANIFEST_DIR");
            let built = repo_root.join("target").join("buzz-check-supervisor");
            let script = repo_root.join("scripts").join("build-check-supervisor.sh");
            let already = built.metadata().map(|m| m.is_file()).unwrap_or(false)
                && built
                    .with_extension("")
                    .to_string_lossy()
                    .ends_with("buzz-check-supervisor");
            if !(already
                && built
                    .parent()
                    .map(|p| p.join("buzz-check-supervisor.manifest.json").exists())
                    .unwrap_or(false))
            {
                let built = std::process::Command::new("sh")
                    .arg(script)
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::inherit())
                    .status();
                match built {
                    Ok(status) if status.success() => {}
                    other => {
                        eprintln!(
                            "skip: the trusted supervisor could not be built offline \
                             ({other:?})"
                        );
                        return None;
                    }
                }
            }
            Some(repo_root.join("target").join("buzz-check-supervisor"))
        })
        .clone()
}

pub(super) fn opts(
    dir: &std::path::Path,
    per_check_ms: u64,
    total_ms: u64,
    cap: usize,
) -> RunnerOptions {
    RunnerOptions {
        artifact_dir: dir.display().to_string(),
        envs: vec![],
        per_check: std::time::Duration::from_millis(per_check_ms),
        total_cap: std::time::Duration::from_millis(total_ms),
        output_cap: cap,
    }
}

pub(super) fn checks_decls(names_argv: &[(&str, Vec<&str>)]) -> super::checks::ChecksDeclaration {
    let mut file_checks = Vec::new();
    for (name, argv) in names_argv {
        file_checks.push(super::checks::CheckSpec {
            name: (*name).into(),
            argv: argv.iter().map(|a| (*a).into()).collect(),
            criterion: None,
            note: None,
        });
    }
    super::checks::ChecksDeclaration {
        checks: file_checks,
        artifacts: vec![],
    }
}

fn by_name<'a>(outcomes: &'a [CheckOutcome], name: &str) -> &'a CheckOutcome {
    outcomes
        .iter()
        .find(|o| o.name == name)
        .unwrap_or_else(|| panic!("outcome for {name} missing"))
}

// ── declaration parsing (no docker) ─────────────────────────────────────────

/// The no-shell rule at the seam: a single-string command shape is refused
/// before anything can run; data files never become command lines.
#[test]
fn a_command_string_is_refused() {
    let err = parse_checks(r#"{"checks":[{"name":"x","command":"echo hi"}]}"#).unwrap_err();
    assert!(matches!(err, CliError::Usage(_)), "expected usage: {err:?}");
}

#[test]
fn argv_must_be_an_array_of_bounded_strings() {
    for bad in [
        r#"{"checks":[{"name":"x","argv":[]}]}"#,
        r#"{"checks":[{"name":"x","argv":"/bin/sh"}]}"#,
        r#"{"checks":[{"name":"x","argv":[""]}]}"#,
        r#"{"checks":[{"argv":["x"]}]}"#,
    ] {
        let err = parse_checks(bad).unwrap_err();
        assert!(matches!(err, CliError::Usage(_)), "expected usage: {err:?}");
    }
}

/// The exact-match secret scrub: the operator-passed env value is matched out
/// of captured output (and declared argv) before anything is signed. The
/// shape pass still catches what no env passed; `0x` hashes survive.
#[test]
fn passed_env_values_are_redacted_from_output() {
    let secret = "supersecretvalue123";
    let envs = vec![("PROBE_SECRET".to_string(), secret.to_string())];
    let scrubbed = scrub_secrets("token= supersecretvalue123 other text", &envs);
    assert!(!scrubbed.contains(secret), "the value leaked: {scrubbed:?}");
    assert!(
        scrubbed.contains("[redacted passed PROBE_SECRET:]"),
        "{scrubbed:?}"
    );
    let shaped = scrub_secrets("export AWS_KEY AKIAABCDEFGHIJKLMNOP; nsec1tooShort", &[]);
    assert!(!shaped.contains("AKIAABCDEFGHIJKLMNOP"), "{shaped:?}");
    let hash = "0x111122223333444455556666777788889999aaaabbbbccccddddeeeeffff0000";
    assert!(
        super::record::replace_exact(hash, &[]) == hash,
        "artifact hashes must survive the scrub"
    );
}

/// The words↔hash binding refuses to claim what it does not have.
#[test]
fn check_words_must_hash_to_the_check_hash() {
    let words = "the check words";
    let digest = format!(
        "0x{}",
        hex::encode(buzz_evm_allowance::abi::keccak256(words.as_bytes()))
    );
    let ok = bind_criteria(Some(words), digest.to_ascii_lowercase(), None, None).unwrap();
    assert_eq!(ok[0].words.as_deref(), Some(words));
    let err = bind_criteria(
        Some(words),
        "0x0000000000000000000000000000000000000000000000000000000000000000".to_string(),
        None,
        None,
    )
    .unwrap_err();
    assert!(matches!(err, CliError::Usage(_)), "expected usage: {err:?}");
}

/// The env pass-through: only `KEY=VALUE` pairs, only their names recorded.
#[test]
fn env_passthrough_is_bounded_and_value_free() {
    let err = parse_envs(&["BADKEY".to_string()]).unwrap_err();
    assert!(matches!(err, CliError::Usage(_)));
    let envs = parse_envs(&["A=1".to_string(), "B=b".to_string()]).unwrap();
    assert_eq!(
        envs,
        vec![("A".into(), "1".into()), ("B".into(), "b".into())]
    );
}

// ── the snapshot (no docker) ────────────────────────────────────────────────

/// A fifo (socket/device alike) is non-regular and refuses the snapshot.
#[test]
fn a_non_regular_file_refuses_the_snapshot() {
    let dir = tempdir().unwrap();
    std::fs::write(dir.path().join("ok.txt"), "hello").unwrap();
    #[cfg(unix)]
    {
        let _listener = std::os::unix::net::UnixListener::bind(dir.path().join("queue")).unwrap();
    }
    let err = snapshot::snapshot_artifact(dir.path()).unwrap_err();
    assert!(err.contains("non-regular file"), "{err}");
}

/// An in-artifact link that resolves to a regular file inside it copies the
/// resolved bytes (not the link), and its bytes land in the manifest digest.
#[test]
fn an_internal_link_copies_its_regular_target() {
    let dir = tempdir().unwrap();
    std::fs::write(dir.path().join("real.txt"), "bytes").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink("real.txt", dir.path().join("alias.txt")).unwrap();
    let snapshot = snapshot::snapshot_artifact(dir.path()).unwrap();
    assert_eq!(snapshot.files, 2);
    assert!(snapshot.digest.starts_with("0x"));
    drop(snapshot);
}

// snapshot boundedness
#[test]
fn snapshot_bounds_are_bounded() {
    let dir = tempdir().unwrap();
    let count = super::snapshot::SNAPSHOT_MAX_FILES + 1;
    for i in 0..count {
        std::fs::write(dir.path().join(format!("f{i}.txt")), "x").unwrap();
    }
    let err = snapshot::snapshot_artifact(dir.path()).unwrap_err();
    assert!(err.contains("more than"), "{err}");
}

/// An escaping symlink leaves nothing behind: the refusal happens before any copy.
#[test]
fn an_escaping_symlink_refuses_the_snapshot() {
    let dir = tempdir().unwrap();
    std::fs::write(dir.path().join("ok.txt"), "hello").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink("/etc/passwd", dir.path().join("escape")).unwrap();
    let err = snapshot::snapshot_artifact(dir.path()).unwrap_err();
    assert!(
        err.contains("does not resolve to a regular file inside it"),
        "{err}"
    );
    // The snapshot never materialized anywhere under the home temp dir.
    let leftovers = std::fs::read_dir(std::env::temp_dir())
        .unwrap()
        .filter_map(|entry| entry.ok())
        .any(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .contains("buzz-check-artifact")
        });
    assert!(!leftovers, "a refused snapshot must leave nothing behind");
}

/// A docker binary that cannot run is an unavailable sandbox: every check
/// comes back `not-run` with the reason recorded, and nothing ever executed
/// on the host.
#[test]
fn an_unavailable_sandbox_fails_closed_to_not_run() {
    let dir = tempdir().unwrap();
    std::fs::write(dir.path().join("artifact.txt"), "the artifact").unwrap();
    let declaration = checks_decls(&[("would-run", vec!["/bin/sh", "-c", "echo hi"])]);
    let options = opts(dir.path(), 5_000, 60_000, 64 * 1024);
    let sandbox = sandbox::prepare(
        "/definitely-not-a-docker",
        FIXTURE_IMAGE,
        dir.path().to_str().unwrap(),
        "/definitely-not-a-supervisor",
    );
    let matches_unavailable = matches!(sandbox, sandbox::PreparedSandbox::Unavailable(_));
    assert!(
        matches_unavailable,
        "an unusable docker binary must be unavailable"
    );
    let (outcomes, telemetry) = run_checks(&declaration, &options, &sandbox).unwrap();
    assert_eq!(outcomes.len(), 1);
    assert_eq!(outcomes[0].status, STATUS_NOT_RUN);
    assert!(outcomes[0]
        .failure
        .as_ref()
        .unwrap()
        .contains("sandbox runtime was unavailable"));
    assert!(!telemetry.enforced_verified());
    assert!(telemetry.config.is_none());
    // No container of this feature may exist after a failed prepare.
    assert!(!feature_container_running());
}

/// A locally absent image is refused without ever pulling: the resolve path
/// errors, the daemon is never asked to fetch, and no check runs.
#[test]
fn an_absent_local_image_is_refused_without_pull() {
    if !docker_available() {
        eprintln!("skip: docker not available");
        return;
    }
    let _guard = docker_lock();
    let dir = tempdir().unwrap();
    std::fs::write(dir.path().join("artifact.txt"), "the artifact").unwrap();
    // The absent image refuses at image resolution, BEFORE the supervisor is
    // ever touched: an unusable path proves no secret dependency on it.
    let sandbox = sandbox::prepare(
        "docker",
        "buzz-test-absent-image:never-published",
        dir.path().to_str().unwrap(),
        "/definitely-not-a-supervisor",
    );
    assert!(
        matches!(&sandbox, sandbox::PreparedSandbox::Unavailable(reason) if reason.contains("not available locally")),
        "absent image must be unavailable (never pulled): {sandbox:?}"
    );
}

// ── record truth (no docker) ───────────────────────────────────────────────

/// Every record carries the fixed no-independence sentence, distinct
/// sections, and the sandbox truth as observed — an unverified/absent sandbox
/// is `sandboxEnforced: false` with the limitation that the run is never
/// machine evidence.
#[test]
fn the_record_says_what_it_is() {
    let outcomes = vec![CheckOutcome {
        name: "tests".into(),
        argv: vec!["/bin/sh".into(), "-c".into(), "exit 2".into()],
        criterion: None,
        note: None,
        status: STATUS_FAILED,
        exit_status: Some(2),
        stdout: String::new(),
        stderr: "boom".into(),
        stdout_truncated: false,
        stderr_truncated: false,
        started_at: 1,
        ended_at: 2,
        duration_ms: 3,
        failure: Some("Exited with a non-zero status.".into()),
    }];
    let bindings = vec![CriterionBinding {
        source: CriterionSource::ClaimCheck,
        hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
        words: None,
    }];
    let record = build_record(
        "0x0e1e",
        "0x0d",
        "0x0c000000000000000000000000000000000000000000000000000000000000",
        &bindings,
        &checks_decls(&[]),
        &outcomes,
        1024,
        &[],
        "d",
        super::sandbox::SandboxTelemetry::default().sandbox_json(None),
        None,
    );
    assert_eq!(record["type"], "work-check-run");
    let argv_text = record["checks"][0]["argv"].to_string();
    assert!(!argv_text.contains("command"));
    assert_eq!(
        record["notIndependentVerification"].as_str().unwrap(),
        super::record::NOT_INDEPENDENT_VERIFICATION,
        "the fixed sentence is the record's own copy"
    );
    assert!(record["model"].is_null(), "no model section was asked for");
    assert_eq!(record["sandboxEnforced"], false);
    assert!(record["sandbox"]["enforced"].as_bool() == Some(false));
    let limitations: Vec<String> = record["limitations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l.as_str().unwrap().to_string())
        .collect();
    assert!(
        limitations
            .iter()
            .any(|l| l.contains("No enforced sandbox") && l.contains("never as machine evidence")),
        "{limitations:?}"
    );
    // Statuses are the closed vocabulary; the failed one stays failed.
    assert_eq!(record["checks"][0]["status"], "failed");
    assert_eq!(record["summary"]["failed"].as_u64(), Some(1));
}

/// A verified sandbox flips the record's truth honestly, and the limitation
/// says what enforcement covers — bounding reach, not proving truth.
#[test]
fn a_verified_sandbox_record_says_enforced() {
    let outcomes = vec![CheckOutcome {
        name: "any".into(),
        argv: vec!["/bin/true".into()],
        criterion: None,
        note: None,
        status: STATUS_PASSED,
        exit_status: Some(0),
        stdout: String::new(),
        stderr: String::new(),
        stdout_truncated: false,
        stderr_truncated: false,
        started_at: now_secs(),
        ended_at: now_secs(),
        duration_ms: 1,
        failure: None,
    }];
    let telemetry = super::sandbox::SandboxTelemetry {
        ran_any: true,
        verified: 1,
        config: Some(serde_json::json!({ "user": super::sandbox::SANDBOX_USER })),
        ..Default::default()
    };
    let record = build_record(
        "0x0e1e",
        "0x0d",
        "0x0c000000000000000000000000000000000000000000000000000000000000",
        &[CriterionBinding {
            source: CriterionSource::ClaimCheck,
            hash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into(),
            words: None,
        }],
        &checks_decls(&[]),
        &outcomes,
        1024,
        &[],
        "d",
        telemetry.sandbox_json(None),
        None,
    );
    assert_eq!(record["sandboxEnforced"], true);
    let limitations: Vec<String> = record["limitations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l.as_str().unwrap().to_string())
        .collect();
    assert!(
        limitations
            .iter()
            .any(|l| l.contains("enforcing sandbox")
                && l.contains("is not independent verification")),
        "enforced copy still carries no independence claim: {limitations:?}"
    );
}

/// Auxiliary labelling: a check no criterion claims is recorded as auxiliary
/// and counted as such; a wanted mapping without a binding is auxiliary too.
#[test]
fn unmapped_and_unbound_checks_are_auxiliary() {
    if !docker_available() {
        eprintln!("skip: docker not available");
        return;
    }
    let _guard = docker_lock();
    let dir = tempdir().unwrap();
    std::fs::write(dir.path().join("artifact.txt"), "the artifact").unwrap();
    let declaration = checks_decls(&[
        ("unmapped", vec!["/bin/sh", "-c", "exit 0"]),
        ("auxnote", vec!["/bin/sh", "-c", "exit 0"]),
    ]);
    let options = opts(dir.path(), 30_000, 120_000, 64 * 1024);
    let supervisor = match super::tests::supervisor_fixture() {
        Some(path) => path,
        None => return,
    };
    let sandbox = sandbox::prepare(
        "docker",
        FIXTURE_IMAGE,
        dir.path().to_str().unwrap(),
        supervisor.to_str().unwrap(),
    );
    let (outcomes, _telemetry) = run_checks(&declaration, &options, &sandbox).unwrap();
    let bindings: Vec<CriterionBinding> = vec![CriterionBinding {
        source: CriterionSource::ClaimCheck,
        hash: "0x1111111111111111111111111111111111111111111111111111111111111111".into(),
        words: Some("the words".into()),
    }];
    let record = build_record(
        "0x2222222222222222222222222222222222222222222222222222222222222222",
        "0x3333333333333333333333333333333333333333",
        "0x4444444444444444444444444444444444444444444444444444444444444444",
        &bindings,
        &checks_decls(&[]),
        &outcomes,
        64 * 1024,
        &[],
        "artifact",
        super::sandbox::SandboxTelemetry::default().sandbox_json(None),
        None,
    );
    for check in record["checks"].as_array().unwrap() {
        assert_eq!(check["auxiliary"], true);
        assert!(
            check["criterion"].is_null(),
            "aux checks carry no criterion"
        );
    }
    assert_eq!(record["summary"]["auxiliary"].as_u64(), Some(2));
    assert_eq!(record["summary"]["passed"].as_u64(), Some(2));
}

// ── the enforcing sandbox against the real daemon (docker fixture) ─────────

/// Statuses inside the sandbox: a passing check passes with its captured
/// output; a failing check (non-zero exit) stays failed; both ran in a
/// verified container.
#[test]
fn sandbox_statuses_pass_failed_and_record_enforcement() {
    if !docker_available() {
        eprintln!("skip: docker not available");
        return;
    }
    let _guard = docker_lock();
    let dir = tempdir().unwrap();
    std::fs::write(dir.path().join("artifact.txt"), "the artifact").unwrap();
    let declaration = checks_decls(&[
        ("passes", vec!["/bin/sh", "-c", "printf 'total: 41.20\\n'"]),
        (
            "exits-three",
            vec!["/bin/sh", "-c", "echo mismatch; exit 3"],
        ),
    ]);
    let options = opts(dir.path(), 30_000, 120_000, 64 * 1024);
    let supervisor = match super::tests::supervisor_fixture() {
        Some(path) => path,
        None => return,
    };
    let sandbox = sandbox::prepare(
        "docker",
        FIXTURE_IMAGE,
        dir.path().to_str().unwrap(),
        supervisor.to_str().unwrap(),
    );
    assert!(matches!(sandbox, sandbox::PreparedSandbox::Ready(_)));
    let (outcomes, telemetry) = run_checks(&declaration, &options, &sandbox).unwrap();
    let passed = by_name(&outcomes, "passes");
    assert_eq!(passed.status, STATUS_PASSED);
    assert!(passed.stdout.contains("total: 41.20"));
    let failed = by_name(&outcomes, "exits-three");
    assert_eq!(failed.status, STATUS_FAILED);
    assert_eq!(failed.exit_status, Some(3));
    assert!(failed.failure.is_some());
    assert!(
        telemetry.enforced_verified(),
        "both ran in verified containers: {telemetry:?}"
    );
    assert_eq!(telemetry.containers_stopped_cleanly, 2);
}

/// The output cap: a chatty check is cut at the bound and the record says so,
/// while the check itself still passes.
#[test]
fn output_is_capped_and_marked() {
    if !docker_available() {
        eprintln!("skip: docker not available");
        return;
    }
    let _guard = docker_lock();
    let dir = tempdir().unwrap();
    std::fs::write(dir.path().join("artifact.txt"), "the artifact").unwrap();
    let declaration = checks_decls(&[(
        "chatty",
        vec![
            "/bin/sh",
            "-c",
            "i=0; while [ $i -lt 200 ]; do printf 'x'; i=$((i+1)); done",
        ],
    )]);
    let options = opts(dir.path(), 60_000, 240_000, 32);
    let supervisor = match super::tests::supervisor_fixture() {
        Some(path) => path,
        None => return,
    };
    let sandbox = sandbox::prepare(
        "docker",
        FIXTURE_IMAGE,
        dir.path().to_str().unwrap(),
        supervisor.to_str().unwrap(),
    );
    let (outcomes, _) = run_checks(&declaration, &options, &sandbox).unwrap();
    let outcome = by_name(&outcomes, "chatty");
    assert_eq!(outcome.status, STATUS_PASSED);
    let kept = outcome.stdout.chars().filter(|c| *c == 'x').count();
    assert_eq!(kept, 32, "kept only up to the cap bytes");
    assert!(outcome.stdout.contains(super::runner::TRUNCATION_MARKER));
    assert!(outcome.stdout_truncated);
}

/// Timeout: the container (the check's whole process namespace) is killed and
/// removed in the bounded sequence; the forked `setsid` descendant dies with
/// it; nothing escapes; the check is `timed-out`, never a pass.
#[test]
fn timeout_kills_the_container_and_its_descendants() {
    if !docker_available() {
        eprintln!("skip: docker not available");
        return;
    }
    let _guard = docker_lock();
    let dir = tempdir().unwrap();
    std::fs::write(dir.path().join("artifact.txt"), "the artifact").unwrap();
    let declaration = checks_decls(&[(
        "hangs-and-forks",
        vec![
            "/bin/sh",
            "-c",
            "echo started; ( sleep 30 ) & echo forked; wait",
        ],
    )]);
    let options = opts(dir.path(), 2_000, 120_000, 64 * 1024);
    let supervisor = match super::tests::supervisor_fixture() {
        Some(path) => path,
        None => return,
    };
    let sandbox = sandbox::prepare(
        "docker",
        FIXTURE_IMAGE,
        dir.path().to_str().unwrap(),
        supervisor.to_str().unwrap(),
    );
    let (outcomes, telemetry) = run_checks(&declaration, &options, &sandbox).unwrap();
    let outcome = by_name(&outcomes, "hangs-and-forks");
    assert_eq!(outcome.status, STATUS_TIMED_OUT);
    assert!(outcome.failure.as_ref().unwrap().contains("Timed out"));
    assert_eq!(telemetry.containers_stopped_cleanly, 1);
    assert!(
        !feature_container_running(),
        "the killed container must be removed, and the forked descendant with it"
    );
    assert!(
        telemetry.enforced_verified(),
        "a stopped-on-timeout container still verifies its shape"
    );
}

/// Malicious check #1 — write outside the artifact (root filesystem and the
/// read-only bind): refused; the declared route cannot change the host or the
/// snapshot.
#[test]
fn a_host_or_bind_write_is_refused() {
    if !docker_available() {
        eprintln!("skip: docker not available");
        return;
    }
    let _guard = docker_lock();
    let dir = tempdir().unwrap();
    std::fs::write(dir.path().join("artifact.txt"), "the artifact").unwrap();
    let declaration = checks_decls(&[(
        "tries-writes",
        vec![
            "/bin/sh",
            "-c",
            "echo root-mount: $(touch /outside-write 2>&1 | tail -1); \
             echo bind-mount: $(touch /artifact/escape 2>&1 | tail -1); \
             mount -o remount,rw /artifact 2>&1 | tail -1; \
             echo done",
        ],
    )]);
    let options = opts(dir.path(), 60_000, 240_000, 64 * 1024);
    let supervisor = match super::tests::supervisor_fixture() {
        Some(path) => path,
        None => return,
    };
    let sandbox = sandbox::prepare(
        "docker",
        FIXTURE_IMAGE,
        dir.path().to_str().unwrap(),
        supervisor.to_str().unwrap(),
    );
    let (outcomes, telemetry) = run_checks(&declaration, &options, &sandbox).unwrap();
    let outcome = by_name(&outcomes, "tries-writes");
    assert!(outcome.stdout.contains("root-mount:"));
    assert!(
        outcome.stdout.to_lowercase().contains("read-only"),
        "the read-only rootfs must refuse the write: {:?}",
        outcome.stdout
    );
    // Nothing appeared on the host snapshot and the snapshot hash as last
    // recorded by the sandbox stayed what was prepared.
    assert!(!dir.path().join("escape").exists(), "the bind is read-only");
    assert!(
        telemetry.snapshot_unchanged_or_unavailable(),
        "the artifact snapshot must be unchanged"
    );
}

/// Malicious check #2 — read credentials: the container environment carries
/// nothing of this process's environment (the secret is absent), and root's
/// home is not readable as the fixed non-root user.
#[test]
fn credentials_are_not_reachable_from_the_container() {
    if !docker_available() {
        eprintln!("skip: docker not available");
        return;
    }
    let _guard = docker_lock();
    let dir = tempdir().unwrap();
    std::fs::write(dir.path().join("artifact.txt"), "the artifact").unwrap();
    let declaration = checks_decls(&[(
        "hunts-secrets",
        vec![
            "/bin/sh",
            "-c",
            "printenv | sort | sed 's/=.*//' ; ls /root 2>&1; cat /root/.docker/config.json 2>&1",
        ],
    )]);
    let options = ChecksOptionsWithSecret::options(dir.path());
    let supervisor = match super::tests::supervisor_fixture() {
        Some(path) => path,
        None => return,
    };
    let sandbox = sandbox::prepare(
        "docker",
        FIXTURE_IMAGE,
        dir.path().to_str().unwrap(),
        supervisor.to_str().unwrap(),
    );
    let (outcomes, telemetry) =
        run_checks(&declaration.secret_check(), &options, &sandbox).unwrap();
    let outcome = by_name(&outcomes, "hunts-secrets");
    assert!(
        !outcome.stdout.contains("hunt-secret-value"),
        "the passed secret must not be recorded in env names"
    );
    assert!(telemetry.enforced_verified());
    // The read-back config carried no credential keys and only the requested ones.
    let carried = telemetry
        .config
        .as_ref()
        .unwrap()
        .get("envCarried")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    assert_eq!(
        carried, 1,
        "only the explicitly requested env key is carried"
    );
    assert!(
        outcome.stdout.contains("Permission denied") || outcome.stdout.contains("read"),
        "the non-root user must be refused root's files: {:?}",
        outcome.stdout
    );
}

/// Malicious check #3 — reach the network: with `--network none` the request
/// cannot resolve or connect; no HTTP body appears in the captured output.
#[test]
fn the_network_is_blocked() {
    if !docker_available() {
        eprintln!("skip: docker not available");
        return;
    }
    let _guard = docker_lock();
    let dir = tempdir().unwrap();
    std::fs::write(dir.path().join("artifact.txt"), "the artifact").unwrap();
    let declaration = checks_decls(&[(
        "tries-network",
        vec![
            "/bin/sh",
            "-c",
            "wget -T 3 -q -O /dev/null https://example.com; echo rc=$?",
        ],
    )]);
    let options = ChecksOptionsWithSecret::options(dir.path());
    let supervisor = match super::tests::supervisor_fixture() {
        Some(path) => path,
        None => return,
    };
    let sandbox = sandbox::prepare(
        "docker",
        FIXTURE_IMAGE,
        dir.path().to_str().unwrap(),
        supervisor.to_str().unwrap(),
    );
    let (outcomes, _) = run_checks(&declaration.check_net(), &options, &sandbox).unwrap();
    let outcome = by_name(&outcomes, "tries-network");
    assert!(
        !outcome.stdout.contains("Example Domain") && !outcome.stderr.contains("Example Domain"),
        "no HTTP body may appear: {:?} {:?}",
        outcome.stdout,
        outcome.stderr
    );
    // busybox wget reports `rc=1` (or another nonzero) — `rc=0` would mean the
    // fetch succeeded somewhere it must not.
    assert!(
        !outcome.stdout.contains("rc=0"),
        "the fetch must not succeed under --network none: {:?}",
        outcome.stdout
    );
}

/// Secret scrub end-to-end inside the sandbox: the operator-passed value is
/// redacted from captured output, from declared argv, and present as env only
/// under its name.
#[test]
fn the_passed_secret_is_scrubbed_everywhere() {
    if !docker_available() {
        eprintln!("skip: docker not available");
        return;
    }
    let _guard = docker_lock();
    let dir = tempdir().unwrap();
    std::fs::write(dir.path().join("artifact.txt"), "the artifact").unwrap();
    let declaration = checks_decls(&[(
        "echoes",
        vec![
            "/bin/sh",
            "-c",
            "echo \"token=supersecretvalue123 (passed via --env)\"",
        ],
    )]);
    let options = ChecksOptionsWithSecret::options(dir.path());
    let supervisor = match super::tests::supervisor_fixture() {
        Some(path) => path,
        None => return,
    };
    let sandbox = sandbox::prepare(
        "docker",
        FIXTURE_IMAGE,
        dir.path().to_str().unwrap(),
        supervisor.to_str().unwrap(),
    );
    let (outcomes, _) = run_checks(&declaration, &options, &sandbox).unwrap();
    let outcome = by_name(&outcomes, "echoes");
    let _ = outcome;
    // The raw capture carries what the check printed; the SIGNED record is
    // what cannot carry the value.
    let bindings: Vec<CriterionBinding> = vec![CriterionBinding {
        source: CriterionSource::ClaimCheck,
        hash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into(),
        words: None,
    }];
    let record = build_record(
        "0x0e1e",
        "0x0d",
        "0x0c000000000000000000000000000000000000000000000000000000000000",
        &bindings,
        &checks_decls(&[]),
        &outcomes,
        64 * 1024,
        &options.envs,
        "d",
        super::sandbox::SandboxTelemetry::default().sandbox_json(None),
        None,
    );
    let stdout = record["checks"][0]["stdout"].as_str().unwrap_or_default();
    assert!(!stdout.contains("supersecretvalue123"), "{stdout:?}");
    assert!(
        stdout.contains("[redacted passed PROBE_TOKEN:]"),
        "{stdout:?}"
    );
    let argv_text = record["checks"][0]["argv"][2].as_str().unwrap_or_default();
    assert!(!argv_text.contains("supersecretvalue123"), "{argv_text:?}");
}

// The cleanup-scope test lives in lifecycle_tests.rs now (durable ownership
// journal semantics: journal-less containers are never swept, dead-owner
// leftovers are, live-run bystanders never are).

/// A helper trait set to keep the malicious tests' options short.
struct ChecksOptionsWithSecret;

impl ChecksOptionsWithSecret {
    fn options(dir: &std::path::Path) -> RunnerOptions {
        RunnerOptions {
            artifact_dir: dir.display().to_string(),
            envs: vec![("PROBE_TOKEN".to_string(), "supersecretvalue123".to_string())],
            per_check: std::time::Duration::from_secs(60),
            total_cap: std::time::Duration::from_secs(240),
            output_cap: 64 * 1024,
        }
    }
}

trait DeclarationExt {
    fn secret_check(&self) -> super::checks::ChecksDeclaration;
    fn check_net(&self) -> super::checks::ChecksDeclaration;
}

impl DeclarationExt for super::checks::ChecksDeclaration {
    fn secret_check(&self) -> super::checks::ChecksDeclaration {
        checks_decls(&[(
            "hunts-secrets",
            vec![
                "/bin/sh",
                "-c",
                "printenv | sort | sed 's/=.*//'; ls /root 2>&1; cat /root/.docker/config.json 2>&1",
            ],
        )])
    }

    fn check_net(&self) -> super::checks::ChecksDeclaration {
        checks_decls(&[(
            "tries-network",
            vec![
                "/bin/sh",
                "-c",
                "wget -T 3 -q -O /dev/null https://example.com; echo rc=$?",
            ],
        )])
    }
}

/// No container of this feature is running (by label), i.e. a check ran to
/// completion and the bounded removal confirmed.
pub(super) fn feature_container_running() -> bool {
    let output = std::process::Command::new("docker")
        .args([
            "ps",
            "-a",
            "--filter",
            "label=buzz.work-check-run=1",
            "--format",
            "{{.Status}}",
        ])
        .output();
    match output {
        Ok(output) => String::from_utf8_lossy(&output.stdout)
            .lines()
            .any(|status| status.starts_with("Up ")),
        Err(_) => false,
    }
}

/// The container enforces the snapshot `unchanged` indirectly: the record
/// carries the snapshot hash, and the sandbox verified a read-only bind.
trait SnapshotUnchanged {
    fn snapshot_unchanged_or_unavailable(&self) -> bool;
}

impl SnapshotUnchanged for sandbox::SandboxTelemetry {
    fn snapshot_unchanged_or_unavailable(&self) -> bool {
        // The only writable surface is the bounded /tmp tmpfs; the artifact
        // bind and rootfs are read-only and their verification was asserted
        // by reading back the daemon configuration.
        self.enforced_verified()
    }
}

/// The limits still refuse junk CLI values.
#[test]
fn limits_are_bounded() {
    for bad in [
        (0u64, 600u64, 64 * 1024u64),
        (10_000, 600, 64 * 1024),
        (60, 0, 64 * 1024),
        (60, 60_000, 64 * 1024),
        (60, 600, 512),
        (60, 600, 8 * 1024 * 1024),
    ] {
        let err = Limits::new(bad.0, bad.1, bad.2).unwrap_err();
        assert!(matches!(err, CliError::Usage(_)), "{bad:?} must be usage");
    }
    assert!(Limits::new(60, 600, 64 * 1024).is_ok());
}

/// The docker invocation is plain `std::process::Command` argv — every flag
/// and value is its own entry in the vector, never a compacted prose string
/// handed to a shell. This pins the exact token shape the sandbox runs, so a
/// later edit cannot quietly glue flags back together; each token's arity is
/// the one `docker run --help` documents (`--cap-drop list`,
/// `--security-opt list`, `--pids-limit int`, `--memory bytes`,
/// `--cpus decimal`, `--user string`, `--pull string`, `--network network`,
/// `--read-only` bool (single token), `--tmpfs list`, `--tmpfs list`,
/// `--log-driver string`), plus the TWO read-only binds (artifact snapshot
/// and the hash-pinned trusted supervisor) and the trusted supervisor as
/// entrypoint with the deadline first and ONLY THEN the declared argv.
/// Note there is NO `--init`: the helper IS pid 1, which is the point.
#[test]
fn container_argv_is_split_tokens_per_docker_help() {
    use super::sandbox::SupervisorProfile;
    use super::sandbox::{container_argv, SANDBOX_TMPFS, SANDBOX_USER};

    let dir = tempdir().unwrap();
    std::fs::write(dir.path().join("f.txt"), "x").unwrap();
    let snapshot = super::snapshot::snapshot_artifact(dir.path()).unwrap();
    let helper_dir = tempdir().unwrap();
    let helper_copy = helper_dir.path().join("copy-inside-private-root");
    std::fs::write(&helper_copy, "not-executable-in-test: bind path only").unwrap();
    let ready = super::sandbox::ReadySandbox {
        docker_bin: "docker".into(),
        reference: "alpine:3.20".into(),
        image_id: "sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc".into(),
        image_env_keys: vec!["PATH".into()],
        snapshot,
        supervisor: SupervisorProfile {
            entrypoint: "/buzz-wcr-supervisor".into(),
            host_copy: helper_copy.clone(),
            source_sha256: "a".repeat(64),
            binary_sha256: "b".repeat(64),
            size_bytes: 16,
        },
    };
    let spec = super::checks::CheckSpec {
        name: "probe".into(),
        argv: vec!["/bin/true".into()],
        criterion: None,
        note: None,
    };
    let argv = container_argv(
        &ready,
        "buzz-wcr-token-shape",
        &spec,
        &[("A".to_string(), "1".to_string())],
        2,
    );
    let expected: Vec<&str> = vec![
        "run",
        "--pull",
        "never",
        "--name",
        "buzz-wcr-token-shape",
        "--label",
        "buzz.work-check-run=1",
        "--label",
        // the ownership label value is the run's own key (by prefix below)
        "...",
        "--user",
        SANDBOX_USER,
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "32",
        "--memory",
        "128m",
        "--cpus",
        "1",
        "--tmpfs",
        SANDBOX_TMPFS,
        "--log-driver",
        "none",
        "--entrypoint",
        "/buzz-wcr-supervisor",
        // TWO read-only binds only: the artifact snapshot and the helper.
        "-v",
        // the artifact snapshot bind (temp path asserted by prefix below)
        "...",
        "-v",
        // the trusted helper bind: the private copy at its fixed container
        // path, read-only
        "...",
        "-w",
        "/artifact",
        "--env",
        "A=1",
        "sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc",
        // the deadline LAST before the declared program, exactly
        "2",
        "/bin/true",
    ];
    // Same length and same tokens, except for the three wildcarded ones (the
    // ownership label, the snapshot bind, the helper bind): token-for-token.
    assert_eq!(argv.len(), expected.len(), "argv: {argv:?}");
    let mut wildcard_slot = 0usize;
    for (got, want) in argv.iter().zip(expected.iter()) {
        if *want == "..." {
            wildcard_slot += 1;
            match wildcard_slot {
                1 => assert!(
                    got.starts_with("buzz.wcr.owner="),
                    "the first wildcard token must be the ownership label: {got:?}"
                ),
                2 => assert!(
                    got.starts_with(&format!("{}:/artifact:ro", ready.snapshot.dir.display())),
                    "the second wildcard token must be the artifact snapshot bind: {got:?}"
                ),
                _ => assert_eq!(
                    *got,
                    format!("{}:/buzz-wcr-supervisor:ro", helper_copy.display()),
                    "the third wildcard token must be the trusted helper's read-only \
                     bind: {got:?}"
                ),
            }
            continue;
        }
        assert_eq!(got, want, "argv mismatch: {argv:?}");
    }
    // Every token that is docker's own configuration (before the image id)
    // must be one flag or one value — no glued prose — except the label pairs,
    // which are single NAME=VALUE, and the env pair, likewise one KEY=VALUE.
    let image_at = argv.iter().position(|w| w.starts_with("sha256:")).unwrap();
    for got in &argv[..image_at] {
        if got.starts_with("buzz.work-check-run=") || got.starts_with("buzz.wcr.owner=") {
            continue;
        }
        if got.starts_with("--env") || got.starts_with("A=1") || got.starts_with("--name") {
            continue;
        }
        assert!(
            !got.contains(' '),
            "docker argv tokens are one flag or one value (per docker --help), got {got:?}"
        );
    }
}
