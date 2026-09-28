//! The distill-skill trainer — SkillOpt's optimizer stages over the LLM port,
//! scoring the Agent Wiki distill skill with our own validators.
//!
//! This is the production bridge for `buzz-skillopt`: the trainable artifact
//! is the distill system prompt (the persona's wiki-writing skill), rollouts
//! generate standup pages from fixture source digests, and the held-out score
//! rewards exactly the honesty rules we enforce elsewhere — the page must
//! validate, decision blocks must extract, and evidence must be verbatim.
//!
//! Layering: prompt assembly and strict JSON parsing are pure (golden-tested
//! here); the LLM transport is `crate::llm::chat_completion`; the sync traits
//! of `buzz_skillopt::train` are honored by running each call on a
//! current-thread runtime. Hosts MUST therefore drive `train()` from a
//! blocking context (`tokio::task::spawn_blocking`) — starting a runtime
//! inside the async dispatch panics (observed live, then fixed at the host).

use std::collections::BTreeMap;

use buzz_skillopt::edit::{EditOp, MergedEdit, SkillDoc};
use buzz_skillopt::train::{
    AnalysisRequest, LongitudinalRequest, Optimizer, Patch, Scorer, Task, Target, Trajectory,
};

use crate::draft::decision_drafts;
use crate::llm::{chat_completion_effort, LlmError, LlmTarget};
use crate::{validate_page_draft, AGWIKI_MAX_TOKENS};

// ── Pure: prompt assembly (the C.2 contracts + our slots) ──────────────────

fn format_trajectory(t: &Trajectory) -> String {
    format!(
        "- task {} ({}): {}",
        t.task,
        if t.success { "success" } else { "failure" },
        t.output
    )
}

/// `analyst_error.md` with the slots filled: skill, minibatch, budget `L`,
/// optimizer memory, and the rejected-buffer note appended (the do-not-
/// repeat material from §3.5).
pub fn analyst_prompt(contract: &str, req: &AnalysisRequest<'_>) -> String {
    let mut prompt = format!(
        "{contract}\n\n## Current skill document\n{}\n\n## Trajectories (minibatch)\n{}\n\nBudget L: {}\n",
        req.skill,
        req.trajectories
            .iter()
            .map(format_trajectory)
            .collect::<Vec<_>>()
            .join("\n"),
        req.budget
    );
    if let Some(memory) = req.memory {
        prompt.push_str(&format!("\n## Optimizer memory (m_meta)\n{memory}\n"));
    }
    prompt.push_str(req.buffer_note);
    prompt
}

/// The `merge_*.md` slots: skill + the source patches (with their carried
/// support metadata in `notes`, per the port's deviation 1).
pub fn merge_prompt(contract: &str, skill: &str, patches: &[Patch]) -> String {
    let body: Vec<String> = patches
        .iter()
        .map(|p| {
            format!(
                "- reasoning: {}\n  edits: {}\n  carried metadata: {}",
                p.reasoning,
                serde_json::to_string(&p.edits).unwrap_or_default(),
                p.notes
            )
        })
        .collect();
    format!(
        "{contract}\n\n## Current skill document\n{skill}\n\n## Proposed patches\n{}\n",
        body.join("\n")
    )
}

/// The `merge_final.md` slots: skill + both pre-merged groups (serialized as
/// contract-shaped edits so support counts survive).
pub fn final_merge_prompt(
    contract: &str,
    skill: &str,
    failure: &[MergedEdit],
    success: &[MergedEdit],
) -> String {
    format!(
        "{contract}\n\n## Current skill document\n{skill}\n\n## Failure-driven merged edits\n{}\n\n## Success-driven merged edits\n{}\n",
        serde_json::to_string(failure).unwrap_or_default(),
        serde_json::to_string(success).unwrap_or_default()
    )
}

/// The `ranking.md` slots: skill + the pool + the budget.
pub fn ranking_prompt(contract: &str, skill: &str, pool: &[MergedEdit], select: usize) -> String {
    format!(
        "{contract}\n\n## Current skill document\n{skill}\n\n## Edit pool (0-based indices)\n{}\n\nSelect exactly {select} edits.\n",
        serde_json::to_string(pool).unwrap_or_default()
    )
}

