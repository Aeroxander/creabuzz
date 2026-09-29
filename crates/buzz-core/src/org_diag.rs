//! The differentiated instrument (OA.md Phase 4 / OAv2 §6) — an
//! organizational diagnostic over the signed event graph.
//!
//! Nobody in the field has this because nobody else holds signed multi-agent
//! events, timestamps, a hash chain, AND real economic activity in one
//! substrate. Every instrument here is a pure, deterministic function of the
//! event stream — recomputable by any consumer, like the ERC-4824 projection.
//!
//! Sources, named honestly (OA.md §6, OAv2 §4.9):
//! - **Pentland (#7)**: coordination is detectable from the time signal alone,
//!   "even if all the identities are synonymous" → [`TimeSignal`], computable
//!   with identities discarded (timing-only mode) and with handoffs
//!   (identity-aware contrast).
//! - **Tomasello's three layers** (via CooperBench, #6): communicate / build
//!   trust / institutionalize. Agents talk constantly and it changes nothing,
//!   so volume is explicitly the wrong instrument — the verdict weights
//!   *institutionalization* (standing rules that bind future action).
//! - **Dotta (#4)**: "you can't optimize what you can't evaluate" — tier three
//!   is how the members interact; the five **WEF multi-agent failure modes**
//!   (OAv2 §4.9) are the taxonomy: orchestration drift, semantic misalignment,
//!   security/trust gaps, cascading effects, systemic complexity.
//! - **Cursor** (OAv2 §6): thrash-vs-work scoreboard — "most of those commits
//!   were busywork".
//! - **AI Village (#3)**: personality drift into a bad basin, persisting for
//!   months → [`DriftProbe`] (distribution moved; "bad" is never inferred).
//! - **WEF "governor agents"**: the supervision-saturation read, including its
//!   own stated risk ("overreliance on agents supervising other agents").
//!
//! Honesty rules (the house discipline): every rate is integer basis points
//! (no float nondeterminism, goldens byte-exact); insufficient data yields
//! `None` / `insufficient`, never a zero that reads as measured; raw counts
//! are primary and derived rates always accompany them; nothing here claims
//! causation — "coordination-consistent timing" is a pattern, not a verdict.

use serde::Serialize;

/// Cross-actor handoff window (seconds): an event by B within this lag after
/// an event by A ≠ B counts as a handoff (Pentland's timing coupling).
pub const HANDOFF_LAG_S: u64 = 60;
/// Burstiness above this (basis points of (σ−μ)/(σ+μ)) reads "bursty".
pub const BURSTY_FLAG_BP: i128 = 2_000;
/// Minimum events before any instrument reports at all.
pub const MIN_EVENTS: usize = 20;
/// Minimum per-actor events (per window) for a drift probe to run.
pub const MIN_DRIFT_EVENTS: usize = 8;
/// Drift flag: L1 distance between an actor's class mix across windows.
pub const DRIFT_FLAG_BP: u32 = 3_000;
/// Approval share (of all actions) above which saturation is flagged.
pub const SATURATION_FLAG_BP: u32 = 2_000;

/// The action classes the diagnostic reasons over. Relay event kinds map in
/// via [`class_of_kind`]; unknown kinds are [`DiagClass::Other`] — never
/// guessed into a class.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DiagClass {
    /// Channel/forum messages (the communicate layer's raw material).
    Message,
    /// Proposal records (47004).
    Proposal,
    /// Vote receipt mirrors (47005 `kind: vote`).
    Vote,
    /// Execute receipt mirrors (47005 `kind: execute`).
    Execute,
    /// Contribution records (37013).
    Contribution,
    /// Grants (37011) — standing rules that bind future action.
    Grant,
    /// Revocations/sanctions — trust withdrawn.
    Revoke,
    /// Supervision-gate approval requests (46010).
    Approval,
    /// Wiki page revisions (44001/44002) — the thrash surface.
    Revision,
    /// NIP-09 tombstones — action retracted after the fact.
    Tombstone,
    /// Done coordination tasks (44011).
    TaskDone,
    /// Other receipt mirrors (royalty, claim, grant tables).
    Receipt,
    /// Anything unrecognized — never guessed into a class.
    Other,
}

