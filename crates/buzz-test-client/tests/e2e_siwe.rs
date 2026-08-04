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

use buzz_evm_auth::{personal_sign_digest, EvmAddress};
use chrono::{SecondsFormat, Utc};
use k256::ecdsa::SigningKey;
use nostr::{EventBuilder, Keys, Kind, Tag};
use serde_json::{json, Value};

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
