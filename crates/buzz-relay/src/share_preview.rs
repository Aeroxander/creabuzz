//! Link previews for a project's public pages.
//!
//! A link pasted into a chat app is read by a crawler that does not run the web
//! app, so it only sees the one `index.html` every page shares: the generic
//! "Creaton" card. For the two addresses a project is shared by,
//! `/p/<project id>-<founder>` (its scorecard) and `/launchpad/<project id>`,
//! the relay looks the project up and answers with the same `index.html` plus a
//! real title, description and a static image.
//!
//! What a preview may say is exactly what the same visitor could already read:
//!
//! - the host picks the community, as everywhere else (`tenant::bind_community`);
//! - on a community where people must be members to read (an invite-only
//!   server), a signed-out visitor reads nothing, so the preview says nothing
//!   either and the page is the plain shell; unless the server lets anyone
//!   read a public project's record (`BUZZ_PUBLIC_PROJECT_READS`,
//!   `api::public_read`), when the visitor can read these words and the
//!   preview says them;
//! - a project that is removed, not listed, or whose founder is banned or muted
//!   gets the plain shell;
//! - only the project's own words are used (name, pitch, the founder's main
//!   goal), HTML-escaped. No price, no returns, no counts.
//!
//! Any miss, error or slow answer falls back to the plain shell: a preview is a
//! nicety and never stands between a visitor and the app.

use std::time::Duration;

use axum::http::HeaderMap;
use buzz_core::kind::{KIND_DELETION, KIND_LAUNCH_RECORD, KIND_LAUNCH_UPDATE};
use buzz_core::CommunityId;
use buzz_db::DbError;

use crate::state::AppState;

/// The product name people see. The web app's `APP_NAME` says the same.
const SITE_NAME: &str = "Creaton";
/// The one image every preview carries. It lives under `/assets/` because that
/// is the only prefix the relay serves from the web directory.
const IMAGE_PATH: &str = "/assets/share-card.png";
const IMAGE_WIDTH: &str = "1200";
const IMAGE_HEIGHT: &str = "630";
/// Longest description a chat app shows in full.
const DESCRIPTION_CHARS: usize = 200;
const NAME_CHARS: usize = 80;
/// Longest the lookups may take before the plain shell is served instead.
const LOOKUP_DEADLINE: Duration = Duration::from_secs(2);
/// How many records of one project id are read: more than one founder may use
/// the same id, and the address says which.
const RECORD_READ_LIMIT: i64 = 20;
/// How many characters of the founder's key a scorecard address carries.
pub(crate) const FOUNDER_PART: usize = 16;

/// Which project an address names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ProjectRoute {
    /// `/p/<id>-<first 16 hex of the founder's key>`.
    Scorecard { id: String, founder_start: String },
    /// `/launchpad/<id>`, with the founder's full key when the link carries `?author=`.
    ProjectPage { id: String, author: Option<String> },
}

/// What a preview says about one project.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Preview {
    pub(crate) title: String,
    pub(crate) description: String,
}

/// The project an address names, or `None` when it names none.
pub(crate) fn route_of(path: &str, query: Option<&str>) -> Option<ProjectRoute> {
    if let Some(rest) = path.strip_prefix("/p/") {
        let slug = percent_decode(rest.trim_end_matches('/'))?;
        let (id, founder_start) = slug.rsplit_once('-')?;
        let founder_ok = founder_start.len() == FOUNDER_PART
            && founder_start
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        if id.is_empty() || !founder_ok {
            return None;
        }
        return Some(ProjectRoute::Scorecard {
            id: id.to_string(),
            founder_start: founder_start.to_string(),
        });
    }
    if let Some(rest) = path.strip_prefix("/launchpad/") {
        let id = percent_decode(rest.trim_end_matches('/'))?;
        if id.is_empty() || id.contains('/') {
            return None;
        }
        let author = query
            .and_then(|q| {
                q.split('&')
                    .find_map(|pair| pair.strip_prefix("author="))
                    .map(str::to_ascii_lowercase)
            })
            .filter(|a| a.len() == 64 && a.bytes().all(|b| b.is_ascii_hexdigit()));
        return Some(ProjectRoute::ProjectPage { id, author });
    }
    None
}

/// Decode `%XX` escapes; `None` for a malformed escape or bytes that are not UTF-8.
fn percent_decode(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = raw.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The preview for a request, or `None` when the plain shell must be served:
/// the host maps to no community, the community is invite-only, the project is
/// missing, removed, not listed, or its founder is restricted, or anything fails.
pub(crate) async fn preview_for(
    state: &AppState,
    raw_host: &str,
    route: &ProjectRoute,
) -> Option<Preview> {
    match tokio::time::timeout(LOOKUP_DEADLINE, lookup(state, raw_host, route)).await {
        Ok(found) => found,
        Err(_) => {
            tracing::warn!("share preview lookup timed out; serving the plain page");
            None
        }
    }
}

/// A project record that anyone may be shown: listed, not removed, and signed
/// by a founder who is neither muted nor banned.
#[derive(Debug, Clone)]
pub(crate) struct PublicProject {
    /// The founder's record (kind 37001).
    pub(crate) record: nostr::Event,
    /// Its address, `37001:<founder key>:<project id>`.
    pub(crate) coordinate: String,
}

/// How many records under one project id are looked through for the founder
/// a scorecard address names. The address carries only the start of the
/// founder's key, which the database cannot ask for, so the start is matched
/// here; this is how many other founders may share the id before the one
/// meant can no longer be found.
const FOUNDER_START_READ_LIMIT: i64 = 200;

/// Which founder's record under a project id is wanted.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) enum Founder {
    /// Whoever signed one: an address that names no founder.
    Anyone,
    /// The founder with exactly this key (64 lowercase hex characters).
    Key(String),
    /// Founders whose key begins with these characters (a scorecard address).
    Start(String),
}

