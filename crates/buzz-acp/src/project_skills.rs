//! Persona skill bindings → the `<project-skills>` standing-context section.
//!
//! # The wire contract this implements
//!
//! * `buzz_core::kind::KIND_SKILL` (kind:30180) is a NIP-33 parameterized
//!   replaceable "agent skill definition" event. Its content is the JSON body
//!   `{name, description, sha256, content, attachments}` written by
//!   `buzz-cli`'s `templates apply`
//!   (`crates/buzz-cli/src/commands/templates/apply.rs`, `SkillEventBody`),
//!   where `content` is
//!   the full `SKILL.md` text and `sha256` pins those exact bytes.
//!   `crates/buzz-core/src/kind.rs` (`KIND_SKILL`) documents the kind.
//! * A template apply tags **every** persona event it publishes with one
//!   `["skill", "<skill-id>", "developers"|"all"]` tag per template skill
//!   (`apply.rs`, `StepKind::Persona` — "scope recorded verbatim"). Those tags
//!   ride on the kind:30175 persona event.
//! * The desktop hands this harness the persona's raw binding tags at spawn
//!   time in `BUZZ_ACP_SKILL_BINDINGS` (see
//!   `desktop/src-tauri/src/managed_agents/skill_bindings.rs`) — the harness
//!   cannot read kind:30175 itself, because that kind is
//!   author-only-unless-shared (`SHARED_GATED_KINDS` in `buzz-core`) and the
//!   harness authenticates as the agent, not the owner.
//!
//! # Injection rules
//!
//! * **Bounded** — at most [`MAX_SKILL_BINDINGS`] bindings and
//!   [`MAX_PROJECT_SKILL_BYTES`] bytes of skill content reach the prompt. The
//!   overflow is reported by [`TRUNCATION_MARKER`] plus an omission list; it
//!   is never silent.
//! * **Content-addressed** — two bound skills whose `content` bytes hash equal
//!   are injected once.
//! * **Deterministic** — skills are ordered by `(name, id)`, independent of
//!   binding-tag order and of relay return order.
//! * **Version-true** — every resolve reads kind:30180 fresh from the relay;
//!   NIP-33 keeps only the latest event per `(pubkey, kind, d)`, so a skill
//!   update is picked up on the next resolve. Head selection among several
//!   candidates is [`pick_newest_head`].
//! * **Fail-open for missing skills** — an unresolvable binding drops that
//!   skill and logs; the agent still runs. A resolve failure (timeout, HTTP
//!   error, malformed response) injects nothing and logs.
//! * **Fail-closed for malformed binding tags** — a tag that is not exactly
//!   `["skill", "<non-empty id>", "developers"|"all"]` is ignored and logged
//!   by [`parse_bindings`]; it never reaches the prompt.
//!
//! The section is delivered as standing context: modern (protocol ≥ 2) agents
//! receive it inside `session/new`'s system prompt, legacy agents in their
//! first user message — see `with_project_skills` in `pool.rs` and
//! `StandingContext::sections` in `queue.rs`.

use std::time::Duration;

use nostr::{Alphabet, Filter, Kind, SingleLetterTag};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::relay::RestClient;

/// Total bytes of skill content (header + skill blocks) allowed into one
/// section. Mirrors `buzz_persona::skill::SKILL_MAX_CONTENT_BYTES`: a skill is
/// an instruction set, not a data file, and one skill already cannot exceed
/// this cap on the wire.
pub const MAX_PROJECT_SKILL_BYTES: usize = 64 * 1024;

/// Upper bound on binding tags honoured for one agent.
pub const MAX_SKILL_BINDINGS: usize = 64;

/// Upper bound on skill events requested per resolve — 4 events per bound id
/// is already generous for a NIP-33 address (one head per author).
pub const SKILL_QUERY_LIMIT: usize = 256;

/// One bounded `POST /query` for the bound skill ids.
pub const SKILL_FETCH_TIMEOUT: Duration = Duration::from_secs(3);

/// Named marker appended when the byte cap cut the section. Never silent.
pub const TRUNCATION_MARKER: &str =
    "[project-skills: truncated — 65536-byte total skill cap reached]";

