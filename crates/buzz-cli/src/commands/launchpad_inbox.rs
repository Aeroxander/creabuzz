//! `buzz launchpad tasks mine | next`, and the filters on `tasks open`: an agent's inbox.
//!
//! * `mine`: every task that names this account, across all projects, with what it can do next on each and when it
//!   is due. A task names its helper in a `p` tag, so one bounded read by that tag finds them; each project the
//!   tasks belong to is then read the way `tasks list` reads it, so the state is worked out from who signed what and
//!   not from the tag.
//! * `next`: one open help request that fits, with the command that offers on it.
//! * [`OpenFilters`]: `--size`, `--project`, `--category`, `--text`, `--max-time`, applied to what `open` found.
//!
//! Everything here only reads. An agent may offer, say yes to a task that names it, and hand work in; none of these
//! commands checks work, grants time, votes or awards anything, and the server would refuse an agent that tried.
//! Every scan is bounded and says when it was cut (`cut`, `next_until`), the same way `open` does.

use std::collections::BTreeMap;

use buzz_core::kind::KIND_LAUNCH_UPDATE;
use clap::Args;
use serde_json::{json, Value};

use super::launchpad_tasks::{
    attach_helper_labels, open_page, parse_events, project_path, project_tasks, read_open,
    read_project, read_task_records, split_coordinate, task_project_for, today, SCHEMA, TASK_LABEL,
};
use crate::client::BuzzClient;
use crate::error::CliError;

/// How many task records `mine` looks through in one call unless told otherwise, and the most it ever will.
const MINE_SCAN_DEFAULT: u32 = 500;
const MINE_SCAN_MAX: u32 = 2_000;

/// Narrow the help requests `open` and `next` look at. A request must pass every filter given.
#[derive(Args, Debug, Clone, Default)]
pub struct OpenFilters {
    /// Only requests of this size: small, medium or large
    #[arg(long)]
    pub size: Option<String>,
    /// Only requests of this project (its id)
    #[arg(long)]
    pub project: Option<String>,
    /// Only projects with this topic (as the project page shows it, any case)
    #[arg(long)]
    pub category: Option<String>,
    /// Only requests that mention every one of these words (in the request, the project's name or its topics)
    #[arg(long)]
    pub text: Option<String>,
    /// Only requests that should take at most this long: `4h`, `2d`, `1w`, or `3 days`. A request whose time is not
    /// in hours, days or weeks is left out and counted in `time_unknown`.
    #[arg(long = "max-time")]
    pub max_time: Option<String>,
}

