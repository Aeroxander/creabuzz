//! Fixtures shared by this crate's unit tests and by the integration tests.
//!
//! They live in the library rather than in a test module so that
//! `tests/projection.rs` exercises the same production mapping entry points
//! that `main.rs` uses, with no test-only copy of the mapping logic.

use std::collections::BTreeMap;

use crate::source::Issue;
use crate::{map_issue, MappedTask, ProjectionConfig};

/// A 64-character hex public key, for assignee-map fixtures.
pub const SAMPLE_PUBKEY: &str = "953d3bd0e0ec7d4c56ba0f3a1f4e5f6a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4";

/// An issue with the fields every projection run needs.
pub fn issue(id: &str, status: &str) -> Issue {
    Issue {
        id: id.to_string(),
        title: Some(format!("Issue {id}")),
        status: Some(status.to_string()),
        updated_at: Some("2026-09-18T10:00:00Z".to_string()),
        ..Issue::default()
    }
}

/// A config with one company, one channel and one mapped assignee.
pub fn config() -> ProjectionConfig {
    ProjectionConfig {
        company_id: "cmp_1".to_string(),
        channel_id: Some("9c1f0f4a-0000-4000-8000-000000000001".to_string()),
        dashboard_url: Some("https://tasks.example.com".to_string()),
        assignee_map: BTreeMap::new(),
    }
}

/// The mapped row for [`issue`] with id `iss_1`, using [`config`].
pub fn mapped_task() -> MappedTask {
    map_issue(&issue("iss_1", "in_progress"), &config())
}
