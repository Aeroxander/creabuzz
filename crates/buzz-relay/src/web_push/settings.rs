//! Web push settings, read from the environment.
//!
//! Push is **off** unless the operator sets both of `BUZZ_WEB_PUSH_VAPID_PRIVATE_KEY` and `BUZZ_WEB_PUSH_SUBJECT`. One of
//! the two without the other is a startup error that names both (half a configuration is a mistake, not "off"), and so
//! is any other `BUZZ_WEB_PUSH_*` setting without them. The key is read here and nowhere else, is never written to a
//! file and never printed.

use super::vapid::VapidKey;

/// The operator's own VAPID signing key (`BUZZ_WEB_PUSH_VAPID_PRIVATE_KEY`).
pub const KEY_VAR: &str = "BUZZ_WEB_PUSH_VAPID_PRIVATE_KEY";
/// The operator's contact for the push services (`BUZZ_WEB_PUSH_SUBJECT`).
pub const SUBJECT_VAR: &str = "BUZZ_WEB_PUSH_SUBJECT";
/// Alerts per device per UTC day (`BUZZ_WEB_PUSH_DAILY_CAP`).
pub const DAILY_CAP_VAR: &str = "BUZZ_WEB_PUSH_DAILY_CAP";
/// Devices per account (`BUZZ_WEB_PUSH_MAX_PER_ACCOUNT`).
pub const MAX_PER_ACCOUNT_VAR: &str = "BUZZ_WEB_PUSH_MAX_PER_ACCOUNT";
/// Extra push hosts, for a local stand-in only (`BUZZ_WEB_PUSH_EXTRA_HOSTS`).
pub const EXTRA_HOSTS_VAR: &str = "BUZZ_WEB_PUSH_EXTRA_HOSTS";

/// Alerts one device may get in a UTC day, unless the operator sets another number.
pub const DEFAULT_DAILY_CAP: u32 = 6;
/// Alerts one device may get about one project in a UTC day.
pub const PROJECT_DAILY_CAP: u32 = 3;
/// Devices one account may keep, unless the operator sets another number.
pub const DEFAULT_MAX_PER_ACCOUNT: u32 = 5;

/// Web push settings (`BUZZ_WEB_PUSH_*`). Present only when push is on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WebPushConfig {
    /// The VAPID key. Never printed.
    pub vapid: VapidKey,
    /// The `sub` of the VAPID token: the operator's own `mailto:` or `https:` contact.
    pub subject: String,
    /// Alerts per device per UTC day.
    pub daily_cap: u32,
    /// Devices per account.
    pub max_per_account: u32,
    /// Exact `host[:port]` entries allowed as push endpoints in addition to the known services (a local stand-in).
    pub extra_hosts: Vec<String>,
}

fn var(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
}

fn number(name: &str, default: u32, min: u32, max: u32) -> Result<u32, String> {
    match var(name) {
        None => Ok(default),
        Some(raw) => match raw.parse::<u32>() {
            Ok(v) if (min..=max).contains(&v) => Ok(v),
            _ => Err(format!(
                "{name} must be a whole number from {min} to {max} (got \"{raw}\")"
            )),
        },
    }
}

/// A contact the push services can use: a `mailto:` address or an `https:` address.
fn subject_ok(subject: &str) -> bool {
    let valid_mail = subject
        .strip_prefix("mailto:")
        .is_some_and(|m| m.contains('@') && !m.contains(char::is_whitespace));
    let valid_web = subject
        .strip_prefix("https://")
        .is_some_and(|h| !h.is_empty() && !h.contains(char::is_whitespace));
    (valid_mail || valid_web) && subject.len() <= 200
}

impl WebPushConfig {
    /// Read the settings; `Ok(None)` when push is off.
    pub fn from_env() -> Result<Option<Self>, String> {
        let key = var(KEY_VAR);
        let subject = var(SUBJECT_VAR);
        let (key, subject) = match (key, subject) {
            (Some(key), Some(subject)) => (key, subject),
            (None, None) => {
                if let Some(set) = [DAILY_CAP_VAR, MAX_PER_ACCOUNT_VAR, EXTRA_HOSTS_VAR]
                    .into_iter()
                    .find(|name| var(name).is_some())
                {
                    return Err(format!(
                        "{set} is set but {KEY_VAR} and {SUBJECT_VAR} are not; set both to send web push, or none"
                    ));
                }
                return Ok(None);
            }
            _ => {
                return Err(format!(
                    "web push needs both {KEY_VAR} and {SUBJECT_VAR}; set both, or neither"
                ))
            }
        };
        let vapid = VapidKey::from_base64url(&key)
            .map_err(|why| format!("{KEY_VAR} is not a usable key: {why}"))?;
        if !subject_ok(&subject) {
            return Err(format!(
                "{SUBJECT_VAR} must be a mailto: or https: contact (got \"{subject}\")"
            ));
        }
        let extra_hosts: Vec<String> = var(EXTRA_HOSTS_VAR)
            .map(|raw| {
                raw.split(',')
                    .map(|entry| entry.trim().to_ascii_lowercase())
                    .filter(|entry| !entry.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        for entry in &extra_hosts {
            let (host, port) = match entry.rsplit_once(':') {
                Some((h, p)) if !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) => {
                    (h, Some(p))
                }
                _ => (entry.as_str(), None),
            };
            let host_ok = !host.is_empty()
                && host
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-');
            let port_ok = port.is_none_or(|p| p.parse::<u16>().is_ok_and(|n| n > 0));
            if !host_ok || !port_ok {
                return Err(format!(
                    "{EXTRA_HOSTS_VAR} must be a comma-separated list of host or host:port (got \"{entry}\")"
                ));
            }
        }
        Ok(Some(Self {
            vapid,
            subject,
            daily_cap: number(DAILY_CAP_VAR, DEFAULT_DAILY_CAP, 1, 50)?,
            max_per_account: number(MAX_PER_ACCOUNT_VAR, DEFAULT_MAX_PER_ACCOUNT, 1, 20)?,
            extra_hosts,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_contact_is_a_mailto_or_an_https_address() {
        for good in ["mailto:ops@example.org", "https://example.org/contact"] {
            assert!(subject_ok(good), "{good}");
        }
        for bad in [
            "",
            "ops@example.org",
            "mailto:nobody",
            "http://example.org",
            "https://",
            "mailto:a b@c",
        ] {
            assert!(!subject_ok(bad), "{bad}");
        }
    }
}