/// The project records stored under `id` in `community` for `founder`.
///
/// Several founders may use one id, and anyone on the member list can add a
/// newer record under an id that is already taken. So the founder is asked of
/// the database where it can be (a whole key), and a key's start is matched
/// over [`FOUNDER_START_READ_LIMIT`] records, before anything is cut to
/// [`RECORD_READ_LIMIT`]: other people's records under the same id cannot push
/// the one the address names out of the answer.
pub(crate) async fn records_named(
    state: &AppState,
    community: CommunityId,
    id: &str,
    founder: &Founder,
) -> Result<Vec<nostr::Event>, DbError> {
    let (authors, limit) = match founder {
        Founder::Anyone => (None, RECORD_READ_LIMIT),
        Founder::Key(key) => match hex::decode(key) {
            Ok(bytes) => (Some(vec![bytes]), RECORD_READ_LIMIT),
            Err(_) => return Ok(Vec::new()),
        },
        Founder::Start(_) => (None, FOUNDER_START_READ_LIMIT),
    };
    Ok(state
        .db
        .query_events(&buzz_db::EventQuery {
            kinds: Some(vec![KIND_LAUNCH_RECORD as i32]),
            d_tag: Some(id.to_string()),
            authors,
            global_only: true,
            limit: Some(limit),
            ..buzz_db::EventQuery::for_community(community)
        })
        .await?
        .into_iter()
        .map(|stored| stored.event)
        .filter(|event| match founder {
            Founder::Anyone => true,
            Founder::Key(key) => event.pubkey.to_hex() == *key,
            Founder::Start(start) => event.pubkey.to_hex().starts_with(start.as_str()),
        })
        .take(RECORD_READ_LIMIT as usize)
        .collect())
}

/// Whether `record` may be shown to anyone: `Ok(None)` when its founder is
/// banned or muted, when the founder removed it, or when it is not listed.
///
/// This is the one rule for what a project shows to someone who is not a
/// member: the link preview and the public record read both ask it, so they
/// cannot disagree. A failed lookup is an error, never "public".
pub(crate) async fn public_standing(
    state: &AppState,
    community: CommunityId,
    record: nostr::Event,
) -> Result<Option<PublicProject>, DbError> {
    let Some(id) = record
        .tags
        .iter()
        .find(|t| t.as_slice().first().map(String::as_str) == Some("d"))
        .and_then(|t| t.as_slice().get(1).cloned())
    else {
        return Ok(None);
    };
    let author = record.pubkey.to_bytes();
    let coordinate = format!("{KIND_LAUNCH_RECORD}:{}:{id}", record.pubkey.to_hex());

    // A founder who is banned or muted has no public face.
    let restriction = state
        .db
        .moderation_restriction_state(community, &author)
        .await?;
    if restriction.banned || restriction.muted_until.is_some() {
        return Ok(None);
    }

    // Removed: the founder's own NIP-09 deletion of this record, at or after it.
    let removals = state
        .db
        .query_events(&buzz_db::EventQuery {
            kinds: Some(vec![KIND_DELETION as i32]),
            pubkey: Some(author.to_vec()),
            tag_filters: vec![("a".to_string(), vec![coordinate.clone()])],
            limit: Some(RECORD_READ_LIMIT),
            ..buzz_db::EventQuery::for_community(community)
        })
        .await?;
    if removals
        .iter()
        .any(|stored| stored.event.created_at >= record.created_at)
    {
        return Ok(None);
    }

    // "Not listed yet": the page opens from its link but nothing may announce it.
    let body: serde_json::Value = serde_json::from_str(&record.content).unwrap_or_default();
    if body.get("listing").and_then(|v| v.as_str()) == Some("unlisted") {
        return Ok(None);
    }
    Ok(Some(PublicProject { record, coordinate }))
}

/// The project `route` names in `community`, when a visitor who is not signed
/// in may be shown it there: `None` when the community is invite-only and the
/// server does not let anyone read public records, when the address fits no
/// project or more than one, when the project does not pass
/// [`public_standing`], or when a lookup fails.
async fn shown_project(
    state: &AppState,
    community: CommunityId,
    route: &ProjectRoute,
) -> Option<PublicProject> {
    // Invite-only: a visitor who is not signed in reads nothing here, so the
    // preview must not tell a crawler what the visitor could not read. When the
    // server lets anyone read a public project's record, the visitor can read
    // these words, and the preview may say them.
    match state.membership_required(community, false).await {
        Ok(false) => {}
        Ok(true) if state.public_project_reads() => {}
        Ok(true) => return None,
        Err(error) => {
            tracing::warn!(%error, "share preview: could not read the access setting");
            return None;
        }
    }

    let (id, founder) = match route {
        ProjectRoute::Scorecard { id, founder_start } => {
            (id, Founder::Start(founder_start.clone()))
        }
        ProjectRoute::ProjectPage {
            id,
            author: Some(author),
        } => (id, Founder::Key(author.clone())),
        ProjectRoute::ProjectPage { id, author: None } => (id, Founder::Anyone),
    };
    let mut matching = records_named(state, community, id, &founder)
        .await
        .map_err(|error| tracing::warn!(%error, "share preview: record read failed"))
        .ok()?
        .into_iter();
    let record = matching.next()?;
    // Two founders on one address: which one is meant is the web app's to ask.
    if matching.next().is_some() {
        return None;
    }

    public_standing(state, community, record)
        .await
        .map_err(|error| tracing::warn!(%error, "share preview: standing read failed"))
        .ok()?
}

/// The server's own example project (`BUZZ_EXAMPLE_PROJECT`, a scorecard
/// address without its `/p/`), when a visitor who is not signed in could open
/// it in `community`: the same answer the link preview gives for that
/// address. `None` when the server names none, or the visitor could not open
/// it here, so the web app never offers a link that leads nowhere.
pub(crate) async fn example_project(state: &AppState, community: CommunityId) -> Option<String> {
    let slug = state.config.example_project.as_deref()?;
    // The information document is fetched by every client on load, without an account: the lookups below are made
    // once in a while per community, not once per request.
    if let Some(remembered) = state.public_reads.example(community) {
        return remembered;
    }
    let route = route_of(&format!("/p/{slug}"), None)?;
    let shown = tokio::time::timeout(LOOKUP_DEADLINE, shown_project(state, community, &route))
        .await
        .ok()
        .flatten()
        .map(|_| slug.to_string());
    state
        .public_reads
        .remember_example(community, shown.clone());
    shown
}

