//! `buzz agwiki` — the Agent Wiki (kind:44002) distillation loop + read paths.
//!
//! This is a NEW feature, distinct from the human Buzz wiki (kind:44001,
//! Yjs/Trystero live editing): an agent-maintained knowledge base. One page
//! per space is the executive standup (`<space>/standup`), rewritten to the
//! current truth by each distill run from the last cursor's source window.
//!
//! The distill loop itself (prompt + strict validation + front-matter +
//! cursor rules) lives in the shared `buzz-agwiki` crate — the same core the
//! relay's `distill_agent_wiki` workflow action runs so the wiki can also
//! maintain itself on a schedule. This module is the CLI host: `BuzzClient`
//! reads/publishes and stdout/stderr formatting.
//!
//! Distill loop: fetch done kind:44011 tasks + published kind:37013
//! contribution records newer than the cursor (bounded), call the LLM endpoint
//! with a distill prompt whose success criterion is Paperclip's
//! ('wiki-insightful, not procedural'), validate the markdown strictly, and
//! either print the draft or, with `--publish`, sign + publish it as a
//! kind:44002 page with provenance tags (`model`, `cost_tokens`, `sources`).
//!
//! Configuration reuses the contribution-classifier env vars (no new config
//! surface): `BUZZ_CLASSIFIER_API_URL` and `BUZZ_CLASSIFIER_API_KEY` are
//! required, `BUZZ_CLASSIFIER_MODEL` defaults to the shared classifier
//! default (`DEFAULT_CLASSIFIER_MODEL` in `buzz_agwiki::llm`). Missing key or URL is a hard usage error —
//! there is no silent local fallback and no offline model (fail-closed).
//!
//! Cursor: persisted in the standup page's YAML front-matter
//! (`agwiki-cursor: <unix>`), written deterministically at publish. The next
//! run parses the cursor from the existing page and fetches only events
//! strictly newer than it. A run with nothing new never calls the LLM. When
//! the fetch bound truncates a source window (more fresh sources than
//! `limit` per kind), the cursor only advances to the oldest included
//! source, so the window is re-crawled next run instead of silently dropping
//! sources — bounded, never lossy.

use buzz_agwiki::llm::{chat_completion, LlmError, LlmTarget};
use buzz_agwiki::run::{DistillError, DistillOptions, DistillOutcome, DistillPorts};
use nostr::{Event, EventBuilder};

use crate::client::BuzzClient;
use crate::commands::org_classify::{classifier_config_from_env, ClassifierConfig};
use crate::commands::parse_write_response;
use crate::error::CliError;

pub use buzz_agwiki::{
    extract_page_body, tag_values, validate_page_coordinate, AGWIKI_DEFAULT_LIMIT, AGWIKI_HARD_CAP,
    AGWIKI_PAGE_QUERY_BOUND, KIND_AGENT_WIKI, STANDUP_SLUG,
};

/// CLI ports onto [`DistillPorts`] — `BuzzClient` reads/publishes and the
/// shared classifier LLM transport.
struct CliDistillPorts<'a> {
    client: &'a BuzzClient,
    target: LlmTarget,
}

impl DistillPorts for CliDistillPorts<'_> {
    type Error = CliError;

    fn fetch_kind_events(
        &self,
        kind: u32,
        since: u64,
        bound: u32,
    ) -> buzz_agwiki::run::PortFut<'_, Vec<Event>, Self::Error> {
        let filter = if since > 0 {
            serde_json::json!({ "kinds": [kind], "since": since })
        } else {
            serde_json::json!({ "kinds": [kind] })
        };
        Box::pin(async move {
            let events = self
                .client
                .query_all_bounded(filter, bound)
                .await?
                .into_iter()
                .filter_map(|v| serde_json::from_value(v).ok())
                .collect();
            Ok(events)
        })
    }

    fn fetch_existing_page(
        &self,
        coordinate: &str,
    ) -> buzz_agwiki::run::PortFut<'_, Option<(String, u64)>, Self::Error> {
        let coordinate = coordinate.to_string();
        Box::pin(async move {
            let filter = serde_json::json!({ "kinds": [KIND_AGENT_WIKI] });
            let events: Vec<Event> = self
                .client
                .query_pages_bounded(filter, AGWIKI_PAGE_QUERY_BOUND)
                .await?
                .into_iter()
                .filter_map(|v| serde_json::from_value(v).ok())
                .collect();
            Ok(buzz_agwiki::newest_page(&events, &coordinate))
        })
    }

    fn search(
        &self,
        query: &str,
        kinds: &[u32],
        limit: u32,
    ) -> buzz_agwiki::run::PortFut<'_, Vec<serde_json::Value>, Self::Error> {
        let query = query.to_string();
        let kinds = kinds.to_vec();
        Box::pin(async move {
            let filter = serde_json::json!({ "kinds": kinds, "search": query, "limit": limit });
            let resp = self.client.query(&filter).await?;
            let events: Vec<serde_json::Value> = serde_json::from_str(&resp).unwrap_or_default();
            Ok(events)
        })
    }

    fn chat(
        &self,
        http: &reqwest::Client,
        system: &str,
        user: &str,
        max_tokens: u32,
    ) -> buzz_agwiki::run::PortFut<'_, serde_json::Value, Self::Error> {
        // Capture owned copies (the reqwest client is Arc-backed) so the
        // boxed future is bound only by `&self`, matching the trait.
        let http = http.clone();
        let target = self.target.clone();
        let system = system.to_owned();
        let user = user.to_owned();
        Box::pin(async move {
            chat_completion(&http, &target, &system, &user, max_tokens)
                .await
                .map_err(|e| match e {
                    LlmError::Http(err) => CliError::Network(err),
                    LlmError::Message(m) => CliError::Other(m),
                })
        })
    }

    fn publish(&self, builder: EventBuilder) -> buzz_agwiki::run::PortFut<'_, String, Self::Error> {
        Box::pin(async move {
            let event = self.client.sign_event(builder)?;
            let response = self.client.submit_event(event).await?;
            parse_write_response(&response, "standup page write raced a newer page")
        })
    }

    fn llm_model(&self) -> &str {
        &self.target.model
    }
}

