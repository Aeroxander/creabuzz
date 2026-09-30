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
//!
//! The wallet-flow test (`wallet_flows_end_to_end`) is self-contained — it
//! needs only a running anvil (default keys), deploys its own tiny mock
//! `BidSubmitted` emitter as inline bytecode, and covers value transfer,
//! contract creation, `call`/`estimate_gas`, and the bounded log scan used
//! for bid-id discovery:
//!
//! ```bash
//! anvil &                                        # 127.0.0.1:8545, default keys
//! cargo test -p buzz-evm-allowance --features test-support \
//!   --test anvil wallet -- --ignored --nocapture
//! ```

use std::sync::Arc;
use std::time::Duration;

use buzz_evm_allowance::abi::{encode_address_word, encode_uint256, keccak256};
use buzz_evm_allowance::wallet::{
    bid_submitted_topic, Eip1559TxFields, LogEntry, LogFilter, TxReceipt, Wallet, WalletClient,
};
use buzz_evm_allowance::{
    AllowanceClient, AllowanceDecision, AllowanceError, EvmRpc, HttpEvmRpc, Window,
};

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

// ── wallet flows (value transfer, contract creation, logs) ─────────────────

/// Anvil account 1's address (derived from `SPENDER_KEY`); the bid owner
/// whose ids the discovery must enumerate.
fn owner_wallet() -> Wallet {
    Wallet::from_private_key_hex(SPENDER_KEY).unwrap()
}

/// A third party that also bids — their ids must NOT show up in the
/// owner's discovery results.
const OTHER_OWNER: [u8; 20] = [0x33; 20];

/// Sign, broadcast, and await one type-2 transaction from `sender` — the
/// full wallet path `evm_send_transaction` exercises.
async fn send_tx(
    client: &WalletClient,
    sender: &Wallet,
    to: Option<[u8; 20]>,
    value: u128,
    data: &[u8],
    gas_limit: u64,
) -> TxReceipt {
    let fees = client.suggest_eip1559_fees().await.unwrap();
    let nonce = client
        .get_transaction_count(&sender.address())
        .await
        .unwrap();
    let signed = sender
        .sign_eip1559_tx(&Eip1559TxFields {
            chain_id: client.chain_id().await.unwrap(),
            nonce,
            max_priority_fee_per_gas: fees.max_priority_fee_per_gas,
            max_fee_per_gas: fees.max_fee_per_gas,
            gas_limit,
            to,
            value,
            data,
        })
        .unwrap();
    let tx_hash = client.send_raw_transaction(&signed).await.unwrap();
    assert!(tx_hash.starts_with("0x") && tx_hash.len() == 66);
    client.wait_for_receipt(&tx_hash).await.unwrap()
}

/// Inline mock emitter for `BidSubmitted` logs. Every call copies
/// `calldata[0..32]` (the id word) to memory, emits
/// `BidSubmitted(id, owner, …)` with `calldata[32..64]` (the owner word) as
/// `topics[2]`, and returns the id word — self-contained raw EVM bytecode,
/// assembled here around `bid_submitted_topic()` so the emitter and the
/// production topic derivation cannot drift apart.
///
/// ```text
/// runtime:
///   PUSH1 0x20 PUSH1 0x00 PUSH1 0x00 CALLDATACOPY   ; mem[0..32] = id word
///   PUSH1 0x20 CALLDATALOAD                         ; owner word   (topic3)
///   PUSH1 0x00 CALLDATALOAD                         ; id word      (topic2)
///   PUSH32 <BidSubmitted topic0>                               (topic1)
///   PUSH1 0x20 PUSH1 0x00 LOG3                      ; data = id word
///   PUSH1 0x20 PUSH1 0x00 RETURN                    ; echo the id word
/// init (12-byte deployer): CODECOPY the runtime and RETURN it.
/// ```
fn emitter_deploy_code() -> Vec<u8> {
    let mut runtime =
        hex::decode("602060006000376020356000357f").expect("static runtime prefix is hex");
    runtime.extend_from_slice(&bid_submitted_topic());
    runtime.extend_from_slice(&hex::decode("60206000a360206000f3").expect("static suffix is hex"));
    assert!(
        runtime.len() <= 0xff,
        "runtime must fit the 1-byte deployer"
    );
    let mut init = hex::decode(format!(
        "60{:02x}600c60003960{:02x}6000f3",
        runtime.len(),
        runtime.len()
    ))
    .expect("deployer prefix is hex");
    init.extend_from_slice(&runtime);
    init
}

