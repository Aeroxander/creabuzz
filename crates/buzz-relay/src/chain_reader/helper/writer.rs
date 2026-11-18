//! Where the helper sends: a JSON-RPC node with the relay-held key, or a fake
//! in tests. Calls are checked with `eth_call` and `eth_estimateGas` from the
//! helper's own address at the head; nonces come from the `latest` count,
//! never `pending` (the helper keeps at most one transaction in flight and
//! knows its own).

use std::sync::Arc;
use std::time::Duration;

use anyhow::anyhow;
use async_trait::async_trait;
use buzz_evm_allowance::{AllowanceError, Eip1559TxFields, EvmRpc, Wallet};
use serde_json::{json, Value};

use crate::chain_reader::word::{hex0x, parse_bytes, parse_fixed, Word};

/// Fee caps per gas for one transaction.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fees {
    /// `maxFeePerGas`.
    pub max_fee_per_gas: u128,
    /// `maxPriorityFeePerGas`.
    pub max_priority_fee_per_gas: u128,
}

/// A transaction to sign and broadcast.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TxRequest {
    /// The contract.
    pub to: [u8; 20],
    /// Calldata.
    pub data: Vec<u8>,
    /// The helper's nonce.
    pub nonce: u64,
    /// Gas limit.
    pub gas_limit: u64,
    /// Fees.
    pub fees: Fees,
}

/// A mined transaction.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Receipt {
    /// Status 1.
    pub success: bool,
    /// The block it mined in.
    pub block: u64,
    /// Gas used.
    pub gas_used: u64,
    /// The price per gas paid.
    pub effective_gas_price: u128,
}

/// Why a check failed.
#[derive(Debug)]
pub enum CallError {
    /// The contract reverted (the node's answer, with the revert data).
    Reverted(String),
    /// The node could not be asked (a timeout, a transport error).
    Unavailable(anyhow::Error),
}

/// Why a broadcast failed.
#[derive(Debug)]
pub enum SendError {
    /// The node refused the transaction; it is not in flight.
    Rejected(String),
    /// No clear answer (a timeout): it may be in flight.
    Uncertain(String),
}

/// The chain as the helper writes to it.
#[async_trait]
pub trait ChainWriter: Send + Sync {
    /// The helper's address.
    fn address(&self) -> [u8; 20];
    /// `eth_call` from the helper at the head.
    async fn call(&self, to: &[u8; 20], data: &[u8]) -> Result<Vec<u8>, CallError>;
    /// `eth_estimateGas` from the helper.
    async fn estimate_gas(&self, to: &[u8; 20], data: &[u8]) -> Result<u64, CallError>;
    /// The helper's nonce at the newest block (`latest`).
    async fn nonce(&self) -> anyhow::Result<u64>;
    /// Fee caps for a transaction now.
    async fn fees(&self) -> anyhow::Result<Fees>;
    /// The hash `tx` will have once signed (no broadcast).
    fn tx_hash(&self, tx: &TxRequest) -> anyhow::Result<Word>;
    /// Sign and broadcast `tx`.
    async fn send(&self, tx: &TxRequest) -> Result<Word, SendError>;
    /// The receipt of a mined transaction, if it mined.
    async fn receipt(&self, hash: &Word) -> anyhow::Result<Option<Receipt>>;
    /// Whether the node still knows the transaction (mined or waiting).
    async fn known(&self, hash: &Word) -> anyhow::Result<bool>;
}

/// [`ChainWriter`] over a JSON-RPC node and the relay-held key.
pub struct RpcChainWriter {
    rpc: Arc<dyn EvmRpc>,
    wallet: Arc<Wallet>,
    chain_id: u64,
    timeout: Duration,
}

impl RpcChainWriter {
    /// Write through `rpc` with `wallet`, for `chain_id`, each call bounded by
    /// `timeout`.
    pub fn new(
        rpc: Arc<dyn EvmRpc>,
        wallet: Arc<Wallet>,
        chain_id: u64,
        timeout: Duration,
    ) -> Self {
        Self {
            rpc,
            wallet,
            chain_id,
            timeout,
        }
    }

    async fn rpc(&self, method: &'static str, params: Value) -> Result<Value, AllowanceError> {
        self.rpc.call(method, params, self.timeout).await
    }

    fn fields<'a>(&self, tx: &'a TxRequest) -> Eip1559TxFields<'a> {
        Eip1559TxFields {
            chain_id: self.chain_id,
            nonce: tx.nonce,
            max_priority_fee_per_gas: tx.fees.max_priority_fee_per_gas,
            max_fee_per_gas: tx.fees.max_fee_per_gas,
            gas_limit: tx.gas_limit,
            to: Some(tx.to),
            value: 0,
            data: &tx.data,
        }
    }
}

/// Whether a node's error is a contract revert (and not a node problem).
pub fn is_revert(detail: &str) -> bool {
    let d = detail.to_ascii_lowercase();
    d.contains("revert") || d.contains("\"code\":3,") || d.contains("\"code\":3}")
}

fn call_error(e: AllowanceError) -> CallError {
    match &e {
        AllowanceError::Rpc { detail, .. } if is_revert(detail) => {
            CallError::Reverted(detail.clone())
        }
        _ => CallError::Unavailable(anyhow!("{e}")),
    }
}

