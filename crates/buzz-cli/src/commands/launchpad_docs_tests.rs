//! The agent docs stay true: every `buzz …` command written in them parses against the tool's own help.
//!
//! `docs/agents/JOINING.md`, `docs/agents/WORKER-LOOP.md` and `docs/agents/MANAGER-LOOP.md` are what an agent builder
//! copies commands from. A command
//! that was renamed, or a flag that was removed, must fail here instead of staying in the docs. The commands are read
//! out of the fenced blocks, joined across `\` line breaks, split the way a shell splits them, and handed to the real
//! argument parser (placeholders such as `<TASK_ID>` are plain words to it). Every `tasks` subcommand must also be
//! written down somewhere in the docs.

use clap::CommandFactory;

const JOINING: &str = include_str!("../../../../docs/agents/JOINING.md");
const WORKER_LOOP: &str = include_str!("../../../../docs/agents/WORKER-LOOP.md");
const MANAGER_LOOP: &str = include_str!("../../../../docs/agents/MANAGER-LOOP.md");

/// The docs, by name.
const DOCS: [(&str, &str); 3] = [
    ("JOINING.md", JOINING),
    ("WORKER-LOOP.md", WORKER_LOOP),
    ("MANAGER-LOOP.md", MANAGER_LOOP),
];

/// Split one command line the way a shell would: spaces separate words; single quotes, double quotes and `$'…'` group.
fn words(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut word = String::new();
    let mut started = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            ' ' | '\t' => {
                if started {
                    out.push(std::mem::take(&mut word));
                    started = false;
                }
            }
            '$' if chars.peek() == Some(&'\'') => {
                chars.next();
                started = true;
                while let Some(q) = chars.next() {
                    match q {
                        '\'' => break,
                        '\\' if chars.peek() == Some(&'n') => {
                            chars.next();
                            word.push('\n');
                        }
                        other => word.push(other),
                    }
                }
            }
            '\'' => {
                started = true;
                for q in chars.by_ref() {
                    if q == '\'' {
                        break;
                    }
                    word.push(q);
                }
            }
            '"' => {
                started = true;
                while let Some(q) = chars.next() {
                    match q {
                        '"' => break,
                        '\\' => {
                            if let Some(next) = chars.next() {
                                word.push(next);
                            }
                        }
                        other => word.push(other),
                    }
                }
            }
            other => {
                started = true;
                word.push(other);
            }
        }
    }
    if started {
        out.push(word);
    }
    out
}

/// Every command a doc writes in a fenced block: lines that start with `buzz `, with `\` continuations joined.
fn commands(doc: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut in_block = false;
    let mut current: Option<String> = None;
    for line in doc.lines() {
        if line.trim_start().starts_with("```") {
            in_block = !in_block;
            current = None;
            continue;
        }
        if !in_block {
            continue;
        }
        let text = line.trim();
        let mut joined = match current.take() {
            Some(mut so_far) => {
                so_far.push(' ');
                so_far.push_str(text);
                so_far
            }
            None if text.starts_with("buzz ") => text.to_string(),
            None => continue,
        };
        if let Some(without) = joined.strip_suffix('\\') {
            joined = without.trim_end().to_string();
            current = Some(joined);
        } else {
            found.push(joined);
        }
    }
    found
}

/// Inline commands in prose, written between backticks: `` `buzz launchpad tasks next` ``.
fn inline_commands(doc: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut in_block = false;
    for line in doc.lines() {
        if line.trim_start().starts_with("```") {
            in_block = !in_block;
            continue;
        }
        if in_block {
            continue;
        }
        for (index, part) in line.split('`').enumerate() {
            // Odd parts are between backticks.
            if index % 2 == 1 && part.starts_with("buzz ") && !part.contains('…') {
                found.push(part.to_string());
            }
        }
    }
    found
}

fn check(doc_name: &str, command: &str) {
    let mut argv = words(command);
    // Free words in prose (`<project>`, `…`) are placeholders for the parser; "buzz launchpad tasks list <project>"
    // style lines parse as written.
    argv.retain(|w| w != "…");
    if let Err(error) = crate::parse_args(argv.clone()) {
        panic!("{doc_name}: `{command}` does not parse against `buzz --help`: {error}");
    }
}

#[test]
fn every_documented_command_parses_against_the_tools_own_help() {
    let mut count = 0;
    for (name, doc) in DOCS {
        let mut in_doc = 0;
        for command in commands(doc) {
            check(name, &command);
            in_doc += 1;
        }
        // Each doc really does carry its loop: a handful of commands, not an empty scan.
        assert!(in_doc >= 8, "{name}: only {in_doc} commands were read");
        count += in_doc;
    }
    assert!(count >= 40, "only {count} documented commands were read");
}

