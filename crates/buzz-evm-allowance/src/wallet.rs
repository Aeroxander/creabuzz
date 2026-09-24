//! General-purpose EVM wallet: local secp256k1 keys, EIP-1559 (type-2)
//! transaction signing, and bounded broadcast/receipt RPC helpers.
//!
//! Built for the desktop app's in-app signing flows (token deploys, auction
//! bids, ragequit exits, arbitrary contract calls) on the same hand-rolled
//! stack as the allowance guard: RLP and keccak reuse [`crate::tx`] /
//! [`crate::abi`] primitives (nothing is duplicated), signing is `k256`,
//! transport is [`crate::rpc::EvmRpc`]. No alloy/ethers — deliberate, like
//! `buzz-evm-auth` and the launchpad composer.
//!
//! # Key handling
//!
//! [`Wallet`] owns the private key. It implements [`std::fmt::Debug`] with
//! the key material **redacted** and deliberately does not implement
//! [`std::fmt::Display`], so key bytes cannot leak through `{}`/`{:?}`
//! formatting or logging. Nothing in this module logs key material.
//! [`Wallet::to_private_key_hex`] is the single, explicit export seam for
//! persistence callers (e.g. the desktop keyring) — its result is secret
//! material and must never be logged.
//!
//! # Transaction scope
//!
//! Type-2 (EIP-1559) transactions only: `0x02 || rlp([...])` per EIP-2718,
//! with an always-empty access list (EIP-1559 permits an empty list;
//! access lists are intentionally unsupported). `to: None` is contract
//! creation. Legacy transactions keep using [`crate::tx::sign_legacy_tx`].
//!
//! # Bounded resources
//!
//! Every RPC round-trip carries an explicit timeout, the receipt wait has
//! a hard deadline that is the terminal state, and fee estimation performs
//! a fixed number of calls — no retry loops anywhere. Log scanning
//! ([`WalletClient::get_logs`], [`WalletClient::find_bid_ids`]) is bounded
//! by a per-request block-range cap, a per-response result count cap, and
//! a scan deadline (the terminal state) — documented on those methods.

use std::fmt;
use std::sync::Arc;
use std::time::{Duration, Instant};

use k256::ecdsa::SigningKey;
use serde_json::{json, Value};

use crate::abi::keccak256;
use crate::client::{
    parse_hex_quantity, DEFAULT_RECEIPT_DEADLINE, DEFAULT_RPC_TIMEOUT, RECEIPT_POLL_INTERVAL,
};
use crate::error::WalletError;
use crate::rpc::EvmRpc;
use crate::tx::{self, minimal_be, rlp_bytes, rlp_list, rlp_scalar, SignedTx};

/// Key-generation draws before giving up. A valid secp256k1 scalar is
/// rejected with probability ~2^-128 per draw, so this bound can only fire
/// on a broken CSPRNG — but it stays bounded (AGENTS.md rule 4).
const KEYGEN_DRAWS: u8 = 8;

/// Canonical signature of the vendored continuous-clearing-auction
/// bid-submitted event — `event BidSubmitted(uint256 indexed id, address
/// indexed owner, uint256 priceQ96, uint128 amount)`, declared at
/// `contracts/lib/continuous-clearing-auction/src/interfaces/IContinuousClearingAuction.sol:103`
/// and emitted at
/// `contracts/lib/continuous-clearing-auction/src/ContinuousClearingAuction.sol:391`.
/// The indexed parameters become log topics in declaration order:
/// `topics[0]` is [`bid_submitted_topic`], `topics[1]` the bid id,
/// `topics[2]` the owner.
pub const BID_SUBMITTED_SIGNATURE: &str = "BidSubmitted(uint256,address,uint256,uint128)";

/// `topics[0]` of a [`BID_SUBMITTED_SIGNATURE`] log, computed at runtime
/// with [`crate::abi::keccak256`]; the unit tests pin it against
/// `cast keccak` output (foundry 1.4.3).
pub fn bid_submitted_topic() -> [u8; 32] {
    keccak256(BID_SUBMITTED_SIGNATURE.as_bytes())
}

/// `startBlock()` — the auction's first active block (CCA view).
const START_BLOCK_SIGNATURE: &str = "startBlock()";

/// `endBlock()` — the auction's exclusive end block (CCA view).
const END_BLOCK_SIGNATURE: &str = "endBlock()";

/// Maximum block span one [`WalletClient::get_logs`] request may cover —
/// a provider-safe `eth_getLogs` chunk size. Wider windows must be chunked;
/// [`WalletClient::find_bid_ids`] does so internally.
pub const LOG_BLOCK_RANGE_CAP: u64 = 10_000;

/// Maximum matching logs one `eth_getLogs` response may carry. A larger
/// response is refused, never truncated — narrow the block range or topics.
pub const LOG_RESULT_CAP: usize = 1_000;

/// Maximum total block span one [`WalletClient::find_bid_ids`] scan may
/// cover across all chunks (200 × [`LOG_BLOCK_RANGE_CAP`] — roughly a
/// 46-day auction at 2s blocks, far longer than the CCA flow needs).
pub const LOG_SCAN_BLOCK_CAP: u64 = 2_000_000;

/// Default wall-clock ceiling for one [`WalletClient::find_bid_ids`] scan.
/// The deadline is the terminal state ([`WalletError::Timeout`]); partially
/// scanned windows are an error, never an authoritative partial answer.
pub const DEFAULT_LOG_SCAN_DEADLINE: Duration = Duration::from_secs(60);

/// A locally-held secp256k1 key with its derived EVM address.
///
/// See the module docs for the redaction contract: `Debug` prints the
/// address and `<redacted>`, never the key; `Display` is not implemented.
pub struct Wallet {
    key: SigningKey,
    address: [u8; 20],
}

impl Wallet {
    /// Generate a fresh random key from the OS CSPRNG.
    pub fn generate() -> Result<Self, WalletError> {
        for _ in 0..KEYGEN_DRAWS {
            let bytes: [u8; 32] = rand::random();
            if let Ok(key) = SigningKey::from_slice(&bytes) {
                return Ok(Self::from_key(key));
            }
        }
        Err(WalletError::KeyGeneration(format!(
            "no valid secp256k1 scalar in {KEYGEN_DRAWS} CSPRNG draws"
        )))
    }

    /// Import a key from 32-byte hex (`0x` prefix optional).
    pub fn from_private_key_hex(hex_key: &str) -> Result<Self, WalletError> {
        let clean = hex_key.trim().trim_start_matches("0x");
        let bytes = hex::decode(clean)
            .map_err(|e| WalletError::InvalidInput(format!("bad private key hex: {e}")))?;
        let key = SigningKey::from_slice(&bytes)
            .map_err(|e| WalletError::InvalidInput(format!("bad private key: {e}")))?;
        Ok(Self::from_key(key))
    }

    fn from_key(key: SigningKey) -> Self {
        let address = tx::address_from_key(&key);
        Self { key, address }
    }

    /// The 20-byte EVM address:
    /// `keccak256(uncompressed_pubkey[1..65])[12..32]`.
    pub fn address(&self) -> [u8; 20] {
        self.address
    }

    /// The address as `0x`-prefixed lowercase hex.
    pub fn address_hex(&self) -> String {
        format!("0x{}", hex::encode(self.address))
    }

    /// Export the raw private key as bare lowercase hex (no `0x` prefix) —
    /// the exact form [`Self::from_private_key_hex`] accepts back.
    ///
    /// This is the **only** path key material leaves a [`Wallet`]; it exists
    /// for persistence seams (the desktop app's keyring). The result is
    /// secret material: never log it, never put it in an error message.
    pub fn to_private_key_hex(&self) -> String {
        hex::encode(self.key.to_bytes())
    }

    /// Sign an EIP-1559 (type-2) transaction.
    ///
    /// All fields are already resolved by the caller (nonce, fees, gas
    /// limit); this is pure local signing — no RPC, no retries. The signing
    /// digest is `keccak256(0x02 || rlp([chainId, nonce,
    /// maxPriorityFeePerGas, maxFeePerGas, gasLimit, to, value, data,
    /// accessList]))` and `y_parity` in the result is `0`/`1` (typed
    /// transactions do not use EIP-155 `v`).
    pub fn sign_eip1559_tx(&self, tx: &Eip1559TxFields<'_>) -> Result<SignedTx, WalletError> {
        let prehash = keccak256(&signing_payload(tx));
        let (signature, recid) = self
            .key
            .sign_prehash_recoverable(prehash.as_slice())
            .map_err(|e| WalletError::Signing(format!("{e}")))?;
        let sig_bytes = signature.to_bytes();
        let mut sig = [0u8; 64];
        sig.copy_from_slice(&sig_bytes);
        let y_parity = u8::from(recid.is_y_odd());
        let raw = signed_payload(tx, y_parity, &sig);
        let tx_hash = keccak256(&raw);
        Ok(SignedTx {
            raw,
            tx_hash,
            signature: sig,
            parity: y_parity,
        })
    }
}

impl fmt::Debug for Wallet {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Wallet")
            .field("address", &format_args!("0x{}", hex::encode(self.address)))
            .field("key", &"<redacted>")
            .finish()
    }
}

