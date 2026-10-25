//! Board moderation (D93): locked and pinned threads, a board's rules, mutes
//! that apply on one board only, and moderators the board's owners and admins
//! appoint for a term — with every action in the board's public log.
//!
//! Commands are kinds 9045–9053 (`buzz_core::kind`), signed by the actor,
//! validated and run here, never stored. Who may do what is decided in
//! [`crate::handlers::moderation_authz`] (one standing per person per board);
//! this module does the reads, applies the guard rails of
//! `docs/v3-review/BOARD-MODERATION-DESIGN-2026-10-22.md` §3, and hands the
//! change, its audit row, the public log entry (kind 45004) and the rebuilt
//! board state record (kind 39008) to the database in one transaction.
//!
//! The same module enforces the results on ordinary writes: a muted person
//! cannot post, reply, vote or react on that board, and nobody below moderator
//! can reply in a locked thread.

use buzz_core::StoredEvent;
use std::sync::Arc;

use buzz_core::kind::{
    event_kind_u32, KIND_BOARD_APPOINT_MODERATOR, KIND_BOARD_LOCK_THREAD,
    KIND_BOARD_MODERATION_LOG, KIND_BOARD_MUTE, KIND_BOARD_PIN_THREAD, KIND_BOARD_REMOVE_MODERATOR,
    KIND_BOARD_SET_RULES, KIND_BOARD_STATE, KIND_BOARD_UNLOCK_THREAD, KIND_BOARD_UNMUTE,
    KIND_BOARD_UNPIN_THREAD, KIND_FORUM_COMMENT, KIND_FORUM_POST, KIND_FORUM_VOTE, KIND_REACTION,
};
use buzz_core::tenant::TenantContext;
use buzz_db::board_moderation::{BoardAuditRow, BoardChange, BoardSnapshot};
use buzz_db::channel::ChannelRecord;
use chrono::{DateTime, Duration, TimeZone, Utc};
use nostr::{Event, EventBuilder, Kind, Tag};
use tracing::info;
use uuid::Uuid;

use super::event::dispatch_persistent_event;
use super::moderation_authz::{
    board_capability_allowed, board_may_act_against, board_may_undo, board_standing,
    BoardCapability, BoardStanding,
};
use super::moderation_notices::{send_moderation_notice, ModerationNotice};
use crate::state::AppState;

/// The longest board mute one moderator may set alone; longer needs a second
/// moderator to confirm it within [`SECOND_MODERATOR_WINDOW_HOURS`].
pub const MODERATOR_MUTE_DAYS: i64 = 7;
/// The longest board mute anyone may set. Longer belongs to the community's
/// own timeout or ban.
pub const BOARD_MUTE_MAX_DAYS: i64 = 30;
/// How long a moderator's request for a longer mute waits for a second moderator.
pub const SECOND_MODERATOR_WINDOW_HOURS: i64 = 24;
/// The longest (and default) term of an appointed moderator.
pub const MODERATOR_TERM_DAYS: i64 = 90;
/// How many actions an appointed moderator may take in an hour (enforced where
/// each action is written; the checks here only refuse early).
pub use buzz_db::board_moderation::BOARD_MODERATOR_ACTIONS_PER_HOUR as MODERATOR_ACTIONS_PER_HOUR;
/// How many threads may be pinned on a board at once (likewise).
pub use buzz_db::board_moderation::BOARD_PIN_LIMIT;
/// The longest rules text, in characters.
pub const BOARD_RULES_MAX_CHARS: usize = 4000;
/// The longest public reason, in characters; longer is cut.
pub const PUBLIC_REASON_MAX_CHARS: usize = 280;

/// Max clock skew for a freshly-signed command, as for kinds 9040–9044: the
/// commands are never stored, so a tight window is the replay mitigation.
const MAX_COMMAND_SKEW_SECS: i64 = 120;

/// What a board command asks for, parsed and checked for shape.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Command {
    Lock(Vec<u8>),
    Unlock(Vec<u8>),
    Pin(Vec<u8>),
    Unpin(Vec<u8>),
    Mute {
        target: Vec<u8>,
        until: DateTime<Utc>,
    },
    Unmute(Vec<u8>),
    SetRules(String),
    Appoint {
        target: Vec<u8>,
        until: Option<DateTime<Utc>>,
    },
    Dismiss(Vec<u8>),
}

impl Command {
    fn parse(event: &Event) -> Result<Self, String> {
        let kind = event_kind_u32(event);
        let post = || hex_tag(event, "e").ok_or_else(|| invalid("missing or invalid e tag"));
        let person = || hex_tag(event, "p").ok_or_else(|| invalid("missing or invalid p tag"));
        Ok(match kind {
            KIND_BOARD_LOCK_THREAD => Self::Lock(post()?),
            KIND_BOARD_UNLOCK_THREAD => Self::Unlock(post()?),
            KIND_BOARD_PIN_THREAD => Self::Pin(post()?),
            KIND_BOARD_UNPIN_THREAD => Self::Unpin(post()?),
            KIND_BOARD_MUTE => Self::Mute {
                target: person()?,
                until: expiration(event)?
                    .ok_or_else(|| invalid("a board mute needs an expiration tag"))?,
            },
            KIND_BOARD_UNMUTE => Self::Unmute(person()?),
            KIND_BOARD_SET_RULES => {
                let rules = event.content.trim().to_string();
                if rules.chars().count() > BOARD_RULES_MAX_CHARS {
                    return Err(invalid(format!(
                        "board rules may be at most {BOARD_RULES_MAX_CHARS} characters"
                    )));
                }
                Self::SetRules(rules)
            }
            KIND_BOARD_APPOINT_MODERATOR => Self::Appoint {
                target: person()?,
                until: expiration(event)?,
            },
            KIND_BOARD_REMOVE_MODERATOR => Self::Dismiss(person()?),
            other => return Err(invalid(format!("unexpected board command kind: {other}"))),
        })
    }

