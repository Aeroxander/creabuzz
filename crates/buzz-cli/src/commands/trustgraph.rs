//! `buzz trustgraph` — the scoring-operator bridge (NIP-LP kind 37006).
//!
//! The scoring ENGINE is external and replaceable by design; this module is
//! the pipeline that turns any engine's scores into what the stack already
//! consumes:
//!
//! * `compose-root` (local) — a scores file -> the sorted-pair Merkle root,
//!   per-member proofs, and the 37006 record bundle. The leaf is
//!   `keccak256(abi.encode(member, score))` and the fold is sorted-pair —
//!   byte-identical to `TrustGatedHook.validate` and web `trust-score.ts`,
//!   so a proof this bundle emits is a proof the bucket hook accepts.
//! * `publish-root` (relay auth) — sign and publish the 37006 record
//!   (`d = <program>:<epoch>`, global-only, MessagesWrite).
//! * `rotate-gate` (chain opt-in) — `TrustGatedHook.setScoreRoot(root,
//!   minScore)`, the rotation the hook's design expects each epoch.
//!
//! The workspace data the root was computed from stays private (NIP-LP: the
//! root proves the computation, never exposes the source) — only the bundle
//! ships.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use buzz_evm_allowance::{abi, AllowanceClient, AllowanceError, EvmRpc, HttpEvmRpc};
use nostr::{EventBuilder, Kind, Tag};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::client::BuzzClient;
use crate::error::CliError;

use super::org::{validate_eth_address, ENV_EVM_RPC_URL, ENV_SPENDER_KEY};
use super::{parse_write_response, with_git_provenance};

const RPC_TIMEOUT: Duration = buzz_evm_allowance::DEFAULT_RPC_TIMEOUT;
const RECEIPT_DEADLINE: Duration = buzz_evm_allowance::DEFAULT_RECEIPT_DEADLINE;

/// `setScoreRoot(bytes32,uint256)` on TrustGatedHook (pinned to `cast sig`).
const SIG_SET_SCORE_ROOT: &str = "setScoreRoot(bytes32,uint256)";

/// The canonical program id the launchpad's community track reads.
pub const DEFAULT_PROGRAM: &str = "trustgraphs.output.nostr-member.v1";

