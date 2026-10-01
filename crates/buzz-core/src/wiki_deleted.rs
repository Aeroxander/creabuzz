//! The `include_deleted` REQ-filter extension — "Recently deleted" wiki pages.
//!
//! Tombstoned wiki rows are hidden from every ordinary read (`deleted_at IS
//! NULL` is pushed into SQL), but their content is deliberately preserved on
//! tombstone so an authorized editor can restore the page by republishing a
//! revision. The "Recently deleted" UI lists those tombstones, so a query
//! filter may opt in with `"include_deleted": true` — accepted only on
//! wiki-page queries, exactly the strict-extension pattern of
//! [`crate::thread_window`]: an unknown or unusable constraint fails closed
//! rather than silently describing different rows from the ones the caller
//! requested.

use serde_json::Value;

use crate::kind::{KIND_AGENT_WIKI_PAGE, KIND_WIKI_PAGE};

/// The wiki page kinds whose tombstoned rows `include_deleted` may surface.
/// Purged rows of these kinds are content-stripped shells; they are listed
/// too (the slug is what the UI shows) and restore the same way.
pub const WIKI_PAGE_KINDS: [u32; 2] = [KIND_WIKI_PAGE, KIND_AGENT_WIKI_PAGE];

/// Parse the `include_deleted` extension from one raw query filter.
///
/// Returns `Ok(true)` only for an explicitly opted-in wiki-page filter: the
/// field must be the literal `true` when present and every kind the filter
/// selects must be a wiki page kind (44001/44002). Anything else is a
/// deterministic client mistake and fails closed with a stable error message.
/// Absent field → `Ok(false)`; the query then behaves exactly as before.
pub fn parse(raw: &Value) -> Result<bool, String> {
    match raw.get("include_deleted") {
        None => return Ok(false),
        Some(Value::Bool(true)) => {}
        Some(_) => return Err("include_deleted must be true".into()),
    }
    let wiki_only = raw
        .get("kinds")
        .and_then(Value::as_array)
        .filter(|kinds| !kinds.is_empty())
        .is_some_and(|kinds| {
            kinds.iter().all(|k| {
                k.as_u64()
                    .and_then(|n| u32::try_from(n).ok())
                    .is_some_and(|n| WIKI_PAGE_KINDS.contains(&n))
            })
        });
    if !wiki_only {
        return Err(
            "include_deleted is only supported on wiki page queries (kinds 44001/44002)".into(),
        );
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn absent_flag_is_a_plain_query() {
        assert_eq!(parse(&json!({"kinds": [44001]})), Ok(false));
        assert_eq!(parse(&json!({})), Ok(false));
    }

    #[test]
    fn wiki_page_kinds_opt_in() {
        assert_eq!(parse(&json!({"kinds": [44001], "include_deleted": true})), Ok(true));
        assert_eq!(parse(&json!({"kinds": [44002], "include_deleted": true})), Ok(true));
        assert_eq!(
            parse(&json!({"kinds": [44001, 44002], "include_deleted": true})),
            Ok(true)
        );
    }

    #[test]
    fn non_wiki_or_mixed_kinds_fail_closed() {
        assert_eq!(
            parse(&json!({"kinds": [9], "include_deleted": true})),
            Err("include_deleted is only supported on wiki page queries (kinds 44001/44002)".into())
        );
        assert_eq!(
            parse(&json!({"kinds": [44001, 9], "include_deleted": true})),
            Err("include_deleted is only supported on wiki page queries (kinds 44001/44002)".into())
        );
        assert_eq!(
            parse(&json!({"kinds": [], "include_deleted": true})),
            Err("include_deleted is only supported on wiki page queries (kinds 44001/44002)".into())
        );
        assert_eq!(
            parse(&json!({"include_deleted": true})),
            Err("include_deleted is only supported on wiki page queries (kinds 44001/44002)".into())
        );
    }

    #[test]
    fn non_boolean_flag_fails_closed() {
        assert_eq!(
            parse(&json!({"kinds": [44001], "include_deleted": false})),
            Err("include_deleted must be true".into())
        );
        assert_eq!(
            parse(&json!({"kinds": [44001], "include_deleted": "yes"})),
            Err("include_deleted must be true".into())
        );
    }
}
