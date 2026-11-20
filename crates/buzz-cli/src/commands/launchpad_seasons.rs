//! `buzz launchpad seasons`: the operator's three commands for a season.
//!
//! A season is a six-week group of projects with open entry; demo day is the day its projects are shown together
//! (`docs/next-version/ROOM-AND-SEASON-RECORDS.md`). Only an operator of the server (a key in `RELAY_OPERATOR_PUBKEYS`,
//! or the relay's owner when that list is empty) may start one or take a project out of one; the key is the one in
//! `BUZZ_PRIVATE_KEY`, as for every `buzz` command, and nothing is written to a file.
//!
//! * `start` prints the three dates before it signs, and refuses a number that exists unless `--replace` is given
//!   (a later record with the same number is how a date moves). The dates are held to the very bounds the server
//!   holds them to (`buzz_core::season`).
//! * `show` prints the seasons the server holds.
//! * `remove` signs a `season-remove` for a project: it wins over the project's entry in that season, before or
//!   after, and the project cannot enter that season again.

use buzz_core::kind::{KIND_LAUNCH_RECORD, KIND_LAUNCH_UPDATE, KIND_SEASON};
use buzz_core::season::{season_d, Season, DAY};
use chrono::{DateTime, SecondsFormat, Utc};
use clap::Subcommand;
use nostr::{Event, EventBuilder, Kind, Tag};
use serde_json::{json, Value};

use crate::client::BuzzClient;
use crate::commands::parse_write_response;
use crate::error::CliError;

/// The seasons of the server, and how to start one.
#[derive(Subcommand)]
pub enum SeasonsCmd {
    /// Start a season: a six-week group of projects with open entry, then a demo week
    #[command(
        after_help = "Prints the three dates before it signs. A number that exists is refused unless --replace is \
given (publishing the same number again is how a date moves). Only an operator of the server may start a season.\n\n\
Examples:\n  buzz launchpad seasons start --number 1\n  \
buzz launchpad seasons start --number 2 --starts 2027-02-01T09:00:00Z --days 42 --demo-week-days 7"
    )]
    Start {
        /// The season's number, from 1
        #[arg(long)]
        number: u32,
        /// When entry opens: an RFC 3339 time, or `now`
        #[arg(long, default_value = "now")]
        starts: String,
        /// Days from the start to demo day
        #[arg(long, default_value_t = 42)]
        days: u64,
        /// Days from demo day to the end of the season
        #[arg(long = "demo-week-days", default_value_t = 7)]
        demo_week_days: u64,
        /// Replace the season of this number if it exists (move its dates)
        #[arg(long, default_value_t = false)]
        replace: bool,
    },
    /// Print the seasons the server holds (all, or one number) as JSON
    Show {
        /// Only this season
        #[arg(long)]
        number: Option<u32>,
    },
    /// Take a project out of a season, for good: signs a `season-remove` that wins over its entry
    #[command(
        after_help = "The project is named by its page link's last part (`orbit-ab12cd34ef56ab78`, or the whole \
`/p/...` path) or by its address (`37001:<founder key>:<id>`). Only an operator of the server may do this."
    )]
    Remove {
        /// The season's number
        #[arg(long)]
        number: u32,
        /// The project: its link's last part, or its address
        #[arg(long)]
        project: String,
    },
}

fn tag(parts: &[&str]) -> Result<Tag, CliError> {
    Tag::parse(parts.iter().copied()).map_err(|e| CliError::Other(format!("bad tag: {e}")))
}

/// The unix seconds of an RFC 3339 time, or of now for `now`.
fn start_time(starts: &str, now: u64) -> Result<u64, CliError> {
    if starts.trim() == "now" {
        return Ok(now);
    }
    let at = DateTime::parse_from_rfc3339(starts.trim()).map_err(|_| {
        CliError::Usage("--starts is `now` or an RFC 3339 time such as 2027-02-01T09:00:00Z".into())
    })?;
    u64::try_from(at.timestamp()).map_err(|_| CliError::Usage("--starts is before 1970".into()))
}