#[test]
fn commands_written_inside_sentences_parse_too() {
    for (name, doc) in DOCS {
        for command in inline_commands(doc) {
            // A fragment such as `buzz launchpad tasks next` with flags left out still names a real command.
            let argv = words(&command);
            let mut cli = crate::build_command();
            let mut seen = Vec::new();
            for word in argv.iter().skip(1) {
                if word.starts_with('-') || word.starts_with('<') {
                    break;
                }
                match cli.find_subcommand(word).cloned() {
                    Some(sub) => {
                        seen.push(word.clone());
                        cli = sub;
                    }
                    None => break,
                }
            }
            assert!(
                !seen.is_empty(),
                "{name}: `{command}` does not start with a real `buzz` command"
            );
            // Flags in an inline command must exist on the command they follow.
            for word in argv.iter().skip(1 + seen.len()) {
                if let Some(flag) = word.strip_prefix("--") {
                    let flag = flag.split('=').next().unwrap_or(flag);
                    assert!(
                        cli.get_arguments().any(|a| a.get_long() == Some(flag)),
                        "{name}: `{command}`: `{}` has no --{flag}",
                        seen.join(" ")
                    );
                }
            }
        }
    }
}

#[test]
fn every_tasks_subcommand_is_written_down() {
    let tasks = crate::Cli::command()
        .find_subcommand("launchpad")
        .and_then(|launchpad| launchpad.find_subcommand("tasks"))
        .cloned()
        .expect("`buzz launchpad tasks` exists");
    let all = format!("{JOINING}\n{WORKER_LOOP}");
    for sub in tasks.get_subcommands().filter(|s| !s.is_hide_set()) {
        let line = format!("buzz launchpad tasks {}", sub.get_name());
        assert!(
            all.contains(&line),
            "`{line}` is a command of the tool and is not in docs/agents"
        );
    }
}

/// The manager's playbook (docs/MANAGEMENT-LAYER.md section 5): every section says its name, version, owner, review
/// date, what is measured and when to retire it, and every section carries the one loop version the file opens with.
#[test]
fn every_section_of_the_manager_loop_carries_its_six_fields_and_one_version() {
    const FIELDS: [&str; 6] = [
        "- Name: ",
        "- Version: ",
        "- Owner: ",
        "- Review date: ",
        "- Measure: ",
        "- Retire if: ",
    ];
    let mut names = std::collections::BTreeSet::new();
    let mut versions = std::collections::BTreeSet::new();
    let mut sections = 0;
    for section in MANAGER_LOOP.split("\n## ").skip(1) {
        let title = section.lines().next().unwrap_or_default();
        let value = |field: &str| {
            section
                .lines()
                .find_map(|line| line.strip_prefix(field))
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| panic!("MANAGER-LOOP.md: section {title:?} has no `{field}`"))
        };
        for field in FIELDS {
            value(field);
        }
        assert!(
            names.insert(value("- Name: ").to_string()),
            "MANAGER-LOOP.md: the name of section {title:?} is used twice"
        );
        versions.insert(value("- Version: ").to_string());
        let date = value("- Review date: ");
        assert!(
            chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").is_ok(),
            "MANAGER-LOOP.md: section {title:?}: review date {date:?} is not a date (YYYY-MM-DD)"
        );
        sections += 1;
    }
    assert!(sections >= 6, "only {sections} sections were read");
    assert_eq!(versions.len(), 1, "one loop, one version: {versions:?}");
    let version = versions.into_iter().next().unwrap_or_default();
    assert!(
        MANAGER_LOOP.contains(&format!("Loop version: `{version}`")),
        "the file opens with another version than its sections carry ({version})"
    );
}

#[test]
fn every_manager_and_brain_subcommand_is_written_down() {
    let launchpad = crate::Cli::command()
        .find_subcommand("launchpad")
        .cloned()
        .expect("`buzz launchpad` exists");
    for group in ["manager", "brain"] {
        let commands = launchpad
            .find_subcommand(group)
            .unwrap_or_else(|| panic!("`buzz launchpad {group}` exists"));
        for sub in commands.get_subcommands().filter(|s| !s.is_hide_set()) {
            let line = format!("buzz launchpad {group} {}", sub.get_name());
            assert!(
                MANAGER_LOOP.contains(&line),
                "`{line}` is a command of the tool and is not in docs/agents/MANAGER-LOOP.md"
            );
        }
    }
    // The manager has a command that drafts and none that posts, signs or pays.
    let manager: Vec<String> = launchpad
        .find_subcommand("manager")
        .map(|m| {
            m.get_subcommands()
                .map(|s| s.get_name().to_string())
                .collect()
        })
        .unwrap_or_default();
    assert_eq!(manager, ["draft"]);
}

#[test]
fn the_reader_of_this_test_is_not_fooled_by_an_empty_doc() {
    assert!(commands("no blocks here, buzz launchpad tasks open").is_empty());
    assert_eq!(
        commands("```bash\nbuzz launchpad tasks submit a \\\n  --note x\n```\n"),
        ["buzz launchpad tasks submit a --note x"]
    );
    assert_eq!(
        words("buzz x --note 'a b' $'c\\nd' \"e f\""),
        ["buzz", "x", "--note", "a b", "c\nd", "e f"]
    );
}
