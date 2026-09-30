//! Anonymous P2P-signaling admission policy (`BUZZ_P2P_SIGNALING=1`).
//!
//! Browser P2P layers (the Trystero Nostr strategy behind live wiki editing)
//! rendezvous through the relay before any member has authenticated. When the
//! deployment opts in, an *unauthenticated* socket may publish and subscribe to
//! a narrow slice of NIP-01 ephemeral events. Ephemeral events are never
//! stored, but they ARE fanned out live, so the slice has to be small enough
//! that an anonymous socket can neither read community state nor write it:
//!
//! - **Allowlisted kinds only** (`BUZZ_P2P_SIGNALING_KINDS`, default the whole
//!   ephemeral window `20000-29999`). The Trystero Nostr strategy derives its
//!   event kind from the room topic (`20000 + Σ charCodes(topic) mod 10000`),
//!   so the kind is *not* a single value; the window is therefore the default
//!   and the fixed deny-list below carves out every kind Buzz itself defines.
//! - **Never a Buzz kind.** Every kind in [`buzz_core::kind::ALL_KINDS`]
//!   (presence 20001, typing 20002, observer frames 24200, pairing 24134, HTTP
//!   auth 27235, …) plus NIP-46 is refused regardless of configuration, so an
//!   anonymous socket cannot read every member's presence or forge state.
//! - **Trystero-shaped traffic only.** Filters must be `{kinds, #x, since?}`
//!   with bounded topic counts; events must carry exactly one bounded `x`
//!   topic tag, no `h` (channel) tag, and bounded content.
//! - **Bounded**: a per-connection subscription cap and a per-connection
//!   frame budget ([`AnonymousFrameLimiter`]) for EVENT and REQ.
//!
//! The predicates are pure so the WS handlers (`handlers::req`,
//! `handlers::event`) and the tests share exactly one definition.

use std::ops::RangeInclusive;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use buzz_core::kind::{is_ephemeral, ALL_KINDS, EPHEMERAL_KIND_MAX, EPHEMERAL_KIND_MIN};
use nostr::{Alphabet, Event, Filter, SingleLetterTag};
use uuid::Uuid;

use crate::config::ConfigError;

/// Default `BUZZ_P2P_SIGNALING_KINDS`: the whole ephemeral window (minus the
/// always-denied Buzz kinds).
pub const DEFAULT_KINDS_SPEC: &str = "20000-29999";
/// Default `BUZZ_P2P_SIGNALING_MAX_SUBSCRIPTIONS`: standing subscriptions per
/// anonymous connection. Trystero batches every topic of a relay into one REQ.
pub const DEFAULT_MAX_SUBSCRIPTIONS: usize = 4;
/// Default `BUZZ_P2P_SIGNALING_EVENTS_PER_MIN`: anonymous EVENT (and,
/// separately, REQ) frames admitted per connection per minute.
pub const DEFAULT_FRAMES_PER_MINUTE: u32 = 120;
/// Upper bound accepted for `BUZZ_P2P_SIGNALING_MAX_SUBSCRIPTIONS`.
pub const MAX_CONFIGURABLE_SUBSCRIPTIONS: usize = 64;
/// Upper bound accepted for `BUZZ_P2P_SIGNALING_EVENTS_PER_MIN`.
pub const MAX_CONFIGURABLE_FRAMES_PER_MINUTE: u32 = 10_000;

/// Filters per anonymous REQ. Trystero sends one.
pub const MAX_FILTERS_PER_REQ: usize = 4;
/// Topics (`#x` values) and kinds per anonymous filter. Matches Trystero's
/// `maxTopicsPerSubscription`.
pub const MAX_TOPICS_PER_FILTER: usize = 250;
/// Longest accepted topic string, in bytes.
pub const MAX_TOPIC_BYTES: usize = 256;
/// Longest accepted anonymous event `content`, in bytes. WebRTC offers/answers
/// (encrypted SDP) are a few KiB; this leaves ample headroom while keeping an
/// anonymous socket from fanning out large payloads.
pub const MAX_EVENT_CONTENT_BYTES: usize = 64 * 1024;
/// Most tags an anonymous event may carry.
pub const MAX_EVENT_TAGS: usize = 8;

