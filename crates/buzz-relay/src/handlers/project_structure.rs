//! Envelopes for the two records that give a contributor project its working
//! structure (`docs/v3-review/PROJECT-STRUCTURE.md`, step 1):
//!
//! - kind:37019, work taken on: anyone may say they are doing a piece of work
//!   in a launch's work area, what they will deliver, for whom and by when.
//! - kind:37020, project focus: the launch author's "Now" (at most three) and
//!   "Not doing" lists.
//!
//! Neither moves money or grants anything; the relay checks only their shape,
//! plus that a focus record is signed by the launch it names.

use nostr::Event;

use super::ingest::parse_launch_coordinate;

/// Longest "what I will deliver" and Now item, in characters.
const MAX_TEXT_CHARS: usize = 280;
/// Longest "who will use it", in characters.
const MAX_FOR_CHARS: usize = 140;
/// Longest reason given for not doing something, in characters.
const MAX_WHY_CHARS: usize = 280;
/// At most this many Now items: a team works on a few things at a time.
const MAX_NOW: usize = 3;
/// At most this many Not doing items.
const MAX_NOT_DOING: usize = 10;
/// Longest aim (who the project is for and what it changes for them), in characters.
const MAX_AIM_CHARS: usize = 200;

/// The tags these records use: the `d` value and the single `a` coordinate.
fn d_and_launch<'a>(event: &'a Event, label: &str) -> Result<(&'a str, &'a str), String> {
    let mut d: Option<&str> = None;
    let mut a: Vec<&str> = Vec::new();
    for tag in event.tags.iter() {
        let parts = tag.as_slice();
        match parts.first().map(|s| s.as_str()) {
            Some("d") => {
                if d.is_some() {
                    return Err(format!("{label} must have exactly one `d` tag"));
                }
                d = Some(parts.get(1).map(|s| s.as_str()).unwrap_or(""));
            }
            Some("a") => a.push(parts.get(1).map(|s| s.as_str()).unwrap_or("")),
            _ => {}
        }
    }
    let Some(d) = d else {
        return Err(format!("{label} must have a `d` tag"));
    };
    if a.len() != 1 {
        return Err(format!(
            "{label} must have exactly one `a` tag (got {})",
            a.len()
        ));
    }
    parse_launch_coordinate(a[0])?;
    Ok((d, a[0]))
}

fn content_object(
    event: &Event,
    label: &str,
) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    match serde_json::from_str::<serde_json::Value>(&event.content) {
        Ok(serde_json::Value::Object(map)) => Ok(map),
        _ => Err(format!("{label} content must be a JSON object")),
    }
}

/// A string field of `1..=max` characters after trimming, or of `0..=max` when not `required`.
fn text_field(
    map: &serde_json::Map<String, serde_json::Value>,
    key: &str,
    max: usize,
    required: bool,
    label: &str,
) -> Result<(), String> {
    match map.get(key) {
        None if !required => Ok(()),
        None => Err(format!("{label} `{key}` is required")),
        Some(serde_json::Value::String(text)) => {
            let n = text.trim().chars().count();
            if (required && n == 0) || n > max {
                Err(format!(
                    "{label} `{key}` must be {} to {max} characters",
                    if required { 1 } else { 0 }
                ))
            } else {
                Ok(())
            }
        }
        _ => Err(format!("{label} `{key}` must be a string")),
    }
}

