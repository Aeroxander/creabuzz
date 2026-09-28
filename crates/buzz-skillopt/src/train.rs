//! The SkillOpt training loop (arXiv:2605.23904, Algorithm 1) — the skill
//! document as the trainable state of a frozen agent.
//!
//! Per step: rollout (target executes the batch) → reflect (failure/success
//! analysts per minibatch) → aggregate (hierarchical merges) → select
//! (ranking, clipped to the textual learning rate `L_t`) → update (bounded
//! edits applied) → gate (held-out selection score must strictly improve;
//! rejects land in the rejected buffer). At the epoch boundary: the slow
//! update rewrites the protected section from a longitudinal comparison, and
//! from epoch 2 the meta skill updates the optimizer's own memory.
//!
//! LLM-touching stages sit behind [`Optimizer`]; rollouts behind [`Target`];
//! scoring behind [`Scorer`]. Everything else is deterministic and golden-
//! tested. Defaults match `configs/_base_/default.yaml` (see
//! docs/skillopt-port.md for the full fidelity map).

use crate::buffer::{RejectedBuffer, RejectedEntry};
use crate::edit::{resolve_conflicts, EditOp, MergedEdit, SkillDoc};
use crate::gate::{composite_score, gate_accepts, GateConfig};
use crate::schedule::{learning_rate, Scheduler};

/// One rollout: the target's trajectory on a task under a skill.
#[derive(Debug, Clone, PartialEq)]
pub struct Trajectory {
    pub task: String,
    pub success: bool,
    pub output: String,
    /// Per-task hard score (the benchmark's metric for this one task).
    pub score: f64,
}

/// A benchmark task (rollout input).
#[derive(Debug, Clone, PartialEq)]
pub struct Task {
    pub id: String,
    pub prompt: String,
}

/// What one analyst call receives (the `analyst_*.md` contracts).
pub struct AnalysisRequest<'a> {
    pub skill: &'a str,
    pub trajectories: &'a [Trajectory],
    /// The maximum number of edits (the budget `L`) — at most `L` edits.
    pub budget: usize,
    /// The optimizer's own memory (`m_meta`), once epoch 2 starts.
    pub memory: Option<&'a str>,
    /// The rejected-edit buffer note (do-not-repeat).
    pub buffer_note: &'a str,
}

/// One analyst patch (the `analyst_*.md` JSON `patch` + its notes field).
#[derive(Debug, Clone, PartialEq)]
pub struct Patch {
    pub reasoning: String,
    pub edits: Vec<EditOp>,
    /// `failure_summary` / `success_patterns`, carried for the buffer and
    /// merge context.
    pub notes: String,
}

/// The longitudinal epoch comparison fed to slow update / meta skill.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Longitudinal {
    /// Tasks that worked under the previous epoch's skill and broke now.
    pub regressions: Vec<String>,
    /// Tasks failing under both skills.
    pub persistent_failures: Vec<String>,
    /// Tasks that started working this epoch.
    pub improvements: Vec<String>,
    /// Tasks working under both skills.
    pub stable_successes: Vec<String>,
}

pub struct LongitudinalRequest<'a> {
    pub prev_skill: &'a str,
    pub curr_skill: &'a str,
    pub comparison: &'a Longitudinal,
    /// Previous guidance (`slow_update`) or memory (`meta_skill`).
    pub previous: Option<&'a str>,
}

