//! Project skill library: kind:30180 discovery, publication, and the
//! per-agent binding edits the harness injects at spawn.
//!
//! Three seams, each deliberately thin over one that already exists:
//!
//! * **Discovery** mirrors `persona_catalog::fetch_persona_catalog` — a paged,
//!   bounded read over the native relay session, signatures verified off the
//!   async executor, NIP-33 head selection per `d` tag. Restricted to the
//!   owner's authorship because that is exactly what
//!   `buzz_acp::project_skills::prefer_owner` will inject: a skill authored by
//!   anyone else can never load, so the library does not offer it as bindable.
//! * **Publication** validates through `buzz_persona::skill::parse_skill_md`
//!   (the single frontmatter contract) and pins `sha256` over the stored
//!   `content` bytes — the same pin the harness recomputes
//!   (`project_skills::parse_candidate`).
//! * **Binding edits** are a tag-intent re-publish of the persona head:
//!   `carried_forward_tags(head)` minus/plus exactly the edited binding,
//!   written through `pending::prepare_persona_publication_at_with_tags` under
//!   the same store lock that serializes every other persona write. The
//!   retention store, the spawn env (`skill_bindings`), and the relay therefore
//!   move together, and a failure before the retain leaves the head — and the
//!   binding the UI shows — untouched.
//!
//! The harness fails OPEN on a missing skill, so an unbind is only real when
//! the tag is gone from the retained head. That is why nothing here treats the
//! relay's answer as optional: a rejection is reported as `queued` (local head
//! already authoritative for spawn, flush loop still owns the relay copy), and
//! a pre-publish failure propagates with the binding still in place.

use std::{collections::hash_map::Entry, time::Duration};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use super::{
    pending::{prepare_persona_publication_at_with_tags, PreparedPersonaPublication},
    sharing::{publish_prepared_persona, PersonaSharePublicationStatus},
};
use crate::{
    app_state::AppState,
    managed_agents::{
        load_personas,
        persona_events::{carried_forward_tags, monotonic_created_at, persona_d_tag},
        retention::{get_retained_event, open_retention_db},
        skill_bindings::{collect_skill_binding_tags, MAX_SKILL_BINDINGS, SKILL_TAG_NAME},
    },
    native_relay_client::NativeRelayClient,
};

/// One bounded page of skill heads. Small on purpose: skills are small in
/// number (a template apply publishes a handful), and the whole library is a
/// renderer-facing list, not an archive sync.
const SKILL_PAGE_SIZE: usize = 100;
/// Hard page ceiling for one library fetch — a bounded read, like the
/// persona catalog's `MAX_CATALOG_PAGES` but far smaller.
const MAX_SKILL_PAGES: usize = 5;
const PAGE_TIMEOUT: Duration = Duration::from_secs(10);
/// Hard cap on a fetched SKILL.md, mirroring `resolve_skill_content` in
/// `buzz-cli` templates and `SKILL_MAX_CONTENT_BYTES`.
const SKILL_FETCH_MAX_BYTES: usize = 64 * 1024;
const SKILL_FETCH_TIMEOUT: Duration = Duration::from_secs(10);
/// Bound for the `source` tag (a URL or a label), and for the URL itself.
const MAX_SOURCE_LENGTH: usize = 512;
/// `applies_to` / binding-scope values. Matches `buzz_cli::templates::schema::
/// SkillScope`; anything else is a binding the harness would silently drop.
const SCOPE_ALL: &str = "all";
const SCOPE_DEVELOPERS: &str = "developers";

// ── Discovery ──────────────────────────────────────────────────────────────

/// One kind:30180 head, projected for the library list.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSkill {
    /// The event's `d` tag — the id binding tags reference.
    pub id: String,
    pub event_id: String,
    /// Frontmatter name (the Agent Skills load key).
    pub name: String,
    pub description: String,
    pub sha256: String,
    pub source: Option<String>,
    pub applies_to: Option<String>,
    /// Byte length of the stored `content`. The renderer sums these over one
    /// agent's bindings to warn about the harness's 64 KiB total cap before
    /// the injection truncation marker fires.
    pub content_bytes: usize,
    pub created_at: u64,
    pub author: String,
    /// True when this workspace's own identity authored the head — the only
    /// kind the harness will inject (owner-preferred head selection).
    pub own: bool,
}

/// The kind:30180 content body as this side reads it. Mirrors `SkillEventContent`
/// in `buzz-acp` and `SkillEventBody` in `buzz-cli` templates: same required
/// fields, same accepted-but-ignored `attachments`.
#[derive(Debug, Deserialize)]
struct SkillEventContent {
    name: String,
    description: String,
    #[serde(default)]
    sha256: String,
    content: String,
    #[serde(default)]
    #[allow(dead_code)]
    attachments: Vec<serde_json::Value>,
}

/// Whether a paged read has more pages to fetch.
#[derive(Debug, PartialEq)]
enum PageProgress {
    Done,
    Next(u64),
}

