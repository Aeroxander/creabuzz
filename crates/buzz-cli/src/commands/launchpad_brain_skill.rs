//! The project brain's recorded-run skill (docs/MANAGEMENT-LAYER.md section 9, step B4): turn what a founder said and
//! did while doing one job once into one playbook file, `playbooks/<job>.md`: when to use it, the steps, the checks, the
//! mistakes to avoid.
//!
//! - The recording is a text file the founder supplies (a transcript or notes). No audio is read and nothing is
//!   uploaded: this command is local and sends nothing anywhere.
//! - No AI service is called. The draft is a skeleton built from the recording's own headings: what sits under a heading
//!   that names a section is copied into that section word for word, a heading that names none goes under "Not sorted
//!   yet", and a section the recording did not cover says so and is listed for the founder to write. The server's manager
//!   has no route for playbooks, so nothing here asks it to.
//! - The founder reviews before anything is saved: without `--save` the draft is only printed. With `--save` it is
//!   written as a new file and never over an existing one.
//! - A recording, or a draft, that looks like it holds a key or a password is refused (the brain's own check).
//!
//! Not yet tried by real founders: MANAGEMENT-LAYER section 9 asked for five to ten founders to use the brain by hand
//! first, and the lead decided to build it ahead of that.

use std::io::Read;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::launchpad_brain::{looks_like_a_key, MAX_PLAYBOOKS};
use crate::error::CliError;

/// The most bytes of a recording read.
const MAX_RECORDING_BYTES: u64 = 128 * 1024;
/// The longest job name, in characters.
const MAX_JOB_CHARS: usize = 48;
/// The longest "added by" name, in characters.
const MAX_BY_CHARS: usize = 80;
/// What a section says when the recording did not cover it.
const NOT_FILLED: &str = "_Not filled in yet: the founder writes this._";
/// Always in "Mistakes to avoid": the brain's own rule for money, Shares, legal terms and tax.
const PERSON_STEP: &str =
    "Anything about money, Shares, legal terms or tax ends with a person's step, never an \
agent's.";

/// The four sections of a playbook, in the order the file shows them.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Section {
    When,
    Steps,
    Checks,
    Mistakes,
}

impl Section {
    const ALL: [Section; 4] = [
        Section::When,
        Section::Steps,
        Section::Checks,
        Section::Mistakes,
    ];

    fn title(self) -> &'static str {
        match self {
            Section::When => "When to use it",
            Section::Steps => "Steps",
            Section::Checks => "Checks",
            Section::Mistakes => "Mistakes to avoid",
        }
    }
}

/// Which section a heading of the recording names, or `None`. Whole words, tried in this order (a heading that names
/// mistakes and checks is a list of mistakes).
fn classify(heading: &str) -> Option<Section> {
    let lower = heading.to_lowercase();
    let words: Vec<&str> = lower
        .split(|c: char| !c.is_alphanumeric() && c != '\'')
        .filter(|w| !w.is_empty())
        .collect();
    let has = |prefixes: &[&str], exact: &[&str]| {
        words
            .iter()
            .any(|w| exact.contains(w) || prefixes.iter().any(|p| w.starts_with(p)))
    };
    if has(
        &["mistake", "avoid", "pitfall", "careful", "warning", "trap"],
        &["never", "don't", "dont"],
    ) {
        Some(Section::Mistakes)
    } else if has(&["check", "verif", "confirm", "test"], &[]) {
        Some(Section::Checks)
    } else if has(&["trigger"], &["when", "use"]) {
        Some(Section::When)
    } else if has(
        &["step", "how", "process", "procedure", "walkthrough"],
        &["do", "did"],
    ) {
        Some(Section::Steps)
    } else {
        None
    }
}

/// A playbook built from a recording, before it is saved.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Draft {
    /// The whole file.
    pub text: String,
    /// What the founder still has to write or sort, in plain words.
    pub left_for_founder: Vec<String>,
    /// Lines before the recording's first heading: they belong to no section and were not used.
    pub lines_unused: usize,
}