/// Caller-resolved fields of an EIP-1559 (type-2) transaction, in wire
/// order (which is **not** the order the fee names suggest: the tip
/// precedes the fee cap on the wire, per EIP-1559).
#[derive(Debug, Clone, Copy)]
pub struct Eip1559TxFields<'a> {
    /// EIP-155 replay-protection chain id.
    pub chain_id: u64,
    /// Account nonce.
    pub nonce: u64,
    /// Miner tip cap per gas (wire position 3).
    pub max_priority_fee_per_gas: u128,
    /// Total per-gas fee cap (wire position 4).
    pub max_fee_per_gas: u128,
    /// Gas limit.
    pub gas_limit: u64,
    /// Recipient; `None` is contract creation (encodes as the empty byte
    /// string).
    pub to: Option<[u8; 20]>,
    /// Value in wei.
    pub value: u128,
    /// Calldata (init code for contract creation).
    pub data: &'a [u8],
}

/// The nine unsigned type-2 fields as concatenated RLP items.
fn field_items(tx: &Eip1559TxFields<'_>) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&rlp_bytes(&minimal_be(tx.chain_id as u128)));
    payload.extend_from_slice(&rlp_bytes(&minimal_be(tx.nonce as u128)));
    payload.extend_from_slice(&rlp_bytes(&minimal_be(tx.max_priority_fee_per_gas)));
    payload.extend_from_slice(&rlp_bytes(&minimal_be(tx.max_fee_per_gas)));
    payload.extend_from_slice(&rlp_bytes(&minimal_be(tx.gas_limit as u128)));
    match &tx.to {
        Some(addr) => payload.extend_from_slice(&rlp_bytes(addr)),
        // Contract creation: the empty byte string (RLP 0x80).
        None => payload.extend_from_slice(&rlp_bytes(&[])),
    }
    payload.extend_from_slice(&rlp_bytes(&minimal_be(tx.value)));
    payload.extend_from_slice(&rlp_bytes(tx.data));
    // accessList — always the empty list (RLP 0xc0).
    payload.extend_from_slice(&rlp_list(&[]));
    payload
}

/// The EIP-2718 signing payload:
/// `0x02 || rlp([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas,
/// gasLimit, to, value, data, accessList])`.
fn signing_payload(tx: &Eip1559TxFields<'_>) -> Vec<u8> {
    let payload = field_items(tx);
    let mut out = Vec::with_capacity(payload.len() + 3);
    out.push(0x02);
    out.extend_from_slice(&rlp_list(&payload));
    out
}

/// The signed type-2 envelope:
/// `0x02 || rlp([...unsigned fields..., yParity, r, s])`, with `r`/`s` as
/// minimally-encoded scalars (leading zeros stripped — see
/// [`rlp_scalar`]).
fn signed_payload(tx: &Eip1559TxFields<'_>, y_parity: u8, sig: &[u8; 64]) -> Vec<u8> {
    let mut payload = field_items(tx);
    payload.extend_from_slice(&rlp_bytes(&minimal_be(u128::from(y_parity))));
    payload.extend_from_slice(&rlp_scalar(&sig[..32]));
    payload.extend_from_slice(&rlp_scalar(&sig[32..]));
    let mut out = Vec::with_capacity(payload.len() + 3);
    out.push(0x02);
    out.extend_from_slice(&rlp_list(&payload));
    out
}

/// A mined, successful transaction's receipt — the subset the app needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TxReceipt {
    /// Transaction hash, `0x`-prefixed lowercase.
    pub tx_hash: String,
    /// Created contract address (contract-creation transactions only).
    pub contract_address: Option<[u8; 20]>,
    /// Block the transaction mined in.
    pub block_number: u64,
    /// Gas the transaction consumed.
    pub gas_used: u128,
}

/// Suggested EIP-1559 fee caps for one transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FeeSuggestion {
    /// Suggested `maxFeePerGas`.
    pub max_fee_per_gas: u128,
    /// Suggested `maxPriorityFeePerGas`.
    pub max_priority_fee_per_gas: u128,
}

/// A mined receipt with its onchain status — success **or** revert, as data.
///
/// [`WalletClient::wait_for_receipt`] folds the status into its error type
/// (a revert is [`WalletError::TxReverted`]); this type exists for callers
/// that need the reverted receipt's block/gas/address fields too.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MinedReceipt {
    /// `true` for receipt status `0x1`, `false` for `0x0`.
    pub success: bool,
    /// The receipt's identifying fields (valid for either status).
    pub receipt: TxReceipt,
}

/// Filter for one bounded [`WalletClient::get_logs`] request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogFilter {
    /// Only logs emitted by this contract.
    pub address: [u8; 20],
    /// Positional topic filter: `Some(word)` matches that topic exactly,
    /// `None` matches any topic at that position. Trailing wildcards may be
    /// omitted from the list.
    pub topics: Vec<Option<[u8; 32]>>,
    /// First block to scan (inclusive).
    pub from_block: u64,
    /// Last block to scan (inclusive).
    pub to_block: u64,
}

/// One `eth_getLogs` entry — the identifying subset of a mined log. Node
/// fields are parsed fail-loud: a malformed entry is an error, never a
/// guess ([`WalletError::MalformedResponse`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogEntry {
    /// The contract that emitted the log.
    pub address: [u8; 20],
    /// Emitted topics; `topics[0]` is the event-signature hash.
    pub topics: Vec<[u8; 32]>,
    /// Unindexed event data.
    pub data: Vec<u8>,
    /// Block the log was mined in.
    pub block_number: u64,
    /// Index of the log within its block.
    pub log_index: u64,
}

/// Bounded JSON-RPC helpers for the wallet: broadcast with the signed-hash
/// acknowledgment check (mirroring `AllowanceClient`), deadline-bounded
/// receipt polling, the nonce/fee lookups needed to resolve
/// [`Eip1559TxFields`], and bounded log scanning ([`Self::get_logs`],
/// [`Self::find_bid_ids`]).
pub struct WalletClient {
    rpc: Arc<dyn EvmRpc>,
    rpc_timeout: Duration,
    receipt_deadline: Duration,
    log_scan_deadline: Duration,
}

impl WalletClient {
    /// Build a client for the node at `rpc_url`.
    pub fn new(rpc_url: &str) -> Result<Self, WalletError> {
        let rpc: Arc<dyn EvmRpc> = Arc::new(crate::rpc::HttpEvmRpc::new(rpc_url)?);
        Ok(Self::from_transport(rpc))
    }

    /// Build a client over an injected transport (tests).
    pub fn from_transport(rpc: Arc<dyn EvmRpc>) -> Self {
        Self {
            rpc,
            rpc_timeout: DEFAULT_RPC_TIMEOUT,
            receipt_deadline: DEFAULT_RECEIPT_DEADLINE,
            log_scan_deadline: DEFAULT_LOG_SCAN_DEADLINE,
        }
    }

    /// Override the per-RPC-call ceiling.
    pub fn with_rpc_timeout(mut self, timeout: Duration) -> Self {
        self.rpc_timeout = timeout;
        self
    }

    /// Override the receipt-wait deadline.
    pub fn with_receipt_deadline(mut self, deadline: Duration) -> Self {
        self.receipt_deadline = deadline;
        self
    }

    /// Override the [`Self::find_bid_ids`] scan deadline.
    pub fn with_log_scan_deadline(mut self, deadline: Duration) -> Self {
        self.log_scan_deadline = deadline;
        self
    }

    /// `eth_chainId`.
    pub async fn chain_id(&self) -> Result<u64, WalletError> {
        Ok(self.scalar_rpc("eth_chainId", json!([])).await? as u64)
    }

    /// `eth_gasPrice` (for legacy transactions and fee fallbacks).
    pub async fn gas_price(&self) -> Result<u128, WalletError> {
        self.scalar_rpc("eth_gasPrice", json!([])).await
    }

    /// `eth_getTransactionCount` at `pending` — the next usable nonce;
    /// `pending` makes concurrent sends from one key queue rather than
    /// collide.
    pub async fn get_transaction_count(&self, address: &[u8; 20]) -> Result<u64, WalletError> {
        let from_hex = format!("0x{}", hex::encode(address));
        let count = self
            .scalar_rpc("eth_getTransactionCount", json!([from_hex, "pending"]))
            .await?;
        Ok(count as u64)
    }

    /// Suggest EIP-1559 fee caps from the latest block's base fee and the
    /// node's priority-fee suggestion.
    ///
    /// `maxFeePerGas = 2 * baseFeePerGas + tip`: the base fee moves at most
    /// +12.5% per block, so 2x covers several blocks of headroom. The tip
    /// comes from `eth_maxPriorityFeePerGas`; a node without it errors
    /// loudly (fees are caller-supplied to [`Wallet::sign_eip1559_tx`], so
    /// the caller can always choose its own). Fixed call count — no loops.
    pub async fn suggest_eip1559_fees(&self) -> Result<FeeSuggestion, WalletError> {
        let block = self
            .rpc
            .call(
                "eth_getBlockByNumber",
                json!(["latest", false]),
                self.rpc_timeout,
            )
            .await?;
        let base = block.get("baseFeePerGas").ok_or_else(|| {
            WalletError::MalformedResponse(
                "latest block has no baseFeePerGas (pre-London chain?)".into(),
            )
        })?;
        let base_fee = parse_hex_quantity(base).map_err(WalletError::MalformedResponse)?;
        let tip = self
            .scalar_rpc("eth_maxPriorityFeePerGas", json!([]))
            .await?;
        Ok(FeeSuggestion {
            max_fee_per_gas: base_fee.saturating_mul(2).saturating_add(tip),
            max_priority_fee_per_gas: tip,
        })
    }

