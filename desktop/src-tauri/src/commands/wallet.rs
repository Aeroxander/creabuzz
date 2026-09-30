//! `evm_*` Tauri commands — the launchpad's in-app EVM wallet and
//! transaction primitives (`desktop/src/features/launchpad/walletHooks.ts` /
//! `bidHooks.ts` are the frontend contracts).
//!
//! The wallet key is a single secp256k1 key held in the OS keyring through
//! [`SecretStore`] — the exact store and service scoping the human identity
//! uses (`SecretStore::shared(keyring_service())`), under its own namespaced
//! key name (`evm:wallet`) like the `agent:{pubkey}` entries. There is no
//! file fallback: when the keyring is unavailable, create/import fail
//! loudly rather than dropping key material to disk.
//!
//! Creation and import never overwrite an existing wallet (explicit error;
//! the stored key is never replaced behind the user's back), and every write
//! is read-back-verified against the OS backend before success is reported
//! (the identity persistence pattern).
//!
//! Transactions are EIP-1559 (type-2) only, one transaction per invocation —
//! the frontend flows sequence multi-step actions and own their retry story.
//! `evm_send_transaction`'s `to` is **optional**: omitted (or null/empty) is
//! a contract-creation transaction and the reply's `contractAddress` carries
//! the created address from the receipt. A **mined revert resolves as data**
//! (`status: "reverted"` with the real receipt fields), never as a rejection;
//! transport failures and receipt timeouts are rejections.
//!
//! `evm_find_bid_ids` enumerates an owner's continuous-clearing-auction bid
//! ids from the auction's `BidSubmitted` logs (bounded scan — see
//! `WalletClient::find_bid_ids`).

use serde::Serialize;

use buzz_evm_allowance_pkg::wallet::{Eip1559TxFields, TxReceipt};
use buzz_evm_allowance_pkg::{Wallet, WalletClient, WalletError};

use crate::secret_store::SecretStore;

/// Keyring key name for the app's single EVM wallet private key (bare
/// lowercase 64-hex). Scoped exactly like the identity key: one name in the
/// build-scoped keyring service (`app_state::keyring_service`).
const EVM_WALLET_KEY_NAME: &str = "evm:wallet";

/// Hard cap on any gas limit this app will sign for. The estimate branch
/// gets a 20% margin first; an estimate (or caller-provided limit) whose
/// final limit exceeds this is refused, never clamped into a doomed
/// transaction. 10M is well above the heaviest known flow (the TokenMaster
/// router token deploy, ~4M) and far below any block gas limit.
const GAS_LIMIT_HARD_CAP: u64 = 10_000_000;

/// Serializes the check-then-store wallet creation/import within this
/// process (double-click race). The keyring blob write is already
/// interprocess-locked inside `SecretStore`; this closes the in-process
/// read-check window.
static WALLET_WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The keyring operations the wallet flow needs — the same seam pattern as
/// `IdentityKeyStore` in `app_state.rs`, so create/import/status logic is
/// unit-testable without the live OS keychain.
trait WalletKeyStore {
    fn load(&self, name: &str) -> Result<Option<String>, String>;
    fn store(&self, name: &str, value: &str) -> Result<(), String>;
    /// Read `name` back from the OS backend (bypassing any cache) and
    /// compare against `expected`.
    fn verify_stored(&self, name: &str, expected: &str) -> Result<bool, String>;
}

impl WalletKeyStore for SecretStore {
    fn load(&self, name: &str) -> Result<Option<String>, String> {
        SecretStore::load(self, name)
    }
    fn store(&self, name: &str, value: &str) -> Result<(), String> {
        SecretStore::store(self, name, value)
    }
    fn verify_stored(&self, name: &str, expected: &str) -> Result<bool, String> {
        SecretStore::verify_stored_raw(self, name, expected)
    }
}

/// The shared wallet keyring store (same instance as the identity and agent
/// keys, so all blob mutations contend on one lock/cache).
fn wallet_store() -> &'static SecretStore {
    SecretStore::shared(crate::app_state::keyring_service())
}