fn normal(word: &str) -> String {
    let mut out = String::new();
    for c in word.trim().to_lowercase().chars() {
        if c.is_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').to_string()
}

/// How many hours a free-text time like "about 3 days", "1-2 weeks" or "a day" stands for: the larger number named,
/// times the first unit named. `None` when there is no number or no unit it knows.
pub(crate) fn parse_hours(text: &str) -> Option<f64> {
    let lower = text.to_lowercase();
    let mut numbers: Vec<f64> = Vec::new();
    let mut unit: Option<f64> = None;
    let mut word = String::new();
    let flush = |word: &mut String, numbers: &mut Vec<f64>, unit: &mut Option<f64>| {
        if word.is_empty() {
            return;
        }
        let w = word.as_str();
        if let Ok(n) = w.parse::<f64>() {
            numbers.push(n);
        } else {
            // A number glued to its unit: "3d", "2h", "1.5w".
            let split = w
                .find(|c: char| !(c.is_ascii_digit() || c == '.'))
                .unwrap_or(w.len());
            let (digits, rest) = w.split_at(split);
            let named = match w {
                "a" | "an" | "one" => Some(1.0),
                "two" | "couple" => Some(2.0),
                "three" | "few" => Some(3.0),
                "four" => Some(4.0),
                "five" => Some(5.0),
                "six" => Some(6.0),
                "seven" => Some(7.0),
                "ten" => Some(10.0),
                _ => None,
            };
            if let Some(n) = named {
                numbers.push(n);
            } else {
                let unit_word = match digits.parse::<f64>() {
                    Ok(n) if !rest.is_empty() => {
                        numbers.push(n);
                        rest
                    }
                    _ => w,
                };
                let hours = match unit_word {
                    "m" | "min" | "mins" | "minute" | "minutes" => Some(1.0 / 60.0),
                    "h" | "hr" | "hrs" | "hour" | "hours" => Some(1.0),
                    "d" | "day" | "days" => Some(24.0),
                    "w" | "wk" | "wks" | "week" | "weeks" => Some(24.0 * 7.0),
                    "month" | "months" => Some(24.0 * 30.0),
                    _ => None,
                };
                if unit.is_none() {
                    *unit = hours;
                }
            }
        }
        word.clear();
    };
    for c in lower.chars() {
        if c.is_ascii_alphanumeric() || c == '.' {
            word.push(c);
        } else {
            flush(&mut word, &mut numbers, &mut unit);
        }
    }
    flush(&mut word, &mut numbers, &mut unit);
    let biggest = numbers.into_iter().fold(None::<f64>, |best, n| {
        Some(best.map_or(n, |b: f64| b.max(n)))
    })?;
    let hours = biggest * unit?;
    (hours.is_finite() && hours > 0.0).then_some(hours)
}

impl OpenFilters {
    /// Check the values given, once, before anything is read.
    pub(crate) fn check(&self) -> Result<Option<f64>, CliError> {
        if let Some(size) = &self.size {
            if !matches!(size.as_str(), "small" | "medium" | "large") {
                return Err(CliError::Usage(
                    "--size must be small, medium or large".into(),
                ));
            }
        }
        match &self.max_time {
            Some(text) => parse_hours(text).map(Some).ok_or_else(|| {
                CliError::Usage(
                    "--max-time must be a length of time like 4h, 2d, 1w or 3 days".into(),
                )
            }),
            None => Ok(None),
        }
    }

    fn echo(&self) -> Value {
        json!({
            "size": self.size,
            "project": self.project,
            "category": self.category,
            "text": self.text,
            "max_time": self.max_time,
        })
    }
}

/// What the filters left, and why the rest was left out.
pub(crate) struct Filtered {
    pub(crate) kept: Vec<Value>,
    /// How many requests the page held before the filters.
    pub(crate) considered: usize,
    /// How many were left out because their time is not in hours, days or weeks (only with `--max-time`).
    pub(crate) time_unknown: usize,
}

/// Apply the filters to the requests `open` found. `max_hours` is what [`OpenFilters::check`] returned.
pub(crate) fn apply(
    filters: &OpenFilters,
    max_hours: Option<f64>,
    requests: Vec<Value>,
) -> Filtered {
    let considered = requests.len();
    let terms: Vec<String> = filters
        .text
        .iter()
        .flat_map(|t| t.split_whitespace())
        .map(str::to_lowercase)
        .collect();
    let category = filters.category.as_deref().map(normal);
    let mut time_unknown = 0;
    let kept = requests
        .into_iter()
        .filter(|r| {
            if filters
                .size
                .as_deref()
                .is_some_and(|size| r["size"].as_str() != Some(size))
            {
                return false;
            }
            if filters
                .project
                .as_deref()
                .is_some_and(|id| r["project"]["id"].as_str() != Some(id))
            {
                return false;
            }
            if let Some(wanted) = &category {
                let topics = r["project"]["topics"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                if !topics
                    .iter()
                    .any(|t| t.as_str().is_some_and(|t| normal(t) == *wanted))
                {
                    return false;
                }
            }
            if !terms.is_empty() {
                let haystack = format!(
                    "{} {} {}",
                    r["text"].as_str().unwrap_or(""),
                    r["project"]["name"].as_str().unwrap_or(""),
                    r["project"]["topics"]
                        .as_array()
                        .map(|t| t
                            .iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join(" "))
                        .unwrap_or_default()
                )
                .to_lowercase();
                if !terms.iter().all(|t| haystack.contains(t.as_str())) {
                    return false;
                }
            }
            if let Some(max) = max_hours {
                match r["time_hours"].as_f64() {
                    Some(hours) if hours <= max => {}
                    Some(_) => return false,
                    None => {
                        time_unknown += 1;
                        return false;
                    }
                }
            }
            true
        })
        .collect();
    Filtered {
        kept,
        considered,
        time_unknown,
    }
}

/// The best fit among requests this account may offer on: the fewest offers so far, then the newest, then by id.
pub(crate) fn best_fit(requests: &[Value]) -> Option<&Value> {
    requests
        .iter()
        .filter(|r| r["may_offer"] == json!(true))
        .min_by(|a, b| {
            let key = |v: &Value| {
                (
                    v["offers"].as_u64().unwrap_or(0),
                    std::cmp::Reverse(v["created_at"].as_u64().unwrap_or(0)),
                    v["update_id"].as_str().unwrap_or_default().to_string(),
                )
            };
            key(a).cmp(&key(b))
        })
}

/// `buzz launchpad tasks next`
pub(crate) async fn cmd_next(
    client: &BuzzClient,
    until: Option<u64>,
    scan: Option<u32>,
    filters: &OpenFilters,
) -> Result<(), CliError> {
    let max_hours = filters.check()?;
    let page = read_open(client, until, scan).await?;
    let found = apply(filters, max_hours, page.requests);
    let best = best_fit(&found.kept).cloned();
    let offer = best
        .as_ref()
        .and_then(|r| r["offer_command"].as_str().map(str::to_string));
    println!(
        "{}",
        json!({
            "schema": SCHEMA,
            "next": best,
            "offer_command": offer,
            "considered": found.considered,
            "fits": found.kept.len(),
            "filters": filters.echo(),
            "scanned": page.scanned,
            // True: older records remain. Pass `next_until` as --until to read on.
            "cut": page.cut,
            "next_until": page.next_until,
            "skipped_in_one_second": page.same_second,
            "time_unknown": found.time_unknown,
            "complete": { "answers": page.answers_complete },
            "note": "An offer is not an agreement. The project's team makes a task for whoever it picks, and that person says yes to it.",
        })
    );
    Ok(())
}

/// What an account can run next on one of its tasks.
fn commands_for(project_id: &str, founder: &str, task: &Value) -> Value {
    let task_id = task["task_id"].as_str().unwrap_or_default();
    let base = format!("buzz launchpad tasks %s {project_id} --author {founder} --task {task_id}");
    let command = match task["next"].as_str() {
        Some("accept") => Some(base.replace("%s", "accept")),
        Some("submit") => Some(format!(
            "{} --note \"<what you did and where to look>\"",
            base.replace("%s", "submit")
        )),
        _ => None,
    };
    json!({
        "show": format!("buzz launchpad tasks show {task_id}"),
        "next": command,
    })
}

/// `buzz launchpad tasks mine`
pub(crate) async fn cmd_mine(
    client: &BuzzClient,
    until: Option<u64>,
    scan: Option<u32>,
    all: bool,
) -> Result<(), CliError> {
    let scan = scan.unwrap_or(MINE_SCAN_DEFAULT);
    if scan == 0 || scan > MINE_SCAN_MAX {
        return Err(CliError::Usage(format!(
            "--scan must be between 1 and {MINE_SCAN_MAX}"
        )));
    }
    let me = client.keys().public_key().to_hex();
    let mut filter = json!({
        "kinds": [KIND_LAUNCH_UPDATE],
        "#p": [me],
        "#l": [TASK_LABEL],
    });
    if let Some(until) = until {
        filter["until"] = json!(until);
    }
    let read = parse_events(client.query_pages_bounded(filter, scan + 1).await?)?;
    let (page, cut, next_until, same_second) = open_page(read, scan as usize);
    let scanned = page.len();

    // The projects whose tasks name this account, from the task records themselves.
    let mut projects: BTreeMap<String, ()> = BTreeMap::new();
    for event in &page {
        if let Some(coordinate) = task_project_for(event, &me) {
            projects.insert(coordinate, ());
        }
    }

    let mut tasks: Vec<Value> = Vec::new();
    let mut complete = true;
    let mut gone = 0usize;
    let mut hidden_closed = 0usize;
    let today = today();
    for coordinate in projects.keys() {
        let Some((founder, id)) = split_coordinate(coordinate) else {
            continue;
        };
        let project = match read_project(client, id, founder).await {
            Ok(project) => project,
            Err(CliError::NotFound(_)) | Err(CliError::Usage(_)) => {
                gone += 1;
                continue;
            }
            Err(other) => return Err(other),
        };
        let (records, records_complete) = read_task_records(client, &project).await?;
        complete &= records_complete;
        let team = project.team.iter().cloned().collect();
        for mut task in project_tasks(&records, &project.coordinate, &team, &today, &me) {
            if task["mine"] != json!(true) {
                continue;
            }
            let closed = matches!(
                task["state"].as_str(),
                Some("confirmed" | "given-up" | "cancelled")
            );
            if closed && !all {
                hidden_closed += 1;
                continue;
            }
            task["project"] = json!({
                "id": id,
                "author": founder,
                "name": project.name,
                "coordinate": project.coordinate,
                "path": project_path(founder, id),
            });
            task["commands"] = commands_for(id, founder, &task);
            tasks.push(task);
        }
    }
    // Whether this account is labelled as an agent is known before it has signed anything for a task: say so.
    let labels_complete = attach_helper_labels(client, &mut tasks).await?;
    // What needs this account first (say yes, hand in), then what waits for a check, then the rest; late first, then
    // soonest due, then by id: never by a signer's own date.
    let rank = |v: &Value| match v["next"].as_str() {
        Some("accept" | "submit") => 0,
        Some("wait-for-check") => 1,
        _ => 2,
    };
    tasks.sort_by(|a, b| {
        let key = |v: &Value| {
            (
                rank(v),
                !v["late"].as_bool().unwrap_or(false),
                v["due"].as_str().unwrap_or("9999").to_string(),
                v["task_id"].as_str().unwrap_or_default().to_string(),
            )
        };
        key(a).cmp(&key(b))
    });
    let count = |next: &str| {
        tasks
            .iter()
            .filter(|t| t["next"].as_str() == Some(next))
            .count()
    };
    println!(
        "{}",
        json!({
            "schema": SCHEMA,
            "tasks": tasks,
            "counts": {
                "accept": count("accept"),
                "submit": count("submit"),
                "wait_for_check": count("wait-for-check"),
                "hidden_closed": hidden_closed,
            },
            "scanned": scanned,
            // True: older records remain. Pass `next_until` as --until to read on.
            "cut": cut,
            "next_until": next_until,
            "skipped_in_one_second": same_second,
            // False: a project has more task records than were read, so a step or a task may be missing.
            "complete": { "tasks": complete, "helper_labels": labels_complete },
            "projects_no_longer_listed": gone,
            "note": "A task is yours only once you say yes. `next` says what you can do: accept, submit, wait-for-check, or none. Someone else on the team checks the work.",
        })
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(id: &str, size: &str, time: &str, text: &str, offers: u64, at: u64) -> Value {
        json!({
            "update_id": id,
            "created_at": at,
            "text": text,
            "size": size,
            "time": time,
            "time_hours": parse_hours(time),
            "offers": offers,
            "may_offer": true,
            "offered_by_me": false,
            "project": { "id": format!("p-{id}"), "name": "Orbit", "topics": ["ai-agents", "maps"] },
        })
    }

    #[test]
    fn free_text_times_become_hours() {
        assert_eq!(parse_hours("about a day"), Some(24.0));
        assert_eq!(parse_hours("about 3 days"), Some(72.0));
        assert_eq!(parse_hours("1-2 weeks"), Some(336.0));
        assert_eq!(parse_hours("4h"), Some(4.0));
        assert_eq!(parse_hours("2d"), Some(48.0));
        assert_eq!(parse_hours("a couple of days"), Some(48.0));
        assert_eq!(parse_hours("30 minutes"), Some(0.5));
        assert_eq!(parse_hours("when I can"), None);
        assert_eq!(parse_hours("3"), None);
        assert_eq!(parse_hours(""), None);
    }

    #[test]
    fn every_filter_given_must_pass_and_the_reasons_are_counted() {
        let all = vec![
            request("a", "small", "about a day", "Check the star names", 0, 10),
            request("b", "large", "about 2 weeks", "Write the star guide", 1, 20),
            request("c", "small", "someday", "Check the maps", 0, 30),
        ];
        let by = |filters: OpenFilters| {
            let max = filters.check().expect("valid");
            let found = apply(&filters, max, all.clone());
            (
                found
                    .kept
                    .iter()
                    .map(|r| r["update_id"].as_str().unwrap().to_string())
                    .collect::<Vec<_>>(),
                found.time_unknown,
            )
        };
        assert_eq!(by(OpenFilters::default()).0, ["a", "b", "c"]);
        let small = OpenFilters {
            size: Some("small".into()),
            ..Default::default()
        };
        assert_eq!(by(small).0, ["a", "c"]);
        let quick = OpenFilters {
            max_time: Some("3d".into()),
            ..Default::default()
        };
        // "someday" has no length: left out and counted, never guessed.
        assert_eq!(by(quick), (vec!["a".to_string()], 1));
        let text = OpenFilters {
            text: Some("CHECK star".into()),
            ..Default::default()
        };
        assert_eq!(by(text).0, ["a"]);
        let category = OpenFilters {
            category: Some("AI Agents".into()),
            project: Some("p-b".into()),
            ..Default::default()
        };
        assert_eq!(by(category).0, ["b"]);
        let nothing = OpenFilters {
            category: Some("gardening".into()),
            ..Default::default()
        };
        assert!(by(nothing).0.is_empty());
        // Bad values are refused before anything is read.
        assert!(OpenFilters {
            size: Some("huge".into()),
            ..Default::default()
        }
        .check()
        .is_err());
        assert!(OpenFilters {
            max_time: Some("soon".into()),
            ..Default::default()
        }
        .check()
        .is_err());
    }

    #[test]
    fn the_best_fit_has_the_fewest_offers_then_is_newest_and_must_be_offerable() {
        let mut requests = vec![
            request("a", "small", "a day", "x", 2, 30),
            request("b", "small", "a day", "x", 0, 10),
            request("c", "small", "a day", "x", 0, 20),
        ];
        assert_eq!(best_fit(&requests).unwrap()["update_id"], "c");
        requests[2]["may_offer"] = json!(false);
        assert_eq!(best_fit(&requests).unwrap()["update_id"], "b");
        requests[1]["may_offer"] = json!(false);
        requests[0]["may_offer"] = json!(false);
        assert!(best_fit(&requests).is_none());
    }

    #[test]
    fn a_task_comes_with_the_command_that_does_its_next_step() {
        let founder = "f".repeat(64);
        let task = json!({ "task_id": "t".repeat(64), "next": "submit" });
        let commands = commands_for("orbit", &founder, &task);
        assert!(commands["next"].as_str().unwrap().starts_with(&format!(
            "buzz launchpad tasks submit orbit --author {founder} --task "
        )));
        let waiting = json!({ "task_id": "t".repeat(64), "next": "wait-for-check" });
        assert!(commands_for("orbit", &founder, &waiting)["next"].is_null());
    }
}
