//! Produce-and-publish seam for the kind:48001 hash-chain audit log.
//!
//! `buzz-audit` owns the chain itself (seq assignment, prev-hash linking,
//! [`buzz_audit::AuditService::verify_chain`]). This module is the relay half:
//!
//! 1. **Produce** — every structural moment named by [`buzz_audit::AuditAction`]
//!    is recorded through [`record_audit`], which enqueues a
//!    [`buzz_audit::NewAuditEntry`] onto the bounded audit channel
//!    (`AppState::audit_tx`). The [`PRODUCE_SITES`] table maps each action to
//!    the relay source location that enqueues it; the tests below bind that
//!    table to the real call sites, so an action cannot ship unproducible.
//! 2. **Publish** — after the worker appends an entry to `audit_log`, it
//!    publishes the entry as a kind:48001 event signed by the relay's configured
//!    signer, stored in the community and dispatched through the same internal
//!    path the workflow sink uses for its relay-signed kinds (see
//!    `workflow_sink.rs` — `lookup_community_host` → `TenantContext::resolved` →
//!    `EventBuilder…sign_with_keys` → `db.insert_event` →
//!    `dispatch_persistent_event`). Client ingest never sees these events
//!    (rejected in `handlers::ingest`), so there is exactly one writer: the
//!    relay.
//! 3. **Serve** — the event `content` is the exact serde shape of
//!    [`buzz_audit::AuditEntry`], i.e. the JSON that
//!    `desktop/src/features/org/lib/auditChain.ts` `parseChainEntry` parses, and
//!    the bytes hash to [`buzz_audit::compute_hash`] — the digest the desktop
//!    recomputes client-side. The bounded `{kinds:[48001], limit:200}` REQ the
//!    desktop sends therefore reads back what this module published.
//!
//! **No recursion:** publishing a kind:48001 event must never enqueue another
//! audit row (that would append forever). The fence is
//! [`event_created_audit_site`], consulted by the single chokepoint every
//! `event_created` enqueue flows through, plus the workflow-trigger exclusion in
//! `dispatch_persistent_event_inner`.

use std::sync::Arc;
use std::time::Duration;

use buzz_audit::{AuditAction, AuditEntry, NewAuditEntry};
use buzz_core::kind::KIND_AUDIT_ENTRY;
use buzz_core::tenant::TenantContext;
use buzz_core::CommunityId;
use nostr::{Event, EventBuilder, Kind, Timestamp};
use serde_json::Value;
use tokio::sync::mpsc;
use tokio::sync::mpsc::error::TrySendError;

use crate::handlers::event::dispatch_persistent_event;
use crate::state::AppState;

// ── Produce side ─────────────────────────────────────────────────────────────

/// A structural moment in the relay that gets an audit row.
///
/// One variant per [`buzz_audit::AuditAction`] (the mapping is asserted by
/// [`tests::every_audit_action_has_a_produce_site`]); several call sites may
/// share one variant (e.g. admin put-member and self-join are both
/// [`AuditSite::MemberAdded`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AuditSite {
    /// An event was durably accepted (ingest / internal dispatch).
    EventCreated,
    /// An event was deleted (author NIP-09 kind:5, moderation kind:9005).
    EventDeleted,
    /// A channel was created (NIP-29 kind:9007).
    ChannelCreated,
    /// A channel's metadata was updated (NIP-29 kind:9002).
    ChannelUpdated,
    /// A channel was deleted (NIP-29 kind:9008).
    ChannelDeleted,
    /// A member was added (kind:9000 put-member, kind:9021 join).
    MemberAdded,
    /// A member was removed (kind:9001 remove-member, kind:9022 leave).
    MemberRemoved,
    /// A NIP-42 AUTH transitioned a connection to `Authenticated`.
    AuthSuccess,
    /// A NIP-42 AUTH attempt failed a gate (ban, allowlist, membership, sig).
    AuthFailure,
    /// An admission quota rejected a frame: WS door (`rejection.rs`), HTTP
    /// ingest door (`POST /events` in `api/bridge.rs`).
    RateLimitExceeded,
    /// A media upload completed on the Blossom endpoint.
    MediaUploaded,
}

impl AuditSite {
    /// The audit action this site records.
    pub(crate) const fn action(self) -> AuditAction {
        match self {
            Self::EventCreated => AuditAction::EventCreated,
            Self::EventDeleted => AuditAction::EventDeleted,
            Self::ChannelCreated => AuditAction::ChannelCreated,
            Self::ChannelUpdated => AuditAction::ChannelUpdated,
            Self::ChannelDeleted => AuditAction::ChannelDeleted,
            Self::MemberAdded => AuditAction::MemberAdded,
            Self::MemberRemoved => AuditAction::MemberRemoved,
            Self::AuthSuccess => AuditAction::AuthSuccess,
            Self::AuthFailure => AuditAction::AuthFailure,
            Self::RateLimitExceeded => AuditAction::RateLimitExceeded,
            Self::MediaUploaded => AuditAction::MediaUploaded,
        }
    }

    /// Bounded metric label for this site (closed set — no cardinality risk).
    pub(crate) fn label(self) -> &'static str {
        self.action().as_str()
    }

    /// How an enqueue at this site behaves when the audit queue is full.
    ///
    /// Structural sites **backpressure**: `.send().await` stalls the caller
    /// instead of dropping evidence (the posture the ingest audit enqueue has
    /// always documented — a full queue means the audit DB is genuinely
    /// overloaded and the relay slows down rather than accumulating unbounded
    /// in-memory state). [`AuditSite::RateLimitExceeded`] **sheds** instead:
    /// an over-quota flood must not be able to stall the very door that is
    /// shedding load, and shedding at enqueue time can never put a hole in the
    /// chain — `seq`/`prev_hash` are assigned only when a row is actually
    /// appended, so the chain stays contiguous over exactly the rows that were
    /// recorded, and every shed is counted.
    const fn needs_backpressure(self) -> bool {
        !matches!(self, Self::RateLimitExceeded)
    }
}

