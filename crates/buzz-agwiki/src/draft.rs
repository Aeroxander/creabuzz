//! Persona drafting loop (B1) — wiki decision blocks → 47004 `agent-draft`
//! proposal records (docs/persona-drafting-loop.md).
//!
//! The second half of the persona's round: the distill loop writes the wiki,
//! this module materializes the wiki's EXPLICIT decision intent as proposal
//! records awaiting a human counter-sign. Pure and deterministic — the
//! composer never synthesizes claims (D1): a draft's text is the block's
//! authored `title` plus its verbatim `evidence` quote, nothing else.
//!
//! Honesty rules enforced here (the production seams the goldens pin):
//! - **D3 verbatim evidence**: `evidence` must appear verbatim in the page
//!   body OUTSIDE decision blocks, or the block is skipped and reported —
//!   the no-invented-facts seam.
//! - **D4 strictly parse or drop**: malformed block structure drops the
//!   block with a reason; a malformed `intent`/`calls` VALUE drops only that
//!   value (the draft stays record-only — NIP-LP §47004's "such a record
//!   carries no executable intent"). A `signal` block carrying an `intent`
//!   key is contradictory and drops the block.
//! - **D6 routing is inherited**: `kind` is the A-series routing map's own
//!   key (`plain` | `futarchy-budget` | `signal`), never defaulted.
//! - **D7 dedupe by wiki anchor**: one live record per
//!   `["wiki", <page-coordinate>, <block-anchor>]`; anchors count every
//!   decision block in document order, including skipped ones, so they stay
//!   stable across runs on unchanged pages.
//! - **D8 provenance is the source pointer**: the draft carries the `wiki`
//!   tag and the verbatim quote — no re-summarized text, no model tag.
//!
//! `intent` parsing is desktop's `parseProposalIntent` rules (shape +
//! argument formats); web enforces the same formats at compose time in
//! `vote-tx.ts`. The canonical content JSON serializes in the NIP-LP schema
//! field order (proposalId, kind, issue, state, title, evidence, intent,
//! calls) — the TS composers build the same order, and the golden vectors in
//! both languages pin the identical strings.

use nostr::{Event, EventBuilder, Tag};
use serde::Serialize;

use buzz_core::kind::{KIND_LAUNCH_PROPOSAL, KIND_WIKI_PAGE};

/// The 47004 state of an agent-composed, not-yet-counter-signed proposal.
pub const AGENT_DRAFT_STATE: &str = "agent-draft";

pub const BLOCK_TITLE_MAX_CHARS: usize = 200;
pub const BLOCK_EVIDENCE_MAX_CHARS: usize = 400;
/// House content cap (the wiki page envelope's bound).
pub const DRAFT_CONTENT_MAX_BYTES: usize = 65_536;

/// A strictly parsed execution intent (majeur's `executeByVotes` input).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StrictIntent {
    pub op: u8,
    pub to: String,
    pub value: String,
    pub data: String,
    pub nonce: String,
}

/// One ERC-4824 `CallDataEVM` entry (NIP-LP §47004 `calls[]`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StrictCall {
    pub operation: String,
    pub from: String,
    pub to: String,
    pub value: String,
    pub data: String,
}

/// One decision block that passed structural + evidence verification.
#[derive(Debug, Clone, PartialEq)]
pub struct DecisionBlock {
    /// 1-based index of the block in the page body (all blocks count,
    /// including skipped ones — anchors stay stable across runs).
    pub anchor: u32,
    pub title: String,
    /// Routing map key: `plain` | `futarchy-budget` | `signal`.
    pub kind: String,
    pub evidence: String,
    /// Strict `intent` value; None when absent or malformed (record-only).
    pub intent: Option<StrictIntent>,
    /// Strict non-empty `calls` value; None when absent, empty or malformed.
    pub calls: Option<Vec<StrictCall>>,
}

/// A block the composer cannot render honestly — skipped, never repaired.
#[derive(Debug, Clone, PartialEq)]
pub struct SkippedBlock {
    pub anchor: u32,
    pub reason: String,
}