    /// Bounded `eth_call` — a read-only contract call to `to` with `data`.
    ///
    /// `to` is a `0x`-or-bare 20-byte hex address; `data` is `0x`-or-bare
    /// hex calldata (the empty string is empty calldata). Returns the node's
    /// raw `0x` return data verbatim. One round-trip, bounded by the
    /// configured RPC timeout — no retries.
    pub async fn call(&self, to: &str, data: &str) -> Result<String, WalletError> {
        let to = crate::abi::parse_address(to)?;
        let data = parse_data_hex(data)?;
        let params = json!([
            {
                "to": format!("0x{}", hex::encode(to)),
                "data": format!("0x{}", hex::encode(&data)),
            },
            "latest"
        ]);
        let v = self.rpc.call("eth_call", params, self.rpc_timeout).await?;
        match v.as_str() {
            Some(return_data) => Ok(return_data.to_string()),
            None => Err(WalletError::MalformedResponse(format!(
                "eth_call returned non-string result: {v}"
            ))),
        }
    }

    /// Bounded `eth_estimateGas` for one prospective transaction.
    ///
    /// Address/data parsing matches [`Self::call`]; `value` is in wei. The
    /// estimate is the node's raw answer — callers apply their own margin
    /// and cap policy on top. One round-trip, no retries; a simulation
    /// revert surfaces as [`WalletError::Rpc`] with the node's detail
    /// ("execution reverted", …) — nothing is hidden.
    pub async fn estimate_gas(
        &self,
        from: &str,
        to: &str,
        value: u128,
        data: &str,
    ) -> Result<u64, WalletError> {
        let to = crate::abi::parse_address(to)?;
        self.estimate_gas_inner(from, Some(to), value, data).await
    }

    /// Bounded `eth_estimateGas` for a **contract-creation** transaction —
    /// the `to` field is omitted and `data` is the init code (the same
    /// shape [`Wallet::sign_eip1559_tx`] takes with `to: None`).
    ///
    /// Otherwise identical to [`Self::estimate_gas`]: one round-trip, no
    /// retries; the estimate is raw and the caller applies margin/caps.
    pub async fn estimate_creation_gas(
        &self,
        from: &str,
        value: u128,
        data: &str,
    ) -> Result<u64, WalletError> {
        self.estimate_gas_inner(from, None, value, data).await
    }

    /// Shared request shape for [`Self::estimate_gas`] (with `to`) and
    /// [`Self::estimate_creation_gas`] (without).
    async fn estimate_gas_inner(
        &self,
        from: &str,
        to: Option<[u8; 20]>,
        value: u128,
        data: &str,
    ) -> Result<u64, WalletError> {
        let from = crate::abi::parse_address(from)?;
        let data = parse_data_hex(data)?;
        let mut tx = serde_json::Map::new();
        tx.insert("from".into(), json!(format!("0x{}", hex::encode(from))));
        if let Some(to) = to {
            tx.insert("to".into(), json!(format!("0x{}", hex::encode(to))));
        }
        tx.insert("value".into(), json!(format!("0x{value:x}")));
        tx.insert("data".into(), json!(format!("0x{}", hex::encode(&data))));
        let params = json!([serde_json::Value::Object(tx)]);
        let gas = self.scalar_rpc("eth_estimateGas", params).await?;
        u64::try_from(gas).map_err(|_| {
            WalletError::MalformedResponse(format!("gas estimate {gas} does not fit in u64"))
        })
    }

    /// One bounded `eth_getLogs` request over `filter`.
    ///
    /// Bounds (each is terminal — nothing is silently truncated):
    ///
    /// - **Block range**: `from_block..=to_block` may span at most
    ///   [`LOG_BLOCK_RANGE_CAP`] blocks; wider requests are refused with
    ///   [`WalletError::InvalidInput`] before any RPC. Chunk larger windows
    ///   the way [`Self::find_bid_ids`] does.
    /// - **Result count**: more than [`LOG_RESULT_CAP`] matching logs is
    ///   refused with [`WalletError::Rpc`] on `eth_getLogs` — narrow the
    ///   range or topics rather than losing logs to truncation.
    /// - **Timeout**: one round-trip bounded by the configured RPC timeout.
    ///
    /// Matching (address + positional topics) is node-side; entries are
    /// parsed fail-loud ([`WalletError::MalformedResponse`] on malformed
    /// node data). Results are as of the node's chain head at call time.
    pub async fn get_logs(&self, filter: &LogFilter) -> Result<Vec<LogEntry>, WalletError> {
        if filter.from_block > filter.to_block {
            return Err(WalletError::InvalidInput(format!(
                "log range from_block {} exceeds to_block {}",
                filter.from_block, filter.to_block
            )));
        }
        let span = u128::from(filter.to_block) - u128::from(filter.from_block) + 1;
        if span > u128::from(LOG_BLOCK_RANGE_CAP) {
            return Err(WalletError::InvalidInput(format!(
                "log range spans {span} blocks, exceeding the {LOG_BLOCK_RANGE_CAP}-block request cap"
            )));
        }
        let topics: Vec<serde_json::Value> = filter
            .topics
            .iter()
            .map(|t| match t {
                Some(word) => Value::String(format!("0x{}", hex::encode(word))),
                None => Value::Null,
            })
            .collect();
        let params = json!([{
            "address": format!("0x{}", hex::encode(filter.address)),
            "topics": topics,
            "fromBlock": format!("0x{:x}", filter.from_block),
            "toBlock": format!("0x{:x}", filter.to_block),
        }]);
        let v = self
            .rpc
            .call("eth_getLogs", params, self.rpc_timeout)
            .await?;
        let entries = v.as_array().ok_or_else(|| {
            WalletError::MalformedResponse(format!("eth_getLogs returned non-array result: {v}"))
        })?;
        if entries.len() > LOG_RESULT_CAP {
            return Err(WalletError::Rpc {
                method: "eth_getLogs",
                detail: format!(
                    "{} logs exceed the {LOG_RESULT_CAP}-result response cap; narrow the block range or topics",
                    entries.len()
                ),
            });
        }
        entries.iter().map(parse_log_entry).collect()
    }

    /// Enumerate the bid ids `owner` holds on the continuous-clearing-
    /// auction at `auction`, ascending.
    ///
    /// Discovery is by the `BidSubmitted` logs ([`BID_SUBMITTED_SIGNATURE`]):
    /// `topics[1]` is the bid id, `topics[2]` the owner. Logs are the only
    /// complete enumeration path — the auction exposes no owner-indexed bid
    /// list (`IBidStorage` offers just `nextBidId()` and `bids(id)`, and
    /// `bids` cannot be enumerated), while bid ids are a per-auction
    /// monotonic counter (`BidStorage.sol:47-49`), so the owner's log set is
    /// complete and sortable. Ids are returned as counters (u128; a wider
    /// id is [`WalletError::MalformedResponse`], never truncated).
    ///
    /// The scan window is the auction's active window — `startBlock()` to
    /// `endBlock() - 1` — since `submitBid` reverts outside it
    /// (`ContinuousClearingAuction.sol:106` reverts before the start,
    /// `:471-472` reverts at/after the end). Those two view reads are
    /// **best-effort scan narrowing**: if either is unreadable (a non-CCA
    /// or mock contract, reverts, undecodable return data) the scan falls
    /// back to the full `[0, latest]` history — a superset, so results stay
    /// complete — rather than failing or silently narrowing. Everything
    /// else propagates fail-loud.
    ///
    /// Bounds: each chunk is capped at [`LOG_BLOCK_RANGE_CAP`] blocks and
    /// [`LOG_RESULT_CAP`] results with the configured RPC timeout; the
    /// total window is capped at [`LOG_SCAN_BLOCK_CAP`] blocks
    /// ([`WalletError::Rpc`] on `eth_getLogs` beyond it); the wall clock is
    /// capped by the scan deadline (default
    /// [`DEFAULT_LOG_SCAN_DEADLINE`]), whose expiry is the terminal state
    /// ([`WalletError::Timeout`]) — a partially scanned window is an error,
    /// never an authoritative partial answer. Results are as of the node's
    /// chain head at call time; bids mined later are not included.
    pub async fn find_bid_ids(&self, auction: &str, owner: &str) -> Result<Vec<u128>, WalletError> {
        let auction = crate::abi::parse_address(auction)?;
        let owner = crate::abi::parse_address(owner)?;
        let topic0 = bid_submitted_topic();
        let owner_topic = crate::abi::encode_address_word(&owner);

        let window = self.auction_bid_window(&auction).await;
        let latest = self.latest_block().await?;
        let (from_block, to_block) = match window {
            // An empty/inverted window can hold no logs — authoritative.
            Some((start, end)) if start >= end => return Ok(Vec::new()),
            Some((start, end)) => (start, (end - 1).min(latest)),
            // No auction views readable: scan the full bounded history.
            None => (0, latest),
        };
        if from_block > to_block {
            return Ok(Vec::new());
        }
        let span = u128::from(to_block) - u128::from(from_block) + 1;
        if span > u128::from(LOG_SCAN_BLOCK_CAP) {
            return Err(WalletError::Rpc {
                method: "eth_getLogs",
                detail: format!(
                    "bid scan spans {span} blocks, exceeding the {LOG_SCAN_BLOCK_CAP}-block scan cap"
                ),
            });
        }

        let deadline = Instant::now() + self.log_scan_deadline;
        let mut ids = Vec::new();
        let mut from = from_block;
        loop {
            if Instant::now() >= deadline {
                return Err(WalletError::Timeout {
                    method: "eth_getLogs",
                    timeout_ms: self.log_scan_deadline.as_millis() as u64,
                });
            }
            let to = from.saturating_add(LOG_BLOCK_RANGE_CAP - 1).min(to_block);
            let entries = self
                .get_logs(&LogFilter {
                    address: auction,
                    topics: vec![Some(topic0), None, Some(owner_topic)],
                    from_block: from,
                    to_block: to,
                })
                .await?;
            for entry in &entries {
                ids.push(bid_id_from_log(entry)?);
            }
            if to >= to_block {
                break;
            }
            from = to + 1;
        }
        ids.sort_unstable();
        Ok(ids)
    }