/// Fetch the active community's own kind:30180 heads, bounded and verified.
///
/// Snapshot-and-recheck like `fetch_persona_catalog`: the response is discarded
/// if the identity or community changed mid-fetch.
#[tauri::command]
pub async fn fetch_project_skills(
    state: State<'_, AppState>,
    relay_client: State<'_, NativeRelayClient>,
) -> Result<Vec<ProjectSkill>, String> {
    let keys = state.signing_keys()?;
    let owner = keys.public_key().to_hex();
    let relay_url = crate::relay::relay_ws_url_with_override(&state);
    let session = relay_client.session(relay_url.clone(), keys).await;
    let mut heads: std::collections::HashMap<String, nostr::Event> =
        std::collections::HashMap::new();
    let mut until: Option<u64> = None;

    for _ in 0..MAX_SKILL_PAGES {
        let mut filter = serde_json::json!({
            "kinds": [buzz_core_pkg::kind::KIND_SKILL],
            "authors": [owner.clone()],
            "limit": SKILL_PAGE_SIZE,
        });
        if let Some(cursor) = until {
            filter["until"] = serde_json::json!(cursor);
        }
        let page = session.fetch_events(filter, PAGE_TIMEOUT).await?;
        let wire_page_len = page.len();
        // Schnorr verification is CPU-bound; keep it off the executor.
        let verified = tauri::async_runtime::spawn_blocking(move || {
            page.into_iter()
                .filter(|event| event.verify().is_ok())
                .collect::<Vec<_>>()
        })
        .await
        .map_err(|error| format!("skill signature verification failed: {error}"))?;

        match merge_verified_page(&mut heads, wire_page_len, verified) {
            PageProgress::Done => break,
            PageProgress::Next(cursor) => until = Some(cursor),
        }
    }

    // Scope fence: a workspace or identity switch mid-fetch must not populate
    // the new community's cache with the old community's skills.
    let current_keys = state.signing_keys()?;
    if current_keys.public_key().to_hex() != owner
        || crate::relay::relay_ws_url_with_override(&state) != relay_url
    {
        return Err("skill library scope changed while fetching".to_string());
    }

    let mut skills: Vec<ProjectSkill> = heads
        .into_values()
        .filter_map(|event| project_skill(&event, &owner))
        .collect();
    skills.sort_by(|left, right| {
        right
            .created_at
            .cmp(&left.created_at)
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(skills)
}

/// Fold one verified page into the `d`-keyed head map and decide the next
/// cursor. Head selection is the relay's rule: greatest `created_at` wins,
/// ties go to the lowest event id.
fn merge_verified_page(
    heads: &mut std::collections::HashMap<String, nostr::Event>,
    wire_page_len: usize,
    verified: Vec<nostr::Event>,
) -> PageProgress {
    let size_before = heads.len();
    let oldest = verified
        .iter()
        .map(|event| event.created_at.as_secs())
        .min();
    for event in verified {
        if event.kind.as_u16() as u32 != buzz_core_pkg::kind::KIND_SKILL {
            continue;
        }
        let Some(id) = tag_value(&event, "d") else {
            continue;
        };
        if id.is_empty() {
            continue;
        }
        match heads.entry(id) {
            Entry::Vacant(slot) => {
                slot.insert(event);
            }
            Entry::Occupied(mut slot) => {
                let current = slot.get();
                let newer = event.created_at > current.created_at
                    || (event.created_at == current.created_at && event.id < current.id);
                if newer {
                    slot.insert(event);
                }
            }
        }
    }

    // A short page is the end of the library; a page of only repeats means the
    // inclusive `until` cursor cannot advance past tied timestamps. Both are
    // stop conditions, not errors — the read stays bounded either way.
    if wire_page_len < SKILL_PAGE_SIZE || heads.len() == size_before {
        return PageProgress::Done;
    }
    oldest.map_or(PageProgress::Done, PageProgress::Next)
}

/// Project one signed skill head. `None` for anything the harness would fail
/// closed on (no `d`, unparsable body, missing name) — such events never
/// inject, so they are not offered as bindable.
fn project_skill(event: &nostr::Event, owner: &str) -> Option<ProjectSkill> {
    let body: SkillEventContent = serde_json::from_str(&event.content).ok()?;
    let name = body.name.trim();
    if name.is_empty() {
        return None;
    }
    let id = tag_value(event, "d")?;
    if id.is_empty() {
        return None;
    }
    Some(ProjectSkill {
        id,
        event_id: event.id.to_hex(),
        name: name.to_string(),
        description: body.description,
        sha256: body.sha256,
        source: tag_value(event, "source"),
        applies_to: tag_value(event, "applies_to"),
        content_bytes: body.content.len(),
        created_at: event.created_at.as_secs(),
        author: event.pubkey.to_hex(),
        own: event.pubkey.to_hex().eq_ignore_ascii_case(owner),
    })
}

fn tag_value(event: &nostr::Event, name: &str) -> Option<String> {
    event
        .tags
        .iter()
        .filter_map(|tag| {
            let values = tag.as_slice();
            (values.len() >= 2 && values.first().is_some_and(|value| value == name))
                .then(|| values[1].clone())
        })
        .next()
}

// ── Publication ────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishSkillInput {
    /// Raw SKILL.md text pasted by the user. Takes precedence over `url`.
    #[serde(default)]
    pub content: Option<String>,
    /// https URL to fetch SKILL.md from when `content` is absent.
    #[serde(default)]
    pub url: Option<String>,
    /// Recorded verbatim (clamped) in the skill's `source` tag. Defaults to
    /// the URL, or `paste` for pasted content.
    #[serde(default)]
    pub source: Option<String>,
    /// Binding scope recorded on the skill's `applies_to` tag: `all` |
    /// `developers`, default `all`.
    #[serde(default)]
    pub applies_to: Option<String>,
}

/// Validate, pin, and publish a SKILL.md as a kind:30180 event.
///
/// Failures propagate: there is no durable retry record for a skill publish
/// (skills are not persona heads and never enter the flush loop's scope), so a
/// swallowed rejection would be an abandoned write.
#[tauri::command]
pub async fn publish_skill(
    input: PublishSkillInput,
    state: State<'_, AppState>,
    relay_client: State<'_, NativeRelayClient>,
) -> Result<ProjectSkill, String> {
    let (markdown, source) = resolve_skill_source(&input, &state).await?;
    let meta = buzz_persona_pkg::skill::parse_skill_md(&markdown)
        .map_err(|error| format!("skill validation failed: {error}"))?;
    let id = meta.name.trim();
    validate_skill_id(id)?;
    let applies_to = normalize_scope(input.applies_to.as_deref(), SCOPE_ALL)?;
    let sha256 = sha256_hex(&markdown);

    let keys = state.signing_keys()?;
    let owner = keys.public_key().to_hex();
    let relay_url = crate::relay::relay_ws_url_with_override(&state);
    let api_base_url = crate::relay::relay_api_base_url_with_override(&state);

    // NIP-33 monotonic re-date: read the current head for this id first so a
    // same-second republish cannot lose the coordinate to the older id.
    let prior_created_at = prior_skill_created_at(&relay_client, &relay_url, &keys, id).await?;

    let content_json = build_skill_content_json(&meta.name, &meta.description, &sha256, &markdown)?;
    let builder = build_skill_event(id, &source, &applies_to, &sha256, &content_json)?
        .custom_created_at(monotonic_created_at(prior_created_at));

    // Scope fence BEFORE anything is signed and sent: a switch mid-publish
    // aborts with nothing sent, rather than publishing to the wrong community.
    let current_keys = state.signing_keys()?;
    if current_keys.public_key().to_hex() != owner
        || crate::relay::relay_ws_url_with_override(&state) != relay_url
    {
        return Err(
            "the community or identity changed while publishing — nothing was sent".to_string(),
        );
    }

    let event = builder
        .sign_with_keys(&keys)
        .map_err(|error| format!("failed to sign skill event: {error}"))?;
    crate::relay::submit_signed_event_at_with_keys(&event, &state, &api_base_url, &keys).await?;

    project_skill(&event, &owner)
        .ok_or_else(|| "published skill did not survive validation".to_string())
}

/// Resolve the SKILL.md text plus the `source` label to record with it.
async fn resolve_skill_source(
    input: &PublishSkillInput,
    state: &AppState,
) -> Result<(String, String), String> {
    if let Some(pasted) = input
        .content
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let source = input
            .source
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("paste");
        return Ok((pasted.to_string(), clamp_source(source)));
    }

    let url = input
        .url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "paste a SKILL.md or give its URL".to_string())?;
    if !url.starts_with("https://") {
        return Err("skill URLs must use https://".to_string());
    }
    if url.len() > MAX_SOURCE_LENGTH {
        return Err(format!("skill URL exceeds {MAX_SOURCE_LENGTH} characters"));
    }
    let markdown = fetch_skill_url(state, url).await?;
    let source = input
        .source
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(url);
    Ok((markdown, clamp_source(source)))
}

