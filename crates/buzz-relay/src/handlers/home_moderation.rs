//! Removing a Home post: a community owner or admin takes someone's global
//! social post (a kind:1 note or reply, a repost, a poll, …) off Home with a
//! public reason.
//!
//! The request is a kind:9005 with no `h` tag, naming the post in its one `e`
//! tag and the reason in `public_reason` — the board removal's shape without
//! the board. Like the community moderation commands it is run here and never
//! stored. The soft delete, its audit row, the open reports about the post
//! (closed as resolved), and a relay-signed public log entry (kind 45004 with
//! no `h`, naming the author in `p` so their notifications find it) commit in
//! one transaction ([`buzz_db::Db::remove_home_post`]) before anything is
//! acknowledged. The author's and reporters' moderation messages follow on
//! their own task: the log entry is the durable record of both.
//!
//! A kind:9005 that carries an `h` tag never comes here: rooms and boards keep
//! their own path (`side_effects.rs`, `board_moderation.rs`).

use std::sync::Arc;

use buzz_core::kind::{
    event_kind_u32, KIND_BOARD_MODERATION_LOG, KIND_COMMENT, KIND_GENERIC_REPOST, KIND_HIGHLIGHT,
    KIND_LONG_FORM, KIND_NIP29_DELETE_EVENT, KIND_POLL, KIND_REPOST, KIND_TEXT_NOTE,
};
use buzz_core::tenant::TenantContext;
use chrono::{DateTime, Utc};
use nostr::{Event, EventBuilder, Kind, Tag};
use tracing::{info, warn};
use uuid::Uuid;

use super::event::dispatch_persistent_event;
use super::ingest::{IngestAuth, IngestError, IngestResult};
use super::moderation_authz::{
    authorize_moderation_action, ModerationAction, ModerationAuthority, ModerationTarget,
};
use super::moderation_notices::{send_moderation_notice, ModerationNotice};
use crate::state::AppState;

/// The refusal for anyone who is not one of the community's owners or admins.
pub(crate) const NOT_A_MODERATOR: &str =
    "only the community's owners and admins can remove someone's post from Home";

/// The refusal for an admin removing the owner's or a fellow admin's post.
pub(crate) const ADMIN_GUARD_RAIL: &str =
    "an admin cannot remove a post by the community's owner or a fellow admin";

/// Whether `event` asks to remove a Home post: a kind:9005 with no `h` tag.
pub(crate) fn is_home_removal(event: &Event) -> bool {
    event_kind_u32(event) == KIND_NIP29_DELETE_EVENT
        && !event
            .tags
            .iter()
            .any(|tag| tag.as_slice().first().map(String::as_str) == Some("h"))
}

/// The public social kinds Home shows: never channel-scoped, and authored by
/// people (so profiles, contact lists and settings are never removable here).
pub(crate) fn is_home_post_kind(kind: u32) -> bool {
    matches!(
        kind,
        KIND_TEXT_NOTE
            | KIND_REPOST
            | KIND_GENERIC_REPOST
            | KIND_COMMENT
            | KIND_HIGHLIGHT
            | KIND_POLL
            | KIND_LONG_FORM
    )
}

/// The one post the request names: exactly one 32-byte `e` tag, no `a` tag.
fn removal_target(event: &Event) -> Result<Vec<u8>, String> {
    let mut targets = Vec::new();
    for tag in event.tags.iter() {
        let parts = tag.as_slice();
        match parts.first().map(String::as_str) {
            Some("e") => targets.push(parts.get(1).cloned().unwrap_or_default()),
            Some("a") => return Err(invalid("name the post to remove with an e tag")),
            _ => {}
        }
    }
    let [target] = targets.as_slice() else {
        return Err(invalid("name exactly one post to remove"));
    };
    match hex::decode(target) {
        Ok(bytes) if bytes.len() == 32 => Ok(bytes),
        _ => Err(invalid("the post to remove must be a 64-character hex id")),
    }
}

/// For a reply (NIP-10): the thread it is in — the `root`-marked `e` tag, else
/// the first `e` tag. `None` for a post that answers nothing.
fn thread_root(event: &Event) -> Option<String> {
    let e_tags: Vec<&[String]> = event
        .tags
        .iter()
        .map(|tag| tag.as_slice())
        .filter(|parts| parts.len() >= 2 && parts[0] == "e")
        .collect();
    e_tags
        .iter()
        .find(|parts| parts.get(3).map(String::as_str) == Some("root"))
        .or_else(|| e_tags.first())
        .map(|parts| parts[1].to_lowercase())
        .filter(|id| id.len() == 64 && id.chars().all(|c| c.is_ascii_hexdigit()))
}

