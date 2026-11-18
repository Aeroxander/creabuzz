# SkillOpt → Rust port: fidelity checklist

*2026-09-28. The user decision: "port the code and also read the paper to
double check if everything is ported correctly." This doc is that double
check. Port: `crates/buzz-skillopt` (method: arXiv:2605.23904v2, Algorithm 1 +
Appendix C; operational defaults: SkillOpt `docs/reference/config.md` +
`docs/index.md`).*

## Sources read

| Source | Used for |
|---|---|
| arXiv:2605.23904v2 §3 + Algorithm 1 + Appendix C.1–C.4 | the loop, the edit grammar, the safeguards, the design principles |
| Appendix C.2 (all eight prompt contracts) | verbatim into `prompts.rs` (with a test asserting the load-bearing clauses) |
| `docs/reference/config.md` | every hyperparameter default and enum |
| `docs/index.md` | stage names + the deep-learning analogy (LR = max edits; gate = held-out selection) |

## Stage-by-stage map (Algorithm 1 → Rust)

| Paper | Rust (`buzz-skillopt`) | Status |
|---|---|---|
| Rollout — frozen target `M` executes the batch | `train::Target::rollout`, `train::evaluate` | ported (target behind a port) |
| Reflect — minibatch failure/success analysts | `Optimizer::analyze_error` / `analyze_success` over `chunks(minibatch_size)` | ported; prompts verbatim |
| Aggregate — hierarchical merges | `train.rs::hierarchical_merge` in `merge_batch_size` groups, round by round | ported (see deviation 1) |
| Aggregate — final merge, failure-first | `Optimizer::merge_final` + `resolve_conflicts` (support-count wins; ties keep the failure edit) | ported |
| Select — rank by systematic impact → complementarity → generality → actionability | `Optimizer::rank` (criteria live in the verbatim `RANKING` prompt) | ported |
| Textual learning rate `L_t` | `schedule::learning_rate` — `constant` / `linear` / `cosine`, floor `min_learning_rate` | ported (`autonomous` deferred) |
| Update — bounded `append / insert_after / replace / delete` | `edit::EditOp` + `SkillDoc::apply` (exact target; missing/ambiguous/protected → refused and buffered, never guessed) | ported |
| Gate — accept only STRICT improvement on the held-out selection split | `gate::gate_accepts` (`>` only; `hard`/`soft`/`mixed` + `gate_mixed_weight`; `use_gate: false` = record-and-force-accept) | ported |
| Rejected-edit buffer | `buffer::RejectedBuffer` — rejected edits + failure patterns, injected as a do-not-repeat prompt note | ported (cap 32, see deviation 3) |
| Protected `SLOW_UPDATE_START/END` section | `edit::SkillDoc` — step edits REFUSE to touch it (the prompts also forbid it); only `with_slow_update` writes it | ported (defense in depth) |
| Epoch-wise slow update (20-task longitudinal: regressions / persistent failures / improvements / stable successes) | `train::longitudinal` + `Optimizer::slow_update` + `SkillDoc::with_slow_update`; `longitudinal_pair_policy` mixed/changed/unchanged | ported (see ambiguity 1) |
| Epoch-wise meta skill (`m_meta`, from epoch e ≥ 2) | `Optimizer::meta_skill`, memory injected into `AnalysisRequest.memory` from epoch 2 | ported |
| Final test evaluation of `s_best` | `train()` tail (`eval_test`, `test_score`) | ported |
| Frozen model / only text changes; lightweight deployable skill | `Target` is fixed for a run; the output is one markdown doc | ported (design principle 1, 5) |

## Defaults verified against `config.md`

`num_epochs 4 · batch_size 40 · accumulation 1 · minibatch_size 8 ·
merge_batch_size 8 · failure_only false · learning_rate 4 · min_learning_rate
2 · lr_scheduler cosine · skill_update_mode patch · use_slow_update true ·
slow_update_samples 20 · slow_update_gate_with_selection false ·
longitudinal_pair_policy mixed · use_meta_skill true · evaluation.use_gate
true · gate_metric hard · gate_mixed_weight 0.5 · semantic density off ·
sel_env_num 0 (full) · eval_test true · seed 42` — all reproduced as
`TrainConfig::default()` / `GateConfig::default()`.

## Ambiguities found in the sources, and how they were resolved