    /// What the actor needs. A moderator may end their own appointment.
    fn capability(&self, actor: &[u8]) -> Option<BoardCapability> {
        match self {
            Self::SetRules(_) | Self::Appoint { .. } => Some(BoardCapability::Manage),
            Self::Dismiss(target) if target == actor => None,
            Self::Dismiss(_) => Some(BoardCapability::Manage),
            _ => Some(BoardCapability::Moderate),
        }
    }
}

/// One accepted command, ready for the database: the changes, the audit row's
/// fields, and what the public log entry and the reply say.
struct Plan<'a> {
    changes: Vec<BoardChange<'a>>,
    audit_action: &'static str,
    log_action: &'static str,
    target_event: Option<&'a [u8]>,
    target_pubkey: Option<&'a [u8]>,
    until: Option<DateTime<Utc>>,
    /// For a longer mute waiting for a second moderator: the end asked for.
    asked_until: Option<DateTime<Utc>>,
    reason_code: Option<&'static str>,
    message: String,
}

/// Validate and run a board command. `channel` is the board the `h` tag names,
/// already loaded under the tenant (`None` when it does not exist).
///
/// Returns the message for `OK true`, or a client-safe reason for `OK false`.
pub async fn handle_board_command(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    event: &Event,
    channel: Option<&ChannelRecord>,
) -> Result<String, String> {
    let now = Utc::now();
    let skew = event.created_at.as_secs() as i64 - now.timestamp();
    if skew.abs() > MAX_COMMAND_SKEW_SECS {
        return Err(invalid(format!(
            "event timestamp out of range ({skew}s; max ±{MAX_COMMAND_SKEW_SECS}s)"
        )));
    }
    let channel = channel.ok_or_else(|| invalid("board not found"))?;
    if channel.channel_type != "forum" {
        return Err(invalid("board moderation applies to boards only"));
    }
    if channel.archived_at.is_some() || channel.deleted_at.is_some() {
        return Err(invalid("this board is archived"));
    }
    let board = channel.id;
    let command = Command::parse(event)?;
    let actor = event.pubkey.to_bytes().to_vec();
    let community = tenant.community();

    let standing_of = |pubkey: Vec<u8>| async move {
        board_standing(tenant, state, board, &pubkey, now)
            .await
            .map_err(|e| error(format!("database error reading roles: {e}")))
    };
    let actor_standing = standing_of(actor.clone()).await?;
    if let Some(capability) = command.capability(&actor) {
        if !board_capability_allowed(actor_standing, capability) {
            return Err(restricted(match capability {
                BoardCapability::Moderate => {
                    "only this board's moderators, owners and admins can do that"
                }
                BoardCapability::Manage => "only this board's owners and admins can do that",
            }));
        }
    }
    if let Some(until) = state
        .db
        .board_mute_until(community, board, &actor)
        .await
        .map_err(db_error)?
    {
        return Err(restricted(format!(
            "you are muted on this board until {}",
            until.timestamp()
        )));
    }
    if actor_standing == BoardStanding::Moderator {
        let recent = state
            .db
            .board_moderator_actions_since(community, &actor, now - Duration::hours(1))
            .await
            .map_err(db_error)?;
        if recent >= MODERATOR_ACTIONS_PER_HOUR {
            return Err(rate_limited());
        }
    }

    let reason = public_reason(event, &command);
    let plan = match &command {
        Command::Lock(root) | Command::Pin(root) => {
            let post = state
                .db
                .get_event_by_id_for_event_write(community, root)
                .await
                .map_err(db_error)?
                .filter(|post| {
                    post.channel_id == Some(board) && event_kind_u32(&post.event) == KIND_FORUM_POST
                })
                .ok_or_else(|| invalid("that post is not on this board"))?;
            let thread = state
                .db
                .board_thread_state(community, board, root)
                .await
                .map_err(db_error)?
                .unwrap_or_default();
            if matches!(command, Command::Lock(_)) {
                if thread.locked_at.is_some() {
                    return Err(invalid("this thread is already locked"));
                }
                let author = post.event.pubkey.to_bytes().to_vec();
                if author != actor
                    && !board_may_act_against(actor_standing, standing_of(author).await?)
                {
                    return Err(restricted(
                        "you cannot lock a thread started by someone with the same or higher standing",
                    ));
                }
                Plan::thread(
                    BoardChange::Lock { root },
                    "board_lock",
                    "lock",
                    root,
                    "Thread locked.",
                )
            } else {
                if thread.pinned_at.is_some() {
                    return Err(invalid("this thread is already pinned"));
                }
                let pinned = state
                    .db
                    .board_pinned_count(community, board)
                    .await
                    .map_err(db_error)?;
                if pinned >= BOARD_PIN_LIMIT {
                    return Err(pin_limit());
                }
                Plan::thread(
                    BoardChange::Pin { root },
                    "board_pin",
                    "pin",
                    root,
                    "Thread pinned.",
                )
            }
        }
        Command::Unlock(root) | Command::Unpin(root) => {
            let thread = state
                .db
                .board_thread_state(community, board, root)
                .await
                .map_err(db_error)?
                .unwrap_or_default();
            let unlock = matches!(command, Command::Unlock(_));
            let placed_by = if unlock {
                thread.locked_by
            } else {
                thread.pinned_by
            };
            let placed_by = placed_by.ok_or_else(|| {
                invalid(if unlock {
                    "this thread is not locked"
                } else {
                    "this thread is not pinned"
                })
            })?;
            if !board_may_undo(actor_standing, standing_of(placed_by).await?) {
                return Err(restricted(
                    "someone with higher standing did that; only they or someone above can undo it",
                ));
            }
            if unlock {
                Plan::thread(
                    BoardChange::Unlock { root },
                    "board_unlock",
                    "unlock",
                    root,
                    "Thread unlocked.",
                )
            } else {
                Plan::thread(
                    BoardChange::Unpin { root },
                    "board_unpin",
                    "unpin",
                    root,
                    "Thread unpinned.",
                )
            }
        }
        Command::Mute { target, until } => {
            if target == &actor {
                return Err(invalid("you cannot mute yourself"));
            }
            if *until <= now {
                return Err(invalid("a mute must end in the future"));
            }
            if *until > now + Duration::days(BOARD_MUTE_MAX_DAYS) {
                return Err(invalid(format!(
                    "a board mute lasts at most {BOARD_MUTE_MAX_DAYS} days; use a community timeout or ban for longer"
                )));
            }
            if !board_may_act_against(actor_standing, standing_of(target.clone()).await?) {
                return Err(restricted(
                    "you cannot mute someone with the same or higher standing on this board",
                ));
            }
            let person = state
                .db
                .board_person(community, board, target)
                .await
                .map_err(db_error)?
                .unwrap_or_default();
            if let (Some(current), Some(by)) = (person.muted_until, person.muted_by.clone()) {
                if current > now
                    && *until < current
                    && !board_may_undo(actor_standing, standing_of(by).await?)
                {
                    return Err(restricted(
                        "a longer mute set by someone with higher standing is in place",
                    ));
                }
            }
            let alone = now + Duration::days(MODERATOR_MUTE_DAYS);
            if actor_standing > BoardStanding::Moderator || *until <= alone {
                Plan::mute(
                    vec![
                        BoardChange::Mute {
                            pubkey: target,
                            until: *until,
                            reason: reason.as_deref(),
                        },
                        BoardChange::ClearLongerMute { pubkey: target },
                    ],
                    target,
                    *until,
                    None,
                    format!("Muted on this board until {}.", until.timestamp()),
                )
            } else {
                // Longer than one moderator may set alone: a second moderator's
                // request, within the window, confirms it for the shorter of the two.
                let mut confirming = None;
                if let (Some(first), Some(asked_until), Some(asked_at)) = (
                    person.longer_mute_by.clone(),
                    person.longer_mute_until,
                    person.longer_mute_asked_at,
                ) {
                    if first != actor
                        && asked_at > now - Duration::hours(SECOND_MODERATOR_WINDOW_HOURS)
                        && standing_of(first).await? >= BoardStanding::Moderator
                    {
                        confirming = Some((*until).min(asked_until));
                    }
                }
                match confirming {
                    Some(agreed) => Plan::mute(
                        vec![
                            BoardChange::Mute {
                                pubkey: target,
                                until: agreed,
                                reason: reason.as_deref(),
                            },
                            BoardChange::ClearLongerMute { pubkey: target },
                        ],
                        target,
                        agreed,
                        Some("confirmed_by_second_moderator"),
                        format!(
                            "Muted on this board until {}, confirmed by a second moderator.",
                            agreed.timestamp()
                        ),
                    ),
                    None => {
                        let first = alone.max(person.muted_until.unwrap_or(alone));
                        let mut plan = Plan::mute(
                            vec![
                                BoardChange::Mute { pubkey: target, until: first, reason: reason.as_deref() },
                                BoardChange::AskLongerMute { pubkey: target, until: *until },
                            ],
                            target,
                            first,
                            Some("awaiting_second_moderator"),
                            format!(
                                "Muted on this board until {}. A second moderator can extend it to {} within {SECOND_MODERATOR_WINDOW_HOURS} hours.",
                                first.timestamp(),
                                until.timestamp()
                            ),
                        );
                        // The log says how long was asked for, so another moderator can confirm it.
                        plan.asked_until = Some(*until);
                        plan
                    }
                }
            }
        }
        Command::Unmute(target) => {
            if target == &actor {
                return Err(restricted("you cannot lift your own mute"));
            }
            let person = state
                .db
                .board_person(community, board, target)
                .await
                .map_err(db_error)?
                .unwrap_or_default();
            let active = person.muted_until.is_some_and(|until| until > now);
            if !active && person.longer_mute_until.is_none() {
                return Err(invalid("that person is not muted on this board"));
            }
            if let Some(by) = person.muted_by.filter(|_| active) {
                if !board_may_undo(actor_standing, standing_of(by).await?) {
                    return Err(restricted(
                        "someone with higher standing set this mute; only they or someone above can lift it",
                    ));
                }
            }
            Plan::person(
                BoardChange::Unmute { pubkey: target },
                "board_unmute",
                "unmute",
                target,
                None,
                "Mute lifted.",
            )
        }
        Command::SetRules(rules) => Plan {
            changes: vec![BoardChange::SetRules { rules }],
            audit_action: "board_rules",
            log_action: "rules",
            target_event: None,
            target_pubkey: None,
            until: None,
            asked_until: None,
            reason_code: None,
            message: if rules.is_empty() {
                "Rules cleared.".into()
            } else {
                "Rules saved.".into()
            },
        },
        Command::Appoint { target, until } => {
            if target == &actor {
                return Err(invalid("you cannot appoint yourself"));
            }
            let longest = now + Duration::days(MODERATOR_TERM_DAYS);
            let until = until.unwrap_or(longest);
            if until <= now || until > longest {
                return Err(invalid(format!(
                    "a moderator's term ends in the future and lasts at most {MODERATOR_TERM_DAYS} days"
                )));
            }
            let target_standing = standing_of(target.clone()).await?;
            if target_standing > BoardStanding::Moderator {
                return Err(invalid(
                    "they already own or administer this board or the community",
                ));
            }
            if state
                .db
                .board_mute_until(community, board, target)
                .await
                .map_err(db_error)?
                .is_some()
            {
                return Err(invalid("they are muted on this board"));
            }
            Plan::person(
                BoardChange::Appoint {
                    pubkey: target,
                    until,
                },
                "board_appoint",
                "appoint",
                target,
                Some(until),
                &format!("Moderator appointed until {}.", until.timestamp()),
            )
        }
        Command::Dismiss(target) => {
            let target_standing = standing_of(target.clone()).await?;
            if target_standing != BoardStanding::Moderator {
                return Err(invalid("they are not an appointed moderator of this board"));
            }
            let message = if target == &actor {
                "You are no longer a moderator of this board."
            } else {
                "Moderator dismissed."
            };
            Plan::person(
                BoardChange::Dismiss { pubkey: target },
                "board_dismiss",
                "dismiss",
                target,
                None,
                message,
            )
        }
    };

    let action_id = Uuid::new_v4();
    let log = log_event(
        state,
        LogEntry {
            board,
            action: plan.log_action,
            actor: &actor,
            standing: actor_standing,
            target_event: plan.target_event,
            thread: None,
            target_pubkey: plan.target_pubkey,
            until: plan.until,
            asked_until: plan.asked_until,
            status: plan.reason_code,
            action_id,
            reason: reason.as_deref().unwrap_or(""),
            at: now,
        },
    )
    .map_err(error)?;
    let audit = BoardAuditRow {
        id: action_id,
        at: now,
        actor_pubkey: &actor,
        action: plan.audit_action,
        target_pubkey: plan.target_pubkey,
        target_event_id: plan.target_event,
        reason_code: plan.reason_code,
        public_reason: reason.as_deref(),
        actor_authority: actor_standing.audit_authority(),
    };
    let applied = state
        .db
        .apply_board_action(
            community,
            board,
            &plan.changes,
            audit,
            &log,
            None,
            |snapshot, min| board_state_event(state, board, snapshot, min, now),
        )
        .await
        .map_err(|e| match e {
            // The limits again, checked with the write: requests sent together
            // all pass the early checks above.
            buzz_db::DbError::ModeratorRateLimited(_) => rate_limited(),
            buzz_db::DbError::BoardPinLimit(_) => pin_limit(),
            e => db_error(e),
        })?
        .ok_or_else(|| invalid("nothing to change"))?;
    dispatch_board_events(tenant, state, &applied).await;

    if let (Command::Mute { target, .. }, Some(until)) = (&command, plan.until) {
        let notice = ModerationNotice::BoardMute {
            action_id,
            board: channel.name.clone(),
            public_reason: reason.clone().unwrap_or_default(),
            until,
        };
        if let Err(e) = send_moderation_notice(tenant, state, target, notice, now).await {
            // The mute holds and is in the board's public log; the notice is a courtesy copy.
            info!(error = %e, "board mute notice delivery failed (mute still enforced)");
        }
    }
    info!(board = %board, action = plan.log_action, "board moderation command applied");
    Ok(plan.message)
}