/// Ephemeral kinds reserved by other Nostr protocols that Buzz does not define
/// as constants; refused for anonymous sockets in addition to [`ALL_KINDS`].
const EXTRA_RESERVED_KINDS: [u32; 1] = [
    24133, // NIP-46 remote signing
];

/// Frame classes counted by [`AnonymousFrameLimiter`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AnonymousFrame {
    /// An anonymous `EVENT`.
    Event,
    /// An anonymous `REQ`.
    Req,
}

/// Anonymous P2P-signaling policy, resolved once from the environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct P2pSignalingPolicy {
    kinds: Vec<RangeInclusive<u32>>,
    /// Standing subscriptions one anonymous connection may hold.
    pub max_subscriptions: usize,
    /// EVENT (and, separately, REQ) frames admitted per anonymous connection
    /// per minute.
    pub frames_per_minute: u32,
}

impl Default for P2pSignalingPolicy {
    fn default() -> Self {
        Self {
            // Same window as `DEFAULT_KINDS_SPEC`, built without parsing.
            kinds: vec![EPHEMERAL_KIND_MIN..=EPHEMERAL_KIND_MAX],
            max_subscriptions: DEFAULT_MAX_SUBSCRIPTIONS,
            frames_per_minute: DEFAULT_FRAMES_PER_MINUTE,
        }
    }
}

impl P2pSignalingPolicy {
    /// Read `BUZZ_P2P_SIGNALING_KINDS`, `BUZZ_P2P_SIGNALING_MAX_SUBSCRIPTIONS`
    /// and `BUZZ_P2P_SIGNALING_EVENTS_PER_MIN`. Unset or blank means default; a
    /// malformed value is a startup error rather than a silent widening.
    pub fn from_env() -> Result<Self, ConfigError> {
        let read = |name: &str| -> Result<Option<String>, ConfigError> {
            match std::env::var(name) {
                Ok(value) if value.trim().is_empty() => Ok(None),
                Ok(value) => Ok(Some(value)),
                Err(std::env::VarError::NotPresent) => Ok(None),
                Err(error) => Err(ConfigError::InvalidValue(format!(
                    "{name} must be valid UTF-8: {error}"
                ))),
            }
        };
        Self::from_values(
            read("BUZZ_P2P_SIGNALING_KINDS")?.as_deref(),
            read("BUZZ_P2P_SIGNALING_MAX_SUBSCRIPTIONS")?.as_deref(),
            read("BUZZ_P2P_SIGNALING_EVENTS_PER_MIN")?.as_deref(),
        )
    }

    /// Build a policy from raw setting values (`None` = default).
    pub fn from_values(
        kinds: Option<&str>,
        max_subscriptions: Option<&str>,
        frames_per_minute: Option<&str>,
    ) -> Result<Self, ConfigError> {
        let kinds = parse_kinds_spec(kinds.unwrap_or(DEFAULT_KINDS_SPEC)).map_err(|message| {
            ConfigError::InvalidValue(format!("BUZZ_P2P_SIGNALING_KINDS {message}"))
        })?;
        let max_subscriptions = match max_subscriptions {
            None => DEFAULT_MAX_SUBSCRIPTIONS,
            Some(raw) => raw
                .trim()
                .parse::<usize>()
                .ok()
                .filter(|n| (1..=MAX_CONFIGURABLE_SUBSCRIPTIONS).contains(n))
                .ok_or_else(|| {
                    ConfigError::InvalidValue(format!(
                        "BUZZ_P2P_SIGNALING_MAX_SUBSCRIPTIONS must be an integer in 1..={MAX_CONFIGURABLE_SUBSCRIPTIONS}, got {raw:?}"
                    ))
                })?,
        };
        let frames_per_minute = match frames_per_minute {
            None => DEFAULT_FRAMES_PER_MINUTE,
            Some(raw) => raw
                .trim()
                .parse::<u32>()
                .ok()
                .filter(|n| (1..=MAX_CONFIGURABLE_FRAMES_PER_MINUTE).contains(n))
                .ok_or_else(|| {
                    ConfigError::InvalidValue(format!(
                        "BUZZ_P2P_SIGNALING_EVENTS_PER_MIN must be an integer in 1..={MAX_CONFIGURABLE_FRAMES_PER_MINUTE}, got {raw:?}"
                    ))
                })?,
        };
        Ok(Self {
            kinds,
            max_subscriptions,
            frames_per_minute,
        })
    }

