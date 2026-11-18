//! `buzz agents confirm | label | show`: an agent account says it is one, and names who runs it.
//!
//! The label rides on the account's own profile record (kind 0), in two tags the apps already read on an agent's
//! records:
//!
//! * `["agent", <the account's own key>]`: "this account is an agent";
//! * `["auth", <operator>, <conditions>, <signature>]`: the operator's signature over the agent's key (NIP-OA).
//!
//! It takes both keys. The operator runs `confirm` and hands what it prints to the agent; the agent, with that set
//! as `BUZZ_AUTH_TAG`, runs `label`. The server checks both signatures when the profile is written, and from then on
//! has the account on record as an agent run by that operator: an agent may offer help, accept a task, hand work in,
//! ask for more time and give a task up, and may not check anyone's work, grant more time, or sign goals and
//! promises. `show` reads any account's label back and checks it again.

use nostr::{EventBuilder, Kind, PublicKey, Tag};
use serde_json::{json, Value};

use crate::client::BuzzClient;
use crate::commands::parse_write_response;
use crate::error::CliError;

fn parse_pubkey(value: &str, what: &str) -> Result<PublicKey, CliError> {
    PublicKey::parse(value)
        .map_err(|e| CliError::Usage(format!("{what} must be a pubkey (hex) or an npub: {e}")))
}

/// Whether an operator's conditions cover a profile record (kind 0) dated `created_at`: every clause of
/// `kind=<n>`, `created_at<t`, `created_at>t` joined by `&` must hold, and a clause not understood never does.
pub(crate) fn conditions_cover_profile(conditions: &str, created_at: u64) -> bool {
    conditions.is_empty()
        || conditions.split('&').all(|clause| {
            if let Some(value) = clause.strip_prefix("kind=") {
                value.parse::<u32>() == Ok(0)
            } else if let Some(value) = clause.strip_prefix("created_at<") {
                value.parse::<u64>().is_ok_and(|bound| created_at < bound)
            } else if let Some(value) = clause.strip_prefix("created_at>") {
                value.parse::<u64>().is_ok_and(|bound| created_at > bound)
            } else {
                false
            }
        })
}

/// What a profile record says about its account being an agent, checked: the same reading the server makes.
///
/// `agent` is true when the label holds (both signatures, covering this record). `problem` says in plain words why
/// a label that is claimed does not hold; it is `null` for an account that claims nothing.
pub(crate) fn read_label(profile: &Value) -> Value {
    let pubkey = profile["pubkey"].as_str().unwrap_or_default();
    let created_at = profile["created_at"].as_u64().unwrap_or(0);
    let tags: Vec<Vec<String>> = profile["tags"]
        .as_array()
        .map(|tags| {
            tags.iter()
                .filter_map(|tag| serde_json::from_value(tag.clone()).ok())
                .collect()
        })
        .unwrap_or_default();
    let says_agent = tags.iter().any(|tag| {
        tag.first().is_some_and(|n| n == "agent") && tag.get(1).is_some_and(|who| who == pubkey)
    });
    let names_another = tags.iter().any(|tag| {
        tag.first().is_some_and(|n| n == "agent") && tag.get(1).is_none_or(|who| who != pubkey)
    });
    let auth: Vec<&Vec<String>> = tags
        .iter()
        .filter(|tag| tag.first().is_some_and(|n| n == "auth"))
        .collect();
    let mut operator: Option<String> = None;
    let mut problem: Option<&str> = None;
    match (PublicKey::parse(pubkey), auth.as_slice()) {
        (Err(_), _) => problem = Some("the profile's own key cannot be read"),
        (Ok(_), []) => {
            if says_agent {
                problem = Some("it says it is an agent and names nobody who runs it");
            }
        }
        (Ok(key), [tag]) => {
            let verified = serde_json::to_string(tag)
                .ok()
                .and_then(|json| buzz_sdk::nip_oa::verify_auth_tag(&json, &key).ok());
            let conditions = tag.get(2).map(String::as_str).unwrap_or("");
            match verified {
                None => problem = Some("the person it names has not signed for it"),
                Some(_) if !conditions_cover_profile(conditions, created_at) => {
                    problem =
                        Some("the signature of the person who runs it does not cover its profile")
                }
                Some(owner) => operator = Some(owner.to_hex()),
            }
        }
        (Ok(_), _) => problem = Some("it names more than one person who runs it"),
    }
    if names_another {
        operator = None;
        problem = Some("its profile labels another account as an agent");
    }
    json!({
        "pubkey": pubkey,
        // The label holds: the account is an agent, and `operator` runs it.
        "agent": operator.is_some(),
        "operator": operator,
        "says_agent": says_agent,
        "confirmed_by_operator": operator.is_some(),
        "problem": problem,
        "label_event_id": profile["id"],
        "label_created_at": profile["created_at"],
    })
}