/// Minimal RLP item (single byte < 0x80 verbatim, short string prefix) —
/// enough for the CREATE address derivation, which encodes at most a
/// 20-byte address and an 8-byte nonce.
fn rlp_item(data: &[u8]) -> Vec<u8> {
    assert!(data.len() <= 55, "test RLP only supports short items");
    if data.len() == 1 && data[0] < 0x80 {
        return data.to_vec();
    }
    let mut out = vec![0x80 + data.len() as u8];
    out.extend_from_slice(data);
    out
}

/// `CREATE` address derivation, `keccak256(rlp([sender, nonce]))[12..]`,
/// hand-rolled so the expected address is independent of the receipt the
/// node reports.
fn create_address(sender: &[u8; 20], nonce: u64) -> [u8; 20] {
    let nonce_be = nonce.to_be_bytes();
    let start = nonce_be
        .iter()
        .position(|&b| b != 0)
        .unwrap_or(nonce_be.len());
    let mut payload = rlp_item(sender);
    payload.extend_from_slice(&rlp_item(&nonce_be[start..]));
    let mut encoded = Vec::with_capacity(payload.len() + 1);
    encoded.push(0xc0 + payload.len() as u8);
    encoded.extend_from_slice(&payload);
    let digest = keccak256(&encoded);
    let mut addr = [0u8; 20];
    addr.copy_from_slice(&digest[12..]);
    addr
}

/// Parse a node hex quantity ("0x…") into a u128.
fn parse_u128_hex(value: &str) -> u128 {
    let clean = value.trim().trim_start_matches("0x");
    if clean.is_empty() {
        return 0;
    }
    u128::from_str_radix(clean, 16).unwrap_or_else(|e| panic!("bad hex quantity {value:?}: {e}"))
}

/// `eth_getBalance` at `latest` through the raw transport.
async fn eth_balance(rpc: &Arc<dyn EvmRpc>, address: &[u8; 20]) -> u128 {
    let v = rpc
        .call(
            "eth_getBalance",
            serde_json::json!([format!("0x{}", hex::encode(address)), "latest"]),
            Duration::from_secs(5),
        )
        .await
        .expect("eth_getBalance must answer");
    parse_u128_hex(v.as_str().expect("balance is a hex string"))
}

/// `eth_blockNumber` through the raw transport.
async fn latest_block(rpc: &Arc<dyn EvmRpc>) -> u64 {
    let v = rpc
        .call(
            "eth_blockNumber",
            serde_json::json!([]),
            Duration::from_secs(5),
        )
        .await
        .expect("eth_blockNumber must answer");
    parse_u128_hex(v.as_str().expect("block number is a hex string")) as u64
}

/// The emitter's calldata: `[id word | owner word]`.
fn emitter_calldata(id: u128, owner_addr: &[u8; 20]) -> Vec<u8> {
    let mut out = encode_uint256(id).to_vec();
    out.extend_from_slice(&encode_address_word(owner_addr));
    out
}

/// The bid id a `BidSubmitted` log carries in `topics[1]`.
fn log_bid_id(entry: &LogEntry) -> u128 {
    let mut buf = [0u8; 16];
    buf.copy_from_slice(&entry.topics[1][16..32]);
    u128::from_be_bytes(buf)
}

