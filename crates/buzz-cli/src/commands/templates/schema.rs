//! Project-template schema (`templates/<id>/template.yaml`) and strict validator.
//!
//! This is the CONTRACT with template content authors. The wire shape is
//! pinned; validation enforces every documented bound at apply time, that
//! every referenced file exists inside the template directory, and that
//! workflow YAML parses through `buzz-workflow`'s schema types (the same
//! parser the relay's ingest uses — reuse, never re-validate loosely).
//!
//! ```yaml
//! id: ai-media-studio          # kebab, matches dir name
//! name: AI Media Studio        # ≤60
//! description: ...             # ≤280, shown in the picker
//! channels:                    # 1..8
//!   - id: writers-room         # kebab
//!     name: writers-room
//!     purpose: ...             # ≤200
//!     seed: welcome.md         # optional; posted as the channel's first message
//! personas:                    # 0..6 — published as kind:30175 persona events
//!   - id: writer
//!     name: The Writer
//!     prompt: personas/writer.md
//!     skills: [ethereum-dev]   # OPTIONAL — skill names this persona inherits;
//!                               # absent ⇒ every template skill (historical
//!                               # default) — this is the per-persona scope
//!                               # selector `applies_to` cannot express
//! workflows:                   # 0..6 — created via the workflow create path
//!   - file: workflows/nightly-standup.yaml
//!     channel: standup         # OPTIONAL — a channel `id` from THIS file;
//!                               # the workflow's channel binding (its h-tag),
//!                               # so a `message_posted` trigger fires only for
//!                               # messages in that channel. Defaults to
//!                               # `channels[0]` when absent (backward compat).
//! docs:                        # 0..8 — seeded as NIP-23 notes (team KB)
//!   - file: docs/story-bible.md
//!     title: Story Bible
//! skills:                      # 0..8 — Agent Skills SKILL.md definitions
//!   - name: ethereum-dev       # ≤60
//!     source: https://ethskills.com/SKILL.md   # https URL or template-relative file
//!     applies_to: developers   # "developers" | "all"
//! welcome: welcome.md          # posted to the FIRST channel + returned for the UI
//! org:                         # OPTIONAL — seeds the community org (see below)
//!   root:
//!     name: Studio             # ≤60 — the founder seat; the applying user holds it
//!     blurb: Founders          # optional, ≤120
//!   seats:                     # 0..6 — one vacant agent seat per persona
//!     - persona: writer        # a persona `id` from THIS file
//!       title: Head of Story   # optional seat title (default: the persona name)
//!   default_budget:            # the community default agent budget (subject "*")
//!     window: day              # epoch | day | week | month (default day)
//!     runs: 200                # optional caps, each 1..=1_000_000
//!     tasks_create: 20
//!     messages: 300
//!     llm_calls: 200
//! ```
//!
//! # The `org` block wires the template into the org and its budgets
//!
//! The DAO-OS contract (`docs/dao-os.md`, rules R1/R2) is that every agent is
//! covered by a budget from the moment it joins and sits in a seat under a
//! founder root. The `org` block is how a template delivers that in one apply:
//!
//! * `root` → a kind:37010 role node with id `root`, held by the applying user
//!   (only the community owner/admin may create a root — the relay enforces
//!   it). An existing `root` node is never overwritten.
//! * `seats[]` → one kind:37010 `agent-seat` node per persona with the
//!   deterministic id `seat-<persona-id>`, parented to `root`, holder list
//!   empty (the seat is *vacant* until a persona instance is attached — the
//!   desktop attaches the agent it deploys to `seat-<persona-id>`).
//! * `default_budget` → a kind:37012 budget with subject `"*"` and id
//!   `default-agents`: the relay applies it to every agent that has no budget
//!   of its own. Overruns become approval requests, never silent stops.
//!
//! Every event carries the template marker tag, so re-apply and `--resume`
//! skip what already exists (idempotent, consistent-prefix execution).
//!
//! All referenced files live under `templates/<id>/`. Referenced paths must be
//! relative and stay inside the template directory (no `..`, no absolute).
//!
//! # Channel binding semantics
//!
//! Every channel-scoped item the apply engine writes resolves a channel id the
//! same way: the item's declared `channel` id, else — when it declares none —
//! `channels[0]`.
//!
//! * `workflows[].channel` is OPTIONAL and validated against the declared
//!   channel ids; an unknown id is a named validation error. The resolved id
//!   becomes the workflow definition's `["h", <uuid>]` tag at apply time, and
//!   the relay only evaluates a workflow against messages **in its own
//!   channel** (`buzz_workflow::WorkflowEngine::on_event` →
//!   `list_enabled_channel_workflows(community, channel_id)`), so this field —
//!   not the workflow YAML — is what decides where a `message_posted` trigger
//!   fires. Binding here (rather than inside the workflow file) keeps shared
//!   workflow files byte-identical across templates.
//! * `welcome` has no override and by design posts to `channels[0]` — that is
//!   the welcome's designed home, and the reason a template that wants the
//!   welcome in a specific room lists that room first (or binds its
//!   `message_posted` workflows elsewhere).
//!
//! # `applies_to` is metadata; per-persona scoping is `personas[].skills`
//!
//! By default the apply engine writes one `["skill", <id>, <applies_to>]`
//! binding tag per template skill onto **every** persona event it publishes,
//! and the consumer (`buzz-acp::project_skills`) keys on tag *presence* and
//! records the scope verbatim — it does not filter personas by role. So
//! `applies_to: developers` alone never limits a skill to "developer"
//! personas: it is honest metadata about who the skill is written for, not a
//! runtime access boundary.
//!
//! The declarative scoping seam is `personas[].skills`: an explicit list of
//! skill names a persona inherits. The apply engine honours it end-to-end
//! (the persona event carries exactly those `skill` tags; the desktop hands
//! the persona's own tags to the harness and the harness injects per persona),
//! so a template scopes skills by naming recipients — never by inferring a
//! persona's role from its name.

