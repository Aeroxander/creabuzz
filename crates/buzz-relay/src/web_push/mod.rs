//! Web push: alerts to a device that has not opened the app (step 3, package P3).
//!
//! **Off unless the operator turns it on** with their own VAPID key and contact in the environment ([`settings`]). When
//! it is off the information document has no `webPush` key, the subscription paths answer "not switched on", the sender
//! is not started and the tables are never written.
//!
//! A person's browser makes a push address (its own capability) and gives it to this server with `PUT /push/web`; the
//! server keeps as little as it takes to send to it and deletes it on request. An alert is made from the chain's own
//! final task rows (planned, taken, ended), never from text anyone writes, and goes only to accounts that proved the
//! wallet that holds Shares in the project. The message carries a kind and a project link, nothing else; it is
//! encrypted to the device ([`ece`]), signed for the push service ([`vapid`]), and sent by a supervised task with a
//! lease, a growing pause between tries and a terminal state ([`sender`]). A push outage can never stall the chain
//! reader or Take out: the sender is its own task.

pub mod alerts;
pub mod ece;
pub mod hosts;
pub mod sender;
pub mod settings;
pub mod store;
pub mod vapid;

#[cfg(test)]
mod alerts_postgres_tests;
#[cfg(test)]
mod sender_postgres_tests;
#[cfg(test)]
mod store_postgres_tests;
#[cfg(test)]
pub(crate) mod test_support;

pub use settings::WebPushConfig;

/// The three kinds of news a push carries. Each is the same news the in-app alert carries for a task: `planned`, `taken`
/// and `ended` (paid, sent back, lapsed or run out alike).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Kind {
    /// A task was planned: the money can still be taken out first.
    Planned,
    /// A task was taken: work began.
    Taken,
    /// A task ended.
    Ended,
}

impl Kind {
    /// The word stored, and sent in the message's `k`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Planned => "planned",
            Self::Taken => "taken",
            Self::Ended => "ended",
        }
    }

    /// The kind a stored word names.
    pub fn parse(word: &str) -> Option<Self> {
        match word {
            "planned" => Some(Self::Planned),
            "taken" => Some(Self::Taken),
            "ended" => Some(Self::Ended),
            _ => None,
        }
    }
}

/// The plain text a device decrypts: `{"v":1,"k":"planned"|"taken"|"ended","r":"<project link ref>"}`. No amount, no
/// name, no date and no project name: the app's service worker turns the kind into one of three fixed sentences and
/// opens the news page.
pub fn message(kind: Kind, link_ref: &str) -> String {
    serde_json::json!({ "v": 1, "k": kind.as_str(), "r": link_ref }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_message_has_exactly_three_keys_and_is_small() {
        let text = message(Kind::Planned, "my-project-0123456789abcdef");
        let value: serde_json::Value = serde_json::from_str(&text).expect("json");
        let mut keys: Vec<&str> = value
            .as_object()
            .expect("object")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(keys, ["k", "r", "v"]);
        assert_eq!(value["v"], 1);
        assert_eq!(value["k"], "planned");
        assert!(text.len() < 200);
        for kind in [Kind::Planned, Kind::Taken, Kind::Ended] {
            assert_eq!(Kind::parse(kind.as_str()), Some(kind));
        }
        assert_eq!(Kind::parse("claim"), None);
    }
}