impl<'a> Plan<'a> {
    fn thread(
        change: BoardChange<'a>,
        audit_action: &'static str,
        log_action: &'static str,
        root: &'a [u8],
        message: &str,
    ) -> Self {
        Self {
            changes: vec![change],
            audit_action,
            log_action,
            target_event: Some(root),
            target_pubkey: None,
            until: None,
            asked_until: None,
            reason_code: None,
            message: message.into(),
        }
    }

    fn person(
        change: BoardChange<'a>,
        audit_action: &'static str,
        log_action: &'static str,
        pubkey: &'a [u8],
        until: Option<DateTime<Utc>>,
        message: &str,
    ) -> Self {
        Self {
            changes: vec![change],
            audit_action,
            log_action,
            target_event: None,
            target_pubkey: Some(pubkey),
            until,
            asked_until: None,
            reason_code: None,
            message: message.into(),
        }
    }

    fn mute(
        changes: Vec<BoardChange<'a>>,
        pubkey: &'a [u8],
        until: DateTime<Utc>,
        reason_code: Option<&'static str>,
        message: String,
    ) -> Self {
        Self {
            changes,
            audit_action: "board_mute",
            log_action: "mute",
            target_event: None,
            target_pubkey: Some(pubkey),
            until: Some(until),
            asked_until: None,
            reason_code,
            message,
        }
    }
}

