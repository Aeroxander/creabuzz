//! Retention-store enqueue helpers for owner-authored persona writes: retain
//! a pending 30175 on create/update, purge + tombstone on delete. The flush
//! loop (`flush_pending_events`) is the sole publisher.

use tauri::AppHandle;

use crate::app_state::AppState;
use crate::managed_agents::{
    retention::{RetainedEvent, RetentionScope},
    AgentDefinition,
};

pub(super) struct PreparedPersonaPublication {
    pub scope: RetentionScope,
    pub event: nostr::Event,
    pub retained: RetainedEvent,
    pub persona: AgentDefinition,
}

/// Retain a freshly authored persona event in the local store, flagged for
/// relay sync. Called inside a command's `managed_agents_store_lock`-held body
/// after `save_personas`; the background flush loop publishes it out-of-band.
///
/// The event is signed with the owner keys at call time, so its `created_at`
/// is `now` — newer than any prior retained row, clearing the upsert's
/// newer-or-equal guard. `pending_sync = 1` enqueues it for the flush loop,
/// which is the sole publisher. Best-effort: a failure here is logged and
/// swallowed so a retention hiccup never blocks the disk-authoritative write.
/// The explicit catalog toggle uses [`prepare_persona_publication`] directly
/// so its durable enqueue failure reaches the UI.
///
/// Unlike `retain_managed_agent_pending`, this has no projection-equality
/// short-circuit: personas have no start/stop runtime churn, so a republish
/// only happens on a genuine create/update/delete/share user edit
/// (`set_persona_active` does not retain, so the local-only `is_active` toggle
/// never republishes, while `set_persona_shared` must retain because the tag is
/// relay-authoritative). A byte-identical user-save republish is harmlessly
/// NIP-33-replaced. The guard is intentionally omitted.
pub(in crate::commands) fn retain_persona_pending(
    app: &AppHandle,
    state: &AppState,
    persona: &AgentDefinition,
) {
    if let Err(e) = prepare_persona_publication(app, state, persona, None) {
        eprintln!("buzz-desktop: persona-retain: {e}");
    }
}

/// Scope-level persona retention: sign and durably enqueue a persona head in an
/// already-resolved retention scope. Callers that resolve the scope once for a
/// batch (team adoption) use this to avoid a keyring round-trip per member;
/// [`retain_persona_pending`] is the `AppHandle` wrapper for single writes.
pub(in crate::commands) fn retain_persona_pending_at(
    scope: &RetentionScope,
    persona: &AgentDefinition,
) -> Result<(), String> {
    prepare_persona_publication_at(&scope.db_path, &scope.owner_keys, persona, None).map(|_| ())
}

/// Build, sign, and durably retain a persona event in the active relay+owner
/// scope.
///
/// Ordinary definition writes pass `None` and preserve the scoped head's
/// exact share tag. The explicit share toggle passes `Some(shared)`. Returning
/// the retained event lets that command immediately await relay acceptance
/// without rebuilding or re-signing a different NIP-33 head.
pub(super) fn prepare_persona_publication(
    app: &AppHandle,
    state: &AppState,
    persona: &AgentDefinition,
    shared_override: Option<bool>,
) -> Result<PreparedPersonaPublication, String> {
    let scope = crate::managed_agents::retention::active_retention_scope(app, state)?;
    let (event, retained, persona) = prepare_persona_publication_at(
        &scope.db_path,
        &scope.owner_keys,
        persona,
        shared_override,
    )?;
    Ok(PreparedPersonaPublication {
        scope,
        event,
        retained,
        persona,
    })
}

fn retained_persona_is_shared(row: Option<&RetainedEvent>) -> bool {
    use buzz_core_pkg::kind::event_is_shared;
    use nostr::JsonUtil;

    row.and_then(|retained| nostr::Event::from_json(&retained.raw_event).ok())
        .is_some_and(|event| event_is_shared(&event))
}

