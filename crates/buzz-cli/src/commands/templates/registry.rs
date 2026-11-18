//! Embedded template registry.
//!
//! Templates are authored in the repo-root `templates/` directory and
//! compiled into the `buzz` binary by `build.rs` (see its module docs for the
//! why). This module is the lookup surface: list, find, and strict-load.
//!
//! The completeness test below re-walks `templates/` at test time and fails
//! on any drift: a template directory missing from the registry, a registry
//! entry missing from disk, diverging file content (stale build), or content
//! that violates the schema contract — the guard for template content
//! authored outside this crate.

#[cfg(test)]
use std::path::PathBuf;

use super::schema::{parse_template_yaml, validate_template, Template, TemplateFiles};
use crate::error::CliError;

/// One file inside an embedded template (path relative to the template dir).
pub struct EmbeddedFile {
    pub path: &'static str,
    pub content: &'static str,
}

/// One embedded template directory.
pub struct EmbeddedTemplate {
    pub dir: &'static str,
    pub files: &'static [EmbeddedFile],
}

impl EmbeddedTemplate {
    /// The template's file tree as the shared resolution seam.
    pub fn files(&self) -> TemplateFiles {
        TemplateFiles::from_pairs(
            self.files
                .iter()
                .map(|f| (f.path.to_string(), f.content.to_string())),
        )
    }

    /// Parse `template.yaml` and strictly validate the whole template.
    pub fn parse_and_validate(&self) -> Result<Template, String> {
        let yaml = self
            .files
            .iter()
            .find(|f| f.path == "template.yaml")
            .map(|f| f.content)
            .ok_or_else(|| "template.yaml is missing".to_string())?;
        let template = parse_template_yaml(yaml).map_err(|e| e.to_string())?;
        validate_template(self.dir, &template, &self.files())?;
        Ok(template)
    }
}

include!(concat!(env!("OUT_DIR"), "/templates_registry.rs"));

/// All embedded templates, sorted by id (the build sorts by directory name).
pub fn all_templates() -> &'static [EmbeddedTemplate] {
    EMBEDDED_TEMPLATES
}

/// Find one embedded template by id.
pub fn find_template(id: &str) -> Option<&'static EmbeddedTemplate> {
    EMBEDDED_TEMPLATES.iter().find(|t| t.dir == id)
}

/// Load + strictly validate one template. Every entry point that reads
/// template content goes through here, so an invalid template can never reach
/// the apply engine (the completeness test keeps the registry valid anyway).
pub fn load_template(id: &str) -> Result<(Template, TemplateFiles), CliError> {
    let embedded = find_template(id).ok_or_else(|| {
        let known: Vec<&str> = EMBEDDED_TEMPLATES.iter().map(|t| t.dir).collect();
        CliError::Usage(format!(
            "unknown template '{id}' (available: {})",
            if known.is_empty() {
                "none".to_string()
            } else {
                known.join(", ")
            }
        ))
    })?;
    let template = embedded
        .parse_and_validate()
        .map_err(|e| CliError::Other(format!("embedded template '{id}' is invalid: {e}")))?;
    Ok((template, embedded.files()))
}

