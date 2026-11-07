//! The distill loop driver, parameterized by narrow host ports.
//!
//! [`run_distill`] is the single end-to-end implementation both hosts
//! execute: bounded source fetch → skip-cleanly when nothing new → bounded
//! self-reflective retrieval → strict draft validation (one retry) →
//! deterministic front-matter → preview or publish. The hosts differ only
//! in four genuinely different things, expressed as [`DistillPorts`]:
//! reading sources (relay `/query` vs. the relay's own store), the
//! follow-up NIP-50 search (relay search vs. Postgres FTS), signing +
//! publishing (client submit vs. the relay's internal ingest path), and
//! error typing ([`DistillPorts::Error`] preserves each host's error
//! codes/messages unchanged).
//!
//! The LLM call is a port too ([`DistillPorts::chat`]) so tests can fake
//! it, but both real implementations delegate to the one shared contract in
//! [`crate::llm::chat_completion`] — same endpoint shape, same 429 back-off.

use std::fmt::Display;
use std::future::Future;
use std::pin::Pin;

use nostr::{Event, EventBuilder};

use crate::{
    assemble_bundle, build_agent_wiki_builder, build_distill_prompt,
    build_reflection_system_prompt, build_reflection_user_prompt, chat_completion_content,
    compose_page, merge_search_context, parse_cursor_from_page, parse_reflection_decision,
    search_result_entry, truncate, validate_page_coordinate, validate_page_draft, DistillBundle,
    PageDraft, SearchContextEntry, AGWIKI_CONTRIBUTION_KIND, AGWIKI_DEFAULT_LIMIT,
    AGWIKI_FETCH_MULTIPLIER, AGWIKI_FETCH_RESERVE, AGWIKI_HARD_CAP, AGWIKI_MAX_TOKENS,
    AGWIKI_REFLECTION_MAX_TOKENS, AGWIKI_REFLECTION_ROUNDS, AGWIKI_SEARCH_KINDS,
    AGWIKI_SEARCH_RESULT_LIMIT, AGWIKI_TASK_KIND, AGWIKI_TIMEOUT, STANDUP_SLUG,
};

/// Boxed `Send` future returned by [`DistillPorts`] methods.
///
/// Boxed (rather than an associated `Future` type) so hosts can implement the
/// ports with ordinary `async move` blocks without `async-trait`; `Send` so a
/// host may drive the loop from the relay runtime.
pub type PortFut<'a, T, E> = Pin<Box<dyn Future<Output = Result<T, E>> + Send + 'a>>;

/// Host side effects and reads the distill loop needs.
///
/// Returned futures are boxed for `Send`-safe reuse across hosts; errors are
/// the host's own error type so nothing is lost translating them.
pub trait DistillPorts {
    /// Host error type (preserves host error codes, e.g. the CLI's
    /// `network_error` vs `user_error` envelope distinction).
    type Error: Display + Send + Sync + 'static;

    /// Bounded relay read of one source kind (newest first).
    ///
    /// The driver applies the strict cursor/status filters and caps via
    /// [`assemble_bundle`]; the host only fetches up to `bound` events of
    /// `kind` at-or-after `since` (`since == 0` means "no lower bound").
    fn fetch_kind_events(
        &self,
        kind: u32,
        since: u64,
        bound: u32,
    ) -> PortFut<'_, Vec<Event>, Self::Error>;

    /// Newest standup page revision for `coordinate`, if any — `(content,
    /// created_at)` (read-side LWW across authors).
    fn fetch_existing_page(
        &self,
        coordinate: &str,
    ) -> PortFut<'_, Option<(String, u64)>, Self::Error>;

    /// One bounded NIP-50 follow-up search over community text
    /// (reflection only — fail-open at the call site).
    ///
    /// `kinds`/`limit` are the search contract ([`AGWIKI_SEARCH_KINDS`] /
    /// [`AGWIKI_SEARCH_RESULT_LIMIT`]); results are `{"id", "content"}`
    /// JSON values.
    fn search(
        &self,
        query: &str,
        kinds: &[u32],
        limit: u32,
    ) -> PortFut<'_, Vec<serde_json::Value>, Self::Error>;