/// The produce-side mapping table: one row per (action, source file) pair,
/// bound to the anchor literal that must appear in that file.
///
/// An action may fan out across files (e.g. `RateLimitExceeded` has the WS door
/// in `rejection.rs` and the HTTP ingest door in `api/bridge.rs`) and across
/// several call sites inside one file (pinned by
/// [`ProduceSite::min_occurrences`]).
///
/// This table is *the* produce seam. [`tests::every_audit_action_has_a_produce_site`]
/// asserts it covers [`buzz_audit::AuditAction::all`] exactly, and
/// [`tests::every_produce_site_is_bound_to_a_relay_call_site`] reads the named
/// files and asserts the anchor appears together with `record_audit(` — so a
/// row cannot exist without real production call sites, and a deleted call site
/// reds the suite.
#[cfg_attr(not(test), allow(dead_code))] // consumed by the binding tests below
pub(crate) struct ProduceSite {
    /// The site (and therefore the action) produced here.
    pub(crate) site: AuditSite,
    /// Source file relative to `crates/buzz-relay/src/`.
    pub(crate) file: &'static str,
    /// Literal that must appear in that file (the call site's site token).
    pub(crate) anchor: &'static str,
    /// Minimum occurrences of the anchor — pins *how many* call sites exist,
    /// so removing one of several hooks for the same action also reds.
    pub(crate) min_occurrences: usize,
}

/// The produce-side mapping (see [`ProduceSite`]).
#[cfg_attr(not(test), allow(dead_code))] // consumed by the binding tests below
pub(crate) const PRODUCE_SITES: &[ProduceSite] = &[
    ProduceSite {
        site: AuditSite::EventCreated,
        file: "handlers/event.rs",
        // The no-recursion fence *is* the event_created site selection —
        // binding it pins both the produce call and the fence in one anchor.
        anchor: "event_created_audit_site(kind_u32)",
        min_occurrences: 1,
    },
    ProduceSite {
        site: AuditSite::EventDeleted,
        file: "handlers/side_effects.rs",
        anchor: "AuditSite::EventDeleted",
        // kind:9005 moderation delete + kind:5 author delete by `e` tag +
        // kind:5 author delete by `a` tag (addressable coordinate).
        min_occurrences: 3,
    },
    ProduceSite {
        site: AuditSite::ChannelCreated,
        file: "handlers/side_effects.rs",
        anchor: "AuditSite::ChannelCreated",
        min_occurrences: 1,
    },
    ProduceSite {
        site: AuditSite::ChannelUpdated,
        file: "handlers/side_effects.rs",
        anchor: "AuditSite::ChannelUpdated",
        min_occurrences: 1,
    },
    ProduceSite {
        site: AuditSite::ChannelDeleted,
        file: "handlers/side_effects.rs",
        anchor: "AuditSite::ChannelDeleted",
        min_occurrences: 1,
    },
    ProduceSite {
        site: AuditSite::MemberAdded,
        file: "handlers/side_effects.rs",
        anchor: "AuditSite::MemberAdded",
        // kind:9000 put-member + kind:9021 join.
        min_occurrences: 2,
    },
    ProduceSite {
        site: AuditSite::MemberRemoved,
        file: "handlers/side_effects.rs",
        anchor: "AuditSite::MemberRemoved",
        // kind:9001 remove-member + kind:9022 leave.
        min_occurrences: 2,
    },
    ProduceSite {
        site: AuditSite::AuthSuccess,
        file: "handlers/auth.rs",
        anchor: "AuditSite::AuthSuccess",
        min_occurrences: 1,
    },
    ProduceSite {
        site: AuditSite::AuthFailure,
        file: "handlers/auth.rs",
        anchor: "AuditSite::AuthFailure",
        // ban / allowlist / not_relay_member / signature-invalid.
        min_occurrences: 4,
    },
    ProduceSite {
        site: AuditSite::RateLimitExceeded,
        file: "rejection.rs",
        // The site token lives in the shared `record_rate_limit_audit` helper,
        // so binding the helper *name* with its full occurrence count (1 def +
        // 2 call sites) is what pins both WS doors: dropping the burst-quota or
        // the per-minute-message call reds the suite.
        anchor: "record_rate_limit_audit(",
        min_occurrences: 3,
    },
    ProduceSite {
        site: AuditSite::RateLimitExceeded,
        file: "api/bridge.rs",
        anchor: "AuditSite::RateLimitExceeded",
        // HTTP ingest door (`POST /events`) — the same path the WS door gates.
        min_occurrences: 1,
    },
    ProduceSite {
        site: AuditSite::MediaUploaded,
        file: "api/media.rs",
        anchor: "AuditSite::MediaUploaded",
        min_occurrences: 1,
    },
];

/// One produce request: where the structural change happened, who did it, and
/// what was acted upon.
///
/// `detail` is **never** bearer-token material (see [`NewAuditEntry::detail`]):
/// auth records carry only closed-set outcome metadata.
pub(crate) struct AuditRecord<'a> {
    /// Which structural moment fired.
    pub(crate) site: AuditSite,
    /// Server-resolved tenant of the operation.
    pub(crate) tenant: &'a TenantContext,
    /// Raw pubkey bytes of the actor, if the action has one.
    pub(crate) actor_pubkey: Option<Vec<u8>>,
    /// Identifier of the object acted upon (event id hex, channel UUID, …).
    pub(crate) object_id: Option<String>,
    /// Hashed JSON context for the entry.
    pub(crate) detail: Value,
}

impl<'a> AuditRecord<'a> {
    /// Start a record for `site` under `tenant` with empty actor/object/detail.
    pub(crate) fn new(site: AuditSite, tenant: &'a TenantContext) -> Self {
        Self {
            site,
            tenant,
            actor_pubkey: None,
            object_id: None,
            detail: Value::Null,
        }
    }

    /// Set the acting pubkey (raw bytes, as stored in `audit_log`).
    pub(crate) fn actor(mut self, pubkey: Option<Vec<u8>>) -> Self {
        self.actor_pubkey = pubkey;
        self
    }

    /// Set the object identifier (event id hex, channel UUID, …).
    pub(crate) fn object_id(mut self, id: impl Into<String>) -> Self {
        self.object_id = Some(id.into());
        self
    }

    /// Set the hashed JSON context.
    pub(crate) fn detail(mut self, detail: Value) -> Self {
        self.detail = detail;
        self
    }
}

/// What happened when a record was offered to the bounded audit queue.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AuditEnqueueOutcome {
    /// The entry is queued for the worker (or the channel accepted it).
    Queued,
    /// A shedding site dropped the entry because the queue was full — counted,
    /// never silent, and never a hole in the chain (see [`AuditSite::needs_backpressure`]).
    Shed,
    /// Audit is disabled (`audit_tx` is `None`).
    Disabled,
    /// The queue was closed (worker gone / shutdown) — the entry is lost and
    /// the failure is logged and counted.
    Closed,
}

/// Build the [`NewAuditEntry`] for a record.
pub(crate) fn new_audit_entry(record: &AuditRecord<'_>) -> NewAuditEntry {
    NewAuditEntry {
        community_id: record.tenant.community(),
        action: record.site.action(),
        actor_pubkey: record.actor_pubkey.clone(),
        object_id: record.object_id.clone(),
        detail: record.detail.clone(),
    }
}