/// The guard rail on top of community authority: an owner removes anyone's
/// post; an admin removes anyone's but the owner's or a fellow admin's (their
/// own included, which is no one else's). Pure, so it is table-tested.
pub(crate) fn may_remove_post_by(
    authority: ModerationAuthority,
    author_role: Option<&str>,
    own_post: bool,
) -> Result<(), &'static str> {
    match authority {
        ModerationAuthority::CommunityOwner => Ok(()),
        ModerationAuthority::CommunityAdmin
            if own_post || !matches!(author_role, Some("owner" | "admin")) =>
        {
            Ok(())
        }
        ModerationAuthority::CommunityAdmin => Err(ADMIN_GUARD_RAIL),
        ModerationAuthority::ChannelRole => Err(NOT_A_MODERATOR),
    }
}

/// Remove the Home post a kind:9005 without an `h` tag names, or refuse with a
/// plain reason. Accepted only once the removal, its audit row, the closed
/// reports and the public log entry are committed.
pub(crate) async fn remove_home_post(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    event: &Event,
    auth: &IngestAuth,
) -> Result<IngestResult, IngestError> {
    let event_id = event.id.to_hex();
    if auth.channel_ids().is_some() {
        return Err(IngestError::AuthFailed(
            "restricted: channel-scoped tokens cannot publish global events".into(),
        ));
    }
    let target_id = removal_target(event).map_err(IngestError::Rejected)?;
    let actor = event.pubkey.to_bytes().to_vec();
    let community = tenant.community();

    // Who may, before anything about the post is said.
    let authority = authorize_moderation_action(
        tenant,
        state,
        &actor,
        None,
        ModerationTarget::Event(&target_id),
        ModerationAction::DeleteMessage,
    )
    .await
    .map_err(|e| match e.downcast_ref::<buzz_db::DbError>() {
        Some(db) => IngestError::Internal(format!("error: database error checking roles: {db}")),
        None => IngestError::Rejected(restricted(NOT_A_MODERATOR)),
    })?;

    let target = state
        .db
        .get_event_by_id_including_deleted_for_event_write(community, &target_id)
        .await
        .map_err(|e| IngestError::Internal(format!("error: database error: {e}")))?
        .ok_or_else(|| IngestError::Rejected(invalid("that post was not found")))?;
    if target.channel_id.is_some() {
        return Err(IngestError::Rejected(invalid(
            "this message is in a room or board; remove it there",
        )));
    }
    let target_kind = event_kind_u32(&target.event);
    if !is_home_post_kind(target_kind) {
        return Err(IngestError::Rejected(invalid(
            "only posts and replies on Home can be removed this way",
        )));
    }

    let author =
        super::ingest::effective_message_author(&target.event, &state.relay_keypair.public_key());
    let author_role = if authority == ModerationAuthority::CommunityAdmin && author != actor {
        state
            .db
            .get_relay_member(community, &hex::encode(&author))
            .await
            .map_err(|e| IngestError::Internal(format!("error: database error: {e}")))?
            .map(|member| member.role)
    } else {
        None
    };
    may_remove_post_by(authority, author_role.as_deref(), author == actor)
        .map_err(|reason| IngestError::Rejected(restricted(reason)))?;

    let reason = tag_value(event, "public_reason")
        .map(|r| super::board_moderation::clip_reason(&r))
        .filter(|r| !r.is_empty());
    let now = Utc::now();
    let action_id = Uuid::new_v4();
    let root = (target_kind == KIND_TEXT_NOTE)
        .then(|| thread_root(&target.event))
        .flatten();
    let log = log_event(
        state,
        &LogEntry {
            actor: &actor,
            role: match authority {
                ModerationAuthority::CommunityOwner => "community_owner",
                _ => "community_admin",
            },
            action_id,
            target: &target_id,
            thread: root.as_deref(),
            author: &author,
            reason: reason.as_deref().unwrap_or(""),
            at: now,
        },
    )
    .map_err(|e| IngestError::Internal(format!("error: {e}")))?;

    let removed = state
        .db
        .remove_home_post(
            community,
            buzz_db::home_moderation::HomeRemoval {
                action_id,
                at: now,
                actor_pubkey: &actor,
                author_pubkey: &author,
                event_id: &target_id,
                public_reason: reason.as_deref(),
                log_event: &log,
            },
        )
        .await
        .map_err(|e| match e {
            buzz_db::DbError::InvalidData(message) => IngestError::Rejected(invalid(message)),
            other => IngestError::Internal(format!("error: Home removal failed: {other}")),
        })?;
    let Some(outcome) = removed else {
        // Already gone (removed before, or deleted by its author): nothing to do.
        return Ok(IngestResult {
            event_id,
            accepted: true,
            message: "duplicate: this post was already removed".into(),
        });
    };

    let relay_hex = state.relay_keypair.public_key().to_hex();
    dispatch_persistent_event(
        tenant,
        state,
        &outcome.log,
        KIND_BOARD_MODERATION_LOG,
        &relay_hex,
        None,
    )
    .await;
    crate::audit::record_audit(
        state,
        crate::audit::AuditRecord::new(crate::audit::AuditSite::EventDeleted, tenant)
            .actor(Some(actor.clone()))
            .object_id(hex::encode(&target_id))
            .detail(serde_json::json!({
                "event_id": event_id,
                "channel_id": null,
                "moderation": true,
                "home": true,
            })),
    )
    .await;

    let author_notice = ModerationNotice::HomeRemoval {
        action_id,
        what: if root.is_some() { "reply" } else { "post" },
        excerpt: super::board_moderation::removed_excerpt(&target.event.content),
        public_reason: reason.unwrap_or_default(),
    };
    // Its own task: the removal is committed and in the public log, which is
    // what the author's notifications read; these messages are courtesy copies
    // and their writes would otherwise run at the bottom of the ingest stack.
    let (tenant, state) = (tenant.clone(), Arc::clone(state));
    let closed = outcome.closed_reports;
    tokio::spawn(async move {
        if let Err(e) = send_moderation_notice(&tenant, &state, &author, author_notice, now).await {
            info!(error = %e, "Home removal notice delivery failed (removal still applied)");
        }
        for report in closed {
            let notice = ModerationNotice::ReportResolved {
                report_id: report.id,
                status: "resolved".into(),
                summary: "A moderator removed the post you reported.".into(),
            };
            if let Err(e) =
                send_moderation_notice(&tenant, &state, &report.reporter_pubkey, notice, now).await
            {
                warn!(error = %e, report_id = %report.id, "reporter notice delivery failed");
            }
        }
    });

    info!(target_event = %hex::encode(&target_id), "Home post removed by a moderator");
    Ok(IngestResult {
        event_id,
        accepted: true,
        message: String::new(),
    })
}