/// Whether `actor` may remove someone else's post or reply on the board
/// `channel_id` through kind:9005, beyond the board's own owners and admins
/// (`validate_admin_event` checks those first): the community's owners and
/// admins, and the board's moderators, against people of lower standing, within
/// a moderator's hourly limit.
pub async fn authorize_board_removal(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    channel_id: Uuid,
    actor: &[u8],
    author: &[u8],
) -> anyhow::Result<()> {
    let now = Utc::now();
    let standing = board_standing(tenant, state, channel_id, actor, now).await?;
    if !board_capability_allowed(standing, BoardCapability::Moderate) {
        anyhow::bail!("must be event author or board moderator, owner or admin");
    }
    if let Some(until) = state
        .db
        .board_mute_until(tenant.community(), channel_id, actor)
        .await?
    {
        anyhow::bail!("you are muted on this board until {}", until.timestamp());
    }
    let author_standing = board_standing(tenant, state, channel_id, author, now).await?;
    if !board_may_act_against(standing, author_standing) {
        anyhow::bail!("you cannot remove a post by someone with the same or higher standing");
    }
    if standing == BoardStanding::Moderator
        && state
            .db
            .board_moderator_actions_since(tenant.community(), actor, now - Duration::hours(1))
            .await?
            >= MODERATOR_ACTIONS_PER_HOUR
    {
        anyhow::bail!("a moderator may take {MODERATOR_ACTIONS_PER_HOUR} actions an hour");
    }
    Ok(())
}

