//! The bounded runner: declaration order, per-check budgets, total cap, and
//! the never-a-silent-success statuses. It does not spawn anything itself —
//! every check that actually runs is executed by the enforcing sandbox
//! (sandbox.rs); what the runner owns is the honest accounting around them:
//! budget skips stay `not-run` with reasons, failures stay `failed`, timeouts
//! stay `timed-out`, and nothing is rewritten into "nothing missing".

use std::io::Read;
use std::time::{Duration, Instant};

use super::checks::{now_secs, CheckSpec, ChecksDeclaration, RunnerOptions};
use super::sandbox;
use crate::error::CliError;

pub(crate) const STATUS_PASSED: &str = "passed";
pub(crate) const STATUS_FAILED: &str = "failed";
pub(crate) const STATUS_TIMED_OUT: &str = "timed-out";
pub(crate) const STATUS_NOT_RUN: &str = "not-run";

/// Appended to a cut excerpt, so a reader who only skims still sees the cut.
pub(crate) const TRUNCATION_MARKER: &str = "…[output cut]";

/// One executed (or honestly skipped) check, as it goes into the record
/// (identity bindings attach beside it when the record is built).
#[derive(Debug, Clone)]
pub(crate) struct CheckOutcome {
    pub name: String,
    pub argv: Vec<String>,
    pub criterion: Option<super::checks::CriterionSource>,
    pub note: Option<String>,
    pub status: &'static str,
    pub exit_status: Option<i64>,
    pub stdout: String,
    pub stderr: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub started_at: u64,
    pub ended_at: u64,
    pub duration_ms: u64,
    /// Why a check did not really execute (timeout, budget, unavailable).
    pub failure: Option<String>,
}

/// Run every declared check under the bounded rules, in declaration order.
/// Checks the overall budget skips come back as `not-run` — never passed,
/// never "nothing". Each check that *does* run executes inside its own
/// enforcing container (see sandbox.rs); a sandbox that is unavailable or a
/// containment failure aborts the rest of the run with not-run outcomes
/// rather than ever continuing outside confinement.
pub(crate) fn run_checks(
    declaration: &ChecksDeclaration,
    options: &RunnerOptions,
    sandbox: &sandbox::PreparedSandbox,
) -> Result<(Vec<CheckOutcome>, sandbox::SandboxTelemetry), CliError> {
    let dir = std::path::Path::new(&options.artifact_dir);
    if !dir.is_dir() {
        return Err(CliError::Usage(format!(
            "--dir {} is not a directory (the checks run with it snapshot read-only)",
            options.artifact_dir
        )));
    }
    let mut telemetry = sandbox::SandboxTelemetry::default();
    let total_deadline = Instant::now() + options.total_cap;
    let mut outcomes = Vec::with_capacity(declaration.checks.len());
    for (seq, spec) in declaration.checks.iter().enumerate() {
        if let Some(reason) = telemetry.containment_failure.clone() {
            // A containment failure ends the run for safety: after that
            // nothing runs anywhere near the machine or the snapshot.
            outcomes.push(aborted_outcome(spec, reason));
            continue;
        }
        if Instant::now()
            >= total_deadline
                .checked_sub(Duration::from_millis(10))
                .unwrap_or(total_deadline)
        {
            outcomes.push(skipped_outcome(spec));
            telemetry.budget_skips += 1;
            continue;
        }
        let remaining = total_deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            // A budget spent to the second cannot half-run a check either.
            outcomes.push(skipped_outcome(spec));
            telemetry.budget_skips += 1;
            continue;
        }
        let per_check = options.per_check.min(remaining);
        outcomes.push(sandbox::exec(
            spec,
            seq,
            options,
            sandbox,
            per_check,
            &mut telemetry,
        )?);
    }
    Ok((outcomes, telemetry))
}

fn skipped_outcome(spec: &CheckSpec) -> CheckOutcome {
    CheckOutcome {
        name: spec.name.clone(),
        argv: spec.argv.clone(),
        criterion: spec.criterion,
        note: spec.note.clone(),
        status: STATUS_NOT_RUN,
        exit_status: None,
        stdout: String::new(),
        stderr: String::new(),
        stdout_truncated: false,
        stderr_truncated: false,
        started_at: now_secs(),
        ended_at: now_secs(),
        duration_ms: 0,
        failure: Some(
            "Not run: the overall time budget was used up first. The result is unknown, \
             and the record keeps it unknown."
                .into(),
        ),
    }
}