struct LogEntry<'a> {
    actor: &'a [u8],
    role: &'a str,
    action_id: Uuid,
    target: &'a [u8],
    /// For a removed reply: the thread it was in.
    thread: Option<&'a str>,
    author: &'a [u8],
    reason: &'a str,
    at: DateTime<Utc>,
}

/// The relay-signed public log entry for a Home removal: the board log's shape
/// (kind 45004) without an `h` tag, so it is a community-wide record anyone
/// who can read Home can read, and the author finds it by `#p`.
fn log_event(state: &AppState, entry: &LogEntry<'_>) -> Result<Event, String> {
    let tag = |parts: &[&str]| {
        Tag::parse(parts.to_vec()).map_err(|e| format!("failed to build log tag: {e}"))
    };
    let mut tags = vec![
        tag(&["action", "remove"])?,
        tag(&["actor", &hex::encode(entry.actor)])?,
        tag(&["role", entry.role])?,
        tag(&["action_id", &entry.action_id.to_string()])?,
        tag(&["e", &hex::encode(entry.target)])?,
    ];
    if let Some(root) = entry.thread {
        tags.push(tag(&["thread", root])?);
    }
    tags.push(tag(&["p", &hex::encode(entry.author)])?);
    EventBuilder::new(Kind::Custom(KIND_BOARD_MODERATION_LOG as u16), entry.reason)
        .tags(tags)
        .custom_created_at(nostr::Timestamp::from(entry.at.timestamp().max(0) as u64))
        .sign_with_keys(&state.relay_keypair)
        .map_err(|e| format!("failed to sign Home moderation log entry: {e}"))
}

