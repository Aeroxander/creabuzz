//! End-to-end tests for SIWE (EIP-4361) onboarding — creabuzz.
//!
//! These tests require a running relay started with `BUZZ_EVM_AUTH=true`
//! (and Postgres + Redis). They are marked `#[ignore]` so plain `cargo test`
//! skips them.
//!
//! # Running
//!
//! ```text
//! BUZZ_EVM_AUTH=true just relay &
//! cargo test --test e2e_siwe -- --ignored
//! ```

use buzz_evm_auth::{
    personal_sign_digest, AttestationEnvelope, Eip712Domain, EvmAddress, NostrSignerAttestation,
};
use chrono::{SecondsFormat, Utc};
use k256::ecdsa::SigningKey;
use k256::schnorr::SigningKey as SchnorrSigningKey;
use nostr::{EventBuilder, Keys, Kind, Tag};
use serde_json::{json, Value};
use sha2::{Digest as _, Sha256};
use signature::hazmat::PrehashSigner;

fn relay_http_url() -> String {
    std::env::var("RELAY_URL")
        .unwrap_or_else(|_| "ws://localhost:3000".to_string())
        .replace("wss://", "https://")
        .replace("ws://", "http://")
        .trim_end_matches('/')
        .to_string()
}

/// Chain id used in test SIWE messages (accepted when the relay has no
/// BUZZ_EVM_CHAIN_ID configured).
const TEST_CHAIN_ID: u64 = 8453;

/// A fresh identity: one EVM key (the root) + one Nostr keypair (device key).
struct TestIdentity {
    evm_key: SigningKey,
    address: EvmAddress,
    nostr_keys: Keys,
}

impl TestIdentity {
    fn generate() -> Self {
        let secret: [u8; 32] = rand::random();
        let evm_key = SigningKey::from_slice(&secret).expect("valid secp256k1 secret");
        let address = EvmAddress::from_verifying_key(evm_key.verifying_key());
        Self {
            evm_key,
            address,
            nostr_keys: Keys::generate(),
        }
    }

    fn npub_hex(&self) -> String {
        self.nostr_keys.public_key().to_hex()
    }
}

/// Sign `msg` as Ethereum `personal_sign`; returns 65-byte hex (v = 27/28).
fn sign_personal(key: &SigningKey, msg: &[u8]) -> String {
    let digest = personal_sign_digest(msg);
    let (sig, recid) = key.sign_prehash_recoverable(&digest).expect("sign");
    let mut bytes = sig.to_bytes().to_vec();
    bytes.push(if recid.is_y_odd() { 28 } else { 27 });
    hex::encode(bytes)
}

/// Canonical SIWE message for the local relay tenant (`localhost`).
fn build_siwe_message(identity: &TestIdentity, nonce: &str, with_npub_resource: bool) -> String {
    let issued_at = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    let mut msg = format!(
        "localhost wants you to sign in with your Ethereum account:\n{}\n\n\nURI: http://localhost:3000\nVersion: 1\nChain ID: {TEST_CHAIN_ID}\nNonce: {nonce}\nIssued At: {issued_at}",
        identity.address,
    );
    if with_npub_resource {
        msg.push_str(&format!("\nResources:\n- nostr:{}", identity.npub_hex()));
    }
    msg
}

/// Signed Nostr proof event for the registration endpoint.
fn build_nostr_proof(identity: &TestIdentity, content_address: &EvmAddress) -> nostr::Event {
    EventBuilder::new(Kind::Custom(27235), content_address.to_hex())
        .tags(vec![Tag::parse(["u", "/auth/siwe/register"]).expect("tag")])
        .sign_with_keys(&identity.nostr_keys)
        .expect("sign proof event")
}

/// Signed Nostr proof event for the revocation endpoint.
fn build_revoke_proof(identity: &TestIdentity, content_address: &EvmAddress) -> nostr::Event {
    EventBuilder::new(Kind::Custom(27235), content_address.to_hex())
        .tags(vec![Tag::parse(["u", "/auth/siwe/revoke"]).expect("tag")])
        .sign_with_keys(&identity.nostr_keys)
        .expect("sign revoke proof")
}

