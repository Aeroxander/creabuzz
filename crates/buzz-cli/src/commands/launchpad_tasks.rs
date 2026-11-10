//! `buzz launchpad tasks …`: a helper's side of tasks with a finish line.
//!
//! A project asks for help in an update; someone offers; the team makes a task for them, and they say yes to it, with
//! "Done means" written down; the helper hands work in; someone else on the team checks it. Every step is one signed
//! update record (kind 47003) that names the project (`a`), carries `l` = `creaton-task` and says which step it is in
//! `task-part`. The web app writes and reads the same records (`web/src/features/launchpad/lib/tasks.ts`).
//!
//! What this tool can do is what a helper can do, whether a person or an agent runs it:
//!
//! * `list`: a project's open help requests and its tasks, with each task's state worked out from who signed what;
//! * `offer`: "I can help" on an update that asks for help;
//! * `accept`: say yes to a task that names this account. A task is this account's only once it signs a step for that
//!   task: an offer to help is never agreement, since any project could name any offer ever made;
//! * `submit`: hand work in, as words and links;
//! * `more-time`: ask for more time, with a reason.
//!
//! There is deliberately no command to confirm work, send it back, cancel a task, vote or award anything: the one who
//! did the work never checks it, and those steps need a person on the project's team.
//!
//! A write first reads what it answers and refuses when that is not there or not this account's to answer, and it
//! refuses to send what this account already sent, so a retry after a lost answer never makes a second record.

use std::collections::{BTreeMap, HashMap, HashSet};

use buzz_core::kind::{KIND_LAUNCH_RECORD, KIND_LAUNCH_UPDATE};
use clap::Subcommand;
use nostr::{Event, EventBuilder, Kind, Tag};
use serde_json::{json, Value};

use crate::client::BuzzClient;
use crate::commands::parse_write_response;
use crate::error::CliError;

/// The `l` label every task record carries.
const TASK_LABEL: &str = "creaton-task";
/// How many of a project's task records are read. More than this and the listing says it is not complete.
const TASK_READ_BOUND: u32 = 5_000;
/// How many records are read for a project's help requests and what answers them.
const HELP_READ_BOUND: u32 = 2_000;
/// How many team members one step names so each is told.
const TEAM_TOLD: usize = 12;
/// The most links one piece of handed-in work carries.
const MAX_LINKS: usize = 5;
const MAX_NOTE: usize = 1_000;
const MAX_LINK: usize = 500;

/// A helper's side of tasks with a finish line.
#[derive(Subcommand)]
pub enum TasksCmd {
    /// List a project's open help requests and its tasks, with each task's state
    List {
        /// Project id (slug)
        id: String,
        /// Founder pubkey (64-char hex). Defaults to the current identity.
        #[arg(long)]
        author: Option<String>,
    },
    /// Offer to help on an update that asks for help (public; not an agreement, and not a yes to any task)
    Offer {
        /// Project id (slug)
        id: String,
        /// Founder pubkey (64-char hex)
        #[arg(long)]
        author: String,
        /// Event id of the update that asks for help (64-char hex)
        #[arg(long)]
        update: String,
        /// A short public note: what you can do
        #[arg(long)]
        note: Option<String>,
    },
    /// Say yes to a task that names you. A task is yours only once you say yes, including one the team made from an
    /// offer of yours: an offer to help is not agreement to a task.
    Accept {
        /// Project id (slug)
        id: String,
        /// Founder pubkey (64-char hex)
        #[arg(long)]
        author: String,
        /// Task id (64-char hex)
        #[arg(long)]
        task: String,
    },
    /// Hand in work on your task: a few words and links. Someone else on the team checks it.
    Submit {
        /// Project id (slug)
        id: String,
        /// Founder pubkey (64-char hex)
        #[arg(long)]
        author: String,
        /// Task id (64-char hex)
        #[arg(long)]
        task: String,
        /// What was done, and where to look
        #[arg(long)]
        note: Option<String>,
        /// A web link to the work (repeat for more; at most 5)
        #[arg(long = "link")]
        links: Vec<String>,
    },
    /// Ask for more time on your task
    #[command(name = "more-time")]
    MoreTime {
        /// Project id (slug)
        id: String,
        /// Founder pubkey (64-char hex)
        #[arg(long)]
        author: String,
        /// Task id (64-char hex)
        #[arg(long)]
        task: String,
        /// Why more time is needed
        #[arg(long)]
        reason: String,
        /// The date asked for (YYYY-MM-DD)
        #[arg(long)]
        until: Option<String>,
    },
}

fn is_hex64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn require_hex64(value: &str, what: &str) -> Result<(), CliError> {
    if is_hex64(value) {
        Ok(())
    } else {
        Err(CliError::Usage(format!(
            "{what} must be 64 lowercase hex characters"
        )))
    }
}

/// A real calendar date written `YYYY-MM-DD`, or `None`.
fn valid_date(value: &str) -> Option<String> {
    chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .ok()
        .filter(|_| value.len() == 10)
        .map(|date| date.format("%Y-%m-%d").to_string())
}

/// A web link as evidence may carry it: http or https, of a sane length.
fn valid_link(value: &str) -> Option<String> {
    let text = value.trim();
    if text.is_empty() || text.len() > MAX_LINK || text.chars().any(char::is_whitespace) {
        return None;
    }
    let rest = text
        .strip_prefix("https://")
        .or_else(|| text.strip_prefix("http://"))?;
    if rest.is_empty() || rest.starts_with('/') {
        return None;
    }
    Some(text.to_string())
}

fn first_tag(event: &Event, name: &str) -> Option<String> {
    event.tags.iter().find_map(|tag| match tag.as_slice() {
        [n, v, ..] if n.as_str() == name => Some(v.clone()),
        _ => None,
    })
}

fn all_tags(event: &Event, name: &str) -> Vec<String> {
    event
        .tags
        .iter()
        .filter_map(|tag| match tag.as_slice() {
            [n, v, ..] if n.as_str() == name => Some(v.clone()),
            _ => None,
        })
        .collect()
}

/// Whether an update record is a task record: it carries a `task-part` tag. Task records are steps on a task, never
/// news, so they are not listed or counted as updates.
pub(crate) fn is_task_record(event: &Event) -> bool {
    event
        .tags
        .iter()
        .any(|tag| matches!(tag.as_slice(), [n, ..] if n.as_str() == "task-part"))
}

/// Whether an update record is an offer to help, a reply to one, or "Help found": it answers an update and is not
/// one.
pub(crate) fn is_help_signal(event: &Event) -> bool {
    event.tags.iter().any(|tag| {
        matches!(tag.as_slice(), [n, ..] if matches!(n.as_str(), "help-offer" | "help-reply" | "help-found"))
    })
}

/// The words a step carries: `note` in its JSON body.
fn note_of(event: &Event) -> String {
    serde_json::from_str::<Value>(event.content.as_str())
        .ok()
        .and_then(|body| body.get("note").and_then(Value::as_str).map(str::to_string))
        .map(|note| note.trim().chars().take(MAX_NOTE).collect())
        .unwrap_or_default()
}

/// One task record, as read. Who signed it is `author`; whether that gives it any weight is decided in
/// [`project_tasks`].
#[derive(Debug, Clone)]
struct TaskRecord {
    id: String,
    part: String,
    author: String,
    at: u64,
    coordinate: String,
    task_id: String,
    note: String,
    helper: String,
    what: String,
    done: String,
    size: String,
    due: Option<String>,
    update_id: Option<String>,
    offer_id: Option<String>,
    evidence_id: Option<String>,
    ask_id: Option<String>,
    links: Vec<String>,
    files: Vec<Value>,
    /// The record carries an `agent` or an `auth` tag: an agent signed it.
    agent: bool,
    /// The owner its `auth` tag proves, when the signature holds.
    owner: Option<String>,
}

const PARTS: [&str; 9] = [
    "task",
    "accept",
    "evidence",
    "send-back",
    "confirm",
    "more-time",
    "grant",
    "give-up",
    "cancel",
];