fn aborted_outcome(spec: &CheckSpec, reason: String) -> CheckOutcome {
    CheckOutcome {
        name: spec.name.clone(),
        argv: spec.argv.clone(),
        criterion: spec.criterion,
        note: spec.note.clone(),
        status: STATUS_NOT_RUN,
        exit_status: None,
        stdout: String::new(),
        stderr: String::new(),
        stdout_truncated: false,
        stderr_truncated: false,
        started_at: now_secs(),
        ended_at: now_secs(),
        duration_ms: 0,
        failure: Some(format!(
            "Not run: containment failed after another check ({reason}). Everything after \
             that was stopped for safety."
        )),
    }
}

/// One stream read: text up to the cap, whether bytes were cut, and any
/// read ERROR. An error is never silently read as end-of-stream: it is
/// recorded, and the caller turns it into a failed/unknown result — never a
/// fake pass over lost output.
#[derive(Debug)]
pub(crate) struct CappedRead {
    pub text: String,
    pub truncated: bool,
    pub error: Option<String>,
}

/// The reader's handle. The thread returns its result over a channel so the
/// parent can wait for it WITH A BOUND; a capture that does not finish in
/// time is recorded as unknown, and the thread (whose pipe closes with the
/// child process) is never joined forever.
pub(crate) struct ReaderHandle {
    rx: Option<std::sync::mpsc::Receiver<CappedRead>>,
}

/// Read one output stream to its end, keeping at most `cap` bytes (and a
/// truncation marker when bytes were cut), while reading *on* past the cap so
/// a chatty command can never deadlock on a full pipe.
pub(crate) fn spawn_reader<R>(pipe: Option<R>, cap: usize) -> ReaderHandle
where
    R: Read + Send + 'static,
{
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut text: Vec<u8> = Vec::with_capacity(8_192);
        let mut truncated = false;
        let mut failed: Option<String> = None;
        if let Some(mut pipe) = pipe {
            let mut chunk = [0u8; 8_192];
            loop {
                match pipe.read(&mut chunk) {
                    Ok(0) => break,
                    Err(e) => {
                        failed = Some(format!("the stream could not be read: {e}"));
                        break;
                    }
                    Ok(n) => {
                        if text.len() < cap {
                            let take = (cap - text.len()).min(n);
                            text.extend_from_slice(&chunk[..take]);
                            if take < n {
                                truncated = true;
                            }
                        } else {
                            truncated = true;
                        }
                    }
                }
            }
        }
        let mut body = String::from_utf8_lossy(&text).into_owned();
        if truncated {
            body.push(' ');
            body.push_str(TRUNCATION_MARKER);
        }
        let recorded = CappedRead {
            text: body,
            truncated,
            error: failed,
        };
        // A receive-side gone means nobody is waiting; the result is theirs
        // to record as unknown, not ours to keep.
        let _ = tx.send(recorded);
    });
    ReaderHandle { rx: Some(rx) }
}

/// Bounded reader join: the capture, or an honest unknown-record when the
/// capture did not arrive in time (or its thread died). There is no silent
/// empty success, and no unbounded join.
pub(crate) fn join_reader(handle: ReaderHandle, timeout: Duration) -> CappedRead {
    let unknown = |why: String| CappedRead {
        text: String::new(),
        truncated: false,
        error: Some(why),
    };
    match handle.rx {
        None => unknown("the output capture was already consumed".into()),
        Some(rx) => match rx.recv_timeout(timeout) {
            Ok(record) => record,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => unknown(format!(
                "the output capture did not finish within {}s; what the check \
                 wrote there is unknown",
                timeout.as_secs().max(1)
            )),
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => unknown(
                "the output capture's reader failed before finishing; what the \
                 check wrote there is unknown"
                    .into(),
            ),
        },
    }
}

/// Trim an excerpt to the cap byte boundary, mark the cut, and scrub secrets.
pub(crate) fn sanitize_excerpt(
    text: &str,
    cap_bytes: usize,
    passed_env: &[(String, String)],
) -> String {
    let marker = text.len() > cap_bytes;
    let marked = if marker {
        let mut end = cap_bytes;
        while end > 0 && !text.is_char_boundary(end) {
            end -= 1;
        }
        let cut = text.get(..end).unwrap_or("");
        format!("{cut} {TRUNCATION_MARKER}")
    } else {
        text.to_string()
    };
    super::record::scrub_secrets(&marked, passed_env)
}