/// One score row — the web `TrustScore` shape (`trust-score.ts`).
#[derive(Deserialize, Serialize, Clone)]
pub struct TrustScore {
    pub member: String,
    pub score: u128,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct MemberProof {
    pub score: u128,
    pub proof: Vec<String>,
}

/// The `compose-root` bundle: the 37006 record plus the proof file's body.
#[derive(Serialize, Deserialize, Clone)]
pub struct RootBundle {
    pub program: String,
    pub root: String,
    pub epoch: String,
    /// Where the per-member proofs bundle is served from. Wire name is
    /// camelCase per NIP-LP and web `trust-score.ts`.
    #[serde(rename = "indexerUrl", skip_serializing_if = "Option::is_none")]
    pub indexer_url: Option<String>,
    /// Block the scores were anchored at, when the engine records one. Wire
    /// name is camelCase per NIP-LP and web `trust-score.ts`.
    #[serde(rename = "anchorBlock", skip_serializing_if = "Option::is_none")]
    pub anchor_block: Option<u64>,
    /// member (lowercase) -> score + sorted-pair Merkle proof.
    pub proofs: BTreeMap<String, MemberProof>,
}

/// Delivery signals that feed the trust score (the corpus in
/// `scripts/trust-score-corpus.json` pins this formula on both the Rust and
/// TypeScript sides). Accepted milestone claims and contribution records
/// raise the score, scaled by tenure; slashed and rejected claims subtract at
/// the same scale. Everything floors per term and the result clamps at zero.
#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Default)]
#[serde(rename_all = "camelCase")]
pub struct DeliverySignals {
    #[serde(default)]
    pub approved_milestones: u64,
    #[serde(default)]
    pub contribution_records: u64,
    /// Explicit tenure in months; `0` is zero tenure. When the field is
    /// ABSENT (`None`), tenure is derived from [`Self::first_accepted_at`]
    /// against [`Self::reference_at`] — never a silent 12. TODO: the caller
    /// that resolves kind:37013 records (the royalty fold) should set
    /// `first_accepted_at` from the earliest accepted record's `created_at`
    /// and `reference_at` from the run's reference time.
    pub months_active: Option<u64>,
    #[serde(default)]
    pub slashed_claims: u64,
    #[serde(default)]
    pub rejected_claims: u64,
    /// Unix seconds of the earliest accepted contribution/milestone — the
    /// start of the derived tenure when `monthsActive` is absent.
    pub first_accepted_at: Option<i64>,
    /// Unix seconds the derived tenure is measured against (the scoring
    /// run's reference time).
    pub reference_at: Option<i64>,
}

/// Whole 30-day months between the first accepted work and the reference
/// time: `floor(max(0, reference_at - first_accepted_at) / 2_592_000)`,
/// capped at 12. Deterministic; a reference before the first accepted work
/// is zero.
pub fn tenure_months(first_accepted_at: i64, reference_at: i64) -> u64 {
    let elapsed = reference_at.saturating_sub(first_accepted_at).max(0) as u64;
    (elapsed / (30 * 24 * 60 * 60)).min(12)
}

/// `score = max(0, floor((approved + contributions) * months * 1000 / 12) -
/// floor((slashed + rejected) * months * 1000 / 12))`, `months =
/// min(months_active, 12)` when `monthsActive` is present (`0` = zero
/// tenure) and [`tenure_months`]`(first_accepted_at, reference_at)` when it
/// is absent and both timestamps are known — otherwise zero tenure, never a
/// silent 12. Deterministic; saturating; never panics.
pub fn delivery_score(s: &DeliverySignals) -> u128 {
    let months = u128::from(match s.months_active {
        Some(m) => m.min(12),
        None => match (s.first_accepted_at, s.reference_at) {
            (Some(first), Some(reference)) => tenure_months(first, reference),
            _ => 0,
        },
    });
    let scale = |n: u64| u128::from(n) * months * 1000 / 12;
    let good = scale(s.approved_milestones.saturating_add(s.contribution_records));
    let bad = scale(s.slashed_claims.saturating_add(s.rejected_claims));
    good.saturating_sub(bad)
}

fn cli_error(context: &'static str) -> impl Fn(AllowanceError) -> CliError {
    move |e| CliError::Other(format!("{context}: {e}"))
}

/// Leaf = `keccak256(abi.encode(member, score))` — address left-padded to 32
/// bytes, score as uint256, keccak of the 64-byte concatenation. Identical to
/// `TrustGatedHook.validate` and `launchpad_compose::trustgraph_leaf`.
pub fn leaf(member: &str, score: u128) -> Result<[u8; 32], CliError> {
    let addr = abi::parse_address(member).map_err(cli_error("bad member address"))?;
    let mut buf = Vec::with_capacity(64);
    buf.extend_from_slice(&abi::encode_address_word(&addr));
    buf.extend_from_slice(&abi::encode_uint256(score));
    Ok(abi::keccak256(&buf))
}

/// Sorted-pair node combination (the hook's fold: `node <= sibling` first).
pub fn sorted_pair(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    let mut buf = Vec::with_capacity(64);
    buf.extend_from_slice(lo);
    buf.extend_from_slice(hi);
    abi::keccak256(&buf)
}

/// Fold a leaf through its proof to the root (the verify both the hook and
/// the web module perform).
pub fn fold(leaf: [u8; 32], proof: &[[u8; 32]]) -> [u8; 32] {
    let mut node = leaf;
    for sibling in proof {
        node = sorted_pair(&node, sibling);
    }
    node
}

/// Build the tree over `scores`, sorted by member (deterministic across input
/// order). Odd levels carry the last node up alone. Refuses duplicate
/// members — a root with ambiguous leaves proves nothing.
pub fn compose(
    scores: &[TrustScore],
    program: &str,
    epoch: &str,
    indexer_url: Option<String>,
    anchor_block: Option<u64>,
) -> Result<RootBundle, CliError> {
    if scores.is_empty() {
        return Err(CliError::Other("scores file is empty".into()));
    }
    let mut rows: Vec<(String, u128, [u8; 32])> = Vec::with_capacity(scores.len());
    for s in scores {
        let l = leaf(&s.member, s.score)?;
        let member = s
            .member
            .trim()
            .trim_start_matches("0x")
            .to_ascii_lowercase();
        if rows.iter().any(|(m, _, _)| *m == member) {
            return Err(CliError::Other(format!("duplicate member 0x{member}")));
        }
        rows.push((member, s.score, l));
    }
    rows.sort_by(|a, b| a.0.cmp(&b.0));

    // Level-by-level tree; proofs walk the sibling at (i ^ 1) per level.
    let mut levels: Vec<Vec<[u8; 32]>> = Vec::new();
    let mut cur: Vec<[u8; 32]> = rows.iter().map(|r| r.2).collect();
    while cur.len() > 1 {
        let mut next = Vec::with_capacity(cur.len().div_ceil(2));
        let mut i = 0;
        while i < cur.len() {
            if i + 1 < cur.len() {
                next.push(sorted_pair(&cur[i], &cur[i + 1]));
            } else {
                next.push(cur[i]); // odd carry
            }
            i += 2;
        }
        levels.push(cur);
        cur = next;
    }
    // `rows` is non-empty above and halving stops at one node, so `cur` holds
    // exactly the root; fail typed rather than panic if that ever breaks.
    let root = cur
        .first()
        .copied()
        .ok_or_else(|| CliError::Other("internal: empty trust graph".into()))?;

    let mut proofs = BTreeMap::new();
    for (idx, (member, score, l)) in rows.iter().enumerate() {
        let mut path = Vec::new();
        let mut i = idx;
        for level in &levels {
            let sibling = i ^ 1;
            if sibling < level.len() {
                path.push(level[sibling]);
            }
            i /= 2;
        }
        // The path must fold to the root — anything else is a broken tree.
        if fold(*l, &path) != root {
            return Err(CliError::Other(format!(
                "internal: proof for 0x{member} does not fold to the root"
            )));
        }
        proofs.insert(
            member.clone(),
            MemberProof {
                score: *score,
                proof: path
                    .iter()
                    .map(|h| format!("0x{}", hex::encode(h)))
                    .collect(),
            },
        );
    }

    Ok(RootBundle {
        program: program.to_owned(),
        root: format!("0x{}", hex::encode(root)),
        epoch: epoch.to_owned(),
        indexer_url,
        anchor_block,
        proofs,
    })
}

/// The 37006 record: parameterized-replaceable, `d = <program>:<epoch>`,
/// global-only (never channel-scoped).
pub fn build_root_event(bundle: &RootBundle) -> Result<EventBuilder, CliError> {
    if bundle.program.trim().is_empty() || bundle.epoch.trim().is_empty() {
        return Err(CliError::Other("program and epoch are required".into()));
    }
    let root = bundle.root.trim();
    if !root.starts_with("0x")
        || root.len() != 66
        || !root[2..].chars().all(|c| c.is_ascii_hexdigit())
    {
        return Err(CliError::Other(format!(
            "root must be 0x + 64 hex (clients refuse malformed roots): {root:?}"
        )));
    }
    let mut content = json!({
        "program": bundle.program,
        "root": root.to_ascii_lowercase(),
        "epoch": bundle.epoch,
    });
    if let Some(u) = &bundle.indexer_url {
        content["indexerUrl"] = json!(u);
    }
    if let Some(b) = bundle.anchor_block {
        content["anchorBlock"] = json!(b);
    }
    let d = format!("{}:{}", bundle.program, bundle.epoch);
    Ok(EventBuilder::new(
        Kind::Custom(buzz_core::kind::KIND_SCORE_ROOT as u16),
        content.to_string(),
    )
    .tag(Tag::parse(["d", &d]).map_err(|e| CliError::Other(format!("bad d tag: {e}")))?)
    .tag(
        Tag::parse(["t", "dao-launchpad"])
            .map_err(|e| CliError::Other(format!("bad t tag: {e}")))?,
    ))
}

/// `setScoreRoot(bytes32,uint256)` calldata for the gate rotation.
pub fn encode_set_score_root(root: &str, min_score: u128) -> Result<Vec<u8>, CliError> {
    let root = root.trim();
    let hexpart = root.strip_prefix("0x").unwrap_or(root);
    if hexpart.len() != 64 || !hexpart.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(CliError::Other(format!(
            "root must be 0x + 64 hex: {root:?}"
        )));
    }
    let mut data = abi::selector(SIG_SET_SCORE_ROOT).to_vec();
    data.extend_from_slice(
        &hex::decode(hexpart).map_err(|e| CliError::Other(format!("root: {e}")))?,
    );
    data.extend_from_slice(&abi::encode_uint256(min_score));
    Ok(data)
}