/// The season `number` that starts at `starts`, `days` days to demo day and `demo_week_days` more to its end, held to
/// the bounds the server holds it to.
pub(crate) fn plan(
    number: u32,
    starts: &str,
    days: u64,
    demo_week_days: u64,
    now: u64,
) -> Result<Season, CliError> {
    let starts_at = start_time(starts, now)?;
    let too_big = || CliError::Usage("those dates are too far out".into());
    let demo_day_at = days
        .checked_mul(DAY)
        .and_then(|d| starts_at.checked_add(d))
        .ok_or_else(too_big)?;
    let ends_at = demo_week_days
        .checked_mul(DAY)
        .and_then(|d| demo_day_at.checked_add(d))
        .ok_or_else(too_big)?;
    let season = Season {
        number,
        starts_at,
        demo_day_at,
        ends_at,
    };
    season.check().map_err(|reason| {
        CliError::Usage(format!("not a season the server will take: {reason}"))
    })?;
    Ok(season)
}

fn rfc3339(seconds: u64) -> String {
    i64::try_from(seconds)
        .ok()
        .and_then(|s| DateTime::<Utc>::from_timestamp(s, 0))
        .map_or_else(
            || seconds.to_string(),
            |at| at.to_rfc3339_opts(SecondsFormat::Secs, true),
        )
}

/// The three dates of a season, as the command prints them before it signs.
pub(crate) fn describe(season: &Season) -> String {
    format!(
        "Season {}\n  entry opens  {} ({})\n  demo day     {} ({})\n  ends         {} ({})",
        season.number,
        rfc3339(season.starts_at),
        season.starts_at,
        rfc3339(season.demo_day_at),
        season.demo_day_at,
        rfc3339(season.ends_at),
        season.ends_at,
    )
}

/// The record `start` signs: kind 37021 with the season's `d` and its content.
pub(crate) fn season_builder(season: &Season) -> Result<EventBuilder, CliError> {
    Ok(
        EventBuilder::new(Kind::Custom(KIND_SEASON as u16), season.content())
            .tags([tag(&["d", &season.d()])?]),
    )
}

/// The project a `--project` names: its id and either the founder's whole key or its first 16 digits.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ProjectRef {
    /// The project's full address.
    Address { founder: String, id: String },
    /// The project's link: its id and the start of its founder's key.
    Link { id: String, founder_start: String },
}

