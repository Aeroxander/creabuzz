//! The project brain (docs/MANAGEMENT-LAYER.md section 9, step B1): five plain files every agent on a project reads
//! before any task, kept in the project's repository.
//!
//! - `buzz launchpad brain init --dir <checkout>` writes `AGENTS.md`, `facts.md`, `voice.md`, `decisions.md` and
//!   `playbooks/README.md` into the checkout. It refuses when any of them is already there and writes nothing then: it
//!   never overwrites, and never leaves half a brain behind.
//! - `buzz launchpad brain check --dir <checkout>` reads the brain's files and refuses any that look like they hold a
//!   key or a password, which must never sit in a repository (it may be public).
//! - `buzz launchpad brain skill --dir <checkout> --recording <notes> --job <name>` (step B4, in
//!   `launchpad_brain_skill.rs`) drafts `playbooks/<name>.md` from a recorded run written as text.
//!
//! Both are local: no server, no key. Where the repository lives and who can read it is a channel question (see the
//! milestone 8 report): an unbound repository is unreadable by everyone, its author included.

use std::path::{Path, PathBuf};

use clap::Subcommand;
use serde_json::json;

use super::launchpad_brain_skill as skill;
use crate::error::CliError;

/// The JSON name of every brain command's output.
const SCHEMA: &str = "creaton.brain.v1";

/// The five files, by path inside the checkout, with the words each starts as.
pub(crate) const BRAIN_FILES: [(&str, &str); 5] = [
    ("AGENTS.md", include_str!("brain/AGENTS.md")),
    ("facts.md", include_str!("brain/facts.md")),
    ("voice.md", include_str!("brain/voice.md")),
    ("decisions.md", include_str!("brain/decisions.md")),
    (
        "playbooks/README.md",
        include_str!("brain/playbooks/README.md"),
    ),
];

/// Said once, beside the files written: the repository may be public.
const PUBLIC_NOTE: &str =
    "Nothing in these files is private if the repository is public. Never put a key, a password \
or personal data in them; `buzz launchpad brain check` looks for keys.";

/// The most bytes of one brain file `check` reads.
const MAX_FILE_BYTES: u64 = 1 << 20;
/// The most playbook files `check` reads.
pub(crate) const MAX_PLAYBOOKS: usize = 200;

/// The project brain: plain files agents read first
#[derive(Subcommand)]
pub enum BrainCmd {
    /// Write the five brain files into a project's repository checkout. Refuses if any is already there.
    Init {
        /// The checkout to write into (a directory that exists)
        #[arg(long)]
        dir: PathBuf,
    },
    /// Refuse brain files that look like they hold a key or a password
    Check {
        /// The checkout to read
        #[arg(long)]
        dir: PathBuf,
    },
    /// Draft one playbook (`playbooks/<job>.md`) from notes or a transcript of a job done once. Not yet tried by real
    /// founders
    #[command(
        after_help = "The recording is a text file you write or paste: a transcript or notes of doing one job once while saying what you do. Put it under headings: the ones that name a section (When to use it, Steps, Checks, Mistakes to avoid) are copied into that section word for word; any other heading goes under \"Not sorted yet\" for you to place; a section the notes did not cover is left empty and listed. There is no AI service in this command and nothing is sent anywhere: no audio is read and no recording is uploaded. Without --save the draft is only printed, so you can read it first; with --save it is written as a new file and never over an existing one. A recording that looks like it holds a key or a password is refused. One recording, one job, one file. Not yet tried by real founders.\n\nExample:\n  buzz launchpad brain skill --dir ./brain --recording ./notes.md --job order-samples\n  buzz launchpad brain skill --dir ./brain --recording ./notes.md --job order-samples --save"
    )]
    Skill {
        /// The project's repository checkout holding the brain
        #[arg(long)]
        dir: PathBuf,
        /// The notes or transcript, a text file
        #[arg(long)]
        recording: PathBuf,
        /// The job's name: lower-case words joined by hyphens, like order-samples
        #[arg(long)]
        job: String,
        /// Who adds it (written in the file). Default: the founder
        #[arg(long, default_value = "the founder")]
        by: String,
        /// Write the playbook. Without it the draft is only printed
        #[arg(long)]
        save: bool,
    },
}

