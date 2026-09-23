//! `buzz team` — self-organizing agent teams (SAT), slice 1.
//!
//! Implements the teamwork-strategy engine from arXiv 2609.22682
//! ("Self-Organizing Agent Teams Learn to Reason Together", §2.1 + Appendix A):
//! a fixed roster of LLM-backed agents executes an ordered list of
//! conversational phases under a shared teamwork prompt and persistent role
//! prompts. The conductor (this CLI) calls the OpenAI-compatible classifier
//! endpoint once per turn: system = teamwork prompt + role prompt + phase
//! prompt; user = the conversation so far (local flow: phase participants'
//! turns only; summary flow: the designated summarizer's digest added to
//! every member's context).
//!
//! Slice 1 ships the execution engine + strategy management; teamwork
//! reflection (the paper's §2.2 evolution loop that distills revised
//! strategies) and the org binding (seats/grants/budgets) land in slice 2 —
//! see `docs/agent-teams.md` for the full spec.
//!
//! Kinds (community-level, global-only, read-side LWW — see kind.rs):
//! - 44020 `KIND_TEAM_STRATEGY` — strategy definition (`d` = strategy id)
//! - 44021 `KIND_TEAM_RUN`     — one executed run (`d` = run id)
//! - 44022 `KIND_TEAM_TURN`    — one turn (`d` = `<run-id>/<phase>/<agentSlot>`)
//!
//! Bounds (fail-closed everywhere): max 6 phases, 4 rounds, 6 participants;
//! 30s per LLM call; `--max-tokens-per-turn` default 700, hard cap 2048.
//! A mid-run LLM failure never publishes anything partial — the partial
//! transcript is printed with a note and the command fails loudly.

use std::collections::{BTreeMap, HashMap};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use buzz_core::kind::{KIND_TEAM_RUN, KIND_TEAM_STRATEGY, KIND_TEAM_TURN};
use nostr::{Event, EventBuilder, Kind, Tag};

use crate::client::BuzzClient;
use crate::commands::org_classify::{classifier_config_from_env, ClassifierConfig};
use crate::commands::parse_write_response;
use crate::error::CliError;

// ── Bounds ────────────────────────────────────────────────────────────────

/// Default response token cap per turn (the task's outer bound; the paper's
/// runs stay well below this).
pub const DEFAULT_MAX_TOKENS_PER_TURN: u32 = 700;
/// Hard ceiling for `--max-tokens-per-turn` — bounds the per-run LLM spend.
pub const MAX_TOKENS_HARD_CAP: u32 = 2048;
/// Hard timeout for one LLM call (conductor turn, summary, final writer).
const LLM_TIMEOUT: Duration = Duration::from_secs(30);
/// Backoff for HTTP 429 from the classifier limiter (task contract: back off
/// 5 minutes, retry once).
const RATE_LIMIT_BACKOFF: Duration = Duration::from_secs(300);
/// Temperature for turn calls — low and reproducible, like the classifier.
const LLM_TEMPERATURE: f64 = 0.2;
/// Ceiling for the empty-content retry's token bump. Reasoning models spend
/// completion tokens on reasoning before `content` (the same failure mode
/// the org classifier documents); a request whose budget dies mid-reasoning
/// returns empty content (`finish_reason: length`, zero text tokens), so the
/// single retry runs with a 4× budget (bounded by this ceiling). Long
/// contexts need real headroom: a 2× bump still starved the summary call in
/// live smoke testing.
const EMPTY_RETRY_MAX_TOKENS: u32 = 4096;
/// Hard cap: phases per strategy.
pub const MAX_PHASES: usize = 6;
/// Hard cap: rounds per phase.
pub const MAX_ROUNDS: u32 = 4;
/// Hard cap: roster slots (participants per phase).
pub const MAX_PARTICIPANTS: usize = 6;
/// Bounded relay read for one strategy/run fetch.
const STRATEGY_QUERY_BOUND: u32 = 32;
/// Bounded relay read for `strategy list`.
const STRATEGY_LIST_BOUND: u32 = 256;
/// User-message context cap (bytes). Turn content is bounded per-turn by
/// `max_tokens_per_turn`; this bounds what the conductor re-sends.
const CONTEXT_MAX_CHARS: usize = 32_768;

const STRATEGY_NAME_MAX_CHARS: usize = 128;
const STRATEGY_DESC_MAX_CHARS: usize = 1024;
const TEAMWORK_PROMPT_MAX_CHARS: usize = 8192;
const ROLE_PROMPT_MAX_CHARS: usize = 4096;
const STEP_PROMPT_MAX_CHARS: usize = 4096;
const SLOT_NAME_MAX_CHARS: usize = 32;
const PROBLEM_MAX_CHARS: usize = 16_384;

/// Strategy schema version accepted by slice 1.
pub const STRATEGY_SCHEMA_VERSION: u32 = 1;

/// arXiv id the seeded strategies are transcribed from (Appendix A).
pub const PAPER_ARXIV_ID: &str = "2609.22682";

// ── Strategy DSL ──────────────────────────────────────────────────────────

/// One ordered conversational phase P_k from the paper's P = (S, τ, α).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PhaseStep {
    /// Participating roster slots, in response order (the paper's step
    /// participant set A_k with its specified order, e.g. [2,0,1] means
    /// agent-2 responds first).
    pub participants: Vec<String>,
    /// Number of discussion rounds; each participant responds once per round.
    pub rounds: u32,
    /// `local` = only phase participants see these turns; `summary` = after
    /// the phase, a designated participant summarizes and the digest is
    /// added to every member's context for subsequent phases.
    pub flow: String,
    /// Shared step prompt π_k.
    pub prompt: String,
    /// Optional per-participant step prompts ρ_k (keys ⊆ participants).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "perAgentPrompts"
    )]
    pub per_agent_prompts: Option<HashMap<String, String>>,
}

/// The complete strategy document (content of a kind:44020 event).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TeamStrategy {
    /// Schema version (1).
    pub v: u32,
    /// Short human name.
    pub name: String,
    /// What the strategy is for.
    pub description: String,
    /// Shared teamwork prompt τ (collaboration norms for the whole team).
    #[serde(rename = "teamworkPrompt")]
    pub teamwork_prompt: String,
    /// Persistent per-agent role prompts α, keyed by roster slot.
    pub roles: BTreeMap<String, String>,
    /// Ordered list of conversational phases S = [s_1, …, s_K].
    pub steps: Vec<PhaseStep>,
    /// Roster slot of the designated final writer (produces the certificate).
    #[serde(rename = "finalWriter")]
    pub final_writer: String,
}

impl TeamStrategy {
    /// Strict semantic validation (the CLI layer; the relay only bounds the
    /// envelope). Fails closed: a malformed strategy is never published and
    /// never executed.
    pub fn validate(&self) -> Result<(), String> {
        if self.v != STRATEGY_SCHEMA_VERSION {
            return Err(format!(
                "unsupported strategy schema v={} (slice 1 accepts v={STRATEGY_SCHEMA_VERSION})",
                self.v
            ));
        }
        let nonempty_bounded = |s: &str, max: usize, field: &str| -> Result<(), String> {
            let n = s.chars().count();
            if s.trim().is_empty() || n > max {
                return Err(format!("'{field}' must be 1..={max} chars (got {n})"));
            }
            Ok(())
        };
        nonempty_bounded(&self.name, STRATEGY_NAME_MAX_CHARS, "name")?;
        nonempty_bounded(&self.description, STRATEGY_DESC_MAX_CHARS, "description")?;
        nonempty_bounded(
            &self.teamwork_prompt,
            TEAMWORK_PROMPT_MAX_CHARS,
            "teamworkPrompt",
        )?;

        if self.roles.is_empty() || self.roles.len() > MAX_PARTICIPANTS {
            return Err(format!(
                "'roles' must have 1..={MAX_PARTICIPANTS} slot(s) (got {})",
                self.roles.len()
            ));
        }
        for (slot, role) in &self.roles {
            nonempty_bounded(slot, SLOT_NAME_MAX_CHARS, "role slot name")?;
            nonempty_bounded(
                role,
                ROLE_PROMPT_MAX_CHARS,
                &format!("role prompt for {slot:?}"),
            )?;
        }

        if self.steps.is_empty() || self.steps.len() > MAX_PHASES {
            return Err(format!(
                "'steps' must have 1..={MAX_PHASES} phase(s) (got {})",
                self.steps.len()
            ));
        }
        for (idx, step) in self.steps.iter().enumerate() {
            let label = format!("steps[{idx}]");
            if step.participants.is_empty() || step.participants.len() > MAX_PARTICIPANTS {
                return Err(format!(
                    "{label}.participants must have 1..={MAX_PARTICIPANTS} slot(s) (got {})",
                    step.participants.len()
                ));
            }
            for slot in &step.participants {
                if !self.roles.contains_key(slot) {
                    return Err(format!(
                        "{label}.participants contains {slot:?}, which is not a defined role slot"
                    ));
                }
            }
            if step.rounds == 0 || step.rounds > MAX_ROUNDS {
                return Err(format!(
                    "{label}.rounds must be 1..={MAX_ROUNDS} (got {})",
                    step.rounds
                ));
            }
            if step.flow != "local" && step.flow != "summary" {
                return Err(format!(
                    "{label}.flow must be \"local\" or \"summary\" (got {:?})",
                    step.flow
                ));
            }
            nonempty_bounded(
                &step.prompt,
                STEP_PROMPT_MAX_CHARS,
                &format!("{label}.prompt"),
            )?;
            if let Some(per_agent) = &step.per_agent_prompts {
                for (slot, prompt) in per_agent {
                    if !step.participants.contains(slot) {
                        return Err(format!(
                            "{label}.perAgentPrompts names {slot:?}, which is not a participant of this phase"
                        ));
                    }
                    nonempty_bounded(
                        prompt,
                        STEP_PROMPT_MAX_CHARS,
                        &format!("{label}.perAgentPrompts[{slot:?}]"),
                    )?;
                }
            }
        }

        if !self.roles.contains_key(&self.final_writer) {
            return Err(format!(
                "'finalWriter' must be a defined role slot (got {:?})",
                self.final_writer
            ));
        }
        Ok(())
    }
}

