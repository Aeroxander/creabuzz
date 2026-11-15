//! The tags a helper's hand-in (a task's `evidence` step, kind 47003) may carry beside its words, links and files.
//!
//! They exist so a number a helper reports (a pass rate, a score, a time) is a field a checker can read and compare
//! with the task's finish line, and not a figure buried in a sentence. Everything here is **reported by the helper**:
//! nothing in a `task-result` tag was run or verified by anyone else, and readers must say so. The one thing that
//! is more than a report is a run record (kind 47010) that a sandbox run signed; `task-run-record` only names it.
//!
//! The three tags, in the order the CLI writes them (`buzz launchpad tasks submit`):
//!
//! | tag | fields after the name | rules |
//! |-----|-----------------------|-------|
//! | `task-result` | `name`, `value`, `unit`, `baseline`, `sample_size`, `produced_by` | up to [`MAX_RESULTS`] per hand-in; names unique; the six fields always present (empty when unused) |
//! | `task-run-log` | `sha256`, `name` | at most one; the fingerprint of a log file the helper kept; the file is never uploaded |
//! | `task-run-record` | `event id` | at most one; the id of a kind 47010 record this account signed for this task |
//!
//! `value` and `baseline` are plain decimal numbers (`0.82`, `-3`, `1200`; no exponent, no thousands marks, at most
//! [`MAX_NUMBER`] characters). `sample_size` is a whole number or empty. `unit` is a few words (`%`, `ms`,
//! `tests passed`). `produced_by` says what produced the number: a commit, a model name, a run log's hash.
//!
//! The relay refuses a hand-in whose tags break these bounds (`launch_update_authority::classify`), and refuses
//! these tags on any step that is not a hand-in. The CLI writes only what passes the same check, because both call
//! this module.

use std::collections::HashSet;

/// The tag name of one reported result.
pub const TAG_RESULT: &str = "task-result";
/// The tag name of the fingerprint of a run log file.
pub const TAG_RUN_LOG: &str = "task-run-log";
/// The tag name of a run record the helper signed for the task.
pub const TAG_RUN_RECORD: &str = "task-run-record";

/// The most `task-result` tags one hand-in carries.
pub const MAX_RESULTS: usize = 10;
/// The longest result name, in characters.
pub const MAX_NAME: usize = 60;
/// The longest `value` or `baseline`, in characters.
pub const MAX_NUMBER: usize = 32;
/// The longest unit, in characters.
pub const MAX_UNIT: usize = 24;
/// The longest sample size, in digits.
pub const MAX_SAMPLE_DIGITS: usize = 12;
/// The longest `produced_by`, in characters.
pub const MAX_PRODUCED_BY: usize = 200;
/// The longest run log file name, in characters.
pub const MAX_LOG_NAME: usize = 120;

/// One reported result, as a hand-in carries it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskResult {
    /// What was measured: `pass_rate`, `accuracy on held-out set`.
    pub name: String,
    /// The measured number, a plain decimal.
    pub value: String,
    /// The unit, or empty.
    pub unit: String,
    /// The number it is compared with (before, or the other method), or empty.
    pub baseline: String,
    /// How many cases the number is over, or empty.
    pub sample_size: String,
    /// What produced the number (a commit, a model, a log hash), or empty.
    pub produced_by: String,
}

impl TaskResult {
    /// The tag a hand-in carries for this result.
    #[must_use]
    pub fn to_tag(&self) -> Vec<String> {
        vec![
            TAG_RESULT.to_string(),
            self.name.clone(),
            self.value.clone(),
            self.unit.clone(),
            self.baseline.clone(),
            self.sample_size.clone(),
            self.produced_by.clone(),
        ]
    }
}

fn has_control(text: &str) -> bool {
    text.chars().any(char::is_control)
}

/// Whether `text` is a plain decimal number: an optional minus, digits, and an optional fraction.
#[must_use]
pub fn is_plain_number(text: &str) -> bool {
    if text.is_empty() || text.len() > MAX_NUMBER {
        return false;
    }
    let digits = text.strip_prefix('-').unwrap_or(text);
    let (whole, fraction) = match digits.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (digits, None),
    };
    !whole.is_empty()
        && whole.bytes().all(|b| b.is_ascii_digit())
        && fraction.is_none_or(|f| !f.is_empty() && f.bytes().all(|b| b.is_ascii_digit()))
}

