//! Anvil-backed integration test for the allowance guard.
//!
//! `#[ignore]`d: it needs a real anvil and a deployed `OrgAllowance.sol`.
//! Run manually:
//!
//! ```bash
//! # 1. chain
//! anvil &                                        # 127.0.0.1:8545, default keys
//!
//! # 2. deploy + configure (from contracts/)
//! cd contracts
//! forge script script/DeployOrgAllowance.s.sol --rpc-url anvil --broadcast \
//!   --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
//! ```
//!
//! Then, with the deployed address exported as `TEST_ALLOWANCE_CONTRACT`:
//!
//! ```bash
//! cargo test -p buzz-evm-allowance --test anvil -- --ignored --nocapture
//! ```
//!
//! The test drives admin calls (setSpender/setAllowance) itself through the
//! same bounded transaction path the guard uses — the owner key is anvil
//! account 0, the spender is anvil account 1.

use std::time::Duration;

use buzz_evm_allowance::{AllowanceClient, AllowanceDecision, AllowanceError, Window};

const RPC: &str = "http://127.0.0.1:8545";
const OWNER_KEY: &str = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const SPENDER_KEY: &str = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
/// Per-run subject: the contract's `_spent` counter persists across runs, so
/// each run keys on a fresh 32-byte subject (any 32 bytes work — no ERC-20
/// needed since the contract never moves tokens).
fn unique_subject() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:064x}")
}
/// Token address stand-in (contract does not custody tokens).
const TOKEN: &str = "0x0000000000000000000000000000000000000042";
const ALLOWANCE: u128 = 100_000_000; // 100e6, the deploy script's example

fn contract_address() -> String {
    std::env::var("TEST_ALLOWANCE_CONTRACT")
        .expect("TEST_ALLOWANCE_CONTRACT must point at a deployed OrgAllowance")
}

#[tokio::test]
#[ignore = "needs a running anvil + deployed OrgAllowance (see module docs)"]
async fn allowance_guard_end_to_end() {
    let subject = unique_subject();
    let contract = contract_address();

    // --- owner: authorize the spender and set the epoch allowance --------
    let owner = AllowanceClient::new(RPC, &contract)
        .unwrap()
        .with_spender_key(OWNER_KEY)
        .unwrap();
    let owner_key = k256_test_signer(OWNER_KEY);
    let subject_bytes = hex::decode(&subject).unwrap();
    let mut subject32 = [0u8; 32];
    subject32.copy_from_slice(&subject_bytes);
    let token20 = buzz_evm_allowance::test_support::parse_address(TOKEN).unwrap();
    // The authorized spender is the GUARD's key (anvil account 1), not the
    // owner — derive it from the spender key.
    let spender_guard = buzz_evm_allowance::AllowanceClient::new(RPC, &contract)
        .unwrap()
        .with_spender_key(SPENDER_KEY)
        .unwrap();
    let spender_addr = spender_guard.spender_address().unwrap();

    let epoch = Window::Day.epoch_now();
    println!(
        "contract={contract} spender=0x{} epoch={epoch}",
        hex::encode(spender_addr)
    );

    owner
        .send_contract_tx(
            &owner_key,
            &buzz_evm_allowance::test_support::encode_set_spender(&subject32, &spender_addr),
        )
        .await
        .expect("setSpender must land");
    owner
        .send_contract_tx(
            &owner_key,
            &buzz_evm_allowance::test_support::encode_set_allowance(
                &subject32, &token20, epoch, ALLOWANCE,
            ),
        )
        .await
        .expect("setAllowance must land");

    // --- spender: the guard path ----------------------------------------
    let guard = AllowanceClient::new(RPC, &contract)
        .unwrap()
        .with_spender_key(SPENDER_KEY)
        .unwrap();

    // 1. Under-limit spend: allowed, remaining shrinks.
    let decision = guard.check(&subject, TOKEN, 30_000_000, Window::Day).await;
    assert_eq!(
        decision,
        AllowanceDecision::Allowed {
            remaining_after: ALLOWANCE - 30_000_000
        },
        "under-limit spend must be allowed"
    );
    let receipt = guard
        .record_spend(&subject, TOKEN, 30_000_000, Window::Day)
        .await
        .expect("under-limit spend must settle");
    println!("spend tx: {}", receipt.tx_hash);
    assert!(receipt.tx_hash.starts_with("0x") && receipt.tx_hash.len() == 66);

    // 2. After settling, the remaining is reflected onchain.
    let decision = guard.check(&subject, TOKEN, 70_000_001, Window::Day).await;
    assert_eq!(
        decision,
        AllowanceDecision::Exceeded {
            remaining: ALLOWANCE - 30_000_000
        },
        "over-limit spend must be denied with the onchain remaining"
    );

    // 3. Exact remaining still fits.
    let decision = guard.check(&subject, TOKEN, 70_000_000, Window::Day).await;
    assert_eq!(decision, AllowanceDecision::Allowed { remaining_after: 0 });

    // 4. record_spend over the limit: the contract reverts — fail closed.
    let result = guard
        .record_spend(&subject, TOKEN, 70_000_001, Window::Day)
        .await;
    assert!(
        matches!(
            result,
            Err(AllowanceError::SpendRejectedByContract { .. })
                | Err(AllowanceError::SpendReverted { .. })
        ),
        "contract-side over-spend must be refused (simulation or onchain), got {result:?}"
    );

    // 5. Fail closed on a dead node.
    let dead = AllowanceClient::new("http://127.0.0.1:1", &contract)
        .unwrap()
        .with_rpc_timeout(Duration::from_millis(1_500));
    let decision = dead.check(&subject, TOKEN, 1, Window::Day).await;
    assert!(
        matches!(decision, AllowanceDecision::Denied { .. }),
        "an unreachable node must deny, got {decision:?}"
    );
}

/// k256 signer from a hex key (test-only shim to avoid exporting the key
/// type through the crate's public API).
fn k256_test_signer(key_hex: &str) -> k256_signer::SigningKey {
    k256_signer::SigningKey::from_slice(&hex::decode(key_hex.trim_start_matches("0x")).unwrap())
        .unwrap()
}

/// Re-export k256 under a stable name for the test shim above.
mod k256_signer {
    pub use k256::ecdsa::SigningKey;
}
