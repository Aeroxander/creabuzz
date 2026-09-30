//! Template apply engine: idempotent planning, ordered execution, and
//! honest partial-failure reporting with `--resume`.
//!
//! # Idempotency / marker scheme (Review-Proven Rules 1 + 5)
//!
//! Every template-created event carries a template-managed marker tag
//! `["t", "<template-id>", "<item-id>"]`. Re-apply queries the relay for
//! marker-tagged events (scoped to the signer) and skips items that already
//! exist — so a partially-applied template is a consistent prefix, and
//! `templates apply <id> --resume` completes the remainder from the durable
//! relay state (no local journal to corrupt or lose). Channels dedupe by name
//! (the NIP-29 handle); skills additionally record their `source` so an
//! unchanged https source is skipped **without refetching** (pin semantics —
//! byte-reproducible re-applies; a changed source re-fetches and replaces).
//!
//! Execution is strictly ordered (channels → seeds → skills → personas →
//! workflows → docs → welcome) and stops at the first failure: every prefix is
//! consistent and the remainder is reported as `not-attempted`.
//!
//! # Step order rationale
//!
//! Seeds post immediately after their channel (the contract: "posted as the
//! channel's first message"). Welcome posts last to the FIRST channel (the
//! contract constrains only its location and that it is returned for the UI's
//! success state). Skills publish before personas so a persona's
//! `["skill", …]` bindings never reference an unpublished skill.
//!
//! # Replaceable publishes
//!
//! Kind:30180 skills, kind:30175 personas, kind:30620 workflows, and
//! kind:30023 docs are NIP-33 parameterized replaceable; re-publishes use a
//! monotonic `created_at` (`max(now, prior + 1)`) so a same-second replacement
//! cannot lose the relay's LWW tie-break to an older head.

use std::collections::{BTreeMap, BTreeSet};

use buzz_sdk::{
    BudgetLimits, BudgetWindow, OnExceed, OrgBudgetContent, OrgNodeContent, OrgNodeKind, OrgNodeUi,
    OrgScope, TaskLimits,
};
use nostr::{EventBuilder, Kind, Tag, Timestamp};
use sha2::{Digest, Sha256};

use super::schema::{
    doc_slug, seat_node_id, Template, TemplateFiles, TemplateSkill, ORG_DEFAULT_BUDGET_ID,
    ORG_ROOT_NODE_ID,
};
use crate::client::{extract_d_tag, extract_tag_value, normalize_write_response, BuzzClient};
use crate::error::CliError;

/// Wall-clock cap for one https skill fetch.
const SKILL_FETCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
/// Byte cap for one https skill fetch (SKILL.md is bounded at 64 KiB).
const SKILL_FETCH_MAX_BYTES: usize = 64 * 1024;

// ── Planning (pure) ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum StepKind {
    Channel,
    Seed,
    Skill,
    Persona,
    Org,
    Workflow,
    Doc,
    Welcome,
}

impl StepKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Channel => "channel",
            Self::Seed => "seed",
            Self::Skill => "skill",
            Self::Persona => "persona",
            Self::Org => "org",
            Self::Workflow => "workflow",
            Self::Doc => "doc",
            Self::Welcome => "welcome",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    /// The item already exists on the relay (channel name or marker match).
    AlreadyExists,
    /// The item exists with the same pinned source — re-apply is a no-op.
    Unchanged,
}

impl SkipReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AlreadyExists => "already-exists",
            Self::Unchanged => "unchanged",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanAction {
    Create,
    Skip(SkipReason),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanStep {
    pub kind: StepKind,
    pub item: String,
    pub action: PlanAction,
}

/// A marker-tagged item found on the relay.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ExistingItem {
    pub event_id: String,
    pub created_at: u64,
    /// Skills: the recorded source (URL or template-relative path).
    pub source: Option<String>,
    /// Skills: the recorded sha256 pin of the content bytes.
    pub sha256: Option<String>,
}

/// What the relay already holds for this template, gathered before planning.
#[derive(Debug, Default, Clone)]
pub struct ExistingState {
    /// Canonical channel name → channel id (from kind:39000 metadata).
    pub channels: BTreeMap<String, String>,
    /// Marker-matched items, keyed by (step kind, marker item id).
    pub items: BTreeMap<(StepKind, String), ExistingItem>,
    /// `d` tags of the signer's own kind:37010 org nodes. Org steps dedup on
    /// these (not on the marker) so an org the user built by hand is never
    /// overwritten by a template's replaceable re-publish.
    pub org_nodes: BTreeSet<String>,
    /// `d` tags of the signer's own kind:37012 budgets (same reasoning).
    pub org_budgets: BTreeSet<String>,
}

/// Marker item id for a channel seed message.
pub fn seed_item(channel_id: &str) -> String {
    format!("seed:{channel_id}")
}

/// The marker tag every template-created event carries.
pub fn marker_tag(template_id: &str, item: &str) -> Result<Tag, CliError> {
    Tag::parse(["t", template_id, item])
        .map_err(|e| CliError::Other(format!("failed to build template marker: {e}")))
}

/// Monotonic `created_at` for a replaceable re-publish (see module docs).
pub fn next_created_at(prior: Option<u64>) -> u64 {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    now.max(prior.map_or(0, |t| t + 1))
}

/// Build the ordered plan. Pure: given the template and what the relay
/// already holds, every step is decided as Create or Skip with a reason.
pub fn plan_apply(template: &Template, existing: &ExistingState) -> Vec<PlanStep> {
    let mut steps: Vec<PlanStep> = Vec::new();

    for ch in &template.channels {
        let canon = buzz_core::channel::canonical_channel_name(&ch.name).to_string();
        let action = if existing.channels.contains_key(&canon) {
            PlanAction::Skip(SkipReason::AlreadyExists)
        } else {
            PlanAction::Create
        };
        steps.push(PlanStep {
            kind: StepKind::Channel,
            item: ch.id.clone(),
            action,
        });
        if ch.seed.is_some() {
            let item = seed_item(&ch.id);
            let action = if existing.items.contains_key(&(StepKind::Seed, item.clone())) {
                PlanAction::Skip(SkipReason::AlreadyExists)
            } else {
                PlanAction::Create
            };
            steps.push(PlanStep {
                kind: StepKind::Seed,
                item,
                action,
            });
        }
    }

    for s in &template.skills {
        let item = s.name.clone();
        let action = match existing.items.get(&(StepKind::Skill, item.clone())) {
            // Pin semantics: same recorded source ⇒ unchanged ⇒ skip without
            // any fetch. A changed source re-fetches and replaces (LWW).
            Some(found) if found.source.as_deref() == Some(s.source.as_str()) => {
                PlanAction::Skip(SkipReason::Unchanged)
            }
            _ => PlanAction::Create,
        };
        steps.push(PlanStep {
            kind: StepKind::Skill,
            item,
            action,
        });
    }

    for p in &template.personas {
        push_marker_step(&mut steps, StepKind::Persona, p.id.clone(), existing);
    }
    if let Some(org) = &template.org {
        // Root first (seats hang off it), then one vacant seat per persona,
        // then the default budget every agent falls under.
        push_org_step(
            &mut steps,
            "org:root".to_string(),
            existing.org_nodes.contains(ORG_ROOT_NODE_ID),
        );
        for seat in &org.seats {
            push_org_step(
                &mut steps,
                format!("org:seat:{}", seat.persona),
                existing.org_nodes.contains(&seat_node_id(&seat.persona)),
            );
        }
        if org.default_budget.is_some() {
            push_org_step(
                &mut steps,
                "org:budget".to_string(),
                existing.org_budgets.contains(ORG_DEFAULT_BUDGET_ID),
            );
        }
    }
    for w in &template.workflows {
        push_marker_step(&mut steps, StepKind::Workflow, w.file.clone(), existing);
    }
    for d in &template.docs {
        push_marker_step(&mut steps, StepKind::Doc, d.file.clone(), existing);
    }
    push_marker_step(
        &mut steps,
        StepKind::Welcome,
        "welcome".to_string(),
        existing,
    );

    steps
}

fn push_org_step(steps: &mut Vec<PlanStep>, item: String, exists: bool) {
    let action = if exists {
        PlanAction::Skip(SkipReason::AlreadyExists)
    } else {
        PlanAction::Create
    };
    steps.push(PlanStep {
        kind: StepKind::Org,
        item,
        action,
    });
}

fn push_marker_step(
    steps: &mut Vec<PlanStep>,
    kind: StepKind,
    item: String,
    existing: &ExistingState,
) {
    let action = if existing.items.contains_key(&(kind, item.clone())) {
        PlanAction::Skip(SkipReason::AlreadyExists)
    } else {
        PlanAction::Create
    };
    steps.push(PlanStep { kind, item, action });
}

