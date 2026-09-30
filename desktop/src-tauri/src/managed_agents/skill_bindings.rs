//! Persona skill bindings, resolved once at managed-agent spawn time.
//!
//! # Why spawn time
//!
//! A template apply (`crates/buzz-cli/src/commands/templates/apply.rs`) tags
//! every kind:30175 persona event it publishes with one
//! `["skill", "<skill-id>", "developers"|"all"]` tag per template skill —
//! "one binding tag per template skill, scope recorded verbatim". Those tags
//! are the only durable record of which skills a persona inherits.
//!
//! The harness (`crates/buzz-acp`) assembles the `<project-skills>` section but
//! cannot read the persona event itself: kind:30175 is author-only-unless-shared
//! (`SHARED_GATED_KINDS` in `buzz-core`), and the harness authenticates to the
//! relay as the *agent*, not the owner. The desktop, however, holds the owner's
//! keys and keeps the signed persona head in the scoped retention store — so
//! binding resolution happens here, at the spawn boundary, and travels to the
//! harness as `BUZZ_ACP_SKILL_BINDINGS`.
//!
//! # The wire contract (consumed by `crates/buzz-acp/src/project_skills.rs`)
//!
//! `BUZZ_ACP_SKILL_BINDINGS` is a JSON array of raw tag vectors, e.g.
//! `[["skill","ethereum-dev","developers"]]`. This module only filters for tags
//! named `skill`; arity, id, and scope validation is the harness's
//! fail-closed job so there is exactly one strict validator, and it is the one
//! that renders the prompt.
//!
//! Fail-open throughout: a missing owner, definition, retention row, or
//! unparsable event yields no bindings (logged) and the agent still spawns.

use tauri::AppHandle;

use super::persona_events::persona_d_tag;
use super::retention::{get_retained_event, open_retention_db, scoped_retention_db_path};
use super::{managed_agents_base_dir, AgentDefinition};

/// Harness env var carrying the persona's raw skill-binding tags as JSON.
pub const SKILL_BINDINGS_ENV: &str = "BUZZ_ACP_SKILL_BINDINGS";

/// Tag name that marks a skill binding on a kind:30175 persona event.
pub const SKILL_TAG_NAME: &str = "skill";

/// Upper bound on binding tags handed to one spawn. Bounds the env value
/// itself; `buzz-acp` enforces its own (independently tested) cap.
pub const MAX_SKILL_BINDINGS: usize = 64;

/// Resolve the linked persona's skill-binding tags for one spawn.
///
/// Returns `Some(json)` when the persona's retained kind:30175 head carries at
/// least one `skill` tag, `None` otherwise (callers `env_remove` the var so a
/// reused command never inherits a previous agent's bindings).
pub fn spawn_skill_bindings_json<R: tauri::Runtime>(
    app: &AppHandle<R>,
    relay_url: &str,
    owner_hex: Option<&str>,
    definition: Option<&AgentDefinition>,
) -> Option<String> {
    let owner = owner_hex.map(str::trim).filter(|value| !value.is_empty())?;
    let definition = definition?;
    let d_tag = persona_d_tag(definition);

    let base_dir = match managed_agents_base_dir(app) {
        Ok(base_dir) => base_dir,
        Err(error) => {
            tracing::warn!("skill bindings: cannot resolve managed-agent dir ({error}) — skipping");
            return None;
        }
    };
    let db_path = scoped_retention_db_path(&base_dir, relay_url, owner);
    skill_bindings_json_at(&db_path, owner, &d_tag)
}

/// Read one retained kind:30175 head and serialize its skill-binding tags.
///
/// This is the whole read half of the seam: scoped retention path → signed
/// head → `skill` tags → JSON payload the harness parses. `None` at any step
/// (no store, no head, unreadable bytes) means no bindings and no failure.
pub(crate) fn skill_bindings_json_at(
    db_path: &std::path::Path,
    owner: &str,
    d_tag: &str,
) -> Option<String> {
    if !db_path.exists() {
        // Fresh workspace: no retained persona head yet, so no bindings.
        return None;
    }
    let conn = match open_retention_db(db_path) {
        Ok(conn) => conn,
        Err(error) => {
            tracing::warn!("skill bindings: cannot open retention store ({error}) — skipping");
            return None;
        }
    };
    skill_bindings_json_from_conn(&conn, owner, d_tag)
}

fn skill_bindings_json_from_conn(
    conn: &rusqlite::Connection,
    owner: &str,
    d_tag: &str,
) -> Option<String> {
    let retained = match get_retained_event(conn, buzz_core_pkg::kind::KIND_PERSONA, owner, d_tag) {
        Ok(row) => row,
        Err(error) => {
            tracing::warn!("skill bindings: persona head unreadable ({error}) — skipping");
            return None;
        }
    };
    // `None` = the persona has no retained head here; nothing to bind.
    let row = retained?;
    let event: nostr::Event = match serde_json::from_str(&row.raw_event) {
        Ok(event) => event,
        Err(error) => {
            tracing::warn!("skill bindings: persona head not parseable ({error}) — skipping");
            return None;
        }
    };

    let raw_tags: Vec<Vec<String>> = event
        .tags
        .iter()
        .map(|tag| tag.as_slice().to_vec())
        .collect();
    let bindings = collect_skill_binding_tags(&raw_tags);
    if bindings.is_empty() {
        return None;
    }
    match serde_json::to_string(&bindings) {
        Ok(payload) => Some(payload),
        Err(error) => {
            tracing::warn!("skill bindings: payload serialization failed ({error}) — skipping");
            None
        }
    }
}

