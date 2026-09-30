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

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::sync::Arc;
use std::time::Duration;

use buzz_core::org_grant::{tally_reviews, ReviewRow};
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

// ── settlement job: kind:37013 contributions → kind:47006 schedules ────────

/// Default bounded read of kind:37013 events per settlement run.
pub const SETTLEMENT_QUERY_DEFAULT: u32 = 500;
/// Hard cap on that read; a `--limit` above this is a usage error.
pub const SETTLEMENT_QUERY_CAP: u32 = 2_000;
/// Tenure factor denominator: `min(months_active, 12) / 12`.
pub const TENURE_CAP_MONTHS: u64 = 12;
/// Integer weights carry three decimals (×1000) so they fit `u32`.
pub const WEIGHT_SCALE: u128 = 1_000;

/// The weight formula, quoted in the command's help and echoed in its JSON
/// output so a printed weight can be re-derived from the same text.
pub const WEIGHT_FORMULA: &str = "weight(b) = sum over accepted actions of \
floor(amount * min(monthsActive, 12) * 1000 / 12), minus the same sum over \
rejected/slashed actions, clamped at 0; monthsActive defaults to 12 when \
absent, amount is required, and pending/appealed/unreviewed actions never count";

/// Claim fields copied into one review record (NIP-ORG: a review republishes
/// the record with its fields copied), keyed by review event id.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ReviewClaim {
    /// The review event's content carried a non-null `amount` field.
    pub has_amount: bool,
    /// The carried `amount`, parsed (`None` when absent or unparseable).
    pub amount: Option<u64>,
    /// The carried `monthsActive`, parsed.
    pub months_active: Option<u64>,
}

/// One kind:37013 contribution action as the settlement job sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContributionAction {
    /// Action id (`d` tag).
    pub d: String,
    /// Claimant (beneficiary): signer of the earliest record for `d`.
    pub subject: String,
    /// `content.amount` from the claimant's newest record (their claim) —
    /// the FALLBACK paid only when the disposing review copies no amount at
    /// all ([`paid_claim_fields`]); a post-acceptance edit to this record
    /// never changes the payout. `None` = unpayable (excluded, reported,
    /// never silently dropped).
    pub amount: Option<u64>,
    /// `content.monthsActive` from the claimant's newest record; `None`
    /// means full tenure ([`TENURE_CAP_MONTHS`]).
    pub months_active: Option<u64>,
    /// Claim snapshots copied into the review events, keyed by review event
    /// id — the reviewed fields a disposing verdict is bound to.
    pub review_claims: BTreeMap<String, ReviewClaim>,
    /// Every record for `d` at or after the filing, as review rows — the
    /// claimant's own included; [`tally_reviews`] never counts those.
    pub reviews: Vec<ReviewRow>,
}

/// The result of folding raw query events into settlement inputs.
#[derive(Debug, Default)]
pub struct FoldedActions {
    /// Per-action inputs, ordered by action id (deterministic).
    pub actions: Vec<ContributionAction>,
    /// Events with no `d` tag (action id) — cannot settle.
    pub skipped_no_action_id: u64,
    /// Events missing `id`/`pubkey`/`created_at` — malformed.
    pub skipped_malformed: u64,
}

/// Canonical verdict for one action (only `Accepted` pays).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// The canonical authorized review says `accepted` — payable.
    Accepted,
    /// The canonical authorized review says `rejected` — subtracts.
    Rejected,
    /// The canonical authorized review says `slashed` — subtracts.
    Slashed,
    /// No authorized non-subject review, or a non-terminal disposition
    /// (`pending`, `appealed`, …) — excluded entirely.
    Unreviewed,
}

/// Per-beneficiary settlement row — the schedules the mirror emits (one
/// claim per accepted action).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BeneficiaryWeight {
    /// Beneficiary pubkey (lowercase 64-hex) — the claimant of its actions.
    pub beneficiary: String,
    /// Net schedule weight in `u32`, scaled ×1000 ([`WEIGHT_FORMULA`]).
    pub weight: u32,
    /// Accepted scaled sum before subtraction (audit trail).
    pub credited: u128,
    /// Rejected/slashed scaled sum subtracted from `credited`.
    pub subtracted: u128,
    /// Accepted action ids that built the weight (sorted).
    pub accepted_actions: Vec<String>,
    /// Rejected/slashed action ids that subtracted (sorted).
    pub subtracted_actions: Vec<String>,
    /// Per-accepted-action claim weights (sorted by action id): the
    /// rejected/slashed clawback (`subtracted`) is absorbed by the accepted
    /// claims in sorted order, so the claim weights sum exactly to `weight`
    /// ([`WEIGHT_FORMULA`]) and each claim settles under its own id
    /// ([`settlement_ids`]) — never one id over the whole accepted set.
    pub claim_weights: Vec<(String, u32)>,
}

/// Per-record scaled claim: `floor(amount × min(months_active, 12) × 1000 / 12)`.
///
/// All arithmetic is `u128` intermediate (a `u64` amount at full tenure
/// cannot overflow it); the floor keeps the result an integer.
pub fn record_weight(amount: u64, months_active: u64) -> u128 {
    let capped = months_active.min(TENURE_CAP_MONTHS) as u128;
    u128::from(amount) * capped * WEIGHT_SCALE / 12
}

/// The canonical disposition for one action: the newest review by an
/// authorized reviewer other than the subject (ties: lowest event id) —
/// the exact pick [`tally_reviews`] makes internally.
fn canonical_review<'a>(
    rows: &'a [ReviewRow],
    subject: &str,
    authorized: &HashSet<String>,
) -> Option<&'a ReviewRow> {
    let mut best: Option<&ReviewRow> = None;
    for row in rows {
        if row.reviewer.eq_ignore_ascii_case(subject) || !authorized.contains(&row.reviewer) {
            continue;
        }
        let replace = match best {
            None => true,
            Some(cur) => {
                row.created_at > cur.created_at
                    || (row.created_at == cur.created_at && row.event_id < cur.event_id)
            }
        };
        if replace {
            best = Some(row);
        }
    }
    best
}