fn is_lower_hex(value: &str, digits: usize) -> bool {
    value.len() == digits + 2
        && value.starts_with("0x")
        && value[2..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// A work area: `<budget address>:<work area id>`, both lowercase hex.
fn is_work_area(value: &str) -> bool {
    match value.split_once(':') {
        Some((budget, id)) => is_lower_hex(budget, 40) && is_lower_hex(id, 64),
        None => false,
    }
}

/// kind:37019. `d` names the work area; content holds what will be delivered (1–280 characters), who will use it
/// (1–140), `until` (Unix seconds), and optionally `released: true`.
pub(crate) fn validate_work_taken_on(event: &Event) -> Result<(), String> {
    const LABEL: &str = "work taken on";
    let (d, _) = d_and_launch(event, LABEL)?;
    if !is_work_area(d) {
        return Err(format!(
            "{LABEL} `d` tag must be `<budget>:<work-area-id>` in lowercase hex"
        ));
    }
    let map = content_object(event, LABEL)?;
    text_field(&map, "deliver", MAX_TEXT_CHARS, true, LABEL)?;
    text_field(&map, "for", MAX_FOR_CHARS, true, LABEL)?;
    match map.get("until") {
        Some(serde_json::Value::Number(n)) if n.as_u64().is_some_and(|v| v > 0) => {}
        _ => {
            return Err(format!(
                "{LABEL} `until` must be a positive whole number of seconds"
            ))
        }
    }
    match map.get("released") {
        None | Some(serde_json::Value::Bool(_)) => Ok(()),
        _ => Err(format!("{LABEL} `released` must be true or false")),
    }
}

/// kind:37020. `d` is the launch id of the `a` tag, whose author must be the signer; content holds `now` (at most
/// three items of `text` and an optional `area`) and `notDoing` (at most ten items of `text` and an optional `why`).
pub(crate) fn validate_project_focus(event: &Event) -> Result<(), String> {
    const LABEL: &str = "project focus";
    let (d, coordinate) = d_and_launch(event, LABEL)?;
    let mut segments = coordinate.splitn(3, ':');
    let (_, author, launch) = (segments.next(), segments.next(), segments.next());
    if author != Some(event.pubkey.to_hex().as_str()) {
        return Err(format!("{LABEL} must be signed by the launch's author"));
    }
    if launch != Some(d) {
        return Err(format!(
            "{LABEL} `d` tag must be the launch id its `a` tag names"
        ));
    }
    let map = content_object(event, LABEL)?;
    text_field(&map, "aim", MAX_AIM_CHARS, false, LABEL)?;
    let list = |key: &str,
                max: usize|
     -> Result<Vec<serde_json::Map<String, serde_json::Value>>, String> {
        match map.get(key) {
            None => Ok(Vec::new()),
            Some(serde_json::Value::Array(items)) if items.len() <= max => items
                .iter()
                .map(|item| match item {
                    serde_json::Value::Object(entry) => Ok(entry.clone()),
                    _ => Err(format!("{LABEL} `{key}` items must be objects")),
                })
                .collect(),
            Some(serde_json::Value::Array(_)) => {
                Err(format!("{LABEL} `{key}` holds at most {max} items"))
            }
            _ => Err(format!("{LABEL} `{key}` must be a list")),
        }
    };
    for item in list("now", MAX_NOW)? {
        text_field(&item, "text", MAX_TEXT_CHARS, true, LABEL)?;
        match item.get("area") {
            None => {}
            Some(serde_json::Value::String(area)) if is_work_area(area) => {}
            _ => {
                return Err(format!(
                    "{LABEL} `area` must be `<budget>:<work-area-id>` in lowercase hex"
                ))
            }
        }
        // Why this now, and what the team expects to see by a day it will check: optional, but a prediction
        // always carries its day and a day always carries its prediction.
        text_field(&item, "why", MAX_WHY_CHARS, false, LABEL)?;
        text_field(&item, "expect", MAX_WHY_CHARS, false, LABEL)?;
        let check_by = match item.get("checkBy") {
            None => false,
            Some(serde_json::Value::Number(n)) if n.as_u64().is_some_and(|v| v > 0) => true,
            _ => {
                return Err(format!(
                    "{LABEL} `checkBy` must be a positive whole number of seconds"
                ))
            }
        };
        if item.contains_key("expect") != check_by {
            return Err(format!(
                "{LABEL} `expect` and `checkBy` must be given together"
            ));
        }
    }
    for item in list("notDoing", MAX_NOT_DOING)? {
        text_field(&item, "text", MAX_TEXT_CHARS, true, LABEL)?;
        text_field(&item, "why", MAX_WHY_CHARS, false, LABEL)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const AREA: &str = "0x1111111111111111111111111111111111111111:0x2222222222222222222222222222222222222222222222222222222222222222";

    fn event(keys: &nostr::Keys, kind: u16, content: &str, tags: &[&[&str]]) -> Event {
        let tags: Vec<nostr::Tag> = tags
            .iter()
            .map(|t| nostr::Tag::parse(t.iter().copied()).expect("tag"))
            .collect();
        nostr::EventBuilder::new(nostr::Kind::Custom(kind), content)
            .tags(tags)
            .sign_with_keys(keys)
            .expect("sign")
    }

    fn launch(author: &str) -> String {
        format!("37001:{author}:docs-commons")
    }

    #[test]
    fn work_taken_on_needs_a_work_area_a_launch_and_its_three_answers() {
        let keys = nostr::Keys::generate();
        let founder = "f".repeat(64);
        let a = launch(&founder);
        let good = r#"{"deliver":"A first guide","for":"New contributors","until":1767225600}"#;
        let ok = event(&keys, 37019, good, &[&["d", AREA], &["a", &a]]);
        assert_eq!(validate_work_taken_on(&ok), Ok(()));
        let released = r#"{"deliver":"A first guide","for":"New contributors","until":1767225600,"released":true}"#;
        assert_eq!(
            validate_work_taken_on(&event(&keys, 37019, released, &[&["d", AREA], &["a", &a]])),
            Ok(())
        );

        let upper = AREA.replace("0x1111", "0xAAAA");
        for (content, tags) in [
            (good, vec![vec!["a", a.as_str()]]),
            (good, vec![vec!["d", "docs"], vec!["a", a.as_str()]]),
            (good, vec![vec!["d", upper.as_str()], vec!["a", a.as_str()]]),
            (good, vec![vec!["d", AREA]]),
            (good, vec![vec!["d", AREA], vec!["a", "30023:x:y"]]),
            (
                r#"{"for":"x","until":1}"#,
                vec![vec!["d", AREA], vec!["a", a.as_str()]],
            ),
            (
                r#"{"deliver":" ","for":"x","until":1}"#,
                vec![vec!["d", AREA], vec!["a", a.as_str()]],
            ),
            (
                r#"{"deliver":"x","until":1}"#,
                vec![vec!["d", AREA], vec!["a", a.as_str()]],
            ),
            (
                r#"{"deliver":"x","for":"y","until":0}"#,
                vec![vec!["d", AREA], vec!["a", a.as_str()]],
            ),
            (
                r#"{"deliver":"x","for":"y","until":"soon"}"#,
                vec![vec!["d", AREA], vec!["a", a.as_str()]],
            ),
            (
                r#"{"deliver":"x","for":"y","until":1,"released":"yes"}"#,
                vec![vec!["d", AREA], vec!["a", a.as_str()]],
            ),
            ("not json", vec![vec!["d", AREA], vec!["a", a.as_str()]]),
        ] {
            let tags: Vec<&[&str]> = tags.iter().map(|t| t.as_slice()).collect();
            assert!(
                validate_work_taken_on(&event(&keys, 37019, content, &tags)).is_err(),
                "{content} {tags:?}"
            );
        }
        let long = format!(
            r#"{{"deliver":"{}","for":"y","until":1}}"#,
            "x".repeat(MAX_TEXT_CHARS + 1)
        );
        assert!(
            validate_work_taken_on(&event(&keys, 37019, &long, &[&["d", AREA], &["a", &a]]))
                .is_err()
        );
    }

    #[test]
    fn project_focus_is_the_launch_authors_own_and_stays_short() {
        let founder = nostr::Keys::generate();
        let me = founder.public_key().to_hex();
        let a = launch(&me);
        let content = format!(
            r#"{{"aim":"Teachers who want open lesson plans","now":[{{"text":"Ship the first guide","area":"{AREA}","why":"Newcomers need it","expect":"Three newcomers submit","checkBy":1767225600}},{{"text":"Find two reviewers"}}],"notDoing":[{{"text":"A mobile app","why":"Not before the guide works"}}]}}"#
        );
        let ok = event(
            &founder,
            37020,
            &content,
            &[&["d", "docs-commons"], &["a", &a]],
        );
        assert_eq!(validate_project_focus(&ok), Ok(()));
        assert_eq!(
            validate_project_focus(&event(
                &founder,
                37020,
                "{}",
                &[&["d", "docs-commons"], &["a", &a]]
            )),
            Ok(())
        );

        // Someone else cannot set a launch's focus, and the d tag must be the launch's id.
        let other = nostr::Keys::generate();
        assert!(validate_project_focus(&event(
            &other,
            37020,
            &content,
            &[&["d", "docs-commons"], &["a", &a]]
        ))
        .is_err());
        assert!(validate_project_focus(&event(
            &founder,
            37020,
            &content,
            &[&["d", "other"], &["a", &a]]
        ))
        .is_err());

        let four = r#"{"now":[{"text":"a"},{"text":"b"},{"text":"c"},{"text":"d"}]}"#;
        let empty = r#"{"now":[{"text":""}]}"#;
        let bad_area = r#"{"now":[{"text":"a","area":"docs"}]}"#;
        let not_list = r#"{"notDoing":"everything"}"#;
        let expect_without_day = r#"{"now":[{"text":"a","expect":"ten sign-ups"}]}"#;
        let day_without_expect = r#"{"now":[{"text":"a","checkBy":1767225600}]}"#;
        let bad_day = r#"{"now":[{"text":"a","expect":"x","checkBy":"soon"}]}"#;
        let long_aim = format!(r#"{{"aim":"{}"}}"#, "a".repeat(MAX_AIM_CHARS + 1));
        let long_why = format!(
            r#"{{"notDoing":[{{"text":"a","why":"{}"}}]}}"#,
            "w".repeat(MAX_WHY_CHARS + 1)
        );
        let eleven = format!(
            r#"{{"notDoing":[{}]}}"#,
            [r#"{"text":"a"}"#; MAX_NOT_DOING + 1].join(",")
        );
        for content in [
            expect_without_day,
            day_without_expect,
            bad_day,
            long_aim.as_str(),
            four,
            empty,
            bad_area,
            not_list,
            long_why.as_str(),
            eleven.as_str(),
        ] {
            assert!(
                validate_project_focus(&event(
                    &founder,
                    37020,
                    content,
                    &[&["d", "docs-commons"], &["a", &a]]
                ))
                .is_err(),
                "{content}"
            );
        }
    }
}
