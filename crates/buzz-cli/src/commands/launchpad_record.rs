//! `buzz launchpad updates post` and `buzz launchpad record`: a project's weekly update and its promise record.
//!
//! A weekly update is one signed update record (kind 47003) that names the project (`a`). Its parts ride in tags
//! the web app reads back (`web/src/features/launchpad/lib/weekly-update.ts`, `promises.ts`):
//!
//! * `update-part` `done` / `next`: "What happened this week" and "What's next";
//! * `promise` `<n>` `<words>`: each line of "What's next", when the founder posts it. A promise is the founder's
//!   alone: the server refuses one from anyone else, and from an agent account;
//! * `promise-mark` `<update id>:<n>` `done|not-done|changed` `<note>`: the founder's answer to an earlier promise;
//! * `help-needed`, `help-size`, `help-time`: the help asked for.
//!
//! `record` reads the founder's updates and counts how the promises stand: kept, missed, changed, waiting for the
//! next update, or not answered by it. The rules are the web app's `promiseRecord`: only the founder's records
//! count, an answer names its promise by the id of the update that made it, the dates a signer writes decide
//! nothing between answers, and when the founder answered one promise more than once and differently, the worse
//! answer is the one counted.

use std::collections::{BTreeMap, HashMap, HashSet};

use buzz_core::kind::KIND_LAUNCH_UPDATE;
use clap::Subcommand;
use nostr::{Event, EventBuilder, Kind, Tag};
use serde_json::{json, Value};

use super::launchpad_tasks::{
    goals_as_they_stand, read_founder_updates, read_project, Project, SCHEMA,
};
use crate::client::BuzzClient;
use crate::commands::parse_write_response;
use crate::error::CliError;

const MAX_TITLE: usize = 120;
const MAX_PART: usize = 2_000;
const MAX_HELP: usize = 500;
const MAX_HELP_TIME: usize = 40;
const MAX_PROMISE: usize = 200;
const MAX_MARK_NOTE: usize = 140;
/// The most promises one update makes, and the most answers it carries.
const MAX_PROMISES: usize = 10;
const MAX_MARKS: usize = 30;
/// How many of this account's own updates are read to tell a repeat from a new update.
const OWN_READ_BOUND: u32 = 2_000;

/// A project's weekly update.
#[derive(Subcommand)]
pub enum UpdatesCmd {
    /// Post a weekly update as the founder or a team member: what happened, what is next, what help is needed
    #[command(
        after_help = "Each line of --next is a promise when the founder posts it; the next update answers it with \\
--mark. A team member's update makes no promises (the lines are plans), and neither does an agent account's: \\
promises need a person. Get the promise ids from `buzz launchpad record <id>`.\\n\\n\\
Examples:\\n  \\
buzz launchpad updates post orbit --title 'Week 3' --done 'Shipped the map' --next 'Invite ten people'\\n  \\
buzz launchpad updates post orbit --title 'Week 4' --done 'Ten joined' --mark <UPDATE_ID>:0=done\\n  \\
buzz launchpad updates post orbit --author <FOUNDER> --title 'Docs' --done 'Wrote the guide' \\\\\\n    \\
--help-needed 'Someone to test sign-up' --help-size small"
    )]
    Post {
        /// Project id (slug)
        id: String,
        /// Founder pubkey (64-char hex). Defaults to the current identity.
        #[arg(long)]
        author: Option<String>,
        /// The update's title
        #[arg(long)]
        title: String,
        /// What happened this week
        #[arg(long)]
        done: Option<String>,
        /// What's next, one line per item
        #[arg(long)]
        next: Option<String>,
        /// Free words, used when the two prompts do not fit
        #[arg(long)]
        body: Option<String>,
        /// The help the project needs
        #[arg(long = "help-needed")]
        help_needed: Option<String>,
        /// How big the help asked for is: small, medium or large
        #[arg(long = "help-size", default_value = "small")]
        help_size: String,
        /// Roughly how long, in your own words ("about 3 days")
        #[arg(long = "help-time")]
        help_time: Option<String>,
        /// Answer an earlier promise: <promise id>=<done|not-done|changed>, with an optional ":note" (repeat for
        /// more). Founder only.
        #[arg(long = "mark")]
        marks: Vec<String>,
        /// Post "What's next" as plans, without making promises
        #[arg(long = "no-promises", default_value_t = false)]
        no_promises: bool,
    },
}

fn first_tag(event: &Event, name: &str) -> Option<String> {
    event.tags.iter().find_map(|tag| match tag.as_slice() {
        [n, v, ..] if n.as_str() == name => Some(v.clone()),
        _ => None,
    })
}