/// Bounded, https-only SKILL.md fetch: 10s timeout, hard 64 KiB cap enforced
/// while streaming so a hostile server cannot overrun the bound.
async fn fetch_skill_url(state: &AppState, url: &str) -> Result<String, String> {
    let mut response = state
        .http_client
        .get(url)
        .timeout(SKILL_FETCH_TIMEOUT)
        .send()
        .await
        .map_err(|error| format!("skill fetch failed for {url}: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "skill fetch failed for {url}: HTTP {}",
            response.status()
        ));
    }
    let mut buffer: Vec<u8> = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("skill fetch failed for {url}: {error}"))?
    {
        if buffer.len() + chunk.len() > SKILL_FETCH_MAX_BYTES {
            return Err(format!(
                "skill fetch for {url} exceeds {SKILL_FETCH_MAX_BYTES} bytes"
            ));
        }
        buffer.extend_from_slice(&chunk);
    }
    String::from_utf8(buffer).map_err(|_| format!("skill fetch for {url} is not UTF-8"))
}

/// Read this id's current head `created_at` so the next event is strictly
/// newer (the templates apply's `next_created_at` rule).
async fn prior_skill_created_at(
    relay_client: &State<'_, NativeRelayClient>,
    relay_url: &str,
    keys: &nostr::Keys,
    id: &str,
) -> Result<Option<i64>, String> {
    let session = relay_client
        .session(relay_url.to_string(), keys.clone())
        .await;
    let filter = serde_json::json!({
        "kinds": [buzz_core_pkg::kind::KIND_SKILL],
        "authors": [keys.public_key().to_hex()],
        "#d": [id],
        "limit": 1,
    });
    let events = session.fetch_events(filter, PAGE_TIMEOUT).await?;
    Ok(events
        .iter()
        .map(|event| event.created_at.as_secs() as i64)
        .max())
}

/// sha256 of the stored `content` bytes — the pin `buzz-acp` recomputes
/// before injecting (`project_skills::parse_candidate`).
fn sha256_hex(content: &str) -> String {
    use sha2::{Digest, Sha256};

    hex::encode(Sha256::digest(content.as_bytes()))
}

/// Content body for kind:30180. Field order is the wire contract —
/// `sha256` pins the `content` bytes — and `attachments` is always emitted
/// (empty in v1), mirroring `SkillEventBody` in `buzz-cli` templates.
fn build_skill_content_json(
    name: &str,
    description: &str,
    sha256: &str,
    markdown: &str,
) -> Result<String, String> {
    #[derive(Serialize)]
    struct Wire<'a> {
        name: &'a str,
        description: &'a str,
        sha256: &'a str,
        content: &'a str,
        attachments: Vec<serde_json::Value>,
    }

    serde_json::to_string(&Wire {
        name,
        description,
        sha256,
        content: markdown,
        attachments: Vec::new(),
    })
    .map_err(|error| format!("skill body serialization failed: {error}"))
}

/// Build the unsigned kind:30180 event: `d` (the binding id), `sha256`,
/// `source`, `applies_to` — the tag set templates write and the harness reads.
fn build_skill_event(
    id: &str,
    source: &str,
    applies_to: &str,
    sha256: &str,
    content_json: &str,
) -> Result<nostr::EventBuilder, String> {
    use nostr::{EventBuilder, Kind, Tag};

    let tags = vec![
        Tag::parse(["d", id]).map_err(|error| format!("invalid skill id: {error}"))?,
        Tag::parse(["sha256", sha256]).map_err(|error| format!("invalid sha256 tag: {error}"))?,
        Tag::parse(["source", source]).map_err(|error| format!("invalid source tag: {error}"))?,
        Tag::parse(["applies_to", applies_to])
            .map_err(|error| format!("invalid applies_to tag: {error}"))?,
    ];
    Ok(EventBuilder::new(
        Kind::Custom(buzz_core_pkg::kind::KIND_SKILL as u16),
        content_json.to_string(),
    )
    .tags(tags))
}