/// All classes in a stable order (distribution vectors use this order).
pub const DIAG_CLASSES: [DiagClass; 13] = [
    DiagClass::Message,
    DiagClass::Proposal,
    DiagClass::Vote,
    DiagClass::Execute,
    DiagClass::Contribution,
    DiagClass::Grant,
    DiagClass::Revoke,
    DiagClass::Approval,
    DiagClass::Revision,
    DiagClass::Tombstone,
    DiagClass::TaskDone,
    DiagClass::Receipt,
    DiagClass::Other,
];

/// One normalized event. `actor` may be a constant placeholder — the
/// timing-only mode ignores it by construction (Pentland's synonymous case).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiagEvent {
    /// Stable id for deterministic ordering ties (e.g. the event id hex).
    pub id: String,
    /// Acting seat (pubkey hex), or any placeholder in synonymous mode.
    pub actor: String,
    /// Unix seconds.
    pub at: u64,
    pub class: DiagClass,
    /// The acted-on coordinate (`(kind, author, d)`), when the event has one.
    /// Revisions of one coordinate are the thrash/drift surface.
    pub coordinate: Option<String>,
}

/// Map a house event kind to its action class (conservative: unknown → Other).
/// `table` refines 47005 receipt mirrors into the governance vocabulary.
pub fn class_of_kind(kind: u32, table: Option<&str>) -> DiagClass {
    match kind {
        // channel messages + forum posts/threads (NIP-29 plane)
        9 | 40002 | 45001 | 45003 => DiagClass::Message,
        // NIP-LP proposal records / receipt mirrors
        47004 => DiagClass::Proposal,
        47005 => match table {
            Some("vote") => DiagClass::Vote,
            Some("execute") => DiagClass::Execute,
            _ => DiagClass::Receipt,
        },
        // NIP-ORG: contribution records, grants (+ their revocation)
        37013 => DiagClass::Contribution,
        37011 => match table {
            Some("revoke") => DiagClass::Revoke,
            _ => DiagClass::Grant,
        },
        // the S3 supervision gate's approval requests
        46010 => DiagClass::Approval,
        // wiki pages (both kinds) are revisions of a coordinate
        44001 | 44002 => DiagClass::Revision,
        5 => DiagClass::Tombstone,
        // done coordination tasks
        44011 => DiagClass::TaskDone,
        _ => DiagClass::Other,
    }
}

// ── Deterministic integer statistics (no floats anywhere) ──────────────────

fn mean_i128(values: &[u64]) -> i128 {
    if values.is_empty() {
        return 0;
    }
    values.iter().map(|&v| v as i128).sum::<i128>() / values.len() as i128
}

/// Population std-dev × 100 in integer math (sqrt-free: returned squared-scaled
/// is wrong for reporting, so this uses an integer square root).
fn std_i128(values: &[u64]) -> i128 {
    if values.len() < 2 {
        return 0;
    }
    let mean = mean_i128(values);
    let var = values
        .iter()
        .map(|&v| {
            let d = v as i128 - mean;
            d * d
        })
        .sum::<i128>()
        / values.len() as i128;
    isqrt_i128(var)
}

fn isqrt_i128(n: i128) -> i128 {
    if n <= 0 {
        return 0;
    }
    let mut x = n;
    let mut y = (x + 1) / 2;
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    x
}

fn median_u64(mut values: Vec<u64>) -> u64 {
    if values.is_empty() {
        return 0;
    }
    values.sort_unstable();
    values[values.len() / 2]
}

fn rate_bp(part: usize, whole: usize) -> u32 {
    if whole == 0 {
        return 0;
    }
    ((part as i128 * 10_000) / whole as i128) as u32
}

fn sorted_events(events: &[DiagEvent]) -> Vec<&DiagEvent> {
    let mut out: Vec<&DiagEvent> = events.iter().collect();
    out.sort_by(|a, b| (a.at, &a.id).cmp(&(b.at, &b.id)));
    out
}

// ── Instrument 1: the time signal (Pentland) ───────────────────────────────