fn clip(value: &str, max: usize) -> String {
    value
        .trim()
        .chars()
        .take(max)
        .collect::<String>()
        .trim()
        .to_string()
}

fn tag(parts: &[&str]) -> Result<Tag, CliError> {
    Tag::parse(parts.iter().copied()).map_err(|e| CliError::Other(format!("bad tag: {e}")))
}

/// Whether `value` is a promise's id: the id of the update that made it, a colon, and its number there.
fn is_promise_id(value: &str) -> bool {
    value.split_once(':').is_some_and(|(update, index)| {
        update.len() == 64
            && update
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            && (1..=2).contains(&index.len())
            && index.bytes().all(|b| b.is_ascii_digit())
    })
}

/// The promises in a "What's next" answer: one per line, without the list marks people type ("- ", "* ", "1. "),
/// empty lines left out, each cut to a line's length. The web app's `promiseLines`.
pub(crate) fn promise_lines(next: &str) -> Vec<String> {
    next.lines()
        .map(|line| {
            let line = line.trim();
            let rest = ["- ", "* ", "• "]
                .iter()
                .find_map(|mark| line.strip_prefix(mark))
                .or_else(|| {
                    let digits = line.bytes().take_while(u8::is_ascii_digit).count();
                    let after = line.get(digits..)?;
                    ((1..=2).contains(&digits))
                        .then(|| {
                            after
                                .strip_prefix(". ")
                                .or_else(|| after.strip_prefix(") "))
                        })
                        .flatten()
                })
                .unwrap_or(line);
            clip(rest, MAX_PROMISE)
        })
        .filter(|line| !line.is_empty())
        .take(MAX_PROMISES)
        .collect()
}

/// One answer to an earlier promise, as `--mark` gives it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Mark {
    promise_id: String,
    state: String,
    note: String,
}

/// Read `--mark <promise id>=<done|not-done|changed>[:note]`.
pub(crate) fn parse_mark(value: &str) -> Result<Mark, CliError> {
    let problem = || {
        CliError::Usage(format!(
            "--mark must be <promise id>=<done|not-done|changed>, with an optional :note (got {value:?})"
        ))
    };
    let (promise_id, answer) = value.split_once('=').ok_or_else(problem)?;
    let (state, note) = answer.split_once(':').unwrap_or((answer, ""));
    if !is_promise_id(promise_id) || !matches!(state, "done" | "not-done" | "changed") {
        return Err(problem());
    }
    Ok(Mark {
        promise_id: promise_id.to_string(),
        state: state.to_string(),
        note: clip(note, MAX_MARK_NOTE),
    })
}

/// What a weekly update says, before it is made into a record.
#[derive(Debug, Default, Clone)]
pub(crate) struct UpdateDraft {
    title: String,
    done: String,
    next: String,
    body: String,
    help: String,
    help_size: String,
    help_time: String,
    /// Each answer with the words of the promise it answers, for the readable body.
    marks: Vec<(Mark, String)>,
    /// Whether "What's next" makes promises (the founder's update) or only plans.
    promises: bool,
}

/// The tags and body of a weekly update, as the web app's `updateEvent` writes them.
pub(crate) fn update_parts(draft: &UpdateDraft) -> Result<(Vec<Tag>, Value), CliError> {
    let done = clip(&draft.done, MAX_PART);
    let next = clip(&draft.next, MAX_PART);
    let free = clip(&draft.body, MAX_PART * 2);
    let help = clip(&draft.help, MAX_HELP);
    let help_time = clip(&draft.help_time, MAX_HELP_TIME);
    let size = draft.help_size.as_str();
    let size_label = match size {
        "small" => "Small",
        "medium" => "Medium",
        "large" => "Large",
        other => {
            return Err(CliError::Usage(format!(
                "--help-size must be small, medium or large (got {other:?})"
            )))
        }
    };

    let mut tags = Vec::new();
    if !done.is_empty() {
        tags.push(tag(&["update-part", "done", &done])?);
    }
    if !next.is_empty() {
        tags.push(tag(&["update-part", "next", &next])?);
    }
    let marks: &[(Mark, String)] = if draft.promises { &draft.marks } else { &[] };
    if draft.promises {
        for (index, line) in promise_lines(&next).iter().enumerate() {
            tags.push(tag(&["promise", &index.to_string(), line])?);
        }
        for (mark, _) in marks.iter().take(MAX_MARKS) {
            tags.push(tag(&[
                "promise-mark",
                &mark.promise_id,
                &mark.state,
                &mark.note,
            ])?);
        }
    }
    if !help.is_empty() {
        tags.push(tag(&["help-needed", &help])?);
        tags.push(tag(&["help-size", size])?);
        if !help_time.is_empty() {
            tags.push(tag(&["help-time", &help_time])?);
        }
    }
    // Written freely: nothing above says it is a weekly update, so it says so itself.
    if done.is_empty() && next.is_empty() && marks.is_empty() {
        tags.push(tag(&["update-kind", "weekly"])?);
    }

    let mut sections: Vec<String> = Vec::new();
    if !free.is_empty() {
        sections.push(free);
    }
    if !marks.is_empty() {
        let lines: Vec<String> = marks
            .iter()
            .take(MAX_MARKS)
            .map(|(mark, text)| {
                let label = match mark.state.as_str() {
                    "done" => "Done",
                    "not-done" => "Not done",
                    _ => "Changed",
                };
                if mark.note.is_empty() {
                    format!("{label}: {text}")
                } else {
                    format!("{label}: {text} ({})", mark.note)
                }
            })
            .collect();
        sections.push(format!("What we said last time\n{}", lines.join("\n")));
    }
    if !done.is_empty() {
        sections.push(format!("What happened this week\n{done}"));
    }
    if !next.is_empty() {
        sections.push(format!("What's next\n{next}"));
    }
    if !help.is_empty() {
        let size_line = if help_time.is_empty() {
            size_label.to_string()
        } else {
            format!("{size_label}, {help_time}")
        };
        sections.push(format!("Help needed ({size_line})\n{help}"));
    }
    Ok((
        tags,
        json!({ "title": clip(&draft.title, MAX_TITLE), "body": sections.join("\n\n") }),
    ))
}

