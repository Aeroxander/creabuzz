//! Where the reader gets blocks and logs: a JSON-RPC node, or a fake chain in
//! tests.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context};
use async_trait::async_trait;
use buzz_evm_allowance::EvmRpc;
use serde_json::{json, Value};

use super::word::{hex0x, parse_bytes, parse_fixed, parse_quantity, Word};

/// A block header: what the reader keeps to notice a chain rollback.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Header {
    /// Block number.
    pub number: u64,
    /// Block hash.
    pub hash: Word,
    /// The parent block's hash.
    pub parent: Word,
    /// Block time (unix seconds).
    pub time: u64,
}

/// One log as the node returns it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RawLog {
    /// Block number.
    pub block_number: u64,
    /// Hash of the block the node says the log is in.
    pub block_hash: Word,
    /// Transaction hash.
    pub tx_hash: Word,
    /// Position in the block.
    pub log_index: u32,
    /// Emitting contract.
    pub address: [u8; 20],
    /// Topics, the first being the event's.
    pub topics: Vec<Word>,
    /// Non-indexed data.
    pub data: Vec<u8>,
    /// The node marks logs of a block that left the chain.
    pub removed: bool,
}

/// The chain as the reader sees it.
#[async_trait]
pub trait ChainSource: Send + Sync {
    /// The chain id the node serves.
    async fn chain_id(&self) -> anyhow::Result<u64>;
    /// The newest block number.
    async fn head(&self) -> anyhow::Result<u64>;
    /// The header of block `number`, or `None` if the chain is shorter.
    async fn header(&self, number: u64) -> anyhow::Result<Option<Header>>;
    /// Logs from `addresses` in blocks `from..=to` whose first topic is one of
    /// `topics`, in chain order.
    async fn logs(
        &self,
        addresses: &[[u8; 20]],
        topics: &[Word],
        from: u64,
        to: u64,
    ) -> anyhow::Result<Vec<RawLog>>;

    /// Logs from one shared contract in blocks `from..=to` whose first topic
    /// is `topic0` and whose second is one of `topic1` (the pool manager's
    /// `Swap` for the projects' own pools only), in chain order. A source
    /// that cannot filter on the second topic answers an error, never a
    /// silent empty list.
    async fn logs_with_topic1(
        &self,
        _address: &[u8; 20],
        _topic0: &Word,
        _topic1: &[Word],
        _from: u64,
        _to: u64,
    ) -> anyhow::Result<Vec<RawLog>> {
        anyhow::bail!("this chain source cannot filter logs on their second topic")
    }

    /// `eth_call` of `data` to `to` at block `at` (the Launcher's fixed
    /// addresses). `None` when this source makes no calls.
    async fn eth_call(
        &self,
        _to: &[u8; 20],
        _data: &[u8],
        _at: u64,
    ) -> anyhow::Result<Option<Vec<u8>>> {
        Ok(None)
    }

    /// Every call of `calls` at block `at`, answers in the same order. All the
    /// answers are of the one block: a call that fails (a revert, a node that
    /// cannot serve the block, a source that makes no calls) fails the whole
    /// batch, so a record is never built from a part of its numbers.
    async fn eth_call_batch(&self, calls: &[ViewCall], at: u64) -> anyhow::Result<Vec<Vec<u8>>> {
        let mut out = Vec::with_capacity(calls.len());
        for call in calls {
            let answer = self
                .eth_call(&call.to, &call.data, at)
                .await?
                .ok_or_else(|| anyhow!("this chain source makes no calls"))?;
            out.push(answer);
        }
        Ok(out)
    }
}

/// One read-only call of a batch: the contract and its calldata.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ViewCall {
    /// The contract.
    pub to: [u8; 20],
    /// The selector and the ABI-encoded arguments.
    pub data: Vec<u8>,
}

/// At most this many `eth_call`s of a batch are in flight at once.
pub const CALLS_IN_FLIGHT: usize = 16;

/// Logs from at most this many addresses go into one `eth_getLogs` call.
pub const ADDRESSES_PER_CALL: usize = 100;
/// A node answering more logs than this for one call is refused, not
/// truncated: the reader then asks for a smaller block range (see
/// [`is_too_many_logs`]).
pub const MAX_LOGS_PER_CALL: usize = 10_000;

/// A log request the reader or the node refused as too big for one answer.
#[derive(Debug)]
pub struct TooManyLogs(pub String);

impl std::fmt::Display for TooManyLogs {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "too many logs for one request: {}", self.0)
    }
}

impl std::error::Error for TooManyLogs {}