/// Keep only the tags named `skill`, in event order, bounded by
/// [`MAX_SKILL_BINDINGS`].
///
/// Deliberately dumb: shape and scope validation happen in the harness
/// (`project_skills::parse_bindings`), which is the layer that decides what
/// reaches the prompt.
pub fn collect_skill_binding_tags(raw_tags: &[Vec<String>]) -> Vec<Vec<String>> {
    let mut out: Vec<Vec<String>> = Vec::new();
    for tag in raw_tags {
        if tag.first().map(String::as_str) != Some(SKILL_TAG_NAME) {
            continue;
        }
        if out.len() >= MAX_SKILL_BINDINGS {
            tracing::warn!(
                "skill bindings: persona carries more than {MAX_SKILL_BINDINGS} — dropping the rest"
            );
            break;
        }
        out.push(tag.clone());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_only_skill_tags_in_event_order() {
        let raw: Vec<Vec<String>> = vec![
            vec!["d".into(), "solidity-dev".into()],
            vec!["skill".into(), "zeta".into(), "all".into()],
            vec!["marker".into(), "template".into()],
            vec!["skill".into(), "alpha".into(), "developers".into()],
        ];
        assert_eq!(
            collect_skill_binding_tags(&raw),
            vec![
                vec!["skill".to_string(), "zeta".to_string(), "all".to_string()],
                vec![
                    "skill".to_string(),
                    "alpha".to_string(),
                    "developers".to_string()
                ],
            ]
        );
    }

    #[test]
    fn malformed_skill_tags_stay_in_the_payload_for_the_harness_to_reject() {
        // The desktop filters on the tag name only; the harness is the single
        // strict validator, so an arity-2 tag must survive this pass.
        let raw: Vec<Vec<String>> = vec![vec!["skill".into(), "no-scope".into()]];
        assert_eq!(collect_skill_binding_tags(&raw).len(), 1);
    }

    #[test]
    fn binding_count_is_capped() {
        let raw: Vec<Vec<String>> = (0..MAX_SKILL_BINDINGS + 5)
            .map(|i| vec!["skill".to_string(), format!("s{i}"), "all".to_string()])
            .collect();
        assert_eq!(collect_skill_binding_tags(&raw).len(), MAX_SKILL_BINDINGS);
    }

    #[test]
    fn no_skill_tags_yields_no_bindings() {
        let raw: Vec<Vec<String>> = vec![vec!["d".into(), "solidity-dev".into()]];
        assert!(collect_skill_binding_tags(&raw).is_empty());
    }

    /// The production read half, end to end: a retained, signed kind:30175 head
    /// carrying the template's binding tags becomes exactly the payload
    /// `buzz-acp` parses — and every miss is fail-open `None`.
    #[test]
    fn retained_persona_head_becomes_the_binding_payload() {
        use super::super::retention::{open_retention_db, retain_event, RetainedEvent};
        use nostr::{EventBuilder, Kind, Tag};

        let keys = nostr::Keys::generate();
        let owner = keys.public_key().to_hex();
        let d_tag = "solidity-dev";
        let event = EventBuilder::new(Kind::Custom(buzz_core_pkg::kind::KIND_PERSONA as u16), "{}")
            .tags(vec![
                Tag::parse(["d", d_tag]).expect("d tag"),
                Tag::parse(["marker", "template"]).expect("marker tag"),
                Tag::parse(["skill", "ethereum-dev", "developers"]).expect("skill tag"),
            ])
            .sign_with_keys(&keys)
            .expect("signed");

        let path = std::env::temp_dir().join(format!(
            "buzz-skill-bindings-{}-{}.db",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let conn = open_retention_db(&path).expect("open retention store");
        retain_event(
            &conn,
            &RetainedEvent {
                kind: buzz_core_pkg::kind::KIND_PERSONA,
                pubkey: owner.clone(),
                d_tag: d_tag.to_string(),
                content: "{}".to_string(),
                created_at: event.created_at.as_secs() as i64,
                raw_event: serde_json::to_string(&event).expect("serialized head"),
                pending_sync: false,
            },
        )
        .expect("retain head");
        drop(conn);

        let payload = skill_bindings_json_at(&path, &owner, d_tag)
            .expect("bindings resolve from the retained head");
        assert_eq!(
            serde_json::from_str::<Vec<Vec<String>>>(&payload).expect("json payload"),
            vec![vec![
                "skill".to_string(),
                "ethereum-dev".to_string(),
                "developers".to_string()
            ]]
        );

        // Unknown persona coordinate: no head → fail-open `None`.
        assert!(skill_bindings_json_at(&path, &owner, "app-dev").is_none());
        // Absent store: fail-open `None`, and the lookup never creates one.
        let absent = std::env::temp_dir().join(format!("buzz-absent-{}.db", uuid::Uuid::new_v4()));
        assert!(skill_bindings_json_at(&absent, &owner, d_tag).is_none());
        assert!(!absent.exists());

        for suffix in ["", "-wal", "-shm"] {
            let mut file = path.clone().into_os_string();
            file.push(suffix);
            let _ = std::fs::remove_file(file);
        }
    }
}