/// Map the core's error shape onto CLI errors without losing error codes
/// (port errors pass through verbatim).
fn map_distill_error(e: DistillError<CliError>) -> CliError {
    match e {
        DistillError::Failed(m) => CliError::Other(m),
        DistillError::Port(e) => e,
    }
}

/// One round trip through the distill pipeline (injectable config for tests).
///
/// Fetch bundle → (skip when nothing new) → prompt → LLM → validate (retry
/// once) → compose page with the new cursor → preview or publish. Publishing
/// advances the durable cursor because the new page's front-matter records
/// it; a preview run never advances it.
pub async fn run_distill_inner(
    client: &BuzzClient,
    cfg: &ClassifierConfig,
    space: &str,
    limit: Option<u32>,
    publish: bool,
    skill_file: Option<&str>,
) -> Result<Option<String>, CliError> {
    let space = space.trim().to_lowercase();
    validate_page_coordinate(&format!("{space}/{STANDUP_SLUG}")).map_err(CliError::Other)?;

    let raw_limit = limit.unwrap_or(AGWIKI_DEFAULT_LIMIT);
    let cap = raw_limit.min(AGWIKI_HARD_CAP);
    if raw_limit > AGWIKI_HARD_CAP {
        eprintln!(
            "note: --limit {raw_limit} exceeds the hard cap of {AGWIKI_HARD_CAP}; using {cap}"
        );
    }

    let ports = CliDistillPorts {
        client,
        target: LlmTarget {
            api_url: cfg.api_url.clone(),
            api_key: cfg.api_key.clone(),
            model: cfg.model.clone(),
        },
    };
    // Optional trainable skill (a SkillOpt `best_skill.md`) — loaded instead
    // of the built-in system prompt; provenance is the caller's.
    let skill_override = match skill_file {
        Some(path) => Some(
            std::fs::read_to_string(path)
                .map_err(|e| CliError::Other(format!("read {path}: {e}")))?,
        ),
        None => None,
    };
    let outcome = buzz_agwiki::run::run_distill(
        &ports,
        &DistillOptions {
            space: &space,
            limit,
            publish,
            system_prompt: skill_override.as_deref(),
        },
        &|msg| eprintln!("{msg}"),
    )
    .await
    .map_err(map_distill_error)?;

    match outcome {
        DistillOutcome::Skipped { since, .. } => {
            println!(
                "no new done tasks or contribution records since cursor {since}; nothing to distill"
            );
            Ok(None)
        }
        DistillOutcome::Preview { report, page } => {
            println!("{page}");
            println!(
                "preview only (cost ~{} tokens); pass --publish to save the standup page (d={})",
                report.cost_tokens, report.coordinate
            );
            Ok(None)
        }
        DistillOutcome::Published { write_result, .. } => {
            println!("{write_result}");
            Ok(Some(write_result))
        }
    }
}

/// `buzz agwiki distill --space default [--limit 5] [--publish]`
pub async fn cmd_distill(
    client: &BuzzClient,
    space: &str,
    limit: Option<u32>,
    publish: bool,
    skill_file: Option<&str>,
) -> Result<(), CliError> {
    // Fail closed before any network call: no key/URL, no draft.
    let cfg = classifier_config_from_env()?;
    run_distill_inner(client, &cfg, space, limit, publish, skill_file)
        .await
        .map(|_| ())
}

/// `buzz agwiki show <coordinate>`
pub async fn cmd_show(client: &BuzzClient, coordinate: &str) -> Result<(), CliError> {
    validate_page_coordinate(coordinate).map_err(CliError::Other)?;
    let Some((content, _)) = fetch_newest_page(client, coordinate).await? else {
        return Err(CliError::NotFound(format!(
            "agent wiki page '{coordinate}' not found on the relay"
        )));
    };
    let body = extract_page_body(&content)
        .map_err(|e| CliError::Other(format!("stored page is corrupt: {e}")))?;
    println!("{body}");
    Ok(())
}

/// `buzz agwiki list [--space <space>] [--limit N]`
pub async fn cmd_list(
    client: &BuzzClient,
    space: Option<&str>,
    limit: Option<u32>,
) -> Result<(), CliError> {
    let space_prefix = space.map(|s| {
        let s = s.trim().to_lowercase();
        format!("{s}/")
    });
    if let Some(ref prefix) = space_prefix {
        validate_page_coordinate(prefix.trim_end_matches('/')).map_err(CliError::Other)?;
    }
    let raw_limit = limit.unwrap_or(200).min(AGWIKI_PAGE_QUERY_BOUND);
    let filter = serde_json::json!({ "kinds": [KIND_AGENT_WIKI] });
    let events: Vec<Event> = client
        .query_pages_bounded(filter, raw_limit)
        .await?
        .into_iter()
        .filter_map(|v| serde_json::from_value(v).ok())
        .collect();

    // Newest revision per coordinate (read-side LWW across authors).
    let mut newest: Vec<(String, u64, String)> = Vec::new(); // (d, created, model)
    let mut index = std::collections::HashMap::<String, usize>::new();
    for event in events {
        let Some(d) = tag_values(&event, "d").into_iter().next() else {
            continue;
        };
        if d.is_empty() {
            continue;
        }
        if let Some(ref prefix) = space_prefix {
            if !d.starts_with(prefix.as_str()) {
                continue;
            }
        }
        let created = event.created_at.as_secs();
        let model = tag_values(&event, "model")
            .into_iter()
            .next()
            .unwrap_or_default();
        match index.get(&d) {
            Some(&i) if created > newest[i].1 => {
                newest[i] = (d.clone(), created, model);
            }
            Some(_) => {}
            None => {
                index.insert(d.clone(), newest.len());
                newest.push((d, created, model));
            }
        }
    }
    newest.sort_by_key(|b| std::cmp::Reverse(b.1));
    for (d, created, model) in &newest {
        if model.is_empty() {
            println!("{d}\t{created}");
        } else {
            println!("{d}\t{created}\t{model}");
        }
    }
    Ok(())
}

