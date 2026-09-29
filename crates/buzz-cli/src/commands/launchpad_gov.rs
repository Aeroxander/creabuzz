//! `buzz launchpad propose|vote|process|proposal-state` — the majeur
//! governance loop (docs/agentic-governance-design.md, S1).
//!
//! Chain-local (EVM value layer; no relay, no Nostr key) like `org ragequit`.
//! Majeur proposals are ID-HASHED OPERATIONS: the identity is
//! `proposalId(op, to, value, data, nonce)` read from the DAO itself (the id
//! binds `config`, which is how `bumpConfig` emergency-invalidates). The CLI
//! resolves the id via that view — `vote-tx.ts` computes the same id offline
//! for the UI, and `contracts/script/JourneyGov.s.sol` pins their equality.
//!
//! Lifecycle: `openProposal(id)` -> `castVote(id, support)` (1 for / 0
//! against / 2 abstain) -> `queue(id)` -> `executeByVotes(op, to, value,
//! data, nonce)`. Bounded resources mirror `org_ragequit`: explicit RPC
//! timeouts, hard gas caps, receipt deadlines; `EvmRpc` is the mock seam.

use std::sync::Arc;
use std::time::Duration;

use buzz_evm_allowance::{abi, AllowanceClient, AllowanceError, EvmRpc, HttpEvmRpc};
use num_bigint::BigUint;
use serde_json::json;

use crate::error::CliError;

use super::org::{validate_eth_address, ENV_EVM_RPC_URL, ENV_SPENDER_KEY};

const RPC_TIMEOUT: Duration = buzz_evm_allowance::DEFAULT_RPC_TIMEOUT;
const RECEIPT_DEADLINE: Duration = buzz_evm_allowance::DEFAULT_RECEIPT_DEADLINE;

// Selectors computed from canonical signatures at runtime; tests pin them
// against `cast sig` (the same pins as web `vote-tx.ts`).
const SIG_OPEN_PROPOSAL: &str = "openProposal(uint256)";
const SIG_CAST_VOTE: &str = "castVote(uint256,uint8)";
const SIG_EXECUTE_BY_VOTES: &str = "executeByVotes(uint8,address,uint256,bytes,bytes32)";
const SIG_PROPOSAL_ID: &str = "proposalId(uint8,address,uint256,bytes,bytes32)";
const SIG_STATE: &str = "state(uint256)";

/// `ProposalState` labels in majeur's declaration order (D6 copy).
const STATES: [&str; 7] = [
    "Unopened",
    "Active",
    "Queued",
    "Succeeded",
    "Defeated",
    "Expired",
    "Executed",
];

fn cli_error(context: &'static str) -> impl Fn(AllowanceError) -> CliError {
    move |e| CliError::Other(format!("{context}: {e}"))
}

/// One 32-byte word from a decimal or `0x`-hex integer string (proposal ids
/// are full uint256 hashes and do not fit narrower types).
pub fn uint256_word(value: &str) -> Result<[u8; 32], CliError> {
    let trimmed = value.trim();
    let big = if let Some(hex) = trimmed.strip_prefix("0x") {
        if hex.is_empty() || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(CliError::Usage(format!("not a hex integer: {value:?}")));
        }
        BigUint::parse_bytes(hex.as_bytes(), 16)
    } else {
        if trimmed.is_empty() || !trimmed.bytes().all(|b| b.is_ascii_digit()) {
            return Err(CliError::Usage(format!("not a decimal integer: {value:?}")));
        }
        BigUint::parse_bytes(trimmed.as_bytes(), 10)
    }
    .ok_or_else(|| CliError::Usage(format!("cannot parse integer: {value:?}")))?;
    if big.bits() > 256 {
        return Err(CliError::Usage(format!("uint256 overflow: {value:?}")));
    }
    let hexed = format!("{big:064x}");
    let mut out = [0u8; 32];
    out.copy_from_slice(&hex::decode(hexed).map_err(|e| CliError::Other(format!("word: {e}")))?);
    Ok(out)
}