/// Project each persona's catalog visibility from the active relay+owner
/// scope's retained head.
///
/// Infallible by design. The scope needs `signing_keys()`, which fails for the
/// whole process whenever the identity is lost or the keyring is locked, and a
/// propagated error there would break listing, creating, and updating EVERY
/// agent. Share state is a view projection, so an unresolvable scope degrades
/// to "not shared" — the safe direction: it can under-report visibility but can
/// never present an unshared persona as published. The durable share state
/// lives in the retention head, so nothing is lost: the true value reappears
/// once the identity is signable again.
pub(super) fn project_active_persona_sharing(
    app: &AppHandle,
    state: &AppState,
    personas: &mut [AgentDefinition],
) {
    let scope = crate::managed_agents::retention::active_retention_scope(app, state);
    project_scoped_persona_sharing(scope, personas);
}

fn project_scoped_persona_sharing(
    scope: Result<RetentionScope, String>,
    personas: &mut [AgentDefinition],
) {
    let projected = scope.and_then(|scope| {
        project_persona_sharing_at(
            &scope.db_path,
            &scope.owner_keys.public_key().to_hex(),
            personas,
        )
    });
    if let Err(error) = projected {
        eprintln!("buzz-desktop: persona-share-projection unavailable, reporting every agent as unshared: {error}");
        for persona in personas {
            persona.shared = false;
        }
    }
}

fn project_persona_sharing_at(
    db_path: &std::path::Path,
    owner_pubkey: &str,
    personas: &mut [AgentDefinition],
) -> Result<(), String> {
    use crate::managed_agents::{
        persona_events::persona_d_tag,
        retention::{get_retained_event, open_retention_db},
    };
    use buzz_core_pkg::kind::KIND_PERSONA;

    let conn = open_retention_db(db_path)?;
    for persona in personas {
        if persona.is_builtin {
            persona.shared = false;
            continue;
        }
        let retained =
            get_retained_event(&conn, KIND_PERSONA, owner_pubkey, &persona_d_tag(persona))?;
        persona.shared = retained_persona_is_shared(retained.as_ref());
    }
    Ok(())
}

pub(super) fn prepare_persona_publication_at(
    db_path: &std::path::Path,
    keys: &nostr::Keys,
    persona: &AgentDefinition,
    shared_override: Option<bool>,
) -> Result<(nostr::Event, RetainedEvent, AgentDefinition), String> {
    prepare_persona_publication_stage(db_path, keys, persona, shared_override, None)
}

/// Explicit-tag-intent sibling of [`prepare_persona_publication_at`].
///
/// Same stage-2 contract (scope-free build/sign/retain over `db_path`), but the
/// carried tag set is *supplied* instead of derived by carry-forward: the
/// caller has computed the desired set — e.g. `carried_forward_tags(head)`
/// minus the one binding a deliberate unbind removes — and this writes exactly
/// that intent into the retained head. An empty `Vec` is the explicit clear
/// (only `d`, plus `shared` when the record says so, survives).
///
/// Both variants read the retained head here (for `shared`, the strict
/// parse-failure guard, and the monotonic `created_at`), so the caller must
/// have derived `carried_tags` from *this same* head while holding the store
/// lock — `commands::personas::skills::set_persona_skill_binding` does.
pub(super) fn prepare_persona_publication_at_with_tags(
    db_path: &std::path::Path,
    keys: &nostr::Keys,
    persona: &AgentDefinition,
    shared_override: Option<bool>,
    carried_tags: Vec<nostr::Tag>,
) -> Result<(nostr::Event, RetainedEvent, AgentDefinition), String> {
    prepare_persona_publication_stage(db_path, keys, persona, shared_override, Some(carried_tags))
}

