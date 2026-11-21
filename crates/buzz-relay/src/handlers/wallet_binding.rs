//! Which wallets an account has proved are its own (kind 37017), and the inverse: which accounts proved a wallet.
//!
//! A binding is **verified when it is stored** (`ingest.rs`: a wallet by its signature, offline; a smart account by
//! asking the chain), and a stored record is never looked at again for that. What a rule needs *now* is read here:
//! the binding is not revoked, its attestation has not expired at the server's clock, and it is bound on the chain the
//! rule is about (the record's `chain` tag, or the attestation's own domain when the tag is absent: the tag is optional
//! at write).
//!
//! Two readers, one rule for "live" ([`live_wallet`]):
//!
//! - [`linked_wallets`]: the wallets of one account (the room rule decides who may write from these).
//! - [`accounts_of_wallets`]: the accounts that proved any of some wallets (web push uses this to find who to tell).
//!
//! Both are bounded: at most [`WALLETS_READ`] records per account and [`ACCOUNTS_PER_WALLET_READ`] per wallet are read.
//! A read that fails is an error, never an empty list.

use buzz_core::kind::KIND_EVM_BINDING;
use buzz_core::tenant::CommunityId;
use buzz_db::DbError;
use nostr::Event;
use serde_json::Value;

use crate::state::AppState;

/// The most binding records of one account that are read.
pub(crate) const WALLETS_READ: i64 = 20;
/// The most wallets of one account a rule uses.
pub(crate) const WALLETS_USED: usize = 8;
/// The most accounts read for one wallet. A wallet with more live bindings than a rule allows is over its cap anyway.
pub(crate) const ACCOUNTS_PER_WALLET_READ: i64 = 64;
/// The most wallets [`accounts_of_wallets`] is asked about in one call.
pub(crate) const WALLETS_ASKED_MAX: usize = 64;

/// A wallet address: 20 bytes.
pub(crate) type Wallet = [u8; 20];

/// The lower-case `0x` text of a wallet.
pub(crate) fn wallet_text(wallet: &Wallet) -> String {
    format!("0x{}", hex::encode(wallet))
}

/// The wallet of a lower-case `0x` and 40 hex digits text.
pub(crate) fn parse_wallet(text: &str) -> Option<Wallet> {
    let digits = text.strip_prefix("0x")?;
    if digits.len() != 40
        || !digits
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return None;
    }
    hex::decode(digits).ok()?.try_into().ok()
}

fn first_tag<'a>(event: &'a Event, name: &str) -> Option<&'a str> {
    event.tags.iter().find_map(|tag| {
        let parts = tag.as_slice();
        (parts.len() >= 2 && parts[0] == name).then(|| parts[1].as_str())
    })
}

/// The wallet a stored kind 37017 record binds **if it is live now**: not revoked, with an attestation that has not
/// expired at `now` (unix seconds), on `chain_id` (when given). `None` for anything else, including a record that does
/// not read: a live binding always carries its attestation, so a missing or odd one is not a wallet.
pub(crate) fn live_wallet(event: &Event, now: u64, chain_id: Option<u64>) -> Option<Wallet> {
    if event.kind.as_u16() as u32 != KIND_EVM_BINDING {
        return None;
    }
    let address = parse_wallet(first_tag(event, "d")?)?;
    let body: Value = serde_json::from_str(&event.content).ok()?;
    if body.get("revoked").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let envelope = body.get("attestation")?;
    let expires = envelope
        .get("attestation")?
        .get("expires")
        .and_then(Value::as_u64)?;
    if expires < now {
        return None;
    }
    if let Some(chain_id) = chain_id {
        let domain_chain = envelope
            .get("domain")
            .and_then(|d| d.get("chain_id"))
            .and_then(Value::as_u64);
        let bound = match first_tag(event, "chain") {
            Some(tag) => tag.parse::<u64>().ok(),
            None => domain_chain,
        };
        if bound != Some(chain_id) {
            return None;
        }
    }
    Some(address)
}

