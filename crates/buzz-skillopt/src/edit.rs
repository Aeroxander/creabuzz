//! Bounded text updates (SkillOpt §3.4, Appendix C.3) — the four atomic
//! operations, exact-target application, the protected slow-update section,
//! and region independence.
//!
//! Fidelity notes (docs/skillopt-port.md):
//! - Ops are exactly the paper's grammar: `append`, `insert_after`,
//!   `replace`, `delete` (the prompt contracts' JSON `op` field).
//! - `target` is EXACT text. Not found → the edit is invalid and is recorded
//!   in the rejected buffer; multiple matches → ambiguous → invalid. Never
//!   guess which occurrence was meant.
//! - The `<!-- SLOW_UPDATE_START -->` … `<!-- SLOW_UPDATE_END -->` section is
//!   protected from every step-level edit (defense in depth: the prompts say
//!   not to touch it, and the applier refuses regardless).
//! - Region independence (merge guideline 5): two edits whose targets overlap
//!   cannot both apply; the survivor is chosen upstream by support count.

use thiserror::Error;

pub const SLOW_UPDATE_START: &str = "<!-- SLOW_UPDATE_START -->";
pub const SLOW_UPDATE_END: &str = "<!-- SLOW_UPDATE_END -->";

/// One atomic edit — the prompt contracts' JSON shape.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum EditOp {
    /// Append markdown at the end of the skill (outside the protected tail).
    Append { content: String },
    /// Insert `content` after the exact `target` text.
    InsertAfter { target: String, content: String },
    /// Replace the exact `target` text with `content`.
    Replace { target: String, content: String },
    /// Remove the exact `target` text.
    Delete { target: String },
}

/// Which analysis produced an edit (merge outputs carry it — ranking prefers
/// failure-driven edits on conflict, per `merge_final.md`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceType {
    Failure,
    Success,
}

/// A merged edit — the `merge_*.md` JSON shape.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct MergedEdit {
    #[serde(flatten)]
    pub op: EditOp,
    /// How many independent source patches support this edit.
    pub support_count: u32,
    pub source_type: SourceType,
}