/// Instruction-shaped lead-in the section opens with.
pub const SECTION_INTRO: &str = "Project skills — how this work should be done\n\nStanding instruction sets bound to this project's agents. Follow the skill that matches the work you are doing; where a skill disagrees with a general default, the skill wins.";

/// Inheritance scope recorded verbatim on the persona's binding tag.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkillScope {
    Developers,
    All,
}

impl SkillScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Developers => "developers",
            Self::All => "all",
        }
    }
}

/// One validated persona → skill binding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillBinding {
    pub id: String,
    pub scope: SkillScope,
}

/// Parse raw `["skill", "<id>", "<scope>"]` triples into validated bindings.
///
/// Fail-closed per tag: anything malformed (wrong arity, empty id, unknown
/// scope, not a `skill` tag) is logged and dropped, and a repeated id keeps
/// only its first occurrence. The result is capped at [`MAX_SKILL_BINDINGS`].
pub fn parse_bindings(raw: &[Vec<String>]) -> Vec<SkillBinding> {
    let mut out: Vec<SkillBinding> = Vec::new();
    for tag in raw {
        if out.len() >= MAX_SKILL_BINDINGS {
            tracing::warn!(
                target: "project_skills",
                dropped = raw.len() - out.len(),
                "skill bindings exceed {MAX_SKILL_BINDINGS} — ignoring the rest"
            );
            break;
        }
        let Some(binding) = parse_binding(tag) else {
            continue;
        };
        if out.iter().any(|b| b.id == binding.id) {
            tracing::warn!(
                target: "project_skills",
                skill_id = %binding.id,
                "duplicate skill binding tag — keeping the first"
            );
            continue;
        }
        out.push(binding);
    }
    out
}

fn parse_binding(tag: &[String]) -> Option<SkillBinding> {
    if tag.first().map(String::as_str) != Some("skill") {
        tracing::warn!(
            target: "project_skills",
            "malformed skill binding tag (expected [\"skill\", id, scope]) — ignoring"
        );
        return None;
    }
    if tag.len() != 3 {
        tracing::warn!(
            target: "project_skills",
            arity = tag.len(),
            "malformed skill binding tag — expected exactly 3 elements — ignoring"
        );
        return None;
    }
    let id = tag[1].trim();
    if id.is_empty() {
        tracing::warn!(target: "project_skills", "skill binding tag has an empty id — ignoring");
        return None;
    }
    let scope = match tag[2].as_str() {
        "developers" => SkillScope::Developers,
        "all" => SkillScope::All,
        other => {
            tracing::warn!(
                target: "project_skills",
                scope = %other,
                skill_id = %id,
                "skill binding tag has an unknown scope — ignoring"
            );
            return None;
        }
    };
    Some(SkillBinding {
        id: id.to_string(),
        scope,
    })
}

/// The kind:30180 content body as this harness reads it.
///
/// Mirrors `SkillEventBody` in
/// `crates/buzz-cli/src/commands/templates/apply.rs` (the writer). `attachments`
/// is the reserved growth point and is accepted-but-ignored here.
#[derive(Debug, Deserialize)]
struct SkillEventContent {
    name: String,
    description: String,
    #[serde(default)]
    sha256: String,
    content: String,
    /// Reserved growth point (see `buzz_core::kind::KIND_SKILL`) — parsed so a
    /// future reader change cannot break v1 content, unused in v1.
    #[serde(default)]
    #[allow(dead_code)]
    attachments: Vec<serde_json::Value>,
}

/// One skill fetched from the relay and ready to render.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundSkill {
    /// The binding id (the event's `d` tag).
    pub id: String,
    /// Canonical identity from the SKILL.md frontmatter (the load key).
    pub name: String,
    pub description: String,
    /// `SKILL.md` with its YAML frontmatter removed, trimmed.
    pub body: String,
    /// sha256 of the stored `content` bytes (hex) — the dedupe key.
    pub digest: String,
}

/// One kind:30180 candidate before head selection.
#[derive(Debug, Clone, PartialEq, Eq)]
struct SkillCandidate {
    author: String,
    created_at: u64,
    event_id: String,
    d_tag: Option<String>,
    content: String,
}

