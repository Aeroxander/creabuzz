//! `buzz org ragequit` — the exit right on a bound DAO (NIP-ORG "Opt-in
//! onchain binding").
//!
//! Calls `ragequit(address[] tokens, uint256 sharesToBurn, uint256
//! lootToBurn)` on the Moloch-family DAO the org root is bound to (the
//! vendored `majeur` contracts). Tokens MUST be passed ascending-sorted and
//! must not include the shares/loot/DAO addresses; zero shares+loot reverts.
//!
//! # DEV identity mapping (documented simplification)
//!
//! The mapping "which Nostr holder owns which EVM share balance" is a
//! protocol question (governance/DAO-proposal upgrade later). This command
//! implements the DEV mapping: the configured value-layer spender key
//! (`BUZZ_SPENDER_KEY`) IS the shareholder. The desktop affordance states
//! the same simplification inline. Production handover replaces this with
//! the DAO's own member registry — never auto-mutations of share supply.
//!
//! # Bounded resources
//!
//! Reuses the allowance client seam (`buzz-evm-allowance`): every RPC
//! round-trip carries an explicit timeout, gas is hard-capped
//! (`tx::MAX_GAS`), the receipt wait has a deadline, and a node-reported
//! hash that mismatches what we signed aborts the command. No network in
//! unit tests — the `EvmRpc` trait is the mock seam.

use std::sync::Arc;
use std::time::Duration;

use buzz_evm_allowance::tx;
use buzz_evm_allowance::{abi, AllowanceClient, AllowanceError, EvmRpc, HttpEvmRpc};
use serde_json::json;

use crate::error::CliError;

use super::org::{validate_eth_address, ENV_EVM_RPC_URL, ENV_SPENDER_KEY};

/// Per-RPC round-trip ceiling (mirrors the allowance client default).
const RPC_TIMEOUT: Duration = buzz_evm_allowance::DEFAULT_RPC_TIMEOUT;
/// Receipt-wait deadline (mirrors the allowance client default).
const RECEIPT_DEADLINE: Duration = buzz_evm_allowance::DEFAULT_RECEIPT_DEADLINE;

// Selectors are computed from canonical signatures at runtime (same
// approach as `buzz-evm-allowance::abi`); the tests pin them against
// `cast sig` output.
const SIG_RAGEQUIT: &str = "ragequit(address[],uint256,uint256)";
const SIG_SHARES: &str = "shares()";
const SIG_LOOT: &str = "loot()";
const SIG_BALANCE_OF: &str = "balanceOf(address)";
const SIG_RAGEQUITTABLE: &str = "ragequittable()";

/// The ETH sentinel token address — ragequit pays ETH pro-rata for it.
pub const ETH_TOKEN: [u8; 20] = [0u8; 20];

/// ABI-encode `ragequit(address[],uint256,uint256)`.
///
/// Layout: selector, head-words [offset=0x60, sharesToBurn, lootToBurn],
/// then the array tail [length, token word × N]. The caller sorts and
/// dedupes tokens (`sorted_unique_tokens`); the contract reverts on an
/// unsorted array, so the encoding order is load-bearing.
pub fn encode_ragequit_calldata(
    tokens: &[[u8; 20]],
    shares_to_burn: u128,
    loot_to_burn: u128,
) -> Vec<u8> {
    let n = tokens.len();
    let mut out = Vec::with_capacity(4 + 3 * 32 + (n + 1) * 32);
    out.extend_from_slice(&abi::selector(SIG_RAGEQUIT));
    out.extend_from_slice(&abi::encode_uint256(0x60));
    out.extend_from_slice(&abi::encode_uint256(shares_to_burn));
    out.extend_from_slice(&abi::encode_uint256(loot_to_burn));
    out.extend_from_slice(&abi::encode_uint256(n as u128));
    for token in tokens {
        out.extend_from_slice(&abi::encode_address_word(token));
    }
    out
}

/// Sort tokens ascending and drop duplicates — the ragequit pre-condition
/// the contract enforces (`tk <= prev` reverts).
pub fn sorted_unique_tokens(mut tokens: Vec<[u8; 20]>) -> Vec<[u8; 20]> {
    tokens.sort_unstable();
    tokens.dedup();
    tokens
}