/// Whether `actor` may close a report as one of the board's moderators, and the
/// audit authority to record it under (D99). `Ok(None)` when the report is not
/// about a post or reply on a board the actor moderates: the community's rule
/// then stands alone.
///
/// A board's moderators may dismiss a report, or close it as removed once the
/// post or reply is gone (removed through the board's own path, with its guard
/// rails and public log). Anything more (a ban, a timeout, handing it on) is
/// for the community's moderators, who see every report.
pub async fn board_report_authority(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    actor: &[u8],
    report: &buzz_db::moderation::ReportRecord,
    action: &str,
) -> Result<Option<&'static str>, String> {
    let (Some(channel_id), buzz_db::moderation::ReportTarget::Event(target_id)) =
        (report.channel_id, &report.target)
    else {
        return Ok(None);
    };
    let standing_error = |e: anyhow::Error| error(format!("database error: {e}"));
    let community = tenant.community();
    let channel = state
        .db
        .get_channel_for_event_write(community, channel_id)
        .await
        .map_err(db_error)?;
    if channel.channel_type != "forum" {
        return Ok(None);
    }
    let now = Utc::now();
    let standing = board_standing(tenant, state, channel_id, actor, now)
        .await
        .map_err(standing_error)?;
    if !board_capability_allowed(standing, BoardCapability::Moderate) {
        return Ok(None);
    }
    let Some(target) = state
        .db
        .get_event_by_id_including_deleted(community, target_id)
        .await
        .map_err(db_error)?
    else {
        return Ok(None);
    };
    if !matches!(action, "dismiss" | "delete") {
        return Err(restricted(
            "a board's moderators can remove what was reported or dismiss the report; \
             anything more is for the community's moderators",
        ));
    }
    if let Some(until) = state
        .db
        .board_mute_until(community, channel_id, actor)
        .await
        .map_err(db_error)?
    {
        return Err(restricted(format!(
            "you are muted on this board until {}",
            until.timestamp()
        )));
    }
    let author =
        super::ingest::effective_message_author(&target.event, &state.relay_keypair.public_key());
    if author == actor {
        return Err(restricted("you cannot close a report about your own words"));
    }
    let author_standing = board_standing(tenant, state, channel_id, &author, now)
        .await
        .map_err(standing_error)?;
    if !board_may_act_against(standing, author_standing) {
        return Err(restricted(
            "you cannot close a report about someone with the same or higher standing",
        ));
    }
    if action == "delete"
        && state
            .db
            .get_event_by_id(community, target_id)
            .await
            .map_err(db_error)?
            .is_some()
    {
        return Err(invalid(
            "remove the post or reply first, then close the report",
        ));
    }
    if action == "dismiss"
        && standing == BoardStanding::Moderator
        && state
            .db
            .board_moderator_actions_since(community, actor, now - Duration::hours(1))
            .await
            .map_err(db_error)?
            >= MODERATOR_ACTIONS_PER_HOUR
    {
        return Err(restricted(format!(
            "a moderator may take {MODERATOR_ACTIONS_PER_HOUR} actions an hour"
        )));
    }
    Ok(Some(standing.audit_authority()))
}

/// The words a moderator removes from a board, as stored, with where they sit.
pub struct RemovedWords<'a> {
    /// The post or reply.
    pub event: &'a Event,
    /// Who wrote it.
    pub author: &'a [u8],
    /// For a reply: what it answered.
    pub parent: Option<&'a [u8]>,
    /// For a reply: the thread it is in.
    pub root: Option<&'a [u8]>,
}

/// The longest start of removed words quoted back to their author.
const REMOVED_EXCERPT_CHARS: usize = 80;