// ── Run model ─────────────────────────────────────────────────────────────

/// One recorded conversational turn (mirrors the kind:44022 content and the
/// kind:44021 transcript rows).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Turn {
    /// 1-based phase number (P1, P2, …).
    pub phase: usize,
    /// Roster slot that produced the turn.
    #[serde(rename = "agentSlot")]
    pub agent_slot: String,
    /// The turn markdown (or the phase digest for summary flow).
    pub content: String,
    /// Token usage for this LLM call (from the response when available).
    pub tokens: u64,
}

/// Content of a kind:44021 run event.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RunDocument {
    pub v: u32,
    /// Strategy id (the kind:44020 `d` tag the run executed).
    #[serde(rename = "strategyId")]
    pub strategy_id: String,
    /// The problem the team was asked to solve.
    pub problem: String,
    /// All conductor turns + phase digests, in execution order.
    pub transcript: Vec<Turn>,
    /// The final writer's certificate.
    #[serde(rename = "finalAnswer")]
    pub final_answer: String,
    /// Sum of per-turn token usage.
    #[serde(rename = "totalTokens")]
    pub total_tokens: u64,
    /// Classifier model id.
    pub model: String,
    /// `complete` — slice 1 publishes only completed runs; failures publish
    /// nothing and the partial transcript is printed in-process instead.
    pub status: String,
}

impl RunDocument {
    pub fn new(strategy_id: &str, problem: &str, model: &str) -> Self {
        RunDocument {
            v: STRATEGY_SCHEMA_VERSION,
            strategy_id: strategy_id.to_string(),
            problem: problem.to_string(),
            transcript: vec![],
            final_answer: String::new(),
            total_tokens: 0,
            model: model.to_string(),
            status: "complete".to_string(),
        }
    }
}

// ── Env / config (fail-closed) ────────────────────────────────────────────

/// The conductor requires the same OpenAI-compatible classifier config as
/// `org contribute classify` (BUZZ_CLASSIFIER_API_URL / _KEY / _MODEL).
/// Missing key or URL is a hard usage error — no silent local fallback.
fn conductor_config() -> Result<ClassifierConfig, CliError> {
    classifier_config_from_env()
}

// ── Prompt building ───────────────────────────────────────────────────────

/// Build the (system, user) message pair for one conductor turn: system =
/// teamwork prompt τ + persistent role prompt α_i + phase prompt π_k; user =
/// the problem plus the conversation context (shared prior-phase digests and
/// this phase's participants' turns so far — the paper's local flow).
fn build_turn_messages(
    strategy: &TeamStrategy,
    phase_idx: usize,
    slot: &str,
    problem: &str,
    phase_context: &str,
) -> (String, String) {
    let step = &strategy.steps[phase_idx];
    let mut phase_prompt = format!(
        "This is PHASE {} of {} (flow: {}).\n{}",
        phase_idx + 1,
        strategy.steps.len(),
        step.flow,
        step.prompt.trim(),
    );
    if let Some(per_agent) = &step.per_agent_prompts {
        if let Some(own) = per_agent.get(slot) {
            phase_prompt.push_str("\n\nYour phase-specific instruction:\n");
            phase_prompt.push_str(own.trim());
        }
    }

    let system = format!(
        "{}\n\nYou are {slot} on a fixed team. Your persistent role:\n{}\n\n{phase_prompt}\n\nRespond as {slot} in the team conversation. Reason step by step and, when relevant, state your current answer position.",
        strategy.teamwork_prompt.trim(),
        strategy.roles.get(slot).map(|s| s.as_str()).unwrap_or("generalist"),
    );

    let user = format!(
        "PROBLEM:\n{}\n\nCONVERSATION SO FAR:\n{}",
        problem.trim(),
        if phase_context.trim().is_empty() {
            "(no prior context — you are starting this phase)".to_string()
        } else {
            phase_context.trim().to_string()
        },
    );
    (system, user)
}

/// System prompt for a summary-flow digest call. The paper selects one
/// participant to summarize; slice 1 deterministically picks the phase's
/// first participant (documented divergence: reproducibility over randomness).
fn build_summary_system(strategy: &TeamStrategy, phase_idx: usize, slot: &str) -> String {
    format!(
        "{}\n\nYou are {slot} on a fixed team. Your persistent role:\n{}\n\nPHASE {} of {} just ran with summary flow.\nSummarize the phase's key points, conclusions, and the team's current answer position into a short, self-contained digest that will be added to every member's context for the rest of the run.",
        strategy.teamwork_prompt.trim(),
        strategy.roles.get(slot).map(|s| s.as_str()).unwrap_or("generalist"),
        phase_idx + 1,
        strategy.steps.len(),
    )
}

/// Build the (system, user) pair for the final writer call.
fn build_final_writer_messages(
    strategy: &TeamStrategy,
    problem: &str,
    context: &str,
) -> (String, String) {
    let system = format!(
        "{}\n\nYou are {} on a fixed team. Your persistent role:\n{}\n\nYou are the designated FINAL WRITER. Produce the team's final answer to the problem as a self-contained certificate: state the answer clearly and give a step-by-step reasoning trace a reader can check. If the answer is a single value (a number, a multiple-choice letter, a name), state it on its own final line as:\nFINAL ANSWER: <value>",
        strategy.teamwork_prompt.trim(),
        strategy.final_writer,
        strategy
            .roles
            .get(&strategy.final_writer)
            .map(|s| s.as_str())
            .unwrap_or("generalist"),
    );
    let user = format!(
        "PROBLEM:\n{}\n\nTEAM CONVERSATION (all phases):\n{}\n\nWrite the final answer now.",
        problem.trim(),
        context.trim(),
    );
    (system, user)
}

// ── LLM call with retry ───────────────────────────────────────────────────

/// Whether a classifier call failed with HTTP 429 (the limiter).
#[derive(Debug)]
enum LlmError {
    /// HTTP 429 — the rate limiter; back off 5 minutes, retry once.
    RateLimited(CliError),
    /// Any other failure.
    Other(CliError),
}

impl LlmError {
    fn into_cli(self) -> CliError {
        match self {
            LlmError::RateLimited(e) | LlmError::Other(e) => e,
        }
    }
}

/// Extract the assistant message content from an OpenAI-compatible response.
fn chat_completion_content(value: &serde_json::Value) -> Result<String, String> {
    let choices = value
        .get("choices")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "response has no 'choices' array".to_string())?;
    let choice = choices
        .first()
        .ok_or_else(|| "response has an empty 'choices' array".to_string())?;
    let content = choice
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "choice has no string message.content".to_string())?;
    Ok(content.to_string())
}

/// Read token usage from the response when the provider reports it; fall
/// back to a chars/4 estimate (bounded, deterministic).
fn response_tokens(value: &serde_json::Value, content: &str) -> u64 {
    value
        .get("usage")
        .and_then(|u| u.get("total_tokens"))
        .and_then(serde_json::Value::as_u64)
        .unwrap_or_else(|| (content.chars().count() as u64).saturating_div(4))
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let cut: String = s.chars().take(max).collect();
        format!("{cut}…")
    }
}

/// One HTTP round trip to `{api_url}/chat/completions` (turns are free-form
/// markdown, so no `response_format` is sent — unlike the JSON classifier).
async fn call_llm_once(
    http: &reqwest::Client,
    cfg: &ClassifierConfig,
    system: &str,
    user: &str,
    max_tokens: u32,
) -> Result<serde_json::Value, LlmError> {
    let url = format!("{}/chat/completions", cfg.api_url.trim_end_matches('/'));
    let body = serde_json::json!({
        "model": cfg.model,
        "temperature": LLM_TEMPERATURE,
        "max_tokens": max_tokens,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user },
        ],
    });
    let resp = http
        .post(&url)
        .bearer_auth(&cfg.api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| LlmError::Other(CliError::from(e)))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| LlmError::Other(CliError::from(e)))?;
    if !status.is_success() {
        let err = CliError::Other(format!(
            "classifier API error {status}: {}",
            truncate(&text, 400)
        ));
        return Err(if status.as_u16() == 429 {
            LlmError::RateLimited(err)
        } else {
            LlmError::Other(err)
        });
    }
    serde_json::from_str(&text).map_err(|e| {
        LlmError::Other(CliError::Other(format!(
            "classifier returned non-JSON: {e}"
        )))
    })
}