/// NIP-33 head selection: the greatest `created_at` wins, ties go to the
/// lowest event id — the same rule the relay applies when it retains a
/// parameterized-replaceable address. Pure so version-true selection is unit
/// testable without a relay.
fn pick_newest_head(mut candidates: Vec<SkillCandidate>) -> Option<SkillCandidate> {
    candidates.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| a.event_id.cmp(&b.event_id))
    });
    candidates.into_iter().next()
}

/// Restrict candidates to the workspace owner's authorship when the owner is
/// known, and drop everything when it is not.
///
/// The binding tag is written by the owner (template apply), so the skill body
/// must come from the same key — otherwise any community member could shadow a
/// bound skill id with a later `created_at` and have their text injected into
/// the agent's system prompt, where "the skill wins" over the general defaults.
/// When the owner is unknown there is nobody to trust, so the agent runs
/// **without** the skill: this is a trust boundary and fails closed.
fn prefer_owner(candidates: Vec<SkillCandidate>, owner_hex: Option<&str>) -> Vec<SkillCandidate> {
    let Some(owner) = owner_hex else {
        if !candidates.is_empty() {
            tracing::warn!(
                target: "project_skills",
                dropped = candidates.len(),
                "no resolved owner pubkey — not loading bound skills (they can only come from the workspace owner)"
            );
        }
        return Vec::new();
    };
    let owner = owner.to_ascii_lowercase();
    let own: Vec<SkillCandidate> = candidates
        .iter()
        .filter(|c| c.author.eq_ignore_ascii_case(&owner))
        .cloned()
        .collect();
    if own.len() < candidates.len() {
        tracing::warn!(
            target: "project_skills",
            ignored = candidates.len() - own.len(),
            "ignoring bound skill events not authored by the workspace owner"
        );
    }
    own
}

/// Fetch every bound skill's current kind:30180 head.
///
/// Fail-open: a timeout, transport error, or unparsable response yields an
/// empty list (logged), never an error the caller must handle.
pub async fn fetch_bound_skills(
    rest: &RestClient,
    bindings: &[SkillBinding],
    owner: Option<&nostr::PublicKey>,
) -> Vec<BoundSkill> {
    if bindings.is_empty() {
        return Vec::new();
    }
    let owner_hex = owner.map(|pk| pk.to_hex());

    let d_values: Vec<String> = bindings.iter().map(|b| b.id.clone()).collect();
    let d_tag = SingleLetterTag::lowercase(Alphabet::D);
    let limit = (d_values.len() * 4 + 16).min(SKILL_QUERY_LIMIT);
    let filter = Filter::new()
        .kind(Kind::Custom(buzz_core::kind::KIND_SKILL as u16))
        .custom_tags(d_tag, d_values)
        .limit(limit);

    let response = match tokio::time::timeout(SKILL_FETCH_TIMEOUT, rest.query(&[filter])).await {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => {
            tracing::warn!(
                target: "project_skills",
                %error,
                "bound skill fetch failed — continuing without project skills"
            );
            return Vec::new();
        }
        Err(_) => {
            tracing::warn!(
                target: "project_skills",
                "bound skill fetch timed out — continuing without project skills"
            );
            return Vec::new();
        }
    };
    let Some(events) = response.as_array() else {
        tracing::warn!(
            target: "project_skills",
            "bound skill query returned a non-array response — continuing without project skills"
        );
        return Vec::new();
    };

    let mut candidates: Vec<SkillCandidate> = Vec::with_capacity(events.len());
    for event in events {
        let Some(candidate) = parse_candidate(event) else {
            continue;
        };
        candidates.push(candidate);
    }

    let mut out = Vec::new();
    for binding in bindings {
        let for_id: Vec<SkillCandidate> = candidates
            .iter()
            .filter(|c| c.d_tag.as_deref() == Some(binding.id.as_str()))
            .cloned()
            .collect();
        let Some(head) = pick_newest_head(prefer_owner(for_id, owner_hex.as_deref())) else {
            tracing::warn!(
                target: "project_skills",
                skill_id = %binding.id,
                "bound skill not found on the relay — agent runs without it"
            );
            continue;
        };
        match bound_skill_from_head(&head, binding) {
            Some(skill) => out.push(skill),
            None => tracing::warn!(
                target: "project_skills",
                skill_id = %binding.id,
                "bound skill content is malformed — agent runs without it"
            ),
        }
    }
    out
}

