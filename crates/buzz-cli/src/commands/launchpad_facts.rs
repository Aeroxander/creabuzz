//! `buzz launchpad updates facts <project>`: the grounded facts a weekly update is drafted from.
//!
//! An operator's own agent (or the operator) reads this, writes the "what happened" and "help needed" words from it
//! and nothing else, and posts with `buzz launchpad updates post … --no-promises`. Everything printed is read from
//! signed records; nothing is estimated and nothing is invented. The facts are:
//!
//! * the goals as they stand;
//! * the last weekly update (what it said was done and next) and when it was signed;
//! * last update's promises with how each stands (kept, missed, changed, waiting) and every promise still waiting
//!   for an answer;
//! * the work accepted since the last update: tasks a team member other than the helper confirmed, with what was
//!   handed in (links, fingerprints, and any results, which are reported by the helper);
//! * the tasks still going, by state, and the help requests still open.
//!
//! The command only reads. It never posts, and the update it helps with makes no promises: a promise is the
//! founder's, and a person must sign it.

use std::collections::BTreeMap;

use nostr::Event;
use serde_json::{json, Value};

use super::launchpad_record::{promise_record, promise_totals};
use super::launchpad_tasks::{
    first_tag, goals_as_they_stand, is_help_signal, is_task_record, open_help_requests,
    project_path, project_tasks, read_founder_updates, read_help_inputs, read_project,
    read_task_records, today, RESULTS_NOTE, SCHEMA,
};
use crate::client::BuzzClient;
use crate::error::CliError;

/// The most accepted pieces of work listed, newest first. More than this and `accepted_cut` says so.
const ACCEPTED_LISTED: usize = 20;

/// The last weekly update among the founder's records: the newest that says it is one. `None` when there is none.
pub(crate) fn last_weekly_update(updates: &[Event], founder: &str) -> Option<Value> {
    updates
        .iter()
        .filter(|e| {
            e.pubkey.to_hex() == founder
                && !is_task_record(e)
                && !is_help_signal(e)
                && first_tag(e, "goal").is_none()
                && e.tags.iter().any(|t| match t.as_slice() {
                    [n, ..] if matches!(n.as_str(), "update-part" | "promise" | "promise-mark") => {
                        true
                    }
                    [n, kind, ..] => n.as_str() == "update-kind" && kind.as_str() == "weekly",
                    _ => false,
                })
        })
        .max_by_key(|e| (e.created_at.as_secs(), e.id.to_hex()))
        .map(|e| {
            let part = |name: &str| {
                e.tags.iter().find_map(|t| match t.as_slice() {
                    [n, which, text, ..]
                        if n.as_str() == "update-part" && which.as_str() == name =>
                    {
                        Some(text.clone())
                    }
                    _ => None,
                })
            };
            let title = serde_json::from_str::<Value>(&e.content)
                .ok()
                .and_then(|b| b["title"].as_str().map(str::to_string));
            json!({
                "id": e.id.to_hex(),
                "signed_at": e.created_at.as_secs(),
                "title": title,
                "done": part("done"),
                "next": part("next"),
            })
        })
}