fn is_hex64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Read one `task-result` tag (its fields, name first) into a result, or say in plain words what is wrong with it.
///
/// # Errors
///
/// A message naming the broken field when the tag does not follow the table in the module docs.
pub fn parse_result_tag(fields: &[String]) -> Result<TaskResult, String> {
    if fields.first().map(String::as_str) != Some(TAG_RESULT) {
        return Err("not a task-result tag".into());
    }
    if fields.len() != 7 {
        return Err(format!(
            "a {TAG_RESULT} tag has six fields after its name (name, value, unit, baseline, sample size, produced by); this one has {}",
            fields.len().saturating_sub(1)
        ));
    }
    let name = fields[1].as_str();
    if name.trim().is_empty() || name != name.trim() || name.chars().count() > MAX_NAME {
        return Err(format!(
            "a result's name is 1 to {MAX_NAME} characters with no space at either end"
        ));
    }
    if has_control(name) {
        return Err("a result's name has a control character".into());
    }
    if !is_plain_number(&fields[2]) {
        return Err(format!(
            "result {name:?} needs a plain number as its value (like 0.82 or 1200)"
        ));
    }
    let unit = fields[3].as_str();
    if unit.chars().count() > MAX_UNIT || has_control(unit) || unit != unit.trim() {
        return Err(format!(
            "result {name:?}: the unit is at most {MAX_UNIT} characters"
        ));
    }
    let baseline = fields[4].as_str();
    if !baseline.is_empty() && !is_plain_number(baseline) {
        return Err(format!(
            "result {name:?}: the baseline is empty or a plain number"
        ));
    }
    let sample = fields[5].as_str();
    if !sample.is_empty()
        && (sample.len() > MAX_SAMPLE_DIGITS
            || !sample.bytes().all(|b| b.is_ascii_digit())
            || sample.parse::<u64>().ok() == Some(0))
    {
        return Err(format!(
            "result {name:?}: the sample size is empty or a whole number above zero"
        ));
    }
    let by = fields[6].as_str();
    if by.chars().count() > MAX_PRODUCED_BY || has_control(by) || by != by.trim() {
        return Err(format!(
            "result {name:?}: what produced it is at most {MAX_PRODUCED_BY} characters"
        ));
    }
    Ok(TaskResult {
        name: name.to_string(),
        value: fields[2].clone(),
        unit: unit.to_string(),
        baseline: baseline.to_string(),
        sample_size: sample.to_string(),
        produced_by: by.to_string(),
    })
}

/// Check every result, run log and run record tag of a hand-in, and return its results.
///
/// `tags` are all the tags of the record; tags with other names are not looked at. The relay calls this for an
/// `evidence` step; the CLI calls it before it signs one.
///
/// # Errors
///
/// A message naming the first thing that breaks the bounds: too many results, a repeated name, a malformed field,
/// more than one run log or run record.
pub fn check_hand_in_tags(tags: &[Vec<String>]) -> Result<Vec<TaskResult>, String> {
    let mut results: Vec<TaskResult> = Vec::new();
    let mut names = HashSet::new();
    let (mut logs, mut records) = (0usize, 0usize);
    for fields in tags {
        match fields.first().map(String::as_str) {
            Some(TAG_RESULT) => {
                if results.len() >= MAX_RESULTS {
                    return Err(format!("a hand-in carries at most {MAX_RESULTS} results"));
                }
                let result = parse_result_tag(fields)?;
                if !names.insert(result.name.to_lowercase()) {
                    return Err(format!("the result {:?} is given twice", result.name));
                }
                results.push(result);
            }
            Some(TAG_RUN_LOG) => {
                logs += 1;
                let hash = fields.get(1).map(String::as_str).unwrap_or("");
                let name = fields.get(2).map(String::as_str).unwrap_or("");
                if logs > 1
                    || fields.len() != 3
                    || !is_hex64(hash)
                    || name.chars().count() > MAX_LOG_NAME
                    || has_control(name)
                {
                    return Err(format!(
                        "a hand-in carries at most one {TAG_RUN_LOG}: a sha256 fingerprint and a file name of at most {MAX_LOG_NAME} characters"
                    ));
                }
            }
            Some(TAG_RUN_RECORD) => {
                records += 1;
                let id = fields.get(1).map(String::as_str).unwrap_or("");
                if records > 1 || fields.len() != 2 || !is_hex64(id) {
                    return Err(format!(
                        "a hand-in carries at most one {TAG_RUN_RECORD}: the id of a run record (64 hex characters)"
                    ));
                }
            }
            _ => {}
        }
    }
    Ok(results)
}

