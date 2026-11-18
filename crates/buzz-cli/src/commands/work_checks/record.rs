//! The signed record: identity bindings (words↔hash), secret scrubbing, and
//! the content build. The record keeps three things distinct — supplied
//! descriptions (the evidence packet, referenced by hash), executed results
//! (this record's `checks`), and model interpretation (optional `model`).
//! It never claims independence (fixed sentence), never states a sandbox that
//! was not verified (`sandboxEnforced` only after the runtime config is
//! verified), and its limitations state the sandbox truth plainly.

use serde_json::{json, Value};

use super::checks::{bounded, ChecksDeclaration, CriterionSource, MAX_WORDS_BYTES};
use super::runner::CheckOutcome;
use crate::error::CliError;
use buzz_evm_allowance::abi;

/// The sentence every record carries. It is fixed text, produced by the
/// runner, never by a check: the record must not claim independence.
pub(crate) const NOT_INDEPENDENT_VERIFICATION: &str = "These are the contributor's own \
execution records, not independent verification: the contributor ran these checks themselves. \
A creator agent's self-assessment is never labelled verification, and the reviewer's verdict \
stays theirs.";

/// One hash-bound criterion the checks map against: the claim's check words
/// (`claimCheck`) or a work area's words (`workArea`). `words` (when the
/// operator supplied them) are recorded so a reader can re-check the binding.
#[derive(Debug, Clone)]
pub(crate) struct CriterionBinding {
    pub source: CriterionSource,
    pub hash: String,
    pub words: Option<String>,
}

/// Verify the words↔hash bindings the operator asked for, and produce the
/// bindings a record claims. A `--check-text` that does not hash to
/// `--check-hash` means the record would bind a criterion it does not have:
/// refuse that, plainly.
pub(crate) fn bind_criteria(
    check_text: Option<&str>,
    check_hash: String,
    work_area_text: Option<&str>,
    work_area_hash: Option<&str>,
) -> Result<Vec<CriterionBinding>, CliError> {
    let mut bindings = vec![CriterionBinding {
        source: CriterionSource::ClaimCheck,
        hash: check_hash.clone(),
        words: None,
    }];
    if let Some(text) = check_text {
        let digest = format!("0x{}", hex::encode(abi::keccak256(text.trim().as_bytes())));
        if !digest.eq_ignore_ascii_case(&check_hash) {
            return Err(CliError::Usage(format!(
                "--check-text does not hash to --check-hash ({digest} vs {check_hash}): the \
                 record would claim a binding it does not have"
            )));
        }
        bindings[0].words = Some(
            bounded(text.trim(), MAX_WORDS_BYTES, "the check words")
                .map_err(CliError::Usage)?
                .to_string(),
        );
    }
    match (work_area_text, work_area_hash) {
        (Some(text), Some(hash)) => {
            let digest = format!("0x{}", hex::encode(abi::keccak256(text.trim().as_bytes())));
            if !digest.eq_ignore_ascii_case(hash) {
                return Err(CliError::Usage(format!(
                    "--work-area-text does not hash to --work-area-hash ({digest} vs {hash})"
                )));
            }
            bindings.push(CriterionBinding {
                source: CriterionSource::WorkArea,
                hash: hash.to_ascii_lowercase(),
                words: Some(
                    bounded(text.trim(), MAX_WORDS_BYTES, "the work-area words")
                        .map_err(CliError::Usage)?
                        .to_string(),
                ),
            });
        }
        (None, None) => {}
        (None, Some(_)) => {
            return Err(CliError::Usage(
                "--work-area-hash without --work-area-text: nothing to bind".into(),
            ))
        }
        (Some(_), None) => {
            return Err(CliError::Usage(
                "--work-area-text without --work-area-hash: say which hash the words bind to"
                    .into(),
            ))
        }
    }
    Ok(bindings)
}