/// Enqueue one entry onto the bounded audit queue, applying the site's
/// overload policy (backpressure vs. shed).
///
/// Every outcome is observable in `buzz_audit_enqueue_total` (labels: `site`,
/// `outcome`); `Closed` additionally logs at `error` with the object id, so a
/// lost entry is never a silent success.
pub(crate) async fn enqueue_new_audit(
    tx: Option<&mpsc::Sender<NewAuditEntry>>,
    site: AuditSite,
    entry: NewAuditEntry,
) -> AuditEnqueueOutcome {
    if !site.needs_backpressure() {
        return try_enqueue_new_audit(tx, site, entry);
    }
    let Some(tx) = tx else {
        metrics::counter!(
            "buzz_audit_enqueue_total",
            "site" => site.label(),
            "outcome" => "disabled"
        )
        .increment(1);
        return AuditEnqueueOutcome::Disabled;
    };

    let object_id = entry.object_id.clone();
    match tx.send(entry).await {
        Ok(()) => {
            metrics::counter!(
                "buzz_audit_enqueue_total",
                "site" => site.label(),
                "outcome" => "queued"
            )
            .increment(1);
            AuditEnqueueOutcome::Queued
        }
        Err(e) => {
            tracing::error!(
                site = site.label(),
                object = ?object_id,
                "audit channel closed — entry lost: {e}"
            );
            metrics::counter!(
                "buzz_audit_enqueue_total",
                "site" => site.label(),
                "outcome" => "closed"
            )
            .increment(1);
            AuditEnqueueOutcome::Closed
        }
    }
}

/// Non-blocking enqueue for load-shedding sites only.
///
/// Panics if handed a backpressure site — that would silently turn the
/// evidence-preserving posture into a drop. Shed sites never wait on the
/// queue (see [`AuditSite::needs_backpressure`]), which is what lets this run
/// from synchronous admission code without a task hop.
pub(crate) fn record_audit_nonblocking(
    state: &AppState,
    record: AuditRecord<'_>,
) -> AuditEnqueueOutcome {
    let site = record.site;
    assert!(
        !site.needs_backpressure(),
        "backpressure sites must go through record_audit"
    );
    try_enqueue_new_audit(state.audit_tx.as_ref(), site, new_audit_entry(&record))
}

/// The try-send half of the enqueue policy (disabled / shed / closed / queued).
fn try_enqueue_new_audit(
    tx: Option<&mpsc::Sender<NewAuditEntry>>,
    site: AuditSite,
    entry: NewAuditEntry,
) -> AuditEnqueueOutcome {
    let Some(tx) = tx else {
        metrics::counter!(
            "buzz_audit_enqueue_total",
            "site" => site.label(),
            "outcome" => "disabled"
        )
        .increment(1);
        return AuditEnqueueOutcome::Disabled;
    };

    let object_id = entry.object_id.clone();
    let (outcome, metric_outcome) = match tx.try_send(entry) {
        Ok(()) => (AuditEnqueueOutcome::Queued, "queued"),
        Err(TrySendError::Full(_)) => {
            // Shed by design: counted, never a chain hole (seq is assigned
            // only on append).
            metrics::counter!(
                "buzz_audit_enqueue_total",
                "site" => site.label(),
                "outcome" => "shed"
            )
            .increment(1);
            return AuditEnqueueOutcome::Shed;
        }
        Err(TrySendError::Closed(_)) => {
            tracing::error!(
                site = site.label(),
                object = ?object_id,
                "audit channel closed — entry lost"
            );
            (AuditEnqueueOutcome::Closed, "closed")
        }
    };
    metrics::counter!(
        "buzz_audit_enqueue_total",
        "site" => site.label(),
        "outcome" => metric_outcome
    )
    .increment(1);
    outcome
}

/// Record a structural moment: build the entry and enqueue it.
///
/// The production seam every producer calls; returns the enqueue outcome so
/// call sites (and tests) can observe the failure semantics.
pub(crate) async fn record_audit(state: &AppState, record: AuditRecord<'_>) -> AuditEnqueueOutcome {
    let site = record.site;
    let entry = new_audit_entry(&record);
    enqueue_new_audit(state.audit_tx.as_ref(), site, entry).await
}

/// The no-recursion fence for `event_created`.
///
/// Returns the audit site a stored event of `kind` should produce — `None` for
/// kind:48001, because those events *are* the audit log's projection:
/// recording `event_created` for an audit publication would append a row for
/// every published row, forever. Every `event_created` enqueue funnels through
/// this function (bound by
/// [`tests::publishing_an_audit_entry_never_enqueues_another_audit_row`]).
pub(crate) fn event_created_audit_site(kind_u32: u32) -> Option<AuditSite> {
    if kind_u32 == KIND_AUDIT_ENTRY {
        None
    } else {
        Some(AuditSite::EventCreated)
    }
}

// ── Failure semantics ────────────────────────────────────────────────────────

/// Verdict for a failed `AuditService::log` attempt.
///
/// The policy (the "durable retry queue" decision): the queued entry *is* the
/// retry record, so every failure that is not provably terminal keeps the entry
/// and retries with capped backoff — the chain stops rather than records a
/// hole. The single terminal case is the FK pointing at a deleted tenant: there
/// the chain was removed with the community, so dropping the entry corrupts
/// nothing and retrying would block every other community's chain forever.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AppendFailure {
    /// `55P03` advisory-lock timeout: preserved and retried (counted on the
    /// dedicated lock-retry counter, as before).
    LockTimeout,
    /// Any other error (including unknown ones): preserved and retried with
    /// capped backoff, each attempt logged and counted.
    Retryable,
    /// `23503` FK violation — the community row is gone. Terminal for this
    /// entry only; the tenant's chain was deleted with it.
    TenantGone,
}

/// Classify a failed append from the SQLSTATE, if the error carries one.
///
/// Unknown/`None` codes are [`AppendFailure::Retryable`] — fail closed: an
/// unrecognised error must never be treated as "write succeeded somewhere else".
pub(crate) fn classify_sql_state(code: Option<&str>) -> AppendFailure {
    match code {
        Some("55P03") => AppendFailure::LockTimeout,
        Some("23503") => AppendFailure::TenantGone,
        _ => AppendFailure::Retryable,
    }
}