fn parse_candidate(event: &serde_json::Value) -> Option<SkillCandidate> {
    let event_id = event.get("id")?.as_str()?.to_string();
    let author = event.get("pubkey")?.as_str()?.to_string();
    let created_at = event.get("created_at")?.as_u64()?;
    let content = event.get("content")?.as_str()?.to_string();
    let d_tag = event
        .get("tags")?
        .as_array()?
        .iter()
        .filter_map(|tag| tag.as_array())
        .find(|values| values.first().and_then(serde_json::Value::as_str) == Some("d"))
        .and_then(|values| values.get(1))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    Some(SkillCandidate {
        author,
        created_at,
        event_id,
        d_tag,
        content,
    })
}

fn bound_skill_from_head(head: &SkillCandidate, binding: &SkillBinding) -> Option<BoundSkill> {
    let parsed: SkillEventContent = serde_json::from_str(&head.content).ok()?;
    let content = parsed.content;
    let digest = hex::encode(Sha256::digest(content.as_bytes()));
    if !parsed.sha256.is_empty() && parsed.sha256 != digest {
        // Fail-open: the event is owner-signed, so the body is still the
        // owner's. The declared pin is reported and the computed digest wins
        // (it is what content-addressed dedupe keys on).
        tracing::warn!(
            target: "project_skills",
            skill_id = %binding.id,
            declared = %parsed.sha256,
            computed = %digest,
            "bound skill sha256 pin does not match its content bytes"
        );
    }
    let body = match buzz_persona::persona::split_frontmatter(&content) {
        Ok((_frontmatter, body)) => body.trim().to_string(),
        Err(_) => content.trim().to_string(),
    };
    let name = if parsed.name.trim().is_empty() {
        binding.id.clone()
    } else {
        parsed.name.trim().to_string()
    };
    Some(BoundSkill {
        id: binding.id.clone(),
        name,
        description: parsed.description.trim().to_string(),
        body,
        digest,
    })
}