fn prepare_persona_publication_stage(
    db_path: &std::path::Path,
    keys: &nostr::Keys,
    persona: &AgentDefinition,
    shared_override: Option<bool>,
    carried_tags: Option<Vec<nostr::Tag>>,
) -> Result<(nostr::Event, RetainedEvent, AgentDefinition), String> {
    use crate::managed_agents::{
        persona_events::{
            build_persona_event, build_persona_event_with_tags, monotonic_created_at, persona_d_tag,
        },
        retention::{get_retained_event, open_retention_db, retain_event, RetainedEvent},
    };
    use buzz_core_pkg::kind::{event_is_shared, KIND_PERSONA};
    use nostr::JsonUtil;

    let d_tag = persona_d_tag(persona);
    let pubkey = keys.public_key().to_hex();
    let conn = open_retention_db(db_path)?;
    let existing = get_retained_event(&conn, KIND_PERSONA, &pubkey, &d_tag)?;
    // Parse the retained head STRICTLY for the same reason as the boot
    // reconcile in `migrate_personas_in_dir_at`: its `skill` bindings and
    // template marker cannot be re-derived from the record, so an
    // unparsable head must fail this enqueue (row untouched, bindings
    // intact) instead of being overwritten by a tag-stripped rebuild.
    let prior_head = existing
        .as_ref()
        .map(|row| nostr::Event::from_json(&row.raw_event))
        .transpose()
        .map_err(|e| format!("failed to parse retained persona head '{d_tag}': {e}"))?;
    let mut scoped_persona = persona.clone();
    scoped_persona.shared =
        shared_override.unwrap_or_else(|| prior_head.as_ref().is_some_and(event_is_shared));
    if scoped_persona.shared {
        crate::managed_agents::validate_agent_definition_text(
            &scoped_persona.display_name,
            &scoped_persona.system_prompt,
        )?;
        crate::managed_agents::validate_agent_description_text(
            scoped_persona.description.as_deref(),
        )?;
    }
    // Prior head passed so its `skill` bindings and template marker survive
    // the rebuild (only `d`/`shared` are recomputed) — see
    // `build_persona_event`'s carry-forward contract. Explicit tag intent
    // overrides that carry-forward with exactly the set the caller computed.
    let event = match carried_tags {
        Some(tags) => build_persona_event_with_tags(&scoped_persona, tags)?,
        None => build_persona_event(&scoped_persona, prior_head.as_ref())?,
    }
    .custom_created_at(monotonic_created_at(
        existing.as_ref().map(|row| row.created_at),
    ))
    .sign_with_keys(keys)
    .map_err(|e| format!("failed to sign persona event: {e}"))?;
    let retained = RetainedEvent {
        kind: KIND_PERSONA,
        pubkey,
        d_tag,
        content: event.content.to_string(),
        created_at: event.created_at.as_secs() as i64,
        raw_event: event.as_json(),
        pending_sync: true,
    };
    retain_event(&conn, &retained)?;
    Ok((event, retained, scoped_persona))
}

/// Purge a deleted persona's pending row and enqueue a NIP-09 tombstone, both
/// inside the `managed_agents_store_lock`-held delete body.
///
/// PURGE IN: the persona's `(30175, pubkey, d_tag)` row is deleted. Running it
/// under the same lock that serializes `retain_event` closes the same-second
/// resurrect race — a concurrent edit can't re-insert a pending persona row
/// after the tombstone is queued.
///
/// PUBLISH OUT: the kind:5 tombstone is retained at its own coordinate `(5,
/// pubkey, d_tag)` (distinct from the purged persona row) with `pending_sync =
/// 1`; the flush loop publishes it. Purge and enqueue run in one `BEGIN
/// IMMEDIATE` transaction so a crash between them cannot leave the 30175 head
/// live with its only retry witness gone. Best-effort: a failure is logged and
/// swallowed so a retention hiccup never blocks the disk-authoritative delete.
pub(in crate::commands) fn tombstone_persona_pending(
    app: &AppHandle,
    state: &AppState,
    d_tag: &str,
) {
    let result = (|| -> Result<(), String> {
        let scope = crate::managed_agents::retention::active_retention_scope(app, state)?;
        tombstone_persona_at(&scope.db_path, &scope.owner_keys, d_tag)
    })();
    if let Err(e) = result {
        eprintln!("buzz-desktop: persona-tombstone: {e}");
    }
}

