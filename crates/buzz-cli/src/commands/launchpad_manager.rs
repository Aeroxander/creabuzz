//! `buzz launchpad manager draft <project>`: ask the server's AI manager for a draft (docs/agents/MANAGER-LOOP.md).
//!
//! The founder, or the manager agent the founder runs, sends the project's address, the ids of the records to read,
//! the founder's answers and the brain's three files (`facts.md`, `decisions.md`, `voice.md`) from a checkout. The
//! server reads the records itself, calls its AI service and holds the reply to the honesty envelope; what comes back
//! is printed unchanged (`"schema": "creaton.manager.v1"`): one line for this week, one for what to leave aside, up to
//! three for "What happened", each with what it cites, and what needs a person. Never "What's next".
//!
//! Nothing here signs, posts or pays: a draft is for the founder to read, and a person signs the update. A refusal by
//! the server (not the founder's, post the weekly update first, the week's drafts used, the platform's cap) exits 3
//! with the server's code and words.

use std::path::{Path, PathBuf};
use std::time::Duration;

use clap::Subcommand;
use serde_json::{json, Value};

use super::launchpad_tasks::{read_founder_updates, read_project};
use crate::client::BuzzClient;
use crate::error::CliError;

/// The server's route.
const DRAFT_PATH: &str = "/llm/manager/draft";
/// The most records sent to be read (the server reads at most this many).
const ITEMS_MAX: usize = 30;
/// The most answers sent, and the longest one, in characters.
const ANSWERS_MAX: usize = 5;
const ANSWER_MAX: usize = 1_000;
/// The most of one brain file sent, in characters (the server reads no more).
const FILE_MAX: usize = 8 * 1024;
/// How long the AI service is given to answer.
const ANSWER_WAIT: Duration = Duration::from_secs(120);

/// The AI manager: drafts for the founder, never signs
#[derive(Subcommand)]
pub enum ManagerCmd {
    /// Ask for a draft of this week's one thing, what to leave aside, and "What happened". Prints the server's JSON
    /// (`"schema": "creaton.manager.v1"`). Never drafts "What's next", and posts nothing
    #[command(
        after_help = "Only the project's founder, or the manager agent the founder runs (labelled with `buzz agents \
label --operator <FOUNDER> --role manager`), may ask. Without --item the project's 30 newest records by its founder \
are read. --brain-dir is the project's repository checkout: facts.md, decisions.md and voice.md are sent as text, \
after the same key check as `buzz launchpad brain check`. Every line of the answer cites what it came from; lines \
that could not be backed are dropped and counted. The answer can be wrong: a person reads it and signs the update.\n\n\
Exit codes: 0 a draft, 3 refused by the server (its `code` and words are printed), 2 the AI service did not answer.\n\n\
Example:\n  buzz launchpad manager draft orbit --answer 'The demo slipped a week' --brain-dir ./orbit"
    )]
    Draft {
        /// Project id (slug)
        id: String,
        /// Founder pubkey (64-char hex). Defaults to the current identity.
        #[arg(long)]
        author: Option<String>,
        /// A record of the project to read, by id (repeat for more; at most 30). Default: the 30 newest
        #[arg(long = "item")]
        items: Vec<String>,
        /// The founder's answer to something the manager asked (repeat for more; at most 5)
        #[arg(long = "answer")]
        answers: Vec<String>,
        /// The project's repository checkout holding the brain files
        #[arg(long = "brain-dir")]
        brain_dir: Option<PathBuf>,
    },
}

/// The three brain files the manager reads, as text.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Brain {
    facts: String,
    decisions: String,
    voice: String,
}

