//! A season: the operator's record of six weeks of open entry and the day its projects are shown together.
//!
//! The record is kind 37021 ([`crate::kind::KIND_SEASON`]): one `d` tag, `season-<n>`, and a small JSON content with
//! the season's number and its three dates. The relay holds every season record to the bounds below when it is
//! written, and `buzz launchpad seasons start` holds the one it is about to sign to the very same function, so the two
//! cannot drift. Who may sign one (an operator of the server) and who may enter a project are the relay's to judge;
//! see `docs/next-version/ROOM-AND-SEASON-RECORDS.md`.

use nostr::Event;
use serde_json::{json, Value};

use crate::kind::KIND_SEASON;

/// The largest season number.
pub const NUMBER_MAX: u32 = 9_999;
/// The most bytes of a season record's content.
pub const CONTENT_MAX: usize = 1_024;
/// One day in seconds.
pub const DAY: u64 = 86_400;
/// The longest from the start to demo day, in days.
pub const TO_DEMO_DAYS_MAX: u64 = 56;
/// The longest from demo day to the end, in days.
pub const AFTER_DEMO_DAYS_MAX: u64 = 14;
/// 1 January 2020 in unix seconds: no season starts before it.
pub const DATE_MIN: u64 = 1_577_836_800;
/// 1 January 2100 in unix seconds: no season ends at or after it.
pub const DATE_MAX: u64 = 4_102_444_800;

/// A season, as its record says.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Season {
    /// Its number, from 1.
    pub number: u32,
    /// When entry opens (unix seconds).
    pub starts_at: u64,
    /// Demo day: entry ends and the projects are shown.
    pub demo_day_at: u64,
    /// When the season ends.
    pub ends_at: u64,
}

impl Season {
    /// Whether entry and leave are open at `now`: from the start up to, not including, demo day.
    pub fn is_open(&self, now: u64) -> bool {
        (self.starts_at..self.demo_day_at).contains(&now)
    }

    /// The record's `d` tag value.
    pub fn d(&self) -> String {
        season_d(self.number)
    }

    /// The record's content, as JSON text.
    pub fn content(&self) -> String {
        json!({
            "v": 1,
            "number": self.number,
            "startsAt": self.starts_at,
            "demoDayAt": self.demo_day_at,
            "endsAt": self.ends_at,
        })
        .to_string()
    }

    /// Hold the season to its bounds: its number from 1 to [`NUMBER_MAX`]; the start before demo day, demo day not
    /// after the end; a day to [`TO_DEMO_DAYS_MAX`] days to demo day and at most [`AFTER_DEMO_DAYS_MAX`] after it; whole
    /// seconds from [`DATE_MIN`] up to, not including, [`DATE_MAX`].
    pub fn check(&self) -> Result<(), &'static str> {
        if !(1..=NUMBER_MAX).contains(&self.number) {
            return Err("the season's number is from 1 to 9999");
        }
        if self.starts_at >= self.demo_day_at || self.demo_day_at > self.ends_at {
            return Err("the dates run start, demo day, end");
        }
        let to_demo = self.demo_day_at - self.starts_at;
        if !(DAY..=TO_DEMO_DAYS_MAX * DAY).contains(&to_demo) {
            return Err("demo day is from 1 to 56 days after the start");
        }
        if self.ends_at - self.demo_day_at > AFTER_DEMO_DAYS_MAX * DAY {
            return Err("the season ends at most 14 days after demo day");
        }
        if self.starts_at < DATE_MIN || self.ends_at >= DATE_MAX {
            return Err("the dates are from 2020 to 2099");
        }
        Ok(())
    }
}

/// The `d` tag of season `number`'s record.
pub fn season_d(number: u32) -> String {
    format!("season-{number}")
}

/// A canonical decimal season number (no sign, no leading zero) from 1 to [`NUMBER_MAX`].
pub fn parse_number(text: &str) -> Option<u32> {
    if text.is_empty() || text.len() > 4 || text.starts_with('0') {
        return None;
    }
    if !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse::<u32>()
        .ok()
        .filter(|n| (1..=NUMBER_MAX).contains(n))
}

/// The number of a `season-<n>` text, when it is canonical.
pub fn parse_d(text: &str) -> Option<u32> {
    parse_number(text.strip_prefix("season-")?)
}