fn tag_value(event: &Event, name: &str) -> Option<String> {
    event.tags.iter().find_map(|tag| {
        let parts = tag.as_slice();
        (parts.len() >= 2 && parts[0] == name).then(|| parts[1].clone())
    })
}

fn invalid(message: impl std::fmt::Display) -> String {
    format!("invalid: {message}")
}

fn restricted(message: impl std::fmt::Display) -> String {
    format!("restricted: {message}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::Keys;

    fn signed(kind: u32, tags: &[&[&str]]) -> Event {
        let tags: Vec<Tag> = tags
            .iter()
            .map(|parts| Tag::parse(parts.to_vec()).expect("tag"))
            .collect();
        EventBuilder::new(Kind::Custom(kind as u16), "")
            .tags(tags)
            .sign_with_keys(&Keys::generate())
            .expect("sign")
    }

    const ID: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const ROOT: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    #[test]
    fn only_a_deletion_without_a_room_is_a_home_removal() {
        assert!(is_home_removal(&signed(
            KIND_NIP29_DELETE_EVENT,
            &[&["e", ID]]
        )));
        assert!(!is_home_removal(&signed(
            KIND_NIP29_DELETE_EVENT,
            &[&["h", "7d4c7b1e-0000-4000-8000-000000000000"], &["e", ID]]
        )));
        assert!(!is_home_removal(&signed(5, &[&["e", ID]])));
    }

    #[test]
    fn the_target_is_exactly_one_hex_event_id() {
        let ok = signed(KIND_NIP29_DELETE_EVENT, &[&["e", ID]]);
        assert_eq!(removal_target(&ok).expect("target"), vec![0xaa; 32]);
        for tags in [
            vec![],
            vec![["e", ID], ["e", ROOT]],
            vec![["e", "not-hex"], ["x", "y"]],
            vec![["e", ID], ["a", "1:ab:c"]],
        ] {
            let tags: Vec<&[&str]> = tags.iter().map(|t| t.as_slice()).collect();
            assert!(removal_target(&signed(KIND_NIP29_DELETE_EVENT, &tags)).is_err());
        }
    }

    #[test]
    fn home_posts_are_the_public_social_kinds_only() {
        for kind in [1, 6, 16, 1111, 1068, 9802, 30023] {
            assert!(is_home_post_kind(kind), "{kind}");
        }
        // Profiles, contact lists, board posts and room messages are not.
        for kind in [0, 3, 9, 11, 1984, 10000, 45004] {
            assert!(!is_home_post_kind(kind), "{kind}");
        }
    }

    #[test]
    fn a_reply_names_its_thread_and_a_post_does_not() {
        let marked = signed(1, &[&["e", ROOT, "", "root"], &["e", ID, "", "reply"]]);
        assert_eq!(thread_root(&marked).as_deref(), Some(ROOT));
        let positional = signed(1, &[&["e", ROOT], &["e", ID]]);
        assert_eq!(thread_root(&positional).as_deref(), Some(ROOT));
        assert_eq!(thread_root(&signed(1, &[&["p", ID]])), None);
    }

    #[test]
    fn the_admin_guard_rail_spares_owners_and_fellow_admins() {
        use ModerationAuthority::*;
        assert_eq!(
            may_remove_post_by(CommunityOwner, Some("admin"), false),
            Ok(())
        );
        assert_eq!(
            may_remove_post_by(CommunityOwner, Some("owner"), true),
            Ok(())
        );
        assert_eq!(
            may_remove_post_by(CommunityAdmin, Some("member"), false),
            Ok(())
        );
        assert_eq!(may_remove_post_by(CommunityAdmin, None, false), Ok(()));
        assert_eq!(
            may_remove_post_by(CommunityAdmin, Some("admin"), true),
            Ok(())
        );
        assert_eq!(
            may_remove_post_by(CommunityAdmin, Some("admin"), false),
            Err(ADMIN_GUARD_RAIL)
        );
        assert_eq!(
            may_remove_post_by(CommunityAdmin, Some("owner"), false),
            Err(ADMIN_GUARD_RAIL)
        );
        assert_eq!(
            may_remove_post_by(ChannelRole, None, false),
            Err(NOT_A_MODERATOR)
        );
    }
}