    /// One LLM chat-completions call on the shared transport
    /// ([`chat_completion`]); returns the raw response JSON.
    fn chat(
        &self,
        http: &reqwest::Client,
        system: &str,
        user: &str,
        max_tokens: u32,
    ) -> PortFut<'_, serde_json::Value, Self::Error>;

    /// Sign + publish the composed page. Returns the host's write result
    /// (the CLI: the normalized write response; the relay: the event id).
    fn publish(&self, builder: EventBuilder) -> PortFut<'_, String, Self::Error>;

    /// Model id recorded in front-matter + the `model` provenance tag.
    /// Member corrections for `coordinate` not yet consumed by its latest
    /// agent-page revision — folded into the next distill prompt and recorded
    /// on the published page's `a` tags. Default: none (the relay job has no
    /// correction feed).
    fn fetch_corrections(
        &self,
        _coordinate: &str,
    ) -> PortFut<'_, Vec<crate::CorrectionNote>, Self::Error> {
        Box::pin(async { Ok(Vec::new()) })
    }

    fn llm_model(&self) -> &str;
}

/// Options for one distill round trip.
pub struct DistillOptions<'a> {
    /// Wiki space name; the page coordinate is `<space>/standup`.
    pub space: &'a str,
    /// Per-kind source cap (default [`AGWIKI_DEFAULT_LIMIT`], clamped to
    /// [`AGWIKI_HARD_CAP`]).
    pub limit: Option<u32>,
    /// Publish the composed page when `true`; otherwise return a preview.
    pub publish: bool,
    /// Optional system-prompt override — the trainable skill (a SkillOpt
    /// `best_skill.md`), loaded instead of the built-in [`build_system_prompt`].
    /// The caller owns provenance and review for whatever it passes.
    pub system_prompt: Option<&'a str>,
}

/// Facts about a finished (or previewed) distill, for host reporting.
#[derive(Debug, Clone, PartialEq)]
pub struct DistillReport {
    /// Wiki space name (trimmed, lowercased).
    pub space: String,
    /// Page coordinate (`<space>/standup`).
    pub coordinate: String,
    /// The new durable cursor (source-window boundary).
    pub cursor: u64,
    /// Total token cost (draft + reflection).
    pub cost_tokens: u64,
    /// Model id recorded in the page.
    pub model: String,
    /// Source event ids recorded in the `sources` provenance tag.
    pub sources: Vec<String>,
}

/// Outcome of one distill round trip.
#[derive(Debug, Clone, PartialEq)]
pub enum DistillOutcome {
    /// Nothing new since the cursor — nothing distilled, nothing published.
    Skipped {
        /// Page coordinate whose cursor bounded the (empty) window.
        coordinate: String,
        /// The resume cursor the run started from.
        since: u64,
    },
    /// A validated draft was composed but not published (preview mode).
    Preview {
        /// Run facts (cost/cursor/model/sources).
        report: DistillReport,
        /// The composed page (front-matter + body).
        page: String,
    },
    /// The composed page was published.
    Published {
        /// Run facts (cost/cursor/model/sources).
        report: DistillReport,
        /// The host's write result (CLI: normalized write response;
        /// relay: the published event id hex).
        write_result: String,
    },
}

/// Failures from [`run_distill`].
#[derive(Debug)]
pub enum DistillError<E> {
    /// Contract/usage failure with a user-visible message (corrupt cursor
    /// front-matter, invalid draft after one retry, publish bounds, …).
    Failed(String),
    /// A host port failed — preserved typed so hosts keep their error codes.
    Port(E),
}

impl<E: Display> Display for DistillError<E> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DistillError::Failed(m) => f.write_str(m),
            DistillError::Port(e) => write!(f, "{e}"),
        }
    }
}