/// Parse `for|against|abstain` to majeur's support word (1 / 0 / 2).
pub fn support_word(support: &str) -> Result<u8, CliError> {
    match support.trim().to_ascii_lowercase().as_str() {
        "for" => Ok(1),
        "against" => Ok(0),
        "abstain" => Ok(2),
        other => Err(CliError::Usage(format!(
            "support must be for | against | abstain (got {other:?})"
        ))),
    }
}

/// ABI-encode the shared `(op, to, value, data, nonce)` intent arguments —
/// identical layout for `proposalId(...)` and `executeByVotes(...)`. Head:
/// op, to, value, offset 0xa0, nonce; tail: data length + right-padded bytes.
pub fn encode_intent_args(
    op: u8,
    to: &str,
    value: &str,
    data: &str,
    nonce: &str,
) -> Result<Vec<u8>, CliError> {
    let to = abi::parse_address(&validate_eth_address(to, "to address")?)
        .map_err(cli_error("bad to address"))?;
    let value_word = uint256_word(value)?;
    let data_bytes = {
        let clean = data.trim();
        let hex = clean.strip_prefix("0x").unwrap_or(clean);
        if !hex.bytes().all(|b| b.is_ascii_hexdigit()) || !hex.len().is_multiple_of(2) {
            return Err(CliError::Usage(format!(
                "data must be even-length hex: {data:?}"
            )));
        }
        hex::decode(hex).map_err(|e| CliError::Usage(format!("data: {e}")))?
    };
    let nonce_word = uint256_word(nonce)?;

    let mut out = Vec::with_capacity(5 * 32 + 32 + data_bytes.len() + 32);
    out.extend_from_slice(&abi::encode_uint256(op as u128));
    out.extend_from_slice(&abi::encode_address_word(&to));
    out.extend_from_slice(&value_word);
    out.extend_from_slice(&abi::encode_uint256(0xa0));
    out.extend_from_slice(&nonce_word);
    // tail: length + right-padded bytes
    let padded = data_bytes.len().div_ceil(32) * 32;
    out.extend_from_slice(&abi::encode_uint256(data_bytes.len() as u128));
    out.extend_from_slice(&data_bytes);
    out.resize(out.len() - data_bytes.len() + padded, 0);
    Ok(out)
}

/// `openProposal(uint256)`.
pub fn encode_open_proposal(id: &str) -> Result<Vec<u8>, CliError> {
    let mut out = abi::selector(SIG_OPEN_PROPOSAL).to_vec();
    out.extend_from_slice(&uint256_word(id)?);
    Ok(out)
}

/// `castVote(uint256,uint8)`.
pub fn encode_cast_vote(id: &str, support: u8) -> Result<Vec<u8>, CliError> {
    if support > 2 {
        return Err(CliError::Usage(format!(
            "support must be 0, 1, or 2: {support}"
        )));
    }
    let mut out = abi::selector(SIG_CAST_VOTE).to_vec();
    out.extend_from_slice(&uint256_word(id)?);
    out.extend_from_slice(&abi::encode_uint256(support as u128));
    Ok(out)
}

/// `executeByVotes(op, to, value, data, nonce)`.
pub fn encode_execute_by_votes(
    op: u8,
    to: &str,
    value: &str,
    data: &str,
    nonce: &str,
) -> Result<Vec<u8>, CliError> {
    let mut out = abi::selector(SIG_EXECUTE_BY_VOTES).to_vec();
    out.extend_from_slice(&encode_intent_args(op, to, value, data, nonce)?);
    Ok(out)
}

/// The bounded read/write client over the shared value-layer transport.
pub struct GovClient {
    rpc: Arc<dyn EvmRpc>,
    dao: [u8; 20],
    rpc_timeout: Duration,
}

impl GovClient {
    pub fn new_http(rpc_url: &str, dao: &str) -> Result<Self, CliError> {
        let rpc: Arc<dyn EvmRpc> =
            Arc::new(HttpEvmRpc::new(rpc_url).map_err(cli_error("rpc init"))?);
        Self::from_transport(rpc, dao)
    }