/// The binding id is a user-visible string that binding tags reference
/// verbatim, so it gets a real bound rather than being trusted.
fn validate_skill_id(id: &str) -> Result<(), String> {
    if id.is_empty() {
        return Err("skill name is empty".to_string());
    }
    if id.len() > MAX_SOURCE_LENGTH {
        return Err(format!("skill name exceeds {MAX_SOURCE_LENGTH} bytes"));
    }
    if id.chars().any(char::is_control) {
        return Err("skill name contains control characters".to_string());
    }
    Ok(())
}

fn normalize_scope(scope: Option<&str>, default: &'static str) -> Result<String, String> {
    match scope.map(str::trim).filter(|value| !value.is_empty()) {
        None => Ok(default.to_string()),
        Some(value @ (SCOPE_ALL | SCOPE_DEVELOPERS)) => Ok(value.to_string()),
        Some(other) => Err(format!(
            "unknown binding scope '{other}' (expected \"{SCOPE_ALL}\" or \"{SCOPE_DEVELOPERS}\")"
        )),
    }
}

/// Tags are one line of text: collapse whitespace and clamp the label.
fn clamp_source(source: &str) -> String {
    let collapsed = source.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed
        .chars()
        .take(MAX_SOURCE_LENGTH)
        .collect::<String>()
}

// ── Binding reads ──────────────────────────────────────────────────────────

/// One binding as the UI sees it. `invalid` marks a tag the harness would
/// fail closed on (wrong arity or unknown scope) — shown, never hidden.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillBinding {
    pub skill_id: String,
    pub scope: String,
    pub invalid: bool,
}

/// Every persona's bindings, read off the retained kind:30175 heads — the
/// same source `skill_bindings` reads at spawn, so the list is exactly what
/// will be injected.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkillBindings {
    pub persona_id: String,
    pub display_name: String,
    /// Built-in agents have no owner-signed head to carry bindings.
    pub can_bind: bool,
    pub bindings: Vec<SkillBinding>,
    /// Set when the head exists but cannot be read: the bindings are UNKNOWN,
    /// not empty, and the UI must say so (rule: states honest).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_error: Option<String>,
}

/// Read every persona's skill bindings from the active retention scope.
#[tauri::command]
pub async fn fetch_skill_bindings(app: AppHandle) -> Result<Vec<AgentSkillBindings>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let scope = crate::managed_agents::retention::active_retention_scope(&app, &state)?;
        let conn = open_retention_db(&scope.db_path)?;
        let owner = scope.owner_keys.public_key().to_hex();
        let personas = load_personas(&app)?;

        let mut out = Vec::with_capacity(personas.len());
        for persona in &personas {
            let can_bind = !persona.is_builtin;
            let (bindings, read_error) = if can_bind {
                match read_bindings_at(&conn, &owner, &persona_d_tag(persona)) {
                    Ok(bindings) => (bindings, None),
                    // The head is unreadable: report the agent with an error
                    // rather than rendering an empty (=="nothing bound") list.
                    Err(error) => (Vec::new(), Some(error)),
                }
            } else {
                (Vec::new(), None)
            };
            out.push(AgentSkillBindings {
                persona_id: persona.id.clone(),
                display_name: persona.display_name.clone(),
                can_bind,
                bindings,
                read_error,
            });
        }
        Ok(out)
    })
    .await
    .map_err(|error| format!("spawn_blocking failed: {error}"))?
}

/// Strict read of one retained head's `skill` tags.
///
/// Strict, unlike the spawn path's fail-open: the UI would rather show an
/// error than show bindings that are not there.
fn read_bindings_at(
    conn: &rusqlite::Connection,
    owner: &str,
    d_tag: &str,
) -> Result<Vec<SkillBinding>, String> {
    let row = get_retained_event(conn, buzz_core_pkg::kind::KIND_PERSONA, owner, d_tag)
        .map_err(|error| format!("could not read this agent's published head: {error}"))?;
    let Some(row) = row else {
        return Ok(Vec::new());
    };
    let event: nostr::Event = serde_json::from_str(&row.raw_event)
        .map_err(|error| format!("this agent's published head is unreadable: {error}"))?;
    let raw: Vec<Vec<String>> = event
        .tags
        .iter()
        .map(|tag| tag.as_slice().to_vec())
        .collect();
    Ok(bindings_from_raw(&raw))
}

/// Raw `skill` tags → projections. Arity and scope are the harness's
/// fail-closed contract (`buzz-acp::project_skills::parse_bindings`), so a
/// tag that would be dropped there is flagged instead of disappearing here.
fn bindings_from_raw(raw: &[Vec<String>]) -> Vec<SkillBinding> {
    collect_skill_binding_tags(raw)
        .into_iter()
        .map(|tag| {
            let invalid = tag.len() < 3 || !matches!(tag[2].as_str(), SCOPE_ALL | SCOPE_DEVELOPERS);
            SkillBinding {
                skill_id: tag.get(1).cloned().unwrap_or_default(),
                scope: tag.get(2).cloned().unwrap_or_default(),
                invalid,
            }
        })
        .collect()
}

// ── Binding edits ──────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetSkillBindingInput {
    pub persona_id: String,
    pub change: SkillBindingChange,
}