/// A composed draft: canonical content JSON plus its routing identity.
#[derive(Debug, Clone, PartialEq)]
pub struct DraftProposal {
    pub anchor: u32,
    pub title: String,
    pub kind: String,
    /// Canonical content JSON (fixed NIP-LP field order).
    pub content: String,
}

/// Everything one page body yields: drafts to land, blocks skipped.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct PageDrafts {
    pub drafts: Vec<DraftProposal>,
    pub skipped: Vec<SkippedBlock>,
}

// ── Block parsing (the front-matter parser family: flat `key: value` lines,
//    first occurrence wins — deliberately NOT a YAML implementation; no
//    inline-comment stripping here, unlike front-matter: `evidence` is a
//    verbatim quote and a `#` in it must survive) ───────────────────────────

/// Raw parsed block: anchor + ordered fields (first occurrence wins).
#[derive(Debug, Clone, PartialEq)]
pub struct RawBlock {
    pub anchor: u32,
    pub fields: Vec<(String, String)>,
}

impl RawBlock {
    pub fn get(&self, key: &str) -> Option<&str> {
        self.fields
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }

    pub fn has(&self, key: &str) -> bool {
        self.fields.iter().any(|(k, _)| k == key)
    }
}

fn parse_field_line(line: &str) -> Option<(String, String)> {
    let colon = line.find(':')?;
    if colon == 0 {
        return None;
    }
    let key = line[..colon].trim();
    if key.is_empty() {
        return None;
    }
    let value = line[colon + 1..].trim();
    Some((key.to_string(), value.to_string()))
}

fn is_open_fence(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed
        .strip_prefix("```decision")
        .map(|rest| rest.trim().is_empty())
        .unwrap_or(false)
}

fn is_close_fence(line: &str) -> bool {
    line.trim() == "```"
}

/// Parse every fenced `decision` block in a page body.
///
/// A block without a closing fence is skipped (unterminated — never
/// half-parsed). Anchors count every block in document order. Field lines
/// without a colon are ignored; the first occurrence of a key wins.
pub fn parse_decision_blocks(body: &str) -> (Vec<RawBlock>, Vec<SkippedBlock>) {
    let mut blocks: Vec<RawBlock> = Vec::new();
    let mut skipped: Vec<SkippedBlock> = Vec::new();
    let mut anchor: u32 = 0;
    let mut current: Option<RawBlock> = None;
    for line in body.lines() {
        if current.is_some() {
            if is_close_fence(line) {
                blocks.push(current.take().expect("checked above"));
            } else if let Some(field) = parse_field_line(line) {
                let block = current.as_mut().expect("checked above");
                if !block.fields.iter().any(|(k, _)| *k == field.0) {
                    block.fields.push(field);
                }
            }
        } else if is_open_fence(line) {
            anchor += 1;
            current = Some(RawBlock {
                anchor,
                fields: Vec::new(),
            });
        }
    }
    if let Some(block) = current {
        skipped.push(SkippedBlock {
            anchor: block.anchor,
            reason: "unterminated decision block (no closing fence)".to_string(),
        });
    }
    (blocks, skipped)
}

/// The page body with every fenced decision block removed (complete blocks
/// entirely; an unterminated block removes its opener to the end). This is
/// the surface the D3 verbatim-evidence rule checks against: evidence must
/// come from the page's prose, not from another block.
pub fn body_without_decision_blocks(body: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    let mut in_block = false;
    for line in body.lines() {
        if in_block {
            if is_close_fence(line) {
                in_block = false;
            }
            continue;
        }
        if is_open_fence(line) {
            in_block = true;
            continue;
        }
        out.push(line);
    }
    out.join("\n")
}

// ── Strict value parsers (desktop's parseProposalIntent rules) ─────────────

fn is_address(value: &str) -> bool {
    value.strip_prefix("0x").is_some_and(|hex| {
        hex.len() == 40 && hex.bytes().all(|b| b.is_ascii_hexdigit())
    })
}

fn is_bytes32(value: &str) -> bool {
    value.strip_prefix("0x").is_some_and(|hex| {
        hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit())
    })
}

fn is_data(value: &str) -> bool {
    value.strip_prefix("0x").is_some_and(|hex| {
        hex.len() % 2 == 0 && hex.bytes().all(|b| b.is_ascii_hexdigit())
    })
}

fn is_decimal(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit())
}

