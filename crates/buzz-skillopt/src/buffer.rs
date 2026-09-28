//! The rejected-edit buffer (SkillOpt §3.5, Appendix C.3): "Rejected
//! candidates are not discarded entirely: their failure patterns and rejected
//! edits are stored in the step buffer so that later optimizer calls can avoid
//! repeating harmful changes."
//!
//! The buffer is injected into subsequent optimizer prompts as a do-not-
//! repeat note. Bounded to the most recent [`BUFFER_CAP`] entries (a port
//! choice — upstream leaves it unbounded; the cap is documented).

use crate::edit::{EditOp, MergedEdit};

pub const BUFFER_CAP: usize = 32;

#[derive(Debug, Clone, PartialEq)]
pub struct RejectedEntry {
    /// The edits that did not survive the gate.
    pub edits: Vec<MergedEdit>,
    /// Failure patterns observed on the rejected candidate (the analyst's
    /// `failure_summary` from that step).
    pub failure_patterns: String,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct RejectedBuffer {
    entries: Vec<RejectedEntry>,
}

impl RejectedBuffer {
    pub fn record(&mut self, entry: RejectedEntry) {
        self.entries.push(entry);
        let overflow = self.entries.len().saturating_sub(BUFFER_CAP);
        if overflow > 0 {
            self.entries.drain(..overflow);
        }
    }

    pub fn entries(&self) -> &[RejectedEntry] {
        &self.entries
    }

    /// The do-not-repeat note appended to later optimizer prompts.
    pub fn prompt_note(&self) -> String {
        if self.entries.is_empty() {
            return String::new();
        }
        let mut out = String::from(
            "\n\nPREVIOUSLY REJECTED (do not repeat these edits or patterns):\n",
        );
        for (i, entry) in self.entries.iter().enumerate() {
            out.push_str(&format!("{}. patterns: {}\n", i + 1, entry.failure_patterns));
            for edit in &entry.edits {
                let description = match &edit.op {
                    EditOp::Append { content } => format!("append {:?}", truncate(content)),
                    EditOp::InsertAfter { target, content } => format!(
                        "insert_after {:?} -> {:?}",
                        truncate(target),
                        truncate(content)
                    ),
                    EditOp::Replace { target, content } => format!(
                        "replace {:?} -> {:?}",
                        truncate(target),
                        truncate(content)
                    ),
                    EditOp::Delete { target } => format!("delete {:?}", truncate(target)),
                };
                out.push_str(&format!("   - {description}\n"));
            }
        }
        out
    }
}

fn truncate(text: &str) -> String {
    if text.chars().count() <= 60 {
        text.to_string()
    } else {
        let cut: String = text.chars().take(57).collect();
        format!("{cut}...")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::edit::SourceType;

    #[test]
    fn buffer_is_bounded_and_notes_are_injected() {
        let mut buffer = RejectedBuffer::default();
        assert_eq!(buffer.prompt_note(), "", "empty buffer adds nothing");
        for i in 0..BUFFER_CAP + 5 {
            buffer.record(RejectedEntry {
                edits: vec![MergedEdit {
                    op: EditOp::Delete {
                        target: format!("target-{i}"),
                    },
                    support_count: 1,
                    source_type: SourceType::Failure,
                }],
                failure_patterns: format!("pattern-{i}"),
            });
        }
        assert_eq!(buffer.entries().len(), BUFFER_CAP, "bounded to the cap");
        let note = buffer.prompt_note();
        assert!(note.contains("do not repeat"));
        // Quoted forms are unambiguous ("target-1" is not inside "target-10").
        assert!(!note.contains("\"target-0\""), "oldest evicted");
        assert!(note.contains("\"target-36\""), "newest retained");
    }
}