use std::collections::BTreeMap;

use serde::Deserialize;

use crate::error::CliError;

/// Longest accepted `name` field in a template.
pub const MAX_NAME: usize = 60;
/// Longest accepted `description` field in a template.
pub const MAX_DESCRIPTION: usize = 280;
/// Longest accepted `purpose` field in a template.
pub const MAX_PURPOSE: usize = 200;
/// Channels a single template may define.
pub const MAX_CHANNELS: usize = 8;
/// Personas a single template may define.
pub const MAX_PERSONAS: usize = 6;
/// Workflows a single template may define.
pub const MAX_WORKFLOWS: usize = 6;
/// Docs a single template may reference.
pub const MAX_DOCS: usize = 8;
/// Skills a single template may reference.
pub const MAX_SKILLS: usize = 8;
/// Vacant agent seats a template may seed (one per persona at most).
pub const MAX_ORG_SEATS: usize = MAX_PERSONAS;
/// Longest founder-seat blurb.
pub const MAX_ORG_BLURB: usize = 120;
/// Ceiling on any default-budget counter (a template is a starting point, not
/// an unlimited grant).
pub const MAX_DEFAULT_BUDGET_LIMIT: u32 = 1_000_000;
/// The org node id the template's founder seat uses.
pub const ORG_ROOT_NODE_ID: &str = "root";
/// The budget id (`d`) of the community default agent budget.
pub const ORG_DEFAULT_BUDGET_ID: &str = "default-agents";
/// Uniform bound on every referenced text file (matches the SDK builders'
/// `check_content(64 * 1024)` and `buzz_persona::skill`'s skill bound).
pub const MAX_FILE_BYTES: usize = 64 * 1024;

/// In-memory file tree of one template (`relative path` → content).
///
/// Embedded templates and test fixtures both resolve through this, so the
/// validator and apply engine share one seam.
#[derive(Debug, Default, Clone)]
pub struct TemplateFiles(BTreeMap<String, String>);

impl TemplateFiles {
    pub fn from_pairs<I: IntoIterator<Item = (String, String)>>(pairs: I) -> Self {
        Self(pairs.into_iter().collect())
    }

    pub fn get(&self, rel: &str) -> Option<&str> {
        self.0.get(rel).map(String::as_str)
    }

    // Exercised by the registry/plan tests through this public seam; kept
    // live for future callers rather than gating the API on cfg(test).
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn len(&self) -> usize {
        self.0.len()
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
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

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateSkill {
    pub name: String,
    pub source: String,
    pub applies_to: SkillScope,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateChannel {
    pub id: String,
    pub name: String,
    pub purpose: String,
    #[serde(default)]
    pub seed: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplatePersona {
    pub id: String,
    pub name: String,
    pub prompt: String,
    /// Optional skill-scope override: the exact template skill names this
    /// persona inherits. Absent ⇒ every template skill binds to this persona
    /// (the historical behavior, unchanged for existing templates). Each id
    /// must name a skill declared in this same file — this is the declarative
    /// per-persona scoping that `applies_to` alone cannot express (see the
    /// module docs), and the only sanctioned way to scope skills per persona.
    #[serde(default)]
    pub skills: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateWorkflow {
    pub file: String,
    /// Channel binding: a channel `id` declared in this same template.
    /// Absent ⇒ `channels[0]` (the pre-`channel` behavior, kept for backward
    /// compatibility). Resolved to a UUID at apply time and written as the
    /// workflow definition's `h` tag — the relay evaluates a `message_posted`
    /// trigger only against messages in that channel.
    #[serde(default)]
    pub channel: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateDoc {
    pub file: String,
    pub title: String,
}

/// The founder seat an `org` block creates.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateOrgRoot {
    pub name: String,
    #[serde(default)]
    pub blurb: Option<String>,
}

/// One vacant agent seat, bound to a persona by id.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateOrgSeat {
    /// A persona `id` declared in this same file.
    pub persona: String,
    /// Optional seat title; defaults to the persona's display name.
    #[serde(default)]
    pub title: Option<String>,
}

/// The community default agent budget (relay subject `"*"`).
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateDefaultBudget {
    /// `epoch` | `day` | `week` | `month`; absent ⇒ `day`.
    #[serde(default)]
    pub window: Option<String>,
    #[serde(default)]
    pub runs: Option<u32>,
    #[serde(default)]
    pub tasks_create: Option<u32>,
    #[serde(default)]
    pub messages: Option<u32>,
    #[serde(default)]
    pub llm_calls: Option<u32>,
}

/// The optional `org:` block — see the module docs.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateOrg {
    pub root: TemplateOrgRoot,
    #[serde(default)]
    pub seats: Vec<TemplateOrgSeat>,
    #[serde(default)]
    pub default_budget: Option<TemplateDefaultBudget>,
}

/// The parsed `template.yaml`. Fields map 1:1 onto the pinned contract; the
/// optional blocks default to empty (a template with no `skills:` is valid).
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Template {
    pub id: String,
    pub name: String,
    pub description: String,
    pub channels: Vec<TemplateChannel>,
    #[serde(default)]
    pub personas: Vec<TemplatePersona>,
    #[serde(default)]
    pub workflows: Vec<TemplateWorkflow>,
    #[serde(default)]
    pub docs: Vec<TemplateDoc>,
    #[serde(default)]
    pub skills: Vec<TemplateSkill>,
    /// Optional org seeding (founder seat, vacant agent seats, default budget).
    #[serde(default)]
    pub org: Option<TemplateOrg>,
    pub welcome: String,
}

/// The deterministic org node id of the seat a persona's agent sits in.
pub fn seat_node_id(persona_id: &str) -> String {
    format!("seat-{persona_id}")
}

/// Kebab id: lowercase alphanumerics separated by single dashes.
fn is_kebab(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !s.starts_with('-')
        && !s.ends_with('-')
        && !s.contains("--")
}

/// NIP-AP persona slug grammar `^[a-z0-9][a-z0-9_-]{0,63}$` — enforced by the
/// relay on kind:30175 `d` tags, so it must hold before we ever publish.
fn is_persona_slug(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.is_empty() || bytes.len() > 64 {
        return false;
    }
    if !bytes[0].is_ascii_lowercase() && !bytes[0].is_ascii_digit() {
        return false;
    }
    bytes[1..]
        .iter()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_' || *b == b'-')
}

/// NIP-23 note slug grammar `[a-z0-9._-]{1,80}` (the `notes set --name` bound).
fn is_note_slug(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 80
        && s.chars().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '_' || c == '-'
        })
}

/// Resolve a template-relative reference and read its content, enforcing that
/// the path stays inside the template directory and the file exists.
fn read_ref<'a>(files: &'a TemplateFiles, what: &str, rel: &str) -> Result<&'a str, String> {
    if rel.trim().is_empty() {
        return Err(format!("{what}: file path must not be empty"));
    }
    if rel.starts_with('/') || rel.starts_with('\\') || rel.contains('\\') {
        return Err(format!(
            "{what}: file path must be template-relative (got {rel})"
        ));
    }
    if rel.split('/').any(|seg| seg == ".." || seg.is_empty()) {
        return Err(format!(
            "{what}: file path escapes the template directory (got {rel})"
        ));
    }
    let content = files
        .get(rel)
        .ok_or_else(|| format!("{what}: referenced file does not exist: {rel}"))?;
    if content.trim().is_empty() {
        return Err(format!("{what}: referenced file must not be empty: {rel}"));
    }
    if content.len() > MAX_FILE_BYTES {
        return Err(format!(
            "{what}: referenced file exceeds {MAX_FILE_BYTES} bytes: {rel}"
        ));
    }
    Ok(content)
}