    /// Whether an anonymous socket may use `kind`: an ephemeral kind inside the
    /// configured allowlist that is not defined by Buzz (or reserved by NIP-46).
    pub fn kind_allowed(&self, kind: u32) -> bool {
        is_ephemeral(kind)
            && !ALL_KINDS.contains(&kind)
            && !EXTRA_RESERVED_KINDS.contains(&kind)
            && self.kinds.iter().any(|range| range.contains(&kind))
    }

    /// Whether an anonymous `REQ` with these filters is admissible: 1–4
    /// filters, each `{kinds ⊆ allowlist, #x topics}` and nothing else that
    /// could widen the read (no `ids`, `authors`, `search`, or other tags).
    pub fn filters_allowed(&self, filters: &[Filter]) -> bool {
        !filters.is_empty()
            && filters.len() <= MAX_FILTERS_PER_REQ
            && filters.iter().all(|filter| self.filter_allowed(filter))
    }

    fn filter_allowed(&self, filter: &Filter) -> bool {
        let Some(kinds) = filter.kinds.as_ref() else {
            return false;
        };
        if kinds.is_empty()
            || kinds.len() > MAX_TOPICS_PER_FILTER
            || !kinds
                .iter()
                .all(|kind| self.kind_allowed(u32::from(kind.as_u16())))
        {
            return false;
        }
        if filter.ids.is_some() || filter.authors.is_some() || filter.search.is_some() {
            return false;
        }
        if filter.generic_tags.len() != 1 {
            return false;
        }
        let topic_tag = SingleLetterTag::lowercase(Alphabet::X);
        filter.generic_tags.get(&topic_tag).is_some_and(|topics| {
            !topics.is_empty()
                && topics.len() <= MAX_TOPICS_PER_FILTER
                && topics.iter().all(|topic| topic_valid(topic))
        })
    }

    /// Whether an anonymous `EVENT` is admissible: an allowlisted kind, exactly
    /// one bounded `x` topic tag, no `h` (channel) tag, bounded tags/content.
    pub fn event_allowed(&self, event: &Event) -> bool {
        if !self.kind_allowed(u32::from(event.kind.as_u16()))
            || event.content.len() > MAX_EVENT_CONTENT_BYTES
            || event.tags.len() > MAX_EVENT_TAGS
        {
            return false;
        }
        let mut topics = 0usize;
        for tag in event.tags.iter() {
            let parts = tag.as_slice();
            match parts.first().map(String::as_str) {
                Some("x") => {
                    if !parts.get(1).is_some_and(|topic| topic_valid(topic)) {
                        return false;
                    }
                    topics += 1;
                }
                // Channel scoping would route this through membership checks
                // and channel fan-out; anonymous signaling is channel-less.
                Some("h") => return false,
                _ => {}
            }
        }
        topics == 1
    }
}

fn topic_valid(topic: &str) -> bool {
    !topic.is_empty() && topic.len() <= MAX_TOPIC_BYTES
}

/// Parse a kinds spec such as `"25000,25010-25020"` into inclusive ranges.
///
/// Every value must lie inside the ephemeral window: anonymous sockets may
/// never touch a stored kind, whatever the operator configures.
fn parse_kinds_spec(spec: &str) -> Result<Vec<RangeInclusive<u32>>, String> {
    const MAX_ENTRIES: usize = 64;
    let mut ranges = Vec::new();
    for entry in spec.split(',').map(str::trim).filter(|e| !e.is_empty()) {
        let (start, end) = match entry.split_once('-') {
            Some((a, b)) => (a.trim(), b.trim()),
            None => (entry, entry),
        };
        let parse = |raw: &str| {
            raw.parse::<u32>()
                .map_err(|_| format!("has an unparseable entry {entry:?}"))
        };
        let (start, end) = (parse(start)?, parse(end)?);
        if start > end {
            return Err(format!("has an inverted range {entry:?}"));
        }
        if start < EPHEMERAL_KIND_MIN || end > EPHEMERAL_KIND_MAX {
            return Err(format!(
                "entry {entry:?} is outside the ephemeral window {EPHEMERAL_KIND_MIN}-{EPHEMERAL_KIND_MAX}; anonymous sockets may only use ephemeral kinds"
            ));
        }
        ranges.push(start..=end);
        if ranges.len() > MAX_ENTRIES {
            return Err(format!("has more than {MAX_ENTRIES} entries"));
        }
    }
    if ranges.is_empty() {
        return Err("must list at least one kind or range".to_string());
    }
    Ok(ranges)
}