impl MergedEdit {
    pub fn target(&self) -> Option<&str> {
        match &self.op {
            EditOp::Append { .. } => None,
            EditOp::InsertAfter { target, .. }
            | EditOp::Replace { target, .. }
            | EditOp::Delete { target } => Some(target),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum EditError {
    #[error("target text not found in the skill (edit dropped, buffered)")]
    TargetNotFound,
    #[error("target text is ambiguous (matches {matches} places; edit dropped)")]
    AmbiguousTarget { matches: usize },
    #[error("edit targets the protected slow-update section (refused)")]
    ProtectedTarget,
    #[error("empty target")]
    EmptyTarget,
}

/// The skill document with its protected section awareness.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillDoc {
    text: String,
}

fn count_matches(haystack: &str, needle: &str) -> usize {
    if needle.is_empty() {
        return 0;
    }
    haystack.match_indices(needle).count()
}

impl SkillDoc {
    pub fn new(text: impl Into<String>) -> Self {
        Self { text: text.into() }
    }

    pub fn as_str(&self) -> &str {
        &self.text
    }

    /// Byte range of the protected section (markers included), if present.
    pub fn protected_range(&self) -> Option<std::ops::Range<usize>> {
        let start = self.text.find(SLOW_UPDATE_START)?;
        let end = self.text[SLOW_UPDATE_START.len() + start..].find(SLOW_UPDATE_END)?;
        let finish = start + SLOW_UPDATE_START.len() + end + SLOW_UPDATE_END.len();
        Some(start..finish)
    }

    fn overlaps_protected(&self, range: std::ops::Range<usize>) -> bool {
        match self.protected_range() {
            Some(protected) => range.start < protected.end && protected.start < range.end,
            None => false,
        }
    }

    /// Replace the protected section's content wholesale (the ONLY sanctioned
    /// writer of that region — the epoch-boundary slow update). The new
    /// content is placed between fresh markers.
    pub fn with_slow_update(&self, guidance: &str) -> SkillDoc {
        let body = match self.protected_range() {
            Some(range) => {
                let (head, tail) = self.text.split_at(range.start);
                let tail = &tail[range.len()..];
                format!("{head}{SLOW_UPDATE_START}\n{guidance}\n{SLOW_UPDATE_END}{tail}")
            }
            None => format!(
                "{}\n\n{SLOW_UPDATE_START}\n{guidance}\n{SLOW_UPDATE_END}\n",
                self.text
            ),
        };
        SkillDoc::new(body)
    }

    /// Apply one edit on a COPY (the training loop keeps candidates and
    /// simply discards rejected ones — rollback-by-not-committing).
    pub fn apply(&self, edit: &EditOp) -> Result<SkillDoc, EditError> {
        match edit {
            EditOp::Append { content } => {
                // Appends land at the end of the body: if only whitespace
                // follows the protected section, insert before it so an
                // append can never enter it.
                let body = match self.protected_range() {
                    Some(range) if self.text[range.end..].trim().is_empty() => {
                        let (head, tail) = self.text.split_at(range.start);
                        format!("{head}{content}\n\n{tail}")
                    }
                    _ => format!("{}\n\n{}", self.text.trim_end_matches('\n'), content),
                };
                Ok(SkillDoc::new(body))
            }
            EditOp::InsertAfter { target, content } => {
                let range = self.locate(target)?;
                let at = range.end;
                let body = format!("{}\n{}{}", &self.text[..at], content, &self.text[at..]);
                Ok(SkillDoc::new(body))
            }
            EditOp::Replace { target, content } => {
                let range = self.locate(target)?;
                let body = format!(
                    "{}{}{}",
                    &self.text[..range.start],
                    content,
                    &self.text[range.end..]
                );
                Ok(SkillDoc::new(body))
            }
            EditOp::Delete { target } => {
                let range = self.locate(target)?;
                let body = format!("{}{}", &self.text[..range.start], &self.text[range.end..]);
                Ok(SkillDoc::new(body))
            }
        }
    }

    fn locate(&self, target: &str) -> Result<std::ops::Range<usize>, EditError> {
        if target.is_empty() {
            return Err(EditError::EmptyTarget);
        }
        let matches = count_matches(&self.text, target);
        if matches == 0 {
            return Err(EditError::TargetNotFound);
        }
        if matches > 1 {
            return Err(EditError::AmbiguousTarget { matches });
        }
        let start = self.text.find(target).expect("checked above");
        let range = start..start + target.len();
        if self.overlaps_protected(range.clone()) {
            return Err(EditError::ProtectedTarget);
        }
        Ok(range)
    }
}

/// Region independence (merge guideline 5): edits with overlapping or
/// identical targets conflict; appends never conflict (their region is the
/// end of the body).
pub fn edits_independent(a: &MergedEdit, b: &MergedEdit) -> bool {
    match (a.target(), b.target()) {
        (Some(x), Some(y)) => !x.contains(y) && !y.contains(x),
        _ => true,
    }
}

/// Drop conflicting edits keeping the better one: higher support count wins;
/// ties prefer the failure-driven edit (`merge_final.md` rule 2: "keep the
/// failure version"). Input order breaks remaining ties deterministically.
pub fn resolve_conflicts(mut pool: Vec<MergedEdit>) -> Vec<MergedEdit> {
    pool.sort_by(|x, y| {
        y.support_count
            .cmp(&x.support_count)
            .then_with(|| match (x.source_type, y.source_type) {
                (SourceType::Failure, SourceType::Success) => std::cmp::Ordering::Less,
                (SourceType::Success, SourceType::Failure) => std::cmp::Ordering::Greater,
                _ => std::cmp::Ordering::Equal,
            })
    });
    let mut kept: Vec<MergedEdit> = Vec::new();
    for edit in pool {
        if kept.iter().all(|k| edits_independent(k, &edit)) {
            kept.push(edit);
        }
    }
    kept
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skill() -> SkillDoc {
        SkillDoc::new(
            "# Skill\nAlways cite evidence.\n\n<!-- SLOW_UPDATE_START -->\nold guidance\n<!-- SLOW_UPDATE_END -->\n",
        )
    }

    #[test]
    fn golden_apply_the_four_atomic_ops() {
        let doc = skill();
        let appended = doc
            .apply(&EditOp::Append {
                content: "Never invent numbers.".into(),
            })
            .expect("append");
        assert!(appended.as_str().contains("Never invent numbers."));
        // Append lands in the body — before the protected tail.
        assert!(
            appended.as_str().find("Never invent numbers.").unwrap()
                < appended.protected_range().unwrap().start
        );

        let inserted = doc
            .apply(&EditOp::InsertAfter {
                target: "Always cite evidence.".into(),
                content: "Quote verbatim.".into(),
            })
            .expect("insert");
        assert_eq!(
            inserted.as_str(),
            "# Skill\nAlways cite evidence.\nQuote verbatim.\n\n<!-- SLOW_UPDATE_START -->\nold guidance\n<!-- SLOW_UPDATE_END -->\n"
        );

        let replaced = doc
            .apply(&EditOp::Replace {
                target: "Always cite evidence.".into(),
                content: "Cite or skip.".into(),
            })
            .expect("replace");
        assert!(replaced.as_str().contains("Cite or skip."));
        assert!(!replaced.as_str().contains("Always cite evidence."));

        let deleted = doc
            .apply(&EditOp::Delete {
                target: "\nAlways cite evidence.".into(),
            })
            .expect("delete");
        assert!(!deleted.as_str().contains("Always cite evidence."));
    }

    #[test]
    fn invalid_targets_are_refused_never_guessed() {
        let doc = skill();
        assert!(matches!(
            doc.apply(&EditOp::Delete {
                target: "not there".into()
            }),
            Err(EditError::TargetNotFound)
        ));
        let twice = SkillDoc::new("dup dup\n");
        assert!(matches!(
            twice.apply(&EditOp::Delete {
                target: "dup".into()
            }),
            Err(EditError::AmbiguousTarget { matches: 2 })
        ));
        assert!(matches!(
            doc.apply(&EditOp::Delete { target: "".into() }),
            Err(EditError::EmptyTarget)
        ));
    }

    #[test]
    fn the_protected_section_is_off_limits_to_step_edits() {
        let doc = skill();
        assert!(matches!(
            doc.apply(&EditOp::Replace {
                target: "old guidance".into(),
                content: "hijack".into(),
            }),
            Err(EditError::ProtectedTarget)
        ));
        // …and only the slow update may rewrite it.
        let rewritten = doc.with_slow_update("new guidance");
        assert!(rewritten.as_str().contains("new guidance"));
        assert!(!rewritten.as_str().contains("old guidance"));
        assert_eq!(
            rewritten.protected_range().is_some(),
            true,
            "markers preserved exactly once"
        );
    }

    #[test]
    fn golden_region_independence_and_conflict_resolution() {
        let a = MergedEdit {
            op: EditOp::Replace {
                target: "rule one".into(),
                content: "x".into(),
            },
            support_count: 2,
            source_type: SourceType::Failure,
        };
        let b = MergedEdit {
            op: EditOp::Delete {
                target: "rule one and more".into(),
            },
            support_count: 5,
            source_type: SourceType::Success,
        };
        let c = MergedEdit {
            op: EditOp::Append {
                content: "independent".into(),
            },
            support_count: 1,
            source_type: SourceType::Success,
        };
        assert!(!edits_independent(&a, &b), "overlapping targets conflict");
        assert!(edits_independent(&a, &c));
        // Higher support survives; the append is independent and stays.
        let kept = resolve_conflicts(vec![a, b, c]);
        assert_eq!(kept.len(), 2);
        assert_eq!(kept[0].support_count, 5);
    }

    #[test]
    fn conflict_ties_prefer_the_failure_edit() {
        let failure = MergedEdit {
            op: EditOp::Delete { target: "x".into() },
            support_count: 1,
            source_type: SourceType::Failure,
        };
        let success = MergedEdit {
            op: EditOp::Replace {
                target: "x".into(),
                content: "y".into(),
            },
            support_count: 1,
            source_type: SourceType::Success,
        };
        let kept = resolve_conflicts(vec![success, failure]);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].source_type, SourceType::Failure);
    }

    #[test]
    fn edit_json_matches_the_prompt_contract_schema() {
        let edit: EditOp = serde_json::from_str(
            r###"{"op":"insert_after","target":"## Rules","content":"- New"}"###,
        )
        .expect("parses");
        assert_eq!(
            edit,
            EditOp::InsertAfter {
                target: "## Rules".into(),
                content: "- New".into()
            }
        );
        let merged: MergedEdit = serde_json::from_str(
            r#"{"op":"append","content":"x","support_count":3,"source_type":"failure"}"#,
        )
        .expect("parses");
        assert_eq!(merged.support_count, 3);
    }
}