/// Scope-free core of [`tombstone_persona_pending`], so the atomic purge +
/// enqueue and its future-dated-head domination can be asserted directly
/// against a retention database (mirrors `teams::tombstone_team_at`).
pub(crate) fn tombstone_persona_at(
    db_path: &std::path::Path,
    keys: &nostr::Keys,
    d_tag: &str,
) -> Result<(), String> {
    use crate::managed_agents::{
        persona_events::{build_persona_delete, monotonic_created_at},
        retention::{
            delete_retained_event, get_retained_event, open_retention_db, retain_event,
            tombstone_retention_d_tag, RetainedEvent,
        },
    };
    use buzz_core_pkg::kind::KIND_PERSONA;
    use nostr::JsonUtil;

    const KIND_DELETE: u32 = 5;

    let pubkey = keys.public_key().to_hex();
    let conn = open_retention_db(db_path)?;
    // Single transaction: a kill between the head purge and the tombstone
    // enqueue would otherwise leave the 30175 head live with no local retry
    // witness. Reading the head's `created_at` inside the same `BEGIN
    // IMMEDIATE` closes both the crash window and the read-then-sign race —
    // and lets the kind:5 be signed strictly past a future-dated head so it
    // cannot survive its own tombstone once the head row is purged. The flush
    // loop re-dates a kind:5 only to `now.max(retained_created_at)` and never
    // re-reads the (already purged) head, so the domination guarantee must be
    // established here. Mirrors the 30176/30178 tombstone helpers.
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("failed to begin persona tombstone transaction: {e}"))?;
    let result = (|| -> Result<(), String> {
        let prior_head =
            get_retained_event(&conn, KIND_PERSONA, &pubkey, d_tag)?.map(|row| row.created_at);
        let event = build_persona_delete(d_tag, &pubkey)?
            .custom_created_at(monotonic_created_at(prior_head))
            .sign_with_keys(keys)
            .map_err(|e| format!("failed to sign persona tombstone: {e}"))?;
        delete_retained_event(&conn, KIND_PERSONA, &pubkey, d_tag)?;
        retain_event(
            &conn,
            &RetainedEvent {
                kind: KIND_DELETE,
                pubkey: pubkey.clone(),
                // Key by the target coordinate so cross-kind d-tag tombstones
                // occupy distinct rows (F2c).
                d_tag: tombstone_retention_d_tag(KIND_PERSONA, d_tag),
                content: event.content.to_string(),
                created_at: event.created_at.as_secs() as i64,
                raw_event: event.as_json(),
                pending_sync: true,
            },
        )
    })();
    match result {
        Ok(()) => conn
            .execute_batch("COMMIT")
            .map_err(|e| format!("failed to commit persona tombstone transaction: {e}")),
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::managed_agents::retention::{
        get_retained_event, open_retention_db, scoped_retention_db_path,
    };
    use buzz_core_pkg::kind::KIND_PERSONA;
    use std::collections::BTreeMap;

    fn persona() -> AgentDefinition {
        AgentDefinition {
            description: None,
            id: "catalog-reviewer".to_string(),
            display_name: "Catalog Reviewer".to_string(),
            avatar_url: None,
            system_prompt: "Review the catalog.".to_string(),
            runtime: None,
            model: None,
            provider: None,
            name_pool: Vec::new(),
            is_builtin: false,
            is_active: true,
            shared: false,
            source_team: None,
            source_team_persona_slug: None,
            catalog_source: None,
            team_catalog_source: None,
            env_vars: BTreeMap::new(),
            respond_to: None,
            respond_to_allowlist: Vec::new(),
            parallelism: None,
            created_at: "2026-07-27T00:00:00Z".to_string(),
            updated_at: "2026-07-27T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn share_state_and_pending_heads_are_scoped_by_relay_and_owner() {
        let dir = tempfile::tempdir().unwrap();
        let keys = nostr::Keys::generate();
        let owner = keys.public_key().to_hex();
        let community_a = scoped_retention_db_path(dir.path(), "wss://a.example", &owner);
        let community_b = scoped_retention_db_path(dir.path(), "wss://b.example", &owner);
        std::fs::create_dir_all(community_a.parent().unwrap()).unwrap();

        let (_, _, shared_in_a) =
            prepare_persona_publication_at(&community_a, &keys, &persona(), Some(true)).unwrap();
        assert!(shared_in_a.shared);

        let (_, _, unshared_in_b) =
            prepare_persona_publication_at(&community_b, &keys, &persona(), None).unwrap();
        assert!(!unshared_in_b.shared);

        let mut edited = persona();
        edited.system_prompt = "Review the latest catalog.".to_string();
        let (_, _, edited_in_a) =
            prepare_persona_publication_at(&community_a, &keys, &edited, None).unwrap();
        assert!(
            edited_in_a.shared,
            "ordinary edits preserve only the active scope's share choice"
        );

        let conn_a = open_retention_db(&community_a).unwrap();
        let conn_b = open_retention_db(&community_b).unwrap();
        assert!(retained_persona_is_shared(
            get_retained_event(&conn_a, KIND_PERSONA, &owner, "catalog-reviewer")
                .unwrap()
                .as_ref()
        ));
        assert!(!retained_persona_is_shared(
            get_retained_event(&conn_b, KIND_PERSONA, &owner, "catalog-reviewer")
                .unwrap()
                .as_ref()
        ));
    }

    /// Seed a retained kind:30175 head at `db_path` carrying exactly `tags`
    /// with `content`, built by HAND (never through the production builder) so
    /// a carry-forward regression cannot make the seed agree with an
    /// assertion.
    fn seed_binding_head(
        db_path: &std::path::Path,
        keys: &nostr::Keys,
        tags: Vec<nostr::Tag>,
        content: &str,
    ) -> nostr::Event {
        use crate::managed_agents::retention::retain_event;
        use nostr::{EventBuilder, JsonUtil, Kind};

        let event = EventBuilder::new(Kind::Custom(KIND_PERSONA as u16), content)
            .tags(tags)
            .sign_with_keys(keys)
            .expect("signed seed head");
        let conn = open_retention_db(db_path).unwrap();
        retain_event(
            &conn,
            &RetainedEvent {
                kind: KIND_PERSONA,
                pubkey: keys.public_key().to_hex(),
                d_tag: "catalog-reviewer".to_string(),
                content: content.to_string(),
                created_at: event.created_at.as_secs() as i64,
                raw_event: event.as_json(),
                pending_sync: false,
            },
        )
        .expect("seed head retained");
        event
    }

    fn tag_shape(event: &nostr::Event) -> Vec<Vec<&str>> {
        event
            .tags
            .iter()
            .map(|t| t.as_slice().iter().map(String::as_str).collect())
            .collect()
    }

    /// Re-publish seam (`prepare_persona_publication_at` → `build_persona_event`):
    /// the desktop record cannot re-derive the retained head's
    /// `["skill", <id>, <scope>]` bindings or the template `["marker", …]` tag
    /// — `skill_bindings` reads them off this very head at spawn — so a
    /// desktop edit must carry both forward byte-identically while content
    /// updates and `d` is recomputed exactly once.
    #[test]
    fn republish_carries_binding_tags_and_marker_forward() {
        use nostr::{JsonUtil, Tag};

        let dir = tempfile::tempdir().unwrap();
        let keys = nostr::Keys::generate();
        let owner = keys.public_key().to_hex();
        let db_path = scoped_retention_db_path(dir.path(), "wss://a.example", &owner);
        std::fs::create_dir_all(db_path.parent().unwrap()).unwrap();

        const HEAD_CONTENT: &str =
            r#"{"display_name":"Catalog Reviewer","system_prompt":"Review the catalog."}"#;
        let head = seed_binding_head(
            &db_path,
            &keys,
            vec![
                Tag::parse(["d", "catalog-reviewer"]).expect("d tag"),
                Tag::parse(["skill", "ethereum-dev", "developers"]).expect("skill tag"),
                Tag::parse(["marker", "template"]).expect("marker tag"),
            ],
            HEAD_CONTENT,
        );

        // Desktop edit: content changes; the record still knows nothing about
        // the bindings it never carried.
        let mut edited = persona();
        edited.system_prompt = "Review the latest catalog.".to_string();
        let (event, _, _) = prepare_persona_publication_at(&db_path, &keys, &edited, None)
            .expect("republish over the seeded binding head");

        assert_eq!(
            tag_shape(&event),
            vec![
                vec!["d", "catalog-reviewer"],
                vec!["skill", "ethereum-dev", "developers"],
                vec!["marker", "template"],
            ],
            "binding + marker carried verbatim; d recomputed exactly once"
        );
        // Byte-identity against the seeded head's own tags, not just shape.
        let head_event: nostr::Event = JsonUtil::from_json(head.as_json()).unwrap();
        assert_eq!(event.tags.as_slice()[1], head_event.tags.as_slice()[1]);
        assert_eq!(event.tags.as_slice()[2], head_event.tags.as_slice()[2]);
        // ...while the content actually updates.
        assert!(event.content.contains("Review the latest catalog."));
        assert_ne!(event.content, HEAD_CONTENT, "content must change");
    }

    /// Inverse: a head with no binding tags stays exactly `d` — carry-forward
    /// must neither invent tags nor duplicate the recomputed ones.
    #[test]
    fn republish_of_a_tag_free_head_stays_tag_free() {
        use nostr::Tag;

        let dir = tempfile::tempdir().unwrap();
        let keys = nostr::Keys::generate();
        let owner = keys.public_key().to_hex();
        let db_path = scoped_retention_db_path(dir.path(), "wss://a.example", &owner);
        std::fs::create_dir_all(db_path.parent().unwrap()).unwrap();

        const HEAD_CONTENT: &str =
            r#"{"display_name":"Catalog Reviewer","system_prompt":"Review the catalog."}"#;
        seed_binding_head(
            &db_path,
            &keys,
            vec![Tag::parse(["d", "catalog-reviewer"]).expect("d tag")],
            HEAD_CONTENT,
        );

        let mut edited = persona();
        edited.system_prompt = "Review the latest catalog.".to_string();
        let (event, _, _) = prepare_persona_publication_at(&db_path, &keys, &edited, None)
            .expect("republish over the tag-free head");

        assert_eq!(
            tag_shape(&event),
            vec![vec!["d", "catalog-reviewer"]],
            "a tag-free head must not gain tags on republish"
        );
        assert!(event.content.contains("Review the latest catalog."));
    }

    /// Review-Proven Rules 1+2 at this call site: the retained head is the
    /// only source of the bindings, so a head this rebuild cannot parse must
    /// fail the enqueue LOUD and leave the row byte-for-byte untouched — never
    /// be overwritten by a tag-stripped rebuild.
    #[test]
    fn republish_fails_loud_on_unparsable_head_and_leaves_it_intact() {
        let dir = tempfile::tempdir().unwrap();
        let keys = nostr::Keys::generate();
        let owner = keys.public_key().to_hex();
        let db_path = scoped_retention_db_path(dir.path(), "wss://a.example", &owner);
        std::fs::create_dir_all(db_path.parent().unwrap()).unwrap();

        const HEAD_CONTENT: &str = r#"{"display_name":"Catalog Reviewer"}"#;
        seed_binding_head(
            &db_path,
            &keys,
            vec![
                nostr::Tag::parse(["d", "catalog-reviewer"]).expect("d tag"),
                nostr::Tag::parse(["skill", "ethereum-dev", "developers"]).expect("skill tag"),
            ],
            HEAD_CONTENT,
        );
        // Corrupt the stored head AFTER seeding, so the row exists but its
        // `raw_event` no longer parses.
        let conn = open_retention_db(&db_path).unwrap();
        conn.execute(
            "UPDATE persona_events SET raw_event = 'not-a-json-event'
             WHERE kind = ?1 AND pubkey = ?2 AND d_tag = ?3",
            (KIND_PERSONA, owner.clone(), "catalog-reviewer".to_string()),
        )
        .expect("corrupt head");
        drop(conn);

        let err = prepare_persona_publication_at(&db_path, &keys, &persona(), None)
            .expect_err("an unparsable head must block the rebuild");
        assert!(
            err.contains("failed to parse retained persona head"),
            "error must name the head parse failure; got: {err}"
        );

        // Row untouched: bindings intact for the next attempt.
        let conn = open_retention_db(&db_path).unwrap();
        let row = get_retained_event(&conn, KIND_PERSONA, &owner, "catalog-reviewer")
            .unwrap()
            .expect("head row survives");
        assert_eq!(row.raw_event, "not-a-json-event");
        assert_eq!(row.content, HEAD_CONTENT);
    }

    /// A `shared = true` persona plus the scope that says so.
    fn shared_persona_scope(dir: &std::path::Path) -> (RetentionScope, Vec<AgentDefinition>) {
        let keys = nostr::Keys::generate();
        let db_path = scoped_retention_db_path(dir, "wss://a.example", &keys.public_key().to_hex());
        std::fs::create_dir_all(db_path.parent().unwrap()).unwrap();
        prepare_persona_publication_at(&db_path, &keys, &persona(), Some(true)).unwrap();
        (
            RetentionScope {
                db_path,
                relay_url: "wss://a.example".to_string(),
                owner_keys: keys,
            },
            vec![persona()],
        )
    }

    #[test]
    fn test_resolvable_scope_projects_the_retained_share_state() {
        let dir = tempfile::tempdir().unwrap();
        let (scope, mut personas) = shared_persona_scope(dir.path());

        project_scoped_persona_sharing(Ok(scope), &mut personas);

        assert!(personas[0].shared);
    }

    #[test]
    fn test_recovery_mode_identity_projects_unshared_instead_of_failing() {
        let dir = tempfile::tempdir().unwrap();
        let (_scope, mut personas) = shared_persona_scope(dir.path());
        personas[0].shared = true;

        // The real recovery-mode failure: `active_retention_scope` cannot
        // resolve a scope without signing keys, which is exactly what
        // `identity_lost` / `keyring_locked` withhold.
        let state = crate::app_state::build_app_state();
        state
            .identity_lost
            .store(true, std::sync::atomic::Ordering::Release);
        let error = state
            .signing_keys()
            .expect_err("recovery mode must withhold signing keys");

        project_scoped_persona_sharing(Err(error), &mut personas);

        assert!(
            !personas[0].shared,
            "an unresolvable scope degrades to unshared so list/create/update keep working"
        );
    }

    #[test]
    fn test_unopenable_retention_db_projects_unshared_instead_of_failing() {
        let dir = tempfile::tempdir().unwrap();
        let keys = nostr::Keys::generate();
        let mut personas = vec![persona()];
        personas[0].shared = true;

        project_scoped_persona_sharing(
            Ok(RetentionScope {
                // A directory cannot be opened as the retention database.
                db_path: dir.path().to_path_buf(),
                relay_url: "wss://a.example".to_string(),
                owner_keys: keys,
            }),
            &mut personas,
        );

        assert!(!personas[0].shared);
    }

    #[test]
    fn explicit_share_enqueue_failure_is_returned() {
        let dir = tempfile::tempdir().unwrap();
        let keys = nostr::Keys::generate();
        let error = prepare_persona_publication_at(dir.path(), &keys, &persona(), Some(true))
            .expect_err("a directory cannot be opened as the retention database");
        assert!(error.contains("failed to open retention db"));
    }

    #[test]
    fn shared_publication_rejects_invisible_definition_text() {
        let dir = tempfile::tempdir().unwrap();
        let keys = nostr::Keys::generate();
        let db_path = dir.path().join("retention.sqlite3");
        let mut unsafe_persona = persona();
        unsafe_persona.system_prompt = "Review\u{200B} the catalog.".to_string();

        let error = prepare_persona_publication_at(&db_path, &keys, &unsafe_persona, Some(true))
            .expect_err("sharing must reject an invisible instruction character");

        assert!(error.contains("U+200B"));
    }

    /// Seed a retained 30175 persona head dated `created_at` seconds since
    /// epoch, then return the enqueued kind:5 tombstone after tombstoning.
    fn seed_persona_head(db_path: &std::path::Path, keys: &nostr::Keys, created_at: i64) {
        use crate::managed_agents::persona_events::build_persona_event;
        use nostr::JsonUtil;
        let mut shared = persona();
        shared.shared = true;
        let event = build_persona_event(&shared, None)
            .unwrap()
            .custom_created_at(nostr::Timestamp::from(created_at as u64))
            .sign_with_keys(keys)
            .unwrap();
        let conn = open_retention_db(db_path).unwrap();
        crate::managed_agents::retention::retain_event(
            &conn,
            &RetainedEvent {
                kind: KIND_PERSONA,
                pubkey: keys.public_key().to_hex(),
                d_tag: "catalog-reviewer".to_string(),
                content: event.content.to_string(),
                created_at,
                raw_event: event.as_json(),
                pending_sync: false,
            },
        )
        .unwrap();
    }

    fn enqueued_persona_tombstone(db_path: &std::path::Path) -> RetainedEvent {
        use crate::managed_agents::retention::get_pending_sync;
        let conn = open_retention_db(db_path).unwrap();
        get_pending_sync(&conn)
            .unwrap()
            .into_iter()
            .find(|row| row.kind == 5)
            .expect("a kind:5 persona tombstone is enqueued")
    }

    #[test]
    fn persona_tombstone_created_at_strictly_dominates_a_future_dated_head() {
        // The retained 30175 head may be future-dated (monotonic_created_at
        // bumps a same-second re-publish past the prior head). The relay only
        // soft-deletes coordinate versions with created_at <= the tombstone's,
        // and the flush loop never re-reads the (purged) head — so a kind:5
        // signed at wall-clock `now` would leave the persona live forever once
        // its local retry witness is gone.
        let dir = tempfile::tempdir().unwrap();
        let keys = nostr::Keys::generate();
        let owner = keys.public_key().to_hex();
        let db_path = scoped_retention_db_path(dir.path(), "wss://a.example", &owner);
        std::fs::create_dir_all(db_path.parent().unwrap()).unwrap();

        let future = nostr::Timestamp::now().as_secs() as i64 + 86_400;
        seed_persona_head(&db_path, &keys, future);

        tombstone_persona_at(&db_path, &keys, "catalog-reviewer").unwrap();

        let tombstone = enqueued_persona_tombstone(&db_path);
        assert!(
            tombstone.created_at > future,
            "tombstone created_at ({}) must strictly dominate the future-dated head ({future})",
            tombstone.created_at
        );
        // The head row itself is purged in the same transaction.
        let conn = open_retention_db(&db_path).unwrap();
        assert!(
            get_retained_event(&conn, KIND_PERSONA, &owner, "catalog-reviewer")
                .unwrap()
                .is_none(),
            "the 30175 head is purged so no stale edit can republish it"
        );
    }

    #[test]
    fn persona_tombstone_rolls_back_head_purge_when_enqueue_fails() {
        // The head purge and kind:5 enqueue run in one `BEGIN IMMEDIATE`
        // transaction. A `BEFORE INSERT` trigger blocks the enqueue (which
        // follows the head DELETE); the whole transaction must roll back so the
        // 30175 head survives with its local retry witness intact.
        let dir = tempfile::tempdir().unwrap();
        let keys = nostr::Keys::generate();
        let owner = keys.public_key().to_hex();
        let db_path = scoped_retention_db_path(dir.path(), "wss://a.example", &owner);
        std::fs::create_dir_all(db_path.parent().unwrap()).unwrap();

        let future = nostr::Timestamp::now().as_secs() as i64 + 86_400;
        seed_persona_head(&db_path, &keys, future);

        let conn = open_retention_db(&db_path).unwrap();
        conn.execute_batch(
            "CREATE TRIGGER block_all_inserts BEFORE INSERT ON persona_events
             BEGIN
                 SELECT RAISE(ABORT, 'insert blocked by test trigger');
             END;",
        )
        .unwrap();
        drop(conn);

        let err = tombstone_persona_at(&db_path, &keys, "catalog-reviewer")
            .expect_err("tombstone with INSERT trigger must fail");
        assert!(
            err.contains("insert blocked by test trigger") || err.contains("blocked"),
            "error must name the trigger cause; got: {err}"
        );

        let conn = open_retention_db(&db_path).unwrap();
        assert!(
            get_retained_event(&conn, KIND_PERSONA, &owner, "catalog-reviewer")
                .unwrap()
                .is_some(),
            "the 30175 head must survive when the tombstone enqueue fails"
        );
    }
}