/// Strict `ProposalIntent` parse: shape + argument formats. Anything
/// malformed returns None — a block without a valid intent stays record-only
/// (never guessed at).
pub fn parse_strict_intent(value: &serde_json::Value) -> Option<StrictIntent> {
    let raw = value.as_object()?;
    let op = raw.get("op")?.as_u64()?;
    if op > 1 {
        return None;
    }
    let to = raw.get("to")?.as_str()?;
    let value_field = raw.get("value")?.as_str()?;
    let data = raw.get("data")?.as_str()?;
    let nonce = raw.get("nonce")?.as_str()?;
    if !is_address(to) || !is_decimal(value_field) || !is_data(data) || !is_bytes32(nonce) {
        return None;
    }
    Some(StrictIntent {
        op: op as u8,
        to: to.to_string(),
        value: value_field.to_string(),
        data: data.to_string(),
        nonce: nonce.to_string(),
    })
}

/// Strict `calls[]` parse (web's `parseProposalCalls` rules): every entry is
/// an object with `operation` ∈ {call, delegatecall} and string
/// from/to/value/data; an empty or malformed array is None (record-only).
pub fn parse_strict_calls(value: &serde_json::Value) -> Option<Vec<StrictCall>> {
    let raw = value.as_array()?;
    let mut out: Vec<StrictCall> = Vec::new();
    for entry in raw {
        let e = entry.as_object()?;
        let operation = e.get("operation")?.as_str()?;
        if operation != "call" && operation != "delegatecall" {
            return None;
        }
        let from = e.get("from")?.as_str()?;
        let to = e.get("to")?.as_str()?;
        let value_field = e.get("value")?.as_str()?;
        let data = e.get("data")?.as_str()?;
        out.push(StrictCall {
            operation: operation.to_string(),
            from: from.to_string(),
            to: to.to_string(),
            value: value_field.to_string(),
            data: data.to_string(),
        });
    }
    if out.is_empty() {
        return None;
    }
    Some(out)
}

// ── Structural validation + composition ────────────────────────────────────

fn char_count(s: &str) -> usize {
    s.chars().count()
}

fn validate_block(raw: &RawBlock, prose: &str) -> Result<DecisionBlock, String> {
    let title = raw
        .get("title")
        .filter(|t| !t.is_empty())
        .ok_or("missing `title`")?;
    if char_count(title) > BLOCK_TITLE_MAX_CHARS {
        return Err(format!("`title` exceeds {BLOCK_TITLE_MAX_CHARS} chars"));
    }
    let kind = raw.get("kind").ok_or("missing `kind`")?;
    if kind != "plain" && kind != "futarchy-budget" && kind != "signal" {
        return Err(format!("unknown `kind` {kind:?} (routing map keys only)"));
    }
    let evidence = raw
        .get("evidence")
        .filter(|e| !e.is_empty())
        .ok_or("missing `evidence`")?;
    if char_count(evidence) > BLOCK_EVIDENCE_MAX_CHARS {
        return Err(format!(
            "`evidence` exceeds {BLOCK_EVIDENCE_MAX_CHARS} chars"
        ));
    }
    if kind == "signal" && raw.has("intent") {
        return Err("contradictory block: `signal` carries an `intent`".to_string());
    }
    // D3 — the verbatim evidence rule (the no-invented-facts seam).
    if !prose.contains(evidence) {
        return Err(
            "non-verbatim `evidence` (must appear in the page body outside decision blocks)"
                .to_string(),
        );
    }

    let intent = raw
        .get("intent")
        .and_then(|v| parse_strict_intent(&serde_json::from_str::<serde_json::Value>(v).ok()?));
    let calls = raw
        .get("calls")
        .and_then(|v| parse_strict_calls(&serde_json::from_str::<serde_json::Value>(v).ok()?));
    Ok(DecisionBlock {
        anchor: raw.anchor,
        title: title.to_string(),
        kind: kind.to_string(),
        evidence: evidence.to_string(),
        intent,
        calls,
    })
}