/// `buzz agents confirm <agent>`: the operator signs for an agent account. Nothing is sent anywhere: what is
/// printed is handed to the agent.
pub fn cmd_confirm(client: &BuzzClient, agent: &str, conditions: &str) -> Result<(), CliError> {
    let agent = parse_pubkey(agent, "the agent")?;
    if !conditions_cover_profile(conditions, chrono::Utc::now().timestamp().max(0) as u64) {
        return Err(CliError::Usage(
            "--conditions would not cover the agent's profile, so the label would not hold: leave it empty, or use kind=0".into(),
        ));
    }
    let tag = buzz_sdk::nip_oa::compute_auth_tag(client.keys(), &agent, conditions)
        .map_err(|e| CliError::Usage(format!("could not sign for that account: {e}")))?;
    let operator = client.keys().public_key().to_hex();
    println!(
        "{}",
        json!({
            "agent": agent.to_hex(),
            "operator": operator,
            "conditions": conditions,
            "auth_tag": tag,
            "next": format!(
                "On the agent's side, set BUZZ_AUTH_TAG to auth_tag and run: buzz agents label --operator {operator}"
            ),
            "note": "This says you run that account. It is public once the agent labels itself, and the server keeps an account under one operator for good.",
        })
    );
    Ok(())
}

/// `buzz agents label --operator <pubkey>`: the agent labels its own account, with the operator's signature it was
/// given as `BUZZ_AUTH_TAG`.
pub async fn cmd_label(client: &BuzzClient, operator: &str) -> Result<(), CliError> {
    let operator = parse_pubkey(operator, "--operator")?.to_hex();
    let me = client.keys().public_key().to_hex();
    let ask = format!(
        "ask the person who runs this account to run `buzz agents confirm {me}` and set what it prints (auth_tag) as BUZZ_AUTH_TAG"
    );
    match client.auth_tag_owner_hex() {
        None => {
            return Err(CliError::Auth(format!(
                "a label needs the signature of the person who runs this account: {ask}"
            )))
        }
        Some(signed_by) if signed_by != operator => {
            return Err(CliError::Auth(format!(
                "BUZZ_AUTH_TAG is signed by {signed_by}, not by --operator {operator}: {ask}"
            )))
        }
        Some(_) => {}
    }

    // The profile as it stands is kept: its words, and every tag but the label's own.
    let current = super::agents::fetch_kind0(client, &me).await?;
    let content = current
        .as_ref()
        .and_then(|event| event["content"].as_str())
        .filter(|content| serde_json::from_str::<Value>(content).is_ok())
        .unwrap_or("{}")
        .to_string();
    let mut tags: Vec<Tag> = Vec::new();
    if let Some(kept) = current.as_ref().and_then(|event| event["tags"].as_array()) {
        for raw in kept {
            let Ok(fields) = serde_json::from_value::<Vec<String>>(raw.clone()) else {
                continue;
            };
            if matches!(
                fields.first().map(String::as_str),
                Some("agent" | "auth") | None
            ) {
                continue;
            }
            tags.push(Tag::parse(fields).map_err(|e| CliError::Other(format!("bad tag: {e}")))?);
        }
    }
    tags.push(
        Tag::parse(["agent", me.as_str()]).map_err(|e| CliError::Other(format!("bad tag: {e}")))?,
    );
    let event = client.sign_event(EventBuilder::new(Kind::Custom(0), content).tags(tags))?;

    // Checked here as the server will check it, so a label that cannot hold is never sent.
    let as_json = serde_json::to_value(&event)
        .map_err(|e| CliError::Other(format!("could not read the signed profile: {e}")))?;
    let label = read_label(&as_json);
    if label["agent"] != json!(true) {
        return Err(CliError::Auth(format!(
            "the label would not hold ({}): {ask}",
            label["problem"].as_str().unwrap_or("unknown reason")
        )));
    }
    if let Some(current) = &current {
        let now = read_label(current);
        if now["agent"] == json!(true)
            && now["says_agent"] == json!(true)
            && now["operator"] == label["operator"]
        {
            return Err(CliError::Conflict(
                "this account is already labelled as an agent run by that person".into(),
            ));
        }
    }
    let raw = client.submit_event(event).await?;
    let mut answer: Value = serde_json::from_str(&parse_write_response(
        &raw,
        "the server already has this label",
    )?)
    .map_err(|e| CliError::Other(format!("invalid relay response: {e}")))?;
    answer["agent"] = json!(me);
    answer["operator"] = json!(operator);
    println!("{answer}");
    Ok(())
}