/// Assemble the fully framed `<project-skills>` section.
///
/// Returns `None` when nothing can be injected (no bindings, or no binding
/// resolved to a skill) so callers render no empty boundary. This function is
/// the injection seam: deterministic, bounded, content-addressed, and loud
/// about every omission.
pub fn assemble_project_skills_section(
    bindings: &[SkillBinding],
    skills: &[BoundSkill],
) -> Option<String> {
    if bindings.is_empty() {
        return None;
    }

    // Bound ids only: an unbound skill can never reach this agent's context.
    let bound: Vec<&str> = bindings.iter().map(|b| b.id.as_str()).collect();

    // Deterministic order: (name, id), independent of binding/relay order.
    let mut selected: Vec<&BoundSkill> = Vec::new();
    for skill in skills {
        if !bound.contains(&skill.id.as_str()) {
            continue;
        }
        selected.push(skill);
    }
    selected.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.id.cmp(&b.id)));
    // Snapshot the resolved ids before dedupe consumes `selected`.
    let resolved_ids: Vec<&str> = selected.iter().map(|s| s.id.as_str()).collect();

    // Content-addressed: identical bytes render once.
    let mut seen_digests: Vec<&str> = Vec::new();
    let mut unique: Vec<&BoundSkill> = Vec::new();
    for skill in selected {
        if seen_digests.contains(&skill.digest.as_str()) {
            tracing::info!(
                target: "project_skills",
                skill_id = %skill.id,
                "duplicate skill content — injecting once"
            );
            continue;
        }
        seen_digests.push(&skill.digest);
        unique.push(skill);
    }

    // Fail-open: name every binding that produced nothing. A binding whose
    // content deduped away was resolved — it is not missing — so this reads the
    // pre-dedupe set.
    let mut missing: Vec<&str> = Vec::new();
    for binding in bindings {
        if !resolved_ids.contains(&binding.id.as_str()) {
            missing.push(&binding.id);
        }
    }
    if !missing.is_empty() {
        tracing::warn!(
            target: "project_skills",
            skills = %missing.join(", "),
            "bound skills unavailable — injecting the rest"
        );
    }
    if unique.is_empty() {
        return None;
    }

    // The binding tag owns the scope (it is recorded verbatim there), so the
    // rendered `applies_to` comes from the binding, never from the fetched event.
    let scope_for = |id: &str| {
        bindings
            .iter()
            .find(|b| b.id == id)
            .map(|b| b.scope)
            .unwrap_or(SkillScope::All)
    };

    let mut body = String::from(SECTION_INTRO);
    body.push_str("\n\n");

    let mut used = body.len();
    let mut omitted: Vec<&str> = Vec::new();
    let mut truncated = false;
    for (index, skill) in unique.iter().enumerate() {
        let block = render_skill_block(skill, scope_for(&skill.id));
        let budget = MAX_PROJECT_SKILL_BYTES.saturating_sub(used);
        if block.len() <= budget {
            body.push_str(&block);
            used += block.len();
            continue;
        }
        if budget > 0 {
            let mut cut = budget;
            while cut > 0 && !block.is_char_boundary(cut) {
                cut -= 1;
            }
            body.push_str(&block[..cut]);
            if cut == 0 {
                // Nothing of this skill reached the prompt: name it as omitted
                // rather than letting the marker imply it was rendered.
                omitted.push(skill.name.as_str());
            }
        } else {
            omitted.push(skill.name.as_str());
        }
        truncated = true;
        omitted.extend(unique[index + 1..].iter().map(|s| s.name.as_str()));
        break;
    }

    if truncated {
        body.push('\n');
        body.push_str(TRUNCATION_MARKER);
        if !omitted.is_empty() {
            body.push_str("\nOmitted skills: ");
            body.push_str(&omitted.join(", "));
        }
        body.push('\n');
    }

    Some(crate::prompt_framing::semantic_section(
        "project-skills",
        body.trim_end(),
    ))
}

fn render_skill_block(skill: &BoundSkill, scope: SkillScope) -> String {
    format!(
        "## {}\nDescription: {}\nBinding: {} (applies_to: {})\n\n{}\n\n",
        crate::prompt_framing::escape_semantic_text(&skill.name),
        crate::prompt_framing::escape_semantic_text(&skill.description),
        crate::prompt_framing::escape_semantic_text(&skill.id),
        scope.as_str(),
        skill.body,
    )
}

