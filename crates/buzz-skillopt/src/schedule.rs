//! Textual learning rate (SkillOpt §3.4 + `optimizer.lr_scheduler`): `L_t`,
//! the maximum number of edit patches applied per step. Decays across steps
//! within an epoch schedule (larger early changes, smaller late refinements).
//!
//! Ported schedules: `constant`, `linear`, `cosine` (the config's shipped
//! enum minus `autonomous`, which is an online control loop — listed as
//! deferred in docs/skillopt-port.md). The floor is
//! `optimizer.min_learning_rate`.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scheduler {
    Constant,
    Linear,
    Cosine,
}

/// `L_t` for step `t` of `total_steps` (both ≥ 1), clamped to the floor.
pub fn learning_rate(
    scheduler: Scheduler,
    step: usize,
    total_steps: usize,
    l0: usize,
    lmin: usize,
) -> usize {
    let l0f = l0 as f64;
    let lminf = lmin as f64;
    let t = (step.min(total_steps.saturating_sub(1)).max(0)) as f64;
    let progress = if total_steps <= 1 {
        1.0
    } else {
        t / (total_steps - 1) as f64
    };
    let value = match scheduler {
        Scheduler::Constant => l0f,
        Scheduler::Linear => l0f - progress * (l0f - lminf),
        Scheduler::Cosine => {
            lminf + 0.5 * (l0f - lminf) * (1.0 + (std::f64::consts::PI * progress).cos())
        }
    };
    (value.round() as usize).max(lmin)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn golden_schedulers_match_the_paper_defaults() {
        // Defaults: learning_rate 4, min_learning_rate 2, cosine.
        assert_eq!(
            learning_rate(Scheduler::Cosine, 0, 4, 4, 2),
            4,
            "first step is the largest change"
        );
        assert_eq!(
            learning_rate(Scheduler::Cosine, 3, 4, 4, 2),
            2,
            "last step decays to the floor"
        );
        assert_eq!(learning_rate(Scheduler::Constant, 2, 4, 4, 2), 4);
        assert_eq!(learning_rate(Scheduler::Linear, 1, 4, 4, 2), 3);
        // The floor is never undercut, even for extreme inputs.
        assert_eq!(learning_rate(Scheduler::Linear, 99, 4, 4, 2), 2);
        assert_eq!(learning_rate(Scheduler::Cosine, 0, 1, 4, 2), 2);
    }
}