pub fn dispatch(cmd: &BrainCmd) -> Result<(), CliError> {
    match cmd {
        BrainCmd::Init { dir } => {
            let written = init(dir)?;
            eprintln!("{PUBLIC_NOTE}");
            println!(
                "{}",
                json!({ "schema": SCHEMA, "written": written, "note": PUBLIC_NOTE })
            );
            Ok(())
        }
        BrainCmd::Skill {
            dir,
            recording,
            job,
            by,
            save,
        } => {
            let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
            let outcome = skill::run(dir, recording, job, by, &today, *save)?;
            let (json, words) = skill::report(&outcome, SCHEMA);
            eprintln!("{}\n", outcome.draft.text);
            for left in &outcome.draft.left_for_founder {
                eprintln!("Left for you: {left}");
            }
            eprintln!("{words}");
            println!("{json}");
            Ok(())
        }
        BrainCmd::Check { dir } => {
            let read = check(dir)?;
            println!(
                "{}",
                json!({ "schema": SCHEMA, "checked": read, "keys_found": [] })
            );
            Ok(())
        }
    }
}

/// Write the five files into `dir`. Every target is checked before anything is written: one that exists refuses the
/// whole scaffold, and nothing is written. A write that fails part-way takes back what this call wrote, so a failure
/// never leaves half a brain. Returns the paths written, in order.
pub(crate) fn init(dir: &Path) -> Result<Vec<String>, CliError> {
    if !dir.is_dir() {
        return Err(CliError::Usage(format!(
            "{} is not a directory: give the project's repository checkout",
            dir.display()
        )));
    }
    let there: Vec<&str> = BRAIN_FILES
        .iter()
        .map(|(path, _)| *path)
        .filter(|path| dir.join(path).symlink_metadata().is_ok())
        .collect();
    if !there.is_empty() {
        return Err(CliError::Conflict(format!(
            "the brain is already here ({}); nothing was written, and nothing is ever overwritten",
            there.join(", ")
        )));
    }
    let mut written: Vec<String> = Vec::new();
    let mut made_dirs: Vec<PathBuf> = Vec::new();
    if let Err(error) = write_all(dir, &mut written, &mut made_dirs) {
        // Best effort, and only this call's own files: `create_new` means each one was made here.
        for path in &written {
            let _ = std::fs::remove_file(dir.join(path));
        }
        for made in made_dirs.iter().rev() {
            let _ = std::fs::remove_dir(made);
        }
        return Err(error);
    }
    Ok(written)
}

/// The writes of [`init`], recording each file and each folder it made so the caller can take them back.
fn write_all(
    dir: &Path,
    written: &mut Vec<String>,
    made_dirs: &mut Vec<PathBuf>,
) -> Result<(), CliError> {
    for (path, words) in BRAIN_FILES {
        let target = dir.join(path);
        if let Some(parent) = target.parent().filter(|p| !p.exists()) {
            std::fs::create_dir_all(parent).map_err(|e| {
                CliError::Other(format!("could not make {}: {e}", parent.display()))
            })?;
            made_dirs.push(parent.to_path_buf());
        }
        // `create_new`: a file that appeared since the check above is never overwritten either.
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|e| CliError::Other(format!("could not write {}: {e}", target.display())))?;
        written.push(path.to_string());
        std::io::Write::write_all(&mut file, words.as_bytes())
            .map_err(|e| CliError::Other(format!("could not write {}: {e}", target.display())))?;
    }
    Ok(())
}

/// The brain's files in `dir`: the five, and every `.md` in `playbooks/` (at most [`MAX_PLAYBOOKS`]). A link is listed
/// too, so that [`check`] can refuse it.
fn brain_paths(dir: &Path) -> Result<Vec<PathBuf>, CliError> {
    let present = |path: &Path| {
        path.symlink_metadata()
            .is_ok_and(|m| m.is_file() || m.file_type().is_symlink())
    };
    let mut paths: Vec<PathBuf> = BRAIN_FILES
        .iter()
        .map(|(path, _)| dir.join(path))
        .filter(|path| present(path))
        .collect();
    let playbooks = dir.join("playbooks");
    if playbooks
        .symlink_metadata()
        .is_ok_and(|m| m.file_type().is_symlink())
    {
        return Err(CliError::Usage(format!(
            "{} is a link: the brain's files must be real files in the repository",
            playbooks.display()
        )));
    }
    if playbooks.is_dir() {
        let mut more: Vec<PathBuf> = std::fs::read_dir(&playbooks)
            .map_err(|e| CliError::Other(format!("could not read {}: {e}", playbooks.display())))?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "md") && !paths.contains(path))
            .collect();
        more.sort();
        more.truncate(MAX_PLAYBOOKS);
        paths.extend(more);
    }
    Ok(paths)
}