/// Resolve the section for one prompt task from `ctx`.
///
/// Returns `None` without touching the relay when the persona bound no skills
/// (the overwhelmingly common case), so unbound agents pay nothing.
pub(crate) async fn resolve_project_skills(ctx: &crate::pool::PromptContext) -> Option<String> {
    if ctx.skill_bindings.is_empty() {
        return None;
    }
    let skills = fetch_bound_skills(
        &ctx.rest_client,
        &ctx.skill_bindings,
        ctx.agent_owner_pubkey.as_ref(),
    )
    .await;
    assemble_project_skills_section(&ctx.skill_bindings, &skills)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding(id: &str, scope: SkillScope) -> SkillBinding {
        SkillBinding {
            id: id.to_string(),
            scope,
        }
    }

    fn skill(id: &str, name: &str, body: &str) -> BoundSkill {
        BoundSkill {
            id: id.to_string(),
            name: name.to_string(),
            description: format!("{name} description"),
            body: body.to_string(),
            // Mirrors production: the digest keys on the skill's own bytes, so
            // two bindings that resolve to identical content collapse to one.
            digest: hex::encode(Sha256::digest(body.as_bytes())),
        }
    }

    fn triple(id: &str, scope: &str) -> Vec<String> {
        vec!["skill".to_string(), id.to_string(), scope.to_string()]
    }

    // ---- binding parsing (fail-closed) ----

    #[test]
    fn parses_valid_binding_tags_in_order() {
        let raw = vec![
            triple("ethereum-dev", "developers"),
            triple("review", "all"),
        ];
        assert_eq!(
            parse_bindings(&raw),
            vec![
                binding("ethereum-dev", SkillScope::Developers),
                binding("review", SkillScope::All),
            ]
        );
    }

    #[test]
    fn malformed_binding_tags_are_ignored_not_injected() {
        let raw = vec![
            vec!["skill".to_string(), "no-scope".to_string()],
            vec!["skill".to_string(), String::new(), "developers".to_string()],
            vec![
                "skill".to_string(),
                "bad-scope".to_string(),
                "admins".to_string(),
            ],
            vec![
                "not-a-skill".to_string(),
                "x".to_string(),
                "all".to_string(),
            ],
            triple("good", "all"),
        ];
        assert_eq!(parse_bindings(&raw), vec![binding("good", SkillScope::All)]);
    }

    #[test]
    fn duplicate_binding_ids_keep_the_first() {
        let raw = vec![triple("a", "all"), triple("a", "developers")];
        assert_eq!(parse_bindings(&raw), vec![binding("a", SkillScope::All)]);
    }

    #[test]
    fn binding_count_is_capped() {
        let raw: Vec<Vec<String>> = (0..MAX_SKILL_BINDINGS + 5)
            .map(|i| triple(&format!("skill-{i}"), "all"))
            .collect();
        assert_eq!(parse_bindings(&raw).len(), MAX_SKILL_BINDINGS);
    }

    // ---- head selection (version-true) ----

    fn candidate(created_at: u64, event_id: &str) -> SkillCandidate {
        SkillCandidate {
            author: "author".into(),
            created_at,
            event_id: event_id.into(),
            d_tag: Some("ethereum-dev".into()),
            content: "{}".into(),
        }
    }

    #[test]
    fn head_selection_prefers_the_newest_created_at() {
        let head =
            pick_newest_head(vec![candidate(100, "bbbb"), candidate(200, "aaaa")]).expect("head");
        assert_eq!(head.event_id, "aaaa");
        assert_eq!(head.created_at, 200);
    }

    #[test]
    fn head_selection_breaks_created_at_ties_on_lowest_event_id() {
        let head =
            pick_newest_head(vec![candidate(200, "bbbb"), candidate(200, "aaaa")]).expect("head");
        assert_eq!(head.event_id, "aaaa");
    }

    #[test]
    fn owner_authorship_wins_over_a_later_foreign_head() {
        let mut own = candidate(100, "aaaa");
        own.author = "OWNER".into();
        let mut foreign = candidate(900, "cccc");
        foreign.author = "someone-else".into();
        let picked = pick_newest_head(prefer_owner(vec![own.clone(), foreign], Some("owner")))
            .expect("head");
        assert_eq!(picked.event_id, "aaaa");
    }

    #[test]
    fn unknown_owner_loads_no_skills_at_all() {
        // Fail closed: with no owner to trust, neither the owner-looking nor a
        // foreign head may reach the prompt — a member must not be able to
        // inject instructions by publishing a newer head for a bound id.
        let mut own = candidate(100, "aaaa");
        own.author = "OWNER".into();
        let mut foreign = candidate(900, "cccc");
        foreign.author = "someone-else".into();
        assert!(prefer_owner(vec![own, foreign], None).is_empty());
        assert_eq!(
            pick_newest_head(prefer_owner(vec![candidate(1, "dddd")], None)),
            None
        );
    }

    // ---- assembly seam ----

    #[test]
    fn no_bindings_never_renders_a_section() {
        assert_eq!(assemble_project_skills_section(&[], &[]), None);
    }

    #[test]
    fn missing_skills_render_nothing_and_stay_fail_open() {
        let bindings = vec![binding("ethereum-dev", SkillScope::Developers)];
        assert_eq!(assemble_project_skills_section(&bindings, &[]), None);
    }

    /// Snapshot of the assembled section for a fully resolvable binding.
    #[test]
    fn assembled_section_snapshot() {
        let bindings = vec![
            binding("ethereum-dev", SkillScope::Developers),
            binding("review", SkillScope::All),
        ];
        let skills = vec![
            skill("ethereum-dev", "ethereum-dev", "# Ethereum\nDo the thing."),
            skill("review", "review", "# Review\nCheck the thing."),
        ];
        let section = assemble_project_skills_section(&bindings, &skills).expect("section renders");
        let expected = "<project-skills>\nProject skills — how this work should be done\n\nStanding instruction sets bound to this project's agents. Follow the skill that matches the work you are doing; where a skill disagrees with a general default, the skill wins.\n\n## ethereum-dev\nDescription: ethereum-dev description\nBinding: ethereum-dev (applies_to: developers)\n\n# Ethereum\nDo the thing.\n\n## review\nDescription: review description\nBinding: review (applies_to: all)\n\n# Review\nCheck the thing.\n</project-skills>";
        assert_eq!(section, expected);
    }

    #[test]
    fn skills_are_sorted_by_name_not_by_binding_order() {
        let bindings = vec![
            binding("zeta", SkillScope::All),
            binding("alpha", SkillScope::All),
        ];
        let skills = vec![
            skill("zeta", "zeta", "z body"),
            skill("alpha", "alpha", "a body"),
        ];
        let section = assemble_project_skills_section(&bindings, &skills).expect("section renders");
        let alpha = section.find("## alpha").expect("alpha block");
        let zeta = section.find("## zeta").expect("zeta block");
        assert!(alpha < zeta, "expected name order, got: {section}");
    }

    #[test]
    fn identical_skill_bytes_render_once() {
        let bindings = vec![
            binding("one", SkillScope::All),
            binding("two", SkillScope::All),
        ];
        let same = "# Shared\nsame bytes";
        let skills = vec![skill("one", "one", same), skill("two", "two", same)];
        let section = assemble_project_skills_section(&bindings, &skills).expect("section renders");
        assert_eq!(section.matches(same).count(), 1, "{section}");
        assert!(section.contains("## one"), "{section}");
        assert!(!section.contains("## two"), "{section}");
    }

    #[test]
    fn unbound_skills_never_reach_the_section() {
        let bindings = vec![binding("bound", SkillScope::All)];
        let skills = vec![
            skill("bound", "bound", "bound body"),
            skill("intruder", "intruder", "intruder body"),
        ];
        let section = assemble_project_skills_section(&bindings, &skills).expect("section renders");
        assert!(section.contains("bound body"), "{section}");
        assert!(!section.contains("intruder body"), "{section}");
    }

    #[test]
    fn oversized_skill_content_is_truncated_with_the_named_marker() {
        let bindings = vec![
            binding("huge", SkillScope::All),
            binding("later", SkillScope::All),
        ];
        let huge = "x".repeat(MAX_PROJECT_SKILL_BYTES);
        let skills = vec![
            skill("huge", "huge", &huge),
            skill("later", "later", "later body"),
        ];
        let section = assemble_project_skills_section(&bindings, &skills).expect("section renders");
        assert!(section.contains(TRUNCATION_MARKER), "marker missing");
        assert!(section.contains("Omitted skills: later"), "{section}");
        assert!(!section.contains("later body"), "later skill leaked in");
        // Bounded: header/marker overhead only, never unbounded skill bytes.
        assert!(
            section.len() <= MAX_PROJECT_SKILL_BYTES + 512,
            "section grew to {}",
            section.len()
        );
    }

    #[test]
    fn partial_block_is_cut_on_a_char_boundary() {
        let bindings = vec![binding("big", SkillScope::All)];
        // Multi-byte tail past the cap forces the cut to land inside `é`.
        let body = format!(
            "{}{}",
            "a".repeat(MAX_PROJECT_SKILL_BYTES / 2),
            "é".repeat(20_000)
        );
        assert!(body.len() > MAX_PROJECT_SKILL_BYTES);
        let skills = vec![skill("big", "big", &body)];
        let section = assemble_project_skills_section(&bindings, &skills).expect("section renders");
        assert!(
            section.contains(TRUNCATION_MARKER),
            "expected the named truncation marker"
        );
        assert!(
            section.len() <= MAX_PROJECT_SKILL_BYTES + 512,
            "section grew to {} bytes",
            section.len()
        );
    }
}