/// The chain the server's chain reader is about, when there is one.
fn reader_chain(state: &AppState) -> Option<u64> {
    state
        .config
        .chain_reader
        .as_ref()
        .map(|reader| reader.chain_id)
}

/// The wallets `pubkey` has bound that are live now (newest record per address, at most [`WALLETS_READ`] records
/// read, at most [`WALLETS_USED`] returned, in address order so the same account always gets the same ones).
pub(crate) async fn linked_wallets(
    state: &AppState,
    community: CommunityId,
    pubkey: &[u8],
) -> Result<Vec<Wallet>, DbError> {
    let mut wallets = all_linked_wallets(state, community, pubkey).await?.wallets;
    wallets.truncate(WALLETS_USED);
    Ok(wallets)
}

/// Every live wallet of one account that a rule which must not miss one can use.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AllWallets {
    /// The live wallets in address order (at most [`WALLETS_READ`]).
    pub(crate) wallets: Vec<Wallet>,
    /// Whether the account's binding records were all read: `false` when the read stopped at [`WALLETS_READ`] records,
    /// so a live wallet may be among the ones not read.
    pub(crate) complete: bool,
}

/// The wallets `pubkey` has bound that are live now, all of those read (no cut at [`WALLETS_USED`]), and whether the
/// read reached the end of the account's records. A rule that asks "does this account hold any wallet that is X" uses
/// this one: an account must not be able to hide a wallet by linking more throwaway wallets than a rule looks at.
pub(crate) async fn all_linked_wallets(
    state: &AppState,
    community: CommunityId,
    pubkey: &[u8],
) -> Result<AllWallets, DbError> {
    let records = state
        .db
        .query_events_for_event_write(&buzz_db::EventQuery {
            kinds: Some(vec![KIND_EVM_BINDING as i32]),
            pubkey: Some(pubkey.to_vec()),
            global_only: true,
            limit: Some(WALLETS_READ),
            ..buzz_db::EventQuery::for_community(community)
        })
        .await?;
    let complete = i64::try_from(records.len()).is_ok_and(|read| read < WALLETS_READ);
    let now = u64::try_from(chrono::Utc::now().timestamp()).unwrap_or(0);
    let chain = reader_chain(state);
    let mut wallets: Vec<Wallet> = records
        .iter()
        .filter_map(|stored| live_wallet(&stored.event, now, chain))
        .collect();
    wallets.sort_unstable();
    wallets.dedup();
    Ok(AllWallets { wallets, complete })
}

