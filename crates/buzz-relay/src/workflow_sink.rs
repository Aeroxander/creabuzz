//! Relay-side implementation of [`ActionSink`] for workflow actions.
//!
//! Builds Nostr events, persists them, and delegates post-persist side effects
//! (WebSocket fan-out, Redis pub/sub, search indexing, audit logging) to the
//! existing [`dispatch_persistent_event`] helper.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Weak};

use buzz_core::kind::{KIND_STREAM_MESSAGE, KIND_WORKFLOW_APPROVAL_REQUESTED};
use buzz_core::tenant::CommunityId;
use buzz_workflow::action_sink::{ActionSink, ActionSinkError};
use chrono::Utc;
use nostr::{EventBuilder, Kind, Tag};
use tracing::info;
use uuid::Uuid;

use crate::handlers::event::dispatch_persistent_event;
use crate::state::AppState;

/// Resolves `@Name` mentions in workflow message text to the pubkeys of the
/// channel members they name, so the emitted kind:9 carries the `p` tags that
/// ACP agent-wake (`event_mentions_agent`) is gated on.
///
/// The client resolves mentions to `p` tags at compose time from an interactive
/// autocomplete pick; the workflow path has only free text, so this reverse-parse
/// *defines* the matching contract. It is deliberately conservative to avoid
/// waking the wrong agent:
///
/// - **Members only.** Candidates are the destination channel's members; global
///   users are never matched.
/// - **Exact display name.** No substring, prefix, or fuzzy matching. Names may
///   contain spaces/punctuation (`"Will Pfleger"`, `"Lep (Subagent)"`), so the
///   match is anchored on `@` and terminated by a non-name boundary rather than
///   whitespace.
/// - **Greedy-longest, non-overlapping.** Longer names are matched first and
///   consume their span, so `@Will Pfleger` binds *Pfleger* and a bare `@Will`
///   does not match the member `"Will Pfleger"`.
/// - **Ambiguous names wake no one.** If two or more members share the matched
///   display name, no `p` tag is emitted for it — arbitrary selection would
///   silently misroute and tagging all of them is a false-wake firehose.
///
/// Returns deduplicated pubkey hexes, in first-appearance order in `text`.
fn resolve_mention_pubkeys(text: &str, members: &[(String, String)]) -> Vec<String> {
    // Name → pubkey, folding case (client matches case-insensitively). A name
    // that maps to more than one distinct pubkey is ambiguous → wake no one.
    let mut by_name: std::collections::HashMap<String, Option<String>> =
        std::collections::HashMap::new();
    for (name, pubkey) in members {
        if name.trim().is_empty() {
            continue;
        }
        by_name
            .entry(name.to_lowercase())
            .and_modify(|slot| {
                if slot.as_deref() != Some(pubkey.as_str()) {
                    *slot = None; // ambiguous
                }
            })
            .or_insert_with(|| Some(pubkey.clone()));
    }

    // Match longest names first so a longer name consumes its span before a
    // shorter substring name can claim part of it.
    let mut names: Vec<&(String, String)> = members.iter().collect();
    names.sort_by_key(|(name, _)| std::cmp::Reverse(name.chars().count()));

    let chars: Vec<char> = text.chars().collect();
    let mut consumed = vec![false; chars.len()];

    // Case-insensitivity folds *both* sides through `char::to_lowercase`, which
    // can change length: `İ` (U+0130) lowercases to two code points (`i` +
    // U+0307 combining dot). Comparing a pre-lowercased copy of the whole text
    // against a lowercased name by index silently desyncs once any earlier char
    // expands. Instead, fold on the fly: walk the original `chars` at the
    // candidate `@`, folding each char, and match against the folded-name char
    // stream — tracking how many *original* chars were consumed so
    // boundary/`consumed` accounting stays in original coordinates. `None` = no
    // match; `Some(n)` = matched, consuming `n` original chars after the `@`.
    let match_name_len = |start: usize, folded_name: &[char]| -> Option<usize> {
        let mut ci = start;
        let mut ni = 0;
        while ni < folded_name.len() {
            let c = *chars.get(ci)?;
            for fc in c.to_lowercase() {
                if folded_name.get(ni) != Some(&fc) {
                    return None;
                }
                ni += 1;
            }
            ci += 1;
        }
        Some(ci - start)
    };

    // A mention is anchored on `@` at a left boundary (start / whitespace / `(`)
    // and the matched name must not be followed by a name-continuation char —
    // otherwise `@Will` would match inside `@Willow`. Combined with matching the
    // longest member name first, this is the whole rule: no punctuation allowlist
    // to get wrong, and it is unicode-safe (em-dash, emoji all terminate a name).
    let is_left_boundary = |i: usize| i == 0 || chars[i - 1].is_whitespace() || chars[i - 1] == '(';
    let extends_name = |c: char| c.is_alphanumeric() || c == '_';

    let mut out: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut hits: Vec<(usize, String)> = Vec::new();

    for (name, _) in &names {
        let folded_name: Vec<char> = name.to_lowercase().chars().collect();
        if folded_name.is_empty() {
            continue;
        }
        let mut at = 0;
        while at < chars.len() {
            // Anchor on `@` at a left boundary and an unconsumed span; only then
            // attempt the fold-match. `name_len` is measured in *original* chars,
            // so `at + 1 + name_len` is the true position just past the name.
            let name_len = (chars[at] == '@' && is_left_boundary(at) && !consumed[at])
                .then(|| match_name_len(at + 1, &folded_name))
                .flatten()
                .filter(|&n| {
                    chars[at + 1 + n..]
                        .first()
                        .is_none_or(|&c| !extends_name(c))
                });
            if let Some(name_len) = name_len {
                let span = 1 + name_len;
                if let Some(Some(pubkey)) = by_name.get(&name.to_lowercase()) {
                    hits.push((at, pubkey.clone()));
                }
                for slot in consumed.iter_mut().skip(at).take(span) {
                    *slot = true;
                }
                at += span;
            } else {
                at += 1;
            }
        }
    }

    hits.sort_by_key(|(at, _)| *at);
    for (_, pubkey) in hits {
        if seen.insert(pubkey.clone()) {
            out.push(pubkey);
        }
    }
    out
}

/// Append legacy routing tags from rendered output and authority-bearing tags
/// only for targets also named in the workflow owner's stored step template.
fn append_workflow_mention_tags(
    tags: &mut Vec<Tag>,
    rendered_text: &str,
    authored_text: &str,
    members: &[(String, String)],
    author_pubkey_hex: &str,
) -> Result<(), ActionSinkError> {
    let rendered_mentions = resolve_mention_pubkeys(rendered_text, members);
    let authored_mentions: std::collections::HashSet<String> =
        resolve_mention_pubkeys(authored_text, members)
            .into_iter()
            .collect();

    for mentioned in rendered_mentions {
        if mentioned != author_pubkey_hex {
            tags.push(
                Tag::parse(["p", &mentioned])
                    .map_err(|e| ActionSinkError::EventBuild(format!("mention p tag: {e}")))?,
            );
        }
        if authored_mentions.contains(&mentioned) {
            tags.push(
                Tag::parse(["buzz:workflow-mention", &mentioned]).map_err(|e| {
                    ActionSinkError::EventBuild(format!("workflow mention tag: {e}"))
                })?,
            );
        }
    }
    Ok(())
}

/// Relay-side action sink — executes workflow side-effects directly.
///
/// Holds a **weak** reference to `AppState` to avoid an `Arc` reference cycle:
/// `AppState` → `WorkflowEngine` → `ActionSink` → `AppState`. Using `Weak`
/// breaks the cycle so all structs can be dropped on shutdown.
///
/// Post-persist side effects are delegated to [`dispatch_persistent_event`]
/// for consistency with the REST/WebSocket paths.
pub struct RelayActionSink {
    state: Weak<AppState>,
}

impl RelayActionSink {
    /// Create a new `RelayActionSink` from the shared application state.
    pub fn new(state: &Arc<AppState>) -> Self {
        Self {
            state: Arc::downgrade(state),
        }
    }
}

impl ActionSink for RelayActionSink {
    fn send_message(
        &self,
        community_id: CommunityId,
        channel_id: &str,
        text: &str,
        authored_text: &str,
        author_pubkey: &str,
        reply_to: Option<&str>,
    ) -> Pin<Box<dyn Future<Output = Result<String, ActionSinkError>> + Send + '_>> {
        let channel_id = channel_id.to_owned();
        let text = text.to_owned();
        let authored_text = authored_text.to_owned();
        let author_pubkey = author_pubkey.to_owned();
        let reply_to = reply_to.map(str::to_owned);