/// Strict validation of a template against the pinned contract. Returns every
/// bound violation as a precise error; on `Ok` the template is safe to apply.
///
/// `dir_name` is the template's directory name — the contract requires
/// `id` to match it exactly.
pub fn validate_template(
    dir_name: &str,
    template: &Template,
    files: &TemplateFiles,
) -> Result<(), String> {
    if !is_kebab(&template.id) {
        return Err(format!("id must be kebab-case: '{}'", template.id));
    }
    if template.id != dir_name {
        return Err(format!(
            "id must match the directory name (got '{}', expected '{dir_name}')",
            template.id
        ));
    }
    if template.name.trim().is_empty() {
        return Err("name must not be empty".into());
    }
    if template.name.chars().count() > MAX_NAME {
        return Err(format!("name exceeds {MAX_NAME} characters"));
    }
    if template.description.trim().is_empty() {
        return Err("description must not be empty".into());
    }
    if template.description.chars().count() > MAX_DESCRIPTION {
        return Err(format!("description exceeds {MAX_DESCRIPTION} characters"));
    }

    // Channels: 1..8.
    if template.channels.is_empty() {
        return Err("channels must contain at least 1 channel".into());
    }
    if template.channels.len() > MAX_CHANNELS {
        return Err(format!(
            "channels exceeds {MAX_CHANNELS} entries (got {})",
            template.channels.len()
        ));
    }
    let mut seen_channel_ids = std::collections::HashSet::new();
    for (i, ch) in template.channels.iter().enumerate() {
        let what = format!("channels[{i}]");
        if !is_kebab(&ch.id) {
            return Err(format!("{what}: id must be kebab-case: '{}'", ch.id));
        }
        if !seen_channel_ids.insert(ch.id.clone()) {
            return Err(format!("{what}: duplicate channel id '{}'", ch.id));
        }
        if ch.name.trim().is_empty() {
            return Err(format!("{what}: name must not be empty"));
        }
        if ch.purpose.trim().is_empty() {
            return Err(format!("{what}: purpose must not be empty"));
        }
        if ch.purpose.chars().count() > MAX_PURPOSE {
            return Err(format!("{what}: purpose exceeds {MAX_PURPOSE} characters"));
        }
        if let Some(seed) = &ch.seed {
            read_ref(files, &format!("{what}.seed"), seed)?;
        }
    }

    // Personas: 0..6.
    if template.personas.len() > MAX_PERSONAS {
        return Err(format!(
            "personas exceeds {MAX_PERSONAS} entries (got {})",
            template.personas.len()
        ));
    }
    let mut seen_persona_ids = std::collections::HashSet::new();
    for (i, p) in template.personas.iter().enumerate() {
        let what = format!("personas[{i}]");
        if !is_persona_slug(&p.id) {
            return Err(format!(
                "{what}: id must match the NIP-AP slug grammar ^[a-z0-9][a-z0-9_-]{{0,63}}$ (the relay enforces it on kind:30175): '{}'",
                p.id
            ));
        }
        if !seen_persona_ids.insert(p.id.clone()) {
            return Err(format!("{what}: duplicate persona id '{}'", p.id));
        }
        if p.name.trim().is_empty() {
            return Err(format!("{what}: name must not be empty"));
        }
        read_ref(files, &format!("{what}.prompt"), &p.prompt)?;
        // Optional per-persona skill scope: every id must name a skill
        // declared in THIS file (the struct is fully parsed before validation,
        // so declaration order in the YAML does not matter).
        if let Some(ids) = &p.skills {
            if ids.is_empty() {
                return Err(format!(
                    "{what}: skills must not be empty (omit the field to bind every skill)"
                ));
            }
            let mut seen = std::collections::HashSet::new();
            for id in ids {
                if !template.skills.iter().any(|s| &s.name == id) {
                    let mut declared: Vec<&str> =
                        template.skills.iter().map(|s| s.name.as_str()).collect();
                    declared.sort_unstable();
                    return Err(format!(
                        "{what}: unknown skill id '{id}' (declared skill names: {})",
                        declared.join(", ")
                    ));
                }
                if !seen.insert(id.as_str()) {
                    return Err(format!("{what}: duplicate skill id '{id}'"));
                }
            }
        }
    }

    // Workflows: 0..6, each parsing via buzz-workflow's schema types.
    if template.workflows.len() > MAX_WORKFLOWS {
        return Err(format!(
            "workflows exceeds {MAX_WORKFLOWS} entries (got {})",
            template.workflows.len()
        ));
    }
    let mut seen_workflow_files = std::collections::HashSet::new();
    for (i, w) in template.workflows.iter().enumerate() {
        let what = format!("workflows[{i}]");
        if !seen_workflow_files.insert(w.file.clone()) {
            return Err(format!("{what}: duplicate workflow file '{}'", w.file));
        }
        // Optional channel binding must name a channel declared in THIS file;
        // absent means `channels[0]` (resolved at apply time).
        if let Some(ch) = &w.channel {
            if !seen_channel_ids.contains(ch.as_str()) {
                let mut declared: Vec<&str> = seen_channel_ids.iter().map(String::as_str).collect();
                declared.sort_unstable();
                return Err(format!(
                    "{what}: unknown channel id '{ch}' (declared channel ids: {})",
                    declared.join(", ")
                ));
            }
        }
        let content = read_ref(files, &what, &w.file)?;
        buzz_workflow::schema::parse_yaml(content)
            .map_err(|e| format!("{what}: invalid workflow YAML ({}): {e}", w.file))?;
    }

    // Docs: 0..8 → NIP-23 notes; slug derives from the file stem.
    if template.docs.len() > MAX_DOCS {
        return Err(format!(
            "docs exceeds {MAX_DOCS} entries (got {})",
            template.docs.len()
        ));
    }
    let mut seen_doc_files = std::collections::HashSet::new();
    for (i, d) in template.docs.iter().enumerate() {
        let what = format!("docs[{i}]");
        if !seen_doc_files.insert(d.file.clone()) {
            return Err(format!("{what}: duplicate doc file '{}'", d.file));
        }
        read_ref(files, &what, &d.file)?;
        if d.title.trim().is_empty() {
            return Err(format!("{what}: title must not be empty"));
        }
        let slug = doc_slug(&d.file).unwrap_or_default();
        if !is_note_slug(&slug) {
            return Err(format!(
                "{what}: file stem '{slug}' is not a valid note slug ([a-z0-9._-]{{1,80}})"
            ));
        }
    }

    // Skills: 0..8.
    if template.skills.len() > MAX_SKILLS {
        return Err(format!(
            "skills exceeds {MAX_SKILLS} entries (got {})",
            template.skills.len()
        ));
    }
    let mut seen_skill_names = std::collections::HashSet::new();
    for (i, s) in template.skills.iter().enumerate() {
        let what = format!("skills[{i}]");
        if s.name.trim().is_empty() {
            return Err(format!("{what}: name must not be empty"));
        }
        if s.name.chars().count() > MAX_NAME {
            return Err(format!("{what}: name exceeds {MAX_NAME} characters"));
        }
        if !seen_skill_names.insert(s.name.clone()) {
            return Err(format!("{what}: duplicate skill name '{}'", s.name));
        }
        if s.source.trim().is_empty() {
            return Err(format!("{what}: source must not be empty"));
        }
        if s.source.starts_with("https://") {
            // Remote sources are fetched (bounded) and validated at apply time.
        } else if s.source.starts_with("http://") {
            return Err(format!(
                "{what}: source must be https:// or a template-relative file (got '{}')",
                s.source
            ));
        } else {
            let content = read_ref(files, &what, &s.source)?;
            // File sources validate frontmatter now, with the named error.
            buzz_persona::skill::parse_skill_md(content).map_err(|e| format!("{what}: {e}"))?;
        }
    }

    if let Some(org) = &template.org {
        validate_org(org, template)?;
    }

    // Welcome: posted to the FIRST channel.
    read_ref(files, "welcome", &template.welcome)?;

    Ok(())
}