// ── Reporting (pure) ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApplyStatus {
    /// Every plan step resolved (created or skipped).
    Ok,
    /// Execution stopped at a failed step; earlier steps resolved;
    /// `--resume` completes the remainder.
    Partial,
    /// Validation/resolution failed before any write; nothing was created.
    Failed,
}

impl ApplyStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Partial => "partial",
            Self::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StepStatus {
    Created,
    Skipped(SkipReason),
    Failed(String),
    NotAttempted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepOutcome {
    pub kind: StepKind,
    pub item: String,
    pub status: StepStatus,
    pub event_id: Option<String>,
    pub accepted: Option<bool>,
    pub message: Option<String>,
    pub channel_id: Option<String>,
}

impl StepOutcome {
    fn planned(step: &PlanStep, status: StepStatus) -> Self {
        Self {
            kind: step.kind,
            item: step.item.clone(),
            status,
            event_id: None,
            accepted: None,
            message: None,
            channel_id: None,
        }
    }
}

/// The welcome message captured for the UI's success state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WelcomeResult {
    pub channel_id: String,
    pub event_id: String,
    pub content: String,
}

/// The step a run stopped at. `step` is the step-kind label, or `"validate"`
/// for pre-write validation/resolution failures (nothing written).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FailedStep {
    pub step: String,
    pub item: String,
    pub error: String,
}

#[derive(Debug, Clone)]
pub struct ApplyReport {
    pub status: ApplyStatus,
    pub template_id: String,
    pub resumed: bool,
    pub steps: Vec<StepOutcome>,
    /// The step the run stopped at.
    pub failed_step: Option<FailedStep>,
    pub welcome: Option<WelcomeResult>,
}

/// Build the report from a run that executed the first `outcomes.len()` plan
/// steps and stopped. The unexecuted tail is reported as `not-attempted`, so
/// the report always enumerates the FULL plan — which steps completed, which
/// failed, and exactly what `--resume` will do. Pure and table-testable.
pub fn build_report(
    template_id: &str,
    resumed: bool,
    plan: &[PlanStep],
    outcomes: Vec<StepOutcome>,
    welcome: Option<WelcomeResult>,
) -> ApplyReport {
    debug_assert!(outcomes.len() <= plan.len());
    let mut steps = outcomes;
    let failed_step = steps.iter().find_map(|o| match &o.status {
        StepStatus::Failed(e) => Some(FailedStep {
            step: o.kind.as_str().to_string(),
            item: o.item.clone(),
            error: e.clone(),
        }),
        _ => None,
    });
    for step in plan.iter().skip(steps.len()) {
        steps.push(StepOutcome::planned(step, StepStatus::NotAttempted));
    }
    let status = if failed_step.is_some() {
        ApplyStatus::Partial
    } else {
        ApplyStatus::Ok
    };
    ApplyReport {
        status,
        template_id: template_id.to_string(),
        resumed,
        steps,
        failed_step,
        welcome,
    }
}

/// The report for a validation/resolution failure: nothing was written.
pub fn validation_failure_report(template_id: &str, resumed: bool, error: String) -> ApplyReport {
    ApplyReport {
        status: ApplyStatus::Failed,
        template_id: template_id.to_string(),
        resumed,
        steps: Vec::new(),
        failed_step: Some(FailedStep {
            step: "validate".to_string(),
            item: String::new(),
            error,
        }),
        welcome: None,
    }
}

/// Render the report as the normalized-style stdout JSON contract.
///
/// Actions: `created` | `skipped` (+`reason`) | `failed` (+`error`) |
/// `not-attempted`. Per-write fields (`event_id`, `accepted`, `message`) use
/// the relay's normalized write-response shape.
pub fn report_to_json(report: &ApplyReport) -> serde_json::Value {
    let steps: Vec<serde_json::Value> = report
        .steps
        .iter()
        .map(|o| {
            let mut v = serde_json::json!({
                "step": o.kind.as_str(),
                "item": o.item,
            });
            match &o.status {
                StepStatus::Created => v["action"] = serde_json::json!("created"),
                StepStatus::Skipped(reason) => {
                    v["action"] = serde_json::json!("skipped");
                    v["reason"] = serde_json::json!(reason.as_str());
                }
                StepStatus::Failed(e) => {
                    v["action"] = serde_json::json!("failed");
                    v["error"] = serde_json::json!(e);
                }
                StepStatus::NotAttempted => v["action"] = serde_json::json!("not-attempted"),
            }
            if let Some(id) = &o.event_id {
                v["event_id"] = serde_json::json!(id);
            }
            if let Some(a) = o.accepted {
                v["accepted"] = serde_json::json!(a);
            }
            if let Some(m) = &o.message {
                v["message"] = serde_json::json!(m);
            }
            if let Some(c) = &o.channel_id {
                v["channel_id"] = serde_json::json!(c);
            }
            v
        })
        .collect();

    let mut v = serde_json::json!({
        "status": report.status.as_str(),
        "template_id": report.template_id,
        "resumed": report.resumed,
        "steps": steps,
    });
    if let Some(f) = &report.failed_step {
        v["failed_step"] = serde_json::json!({
            "step": f.step,
            "item": f.item,
            "error": f.error,
        });
    }
    if let Some(w) = &report.welcome {
        v["welcome"] = serde_json::json!({
            "channel_id": w.channel_id,
            "event_id": w.event_id,
            "content": w.content,
        });
    }
    v
}

// ── Event bodies (pure) ────────────────────────────────────────────────────

/// kind:30180 content body. Field order is the wire contract (the `sha256`
/// pins the `content` bytes); `attachments` is the folder-growth extension
/// point (see `buzz_core::kind::KIND_SKILL`) and is always emitted, empty in v1.
#[derive(Debug, serde::Serialize)]
pub struct SkillEventBody {
    pub name: String,
    pub description: String,
    pub sha256: String,
    pub content: String,
    pub attachments: Vec<serde_json::Value>,
}

/// kind:30175 content body. Field order matches the NIP-AP reference vectors
/// (`display_name, system_prompt`) so content bytes — and therefore the event
/// id — interoperate with the desktop's persona publisher.
#[derive(Debug, serde::Serialize)]
pub struct PersonaEventBody {
    pub display_name: String,
    pub system_prompt: String,
}

// ── Execution (async, thin over BuzzClient) ────────────────────────────────

/// Resolve a skill's content: embedded file verbatim, or a bounded https fetch.
/// Returns the raw SKILL.md text.
async fn resolve_skill_content(
    skill: &TemplateSkill,
    files: &TemplateFiles,
) -> Result<String, String> {
    if skill.source.starts_with("https://") {
        fetch_skill_url(&skill.source).await
    } else {
        files
            .get(&skill.source)
            .map(str::to_string)
            .ok_or_else(|| format!("{}: referenced file does not exist", skill.source))
    }
}

/// Bounded, https-only SKILL.md fetch: 10s total timeout, hard 64 KiB cap
/// enforced while streaming (a hostile server cannot overrun the bound).
async fn fetch_skill_url(url: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(SKILL_FETCH_TIMEOUT)
        .build()
        .map_err(|e| format!("skill fetch client failed: {e}"))?;
    let mut resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("skill fetch failed for {url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "skill fetch failed for {url}: HTTP {}",
            resp.status()
        ));
    }
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("skill fetch failed for {url}: {e}"))?
    {
        if buf.len() + chunk.len() > SKILL_FETCH_MAX_BYTES {
            return Err(format!(
                "skill fetch for {url} exceeds {SKILL_FETCH_MAX_BYTES} bytes"
            ));
        }
        buf.extend_from_slice(&chunk);
    }
    String::from_utf8(buf).map_err(|_| format!("skill fetch for {url} is not UTF-8"))
}

/// Compute the sha256 pin of skill content bytes (lowercase hex).
pub fn sha256_hex(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    hex::encode(hasher.finalize())
}