/// One round trip through the distill pipeline.
///
/// Fetch bundle → (skip when nothing new) → reflect → prompt → LLM →
/// validate (retry once) → compose page with the new cursor → preview or
/// publish. Publishing advances the durable cursor because the new page's
/// front-matter records it; a preview never advances it. Nothing is ever
/// published on failure (fail-closed).
///
/// `diag` receives human-oriented diagnostics (invalid-draft retry notice,
/// fail-open reflection warnings) so the CLI can print to stderr and the
/// relay can log.
pub async fn run_distill<P: DistillPorts>(
    ports: &P,
    opts: &DistillOptions<'_>,
    diag: &(dyn Fn(&str) + Send + Sync),
) -> Result<DistillOutcome, DistillError<P::Error>> {
    let space = opts.space.trim().to_lowercase();
    validate_page_coordinate(&format!("{space}/{STANDUP_SLUG}")).map_err(DistillError::Failed)?;
    let coordinate = format!("{space}/{STANDUP_SLUG}");

    let cap = opts
        .limit
        .unwrap_or(AGWIKI_DEFAULT_LIMIT)
        .min(AGWIKI_HARD_CAP);
    let bound = cap
        .saturating_mul(AGWIKI_FETCH_MULTIPLIER)
        .saturating_add(AGWIKI_FETCH_RESERVE);

    let existing = ports
        .fetch_existing_page(&coordinate)
        .await
        .map_err(DistillError::Port)?;
    let since = match &existing {
        Some((content, _)) => parse_cursor_from_page(content).map_err(DistillError::Failed)?,
        None => 0,
    };

    let task_events = ports
        .fetch_kind_events(AGWIKI_TASK_KIND, since, bound)
        .await
        .map_err(DistillError::Port)?;
    let record_events = ports
        .fetch_kind_events(AGWIKI_CONTRIBUTION_KIND, since, bound)
        .await
        .map_err(DistillError::Port)?;
    let (bundle, new_cursor) = assemble_bundle(&task_events, &record_events, since, cap);

    if bundle.tasks.is_empty() && bundle.contributions.is_empty() {
        return Ok(DistillOutcome::Skipped { coordinate, since });
    }

    // Bounded self-reflective retrieval: the distiller may request follow-up
    // community searches before drafting (fails open — enhancement, not gate).
    let (search_context, reflection_cost) = reflect_and_search(ports, &space, &bundle, diag).await;

    // Unconsumed member corrections for this page: folded into the prompt and
    // recorded on the published page's `a` tags. Consumption lives on the
    // agent's own page — member correction pages are never modified.
    let corrections = ports
        .fetch_corrections(&coordinate)
        .await
        .map_err(DistillError::Port)?;

    let (system, user) = build_distill_prompt(
        &space,
        since,
        &bundle,
        existing.as_ref().map(|(c, _)| c.as_str()),
        &search_context,
        &corrections,
    );
    // The trainable skill override (a SkillOpt `best_skill.md`): the caller
    // owns provenance and review for whatever it passes.
    let system = opts.system_prompt.unwrap_or(&system);
    let draft = distill_draft(ports, system, &user, diag).await?;
    let total_cost = draft.cost_tokens.saturating_add(reflection_cost);

    let page = compose_page(&space, &draft.body, ports.llm_model(), new_cursor);
    let sources: Vec<String> = bundle
        .tasks
        .iter()
        .map(|t| t.id.clone())
        .chain(bundle.contributions.iter().map(|c| c.id.clone()))
        .chain(search_context.iter().map(|e| e.event_id.clone()))
        .collect();
    let report = DistillReport {
        space,
        coordinate,
        cursor: new_cursor,
        cost_tokens: total_cost,
        model: ports.llm_model().to_string(),
        sources,
    };

    if !opts.publish {
        return Ok(DistillOutcome::Preview { report, page });
    }

    let applied: Vec<String> = corrections.iter().map(|c| c.coordinate.clone()).collect();
    let builder = build_agent_wiki_builder(
        &report.coordinate,
        &page,
        &report.model,
        report.cost_tokens,
        &report.sources,
        &applied,
    )
    .map_err(DistillError::Failed)?;
    let write_result = ports.publish(builder).await.map_err(DistillError::Port)?;
    Ok(DistillOutcome::Published {
        report,
        write_result,
    })
}

