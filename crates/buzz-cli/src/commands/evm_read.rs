//! The read side the on-chain command clients share: one bounded `eth_call`,
//! decoded, and the error wrapper they all use.

use std::time::Duration;

use buzz_evm_allowance::{abi, AllowanceError, EvmRpc};
use serde_json::json;

use crate::error::CliError;

/// Wrap an allowance-client error with what the command was doing.
pub(super) fn cli_error(context: &'static str) -> impl Fn(AllowanceError) -> CliError {
    move |e| CliError::Other(format!("{context}: {e}"))
}

/// One `eth_call` to `to` (a `0x` address) at the latest block, returned as
/// the node's hex string.
pub(super) async fn eth_call_hex(
    rpc: &dyn EvmRpc,
    to: &str,
    data: &[u8],
    timeout: Duration,
) -> Result<String, CliError> {
    let params = json!([
        { "to": to, "data": format!("0x{}", hex::encode(data)) },
        "latest",
    ]);
    let value = rpc
        .call("eth_call", params, timeout)
        .await
        .map_err(cli_error("eth_call"))?;
    value
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| CliError::Other("eth_call returned a non-string result".into()))
}

/// The first 32-byte word of an `eth_call` result.
async fn eth_call_word_bytes(
    rpc: &dyn EvmRpc,
    to: &str,
    data: &[u8],
    timeout: Duration,
) -> Result<[u8; 32], CliError> {
    let hex_str = eth_call_hex(rpc, to, data, timeout).await?;
    let bytes = hex::decode(hex_str.trim().trim_start_matches("0x"))
        .map_err(|e| CliError::Other(format!("malformed eth_call result: {e}")))?;
    if bytes.len() < 32 {
        return Err(CliError::Other(format!(
            "eth_call result too short for a word: {} bytes",
            bytes.len()
        )));
    }
    bytes[..32]
        .try_into()
        .map_err(|_| CliError::Other("word slice mismatch".into()))
}

/// An `eth_call` read as one `uint256` (it must fit in a `u128`).
pub(super) async fn eth_call_word(
    rpc: &dyn EvmRpc,
    to: &str,
    data: &[u8],
    timeout: Duration,
) -> Result<u128, CliError> {
    let word = eth_call_word_bytes(rpc, to, data, timeout).await?;
    abi::decode_uint256(&word).map_err(cli_error("decode"))
}

/// An `eth_call` read as one `address`.
pub(super) async fn eth_call_address(
    rpc: &dyn EvmRpc,
    to: &str,
    data: &[u8],
    timeout: Duration,
) -> Result<[u8; 20], CliError> {
    let word = eth_call_word_bytes(rpc, to, data, timeout).await?;
    word[12..]
        .try_into()
        .map_err(|_| CliError::Other("address slice mismatch".into()))
}