/// Classify a failed [`buzz_audit::AuditService::log`] attempt.
pub(crate) fn classify_append_failure(error: &buzz_audit::AuditError) -> AppendFailure {
    let buzz_audit::AuditError::Database(sqlx::Error::Database(db)) = error else {
        return AppendFailure::Retryable;
    };
    classify_sql_state(db.code().as_deref())
}

// ── Publish side ─────────────────────────────────────────────────────────────

/// Upper bound on a kind:48001 envelope's `content`.
///
/// The content is serde of [`AuditEntry`] — code-authored `detail` only — so
/// this bound is a defensive fence against future detail growth, checked both
/// when building an event and at client ingest (which rejects everything).
pub(crate) const AUDIT_ENVELOPE_MAX_BYTES: usize = 16 * 1024;

/// Serialize a chain entry into the kind:48001 envelope `content`.
///
/// This is exactly the JSON `parseChainEntry` in
/// `desktop/src/features/org/lib/auditChain.ts` consumes: `AuditEntry`'s own
/// serde shape (`community_id`, `seq`, `hash`, `prev_hash`, `action`,
/// `actor_pubkey`, `object_id`, `detail`, `created_at`), with bytes as JSON
/// arrays and `created_at` as RFC 3339.
pub(crate) fn audit_envelope_content(entry: &AuditEntry) -> Result<String, serde_json::Error> {
    serde_json::to_string(entry)
}

/// Build the relay-signed kind:48001 event for one chain entry.
///
/// **Deterministic:** `created_at` is taken from the entry and there are no
/// tags, so re-publishing the same entry yields the *same* event id — a retry
/// after a partial failure can never duplicate the entry in the served window
/// (a duplicate `seq` would make the desktop's verifier report `malformed`).
pub(crate) fn build_audit_entry_event(
    entry: &AuditEntry,
    relay_keypair: &nostr::Keys,
) -> anyhow::Result<Event> {
    let content = audit_envelope_content(entry)?;
    anyhow::ensure!(
        content.len() <= AUDIT_ENVELOPE_MAX_BYTES,
        "kind:48001 envelope exceeds {AUDIT_ENVELOPE_MAX_BYTES} bytes ({} bytes)",
        content.len()
    );
    let created_at = Timestamp::from_secs(entry.created_at.timestamp().max(0) as u64);
    let event = EventBuilder::new(Kind::Custom(KIND_AUDIT_ENTRY as u16), content)
        .custom_created_at(created_at)
        .sign_with_keys(relay_keypair)?;
    Ok(event)
}

/// Result of a publish attempt that completed without error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PublishOutcome {
    /// The event was stored and dispatched.
    Published,
    /// The identical event was already stored (idempotent retry) — nothing to
    /// re-dispatch; counted as success.
    AlreadyPublished,
    /// The community no longer resolves to a host: the tenant (and its chain)
    /// was deleted mid-flight. Terminal for this entry — the worker stops
    /// retrying instead of blocking every other community.
    TenantGone,
}

/// Publish one chain entry as a kind:48001 event.
///
/// Follows the internal-publication precedent set by the workflow sink
/// (`workflow_sink.rs`, kind:46010 emission): resolve the tenant's host,
/// sign with the relay's configured key, insert directly into the event store
/// (never through client ingest, which rejects kind:48001), then dispatch
/// through the guarded fan-out path. `was_inserted == false` means a prior
/// attempt already stored the identical event — treated as success.
pub(crate) async fn publish_audit_entry(
    state: &Arc<AppState>,
    entry: &AuditEntry,
) -> anyhow::Result<PublishOutcome> {
    let event = build_audit_entry_event(entry, &state.relay_keypair)?;
    let community = CommunityId::from_uuid(entry.community_id);

    let Some(host) = state.db.lookup_community_host(community).await? else {
        return Ok(PublishOutcome::TenantGone);
    };
    let tenant = TenantContext::resolved(community, host);

    let (stored, was_inserted) = state.db.insert_event(community, &event, None).await?;
    if !was_inserted {
        metrics::counter!("buzz_audit_publish_total", "outcome" => "already").increment(1);
        return Ok(PublishOutcome::AlreadyPublished);
    }

    dispatch_persistent_event(
        &tenant,
        state,
        &stored,
        KIND_AUDIT_ENTRY,
        &state.relay_keypair.public_key().to_hex(),
        None,
    )
    .await;

    metrics::counter!("buzz_audit_publish_total", "outcome" => "published").increment(1);
    Ok(PublishOutcome::Published)
}

/// Initial retry delay (ms) for audit DB operations; doubles up to
/// [`MAX_RETRY_DELAY_MS`].
const INITIAL_RETRY_DELAY_MS: u64 = 50;
/// Ceiling for the retry backoff — a persistent failure retries at most once
/// per second, so a stuck entry cannot self-amplify into a hot loop.
const MAX_RETRY_DELAY_MS: u64 = 1000;

/// One capped-backoff sleep that returns early (and reports cancellation) when
/// `cancel` fires, so shutdown never waits out a full backoff chain.
pub(crate) async fn audit_backoff(
    cancel: &tokio_util::sync::CancellationToken,
    delay_ms: &mut u64,
) -> bool {
    let delay = *delay_ms;
    *delay_ms = delay.saturating_mul(2).min(MAX_RETRY_DELAY_MS);
    tokio::select! {
        _ = cancel.cancelled() => true,
        _ = tokio::time::sleep(Duration::from_millis(delay)) => false,
    }
}

