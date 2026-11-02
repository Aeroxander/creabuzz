//! The checks declaration: what `work-checks` is allowed to run, parsed
//! strictly from the data file. This is the seam where data stays data: a
//! `command` *string* is refused (a single command line is never interpreted,
//! with a shell or without), argv entries are bounded arrays of short
//! strings, and names/notes/criterion words are bounded because they end up
//! in a signed record other people read.
//!
//! Also here: the `--env KEY=VALUE` pass-through parser (the only environment
//! the checks ever see) and the CLI's runtime-limit bounds.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::Value;

use crate::error::CliError;

/// Most checks in one declaration: a claim's work is a handful of commands.
pub(crate) const MAX_CHECKS: usize = 12;
/// Most argv entries in one check: a program and its arguments.
pub(crate) const MAX_ARGV: usize = 8;
/// Most bytes in one argv entry: a long flag, a path, a short snippet.
pub(crate) const MAX_ARG_ENTRY_BYTES: usize = 512;
/// Most bytes for a check's name.
pub(crate) const MAX_NAME_BYTES: usize = 64;
/// Most bytes for a check's note.
pub(crate) const MAX_NOTE_BYTES: usize = 280;
/// Most artifact entries copied into the record.
pub(crate) const MAX_ARTIFACTS: usize = 16;
/// Most bytes for a criterion's recorded words.
pub(crate) const MAX_WORDS_BYTES: usize = 2_000;
/// Most env vars the operator may pass through.
pub(crate) const MAX_ENVS: usize = 16;
/// Most bytes of the checks declaration file.
pub(crate) const CHECKS_FILE_MAX_BYTES: u64 = 64 * 1024;

pub(crate) const DEFAULT_CHECK_TIMEOUT_SECS: u64 = 60;
pub(crate) const DEFAULT_TOTAL_CAP_SECS: u64 = 600;
pub(crate) const DEFAULT_OUTPUT_CAP_BYTES: u64 = 64 * 1024;
pub(crate) const MIN_CHECK_TIMEOUT_SECS: u64 = 1;
pub(crate) const MAX_CHECK_TIMEOUT_SECS: u64 = 1_800;
pub(crate) const MIN_TOTAL_CAP_SECS: u64 = 1;
pub(crate) const MAX_TOTAL_CAP_SECS: u64 = 3_600;
pub(crate) const MIN_OUTPUT_CAP_BYTES: u64 = 1_024;
pub(crate) const MAX_OUTPUT_CAP_BYTES: u64 = 1_024 * 1_024;

/// Which accepted criterion a check maps to. `claim-check` binds to the words
/// the claim is judged against; `work-area` to a work area's published words.
/// Absent (or `none`) means auxiliary, and the record labels it so.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CriterionSource {
    ClaimCheck,
    WorkArea,
}

fn parse_criterion(value: &str) -> Result<Option<CriterionSource>, CliError> {
    match value {
        "claim-check" => Ok(Some(CriterionSource::ClaimCheck)),
        "work-area" => Ok(Some(CriterionSource::WorkArea)),
        "none" | "auxiliary" => Ok(None),
        other => Err(CliError::Usage(format!(
            "a check's criterion is \"claim-check\", \"work-area\", or \"none\" (got {other:?})"
        ))),
    }
}