// ── CLI commands ────────────────────────────────────────────────────────────

/// One scores-file row: either a literal `score`, or delivery `signals` the
/// score derives from (`compose-root` counts milestones/contributions scaled
/// by tenure and subtracts slashed/rejected — the plan's trust-score inputs).
#[derive(serde::Deserialize)]
struct ScoreRow {
    member: String,
    score: Option<u128>,
    #[serde(flatten)]
    signals: DeliverySignals,
}

fn read_scores(path: &str) -> Result<Vec<TrustScore>, CliError> {
    let raw = if path == "-" {
        use std::io::Read;
        let mut s = String::new();
        std::io::stdin()
            .read_to_string(&mut s)
            .map_err(|e| CliError::Other(format!("stdin: {e}")))?;
        s
    } else {
        std::fs::read_to_string(path).map_err(|e| CliError::Other(format!("read {path}: {e}")))?
    };
    let rows: Vec<ScoreRow> =
        serde_json::from_str(&raw).map_err(|e| CliError::Other(format!("scores JSON: {e}")))?;
    Ok(rows
        .into_iter()
        .map(|r| TrustScore {
            score: r.score.unwrap_or_else(|| delivery_score(&r.signals)),
            member: r.member,
        })
        .collect())
}

/// `buzz trustgraph compose-root` — scores file -> root bundle (local).
#[allow(clippy::too_many_arguments)]
pub fn cmd_compose_root(
    program: &str,
    epoch: &str,
    scores: &str,
    proofs_out: Option<&str>,
    indexer_url: Option<&str>,
    anchor_block: Option<u64>,
) -> Result<(), CliError> {
    let rows = read_scores(scores)?;
    let bundle = compose(
        &rows,
        program,
        epoch,
        indexer_url.map(|s| s.to_owned()),
        anchor_block,
    )?;
    if let Some(path) = proofs_out {
        let body = serde_json::to_string_pretty(&bundle.proofs)
            .map_err(|e| CliError::Other(format!("serialize proofs: {e}")))?;
        std::fs::write(path, body).map_err(|e| CliError::Other(format!("write {path}: {e}")))?;
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&bundle)
            .map_err(|e| CliError::Other(format!("serialize bundle: {e}")))?
    );
    Ok(())
}