/// A minimal Moloch-family read/write client over the shared value-layer
/// transport. Writes go through [`AllowanceClient::send_contract_tx`] with
/// the DAO as the target — the exact bounded-gas, timed-receipt seam the
/// spend guard uses.
pub struct MolochClient {
    rpc: Arc<dyn EvmRpc>,
    /// The bound DAO contract (ragequit target).
    dao: [u8; 20],
    rpc_timeout: Duration,
}

impl MolochClient {
    /// Build a client against `dao` reachable at `rpc`. With no transport
    /// injection it constructs the HTTP transport itself.
    pub fn new_http(rpc_url: &str, dao: &str) -> Result<Self, CliError> {
        let rpc: Arc<dyn EvmRpc> =
            Arc::new(HttpEvmRpc::new(rpc_url).map_err(cli_error("rpc init"))?);
        Self::from_transport(rpc, dao)
    }

    /// Build over an injected transport (tests — the network is never
    /// touched by unit tests).
    pub fn from_transport(rpc: Arc<dyn EvmRpc>, dao: &str) -> Result<Self, CliError> {
        let dao = abi::parse_address(dao).map_err(cli_error("bad dao address"))?;
        Ok(Self {
            rpc,
            dao,
            rpc_timeout: RPC_TIMEOUT,
        })
    }

    /// The DAO address, `0x`-prefixed lowercase.
    pub fn dao_hex(&self) -> String {
        format!("0x{}", hex::encode(self.dao))
    }

    /// One `eth_call` view read decoded as a single 32-byte word.
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

    /// One `eth_call` view read decoded as a 20-byte address.
    async fn call_address(&self, data: &[u8]) -> Result<[u8; 20], CliError> {
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
        let word: [u8; 32] = bytes[..32]
            .try_into()
            .map_err(|_| CliError::Other("word slice mismatch".into()))?;
        word[12..]
            .try_into()
            .map_err(|_| CliError::Other("address slice mismatch".into()))
    }

    async fn call_bool(&self, data: &[u8]) -> Result<bool, CliError> {
        Ok(self.call_word(data).await? != 0)
    }

    fn selector_data(sig: &str) -> Vec<u8> {
        abi::selector(sig).to_vec()
    }

    /// The DAO's shares token (for balances and the member view).
    pub async fn shares_token(&self) -> Result<[u8; 20], CliError> {
        self.call_address(&Self::selector_data(SIG_SHARES)).await
    }

    /// The DAO's loot token.
    pub async fn loot_token(&self) -> Result<[u8; 20], CliError> {
        self.call_address(&Self::selector_data(SIG_LOOT)).await
    }

    /// Whether the DAO allows ragequit at all (`ragequittable()`).
    pub async fn ragequittable(&self) -> Result<bool, CliError> {
        self.call_bool(&Self::selector_data(SIG_RAGEQUITTABLE))
            .await
    }