/// The facts, from what was read. Pure: `now` is the clock, and every record comes in as a parameter.
pub(crate) fn facts_from(
    project: &Value,
    founder_updates: &[Event],
    founder: &str,
    tasks: &[Value],
    help_requests: Vec<Value>,
    now: u64,
) -> Value {
    let goals = goals_as_they_stand(founder_updates, founder);
    let entries = promise_record(founder_updates, founder);
    let last = last_weekly_update(founder_updates, founder);
    let since = last.as_ref().and_then(|l| l["signed_at"].as_u64());
    let last_id = last.as_ref().and_then(|l| l["id"].as_str()).unwrap_or("");
    let promise_json = |e: &super::launchpad_record::PromiseEntry| e.to_json();
    let last_promises: Vec<Value> = entries
        .iter()
        .filter(|e| !last_id.is_empty() && e.id().starts_with(&format!("{last_id}:")))
        .map(promise_json)
        .collect();
    let waiting: Vec<Value> = entries
        .iter()
        .filter(|e| matches!(e.state(), "waiting" | "unanswered"))
        .map(promise_json)
        .collect();

    // Accepted work since the last update, newest first. The time is the checker's own record of it: it decides
    // only which update the work is told in, nothing else.
    let mut accepted: Vec<&Value> = tasks
        .iter()
        .filter(|t| t["state"].as_str() == Some("confirmed"))
        .filter(|t| match (since, t["accepted_at"].as_u64()) {
            (Some(since), Some(at)) => at > since,
            _ => true,
        })
        .collect();
    accepted.sort_by(|a, b| {
        let key = |v: &Value| {
            (
                std::cmp::Reverse(v["accepted_at"].as_u64().unwrap_or(0)),
                v["task_id"].as_str().unwrap_or_default().to_string(),
            )
        };
        key(a).cmp(&key(b))
    });
    let accepted_total = accepted.len();
    accepted.truncate(ACCEPTED_LISTED);
    let accepted_json: Vec<Value> = accepted
        .iter()
        .map(|t| {
            let checked: Vec<&Value> = t["evidence"]
                .as_array()
                .map(|pieces| {
                    pieces
                        .iter()
                        .filter(|p| p["confirmed_by"].as_array().is_some_and(|c| !c.is_empty()))
                        .collect()
                })
                .unwrap_or_default();
            json!({
                "task_id": t["task_id"],
                "what": t["what"],
                "done_means": t["done_means"],
                "helper": t["helper"],
                "helper_is_agent": t["helper_is_agent"],
                "accepted_at": t["accepted_at"],
                "checked_by": t["checked_by"],
                "accepted_work": checked,
            })
        })
        .collect();

    let mut by_state: BTreeMap<&str, usize> = BTreeMap::new();
    for task in tasks {
        if let Some(state) = task["state"].as_str() {
            *by_state.entry(state).or_default() += 1;
        }
    }
    let late: Vec<Value> = tasks
        .iter()
        .filter(|t| t["late"] == json!(true))
        .map(|t| json!({ "task_id": t["task_id"], "what": t["what"], "due": t["due"] }))
        .collect();

    let project_id = project["id"].as_str().unwrap_or("<project>");
    json!({
        "schema": SCHEMA,
        "project": project,
        "as_of": now,
        "goals": goals.values().collect::<Vec<_>>(),
        "last_update": last,
        "last_update_promises": last_promises,
        "promises_waiting_for_an_answer": waiting,
        "promise_totals": promise_totals(&entries),
        "work_accepted_since_last_update": accepted_json,
        "accepted_total": accepted_total,
        "accepted_cut": accepted_total > ACCEPTED_LISTED,
        "results_note": RESULTS_NOTE,
        "tasks_by_state": by_state,
        "tasks_late": late,
        "help_requests_open": help_requests,
        "draft_rules": [
            "Write only from the facts above. Do not add numbers, names or outcomes that are not in them.",
            "What is next is plans, not promises: post with --no-promises. A promise must be signed by a person.",
            "Answering last update's promises (--mark) is the founder's, and a person's.",
            "Results in accepted work are reported by the helper, not run by anyone else; say so if you quote them.",
        ],
        "post_command": format!(
            "buzz launchpad updates post {project_id} --title \"<title>\" --done \"<what happened, from the facts>\" --next \"<plans>\" --help-needed \"<help, if any>\" --no-promises"
        ),
    })
}