/// Timing-only coordination evidence — computed WITHOUT identities at all,
/// the synonymous case. `burstiness_bp` is (σ−μ)/(σ+μ) of inter-event
/// intervals in basis points (−10000..=10000). `handoff_*` add the
/// identity-aware contrast.
#[derive(Debug, Clone, PartialEq, Serialize)]
// Camel-case on the wire: the report JSON is byte-compatible with the TS
// twins (web `org-diag.ts`, desktop `orgDiag.ts`) — `buzz diag`, the
// workflow step output, and the UI cards are literally the same report.
#[serde(rename_all = "camelCase")]
pub struct TimeSignal {
    pub events: usize,
    /// Interval burstiness in bp (positive = bursty = coordination-consistent).
    pub burstiness_bp: i128,
    pub bursty: bool,
    /// Cross-actor handoffs (≤ [`HANDOFF_LAG_S`]) as a share of events, bp.
    pub handoff_rate_bp: u32,
    /// Median handoff lag in seconds (0 when no handoffs).
    pub handoff_median_lag_s: u64,
    /// Plain-language read — a pattern, never a verdict.
    pub reading: String,
}

pub fn time_signal(events: &[DiagEvent]) -> Option<TimeSignal> {
    if events.len() < MIN_EVENTS {
        return None;
    }
    let sorted = sorted_events(events);
    let intervals: Vec<u64> = sorted
        .windows(2)
        .map(|w| w[1].at.saturating_sub(w[0].at))
        .collect();
    if intervals.is_empty() {
        return None;
    }
    let mean = mean_i128(&intervals);
    let std = std_i128(&intervals);
    let burstiness_bp = if mean + std == 0 {
        0
    } else {
        ((std - mean) * 10_000 / (std + mean)).clamp(-10_000, 10_000)
    };
    let bursty = burstiness_bp >= BURSTY_FLAG_BP;

    // Identity-aware contrast: B acts right after A ≠ B.
    let mut handoffs = 0usize;
    let mut lags: Vec<u64> = Vec::new();
    for w in sorted.windows(2) {
        let (a, b) = (w[0], w[1]);
        let lag = b.at.saturating_sub(a.at);
        if a.actor != b.actor && lag <= HANDOFF_LAG_S {
            handoffs += 1;
            lags.push(lag);
        }
    }
    let handoff_rate_bp = rate_bp(handoffs, events.len());
    let reading = if bursty && handoff_rate_bp >= 1_000 {
        "coordination-consistent timing: bursty stream with cross-actor handoffs — a pattern in the timestamps, not proof of coordination".to_string()
    } else if bursty {
        "bursty timing without cross-actor handoffs — synchronized load or deadlines also produce this".to_string()
    } else {
        "no timing coordination pattern detectable in this window".to_string()
    };
    Some(TimeSignal {
        events: events.len(),
        burstiness_bp,
        bursty,
        handoff_rate_bp,
        handoff_median_lag_s: median_u64(lags),
        reading,
    })
}

// ── Instrument 2: Tomasello's three layers ─────────────────────────────────

