//! `AllowanceClient` — the fail-closed onchain spend guard.
//!
//! Wiring point for the NIP-ORG value layer: kind-37012 budgets carry an
//! optional `onchain` binding; this client enforces the spend ceiling at the
//! point where an agent would spend, against `OrgAllowance.sol`:
//!
//! - [`AllowanceClient::check`] reads `remainingOf(subject, token, epoch)`
//!   and answers allowed/exceeded — **any** RPC, decode, or input error
//!   denies (fail closed).
//! - [`AllowanceClient::record_spend`] settles the spend onchain from the
//!   configured spender key and waits, bounded, for the receipt.
//!
//! Bounded resources: every RPC round-trip carries an explicit timeout, the
//! gas limit is capped, and the receipt wait has a deadline (see
//! `AllowanceError::SpendUnconfirmed`).

use std::sync::Arc;
use std::time::{Duration, Instant};

use k256::ecdsa::SigningKey;
use serde_json::json;

use crate::abi;
use crate::epoch::Window;
use crate::error::AllowanceError;
use crate::rpc::EvmRpc;
use crate::tx;

/// Default ceiling for one RPC round-trip.
pub const DEFAULT_RPC_TIMEOUT: Duration = Duration::from_secs(5);
/// Default deadline for waiting for a broadcast spend to mine.
pub const DEFAULT_RECEIPT_DEADLINE: Duration = Duration::from_secs(30);
/// Poll interval while waiting for a receipt.
const RECEIPT_POLL_INTERVAL: Duration = Duration::from_millis(500);

/// Outcome of [`AllowanceClient::check`]. There is no "allow on error":
/// every failure mode is a deny.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AllowanceDecision {
    /// The spend fits; `remaining_after` is what the subject would have left.
    Allowed { remaining_after: u128 },
    /// The spend exceeds the epoch allowance; `remaining` is what is left.
    Exceeded { remaining: u128 },
    /// Fail-closed deny: an RPC, decode, or input error occurred. Never
    /// treated as an allowance.
    Denied { reason: String },
}

/// A settled onchain spend.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpendReceipt {
    /// Transaction hash of the `spend()` call, `0x`-prefixed lowercase.
    pub tx_hash: String,
}

/// Fail-closed guard client over an `OrgAllowance.sol` deployment.
pub struct AllowanceClient {
    rpc: Arc<dyn EvmRpc>,
    contract: [u8; 20],
    spender: Option<SigningKey>,
    rpc_timeout: Duration,
    receipt_deadline: Duration,
}

impl AllowanceClient {
    /// Build a guard against `contract` reachable at `rpc_url`.
    pub fn new(rpc_url: &str, contract: &str) -> Result<Self, AllowanceError> {
        let rpc: Arc<dyn EvmRpc> = Arc::new(crate::rpc::HttpEvmRpc::new(rpc_url)?);
        Self::from_transport(rpc, contract)
    }

    /// Build a guard over an injected transport (tests).
    pub fn from_transport(rpc: Arc<dyn EvmRpc>, contract: &str) -> Result<Self, AllowanceError> {
        Ok(Self {
            rpc,
            contract: abi::parse_address(contract)?,
            spender: None,
            rpc_timeout: DEFAULT_RPC_TIMEOUT,
            receipt_deadline: DEFAULT_RECEIPT_DEADLINE,
        })
    }