/// `buzz trustgraph rotate-gate` — `TrustGatedHook.setScoreRoot` (chain
/// opt-in: BUZZ_EVM_RPC_URL + BUZZ_SPENDER_KEY, the hook owner's key).
pub async fn cmd_rotate_gate(
    hook: &str,
    root: &str,
    min_score: u128,
    dry_run: bool,
) -> Result<(), CliError> {
    let hook = validate_eth_address(hook, "hook address")?;
    let data = encode_set_score_root(root, min_score)?;
    if dry_run {
        println!(
            "{}",
            json!({ "to": hook, "data": format!("0x{}", hex::encode(&data)) })
        );
        return Ok(());
    }
    let rpc_url = std::env::var(ENV_EVM_RPC_URL)
        .ok()
        .filter(|v| !v.is_empty());
    let spender_key = std::env::var(ENV_SPENDER_KEY)
        .ok()
        .filter(|v| !v.is_empty());
    let (Some(rpc_url), Some(spender_key)) = (rpc_url, spender_key) else {
        return Err(CliError::Usage(format!(
            "rotate-gate is opt-in: set {ENV_EVM_RPC_URL} and {ENV_SPENDER_KEY} (the hook owner's key)"
        )));
    };
    let clean = spender_key.trim().trim_start_matches("0x");
    let key_bytes = hex::decode(clean)
        .map_err(|e| CliError::Usage(format!("invalid {ENV_SPENDER_KEY} hex: {e}")))?;
    let spender = k256::ecdsa::SigningKey::from_slice(&key_bytes)
        .map_err(|e| CliError::Usage(format!("invalid {ENV_SPENDER_KEY}: {e}")))?;

    let rpc: Arc<dyn EvmRpc> = Arc::new(HttpEvmRpc::new(&rpc_url).map_err(cli_error("rpc init"))?);
    let tx_client = AllowanceClient::from_transport(rpc, &hook)
        .map_err(cli_error("tx client"))?
        .with_rpc_timeout(RPC_TIMEOUT)
        .with_receipt_deadline(RECEIPT_DEADLINE);
    let receipt = tx_client
        .send_contract_tx(&spender, &data)
        .await
        .map_err(|e| match e {
            AllowanceError::SpendRejectedByContract { detail } => CliError::Other(format!(
                "the hook refused the rotation at simulation; nothing was broadcast: {detail}"
            )),
            AllowanceError::SpendReverted { tx_hash } => CliError::Other(format!(
                "rotation transaction {tx_hash} reverted onchain"
            )),
            AllowanceError::SpendUnconfirmed { .. } => CliError::Other(
                "rotation not confirmed within the deadline — check the receipt; do NOT re-submit blindly"
                    .to_string(),
            ),
            other => CliError::Other(format!("rotate-gate failed: {other}")),
        })?;
    println!(
        "{}",
        json!({ "status": "ok", "txHash": receipt.tx_hash, "hook": hook, "root": root, "minScore": min_score.to_string() })
    );
    Ok(())
}