/// `buzz agwiki train-skill` — SkillOpt training for the distill skill
/// (docs/skillopt-port.md). The trainable text is the distill system prompt;
/// rollouts generate pages from the fixture corpus; our validators are the
/// held-out metric. Reduced-epoch by flag for cost control — the paper's
/// default is 4 epochs.
pub async fn cmd_train_skill(
    _client: &BuzzClient,
    data: Option<&str>,
    epochs: Option<usize>,
    out: Option<&str>,
    reasoning_effort: Option<&str>,
    optimizer_effort: Option<&str>,
    target_effort: Option<&str>,
) -> Result<(), CliError> {
    use buzz_agwiki::llm::classifier_target_from_provider;
    use buzz_agwiki::skill_train::{
        load_expectations, load_split, DistillScorer, DistillTarget, LlmOptimizer,
    };
    use buzz_agwiki::build_system_prompt;
    use buzz_skillopt::train::{train, TrainConfig};

    let root = std::path::PathBuf::from(
        data.unwrap_or("crates/buzz-agwiki/data/distill-skill"),
    );
    let train_set = load_split(&root.join("train")).map_err(CliError::Other)?;
    let sel_split = load_split(&root.join("sel")).map_err(CliError::Other)?;
    let test_split = load_split(&root.join("test")).map_err(CliError::Other)?;

    let target_config = classifier_target_from_provider(|name| {
        std::env::var(name).ok().filter(|v| !v.is_empty())
    })
    .map_err(|e| CliError::Other(format!("classifier target: {e}")))?;
    let init_skill = buzz_skillopt::SkillDoc::new(build_system_prompt());

    let config = TrainConfig {
        num_epochs: epochs.unwrap_or(1).max(1),
        ..TrainConfig::default()
    };
    println!(
        "training the distill skill: {} train / {} sel / {} test fixtures, {} epoch(s), optimizer+target = {}",
        train_set.len(),
        sel_split.len(),
        test_split.len(),
        config.num_epochs,
        target_config.model
    );

    let shared_effort = reasoning_effort.unwrap_or("medium");
    let optimizer_effort = optimizer_effort.unwrap_or(shared_effort);
    let target_effort = target_effort.unwrap_or(shared_effort);
    let mut optimizer = LlmOptimizer {
        target: target_config.clone(),
        reasoning_effort: optimizer_effort.to_string(),
    };
    let mut rollout_target = DistillTarget {
        target: target_config,
        reasoning_effort: target_effort.to_string(),
    };
    let mut scorer = DistillScorer::new();
    scorer.expectations =
        load_expectations(&root).map_err(CliError::Other)?;

    // The training loop's ports are sync by design (docs/skillopt-port.md);
    // drive them from the blocking pool so the LLM adapter's per-call runtime
    // never starts inside the async dispatch ("Cannot start a runtime from
    // within a runtime").
    let result = tokio::task::spawn_blocking(move || {
        train(
            &config,
            init_skill,
            &train_set,
            &sel_split,
            &test_split,
            &mut optimizer,
            &mut rollout_target,
            &mut scorer,
        )
    })
    .await
    .map_err(|e| CliError::Other(format!("training join: {e}")))?
    .map_err(CliError::Other)?;

    for record in &result.history {
        println!(
            "epoch {} step {}: L={} proposed={} selected={} applied={} {} score={:.3}",
            record.epoch,
            record.step,
            record.learning_rate,
            record.proposed,
            record.selected,
            record.applied,
            if record.accepted { "ACCEPTED" } else { "rejected" },
            record.score
        );
    }
    println!(
        "best selection score {:.3}{}",
        result.best_selection_score,
        result
            .test_score
            .map(|s| format!(", test score {s:.3}"))
            .unwrap_or_default()
    );
    if !result.buffer.is_empty() {
        println!("== the rejected-edit buffer (do-not-repeat material for the next run)");
        let mut buffer = buzz_skillopt::RejectedBuffer::default();
        for entry in &result.buffer {
            buffer.record(entry.clone());
        }
        println!("{}", buffer.prompt_note());
    }
    let path = out.unwrap_or("best_skill.md");
    std::fs::write(path, result.best_skill.as_str())
        .map_err(|e| CliError::Other(format!("write {path}: {e}")))?;
    println!("best skill written to {path}");
    Ok(())
}

/// Fetch the newest published page for a coordinate (any author), via a
/// bounded newest-first read + the shared read-side-LWW fold.
async fn fetch_newest_page(
    client: &BuzzClient,
    coordinate: &str,
) -> Result<Option<(String, u64)>, CliError> {
    let filter = serde_json::json!({ "kinds": [KIND_AGENT_WIKI] });
    let events: Vec<Event> = client
        .query_pages_bounded(filter, AGWIKI_PAGE_QUERY_BOUND)
        .await?
        .into_iter()
        .filter_map(|v| serde_json::from_value(v).ok())
        .collect();
    Ok(buzz_agwiki::newest_page(&events, coordinate))
}

