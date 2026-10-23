//! Board moderation persistence (D93).
//!
//! Locked and pinned threads, a board's rules, mutes that apply on one board
//! only, and moderators appointed to a board for a term
//! (`migrations/0064_board_moderation.sql`).
//!
//! Every change goes through [`Db::apply_board_action`], which writes the
//! change, its `moderation_actions` audit row, the relay-signed public log
//! entry and the rebuilt board state record in one transaction. The public log
//! can therefore never miss an action that took effect, and the state record
//! never lags the rows it is built from.
//!
//! ## Tenant invariant
//! Every function takes a [`CommunityId`] and touches exactly one community's
//! rows. Callers resolve the board under the requesting tenant first.

use buzz_core::StoredEvent;
use buzz_datastore_tracing::datastore_span;
use chrono::{DateTime, Utc};
use sqlx::Row as _;
use uuid::Uuid;

use crate::error::{DbError, Result};
use crate::replaceable::{ParameterizedReplacePrecondition, ParameterizedReplaceStatus};
use crate::store::replaceable::event_replacement_lock_key;
use crate::{AdmittedTx, CommunityId, Db};

/// Most locked threads a board state record lists, newest first. Older locks
/// still hold: the server enforces them from the table, not from the record.
pub const BOARD_STATE_LOCKED_LIMIT: i64 = 500;

/// Lock and pin state of one thread on a board.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ThreadState {
    /// When the thread was locked, if it is.
    pub locked_at: Option<DateTime<Utc>>,
    /// Who locked it.
    pub locked_by: Option<Vec<u8>>,
    /// When the thread was pinned, if it is.
    pub pinned_at: Option<DateTime<Utc>>,
    /// Who pinned it.
    pub pinned_by: Option<Vec<u8>>,
}

/// One person's standing rows on one board: their mute, a pending request to
/// mute them for longer, and their appointment as a moderator.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BoardPerson {
    /// Board mute end; `None` or past means not muted.
    pub muted_until: Option<DateTime<Utc>>,
    /// Who set the current mute.
    pub muted_by: Option<Vec<u8>>,
    /// The mute's public reason.
    pub mute_reason: Option<String>,
    /// A moderator's requested longer mute end, waiting for a second moderator.
    pub longer_mute_until: Option<DateTime<Utc>>,
    /// Who asked for the longer mute.
    pub longer_mute_by: Option<Vec<u8>>,
    /// When they asked.
    pub longer_mute_asked_at: Option<DateTime<Utc>>,
    /// End of their term as a moderator of this board; `None` or past means not one.
    pub moderator_until: Option<DateTime<Utc>>,
    /// Who appointed them.
    pub appointed_by: Option<Vec<u8>>,
}

/// What a board state record says, read inside the action's transaction.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BoardSnapshot {
    /// The board's rules; empty when it has none.
    pub rules: String,
    /// When the rules were last set.
    pub rules_set_at: Option<DateTime<Utc>>,
    /// Pinned threads whose post still exists, newest pin first: the post, when,
    /// and who pinned it.
    pub pinned: Vec<(Vec<u8>, DateTime<Utc>, Vec<u8>)>,
    /// Locked threads whose post still exists, newest lock first, at most
    /// [`BOARD_STATE_LOCKED_LIMIT`]: the post, when, and who locked it.
    pub locked: Vec<(Vec<u8>, DateTime<Utc>, Vec<u8>)>,
    /// Moderators whose term has not ended, with their term ends, in order of appointment.
    pub moderators: Vec<(Vec<u8>, DateTime<Utc>)>,
}

