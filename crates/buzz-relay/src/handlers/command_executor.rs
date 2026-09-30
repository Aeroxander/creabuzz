//! Command executor — transactional event processing for command kinds.
//!
//! Command kinds (41010–41012, 30620, 46020, 46030–46031) are processed
//! transactionally: validate → begin tx → insert event → execute mutations → commit.
//!
//! SECURITY: This module is only reachable AFTER the ingest pipeline has verified:
//! 1. Event signature (verify_event)
//! 2. Timestamp freshness (±15 min)
//! 3. Pubkey/auth identity match
//! 4. Per-kind scope authorization

use std::sync::Arc;

use chrono::Utc;
use nostr::Event;
use sha2::{Digest, Sha256};
use tracing::warn;
use uuid::Uuid;

use buzz_core::kind::*;
use buzz_core::tenant::{CommunityId, TenantContext};
use buzz_datastore_tracing::datastore_span;
use buzz_db::workflow::{ApprovalStatus, RunStatus};
use buzz_db::DbError;
use buzz_workflow::executor::TriggerContext;

use crate::state::AppState;
use crate::webhook_secret;

use super::ingest::{extract_channel_id, IngestAuth, IngestError, IngestResult};
use super::side_effects::{
    emit_group_discovery_events, emit_membership_notification, emit_system_message,
    publish_dm_visibility_snapshot,
};

/// Route a command-kind event to the appropriate handler.
pub async fn handle_command(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    event: Event,
    auth: IngestAuth,
) -> Result<IngestResult, IngestError> {
    // Ensure the authenticated user exists in the users table (foreign key requirement).
    // The old REST handlers did this via extract_auth_context; command executor must do it explicitly.
    let pubkey_bytes = auth.pubkey().to_bytes().to_vec();
    match state
        .db
        .ensure_user(tenant.community(), &pubkey_bytes)
        .await
    {
        Ok(true) => {
            metrics::counter!(
                "buzz_users_created_total",
                "community" => tenant.host().to_owned()
            )
            .increment(1);
        }
        Ok(false) => {}
        Err(e) => {
            tracing::warn!("command_executor: ensure_user failed: {e}");
        }
    }

    let kind = event.kind.as_u16() as u32;
    match kind {
        KIND_DM_OPEN => handle_dm_open(tenant, state, &event, &auth).await,
        KIND_DM_ADD_MEMBER => handle_dm_add_member(tenant, state, &event, &auth).await,
        KIND_DM_HIDE => handle_dm_hide(tenant, state, &event, &auth).await,
        KIND_WORKFLOW_DEF => handle_workflow_def(tenant, state, &event, &auth).await,
        KIND_WORKFLOW_TRIGGER => handle_workflow_trigger(tenant, state, &event, &auth).await,
        KIND_APPROVAL_GRANT => handle_approval_grant(tenant, state, &event, &auth).await,
        KIND_APPROVAL_DENY => handle_approval_deny(tenant, state, &event, &auth).await,
        _ => Err(IngestError::Rejected(format!(
            "unknown command kind: {kind}"
        ))),
    }
}