/// `buzz agwiki draft --launch <37001:…> [--space S | --page S/slug]
/// [--publish]` — the persona drafting loop's CLI host
/// (docs/persona-drafting-loop.md).
///
/// Scans the human wiki (44001) and agent wiki (44002) for fenced `decision`
/// blocks and composes one kind:47004 `agent-draft` record per honest block:
/// verbatim evidence strictly enforced (D3), malformed blocks skipped and
/// reported, never repaired (D4). Deterministic — no LLM in this step.
/// Dry-run by default; `--publish` signs and lands each draft (they are
/// `governance.proposal` actions at the S3 budget gate). Dedupe by the `wiki`
/// anchor tag (D7): re-runs on unchanged pages draft nothing new.
pub async fn cmd_draft(
    client: &BuzzClient,
    launch: &str,
    space: Option<&str>,
    page: Option<&str>,
    limit: Option<u32>,
    publish: bool,
) -> Result<(), CliError> {
    use buzz_agwiki::draft::{
        build_proposal_draft_builder, decision_drafts, existing_anchors,
        validate_launch_coordinate,
    };
    use buzz_core::kind::{KIND_LAUNCH_PROPOSAL, KIND_WIKI_PAGE};

    if space.is_some() && page.is_some() {
        return Err(CliError::Usage(
            "--space and --page are mutually exclusive".to_string(),
        ));
    }
    validate_launch_coordinate(launch).map_err(CliError::Other)?;
    if let Some(p) = page {
        if p.trim().is_empty() {
            return Err(CliError::Usage("--page must not be empty".to_string()));
        }
    }
    let space_prefix = space.map(|s| format!("{}/", s.trim().to_lowercase()));
    let bound = limit.unwrap_or(200).min(AGWIKI_PAGE_QUERY_BOUND);

    // Newest revision per (kind, author, d) — read-side LWW — over BOTH wiki
    // kinds; the fold keeps full coordinates so 44001 and 44002 pages with
    // the same d never collide (the `wiki` tag points at the full coordinate).
    let filter = serde_json::json!({ "kinds": [KIND_WIKI_PAGE, KIND_AGENT_WIKI] });
    let events: Vec<Event> = client
        .query_pages_bounded(filter, bound)
        .await?
        .into_iter()
        .filter_map(|v| serde_json::from_value(v).ok())
        .collect();
    let mut newest: std::collections::BTreeMap<String, (u64, String)> = std::collections::BTreeMap::new();
    for event in events {
        let Some(d) = tag_values(&event, "d").into_iter().next() else {
            continue;
        };
        if d.is_empty() {
            continue;
        }
        if let Some(ref prefix) = space_prefix {
            if !d.starts_with(prefix.as_str()) {
                continue;
            }
        }
        if let Some(p) = page {
            if d != p {
                continue;
            }
        }
        let kind = event.kind.as_u16();
        if kind != KIND_WIKI_PAGE as u16 && kind != KIND_AGENT_WIKI as u16 {
            continue;
        }
        let coordinate = format!("{kind}:{}:{d}", event.pubkey.to_hex());
        let created = event.created_at.as_secs();
        match newest.get(&coordinate) {
            Some((prev, _)) if *prev >= created => {}
            _ => {
                newest.insert(coordinate, (created, event.content.clone()));
            }
        }
    }

    // D7 dedupe: live (non-tombstoned filtering is the model layer's job —
    // here any recorded anchor blocks a re-draft) 47004 wiki anchors.
    let existing_filter = serde_json::json!({ "kinds": [KIND_LAUNCH_PROPOSAL], "#a": [launch] });
    let existing: Vec<Event> = client
        .query_all_bounded(existing_filter, 512)
        .await?
        .into_iter()
        .filter_map(|v| serde_json::from_value(v).ok())
        .collect();
    let anchors = existing_anchors(&existing);

    let mut drafted = 0usize;
    let mut skipped = 0usize;
    let mut dupes = 0usize;
    for (coordinate, (_, content)) in &newest {
        let body = match extract_page_body(content) {
            Ok(body) => body,
            Err(e) => {
                println!("skipped {coordinate}: corrupt page ({e})");
                skipped += 1;
                continue;
            }
        };
        let out = decision_drafts(body);
        for skip in &out.skipped {
            println!("skipped {coordinate}#{}: {}", skip.anchor, skip.reason);
            skipped += 1;
        }
        for draft in &out.drafts {
            if anchors.contains(&(coordinate.clone(), draft.anchor)) {
                println!(
                    "already drafted {coordinate}#{}: {}",
                    draft.anchor, draft.title
                );
                dupes += 1;
                continue;
            }
            let builder =
                build_proposal_draft_builder(launch, coordinate, draft).map_err(CliError::Other)?;
            if publish {
                let event = client.sign_event(builder)?;
                let response = client.submit_event(event).await?;
                let result =
                    parse_write_response(&response, "draft write raced a newer record")?;
                println!("landed {coordinate}#{}: {} ({result})", draft.anchor, draft.title);
            } else {
                println!("{coordinate}#{}\t{}\t{}", draft.anchor, draft.title, draft.kind);
                println!("{}", draft.content);
            }
            drafted += 1;
        }
    }
    if publish {
        println!("landed {drafted} draft(s); skipped {skipped}, already drafted {dupes}");
    } else {
        println!(
            "{drafted} draft(s) ready; skipped {skipped}, already drafted {dupes}; \
             pass --publish to land them as 47004 agent-drafts"
        );
    }
    Ok(())
}