/// One change a board action makes. Each reports whether it changed anything;
/// an action whose changes all report no change is rolled back unrecorded.
#[derive(Debug, Clone)]
pub enum BoardChange<'a> {
    /// Lock a thread (no change when it already is).
    Lock {
        /// The thread's post id.
        root: &'a [u8],
    },
    /// Unlock a thread.
    Unlock {
        /// The thread's post id.
        root: &'a [u8],
    },
    /// Pin a thread.
    Pin {
        /// The thread's post id.
        root: &'a [u8],
    },
    /// Unpin a thread.
    Unpin {
        /// The thread's post id.
        root: &'a [u8],
    },
    /// Mute a person on this board until `until` (replacing any mute).
    Mute {
        /// The muted person.
        pubkey: &'a [u8],
        /// When the mute ends.
        until: DateTime<Utc>,
        /// The public reason.
        reason: Option<&'a str>,
    },
    /// Record a moderator's request to mute for longer than one moderator may.
    AskLongerMute {
        /// The person to mute.
        pubkey: &'a [u8],
        /// The longer end asked for.
        until: DateTime<Utc>,
    },
    /// Drop a pending longer-mute request (it was confirmed or withdrawn).
    ClearLongerMute {
        /// The person it was about.
        pubkey: &'a [u8],
    },
    /// Lift a board mute early, with any pending longer-mute request.
    Unmute {
        /// The muted person.
        pubkey: &'a [u8],
    },
    /// Set the board's rules (empty clears them).
    SetRules {
        /// The new rules.
        rules: &'a str,
    },
    /// Appoint (or reappoint) a board moderator until `until`.
    Appoint {
        /// The moderator.
        pubkey: &'a [u8],
        /// The end of their term.
        until: DateTime<Utc>,
    },
    /// End a board moderator's term now.
    Dismiss {
        /// The moderator.
        pubkey: &'a [u8],
    },
    /// Remove someone's post or reply (soft delete with thread counters).
    RemovePost {
        /// The removed event.
        event_id: &'a [u8],
        /// Its parent, for the thread counters.
        parent: Option<&'a [u8]>,
        /// Its thread root, for the thread counters.
        root: Option<&'a [u8]>,
    },
}

/// The audit row of a board action. The id and time are chosen by the caller
/// so the signed log entry can name them before the transaction runs.
#[derive(Debug, Clone)]
pub struct BoardAuditRow<'a> {
    /// Audit row id, also carried by the log entry's `action_id` tag.
    pub id: Uuid,
    /// When the action happened; every change and the audit row use it.
    pub at: DateTime<Utc>,
    /// Who acted.
    pub actor_pubkey: &'a [u8],
    /// One of `BOARD_MODERATION_ACTION_VOCAB`, or `delete_message` for a removal.
    pub action: &'a str,
    /// The person acted on, when the action is about a person.
    pub target_pubkey: Option<&'a [u8]>,
    /// The post acted on, when the action is about a post.
    pub target_event_id: Option<&'a [u8]>,
    /// Machine-readable detail (for example a mute waiting for a second moderator).
    pub reason_code: Option<&'a str>,
    /// The public reason.
    pub public_reason: Option<&'a str>,
    /// `community` for owners and admins, `board_moderator` for an appointed moderator.
    pub actor_authority: &'a str,
}

/// What an applied board action stored.
#[derive(Debug, Clone)]
pub struct BoardActionOutcome {
    /// The public log entry.
    pub log: StoredEvent,
    /// The board's rebuilt state record.
    pub state: StoredEvent,
}

/// Transaction-scoped advisory-lock key serializing one board's actions, so
/// each rebuilt state record sees every earlier action on the board.
fn board_lock_key(community: CommunityId, channel_id: Uuid) -> i64 {
    event_replacement_lock_key(
        community,
        buzz_core::kind::KIND_BOARD_STATE as i32,
        b"board-moderation",
        Some(channel_id.as_bytes().as_slice()),
    )
}