/// The eight optimizer-model stages (Appendix C.2 prompt contracts).
pub trait Optimizer {
    fn analyze_error(&mut self, req: &AnalysisRequest<'_>) -> Result<Patch, String>;
    fn analyze_success(&mut self, req: &AnalysisRequest<'_>) -> Result<Patch, String>;
    fn merge_failure(&mut self, skill: &str, patches: &[Patch]) -> Result<Vec<MergedEdit>, String>;
    fn merge_success(&mut self, skill: &str, patches: &[Patch]) -> Result<Vec<MergedEdit>, String>;
    fn merge_final(
        &mut self,
        skill: &str,
        failure: &[MergedEdit],
        success: &[MergedEdit],
    ) -> Result<Vec<MergedEdit>, String>;
    /// Return pool indices in priority order (the `ranking.md` contract).
    fn rank(&mut self, skill: &str, pool: &[MergedEdit], select: usize) -> Result<Vec<usize>, String>;
    fn slow_update(&mut self, req: &LongitudinalRequest<'_>) -> Result<String, String>;
    fn meta_skill(&mut self, req: &LongitudinalRequest<'_>) -> Result<String, String>;
}

/// The frozen task-execution model (only the skill text ever changes).
pub trait Target {
    fn rollout(&mut self, skill: &SkillDoc, task: &Task) -> Trajectory;
}

/// The benchmark's scoring: aggregate a split's trajectories into
/// (hard, soft) scores.
pub trait Scorer {
    fn score(&mut self, skill: &SkillDoc, trajectories: &[Trajectory]) -> (f64, f64);
}

/// Which pairs feed the longitudinal comparison.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LongitudinalPairPolicy {
    /// Both changed and unchanged pairs (the default).
    Mixed,
    /// Only tasks whose outcome changed.
    Changed,
    /// Only tasks whose outcome stayed the same.
    Unchanged,
}

/// Training configuration — defaults verbatim from the shipped base config.
#[derive(Debug, Clone, PartialEq)]
pub struct TrainConfig {
    pub num_epochs: usize,
    pub batch_size: usize,
    pub accumulation: usize,
    pub minibatch_size: usize,
    pub merge_batch_size: usize,
    pub failure_only: bool,
    pub learning_rate0: usize,
    pub min_learning_rate: usize,
    pub scheduler: Scheduler,
    pub use_slow_update: bool,
    pub slow_update_samples: usize,
    pub slow_update_gate_with_selection: bool,
    pub longitudinal_pair_policy: LongitudinalPairPolicy,
    pub use_meta_skill: bool,
    pub gate: GateConfig,
    /// 0 = the full split.
    pub sel_env_num: usize,
    pub eval_test: bool,
    pub seed: u64,
}

impl Default for TrainConfig {
    fn default() -> Self {
        Self {
            num_epochs: 4,
            batch_size: 40,
            accumulation: 1,
            minibatch_size: 8,
            merge_batch_size: 8,
            failure_only: false,
            learning_rate0: 4,
            min_learning_rate: 2,
            scheduler: Scheduler::Cosine,
            use_slow_update: true,
            slow_update_samples: 20,
            slow_update_gate_with_selection: false,
            longitudinal_pair_policy: LongitudinalPairPolicy::Mixed,
            use_meta_skill: true,
            gate: GateConfig::default(),
            sel_env_num: 0,
            eval_test: true,
            seed: 42,
        }
    }
}

/// Per-step receipts (the observability the house discipline expects).
#[derive(Debug, Clone, PartialEq)]
pub struct StepRecord {
    pub epoch: usize,
    pub step: usize,
    pub learning_rate: usize,
    pub proposed: usize,
    pub selected: usize,
    pub applied: usize,
    pub accepted: bool,
    pub score: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TrainResult {
    pub best_skill: SkillDoc,
    pub best_selection_score: f64,
    pub test_score: Option<f64>,
    pub history: Vec<StepRecord>,
    /// The end-of-run rejected-edit buffer (the do-not-repeat material for
    /// the next run) — the run receipt's honest record of what was refused.
    pub buffer: Vec<crate::buffer::RejectedEntry>,
}

fn xorshift(state: &mut u64) -> u64 {
    let mut x = *state;
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    *state = x;
    x
}

fn sample<T: Clone>(items: &[T], n: usize, seed: &mut u64) -> Vec<T> {
    let mut pool: Vec<T> = items.to_vec();
    for i in (1..pool.len()).rev() {
        let j = (xorshift(seed) % (i as u64 + 1)) as usize;
        pool.swap(i, j);
    }
    pool.truncate(n.min(pool.len()));
    pool
}

/// Evaluate a skill on a split (Algorithm 1's `Evaluate`): rollout every
/// task, aggregate with the scorer → (hard, soft).
pub fn evaluate(
    target: &mut impl Target,
    scorer: &mut impl Scorer,
    skill: &SkillDoc,
    split: &[Task],
) -> (f64, f64) {
    let trajectories: Vec<Trajectory> = split
        .iter()
        .map(|task| target.rollout(skill, task))
        .collect();
    scorer.score(skill, &trajectories)
}

/// The epoch-boundary longitudinal comparison (the slow-update/meta-skill
/// input): the same tasks rolled out under both consecutive skills,
/// categorized per the paper and filtered by the pair policy.
pub fn longitudinal(
    target: &mut impl Target,
    prev: &SkillDoc,
    curr: &SkillDoc,
    tasks: &[Task],
    policy: LongitudinalPairPolicy,
) -> Longitudinal {
    let mut out = Longitudinal::default();
    for task in tasks {
        let before = target.rollout(prev, task);
        let after = target.rollout(curr, task);
        let changed = before.success != after.success;
        let keep = match policy {
            LongitudinalPairPolicy::Mixed => true,
            LongitudinalPairPolicy::Changed => changed,
            LongitudinalPairPolicy::Unchanged => !changed,
        };
        if !keep {
            continue;
        }
        let label = task.id.clone();
        match (before.success, after.success) {
            (true, false) => out.regressions.push(label),
            (false, false) => out.persistent_failures.push(label),
            (false, true) => out.improvements.push(label),
            (true, true) => out.stable_successes.push(label),
        }
    }
    out
}

/// Hierarchical merge (design principle 3): merge patches in
/// `merge_batch_size` groups; each group's merged edits become one synthetic
/// patch for the next round, until one merged set remains. Inter-round
/// support metadata rides in `Patch.notes` (serialized merged edits) so the
/// merge prompts can "carry forward support_count" exactly as instructed.
fn hierarchical_merge(
    optimizer: &mut impl Optimizer,
    skill: &str,
    patches: Vec<Patch>,
    merge_batch_size: usize,
    failure: bool,
) -> Result<Vec<MergedEdit>, String> {
    if patches.is_empty() {
        return Ok(Vec::new());
    }
    let mut layer: Vec<Patch> = patches;
    loop {
        let size = merge_batch_size.max(1);
        let mut round_sets: Vec<Vec<MergedEdit>> = Vec::new();
        for group in layer.chunks(size) {
            let merged = if failure {
                optimizer.merge_failure(skill, group)?
            } else {
                optimizer.merge_success(skill, group)?
            };
            round_sets.push(merged);
        }
        if round_sets.len() == 1 {
            return Ok(round_sets.pop().expect("checked above"));
        }
        layer = round_sets
            .into_iter()
            .map(|edits| Patch {
                reasoning: "hierarchical merge".into(),
                notes: serde_json::to_string(&edits).unwrap_or_default(),
                edits: edits.iter().map(|m| m.op.clone()).collect(),
            })
            .collect();
    }
}

/// Run Algorithm 1. Deterministic given scripted ports and `config.seed`.
pub fn train(
    config: &TrainConfig,
    init_skill: SkillDoc,
    train_set: &[Task],
    sel_split: &[Task],
    test_split: &[Task],
    optimizer: &mut impl Optimizer,
    target: &mut impl Target,
    scorer: &mut impl Scorer,
) -> Result<TrainResult, String> {
    let mut seed = config.seed.max(1);
    let mut current = init_skill.clone();
    let mut best = current.clone();
    let (mut best_hard, mut best_soft) = evaluate(target, scorer, &current, sel_split);
    let mut best_score = composite_score(best_hard, best_soft, current.as_str(), &config.gate);
    let mut buffer = RejectedBuffer::default();
    let mut memory: Option<String> = None;
    let mut history: Vec<StepRecord> = Vec::new();

    let per_step = config.batch_size * config.accumulation.max(1);
    let steps_per_epoch = train_set.len().div_ceil(per_step.max(1)).max(1);
    let total_steps = steps_per_epoch * config.num_epochs;
    let mut global_step = 0usize;

    for epoch in 0..config.num_epochs {
        let epoch_start_skill = current.clone();
        for step in 0..steps_per_epoch {
            let l_t = learning_rate(
                config.scheduler,
                global_step,
                total_steps,
                config.learning_rate0,
                config.min_learning_rate,
            );

            // Forward pass: accumulate rollout rounds over the batch.
            let mut trajectories: Vec<Trajectory> = Vec::new();
            for round in 0..config.accumulation.max(1) {
                let tasks = sample(
                    train_set,
                    config.batch_size,
                    &mut (seed ^ ((epoch as u64) << 32) ^ (step as u64) << 8 ^ round as u64),
                );
                for task in &tasks {
                    trajectories.push(target.rollout(&current, task));
                }
            }

            // Backward pass: reflect per minibatch (failure + success).
            let mut failure_patches: Vec<Patch> = Vec::new();
            let mut success_patches: Vec<Patch> = Vec::new();
            for minibatch in trajectories.chunks(config.minibatch_size.max(1)) {
                let failures: Vec<Trajectory> = minibatch
                    .iter()
                    .filter(|t| !t.success)
                    .cloned()
                    .collect();
                let successes: Vec<Trajectory> =
                    minibatch.iter().filter(|t| t.success).cloned().collect();
                let request = AnalysisRequest {
                    skill: current.as_str(),
                    trajectories: &failures,
                    budget: l_t,
                    memory: memory.as_deref(),
                    buffer_note: &buffer.prompt_note(),
                };
                if !failures.is_empty() {
                    failure_patches.push(optimizer.analyze_error(&request)?);
                }
                if !config.failure_only && !successes.is_empty() {
                    let request = AnalysisRequest {
                        skill: current.as_str(),
                        trajectories: &successes,
                        budget: l_t,
                        memory: memory.as_deref(),
                        buffer_note: &buffer.prompt_note(),
                    };
                    success_patches.push(optimizer.analyze_success(&request)?);
                }
            }

            // Aggregate: hierarchical merges + the final merge + conflicts.
            let failure_summary: String = failure_patches
                .iter()
                .map(|p| p.notes.as_str())
                .collect::<Vec<_>>()
                .join("; ");
            let merged_failure = hierarchical_merge(
                optimizer,
                current.as_str(),
                failure_patches.clone(),
                config.merge_batch_size,
                true,
            )?;
            let merged_success = hierarchical_merge(
                optimizer,
                current.as_str(),
                success_patches.clone(),
                config.merge_batch_size,
                false,
            )?;
            let mut pool = optimizer.merge_final(
                current.as_str(),
                &merged_failure,
                &merged_success,
            )?;
            pool = resolve_conflicts(pool);

            // Select: rank and clip to the textual learning rate.
            let want = l_t.min(pool.len());
            let mut selected: Vec<MergedEdit> = Vec::new();
            if want > 0 {
                let indices = optimizer.rank(current.as_str(), &pool, want)?;
                for index in indices.into_iter().take(want) {
                    if let Some(edit) = pool.get(index) {
                        selected.push(edit.clone());
                    }
                }
            }

            // Update: bounded edits, strictly valid application.
            let mut candidate = current.clone();
            let mut applied = 0usize;
            let mut valid_edits: Vec<MergedEdit> = Vec::new();
            for edit in &selected {
                match candidate.apply(&edit.op) {
                    Ok(next) => {
                        candidate = next;
                        applied += 1;
                        valid_edits.push(edit.clone());
                    }
                    Err(_) => {
                        // Invalid edits are buffered, never guessed at.
                        buffer.record(RejectedEntry {
                            edits: vec![edit.clone()],
                            failure_patterns: "edit did not apply cleanly".into(),
                        });
                    }
                }
            }

            // Gate on the held-out selection split.
            let (hard, soft) = evaluate(target, scorer, &candidate, sel_split);
            let score = composite_score(hard, soft, candidate.as_str(), &config.gate);
            let accepted = applied > 0 && gate_accepts(&config.gate, score, best_score);
            if accepted {
                current = candidate;
                (best_hard, best_soft) = (hard, soft);
                best_score = score;
                best = current.clone();
            } else {
                buffer.record(RejectedEntry {
                    edits: valid_edits,
                    failure_patterns: if failure_summary.is_empty() {
                        "no improvement on the selection split".into()
                    } else {
                        failure_summary.clone()
                    },
                });
            }
            history.push(StepRecord {
                epoch,
                step,
                learning_rate: l_t,
                proposed: pool.len(),
                selected: selected.len(),
                applied,
                accepted,
                score,
            });
            global_step += 1;
        }

        // Epoch boundary: slow update (protected section) then meta skill.
        let comparison = longitudinal(
            target,
            &epoch_start_skill,
            &current,
            &sample(train_set, config.slow_update_samples, &mut seed),
            config.longitudinal_pair_policy,
        );
        if config.use_slow_update {
            let previous = current
                .as_str()
                .split("<!-- SLOW_UPDATE_START -->")
                .nth(1)
                .map(|s| s.split("<!-- SLOW_UPDATE_END -->").next().unwrap_or("").trim().to_string());
            let guidance = optimizer.slow_update(&LongitudinalRequest {
                prev_skill: epoch_start_skill.as_str(),
                curr_skill: current.as_str(),
                comparison: &comparison,
                previous: previous.as_deref(),
            })?;
            let candidate = current.with_slow_update(&guidance);
            if config.slow_update_gate_with_selection {
                let (hard, soft) = evaluate(target, scorer, &candidate, sel_split);
                let score = composite_score(hard, soft, candidate.as_str(), &config.gate);
                if gate_accepts(&config.gate, score, best_score) {
                    (best_hard, best_soft) = (hard, soft);
                    best_score = score;
                    current = candidate;
                    best = current.clone();
                }
            } else {
                current = candidate;
                best = current.clone();
            }
        }
        if config.use_meta_skill && epoch + 1 >= 2 {
            memory = Some(optimizer.meta_skill(&LongitudinalRequest {
                prev_skill: epoch_start_skill.as_str(),
                curr_skill: current.as_str(),
                comparison: &comparison,
                previous: memory.as_deref(),
            })?);
        }
    }

    let test_score = if config.eval_test && !test_split.is_empty() {
        let (hard, soft) = evaluate(target, scorer, &best, test_split);
        Some(composite_score(hard, soft, best.as_str(), &config.gate))
    } else {
        None
    };
    let _ = (best_hard, best_soft);
    Ok(TrainResult {
        best_skill: best,
        best_selection_score: best_score,
        test_score,
        history,
        buffer: buffer.entries().to_vec(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::edit::{SourceType, SLOW_UPDATE_END, SLOW_UPDATE_START};

    /// A scripted optimizer: proposes the one edit that fixes the scripted
    /// world, remembers what it was asked, and counts its stages.
    #[derive(Default)]
    struct ScriptedOptimizer {
        fix: String,
        harmful: bool,
        calls: Vec<String>,
        saw_buffer_note: bool,
    }

    impl Optimizer for ScriptedOptimizer {
        fn analyze_error(&mut self, req: &AnalysisRequest<'_>) -> Result<Patch, String> {
            self.calls.push(format!("analyze_error:{}", req.trajectories.len()));
            if !req.buffer_note.is_empty() {
                self.saw_buffer_note = true;
            }
            Ok(Patch {
                reasoning: "common failure".into(),
                edits: vec![if self.harmful {
                    EditOp::Append {
                        content: "HARMFUL RULE".into(),
                    }
                } else {
                    EditOp::Append {
                        content: self.fix.clone(),
                    }
                }],
                notes: "tasks fail without the fix".into(),
            })
        }
        fn analyze_success(&mut self, req: &AnalysisRequest<'_>) -> Result<Patch, String> {
            self.calls.push(format!("analyze_success:{}", req.trajectories.len()));
            if !req.buffer_note.is_empty() {
                self.saw_buffer_note = true;
            }
            Ok(Patch {
                reasoning: "keep it".into(),
                edits: if self.harmful {
                    vec![EditOp::Append {
                        content: "HARMFUL RULE".into(),
                    }]
                } else {
                    vec![]
                },
                notes: String::new(),
            })
        }
        fn merge_failure(
            &mut self,
            _skill: &str,
            patches: &[Patch],
        ) -> Result<Vec<MergedEdit>, String> {
            self.calls.push(format!("merge_failure:{}", patches.len()));
            Ok(patches
                .iter()
                .flat_map(|p| p.edits.iter())
                .map(|op| MergedEdit {
                    op: op.clone(),
                    support_count: 2,
                    source_type: SourceType::Failure,
                })
                .collect())
        }
        fn merge_success(
            &mut self,
            _skill: &str,
            patches: &[Patch],
        ) -> Result<Vec<MergedEdit>, String> {
            self.calls.push(format!("merge_success:{}", patches.len()));
            let _ = patches;
            Ok(vec![])
        }
        fn merge_final(
            &mut self,
            _skill: &str,
            failure: &[MergedEdit],
            success: &[MergedEdit],
        ) -> Result<Vec<MergedEdit>, String> {
            self.calls.push("merge_final".into());
            Ok(failure.iter().chain(success.iter()).cloned().collect())
        }
        fn rank(
            &mut self,
            _skill: &str,
            pool: &[MergedEdit],
            select: usize,
        ) -> Result<Vec<usize>, String> {
            self.calls.push(format!("rank:{select}"));
            Ok((0..pool.len().min(select)).collect())
        }
        fn slow_update(&mut self, req: &LongitudinalRequest<'_>) -> Result<String, String> {
            self.calls.push(format!(
                "slow_update:prev={}",
                req.previous.is_some()
            ));
            Ok("Prevent regressions first.".into())
        }
        fn meta_skill(&mut self, req: &LongitudinalRequest<'_>) -> Result<String, String> {
            self.calls
                .push(format!("meta_skill:prev={}", req.previous.is_some()));
            Ok("Prefer concrete edits over vague advice.".into())
        }
    }

    /// A world where tasks succeed only when the skill contains `fix` — and
    /// degrade to zero the moment the harmful rule is present.
    struct ScriptedTarget {
        fix: String,
    }

    impl Target for ScriptedTarget {
        fn rollout(&mut self, skill: &SkillDoc, task: &Task) -> Trajectory {
            let success = skill.as_str().contains(&self.fix)
                && !skill.as_str().contains("HARMFUL RULE");
            Trajectory {
                task: task.id.clone(),
                success,
                output: if success { "ok" } else { "miss" }.into(),
                score: if success { 1.0 } else { 0.0 },
            }
        }
    }

    struct AccuracyScorer;

    impl Scorer for AccuracyScorer {
        fn score(&mut self, _skill: &SkillDoc, trajectories: &[Trajectory]) -> (f64, f64) {
            let hard = trajectories.iter().filter(|t| t.success).count() as f64
                / trajectories.len().max(1) as f64;
            (hard, hard)
        }
    }

    fn tasks(n: usize) -> Vec<Task> {
        (0..n)
            .map(|i| Task {
                id: format!("t{i}"),
                prompt: format!("task {i}"),
            })
            .collect()
    }

    fn fixture_world() -> (ScriptedOptimizer, ScriptedTarget) {
        (
            ScriptedOptimizer {
                fix: "FIX-MARKER".into(),
                harmful: false,
                calls: vec![],
                saw_buffer_note: false,
            },
            ScriptedTarget {
                fix: "FIX-MARKER".into(),
            },
        )
    }

    #[test]
    fn the_learner_discovers_the_fix_and_the_gate_accepts_it() {
        let config = TrainConfig {
            num_epochs: 1,
            batch_size: 8,
            minibatch_size: 4,
            use_slow_update: false,
            use_meta_skill: false,
            eval_test: true,
            ..TrainConfig::default()
        };
        let (mut optimizer, mut target) = fixture_world();
        let mut scorer = AccuracyScorer;
        let result = train(
            &config,
            SkillDoc::new("# Skill\nBase rules.\n"),
            &tasks(8),
            &tasks(4),
            &tasks(4),
            &mut optimizer,
            &mut target,
            &mut scorer,
        )
        .expect("trains");
        assert!(
            result.best_skill.as_str().contains("FIX-MARKER"),
            "the accepted edit lands in the best skill"
        );
        assert_eq!(result.best_selection_score, 1.0);
        assert_eq!(result.test_score, Some(1.0), "held-out agrees");
        assert!(result.history.iter().any(|s| s.accepted));
        // The full stage battery ran: analysts, hierarchical merges, final, rank.
        for stage in ["analyze_error", "merge_failure", "merge_final", "rank"] {
            assert!(
                optimizer.calls.iter().any(|c| c.starts_with(stage)),
                "missing stage {stage}: {:?}",
                optimizer.calls
            );
        }
    }

    #[test]
    fn a_harmful_edit_is_rejected_and_buffered_not_kept() {
        let config = TrainConfig {
            num_epochs: 1,
            batch_size: 4,
            minibatch_size: 4,
            use_slow_update: false,
            use_meta_skill: false,
            eval_test: false,
            ..TrainConfig::default()
        };
        // Start from the fixed skill so the harmful edit can only degrade it.
        let (mut optimizer, mut target) = fixture_world();
        optimizer.harmful = true;
        let mut scorer = AccuracyScorer;
        let result = train(
            &config,
            SkillDoc::new("# Skill\nFIX-MARKER\n"),
            &tasks(8),
            &tasks(4),
            &[],
            &mut optimizer,
            &mut target,
            &mut scorer,
        )
        .expect("trains");
        assert!(
            !result.best_skill.as_str().contains("HARMFUL RULE"),
            "rejected edits never reach the best skill"
        );
        assert!(result.history.iter().all(|s| !s.accepted));
        // Two steps: the first rejection is visible as a do-not-repeat note in
        // the second step's reflection request (C.3's buffer semantics).
        assert!(optimizer.saw_buffer_note, "buffer feeds later optimizer calls");
    }

    #[test]
    fn epoch_boundary_writes_the_protected_section_and_meta_memory() {
        let config = TrainConfig {
            num_epochs: 2,
            batch_size: 4,
            minibatch_size: 4,
            learning_rate0: 2,
            min_learning_rate: 2,
            scheduler: Scheduler::Constant,
            use_slow_update: true,
            use_meta_skill: true,
            slow_update_samples: 4,
            eval_test: false,
            ..TrainConfig::default()
        };
        let (mut optimizer, mut target) = fixture_world();
        let mut scorer = AccuracyScorer;
        let init = format!(
            "# Skill\nBase.\n{SLOW_UPDATE_START}\nold\n{SLOW_UPDATE_END}\n"
        );
        let result = train(
            &config,
            SkillDoc::new(init),
            &tasks(8),
            &tasks(4),
            &[],
            &mut optimizer,
            &mut target,
            &mut scorer,
        )
        .expect("trains");
        assert!(
            result.best_skill.as_str().contains("Prevent regressions first."),
            "slow update lands in the protected section"
        );
        assert!(result.best_skill.as_str().contains(SLOW_UPDATE_START));
        assert!(result.best_skill.as_str().contains(SLOW_UPDATE_END));
        // Meta skill fires from epoch 2 and carries its memory forward.
        assert!(optimizer
            .calls
            .iter()
            .any(|c| c == "meta_skill:prev=false"));
    }

    #[test]
    fn determinism_given_the_seed() {
        let config = TrainConfig::default();
        let run = || {
            let (mut optimizer, mut target) = fixture_world();
            let mut scorer = AccuracyScorer;
            train(
                &config,
                SkillDoc::new("# Skill\nBase.\n"),
                &tasks(24),
                &tasks(4),
                &[],
                &mut optimizer,
                &mut target,
                &mut scorer,
            )
            .expect("trains")
        };
        let a = run();
        let b = run();
        assert_eq!(a.best_skill, b.best_skill);
        assert_eq!(a.history, b.history);
    }
}