/// Canonical content JSON: NIP-LP schema field order. `intent`/`calls` are
/// omitted when absent (empty means omitted, never nulled).
#[derive(Serialize)]
struct DraftContent<'a> {
    #[serde(rename = "proposalId")]
    proposal_id: Option<&'a str>,
    kind: &'a str,
    issue: Option<&'a str>,
    state: &'a str,
    title: &'a str,
    evidence: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    intent: Option<&'a StrictIntent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    calls: Option<&'a [StrictCall]>,
}

fn compose_content(block: &DecisionBlock) -> String {
    let content = DraftContent {
        proposal_id: None,
        kind: &block.kind,
        issue: None,
        state: AGENT_DRAFT_STATE,
        title: &block.title,
        evidence: &block.evidence,
        intent: block.intent.as_ref(),
        calls: block.calls.as_deref(),
    };
    serde_json::to_string(&content).expect("serializable content")
}

/// Compose every honest draft from one page body (D1–D4, D8). Deterministic:
/// document order in, document order out.
pub fn decision_drafts(body: &str) -> PageDrafts {
    let prose = body_without_decision_blocks(body);
    let (raw_blocks, mut skipped) = parse_decision_blocks(body);
    let mut drafts: Vec<DraftProposal> = Vec::new();
    for raw in raw_blocks {
        match validate_block(&raw, &prose) {
            Ok(block) => drafts.push(DraftProposal {
                anchor: block.anchor,
                title: block.title.clone(),
                kind: block.kind.clone(),
                content: compose_content(&block),
            }),
            Err(reason) => skipped.push(SkippedBlock {
                anchor: raw.anchor,
                reason,
            }),
        }
    }
    skipped.sort_by_key(|s| s.anchor);
    PageDrafts { drafts, skipped }
}

// ── Event envelope (mirrors build_agent_wiki_builder's self-validation) ────

/// Validate a launch coordinate (`37001:<lowercase-64-hex>:<non-empty id>`),
/// the exact shape the relay's launch-mirror envelope enforces.
pub fn validate_launch_coordinate(coordinate: &str) -> Result<(), String> {
    let parts: Vec<&str> = coordinate.split(':').collect();
    if parts.len() != 3 {
        return Err(format!(
            "launch coordinate must be `37001:<author-hex>:<launch-id>` (got {coordinate:?})"
        ));
    }
    if parts[0] != "37001" {
        return Err(format!(
            "launch coordinate must reference kind 37001 (got {:?})",
            parts[0]
        ));
    }
    let author = parts[1];
    if author.len() != 64
        || !author
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(format!(
            "launch coordinate author must be lowercase 64-hex (got {author:?})"
        ));
    }
    if parts[2].is_empty() {
        return Err("launch coordinate launch id must not be empty".to_string());
    }
    Ok(())
}

/// Validate a wiki page event coordinate (`44001|44002:<lowercase-64-hex>:
/// <non-empty d ≤ 256 bytes>`) — the `wiki` tag's page pointer (D8). The
/// per-kind `d` grammar stays the publishing side's business.
pub fn validate_page_event_coordinate(coordinate: &str) -> Result<(), String> {
    let Some((kind, rest)) = coordinate.split_once(':') else {
        return Err(format!("wiki coordinate must be `<kind>:<hex>:<d>` (got {coordinate:?})"));
    };
    if kind != KIND_WIKI_PAGE.to_string() && kind != super::KIND_AGENT_WIKI.to_string() {
        return Err(format!(
            "wiki coordinate kind must be 44001 or 44002 (got {kind:?})"
        ));
    }
    let Some((author, d)) = rest.split_once(':') else {
        return Err(format!("wiki coordinate must be `<kind>:<hex>:<d>` (got {coordinate:?})"));
    };
    if author.len() != 64
        || !author
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(format!(
            "wiki coordinate author must be lowercase 64-hex (got {author:?})"
        ));
    }
    if d.is_empty() || d.len() > 256 {
        return Err("wiki coordinate d must be 1..=256 bytes".to_string());
    }
    Ok(())
}