    /// Best-effort read of the auction's active window `[startBlock(),
    /// endBlock())` — the window that provably contains every
    /// `BidSubmitted` log. `None` when either view is unreadable (see
    /// [`Self::find_bid_ids`] for the fallback semantics).
    async fn auction_bid_window(&self, auction: &[u8; 20]) -> Option<(u64, u64)> {
        let start = self
            .auction_view_u64(auction, START_BLOCK_SIGNATURE)
            .await?;
        let end = self.auction_view_u64(auction, END_BLOCK_SIGNATURE).await?;
        Some((start, end))
    }

    /// One best-effort `eth_call` to `auction` with a 4-byte selector,
    /// decoded as a u64-sized word. `None` on any RPC or decode failure —
    /// these reads only narrow the scan, never decide correctness.
    async fn auction_view_u64(&self, auction: &[u8; 20], signature: &str) -> Option<u64> {
        let params = json!([
            {
                "to": format!("0x{}", hex::encode(auction)),
                "data": format!("0x{}", hex::encode(crate::abi::selector(signature))),
            },
            "latest",
        ]);
        let v = self
            .rpc
            .call("eth_call", params, self.rpc_timeout)
            .await
            .ok()?;
        let hex_str = v.as_str()?;
        let clean = hex_str.trim().trim_start_matches("0x");
        let bytes = hex::decode(clean).ok()?;
        let word: [u8; 32] = bytes.as_slice().try_into().ok()?;
        let value = crate::abi::decode_uint256(&word).ok()?;
        u64::try_from(value).ok()
    }

    /// `eth_blockNumber` — the node's current chain-head height.
    async fn latest_block(&self) -> Result<u64, WalletError> {
        let v = self
            .rpc
            .call("eth_blockNumber", json!([]), self.rpc_timeout)
            .await?;
        let quantity = parse_hex_quantity(&v).map_err(|e| WalletError::Rpc {
            method: "eth_blockNumber",
            detail: e,
        })?;
        u64::try_from(quantity).map_err(|_| {
            WalletError::MalformedResponse(format!("block number {quantity} does not fit in u64"))
        })
    }

    /// One bounded `eth_getTransactionReceipt` fetch — `None` while the
    /// transaction is not yet mined.
    ///
    /// Unlike [`Self::wait_for_receipt`] this never polls and returns a
    /// **reverted** receipt as data ([`MinedReceipt::success`] `= false`)
    /// instead of an error — for callers that must report a mined revert's
    /// block/gas/address fields.
    pub async fn mined_receipt(&self, tx_hash: &str) -> Result<Option<MinedReceipt>, WalletError> {
        let v = self
            .rpc
            .call(
                "eth_getTransactionReceipt",
                json!([tx_hash]),
                self.rpc_timeout,
            )
            .await?;
        if v.is_null() {
            return Ok(None);
        }
        let status = v
            .get("status")
            .and_then(|s| s.as_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let success = match status.as_str() {
            "0x1" => true,
            "0x0" => false,
            other => {
                return Err(WalletError::MalformedResponse(format!(
                    "unexpected receipt status {other:?}"
                )))
            }
        };
        let receipt = parse_receipt(tx_hash, &v)?;
        Ok(Some(MinedReceipt { success, receipt }))
    }

    /// Broadcast a signed transaction and return its hash.
    ///
    /// The node must acknowledge exactly the transaction we signed: a
    /// different hash back means our bytes were not accepted as-is, and we
    /// refuse to report a transaction we cannot identify (same check as
    /// `AllowanceClient::send_contract_tx`).
    pub async fn send_raw_transaction(&self, signed: &SignedTx) -> Result<String, WalletError> {
        let raw_hex = format!("0x{}", hex::encode(&signed.raw));
        let hash_value = self
            .rpc
            .call("eth_sendRawTransaction", json!([raw_hex]), self.rpc_timeout)
            .await?;
        let tx_hash = hash_value
            .as_str()
            .ok_or_else(|| WalletError::Rpc {
                method: "eth_sendRawTransaction",
                detail: "non-string tx hash".into(),
            })?
            .to_ascii_lowercase();
        let expected = format!("0x{}", hex::encode(signed.tx_hash));
        if tx_hash != expected {
            return Err(WalletError::Rpc {
                method: "eth_sendRawTransaction",
                detail: format!("node returned {tx_hash}, we signed {expected}"),
            });
        }
        Ok(tx_hash)
    }

    /// Poll `eth_getTransactionReceipt` until the transaction mines or the
    /// configured deadline passes — the deadline is the terminal state
    /// ([`WalletError::TxUnconfirmed`]), never an open-ended wait. A
    /// reverted transaction is [`WalletError::TxReverted`]; a mined
    /// success is a [`TxReceipt`].
    pub async fn wait_for_receipt(&self, tx_hash: &str) -> Result<TxReceipt, WalletError> {
        let deadline = Instant::now() + self.receipt_deadline;
        loop {
            if Instant::now() >= deadline {
                return Err(WalletError::TxUnconfirmed {
                    tx_hash: tx_hash.to_string(),
                    deadline_ms: self.receipt_deadline.as_millis() as u64,
                });
            }
            tokio::time::sleep(RECEIPT_POLL_INTERVAL).await;
            let params = json!([tx_hash]);
            match self
                .rpc
                .call("eth_getTransactionReceipt", params, self.rpc_timeout)
                .await
            {
                Ok(v) if v.is_null() => continue,
                Ok(v) => {
                    let status = v
                        .get("status")
                        .and_then(|s| s.as_str())
                        .unwrap_or_default()
                        .to_ascii_lowercase();
                    return match status.as_str() {
                        "0x1" => parse_receipt(tx_hash, &v),
                        "0x0" => Err(WalletError::TxReverted {
                            tx_hash: tx_hash.to_string(),
                        }),
                        other => Err(WalletError::Rpc {
                            method: "eth_getTransactionReceipt",
                            detail: format!("unexpected receipt status {other:?}"),
                        }),
                    };
                }
                // A single failed poll is retried until the deadline; the
                // deadline itself is the terminal state.
                Err(_) => continue,
            }
        }
    }

    /// Read one hex-quantity scalar from the node.
    async fn scalar_rpc(
        &self,
        method: &'static str,
        params: serde_json::Value,
    ) -> Result<u128, WalletError> {
        let v = self.rpc.call(method, params, self.rpc_timeout).await?;
        parse_hex_quantity(&v).map_err(|e| WalletError::Rpc { method, detail: e })
    }
}

/// Parse `0x`-or-bare hex calldata. The empty string is empty calldata;
/// anything non-hex is [`WalletError::InvalidInput`].
fn parse_data_hex(data: &str) -> Result<Vec<u8>, WalletError> {
    let clean = data.trim().trim_start_matches("0x");
    if clean.is_empty() {
        return Ok(Vec::new());
    }
    hex::decode(clean).map_err(|e| WalletError::InvalidInput(format!("bad calldata hex: {e}")))
}

/// Parse one `eth_getLogs` entry fail-loud — malformed node data is
/// [`WalletError::MalformedResponse`], never a guess.
fn parse_log_entry(entry: &Value) -> Result<LogEntry, WalletError> {
    let address_hex = entry
        .get("address")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            WalletError::MalformedResponse(format!("log entry missing address field: {entry}"))
        })?;
    let address = crate::abi::parse_address(address_hex).map_err(|e| {
        WalletError::MalformedResponse(format!("bad log address {address_hex:?}: {e}"))
    })?;
    let topics_raw = entry
        .get("topics")
        .and_then(|v| v.as_array())
        .ok_or_else(|| {
            WalletError::MalformedResponse(format!("log entry missing topics field: {entry}"))
        })?;
    let mut topics = Vec::with_capacity(topics_raw.len());
    for topic in topics_raw {
        topics.push(parse_log_word(topic)?);
    }
    let data_hex = entry.get("data").and_then(|v| v.as_str()).ok_or_else(|| {
        WalletError::MalformedResponse(format!("log entry missing data field: {entry}"))
    })?;
    let clean = data_hex.trim().trim_start_matches("0x");
    let data = if clean.is_empty() {
        Vec::new()
    } else {
        hex::decode(clean)
            .map_err(|e| WalletError::MalformedResponse(format!("bad log data hex: {e}")))?
    };
    Ok(LogEntry {
        address,
        topics,
        data,
        block_number: log_quantity_u64(entry, "blockNumber")?,
        log_index: log_quantity_u64(entry, "logIndex")?,
    })
}

/// Parse one 32-byte log topic.
fn parse_log_word(value: &Value) -> Result<[u8; 32], WalletError> {
    let s = value.as_str().ok_or_else(|| {
        WalletError::MalformedResponse(format!("expected hex topic, got {value}"))
    })?;
    let clean = s.trim().trim_start_matches("0x");
    let bytes = hex::decode(clean)
        .map_err(|e| WalletError::MalformedResponse(format!("bad topic hex {s:?}: {e}")))?;
    bytes
        .as_slice()
        .try_into()
        .map_err(|_| WalletError::MalformedResponse(format!("topic must be 32 bytes: {s:?}")))
}

