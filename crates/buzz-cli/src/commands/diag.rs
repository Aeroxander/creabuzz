//! `buzz diag` — the Phase 4 instrument's CLI host (OA.md §6 / OAv2 §6).
//!
//! Fetches a bounded window of the community's signed events across the
//! coordination plane (governance records, receipts, contribution records,
//! grants/revocations, approval requests, wiki revisions, tombstones, done
//! tasks, channel messages) and runs [`buzz_core::org_diag::diagnose`] over
//! them. The mapping from wire events to [`DiagEvent`]s is deliberately
//! conservative: unknown kinds and unparseable rows become `Other`/dropped,
//! never guessed into a class. Host decision recorded in OAv2 open-decision
//! 5: the instrument is a **CLI twin of a workflow action** — this command
//! (human-run, recomputable) with the relay-side scheduled host to follow.

use crate::{BuzzClient, CliError};
use buzz_core::org_diag::{class_of_kind, diagnose, DiagEvent, MIN_EVENTS};

/// The kinds the instrument reasons over (the coordination plane).
const DIAG_KINDS: [u32; 10] = [
    47004, 47005, 37013, 37011, 46010, 44001, 44002, 5, 44011, 40002,
];

fn tag_value<'a>(tags: &'a [serde_json::Value], name: &str) -> Option<&'a str> {
    tags.iter().find_map(|tag| {
        let parts = tag.as_array()?;
        if parts.first().and_then(|p| p.as_str()) == Some(name) {
            parts.get(1).and_then(|p| p.as_str())
        } else {
            None
        }
    })
}

pub async fn cmd_diag(client: &BuzzClient, limit: Option<u32>) -> Result<(), CliError> {
    let bound = limit.unwrap_or(500).min(2_000);
    let filter = serde_json::json!({ "kinds": DIAG_KINDS.to_vec() });
    let rows = client.query_all_bounded(filter, bound).await?;

    let mut events: Vec<DiagEvent> = Vec::new();
    let mut dropped = 0usize;
    for row in &rows {
        let (Some(kind), Some(at), Some(actor), Some(id)) = (
            row.get("kind").and_then(|v| v.as_u64()),
            row.get("created_at").and_then(|v| v.as_u64()),
            row.get("pubkey").and_then(|v| v.as_str()),
            row.get("id").and_then(|v| v.as_str()),
        ) else {
            dropped += 1;
            continue;
        };
        let tags: &[serde_json::Value] = row
            .get("tags")
            .and_then(|v| v.as_array())
            .map(|v| v.as_slice())
            .unwrap_or(&[]);
        // The receipt/grant tables refine 47005/37011 into vote/execute/
        // revoke — absent or unknown tables stay at the conservative default.
        let table = tag_value(tags, "kind");
        events.push(DiagEvent {
            id: id.to_string(),
            actor: actor.to_string(),
            at,
            class: class_of_kind(kind as u32, table),
            coordinate: tag_value(tags, "d").map(|d| d.to_string()),
        });
    }

    let report = diagnose(&events);
    let json = serde_json::to_string_pretty(&report).map_err(|e| CliError::Other(e.to_string()))?;
    println!("{json}");
    if !events.is_empty() && dropped > 0 {
        eprintln!("note: {dropped} row(s) unparseable — dropped, never guessed");
    }
    if events.len() < MIN_EVENTS {
        eprintln!(
            "note: {} event(s) is under the {} minimum — instruments report \"insufficient\" (omitted), never zeroed scores",
            events.len(),
            MIN_EVENTS
        );
    }
    Ok(())
}