/// Build the kind:47004 `agent-draft` event (unsigned): tags `a` = launch
/// coordinate, `wiki` = page coordinate + block anchor (the D7 dedupe key and
/// D8 provenance pointer). Content bounds mirror the house envelopes.
pub fn build_proposal_draft_builder(
    launch: &str,
    page_coordinate: &str,
    draft: &DraftProposal,
) -> Result<EventBuilder, String> {
    validate_launch_coordinate(launch)?;
    validate_page_event_coordinate(page_coordinate)?;
    if draft.title.is_empty() || char_count(&draft.title) > BLOCK_TITLE_MAX_CHARS {
        return Err(format!(
            "draft title must be 1..={BLOCK_TITLE_MAX_CHARS} chars"
        ));
    }
    if draft.content.is_empty() || draft.content.len() > DRAFT_CONTENT_MAX_BYTES {
        return Err(format!(
            "draft content must be non-empty and under {DRAFT_CONTENT_MAX_BYTES} bytes"
        ));
    }
    let tags = vec![
        Tag::parse(["a", launch]).map_err(|e| format!("invalid a tag: {e}"))?,
        Tag::parse(["wiki", page_coordinate, &draft.anchor.to_string()])
            .map_err(|e| format!("invalid wiki tag: {e}"))?,
    ];
    Ok(EventBuilder::new(
        nostr::Kind::Custom(KIND_LAUNCH_PROPOSAL as u16),
        draft.content.clone(),
    )
    .tags(tags))
}