    pub fn from_transport(rpc: Arc<dyn EvmRpc>, dao: &str) -> Result<Self, CliError> {
        let dao = abi::parse_address(&validate_eth_address(dao, "dao address")?)
            .map_err(cli_error("bad dao address"))?;
        Ok(Self {
            rpc,
            dao,
            rpc_timeout: RPC_TIMEOUT,
        })
    }

    pub fn dao_hex(&self) -> String {
        format!("0x{}", hex::encode(self.dao))
    }

    async fn call_word(&self, data: &[u8]) -> Result<u128, CliError> {
        let params = json!([
            { "to": self.dao_hex(), "data": format!("0x{}", hex::encode(data)) },
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

    /// `proposalId(op, to, value, data, nonce)` — the authoritative id (it
    /// binds `config`).
    pub async fn proposal_id(
        &self,
        op: u8,
        to: &str,
        value: &str,
        data: &str,
        nonce: &str,
    ) -> Result<String, CliError> {
        let mut call = abi::selector(SIG_PROPOSAL_ID).to_vec();
        call.extend_from_slice(&encode_intent_args(op, to, value, data, nonce)?);
        let params = json!([
            { "to": self.dao_hex(), "data": format!("0x{}", hex::encode(&call)) },
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
        Ok(format!("0x{}", hex_str.trim().trim_start_matches("0x")))
    }

    /// `state(id)` -> the label from `STATES` (D6 copy).
    pub async fn state(&self, id: &str) -> Result<&'static str, CliError> {
        let mut call = abi::selector(SIG_STATE).to_vec();
        call.extend_from_slice(&uint256_word(id)?);
        let word = self.call_word(&call).await?;
        STATES
            .get(word as usize)
            .copied()
            .ok_or_else(|| CliError::Other(format!("unknown ProposalState: {word}")))
    }

    async fn send(
        &self,
        spender: &k256::ecdsa::SigningKey,
        data: &[u8],
        what: &str,
    ) -> Result<String, CliError> {
        let tx_client = AllowanceClient::from_transport(self.rpc.clone(), &self.dao_hex())
            .map_err(cli_error("tx client"))?
            .with_rpc_timeout(self.rpc_timeout)
            .with_receipt_deadline(RECEIPT_DEADLINE);
        let receipt = tx_client
            .send_contract_tx(spender, data)
            .await
            .map_err(|e| match e {
                AllowanceError::SpendRejectedByContract { detail } => CliError::Other(format!(
                    "the DAO refused {what} at simulation; nothing was broadcast: {detail}"
                )),
                AllowanceError::SpendReverted { tx_hash } => {
                    CliError::Other(format!("{what} transaction {tx_hash} reverted onchain"))
                }
                AllowanceError::SpendUnconfirmed { .. } => CliError::Other(format!(
                    "{what} not confirmed within the deadline — check the receipt; \
                     do NOT re-submit blindly"
                )),
                other => CliError::Other(format!("{what} failed: {other}")),
            })?;
        Ok(receipt.tx_hash)
    }

    pub async fn open_proposal(
        &self,
        spender: &k256::ecdsa::SigningKey,
        id: &str,
    ) -> Result<String, CliError> {
        self.send(spender, &encode_open_proposal(id)?, "openProposal")
            .await
    }

    pub async fn cast_vote(
        &self,
        spender: &k256::ecdsa::SigningKey,
        id: &str,
        support: u8,
    ) -> Result<String, CliError> {
        self.send(spender, &encode_cast_vote(id, support)?, "castVote")
            .await
    }

    pub async fn execute_by_votes(
        &self,
        spender: &k256::ecdsa::SigningKey,
        op: u8,
        to: &str,
        value: &str,
        data: &str,
        nonce: &str,
    ) -> Result<String, CliError> {
        self.send(
            spender,
            &encode_execute_by_votes(op, to, value, data, nonce)?,
            "executeByVotes",
        )
        .await
    }
}

// ── CLI commands ────────────────────────────────────────────────────────────

fn load_chain() -> Result<(String, k256::ecdsa::SigningKey), CliError> {
    let rpc_url = std::env::var(ENV_EVM_RPC_URL)
        .ok()
        .filter(|v| !v.is_empty());
    let spender_key = std::env::var(ENV_SPENDER_KEY)
        .ok()
        .filter(|v| !v.is_empty());
    let (Some(rpc_url), Some(spender_key)) = (rpc_url, spender_key) else {
        return Err(CliError::Usage(format!(
            "launchpad governance commands are opt-in: set {ENV_EVM_RPC_URL} and {ENV_SPENDER_KEY}"
        )));
    };
    let clean = spender_key.trim().trim_start_matches("0x");
    let key_bytes = hex::decode(clean)
        .map_err(|e| CliError::Usage(format!("invalid {ENV_SPENDER_KEY} hex: {e}")))?;
    let spender = k256::ecdsa::SigningKey::from_slice(&key_bytes)
        .map_err(|e| CliError::Usage(format!("invalid {ENV_SPENDER_KEY}: {e}")))?;
    Ok((rpc_url, spender))
}

/// `buzz launchpad propose` — open the proposal (prints its id for `vote`).
pub async fn cmd_propose(
    dao: &str,
    op: u8,
    to: &str,
    value: &str,
    data: &str,
    nonce: &str,
) -> Result<(), CliError> {
    let (rpc_url, spender) = load_chain()?;
    let client = GovClient::new_http(&rpc_url, dao)?;
    let id = client.proposal_id(op, to, value, data, nonce).await?;
    let tx_hash = client.open_proposal(&spender, &id).await?;
    println!(
        "{}",
        json!({ "status": "ok", "txHash": tx_hash, "dao": client.dao_hex(), "id": id })
    );
    Ok(())
}

/// `buzz launchpad vote` — cast for | against | abstain.
pub async fn cmd_vote(dao: &str, id: &str, support: &str) -> Result<(), CliError> {
    let (rpc_url, spender) = load_chain()?;
    let client = GovClient::new_http(&rpc_url, dao)?;
    let support = support_word(support)?;
    let tx_hash = client.cast_vote(&spender, id, support).await?;
    println!(
        "{}",
        json!({ "status": "ok", "txHash": tx_hash, "dao": client.dao_hex(), "id": id, "support": support })
    );
    Ok(())
}

/// `buzz launchpad process` — execute after votes + timelock.
pub async fn cmd_process(
    dao: &str,
    op: u8,
    to: &str,
    value: &str,
    data: &str,
    nonce: &str,
) -> Result<(), CliError> {
    let (rpc_url, spender) = load_chain()?;
    let client = GovClient::new_http(&rpc_url, dao)?;
    let id = client.proposal_id(op, to, value, data, nonce).await?;
    let tx_hash = client
        .execute_by_votes(&spender, op, to, value, data, nonce)
        .await?;
    println!(
        "{}",
        json!({ "status": "ok", "txHash": tx_hash, "dao": client.dao_hex(), "id": id })
    );
    Ok(())
}

/// `buzz launchpad proposal-state` — the state label (D6 input).
pub async fn cmd_proposal_state(dao: &str, id: &str) -> Result<(), CliError> {
    let rpc_url = std::env::var(ENV_EVM_RPC_URL)
        .ok()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| {
            CliError::Usage(format!(
                "proposal-state reads the chain: set {ENV_EVM_RPC_URL}"
            ))
        })?;
    let client = GovClient::new_http(&rpc_url, dao)?;
    let state = client.state(id).await?;
    println!(
        "{}",
        json!({ "dao": client.dao_hex(), "id": id, "state": state })
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// Mock transport keyed by RPC method + calldata selector prefix.
    struct MockRpc {
        responses: Mutex<HashMap<String, serde_json::Value>>,
    }

    impl MockRpc {
        fn new(responses: HashMap<String, serde_json::Value>) -> Self {
            Self {
                responses: Mutex::new(responses),
            }
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

    const DAO: &str = "0x00000000000000000000000000000000000000Aa";
    const TO: &str = "0x000000000000000000000000000000000000dEaD";

    /// Selectors pinned against `cast sig`.
    #[test]
    fn selectors_match_cast_sig() {
        assert_eq!(hex::encode(abi::selector(SIG_OPEN_PROPOSAL)), "31288f40");
        assert_eq!(hex::encode(abi::selector(SIG_CAST_VOTE)), "56781388");
        // `queue(uint256)` is part of the documented lifecycle but has no CLI
        // command yet (that subcommand belongs in `lib.rs`); the pin stays so
        // the future `launchpad queue` step cannot drift from `cast sig`.
        assert_eq!(hex::encode(abi::selector("queue(uint256)")), "ddf0b009");
        assert_eq!(hex::encode(abi::selector(SIG_EXECUTE_BY_VOTES)), "ee5b2895");
        assert_eq!(hex::encode(abi::selector(SIG_PROPOSAL_ID)), "997506ba");
        assert_eq!(hex::encode(abi::selector(SIG_STATE)), "3e4f49e6");
    }

    /// The dynamic-bytes layout must match web `vote-tx.ts` byte for byte
    /// (its `cast calldata` golden is the shared vector).
    #[test]
    fn execute_by_votes_matches_the_cast_golden() {
        let data = encode_execute_by_votes(
            0,
            TO,
            "0",
            "0x123456",
            "0x1111111111111111111111111111111111111111111111111111111111111111",
        )
        .unwrap();
        assert_eq!(
            format!("0x{}", hex::encode(&data)),
            "0xee5b28950000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000dead000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a0111111111111111111111111111111111111111111111111111111111111111100000000000000000000000000000000000000000000000000000000000000031234560000000000000000000000000000000000000000000000000000000000"
        );
    }

    #[test]
    fn words_and_support_parse() {
        // Decimal and hex spellings of the same integer produce one word.
        let from_dec = uint256_word("255").unwrap();
        let from_hex = uint256_word("0xff").unwrap();
        assert_eq!(from_dec, from_hex);
        assert_eq!(uint256_word("1").unwrap()[31], 1);
        // Full-width proposal ids (uint256 hashes) fit.
        assert!(uint256_word(&format!("0x{}", "ff".repeat(32))).is_ok());
        assert!(uint256_word("0x").is_err());
        assert!(uint256_word("not-a-number").is_err());
        assert_eq!(support_word("For").unwrap(), 1);
        assert_eq!(support_word("against").unwrap(), 0);
        assert_eq!(support_word("abstain").unwrap(), 2);
        assert!(support_word("yes").is_err());
    }

    #[test]
    fn open_and_vote_calldata_shape() {
        let one = format!("0x{}1", "0".repeat(63));
        let open = encode_open_proposal(&one).unwrap();
        assert_eq!(&open[..4], &abi::selector(SIG_OPEN_PROPOSAL));
        assert_eq!(open.len(), 36);
        let vote = encode_cast_vote(&one, 1).unwrap();
        assert_eq!(&vote[..4], &abi::selector(SIG_CAST_VOTE));
        assert_eq!(vote.len(), 68);
    }

    /// The state read maps majeur's enum order to the D6 labels.
    #[tokio::test]
    async fn state_labels_follow_the_enum_order() {
        let mut m = HashMap::new();
        m.insert(
            format!("eth_call:{}", hex::encode(abi::selector(SIG_STATE))),
            serde_json::Value::String(format!("0x{:064x}", 3)),
        );
        let client = GovClient::from_transport(Arc::new(MockRpc::new(m)), DAO).expect("client");
        assert_eq!(
            client
                .state(&format!("0x{}", "0".repeat(63)))
                .await
                .unwrap(),
            "Succeeded"
        );
    }
}