/// The `slow_update.md` / `meta_skill.md` slots: both skills + the
/// longitudinal comparison + the previous guidance/memory.
pub fn epoch_prompt(contract: &str, req: &LongitudinalRequest<'_>) -> String {
    let comparison = format!(
        "regressions: {:?}\npersistent failures: {:?}\nimprovements: {:?}\nstable successes: {:?}",
        req.comparison.regressions,
        req.comparison.persistent_failures,
        req.comparison.improvements,
        req.comparison.stable_successes
    );
    let mut prompt = format!(
        "{contract}\n\n## Previous epoch skill\n{}\n\n## Current epoch skill\n{}\n\n## Longitudinal comparison\n{comparison}\n",
        req.prev_skill, req.curr_skill
    );
    if let Some(previous) = req.previous {
        prompt.push_str(&format!("\n## Previous guidance / memory\n{previous}\n"));
    }
    prompt
}

// ── Pure: strict output parsing (parse or fail loudly — never guess) ───────

fn json_body(text: &str) -> Result<serde_json::Value, String> {
    serde_json::from_str(text.trim()).map_err(|e| format!("optimizer returned non-JSON: {e}"))
}

/// Parse an `analyst_*.md` response into a [`Patch`].
pub fn parse_analysis_output(text: &str) -> Result<Patch, String> {
    let value = json_body(text)?;
    let patch = value
        .get("patch")
        .ok_or_else(|| "optimizer response has no `patch`".to_string())?;
    let reasoning = patch
        .get("reasoning")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_string();
    let edits_value = patch.get("edits").cloned().unwrap_or(serde_json::json!([]));
    let edits: Vec<EditOp> =
        serde_json::from_value(edits_value).map_err(|e| format!("bad edits: {e}"))?;
    let notes = value
        .get("failure_summary")
        .or_else(|| value.get("success_patterns"))
        .map(|n| n.to_string())
        .unwrap_or_default();
    Ok(Patch {
        reasoning,
        edits,
        notes,
    })
}

/// Parse a `merge_*.md` response into merged edits (strict).
pub fn parse_merge_output(text: &str) -> Result<Vec<MergedEdit>, String> {
    let value = json_body(text)?;
    let edits = value
        .get("edits")
        .cloned()
        .unwrap_or(serde_json::json!([]));
    serde_json::from_value(edits).map_err(|e| format!("bad merged edits: {e}"))
}

/// Parse a `ranking.md` response into selected indices (strict).
pub fn parse_ranking_output(text: &str) -> Result<Vec<usize>, String> {
    let value = json_body(text)?;
    serde_json::from_value(
        value
            .get("selected_indices")
            .cloned()
            .unwrap_or(serde_json::json!([])),
    )
    .map_err(|e| format!("bad selected_indices: {e}"))
}

/// Parse `slow_update.md` / `meta_skill.md` output content (strict).
pub fn parse_epoch_output(text: &str, key: &str) -> Result<String, String> {
    let value = json_body(text)?;
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("optimizer response has no `{key}`"))
}

// ── Pure: the distill scorer (our validators as the held-out metric) ───────

/// Per-task hard score in points (max [`DISTILL_MAX_POINTS`]):
/// the page validates (2), at least one decision block extracts (1), and
/// every extracted block passes the verbatim-evidence rule (2). The soft
/// score is the fraction of blocks that survive extraction — reinforcement
/// shaping only; the gate defaults to hard.
pub const DISTILL_MAX_POINTS: f64 = 5.0;

/// Per-fixture block expectations (the `corpus.json` manifest) — the
/// decision-honesty checks the structure-only score cannot see. A
/// `max_blocks: 0` fixture says "the sources do not support a decision";
/// emitting one is exactly the `unsupported_decision_encoding` failure the
/// analysts identified, and the score must punish it.
#[derive(Debug, Clone, Copy, Default, PartialEq, serde::Deserialize)]
pub struct BlockExpectation {
    #[serde(default)]
    pub min_blocks: Option<usize>,
    #[serde(default)]
    pub max_blocks: Option<usize>,
}

/// Score one generated page. Pure and deterministic — golden-tested.
pub fn score_page(output: &str) -> (f64, f64) {
    score_page_with(output, None)
}