fn is_hex(text: &str) -> bool {
    text.bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Read `--project`: an address `37001:<64 hex>:<id>`, a link's last part `<id>-<16 hex>`, or a page path ending in one.
pub(crate) fn parse_project(text: &str) -> Result<ProjectRef, CliError> {
    let bad = || {
        CliError::Usage(
            "--project is the project's link (`orbit-ab12cd34ef56ab78`) or its address (`37001:<founder key>:<id>`)"
                .into(),
        )
    };
    let text = text.trim();
    if let Some(rest) = text.strip_prefix(&format!("{KIND_LAUNCH_RECORD}:")) {
        let (founder, id) = rest.split_once(':').ok_or_else(bad)?;
        if founder.len() == 64 && is_hex(founder) && !id.is_empty() {
            return Ok(ProjectRef::Address {
                founder: founder.to_owned(),
                id: id.to_owned(),
            });
        }
        return Err(bad());
    }
    // A page path or a whole link: the last part is the reference.
    let last = text
        .split(['?', '#'])
        .next()
        .unwrap_or("")
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("");
    let (id, founder_start) = last.rsplit_once('-').ok_or_else(bad)?;
    if id.is_empty() || founder_start.len() != 16 || !is_hex(founder_start) {
        return Err(bad());
    }
    Ok(ProjectRef::Link {
        id: id.to_owned(),
        founder_start: founder_start.to_owned(),
    })
}

/// The address of the project a reference names: a link is resolved against the project records the server holds
/// (exactly one founder whose key starts so, with that id).
async fn coordinate_of(client: &BuzzClient, project: &ProjectRef) -> Result<String, CliError> {
    match project {
        ProjectRef::Address { founder, id } => Ok(format!("{KIND_LAUNCH_RECORD}:{founder}:{id}")),
        ProjectRef::Link { id, founder_start } => {
            let records = client
                .query_pages_bounded(json!({ "kinds": [KIND_LAUNCH_RECORD], "#d": [id] }), 50)
                .await?;
            let mut founders: Vec<String> = records
                .into_iter()
                .filter_map(|record| serde_json::from_value::<Event>(record).ok())
                .map(|event| event.pubkey.to_hex())
                .filter(|founder| founder.starts_with(founder_start.as_str()))
                .collect();
            founders.sort();
            founders.dedup();
            match founders.as_slice() {
                [founder] => Ok(format!("{KIND_LAUNCH_RECORD}:{founder}:{id}")),
                [] => Err(CliError::NotFound(format!(
                    "no project {id:?} by a founder whose key starts {founder_start}"
                ))),
                _ => Err(CliError::Usage(
                    "that link names more than one project; use its address (`37001:<founder key>:<id>`)".into(),
                )),
            }
        }
    }
}

/// The record `remove` signs: kind 47003 naming the project, the season's topic and the removal.
pub(crate) fn removal_builder(number: u32, coordinate: &str) -> Result<EventBuilder, CliError> {
    Ok(
        EventBuilder::new(Kind::Custom(KIND_LAUNCH_UPDATE as u16), "{}").tags([
            tag(&["a", coordinate])?,
            tag(&["t", &season_d(number)])?,
            tag(&["season-remove", &number.to_string()])?,
        ]),
    )
}

async fn read_seasons(client: &BuzzClient, number: Option<u32>) -> Result<Vec<Event>, CliError> {
    let mut filter = json!({ "kinds": [KIND_SEASON], "limit": 50 });
    if let Some(number) = number {
        filter["#d"] = json!([season_d(number)]);
    }
    let raw = client.query(&filter).await?;
    let events: Vec<Event> = serde_json::from_str(&raw)
        .map_err(|e| CliError::Other(format!("failed to parse relay response: {e}")))?;
    Ok(events)
}

async fn cmd_start(
    client: &BuzzClient,
    number: u32,
    starts: &str,
    days: u64,
    demo_week_days: u64,
    replace: bool,
) -> Result<(), CliError> {
    let now = u64::try_from(Utc::now().timestamp()).unwrap_or(0);
    let season = plan(number, starts, days, demo_week_days, now)?;
    // The dates first, so the operator sees what is about to be signed.
    eprintln!("{}", describe(&season));
    if !replace
        && read_seasons(client, Some(number))
            .await?
            .iter()
            .any(|event| buzz_core::season::parse_record(event).is_ok())
    {
        return Err(CliError::Usage(format!(
            "season {number} already exists; pass --replace to move its dates"
        )));
    }
    let event = client.sign_event(season_builder(&season)?)?;
    let raw = client.submit_event(event).await?;
    println!(
        "{}",
        parse_write_response(&raw, "the server already has this season")?
    );
    Ok(())
}

async fn cmd_show(client: &BuzzClient, number: Option<u32>) -> Result<(), CliError> {
    let now = u64::try_from(Utc::now().timestamp()).unwrap_or(0);
    let mut seasons: Vec<Value> = read_seasons(client, number)
        .await?
        .iter()
        .filter_map(|event| {
            let season = buzz_core::season::parse_record(event).ok()?;
            Some(json!({
                "number": season.number,
                "startsAt": season.starts_at,
                "demoDayAt": season.demo_day_at,
                "endsAt": season.ends_at,
                "startsAtText": rfc3339(season.starts_at),
                "demoDayAtText": rfc3339(season.demo_day_at),
                "endsAtText": rfc3339(season.ends_at),
                "openForEntry": season.is_open(now),
                "signer": event.pubkey.to_hex(),
                "id": event.id.to_hex(),
            }))
        })
        .collect();
    seasons.sort_by_key(|season| season["number"].as_u64());
    println!("{}", Value::Array(seasons));
    Ok(())
}

async fn cmd_remove(client: &BuzzClient, number: u32, project: &str) -> Result<(), CliError> {
    if buzz_core::season::parse_number(&number.to_string()).is_none() {
        return Err(CliError::Usage("--number is from 1 to 9999".into()));
    }
    let coordinate = coordinate_of(client, &parse_project(project)?).await?;
    let event = client.sign_event(removal_builder(number, &coordinate)?)?;
    let raw = client.submit_event(event).await?;
    println!(
        "{}",
        parse_write_response(&raw, "the server already has this removal")?
    );
    Ok(())
}

/// Run one `buzz launchpad seasons` command.
pub async fn dispatch(cmd: SeasonsCmd, client: &BuzzClient) -> Result<(), CliError> {
    match cmd {
        SeasonsCmd::Start {
            number,
            starts,
            days,
            demo_week_days,
            replace,
        } => cmd_start(client, number, &starts, days, demo_week_days, replace).await,
        SeasonsCmd::Show { number } => cmd_show(client, number).await,
        SeasonsCmd::Remove { number, project } => cmd_remove(client, number, &project).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::Keys;

    const NOW: u64 = 1_800_000_000;

    #[test]
    fn the_defaults_are_six_weeks_to_demo_day_and_a_demo_week() {
        let season = plan(3, "now", 42, 7, NOW).expect("a season");
        assert_eq!(
            season,
            Season {
                number: 3,
                starts_at: NOW,
                demo_day_at: NOW + 42 * DAY,
                ends_at: NOW + 49 * DAY,
            }
        );
        let text = describe(&season);
        // The three dates are in what is printed before anything is signed.
        for at in [season.starts_at, season.demo_day_at, season.ends_at] {
            assert!(text.contains(&rfc3339(at)), "{text}");
            assert!(text.contains(&at.to_string()), "{text}");
        }
        let at = plan(1, "2027-02-01T09:00:00Z", 42, 7, NOW).expect("a season");
        assert_eq!(rfc3339(at.starts_at), "2027-02-01T09:00:00Z");
    }

    #[test]
    fn dates_the_server_would_refuse_are_refused_before_anything_is_signed() {
        for (days, week) in [(0, 7), (57, 7), (42, 15), (u64::MAX, 7), (42, u64::MAX)] {
            assert!(plan(1, "now", days, week, NOW).is_err(), "{days} {week}");
        }
        assert!(plan(0, "now", 42, 7, NOW).is_err());
        assert!(plan(10_000, "now", 42, 7, NOW).is_err());
        assert!(plan(1, "soon", 42, 7, NOW).is_err());
        assert!(plan(1, "2019-12-31T00:00:00Z", 42, 7, NOW).is_err());
        assert!(plan(1, "now", 56, 14, NOW).is_ok());
        assert!(plan(1, "now", 1, 0, NOW).is_ok());
    }

    /// The record `start` signs is the one the server's rule reads back: the same function that holds the server's
    /// dates reads it, and it names the same season.
    #[test]
    fn the_record_start_signs_is_the_one_the_servers_rule_accepts() {
        let season = plan(2, "now", 42, 7, NOW).expect("a season");
        let event = season_builder(&season)
            .expect("builder")
            .sign_with_keys(&Keys::generate())
            .expect("sign");
        assert_eq!(u32::from(event.kind.as_u16()), KIND_SEASON);
        assert_eq!(buzz_core::season::parse_record(&event), Ok(season));
        assert_eq!(
            event
                .tags
                .iter()
                .filter_map(|t| {
                    let parts = t.as_slice();
                    (parts.first().map(String::as_str) == Some("d")).then(|| parts[1].clone())
                })
                .collect::<Vec<_>>(),
            vec!["season-2".to_owned()]
        );
    }

    #[test]
    fn a_removal_names_the_project_the_season_and_the_family() {
        let coordinate = format!("37001:{}:orbit", "ab".repeat(32));
        let event = removal_builder(4, &coordinate)
            .expect("builder")
            .sign_with_keys(&Keys::generate())
            .expect("sign");
        assert_eq!(u32::from(event.kind.as_u16()), KIND_LAUNCH_UPDATE);
        let tags: Vec<Vec<String>> = event.tags.iter().map(|t| t.as_slice().to_vec()).collect();
        assert_eq!(
            tags,
            vec![
                vec!["a".to_owned(), coordinate],
                vec!["t".to_owned(), "season-4".to_owned()],
                vec!["season-remove".to_owned(), "4".to_owned()],
            ]
        );
    }

    #[test]
    fn a_project_is_named_by_its_link_or_its_address() {
        let founder = "ab".repeat(32);
        assert_eq!(
            parse_project(&format!("37001:{founder}:orbit")).expect("address"),
            ProjectRef::Address {
                founder: founder.clone(),
                id: "orbit".into()
            }
        );
        let link = ProjectRef::Link {
            id: "star-atlas".into(),
            founder_start: "ab".repeat(8),
        };
        for text in [
            "star-atlas-abababababababab",
            "/p/star-atlas-abababababababab",
            "https://creaton.example/p/star-atlas-abababababababab?x=1",
            "https://creaton.example/p/star-atlas-abababababababab/",
        ] {
            assert_eq!(parse_project(text).expect(text), link, "{text}");
        }
        for bad in [
            "",
            "orbit",
            "orbit-xyz",
            "orbit-ABABABABABABABAB",
            "-abababababababab",
            "37001:short:orbit",
            "37001:abab",
        ] {
            assert!(parse_project(bad).is_err(), "{bad}");
        }
    }
}