/// Build the signed write for one step. Split from execution so the event
/// shapes are unit-testable without a relay.
pub(crate) fn build_step_event(
    template_id: &str,
    template: &Template,
    files: &TemplateFiles,
    step: &PlanStep,
    channel_ids: &BTreeMap<String, String>,
    prior_created_at: Option<u64>,
    resolved_skills: &BTreeMap<String, ResolvedSkill>,
) -> Result<EventBuilder, CliError> {
    let ts = Timestamp::from(next_created_at(prior_created_at));
    let marker = marker_tag(template_id, &step.item)?;
    match step.kind {
        StepKind::Channel => {
            let ch = template
                .channels
                .iter()
                .find(|c| c.id == step.item)
                .ok_or_else(|| CliError::Other("plan step has no channel".into()))?;
            // New communities default to open stream channels: the schema
            // contract carries no visibility/type fields, so the engine
            // default is fixed and documented.
            buzz_sdk::build_create_channel(
                uuid::Uuid::new_v4(),
                &ch.name,
                Some(buzz_sdk::Visibility::Open),
                Some(buzz_sdk::ChannelKind::Stream),
                Some(&ch.purpose),
                None,
            )
            .map_err(|e| CliError::Other(format!("build_create_channel failed: {e}")))
        }
        StepKind::Seed => {
            let channel_id = step.item.strip_prefix("seed:").unwrap_or(&step.item);
            let ch = template
                .channels
                .iter()
                .find(|c| c.id == channel_id)
                .ok_or_else(|| CliError::Other("plan step has no channel".into()))?;
            let content = ch
                .seed
                .as_deref()
                .and_then(|s| files.get(s))
                .ok_or_else(|| CliError::Other("seed content missing".into()))?;
            let channel_uuid = parse_channel_uuid(channel_ids, &ch.id)?;
            Ok(build_message_with_marker(channel_uuid, content, marker)?.custom_created_at(ts))
        }
        StepKind::Welcome => {
            let first = template
                .channels
                .first()
                .ok_or_else(|| CliError::Other("template has no channels".into()))?;
            let content = files
                .get(&template.welcome)
                .ok_or_else(|| CliError::Other("welcome content missing".into()))?;
            let channel_uuid = parse_channel_uuid(channel_ids, &first.id)?;
            Ok(build_message_with_marker(channel_uuid, content, marker)?.custom_created_at(ts))
        }
        StepKind::Skill => {
            let skill = template
                .skills
                .iter()
                .find(|s| s.name == step.item)
                .ok_or_else(|| CliError::Other("plan step has no skill".into()))?;
            let resolved = resolved_skills
                .get(&step.item)
                .ok_or_else(|| CliError::Other("skill content not resolved".into()))?;
            let body = SkillEventBody {
                // Canonical identity comes from the SKILL.md frontmatter
                // (the Agent Skills load key); `name`/`description` there win
                // over the template's stable item id.
                name: resolved.meta.name.clone(),
                description: resolved.meta.description.clone(),
                sha256: resolved.sha256.clone(),
                content: resolved.content.clone(),
                attachments: Vec::new(),
            };
            let content_json = serde_json::to_string(&body)
                .map_err(|e| CliError::Other(format!("skill body serialization failed: {e}")))?;
            let tags = vec![
                Tag::parse(["d", skill.name.as_str()])
                    .map_err(|e| CliError::Other(format!("invalid skill d-tag: {e}")))?,
                marker,
                Tag::parse(["sha256", resolved.sha256.as_str()])
                    .map_err(|e| CliError::Other(format!("invalid sha256 tag: {e}")))?,
                Tag::parse(["source", skill.source.as_str()])
                    .map_err(|e| CliError::Other(format!("invalid source tag: {e}")))?,
                Tag::parse(["applies_to", skill.applies_to.as_str()])
                    .map_err(|e| CliError::Other(format!("invalid applies_to tag: {e}")))?,
            ];
            Ok(EventBuilder::new(
                Kind::Custom(buzz_core::kind::KIND_SKILL as u16),
                content_json,
            )
            .tags(tags)
            .custom_created_at(ts))
        }
        StepKind::Persona => {
            let persona = template
                .personas
                .iter()
                .find(|p| p.id == step.item)
                .ok_or_else(|| CliError::Other("plan step has no persona".into()))?;
            let prompt = files
                .get(&persona.prompt)
                .ok_or_else(|| CliError::Other("persona prompt missing".into()))?;
            let body = PersonaEventBody {
                display_name: persona.name.clone(),
                system_prompt: prompt.to_string(),
            };
            let content_json = serde_json::to_string(&body)
                .map_err(|e| CliError::Other(format!("persona body serialization failed: {e}")))?;
            let mut tags = vec![Tag::parse(["d", persona.id.as_str()])
                .map_err(|e| CliError::Other(format!("invalid persona d-tag: {e}")))?];
            // Durable skill bindings for the injection worker: one
            // ["skill", "<skill-id>", "<applies_to>"] tag per skill this
            // persona inherits, scope recorded verbatim. A persona's
            // declarative `skills` override selects exactly those skills;
            // absent ⇒ every template skill (the historical default). The
            // schema validator rejects unknown ids — re-check here so a
            // hand-built template fails with a named error, not a silent gap.
            let bound: Vec<&TemplateSkill> =
                match &persona.skills {
                    Some(ids) => {
                        let mut out = Vec::with_capacity(ids.len());
                        for id in ids {
                            let skill = template.skills.iter().find(|s| &s.name == id).ok_or_else(
                                || {
                                    CliError::Other(format!(
                                        "persona '{}' declares unknown skill '{id}'",
                                        persona.id
                                    ))
                                },
                            )?;
                            out.push(skill);
                        }
                        out
                    }
                    None => template.skills.iter().collect(),
                };
            for s in bound {
                tags.push(
                    Tag::parse(["skill", s.name.as_str(), s.applies_to.as_str()])
                        .map_err(|e| CliError::Other(format!("invalid skill binding tag: {e}")))?,
                );
            }
            tags.push(marker);
            Ok(EventBuilder::new(
                Kind::Custom(buzz_core::kind::KIND_PERSONA as u16),
                content_json,
            )
            .tags(tags)
            .custom_created_at(ts))
        }
        StepKind::Workflow => {
            let w = template
                .workflows
                .iter()
                .find(|w| w.file == step.item)
                .ok_or_else(|| CliError::Other("plan step has no workflow".into()))?;
            let content = files
                .get(&w.file)
                .ok_or_else(|| CliError::Other("workflow content missing".into()))?;
            // Channel binding: the entry's declared `channel` id, else the
            // template's FIRST channel (the same rule `welcome` uses). The id
            // is validated by the schema validator; re-check it here so a
            // hand-built template fails with a named error instead of a
            // missing-map lookup.
            let channel_ref = match &w.channel {
                Some(id) => {
                    if !template.channels.iter().any(|c| &c.id == id) {
                        return Err(CliError::Other(format!(
                            "workflow '{}' declares channel '{id}' which is not a template channel",
                            w.file
                        )));
                    }
                    id.clone()
                }
                None => template
                    .channels
                    .first()
                    .ok_or_else(|| CliError::Other("template has no channels".into()))?
                    .id
                    .clone(),
            };
            let channel_uuid = parse_channel_uuid(channel_ids, &channel_ref)?;
            // The binding is the workflow definition's `h` tag: the relay only
            // evaluates this workflow against messages posted in that channel.
            let builder = buzz_sdk::build_workflow_def(channel_uuid, uuid::Uuid::new_v4(), content)
                .map_err(|e| CliError::Other(format!("build_workflow_def failed: {e}")))?;
            Ok(builder.tag(marker).custom_created_at(ts))
        }
        StepKind::Doc => {
            let d = template
                .docs
                .iter()
                .find(|d| d.file == step.item)
                .ok_or_else(|| CliError::Other("plan step has no doc".into()))?;
            let content = files
                .get(&d.file)
                .ok_or_else(|| CliError::Other("doc content missing".into()))?;
            let slug =
                doc_slug(&d.file).ok_or_else(|| CliError::Other("doc slug missing".into()))?;
            let now = ts.as_secs();
            let builder = crate::commands::notes::build_set_event(
                None,
                &slug,
                Some(d.title.as_str()),
                None,
                Some(&[]),
                content,
                now,
            )?;
            Ok(builder.tag(marker))
        }
        // Org steps need the signer's identity (the founder seat's holder):
        // they are built by `build_org_step_event`, which `execute_plan`
        // dispatches to. Reaching this arm is a programming error.
        StepKind::Org => Err(CliError::Other(
            "org steps are built by build_org_step_event".into(),
        )),
    }
}

