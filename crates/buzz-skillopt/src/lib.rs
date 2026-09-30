//! `buzz-skillopt` — the SkillOpt method (arXiv:2605.23904), ported to Rust
//! as the production self-evolution loop for agent skill documents.
//!
//! "Train agent skills like you train neural networks": the skill document is
//! the trainable state of a FROZEN agent. Per step: rollout → reflect
//! (minibatch failure/success analysts) → aggregate (hierarchical merges) →
//! select (rank + clip to the textual learning rate `L_t`) → update (bounded
//! edits) → gate (held-out selection score must strictly improve; rejects go
//! to the rejected-edit buffer). At epoch boundaries the slow update rewrites
//! the protected section and the meta skill updates the optimizer's memory.
//!
//! Fidelity: every stage maps to the paper's Algorithm 1 and its Appendix C.2
//! prompt contracts ([`prompts`] carries them verbatim); the deterministic
//! mechanics are golden-tested. The full port checklist — including the
//! deliberately deferred upstream modes — is docs/skillopt-port.md.
//!
//! Ports (LLM-touching stages, kept behind traits for scripted tests):
//! [`train::Optimizer`] (the eight stages), [`train::Target`] (rollouts),
//! [`train::Scorer`] (held-out scoring).

pub mod buffer;
pub mod edit;
pub mod gate;
pub mod prompts;
pub mod schedule;
pub mod train;

pub use buffer::{RejectedBuffer, RejectedEntry};
pub use edit::{
    edits_independent, resolve_conflicts, EditError, EditOp, MergedEdit, SkillDoc, SourceType,
    SLOW_UPDATE_END, SLOW_UPDATE_START,
};
pub use gate::{
    composite_score, density_bonus, gate_accepts, DensityConfig, GateConfig, GateMetric,
};
pub use schedule::{learning_rate, Scheduler};
pub use train::{
    evaluate, longitudinal, train, AnalysisRequest, Longitudinal, LongitudinalPairPolicy,
    LongitudinalRequest, Optimizer, Patch, Scorer, StepRecord, Target, Task, TrainConfig,
    TrainResult, Trajectory,
};
