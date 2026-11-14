//! Interim web → desktop identity handoff (`preview_identity_import_inner`,
//! `import_identity_inner` in `identity.rs`): the preview must be read-only,
//! the replace must be fenced to the npub the user was shown, and a failing
//! persist must leave the previous identity live. The storage backend itself
//! is mocked through the injected `persist` closure — the same seam
//! `app_state_tests::persist_imported_identity_*` uses for the real
//! keyring→file policy, since the OS keyring is unavailable under test.

use std::sync::atomic::Ordering;

use nostr::{Keys, ToBech32};

use super::{import_identity_inner, preview_identity_import_inner};
use crate::app_state::{build_app_state, AppState, IdentityStorage};

/// Fixed vector, agreed with the web client (nostr-tools/@noble): secret
/// 0x11…11 must derive this pubkey/npub on every implementation, so this
/// round-trip fails loudly if either side's parse/derive changes.
const SECRET_HEX: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const SECRET_NSEC: &str = "nsec1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygs4rm7hz";
const EXPECTED_PUBKEY_HEX: &str =
    "4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa";
const EXPECTED_NPUB: &str = "npub1fu64hh9hes90w2808n8tjc2ajp5yhddjef0ctx4s7zmsgp6cwx4qgy4eg9";

/// Everything an import can change about the live identity, for
/// before/after comparison.
fn identity_snapshot(state: &AppState) -> (String, String, bool, bool) {
    let pubkey = state.keys.lock().unwrap().public_key().to_hex();
    let storage = state.identity_storage().as_str().to_string();
    let lost = state.identity_lost.load(Ordering::Acquire);
    let locked = state.keyring_locked.load(Ordering::Acquire);
    (pubkey, storage, lost, locked)
}

#[test]
fn preview_round_trips_the_fixed_vector_for_hex_and_nsec_inputs() {
    let state = build_app_state();

    for input in [SECRET_HEX, SECRET_NSEC] {
        let preview = preview_identity_import_inner(&state, input, None)
            .unwrap_or_else(|e| panic!("preview failed for {input}: {e}"));
        assert_eq!(preview.pubkey, EXPECTED_PUBKEY_HEX, "input: {input}");
        assert_eq!(preview.npub, EXPECTED_NPUB, "input: {input}");
        assert!(!preview.matches_current_identity, "input: {input}");

        let current = state.keys.lock().unwrap().public_key().to_bech32().unwrap();
        assert_eq!(preview.current_npub, current, "input: {input}");
    }
}

#[test]
fn preview_reports_a_match_for_the_identity_live_on_this_device() {
    let state = build_app_state();
    let current_nsec = state.keys.lock().unwrap().secret_key().to_bech32().unwrap();

    let preview = preview_identity_import_inner(&state, &current_nsec, None).unwrap();

    assert!(preview.matches_current_identity);
    assert_eq!(
        preview.pubkey,
        state.keys.lock().unwrap().public_key().to_hex()
    );
}

#[test]
fn preview_never_mutates_the_stored_identity() {
    let state = build_app_state();
    let before = identity_snapshot(&state);

    // A valid candidate, a public key (npub is not an importable private
    // key), and garbage: none of them may change anything.
    preview_identity_import_inner(&state, SECRET_HEX, None).unwrap();
    assert!(preview_identity_import_inner(&state, EXPECTED_NPUB, None).is_err());
    assert!(preview_identity_import_inner(&state, "not-a-key", None).is_err());

    assert_eq!(identity_snapshot(&state), before);
}

#[test]
fn preview_rejects_a_public_key_with_an_honest_error() {
    let state = build_app_state();
    let err = preview_identity_import_inner(&state, EXPECTED_NPUB, None).unwrap_err();
    assert!(err.contains("Invalid private key"), "{err}");
}

/// Replace-safety: persistence failing (keyring AND file fallback both
/// refused) must leave the previous identity live in memory with its storage
/// metadata and recovery flags untouched — the import is an error, never a
/// half-applied swap.
#[test]
fn failed_persist_leaves_the_previous_identity_intact() {
    let state = build_app_state();
    let dir = tempfile::tempdir().unwrap();
    let before = identity_snapshot(&state);

    let err = import_identity_inner(&state, dir.path(), SECRET_HEX, None, None, |_| {
        Err("keyring unavailable".to_string())
    })
    .unwrap_err();

    assert_eq!(err, "keyring unavailable");
    assert_eq!(identity_snapshot(&state), before);
}

/// The confirm fence: an import that names a different "current npub" than
/// the device actually holds was reviewed against a stale identity, so it is
/// refused BEFORE the persist backend is even reached.
#[test]
fn import_refuses_a_candidate_the_user_never_reviewed() {
    let state = build_app_state();
    let dir = tempfile::tempdir().unwrap();
    let before = identity_snapshot(&state);
    let other_npub = Keys::generate().public_key().to_bech32().unwrap();
    let mut persist_called = false;

    let err = import_identity_inner(
        &state,
        dir.path(),
        SECRET_HEX,
        None,
        Some(&other_npub),
        |_| {
            persist_called = true;
            Ok(IdentityStorage::SystemKeyring)
        },
    )
    .unwrap_err();

    assert!(err.contains("changed since you reviewed"), "{err}");
    assert!(
        !persist_called,
        "a fenced import must not reach the persist backend"
    );
    assert_eq!(identity_snapshot(&state), before);
}

/// The happy path: previewed (fenced) import swaps the keyring identity to
/// the candidate, records where the durable write landed, and resolves the
/// recovery flags an import is allowed to resolve.
#[test]
fn reviewed_import_replaces_identity_and_records_storage() {
    let state = build_app_state();
    let dir = tempfile::tempdir().unwrap();
    let current_npub = state.keys.lock().unwrap().public_key().to_bech32().unwrap();
    state.identity_lost.store(true, Ordering::Release);

    let (pubkey, storage) = import_identity_inner(
        &state,
        dir.path(),
        SECRET_HEX,
        None,
        Some(&current_npub),
        |_| Ok(IdentityStorage::SystemKeyring),
    )
    .unwrap();

    assert_eq!(pubkey.to_hex(), EXPECTED_PUBKEY_HEX);
    assert_eq!(storage, IdentityStorage::SystemKeyring);
    assert_eq!(
        state.keys.lock().unwrap().public_key().to_hex(),
        EXPECTED_PUBKEY_HEX
    );
    assert_eq!(state.identity_storage(), IdentityStorage::SystemKeyring);
    assert!(
        !state.identity_lost.load(Ordering::Acquire),
        "a committed import resolves the lost state"
    );
    assert!(
        !state.keyring_locked.load(Ordering::Acquire),
        "a committed import resolves the locked state"
    );
}