/// The three deliberate edits. `Clear` is the explicit-tag-intent empty set —
/// every binding removed in one head.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
pub enum SkillBindingChange {
    #[serde(rename = "bind")]
    Bind {
        #[serde(rename = "skillId")]
        skill_id: String,
        scope: String,
    },
    #[serde(rename = "unbind")]
    Unbind {
        #[serde(rename = "skillId")]
        skill_id: String,
    },
    #[serde(rename = "clear")]
    Clear,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SkillPublicationStatus {
    Published,
    Queued,
    /// The requested edit was already the current state — nothing signed.
    Unchanged,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillBindingChangeResult {
    pub publication_status: SkillPublicationStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relay_message: Option<String>,
    pub changed: bool,
    /// The persona's bindings as they now stand in the retained head — the
    /// renderer renders from this, never from an optimistic local guess.
    pub bindings: Vec<SkillBinding>,
}

/// Bind, unbind, or clear a persona's skill bindings.
///
/// The edit is computed as full tag intent and retained locally FIRST (the
/// store lock is held across read + compute + retain, so no other write can
/// interleave), then awaited against the relay exactly like the share toggle:
/// acceptance reports `published`, rejection reports `queued` with the relay's
/// message — the local head is already authoritative for spawn either way, and
/// the flush loop keeps owning the relay copy. Anything failing BEFORE the
/// retain propagates, leaving the head (and the binding on screen) untouched.
#[tauri::command]
pub async fn set_persona_skill_binding(
    input: SetSkillBindingInput,
    app: AppHandle,
) -> Result<SkillBindingChangeResult, String> {
    enum Outcome {
        Unchanged(Vec<SkillBinding>),
        // Boxed: `PreparedPersonaPublication` is the large variant (clippy
        // `large_enum_variant`) and this value crosses a `spawn_blocking`
        // boundary as one heap allocation anyway.
        Changed(Box<PreparedPersonaPublication>, Vec<SkillBinding>),
    }

    let outcome = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        let change = input.change.clone();
        let persona_id = input.persona_id.clone();
        move || -> Result<Outcome, String> {
            let state = app.state::<AppState>();
            let _store_guard = state
                .managed_agents_store_lock
                .lock()
                .map_err(|error| error.to_string())?;
            let scope = crate::managed_agents::retention::active_retention_scope(&app, &state)?;
            let conn = open_retention_db(&scope.db_path)?;
            let personas = load_personas(&app)?;
            let persona = personas
                .iter()
                .find(|record| record.id == persona_id)
                .ok_or_else(|| format!("agent {persona_id} not found"))?;
            if persona.is_builtin {
                return Err(format!(
                    "{} is a built-in agent and cannot carry skill bindings",
                    persona.display_name
                ));
            }

            let owner = scope.owner_keys.public_key().to_hex();
            let head = read_head(&conn, &owner, &persona_d_tag(persona))?;
            let carried = head.as_ref().map(carried_forward_tags).unwrap_or_default();
            let (next, changed) = apply_binding_change(&carried, &change)?;
            let bindings = bindings_from_raw(
                &next
                    .iter()
                    .map(|tag| tag.as_slice().to_vec())
                    .collect::<Vec<_>>(),
            );
            if !changed {
                return Ok(Outcome::Unchanged(bindings));
            }

            let (event, retained, scoped) = prepare_persona_publication_at_with_tags(
                &scope.db_path,
                &scope.owner_keys,
                persona,
                None,
                next,
            )?;
            Ok(Outcome::Changed(
                Box::new(PreparedPersonaPublication {
                    scope,
                    event,
                    retained,
                    persona: scoped,
                }),
                bindings,
            ))
        }
    })
    .await
    .map_err(|error| format!("spawn_blocking failed: {error}"))??;

    match outcome {
        Outcome::Unchanged(bindings) => Ok(SkillBindingChangeResult {
            publication_status: SkillPublicationStatus::Unchanged,
            relay_message: None,
            changed: false,
            bindings,
        }),
        Outcome::Changed(prepared, bindings) => {
            let state = app.state::<AppState>();
            let result = publish_prepared_persona(&state, *prepared).await;
            let (publication_status, relay_message) = match result {
                Ok(result) => (
                    match result.publication_status {
                        PersonaSharePublicationStatus::Published => {
                            SkillPublicationStatus::Published
                        }
                        PersonaSharePublicationStatus::Queued => SkillPublicationStatus::Queued,
                    },
                    result.relay_message,
                ),
                // The head is already retained with `pending_sync = 1`; a
                // failure while recording the relay outcome only means the
                // flush loop still owns the relay copy. Never reported as a
                // failed edit — and never as a successful publish.
                Err(error) => (
                    SkillPublicationStatus::Queued,
                    Some(format!("saved locally; relay outcome unknown: {error}")),
                ),
            };
            Ok(SkillBindingChangeResult {
                publication_status,
                relay_message,
                changed: true,
                bindings,
            })
        }
    }
}

fn read_head(
    conn: &rusqlite::Connection,
    owner: &str,
    d_tag: &str,
) -> Result<Option<nostr::Event>, String> {
    use nostr::JsonUtil;

    let row = get_retained_event(conn, buzz_core_pkg::kind::KIND_PERSONA, owner, d_tag)
        .map_err(|error| format!("could not read this agent's published head: {error}"))?;
    row.map(|row| {
        nostr::Event::from_json(&row.raw_event)
            .map_err(|error| format!("this agent's published head is unreadable: {error}"))
    })
    .transpose()
}