/// Whether `error` says a log request covered too much: the reader's own
/// [`TooManyLogs`], or a node's result or block-range limit (JSON-RPC -32005
/// "query returned more than 10000 results", "block range is too large",
/// "log response size exceeded", ...), not a rate limit or a timeout. The
/// reader then halves the range.
pub fn is_too_many_logs(error: &anyhow::Error) -> bool {
    if error.chain().any(|e| e.is::<TooManyLogs>()) {
        return true;
    }
    let text = format!("{error:#}").to_lowercase();
    [
        "-32005",
        "more than",
        "too many results",
        "too many logs",
        "range too large",
        "range is too large",
        "range too wide",
        "block range",
        "response size",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

/// [`ChainSource`] over a JSON-RPC node.
pub struct RpcChainSource {
    rpc: Arc<dyn EvmRpc>,
    timeout: Duration,
}

impl RpcChainSource {
    /// Read through `rpc`, each call bounded by `timeout`.
    pub fn new(rpc: Arc<dyn EvmRpc>, timeout: Duration) -> Self {
        Self { rpc, timeout }
    }

    async fn call(&self, method: &'static str, params: Value) -> anyhow::Result<Value> {
        self.rpc
            .call(method, params, self.timeout)
            .await
            .map_err(|e| anyhow!("{method}: {e}"))
    }
}

fn str_field<'a>(v: &'a Value, key: &str) -> anyhow::Result<&'a str> {
    v.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("missing {key}"))
}

fn quantity(v: &Value, key: &str) -> anyhow::Result<u64> {
    parse_quantity(str_field(v, key)?).ok_or_else(|| anyhow!("bad {key}"))
}

fn word(v: &Value, key: &str) -> anyhow::Result<Word> {
    parse_fixed::<32>(str_field(v, key)?).ok_or_else(|| anyhow!("bad {key}"))
}

/// Parse an `eth_getBlockByNumber` result.
pub fn parse_header(v: &Value) -> anyhow::Result<Header> {
    Ok(Header {
        number: quantity(v, "number")?,
        hash: word(v, "hash")?,
        parent: word(v, "parentHash")?,
        time: quantity(v, "timestamp")?,
    })
}

