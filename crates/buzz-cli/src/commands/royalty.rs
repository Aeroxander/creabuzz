//! `buzz royalty` — the contributor royalty ledger (docs/token-lifecycle-design.md).
//!
//! Three surfaces, all local-only (EVM value layer; no relay, no Nostr key):
//!
//! * **read** — `cmd_show`: the ledger state that matters (credited balance,
//!   carry, pending revenue, window clock).
//! * **claim / settle** — the two writes. `claim()` pulls a CREDITED balance
//!   (credited-is-owned: it never expires and no admin can touch it);
//!   `settle()` closes the current settlement window (permissionless).
//! * **mirrors** — unsigned kind:47006/47007 event templates (advisory
//!   mirrors of onchain schedules and settlement closes; the chain is
//!   authoritative). These are the revenue attestation feed's scaffolding:
//!   compose here, sign and publish through the ordinary event path.
//!
//! Bounded resources mirror `org_ragequit`: every RPC round-trip has an
//! explicit timeout, gas is hard-capped, the receipt wait has a deadline,
//! and the network is never touched by unit tests (`EvmRpc` is the seam).

use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::Duration;

use buzz_evm_allowance::tx;
use buzz_evm_allowance::{abi, AllowanceClient, AllowanceError, EvmRpc, HttpEvmRpc};
use nostr::{EventBuilder, Kind, Tag};
use serde_json::json;

use crate::client::BuzzClient;
use crate::error::CliError;

use super::org::{validate_eth_address, ENV_EVM_RPC_URL, ENV_SPENDER_KEY};
use super::{parse_write_response, with_git_provenance};

/// Per-RPC round-trip ceiling (mirrors the allowance client default).
const RPC_TIMEOUT: Duration = buzz_evm_allowance::DEFAULT_RPC_TIMEOUT;
/// Receipt-wait deadline (mirrors the allowance client default).
const RECEIPT_DEADLINE: Duration = buzz_evm_allowance::DEFAULT_RECEIPT_DEADLINE;

// Selectors computed from canonical signatures at runtime (same approach as
// `org_ragequit`); the tests pin them against `cast sig` output.
const SIG_CLAIM: &str = "claim()";
const SIG_SETTLE: &str = "settle()";
const SIG_CLAIMABLE_OF: &str = "claimableOf(address)";
const SIG_CARRY: &str = "carry()";
const SIG_PENDING_REVENUE: &str = "pendingRevenue()";
const SIG_NEXT_CLOSE: &str = "nextClose()";
const SIG_CLOSED_WINDOWS: &str = "closedWindows()";

/// Unsigned mirror event kinds (advisory; the chain is authoritative).
/// Numbers mirror `crates/buzz-core/src/kind.rs` — a test binds them.
pub const MIRROR_KIND_SCHEDULE: u16 = 47006;
pub const MIRROR_KIND_CLOSE: u16 = 47007;

/// ABI-encode `claim()` — pull a credited royalty balance.
pub fn encode_claim_calldata() -> Vec<u8> {
    abi::selector(SIG_CLAIM).to_vec()
}

/// ABI-encode `settle()` — close the current settlement window.
pub fn encode_settle_calldata() -> Vec<u8> {
    abi::selector(SIG_SETTLE).to_vec()
}

fn cli_error(context: &'static str) -> impl Fn(AllowanceError) -> CliError {
    move |e| CliError::Other(format!("{context}: {e}"))
}

/// A minimal RoyaltyDistributor read/write client over the shared
/// value-layer transport. Writes go through [`AllowanceClient::send_contract_tx`]
/// with the distributor as the target — the exact bounded-gas, timed-receipt
/// seam the spend guard and ragequit use.
pub struct RoyaltyClient {
    rpc: Arc<dyn EvmRpc>,
    distributor: [u8; 20],
    rpc_timeout: Duration,
}

impl RoyaltyClient {
    /// Build a client against `distributor` reachable at `rpc`.
    pub fn new_http(rpc_url: &str, distributor: &str) -> Result<Self, CliError> {
        let rpc: Arc<dyn EvmRpc> =
            Arc::new(HttpEvmRpc::new(rpc_url).map_err(cli_error("rpc init"))?);
        Self::from_transport(rpc, distributor)
    }

    /// Build over an injected transport (tests — never touches the network).
    pub fn from_transport(rpc: Arc<dyn EvmRpc>, distributor: &str) -> Result<Self, CliError> {
        let distributor =
            abi::parse_address(distributor).map_err(cli_error("bad distributor address"))?;
        Ok(Self {
            rpc,
            distributor,
            rpc_timeout: RPC_TIMEOUT,
        })
    }

    /// The distributor address, `0x`-prefixed lowercase.
    pub fn distributor_hex(&self) -> String {
        format!("0x{}", hex::encode(self.distributor))
    }