/// Read the brain's three files from a checkout. A file that is not there is empty; a brain that looks like it holds
/// a key is refused before anything is sent anywhere.
pub(crate) fn read_brain(dir: &Path) -> Result<Brain, CliError> {
    if !dir.is_dir() {
        return Err(CliError::Usage(format!(
            "{} is not a directory: give the project's repository checkout",
            dir.display()
        )));
    }
    super::launchpad_brain::check(dir)?;
    let file = |name: &str| -> Result<String, CliError> {
        let path = dir.join(name);
        if !path.is_file() {
            return Ok(String::new());
        }
        let words = std::fs::read_to_string(&path)
            .map_err(|e| CliError::Other(format!("could not read {}: {e}", path.display())))?;
        Ok(words.chars().take(FILE_MAX).collect())
    };
    Ok(Brain {
        facts: file("facts.md")?,
        decisions: file("decisions.md")?,
        voice: file("voice.md")?,
    })
}

/// The request the server reads. Pure.
pub(crate) fn request_body(
    coordinate: &str,
    items: &[String],
    answers: &[String],
    brain: &Brain,
) -> Result<Value, CliError> {
    if items.len() > ITEMS_MAX {
        return Err(CliError::Usage(format!(
            "at most {ITEMS_MAX} records can be read for one draft"
        )));
    }
    if let Some(bad) = items
        .iter()
        .find(|id| id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err(CliError::Usage(format!(
            "--item must be a record id (64 hex characters), got {bad:?}"
        )));
    }
    if answers.len() > ANSWERS_MAX {
        return Err(CliError::Usage(format!(
            "at most {ANSWERS_MAX} answers can be sent with one draft"
        )));
    }
    if let Some(long) = answers.iter().find(|a| a.chars().count() > ANSWER_MAX) {
        return Err(CliError::Usage(format!(
            "an answer is at most {ANSWER_MAX} characters (this one is {})",
            long.chars().count()
        )));
    }
    Ok(json!({
        "project": coordinate,
        "items": items.iter().map(|id| id.to_lowercase()).collect::<Vec<_>>(),
        "answers": answers,
        "facts": brain.facts,
        "decisions": brain.decisions,
        "voice": brain.voice,
    }))
}

/// What the server's answer means for this command: the draft unchanged, or why there is none. Pure.
pub(crate) fn outcome(status: u16, body: String) -> Result<String, CliError> {
    if (200..300).contains(&status) {
        return Ok(body);
    }
    let parsed: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    let words = parsed["error"].as_str().unwrap_or(body.trim()).to_string();
    match parsed["code"].as_str() {
        // The server decided: asking again the same way gets the same answer.
        Some(code) if matches!(status, 403 | 429) && code.starts_with("ai_") => {
            Err(CliError::Auth(format!("{code}: {words}")))
        }
        _ => Err(CliError::Relay {
            status,
            body: words,
        }),
    }
}