/// The retry delay sequence starts here (used by the worker's append loop).
pub(crate) const fn initial_retry_delay_ms() -> u64 {
    INITIAL_RETRY_DELAY_MS
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_audit::AuditAction;
    use std::collections::{HashMap, HashSet};

    fn src_path(rel: &str) -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join(rel)
    }

    fn read_src(rel: &str) -> String {
        let path = src_path(rel);
        std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("cannot read {} ({e})", path.display()))
    }

    fn occurrences(haystack: &str, needle: &str) -> usize {
        haystack.matches(needle).count()
    }

    /// Completeness: every action in the closed set has exactly one row in the
    /// produce mapping, and the mapping introduces no phantom actions.
    #[test]
    fn every_audit_action_has_a_produce_site() {
        let expected: HashSet<&'static str> =
            AuditAction::all().iter().map(|a| a.as_str()).collect();
        let mapped: HashSet<&'static str> = PRODUCE_SITES
            .iter()
            .map(|row| row.site.action().as_str())
            .collect();
        assert_eq!(
            expected, mapped,
            "PRODUCE_SITES must cover AuditAction::all exactly — an action \
             added to buzz-audit without a relay produce site cannot ship"
        );
        // Rows may fan out per file, but the same (action, file) pair twice
        // would be a stale duplicate row nobody needs.
        let mut seen = HashSet::new();
        for row in PRODUCE_SITES {
            assert!(
                seen.insert((row.site.action().as_str(), row.file)),
                "duplicate PRODUCE_SITES row for {:?} in {}",
                row.site,
                row.file
            );
        }
        // The 1:1 site↔action mapping itself (the match in AuditSite::action
        // is exhaustive by construction; this pins no site maps to itself
        // accidentally twice).
        for row in PRODUCE_SITES {
            assert_eq!(
                row.site.action().as_str(),
                row.site.label(),
                "site label must be its action's stable string"
            );
        }
    }

    /// Binding: each mapping row's file contains the anchor literal at least
    /// `min_occurrences` times *and* a `record_audit(` call — a row without
    /// production call sites, or a call site deleted out from under a pinned
    /// count, reds here.
    #[test]
    fn every_produce_site_is_bound_to_a_relay_call_site() {
        // Cache file reads per file so the side-effects file (7 rows) is read once.
        let mut sources: HashMap<&'static str, String> = HashMap::new();
        for row in PRODUCE_SITES {
            let source = sources
                .entry(row.file)
                .or_insert_with(|| read_src(row.file));
            let anchor_count = occurrences(source, row.anchor);
            assert!(
                anchor_count >= row.min_occurrences,
                "{} must contain at least {} occurrence(s) of `{}` (found {anchor_count}) — \
                 the audit produce call site for {:?} was removed",
                row.file,
                row.min_occurrences,
                row.anchor,
                row.site
            );
            assert!(
                occurrences(source, "record_audit(")
                    + occurrences(source, "record_audit_nonblocking(")
                    >= 1,
                "{} must call record_audit/record_audit_nonblocking (the production \
                 enqueue seam)",
                row.file
            );
        }
    }

    /// No-recursion fence: kind:48001 has no `event_created` site, and the
    /// chokepoint every enqueue flows through consults the fence (source-bound
    /// so removing the call reds).
    #[test]
    fn publishing_an_audit_entry_never_enqueues_another_audit_row() {
        assert_eq!(event_created_audit_site(KIND_AUDIT_ENTRY), None);
        assert_eq!(
            event_created_audit_site(1),
            Some(AuditSite::EventCreated),
            "ordinary kinds still produce event_created"
        );

        let event_src = read_src("handlers/event.rs");
        assert!(
            event_src.contains("event_created_audit_site(kind_u32)"),
            "enqueue_event_created_audit must consult the fence — without it, \
             publishing kind:48001 would enqueue an audit row for every audit row"
        );
        // And the internal dispatcher that publishes audit entries must not
        // hand them to the workflow engine (amplification vector).
        assert!(
            event_src.contains("kind_u32 != KIND_AUDIT_ENTRY"),
            "dispatch_persistent_event_inner must exclude kind:48001 from \
             workflow triggering"
        );
        // Client submissions must be rejected on ingest — the relay is the only
        // publisher of kind:48001.
        let ingest_src = read_src("handlers/ingest.rs");
        assert!(
            occurrences(&ingest_src, "KIND_AUDIT_ENTRY") >= 1,
            "ingest must reject client-submitted kind:48001"
        );
    }

    /// Enqueue failure semantics per site: structural sites block on a full
    /// queue (evidence is never dropped), the load-shedding rate-limit site
    /// drops-and-counts, disabled is a no-op, and a closed queue is an error —
    /// never a silent success.
    #[tokio::test]
    async fn enqueue_failure_semantics_match_the_site_policy() {
        let tenant = TenantContext::resolved(
            CommunityId::from_uuid(uuid::Uuid::from_u128(1)),
            "relay.test",
        );
        let record = AuditRecord::new(AuditSite::EventCreated, &tenant)
            .actor(Some(vec![0xab; 32]))
            .object_id("deadbeef")
            .detail(serde_json::json!({"event_kind": 1}));
        let entry = new_audit_entry(&record);
        assert_eq!(entry.action, AuditAction::EventCreated);

        // Disabled: audit off ⇒ no-op outcome.
        assert_eq!(
            enqueue_new_audit(None, AuditSite::EventCreated, entry.clone()).await,
            AuditEnqueueOutcome::Disabled
        );

        // Backpressure: a full queue blocks the structural producer rather than
        // shedding. Capacity 1, one buffered entry ⇒ send must not complete.
        let (tx, mut rx) = mpsc::channel::<NewAuditEntry>(1);
        tx.send(entry.clone()).await.unwrap();
        let pending = tokio::time::timeout(
            Duration::from_millis(100),
            enqueue_new_audit(Some(&tx), AuditSite::EventCreated, entry.clone()),
        )
        .await;
        assert!(
            pending.is_err(),
            "structural sites must backpressure on a full audit queue, not drop"
        );
        // Receiving the buffered entry lets the pending send complete.
        rx.recv().await.unwrap();
        assert_eq!(
            tokio::time::timeout(
                Duration::from_millis(100),
                enqueue_new_audit(Some(&tx), AuditSite::EventCreated, entry.clone()),
            )
            .await
            .expect("send completes once space exists"),
            AuditEnqueueOutcome::Queued
        );

        // Shed: the rate-limit site never blocks the door that sheds load.
        let (tx, _rx) = mpsc::channel::<NewAuditEntry>(1);
        tx.send(entry.clone()).await.unwrap();
        assert_eq!(
            enqueue_new_audit(Some(&tx), AuditSite::RateLimitExceeded, entry.clone()).await,
            AuditEnqueueOutcome::Shed
        );

        // Closed: the worker is gone — logged + counted, outcome observable.
        let (tx, rx) = mpsc::channel::<NewAuditEntry>(1);
        drop(rx);
        assert_eq!(
            enqueue_new_audit(Some(&tx), AuditSite::EventCreated, entry).await,
            AuditEnqueueOutcome::Closed
        );
    }

    /// Failure classification: the only terminal case is the tenant's FK row
    /// being gone; lock timeouts keep their dedicated class; anything unknown
    /// stays retryable (fail closed — never "assume it landed").
    #[test]
    fn append_failure_classification_is_fail_closed() {
        assert_eq!(
            classify_sql_state(Some("55P03")),
            AppendFailure::LockTimeout
        );
        assert_eq!(classify_sql_state(Some("23503")), AppendFailure::TenantGone);
        // Unique violation, serialization failure, connection errors, and no
        // code at all (pool/io errors) all keep the entry and retry.
        for code in [
            Some("23505"),
            Some("40001"),
            Some("08006"),
            Some("XX000"),
            None,
        ] {
            assert_eq!(
                classify_sql_state(code),
                AppendFailure::Retryable,
                "code {code:?} must stay retryable"
            );
        }

        // Through the real error type: a non-DB error is retryable too.
        let domain = buzz_audit::AuditError::UnknownAction;
        assert_eq!(classify_append_failure(&domain), AppendFailure::Retryable);
    }

    // ── Publish contract: the desktop verifier is the consumer ──────────────

    /// A representative chain entry as the worker would hold it (hash computed
    /// by the crate, storage-precision timestamp, chained prev_hash).
    fn sample_published_entry(seq: i64) -> AuditEntry {
        let mut entry = AuditEntry {
            community_id: uuid::Uuid::from_u128(0x_c0ffee),
            seq,
            hash: Vec::new(),
            hash_version: buzz_audit::hash::CURRENT_HASH_VERSION,
            prev_hash: Some(vec![0x11; 32]),
            action: AuditAction::ChannelCreated,
            actor_pubkey: Some(vec![0xab; 32]),
            object_id: Some("44d2d461-6f25-4a58-8b13-6b6b5f33aa11".into()),
            detail: serde_json::json!({"event_id": "aa".repeat(32)}),
            created_at: chrono::DateTime::parse_from_rfc3339("2026-01-01T00:00:00.123456Z")
                .unwrap()
                .with_timezone(&chrono::Utc),
        };
        entry.hash = buzz_audit::compute_hash(&entry).expect("hash").to_vec();
        entry
    }

    fn desktop_file(name: &str) -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../desktop/src/features/org/lib")
            .join(name);
        std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("cannot read {} ({e})", path.display()))
    }

    /// The published envelope is the *exact* JSON `parseChainEntry` parses.
    ///
    /// Field set is extracted from the committed TS source at test time, so
    /// drift on either side (a serde rename, a new TS requirement) reds this
    /// test, and the round-tripped entry must still hash to the digest the
    /// desktop recomputes.
    #[test]
    fn published_envelope_matches_the_ts_verifier_contract() {
        let entry = sample_published_entry(7);
        let content = audit_envelope_content(&entry).expect("envelope serializes");
        assert!(
            content.len() <= AUDIT_ENVELOPE_MAX_BYTES,
            "representative envelope must sit under the published bound"
        );
        let value: serde_json::Value =
            serde_json::from_str(&content).expect("envelope is valid JSON");
        let object = value.as_object().expect("envelope is a JSON object");

        // 1. Field set: every `record.<field>` parseChainEntry reads must be a
        //    serde field of AuditEntry, and vice versa.
        let ts = desktop_file("auditChain.ts");
        let fn_start = ts
            .find("export function parseChainEntry")
            .expect("auditChain.ts must export parseChainEntry");
        let fn_end = ts[fn_start..]
            .find("\nexport ")
            .map(|off| fn_start + off)
            .unwrap_or(ts.len());
        let body = &ts[fn_start..fn_end];
        let mut ts_fields: HashSet<String> = HashSet::new();
        let mut rest = body;
        while let Some(pos) = rest.find("record.") {
            rest = &rest[pos + "record.".len()..];
            let len = rest
                .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
                .unwrap_or(rest.len());
            if len > 0 {
                ts_fields.insert(rest[..len].to_owned());
            }
        }
        assert!(
            !ts_fields.is_empty(),
            "extraction must find record.<field> reads in parseChainEntry"
        );
        let json_fields: HashSet<String> = object.keys().cloned().collect();
        assert_eq!(
            ts_fields, json_fields,
            "the published envelope must expose exactly the fields parseChainEntry \
             consumes — a serde rename or a new envelope field breaks the contract"
        );

        // 2. Types the TS parser requires.
        assert!(object["community_id"].is_string());
        assert!(object["seq"].is_i64());
        assert!(object["hash"].as_array().is_some_and(
            |a| a.len() == 32 && a.iter().all(|v| v.as_u64().is_some_and(|n| n <= 255))
        ));
        assert!(
            object["prev_hash"].is_null()
                || object["prev_hash"].as_array().is_some_and(
                    |a| a.len() == 32 && a.iter().all(|v| v.as_u64().is_some_and(|n| n <= 255))
                )
        );
        assert!(
            object["actor_pubkey"].is_null()
                || object["actor_pubkey"]
                    .as_array()
                    .is_some_and(|a| a.iter().all(|v| v.as_u64().is_some_and(|n| n <= 255)))
        );
        assert!(object["object_id"].is_null() || object["object_id"].is_string());
        assert!(object["created_at"].is_string());
        let action = object["action"].as_str().expect("action is a string");
        assert!(
            AuditAction::all().iter().any(|a| a.as_str() == action),
            "action {action:?} must be in the closed set"
        );

        // 3. Round-trip: what a reader deserializes hashes back to the chain
        //    digest — i.e. the published content hashes to compute_hash.
        let parsed: AuditEntry = serde_json::from_str(&content).expect("round-trips");
        assert_eq!(parsed, entry);
        let recomputed = buzz_audit::compute_hash(&parsed).expect("recompute");
        assert_eq!(
            recomputed.as_slice(),
            entry.hash.as_slice(),
            "the published envelope must hash to the digest the desktop recomputes"
        );
    }

    /// Publication is idempotent: the same entry always builds the same event
    /// (same id), so a retry after a partial failure cannot duplicate a `seq`
    /// in the served window.
    #[test]
    fn publish_event_is_deterministic_for_one_entry() {
        let entry = sample_published_entry(3);
        let keys = nostr::Keys::generate();
        let first = build_audit_entry_event(&entry, &keys).expect("event");
        let second = build_audit_entry_event(&entry, &keys).expect("event");
        assert_eq!(first.id, second.id, "re-publish must dedupe by event id");
        assert_eq!(
            u32::from(first.kind.as_u16()),
            KIND_AUDIT_ENTRY,
            "published kind must be 48001"
        );
        assert_eq!(
            first.pubkey,
            keys.public_key(),
            "envelopes are signed by the relay's configured signer"
        );
        // Deterministic created_at: taken from the entry, not the wall clock.
        assert_eq!(
            first.created_at.as_secs(),
            entry.created_at.timestamp() as u64
        );
        // Content is the envelope.
        assert_eq!(first.content, audit_envelope_content(&entry).unwrap());

        // A different entry (different seq) must be a different event.
        let other = build_audit_entry_event(&sample_published_entry(4), &keys).expect("event");
        assert_ne!(first.id, other.id);
    }

    /// Oversized envelopes are refused at build time rather than published.
    #[test]
    fn oversized_envelope_is_refused() {
        let mut entry = sample_published_entry(5);
        entry.detail = serde_json::json!({ "pad": "x".repeat(AUDIT_ENVELOPE_MAX_BYTES) });
        let keys = nostr::Keys::generate();
        let err = build_audit_entry_event(&entry, &keys).expect_err("must refuse");
        assert!(
            err.to_string().contains("exceeds"),
            "unexpected error: {err}"
        );
    }

    // ── Failure paths that need a (deliberately broken) state ────────────────

    /// An [`AppState`] whose database is unreachable — every DB call fails with
    /// a connection error. Redis is also unreachable, but nothing under test
    /// reaches it (the failure fires before dispatch).
    ///
    /// The pool pins a short **`acquire_timeout`** (sqlx defaults to 30s): an
    /// unreachable server makes each acquire wait out that whole window, so a
    /// single publish attempt would outlive the 10s bound this state feeds and
    /// the cancellation test would fail on connect latency it was never meant
    /// to observe. This test's subject is *retry-then-cancel*, not how long a
    /// dead database takes to give up — bounding the attempt isolates that.
    async fn state_with_unreachable_db() -> Arc<AppState> {
        let mut config = crate::config::Config::from_env().expect("default config loads");
        config.database_url = "postgres://nobody:nothing@127.0.0.1:1/unreachable".into();
        config.redis_url = "redis://127.0.0.1:1".into();
        config.require_relay_membership = false;
        let pool = sqlx::postgres::PgPoolOptions::new()
            .acquire_timeout(Duration::from_millis(500))
            .connect_lazy(&config.database_url)
            .expect("lazy pg pool");
        let db = buzz_db::Db::from_pool(pool.clone());
        let redis_pool = deadpool_redis::Config::from_url(&config.redis_url)
            .create_pool(Some(deadpool_redis::Runtime::Tokio1))
            .expect("redis pool");
        let pubsub = Arc::new(
            buzz_pubsub::PubSubManager::new(&config.redis_url, redis_pool.clone())
                .await
                .expect("pubsub manager"),
        );
        let auth = buzz_auth::AuthService::new(config.auth.clone());
        let search = buzz_search::SearchService::new(pool.clone());
        let workflow_engine = Arc::new(buzz_workflow::WorkflowEngine::new(
            db.clone(),
            buzz_workflow::WorkflowConfig::default(),
        ));
        let media_storage = buzz_media::MediaStorage::new(&config.media).expect("media storage");
        let (state, _shutdown) = AppState::new(
            config,
            db,
            redis_pool,
            Some(buzz_audit::AuditService::new(pool)),
            pubsub,
            auth,
            search,
            workflow_engine,
            nostr::Keys::generate(),
            media_storage,
        );
        Arc::new(state)
    }

    /// Failure semantics of the publish step: an unreachable DB surfaces as a
    /// real error (never a swallowed success), and the retry wrapper keeps
    /// trying until shutdown cancels it — bounded, with the entry still
    /// durable in `audit_log` (the journal the retry replays from).
    #[tokio::test]
    async fn publish_failure_propagates_and_retries_until_shutdown() {
        let state = state_with_unreachable_db().await;
        let entry = sample_published_entry(9);

        // Direct call: the failure is observable, not logged-and-swallowed.
        assert!(
            publish_audit_entry(&state, &entry).await.is_err(),
            "an unreachable DB must surface as an error from the publish seam"
        );

        // Retry wrapper: cancel fires mid-retry and the call returns promptly
        // instead of spinning past shutdown.
        let cancel = tokio_util::sync::CancellationToken::new();
        let canceler = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            canceler.cancel();
        });
        let started = std::time::Instant::now();
        tokio::time::timeout(
            Duration::from_secs(10),
            crate::state::publish_audit_entry_with_retry(&state, &entry, &cancel),
        )
        .await
        .expect("publish retry must stop on shutdown cancellation, not spin forever");
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "shutdown must bound the publish retry loop"
        );
    }

    // ── End to end: produce → append → publish → serve (Postgres) ───────────

    /// A real state on the local Postgres/Redis (like the relay's existing
    /// audit tests). `None` when either is unreachable — the test then skips.
    async fn live_audit_state() -> Option<(
        Arc<AppState>,
        crate::state::AuditShutdownHandle,
        sqlx::PgPool,
    )> {
        let mut config = crate::config::Config::from_env().ok()?;
        config.redis_url = "redis://127.0.0.1:6379".to_string();
        config.require_relay_membership = false;
        let pool = sqlx::PgPool::connect(&config.database_url).await.ok()?;
        let redis_pool = deadpool_redis::Config::from_url(&config.redis_url)
            .create_pool(Some(deadpool_redis::Runtime::Tokio1))
            .ok()?;
        redis::cmd("PING")
            .query_async::<String>(&mut redis_pool.get().await.ok()?)
            .await
            .ok()?;
        let db = buzz_db::Db::from_pool(pool.clone());
        let pubsub = Arc::new(
            buzz_pubsub::PubSubManager::new(&config.redis_url, redis_pool.clone())
                .await
                .ok()?,
        );
        let auth = buzz_auth::AuthService::new(config.auth.clone());
        let search = buzz_search::SearchService::new(pool.clone());
        let workflow_engine = Arc::new(buzz_workflow::WorkflowEngine::new(
            db.clone(),
            buzz_workflow::WorkflowConfig::default(),
        ));
        let media_storage = buzz_media::MediaStorage::new(&config.media).ok()?;
        let (state, shutdown) = AppState::new(
            config,
            db,
            redis_pool,
            Some(buzz_audit::AuditService::new(pool.clone())),
            pubsub,
            auth,
            search,
            workflow_engine,
            nostr::Keys::generate(),
            media_storage,
        );
        Some((Arc::new(state), shutdown, pool))
    }

    /// The serve query exactly as the desktop issues it: `{kinds: [48001],
    /// limit: 200}` scoped to the community, channel-less.
    async fn serve_chain(state: &AppState, community: CommunityId) -> Vec<String> {
        let mut query = buzz_db::EventQuery::for_community(community);
        query.kinds = Some(vec![KIND_AUDIT_ENTRY as i32]);
        query.limit = Some(200);
        state
            .db
            .query_events(&query)
            .await
            .expect("serve kind:48001 query")
            .into_iter()
            .map(|stored| stored.event.content)
            .collect()
    }

    /// End-to-end produce → append → publish → serve through the *production*
    /// worker, then a no-recursion check on the served window.
    ///
    /// What it proves:
    /// 1. `record_audit` at a structural site lands in `audit_log` (seq 1, 2).
    /// 2. Each row is published as a kind:48001 event whose `content` is the
    ///    `AuditEntry` serde envelope.
    /// 3. The published contents alone — parsed the way the TS verifier parses
    ///    them — re-verify as a chain using `compute_hash` (the digest the TS
    ///    vectors pin; see `buzz-audit`'s `ts_pinned_vector_v1_matches_compute_hash`).
    /// 4. Serving through `{kinds:[48001], limit:200}` returns them.
    /// 5. No recursion: publishing never appends more audit rows — counts stay
    ///    at 2 across a settle window.
    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn produce_append_publish_and_serve_end_to_end() {
        let Some((state, shutdown, pool)) = live_audit_state().await else {
            eprintln!("skipping audit E2E: Postgres/Redis unavailable");
            return;
        };

        let community_uuid = uuid::Uuid::new_v4();
        let host = format!("audit-e2e-{}.example", community_uuid.simple());
        sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
            .bind(community_uuid)
            .bind(&host)
            .execute(&pool)
            .await
            .expect("seed community");
        let community = CommunityId::from_uuid(community_uuid);
        let tenant = TenantContext::resolved(community, host);
        let actor = Some(vec![0xab; 32]);

        record_audit(
            &state,
            AuditRecord::new(AuditSite::ChannelCreated, &tenant)
                .actor(actor.clone())
                .object_id(uuid::Uuid::new_v4().to_string())
                .detail(serde_json::json!({"event_id": "e2e-create"})),
        )
        .await;
        record_audit(
            &state,
            AuditRecord::new(AuditSite::ChannelDeleted, &tenant)
                .actor(actor.clone())
                .object_id(uuid::Uuid::new_v4().to_string())
                .detail(serde_json::json!({"event_id": "e2e-delete"})),
        )
        .await;

        // Poll the production worker through append + publish.
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        let contents = loop {
            let contents = serve_chain(&state, community).await;
            if contents.len() >= 2 {
                break contents;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "worker never published the audit entries (got {} envelope(s))",
                contents.len()
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        };

        // Parse the published envelopes exactly as `parseChainEntry` does
        // (serde round-trip of the content) and verify the chain the way the
        // desktop does: ascending seq, contiguous, prev_hash = recomputed hash
        // of the previous entry's published content.
        let mut entries: Vec<AuditEntry> = contents
            .iter()
            .map(|content| {
                serde_json::from_str::<AuditEntry>(content)
                    .expect("envelope content must parse with the AuditEntry shape")
            })
            .collect();
        entries.sort_by_key(|e| e.seq);
        assert_eq!(
            entries.iter().map(|e| e.seq).collect::<Vec<_>>(),
            vec![1, 2],
            "two structural records must publish as seq 1 and 2"
        );
        let mut previous: Option<Vec<u8>> = None;
        for entry in &entries {
            let recomputed = buzz_audit::compute_hash(entry).expect("recompute published digest");
            assert_eq!(
                recomputed.as_slice(),
                entry.hash.as_slice(),
                "published content must hash to the chain digest"
            );
            match &previous {
                None => assert!(entry.prev_hash.is_none(), "seq 1 is the genesis entry"),
                Some(prev) => assert_eq!(
                    entry.prev_hash.as_deref(),
                    Some(prev.as_slice()),
                    "published envelopes must chain prev_hash across seq"
                ),
            }
            previous = Some(entry.hash.clone());
        }

        // Chain integrity in the store, through the operator verifier.
        let audit = buzz_audit::AuditService::new(pool.clone());
        assert!(
            audit
                .verify_chain(community, 1, 2)
                .await
                .expect("verify stored chain"),
            "the stored chain must verify"
        );

        // No recursion: settle, then re-count. Publishing kind:48001 must not
        // have produced additional audit rows or additional envelopes.
        tokio::time::sleep(Duration::from_secs(1)).await;
        let audit_rows: i64 =
            sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE community_id = $1")
                .bind(community_uuid)
                .fetch_one(&pool)
                .await
                .expect("count audit rows");
        assert_eq!(
            audit_rows, 2,
            "publishing kind:48001 must not enqueue further audit rows \
             (the no-recursion fence failed)"
        );
        assert_eq!(
            serve_chain(&state, community).await.len(),
            2,
            "the served window must not grow from publication"
        );

        shutdown.drain(std::time::Duration::from_secs(5)).await;
    }

    /// Client submissions of kind:48001 are rejected at ingest — the relay is
    /// the single writer of the chain's projection, and a client-signed
    /// envelope could never chain-verify (it would show up as `malformed` in
    /// the desktop verifier).
    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn client_submitted_audit_entry_is_rejected_at_ingest() {
        let Some((state, shutdown, pool)) = live_audit_state().await else {
            eprintln!("skipping ingest rejection test: Postgres/Redis unavailable");
            return;
        };

        let community_uuid = uuid::Uuid::new_v4();
        let host = format!("audit-ingest-{}.example", community_uuid.simple());
        sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
            .bind(community_uuid)
            .bind(&host)
            .execute(&pool)
            .await
            .expect("seed community");
        let tenant = TenantContext::resolved(CommunityId::from_uuid(community_uuid), host);

        let client = nostr::Keys::generate();
        let entry = sample_published_entry(1);
        let forged = nostr::EventBuilder::new(
            Kind::Custom(KIND_AUDIT_ENTRY as u16),
            audit_envelope_content(&entry).expect("envelope"),
        )
        .sign_with_keys(&client)
        .expect("sign forged envelope");
        let auth = crate::handlers::ingest::IngestAuth::Nip42 {
            pubkey: client.public_key(),
            scopes: Vec::new(),
            channel_ids: None,
            conn_id: uuid::Uuid::new_v4(),
        };

        let result = crate::handlers::ingest::ingest_event(&state, &tenant, forged, auth).await;
        match result {
            Err(crate::handlers::ingest::IngestError::Rejected(reason)) => assert!(
                reason.contains("relay-authored"),
                "unexpected rejection reason: {reason}"
            ),
            Ok(_) => panic!("client-submitted kind:48001 must be rejected, but ingest accepted it"),
            Err(e) => panic!("client-submitted kind:48001 must be rejected, got error: {e:?}"),
        }

        // And nothing was stored.
        assert_eq!(
            serve_chain(&state, CommunityId::from_uuid(community_uuid))
                .await
                .len(),
            0,
            "a rejected envelope must not reach the store"
        );

        shutdown.drain(std::time::Duration::from_secs(5)).await;
    }
}