/// The owner a record's `auth` tag proves for its signer, by the owner's signature.
fn proven_owner(event: &Event) -> Option<String> {
    let tag = event
        .tags
        .iter()
        .find(|tag| matches!(tag.as_slice(), [n, ..] if n.as_str() == "auth"))?;
    let json = serde_json::to_string(tag.as_slice()).ok()?;
    buzz_sdk::nip_oa::verify_auth_tag(&json, &event.pubkey)
        .ok()
        .map(|owner| owner.to_hex())
}

/// The task record an update record is, or `None` when it is not one or cannot be read as one. The same rules as the
/// web app's `parseTaskRecord`.
fn parse_task_record(event: &Event) -> Option<TaskRecord> {
    if event.kind.as_u16() as u32 != KIND_LAUNCH_UPDATE {
        return None;
    }
    let parts = all_tags(event, "task-part");
    // Exactly one step: a record that claims to be two things is neither.
    let [part] = parts.as_slice() else {
        return None;
    };
    if !PARTS.contains(&part.as_str()) {
        return None;
    }
    let coordinate = first_tag(event, "a")?;
    let id = event.id.to_hex();
    let note = note_of(event);
    // An agent's record says so: an `agent` tag naming its own signer, or an owner's `auth` proof. An `agent` tag
    // naming anyone else says nothing about this record.
    let signer = event.pubkey.to_hex();
    let agent = event.tags.iter().any(|tag| match tag.as_slice() {
        [n, who, ..] if n.as_str() == "agent" => *who == signer,
        [n, ..] => n.as_str() == "auth",
        _ => false,
    });
    let mut record = TaskRecord {
        id: id.clone(),
        part: part.clone(),
        author: event.pubkey.to_hex(),
        at: event.created_at.as_secs(),
        coordinate,
        task_id: id,
        note,
        helper: String::new(),
        what: String::new(),
        done: String::new(),
        size: String::new(),
        due: first_tag(event, "task-due").and_then(|d| valid_date(&d)),
        update_id: None,
        offer_id: None,
        evidence_id: None,
        ask_id: None,
        links: Vec::new(),
        files: Vec::new(),
        agent,
        owner: None,
    };
    if part == "task" {
        let helper = first_tag(event, "task-helper").filter(|h| is_hex64(h))?;
        let what = first_tag(event, "task-what")?.trim().to_string();
        let done = first_tag(event, "task-done")?.trim().to_string();
        let size = first_tag(event, "task-size")
            .filter(|s| matches!(s.as_str(), "small" | "medium" | "large"))?;
        // A task without its words or its finish line is not a task.
        if what.is_empty() || done.is_empty() {
            return None;
        }
        record.helper = helper;
        record.what = what;
        record.done = done;
        record.size = size;
        record.update_id = first_tag(event, "task-update").filter(|v| is_hex64(v));
        record.offer_id = first_tag(event, "task-offer").filter(|v| is_hex64(v));
        return Some(record);
    }
    record.task_id = first_tag(event, "task").filter(|v| is_hex64(v))?;
    match part.as_str() {
        "evidence" => {
            for link in all_tags(event, "task-link") {
                if let Some(link) = valid_link(&link) {
                    if record.links.len() < MAX_LINKS && !record.links.contains(&link) {
                        record.links.push(link);
                    }
                }
            }
            for tag in event.tags.iter() {
                if let [n, hash, rest @ ..] = tag.as_slice() {
                    if n.as_str() == "task-file" && is_hex64(hash) && record.files.len() < MAX_LINKS
                    {
                        record.files.push(json!({
                            "sha256": hash,
                            "name": rest.first().map(String::as_str).unwrap_or(""),
                            "url": rest.get(1).and_then(|u| valid_link(u)).unwrap_or_default(),
                        }));
                    }
                }
            }
            // Evidence is something handed in.
            if record.links.is_empty() && record.files.is_empty() && record.note.is_empty() {
                return None;
            }
            record.owner = proven_owner(event);
        }
        "send-back" | "confirm" => {
            record.evidence_id = Some(first_tag(event, "task-evidence").filter(|v| is_hex64(v))?);
            if part == "send-back" && record.note.is_empty() {
                return None;
            }
        }
        "more-time" | "cancel" => {
            if record.note.is_empty() {
                return None;
            }
        }
        "grant" => {
            record.ask_id = Some(first_tag(event, "task-ask").filter(|v| is_hex64(v))?);
            record.due.as_ref()?;
        }
        _ => {
            record.owner = proven_owner(event);
        }
    }
    Some(record)
}