/// Call the LLM and extract usable content, enforcing the 30s timeout.
///
/// Retry policy (task contract): exactly one retry per turn; HTTP 429 backs
/// off `backoff` first; any other failure retries immediately. A second
/// failure — or two consecutive unusable/envelope-broken contents — fails
/// loud; an invalid turn is never published and never silently repaired.
async fn call_llm_with_retry_and_backoff(
    cfg: &ClassifierConfig,
    system: &str,
    user: &str,
    max_tokens: u32,
    backoff: Duration,
) -> Result<(String, u64), CliError> {
    let http = reqwest::Client::builder()
        .timeout(LLM_TIMEOUT)
        .build()
        .map_err(|e| CliError::Other(format!("classifier client init failed: {e}")))?;

    let attempt = || async { call_llm_once(&http, cfg, system, user, max_tokens).await };

    let value = match attempt().await {
        Ok(v) => v,
        Err(LlmError::RateLimited(e)) => {
            eprintln!("  {e}");
            eprintln!(
                "  rate limit hit; backing off {}s and retrying once…",
                backoff.as_secs()
            );
            tokio::time::sleep(backoff).await;
            attempt().await.map_err(LlmError::into_cli)?
        }
        Err(LlmError::Other(e)) => {
            eprintln!("  {e}; retrying once…");
            attempt().await.map_err(LlmError::into_cli)?
        }
    };

    let content = chat_completion_content(&value)
        .map_err(|e| CliError::Other(format!("classifier response unusable: {e}")))?;
    if content.trim().is_empty() {
        // Invalid (empty) turn content — typically a reasoning model whose
        // budget died mid-reasoning (`finish_reason: length`, zero text
        // tokens). One retry with a doubled budget, then fail loud.
        let retry_tokens = max_tokens
            .saturating_mul(4)
            .min(EMPTY_RETRY_MAX_TOKENS)
            .max(max_tokens);
        eprintln!(
            "  classifier returned empty content; retrying once with {retry_tokens} max_tokens…"
        );
        let value2 = call_llm_once(&http, cfg, system, user, retry_tokens)
            .await
            .map_err(LlmError::into_cli)?;
        let content2 = chat_completion_content(&value2)
            .map_err(|e| CliError::Other(format!("classifier response unusable: {e}")))?;
        if content2.trim().is_empty() {
            return Err(CliError::Other(
                "classifier returned empty content twice; failing loud (nothing published)"
                    .to_string(),
            ));
        }
        let tokens2 = response_tokens(&value2, &content2);
        return Ok((content2, tokens2));
    }
    let tokens = response_tokens(&value, &content);
    Ok((content, tokens))
}

// ── Context assembly (local vs summary flow) ──────────────────────────────

/// The digest turn of a completed summary phase is its last recorded turn.
fn phase_digest(turns: &[Turn], phase: usize) -> Option<&Turn> {
    turns.iter().rev().find(|t| t.phase == phase)
}

/// Render the turn context for one phase.
///
/// Prior summary-flow phases contribute their shared digest (added to every
/// member's context, paper §2.1); the running phase contributes its own
/// participants' turns only (local flow keeps the exchange local). Bounded
/// to [`CONTEXT_MAX_CHARS`], keeping the tail (most recent turns).
fn phase_context(strategy: &TeamStrategy, phase_idx: usize, turns: &[Turn]) -> String {
    let mut parts: Vec<String> = Vec::new();

    let mut digests: Vec<&Turn> = Vec::new();
    for (i, step) in strategy.steps.iter().enumerate() {
        if i < phase_idx && step.flow == "summary" {
            if let Some(d) = phase_digest(turns, i + 1) {
                digests.push(d);
            }
        }
    }
    if !digests.is_empty() {
        parts.push("SHARED DIGESTS (prior phases):".to_string());
        for d in digests {
            parts.push(format!(
                "— summary of phase {} by {}:",
                d.phase, d.agent_slot
            ));
            parts.push(d.content.trim().to_string());
        }
    }

    let mut phase_turns: Vec<&Turn> = Vec::new();
    for t in turns {
        if t.phase == phase_idx + 1
            && strategy.steps[phase_idx]
                .participants
                .contains(&t.agent_slot)
        {
            phase_turns.push(t);
        }
    }
    if !phase_turns.is_empty() {
        parts.push(format!(
            "CURRENT PHASE {} (this phase's participants' turns):",
            phase_idx + 1
        ));
        for t in &phase_turns {
            parts.push(format!("[{}]", t.agent_slot));
            parts.push(t.content.trim().to_string());
        }
    }

    let mut joined = parts.join("\n\n");
    if joined.chars().count() > CONTEXT_MAX_CHARS {
        let keep: String = joined
            .chars()
            .rev()
            .take(CONTEXT_MAX_CHARS)
            .collect::<String>()
            .chars()
            .rev()
            .collect();
        joined = format!("(context truncated; showing the most recent turns)\n\n{keep}");
    }
    joined
}

/// The turns of one completed phase, in order (used for the summary call's
/// user message — the summary reads only the phase's own exchange).
fn phase_own_turns(strategy: &TeamStrategy, phase_idx: usize, turns: &[Turn]) -> String {
    let mut parts: Vec<String> = Vec::new();
    for t in turns {
        if t.phase == phase_idx + 1
            && strategy.steps[phase_idx]
                .participants
                .contains(&t.agent_slot)
        {
            parts.push(format!("[{}]", t.agent_slot));
            parts.push(t.content.trim().to_string());
        }
    }
    let joined = parts.join("\n\n");
    if joined.trim().is_empty() {
        "(no turns recorded for this phase)".to_string()
    } else {
        joined
    }
}

/// Full-run context for the final writer: every recorded turn (bounded).
fn full_run_context(transcript: &[Turn]) -> String {
    let mut parts: Vec<String> = Vec::new();
    for t in transcript {
        parts.push(format!("[phase {} — {}]", t.phase, t.agent_slot));
        parts.push(t.content.trim().to_string());
    }
    let mut joined = parts.join("\n\n");
    if joined.chars().count() > CONTEXT_MAX_CHARS {
        let keep: String = joined
            .chars()
            .rev()
            .take(CONTEXT_MAX_CHARS)
            .collect::<String>()
            .chars()
            .rev()
            .collect();
        joined = format!("(context truncated; showing the most recent turns)\n\n{keep}");
    }
    if joined.trim().is_empty() {
        "(no team turns recorded)".to_string()
    } else {
        joined
    }
}

// ── Run loop ──────────────────────────────────────────────────────────────

/// Deterministic run id: `<strategy-id truncated to 40>-<unix>` (≤ 51 chars,
/// within the relay's 64-char team-id cap; unique per second per strategy).
pub fn build_run_id(strategy_id: &str, now: u64) -> String {
    let slug: String = strategy_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        .take(40)
        .collect();
    format!("{slug}-{now}")
}

fn print_transcript(strategy: &TeamStrategy, run: &RunDocument, note: Option<&str>) {
    println!("strategy: {} ({})", strategy.name, run.strategy_id);
    println!("problem: {}", truncate(&run.problem, 400));
    for (idx, step) in strategy.steps.iter().enumerate() {
        println!(
            "  P{} [{} participants, {} round(s), {} flow]: {}",
            idx + 1,
            step.participants.join(", "),
            step.rounds,
            step.flow,
            truncate(&step.prompt, 160)
        );
    }
    for t in &run.transcript {
        println!(
            "  P{} {} ({} tok): {}",
            t.phase, t.agent_slot, t.tokens, t.content
        );
    }
    if let Some(note) = note {
        eprintln!("note: {note}");
    }
}

/// Execute the strategy phases against the problem via the LLM conductor.
///
/// Never publishes anything partial: on any LLM failure the partial
/// transcript is printed with a note and the error propagates.
async fn execute_run(
    cfg: &ClassifierConfig,
    strategy: &TeamStrategy,
    problem: &str,
    max_tokens_per_turn: u32,
    strategy_id: &str,
    model: &str,
    backoff: Duration,
) -> Result<RunDocument, CliError> {
    strategy
        .validate()
        .map_err(|e| CliError::Other(format!("strategy failed validation at run start: {e}")))?;

    let mut run = RunDocument::new(strategy_id, problem, model);

    for (phase_idx, step) in strategy.steps.iter().enumerate() {
        for _round in 0..step.rounds {
            for slot in &step.participants {
                let ctx = phase_context(strategy, phase_idx, &run.transcript);
                let (system, user) = build_turn_messages(strategy, phase_idx, slot, problem, &ctx);
                match call_llm_with_retry_and_backoff(
                    cfg,
                    &system,
                    &user,
                    max_tokens_per_turn,
                    backoff,
                )
                .await
                {
                    Ok((content, tokens)) => {
                        run.transcript.push(Turn {
                            phase: phase_idx + 1,
                            agent_slot: slot.clone(),
                            content,
                            tokens,
                        });
                        run.total_tokens = run.total_tokens.saturating_add(tokens);
                    }
                    Err(e) => {
                        print_transcript(strategy, &run, Some(&format!(
                            "run aborted in phase {} — LLM call failed: {e}. Nothing was published.",
                            phase_idx + 1
                        )));
                        return Err(CliError::Other(format!(
                            "team run failed in phase {} — {e} (partial transcript printed; nothing published)",
                            phase_idx + 1
                        )));
                    }
                }
            }
        }

        // Summary flow: after the phase, its first participant produces the
        // shared digest (paper §2.1; deterministic pick documented above).
        if step.flow == "summary" {
            if let Some(summarizer) = step.participants.first() {
                let system = build_summary_system(strategy, phase_idx, summarizer);
                let user = format!(
                    "PROBLEM:\n{}\n\nPHASE {} CONVERSATION:\n{}",
                    problem.trim(),
                    phase_idx + 1,
                    phase_own_turns(strategy, phase_idx, &run.transcript)
                );
                match call_llm_with_retry_and_backoff(
                    cfg,
                    &system,
                    &user,
                    max_tokens_per_turn,
                    backoff,
                )
                .await
                {
                    Ok((digest, tokens)) => {
                        run.transcript.push(Turn {
                            phase: phase_idx + 1,
                            agent_slot: summarizer.clone(),
                            content: digest,
                            tokens,
                        });
                        run.total_tokens = run.total_tokens.saturating_add(tokens);
                    }
                    Err(e) => {
                        print_transcript(strategy, &run, Some(&format!(
                            "run aborted after phase {} — summary call failed: {e}. Nothing was published.",
                            phase_idx + 1
                        )));
                        return Err(CliError::Other(format!(
                            "team run failed after phase {} — summary call failed: {e} (partial transcript printed; nothing published)",
                            phase_idx + 1
                        )));
                    }
                }
            }
        }
    }

    // Final writer produces the certificate.
    let ctx = full_run_context(&run.transcript);
    let (system, user) = build_final_writer_messages(strategy, problem, &ctx);
    match call_llm_with_retry_and_backoff(cfg, &system, &user, max_tokens_per_turn, backoff).await {
        Ok((answer, tokens)) => {
            run.total_tokens = run.total_tokens.saturating_add(tokens);
            run.final_answer = answer;
        }
        Err(e) => {
            print_transcript(
                strategy,
                &run,
                Some(&format!(
                "run aborted at the final writer — LLM call failed: {e}. Nothing was published."
            )),
            );
            return Err(CliError::Other(format!(
                "team run failed at the final writer — {e} (partial transcript printed; nothing published)"
            )));
        }
    }

    Ok(run)
}