#[derive(Debug, Clone)]
pub(crate) struct CheckSpec {
    pub name: String,
    pub argv: Vec<String>,
    pub criterion: Option<CriterionSource>,
    pub note: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct ArtifactSpec {
    pub name: String,
    pub path: String,
    pub sha256: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct ChecksDeclaration {
    pub checks: Vec<CheckSpec>,
    pub artifacts: Vec<ArtifactSpec>,
}

/// Parse the checks declaration JSON. Strict about what runs: `checks[*].argv`
/// must be a non-empty array of short strings (a `command` *string* is
/// refused — data files are never re-interpreted as command lines), names and
/// notes are bounded, and counts are bounded.
pub(crate) fn parse_checks(raw: &str) -> Result<ChecksDeclaration, CliError> {
    let value: Value =
        serde_json::from_str(raw).map_err(|e| CliError::Usage(format!("checks JSON: {e}")))?;
    let list = value
        .get("checks")
        .and_then(Value::as_array)
        .ok_or_else(|| CliError::Usage("checks JSON needs a \"checks\" array".into()))?;
    if list.is_empty() {
        return Err(CliError::Usage(
            "the checks declaration has no checks; nothing to run".into(),
        ));
    }
    if list.len() > MAX_CHECKS {
        return Err(CliError::Usage(format!(
            "at most {MAX_CHECKS} checks in one declaration (got {})",
            list.len()
        )));
    }
    let mut checks = Vec::with_capacity(list.len());
    for (index, entry) in list.iter().enumerate() {
        let obj = entry
            .as_object()
            .ok_or_else(|| CliError::Usage(format!("checks[{index}] must be an object")))?;
        if let Some(bad) = obj.get("command") {
            return Err(CliError::Usage(format!(
                "checks[{index}] has a \"command\" field {bad}: checks run as argv arrays \
                 only; a command-line string is never interpreted, with a shell or without"
            )));
        }
        let name =
            required_string(obj, "name", &format!("checks[{index}]"), MAX_NAME_BYTES)?.to_string();
        let argv = argv_of(obj, index)?;
        let criterion = match obj.get("criterion") {
            None => None,
            Some(Value::String(word)) => parse_criterion(word)?,
            Some(other) => {
                return Err(CliError::Usage(format!(
                    "checks[{index}].criterion must be a string (got {other})"
                )))
            }
        };
        let note = match obj.get("note") {
            None | Some(Value::Null) => None,
            Some(Value::String(text)) => Some(
                bounded(text, MAX_NOTE_BYTES, "checks note")
                    .map_err(|e| CliError::Usage(format!("checks[{index}].note: {e}")))?
                    .to_string(),
            ),
            Some(other) => {
                return Err(CliError::Usage(format!(
                    "checks[{index}].note must be a string (got {other})"
                )))
            }
        };
        checks.push(CheckSpec {
            name,
            argv,
            criterion,
            note,
        });
    }
    let mut artifacts = Vec::new();
    if let Some(list) = value.get("artifacts").and_then(Value::as_array) {
        if list.len() > MAX_ARTIFACTS {
            return Err(CliError::Usage(format!(
                "at most {MAX_ARTIFACTS} artifacts in one declaration (got {})",
                list.len()
            )));
        }
        for (index, entry) in list.iter().enumerate() {
            let obj = entry
                .as_object()
                .ok_or_else(|| CliError::Usage(format!("artifacts[{index}] must be an object")))?;
            let version = match obj.get("version") {
                None | Some(Value::Null) => None,
                Some(Value::String(text)) => Some(
                    bounded(text, MAX_NOTE_BYTES, "artifact version")
                        .map_err(|e| CliError::Usage(format!("artifacts[{index}].version: {e}")))?
                        .to_string(),
                ),
                Some(other) => {
                    return Err(CliError::Usage(format!(
                        "artifacts[{index}].version must be a string (got {other})"
                    )))
                }
            };
            artifacts.push(ArtifactSpec {
                name: required_string(obj, "name", &format!("artifacts[{index}]"), MAX_NAME_BYTES)?
                    .to_string(),
                path: required_string(obj, "path", &format!("artifacts[{index}]"), 256)?
                    .to_string(),
                sha256: optional_sha256(obj, "sha256", index)?,
                version,
            });
        }
    }
    Ok(ChecksDeclaration { checks, artifacts })
}

fn required_string<'a>(
    obj: &'a serde_json::Map<String, Value>,
    key: &str,
    label: &str,
    max_bytes: usize,
) -> Result<&'a str, CliError> {
    match obj.get(key) {
        Some(Value::String(text)) => {
            bounded(text, max_bytes, &format!("{label}.{key}")).map_err(CliError::Usage)
        }
        Some(other) => Err(CliError::Usage(format!(
            "{label}.{key} must be a string (got {other})"
        ))),
        None => Err(CliError::Usage(format!("{label} needs a {key}"))),
    }
}

/// Bound a string on byte length and refuse NUL/control bytes: these strings
/// end up in a signed record other people read.
pub(crate) fn bounded<'a>(text: &'a str, max_bytes: usize, what: &str) -> Result<&'a str, String> {
    if text.len() > max_bytes {
        return Err(format!(
            "{what} is at most {max_bytes} bytes (got {})",
            text.len()
        ));
    }
    if text.bytes().any(|b| b < 0x20 && b != b'\t') {
        return Err(format!("{what} must not contain control characters"));
    }
    Ok(text)
}