/// Per-connection fixed-window budget for anonymous `EVENT` and `REQ` frames.
///
/// Bounded: entries expire one window after creation and the map has a hard
/// capacity, so a flood of throwaway connections cannot grow it without limit.
/// The window is fixed (counter resets when the entry expires), not sliding.
#[derive(Clone)]
pub struct AnonymousFrameLimiter {
    counters: Arc<moka::sync::Cache<(Uuid, AnonymousFrame), Arc<AtomicU32>>>,
}

impl AnonymousFrameLimiter {
    /// Window over which [`AnonymousFrameLimiter::admit`] counts frames.
    pub const WINDOW: Duration = Duration::from_secs(60);
    const CAPACITY: u64 = 100_000;

    /// A limiter with the standard one-minute window.
    pub fn new() -> Self {
        Self::with_window(Self::WINDOW)
    }

    /// A limiter with a custom window (tests).
    pub fn with_window(window: Duration) -> Self {
        Self {
            counters: Arc::new(
                moka::sync::Cache::builder()
                    .max_capacity(Self::CAPACITY)
                    .time_to_live(window)
                    .build(),
            ),
        }
    }

    /// Count one `frame` for `connection`; `false` once more than `limit`
    /// frames of that class were seen in the current window.
    pub fn admit(&self, connection: Uuid, frame: AnonymousFrame, limit: u32) -> bool {
        let counter = self
            .counters
            .get_with((connection, frame), || Arc::new(AtomicU32::new(0)));
        let seen = counter
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| {
                Some(n.saturating_add(1))
            })
            .unwrap_or(u32::MAX);
        seen < limit
    }
}

impl Default for AnonymousFrameLimiter {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Debug for AnonymousFrameLimiter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AnonymousFrameLimiter")
            .field("tracked_connections", &self.counters.entry_count())
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::kind::{
        KIND_AGENT_OBSERVER_FRAME, KIND_AUTH, KIND_HTTP_AUTH, KIND_PAIRING, KIND_PRESENCE_UPDATE,
        KIND_STREAM_MESSAGE, KIND_TYPING_INDICATOR,
    };
    use nostr::{EventBuilder, Keys, Kind, Tag};

    /// A kind Trystero could derive: ephemeral and not defined by Buzz.
    const TRYSTERO_KIND: u16 = 25_321;

    fn trystero_filter(kind: u16, topic: &str) -> Filter {
        Filter::new()
            .kind(Kind::Custom(kind))
            .custom_tag(SingleLetterTag::lowercase(Alphabet::X), topic)
    }

    fn signed(kind: u16, tags: Vec<Tag>, content: &str) -> Event {
        EventBuilder::new(Kind::Custom(kind), content)
            .tags(tags)
            .sign_with_keys(&Keys::generate())
            .expect("sign")
    }

    fn x_tag(topic: &str) -> Tag {
        Tag::parse(["x", topic]).expect("x tag")
    }

    #[test]
    fn trystero_shaped_traffic_is_admitted_by_default() {
        let policy = P2pSignalingPolicy::default();
        assert!(policy.filters_allowed(&[trystero_filter(TRYSTERO_KIND, "topic-a")]));
        assert!(policy.event_allowed(&signed(TRYSTERO_KIND, vec![x_tag("topic-a")], "{}")));
    }