// ── Relay reads ───────────────────────────────────────────────────────────

fn tag_values(event: &Event, name: &str) -> Vec<String> {
    event
        .tags
        .iter()
        .filter_map(|tag| {
            let parts = tag.as_slice();
            (parts.first().map(String::as_str) == Some(name))
                .then(|| parts.get(1).cloned().unwrap_or_default())
        })
        .filter(|v| !v.is_empty())
        .collect()
}

/// Fetch the newest kind:44020 strategy with `d` = id (read-side LWW:
/// newest revision per `(pubkey, kind, d)` wins).
async fn fetch_strategy(client: &BuzzClient, strategy_id: &str) -> Result<TeamStrategy, CliError> {
    let filter = serde_json::json!({ "kinds": [KIND_TEAM_STRATEGY], "#d": [strategy_id] });
    let events: Vec<Event> = client
        .query_all_bounded(filter, STRATEGY_QUERY_BOUND)
        .await?
        .into_iter()
        .filter_map(|v| serde_json::from_value(v).ok())
        .collect();
    let mut best: Option<&Event> = None;
    for event in &events {
        if tag_values(event, "d").iter().any(|d| d == strategy_id) {
            let newer = match best {
                None => true,
                Some(cur) => {
                    (event.created_at, event.id.to_hex()) > (cur.created_at, cur.id.to_hex())
                }
            };
            if newer {
                best = Some(event);
            }
        }
    }
    let event = best.ok_or_else(|| {
        CliError::NotFound(format!(
            "team strategy '{strategy_id}' (kind 44020) not found on the relay"
        ))
    })?;
    let strategy: TeamStrategy = serde_json::from_str(&event.content).map_err(|e| {
        CliError::Other(format!(
            "stored strategy '{strategy_id}' is not parseable JSON: {e}"
        ))
    })?;
    strategy
        .validate()
        .map_err(|e| CliError::Other(format!("stored strategy '{strategy_id}' is invalid: {e}")))?;
    Ok(strategy)
}

// ── Commands ──────────────────────────────────────────────────────────────

/// `buzz team strategy put --id <id> --file <json> [--publish]`
///
/// Strictly validates the strategy document (schema + semantics), then
/// prints it for review or, with `--publish`, signs + publishes it as
/// kind:44020 with `d` = id (revisions replace via read-side LWW).
pub async fn cmd_strategy_put(
    client: &BuzzClient,
    id: &str,
    file: &str,
    publish: bool,
) -> Result<(), CliError> {
    let id = id.trim();
    if id.is_empty() || id.len() > 64 {
        return Err(CliError::Usage(
            "--id must be 1..=64 chars (the strategy's `d` tag)".to_string(),
        ));
    }
    let raw = std::fs::read_to_string(file)
        .map_err(|e| CliError::Usage(format!("cannot read strategy file {file:?}: {e}")))?;
    let strategy: TeamStrategy = serde_json::from_str(&raw)
        .map_err(|e| CliError::Usage(format!("strategy file is not valid JSON: {e}")))?;
    strategy
        .validate()
        .map_err(|e| CliError::Usage(format!("strategy schema violation: {e}")))?;

    let content = serde_json::to_string(&strategy)
        .map_err(|e| CliError::Other(format!("failed to serialize strategy: {e}")))?;
    if !publish {
        println!(
            "{}",
            serde_json::to_string_pretty(&strategy)
                .map_err(|e| CliError::Other(format!("failed to serialize draft: {e}")))?
        );
        println!("preview only; pass --publish to sign and publish (d={id})");
        return Ok(());
    }

    let builder =
        EventBuilder::new(Kind::Custom(KIND_TEAM_STRATEGY as u16), content)
            .tags(vec![Tag::parse(["d", id]).map_err(|e| {
                CliError::Other(format!("invalid d tag: {e}"))
            })?]);
    let event = client.sign_event(builder)?;
    let response = client.submit_event(event).await?;
    let normalized =
        parse_write_response(&response, "strategy was superseded; re-read and re-publish")?;
    println!("{normalized}");
    Ok(())
}

/// `buzz team strategy get <id>`
pub async fn cmd_strategy_get(client: &BuzzClient, id: &str) -> Result<(), CliError> {
    let strategy = fetch_strategy(client, id).await?;
    println!(
        "{}",
        serde_json::to_string_pretty(&strategy)
            .map_err(|e| CliError::Other(format!("serialization failed: {e}")))?
    );
    Ok(())
}

/// `buzz team strategy list [--limit N]`
///
/// Newest revision per `(pubkey, kind, d)`, newest events first.
pub async fn cmd_strategy_list(client: &BuzzClient, limit: Option<u32>) -> Result<(), CliError> {
    let raw_limit = limit.unwrap_or(50);
    let cap = raw_limit.min(STRATEGY_LIST_BOUND);
    let filter = serde_json::json!({ "kinds": [KIND_TEAM_STRATEGY] });
    let events: Vec<Event> = client
        .query_all_bounded(filter, cap)
        .await?
        .into_iter()
        .filter_map(|v| serde_json::from_value(v).ok())
        .collect();
    let mut by_id: BTreeMap<String, &Event> = BTreeMap::new();
    for event in events.iter() {
        let d = tag_values(event, "d")
            .into_iter()
            .next()
            .unwrap_or_default();
        if d.is_empty() {
            continue;
        }
        let replace = match by_id.get(&d) {
            None => true,
            Some(cur) => (event.created_at, event.id.to_hex()) > (cur.created_at, cur.id.to_hex()),
        };
        if replace {
            by_id.insert(d, event);
        }
    }
    let mut rows: Vec<(String, String, String)> = Vec::new();
    for (d, event) in by_id.iter() {
        let name = serde_json::from_str::<serde_json::Value>(&event.content)
            .ok()
            .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(str::to_string))
            .unwrap_or_default();
        rows.push((d.clone(), name, event.id.to_hex()));
    }
    rows.sort_by(|a, b| b.0.cmp(&a.0));
    if rows.is_empty() {
        println!("no team strategies on the relay");
        return Ok(());
    }
    for (d, name, event_id) in rows {
        println!("{d}\t{name}\t{event_id}");
    }
    Ok(())
}

/// `buzz team run --strategy <id> --problem "<text>" [--max-tokens-per-turn N] [--publish]`
///
/// Executes the strategy's phases in order (rounds, then participants in the
/// step's listed order), assembles the transcript with per-turn token usage,
/// and either prints the transcript + final answer + totals (default) or
/// publishes the kind:44022 turns + kind:44021 run (`--publish`). Always
/// bounded and fail-closed: missing env is a hard error before any network
/// call, and an LLM failure mid-run publishes nothing.
pub async fn cmd_team_run(
    client: &BuzzClient,
    strategy_id: &str,
    problem: &str,
    max_tokens_per_turn: Option<u32>,
    publish: bool,
) -> Result<(), CliError> {
    // Fail closed before any network call: no key/URL, no run.
    let cfg = conductor_config()?;
    cmd_team_run_with_config(
        client,
        &cfg,
        strategy_id,
        problem,
        RunParams {
            max_tokens_per_turn,
            publish,
            now: nostr::Timestamp::now().as_secs(),
            backoff: RATE_LIMIT_BACKOFF,
        },
    )
    .await
}

/// [`cmd_team_run`] with an injected classifier config + clock + backoff.
#[derive(Debug, Clone)]
struct RunParams {
    max_tokens_per_turn: Option<u32>,
    publish: bool,
    now: u64,
    backoff: Duration,
}

