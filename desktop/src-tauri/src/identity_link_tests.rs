//! Unit tests for the browser → desktop account handoff validation core.
//!
//! Falsifiability: these drive `consume_identity_payload` — the exact
//! function the `creaton://identity` deep-link arm calls — and the payloads
//! are built with the web half's construction (ACCOUNT key as NIP-44 sender,
//! the pending request's one-time pubkey as recipient, base64url unpadded
//! over the ciphertext — `buildLinkDeviceRedirect` /
//! `buildLinkDeviceCallback` in `packages/creaton-core/src/link-device.ts`).
//! Removing the nonce check, the expiry check, the sender binding, or the
//! single-use consumption makes tests here go red (the nonce guard is
//! mutation-checked).

use super::*;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use nostr::nips::nip44;

const NOW: u64 = 1_760_000_000;

fn fixed_keys(byte: u8) -> nostr::Keys {
    nostr::Keys::new(nostr::SecretKey::from_slice(&[byte; 32]).expect("test key should parse"))
}

/// The account being handed over — the NIP-44 sender on the web side.
fn account_keys() -> nostr::Keys {
    fixed_keys(1)
}

/// A different account: the sender-binding mismatch case.
fn other_account_keys() -> nostr::Keys {
    fixed_keys(3)
}

fn insert_request(links: &PendingIdentityLinks, nonce_hex: &str) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    links.insert_pending(
        PendingIdentityLink {
            id: id.clone(),
            nonce_hex: nonce_hex.to_string(),
            keys: fixed_keys(2),
            created_at: NOW,
        },
        NOW,
    );
    id
}

