//! The validation gate (SkillOpt §3.5 + `evaluation.*`): a candidate edit set
//! is accepted only when it STRICTLY improves the held-out selection score.
//!
//! `gate_metric` = `hard` (default) | `soft` | `mixed` (soft weight
//! `gate_mixed_weight`). `use_semantic_density` adds the optional
//! instruction-density bonus (formula inferred — see docs/skillopt-port.md —
//! disabled by default exactly like upstream).
//! `use_gate: false` records the validation score but force-accepts.

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum GateMetric {
    Hard,
    Soft,
    Mixed { soft_weight: f64 },
}

#[derive(Debug, Clone, PartialEq)]
pub struct DensityConfig {
    pub weight: f64,
    pub leading_words: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GateConfig {
    pub use_gate: bool,
    pub metric: GateMetric,
    pub semantic_density: Option<DensityConfig>,
}

impl Default for GateConfig {
    fn default() -> Self {
        Self {
            use_gate: true,
            metric: GateMetric::Hard,
            semantic_density: None,
        }
    }
}

/// Density bonus: `weight × (leading-word hits per 100 words)`, capped at
/// `weight` so it can nudge but never dominate the held-out score.
pub fn density_bonus(skill: &str, density: &DensityConfig) -> f64 {
    let words: Vec<&str> = skill.split_whitespace().collect();
    if words.is_empty() {
        return 0.0;
    }
    let hits = words
        .iter()
        .filter(|w| {
            let clean = w.trim_matches(|c: char| !c.is_alphanumeric());
            density
                .leading_words
                .iter()
                .any(|lead| clean.eq_ignore_ascii_case(lead))
        })
        .count();
    let rate = hits as f64 * 100.0 / words.len() as f64;
    (density.weight * rate).min(density.weight)
}

/// Fold hard/soft scores per `gate_metric` and add the optional bonus.
pub fn composite_score(
    hard: f64,
    soft: f64,
    skill: &str,
    gate: &GateConfig,
) -> f64 {
    let base = match gate.metric {
        GateMetric::Hard => hard,
        GateMetric::Soft => soft,
        GateMetric::Mixed { soft_weight } => {
            (1.0 - soft_weight) * hard + soft_weight * soft
        }
    };
    base + gate
        .semantic_density
        .as_ref()
        .map(|d| density_bonus(skill, d))
        .unwrap_or(0.0)
}

/// Strict improvement — ties reject (an edit set that merely preserves the
/// score is not progress and gets buffered instead).
pub fn gate_accepts(gate: &GateConfig, candidate: f64, best: f64) -> bool {
    if !gate.use_gate {
        return true;
    }
    candidate > best
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn golden_gate_requires_strict_improvement() {
        let gate = GateConfig::default();
        assert!(gate_accepts(&gate, 0.51, 0.5));
        assert!(!gate_accepts(&gate, 0.5, 0.5), "ties reject");
        assert!(!gate_accepts(&gate, 0.49, 0.5));
        let recording_only = GateConfig {
            use_gate: false,
            ..GateConfig::default()
        };
        assert!(gate_accepts(&recording_only, 0.0, 1.0), "force-accept mode");
    }

    #[test]
    fn golden_mixed_metric_matches_the_default_weight() {
        let gate = GateConfig {
            metric: GateMetric::Mixed { soft_weight: 0.5 },
            ..GateConfig::default()
        };
        assert!((composite_score(0.4, 0.8, "", &gate) - 0.6).abs() < 1e-12);
        let hard_only = GateConfig::default();
        assert!((composite_score(0.4, 0.8, "", &hard_only) - 0.4).abs() < 1e-12);
    }

    #[test]
    fn density_bonus_never_dominate() {
        let density = DensityConfig {
            weight: 0.05,
            leading_words: vec!["always".into(), "never".into()],
        };
        let skill = "always never always never";
        assert_eq!(density_bonus(skill, &density), 0.05, "capped at the weight");
        assert_eq!(density_bonus("plain words here", &density), 0.0);
    }
}