/// [`score_page`] with optional block expectations: a violated expectation
/// caps the hard score at the page-valid credit (2/5) — no block credit, no
/// verbatim credit — so "don't decide when sources don't support it" is
/// learnable through the gate.
pub fn score_page_with(output: &str, expectation: Option<&BlockExpectation>) -> (f64, f64) {
    let mut hard = 0.0;
    if validate_page_draft(output).is_ok() {
        hard += 2.0;
    }
    let drafts = decision_drafts(output);
    let extracted = drafts.drafts.len();
    let total_blocks = extracted + drafts.skipped.len();
    let violates = expectation
        .map(|e| {
            e.max_blocks.is_some_and(|max| extracted > max)
                || e.min_blocks.is_some_and(|min| extracted < min)
        })
        .unwrap_or(false);
    if violates {
        return (hard / DISTILL_MAX_POINTS, 0.0);
    }
    if extracted > 0 {
        hard += 1.0;
    }
    if total_blocks > 0 && drafts.skipped.is_empty() {
        hard += 2.0;
    }
    let soft = if total_blocks == 0 {
        0.0
    } else {
        extracted as f64 / total_blocks as f64
    };
    (hard / DISTILL_MAX_POINTS, soft)
}

/// Load the optional `corpus.json` expectations manifest (task id →
/// [`BlockExpectation`]); a missing manifest means no expectations.
pub fn load_expectations(
    root: &std::path::Path,
) -> Result<std::collections::BTreeMap<String, BlockExpectation>, String> {
    let path = root.join("corpus.json");
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(_) => return Ok(Default::default()),
    };
    serde_json::from_str(&text).map_err(|e| format!("corpus.json: {e}"))
}

// ── LLM plumbing (thin; each call gets its own current-thread runtime so
//    `buzz-skillopt`'s traits stay sync and the crate stays async-free) ────

/// Strict `choices[0].message.content` extraction — the reasoning-model
/// lesson from the live distill failure, applied here too, with the
/// `finish_reason` named for diagnosis.
fn message_content(value: &serde_json::Value) -> Result<String, String> {
    let choice = value
        .get("choices")
        .and_then(serde_json::Value::as_array)
        .and_then(|c| c.first())
        .ok_or_else(|| "response has no 'choices' array".to_string())?;
    let content = choice
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            format!(
                "no string message.content (finish_reason={:?} — a reasoning \
                 model likely exhausted max_tokens thinking)",
                choice.get("finish_reason").and_then(serde_json::Value::as_str)
            )
        })?;
    Ok(content.to_string())
}

/// One LLM round trip. Reasoning models vary in how much they think before
/// writing content (observed live: content null at the standard budget on
/// some prompts, fine on others) — on empty content the SAME prompt is
/// retried once at double budget. Prompts stay verbatim (this is transport
/// robustness, not a method change).
fn llm_text(
    target: &LlmTarget,
    system: &str,
    user: &str,
    max_tokens: u32,
    reasoning_effort: Option<&str>,
) -> Result<String, String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("runtime: {e}"))?;
    let http = reqwest::Client::builder()
        .timeout(crate::AGWIKI_TIMEOUT)
        .build()
        .map_err(|e| format!("http: {e}"))?;
    let mut last_error = String::new();
    for attempt_budget in [max_tokens, max_tokens.saturating_mul(2)] {
        let value = runtime
            .block_on(chat_completion_effort(
                &http,
                target,
                system,
                user,
                attempt_budget,
                reasoning_effort,
            ))
            .map_err(|e: LlmError| e.to_string())?;
        match message_content(&value) {
            Ok(content) => return Ok(content),
            Err(error) => last_error = error,
        }
    }
    Err(last_error)
}

/// Rollout budget: pages are long — a page-sized completion cap (the SkillOpt
/// config's `rewrite_max_completion_tokens` is 64k upstream; 32k covers our
/// page bound with headroom for the reasoning model's thinking).
pub const SKILL_ROLLOUT_MAX_TOKENS: u32 = 32_768;

/// The `Target` adapter: rollouts are real generations under the candidate
/// skill (the system prompt IS the trainable text). `task.prompt` is the
/// fixture's source digest in the shape of the distill user message.
pub struct DistillTarget {
    pub target: LlmTarget,
    /// SkillOpt's `model.reasoning_effort` (default `medium` upstream).
    pub reasoning_effort: String,
}

/// Output kept for the analysts is capped — prompt economy, stated.
pub const ROLLOUT_OUTPUT_CAP: usize = 8_000;