/// Load the stored wallet, if any. A stored-but-unparseable key is an
/// explicit error — never silently treated as "no wallet".
fn load_wallet(store: &impl WalletKeyStore) -> Result<Option<Wallet>, String> {
    match store.load(EVM_WALLET_KEY_NAME)? {
        Some(key_hex) => {
            let wallet = Wallet::from_private_key_hex(key_hex.trim())
                .map_err(|e| format!("stored EVM wallet key is unusable: {e}"))?;
            Ok(Some(wallet))
        }
        None => Ok(None),
    }
}

/// Generate and persist a fresh wallet. Refuses when one already exists —
/// creation never overwrites key material.
fn create_wallet(store: &impl WalletKeyStore) -> Result<String, String> {
    let _guard = lock_wallet_writes();
    if let Some(existing) = load_wallet(store)? {
        return Err(format!(
            "an EVM wallet already exists ({}); refusing to overwrite it",
            existing.address_hex()
        ));
    }
    let wallet = Wallet::generate().map_err(|e| format!("generate EVM wallet: {e}"))?;
    persist_wallet(store, &wallet)?;
    Ok(wallet.address_hex())
}

/// Import an existing key (bare or `0x`-prefixed hex). Refuses when a
/// wallet already exists — import never overwrites key material — and
/// persists nothing when the key does not parse.
fn import_wallet(store: &impl WalletKeyStore, private_key_hex: &str) -> Result<String, String> {
    let _guard = lock_wallet_writes();
    if let Some(existing) = load_wallet(store)? {
        return Err(format!(
            "an EVM wallet already exists ({}); refusing to overwrite it",
            existing.address_hex()
        ));
    }
    let clean = private_key_hex
        .trim()
        .trim_start_matches("0x")
        .to_ascii_lowercase();
    let wallet =
        Wallet::from_private_key_hex(&clean).map_err(|e| format!("invalid private key: {e}"))?;
    persist_wallet(store, &wallet)?;
    Ok(wallet.address_hex())
}

/// Store the key (canonical bare lowercase hex) and prove the OS round-trip
/// before reporting success — the identity persistence pattern. On a failed
/// verify this errors: no plaintext fallback, no silent loss.
fn persist_wallet(store: &impl WalletKeyStore, wallet: &Wallet) -> Result<(), String> {
    let key_hex = wallet.to_private_key_hex();
    store.store(EVM_WALLET_KEY_NAME, &key_hex)?;
    if !store.verify_stored(EVM_WALLET_KEY_NAME, &key_hex)? {
        return Err(
            "keyring read-back verify failed for the EVM wallet key; not reporting it saved"
                .to_string(),
        );
    }
    Ok(())
}

/// Lock the create/import check-then-store window (poison-tolerant).
fn lock_wallet_writes() -> std::sync::MutexGuard<'static, ()> {
    match WALLET_WRITE_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

// ── Wire shapes (frontend contracts in features/launchpad/walletHooks.ts and
//    bidHooks.ts) ─────────────────────────────────────────────────────────

/// `evm_wallet_status` reply.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvmWalletStatus {
    /// Whether the keyring holds a wallet key.
    pub has_wallet: bool,
    /// The wallet address, `0x`-prefixed lowercase hex; `None` without one.
    pub address: Option<String>,
}

/// `evm_wallet_create` / `evm_wallet_import` reply.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvmWalletAddress {
    /// The wallet address, `0x`-prefixed lowercase hex.
    pub address: String,
}

/// `evm_chain_status` reply.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvmChainStatus {
    /// Chain id the RPC endpoint reports (`eth_chainId`).
    pub chain_id: u64,
}

/// `evm_call` reply.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvmCallResult {
    /// Raw `0x` return data from `eth_call`.
    pub return_data: String,
}

/// `evm_send_transaction` reply — a mined transaction receipt.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvmSendResult {
    /// Transaction hash, `0x`-prefixed lowercase.
    pub tx_hash: String,
    /// `"success"` or `"reverted"` — a mined revert is data, not a throw.
    pub status: String,
    /// Block the transaction mined in.
    pub block_number: u64,
    /// Gas consumed, as a decimal string (JS-safe).
    pub gas_used: String,
    /// Created contract address (contract-creation calls only), `0x` hex.
    pub contract_address: Option<String>,
}