    /// One `eth_call` view read decoded as a single 32-byte word.
    async fn call_word(&self, data: &[u8]) -> Result<u128, CliError> {
        let params = json!([
            { "to": self.distributor_hex(), "data": format!("0x{}", hex::encode(data)) },
            "latest",
        ]);
        let value = self
            .rpc
            .call("eth_call", params, self.rpc_timeout)
            .await
            .map_err(cli_error("eth_call"))?;
        let hex_str = value
            .as_str()
            .ok_or_else(|| CliError::Other("eth_call returned a non-string result".into()))?;
        let clean = hex_str.trim().trim_start_matches("0x");
        let bytes = hex::decode(clean)
            .map_err(|e| CliError::Other(format!("malformed eth_call result: {e}")))?;
        if bytes.len() < 32 {
            return Err(CliError::Other(format!(
                "eth_call result too short for a word: {} bytes",
                bytes.len()
            )));
        }
        abi::decode_uint256(&bytes[..32]).map_err(cli_error("decode"))
    }

    /// `claimableOf(who)` — the credited, never-expiring balance.
    pub async fn claimable_of(&self, who: [u8; 20]) -> Result<u128, CliError> {
        let mut data = abi::selector(SIG_CLAIMABLE_OF).to_vec();
        data.extend_from_slice(&abi::encode_address_word(&who));
        self.call_word(&data).await
    }

    /// `carry()` — unattributable revenue carried into the next pool (D4).
    pub async fn carry(&self) -> Result<u128, CliError> {
        self.call_word(&abi::selector(SIG_CARRY)).await
    }

    /// `pendingRevenue()` — funded but not yet settled.
    pub async fn pending_revenue(&self) -> Result<u128, CliError> {
        self.call_word(&abi::selector(SIG_PENDING_REVENUE)).await
    }

    /// `nextClose()` — unix seconds of the next window close.
    pub async fn next_close(&self) -> Result<u128, CliError> {
        self.call_word(&abi::selector(SIG_NEXT_CLOSE)).await
    }

    /// `closedWindows()` — settled windows so far (also the SellRateGate period).
    pub async fn closed_windows(&self) -> Result<u128, CliError> {
        self.call_word(&abi::selector(SIG_CLOSED_WINDOWS)).await
    }

    /// All `WindowClosed` logs from `from_block` to latest (the watcher's
    /// source of truth for a close's numbers).
    pub async fn window_closes(&self, from_block: u64) -> Result<Vec<WindowClose>, CliError> {
        let params = json!([{
            "address": self.distributor_hex(),
            "topics": [format!("0x{}", hex::encode(topic_window_closed()))],
            "fromBlock": format!("0x{from_block:x}"),
            "toBlock": "latest",
        }]);
        let value = self
            .rpc
            .call("eth_getLogs", params, self.rpc_timeout)
            .await
            .map_err(cli_error("eth_getLogs"))?;
        let logs = value
            .as_array()
            .ok_or_else(|| CliError::Other("eth_getLogs returned a non-array result".into()))?;
        logs.iter().map(decode_window_closed_log).collect()
    }

    /// Broadcast `claim()` from `spender` and wait, bounded, for the receipt.
    pub async fn claim(&self, spender: &k256::ecdsa::SigningKey) -> Result<String, CliError> {
        self.send(spender, &encode_claim_calldata(), "claim").await
    }

    /// Broadcast `settle()` (permissionless) from `spender`, bounded.
    pub async fn settle(&self, spender: &k256::ecdsa::SigningKey) -> Result<String, CliError> {
        self.send(spender, &encode_settle_calldata(), "settle")
            .await
    }

    async fn send(
        &self,
        spender: &k256::ecdsa::SigningKey,
        data: &[u8],
        what: &str,
    ) -> Result<String, CliError> {
        let tx_client = AllowanceClient::from_transport(self.rpc.clone(), &self.distributor_hex())
            .map_err(cli_error("tx client"))?
            .with_rpc_timeout(self.rpc_timeout)
            .with_receipt_deadline(RECEIPT_DEADLINE);
        let receipt = tx_client
            .send_contract_tx(spender, data)
            .await
            .map_err(|e| match e {
                AllowanceError::SpendRejectedByContract { detail } => CliError::Other(format!(
                    "the distributor refused {what} at simulation; nothing was broadcast: {detail}"
                )),
                AllowanceError::SpendReverted { tx_hash } => {
                    CliError::Other(format!("{what} transaction {tx_hash} reverted onchain"))
                }
                AllowanceError::SpendUnconfirmed { .. } => CliError::Other(format!(
                    "{what} transaction not confirmed within the deadline — \
                         check the receipt before assuming it landed; do NOT re-submit blindly"
                )),
                other => CliError::Other(format!("{what} failed: {other}")),
            })?;
        Ok(receipt.tx_hash)
    }
}

// ── mirror event templates (advisory; chain is authoritative) ───────────────