impl Target for DistillTarget {
    fn rollout(&mut self, skill: &SkillDoc, task: &Task) -> Trajectory {
        match llm_text(
            &self.target,
            skill.as_str(),
            &task.prompt,
            SKILL_ROLLOUT_MAX_TOKENS,
            Some(self.reasoning_effort.as_str()),
        ) {
            Ok(output) => {
                let (hard, _soft) = score_page(&output);
        let success = validate_page_draft(&output).is_ok() && hard > 0.5;
                let clipped: String = output.chars().take(ROLLOUT_OUTPUT_CAP).collect();
                Trajectory {
                    task: task.id.clone(),
                    success,
                    output: clipped,
                    score: hard,
                }
            }
            Err(error) => Trajectory {
                task: task.id.clone(),
                success: false,
                output: format!("[rollout failed: {error}]"),
                score: 0.0,
            },
        }
    }
}

/// The `Scorer` adapter over [`score_page_with`] (mean hard / mean soft),
/// with per-fixture block expectations from the corpus manifest.
pub struct DistillScorer {
    pub expectations: BTreeMap<String, BlockExpectation>,
}

impl DistillScorer {
    pub fn new() -> Self {
        Self {
            expectations: BTreeMap::new(),
        }
    }
}

impl Default for DistillScorer {
    fn default() -> Self {
        Self::new()
    }
}

impl Scorer for DistillScorer {
    fn score(&mut self, _skill: &SkillDoc, trajectories: &[Trajectory]) -> (f64, f64) {
        if trajectories.is_empty() {
            return (0.0, 0.0);
        }
        let mut hard = 0.0;
        let mut soft = 0.0;
        for trajectory in trajectories {
            let (h, s) = score_page_with(
                &trajectory.output,
                self.expectations.get(&trajectory.task),
            );
            hard += h;
            soft += s;
        }
        let n = trajectories.len() as f64;
        (hard / n, soft / n)
    }
}

/// The eight SkillOpt optimizer stages over one OpenAI-compatible endpoint
/// (the contracts arrive verbatim from [`crate::skill_train`]'s re-export of
/// `buzz_skillopt::prompts`).
pub struct LlmOptimizer {
    pub target: LlmTarget,
    /// SkillOpt's `model.reasoning_effort` (default `medium` upstream).
    pub reasoning_effort: String,
}

impl LlmOptimizer {
    fn call(&self, system: &str, user: &str) -> Result<String, String> {
        llm_text(
            &self.target,
            system,
            user,
            AGWIKI_MAX_TOKENS,
            Some(self.reasoning_effort.as_str()),
        )
    }
}

impl Optimizer for LlmOptimizer {
    fn analyze_error(&mut self, req: &AnalysisRequest<'_>) -> Result<Patch, String> {
        let prompt = analyst_prompt(buzz_skillopt::prompts::ANALYST_ERROR, req);
        let output = self.call("You are the SkillOpt failure analyst.", &prompt)?;
        let patch = parse_analysis_output(&output)?;
        for edit in &patch.edits {
            eprintln!("  [analyst-error] proposed {}", describe(edit));
        }
        Ok(patch)
    }

    fn analyze_success(&mut self, req: &AnalysisRequest<'_>) -> Result<Patch, String> {
        let prompt = analyst_prompt(buzz_skillopt::prompts::ANALYST_SUCCESS, req);
        let output = self.call("You are the SkillOpt success analyst.", &prompt)?;
        let patch = parse_analysis_output(&output)?;
        for edit in &patch.edits {
            eprintln!("  [analyst-success] proposed {}", describe(edit));
        }
        Ok(patch)
    }

    fn merge_failure(&mut self, skill: &str, patches: &[Patch]) -> Result<Vec<MergedEdit>, String> {
        let prompt = merge_prompt(buzz_skillopt::prompts::MERGE_FAILURE, skill, patches);
        let output = self.call("You are the SkillOpt edit coordinator.", &prompt)?;
        parse_merge_output(&output)
    }

    fn merge_success(&mut self, skill: &str, patches: &[Patch]) -> Result<Vec<MergedEdit>, String> {
        let prompt = merge_prompt(buzz_skillopt::prompts::MERGE_SUCCESS, skill, patches);
        let output = self.call("You are the SkillOpt edit coordinator.", &prompt)?;
        parse_merge_output(&output)
    }