/// Build the signed write for one `org` step: the founder root node, a vacant
/// agent seat, or the community default budget (see `schema.rs` module docs).
///
/// Split from [`build_step_event`] because the root's holder is the applying
/// identity, which the generic builder does not carry.
pub(crate) fn build_org_step_event(
    template_id: &str,
    template: &Template,
    step: &PlanStep,
    signer_hex: &str,
    prior_created_at: Option<u64>,
) -> Result<EventBuilder, CliError> {
    let org = template
        .org
        .as_ref()
        .ok_or_else(|| CliError::Other("plan step has an org item but no org block".into()))?;
    let ts = Timestamp::from(next_created_at(prior_created_at));
    let marker = marker_tag(template_id, &step.item)?;
    let sdk_err = |what: &str, e: buzz_sdk::SdkError| CliError::Other(format!("{what}: {e}"));

    if step.item == "org:root" {
        let content = OrgNodeContent {
            v: 1,
            name: org.root.name.clone(),
            node_kind: OrgNodeKind::Role,
            parent: None,
            holders: vec![signer_hex.to_string()],
            agent_seats: Vec::new(),
            scope: OrgScope {
                read_below: true,
                assign_below: true,
                can_grant: vec!["read".to_string(), "task".to_string()],
            },
            ui: org.root.blurb.clone().map(|blurb| OrgNodeUi {
                color: None,
                icon: None,
                blurb: Some(blurb),
            }),
            onchain: None,
        };
        let builder = buzz_sdk::build_org_node(ORG_ROOT_NODE_ID, &content)
            .map_err(|e| sdk_err("build_org_node (root) failed", e))?;
        return Ok(builder.tag(marker).custom_created_at(ts));
    }

    if let Some(persona_id) = step.item.strip_prefix("org:seat:") {
        let seat = org
            .seats
            .iter()
            .find(|s| s.persona == persona_id)
            .ok_or_else(|| CliError::Other(format!("no org seat for persona '{persona_id}'")))?;
        let persona = template
            .personas
            .iter()
            .find(|p| p.id == persona_id)
            .ok_or_else(|| {
                CliError::Other(format!("org seat names unknown persona '{persona_id}'"))
            })?;
        let content = OrgNodeContent {
            v: 1,
            name: seat.title.clone().unwrap_or_else(|| persona.name.clone()),
            node_kind: OrgNodeKind::AgentSeat,
            parent: Some(ORG_ROOT_NODE_ID.to_string()),
            // Vacant until a persona instance is attached to this seat.
            holders: Vec::new(),
            agent_seats: Vec::new(),
            scope: OrgScope::default(),
            ui: None,
            onchain: None,
        };
        let builder = buzz_sdk::build_org_node(&seat_node_id(persona_id), &content)
            .map_err(|e| sdk_err("build_org_node (seat) failed", e))?;
        return Ok(builder.tag(marker).custom_created_at(ts));
    }

    if step.item == "org:budget" {
        let b = org
            .default_budget
            .as_ref()
            .ok_or_else(|| CliError::Other("org:budget step but no default_budget".into()))?;
        let window = match b.window.as_deref().unwrap_or("day") {
            "epoch" => BudgetWindow::Epoch,
            "day" => BudgetWindow::Day,
            "week" => BudgetWindow::Week,
            "month" => BudgetWindow::Month,
            other => {
                return Err(CliError::Other(format!(
                    "default_budget.window '{other}' is not epoch|day|week|month"
                )))
            }
        };
        let content = OrgBudgetContent {
            v: 1,
            // "*" = the community default: applies to every agent that has no
            // budget of its own (owner-signed only; the relay enforces it).
            subject: "*".to_string(),
            window,
            limits: BudgetLimits {
                spend: None,
                runs: b.runs,
                tasks: b.tasks_create.map(|create| TaskLimits {
                    create: Some(create),
                    approve: None,
                }),
                governance: None,
                messages: b.messages,
                llm_calls: b.llm_calls,
                llm_cost_cents: None,
            },
            on_exceed: OnExceed::RequireApproval,
            onchain: None,
            performance_link: None,
        };
        let builder = buzz_sdk::build_org_budget(ORG_DEFAULT_BUDGET_ID, &content)
            .map_err(|e| sdk_err("build_org_budget failed", e))?;
        return Ok(builder.tag(marker).custom_created_at(ts));
    }

    Err(CliError::Other(format!(
        "unknown org step item '{}'",
        step.item
    )))
}

fn parse_channel_uuid(
    channel_ids: &BTreeMap<String, String>,
    item: &str,
) -> Result<uuid::Uuid, CliError> {
    let id = channel_ids
        .get(item)
        .ok_or_else(|| CliError::Other(format!("channel for '{item}' was not created")))?;
    uuid::Uuid::parse_str(id)
        .map_err(|e| CliError::Other(format!("invalid channel id for '{item}': {e}")))
}

fn build_message_with_marker(
    channel_uuid: uuid::Uuid,
    content: &str,
    marker: Tag,
) -> Result<EventBuilder, CliError> {
    let builder = buzz_sdk::build_message(channel_uuid, content, None, &[], false, &[], &[])
        .map_err(|e| CliError::Other(format!("build_message failed: {e}")))?;
    Ok(builder.tag(marker))
}

/// A skill whose content is resolved (fetched/embedded), validated, and pinned.
pub struct ResolvedSkill {
    pub content: String,
    pub meta: buzz_persona::skill::SkillMetadata,
    pub sha256: String,
}

/// Resolve + validate every skill the plan will create. https sources are
/// fetched here (bounded) — before any write — so a bad source fails the apply
/// with NOTHING written; skipped skills are never fetched (pin semantics).
pub async fn resolve_planned_skills(
    template: &Template,
    files: &TemplateFiles,
    plan: &[PlanStep],
) -> Result<BTreeMap<String, ResolvedSkill>, String> {
    let mut out = BTreeMap::new();
    for step in plan {
        if step.kind != StepKind::Skill || step.action != PlanAction::Create {
            continue;
        }
        let skill = template
            .skills
            .iter()
            .find(|s| s.name == step.item)
            .ok_or_else(|| format!("skill '{}' not in template", step.item))?;
        let content = resolve_skill_content(skill, files).await?;
        let meta = buzz_persona::skill::parse_skill_md(&content)
            .map_err(|e| format!("skills/{}: {e}", skill.name))?;
        let sha256 = sha256_hex(&content);
        out.insert(
            step.item.clone(),
            ResolvedSkill {
                content,
                meta,
                sha256,
            },
        );
    }
    Ok(out)
}

/// Gather what the relay already holds for this template: channels by
/// canonical name (kind:39000) and marker-tagged items (signer-scoped).
pub async fn query_existing_state(
    client: &BuzzClient,
    template_id: &str,
) -> Result<ExistingState, CliError> {
    let me = client.keys().public_key().to_hex();
    let mut state = ExistingState::default();

    let channels_raw = client
        .query(&serde_json::json!({ "kinds": [39000], "limit": 500 }))
        .await?;
    let channel_events: Vec<serde_json::Value> =
        serde_json::from_str(&channels_raw).unwrap_or_default();
    for e in &channel_events {
        let name = extract_tag_value(e, "name");
        if name.is_empty() {
            continue;
        }
        let canon = buzz_core::channel::canonical_channel_name(&name).to_string();
        state.channels.insert(canon, extract_d_tag(e));
    }

    let marker_filters = [
        serde_json::json!({ "kinds": [30175], "authors": [me], "#t": [template_id], "limit": 200 }),
        serde_json::json!({ "kinds": [buzz_core::kind::KIND_SKILL], "authors": [me], "#t": [template_id], "limit": 200 }),
        serde_json::json!({ "kinds": [30620], "authors": [me], "#t": [template_id], "limit": 200 }),
        serde_json::json!({ "kinds": [30023], "authors": [me], "#t": [template_id], "limit": 200 }),
        serde_json::json!({ "kinds": [9], "authors": [me], "#t": [template_id], "limit": 200 }),
    ];
    // The signer's own org nodes and budgets, by `d` — org steps dedup on
    // these so a hand-built org is never overwritten (NIP-33 replacement is
    // per author + d, so a re-publish would silently replace it).
    let org_filters = [
        serde_json::json!({ "kinds": [buzz_core::kind::KIND_ORG_NODE], "authors": [me], "limit": 500 }),
        serde_json::json!({ "kinds": [buzz_core::kind::KIND_ORG_BUDGET], "authors": [me], "limit": 500 }),
    ];
    let org_raw = client.query_multi(&org_filters).await?;
    let org_events: Vec<serde_json::Value> = serde_json::from_str(&org_raw).unwrap_or_default();
    for e in &org_events {
        let d = extract_d_tag(e);
        if d.is_empty() {
            continue;
        }
        match e.get("kind").and_then(|v| v.as_u64()).unwrap_or(0) {
            k if k == buzz_core::kind::KIND_ORG_NODE as u64 => {
                state.org_nodes.insert(d);
            }
            k if k == buzz_core::kind::KIND_ORG_BUDGET as u64 => {
                state.org_budgets.insert(d);
            }
            _ => {}
        }
    }

    let raw = client.query_multi(&marker_filters).await?;
    let events: Vec<serde_json::Value> = serde_json::from_str(&raw).unwrap_or_default();
    for e in &events {
        let kind = e.get("kind").and_then(|v| v.as_u64()).unwrap_or(0);
        let step_kind = match kind {
            30175 => StepKind::Persona,
            30620 => StepKind::Workflow,
            30023 => StepKind::Doc,
            9 => StepKind::Seed, // narrowed to Seed/Welcome by marker item below
            k if k == buzz_core::kind::KIND_SKILL as u64 => StepKind::Skill,
            _ => continue,
        };
        // Marker = ["t", <template-id>, <item-id>]; the query matched
        // tag[1] == template-id, so the item is tag[2].
        let Some(item) = marker_item(e, template_id) else {
            continue;
        };
        let step_kind = if step_kind == StepKind::Seed && item == "welcome" {
            StepKind::Welcome
        } else {
            step_kind
        };
        state.items.insert(
            (step_kind, item),
            ExistingItem {
                event_id: e
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                created_at: e.get("created_at").and_then(|v| v.as_u64()).unwrap_or(0),
                source: (step_kind == StepKind::Skill).then(|| extract_tag_value(e, "source")),
                sha256: (step_kind == StepKind::Skill).then(|| extract_tag_value(e, "sha256")),
            },
        );
    }
    Ok(state)
}