        Box::pin(async move {
            // 0. Upgrade weak reference — fails only during shutdown.
            let state = self
                .state
                .upgrade()
                .ok_or_else(|| ActionSinkError::Database("relay is shutting down".into()))?;

            // The run carries its owning community (`community_id`); the
            // relay-signed kind:9 message belongs to *that* community, never the
            // deployment default. Re-deriving the tenant from `config.relay_url`
            // would post a community-B workflow's output into the deployment/
            // default community under N>1. Read the community's host back to
            // form a complete TenantContext (host is for labelling only — the
            // community is already fixed and is never re-derived from it). Fail
            // closed if the community no longer maps to a host.
            let host = state
                .db
                .lookup_community_host(community_id)
                .await
                .map_err(|e| ActionSinkError::Database(e.to_string()))?
                .ok_or_else(|| {
                    ActionSinkError::Database(format!(
                        "workflow run community {community_id} is not mapped to a host"
                    ))
                })?;
            let tenant = buzz_core::tenant::TenantContext::resolved(community_id, host);

            // 1. Validate content is not empty/whitespace-only
            if text.trim().is_empty() {
                return Err(ActionSinkError::EmptyContent);
            }

            // 2. Parse and validate channel — canonicalize UUID immediately
            let channel_uuid = Uuid::parse_str(&channel_id)
                .map_err(|e| ActionSinkError::InvalidInput(format!("invalid UUID: {e}")))?;
            let channel_id_canonical = channel_uuid.to_string();

            let channel = state
                .db
                .get_channel_for_event_write(tenant.community(), channel_uuid)
                .await
                .map_err(|e| match &e {
                    buzz_db::DbError::ChannelNotFound(_) | buzz_db::DbError::NotFound(_) => {
                        ActionSinkError::ChannelNotFound(channel_id_canonical.clone())
                    }
                    _ => ActionSinkError::Database(e.to_string()),
                })?;

            if channel.archived_at.is_some() {
                return Err(ActionSinkError::ChannelArchived(
                    channel_id_canonical.clone(),
                ));
            }

            let author_pubkey = nostr::PublicKey::from_hex(&author_pubkey).map_err(|e| {
                ActionSinkError::InvalidInput(format!("invalid author pubkey: {e}"))
            })?;
            let author_pubkey_bytes = author_pubkey.to_bytes().to_vec();
            let author_pubkey_hex = author_pubkey.to_hex();
            let is_member = state
                .is_member_cached(tenant.community(), channel_uuid, &author_pubkey_bytes)
                .await
                .map_err(|e| ActionSinkError::Database(e.to_string()))?;
            if !is_member && channel.visibility != "open" {
                return Err(ActionSinkError::InvalidInput(
                    "workflow owner does not have access to destination channel".into(),
                ));
            }

            // 3. Build kind:9 Nostr event
            //    - Signed by relay keypair (event.pubkey = relay pubkey)
            //    - `p` tag attributes the message to the workflow owner
            //    - `h` tag scopes to the channel (NIP-29, canonical UUID)
            //    - `buzz:workflow` tag prevents recursive workflow triggering
            //    - `buzz:workflow-owner` lets harnesses apply the owner's
            //      inbound-author policy after verifying the relay signature
            //    - one `p` tag for every resolved mention in the rendered output,
            //      preserving legacy wake/feed behavior
            //    - one `buzz:workflow-mention` tag only when the same target was
            //      named in the workflow owner's stored step template. This is the
            //      authority-bearing provenance used by ACP; trigger-controlled
            //      template substitutions cannot create it.
            let mut tags = vec![
                Tag::parse(["p", &author_pubkey_hex])
                    .map_err(|e| ActionSinkError::EventBuild(format!("p tag: {e}")))?,
                Tag::parse(["h", &channel_id_canonical])
                    .map_err(|e| ActionSinkError::EventBuild(format!("h tag: {e}")))?,
                Tag::parse(["buzz:workflow", "true"])
                    .map_err(|e| ActionSinkError::EventBuild(format!("workflow tag: {e}")))?,
                Tag::parse(["buzz:workflow-owner", &author_pubkey_hex])
                    .map_err(|e| ActionSinkError::EventBuild(format!("workflow owner tag: {e}")))?,
            ];

            // Resolve thread ancestry when this is a threaded reply, so the
            // built event carries NIP-10 `root`/`reply` e-tags and persists real
            // thread metadata (matching the ingest path) instead of top-level.
            let reply_ancestry = match reply_to.as_deref() {
                Some(parent_hex) => Some(
                    crate::handlers::ingest::resolve_relay_reply_thread_meta(
                        tenant.community(),
                        parent_hex,
                        channel_uuid,
                        &state,
                    )
                    .await
                    .map_err(ActionSinkError::InvalidInput)?,
                ),
                None => None,
            };

            // NIP-10 e-tags for the thread. Marked `root`/`reply` so clients and
            // the ingest resolver read the ancestry the same way. A direct reply
            // (parent == root) emits a single `reply` tag; a nested reply emits
            // the `root` + `reply` pair — matching `buzz_sdk::builders::thread_tags`
            // so every writer produces one wire shape per reply kind.
            if let Some(ancestry) = &reply_ancestry {
                let root_hex = ancestry.root_hex();
                let parent_hex = ancestry.parent_hex();
                if root_hex == parent_hex {
                    tags.push(
                        Tag::parse(["e", &root_hex, "", "reply"]).map_err(|e| {
                            ActionSinkError::EventBuild(format!("reply e tag: {e}"))
                        })?,
                    );
                } else {
                    tags.push(
                        Tag::parse(["e", &root_hex, "", "root"])
                            .map_err(|e| ActionSinkError::EventBuild(format!("root e tag: {e}")))?,
                    );
                    tags.push(
                        Tag::parse(["e", &parent_hex, "", "reply"]).map_err(|e| {
                            ActionSinkError::EventBuild(format!("reply e tag: {e}"))
                        })?,
                    );
                }
            }

            // Resolve `@Name` mentions to channel-member pubkeys. The rendered
            // text supplies the legacy `p` tags used by subscriptions and feeds.
            // The stored author-written template independently supplies the
            // authority-bearing workflow-mention tags. A trigger may therefore
            // render an `@Name` into visible output, but it cannot borrow the
            // workflow owner's authority to wake that agent. A resolution failure
            // must not drop the message, so log and proceed with the base tags.
            let members = state
                .db
                .get_members_for_event_write(tenant.community(), channel_uuid)
                .await
                .map_err(|e| ActionSinkError::Database(e.to_string()))?;
            let member_pubkeys: Vec<Vec<u8>> = members.iter().map(|m| m.pubkey.clone()).collect();
            let users = state
                .db
                .get_users_bulk_for_event_write(tenant.community(), &member_pubkeys)
                .await
                .map_err(|e| ActionSinkError::Database(e.to_string()))?;
            let named_members: Vec<(String, String)> = users
                .into_iter()
                .filter_map(|u| {
                    let name = u.display_name?;
                    Some((name, nostr::PublicKey::from_slice(&u.pubkey).ok()?.to_hex()))
                })
                .collect();
            append_workflow_mention_tags(
                &mut tags,
                &text,
                &authored_text,
                &named_members,
                &author_pubkey_hex,
            )?;

            let kind = Kind::from(KIND_STREAM_MESSAGE as u16);
            let event = EventBuilder::new(kind, &text)
                .tags(tags)
                .sign_with_keys(&state.relay_keypair)
                .map_err(|e| ActionSinkError::EventBuild(format!("signing: {e}")))?;

            let event_id_hex = event.id.to_hex();
            let event_id_bytes = event.id.as_bytes().to_vec();
            let kind_u32 = KIND_STREAM_MESSAGE;

            let event_created_at = {
                let ts = event.created_at.as_secs() as i64;
                chrono::DateTime::from_timestamp(ts, 0).unwrap_or_else(Utc::now)
            };

            info!(
                event_id = %event_id_hex,
                channel_id = %channel_id_canonical,
                author = %author_pubkey,
                "Workflow SendMessage: posting kind {kind_u32} event"
            );

            // 4. Persist event with thread metadata (matches REST handler path).
            //    Threaded replies persist the resolved parent/root/depth; a
            //    non-reply workflow message stays top-level (depth=0, no parent).
            let thread_meta_owned = reply_ancestry.map(|ancestry| {
                ancestry.into_thread_meta(event_id_bytes.clone(), event_created_at, channel_uuid)
            });
            let thread_meta = Some(match &thread_meta_owned {
                Some(owned) => owned.as_params(),
                None => buzz_db::event::ThreadMetadataParams {
                    event_id: &event_id_bytes,
                    event_created_at,
                    channel_id: channel_uuid,
                    parent_event_id: None,
                    parent_event_created_at: None,
                    root_event_id: None,
                    root_event_created_at: None,
                    depth: 0,
                    broadcast: false,
                },
            });

            let (stored_event, was_inserted) = state
                .db
                .insert_event_with_thread_metadata(
                    tenant.community(),
                    &event,
                    Some(channel_uuid),
                    thread_meta,
                )
                .await
                .map_err(|e| ActionSinkError::Database(e.to_string()))?;

            // 5. Post-persist side effects (fan-out, search, audit)
            //    Only if actually inserted (idempotency guard).
            if was_inserted {
                let _ = dispatch_persistent_event(
                    &tenant,
                    &state,
                    &stored_event,
                    kind_u32,
                    &author_pubkey_hex,
                    None,
                )
                .await;

                // A threaded reply changed its thread's counters — push a fresh
                // relay-signed kind:39005 so subscribed clients update badge
                // counts without refetching the head window, exactly as the
                // ingest path does after a reply insert. Fan-out-only and
                // best-effort; skipped for top-level (non-reply) messages.
                if let Some(owned) = &thread_meta_owned {
                    crate::handlers::side_effects::emit_live_thread_summary(
                        &tenant,
                        &state,
                        channel_uuid,
                        owned.root_event_id.clone(),
                    );
                }
            }

            Ok(event_id_hex)
        })
    }

    fn emit_approval_request(
        &self,
        community_id: CommunityId,
        channel_id: &str,
        token_hash_hex: &str,
        approver_spec: &str,
        message: &str,
        author_pubkey: &str,
    ) -> Pin<Box<dyn Future<Output = Result<String, ActionSinkError>> + Send + '_>> {
        let channel_id = channel_id.to_owned();
        let token_hash_hex = token_hash_hex.to_owned();
        let approver_spec = approver_spec.to_owned();
        let message = message.to_owned();
        let author_pubkey = author_pubkey.to_owned();

        Box::pin(async move {
            let state = self
                .state
                .upgrade()
                .ok_or_else(|| ActionSinkError::Database("relay is shutting down".into()))?;

            // Same community contract as send_message: the run's community,
            // never re-derived. Fail closed if unmapped.
            let host = state
                .db
                .lookup_community_host(community_id)
                .await
                .map_err(|e| ActionSinkError::Database(e.to_string()))?
                .ok_or_else(|| {
                    ActionSinkError::Database(format!(
                        "workflow run community {community_id} is not mapped to a host"
                    ))
                })?;
            let tenant = buzz_core::tenant::TenantContext::resolved(community_id, host);

            // Channel must exist and not be archived — an approval nobody can
            // read is worse than no notification (it hides the recovery path).
            let channel_uuid = Uuid::parse_str(&channel_id)
                .map_err(|e| ActionSinkError::InvalidInput(format!("invalid UUID: {e}")))?;
            let channel_id_canonical = channel_uuid.to_string();
            let channel = state
                .db
                .get_channel_for_event_write(tenant.community(), channel_uuid)
                .await
                .map_err(|e| match &e {
                    buzz_db::DbError::ChannelNotFound(_) | buzz_db::DbError::NotFound(_) => {
                        ActionSinkError::ChannelNotFound(channel_id_canonical.clone())
                    }
                    _ => ActionSinkError::Database(e.to_string()),
                })?;
            if channel.archived_at.is_some() {
                return Err(ActionSinkError::ChannelArchived(
                    channel_id_canonical.clone(),
                ));
            }

            let author_pubkey = nostr::PublicKey::from_hex(&author_pubkey).map_err(|e| {
                ActionSinkError::InvalidInput(format!("invalid author pubkey: {e}"))
            })?;
            let author_pubkey_bytes = author_pubkey.to_bytes().to_vec();
            let author_pubkey_hex = author_pubkey.to_hex();
            let is_member = state
                .is_member_cached(tenant.community(), channel_uuid, &author_pubkey_bytes)
                .await
                .map_err(|e| ActionSinkError::Database(e.to_string()))?;
            if !is_member && channel.visibility != "open" {
                return Err(ActionSinkError::InvalidInput(
                    "workflow owner does not have access to destination channel".into(),
                ));
            }

            if token_hash_hex.trim().is_empty() {
                return Err(ActionSinkError::InvalidInput(
                    "approval token hash must not be empty".into(),
                ));
            }

            // Content is definition-rendered (from/message templates), never
            // raw trigger text. An empty message falls back rather than
            // failing — suspension is already persisted; emission is best
            // effort and must not fail on cosmetic input.
            let text = if message.trim().is_empty() {
                format!("Approval requested (from {approver_spec})")
            } else {
                message
            };

            // kind:46010 tags: `h` scopes to the channel (membership-gated
            // reads), `d` carries the token hash (the value grant/deny look
            // up), `p` attributes the workflow owner, `buzz:workflow`
            // excludes the event from re-triggering workflows.
            let tags = vec![
                Tag::parse(["h", &channel_id_canonical])
                    .map_err(|e| ActionSinkError::EventBuild(format!("h tag: {e}")))?,
                Tag::parse(["d", &token_hash_hex])
                    .map_err(|e| ActionSinkError::EventBuild(format!("d tag: {e}")))?,
                Tag::parse(["p", &author_pubkey_hex])
                    .map_err(|e| ActionSinkError::EventBuild(format!("p tag: {e}")))?,
                Tag::parse(["buzz:workflow", "true"])
                    .map_err(|e| ActionSinkError::EventBuild(format!("workflow tag: {e}")))?,
                Tag::parse(["buzz:workflow-owner", &author_pubkey_hex])
                    .map_err(|e| ActionSinkError::EventBuild(format!("workflow owner tag: {e}")))?,
            ];

            let kind = Kind::from(KIND_WORKFLOW_APPROVAL_REQUESTED as u16);
            let event = EventBuilder::new(kind, &text)
                .tags(tags)
                .sign_with_keys(&state.relay_keypair)
                .map_err(|e| ActionSinkError::EventBuild(format!("signing: {e}")))?;

            let event_id_hex = event.id.to_hex();
            let event_id_bytes = event.id.as_bytes().to_vec();
            let kind_u32 = KIND_WORKFLOW_APPROVAL_REQUESTED;

            let event_created_at = {
                let ts = event.created_at.as_secs() as i64;
                chrono::DateTime::from_timestamp(ts, 0).unwrap_or_else(Utc::now)
            };

            info!(
                event_id = %event_id_hex,
                channel_id = %channel_id_canonical,
                author = %author_pubkey,
                "Workflow approval requested: emitting kind 46010 event"
            );

            let thread_meta = Some(buzz_db::event::ThreadMetadataParams {
                event_id: &event_id_bytes,
                event_created_at,
                channel_id: channel_uuid,
                parent_event_id: None,
                parent_event_created_at: None,
                root_event_id: None,
                root_event_created_at: None,
                depth: 0,
                broadcast: false,
            });

            let (stored_event, was_inserted) = state
                .db
                .insert_event_with_thread_metadata(
                    tenant.community(),
                    &event,
                    Some(channel_uuid),
                    thread_meta,
                )
                .await
                .map_err(|e| ActionSinkError::Database(e.to_string()))?;

            if was_inserted {
                let _ = dispatch_persistent_event(
                    &tenant,
                    &state,
                    &stored_event,
                    kind_u32,
                    &author_pubkey_hex,
                    None,
                )
                .await;
            }

            Ok(event_id_hex)
        })
    }

    fn distill_agent_wiki(
        &self,
        community_id: CommunityId,
        space: &str,
    ) -> Pin<Box<dyn Future<Output = Result<serde_json::Value, ActionSinkError>> + Send + '_>> {
        let space = space.to_owned();

        Box::pin(async move {
            // 0. Upgrade weak reference — fails only during shutdown.
            let state = self
                .state
                .upgrade()
                .ok_or_else(|| ActionSinkError::Database("relay is shutting down".into()))?;

            // Fail closed when the classifier endpoint is unconfigured: a
            // scheduled maintenance run must leave a visible run-status error,
            // never silently skip (Review-Proven Rule 1). Same
            // `BUZZ_CLASSIFIER_*` env/config as `org classify` and
            // `buzz agwiki distill`.
            let target = classifier_target()?;

            // Same community scoping contract as `send_message`: the run
            // carries its owning community; read its host back only to form a
            // complete TenantContext (labelling), never to re-derive the
            // community from the deployment default.
            let host = state
                .db
                .lookup_community_host(community_id)
                .await
                .map_err(|e| ActionSinkError::Database(e.to_string()))?
                .ok_or_else(|| {
                    ActionSinkError::Database(format!(
                        "workflow run community {community_id} is not mapped to a host"
                    ))
                })?;
            let tenant = buzz_core::tenant::TenantContext::resolved(community_id, host);

            info!(community = %community_id, space = %space, "DistillAgentWiki: running the distill loop");
            let ports = RelayDistillPorts {
                state: &state,
                tenant: &tenant,
                target: &target,
            };
            let outcome = buzz_agwiki::run::run_distill(
                &ports,
                &buzz_agwiki::run::DistillOptions {
                    space: &space,
                    limit: None,
                    publish: true,
                    system_prompt: None,
                },
                &|msg| tracing::warn!(target: "agwiki", "{msg}"),
            )
            .await
            .map_err(|e| match e {
                buzz_agwiki::run::DistillError::Failed(m) => ActionSinkError::Distill(m),
                buzz_agwiki::run::DistillError::Port(e) => e,
            })?;
            Ok(distill_outcome_json(&outcome))
        })
    }

    fn run_org_diag(
        &self,
        community_id: CommunityId,
    ) -> Pin<Box<dyn Future<Output = Result<serde_json::Value, ActionSinkError>> + Send + '_>> {
        Box::pin(async move {
            // 0. Upgrade weak reference — fails only during shutdown.
            let state = self
                .state
                .upgrade()
                .ok_or_else(|| ActionSinkError::Database("relay is shutting down".into()))?;

            // Community-scoped bounded read of the coordination plane — the
            // same kinds `buzz diag` scans. The lookback is a stated default
            // (7 days, cap 5000 events), never a claim about the window.
            let now = chrono::Utc::now().timestamp().max(0) as u64;
            let since = now.saturating_sub(DIAG_LOOKBACK_S);
            let query = buzz_db::EventQuery {
                kinds: Some(DIAG_KINDS.iter().map(|&k| i32::from(k as u16)).collect()),
                since: chrono::DateTime::from_timestamp(since as i64, 0),
                limit: Some(DIAG_EVENT_CAP),
                ..buzz_db::EventQuery::for_community(community_id)
            };
            let rows = state
                .db
                .query_events(&query)
                .await
                .map_err(|e| ActionSinkError::Database(e.to_string()))?;
            // Open channels only: the diag reads actor + timing metadata of
            // chat and task events, and this job has no viewer to authorize
            // against. Events with no channel (org records) stay in.
            let readable: std::collections::HashSet<uuid::Uuid> =
                readable_channel_ids(&state.db, community_id)
                    .await?
                    .into_iter()
                    .collect();
            let events: Vec<nostr::Event> = rows
                .into_iter()
                .map(|row| row.event)
                .filter(|event| event_in_readable_channel(event, &readable))
                .collect();

            let report = buzz_core::org_diag::diagnose(&diag_events_from_nostr(&events));
            serde_json::to_value(&report).map_err(|e| ActionSinkError::EventBuild(e.to_string()))
        })
    }
}

