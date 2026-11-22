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

/// The five kinds of news a push carries. Three are the same news the in-app alert carries for a task: `planned`,
/// `taken` and `ended` (paid, sent back, lapsed or run out alike). Two are the Council round's (`COUNCIL-PLAN.md`
/// section 5.6): `vote`, a ballot that opened (either kind: a seat election changes who runs the project too), and
/// `moved`, a result the reader derived that changes the runner (moved or seated).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Kind {
    /// A task was planned: the money can still be taken out first.
    Planned,
    /// A task was taken: work began.
    Taken,
    /// A task ended.
    Ended,
    /// A vote opened on the project: it changes who runs it.
    Vote,
    /// A vote's result changes who runs the project.
    Moved,
}

impl Kind {
    /// The word stored, and sent in the message's `k`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Planned => "planned",
            Self::Taken => "taken",
            Self::Ended => "ended",
            Self::Vote => "vote",
            Self::Moved => "moved",
        }
    }

    /// The kind a stored word names.
    pub fn parse(word: &str) -> Option<Self> {
        match word {
            "planned" => Some(Self::Planned),
            "taken" => Some(Self::Taken),
            "ended" => Some(Self::Ended),
            "vote" => Some(Self::Vote),
            "moved" => Some(Self::Moved),
            _ => None,
        }
    }

    /// The fixed sentence the app's service worker shows for this kind: no name, no amount, no date (`COUNCIL-PLAN.md`
    /// sections 5.6 and 6.7). `app/public/sw.js` and the app's `push-words.ts` hold the same words, and a test here holds
    /// the Rust words and `app/public/sw.js` equal.
    pub fn words(self) -> &'static str {
        match self {
            Self::Planned => {
                "A task was planned on a project you back. You can take your money out first."
            }
            Self::Taken => "A task was started on a project you back.",
            Self::Ended => "A task ended on a project you back.",
            Self::Vote => {
                "A vote on who runs a project you back is open. You can take your money out any time."
            }
            Self::Moved => {
                "Holders voted to change who runs a project you back. You can take your money out first."
            }
        }
    }

    /// Every kind, so a test (or a reader of the words) walks all of them.
    pub const ALL: [Kind; 5] = [
        Kind::Planned,
        Kind::Taken,
        Kind::Ended,
        Kind::Vote,
        Kind::Moved,
    ];
}

/// The plain text a device decrypts: `{"v":1,"k":"<kind>","r":"<project link ref>"}`. No amount, no name, no date and
/// no project name: the app's service worker turns the kind into one of its fixed sentences and opens the news page.
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
        for kind in Kind::ALL {
            assert_eq!(Kind::parse(kind.as_str()), Some(kind));
        }
        assert_eq!(Kind::parse("claim"), None);
        assert_eq!(Kind::parse("candidacy"), None);
    }

    /// The push words carry no name, amount, date, address or protocol word: a fixed sentence per kind, so nothing a
    /// person sees can be anything but the sentence (`COUNCIL-PLAN.md` sections 5.6 and 6.7).
    #[test]
    fn every_push_word_is_one_fixed_sentence_with_no_number_or_name() {
        for kind in Kind::ALL {
            let words = kind.words();
            assert!(words.ends_with('.'), "{kind:?}: {words}");
            assert!(
                !words.chars().any(|c| c.is_ascii_digit()),
                "{kind:?} carries a number or a date: {words}"
            );
            assert!(
                !words.contains('0') && !words.contains("(("),
                "{kind:?}: {words}"
            );
            for word in ["0x", "http", "Nostr", "relay", "event", "kind ", "token"] {
                assert!(!words.contains(word), "{kind:?} says {word:?}: {words}");
            }
        }
    }

    /// The plan's own sentences for the two new kinds, word for word (section 6.7): the words the service worker shows
    /// and the app's `push-words.ts` holds.
    #[test]
    fn the_two_new_push_words_are_the_plans_sentences() {
        assert_eq!(
            Kind::Vote.words(),
            "A vote on who runs a project you back is open. You can take your money out any time."
        );
        assert_eq!(
            Kind::Moved.words(),
            "Holders voted to change who runs a project you back. You can take your money out first."
        );
    }

    /// The words here and the words the app's service worker shows are the same, kind for kind: this test reads
    /// `app/public/sw.js` and compares every entry. Remove or reword an entry there (or here) and it fails.
    #[test]
    fn the_push_words_are_the_ones_in_the_apps_service_worker() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../app/public/sw.js");
        let js = std::fs::read_to_string(&path).unwrap_or_else(|e| {
            panic!("read {}: {e}", path.display());
        });
        let shown = words_of_sw(&js);
        for kind in Kind::ALL {
            assert_eq!(
                shown.get(kind.as_str()).map(String::as_str),
                Some(kind.words()),
                "the service worker's word for {:?} is not the server's",
                kind.as_str()
            );
        }
        assert_eq!(
            shown.len(),
            Kind::ALL.len(),
            "the service worker shows a kind the server never sends: {shown:?}"
        );
    }

    /// The `PUSH_WORDS` object of `app/public/sw.js`, as (kind, words) pairs: the keys are the bare words and the
    /// values are the double-quoted sentences (the object is written by hand there, so this is a small reader, not an
    /// evaluator). A shape this cannot read is a failure of the test, never an empty list that passes.
    fn words_of_sw(js: &str) -> std::collections::BTreeMap<String, String> {
        let start = js
            .find("const PUSH_WORDS = {")
            .expect("sw.js has PUSH_WORDS");
        let rest = &js[start + "const PUSH_WORDS = {".len()..];
        let end = rest.find("};").expect("PUSH_WORDS is closed");
        let body = &rest[..end];
        let mut out = std::collections::BTreeMap::new();
        let mut cursor = 0;
        let bytes = body.as_bytes();
        while cursor < bytes.len() {
            // The key: an identifier after whitespace.
            while cursor < bytes.len() && !bytes[cursor].is_ascii_alphabetic() {
                cursor += 1;
            }
            let key_at = cursor;
            while cursor < bytes.len()
                && (bytes[cursor].is_ascii_alphanumeric() || bytes[cursor] == b'_')
            {
                cursor += 1;
            }
            if key_at == cursor {
                break;
            }
            let key = body[key_at..cursor].to_owned();
            while cursor < bytes.len() && bytes[cursor] != b':' {
                assert_ne!(bytes[cursor], b'}', "a key without a value: {key}");
                cursor += 1;
            }
            assert!(cursor < bytes.len(), "a key without a value: {key}");
            cursor += 1;
            while cursor < bytes.len() && bytes[cursor] != b'"' {
                assert_ne!(bytes[cursor], b'}', "a key without a string: {key}");
                cursor += 1;
            }
            assert!(cursor < bytes.len(), "a key without a string: {key}");
            cursor += 1;
            let value_at = cursor;
            while cursor < bytes.len() && bytes[cursor] != b'"' {
                assert_ne!(bytes[cursor], b'\\', "an escaped quote in {key}");
                cursor += 1;
            }
            assert!(cursor < bytes.len(), "an unclosed string for {key}");
            out.insert(key, body[value_at..cursor].to_owned());
            cursor += 1;
        }
        out
    }
}