    fn merge_final(
        &mut self,
        skill: &str,
        failure: &[MergedEdit],
        success: &[MergedEdit],
    ) -> Result<Vec<MergedEdit>, String> {
        let prompt = final_merge_prompt(buzz_skillopt::prompts::MERGE_FINAL, skill, failure, success);
        let output = self.call("You are the SkillOpt edit coordinator.", &prompt)?;
        parse_merge_output(&output)
    }

    fn rank(
        &mut self,
        skill: &str,
        pool: &[MergedEdit],
        select: usize,
    ) -> Result<Vec<usize>, String> {
        let prompt = ranking_prompt(buzz_skillopt::prompts::RANKING, skill, pool, select);
        let output = self.call("You are the SkillOpt edit-ranking optimizer.", &prompt)?;
        let indices = parse_ranking_output(&output)?;
        eprintln!("  [ranking] selected indices {indices:?} of {} (budget {select})", pool.len());
        Ok(indices)
    }

    fn slow_update(&mut self, req: &LongitudinalRequest<'_>) -> Result<String, String> {
        let prompt = epoch_prompt(buzz_skillopt::prompts::SLOW_UPDATE, req);
        let output = self.call("You are a strategic skill advisor.", &prompt)?;
        parse_epoch_output(&output, "slow_update_content")
    }

    fn meta_skill(&mut self, req: &LongitudinalRequest<'_>) -> Result<String, String> {
        let prompt = epoch_prompt(buzz_skillopt::prompts::META_SKILL, req);
        let output = self.call("You are an optimizer coach.", &prompt)?;
        parse_epoch_output(&output, "meta_skill_content")
    }
}

/// A compact edit description for the run receipt.
fn describe(edit: &EditOp) -> String {
    match edit {
        EditOp::Append { content } => format!("append {:?}", clip(content)),
        EditOp::InsertAfter { target, content } => {
            format!("insert_after {:?} -> {:?}", clip(target), clip(content))
        }
        EditOp::Replace { target, content } => {
            format!("replace {:?} -> {:?}", clip(target), clip(content))
        }
        EditOp::Delete { target } => format!("delete {:?}", clip(target)),
    }
}

fn clip(text: &str) -> String {
    if text.chars().count() <= 70 {
        text.to_string()
    } else {
        let cut: String = text.chars().take(67).collect();
        format!("{cut}...")
    }
}