/// The claim fields one disposed action is PAID: the snapshot copied into
/// the disposing (canonical) review — per NIP-ORG a review republishes the
/// record with its fields copied, so the reviewed snapshot is the
/// authoritative claim — falling back to the claimant's newest record only
/// when the review copies no `amount` at all. A claimant edit AFTER
/// acceptance therefore never changes the payout.
pub fn paid_claim_fields(
    action: &ContributionAction,
    authorized: &HashSet<String>,
) -> (Option<u64>, Option<u64>) {
    if let Some(review) = canonical_review(&action.reviews, &action.subject, authorized) {
        if let Some(claim) = action.review_claims.get(&review.event_id) {
            if claim.has_amount {
                return (claim.amount, claim.months_active);
            }
        }
    }
    (action.amount, action.months_active)
}

/// Resolve one action's verdict with the review machinery's semantics.
///
/// The accepted/rejected split is delegated to [`tally_reviews`] (so a
/// self-review or an unauthorized reviewer can never decide anything);
/// `slashed` is recognized from the same canonical pick, and anything else
/// is [`Verdict::Unreviewed`] — excluded.
pub fn verdict_of(action: &ContributionAction, authorized: &HashSet<String>) -> Verdict {
    let (accepted, rejected) = tally_reviews(&action.reviews, &action.subject, authorized);
    if accepted == 1 {
        return Verdict::Accepted;
    }
    if rejected == 1 {
        return Verdict::Rejected;
    }
    match canonical_review(&action.reviews, &action.subject, authorized) {
        Some(row) if row.status.as_deref() == Some("slashed") => Verdict::Slashed,
        _ => Verdict::Unreviewed,
    }
}

/// Compute per-beneficiary weights deterministically ([`WEIGHT_FORMULA`]).
///
/// Beneficiaries are ordered by pubkey; accepted actions add, rejected and
/// slashed actions subtract (net clamped at 0 per beneficiary), and
/// everything else — unreviewed verdicts and claims without an `amount` —
/// contributes nothing. A net that cannot fit `u32` is an explicit error,
/// never a wraparound.
pub fn compute_weights(
    actions: &[ContributionAction],
    authorized: &HashSet<String>,
) -> Result<Vec<BeneficiaryWeight>, CliError> {
    #[derive(Default)]
    struct Acc {
        credited: u128,
        subtracted: u128,
        accepted: BTreeMap<String, u128>,
        subtracted_actions: BTreeSet<String>,
    }
    let mut by_beneficiary: BTreeMap<String, Acc> = BTreeMap::new();
    for action in actions {
        let verdict = verdict_of(action, authorized);
        let on_accepted_side = verdict == Verdict::Accepted;
        let on_subtracted_side = matches!(verdict, Verdict::Rejected | Verdict::Slashed);
        if !on_accepted_side && !on_subtracted_side {
            continue;
        }
        // Pay the claim as it stood at the disposing review (its copied
        // snapshot), never a later claimant edit ([`paid_claim_fields`]).
        let (amount, months_active) = paid_claim_fields(action, authorized);
        let Some(amount) = amount else {
            // Unpayable claim: reported by the caller's stats, never money.
            continue;
        };
        let scaled = record_weight(amount, months_active.unwrap_or(TENURE_CAP_MONTHS));
        let acc = by_beneficiary.entry(action.subject.clone()).or_default();
        if on_accepted_side {
            acc.credited = acc.credited.saturating_add(scaled);
            acc.accepted.insert(action.d.clone(), scaled);
        } else {
            acc.subtracted = acc.subtracted.saturating_add(scaled);
            acc.subtracted_actions.insert(action.d.clone());
        }
    }

    let mut out = Vec::with_capacity(by_beneficiary.len());
    for (beneficiary, acc) in by_beneficiary {
        if acc.accepted.is_empty() {
            // Nothing payable ever existed here: a rejected-only history is
            // not a schedule row.
            continue;
        }
        let net = acc.credited.saturating_sub(acc.subtracted);
        let weight = u32::try_from(net).map_err(|_| {
            CliError::Other(format!(
                "computed royalty weight for {beneficiary} exceeds u32; split the epoch or \
                 lower the claim amounts"
            ))
        })?;
        // Fan the clamped net out over the accepted claims: the clawback for
        // rejected/slashed work is absorbed in sorted action order, so the
        // claim weights sum exactly to `weight` and every claim settles under
        // its own id ([`settlement_ids`]) — the chain's one-shot claim slot
        // turns overlapping re-runs into no-ops, never double payouts.
        let mut carry = acc.subtracted;
        let mut claim_weights = Vec::with_capacity(acc.accepted.len());
        for (action_id, scaled) in &acc.accepted {
            let applied = carry.min(*scaled);
            carry -= applied;
            let claim_weight = u32::try_from(scaled - applied).map_err(|_| {
                CliError::Other(format!(
                    "computed royalty weight for {beneficiary} exceeds u32; split the epoch or \
                     lower the claim amounts"
                ))
            })?;
            claim_weights.push((action_id.clone(), claim_weight));
        }
        out.push(BeneficiaryWeight {
            beneficiary,
            weight,
            credited: acc.credited,
            subtracted: acc.subtracted,
            accepted_actions: acc.accepted.keys().cloned().collect(),
            subtracted_actions: acc.subtracted_actions.into_iter().collect(),
            claim_weights,
        });
    }
    Ok(out)
}

/// Normalize a reviewer/subject pubkey: trim, lowercase, 64 hex chars.
pub fn normalize_pubkey_hex(value: &str) -> Result<String, CliError> {
    let clean = value.trim().to_ascii_lowercase();
    if clean.len() != 64 || !clean.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(CliError::Usage(format!(
            "expected a 64-hex pubkey, got: {value}"
        )));
    }
    Ok(clean)
}

fn content_u64(content: &serde_json::Value, key: &str) -> Option<u64> {
    match content.get(key) {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::Number(n)) => n.as_u64(),
        Some(serde_json::Value::String(s)) => s.trim().parse::<u64>().ok(),
        Some(_) => None,
    }
}