/// Every task of one project as JSON, from its task records, by the same rules as the web app's `projectTasks`:
/// a step counts only when the right party signed it, nothing is ordered by the time a record carries, a
/// confirmation counts only from a team member who is not the helper (nor an agent, nor whoever runs the helper),
/// and a helper is on a task only once they signed a step for that very task (a yes, work handed in, an ask for
/// more time). An offer to help is never agreement. A task nobody has agreed to is listed only for the project's
/// team and for the person it names; the record itself is public all the same.
fn project_tasks(
    records: &[TaskRecord],
    coordinate: &str,
    team: &HashSet<String>,
    today: &str,
    me: &str,
) -> Vec<Value> {
    let mut seen = HashSet::new();
    let records: Vec<&TaskRecord> = records
        .iter()
        .filter(|r| r.coordinate == coordinate && seen.insert(r.id.clone()))
        .collect();
    let mut steps: HashMap<&str, Vec<&TaskRecord>> = HashMap::new();
    for record in &records {
        if record.part != "task" {
            steps
                .entry(record.task_id.as_str())
                .or_default()
                .push(record);
        }
    }
    let mut out = Vec::new();
    for task in &records {
        // Only the project's team can make one of its tasks.
        if task.part != "task" || !team.contains(&task.author) {
            continue;
        }
        let helper = task.helper.as_str();
        let mine: &[&TaskRecord] = steps.get(task.id.as_str()).map_or(&[], Vec::as_slice);
        let from_helper = |part: &str| {
            let mut found: Vec<&TaskRecord> = mine
                .iter()
                .copied()
                .filter(|s| s.author == helper && s.part == part)
                .collect();
            // By id: the dates are the helper's own to write, and decide nothing.
            found.sort_by(|a, b| a.id.cmp(&b.id));
            found
        };
        // The team's word on the helper's work comes from someone else on the team.
        let from_team = |part: &str| -> Vec<&TaskRecord> {
            mine.iter()
                .copied()
                .filter(|s| s.part == part && team.contains(&s.author) && s.author != helper)
                .collect()
        };
        let owners: HashSet<&str> = mine
            .iter()
            .filter(|s| s.author == helper)
            .filter_map(|s| s.owner.as_deref())
            .collect();
        let helper_is_agent = mine.iter().any(|s| s.author == helper && s.agent);

        let evidence = from_helper("evidence");
        let ids: HashSet<&str> = evidence.iter().map(|e| e.id.as_str()).collect();
        let mut confirmed: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
        let mut confirmed_without_evidence = false;
        for step in from_team("confirm") {
            // Nobody grades their own work: not whoever runs the helper, and not an agent.
            if owners.contains(step.author.as_str()) || step.agent {
                continue;
            }
            match step.evidence_id.as_deref() {
                Some(id) if ids.contains(id) => {
                    confirmed.entry(id).or_default().push(step.author.as_str())
                }
                _ => confirmed_without_evidence = true,
            }
        }
        let mut sent_back: BTreeMap<&str, Vec<&TaskRecord>> = BTreeMap::new();
        // The team sent back work that is no longer on the server: it still counts as sent back.
        let mut orphan_send_backs: Vec<&TaskRecord> = Vec::new();
        for step in from_team("send-back") {
            match step.evidence_id.as_deref().filter(|id| ids.contains(id)) {
                Some(id) => sent_back.entry(id).or_default().push(step),
                None => orphan_send_backs.push(step),
            }
        }
        for list in confirmed.values_mut() {
            list.sort_unstable();
        }
        let accepted = evidence.iter().find(|e| {
            confirmed.contains_key(e.id.as_str()) && !sent_back.contains_key(e.id.as_str())
        });
        // Every piece nobody on the team has answered waits for a check.
        let waiting: Vec<&str> = evidence
            .iter()
            .filter(|e| {
                !confirmed.contains_key(e.id.as_str()) && !sent_back.contains_key(e.id.as_str())
            })
            .map(|e| e.id.as_str())
            .collect();

        let asks = from_helper("more-time");
        let mut due = task.due.clone();
        let mut granted: HashMap<&str, &str> = HashMap::new();
        let mut grant_without_ask = false;
        for step in from_team("grant") {
            let (Some(ask), Some(date)) = (step.ask_id.as_deref(), step.due.as_deref()) else {
                continue;
            };
            if !asks.iter().any(|a| a.id == ask) {
                grant_without_ask = true;
                continue;
            }
            if granted.get(ask).is_none_or(|have| date > *have) {
                granted.insert(ask, date);
            }
            if due.as_deref().is_none_or(|have| date > have) {
                due = Some(date.to_string());
            }
        }

        let gave_up = from_helper("give-up").first().copied();
        let cancelled = from_team("cancel").first().copied();
        // Agreement is a record the helper signed for THIS task. An offer to help is never one: any project could
        // name any offer a person ever made.
        let agreed = if task.author == helper {
            Some("self")
        } else if !from_helper("accept").is_empty() {
            Some("accept")
        } else if !evidence.is_empty() {
            Some("work")
        } else if !asks.is_empty() {
            Some("step")
        } else {
            None
        };
        // Until the helper agrees, a task is the team's proposal to one person: listed for the team and for them.
        if agreed.is_none() && helper != me && !team.contains(me) {
            continue;
        }
        let state = if accepted.is_some() {
            "confirmed"
        } else if gave_up.is_some() {
            "given-up"
        } else if cancelled.is_some() {
            "cancelled"
        } else if agreed.is_none() {
            "offered"
        } else if !waiting.is_empty() {
            "submitted"
        } else if !evidence.is_empty() || !orphan_send_backs.is_empty() {
            "sent-back"
        } else {
            "in-progress"
        };
        let late = matches!(state, "in-progress" | "sent-back")
            && due.as_deref().is_some_and(|date| today > date);
        let is_mine = helper == me;
        // What this account can do next on the task, with this tool.
        let next = match (is_mine, state) {
            (true, "offered") => "accept",
            (true, "in-progress" | "sent-back") => "submit",
            (true, "submitted") => "wait-for-check",
            _ => "none",
        };
        out.push(json!({
            "task_id": task.id,
            "state": state,
            "late": late,
            "helper": helper,
            "helper_is_agent": helper_is_agent,
            "made_by": task.author,
            "what": task.what,
            "done_means": task.done,
            "size": task.size,
            "due": due,
            "update_id": task.update_id,
            "offer_id": task.offer_id,
            "agreed": agreed,
            "mine": is_mine,
            "next": next,
            "confirmed_without_evidence": accepted.is_none() && confirmed_without_evidence,
            "waiting": waiting,
            "sent_back_work_removed": orphan_send_backs.iter().map(|s| json!({
                "by": s.author,
                "reason": s.note,
            })).collect::<Vec<_>>(),
            // The team recorded steps that only follow a helper's step, and no step the helper signed is there.
            "step_removed": agreed.is_none()
                && (!orphan_send_backs.is_empty() || confirmed_without_evidence || grant_without_ask),
            "evidence": evidence.iter().map(|e| json!({
                "id": e.id,
                "created_at": e.at,
                "note": e.note,
                "links": e.links,
                "files": e.files,
                "confirmed_by": confirmed.get(e.id.as_str()).cloned().unwrap_or_default(),
                "sent_back": sent_back.get(e.id.as_str()).map(|list| list.iter().map(|s| json!({
                    "by": s.author,
                    "reason": s.note,
                })).collect::<Vec<_>>()).unwrap_or_default(),
            })).collect::<Vec<_>>(),
            "more_time": asks.iter().map(|a| json!({
                "id": a.id,
                "reason": a.note,
                "wanted": a.due,
                "granted_until": granted.get(a.id.as_str()),
            })).collect::<Vec<_>>(),
            "gave_up": gave_up.map(|s| json!({ "note": s.note })),
            "cancelled": cancelled.map(|s| json!({ "by": s.author, "reason": s.note })),
        }));
    }
    // Late first, then soonest due, then by id: never by a signer's own date.
    out.sort_by(|a, b| {
        let key = |v: &Value| {
            (
                !v["late"].as_bool().unwrap_or(false),
                v["due"]
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| "9999".into()),
                v["task_id"]
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_default(),
            )
        };
        key(a).cmp(&key(b))
    });
    out
}

/// The project's open help requests as JSON: team updates that ask for help and that no team member has marked
/// "Help found". `signals` are the records that answer those updates.
fn open_help_requests(
    updates: &[Event],
    signals: &[Event],
    team: &HashSet<String>,
    me: &str,
) -> Vec<Value> {
    let mut out = Vec::new();
    for update in updates {
        let author = update.pubkey.to_hex();
        if !team.contains(&author) || is_help_signal(update) || is_task_record(update) {
            continue;
        }
        let Some(text) = first_tag(update, "help-needed").filter(|t| !t.trim().is_empty()) else {
            continue;
        };
        let id = update.id.to_hex();
        let answers = |name: &str| -> Vec<String> {
            signals
                .iter()
                .filter(|s| first_tag(s, name).as_deref() == Some(id.as_str()))
                .map(|s| s.pubkey.to_hex())
                .collect()
        };
        // Only the team closes its own request.
        if answers("help-found").iter().any(|who| team.contains(who)) {
            continue;
        }
        // The team asked, so its own records are not offers; one offer per person.
        let offered: HashSet<String> = answers("help-offer")
            .into_iter()
            .filter(|who| !team.contains(who))
            .collect();
        out.push(json!({
            "update_id": id,
            "author": author,
            "created_at": update.created_at.as_secs(),
            "text": text,
            "size": first_tag(update, "help-size"),
            "time": first_tag(update, "help-time"),
            "offers": offered.len(),
            "offered_by_me": offered.contains(me),
        }));
    }
    out.sort_by(|a, b| a["update_id"].as_str().cmp(&b["update_id"].as_str()));
    out
}

fn tag(parts: &[&str]) -> Result<Tag, CliError> {
    Tag::parse(parts.iter().copied()).map_err(|e| CliError::Other(format!("bad tag: {e}")))
}

/// The tags and body of an offer to help, as the web app's `offerEvent` writes them.
fn offer_parts(
    update_id: &str,
    update_author: &str,
    note: &str,
) -> Result<(Vec<Tag>, Value), CliError> {
    let note: String = note.trim().chars().take(280).collect();
    Ok((
        vec![
            tag(&["e", update_id])?,
            tag(&["p", update_author])?,
            tag(&["help-offer", update_id])?,
        ],
        json!({ "title": "Offer to help", "body": note }),
    ))
}

/// The tags and body of a helper's step on a task (`accept`, `evidence` or `more-time`), as the web app's
/// `taskStepEvent` writes them. `tell` are the team members the step is for.
fn step_parts(
    part: &str,
    task_id: &str,
    tell: &[String],
    note: &str,
    links: &[String],
    due: Option<&str>,
) -> Result<(Vec<Tag>, Value), CliError> {
    let title = match part {
        "accept" => "Task accepted",
        "evidence" => "Work handed in",
        "more-time" => "More time asked",
        other => {
            return Err(CliError::Other(format!(
                "this tool does not send a {other:?} step"
            )))
        }
    };
    let note: String = note.trim().chars().take(MAX_NOTE).collect();
    let mut tags = vec![
        tag(&["l", TASK_LABEL])?,
        tag(&["task-part", part])?,
        tag(&["e", task_id])?,
        tag(&["task", task_id])?,
    ];
    let mut told = HashSet::new();
    for who in tell.iter().filter(|who| is_hex64(who)).take(TEAM_TOLD) {
        if told.insert(who.as_str()) {
            tags.push(tag(&["p", who])?);
        }
    }
    if let Some(due) = due {
        tags.push(tag(&["task-due", due])?);
    }
    for link in links {
        tags.push(tag(&["task-link", link])?);
    }
    let mut body: Vec<&str> = Vec::new();
    if !note.is_empty() {
        body.push(note.as_str());
    }
    body.extend(links.iter().map(String::as_str));
    let mut content = json!({ "title": title, "body": body.join("\n") });
    if !note.is_empty() {
        content["note"] = json!(note);
    }
    Ok((tags, content))
}