/// Load a split corpus: every `.md` file in `dir` is one task — id = the file
/// stem, prompt = the file's text (the fixture's source digest).
pub fn load_split(dir: &std::path::Path) -> Result<Vec<Task>, String> {
    let mut tasks = BTreeMap::new();
    let entries = std::fs::read_dir(dir).map_err(|e| format!("read_dir {}: {e}", dir.display()))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string();
        let prompt = std::fs::read_to_string(&path)
            .map_err(|e| format!("read {}: {e}", path.display()))?;
        tasks.insert(id.clone(), Task { id, prompt });
    }
    if tasks.is_empty() {
        return Err(format!("no .md fixtures in {}", dir.display()));
    }
    Ok(tasks.into_values().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_skillopt::edit::SourceType;

    fn request<'a>(
        skill: &'a str,
        trajectories: &'a [Trajectory],
        budget: usize,
        memory: Option<&'a str>,
        buffer_note: &'a str,
    ) -> AnalysisRequest<'a> {
        AnalysisRequest {
            skill,
            trajectories,
            budget,
            memory,
            buffer_note,
        }
    }

    #[test]
    fn golden_analyst_prompt_carries_every_contract_slot() {
        let trajectory = Trajectory {
            task: "t1".into(),
            success: false,
            output: "miss".into(),
            score: 0.0,
        };
        let req = request(
            "# Skill\nrule",
            std::slice::from_ref(&trajectory),
            4,
            Some("prefer concrete edits"),
            "\nPREVIOUSLY REJECTED (do not repeat these edits or patterns):\n",
        );
        let prompt = analyst_prompt(buzz_skillopt::prompts::ANALYST_ERROR, &req);
        assert!(prompt.contains("# Skill\nrule"));
        assert!(prompt.contains("task t1 (failure): miss"));
        assert!(prompt.contains("Budget L: 4"));
        assert!(prompt.contains("Optimizer memory"));
        assert!(prompt.contains("PREVIOUSLY REJECTED"));
    }

    #[test]
    fn golden_analysis_output_parses_strictly() {
        let output = r###"{"batch_size":2,"failure_summary":[{"failure_type":"missing rule","count":2,"description":"x"}],"patch":{"reasoning":"common","edits":[{"op":"append","content":"New rule."}]}}"###;
        let patch = parse_analysis_output(output).expect("parses");
        assert_eq!(patch.reasoning, "common");
        assert_eq!(
            patch.edits,
            vec![EditOp::Append {
                content: "New rule.".into()
            }]
        );
        assert!(patch.notes.contains("missing rule"), "notes carry the summary");
        // Strict: non-JSON and missing patches fail loudly, never guessed.
        assert!(parse_analysis_output("not json").is_err());
        assert!(parse_analysis_output("{\"batch_size\":1}").is_err());
    }

    #[test]
    fn golden_merge_rank_and_epoch_parsing() {
        let merged = parse_merge_output(
            r###"{"reasoning":"r","edits":[{"op":"delete","target":"x","support_count":3,"source_type":"failure"}]}"###,
        )
        .expect("parses");
        assert_eq!(merged[0].support_count, 3);
        assert_eq!(merged[0].source_type, SourceType::Failure);
        let indices = parse_ranking_output("{\"reasoning\":\"r\",\"selected_indices\":[2,0]}")
            .expect("parses");
        assert_eq!(indices, vec![2, 0]);
        assert_eq!(
            parse_epoch_output(
                "{\"reasoning\":\"r\",\"slow_update_content\":\"Do Y.\"}",
                "slow_update_content"
            )
            .expect("parses"),
            "Do Y."
        );
        assert!(parse_epoch_output("{\"reasoning\":\"r\"}", "meta_skill_content").is_err());
    }

    #[test]
    fn golden_block_expectations_punish_unsupported_decisions() {
        let decides = concat!(
            "## Standup\n\nThe round-2 postmortem asks for a 600 bps quorum.\n\n",
            "```decision\nkind: plain\ntitle: Raise quorum\nevidence: The round-2 postmortem asks for a 600 bps quorum.\n```\n"
        );
        // Unconstrained: the honest block earns full credit…
        assert_eq!(score_page(decides).0, 1.0);
        // …but a fixture that forbids decisions caps it at page-valid credit
        // (the `unsupported_decision_encoding` failure, made learnable).
        let forbidden = BlockExpectation {
            min_blocks: None,
            max_blocks: Some(0),
        };
        assert_eq!(
            score_page_with(decides, Some(&forbidden)).0,
            2.0 / 5.0,
            "deciding when sources do not support it is punished"
        );
        // And a required block that never came is not rewarded.
        let required = BlockExpectation {
            min_blocks: Some(1),
            max_blocks: None,
        };
        let no_blocks = "## Standup\n\nNothing to decide.\n";
        assert_eq!(
            score_page_with(no_blocks, Some(&required)).0,
            2.0 / 5.0,
            "a missing required decision earns no block credit"
        );
    }

    #[test]
    fn golden_distill_scoring_rewards_our_honesty_rules() {
        let honest = concat!(
            "## Standup\n\nThe round-2 postmortem asks for a 600 bps quorum.\n\n",
            "```decision\nkind: plain\ntitle: Raise quorum\nevidence: The round-2 postmortem asks for a 600 bps quorum.\n```\n"
        );
        let (hard, soft) = score_page(honest);
        assert_eq!((hard, soft), (1.0, 1.0), "valid + one block + all verbatim");

        let invented = concat!(
            "## Standup\n\nNothing here.\n\n",
            "```decision\nkind: plain\ntitle: Invent\nevidence: A quote that exists nowhere.\n```\n"
        );
        let (hard, soft) = score_page(invented);
        assert_eq!(
            hard,
            2.0 / 5.0,
            "valid page only — an all-skipped block earns no draft credit and no verbatim credit"
        );
        assert_eq!(soft, 0.0);
    }

    #[test]
    fn rollout_failures_land_as_zero_score_trajectories() {
        let _ = DistillScorer::new();
        let mut target = DistillTarget {
            target: LlmTarget {
                api_url: "http://127.0.0.1:1".into(),
                api_key: String::new(),
                model: "none".into(),
            },
            reasoning_effort: "low".into(),
        };
        let trajectory = target.rollout(
            &SkillDoc::new("# Skill"),
            &Task {
                id: "t1".into(),
                prompt: "p".into(),
            },
        );
        assert!(!trajectory.success);
        assert_eq!(trajectory.score, 0.0);
        assert!(trajectory.output.contains("rollout failed"));
    }
}