/// The marker item id (tag[2]) of this event's `["t", template-id, item]` tag.
fn marker_item(event: &serde_json::Value, template_id: &str) -> Option<String> {
    event
        .get("tags")
        .and_then(|t| t.as_array())
        .and_then(|tags| {
            tags.iter().find_map(|tag| {
                let a = tag.as_array()?;
                if a.first().and_then(|v| v.as_str()) == Some("t")
                    && a.get(1).and_then(|v| v.as_str()) == Some(template_id)
                {
                    a.get(2).and_then(|v| v.as_str()).map(str::to_string)
                } else {
                    None
                }
            })
        })
}

/// Execute the plan in order, stopping at the first failure. Skipped steps
/// resolve without I/O; created steps sign + submit one event each.
#[allow(clippy::too_many_arguments)] // plan + context; same shape as channels.rs::build_template_report
pub async fn execute_plan(
    client: &BuzzClient,
    template_id: &str,
    template: &Template,
    files: &TemplateFiles,
    plan: &[PlanStep],
    existing: &ExistingState,
    resumed: bool,
    resolved_skills: BTreeMap<String, ResolvedSkill>,
) -> ApplyReport {
    let mut outcomes: Vec<StepOutcome> = Vec::new();
    let mut channel_ids: BTreeMap<String, String> = existing.channels.clone();
    // Map template channel ids → ids of channels that already existed.
    for ch in &template.channels {
        let canon = buzz_core::channel::canonical_channel_name(&ch.name).to_string();
        if let Some(id) = existing.channels.get(&canon) {
            channel_ids.insert(ch.id.clone(), id.clone());
        }
    }
    let mut welcome: Option<WelcomeResult> = None;
    let signer_hex = client.keys().public_key().to_hex();

    for step in plan {
        match step.action {
            PlanAction::Skip(reason) => {
                outcomes.push(StepOutcome::planned(step, StepStatus::Skipped(reason)));
                continue;
            }
            PlanAction::Create => {}
        }

        let prior = existing
            .items
            .get(&(step.kind, step.item.clone()))
            .map(|i| i.created_at);
        let built = if step.kind == StepKind::Org {
            build_org_step_event(template_id, template, step, &signer_hex, prior)
        } else {
            build_step_event(
                template_id,
                template,
                files,
                step,
                &channel_ids,
                prior,
                &resolved_skills,
            )
        };
        let builder = match built {
            Ok(b) => b,
            Err(e) => {
                outcomes.push(StepOutcome::planned(
                    step,
                    StepStatus::Failed(e.to_string()),
                ));
                break;
            }
        };
        let event = match client.sign_event(builder) {
            Ok(e) => e,
            Err(e) => {
                outcomes.push(StepOutcome::planned(
                    step,
                    StepStatus::Failed(e.to_string()),
                ));
                break;
            }
        };
        let event_id = event.id.to_hex();
        let created_channel_id = (step.kind == StepKind::Channel).then(|| extract_h_tag(&event));
        match client.submit_event(event).await {
            Ok(resp) => {
                let normalized: serde_json::Value = serde_json::from_str(
                    &normalize_write_response(&resp),
                )
                .unwrap_or_else(|_| serde_json::json!({ "accepted": false, "message": resp }));
                let accepted = normalized
                    .get("accepted")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let message = normalized
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if !accepted {
                    outcomes.push(StepOutcome {
                        kind: step.kind,
                        item: step.item.clone(),
                        status: StepStatus::Failed(format!("relay rejected the event: {message}")),
                        event_id: Some(event_id),
                        accepted: Some(false),
                        message: Some(message),
                        channel_id: None,
                    });
                    break;
                }
                let mut outcome = StepOutcome {
                    kind: step.kind,
                    item: step.item.clone(),
                    status: StepStatus::Created,
                    event_id: Some(event_id),
                    accepted: Some(true),
                    message: Some(message),
                    channel_id: None,
                };
                if let Some(generated) = created_channel_id {
                    // Channels carry their generated UUID in the `h` tag of
                    // the create event — the same id the relay scopes by.
                    channel_ids.insert(step.item.clone(), generated.clone());
                    outcome.channel_id = Some(generated);
                }
                if step.kind == StepKind::Welcome {
                    let content = files.get(&template.welcome).unwrap_or("").to_string();
                    let first = template
                        .channels
                        .first()
                        .map(|c| c.id.clone())
                        .unwrap_or_default();
                    welcome = Some(WelcomeResult {
                        channel_id: channel_ids.get(&first).cloned().unwrap_or_default(),
                        event_id: outcome.event_id.clone().unwrap_or_default(),
                        content,
                    });
                }
                outcomes.push(outcome);
            }
            Err(e) => {
                outcomes.push(StepOutcome::planned(
                    step,
                    StepStatus::Failed(e.to_string()),
                ));
                break;
            }
        }
    }

    build_report(template_id, resumed, plan, outcomes, welcome)
}

