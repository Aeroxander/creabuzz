//! `buzz launchpad start`: a live project from one command, the same two records the web app's Quick Start publishes.
//!
//! Quick Start asks four things: the project's name, one sentence, its goal, and how everyone will know the goal was
//! reached. This command takes the same four (`--pitch` is the sentence and falls back to the goal) and publishes:
//!
//! 1. the project record (kind 37001): the lightest kind there is, a public page with no Shares, no money and no
//!    reviewers (`web/src/features/launchpad/lib/idea.ts`, `use-launches.ts`);
//! 2. its first goal, as an update record (kind 47003) with the `goal` tags the web app reads (`goals.ts`).
//!
//! It prints the project and the path of its public page, `/p/<id>-<start of the founder's key>`, as JSON.
//!
//! A retry never makes a second project. The id is the name's slug; when the account already has a project under
//! it that carries the same name and sentence, that project is carried on with, and a goal it already has is not
//! sent again. A clash with a different project gets a short, steady suffix drawn from the four answers, so the same
//! four answers always land on the same id.
//!
//! **A labelled agent account cannot set goals**: the server refuses any goal from an account it has on record as an
//! agent, even on a project of its own. For such an account the project is still made and its page printed, the goal
//! is not saved, and the command says so (`goal.saved` is false, `goal.needs_a_person` is true) and exits 3. A person
//! sets the goal from the project page.

use std::time::Duration;

use buzz_core::kind::{KIND_LAUNCH_RECORD, KIND_LAUNCH_UPDATE};
use nostr::{EventBuilder, Kind, Tag};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::launchpad_tasks::{goals_as_they_stand, parse_events, project_path};
use crate::client::BuzzClient;
use crate::commands::parse_write_response;
use crate::error::CliError;

/// The name's longest length, and the sentence's shortest and longest, as the web app's form holds them.
const NAME_MAX: usize = 60;
const PITCH_MIN: usize = 10;
const PITCH_MAX: usize = 140;
/// A goal and how it will be known: the web app's `GOAL_LIMITS`.
const GOAL_MIN: usize = 3;
const GOAL_MAX: usize = 200;
/// How many of this account's own project records are read to find an id that is free.
const OWN_READ_BOUND: u32 = 500;
const GOAL_READ_BOUND: u32 = 2_000;
/// The record is read back this many times, with a pause, before the command says the server is slow to show it.
const SHOWN_TRIES: u32 = 5;
const SHOWN_WAIT: Duration = Duration::from_millis(600);
pub(crate) const START_SCHEMA: &str = "creaton.start.v1";

/// What `buzz launchpad start` is given.
pub struct StartArgs {
    pub name: String,
    pub goal: String,
    pub how: String,
    pub pitch: Option<String>,
}

/// The name's slug: lowercase letters and digits joined by single dashes, at most 64 characters. The web app's
/// `slugFromName`.
pub(crate) fn slug_from_name(name: &str) -> String {
    let mut out = String::new();
    for c in name.trim().to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-');
    trimmed
        .chars()
        .take(64)
        .collect::<String>()
        .trim_end_matches('-')
        .to_string()
}

/// Why the four answers cannot make a project yet, in plain words, or `None`. The web form's checks.
pub(crate) fn problem(name: &str, pitch: &str, goal: &str, how: &str) -> Option<String> {
    let name = name.trim();
    if name.chars().count() < 2 {
        return Some("Give your project a name (at least 2 characters).".into());
    }
    if name.chars().count() > NAME_MAX {
        return Some(format!("Keep the name under {NAME_MAX} characters."));
    }
    if slug_from_name(name).is_empty() {
        return Some("Use at least one letter or number in the name.".into());
    }
    let pitch = pitch.trim();
    if pitch.chars().count() < PITCH_MIN {
        return Some(format!(
            "Say what it is in a sentence of at least {PITCH_MIN} characters (--pitch)."
        ));
    }
    if pitch.chars().count() > PITCH_MAX {
        return Some(format!("Keep the one-liner under {PITCH_MAX} characters."));
    }
    for (what, text) in [("goal", goal.trim()), ("how we will know", how.trim())] {
        if text.chars().count() < GOAL_MIN {
            return Some(format!("Say what the {what} is (--goal and --how)."));
        }
        if text.chars().count() > GOAL_MAX {
            return Some(format!("Keep the {what} under {GOAL_MAX} characters."));
        }
    }
    None
}