/// How one promise stands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PromiseEntry {
    id: String,
    text: String,
    promised_at: u64,
    /// `kept`, `missed`, `changed`, `waiting` (no later update yet) or `unanswered` (a later update did not say).
    state: &'static str,
    note: String,
    /// Every answer the founder gave: its word and when its update says it was posted.
    answers: Vec<(String, u64)>,
    /// The founder answered more than once and the answers disagree.
    conflict: bool,
}

struct FounderUpdate<'a> {
    id: String,
    at: u64,
    weekly: bool,
    promises: Vec<(usize, String)>,
    marks: Vec<(String, &'a str, String)>,
}

fn founder_update(event: &Event) -> FounderUpdate<'_> {
    let mut promises: Vec<(usize, String)> = Vec::new();
    let mut marks: Vec<(String, &str, String)> = Vec::new();
    let mut weekly = false;
    for tag in event.tags.iter() {
        match tag.as_slice() {
            [n, ..] if n.as_str() == "update-part" => weekly = true,
            [n, kind, ..] if n.as_str() == "update-kind" && kind.as_str() == "weekly" => {
                weekly = true
            }
            [n, rest @ ..] if n.as_str() == "promise" => {
                weekly = true;
                let (Some(index), Some(text)) = (rest.first(), rest.get(1)) else {
                    continue;
                };
                let numbered =
                    (1..=2).contains(&index.len()) && index.bytes().all(|b| b.is_ascii_digit());
                let text = clip(text, MAX_PROMISE);
                let Ok(index) = index.parse::<usize>() else {
                    continue;
                };
                if numbered
                    && !text.is_empty()
                    && promises.len() < MAX_PROMISES
                    && !promises.iter().any(|(have, _)| *have == index)
                {
                    promises.push((index, text));
                }
            }
            [n, rest @ ..] if n.as_str() == "promise-mark" => {
                weekly = true;
                let (Some(id), Some(state)) = (rest.first(), rest.get(1)) else {
                    continue;
                };
                let state = match state.as_str() {
                    "done" => "done",
                    "not-done" => "not-done",
                    "changed" => "changed",
                    _ => continue,
                };
                // One answer per promise in one update: the first one given.
                if is_promise_id(id)
                    && marks.len() < MAX_MARKS
                    && !marks.iter().any(|(have, _, _)| have == id)
                {
                    let note = rest
                        .get(2)
                        .map(|n| clip(n, MAX_MARK_NOTE))
                        .unwrap_or_default();
                    marks.push((id.clone(), state, note));
                }
            }
            _ => {}
        }
    }
    promises.sort_by_key(|(index, _)| *index);
    FounderUpdate {
        id: event.id.to_hex(),
        at: event.created_at.as_secs(),
        weekly,
        promises,
        marks,
    }
}