fn criterion_for(bindings: &[CriterionBinding], source: Option<CriterionSource>) -> Value {
    match source {
        Some(source) => match bindings.iter().find(|b| b.source == source) {
            Some(binding) => json!({
                "source": match source {
                    CriterionSource::ClaimCheck => "claim-check",
                    CriterionSource::WorkArea => "work-area",
                },
                "hash": binding.hash,
                "words": binding.words,
            }),
            None => {
                // The declaration wants a mapping the run has no binding for:
                // it is labelled auxiliary rather than guessed at.
                Value::Null
            }
        },
        None => Value::Null,
    }
}

// ── secrets scrub ───────────────────────────────────────────────────────────

/// Redact secrets from captured output before the record is signed. Two
/// conservative passes:
///
/// 1. exact matches of every operator-passed environment value (length ≥ 8,
///    no whitespace) — the runner knows exactly what it handed over;
/// 2. a token scan for common credential shapes: AWS access keys, prefixed
///    API keys (`sk-`, `ghp_`/`gho_`/`ghs_`, `xox…`, `nsec…`), and values
///    sitting after key-ish words (`secret`, `token`, `password`, `bearer`,
///    `authorization`, or anything ending in `key`).
///
/// Non-credential tokens are preserved byte for byte, so argv echoes and
/// artifact hashes in the output stay intact. Best effort, and the record's
/// limitations say so.
pub(crate) fn scrub_secrets(text: &str, passed_env: &[(String, String)]) -> String {
    let mut out = text.to_string();
    for (key, value) in passed_env {
        if value.len() >= 8 && !value.contains(char::is_whitespace) {
            let redacted = format!("[redacted passed {}:]", key);
            out = replace_all(&out, value, &redacted);
        }
    }
    scrub_token_shapes(&out)
}

/// Scrub a *declared* string (argv) of the operator-passed environment values,
/// exactly. Unlike excerpts this skips the shape pass: commands are notation,
/// and word shapes inside them may legitimately match key-styled words.
pub(crate) fn replace_exact(text: &str, passed_env: &[(String, String)]) -> String {
    let mut out = text.to_string();
    for (key, value) in passed_env {
        if value.len() >= 8 && !value.contains(char::is_whitespace) {
            out = replace_all(&out, value, &format!("[redacted passed {}:]", key));
        }
    }
    out
}

fn replace_all(text: &str, needle: &str, replacement: &str) -> String {
    if !text.contains(needle) {
        return text.to_string();
    }
    text.split(needle).collect::<Vec<_>>().join(replacement)
}