/// Whether a tag is one of the three this module owns.
#[must_use]
pub fn is_hand_in_extra(fields: &[String]) -> bool {
    matches!(
        fields.first().map(String::as_str),
        Some(TAG_RESULT | TAG_RUN_LOG | TAG_RUN_RECORD)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tag(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|p| (*p).to_string()).collect()
    }

    fn result(name: &str, value: &str) -> Vec<String> {
        tag(&["task-result", name, value, "", "", "", ""])
    }

    #[test]
    fn plain_numbers_only() {
        for ok in ["0", "0.82", "-3", "1200", "-0.5"] {
            assert!(is_plain_number(ok), "{ok}");
        }
        for bad in [
            "", "1e5", "1,200", ".5", "5.", "--1", "NaN", "inf", "0x10", " 1",
        ] {
            assert!(!is_plain_number(bad), "{bad}");
        }
        assert!(!is_plain_number(&"9".repeat(MAX_NUMBER + 1)));
    }

    #[test]
    fn a_result_round_trips_through_its_tag() {
        let r = TaskResult {
            name: "pass_rate".into(),
            value: "0.82".into(),
            unit: "ratio".into(),
            baseline: "0.71".into(),
            sample_size: "40".into(),
            produced_by: "commit abc123".into(),
        };
        assert_eq!(parse_result_tag(&r.to_tag()), Ok(r));
    }

    #[test]
    fn a_result_that_breaks_a_bound_is_refused_in_words() {
        assert!(parse_result_tag(&tag(&["task-result", "x", "1"])).is_err());
        assert!(parse_result_tag(&result("", "1")).is_err());
        assert!(parse_result_tag(&result(" x", "1")).is_err());
        assert!(parse_result_tag(&result(&"n".repeat(MAX_NAME + 1), "1")).is_err());
        assert!(parse_result_tag(&result("x", "high")).is_err());
        assert!(parse_result_tag(&tag(&["task-result", "x", "1", "", "lots", "", ""])).is_err());
        assert!(parse_result_tag(&tag(&["task-result", "x", "1", "", "", "0", ""])).is_err());
        assert!(parse_result_tag(&tag(&["task-result", "x", "1", "", "", "4.5", ""])).is_err());
        assert!(parse_result_tag(&tag(&[
            "task-result",
            "x",
            "1",
            "",
            "",
            "",
            &"p".repeat(MAX_PRODUCED_BY + 1)
        ]))
        .is_err());
        assert!(parse_result_tag(&tag(&["task-result", "x\n", "1", "", "", "", ""])).is_err());
    }

    #[test]
    fn a_hand_in_is_bounded_in_count_and_in_repeats() {
        let many: Vec<Vec<String>> = (0..=MAX_RESULTS)
            .map(|i| result(&format!("m{i}"), "1"))
            .collect();
        assert!(check_hand_in_tags(&many[..MAX_RESULTS]).is_ok());
        assert!(check_hand_in_tags(&many).is_err());
        assert!(check_hand_in_tags(&[result("Score", "1"), result("score", "2")]).is_err());
        let hash = "a".repeat(64);
        let log = tag(&["task-run-log", &hash, "run.log"]);
        assert!(check_hand_in_tags(&[log.clone()]).is_ok());
        assert!(check_hand_in_tags(&[log.clone(), log]).is_err());
        assert!(check_hand_in_tags(&[tag(&["task-run-log", "abc", "run.log"])]).is_err());
        let record = tag(&["task-run-record", &hash]);
        assert!(check_hand_in_tags(&[record.clone()]).is_ok());
        assert!(check_hand_in_tags(&[record.clone(), record]).is_err());
        assert!(check_hand_in_tags(&[tag(&["task-run-record", "nope"])]).is_err());
        // Tags of other names are not this module's business.
        assert_eq!(
            check_hand_in_tags(&[tag(&["task-link", "https://example.org"])]),
            Ok(vec![])
        );
    }
}