/// Every promise the founder's updates made, with how each stands. `updates` are the project's update records;
/// anyone else's are ignored. Ordered by the id of the promise, so the listing never depends on a signer's dates.
pub(crate) fn promise_record(updates: &[Event], founder: &str) -> Vec<PromiseEntry> {
    let mut seen = HashSet::new();
    let mut mine: Vec<FounderUpdate> = updates
        .iter()
        .filter(|e| {
            e.kind.as_u16() as u32 == KIND_LAUNCH_UPDATE
                && e.pubkey.to_hex() == founder
                && seen.insert(e.id)
        })
        .map(founder_update)
        .collect();
    // Which update each update answers: an answer names the update that made its promise, so it came after it.
    let answered: HashMap<String, HashSet<String>> = mine
        .iter()
        .map(|u| {
            let named = u
                .marks
                .iter()
                .filter_map(|(id, _, _)| id.split_once(':').map(|(update, _)| update.to_string()))
                .collect();
            (u.id.clone(), named)
        })
        .collect();
    // Oldest first. Two signed in the same second go in the order their answers prove, then by id.
    mine.sort_by(|a, b| {
        a.at.cmp(&b.at).then_with(|| {
            if answered.get(&a.id).is_some_and(|set| set.contains(&b.id)) {
                std::cmp::Ordering::Greater
            } else if answered.get(&b.id).is_some_and(|set| set.contains(&a.id)) {
                std::cmp::Ordering::Less
            } else {
                a.id.cmp(&b.id)
            }
        })
    });
    let made: HashMap<String, &str> = mine
        .iter()
        .flat_map(|u| {
            u.promises
                .iter()
                .map(move |(index, _)| (format!("{}:{index}", u.id), u.id.as_str()))
        })
        .collect();
    let mut answers: HashMap<&str, Vec<(&str, &str, u64)>> = HashMap::new();
    for update in &mine {
        for (promise, state, note) in &update.marks {
            // An update cannot answer its own promises, and an answer to a promise that is not there answers nothing.
            if made.get(promise).is_none_or(|maker| *maker == update.id) {
                continue;
            }
            answers
                .entry(promise.as_str())
                .or_default()
                .push((state, note.as_str(), update.at));
        }
    }
    let newest_weekly = mine.iter().rev().find(|u| u.weekly).map(|u| u.id.as_str());
    let mut entries = Vec::new();
    for update in &mine {
        for (index, text) in &update.promises {
            let id = format!("{}:{index}", update.id);
            let given = answers.get(id.as_str()).cloned().unwrap_or_default();
            // When the answers disagree the worse one is counted.
            let counted = ["not-done", "changed", "done"]
                .into_iter()
                .find(|state| given.iter().any(|(have, _, _)| have == state));
            let states: HashSet<&str> = given.iter().map(|(state, _, _)| *state).collect();
            let state = match counted {
                Some("done") => "kept",
                Some("not-done") => "missed",
                Some(_) => "changed",
                None if newest_weekly.is_some_and(|newest| newest != update.id) => "unanswered",
                None => "waiting",
            };
            entries.push(PromiseEntry {
                id,
                text: text.clone(),
                promised_at: update.at,
                state,
                note: given
                    .iter()
                    .find(|(have, _, _)| Some(*have) == counted)
                    .map(|(_, note, _)| note.to_string())
                    .unwrap_or_default(),
                answers: given
                    .iter()
                    .map(|(state, _, at)| (state.to_string(), *at))
                    .collect(),
                conflict: states.len() > 1,
            });
        }
    }
    entries.sort_by(|a, b| a.id.cmp(&b.id));
    entries
}

/// The totals of a promise record, with every state present even at zero.
pub(crate) fn promise_totals(entries: &[PromiseEntry]) -> Value {
    let count = |state: &str| entries.iter().filter(|e| e.state == state).count();
    json!({
        "promised": entries.len(),
        "kept": count("kept"),
        "missed": count("missed"),
        "changed": count("changed"),
        "waiting": count("waiting"),
        "unanswered": count("unanswered"),
        "answered_more_than_once": entries.iter().filter(|e| e.conflict).count(),
    })
}

fn goal_totals(goals: &BTreeMap<String, Value>) -> Value {
    let count = |state: &str| {
        goals
            .values()
            .filter(|goal| goal["state"].as_str() == Some(state))
            .count()
    };
    json!({
        "goals": goals.len(),
        "open": count("open"),
        "reached": count("reached"),
        "missed": count("missed"),
        "changed": count("changed"),
    })
}