// ── Org diagnostic (`run_org_diag`) — OA.md Phase 4 ────────────────────────

/// Whether a relay-run job (it has no viewer, so per-member access cannot be
/// re-checked) may read a channel: only open, live, non-DM channels.
///
/// The distill and diag jobs publish or summarize community-wide, so anything
/// they read must already be readable by every member.
fn is_distill_readable(
    visibility: &str,
    channel_type: &str,
    archived: bool,
    deleted: bool,
) -> bool {
    visibility == "open" && channel_type != "dm" && !archived && !deleted
}

/// Ids of the channels a relay-run job may read (see [`is_distill_readable`]).
async fn readable_channel_ids(
    db: &buzz_db::Db,
    community: CommunityId,
) -> Result<Vec<uuid::Uuid>, ActionSinkError> {
    let channels = db
        .list_channels(community, Some("open"))
        .await
        .map_err(|e| ActionSinkError::Database(e.to_string()))?;
    Ok(channels
        .iter()
        .filter(|c| {
            is_distill_readable(
                &c.visibility,
                &c.channel_type,
                c.archived_at.is_some(),
                c.deleted_at.is_some(),
            )
        })
        .map(|c| c.id)
        .collect())
}

/// Whether an event may feed a relay-run job: channel-less events (org
/// records) pass; channel-scoped ones only when their `h` channel is readable.
/// An `h` tag that is not a UUID fails closed.
fn event_in_readable_channel(
    event: &nostr::Event,
    readable: &std::collections::HashSet<uuid::Uuid>,
) -> bool {
    let h = event.tags.iter().find_map(|tag| {
        let parts = tag.as_slice();
        (parts.first().map(String::as_str) == Some("h")).then(|| parts.get(1).cloned())
    });
    match h {
        None => true,
        Some(value) => value
            .and_then(|v| uuid::Uuid::parse_str(&v).ok())
            .is_some_and(|id| readable.contains(&id)),
    }
}