/// Compose the unsigned kind:47006 royalty-schedule mirror event.
pub fn royalty_schedule_event_json(
    chain: &str,
    distributor: &str,
    claim_id: &str,
    evidence_hash: &str,
    contributor: &str,
    weight: u32,
    term: u64,
    band: u8,
    allocation: u128,
) -> serde_json::Value {
    json!({
        "kind": MIRROR_KIND_SCHEDULE,
        "content": json!({
            "claimId": claim_id,
            "evidenceHash": evidence_hash,
            "contributor": contributor,
            "weight": weight,
            "term": term,
            "band": band,
            "allocation": allocation.to_string(),
        })
        .to_string(),
        "tags": [
            ["distributor", distributor],
            ["chain", chain],
            ["claim", claim_id],
            ["evidence", evidence_hash],
        ],
    })
}

/// Compose the unsigned kind:47007 settlement-close mirror event (the
/// revenue attestation feed's per-window record).
pub fn royalty_close_event_json(
    chain: &str,
    distributor: &str,
    window_id: u64,
    revenue: u128,
    buyback_share: u128,
    treasury_share: u128,
    pool: u128,
    carried: u128,
) -> serde_json::Value {
    json!({
        "kind": MIRROR_KIND_CLOSE,
        "content": json!({
            "windowId": window_id,
            "revenue": revenue.to_string(),
            "buybackShare": buyback_share.to_string(),
            "treasuryShare": treasury_share.to_string(),
            "pool": pool.to_string(),
            "carried": carried.to_string(),
        })
        .to_string(),
        "tags": [
            ["distributor", distributor],
            ["chain", chain],
            ["window", window_id.to_string()],
        ],
    })
}

// ── CLI commands ────────────────────────────────────────────────────────────

fn distributor_addr(distributor: &str) -> Result<String, CliError> {
    Ok(validate_eth_address(distributor, "distributor address")?)
}

fn load_spender() -> Result<(String, k256::ecdsa::SigningKey), CliError> {
    let rpc_url = std::env::var(ENV_EVM_RPC_URL)
        .ok()
        .filter(|v| !v.is_empty());
    let spender_key = std::env::var(ENV_SPENDER_KEY)
        .ok()
        .filter(|v| !v.is_empty());
    let (Some(rpc_url), Some(spender_key)) = (rpc_url, spender_key) else {
        return Err(CliError::Usage(format!(
            "royalty chain commands are opt-in: set {ENV_EVM_RPC_URL} and {ENV_SPENDER_KEY} \
             to enable them"
        )));
    };
    let clean_key = spender_key.trim().trim_start_matches("0x");
    let key_bytes = hex::decode(clean_key)
        .map_err(|e| CliError::Usage(format!("invalid {ENV_SPENDER_KEY} hex: {e}")))?;
    let spender = k256::ecdsa::SigningKey::from_slice(&key_bytes)
        .map_err(|e| CliError::Usage(format!("invalid {ENV_SPENDER_KEY}: {e}")))?;
    Ok((rpc_url, spender))
}

/// `buzz royalty show` — the ledger state (read-only).
pub async fn cmd_show(distributor: &str) -> Result<(), CliError> {
    let distributor = distributor_addr(distributor)?;
    let (rpc_url, spender) = load_spender()?;
    let holder = tx::address_from_key(&spender);
    let client = RoyaltyClient::new_http(&rpc_url, &distributor)?;

    println!(
        "{}",
        json!({
            "distributor": client.distributor_hex(),
            "claimable": client.claimable_of(holder).await?.to_string(),
            "carry": client.carry().await?.to_string(),
            "pendingRevenue": client.pending_revenue().await?.to_string(),
            "nextClose": client.next_close().await?.to_string(),
            "closedWindows": client.closed_windows().await?.to_string(),
            "holder": format!("0x{}", hex::encode(holder)),
        })
    );
    Ok(())
}

/// `buzz royalty claim` — pull the credited balance (never expires).
pub async fn cmd_claim(distributor: &str) -> Result<(), CliError> {
    let distributor = distributor_addr(distributor)?;
    let (rpc_url, spender) = load_spender()?;
    let holder = tx::address_from_key(&spender);
    let client = RoyaltyClient::new_http(&rpc_url, &distributor)?;

    let claimable = client.claimable_of(holder).await?;
    if claimable == 0 {
        return Err(CliError::Other(
            "nothing is credited for the configured key; royalties credit automatically at \
             each settlement close"
                .into(),
        ));
    }

    let tx_hash = client.claim(&spender).await?;
    println!(
        "{}",
        json!({
            "status": "ok",
            "txHash": tx_hash,
            "claimed": claimable.to_string(),
            "distributor": client.distributor_hex(),
        })
    );
    Ok(())
}

/// `buzz royalty settle` — close the current settlement window (permissionless).
pub async fn cmd_settle(distributor: &str) -> Result<(), CliError> {
    let distributor = distributor_addr(distributor)?;
    let (rpc_url, spender) = load_spender()?;
    let client = RoyaltyClient::new_http(&rpc_url, &distributor)?;

    let tx_hash = client.settle(&spender).await?;
    println!(
        "{}",
        json!({
            "status": "ok",
            "txHash": tx_hash,
            "distributor": client.distributor_hex(),
            "note": "publish the matching kind:47007 close mirror for the attestation feed",
        })
    );
    Ok(())
}