fn quantity(v: &Value) -> anyhow::Result<u128> {
    let text = v.as_str().ok_or_else(|| anyhow!("not a quantity: {v}"))?;
    let raw = text
        .strip_prefix("0x")
        .ok_or_else(|| anyhow!("not a quantity: {text}"))?;
    if raw.is_empty() {
        return Ok(0);
    }
    u128::from_str_radix(raw, 16).map_err(|e| anyhow!("bad quantity {text}: {e}"))
}

fn small(v: &Value) -> anyhow::Result<u64> {
    u64::try_from(quantity(v)?).map_err(|_| anyhow!("quantity too large: {v}"))
}

#[async_trait]
impl ChainWriter for RpcChainWriter {
    fn address(&self) -> [u8; 20] {
        self.wallet.address()
    }

    async fn call(&self, to: &[u8; 20], data: &[u8]) -> Result<Vec<u8>, CallError> {
        let v = self
            .rpc(
                "eth_call",
                json!([{"from": hex0x(&self.address()), "to": hex0x(to), "data": hex0x(data)}, "latest"]),
            )
            .await
            .map_err(call_error)?;
        v.as_str()
            .and_then(parse_bytes)
            .ok_or_else(|| CallError::Unavailable(anyhow!("eth_call answered {v}")))
    }

    async fn estimate_gas(&self, to: &[u8; 20], data: &[u8]) -> Result<u64, CallError> {
        let v = self
            .rpc(
                "eth_estimateGas",
                json!([{"from": hex0x(&self.address()), "to": hex0x(to), "data": hex0x(data)}]),
            )
            .await
            .map_err(call_error)?;
        small(&v).map_err(CallError::Unavailable)
    }

    async fn nonce(&self) -> anyhow::Result<u64> {
        let v = self
            .rpc(
                "eth_getTransactionCount",
                json!([hex0x(&self.address()), "latest"]),
            )
            .await?;
        small(&v)
    }

    async fn fees(&self) -> anyhow::Result<Fees> {
        let block = self
            .rpc("eth_getBlockByNumber", json!(["latest", false]))
            .await?;
        let base = block
            .get("baseFeePerGas")
            .ok_or_else(|| anyhow!("the newest block has no base fee"))?;
        let base = quantity(base)?;
        let tip = match self.rpc("eth_maxPriorityFeePerGas", json!([])).await {
            Ok(v) => quantity(&v)?,
            Err(_) => 1_000_000_000,
        };
        Ok(Fees {
            max_fee_per_gas: base.saturating_mul(2).saturating_add(tip),
            max_priority_fee_per_gas: tip,
        })
    }

    fn tx_hash(&self, tx: &TxRequest) -> anyhow::Result<Word> {
        Ok(self
            .wallet
            .sign_eip1559_tx(&self.fields(tx))
            .map_err(|e| anyhow!("sign: {e}"))?
            .tx_hash)
    }

    async fn send(&self, tx: &TxRequest) -> Result<Word, SendError> {
        let signed = self
            .wallet
            .sign_eip1559_tx(&self.fields(tx))
            .map_err(|e| SendError::Rejected(format!("sign: {e}")))?;
        match self
            .rpc("eth_sendRawTransaction", json!([hex0x(&signed.raw)]))
            .await
        {
            Ok(v) => {
                let back = v.as_str().and_then(parse_fixed::<32>);
                if back != Some(signed.tx_hash) {
                    return Err(SendError::Uncertain(format!(
                        "the node answered {v}, not the signed hash {}",
                        hex0x(&signed.tx_hash)
                    )));
                }
                Ok(signed.tx_hash)
            }
            Err(AllowanceError::Rpc { detail, .. })
                if !detail.starts_with("transport") && !detail.starts_with("bad response") =>
            {
                Err(SendError::Rejected(detail))
            }
            Err(e) => Err(SendError::Uncertain(e.to_string())),
        }
    }

    async fn receipt(&self, hash: &Word) -> anyhow::Result<Option<Receipt>> {
        let v = self
            .rpc("eth_getTransactionReceipt", json!([hex0x(hash)]))
            .await?;
        if v.is_null() {
            return Ok(None);
        }
        let status = v.get("status").map(small).transpose()?.unwrap_or(0);
        let field = |name: &str| v.get(name).ok_or_else(|| anyhow!("receipt has no {name}"));
        Ok(Some(Receipt {
            success: status == 1,
            block: small(field("blockNumber")?)?,
            gas_used: small(field("gasUsed")?)?,
            effective_gas_price: quantity(field("effectiveGasPrice")?)?,
        }))
    }

    async fn known(&self, hash: &Word) -> anyhow::Result<bool> {
        let v = self
            .rpc("eth_getTransactionByHash", json!([hex0x(hash)]))
            .await?;
        Ok(!v.is_null())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reverts_are_told_apart_from_node_problems() {
        for revert in [
            r#"{"code":3,"message":"execution reverted: custom error 0x6c9b7a5f","data":"0x6c9b7a5f"}"#,
            r#"{"code":-32000,"message":"execution reverted"}"#,
            r#"{"code":-32603,"message":"EVM error: Revert"}"#,
        ] {
            assert!(is_revert(revert), "{revert}");
        }
        for other in [
            "transport: connection refused",
            r#"{"code":-32005,"message":"limit"}"#,
        ] {
            assert!(!is_revert(other), "{other}");
        }
    }
}