/// Base-36 digits of a hash: steady for the same input, so a retry lands on the same id.
fn steady(parts: &[&str], digits: usize) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part.as_bytes());
        hasher.update([0u8]);
    }
    let digest = hasher.finalize();
    let mut number = u128::from_be_bytes(digest[..16].try_into().unwrap_or([0u8; 16]));
    let mut out = String::new();
    for _ in 0..digits {
        let d = (number % 36) as u32;
        out.push(char::from_digit(d, 36).unwrap_or('0'));
        number /= 36;
    }
    out
}

/// The goal's id: steady for the same project and words, so a goal sent twice is one goal, not two.
pub(crate) fn goal_id(coordinate: &str, goal: &str) -> String {
    format!("g{}", steady(&[coordinate, goal.trim()], 10))
}

/// The id a new project is published under, given the ids this account's projects already use (with the name and
/// sentence each carries), or the project to carry on with. The first answer is `(id, true)`: that project already
/// exists and is the same one.
pub(crate) fn choose_id(
    name: &str,
    pitch: &str,
    goal: &str,
    how: &str,
    own: &[(String, String, String)],
) -> Result<(String, bool), CliError> {
    let base = slug_from_name(name);
    let same = |id: &str| {
        own.iter()
            .find(|(have, _, _)| have == id)
            .map(|(_, n, p)| n.trim() == name.trim() && p.trim() == pitch.trim())
    };
    match same(&base) {
        None => return Ok((base, false)),
        Some(true) => return Ok((base, true)),
        Some(false) => {}
    }
    let suffix = steady(&[name.trim(), pitch.trim(), goal.trim(), how.trim()], 4);
    let head: String = base.chars().take(59).collect();
    let candidate = format!("{}-{suffix}", head.trim_end_matches('-'));
    match same(&candidate) {
        None => Ok((candidate, false)),
        Some(true) => Ok((candidate, true)),
        Some(false) => Err(CliError::Conflict(format!(
            "this account already has other projects under {base:?} and {candidate:?}: pick a different --name"
        ))),
    }
}

fn tag(parts: &[&str]) -> Result<Tag, CliError> {
    Tag::parse(parts.iter().copied()).map_err(|e| CliError::Other(format!("bad tag: {e}")))
}

/// The project record's tags and body: the web app's idea record, with no sale, no chain and no money.
pub(crate) fn project_parts(
    id: &str,
    name: &str,
    pitch: &str,
    now: u64,
) -> Result<(Vec<Tag>, Value), CliError> {
    Ok((
        vec![
            tag(&["d", id])?,
            tag(&["name", name.trim()])?,
            tag(&["t", "dao-launchpad"])?,
            tag(&["admission", "curated"])?,
        ],
        json!({ "pitch": pitch.trim(), "stage": "draft", "started": now }),
    ))
}

/// The goal record's tags and body, as the web app's `goalEvent` writes a project's first goal.
pub(crate) fn goal_parts(
    coordinate: &str,
    goal_id: &str,
    goal: &str,
    how: &str,
) -> Result<(Vec<Tag>, Value), CliError> {
    let (goal, how) = (goal.trim(), how.trim());
    Ok((
        vec![
            tag(&["a", coordinate])?,
            tag(&["goal", goal_id])?,
            tag(&["goal-level", "primary"])?,
            tag(&["goal-text", goal])?,
            tag(&["goal-how", how])?,
            tag(&["goal-state", "open"])?,
        ],
        json!({ "title": "Goal", "body": format!("{goal}\nHow we'll know: {how}") }),
    ))
}