/// `buzz royalty mirror-schedule` — print an unsigned kind:47006 template.
#[allow(clippy::too_many_arguments)]
pub fn cmd_mirror_schedule(
    chain: &str,
    distributor: &str,
    claim_id: &str,
    evidence_hash: &str,
    contributor: &str,
    weight: u32,
    term: u64,
    band: u8,
    allocation: u128,
) -> Result<(), CliError> {
    let distributor = distributor_addr(distributor)?;
    println!(
        "{}",
        royalty_schedule_event_json(
            chain,
            &distributor,
            claim_id,
            evidence_hash,
            contributor,
            weight,
            term,
            band,
            allocation,
        )
    );
    Ok(())
}

/// `buzz royalty mirror-close` — print an unsigned kind:47007 template.
#[allow(clippy::too_many_arguments)]
pub fn cmd_mirror_close(
    chain: &str,
    distributor: &str,
    window_id: u64,
    revenue: u128,
    buyback_share: u128,
    treasury_share: u128,
    pool: u128,
    carried: u128,
) -> Result<(), CliError> {
    let distributor = distributor_addr(distributor)?;
    println!(
        "{}",
        royalty_close_event_json(
            chain,
            &distributor,
            window_id,
            revenue,
            buyback_share,
            treasury_share,
            pool,
            carried,
        )
    );
    Ok(())
}

// ── publishing: the attestation feed on the ordinary signed event path ──────

/// The `WindowClosed` event signature (topic0 = keccak of it), pinned against
/// `cast keccak` in tests.
const SIG_WINDOW_CLOSED: &str = "WindowClosed(uint64,uint256,uint256,uint256,uint256,uint256)";

pub fn topic_window_closed() -> [u8; 32] {
    abi::keccak256(SIG_WINDOW_CLOSED.as_bytes())
}

/// One decoded `WindowClosed` log — the numbers a close mirror publishes.
pub struct WindowClose {
    pub window_id: u64,
    pub revenue: u128,
    pub buyback_share: u128,
    pub treasury_share: u128,
    pub pool: u128,
    pub carried: u128,
    pub block_number: u64,
}

/// Decode one `eth_getLogs` entry: `windowId` is the indexed topic (32-byte
/// padded); the five uint256 words ride in `data`.
pub fn decode_window_closed_log(entry: &serde_json::Value) -> Result<WindowClose, CliError> {
    let topics = entry["topics"]
        .as_array()
        .ok_or_else(|| CliError::Other("log has no topics".into()))?;
    let id_word = topics
        .get(1)
        .and_then(|t| t.as_str())
        .ok_or_else(|| CliError::Other("log has no windowId topic".into()))?
        .trim_start_matches("0x");
    let window_id = u64::from_str_radix(&id_word[id_word.len() - 16..], 16)
        .map_err(|e| CliError::Other(format!("bad windowId topic: {e}")))?;

    let data = entry["data"]
        .as_str()
        .ok_or_else(|| CliError::Other("log has no data".into()))?
        .trim_start_matches("0x");
    let bytes =
        hex::decode(data).map_err(|e| CliError::Other(format!("malformed log data: {e}")))?;
    if bytes.len() < 5 * 32 {
        return Err(CliError::Other(format!(
            "log data too short for WindowClosed: {} bytes",
            bytes.len()
        )));
    }
    let word = |i: usize| -> Result<u128, CliError> {
        abi::decode_uint256(&bytes[i * 32..i * 32 + 32]).map_err(cli_error("decode"))
    };
    let block_number = u64::from_str_radix(
        entry["blockNumber"]
            .as_str()
            .unwrap_or("0x0")
            .trim_start_matches("0x"),
        16,
    )
    .unwrap_or(0);

    Ok(WindowClose {
        window_id,
        revenue: word(0)?,
        buyback_share: word(1)?,
        treasury_share: word(2)?,
        pool: word(3)?,
        carried: word(4)?,
        block_number,
    })
}

/// Which close windows the feed ALREADY records for this distributor. The
/// mirror's multi-letter tags are not filterable over Nostr, so the query
/// narrows by kind + author and this fold filters exactly — no drift between
/// the wire and the record.
pub fn published_windows(events_json: &str, distributor: &str) -> Result<BTreeSet<u64>, CliError> {
    let parsed: serde_json::Value = serde_json::from_str(events_json)
        .map_err(|e| CliError::Other(format!("query response is not JSON: {e}")))?;
    let events = match &parsed {
        serde_json::Value::Array(v) => Some(v),
        _ => parsed["events"].as_array(),
    }
    .ok_or_else(|| CliError::Other("query response has no events".into()))?;

    let mut seen = BTreeSet::new();
    let want = distributor.trim().to_ascii_lowercase();
    for event in events {
        if event["kind"].as_u64() != Some(MIRROR_KIND_CLOSE as u64) {
            continue;
        }
        let mut ours = false;
        let mut window: Option<u64> = None;
        for tag in event["tags"]
            .as_array()
            .map(|v| v.as_slice())
            .unwrap_or(&[])
        {
            let key = tag[0].as_str().unwrap_or("");
            let value = tag[1].as_str().unwrap_or("");
            if key == "distributor" && value.to_ascii_lowercase() == want {
                ours = true;
            }
            if key == "window" {
                window = value.parse().ok();
            }
        }
        if ours {
            if let Some(w) = window {
                seen.insert(w);
            }
        }
    }
    Ok(seen)
}