/// A recording's headings and what sits under each, in order. A `#` line inside a fenced block is text, not a heading.
fn split_recording(recording: &str) -> (usize, Vec<(String, String)>) {
    let mut unused = 0usize;
    let mut parts: Vec<(String, Vec<&str>)> = Vec::new();
    let mut fenced = false;
    for line in recording.lines() {
        if line.trim_start().starts_with("```") {
            fenced = !fenced;
        }
        let hashes = line.bytes().take_while(|b| *b == b'#').count();
        let is_heading = !fenced
            && (1..=6).contains(&hashes)
            && line[hashes..].starts_with(' ')
            && !line[hashes..].trim().is_empty();
        if is_heading {
            parts.push((line[hashes..].trim().to_string(), Vec::new()));
        } else if let Some((_, body)) = parts.last_mut() {
            body.push(line);
        } else if !line.trim().is_empty() {
            unused += 1;
        }
    }
    let parts = parts
        .into_iter()
        .map(|(heading, body)| (heading, body.join("\n").trim().to_string()))
        .collect();
    (unused, parts)
}

/// The job's name as a title: `order-samples` becomes `Order samples`.
fn title_of(job: &str) -> String {
    let spaced = job.replace('-', " ");
    let mut chars = spaced.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// A job's file name stem: lower-case letters, digits and single hyphens, never `readme`, at most [`MAX_JOB_CHARS`].
fn check_job(job: &str) -> Result<(), CliError> {
    let plain = !job.is_empty()
        && job.chars().count() <= MAX_JOB_CHARS
        && job
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !job.starts_with('-')
        && !job.ends_with('-')
        && !job.contains("--");
    if !plain {
        return Err(CliError::Usage(format!(
            "the job name must be lower-case words joined by hyphens (letters, digits and single hyphens, at most \
{MAX_JOB_CHARS} characters), like order-samples; got {job:?}"
        )));
    }
    if job == "readme" {
        return Err(CliError::Usage(
            "`readme` is the playbooks folder's own file: give the job a name of its own".into(),
        ));
    }
    Ok(())
}

/// Build the draft playbook for `job` from `recording`. Refuses a recording or a name that looks like it holds a key.
pub(crate) fn draft(job: &str, by: &str, date: &str, recording: &str) -> Result<Draft, CliError> {
    check_job(job)?;
    if by.trim().is_empty() || by.chars().count() > MAX_BY_CHARS || by.chars().any(char::is_control)
    {
        return Err(CliError::Usage(format!(
            "--by must be a short name on one line (at most {MAX_BY_CHARS} characters)"
        )));
    }
    if let Some(what) = looks_like_a_key(recording).or_else(|| looks_like_a_key(by)) {
        return Err(CliError::Usage(format!(
            "the recording looks like it holds {what}; take it out and run this again. Nothing was written, and a key \
must never sit in a playbook (the repository may be public)"
        )));
    }
    let (lines_unused, parts) = split_recording(recording);
    let mut body: Vec<(Section, Vec<String>)> = Section::ALL.map(|s| (s, Vec::new())).to_vec();
    let mut not_sorted: Vec<(String, String)> = Vec::new();
    for (heading, content) in parts {
        if content.is_empty() {
            continue;
        }
        match classify(&heading) {
            Some(section) => {
                if let Some((_, texts)) = body.iter_mut().find(|(s, _)| *s == section) {
                    texts.push(content);
                }
            }
            None => not_sorted.push((heading, content)),
        }
    }

    let mut left: Vec<String> = Vec::new();
    let mut text = format!(
        "# {}\n\n_Drafted from a recorded run, from its headings only. Read it, fix it and add what is missing before \
anyone relies on it._\n",
        title_of(job)
    );
    for (section, texts) in &body {
        text.push_str(&format!("\n## {}\n\n", section.title()));
        if texts.is_empty() {
            text.push_str(NOT_FILLED);
            text.push('\n');
            left.push(format!("write \"{}\"", section.title()));
        } else {
            text.push_str(&texts.join("\n\n"));
            text.push('\n');
        }
        if *section == Section::Mistakes {
            text.push_str(&format!("\n- {PERSON_STEP}\n"));
        }
    }
    if !not_sorted.is_empty() {
        text.push_str("\n## Not sorted yet\n\nThe recording had these headings, which name no section above. Move each \
into the right one.\n");
        for (heading, content) in &not_sorted {
            text.push_str(&format!("\n### {heading}\n\n{content}\n"));
            left.push(format!("sort the part headed \"{heading}\""));
        }
    }
    text.push_str(&format!("\n## Added\n\n{date} by {by}.\n"));
    if lines_unused > 0 {
        left.push(format!(
            "{lines_unused} line(s) came before the first heading and were not used: put what matters under a heading"
        ));
    }
    if let Some(what) = looks_like_a_key(&text) {
        return Err(CliError::Usage(format!(
            "the draft looks like it holds {what}; nothing was written"
        )));
    }
    Ok(Draft {
        text,
        left_for_founder: left,
        lines_unused,
    })
}

/// Read the founder's recording: one regular text file, at most [`MAX_RECORDING_BYTES`]. Audio and any other file
/// that is not text is refused; nothing is uploaded.
pub(crate) fn read_recording(path: &Path) -> Result<String, CliError> {
    let meta = path.metadata().map_err(|e| {
        CliError::Usage(format!(
            "could not read the recording {}: {e}",
            path.display()
        ))
    })?;
    if !meta.is_file() {
        return Err(CliError::Usage(format!(
            "{} is not a file: give a text file with the transcript or notes",
            path.display()
        )));
    }
    if meta.len() > MAX_RECORDING_BYTES {
        return Err(CliError::Usage(format!(
            "{} is larger than a recording should be ({} bytes, at most {MAX_RECORDING_BYTES}): keep the notes for \
one job",
            path.display(),
            meta.len()
        )));
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .and_then(|file| file.take(MAX_RECORDING_BYTES + 1).read_to_end(&mut bytes))
        .map_err(|e| CliError::Usage(format!("could not read {}: {e}", path.display())))?;
    if bytes.len() as u64 > MAX_RECORDING_BYTES {
        return Err(CliError::Usage(format!(
            "{} grew while it was read and is too large",
            path.display()
        )));
    }
    match String::from_utf8(bytes) {
        Ok(text) if !text.contains('\0') => Ok(text),
        _ => Err(CliError::Usage(format!(
            "{} is not text: this command reads a transcript or notes written as text, never audio",
            path.display()
        ))),
    }
}

/// Where the playbook goes, after checking the brain is there and has room. Never a link, never an existing file.
fn target(dir: &Path, job: &str) -> Result<PathBuf, CliError> {
    let playbooks = dir.join("playbooks");
    let meta = playbooks.symlink_metadata().map_err(|_| {
        CliError::Usage(format!(
            "{} has no playbooks folder: run `buzz launchpad brain init --dir {}` first",
            dir.display(),
            dir.display()
        ))
    })?;
    if meta.file_type().is_symlink() {
        return Err(CliError::Usage(format!(
            "{} is a link: the brain's files must be real files in the repository",
            playbooks.display()
        )));
    }
    if !meta.is_dir() {
        return Err(CliError::Usage(format!(
            "{} is not a folder",
            playbooks.display()
        )));
    }
    let file = playbooks.join(format!("{job}.md"));
    if file.symlink_metadata().is_ok() {
        return Err(CliError::Conflict(format!(
            "playbooks/{job}.md is already there; nothing was written, and nothing is ever overwritten. Give this job a \
new name, or change that file by hand"
        )));
    }
    let existing = std::fs::read_dir(&playbooks)
        .map_err(|e| CliError::Other(format!("could not read {}: {e}", playbooks.display())))?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "md"))
        .count();
    if existing >= MAX_PLAYBOOKS {
        return Err(CliError::Usage(format!(
            "playbooks/ already holds {existing} files, the most `brain check` reads: fold some jobs together first"
        )));
    }
    Ok(file)
}