async fn cmd_team_run_with_config(
    client: &BuzzClient,
    cfg: &ClassifierConfig,
    strategy_id: &str,
    problem: &str,
    params: RunParams,
) -> Result<(), CliError> {
    let max_tokens_per_turn = params.max_tokens_per_turn;
    let publish = params.publish;
    let now = params.now;
    let backoff = params.backoff;
    let raw_tokens = max_tokens_per_turn.unwrap_or(DEFAULT_MAX_TOKENS_PER_TURN);
    if raw_tokens == 0 || raw_tokens > MAX_TOKENS_HARD_CAP {
        return Err(CliError::Usage(format!(
            "--max-tokens-per-turn must be 1..={MAX_TOKENS_HARD_CAP} (got {raw_tokens})"
        )));
    }
    let problem = problem.trim();
    if problem.is_empty() || problem.chars().count() > PROBLEM_MAX_CHARS {
        return Err(CliError::Usage(format!(
            "--problem must be 1..={PROBLEM_MAX_CHARS} chars"
        )));
    }

    let strategy = fetch_strategy(client, strategy_id).await?;
    let run = execute_run(
        cfg,
        &strategy,
        problem,
        raw_tokens,
        strategy_id,
        &cfg.model,
        backoff,
    )
    .await?;

    let run_id = build_run_id(strategy_id, now);

    if !publish {
        print_transcript(&strategy, &run, None);
        println!(
            "\nfinal answer ({} tokens total, model {}):\n{}",
            run.total_tokens, run.model, run.final_answer
        );
        println!("preview only; pass --publish to sign and publish (run d={run_id})");
        return Ok(());
    }

    // Publish turns first, then the run head: the run event is the
    // authoritative record, so it only exists once every turn persisted.
    for turn in &run.transcript {
        let turn_d = format!("{run_id}/{}/{}", turn.phase, turn.agent_slot);
        let builder = EventBuilder::new(Kind::Custom(KIND_TEAM_TURN as u16), turn.content.clone())
            .tags(vec![Tag::parse(["d", &turn_d]).map_err(|e| {
                CliError::Other(format!("invalid d tag: {e}"))
            })?]);
        let event = client.sign_event(builder)?;
        let response = client.submit_event(event).await?;
        parse_write_response(&response, "team turn was superseded; re-run")?;
    }

    let run_doc = run.clone();
    let run_content = serde_json::to_string(&run_doc)
        .map_err(|e| CliError::Other(format!("failed to serialize run: {e}")))?;
    let builder =
        EventBuilder::new(Kind::Custom(KIND_TEAM_RUN as u16), run_content)
            .tags(vec![Tag::parse(["d", &run_id]).map_err(|e| {
                CliError::Other(format!("invalid d tag: {e}"))
            })?]);
    let event = client.sign_event(builder)?;
    let response = client.submit_event(event).await?;
    let normalized = parse_write_response(&response, "team run was superseded; re-run")?;
    println!("{normalized}");
    println!(
        "published run {run_id}: {} turn(s), {} tokens, model {}",
        run.transcript.len(),
        run.total_tokens,
        run.model
    );
    Ok(())
}

// ── Seed strategies (arXiv 2609.22682, Appendix A) ────────────────────────

/// The three seeded strategies, transcribed from the paper's Appendix A
/// (AIME-2024 bank). The paper leaves most AIME roles unset ("shown when
/// set"); the SAT DSL requires a role prompt per roster slot, so slot roles
/// are derived from the strategy's own per-agent instructions where given
/// (e.g. the challenger role), and otherwise a neutral independent-solver
/// prompt matching the paper's per-agent step instructions.
pub fn seed_strategies() -> Vec<(String, TeamStrategy)> {
    vec![
        (
            "mechanistic_step_audit".to_string(),
            TeamStrategy {
                v: STRATEGY_SCHEMA_VERSION,
                name: "Mechanistic step audit".to_string(),
                description: format!(
                    "AIME-2024 bank strategy from arXiv {PAPER_ARXIV_ID} Appendix A: agents audit the mechanics of each reasoning chain before synthesis."
                ),
                teamwork_prompt: "Treat arithmetic, algebraic transformations, case splits, and counting steps as audit targets before accepting a final answer.".to_string(),
                roles: BTreeMap::from([
                    ("agent-0".to_string(), "Independent solver and step auditor. Identify one concrete step from another agent that is either verified, questionable, or incorrect.".to_string()),
                    ("agent-1".to_string(), "Independent solver and step auditor. Identify one concrete step from another agent that is either verified, questionable, or incorrect.".to_string()),
                    ("agent-2".to_string(), "Independent solver and step auditor. Identify one concrete step from another agent that is either verified, questionable, or incorrect.".to_string()),
                ]),
                steps: vec![
                    PhaseStep {
                        participants: vec!["agent-0".into(), "agent-1".into(), "agent-2".into()],
                        rounds: 1,
                        flow: "local".to_string(),
                        prompt: "Audit the reasoning chains step by step. Each agent should identify one concrete step from another agent that is either verified, questionable, or incorrect.".to_string(),
                        per_agent_prompts: None,
                    },
                    PhaseStep {
                        participants: vec!["agent-0".into(), "agent-1".into(), "agent-2".into()],
                        rounds: 1,
                        flow: "local".to_string(),
                        prompt: "Resolve the audited issues. If a step is corrected, update the downstream calculation explicitly.".to_string(),
                        per_agent_prompts: None,
                    },
                ],
                final_writer: "agent-2".to_string(),
            },
        ),
        (
            "independent_solve_then_synthesis".to_string(),
            TeamStrategy {
                v: STRATEGY_SCHEMA_VERSION,
                name: "Independent solve then synthesis".to_string(),
                description: format!(
                    "AIME-2024 bank strategy from arXiv {PAPER_ARXIV_ID} Appendix A: agents compare independent solutions, identify disagreements, and synthesize."
                ),
                teamwork_prompt: "Preserve independent reasoning. Do not converge until each agent's solution has been compared against the others.".to_string(),
                roles: BTreeMap::from([
                    ("agent-0".to_string(), "Independent solver. Name the answer you got, the main method you used, and one possible weakness in your own solution.".to_string()),
                    ("agent-1".to_string(), "Independent solver. Name the answer you got, the main method you used, and one possible weakness in your own solution.".to_string()),
                    ("agent-2".to_string(), "Independent solver. Name the answer you got, the main method you used, and one possible weakness in your own solution.".to_string()),
                ]),
                steps: vec![
                    PhaseStep {
                        participants: vec!["agent-0".into(), "agent-1".into(), "agent-2".into()],
                        rounds: 1,
                        flow: "local".to_string(),
                        prompt: "Compare the independent reasoning chains. Each agent should name the answer they got, the main method they used, and one possible weakness in their own solution.".to_string(),
                        per_agent_prompts: None,
                    },
                    PhaseStep {
                        participants: vec!["agent-0".into(), "agent-1".into(), "agent-2".into()],
                        rounds: 1,
                        flow: "summary".to_string(),
                        prompt: "Synthesize the strongest supported reasoning into a shared answer. If answers differ, resolve the disagreement using specific mathematical steps from the discussion.".to_string(),
                        per_agent_prompts: None,
                    },
                ],
                final_writer: "agent-0".to_string(),
            },
        ),
        (
            "suspicious_consensus_challenger".to_string(),
            TeamStrategy {
                v: STRATEGY_SCHEMA_VERSION,
                name: "Suspicious consensus challenger".to_string(),
                description: format!(
                    "AIME-2024 bank strategy from arXiv {PAPER_ARXIV_ID} Appendix A: if the team converges early, one agent must look for a failure mode."
                ),
                teamwork_prompt: "Consensus is not sufficient. If the team appears to agree, actively test whether the shared answer could still be wrong.".to_string(),
                roles: BTreeMap::from([
                    ("agent-0".to_string(), "Independent solver. If there is a consensus, identify the weakest link in the shared reasoning.".to_string()),
                    ("agent-1".to_string(), "Independent solver. If there is a consensus, identify the weakest link in the shared reasoning.".to_string()),
                    ("agent-2".to_string(), "You are the consensus challenger. Look for concrete failure modes before accepting the answer.".to_string()),
                ]),
                steps: vec![
                    PhaseStep {
                        participants: vec!["agent-0".into(), "agent-1".into(), "agent-2".into()],
                        rounds: 1,
                        flow: "local".to_string(),
                        prompt: "State the current consensus or disagreement. If there is a consensus, identify the weakest link in the shared reasoning.".to_string(),
                        per_agent_prompts: None,
                    },
                    PhaseStep {
                        participants: vec!["agent-0".into(), "agent-1".into(), "agent-2".into()],
                        rounds: 1,
                        flow: "local".to_string(),
                        prompt: "Agent 2 acts as consensus challenger. Try to find an alternative derivation, missing case, arithmetic error, or constraint violation. Agents 0 and 1 respond only with mathematical evidence.".to_string(),
                        per_agent_prompts: Some(HashMap::from([
                            ("agent-2".to_string(), "You are the consensus challenger. Look for concrete failure modes before accepting the answer.".to_string()),
                        ])),
                    },
                    PhaseStep {
                        participants: vec!["agent-0".into(), "agent-1".into(), "agent-2".into()],
                        rounds: 1,
                        flow: "summary".to_string(),
                        prompt: "Decide whether the challenged answer survives. If it does, state why; if not, revise using the discovered issue.".to_string(),
                        per_agent_prompts: None,
                    },
                ],
                final_writer: "agent-1".to_string(),
            },
        ),
    ]
}

/// `buzz team strategies seed-examples [--publish]`
///
/// Loads the paper's Appendix A strategies (cited above); preview prints
/// them for review, `--publish` validates + publishes each one.
pub async fn cmd_strategies_seed(client: &BuzzClient, publish: bool) -> Result<(), CliError> {
    for (id, strategy) in seed_strategies() {
        strategy
            .validate()
            .map_err(|e| CliError::Other(format!("seed {id} invalid: {e}")))?;
        let content = serde_json::to_string(&strategy)
            .map_err(|e| CliError::Other(format!("failed to serialize seed {id}: {e}")))?;
        if !publish {
            println!(
                "--- seed {id} (arXiv {PAPER_ARXIV_ID} Appendix A) ---\n{}",
                serde_json::to_string_pretty(&strategy).unwrap()
            );
            continue;
        }
        let builder = EventBuilder::new(Kind::Custom(KIND_TEAM_STRATEGY as u16), content)
            .tags(vec![Tag::parse(["d", &id]).map_err(|e| {
                CliError::Other(format!("invalid d tag: {e}"))
            })?]);
        let event = client.sign_event(builder)?;
        let response = client.submit_event(event).await?;
        let normalized = parse_write_response(&response, "seed strategy was superseded; re-seed")?;
        println!("{id}: {normalized}");
    }
    if !publish {
        println!("preview only; pass --publish to sign and publish all seeds");
    }
    Ok(())
}