pub async fn dispatch(cmd: ManagerCmd, client: &BuzzClient) -> Result<(), CliError> {
    match cmd {
        ManagerCmd::Draft {
            id,
            author,
            items,
            answers,
            brain_dir,
        } => {
            let owner = author
                .map(|a| a.to_lowercase())
                .unwrap_or_else(|| client.keys().public_key().to_hex());
            let brain = match brain_dir.as_deref() {
                Some(dir) => read_brain(dir)?,
                None => Brain::default(),
            };
            let project = read_project(client, &id, &owner).await?;
            let items = if items.is_empty() {
                let (mut updates, _complete) = read_founder_updates(client, &project).await?;
                updates.sort_by_key(|e| std::cmp::Reverse((e.created_at.as_secs(), e.id.to_hex())));
                updates
                    .iter()
                    .take(ITEMS_MAX)
                    .map(|e| e.id.to_hex())
                    .collect()
            } else {
                items
            };
            let body = request_body(&project.coordinate, &items, &answers, &brain)?;
            let (status, answer) = client
                .post_json_for_status(DRAFT_PATH, &body, ANSWER_WAIT)
                .await?;
            println!("{}", outcome(status, answer)?);
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("buzz-manager-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        dir
    }

    #[test]
    fn the_request_names_the_project_the_records_the_answers_and_the_three_files() {
        let brain = Brain {
            facts: "- Lantern sells lamps.".into(),
            decisions: "- (2026-11-02) Decided: one colour.".into(),
            voice: "Short sentences.".into(),
        };
        let id = "AB".repeat(32);
        let body = request_body(
            "37001:ff:lantern",
            std::slice::from_ref(&id),
            &["The demo slipped.".into()],
            &brain,
        )
        .expect("body");
        assert_eq!(
            body,
            json!({
                "project": "37001:ff:lantern",
                "items": [id.to_lowercase()],
                "answers": ["The demo slipped."],
                "facts": "- Lantern sells lamps.",
                "decisions": "- (2026-11-02) Decided: one colour.",
                "voice": "Short sentences.",
            })
        );
        // No field for "What's next": the manager never drafts it, and the tool cannot ask for it.
        assert!(body.get("next").is_none());
    }

    #[test]
    fn too_much_or_a_bad_id_is_refused_before_anything_is_sent() {
        let brain = Brain::default();
        let id = "a".repeat(64);
        for (items, answers) in [
            (vec!["not-an-id".to_string()], vec![]),
            (vec![id.clone(); ITEMS_MAX + 1], vec![]),
            (vec![], vec!["a".to_string(); ANSWERS_MAX + 1]),
            (vec![], vec!["a".repeat(ANSWER_MAX + 1)]),
        ] {
            let refused =
                request_body("37001:ff:x", &items, &answers, &brain).expect_err("refused");
            assert!(matches!(refused, CliError::Usage(_)), "{refused}");
        }
        assert!(request_body("37001:ff:x", &vec![id; ITEMS_MAX], &[], &brain).is_ok());
    }

    #[test]
    fn the_brain_is_read_from_a_checkout_and_a_key_in_it_stops_the_draft() {
        let dir = scratch();
        assert_eq!(
            read_brain(&dir).expect("empty"),
            Brain::default(),
            "no brain yet"
        );
        super::super::launchpad_brain::init(&dir).expect("init");
        std::fs::write(dir.join("facts.md"), "- Lantern sells lamps.\n").expect("write");
        let brain = read_brain(&dir).expect("brain");
        assert_eq!(brain.facts, "- Lantern sells lamps.\n");
        assert!(!brain.decisions.is_empty() && !brain.voice.is_empty());
        // Long files are cut to what the server reads.
        std::fs::write(dir.join("voice.md"), "v".repeat(FILE_MAX + 100)).expect("write");
        assert_eq!(read_brain(&dir).expect("brain").voice.len(), FILE_MAX);
        // A key in any brain file: nothing is read out for sending.
        std::fs::write(
            dir.join("decisions.md"),
            "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n",
        )
        .expect("write");
        let refused = read_brain(&dir).expect_err("a key");
        assert!(refused.to_string().contains("decisions.md"), "{refused}");
        assert!(matches!(
            read_brain(&dir.join("missing")).expect_err("no directory"),
            CliError::Usage(_)
        ));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_draft_is_printed_unchanged_and_a_refusal_exits_3_with_the_servers_code() {
        let draft = r#"{"schema":"creaton.manager.v1","this_week":[]}"#;
        assert_eq!(outcome(200, draft.to_string()).expect("draft"), draft);
        for (status, code) in [
            (403, "ai_manager_founder_only"),
            (403, "ai_manager_post_weekly"),
            (429, "ai_manager_own_key"),
            (429, "ai_manager_platform_cap"),
            (429, "ai_limit_account"),
        ] {
            let body = json!({ "error": "Plain words.", "code": code }).to_string();
            let refused = outcome(status, body).expect_err("refused");
            assert_eq!(crate::error::exit_code(&refused), 3, "{code}");
            assert!(refused.to_string().contains(code), "{refused}");
            assert!(refused.to_string().contains("Plain words."), "{refused}");
        }
        // The AI service not answering is not a refusal: exit 2, try again later.
        let down = json!({ "error": "The AI service didn't answer.", "code": "ai_unavailable" });
        let failed = outcome(502, down.to_string()).expect_err("failed");
        assert_eq!(crate::error::exit_code(&failed), 2);
        // A 403 with no code is the server's ordinary "not allowed".
        let plain = outcome(403, r#"{"error":"not a member"}"#.to_string()).expect_err("403");
        assert_eq!(crate::error::exit_code(&plain), 3);
    }
}
