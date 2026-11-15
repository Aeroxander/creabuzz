//! What a helper reports with a hand-in: `tasks submit --result`, `--run-log` and `--run-record`.
//!
//! The tag names and bounds are fixed in `buzz_core::task_result`, which the relay holds every hand-in to as well; this
//! module reads the command line into those tags. A number given with `--result` is recorded as reported by the
//! helper. Nothing here runs a check or marks a number as verified: the only run in the picture is a run record
//! (kind 47010) from `buzz launchpad work-checks --task`, and `--run-record` merely names it.

use buzz_core::kind::KIND_WORK_CHECK_RUN;
use buzz_core::task_result::{
    parse_result_tag, TaskResult, MAX_RESULTS, TAG_RUN_LOG, TAG_RUN_RECORD,
};
use serde_json::json;

use crate::client::BuzzClient;
use crate::error::CliError;

/// The marks inside a `--result` value that start an optional part: `/baseline=`, `/n=`, `/unit=`, `/by=`.
const PARTS: [(&str, &str); 4] = [
    ("/baseline=", "baseline"),
    ("/n=", "n"),
    ("/unit=", "unit"),
    ("/by=", "by"),
];

/// Read one `--result` value: `name=value`, then any of `/baseline=<number>`, `/n=<sample size>`, `/unit=<words>`
/// and `/by=<what produced it>`, once each, in any order. `pass_rate=0.82/baseline=0.71/n=40` is the usual shape.
///
/// # Errors
///
/// A [`CliError::Usage`] in plain words when the value breaks the shape or a bound.
pub(crate) fn parse_result_arg(value: &str) -> Result<TaskResult, CliError> {
    let usage = |what: String| CliError::Usage(format!("--result {value:?}: {what}"));
    let mut marks: Vec<(usize, &str, &str)> = Vec::new();
    for (mark, key) in PARTS {
        let mut at = 0;
        while let Some(found) = value[at..].find(mark) {
            let position = at + found;
            if marks.iter().any(|(_, have, _)| *have == key) {
                return Err(usage(format!("{key} is given twice")));
            }
            marks.push((position, key, mark));
            at = position + mark.len();
        }
    }
    marks.sort_by_key(|(position, _, _)| *position);
    let head_end = marks
        .first()
        .map_or(value.len(), |(position, _, _)| *position);
    let (name, number) = value[..head_end]
        .split_once('=')
        .ok_or_else(|| usage("write it as name=value, like pass_rate=0.82".into()))?;
    let mut result = TaskResult {
        name: name.trim().to_string(),
        value: number.trim().to_string(),
        unit: String::new(),
        baseline: String::new(),
        sample_size: String::new(),
        produced_by: String::new(),
    };
    for (index, (position, key, mark)) in marks.iter().enumerate() {
        let from = position + mark.len();
        let to = marks
            .get(index + 1)
            .map_or(value.len(), |(next, _, _)| *next);
        let text = value[from..to].trim().to_string();
        match *key {
            "baseline" => result.baseline = text,
            "n" => result.sample_size = text,
            "unit" => result.unit = text,
            _ => result.produced_by = text,
        }
    }
    parse_result_tag(&result.to_tag()).map_err(usage)
}

/// The extra tags of a hand-in, checked against the bounds the relay holds them to.
pub(crate) struct Extras {
    pub(crate) tags: Vec<Vec<String>>,
}

impl Extras {
    /// Build them from what the command line gave: `results` as typed, the run log's fingerprint and name, and the
    /// run record's id.
    pub(crate) fn build(
        results: &[String],
        run_log: Option<&(String, String)>,
        run_record: Option<&str>,
    ) -> Result<Self, CliError> {
        if results.len() > MAX_RESULTS {
            return Err(CliError::Usage(format!(
                "at most {MAX_RESULTS} --result values"
            )));
        }
        let mut tags: Vec<Vec<String>> = Vec::new();
        for value in results {
            tags.push(parse_result_arg(value)?.to_tag());
        }
        if let Some((hash, name)) = run_log {
            tags.push(vec![TAG_RUN_LOG.into(), hash.clone(), name.clone()]);
        }
        if let Some(id) = run_record {
            tags.push(vec![TAG_RUN_RECORD.into(), id.to_string()]);
        }
        // The same check the relay makes: names unique, one log, one record.
        buzz_core::task_result::check_hand_in_tags(&tags).map_err(CliError::Usage)?;
        tags.sort();
        Ok(Self { tags })
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.tags.is_empty()
    }
}

