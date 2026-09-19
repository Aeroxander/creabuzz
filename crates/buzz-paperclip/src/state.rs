//! Durable projection state: what we already published, and how far we read.
//!
//! The state file is the difference between an idempotent projection and a
//! relay full of duplicate task rows. Three rules follow from that:
//!
//! * A corrupt or unreadable state file is a hard error, never a silent reset.
//!   Treating it as empty would republish every issue (see the repository's
//!   rule against converting a failure into an authoritative empty result).
//! * Saving is atomic: write a sibling temporary file, then rename over the
//!   target, so a crash cannot leave a half-written state file behind.
//! * The cursor is a **wall-clock scan start**, not the maximum `updatedAt`
//!   seen. Paperclip's `updatedSince` filter compares `updated_at`, while the
//!   list order uses a different expression, so a cursor advanced to a page's
//!   maximum `updatedAt` silently drops every issue sharing that timestamp
//!   across a page boundary. A clock cursor plus an overlap re-reads a little
//!   and loses nothing.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::BridgeError;

/// Current on-disk schema version.
pub const STATE_SCHEMA_VERSION: u32 = 1;

/// Seconds subtracted from the stored scan start when building the next
/// incremental cursor. Covers clock skew, in-flight writes and the
/// filter-column/sort-column mismatch described above.
pub const DEFAULT_OVERLAP_SECONDS: u64 = 120;

/// What we recorded for one issue after a successful publish.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueState {
    /// SHA-256 of the mapped content plus the tags that affect rendering.
    pub hash: String,
    /// Mapped Buzz status at the time of the last publish.
    pub status: String,
    /// Event id returned by the relay, when it reported one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_id: Option<String>,
}

/// The link between a Buzz task row and the Paperclip issue it became.
///
/// This is what keeps the two directions from producing two rows for one task:
/// once a Buzz-authored row has been turned into a Paperclip issue, the
/// projection owns that `d` tag and republishes it from Paperclip's state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuzzTaskBinding {
    /// Paperclip issue id this Buzz task row was created from.
    pub paperclip_issue_id: String,
    /// Buzz status last applied to Paperclip.
    pub last_status: String,
}

/// The projection's durable cursor and per-issue publish record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncState {
    /// On-disk schema version; a mismatch is an error, not a migration.
    pub schema_version: u32,
    /// Wall-clock start of the last fully successful scan.
    ///
    /// The next run subtracts [`SyncState::overlap_seconds`] from this to form
    /// its incremental cursor.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_scan_started_at: Option<String>,
    /// Overlap applied to the cursor, in seconds.
    #[serde(default = "default_overlap_seconds")]
    pub overlap_seconds: u64,
    /// Per-issue records keyed by the task `d` tag.
    #[serde(default)]
    pub issues: BTreeMap<String, IssueState>,
    /// Buzz-authored tasks already turned into Paperclip issues, keyed by the
    /// task `d` tag.
    #[serde(default)]
    pub buzz_tasks: BTreeMap<String, BuzzTaskBinding>,
}

fn default_overlap_seconds() -> u64 {
    DEFAULT_OVERLAP_SECONDS
}

impl Default for SyncState {
    fn default() -> Self {
        Self {
            schema_version: STATE_SCHEMA_VERSION,
            last_scan_started_at: None,
            overlap_seconds: DEFAULT_OVERLAP_SECONDS,
            issues: BTreeMap::new(),
            buzz_tasks: BTreeMap::new(),
        }
    }
}

impl SyncState {
    /// An empty state for a first run.
    pub fn new() -> Self {
        Self::default()
    }

    /// Load state from `path`, returning an empty state only when the file does
    /// not exist yet. Any other failure is an error.
    pub fn load(path: &Path) -> Result<Self, BridgeError> {
        let text = match std::fs::read_to_string(path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Self::new()),
            Err(error) => {
                return Err(BridgeError::State(format!(
                    "cannot read state file {}: {error}",
                    path.display()
                )))
            }
        };
        let state: Self = serde_json::from_str(&text).map_err(|error| {
            BridgeError::State(format!(
                "state file {} is not valid JSON ({error}); refusing to treat it as empty because \
                 that would republish every issue",
                path.display()
            ))
        })?;
        if state.schema_version != STATE_SCHEMA_VERSION {
            return Err(BridgeError::State(format!(
                "state file {} has schemaVersion {} but this build writes {}",
                path.display(),
                state.schema_version,
                STATE_SCHEMA_VERSION
            )));
        }
        Ok(state)
    }

    /// Persist state atomically: temporary sibling file, then rename.
    pub fn save(&self, path: &Path) -> Result<(), BridgeError> {
        let serialized = serde_json::to_string_pretty(self)
            .map_err(|error| BridgeError::State(format!("cannot serialize state: {error}")))?;
        write_atomic(path, &serialized)
    }

    /// Record the Paperclip issue a Buzz-authored task became.
    pub fn bind_buzz_task(&mut self, d: &str, paperclip_issue_id: &str, status: &str) {
        self.buzz_tasks.insert(
            d.to_string(),
            BuzzTaskBinding {
                paperclip_issue_id: paperclip_issue_id.to_string(),
                last_status: status.to_string(),
            },
        );
    }

    /// Record a successful publish for `d`.
    pub fn record(&mut self, d: &str, hash: &str, status: &str, event_id: Option<String>) {
        self.issues.insert(
            d.to_string(),
            IssueState {
                hash: hash.to_string(),
                status: status.to_string(),
                event_id,
            },
        );
    }
}

