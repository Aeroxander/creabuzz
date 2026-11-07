//! `buzz launchpad work-checks` — one narrow evidence-preparation path: run a
//! claim's declared checks inside an enforcing local Docker sandbox and
//! publish the signed run record (kind:47010) reviewers read beside the
//! evidence.
//!
//! The bounded rules this path enforces are the product requirements:
//!
//! * **Argv, no shell** — each check is an argv array; the exact declared
//!   program becomes the container's entrypoint, and its arguments are never
//!   routed through a shell. A `command` string shape is refused at the seam.
//! * **Enforced sandbox, fail-closed** — the artifact runs inside a
//!   non-root container with the fixed enforced shape
//!   (`/lib/sandbox` docs live in sandbox.rs); the image must be locally
//!   available (no implicit pull), the artifact arrives as a bounded
//!   read-only snapshot, and `sandboxEnforced` is true only after the
//!   container's actual configuration is verified against the enforced
//!   shape. No daemon, no image, or a refused snapshot => the record carries
//!   `not-run` outcomes with the reason; the manual review path is intact
//!   and nothing ever executed on the host.
//! * **Bounded** — per-check timeout (default 60 s) and a total run cap;
//!   on timeout the container (the whole process namespace) is killed and
//!   removed under a bounded sequence, and the check is recorded as
//!   `timed-out`, never as a pass. Captured output is capped per stream and
//!   the record says when it was cut.
//! * **Min env** — the container's environment is the image's own defaults
//!   plus exactly the `--env KEY=VALUE` entries the operator requested;
//!   nothing of this process's environment is inherited, and credential keys
//!   are re-verified at read-back.
//! * **Never a silent success** — checks that exit non-zero or could not run
//!   stay `failed`/`not-run`; timeouts are `timed-out`; nothing is rewritten
//!   into "nothing missing".
//! * **Auxiliary is labelled** — a check that maps to no accepted criterion
//!   is recorded as auxiliary. The record carries the fixed
//!   `notIndependentVerification` sentence: the contributor's own execution
//!   records, never independent verification.
//! * Secrets: values of the operator-passed environment are matched exactly
//!   in captured output (and in declared argv) and redacted before signing,
//!   plus a small conservative token scan for common credential shapes. The
//!   optional `--summarize` ask of the server's AI service lands in the
//!   clearly separate `model` section as commentary — never authority, no
//!   confidence score, and the runner remains fully usable with the service
//!   off.

use std::time::Duration;

use buzz_core::kind::KIND_WORK_CHECK_RUN;
use nostr::{EventBuilder, Kind, Tag};
use serde_json::{json, Value};

use crate::client::BuzzClient;
use crate::commands::{launchpad_work::bytes32_arg, parse_write_response};
use crate::error::CliError;

pub(crate) mod checks;
pub(crate) mod record;
pub(crate) mod runner;
pub(crate) mod sandbox;
pub(crate) mod sandbox_ops;
pub(crate) mod sandbox_run;
pub(crate) mod snapshot;

#[cfg(test)]
mod tests;

#[cfg(test)]
#[path = "lifecycle_tests.rs"]
pub(crate) mod lifecycle_tests;

const AI_MAX_TOKENS: u32 = 1_024;
const AI_SUMMARY_MAX_BYTES: usize = 2_000;

fn word_of(value: &str, what: &str) -> Result<String, CliError> {
    let bytes = bytes32_arg(value, what)?;
    Ok(format!("0x{}", hex::encode(bytes)))
}

fn address_of(value: &str, what: &str) -> Result<String, CliError> {
    if value.len() != 42
        || !value.starts_with("0x")
        || value[2..].bytes().any(|b| !b.is_ascii_hexdigit())
    {
        return Err(CliError::Usage(format!(
            "{what} must be a 0x address (got {value:?})"
        )));
    }
    Ok(value.to_ascii_lowercase())
}

fn hash_word(value: &str, what: &str) -> Result<String, CliError> {
    if value.len() != 66 || !value.starts_with("0x") {
        return Err(CliError::Usage(format!(
            "{what} must be 0x + 64 hex (got {value:?})"
        )));
    }
    Ok(value.to_ascii_lowercase())
}

pub(super) struct WorkChecksArgs {
    pub launch: String,
    pub launch_author: Option<String>,
    pub claim: String,
    pub mandate: String,
    pub evidence_hash: String,
    pub check_text: Option<String>,
    pub check_hash: String,
    pub work_area_text: Option<String>,
    pub work_area_hash: Option<String>,
    /// The sandbox image, locally available; resolved to its immutable ID
    /// and run with `--pull never`. Required: an unnamed image means nothing
    /// can run, by design.
    pub sandbox_image: String,
    /// The operator-prepared trusted PID-1 deadline supervisor binary
    /// (scripts/check-supervisor.rs, built once offline; its paired manifest
    /// must sit beside it). Nothing runs under anything else.
    pub sandbox_supervisor: String,
    pub checks_file: String,
    pub dir: String,
    pub timeout_secs: u64,
    pub total_cap_secs: u64,
    pub output_cap_bytes: u64,
    pub envs: Vec<String>,
    pub summarize: bool,
    pub model: Option<String>,
    pub no_publish: bool,
}