/// Apply one binding edit to the carried tag set.
///
/// Returns the new carried set plus whether anything actually changed — a
/// no-op edit is never signed. `unbind` removes exactly the tags naming that
/// skill id (one binding on a well-formed head), every other tag — `marker`,
/// other bindings, everything — stays byte-identical; `clear` returns the
/// empty set, which `build_persona_event_with_tags` treats as the explicit
/// clear (only `d`/`shared` survive).
pub(super) fn apply_binding_change(
    carried: &[nostr::Tag],
    change: &SkillBindingChange,
) -> Result<(Vec<nostr::Tag>, bool), String> {
    match change {
        SkillBindingChange::Clear => Ok((Vec::new(), !carried.is_empty())),
        SkillBindingChange::Unbind { skill_id } => {
            let id = validate_binding_id(skill_id)?;
            let next: Vec<nostr::Tag> = carried
                .iter()
                .filter(|tag| !is_binding_for(tag, &id))
                .cloned()
                .collect();
            let changed = next.len() != carried.len();
            Ok((next, changed))
        }
        SkillBindingChange::Bind { skill_id, scope } => {
            let id = validate_binding_id(skill_id)?;
            let scope = normalize_scope(Some(scope.as_str()), SCOPE_ALL)?;
            let rebound = nostr::Tag::parse(["skill", id.as_str(), scope.as_str()])
                .map_err(|error| format!("invalid skill binding tag: {error}"))?;
            // Replace an existing binding for this id IN PLACE (so a re-scope
            // keeps the binding's position — prompt render order must not
            // shuffle) and drop duplicate tags for the same id. Only a
            // genuinely new binding grows the set, and only then is the cap
            // checked: a 65th tag would be dropped by
            // `collect_skill_binding_tags` before it ever reached the prompt.
            let mut next: Vec<nostr::Tag> = Vec::with_capacity(carried.len() + 1);
            let mut replaced = false;
            for tag in carried {
                if is_binding_for(tag, &id) {
                    if !replaced {
                        next.push(rebound.clone());
                        replaced = true;
                    }
                    continue;
                }
                next.push(tag.clone());
            }
            if !replaced {
                let bound = next
                    .iter()
                    .filter(|tag| {
                        tag.as_slice()
                            .first()
                            .is_some_and(|name| name == SKILL_TAG_NAME)
                    })
                    .count();
                if bound >= MAX_SKILL_BINDINGS {
                    return Err(format!(
                        "this agent already has {MAX_SKILL_BINDINGS} skill bindings — the harness's injection cap. Unbind one before adding another."
                    ));
                }
                next.push(rebound);
            }
            let changed = next.as_slice() != carried;
            Ok((next, changed))
        }
    }
}

fn validate_binding_id(skill_id: &str) -> Result<String, String> {
    let id = skill_id.trim();
    validate_skill_id(id)?;
    Ok(id.to_string())
}