/// Parse one entry of an `eth_getLogs` result.
pub fn parse_log(v: &Value) -> anyhow::Result<RawLog> {
    let topics = v
        .get("topics")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("missing topics"))?
        .iter()
        .map(|t| {
            t.as_str()
                .and_then(parse_fixed::<32>)
                .ok_or_else(|| anyhow!("bad topic"))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    let log_index = u32::try_from(quantity(v, "logIndex")?).context("log index")?;
    Ok(RawLog {
        block_number: quantity(v, "blockNumber")?,
        block_hash: word(v, "blockHash")?,
        tx_hash: word(v, "transactionHash")?,
        log_index,
        address: parse_fixed::<20>(str_field(v, "address")?)
            .ok_or_else(|| anyhow!("bad address"))?,
        topics,
        data: parse_bytes(str_field(v, "data")?).ok_or_else(|| anyhow!("bad data"))?,
        removed: v.get("removed").and_then(Value::as_bool).unwrap_or(false),
    })
}

#[async_trait]
impl ChainSource for RpcChainSource {
    async fn chain_id(&self) -> anyhow::Result<u64> {
        let v = self.call("eth_chainId", json!([])).await?;
        v.as_str()
            .and_then(parse_quantity)
            .ok_or_else(|| anyhow!("bad eth_chainId answer"))
    }

    async fn head(&self) -> anyhow::Result<u64> {
        let v = self.call("eth_blockNumber", json!([])).await?;
        v.as_str()
            .and_then(parse_quantity)
            .ok_or_else(|| anyhow!("bad eth_blockNumber answer"))
    }

    async fn header(&self, number: u64) -> anyhow::Result<Option<Header>> {
        let v = self
            .call(
                "eth_getBlockByNumber",
                json!([format!("0x{number:x}"), false]),
            )
            .await?;
        if v.is_null() {
            return Ok(None);
        }
        parse_header(&v).map(Some)
    }

    async fn logs(
        &self,
        addresses: &[[u8; 20]],
        topics: &[Word],
        from: u64,
        to: u64,
    ) -> anyhow::Result<Vec<RawLog>> {
        let topic_list: Vec<String> = topics.iter().map(|t| hex0x(t)).collect();
        let mut out = Vec::new();
        for chunk in addresses.chunks(ADDRESSES_PER_CALL) {
            let list: Vec<String> = chunk.iter().map(|a| hex0x(a)).collect();
            let v = self
                .call(
                    "eth_getLogs",
                    json!([{
                        "fromBlock": format!("0x{from:x}"),
                        "toBlock": format!("0x{to:x}"),
                        "address": list,
                        "topics": [topic_list],
                    }]),
                )
                .await?;
            let entries = v
                .as_array()
                .ok_or_else(|| anyhow!("eth_getLogs answer is not a list"))?;
            if entries.len() > MAX_LOGS_PER_CALL {
                return Err(TooManyLogs(format!(
                    "eth_getLogs answered {} logs for blocks {from}..={to}",
                    entries.len()
                ))
                .into());
            }
            for entry in entries {
                out.push(parse_log(entry)?);
            }
        }
        out.sort_by_key(|l| (l.block_number, l.log_index));
        Ok(out)
    }

    async fn logs_with_topic1(
        &self,
        address: &[u8; 20],
        topic0: &Word,
        topic1: &[Word],
        from: u64,
        to: u64,
    ) -> anyhow::Result<Vec<RawLog>> {
        if topic1.is_empty() {
            return Ok(Vec::new());
        }
        let wanted: Vec<String> = topic1.iter().map(|t| hex0x(t)).collect();
        let v = self
            .call(
                "eth_getLogs",
                json!([{
                    "fromBlock": format!("0x{from:x}"),
                    "toBlock": format!("0x{to:x}"),
                    "address": hex0x(address),
                    "topics": [hex0x(topic0), wanted],
                }]),
            )
            .await?;
        let entries = v
            .as_array()
            .ok_or_else(|| anyhow!("eth_getLogs answer is not a list"))?;
        if entries.len() > MAX_LOGS_PER_CALL {
            return Err(TooManyLogs(format!(
                "eth_getLogs answered {} logs for blocks {from}..={to}",
                entries.len()
            ))
            .into());
        }
        let mut out = entries
            .iter()
            .map(parse_log)
            .collect::<anyhow::Result<Vec<_>>>()?;
        out.sort_by_key(|l| (l.block_number, l.log_index));
        Ok(out)
    }

    async fn eth_call(
        &self,
        to: &[u8; 20],
        data: &[u8],
        at: u64,
    ) -> anyhow::Result<Option<Vec<u8>>> {
        let v = self
            .call(
                "eth_call",
                json!([{"to": hex0x(to), "data": hex0x(data)}, format!("0x{at:x}")]),
            )
            .await?;
        let text = v
            .as_str()
            .ok_or_else(|| anyhow!("eth_call answer is not hex"))?;
        super::word::parse_bytes(text)
            .map(Some)
            .ok_or_else(|| anyhow!("eth_call answer is not hex"))
    }

    async fn eth_call_batch(&self, calls: &[ViewCall], at: u64) -> anyhow::Result<Vec<Vec<u8>>> {
        use futures_util::future::try_join_all;
        // Each call names the block number, so the answers are of one block
        // however they are interleaved; `try_join_all` keeps their order.
        let mut out = Vec::with_capacity(calls.len());
        for chunk in calls.chunks(CALLS_IN_FLIGHT) {
            let mut pending = Vec::with_capacity(chunk.len());
            for call in chunk {
                pending.push(async move {
                    self.eth_call(&call.to, &call.data, at)
                        .await?
                        .ok_or_else(|| anyhow!("eth_call answer is missing"))
                });
            }
            out.extend(try_join_all(pending).await?);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_an_anvil_header_and_log() {
        let header = json!({
            "number": "0x1b",
            "hash": format!("0x{}", "aa".repeat(32)),
            "parentHash": format!("0x{}", "bb".repeat(32)),
            "timestamp": "0x6553f100",
        });
        let h = parse_header(&header).expect("header");
        assert_eq!((h.number, h.time), (27, 0x6553_f100));
        assert_eq!(h.parent, [0xbb; 32]);

        let log = json!({
            "address": "0x5fbdb2315678afecb367f032d93f642f64180aa3",
            "topics": [format!("0x{}", "11".repeat(32))],
            "data": "0x",
            "blockNumber": "0x1b",
            "blockHash": format!("0x{}", "aa".repeat(32)),
            "transactionHash": format!("0x{}", "cc".repeat(32)),
            "logIndex": "0x2",
            "removed": false,
        });
        let l = parse_log(&log).expect("log");
        assert_eq!((l.block_number, l.log_index, l.removed), (27, 2, false));
        assert!(l.data.is_empty());
        assert!(parse_log(&json!({"topics": []})).is_err());
    }

    #[test]
    fn too_many_logs_is_told_apart_from_other_failures() {
        let own: anyhow::Error = TooManyLogs("12000 logs".into()).into();
        assert!(is_too_many_logs(&own));
        assert!(is_too_many_logs(&own.context("read blocks 1..=2000")));
        for node in [
            "eth_getLogs: rpc error -32005: query returned more than 10000 results",
            "eth_getLogs: block range is too large",
            "eth_getLogs: Log response size exceeded.",
        ] {
            assert!(is_too_many_logs(&anyhow!("{node}")), "{node}");
        }
        for other in [
            "eth_getLogs: timed out",
            "eth_getLogs: HTTP 429 Too Many Requests",
            "eth_getLogs: rate limit exceeded",
            "block 7 is not on the chain",
            "a log of block 3 names another block; the chain moved",
        ] {
            assert!(!is_too_many_logs(&anyhow!("{other}")), "{other}");
        }
    }
}