/// Read a season record: kind 37021, one `d` tag equal to `season-<number>`, content within [`CONTENT_MAX`] bytes that
/// is a JSON object with `v` 1, the number and the three dates, all within [`Season::check`]. Who signed it is not asked.
pub fn parse_record(event: &Event) -> Result<Season, &'static str> {
    const BAD: &str = "a season names its number, and its dates run start, demo day, end";
    if u32::from(event.kind.as_u16()) != KIND_SEASON || event.content.len() > CONTENT_MAX {
        return Err(BAD);
    }
    let mut ds = event.tags.iter().filter_map(|tag| {
        let parts = tag.as_slice();
        (parts.first().map(String::as_str) == Some("d"))
            .then(|| parts.get(1).cloned().unwrap_or_default())
    });
    let (Some(d), None) = (ds.next(), ds.next()) else {
        return Err(BAD);
    };
    let body: Value = serde_json::from_str(&event.content).map_err(|_| BAD)?;
    let field = |name: &str| body.get(name).and_then(Value::as_u64);
    let number = field("number")
        .and_then(|n| u32::try_from(n).ok())
        .ok_or(BAD)?;
    if body.get("v").and_then(Value::as_u64) != Some(1) || d != season_d(number) {
        return Err(BAD);
    }
    let (Some(starts_at), Some(demo_day_at), Some(ends_at)) =
        (field("startsAt"), field("demoDayAt"), field("endsAt"))
    else {
        return Err(BAD);
    };
    let season = Season {
        number,
        starts_at,
        demo_day_at,
        ends_at,
    };
    season.check().map_err(|_| BAD)?;
    Ok(season)
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: u64 = 1_800_000_000;

    fn season(starts: u64, demo: u64, end: u64) -> Season {
        Season {
            number: 1,
            starts_at: starts,
            demo_day_at: demo,
            ends_at: end,
        }
    }

    #[test]
    fn the_bounds_of_a_season_are_inclusive_where_the_record_says_and_not_otherwise() {
        assert!(season(T0, T0 + DAY, T0 + DAY).check().is_ok());
        assert!(season(T0, T0 + 56 * DAY, T0 + 70 * DAY).check().is_ok());
        assert!(season(T0, T0 + DAY - 1, T0 + DAY).check().is_err());
        assert!(season(T0, T0 + 56 * DAY + 1, T0 + 57 * DAY)
            .check()
            .is_err());
        assert!(season(T0, T0 + 2 * DAY, T0 + 16 * DAY + 1).check().is_err());
        assert!(season(T0, T0 + 2 * DAY, T0 + 2 * DAY - 1).check().is_err());
        assert!(season(T0, T0, T0 + DAY).check().is_err());
        assert!(season(DATE_MIN - 1, DATE_MIN + DAY, DATE_MIN + DAY)
            .check()
            .is_err());
        assert!(season(DATE_MIN, DATE_MIN + DAY, DATE_MIN + DAY)
            .check()
            .is_ok());
        assert!(season(DATE_MAX - 2 * DAY, DATE_MAX - DAY, DATE_MAX)
            .check()
            .is_err());
        assert!(season(DATE_MAX - 3 * DAY, DATE_MAX - 2 * DAY, DATE_MAX - 1)
            .check()
            .is_ok());
        for number in [0, NUMBER_MAX + 1] {
            let bad = Season {
                number,
                ..season(T0, T0 + DAY, T0 + DAY)
            };
            assert!(bad.check().is_err(), "{number}");
        }
    }

    #[test]
    fn numbers_are_canonical_decimals() {
        for (text, number) in [("1", Some(1)), ("9999", Some(9_999)), ("12", Some(12))] {
            assert_eq!(parse_number(text), number, "{text}");
        }
        for bad in ["", "0", "01", "10000", "-1", "+1", "1.0", "a", "١"] {
            assert_eq!(parse_number(bad), None, "{bad}");
        }
        assert_eq!(parse_d("season-7"), Some(7));
        assert_eq!(parse_d("season-07"), None);
        assert_eq!(parse_d("7"), None);
    }

    #[test]
    fn a_record_round_trips_through_its_content() {
        use nostr::{EventBuilder, Keys, Kind, Tag};
        let s = Season {
            number: 4,
            ..season(T0, T0 + 42 * DAY, T0 + 49 * DAY)
        };
        let event = EventBuilder::new(Kind::Custom(KIND_SEASON as u16), s.content())
            .tags([Tag::parse(["d", &s.d()]).expect("tag")])
            .sign_with_keys(&Keys::generate())
            .expect("sign");
        assert_eq!(parse_record(&event), Ok(s));
    }
}