/// What one run of the command did.
#[derive(Debug)]
pub(crate) struct Outcome {
    /// The playbook's path inside the checkout.
    pub path: String,
    /// Whether it was written.
    pub saved: bool,
    /// The draft.
    pub draft: Draft,
}

/// The command: read the recording, build the draft, and, only when `save` is set, write it as a new file in `dir`.
/// Without `save` nothing on disk changes. The target is checked either way, so a preview already says when a save
/// would be refused.
pub(crate) fn run(
    dir: &Path,
    recording: &Path,
    job: &str,
    by: &str,
    date: &str,
    save: bool,
) -> Result<Outcome, CliError> {
    check_job(job)?;
    if !dir.is_dir() {
        return Err(CliError::Usage(format!(
            "{} is not a directory: give the project's repository checkout",
            dir.display()
        )));
    }
    let words = read_recording(recording)?;
    let built = draft(job, by, date, &words)?;
    let file = target(dir, job)?;
    if save {
        // `create_new`: a file that appeared since the check above is never overwritten either.
        let mut out = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&file)
            .map_err(|e| CliError::Other(format!("could not write {}: {e}", file.display())))?;
        if let Err(e) = std::io::Write::write_all(&mut out, built.text.as_bytes()) {
            drop(out);
            let _ = std::fs::remove_file(&file);
            return Err(CliError::Other(format!(
                "could not write {}: {e}",
                file.display()
            )));
        }
    }
    Ok(Outcome {
        path: format!("playbooks/{job}.md"),
        saved: save,
        draft: built,
    })
}