/// Sign and publish one mirror template (shared by the publish commands and
/// the watcher). Returns the relay's normalized write response.
pub async fn publish_template(
    client: &BuzzClient,
    template: serde_json::Value,
    launch_author: Option<&str>,
    launch_id: Option<&str>,
    channel: Option<&str>,
) -> Result<String, CliError> {
    let builder = build_mirror_event(template, launch_author, launch_id, channel)?;
    let event = with_git_provenance(builder)?
        .sign_with_keys(client.keys())
        .map_err(|e| CliError::Other(format!("sign: {e}")))?;
    let raw = client.submit_event(event).await?;
    parse_write_response(&raw, "royalty mirror already recorded")
}

/// Assemble the signed mirror event (kind 47006/47007) from the same template
/// the local composers print, plus the NIP-LP binding tags: `a` (launch
/// coordinate `<author>:<id>`) and `h` (channel). The chain is authoritative;
/// these events are the feed's record of it.
fn build_mirror_event(
    template: serde_json::Value,
    launch_author: Option<&str>,
    launch_id: Option<&str>,
    channel: Option<&str>,
) -> Result<EventBuilder, CliError> {
    let kind = template["kind"]
        .as_u64()
        .ok_or_else(|| CliError::Other("mirror template lost its kind".into()))?
        as u16;
    let content = template["content"]
        .as_str()
        .ok_or_else(|| CliError::Other("mirror template lost its content".into()))?
        .to_owned();
    let mut builder = EventBuilder::new(Kind::Custom(kind), content);
    let tags = template["tags"]
        .as_array()
        .ok_or_else(|| CliError::Other("mirror template lost its tags".into()))?;
    for tag in tags {
        let key = tag[0]
            .as_str()
            .ok_or_else(|| CliError::Other("mirror tag is not a string".into()))?;
        let value = tag[1]
            .as_str()
            .ok_or_else(|| CliError::Other("mirror tag is not a string".into()))?;
        builder = builder
            .tag(Tag::parse([key, value]).map_err(|e| {
                CliError::Other(format!("invalid mirror tag [{key},{value}]: {e}"))
            })?);
    }
    if let (Some(author), Some(id)) = (launch_author, launch_id) {
        let coord = format!("{author}:{id}");
        builder = builder.tag(
            Tag::parse(["a", &coord])
                .map_err(|e| CliError::Other(format!("invalid launch coordinate {coord}: {e}")))?,
        );
    }
    if let Some(h) = channel {
        builder = builder.tag(
            Tag::parse(["h", h]).map_err(|e| CliError::Other(format!("invalid channel: {e}")))?,
        );
    }
    Ok(builder)
}

/// `buzz royalty publish-schedule | publish-close` — sign and publish the
/// attestation-feed mirrors through the ordinary relay path (post-auth). The
/// local-only commands run before auth and never reach here.
pub async fn dispatch(sub: crate::RoyaltyCmd, client: &BuzzClient) -> Result<(), CliError> {
    use crate::RoyaltyCmd::*;
    let (template, what, launch_author, launch_id, channel) = match sub {
        PublishSchedule {
            chain,
            distributor,
            claim_id,
            evidence_hash,
            contributor,
            weight,
            term,
            band,
            allocation,
            launch_author,
            launch_id,
            channel,
        } => {
            let distributor = distributor_addr(&distributor)?;
            (
                royalty_schedule_event_json(
                    &chain,
                    &distributor,
                    &claim_id,
                    &evidence_hash,
                    &contributor,
                    weight,
                    term,
                    band,
                    allocation,
                ),
                "schedule",
                launch_author,
                launch_id,
                channel,
            )
        }
        PublishClose {
            chain,
            distributor,
            window_id,
            revenue,
            buyback_share,
            treasury_share,
            pool,
            carried,
            launch_author,
            launch_id,
            channel,
        } => {
            let distributor = distributor_addr(&distributor)?;
            (
                royalty_close_event_json(
                    &chain,
                    &distributor,
                    window_id,
                    revenue,
                    buyback_share,
                    treasury_share,
                    pool,
                    carried,
                ),
                "close",
                launch_author,
                launch_id,
                channel,
            )
        }
        Watch {
            chain,
            distributor,
            launch_author,
            launch_id,
            channel,
            interval,
            once,
            from_block,
        } => {
            return watch_loop(
                client,
                &chain,
                &distributor_addr(&distributor)?,
                launch_author.as_deref(),
                launch_id.as_deref(),
                channel.as_deref(),
                interval.unwrap_or(30),
                once,
                from_block.unwrap_or(0),
            )
            .await
        }
        _ => {
            return Err(CliError::Usage(
                "royalty publish commands need a relay identity (they run after auth); \
                 the local commands run before it"
                    .into(),
            ))
        }
    };

    let response = publish_template(
        client,
        template,
        launch_author.as_deref(),
        launch_id.as_deref(),
        channel.as_deref(),
    )
    .await?;
    println!(
        "{}",
        json!({ "status": "ok", "what": what, "response": response })
    );
    Ok(())
}