    #[test]
    fn buzz_defined_and_reserved_kinds_are_never_admitted_even_when_listed() {
        // Widest possible operator config: the entire ephemeral window.
        let policy = P2pSignalingPolicy::from_values(Some("20000-29999"), None, None).unwrap();
        for kind in [
            KIND_PRESENCE_UPDATE,
            KIND_TYPING_INDICATOR,
            KIND_AGENT_OBSERVER_FRAME,
            KIND_PAIRING,
            KIND_AUTH,
            KIND_HTTP_AUTH,
            24133,
        ] {
            assert!(!policy.kind_allowed(kind), "kind {kind} must stay denied");
            let kind = kind as u16;
            assert!(!policy.filters_allowed(&[trystero_filter(kind, "t")]));
            assert!(!policy.event_allowed(&signed(kind, vec![x_tag("t")], "")));
        }
        // Stored kinds are never anonymous, whatever the allowlist says.
        assert!(!policy.kind_allowed(KIND_STREAM_MESSAGE));
        assert!(!policy.kind_allowed(30_023));
    }

    #[test]
    fn every_buzz_defined_ephemeral_kind_is_denied() {
        let policy = P2pSignalingPolicy::default();
        for &kind in ALL_KINDS.iter().filter(|kind| is_ephemeral(**kind)) {
            assert!(!policy.kind_allowed(kind), "kind {kind} is Buzz-defined");
        }
    }

    #[test]
    fn allowlist_narrows_admission() {
        let policy =
            P2pSignalingPolicy::from_values(Some("25000, 25010-25020"), None, None).unwrap();
        assert!(policy.kind_allowed(25_000));
        assert!(policy.kind_allowed(25_015));
        assert!(!policy.kind_allowed(25_001));
        assert!(!policy.kind_allowed(26_000));
    }

    #[test]
    fn filters_must_be_exactly_kinds_plus_topics() {
        let policy = P2pSignalingPolicy::default();
        let base = trystero_filter(TRYSTERO_KIND, "t");
        assert!(policy.filters_allowed(std::slice::from_ref(&base)));
        assert!(!policy.filters_allowed(&[]), "empty REQ");

        // Kindless / non-ephemeral.
        assert!(!policy.filters_allowed(&[
            Filter::new().custom_tag(SingleLetterTag::lowercase(Alphabet::X), "t")
        ]));
        assert!(!policy.filters_allowed(&[Filter::new()
            .kind(Kind::Custom(9))
            .custom_tag(SingleLetterTag::lowercase(Alphabet::X), "t")]));
        // No topic constraint: would read every event of the kind.
        assert!(!policy.filters_allowed(&[Filter::new().kind(Kind::Custom(TRYSTERO_KIND))]));
        // Widening fields.
        let keys = Keys::generate();
        assert!(!policy.filters_allowed(&[base.clone().author(keys.public_key())]));
        assert!(!policy.filters_allowed(&[base.clone().id(nostr::EventId::all_zeros())]));
        assert!(!policy.filters_allowed(&[base.clone().search("q")]));
        assert!(!policy.filters_allowed(&[base.clone().custom_tag(
            SingleLetterTag::lowercase(Alphabet::P),
            keys.public_key().to_hex()
        )]));
        assert!(!policy.filters_allowed(&[base
            .clone()
            .custom_tag(SingleLetterTag::lowercase(Alphabet::H), "channel")]));
        // One bad filter poisons the whole REQ (OR semantics would widen it).
        assert!(!policy.filters_allowed(&[
            base.clone(),
            trystero_filter(KIND_PRESENCE_UPDATE as u16, "t")
        ]));
    }

    #[test]
    fn filter_topic_and_kind_counts_are_bounded() {
        let policy = P2pSignalingPolicy::default();
        let mut too_many_topics = Filter::new().kind(Kind::Custom(TRYSTERO_KIND));
        for i in 0..=MAX_TOPICS_PER_FILTER {
            too_many_topics = too_many_topics
                .custom_tag(SingleLetterTag::lowercase(Alphabet::X), format!("t{i}"));
        }
        assert!(!policy.filters_allowed(&[too_many_topics]));

        let long_topic = "x".repeat(MAX_TOPIC_BYTES + 1);
        assert!(!policy.filters_allowed(&[trystero_filter(TRYSTERO_KIND, &long_topic)]));

        let at_limit = "x".repeat(MAX_TOPIC_BYTES);
        assert!(policy.filters_allowed(&[trystero_filter(TRYSTERO_KIND, &at_limit)]));

        let many_filters = vec![trystero_filter(TRYSTERO_KIND, "t"); MAX_FILTERS_PER_REQ + 1];
        assert!(!policy.filters_allowed(&many_filters));
    }