/// Call the distiller, validate the markdown draft, retry once on a bad draft.
///
/// A draft that fails [`validate_page_draft`] gets exactly one retry with the
/// same prompt; a second invalid draft fails loudly and nothing is published.
async fn distill_draft<P: DistillPorts>(
    ports: &P,
    system: &str,
    user: &str,
    diag: &(dyn Fn(&str) + Send + Sync),
) -> Result<PageDraft, DistillError<P::Error>> {
    let http = reqwest::Client::builder()
        .timeout(AGWIKI_TIMEOUT)
        .build()
        .map_err(|e| DistillError::Failed(format!("agent wiki client init failed: {e}")))?;

    let mut last_error: Option<String> = None;
    for attempt in 0..2 {
        match ports.chat(&http, system, user, AGWIKI_MAX_TOKENS).await {
            Ok(value) => {
                let content = chat_completion_content(&value).map_err(|e| {
                    DistillError::Failed(format!("agent wiki response unusable: {e}"))
                })?;
                match validate_page_draft(&content) {
                    Ok(()) => {
                        let cost_tokens = value
                            .get("usage")
                            .and_then(|u| u.get("total_tokens"))
                            .and_then(serde_json::Value::as_u64)
                            .unwrap_or(AGWIKI_MAX_TOKENS as u64);
                        return Ok(PageDraft {
                            body: content,
                            cost_tokens,
                        });
                    }
                    Err(e) => last_error = Some(e),
                }
            }
            Err(e) => return Err(DistillError::Port(e)),
        }
        if attempt == 0 {
            diag(&format!(
                "agent wiki draft invalid (attempt 1): {}",
                last_error.as_deref().unwrap_or("unknown")
            ));
        }
    }
    Err(DistillError::Failed(format!(
        "agent wiki produced no valid page after one retry: {}",
        last_error.unwrap_or_else(|| "unknown".to_string())
    )))
}