/// The `buzz launchpad work-checks` body: bind, snapshot, run inside the
/// enforced sandbox, summarize (optional), sign, publish.
pub(super) async fn cmd_work_checks(
    args: &WorkChecksArgs,
    client: &BuzzClient,
) -> Result<(), CliError> {
    let claim = word_of(&args.claim, "claim id")?;
    let mandate = address_of(&args.mandate, "mandate")?;
    let evidence_hash = hash_word(&args.evidence_hash, "evidence hash")?;
    let check_hash = hash_word(&args.check_hash, "check hash")?;
    if args.work_area_text.is_some() != args.work_area_hash.is_some() {
        return Err(CliError::Usage(
            "--work-area-text and --work-area-hash go together: the words are bound to \
             the hash, or neither"
                .into(),
        ));
    }
    let limits = checks::Limits::new(
        args.timeout_secs,
        args.total_cap_secs,
        args.output_cap_bytes,
    )?;
    let declaration = checks::parse_checks(&read_file(&args.checks_file)?)?;
    let envs = checks::parse_envs(&args.envs)?;
    let bindings = record::bind_criteria(
        args.check_text.as_deref(),
        check_hash.clone(),
        args.work_area_text.as_deref(),
        args.work_area_hash.as_deref(),
    )?;
    // A declared mapping needs the run to actually bind those words.
    for spec in &declaration.checks {
        if let Some(source) = spec.criterion {
            let words = match source {
                checks::CriterionSource::ClaimCheck => "--check-text/--check-hash",
                checks::CriterionSource::WorkArea => "--work-area-text/--work-area-hash",
            };
            if !bindings.iter().any(|binding| binding.source == source) {
                return Err(CliError::Usage(format!(
                    "check {:?} maps to {:?}, but this run did not bind those words ({})",
                    spec.name,
                    source_to_word(source),
                    words
                )));
            }
        }
    }

    let coordinate =
        resolve_launch_coordinate(client, &args.launch, args.launch_author.as_deref()).await?;

    let artifact_dir_name = std::path::Path::new(&args.dir)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| args.dir.clone());
    let options = checks::RunnerOptions {
        artifact_dir: args.dir.clone(),
        envs: envs.clone(),
        per_check: Duration::from_secs(limits.per_check_secs),
        total_cap: Duration::from_secs(limits.total_cap_secs),
        output_cap: limits.output_cap_bytes as usize,
    };

    // Fail-closed sandbox preparation: any failure means NOTHING ran, and the
    // existing manual review path (reading the evidence yourself) is intact.
    // Cleanup is scoped to this feature's durable ownership journal: only a
    // finished container of this owner or of a verified-dead owner is
    // removed, and its report lands in the record's shared notes.
    let cleanup_notes = sandbox::cleanup_finished("docker", &sandbox::owner_key());
    let sandbox = sandbox::prepare(
        "docker",
        &args.sandbox_image,
        &args.dir,
        &args.sandbox_supervisor,
    );

    let (outcomes, telemetry) = runner::run_checks(&declaration, &options, &sandbox)?;

    let ready = match &sandbox {
        sandbox::PreparedSandbox::Ready(ready) => Some(&**ready),
        sandbox::PreparedSandbox::Unavailable(_) => None,
    };
    let mut sandbox_json = telemetry.sandbox_json(ready);
    let sandbox_word = sandbox_enforced_word(&sandbox_json);
    for note in telemetry.notes.iter().chain(cleanup_notes.iter()) {
        if let Some(obj) = sandbox_json.as_object_mut() {
            let mut notes = obj
                .get("notes")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            notes.push(Value::String(note.clone()));
            obj.insert("notes".into(), Value::Array(notes));
        }
    }

    let mut record = record::build_record(
        &claim,
        &mandate,
        &evidence_hash,
        &bindings,
        &declaration,
        &outcomes,
        limits.output_cap_bytes as usize,
        &envs,
        &artifact_dir_name,
        sandbox_json.clone(),
        None,
    );

    if args.summarize {
        // The ask carries the record's own cut excerpts, and only those. Its
        // answer becomes the clearly separated `model` section; the service
        // being off or declining leaves an honest limitation line and the
        // manual record intact.
        match model_interpretation(client, args.model.as_deref(), &record).await {
            Ok(Some(summary)) => {
                if let Some(obj) = record.as_object_mut() {
                    obj.insert("model".into(), summary);
                }
            }
            Ok(None) => {}
            Err(note) => push_limitation(&mut record, note),
        }
    }

    // The ONE indexed context tag the reader queries by: `<lowercase
    // mandate>:<lowercase claim id>:<lowercase evidence hash>`, `0x` prefixes
    // kept. The relay pushes this single value into SQL before LIMIT for a
    // kind-47010-only filter, so a claim's own records cannot be starved off
    // the page by newer unrelated runs. The longer `claim`/`evidence`/`mandate`
    // tags stay for display and for readers that parse them.
    let context_tag = format!(
        "{}:{}:{}",
        mandate.as_str().to_lowercase(),
        claim.as_str().to_lowercase(),
        evidence_hash.as_str().to_lowercase(),
    );
    let tags = vec![
        Tag::parse(["a", coordinate.as_str()])
            .map_err(|e| CliError::Other(format!("bad a tag: {e}")))?,
        Tag::parse(["c", context_tag.as_str()])
            .map_err(|e| CliError::Other(format!("bad c tag: {e}")))?,
        Tag::parse(["claim", claim.as_str()])
            .map_err(|e| CliError::Other(format!("bad claim tag: {e}")))?,
        Tag::parse(["evidence", evidence_hash.as_str()])
            .map_err(|e| CliError::Other(format!("bad evidence tag: {e}")))?,
        Tag::parse(["mandate", mandate.as_str()])
            .map_err(|e| CliError::Other(format!("bad mandate tag: {e}")))?,
        Tag::parse(["sandbox", sandbox_word])
            .map_err(|e| CliError::Other(format!("bad sandbox tag: {e}")))?,
    ];
    let builder =
        EventBuilder::new(Kind::Custom(KIND_WORK_CHECK_RUN as u16), record.to_string()).tags(tags);
    let event = client.sign_event(builder)?;

    let event_json = event_to_json(&event);
    let mut response = json!({
        "recordId": event.id.to_hex(),
        "signedEvent": event_json,
        "checks": record.get("checks").cloned().unwrap_or(Value::Array(vec![])),
        "summary": record.get("summary").cloned().unwrap_or(json!({})),
        "sandboxEnforced": sandbox_word == "enforced",
        "published": false,
    });
    if args.no_publish {
        response["note"] = json!(
            "Signed but not published (you passed --no-publish). Re-run without \
             --no-publish to put the record beside the claim."
        );
        println!("{}", response);
        return Ok(());
    }
    let raw = client.submit_event(event).await?;
    parse_write_response(
        &raw,
        "the check-run record was superseded; re-run to republish",
    )?;
    response["published"] = json!(true);
    println!("{}", response);
    Ok(())
}