fn extract_h_tag(event: &nostr::Event) -> String {
    event
        .tags
        .iter()
        .find(|t| t.as_slice().first().map(|s| s.as_str()) == Some("h"))
        .and_then(|t| t.as_slice().get(1).map(|s| s.to_string()))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::templates::schema::{
        SkillScope, Template, TemplateChannel, TemplateDefaultBudget, TemplateDoc, TemplateFiles,
        TemplateOrg, TemplateOrgRoot, TemplateOrgSeat, TemplatePersona, TemplateSkill,
        TemplateWorkflow,
    };

    fn template() -> Template {
        Template {
            id: "demo-template".into(),
            name: "Demo".into(),
            description: "A demo".into(),
            channels: vec![
                TemplateChannel {
                    id: "general".into(),
                    name: "general".into(),
                    purpose: "chat".into(),
                    seed: Some("seeds/general.md".into()),
                },
                TemplateChannel {
                    id: "random".into(),
                    name: "random".into(),
                    purpose: "off-topic".into(),
                    seed: None,
                },
            ],
            personas: vec![TemplatePersona {
                id: "writer".into(),
                name: "The Writer".into(),
                prompt: "personas/writer.md".into(),
                skills: None,
            }],
            workflows: vec![TemplateWorkflow {
                file: "workflows/w.yaml".into(),
                channel: None,
            }],
            docs: vec![TemplateDoc {
                file: "docs/story-bible.md".into(),
                title: "Story Bible".into(),
            }],
            skills: vec![TemplateSkill {
                name: "prompt-craft".into(),
                source: "https://example.com/SKILL.md".into(),
                applies_to: SkillScope::All,
            }],
            org: None,
            welcome: "welcome.md".into(),
        }
    }

    fn files() -> TemplateFiles {
        TemplateFiles::from_pairs(
            [
                ("seeds/general.md", "seed"),
                ("personas/writer.md", "prompt"),
                ("workflows/w.yaml", "yaml"),
                ("docs/story-bible.md", "doc"),
                ("welcome.md", "welcome"),
            ]
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string())),
        )
    }

    fn items(
        pairs: &[((StepKind, &str), &str, Option<&str>)],
    ) -> BTreeMap<(StepKind, String), ExistingItem> {
        pairs
            .iter()
            .map(|((k, item), id, source)| {
                (
                    (*k, item.to_string()),
                    ExistingItem {
                        event_id: id.to_string(),
                        created_at: 0,
                        source: source.map(str::to_string),
                        sha256: None,
                    },
                )
            })
            .collect()
    }

    #[test]
    fn fresh_community_plans_everything_in_order() {
        let plan = plan_apply(&template(), &ExistingState::default());
        let kinds: Vec<(StepKind, &str, PlanAction)> = plan
            .iter()
            .map(|s| (s.kind, s.item.as_str(), s.action))
            .collect();
        assert_eq!(
            kinds,
            vec![
                (StepKind::Channel, "general", PlanAction::Create),
                (StepKind::Seed, "seed:general", PlanAction::Create),
                (StepKind::Channel, "random", PlanAction::Create),
                (StepKind::Skill, "prompt-craft", PlanAction::Create),
                (StepKind::Persona, "writer", PlanAction::Create),
                (StepKind::Workflow, "workflows/w.yaml", PlanAction::Create),
                (StepKind::Doc, "docs/story-bible.md", PlanAction::Create),
                (StepKind::Welcome, "welcome", PlanAction::Create),
            ]
        );
    }

    #[test]
    fn existing_channel_skips_by_name_and_seed_dedups_by_marker() {
        let mut existing = ExistingState {
            items: items(&[((StepKind::Seed, "seed:general"), "ev-seed", None)]),
            ..Default::default()
        };
        existing
            .channels
            .insert("general".to_string(), "uuid-1".to_string());
        let plan = plan_apply(&template(), &existing);
        assert_eq!(plan[0].action, PlanAction::Skip(SkipReason::AlreadyExists));
        assert_eq!(plan[1].action, PlanAction::Skip(SkipReason::AlreadyExists));
        // The second channel still plans.
        assert_eq!(plan[2].action, PlanAction::Create);
    }

    #[test]
    fn marker_items_skip_and_skill_source_pin_skips_without_refetch() {
        let existing = ExistingState {
            items: items(&[
                (
                    (StepKind::Skill, "prompt-craft"),
                    "ev-skill",
                    Some("https://example.com/SKILL.md"),
                ),
                ((StepKind::Persona, "writer"), "ev-p", None),
                ((StepKind::Workflow, "workflows/w.yaml"), "ev-w", None),
                ((StepKind::Doc, "docs/story-bible.md"), "ev-d", None),
                ((StepKind::Welcome, "welcome"), "ev-welcome", None),
            ]),
            ..Default::default()
        };
        let plan = plan_apply(&template(), &existing);
        let by_item: BTreeMap<&str, PlanAction> =
            plan.iter().map(|s| (s.item.as_str(), s.action)).collect();
        assert_eq!(
            by_item["prompt-craft"],
            PlanAction::Skip(SkipReason::Unchanged)
        );
        assert_eq!(
            by_item["writer"],
            PlanAction::Skip(SkipReason::AlreadyExists)
        );
        assert_eq!(
            by_item["workflows/w.yaml"],
            PlanAction::Skip(SkipReason::AlreadyExists)
        );
        assert_eq!(
            by_item["docs/story-bible.md"],
            PlanAction::Skip(SkipReason::AlreadyExists)
        );
        assert_eq!(
            by_item["welcome"],
            PlanAction::Skip(SkipReason::AlreadyExists)
        );
    }

    #[test]
    fn skill_source_change_replans_create() {
        let existing = ExistingState {
            items: items(&[(
                (StepKind::Skill, "prompt-craft"),
                "ev",
                Some("https://other/SKILL.md"),
            )]),
            ..Default::default()
        };
        let plan = plan_apply(&template(), &existing);
        let skill = plan.iter().find(|s| s.kind == StepKind::Skill).unwrap();
        assert_eq!(skill.action, PlanAction::Create);
    }

    #[test]
    fn build_report_fills_not_attempted_tail_and_marks_failure() {
        let plan = plan_apply(&template(), &ExistingState::default());
        let outcomes = vec![
            StepOutcome::planned(&plan[0], StepStatus::Created),
            StepOutcome::planned(&plan[1], StepStatus::Failed("relay down".into())),
        ];
        let report = build_report("demo-template", false, &plan, outcomes, None);
        assert_eq!(report.status, ApplyStatus::Partial);
        assert_eq!(
            report.failed_step,
            Some(FailedStep {
                step: "seed".to_string(),
                item: "seed:general".to_string(),
                error: "relay down".to_string(),
            })
        );
        assert_eq!(report.steps.len(), plan.len());
        assert!(matches!(report.steps[1].status, StepStatus::Failed(_)));
        for s in &report.steps[2..] {
            assert_eq!(s.status, StepStatus::NotAttempted);
        }
    }

    #[test]
    fn build_report_all_created_is_ok() {
        let plan = plan_apply(&template(), &ExistingState::default());
        let outcomes: Vec<StepOutcome> = plan
            .iter()
            .map(|s| StepOutcome::planned(s, StepStatus::Created))
            .collect();
        let report = build_report("demo-template", true, &plan, outcomes, None);
        assert_eq!(report.status, ApplyStatus::Ok);
        assert!(report.failed_step.is_none());
        assert!(report.resumed);
    }

    #[test]
    fn resume_after_failure_plans_only_the_remainder() {
        // First run: channel + seed created, then failure at the skill step.
        let mut existing = ExistingState {
            items: items(&[((StepKind::Seed, "seed:general"), "ev-seed", None)]),
            ..Default::default()
        };
        existing
            .channels
            .insert("general".to_string(), "uuid-1".to_string());
        let plan = plan_apply(&template(), &existing);
        assert_eq!(plan[0].action, PlanAction::Skip(SkipReason::AlreadyExists));
        assert_eq!(plan[1].action, PlanAction::Skip(SkipReason::AlreadyExists));
        assert_eq!(plan[2].action, PlanAction::Create); // random
                                                        // The resume run re-plans from the durable relay state: everything
                                                        // the first run created is skipped, the remainder is created.
        let outcomes: Vec<StepOutcome> = plan
            .iter()
            .map(|s| StepOutcome::planned(s, StepStatus::Created))
            .collect();
        let report = build_report("demo-template", true, &plan, outcomes, None);
        assert_eq!(report.status, ApplyStatus::Ok);
    }

    #[test]
    fn report_json_shape_is_the_normalized_contract() {
        let plan = plan_apply(&template(), &ExistingState::default());
        let outcomes = vec![
            StepOutcome {
                kind: StepKind::Channel,
                item: "general".into(),
                status: StepStatus::Created,
                event_id: Some("ev1".into()),
                accepted: Some(true),
                message: Some("ok".into()),
                channel_id: Some("uuid-1".into()),
            },
            StepOutcome::planned(&plan[1], StepStatus::Skipped(SkipReason::AlreadyExists)),
            StepOutcome::planned(&plan[2], StepStatus::Failed("boom".into())),
        ];
        let report = build_report("demo-template", false, &plan, outcomes, None);
        let v = report_to_json(&report);
        assert_eq!(v["status"], "partial");
        assert_eq!(v["template_id"], "demo-template");
        assert_eq!(v["resumed"], false);
        assert_eq!(v["steps"][0]["action"], "created");
        assert_eq!(v["steps"][0]["event_id"], "ev1");
        assert_eq!(v["steps"][0]["accepted"], true);
        assert_eq!(v["steps"][0]["message"], "ok");
        assert_eq!(v["steps"][0]["channel_id"], "uuid-1");
        assert_eq!(v["steps"][1]["action"], "skipped");
        assert_eq!(v["steps"][1]["reason"], "already-exists");
        assert_eq!(v["steps"][2]["action"], "failed");
        assert_eq!(v["steps"][2]["error"], "boom");
        assert_eq!(v["steps"][3]["action"], "not-attempted");
        assert_eq!(v["failed_step"]["step"], "channel");
        assert_eq!(v["failed_step"]["item"], "random");
        assert_eq!(v["failed_step"]["error"], "boom");
        assert!(v.get("welcome").is_none());
    }

    #[test]
    fn validation_failure_report_shape() {
        let v = report_to_json(&validation_failure_report(
            "demo-template",
            true,
            "skill is missing frontmatter name/description".into(),
        ));
        assert_eq!(v["status"], "failed");
        assert_eq!(v["resumed"], true);
        assert_eq!(v["steps"], serde_json::json!([]));
        assert_eq!(v["failed_step"]["step"], "validate");
        assert_eq!(
            v["failed_step"]["error"],
            "skill is missing frontmatter name/description"
        );
    }

    #[test]
    fn marker_and_next_created_at_helpers() {
        let tag = marker_tag("demo-template", "writer").unwrap();
        assert_eq!(tag.as_slice(), &["t", "demo-template", "writer"]);
        assert!(next_created_at(Some(100)) >= 101);
        assert_eq!(seed_item("general"), "seed:general");
    }

    #[test]
    fn skill_body_shape_carries_name_sha256_content_and_attachments() {
        let body = SkillEventBody {
            name: "prompt-craft".into(),
            description: "Crafting prompts".into(),
            sha256: "ab".into(),
            content: "---\nname: prompt-craft\n---\nbody".into(),
            attachments: Vec::new(),
        };
        let v = serde_json::to_value(&body).unwrap();
        assert_eq!(v["name"], "prompt-craft");
        assert_eq!(v["sha256"], "ab");
        assert!(v["content"].as_str().unwrap().contains("body"));
        assert_eq!(v["attachments"], serde_json::json!([]));
    }

    #[test]
    fn persona_body_field_order_matches_nip_ap_vectors() {
        let body = PersonaEventBody {
            display_name: "The Writer".into(),
            system_prompt: "Write.".into(),
        };
        let json = serde_json::to_string(&body).unwrap();
        assert!(json.starts_with(r#"{"display_name":"The Writer","system_prompt":"Write."}"#));
    }

    #[test]
    fn sha256_pin_is_stable() {
        assert_eq!(
            sha256_hex(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn planned_skill_events_carry_marker_and_bindings() {
        let template = template();
        let files = files();
        let plan = plan_apply(&template, &ExistingState::default());
        let step = plan.iter().find(|s| s.kind == StepKind::Skill).unwrap();
        let mut resolved = BTreeMap::new();
        resolved.insert(
            "prompt-craft".to_string(),
            ResolvedSkill {
                content: "---\nname: prompt-craft\ndescription: d\n---\nbody".into(),
                meta: buzz_persona::skill::parse_skill_md(
                    "---\nname: prompt-craft\ndescription: d\n---\nbody",
                )
                .unwrap(),
                sha256: sha256_hex("x"),
            },
        );
        let builder = build_step_event(
            "demo-template",
            &template,
            &files,
            step,
            &BTreeMap::new(),
            None,
            &resolved,
        )
        .unwrap();
        let keys = nostr::Keys::generate();
        let event = builder.sign_with_keys(&keys).unwrap();
        assert_eq!(event.kind.as_u16() as u32, buzz_core::kind::KIND_SKILL);
        let tags: Vec<String> = event
            .tags
            .iter()
            .map(|t| {
                t.as_slice()
                    .iter()
                    .map(|s| s.to_string())
                    .collect::<Vec<_>>()
                    .join("|")
            })
            .collect();
        assert!(tags.contains(&"d|prompt-craft".to_string()));
        assert!(tags.contains(&"t|demo-template|prompt-craft".to_string()));
        assert!(tags.contains(&format!("sha256|{}", sha256_hex("x"))));
        assert!(tags.contains(&"source|https://example.com/SKILL.md".to_string()));
        assert!(tags.contains(&"applies_to|all".to_string()));
    }

    #[test]
    fn planned_persona_events_carry_skill_bindings_and_marker() {
        let template = template();
        let files = files();
        let plan = plan_apply(&template, &ExistingState::default());
        let step = plan.iter().find(|s| s.kind == StepKind::Persona).unwrap();
        let builder = build_step_event(
            "demo-template",
            &template,
            &files,
            step,
            &BTreeMap::new(),
            None,
            &BTreeMap::new(),
        )
        .unwrap();
        let keys = nostr::Keys::generate();
        let event = builder.sign_with_keys(&keys).unwrap();
        assert_eq!(event.kind.as_u16() as u32, buzz_core::kind::KIND_PERSONA);
        let tags: Vec<String> = event
            .tags
            .iter()
            .map(|t| {
                t.as_slice()
                    .iter()
                    .map(|s| s.to_string())
                    .collect::<Vec<_>>()
                    .join("|")
            })
            .collect();
        assert!(tags.contains(&"d|writer".to_string()));
        assert!(tags.contains(&"skill|prompt-craft|all".to_string()));
        assert!(tags.contains(&"t|demo-template|writer".to_string()));
    }

    /// The workflow channel binding — the production seam is
    /// `build_step_event` → `buzz_sdk::build_workflow_def`, whose `h` tag is
    /// the channel the relay evaluates the trigger against. An entry with no
    /// declared `channel` keeps the historical `channels[0]` binding; a
    /// declared id binds that channel.
    #[test]
    fn workflow_binding_uses_declared_channel_and_defaults_to_first() {
        let mut template = template();
        template.workflows.push(TemplateWorkflow {
            file: "workflows/w2.yaml".into(),
            channel: Some("random".into()),
        });
        let files = TemplateFiles::from_pairs(
            [
                ("seeds/general.md", "seed"),
                ("personas/writer.md", "prompt"),
                ("workflows/w.yaml", "yaml-1"),
                ("workflows/w2.yaml", "yaml-2"),
                ("docs/story-bible.md", "doc"),
                ("welcome.md", "welcome"),
            ]
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string())),
        );
        let general = "11111111-1111-1111-1111-111111111111";
        let random = "22222222-2222-2222-2222-222222222222";
        let mut channel_ids = BTreeMap::new();
        channel_ids.insert("general".to_string(), general.to_string());
        channel_ids.insert("random".to_string(), random.to_string());

        let plan = plan_apply(&template, &ExistingState::default());
        let keys = nostr::Keys::generate();
        let mut bound: Vec<(String, String)> = Vec::new();
        for step in plan.iter().filter(|s| s.kind == StepKind::Workflow) {
            let builder = build_step_event(
                "demo-template",
                &template,
                &files,
                step,
                &channel_ids,
                None,
                &BTreeMap::new(),
            )
            .unwrap();
            let event = builder.sign_with_keys(&keys).unwrap();
            bound.push((step.item.clone(), extract_h_tag(&event)));
        }
        assert_eq!(
            bound,
            vec![
                // no `channel` → channels[0] (general): the old default
                ("workflows/w.yaml".to_string(), general.to_string()),
                // declared `channel: random` → the declared channel
                ("workflows/w2.yaml".to_string(), random.to_string()),
            ]
        );
    }

    /// Defense in depth: a channel id that is not a declared template channel
    /// fails with a named error instead of a map-lookup miss (the schema
    /// validator already rejects it).
    #[test]
    fn workflow_declaring_an_undeclared_channel_fails_with_a_named_error() {
        let mut template = template();
        template.workflows[0].channel = Some("nope".into());
        let plan = plan_apply(&template, &ExistingState::default());
        let step = plan.iter().find(|s| s.kind == StepKind::Workflow).unwrap();
        let err = build_step_event(
            "demo-template",
            &template,
            &files(),
            step,
            &BTreeMap::new(),
            None,
            &BTreeMap::new(),
        )
        .unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("declares channel 'nope' which is not a template channel"),
            "{msg}"
        );
    }

    /// `personas[].skills` at the production seam (`build_step_event` →
    /// kind:30175 persona event tags): a declared override binds exactly the
    /// named skills — `applies_to` stops being cosmetic — while a persona
    /// without the field keeps the historical bind-every-skill set (asserted
    /// by `planned_persona_events_carry_skill_bindings_and_marker`).
    #[test]
    fn persona_skills_override_binds_only_declared_skills() {
        let mut template = template();
        template.skills.push(TemplateSkill {
            name: "extra".into(),
            source: "https://example.com/extra/SKILL.md".into(),
            applies_to: SkillScope::Developers,
        });
        template.personas[0].skills = Some(vec!["extra".into()]);
        let plan = plan_apply(&template, &ExistingState::default());
        let step = plan.iter().find(|s| s.kind == StepKind::Persona).unwrap();
        let builder = build_step_event(
            "demo-template",
            &template,
            &files(),
            step,
            &BTreeMap::new(),
            None,
            &BTreeMap::new(),
        )
        .unwrap();
        let keys = nostr::Keys::generate();
        let event = builder.sign_with_keys(&keys).unwrap();
        let skill_tags: Vec<Vec<String>> = event
            .tags
            .iter()
            .filter(|t| t.as_slice().first().map(String::as_str) == Some("skill"))
            .map(|t| t.as_slice().iter().map(String::to_string).collect())
            .collect();
        assert_eq!(
            skill_tags,
            vec![vec![
                "skill".to_string(),
                "extra".to_string(),
                "developers".to_string()
            ]],
            "override must bind exactly the declared skill; the unbound \
             skill ('prompt-craft') must not appear"
        );
    }

    /// Defense in depth: an unknown skill id in a persona's override fails
    /// with a named error instead of silently dropping the binding (the schema
    /// validator already rejects it).
    #[test]
    fn persona_declaring_an_unknown_skill_fails_with_a_named_error() {
        let mut template = template();
        template.personas[0].skills = Some(vec!["nope".into()]);
        let plan = plan_apply(&template, &ExistingState::default());
        let step = plan.iter().find(|s| s.kind == StepKind::Persona).unwrap();
        let err = build_step_event(
            "demo-template",
            &template,
            &files(),
            step,
            &BTreeMap::new(),
            None,
            &BTreeMap::new(),
        )
        .unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("persona 'writer' declares unknown skill 'nope'"),
            "{msg}"
        );
    }

    // ---- org block: founder seat, vacant agent seats, default budget ----

    fn org_template() -> Template {
        let mut t = template();
        t.org = Some(TemplateOrg {
            root: TemplateOrgRoot {
                name: "Studio".into(),
                blurb: Some("The founders".into()),
            },
            seats: vec![TemplateOrgSeat {
                persona: "writer".into(),
                title: Some("Head of Story".into()),
            }],
            default_budget: Some(TemplateDefaultBudget {
                window: Some("week".into()),
                runs: Some(200),
                tasks_create: Some(20),
                messages: Some(300),
                llm_calls: None,
            }),
        });
        t
    }

    fn org_step(plan: &[PlanStep], item: &str) -> PlanStep {
        plan.iter()
            .find(|s| s.kind == StepKind::Org && s.item == item)
            .unwrap_or_else(|| panic!("no org step {item}"))
            .clone()
    }

    fn signed(builder: EventBuilder, keys: &nostr::Keys) -> nostr::Event {
        builder.sign_with_keys(keys).unwrap()
    }

    fn first_tag(event: &nostr::Event, name: &str) -> Option<Vec<String>> {
        event
            .tags
            .iter()
            .map(|t| {
                t.as_slice()
                    .iter()
                    .map(String::to_string)
                    .collect::<Vec<_>>()
            })
            .find(|t| t.first().map(String::as_str) == Some(name))
    }

    #[test]
    fn org_block_plans_root_then_seats_then_budget_after_the_personas() {
        let plan = plan_apply(&org_template(), &ExistingState::default());
        let order: Vec<(StepKind, &str)> = plan.iter().map(|s| (s.kind, s.item.as_str())).collect();
        let persona_at = order
            .iter()
            .position(|(k, _)| *k == StepKind::Persona)
            .unwrap();
        assert_eq!(
            &order[persona_at + 1..persona_at + 4],
            &[
                (StepKind::Org, "org:root"),
                (StepKind::Org, "org:seat:writer"),
                (StepKind::Org, "org:budget"),
            ],
            "root before its seats, budget last, all after the personas"
        );
        assert!(plan
            .iter()
            .filter(|s| s.kind == StepKind::Org)
            .all(|s| s.action == PlanAction::Create));
    }

    #[test]
    fn a_template_without_an_org_block_plans_no_org_steps() {
        let plan = plan_apply(&template(), &ExistingState::default());
        assert!(plan.iter().all(|s| s.kind != StepKind::Org));
    }

    /// The safety property: NIP-33 replacement is per author + `d`, so a
    /// re-publish would silently overwrite an org the user built by hand.
    /// Org steps therefore dedup on the signer's own node/budget `d` tags.
    #[test]
    fn existing_org_nodes_and_budgets_are_never_overwritten() {
        let mut existing = ExistingState::default();
        existing.org_nodes.insert("root".into());
        existing.org_nodes.insert("seat-writer".into());
        existing.org_budgets.insert("default-agents".into());
        let plan = plan_apply(&org_template(), &existing);
        for s in plan.iter().filter(|s| s.kind == StepKind::Org) {
            assert_eq!(
                s.action,
                PlanAction::Skip(SkipReason::AlreadyExists),
                "{s:?}"
            );
        }
        // A partial org (root present, seat and budget missing) plans only the rest.
        let mut partial = ExistingState::default();
        partial.org_nodes.insert("root".into());
        let plan = plan_apply(&org_template(), &partial);
        assert_eq!(
            org_step(&plan, "org:root").action,
            PlanAction::Skip(SkipReason::AlreadyExists)
        );
        assert_eq!(
            org_step(&plan, "org:seat:writer").action,
            PlanAction::Create
        );
        assert_eq!(org_step(&plan, "org:budget").action, PlanAction::Create);
    }

    #[test]
    fn org_root_is_a_role_node_held_by_the_signer() {
        let t = org_template();
        let plan = plan_apply(&t, &ExistingState::default());
        let keys = nostr::Keys::generate();
        let me = keys.public_key().to_hex();
        let event = signed(
            build_org_step_event("demo-template", &t, &org_step(&plan, "org:root"), &me, None)
                .unwrap(),
            &keys,
        );
        assert_eq!(event.kind.as_u16() as u32, buzz_core::kind::KIND_ORG_NODE);
        assert_eq!(first_tag(&event, "d").unwrap()[1], "root");
        assert_eq!(
            first_tag(&event, "t").unwrap(),
            vec!["t", "demo-template", "org:root"]
        );
        let body: serde_json::Value = serde_json::from_str(&event.content).unwrap();
        assert_eq!(body["name"], "Studio");
        assert_eq!(body["kind"], "role");
        assert_eq!(body["holders"], serde_json::json!([me]));
        assert!(body.get("parent").is_none(), "a root has no parent");
        assert_eq!(
            body["scope"]["canGrant"],
            serde_json::json!(["read", "task"])
        );
        assert_eq!(body["ui"]["blurb"], "The founders");
    }

    #[test]
    fn org_seat_is_a_vacant_agent_seat_under_the_root() {
        let t = org_template();
        let plan = plan_apply(&t, &ExistingState::default());
        let keys = nostr::Keys::generate();
        let me = keys.public_key().to_hex();
        let event = signed(
            build_org_step_event(
                "demo-template",
                &t,
                &org_step(&plan, "org:seat:writer"),
                &me,
                None,
            )
            .unwrap(),
            &keys,
        );
        assert_eq!(first_tag(&event, "d").unwrap()[1], "seat-writer");
        let body: serde_json::Value = serde_json::from_str(&event.content).unwrap();
        assert_eq!(body["name"], "Head of Story", "the declared title wins");
        // Wire spelling is snake_case (`agent_seat`): the SDK enum, the desktop
        // reader and the relay all agree; NIP-ORG documents it the same way.
        assert_eq!(body["kind"], "agent_seat");
        assert_eq!(body["parent"], "root");
        assert_eq!(body["holders"], serde_json::json!([]));
        assert_eq!(body["agentSeats"], serde_json::json!([]), "vacant");
    }

    #[test]
    fn org_seat_title_defaults_to_the_persona_name() {
        let mut t = org_template();
        t.org.as_mut().unwrap().seats[0].title = None;
        let plan = plan_apply(&t, &ExistingState::default());
        let keys = nostr::Keys::generate();
        let me = keys.public_key().to_hex();
        let event = signed(
            build_org_step_event(
                "demo-template",
                &t,
                &org_step(&plan, "org:seat:writer"),
                &me,
                None,
            )
            .unwrap(),
            &keys,
        );
        let body: serde_json::Value = serde_json::from_str(&event.content).unwrap();
        assert_eq!(body["name"], "The Writer");
    }

    /// The default budget is what makes "every agent is covered from day one"
    /// true: subject `"*"`, the declared window and only the declared limits.
    #[test]
    fn org_default_budget_targets_every_agent() {
        let t = org_template();
        let plan = plan_apply(&t, &ExistingState::default());
        let keys = nostr::Keys::generate();
        let me = keys.public_key().to_hex();
        let event = signed(
            build_org_step_event(
                "demo-template",
                &t,
                &org_step(&plan, "org:budget"),
                &me,
                None,
            )
            .unwrap(),
            &keys,
        );
        assert_eq!(event.kind.as_u16() as u32, buzz_core::kind::KIND_ORG_BUDGET);
        assert_eq!(first_tag(&event, "d").unwrap()[1], "default-agents");
        let body: serde_json::Value = serde_json::from_str(&event.content).unwrap();
        assert_eq!(body["subject"], "*");
        assert_eq!(body["window"], "week");
        assert_eq!(body["onExceed"], "require-approval");
        assert_eq!(body["limits"]["runs"], 200);
        assert_eq!(body["limits"]["tasks"]["create"], 20);
        assert_eq!(body["limits"]["messages"], 300);
        assert!(
            body["limits"].get("llmCalls").is_none() && body["limits"].get("spend").is_none(),
            "only declared limits are written: {}",
            body["limits"]
        );
    }

    #[test]
    fn org_steps_refuse_the_generic_builder() {
        let t = org_template();
        let plan = plan_apply(&t, &ExistingState::default());
        let err = build_step_event(
            "demo-template",
            &t,
            &files(),
            &org_step(&plan, "org:root"),
            &BTreeMap::new(),
            None,
            &BTreeMap::new(),
        )
        .unwrap_err();
        assert!(err.to_string().contains("build_org_step_event"), "{err}");
    }
}