fn canonical_json(sk_hex: &str, nonce: &str, exp: u64) -> String {
    format!(r#"{{"v":1,"sk":"{sk_hex}","nonce":"{nonce}","exp":{exp}}}"#)
}

/// The web half's construction: NIP-44 with `sender`'s account key as the
/// sender and the pending request's one-time pubkey as the recipient, then
/// base64url (unpadded) over the UTF-8 text of the ciphertext string.
fn web_payload(
    links: &PendingIdentityLinks,
    index: usize,
    sender: &nostr::Keys,
    json: &str,
) -> String {
    let queue = links.lock();
    let pending = &queue[index];
    let ciphertext = nip44::encrypt(
        sender.secret_key(),
        &pending.keys.public_key(),
        json,
        nip44::Version::V2,
    )
    .expect("web side should encrypt");
    URL_SAFE_NO_PAD.encode(ciphertext.as_bytes())
}

fn from_hex(keys: &nostr::Keys) -> String {
    keys.public_key().to_hex()
}

fn sk_hex(keys: &nostr::Keys) -> String {
    hex_lower(keys.secret_key().as_secret_bytes())
}

#[test]
fn links_the_account_when_the_payload_matches() {
    let links = PendingIdentityLinks::default();
    let id = insert_request(&links, "aabbcc");
    let account = account_keys();
    let payload = web_payload(
        &links,
        0,
        &account,
        &canonical_json(&sk_hex(&account), "aabbcc", NOW + 300),
    );

    let consumed =
        consume_identity_payload(&links, &payload, &from_hex(&account), NOW).expect("link");
    assert_eq!(consumed.id, id);
    assert_eq!(consumed.keys.public_key(), account.public_key());
    // Single-use: the request is gone after one success.
    assert_eq!(links.lock().len(), 0);
}

#[test]
fn rejects_a_payload_with_the_wrong_nonce() {
    let links = PendingIdentityLinks::default();
    let id = insert_request(&links, "aabbcc");
    let account = account_keys();
    // Encrypted to THIS request's one-time key by the right account, but
    // echoing a different nonce — the confused-deputy response the nonce
    // check must refuse.
    let payload = web_payload(
        &links,
        0,
        &account,
        &canonical_json(&sk_hex(&account), "ddeeff", NOW + 300),
    );

    let rejection = consume_identity_payload(&links, &payload, &from_hex(&account), NOW)
        .expect_err("must reject");
    assert_eq!(rejection.error, IdentityLinkError::NonceMismatch);
    assert_eq!(rejection.id, Some(id));
    // A rejection consumes nothing.
    assert_eq!(links.lock().len(), 1);
}

#[test]
fn rejects_an_expired_payload() {
    let links = PendingIdentityLinks::default();
    let id = insert_request(&links, "aabbcc");
    let account = account_keys();
    let payload = web_payload(
        &links,
        0,
        &account,
        &canonical_json(&sk_hex(&account), "aabbcc", NOW - 1),
    );

    let rejection = consume_identity_payload(&links, &payload, &from_hex(&account), NOW)
        .expect_err("must reject");
    assert_eq!(rejection.error, IdentityLinkError::Expired);
    assert_eq!(rejection.id, Some(id));
    assert_eq!(links.lock().len(), 1);
}

#[test]
fn rejects_a_replayed_payload() {
    let links = PendingIdentityLinks::default();
    insert_request(&links, "aabbcc");
    let account = account_keys();
    let payload = web_payload(
        &links,
        0,
        &account,
        &canonical_json(&sk_hex(&account), "aabbcc", NOW + 300),
    );

    consume_identity_payload(&links, &payload, &from_hex(&account), NOW).expect("first links");
    let rejection = consume_identity_payload(&links, &payload, &from_hex(&account), NOW)
        .expect_err("replay must fail");
    assert_eq!(rejection.error, IdentityLinkError::NoPendingRequest);
}

#[test]
fn rejects_a_payload_whose_sk_is_not_the_sender() {
    let links = PendingIdentityLinks::default();
    let id = insert_request(&links, "aabbcc");
    let account = account_keys();
    // Sent (encrypted) by the account — but the payload hands over a
    // DIFFERENT account's key. The sender binding must refuse it.
    let payload = web_payload(
        &links,
        0,
        &account,
        &canonical_json(&sk_hex(&other_account_keys()), "aabbcc", NOW + 300),
    );

    let rejection = consume_identity_payload(&links, &payload, &from_hex(&account), NOW)
        .expect_err("must reject");
    assert_eq!(rejection.error, IdentityLinkError::SenderMismatch);
    assert_eq!(rejection.id, Some(id));
    assert_eq!(links.lock().len(), 1);
}

#[test]
fn rejects_a_payload_with_the_wrong_version() {
    let links = PendingIdentityLinks::default();
    let id = insert_request(&links, "aabbcc");
    let account = account_keys();
    let json = format!(
        r#"{{"v":2,"sk":"{}","nonce":"aabbcc","exp":{}}}"#,
        sk_hex(&account),
        NOW + 300
    );
    let payload = web_payload(&links, 0, &account, &json);

    let rejection = consume_identity_payload(&links, &payload, &from_hex(&account), NOW)
        .expect_err("must reject");
    assert_eq!(rejection.error, IdentityLinkError::Malformed);
    assert_eq!(rejection.id, Some(id));
}

#[test]
fn rejects_payloads_that_stray_from_the_four_field_shape() {
    let links = PendingIdentityLinks::default();
    insert_request(&links, "aabbcc");
    let account = account_keys();
    let sk = sk_hex(&account);
    // An extra field is as much a violation as a missing one.
    for json in [
        format!(
            r#"{{"v":1,"sk":"{sk}","nonce":"aabbcc","exp":{},"x":1}}"#,
            NOW + 300
        ),
        format!(r#"{{"v":1,"sk":"{sk}","exp":{}}}"#, NOW + 300),
    ] {
        let payload = web_payload(&links, 0, &account, &json);
        let rejection = consume_identity_payload(&links, &payload, &from_hex(&account), NOW)
            .expect_err("must reject");
        assert_eq!(rejection.error, IdentityLinkError::Malformed);
    }
}

#[test]
fn rejects_a_payload_with_an_unparseable_key() {
    let links = PendingIdentityLinks::default();
    insert_request(&links, "aabbcc");
    let account = account_keys();
    let payload = web_payload(
        &links,
        0,
        &account,
        &canonical_json("not-a-secret-key", "aabbcc", NOW + 300),
    );

    let rejection = consume_identity_payload(&links, &payload, &from_hex(&account), NOW)
        .expect_err("must reject");
    assert_eq!(rejection.error, IdentityLinkError::Malformed);
}

#[test]
fn rejects_malformed_envelopes() {
    let links = PendingIdentityLinks::default();
    insert_request(&links, "aabbcc");
    let account = account_keys();
    let payload = web_payload(
        &links,
        0,
        &account,
        &canonical_json(&sk_hex(&account), "aabbcc", NOW + 300),
    );

    // Not a base64url envelope at all (and the empty payload) fail before
    // any decryption attempt and carry no request id.
    for bad in ["", "!!!not base64!!!"] {
        let rejection = consume_identity_payload(&links, bad, &from_hex(&account), NOW)
            .expect_err("must reject");
        assert_eq!(rejection.error, IdentityLinkError::Malformed);
        assert_eq!(rejection.id, None);
    }
    // A `from` that is not a pubkey is malformed, not decryptable.
    let rejection = consume_identity_payload(&links, &payload, "zz", NOW).expect_err("must reject");
    assert_eq!(rejection.error, IdentityLinkError::Malformed);
    // A structurally valid envelope no pending request can decrypt is
    // reported as "no request", not malformed.
    let rejection = consume_identity_payload(&links, "aGVsbG8", &from_hex(&account), NOW)
        .expect_err("must reject");
    assert_eq!(rejection.error, IdentityLinkError::NoPendingRequest);
}

#[test]
fn rejects_a_payload_when_no_request_is_outstanding() {
    let links = PendingIdentityLinks::default();
    let rejection = consume_identity_payload(&links, "aGVsbG8", &from_hex(&account_keys()), NOW)
        .expect_err("nothing pending");
    assert_eq!(rejection.error, IdentityLinkError::NoPendingRequest);
}

#[test]
fn pending_requests_are_bounded_and_pruned() {
    let links = PendingIdentityLinks::default();
    // A stale request is pruned on the next insert.
    links.insert_pending(
        PendingIdentityLink {
            id: "stale".to_string(),
            nonce_hex: "00".to_string(),
            keys: fixed_keys(2),
            created_at: NOW - PENDING_LINK_TTL_SECS - 1,
        },
        NOW,
    );
    for _ in 0..(MAX_PENDING_LINKS + 2) {
        insert_request(&links, "aabbcc");
    }
    let queue = links.lock();
    assert_eq!(queue.len(), MAX_PENDING_LINKS);
    assert!(queue.iter().all(|item| item.id != "stale"));
}

#[test]
fn link_url_matches_the_frozen_contract() {
    let url = build_link_url("app.example.com", "PUBHEX", "NONCEHEX").expect("url");
    assert_eq!(
        url.as_str(),
        "https://app.example.com/link-device?pub=PUBHEX&nonce=NONCEHEX&cb=creaton%3A%2F%2Fidentity"
    );
    let pairs: Vec<(String, String)> = url
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    assert!(pairs.contains(&("pub".to_string(), "PUBHEX".to_string())));
    assert!(pairs.contains(&("nonce".to_string(), "NONCEHEX".to_string())));
    assert!(pairs.contains(&("cb".to_string(), "creaton://identity".to_string())));
}

#[test]
fn link_url_refuses_a_non_https_web_host() {
    assert!(build_link_url("http://app.example.com", "PUB", "N").is_err());
    assert!(build_link_url("https://user@evil.example.com", "PUB", "N").is_err());
    assert!(normalize_web_origin("app.example.com").is_ok());
}

// ── Web-host resolution (sign-in must work with no environment) ────────────

#[test]
fn web_origin_prefers_the_explicit_env_override() {
    assert_eq!(
        web_origin_from(Some("app.example.com"), Some("wss://relay.example")).expect("origin"),
        "https://app.example.com"
    );
}

#[test]
fn web_origin_derives_from_the_active_community_relay() {
    // The relay serves the web bundle at its own origin: `wss→https` /
    // `ws→http`, host and port kept.
    assert_eq!(
        web_origin_from(None, Some("wss://acme.communities.buzz.xyz")).expect("origin"),
        "https://acme.communities.buzz.xyz"
    );
    assert_eq!(
        web_origin_from(None, Some("ws://localhost:3000")).expect("origin"),
        "http://localhost:3000"
    );
}

#[test]
fn web_origin_without_a_community_is_actionable_and_opens_nothing() {
    let error = web_origin_from(None, None).expect_err("no community");
    assert!(error.contains("Connect a community first"), "{error}");
}

#[test]
fn web_origin_refuses_plain_http_off_loopback() {
    assert!(web_origin_from(None, Some("ws://relay.example:3000")).is_err());
}

// ── URL redaction (query strings are payload material) ─────────────────────

#[test]
fn redaction_keeps_scheme_host_path_and_drops_the_query() {
    let url =
        Url::parse("https://app.example.com/link-device?pub=PUBHEX&nonce=NONCEHEX").expect("url");
    assert_eq!(
        redact_url_for_log(&url),
        "https://app.example.com/link-device"
    );
    // The opener's scope error embeds the full target URL; the surfaced
    // message must carry only the redacted form.
    let detail = format!("Not allowed to open url {}", url.as_str());
    assert_eq!(
        sanitized_open_error(&detail, &url),
        "Not allowed to open url https://app.example.com/link-device"
    );
}

// ── Cross-language golden fixture ──────────────────────────────────────────

/// The fixed inputs and the generated wire values, as produced by the actual
/// TypeScript web stack (nostr-tools NIP-44 + `link-device.ts` builders).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoldenFixture {
    one_time_sk: String,
    account_sk: String,
    nonce: String,
    exp: u64,
    p: String,
    from: String,
}

/// THE interop proof: `p`/`from` generated by the TS code must link through
/// the exact production Rust core — and an altered `from` must not. (NIP-44
/// encrypts with a random nonce, so the fixture is a captured artifact, not
/// a regeneration target; it lives next to its generator in
/// `packages/creaton-core/test-fixtures/`.)
#[test]
fn golden_fixture_from_the_typescript_web_code_links_the_account() {
    let fixture: GoldenFixture = serde_json::from_str(include_str!(
        "../../../packages/creaton-core/test-fixtures/link-device-golden.json"
    ))
    .expect("golden fixture parses");

    let one_time = nostr::Keys::new(
        nostr::SecretKey::from_hex(&fixture.one_time_sk).expect("fixture one-time key parses"),
    );
    let account = nostr::Keys::new(
        nostr::SecretKey::from_hex(&fixture.account_sk).expect("fixture account key parses"),
    );
    assert_eq!(fixture.from, account.public_key().to_hex());
    let altered_from = one_time.public_key().to_hex();

    let links = PendingIdentityLinks::default();
    links.insert_pending(
        PendingIdentityLink {
            id: "golden".to_string(),
            nonce_hex: fixture.nonce.clone(),
            keys: one_time.clone(),
            created_at: fixture.exp - 10,
        },
        fixture.exp - 10,
    );
    let consumed = consume_identity_payload(&links, &fixture.p, &fixture.from, fixture.exp - 10)
        .expect("TS-generated fixture must link");
    assert_eq!(consumed.keys.public_key(), account.public_key());
    assert_eq!(links.lock().len(), 0, "the golden request is single-use");

    // An altered `from` (a valid but wrong pubkey) derives no matching
    // conversation key — the fixture must be rejected and nothing consumed.
    let links = PendingIdentityLinks::default();
    links.insert_pending(
        PendingIdentityLink {
            id: "golden-2".to_string(),
            nonce_hex: fixture.nonce.clone(),
            keys: one_time,
            created_at: fixture.exp - 10,
        },
        fixture.exp - 10,
    );
    let rejection = consume_identity_payload(&links, &fixture.p, &altered_from, fixture.exp - 10)
        .expect_err("altered from must be rejected");
    assert_eq!(rejection.error, IdentityLinkError::NoPendingRequest);
    assert_eq!(links.lock().len(), 1, "rejection consumes nothing");
}