async fn post_revoke(
    client: &reqwest::Client,
    base: &str,
    identity: &TestIdentity,
    proof_address: &EvmAddress,
) -> (u16, Value) {
    let proof = build_revoke_proof(identity, proof_address);
    let response = client
        .post(format!("{base}/auth/siwe/revoke"))
        .json(&json!({ "nostr_proof": proof }))
        .send()
        .await
        .expect("revoke request");
    let status = response.status().as_u16();
    let json: Value = response.json().await.expect("revoke json");
    (status, json)
}

/// Build a signed EIP-712 `NostrSigner` attestation binding the identity's EVM
/// root to its Nostr npub, wrapped in the persisted envelope shape.
fn build_attestation_envelope(identity: &TestIdentity) -> serde_json::Value {
    let npub_bytes: [u8; 32] = {
        let mut b = [0u8; 32];
        let hex = identity.npub_hex();
        hex::decode_to_slice(&hex, &mut b).expect("npub hex");
        b
    };
    let att = NostrSignerAttestation {
        account: identity.address,
        npub: npub_bytes,
        expires: 2_000_000_000,
        nonce: 1,
    };
    let domain = Eip712Domain {
        name: "creabuzz".into(),
        version: "1".into(),
        chain_id: TEST_CHAIN_ID,
        verifying_contract: EvmAddress::from_bytes([0u8; 20]),
    };
    let digest = att.digest(&domain);
    let (sig, recid) = identity
        .evm_key
        .sign_prehash_recoverable(&digest)
        .expect("sign attestation");
    let mut bytes = sig.to_bytes().to_vec();
    bytes.push(if recid.is_y_odd() { 28 } else { 27 });
    let envelope = AttestationEnvelope {
        attestation: att,
        domain,
        signature: hex::encode(bytes),
    };
    serde_json::to_value(envelope).expect("attestation json")
}

async fn fetch_nonce(client: &reqwest::Client, base: &str) -> String {
    let response = client
        .get(format!("{base}/auth/siwe/nonce"))
        .send()
        .await
        .expect("nonce request");
    let status = response.status();
    let body: Value = response.json().await.expect("nonce json");
    assert_eq!(status, 200, "nonce endpoint (is BUZZ_EVM_AUTH on?): {body}");
    body["nonce"].as_str().expect("nonce field").to_string()
}

async fn post_register(
    client: &reqwest::Client,
    base: &str,
    identity: &TestIdentity,
    message: &str,
    proof_address: &EvmAddress,
) -> (u16, Value) {
    let signature = sign_personal(&identity.evm_key, message.as_bytes());
    let proof = build_nostr_proof(identity, proof_address);
    let body = json!({
        "message": message,
        "signature": signature,
        "nostr_proof": proof,
    });
    let response = client
        .post(format!("{base}/auth/siwe/register"))
        .json(&body)
        .send()
        .await
        .expect("register request");
    let status = response.status().as_u16();
    let json: Value = response.json().await.expect("register json");
    (status, json)
}

#[tokio::test]
#[ignore]
async fn siwe_register_flow() {
    let client = reqwest::Client::new();
    let base = relay_http_url();
    let identity = TestIdentity::generate();

    let nonce = fetch_nonce(&client, &base).await;
    let message = build_siwe_message(&identity, &nonce, true);

    let (status, body) =
        post_register(&client, &base, &identity, &message, &identity.address).await;
    assert_eq!(status, 200, "register: {body}");
    assert_eq!(body["status"], "joined");
    assert_eq!(body["npub"], identity.npub_hex());
    assert_eq!(body["evm_address"], identity.address.to_hex());

    // Second registration (new nonce) is idempotent.
    let nonce2 = fetch_nonce(&client, &base).await;
    let message2 = build_siwe_message(&identity, &nonce2, true);
    let (status2, body2) =
        post_register(&client, &base, &identity, &message2, &identity.address).await;
    assert_eq!(status2, 200, "re-register: {body2}");
    assert_eq!(body2["status"], "already_member");
}

#[tokio::test]
#[ignore]
async fn siwe_rejects_unknown_nonce() {
    let client = reqwest::Client::new();
    let base = relay_http_url();
    let identity = TestIdentity::generate();

    // Well-formed but never-issued nonce.
    let message = build_siwe_message(&identity, "deadbeefdeadbeefdeadbeefdeadbeef", true);
    let (status, body) =
        post_register(&client, &base, &identity, &message, &identity.address).await;
    assert_eq!(status, 403, "expected nonce rejection: {body}");
    assert_eq!(body["error"], "nonce_invalid");
}