/// `evm_find_bid_ids` reply.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvmFindBidIdsResult {
    /// Bid ids owned by `owner`, as decimal strings, ascending.
    pub bid_ids: Vec<String>,
}

// ── Commands ──────────────────────────────────────────────────────────────

/// Whether the keyring holds the app's EVM wallet, and its address.
#[tauri::command]
pub async fn evm_wallet_status() -> Result<EvmWalletStatus, String> {
    match load_wallet(wallet_store())? {
        Some(wallet) => Ok(EvmWalletStatus {
            has_wallet: true,
            address: Some(wallet.address_hex()),
        }),
        None => Ok(EvmWalletStatus {
            has_wallet: false,
            address: None,
        }),
    }
}

/// Generate a fresh wallet and persist its key in the keyring. Fails when a
/// wallet already exists — no silent overwrite.
#[tauri::command]
pub async fn evm_wallet_create() -> Result<EvmWalletAddress, String> {
    let address = create_wallet(wallet_store())?;
    Ok(EvmWalletAddress { address })
}

/// Import a secp256k1 private key (bare or `0x`-prefixed hex) into the
/// keyring. Fails when a wallet already exists — no silent overwrite.
#[tauri::command]
pub async fn evm_wallet_import(private_key_hex: String) -> Result<EvmWalletAddress, String> {
    let address = import_wallet(wallet_store(), &private_key_hex)?;
    Ok(EvmWalletAddress { address })
}

/// Bounded `eth_chainId` probe of an RPC endpoint.
#[tauri::command]
pub async fn evm_chain_status(rpc_url: String) -> Result<EvmChainStatus, String> {
    let client = WalletClient::new(rpc_url.trim()).map_err(|e| format!("EVM RPC: {e}"))?;
    let chain_id = client.chain_id().await.map_err(|e| e.to_string())?;
    Ok(EvmChainStatus { chain_id })
}

/// Generic bounded `eth_call` — resolves the raw `0x` return data.
#[tauri::command]
pub async fn evm_call(rpc_url: String, to: String, data: String) -> Result<EvmCallResult, String> {
    let client = WalletClient::new(rpc_url.trim()).map_err(|e| format!("EVM RPC: {e}"))?;
    let return_data = client.call(&to, &data).await.map_err(|e| e.to_string())?;
    Ok(EvmCallResult { return_data })
}