/// Route an `agwiki` invocation.
pub async fn dispatch(cmd: crate::AgwikiCmd, client: &BuzzClient) -> Result<(), CliError> {
    use crate::AgwikiCmd;
    match cmd {
        AgwikiCmd::Distill {
            space,
            limit,
            publish,
            skill_file,
        } => cmd_distill(client, &space, limit, publish, skill_file.as_deref()).await,
        AgwikiCmd::Show { page } => cmd_show(client, &page).await,
        AgwikiCmd::List { space, limit } => cmd_list(client, space.as_deref(), limit).await,
        AgwikiCmd::Draft {
            launch,
            space,
            page,
            limit,
            publish,
        } => {
            cmd_draft(
                client,
                &launch,
                space.as_deref(),
                page.as_deref(),
                limit,
                publish,
            )
            .await
        }
        AgwikiCmd::TrainSkill {
            data,
            epochs,
            out,
            reasoning_effort,
            optimizer_effort,
            target_effort,
        } => {
            cmd_train_skill(
                client,
                data.as_deref(),
                epochs,
                out.as_deref(),
                reasoning_effort.as_deref(),
                optimizer_effort.as_deref(),
                target_effort.as_deref(),
            )
            .await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_agwiki::{
        parse_cursor_from_page, FRONT_MATTER_CURSOR_KEY, KIND_AGENT_WIKI as KIND_WIKI,
    };
    use buzz_core::kind::{KIND_AGENT_TASK, KIND_CONTRIBUTION_RECORD};
    use nostr::{EventBuilder, Keys, Kind, Tag};

    // ── Fixtures ───────────────────────────────────────────────────────────

    fn done_task_fixture(title: &str, ts: u64) -> Event {
        let content = serde_json::json!({
            "title": title,
            "description": "Completed work item with a real description",
            "status": "done",
            "priority": "normal",
        });
        let mut builder =
            EventBuilder::new(Kind::Custom(KIND_AGENT_TASK as u16), content.to_string());
        builder = builder.custom_created_at(nostr::Timestamp::from(ts));
        builder.sign_with_keys(&Keys::generate()).expect("signs")
    }

    fn contribution_fixture(action: &str, ts: u64) -> Event {
        let content = serde_json::json!({
            "v": 1,
            "action": action,
            "dimensions": { "build": 0.8, "coordinate": 0.2 },
            "humanVsAi": { "human": 0.7, "ai": 0.3 },
            "reviewStatus": "accepted",
        });
        EventBuilder::new(
            Kind::Custom(KIND_CONTRIBUTION_RECORD as u16),
            content.to_string(),
        )
        .custom_created_at(nostr::Timestamp::from(ts))
        .sign_with_keys(&Keys::generate())
        .expect("signs")
    }

    /// A previously published standup page with a cursor in front-matter.
    fn standup_page_fixture(cursor: u64, body: &str) -> Event {
        let page = format!(
            "---\nslug: default/standup\n{FRONT_MATTER_CURSOR_KEY}: {cursor}\nmodel: old-model\ngenerated-at: 1\n---\n{body}"
        );
        EventBuilder::new(Kind::Custom(KIND_WIKI as u16), page)
            .tags(vec![Tag::parse(["d", "default/standup"]).expect("tag")])
            .custom_created_at(nostr::Timestamp::from(cursor + 1))
            .sign_with_keys(&Keys::generate())
            .expect("signs")
    }

    fn chat_response(content: &str, total_tokens: Option<u64>) -> serde_json::Value {
        let mut value = serde_json::json!({
            "choices": [{ "index": 0, "message": { "role": "assistant", "content": content } }]
        });
        if let Some(t) = total_tokens {
            value["usage"] = serde_json::json!({ "total_tokens": t });
        }
        value
    }

    /// A reflection decision that stops the loop before any search runs.
    fn reflection_sufficient() -> serde_json::Value {
        chat_response(
            r#"{"sufficient": true, "queries": [], "reason": "bundle is enough"}"#,
            Some(50),
        )
    }

    fn markdown_draft() -> String {
        "# What the org is doing\n\nThe payments team shipped the retry-loop refactor.\n"
            .to_string()
    }

    fn dirty_draft() -> String {
        "# Not valid\n\n```json\n{\"llm\":\"leaked bundle\"}\n```\n".to_string()
    }

    // ── Mock TCP relay + chat endpoint (same seam as org_classify) ────────

    #[derive(Default)]
    struct MockState {
        chat_calls: std::sync::Mutex<Vec<serde_json::Value>>,
        chat_responses:
            std::sync::Mutex<std::collections::VecDeque<Result<serde_json::Value, u16>>>,
        event_posts: std::sync::Mutex<Vec<serde_json::Value>>,
        task_query_response: std::sync::Mutex<Vec<serde_json::Value>>,
        record_query_response: std::sync::Mutex<Vec<serde_json::Value>>,
        page_query_response: std::sync::Mutex<Vec<serde_json::Value>>,
        search_query_response: std::sync::Mutex<Vec<serde_json::Value>>,
    }

    impl MockState {
        fn with_sources(tasks: &[&Event], records: &[&Event]) -> Self {
            let state = Self::default();
            *state.task_query_response.lock().unwrap() = tasks
                .iter()
                .map(|e| serde_json::to_value(e).unwrap())
                .collect();
            *state.record_query_response.lock().unwrap() = records
                .iter()
                .map(|e| serde_json::to_value(e).unwrap())
                .collect();
            state
        }

        fn with_pages(&self, pages: &[&Event]) {
            *self.page_query_response.lock().unwrap() = pages
                .iter()
                .map(|e| serde_json::to_value(e).unwrap())
                .collect();
        }

        fn push_chat(&self, response: Result<serde_json::Value, u16>) {
            self.chat_responses.lock().unwrap().push_back(response);
        }

        fn with_search_results(self, events: &[&Event]) -> Self {
            *self.search_query_response.lock().unwrap() = events
                .iter()
                .map(|e| serde_json::to_value(e).unwrap())
                .collect();
            self
        }
    }

    async fn spawn_mock(state: std::sync::Arc<MockState>) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let state = state.clone();
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf = vec![0; 65_536];
                    let read = socket.read(&mut buf).await.unwrap_or(0);
                    let request = String::from_utf8_lossy(&buf[..read]);
                    let json_start = request.find("\r\n\r\n").map(|i| i + 4);
                    let body_text = json_start.map(|i| &request[i..]).unwrap_or("");
                    let (status, body) = if request.starts_with("POST /query ") {
                        // The client POSTs a JSON array of filters (one per REQ).
                        let parsed_filter: serde_json::Value =
                            serde_json::from_str::<serde_json::Value>(body_text)
                                .ok()
                                .and_then(|v| {
                                    v.as_array()
                                        .and_then(|a| a.first().cloned())
                                        .or(Some(v))
                                        .filter(|f| f.is_object())
                                })
                                .unwrap_or(serde_json::Value::Null);
                        let kinds = parsed_filter["kinds"]
                            .as_array()
                            .map(|k| k.iter().filter_map(|v| v.as_u64()).collect::<Vec<_>>())
                            .unwrap_or_default();
                        let is_search = parsed_filter.get("search").is_some() && kinds.len() == 4;
                        let events = if kinds == [KIND_AGENT_TASK as u64] {
                            state.task_query_response.lock().unwrap().clone()
                        } else if kinds == [KIND_CONTRIBUTION_RECORD as u64] {
                            state.record_query_response.lock().unwrap().clone()
                        } else if kinds == [KIND_WIKI as u64] {
                            state.page_query_response.lock().unwrap().clone()
                        } else if is_search {
                            state.search_query_response.lock().unwrap().clone()
                        } else {
                            Vec::new()
                        };
                        (
                            "200 OK".to_string(),
                            serde_json::to_string(&events).unwrap(),
                        )
                    } else if request.starts_with("POST /v1/chat/completions ") {
                        let parsed: serde_json::Value =
                            serde_json::from_str(body_text).unwrap_or(serde_json::Value::Null);
                        state.chat_calls.lock().unwrap().push(parsed);
                        let next = state.chat_responses.lock().unwrap().pop_front();
                        match next {
                            Some(Ok(value)) => ("200 OK".to_string(), value.to_string()),
                            Some(Err(code)) => (format!("{code} Bad Request"), "{}".to_string()),
                            None => ("500 Internal Server Error".to_string(), "{}".to_string()),
                        }
                    } else if request.starts_with("POST /events ") {
                        let parsed: serde_json::Value =
                            serde_json::from_str(body_text).unwrap_or(serde_json::Value::Null);
                        let event_id = parsed["id"].clone();
                        state.event_posts.lock().unwrap().push(parsed);
                        (
                            "200 OK".to_string(),
                            serde_json::json!({
                                "event_id": event_id,
                                "accepted": true,
                                "message": ""
                            })
                            .to_string(),
                        )
                    } else {
                        ("404 Not Found".to_string(), "{}".to_string())
                    };
                    let response = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    socket.write_all(response.as_bytes()).await.unwrap();
                });
            }
        });
        base_url
    }

    fn classifier_config(base_url: &str) -> ClassifierConfig {
        ClassifierConfig {
            api_url: format!("{base_url}/v1"),
            api_key: "test-key".to_string(),
            model: "test-model".to_string(),
        }
    }

    // ── Command-level mock round trips (bind run_distill_inner end to end) ─

    #[tokio::test]
    async fn distill_previews_the_draft_without_publishing() {
        let task = done_task_fixture("Payments refactor", 100);
        let record = contribution_fixture("Shipped E2E harness", 200);
        let state = std::sync::Arc::new(MockState::with_sources(&[&task], &[&record]));
        state.push_chat(Ok(reflection_sufficient()));
        state.push_chat(Ok(chat_response(&markdown_draft(), Some(900))));
        let base_url = spawn_mock(state.clone()).await;

        let client = BuzzClient::new(base_url.clone(), Keys::generate(), None, None).unwrap();
        let cfg = classifier_config(&base_url);
        let result = run_distill_inner(&client, &cfg, "default", None, false).await;
        assert!(result.is_ok(), "expected ok, got {result:?}");

        let chats = state.chat_calls.lock().unwrap();
        assert_eq!(chats.len(), 2, "reflection + distill call");
        assert_eq!(chats[0]["max_tokens"], 400, "reflection uses the small cap");
        assert_eq!(chats[1]["model"], "test-model");
        assert_eq!(chats[1]["max_tokens"], 1500);
        let user = chats[1]["messages"][1]["content"].as_str().unwrap();
        assert!(user.contains("Payments refactor"));
        assert!(user.contains("Shipped E2E harness"));
        assert!(
            user.contains("search_context"),
            "distill prompt carries the context field"
        );
        let system = chats[1]["messages"][0]["content"].as_str().unwrap();
        assert!(system.contains("UNTRUSTED DATA"));

        // Preview only — nothing published, the cursor never advanced.
        assert!(state.event_posts.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn distill_publishes_signed_page_with_provenance() {
        let task = done_task_fixture("Payments refactor", 100);
        let record = contribution_fixture("Shipped E2E harness", 200);
        let state = std::sync::Arc::new(MockState::with_sources(&[&task], &[&record]));
        state.push_chat(Ok(reflection_sufficient()));
        state.push_chat(Ok(chat_response(&markdown_draft(), Some(900))));
        let base_url = spawn_mock(state.clone()).await;

        let client = BuzzClient::new(base_url.clone(), Keys::generate(), None, None).unwrap();
        let cfg = classifier_config(&base_url);
        let result = run_distill_inner(&client, &cfg, "default", None, true).await;
        assert!(result.is_ok(), "expected ok, got {result:?}");

        let posts = state.event_posts.lock().unwrap();
        assert_eq!(posts.len(), 1, "one signed 44002 publish");
        let published = &posts[0];
        assert_eq!(published["kind"], KIND_WIKI);
        let tags: Vec<Vec<String>> = published["tags"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| {
                t.as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_str().unwrap_or_default().to_string())
                    .collect()
            })
            .collect();
        assert!(tags
            .iter()
            .any(|t| t[0] == "d" && t[1] == "default/standup"));
        assert!(tags.iter().any(|t| t[0] == "model" && t[1] == "test-model"));
        assert!(
            tags.iter().any(|t| t[0] == "cost_tokens" && t[1] == "950"),
            "reflection + distill usage reported"
        );
        assert!(
            tags.iter().any(|t| t[0] == "sources"
                && t[1] == format!("{},{}", task.id.to_hex(), record.id.to_hex())),
            "both sources in the provenance tag"
        );
        let content = published["content"].as_str().unwrap();
        let parsed_cursor = parse_cursor_from_page(content).expect("published cursor parses");
        assert_eq!(parsed_cursor, 200, "cursor = max source created_at");
        assert!(content.contains("# What the org is doing"));
    }

    #[tokio::test]
    async fn distill_skips_when_nothing_new() {
        let state = std::sync::Arc::new(MockState::with_sources(&[], &[]));
        // No chat responses queued — a chat call would 500 and fail the run.
        let base_url = spawn_mock(state.clone()).await;

        let client = BuzzClient::new(base_url.clone(), Keys::generate(), None, None).unwrap();
        let cfg = classifier_config(&base_url);
        let result = run_distill_inner(&client, &cfg, "default", None, true).await;
        assert!(result.is_ok(), "expected ok, got {result:?}");
        assert_eq!(state.chat_calls.lock().unwrap().len(), 0, "no LLM call");
        assert!(state.event_posts.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn distill_fetches_only_strictly_newer_than_cursor() {
        // Existing page carries cursor 150; sources at 100 (stale) and 200 (new).
        let stale = done_task_fixture("Already distilled", 100);
        let fresh = contribution_fixture("Fresh completion", 200);
        let state = std::sync::Arc::new(MockState::with_sources(&[&stale], &[&fresh]));
        let page = standup_page_fixture(150, "# Old truth");
        state.with_pages(&[&page]);
        state.push_chat(Ok(reflection_sufficient()));
        state.push_chat(Ok(chat_response(&markdown_draft(), None)));
        let base_url = spawn_mock(state.clone()).await;

        let client = BuzzClient::new(base_url.clone(), Keys::generate(), None, None).unwrap();
        let cfg = classifier_config(&base_url);
        let result = run_distill_inner(&client, &cfg, "default", None, true).await;
        assert!(result.is_ok(), "expected ok, got {result:?}");

        // The stale task was never included: only the fresh record's id flows
        // into the sources provenance tag.
        let posts = state.event_posts.lock().unwrap();
        assert_eq!(posts.len(), 1);
        let published = &posts[0];
        let tags: Vec<Vec<String>> = published["tags"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| {
                t.as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_str().unwrap_or_default().to_string())
                    .collect()
            })
            .collect();
        let sources = tags
            .iter()
            .find(|t| t[0] == "sources")
            .map(|t| t[1].clone())
            .unwrap();
        assert!(!sources.contains(&stale.id.to_hex()), "stale excluded");
        assert!(sources.contains(&fresh.id.to_hex()), "fresh included");
        // And the prompt included the existing page for patch semantics.
        let chats = state.chat_calls.lock().unwrap();
        assert_eq!(chats.len(), 2, "reflection + distill");
        let user = chats[1]["messages"][1]["content"].as_str().unwrap();
        assert!(user.contains("# Old truth"), "existing page patched in");
        assert!(
            user.contains("\"window_started_after\": 150"),
            "cursor sent"
        );
    }

    #[tokio::test]
    async fn distill_retries_once_then_fails_closed() {
        let task = done_task_fixture("Payments refactor", 100);
        let state = std::sync::Arc::new(MockState::with_sources(&[&task], &[]));
        // First draft invalid (JSON fence), retry valid.
        state.push_chat(Ok(reflection_sufficient()));
        state.push_chat(Ok(chat_response(&dirty_draft(), None)));
        state.push_chat(Ok(chat_response(&markdown_draft(), None)));
        let base_url = spawn_mock(state.clone()).await;

        let client = BuzzClient::new(base_url.clone(), Keys::generate(), None, None).unwrap();
        let cfg = classifier_config(&base_url);
        let result = run_distill_inner(&client, &cfg, "default", None, true).await;
        assert!(result.is_ok(), "retry succeeded: {result:?}");
        assert_eq!(
            state.chat_calls.lock().unwrap().len(),
            3,
            "reflection + two attempts"
        );
        assert_eq!(
            state.event_posts.lock().unwrap().len(),
            1,
            "published after retry"
        );

        // Two invalid drafts → hard failure, nothing published.
        let state2 = std::sync::Arc::new(MockState::with_sources(&[&task], &[]));
        state2.push_chat(Ok(reflection_sufficient()));
        state2.push_chat(Ok(chat_response(&dirty_draft(), None)));
        state2.push_chat(Ok(chat_response(&dirty_draft(), None)));
        let base_url2 = spawn_mock(state2.clone()).await;
        let client2 = BuzzClient::new(base_url2.clone(), Keys::generate(), None, None).unwrap();
        let cfg2 = classifier_config(&base_url2);
        let result2 = run_distill_inner(&client2, &cfg2, "default", None, true).await;
        assert!(result2.is_err(), "fail loudly after one retry");
        assert!(
            state2.event_posts.lock().unwrap().is_empty(),
            "nothing published"
        );
    }

    // ── Config (fail-closed) ───────────────────────────────────────────────

    #[test]
    fn agwiki_config_fails_closed_without_url_or_key() {
        // Reuses the classifier provider seam: missing url/key is a usage error.
        let missing_url = crate::commands::org_classify::classifier_config_from_provider(|name| {
            (name == crate::commands::org_classify::ENV_CLASSIFIER_API_KEY).then(|| "k".to_string())
        });
        assert!(
            matches!(missing_url, Err(CliError::Usage(m)) if m.contains("BUZZ_CLASSIFIER_API_URL"))
        );

        let missing_key = crate::commands::org_classify::classifier_config_from_provider(|name| {
            (name == crate::commands::org_classify::ENV_CLASSIFIER_API_URL)
                .then(|| "http://x".to_string())
        });
        assert!(
            matches!(missing_key, Err(CliError::Usage(m)) if m.contains("BUZZ_CLASSIFIER_API_KEY"))
        );

        let ok =
            crate::commands::org_classify::classifier_config_from_provider(|name| match name {
                "BUZZ_CLASSIFIER_API_URL" => Some("http://x".to_string()),
                "BUZZ_CLASSIFIER_API_KEY" => Some("k".to_string()),
                _ => None,
            });
        assert!(ok.is_ok());
    }

    #[test]
    fn show_and_list_validate_coordinates() {
        assert!(validate_page_coordinate("default/standup").is_ok());
        assert!(validate_page_coordinate("Default/standup").is_err());
    }

    // ── Self-reflective retrieval (fail-open) ──────────────────────────────

    #[tokio::test]
    async fn reflection_failure_fails_open_and_distill_proceeds() {
        let task = done_task_fixture("Payments refactor", 100);
        let state = std::sync::Arc::new(MockState::with_sources(&[&task], &[]));
        // Reflection call 500s; distill still runs.
        state.push_chat(Err(500));
        state.push_chat(Ok(chat_response(&markdown_draft(), Some(900))));
        let base_url = spawn_mock(state.clone()).await;

        let client = BuzzClient::new(base_url.clone(), Keys::generate(), None, None).unwrap();
        let cfg = classifier_config(&base_url);
        let result = run_distill_inner(&client, &cfg, "default", None, false).await;
        assert!(
            result.is_ok(),
            "reflection failure must not fail the distill: {result:?}"
        );

        let chats = state.chat_calls.lock().unwrap();
        assert_eq!(chats.len(), 2, "reflection attempt + distill");
        let user = chats[1]["messages"][1]["content"].as_str().unwrap();
        assert!(user.contains("Payments refactor"));
        // No search context accumulated.
        assert!(state.event_posts.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn reflection_runs_followup_searches_and_augments_context() {
        let task = done_task_fixture("Mesh rollout plan", 100);
        let msg_a = EventBuilder::new(
            Kind::Custom(9),
            "Decided at standup: mesh beta ships behind the consent panel toggle.",
        )
        .custom_created_at(nostr::Timestamp::from(150))
        .sign_with_keys(&Keys::generate())
        .expect("signs");
        let msg_b = EventBuilder::new(
            Kind::Custom(40002),
            "Mesh rollout follow-up: channel templates carry the default privacy.",
        )
        .custom_created_at(nostr::Timestamp::from(160))
        .sign_with_keys(&Keys::generate())
        .expect("signs");
        let state = std::sync::Arc::new(
            MockState::with_sources(&[&task], &[]).with_search_results(&[&msg_a, &msg_b]),
        );
        // Reflection says insufficient with one query (round 1); round 2 says sufficient.
        state.push_chat(Ok(chat_response(
            r#"{"sufficient": false, "queries": ["mesh rollout"], "reason": "missing channel decisions"}"#,
            Some(60),
        )));
        state.push_chat(Ok(reflection_sufficient()));
        state.push_chat(Ok(chat_response(&markdown_draft(), Some(900))));
        let base_url = spawn_mock(state.clone()).await;

        let client = BuzzClient::new(base_url.clone(), Keys::generate(), None, None).unwrap();
        let cfg = classifier_config(&base_url);
        let result = run_distill_inner(&client, &cfg, "default", None, true).await;
        assert!(result.is_ok(), "expected ok, got {result:?}");

        let chats = state.chat_calls.lock().unwrap();
        assert_eq!(
            chats.len(),
            3,
            "round1 reflection + round2 reflection + distill"
        );
        let distill_user = chats[2]["messages"][1]["content"].as_str().unwrap();
        assert!(
            distill_user.contains("consent panel toggle"),
            "search snippet reached the distill prompt"
        );
        assert!(distill_user.contains("search_context"));
        drop(chats);

        // Provenance: the searched event ids join the sources tag.
        let posts = state.event_posts.lock().unwrap();
        assert_eq!(posts.len(), 1);
        let tags: Vec<Vec<String>> = posts[0]["tags"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| {
                t.as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_str().unwrap_or_default().to_string())
                    .collect()
            })
            .collect();
        let sources = tags
            .iter()
            .find(|t| t[0] == "sources")
            .map(|t| t[1].clone())
            .unwrap();
        assert!(sources.contains(&task.id.to_hex()));
        assert!(
            sources.contains(&msg_a.id.to_hex()),
            "searched message in provenance"
        );
        assert!(sources.contains(&msg_b.id.to_hex()));
        // Cost: 60 + 50 + 900.
        assert!(tags.iter().any(|t| t[0] == "cost_tokens" && t[1] == "1010"));
    }
}