fn is_binding_for(tag: &nostr::Tag, id: &str) -> bool {
    let values = tag.as_slice();
    values.len() >= 2 && values[0] == SKILL_TAG_NAME && values[1] == id
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::managed_agents::retention::{get_retained_event, retain_event, RetainedEvent};
    use nostr::{Event, EventBuilder, JsonUtil, Kind, Tag};
    use sha2::Digest;

    fn skill_doc() -> String {
        "---\nname: ethereum-dev\ndescription: Ethereum dev guidance\n---\n\n# Ethereum\n"
            .to_string()
    }

    fn tag_shapes(event: &Event) -> Vec<Vec<&str>> {
        event
            .tags
            .iter()
            .map(|tag| tag.as_slice().iter().map(String::as_str).collect())
            .collect()
    }

    // ── Parsing / publishing ───────────────────────────────────────────────

    #[test]
    fn published_skill_pins_the_content_sha_and_writes_the_binding_tags() {
        let markdown = skill_doc();
        let meta = buzz_persona_pkg::skill::parse_skill_md(&markdown).unwrap();
        let sha = sha256_hex(&markdown);
        let content_json =
            build_skill_content_json(&meta.name, &meta.description, &sha, &markdown).unwrap();
        let builder = build_skill_event(
            "ethereum-dev",
            "https://x/SKILL.md",
            "all",
            &sha,
            &content_json,
        )
        .unwrap();
        let event = builder.sign_with_keys(&nostr::Keys::generate()).unwrap();

        assert_eq!(event.kind.as_u16() as u32, buzz_core_pkg::kind::KIND_SKILL);
        assert_eq!(
            tag_shapes(&event),
            vec![
                vec!["d", "ethereum-dev"],
                vec!["sha256", sha.as_str()],
                vec!["source", "https://x/SKILL.md"],
                vec!["applies_to", "all"],
            ]
        );

        // Content body: field order is the wire contract, and the pin must be
        // recomputable by the harness over the stored `content` bytes.
        assert!(
            content_json.starts_with(
                "{\"name\":\"ethereum-dev\",\"description\":\"Ethereum dev guidance\",\"sha256\":\""
            ),
            "field order is the wire contract, got: {content_json}"
        );
        let body: serde_json::Value = serde_json::from_str(&event.content).unwrap();
        assert_eq!(body["name"], "ethereum-dev");
        assert_eq!(body["content"], markdown);
        assert!(body["attachments"].as_array().is_some_and(Vec::is_empty));
        assert_eq!(body["sha256"], sha256_hex(markdown.as_str()));
        assert_eq!(sha, hex::encode(sha2::Sha256::digest(markdown.as_bytes())));
    }

    #[test]
    fn frontmatter_contract_errors_are_named_not_generic() {
        assert_eq!(
            buzz_persona_pkg::skill::parse_skill_md("# no frontmatter"),
            Err(buzz_persona_pkg::skill::SkillError::MissingMetadata)
        );
        let oversized = format!(
            "---\nname: x\ndescription: y\n---\n{}",
            "a".repeat(buzz_persona_pkg::skill::SKILL_MAX_CONTENT_BYTES + 1)
        );
        assert_eq!(
            buzz_persona_pkg::skill::parse_skill_md(&oversized),
            Err(buzz_persona_pkg::skill::SkillError::TooLarge)
        );
    }

    #[test]
    fn skill_ids_and_scopes_are_validated_before_signing() {
        assert!(validate_skill_id("ethereum-dev").is_ok());
        assert!(validate_skill_id("").is_err());
        assert!(validate_skill_id("bad\nname").is_err());
        assert!(validate_skill_id(&"x".repeat(MAX_SOURCE_LENGTH + 1)).is_err());

        assert_eq!(normalize_scope(None, SCOPE_ALL).unwrap(), "all");
        assert_eq!(
            normalize_scope(Some("developers"), SCOPE_ALL).unwrap(),
            "developers"
        );
        assert!(normalize_scope(Some("everywhere"), SCOPE_ALL).is_err());
    }

    #[test]
    fn source_label_is_one_line_and_clamped() {
        assert_eq!(clamp_source("  https://a\n b  "), "https://a b");
        assert_eq!(
            clamp_source(&"x".repeat(MAX_SOURCE_LENGTH * 2)).len(),
            MAX_SOURCE_LENGTH
        );
    }

    // ── Head selection ─────────────────────────────────────────────────────

    #[test]
    fn page_merge_keeps_the_nip33_head_and_stops_on_a_short_page() {
        fn head(id: &str, created_at: u64) -> Event {
            EventBuilder::new(Kind::Custom(buzz_core_pkg::kind::KIND_SKILL as u16), "{}")
                .tag(Tag::parse(["d", id]).unwrap())
                .custom_created_at(nostr::Timestamp::from_secs(created_at))
                .sign_with_keys(&nostr::Keys::generate())
                .unwrap()
        }

        let mut heads = std::collections::HashMap::new();
        let newer = head("ethereum-dev", 2_000);
        let older = head("ethereum-dev", 1_000);
        let page = vec![newer.clone(), older.clone()];
        let progress = merge_verified_page(&mut heads, SKILL_PAGE_SIZE, page);
        assert!(matches!(progress, PageProgress::Next(_)));
        assert_eq!(
            heads["ethereum-dev"].id, newer.id,
            "greatest created_at wins"
        );

        // A repeat page cannot advance the cursor: stop rather than loop.
        let progress = merge_verified_page(&mut heads, SKILL_PAGE_SIZE, vec![newer.clone()]);
        assert_eq!(progress, PageProgress::Done);

        // A short page is the end of the library.
        let progress = merge_verified_page(&mut heads, 1, vec![head("review", 3_000)]);
        assert_eq!(progress, PageProgress::Done);
    }

    // ── Binding edits ──────────────────────────────────────────────────────

    fn binding(id: &str, scope: &str) -> Tag {
        Tag::parse(["skill", id, scope]).unwrap()
    }

    #[test]
    fn unbind_removes_exactly_that_binding_and_keeps_the_rest() {
        let marker = Tag::parse(["marker", "template"]).unwrap();
        let head_carried = vec![
            binding("ethereum-dev", "developers"),
            binding("review", "all"),
            marker.clone(),
        ];
        let original = head_carried.clone();

        let (next, changed) = apply_binding_change(
            &head_carried,
            &SkillBindingChange::Unbind {
                skill_id: "ethereum-dev".into(),
            },
        )
        .unwrap();

        assert!(changed);
        assert_eq!(
            next,
            vec![binding("review", "all"), marker.clone()],
            "exactly one binding removed; marker untouched"
        );
        // Byte-identity for everything that survives, not just shape.
        assert_eq!(next[0], original[1]);
        assert_eq!(next[1], original[2]);
    }

    #[test]
    fn clear_all_returns_the_empty_tag_intent() {
        let head_carried = vec![binding("a", "all"), binding("b", "all")];
        let (next, changed) =
            apply_binding_change(&head_carried, &SkillBindingChange::Clear).unwrap();
        assert!(changed);
        assert!(next.is_empty(), "explicit clear passes an empty Vec");

        let (next, changed) = apply_binding_change(&[], &SkillBindingChange::Clear).unwrap();
        assert!(!changed, "clearing nothing is a no-op");
        assert!(next.is_empty());
    }

    #[test]
    fn unbinding_an_unbound_skill_is_reported_as_unchanged() {
        let head_carried = vec![binding("review", "all")];
        let (next, changed) = apply_binding_change(
            &head_carried,
            &SkillBindingChange::Unbind {
                skill_id: "absent".into(),
            },
        )
        .unwrap();
        assert!(!changed);
        assert_eq!(next, head_carried);
    }

    #[test]
    fn bind_appends_and_rebind_replaces_scope_without_touching_others() {
        let head_carried = vec![binding("review", "all")];

        let (next, changed) = apply_binding_change(
            &head_carried,
            &SkillBindingChange::Bind {
                skill_id: "ethereum-dev".into(),
                scope: "developers".into(),
            },
        )
        .unwrap();
        assert!(changed);
        assert_eq!(
            next,
            vec![
                binding("review", "all"),
                binding("ethereum-dev", "developers")
            ]
        );

        let (next, changed) = apply_binding_change(
            &next,
            &SkillBindingChange::Bind {
                skill_id: "review".into(),
                scope: "all".into(),
            },
        )
        .unwrap();
        assert!(!changed, "re-binding the same scope is a no-op");
        assert_eq!(
            next,
            vec![
                binding("review", "all"),
                binding("ethereum-dev", "developers")
            ]
        );
    }

    #[test]
    fn the_binding_cap_refuses_the_tag_the_harness_would_drop() {
        let head_carried: Vec<Tag> = (0..MAX_SKILL_BINDINGS)
            .map(|index| binding(&format!("skill-{index}"), "all"))
            .collect();

        let error = apply_binding_change(
            &head_carried,
            &SkillBindingChange::Bind {
                skill_id: "one-too-many".into(),
                scope: "all".into(),
            },
        )
        .expect_err("the 65th binding must be refused before it is written");
        assert!(error.contains(&MAX_SKILL_BINDINGS.to_string()), "{error}");

        // Re-binding an id already counted does not grow the set: allowed.
        let (next, changed) = apply_binding_change(
            &head_carried,
            &SkillBindingChange::Bind {
                skill_id: "skill-0".into(),
                scope: "developers".into(),
            },
        )
        .unwrap();
        assert!(changed);
        assert_eq!(next.len(), MAX_SKILL_BINDINGS);
    }

    #[test]
    fn invalid_binding_ids_and_scopes_are_refused() {
        assert!(apply_binding_change(
            &[],
            &SkillBindingChange::Unbind {
                skill_id: "  ".into()
            },
        )
        .is_err());
        assert!(apply_binding_change(
            &[],
            &SkillBindingChange::Bind {
                skill_id: "ok".into(),
                scope: "everyone".into(),
            },
        )
        .is_err());
    }

    // ── Unbind through the production re-publish seam ──────────────────────

    /// Seed a retained kind:30175 head by HAND (never through the production
    /// builder) so a carry-forward regression cannot make the seed agree with
    /// the assertion. Mirrors `pending::tests::seed_binding_head`.
    fn seed_head(db_path: &std::path::Path, keys: &nostr::Keys, tags: Vec<Tag>) -> Event {
        let content = r#"{"display_name":"Catalog Reviewer","system_prompt":"Review."}"#;
        let event = EventBuilder::new(
            Kind::Custom(buzz_core_pkg::kind::KIND_PERSONA as u16),
            content,
        )
        .tags(tags)
        .sign_with_keys(keys)
        .expect("signed seed head");
        let conn = open_retention_db(db_path).unwrap();
        retain_event(
            &conn,
            &RetainedEvent {
                kind: buzz_core_pkg::kind::KIND_PERSONA,
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

    fn persona() -> crate::managed_agents::AgentDefinition {
        use std::collections::BTreeMap;

        crate::managed_agents::AgentDefinition {
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
            shared: true,
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

    /// The deliberate-removal path end to end: carried tags read off a
    /// hand-seeded head, minus exactly one binding, written by the SAME
    /// stage-2 seam every other persona re-publish uses, then read back the
    /// way `skill_bindings` reads it at spawn.
    #[test]
    fn unbind_persists_into_the_retained_head_the_spawn_env_reads() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("retention.db");
        let keys = nostr::Keys::generate();
        let owner = keys.public_key().to_hex();
        let marker = Tag::parse(["marker", "template"]).unwrap();
        seed_head(
            &db_path,
            &keys,
            vec![
                Tag::parse(["d", "catalog-reviewer"]).unwrap(),
                Tag::parse(["shared", "true"]).unwrap(),
                binding("ethereum-dev", "developers"),
                binding("review", "all"),
                marker.clone(),
            ],
        );

        let conn = open_retention_db(&db_path).unwrap();
        let head = read_head(&conn, &owner, "catalog-reviewer")
            .unwrap()
            .expect("seeded head");
        let carried = carried_forward_tags(&head);
        let (next, changed) = apply_binding_change(
            &carried,
            &SkillBindingChange::Unbind {
                skill_id: "ethereum-dev".into(),
            },
        )
        .unwrap();
        assert!(changed);

        let (event, _, _) =
            prepare_persona_publication_at_with_tags(&db_path, &keys, &persona(), None, next)
                .expect("tag-intent re-publish");

        assert_eq!(
            tag_shapes(&event),
            vec![
                vec!["d", "catalog-reviewer"],
                vec!["shared", "true"],
                vec!["skill", "review", "all"],
                vec!["marker", "template"],
            ],
            "d/shared recomputed, the removed binding gone, the rest verbatim"
        );
        assert!(event.content.contains("Review the catalog."));

        // What the spawn env would now read: one binding, not two.
        let raw: Vec<Vec<String>> = event
            .tags
            .iter()
            .map(|tag| tag.as_slice().to_vec())
            .collect();
        let bindings = bindings_from_raw(&raw);
        assert_eq!(
            bindings,
            vec![SkillBinding {
                skill_id: "review".to_string(),
                scope: "all".to_string(),
                invalid: false,
            }]
        );
    }

    /// Clear-all: the same seam with an empty carried set leaves only the
    /// recomputed tags — the explicit clear path.
    #[test]
    fn clear_all_persists_a_head_with_no_bindings() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("retention.db");
        let keys = nostr::Keys::generate();
        let owner = keys.public_key().to_hex();
        seed_head(
            &db_path,
            &keys,
            vec![
                Tag::parse(["d", "catalog-reviewer"]).unwrap(),
                binding("ethereum-dev", "all"),
                binding("review", "all"),
            ],
        );

        let (event, _, _) =
            prepare_persona_publication_at_with_tags(&db_path, &keys, &persona(), None, Vec::new())
                .expect("explicit clear");

        assert_eq!(tag_shapes(&event), vec![vec!["d", "catalog-reviewer"]]);
        let conn = open_retention_db(&db_path).unwrap();
        let row = get_retained_event(
            &conn,
            buzz_core_pkg::kind::KIND_PERSONA,
            &owner,
            "catalog-reviewer",
        )
        .unwrap()
        .unwrap();
        assert!(row.pending_sync, "the clear is enqueued for the flush loop");
        let raw: Vec<Vec<String>> = Event::from_json(&row.raw_event)
            .unwrap()
            .tags
            .iter()
            .map(|tag| tag.as_slice().to_vec())
            .collect();
        assert!(bindings_from_raw(&raw).is_empty());
    }

    #[test]
    fn malformed_binding_tags_are_flagged_not_dropped() {
        let raw = vec![
            vec!["skill".to_string(), "review".to_string()],
            vec![
                "skill".to_string(),
                "odd".to_string(),
                "everyone".to_string(),
            ],
            vec!["skill".to_string(), "ok".to_string(), "all".to_string()],
        ];
        let bindings = bindings_from_raw(&raw);
        assert_eq!(
            bindings.len(),
            3,
            "the harness drops these; the UI shows them"
        );
        assert!(bindings[0].invalid, "arity-2 is dropped downstream");
        assert!(bindings[1].invalid, "unknown scope is dropped downstream");
        assert!(!bindings[2].invalid);
    }

    #[test]
    fn read_bindings_reports_empty_heads_as_empty() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("retention.db");
        let keys = nostr::Keys::generate();
        let owner = keys.public_key().to_hex();
        let conn = open_retention_db(&db_path).unwrap();
        assert_eq!(read_bindings_at(&conn, &owner, "nope").unwrap(), Vec::new());

        seed_head(
            &db_path,
            &keys,
            vec![
                Tag::parse(["d", "catalog-reviewer"]).unwrap(),
                binding("ethereum-dev", "all"),
            ],
        );
        let conn = open_retention_db(&db_path).unwrap();
        assert_eq!(
            read_bindings_at(&conn, &owner, "catalog-reviewer").unwrap(),
            vec![SkillBinding {
                skill_id: "ethereum-dev".to_string(),
                scope: "all".to_string(),
                invalid: false,
            }]
        );
    }
}