/// `buzz launchpad updates facts <id> [--author <founder>]`
pub async fn cmd_facts(
    client: &BuzzClient,
    id: &str,
    author: Option<&str>,
) -> Result<(), CliError> {
    let me = client.keys().public_key().to_hex();
    let owner = author.map_or_else(|| me.clone(), str::to_string);
    let project = read_project(client, id, &owner).await?;
    let (founder_updates, updates_complete) = read_founder_updates(client, &project).await?;
    let (records, tasks_complete) = read_task_records(client, &project).await?;
    let team = project.team_set();
    let tasks = project_tasks(&records, &project.coordinate, &team, &today(), &me);
    let (team_updates, signals, help_complete) = read_help_inputs(client, &project).await?;
    let requests = open_help_requests(&team_updates, &signals, &team, &me);
    let mut summary = json!({
        "id": id,
        "author": project.founder(),
        "name": project.name,
        "coordinate": project.coordinate,
        "path": project_path(project.founder(), id),
    });
    summary["topics"] = json!(project.topics);
    let mut facts = facts_from(
        &summary,
        &founder_updates,
        project.founder(),
        &tasks,
        requests,
        chrono::Utc::now().timestamp().max(0) as u64,
    );
    // False: more records than were read, so a fact may be missing; say so before drafting from them.
    facts["complete"] = json!({
        "updates": updates_complete,
        "tasks": tasks_complete,
        "help_requests": help_complete,
    });
    println!("{facts}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::kind::KIND_LAUNCH_UPDATE;
    use nostr::{EventBuilder, Keys, Kind, Tag, Timestamp};

    const COORD: &str = "37001:founder:orbit";

    fn update(who: &Keys, at: u64, tags: &[&[&str]], title: &str) -> Event {
        let mut all = vec![Tag::parse(["a", COORD]).expect("tag")];
        all.extend(tags.iter().map(|t| Tag::parse(t.to_vec()).expect("tag")));
        EventBuilder::new(
            Kind::Custom(KIND_LAUNCH_UPDATE as u16),
            json!({ "title": title }).to_string(),
        )
        .tags(all)
        .custom_created_at(Timestamp::from(at))
        .sign_with_keys(who)
        .expect("signed")
    }

    fn task(id: &str, state: &str, accepted_at: Option<u64>) -> Value {
        json!({
            "task_id": id, "state": state, "what": format!("Task {id}"), "done_means": "A list",
            "helper": "h", "helper_is_agent": true, "accepted_at": accepted_at, "checked_by": ["f"],
            "late": state == "in-progress", "due": "2026-11-01",
            "evidence": [{ "id": "e1", "confirmed_by": ["f"], "results": [], "links": ["https://example.org/a"] }],
        })
    }

    #[test]
    fn facts_are_read_from_records_and_say_what_is_not_theirs_to_write() {
        let founder = Keys::generate();
        let me = founder.public_key().to_hex();
        let first = update(
            &founder,
            1_000,
            &[
                &["update-part", "done", "Drew the chart"],
                &["update-part", "next", "Publish it"],
                &["promise", "0", "Publish it"],
            ],
            "Week 1",
        );
        let goal = update(
            &founder,
            900,
            &[
                &["goal", "g1"],
                &["goal-level", "primary"],
                &["goal-text", "Publish the northern sky"],
                &["goal-how", "Ten people read it"],
                &["goal-state", "open"],
            ],
            "Goal",
        );
        let tasks = vec![
            task("t-old", "confirmed", Some(950)),
            task("t-new", "confirmed", Some(1_500)),
            task("t-going", "in-progress", None),
        ];
        let facts = facts_from(
            &json!({ "id": "orbit" }),
            &[first.clone(), goal],
            &me,
            &tasks,
            vec![],
            2_000,
        );
        // Only work accepted after the last update is told in the next one.
        let told: Vec<&str> = facts["work_accepted_since_last_update"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["task_id"].as_str().unwrap())
            .collect();
        assert_eq!(told, ["t-new"]);
        assert_eq!(facts["last_update"]["id"], first.id.to_hex());
        assert_eq!(facts["last_update"]["done"], "Drew the chart");
        assert_eq!(facts["goals"][0]["text"], "Publish the northern sky");
        // Last update's promise, still waiting for its answer.
        assert_eq!(facts["last_update_promises"][0]["text"], "Publish it");
        assert_eq!(facts["last_update_promises"][0]["state"], "waiting");
        assert_eq!(facts["tasks_by_state"]["in-progress"], 1);
        assert_eq!(facts["tasks_late"].as_array().unwrap().len(), 1);
        // The draft is told to make no promises and to say what is only the helper's report.
        let rules = facts["draft_rules"].to_string();
        assert!(rules.contains("--no-promises") && rules.contains("reported by the helper"));
        assert!(facts["post_command"]
            .as_str()
            .unwrap()
            .ends_with("--no-promises"));
    }

    #[test]
    fn with_no_update_yet_everything_accepted_is_news_and_nothing_is_invented() {
        let founder = Keys::generate();
        let me = founder.public_key().to_hex();
        let facts = facts_from(
            &json!({ "id": "orbit" }),
            &[],
            &me,
            &[task("t1", "confirmed", Some(5))],
            vec![],
            10,
        );
        assert!(facts["last_update"].is_null());
        assert_eq!(
            facts["work_accepted_since_last_update"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(facts["goals"], json!([]));
        assert_eq!(facts["promise_totals"]["promised"], 0);
    }

    #[test]
    fn a_strangers_update_is_never_the_last_update() {
        let founder = Keys::generate();
        let stranger = Keys::generate();
        let mine = update(&founder, 1_000, &[&["update-part", "done", "Real"]], "Mine");
        let theirs = update(
            &stranger,
            2_000,
            &[&["update-part", "done", "Fake"]],
            "Theirs",
        );
        let last = last_weekly_update(&[mine, theirs], &founder.public_key().to_hex()).unwrap();
        assert_eq!(last["done"], "Real");
    }
}
