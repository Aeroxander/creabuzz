//! Agent accounts are labelled, and name who runs them.
//!
//! A helper is an account, not a person. An account that is an agent says so
//! on its own profile record (kind 0), with two tags the apps already write and
//! read on an agent's records:
//!
//! | tag                                         | what it says                         |
//! |---------------------------------------------|--------------------------------------|
//! | `["agent", <the account's own key>]`        | "this account is an agent"           |
//! | `["auth", <operator>, <conditions>, <sig>]` | "and this person runs it" (NIP-OA)   |
//!
//! The profile is signed by the agent's own key, and the `auth` tag holds the
//! operator's signature over the agent's key. So the label takes both keys:
//! nobody can label another account as an agent (only the account signs its
//! own profile, and an `agent` tag must name the signer), and nobody can claim
//! to be run by someone who did not sign for them.
//!
//! No new kind is made. The check here runs once, when the profile is written:
//!
//! * an `agent` tag must name the signer, and needs the operator's signature
//!   beside it, covering this record;
//! * an `auth` tag must be the only one, and its signature must hold for the
//!   signer;
//! * a profile that passes with an operator's signature covering it puts the
//!   account on the server's record as an agent run by that operator (the same
//!   record a sign-in with the operator's signature makes). An account is on
//!   record under one operator only, for good: a label naming someone else is
//!   refused.
//!
//! That record is what limits an agent's powers elsewhere (see
//! `launch_update_authority`). A profile with neither tag is not looked at.

use std::sync::Arc;

use buzz_core::kind::KIND_PROFILE;
use buzz_core::tenant::TenantContext;
use nostr::{Event, PublicKey};

use super::ingest::IngestError;
use crate::state::AppState;

/// Said when an `agent` tag on a profile names any key but the signer's.
pub(crate) const NOT_YOUR_ACCOUNT: &str =
    "restricted: only an account itself can say it is an agent";
/// Said when a profile says "agent" and carries nobody's signature for it.
pub(crate) const NO_OPERATOR: &str =
    "invalid: an agent label must name who runs the account, with their signature";
/// Said when a profile carries more than one `auth` tag.
pub(crate) const ONE_OPERATOR: &str = "invalid: an account names one person who runs it";
/// Said when the signature in the `auth` tag does not hold for the signer.
pub(crate) const NOT_CONFIRMED: &str =
    "restricted: the person named as running this account has not signed for it";
/// Said when the operator's signature holds but its conditions leave this record out.
pub(crate) const NOT_COVERED: &str =
    "restricted: the signature of the person who runs this account does not cover its profile";
/// Said when the server already has the account on record under another operator, or could not record it.
pub(crate) const OTHER_OPERATOR: &str =
    "restricted: this account could not be put on record as run by that person; it may already be on record as run by someone else";

/// What a profile record says about its account being an agent.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Label {
    /// Neither tag, or an operator's signature that does not cover this
    /// record and no claim to be an agent: nothing to put on record.
    None,
    /// The account is an agent run by this operator, by both signatures.
    Agent {
        /// The operator whose signature the `auth` tag holds.
        operator: PublicKey,
    },
}

/// Whether a record of kind 0 dated `created_at` meets every clause of the
/// operator's conditions (`kind=<n>`, `created_at<t`, `created_at>t`, joined
/// by `&`). Anything not understood fails: an unknown clause is never waved
/// through. The same reading as the web app's `conditionsHold`.
fn conditions_cover_profile(conditions: &str, created_at: u64) -> bool {
    if conditions.is_empty() {
        return true;
    }
    conditions.split('&').all(|clause| {
        if let Some(value) = clause.strip_prefix("kind=") {
            value.parse::<u32>() == Ok(KIND_PROFILE)
        } else if let Some(value) = clause.strip_prefix("created_at<") {
            value.parse::<u64>().is_ok_and(|bound| created_at < bound)
        } else if let Some(value) = clause.strip_prefix("created_at>") {
            value.parse::<u64>().is_ok_and(|bound| created_at > bound)
        } else {
            false
        }
    })
}