/// Whether a failed write was the server refusing an agent account a goal.
fn refused_for_agent(error: &CliError) -> bool {
    match error {
        CliError::Relay { status: 403, body } => body.contains("agent account"),
        CliError::Auth(message) => message.contains("agent account"),
        _ => false,
    }
}

async fn own_projects(
    client: &BuzzClient,
    me: &str,
) -> Result<Vec<(String, String, String)>, CliError> {
    let filter = json!({ "kinds": [KIND_LAUNCH_RECORD], "authors": [me] });
    let events = parse_events(client.query_pages_bounded(filter, OWN_READ_BOUND).await?)?;
    let mut newest: std::collections::BTreeMap<String, (u64, String, String)> = Default::default();
    for event in events.iter().filter(|e| e.pubkey.to_hex() == me) {
        let value = |name: &str| {
            event.tags.iter().find_map(|t| match t.as_slice() {
                [n, v, ..] if n.as_str() == name => Some(v.clone()),
                _ => None,
            })
        };
        let Some(id) = value("d") else { continue };
        let pitch = serde_json::from_str::<Value>(&event.content)
            .ok()
            .and_then(|b| b["pitch"].as_str().map(str::to_string))
            .unwrap_or_default();
        let at = event.created_at.as_secs();
        if newest.get(&id).is_none_or(|(have, _, _)| at >= *have) {
            newest.insert(id, (at, value("name").unwrap_or_default(), pitch));
        }
    }
    Ok(newest
        .into_iter()
        .map(|(id, (_, n, p))| (id, n, p))
        .collect())
}

async fn is_shown(client: &BuzzClient, me: &str, id: &str) -> Result<bool, CliError> {
    let filter = json!({ "kinds": [KIND_LAUNCH_RECORD], "authors": [me], "#d": [id] });
    Ok(!client.query_pages_bounded(filter, 2).await?.is_empty())
}