fn event_d_tag(event: &serde_json::Value) -> Option<String> {
    event["tags"].as_array().and_then(|tags| {
        tags.iter().find_map(|tag| {
            let pair = tag.as_array()?;
            match (pair.first().and_then(|k| k.as_str()), pair.get(1)) {
                (Some("d"), Some(v)) => v.as_str().map(|s| s.to_owned()),
                _ => None,
            }
        })
    })
}

/// Fold raw kind:37013 query events into per-action settlement inputs.
///
/// Grouping mirrors NIP-ORG § Contribution record review: one action per `d`
/// tag. The **claimant** is the signer of the earliest record carrying the
/// claim (`content.amount`; ties: lowest event id) — a copy by anyone else
/// never hijacks the action — and what is PAID is the snapshot the disposing
/// review copied ([`paid_claim_fields`]), falling back to the claimant's
/// newest record (NIP-33 LWW) only when the review copies no amount — a
/// post-acceptance edit never changes the payout. An action settles in this
/// epoch when its filing (the claimant's earliest record) is inside
/// `[epoch_start, epoch_end)`; a review cannot predate the filing (the
/// [`tally_reviews`] consumer rule), and reviews up to `review_until` count —
/// so a verdict landing just after the window still disposes the work it
/// reviews, while a verdict after the cutoff is picked up by the next run
/// (per-action claim ids make that overlap idempotent).
pub fn fold_settlement_actions(
    events: &[serde_json::Value],
    epoch_start: u64,
    epoch_end: u64,
    review_until: u64,
) -> Result<FoldedActions, CliError> {
    struct Raw {
        id: String,
        signer: String,
        created_at: u64,
        status: Option<String>,
        has_amount: bool,
        amount: Option<u64>,
        months_active: Option<u64>,
    }

    let mut by_action: BTreeMap<String, Vec<Raw>> = BTreeMap::new();
    let mut folded = FoldedActions::default();
    for event in events {
        if event["kind"].as_u64() != Some(u64::from(buzz_core::kind::KIND_CONTRIBUTION_RECORD)) {
            continue;
        }
        let (Some(id), Some(signer), Some(created_at)) = (
            event["id"].as_str().map(|s| s.to_ascii_lowercase()),
            event["pubkey"].as_str().map(|s| s.to_ascii_lowercase()),
            event["created_at"].as_u64(),
        ) else {
            folded.skipped_malformed += 1;
            continue;
        };
        let Some(d) = event_d_tag(event) else {
            folded.skipped_no_action_id += 1;
            continue;
        };
        let content = match event["content"].as_str() {
            Some(raw) => {
                serde_json::from_str::<serde_json::Value>(raw).unwrap_or(serde_json::Value::Null)
            }
            None => serde_json::Value::Null,
        };
        by_action.entry(d).or_default().push(Raw {
            id,
            signer,
            created_at,
            status: content
                .get("reviewStatus")
                .and_then(|v| v.as_str())
                .map(str::to_owned),
            has_amount: content.get("amount").is_some_and(|v| !v.is_null()),
            amount: content_u64(&content, "amount"),
            months_active: content_u64(&content, "monthsActive"),
        });
    }

    for (d, mut rows) in by_action {
        rows.sort_by(|a, b| {
            a.created_at
                .cmp(&b.created_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        // Claimant = signer of the earliest claim-carrying record; an action
        // whose records never carry `amount` falls back to the earliest
        // signer and settles as unpayable (reported, never silent). The
        // claimant's own reviews never count ([`tally_reviews`]).
        let Some(subject) = rows
            .iter()
            .find(|r| r.has_amount)
            .or_else(|| rows.first())
            .map(|r| r.signer.clone())
        else {
            continue;
        };
        let Some(filing_at) = rows
            .iter()
            .filter(|r| r.signer == subject)
            .map(|r| r.created_at)
            .min()
        else {
            continue;
        };
        if filing_at < epoch_start || filing_at >= epoch_end {
            continue;
        }
        // Claim fields: the claimant's newest record (NIP-33 LWW; ties:
        // lowest event id).
        let claim = rows.iter().filter(|r| r.signer == subject).max_by(|a, b| {
            a.created_at
                .cmp(&b.created_at)
                .then_with(|| b.id.cmp(&a.id))
        });
        let (amount, months_active) = match claim {
            Some(c) => (c.amount, c.months_active),
            None => (None, None),
        };
        let mut reviews = Vec::new();
        let mut review_claims = BTreeMap::new();
        for r in rows
            .iter()
            .filter(|r| r.created_at >= filing_at && r.created_at <= review_until)
        {
            reviews.push(ReviewRow {
                d: d.clone(),
                reviewer: r.signer.clone(),
                created_at: r.created_at,
                event_id: r.id.clone(),
                status: r.status.clone(),
            });
            review_claims.insert(
                r.id.clone(),
                ReviewClaim {
                    has_amount: r.has_amount,
                    amount: r.amount,
                    months_active: r.months_active,
                },
            );
        }
        folded.actions.push(ContributionAction {
            d,
            subject,
            amount,
            months_active,
            review_claims,
            reviews,
        });
    }
    Ok(folded)
}

/// Deterministic claim/evidence ids for ONE accepted action of one
/// beneficiary's epoch schedule: keccak over the settled window, beneficiary
/// and the single action id. Ids are derived per action — never one id over
/// the whole accepted set — so overlapping re-runs re-derive the shared
/// actions' claims byte-identically (idempotent queue: the chain's one-shot
/// claim slot can never re-pay a settled action) and a wider cutoff only
/// adds new ids for its delta actions.
fn settlement_ids(
    epoch_start: u64,
    epoch_end: u64,
    beneficiary: &str,
    action: &str,
) -> (String, String) {
    let claim = format!("royalty-settle:{epoch_start}:{epoch_end}:{beneficiary}:{action}");
    let evidence = format!("royalty-settle-evidence:{epoch_start}:{epoch_end}:{action}");
    (
        format!("0x{}", hex::encode(abi::keccak256(claim.as_bytes()))),
        format!("0x{}", hex::encode(abi::keccak256(evidence.as_bytes()))),
    )
}

/// Inputs for [`cmd_settle_weights`].
pub struct SettleWeightsOpts<'a> {
    /// Chain identifier for the emitted mirrors, e.g. `eip155:8453`.
    pub chain: &'a str,
    /// RoyaltyDistributor address (`0x…`).
    pub distributor: &'a str,
    /// Epoch window start (unix seconds, inclusive).
    pub epoch_start: u64,
    /// Epoch window end (unix seconds, exclusive).
    pub epoch_end: u64,
    /// Latest review `created_at` that may dispose an action. Verdicts after
    /// the cutoff are picked up by the next run — per-action claim ids make
    /// the overlap idempotent.
    pub review_until: u64,
    /// Bounded read cap for kind:37013 events.
    pub limit: u32,
    /// Reviewer keys whose dispositions count (NIP-ORG review authority,
    /// supplied by the operator: owner/admin + seated humans).
    pub authorized: HashSet<String>,
    /// Schedule term (seconds) applied to every emitted schedule.
    pub term: u64,
    /// Badge tier (1–3) applied to every emitted schedule.
    pub band: u8,
    /// Earned token allocation applied to every emitted schedule.
    pub allocation: u128,
}

/// `buzz royalty settle-weights` — the contribution→payout bridge.
///
/// For the connected relay's community and the given epoch: collect the
/// kind:37013 contribution records (bounded query), resolve each action's
/// verdict exactly the way the review machinery does, compute per-beneficiary
/// weights ([`WEIGHT_FORMULA`]), and emit one unsigned kind:47006 schedule per
/// accepted action — each under its own claim id ([`settlement_ids`]), so a
/// re-run with a wider cutoff only adds delta claims — through the existing
/// mirror composer — the chain stays
/// authoritative. Prints the schedules plus the exact `buzz royalty`
/// follow-ups to publish the mirrors and close the window on chain. An epoch
/// with nothing payable reports `"status": "empty"` explicitly.
pub async fn cmd_settle_weights(
    client: &BuzzClient,
    opts: SettleWeightsOpts<'_>,
) -> Result<(), CliError> {
    let distributor = distributor_addr(opts.distributor)?;
    if opts.epoch_start >= opts.epoch_end {
        return Err(CliError::Usage(
            "--epoch-start must be before --epoch-end".into(),
        ));
    }
    if opts.review_until < opts.epoch_end {
        return Err(CliError::Usage(
            "--review-until must be at least --epoch-end (a verdict inside the epoch \
             must be able to dispose it)"
                .into(),
        ));
    }
    if opts.limit == 0 || opts.limit > SETTLEMENT_QUERY_CAP {
        return Err(CliError::Usage(format!(
            "--limit must be 1..={SETTLEMENT_QUERY_CAP}"
        )));
    }
    if !(1..=3).contains(&opts.band) {
        return Err(CliError::Usage("--band must be 1, 2, or 3".into()));
    }
    if opts.term == 0 {
        return Err(CliError::Usage("--term must be at least 1 second".into()));
    }
    if opts.authorized.is_empty() {
        return Err(CliError::Usage(
            "settle-weights needs at least one --authorized-reviewer (owner/admin or seated \
             humans): without one every action reads as unreviewed"
                .into(),
        ));
    }

    // Bounded read: `query_all_bounded` errors on truncation rather than
    // letting a silent cap fabricate an authoritative empty settlement.
    let filter = json!({
        "kinds": [buzz_core::kind::KIND_CONTRIBUTION_RECORD],
        "since": opts.epoch_start,
        "until": opts.review_until,
    });
    let events = client.query_all_bounded(filter, opts.limit).await?;
    let folded =
        fold_settlement_actions(&events, opts.epoch_start, opts.epoch_end, opts.review_until)?;
    let weights = compute_weights(&folded.actions, &opts.authorized)?;

    let mut counts = json!({
        "events": events.len(),
        "actions": folded.actions.len(),
        "skippedNoActionId": folded.skipped_no_action_id,
        "skippedMalformed": folded.skipped_malformed,
        "accepted": 0,
        "rejected": 0,
        "slashed": 0,
        "unreviewed": 0,
        "skippedNoAmount": 0,
    });
    let mut unpayable: Vec<String> = Vec::new();
    for action in &folded.actions {
        let slot = match verdict_of(action, &opts.authorized) {
            Verdict::Accepted => "accepted",
            Verdict::Rejected => "rejected",
            Verdict::Slashed => "slashed",
            Verdict::Unreviewed => "unreviewed",
        };
        counts[slot] = json!(counts[slot].as_u64().unwrap_or(0) + 1);
        let (paid_amount, _) = paid_claim_fields(action, &opts.authorized);
        if paid_amount.is_none() && slot != "unreviewed" {
            counts["skippedNoAmount"] = json!(counts["skippedNoAmount"].as_u64().unwrap_or(0) + 1);
            unpayable.push(action.d.clone());
        }
    }

    let epoch = json!({
        "start": opts.epoch_start,
        "end": opts.epoch_end,
        "reviewUntil": opts.review_until,
    });

    if weights.is_empty() {
        println!(
            "{}",
            json!({
                "status": "empty",
                "message": "no accepted contributions this epoch — nothing to schedule",
                "epoch": epoch,
                "records": counts,
                "unpayableActions": unpayable,
                "note": "only actions whose newest authorized review is 'accepted' pay; \
                         pass --authorized-reviewer keys if you expected payable work",
            })
        );
        return Ok(());
    }

    let mut templates = Vec::with_capacity(weights.len());
    let mut schedule = Vec::with_capacity(weights.len());
    let mut next_commands = Vec::with_capacity(weights.len() + 1);
    for row in &weights {
        let mut claims = Vec::with_capacity(row.claim_weights.len());
        for (action_id, claim_weight) in &row.claim_weights {
            // One claim per accepted action — never one id over the whole
            // accepted set — so an overlapping re-run re-derives the settled
            // actions' claims byte-identically (the chain's one-shot claim
            // slot makes them no-ops) and only its delta actions get new ids.
            let (claim_id, evidence_hash) = settlement_ids(
                opts.epoch_start,
                opts.epoch_end,
                &row.beneficiary,
                action_id,
            );
            // The EXISTING compose path — same unsigned template the
            // mirror-schedule command prints (advisory; chain is authoritative).
            templates.push(royalty_schedule_event_json(
                opts.chain,
                &distributor,
                &claim_id,
                &evidence_hash,
                &row.beneficiary,
                *claim_weight,
                opts.term,
                opts.band,
                opts.allocation,
            ));
            next_commands.push(format!(
                "buzz royalty publish-schedule --chain {} --distributor {} --claim-id {} \
                 --evidence-hash {} --contributor {} --weight {} --term {} --band {} \
                 --allocation {}",
                opts.chain,
                distributor,
                claim_id,
                evidence_hash,
                row.beneficiary,
                claim_weight,
                opts.term,
                opts.band,
                opts.allocation
            ));
            claims.push(json!({
                "actionId": action_id,
                "claimId": claim_id,
                "evidenceHash": evidence_hash,
                "weight": claim_weight,
            }));
        }
        schedule.push(json!({
            "beneficiary": row.beneficiary,
            "weight": row.weight,
            "credited": row.credited.to_string(),
            "subtracted": row.subtracted.to_string(),
            "acceptedActions": row.accepted_actions,
            "subtractedActions": row.subtracted_actions,
            "claims": claims,
        }));
    }
    next_commands.push(format!(
        "buzz royalty settle --distributor {distributor}  # close the window on chain \
         (the payout; ClaimStake settles the matching schedule mints)"
    ));

    println!(
        "{}",
        json!({
            "status": "ok",
            "epoch": epoch,
            "formula": WEIGHT_FORMULA,
            "records": counts,
            "unpayableActions": unpayable,
            "schedule": schedule,
            "templates": templates,
            "nextCommands": next_commands,
            "note": "unsigned kind:47006 mirrors — the chain is authoritative",
        })
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
        SettleWeights {
            epoch_start,
            epoch_end,
            review_until,
            authorized_reviewer,
            limit,
            chain,
            distributor,
            term,
            band,
            allocation,
        } => {
            let mut authorized = HashSet::new();
            for key in &authorized_reviewer {
                authorized.insert(normalize_pubkey_hex(key)?);
            }
            return cmd_settle_weights(
                client,
                SettleWeightsOpts {
                    chain: &chain,
                    distributor: &distributor,
                    epoch_start,
                    epoch_end,
                    review_until: review_until.unwrap_or(epoch_end),
                    limit: limit.unwrap_or(SETTLEMENT_QUERY_DEFAULT),
                    authorized,
                    term,
                    band,
                    allocation,
                },
            )
            .await;
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

    // ── settlement job: kind:37013 contributions → schedule weights ────────

    fn pk(c: char) -> String {
        c.to_string().repeat(64)
    }

    fn row(d: &str, reviewer: &str, at: u64, id: u64, status: &str) -> ReviewRow {
        ReviewRow {
            d: d.into(),
            reviewer: reviewer.into(),
            created_at: at,
            event_id: format!("{id:064x}"),
            status: Some(status.into()),
        }
    }

    fn action(
        d: &str,
        subject: &str,
        amount: Option<u64>,
        months_active: Option<u64>,
        reviews: Vec<ReviewRow>,
    ) -> ContributionAction {
        ContributionAction {
            d: d.into(),
            subject: subject.into(),
            amount,
            months_active,
            review_claims: BTreeMap::new(),
            reviews,
        }
    }

    fn authorized(keys: &[&str]) -> HashSet<String> {
        keys.iter().map(|k| k.to_string()).collect()
    }

    #[test]
    fn settle_weights_are_exact_and_deterministic() {
        let (a, b, rev) = (pk('a'), pk('b'), pk('r'));
        let auth = authorized(&[&rev]);
        let actions = vec![
            action(
                "t1",
                &a,
                Some(120),
                Some(12),
                vec![row("t1", &rev, 10, 1, "accepted")],
            ),
            action(
                "t2",
                &a,
                Some(100),
                Some(6),
                vec![row("t2", &rev, 11, 2, "accepted")],
            ),
            action(
                "t3",
                &b,
                Some(120),
                Some(12),
                vec![row("t3", &rev, 12, 3, "accepted")],
            ),
        ];
        let weights = compute_weights(&actions, &auth).expect("weights");
        assert_eq!(weights.len(), 2);
        // 120×12×1000/12 = 120000; 100×6×1000/12 = 50000.
        assert_eq!(weights[0].beneficiary, a);
        assert_eq!(weights[0].weight, 170_000);
        assert_eq!(weights[0].credited, 170_000);
        assert_eq!(weights[0].accepted_actions, vec!["t1", "t2"]);
        assert_eq!(weights[1].beneficiary, b);
        assert_eq!(weights[1].weight, 120_000);
    }

    #[test]
    fn rejected_and_slashed_subtract_and_clamp_at_zero() {
        let (a, b, rev) = (pk('a'), pk('b'), pk('r'));
        let auth = authorized(&[&rev]);
        let actions = vec![
            action(
                "t1",
                &a,
                Some(120),
                Some(12),
                vec![row("t1", &rev, 10, 1, "accepted")],
            ),
            action(
                "t2",
                &a,
                Some(40),
                Some(12),
                vec![row("t2", &rev, 10, 2, "rejected")],
            ),
            action(
                "t3",
                &a,
                Some(20),
                Some(12),
                vec![row("t3", &rev, 10, 3, "slashed")],
            ),
            // Net clamps at 0 per beneficiary, never negative.
            action(
                "t4",
                &b,
                Some(10),
                Some(12),
                vec![row("t4", &rev, 10, 4, "accepted")],
            ),
            action(
                "t5",
                &b,
                Some(50),
                Some(12),
                vec![row("t5", &rev, 10, 5, "rejected")],
            ),
        ];
        let weights = compute_weights(&actions, &auth).expect("weights");
        assert_eq!(weights[0].weight, 60_000);
        assert_eq!(weights[0].credited, 120_000);
        assert_eq!(weights[0].subtracted, 60_000);
        assert_eq!(weights[0].subtracted_actions, vec!["t2", "t3"]);
        // The clawback is absorbed by the accepted claims in sorted order:
        // claim weights sum exactly to the net weight (never overpay).
        assert_eq!(weights[0].claim_weights, vec![("t1".to_string(), 60_000)]);
        assert_eq!(weights[1].beneficiary, b);
        assert_eq!(weights[1].weight, 0);
        assert_eq!(weights[1].claim_weights, vec![("t4".to_string(), 0)]);
    }

    /// Guard: pending/appealed/unreviewed actions, self-signed "accepted"
    /// claims and unauthorized reviewers never pay. Mutation check —
    /// dropping the exclusion rule (e.g. treating [`Verdict::Unreviewed`] as
    /// payable) fails this test.
    #[test]
    fn unreviewed_and_self_reviewed_records_are_excluded() {
        let (a, rev, outsider) = (pk('a'), pk('r'), pk('o'));
        let auth = authorized(&[&rev]);
        let actions = vec![
            action(
                "t1",
                &a,
                Some(100),
                Some(12),
                vec![row("t1", &rev, 10, 1, "accepted")],
            ),
            // Authorized reviewer left it pending: no weight.
            action(
                "t2",
                &a,
                Some(100),
                Some(12),
                vec![row("t2", &rev, 10, 2, "pending")],
            ),
            // The subject grades itself: never counts.
            action(
                "t3",
                &a,
                Some(100),
                Some(12),
                vec![row("t3", &a, 10, 3, "accepted")],
            ),
            // An unauthorized key cannot make a claim payable.
            action(
                "t4",
                &a,
                Some(100),
                Some(12),
                vec![row("t4", &outsider, 10, 4, "accepted")],
            ),
            // Nobody reviewed at all.
            action("t5", &a, Some(100), Some(12), vec![]),
        ];
        let weights = compute_weights(&actions, &auth).expect("weights");
        assert_eq!(weights.len(), 1);
        assert_eq!(weights[0].weight, 100_000, "only t1 may pay");
        assert_eq!(weights[0].accepted_actions, vec!["t1"]);
    }

    #[test]
    fn tenure_caps_at_twelve_months() {
        assert_eq!(record_weight(1_000, 12), 1_000_000);
        assert_eq!(
            record_weight(1_000, 36),
            record_weight(1_000, 12),
            "tenure is capped at 12 months"
        );
        assert_eq!(record_weight(1_000, 0), 0);
        // Floor division: 100×1×1000/12 = 8333.33… → 8333.
        assert_eq!(record_weight(100, 1), 8_333);
        // Absent tenure = full tenure.
        let (a, rev) = (pk('a'), pk('r'));
        let auth = authorized(&[&rev]);
        let actions = vec![action(
            "t1",
            &a,
            Some(1_000),
            None,
            vec![row("t1", &rev, 10, 1, "accepted")],
        )];
        let weights = compute_weights(&actions, &auth).expect("weights");
        assert_eq!(weights[0].weight, 1_000_000);
    }

    #[test]
    fn weight_overflow_is_an_explicit_error() {
        let (a, rev) = (pk('a'), pk('r'));
        let auth = authorized(&[&rev]);
        let actions = vec![action(
            "t1",
            &a,
            Some(u64::MAX),
            Some(12),
            vec![row("t1", &rev, 10, 1, "accepted")],
        )];
        let err = compute_weights(&actions, &auth).expect_err("must not wrap u32");
        assert!(
            format!("{err:?}").contains("exceeds u32"),
            "overflow must name the failure, got {err:?}"
        );
    }

    /// Verdict resolution must agree with [`tally_reviews`] on every
    /// accepted/rejected fixture — same-`d` self-reviews never count, the
    /// canonical pick is the newest authorized review (ties: lowest id), and
    /// an unauthorized verdict can never supersede an authorized one.
    #[test]
    fn verdicts_follow_tally_reviews_semantics() {
        let (s, r1, r2, outsider) = (pk('a'), pk('b'), pk('c'), pk('z'));
        let auth = authorized(&[&r1, &r2]);

        // Self-review + authorized accept: only the authorized one counts.
        let a = action(
            "t1",
            &s,
            Some(1),
            Some(12),
            vec![
                row("t1", &s, 10, 1, "accepted"),
                row("t1", &r1, 11, 2, "accepted"),
            ],
        );
        assert_eq!(verdict_of(&a, &auth), Verdict::Accepted);
        assert_eq!(tally_reviews(&a.reviews, &s, &auth), (1, 0));

        // A newer authorized `pending` supersedes an earlier `accepted`.
        let a = action(
            "t1",
            &s,
            Some(1),
            Some(12),
            vec![
                row("t1", &r1, 10, 1, "accepted"),
                row("t1", &r2, 20, 2, "pending"),
            ],
        );
        assert_eq!(verdict_of(&a, &auth), Verdict::Unreviewed);
        assert_eq!(tally_reviews(&a.reviews, &s, &auth), (0, 0));

        // Equal timestamps: the lowest event id wins, deterministically.
        let a = action(
            "t1",
            &s,
            Some(1),
            Some(12),
            vec![
                row("t1", &r1, 10, 5, "accepted"),
                row("t1", &r2, 10, 4, "rejected"),
            ],
        );
        assert_eq!(verdict_of(&a, &auth), Verdict::Rejected);
        assert_eq!(tally_reviews(&a.reviews, &s, &auth), (0, 1));

        // An unauthorized newer verdict cannot supersede an authorized one.
        let a = action(
            "t1",
            &s,
            Some(1),
            Some(12),
            vec![
                row("t1", &r1, 10, 1, "accepted"),
                row("t1", &outsider, 20, 2, "rejected"),
            ],
        );
        assert_eq!(verdict_of(&a, &auth), Verdict::Accepted);
        assert_eq!(tally_reviews(&a.reviews, &s, &auth), (1, 0));

        // `slashed` rides the same canonical pick; newest still wins.
        let a = action(
            "t1",
            &s,
            Some(1),
            Some(12),
            vec![
                row("t1", &r1, 10, 1, "slashed"),
                row("t1", &r2, 20, 2, "accepted"),
            ],
        );
        assert_eq!(verdict_of(&a, &auth), Verdict::Accepted, "newest wins");
        let a = action(
            "t1",
            &s,
            Some(1),
            Some(12),
            vec![
                row("t1", &r1, 10, 1, "accepted"),
                row("t1", &r2, 20, 2, "slashed"),
            ],
        );
        assert_eq!(verdict_of(&a, &auth), Verdict::Slashed);
        assert_eq!(
            tally_reviews(&a.reviews, &s, &auth),
            (0, 0),
            "slashed is not accepted and not rejected"
        );
    }

    fn raw_event(
        id: u64,
        signer: &str,
        at: u64,
        d: Option<&str>,
        content: serde_json::Value,
    ) -> serde_json::Value {
        let tags: Vec<serde_json::Value> = match d {
            Some(d) => vec![json!(["d", d])],
            None => vec![],
        };
        json!({
            "id": format!("{id:064x}"),
            "pubkey": signer,
            "kind": buzz_core::kind::KIND_CONTRIBUTION_RECORD,
            "created_at": at,
            "content": content.to_string(),
            "tags": tags,
        })
    }

    #[test]
    fn folding_groups_actions_and_windows_the_epoch() {
        let (s, rev) = (pk('a'), pk('r'));
        let (start, end) = (1_000u64, 2_000u64);
        let events = vec![
            // Filing: the claimant's first claim-carrying record (in window).
            raw_event(
                1,
                &s,
                start + 10,
                Some("t1"),
                json!({"v": 1, "amount": 250, "monthsActive": 6, "reviewStatus": "pending"}),
            ),
            // Review inside the window: accepted (amount copied along).
            raw_event(
                2,
                &rev,
                start + 20,
                Some("t1"),
                json!({"v": 1, "amount": 250, "monthsActive": 6, "reviewStatus": "accepted"}),
            ),
            // Claimant edit AFTER acceptance: the newest claimant record is
            // only the fallback claim — it must never change the payout.
            raw_event(
                6,
                &s,
                start + 30,
                Some("t1"),
                json!({"v": 1, "amount": "300", "monthsActive": 6}),
            ),
            // A copy predating the filing never counts as a review.
            raw_event(
                4,
                &rev,
                start - 5,
                Some("t1"),
                json!({"reviewStatus": "accepted"}),
            ),
            // A filing after the epoch end settles in the next epoch.
            raw_event(3, &s, end + 5, Some("t2"), json!({"amount": 999})),
            // No action id: cannot settle, counted explicitly.
            raw_event(5, &s, start + 10, None, json!({"amount": 1})),
        ];
        let folded = fold_settlement_actions(&events, start, end, end).expect("fold");
        assert_eq!(folded.actions.len(), 1);
        assert_eq!(folded.skipped_no_action_id, 1);
        let t1 = &folded.actions[0];
        assert_eq!(t1.d, "t1");
        assert_eq!(t1.subject, s);
        assert_eq!(
            t1.amount,
            Some(300),
            "the fallback claim is the claimant's newest record (LWW)"
        );
        assert_eq!(t1.months_active, Some(6));
        assert_eq!(
            t1.reviews.len(),
            3,
            "the pre-filing copy is excluded; the claimant's own rows ride \
             along so tally_reviews can drop them"
        );
        let auth = authorized(&[&rev]);
        assert_eq!(verdict_of(t1, &auth), Verdict::Accepted);
        assert_eq!(
            paid_claim_fields(t1, &auth),
            (Some(250), Some(6)),
            "the accepting review's copied snapshot is what pays — the \
             post-acceptance edit to 300 must never pay"
        );
        // Only the REVIEWED claim pays: 250×6×1000/12 = 125_000.
        let weights = compute_weights(&folded.actions, &auth).expect("weights");
        assert_eq!(weights[0].weight, 125_000);
    }

    #[test]
    fn settlement_ids_are_deterministic_and_action_bound() {
        let (a, b) = (pk('a'), pk('b'));
        let one = settlement_ids(1_000, 2_000, &a, "t1");
        let two = settlement_ids(1_000, 2_000, &a, "t1");
        assert_eq!(one, two, "same inputs → byte-identical mirrors");
        assert!(one.0.starts_with("0x") && one.0.len() == 66);
        assert!(one.1.starts_with("0x") && one.1.len() == 66);
        assert_ne!(
            one,
            settlement_ids(1_000, 2_000, &b, "t1"),
            "a claim is bound to its beneficiary"
        );
        assert_ne!(
            one,
            settlement_ids(1_000, 2_000, &a, "t2"),
            "a claim is bound to its single action — never one id over the \
             accepted set"
        );
    }

    /// Guard: an edit to the claimant's record AFTER the accepting review
    /// never changes the payout — the amount/monthsActive as it stood at the
    /// accepting review (the snapshot the review copied) is what pays. The
    /// claimant's newest record is consulted only when the review copies no
    /// amount at all. Mutation check: paying the claimant's newest record
    /// instead fails this test (the edit 250 → 300 would pay 300_000).
    #[test]
    fn post_acceptance_edits_are_not_paid() {
        let (s, rev) = (pk('a'), pk('r'));
        let (start, end) = (1_000u64, 2_000u64);
        let auth = authorized(&[&rev]);
        let events = vec![
            raw_event(
                1,
                &s,
                start + 10,
                Some("t1"),
                json!({"amount": 250, "monthsActive": 6, "reviewStatus": "pending"}),
            ),
            // The accepting review copies the record: 250/6 as reviewed.
            raw_event(
                2,
                &rev,
                start + 20,
                Some("t1"),
                json!({"amount": 250, "monthsActive": 6, "reviewStatus": "accepted"}),
            ),
            // Post-acceptance claimant edit — must never pay.
            raw_event(
                3,
                &s,
                start + 30,
                Some("t1"),
                json!({"amount": 300, "monthsActive": 12}),
            ),
        ];
        let folded = fold_settlement_actions(&events, start, end, end).expect("fold");
        let weights = compute_weights(&folded.actions, &auth).expect("weights");
        // 250×6×1000/12 = 125_000 — the REVIEWED claim pays, not 300_000.
        assert_eq!(weights[0].weight, 125_000);
        assert_eq!(weights[0].claim_weights, vec![("t1".to_string(), 125_000)]);

        // Fallback: a review that copies no amount at all falls back to the
        // claimant's newest record (LWW).
        let events = vec![
            raw_event(4, &s, start + 10, Some("t1"), json!({"amount": 250, "monthsActive": 6})),
            raw_event(5, &rev, start + 20, Some("t1"), json!({"reviewStatus": "accepted"})),
            raw_event(6, &s, start + 30, Some("t1"), json!({"amount": 300, "monthsActive": 12})),
        ];
        let folded = fold_settlement_actions(&events, start, end, end).expect("fold");
        let weights = compute_weights(&folded.actions, &auth).expect("weights");
        // 300×12×1000/12 = 300_000 — the fallback claim, newest record.
        assert_eq!(weights[0].weight, 300_000);
    }

    /// A verdict landing after the first run's cutoff is invisible to that
    /// run and is picked up — paid — by the next run with a wider cutoff.
    #[test]
    fn late_verdict_appears_in_the_next_run() {
        let (s, rev) = (pk('a'), pk('r'));
        let (start, end) = (1_000u64, 2_000u64);
        let auth = authorized(&[&rev]);
        let events = vec![
            raw_event(1, &s, start + 10, Some("t1"), json!({"amount": 100, "monthsActive": 12})),
            raw_event(
                2,
                &rev,
                start + 20,
                Some("t1"),
                json!({"amount": 100, "monthsActive": 12, "reviewStatus": "accepted"}),
            ),
            // Filed in-epoch, but the verdict lands after the first cutoff.
            raw_event(3, &s, start + 30, Some("t2"), json!({"amount": 50, "monthsActive": 12})),
            raw_event(
                4,
                &rev,
                start + 50,
                Some("t2"),
                json!({"amount": 50, "monthsActive": 12, "reviewStatus": "accepted"}),
            ),
        ];
        // Run 1: the t2 verdict is after the cutoff — invisible, unpaid.
        let run1 = fold_settlement_actions(&events, start, end, start + 40).expect("fold");
        let w1 = compute_weights(&run1.actions, &auth).expect("w1");
        assert_eq!(w1[0].accepted_actions, vec!["t1"]);
        assert_eq!(w1[0].weight, 100_000);
        // Run 2 (same epoch, wider cutoff): the late verdict appears.
        let run2 = fold_settlement_actions(&events, start, end, end).expect("fold");
        let w2 = compute_weights(&run2.actions, &auth).expect("w2");
        assert_eq!(w2[0].accepted_actions, vec!["t1", "t2"]);
        assert_eq!(w2[0].weight, 150_000, "the late verdict is paid in run 2");
    }

    /// Same epoch + wider cutoff twice: claim ids are derived per accepted
    /// action, so the settled action re-derives byte-identically (the chain's
    /// one-shot claim slot can never re-pay it) and the ONLY new id binds to
    /// the delta action alone — no run-2 id covers an already-published
    /// action again. Mutation check: one id over the whole accepted set makes
    /// run 2's single new id cover t1 again — this test fails.
    #[test]
    fn wider_cutoff_rerun_ids_exclude_settled_actions() {
        let (s, rev) = (pk('a'), pk('r'));
        let (start, end) = (1_000u64, 2_000u64);
        let auth = authorized(&[&rev]);
        let events = vec![
            raw_event(1, &s, start + 10, Some("t1"), json!({"amount": 100, "monthsActive": 12})),
            raw_event(
                2,
                &rev,
                start + 20,
                Some("t1"),
                json!({"amount": 100, "monthsActive": 12, "reviewStatus": "accepted"}),
            ),
            raw_event(3, &s, start + 30, Some("t2"), json!({"amount": 50, "monthsActive": 12})),
            raw_event(
                4,
                &rev,
                start + 50,
                Some("t2"),
                json!({"amount": 50, "monthsActive": 12, "reviewStatus": "accepted"}),
            ),
        ];
        let claim_ids = |weights: &[BeneficiaryWeight]| -> BTreeSet<String> {
            weights
                .iter()
                .flat_map(|row| {
                    row.claim_weights
                        .iter()
                        .map(|(a, _)| settlement_ids(start, end, &row.beneficiary, a).0)
                })
                .collect()
        };
        let run1 = fold_settlement_actions(&events, start, end, start + 40).expect("fold");
        let w1 = compute_weights(&run1.actions, &auth).expect("w1");
        let ids1 = claim_ids(&w1);
        let run2 = fold_settlement_actions(&events, start, end, end).expect("fold");
        let w2 = compute_weights(&run2.actions, &auth).expect("w2");
        let ids2 = claim_ids(&w2);

        // The settled action's claim is byte-identical across runs…
        assert!(ids1.is_subset(&ids2));
        assert_eq!(
            w1[0].claim_weights,
            vec![("t1".to_string(), 100_000)],
            "the settled claim's mirror is unchanged by the re-run"
        );
        // …and the only NEW id binds to the delta action alone.
        let added: BTreeSet<&String> = ids2.difference(&ids1).collect();
        assert_eq!(
            added,
            [&settlement_ids(start, end, &s, "t2").0]
                .into_iter()
                .collect(),
            "the wider-cutoff run adds exactly the late action's claim id — \
             never an id that also covers the already-published t1"
        );
    }
}