/// Existing live draft anchors (D7): the `wiki` tags of fetched kind:47004
/// records. Malformed tags are dropped, never guessed at.
pub fn existing_anchors(events: &[Event]) -> std::collections::BTreeSet<(String, u32)> {
    let mut out = std::collections::BTreeSet::new();
    for event in events {
        if event.kind != nostr::Kind::Custom(KIND_LAUNCH_PROPOSAL as u16) {
            continue;
        }
        for tag in event.tags.iter() {
            let parts = tag.as_slice();
            if parts.first().map(String::as_str) != Some("wiki") {
                continue;
            }
            let (Some(coordinate), Some(anchor)) = (parts.get(1), parts.get(2)) else {
                continue;
            };
            let Ok(anchor) = anchor.parse::<u32>() else {
                continue;
            };
            out.insert((coordinate.clone(), anchor));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const LAUNCH: &str = "37001:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:nebula-dao";
    const PAGE_COORD: &str = "44002:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:default/standup";

    /// The golden corpus (docs/persona-drafting-loop.md §Test discipline):
    /// four honest blocks (two with intent/calls, one signal, one
    /// record-only), one non-verbatim evidence, one contradictory signal.
    fn corpus() -> String {
        let mut s = String::new();
        s.push_str("## Standup\n\n");
        s.push_str("Quorum is 500 bps today. The round-2 postmortem asks for a 600 bps quorum.\n\n");
        s.push_str("```decision\n");
        s.push_str("title: Raise proposal quorum to 600 bps\n");
        s.push_str("kind: plain\n");
        s.push_str("evidence: The round-2 postmortem asks for a 600 bps quorum.\n");
        s.push_str("intent: {\"op\":0,\"to\":\"0x1111111111111111111111111111111111111111\",\"value\":\"0\",\"data\":\"0x1234\",\"nonce\":\"0x0000000000000000000000000000000000000000000000000000000000000001\"}\n");
        s.push_str("```\n\n");
        s.push_str("Sell pressure is capped at 15% per epoch today.\n\n");
        s.push_str("```decision\n");
        s.push_str("title: Document the sell-rate gate\n");
        s.push_str("kind: plain\n");
        s.push_str("evidence: Sell pressure is capped at 15% per epoch today.\n");
        s.push_str("calls: [{\"operation\":\"call\",\"from\":\"0x0000000000000000000000000000000000000000\",\"to\":\"0x2222222222222222222222222222222222222222\",\"value\":\"0\",\"data\":\"0x\"}]\n");
        s.push_str("```\n\n");
        s.push_str("People keep asking for a weekly standup digest.\n\n");
        s.push_str("```decision\n");
        s.push_str("title: Weekly digest signal\n");
        s.push_str("kind: signal\n");
        s.push_str("evidence: People keep asking for a weekly standup digest.\n");
        s.push_str("```\n\n");
        // Block 4: non-verbatim evidence (the number appears nowhere in prose).
        s.push_str("```decision\n");
        s.push_str("title: Invent a number\n");
        s.push_str("kind: plain\n");
        s.push_str("evidence: The quorum is 999 bps and everyone agrees.\n");
        s.push_str("```\n\n");
        // Block 5: contradictory signal (carries an intent key).
        s.push_str("```decision\n");
        s.push_str("title: Signal with intent\n");
        s.push_str("kind: signal\n");
        s.push_str("evidence: People keep asking for a weekly standup digest.\n");
        s.push_str("intent: {\"op\":0,\"to\":\"0x1111111111111111111111111111111111111111\",\"value\":\"0\",\"data\":\"0x\",\"nonce\":\"0x0000000000000000000000000000000000000000000000000000000000000001\"}\n");
        s.push_str("```\n\n");
        // Block 6: malformed intent value (op 2) — drops to record-only.
        s.push_str("```decision\n");
        s.push_str("title: Record-only proposal\n");
        s.push_str("kind: plain\n");
        s.push_str("evidence: Sell pressure is capped at 15% per epoch today.\n");
        s.push_str("intent: {\"op\":2,\"to\":\"0x1111111111111111111111111111111111111111\",\"value\":\"0\",\"data\":\"0x\",\"nonce\":\"0x0000000000000000000000000000000000000000000000000000000000000001\"}\n");
        s.push_str("```\n");
        s
    }

    // The golden content vectors — pinned identically in web
    // `draft-proposal.test.mjs` and desktop `draftProposal.test.mjs` so the
    // CLI loop and the UI journey can never diverge silently.
    const GOLDEN_1: &str = "{\"proposalId\":null,\"kind\":\"plain\",\"issue\":null,\"state\":\"agent-draft\",\"title\":\"Raise proposal quorum to 600 bps\",\"evidence\":\"The round-2 postmortem asks for a 600 bps quorum.\",\"intent\":{\"op\":0,\"to\":\"0x1111111111111111111111111111111111111111\",\"value\":\"0\",\"data\":\"0x1234\",\"nonce\":\"0x0000000000000000000000000000000000000000000000000000000000000001\"}}";
    const GOLDEN_2: &str = "{\"proposalId\":null,\"kind\":\"plain\",\"issue\":null,\"state\":\"agent-draft\",\"title\":\"Document the sell-rate gate\",\"evidence\":\"Sell pressure is capped at 15% per epoch today.\",\"calls\":[{\"operation\":\"call\",\"from\":\"0x0000000000000000000000000000000000000000\",\"to\":\"0x2222222222222222222222222222222222222222\",\"value\":\"0\",\"data\":\"0x\"}]}";
    const GOLDEN_3: &str = "{\"proposalId\":null,\"kind\":\"signal\",\"issue\":null,\"state\":\"agent-draft\",\"title\":\"Weekly digest signal\",\"evidence\":\"People keep asking for a weekly standup digest.\"}";
    const GOLDEN_6: &str = "{\"proposalId\":null,\"kind\":\"plain\",\"issue\":null,\"state\":\"agent-draft\",\"title\":\"Record-only proposal\",\"evidence\":\"Sell pressure is capped at 15% per epoch today.\"}";

    #[test]
    fn golden_corpus_composes_exact_content() {
        let out = decision_drafts(&corpus());
        let contents: Vec<&str> = out.drafts.iter().map(|d| d.content.as_str()).collect();
        assert_eq!(contents, vec![GOLDEN_1, GOLDEN_2, GOLDEN_3, GOLDEN_6]);
        assert_eq!(
            out.drafts.iter().map(|d| d.anchor).collect::<Vec<_>>(),
            vec![1, 2, 3, 6]
        );
    }

    #[test]
    fn skips_are_reported_with_anchors_never_repaired() {
        let out = decision_drafts(&corpus());
        let skips: Vec<(u32, &str)> = out
            .skipped
            .iter()
            .map(|s| (s.anchor, s.reason.as_str()))
            .collect();
        assert_eq!(skips.len(), 2);
        assert_eq!(skips[0].0, 4);
        assert!(skips[0].1.contains("non-verbatim"), "{}", skips[0].1);
        assert_eq!(skips[1].0, 5);
        assert!(skips[1].1.contains("contradictory"), "{}", skips[1].1);
    }

    #[test]
    fn malformed_intent_drops_to_record_only_not_the_block() {
        let out = decision_drafts(&corpus());
        let record_only = out
            .drafts
            .iter()
            .find(|d| d.title == "Record-only proposal")
            .expect("draft");
        assert!(!record_only.content.contains("intent"));
        assert!(!record_only.content.contains("\"calls\""));
    }

    #[test]
    fn evidence_must_come_from_prose_not_another_block() {
        let body = concat!(
            "Intro line with nothing quoted.\n\n",
            "```decision\n",
            "title: One\n",
            "kind: plain\n",
            "evidence: Only inside block two.\n",
            "```\n\n",
            "```decision\n",
            "title: Two\n",
            "kind: plain\n",
            "evidence: Only inside block two.\n",
            "```\n"
        );
        let out = decision_drafts(body);
        assert!(out.drafts.is_empty());
        assert_eq!(out.skipped.len(), 2);
    }

    #[test]
    fn anchors_count_skipped_blocks_stably() {
        let out = decision_drafts(&corpus());
        // Block 6 kept anchor 6 even though 4 and 5 were skipped.
        assert_eq!(out.drafts[3].anchor, 6);
    }

    #[test]
    fn deterministic_across_runs() {
        let a = decision_drafts(&corpus());
        let b = decision_drafts(&corpus());
        assert_eq!(a, b);
    }

    #[test]
    fn unterminated_block_is_skipped_not_half_parsed() {
        let body = concat!(
            "The gate is real prose.\n\n",
            "```decision\n",
            "title: Never closed\n",
            "kind: plain\n",
            "evidence: The gate is real prose.\n"
        );
        let out = decision_drafts(body);
        assert!(out.drafts.is_empty());
        assert_eq!(out.skipped.len(), 1);
        assert!(out.skipped[0].reason.contains("unterminated"));
    }

    #[test]
    fn structural_drops_missing_title_unknown_kind_oversized() {
        let prose = "The gate is real prose.";
        let cases = [
            "```decision\nkind: plain\nevidence: The gate is real prose.\n```\n",
            "```decision\nkind: vibes\nevidence: The gate is real prose.\ntitle: T\n```\n",
            "```decision\ntitle: \nkind: plain\nevidence: The gate is real prose.\n```\n",
        ];
        for case in cases {
            let body = format!("{prose}\n\n{case}");
            let out = decision_drafts(&body);
            assert!(out.drafts.is_empty(), "case composed: {case}");
            assert_eq!(out.skipped.len(), 1, "case: {case}");
        }
    }

    #[test]
    fn builder_shapes_the_agent_draft_envelope() {
        let out = decision_drafts(&corpus());
        let builder = build_proposal_draft_builder(LAUNCH, PAGE_COORD, &out.drafts[0]).unwrap();
        let event = builder
            .sign_with_keys(&nostr::Keys::generate())
            .expect("event");
        assert_eq!(event.kind, nostr::Kind::Custom(KIND_LAUNCH_PROPOSAL as u16));
        assert_eq!(event.content, GOLDEN_1);
        let mut tags: Vec<Vec<&str>> = event
            .tags
            .iter()
            .map(|t| t.as_slice().iter().map(|s| s.as_str()).collect())
            .collect();
        tags.sort();
        assert_eq!(
            tags,
            vec![
                vec!["a", LAUNCH],
                vec!["wiki", PAGE_COORD, "1"],
            ]
        );
    }

    #[test]
    fn builder_rejects_bad_coordinates_and_bounds() {
        let out = decision_drafts(&corpus());
        let draft = &out.drafts[0];
        assert!(build_proposal_draft_builder("nebula", PAGE_COORD, draft).is_err());
        assert!(build_proposal_draft_builder(LAUNCH, "44003:aa:bb", draft).is_err());
        assert!(
            build_proposal_draft_builder("37001:ABCD:nebula-dao", PAGE_COORD, draft).is_err()
        );
    }

    #[test]
    fn existing_anchors_read_wiki_tags_strictly() {
        use nostr::{EventBuilder, Keys, Kind, Tag};
        let keys = Keys::generate();
        let e1 = EventBuilder::new(Kind::Custom(KIND_LAUNCH_PROPOSAL as u16), "{}")
            .tags(vec![
                Tag::parse(["wiki", PAGE_COORD, "1"]).unwrap(),
                Tag::parse(["wiki", PAGE_COORD, "3"]).unwrap(),
                Tag::parse(["wiki", PAGE_COORD, "not-a-number"]).unwrap(),
            ])
            .sign_with_keys(&keys)
            .expect("event");
        let e2 = EventBuilder::new(Kind::Custom(5), "{}")
            .tags(vec![Tag::parse(["wiki", PAGE_COORD, "9"]).unwrap()])
            .sign_with_keys(&keys)
            .expect("event");
        let anchors = existing_anchors(&[e1, e2]);
        assert!(anchors.contains(&(PAGE_COORD.to_string(), 1)));
        assert!(anchors.contains(&(PAGE_COORD.to_string(), 3)));
        assert_eq!(anchors.len(), 2); // non-47004 and malformed entries dropped
    }

    #[test]
    fn empty_body_is_empty_output() {
        let out = decision_drafts("");
        assert!(out.drafts.is_empty());
        assert!(out.skipped.is_empty());
    }

    #[test]
    fn value_shapes_match_the_ts_parsers() {
        // op must be the JSON number 0/1 (TS strict equality), value a
        // decimal string (TS rejects JSON numbers), formats enforced
        // (desktop's intentArgs). Extras are ignored, output is canonical.
        let good = serde_json::json!({
            "op": 1,
            "to": "0x1111111111111111111111111111111111111111",
            "value": "5",
            "data": "0x",
            "nonce": "0x0000000000000000000000000000000000000000000000000000000000000001",
            "extra": true
        });
        let intent = parse_strict_intent(&good).unwrap();
        assert_eq!(intent.op, 1);
        assert_eq!(intent.value, "5");
        for bad in [
            serde_json::json!({"op": "0", "to": "0x1111111111111111111111111111111111111111", "value": "0", "data": "0x", "nonce": "0x0000000000000000000000000000000000000000000000000000000000000001"}),
            serde_json::json!({"op": 0, "to": "0x11", "value": "0", "data": "0x", "nonce": "0x0000000000000000000000000000000000000000000000000000000000000001"}),
            serde_json::json!({"op": 0, "to": "0x1111111111111111111111111111111111111111", "value": 0, "data": "0x", "nonce": "0x0000000000000000000000000000000000000000000000000000000000000001"}),
            serde_json::json!({"op": 0, "to": "0x1111111111111111111111111111111111111111", "value": "-1", "data": "0x", "nonce": "0x0000000000000000000000000000000000000000000000000000000000000001"}),
            serde_json::json!({"op": 0, "to": "0x1111111111111111111111111111111111111111", "value": "0", "data": "0x1", "nonce": "0x0000000000000000000000000000000000000000000000000000000000000001"}),
            serde_json::json!({"op": 0, "to": "0x1111111111111111111111111111111111111111", "value": "0", "data": "0x", "nonce": "0x01"}),
            serde_json::json!([0]),
        ] {
            assert!(parse_strict_intent(&bad).is_none(), "accepted: {bad}");
        }
        let calls = parse_strict_calls(&serde_json::json!([
            {"operation": "delegatecall", "from": "a", "to": "b", "value": "0", "data": "c"}
        ]))
        .unwrap();
        assert_eq!(calls[0].operation, "delegatecall");
        for bad in [
            serde_json::json!([{"operation": "staticcall", "from": "a", "to": "b", "value": "0", "data": "c"}]),
            serde_json::json!([{"operation": "call", "from": "a", "to": "b", "value": "0"}]),
            serde_json::json!([]),
            serde_json::json!({"operation": "call"}),
        ] {
            assert!(parse_strict_calls(&bad).is_none(), "accepted: {bad}");
        }
    }

    #[test]
    fn hash_in_quote_survives_verbatim() {
        // No inline-comment stripping: a `#` in a verbatim quote is data.
        let body = "Members asked for the #quorum thread to stay open.\n\n```decision\nkind: plain\ntitle: Keep the thread open\nevidence: Members asked for the #quorum thread to stay open.\n```\n";
        let out = decision_drafts(body);
        assert_eq!(out.drafts.len(), 1);
    }
}