/// Route `buzz team` subcommands.
pub async fn dispatch(cmd: crate::TeamCmd, client: &BuzzClient) -> Result<(), CliError> {
    use crate::{TeamCmd, TeamStrategiesCmd, TeamStrategyCmd};
    match cmd {
        TeamCmd::Run {
            strategy,
            problem,
            max_tokens_per_turn,
            publish,
        } => cmd_team_run(client, &strategy, &problem, max_tokens_per_turn, publish).await,
        TeamCmd::Strategy(sub) => match sub {
            TeamStrategyCmd::Put { id, file, publish } => {
                cmd_strategy_put(client, &id, &file, publish).await
            }
            TeamStrategyCmd::Get { id } => cmd_strategy_get(client, &id).await,
            TeamStrategyCmd::List { limit } => cmd_strategy_list(client, limit).await,
        },
        TeamCmd::Strategies(sub) => match sub {
            TeamStrategiesCmd::SeedExamples { publish } => {
                cmd_strategies_seed(client, publish).await
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::Keys;

    // ── Fixtures ───────────────────────────────────────────────────────────

    /// A minimal two-participant strategy used by most run tests.
    fn basic_strategy() -> TeamStrategy {
        TeamStrategy {
            v: STRATEGY_SCHEMA_VERSION,
            name: "Test strategy".to_string(),
            description: "For tests".to_string(),
            teamwork_prompt: "Verify everything before accepting an answer.".to_string(),
            roles: BTreeMap::from([
                (
                    "agent-0".to_string(),
                    "Solver with a numbers focus.".to_string(),
                ),
                (
                    "agent-1".to_string(),
                    "Solver with a checks focus.".to_string(),
                ),
            ]),
            steps: vec![PhaseStep {
                participants: vec!["agent-0".into(), "agent-1".into()],
                rounds: 1,
                flow: "local".to_string(),
                prompt: "Each agent states its derivation.".to_string(),
                per_agent_prompts: None,
            }],
            final_writer: "agent-0".to_string(),
        }
    }

    fn strategy_event(strategy: &TeamStrategy, id: &str) -> Event {
        EventBuilder::new(
            Kind::Custom(KIND_TEAM_STRATEGY as u16),
            serde_json::to_string(strategy).unwrap(),
        )
        .tags(vec![Tag::parse(["d", id]).expect("tag")])
        .sign_with_keys(&Keys::generate())
        .expect("signs")
    }

    fn chat_response(content: &str, total_tokens: u64) -> serde_json::Value {
        serde_json::json!({
            "choices": [{ "index": 0, "message": { "role": "assistant", "content": content } }],
            "usage": { "total_tokens": total_tokens }
        })
    }

    /// Raw-TCP mock serving the relay `/query` + `/events` endpoints and the
    /// OpenAI-compatible `/v1/chat/completions` endpoint (real HTTP, no
    /// network beyond localhost — same seam as the org_classify tests).
    #[derive(Default)]
    struct MockState {
        chat_calls: std::sync::Mutex<Vec<serde_json::Value>>,
        chat_responses:
            std::sync::Mutex<std::collections::VecDeque<Result<serde_json::Value, u16>>>,
        event_posts: std::sync::Mutex<Vec<serde_json::Value>>,
        query_response: std::sync::Mutex<Vec<serde_json::Value>>,
    }

    impl MockState {
        fn with_strategy(event: &Event) -> Self {
            let state = Self::default();
            *state.query_response.lock().unwrap() = vec![serde_json::to_value(event).unwrap()];
            state
        }

        fn push_chat(&self, response: Result<serde_json::Value, u16>) {
            self.chat_responses.lock().unwrap().push_back(response);
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
                    let mut buf = vec![0; 262_144];
                    let read = socket.read(&mut buf).await.unwrap_or(0);
                    let request = String::from_utf8_lossy(&buf[..read]);
                    let json_start = request.find("\r\n\r\n").map(|i| i + 4);
                    let body_text = json_start.map(|i| &request[i..]).unwrap_or("");
                    let (status, body) = if request.starts_with("POST /query ") {
                        let events = state.query_response.lock().unwrap().clone();
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
                            Some(Err(code)) => (
                                format!("{code} Bad Request"),
                                serde_json::json!({"error": {"message": "mock failure"}})
                                    .to_string(),
                            ),
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

    // ── Strategy schema validation ─────────────────────────────────────────

    #[test]
    fn validate_accepts_a_valid_strategy() {
        assert!(basic_strategy().validate().is_ok());
        for (id, strategy) in seed_strategies() {
            assert!(strategy.validate().is_ok(), "seed {id} must validate");
        }
    }

    #[test]
    fn validate_rejects_schema_violations() {
        // Wrong schema version.
        let mut s = basic_strategy();
        s.v = 2;
        assert!(s.validate().is_err());

        // Empty steps.
        let mut s = basic_strategy();
        s.steps = vec![];
        assert!(s.validate().is_err());

        // Too many steps (7 > 6).
        let mut s = basic_strategy();
        s.steps = vec![s.steps[0].clone(); 7];
        assert!(s.validate().is_err());

        // Participant not in roles.
        let mut s = basic_strategy();
        s.steps[0].participants = vec!["ghost".into()];
        assert!(s.validate().is_err());

        // Rounds out of range.
        let mut s = basic_strategy();
        s.steps[0].rounds = 0;
        assert!(s.validate().is_err());
        let mut s = basic_strategy();
        s.steps[0].rounds = 5;
        assert!(s.validate().is_err());

        // Bad flow enum.
        let mut s = basic_strategy();
        s.steps[0].flow = "broadcast".into();
        assert!(s.validate().is_err());

        // Final writer outside the roster.
        let mut s = basic_strategy();
        s.final_writer = "agent-9".into();
        assert!(s.validate().is_err());

        // per-agent prompt naming a non-participant.
        let mut s = basic_strategy();
        s.steps[0].per_agent_prompts = Some(HashMap::from([("agent-7".into(), "x".into())]));
        assert!(s.validate().is_err());

        // Too many roles.
        let mut s = basic_strategy();
        for i in 2..8 {
            s.roles.insert(format!("agent-{i}"), "role".into());
        }
        assert!(s.validate().is_err());
    }

    #[test]
    fn runaway_limits_match_the_paper_bounds() {
        assert_eq!(MAX_PHASES, 6);
        assert_eq!(MAX_ROUNDS, 4);
        assert_eq!(MAX_PARTICIPANTS, 6);
    }

    // ── Strategy put/get/list ──────────────────────────────────────────────

    #[tokio::test]
    async fn strategy_put_publishes_a_signed_44020_with_d_tag() {
        let state = std::sync::Arc::new(MockState::default());
        let base_url = spawn_mock(state.clone()).await;
        let keys = Keys::generate();
        let client = BuzzClient::new(base_url.clone(), keys, None, None).unwrap();

        let strategy = basic_strategy();
        let file = std::env::temp_dir().join(format!("sat-strategy-{}.json", std::process::id()));
        std::fs::write(&file, serde_json::to_string(&strategy).unwrap()).unwrap();

        let result = cmd_strategy_put(&client, "s1", file.to_str().unwrap(), true).await;
        std::fs::remove_file(&file).ok();
        assert!(result.is_ok(), "expected ok, got {result:?}");

        let posts = state.event_posts.lock().unwrap();
        assert_eq!(posts.len(), 1);
        assert_eq!(posts[0]["kind"], KIND_TEAM_STRATEGY);
        let d: Vec<String> = posts[0]["tags"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| {
                let arr = t.as_array()?;
                {
                    let first = arr.first()?.as_str()?;
                    if first == "d" {
                        Some(arr.get(1)?.as_str().unwrap_or_default().to_string())
                    } else {
                        None
                    }
                }
            })
            .collect();
        assert_eq!(d, vec!["s1".to_string()]);
        let content: serde_json::Value =
            serde_json::from_str(posts[0]["content"].as_str().unwrap()).unwrap();
        assert_eq!(content["v"], 1);
        assert_eq!(
            content["teamworkPrompt"],
            "Verify everything before accepting an answer."
        );
        assert_eq!(content["finalWriter"], "agent-0");
    }

    #[tokio::test]
    async fn strategy_put_previews_without_publishing_and_rejects_bad_files() {
        let state = std::sync::Arc::new(MockState::default());
        let base_url = spawn_mock(state.clone()).await;
        let keys = Keys::generate();
        let client = BuzzClient::new(base_url.clone(), keys, None, None).unwrap();

        let strategy = basic_strategy();
        let file =
            std::env::temp_dir().join(format!("sat-strategy-preview-{}.json", std::process::id()));
        std::fs::write(&file, serde_json::to_string(&strategy).unwrap()).unwrap();
        let result = cmd_strategy_put(&client, "s1", file.to_str().unwrap(), false).await;
        std::fs::remove_file(&file).ok();
        assert!(result.is_ok(), "preview must be ok, got {result:?}");
        assert!(state.event_posts.lock().unwrap().is_empty());

        // Invalid strategy JSON file.
        let bad =
            std::env::temp_dir().join(format!("sat-strategy-bad-{}.json", std::process::id()));
        std::fs::write(&bad, "{\"v\":1}").unwrap(); // missing required fields
        let result = cmd_strategy_put(&client, "s1", bad.to_str().unwrap(), true).await;
        std::fs::remove_file(&bad).ok();
        assert!(matches!(result, Err(CliError::Usage(_))));
        assert!(state.event_posts.lock().unwrap().is_empty());

        // Unreadable file.
        let result = cmd_strategy_put(&client, "s1", "/nonexistent/sat.json", true).await;
        assert!(matches!(result, Err(CliError::Usage(_))));
    }

    #[tokio::test]
    async fn strategy_get_reads_the_newest_revision_by_d() {
        let strategy = basic_strategy();
        let event = strategy_event(&strategy, "s1");
        let state = std::sync::Arc::new(MockState::with_strategy(&event));
        let base_url = spawn_mock(state.clone()).await;
        let keys = Keys::generate();
        let client = BuzzClient::new(base_url.clone(), keys.clone(), None, None).unwrap();
        let result = cmd_strategy_get(&client, "s1").await;
        assert!(result.is_ok(), "expected ok, got {result:?}");

        // Missing strategy → NotFound.
        let empty = std::sync::Arc::new(MockState::default());
        let base_url2 = spawn_mock(empty).await;
        let client2 = BuzzClient::new(base_url2, keys, None, None).unwrap();
        let result = cmd_strategy_get(&client2, "nope").await;
        assert!(matches!(result, Err(CliError::NotFound(_))));
    }

    // ── Run loop ───────────────────────────────────────────────────────────

    /// Run against the mock with an injected config; `now` is fixed so run
    /// ids are deterministic.
    async fn run_with_config(
        cfg: &ClassifierConfig,
        client: &BuzzClient,
        strategy_id: &str,
        problem: &str,
        publish: bool,
    ) -> Result<(), CliError> {
        cmd_team_run_with_config(
            client,
            cfg,
            strategy_id,
            problem,
            RunParams {
                max_tokens_per_turn: Some(128),
                publish,
                now: 1_700_000_000,
                backoff: Duration::from_millis(1),
            },
        )
        .await
    }

    #[tokio::test]
    async fn run_previews_transcript_and_totals_without_publishing() {
        let strategy = basic_strategy();
        let state = std::sync::Arc::new(MockState::with_strategy(&strategy_event(&strategy, "s1")));
        // 2 participant turns + 1 final writer.
        state.push_chat(Ok(chat_response("My derivation: 42", 10)));
        state.push_chat(Ok(chat_response("Checks out: 42", 12)));
        state.push_chat(Ok(chat_response("FINAL ANSWER: 42", 20)));
        let base_url = spawn_mock(state.clone()).await;
        let keys = Keys::generate();
        let client = BuzzClient::new(base_url.clone(), keys, None, None).unwrap();
        let cfg = classifier_config(&base_url);

        let result = run_with_config(&cfg, &client, "s1", "What is 6*7?", false).await;
        assert!(result.is_ok(), "expected ok, got {result:?}");

        let chats = state.chat_calls.lock().unwrap();
        assert_eq!(chats.len(), 3, "2 turns + 1 final writer");
        assert_eq!(chats[0]["model"], "test-model");
        assert_eq!(chats[0]["max_tokens"], 128);
        assert!(
            chats[0].get("response_format").is_none(),
            "turns are not JSON-shaped"
        );
        let system0 = chats[0]["messages"][0]["content"].as_str().unwrap();
        assert!(
            system0.contains("Verify everything"),
            "teamwork prompt in system"
        );
        assert!(system0.contains("agent-0"), "role identity in system");
        assert!(system0.contains("PHASE 1 of 1"), "phase prompt in system");
        let user0 = chats[0]["messages"][1]["content"].as_str().unwrap();
        assert!(user0.contains("What is 6*7?"), "problem in user");

        // Preview only: nothing published.
        assert!(state.event_posts.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn run_publishes_turns_then_the_run_head() {
        let strategy = basic_strategy();
        let state = std::sync::Arc::new(MockState::with_strategy(&strategy_event(&strategy, "s1")));
        state.push_chat(Ok(chat_response("Turn A", 5)));
        state.push_chat(Ok(chat_response("Turn B", 7)));
        state.push_chat(Ok(chat_response("FINAL ANSWER: 42", 9)));
        let base_url = spawn_mock(state.clone()).await;
        let keys = Keys::generate();
        let client = BuzzClient::new(base_url.clone(), keys, None, None).unwrap();
        let cfg = classifier_config(&base_url);

        let result = run_with_config(&cfg, &client, "s1", "6*7?", true).await;
        assert!(result.is_ok(), "expected ok, got {result:?}");

        let posts = state.event_posts.lock().unwrap();
        assert_eq!(posts.len(), 3, "2 turns + 1 run");

        // Turn events: kind 44022, d = run-id/phase/slot, content = markdown.
        let run_id = build_run_id("s1", 1_700_000_000);
        let turns: Vec<&serde_json::Value> = posts
            .iter()
            .filter(|p| p["kind"] == KIND_TEAM_TURN)
            .collect();
        assert_eq!(turns.len(), 2);
        for (turn_event, expected) in turns.iter().zip(["Turn A", "Turn B"]) {
            let d: Vec<String> = turn_event["tags"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|t| {
                    let arr = t.as_array()?;
                    let first = arr.first()?.as_str()?;
                    if first == "d" {
                        Some(arr.get(1)?.as_str().unwrap_or_default().to_string())
                    } else {
                        None
                    }
                })
                .collect();
            assert_eq!(d.len(), 1);
            assert!(d[0].starts_with(&format!("{run_id}/1/")), "d={d:?}");
            assert_eq!(turn_event["content"].as_str().unwrap(), expected);
        }

        // Run head: kind 44021, d = run id, content carries the transcript.
        let run = posts.iter().find(|p| p["kind"] == KIND_TEAM_RUN).unwrap();
        let d: Vec<String> = run["tags"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| {
                let arr = t.as_array()?;
                {
                    let first = arr.first()?.as_str()?;
                    if first == "d" {
                        Some(arr.get(1)?.as_str().unwrap_or_default().to_string())
                    } else {
                        None
                    }
                }
            })
            .collect();
        assert_eq!(d, vec![run_id.clone()]);
        let content: serde_json::Value =
            serde_json::from_str(run["content"].as_str().unwrap()).unwrap();
        assert_eq!(content["strategyId"], "s1");
        assert_eq!(content["problem"], "6*7?");
        assert_eq!(content["status"], "complete");
        assert_eq!(content["totalTokens"], 21);
        assert_eq!(content["model"], "test-model");
        assert_eq!(content["finalAnswer"], "FINAL ANSWER: 42");
        let transcript = content["transcript"].as_array().unwrap();
        // The final writer's certificate is not a transcript row in slice 1:
        // transcript = conductor turns + digests only.
        assert_eq!(transcript.len(), 2, "2 conductor turns");
        assert_eq!(transcript[0]["agentSlot"], "agent-0");
        assert_eq!(transcript[0]["tokens"], 5);
        assert_eq!(transcript[1]["agentSlot"], "agent-1");
        assert_eq!(transcript[1]["tokens"], 7);
    }

    #[tokio::test]
    async fn run_aborts_mid_run_fails_loud_and_publishes_nothing() {
        let strategy = basic_strategy();
        let state = std::sync::Arc::new(MockState::with_strategy(&strategy_event(&strategy, "s1")));
        // agent-0 ok; agent-1 fails twice (500) → loud failure after one retry.
        state.push_chat(Ok(chat_response("Turn A", 5)));
        state.push_chat(Err(500));
        state.push_chat(Err(500));
        let base_url = spawn_mock(state.clone()).await;
        let keys = Keys::generate();
        let client = BuzzClient::new(base_url.clone(), keys, None, None).unwrap();
        let cfg = classifier_config(&base_url);

        let result = run_with_config(&cfg, &client, "s1", "6*7?", true).await;
        assert!(
            matches!(&result, Err(CliError::Other(m)) if m.contains("nothing published")),
            "must fail loudly, got {result:?}"
        );
        assert_eq!(
            state.chat_calls.lock().unwrap().len(),
            3,
            "turn A + 2 attempts for the failing turn"
        );
        assert!(
            state.event_posts.lock().unwrap().is_empty(),
            "a mid-run failure must never publish anything"
        );
    }

    #[tokio::test]
    async fn run_retries_empty_content_once_then_fails_loud() {
        let strategy = basic_strategy();
        let state = std::sync::Arc::new(MockState::with_strategy(&strategy_event(&strategy, "s1")));
        // agent-0 returns empty twice → fail loud.
        state.push_chat(Ok(chat_response("", 0)));
        state.push_chat(Ok(chat_response("", 0)));
        let base_url = spawn_mock(state.clone()).await;
        let keys = Keys::generate();
        let client = BuzzClient::new(base_url.clone(), keys, None, None).unwrap();
        let cfg = classifier_config(&base_url);

        let result = run_with_config(&cfg, &client, "s1", "6*7?", false).await;
        assert!(
            matches!(&result, Err(CliError::Other(m)) if m.contains("empty content twice")),
            "got {result:?}"
        );
        assert!(state.event_posts.lock().unwrap().is_empty());
        // The empty-content retry doubled the token budget (128 → 256).
        let chats = state.chat_calls.lock().unwrap();
        assert_eq!(chats[0]["max_tokens"], 128);
        assert_eq!(chats[1]["max_tokens"], 512);
    }

    #[tokio::test]
    async fn run_recovers_when_the_retry_bump_frees_reasoning_budget() {
        let strategy = basic_strategy();
        let state = std::sync::Arc::new(MockState::with_strategy(&strategy_event(&strategy, "s1")));
        // agent-0: reasoning model burns the budget (empty content); the
        // doubled-budget retry succeeds and the run completes.
        state.push_chat(Ok(chat_response("", 0)));
        state.push_chat(Ok(chat_response("Recovered turn", 9)));
        state.push_chat(Ok(chat_response("Turn B", 7)));
        state.push_chat(Ok(chat_response("FINAL ANSWER: 42", 9)));
        let base_url = spawn_mock(state.clone()).await;
        let keys = Keys::generate();
        let client = BuzzClient::new(base_url.clone(), keys, None, None).unwrap();
        let cfg = classifier_config(&base_url);

        let result = run_with_config(&cfg, &client, "s1", "6*7?", false).await;
        assert!(result.is_ok(), "expected ok, got {result:?}");
        let chats = state.chat_calls.lock().unwrap();
        assert_eq!(chats[1]["max_tokens"], 512, "retry runs a 4x budget");
    }

    #[tokio::test]
    async fn run_backs_off_on_429_then_retries_once() {
        let strategy = basic_strategy();
        let state = std::sync::Arc::new(MockState::with_strategy(&strategy_event(&strategy, "s1")));
        // agent-0: 429 (limiter) → backoff → retry ok.
        state.push_chat(Err(429));
        state.push_chat(Ok(chat_response("Turn A", 5)));
        // agent-1 ok.
        state.push_chat(Ok(chat_response("Turn B", 7)));
        // final writer ok.
        state.push_chat(Ok(chat_response("FINAL ANSWER: 42", 9)));
        let base_url = spawn_mock(state.clone()).await;
        let keys = Keys::generate();
        let client = BuzzClient::new(base_url.clone(), keys, None, None).unwrap();
        let cfg = classifier_config(&base_url);

        let result = run_with_config(&cfg, &client, "s1", "6*7?", false).await;
        assert!(result.is_ok(), "expected ok, got {result:?}");
        let chats = state.chat_calls.lock().unwrap();
        assert_eq!(chats.len(), 4, "429 retry + turn A + turn B + final writer");
    }

    #[tokio::test]
    async fn run_requires_an_existing_strategy() {
        let state = std::sync::Arc::new(MockState::default()); // no strategy
        let base_url = spawn_mock(state.clone()).await;
        let keys = Keys::generate();
        let client = BuzzClient::new(base_url.clone(), keys, None, None).unwrap();
        let cfg = classifier_config(&base_url);
        let result = run_with_config(&cfg, &client, "missing", "6*7?", false).await;
        assert!(matches!(result, Err(CliError::NotFound(_))));
        assert!(
            state.chat_calls.lock().unwrap().is_empty(),
            "no LLM calls without a strategy"
        );
    }

    #[test]
    fn run_fails_closed_without_classifier_config() {
        // The env-required path must fail with a Usage error when the key is
        // absent (deterministic via the provider seam; the process env is
        // never mutated).
        let missing_key = crate::commands::org_classify::classifier_config_from_provider(|name| {
            (name == crate::commands::org_classify::ENV_CLASSIFIER_API_URL)
                .then(|| "https://llm.example/v1".to_string())
        });
        assert!(
            matches!(&missing_key, Err(CliError::Usage(m)) if m.contains("API_KEY")),
            "got {missing_key:?}"
        );
    }

    #[test]
    fn run_id_is_bounded_and_deterministic() {
        let id = build_run_id("mechanistic_step_audit", 1_700_000_000);
        assert_eq!(id, "mechanistic_step_audit-1700000000");
        assert!(id.len() <= 64);

        let long = build_run_id(&"x".repeat(200), 1);
        assert!(
            long.len() <= 64,
            "run id must fit the relay d cap, got {long}"
        );
        assert!(long.ends_with("-1"));
    }

    #[tokio::test]
    async fn max_tokens_flag_is_validated_before_any_network() {
        let cfg = classifier_config("http://unused/v1");
        let client = BuzzClient::new("http://unused".into(), Keys::generate(), None, None).unwrap();
        // 0 and above the hard cap are rejected; validation runs before any
        // relay/LLM network call, so no mock is needed.
        let result = cmd_team_run_with_config(
            &client,
            &cfg,
            "s1",
            "p",
            RunParams {
                max_tokens_per_turn: Some(0),
                publish: false,
                now: 1,
                backoff: Duration::from_secs(1),
            },
        )
        .await;
        assert!(matches!(result, Err(CliError::Usage(_))));
        let result = cmd_team_run_with_config(
            &client,
            &cfg,
            "s1",
            "p",
            RunParams {
                max_tokens_per_turn: Some(MAX_TOKENS_HARD_CAP + 1),
                publish: false,
                now: 1,
                backoff: Duration::from_secs(1),
            },
        )
        .await;
        assert!(matches!(result, Err(CliError::Usage(_))));
    }

    // ── Context flow (local vs summary) ────────────────────────────────────

    #[test]
    fn local_flow_keeps_phase_turns_among_participants() {
        // Phase 1: agent-0 only. Phase 2: agent-1 only. Agent-1 must NOT see
        // agent-0's phase-1 turn (local flow).
        let mut strategy = basic_strategy();
        strategy.steps = vec![
            PhaseStep {
                participants: vec!["agent-0".into()],
                rounds: 1,
                flow: "local".to_string(),
                prompt: "P1".to_string(),
                per_agent_prompts: None,
            },
            PhaseStep {
                participants: vec!["agent-1".into()],
                rounds: 1,
                flow: "local".to_string(),
                prompt: "P2".to_string(),
                per_agent_prompts: None,
            },
        ];
        let turns = vec![Turn {
            phase: 1,
            agent_slot: "agent-0".into(),
            content: "AGENT0-SECRET".into(),
            tokens: 1,
        }];
        let ctx = phase_context(&strategy, 1, &turns);
        assert!(
            !ctx.contains("AGENT0-SECRET"),
            "local flow must not leak: {ctx}"
        );
        assert!(
            !ctx.contains("CURRENT PHASE 2"),
            "no turns yet for phase 2 (agent-1 has not spoken): {ctx}"
        );
    }

    #[test]
    fn summary_flow_shares_the_digest_but_not_raw_turns() {
        // Phase 1: summary flow, agent-0. Phase 2: agent-1. Agent-1 must see
        // the phase-1 DIGEST but not agent-0's raw phase-1 turn.
        let mut strategy = basic_strategy();
        strategy.steps = vec![
            PhaseStep {
                participants: vec!["agent-0".into()],
                rounds: 1,
                flow: "summary".to_string(),
                prompt: "P1".to_string(),
                per_agent_prompts: None,
            },
            PhaseStep {
                participants: vec!["agent-1".into()],
                rounds: 1,
                flow: "local".to_string(),
                prompt: "P2".to_string(),
                per_agent_prompts: None,
            },
        ];
        let turns = vec![
            Turn {
                phase: 1,
                agent_slot: "agent-0".into(),
                content: "AGENT0-SECRET".into(),
                tokens: 1,
            },
            Turn {
                phase: 1,
                agent_slot: "agent-0".into(),
                content: "DIGEST: 42".into(),
                tokens: 1,
            },
        ];
        let ctx = phase_context(&strategy, 1, &turns);
        assert!(ctx.contains("DIGEST: 42"), "digest must be shared: {ctx}");
        assert!(
            !ctx.contains("AGENT0-SECRET"),
            "raw turns must stay local: {ctx}"
        );
    }

    #[tokio::test]
    async fn run_processes_summary_flow_with_a_digest_turn() {
        // 1 participant, 1 summary phase, 1 round → turn + digest + final.
        let mut strategy = basic_strategy();
        strategy.steps[0].flow = "summary".to_string();
        strategy.steps[0].participants = vec!["agent-0".into()];
        let state = std::sync::Arc::new(MockState::with_strategy(&strategy_event(&strategy, "s1")));
        state.push_chat(Ok(chat_response("Turn only", 3)));
        state.push_chat(Ok(chat_response("Digest: X", 4)));
        state.push_chat(Ok(chat_response("FINAL ANSWER: X", 5)));
        let base_url = spawn_mock(state.clone()).await;
        let keys = Keys::generate();
        let client = BuzzClient::new(base_url.clone(), keys, None, None).unwrap();
        let cfg = classifier_config(&base_url);

        let result = run_with_config(&cfg, &client, "s1", "P", true).await;
        assert!(result.is_ok(), "expected ok, got {result:?}");
        let posts = state.event_posts.lock().unwrap();
        assert_eq!(posts.len(), 3, "turn + digest (both 44022) + run (44021)");
        let run = posts.iter().find(|p| p["kind"] == KIND_TEAM_RUN).unwrap();
        let content: serde_json::Value =
            serde_json::from_str(run["content"].as_str().unwrap()).unwrap();
        let transcript = content["transcript"].as_array().unwrap();
        assert_eq!(transcript.len(), 2);
        assert_eq!(transcript[1]["content"], "Digest: X");
        assert_eq!(content["totalTokens"], 12);
    }

    #[test]
    fn seed_strategies_cite_the_paper() {
        for (id, strategy) in seed_strategies() {
            assert!(
                strategy.description.contains(PAPER_ARXIV_ID),
                "seed {id} must cite arXiv {PAPER_ARXIV_ID}"
            );
        }
    }
}