async fn apply_change(
    tx: &mut AdmittedTx,
    channel_id: Uuid,
    actor: &[u8],
    at: DateTime<Utc>,
    change: &BoardChange<'_>,
) -> Result<bool> {
    let community = *tx.community().as_uuid();
    let affected = match change {
        BoardChange::Lock { root } => sqlx::query(
            r#"
            INSERT INTO board_thread_state (community_id, channel_id, root_event_id, locked_at, locked_by)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (community_id, channel_id, root_event_id) DO UPDATE
                SET locked_at = EXCLUDED.locked_at, locked_by = EXCLUDED.locked_by
                WHERE board_thread_state.locked_at IS NULL
            "#,
        )
        .bind(community)
        .bind(channel_id)
        .bind(*root)
        .bind(at)
        .bind(actor)
        .execute(tx.conn())
        .await?
        .rows_affected(),
        BoardChange::Unlock { root } => sqlx::query(
            r#"
            UPDATE board_thread_state SET locked_at = NULL, locked_by = NULL
            WHERE community_id = $1 AND channel_id = $2 AND root_event_id = $3
              AND locked_at IS NOT NULL
            "#,
        )
        .bind(community)
        .bind(channel_id)
        .bind(*root)
        .execute(tx.conn())
        .await?
        .rows_affected(),
        BoardChange::Pin { root } => sqlx::query(
            r#"
            INSERT INTO board_thread_state (community_id, channel_id, root_event_id, pinned_at, pinned_by)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (community_id, channel_id, root_event_id) DO UPDATE
                SET pinned_at = EXCLUDED.pinned_at, pinned_by = EXCLUDED.pinned_by
                WHERE board_thread_state.pinned_at IS NULL
            "#,
        )
        .bind(community)
        .bind(channel_id)
        .bind(*root)
        .bind(at)
        .bind(actor)
        .execute(tx.conn())
        .await?
        .rows_affected(),
        BoardChange::Unpin { root } => sqlx::query(
            r#"
            UPDATE board_thread_state SET pinned_at = NULL, pinned_by = NULL
            WHERE community_id = $1 AND channel_id = $2 AND root_event_id = $3
              AND pinned_at IS NOT NULL
            "#,
        )
        .bind(community)
        .bind(channel_id)
        .bind(*root)
        .execute(tx.conn())
        .await?
        .rows_affected(),
        BoardChange::Mute {
            pubkey,
            until,
            reason,
        } => sqlx::query(
            r#"
            INSERT INTO board_people (community_id, channel_id, pubkey, muted_until, muted_by, mute_reason, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (community_id, channel_id, pubkey) DO UPDATE SET
                muted_until = EXCLUDED.muted_until,
                muted_by = EXCLUDED.muted_by,
                mute_reason = EXCLUDED.mute_reason,
                updated_at = EXCLUDED.updated_at
            "#,
        )
        .bind(community)
        .bind(channel_id)
        .bind(*pubkey)
        .bind(until)
        .bind(actor)
        .bind(*reason)
        .bind(at)
        .execute(tx.conn())
        .await?
        .rows_affected(),
        BoardChange::AskLongerMute { pubkey, until } => sqlx::query(
            r#"
            INSERT INTO board_people (community_id, channel_id, pubkey, longer_mute_until, longer_mute_by, longer_mute_asked_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $6)
            ON CONFLICT (community_id, channel_id, pubkey) DO UPDATE SET
                longer_mute_until = EXCLUDED.longer_mute_until,
                longer_mute_by = EXCLUDED.longer_mute_by,
                longer_mute_asked_at = EXCLUDED.longer_mute_asked_at,
                updated_at = EXCLUDED.updated_at
            "#,
        )
        .bind(community)
        .bind(channel_id)
        .bind(*pubkey)
        .bind(until)
        .bind(actor)
        .bind(at)
        .execute(tx.conn())
        .await?
        .rows_affected(),
        BoardChange::ClearLongerMute { pubkey } => sqlx::query(
            r#"
            UPDATE board_people SET longer_mute_until = NULL, longer_mute_by = NULL,
                longer_mute_asked_at = NULL, updated_at = $4
            WHERE community_id = $1 AND channel_id = $2 AND pubkey = $3
              AND longer_mute_until IS NOT NULL
            "#,
        )
        .bind(community)
        .bind(channel_id)
        .bind(*pubkey)
        .bind(at)
        .execute(tx.conn())
        .await?
        .rows_affected(),
        BoardChange::Unmute { pubkey } => sqlx::query(
            r#"
            UPDATE board_people SET muted_until = NULL, muted_by = NULL, mute_reason = NULL,
                longer_mute_until = NULL, longer_mute_by = NULL, longer_mute_asked_at = NULL,
                updated_at = $4
            WHERE community_id = $1 AND channel_id = $2 AND pubkey = $3
              AND (muted_until > $4 OR longer_mute_until IS NOT NULL)
            "#,
        )
        .bind(community)
        .bind(channel_id)
        .bind(*pubkey)
        .bind(at)
        .execute(tx.conn())
        .await?
        .rows_affected(),
        BoardChange::SetRules { rules } => sqlx::query(
            r#"
            INSERT INTO board_settings (community_id, channel_id, rules, rules_set_by, rules_set_at)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (community_id, channel_id) DO UPDATE SET
                rules = EXCLUDED.rules,
                rules_set_by = EXCLUDED.rules_set_by,
                rules_set_at = EXCLUDED.rules_set_at
                WHERE board_settings.rules IS DISTINCT FROM EXCLUDED.rules
            "#,
        )
        .bind(community)
        .bind(channel_id)
        .bind(*rules)
        .bind(actor)
        .bind(at)
        .execute(tx.conn())
        .await?
        .rows_affected(),
        BoardChange::Appoint { pubkey, until } => sqlx::query(
            r#"
            INSERT INTO board_people (community_id, channel_id, pubkey, moderator_until, appointed_by, appointed_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $6)
            ON CONFLICT (community_id, channel_id, pubkey) DO UPDATE SET
                moderator_until = EXCLUDED.moderator_until,
                appointed_by = EXCLUDED.appointed_by,
                appointed_at = EXCLUDED.appointed_at,
                updated_at = EXCLUDED.updated_at
            "#,
        )
        .bind(community)
        .bind(channel_id)
        .bind(*pubkey)
        .bind(until)
        .bind(actor)
        .bind(at)
        .execute(tx.conn())
        .await?
        .rows_affected(),
        BoardChange::Dismiss { pubkey } => sqlx::query(
            r#"
            UPDATE board_people SET moderator_until = NULL, appointed_by = NULL,
                appointed_at = NULL, updated_at = $4
            WHERE community_id = $1 AND channel_id = $2 AND pubkey = $3
              AND moderator_until > $4
            "#,
        )
        .bind(community)
        .bind(channel_id)
        .bind(*pubkey)
        .bind(at)
        .execute(tx.conn())
        .await?
        .rows_affected(),
        BoardChange::RemovePost {
            event_id,
            parent,
            root,
        } => {
            return crate::store::event::soft_delete_event_and_update_thread_in_tx(
                tx, event_id, *parent, *root,
            )
            .await;
        }
    };
    Ok(affected > 0)
}

/// Drop rows that no longer hold anything, so the tables only carry live state.
async fn prune_empty_rows(tx: &mut AdmittedTx, channel_id: Uuid) -> Result<()> {
    let community = *tx.community().as_uuid();
    sqlx::query(
        "DELETE FROM board_thread_state WHERE community_id = $1 AND channel_id = $2 \
         AND locked_at IS NULL AND pinned_at IS NULL",
    )
    .bind(community)
    .bind(channel_id)
    .execute(tx.conn())
    .await?;
    sqlx::query(
        "DELETE FROM board_people WHERE community_id = $1 AND channel_id = $2 \
         AND muted_until IS NULL AND longer_mute_until IS NULL AND moderator_until IS NULL",
    )
    .bind(community)
    .bind(channel_id)
    .execute(tx.conn())
    .await?;
    Ok(())
}

async fn read_snapshot(
    tx: &mut AdmittedTx,
    channel_id: Uuid,
    at: DateTime<Utc>,
) -> Result<BoardSnapshot> {
    let community = *tx.community().as_uuid();
    let settings = sqlx::query(
        "SELECT rules, rules_set_at FROM board_settings WHERE community_id = $1 AND channel_id = $2",
    )
    .bind(community)
    .bind(channel_id)
    .fetch_optional(tx.conn())
    .await?;
    let (rules, rules_set_at) = match settings {
        Some(row) => (row.try_get("rules")?, row.try_get("rules_set_at")?),
        None => (String::new(), None),
    };
    // Only threads whose post still exists: a post deleted by any path (its
    // author, a moderator, retention) drops out of the record without each
    // path having to clear its lock or pin.
    let mut pinned = Vec::new();
    for row in sqlx::query(
        "SELECT s.root_event_id, s.pinned_at AS at, s.pinned_by AS by FROM board_thread_state s \
         WHERE s.community_id = $1 AND s.channel_id = $2 AND s.pinned_at IS NOT NULL \
           AND EXISTS (SELECT 1 FROM events e WHERE e.community_id = s.community_id \
                       AND e.id = s.root_event_id AND e.deleted_at IS NULL) \
         ORDER BY s.pinned_at DESC, s.root_event_id LIMIT $3",
    )
    .bind(community)
    .bind(channel_id)
    .bind(BOARD_STATE_LOCKED_LIMIT)
    .fetch_all(tx.conn())
    .await?
    {
        pinned.push((
            row.try_get("root_event_id")?,
            row.try_get("at")?,
            row.try_get("by")?,
        ));
    }
    let mut locked = Vec::new();
    for row in sqlx::query(
        "SELECT s.root_event_id, s.locked_at AS at, s.locked_by AS by FROM board_thread_state s \
         WHERE s.community_id = $1 AND s.channel_id = $2 AND s.locked_at IS NOT NULL \
           AND EXISTS (SELECT 1 FROM events e WHERE e.community_id = s.community_id \
                       AND e.id = s.root_event_id AND e.deleted_at IS NULL) \
         ORDER BY s.locked_at DESC, s.root_event_id LIMIT $3",
    )
    .bind(community)
    .bind(channel_id)
    .bind(BOARD_STATE_LOCKED_LIMIT)
    .fetch_all(tx.conn())
    .await?
    {
        locked.push((
            row.try_get("root_event_id")?,
            row.try_get("at")?,
            row.try_get("by")?,
        ));
    }
    let mut moderators = Vec::new();
    for row in sqlx::query(
        "SELECT pubkey, moderator_until FROM board_people \
         WHERE community_id = $1 AND channel_id = $2 AND moderator_until > $3 \
         ORDER BY appointed_at, pubkey",
    )
    .bind(community)
    .bind(channel_id)
    .bind(at)
    .fetch_all(tx.conn())
    .await?
    {
        moderators.push((row.try_get("pubkey")?, row.try_get("moderator_until")?));
    }
    Ok(BoardSnapshot {
        rules,
        rules_set_at,
        pinned,
        locked,
        moderators,
    })
}

async fn insert_board_audit(
    tx: &mut AdmittedTx,
    channel_id: Uuid,
    audit: &BoardAuditRow<'_>,
) -> Result<()> {
    let community = *tx.community().as_uuid();
    sqlx::query(
        r#"
        INSERT INTO moderation_actions (
            community_id, id, actor_pubkey, action, target_pubkey, target_event_id,
            channel_id, reason_code, public_reason, actor_authority, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        "#,
    )
    .bind(community)
    .bind(audit.id)
    .bind(audit.actor_pubkey)
    .bind(audit.action)
    .bind(audit.target_pubkey)
    .bind(audit.target_event_id)
    .bind(channel_id)
    .bind(audit.reason_code)
    .bind(audit.public_reason)
    .bind(audit.actor_authority)
    .bind(audit.at)
    .execute(tx.conn())
    .await?;
    Ok(())
}

impl Db {
    /// Apply one board action atomically: its changes, the audit row, the
    /// relay-signed public log entry (`log_event`, `h` = the board) and the
    /// board's rebuilt state record.
    ///
    /// `sign_state` builds the state record from the snapshot read inside the
    /// transaction after the changes, given the smallest `created_at` that
    /// replaces the current record. Actions on one board are serialized.
    ///
    /// Returns `None`, with nothing written, when no change changed anything
    /// (the thread was already locked, the post already removed, …).
    #[datastore_span(name = "apply_board_action", system = "postgresql")]
    pub async fn apply_board_action<F>(
        &self,
        community: CommunityId,
        channel_id: Uuid,
        changes: &[BoardChange<'_>],
        audit: BoardAuditRow<'_>,
        log_event: &nostr::Event,
        sign_state: F,
    ) -> Result<Option<BoardActionOutcome>>
    where
        F: FnOnce(&BoardSnapshot, u64) -> std::result::Result<nostr::Event, String>,
    {
        let mut tx = crate::begin_community_event_write_transaction(
            &self.pool,
            community,
            crate::observability::WriterOperation::EventWrite,
        )
        .await?;
        sqlx::query("SELECT pg_advisory_xact_lock($1)")
            .bind(board_lock_key(community, channel_id))
            .execute(tx.conn())
            .await?;

        let mut changed = false;
        for change in changes {
            changed |=
                apply_change(&mut tx, channel_id, audit.actor_pubkey, audit.at, change).await?;
        }
        if !changed {
            tx.rollback().await?;
            return Ok(None);
        }
        prune_empty_rows(&mut tx, channel_id).await?;
        insert_board_audit(&mut tx, channel_id, &audit).await?;

        let (log, inserted) =
            crate::store::event::insert_event_in_transaction(&mut tx, log_event, Some(channel_id))
                .await?;
        if !inserted {
            return Err(DbError::InvalidData(
                "board moderation log entry already exists".into(),
            ));
        }
        // The person an entry is about finds it by their key (`#p`), which reads
        // the mention index: write it with the entry (D99).
        crate::insert_mentions_in_transaction(&mut tx, log_event, Some(channel_id)).await?;

        let snapshot = read_snapshot(&mut tx, channel_id, audit.at).await?;
        let head: Option<DateTime<Utc>> = sqlx::query_scalar(
            "SELECT max(created_at) FROM events WHERE community_id = $1 AND kind = $2 \
             AND channel_id = $3 AND deleted_at IS NULL",
        )
        .bind(community.as_uuid())
        .bind(buzz_core::kind::KIND_BOARD_STATE as i32)
        .bind(channel_id)
        .fetch_one(tx.conn())
        .await?;
        let min_created_at = head.map_or(0, |ts| ts.timestamp().max(0) as u64 + 1);
        let state_event = sign_state(&snapshot, min_created_at).map_err(DbError::InvalidData)?;
        let channel_d_tag = channel_id.to_string();
        let replaced = self
            .replace_parameterized_event_in_transaction(
                &mut tx,
                &state_event,
                &channel_d_tag,
                Some(channel_id),
                ParameterizedReplacePrecondition::Unconditional,
            )
            .await?;
        if replaced.status != ParameterizedReplaceStatus::Inserted {
            return Err(DbError::InvalidData(format!(
                "board state record was not replaced: {:?}",
                replaced.status
            )));
        }

        tx.commit().await?;
        Ok(Some(BoardActionOutcome {
            log,
            state: replaced.event,
        }))
    }

    /// Lock and pin state of one thread on a board, if any.
    #[datastore_span(name = "board_thread_state", system = "postgresql")]
    pub async fn board_thread_state(
        &self,
        community: CommunityId,
        channel_id: Uuid,
        root: &[u8],
    ) -> Result<Option<ThreadState>> {
        let row = sqlx::query(
            "SELECT locked_at, locked_by, pinned_at, pinned_by FROM board_thread_state \
             WHERE community_id = $1 AND channel_id = $2 AND root_event_id = $3",
        )
        .bind(community.as_uuid())
        .bind(channel_id)
        .bind(root)
        .fetch_optional(&self.pool)
        .await?;
        row.map(|row| {
            Ok(ThreadState {
                locked_at: row.try_get("locked_at")?,
                locked_by: row.try_get("locked_by")?,
                pinned_at: row.try_get("pinned_at")?,
                pinned_by: row.try_get("pinned_by")?,
            })
        })
        .transpose()
    }

    /// One person's standing rows on a board, if any.
    #[datastore_span(name = "board_person", system = "postgresql")]
    pub async fn board_person(
        &self,
        community: CommunityId,
        channel_id: Uuid,
        pubkey: &[u8],
    ) -> Result<Option<BoardPerson>> {
        let row = sqlx::query(
            "SELECT muted_until, muted_by, mute_reason, longer_mute_until, longer_mute_by, \
                    longer_mute_asked_at, moderator_until, appointed_by \
             FROM board_people WHERE community_id = $1 AND channel_id = $2 AND pubkey = $3",
        )
        .bind(community.as_uuid())
        .bind(channel_id)
        .bind(pubkey)
        .fetch_optional(&self.pool)
        .await?;
        row.map(|row| {
            Ok(BoardPerson {
                muted_until: row.try_get("muted_until")?,
                muted_by: row.try_get("muted_by")?,
                mute_reason: row.try_get("mute_reason")?,
                longer_mute_until: row.try_get("longer_mute_until")?,
                longer_mute_by: row.try_get("longer_mute_by")?,
                longer_mute_asked_at: row.try_get("longer_mute_asked_at")?,
                moderator_until: row.try_get("moderator_until")?,
                appointed_by: row.try_get("appointed_by")?,
            })
        })
        .transpose()
    }

    /// When `pubkey`'s board mute ends, if they are muted on this board now.
    ///
    /// An agent is muted by its own row and by its owner's, read now rather
    /// than copied, matching the community restriction in `moderation`.
    #[datastore_span(name = "board_mute_until", system = "postgresql")]
    pub async fn board_mute_until(
        &self,
        community: CommunityId,
        channel_id: Uuid,
        pubkey: &[u8],
    ) -> Result<Option<DateTime<Utc>>> {
        let mut connection = crate::observability::acquire_writer(
            &self.pool,
            crate::observability::WriterOperation::Authorization,
        )
        .await?;
        let until: Option<DateTime<Utc>> = sqlx::query_scalar(
            r#"
            SELECT max(muted_until) FROM board_people
            WHERE community_id = $1 AND channel_id = $2 AND muted_until > now()
              AND pubkey IN (
                  SELECT $3::bytea
                  UNION ALL
                  SELECT agent_owner_pubkey FROM users
                  WHERE community_id = $1 AND pubkey = $3 AND agent_owner_pubkey IS NOT NULL
              )
            "#,
        )
        .bind(community.as_uuid())
        .bind(channel_id)
        .bind(pubkey)
        .fetch_one(&mut *connection)
        .await?;
        Ok(until)
    }

    /// Whether any of `ids` is a locked thread on this board.
    #[datastore_span(name = "board_any_locked", system = "postgresql")]
    pub async fn board_any_locked(
        &self,
        community: CommunityId,
        channel_id: Uuid,
        ids: &[Vec<u8>],
    ) -> Result<bool> {
        if ids.is_empty() {
            return Ok(false);
        }
        let mut connection = crate::observability::acquire_writer(
            &self.pool,
            crate::observability::WriterOperation::Authorization,
        )
        .await?;
        let locked: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM board_thread_state WHERE community_id = $1 \
             AND channel_id = $2 AND root_event_id = ANY($3) AND locked_at IS NOT NULL)",
        )
        .bind(community.as_uuid())
        .bind(channel_id)
        .bind(ids)
        .fetch_one(&mut *connection)
        .await?;
        Ok(locked)
    }

    /// How many threads are pinned on this board, counting only posts that still exist.
    #[datastore_span(name = "board_pinned_count", system = "postgresql")]
    pub async fn board_pinned_count(
        &self,
        community: CommunityId,
        channel_id: Uuid,
    ) -> Result<i64> {
        Ok(sqlx::query_scalar(
            "SELECT count(*) FROM board_thread_state s WHERE s.community_id = $1 \
             AND s.channel_id = $2 AND s.pinned_at IS NOT NULL \
             AND EXISTS (SELECT 1 FROM events e WHERE e.community_id = s.community_id \
                         AND e.id = s.root_event_id AND e.deleted_at IS NULL)",
        )
        .bind(community.as_uuid())
        .bind(channel_id)
        .fetch_one(&self.pool)
        .await?)
    }

    /// How many actions `actor` took on the authority of a board moderator
    /// appointment since `since`, on any board of the community.
    #[datastore_span(name = "board_moderator_actions_since", system = "postgresql")]
    pub async fn board_moderator_actions_since(
        &self,
        community: CommunityId,
        actor: &[u8],
        since: DateTime<Utc>,
    ) -> Result<i64> {
        Ok(sqlx::query_scalar(
            // Closing a report after removing what it was about is the same act,
            // already counted as the removal.
            "SELECT count(*) FROM moderation_actions WHERE community_id = $1 \
             AND actor_pubkey = $2 AND actor_authority = 'board_moderator' AND created_at > $3 \
             AND action <> 'resolve:delete'",
        )
        .bind(community.as_uuid())
        .bind(actor)
        .bind(since)
        .fetch_one(&self.pool)
        .await?)
    }
}