#[tokio::test]
#[ignore = "needs a running anvil (see module docs)"]
async fn wallet_flows_end_to_end() {
    let sender = Wallet::from_private_key_hex(OWNER_KEY).unwrap();
    let owner = owner_wallet();
    let client = WalletClient::new(RPC).unwrap();
    let raw: Arc<dyn EvmRpc> = Arc::new(HttpEvmRpc::new(RPC).unwrap());

    // --- (a) value transfer (type-2) ---------------------------------------
    let recipient = [0x22u8; 20];
    let balance_before = eth_balance(&raw, &recipient).await;
    let receipt = send_tx(&client, &sender, Some(recipient), 12_345, &[], 21_000).await;
    assert_eq!(
        receipt.contract_address, None,
        "a transfer creates no contract"
    );
    assert!(receipt.block_number > 0);
    assert_eq!(
        receipt.gas_used, 21_000,
        "a bare transfer is exactly intrinsic gas"
    );
    let balance_after = eth_balance(&raw, &recipient).await;
    assert_eq!(
        balance_after - balance_before,
        12_345,
        "the transfer must move exactly value"
    );
    println!("transfer tx: {}", receipt.tx_hash);

    // --- (b) contract creation: deploy the mock BidSubmitted emitter -------
    let init_code = emitter_deploy_code();
    let deploy_nonce = client
        .get_transaction_count(&sender.address())
        .await
        .unwrap();
    let receipt = send_tx(&client, &sender, None, 0, &init_code, 500_000).await;
    let created = receipt
        .contract_address
        .expect("a creation receipt carries the created address");
    assert_eq!(
        created,
        create_address(&sender.address(), deploy_nonce),
        "receipt contractAddress must be CREATE(sender, nonce)"
    );
    let emitter = format!("0x{}", hex::encode(created));
    println!("emitter={emitter} deploy tx: {}", receipt.tx_hash);

    // --- (c) call + estimate_gas + get_logs + find_bid_ids -----------------
    // Three bids: owner 9 first and owner 5 LAST (ascending must come from
    // sorting, not insertion order), plus one for a different owner that
    // the owner-scoped discovery must exclude.
    for (id, bid_owner) in [
        (9u128, owner.address()),
        (6u128, OTHER_OWNER),
        (5u128, owner.address()),
    ] {
        let data = emitter_calldata(id, &bid_owner);
        let data_hex = format!("0x{}", hex::encode(&data));
        // estimate_gas round trip (also sizes the send below).
        let estimate = client
            .estimate_gas(&sender.address_hex(), &emitter, 0, &data_hex)
            .await
            .unwrap();
        assert!(
            estimate > 21_000 && estimate < 200_000,
            "unexpected emitter gas estimate: {estimate}"
        );
        let receipt = send_tx(
            &client,
            &sender,
            Some(created),
            0,
            &data,
            estimate + estimate / 5,
        )
        .await;
        assert_eq!(receipt.contract_address, None);
    }

    // call round trip: the emitter echoes the first calldata word.
    let probe = format!("0x{}", hex::encode(encode_uint256(0x2a)));
    let return_data = client.call(&emitter, &probe).await.unwrap();
    assert_eq!(
        return_data, probe,
        "eth_call must round-trip through the runtime"
    );

    // get_logs round trip: the owner-scoped bid filter.
    let topic0 = bid_submitted_topic();
    let owner_topic = encode_address_word(&owner.address());
    let head = latest_block(&raw).await;
    let entries = client
        .get_logs(&LogFilter {
            address: created,
            topics: vec![Some(topic0), None, Some(owner_topic)],
            from_block: 0,
            to_block: head,
        })
        .await
        .unwrap();
    let mut ids: Vec<u128> = entries.iter().map(log_bid_id).collect();
    ids.sort_unstable();
    assert_eq!(
        ids,
        vec![5, 9],
        "get_logs must return exactly the owner's bids"
    );
    for entry in &entries {
        assert_eq!(entry.topics[0], topic0);
        assert_eq!(entry.topics[2], owner_topic);
        assert_eq!(
            entry.data,
            encode_uint256(log_bid_id(entry)).to_vec(),
            "the emitter stores the id word as log data"
        );
    }

    // An id-targeted filter lands on exactly one log, owned by the owner.
    let entries = client
        .get_logs(&LogFilter {
            address: created,
            topics: vec![Some(topic0), Some(encode_uint256(5)), None],
            from_block: 0,
            to_block: head,
        })
        .await
        .unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].topics[2], owner_topic);

    // find_bid_ids round trip: ascending decimal-ready ids, other owners
    // excluded. The emitter has no startBlock()/endBlock() views, so this
    // also proves the documented full-history fallback.
    let ids = client
        .find_bid_ids(&emitter, &owner.address_hex())
        .await
        .unwrap();
    assert_eq!(
        ids,
        vec![5, 9],
        "find_bid_ids must enumerate the owner's bids ascending"
    );
    println!("owner bid ids: {ids:?}");
}