fn parse_events(raw: Vec<Value>) -> Result<Vec<Event>, CliError> {
    raw.into_iter()
        .map(|event| {
            serde_json::from_value(event)
                .map_err(|e| CliError::Other(format!("failed to parse relay response: {e}")))
        })
        .collect()
}

struct Project {
    coordinate: String,
    name: String,
    /// The founder first, then the people on the project's record.
    team: Vec<String>,
}

impl Project {
    fn team_set(&self) -> HashSet<String> {
        self.team.iter().cloned().collect()
    }
}

/// A project's own record, signed by its founder: its name and who is on its team.
async fn read_project(client: &BuzzClient, id: &str, owner: &str) -> Result<Project, CliError> {
    super::launchpad::validate_launch_id(id)?;
    require_hex64(owner, "--author")?;
    let filter = json!({ "kinds": [KIND_LAUNCH_RECORD], "authors": [owner], "#d": [id] });
    let mut records = parse_events(client.query_pages_bounded(filter, 10).await?)?;
    // What comes back is checked again: only the founder's own record with this id.
    records.retain(|e| e.pubkey.to_hex() == owner && first_tag(e, "d").as_deref() == Some(id));
    records.sort_by_key(|e| e.created_at.as_secs());
    let record = records.pop().ok_or_else(|| {
        CliError::NotFound(format!("project {id:?} not found for author {owner}"))
    })?;
    let mut team = vec![owner.to_string()];
    for tag in record.tags.iter() {
        if let [n, who, _role, ..] = tag.as_slice() {
            if n.as_str() == "team" && is_hex64(who) && !team.contains(who) {
                team.push(who.clone());
            }
        }
    }
    Ok(Project {
        coordinate: format!("{KIND_LAUNCH_RECORD}:{owner}:{id}"),
        name: first_tag(&record, "name").unwrap_or_default(),
        team,
    })
}

async fn read_by_ids(client: &BuzzClient, ids: &[String]) -> Result<Vec<Event>, CliError> {
    let mut out = Vec::new();
    for chunk in ids.chunks(200) {
        let filter = json!({ "kinds": [KIND_LAUNCH_UPDATE], "ids": chunk });
        let found = parse_events(
            client
                .query_pages_bounded(filter, chunk.len() as u32)
                .await?,
        )?;
        out.extend(found.into_iter().filter(|e| chunk.contains(&e.id.to_hex())));
    }
    Ok(out)
}

/// How many helpers' steps are read for one project.
const HELPERS_READ: usize = 200;

/// The project's task records, and whether they were read to the end.
///
/// Read by who signed them, never only by what they name: first the team's own task records, then the steps of the
/// helpers those tasks name. Anyone can sign a record that carries the project's tag and the task label, so a read
/// by tag alone could be filled with a stranger's junk until it never reached its end.
async fn read_task_records(
    client: &BuzzClient,
    project: &Project,
) -> Result<(Vec<TaskRecord>, bool), CliError> {
    let mut complete = project.team.len() <= TEAM_TOLD;
    let team: Vec<&String> = project.team.iter().take(TEAM_TOLD).collect();
    let read = |authors: Vec<&String>| {
        json!({
            "kinds": [KIND_LAUNCH_UPDATE],
            "authors": authors,
            "#a": [project.coordinate],
            "#l": [TASK_LABEL],
        })
    };
    let events = parse_events(
        client
            .query_pages_bounded(read(team.clone()), TASK_READ_BOUND + 1)
            .await?,
    )?;
    complete &= events.len() <= TASK_READ_BOUND as usize;
    // What comes back is checked again: only what a team member signed.
    let mut records: Vec<TaskRecord> = events
        .iter()
        .filter(|e| team.iter().any(|m| **m == e.pubkey.to_hex()))
        .filter_map(parse_task_record)
        .collect();
    let mut helpers: Vec<String> = records
        .iter()
        .filter(|r| r.part == "task" && !project.team.contains(&r.helper))
        .map(|r| r.helper.clone())
        .collect();
    helpers.sort();
    helpers.dedup();
    complete &= helpers.len() <= HELPERS_READ;
    helpers.truncate(HELPERS_READ);
    for chunk in helpers.chunks(50) {
        let events = parse_events(
            client
                .query_pages_bounded(read(chunk.iter().collect()), TASK_READ_BOUND + 1)
                .await?,
        )?;
        complete &= events.len() <= TASK_READ_BOUND as usize;
        records.extend(
            events
                .iter()
                .filter(|e| chunk.contains(&e.pubkey.to_hex()))
                .filter_map(parse_task_record),
        );
    }
    Ok((records, complete))
}

fn today() -> String {
    chrono::Utc::now().format("%Y-%m-%d").to_string()
}

async fn cmd_list(client: &BuzzClient, id: &str, author: Option<&str>) -> Result<(), CliError> {
    let me = client.keys().public_key().to_hex();
    let owner = author.map_or_else(|| me.clone(), str::to_string);
    let project = read_project(client, id, &owner).await?;
    let team = project.team_set();
    let (records, tasks_complete) = read_task_records(client, &project).await?;

    // Help requests are the team's own updates: read by author, so nobody else's records can crowd them out.
    let authors: Vec<&String> = project.team.iter().take(TEAM_TOLD).collect();
    let filter = json!({
        "kinds": [KIND_LAUNCH_UPDATE],
        "authors": authors,
        "#a": [project.coordinate],
    });
    let updates = parse_events(
        client
            .query_pages_bounded(filter, HELP_READ_BOUND + 1)
            .await?,
    )?;
    let mut help_complete = updates.len() <= HELP_READ_BOUND as usize;
    let asking: Vec<String> = updates
        .iter()
        .filter(|u| first_tag(u, "help-needed").is_some())
        .map(|u| u.id.to_hex())
        .collect();
    let mut signals = Vec::new();
    for chunk in asking.chunks(100) {
        let filter = json!({ "kinds": [KIND_LAUNCH_UPDATE], "#e": chunk });
        let found = parse_events(
            client
                .query_pages_bounded(filter, HELP_READ_BOUND + 1)
                .await?,
        )?;
        help_complete &= found.len() <= HELP_READ_BOUND as usize;
        signals.extend(found);
    }
    println!(
        "{}",
        json!({
            "project": {
                "id": id,
                "author": owner,
                "name": project.name,
                "coordinate": project.coordinate,
                "team": project.team,
            },
            "help_requests": open_help_requests(&updates, &signals, &team, &me),
            "tasks": project_tasks(&records, &project.coordinate, &team, &today(), &me),
            // False: more records than were read, so a request, a task or a step may be missing.
            "complete": { "help_requests": help_complete, "tasks": tasks_complete },
            "rewards": "Rewards are decided separately, by the project's own rules.",
            "note": "A task is its helper's only once they say yes. One nobody has said yes to is listed only for the project's team and the person it names; the record itself is public. A project's team can change: steps count by who is on the team now.",
        })
    );
    Ok(())
}

async fn publish(
    client: &BuzzClient,
    coordinate: &str,
    tags: Vec<Tag>,
    content: Value,
) -> Result<(), CliError> {
    let mut all = vec![tag(&["a", coordinate])?];
    all.extend(tags);
    let builder =
        EventBuilder::new(Kind::Custom(KIND_LAUNCH_UPDATE as u16), content.to_string()).tags(all);
    let event = client.sign_event(builder)?;
    let raw = client.submit_event(event).await?;
    println!(
        "{}",
        parse_write_response(&raw, "the server already has this record")?
    );
    Ok(())
}