/// Validate the optional `org:` block against the template's own personas.
fn validate_org(org: &TemplateOrg, template: &Template) -> Result<(), String> {
    if org.root.name.trim().is_empty() {
        return Err("org.root.name must not be empty".into());
    }
    if org.root.name.chars().count() > MAX_NAME {
        return Err(format!("org.root.name exceeds {MAX_NAME} characters"));
    }
    if let Some(blurb) = &org.root.blurb {
        if blurb.chars().count() > MAX_ORG_BLURB {
            return Err(format!("org.root.blurb exceeds {MAX_ORG_BLURB} characters"));
        }
    }

    if org.seats.len() > MAX_ORG_SEATS {
        return Err(format!(
            "org.seats exceeds {MAX_ORG_SEATS} entries (got {})",
            org.seats.len()
        ));
    }
    let mut seen = std::collections::HashSet::new();
    for (i, seat) in org.seats.iter().enumerate() {
        let what = format!("org.seats[{i}]");
        if !template.personas.iter().any(|p| p.id == seat.persona) {
            let mut declared: Vec<&str> = template.personas.iter().map(|p| p.id.as_str()).collect();
            declared.sort_unstable();
            return Err(format!(
                "{what}: unknown persona id '{}' (declared persona ids: {})",
                seat.persona,
                declared.join(", ")
            ));
        }
        if !seen.insert(seat.persona.as_str()) {
            return Err(format!(
                "{what}: duplicate seat for persona '{}'",
                seat.persona
            ));
        }
        if let Some(title) = &seat.title {
            if title.trim().is_empty() {
                return Err(format!("{what}: title must not be empty (omit the field)"));
            }
            if title.chars().count() > MAX_NAME {
                return Err(format!("{what}: title exceeds {MAX_NAME} characters"));
            }
        }
        // The org node `d` grammar is `[a-z0-9._-]{1,64}`: `seat-` + the
        // persona slug must fit.
        if seat_node_id(&seat.persona).len() > buzz_core::org_grant::ORG_D_MAX_LEN {
            return Err(format!(
                "{what}: seat id 'seat-{}' exceeds {} bytes",
                seat.persona,
                buzz_core::org_grant::ORG_D_MAX_LEN
            ));
        }
    }

    if let Some(b) = &org.default_budget {
        if let Some(w) = &b.window {
            if !matches!(w.as_str(), "epoch" | "day" | "week" | "month") {
                return Err(format!(
                    "org.default_budget.window must be one of epoch, day, week, month (got '{w}')"
                ));
            }
        }
        let limits = [
            ("runs", b.runs),
            ("tasks_create", b.tasks_create),
            ("messages", b.messages),
            ("llm_calls", b.llm_calls),
        ];
        if limits.iter().all(|(_, v)| v.is_none()) {
            return Err(
                "org.default_budget must set at least one limit (runs, tasks_create, messages, llm_calls)"
                    .into(),
            );
        }
        for (name, value) in limits {
            if let Some(v) = value {
                if v == 0 || v > MAX_DEFAULT_BUDGET_LIMIT {
                    return Err(format!(
                        "org.default_budget.{name} must be between 1 and {MAX_DEFAULT_BUDGET_LIMIT} (got {v})"
                    ));
                }
            }
        }
    }
    Ok(())
}

