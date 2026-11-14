//! SKILL.md parsing — the Agent Skills metadata schema.
//!
//! A skill is a markdown document rooted at `SKILL.md` with YAML frontmatter
//! carrying `name` and `description`, followed by free-form instructions
//! (see `PERSONA_PACK_SPEC.md` §6 and the open Agent Skills format used by
//! Claude Code, Codex, and published skill packs):
//!
//! ```markdown
//! ---
//! name: "code-review"
//! description: "Reviews code for quality and correctness"
//! ---
//!
//! # Code Review
//!
//! When asked to review code, follow these steps...
//! ```
//!
//! **Both `name:` and `description:` are required frontmatter fields.** The
//! `name:` field is the harness load key (`load(source: "<name>")`). Anything
//! failing that contract is rejected with [`SkillError::MissingMetadata`] —
//! there is no silent fallback.

use serde::Deserialize;

use crate::persona::split_frontmatter;

/// Maximum SKILL.md content size in bytes (64 KiB).
///
/// Matches the relay/SDK content cap used by message and workflow builders;
/// a skill is an instruction set, not a data file. Companion files
/// (`scripts/`, `references/`, `assets/`) are out of scope for v1.
pub const SKILL_MAX_CONTENT_BYTES: usize = 64 * 1024;

/// The skill metadata schema — required SKILL.md frontmatter fields.
///
/// Field order matches `PERSONA_PACK_SPEC.md` §6's reference struct. Extra
/// frontmatter keys (e.g. trigger conditions) are accepted and ignored here;
/// they remain part of the preserved SKILL.md text.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct SkillMetadata {
    pub name: String,
    pub description: String,
}

/// Errors produced while parsing a SKILL.md document.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SkillError {
    /// The document has no parseable YAML frontmatter with non-empty `name`
    /// and `description`. This single named error covers missing delimiters,
    /// malformed YAML, a non-map frontmatter, and missing/blank fields — the
    /// Agent Skills contract rejects all of them identically.
    #[error("skill is missing frontmatter name/description")]
    MissingMetadata,

    /// The document exceeds [`SKILL_MAX_CONTENT_BYTES`].
    #[error("skill content exceeds {SKILL_MAX_CONTENT_BYTES} bytes")]
    TooLarge,
}

/// Parse a SKILL.md document into its metadata.
///
/// Enforces the size bound and the required frontmatter contract; the body is
/// not interpreted here (callers preserve the full document verbatim).
pub fn parse_skill_md(content: &str) -> Result<SkillMetadata, SkillError> {
    if content.len() > SKILL_MAX_CONTENT_BYTES {
        return Err(SkillError::TooLarge);
    }
    let (frontmatter, _body) =
        split_frontmatter(content).map_err(|_| SkillError::MissingMetadata)?;
    let meta: SkillMetadata =
        serde_yaml::from_str(frontmatter).map_err(|_| SkillError::MissingMetadata)?;
    if meta.name.trim().is_empty() || meta.description.trim().is_empty() {
        return Err(SkillError::MissingMetadata);
    }
    Ok(meta)
}

#[cfg(test)]
mod tests {
    use super::{parse_skill_md, SkillError, SkillMetadata, SKILL_MAX_CONTENT_BYTES};

    #[test]
    fn parses_valid_skill_md() {
        let doc =
            "---\nname: \"code-review\"\ndescription: \"Reviews code\"\n---\n\n# Code Review\n";
        let meta = parse_skill_md(doc).unwrap();
        assert_eq!(
            meta,
            SkillMetadata {
                name: "code-review".into(),
                description: "Reviews code".into(),
            }
        );
    }

    #[test]
    fn accepts_extra_frontmatter_keys() {
        let doc = "---\nname: x\ndescription: y\ntriggers:\n  - review\n---\nbody";
        assert!(parse_skill_md(doc).is_ok());
    }

    #[test]
    fn missing_frontmatter_is_the_named_error() {
        assert_eq!(
            parse_skill_md("# just a body"),
            Err(SkillError::MissingMetadata)
        );
    }

    #[test]
    fn missing_name_or_description_is_the_named_error() {
        for doc in [
            "---\ndescription: only desc\n---\nbody",
            "---\nname: only-name\n---\nbody",
            "---\nname: \"\"\ndescription: x\n---\nbody",
            "---\nname: x\ndescription: \"  \"\n---\nbody",
        ] {
            assert_eq!(
                parse_skill_md(doc),
                Err(SkillError::MissingMetadata),
                "{doc}"
            );
        }
    }

    #[test]
    fn malformed_yaml_frontmatter_is_the_named_error() {
        assert_eq!(
            parse_skill_md("---\nname: [unclosed\n---\nbody"),
            Err(SkillError::MissingMetadata)
        );
    }

    #[test]
    fn oversized_content_is_rejected() {
        let big = format!("---\nname: x\ndescription: y\n---\n{}", "a".repeat(65_536));
        assert!(big.len() > SKILL_MAX_CONTENT_BYTES);
        assert_eq!(parse_skill_md(&big), Err(SkillError::TooLarge));
    }
}