/// One self-reflective retrieval pass: judge the bundle, run up to
/// `AGWIKI_REFLECTION_QUERIES_PER_ROUND` NIP-50 searches per round, return
/// the merged context plus the tokens the reflection calls spent. **Fails
/// open**: any reflection/search failure logs loudly via `diag` and returns
/// what has accumulated (possibly empty) — the reflection is an enhancement,
/// and the distill must still work when the search index is down.
async fn reflect_and_search<P: DistillPorts>(
    ports: &P,
    space: &str,
    bundle: &DistillBundle,
    diag: &(dyn Fn(&str) + Send + Sync),
) -> (Vec<SearchContextEntry>, u64) {
    let http = match reqwest::Client::builder().timeout(AGWIKI_TIMEOUT).build() {
        Ok(http) => http,
        Err(e) => {
            diag(&format!(
                "agent wiki reflection unavailable (client init): {e}"
            ));
            return (Vec::new(), 0);
        }
    };
    let mut accumulated: Vec<SearchContextEntry> = Vec::new();
    let mut cost_tokens: u64 = 0;

    for _round in 0..AGWIKI_REFLECTION_ROUNDS {
        let (system, user) = (
            build_reflection_system_prompt(),
            build_reflection_user_prompt(space, bundle, &accumulated),
        );
        let value = match ports
            .chat(&http, &system, &user, AGWIKI_REFLECTION_MAX_TOKENS)
            .await
        {
            Ok(value) => value,
            Err(e) => {
                diag(&format!(
                    "agent wiki reflection failed (continuing without it): {}",
                    truncate(&e.to_string(), 200)
                ));
                return (accumulated, cost_tokens);
            }
        };
        cost_tokens += value
            .get("usage")
            .and_then(|u| u.get("total_tokens"))
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        let content = match chat_completion_content(&value) {
            Ok(content) => content,
            Err(e) => {
                diag(&format!(
                    "agent wiki reflection unusable (continuing without it): {e}"
                ));
                return (accumulated, cost_tokens);
            }
        };
        let decision = match parse_reflection_decision(&content) {
            Ok(d) => d,
            Err(e) => {
                diag(&format!(
                    "agent wiki reflection invalid (continuing without it): {e}"
                ));
                return (accumulated, cost_tokens);
            }
        };
        if decision.sufficient || decision.queries.is_empty() {
            return (accumulated, cost_tokens);
        }
        for query in &decision.queries {
            let events = match ports
                .search(query, &AGWIKI_SEARCH_KINDS, AGWIKI_SEARCH_RESULT_LIMIT)
                .await
            {
                Ok(events) => events,
                Err(e) => {
                    diag(&format!(
                        "agent wiki follow-up search failed (skipped): {}",
                        truncate(&e.to_string(), 200)
                    ));
                    continue;
                }
            };
            let additions: Vec<SearchContextEntry> =
                events.iter().filter_map(search_result_entry).collect();
            accumulated = merge_search_context(accumulated, additions);
        }
    }
    (accumulated, cost_tokens)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{FRONT_MATTER_CURSOR_KEY, KIND_AGENT_WIKI};
    use nostr::{EventBuilder, Keys, Kind, Tag};
    use std::collections::VecDeque;
    use std::sync::Mutex;

    // ── Fixtures (same shapes as the CLI's end-to-end tests) ──────────────

    fn done_task_fixture(title: &str, ts: u64) -> Event {
        let content = serde_json::json!({
            "title": title,
            "description": "Completed work item with a real description",
            "status": "done",
            "priority": "normal",
        });
        EventBuilder::new(Kind::Custom(AGWIKI_TASK_KIND as u16), content.to_string())
            .custom_created_at(nostr::Timestamp::from(ts))
            .sign_with_keys(&Keys::generate())
            .expect("signs")
    }

    fn open_task_fixture(title: &str, ts: u64) -> Event {
        let content = serde_json::json!({
            "title": title,
            "description": "Still open",
            "status": "in_progress",
        });
        EventBuilder::new(Kind::Custom(AGWIKI_TASK_KIND as u16), content.to_string())
            .custom_created_at(nostr::Timestamp::from(ts))
            .sign_with_keys(&Keys::generate())
            .expect("signs")
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
            Kind::Custom(AGWIKI_CONTRIBUTION_KIND as u16),
            content.to_string(),
        )
        .custom_created_at(nostr::Timestamp::from(ts))
        .sign_with_keys(&Keys::generate())
        .expect("signs")
    }

    fn standup_page_fixture(cursor: u64, body: &str) -> Event {
        let page = format!(
            "---\nslug: default/standup\n{FRONT_MATTER_CURSOR_KEY}: {cursor}\nmodel: old-model\ngenerated-at: 1\n---\n{body}"
        );
        EventBuilder::new(Kind::Custom(KIND_AGENT_WIKI as u16), page)
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

    // ── Fake ports (binds the production run_distill seam) ────────────────

    #[derive(Default)]
    struct FakePorts {
        page: Option<(String, u64)>,
        task_events: Vec<Event>,
        record_events: Vec<Event>,
        chat_replies: Mutex<VecDeque<Result<serde_json::Value, String>>>,
        chat_calls: std::sync::atomic::AtomicUsize,
        search_results: Vec<serde_json::Value>,
        published: Mutex<Vec<EventBuilder>>,
    }

    impl DistillPorts for FakePorts {
        type Error = String;

        fn fetch_kind_events(
            &self,
            kind: u32,
            _since: u64,
            _bound: u32,
        ) -> Pin<Box<dyn Future<Output = Result<Vec<Event>, Self::Error>> + Send + '_>> {
            let events = if kind == AGWIKI_TASK_KIND {
                self.task_events.clone()
            } else {
                self.record_events.clone()
            };
            Box::pin(async move { Ok(events) })
        }

        fn fetch_existing_page(
            &self,
            _coordinate: &str,
        ) -> Pin<Box<dyn Future<Output = Result<Option<(String, u64)>, Self::Error>> + Send + '_>>
        {
            let page = self.page.clone();
            Box::pin(async move { Ok(page) })
        }

        fn search(
            &self,
            _query: &str,
            _kinds: &[u32],
            _limit: u32,
        ) -> Pin<Box<dyn Future<Output = Result<Vec<serde_json::Value>, Self::Error>> + Send + '_>>
        {
            let results = self.search_results.clone();
            Box::pin(async move { Ok(results) })
        }

        fn chat(
            &self,
            _http: &reqwest::Client,
            _system: &str,
            _user: &str,
            _max_tokens: u32,
        ) -> Pin<Box<dyn Future<Output = Result<serde_json::Value, Self::Error>> + Send + '_>>
        {
            self.chat_calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let next = self
                .chat_replies
                .lock()
                .expect("chat log poisoned")
                .pop_front();
            Box::pin(async move { next.unwrap_or_else(|| Err("no chat reply queued".to_string())) })
        }

        fn publish(
            &self,
            builder: EventBuilder,
        ) -> Pin<Box<dyn Future<Output = Result<String, Self::Error>> + Send + '_>> {
            self.published
                .lock()
                .expect("publish log poisoned")
                .push(builder);
            Box::pin(async move { Ok("write-ok".to_string()) })
        }

        fn llm_model(&self) -> &str {
            "test-model"
        }
    }

    fn opts(publish: bool) -> DistillOptions<'static> {
        DistillOptions {
            space: "default",
            limit: None,
            publish,
            system_prompt: None,
        }
    }

    fn noop_diag(_msg: &str) {}

    // ── The triad: LLM failure / skip-cleanly / success ───────────────────

    #[tokio::test]
    async fn llm_failure_fails_and_publishes_nothing() {
        let ports = FakePorts {
            task_events: vec![done_task_fixture("Payments refactor", 100)],
            chat_replies: Mutex::new(VecDeque::from([
                Ok(reflection_sufficient()),
                Err("llm down".to_string()),
            ])),
            ..Default::default()
        };
        let result = run_distill(&ports, &opts(true), &noop_diag).await;
        match result {
            Err(DistillError::Port(e)) => assert_eq!(e, "llm down"),
            other => panic!("expected port failure, got {other:?}"),
        }
        assert!(
            ports.published.lock().expect("publish log").is_empty(),
            "nothing may be published on failure"
        );
    }

    #[tokio::test]
    async fn skip_cleanly_publishes_nothing_and_skips_llm() {
        let ports = FakePorts::default(); // no sources at all
        let outcome = run_distill(&ports, &opts(true), &noop_diag)
            .await
            .expect("skip is not a failure");
        assert!(
            matches!(outcome, DistillOutcome::Skipped { since: 0, .. }),
            "got {outcome:?}"
        );
        assert_eq!(
            ports.chat_calls.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "no LLM call on an empty window"
        );
        assert!(ports.published.lock().expect("publish log").is_empty());
    }

    #[tokio::test]
    async fn success_publishes_with_front_matter_and_cursor() {
        let task = done_task_fixture("Payments refactor", 100);
        let record = contribution_fixture("Shipped E2E harness", 200);
        let ports = FakePorts {
            task_events: vec![task.clone()],
            record_events: vec![record.clone()],
            chat_replies: Mutex::new(VecDeque::from([
                Ok(reflection_sufficient()),
                Ok(chat_response(&markdown_draft(), Some(900))),
            ])),
            ..Default::default()
        };
        let outcome = run_distill(&ports, &opts(true), &noop_diag)
            .await
            .expect("distill succeeds");
        let DistillOutcome::Published {
            report,
            write_result,
        } = outcome
        else {
            panic!("expected Published, got {outcome:?}");
        };
        assert_eq!(write_result, "write-ok", "write result passes through");
        assert_eq!(report.coordinate, "default/standup");
        assert_eq!(report.cursor, 200, "cursor = max included created_at");
        assert_eq!(report.cost_tokens, 950, "reflection + draft usage");
        assert_eq!(
            report.sources,
            vec![task.id.to_hex(), record.id.to_hex()],
            "both sources in provenance"
        );

        let published = ports.published.lock().expect("publish log");
        assert_eq!(published.len(), 1, "one publish");
        let event = published[0]
            .clone()
            .sign_with_keys(&Keys::generate())
            .expect("signs");
        assert_eq!(event.kind.as_u16(), KIND_AGENT_WIKI as u16);
        let content = event.content.clone();
        let parsed_cursor = parse_cursor_from_page(&content).expect("cursor parses");
        assert_eq!(parsed_cursor, 200, "front-matter carries the new cursor");
        assert!(
            content.starts_with("---\nslug: default/standup\n"),
            "deterministic front-matter"
        );
        assert!(content.contains("\nmodel: test-model\n"), "model recorded");
        assert!(content.contains(&markdown_draft()), "body survives");
        let tags: Vec<Vec<String>> = event.tags.iter().map(|t| t.as_slice().to_vec()).collect();
        assert!(tags
            .iter()
            .any(|t| t[0] == "d" && t[1] == "default/standup"));
        assert!(
            tags.iter().any(|t| t[0] == "cost_tokens" && t[1] == "950"),
            "cost in provenance"
        );
        assert!(
            tags.iter().any(|t| t[0] == "sources"
                && t[1] == format!("{},{}", task.id.to_hex(), record.id.to_hex())),
            "sources provenance"
        );
    }

    #[tokio::test]
    async fn preview_publishes_nothing() {
        let ports = FakePorts {
            task_events: vec![done_task_fixture("Payments refactor", 100)],
            chat_replies: Mutex::new(VecDeque::from([
                Ok(reflection_sufficient()),
                Ok(chat_response(&markdown_draft(), Some(900))),
            ])),
            ..Default::default()
        };
        let outcome = run_distill(&ports, &opts(false), &noop_diag)
            .await
            .expect("preview succeeds");
        assert!(matches!(outcome, DistillOutcome::Preview { .. }));
        assert!(ports.published.lock().expect("publish log").is_empty());
    }

    #[tokio::test]
    async fn invalid_draft_twice_fails_closed_without_publish() {
        let dirty = "# Not valid\n\n```json\n{\"llm\":\"leaked bundle\"}\n```\n".to_string();
        let ports = FakePorts {
            task_events: vec![done_task_fixture("Payments refactor", 100)],
            chat_replies: Mutex::new(VecDeque::from([
                Ok(reflection_sufficient()),
                Ok(chat_response(&dirty, None)),
                Ok(chat_response(&dirty, None)),
            ])),
            ..Default::default()
        };
        let result = run_distill(&ports, &opts(true), &noop_diag).await;
        match result {
            Err(DistillError::Failed(m)) => {
                assert!(m.contains("no valid page after one retry"), "got: {m}")
            }
            other => panic!("expected fail-closed, got {other:?}"),
        }
        assert!(ports.published.lock().expect("publish log").is_empty());
    }

    // ── Bundle assembly: filtering + the truncation min(created_at) rule ──

    #[test]
    fn assemble_bundle_filters_open_tasks_and_stale_events() {
        let done = done_task_fixture("Done one", 100);
        let open = open_task_fixture("Open two", 300);
        let (bundle, cursor) = assemble_bundle(&[done.clone(), open], &[], 0, 5);
        assert_eq!(bundle.tasks.len(), 1, "open task filtered out");
        assert_eq!(bundle.tasks[0].title, "Done one");
        assert_eq!(cursor, 100, "cursor = max included");

        // Strictly-newer-than-cursor filtering.
        let fresh = contribution_fixture("Fresh completion", 200);
        let (bundle, cursor) = assemble_bundle(&[done], std::slice::from_ref(&fresh), 150, 5);
        assert!(bundle.tasks.is_empty(), "stale task excluded");
        assert_eq!(bundle.contributions.len(), 1);
        assert_eq!(cursor, 200);
    }

    #[test]
    fn truncation_advances_cursor_to_min_included() {
        // Two done tasks but cap 1: the window truncates, so the cursor may
        // only advance to the OLDEST included source — the window is
        // re-fetched next run instead of silently dropping sources.
        let first = done_task_fixture("Newest done", 300);
        let second = done_task_fixture("Oldest done", 100);
        let (bundle, cursor) = assemble_bundle(&[first.clone(), second.clone()], &[], 0, 1);
        assert_eq!(bundle.tasks.len(), 1);
        assert_eq!(cursor, 300, "truncated → min included created_at");
        // With the events ordered oldest-first, min is the oldest included.
        let (bundle, cursor) = assemble_bundle(&[second, first], &[], 0, 1);
        assert_eq!(bundle.tasks.len(), 1);
        assert_eq!(cursor, 100, "truncated → min included created_at");
    }

    #[tokio::test]
    async fn fetch_reuses_existing_page_for_patch_semantics() {
        let page = standup_page_fixture(150, "# Old truth");
        let record = contribution_fixture("Fresh completion", 200);
        let ports = FakePorts {
            page: Some((page.content.clone(), page.created_at.as_secs())),
            record_events: vec![record.clone()],
            chat_replies: Mutex::new(VecDeque::from([
                Ok(reflection_sufficient()),
                Ok(chat_response(&markdown_draft(), None)),
            ])),
            ..Default::default()
        };
        let outcome = run_distill(&ports, &opts(true), &noop_diag)
            .await
            .expect("distill succeeds");
        let DistillOutcome::Published { report, .. } = outcome else {
            panic!("expected Published, got {outcome:?}");
        };
        assert_eq!(report.cursor, 200);
        // The stale task never enters provenance; only the fresh record does.
        assert_eq!(report.sources, vec![record.id.to_hex()]);
    }
}