/// `buzz launchpad record <id> [--author <hex>]`
pub async fn cmd_record(
    client: &BuzzClient,
    id: &str,
    author: Option<&str>,
) -> Result<(), CliError> {
    let me = client.keys().public_key().to_hex();
    let owner = author.map_or_else(|| me.clone(), str::to_string);
    let project = read_project(client, id, &owner).await?;
    let (updates, complete) = read_founder_updates(client, &project).await?;
    let entries = promise_record(&updates, project.founder());
    let goals = goals_as_they_stand(&updates, project.founder());
    println!(
        "{}",
        json!({
            "schema": SCHEMA,
            "project": {
                "id": id,
                "author": project.founder(),
                "name": project.name,
                "coordinate": project.coordinate,
            },
            "promises": promise_totals(&entries),
            "goals": goal_totals(&goals),
            "promise_list": entries.iter().map(|e| json!({
                "promise_id": e.id,
                "text": e.text,
                "promised_at": e.promised_at,
                "state": e.state,
                "note": e.note,
                "answers": e.answers.iter().map(|(state, at)| json!({ "answer": state, "at": at })).collect::<Vec<_>>(),
                "answered_more_than_once": e.conflict,
            })).collect::<Vec<_>>(),
            "goal_list": goals.values().collect::<Vec<_>>(),
            // False: the founder has more records than were read, so the totals are of the newest ones only.
            "complete": complete,
            "note": "Only the founder's own updates count. A removed update takes its promises with it; the web page says how many records a founder removed.",
        })
    );
    Ok(())
}

/// What an update says, reduced to what makes two updates the same update: its title and its tags.
fn update_identity(title: &str, tags: &[Tag]) -> (String, Vec<Vec<String>>) {
    let mut parts: Vec<Vec<String>> = tags
        .iter()
        .map(|t| t.as_slice().to_vec())
        .filter(|t| t.first().is_some_and(|n| n != "a" && n != "auth"))
        .collect();
    parts.sort();
    (title.to_string(), parts)
}

#[allow(clippy::too_many_arguments)]
async fn cmd_post(
    client: &BuzzClient,
    id: &str,
    author: Option<&str>,
    title: &str,
    done: Option<&str>,
    next: Option<&str>,
    body: Option<&str>,
    help_needed: Option<&str>,
    help_size: &str,
    help_time: Option<&str>,
    marks: &[String],
    no_promises: bool,
) -> Result<(), CliError> {
    if title.trim().is_empty() {
        return Err(CliError::Usage("--title must say something".into()));
    }
    let has = |value: Option<&str>| value.is_some_and(|v| !v.trim().is_empty());
    if !has(done) && !has(next) && !has(body) && !has(help_needed) && marks.is_empty() {
        return Err(CliError::Usage(
            "an update says something: --done, --next, --body, --help-needed or --mark".into(),
        ));
    }
    let marks: Vec<Mark> = marks
        .iter()
        .map(|m| parse_mark(m))
        .collect::<Result<_, _>>()?;
    if marks.len() > MAX_MARKS {
        return Err(CliError::Usage(format!(
            "at most {MAX_MARKS} --mark answers"
        )));
    }
    let me = client.keys().public_key().to_hex();
    let owner = author.map_or_else(|| me.clone(), str::to_string);
    let project: Project = read_project(client, id, &owner).await?;
    if !project.team.contains(&me) {
        return Err(CliError::Usage(
            "this account is not the project's founder or on its team: only they post its updates"
                .into(),
        ));
    }
    let is_founder = project.founder() == me;
    let promises = is_founder && !no_promises;
    if !marks.is_empty() && !promises {
        return Err(CliError::Usage(
            "only the founder answers the project's promises (and not with --no-promises)".into(),
        ));
    }

    // Each answer must name a promise the founder made and has not answered yet.
    let mut answered: Vec<(Mark, String)> = Vec::new();
    if !marks.is_empty() {
        let (updates, complete) = read_founder_updates(client, &project).await?;
        if !complete {
            return Err(CliError::Other(
                "this project has more updates than could be read, so its promises are not all known".into(),
            ));
        }
        let record = promise_record(&updates, &me);
        for mark in marks {
            let entry = record
                .iter()
                .find(|e| e.id == mark.promise_id)
                .ok_or_else(|| {
                    CliError::NotFound(format!(
                        "promise {} is not one this project made",
                        mark.promise_id
                    ))
                })?;
            if !entry.answers.is_empty() {
                return Err(CliError::Conflict(format!(
                    "promise {} was already answered; an answer cannot be changed",
                    mark.promise_id
                )));
            }
            if answered
                .iter()
                .any(|(have, _)| have.promise_id == mark.promise_id)
            {
                return Err(CliError::Usage(format!(
                    "promise {} is answered twice in this update",
                    mark.promise_id
                )));
            }
            answered.push((mark, entry.text.clone()));
        }
    }

    let draft = UpdateDraft {
        title: title.to_string(),
        done: done.unwrap_or("").to_string(),
        next: next.unwrap_or("").to_string(),
        body: body.unwrap_or("").to_string(),
        help: help_needed.unwrap_or("").to_string(),
        help_size: help_size.to_string(),
        help_time: help_time.unwrap_or("").to_string(),
        marks: answered,
        promises,
    };
    let (tags, content) = update_parts(&draft)?;

    // The same update sent twice is one update: a retry after a lost answer sends nothing new.
    let filter = json!({
        "kinds": [KIND_LAUNCH_UPDATE],
        "authors": [me],
        "#a": [project.coordinate],
    });
    let own = client
        .query_pages_bounded(filter, OWN_READ_BOUND + 1)
        .await?;
    if own.len() > OWN_READ_BOUND as usize {
        return Err(CliError::Other(
            "this account has more records on this project than could be read, so a repeat could not be ruled out".into(),
        ));
    }
    let clean_title = content["title"].as_str().unwrap_or_default().to_string();
    let wanted = update_identity(&clean_title, &tags);
    for raw in own {
        let event: Event = serde_json::from_value(raw)
            .map_err(|e| CliError::Other(format!("failed to parse relay response: {e}")))?;
        let their_title = serde_json::from_str::<Value>(event.content.as_str())
            .ok()
            .and_then(|body| body["title"].as_str().map(str::to_string))
            .unwrap_or_default();
        let theirs: Vec<Tag> = event.tags.iter().cloned().collect();
        if first_tag(&event, "a").as_deref() == Some(project.coordinate.as_str())
            && update_identity(&their_title, &theirs) == wanted
        {
            return Err(CliError::Conflict(
                "this account already posted exactly this update".into(),
            ));
        }
    }

    let mut all = vec![tag(&["a", &project.coordinate])?];
    all.extend(tags);
    let builder =
        EventBuilder::new(Kind::Custom(KIND_LAUNCH_UPDATE as u16), content.to_string()).tags(all);
    let event = client.sign_event(builder)?;
    let promised: Vec<Value> = event
        .tags
        .iter()
        .filter_map(|t| match t.as_slice() {
            [n, index, text, ..] if n.as_str() == "promise" => Some(json!({
                "promise_id": format!("{}:{index}", event.id.to_hex()),
                "text": text,
            })),
            _ => None,
        })
        .collect();
    let raw = client.submit_event(event).await?;
    let mut answer: Value = serde_json::from_str(&parse_write_response(
        &raw,
        "the server already has this update",
    )?)
    .map_err(|e| CliError::Other(format!("invalid relay response: {e}")))?;
    // The ids the next update answers with --mark.
    answer["promises"] = json!(promised);
    println!("{answer}");
    Ok(())
}