fn argv_of(obj: &serde_json::Map<String, Value>, index: usize) -> Result<Vec<String>, CliError> {
    let list = obj
        .get("argv")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            CliError::Usage(format!(
                "checks[{index}].argv must be an array of strings; a single command string \
                 is refused on purpose (the runner never routes arguments through a shell)"
            ))
        })?
        .clone();
    if list.is_empty() {
        return Err(CliError::Usage(format!(
            "checks[{index}].argv must name the program to run"
        )));
    }
    if list.len() > MAX_ARGV {
        return Err(CliError::Usage(format!(
            "checks[{index}].argv: at most {MAX_ARGV} entries (got {})",
            list.len()
        )));
    }
    let mut argv = Vec::with_capacity(list.len());
    for (i, entry) in list.iter().enumerate() {
        let text = entry.as_str().ok_or_else(|| {
            CliError::Usage(format!(
                "checks[{index}].argv[{i}] must be a string (got {entry})"
            ))
        })?;
        if text.is_empty() {
            return Err(CliError::Usage(format!(
                "checks[{index}].argv[{i}] must not be empty"
            )));
        }
        bounded(text, MAX_ARG_ENTRY_BYTES, "checks argv entry")
            .map_err(|e| CliError::Usage(format!("checks[{index}].argv[{i}]: {e}")))?;
        argv.push(text.to_string());
    }
    Ok(argv)
}

fn optional_sha256(
    obj: &serde_json::Map<String, Value>,
    key: &str,
    index: usize,
) -> Result<Option<String>, CliError> {
    match obj.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => {
            if text.len() == 64 && text.bytes().all(|b| b.is_ascii_hexdigit()) {
                Ok(Some(text.to_ascii_lowercase()))
            } else {
                Err(CliError::Usage(format!(
                    "artifacts[{index}].{key} must be 64 hex characters (got {text:?})"
                )))
            }
        }
        Some(other) => Err(CliError::Usage(format!(
            "artifacts[{index}].{key} must be a string (got {other})"
        ))),
    }
}

/// Parse `KEY=VALUE` pass-through entries. Only these reach the checks.
pub(crate) fn parse_envs(entries: &[String]) -> Result<Vec<(String, String)>, CliError> {
    if entries.len() > MAX_ENVS {
        return Err(CliError::Usage(format!(
            "at most {MAX_ENVS} --env entries (got {})",
            entries.len()
        )));
    }
    let mut envs = Vec::with_capacity(entries.len());
    for entry in entries {
        let Some((key, value)) = entry.split_once('=') else {
            return Err(CliError::Usage(format!(
                "--env must be KEY=VALUE (got {entry:?})"
            )));
        };
        if key.is_empty()
            || key.len() > 128
            || !key
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            return Err(CliError::Usage(format!("--env key {key:?} is not a name")));
        }
        envs.push((key.to_string(), value.to_string()));
    }
    Ok(envs)
}

/// The CLI's adjustable limits, bounded.
#[derive(Debug)]
pub(crate) struct Limits {
    pub per_check_secs: u64,
    pub total_cap_secs: u64,
    pub output_cap_bytes: u64,
}

/// Runtime options shared by the runner and the sandbox: what the checks see
/// and how long they may run. Nothing here is read from the artifact.
pub(crate) struct RunnerOptions {
    pub artifact_dir: String,
    /// The only environment the checks see inside the sandbox.
    pub envs: Vec<(String, String)>,
    pub per_check: Duration,
    pub total_cap: Duration,
    pub output_cap: usize,
}

pub(crate) fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default()
}

impl Limits {
    pub fn new(
        per_check_secs: u64,
        total_cap_secs: u64,
        output_cap_bytes: u64,
    ) -> Result<Self, CliError> {
        if !(MIN_CHECK_TIMEOUT_SECS..=MAX_CHECK_TIMEOUT_SECS).contains(&per_check_secs) {
            return Err(CliError::Usage(format!(
                "--timeout-secs must be {MIN_CHECK_TIMEOUT_SECS}..={MAX_CHECK_TIMEOUT_SECS} \
                 (got {per_check_secs})"
            )));
        }
        if !(MIN_TOTAL_CAP_SECS..=MAX_TOTAL_CAP_SECS).contains(&total_cap_secs) {
            return Err(CliError::Usage(format!(
                "--total-cap-secs must be {MIN_TOTAL_CAP_SECS}..={MAX_TOTAL_CAP_SECS} \
                 (got {total_cap_secs})"
            )));
        }
        if !(MIN_OUTPUT_CAP_BYTES..=MAX_OUTPUT_CAP_BYTES).contains(&output_cap_bytes) {
            return Err(CliError::Usage(format!(
                "--output-cap-bytes must be {MIN_OUTPUT_CAP_BYTES}..={MAX_OUTPUT_CAP_BYTES} \
                 (got {output_cap_bytes})"
            )));
        }
        Ok(Self {
            per_check_secs,
            total_cap_secs,
            output_cap_bytes,
        })
    }
}