/// `buzz trustgraph publish-root` — sign and publish the 37006 record
/// (relay auth). From a `compose-root` bundle or explicit fields.
pub async fn dispatch(sub: crate::TrustgraphCmd, client: &BuzzClient) -> Result<(), CliError> {
    use crate::TrustgraphCmd::*;
    let (program, epoch, root, indexer_url, anchor_block) = match sub {
        PublishRoot {
            program,
            epoch,
            root,
            from_bundle,
            indexer_url,
            anchor_block,
        } => {
            if let Some(path) = from_bundle {
                let raw = std::fs::read_to_string(&path)
                    .map_err(|e| CliError::Other(format!("read {path}: {e}")))?;
                let b: RootBundle = serde_json::from_str(&raw)
                    .map_err(|e| CliError::Other(format!("bundle JSON: {e}")))?;
                (b.program, b.epoch, b.root, b.indexer_url, b.anchor_block)
            } else {
                (
                    program.unwrap_or_else(|| DEFAULT_PROGRAM.to_owned()),
                    epoch.ok_or_else(|| CliError::Usage("--epoch is required".into()))?,
                    root.ok_or_else(|| {
                        CliError::Usage("--root or --from-bundle is required".into())
                    })?,
                    indexer_url,
                    anchor_block,
                )
            }
        }
        _ => {
            return Err(CliError::Usage(
                "trustgraph publish-root needs a relay identity (it runs after auth); \
                 compose-root and rotate-gate run before it"
                    .into(),
            ))
        }
    };

    let bundle = RootBundle {
        program,
        root,
        epoch,
        indexer_url,
        anchor_block,
        proofs: BTreeMap::new(), // the record carries the root; proofs live at indexerUrl
    };
    let builder = build_root_event(&bundle)?;
    let event = with_git_provenance(builder)?
        .sign_with_keys(client.keys())
        .map_err(|e| CliError::Other(format!("sign: {e}")))?;
    let raw = client.submit_event(event).await?;
    let response = parse_write_response(&raw, "score root already published for this epoch")?;
    println!(
        "{}",
        json!({ "status": "ok", "root": bundle.root, "epoch": bundle.epoch, "response": response })
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Goldens computed with `cast abi-encode` + `cast keccak`.
    const DEAD: &str = "0x000000000000000000000000000000000000dEaD";
    const ONE: &str = "0x0000000000000000000000000000000000000001";
    const LEAF_DEAD_5: &str = "7d509c07f0d4edcc2dd1b53aae68677132eb562dcba78e36381b63ccaf66e6ba";
    const LEAF_ONE_7: &str = "b39221ace053465ec3453ce2b36430bd138b997ecea25c1043da0c366812b828";
    const ROOT_2: &str = "6c14f5a201d551a317b28659230799f758bc2657de1fbc446edcd26413ccb9bf";

    #[test]
    fn leaves_match_cast_keccak_and_the_launchpad_composer() {
        assert_eq!(hex::encode(leaf(DEAD, 5).unwrap()), LEAF_DEAD_5);
        assert_eq!(hex::encode(leaf(ONE, 7).unwrap()), LEAF_ONE_7);
        // The CCA-side leaf helper emits the preimage as HEX TEXT; decoded,
        // it must agree byte for byte with this module's raw preimage.
        let mut raw = Vec::with_capacity(64);
        let addr = abi::parse_address(DEAD).unwrap();
        raw.extend_from_slice(&abi::encode_address_word(&addr));
        raw.extend_from_slice(&abi::encode_uint256(5));
        let composed = super::super::launchpad_compose::trustgraph_leaf(DEAD, 5).unwrap();
        assert_eq!(
            hex::decode(&composed).expect("composer emits hex text"),
            raw,
            "same leaf preimage after hex decode"
        );
    }

    #[test]
    fn two_leaf_root_matches_cast() {
        let rows = vec![
            TrustScore {
                member: DEAD.into(),
                score: 5,
            },
            TrustScore {
                member: ONE.into(),
                score: 7,
            },
        ];
        let b = compose(&rows, DEFAULT_PROGRAM, "12", None, None).unwrap();
        assert_eq!(b.root, format!("0x{ROOT_2}"));
        // Every emitted proof folds back to the root (the hook's verify).
        for (member, mp) in &b.proofs {
            let l = leaf(member, mp.score).unwrap();
            let path: Vec<[u8; 32]> = mp
                .proof
                .iter()
                .map(|h| {
                    hex::decode(h.trim_start_matches("0x"))
                        .unwrap()
                        .try_into()
                        .unwrap()
                })
                .collect();
            assert_eq!(hex::encode(fold(l, &path)), ROOT_2, "proof for {member}");
        }
    }

    /// The corpus in `scripts/trust-score-corpus.json` pins the delivery
    /// formula; the TypeScript port reads the same file (`trust-score.test.mjs`).
    /// Removing the slashed/rejected subtraction reds this test.
    #[test]
    fn delivery_score_matches_the_shared_corpus() {
        let raw = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../scripts/trust-score-corpus.json"
        ))
        .expect("trust-score corpus is readable");
        let v: serde_json::Value = serde_json::from_str(&raw).expect("corpus JSON");
        let cases = v["cases"].as_array().expect("cases");
        assert!(!cases.is_empty(), "corpus must pin at least one case");
        for case in cases {
            let i = &case["inputs"];
            let signals = DeliverySignals {
                approved_milestones: i["approvedMilestones"].as_u64().unwrap_or(0),
                contribution_records: i["contributionRecords"].as_u64().unwrap_or(0),
                // Option distinguishes an explicit 0 (zero tenure) from an
                // absent field (derived tenure) — the corpus pins both.
                months_active: i["monthsActive"].as_u64(),
                slashed_claims: i["slashedClaims"].as_u64().unwrap_or(0),
                rejected_claims: i["rejectedClaims"].as_u64().unwrap_or(0),
                first_accepted_at: i["firstAcceptedAt"].as_i64(),
                reference_at: i["referenceAt"].as_i64(),
            };
            assert_eq!(
                delivery_score(&signals),
                case["score"].as_u64().expect("score") as u128,
                "case {:?} diverged from the corpus formula",
                case["name"]
            );
        }
    }

    fn input_order_does_not_change_the_root() {
        let a = vec![
            TrustScore {
                member: DEAD.into(),
                score: 5,
            },
            TrustScore {
                member: ONE.into(),
                score: 7,
            },
            TrustScore {
                member: "0x0000000000000000000000000000000000000002".into(),
                score: 9,
            },
        ];
        let mut shuffled = a.clone();
        shuffled.swap(0, 2);
        let b1 = compose(&a, DEFAULT_PROGRAM, "1", None, None).unwrap();
        let b2 = compose(&shuffled, DEFAULT_PROGRAM, "1", None, None).unwrap();
        assert_eq!(b1.root, b2.root, "sorted-by-member determinism");
        // Odd-leaf tree: every proof still folds (the odd node carries up).
        for (member, mp) in &b1.proofs {
            let l = leaf(member, mp.score).unwrap();
            let path: Vec<[u8; 32]> = mp
                .proof
                .iter()
                .map(|h| {
                    hex::decode(h.trim_start_matches("0x"))
                        .unwrap()
                        .try_into()
                        .unwrap()
                })
                .collect();
            assert_eq!(
                format!("0x{}", hex::encode(fold(l, &path))),
                b1.root,
                "odd-tree proof for {member}"
            );
        }
    }

    #[test]
    fn duplicates_and_empty_inputs_are_refused() {
        let dup = vec![
            TrustScore {
                member: DEAD.into(),
                score: 5,
            },
            TrustScore {
                member: DEAD.into(),
                score: 6,
            },
        ];
        assert!(compose(&dup, DEFAULT_PROGRAM, "1", None, None).is_err());
        assert!(compose(&[], DEFAULT_PROGRAM, "1", None, None).is_err());
    }

    /// The record's shape: kind 37006, `d = program:epoch`, well-formed root
    /// enforced before anything is signed (clients refuse malformed roots).
    #[test]
    fn root_event_shape() {
        let rows = vec![TrustScore {
            member: DEAD.into(),
            score: 5,
        }];
        let mut b = compose(
            &rows,
            DEFAULT_PROGRAM,
            "12",
            Some("https://idx".into()),
            Some(42),
        )
        .unwrap();
        let ev = build_root_event(&b)
            .unwrap()
            .sign_with_keys(&nostr::Keys::generate())
            .unwrap();
        assert_eq!(
            ev.kind,
            Kind::Custom(buzz_core::kind::KIND_SCORE_ROOT as u16)
        );
        assert!(ev
            .tags
            .iter()
            .any(|t| t.as_slice() == ["d", &format!("{DEFAULT_PROGRAM}:12")]));
        let content: serde_json::Value = serde_json::from_str(&ev.content).unwrap();
        assert_eq!(content["program"], DEFAULT_PROGRAM);
        assert_eq!(content["epoch"], "12");
        assert_eq!(content["indexerUrl"], "https://idx");
        assert_eq!(content["anchorBlock"], 42);

        b.root = "0x1234".into();
        assert!(build_root_event(&b).is_err(), "malformed root refused");
    }

    #[test]
    fn set_score_root_selector_pinned_to_cast_sig() {
        assert_eq!(hex::encode(abi::selector(SIG_SET_SCORE_ROOT)), "0355f302");
        let data = encode_set_score_root(&format!("0x{ROOT_2}"), 60).unwrap();
        assert_eq!(&data[..4], &abi::selector(SIG_SET_SCORE_ROOT));
        assert_eq!(data.len(), 4 + 32 + 32);
    }
}