1. **Slow-update gating.** Appendix C.3 says the slow-update rewrite "still
   passes through the same held-out selection gate before it can become the
   current skill", while `config.md` ships
   `slow_update_gate_with_selection: false`. **Resolved toward config.md**
   (the operational source): the flag exists and defaults to false; the gated
   behavior is implemented and available.
2. **Semantic-density bonus formula.** `use_semantic_density`,
   `semantic_density_weight 0.05`, and `leading_words` are specified, but the
   exact density formula sits in the fetch-truncated ablations text.
   **Resolved conservatively**: `density_bonus` = `weight × (leading-word hits
   per 100 words)`, capped at `weight`; disabled by default exactly like
   upstream. Marked inferred.

## Documented micro-deviations (small, deliberate)

1. **Inter-round merge metadata**: upstream carries `support_count` between
   hierarchical rounds through the prompt; the port serializes the merged set
   into the synthetic patch's `notes` field so a live optimizer can carry it
   (the merge guideline "carry forward support_count" is then satisfiable),
   while scripted optimizers stay deterministic.
2. **Rollback = not committing.** Rejected candidates are built on a copy and
   discarded (C.3's "rejected candidates are not discarded entirely" is
   honored via the buffer, which is the specified behavior).
3. **Buffer cap 32** entries (upstream is unbounded; the port bounds memory
   and states it).
4. **Append placement**: appends land at the end of the body but BEFORE a
   trailing protected section, so `append` can never enter it.
5. **Ambiguous targets** (multiple exact matches) are refused like missing
   ones — upstream leaves this to the model; the port refuses deterministically
   ("never guess" house rule).

## Gap found by the first live training run (now ported)

`model.reasoning_effort` (SkillOpt's shared knob, default `medium`) was
missed in the first port — and its absence is exactly what failed live:
page-generation rollouts hit `finish_reason: "length"` with no content (the
reasoning model spent the whole budget thinking). A direct probe showed the
knob is accepted by our gateway and shrinks completion spend ~2.5×
(723 → 290 completion tokens on the same analyst prompt). Ported as
`chat_completion_effort` + `--reasoning-effort` (low|medium|high, default
medium = upstream), plus a page-sized rollout budget (32k). This closes the
fidelity list — the config table's `model.reasoning_effort` row is now
implemented rather than silently absent.

## Deliberately NOT in v1 (upstream features, deferred)

| Upstream feature | Why deferred |
|---|---|
| `lr_scheduler: autonomous`, `lr_control_mode: autonomous` | online control loop; the three fixed schedules cover the paper's reported stable regime |
| `skill_update_mode: rewrite_from_suggestions`, `full_rewrite_minibatch` | the paper's shipped path (and its numbers) is `patch` mode |
| `use_skill_aware_reflection` + appendix consolidation | experimental v0.2 routing; not in the paper's default path |
| Benchmark adapters, exec harnesses (`codex_exec` etc.), WebUI | our "benchmarks" are our own validators + live receipts; harnesses are host-side |
| `openai_chat`/Azure/Claude/Qwen/MiniMax backends | one backend is enough: `openai_compatible` (our classifier endpoint); the trait seam takes any |
| `codex_trace_to_optimizer` / `claude_trace_to_optimizer` | exec-harness trace injection; n/a to chat rollouts |

## What the goldens pin

- `edit.rs`: the four ops byte-exact; missing/ambiguous/empty/protected
  refusals; region independence + failure-first conflict ties; JSON shape ==
  the prompt contracts' schema.
- `schedule.rs`: cosine/linear/constant `L_t` values incl. floor behavior.
- `gate.rs`: strict-improvement semantics (ties reject), mixed-metric
  arithmetic, density-bonus cap.
- `buffer.rs`: bounded eviction + do-not-repeat note content.
- `train.rs`: the discover-the-fix end-to-end run (all eight stages observed),
  harmful-edit rejection (never reaches the skill), epoch-boundary slow/meta
  behavior incl. protected-section write, and determinism under a fixed seed.

## Where this plugs into the production loop (next)

`train::Optimizer` implemented over our LLM port (`buzz-agwiki::llm` style,
`openai_compatible`) with the verbatim prompts; `Target`/`Scorer` = our
validators + live receipts (accept/reject of credits and drafts as the reward
signal); the trained `best_skill.md` published as a versioned persona-pack
event with provenance (model, cost_tokens, validation scores) — the self-
evolving wiki loop, with org_diag's drift probes watching the skill doc.