    /// `balanceOf(owner)` on an ERC-20 token contract (shares, loot, or a
    /// treasury asset).
    pub async fn balance_of(&self, token: [u8; 20], owner: [u8; 20]) -> Result<u128, CliError> {
        let mut data = abi::selector(SIG_BALANCE_OF).to_vec();
        data.extend_from_slice(&abi::encode_address_word(&owner));
        let params = json!([
            {
                "to": format!("0x{}", hex::encode(token)),
                "data": format!("0x{}", hex::encode(&data)),
            },
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
                "balanceOf result too short for a word: {} bytes",
                bytes.len()
            )));
        }
        abi::decode_uint256(&bytes[..32]).map_err(cli_error("decode"))
    }

    /// Broadcast `ragequit` from `spender` and wait, bounded, for the
    /// receipt. Goes through the allowance client's shared send path:
    /// EIP-155 signing, hard gas cap, simulation-revert detection, and a
    /// receipt deadline.
    pub async fn ragequit(
        &self,
        spender: &k256::ecdsa::SigningKey,
        tokens: &[[u8; 20]],
        shares_to_burn: u128,
        loot_to_burn: u128,
    ) -> Result<String, CliError> {
        let tx_client = AllowanceClient::from_transport(self.rpc.clone(), &self.dao_hex())
            .map_err(cli_error("tx client"))?
            .with_rpc_timeout(self.rpc_timeout)
            .with_receipt_deadline(RECEIPT_DEADLINE);
        let data = encode_ragequit_calldata(tokens, shares_to_burn, loot_to_burn);
        let receipt = tx_client
            .send_contract_tx(spender, &data)
            .await
            .map_err(|e| match e {
                AllowanceError::SpendRejectedByContract { detail } => CliError::Other(format!(
                    "the DAO refused the ragequit at simulation; nothing was broadcast: {detail}"
                )),
                AllowanceError::SpendReverted { tx_hash } => CliError::Other(format!(
                    "ragequit transaction {tx_hash} reverted onchain; no shares were burned"
                )),
                AllowanceError::SpendUnconfirmed {
                    tx_hash,
                    deadline_ms,
                } => CliError::Other(format!(
                    "ragequit transaction {tx_hash} not confirmed within {deadline_ms}ms; \
                     check the receipt before assuming an exit — do NOT re-submit blindly"
                )),
                other => CliError::Other(format!("ragequit failed: {other}")),
            })?;
        Ok(receipt.tx_hash)
    }

    /// The remainingOf-style member view: post-exit holdings of the
    /// spender in the DAO's shares and loot tokens. Read from the DAO's
    /// own token registry (MolochViewHelper-style member view, reduced to
    /// the balances an exit changes).
    pub async fn member_view(&self, holder: [u8; 20]) -> Result<MemberView, CliError> {
        let shares_token = self.shares_token().await?;
        let loot_token = self.loot_token().await?;
        let shares = self.balance_of(shares_token, holder).await?;
        let loot = self.balance_of(loot_token, holder).await?;
        Ok(MemberView {
            dao: self.dao_hex(),
            shares_token: format!("0x{}", hex::encode(shares_token)),
            loot_token: format!("0x{}", hex::encode(loot_token)),
            shares,
            loot,
        })
    }
}

/// Post-exit holdings view (printed as JSON by the CLI).
pub struct MemberView {
    pub dao: String,
    pub shares_token: String,
    pub loot_token: String,
    pub shares: u128,
    pub loot: u128,
}

fn cli_error(context: &'static str) -> impl Fn(AllowanceError) -> CliError {
    move |e| CliError::Other(format!("{context}: {e}"))
}

// ── CLI command ────────────────────────────────────────────────────────────

/// Parse one `--token` argument; `0x000…0` means ETH (the contract's
/// native-asset sentinel). Returns the lowercase 20-byte address.
pub fn parse_token_address(s: &str) -> Result<[u8; 20], CliError> {
    let addr = validate_eth_address(s, "token address")?;
    abi::parse_address(&addr).map_err(cli_error("bad token address"))
}

