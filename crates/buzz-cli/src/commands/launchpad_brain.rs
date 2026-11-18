//! The project brain (docs/MANAGEMENT-LAYER.md section 9, step B1): five plain files every agent on a project reads
//! before any task, kept in the project's repository.
//!
//! - `buzz launchpad brain init --dir <checkout>` writes `AGENTS.md`, `facts.md`, `voice.md`, `decisions.md` and
//!   `playbooks/README.md` into the checkout. It refuses when any of them is already there and writes nothing then: it
//!   never overwrites, and never leaves half a brain behind.
//! - `buzz launchpad brain check --dir <checkout>` reads the brain's files and refuses any that look like they hold a
//!   key or a password, which must never sit in a repository (it may be public).
//!
//! Both are local: no server, no key. Where the repository lives and who can read it is a channel question (see the
//! milestone 8 report): an unbound repository is unreadable by everyone, its author included.

use std::path::{Path, PathBuf};

use clap::Subcommand;
use serde_json::json;

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
const MAX_PLAYBOOKS: usize = 200;

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
/// whole scaffold, and nothing is written. Returns the paths written, in order.
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
    let mut written = Vec::new();
    for (path, words) in BRAIN_FILES {
        let target = dir.join(path);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                CliError::Other(format!("could not make {}: {e}", parent.display()))
            })?;
        }
        // `create_new`: a file that appeared since the check above is never overwritten either.
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|e| CliError::Other(format!("could not write {}: {e}", target.display())))?;
        std::io::Write::write_all(&mut file, words.as_bytes())
            .map_err(|e| CliError::Other(format!("could not write {}: {e}", target.display())))?;
        written.push(path.to_string());
    }
    Ok(written)
}

/// The brain's files in `dir`: the five, and every `.md` in `playbooks/` (at most [`MAX_PLAYBOOKS`]).
fn brain_paths(dir: &Path) -> Result<Vec<PathBuf>, CliError> {
    let mut paths: Vec<PathBuf> = BRAIN_FILES
        .iter()
        .map(|(path, _)| dir.join(path))
        .filter(|path| path.is_file())
        .collect();
    let playbooks = dir.join("playbooks");
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