#[tokio::test]
#[ignore]
async fn siwe_rejects_missing_npub_binding() {
    let client = reqwest::Client::new();
    let base = relay_http_url();
    let identity = TestIdentity::generate();

    let nonce = fetch_nonce(&client, &base).await;
    // Signed message WITHOUT the `Resources: - nostr:<npub>` binding.
    let message = build_siwe_message(&identity, &nonce, false);
    let (status, body) =
        post_register(&client, &base, &identity, &message, &identity.address).await;
    assert_eq!(status, 403, "expected binding rejection: {body}");
}

#[tokio::test]
#[ignore]
async fn siwe_rejects_proof_address_mismatch() {
    let client = reqwest::Client::new();
    let base = relay_http_url();
    let identity = TestIdentity::generate();
    let other = TestIdentity::generate();

    let nonce = fetch_nonce(&client, &base).await;
    let message = build_siwe_message(&identity, &nonce, true);
    // Nostr proof carries a *different* EVM address than the SIWE message.
    let (status, body) = post_register(&client, &base, &identity, &message, &other.address).await;
    assert_eq!(status, 403, "expected mismatch rejection: {body}");
}

#[tokio::test]
#[ignore]
async fn siwe_revoke_flow() {
    let client = reqwest::Client::new();
    let base = relay_http_url();
    let identity = TestIdentity::generate();

    // Register first so a binding + membership exist.
    let nonce = fetch_nonce(&client, &base).await;
    let message = build_siwe_message(&identity, &nonce, true);
    let (status, _) = post_register(&client, &base, &identity, &message, &identity.address).await;
    assert_eq!(status, 200, "precondition register");

    // Revoke with a valid proof (same EVM address as the binding).
    let (revoke_status, body) = post_revoke(&client, &base, &identity, &identity.address).await;
    assert_eq!(revoke_status, 200, "revoke: {body}");
    assert_eq!(body["status"], "revoked");

    // Re-registering the revoked npub is rejected.
    let nonce2 = fetch_nonce(&client, &base).await;
    let message2 = build_siwe_message(&identity, &nonce2, true);
    let (re_status, re_body) =
        post_register(&client, &base, &identity, &message2, &identity.address).await;
    assert_eq!(re_status, 403, "revoked re-register should fail: {re_body}");
    assert_eq!(re_body["error"], "evm_identity_revoked");
}

#[tokio::test]
#[ignore]
async fn siwe_revoke_rejects_unregistered() {
    let client = reqwest::Client::new();
    let base = relay_http_url();
    let identity = TestIdentity::generate();

    let (status, body) = post_revoke(&client, &base, &identity, &identity.address).await;
    assert_eq!(status, 404, "expected not_found: {body}");
    assert_eq!(body["error"], "evm_identity_not_found");
}

#[tokio::test]
#[ignore]
async fn siwe_revoke_rejects_address_mismatch() {
    let client = reqwest::Client::new();
    let base = relay_http_url();
    let identity = TestIdentity::generate();
    let other = TestIdentity::generate();

    let nonce = fetch_nonce(&client, &base).await;
    let message = build_siwe_message(&identity, &nonce, true);
    let (status, _) = post_register(&client, &base, &identity, &message, &identity.address).await;
    assert_eq!(status, 200, "precondition register");

    // Proof carries a different EVM address than the binding.
    let (revoke_status, body) = post_revoke(&client, &base, &identity, &other.address).await;
    assert_eq!(revoke_status, 403, "expected mismatch: {body}");
}

#[tokio::test]
#[ignore]
async fn siwe_register_with_attestation() {
    let client = reqwest::Client::new();
    let base = relay_http_url();
    let identity = TestIdentity::generate();

    let nonce = fetch_nonce(&client, &base).await;
    let message = build_siwe_message(&identity, &nonce, true);
    let signature = sign_personal(&identity.evm_key, message.as_bytes());
    let proof = build_nostr_proof(&identity, &identity.address);
    let attestation = build_attestation_envelope(&identity);

    let response = client
        .post(format!("{base}/auth/siwe/register"))
        .json(&json!({
            "message": message,
            "signature": signature,
            "nostr_proof": proof,
            "attestation": attestation,
        }))
        .send()
        .await
        .expect("register request");
    let status = response.status().as_u16();
    let body: Value = response.json().await.expect("register json");
    assert_eq!(status, 200, "register with attestation: {body}");
    assert_eq!(body["status"], "joined");
}