/// Scan whitespace- and punctuation-delimited tokens, redacting credential
/// shapes and values that follow a key-ish token. Delimiters are preserved
/// verbatim.
fn scrub_token_shapes(text: &str) -> String {
    const DELIMS: &[char] = &[
        ' ', '\t', '\n', '\r', '"', '\'', '(', ')', ',', ';', '=', ':', '`',
    ];
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut keyish_prev = false;
    let mut i = 0usize;
    while i < chars.len() {
        if DELIMS.contains(&chars[i]) {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        let start = i;
        while i < chars.len() && !DELIMS.contains(&chars[i]) {
            i += 1;
        }
        let token: String = chars[start..i].iter().collect();
        let redact = token_redacts(&token, keyish_prev);
        if redact {
            out.push_str("[redacted]");
        } else {
            out.push_str(&token);
        }
        keyish_prev = is_keyish(&token);
    }
    out
}

const KEYISH_WORDS: [&str; 4] = ["bearer", "authorization", "secret", "password"];

fn is_keyish(token: &str) -> bool {
    let bare = token.trim_matches(|c: char| c == ':' || c == ',');
    let lower = bare.to_ascii_lowercase();
    KEYISH_WORDS.contains(&lower.as_str()) || lower.ends_with("key") || lower.ends_with("password")
}

fn token_redacts(token: &str, keyish_prev: bool) -> bool {
    let bare = token.trim_matches(|c: char| c == ':' || c == ',');
    let lower = bare.to_ascii_lowercase();
    if is_keyish(token) {
        return true; // the key word itself is replaced, so the *shape* it owned is gone
    }
    let behind_keyish =
        keyish_prev && lower != "authorization" && lower != "basic" && !lower.is_empty();
    let shaped = (token.starts_with("AKIA") && token.len() >= 20)
        || (token.starts_with("sk-") && token.len() >= 20)
        || (token.starts_with("ghp_") && token.len() >= 30)
        || (token.starts_with("gho_") && token.len() >= 30)
        || (token.starts_with("ghs_") && token.len() >= 30)
        || (token.starts_with("xox") && token.len() >= 20)
        || (token.starts_with("nsec") && token.len() >= 20);
    behind_keyish || shaped
}

// ── the record build ────────────────────────────────────────────────────────

/// Build the record content: bounded, scrubbed, statuses from the closed
/// vocabulary, auxiliary labelled, fixed no-independence sentence, the
/// sandbox block as observed (never claiming enforcement that was not
/// verified), and its limitations stating the sandbox truth. The `model`
/// section arrives separately and stays clearly separate.
#[allow(clippy::too_many_arguments)]
pub(crate) fn build_record(
    claim_word: &str,
    mandate: &str,
    evidence_hash: &str,
    bindings: &[CriterionBinding],
    declaration: &ChecksDeclaration,
    outcomes: &[CheckOutcome],
    output_cap_bytes: usize,
    envs: &[(String, String)],
    artifact_dir_name: &str,
    sandbox: Value,
    model: Option<Value>,
) -> Value {
    let passed_env = envs;
    let sandbox_enforced = sandbox.get("enforced").and_then(Value::as_bool) == Some(true);
    let claim_check = bindings
        .iter()
        .find(|b| b.source == CriterionSource::ClaimCheck);
    let work_area = bindings
        .iter()
        .find(|b| b.source == CriterionSource::WorkArea);
    let criteria = json!({
        "claimCheck": claim_check.map(|b| json!({ "hash": b.hash, "words": b.words })),
        "workArea": work_area.map(|b| json!({ "hash": b.hash, "words": b.words })),
    });

    let mut summary =
        json!({ "passed": 0, "failed": 0, "timedOut": 0, "notRun": 0, "auxiliary": 0 });
    let bump = |field: &str, summary: &mut Value| {
        summary[field] = json!(summary[field].as_u64().unwrap_or(0) + 1);
    };
    let mut checks = Vec::with_capacity(outcomes.len());
    for outcome in outcomes {
        let auxiliary = outcome.criterion.is_none();
        // A mapping the run has no binding for is auxiliary too: the record
        // does not guess.
        let mapped = outcome
            .criterion
            .is_some_and(|source| bindings.iter().any(|b| b.source == source));
        let auxiliary = auxiliary || !mapped;
        if auxiliary {
            bump("auxiliary", &mut summary);
        }
        match outcome.status {
            super::runner::STATUS_PASSED => bump("passed", &mut summary),
            super::runner::STATUS_FAILED => bump("failed", &mut summary),
            super::runner::STATUS_TIMED_OUT => bump("timedOut", &mut summary),
            _ => bump("notRun", &mut summary),
        }
        checks.push(outcome_json(
            outcome,
            output_cap_bytes,
            passed_env,
            auxiliary,
            bindings,
        ));
    }

    let limitations = vec![
        "Ran on the contributor's own machine: the machine, its tools and its inputs are as \
         this record lists them, and nothing here proves otherwise."
            .into(),
        "Best-effort secret scrubbing before signing: a leak that does not look like a \
         credential could still be shown."
            .into(),
        if envs.is_empty() {
            "The checks' environment carried no variables of this run (only what the sandbox \
             image itself sets). Only names are recorded; values never are, and anything \
             sensitive the operator passed was redacted from the output before signing."
                .into()
        } else {
            "The checks' environment carried only the variables named here. Only names are \
             recorded; values never are, and anything sensitive the operator passed was \
             redacted from the output before signing."
                .into()
        },
        format!(
            "Output excerpts are cut at {output_cap_bytes} bytes per stream; the record says \
             when it cut one."
        ),
        "The runner never fetched addresses or network resources: what the artifact, the \
         evidence text or the output says to fetch is data, not a command the runner obeyed."
            .into(),
        // Sandbox truth, in the record itself and never softened. These are
        // the contributor's own runs either way; enforcement only bounds what
        // the run could reach.
        if sandbox_enforced {
            "The checks ran inside an enforcing sandbox whose configuration was verified \
             before the record was signed (see sandbox). That bounds what the run could \
             reach — it says nothing about whether the artifact or its claims are true, \
             and it is not independent verification."
                .into()
        } else {
            "No enforced sandbox: the checks did not run confined, or did not run at all \
             (see sandbox). Whatever this record lists as passed or failed, judge it as \
             the contributor's own account — never as machine evidence."
                .into()
        },
    ];

    let artifacts: Vec<Value> = declaration
        .artifacts
        .iter()
        .map(|artifact| {
            json!({
                "name": artifact.name,
                "path": artifact.path,
                "sha256": artifact.sha256,
                "version": artifact.version,
            })
        })
        .collect();

    // sha256 over the run's identity inputs, so a record is identifiable
    // without depending on the event id alone.
    let started_min = outcomes.iter().map(|c| c.started_at).min().unwrap_or(0);
    let run_preimage =
        format!("buzz.work-checks:v1:{claim_word}:{mandate}:{evidence_hash}:{started_min}");
    let run = hash_of(run_preimage.as_bytes());

    json!({
        "v": 1,
        "type": "work-check-run",
        "run": run,
        "claim": { "id": claim_word, "mandate": mandate },
        "evidenceHash": evidence_hash,
        "criteria": criteria,
        "checks": checks,
        "envNames": envs.iter().map(|(k, _)| k.clone()).collect::<Vec<_>>(),
        "artifactDirName": artifact_dir_name,
        "artifacts": artifacts,
        "summary": summary,
        "sandboxEnforced": sandbox_enforced,
        "sandbox": sandbox,
        "notIndependentVerification": NOT_INDEPENDENT_VERIFICATION,
        "limitations": limitations,
        "model": model.unwrap_or(Value::Null),
    })
}

fn hash_of(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("0x{}", hex::encode(Sha256::digest(data)))
}

/// One record `checks[]` entry: statuses from the closed vocabulary,
/// auxiliary labelled, excerpts sanitized (cap + marker + scrub), and the
/// declared argv scrubbed of operator-passed values — notation, not captured
/// output, but the record never carries the value it was told to pass.
pub(crate) fn outcome_json(
    outcome: &CheckOutcome,
    output_cap_bytes: usize,
    passed_env: &[(String, String)],
    auxiliary: bool,
    bindings: &[CriterionBinding],
) -> Value {
    json!({
        "name": outcome.name,
        "argv": outcome
            .argv
            .iter()
            .map(|arg| replace_exact(arg, passed_env))
            .collect::<Vec<_>>(),
        "auxiliary": auxiliary,
        "criterion": criterion_for(bindings, outcome.criterion),
        "status": outcome.status,
        "exitStatus": outcome.exit_status,
        "stdout": super::runner::sanitize_excerpt(&outcome.stdout, output_cap_bytes, passed_env),
        "stderr": super::runner::sanitize_excerpt(&outcome.stderr, output_cap_bytes, passed_env),
        "stdoutTruncated": outcome.stdout_truncated,
        "stderrTruncated": outcome.stderr_truncated,
        "note": outcome.note,
        "notRunReason": outcome.failure,
        "startedAt": outcome.started_at,
        "endedAt": outcome.ended_at,
        "durationMs": outcome.duration_ms,
    })
}