fn sandbox_enforced_word(sandbox_json: &Value) -> &'static str {
    if sandbox_json.get("enforced").and_then(Value::as_bool) == Some(true) {
        "enforced"
    } else {
        "unchecked"
    }
}

fn source_to_word(source: checks::CriterionSource) -> &'static str {
    match source {
        checks::CriterionSource::ClaimCheck => "claim-check",
        checks::CriterionSource::WorkArea => "work-area",
    }
}

/// The seven canonical signed fields, in JSON a reader can paste elsewhere.
fn event_to_json(event: &nostr::Event) -> Value {
    json!({
        "id": event.id.to_hex(),
        "pubkey": event.pubkey.to_hex(),
        "kind": event.kind.as_u16() as u32,
        "created_at": event.created_at.as_secs(),
        "tags": event
            .tags
            .iter()
            .map(|t| t.as_slice().iter().map(|s| s.to_string()).collect::<Vec<_>>())
            .collect::<Vec<_>>(),
        "content": event.content.as_str(),
        "sig": event.sig.to_string(),
    })
}

/// The launch coordinate: `--launch-author` when given, otherwise resolved
/// from the directory — one signer must own the launch (a bounded read).
pub(crate) async fn resolve_launch_coordinate(
    client: &BuzzClient,
    launch: &str,
    author: Option<&str>,
) -> Result<String, CliError> {
    if launch.is_empty() || launch.len() > 64 {
        return Err(CliError::Usage(
            "--launch must be the launch id (a slug of at most 64 characters)".into(),
        ));
    }
    if let Some(author) = author {
        if author.len() != 64 || !author.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(CliError::Usage(
                "--launch-author must be the founder's pubkey (64 hex characters)".into(),
            ));
        }
        return Ok(format!("37001:{author}:{launch}"));
    }
    let filter = json!({ "kinds": [37001], "#d": [launch], "limit": 50 });
    let raw = client.query(&filter).await?;
    let events: Vec<Value> = serde_json::from_str(&raw)
        .map_err(|e| CliError::Other(format!("server response is not an event list: {e}")))?;
    let mut authors: Vec<String> = events
        .iter()
        .filter_map(|event| {
            let pubkey = event.get("pubkey").and_then(Value::as_str)?;
            let named = event
                .get("tags")
                .and_then(Value::as_array)
                .map(|tags| {
                    tags.iter()
                        .any(|tag| tag.get(0).and_then(Value::as_str) == Some("d"))
                })
                .unwrap_or(false);
            named.then(|| pubkey.to_string())
        })
        .collect();
    authors.sort();
    authors.dedup();
    match authors.as_slice() {
        [only] => Ok(format!("37001:{only}:{launch}")),
        [] => Err(CliError::NotFound(format!(
            "no launch named {launch:?} exists on the configured server; the record would \
             be published beside the launch, so give --launch-author once the launch \
             exists"
        ))),
        _ => Err(CliError::Usage(format!(
            "launch {launch:?} is claimed by several authors ({}); give --launch-author",
            authors.len()
        ))),
    }
}