/// The repo-root `templates/` authoring directory (test-time).
#[cfg(test)]
fn templates_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("templates")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::templates::schema::validate_template;

    fn disk_templates() -> Vec<(String, TemplateFiles)> {
        let root = templates_dir();
        let mut out = Vec::new();
        let Ok(entries) = std::fs::read_dir(&root) else {
            return out;
        };
        let mut dirs: Vec<PathBuf> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect();
        dirs.sort();
        for dir in dirs {
            let name = dir.file_name().unwrap().to_string_lossy().into_owned();
            let mut pairs = Vec::new();
            collect_disk_files(&dir, &dir, &mut pairs);
            pairs.sort();
            out.push((name, TemplateFiles::from_pairs(pairs)));
        }
        out
    }

    fn collect_disk_files(root: &PathBuf, dir: &PathBuf, out: &mut Vec<(String, String)>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.is_dir() {
                collect_disk_files(root, &path, out);
            } else {
                let rel = path
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                let content = std::fs::read_to_string(&path)
                    .unwrap_or_else(|e| panic!("template file {rel} is not UTF-8 text: {e}"));
                out.push((rel, content));
            }
        }
    }

    /// Every `templates/*/` directory has a valid `template.yaml`, is present
    /// in the embedded registry with byte-identical content, and the registry
    /// holds nothing the authoring directory does not. This is the guard for
    /// template content authored outside this crate.
    #[test]
    fn embedded_registry_is_complete_and_every_template_is_valid() {
        let disk = disk_templates();

        let embedded_ids: Vec<&str> = EMBEDDED_TEMPLATES.iter().map(|t| t.dir).collect();
        let disk_ids: Vec<&str> = disk.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(
            embedded_ids, disk_ids,
            "embedded registry drifted from templates/ (rebuild to regen)"
        );

        for (name, files) in &disk {
            // 1. The dir has a template.yaml and it strictly validates.
            let yaml = files
                .get("template.yaml")
                .unwrap_or_else(|| panic!("templates/{name}/template.yaml is missing or empty"));
            let template = parse_template_yaml(yaml)
                .unwrap_or_else(|e| panic!("templates/{name}/template.yaml: {e}"));
            validate_template(name, &template, files)
                .unwrap_or_else(|e| panic!("templates/{name}: {e}"));

            // 2. The embedded copy is byte-identical (no stale build).
            let embedded = find_template(name).expect("registry entry");
            assert_eq!(
                embedded.files.len(),
                files.len(),
                "templates/{name}: embedded file count drifted"
            );
            for f in embedded.files {
                assert_eq!(
                    Some(f.content),
                    files.get(f.path),
                    "templates/{name}/{}: embedded content drifted from disk",
                    f.path
                );
            }
        }
    }

    /// `load_template` is the production load seam: valid templates load,
    /// unknown ids fail with the known-id list.
    #[test]
    fn load_template_resolves_embedded_and_rejects_unknown() {
        for t in all_templates() {
            let (template, files) = load_template(t.dir).expect("embedded template loads");
            assert_eq!(template.id, t.dir);
            assert!(!files.is_empty());
        }
        let err = load_template("no-such-template").unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("unknown template"), "{msg}");
        for t in all_templates() {
            assert!(msg.contains(t.dir), "{msg}");
        }
    }

    /// The shared `nightly-standup.yaml` is pinned byte-identical across every
    /// template that ships it, at the recorded digest. Per-template state (the
    /// workflow's channel binding) lives in `template.yaml`'s
    /// `workflows[].channel` — never inside the workflow file — so the shared
    /// file stays one byte-identical copy. Editing the workflow file to carry
    /// template-specific data, or letting copies drift, fails here.
    #[test]
    fn nightly_standup_workflow_is_pinned_byte_identical_across_templates() {
        use crate::commands::templates::apply::sha256_hex;

        /// sha256 of the pinned `workflows/nightly-standup.yaml` bytes.
        const PIN_SHA256: &str = "c001a7b295b7b7261036d5c99c87a176e027c5b91c151e02ce23194b16f4d0d3";

        let disk = disk_templates();
        let copies: Vec<(String, &str)> = disk
            .iter()
            .flat_map(|(name, files)| {
                files
                    .get("workflows/nightly-standup.yaml")
                    .map(|content| (name.clone(), content))
            })
            .collect();
        assert!(
            copies.len() >= 2,
            "expected the shared nightly-standup.yaml in at least two templates, found {}",
            copies.len()
        );

        let (first_dir, first) = &copies[0];
        let digest = sha256_hex(first);
        assert_eq!(
            digest, PIN_SHA256,
            "templates/{first_dir}/workflows/nightly-standup.yaml no longer matches the pinned \
             bytes — if the change is intentional, update PIN_SHA256 (and every other copy)"
        );
        for (name, content) in &copies[1..] {
            assert_eq!(
                *content, *first,
                "templates/{name}/workflows/nightly-standup.yaml drifted from \
                 templates/{first_dir}/workflows/nightly-standup.yaml (must stay byte-identical)"
            );
        }
    }
}