    /// Configure the authorized spender key (`BUZZ_SPENDER_KEY`). Required
    /// for [`AllowanceClient::record_spend`]; `check` never needs it.
    pub fn with_spender_key(mut self, key_hex: &str) -> Result<Self, AllowanceError> {
        let clean = key_hex.trim().trim_start_matches("0x");
        let bytes = hex::decode(clean)
            .map_err(|e| AllowanceError::InvalidInput(format!("bad spender key hex: {e}")))?;
        let key = SigningKey::from_slice(&bytes)
            .map_err(|e| AllowanceError::InvalidInput(format!("bad spender key: {e}")))?;
        self.spender = Some(key);
        Ok(self)
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

    /// The spender's EVM address, when a spender key is configured.
    pub fn spender_address(&self) -> Option<[u8; 20]> {
        self.spender.as_ref().map(tx::address_from_key)
    }

    /// The contract address this guard enforces against, `0x`-prefixed.
    pub fn contract_hex(&self) -> String {
        format!("0x{}", hex::encode(self.contract))
    }

    /// Check whether `amount` fits the subject's onchain allowance for
    /// `window`'s current epoch — without moving anything.
    ///
    /// Fail closed: RPC errors, timeouts, malformed responses, and bad
    /// inputs all yield [`AllowanceDecision::Denied`], never an allowance.
    pub async fn check(
        &self,
        subject_hex: &str,
        token: &str,
        amount: u128,
        window: Window,
    ) -> AllowanceDecision {
        let (subject, token_addr) =
            match (abi::parse_subject(subject_hex), abi::parse_address(token)) {
                (Ok(s), Ok(t)) => (s, t),
                (Err(e), _) | (_, Err(e)) => {
                    return AllowanceDecision::Denied {
                        reason: e.to_string(),
                    }
                }
            };
        let epoch = window.epoch_now();
        let data = abi::encode_view_call(abi::SELECTOR_REMAINING_OF, &subject, &token_addr, epoch);
        let params = json!([
            {
                "to": format!("0x{}", hex::encode(self.contract)),
                "data": format!("0x{}", hex::encode(&data)),
            },
            "latest",
        ]);
        let result = self.rpc.call("eth_call", params, self.rpc_timeout).await;
        let raw = match result {
            Ok(v) => v,
            Err(e) => {
                return AllowanceDecision::Denied {
                    reason: e.to_string(),
                }
            }
        };
        let hex_str = match raw.as_str() {
            Some(s) => s,
            None => {
                return AllowanceDecision::Denied {
                    reason: "eth_call returned non-string result".into(),
                }
            }
        };
        let remaining = match decode_word_hex(hex_str) {
            Ok(v) => v,
            Err(e) => {
                return AllowanceDecision::Denied {
                    reason: e.to_string(),
                }
            }
        };
        if amount > remaining {
            AllowanceDecision::Exceeded { remaining }
        } else {
            AllowanceDecision::Allowed {
                remaining_after: remaining - amount,
            }
        }
    }

    /// Settle a spend onchain: send `spend(subject, token, epoch, amount)`
    /// from the configured spender key and wait (bounded) for the receipt.
    ///
    /// The contract itself is the last line of defense — it reverts an
    /// over-spend even if a stale `check` let one through.
    pub async fn record_spend(
        &self,
        subject_hex: &str,
        token: &str,
        amount: u128,
        window: Window,
    ) -> Result<SpendReceipt, AllowanceError> {
        let spender = self.spender.as_ref().ok_or(AllowanceError::NoSpender)?;
        let subject = abi::parse_subject(subject_hex)?;
        let token_addr = abi::parse_address(token)?;
        let epoch = window.epoch_now();
        let data = abi::encode_spend(&subject, &token_addr, epoch, amount);
        let tx_hash = self.send_contract_tx(spender, &data).await?;
        Ok(tx_hash)
    }

    /// Send one bounded-gas contract call from `spender` and wait for the
    /// receipt. Shared by the spend path and the deployment-time admin calls
    /// used by the integration test.
    pub async fn send_contract_tx(
        &self,
        spender: &SigningKey,
        data: &[u8],
    ) -> Result<SpendReceipt, AllowanceError> {
        let contract_hex = format!("0x{}", hex::encode(self.contract));
        let from_hex = format!("0x{}", hex::encode(tx::address_from_key(spender)));

        // 1. Chain id (EIP-155 replay protection).
        let chain_id = self.scalar_rpc("eth_chainId", json!([])).await? as u64;
        // 2. Nonce — "pending" so concurrent sends from one key queue rather
        //    than collide.
        let nonce = self
            .scalar_rpc("eth_getTransactionCount", json!([from_hex, "pending"]))
            .await? as u64;
        // 3. Gas price (legacy tx; anvil and pre-London semantics accept it).
        let gas_price = self.scalar_rpc("eth_gasPrice", json!([])).await?;
        // 4. Gas estimate, hard-capped.
        let params = json!([{ "from": from_hex, "to": contract_hex, "data": format!("0x{}", hex::encode(data)) }]);
        let estimated = match self.scalar_rpc("eth_estimateGas", params).await {
            Ok(gas) => gas as u64,
            // A simulation revert is the contract's refusal — distinguish it
            // from transport failures so callers can report "the chain said
            // no" instead of "the node is down". Either way: no broadcast.
            Err(AllowanceError::Rpc { detail, .. }) if is_revert(&detail) => {
                return Err(AllowanceError::SpendRejectedByContract { detail });
            }
            Err(e) => return Err(e),
        };
        if estimated > tx::MAX_GAS {
            return Err(AllowanceError::GasEstimateOverCap {
                estimated,
                cap: tx::MAX_GAS,
            });
        }

        // 5. Sign (EIP-155) and broadcast.
        let signed = tx::sign_legacy_tx(
            spender,
            &tx::LegacyTxFields {
                chain_id,
                nonce,
                gas_price,
                gas: estimated,
                to: &self.contract,
                value: 0,
                data,
            },
        )?;
        let raw_hex = format!("0x{}", hex::encode(&signed.raw));
        let hash_value = self
            .rpc
            .call("eth_sendRawTransaction", json!([raw_hex]), self.rpc_timeout)
            .await?;
        let tx_hash = hash_value
            .as_str()
            .ok_or_else(|| AllowanceError::Rpc {
                method: "eth_sendRawTransaction",
                detail: "non-string tx hash".into(),
            })?
            .to_ascii_lowercase();
        // The node must acknowledge exactly the transaction we signed. A
        // mismatch means the node did not accept our bytes as-is — refuse to
        // report a spend we cannot identify.
        let expected = format!("0x{}", hex::encode(signed.tx_hash));
        if tx_hash != expected {
            return Err(AllowanceError::Rpc {
                method: "eth_sendRawTransaction",
                detail: format!("node returned {tx_hash}, we signed {expected}"),
            });
        }

        // 6. Bounded wait for the receipt; an unknown outcome is an error,
        //    never a success.
        let deadline = Instant::now() + self.receipt_deadline;
        loop {
            if Instant::now() >= deadline {
                return Err(AllowanceError::SpendUnconfirmed {
                    tx_hash,
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
                        "0x1" => Ok(SpendReceipt { tx_hash }),
                        "0x0" => Err(AllowanceError::SpendReverted { tx_hash }),
                        other => Err(AllowanceError::Rpc {
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
    ) -> Result<u128, AllowanceError> {
        let v = self.rpc.call(method, params, self.rpc_timeout).await?;
        parse_hex_quantity(&v).map_err(|e| AllowanceError::Rpc { method, detail: e })
    }
}

/// Decode a `0x`-prefixed hex string into a u128 (allowance words). Values
/// beyond u128 are a malformed response — the caller denies.
fn decode_word_hex(hex_str: &str) -> Result<u128, AllowanceError> {
    let clean = hex_str.trim().trim_start_matches("0x");
    let bytes = hex::decode(clean)
        .map_err(|e| AllowanceError::MalformedResponse(format!("bad hex word {hex_str:?}: {e}")))?;
    abi::decode_uint256(&bytes)
}

/// Heuristic: does a JSON-RPC error body carry contract revert data?
fn is_revert(detail: &str) -> bool {
    detail.contains("execution reverted") || detail.contains("\"data\"")
}

/// Parse a JSON-RPC hex quantity ("0x…") into a u128.
fn parse_hex_quantity(value: &serde_json::Value) -> Result<u128, String> {
    let s = value
        .as_str()
        .ok_or_else(|| format!("expected hex quantity string, got {value}"))?;
    let clean = s.trim().trim_start_matches("0x");
    if clean.is_empty() {
        return Ok(0);
    }
    u128::from_str_radix(clean, 16).map_err(|e| format!("bad hex quantity {s:?}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::HttpEvmRpc;
    use serde_json::Value;
    use std::sync::Mutex;

    /// Scripted transport for fail-closed and decision-math tests.
    struct MockRpc {
        responses: Mutex<Vec<Result<Value, AllowanceError>>>,
        calls: std::sync::atomic::AtomicUsize,
    }

    impl MockRpc {
        fn new(responses: Vec<Result<Value, AllowanceError>>) -> Self {
            Self {
                responses: Mutex::new(responses),
                calls: std::sync::atomic::AtomicUsize::new(0),
            }
        }
    }

    #[async_trait::async_trait]
    impl EvmRpc for MockRpc {
        async fn call(
            &self,
            _method: &'static str,
            _params: Value,
            _timeout: Duration,
        ) -> Result<Value, AllowanceError> {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.responses.lock().unwrap().remove(0)
        }
    }

    const SUBJECT: &str = "11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa";
    const TOKEN: &str = "0x0000000000000000000000000000000000000042";
    const CONTRACT: &str = "0x00000000000000000000000000000000000000c0";

    fn word(v: u128) -> Value {
        Value::String(format!("0x{:064x}", v))
    }

    #[tokio::test]
    async fn under_limit_is_allowed_with_remaining_after() {
        let rpc = Arc::new(MockRpc::new(vec![Ok(word(100))]));
        let client = AllowanceClient::from_transport(rpc.clone(), CONTRACT).unwrap();
        assert_eq!(
            client.check(SUBJECT, TOKEN, 30, Window::Day).await,
            AllowanceDecision::Allowed {
                remaining_after: 70
            }
        );
        assert_eq!(rpc.calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn boundary_amount_equals_remaining_is_allowed() {
        let rpc = Arc::new(MockRpc::new(vec![Ok(word(100))]));
        let client = AllowanceClient::from_transport(rpc, CONTRACT).unwrap();
        assert_eq!(
            client.check(SUBJECT, TOKEN, 100, Window::Day).await,
            AllowanceDecision::Allowed { remaining_after: 0 }
        );
    }

    #[tokio::test]
    async fn over_limit_reports_exceeded_with_remaining() {
        let rpc = Arc::new(MockRpc::new(vec![Ok(word(70))]));
        let client = AllowanceClient::from_transport(rpc, CONTRACT).unwrap();
        assert_eq!(
            client.check(SUBJECT, TOKEN, 80, Window::Day).await,
            AllowanceDecision::Exceeded { remaining: 70 }
        );
    }

    #[tokio::test]
    async fn rpc_error_fails_closed_as_denied() {
        let rpc = Arc::new(MockRpc::new(vec![Err(AllowanceError::Timeout {
            method: "eth_call",
            timeout_ms: 5_000,
        })]));
        let client = AllowanceClient::from_transport(rpc, CONTRACT).unwrap();
        assert!(matches!(
            client.check(SUBJECT, TOKEN, 1, Window::Day).await,
            AllowanceDecision::Denied { .. }
        ));
    }

    #[tokio::test]
    async fn malformed_response_fails_closed() {
        let rpc = Arc::new(MockRpc::new(vec![Ok(Value::String("0xzz".into()))]));
        let client = AllowanceClient::from_transport(rpc, CONTRACT).unwrap();
        assert!(matches!(
            client.check(SUBJECT, TOKEN, 1, Window::Day).await,
            AllowanceDecision::Denied { .. }
        ));
    }

    #[tokio::test]
    async fn bad_inputs_fail_closed_without_touching_the_node() {
        let rpc = Arc::new(MockRpc::new(vec![]));
        let client = AllowanceClient::from_transport(rpc.clone(), CONTRACT).unwrap();
        assert!(matches!(
            client.check("nothex", TOKEN, 1, Window::Day).await,
            AllowanceDecision::Denied { .. }
        ));
        assert!(matches!(
            client.check(SUBJECT, "0x1234", 1, Window::Day).await,
            AllowanceDecision::Denied { .. }
        ));
        assert_eq!(rpc.calls.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn record_spend_requires_a_spender_key() {
        let rpc = Arc::new(MockRpc::new(vec![]));
        let client = AllowanceClient::from_transport(rpc, CONTRACT).unwrap();
        assert!(matches!(
            client.record_spend(SUBJECT, TOKEN, 1, Window::Day).await,
            Err(AllowanceError::NoSpender)
        ));
    }

    #[tokio::test]
    async fn http_transport_timeouts_are_bounded() {
        // A closed port: the guard must deny fast, not hang.
        let rpc: Arc<dyn EvmRpc> =
            Arc::new(HttpEvmRpc::new("http://127.0.0.1:1").expect("client builds"));
        let client = AllowanceClient::from_transport(rpc, CONTRACT)
            .unwrap()
            .with_rpc_timeout(Duration::from_millis(1_500));
        let decision = client.check(SUBJECT, TOKEN, 1, Window::Day).await;
        assert!(matches!(decision, AllowanceDecision::Denied { .. }));
    }

    #[test]
    fn hex_quantity_parsing() {
        assert_eq!(parse_hex_quantity(&Value::String("0x0".into())).unwrap(), 0);
        assert_eq!(
            parse_hex_quantity(&Value::String("0x7a69".into())).unwrap(),
            31337
        );
        assert_eq!(
            parse_hex_quantity(&Value::String(String::new())).unwrap(),
            0
        );
        assert!(parse_hex_quantity(&Value::Number(1.into())).is_err());
    }
}