/// The watcher: notice closed settlement windows on the distributor and
/// publish their kind:47007 close mirrors unattended — the feed accumulates
/// the revenue record with no human in the loop.
///
/// Feed-dedupe (not a local watermark) is the source of truth for "already
/// recorded", so a restart never doubles the feed; the scan cursor only
/// bounds `eth_getLogs`. Multi-letter mirror tags are not filterable over
/// Nostr, so the query narrows by kind + author and `published_windows`
/// folds exactly.
#[allow(clippy::too_many_arguments)]
async fn watch_loop(
    client: &BuzzClient,
    chain: &str,
    distributor: &str,
    launch_author: Option<&str>,
    launch_id: Option<&str>,
    channel: Option<&str>,
    interval: u64,
    once: bool,
    from_block: u64,
) -> Result<(), CliError> {
    let rpc_url = std::env::var(ENV_EVM_RPC_URL)
        .ok()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| {
            CliError::Usage(format!(
                "royalty watch is chain-side opt-in too: set {ENV_EVM_RPC_URL}"
            ))
        })?;
    let rpc: Arc<dyn EvmRpc> = Arc::new(HttpEvmRpc::new(&rpc_url).map_err(cli_error("rpc init"))?);
    let chain_client = RoyaltyClient::from_transport(rpc, distributor)?;
    let mut scan_from = from_block;

    loop {
        let raw = client
            .query(&json!({
                "kinds": [MIRROR_KIND_CLOSE],
                "authors": [client.keys().public_key().to_hex()],
                "limit": 500,
            }))
            .await?;
        let seen = published_windows(&raw, distributor)?;

        let closes = chain_client.window_closes(scan_from).await?;
        let mut published = 0u64;
        let mut next_scan = scan_from;
        for close in &closes {
            next_scan = next_scan.max(close.block_number + 1);
            if seen.contains(&close.window_id) {
                continue;
            }
            let template = royalty_close_event_json(
                chain,
                distributor,
                close.window_id,
                close.revenue,
                close.buyback_share,
                close.treasury_share,
                close.pool,
                close.carried,
            );
            let response =
                publish_template(client, template, launch_author, launch_id, channel).await?;
            published += 1;
            println!(
                "{}",
                json!({ "status": "ok", "what": "close", "window": close.window_id, "response": response })
            );
        }
        if once {
            println!(
                "{}",
                json!({ "status": "ok", "watched": closes.len(), "published": published })
            );
            return Ok(());
        }
        scan_from = next_scan;
        tokio::time::sleep(Duration::from_secs(interval.max(1))).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// Mock transport keyed by RPC method + calldata selector prefix.
    struct MockRpc {
        responses: Mutex<HashMap<String, serde_json::Value>>,
        seen: Mutex<Vec<(&'static str, serde_json::Value)>>,
    }

    impl MockRpc {
        fn new(responses: HashMap<String, serde_json::Value>) -> Self {
            Self {
                responses: Mutex::new(responses),
                seen: Mutex::new(Vec::new()),
            }
        }

        fn word(value: u128) -> String {
            format!("0x{:064x}", value)
        }
    }

    #[async_trait::async_trait]
    impl EvmRpc for MockRpc {
        async fn call(
            &self,
            method: &'static str,
            params: serde_json::Value,
            _timeout: Duration,
        ) -> Result<serde_json::Value, AllowanceError> {
            self.seen.lock().unwrap().push((method, params.clone()));
            let key = if method == "eth_call" {
                let data = params[0]["data"].as_str().unwrap_or_default();
                format!("eth_call:{}", data.get(2..10).unwrap_or(""))
            } else {
                method.to_string()
            };
            match self.responses.lock().unwrap().get(&key) {
                Some(v) => Ok(v.clone()),
                None => Err(AllowanceError::Rpc {
                    method,
                    detail: format!("mock has no response for {key}"),
                }),
            }
        }
    }

    const DISTRIBUTOR: &str = "0xcccccccccccccccccccccccccccccccccccccccc";
    const HOLDER: [u8; 20] = [0x44; 20];

    /// Selectors pinned against `cast sig` (foundry) so a keccak regression
    /// cannot silently change the wire format.
    #[test]
    fn selectors_match_cast_sig() {
        assert_eq!(hex::encode(abi::selector(SIG_CLAIM)), "4e71d92d");
        assert_eq!(hex::encode(abi::selector(SIG_SETTLE)), "11da60b4");
        assert_eq!(hex::encode(abi::selector(SIG_CLAIMABLE_OF)), "8903ab9d");
        assert_eq!(hex::encode(abi::selector(SIG_CARRY)), "f02ec765");
        assert_eq!(hex::encode(abi::selector(SIG_PENDING_REVENUE)), "f9a758e5");
        assert_eq!(hex::encode(abi::selector(SIG_NEXT_CLOSE)), "09038a56");
        assert_eq!(hex::encode(abi::selector(SIG_CLOSED_WINDOWS)), "9770c22f");
    }

    #[test]
    fn claim_and_settle_calldata_are_bare_selectors() {
        assert_eq!(encode_claim_calldata(), abi::selector(SIG_CLAIM).to_vec());
        assert_eq!(encode_settle_calldata(), abi::selector(SIG_SETTLE).to_vec());
        assert_eq!(encode_claim_calldata().len(), 4);
        assert_eq!(encode_settle_calldata().len(), 4);
    }

    /// The mirror numbers must stay in lockstep with the kind registry —
    /// removing this binding lets the feed drift off the spec.
    #[test]
    fn mirror_kinds_match_buzz_core_registry() {
        assert_eq!(
            MIRROR_KIND_SCHEDULE,
            buzz_core::kind::KIND_ROYALTY_SCHEDULE as u16
        );
        assert_eq!(
            MIRROR_KIND_CLOSE,
            buzz_core::kind::KIND_ROYALTY_CLOSE as u16
        );
    }

    #[test]
    fn schedule_mirror_shape() {
        let ev = royalty_schedule_event_json(
            "eip155:8453",
            DISTRIBUTOR,
            "0xclaim",
            "0xevidence",
            "0xcontributor",
            2,
            730 * 24 * 3600,
            2,
            500,
        );
        assert_eq!(ev["kind"], 47006);
        let tags = ev["tags"].as_array().unwrap();
        assert!(tags
            .iter()
            .any(|t| t[0] == "chain" && t[1] == "eip155:8453"));
        assert!(tags.iter().any(|t| t[0] == "claim" && t[1] == "0xclaim"));
        let content: serde_json::Value =
            serde_json::from_str(ev["content"].as_str().unwrap()).unwrap();
        assert_eq!(content["weight"], 2);
        assert_eq!(content["band"], 2);
        assert_eq!(content["allocation"], "500");
    }

    #[test]
    fn close_mirror_shape() {
        let ev = royalty_close_event_json(
            "eip155:8453",
            DISTRIBUTOR,
            7,
            10_000,
            4_000,
            2_000,
            4_000,
            0,
        );
        assert_eq!(ev["kind"], 47007);
        let content: serde_json::Value =
            serde_json::from_str(ev["content"].as_str().unwrap()).unwrap();
        assert_eq!(content["windowId"], 7);
        assert_eq!(content["revenue"], "10000");
        // Split-first invariant is visible in the mirror itself (I2).
        assert_eq!(content["buybackShare"], "4000");
        assert_eq!(content["treasuryShare"], "2000");
        assert_eq!(content["pool"], "4000");
    }

    #[tokio::test]
    async fn reads_decode_words_from_transport() {
        let sel = |sig: &str| hex::encode(abi::selector(sig));
        let mut m = HashMap::new();
        m.insert(
            format!("eth_call:{}", sel(SIG_CLAIMABLE_OF)),
            serde_json::Value::String(MockRpc::word(4_000)),
        );
        m.insert(
            format!("eth_call:{}", sel(SIG_CARRY)),
            serde_json::Value::String(MockRpc::word(111)),
        );
        m.insert(
            format!("eth_call:{}", sel(SIG_NEXT_CLOSE)),
            serde_json::Value::String(MockRpc::word(1_780_000_000)),
        );
        let client =
            RoyaltyClient::from_transport(Arc::new(MockRpc::new(m)), DISTRIBUTOR).expect("client");
        assert_eq!(client.claimable_of(HOLDER).await.unwrap(), 4_000);
        assert_eq!(client.carry().await.unwrap(), 111);
        assert_eq!(client.next_close().await.unwrap(), 1_780_000_000);
    }

    /// The publish path's event keeps every template tag and gains the
    /// NIP-LP bindings — the feed record a reader joins to the launch.
    #[test]
    fn publish_event_shape_binds_launch_and_channel() {
        let template = royalty_close_event_json(
            "eip155:8453",
            DISTRIBUTOR,
            7,
            10_000,
            4_000,
            2_000,
            4_000,
            0,
        );
        let author = "ab".repeat(32);
        let builder =
            build_mirror_event(template, Some(&author), Some("my-launch"), Some("chan-1"))
                .expect("event");
        let event = builder
            .sign_with_keys(&nostr::Keys::generate())
            .expect("sign");
        assert_eq!(event.kind, Kind::Custom(MIRROR_KIND_CLOSE));
        let tags: Vec<Vec<&str>> = event
            .tags
            .iter()
            .map(|t| t.as_slice().iter().map(|s| s.as_str()).collect())
            .collect();
        assert!(tags
            .iter()
            .any(|t| t == &vec!["a", &format!("{author}:my-launch")]));
        assert!(tags.iter().any(|t| t == &vec!["h", "chan-1"]));
        assert!(tags.iter().any(|t| t == &vec!["window", "7"]));
        assert!(tags.iter().any(|t| t == &vec!["chain", "eip155:8453"]));
        let content: serde_json::Value = serde_json::from_str(&event.content).unwrap();
        assert_eq!(content["revenue"], "10000");
    }

    #[test]
    fn publish_event_without_bindings_has_no_a_or_h() {
        let template = royalty_schedule_event_json(
            "eip155:8453",
            DISTRIBUTOR,
            "0xclaim",
            "0xevidence",
            "0xwho",
            1,
            2,
            3,
            4,
        );
        let builder = build_mirror_event(template, None, None, None).expect("event");
        let event = builder
            .sign_with_keys(&nostr::Keys::generate())
            .expect("sign");
        assert_eq!(event.kind, Kind::Custom(MIRROR_KIND_SCHEDULE));
        assert!(event.tags.iter().all(|t| t.as_slice()[0] != "a"));
        assert!(event.tags.iter().all(|t| t.as_slice()[0] != "h"));
    }

    /// Topic0 pinned against `cast keccak` so a signature drift breaks here.
    #[test]
    fn window_closed_topic_matches_cast_keccak() {
        assert_eq!(
            hex::encode(topic_window_closed()),
            "971f1c8730011a05d9d156472bea7693be14d42ac85c2c8e87a90e0ce494aa61"
        );
    }

    fn word_hex(v: u128) -> String {
        format!("{v:064x}")
    }

    fn sample_log(window: u64) -> serde_json::Value {
        serde_json::json!({
            "topics": [
                format!("0x{}", hex::encode(topic_window_closed())),
                format!("0x{window:064x}"),
            ],
            "data": format!(
                "0x{}{}{}{}{}",
                word_hex(10_000),
                word_hex(4_000),
                word_hex(2_000),
                word_hex(4_000),
                word_hex(0)
            ),
            "blockNumber": "0x2a",
        })
    }

    #[test]
    fn decode_window_closed_log_reads_topic_and_words() {
        let close = decode_window_closed_log(&sample_log(7)).expect("decode");
        assert_eq!(close.window_id, 7);
        assert_eq!(close.revenue, 10_000);
        assert_eq!(close.buyback_share, 4_000);
        assert_eq!(close.treasury_share, 2_000);
        assert_eq!(close.pool, 4_000);
        assert_eq!(close.carried, 0);
        assert_eq!(close.block_number, 42);
    }

    #[test]
    fn published_windows_folds_both_feed_shapes() {
        let event = |window: u64, dist: &str, kind: u32| {
            serde_json::json!({
                "kind": kind,
                "tags": [["distributor", dist], ["window", window.to_string()]],
            })
        };
        let mine = event(3, "0xAbCd", MIRROR_KIND_CLOSE as u32);
        let other = event(9, "0x1111", MIRROR_KIND_CLOSE as u32);
        let wrong_kind = event(4, "0xAbCd", MIRROR_KIND_SCHEDULE as u32);

        // Bare array shape.
        let bare = serde_json::json!([mine.clone(), other.clone(), wrong_kind]).to_string();
        let seen = published_windows(&bare, "0xabcd").expect("bare");
        assert_eq!(seen.iter().copied().collect::<Vec<_>>(), vec![3]);

        // Wrapped {events:[...]} shape.
        let wrapped =
            serde_json::json!({ "events": [mine, event(5, "0xABCD", MIRROR_KIND_CLOSE as u32)] })
                .to_string();
        let seen = published_windows(&wrapped, "0xabcd").expect("wrapped");
        assert_eq!(seen.iter().copied().collect::<Vec<_>>(), vec![3, 5]);
    }

    /// The watcher's chain read: `eth_getLogs` narrowed by address + topic0.
    #[tokio::test]
    async fn window_closes_fetches_logs_by_topic() {
        let mut m = HashMap::new();
        m.insert(
            "eth_getLogs".to_string(),
            serde_json::json!([sample_log(1), sample_log(2)]),
        );
        let client =
            RoyaltyClient::from_transport(Arc::new(MockRpc::new(m)), DISTRIBUTOR).expect("client");
        let closes = client.window_closes(0).await.expect("logs");
        assert_eq!(closes.len(), 2);
        assert_eq!(closes[0].window_id, 1);
        assert_eq!(closes[1].pool, 4_000);
    }
}