/// The JSON a run prints, and the words for the person.
pub(crate) fn report(outcome: &Outcome, schema: &str) -> (Value, String) {
    let next = if outcome.saved {
        format!(
            "Saved as {}. Nothing is private if the repository is public. Commit it when you are happy with it.",
            outcome.path
        )
    } else {
        format!(
            "Not saved. Read the draft above, then run the same command again with --save to write {}.",
            outcome.path
        )
    };
    let json = json!({
        "schema": schema,
        "skill": {
            "path": outcome.path,
            "saved": outcome.saved,
            "model_called": false,
            "tried_by_real_founders": false,
            "left_for_founder": outcome.draft.left_for_founder,
            "lines_unused": outcome.draft.lines_unused,
            "draft": outcome.draft.text,
            "note": next,
        }
    });
    (json, next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::launchpad_brain;

    const DATE: &str = "2026-11-22";

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("skill-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    fn brain() -> PathBuf {
        let dir = scratch();
        launchpad_brain::init(&dir).expect("init");
        dir
    }

    fn recording(dir: &Path, words: &str) -> PathBuf {
        let path = dir.join("notes.txt");
        std::fs::write(&path, words).expect("write recording");
        path
    }

    const NOTES: &str = "I ordered samples today.\n\n# When to use it\nBefore a new product run.\n\n## Steps\n1. Ask \
two makers for a quote.\n2. Order one sample from each.\n\n# How I check it worked\nThe sample matches the photo.\n\n# \
Mistakes to avoid\nDo not order before the quote is in writing.\n\n# Supplier list\nOrbit Works, Lamp Co.\n";

    fn names(dir: &Path) -> Vec<String> {
        let mut found: Vec<String> = std::fs::read_dir(dir.join("playbooks"))
            .expect("read")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        found.sort();
        found
    }

    #[test]
    fn headings_name_the_sections_and_the_rest_is_left_for_the_founder() {
        let built = draft("order-samples", "the founder", DATE, NOTES).expect("draft");
        let text = &built.text;
        assert!(text.starts_with("# Order samples\n"), "{text}");
        let at = |needle: &str| {
            text.find(needle)
                .unwrap_or_else(|| panic!("{needle} in {text}"))
        };
        // The four sections, in order, with the recording's words under them.
        assert!(at("## When to use it") < at("Before a new product run."));
        assert!(at("Before a new product run.") < at("## Steps"));
        assert!(
            at("## Steps") < at("1. Ask two makers for a quote.\n2. Order one sample from each.")
        );
        assert!(at("## Checks") < at("The sample matches the photo."));
        assert!(at("## Mistakes to avoid") < at("Do not order before the quote is in writing."));
        // The one heading that names no section is kept, flagged, and not guessed into a section.
        assert!(at("## Not sorted yet") < at("### Supplier list"));
        assert!(text.contains("Orbit Works, Lamp Co."));
        assert!(text.contains("2026-11-22 by the founder."));
        assert!(text.contains(PERSON_STEP));
        assert!(!text.contains(NOT_FILLED), "every section was covered");
        // The line before the first heading is not used, and the founder is told.
        assert_eq!(built.lines_unused, 1);
        assert_eq!(
            built.left_for_founder.len(),
            2,
            "{:?}",
            built.left_for_founder
        );
        assert!(built.left_for_founder[0].contains("Supplier list"));
        assert!(built.left_for_founder[1].contains("before the first heading"));
    }

    #[test]
    fn a_recording_with_no_headings_gives_an_empty_skeleton_and_says_what_is_left() {
        let built = draft(
            "plain-job",
            "the founder",
            DATE,
            "I just talked for a while.\nThen I clicked the thing.\n",
        )
        .expect("draft");
        assert_eq!(built.text.matches(NOT_FILLED).count(), 4);
        assert!(
            !built.text.contains("clicked the thing"),
            "unused text is never copied"
        );
        assert_eq!(built.lines_unused, 2);
        assert_eq!(built.left_for_founder.len(), 5);
        assert!(built.left_for_founder[0].contains("When to use it"));
        // A heading inside a code block is text, not a heading.
        let fenced = draft(
            "fenced",
            "the founder",
            DATE,
            "# Steps\n```\n# Checks\nrun it\n```\nthen stop\n",
        )
        .expect("draft");
        assert!(
            fenced.text.contains("# Checks\nrun it\n```\nthen stop"),
            "{}",
            fenced.text
        );
        assert_eq!(fenced.text.matches(NOT_FILLED).count(), 3);
    }

    #[test]
    fn a_job_name_that_could_leave_the_playbooks_folder_is_refused() {
        let dir = brain();
        let notes = recording(&dir, NOTES);
        for bad in [
            "",
            "../outside",
            "a/b",
            "..",
            ".hidden",
            "Upper",
            "two words",
            "-lead",
            "trail-",
            "dou--ble",
            "readme",
            &"x".repeat(MAX_JOB_CHARS + 1),
        ] {
            let refused = run(&dir, &notes, bad, "me", DATE, true).expect_err(bad);
            assert!(matches!(refused, CliError::Usage(_)), "{bad}: {refused}");
        }
        assert_eq!(names(&dir), ["README.md"], "nothing was written");
        assert!(!dir.join("outside.md").exists());
        std::fs::remove_dir_all(&dir).expect("clean up");
    }

    #[test]
    fn a_recording_that_holds_a_key_is_refused_and_nothing_is_written() {
        let dir = brain();
        for (words, what) in [
            (
                "# Steps\n1. set password = hunter2hunter2\n".to_string(),
                "a line that sets a secret",
            ),
            (
                format!("# Steps\nuse the key nsec1{}\n", "q".repeat(58)),
                "a secret key",
            ),
            (
                format!("# Steps\npaste 0x{}\n", "ab".repeat(32)),
                "a 64-digit key",
            ),
            (
                "-----BEGIN OPENSSH PRIVATE KEY-----\n# Steps\nx".to_string(),
                "a private key block",
            ),
        ] {
            let notes = recording(&dir, &words);
            let refused = run(&dir, &notes, "release", "me", DATE, true).expect_err(what);
            assert!(refused.to_string().contains(what), "{what}: {refused}");
        }
        // A key hidden in the name of who added it is caught as well.
        let notes = recording(&dir, "# Steps\nfine\n");
        assert!(run(
            &dir,
            &notes,
            "release",
            "token = abcdefgh12345678",
            DATE,
            true
        )
        .is_err());
        assert_eq!(names(&dir), ["README.md"]);
        std::fs::remove_dir_all(&dir).expect("clean up");
    }

    #[test]
    fn only_a_small_text_file_is_a_recording() {
        let dir = brain();
        // Audio: bytes that are not text.
        let audio = dir.join("voice.m4a");
        std::fs::write(
            &audio,
            [0x00u8, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0xff, 0xfe],
        )
        .expect("write");
        let refused = run(&dir, &audio, "audio-job", "me", DATE, true).expect_err("audio");
        assert!(refused.to_string().contains("never audio"), "{refused}");
        // Text with a zero byte in it is not text either.
        let zero = recording(&dir, "# Steps\nok\0more");
        assert!(run(&dir, &zero, "zero-job", "me", DATE, true).is_err());
        // Too large.
        let big = recording(&dir, &"# Steps\n".repeat(20_000));
        let refused = run(&dir, &big, "big-job", "me", DATE, true).expect_err("big");
        assert!(
            refused.to_string().contains("larger than a recording"),
            "{refused}"
        );
        // A folder, and a file that is not there.
        assert!(run(&dir, &dir, "dir-job", "me", DATE, true).is_err());
        assert!(run(&dir, &dir.join("nothing.txt"), "none-job", "me", DATE, true).is_err());
        assert_eq!(names(&dir), ["README.md"]);
        std::fs::remove_dir_all(&dir).expect("clean up");
    }

    #[test]
    fn the_founder_reads_before_anything_is_saved() {
        let dir = brain();
        let notes = recording(&dir, NOTES);
        let before = names(&dir);
        let shown =
            run(&dir, &notes, "order-samples", "the founder", DATE, false).expect("preview");
        assert!(!shown.saved);
        assert!(shown.draft.text.contains("## Steps"));
        assert_eq!(names(&dir), before, "a preview writes nothing");
        let saved = run(&dir, &notes, "order-samples", "the founder", DATE, true).expect("save");
        assert!(saved.saved);
        assert_eq!(saved.path, "playbooks/order-samples.md");
        assert_eq!(
            std::fs::read_to_string(dir.join(&saved.path)).expect("read"),
            shown.draft.text,
            "what was saved is what was shown"
        );
        // The saved file is part of the brain and passes the brain's own key check.
        let checked = launchpad_brain::check(&dir).expect("check");
        assert!(
            checked.contains(&"playbooks/order-samples.md".to_string()),
            "{checked:?}"
        );
        let (json, words) = report(&saved, "creaton.brain.v1");
        assert_eq!(json["skill"]["model_called"], false);
        assert_eq!(json["skill"]["saved"], true);
        assert_eq!(json["skill"]["tried_by_real_founders"], false);
        assert!(words.contains("Saved as playbooks/order-samples.md"));
        std::fs::remove_dir_all(&dir).expect("clean up");
    }

    #[test]
    fn a_saved_playbook_is_never_overwritten_and_one_job_is_one_file() {
        let dir = brain();
        let notes = recording(&dir, NOTES);
        run(&dir, &notes, "order-samples", "me", DATE, true).expect("first");
        std::fs::write(
            dir.join("playbooks/order-samples.md"),
            "edited by the founder",
        )
        .expect("edit");
        for save in [false, true] {
            let refused = run(&dir, &notes, "order-samples", "me", DATE, save).expect_err("second");
            assert!(matches!(refused, CliError::Conflict(_)), "{refused}");
        }
        assert_eq!(
            std::fs::read_to_string(dir.join("playbooks/order-samples.md")).expect("read"),
            "edited by the founder"
        );
        // Only the one named job was written.
        assert_eq!(names(&dir), ["README.md", "order-samples.md"]);
        std::fs::remove_dir_all(&dir).expect("clean up");
    }

    #[cfg(unix)]
    #[test]
    fn a_link_where_the_playbook_or_its_folder_goes_is_refused() {
        let dir = brain();
        let elsewhere = scratch();
        let notes = recording(&dir, NOTES);
        // A link already sitting where the playbook would go (even one that points nowhere).
        std::os::unix::fs::symlink(elsewhere.join("gone.md"), dir.join("playbooks/linked.md"))
            .expect("link");
        let refused = run(&dir, &notes, "linked", "me", DATE, true).expect_err("link");
        assert!(matches!(refused, CliError::Conflict(_)), "{refused}");
        assert!(
            !elsewhere.join("gone.md").exists(),
            "nothing was written through the link"
        );
        // The playbooks folder itself being a link.
        std::fs::remove_file(dir.join("playbooks/linked.md")).expect("remove");
        std::fs::remove_dir_all(dir.join("playbooks")).expect("remove");
        std::os::unix::fs::symlink(&elsewhere, dir.join("playbooks")).expect("link");
        let refused = run(&dir, &notes, "any-job", "me", DATE, true).expect_err("link");
        assert!(refused.to_string().contains("is a link"), "{refused}");
        assert!(std::fs::read_dir(&elsewhere)
            .expect("read")
            .next()
            .is_none());
        std::fs::remove_dir_all(&dir).expect("clean up");
        std::fs::remove_dir_all(&elsewhere).expect("clean up");
    }

    #[test]
    fn it_needs_a_brain_and_leaves_room_for_the_check_to_read_it() {
        let empty = scratch();
        let notes = recording(&empty, NOTES);
        let refused = run(&empty, &notes, "order-samples", "me", DATE, true).expect_err("no brain");
        assert!(refused.to_string().contains("brain init"), "{refused}");
        assert!(!empty.join("playbooks").exists(), "no folder was made");
        std::fs::remove_dir_all(&empty).expect("clean up");

        let dir = brain();
        let notes = recording(&dir, NOTES);
        for n in 0..MAX_PLAYBOOKS - 1 {
            std::fs::write(dir.join(format!("playbooks/job-{n}.md")), "x").expect("write");
        }
        // README plus 199 jobs is 200 files: full.
        let refused = run(&dir, &notes, "one-too-many", "me", DATE, true).expect_err("full");
        assert!(
            refused.to_string().contains("the most `brain check` reads"),
            "{refused}"
        );
        std::fs::remove_file(dir.join("playbooks/job-0.md")).expect("remove");
        run(&dir, &notes, "one-too-many", "me", DATE, true).expect("room again");
        std::fs::remove_dir_all(&dir).expect("clean up");
    }

    #[test]
    fn the_command_is_local_and_says_what_it_does_not_do() {
        // It has no client: `dispatch` takes only the command, so nothing can be sent. The words say so.
        use clap::CommandFactory;
        let mut cli = crate::Cli::command();
        let skill = cli
            .find_subcommand_mut("launchpad")
            .and_then(|c| c.find_subcommand_mut("brain"))
            .and_then(|c| c.find_subcommand_mut("skill"))
            .expect("`buzz launchpad brain skill` exists");
        let help = skill.render_long_help().to_string();
        assert!(help.contains("Not yet tried by real founders"), "{help}");
        assert!(help.contains("no AI service"), "{help}");
        assert!(!help.to_lowercase().contains("earn"), "{help}");
    }
}