/// Read the agent label a profile record carries, refusing one that could
/// not be true: a label for another account, or an operator who did not sign.
pub(crate) fn read_label(event: &Event) -> Result<Label, &'static str> {
    let signer = event.pubkey.to_hex();
    let mut says_agent = false;
    let mut auth: Vec<&[String]> = Vec::new();
    for tag in event.tags.iter() {
        let fields = tag.as_slice();
        match fields.first().map(String::as_str) {
            Some("agent") => {
                if fields.get(1) != Some(&signer) {
                    return Err(NOT_YOUR_ACCOUNT);
                }
                says_agent = true;
            }
            Some("auth") => auth.push(fields),
            _ => {}
        }
    }
    let fields = match auth.as_slice() {
        [] if says_agent => return Err(NO_OPERATOR),
        [] => return Ok(Label::None),
        [fields] => *fields,
        _ => return Err(ONE_OPERATOR),
    };
    let json = serde_json::to_string(fields).map_err(|_| NOT_CONFIRMED)?;
    let operator =
        buzz_sdk::nip_oa::verify_auth_tag(&json, &event.pubkey).map_err(|_| NOT_CONFIRMED)?;
    let conditions = fields.get(2).map(String::as_str).unwrap_or("");
    if !conditions_cover_profile(conditions, event.created_at.as_secs()) {
        // The operator signed for this account, but not for its profile. Without a claim to be an agent the record
        // is stored as before and puts nothing on record; with one, the label is not confirmed.
        return if says_agent {
            Err(NOT_COVERED)
        } else {
            Ok(Label::None)
        };
    }
    Ok(Label::Agent { operator })
}