/// `buzz org ragequit` — local-only (no relay, no Nostr key): the EVM
/// value-layer exit. Opt-in via env; with `BUZZ_EVM_RPC_URL` /
/// `BUZZ_SPENDER_KEY` unset this is a usage error that names the seam.
pub async fn cmd_ragequit(
    dao: &str,
    shares: Option<u128>,
    tokens: Vec<String>,
) -> Result<(), CliError> {
    let rpc_url = std::env::var(ENV_EVM_RPC_URL)
        .ok()
        .filter(|v| !v.is_empty());
    let spender_key = std::env::var(ENV_SPENDER_KEY)
        .ok()
        .filter(|v| !v.is_empty());
    let (Some(rpc_url), Some(spender_key)) = (rpc_url, spender_key) else {
        return Err(CliError::Usage(format!(
            "ragequit is opt-in: set {ENV_EVM_RPC_URL} and {ENV_SPENDER_KEY} to enable it. \
             DEV mapping: the {ENV_SPENDER_KEY} value-layer key IS the shareholder"
        )));
    };

    let dao_addr = validate_eth_address(dao, "dao address")?;
    let clean_key = spender_key.trim().trim_start_matches("0x");
    let key_bytes = hex::decode(clean_key)
        .map_err(|e| CliError::Usage(format!("invalid {ENV_SPENDER_KEY} hex: {e}")))?;
    let spender = k256::ecdsa::SigningKey::from_slice(&key_bytes)
        .map_err(|e| CliError::Usage(format!("invalid {ENV_SPENDER_KEY}: {e}")))?;
    let holder = tx::address_from_key(&spender);

    let mut token_addrs: Vec<[u8; 20]> = if tokens.is_empty() {
        vec![ETH_TOKEN] // default: withdraw the ETH share
    } else {
        tokens
            .iter()
            .map(|t| parse_token_address(t))
            .collect::<Result<_, _>>()?
    };
    token_addrs = sorted_unique_tokens(token_addrs);

    let client = MolochClient::new_http(&rpc_url, &dao_addr)?;

    if !client.ragequittable().await? {
        return Err(CliError::Other(
            "this DAO is not ragequittable (ragequittable() is false); exit must go \
             through governance"
                .into(),
        ));
    }

    let shares_token = client.shares_token().await?;
    let shares_balance = client.balance_of(shares_token, holder).await?;

    // DEV mapping: the configured spender key IS the shareholder. An
    // omitted --shares burns the FULL balance (the exit default); an
    // explicit --shares allows partial exit.
    let shares_to_burn = shares.unwrap_or(shares_balance);
    let loot_to_burn = 0u128; // loot exit is a separate, later surface
    if shares_to_burn == 0 && loot_to_burn == 0 {
        return Err(CliError::Other(format!(
            "configured EVM address 0x{} holds no shares in DAO {} and no --shares was given; \
             nothing to burn (DEV mapping: {ENV_SPENDER_KEY} is the shareholder)",
            hex::encode(holder),
            dao_addr
        )));
    }
    if shares_to_burn > shares_balance {
        return Err(CliError::Other(format!(
            "--shares {shares_to_burn} exceeds the configured address's balance {shares_balance}"
        )));
    }

    let tx_hash = client
        .ragequit(&spender, &token_addrs, shares_to_burn, loot_to_burn)
        .await?;

    // remainingOf-style view: what the holder keeps after the burn.
    let view = client.member_view(holder).await?;

    println!(
        "{}",
        serde_json::json!({
            "status": "ok",
            "txHash": tx_hash,
            "dao": client.dao_hex(),
            "burned": {
                "shares": shares_to_burn.to_string(),
                "loot": loot_to_burn.to_string(),
            },
            "tokens": token_addrs
                .iter()
                .map(|t| format!("0x{}", hex::encode(t)))
                .collect::<Vec<_>>(),
        })
    );
    println!(
        "{}",
        serde_json::json!({
            "memberView": {
                "dao": view.dao,
                "sharesToken": view.shares_token,
                "lootToken": view.loot_token,
                "sharesRemaining": view.shares.to_string(),
                "lootRemaining": view.loot.to_string(),
            }
        })
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// Mock transport keyed by RPC method; `eth_call` additionally keys on
    /// the calldata selector prefix so one mock serves many view reads.
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

        fn addr_word(address: &[u8; 20]) -> String {
            let mut hex_str = "0".repeat(24);
            hex_str.push_str(&hex::encode(address));
            format!("0x{hex_str}")
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

    const DAO: &str = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const SHARES_TOKEN: [u8; 20] = [0x11; 20];
    const LOOT_TOKEN: [u8; 20] = [0x22; 20];
    const WETH: [u8; 20] = [0x33; 20];

    fn base_responses() -> HashMap<String, serde_json::Value> {
        let mut m = HashMap::new();
        let sel = |sig: &str| hex::encode(abi::selector(sig));
        m.insert(
            format!("eth_call:{}", sel(SIG_SHARES)),
            serde_json::Value::String(MockRpc::addr_word(&SHARES_TOKEN)),
        );
        m.insert(
            format!("eth_call:{}", sel(SIG_LOOT)),
            serde_json::Value::String(MockRpc::addr_word(&LOOT_TOKEN)),
        );
        m.insert(
            format!("eth_call:{}", sel(SIG_RAGEQUITTABLE)),
            serde_json::Value::String(MockRpc::word(1)),
        );
        m.insert(
            format!("eth_call:{}", sel(SIG_BALANCE_OF)),
            serde_json::Value::String(MockRpc::word(1000)),
        );
        m
    }

    /// Selectors pinned against `cast sig` (foundry) so a keccak regression
    /// cannot silently change the wire format.
    #[test]
    fn selectors_match_cast_sig() {
        assert_eq!(hex::encode(abi::selector(SIG_RAGEQUIT)), "29f64d1a");
        assert_eq!(hex::encode(abi::selector(SIG_SHARES)), "03314efa");
        assert_eq!(hex::encode(abi::selector(SIG_LOOT)), "9b7b2ab0");
        assert_eq!(hex::encode(abi::selector(SIG_BALANCE_OF)), "70a08231");
        assert_eq!(hex::encode(abi::selector(SIG_RAGEQUITTABLE)), "14a6d7de");
    }

    #[test]
    fn ragequit_calldata_shape() {
        let data = encode_ragequit_calldata(&[WETH], 700, 0);
        assert_eq!(data.len(), 4 + 3 * 32 + 2 * 32);
        assert_eq!(&data[..4], &abi::selector(SIG_RAGEQUIT));
        // head: offset 0x60, shares, loot
        assert_eq!(&data[4..36], &abi::encode_uint256(0x60));
        assert_eq!(&data[36..68], &abi::encode_uint256(700));
        assert_eq!(&data[68..100], &abi::encode_uint256(0));
        // tail: array length 1, then the token word
        assert_eq!(&data[100..132], &abi::encode_uint256(1));
        assert_eq!(&data[132..164], &abi::encode_address_word(&WETH));
    }

    #[test]
    fn tokens_are_sorted_and_deduped() {
        let sorted = sorted_unique_tokens(vec![WETH, LOOT_TOKEN, WETH, SHARES_TOKEN]);
        assert_eq!(sorted, vec![SHARES_TOKEN, LOOT_TOKEN, WETH]);
    }

    #[tokio::test]
    async fn reads_member_view_through_the_mock_seam() {
        let rpc = Arc::new(MockRpc::new(base_responses()));
        let client = MolochClient::from_transport(rpc, DAO).unwrap();
        let holder = [0x44u8; 20];
        let view = client.member_view(holder).await.unwrap();
        assert_eq!(view.dao, DAO);
        assert_eq!(
            view.shares_token,
            format!("0x{}", hex::encode(SHARES_TOKEN))
        );
        assert_eq!(view.loot_token, format!("0x{}", hex::encode(LOOT_TOKEN)));
        assert_eq!(view.shares, 1000);
        assert_eq!(view.loot, 1000);
    }

    #[tokio::test]
    async fn ragequittable_false_is_a_hard_stop() {
        let mut responses = base_responses();
        let sel = hex::encode(abi::selector(SIG_RAGEQUITTABLE));
        responses.insert(
            format!("eth_call:{sel}"),
            serde_json::Value::String(MockRpc::word(0)),
        );
        let rpc = Arc::new(MockRpc::new(responses));
        let client = MolochClient::from_transport(rpc, DAO).unwrap();
        assert!(!client.ragequittable().await.unwrap());
    }

    #[tokio::test]
    async fn send_path_rejects_a_node_hash_mismatch() {
        // The allowance seam cross-checks the broadcast hash against the
        // signed hash; a mock that returns a wrong hash must abort the
        // ragequit (never report a spend we cannot identify).
        let mut responses = base_responses();
        responses.insert(
            "eth_chainId".into(),
            serde_json::Value::String("0x7a69".into()),
        );
        responses.insert(
            "eth_getTransactionCount".into(),
            serde_json::Value::String("0x0".into()),
        );
        responses.insert(
            "eth_gasPrice".into(),
            serde_json::Value::String("0x1".into()),
        );
        responses.insert(
            "eth_estimateGas".into(),
            serde_json::Value::String("0x186a0".into()),
        );
        responses.insert(
            "eth_sendRawTransaction".into(),
            serde_json::Value::String(format!("0x{}", "ab".repeat(32))),
        );
        let rpc = Arc::new(MockRpc::new(responses));
        let client = MolochClient::from_transport(rpc, DAO).unwrap();
        let key = k256::ecdsa::SigningKey::from_slice(&[7u8; 32]).unwrap();
        let err = client
            .ragequit(&key, &[WETH], 700, 0)
            .await
            .expect_err("mismatched hash must fail");
        assert!(err.to_string().contains("ragequit failed"), "{err}");
    }

    #[test]
    fn parse_token_accepts_hex_and_rejects_garbage() {
        assert_eq!(
            parse_token_address("0x0000000000000000000000000000000000000000").unwrap(),
            ETH_TOKEN
        );
        assert!(parse_token_address("nothex").is_err());
        assert!(parse_token_address("0x1234").is_err());
    }
}