async fn cmd_offer(
    client: &BuzzClient,
    id: &str,
    author: &str,
    update: &str,
    note: Option<&str>,
) -> Result<(), CliError> {
    require_hex64(update, "--update")?;
    let me = client.keys().public_key().to_hex();
    let project = read_project(client, id, author).await?;
    let team = project.team_set();
    if team.contains(&me) {
        return Err(CliError::Usage(
            "this account is on the project's team: the team asked, so its own offers do not count"
                .into(),
        ));
    }
    let found = read_by_ids(client, &[update.to_string()]).await?;
    let asked = found
        .first()
        .ok_or_else(|| CliError::NotFound(format!("update {update} not found")))?;
    let update_author = asked.pubkey.to_hex();
    if first_tag(asked, "a").as_deref() != Some(project.coordinate.as_str())
        || !team.contains(&update_author)
        || first_tag(asked, "help-needed").is_none()
    {
        return Err(CliError::Usage(
            "that update is not a request for help from this project's team".into(),
        ));
    }
    let filter = json!({ "kinds": [KIND_LAUNCH_UPDATE], "#e": [update] });
    let signals = parse_events(
        client
            .query_pages_bounded(filter, HELP_READ_BOUND + 1)
            .await?,
    )?;
    if signals.len() > HELP_READ_BOUND as usize {
        return Err(CliError::Other(
            "this request has more answers than could be read, so whether it is still open is not known".into(),
        ));
    }
    let answered = |name: &str, who: &dyn Fn(&str) -> bool| {
        signals.iter().any(|s| {
            first_tag(s, name).as_deref() == Some(update) && who(s.pubkey.to_hex().as_str())
        })
    };
    if answered("help-found", &|who| team.contains(who)) {
        return Err(CliError::Usage(
            "the team marked this request as Help found; it takes no new offers".into(),
        ));
    }
    if answered("help-offer", &|who| who == me) {
        return Err(CliError::Conflict(
            "this account already offered to help on that update".into(),
        ));
    }
    let (tags, content) = offer_parts(update, &update_author, note.unwrap_or(""))?;
    publish(client, &project.coordinate, tags, content).await
}

/// The task a helper's step is about, checked: it is this project's, made by its team, and this account's.
async fn my_task(
    client: &BuzzClient,
    project: &Project,
    task: &str,
    me: &str,
) -> Result<(Value, Vec<TaskRecord>), CliError> {
    require_hex64(task, "--task")?;
    let (records, complete) = read_task_records(client, project).await?;
    if !complete {
        return Err(CliError::Other(
            "this project has more task records than could be read, so the task's state is not known".into(),
        ));
    }
    let view = project_tasks(
        &records,
        &project.coordinate,
        &project.team_set(),
        &today(),
        me,
    )
    .into_iter()
    .find(|t| t["task_id"].as_str() == Some(task))
    .ok_or_else(|| {
        CliError::NotFound(format!(
            "task {task} is not a task of this project made by its team"
        ))
    })?;
    if view["helper"].as_str() != Some(me) {
        return Err(CliError::Usage(
            "that task is not this account's: only the helper it names can act on it".into(),
        ));
    }
    Ok((view, records))
}

/// The team members a helper's step is for: whoever made the task first, then the founder and the rest.
fn tell(project: &Project, view: &Value) -> Vec<String> {
    let mut out: Vec<String> = view["made_by"]
        .as_str()
        .map(str::to_string)
        .into_iter()
        .collect();
    out.extend(project.team.iter().cloned());
    out
}

async fn cmd_accept(
    client: &BuzzClient,
    id: &str,
    author: &str,
    task: &str,
) -> Result<(), CliError> {
    let me = client.keys().public_key().to_hex();
    let project = read_project(client, id, author).await?;
    let (view, _) = my_task(client, &project, task, &me).await?;
    match view["state"].as_str() {
        Some("offered") => {}
        Some("given-up" | "cancelled" | "confirmed") => {
            return Err(CliError::Usage("that task is closed".into()))
        }
        _ => {
            return Err(CliError::Conflict(
                "this account already agreed to that task".into(),
            ))
        }
    }
    let (tags, content) = step_parts("accept", task, &tell(&project, &view), "", &[], None)?;
    publish(client, &project.coordinate, tags, content).await
}

async fn cmd_submit(
    client: &BuzzClient,
    id: &str,
    author: &str,
    task: &str,
    note: Option<&str>,
    links: &[String],
) -> Result<(), CliError> {
    let note = note.unwrap_or("").trim();
    let mut clean: Vec<String> = Vec::new();
    for link in links {
        let link = valid_link(link).ok_or_else(|| {
            CliError::Usage(format!(
                "not a web link (it must start with https://): {link}"
            ))
        })?;
        if !clean.contains(&link) {
            clean.push(link);
        }
    }
    if clean.len() > MAX_LINKS {
        return Err(CliError::Usage(format!("at most {MAX_LINKS} links")));
    }
    if note.is_empty() && clean.is_empty() {
        return Err(CliError::Usage(
            "hand in something: --note, --link, or both".into(),
        ));
    }
    let me = client.keys().public_key().to_hex();
    let project = read_project(client, id, author).await?;
    let (view, records) = my_task(client, &project, task, &me).await?;
    match view["state"].as_str() {
        Some("in-progress" | "sent-back" | "submitted") => {}
        Some("offered") => {
            return Err(CliError::Usage(
                "say yes to the task first: buzz launchpad tasks accept".into(),
            ))
        }
        _ => return Err(CliError::Usage("that task is closed".into())),
    }
    // The same work handed in twice is one piece of work: a retry after a lost answer sends nothing new. The note
    // is compared as it is stored (cut to its limit), or a long note would never match itself.
    let kept_note: String = note.chars().take(MAX_NOTE).collect();
    let same = records.iter().any(|r| {
        r.part == "evidence"
            && r.task_id == task
            && r.author == me
            && r.note == kept_note
            && r.links == clean
    });
    if same {
        return Err(CliError::Conflict(
            "this account already handed in exactly this on that task".into(),
        ));
    }
    let (tags, content) = step_parts("evidence", task, &tell(&project, &view), note, &clean, None)?;
    publish(client, &project.coordinate, tags, content).await
}

async fn cmd_more_time(
    client: &BuzzClient,
    id: &str,
    author: &str,
    task: &str,
    reason: &str,
    until: Option<&str>,
) -> Result<(), CliError> {
    if reason.trim().is_empty() {
        return Err(CliError::Usage("--reason must say why".into()));
    }
    let until = match until {
        Some(date) => {
            let date = valid_date(date)
                .ok_or_else(|| CliError::Usage("--until must be a date, YYYY-MM-DD".into()))?;
            if date < today() {
                return Err(CliError::Usage("--until has already passed".into()));
            }
            Some(date)
        }
        None => None,
    };
    let me = client.keys().public_key().to_hex();
    let project = read_project(client, id, author).await?;
    let (view, _) = my_task(client, &project, task, &me).await?;
    if !matches!(view["state"].as_str(), Some("in-progress" | "sent-back")) {
        return Err(CliError::Usage(
            "more time can be asked for only while the task is in progress or sent back".into(),
        ));
    }
    let waiting = view["more_time"]
        .as_array()
        .is_some_and(|asks| asks.iter().any(|ask| ask["granted_until"].is_null()));
    if waiting {
        return Err(CliError::Conflict(
            "this account already asked for more time and the team has not answered yet".into(),
        ));
    }
    let (tags, content) = step_parts(
        "more-time",
        task,
        &tell(&project, &view),
        reason,
        &[],
        until.as_deref(),
    )?;
    publish(client, &project.coordinate, tags, content).await
}