/// Write `contents` to `path` via a temporary sibling and an atomic rename.
///
/// The file holds API keys and task bindings, so on unix it is written with
/// mode 0600; the rename replaces any pre-existing (possibly wider) file with
/// the 0600 sibling. Windows has no POSIX file modes — this codebase targets
/// unix/mac, and there the platform's default ACLs apply.
pub fn write_atomic(path: &Path, contents: &str) -> Result<(), BridgeError> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent).map_err(|error| {
            BridgeError::State(format!("cannot create {}: {error}", parent.display()))
        })?;
    }
    let temporary = temporary_path(path);
    write_private(&temporary, contents).map_err(|error| {
        BridgeError::State(format!("cannot write {}: {error}", temporary.display()))
    })?;
    std::fs::rename(&temporary, path).map_err(|error| {
        let _ = std::fs::remove_file(&temporary);
        BridgeError::State(format!("cannot replace {}: {error}", path.display()))
    })
}

/// Write `contents` to `path`, mode 0600 on unix.
fn write_private(path: &Path, contents: &str) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write as _;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        file.write_all(contents.as_bytes())
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        std::fs::write(path, contents)
    }
}

fn temporary_path(path: &Path) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(format!(".tmp-{}", std::process::id()));
    path.with_file_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_state() -> SyncState {
        let mut state = SyncState::new();
        state.last_scan_started_at = Some("2026-09-18T00:00:00Z".to_string());
        state.record("paperclip:iss_1", "abc", "open", Some("evt_1".to_string()));
        state
    }

    #[test]
    fn round_trips_through_disk() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("state.json");
        let state = sample_state();
        state.save(&path).expect("state saves");
        let loaded = SyncState::load(&path).expect("state loads");
        assert_eq!(loaded, state);
    }

    #[test]
    fn a_missing_file_is_an_empty_state() {
        let dir = tempfile::tempdir().expect("temp dir");
        let loaded = SyncState::load(&dir.path().join("absent.json")).expect("missing is empty");
        assert_eq!(loaded, SyncState::new());
    }

    #[test]
    fn a_corrupt_file_is_an_error_not_a_reset() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("state.json");
        std::fs::write(&path, "{ this is not json").expect("write");
        let error = SyncState::load(&path).expect_err("corrupt state must fail loudly");
        assert!(matches!(error, BridgeError::State(_)));
    }

    #[test]
    fn an_unknown_schema_version_is_an_error() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("state.json");
        std::fs::write(&path, r#"{"schemaVersion":99,"issues":{}}"#).expect("write");
        let error = SyncState::load(&path).expect_err("future schema must fail loudly");
        assert!(format!("{error}").contains("schemaVersion 99"));
    }

    #[test]
    fn a_state_without_an_overlap_gets_the_default() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("state.json");
        std::fs::write(
            &path,
            r#"{"schemaVersion":1,"lastScanStartedAt":"2026-09-18T00:00:00Z","issues":{}}"#,
        )
        .expect("write");
        let loaded = SyncState::load(&path).expect("loads");
        assert_eq!(loaded.overlap_seconds, DEFAULT_OVERLAP_SECONDS);
    }

    #[test]
    fn a_buzz_task_binding_round_trips() {
        let mut state = SyncState::new();
        state.bind_buzz_task("open:t1", "iss_9", "todo");
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("state.json");
        state.save(&path).expect("saves");
        let loaded = SyncState::load(&path).expect("loads");
        let binding = loaded.buzz_tasks.get("open:t1").expect("binding survives");
        assert_eq!(binding.paperclip_issue_id, "iss_9");
        assert_eq!(binding.last_status, "todo");
    }

    #[cfg(unix)]
    #[test]
    fn the_state_file_is_written_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("state.json");
        sample_state().save(&path).expect("save");
        let mode = std::fs::metadata(&path)
            .expect("metadata")
            .permissions()
            .mode();
        assert_eq!(
            mode & 0o777,
            0o600,
            "the state file holds keys and bindings; it must not be group/world readable"
        );
    }

    #[test]
    fn saving_leaves_no_temporary_file_behind() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("state.json");
        sample_state().save(&path).expect("save");
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .expect("read dir")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "atomic save left {leftovers:?}");
    }
}