/// The start of removed words to quote back to their author: the first line,
/// without a heading's `#`s, cut at [`REMOVED_EXCERPT_CHARS`].
fn removed_excerpt(content: &str) -> String {
    let line = content
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
        .trim_start_matches('#')
        .trim();
    if line.chars().count() <= REMOVED_EXCERPT_CHARS {
        line.to_string()
    } else {
        let cut: String = line.chars().take(REMOVED_EXCERPT_CHARS).collect();
        format!("{}…", cut.trim_end())
    }
}

/// Remove someone else's post or reply on a board (a kind:9005), writing the
/// removal, its audit row and the public log entry together — and, with
/// `store_command`, the kind:9005 itself, so it is accepted only if the removal
/// is (D111) — then telling the author.
///
/// Returns `None` when it was already gone; otherwise the kind:9005 as stored
/// with the removal, when it was.
pub async fn remove_board_post(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    board: &ChannelRecord,
    delete_event: &Event,
    words: RemovedWords<'_>,
    store_command: bool,
) -> anyhow::Result<Option<Option<(StoredEvent, bool)>>> {
    let now = Utc::now();
    let channel_id = board.id;
    let target_bytes = words.event.id.to_bytes();
    let target_id = target_bytes.as_slice();
    let actor = delete_event.pubkey.to_bytes().to_vec();
    let standing = board_standing(tenant, state, channel_id, &actor, now).await?;
    let reason = tag_value(delete_event, "public_reason").map(|r| clip_reason(&r));
    let action_id = tag_value(delete_event, "action_id")
        .and_then(|id| Uuid::parse_str(&id).ok())
        .unwrap_or_else(Uuid::new_v4);
    let log = log_event(
        state,
        LogEntry {
            board: channel_id,
            action: "remove",
            actor: &actor,
            standing,
            target_event: Some(target_id),
            thread: words.root.filter(|root| *root != target_id),
            // Whose words: the author finds the removal in the log by it.
            target_pubkey: Some(words.author),
            until: None,
            asked_until: None,
            status: None,
            action_id,
            reason: reason.as_deref().unwrap_or(""),
            at: now,
        },
    )
    .map_err(|e| anyhow::anyhow!(e))?;
    let audit = BoardAuditRow {
        id: action_id,
        at: now,
        actor_pubkey: &actor,
        action: "delete_message",
        target_pubkey: Some(words.author),
        target_event_id: Some(target_id),
        reason_code: None,
        public_reason: reason.as_deref(),
        actor_authority: standing.audit_authority(),
    };
    let changes = [BoardChange::RemovePost {
        event_id: target_id,
        parent: words.parent,
        root: words.root,
    }];
    let Some(applied) = state
        .db
        .apply_board_action(
            tenant.community(),
            channel_id,
            &changes,
            audit,
            &log,
            store_command.then_some(delete_event),
            |snapshot, min| board_state_event(state, channel_id, snapshot, min, now),
        )
        .await?
    else {
        return Ok(None);
    };
    dispatch_board_events(tenant, state, &applied).await;

    let notice = ModerationNotice::BoardRemoval {
        action_id,
        board: board.name.clone(),
        what: if event_kind_u32(words.event) == KIND_FORUM_POST {
            "post"
        } else {
            "reply"
        },
        excerpt: removed_excerpt(&words.event.content),
        public_reason: reason.unwrap_or_default(),
    };
    // Its own task: the removal is already applied and logged, and the notice's
    // writes would otherwise run at the bottom of the deep ingest stack.
    let (tenant, state, author) = (tenant.clone(), Arc::clone(state), words.author.to_vec());
    tokio::spawn(async move {
        if let Err(e) = send_moderation_notice(&tenant, &state, &author, notice, now).await {
            // The removal holds and is in the board's public log, under the
            // author's key, where the app finds it; the notice is a courtesy copy.
            info!(error = %e, "board removal notice delivery failed (removal still applied)");
        }
    });
    Ok(Some(applied.command))
}

/// Refuse an ordinary write on a board when its author is muted there, or when
/// it is a reply into a locked thread from someone below moderator. Other
/// channels and other kinds pass untouched.
pub async fn enforce_board_write(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    kind: u32,
    event: &Event,
    channel: &ChannelRecord,
) -> Result<(), String> {
    if channel.channel_type != "forum"
        || !matches!(
            kind,
            KIND_FORUM_POST | KIND_FORUM_VOTE | KIND_FORUM_COMMENT | KIND_REACTION
        )
    {
        return Ok(());
    }
    let community = tenant.community();
    let author = event.pubkey.to_bytes().to_vec();
    if let Some(until) = state
        .db
        .board_mute_until(community, channel.id, &author)
        .await
        .map_err(db_error)?
    {
        return Err(restricted(format!(
            "you are muted on this board until {}",
            until.timestamp()
        )));
    }
    if kind == KIND_FORUM_COMMENT {
        // Every post the reply names, however it is marked: the board shows a
        // reply under the first of its root/reply/unmarked references, so a
        // lock must hold whichever one a client chose.
        let referenced: Vec<Vec<u8>> = event
            .tags
            .iter()
            .filter_map(|tag| {
                let parts = tag.as_slice();
                (parts.len() >= 2 && parts[0] == "e")
                    .then(|| hex::decode(&parts[1]).ok())
                    .flatten()
                    .filter(|id| id.len() == 32)
            })
            .collect();
        if state
            .db
            .board_any_locked(community, channel.id, &referenced)
            .await
            .map_err(db_error)?
        {
            let standing = board_standing(tenant, state, channel.id, &author, Utc::now())
                .await
                .map_err(|e| error(format!("database error reading roles: {e}")))?;
            if standing < BoardStanding::Moderator {
                return Err(restricted("this thread is locked"));
            }
        }
    }
    Ok(())
}