/// The note slug derived from a doc file path: its final path segment's stem.
/// `docs/story-bible.md` → `story-bible`.
pub fn doc_slug(file: &str) -> Option<String> {
    let last = file.rsplit('/').next()?;
    let stem = last.strip_suffix(".md").unwrap_or(last);
    if stem.is_empty() {
        None
    } else {
        Some(stem.to_string())
    }
}

/// Parse `template.yaml` into the pinned schema.
pub fn parse_template_yaml(yaml: &str) -> Result<Template, CliError> {
    serde_yaml::from_str(yaml)
        .map_err(|e| CliError::Usage(format!("template.yaml is not valid: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(pairs: &[(&str, &str)]) -> TemplateFiles {
        TemplateFiles::from_pairs(pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())))
    }

    /// Minimal valid template: one channel, welcome, no optional blocks.
    fn base_yaml() -> String {
        let mut yaml = String::from(
            "id: demo-template\nname: Demo\ndescription: A demo template\nchannels:\n  - id: general\n    name: general\n    purpose: chat\nwelcome: welcome.md\n",
        );
        yaml.push_str("skills: []\npersonas: []\nworkflows: []\ndocs: []\n");
        yaml
    }

    fn base_files() -> TemplateFiles {
        files(&[("welcome.md", "# Welcome"), ("template.yaml", "unused")])
    }

    fn parse(yaml: &str) -> Template {
        serde_yaml::from_str(yaml).expect("fixture YAML parses")
    }

    fn check(yaml: &str, files: &TemplateFiles) -> Result<(), String> {
        validate_template("demo-template", &parse(yaml), files)
    }

    #[test]
    fn minimal_template_is_valid() {
        assert!(check(&base_yaml(), &base_files()).is_ok());
    }

    // ---- org block ----

    /// A valid template that declares one persona so `org.seats` can point at it.
    fn org_yaml(org: &str) -> String {
        let mut yaml = base_yaml().replace(
            "personas: []",
            "personas:\n  - id: writer\n    name: The Writer\n    prompt: personas/writer.md",
        );
        yaml.push_str(org);
        yaml
    }

    fn org_files() -> TemplateFiles {
        files(&[
            ("welcome.md", "# Welcome"),
            ("personas/writer.md", "prompt"),
        ])
    }

    #[test]
    fn org_block_with_seat_and_default_budget_is_valid() {
        let yaml = org_yaml(
            "org:\n  root:\n    name: Studio\n  seats:\n    - persona: writer\n      title: Head of Story\n  default_budget:\n    window: week\n    runs: 200\n    messages: 300\n",
        );
        assert!(check(&yaml, &org_files()).is_ok());
        assert_eq!(seat_node_id("writer"), "seat-writer");
    }

    #[test]
    fn org_seat_must_name_a_declared_persona() {
        let yaml = org_yaml("org:\n  root:\n    name: Studio\n  seats:\n    - persona: ghost\n");
        let err = check(&yaml, &org_files()).unwrap_err();
        assert!(err.contains("unknown persona id 'ghost'"), "{err}");
        assert!(err.contains("writer"), "names the declared ids: {err}");
    }

    #[test]
    fn org_rejects_duplicate_seats_and_empty_root() {
        let dup = org_yaml(
            "org:\n  root:\n    name: Studio\n  seats:\n    - persona: writer\n    - persona: writer\n",
        );
        assert!(check(&dup, &org_files())
            .unwrap_err()
            .contains("duplicate seat"));
        let empty = org_yaml("org:\n  root:\n    name: '  '\n");
        assert!(check(&empty, &org_files())
            .unwrap_err()
            .contains("org.root.name must not be empty"));
    }

    #[test]
    fn org_default_budget_bounds_are_enforced() {
        for (body, needle) in [
            ("default_budget: {}\n", "at least one limit"),
            ("default_budget:\n    runs: 0\n", "between 1 and"),
            ("default_budget:\n    runs: 1000001\n", "between 1 and"),
            (
                "default_budget:\n    window: hour\n    runs: 5\n",
                "window must be one of",
            ),
        ] {
            let yaml = org_yaml(&format!("org:\n  root:\n    name: Studio\n  {body}"));
            let err = check(&yaml, &org_files()).unwrap_err();
            assert!(err.contains(needle), "{body:?} -> {err}");
        }
    }

    #[test]
    fn org_block_rejects_unknown_fields() {
        let yaml = org_yaml("org:\n  root:\n    name: Studio\n  treasury: 0xabc\n");
        assert!(serde_yaml::from_str::<Template>(&yaml).is_err());
    }

    // ---- schema bound table (each documented bound rejects) ----

    #[test]
    fn id_must_match_dir_name() {
        let yaml = base_yaml().replace("id: demo-template", "id: other-name");
        let err = check(&yaml, &base_files()).unwrap_err();
        assert!(err.contains("id must match the directory name"), "{err}");
    }

    #[test]
    fn id_must_be_kebab() {
        let yaml = base_yaml().replace("id: demo-template", "id: Demo_Template");
        let err = check(&yaml, &base_files()).unwrap_err();
        assert!(err.contains("kebab"), "{err}");
    }

    #[test]
    fn name_bounds() {
        let long = "x".repeat(61);
        let yaml = base_yaml().replace("name: Demo", &format!("name: {long}"));
        let err = check(&yaml, &base_files()).unwrap_err();
        assert!(err.contains("name exceeds 60"), "{err}");
        let yaml = base_yaml().replace("name: Demo", "name: ''");
        assert!(check(&yaml, &base_files())
            .unwrap_err()
            .contains("name must not be empty"));
    }

    #[test]
    fn description_bounds() {
        let long = "x".repeat(281);
        let yaml = base_yaml().replace(
            "description: A demo template",
            &format!("description: {long}"),
        );
        let err = check(&yaml, &base_files()).unwrap_err();
        assert!(err.contains("description exceeds 280"), "{err}");
    }

    #[test]
    fn channels_count_bounds() {
        // 0 channels
        let yaml = base_yaml().replace(
            "channels:\n  - id: general\n    name: general\n    purpose: chat\n",
            "channels: []\n",
        );
        let err = check(&yaml, &base_files()).unwrap_err();
        assert!(err.contains("at least 1"), "{err}");
        // 9 channels
        let mut nine = base_yaml().replace(
            "channels:\n  - id: general\n    name: general\n    purpose: chat\n",
            "",
        );
        nine.push_str("channels:\n");
        for i in 0..9 {
            nine.push_str(&format!(
                "  - id: ch-{i}\n    name: ch-{i}\n    purpose: p\n"
            ));
        }
        let err = check(&nine, &base_files()).unwrap_err();
        assert!(err.contains("channels exceeds 8"), "{err}");
    }

    #[test]
    fn channel_purpose_bounds() {
        let long = "x".repeat(201);
        let yaml = base_yaml().replace("purpose: chat", &format!("purpose: {long}"));
        let err = check(&yaml, &base_files()).unwrap_err();
        assert!(err.contains("purpose exceeds 200"), "{err}");
    }

    #[test]
    fn channel_id_must_be_kebab_and_unique() {
        let yaml = base_yaml().replace("id: general", "id: General");
        assert!(check(&yaml, &base_files()).unwrap_err().contains("kebab"));
        let two = base_yaml().replace(
            "channels:\n  - id: general\n    name: general\n    purpose: chat\n",
            "channels:\n  - id: general\n    name: general\n    purpose: chat\n  - id: general\n    name: general\n    purpose: chat\n",
        );
        assert!(check(&two, &base_files())
            .unwrap_err()
            .contains("duplicate channel id"));
    }

    #[test]
    fn seed_file_must_exist_and_bounds() {
        let yaml = base_yaml().replace("purpose: chat", "purpose: chat\n    seed: missing.md");
        let err = check(&yaml, &base_files()).unwrap_err();
        assert!(err.contains("does not exist"), "{err}");

        let f = files(&[
            ("welcome.md", "# W"),
            ("big.md", &"x".repeat(MAX_FILE_BYTES + 1)),
        ]);
        let yaml = base_yaml().replace("purpose: chat", "purpose: chat\n    seed: big.md");
        let err = check(&yaml, &f).unwrap_err();
        assert!(err.contains("exceeds"), "{err}");
    }

    #[test]
    fn persona_count_slug_and_prompt() {
        let mut yaml = base_yaml().replace("personas: []\n", "");
        yaml.push_str(
            "personas:\n  - id: writer\n    name: The Writer\n    prompt: personas/writer.md\n",
        );
        let f = files(&[
            ("welcome.md", "# W"),
            ("personas/writer.md", "You are the writer."),
        ]);
        assert!(check(&yaml, &f).is_ok());

        // slug grammar (relay-enforced on kind:30175)
        let bad = yaml.replace("id: writer", "id: Writer");
        let err = check(&bad, &f).unwrap_err();
        assert!(err.contains("NIP-AP slug grammar"), "{err}");

        // missing prompt file
        let bad = yaml.replace("prompt: personas/writer.md", "prompt: personas/none.md");
        assert!(check(&bad, &f).unwrap_err().contains("does not exist"));

        // 7 personas
        let many = yaml.replace(
            "personas:\n  - id: writer\n    name: The Writer\n    prompt: personas/writer.md\n",
            "",
        );
        let mut many = many;
        many.push_str("personas:\n");
        for i in 0..7 {
            many.push_str(&format!(
                "  - id: p-{i}\n    name: P{i}\n    prompt: personas/writer.md\n"
            ));
        }
        let err = check(&many, &f).unwrap_err();
        assert!(err.contains("personas exceeds 6"), "{err}");
    }

    #[test]
    fn workflow_yaml_must_parse_via_buzz_workflow() {
        // Step flattens its ActionDef: the `action` tag is a sibling of `id`.
        let good = "name: Nightly\ntrigger:\n  on: schedule\n  cron: '0 9 * * *'\nsteps:\n  - id: s1\n    action: send_message\n    text: hi\n";
        let mut yaml = base_yaml().replace("workflows: []\n", "");
        yaml.push_str("workflows:\n  - file: workflows/w.yaml\n");
        let f = files(&[("welcome.md", "# W"), ("workflows/w.yaml", good)]);
        assert!(check(&yaml, &f).is_ok());

        let f = files(&[
            ("welcome.md", "# W"),
            ("workflows/w.yaml", "trigger: {on: bogus}\nsteps: []\n"),
        ]);
        let err = check(&yaml, &f).unwrap_err();
        assert!(err.contains("invalid workflow YAML"), "{err}");

        let f = files(&[("welcome.md", "# W"), ("workflows/w.yaml", "not: [valid\n")]);
        assert!(check(&yaml, &f)
            .unwrap_err()
            .contains("invalid workflow YAML"));
    }

    /// `workflows[].channel` binding field: valid id validates, an unknown id
    /// is a named validation error, absent keeps the `channels[0]` default, and
    /// `deny_unknown_fields` still rejects unknown keys on the entry.
    #[test]
    fn workflow_channel_binding_field_table() {
        const WF: &str = "name: Nightly\ntrigger:\n  on: schedule\n  cron: '0 9 * * *'\nsteps:\n  - id: s1\n    action: send_message\n    text: hi\n";
        // Two channels so binding to a NON-default channel is meaningful.
        let two = base_yaml().replace(
            "channels:\n  - id: general\n    name: general\n    purpose: chat\n",
            "channels:\n  - id: general\n    name: general\n    purpose: chat\n  - id: random\n    name: random\n    purpose: off-topic\n",
        );
        let entry = |channel: &str| {
            two.replace(
                "workflows: []\n",
                &format!("workflows:\n  - file: workflows/w.yaml\n{channel}"),
            )
        };
        let f = files(&[("welcome.md", "# W"), ("workflows/w.yaml", WF)]);

        // valid declared id
        let ok = entry("    channel: random\n");
        let parsed = parse(&ok);
        assert_eq!(parsed.workflows[0].channel.as_deref(), Some("random"));
        assert!(check(&ok, &f).is_ok());

        // absent → default (binds channels[0] at apply time), still valid
        let defaulted = entry("");
        let parsed = parse(&defaulted);
        assert_eq!(parsed.workflows[0].channel, None);
        assert!(check(&defaulted, &f).is_ok());

        // unknown id → named validation error (binds nothing)
        let unknown = entry("    channel: nope\n");
        let err = check(&unknown, &f).unwrap_err();
        assert!(
            err.contains("workflows[0]: unknown channel id 'nope'"),
            "{err}"
        );
        assert!(err.contains("general, random"), "{err}");

        // deny_unknown_fields still holds on the workflow entry
        let extra = entry("    channels: random\n");
        let err = serde_yaml::from_str::<Template>(&extra).unwrap_err();
        assert!(
            err.to_string().contains("unknown field"),
            "expected deny_unknown_fields rejection, got: {err}"
        );
    }

    /// `personas[].skills` — the declarative per-persona scope override that
    /// makes `applies_to` honest: a declared list selects exactly those
    /// skills, an unknown id is a named validation error, an empty list and
    /// duplicates are rejected, absence keeps the historical bind-every-skill
    /// default, and `deny_unknown_fields` still holds on the persona entry.
    #[test]
    fn personas_skills_override_table() {
        let y = |persona_block: &str| {
            base_yaml()
                .replace(
                    "skills: []\n",
                    "skills:\n  - name: alpha\n    source: https://example.com/a/SKILL.md\n    applies_to: all\n  - name: beta\n    source: https://example.com/b/SKILL.md\n    applies_to: developers\n",
                )
                .replace("personas: []\n", persona_block)
        };
        let persona = |skills: &str| {
            format!(
                "personas:\n  - id: writer\n    name: The Writer\n    prompt: personas/writer.md\n{skills}"
            )
        };
        let f = files(&[("welcome.md", "# W"), ("personas/writer.md", "prompt")]);

        // declared list → parsed verbatim and valid
        let ok = y(&persona("    skills: [alpha]\n"));
        let parsed = parse(&ok);
        assert_eq!(
            parsed.personas[0].skills,
            Some(vec!["alpha".to_string()]),
            "declared list must parse verbatim"
        );
        assert!(check(&ok, &f).is_ok());

        // absent → None (apply binds every template skill), still valid
        let defaulted = y(&persona(""));
        let parsed = parse(&defaulted);
        assert_eq!(parsed.personas[0].skills, None);
        assert!(check(&defaulted, &f).is_ok());

        // unknown id → named validation error (binds nothing)
        let unknown = y(&persona("    skills: [gamma]\n"));
        let err = check(&unknown, &f).unwrap_err();
        assert!(
            err.contains("personas[0]: unknown skill id 'gamma'"),
            "{err}"
        );
        assert!(err.contains("alpha, beta"), "{err}");

        // empty override is rejected — omit the field to bind everything
        let empty = y(&persona("    skills: []\n"));
        let err = check(&empty, &f).unwrap_err();
        assert!(err.contains("skills must not be empty"), "{err}");

        // duplicates are rejected (one binding tag per skill, no repeats)
        let dup = y(&persona("    skills: [alpha, alpha]\n"));
        let err = check(&dup, &f).unwrap_err();
        assert!(err.contains("duplicate skill id 'alpha'"), "{err}");

        // deny_unknown_fields still holds on the persona entry
        let extra = y(&persona("    skill: alpha\n"));
        let err = serde_yaml::from_str::<Template>(&extra).unwrap_err();
        assert!(
            err.to_string().contains("unknown field"),
            "expected deny_unknown_fields rejection, got: {err}"
        );
    }

    #[test]
    fn docs_bounds_and_slug() {
        let mut yaml = base_yaml().replace("docs: []\n", "");
        yaml.push_str("docs:\n  - file: docs/story-bible.md\n    title: Story Bible\n");
        let f = files(&[("welcome.md", "# W"), ("docs/story-bible.md", "# Bible")]);
        assert!(check(&yaml, &f).is_ok());

        let bad = yaml.replace("title: Story Bible", "title: ''");
        assert!(check(&bad, &f)
            .unwrap_err()
            .contains("title must not be empty"));

        let bad = yaml.replace("docs/story-bible.md", "docs/Story Bible.md");
        let f = files(&[
            ("welcome.md", "# W"),
            ("docs/story-bible.md", "# Bible"),
            ("docs/Story Bible.md", "# B"),
        ]);
        assert!(check(&bad, &f)
            .unwrap_err()
            .contains("not a valid note slug"));

        let mut many = base_yaml().replace("docs: []\n", "");
        many.push_str("docs:\n");
        for i in 0..9 {
            many.push_str(&format!("  - file: docs/d{i}.md\n    title: D{i}\n"));
        }
        let mut pairs: Vec<(String, String)> = vec![("welcome.md".into(), "# W".into())];
        for i in 0..9 {
            pairs.push((format!("docs/d{i}.md"), "# D".into()));
        }
        let f = TemplateFiles::from_pairs(pairs);
        let err = check(&many, &f).unwrap_err();
        assert!(err.contains("docs exceeds 8"), "{err}");
    }

    #[test]
    fn skills_bounds_scope_and_sources() {
        let mut yaml = base_yaml().replace("skills: []\n", "");
        yaml.push_str("skills:\n  - name: ethereum-dev\n    source: skills/s.md\n    applies_to: developers\n");
        let skill_md = "---\nname: ethereum-dev\ndescription: Eth dev\n---\n# Eth\n";
        let f = files(&[("welcome.md", "# W"), ("skills/s.md", skill_md)]);
        assert!(check(&yaml, &f).is_ok());

        // https source: deferred to apply-time fetch
        let https = yaml.replace(
            "source: skills/s.md",
            "source: https://ethskills.com/SKILL.md",
        );
        assert!(check(&https, &f).is_ok());

        // http is rejected (https-only)
        let http = yaml.replace(
            "source: skills/s.md",
            "source: http://ethskills.com/SKILL.md",
        );
        let err = check(&http, &f).unwrap_err();
        assert!(err.contains("https"), "{err}");

        // invalid applies_to enum is rejected at parse time (serde enum)
        let bad = yaml.replace("applies_to: developers", "applies_to: admins");
        assert!(serde_yaml::from_str::<Template>(&bad).is_err());

        // missing frontmatter gets the named error
        let f = files(&[("welcome.md", "# W"), ("skills/s.md", "# no frontmatter\n")]);
        let err = check(&yaml, &f).unwrap_err();
        assert!(
            err.contains("skill is missing frontmatter name/description"),
            "{err}"
        );

        // name bound
        let long = "x".repeat(61);
        let bad = yaml.replace("name: ethereum-dev", &format!("name: {long}"));
        let err = check(&bad, &f).unwrap_err();
        assert!(err.contains("name exceeds 60"), "{err}");
    }

    #[test]
    fn welcome_must_exist() {
        let yaml = base_yaml().replace("welcome: welcome.md", "welcome: nope.md");
        let err = check(&yaml, &base_files()).unwrap_err();
        assert!(err.contains("welcome"), "{err}");
    }

    #[test]
    fn referenced_paths_cannot_escape_the_template_dir() {
        for rel in [
            "../outside.md",
            "/etc/passwd",
            "a/../../b.md",
            "back\\slash.md",
        ] {
            let yaml = base_yaml().replace("welcome: welcome.md", &format!("welcome: {rel}"));
            let err = check(&yaml, &base_files()).unwrap_err();
            assert!(err.contains("welcome"), "{rel}: {err}");
        }
    }

    #[test]
    fn optional_blocks_default_to_empty() {
        let yaml = "id: demo-template\nname: Demo\ndescription: A demo template\nchannels:\n  - id: general\n    name: general\n    purpose: chat\nwelcome: welcome.md\n";
        let t = parse(yaml);
        assert!(
            t.personas.is_empty()
                && t.workflows.is_empty()
                && t.docs.is_empty()
                && t.skills.is_empty()
        );
        assert!(check(yaml, &base_files()).is_ok());
    }

    #[test]
    fn doc_slug_derives_file_stem() {
        assert_eq!(
            doc_slug("docs/story-bible.md").as_deref(),
            Some("story-bible")
        );
        assert_eq!(doc_slug("story-bible.md").as_deref(), Some("story-bible"));
        assert_eq!(doc_slug("notes/a.b.md").as_deref(), Some("a.b"));
        assert_eq!(doc_slug("x/.md"), None);
    }
}