async fn lookup(state: &AppState, raw_host: &str, route: &ProjectRoute) -> Option<Preview> {
    let tenant = crate::tenant::bind_community(&state.db, raw_host)
        .await
        .ok()?;
    let community = tenant.community();
    let PublicProject { record, coordinate } = shown_project(state, community, route).await?;
    let author = record.pubkey.to_bytes();
    let body: serde_json::Value = serde_json::from_str(&record.content).unwrap_or_default();
    let name = record
        .tags
        .iter()
        .find(|t| t.as_slice().first().map(String::as_str) == Some("name"))
        .and_then(|t| t.as_slice().get(1).cloned())?;
    let pitch = body.get("pitch").and_then(|v| v.as_str()).unwrap_or("");

    // The founder's main goal: their own newest goal record at the top level.
    let goal = state
        .db
        .query_events(&buzz_db::EventQuery {
            kinds: Some(vec![KIND_LAUNCH_UPDATE as i32]),
            pubkey: Some(author.to_vec()),
            tag_filters: vec![
                ("a".to_string(), vec![coordinate]),
                ("goal-level".to_string(), vec!["primary".to_string()]),
            ],
            limit: Some(RECORD_READ_LIMIT),
            ..buzz_db::EventQuery::for_community(community)
        })
        .await
        .map_err(|error| tracing::warn!(%error, "share preview: goal read failed"))
        .ok()?
        .into_iter()
        .map(|stored| stored.event)
        .max_by_key(|e| (e.created_at, e.id))
        .and_then(|e| {
            e.tags
                .iter()
                .find(|t| t.as_slice().first().map(String::as_str) == Some("goal-text"))
                .and_then(|t| t.as_slice().get(1).cloned())
        })
        .unwrap_or_default();

    Some(compose(&name, pitch, &goal))
}

/// Collapse whitespace and drop control characters: one tidy line.
fn tidy(text: &str) -> String {
    text.split_whitespace()
        .map(|word| word.chars().filter(|c| !c.is_control()).collect::<String>())
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// At most `max` characters, ending in an ellipsis when cut.
fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let cut: String = text.chars().take(max.saturating_sub(1)).collect();
    format!("{}…", cut.trim_end())
}

/// Name, pitch and goal, in that order, in plain words.
pub(crate) fn compose(name: &str, pitch: &str, goal: &str) -> Preview {
    let name = clip(&tidy(name), NAME_CHARS);
    let pitch = tidy(pitch);
    let goal = tidy(goal);
    let mut parts = Vec::new();
    if !pitch.is_empty() {
        parts.push(pitch);
    }
    if !goal.is_empty() {
        parts.push(format!("Goal: {goal}"));
    }
    let description = if parts.is_empty() {
        format!("See what {name} is working on and whether it keeps its promises.")
    } else {
        parts.join(" ")
    };
    Preview {
        title: format!("{name} on {SITE_NAME}"),
        description: clip(&description, DESCRIPTION_CHARS),
    }
}

/// Escape text for an HTML element or a quoted attribute.
pub(crate) fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            other => out.push(other),
        }
    }
    out
}

/// `https://host`, from the `Host` the visitor used. `http` only for a local
/// host or when the proxy in front says so.
pub(crate) fn origin_of(headers: &HeaderMap) -> Option<String> {
    let host = headers
        .get(axum::http::header::HOST)?
        .to_str()
        .ok()?
        .trim()
        .to_ascii_lowercase();
    let host_ok = !host.is_empty()
        && host.len() <= 255
        && host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b':' | b'[' | b']'));
    if !host_ok {
        return None;
    }
    let forwarded = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(|v| v.trim().to_ascii_lowercase());
    let local = host == "localhost"
        || host.starts_with("localhost:")
        || host.starts_with("127.0.0.1")
        || host.starts_with("[::1]")
        || host.ends_with(".localhost");
    let scheme = match forwarded.as_deref() {
        Some("http") => "http",
        Some("https") => "https",
        _ if local => "http",
        _ => "https",
    };
    Some(format!("{scheme}://{host}"))
}

/// The value of attribute `attr` in one tag's text, if present.
fn attribute<'a>(tag: &'a str, attr: &str) -> Option<&'a str> {
    let lower = tag.to_ascii_lowercase();
    let mut from = 0;
    while let Some(found) = lower[from..].find(attr) {
        let start = from + found;
        let end = start + attr.len();
        from = end;
        // A whole word: not `data-name`, not `names`.
        let before_ok = start == 0
            || lower.as_bytes()[start - 1].is_ascii_whitespace()
            || lower.as_bytes()[start - 1] == b'"'
            || lower.as_bytes()[start - 1] == b'\'';
        if !before_ok {
            continue;
        }
        let rest = tag[end..].trim_start();
        let Some(rest) = rest.strip_prefix('=') else {
            continue;
        };
        let rest = rest.trim_start();
        let quote = rest.chars().next()?;
        if quote != '"' && quote != '\'' {
            continue;
        }
        let inner = &rest[1..];
        let close = inner.find(quote)?;
        return Some(&inner[..close]);
    }
    None
}

/// Whether a `<meta ...>` tag is one the preview replaces: the description, an
/// `og:` tag or a `twitter:` tag.
fn is_share_meta(tag: &str) -> bool {
    [attribute(tag, "name"), attribute(tag, "property")]
        .into_iter()
        .flatten()
        .any(|value| {
            let value = value.trim().to_ascii_lowercase();
            value == "description" || value.starts_with("og:") || value.starts_with("twitter:")
        })
}

/// `index` without its title, description and share tags.
fn without_share_tags(index: &str) -> String {
    let mut out = String::with_capacity(index.len());
    let lower = index.to_ascii_lowercase();
    let mut at = 0;
    while at < index.len() {
        let next_meta = lower[at..].find("<meta").map(|i| at + i);
        let next_title = lower[at..].find("<title").map(|i| at + i);
        let (start, is_title) = match (next_meta, next_title) {
            (Some(m), Some(t)) if t < m => (t, true),
            (Some(m), _) => (m, false),
            (None, Some(t)) => (t, true),
            (None, None) => break,
        };
        let end = if is_title {
            lower[start..]
                .find("</title>")
                .map(|i| start + i + "</title>".len())
        } else {
            lower[start..].find('>').map(|i| start + i + 1)
        };
        let Some(end) = end else { break };
        out.push_str(&index[at..start]);
        // The title and the share tags are dropped; any other tag stays.
        if !is_title && !is_share_meta(&index[start..end]) {
            out.push_str(&index[start..end]);
        }
        at = end;
    }
    out.push_str(&index[at..]);
    out
}