/// Read the brain in `dir` and refuse it when any file looks like it holds a key. Returns the paths read.
pub(crate) fn check(dir: &Path) -> Result<Vec<String>, CliError> {
    let mut read = Vec::new();
    let mut found = Vec::new();
    for path in brain_paths(dir)? {
        // A link could point anywhere on this machine (a file of keys, say) and send it to the AI service.
        if path
            .symlink_metadata()
            .is_ok_and(|m| m.file_type().is_symlink())
        {
            return Err(CliError::Usage(format!(
                "{} is a link: the brain's files must be real files in the repository",
                path.display()
            )));
        }
        let size = path.metadata().map(|m| m.len()).unwrap_or(0);
        if size > MAX_FILE_BYTES {
            return Err(CliError::Usage(format!(
                "{} is larger than a brain file should be ({size} bytes)",
                path.display()
            )));
        }
        let words = std::fs::read_to_string(&path)
            .map_err(|e| CliError::Other(format!("could not read {}: {e}", path.display())))?;
        let shown = path
            .strip_prefix(dir)
            .unwrap_or(&path)
            .display()
            .to_string();
        if let Some(what) = looks_like_a_key(&words) {
            found.push(format!("{shown} ({what})"));
        }
        read.push(shown);
    }
    if !found.is_empty() {
        return Err(CliError::Usage(format!(
            "these files look like they hold a key or a password; take it out before committing: {}",
            found.join(", ")
        )));
    }
    Ok(read)
}