/// Sign, broadcast, and await one EIP-1559 transaction from the stored
/// wallet. Fees come from `suggest_eip1559_fees`; gas is the caller's
/// `gas_limit` or an `eth_estimateGas` with a 20% margin under a hard cap.
///
/// Wire (the frontend contract in `walletHooks.ts` / `bidHooks.ts` builds
/// to exactly this):
///
/// ```text
/// evm_send_transaction({ rpcUrl, chainId, to?, data, value?, gasLimit? })
///     -> { txHash: string, status: "success" | "reverted",
///          blockNumber: number, gasUsed: string,
///          contractAddress: string | null }
/// ```
///
/// `to` is optional on the wire: omitted, `null`, or an empty string is a
/// **contract-creation** transaction (the signer's `to: None`), `data` is
/// then the init code, and `contractAddress` carries the created address
/// from the receipt (`null` for regular calls). A mined revert resolves as
/// `status: "reverted"` data with its real receipt fields; transport
/// failures and receipt timeouts reject (the timeout message carries the tx
/// hash — the outcome may still be unknown).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn evm_send_transaction(
    rpc_url: String,
    chain_id: u64,
    to: Option<String>,
    data: String,
    value: Option<String>,
    gas_limit: Option<String>,
) -> Result<EvmSendResult, String> {
    let wallet = load_wallet(wallet_store())?
        .ok_or_else(|| "no EVM wallet — create or import one first".to_string())?;
    let client = WalletClient::new(rpc_url.trim()).map_err(|e| format!("EVM RPC: {e}"))?;

    let to_addr = parse_optional_to(to.as_deref())?;
    let data_bytes = parse_calldata_hex(&data)?;
    let value_wei = match value.as_deref() {
        Some(raw) => parse_quantity_u128(raw, "value")?,
        None => 0,
    };

    // One invocation = one transaction: nonce at `pending` so flows that
    // sequence sends from the frontend queue rather than collide.
    let nonce = client
        .get_transaction_count(&wallet.address())
        .await
        .map_err(|e| e.to_string())?;
    let fees = client
        .suggest_eip1559_fees()
        .await
        .map_err(|e| e.to_string())?;

    let gas_limit = match gas_limit.as_deref() {
        Some(raw) => check_gas_limit(parse_quantity_u128(raw, "gas limit")?)?,
        None => {
            let estimate = match &to_addr {
                Some(addr) => {
                    let to_hex = format!("0x{}", hex::encode(addr));
                    client
                        .estimate_gas(&wallet.address_hex(), &to_hex, value_wei, &data)
                        .await
                }
                // Contract creation: `eth_estimateGas` without `to`.
                None => {
                    client
                        .estimate_creation_gas(&wallet.address_hex(), value_wei, &data)
                        .await
                }
            }
            .map_err(|e| e.to_string())?;
            apply_gas_margin(estimate)?
        }
    };

    let signed = wallet
        .sign_eip1559_tx(&Eip1559TxFields {
            chain_id,
            nonce,
            max_priority_fee_per_gas: fees.max_priority_fee_per_gas,
            max_fee_per_gas: fees.max_fee_per_gas,
            gas_limit,
            to: to_addr,
            value: value_wei,
            data: &data_bytes,
        })
        .map_err(|e| e.to_string())?;
    let tx_hash = client
        .send_raw_transaction(&signed)
        .await
        .map_err(|e| e.to_string())?;

    match client.wait_for_receipt(&tx_hash).await {
        Ok(receipt) => Ok(send_result(&receipt, "success")),
        Err(WalletError::TxReverted { tx_hash }) => {
            // A MINED REVERT is data (contract). `wait_for_receipt` folds it
            // into an error without the receipt fields, so take one bounded
            // receipt fetch to report the real block/gas/address — the
            // frontend renders "reverted in block N".
            let mined = client
                .mined_receipt(&tx_hash)
                .await
                .map_err(|e| e.to_string())?
                .ok_or_else(|| {
                    format!("transaction {tx_hash} reverted but its receipt vanished (reorg?)")
                })?;
            Ok(send_result(&mined.receipt, "reverted"))
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Enumerate the bid ids `owner` holds on the continuous-clearing-auction
/// at `auction`, discovered from the auction's `BidSubmitted` logs.
///
/// Wire: `evm_find_bid_ids({ rpcUrl, auction, owner }) ->
/// { bidIds: string[] }` — decimal strings, ascending. The scan is bounded
/// (block-range, result-count, and deadline caps — see
/// `WalletClient::find_bid_ids`) and reflects the chain head at call time:
/// bids mined later are not included.
#[tauri::command]
pub async fn evm_find_bid_ids(
    rpc_url: String,
    auction: String,
    owner: String,
) -> Result<EvmFindBidIdsResult, String> {
    let client = WalletClient::new(rpc_url.trim()).map_err(|e| format!("EVM RPC: {e}"))?;
    let ids = client
        .find_bid_ids(auction.trim(), owner.trim())
        .await
        .map_err(|e| e.to_string())?;
    Ok(EvmFindBidIdsResult {
        bid_ids: ids.into_iter().map(|id| id.to_string()).collect(),
    })
}

/// Map a mined receipt onto the wire result (`status` supplied by outcome).
fn send_result(receipt: &TxReceipt, status: &str) -> EvmSendResult {
    EvmSendResult {
        tx_hash: receipt.tx_hash.clone(),
        status: status.to_string(),
        block_number: receipt.block_number,
        gas_used: receipt.gas_used.to_string(),
        contract_address: receipt
            .contract_address
            .map(|addr| format!("0x{}", hex::encode(addr))),
    }
}

/// Parse `0x`-or-bare hex calldata; the empty string is empty calldata.
fn parse_calldata_hex(data: &str) -> Result<Vec<u8>, String> {
    let clean = data.trim().trim_start_matches("0x");
    if clean.is_empty() {
        return Ok(Vec::new());
    }
    hex::decode(clean).map_err(|e| format!("bad calldata hex: {e}"))
}

/// Parse the optional `to` recipient of `evm_send_transaction`: omitted,
/// `null`, or an empty (after trimming) string is contract creation
/// ([`None`]); anything else must be a 20-byte hex address.
fn parse_optional_to(to: Option<&str>) -> Result<Option<[u8; 20]>, String> {
    match to {
        None => Ok(None),
        Some(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return Ok(None);
            }
            buzz_evm_allowance_pkg::abi::parse_address(trimmed)
                .map(Some)
                .map_err(|e| e.to_string())
        }
    }
}

/// Parse a caller-supplied quantity: `0x`-prefixed hex (what the launchpad
/// calldata builders emit for `value`) or a bare decimal integer.
fn parse_quantity_u128(raw: &str, label: &str) -> Result<u128, String> {
    let trimmed = raw.trim();
    let parsed = match trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
    {
        Some(hex_part) => u128::from_str_radix(hex_part, 16),
        None => trimmed.parse::<u128>(),
    };
    parsed.map_err(|e| format!("{label} must be a 0x hex quantity or decimal integer: {e}"))
}

/// Apply the 20% estimate margin and enforce the hard cap (refuse, never
/// clamp).
fn apply_gas_margin(estimate: u64) -> Result<u64, String> {
    let with_margin = estimate.saturating_add(estimate / 5);
    check_gas_limit(u128::from(with_margin)).map_err(|e| format!("gas estimate {estimate}: {e}"))
}

/// Enforce the gas-limit hard cap (refuse, never clamp).
fn check_gas_limit(gas_limit: u128) -> Result<u64, String> {
    let gas_limit =
        u64::try_from(gas_limit).map_err(|_| format!("gas limit {gas_limit} exceeds u64"))?;
    if gas_limit > GAS_LIMIT_HARD_CAP {
        return Err(format!(
            "gas limit {gas_limit} exceeds the {GAS_LIMIT_HARD_CAP} hard cap"
        ));
    }
    Ok(gas_limit)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use super::*;

    /// Fixed test key `0x07…07` (same vector as the wallet crate's tests);
    /// `cast wallet address` derives `0x4a62…c569` for it.
    const KEY_07_HEX: &str = "0x0707070707070707070707070707070707070707070707070707070707070707";
    const ADDR_07: &str = "0x4a62316623ad457f02cdc5d997ded67a383ec569";

    struct FakeStore {
        map: Mutex<HashMap<String, String>>,
    }

    impl FakeStore {
        fn new() -> Self {
            Self {
                map: Mutex::new(HashMap::new()),
            }
        }

        fn keys(&self) -> Vec<String> {
            let mut keys: Vec<String> = self
                .map
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .keys()
                .cloned()
                .collect();
            keys.sort();
            keys
        }
    }

    impl WalletKeyStore for FakeStore {
        fn load(&self, name: &str) -> Result<Option<String>, String> {
            Ok(self
                .map
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .get(name)
                .cloned())
        }
        fn store(&self, name: &str, value: &str) -> Result<(), String> {
            self.map
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(name.to_string(), value.to_string());
            Ok(())
        }
        fn verify_stored(&self, name: &str, expected: &str) -> Result<bool, String> {
            Ok(self.load(name)?.as_deref() == Some(expected))
        }
    }

    // ── keyring round-trip logic (production seam over a fake store) ──────

    #[test]
    fn import_round_trips_through_the_keyring() {
        let store = FakeStore::new();
        let address =
            import_wallet(&store, KEY_07_HEX).unwrap_or_else(|e| panic!("import succeeds: {e}"));
        assert_eq!(address, ADDR_07);

        // Stored canonically (bare lowercase hex) and reloadable.
        assert_eq!(store.keys(), vec![EVM_WALLET_KEY_NAME.to_string()]);
        let loaded = load_wallet(&store)
            .unwrap_or_else(|e| panic!("load succeeds: {e}"))
            .unwrap_or_else(|| panic!("wallet exists"));
        assert_eq!(loaded.address_hex(), ADDR_07);

        let status = match load_wallet(&store) {
            Ok(Some(w)) => EvmWalletStatus {
                has_wallet: true,
                address: Some(w.address_hex()),
            },
            _ => unreachable!("checked above"),
        };
        assert!(status.has_wallet);
        assert_eq!(status.address.as_deref(), Some(ADDR_07));
    }

    #[test]
    fn create_never_overwrites_an_existing_wallet() {
        let store = FakeStore::new();
        let first = create_wallet(&store).unwrap_or_else(|e| panic!("create succeeds: {e}"));
        let err = create_wallet(&store).expect_err("second create must refuse");
        assert!(err.contains("already exists"), "unexpected error: {err}");
        // The stored key is untouched.
        let second = match load_wallet(&store) {
            Ok(Some(w)) => w.address_hex(),
            other => panic!("wallet must remain: {other:?}"),
        };
        assert_eq!(first, second);
    }

    #[test]
    fn import_never_overwrites_an_existing_wallet() {
        let store = FakeStore::new();
        create_wallet(&store).unwrap_or_else(|e| panic!("create succeeds: {e}"));
        let err = import_wallet(&store, KEY_07_HEX).expect_err("import must refuse");
        assert!(err.contains("already exists"), "unexpected error: {err}");
    }

    #[test]
    fn invalid_import_persists_nothing() {
        let store = FakeStore::new();
        let err = import_wallet(&store, "nothex").expect_err("bad key must fail");
        assert!(err.contains("invalid private key"), "unexpected: {err}");
        assert!(store.keys().is_empty(), "nothing may be stored");
        assert!(load_wallet(&store)
            .unwrap_or_else(|e| panic!("load: {e}"))
            .is_none());
    }

    #[test]
    fn stored_but_corrupt_key_is_an_explicit_error() {
        let store = FakeStore::new();
        store
            .store(EVM_WALLET_KEY_NAME, "nothex")
            .unwrap_or_else(|e| panic!("store: {e}"));
        let err = load_wallet(&store).expect_err("corrupt key must not read as absent");
        assert!(err.contains("unusable"), "unexpected: {err}");
    }

    #[test]
    fn generated_wallets_round_trip_and_differ() {
        let store = FakeStore::new();
        let a = create_wallet(&store).unwrap_or_else(|e| panic!("create: {e}"));
        assert!(a.starts_with("0x") && a.len() == 42);
        let loaded = load_wallet(&store)
            .unwrap_or_else(|e| panic!("load: {e}"))
            .unwrap_or_else(|| panic!("wallet exists"));
        assert_eq!(loaded.address_hex(), a);

        let other_store = FakeStore::new();
        let b = create_wallet(&other_store).unwrap_or_else(|e| panic!("create: {e}"));
        assert_ne!(a, b);
    }

    // ── wire shapes (binds the frontend contracts verbatim) ───────────────

    #[test]
    fn wire_shapes_match_the_frontend_contracts() {
        let status = serde_json::to_value(EvmWalletStatus {
            has_wallet: true,
            address: Some(ADDR_07.to_string()),
        })
        .unwrap_or_else(|e| panic!("serializes: {e}"));
        assert_eq!(status["hasWallet"], true);
        assert_eq!(status["address"], ADDR_07);
        assert_eq!(status.as_object().map(|o| o.len()), Some(2));

        let empty = serde_json::to_value(EvmWalletStatus {
            has_wallet: false,
            address: None,
        })
        .unwrap_or_else(|e| panic!("serializes: {e}"));
        assert_eq!(empty["hasWallet"], false);
        assert_eq!(empty["address"], serde_json::Value::Null);

        let address = serde_json::to_value(EvmWalletAddress {
            address: ADDR_07.to_string(),
        })
        .unwrap_or_else(|e| panic!("serializes: {e}"));
        assert_eq!(address["address"], ADDR_07);

        let chain = serde_json::to_value(EvmChainStatus { chain_id: 31_337 })
            .unwrap_or_else(|e| panic!("serializes: {e}"));
        assert_eq!(chain["chainId"], 31_337);

        let call = serde_json::to_value(EvmCallResult {
            return_data: "0x2a".to_string(),
        })
        .unwrap_or_else(|e| panic!("serializes: {e}"));
        assert_eq!(call["returnData"], "0x2a");

        let send = serde_json::to_value(EvmSendResult {
            tx_hash: "0xabc".to_string(),
            status: "reverted".to_string(),
            block_number: 2,
            gas_used: "50000".to_string(),
            contract_address: None,
        })
        .unwrap_or_else(|e| panic!("serializes: {e}"));
        assert_eq!(send["txHash"], "0xabc");
        assert_eq!(send["status"], "reverted");
        assert_eq!(send["blockNumber"], 2);
        assert_eq!(send["gasUsed"], "50000");
        assert_eq!(send["contractAddress"], serde_json::Value::Null);
        assert_eq!(send.as_object().map(|o| o.len()), Some(5));
    }

    #[test]
    fn send_result_formats_contract_address_and_decimal_gas() {
        let receipt = TxReceipt {
            tx_hash: "0xabc".to_string(),
            contract_address: Some([0u8; 20]),
            block_number: 9,
            gas_used: 21_000,
        };
        let result = send_result(&receipt, "success");
        assert_eq!(result.status, "success");
        assert_eq!(result.gas_used, "21000");
        assert_eq!(
            result.contract_address.as_deref(),
            Some("0x0000000000000000000000000000000000000000")
        );
    }

    // ── quantity parsing + gas policy ─────────────────────────────────────

    #[test]
    fn parses_hex_and_decimal_quantities() {
        assert_eq!(parse_quantity_u128("0x1b", "value").unwrap(), 27);
        assert_eq!(parse_quantity_u128("0X1B", "value").unwrap(), 27);
        assert_eq!(parse_quantity_u128("21000", "gas limit").unwrap(), 21_000);
        assert_eq!(parse_quantity_u128(" 0x0 ", "value").unwrap(), 0);
        assert!(parse_quantity_u128("", "value").is_err());
        assert!(parse_quantity_u128("0x", "value").is_err());
        assert!(parse_quantity_u128("1.5", "value").is_err());
        assert!(parse_quantity_u128("-1", "value").is_err());
    }

    #[test]
    fn gas_margin_and_cap_refuse_runaways() {
        // 20% margin, applied before the cap.
        assert_eq!(apply_gas_margin(0).unwrap(), 0);
        assert_eq!(apply_gas_margin(100).unwrap(), 120);
        assert_eq!(apply_gas_margin(21_000).unwrap(), 25_200);
        // Over-cap estimates and caller limits are refused, never clamped.
        assert!(apply_gas_margin(9_000_000).is_err());
        assert!(apply_gas_margin(u64::MAX).is_err());
        assert_eq!(check_gas_limit(10_000_000).unwrap(), 10_000_000);
        assert!(check_gas_limit(10_000_001).is_err());
        assert!(check_gas_limit(u128::MAX).is_err());
    }

    #[test]
    fn calldata_hex_parses_and_rejects() {
        assert!(parse_calldata_hex("").unwrap().is_empty());
        assert!(parse_calldata_hex("0x").unwrap().is_empty());
        assert_eq!(
            parse_calldata_hex("0xdeadbeef").unwrap(),
            [0xde, 0xad, 0xbe, 0xef]
        );
        assert!(parse_calldata_hex("nothex").is_err());
    }

    // ── `to: Option` wire shape + contract creation ───────────────────────

    /// Mirror of the `evm_send_transaction` invoke-argument wire shape
    /// (Tauri extracts each named argument with this serde shape: camelCase
    /// keys, `to` optional/nullable). Pins the frontend contract
    /// `evm_send_transaction({ rpcUrl, chainId, to?, data, value?, gasLimit? })`.
    #[derive(Debug, serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SendTxArgsMirror {
        rpc_url: String,
        chain_id: u64,
        to: Option<String>,
        data: String,
        value: Option<String>,
        gas_limit: Option<String>,
    }

    #[test]
    fn send_transaction_args_accept_omitted_null_present_and_empty_to() {
        // Omitted `to` — contract creation.
        let args: SendTxArgsMirror = serde_json::from_value(serde_json::json!({
            "rpcUrl": "http://127.0.0.1:8545",
            "chainId": 31337,
            "data": "0x60006000f3",
        }))
        .unwrap_or_else(|e| panic!("omitted to parses: {e}"));
        assert_eq!(args.rpc_url, "http://127.0.0.1:8545");
        assert_eq!(args.chain_id, 31_337);
        assert_eq!(args.data, "0x60006000f3");
        assert_eq!(args.to, None);
        assert_eq!(args.value, None);
        assert_eq!(args.gas_limit, None);
        assert_eq!(parse_optional_to(args.to.as_deref()).unwrap(), None);

        // Explicit `null` — contract creation.
        let args: SendTxArgsMirror = serde_json::from_value(serde_json::json!({
            "rpcUrl": "http://127.0.0.1:8545",
            "chainId": 31337,
            "to": serde_json::Value::Null,
            "data": "0x60006000f3",
            "value": "0x0",
            "gasLimit": "1000000",
        }))
        .unwrap_or_else(|e| panic!("null to parses: {e}"));
        assert_eq!(args.to, None);
        assert_eq!(args.value.as_deref(), Some("0x0"));
        assert_eq!(args.gas_limit.as_deref(), Some("1000000"));
        assert_eq!(parse_optional_to(args.to.as_deref()).unwrap(), None);

        // Empty string — contract creation per the wire contract.
        let args: SendTxArgsMirror = serde_json::from_value(serde_json::json!({
            "rpcUrl": "http://127.0.0.1:8545",
            "chainId": 31337,
            "to": "",
            "data": "0xdeadbeef",
        }))
        .unwrap_or_else(|e| panic!("empty to parses: {e}"));
        assert_eq!(parse_optional_to(args.to.as_deref()).unwrap(), None);

        // Present `to` — regular call.
        let args: SendTxArgsMirror = serde_json::from_value(serde_json::json!({
            "rpcUrl": "http://127.0.0.1:8545",
            "chainId": 31337,
            "to": ADDR_07,
            "data": "0xdeadbeef",
        }))
        .unwrap_or_else(|e| panic!("present to parses: {e}"));
        assert_eq!(
            parse_optional_to(args.to.as_deref()).unwrap(),
            Some(buzz_evm_allowance_pkg::abi::parse_address(ADDR_07).unwrap())
        );
    }

    #[test]
    fn optional_to_rejects_malformed_addresses() {
        assert!(parse_optional_to(Some("0x1234")).is_err());
        assert!(parse_optional_to(Some("nothex")).is_err());
    }

    #[test]
    fn find_bid_ids_result_matches_the_frontend_contract() {
        let result = serde_json::to_value(EvmFindBidIdsResult {
            bid_ids: vec!["5".to_string(), "9".to_string()],
        })
        .unwrap_or_else(|e| panic!("serializes: {e}"));
        assert_eq!(result["bidIds"], serde_json::json!(["5", "9"]));
        assert_eq!(result.as_object().map(|o| o.len()), Some(1));
    }

    #[test]
    fn send_result_wire_shape_carries_the_created_contract_address() {
        // The contract-creation reply: `contractAddress` is the created
        // address string (`string | null` on the wire).
        let send = serde_json::to_value(EvmSendResult {
            tx_hash: "0xabc".to_string(),
            status: "success".to_string(),
            block_number: 3,
            gas_used: "50000".to_string(),
            contract_address: Some("0x00000000000000000000000000000000000000c0".to_string()),
        })
        .unwrap_or_else(|e| panic!("serializes: {e}"));
        assert_eq!(
            send["contractAddress"],
            "0x00000000000000000000000000000000000000c0"
        );
        assert_eq!(send["status"], "success");
        assert_eq!(send.as_object().map(|o| o.len()), Some(5));
    }
}