/// Result of persisting a command event: either a duplicate (already processed)
/// or an open transaction that the handler must commit after executing mutations.
enum PersistResult {
    /// Event was already processed — return idempotent success.
    Duplicate,
    /// Event inserted — transaction is open, handler must commit after mutations.
    Inserted(sqlx::Transaction<'static, sqlx::Postgres>),
}

/// Persist a command event inside a transaction. Returns the OPEN transaction
/// as an idempotency guard — if the event was already stored, `Duplicate` is
/// returned and the handler skips execution.
///
/// If the event is a duplicate (ON CONFLICT DO NOTHING), the transaction is
/// rolled back and `PersistResult::Duplicate` is returned — no mutations needed.
///
/// NOTE: Domain mutations (open_dm, upsert_workflow, etc.) execute on the
/// connection pool, NOT inside this transaction. The pattern is idempotent but
/// not strictly atomic: if a mutation succeeds but commit fails, the mutation
/// persists without the event record. On retry, the event INSERT succeeds
/// (no conflict), and the mutation re-executes — which is safe for idempotent
/// operations (open_dm, hide_dm, update_approval, upsert_workflow).
#[datastore_span(name = "persist_command_event", system = "postgresql")]
async fn persist_command_event(
    db: &buzz_db::Db,
    tenant: &TenantContext,
    event: &Event,
    channel_id_override: Option<Uuid>,
) -> Result<PersistResult, IngestError> {
    use buzz_db::replaceable::{ParameterizedReplacePrecondition, ParameterizedReplaceStatus};

    let channel_id = channel_id_override.or_else(|| extract_channel_id(event));
    let mut tx = db
        .begin_event_write_transaction()
        .await
        .map_err(|e| IngestError::Internal(format!("error: begin transaction: {e}")))?;
    buzz_deletion::store(db)
        .guard_transaction(&mut tx, tenant.community())
        .await
        .map_err(|error| {
            IngestError::Rejected(format!("restricted: community writes are fenced: {error}"))
        })?;

    let d_tag = buzz_db::event::extract_d_tag(event);
    if let Some(d_tag) = d_tag.as_deref() {
        if d_tag.len() > buzz_db::event::D_TAG_MAX_LEN {
            return Err(IngestError::Rejected(format!(
                "invalid: d tag too long ({} bytes, max {})",
                d_tag.len(),
                buzz_db::event::D_TAG_MAX_LEN,
            )));
        }

        let kind = event.kind.as_u16() as i32;
        let (expected_revision, revision_error) = match parse_expected_workflow_revision(
            kind,
            extract_tag(event, "expected-revision").as_deref(),
        ) {
            Ok(expected_revision) => (expected_revision, None),
            Err(error) => (None, Some(error)),
        };
        let precondition = if revision_error.is_some() {
            ParameterizedReplacePrecondition::ExactReplayOnly
        } else if let Some(expected_revision) = expected_revision.as_deref() {
            ParameterizedReplacePrecondition::ExpectedRevision(expected_revision)
        } else {
            ParameterizedReplacePrecondition::Unconditional
        };
        let result = db
            .replace_parameterized_event_in_transaction(
                &mut tx,
                tenant.community(),
                event,
                d_tag,
                channel_id,
                precondition,
            )
            .await
            .map_err(|e| {
                IngestError::Internal(format!("error: replace parameterized event: {e}"))
            })?;

        return match result.status {
            ParameterizedReplaceStatus::Inserted => Ok(PersistResult::Inserted(tx)),
            ParameterizedReplaceStatus::Duplicate => Ok(PersistResult::Duplicate),
            ParameterizedReplaceStatus::Superseded
                if kind == KIND_WORKFLOW_DEF as i32 && expected_revision.is_some() =>
            {
                Err(IngestError::Rejected(
                    "conflict: workflow update was superseded; refresh and try again".into(),
                ))
            }
            ParameterizedReplaceStatus::Superseded => Ok(PersistResult::Duplicate),
            ParameterizedReplaceStatus::RevisionMissing => Err(IngestError::Rejected(
                "conflict: workflow revision does not exist".into(),
            )),
            ParameterizedReplaceStatus::RevisionMismatch => Err(IngestError::Rejected(
                "conflict: workflow changed since it was loaded".into(),
            )),
            ParameterizedReplaceStatus::ReplayOnlyMiss => match revision_error {
                Some(error) => Err(error),
                None => Err(IngestError::Internal(
                    "error: replay-only replacement lacked a revision error".into(),
                )),
            },
        };
    }

    let (_, was_inserted) =
        buzz_db::event::insert_event_in_transaction(&mut tx, tenant.community(), event, channel_id)
            .await
            .map_err(|e| IngestError::Internal(format!("error: insert event: {e}")))?;
    if was_inserted {
        Ok(PersistResult::Inserted(tx))
    } else {
        Ok(PersistResult::Duplicate)
    }
}

fn parse_expected_workflow_revision(
    kind: i32,
    expected_revision: Option<&str>,
) -> Result<Option<Vec<u8>>, IngestError> {
    if kind != KIND_WORKFLOW_DEF as i32 {
        return Ok(None);
    }

    expected_revision
        .map(|expected| {
            let id = hex::decode(expected).map_err(|_| {
                IngestError::Rejected("invalid: bad expected workflow revision".into())
            })?;
            if id.len() != 32 {
                return Err(IngestError::Rejected(
                    "invalid: bad expected workflow revision".into(),
                ));
            }
            Ok(id)
        })
        .transpose()
}

/// Extract all `p` tag values (hex pubkeys) from an event.
fn extract_p_tags(event: &Event) -> Vec<String> {
    event
        .tags
        .iter()
        .filter_map(|t| {
            if t.kind().to_string() == "p" {
                t.content().map(|s| s.to_string())
            } else {
                None
            }
        })
        .collect()
}

/// Extract the first `h` tag value (channel UUID) from an event.
fn extract_h_tag(event: &Event) -> Option<String> {
    event.tags.iter().find_map(|t| {
        if t.kind().to_string() == "h" {
            t.content().map(|s| s.to_string())
        } else {
            None
        }
    })
}

/// Extract the first `d` tag value from an event.
fn extract_d_tag(event: &Event) -> Option<String> {
    event.tags.iter().find_map(|t| {
        if t.kind().to_string() == "d" {
            t.content().map(|s| s.to_string())
        } else {
            None
        }
    })
}

/// Extract the first `e` tag value from an event.
fn extract_e_tag(event: &Event) -> Option<String> {
    event.tags.iter().find_map(|t| {
        if t.kind().to_string() == "e" {
            t.content().map(|s| s.to_string())
        } else {
            None
        }
    })
}

/// Extract a tag value by name.
fn extract_tag(event: &Event, tag_name: &str) -> Option<String> {
    event.tags.iter().find_map(|t| {
        if t.kind().to_string() == tag_name {
            t.content().map(|s| s.to_string())
        } else {
            None
        }
    })
}

/// Decode a hex pubkey string to 32 bytes.
fn decode_pubkey(hex_str: &str) -> Result<Vec<u8>, IngestError> {
    let bytes = hex::decode(hex_str)
        .map_err(|_| IngestError::Rejected(format!("invalid: bad pubkey hex: {hex_str}")))?;
    if bytes.len() != 32 {
        return Err(IngestError::Rejected(format!(
            "invalid: pubkey must be 32 bytes: {hex_str}"
        )));
    }
    Ok(bytes)
}

/// Compute SHA-256 hash of a string, returning raw bytes.
fn compute_definition_hash(json_str: &str) -> Vec<u8> {
    Sha256::digest(json_str.as_bytes()).to_vec()
}

async fn handle_dm_open(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    event: &Event,
    auth: &IngestAuth,
) -> Result<IngestResult, IngestError> {
    let self_bytes = auth.pubkey().to_bytes().to_vec();
    let self_hex = hex::encode(&self_bytes);

    // 1. Extract participant pubkeys from `p` tags
    let p_tags = extract_p_tags(event);

    // 2. Validate: at least 1 other participant, max 8 others (9 total)
    if p_tags.is_empty() {
        return Err(IngestError::Rejected(
            "invalid: pubkeys must contain at least 1 other participant".into(),
        ));
    }
    if p_tags.len() > 8 {
        return Err(IngestError::Rejected(
            "invalid: pubkeys may contain at most 8 other participants (9 total)".into(),
        ));
    }

    // Decode all provided pubkeys
    let mut other_bytes: Vec<Vec<u8>> = Vec::with_capacity(p_tags.len());
    for hex_str in &p_tags {
        other_bytes.push(decode_pubkey(hex_str)?);
    }

    // 3. Build full participant set (self + others, deduplicated)
    let mut all_bytes: Vec<Vec<u8>> = vec![self_bytes.clone()];
    for ob in &other_bytes {
        if !all_bytes.iter().any(|b| b == ob) {
            all_bytes.push(ob.clone());
        }
    }

    // Persist the command event (idempotency) — returns open transaction
    let tx = match persist_command_event(&state.db, tenant, event, None).await? {
        PersistResult::Duplicate => {
            return Ok(IngestResult {
                event_id: event.id.to_hex(),
                accepted: true,
                message: "duplicate: already processed".into(),
            });
        }
        PersistResult::Inserted(tx) => tx,
    };

    // 4. Execute: open_dm
    let all_refs: Vec<&[u8]> = all_bytes.iter().map(|b| b.as_slice()).collect();
    let (channel, was_created) = state
        .db
        .open_dm(tenant.community(), &all_refs, &self_bytes)
        .await
        .map_err(|e| IngestError::Internal(format!("error: db open_dm: {e}")))?;

    // Finalize the idempotency record after the separate mutation succeeds.
    tx.commit()
        .await
        .map_err(|e| IngestError::Internal(format!("error: commit transaction: {e}")))?;

    // 5. Side effects if newly created (post-commit, best-effort)
    if was_created {
        metrics::counter!(
            "buzz_channels_created_total",
            "community" => tenant.host().to_owned(),
            "type" => "dm"
        )
        .increment(1);

        // Invalidate caches for all participants
        for pk in &all_bytes {
            state.invalidate_membership(tenant, channel.id, pk);
        }

        let participant_hexes: Vec<String> = all_bytes.iter().map(hex::encode).collect();
        if let Err(e) = emit_system_message(
            tenant,
            state,
            channel.id,
            serde_json::json!({
                "type": "dm_created",
                "actor": self_hex,
                "participants": participant_hexes,
            }),
            chrono::Utc::now(),
        )
        .await
        {
            warn!("DM open: system message failed: {e}");
        }

        if let Err(e) = emit_group_discovery_events(tenant, state, channel.id).await {
            warn!(channel = %channel.id, "DM open: discovery emission failed: {e}");
        }

        for participant in &all_bytes {
            if let Err(e) = emit_membership_notification(
                tenant,
                state,
                channel.id,
                participant,
                &self_bytes,
                KIND_MEMBER_ADDED_NOTIFICATION,
            )
            .await
            {
                warn!("DM open: membership notification failed: {e}");
            }
        }
    } else {
        // Re-open of an existing DM cleared the caller's hidden_at; refresh
        // their NIP-DV snapshot so the DM reappears in the sidebar.
        if let Err(e) = publish_dm_visibility_snapshot(tenant, state, &self_bytes).await {
            warn!("DM re-open: visibility snapshot failed: {e}");
        }
    }

    // 6. Return response
    Ok(IngestResult {
        event_id: event.id.to_hex(),
        accepted: true,
        message: format!(
            "response:{}",
            serde_json::json!({
                "channel_id": channel.id.to_string(),
                "created": was_created,
            })
        ),
    })
}

async fn handle_dm_add_member(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    event: &Event,
    auth: &IngestAuth,
) -> Result<IngestResult, IngestError> {
    let self_bytes = auth.pubkey().to_bytes().to_vec();

    // 1. Extract target channel from `h` tag, new member pubkeys from `p` tags
    let channel_id_str = extract_h_tag(event)
        .ok_or_else(|| IngestError::Rejected("invalid: missing h tag (channel_id)".into()))?;
    let channel_id = Uuid::parse_str(&channel_id_str)
        .map_err(|_| IngestError::Rejected("invalid: bad channel_id format".into()))?;

    let p_tags = extract_p_tags(event);
    if p_tags.is_empty() {
        return Err(IngestError::Rejected(
            "invalid: must specify at least 1 new participant in p tags".into(),
        ));
    }

    // 2. Validate caller is member of existing DM
    let is_member = state
        .is_member_cached(tenant.community(), channel_id, &self_bytes)
        .await
        .map_err(|e| IngestError::Internal(format!("error: membership check: {e}")))?;
    if !is_member {
        return Err(IngestError::Rejected(
            "forbidden: not a member of this DM".into(),
        ));
    }

    // 3. Validate channel is type "dm"
    let existing_channel = state
        .db
        .get_channel_for_event_write(tenant.community(), channel_id)
        .await
        .map_err(|_| IngestError::Rejected("invalid: DM not found".into()))?;
    if existing_channel.channel_type != "dm" {
        return Err(IngestError::Rejected("invalid: channel is not a DM".into()));
    }

    // 4. Get existing members, merge with new
    let existing_members = state
        .db
        .get_members_for_event_write(tenant.community(), channel_id)
        .await
        .map_err(|e| IngestError::Internal(format!("error: get members: {e}")))?;

    let mut all_bytes: Vec<Vec<u8>> = existing_members.into_iter().map(|m| m.pubkey).collect();

    // Decode and merge new pubkeys
    for hex_str in &p_tags {
        let bytes = decode_pubkey(hex_str)?;
        if !all_bytes.iter().any(|b| b == &bytes) {
            all_bytes.push(bytes);
        }
    }

    // 5. Enforce max 9 participants
    if all_bytes.len() > 9 {
        return Err(IngestError::Rejected(
            "invalid: DM supports at most 9 participants".into(),
        ));
    }

    // Persist the command event — returns open transaction
    let tx = match persist_command_event(&state.db, tenant, event, None).await? {
        PersistResult::Duplicate => {
            return Ok(IngestResult {
                event_id: event.id.to_hex(),
                accepted: true,
                message: "duplicate: already processed".into(),
            });
        }
        PersistResult::Inserted(tx) => tx,
    };

    // 6. Execute: open_dm with expanded set (creates NEW DM — DM sets are immutable)
    let all_refs: Vec<&[u8]> = all_bytes.iter().map(|b| b.as_slice()).collect();
    let (new_channel, was_created) = state
        .db
        .open_dm(tenant.community(), &all_refs, &self_bytes)
        .await
        .map_err(|e| IngestError::Internal(format!("error: db open_dm: {e}")))?;

    // Finalize the idempotency record after the separate mutation succeeds.
    tx.commit()
        .await
        .map_err(|e| IngestError::Internal(format!("error: commit transaction: {e}")))?;

    // 7. Cache invalidation + notifications for new DM (post-commit, best-effort)
    if was_created {
        metrics::counter!(
            "buzz_channels_created_total",
            "community" => tenant.host().to_owned(),
            "type" => "dm"
        )
        .increment(1);

        for pk in &all_bytes {
            state.invalidate_membership(tenant, new_channel.id, pk);
        }

        if let Err(e) = emit_group_discovery_events(tenant, state, new_channel.id).await {
            warn!(channel = %new_channel.id, "DM add_member: discovery emission failed: {e}");
        }

        for participant_bytes in &all_bytes {
            if let Err(e) = emit_membership_notification(
                tenant,
                state,
                new_channel.id,
                participant_bytes,
                &self_bytes,
                KIND_MEMBER_ADDED_NOTIFICATION,
            )
            .await
            {
                warn!("DM add_member: membership notification failed: {e}");
            }
        }
    }

    // 8. Return response
    Ok(IngestResult {
        event_id: event.id.to_hex(),
        accepted: true,
        message: format!(
            "response:{}",
            serde_json::json!({
                "channel_id": new_channel.id.to_string(),
            })
        ),
    })
}

async fn handle_dm_hide(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    event: &Event,
    auth: &IngestAuth,
) -> Result<IngestResult, IngestError> {
    let self_bytes = auth.pubkey().to_bytes().to_vec();

    // 1. Extract channel from `h` tag
    let channel_id_str = extract_h_tag(event)
        .ok_or_else(|| IngestError::Rejected("invalid: missing h tag (channel_id)".into()))?;
    let channel_id = Uuid::parse_str(&channel_id_str)
        .map_err(|_| IngestError::Rejected("invalid: bad channel_id format".into()))?;

    // 2. Validate caller is member of the DM
    let is_member = state
        .is_member_cached(tenant.community(), channel_id, &self_bytes)
        .await
        .map_err(|e| IngestError::Internal(format!("error: membership check: {e}")))?;
    if !is_member {
        return Err(IngestError::Rejected(
            "forbidden: not a member of this DM".into(),
        ));
    }

    // 3. Validate channel is type "dm"
    let channel = state
        .db
        .get_channel_for_event_write(tenant.community(), channel_id)
        .await
        .map_err(|_| IngestError::Rejected("invalid: DM not found".into()))?;
    if channel.channel_type != "dm" {
        return Err(IngestError::Rejected("invalid: channel is not a DM".into()));
    }

    // Persist the command event — returns open transaction
    let tx = match persist_command_event(&state.db, tenant, event, None).await? {
        PersistResult::Duplicate => {
            return Ok(IngestResult {
                event_id: event.id.to_hex(),
                accepted: true,
                message: "duplicate: already processed".into(),
            });
        }
        PersistResult::Inserted(tx) => tx,
    };

    // 4. Execute: hide_dm
    state
        .db
        .hide_dm(tenant.community(), channel_id, &self_bytes)
        .await
        .map_err(|e| IngestError::Internal(format!("error: db hide_dm: {e}")))?;

    // Finalize the idempotency record after the separate mutation succeeds.
    tx.commit()
        .await
        .map_err(|e| IngestError::Internal(format!("error: commit transaction: {e}")))?;

    // 5. Side effect (post-commit, best-effort): refresh the caller's NIP-DV
    // visibility snapshot so clients can filter this DM out of the sidebar.
    if let Err(e) = publish_dm_visibility_snapshot(tenant, state, &self_bytes).await {
        warn!("DM hide: visibility snapshot failed: {e}");
    }

    // 6. Return response
    Ok(IngestResult {
        event_id: event.id.to_hex(),
        accepted: true,
        message: "{}".into(),
    })
}

async fn handle_workflow_def(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    event: &Event,
    auth: &IngestAuth,
) -> Result<IngestResult, IngestError> {
    let self_bytes = auth.pubkey().to_bytes().to_vec();

    // 1. Extract channel and the canonical workflow UUID from the NIP-33 d-tag.
    let channel_id_str = extract_h_tag(event)
        .ok_or_else(|| IngestError::Rejected("invalid: missing h tag (channel_id)".into()))?;
    let channel_id = Uuid::parse_str(&channel_id_str)
        .map_err(|_| IngestError::Rejected("invalid: bad channel_id format".into()))?;

    let workflow_id_str = extract_d_tag(event)
        .ok_or_else(|| IngestError::Rejected("invalid: missing d tag (workflow_id)".into()))?;
    let workflow_id = Uuid::parse_str(&workflow_id_str)
        .map_err(|_| IngestError::Rejected("invalid: bad workflow_id format".into()))?;

    // 2. Validate caller has channel access (minimum: is a member)
    let is_member = state
        .is_member_cached(tenant.community(), channel_id, &self_bytes)
        .await
        .map_err(|e| IngestError::Internal(format!("error: membership check: {e}")))?;
    if !is_member {
        return Err(IngestError::Rejected(
            "forbidden: not a member of this channel".into(),
        ));
    }

    // 3. Parse YAML from event.content
    let (def, definition_json_str) = buzz_workflow::WorkflowEngine::parse_yaml(&event.content)
        .map_err(|e| IngestError::Rejected(format!("invalid: workflow YAML parse error: {e}")))?;
    let workflow_name = extract_tag(event, "name").unwrap_or_else(|| def.name.clone());

    // SEC-006: definitions with exfiltration-capable actions (call_webhook)
    // require elevated channel authority to save — plain membership is not
    // enough, because the workflow will forward channel content outward with
    // the owner's standing authority. Fail-closed on lookup errors.
    if def.requires_elevated_authority() {
        let role = state
            .db
            .get_member_role(tenant.community(), channel_id, &self_bytes)
            .await
            .map_err(|e| IngestError::Internal(format!("error: role check: {e}")))?;
        if !matches!(role.as_deref(), Some("owner") | Some("admin")) {
            return Err(IngestError::Rejected(
                "forbidden: workflows with call_webhook actions require the owner or admin role"
                    .into(),
            ));
        }
    }

    let mut definition_json: serde_json::Value = serde_json::from_str(&definition_json_str)
        .map_err(|e| IngestError::Internal(format!("error: json parse of definition: {e}")))?;

    let existing_workflow = match state.db.get_workflow(tenant.community(), workflow_id).await {
        Ok(workflow) => {
            if workflow.owner_pubkey != self_bytes || workflow.channel_id != Some(channel_id) {
                return Err(IngestError::Rejected(
                    "forbidden: workflow belongs to a different owner or channel".into(),
                ));
            }
            Some(workflow)
        }
        Err(DbError::NotFound(_)) => None,
        Err(e) => {
            return Err(IngestError::Internal(format!(
                "error: db get_workflow: {e}"
            )));
        }
    };

    // Preserve the existing webhook secret across updates. A new secret is
    // returned only when the workflow first gains a webhook trigger.
    let webhook_secret = if matches!(def.trigger, buzz_workflow::TriggerDef::Webhook) {
        let existing_secret = existing_workflow
            .as_ref()
            .and_then(|workflow| webhook_secret::extract_secret(&workflow.definition));
        let secret = existing_secret.unwrap_or_else(webhook_secret::generate_webhook_secret);
        webhook_secret::inject_secret(&mut definition_json, &secret);
        if existing_workflow
            .as_ref()
            .and_then(|workflow| webhook_secret::extract_secret(&workflow.definition))
            .is_none()
        {
            Some(secret)
        } else {
            None
        }
    } else {
        None
    };

    // Compute hash AFTER secret injection
    let definition_json_final = serde_json::to_string(&definition_json)
        .map_err(|e| IngestError::Internal(format!("error: json serialize: {e}")))?;
    let hash = compute_definition_hash(&definition_json_final);

    // Persist the command event — returns open transaction
    let tx = match persist_command_event(&state.db, tenant, event, None).await? {
        PersistResult::Duplicate => {
            return Ok(IngestResult {
                event_id: event.id.to_hex(),
                accepted: true,
                message: "duplicate: already processed".into(),
            });
        }
        PersistResult::Inserted(tx) => tx,
    };

    // 4. Execute: upsert by the NIP-33 d-tag UUID. A retry updates the same
    // row instead of creating another enabled workflow that would fan out on
    // every matching event. The workflow's community is the request's
    // server-bound tenant — never re-derived from the (client-supplied) channel
    // id. `community_of_channel(channel_id)` is ambiguous when the same channel
    // UUID exists in two communities and could mint the workflow under the wrong
    // tenant; `tenant.community()` is the authoritative owner. We then verify the
    // channel actually exists *inside that community* (scoped `get_channel`),
    // which fails closed if the client named a channel that belongs to a
    // different community — the same guarantee the `(community_id, channel_id)`
    // composite FK enforces on insert, surfaced here as a clean rejection.
    let community_id = tenant.community();
    state
        .db
        .get_channel_for_event_write(community_id, channel_id)
        .await
        .map_err(|_| IngestError::Rejected("invalid: workflow channel not found".into()))?;

    state
        .db
        .upsert_workflow(
            community_id,
            workflow_id,
            Some(channel_id),
            &self_bytes,
            &workflow_name,
            &definition_json_final,
            &hash,
        )
        .await
        .map_err(|e| match e {
            DbError::AccessDenied(_) => IngestError::Rejected(
                "forbidden: workflow belongs to a different owner or channel".into(),
            ),
            other => IngestError::Internal(format!("error: db upsert_workflow: {other}")),
        })?;

    // Drop the trigger-path cache entry so the new/updated definition fires on
    // the next matching event instead of after the cache TTL.
    state
        .workflow_engine
        .invalidate_channel_workflows(community_id, channel_id);

    // Commit the event transaction after the idempotent workflow upsert succeeds.
    tx.commit()
        .await
        .map_err(|e| IngestError::Internal(format!("error: commit transaction: {e}")))?;

    // 5. Return response
    let mut resp = serde_json::json!({
        "workflow_id": workflow_id.to_string(),
    });
    if let Some(secret) = webhook_secret {
        resp["webhook_secret"] = serde_json::Value::String(secret);
    }

    Ok(IngestResult {
        event_id: event.id.to_hex(),
        accepted: true,
        message: format!("response:{}", resp),
    })
}

async fn handle_workflow_trigger(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    event: &Event,
    auth: &IngestAuth,
) -> Result<IngestResult, IngestError> {
    let self_bytes = auth.pubkey().to_bytes().to_vec();

    // 1. Extract workflow reference from `d` tag or `e` tag
    let workflow_id_str = extract_d_tag(event)
        .or_else(|| extract_e_tag(event))
        .ok_or_else(|| {
            IngestError::Rejected("invalid: missing workflow reference (d or e tag)".into())
        })?;
    let workflow_id = Uuid::parse_str(&workflow_id_str)
        .map_err(|_| IngestError::Rejected("invalid: bad workflow_id format".into()))?;

    // 2. Validate workflow exists — scoped to the caller's community. The same
    // workflow UUID can exist in another community; a bare-id lookup could load
    // B's workflow and then satisfy the membership check below against B's
    // colliding channel, letting B trigger A's workflow.
    let community_id = tenant.community();
    let workflow = state
        .db
        .get_workflow(community_id, workflow_id)
        .await
        .map_err(|_| IngestError::Rejected("invalid: workflow not found".into()))?;

    // 3. Manual triggers execute with the workflow owner's authority, so only
    // the owner may start them. Channel membership alone is insufficient: a
    // member could otherwise invoke another user's webhook or message actions.
    if workflow.owner_pubkey != self_bytes {
        return Err(IngestError::Rejected(
            "forbidden: not authorized to trigger this workflow".into(),
        ));
    }

    // SEC-006: manual triggers must honor the workflow's lifecycle state and
    // recheck the owner's *current* channel authority before creating a run.
    // Without this, a disabled workflow — including one disabled because its
    // owner was removed from the channel — could still be fired by the owner.
    if !workflow.enabled || workflow.status != buzz_db::workflow::WorkflowStatus::Active {
        return Err(IngestError::Rejected(
            "forbidden: workflow is disabled or inactive".into(),
        ));
    }
    let def: buzz_workflow::WorkflowDef = serde_json::from_value(workflow.definition.clone())
        .map_err(|e| IngestError::Internal(format!("error: corrupt workflow definition: {e}")))?;
    let Some(wf_channel_id) = workflow.channel_id else {
        // No channel scope means no channel authority to verify — fail closed.
        return Err(IngestError::Rejected(
            "forbidden: workflow has no channel scope".into(),
        ));
    };
    state
        .workflow_engine
        .check_owner_authority(community_id, wf_channel_id, &workflow.owner_pubkey, &def)
        .await
        .map_err(|_| {
            IngestError::Rejected("forbidden: not authorized to trigger this workflow".into())
        })?;

    // Persist the command event under the workflow channel even though the
    // trigger event itself only carries the workflow UUID. Storing channel
    // triggers as global events leaks workflow IDs to unrelated relay members.
    let tx = match persist_command_event(&state.db, tenant, event, workflow.channel_id).await? {
        PersistResult::Duplicate => {
            return Ok(IngestResult {
                event_id: event.id.to_hex(),
                accepted: true,
                message: "duplicate: already processed".into(),
            });
        }
        PersistResult::Inserted(tx) => tx,
    };

    // 4. Execute: create workflow run
    let mut trigger_ctx = TriggerContext {
        channel_id: workflow
            .channel_id
            .map(|id| id.to_string())
            .unwrap_or_default(),
        author: hex::encode(&self_bytes),
        ..Default::default()
    };
    if !event.content.is_empty() {
        if let Ok(serde_json::Value::Object(map)) = serde_json::from_str(&event.content) {
            for (k, v) in map {
                let val_str = match v {
                    serde_json::Value::String(s) => s,
                    other => other.to_string(),
                };
                trigger_ctx.webhook_fields.insert(k, val_str);
            }
        }
    }
    let trigger_ctx_json = serde_json::to_value(&trigger_ctx).ok();

    let event_id_bytes = event.id.as_bytes().to_vec();
    let run_id = state
        .db
        .create_workflow_run(
            community_id,
            workflow_id,
            Some(&event_id_bytes),
            trigger_ctx_json.as_ref(),
        )
        .await
        .map_err(|e| IngestError::Internal(format!("error: db create_workflow_run: {e}")))?;

    // Finalize the idempotency record after the separate run creation succeeds.
    tx.commit()
        .await
        .map_err(|e| IngestError::Internal(format!("error: commit transaction: {e}")))?;

    // 5. Spawn workflow execution
    let engine = Arc::clone(&state.workflow_engine);
    let db = state.db.clone();
    let def_value = workflow.definition.clone();
    let trigger_ctx_clone = trigger_ctx.clone();
    tokio::spawn(async move {
        let def: buzz_workflow::WorkflowDef = match serde_json::from_value(def_value) {
            Ok(d) => d,
            Err(e) => {
                tracing::error!("workflow_trigger: failed to parse definition: {e}");
                if let Err(db_err) = db
                    .update_workflow_run(
                        community_id,
                        run_id,
                        RunStatus::Failed,
                        0,
                        &serde_json::json!([]),
                        Some(buzz_db::workflow::WorkflowRunFailure {
                            code: "invalid_definition",
                            message: &format!("definition parse error: {e}"),
                        }),
                    )
                    .await
                {
                    tracing::error!("workflow_trigger: failed to mark run as failed: {db_err}");
                }
                return;
            }
        };

        let result = buzz_workflow::executor::execute_from_step(
            &engine,
            community_id,
            run_id,
            &def,
            &trigger_ctx_clone,
            0,
            None,
        )
        .await;
        engine
            .finalize_run(community_id, run_id, result, None)
            .await;
    });

    // 6. Return response
    Ok(IngestResult {
        event_id: event.id.to_hex(),
        accepted: true,
        message: format!(
            "response:{}",
            serde_json::json!({
                "run_id": run_id.to_string(),
            })
        ),
    })
}

/// Enforce the approver_spec field against the requesting pubkey.
///
/// Accepted specs:
/// - `""` or `"any"` — any authenticated user may approve.
/// - 64-char lowercase hex string — only that exact pubkey may approve.
///
/// All other formats are rejected (fail-closed).
fn check_approver_spec(approver_spec: &str, requester_hex: &str) -> Result<(), IngestError> {
    let spec = approver_spec.trim();

    // Empty or "any" — anyone may approve
    if spec.is_empty() || spec == "any" {
        return Ok(());
    }

    // Exact pubkey match (64-char hex, case-insensitive)
    if spec.len() == 64 && spec.chars().all(|c| c.is_ascii_hexdigit()) {
        if requester_hex.to_lowercase() == spec.to_lowercase() {
            return Ok(());
        }
        return Err(IngestError::Rejected(
            "forbidden: not the designated approver for this request".into(),
        ));
    }

    // Role-based or unrecognised — fail closed
    Err(IngestError::Rejected(format!(
        "forbidden: approver spec '{}' is not yet supported",
        spec
    )))
}

async fn handle_approval_grant(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    event: &Event,
    auth: &IngestAuth,
) -> Result<IngestResult, IngestError> {
    let self_bytes = auth.pubkey().to_bytes().to_vec();
    let self_hex = hex::encode(&self_bytes);

    // 1. Extract approval reference from `e` tag (references the approval-requested event)
    //    or `d` tag (contains the token hash hex)
    let token_hash_hex = extract_d_tag(event)
        .or_else(|| extract_e_tag(event))
        .ok_or_else(|| {
            IngestError::Rejected("invalid: missing approval reference (d or e tag)".into())
        })?;

    let token_hash = hex::decode(&token_hash_hex)
        .map_err(|_| IngestError::Rejected("invalid: bad approval token hash hex".into()))?;

    // 2. Look up the approval record. A token that belongs to a NIP-ORG
    //    budget approval (the kind:46010 request recorded by
    //    `budget_enforcement`) resolves through the same command surface —
    //    see `resolve_budget_approval_command`.
    let approval = match state
        .db
        .get_approval_by_stored_hash(tenant.community(), &token_hash)
        .await
    {
        Ok(approval) => approval,
        Err(DbError::NotFound(_)) => {
            return resolve_budget_approval_command(
                &state.db,
                tenant,
                event,
                &self_bytes,
                &token_hash,
                buzz_db::budget::BudgetApprovalDecision::Granted,
            )
            .await;
        }
        Err(_) => return Err(IngestError::Rejected("invalid: approval not found".into())),
    };

    // 3. Validate approval is pending and not expired
    if approval.status != ApprovalStatus::Pending {
        return Err(IngestError::Rejected(format!(
            "invalid: approval already {}",
            approval.status
        )));
    }
    if Utc::now() > approval.expires_at {
        return Err(IngestError::Rejected(
            "invalid: approval token has expired".into(),
        ));
    }

    // 4. Validate caller is authorized approver
    check_approver_spec(&approval.approver_spec, &self_hex)?;

    // Persist the command event — returns open transaction
    let tx = match persist_command_event(&state.db, tenant, event, None).await? {
        PersistResult::Duplicate => {
            return Ok(IngestResult {
                event_id: event.id.to_hex(),
                accepted: true,
                message: "duplicate: already processed".into(),
            });
        }
        PersistResult::Inserted(tx) => tx,
    };

    // 5. Execute: update approval status to granted
    let note = if event.content.is_empty() {
        None
    } else {
        Some(event.content.as_str())
    };

    let updated = state
        .db
        .update_approval_by_stored_hash(
            tenant.community(),
            &token_hash,
            ApprovalStatus::Granted,
            Some(&self_bytes),
            note,
        )
        .await
        .map_err(|e| IngestError::Internal(format!("error: db update_approval: {e}")))?;

    if !updated {
        return Err(IngestError::Rejected(
            "invalid: approval already acted on (race)".into(),
        ));
    }

    // Finalize the idempotency record after the separate approval update succeeds.
    tx.commit()
        .await
        .map_err(|e| IngestError::Internal(format!("error: commit transaction: {e}")))?;

    // 6. Resume workflow execution (post-commit, async)
    let community_id = tenant.community();
    let run_id = approval.run_id;
    let workflow_id = approval.workflow_id;
    let resume_index = approval.step_index as usize + 1;
    let engine = Arc::clone(&state.workflow_engine);
    let db = state.db.clone();

    tokio::spawn(async move {
        resume_workflow_after_approval(engine, db, community_id, run_id, workflow_id, resume_index)
            .await;
    });

    // 7. Return response
    Ok(IngestResult {
        event_id: event.id.to_hex(),
        accepted: true,
        message: format!(
            "response:{}",
            serde_json::json!({
                "status": "granted",
                "run_id": run_id.to_string(),
            })
        ),
    })
}

async fn handle_approval_deny(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    event: &Event,
    auth: &IngestAuth,
) -> Result<IngestResult, IngestError> {
    let self_bytes = auth.pubkey().to_bytes().to_vec();
    let self_hex = hex::encode(&self_bytes);

    // 1. Extract approval reference
    let token_hash_hex = extract_d_tag(event)
        .or_else(|| extract_e_tag(event))
        .ok_or_else(|| {
            IngestError::Rejected("invalid: missing approval reference (d or e tag)".into())
        })?;

    let token_hash = hex::decode(&token_hash_hex)
        .map_err(|_| IngestError::Rejected("invalid: bad approval token hash hex".into()))?;

    // 2. Look up the approval record. A token that belongs to a NIP-ORG
    //    budget approval (the kind:46010 request recorded by
    //    `budget_enforcement`) resolves through the same command surface —
    //    see `resolve_budget_approval_command`.
    let approval = match state
        .db
        .get_approval_by_stored_hash(tenant.community(), &token_hash)
        .await
    {
        Ok(approval) => approval,
        Err(DbError::NotFound(_)) => {
            return resolve_budget_approval_command(
                &state.db,
                tenant,
                event,
                &self_bytes,
                &token_hash,
                buzz_db::budget::BudgetApprovalDecision::Denied,
            )
            .await;
        }
        Err(_) => return Err(IngestError::Rejected("invalid: approval not found".into())),
    };

    // 3. Validate approval is pending and not expired
    if approval.status != ApprovalStatus::Pending {
        return Err(IngestError::Rejected(format!(
            "invalid: approval already {}",
            approval.status
        )));
    }
    if Utc::now() > approval.expires_at {
        return Err(IngestError::Rejected(
            "invalid: approval token has expired".into(),
        ));
    }

    // 4. Validate caller is authorized approver
    check_approver_spec(&approval.approver_spec, &self_hex)?;

    // Persist the command event — returns open transaction
    let tx = match persist_command_event(&state.db, tenant, event, None).await? {
        PersistResult::Duplicate => {
            return Ok(IngestResult {
                event_id: event.id.to_hex(),
                accepted: true,
                message: "duplicate: already processed".into(),
            });
        }
        PersistResult::Inserted(tx) => tx,
    };

    // 5. Execute: update approval status to denied
    let note = if event.content.is_empty() {
        None
    } else {
        Some(event.content.as_str())
    };

    let updated = state
        .db
        .update_approval_by_stored_hash(
            tenant.community(),
            &token_hash,
            ApprovalStatus::Denied,
            Some(&self_bytes),
            note,
        )
        .await
        .map_err(|e| IngestError::Internal(format!("error: db update_approval: {e}")))?;

    if !updated {
        return Err(IngestError::Rejected(
            "invalid: approval already acted on (race)".into(),
        ));
    }

    // Finalize the idempotency record after the separate approval denial succeeds.
    tx.commit()
        .await
        .map_err(|e| IngestError::Internal(format!("error: commit transaction: {e}")))?;

    // 6. Cancel the workflow run (post-commit, async)
    let community_id = tenant.community();
    let run_id = approval.run_id;
    let pubkey_hex = self_hex.clone();
    let db = state.db.clone();

    tokio::spawn(async move {
        let run = match db.get_workflow_run(community_id, run_id).await {
            Ok(r) => r,
            Err(e) => {
                tracing::error!("approval_deny: failed to fetch run {run_id}: {e}");
                return;
            }
        };

        if run.status != RunStatus::WaitingApproval {
            tracing::warn!(
                "approval_deny: run {run_id} has status '{}', expected 'waiting_approval'",
                run.status
            );
            return;
        }

        let cancel_msg = format!("workflow cancelled: approval denied by {pubkey_hex}");
        if let Err(e) = db
            .update_workflow_run(
                community_id,
                run_id,
                RunStatus::Cancelled,
                run.current_step,
                &run.execution_trace,
                Some(buzz_db::workflow::WorkflowRunFailure {
                    code: "approval_denied",
                    message: &cancel_msg,
                }),
            )
            .await
        {
            tracing::error!("approval_deny: failed to cancel run {run_id}: {e}");
        }
    });

    // 7. Return response
    Ok(IngestResult {
        event_id: event.id.to_hex(),
        accepted: true,
        message: format!(
            "response:{}",
            serde_json::json!({
                "status": "denied",
                "run_id": run_id.to_string(),
            })
        ),
    })
}

/// Resolve a NIP-ORG budget approval (the kind:46010 request recorded by
/// `budget_enforcement`) through the same approval command surface as
/// workflow approvals: same command kinds (46030/46031), same `d`/`e`
/// token reference, same persist-then-resolve transaction shape, and the
/// same audit trail (the persisted command event IS the audit record — no
/// separate audit write).
///
/// Grant semantics: forgive the overrun once. The pending row becomes
/// `granted` (approver + `granted_at` recorded); consumption counters are
/// never rolled back — the grant raises the budget's effective limit by
/// exactly one unit (see `budget_enforcement::effective_limit`), so the
/// subject may act again until the counter reaches the limit once more,
/// and the next overrun then raises a fresh request.
///
/// Deny semantics: the row becomes `denied` (`denied_at` recorded); no
/// tolerance is recorded and the subject stays at or over the limit. The
/// partial unique index binds only `pending` rows, so the next overrun in
/// the same window inserts a fresh pending request with a fresh token.
///
/// Expiry semantics: a pending row past `expires_at` is rejected exactly
/// like an expired workflow approval and is never resolved as if fresh.
/// It is not dead state either: the next overrun refreshes the same
/// pending row (new `expires_at`, same stored token) via
/// `create_budget_approval`, keeping the request actionable.
///
/// Authorization: budget approval rows carry no per-request approver
/// spec, so the authority is the community relay owner — the same role
/// that may publish a budget for any subject. The budgeted subject is
/// deliberately excluded: self-approval would let an agent void an
/// owner-imposed cap.
async fn resolve_budget_approval_command(
    db: &buzz_db::Db,
    tenant: &TenantContext,
    event: &Event,
    approver: &[u8],
    token_hash: &[u8],
    decision: buzz_db::budget::BudgetApprovalDecision,
) -> Result<IngestResult, IngestError> {
    let approval = db
        .get_budget_approval_by_stored_hash(tenant.community(), token_hash)
        .await
        .map_err(|_| IngestError::Rejected("invalid: approval not found".into()))?;

    if approval.status != "pending" {
        return Err(IngestError::Rejected(format!(
            "invalid: approval already {}",
            approval.status
        )));
    }
    if Utc::now() > approval.expires_at {
        return Err(IngestError::Rejected(
            "invalid: approval token has expired".into(),
        ));
    }

    check_budget_approver(db, tenant, &hex::encode(approver)).await?;

    // Persist the command event — returns open transaction.
    let tx = match persist_command_event(db, tenant, event, None).await? {
        PersistResult::Duplicate => {
            return Ok(IngestResult {
                event_id: event.id.to_hex(),
                accepted: true,
                message: "duplicate: already processed".into(),
            });
        }
        PersistResult::Inserted(tx) => tx,
    };

    // TOCTOU-guarded resolution: only a still-pending row is updated, so
    // of two concurrent resolutions exactly one wins.
    let note = if event.content.is_empty() {
        None
    } else {
        Some(event.content.as_str())
    };

    let updated = db
        .resolve_budget_approval(
            tenant.community(),
            token_hash,
            decision,
            Some(approver),
            note,
        )
        .await
        .map_err(|e| IngestError::Internal(format!("error: db resolve_budget_approval: {e}")))?;

    if !updated {
        return Err(IngestError::Rejected(
            "invalid: approval already acted on (race)".into(),
        ));
    }

    // Finalize the idempotency record after the budget resolution succeeds.
    tx.commit()
        .await
        .map_err(|e| IngestError::Internal(format!("error: commit transaction: {e}")))?;

    Ok(IngestResult {
        event_id: event.id.to_hex(),
        accepted: true,
        message: format!(
            "response:{}",
            serde_json::json!({
                "status": decision.as_str(),
                "subject": approval.subject,
                "counterType": approval.counter_type,
            })
        ),
    })
}

/// Budget approval authority: only a community relay owner may grant or
/// deny a budget approval request (see [`resolve_budget_approval_command`]
/// for why the subject itself is excluded).
async fn check_budget_approver(
    db: &buzz_db::Db,
    tenant: &TenantContext,
    approver_hex: &str,
) -> Result<(), IngestError> {
    let is_owner = db
        .get_relay_member(tenant.community(), approver_hex)
        .await
        .map_err(|e| IngestError::Internal(format!("error: db error checking approver: {e}")))?
        .is_some_and(|m| m.role == "owner");
    if is_owner {
        return Ok(());
    }
    Err(IngestError::Rejected(
        "forbidden: only a community owner may resolve a budget approval".into(),
    ))
}

/// Resume a suspended workflow run after an approval gate has been granted.
async fn resume_workflow_after_approval(
    engine: Arc<buzz_workflow::WorkflowEngine>,
    db: buzz_db::Db,
    community_id: CommunityId,
    run_id: Uuid,
    workflow_id: Uuid,
    resume_index: usize,
) {
    let run = match db.get_workflow_run(community_id, run_id).await {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("resume_workflow: failed to fetch run {run_id}: {e}");
            return;
        }
    };

