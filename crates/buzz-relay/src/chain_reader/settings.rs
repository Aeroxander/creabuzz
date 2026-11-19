//! The chain reader's settings, read from the environment.
//!
//! The reader is off unless `BUZZ_CHAIN_RPC_URL` is set. When it is set, the
//! chain id and the Launcher must be set too; any value that is set but cannot
//! be read stops startup rather than silently turning the reader off or
//! reading a different chain. A `BUZZ_CHAIN_*` setting without the RPC URL
//! also stops startup: half a configuration is a mistake, not "off".

/// Chain reader settings (`BUZZ_CHAIN_*`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChainReaderConfig {
    /// JSON-RPC URL of a node (`BUZZ_CHAIN_RPC_URL`).
    pub rpc_url: String,
    /// The chain id the node must serve (`BUZZ_CHAIN_ID`).
    pub chain_id: u64,
    /// The Launcher (`BUZZ_CHAIN_LAUNCHER`); each project's own contracts are
    /// found in its events.
    pub launcher: [u8; 20],
    /// The first block to read (`BUZZ_CHAIN_START_BLOCK`, default 0): the
    /// Launcher's deployment block.
    pub start_block: u64,
    /// Blocks a log must be under the head before the numbers count it
    /// (`BUZZ_CHAIN_CONFIRMATIONS`, default 12). The reader reads no block
    /// above that; below [`super::MIN_LAG`] it acts as `MIN_LAG`.
    pub confirmations: u64,
    /// Seconds between passes (`BUZZ_CHAIN_POLL_SECS`, default 12).
    pub poll_secs: u64,
    /// Seconds after which a record whose time-dependent numbers moved is
    /// signed again even with no new event, for a project whose allowance is
    /// idle and that has no money arriving: the heartbeat
    /// (`BUZZ_CHAIN_REFRESH_SECS`, default 3600).
    pub refresh_secs: u64,
    /// The same while the allowance is accruing or outside money is arriving
    /// (`BUZZ_CHAIN_ACTIVE_REFRESH_SECS`, default 600).
    pub active_refresh_secs: u64,
    /// Blocks per log request (`BUZZ_CHAIN_LOG_RANGE`, default 2000, at most
    /// 10000).
    pub log_range: u64,
    /// The community whose events receive the records
    /// (`BUZZ_CHAIN_COMMUNITY_HOST`); defaults to the host of `BUZZ_RELAY_URL`.
    pub community_host: Option<String>,
    /// The helper job (`BUZZ_CHAIN_HELPER_*`): off unless its key is set.
    pub helper: Option<super::helper::HelperConfig>,
}

/// The least a record may promise as its refresh, in seconds (a test network showing the cadence). The app believes no
/// promise below this.
pub const MIN_REFRESH_SECS: u64 = 5;

/// The most a record may promise as its refresh: one day. The record's `refreshEverySecs` is what the app reads, and
/// the app accepts no promise above 86400 seconds (RECORD-V2 section 6: older than a day is "not refreshed"), so the
/// settings end where the app's range ends. A setting at the ceiling is a range limit, not a recommendation: the app calls
/// a record "stale" once it is older than a day, so a server that re-signs only every 86400 seconds leaves each record
/// stale for as long as the next pass takes. Set it to at most half a day (43200) to keep records fresh all day.
pub const MAX_REFRESH_SECS: u64 = 86_400;

const VARS: [&str; 9] = [
    "BUZZ_CHAIN_ID",
    "BUZZ_CHAIN_LAUNCHER",
    "BUZZ_CHAIN_START_BLOCK",
    "BUZZ_CHAIN_CONFIRMATIONS",
    "BUZZ_CHAIN_POLL_SECS",
    "BUZZ_CHAIN_REFRESH_SECS",
    "BUZZ_CHAIN_ACTIVE_REFRESH_SECS",
    "BUZZ_CHAIN_LOG_RANGE",
    "BUZZ_CHAIN_COMMUNITY_HOST",
];