/// What in `text` looks like a secret, or `None`: a private key block, a Nostr secret key, a 64-hex-digit key, or a
/// line that sets a password, a secret, a token or an API key.
pub(crate) fn looks_like_a_key(text: &str) -> Option<&'static str> {
    if text.contains("-----BEGIN") && text.contains("PRIVATE KEY") {
        return Some("a private key block");
    }
    for word in text.split(|c: char| !c.is_ascii_alphanumeric() && c != '_' && c != '-') {
        if word.len() >= 59 && word.starts_with("nsec1") {
            return Some("a secret key");
        }
        let hex = word.strip_prefix("0x").unwrap_or(word);
        if hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Some("a 64-digit key");
        }
        if word.len() >= 20 && (word.starts_with("sk_") || word.starts_with("sk-")) {
            return Some("an API key");
        }
    }
    for line in text.lines() {
        let lower = line.to_ascii_lowercase();
        let Some((name, value)) = lower.split_once(['=', ':']) else {
            continue;
        };
        let named = [
            "password",
            "secret",
            "api_key",
            "apikey",
            "token",
            "private_key",
        ]
        .iter()
        .any(|word| {
            name.trim()
                .trim_start_matches(['-', '*', ' '])
                .ends_with(word)
        });
        if named && value.trim().len() >= 8 {
            return Some("a line that sets a secret");
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("brain-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[test]
    fn init_writes_exactly_the_five_files() {
        let dir = scratch();
        let written = init(&dir).expect("init");
        assert_eq!(
            written,
            [
                "AGENTS.md",
                "facts.md",
                "voice.md",
                "decisions.md",
                "playbooks/README.md"
            ]
        );
        let mut on_disk: Vec<String> = Vec::new();
        for entry in walk(&dir) {
            on_disk.push(
                entry
                    .strip_prefix(&dir)
                    .expect("inside")
                    .display()
                    .to_string(),
            );
        }
        on_disk.sort();
        assert_eq!(
            on_disk,
            [
                "AGENTS.md",
                "decisions.md",
                "facts.md",
                "playbooks/README.md",
                "voice.md"
            ]
        );
        for (path, words) in BRAIN_FILES {
            assert_eq!(
                std::fs::read_to_string(dir.join(path)).expect("read"),
                words
            );
        }
        // The templates themselves pass the key check.
        assert_eq!(check(&dir).expect("clean").len(), 5);
        std::fs::remove_dir_all(&dir).expect("clean up");
    }

    fn walk(dir: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        for entry in std::fs::read_dir(dir).expect("read dir").flatten() {
            let path = entry.path();
            if path.is_dir() {
                out.extend(walk(&path));
            } else {
                out.push(path);
            }
        }
        out
    }

    #[test]
    fn a_write_that_fails_part_way_leaves_no_half_a_brain() {
        let dir = scratch();
        // A file where the playbooks folder must go: the four files before it are written, then the folder fails.
        std::fs::write(dir.join("playbooks"), "in the way").expect("write");
        let refused = init(&dir).expect_err("the folder cannot be made");
        assert!(matches!(refused, CliError::Other(_)), "{refused}");
        for (path, _) in BRAIN_FILES {
            if path != "playbooks/README.md" {
                assert!(!dir.join(path).exists(), "{path} was left behind");
            }
        }
        assert_eq!(
            std::fs::read_to_string(dir.join("playbooks")).expect("read"),
            "in the way",
            "what was already there is untouched"
        );
        std::fs::remove_dir_all(&dir).expect("clean up");
    }

    #[cfg(unix)]
    #[test]
    fn a_brain_file_that_is_a_link_is_refused_and_never_read() {
        let dir = scratch();
        init(&dir).expect("init");
        let elsewhere = scratch();
        std::fs::write(elsewhere.join("keys.txt"), "not a brain file").expect("write");
        std::fs::remove_file(dir.join("facts.md")).expect("remove");
        std::os::unix::fs::symlink(elsewhere.join("keys.txt"), dir.join("facts.md")).expect("link");
        let refused = check(&dir).expect_err("a link is refused");
        assert!(refused.to_string().contains("is a link"), "{refused}");
        let refused = crate::commands::launchpad_manager::read_brain(&dir).expect_err("refused");
        assert!(refused.to_string().contains("is a link"), "{refused}");
        // A link to a folder where the playbooks go is refused too.
        std::fs::remove_file(dir.join("facts.md")).expect("remove");
        std::fs::write(dir.join("facts.md"), "ok").expect("write");
        std::fs::remove_dir_all(dir.join("playbooks")).expect("remove");
        std::os::unix::fs::symlink(&elsewhere, dir.join("playbooks")).expect("link");
        assert!(check(&dir)
            .expect_err("refused")
            .to_string()
            .contains("is a link"));
        std::fs::remove_dir_all(&dir).expect("clean up");
        std::fs::remove_dir_all(&elsewhere).expect("clean up");
    }

    #[test]
    fn init_never_overwrites_and_writes_nothing_when_one_file_is_there() {
        let dir = scratch();
        std::fs::create_dir_all(dir.join("playbooks")).expect("dir");
        std::fs::write(dir.join("playbooks/README.md"), "mine").expect("write");
        let refused = init(&dir).expect_err("refused");
        assert!(matches!(refused, CliError::Conflict(_)), "{refused}");
        assert!(refused.to_string().contains("playbooks/README.md"));
        // Nothing else was written, and the founder's file is untouched.
        assert!(!dir.join("AGENTS.md").exists());
        assert_eq!(
            std::fs::read_to_string(dir.join("playbooks/README.md")).expect("read"),
            "mine"
        );
        std::fs::remove_dir_all(&dir).expect("clean up");

        // Twice in a row: the second refuses and changes nothing.
        let dir = scratch();
        init(&dir).expect("first");
        std::fs::write(dir.join("facts.md"), "edited by the founder").expect("edit");
        assert!(matches!(init(&dir), Err(CliError::Conflict(_))));
        assert_eq!(
            std::fs::read_to_string(dir.join("facts.md")).expect("read"),
            "edited by the founder"
        );
        std::fs::remove_dir_all(&dir).expect("clean up");

        assert!(matches!(
            init(Path::new("/no/such/checkout")),
            Err(CliError::Usage(_))
        ));
    }

    #[test]
    fn check_refuses_files_that_look_like_keys_and_passes_plain_ones() {
        for (text, what) in [
            (
                "-----BEGIN OPENSSH PRIVATE KEY-----\nabc",
                "a private key block",
            ),
            (
                &format!("my key nsec1{}", "q".repeat(58)) as &str,
                "a secret key",
            ),
            (&format!("key: 0x{}", "ab".repeat(32)), "a 64-digit key"),
            ("use sk-abcdefghijklmnopqrstuvwx", "an API key"),
            ("- password = hunter2hunter2", "a line that sets a secret"),
            ("API_KEY: abcdefgh12345678", "a line that sets a secret"),
        ] {
            assert_eq!(looks_like_a_key(text), Some(what), "{text}");
        }
        for plain in [
            "We shipped 3 lamps to the night market on 2026-11-02.",
            "Decided: no token sale. Because: counsel first.",
            "The address is 0x00000000000000000000000000000000000000cd.",
            "Words I never use: password, secret.",
        ] {
            assert_eq!(looks_like_a_key(plain), None, "{plain}");
        }
        let dir = scratch();
        init(&dir).expect("init");
        std::fs::write(dir.join("playbooks/deploy.md"), "token = abcdef0123456789").expect("write");
        let refused = check(&dir).expect_err("refused");
        assert!(
            refused.to_string().contains("playbooks/deploy.md"),
            "{refused}"
        );
        std::fs::remove_dir_all(&dir).expect("clean up");
    }
}