    #[test]
    fn events_need_exactly_one_topic_and_no_channel_tag() {
        let policy = P2pSignalingPolicy::default();
        assert!(
            !policy.event_allowed(&signed(TRYSTERO_KIND, vec![], "")),
            "no topic"
        );
        assert!(
            !policy.event_allowed(&signed(TRYSTERO_KIND, vec![x_tag("a"), x_tag("b")], "")),
            "two topics"
        );
        assert!(!policy.event_allowed(&signed(
            TRYSTERO_KIND,
            vec![
                x_tag("a"),
                Tag::parse(["h", "0b5a3ae1-2d7d-4f36-8c69-2d1a5a4c0a1b"]).unwrap()
            ],
            ""
        )));
        assert!(!policy.event_allowed(&signed(
            TRYSTERO_KIND,
            vec![Tag::parse(["x"]).unwrap()],
            ""
        )));
        let big = "z".repeat(MAX_EVENT_CONTENT_BYTES + 1);
        assert!(!policy.event_allowed(&signed(TRYSTERO_KIND, vec![x_tag("a")], &big)));
        let many_tags: Vec<Tag> = std::iter::once(x_tag("a"))
            .chain((0..MAX_EVENT_TAGS).map(|i| Tag::parse(["t", &i.to_string()]).unwrap()))
            .collect();
        assert!(!policy.event_allowed(&signed(TRYSTERO_KIND, many_tags, "")));
    }

    #[test]
    fn kinds_spec_rejects_stored_kinds_and_garbage() {
        for bad in [
            "9",
            "19999",
            "20000-30000",
            "abc",
            "25010-25000",
            "",
            ",",
            "1-2",
        ] {
            assert!(
                P2pSignalingPolicy::from_values(Some(bad), None, None).is_err(),
                "{bad:?} must be a startup error"
            );
        }
        assert!(P2pSignalingPolicy::from_values(Some("29999"), None, None).is_ok());
        assert!(P2pSignalingPolicy::from_values(Some("20000,25000-25001"), None, None).is_ok());
    }

    #[test]
    fn numeric_limits_are_validated() {
        for bad in ["0", "-1", "x", "65"] {
            assert!(
                P2pSignalingPolicy::from_values(None, Some(bad), None).is_err(),
                "{bad}"
            );
        }
        for bad in ["0", "x", "10001"] {
            assert!(
                P2pSignalingPolicy::from_values(None, None, Some(bad)).is_err(),
                "{bad}"
            );
        }
        let policy = P2pSignalingPolicy::from_values(None, Some("2"), Some("7")).unwrap();
        assert_eq!((policy.max_subscriptions, policy.frames_per_minute), (2, 7));
        let default = P2pSignalingPolicy::default();
        assert_eq!(
            default,
            P2pSignalingPolicy::from_values(None, None, None).unwrap(),
            "Default and the unset-env policy must agree"
        );
        assert_eq!(default.max_subscriptions, DEFAULT_MAX_SUBSCRIPTIONS);
        assert_eq!(default.frames_per_minute, DEFAULT_FRAMES_PER_MINUTE);
    }

    #[test]
    fn limiter_is_per_connection_and_per_frame_class() {
        let limiter = AnonymousFrameLimiter::new();
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        assert!(limiter.admit(a, AnonymousFrame::Event, 2));
        assert!(limiter.admit(a, AnonymousFrame::Event, 2));
        assert!(
            !limiter.admit(a, AnonymousFrame::Event, 2),
            "third frame is over budget"
        );
        assert!(
            limiter.admit(a, AnonymousFrame::Req, 2),
            "REQs have their own budget"
        );
        assert!(
            limiter.admit(b, AnonymousFrame::Event, 2),
            "other connections are unaffected"
        );
    }

    #[test]
    fn limiter_window_resets() {
        let limiter = AnonymousFrameLimiter::with_window(Duration::from_millis(80));
        let conn = Uuid::new_v4();
        assert!(limiter.admit(conn, AnonymousFrame::Event, 1));
        assert!(!limiter.admit(conn, AnonymousFrame::Event, 1));
        std::thread::sleep(Duration::from_millis(200));
        assert!(
            limiter.admit(conn, AnonymousFrame::Event, 1),
            "fresh window"
        );
    }
}