/// The kinds the instrument reasons over (the coordination plane) — the same
/// list `buzz diag` scans, so the CLI and the scheduled run never disagree.
pub(crate) const DIAG_KINDS: [u32; 10] = [
    47004, 47005, 37013, 37011, 46010, 44001, 44002, 5, 44011, 40002,
];
/// Stated lookback default: one week.
pub(crate) const DIAG_LOOKBACK_S: u64 = 7 * 24 * 3600;
/// Stated scan cap.
pub(crate) const DIAG_EVENT_CAP: i64 = 5_000;

/// Map wire events to instrument rows — conservative: unparseable rows drop,
/// unknown kinds classify as `Other`, the `kind` tag refines receipt/grant
/// tables, `d` is the acted-on coordinate. Never guessed at.
pub(crate) fn diag_events_from_nostr(
    events: &[nostr::Event],
) -> Vec<buzz_core::org_diag::DiagEvent> {
    events
        .iter()
        .map(|event| {
            let table = buzz_agwiki::tag_values(event, "kind");
            let d = buzz_agwiki::tag_values(event, "d");
            buzz_core::org_diag::DiagEvent {
                id: event.id.to_hex(),
                actor: event.pubkey.to_hex(),
                at: event.created_at.as_secs(),
                class: buzz_core::org_diag::class_of_kind(
                    u32::from(event.kind.as_u16()),
                    table.first().map(String::as_str),
                ),
                coordinate: d.first().map(|d| d.to_string()),
            }
        })
        .collect()
}

#[cfg(test)]
mod run_org_diag_tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind, Tag};

    fn event(kind: u32, tags: Vec<Tag>) -> nostr::Event {
        EventBuilder::new(Kind::Custom(kind as u16), "{}")
            .tags(tags)
            .sign_with_keys(&Keys::generate())
            .expect("event")
    }

    #[test]
    fn mapping_is_conservative_and_reads_tables_and_coordinates() {
        let events = vec![
            event(47004, vec![]),
            event(47005, vec![Tag::parse(["kind", "vote"]).expect("tag")]),
            event(47005, vec![Tag::parse(["kind", "execute"]).expect("tag")]),
            event(37011, vec![Tag::parse(["kind", "revoke"]).expect("tag")]),
            event(44002, vec![Tag::parse(["d", "default/diag"]).expect("tag")]),
            event(12_345, vec![]),
        ];
        let rows = diag_events_from_nostr(&events);
        assert_eq!(rows.len(), 6);
        use buzz_core::org_diag::DiagClass;
        assert_eq!(rows[0].class, DiagClass::Proposal);
        assert_eq!(rows[1].class, DiagClass::Vote);
        assert_eq!(rows[2].class, DiagClass::Execute);
        assert_eq!(rows[3].class, DiagClass::Revoke);
        assert_eq!(rows[4].class, DiagClass::Revision);
        assert_eq!(rows[4].coordinate.as_deref(), Some("default/diag"));
        assert_eq!(rows[5].class, DiagClass::Other, "unknown kind → Other");
    }

    #[test]
    fn the_step_output_is_the_report_json() {
        let mut events = Vec::new();
        for i in 0..25 {
            events.push(event(40002, vec![]));
            let _ = i;
        }
        let report = buzz_core::org_diag::diagnose(&diag_events_from_nostr(&events));
        let value = serde_json::to_value(&report).expect("serializable");
        assert_eq!(
            value
                .get("wefModes")
                .and_then(|m| m.as_array())
                .map(Vec::len),
            Some(5),
            "the five WEF modes travel in the step output"
        );
        assert!(value.get("events").is_some());
    }
}

// ── Agent Wiki self-maintenance (`distill_agent_wiki`) ─────────────────────

/// Resolve the classifier endpoint through a provider (injectable for tests).
/// Fail closed — an unconfigured deployment surfaces a visible run-status
/// error instead of silently skipping a scheduled maintenance run.
fn classifier_target_from(
    get: impl Fn(&str) -> Option<String>,
) -> Result<buzz_agwiki::llm::LlmTarget, ActionSinkError> {
    buzz_agwiki::llm::classifier_target_from_provider(get).map_err(ActionSinkError::Distill)
}

/// Resolve the classifier endpoint from the shared `BUZZ_CLASSIFIER_*` env
/// (same config as `org classify` / `buzz agwiki distill`).
fn classifier_target() -> Result<buzz_agwiki::llm::LlmTarget, ActionSinkError> {
    classifier_target_from(|name| std::env::var(name).ok().filter(|v| !v.is_empty()))
}

/// Sign a composed Agent Wiki page and enforce the relay's kind:44002
/// envelope before the internal publish — the same
/// [`validate_agent_wiki_envelope`] bounds a client-side publish must satisfy
/// (malformed pages must never win read-side LWW against a valid head). This
/// is the production publish path's validation seam: `RelayDistillPorts::
/// publish` signs and validates through exactly this function.
fn sign_and_validate_agent_wiki_page(
    keys: &nostr::Keys,
    builder: EventBuilder,
) -> Result<nostr::Event, ActionSinkError> {
    let event = builder
        .sign_with_keys(keys)
        .map_err(|e| ActionSinkError::EventBuild(format!("signing: {e}")))?;
    crate::handlers::ingest::validate_agent_wiki_envelope(&event)
        .map_err(ActionSinkError::Distill)?;
    Ok(event)
}

/// Relay-side ports for the shared `buzz-agwiki` distill core: bounded reads
/// from the relay's own store, NIP-50 reflection search via Postgres FTS, the
/// shared classifier LLM transport, and the internal relay-signed publish.
struct RelayDistillPorts<'a> {
    state: &'a Arc<AppState>,
    tenant: &'a buzz_core::tenant::TenantContext,
    target: &'a buzz_agwiki::llm::LlmTarget,
}

impl buzz_agwiki::run::DistillPorts for RelayDistillPorts<'_> {
    type Error = ActionSinkError;

    fn fetch_kind_events(
        &self,
        kind: u32,
        since: u64,
        bound: u32,
    ) -> buzz_agwiki::run::PortFut<'_, Vec<nostr::Event>, Self::Error> {
        let query = buzz_db::EventQuery {
            kinds: Some(vec![kind as i32]),
            since: (since > 0)
                .then(|| chrono::DateTime::from_timestamp(since as i64, 0))
                .flatten(),
            limit: Some(i64::from(bound)),
            ..buzz_db::EventQuery::for_community(self.tenant.community())
        };
        Box::pin(async move {
            let rows = self
                .state
                .db
                .query_events(&query)
                .await
                .map_err(|e| ActionSinkError::Database(e.to_string()))?;
            Ok(rows.into_iter().map(|row| row.event).collect())
        })
    }

    fn fetch_existing_page(
        &self,
        coordinate: &str,
    ) -> buzz_agwiki::run::PortFut<'_, Option<(String, u64)>, Self::Error> {
        let query = buzz_db::EventQuery {
            kinds: Some(vec![i32::from(buzz_agwiki::KIND_AGENT_WIKI as u16)]),
            d_tag: Some(coordinate.to_owned()),
            limit: Some(i64::from(buzz_agwiki::AGWIKI_PAGE_QUERY_BOUND)),
            ..buzz_db::EventQuery::for_community(self.tenant.community())
        };
        let coordinate = coordinate.to_owned();
        Box::pin(async move {
            let rows = self
                .state
                .db
                .query_events(&query)
                .await
                .map_err(|e| ActionSinkError::Database(e.to_string()))?;
            let events: Vec<nostr::Event> = rows.into_iter().map(|row| row.event).collect();
            Ok(buzz_agwiki::newest_page(&events, &coordinate))
        })
    }

    fn search(
        &self,
        query: &str,
        kinds: &[u32],
        limit: u32,
    ) -> buzz_agwiki::run::PortFut<'_, Vec<serde_json::Value>, Self::Error> {
        let mut search_query = buzz_search::SearchQuery {
            community: self.tenant.community(),
            q: query.to_owned(),
            // Replaced inside the async block below with the OPEN channels
            // only: this relay-run job has no viewer, so nothing here can
            // re-check access per member. `Any` would reach private channels.
            channel_scope: buzz_search::ChannelScope::Any,
            kinds: Some(kinds.iter().map(|k| *k as i32).collect()),
            authors: None,
            since: None,
            until: None,
            page: 1,
            per_page: limit,
            mode: buzz_search::SearchMode::FullText,
        };
        Box::pin(async move {
            let readable = readable_channel_ids(&self.state.db, self.tenant.community()).await?;
            if readable.is_empty() {
                return Ok(Vec::new());
            }
            search_query.channel_scope = buzz_search::ChannelScope::Channels(readable);
            let result = self
                .state
                .search
                .search(&search_query)
                .await
                .map_err(|e| ActionSinkError::Database(e.to_string()))?;
            let hit_ids: Vec<[u8; 32]> = result.hits.into_iter().map(|h| h.event_id).collect();
            let id_refs: Vec<&[u8]> = hit_ids.iter().map(|b| b.as_slice()).collect();
            let events = self
                .state
                .db
                .get_events_by_ids_routed(
                    "agwiki_reflection_search",
                    self.tenant.community(),
                    &id_refs,
                )
                .await
                .map_err(|e| ActionSinkError::Database(e.to_string()))?;
            Ok(events
                .iter()
                .map(|stored| {
                    serde_json::json!({
                        "id": stored.event.id.to_hex(),
                        "content": stored.event.content,
                    })
                })
                .collect())
        })
    }

    fn chat(
        &self,
        http: &reqwest::Client,
        system: &str,
        user: &str,
        max_tokens: u32,
    ) -> buzz_agwiki::run::PortFut<'_, serde_json::Value, Self::Error> {
        // Capture owned copies (the reqwest client is Arc-backed) so the
        // boxed future is bound only by `&self`, matching the trait.
        let http = http.clone();
        let target = self.target.clone();
        let system = system.to_owned();
        let user = user.to_owned();
        Box::pin(async move {
            buzz_agwiki::llm::chat_completion(&http, &target, &system, &user, max_tokens)
                .await
                .map_err(|e| ActionSinkError::Distill(e.to_string()))
        })
    }

    fn publish(&self, builder: EventBuilder) -> buzz_agwiki::run::PortFut<'_, String, Self::Error> {
        Box::pin(async move {
            // Relay-signed internal publish — but the envelope bounds are the
            // same as the client ingest path (fail closed on violations).
            let event = sign_and_validate_agent_wiki_page(&self.state.relay_keypair, builder)?;
            let (stored_event, was_inserted) = self
                .state
                .db
                .insert_event_with_thread_metadata(self.tenant.community(), &event, None, None)
                .await
                .map_err(|e| ActionSinkError::Database(e.to_string()))?;
            if was_inserted {
                let _ = dispatch_persistent_event(
                    self.tenant,
                    self.state,
                    &stored_event,
                    buzz_agwiki::KIND_AGENT_WIKI,
                    &event.pubkey.to_hex(),
                    None,
                )
                .await;
            }
            Ok(event.id.to_hex())
        })
    }

    fn llm_model(&self) -> &str {
        &self.target.model
    }
}