    // Guard: only resume runs that are actually waiting for approval
    if run.status != RunStatus::WaitingApproval {
        tracing::warn!(
            "resume_workflow: run {run_id} has status '{}', expected 'waiting_approval'",
            run.status
        );
        return;
    }

    let workflow = match db.get_workflow(community_id, workflow_id).await {
        Ok(w) => w,
        Err(e) => {
            tracing::error!("resume_workflow: failed to fetch workflow {workflow_id}: {e}");
            return;
        }
    };

    let def: buzz_workflow::WorkflowDef = match serde_json::from_value(workflow.definition.clone())
    {
        Ok(d) => d,
        Err(e) => {
            tracing::error!("resume_workflow: failed to parse workflow definition: {e}");
            if let Err(db_err) = db
                .update_workflow_run(
                    community_id,
                    run_id,
                    RunStatus::Failed,
                    run.current_step,
                    &run.execution_trace,
                    Some(buzz_db::workflow::WorkflowRunFailure {
                        code: "invalid_definition",
                        message: &format!("definition parse error: {e}"),
                    }),
                )
                .await
            {
                tracing::error!("resume_workflow: failed to mark run as failed: {db_err}");
            }
            return;
        }
    };

    // Reconstruct step_outputs from execution trace for template resolution
    let mut initial_outputs: std::collections::HashMap<String, serde_json::Value> =
        std::collections::HashMap::new();
    if let Some(trace_arr) = run.execution_trace.as_array() {
        for entry in trace_arr {
            if let (Some(step_id), Some(output)) = (
                entry.get("step_id").and_then(|v| v.as_str()),
                entry.get("output"),
            ) {
                initial_outputs.insert(step_id.to_string(), output.clone());
            }
        }
    }