#[tokio::test]
#[ignore]
async fn siwe_rejects_attestation_address_mismatch() {
    let client = reqwest::Client::new();
    let base = relay_http_url();
    let identity = TestIdentity::generate();
    let other = TestIdentity::generate();

    let nonce = fetch_nonce(&client, &base).await;
    let message = build_siwe_message(&identity, &nonce, true);
    let signature = sign_personal(&identity.evm_key, message.as_bytes());
    let proof = build_nostr_proof(&identity, &identity.address);
    // Attestation binds `other`'s EVM root, which ≠ the SIWE address.
    let attestation = build_attestation_envelope(&other);

    let response = client
        .post(format!("{base}/auth/siwe/register"))
        .json(&json!({
            "message": message,
            "signature": signature,
            "nostr_proof": proof,
            "attestation": attestation,
        }))
        .send()
        .await
        .expect("register request");
    let status = response.status().as_u16();
    let body: Value = response.json().await.expect("register json");
    assert_eq!(status, 403, "expected attestation mismatch: {body}");
}

// ── EVM key-rotation continuity (kind 30200) ─────────────────────────────────

fn rotation_ws_url() -> String {
    std::env::var("RELAY_URL")
        .unwrap_or_else(|_| "ws://localhost:3000".to_string())
        .trim_end_matches('/')
        .to_string()
}

/// Build a signed kind:30200 rotation event: old npub delegates to new npub.
fn build_rotation_event(old_keys: &Keys, new_npub: &str, evm: &str) -> nostr::Event {
    // NIP-26 delegation token: old npub signs sha256("nostr:delegation:<new>:<conditions>").
    let conditions = "kind=1&created_at>1674834236&created_at<2000000000";
    let message = format!("nostr:delegation:{new_npub}:{conditions}");
    let digest = Sha256::digest(message.as_bytes());
    let secret: [u8; 32] = {
        let mut s = [0u8; 32];
        hex::decode_to_slice(&old_keys.secret_key().to_secret_hex(), &mut s)
            .expect("old secret hex");
        s
    };
    let sk = SchnorrSigningKey::from_bytes(&secret).expect("schnorr key");
    let token = sk.sign_prehash(&digest).expect("sign delegation");
    let token_hex = hex::encode(token.to_bytes());

    let d_tag = Tag::parse(["d", &format!("evm-rotation:{new_npub}")]).expect("d tag");
    let p_tag = Tag::parse(["p", new_npub]).expect("p tag");
    let delegation_tag = Tag::parse([
        "delegation",
        &old_keys.public_key().to_hex(),
        conditions,
        &token_hex,
    ])
    .expect("delegation tag");

    EventBuilder::new(Kind::Custom(30200), evm)
        .tags([d_tag, p_tag, delegation_tag])
        .sign_with_keys(old_keys)
        .expect("sign rotation event")
}

#[tokio::test]
#[ignore]
async fn evm_rotation_event_is_accepted_and_stored() {
    use buzz_test_client::BuzzTestClient;

    let old_keys = Keys::parse(&hex::encode([7u8; 32])).unwrap();
    let new_keys = Keys::parse(&hex::encode([9u8; 32])).unwrap();
    let new_npub = new_keys.public_key().to_hex();

    let event = build_rotation_event(&old_keys, &new_npub, "0xdeadbeef");

    let mut client = BuzzTestClient::connect(&rotation_ws_url(), &old_keys)
        .await
        .expect("connect + auth");
    let ok = client
        .send_event(event.clone())
        .await
        .expect("send rotation event");
    assert!(ok.accepted, "rotation event should be accepted: {ok:?}");
}