/// Check the agent label on a profile record (kind 0) and put a confirmed one
/// on the server's record.
///
/// A record that cannot be put on record under the operator it names is
/// refused, so a stored label and the server's record never disagree about
/// who runs an account.
pub(crate) async fn enforce_agent_label(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    event: &Event,
) -> Result<(), IngestError> {
    let operator = match read_label(event) {
        Ok(Label::None) => return Ok(()),
        Ok(Label::Agent { operator }) => operator,
        Err(reason) => {
            return Err(if reason.starts_with("restricted:") {
                IngestError::AuthFailed(reason.into())
            } else {
                IngestError::Rejected(reason.into())
            })
        }
    };
    if crate::api::relay_members::materialize_nip_oa_owner(state, tenant, &event.pubkey, &operator)
        .await
    {
        Ok(())
    } else {
        Err(IngestError::AuthFailed(OTHER_OPERATOR.into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind, Tag, Timestamp};

    fn profile(keys: &Keys, tags: Vec<Vec<String>>) -> Event {
        let tags: Vec<Tag> = tags
            .into_iter()
            .map(|fields| Tag::parse(fields).expect("tag"))
            .collect();
        EventBuilder::new(Kind::Custom(0), r#"{"name":"Mapper"}"#)
            .tags(tags)
            .allow_self_tagging()
            .custom_created_at(Timestamp::from(1_800_000_000))
            .sign_with_keys(keys)
            .expect("sign")
    }

    fn agent_tag(keys: &Keys) -> Vec<String> {
        vec!["agent".into(), keys.public_key().to_hex()]
    }

    fn auth_tag(operator: &Keys, agent: &Keys, conditions: &str) -> Vec<String> {
        let json = buzz_sdk::nip_oa::compute_auth_tag(operator, &agent.public_key(), conditions)
            .expect("sign");
        serde_json::from_str(&json).expect("tag")
    }

    #[test]
    fn a_profile_with_neither_tag_is_not_a_label() {
        let agent = Keys::generate();
        assert_eq!(read_label(&profile(&agent, vec![])), Ok(Label::None));
        let other = vec![vec!["p".to_string(), agent.public_key().to_hex()]];
        assert_eq!(read_label(&profile(&agent, other)), Ok(Label::None));
    }

    #[test]
    fn the_label_takes_both_keys() {
        let (agent, operator) = (Keys::generate(), Keys::generate());
        let labelled = Label::Agent {
            operator: operator.public_key(),
        };
        for conditions in ["", "kind=0", "kind=0&created_at>1700000000"] {
            let both = profile(
                &agent,
                vec![agent_tag(&agent), auth_tag(&operator, &agent, conditions)],
            );
            assert_eq!(
                read_label(&both),
                Ok(Label::Agent {
                    operator: operator.public_key()
                })
            );
        }
        // The operator's signature alone is the label too: the apps read it that way.
        let quiet = profile(&agent, vec![auth_tag(&operator, &agent, "")]);
        assert_eq!(read_label(&quiet), Ok(labelled));
        // Saying "agent" with nobody's signature is not a label.
        assert_eq!(
            read_label(&profile(&agent, vec![agent_tag(&agent)])),
            Err(NO_OPERATOR)
        );
    }

    #[test]
    fn nobody_labels_another_account() {
        let (agent, operator, victim) = (Keys::generate(), Keys::generate(), Keys::generate());
        // An `agent` tag naming someone else, with or without a real signature beside it.
        assert_eq!(
            read_label(&profile(&agent, vec![agent_tag(&victim)])),
            Err(NOT_YOUR_ACCOUNT)
        );
        assert_eq!(
            read_label(&profile(
                &agent,
                vec![agent_tag(&victim), auth_tag(&operator, &agent, "")]
            )),
            Err(NOT_YOUR_ACCOUNT)
        );
        assert_eq!(
            read_label(&profile(&agent, vec![vec!["agent".into()]])),
            Err(NOT_YOUR_ACCOUNT)
        );
    }

    #[test]
    fn nobody_claims_an_operator_who_did_not_sign() {
        let (agent, operator, other) = (Keys::generate(), Keys::generate(), Keys::generate());
        // The operator signed for a different account.
        let borrowed = auth_tag(&operator, &other, "");
        assert_eq!(
            read_label(&profile(&agent, vec![agent_tag(&agent), borrowed.clone()])),
            Err(NOT_CONFIRMED)
        );
        assert_eq!(
            read_label(&profile(&agent, vec![borrowed])),
            Err(NOT_CONFIRMED)
        );
        // The operator's name with a made-up signature, and the signature moved to other conditions.
        let mut forged = auth_tag(&operator, &agent, "");
        forged[3] = "0".repeat(128);
        assert_eq!(
            read_label(&profile(&agent, vec![agent_tag(&agent), forged])),
            Err(NOT_CONFIRMED)
        );
        let mut moved = auth_tag(&operator, &agent, "kind=1");
        moved[2] = String::new();
        assert_eq!(
            read_label(&profile(&agent, vec![moved])),
            Err(NOT_CONFIRMED)
        );
        // An account cannot be its own operator.
        let own = vec![
            "auth".to_string(),
            agent.public_key().to_hex(),
            String::new(),
            "0".repeat(128),
        ];
        assert_eq!(read_label(&profile(&agent, vec![own])), Err(NOT_CONFIRMED));
        // Two operators are none.
        let two = vec![
            agent_tag(&agent),
            auth_tag(&operator, &agent, ""),
            auth_tag(&other, &agent, ""),
        ];
        assert_eq!(read_label(&profile(&agent, two)), Err(ONE_OPERATOR));
    }

    #[test]
    fn the_operators_word_must_cover_the_profile() {
        let (agent, operator) = (Keys::generate(), Keys::generate());
        // The profile is dated 1_800_000_000.
        for conditions in [
            "kind=1",
            "created_at<1800000000",
            "created_at>1800000000",
            "kind=0&created_at<1700000000",
        ] {
            let auth = auth_tag(&operator, &agent, conditions);
            assert_eq!(
                read_label(&profile(&agent, vec![agent_tag(&agent), auth.clone()])),
                Err(NOT_COVERED),
                "{conditions}"
            );
            // Without a claim to be an agent the record is stored as before and labels nothing.
            assert_eq!(
                read_label(&profile(&agent, vec![auth])),
                Ok(Label::None),
                "{conditions}"
            );
        }
        assert!(conditions_cover_profile(
            "created_at<1800000001",
            1_800_000_000
        ));
        assert!(!conditions_cover_profile(
            "kind=0&valid_until=5",
            1_800_000_000
        ));
    }
}