struct LogEntry<'a> {
    board: Uuid,
    action: &'a str,
    actor: &'a [u8],
    standing: BoardStanding,
    target_event: Option<&'a [u8]>,
    /// For a removed reply: the thread it was in, so a reader sees the removal there.
    thread: Option<&'a [u8]>,
    target_pubkey: Option<&'a [u8]>,
    until: Option<DateTime<Utc>>,
    /// A longer mute waiting for a second moderator: the end asked for.
    asked_until: Option<DateTime<Utc>>,
    status: Option<&'a str>,
    action_id: Uuid,
    reason: &'a str,
    at: DateTime<Utc>,
}

/// The relay-signed public log entry for one action (kind 45004, `h` = the
/// board). The end of a mute or term is an `until` tag, never `expiration`,
/// which would make relays drop the entry itself when the mute ends.
fn log_event(state: &AppState, entry: LogEntry<'_>) -> Result<Event, String> {
    let mut tags = vec![
        tag(["h", &entry.board.to_string()])?,
        tag(["action", entry.action])?,
        tag(["actor", &hex::encode(entry.actor)])?,
        tag(["role", entry.standing.label()])?,
        tag(["action_id", &entry.action_id.to_string()])?,
    ];
    if let Some(id) = entry.target_event {
        tags.push(tag(["e", &hex::encode(id)])?);
    }
    if let Some(root) = entry.thread {
        tags.push(tag(["thread", &hex::encode(root)])?);
    }
    if let Some(pubkey) = entry.target_pubkey {
        tags.push(tag(["p", &hex::encode(pubkey)])?);
    }
    if let Some(until) = entry.until {
        tags.push(tag(["until", &until.timestamp().to_string()])?);
    }
    if let Some(status) = entry.status {
        tags.push(tag(["status", status])?);
    }
    if let Some(asked) = entry.asked_until {
        tags.push(tag(["asked_until", &asked.timestamp().to_string()])?);
    }
    EventBuilder::new(Kind::Custom(KIND_BOARD_MODERATION_LOG as u16), entry.reason)
        .tags(tags)
        .custom_created_at(nostr::Timestamp::from(entry.at.timestamp().max(0) as u64))
        .sign_with_keys(&state.relay_keypair)
        .map_err(|e| format!("failed to sign board log entry: {e}"))
}

/// The relay-signed board state record (kind 39008, `d` and `h` = the board), built
/// from the snapshot the database read inside the action's transaction.
fn board_state_event(
    state: &AppState,
    board: Uuid,
    snapshot: &BoardSnapshot,
    min_created_at: u64,
    now: DateTime<Utc>,
) -> Result<Event, String> {
    // `h` as well as `d`: live delivery reaches only subscriptions that name the
    // board with `#h`, so that is how clients follow this record.
    let mut tags = vec![
        tag(["d", &board.to_string()])?,
        tag(["h", &board.to_string()])?,
    ];
    if let Some(at) = snapshot.rules_set_at {
        tags.push(tag(["rules_set_at", &at.timestamp().to_string()])?);
    }
    // Who placed each pin and lock, so a client offers an undo only to someone
    // of at least their standing (`board_may_undo`), as the server decides.
    for (id, at, by) in &snapshot.pinned {
        tags.push(tag([
            "pinned",
            &hex::encode(id),
            &at.timestamp().to_string(),
            &hex::encode(by),
        ])?);
    }
    for (id, at, by) in &snapshot.locked {
        tags.push(tag([
            "locked",
            &hex::encode(id),
            &at.timestamp().to_string(),
            &hex::encode(by),
        ])?);
    }
    for (pubkey, until) in &snapshot.moderators {
        tags.push(tag([
            "moderator",
            &hex::encode(pubkey),
            &until.timestamp().to_string(),
        ])?);
    }
    let created_at = (now.timestamp().max(0) as u64).max(min_created_at);
    EventBuilder::new(
        Kind::Custom(KIND_BOARD_STATE as u16),
        snapshot.rules.clone(),
    )
    .tags(tags)
    .custom_created_at(nostr::Timestamp::from(created_at))
    .sign_with_keys(&state.relay_keypair)
    .map_err(|e| format!("failed to sign board state: {e}"))
}

/// Fan the stored log entry and state record out to live subscribers. Both are
/// already durable; a client that misses the fan-out reads them back.
async fn dispatch_board_events(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    applied: &buzz_db::board_moderation::BoardActionOutcome,
) {
    let relay_pubkey_hex = state.relay_keypair.public_key().to_hex();
    for stored in [&applied.log, &applied.state] {
        let kind = event_kind_u32(&stored.event);
        dispatch_persistent_event(tenant, state, stored, kind, &relay_pubkey_hex, None).await;
    }
}

/// The public reason: the `reason` tag, trimmed, without control characters,
/// cut to [`PUBLIC_REASON_MAX_CHARS`]. Set-rules has no reason (its content is the rules).
fn public_reason(event: &Event, command: &Command) -> Option<String> {
    if matches!(command, Command::SetRules(_)) {
        return None;
    }
    tag_value(event, "reason")
        .map(|reason| clip_reason(&reason))
        .filter(|reason| !reason.is_empty())
}