/// Run one `buzz launchpad tasks` command.
pub async fn dispatch(cmd: TasksCmd, client: &BuzzClient) -> Result<(), CliError> {
    match cmd {
        TasksCmd::List { id, author } => cmd_list(client, &id, author.as_deref()).await,
        TasksCmd::Offer {
            id,
            author,
            update,
            note,
        } => cmd_offer(client, &id, &author, &update, note.as_deref()).await,
        TasksCmd::Accept { id, author, task } => cmd_accept(client, &id, &author, &task).await,
        TasksCmd::Submit {
            id,
            author,
            task,
            note,
            links,
        } => cmd_submit(client, &id, &author, &task, note.as_deref(), &links).await,
        TasksCmd::MoreTime {
            id,
            author,
            task,
            reason,
            until,
        } => cmd_more_time(client, &id, &author, &task, &reason, until.as_deref()).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;
    use nostr::{Keys, Timestamp};

    const COORD: &str = "37001:founder:orbit";
    const TODAY: &str = "2026-11-10";

    struct World {
        founder: Keys,
        mate: Keys,
        helper: Keys,
        stranger: Keys,
        at: u64,
    }

    impl World {
        fn new() -> Self {
            World {
                founder: Keys::generate(),
                mate: Keys::generate(),
                helper: Keys::generate(),
                stranger: Keys::generate(),
                at: 1_794_000_000,
            }
        }

        fn team(&self) -> HashSet<String> {
            [&self.founder, &self.mate]
                .iter()
                .map(|k| k.public_key().to_hex())
                .collect()
        }

        fn sign(&mut self, who: &Keys, tags: Vec<Vec<String>>, content: Value) -> Event {
            self.at += 1;
            self.sign_at(who, tags, content, self.at)
        }

        fn sign_at(&self, who: &Keys, tags: Vec<Vec<String>>, content: Value, at: u64) -> Event {
            let mut all = vec![Tag::parse(["a", COORD]).expect("tag")];
            all.extend(tags.into_iter().map(|t| Tag::parse(t).expect("tag")));
            EventBuilder::new(Kind::Custom(KIND_LAUNCH_UPDATE as u16), content.to_string())
                .tags(all)
                .custom_created_at(Timestamp::from(at))
                .sign_with_keys(who)
                .expect("signed")
        }

        /// A task as the web app writes it, for the helper, by `who`.
        fn task(&mut self, who: &Keys, extra: &[(&str, &str)]) -> Event {
            let helper = self.helper.public_key().to_hex();
            let mut tags = vec![
                vec!["l".into(), TASK_LABEL.into()],
                vec!["task-part".into(), "task".into()],
                vec!["p".into(), helper.clone()],
                vec!["task-helper".into(), helper],
                vec!["task-what".into(), "Test sign-up.".into()],
                vec!["task-done".into(), "A recording of it working.".into()],
                vec!["task-size".into(), "small".into()],
            ];
            tags.extend(
                extra
                    .iter()
                    .map(|(n, v)| vec![n.to_string(), v.to_string()]),
            );
            self.sign(who, tags, json!({ "title": "Task", "body": "x" }))
        }

        /// Any later step, written by hand as the web app writes it.
        fn step(
            &mut self,
            who: &Keys,
            task: &Event,
            part: &str,
            extra: &[(&str, &str)],
            note: &str,
        ) -> Event {
            let id = task.id.to_hex();
            let mut tags = vec![
                vec!["l".into(), TASK_LABEL.into()],
                vec!["task-part".into(), part.into()],
                vec!["e".into(), id.clone()],
                vec!["task".into(), id],
            ];
            tags.extend(
                extra
                    .iter()
                    .map(|(n, v)| vec![n.to_string(), v.to_string()]),
            );
            let mut content = json!({ "title": part, "body": note });
            if !note.is_empty() {
                content["note"] = json!(note);
            }
            self.sign(who, tags, content)
        }

        fn hand_in(&mut self, task: &Event, note: &str) -> Event {
            let helper = self.helper.clone();
            self.step(
                &helper,
                task,
                "evidence",
                &[("task-link", "https://example.org/a")],
                note,
            )
        }

        fn view(&self, events: &[&Event]) -> Vec<Value> {
            self.view_as(events, &self.helper.public_key().to_hex())
        }

        /// The listing as the account `me` gets it.
        fn view_as(&self, events: &[&Event], me: &str) -> Vec<Value> {
            let records: Vec<TaskRecord> =
                events.iter().filter_map(|e| parse_task_record(e)).collect();
            project_tasks(&records, COORD, &self.team(), TODAY, me)
        }

        fn state(&self, events: &[&Event]) -> String {
            let tasks = self.view(events);
            assert_eq!(tasks.len(), 1, "one task expected");
            tasks[0]["state"].as_str().expect("state").to_string()
        }
    }

    fn pairs(tags: &[Tag]) -> Vec<Vec<String>> {
        tags.iter().map(|t| t.as_slice().to_vec()).collect()
    }

    #[test]
    fn there_is_no_command_to_confirm_send_back_cancel_vote_or_award() {
        let id = "a".repeat(64);
        for step in [
            "confirm",
            "send-back",
            "cancel",
            "grant",
            "award",
            "vote",
            "give",
        ] {
            let parsed = crate::Cli::try_parse_from([
                "buzz",
                "launchpad",
                "tasks",
                step,
                "orbit",
                "--author",
                id.as_str(),
                "--task",
                id.as_str(),
            ]);
            assert!(parsed.is_err(), "`tasks {step}` must not exist");
            // Nor can the step builder be made to write one.
            assert!(step_parts(step, &id, &[], "x", &[], None).is_err());
        }
        // The helper's own steps do parse.
        assert!(crate::Cli::try_parse_from([
            "buzz",
            "launchpad",
            "tasks",
            "accept",
            "orbit",
            "--author",
            id.as_str(),
            "--task",
            id.as_str(),
        ])
        .is_ok());
        assert!(crate::Cli::try_parse_from([
            "buzz",
            "launchpad",
            "tasks",
            "submit",
            "orbit",
            "--author",
            id.as_str(),
            "--task",
            id.as_str(),
            "--link",
            "https://example.org/a",
            "--link",
            "https://example.org/b",
        ])
        .is_ok());
    }

    #[test]
    fn a_helpers_steps_carry_the_tags_the_web_app_reads() {
        let task = "1".repeat(64);
        let maker = "2".repeat(64);
        let founder = "3".repeat(64);
        let (tags, content) = step_parts(
            "evidence",
            &task,
            &[
                maker.clone(),
                founder.clone(),
                maker.clone(),
                "not-a-key".into(),
            ],
            "  Tested on a Moto G6.  ",
            &["https://example.org/a".to_string()],
            None,
        )
        .expect("parts");
        assert_eq!(
            pairs(&tags),
            vec![
                vec!["l".to_string(), "creaton-task".to_string()],
                vec!["task-part".to_string(), "evidence".to_string()],
                vec!["e".to_string(), task.clone()],
                vec!["task".to_string(), task.clone()],
                vec!["p".to_string(), maker.clone()],
                vec!["p".to_string(), founder],
                vec!["task-link".to_string(), "https://example.org/a".to_string()],
            ]
        );
        assert_eq!(content["note"], "Tested on a Moto G6.");
        assert_eq!(content["title"], "Work handed in");

        let (tags, content) = step_parts(
            "more-time",
            &task,
            &[maker],
            "Phone broke.",
            &[],
            Some("2026-12-01"),
        )
        .expect("parts");
        assert!(pairs(&tags).contains(&vec!["task-due".to_string(), "2026-12-01".to_string()]));
        assert_eq!(content["note"], "Phone broke.");

        let (tags, content) = offer_parts(&task, &"4".repeat(64), "I can test.").expect("parts");
        assert_eq!(
            pairs(&tags),
            vec![
                vec!["e".to_string(), task.clone()],
                vec!["p".to_string(), "4".repeat(64)],
                vec!["help-offer".to_string(), task],
            ]
        );
        assert_eq!(content["body"], "I can test.");
        // Nothing a helper sends names an amount.
        assert!(!content.to_string().to_lowercase().contains("share"));
    }

    #[test]
    fn the_full_loop_is_read_from_who_signed_what() {
        let mut w = World::new();
        let (founder, mate, helper) = (w.founder.clone(), w.mate.clone(), w.helper.clone());
        let task = w.task(&founder, &[("task-due", "2026-12-01")]);
        assert_eq!(w.state(&[&task]), "offered");
        let yes = w.step(&helper, &task, "accept", &[], "");
        assert_eq!(w.state(&[&task, &yes]), "in-progress");
        let first = w.hand_in(&task, "First try.");
        assert_eq!(w.state(&[&task, &yes, &first]), "submitted");
        let first_id = first.id.to_hex();
        let back = w.step(
            &mate,
            &task,
            "send-back",
            &[("task-evidence", first_id.as_str())],
            "No recording.",
        );
        assert_eq!(w.state(&[&task, &yes, &first, &back]), "sent-back");
        let second = w.hand_in(&task, "With the recording.");
        assert_eq!(w.state(&[&task, &yes, &first, &back, &second]), "submitted");
        let second_id = second.id.to_hex();
        let ok = w.step(
            &founder,
            &task,
            "confirm",
            &[("task-evidence", second_id.as_str())],
            "",
        );
        let all = [&task, &yes, &first, &back, &second, &ok];
        assert_eq!(w.state(&all), "confirmed");
        // The order records arrive in changes nothing.
        let mut reversed = all;
        reversed.reverse();
        assert_eq!(w.state(&reversed), "confirmed");
        let view = w.view(&all);
        assert_eq!(view[0]["done_means"], "A recording of it working.");
        assert_eq!(view[0]["due"], "2026-12-01");
        assert_eq!(view[0]["mine"], true);
        assert_eq!(view[0]["next"], "none");
        // Pieces are listed by id, never by the dates their signer wrote: each is found by its id.
        let piece = |id: &str| {
            view[0]["evidence"]
                .as_array()
                .and_then(|list| list.iter().find(|p| p["id"] == id))
                .cloned()
                .expect("piece")
        };
        assert_eq!(piece(&first_id)["sent_back"][0]["reason"], "No recording.");
        assert_eq!(
            piece(&second_id)["confirmed_by"][0],
            founder.public_key().to_hex()
        );
    }

    #[test]
    fn dates_a_signer_writes_decide_nothing() {
        let w = World::new();
        let helper = w.helper.public_key().to_hex();
        let task = w.sign_at(
            &w.founder,
            vec![
                vec!["l".into(), TASK_LABEL.into()],
                vec!["task-part".into(), "task".into()],
                vec!["task-helper".into(), helper],
                vec!["task-what".into(), "x".into()],
                vec!["task-done".into(), "y".into()],
                vec!["task-size".into(), "small".into()],
            ],
            json!({}),
            500,
        );
        let id = task.id.to_hex();
        let step = |who: &Keys, part: &str, extra: Vec<Vec<String>>, note: &str, at: u64| {
            let mut tags = vec![
                vec!["l".into(), TASK_LABEL.into()],
                vec!["task-part".into(), part.into()],
                vec!["task".into(), id.clone()],
            ];
            tags.extend(extra);
            w.sign_at(who, tags, json!({ "note": note }), at)
        };
        // The first piece claims a date far in the future; its send-back and the second piece claim the distant past.
        let first = step(&w.helper, "evidence", vec![], "one", 9_999_999_999);
        let back = step(
            &w.mate,
            "send-back",
            vec![vec!["task-evidence".into(), first.id.to_hex()]],
            "no",
            1,
        );
        assert_eq!(w.state(&[&task, &first, &back]), "sent-back");
        let second = step(&w.helper, "evidence", vec![], "two", 2);
        assert_eq!(w.state(&[&task, &first, &back, &second]), "submitted");
    }

    #[test]
    fn the_one_who_did_the_work_never_confirms_it() {
        let mut w = World::new();
        let (founder, mate, helper, stranger) = (
            w.founder.clone(),
            w.mate.clone(),
            w.helper.clone(),
            w.stranger.clone(),
        );
        let task = w.task(&founder, &[]);
        let work = w.hand_in(&task, "Done.");
        let work_id = work.id.to_hex();
        let ev = [("task-evidence", work_id.as_str())];
        let own = w.step(&helper, &task, "confirm", &ev, "");
        assert_eq!(w.state(&[&task, &work, &own]), "submitted");
        let outside = w.step(&stranger, &task, "confirm", &ev, "");
        assert_eq!(w.state(&[&task, &work, &outside]), "submitted");
        // A confirmation that says an agent signed it is not a person's yes.
        let mate_hex = mate.public_key().to_hex();
        let by_agent = w.step(
            &mate,
            &task,
            "confirm",
            &[ev[0], ("agent", mate_hex.as_str())],
            "",
        );
        assert_eq!(w.state(&[&task, &work, &by_agent]), "submitted");
        // Work that is not there accepts nothing.
        let ghost_id = "e".repeat(64);
        let ghost = w.step(
            &mate,
            &task,
            "confirm",
            &[("task-evidence", ghost_id.as_str())],
            "",
        );
        let view = w.view(&[&task, &work, &ghost]);
        assert_eq!(view[0]["state"], "submitted");
        assert_eq!(view[0]["confirmed_without_evidence"], true);
        let ok = w.step(&mate, &task, "confirm", &ev, "");
        assert_eq!(
            w.state(&[&task, &work, &own, &outside, &by_agent, &ok]),
            "confirmed"
        );
    }

    #[test]
    fn whoever_runs_the_helper_may_not_confirm_either() {
        let mut w = World::new();
        let (founder, mate, helper) = (w.founder.clone(), w.mate.clone(), w.helper.clone());
        let task = w.task(&founder, &[]);
        // The helper is an agent the second team member runs: its handed-in work proves it.
        let auth =
            buzz_sdk::nip_oa::compute_auth_tag(&mate, &helper.public_key(), "").expect("auth");
        let auth: Vec<String> = serde_json::from_str(&auth).expect("tag");
        let id = task.id.to_hex();
        let work = w.sign(
            &helper,
            vec![
                vec!["l".into(), TASK_LABEL.into()],
                vec!["task-part".into(), "evidence".into()],
                vec!["task".into(), id],
                auth,
            ],
            json!({ "note": "Done." }),
        );
        let work_id = work.id.to_hex();
        let ev = [("task-evidence", work_id.as_str())];
        let by_owner = w.step(&mate, &task, "confirm", &ev, "");
        let view = w.view(&[&task, &work, &by_owner]);
        assert_eq!(view[0]["state"], "submitted");
        assert_eq!(view[0]["helper_is_agent"], true);
        let by_founder = w.step(&founder, &task, "confirm", &ev, "");
        assert_eq!(
            w.state(&[&task, &work, &by_owner, &by_founder]),
            "confirmed"
        );
    }

    #[test]
    fn forged_and_conflicting_records_change_nothing() {
        let mut w = World::new();
        let (founder, mate, helper, stranger) = (
            w.founder.clone(),
            w.mate.clone(),
            w.helper.clone(),
            w.stranger.clone(),
        );
        // A "task" by someone who is not on the team is not a task of the project.
        let fake = w.task(&stranger, &[]);
        assert!(w.view(&[&fake]).is_empty());
        let task = w.task(&founder, &[("task-due", "2026-11-01")]);
        let yes = w.step(&helper, &task, "accept", &[], "");
        // Only the helper's own yes counts.
        let not_yes = w.step(&stranger, &task, "accept", &[], "");
        assert_eq!(w.state(&[&task, &not_yes]), "offered");
        // Past its date and the helper's move: late. The helper cannot give themselves time.
        let ask = w.step(
            &helper,
            &task,
            "more-time",
            &[("task-due", "2026-12-01")],
            "Phone broke.",
        );
        let ask_id = ask.id.to_hex();
        let self_grant = w.step(
            &helper,
            &task,
            "grant",
            &[("task-ask", ask_id.as_str()), ("task-due", "2026-12-01")],
            "",
        );
        let view = w.view(&[&task, &yes, &ask, &self_grant]);
        assert_eq!(view[0]["late"], true);
        assert_eq!(view[0]["due"], "2026-11-01");
        assert!(view[0]["more_time"][0]["granted_until"].is_null());
        let grant = w.step(
            &mate,
            &task,
            "grant",
            &[("task-ask", ask_id.as_str()), ("task-due", "2026-11-20")],
            "",
        );
        let view = w.view(&[&task, &yes, &ask, &grant]);
        assert_eq!(view[0]["late"], false);
        assert_eq!(view[0]["due"], "2026-11-20");
        assert_eq!(view[0]["next"], "submit");
        // One team member confirms what another sent back: the answers disagree, and the work is not accepted.
        let work = w.hand_in(&task, "Done.");
        let work_id = work.id.to_hex();
        let ev = [("task-evidence", work_id.as_str())];
        let ok = w.step(&founder, &task, "confirm", &ev, "");
        let back = w.step(&mate, &task, "send-back", &ev, "Not what was asked.");
        assert_eq!(w.state(&[&task, &yes, &work, &ok, &back]), "sent-back");
        // A stranger cannot cancel; the team can, but a confirmation outlasts it.
        let bad_cancel = w.step(&stranger, &task, "cancel", &[], "x");
        assert_eq!(w.state(&[&task, &yes, &work, &bad_cancel]), "submitted");
        let cancel = w.step(&founder, &task, "cancel", &[], "Changed plans.");
        assert_eq!(w.state(&[&task, &yes, &work, &cancel]), "cancelled");
        assert_eq!(w.state(&[&task, &yes, &work, &cancel, &ok]), "confirmed");
        // Duplicates of one record count once.
        let view = w.view(&[&task, &task, &work, &work, &ok, &ok]);
        assert_eq!(view.len(), 1);
        assert_eq!(view[0]["evidence"].as_array().map(Vec::len), Some(1));
    }

    #[test]
    fn an_offer_is_never_agreement_to_a_task() {
        let mut w = World::new();
        let (founder, mate, helper) = (w.founder.clone(), w.mate.clone(), w.helper.clone());
        // Any project can name any offer a person ever made, and date the task in the past.
        let offer = "7".repeat(64);
        let task = w.task(
            &founder,
            &[("task-offer", offer.as_str()), ("task-due", "2020-01-01")],
        );
        let view = w.view(&[&task]);
        assert_eq!(view[0]["state"], "offered");
        assert!(view[0]["agreed"].is_null());
        assert_eq!(view[0]["late"], false);
        assert_eq!(view[0]["next"], "accept");
        // The team's steps cannot put the helper on it either; they are called out.
        let ghost = "e".repeat(64);
        let back = w.step(
            &mate,
            &task,
            "send-back",
            &[("task-evidence", ghost.as_str())],
            "Late and bad.",
        );
        let view = w.view(&[&task, &back]);
        assert_eq!(view[0]["state"], "offered");
        assert_eq!(view[0]["step_removed"], true);
        // Until the helper says yes, only the team and the helper are listed the task.
        let stranger = w.stranger.public_key().to_hex();
        assert!(w.view_as(&[&task], &stranger).is_empty());
        assert_eq!(w.view_as(&[&task], &mate.public_key().to_hex()).len(), 1);
        let yes = w.step(&helper, &task, "accept", &[], "");
        assert_eq!(w.view_as(&[&task, &yes], &stranger).len(), 1);
        // With the helper's own yes there, a send-back of work that is gone still stands.
        let view = w.view(&[&task, &yes, &back]);
        assert_eq!(view[0]["state"], "sent-back");
        assert_eq!(
            view[0]["sent_back_work_removed"][0]["reason"],
            "Late and bad."
        );
        assert_eq!(view[0]["step_removed"], false);
        // An ask for more time is the helper's own signature on the task too.
        let ask = w.step(&helper, &task, "more-time", &[], "Ill.");
        assert_eq!(w.view(&[&task, &ask])[0]["agreed"], "step");
    }

    #[test]
    fn every_unanswered_piece_waits_and_an_agent_tag_must_name_its_signer() {
        let mut w = World::new();
        let (founder, mate) = (w.founder.clone(), w.mate.clone());
        let task = w.task(&founder, &[]);
        let a = w.hand_in(&task, "a");
        let b = w.hand_in(&task, "b");
        let view = w.view(&[&task, &a, &b]);
        let mut both = vec![a.id.to_hex(), b.id.to_hex()];
        both.sort();
        assert_eq!(view[0]["waiting"], json!(both));
        // An `agent` tag naming someone else says nothing about this record: the confirmation is a person's.
        let a_id = a.id.to_hex();
        let other = founder.public_key().to_hex();
        let ok = w.step(
            &mate,
            &task,
            "confirm",
            &[("task-evidence", a_id.as_str()), ("agent", other.as_str())],
            "",
        );
        assert_eq!(w.state(&[&task, &a, &b, &ok]), "confirmed");
    }

    #[test]
    fn records_that_are_not_tasks_are_refused() {
        let mut w = World::new();
        let founder = w.founder.clone();
        let good = w.task(&founder, &[]);
        assert!(parse_task_record(&good).is_some());
        assert!(is_task_record(&good));
        for missing in ["task-done", "task-helper", "task-size", "task-what"] {
            let helper = w.helper.public_key().to_hex();
            let tags: Vec<Vec<String>> = [
                ("l", TASK_LABEL),
                ("task-part", "task"),
                ("task-helper", helper.as_str()),
                ("task-what", "x"),
                ("task-done", "y"),
                ("task-size", "small"),
            ]
            .iter()
            .filter(|(n, _)| *n != missing)
            .map(|(n, v)| vec![n.to_string(), v.to_string()])
            .collect();
            let event = w.sign(&founder, tags, json!({}));
            assert!(parse_task_record(&event).is_none(), "{missing} is required");
        }
        // Two steps in one record is neither; a send-back needs a reason; evidence needs something handed in.
        let two = w.task(&founder, &[("task-part", "confirm")]);
        assert!(parse_task_record(&two).is_none());
        let id = "3".repeat(64);
        let no_reason = w.step(
            &founder,
            &good,
            "send-back",
            &[("task-evidence", id.as_str())],
            "",
        );
        assert!(parse_task_record(&no_reason).is_none());
        let empty = w.step(&founder, &good, "evidence", &[], "");
        assert!(parse_task_record(&empty).is_none());
        // A script link is never a link.
        let script = w.step(
            &founder,
            &good,
            "evidence",
            &[("task-link", "javascript:alert(1)")],
            "x",
        );
        assert!(parse_task_record(&script).expect("record").links.is_empty());
        assert_eq!(
            valid_link(" https://example.org/x "),
            Some("https://example.org/x".into())
        );
        assert_eq!(valid_link("ftp://example.org"), None);
        assert_eq!(valid_link("https://"), None);
        assert_eq!(valid_date("2026-12-01"), Some("2026-12-01".into()));
        assert_eq!(valid_date("2026-02-30"), None);
        assert_eq!(valid_date("tomorrow"), None);
    }

    #[test]
    fn open_help_requests_are_the_teams_own_and_only_the_team_closes_them() {
        let mut w = World::new();
        let (founder, mate, helper, stranger) = (
            w.founder.clone(),
            w.mate.clone(),
            w.helper.clone(),
            w.stranger.clone(),
        );
        let ask = |w: &mut World, who: &Keys, text: &str| {
            w.sign(
                who,
                vec![
                    vec!["help-needed".into(), text.into()],
                    vec!["help-size".into(), "small".into()],
                ],
                json!({ "title": "Week", "body": text }),
            )
        };
        let open = ask(&mut w, &founder, "Test sign-up.");
        let closed = ask(&mut w, &founder, "Draw a logo.");
        let not_ours = ask(&mut w, &stranger, "Send me money.");
        let signal = |w: &mut World, who: &Keys, name: &str, update: &Event| {
            let id = update.id.to_hex();
            w.sign(
                who,
                vec![vec!["e".into(), id.clone()], vec![name.into(), id]],
                json!({}),
            )
        };
        let signals = vec![
            signal(&mut w, &helper, "help-offer", &open),
            signal(&mut w, &helper, "help-offer", &open),
            signal(&mut w, &mate, "help-offer", &open),
            signal(&mut w, &stranger, "help-found", &open),
            signal(&mut w, &mate, "help-found", &closed),
        ];
        let updates = vec![open.clone(), closed, not_ours];
        let me = helper.public_key().to_hex();
        let got = open_help_requests(&updates, &signals, &w.team(), &me);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0]["update_id"], open.id.to_hex());
        assert_eq!(got[0]["text"], "Test sign-up.");
        // One offer per person, and the team's own do not count.
        assert_eq!(got[0]["offers"], 1);
        assert_eq!(got[0]["offered_by_me"], true);
        for s in &signals {
            assert!(is_help_signal(s));
            assert!(!is_task_record(s));
        }
        assert!(!is_help_signal(&open));
    }
}