fn var(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
}

fn number(name: &str, default: u64, min: u64, max: u64) -> Result<u64, String> {
    match var(name) {
        None => Ok(default),
        Some(raw) => match raw.parse::<u64>() {
            Ok(v) if (min..=max).contains(&v) => Ok(v),
            _ => Err(format!(
                "{name} must be a whole number from {min} to {max} (got \"{raw}\")"
            )),
        },
    }
}

impl ChainReaderConfig {
    /// Read the settings; `Ok(None)` when the reader is off.
    pub fn from_env() -> Result<Option<Self>, String> {
        let Some(rpc_url) = var("BUZZ_CHAIN_RPC_URL") else {
            let helper_vars = super::helper::settings::OTHER_VARS
                .iter()
                .chain(std::iter::once(&"BUZZ_CHAIN_HELPER_KEY"));
            if let Some(set) = VARS.iter().chain(helper_vars).find(|v| var(v).is_some()) {
                return Err(format!(
                    "{set} is set but BUZZ_CHAIN_RPC_URL is not; set both to read the chain, or neither"
                ));
            }
            return Ok(None);
        };
        if !(rpc_url.starts_with("http://") || rpc_url.starts_with("https://")) {
            return Err(format!(
                "BUZZ_CHAIN_RPC_URL must be an http(s) URL (got \"{rpc_url}\")"
            ));
        }
        let chain_id = match var("BUZZ_CHAIN_ID") {
            None => return Err("BUZZ_CHAIN_ID is required with BUZZ_CHAIN_RPC_URL".into()),
            Some(raw) => match raw.parse::<u64>() {
                Ok(v) if v > 0 => v,
                _ => {
                    return Err(format!(
                        "BUZZ_CHAIN_ID must be a positive integer chain id (got \"{raw}\")"
                    ))
                }
            },
        };
        let launcher = match var("BUZZ_CHAIN_LAUNCHER") {
            None => return Err("BUZZ_CHAIN_LAUNCHER is required with BUZZ_CHAIN_RPC_URL".into()),
            Some(raw) => super::word::parse_fixed::<20>(&raw)
                .filter(|a| *a != [0u8; 20] && raw.starts_with("0x"))
                .ok_or_else(|| {
                    format!("BUZZ_CHAIN_LAUNCHER must be a 0x address (got \"{raw}\")")
                })?,
        };
        let poll_secs = number("BUZZ_CHAIN_POLL_SECS", 12, 1, 86_400)?;
        let mut helper = super::helper::HelperConfig::from_env()?;
        if let Some(h) = helper.as_mut() {
            // Jobs are built at most every five passes (5 s to a minute).
            h.build_every_secs = (poll_secs * 5).clamp(5, 60);
        }
        Ok(Some(Self {
            rpc_url,
            chain_id,
            launcher,
            start_block: number("BUZZ_CHAIN_START_BLOCK", 0, 0, i64::MAX as u64 / 2)?,
            confirmations: number("BUZZ_CHAIN_CONFIRMATIONS", 12, 0, 10_000)?,
            poll_secs,
            refresh_secs: number(
                "BUZZ_CHAIN_REFRESH_SECS",
                3_600,
                MIN_REFRESH_SECS,
                MAX_REFRESH_SECS,
            )?,
            active_refresh_secs: number(
                "BUZZ_CHAIN_ACTIVE_REFRESH_SECS",
                600,
                MIN_REFRESH_SECS,
                MAX_REFRESH_SECS,
            )?,
            log_range: number("BUZZ_CHAIN_LOG_RANGE", 2_000, 1, 10_000)?,
            community_host: var("BUZZ_CHAIN_COMMUNITY_HOST").map(|h| h.to_ascii_lowercase()),
            helper,
        }))
    }

    /// The name the reader's rows are kept under: `<chain id>:<launcher>`.
    pub fn reader_id(&self) -> String {
        format!("{}:{}", self.chain_id, super::word::hex0x(&self.launcher))
    }
}