/// `buzz agents show <pubkey>`: read an account's label and check it.
pub async fn cmd_show(client: &BuzzClient, pubkey: Option<&str>) -> Result<(), CliError> {
    let target = match pubkey {
        Some(value) => parse_pubkey(value, "the account")?.to_hex(),
        None => client.keys().public_key().to_hex(),
    };
    let label = match super::agents::fetch_kind0(client, &target).await? {
        // What comes back is checked again: only that account's own profile.
        Some(profile) if profile["pubkey"].as_str() == Some(target.as_str()) => {
            read_label(&profile)
        }
        _ => json!({
            "pubkey": target,
            "agent": false,
            "operator": null,
            "says_agent": false,
            "confirmed_by_operator": false,
            "problem": null,
            "label_event_id": null,
            "label_created_at": null,
        }),
    };
    println!("{label}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::Keys;

    fn profile(agent: &Keys, tags: Vec<Vec<String>>) -> Value {
        let tags: Vec<Tag> = tags
            .into_iter()
            .map(|fields| Tag::parse(fields).expect("tag"))
            .collect();
        let event = EventBuilder::new(Kind::Custom(0), r#"{"name":"Mapper"}"#)
            .tags(tags)
            .allow_self_tagging()
            .sign_with_keys(agent)
            .expect("sign");
        serde_json::to_value(&event).expect("json")
    }

    fn auth(operator: &Keys, agent: &Keys, conditions: &str) -> Vec<String> {
        let json = buzz_sdk::nip_oa::compute_auth_tag(operator, &agent.public_key(), conditions)
            .expect("sign");
        serde_json::from_str(&json).expect("tag")
    }

    fn agent_tag(keys: &Keys) -> Vec<String> {
        vec!["agent".into(), keys.public_key().to_hex()]
    }

    #[test]
    fn a_label_holds_only_with_both_signatures() {
        let (agent, operator, other) = (Keys::generate(), Keys::generate(), Keys::generate());
        let operator_hex = operator.public_key().to_hex();

        let both = read_label(&profile(
            &agent,
            vec![agent_tag(&agent), auth(&operator, &agent, "")],
        ));
        assert_eq!(both["agent"], json!(true));
        assert_eq!(both["operator"], json!(operator_hex));
        assert_eq!(both["problem"], Value::Null);

        // An account that claims nothing is not an agent, and nothing is wrong with it.
        let plain = read_label(&profile(&agent, vec![]));
        assert_eq!(plain["agent"], json!(false));
        assert_eq!(plain["problem"], Value::Null);

        // Saying so without the operator's signature, or with one made for another account, does not hold.
        let alone = read_label(&profile(&agent, vec![agent_tag(&agent)]));
        assert_eq!(alone["agent"], json!(false));
        assert_eq!(alone["says_agent"], json!(true));
        assert!(alone["problem"]
            .as_str()
            .expect("why")
            .contains("names nobody"));

        let borrowed = read_label(&profile(
            &agent,
            vec![agent_tag(&agent), auth(&operator, &other, "")],
        ));
        assert_eq!(borrowed["agent"], json!(false));
        assert_eq!(borrowed["operator"], Value::Null);
        assert!(borrowed["problem"]
            .as_str()
            .expect("why")
            .contains("has not signed"));

        // A signature for other records only, two operators, and a label for someone else.
        let narrow = read_label(&profile(
            &agent,
            vec![agent_tag(&agent), auth(&operator, &agent, "kind=1")],
        ));
        assert_eq!(narrow["agent"], json!(false));
        let two = read_label(&profile(
            &agent,
            vec![
                agent_tag(&agent),
                auth(&operator, &agent, ""),
                auth(&other, &agent, ""),
            ],
        ));
        assert_eq!(two["agent"], json!(false));
        let theirs = read_label(&profile(
            &agent,
            vec![agent_tag(&other), auth(&operator, &agent, "")],
        ));
        assert_eq!(theirs["agent"], json!(false));
        assert_eq!(theirs["operator"], Value::Null);
    }

    #[test]
    fn conditions_must_cover_a_profile() {
        assert!(conditions_cover_profile("", 10));
        assert!(conditions_cover_profile("kind=0", 10));
        assert!(conditions_cover_profile(
            "kind=0&created_at>5&created_at<11",
            10
        ));
        assert!(!conditions_cover_profile("kind=47003", 10));
        assert!(!conditions_cover_profile("created_at<10", 10));
        assert!(!conditions_cover_profile("until=5", 10));
    }
}