/// `buzz launchpad start`
pub async fn cmd_start(client: &BuzzClient, args: &StartArgs) -> Result<(), CliError> {
    let pitch = args
        .pitch
        .clone()
        .unwrap_or_else(|| args.goal.trim().to_string());
    if let Some(message) = problem(&args.name, &pitch, &args.goal, &args.how) {
        return Err(CliError::Usage(message));
    }
    let me = client.keys().public_key().to_hex();
    let own = own_projects(client, &me).await?;
    let (id, adopt) = choose_id(&args.name, &pitch, &args.goal, &args.how, &own)?;
    let coordinate = format!("{KIND_LAUNCH_RECORD}:{me}:{id}");

    if !adopt {
        let now = chrono::Utc::now().timestamp().max(0) as u64;
        let (tags, content) = project_parts(&id, &args.name, &pitch, now)?;
        let event = client.sign_event(
            EventBuilder::new(Kind::Custom(KIND_LAUNCH_RECORD as u16), content.to_string())
                .tags(tags),
        )?;
        let raw = client.submit_event(event).await?;
        parse_write_response(&raw, "this project was already published")?;
    }

    // A goal the project already has (a retry) is not sent again.
    let filter = json!({ "kinds": [KIND_LAUNCH_UPDATE], "authors": [me], "#a": [coordinate] });
    let updates = parse_events(client.query_pages_bounded(filter, GOAL_READ_BOUND).await?)?;
    let goals = goals_as_they_stand(&updates, &me);
    let goal_key = goal_id(&coordinate, &args.goal);
    let already = goals.values().any(|g| {
        g["text"].as_str() == Some(args.goal.trim()) || g["id"].as_str() == Some(&goal_key)
    });

    let mut saved = already;
    let mut refusal: Option<CliError> = None;
    if !already {
        let (tags, content) = goal_parts(&coordinate, &goal_key, &args.goal, &args.how)?;
        let event = client.sign_event(
            EventBuilder::new(Kind::Custom(KIND_LAUNCH_UPDATE as u16), content.to_string())
                .tags(tags),
        )?;
        match client.submit_event(event).await {
            Ok(raw) => {
                parse_write_response(&raw, "this goal was already published")?;
                saved = true;
            }
            Err(error) => refusal = Some(error),
        }
    }

    // The page opens once the server shows the project back: ask a few times, with a pause.
    let mut shown = false;
    for attempt in 0..SHOWN_TRIES {
        if is_shown(client, &me, &id).await.unwrap_or(false) {
            shown = true;
            break;
        }
        if attempt + 1 < SHOWN_TRIES {
            tokio::time::sleep(SHOWN_WAIT).await;
        }
    }

    let needs_a_person = refusal.as_ref().is_some_and(refused_for_agent);
    let path = project_path(&me, &id);
    println!(
        "{}",
        json!({
            "schema": START_SCHEMA,
            "project": {
                "id": id,
                "author": me,
                "name": args.name.trim(),
                "pitch": pitch.trim(),
                "coordinate": coordinate,
                "path": path,
                "link": path,
            },
            // True: the account already had this project and it was carried on with, not made again.
            "adopted": adopt,
            "goal": {
                "id": goal_key,
                "text": args.goal.trim(),
                "how_we_will_know": args.how.trim(),
                "saved": saved,
                // True: the server refuses an agent account any goal. The project is live without one; a person
                // sets it from the project page.
                "needs_a_person": needs_a_person,
                "problem": refusal.as_ref().map(ToString::to_string),
            },
            "shown": shown,
            "note": "The page is at `link` on the server's web address. A project with no Shares and no money is made; everything else is set up later from its page.",
        })
    );
    match refusal {
        Some(error) if needs_a_person => Err(CliError::Auth(format!(
            "the project was made, but an agent account cannot set its goal: a person must ({error})"
        ))),
        Some(error) => Err(error),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_slug_is_the_web_apps() {
        assert_eq!(slug_from_name("  Star Atlas!  "), "star-atlas");
        assert_eq!(
            slug_from_name("Orbit_2: the *sequel*"),
            "orbit-2-the-sequel"
        );
        assert_eq!(slug_from_name("!!!"), "");
        assert_eq!(slug_from_name(&"a".repeat(80)).len(), 64);
        crate::commands::launchpad::validate_launch_id(&slug_from_name("Star Atlas"))
            .expect("valid id");
    }

    #[test]
    fn the_four_answers_are_held_to_the_forms_rules() {
        let ok = problem(
            "Star Atlas",
            "A map of the northern sky",
            "Publish the chart",
            "Ten people read it",
        );
        assert_eq!(ok, None);
        assert!(problem("A", "A map of the northern sky", "g goal", "how so").is_some());
        assert!(problem("!!!", "A map of the northern sky", "g goal", "how so").is_some());
        assert!(problem("Star Atlas", "too short", "g goal", "how so").is_some());
        assert!(problem("Star Atlas", &"p".repeat(141), "g goal", "how so").is_some());
        assert!(problem("Star Atlas", "A map of the northern sky", "ab", "how so").is_some());
        assert!(problem(
            "Star Atlas",
            "A map of the northern sky",
            "g goal",
            &"h".repeat(201)
        )
        .is_some());
        assert!(problem(
            &"n".repeat(61),
            "A map of the northern sky",
            "g goal",
            "how so"
        )
        .is_some());
    }

    #[test]
    fn a_retry_lands_on_the_same_project_and_a_clash_on_a_steady_suffix() {
        let (name, pitch, goal, how) = (
            "Star Atlas",
            "A map of the northern sky",
            "Publish it",
            "Ten read it",
        );
        // Nothing yet: the slug.
        assert_eq!(
            choose_id(name, pitch, goal, how, &[]).unwrap(),
            ("star-atlas".into(), false)
        );
        // The same project is there: carried on with, not made again.
        let mine = vec![(
            "star-atlas".to_string(),
            name.to_string(),
            pitch.to_string(),
        )];
        assert_eq!(
            choose_id(name, pitch, goal, how, &mine).unwrap(),
            ("star-atlas".into(), true)
        );
        // Another project holds the slug: a suffix drawn from the four answers, the same every time.
        let other = vec![(
            "star-atlas".to_string(),
            "Star Atlas".to_string(),
            "Something else".to_string(),
        )];
        let (first, adopt) = choose_id(name, pitch, goal, how, &other).unwrap();
        assert!(
            !adopt && first.starts_with("star-atlas-") && first.len() == "star-atlas-".len() + 4
        );
        assert_eq!(choose_id(name, pitch, goal, how, &other).unwrap().0, first);
        crate::commands::launchpad::validate_launch_id(&first).expect("valid id");
        // That suffixed project is the retry's own on the next run.
        let mut both = other.clone();
        both.push((first.clone(), name.to_string(), pitch.to_string()));
        assert_eq!(
            choose_id(name, pitch, goal, how, &both).unwrap(),
            (first.clone(), true)
        );
        // Both taken by others: asked for a different name.
        both[1].2 = "Not ours".into();
        assert!(matches!(
            choose_id(name, pitch, goal, how, &both),
            Err(CliError::Conflict(_))
        ));
    }

    #[test]
    fn the_records_are_the_ones_quick_start_publishes() {
        let (tags, content) = project_parts(
            "star-atlas",
            " Star Atlas ",
            " A map of the northern sky ",
            1_800_000_000,
        )
        .unwrap();
        let pairs: Vec<Vec<String>> = tags.iter().map(|t| t.as_slice().to_vec()).collect();
        assert_eq!(
            pairs,
            vec![
                vec!["d", "star-atlas"],
                vec!["name", "Star Atlas"],
                vec!["t", "dao-launchpad"],
                vec!["admission", "curated"],
            ]
        );
        assert_eq!(content["stage"], "draft");
        assert_eq!(content["pitch"], "A map of the northern sky");
        // No money and no chain on the record.
        for key in [
            "currency",
            "floorPrice",
            "requiredRaised",
            "token",
            "auction",
        ] {
            assert!(content.get(key).is_none(), "{key}");
        }
        let coordinate = format!("37001:{}:star-atlas", "f".repeat(64));
        let id = goal_id(&coordinate, "Publish it");
        assert_eq!(id, goal_id(&coordinate, " Publish it "));
        assert!(id.starts_with('g') && id.len() == 11);
        let (tags, content) = goal_parts(&coordinate, &id, "Publish it", "Ten read it").unwrap();
        let pairs: Vec<Vec<String>> = tags.iter().map(|t| t.as_slice().to_vec()).collect();
        assert_eq!(pairs[0], vec!["a".to_string(), coordinate]);
        assert_eq!(pairs[2], vec!["goal-level", "primary"]);
        assert_eq!(pairs[5], vec!["goal-state", "open"]);
        assert_eq!(content["title"], "Goal");
        assert_eq!(content["body"], "Publish it\nHow we'll know: Ten read it");
    }

    #[test]
    fn only_the_servers_refusal_of_an_agent_is_told_apart() {
        assert!(refused_for_agent(&CliError::Relay {
            status: 403,
            body: "restricted: an agent account cannot check work, grant more time, or sign goals and promises; a person on the team must".into(),
        }));
        assert!(!refused_for_agent(&CliError::Relay {
            status: 403,
            body: "restricted: only this project's founder can post this".into(),
        }));
        assert!(!refused_for_agent(&CliError::Other("agent account".into())));
    }
}