/// Check that `id` names a run record this account signed for this task (`buzz launchpad work-checks --task`).
pub(crate) async fn check_run_record(
    client: &BuzzClient,
    id: &str,
    task: &str,
) -> Result<(), CliError> {
    let filter = json!({ "kinds": [KIND_WORK_CHECK_RUN], "ids": [id] });
    let found = client.query_pages_bounded(filter, 2).await?;
    let event = found
        .into_iter()
        .find(|e| e["id"].as_str() == Some(id))
        .ok_or_else(|| CliError::NotFound(format!("run record {id} not found")))?;
    let me = client.keys().public_key().to_hex();
    names_this_task(&event, &me, task)
}

/// Whether a run record (as the server sent it) was signed by `me` for `task`: its `claim` tag is the task's id.
fn names_this_task(event: &serde_json::Value, me: &str, task: &str) -> Result<(), CliError> {
    if event["pubkey"].as_str() != Some(me) {
        return Err(CliError::Usage(
            "that run record was signed by someone else: only a run you signed can go with your work".into(),
        ));
    }
    let claim = format!("0x{task}");
    let names_task = event["tags"].as_array().is_some_and(|tags| {
        tags.iter().any(|tag| {
            tag.get(0).and_then(|n| n.as_str()) == Some("claim")
                && tag.get(1).and_then(|v| v.as_str()).map(str::to_lowercase) == Some(claim.clone())
        })
    });
    if !names_task {
        return Err(CliError::Usage(
            "that run record is not for this task: run `buzz launchpad work-checks --task <task> --evidence <piece>`"
                .into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_result_is_read_from_the_command_line() {
        let r = parse_result_arg("pass_rate=0.82/baseline=0.71/n=40").expect("result");
        assert_eq!(
            (
                r.name.as_str(),
                r.value.as_str(),
                r.baseline.as_str(),
                r.sample_size.as_str()
            ),
            ("pass_rate", "0.82", "0.71", "40")
        );
        let r =
            parse_result_arg("latency=120/unit=ms/by=commit abc123 on the CI box").expect("result");
        assert_eq!(
            (r.unit.as_str(), r.produced_by.as_str()),
            ("ms", "commit abc123 on the CI box")
        );
        // Any order, and a slash inside the free words stays there.
        let r = parse_result_arg("score=3/by=run a/b/n=7/unit=points").expect("result");
        assert_eq!(r.produced_by, "run a/b");
        assert_eq!((r.sample_size.as_str(), r.unit.as_str()), ("7", "points"));
    }

    #[test]
    fn a_result_that_breaks_the_shape_or_a_bound_is_refused_in_words() {
        for bad in [
            "pass_rate",
            "pass_rate=high",
            "=0.5",
            "x=1/baseline=lots",
            "x=1/n=0",
            "x=1/n=4.5",
            "x=1/n=3/n=4",
            "x=1e5",
        ] {
            let error = parse_result_arg(bad).unwrap_err();
            assert!(matches!(error, CliError::Usage(_)), "{bad}");
        }
        let long = format!("{}=1", "n".repeat(61));
        assert!(parse_result_arg(&long).is_err());
    }

    #[test]
    fn extras_keep_to_the_relays_bounds_before_anything_is_signed() {
        let many: Vec<String> = (0..11).map(|i| format!("m{i}=1")).collect();
        assert!(Extras::build(&many, None, None).is_err());
        assert!(Extras::build(&many[..10], None, None).is_ok());
        assert!(Extras::build(&["a=1".into(), "A=2".into()], None, None).is_err());
        let log = ("a".repeat(64), "run.log".to_string());
        let built =
            Extras::build(&["a=1".into()], Some(&log), Some(&"b".repeat(64))).expect("extras");
        assert_eq!(built.tags.len(), 3);
        assert!(Extras::build(&[], None, Some("nope")).is_err());
        assert!(Extras::build(&[], None, None).expect("none").is_empty());
    }

    #[test]
    fn only_a_run_this_account_signed_for_this_task_goes_with_its_work() {
        let task = "c".repeat(64);
        let record = |who: &str, claim: &str| json!({ "pubkey": who, "tags": [["claim", claim], ["mandate", "0x0000000000000000000000000000000000000000"]] });
        let me = "1".repeat(64);
        assert!(names_this_task(&record(&me, &format!("0x{task}")), &me, &task).is_ok());
        assert!(
            names_this_task(&record(&"2".repeat(64), &format!("0x{task}")), &me, &task).is_err()
        );
        assert!(
            names_this_task(&record(&me, &format!("0x{}", "d".repeat(64))), &me, &task).is_err()
        );
        assert!(names_this_task(&json!({ "pubkey": me, "tags": [] }), &me, &task).is_err());
    }
}