/// communicate / build-trust / institutionalize. The verdict weights
/// institutionalization — volume alone is the CooperBench null result.
#[derive(Debug, Clone, PartialEq, Serialize)]
// Camel-case on the wire: the report JSON is byte-compatible with the TS
// twins (web `org-diag.ts`, desktop `orgDiag.ts`) — `buzz diag`, the
// workflow step output, and the UI cards are literally the same report.
#[serde(rename_all = "camelCase")]
pub struct Tomasello {
    pub communicate: Layer,
    pub build_trust: Layer,
    pub institutionalize: Layer,
    pub reading: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
// Camel-case on the wire: the report JSON is byte-compatible with the TS
// twins (web `org-diag.ts`, desktop `orgDiag.ts`) — `buzz diag`, the
// workflow step output, and the UI cards are literally the same report.
#[serde(rename_all = "camelCase")]
pub struct Layer {
    pub events: usize,
    /// This layer's share of all actions, bp.
    pub share_bp: u32,
}

pub fn tomasello(events: &[DiagEvent]) -> Option<Tomasello> {
    if events.len() < MIN_EVENTS {
        return None;
    }
    let count = |c: DiagClass| events.iter().filter(|e| e.class == c).count();
    let communicate_n = count(DiagClass::Message);
    let trust_n =
        count(DiagClass::Contribution) + count(DiagClass::Grant) + count(DiagClass::Revoke);
    let inst_n = count(DiagClass::Proposal)
        + count(DiagClass::Vote)
        + count(DiagClass::Execute)
        + count(DiagClass::Approval);
    let total = events.len();
    let layer = |n: usize| Layer {
        events: n,
        share_bp: rate_bp(n, total),
    };
    let reading = if inst_n == 0 {
        "talk without institutions: no standing rules or executed decisions in this window (the CooperBench shape — volume is not the instrument)".to_string()
    } else if inst_n * 2 < communicate_n {
        "institutions exist but communication dominates — measure what binds future action, not what is said".to_string()
    } else {
        "institutionalization present: proposals/votes/executions and approval gates bind future action".to_string()
    };
    Some(Tomasello {
        communicate: layer(communicate_n),
        build_trust: layer(trust_n),
        institutionalize: layer(inst_n),
        reading,
    })
}

// ── Instrument 3: the WEF five failure modes (OAv2 §4.9 early warnings) ────

/// One WEF multi-agent failure mode and its current read.
#[derive(Debug, Clone, PartialEq, Serialize)]
// Camel-case on the wire: the report JSON is byte-compatible with the TS
// twins (web `org-diag.ts`, desktop `orgDiag.ts`) — `buzz diag`, the
// workflow step output, and the UI cards are literally the same report.
#[serde(rename_all = "camelCase")]
pub struct WefMode {
    pub mode: &'static str,
    pub signal_events: usize,
    /// Raw counts first; `status` is thresholded and says so.
    pub status: &'static str,
    pub note: &'static str,
}

pub fn wef_modes(events: &[DiagEvent]) -> Vec<WefMode> {
    let count = |c: DiagClass| events.iter().filter(|e| e.class == c).count();
    let approvals = count(DiagClass::Approval);
    let revokes = count(DiagClass::Revoke);
    let tombstones = count(DiagClass::Tombstone);
    let revisions = count(DiagClass::Revision);
    let total = events.len().max(1);
    // Cascades: a revoke/tombstone followed by ≥3 events within 30s.
    let sorted = sorted_events(events);
    let mut cascade_events = 0usize;
    for (i, e) in sorted.iter().enumerate() {
        if e.class != DiagClass::Revoke && e.class != DiagClass::Tombstone {
            continue;
        }
        let follow = sorted[i + 1..]
            .iter()
            .take_while(|n| n.at.saturating_sub(e.at) <= 30)
            .count();
        if follow >= 3 {
            cascade_events += 1;
        }
    }
    let status = |bp: u32| {
        if bp >= 2_000 {
            "flag"
        } else if bp >= 500 {
            "watch"
        } else {
            "calm"
        }
    };
    vec![
        WefMode {
            mode: "orchestration-drift",
            signal_events: approvals,
            status: status(rate_bp(approvals, total)),
            note: "approval requests and gate hits (46010) — drift toward asking permission",
        },
        WefMode {
            mode: "semantic-misalignment",
            signal_events: tombstones,
            status: status(rate_bp(tombstones, total)),
            note: "tombstones and disposed drafts — action retracted after the fact",
        },
        WefMode {
            mode: "security-trust-gaps",
            signal_events: revokes,
            status: status(rate_bp(revokes, total)),
            note: "revocations and sanctions — trust withdrawn",
        },
        WefMode {
            mode: "cascading-effects",
            signal_events: cascade_events,
            status: status(rate_bp(cascade_events, total)),
            note: "events clustering within 30s after a revoke/tombstone",
        },
        WefMode {
            mode: "systemic-complexity",
            signal_events: revisions,
            status: status(rate_bp(revisions, total)),
            note: "revision churn per coordinate (see the thrash scoreboard)",
        },
    ]
}

// ── Instrument 4: the thrash-vs-work scoreboard (Cursor) ───────────────────

/// "One reading is that it was more productive. Another is that most of those
/// commits were busywork." — so the scoreboard separates the two readings.
#[derive(Debug, Clone, PartialEq, Serialize)]
// Camel-case on the wire: the report JSON is byte-compatible with the TS
// twins (web `org-diag.ts`, desktop `orgDiag.ts`) — `buzz diag`, the
// workflow step output, and the UI cards are literally the same report.
#[serde(rename_all = "camelCase")]
pub struct Thrash {
    pub revisions: usize,
    pub coordinates: usize,
    /// Revisions beyond the first per coordinate (the busywork surface), bp of
    /// all revisions.
    pub rework_rate_bp: u32,
    /// Coordinates written once and left alone (the settled surface), bp.
    pub settled_rate_bp: u32,
    pub reading: String,
}

pub fn thrash(events: &[DiagEvent]) -> Option<Thrash> {
    let mut per_coordinate: std::collections::BTreeMap<&str, usize> =
        std::collections::BTreeMap::new();
    let mut revisions = 0usize;
    for e in events {
        if e.class != DiagClass::Revision {
            continue;
        }
        revisions += 1;
        if let Some(c) = e.coordinate.as_deref() {
            *per_coordinate.entry(c).or_insert(0) += 1;
        }
    }
    if revisions == 0 {
        return None;
    }
    let coordinates = per_coordinate.len();
    let rework = per_coordinate
        .values()
        .map(|&n| n.saturating_sub(1))
        .sum::<usize>();
    let settled = per_coordinate.values().filter(|&&n| n == 1).count();
    let rework_rate_bp = rate_bp(rework, revisions);
    let settled_rate_bp = rate_bp(settled, coordinates);
    let reading = if rework_rate_bp >= 5_000 {
        "thrash-shaped: most revisions rework a coordinate — the busywork reading".to_string()
    } else if settled_rate_bp >= 7_000 {
        "settled: most coordinates were written once and left alone (Cursor's nine crates)"
            .to_string()
    } else {
        "mixed: raw counts above are the honest read".to_string()
    };
    Some(Thrash {
        revisions,
        coordinates,
        rework_rate_bp,
        settled_rate_bp,
        reading,
    })
}

// ── Instrument 5: drift probes (AI Village) ────────────────────────────────

/// Distribution drift per actor across two equal sub-windows. "Personality
/// drift into a bad basin" starts as a moved distribution — direction of bad
/// is NOT inferred here.
#[derive(Debug, Clone, PartialEq, Serialize)]
// Camel-case on the wire: the report JSON is byte-compatible with the TS
// twins (web `org-diag.ts`, desktop `orgDiag.ts`) — `buzz diag`, the
// workflow step output, and the UI cards are literally the same report.
#[serde(rename_all = "camelCase")]
pub struct DriftProbe {
    pub actor: String,
    pub earlier_events: usize,
    pub later_events: usize,
    /// L1 distance between class mixes, bp (0 = same mix, 20000 = disjoint).
    pub drift_bp: u32,
    /// True at [`DRIFT_FLAG_BP`] — movement only; "bad" is never inferred.
    pub flagged: bool,
}

/// Drift probe per actor across the window's two halves (instrument 5).
pub fn drift_probes(events: &[DiagEvent]) -> Vec<DriftProbe> {
    if events.len() < MIN_EVENTS {
        return Vec::new();
    }
    let sorted = sorted_events(events);
    let t0 = sorted.first().map(|e| e.at).unwrap_or(0);
    let t1 = sorted.last().map(|e| e.at).unwrap_or(0);
    let mid = t0 + (t1.saturating_sub(t0)) / 2;
    let mut actors: std::collections::BTreeMap<&str, (Vec<usize>, Vec<usize>)> =
        std::collections::BTreeMap::new();
    for e in &sorted {
        let entry = actors.entry(e.actor.as_str()).or_default();
        let idx = DIAG_CLASSES.iter().position(|c| *c == e.class).unwrap_or(0);
        if e.at <= mid {
            entry.0.resize(DIAG_CLASSES.len(), 0);
            entry.0[idx] += 1;
        } else {
            entry.1.resize(DIAG_CLASSES.len(), 0);
            entry.1[idx] += 1;
        }
    }
    let mut out = Vec::new();
    for (actor, (early, late)) in actors {
        let (early, late) = {
            let mut e = early;
            let mut l = late;
            e.resize(DIAG_CLASSES.len(), 0);
            l.resize(DIAG_CLASSES.len(), 0);
            (e, l)
        };
        let (ne, nl) = (early.iter().sum::<usize>(), late.iter().sum::<usize>());
        if ne < MIN_DRIFT_EVENTS || nl < MIN_DRIFT_EVENTS {
            continue;
        }
        let mut l1 = 0u32;
        for i in 0..DIAG_CLASSES.len() {
            let a = rate_bp(early[i], ne);
            let b = rate_bp(late[i], nl);
            l1 += a.abs_diff(b);
        }
        out.push(DriftProbe {
            actor: actor.to_string(),
            earlier_events: ne,
            later_events: nl,
            drift_bp: l1,
            flagged: l1 >= DRIFT_FLAG_BP,
        });
    }
    out
}

// ── Instrument 6: supervision saturation (the governor-agents risk) ────────

/// §4.6's rate-limit question gets data. Includes the WEF's own stated risk:
/// overreliance on agents supervising other agents — visible as approval
/// concentration in one seat.
#[derive(Debug, Clone, PartialEq, Serialize)]
// Camel-case on the wire: the report JSON is byte-compatible with the TS
// twins (web `org-diag.ts`, desktop `orgDiag.ts`) — `buzz diag`, the
// workflow step output, and the UI cards are literally the same report.
#[serde(rename_all = "camelCase")]
pub struct Supervision {
    /// Approval requests (46010) in the window.
    pub approval_requests: usize,
    /// All actions in the window (the rate denominator).
    pub actions: usize,
    /// Approval requests as a share of all actions, bp.
    pub saturation_bp: u32,
    /// Largest single actor's share of approval requests, bp (0 when none).
    pub top_approver_share_bp: u32,
    /// Thresholded read (`calm` / `watch` / `saturated`).
    pub status: &'static str,
}

/// Supervision saturation — instrument 6 (the governor-agents read).
pub fn supervision(events: &[DiagEvent]) -> Option<Supervision> {
    if events.len() < MIN_EVENTS {
        return None;
    }
    let approvals: Vec<&DiagEvent> = events
        .iter()
        .filter(|e| e.class == DiagClass::Approval)
        .collect();
    let saturation_bp = rate_bp(approvals.len(), events.len());
    let mut per_actor: std::collections::BTreeMap<&str, usize> = std::collections::BTreeMap::new();
    for e in &approvals {
        *per_actor.entry(e.actor.as_str()).or_insert(0) += 1;
    }
    let top_approver_share_bp = per_actor
        .values()
        .map(|&n| rate_bp(n, approvals.len()))
        .max()
        .unwrap_or(0);
    let status = if saturation_bp >= SATURATION_FLAG_BP {
        "saturated"
    } else if saturation_bp >= 500 {
        "watch"
    } else {
        "calm"
    };
    Some(Supervision {
        approval_requests: approvals.len(),
        actions: events.len(),
        saturation_bp,
        top_approver_share_bp,
        status,
    })
}

// ── The report ─────────────────────────────────────────────────────────────

/// The full instrument run. Valueless instruments are omitted, never nulled —
/// the ERC-4824 house rule applied to diagnostics.
#[derive(Debug, Clone, PartialEq, Serialize)]
// Camel-case on the wire: the report JSON is byte-compatible with the TS
// twins (web `org-diag.ts`, desktop `orgDiag.ts`) — `buzz diag`, the
// workflow step output, and the UI cards are literally the same report.
#[serde(rename_all = "camelCase")]
pub struct DiagReport {
    /// Events in the window (the raw count every rate accompanies).
    pub events: usize,
    /// First event timestamp in the window (unix seconds).
    pub from: u64,
    /// Last event timestamp in the window (unix seconds).
    pub to: u64,
    /// Instrument 1 — Pentland's timing-only coordination read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_signal: Option<TimeSignal>,
    /// Instrument 2 — Tomasello's three layers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tomasello: Option<Tomasello>,
    /// The five WEF failure modes with their current reads.
    pub wef_modes: Vec<WefMode>,
    /// Instrument 4 — Cursor's thrash-vs-work scoreboard.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thrash: Option<Thrash>,
    /// Per-actor drift probes (skipped actors stay out of the list).
    pub drift: Vec<DriftProbe>,
    /// Instrument 6 — supervision saturation (the governor-agents risk).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supervision: Option<Supervision>,
}

/// Run every instrument over one window. Deterministic: input order never
/// affects output (events are sorted by `(at, id)` first).
pub fn diagnose(events: &[DiagEvent]) -> DiagReport {
    let sorted = sorted_events(events);
    DiagReport {
        events: events.len(),
        from: sorted.first().map(|e| e.at).unwrap_or(0),
        to: sorted.last().map(|e| e.at).unwrap_or(0),
        time_signal: time_signal(events),
        tomasello: tomasello(events),
        wef_modes: wef_modes(events),
        thrash: thrash(events),
        drift: drift_probes(events),
        supervision: supervision(events),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(id: usize, actor: &str, at: u64, class: DiagClass) -> DiagEvent {
        DiagEvent {
            id: format!("e{id:02}"),
            actor: actor.to_string(),
            at,
            class,
            coordinate: None,
        }
    }

    /// The golden corpus: 20 events, 10s apart, actors alternating (every
    /// later event is a cross-actor handoff), class mix fixed:
    /// 6 message / 4 trust (2 contribution + 2 grant) / 6 institutional
    /// (2 proposal + 2 vote + 1 execute + 1 approval) / 4 revisions
    /// (coordinate p ×3, q ×1).
    fn corpus() -> Vec<DiagEvent> {
        let classes = [
            DiagClass::Message,
            DiagClass::Message,
            DiagClass::Contribution,
            DiagClass::Message,
            DiagClass::Proposal,
            DiagClass::Grant,
            DiagClass::Message,
            DiagClass::Vote,
            DiagClass::Revision,
            DiagClass::Contribution,
            DiagClass::Message,
            DiagClass::Proposal,
            DiagClass::Grant,
            DiagClass::Vote,
            DiagClass::Revision,
            DiagClass::Message,
            DiagClass::Execute,
            DiagClass::Approval,
            DiagClass::Revision,
            DiagClass::Revision,
        ];
        classes
            .iter()
            .enumerate()
            .map(|(i, &class)| {
                let mut e = ev(
                    i,
                    if i % 2 == 0 { "a" } else { "b" },
                    1_000 + i as u64 * 10,
                    class,
                );
                if class == DiagClass::Revision {
                    e.coordinate = Some(if i == 19 { "q" } else { "p" }.to_string());
                }
                e
            })
            .collect()
    }

    #[test]
    fn golden_time_signal_is_integer_exact() {
        let ts = time_signal(&corpus()).expect("enough events");
        // Uniform 10s intervals: σ=0, μ=10 → burstiness −10000bp (regular).
        assert_eq!(ts.burstiness_bp, -10_000);
        assert!(!ts.bursty);
        // 19 of 20 events are cross-actor handoffs inside the window.
        assert_eq!(ts.handoff_rate_bp, 9_500);
        assert_eq!(ts.handoff_median_lag_s, 10);
        assert!(ts.reading.contains("no timing coordination pattern"));
    }

    #[test]
    fn golden_tomasello_shares_and_institutional_reading() {
        let t = tomasello(&corpus()).expect("enough events");
        assert_eq!(t.communicate.events, 6);
        assert_eq!(t.communicate.share_bp, 3_000);
        assert_eq!(t.build_trust.events, 4);
        assert_eq!(t.build_trust.share_bp, 2_000);
        assert_eq!(t.institutionalize.events, 6);
        assert_eq!(t.institutionalize.share_bp, 3_000);
        assert!(t.reading.contains("institutionalization present"));
    }

    #[test]
    fn golden_thrash_scoreboard() {
        let t = thrash(&corpus()).expect("revisions present");
        assert_eq!(t.revisions, 4);
        assert_eq!(t.coordinates, 2);
        assert_eq!(t.rework_rate_bp, 5_000); // 2 rework revisions of 4
        assert_eq!(t.settled_rate_bp, 5_000); // q settled of 2 coordinates
        assert!(t.reading.contains("thrash-shaped"));
    }

    #[test]
    fn golden_supervision_and_wef_thresholds() {
        let s = supervision(&corpus()).expect("enough events");
        assert_eq!(s.approval_requests, 1);
        assert_eq!(s.saturation_bp, 500);
        assert_eq!(s.top_approver_share_bp, 10_000);
        assert_eq!(s.status, "watch");
        let modes = wef_modes(&corpus());
        assert_eq!(modes.len(), 5);
        let by_mode = |m: &str| modes.iter().find(|w| w.mode == m).unwrap();
        assert_eq!(by_mode("orchestration-drift").signal_events, 1);
        assert_eq!(by_mode("orchestration-drift").status, "watch");
        assert_eq!(by_mode("systemic-complexity").status, "flag"); // 4/20 = 2000bp
        assert_eq!(by_mode("cascading-effects").signal_events, 0);
    }

    #[test]
    fn drift_probe_is_a_moved_distribution_and_infers_nothing_else() {
        // Actor c: pure messages early, pure grants late (disjoint mixes).
        // Actor d: the same mix in both windows (zero drift).
        let mut events: Vec<DiagEvent> = Vec::new();
        for i in 0..8 {
            events.push(ev(i, "c", i as u64, DiagClass::Message));
            events.push(ev(100 + i, "d", 10 + i as u64, DiagClass::Message));
            events.push(ev(200 + i, "d", 20 + i as u64, DiagClass::Grant));
        }
        for i in 0..8 {
            events.push(ev(300 + i, "c", 3_000 + i as u64, DiagClass::Grant));
            events.push(ev(400 + i, "d", 3_010 + i as u64, DiagClass::Message));
            events.push(ev(500 + i, "d", 3_020 + i as u64, DiagClass::Grant));
        }
        let probes = drift_probes(&events);
        assert_eq!(probes.len(), 2);
        let c = probes.iter().find(|p| p.actor == "c").unwrap();
        let d = probes.iter().find(|p| p.actor == "d").unwrap();
        assert_eq!(c.drift_bp, 20_000, "disjoint mixes");
        assert!(c.flagged);
        assert_eq!(d.drift_bp, 0, "same mix");
        assert!(!d.flagged);
    }

    #[test]
    fn insufficient_data_is_omitted_never_zero() {
        let small: Vec<DiagEvent> = (0..5)
            .map(|i| ev(i, "a", i as u64, DiagClass::Message))
            .collect();
        let report = diagnose(&small);
        assert!(report.time_signal.is_none());
        assert!(report.tomasello.is_none());
        assert!(report.supervision.is_none());
        assert!(report.thrash.is_none());
        assert!(report.drift.is_empty());
        // Valueless instruments are REMOVED from the JSON, never nulled.
        let value = serde_json::to_value(&report).unwrap();
        assert!(value.get("timeSignal").is_none());
        assert!(value.get("thrash").is_none());
    }

    #[test]
    fn order_independence_shuffled_input_identical_output() {
        let mut shuffled = corpus();
        shuffled.reverse();
        shuffled.swap(0, 5);
        shuffled.swap(3, 17);
        assert_eq!(
            serde_json::to_string(&diagnose(&corpus())).unwrap(),
            serde_json::to_string(&diagnose(&shuffled)).unwrap()
        );
    }

    #[test]
    fn deterministic_across_runs() {
        assert_eq!(diagnose(&corpus()), diagnose(&corpus()));
    }

    #[test]
    fn class_mapping_is_conservative() {
        assert_eq!(class_of_kind(47004, None), DiagClass::Proposal);
        assert_eq!(class_of_kind(47005, Some("vote")), DiagClass::Vote);
        assert_eq!(class_of_kind(47005, Some("execute")), DiagClass::Execute);
        assert_eq!(class_of_kind(47005, Some("claim")), DiagClass::Receipt);
        assert_eq!(class_of_kind(37013, None), DiagClass::Contribution);
        assert_eq!(class_of_kind(37011, Some("revoke")), DiagClass::Revoke);
        assert_eq!(class_of_kind(46010, None), DiagClass::Approval);
        assert_eq!(class_of_kind(5, None), DiagClass::Tombstone);
        assert_eq!(
            class_of_kind(12_345, None),
            DiagClass::Other,
            "unknown → Other"
        );
    }

    #[test]
    fn cascade_counts_triggers_with_dense_followups() {
        let mut events: Vec<DiagEvent> = vec![
            ev(0, "a", 0, DiagClass::Tombstone),
            ev(1, "b", 5, DiagClass::Message),
            ev(2, "c", 10, DiagClass::Message),
            ev(3, "d", 15, DiagClass::Message),
            ev(4, "e", 500, DiagClass::Tombstone), // only one follower
            ev(5, "f", 510, DiagClass::Message),
        ];
        while events.len() < MIN_EVENTS {
            let i = events.len();
            events.push(ev(i, "z", 1_000 + i as u64, DiagClass::Message));
        }
        let modes = wef_modes(&events);
        let cascade = modes
            .iter()
            .find(|m| m.mode == "cascading-effects")
            .unwrap();
        assert_eq!(cascade.signal_events, 1, "only the first trigger is dense");
    }
}