#[tokio::test]
#[ignore]
async fn evm_rotation_forged_token_is_rejected() {
    use buzz_test_client::BuzzTestClient;

    let old_keys = Keys::parse(&hex::encode([7u8; 32])).unwrap();
    let new_keys = Keys::parse(&hex::encode([9u8; 32])).unwrap();
    let new_npub = new_keys.public_key().to_hex();

    // Tamper: sign the delegation for a *different* condition than the tag
    // carries, so the token no longer matches.
    let conditions_tag = "kind=7";
    let conditions_signed = "kind=1";
    let message = format!("nostr:delegation:{new_npub}:{conditions_signed}");
    let digest = Sha256::digest(message.as_bytes());
    let secret: [u8; 32] = {
        let mut s = [0u8; 32];
        hex::decode_to_slice(&old_keys.secret_key().to_secret_hex(), &mut s).unwrap();
        s
    };
    let sk = SchnorrSigningKey::from_bytes(&secret).unwrap();
    let token = sk.sign_prehash(&digest).unwrap();
    let token_hex = hex::encode(token.to_bytes());

    let d_tag = Tag::parse(["d", &format!("evm-rotation:{new_npub}")]).expect("d tag");
    let p_tag = Tag::parse(["p", &new_npub]).expect("p tag");
    let delegation_tag = Tag::parse([
        "delegation",
        &old_keys.public_key().to_hex(),
        conditions_tag,
        &token_hex,
    ])
    .expect("delegation tag");
    let event = EventBuilder::new(Kind::Custom(30200), "0xdeadbeef")
        .tags([d_tag, p_tag, delegation_tag])
        .sign_with_keys(&old_keys)
        .expect("sign rotation event");

    let mut client = BuzzTestClient::connect(&rotation_ws_url(), &old_keys)
        .await
        .expect("connect + auth");
    let ok = client
        .send_event(event)
        .await
        .expect("send forged rotation event");
    assert!(
        !ok.accepted,
        "forged rotation delegation must be rejected, got: {ok:?}"
    );
    assert!(
        ok.message.contains("rotation delegation rejected"),
        "unexpected rejection message: {ok:?}"
    );
}

#[tokio::test]
#[ignore]
async fn siwe_nip05_alias_claims_and_resolves() {
    let client = reqwest::Client::new();
    let base = relay_http_url();
    let identity = TestIdentity::generate();

    let nonce = fetch_nonce(&client, &base).await;
    let message = build_siwe_message(&identity, &nonce, true);
    let signature = sign_personal(&identity.evm_key, message.as_bytes());
    let proof = build_nostr_proof(&identity, &identity.address);

    let alias = format!("alice-siwe-{}", &identity.npub_hex()[..12]);

    let response = client
        .post(format!("{base}/auth/siwe/register"))
        .json(&json!({
            "message": message,
            "signature": signature,
            "nostr_proof": proof,
            "nip05_handle": format!("{alias}@localhost"),
        }))
        .send()
        .await
        .expect("register request");
    let status = response.status().as_u16();
    let body: Value = response.json().await.expect("register json");
    assert_eq!(status, 200, "register with nip05: {body}");

    // Resolve the alias via NIP-05 → should point at the joining npub.
    let nip05 = client
        .get(format!("{base}/.well-known/nostr.json?name={alias}"))
        .send()
        .await
        .expect("nip05 request");
    let nip05_body: Value = nip05.json().await.expect("nip05 json");
    let resolved = nip05_body["names"][alias]
        .as_str()
        .unwrap_or_default()
        .to_string();
    assert_eq!(
        resolved,
        identity.npub_hex(),
        "nip05 resolution: {nip05_body}"
    );
}

#[tokio::test]
#[ignore]
async fn siwe_nip05_rejects_foreign_domain() {
    let client = reqwest::Client::new();
    let base = relay_http_url();
    let identity = TestIdentity::generate();

    let nonce = fetch_nonce(&client, &base).await;
    let message = build_siwe_message(&identity, &nonce, true);
    let signature = sign_personal(&identity.evm_key, message.as_bytes());
    let proof = build_nostr_proof(&identity, &identity.address);

    // Alias claims a domain that is not the relay host → rejected.
    let response = client
        .post(format!("{base}/auth/siwe/register"))
        .json(&json!({
            "message": message,
            "signature": signature,
            "nostr_proof": proof,
            "nip05_handle": "alice@other.example",
        }))
        .send()
        .await
        .expect("register request");
    let status = response.status().as_u16();
    let body: Value = response.json().await.expect("register json");
    assert_eq!(status, 400, "foreign nip05 domain: {body}");
}