    // Restore trigger context for {{trigger.*}} templates
    let trigger_ctx: TriggerContext = run
        .trigger_context
        .as_ref()
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();

    // Execute remaining steps
    let existing_trace = run.execution_trace.as_array().cloned();
    let result = buzz_workflow::executor::execute_from_step(
        &engine,
        community_id,
        run_id,
        &def,
        &trigger_ctx,
        resume_index,
        Some(initial_outputs),
    )
    .await;
    // Nested approval gates suspend again through the same choke point —
    // a resumed run that hits a second gate persists a new approval row
    // rather than failing.
    engine
        .finish_execution(
            buzz_workflow::Suspension {
                community_id,
                workflow_id,
                channel_id: workflow.channel_id,
                author_pubkey: &workflow.owner_pubkey,
                run_id,
                def: &def,
                trigger_ctx: &trigger_ctx,
                existing_trace,
            },
            result,
        )
        .await;
}

#[cfg(test)]
mod postgres_tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind, Tag, Timestamp};

    async fn persistence_test_context() -> (buzz_db::Db, TenantContext) {
        let url = std::env::var("BUZZ_TEST_DATABASE_URL")
            .or_else(|_| std::env::var("DATABASE_URL"))
            .unwrap_or_else(|_| "postgres://buzz:buzz_dev@localhost:5432/buzz".to_string()); // sadscan:disable np.postgres.1 -- local test-only credentials
        let pool = sqlx::PgPool::connect(&url)
            .await
            .expect("connect workflow persistence test database");
        let db = buzz_db::Db::from_pool(pool);
        if std::env::var("BUZZ_TEST_SCHEMA_MODE").as_deref() != Ok("desired") {
            db.migrate()
                .await
                .expect("migrate workflow persistence test database");
        }
        let host = format!("workflow-cas-{}.example", Uuid::new_v4().simple());
        let community = db
            .ensure_configured_community(&host)
            .await
            .expect("create workflow persistence test community")
            .id;
        (db, TenantContext::resolved(community, host))
    }

    fn workflow_event(
        keys: &Keys,
        workflow_id: Uuid,
        created_at: u64,
        expected_revision: Option<&str>,
        name: &str,
    ) -> Event {
        let workflow_id = workflow_id.to_string();
        let channel_id = Uuid::new_v4().to_string();
        let mut tags = vec![
            Tag::parse(["d", workflow_id.as_str()]).expect("d tag"),
            Tag::parse(["h", channel_id.as_str()]).expect("h tag"),
        ];
        if let Some(revision) = expected_revision {
            tags.push(Tag::parse(["expected-revision", revision]).expect("revision tag"));
        }
        EventBuilder::new(
            Kind::Custom(KIND_WORKFLOW_DEF as u16),
            format!("name: {name}\ntrigger:\n  on: message_posted\nsteps: []\n"),
        )
        .tags(tags)
        .custom_created_at(Timestamp::from(created_at))
        .sign_with_keys(keys)
        .expect("workflow event")
    }

    fn rejection_message(result: Result<Option<Vec<u8>>, IngestError>) -> String {
        match result {
            Err(IngestError::Rejected(message)) => message,
            Err(IngestError::CanvasConflict(message)) => {
                panic!("unexpected canvas conflict: {message}")
            }
            Err(IngestError::AuthFailed(message)) => panic!("unexpected auth failure: {message}"),
            Err(IngestError::Internal(message)) => panic!("unexpected internal failure: {message}"),
            Ok(_) => panic!("expected revision parsing to fail"),
        }
    }

    #[test]
    fn workflow_revision_parser_accepts_create_and_valid_update() {
        let revision = [0x42; 32];
        assert_eq!(
            parse_expected_workflow_revision(KIND_WORKFLOW_DEF as i32, None)
                .expect("tagless workflow"),
            None
        );
        assert_eq!(
            parse_expected_workflow_revision(
                KIND_WORKFLOW_DEF as i32,
                Some(&hex::encode(revision)),
            )
            .expect("valid revision"),
            Some(revision.to_vec())
        );
    }

    #[test]
    fn workflow_revision_parser_rejects_malformed_values() {
        for malformed in ["not-hex", "42"] {
            assert_eq!(
                rejection_message(parse_expected_workflow_revision(
                    KIND_WORKFLOW_DEF as i32,
                    Some(malformed),
                )),
                "invalid: bad expected workflow revision",
            );
        }
    }

    #[test]
    fn revision_tag_does_not_change_other_command_kinds() {
        assert_eq!(
            parse_expected_workflow_revision(KIND_DM_OPEN as i32, Some("not-hex"))
                .expect("non-workflow revision tag"),
            None
        );
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn workflow_persistence_preserves_replays_and_rejects_dominated_cas_updates() {
        let (db, tenant) = persistence_test_context().await;
        let keys = Keys::generate();
        let workflow_id = Uuid::new_v4();
        let created_at = Timestamp::now().as_secs();
        let create = workflow_event(&keys, workflow_id, created_at, None, "create");

        let missing_revision = hex::encode([0x24; 32]);
        let missing_revision_update = workflow_event(
            &keys,
            Uuid::new_v4(),
            created_at,
            Some(&missing_revision),
            "missing-revision",
        );
        let error = match persist_command_event(&db, &tenant, &missing_revision_update, None).await
        {
            Err(error) => error,
            Ok(_) => panic!("missing revision must not create a workflow"),
        };
        assert!(matches!(
            error,
            IngestError::Rejected(ref message)
                if message == "conflict: workflow revision does not exist"
        ));

        let PersistResult::Inserted(tx) = persist_command_event(&db, &tenant, &create, None)
            .await
            .expect("persist create")
        else {
            panic!("first create must insert");
        };
        tx.commit().await.expect("commit create");
        assert!(matches!(
            persist_command_event(&db, &tenant, &create, None)
                .await
                .expect("replay create"),
            PersistResult::Duplicate
        ));

        let create_revision = create.id.to_hex();
        // Event IDs are hashes, so keep sampling instead of imposing a finite
        // cutoff that makes this same-second ordering check probabilistic.
        let mut updates = (0_u64..).map(|index| {
            workflow_event(
                &keys,
                workflow_id,
                created_at,
                Some(&create_revision),
                &format!("update-{index}"),
            )
        });
        let update = updates
            .find(|candidate| candidate.id.as_bytes() < create.id.as_bytes())
            .expect("find same-second update that wins NIP-33 ordering");
        let dominated_update = (64_u64..)
            .map(|index| {
                workflow_event(
                    &keys,
                    workflow_id,
                    created_at,
                    Some(&update.id.to_hex()),
                    &format!("update-{index}"),
                )
            })
            .find(|candidate| candidate.id.as_bytes() > update.id.as_bytes())
            .expect("find same-second CAS-matching update dominated by current head");

        let PersistResult::Inserted(tx) = persist_command_event(&db, &tenant, &update, None)
            .await
            .expect("persist update")
        else {
            panic!("matching update must insert");
        };
        tx.commit().await.expect("commit update");
        assert!(matches!(
            persist_command_event(&db, &tenant, &update, None)
                .await
                .expect("replay update"),
            PersistResult::Duplicate
        ));

        let stale_revision_update = workflow_event(
            &keys,
            workflow_id,
            created_at + 1,
            Some(&create_revision),
            "stale-revision",
        );
        let error = match persist_command_event(&db, &tenant, &stale_revision_update, None).await {
            Err(error) => error,
            Ok(_) => panic!("stale revision must not replace the current workflow"),
        };
        assert!(matches!(
            error,
            IngestError::Rejected(ref message)
                if message == "conflict: workflow changed since it was loaded"
        ));

        let error = match persist_command_event(&db, &tenant, &dominated_update, None).await {
            Err(error) => error,
            Ok(_) => panic!("distinct dominated CAS update must not report duplicate success"),
        };
        assert!(matches!(
            error,
            IngestError::Rejected(ref message)
                if message == "conflict: workflow update was superseded; refresh and try again"
        ));
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn workflow_persistence_replays_legacy_malformed_revision_before_validation() {
        let (db, tenant) = persistence_test_context().await;
        let keys = Keys::generate();
        let workflow_id = Uuid::new_v4();
        let created_at = Timestamp::now().as_secs();
        let legacy = workflow_event(
            &keys,
            workflow_id,
            created_at,
            Some("not-hex"),
            "legacy-malformed",
        );

        let mut tx = db
            .begin_event_write_transaction()
            .await
            .expect("begin legacy seed");
        let (_, was_inserted) = buzz_db::event::insert_event_in_transaction(
            &mut tx,
            tenant.community(),
            &legacy,
            extract_channel_id(&legacy),
        )
        .await
        .expect("seed legacy workflow event");
        assert!(was_inserted);
        tx.commit().await.expect("commit legacy seed");

        assert!(matches!(
            persist_command_event(&db, &tenant, &legacy, None)
                .await
                .expect("exact legacy replay must remain idempotent"),
            PersistResult::Duplicate
        ));

        let distinct = workflow_event(
            &keys,
            workflow_id,
            created_at + 1,
            Some("not-hex"),
            "distinct-malformed",
        );
        let error = match persist_command_event(&db, &tenant, &distinct, None).await {
            Err(error) => error,
            Ok(_) => panic!("distinct malformed revision must remain rejected"),
        };
        assert!(matches!(
            error,
            IngestError::Rejected(ref message)
                if message == "invalid: bad expected workflow revision"
        ));
    }

    /// WF-08 grant→resume: a granted approval resumes its suspended run to
    /// completion through the production resume path. Binds
    /// `resume_workflow_after_approval` (not a test helper): removing the
    /// grant-gated resume leaves the run `WaitingApproval` and fails this.
    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn approval_grant_resumes_suspended_run_to_completed() {
        use buzz_db::workflow::{ApprovalStatus, RunStatus};
        use buzz_workflow::{WorkflowConfig, WorkflowEngine};

        let (db, tenant) = persistence_test_context().await;
        let community = tenant.community();
        let owner = Keys::generate();
        let owner_bytes = owner.public_key().to_bytes().to_vec();
        // workflows.owner_pubkey references users — ensure the row first.
        db.ensure_user(community, &owner_bytes)
            .await
            .expect("ensure owner user");

        let (def, _) = WorkflowEngine::parse_yaml(concat!(
            "name: wf08-resume\n",
            "trigger:\n  on: webhook\n",
            "steps:\n",
            "  - id: gate\n",
            "    action: request_approval\n",
            "    from: '@owner'\n",
            "    message: Proceed?\n",
        ))
        .expect("parse approval def");
        let def_json = serde_json::to_value(&def).expect("def json");
        let workflow_id = db
            .create_workflow(
                community,
                None,
                &owner_bytes,
                "wf08-resume",
                &def_json.to_string(),
                &[9u8; 32],
            )
            .await
            .expect("create workflow");

        let engine = Arc::new(WorkflowEngine::new(db.clone(), WorkflowConfig::default()));
        let run_id = db
            .create_workflow_run(community, workflow_id, None, None)
            .await
            .expect("create run");

        // Suspend through the engine (channel-less: persistence only, no
        // 46010 emission — approvals stay actionable via get_run_approvals).
        let token = Uuid::new_v4().to_string();
        let suspended = buzz_workflow::ExecutionResult {
            approval_token: Some(token.clone()),
            step_index: 0,
            step_outputs: Default::default(),
            trace: vec![],
        };
        let ctx = buzz_workflow::executor::TriggerContext::default();
        engine
            .suspend_run(
                buzz_workflow::Suspension {
                    community_id: community,
                    workflow_id,
                    channel_id: None,
                    author_pubkey: &owner_bytes,
                    run_id,
                    def: &def,
                    trigger_ctx: &ctx,
                    existing_trace: None,
                },
                suspended,
            )
            .await
            .expect("suspend run");

        // Grant through the same TOCTOU-guarded update the ingest path uses.
        assert!(
            db.update_approval(
                community,
                &token,
                ApprovalStatus::Granted,
                Some(&owner_bytes),
                None
            )
            .await
            .expect("grant approval"),
            "first grant must win the pending row"
        );
        assert!(
            !db.update_approval(
                community,
                &token,
                ApprovalStatus::Granted,
                Some(&owner_bytes),
                None
            )
            .await
            .expect("second grant"),
            "second grant must lose the pending row (TOCTOU guard)"
        );

        // Resume through the production path (step_index 0 + 1).
        resume_workflow_after_approval(engine, db.clone(), community, run_id, workflow_id, 1).await;

        let run = db
            .get_workflow_run(community, run_id)
            .await
            .expect("fetch run");
        assert_eq!(
            run.status,
            RunStatus::Completed,
            "granted run must complete after resume"
        );
        let approvals = db
            .get_run_approvals(community, workflow_id, run_id)
            .await
            .expect("fetch approvals");
        assert_eq!(approvals.len(), 1);
        assert_eq!(approvals[0].status, ApprovalStatus::Granted);
    }

    // -- NIP-ORG budget approval resolution through the real command path --

    const BUDGET_AGENT: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    async fn budget_approval_fixture(
        db: &buzz_db::Db,
        tenant: &TenantContext,
        expires_at: chrono::DateTime<Utc>,
    ) -> [u8; 32] {
        let token_hash = [0x42u8; 32];
        let stored = db
            .create_budget_approval(
                tenant.community(),
                buzz_db::budget::CreateBudgetApprovalParams {
                    subject: BUDGET_AGENT,
                    counter_type: "runs",
                    window_start: Utc::now(),
                    limit_value: 2,
                    budget_event_id: Some("evt-ce"),
                    token_hash: &token_hash,
                    expires_at,
                },
            )
            .await
            .expect("create budget approval");
        assert_eq!(stored, token_hash);
        token_hash
    }

    fn approval_command_event(keys: &Keys, kind: u32, token_hash: &[u8], content: &str) -> Event {
        EventBuilder::new(Kind::Custom(kind as u16), content)
            .tag(Tag::parse(["d", &hex::encode(token_hash)]).expect("d tag"))
            .sign_with_keys(keys)
            .expect("sign approval command event")
    }

    /// Grant through the production resolution surface
    /// (`resolve_budget_approval_command`, the branch
    /// `handle_approval_grant` takes for kind:46010 budget tokens):
    /// pending row becomes granted with the approver recorded, and a
    /// second grant through the same path is rejected without touching
    /// the resolved row.
    #[tokio::test]
    #[ignore = "requires migrated Postgres"]
    async fn budget_grant_resolves_pending_row_through_command_path() {
        let (db, tenant) = persistence_test_context().await;
        let owner = Keys::generate();
        let owner_bytes = owner.public_key().to_bytes().to_vec();
        db.ensure_user(tenant.community(), &owner_bytes)
            .await
            .expect("ensure owner user");
        db.add_relay_member(
            tenant.community(),
            &owner.public_key().to_hex(),
            "owner",
            None,
        )
        .await
        .expect("add relay owner");

        let token_hash =
            budget_approval_fixture(&db, &tenant, Utc::now() + chrono::Duration::seconds(3600))
                .await;

        let event = approval_command_event(&owner, KIND_APPROVAL_GRANT, &token_hash, "granted");
        let result = resolve_budget_approval_command(
            &db,
            &tenant,
            &event,
            &owner_bytes,
            &token_hash,
            buzz_db::budget::BudgetApprovalDecision::Granted,
        )
        .await
        .expect("budget grant through command path");
        assert!(result.accepted);
        assert!(
            result.message.contains("granted"),
            "got: {}",
            result.message
        );

        let record = db
            .get_budget_approval_by_stored_hash(tenant.community(), &token_hash)
            .await
            .expect("fetch granted row");
        assert_eq!(record.status, "granted");
        assert_eq!(record.approver.as_deref(), Some(&owner_bytes[..]));
        assert!(record.granted_at.is_some());
        assert!(record.denied_at.is_none());

        // A second grant through the same path loses the resolved row.
        let replay =
            approval_command_event(&owner, KIND_APPROVAL_GRANT, &token_hash, "granted again");
        let err = resolve_budget_approval_command(
            &db,
            &tenant,
            &replay,
            &owner_bytes,
            &token_hash,
            buzz_db::budget::BudgetApprovalDecision::Granted,
        )
        .await
        .err()
        .expect("second grant must be rejected");
        assert!(
            matches!(err, IngestError::Rejected(ref m) if m.contains("already granted")),
            "got: {err:?}"
        );
        assert_eq!(
            db.get_budget_approval_by_stored_hash(tenant.community(), &token_hash)
                .await
                .expect("refetch")
                .status,
            "granted",
            "rejected re-grant must not mutate the row"
        );
    }

    /// Deny through the production resolution surface: the row becomes
    /// denied (denied_at, note from the command content), and a fresh
    /// overrun after the denial inserts a NEW pending row — the partial
    /// unique index binds only pending rows.
    #[tokio::test]
    #[ignore = "requires migrated Postgres"]
    async fn budget_deny_resolves_then_re_overrun_creates_fresh_pending_row() {
        let (db, tenant) = persistence_test_context().await;
        let owner = Keys::generate();
        let owner_bytes = owner.public_key().to_bytes().to_vec();
        db.ensure_user(tenant.community(), &owner_bytes)
            .await
            .expect("ensure owner user");
        db.add_relay_member(
            tenant.community(),
            &owner.public_key().to_hex(),
            "owner",
            None,
        )
        .await
        .expect("add relay owner");

        let token_hash =
            budget_approval_fixture(&db, &tenant, Utc::now() + chrono::Duration::seconds(3600))
                .await;

        let event = approval_command_event(
            &owner,
            KIND_APPROVAL_DENY,
            &token_hash,
            "over budget, denied",
        );
        let result = resolve_budget_approval_command(
            &db,
            &tenant,
            &event,
            &owner_bytes,
            &token_hash,
            buzz_db::budget::BudgetApprovalDecision::Denied,
        )
        .await
        .expect("budget deny through command path");
        assert!(result.accepted);

        let denied = db
            .get_budget_approval_by_stored_hash(tenant.community(), &token_hash)
            .await
            .expect("fetch denied row");
        assert_eq!(denied.status, "denied");
        assert!(denied.denied_at.is_some());
        assert!(denied.granted_at.is_none());
        assert_eq!(denied.note.as_deref(), Some("over budget, denied"));

        // Re-overrun after denial: the production row-write mints a fresh
        // pending row (new token), never resurrects the denied one.
        let fresh_hash = [0x43u8; 32];
        let stored = db
            .create_budget_approval(
                tenant.community(),
                buzz_db::budget::CreateBudgetApprovalParams {
                    subject: BUDGET_AGENT,
                    counter_type: "runs",
                    window_start: Utc::now(),
                    limit_value: 2,
                    budget_event_id: Some("evt-ce"),
                    token_hash: &fresh_hash,
                    expires_at: Utc::now() + chrono::Duration::seconds(3600),
                },
            )
            .await
            .expect("re-overrun after denial");
        assert_eq!(stored, fresh_hash, "fresh overrun mints a fresh token");
        assert_eq!(
            db.get_budget_approval_by_stored_hash(tenant.community(), &token_hash)
                .await
                .expect("fetch old row")
                .status,
            "denied"
        );
        assert_eq!(
            db.get_budget_approval_by_stored_hash(tenant.community(), &fresh_hash)
                .await
                .expect("fetch fresh row")
                .status,
            "pending"
        );
    }

    /// An expired pending row is never resolved as if fresh: the command
    /// path rejects it and the row stays pending (a later overrun
    /// refreshes it instead — see the resolution doc comment).
    #[tokio::test]
    #[ignore = "requires migrated Postgres"]
    async fn expired_pending_budget_approval_is_not_resolved() {
        let (db, tenant) = persistence_test_context().await;
        let owner = Keys::generate();
        let owner_bytes = owner.public_key().to_bytes().to_vec();
        db.ensure_user(tenant.community(), &owner_bytes)
            .await
            .expect("ensure owner user");
        db.add_relay_member(
            tenant.community(),
            &owner.public_key().to_hex(),
            "owner",
            None,
        )
        .await
        .expect("add relay owner");

        let token_hash =
            budget_approval_fixture(&db, &tenant, Utc::now() - chrono::Duration::seconds(60)).await;

        let event = approval_command_event(&owner, KIND_APPROVAL_GRANT, &token_hash, "late grant");
        let err = resolve_budget_approval_command(
            &db,
            &tenant,
            &event,
            &owner_bytes,
            &token_hash,
            buzz_db::budget::BudgetApprovalDecision::Granted,
        )
        .await
        .err()
        .expect("expired pending row must not resolve");
        assert!(
            matches!(err, IngestError::Rejected(ref m) if m.contains("expired")),
            "got: {err:?}"
        );
        assert_eq!(
            db.get_budget_approval_by_stored_hash(tenant.community(), &token_hash)
                .await
                .expect("fetch row")
                .status,
            "pending",
            "expired row stays pending for the refresh-on-overrun path"
        );
    }

    /// Only a community relay owner may resolve a budget approval; a plain
    /// member is rejected and the row stays pending. (The budgeted subject
    /// is excluded too — self-approval would void an owner-imposed cap.)
    #[tokio::test]
    #[ignore = "requires migrated Postgres"]
    async fn non_owner_cannot_resolve_budget_approval() {
        let (db, tenant) = persistence_test_context().await;
        let member = Keys::generate();
        let member_bytes = member.public_key().to_bytes().to_vec();
        db.ensure_user(tenant.community(), &member_bytes)
            .await
            .expect("ensure member user");
        db.add_relay_member(
            tenant.community(),
            &member.public_key().to_hex(),
            "member",
            None,
        )
        .await
        .expect("add relay member");

        let token_hash =
            budget_approval_fixture(&db, &tenant, Utc::now() + chrono::Duration::seconds(3600))
                .await;

        let event =
            approval_command_event(&member, KIND_APPROVAL_GRANT, &token_hash, "self-service");
        let err = resolve_budget_approval_command(
            &db,
            &tenant,
            &event,
            &member_bytes,
            &token_hash,
            buzz_db::budget::BudgetApprovalDecision::Granted,
        )
        .await
        .err()
        .expect("non-owner must be rejected");
        assert!(
            matches!(err, IngestError::Rejected(ref m) if m.contains("only a community owner")),
            "got: {err:?}"
        );
        assert_eq!(
            db.get_budget_approval_by_stored_hash(tenant.community(), &token_hash)
                .await
                .expect("fetch row")
                .status,
            "pending"
        );
    }
}