/// The optional AI interpretation: the record's cut output only, via the
/// server's `/llm/chat/completions` gateway (the same shape the web helpers
/// use). Err carries a plain sentence for the record's limitations; the run
/// itself never fails because the AI did, and the AI decides nothing.
pub(crate) async fn model_interpretation(
    client: &BuzzClient,
    model_name: Option<&str>,
    record: &Value,
) -> Result<Option<Value>, String> {
    let brief: Vec<Value> = record
        .get("checks")
        .and_then(Value::as_array)
        .map(|checks| {
            checks
                .iter()
                .map(|check| {
                    json!({
                        "name": check.get("name"),
                        "status": check.get("status"),
                        "exitStatus": check.get("exitStatus"),
                        "stdout": check.get("stdout"),
                        "stderr": check.get("stderr"),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let system = [
        "You summarise recorded check output for a reviewer, in plain words.",
        "Work only from what you are given: you add no facts, judge no one, and decide nothing.",
        "Say what the executed checks show and what they cannot show.",
        "At most eight sentences, and never a confidence number or score.",
    ]
    .join("\n");
    let user = format!(
        "A contributor's own check run. The criteria it was run against: {}. The \
         executed results: {}",
        record
            .get("criteria")
            .map(|c| c.to_string())
            .unwrap_or_default(),
        serde_json::to_string(&brief).unwrap_or_else(|_| "[]".into()),
    );
    let mut body = json!({
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user },
        ],
        "max_tokens": AI_MAX_TOKENS,
    });
    if let Some(name) = model_name {
        body["model"] = json!(name);
    }
    let body_bytes = serde_json::to_vec(&body)
        .map_err(|e| format!("the summary request could not be built: {e}"))?;
    let url = format!("{}/llm/chat/completions", client.relay_url());
    let raw = client.ask_llm(&url, body_bytes).await.map_err(|e| {
        format!(
            "The AI service did not answer ({e}): the record went out without a model \
             interpretation; only the reviewer's own reading remains."
        )
    })?;
    let parsed: Value = serde_json::from_str(&raw).map_err(|e| {
        format!(
            "The AI service's answer could not be read ({e}): the record went out without \
             a model interpretation."
        )
    })?;
    let summary = parsed
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if summary.is_empty() {
        return Err(
            "The AI service sent back nothing: the record went out without a \
                    model interpretation."
                .into(),
        );
    }
    let summary_bounded = checks::bounded(summary, AI_SUMMARY_MAX_BYTES, "the model's summary")
        .map_err(|e| {
            format!(
                "The AI service's answer was unusable ({e}); the record went out \
                     without a model interpretation."
            )
        })?;
    Ok(Some(json!({
        "service": "this server's AI service",
        "summary": summary_bounded,
        "disclosure": "Written by a model from the executed results' cut excerpts alone, \
    sent to this server's AI service (the one its operator configured). It is commentary: it \
    decides nothing, it is not verification, and a model's confidence is not authority.",
        "generatedAt": checks::now_secs(),
    })))
}

fn push_limitation(record: &mut Value, note: String) {
    if let Some(obj) = record.as_object_mut() {
        let mut limitations = obj
            .get("limitations")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        limitations.push(Value::String(note));
        obj.insert("limitations".into(), Value::Array(limitations));
    }
}

fn read_file(path: &str) -> Result<String, CliError> {
    let meta =
        std::fs::metadata(path).map_err(|e| CliError::Usage(format!("cannot read {path}: {e}")))?;
    if meta.len() > checks::CHECKS_FILE_MAX_BYTES {
        return Err(CliError::Usage(format!(
            "{path} is too large (max {} bytes)",
            checks::CHECKS_FILE_MAX_BYTES
        )));
    }
    std::fs::read_to_string(path).map_err(|e| CliError::Usage(format!("cannot read {path}: {e}")))
}