/// `index` with this project's title, description and share tags in its head.
/// `None` when the document has no `</head>` to put them in.
pub(crate) fn inject(index: &str, preview: &Preview, origin: &str, url: &str) -> Option<String> {
    let mut stripped = without_share_tags(index);
    let head_end = stripped.to_ascii_lowercase().find("</head>")?;
    let title = escape_html(&preview.title);
    let description = escape_html(&preview.description);
    let url = escape_html(&format!("{origin}{url}"));
    let image = escape_html(&format!("{origin}{IMAGE_PATH}"));
    let site = escape_html(SITE_NAME);
    let block = format!(
        "    <title>{title}</title>\n\
         \x20   <meta name=\"description\" content=\"{description}\" />\n\
         \x20   <meta property=\"og:type\" content=\"website\" />\n\
         \x20   <meta property=\"og:site_name\" content=\"{site}\" />\n\
         \x20   <meta property=\"og:title\" content=\"{title}\" />\n\
         \x20   <meta property=\"og:description\" content=\"{description}\" />\n\
         \x20   <meta property=\"og:url\" content=\"{url}\" />\n\
         \x20   <meta property=\"og:image\" content=\"{image}\" />\n\
         \x20   <meta property=\"og:image:width\" content=\"{IMAGE_WIDTH}\" />\n\
         \x20   <meta property=\"og:image:height\" content=\"{IMAGE_HEIGHT}\" />\n\
         \x20   <meta property=\"og:image:alt\" content=\"{site}\" />\n\
         \x20   <meta name=\"twitter:card\" content=\"summary_large_image\" />\n\
         \x20   <meta name=\"twitter:title\" content=\"{title}\" />\n\
         \x20   <meta name=\"twitter:description\" content=\"{description}\" />\n\
         \x20   <meta name=\"twitter:image\" content=\"{image}\" />\n"
    );
    stripped.insert_str(head_end, &block);
    Some(stripped)
}

/// The address a preview names as its own: the path, and for a project page
/// the founder, when the link carried one.
pub(crate) fn canonical_path(path: &str, route: &ProjectRoute) -> String {
    match route {
        ProjectRoute::ProjectPage {
            author: Some(author),
            ..
        } => format!("{path}?author={author}"),
        _ => path.to_string(),
    }
}