/// Map the core outcome to the step output recorded in workflow run history.
fn distill_outcome_json(outcome: &buzz_agwiki::run::DistillOutcome) -> serde_json::Value {
    use buzz_agwiki::run::DistillOutcome;
    match outcome {
        DistillOutcome::Skipped { coordinate, since } => serde_json::json!({
            "status": "skipped",
            "space": coordinate.split('/').next().unwrap_or_default(),
            "coordinate": coordinate,
            "since": since,
        }),
        DistillOutcome::Preview { report, .. } | DistillOutcome::Published { report, .. } => {
            serde_json::json!({
                "status": if matches!(outcome, DistillOutcome::Published { .. }) {
                    "published"
                } else {
                    "preview"
                },
                "space": report.space,
                "coordinate": report.coordinate,
                "event_id": match outcome {
                    DistillOutcome::Published { write_result, .. } => write_result.clone(),
                    _ => String::new(),
                },
                "cursor": report.cursor,
                "cost_tokens": report.cost_tokens,
                "model": report.model,
                "sources": report.sources,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn relay_jobs_read_only_open_live_non_dm_channels() {
        use super::is_distill_readable;
        assert!(is_distill_readable("open", "stream", false, false));
        assert!(is_distill_readable("open", "forum", false, false));
        assert!(!is_distill_readable("private", "stream", false, false));
        assert!(!is_distill_readable("open", "dm", false, false));
        assert!(!is_distill_readable("open", "stream", true, false));
        assert!(!is_distill_readable("open", "stream", false, true));
    }

    #[test]
    fn private_or_unparsable_channel_events_never_feed_a_relay_job() {
        use super::event_in_readable_channel;
        use std::collections::HashSet;

        let keys = nostr::Keys::generate();
        let open = uuid::Uuid::new_v4();
        let private = uuid::Uuid::new_v4();
        let readable: HashSet<uuid::Uuid> = [open].into_iter().collect();
        let event = |tags: Vec<Vec<String>>| {
            nostr::EventBuilder::new(nostr::Kind::Custom(9), "hello")
                .tags(tags.into_iter().map(|t| nostr::Tag::parse(t).unwrap()))
                .sign_with_keys(&keys)
                .unwrap()
        };
        let h = |id: &str| vec![vec!["h".to_string(), id.to_string()]];

        assert!(event_in_readable_channel(
            &event(h(&open.to_string())),
            &readable
        ));
        assert!(
            !event_in_readable_channel(&event(h(&private.to_string())), &readable),
            "a private channel's message must not reach the LLM or the shared page"
        );
        assert!(
            !event_in_readable_channel(&event(h("not-a-uuid")), &readable),
            "an unparsable channel id fails closed"
        );
        assert!(
            event_in_readable_channel(&event(vec![]), &readable),
            "channel-less records (org events) are not channel-scoped"
        );
    }

    use super::*;

    fn m(name: &str, pubkey: &str) -> (String, String) {
        (name.to_string(), pubkey.to_string())
    }

    // A 64-char hex pubkey built from a single repeated nibble, for readable tests.
    fn pk(nibble: char) -> String {
        std::iter::repeat_n(nibble, 64).collect()
    }

    #[test]
    fn resolves_exact_member_name() {
        let members = vec![m("Robby", &pk('a'))];
        assert_eq!(
            resolve_mention_pubkeys("heads up @Robby — please take a look", &members),
            vec![pk('a')]
        );
    }

    #[test]
    fn matches_case_insensitively() {
        let members = vec![m("Robby", &pk('a'))];
        assert_eq!(
            resolve_mention_pubkeys("ping @robby", &members),
            vec![pk('a')]
        );
    }

    #[test]
    fn ignores_non_member_and_bare_at() {
        let members = vec![m("Robby", &pk('a'))];
        assert!(resolve_mention_pubkeys("hey @Stranger and @", &members).is_empty());
    }

    #[test]
    fn greedy_longest_binds_full_name_not_prefix() {
        // Both "Will" and "Will Pfleger" are members. `@Will Pfleger` must bind
        // Pfleger's key only; a bare `@Will` binds Will.
        let members = vec![m("Will", &pk('1')), m("Will Pfleger", &pk('2'))];
        assert_eq!(
            resolve_mention_pubkeys("cc @Will Pfleger on this", &members),
            vec![pk('2')]
        );
        assert_eq!(
            resolve_mention_pubkeys("cc @Will on this", &members),
            vec![pk('1')]
        );
    }

    #[test]
    fn at_mid_token_does_not_match() {
        // `@` must sit at a left boundary (start / whitespace / `(`). An email-ish
        // or mid-token `@` (`alice@Robby`) must not wake Robby.
        let members = vec![m("Robby", &pk('a'))];
        assert!(resolve_mention_pubkeys("alice@Robby", &members).is_empty());
    }

    #[test]
    fn prefix_member_does_not_match_inside_longer_word() {
        // "Sam" is a member; `@Sami` (no "Sami" member) must not wake Sam.
        let members = vec![m("Sam", &pk('3'))];
        assert!(resolve_mention_pubkeys("hi @Sami", &members).is_empty());
    }

    #[test]
    fn name_with_spaces_and_punctuation() {
        let members = vec![m("Lep (Subagent)", &pk('4'))];
        assert_eq!(
            resolve_mention_pubkeys("@Lep (Subagent) take it", &members),
            vec![pk('4')]
        );
    }

    #[test]
    fn em_dash_terminates_name() {
        // Generated prose often writes `@Name—text` with no space.
        let members = vec![m("Robby", &pk('a'))];
        assert_eq!(
            resolve_mention_pubkeys("@Robby—please look", &members),
            vec![pk('a')]
        );
    }

    #[test]
    fn non_ascii_member_name() {
        let members = vec![m("Zoë", &pk('5'))];
        assert_eq!(
            resolve_mention_pubkeys("welcome @Zoë!", &members),
            vec![pk('5')]
        );
    }

    #[test]
    fn lowercase_expansion_does_not_shift_later_mentions() {
        // Regression (Wren's redteam counterexample): `İ` (U+0130) lowercases to
        // TWO code points (`i` + U+0307). A design that pre-lowercases the whole
        // text and indexes it in parallel with the original chars desyncs after
        // the expansion, dropping every later valid mention. `@İ @Robby` must
        // resolve BOTH members, in order.
        let members = vec![m("İ", &pk('c')), m("Robby", &pk('a'))];
        assert_eq!(
            resolve_mention_pubkeys("@İ @Robby", &members),
            vec![pk('c'), pk('a')]
        );
    }

    #[test]
    fn sharp_s_matches_case_insensitively() {
        // `ẞ` (U+1E9E capital sharp s) lowercases to `ß` (U+00DF) — a single
        // char, NOT `ss` (that's uppercase/full-case-fold behavior, not
        // `char::to_lowercase`). Covers non-ASCII case-insensitive matching, and
        // that a later mention still resolves after it.
        let members = vec![m("ẞ", &pk('d')), m("Max", &pk('b'))];
        assert_eq!(
            resolve_mention_pubkeys("@ẞ and @Max", &members),
            vec![pk('d'), pk('b')]
        );
    }

    // Adversarial rows from Quinn's re-review (the two `ẞ→ss`-premised ones were
    // dropped as vacuous — `ẞ` lowercases to `ß`, one char, so it never inverts
    // original-vs-folded length; only `İ` does).

    #[test]
    fn combining_mark_in_name_matches() {
        // A name carrying a combining mark (`é` as `e` + U+0301) matches the same
        // sequence in text (1:1 folding) and terminates cleanly.
        let members = vec![m("Jos\u{0065}\u{0301}", &pk('4'))]; // "José" decomposed
        assert_eq!(
            resolve_mention_pubkeys("hi @Jos\u{0065}\u{0301}!", &members),
            vec![pk('4')]
        );
    }

    #[test]
    fn expanding_name_at_trailing_boundary() {
        // Expansion at the very end: `@İ` with nothing after must match, and
        // `@İx` (x extends the name, no `İx` member) must NOT match `İ`.
        let members = vec![m("İ", &pk('5'))];
        assert_eq!(resolve_mention_pubkeys("@İ", &members), vec![pk('5')]);
        assert!(resolve_mention_pubkeys("@İx", &members).is_empty());
    }

    #[test]
    fn back_to_back_at_is_one_mention() {
        // `@İ@Robby`: the second `@` is preceded by a name char (`İ`), so it is
        // NOT at a left boundary — same rule as `alice@Robby`. Back-to-back
        // `@a@b` is intentionally one mention; a separator is required to wake
        // both. The expanding first name (`İ` → 2 folded chars) also proves the
        // span accounting stays in original coordinates.
        let members = vec![m("İ", &pk('5')), m("Robby", &pk('a'))];
        assert_eq!(resolve_mention_pubkeys("@İ@Robby", &members), vec![pk('5')]);
        // ASCII control: same shape, same outcome — it's the boundary rule, not
        // a Unicode span-accounting bug.
        let ascii = vec![m("Sam", &pk('6')), m("Robby", &pk('a'))];
        assert_eq!(resolve_mention_pubkeys("@Sam@Robby", &ascii), vec![pk('6')]);
        // With a separator, both wake.
        assert_eq!(
            resolve_mention_pubkeys("@İ @Robby", &members),
            vec![pk('5'), pk('a')]
        );
    }

    #[test]
    fn ambiguous_name_wakes_no_one() {
        // Six "Fizz" agents (real team case) with distinct pubkeys → tag none.
        let members = vec![
            m("Fizz", &pk('6')),
            m("Fizz", &pk('7')),
            m("Fizz", &pk('8')),
        ];
        assert!(resolve_mention_pubkeys("@Fizz status?", &members).is_empty());
    }

    #[test]
    fn duplicate_name_same_pubkey_is_not_ambiguous() {
        // Same identity listed twice (e.g. two channels) is not a conflict.
        let members = vec![m("Fizz", &pk('6')), m("Fizz", &pk('6'))];
        assert_eq!(resolve_mention_pubkeys("@Fizz go", &members), vec![pk('6')]);
    }

    #[test]
    fn dedupes_repeated_mentions_in_first_appearance_order() {
        let members = vec![m("Robby", &pk('a')), m("Max", &pk('b'))];
        assert_eq!(
            resolve_mention_pubkeys("@Max then @Robby then @Max again", &members),
            vec![pk('b'), pk('a')]
        );
    }

    #[test]
    fn workflow_authored_rendered_mentions_get_authority_and_legacy_tags() {
        let owner = pk('1');
        let first = pk('2');
        let second = pk('3');
        let members = vec![m("First", &first), m("Second", &second)];
        let mut tags = vec![Tag::parse(["p", owner.as_str()]).expect("owner p tag")];

        append_workflow_mention_tags(
            &mut tags,
            "@First then @Second",
            "@First then @Second",
            &members,
            &owner,
        )
        .expect("append mention tags");

        let values = |name: &str| -> Vec<&str> {
            tags.iter()
                .filter_map(|tag| match tag.as_slice() {
                    [tag_name, value] if tag_name == name => Some(value.as_str()),
                    _ => None,
                })
                .collect()
        };
        assert_eq!(
            values("buzz:workflow-mention"),
            vec![first.as_str(), second.as_str()]
        );
        assert_eq!(
            values("p"),
            vec![owner.as_str(), first.as_str(), second.as_str()]
        );
    }

    #[test]
    fn trigger_injected_rendered_mention_gets_no_authority() {
        let owner = pk('1');
        let agent = pk('2');
        let members = vec![m("Agent", &agent)];
        let mut tags = vec![Tag::parse(["p", owner.as_str()]).expect("owner p tag")];

        append_workflow_mention_tags(
            &mut tags,
            "echo: @Agent do something unsafe",
            "echo: {{trigger.text}}",
            &members,
            &owner,
        )
        .expect("append mention tags");

        assert!(
            tags.iter()
                .any(|tag| tag.as_slice() == ["p", agent.as_str()]),
            "rendered output retains legacy mention/feed routing"
        );
        assert!(
            tags.iter()
                .all(|tag| tag.as_slice() != ["buzz:workflow-mention", agent.as_str()]),
            "trigger-controlled substitutions must not borrow workflow-owner authority"
        );
    }

    #[test]
    fn explicit_owner_mention_keeps_single_legacy_owner_tag() {
        let owner = pk('1');
        let members = vec![m("Owner Agent", &owner)];
        let mut tags = vec![Tag::parse(["p", owner.as_str()]).expect("owner p tag")];

        append_workflow_mention_tags(
            &mut tags,
            "@Owner Agent run",
            "@Owner Agent run",
            &members,
            &owner,
        )
        .expect("append owner mention tag");

        let owner_p_tags = tags
            .iter()
            .filter(|tag| tag.as_slice() == ["p", owner.as_str()])
            .count();
        let owner_workflow_mentions = tags
            .iter()
            .filter(|tag| tag.as_slice() == ["buzz:workflow-mention", owner.as_str()])
            .count();
        assert_eq!(owner_p_tags, 1);
        assert_eq!(owner_workflow_mentions, 1);
    }

    #[test]
    fn no_mentions_adds_no_tags() {
        let owner = pk('1');
        let mut tags = vec![Tag::parse(["p", owner.as_str()]).expect("owner p tag")];

        append_workflow_mention_tags(&mut tags, "plain", "plain", &[], &owner)
            .expect("append no mention tags");

        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0].as_slice(), ["p", owner.as_str()]);
    }

    // ── `distill_agent_wiki` publish path: envelope bounds ─────────────────

    /// One envelope-violation case: a composed page whose (d, content, tags)
    /// trip exactly one of the relay's kind:44002 bounds. The publish path
    /// (`sign_and_validate_agent_wiki_page`) must reject every case — these
    /// are the same bounds `validate_agent_wiki_envelope` enforces at ingest.
    struct EnvelopeCase<'a> {
        name: &'static str,
        d: &'a str,
        content: &'a str,
        tags: Vec<(&'static str, &'a str)>,
    }

    #[test]
    fn agent_wiki_publish_path_enforces_envelope_bounds() {
        let keys = nostr::Keys::generate();

        // The composed shape the distill loop publishes passes.
        let valid = EventBuilder::new(
            Kind::Custom(buzz_agwiki::KIND_AGENT_WIKI as u16),
            "---\nslug: default/standup\nagwiki-cursor: 1\n---\n# body",
        )
        .tags(vec![
            Tag::parse(["d", "default/standup"]).expect("d tag"),
            Tag::parse(["model", "test-model"]).expect("model tag"),
            Tag::parse(["cost_tokens", "1500"]).expect("cost tag"),
            Tag::parse(["sources", &"a".repeat(64)]).expect("sources tag"),
        ]);
        assert!(
            sign_and_validate_agent_wiki_page(&keys, valid).is_ok(),
            "a well-formed page must pass the publish path"
        );

        let long_d = "a".repeat(257);
        let long_content = "x".repeat(65_537);
        let cases = [
            EnvelopeCase {
                name: "d without '/'",
                d: "standalone",
                content: "body",
                tags: vec![],
            },
            EnvelopeCase {
                name: "uppercase d segment",
                d: "Default/standup",
                content: "body",
                tags: vec![],
            },
            EnvelopeCase {
                name: "empty d segment",
                d: "default//standup",
                content: "body",
                tags: vec![],
            },
            EnvelopeCase {
                name: "over-long d",
                d: long_d.as_str(),
                content: "body",
                tags: vec![],
            },
            EnvelopeCase {
                name: "empty content",
                d: "default/standup",
                content: "",
                tags: vec![],
            },
            EnvelopeCase {
                name: "over-long content",
                d: "default/standup",
                content: long_content.as_str(),
                tags: vec![],
            },
            EnvelopeCase {
                name: "duplicate model tags",
                d: "default/standup",
                content: "body",
                tags: vec![("model", "a"), ("model", "b")],
            },
            EnvelopeCase {
                name: "empty model value",
                d: "default/standup",
                content: "body",
                tags: vec![("model", "")],
            },
            EnvelopeCase {
                name: "non-digit cost_tokens",
                d: "default/standup",
                content: "body",
                tags: vec![("cost_tokens", "1.5k")],
            },
            EnvelopeCase {
                name: "duplicate cost_tokens",
                d: "default/standup",
                content: "body",
                tags: vec![("cost_tokens", "1"), ("cost_tokens", "2")],
            },
            EnvelopeCase {
                name: "duplicate sources",
                d: "default/standup",
                content: "body",
                tags: vec![
                    (
                        "sources",
                        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    ),
                    (
                        "sources",
                        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                    ),
                ],
            },
            EnvelopeCase {
                name: "malformed source id",
                d: "default/standup",
                content: "body",
                tags: vec![("sources", "not-hex")],
            },
        ];

        for case in &cases {
            let mut builder = EventBuilder::new(
                Kind::Custom(buzz_agwiki::KIND_AGENT_WIKI as u16),
                case.content,
            )
            .tag(Tag::parse(["d", case.d]).expect("d tag parses"));
            for (name, value) in &case.tags {
                builder = builder.tag(Tag::parse([*name, *value]).expect("tag parses"));
            }
            let result = sign_and_validate_agent_wiki_page(&keys, builder);
            assert!(
                matches!(result, Err(ActionSinkError::Distill(_))),
                "publish path must reject envelope violation '{}', got: {result:?}",
                case.name
            );
        }
    }

    #[test]
    fn classifier_target_fails_closed_without_config() {
        // Missing config must surface as a visible Distill error naming the
        // missing variable — never a silent skip (Review-Proven Rule 1).
        let missing = classifier_target_from(|name| {
            (name == "BUZZ_CLASSIFIER_API_KEY").then(|| "k".to_string())
        });
        match missing {
            Err(ActionSinkError::Distill(m)) => {
                assert!(m.contains("BUZZ_CLASSIFIER_API_URL"), "got: {m}");
            }
            other => panic!("expected a Distill error, got: {other:?}"),
        }

        let ok = classifier_target_from(|name| match name {
            "BUZZ_CLASSIFIER_API_URL" => Some("http://x".to_string()),
            "BUZZ_CLASSIFIER_API_KEY" => Some("k".to_string()),
            _ => None,
        });
        assert!(ok.is_ok(), "a configured target resolves: {ok:?}");
    }
}

#[cfg(test)]
mod postgres_tests {
    //! Regression test for `e3661764` / `7899c1a8`: a workflow `send_message`
    //! that mentions a channel member by name (`@Name`) in its author-written
    //! step template must emit both the legacy `p` tag and authenticated
    //! workflow-mention provenance for that member. Rendered trigger data may
    //! still create a legacy `p` tag, but never authority-bearing provenance.
    //!
    //! Postgres-gated like the other DB-backed relay tests. Run with:
    //!   `cargo test -p buzz-relay --lib workflow_sink -- --ignored`
    use super::*;
    use buzz_core::channel::{ChannelType, ChannelVisibility, MemberRole};
    use buzz_db::CreateCommunityWithOwnerResult;
    use std::sync::Arc;

    /// Real-PG state mirroring `handlers::event::tests::test_state_with_redis_url`.
    async fn test_state() -> Arc<AppState> {
        let mut config = crate::config::Config::for_test(); // [FI-TRACE-ENV-RACE]
        config.require_relay_membership = false;
        config.redis_url = "redis://127.0.0.1:1".to_string();
        let pool = sqlx::PgPool::connect_lazy(&config.database_url).expect("lazy pg pool");
        let db = buzz_db::Db::from_pool(pool.clone());
        let redis_pool = deadpool_redis::Config::from_url(&config.redis_url)
            .create_pool(Some(deadpool_redis::Runtime::Tokio1))
            .expect("redis pool");
        let pubsub = Arc::new(
            buzz_pubsub::PubSubManager::new(&config.redis_url, redis_pool.clone())
                .await
                .expect("pubsub manager"),
        );
        let audit = buzz_audit::AuditService::new(pool.clone());
        let auth = buzz_auth::AuthService::new(config.auth.clone());
        let search = buzz_search::SearchService::new(pool.clone());
        let workflow_engine = Arc::new(buzz_workflow::WorkflowEngine::new(
            db.clone(),
            buzz_workflow::WorkflowConfig::default(),
        ));
        let media_storage = buzz_media::MediaStorage::new(&config.media).expect("media storage");
        let (state, _audit_shutdown) = AppState::new(
            config,
            db,
            redis_pool,
            audit,
            pubsub,
            auth,
            search,
            workflow_engine,
            nostr::Keys::generate(),
            media_storage,
        );
        Arc::new(state)
    }

    async fn execute_send_message_workflow(
        state: &Arc<AppState>,
        community: CommunityId,
        channel_id: Uuid,
        owner_pubkey: &[u8],
        name: &str,
        authored_text: &str,
        trigger_text: &str,
    ) -> String {
        let definition = serde_json::json!({
            "name": name,
            "trigger": {"on": "message_posted"},
            "steps": [{
                "id": "send",
                "action": "send_message",
                "text": authored_text,
            }],
            "enabled": true,
        });
        let definition_hash_byte = name.as_bytes().first().copied().unwrap_or_default();
        let workflow_id = state
            .db
            .create_workflow(
                community,
                Some(channel_id),
                owner_pubkey,
                name,
                &definition.to_string(),
                &[definition_hash_byte; 32],
            )
            .await
            .expect("create workflow");
        let trigger_ctx = buzz_workflow::executor::TriggerContext {
            text: trigger_text.to_owned(),
            channel_id: channel_id.to_string(),
            ..Default::default()
        };
        let trigger_ctx_json = serde_json::to_value(&trigger_ctx).expect("serialize trigger");
        let run_id = state
            .db
            .create_workflow_run(community, workflow_id, None, Some(&trigger_ctx_json))
            .await
            .expect("create workflow run");

        // Load the definition back from Postgres before execution. This pins the
        // authority source to the durable owner-authored template rather than a
        // second test-only string passed directly to RelayActionSink.
        let stored_workflow = state
            .db
            .get_workflow(community, workflow_id)
            .await
            .expect("load stored workflow");
        let stored_definition: buzz_workflow::WorkflowDef =
            serde_json::from_value(stored_workflow.definition).expect("parse stored definition");
        let result = buzz_workflow::executor::execute_run(
            &state.workflow_engine,
            community,
            run_id,
            &stored_definition,
            &trigger_ctx,
        )
        .await
        .expect("execute workflow");

        result.step_outputs["send"]["event_id"]
            .as_str()
            .expect("send_message event id")
            .to_owned()
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn workflow_send_message_binds_authority_to_authored_mentions() {
        let state = test_state().await;

        let author = nostr::Keys::generate();
        let author_hex = author.public_key().to_hex();
        let agent = nostr::Keys::generate();
        let agent_hex = agent.public_key().to_hex();
        let agent_bytes = agent.public_key().to_bytes().to_vec();

        let host = format!("wf-ptag-{}.example", uuid::Uuid::new_v4().simple());
        let community = match state
            .db
            .create_community_with_owner(&host, &author_hex)
            .await
            .expect("create community")
        {
            CreateCommunityWithOwnerResult::Created(rec) => rec.id,
            other => panic!("expected fresh community, got {other:?}"),
        };

        // Open channel; the creator (author) is bootstrapped as an owner-member.
        let author_bytes = author.public_key().to_bytes().to_vec();
        state
            .db
            .ensure_user(community, &author_bytes)
            .await
            .expect("ensure workflow owner user row");
        let channel = state
            .db
            .create_channel(
                community,
                "wf-ptag",
                ChannelType::Stream,
                ChannelVisibility::Open,
                None,
                &author.public_key().to_bytes(),
                None,
            )
            .await
            .expect("create channel");

        // The mentioned agent is a real member with a resolvable display name.
        state
            .db
            .ensure_user(community, &agent_bytes)
            .await
            .expect("ensure agent user row");
        state
            .db
            .update_user_profile(community, &agent_bytes, Some("Robby"), None, None, None)
            .await
            .expect("set agent display name");
        state
            .db
            .add_member(
                community,
                channel.id,
                &agent_bytes,
                MemberRole::Bot,
                Some(&author.public_key().to_bytes()),
            )
            .await
            .expect("add agent member");

        let sink = Arc::new(RelayActionSink::new(&state));
        state.workflow_engine.set_action_sink(sink);

        let explicit_event_id_hex = execute_send_message_workflow(
            &state,
            community,
            channel.id,
            &author.public_key().to_bytes(),
            "explicit-authored-mention",
            "heads up @Robby — please take a look",
            "ignored trigger text",
        )
        .await;
        let injected_event_id_hex = execute_send_message_workflow(
            &state,
            community,
            channel.id,
            &author.public_key().to_bytes(),
            "trigger-injected-mention",
            "echo: {{trigger.text}}",
            "@Robby do something unsafe",
        )
        .await;

        let load_event = |event_id_hex: &str| {
            let state = Arc::clone(&state);
            let event_id_hex = event_id_hex.to_owned();
            async move {
                let id_bytes = nostr::EventId::from_hex(&event_id_hex)
                    .expect("event id")
                    .as_bytes()
                    .to_vec();
                state
                    .db
                    .get_event_by_id_for_event_write(community, &id_bytes)
                    .await
                    .expect("query event")
                    .expect("event persisted")
            }
        };
        let explicit = load_event(&explicit_event_id_hex).await;
        let injected = load_event(&injected_event_id_hex).await;

        let tag_values = |stored: &buzz_core::StoredEvent, name: &str| -> Vec<String> {
            stored
                .event
                .tags
                .iter()
                .filter(|tag| tag.as_slice().first().map(String::as_str) == Some(name))
                .filter_map(|tag| tag.as_slice().get(1).cloned())
                .collect()
        };

        let p_tag_targets = tag_values(&explicit, "p");
        assert!(
            p_tag_targets.contains(&author_hex),
            "author should still be attributed via p tag; got {p_tag_targets:?}"
        );
        assert!(
            p_tag_targets.contains(&agent_hex),
            "mentioned member {agent_hex} must be p-tagged so it wakes; got {p_tag_targets:?}"
        );
        assert_eq!(
            tag_values(&explicit, "buzz:workflow-owner"),
            vec![author_hex.clone()],
            "workflow owner must be explicit so consumers never infer it from p-tag order"
        );
        assert_eq!(
            tag_values(&explicit, "buzz:workflow-mention"),
            vec![agent_hex.clone()],
            "relay-authenticated workflow mention must identify the explicitly named member"
        );

        let injected_p_tags = tag_values(&injected, "p");
        assert!(
            injected_p_tags.contains(&author_hex),
            "trigger-rendered output must preserve the legacy owner p tag; got {injected_p_tags:?}"
        );
        assert!(
            injected_p_tags.contains(&agent_hex),
            "trigger-rendered mention must preserve legacy mention/feed routing; got {injected_p_tags:?}"
        );
        assert!(
            tag_values(&injected, "buzz:workflow-mention").is_empty(),
            "a mention introduced solely by trigger data must not receive owner-delegated authority"
        );
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn workflow_reply_in_thread_threads_onto_parent() {
        let state = test_state().await;

        let author = nostr::Keys::generate();
        let author_hex = author.public_key().to_hex();

        let host = format!("wf-thread-{}.example", uuid::Uuid::new_v4().simple());
        let community = match state
            .db
            .create_community_with_owner(&host, &author_hex)
            .await
            .expect("create community")
        {
            CreateCommunityWithOwnerResult::Created(rec) => rec.id,
            other => panic!("expected fresh community, got {other:?}"),
        };

        let channel = state
            .db
            .create_channel(
                community,
                "wf-thread",
                ChannelType::Stream,
                ChannelVisibility::Open,
                None,
                &author.public_key().to_bytes(),
                None,
            )
            .await
            .expect("create channel");

        let sink = RelayActionSink::new(&state);

        // 1. A top-level workflow message becomes the thread root.
        let root_hex = sink
            .send_message(
                community,
                &channel.id.to_string(),
                "root message",
                "root message",
                &author_hex,
                None,
            )
            .await
            .expect("send root");

        // 2. A reply_in_thread message threads onto it.
        let reply_hex = sink
            .send_message(
                community,
                &channel.id.to_string(),
                "threaded reply",
                "threaded reply",
                &author_hex,
                Some(&root_hex),
            )
            .await
            .expect("send reply");

        // A direct reply carries a single NIP-10 reply e-tag at the root (no
        // root marker), matching SDK `thread_tags`.
        let reply_id_bytes = nostr::EventId::from_hex(&reply_hex)
            .expect("reply id")
            .as_bytes()
            .to_vec();
        let stored = state
            .db
            .get_event_by_id_for_event_write(community, &reply_id_bytes)
            .await
            .expect("query reply")
            .expect("reply persisted");
        let marker = |m: &str| -> Option<String> {
            stored.event.tags.iter().find_map(|t| {
                let p = t.as_slice();
                if p.len() >= 4 && p[0] == "e" && p[3] == m {
                    Some(p[1].clone())
                } else {
                    None
                }
            })
        };
        assert_eq!(
            marker("reply").as_deref(),
            Some(root_hex.as_str()),
            "direct reply emits a single reply marker at the root"
        );
        assert_eq!(
            marker("root"),
            None,
            "direct reply omits the root marker (matches SDK thread_tags)"
        );

        // Thread metadata reflects a depth-1 reply parented on the root.
        let meta = state
            .db
            .get_thread_metadata_by_event(community, &reply_id_bytes)
            .await
            .expect("query meta")
            .expect("reply has thread metadata");
        assert_eq!(
            meta.depth, 1,
            "direct reply to a top-level message is depth 1"
        );
        let root_bytes = nostr::EventId::from_hex(&root_hex)
            .expect("root id")
            .as_bytes()
            .to_vec();
        assert_eq!(meta.parent_event_id.as_deref(), Some(root_bytes.as_slice()));
        assert_eq!(meta.root_event_id.as_deref(), Some(root_bytes.as_slice()));
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn workflow_replies_recover_metadata_less_parent_ancestry() {
        // A parent that carries NIP-10 root/reply markers but has NO
        // thread_metadata row (legacy or not-yet-indexed) must be recognized as
        // nested: the workflow reply threads at depth 2 onto the parent's own
        // root, not a false top-level depth 1.
        let state = test_state().await;

        let author = nostr::Keys::generate();
        let author_hex = author.public_key().to_hex();

        let host = format!("wf-legacy-{}.example", uuid::Uuid::new_v4().simple());
        let community = match state
            .db
            .create_community_with_owner(&host, &author_hex)
            .await
            .expect("create community")
        {
            CreateCommunityWithOwnerResult::Created(rec) => rec.id,
            other => panic!("expected fresh community, got {other:?}"),
        };

        let channel = state
            .db
            .create_channel(
                community,
                "wf-legacy",
                ChannelType::Stream,
                ChannelVisibility::Open,
                None,
                &author.public_key().to_bytes(),
                None,
            )
            .await
            .expect("create channel");

        let channel_hex = channel.id.to_string();

        // A top-level root message, inserted WITHOUT any thread metadata row.
        let root_event = EventBuilder::new(Kind::from(KIND_STREAM_MESSAGE as u16), "root")
            .tags([Tag::parse(["h", &channel_hex]).expect("h tag")])
            .sign_with_keys(&author)
            .expect("sign root");
        let root_hex = root_event.id.to_hex();
        state
            .db
            .insert_event(community, &root_event, Some(channel.id))
            .await
            .expect("insert root");

        // A nested parent that marks its root/reply — but, crucially, is stored
        // with NO thread_metadata row (the legacy/unindexed case F1 addresses).
        let parent_event =
            EventBuilder::new(Kind::from(KIND_STREAM_MESSAGE as u16), "nested parent")
                .tags([
                    Tag::parse(["h", &channel_hex]).expect("h tag"),
                    Tag::parse(["e", &root_hex, "", "root"]).expect("root tag"),
                    Tag::parse(["e", &root_hex, "", "reply"]).expect("reply tag"),
                ])
                .sign_with_keys(&author)
                .expect("sign parent");
        let parent_hex = parent_event.id.to_hex();
        state
            .db
            .insert_event(community, &parent_event, Some(channel.id))
            .await
            .expect("insert parent");
        assert!(
            state
                .db
                .get_thread_metadata_by_event(community, parent_event.id.as_bytes())
                .await
                .expect("query parent meta")
                .is_none(),
            "test premise: the nested parent must have no thread_metadata row"
        );

        // A workflow reply onto the metadata-less nested parent.
        let reply_hex = RelayActionSink::new(&state)
            .send_message(
                community,
                &channel_hex,
                "workflow reply",
                "workflow reply",
                &author_hex,
                Some(&parent_hex),
            )
            .await
            .expect("send reply");

        let reply_id_bytes = nostr::EventId::from_hex(&reply_hex)
            .expect("reply id")
            .as_bytes()
            .to_vec();
        let meta = state
            .db
            .get_thread_metadata_by_event(community, &reply_id_bytes)
            .await
            .expect("query meta")
            .expect("reply has thread metadata");

        assert_eq!(
            meta.depth, 2,
            "reply to a marked-but-unindexed nested parent is depth 2, not top-level"
        );
        let root_bytes = nostr::EventId::from_hex(&root_hex)
            .expect("root id")
            .as_bytes()
            .to_vec();
        let parent_bytes = parent_event.id.as_bytes().to_vec();
        assert_eq!(
            meta.root_event_id.as_deref(),
            Some(root_bytes.as_slice()),
            "root recovered from the parent's own NIP-10 markers"
        );
        assert_eq!(
            meta.parent_event_id.as_deref(),
            Some(parent_bytes.as_slice())
        );

        // The reply's own NIP-10 e-tags point root→the recovered root,
        // reply→the immediate parent (matching the ingest resolver).
        let stored = state
            .db
            .get_event_by_id_for_event_write(community, &reply_id_bytes)
            .await
            .expect("query reply")
            .expect("reply persisted");
        let marker = |m: &str| -> Option<String> {
            stored.event.tags.iter().find_map(|t| {
                let p = t.as_slice();
                if p.len() >= 4 && p[0] == "e" && p[3] == m {
                    Some(p[1].clone())
                } else {
                    None
                }
            })
        };
        assert_eq!(marker("root").as_deref(), Some(root_hex.as_str()));
        assert_eq!(marker("reply").as_deref(), Some(parent_hex.as_str()));

        // A root-only parent is top-level under the shared collapse rule, even
        // without metadata. A workflow reply therefore starts a thread at P,
        // rather than incorrectly inheriting the marker's unrelated root R.
        let root_only_parent =
            EventBuilder::new(Kind::from(KIND_STREAM_MESSAGE as u16), "root-only parent")
                .tags([
                    Tag::parse(["h", &channel_hex]).expect("h tag"),
                    Tag::parse(["e", &root_hex, "", "root"]).expect("root tag"),
                ])
                .sign_with_keys(&author)
                .expect("sign root-only parent");
        let root_only_parent_hex = root_only_parent.id.to_hex();
        let root_only_parent_bytes = root_only_parent.id.as_bytes().to_vec();
        state
            .db
            .insert_event(community, &root_only_parent, Some(channel.id))
            .await
            .expect("insert root-only parent");

        let root_only_reply_hex = RelayActionSink::new(&state)
            .send_message(
                community,
                &channel_hex,
                "workflow reply to root-only parent",
                "workflow reply to root-only parent",
                &author_hex,
                Some(&root_only_parent_hex),
            )
            .await
            .expect("send root-only reply");
        let root_only_reply_bytes = nostr::EventId::from_hex(&root_only_reply_hex)
            .expect("reply id")
            .as_bytes()
            .to_vec();
        let root_only_meta = state
            .db
            .get_thread_metadata_by_event(community, &root_only_reply_bytes)
            .await
            .expect("query root-only reply meta")
            .expect("root-only reply has thread metadata");
        assert_eq!(root_only_meta.depth, 1);
        assert_eq!(
            root_only_meta.parent_event_id.as_deref(),
            Some(root_only_parent_bytes.as_slice())
        );
        assert_eq!(
            root_only_meta.root_event_id.as_deref(),
            Some(root_only_parent_bytes.as_slice())
        );
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn workflow_reply_to_missing_parent_errors() {
        let state = test_state().await;
        let author = nostr::Keys::generate();
        let author_hex = author.public_key().to_hex();
        let host = format!("wf-missing-{}.example", uuid::Uuid::new_v4().simple());
        let community = match state
            .db
            .create_community_with_owner(&host, &author_hex)
            .await
            .expect("create community")
        {
            CreateCommunityWithOwnerResult::Created(rec) => rec.id,
            other => panic!("expected fresh community, got {other:?}"),
        };
        let channel = state
            .db
            .create_channel(
                community,
                "wf-missing",
                ChannelType::Stream,
                ChannelVisibility::Open,
                None,
                &author.public_key().to_bytes(),
                None,
            )
            .await
            .expect("create channel");

        let unknown = nostr::Keys::generate().public_key().to_hex();
        let err = RelayActionSink::new(&state)
            .send_message(
                community,
                &channel.id.to_string(),
                "orphan reply",
                "orphan reply",
                &author_hex,
                Some(&unknown),
            )
            .await
            .expect_err("reply to a non-existent parent must fail");
        assert!(
            matches!(err, ActionSinkError::InvalidInput(_)),
            "expected InvalidInput, got {err:?}"
        );
    }
}