/// The accounts that have bound any of `wallets` and whose binding is live now, as `(wallet, account pubkey)` pairs,
/// in wallet then account order. At most [`ACCOUNTS_PER_WALLET_READ`] records are read per wallet and at most
/// [`WALLETS_ASKED_MAX`] wallets are asked about (more is an error: the caller asks in pieces).
pub(crate) async fn accounts_of_wallets(
    state: &AppState,
    community: CommunityId,
    wallets: &[Wallet],
) -> Result<Vec<(Wallet, Vec<u8>)>, DbError> {
    if wallets.is_empty() {
        return Ok(Vec::new());
    }
    if wallets.len() > WALLETS_ASKED_MAX {
        return Err(DbError::InvalidData(format!(
            "accounts_of_wallets is asked about at most {WALLETS_ASKED_MAX} wallets at a time"
        )));
    }
    let asked: Vec<String> = wallets.iter().map(wallet_text).collect();
    let records = state
        .db
        .query_events_for_event_write(&buzz_db::EventQuery {
            kinds: Some(vec![KIND_EVM_BINDING as i32]),
            d_tags: Some(asked),
            global_only: true,
            limit: Some(
                ACCOUNTS_PER_WALLET_READ
                    .saturating_mul(i64::try_from(wallets.len()).unwrap_or(i64::MAX)),
            ),
            ..buzz_db::EventQuery::for_community(community)
        })
        .await?;
    let now = u64::try_from(chrono::Utc::now().timestamp()).unwrap_or(0);
    let chain = reader_chain(state);
    let mut pairs: Vec<(Wallet, Vec<u8>)> = records
        .iter()
        .filter_map(|stored| {
            let wallet = live_wallet(&stored.event, now, chain)?;
            wallets
                .contains(&wallet)
                .then(|| (wallet, stored.event.pubkey.to_bytes().to_vec()))
        })
        .collect();
    pairs.sort_unstable();
    pairs.dedup();
    Ok(pairs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind, Tag};
    use serde_json::json;

    const WALLET: &str = "0x00000000000000000000000000000000000000aa";

    fn binding(chain_tag: Option<&str>, content: Value) -> Event {
        let mut tags = vec![
            Tag::parse(["d", WALLET]).expect("tag"),
            Tag::parse(["address", WALLET]).expect("tag"),
        ];
        if let Some(chain) = chain_tag {
            tags.push(Tag::parse(["chain", chain]).expect("tag"));
        }
        EventBuilder::new(Kind::Custom(KIND_EVM_BINDING as u16), content.to_string())
            .tags(tags)
            .sign_with_keys(&Keys::generate())
            .expect("sign")
    }

    fn live(expires: u64, chain_id: u64) -> Value {
        json!({
            "v": 1,
            "address": WALLET,
            "attestation": {
                "attestation": { "account": WALLET, "expires": expires, "nonce": 1 },
                "domain": { "chain_id": chain_id },
                "signature": "0x"
            }
        })
    }

    #[test]
    fn a_live_binding_is_a_wallet_until_it_expires_or_is_revoked() {
        let event = binding(None, live(2_000, 31_337));
        assert_eq!(
            live_wallet(&event, 1_000, Some(31_337)),
            parse_wallet(WALLET)
        );
        // Expiry is read now, not when the record was stored.
        assert_eq!(
            live_wallet(&event, 2_000, Some(31_337)),
            parse_wallet(WALLET)
        );
        assert_eq!(live_wallet(&event, 2_001, Some(31_337)), None);
        let mut revoked = live(2_000, 31_337);
        revoked["revoked"] = json!(true);
        assert_eq!(
            live_wallet(&binding(None, revoked), 1_000, Some(31_337)),
            None
        );
    }

    #[test]
    fn a_binding_counts_only_on_the_readers_chain() {
        // No tag: the attestation's own domain decides.
        assert_eq!(
            live_wallet(&binding(None, live(2_000, 1)), 1_000, Some(31_337)),
            None
        );
        // A tag decides when it is there (the write already refused one that contradicts the domain).
        assert_eq!(
            live_wallet(
                &binding(Some("31337"), live(2_000, 31_337)),
                1_000,
                Some(31_337)
            ),
            parse_wallet(WALLET)
        );
        assert_eq!(
            live_wallet(&binding(Some("1"), live(2_000, 1)), 1_000, Some(31_337)),
            None
        );
        // With no chain to compare with, any chain will do.
        assert_eq!(
            live_wallet(&binding(None, live(2_000, 1)), 1_000, None),
            parse_wallet(WALLET)
        );
    }

    #[test]
    fn a_record_that_does_not_read_is_not_a_wallet() {
        for content in [
            json!({ "v": 1 }),
            json!({ "attestation": {} }),
            json!({ "attestation": { "attestation": { "expires": "soon" } } }),
        ] {
            assert_eq!(live_wallet(&binding(None, content), 1_000, None), None);
        }
        let not_binding = EventBuilder::new(Kind::Custom(1), "")
            .sign_with_keys(&Keys::generate())
            .expect("sign");
        assert_eq!(live_wallet(&not_binding, 0, None), None);
    }

    #[test]
    fn a_wallet_is_lower_case_zero_x_and_forty_digits() {
        assert!(parse_wallet(WALLET).is_some());
        for bad in [
            "0x00000000000000000000000000000000000000AA",
            "00000000000000000000000000000000000000aa",
            "0x00",
            "0xzz000000000000000000000000000000000000aa",
        ] {
            assert_eq!(parse_wallet(bad), None, "{bad}");
        }
        assert_eq!(wallet_text(&parse_wallet(WALLET).expect("wallet")), WALLET);
    }
}