/// Parse one u64 hex-quantity field of a log entry.
fn log_quantity_u64(entry: &Value, field: &str) -> Result<u64, WalletError> {
    let v = entry.get(field).ok_or_else(|| {
        WalletError::MalformedResponse(format!("log entry missing {field} field: {entry}"))
    })?;
    let quantity = parse_hex_quantity(v).map_err(WalletError::MalformedResponse)?;
    u64::try_from(quantity).map_err(|_| {
        WalletError::MalformedResponse(format!("log {field} {quantity} does not fit in u64"))
    })
}

/// The bid id from a `BidSubmitted` log: `topics[1]` as a counter
/// ([`crate::abi::decode_uint256`] refuses to truncate wider values).
fn bid_id_from_log(entry: &LogEntry) -> Result<u128, WalletError> {
    let id_topic = entry.topics.get(1).ok_or_else(|| {
        WalletError::MalformedResponse("BidSubmitted log missing the id topic".into())
    })?;
    crate::abi::decode_uint256(id_topic).map_err(WalletError::from)
}

/// Parse a mined-success receipt's identifying fields. Malformed node data
/// is an error, never a guess.
fn parse_receipt(tx_hash: &str, receipt: &serde_json::Value) -> Result<TxReceipt, WalletError> {
    let contract_address = match receipt.get("contractAddress") {
        None | Some(serde_json::Value::Null) => None,
        Some(v) => {
            let s = v.as_str().ok_or_else(|| {
                WalletError::MalformedResponse(format!("bad contractAddress field: {v}"))
            })?;
            Some(crate::abi::parse_address(s).map_err(|e| {
                WalletError::MalformedResponse(format!("bad contractAddress {s:?}: {e}"))
            })?)
        }
    };
    let block_number = receipt
        .get("blockNumber")
        .ok_or_else(|| WalletError::MalformedResponse("receipt missing blockNumber".into()))?;
    let gas_used = receipt
        .get("gasUsed")
        .ok_or_else(|| WalletError::MalformedResponse("receipt missing gasUsed".into()))?;
    Ok(TxReceipt {
        tx_hash: tx_hash.to_string(),
        contract_address,
        block_number: parse_hex_quantity(block_number).map_err(WalletError::MalformedResponse)?
            as u64,
        gas_used: parse_hex_quantity(gas_used).map_err(WalletError::MalformedResponse)?,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
    use serde_json::Value;

    use super::*;
    use crate::error::AllowanceError;

    // Fixed test key `0x07…07` (same convention as `tx`'s unit tests).
    const KEY_07_HEX: &str = "0x0707070707070707070707070707070707070707070707070707070707070707";
    /// Scalar 58 — its EIP-1559 signature below has a zero top byte in `s`.
    const KEY_3A_HEX: &str = "0x000000000000000000000000000000000000000000000000000000000000003a";
    /// Scalar 1 — the widely published "address one" test vector.
    const KEY_01_HEX: &str = "0x0000000000000000000000000000000000000000000000000000000000000001";

    /// `cast wallet address --private-key 0x07…07` (foundry 1.4.3).
    const ADDR_07: &str = "0x4a62316623ad457f02cdc5d997ded67a383ec569";
    /// `cast wallet address --private-key 0x…01` (foundry 1.4.3) — matches
    /// the widely published address of secp256k1 key 1.
    const ADDR_01: &str = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";

    const TO: [u8; 20] = [
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x42,
    ];
    /// [`TO`] as the `0x`-prefixed hex string the RPC helpers accept.
    const TO_HEX: &str = "0x0000000000000000000000000000000000000042";

    fn minimal_fields() -> Eip1559TxFields<'static> {
        Eip1559TxFields {
            chain_id: 1,
            nonce: 0,
            max_priority_fee_per_gas: 0,
            max_fee_per_gas: 0,
            gas_limit: 0,
            to: None,
            value: 0,
            data: &[],
        }
    }

    fn creation_fields() -> Eip1559TxFields<'static> {
        Eip1559TxFields {
            chain_id: 1,
            nonce: 0,
            max_priority_fee_per_gas: 0,
            max_fee_per_gas: 0,
            gas_limit: 0,
            to: None,
            value: 0,
            data: &[0xde, 0xad, 0xbe, 0xef],
        }
    }

    fn rich_fields() -> Eip1559TxFields<'static> {
        Eip1559TxFields {
            chain_id: 1,
            nonce: 9,
            max_priority_fee_per_gas: 1,
            max_fee_per_gas: 2,
            gas_limit: 21_000,
            to: Some(TO),
            value: 100,
            data: &[0xde, 0xad, 0xbe, 0xef],
        }
    }

    // --- golden encoding vectors ------------------------------------------
    //
    // Independently derived with `cast mktx` (foundry 1.4.3) — the same
    // pinning convention as the `cast sig` selector tests in `abi`. RFC
    // 6979 signatures are deterministic, so the signed vectors compare
    // byte-exactly: they pin the RLP structure, the type-2 signing digest,
    // the signature encoding, and the envelope end to end. The minimal
    // vector is additionally derived by hand in its test.

    /// `cast mktx --raw-unsigned --chain 1 --nonce 9 --gas-limit 21000
    /// --gas-price 2 --priority-gas-price 1 --value 100
    /// 0x0000000000000000000000000000000000000042 0xdeadbeef`
    const RICH_UNSIGNED: &str =
        "02e3010901028252089400000000000000000000000000000000000000426484deadbeefc0";

    /// The same command with `--private-key 0x07…07` (signed).
    const RICH_SIGNED_07: &str = "02f866010901028252089400000000000000000000000000000000000000426484deadbeefc001a003c270561cc5dd8a95fe17f81a2689b2c9df53b06e160e1cb13ea65232f2b4e0a04729bea68e676d883b6182446311d4dea31a43520707d5fb7ce5cb0b51691485";

    /// The same fields with `--private-key 0x…003a` (scalar 58): the `s`
    /// scalar starts with 0x00, so canonical RLP encodes it as a 31-byte
    /// string (0x9f prefix) instead of 0xa0 + 32 bytes. This vector fails
    /// if `r`/`s` are ever encoded as fixed-width strings.
    const RICH_SIGNED_3A: &str = "02f865010901028252089400000000000000000000000000000000000000426484deadbeefc080a0929db8c49090921c93afc459672ed26b8b6d62caa687ba68e73b1452ecd658c09f0898a3e6e78db02acda9db6daa53d64ba37f77cae0bd90735baf0344b4f50e";

    /// `cast mktx --raw-unsigned --chain 1 --nonce 0 --gas-limit 0
    /// --gas-price 0 --priority-gas-price 0 --value 0 --create 0xdeadbeef`
    /// — contract creation (`to` empty) with calldata.
    const CREATION_UNSIGNED: &str = "02cd0180808080808084deadbeefc0";

    #[test]
    fn type2_minimal_signing_payload_matches_hand_derived_bytes() {
        // The all-minimal type-2 signing payload, derived by hand from
        // EIP-1559 + the RLP spec (and cross-checked with `cast mktx
        // --raw-unsigned … --create 0x`, foundry 1.4.3, which prints the
        // same bytes):
        //
        //   chainId 1           -> 0x01        (scalar 1: single byte)
        //   nonce 0             -> 0x80        (zero scalar = empty string)
        //   maxPriorityFee 0    -> 0x80
        //   maxFee 0            -> 0x80
        //   gasLimit 0          -> 0x80
        //   to (creation)       -> 0x80        (empty byte string)
        //   value 0             -> 0x80
        //   data (empty)        -> 0x80
        //   accessList (empty)  -> 0xc0        (empty list)
        //
        // Payload = 9 bytes -> short-list prefix 0xc0 + 9 = 0xc9; the
        // EIP-2718 type byte 0x02 leads:
        //   02 c9 01 80 80 80 80 80 80 80 c0
        assert_eq!(
            hex::encode(signing_payload(&minimal_fields())),
            "02c90180808080808080c0"
        );
    }

    #[test]
    fn type2_signing_payload_matches_cast_derived_vectors() {
        // Rich fields: payload items are 01 09 01 02 (four scalars),
        // 82 5208 (gas 21000 = 0x5208), 94 + 20-byte to, 64 (value 100),
        // 84 deadbeef, c0 -> 35 bytes -> 0xe3 list prefix, 0x02 envelope.
        assert_eq!(hex::encode(signing_payload(&rich_fields())), RICH_UNSIGNED);
        // Contract creation: `to` is the empty byte string (0x80) even
        // with calldata present.
        assert_eq!(
            hex::encode(signing_payload(&creation_fields())),
            CREATION_UNSIGNED
        );
    }

    #[test]
    fn type2_signed_envelope_matches_cast_derived_vector() {
        let wallet = Wallet::from_private_key_hex(KEY_07_HEX).unwrap();
        let signed = wallet.sign_eip1559_tx(&rich_fields()).unwrap();
        // Byte-exact against the cast-derived raw (RFC 6979 deterministic):
        // any drift in the signing digest, field order, scalar encoding, or
        // envelope changes these bytes.
        assert_eq!(hex::encode(&signed.raw), RICH_SIGNED_07);
    }

    #[test]
    fn type2_signature_scalars_are_minimally_encoded() {
        let wallet = Wallet::from_private_key_hex(KEY_3A_HEX).unwrap();
        let signed = wallet.sign_eip1559_tx(&rich_fields()).unwrap();
        assert_eq!(hex::encode(&signed.raw), RICH_SIGNED_3A);
    }

    #[test]
    fn signer_round_trip_recovers_signer_over_golden_digest() {
        let wallet = Wallet::from_private_key_hex(KEY_07_HEX).unwrap();
        let signed = wallet.sign_eip1559_tx(&rich_fields()).unwrap();
        // Rebuild the signing digest from the independently derived golden
        // signing payload — NOT from the production encoder. If the
        // production digest derivation is wrong, recovery over this digest
        // yields a different key and the address assertion fails.
        let payload = hex::decode(RICH_UNSIGNED).expect("golden payload is hex");
        let prehash = keccak256(&payload);
        let recid = RecoveryId::from_byte(signed.parity).expect("y_parity is 0 or 1");
        let recovered = VerifyingKey::recover_from_prehash(
            &prehash,
            &Signature::from_slice(&signed.signature).expect("sig bytes"),
            recid,
        )
        .expect("signature must recover");
        let point = recovered.to_encoded_point(false);
        let digest = keccak256(&point.as_bytes()[1..]);
        let mut addr = [0u8; 20];
        addr.copy_from_slice(&digest[12..]);
        assert_eq!(addr, wallet.address());
    }

    // --- key management ----------------------------------------------------

    #[test]
    fn imported_key_derives_known_address() {
        let wallet = Wallet::from_private_key_hex(KEY_01_HEX).unwrap();
        assert_eq!(wallet.address_hex(), ADDR_01);
        assert_eq!(hex::encode(wallet.address()), &ADDR_01[2..]);
        // Bare hex (no 0x) is the same key.
        let bare = Wallet::from_private_key_hex(&KEY_01_HEX[2..]).unwrap();
        assert_eq!(bare.address_hex(), ADDR_01);
        assert_eq!(
            Wallet::from_private_key_hex(KEY_07_HEX)
                .unwrap()
                .address_hex(),
            ADDR_07
        );
    }

    #[test]
    fn import_rejects_malformed_keys() {
        assert!(matches!(
            Wallet::from_private_key_hex("nothex"),
            Err(WalletError::InvalidInput(_))
        ));
        assert!(matches!(
            Wallet::from_private_key_hex("0x1234"),
            Err(WalletError::InvalidInput(_))
        ));
        assert!(matches!(
            Wallet::from_private_key_hex(&"00".repeat(31)),
            Err(WalletError::InvalidInput(_))
        ));
    }

    #[test]
    fn debug_output_redacts_key_material() {
        let wallet = Wallet::from_private_key_hex(KEY_07_HEX).unwrap();
        let dbg = format!("{wallet:?}");
        assert!(
            dbg.contains("redacted"),
            "Debug must mark the key redacted: {dbg}"
        );
        assert!(
            !dbg.contains(&KEY_07_HEX[2..]),
            "Debug leaked the key: {dbg}"
        );
    }

    #[test]
    fn generate_produces_distinct_keys() {
        let a = Wallet::generate().expect("keygen");
        let b = Wallet::generate().expect("keygen");
        assert_ne!(a.address(), b.address());
    }

    // --- bounded RPC helpers ----------------------------------------------

    /// Scripted transport, mirroring the one in `client`'s tests. Records
    /// `(method, params)` per call so tests can pin request shapes.
    struct MockRpc {
        responses: Mutex<Vec<Result<Value, AllowanceError>>>,
        seen: Mutex<Vec<(&'static str, Value)>>,
        calls: std::sync::atomic::AtomicUsize,
    }

    impl MockRpc {
        fn new(responses: Vec<Result<Value, AllowanceError>>) -> Arc<Self> {
            Arc::new(Self {
                responses: Mutex::new(responses),
                seen: Mutex::new(Vec::new()),
                calls: std::sync::atomic::AtomicUsize::new(0),
            })
        }

        fn calls(&self) -> usize {
            self.calls.load(std::sync::atomic::Ordering::SeqCst)
        }

        fn seen(&self) -> Vec<(&'static str, Value)> {
            self.seen.lock().unwrap().clone()
        }
    }

    #[async_trait::async_trait]
    impl EvmRpc for MockRpc {
        async fn call(
            &self,
            method: &'static str,
            params: Value,
            _timeout: Duration,
        ) -> Result<Value, AllowanceError> {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.seen.lock().unwrap().push((method, params));
            self.responses.lock().unwrap().remove(0)
        }
    }

    fn signed_sample() -> SignedTx {
        Wallet::from_private_key_hex(KEY_07_HEX)
            .unwrap()
            .sign_eip1559_tx(&rich_fields())
            .unwrap()
    }

    #[tokio::test]
    async fn send_raw_transaction_requires_hash_acknowledgment() {
        let signed = signed_sample();
        let expected = format!("0x{}", hex::encode(signed.tx_hash));
        // Matching ack: broadcast is reported with the hash we signed.
        let rpc = MockRpc::new(vec![Ok(Value::String(expected.clone()))]);
        let client = WalletClient::from_transport(rpc);
        assert_eq!(
            client.send_raw_transaction(&signed).await.unwrap(),
            expected
        );

        // Mismatched ack: refuse to report a transaction we cannot identify.
        let rpc = MockRpc::new(vec![Ok(Value::String(format!("0x{}", "00".repeat(32))))]);
        let client = WalletClient::from_transport(rpc);
        let err = client.send_raw_transaction(&signed).await.unwrap_err();
        assert!(matches!(
            err,
            WalletError::Rpc {
                method: "eth_sendRawTransaction",
                ..
            }
        ));
    }

    #[tokio::test]
    async fn wait_for_receipt_parses_success_receipt() {
        let rpc = MockRpc::new(vec![Ok(serde_json::json!({
            "status": "0x1",
            "contractAddress": "0x00000000000000000000000000000000000000c0",
            "blockNumber": "0x10",
            "gasUsed": "0x5208",
        }))]);
        let client = WalletClient::from_transport(rpc);
        let receipt = client.wait_for_receipt("0xabc").await.unwrap();
        assert_eq!(receipt.tx_hash, "0xabc");
        assert_eq!(
            receipt.contract_address,
            Some(crate::abi::parse_address("0x00000000000000000000000000000000000000c0").unwrap())
        );
        assert_eq!(receipt.block_number, 16);
        assert_eq!(receipt.gas_used, 21_000);
    }

    #[tokio::test]
    async fn wait_for_receipt_reports_revert() {
        let rpc = MockRpc::new(vec![Ok(serde_json::json!({ "status": "0x0" }))]);
        let client = WalletClient::from_transport(rpc);
        assert!(matches!(
            client.wait_for_receipt("0xabc").await,
            Err(WalletError::TxReverted { .. })
        ));
    }

    #[tokio::test]
    async fn wait_for_receipt_is_bounded_by_deadline() {
        // The node never mines: one bounded poll cycle, then the deadline
        // is the terminal state. If the polling loop were unbounded this
        // test would hang instead of returning.
        let rpc = MockRpc::new(std::iter::repeat_with(|| Ok(Value::Null)).take(8).collect());
        let client = WalletClient::from_transport(rpc.clone())
            .with_receipt_deadline(Duration::from_millis(100));
        let err = client.wait_for_receipt("0xabc").await.unwrap_err();
        assert!(matches!(
            err,
            WalletError::TxUnconfirmed {
                deadline_ms: 100,
                ..
            }
        ));
        assert!(rpc.calls() <= 2, "polling must stop at the deadline");
    }

    #[tokio::test]
    async fn scalar_helpers_parse_hex_quantities() {
        let rpc = MockRpc::new(vec![
            Ok(Value::String("0x7a69".into())),     // eth_chainId -> 31337
            Ok(Value::String("0x3b9aca00".into())), // eth_gasPrice -> 1 gwei
            Ok(Value::String("0x9".into())),        // eth_getTransactionCount -> 9
        ]);
        let client = WalletClient::from_transport(rpc);
        assert_eq!(client.chain_id().await.unwrap(), 31_337);
        assert_eq!(client.gas_price().await.unwrap(), 1_000_000_000);
        assert_eq!(client.get_transaction_count(&TO).await.unwrap(), 9);
    }

    #[tokio::test]
    async fn suggest_eip1559_fees_uses_base_fee_headroom() {
        let rpc = MockRpc::new(vec![
            Ok(serde_json::json!({ "baseFeePerGas": "0xa" })), // base 10
            Ok(Value::String("0x2".into())),                   // tip 2
        ]);
        let client = WalletClient::from_transport(rpc);
        assert_eq!(
            client.suggest_eip1559_fees().await.unwrap(),
            FeeSuggestion {
                max_fee_per_gas: 22, // 2 * 10 + 2
                max_priority_fee_per_gas: 2,
            }
        );
    }

    #[tokio::test]
    async fn suggest_eip1559_fees_rejects_blocks_without_base_fee() {
        let rpc = MockRpc::new(vec![Ok(serde_json::json!({}))]);
        let client = WalletClient::from_transport(rpc);
        assert!(matches!(
            client.suggest_eip1559_fees().await,
            Err(WalletError::MalformedResponse(_))
        ));
    }

    // --- persistence export + generic call/estimate/receipt helpers --------

    #[test]
    fn private_key_hex_export_round_trips() {
        // Export is the persistence seam: bare lowercase hex that
        // `from_private_key_hex` accepts back to the same key.
        let wallet = Wallet::from_private_key_hex(KEY_07_HEX).unwrap();
        let exported = wallet.to_private_key_hex();
        assert_eq!(exported, KEY_07_HEX[2..]);
        let reimported = Wallet::from_private_key_hex(&exported).unwrap();
        assert_eq!(reimported.address_hex(), wallet.address_hex());
    }

    #[tokio::test]
    async fn call_sends_canonical_params_and_returns_data() {
        let rpc = MockRpc::new(vec![Ok(Value::String("0x2a".into()))]);
        let client = WalletClient::from_transport(rpc.clone());
        let out = client
            .call("0x0000000000000000000000000000000000000042", "0xdeadbeef")
            .await
            .unwrap();
        assert_eq!(out, "0x2a");
        let seen = rpc.seen();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].0, "eth_call");
        assert_eq!(
            seen[0].1,
            serde_json::json!([
                {
                    "to": "0x0000000000000000000000000000000000000042",
                    "data": "0xdeadbeef",
                },
                "latest"
            ])
        );
    }

    #[tokio::test]
    async fn call_rejects_bad_inputs_and_non_string_results() {
        // Bad address / bad calldata never reach the transport.
        let rpc = MockRpc::new(vec![]);
        let client = WalletClient::from_transport(rpc.clone());
        assert!(matches!(
            client.call("0x1234", "0x").await,
            Err(WalletError::InvalidInput(_))
        ));
        assert!(matches!(
            client.call(TO_HEX, "nothex").await,
            Err(WalletError::InvalidInput(_))
        ));
        assert_eq!(rpc.calls(), 0);

        // A non-string `result` is malformed, never guessed at.
        let rpc = MockRpc::new(vec![Ok(Value::Number(1.into()))]);
        let client = WalletClient::from_transport(rpc);
        assert!(matches!(
            client.call(TO_HEX, "").await,
            Err(WalletError::MalformedResponse(_))
        ));
    }

    #[tokio::test]
    async fn call_propagates_transport_errors() {
        let rpc = MockRpc::new(vec![Err(AllowanceError::Rpc {
            method: "eth_call",
            detail: "execution reverted".into(),
        })]);
        let client = WalletClient::from_transport(rpc);
        let err = client.call(TO_HEX, "").await.unwrap_err();
        assert!(matches!(
            err,
            WalletError::Rpc {
                method: "eth_call",
                ..
            }
        ));
    }

    #[tokio::test]
    async fn estimate_gas_parses_quantities_and_sends_params() {
        let rpc = MockRpc::new(vec![Ok(Value::String("0x5208".into()))]);
        let client = WalletClient::from_transport(rpc.clone());
        let gas = client
            .estimate_gas(ADDR_07, TO_HEX, 1, "0xdeadbeef")
            .await
            .unwrap();
        assert_eq!(gas, 21_000);
        let seen = rpc.seen();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].0, "eth_estimateGas");
        assert_eq!(
            seen[0].1,
            serde_json::json!([{
                "from": ADDR_07,
                "to": TO_HEX,
                "value": "0x1",
                "data": "0xdeadbeef",
            }])
        );
    }

    #[tokio::test]
    async fn estimate_gas_rejects_oversized_estimates() {
        // A quantity beyond u64 is malformed node data — never truncated.
        let rpc = MockRpc::new(vec![Ok(Value::String("0x10000000000000000".into()))]);
        let client = WalletClient::from_transport(rpc);
        assert!(matches!(
            client.estimate_gas(ADDR_07, TO_HEX, 0, "").await,
            Err(WalletError::MalformedResponse(_))
        ));
    }

    #[tokio::test]
    async fn mined_receipt_returns_revert_as_data() {
        // A mined revert is DATA here (success = false) with real fields —
        // `wait_for_receipt` would have folded it into `WalletError::TxReverted`.
        let rpc = MockRpc::new(vec![Ok(serde_json::json!({
            "status": "0x0",
            "contractAddress": serde_json::Value::Null,
            "blockNumber": "0x10",
            "gasUsed": "0xc350",
        }))]);
        let client = WalletClient::from_transport(rpc);
        let mined = client.mined_receipt("0xabc").await.unwrap().unwrap();
        assert!(!mined.success);
        assert_eq!(mined.receipt.tx_hash, "0xabc");
        assert_eq!(mined.receipt.contract_address, None);
        assert_eq!(mined.receipt.block_number, 16);
        assert_eq!(mined.receipt.gas_used, 50_000);
    }

    #[tokio::test]
    async fn mined_receipt_pending_is_none_and_bad_status_errors() {
        let rpc = MockRpc::new(vec![
            Ok(Value::Null),
            Ok(serde_json::json!({ "status": "0x2" })),
        ]);
        let client = WalletClient::from_transport(rpc);
        assert_eq!(client.mined_receipt("0xabc").await.unwrap(), None);
        assert!(matches!(
            client.mined_receipt("0xabc").await,
            Err(WalletError::MalformedResponse(_))
        ));
    }

    // --- bounded log scanning + bid-id discovery --------------------------

    /// A 32-byte ABI word as the node encodes it.
    fn word(v: u128) -> Value {
        Value::String(format!("0x{:064x}", v))
    }

    /// The 32-byte left-padded topic form of an address.
    fn address_topic(addr_hex: &str) -> [u8; 32] {
        crate::abi::encode_address_word(&crate::abi::parse_address(addr_hex).unwrap())
    }

    /// A `BidSubmitted` log entry as a node would return it.
    fn bid_log(id: u128, owner_hex: &str) -> Value {
        serde_json::json!({
            "address": TO_HEX,
            "topics": [
                format!("0x{}", hex::encode(bid_submitted_topic())),
                format!("0x{:064x}", id),
                format!("0x{}", hex::encode(address_topic(owner_hex))),
            ],
            "data": "0x",
            "blockNumber": "0x1",
            "logIndex": "0x0",
        })
    }

    #[test]
    fn bid_submitted_topic_matches_cast_keccak() {
        // Pinned against `cast keccak "BidSubmitted(uint256,address,uint256,uint128)"`
        // (foundry 1.4.3) so a keccak regression cannot silently change the
        // log filter the bid discovery depends on.
        assert_eq!(
            hex::encode(bid_submitted_topic()),
            "650baad5cd8ca09b8f580be220fa04ce2ba905a041f764b6a3fe2c848eb70540"
        );
    }

    #[tokio::test]
    async fn estimate_creation_gas_omits_the_to_field() {
        let rpc = MockRpc::new(vec![Ok(Value::String("0x5208".into()))]);
        let client = WalletClient::from_transport(rpc.clone());
        let gas = client
            .estimate_creation_gas(ADDR_07, 1, "0xdeadbeef")
            .await
            .unwrap();
        assert_eq!(gas, 21_000);
        let seen = rpc.seen();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].0, "eth_estimateGas");
        // Contract creation: the `to` key is absent, never null.
        assert_eq!(
            seen[0].1,
            serde_json::json!([{
                "from": ADDR_07,
                "value": "0x1",
                "data": "0xdeadbeef",
            }])
        );
    }

    #[tokio::test]
    async fn get_logs_sends_canonical_params_and_parses_entries() {
        let topic0 = bid_submitted_topic();
        let id_topic = crate::abi::encode_uint256(7);
        let owner_topic = address_topic(ADDR_07);
        let rpc = MockRpc::new(vec![Ok(serde_json::json!([{
            "address": TO_HEX,
            "topics": [
                format!("0x{}", hex::encode(topic0)),
                format!("0x{}", hex::encode(id_topic)),
                format!("0x{}", hex::encode(owner_topic)),
            ],
            "data": "0x2a",
            "blockNumber": "0x10",
            "logIndex": "0x1",
        }]))]);
        let client = WalletClient::from_transport(rpc.clone());
        let entries = client
            .get_logs(&LogFilter {
                address: TO,
                topics: vec![Some(topic0), Some(id_topic), Some(owner_topic)],
                from_block: 5,
                to_block: 10,
            })
            .await
            .unwrap();
        assert_eq!(
            entries,
            vec![LogEntry {
                address: TO,
                topics: vec![topic0, id_topic, owner_topic],
                data: vec![0x2a],
                block_number: 16,
                log_index: 1,
            }]
        );
        let seen = rpc.seen();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].0, "eth_getLogs");
        assert_eq!(
            seen[0].1,
            serde_json::json!([{
                "address": TO_HEX,
                "topics": [
                    format!("0x{}", hex::encode(topic0)),
                    format!("0x{}", hex::encode(id_topic)),
                    format!("0x{}", hex::encode(owner_topic)),
                ],
                "fromBlock": "0x5",
                "toBlock": "0xa",
            }])
        );
    }

    #[tokio::test]
    async fn get_logs_caps_the_block_range_before_any_rpc() {
        let rpc = MockRpc::new(vec![]);
        let client = WalletClient::from_transport(rpc.clone());
        // One past the cap: refused up front.
        let too_wide = client
            .get_logs(&LogFilter {
                address: TO,
                topics: vec![],
                from_block: 0,
                to_block: LOG_BLOCK_RANGE_CAP,
            })
            .await
            .unwrap_err();
        assert!(matches!(too_wide, WalletError::InvalidInput(_)));
        // Inverted range: refused up front.
        let inverted = client
            .get_logs(&LogFilter {
                address: TO,
                topics: vec![],
                from_block: 2,
                to_block: 1,
            })
            .await
            .unwrap_err();
        assert!(matches!(inverted, WalletError::InvalidInput(_)));
        assert_eq!(rpc.calls(), 0, "refused requests must not reach the node");

        // Exactly at the cap is one request.
        let rpc = MockRpc::new(vec![Ok(serde_json::json!([]))]);
        let client = WalletClient::from_transport(rpc);
        let entries = client
            .get_logs(&LogFilter {
                address: TO,
                topics: vec![],
                from_block: 0,
                to_block: LOG_BLOCK_RANGE_CAP - 1,
            })
            .await
            .unwrap();
        assert!(entries.is_empty());
    }

    #[tokio::test]
    async fn get_logs_refuses_oversized_responses_instead_of_truncating() {
        let oversized = vec![Value::Null; LOG_RESULT_CAP + 1];
        let rpc = MockRpc::new(vec![Ok(Value::Array(oversized))]);
        let client = WalletClient::from_transport(rpc);
        let err = client
            .get_logs(&LogFilter {
                address: TO,
                topics: vec![],
                from_block: 0,
                to_block: 1,
            })
            .await
            .unwrap_err();
        assert!(matches!(
            err,
            WalletError::Rpc {
                method: "eth_getLogs",
                ..
            }
        ));
    }

    #[tokio::test]
    async fn get_logs_rejects_malformed_entries() {
        let cases = [
            // missing address
            serde_json::json!({"topics": [], "data": "0x", "blockNumber": "0x1", "logIndex": "0x0"}),
            // short topic
            serde_json::json!({"address": TO_HEX, "topics": ["0x1234"], "data": "0x", "blockNumber": "0x1", "logIndex": "0x0"}),
            // bad data hex
            serde_json::json!({"address": TO_HEX, "topics": [], "data": "0xzz", "blockNumber": "0x1", "logIndex": "0x0"}),
            // missing blockNumber
            serde_json::json!({"address": TO_HEX, "topics": [], "data": "0x", "logIndex": "0x0"}),
            // missing logIndex
            serde_json::json!({"address": TO_HEX, "topics": [], "data": "0x", "blockNumber": "0x1"}),
        ];
        for entry in cases {
            let rpc = MockRpc::new(vec![Ok(serde_json::json!([entry]))]);
            let client = WalletClient::from_transport(rpc);
            let result = client
                .get_logs(&LogFilter {
                    address: TO,
                    topics: vec![],
                    from_block: 0,
                    to_block: 1,
                })
                .await;
            assert!(
                matches!(result, Err(WalletError::MalformedResponse(_))),
                "entry must be rejected fail-loud: {result:?}"
            );
        }
        // A non-array result is malformed too.
        let rpc = MockRpc::new(vec![Ok(serde_json::json!({}))]);
        let client = WalletClient::from_transport(rpc);
        assert!(matches!(
            client
                .get_logs(&LogFilter {
                    address: TO,
                    topics: vec![],
                    from_block: 0,
                    to_block: 1,
                })
                .await,
            Err(WalletError::MalformedResponse(_))
        ));
    }

    #[tokio::test]
    async fn find_bid_ids_scans_the_auction_window_in_chunks_and_sorts() {
        // Window [0, 15000) → clamped to the 20000 head → [0, 15000]:
        // two chunks at the 10k request cap. Ids come back out of order
        // (9 before 5) and must be sorted ascending.
        let rpc = MockRpc::new(vec![
            Ok(word(0)),                        // eth_call startBlock() -> 0
            Ok(word(15_001)),                   // eth_call endBlock()   -> 15001 (exclusive)
            Ok(Value::String("0x4e20".into())), // eth_blockNumber -> 20000
            Ok(serde_json::json!([
                bid_log(9, ADDR_07),
                bid_log(5, ADDR_07)
            ])),
            Ok(serde_json::json!([bid_log(7, ADDR_07)])),
        ]);
        let client = WalletClient::from_transport(rpc.clone());
        let ids = client.find_bid_ids(TO_HEX, ADDR_07).await.unwrap();
        assert_eq!(ids, vec![5, 7, 9]);

        let seen = rpc.seen();
        assert_eq!(seen.len(), 5);
        // The window reads are pinned: 4-byte selectors (cast keccak,
        // foundry 1.4.3: startBlock() -> 0x48cd4cb1, endBlock() -> 0x083c6323).
        assert_eq!(seen[0].0, "eth_call");
        assert_eq!(
            seen[0].1,
            serde_json::json!([{"to": TO_HEX, "data": "0x48cd4cb1"}, "latest"])
        );
        assert_eq!(
            seen[1].1,
            serde_json::json!([{"to": TO_HEX, "data": "0x083c6323"}, "latest"])
        );
        // The bid filter: topic0 + wildcard id + the owner's topic.
        let owner_topic = format!("0x{}", hex::encode(address_topic(ADDR_07)));
        let topic0 = format!("0x{}", hex::encode(bid_submitted_topic()));
        assert_eq!(seen[3].0, "eth_getLogs");
        assert_eq!(
            seen[3].1,
            serde_json::json!([{
                "address": TO_HEX,
                "topics": [topic0, Value::Null, owner_topic],
                "fromBlock": "0x0",
                "toBlock": "0x270f",
            }])
        );
        assert_eq!(
            seen[4].1,
            serde_json::json!([{
                "address": TO_HEX,
                "topics": [topic0, Value::Null, owner_topic],
                "fromBlock": "0x2710",
                "toBlock": "0x3a98",
            }])
        );
    }

    #[tokio::test]
    async fn find_bid_ids_falls_back_to_full_history_when_views_are_unreadable() {
        // A non-CCA/mock contract answers startBlock() with undecodable
        // data: the scan falls back to the full [0, latest] history — a
        // superset — rather than failing or silently narrowing. The
        // endBlock() probe is skipped once startBlock() fails.
        let rpc = MockRpc::new(vec![
            Ok(Value::String("0x".into())), // eth_call startBlock() -> undecodable
            Ok(Value::String("0x28".into())), // eth_blockNumber -> 40
            Ok(serde_json::json!([bid_log(3, ADDR_07)])),
        ]);
        let client = WalletClient::from_transport(rpc.clone());
        let ids = client.find_bid_ids(TO_HEX, ADDR_07).await.unwrap();
        assert_eq!(ids, vec![3]);
        let seen = rpc.seen();
        assert_eq!(seen.len(), 3);
        assert_eq!(seen[2].0, "eth_getLogs");
        assert_eq!(
            seen[2].1[0]["fromBlock"].as_str(),
            Some("0x0"),
            "fallback scans from block 0"
        );
        assert_eq!(seen[2].1[0]["toBlock"].as_str(), Some("0x28"));
    }

    #[tokio::test]
    async fn find_bid_ids_empty_window_is_authoritatively_empty() {
        // Views agree the auction window is empty (start >= end): no bid
        // can exist, so no log request is made at all.
        let rpc = MockRpc::new(vec![
            Ok(word(50)),                     // startBlock()
            Ok(word(50)),                     // endBlock() (exclusive)
            Ok(Value::String("0x64".into())), // eth_blockNumber (unused)
        ]);
        let client = WalletClient::from_transport(rpc.clone());
        assert_eq!(client.find_bid_ids(TO_HEX, ADDR_07).await.unwrap(), vec![]);
        assert_eq!(rpc.calls(), 3, "an empty window must not request logs");

        // Window entirely above the chain head clamps empty too.
        let rpc = MockRpc::new(vec![
            Ok(word(50)),
            Ok(word(100)),
            Ok(Value::String("0x1e".into())), // head 30 < start 50
        ]);
        let client = WalletClient::from_transport(rpc.clone());
        assert_eq!(client.find_bid_ids(TO_HEX, ADDR_07).await.unwrap(), vec![]);
        assert_eq!(rpc.calls(), 3);
    }

    #[tokio::test]
    async fn find_bid_ids_scan_is_bounded_by_the_deadline() {
        // A 20k-block window (two chunks) with an already-expired scan
        // deadline: the deadline is the terminal state and not one log
        // chunk may be requested past it.
        let rpc = MockRpc::new(vec![
            Ok(word(0)),
            Ok(word(20_000)),
            Ok(Value::String("0x4e20".into())),
        ]);
        let client =
            WalletClient::from_transport(rpc.clone()).with_log_scan_deadline(Duration::ZERO);
        let err = client.find_bid_ids(TO_HEX, ADDR_07).await.unwrap_err();
        assert!(matches!(
            err,
            WalletError::Timeout {
                method: "eth_getLogs",
                ..
            }
        ));
        assert_eq!(rpc.calls(), 3, "no log chunk may run past the deadline");
    }

    #[tokio::test]
    async fn find_bid_ids_rejects_malformed_bid_logs() {
        // A `BidSubmitted`-shaped entry without the id topic is malformed,
        // never silently skipped.
        let no_id = serde_json::json!({
            "address": TO_HEX,
            "topics": [format!("0x{}", hex::encode(bid_submitted_topic()))],
            "data": "0x",
            "blockNumber": "0x1",
            "logIndex": "0x0",
        });
        let rpc = MockRpc::new(vec![
            Ok(Value::String("0x".into())), // views unreadable -> full history
            Ok(Value::String("0x1".into())),
            Ok(serde_json::json!([no_id])),
        ]);
        let client = WalletClient::from_transport(rpc);
        assert!(matches!(
            client.find_bid_ids(TO_HEX, ADDR_07).await,
            Err(WalletError::MalformedResponse(_))
        ));

        // An id wider than u128 is refused, never truncated.
        let mut wide = bid_log(0, ADDR_07);
        wide["topics"][1] = Value::String(format!("0x01{}", "00".repeat(31)));
        let rpc = MockRpc::new(vec![
            Ok(Value::String("0x".into())),
            Ok(Value::String("0x1".into())),
            Ok(serde_json::json!([wide])),
        ]);
        let client = WalletClient::from_transport(rpc);
        assert!(matches!(
            client.find_bid_ids(TO_HEX, ADDR_07).await,
            Err(WalletError::MalformedResponse(_))
        ));
    }
}