/// Run one `buzz launchpad updates` command.
pub async fn dispatch(cmd: UpdatesCmd, client: &BuzzClient) -> Result<(), CliError> {
    match cmd {
        UpdatesCmd::Post {
            id,
            author,
            title,
            done,
            next,
            body,
            help_needed,
            help_size,
            help_time,
            marks,
            no_promises,
        } => {
            cmd_post(
                client,
                &id,
                author.as_deref(),
                &title,
                done.as_deref(),
                next.as_deref(),
                body.as_deref(),
                help_needed.as_deref(),
                &help_size,
                help_time.as_deref(),
                &marks,
                no_promises,
            )
            .await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;
    use nostr::{Keys, Timestamp};

    const COORD: &str = "37001:founder:orbit";

    fn sign(who: &Keys, tags: Vec<Vec<String>>, at: u64) -> Event {
        let mut all = vec![Tag::parse(["a", COORD]).expect("tag")];
        all.extend(tags.into_iter().map(|t| Tag::parse(t).expect("tag")));
        EventBuilder::new(Kind::Custom(KIND_LAUNCH_UPDATE as u16), "{}")
            .tags(all)
            .custom_created_at(Timestamp::from(at))
            .sign_with_keys(who)
            .expect("signed")
    }

    fn strings(tags: &[&[&str]]) -> Vec<Vec<String>> {
        tags.iter()
            .map(|t| t.iter().map(|f| f.to_string()).collect())
            .collect()
    }

    fn pairs(tags: &[Tag]) -> Vec<Vec<String>> {
        tags.iter().map(|t| t.as_slice().to_vec()).collect()
    }

    fn state_of<'a>(record: &'a [PromiseEntry], id: &str) -> &'a str {
        record
            .iter()
            .find(|e| e.id == id)
            .map(|e| e.state)
            .expect("the promise is in the record")
    }

    #[test]
    fn an_update_is_written_as_the_web_app_reads_it() {
        let draft = UpdateDraft {
            title: "  Week 3  ".into(),
            done: "Shipped the map".into(),
            next: "- Invite ten people\n2. Fix the email\n\n".into(),
            help: "Someone to test sign-up".into(),
            help_size: "medium".into(),
            help_time: "about 3 days".into(),
            promises: true,
            ..UpdateDraft::default()
        };
        let (tags, content) = update_parts(&draft).expect("an update");
        assert_eq!(
            pairs(&tags),
            strings(&[
                &["update-part", "done", "Shipped the map"],
                &[
                    "update-part",
                    "next",
                    "- Invite ten people\n2. Fix the email"
                ],
                &["promise", "0", "Invite ten people"],
                &["promise", "1", "Fix the email"],
                &["help-needed", "Someone to test sign-up"],
                &["help-size", "medium"],
                &["help-time", "about 3 days"],
            ])
        );
        assert_eq!(content["title"], "Week 3");
        assert_eq!(
            content["body"],
            "What happened this week\nShipped the map\n\nWhat's next\n- Invite ten people\n2. Fix the email\n\n\
             Help needed (Medium, about 3 days)\nSomeone to test sign-up"
        );

        // A team member's update (or --no-promises): the same words, no promise and no answer.
        let mark = parse_mark(&format!("{}:0=done", "a".repeat(64))).expect("a mark");
        let plans = UpdateDraft {
            promises: false,
            marks: vec![(mark.clone(), "Invite ten people".into())],
            ..draft.clone()
        };
        let (tags, content) = update_parts(&plans).expect("an update");
        assert!(pairs(&tags)
            .iter()
            .all(|t| t[0] != "promise" && t[0] != "promise-mark"));
        assert!(!content["body"]
            .as_str()
            .expect("body")
            .contains("What we said last time"));

        // The founder's answers ride as tags and as words.
        let answering = UpdateDraft {
            title: "Week 4".into(),
            done: "Ten joined".into(),
            help_size: "small".into(),
            marks: vec![(
                Mark {
                    note: "ran out of time".into(),
                    state: "not-done".into(),
                    ..mark.clone()
                },
                "Fix the email".into(),
            )],
            promises: true,
            ..UpdateDraft::default()
        };
        let (tags, content) = update_parts(&answering).expect("an update");
        assert!(pairs(&tags).contains(&vec![
            "promise-mark".to_string(),
            format!("{}:0", "a".repeat(64)),
            "not-done".to_string(),
            "ran out of time".to_string(),
        ]));
        assert!(content["body"]
            .as_str()
            .expect("body")
            .starts_with("What we said last time\nNot done: Fix the email (ran out of time)"));

        // Written freely: it says itself that it is a weekly update.
        let free = UpdateDraft {
            title: "News".into(),
            body: "We moved.".into(),
            help_size: "small".into(),
            promises: true,
            ..UpdateDraft::default()
        };
        let (tags, _) = update_parts(&free).expect("an update");
        assert_eq!(pairs(&tags), strings(&[&["update-kind", "weekly"]]));

        let bad = UpdateDraft {
            help_size: "huge".into(),
            ..free
        };
        assert!(update_parts(&bad).is_err());
    }

    #[test]
    fn a_mark_names_one_promise_and_one_answer() {
        let id = format!("{}:3", "b".repeat(64));
        assert_eq!(
            parse_mark(&format!("{id}=changed:we chose another road")).expect("a mark"),
            Mark {
                promise_id: id.clone(),
                state: "changed".into(),
                note: "we chose another road".into(),
            }
        );
        for bad in [
            id.clone(),
            format!("{id}=maybe"),
            format!("{}=done", "b".repeat(64)),
            format!("{}:123=done", "b".repeat(64)),
            "0=done".to_string(),
        ] {
            assert!(parse_mark(&bad).is_err(), "{bad}");
        }
        assert_eq!(
            promise_lines("* one\n• two\n 3) three\n12. twelve\n123. not a list mark\n\n"),
            vec!["one", "two", "three", "twelve", "123. not a list mark"]
        );
        assert_eq!(promise_lines(&"x\n".repeat(30)).len(), MAX_PROMISES);
    }

    #[test]
    fn the_record_counts_kept_missed_and_changed_from_the_founders_updates_alone() {
        let (founder, mate) = (Keys::generate(), Keys::generate());
        let founder_hex = founder.public_key().to_hex();
        let first = sign(
            &founder,
            strings(&[
                &["update-part", "next", "a\nb\nc\nd"],
                &["promise", "0", "Invite ten people"],
                &["promise", "1", "Fix the email"],
                &["promise", "2", "Write the guide"],
                &["promise", "3", "Call the printer"],
            ]),
            100,
        );
        let id = first.id.to_hex();
        let p = |n: usize| format!("{id}:{n}");
        let second = sign(
            &founder,
            strings(&[
                &["update-part", "done", "A week"],
                &["promise-mark", &p(0), "done", ""],
                &["promise-mark", &p(1), "not-done", "ran out of time"],
                &["promise-mark", &p(2), "changed", "a video instead"],
                // Not a promise this project made, and an answer nobody understands.
                &["promise-mark", &format!("{}:0", "c".repeat(64)), "done", ""],
                &["promise-mark", &p(3), "maybe", ""],
                &["promise", "0", "Ship the video"],
            ]),
            200,
        );
        // A team member's records make and answer nothing, whatever they carry.
        let forged = sign(
            &mate,
            strings(&[
                &["promise", "0", "Pay the mate"],
                &["promise-mark", &p(1), "done", ""],
            ]),
            300,
        );
        let updates = vec![first.clone(), second.clone(), forged];
        let record = promise_record(&updates, &founder_hex);
        assert_eq!(record.len(), 5);
        assert_eq!(state_of(&record, &p(0)), "kept");
        assert_eq!(state_of(&record, &p(1)), "missed");
        assert_eq!(state_of(&record, &p(2)), "changed");
        // The next update did not say: not hidden, and not counted as kept.
        assert_eq!(state_of(&record, &p(3)), "unanswered");
        // The newest update's own promise waits for the next one.
        assert_eq!(
            state_of(&record, &format!("{}:0", second.id.to_hex())),
            "waiting"
        );
        assert_eq!(
            promise_totals(&record),
            json!({
                "promised": 5, "kept": 1, "missed": 1, "changed": 1, "waiting": 1, "unanswered": 1,
                "answered_more_than_once": 0,
            })
        );
        assert_eq!(
            record.iter().find(|e| e.id == p(1)).expect("entry").note,
            "ran out of time"
        );

        // Answering again and differently takes no miss away: the worse answer is counted, whatever the dates say.
        let rewrite = sign(
            &founder,
            strings(&[
                &["update-part", "done", "Looking back"],
                &["promise-mark", &p(1), "done", "it was fine really"],
                &["promise-mark", &p(0), "not-done", ""],
            ]),
            50,
        );
        let mut again = updates.clone();
        again.push(rewrite);
        let record = promise_record(&again, &founder_hex);
        assert_eq!(state_of(&record, &p(1)), "missed");
        assert_eq!(state_of(&record, &p(0)), "missed");
        assert_eq!(promise_totals(&record)["answered_more_than_once"], 2);

        // The same record read twice is one record, and an update cannot answer its own promise.
        let own = sign(
            &founder,
            strings(&[
                &["promise", "0", "Self-serve"],
                &["update-part", "next", "x"],
            ]),
            400,
        );
        let own_id = format!("{}:0", own.id.to_hex());
        let marked_itself = promise_record(&[own.clone(), own], &founder_hex);
        assert_eq!(marked_itself.len(), 1);
        assert_eq!(state_of(&marked_itself, &own_id), "waiting");
    }

    #[test]
    fn two_updates_in_one_second_are_ordered_by_what_they_answer() {
        let founder = Keys::generate();
        let founder_hex = founder.public_key().to_hex();
        // Try several pairs so the id order goes both ways.
        for n in 0..6 {
            let text = format!("Promise {n}");
            let first = sign(
                &founder,
                strings(&[&["update-part", "next", &text], &["promise", "0", &text]]),
                100,
            );
            let id = format!("{}:0", first.id.to_hex());
            let second = sign(
                &founder,
                strings(&[
                    &["update-part", "done", "x"],
                    &["promise-mark", &id, "done", ""],
                ]),
                100,
            );
            let record = promise_record(&[second, first], &founder_hex);
            assert_eq!(state_of(&record, &id), "kept");
        }
    }

    #[test]
    fn the_commands_parse() {
        let hex = "a".repeat(64);
        let mark = format!("{hex}:0=done");
        for args in [
            vec![
                "updates", "post", "orbit", "--title", "Week 3", "--done", "Shipped",
            ],
            vec![
                "updates",
                "post",
                "orbit",
                "--author",
                hex.as_str(),
                "--title",
                "W",
                "--next",
                "a\nb",
                "--help-needed",
                "A tester",
                "--help-size",
                "large",
                "--help-time",
                "a day",
                "--mark",
                mark.as_str(),
                "--no-promises",
            ],
            vec!["record", "orbit"],
            vec!["record", "orbit", "--author", hex.as_str()],
        ] {
            let mut all = vec!["buzz", "launchpad"];
            all.extend(args.iter().copied());
            assert!(crate::Cli::try_parse_from(all).is_ok(), "{args:?}");
        }
    }
}
