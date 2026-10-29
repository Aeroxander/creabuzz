//! Removing a Home post (a global social note) as a community moderator.
//!
//! Home posts belong to no channel, so they have no board log or room note.
//! [`Db::remove_home_post`] writes everything a removal is in one transaction:
//! the soft delete, its `moderation_actions` audit row, the open reports about
//! the post closed against that row, and the relay-signed public log entry
//! (kind 45004, no `h` tag) with its `#p` mention row, so the author finds it
//! by their key. Nothing is acknowledged unless all of it committed.
//!
//! ## Tenant invariant
//! Every statement is fenced to the transaction's community. Callers resolve
//! the post under the requesting tenant first.

use buzz_core::StoredEvent;
use buzz_datastore_tracing::datastore_span;
use chrono::{DateTime, Utc};
use sqlx::Row as _;
use uuid::Uuid;

use crate::error::{DbError, Result};
use crate::{CommunityId, Db};

/// One moderator's removal of a Home post, resolved by the caller.
#[derive(Debug, Clone)]
pub struct HomeRemoval<'a> {
    /// Audit row id, also carried by the log entry's `action_id` tag.
    pub action_id: Uuid,
    /// When it happened; the audit row and the closed reports use it.
    pub at: DateTime<Utc>,
    /// Who removed it (a community owner or admin).
    pub actor_pubkey: &'a [u8],
    /// Who wrote it.
    pub author_pubkey: &'a [u8],
    /// The removed post or reply.
    pub event_id: &'a [u8],
    /// The moderator's public reason, if any.
    pub public_reason: Option<&'a str>,
    /// The relay-signed public log entry (kind 45004, `p` = the author).
    pub log_event: &'a nostr::Event,
}

/// A report about the removed post that the removal closed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClosedReport {
    /// The report row.
    pub id: Uuid,
    /// Who sent it, to tell them it was acted on (never shown to the author).
    pub reporter_pubkey: Vec<u8>,
}

/// What a committed Home removal stored.
#[derive(Debug, Clone)]
pub struct HomeRemovalOutcome {
    /// The public log entry, as stored.
    pub log: StoredEvent,
    /// The open reports about the post, now resolved.
    pub closed_reports: Vec<ClosedReport>,
}

impl Db {
    /// Remove a Home post atomically: soft delete, audit row, open reports
    /// closed against it, and the public log entry with its `#p` index row.
    ///
    /// Returns `None`, with nothing written, when the post was already gone.
    /// Refuses a post that belongs to a channel: those are removed in their
    /// room or board, with that path's notes and log.
    #[datastore_span(name = "remove_home_post", system = "postgresql")]
    pub async fn remove_home_post(
        &self,
        community: CommunityId,
        removal: HomeRemoval<'_>,
    ) -> Result<Option<HomeRemovalOutcome>> {
        let mut tx = crate::begin_community_event_write_transaction(
            &self.pool,
            community,
            crate::observability::WriterOperation::EventWrite,
        )
        .await?;

        let channel: Option<Option<Uuid>> =
            sqlx::query_scalar("SELECT channel_id FROM events WHERE community_id = $1 AND id = $2")
                .bind(community.as_uuid())
                .bind(removal.event_id)
                .fetch_optional(tx.conn())
                .await?;
        if matches!(channel, Some(Some(_))) {
            return Err(DbError::InvalidData(
                "this post is in a room or board; remove it there".into(),
            ));
        }

        // Global notes carry no thread counters to count down.
        let deleted = crate::store::event::soft_delete_event_and_update_thread_in_tx(
            &mut tx,
            removal.event_id,
            None,
            None,
        )
        .await?;
        if !deleted {
            tx.rollback().await?;
            return Ok(None);
        }

        sqlx::query(
            r#"
            INSERT INTO moderation_actions (
                community_id, id, actor_pubkey, action, target_pubkey, target_event_id,
                channel_id, public_reason, actor_authority, created_at
            ) VALUES ($1, $2, $3, 'delete_message', $4, $5, NULL, $6, 'community', $7)
            "#,
        )
        .bind(community.as_uuid())
        .bind(removal.action_id)
        .bind(removal.actor_pubkey)
        .bind(removal.author_pubkey)
        .bind(removal.event_id)
        .bind(removal.public_reason)
        .bind(removal.at)
        .execute(tx.conn())
        .await?;

        // Only reports still waiting for a moderator: one an operator claimed
        // (`processing`) or that was handed on (`escalated`) stays with them.
        let closed = sqlx::query(
            r#"
            UPDATE moderation_reports
            SET status = 'resolved', resolved_by = $3, resolved_at = $4,
                action_id = $5, active_action_id = NULL
            WHERE community_id = $1 AND target_kind = 'event'
              AND target_event_id = $2 AND status = 'open'
            RETURNING id, reporter_pubkey
            "#,
        )
        .bind(community.as_uuid())
        .bind(removal.event_id)
        .bind(removal.actor_pubkey)
        .bind(removal.at)
        .bind(removal.action_id)
        .fetch_all(tx.conn())
        .await?
        .into_iter()
        .map(|row| {
            Ok(ClosedReport {
                id: row.try_get("id")?,
                reporter_pubkey: row.try_get("reporter_pubkey")?,
            })
        })
        .collect::<Result<Vec<_>>>()?;

        let (log, inserted) =
            crate::store::event::insert_event_in_transaction(&mut tx, removal.log_event, None)
                .await?;
        if !inserted {
            return Err(DbError::InvalidData(
                "Home moderation log entry already exists".into(),
            ));
        }
        // The author finds the entry by their key (`#p`), which reads the
        // mention index: write it with the entry, as the board log does (D99).
        crate::insert_mentions_in_transaction(&mut tx, removal.log_event, None).await?;

        tx.commit().await?;
        Ok(Some(HomeRemovalOutcome {
            log,
            closed_reports: closed,
        }))
    }
}