fn clip_reason(reason: &str) -> String {
    let cleaned: String = reason.chars().filter(|c| !c.is_control()).collect();
    cleaned
        .trim()
        .chars()
        .take(PUBLIC_REASON_MAX_CHARS)
        .collect::<String>()
        .trim_end()
        .to_string()
}

fn tag<const N: usize>(parts: [&str; N]) -> Result<Tag, String> {
    Tag::parse(parts).map_err(|e| format!("invalid tag: {e}"))
}

fn tag_value(event: &Event, name: &str) -> Option<String> {
    event.tags.iter().find_map(|t| {
        let parts = t.as_slice();
        (parts.len() >= 2 && parts[0] == name).then(|| parts[1].to_string())
    })
}

/// A 32-byte id from the first `name` tag carrying exactly 64 hex characters.
fn hex_tag(event: &Event, name: &str) -> Option<Vec<u8>> {
    tag_value(event, name)
        .filter(|value| value.len() == 64)
        .and_then(|value| hex::decode(value).ok())
}

fn expiration(event: &Event) -> Result<Option<DateTime<Utc>>, String> {
    match tag_value(event, "expiration") {
        None => Ok(None),
        Some(value) => {
            let secs: i64 = value
                .parse()
                .map_err(|_| invalid("expiration must be a unix timestamp"))?;
            Utc.timestamp_opt(secs, 0)
                .single()
                .map(Some)
                .ok_or_else(|| invalid("expiration out of range"))
        }
    }
}

fn invalid(message: impl std::fmt::Display) -> String {
    format!("invalid: {message}")
}

fn restricted(message: impl std::fmt::Display) -> String {
    format!("restricted: {message}")
}

fn error(message: impl std::fmt::Display) -> String {
    format!("error: {message}")
}

fn db_error(e: buzz_db::DbError) -> String {
    error(format!("database error: {e}"))
}

pub(crate) fn rate_limited() -> String {
    format!("rate-limited: a moderator may take {MODERATOR_ACTIONS_PER_HOUR} actions an hour")
}

fn pin_limit() -> String {
    invalid(format!(
        "a board can have {BOARD_PIN_LIMIT} pinned threads; unpin one first"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::Keys;

    fn command(kind: u32, tags: Vec<Vec<String>>, content: &str) -> Event {
        let tags: Vec<Tag> = tags
            .into_iter()
            .map(|parts| Tag::parse(parts).expect("tag"))
            .collect();
        EventBuilder::new(Kind::Custom(kind as u16), content)
            .tags(tags)
            .sign_with_keys(&Keys::generate())
            .expect("sign")
    }

    #[test]
    fn removed_excerpt_quotes_the_first_line_cut_short() {
        assert_eq!(removed_excerpt("# Title here\n\nbody"), "Title here");
        assert_eq!(removed_excerpt("\n\n  hello  \nmore"), "hello");
        assert_eq!(removed_excerpt(""), "");
        let long = "é".repeat(REMOVED_EXCERPT_CHARS + 5);
        let cut = removed_excerpt(&long);
        assert_eq!(cut.chars().count(), REMOVED_EXCERPT_CHARS + 1);
        assert!(cut.ends_with('…'));
    }

    #[test]
    fn commands_parse_their_targets_and_reject_malformed_ones() {
        let id = "ab".repeat(32);
        assert_eq!(
            Command::parse(&command(
                KIND_BOARD_LOCK_THREAD,
                vec![vec!["e".into(), id.clone()]],
                ""
            )),
            Ok(Command::Lock(hex::decode(&id).unwrap()))
        );
        assert!(Command::parse(&command(
            KIND_BOARD_PIN_THREAD,
            vec![vec!["e".into(), "abcd".into()]],
            ""
        ))
        .is_err());
        assert!(
            Command::parse(&command(
                KIND_BOARD_MUTE,
                vec![vec!["p".into(), id.clone()]],
                ""
            ))
            .is_err(),
            "a mute without an end is refused"
        );
        let rules = "x".repeat(BOARD_RULES_MAX_CHARS + 1);
        assert!(Command::parse(&command(KIND_BOARD_SET_RULES, vec![], &rules)).is_err());
        assert_eq!(
            Command::parse(&command(KIND_BOARD_SET_RULES, vec![], "  Be kind.  ")),
            Ok(Command::SetRules("Be kind.".into()))
        );
    }

    #[test]
    fn a_moderator_may_resign_but_not_dismiss_others() {
        let me = vec![1u8; 32];
        let other = vec![2u8; 32];
        assert_eq!(Command::Dismiss(me.clone()).capability(&me), None);
        assert_eq!(
            Command::Dismiss(other).capability(&me),
            Some(BoardCapability::Manage)
        );
        assert_eq!(
            Command::Appoint {
                target: vec![3; 32],
                until: None
            }
            .capability(&me),
            Some(BoardCapability::Manage)
        );
        assert_eq!(
            Command::Lock(vec![4; 32]).capability(&me),
            Some(BoardCapability::Moderate)
        );
    }

    #[test]
    fn public_reasons_are_trimmed_cut_and_stripped_of_control_characters() {
        let long = format!(" spam\u{0007}\n{} ", "y".repeat(400));
        let clipped = clip_reason(&long);
        assert!(clipped.starts_with("spamy"));
        assert_eq!(clipped.chars().count(), PUBLIC_REASON_MAX_CHARS);
        assert!(!clipped.chars().any(char::is_control));
    }
}