/// The page for a project address: the web app's `index.html` carrying the
/// project's preview when there is one, the plain `index.html` otherwise.
pub(crate) async fn document(
    state: &AppState,
    headers: &HeaderMap,
    index: &std::path::Path,
    path: &str,
    query: Option<&str>,
) -> Option<Vec<u8>> {
    let route = route_of(path, query)?;
    let raw_host = headers
        .get(axum::http::header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let preview = preview_for(state, raw_host, &route).await?;
    let origin = origin_of(headers)?;
    let html = tokio::fs::read_to_string(index).await.ok()?;
    inject(&html, &preview, &origin, &canonical_path(path, &route)).map(String::into_bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FOUNDER: &str = "ab12cd34ef56ab78";

    #[test]
    fn the_two_project_addresses_are_read() {
        assert_eq!(
            route_of(&format!("/p/nebula-{FOUNDER}"), None),
            Some(ProjectRoute::Scorecard {
                id: "nebula".into(),
                founder_start: FOUNDER.into()
            })
        );
        // The id may hold dashes and escapes; the founder is the last dash-part.
        assert_eq!(
            route_of(&format!("/p/my%20project-v2-{FOUNDER}/"), None),
            Some(ProjectRoute::Scorecard {
                id: "my project-v2".into(),
                founder_start: FOUNDER.into()
            })
        );
        assert_eq!(
            route_of("/launchpad/nebula", None),
            Some(ProjectRoute::ProjectPage {
                id: "nebula".into(),
                author: None
            })
        );
        let author = "ab".repeat(32);
        assert_eq!(
            route_of(
                "/launchpad/nebula",
                Some(&format!("tab=work&author={author}"))
            ),
            Some(ProjectRoute::ProjectPage {
                id: "nebula".into(),
                author: Some(author)
            })
        );
        // A malformed author is ignored, never echoed.
        assert_eq!(
            route_of("/launchpad/nebula", Some("author=\"><script>")),
            Some(ProjectRoute::ProjectPage {
                id: "nebula".into(),
                author: None
            })
        );
    }

    #[test]
    fn other_addresses_are_not_project_addresses() {
        for path in [
            "/",
            "/p/",
            "/p/nebula",
            "/p/nebula-short",
            "/p/nebula-AB12CD34EF56AB78",
            "/p/-ab12cd34ef56ab78",
            "/p/bad%zz-ab12cd34ef56ab78",
            "/p/%ff-ab12cd34ef56ab78",
            "/launchpad",
            "/launchpad/",
            "/launchpad/a/b",
            "/discover",
        ] {
            assert_eq!(route_of(path, None), None, "{path}");
        }
    }

    #[test]
    fn a_preview_leads_with_the_name_the_pitch_and_the_goal() {
        let preview = compose(
            "Nebula",
            "A weekly map of the night sky.",
            "Publish 12 maps",
        );
        assert_eq!(preview.title, "Nebula on Creaton");
        assert_eq!(
            preview.description,
            "A weekly map of the night sky. Goal: Publish 12 maps"
        );
        // A project with neither still says something true.
        let bare = compose("Nebula", "", "");
        assert_eq!(
            bare.description,
            "See what Nebula is working on and whether it keeps its promises."
        );
    }

    #[test]
    fn a_long_description_is_cut_on_a_word_with_an_ellipsis() {
        let long = "word ".repeat(100);
        let preview = compose("N", &long, "");
        assert!(preview.description.chars().count() <= DESCRIPTION_CHARS);
        assert!(preview.description.ends_with('…'));
        // Line breaks and control characters become one tidy line.
        let preview = compose("Neb\nula\u{7}", "a\n\nb", "");
        assert_eq!(preview.title, "Neb ula on Creaton");
    }

    const INDEX: &str = "<!doctype html>\n<html lang=\"en\">\n  <head>\n    <meta charset=\"UTF-8\" />\n    <title>Creaton</title>\n    <meta\n      name=\"description\"\n      content=\"A community workspace.\"\n    />\n    <meta property=\"og:title\" content=\"Creaton\" />\n    <meta name='twitter:card' content='summary' />\n    <meta name=\"theme-color\" content=\"#eefbf5\" />\n    <meta data-name=\"description\" content=\"keep\" />\n  </head>\n  <body><div id=\"root\"></div></body>\n</html>\n";

    #[test]
    fn injection_replaces_the_generic_tags_and_keeps_the_rest() {
        let preview = compose("Nebula", "A weekly map.", "Publish 12 maps");
        let html = inject(
            INDEX,
            &preview,
            "https://creaton.example",
            "/p/nebula-ab12cd34ef56ab78",
        )
        .expect("has a head");
        assert_eq!(html.matches("<title>").count(), 1);
        assert!(html.contains("<title>Nebula on Creaton</title>"));
        assert_eq!(html.matches("og:title").count(), 1, "{html}");
        assert_eq!(html.matches("<meta name=\"description\"").count(), 1);
        assert!(html.contains("content=\"A weekly map. Goal: Publish 12 maps\""));
        assert!(
            !html.contains("A community workspace."),
            "generic text gone"
        );
        assert!(!html.contains("content='summary'"), "old twitter card gone");
        assert!(html.contains(
            "<meta property=\"og:url\" content=\"https://creaton.example/p/nebula-ab12cd34ef56ab78\" />"
        ));
        assert!(html.contains(
            "<meta property=\"og:image\" content=\"https://creaton.example/assets/share-card.png\" />"
        ));
        assert!(html.contains("name=\"twitter:card\" content=\"summary_large_image\""));
        // Everything that is not a share tag is untouched.
        assert!(html.contains("<meta charset=\"UTF-8\" />"));
        assert!(html.contains("name=\"theme-color\""));
        assert!(html.contains("data-name=\"description\" content=\"keep\""));
        assert!(html.contains("<div id=\"root\"></div>"));
        // The new tags sit inside the head.
        assert!(html.find("og:title").unwrap() < html.find("</head>").unwrap());
    }

    #[test]
    fn a_project_cannot_inject_markup_through_its_words() {
        let nasty = "\"><script>alert(1)</script><img src=x onerror=alert(2)>";
        let preview = compose(nasty, nasty, nasty);
        let html = inject(
            INDEX,
            &preview,
            "https://creaton.example",
            "/p/x-ab12cd34ef56ab78",
        )
        .expect("has a head");
        assert!(!html.contains("<script>"), "{html}");
        assert!(!html.contains("<img"), "{html}");
        assert!(
            !html.contains("\"><script") && !html.contains("\"><img"),
            "a quote must not close the attribute: {html}"
        );
        assert!(html.contains("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"));
        // Nor through the address or the host.
        let html = inject(
            INDEX,
            &preview,
            "https://creaton.example",
            "/p/\"><script>-ab12cd34ef56ab78",
        )
        .expect("has a head");
        assert!(!html.contains("<script>"), "{html}");
    }

    /// The page the web app really ships: its generic card is replaced, and its
    /// document policy and boot script survive. Editing `web/index.html` so the
    /// injection no longer fits fails here.
    #[test]
    fn the_real_index_takes_a_preview() {
        let real = include_str!("../../../web/index.html");
        let preview = compose("Nebula", "A weekly map.", "Publish 12 maps");
        let html = inject(
            real,
            &preview,
            "https://creaton.example",
            "/p/n-ab12cd34ef56ab78",
        )
        .expect("the shipped page has a head");
        assert_eq!(html.matches("<title>").count(), 1);
        assert_eq!(html.matches("property=\"og:title\"").count(), 1);
        assert_eq!(html.matches("property=\"og:image\"").count(), 1);
        assert_eq!(html.matches("name=\"twitter:card\"").count(), 1);
        assert!(html.contains("<title>Nebula on Creaton</title>"));
        assert!(!html.contains("<title>Creaton</title>"));
        assert!(
            !html.contains("A community workspace"),
            "the generic text is gone"
        );
        for kept in [
            "http-equiv=\"Content-Security-Policy\"",
            "src=\"/assets/theme-boot.js\"",
            "name=\"theme-color\"",
            "<div id=\"root\"></div>",
        ] {
            assert!(html.contains(kept), "lost {kept}");
        }
    }

    #[test]
    fn a_page_without_a_head_is_left_alone() {
        let preview = compose("Nebula", "", "");
        assert!(inject("<html></html>", &preview, "https://a.example", "/p/x").is_none());
    }

    #[test]
    fn the_origin_comes_from_the_host_the_visitor_used() {
        let headers = |host: &str, proto: Option<&str>| {
            let mut h = HeaderMap::new();
            h.insert(axum::http::header::HOST, host.parse().unwrap());
            if let Some(p) = proto {
                h.insert("x-forwarded-proto", p.parse().unwrap());
            }
            h
        };
        assert_eq!(
            origin_of(&headers("Creaton.Example", None)).as_deref(),
            Some("https://creaton.example")
        );
        assert_eq!(
            origin_of(&headers("localhost:3000", None)).as_deref(),
            Some("http://localhost:3000")
        );
        assert_eq!(
            origin_of(&headers("creaton.example", Some("http, https"))).as_deref(),
            Some("http://creaton.example")
        );
        // A host with anything odd in it is not echoed at all.
        assert_eq!(origin_of(&headers("a.example/\"><script>", None)), None);
        assert_eq!(origin_of(&HeaderMap::new()), None);
    }

    /// The previews through the real router, a real community and real records.
    /// Needs Postgres and Redis:
    /// `cargo test -p buzz-relay --lib -- share_preview::tests::postgres_tests --ignored`.
    mod postgres_tests {
        use std::sync::Arc;

        use axum::body::Body;
        use axum::http::{Request, StatusCode};
        use buzz_auth::Scope;
        use buzz_core::tenant::TenantContext;
        use nostr::{Event, EventBuilder, Keys, Kind, Tag, Timestamp};
        use tower::ServiceExt;
        use uuid::Uuid;

        use super::super::*;
        use crate::handlers::ingest::{ingest_event, IngestAuth};

        const PLAIN: &str =
            "<!doctype html><html><head><title>Creaton</title></head><body></body></html>";

        struct World {
            state: Arc<AppState>,
            tenant: TenantContext,
            founder: Keys,
            _dir: tempfile::TempDir,
        }

        async fn world(invite_only: bool) -> World {
            world_with(invite_only, false).await
        }

        /// `public_reads` is the server's `BUZZ_PUBLIC_PROJECT_READS`.
        async fn world_with(invite_only: bool, public_reads: bool) -> World {
            world_for(invite_only, public_reads, Keys::generate(), None).await
        }

        /// A world whose founder is known before the server starts, so the
        /// server's settings can name the founder's project (`example`).
        async fn world_for(
            invite_only: bool,
            public_reads: bool,
            founder: Keys,
            example: Option<String>,
        ) -> World {
            let dir = tempfile::tempdir().expect("bundle dir");
            std::fs::create_dir_all(dir.path().join("assets")).expect("assets");
            std::fs::write(dir.path().join("index.html"), PLAIN).expect("index");
            let web = dir.path().to_path_buf();
            let state = crate::test_support::test_state_with(move |config| {
                config.web_dir = Some(web);
                config.web_spa_full = true;
                config.new_account_posts_per_hour = 0;
                config.public_project_reads = public_reads;
                // Invite-only as the operator sets it for the whole server: the only kind public records open.
                config.require_relay_membership = invite_only;
                // Nothing kept between requests: each test reads what is there now.
                config.public_project_reads_cache_secs = 0;
                config.example_project = example;
            })
            .await;
            let host = format!("share-preview-{}.example", Uuid::new_v4().simple());
            let community = state
                .db
                .ensure_configured_community(&host)
                .await
                .expect("community")
                .id;
            state
                .db
                .add_relay_member(community, &founder.public_key().to_hex(), "member", None)
                .await
                .expect("member");
            World {
                state,
                tenant: TenantContext::resolved(community, host),
                founder,
                _dir: dir,
            }
        }

        fn signed(keys: &Keys, kind: u32, tags: &[&[&str]], body: &str, ahead: u64) -> Event {
            let tags: Vec<Tag> = tags
                .iter()
                .map(|t| Tag::parse(t.to_vec()).expect("tag"))
                .collect();
            EventBuilder::new(Kind::Custom(kind as u16), body)
                .tags(tags)
                .allow_self_tagging()
                .custom_created_at(Timestamp::from(Timestamp::now().as_secs() + ahead))
                .sign_with_keys(keys)
                .expect("sign")
        }

        async fn publish(w: &World, event: Event) {
            let auth = IngestAuth::Nip42 {
                pubkey: event.pubkey,
                scopes: vec![Scope::ChannelsWrite, Scope::MessagesWrite],
                channel_ids: None,
                conn_id: Uuid::new_v4(),
            };
            let result = ingest_event(&w.state, &w.tenant, event, auth)
                .await
                .expect("accepted by the server");
            assert!(result.accepted, "{}", result.message);
        }

        async fn project(w: &World, id: &str, name: &str, body: &str) {
            publish(
                w,
                signed(
                    &w.founder,
                    KIND_LAUNCH_RECORD,
                    &[&["d", id], &["name", name]],
                    body,
                    0,
                ),
            )
            .await;
        }

        async fn goal(w: &World, id: &str, text: &str, ahead: u64) {
            let coordinate = format!("37001:{}:{id}", w.founder.public_key().to_hex());
            publish(
                w,
                signed(
                    &w.founder,
                    KIND_LAUNCH_UPDATE,
                    &[
                        &["a", &coordinate],
                        &["goal", &format!("g{ahead}")],
                        &["goal-level", "primary"],
                        &["goal-text", text],
                        &["goal-how", "We will count them"],
                        &["goal-state", "open"],
                    ],
                    "{}",
                    ahead,
                ),
            )
            .await;
        }

        fn slug(w: &World, id: &str) -> String {
            format!("/p/{id}-{}", &w.founder.public_key().to_hex()[..16])
        }

        /// The page the router answers for `path` on the community's host.
        async fn page(w: &World, path: &str) -> String {
            let router = crate::router::build_router(w.state.clone());
            let response = router
                .oneshot(
                    Request::get(path)
                        .header(axum::http::header::HOST, w.tenant.host())
                        .header(axum::http::header::ACCEPT, "text/html")
                        .body(Body::empty())
                        .expect("request"),
                )
                .await
                .expect("response");
            assert_eq!(response.status(), StatusCode::OK, "{path}");
            let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
                .await
                .expect("body");
            String::from_utf8(bytes.to_vec()).expect("utf-8")
        }

        #[tokio::test]
        #[ignore = "requires Postgres and Redis"]
        async fn a_projects_links_carry_its_own_title_description_and_image() {
            let w = world(false).await;
            project(
                &w,
                "nebula",
                "Nebula",
                r#"{"pitch":"A weekly map of the night sky."}"#,
            )
            .await;
            goal(&w, "nebula", "Publish 12 maps", 0).await;
            // The founder rewords the goal: the newest one is the goal.
            goal(&w, "nebula", "Publish 24 maps", 5).await;

            for path in [
                slug(&w, "nebula"),
                "/launchpad/nebula".to_string(),
                format!(
                    "/launchpad/nebula?author={}",
                    w.founder.public_key().to_hex()
                ),
            ] {
                let html = page(&w, &path).await;
                assert!(
                    html.contains("<title>Nebula on Creaton</title>"),
                    "{path}: {html}"
                );
                assert!(
                    html.contains(
                        "content=\"A weekly map of the night sky. Goal: Publish 24 maps\""
                    ),
                    "{path}: {html}"
                );
                assert!(
                    html.contains(&format!(
                        "property=\"og:image\" content=\"https://{}/assets/share-card.png\"",
                        w.tenant.host()
                    )),
                    "{path}: {html}"
                );
                assert!(
                    !html.contains(">Creaton</title>"),
                    "{path}: still the generic card"
                );
            }
        }

        #[tokio::test]
        #[ignore = "requires Postgres and Redis"]
        async fn a_hostile_project_name_is_text_not_markup() {
            let w = world(false).await;
            project(
                &w,
                "evil",
                "\"><script>alert(1)</script>",
                r#"{"pitch":"<img src=x onerror=alert(2)>"}"#,
            )
            .await;
            let html = page(&w, &slug(&w, "evil")).await;
            assert!(
                html.contains(
                    "<title>&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt; on Creaton</title>"
                ),
                "{html}"
            );
            assert!(!html.contains("<script>"), "{html}");
            assert!(!html.contains("<img"), "{html}");
        }

        #[tokio::test]
        #[ignore = "requires Postgres and Redis"]
        async fn anything_a_visitor_may_not_see_gets_the_plain_page() {
            // Not listed: the page opens, nothing announces it.
            let w = world(false).await;
            project(
                &w,
                "quiet",
                "Quiet",
                r#"{"listing":"unlisted","pitch":"Hush"}"#,
            )
            .await;
            assert_eq!(page(&w, &slug(&w, "quiet")).await, PLAIN);

            // Never there, or an address that names the wrong founder.
            assert_eq!(page(&w, "/p/nothing-0123456789abcdef").await, PLAIN);
            project(&w, "real", "Real", "{}").await;
            assert_eq!(page(&w, "/p/real-0123456789abcdef").await, PLAIN);
            assert_ne!(page(&w, &slug(&w, "real")).await, PLAIN);

            // Removed by its founder.
            let coordinate = format!("37001:{}:real", w.founder.public_key().to_hex());
            publish(
                &w,
                signed(&w.founder, KIND_DELETION, &[&["a", &coordinate]], "", 1),
            )
            .await;
            assert_eq!(page(&w, &slug(&w, "real")).await, PLAIN);

            // A founder who is muted, and one who is banned.
            project(&w, "muted", "Muted", "{}").await;
            assert_ne!(page(&w, &slug(&w, "muted")).await, PLAIN);
            let actor = Keys::generate();
            w.state
                .db
                .timeout_community_member(
                    w.tenant.community(),
                    &w.founder.public_key().to_bytes(),
                    &actor.public_key().to_bytes(),
                    chrono::Utc::now() + chrono::Duration::hours(1),
                    None,
                )
                .await
                .expect("mute");
            assert_eq!(page(&w, &slug(&w, "muted")).await, PLAIN);
            w.state
                .db
                .untimeout_community_member(
                    w.tenant.community(),
                    &w.founder.public_key().to_bytes(),
                    &actor.public_key().to_bytes(),
                )
                .await
                .expect("unmute");
            assert_ne!(page(&w, &slug(&w, "muted")).await, PLAIN);
            w.state
                .db
                .ban_community_member(
                    w.tenant.community(),
                    &w.founder.public_key().to_bytes(),
                    &actor.public_key().to_bytes(),
                    None,
                    None,
                )
                .await
                .expect("ban");
            assert_eq!(page(&w, &slug(&w, "muted")).await, PLAIN);
        }

        /// The community's own owner makes it invite-only (or opens it again), on a server that lets communities choose.
        async fn community_chooses(w: &World, invite_only: bool) {
            w.state
                .db
                .set_community_membership_required(w.tenant.community(), invite_only)
                .await
                .expect("the community's own setting");
            w.state.forget_membership_policy(w.tenant.community());
        }

        #[tokio::test]
        #[ignore = "requires Postgres and Redis"]
        async fn an_invite_only_server_shows_a_signed_out_crawler_nothing() {
            // The operator made the whole server invite-only.
            let w = world(true).await;
            project(&w, "nebula", "Nebula", r#"{"pitch":"A weekly map."}"#).await;
            let html = page(&w, &slug(&w, "nebula")).await;
            assert_eq!(
                html, PLAIN,
                "the generic page, with nothing about the project"
            );
            assert!(!html.contains("Nebula"));

            // A community that chose invite-only for itself, on a server that lets communities choose.
            let w = world(false).await;
            project(&w, "nebula", "Nebula", r#"{"pitch":"A weekly map."}"#).await;
            community_chooses(&w, true).await;
            assert_eq!(page(&w, &slug(&w, "nebula")).await, PLAIN);
            // Opening the community makes the same link a real preview.
            community_chooses(&w, false).await;
            assert!(page(&w, &slug(&w, "nebula"))
                .await
                .contains("Nebula on Creaton"));
        }

        /// The operator's setting opens records where the operator made the server invite-only. It does not open a
        /// community whose own owner chose invite-only: that owner chose who reads there.
        #[tokio::test]
        #[ignore = "requires Postgres and Redis"]
        async fn public_records_do_not_open_a_community_that_chose_invite_only_itself() {
            let founder = Keys::generate();
            let named = format!("nebula-{}", &founder.public_key().to_hex()[..16]);
            let w = world_for(false, true, founder, Some(named.clone())).await;
            project(&w, "nebula", "Nebula", r#"{"pitch":"A weekly map."}"#).await;
            // Open: previewed and named, as on any open community.
            assert!(page(&w, &slug(&w, "nebula"))
                .await
                .contains("Nebula on Creaton"));
            assert_eq!(example_named(&w).await, serde_json::json!(named));

            community_chooses(&w, true).await;
            let html = page(&w, &slug(&w, "nebula")).await;
            assert_eq!(html, PLAIN, "the owner's choice stands");
            assert_eq!(example_named(&w).await, serde_json::Value::Null);
        }

        /// Anyone on the member list can publish a project under an id that is taken. However many do, the address
        /// still finds the founder it names.
        #[tokio::test]
        #[ignore = "requires Postgres and Redis"]
        async fn other_founders_under_the_same_id_do_not_hide_the_one_the_address_names() {
            let w = world_with(true, true).await;
            project(&w, "nebula", "Nebula", r#"{"pitch":"A weekly map."}"#).await;
            // Thirty newer projects under the same id, more than one read of an id returns.
            for n in 0..30u64 {
                let other = Keys::generate();
                w.state
                    .db
                    .add_relay_member(
                        w.tenant.community(),
                        &other.public_key().to_hex(),
                        "member",
                        None,
                    )
                    .await
                    .expect("member");
                publish(
                    &w,
                    signed(
                        &other,
                        KIND_LAUNCH_RECORD,
                        &[&["d", "nebula"], &["name", "Impostor"]],
                        "{}",
                        10 + n,
                    ),
                )
                .await;
            }
            let html = page(&w, &slug(&w, "nebula")).await;
            assert!(html.contains("<title>Nebula on Creaton</title>"), "{html}");
            let by_key = format!(
                "/launchpad/nebula?author={}",
                w.founder.public_key().to_hex()
            );
            assert!(page(&w, &by_key)
                .await
                .contains("<title>Nebula on Creaton</title>"));
        }

        /// The information document is fetched on every page load. With answers kept, the example project is looked
        /// up once in a while, not on every request.
        #[tokio::test]
        #[ignore = "requires Postgres and Redis"]
        async fn the_example_project_is_remembered_between_requests_when_answers_are_kept() {
            let founder = Keys::generate();
            let named = format!("nebula-{}", &founder.public_key().to_hex()[..16]);
            let dir = tempfile::tempdir().expect("bundle dir");
            let example = named.clone();
            let state = crate::test_support::test_state_with(move |config| {
                config.public_project_reads_cache_secs = 30;
                config.example_project = Some(example);
            })
            .await;
            let host = format!("share-preview-{}.example", Uuid::new_v4().simple());
            let community = state
                .db
                .ensure_configured_community(&host)
                .await
                .expect("community")
                .id;
            let w = World {
                state,
                tenant: TenantContext::resolved(community, host),
                founder,
                _dir: dir,
            };
            project(&w, "nebula", "Nebula", "{}").await;
            assert_eq!(example_named(&w).await, serde_json::json!(named));
            // Closing the community is not seen until what is kept runs out: the lookups were not made again.
            community_chooses(&w, true).await;
            assert_eq!(example_named(&w).await, serde_json::json!(named));
        }

        #[tokio::test]
        #[ignore = "requires Postgres and Redis"]
        async fn an_invite_only_server_that_lets_anyone_read_public_records_previews_them() {
            let w = world_with(true, true).await;
            project(&w, "nebula", "Nebula", r#"{"pitch":"A weekly map."}"#).await;
            goal(&w, "nebula", "Publish 12 maps", 0).await;
            let html = page(&w, &slug(&w, "nebula")).await;
            assert!(html.contains("<title>Nebula on Creaton</title>"), "{html}");
            assert!(
                html.contains("content=\"A weekly map. Goal: Publish 12 maps\""),
                "{html}"
            );
            // What it would not show on an open server it does not show here either.
            project(
                &w,
                "quiet",
                "Quiet",
                r#"{"listing":"unlisted","pitch":"Hush"}"#,
            )
            .await;
            assert_eq!(page(&w, &slug(&w, "quiet")).await, PLAIN);
            let actor = Keys::generate();
            w.state
                .db
                .ban_community_member(
                    w.tenant.community(),
                    &w.founder.public_key().to_bytes(),
                    &actor.public_key().to_bytes(),
                    None,
                    None,
                )
                .await
                .expect("ban");
            assert_eq!(page(&w, &slug(&w, "nebula")).await, PLAIN);
        }

        /// What the server's information document says its example project is, on `w`'s host.
        async fn example_named(w: &World) -> serde_json::Value {
            serde_json::to_value(crate::nip11::nip11_document(&w.state, w.tenant.host()).await)
                .expect("document is JSON")["example_project"]
                .clone()
        }

        #[tokio::test]
        #[ignore = "requires Postgres and Redis"]
        async fn the_servers_example_project_is_named_only_where_a_visitor_can_open_it() {
            let null = serde_json::Value::Null;
            let founder = Keys::generate();
            let named = format!("nebula-{}", &founder.public_key().to_hex()[..16]);

            // An open server: named once the project is there.
            let open = world_for(false, false, founder.clone(), Some(named.clone())).await;
            assert_eq!(example_named(&open).await, null, "no such project yet");
            project(&open, "nebula", "Nebula", "{}").await;
            assert_eq!(example_named(&open).await, serde_json::json!(named));
            // The same server on another community's address has no such project.
            let elsewhere = format!("share-preview-{}.example", Uuid::new_v4().simple());
            open.state
                .db
                .ensure_configured_community(&elsewhere)
                .await
                .expect("community");
            assert_eq!(
                serde_json::to_value(crate::nip11::nip11_document(&open.state, &elsewhere).await)
                    .expect("document is JSON")["example_project"],
                null
            );

            // Invite-only: a visitor could not open it, so it is not offered.
            let closed = world_for(true, false, founder.clone(), Some(named.clone())).await;
            project(&closed, "nebula", "Nebula", "{}").await;
            assert_eq!(example_named(&closed).await, null);

            // Invite-only, and anyone may read public records: offered, until the project stops being public.
            let shown = world_for(true, true, founder.clone(), Some(named.clone())).await;
            project(&shown, "nebula", "Nebula", "{}").await;
            assert_eq!(example_named(&shown).await, serde_json::json!(named));
            publish(
                &shown,
                signed(
                    &shown.founder,
                    KIND_LAUNCH_RECORD,
                    &[&["d", "nebula"], &["name", "Nebula"]],
                    r#"{"listing":"unlisted"}"#,
                    5,
                ),
            )
            .await;
            assert_eq!(example_named(&shown).await, null);

            // A server that names none says nothing.
            let unset = world_for(false, false, founder, None).await;
            project(&unset, "nebula", "Nebula", "{}").await;
            assert_eq!(example_named(&unset).await, null);
        }

        #[tokio::test]
        #[ignore = "requires Postgres and Redis"]
        async fn one_communitys_project_is_not_previewed_on_anothers_host() {
            let w = world(false).await;
            project(&w, "nebula", "Nebula", "{}").await;
            let other = world(false).await;
            // The same address on the other community's host finds no such project.
            let router = crate::router::build_router(other.state.clone());
            let response = router
                .oneshot(
                    Request::get(slug(&w, "nebula"))
                        .header(axum::http::header::HOST, other.tenant.host())
                        .header(axum::http::header::ACCEPT, "text/html")
                        .body(Body::empty())
                        .expect("request"),
                )
                .await
                .expect("response");
            let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
                .await
                .expect("body");
            assert_eq!(String::from_utf8_lossy(&bytes), PLAIN);
        }
    }
}
