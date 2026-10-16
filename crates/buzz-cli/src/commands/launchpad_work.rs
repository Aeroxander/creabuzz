//! `buzz launchpad work …` — the contributor path as plain commands: a funded mandate, an approved project, a
//! claim, its reviewers, its payout and the Shares it earns.
//!
//! Two kinds of step, because the chain has two kinds of actor:
//!
//! * **Proposals** (`mandate`, `project`, `award`) are things the DAO does by vote. They only *compose* the intent
//!   (target, calldata, a nonce) and print it, with the `buzz launchpad propose` line that opens it. Nothing is sent.
//! * **Steps** (`claim`, `check`, `bind`, `attest`, `settle`, `payout`) are a person acting as themselves. They are
//!   chain-local and opt-in like `launchpad vote`: set `BUZZ_EVM_RPC_URL` and `BUZZ_SPENDER_KEY`.
//!
//! `state` reads where a claim stands, so an agent never has to guess what to do next.
//!
//! Identifiers (`--id`, `--project`, `--claim`) are either a `0x` + 64 hex word or a short label of up to 32 bytes
//! (the same as Solidity's `bytes32("label")`). Currency amounts are whole units with `--decimals`; Shares are
//! always 18 decimals. Calldata is pinned against `cast calldata` in the tests.

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use buzz_evm_allowance::{abi, EvmRpc, HttpEvmRpc};
use clap::{Args, Subcommand};
use num_bigint::BigUint;
use serde_json::json;

use crate::error::CliError;

use super::launchpad_gov::{load_chain, send_contract_call};
use super::org::{validate_eth_address, ENV_EVM_RPC_URL};

const RPC_TIMEOUT: Duration = buzz_evm_allowance::DEFAULT_RPC_TIMEOUT;

const SIG_APPROVE: &str = "approve(address,uint256)";
const SIG_CREATE_MANDATE: &str =
    "create(address,uint128,uint128,uint128,uint128,uint64,address[],uint256,uint128,address)";
const SIG_BATCH_CALLS: &str = "batchCalls((address,uint256,bytes)[])";
const SIG_APPROVE_PROJECT: &str = "approveProject(bytes32,address,uint128,uint128,uint64,bytes32)";
const SIG_AWARD: &str = "awardContribution(address,bytes32,uint96,bool)";
const SIG_SUBMIT_CLAIM: &str = "submitClaim(bytes32,uint256,uint256,bytes32)";
const SIG_SET_CHECK: &str = "setCheck(bytes32,bytes32)";
const SIG_FUND_MILESTONE: &str = "fundMilestone(bytes32,bytes32,address)";
const SIG_BIND_MILESTONE: &str = "bindMilestone(bytes32)";
const SIG_ATTEST: &str = "attest(bytes32,bool)";
const SIG_SETTLE: &str = "settle(bytes32)";
const SIG_PAYOUT: &str = "payout(bytes32)";
const SIG_MANDATE_CLAIMS: &str = "claims()";
const SIG_MANDATE_VERIFIERS: &str = "verifiers()";
const SIG_CLAIM: &str = "claims(bytes32)";
const SIG_CLAIM_PROJECT: &str = "claimProject(bytes32)";
const SIG_AWARDED: &str = "contributionAwarded(bytes32)";
const SIG_CHALLENGE_WINDOW: &str = "challengeWindow()";
const SIG_APPROVAL_COUNT: &str = "approvalCount(bytes32)";
const SIG_OBJECTION_COUNT: &str = "objectionCount(bytes32)";
const SIG_QUORUM: &str = "quorum()";
const SIG_DAO_SHARES: &str = "shares()";
const SIG_SHARES_LOCK_GUARD: &str = "lockGuard()";
const SIG_UNLOCK: &str = "unlock(address,uint256,address,bytes32)";
const SIG_LOCKED_OF: &str = "lockedOf(address)";
const SIG_TRANCHE_COUNT: &str = "trancheCount(address)";
const SIG_TRANCHE_OF: &str = "trancheOf(address,uint256)";
/// `MilestoneLock.MAX_TRANCHES`: a lock never has more, so a longer answer is not read further.
const MAX_LOCK_TRANCHES: u64 = 8;

/// `ClaimStake.Status` in declaration order.
const CLAIM_STATES: [&str; 7] = [
    "Open",
    "Approved",
    "Rejected",
    "Frozen",
    "Paid",
    "Recovered",
    "Expired",
];

/// One step of the contributor path.
#[derive(Subcommand)]
pub enum WorkCmd {
    /// Compose the vote that creates a mandate: a budget of currency, of Shares, or both
    Mandate(MandateArgs),
    /// Compose the vote that approves a project inside a mandate
    Project(ProjectArgs),
    /// Compose the vote that awards Shares for an approved claim
    Award(AwardArgs),
    /// File a claim for work (contributor)
    Claim(ClaimArgs),
    /// State the acceptance check a claim will be judged against (contributor, before a reviewer looks)
    Check(CheckArgs),
    /// Bind a claim to a project, reserving its payment if it asks for one (project manager)
    Bind(BindArgs),
    /// Approve or object to a claim (reviewer)
    Attest(AttestArgs),
    /// Settle a claim once reviewers reached their quorum (anyone)
    Settle(ClaimRefArgs),
    /// Take a claim's payout and stake back after the challenge window (contributor)
    Payout(ClaimRefArgs),
    /// Read where a claim stands and what happens next
    State(ClaimRefArgs),
    /// Read the Shares a team member still has locked and the milestones that free them
    Locks(LocksArgs),
    /// Unlock a milestone's Shares with a paid claim of the holder's (anyone)
    Unlock(UnlockArgs),
}

#[derive(Args)]
pub struct MandateArgs {
    /// The DAO that will vote on it (`0x…`)
    #[arg(long)]
    pub dao: String,
    /// The mandate factory the DAO's policy names (`0x…`)
    #[arg(long)]
    pub factory: String,
    /// Currency claims are paid and staked in (`0x…`)
    #[arg(long)]
    pub currency: String,
    /// Decimals of that currency (read it from the token; there is no safe default)
    #[arg(long)]
    pub decimals: Option<u8>,
    /// Currency the mandate may spend in total, in whole units; omit for a Shares-only mandate
    #[arg(long)]
    pub budget: Option<String>,
    /// Most currency one project may hold, in whole units (required with --budget)
    #[arg(long)]
    pub cap: Option<String>,
    /// Shares the mandate may cause to be awarded in total, 18 decimals; omit for a currency-only mandate
    #[arg(long)]
    pub share_budget: Option<String>,
    /// Most Shares one project may award (required with --share-budget)
    #[arg(long)]
    pub share_cap: Option<String>,
    /// When the mandate ends, in unix seconds (or use --expires-in-days)
    #[arg(long)]
    pub expires: Option<u64>,
    /// When the mandate ends, as days from now
    #[arg(long)]
    pub expires_in_days: Option<u64>,
    /// A reviewer's address; repeat for each (at most 32)
    #[arg(long = "reviewer")]
    pub reviewers: Vec<String>,
    /// Reviewers who must agree to approve or reject a claim
    #[arg(long)]
    pub quorum: u64,
    /// The bond each reviewer must post before judging a claim, in whole units of the bond token (the currency unless
    /// --reviewer-bond-token says otherwise; needs --decimals or --reviewer-bond-decimals); omit for none. The DAO
    /// can take it after a disputed approval
    #[arg(long)]
    pub reviewer_bond: Option<String>,
    /// The token the bond is paid in (`0x…`); omit for the claim currency, the safest choice. The project's own
    /// token or any other works, but a bond only deters if it keeps its value and nobody involved can freeze or
    /// inflate it
    #[arg(long)]
    pub reviewer_bond_token: Option<String>,
    /// Decimals of the bond token (required with --reviewer-bond-token: there is no safe default)
    #[arg(long)]
    pub reviewer_bond_decimals: Option<u8>,
    /// The proposal nonce (0x + 64 hex); a fresh one is made when omitted
    #[arg(long)]
    pub nonce: Option<String>,
}

#[derive(Args)]
pub struct ProjectArgs {
    /// The DAO that will vote on it (`0x…`)
    #[arg(long)]
    pub dao: String,
    /// The mandate the project belongs to (`0x…`)
    #[arg(long)]
    pub mandate: String,
    /// The project's id
    #[arg(long)]
    pub id: String,
    /// The manager who binds the project's claims (`0x…`)
    #[arg(long)]
    pub manager: String,
    /// Currency the project may reserve, in whole units (0 or omitted: none)
    #[arg(long)]
    pub amount: Option<String>,
    /// Decimals of the mandate's currency (needed with --amount)
    #[arg(long)]
    pub decimals: Option<u8>,
    /// Shares the project may award, 18 decimals (0 or omitted: none)
    #[arg(long)]
    pub shares: Option<String>,
    /// When the project ends, in unix seconds (or use --expires-in-days)
    #[arg(long)]
    pub expires: Option<u64>,
    /// When the project ends, as days from now
    #[arg(long)]
    pub expires_in_days: Option<u64>,
    /// The acceptance check every claim in it is judged against: a `0x` hash, or use --check-text
    #[arg(long)]
    pub check: Option<String>,
    /// The acceptance check in words; its keccak256 is used
    #[arg(long)]
    pub check_text: Option<String>,
    /// A project in the DAO's milestone panel holds nothing: no money, no Shares. It only lets one of the team's
    /// milestones be judged, against its exact words (--check-text)
    #[arg(long)]
    pub milestone: bool,
    /// The proposal nonce (0x + 64 hex); a fresh one is made when omitted
    #[arg(long)]
    pub nonce: Option<String>,
}

#[derive(Args)]
pub struct AwardArgs {
    /// The DAO that will vote on it (`0x…`)
    #[arg(long)]
    pub dao: String,
    /// The mandate the claim belongs to (`0x…`)
    #[arg(long)]
    pub mandate: String,
    /// The approved claim being recognised
    #[arg(long)]
    pub claim: String,
    /// Shares to award, 18 decimals
    #[arg(long)]
    pub shares: String,
    /// Turn the contributor's Loot into Shares instead of minting new ones
    #[arg(long, default_value_t = false)]
    pub convert: bool,
    /// The proposal nonce (0x + 64 hex); a fresh one is made when omitted
    #[arg(long)]
    pub nonce: Option<String>,
}

#[derive(Args)]
pub struct ClaimArgs {
    /// The mandate the claim is filed under (`0x…`)
    #[arg(long)]
    pub mandate: String,
    /// The claim's id
    #[arg(long)]
    pub id: String,
    /// Currency the claim asks to be paid, in whole units (0 or omitted: it asks to be recognised, not paid)
    #[arg(long)]
    pub amount: Option<String>,
    /// Currency staked as a guarantee, returned on approval and slashed on rejection (0 or omitted: none)
    #[arg(long)]
    pub stake: Option<String>,
    /// Decimals of the mandate's currency (needed with --amount or --stake)
    #[arg(long)]
    pub decimals: Option<u8>,
    /// Hash of the evidence: a `0x` hash, or use --evidence-file
    #[arg(long)]
    pub evidence: Option<String>,
    /// A file whose keccak256 is the evidence hash
    #[arg(long)]
    pub evidence_file: Option<String>,
}

#[derive(Args)]
pub struct CheckArgs {
    /// The mandate the claim is filed under (`0x…`)
    #[arg(long)]
    pub mandate: String,
    /// The claim's id
    #[arg(long)]
    pub id: String,
    /// The acceptance check: a `0x` hash, or use --check-text
    #[arg(long)]
    pub check: Option<String>,
    /// The acceptance check in words; its keccak256 is used
    #[arg(long)]
    pub check_text: Option<String>,
}

#[derive(Args)]
pub struct BindArgs {
    /// The mandate (`0x…`)
    #[arg(long)]
    pub mandate: String,
    /// The project the claim is bound to (not for --milestone)
    #[arg(long, default_value = "")]
    pub project: String,
    /// The claim's id
    #[arg(long)]
    pub id: String,
    /// Who you mean to bind: the contributor's address. A claim id is first come, first served, so this refuses
    /// a claim someone else filed under the id you were told (not for --milestone, where you bind your own claim)
    #[arg(long, default_value = "")]
    pub contributor: String,
    /// File your own milestone claim into the DAO's milestone panel: no project and no manager. The claim must be
    /// yours, ask for no money, and state as its check the exact words of one of your tranches still locked
    #[arg(long)]
    pub milestone: bool,
}

#[derive(Args)]
pub struct AttestArgs {
    /// The mandate (`0x…`)
    #[arg(long)]
    pub mandate: String,
    /// The claim's id
    #[arg(long)]
    pub id: String,
    /// approve | object
    #[arg(long)]
    pub verdict: String,
}

#[derive(Args)]
pub struct ClaimRefArgs {
    /// The mandate (`0x…`)
    #[arg(long)]
    pub mandate: String,
    /// The claim's id
    #[arg(long)]
    pub id: String,
}

#[derive(Args)]
pub struct LocksArgs {
    /// The DAO whose Shares are locked (`0x…`)
    #[arg(long)]
    pub dao: String,
    /// The team member to read (`0x…`); defaults to the wallet in BUZZ_SPENDER_KEY
    #[arg(long)]
    pub holder: Option<String>,
}

#[derive(Args)]
pub struct UnlockArgs {
    /// The DAO whose Shares are locked (`0x…`)
    #[arg(long)]
    pub dao: String,
    /// Whose Shares to unlock (`0x…`): the wallet that filed the claim
    #[arg(long)]
    pub beneficiary: String,
    /// Which milestone, counting from 0 (see `work locks`)
    #[arg(long)]
    pub index: u64,
    /// The mandate the claim was filed in (`0x…`); it must be one this DAO created
    #[arg(long)]
    pub mandate: String,
    /// The claim's id
    #[arg(long)]
    pub id: String,
}

/// Dispatch one step.
pub async fn run(step: &WorkCmd) -> Result<(), CliError> {
    match step {
        WorkCmd::Mandate(args) => cmd_mandate(args),
        WorkCmd::Project(args) => cmd_project(args),
        WorkCmd::Award(args) => cmd_award(args),
        WorkCmd::Claim(args) => cmd_claim(args).await,
        WorkCmd::Check(args) => cmd_check(args).await,
        WorkCmd::Bind(args) => cmd_bind(args).await,
        WorkCmd::Attest(args) => cmd_attest(args).await,
        WorkCmd::Settle(args) => cmd_settle(args).await,
        WorkCmd::Payout(args) => cmd_payout(args).await,
        WorkCmd::State(args) => cmd_state(args).await,
        WorkCmd::Locks(args) => cmd_locks(args).await,
        WorkCmd::Unlock(args) => cmd_unlock(args).await,
    }
}

// ── encoding ────────────────────────────────────────────────────────────────────────────────

/// An id as a 32-byte word: a `0x` + 64 hex word as it is, or a short label as Solidity's `bytes32("label")`.
pub fn bytes32_arg(value: &str, what: &str) -> Result<[u8; 32], CliError> {
    let trimmed = value.trim();
    if let Some(hex_part) = trimmed.strip_prefix("0x") {
        if hex_part.len() != 64 || !hex_part.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(CliError::Usage(format!(
                "{what} starts with 0x, so it must be 0x + 64 hex characters (got {trimmed:?}); \
                 a label cannot start with 0x"
            )));
        }
        let mut out = [0u8; 32];
        out.copy_from_slice(
            &hex::decode(hex_part).map_err(|e| CliError::Usage(format!("{what}: {e}")))?,
        );
        return Ok(out);
    }
    let bytes = trimmed.as_bytes();
    if bytes.is_empty() || bytes.len() > 32 {
        return Err(CliError::Usage(format!(
            "{what} is a label of 1 to 32 bytes, or a 0x + 64 hex word (got {} bytes)",
            bytes.len()
        )));
    }
    let mut out = [0u8; 32];
    out[..bytes.len()].copy_from_slice(bytes);
    Ok(out)
}

pub(crate) fn word_of(value: &BigUint) -> [u8; 32] {
    let raw = value.to_bytes_be();
    let mut out = [0u8; 32];
    out[32 - raw.len()..].copy_from_slice(&raw);
    out
}

/// A decimal amount in whole units as base units, with at most `decimals` fractional digits, fitting `max_bits`.
pub fn scaled_units(
    value: &str,
    decimals: u8,
    max_bits: u64,
    what: &str,
) -> Result<BigUint, CliError> {
    let trimmed = value.trim();
    let parts: Vec<&str> = trimmed.split('.').collect();
    let bad = || {
        CliError::Usage(format!(
            "{what} must be a plain nonnegative number with at most {decimals} decimals (got {value:?})"
        ))
    };
    if parts.is_empty()
        || parts.len() > 2
        || parts[0].is_empty()
        || !parts[0].bytes().all(|b| b.is_ascii_digit())
    {
        return Err(bad());
    }
    let fraction = parts.get(1).copied().unwrap_or("");
    if (parts.len() == 2 && fraction.is_empty())
        || fraction.len() > decimals as usize
        || !fraction.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(bad());
    }
    let raw = format!(
        "{}{}{}",
        parts[0],
        fraction,
        "0".repeat(decimals as usize - fraction.len())
    );
    let units = BigUint::parse_bytes(raw.as_bytes(), 10).ok_or_else(bad)?;
    if units.bits() > max_bits {
        return Err(CliError::Usage(format!(
            "{what} is too large: it must fit in {max_bits} bits of base units"
        )));
    }
    Ok(units)
}

fn units_or_zero(
    value: Option<&str>,
    decimals: u8,
    max_bits: u64,
    what: &str,
) -> Result<BigUint, CliError> {
    match value {
        Some(v) => scaled_units(v, decimals, max_bits, what),
        None => Ok(BigUint::from(0u8)),
    }
}

pub(crate) fn address_word(value: &str, what: &str) -> Result<[u8; 32], CliError> {
    let address = abi::parse_address(&validate_eth_address(value, what)?)
        .map_err(|e| CliError::Usage(format!("{what}: {e}")))?;
    Ok(abi::encode_address_word(&address))
}

fn address_bytes(value: &str, what: &str) -> Result<[u8; 20], CliError> {
    abi::parse_address(&validate_eth_address(value, what)?)
        .map_err(|e| CliError::Usage(format!("{what}: {e}")))
}

pub(crate) fn call(signature: &str, words: &[[u8; 32]]) -> Vec<u8> {
    let mut out = abi::selector(signature).to_vec();
    for word in words {
        out.extend_from_slice(word);
    }
    out
}

pub(crate) fn u64_word(value: u64) -> [u8; 32] {
    abi::encode_uint256(value as u128)
}

/// The end of something, from either an absolute time or days from `now`; never in the past.
fn expiry(
    absolute: Option<u64>,
    in_days: Option<u64>,
    now: u64,
    what: &str,
) -> Result<u64, CliError> {
    let at = match (absolute, in_days) {
        (Some(_), Some(_)) => {
            return Err(CliError::Usage(format!(
                "give {what} as --expires or --expires-in-days, not both"
            )))
        }
        (Some(at), None) => at,
        (None, Some(days)) => now
            .checked_add(days.saturating_mul(86_400))
            .ok_or_else(|| CliError::Usage(format!("{what} is too far away")))?,
        (None, None) => {
            return Err(CliError::Usage(format!(
                "say when {what} ends: --expires <unix seconds> or --expires-in-days <n>"
            )))
        }
    };
    if at <= now {
        return Err(CliError::Usage(format!("{what} must be in the future")));
    }
    Ok(at)
}

/// A hash from a `0x` word or from text (keccak256).
fn hash_arg(hash: Option<&str>, text: Option<&str>, what: &str) -> Result<[u8; 32], CliError> {
    match (hash, text) {
        (Some(_), Some(_)) => Err(CliError::Usage(format!(
            "give the {what} as a hash or as text, not both"
        ))),
        (Some(h), None) => bytes32_arg(h, what).and_then(|w| {
            if h.trim().starts_with("0x") {
                Ok(w)
            } else {
                Err(CliError::Usage(format!(
                    "the {what} hash must be 0x + 64 hex characters; use the text option to hash words"
                )))
            }
        }),
        // Trimmed, so a check typed here hashes exactly as the same words typed in the app.
        (None, Some(t)) if !t.trim().is_empty() => Ok(abi::keccak256(t.trim().as_bytes())),
        _ => Err(CliError::Usage(format!(
            "give the {what} as a 0x hash or as text"
        ))),
    }
}

/// Everything `TreasuryMandateFactory.create(...)` takes.
pub struct MandateTerms<'a> {
    pub currency: &'a str,
    pub budget: &'a BigUint,
    pub cap: &'a BigUint,
    pub share_budget: &'a BigUint,
    pub share_cap: &'a BigUint,
    pub expires: u64,
    pub reviewers: &'a [String],
    pub quorum: u64,
    pub reviewer_bond: &'a BigUint,
    /// What the bond is paid in; the zero address when there is no bond.
    pub bond_token: &'a str,
}

/// `TreasuryMandateFactory.create(...)` for the reviewers and budgets given.
pub fn encode_create_mandate(terms: &MandateTerms) -> Result<Vec<u8>, CliError> {
    let MandateTerms {
        currency,
        budget,
        cap,
        share_budget,
        share_cap,
        expires,
        reviewers,
        quorum,
        reviewer_bond,
        bond_token,
    } = *terms;
    if reviewers.is_empty() || reviewers.len() > 32 {
        return Err(CliError::Usage(
            "a mandate needs 1 to 32 reviewers (--reviewer, repeated)".into(),
        ));
    }
    if quorum == 0 || quorum > reviewers.len() as u64 {
        return Err(CliError::Usage(format!(
            "the quorum is how many of the {} reviewers must agree: 1 to {}",
            reviewers.len(),
            reviewers.len()
        )));
    }
    let mut out = abi::selector(SIG_CREATE_MANDATE).to_vec();
    out.extend_from_slice(&address_word(currency, "currency")?);
    out.extend_from_slice(&word_of(budget));
    out.extend_from_slice(&word_of(cap));
    out.extend_from_slice(&word_of(share_budget));
    out.extend_from_slice(&word_of(share_cap));
    out.extend_from_slice(&u64_word(expires));
    out.extend_from_slice(&u64_word(0x140)); // the reviewers array follows the ten head words
    out.extend_from_slice(&u64_word(quorum));
    out.extend_from_slice(&word_of(reviewer_bond));
    out.extend_from_slice(&address_word(bond_token, "bond token")?);
    out.extend_from_slice(&u64_word(reviewers.len() as u64));
    for reviewer in reviewers {
        out.extend_from_slice(&address_word(reviewer, "reviewer")?);
    }
    Ok(out)
}

/// `Moloch.batchCalls((target, value, data)[])`: the DAO runs several calls in one vote.
pub fn encode_batch_calls(calls: &[([u8; 20], Vec<u8>)]) -> Vec<u8> {
    let mut tuples: Vec<Vec<u8>> = Vec::with_capacity(calls.len());
    for (target, data) in calls {
        let mut tuple = Vec::new();
        tuple.extend_from_slice(&abi::encode_address_word(target));
        tuple.extend_from_slice(&u64_word(0)); // value
        tuple.extend_from_slice(&u64_word(0x60)); // data starts after the three head words
        tuple.extend_from_slice(&u64_word(data.len() as u64));
        tuple.extend_from_slice(data);
        tuple.resize(tuple.len() + (32 - data.len() % 32) % 32, 0);
        tuples.push(tuple);
    }
    let mut out = abi::selector(SIG_BATCH_CALLS).to_vec();
    out.extend_from_slice(&u64_word(0x20));
    out.extend_from_slice(&u64_word(calls.len() as u64));
    let mut offset = 32 * calls.len() as u64;
    for tuple in &tuples {
        out.extend_from_slice(&u64_word(offset));
        offset += tuple.len() as u64;
    }
    for tuple in &tuples {
        out.extend_from_slice(tuple);
    }
    out
}

pub fn encode_approve_project(
    id: &[u8; 32],
    manager: &str,
    amount: &BigUint,
    shares: &BigUint,
    expires: u64,
    check: &[u8; 32],
) -> Result<Vec<u8>, CliError> {
    let mut words = vec![*id, address_word(manager, "manager")?];
    words.push(word_of(amount));
    words.push(word_of(shares));
    words.push(u64_word(expires));
    words.push(*check);
    Ok(call(SIG_APPROVE_PROJECT, &words))
}

pub fn encode_award(
    mandate: &str,
    claim: &[u8; 32],
    shares: &BigUint,
    convert: bool,
) -> Result<Vec<u8>, CliError> {
    Ok(call(
        SIG_AWARD,
        &[
            address_word(mandate, "mandate")?,
            *claim,
            word_of(shares),
            u64_word(u64::from(convert)),
        ],
    ))
}

pub fn encode_submit_claim(
    id: &[u8; 32],
    amount: &BigUint,
    stake: &BigUint,
    evidence: &[u8; 32],
) -> Vec<u8> {
    call(
        SIG_SUBMIT_CLAIM,
        &[*id, word_of(amount), word_of(stake), *evidence],
    )
}

fn fresh_nonce(kind: &str, data: &[u8]) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let mut preimage = format!("buzz.launchpad.work:{kind}:{nanos}:").into_bytes();
    preimage.extend_from_slice(data);
    format!("0x{}", hex::encode(abi::keccak256(&preimage)))
}

pub(crate) fn nonce_arg(
    given: &Option<String>,
    kind: &str,
    data: &[u8],
) -> Result<String, CliError> {
    match given {
        Some(n) => {
            let word = bytes32_arg(n, "nonce")?;
            if !n.trim().starts_with("0x") {
                return Err(CliError::Usage(
                    "nonce must be 0x + 64 hex characters".into(),
                ));
            }
            Ok(format!("0x{}", hex::encode(word)))
        }
        None => Ok(fresh_nonce(kind, data)),
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default()
}

/// The intent a compose step prints: what to propose, which lane it takes and the line that opens it.
pub(crate) fn intent_json(
    kind: &str,
    dao: &str,
    to: &str,
    data: &[u8],
    nonce: &str,
    lane: &str,
    note: &str,
) -> serde_json::Value {
    let data_hex = format!("0x{}", hex::encode(data));
    json!({
        "status": "ok",
        "kind": kind,
        "dao": dao,
        "to": to,
        "op": 0,
        "value": "0",
        "data": data_hex,
        "nonce": nonce,
        "lane": lane,
        "note": note,
        "next": format!(
            "buzz launchpad propose --dao {dao} --to {to} --data {data_hex} --nonce {nonce}"
        ),
    })
}

/// What the compose steps print: the intent, and the line that opens it.
fn print_intent(kind: &str, dao: &str, to: &str, data: &[u8], nonce: &str, lane: &str, note: &str) {
    println!("{}", intent_json(kind, dao, to, data, nonce, lane, note));
}

// ── compose ─────────────────────────────────────────────────────────────────────────────────

pub fn cmd_mandate(args: &MandateArgs) -> Result<(), CliError> {
    let dao = validate_eth_address(&args.dao, "dao")?;
    let factory = validate_eth_address(&args.factory, "factory")?;
    let currency = validate_eth_address(&args.currency, "currency")?;
    let has_cash = args.budget.is_some() || args.cap.is_some();
    let has_shares = args.share_budget.is_some() || args.share_cap.is_some();
    if !has_cash && !has_shares {
        return Err(CliError::Usage(
            "a mandate needs a budget of something: --budget and --cap, --share-budget and --share-cap, or both"
                .into(),
        ));
    }
    if args.budget.is_some() != args.cap.is_some() {
        return Err(CliError::Usage(
            "--budget and --cap go together: the cap is the most one project may hold".into(),
        ));
    }
    if args.share_budget.is_some() != args.share_cap.is_some() {
        return Err(CliError::Usage(
            "--share-budget and --share-cap go together: the cap is the most one project may award"
                .into(),
        ));
    }
    // The bond is paid in the claim currency unless another token is named; a named token needs its own decimals.
    let bond_token = match args.reviewer_bond_token.as_deref() {
        Some(token) => Some(validate_eth_address(token, "reviewer bond token")?),
        None => None,
    };
    if bond_token.is_some() && args.reviewer_bond.is_none() {
        return Err(CliError::Usage(
            "--reviewer-bond-token needs --reviewer-bond: a token with no bond to pay".into(),
        ));
    }
    let bond_in_currency = bond_token
        .as_deref()
        .map_or(true, |t| t.eq_ignore_ascii_case(&currency));
    let decimals = match (
        has_cash || (args.reviewer_bond.is_some() && bond_in_currency),
        args.decimals,
    ) {
        (true, Some(d)) => d,
        (true, None) => {
            return Err(CliError::Usage(
                "say how many decimals the currency has (--decimals); there is no safe default"
                    .into(),
            ))
        }
        (false, d) => d.unwrap_or(18),
    };
    let budget = units_or_zero(args.budget.as_deref(), decimals, 128, "budget")?;
    let cap = units_or_zero(args.cap.as_deref(), decimals, 128, "cap")?;
    if cap > budget {
        return Err(CliError::Usage("the cap cannot exceed the budget".into()));
    }
    let share_budget = units_or_zero(args.share_budget.as_deref(), 18, 128, "share budget")?;
    let share_cap = units_or_zero(args.share_cap.as_deref(), 18, 128, "share cap")?;
    if share_cap > share_budget {
        return Err(CliError::Usage(
            "the share cap cannot exceed the share budget".into(),
        ));
    }
    let bond_decimals = if bond_in_currency {
        decimals
    } else {
        args.reviewer_bond_decimals.ok_or_else(|| {
            CliError::Usage(
                "say how many decimals the bond token has (--reviewer-bond-decimals); there is no safe default"
                    .into(),
            )
        })?
    };
    let reviewer_bond = units_or_zero(
        args.reviewer_bond.as_deref(),
        bond_decimals,
        128,
        "reviewer bond",
    )?;
    let zero_address = "0x0000000000000000000000000000000000000000".to_string();
    let bond_token_word = if reviewer_bond == BigUint::from(0u8) {
        zero_address
    } else {
        bond_token.clone().unwrap_or_else(|| currency.clone())
    };
    let expires = expiry(
        args.expires,
        args.expires_in_days,
        now_secs(),
        "the mandate",
    )?;
    let create = encode_create_mandate(&MandateTerms {
        currency: &currency,
        budget: &budget,
        cap: &cap,
        share_budget: &share_budget,
        share_cap: &share_cap,
        expires,
        reviewers: &args.reviewers,
        quorum: args.quorum,
        reviewer_bond: &reviewer_bond,
        bond_token: &bond_token_word,
    })?;

    // A Shares-only mandate moves no money: the DAO calls the factory directly. One with a currency budget needs
    // the DAO to approve the factory for exactly that budget first, and to clear the approval after.
    let (to, data) = if budget == BigUint::from(0u8) {
        (factory.clone(), create)
    } else {
        let spend = call(
            SIG_APPROVE,
            &[address_word(&factory, "factory")?, word_of(&budget)],
        );
        let clear = call(
            SIG_APPROVE,
            &[
                address_word(&factory, "factory")?,
                word_of(&BigUint::from(0u8)),
            ],
        );
        let batch = encode_batch_calls(&[
            (address_bytes(&currency, "currency")?, spend),
            (address_bytes(&factory, "factory")?, create),
            (address_bytes(&currency, "currency")?, clear),
        ]);
        (dao.clone(), batch)
    };
    let nonce = nonce_arg(&args.nonce, "mandate", &data)?;
    print_intent(
        "mandate",
        &dao,
        &to,
        &data,
        &nonce,
        "unrestricted",
        "A mandate sets how much money and dilution the work may cost, so it takes the full vote.",
    );
    Ok(())
}

pub fn cmd_project(args: &ProjectArgs) -> Result<(), CliError> {
    let dao = validate_eth_address(&args.dao, "dao")?;
    let mandate = validate_eth_address(&args.mandate, "mandate")?;
    let id = bytes32_arg(&args.id, "project id")?;
    let amount = match (&args.amount, args.decimals) {
        (Some(v), Some(d)) => scaled_units(v, d, 128, "amount")?,
        (Some(_), None) => {
            return Err(CliError::Usage(
                "say how many decimals the currency has (--decimals) when giving --amount".into(),
            ))
        }
        (None, _) => BigUint::from(0u8),
    };
    let shares = units_or_zero(args.shares.as_deref(), 18, 128, "shares")?;
    if amount == BigUint::from(0u8) && shares == BigUint::from(0u8) && !args.milestone {
        return Err(CliError::Usage(
            "a project needs a budget of something: --amount, --shares, or both (a milestone project, in the milestone panel, holds nothing: say --milestone)"
                .into(),
        ));
    }
    let expires = expiry(
        args.expires,
        args.expires_in_days,
        now_secs(),
        "the project",
    )?;
    let check = hash_arg(
        args.check.as_deref(),
        args.check_text.as_deref(),
        "acceptance check",
    )?;
    let data = encode_approve_project(&id, &args.manager, &amount, &shares, expires, &check)?;
    let nonce = nonce_arg(&args.nonce, "project", &data)?;
    print_intent(
        "project",
        &dao,
        &mandate,
        &data,
        &nonce,
        "bounded",
        "Inside a mandate this DAO created, this uses the lighter vote; the chain decides which lane applies.",
    );
    Ok(())
}

pub fn cmd_award(args: &AwardArgs) -> Result<(), CliError> {
    let dao = validate_eth_address(&args.dao, "dao")?;
    let mandate = validate_eth_address(&args.mandate, "mandate")?;
    let claim = bytes32_arg(&args.claim, "claim id")?;
    let shares = scaled_units(&args.shares, 18, 96, "shares")?;
    if shares == BigUint::from(0u8) {
        return Err(CliError::Usage("an award of no Shares is refused".into()));
    }
    let data = encode_award(&mandate, &claim, &shares, args.convert)?;
    let nonce = nonce_arg(&args.nonce, "award", &data)?;
    print_intent(
        "award",
        &dao,
        &dao,
        &data,
        &nonce,
        "bounded",
        "The mandate refuses an award larger than the project has left, however the vote goes.",
    );
    Ok(())
}

// ── chain steps ─────────────────────────────────────────────────────────────────────────────

pub(crate) struct Chain {
    rpc: Arc<dyn EvmRpc>,
    mandate: String,
}

impl Chain {
    pub(crate) fn open(rpc_url: &str, mandate: &str) -> Result<Self, CliError> {
        let rpc: Arc<dyn EvmRpc> = Arc::new(
            HttpEvmRpc::new(rpc_url).map_err(|e| CliError::Other(format!("rpc init: {e}")))?,
        );
        Self::with_transport(rpc, mandate)
    }

    fn with_transport(rpc: Arc<dyn EvmRpc>, mandate: &str) -> Result<Self, CliError> {
        Ok(Self {
            rpc,
            mandate: validate_eth_address(mandate, "mandate")?,
        })
    }

    async fn eth_call(&self, to: &str, data: &[u8]) -> Result<Vec<u8>, CliError> {
        let value = self
            .rpc
            .call(
                "eth_call",
                json!([{ "to": to, "data": format!("0x{}", hex::encode(data)) }, "latest"]),
                RPC_TIMEOUT,
            )
            .await
            .map_err(|e| CliError::Other(format!("eth_call: {e}")))?;
        let text = value
            .as_str()
            .ok_or_else(|| CliError::Other("eth_call returned a non-string result".into()))?;
        hex::decode(text.trim().trim_start_matches("0x"))
            .map_err(|e| CliError::Other(format!("malformed eth_call result: {e}")))
    }

    pub(crate) async fn word(&self, to: &str, data: &[u8]) -> Result<[u8; 32], CliError> {
        let bytes = self.eth_call(to, data).await?;
        bytes
            .get(..32)
            .and_then(|w| <[u8; 32]>::try_from(w).ok())
            .ok_or_else(|| CliError::Other("eth_call result too short for a word".into()))
    }

    /// The latest block's timestamp: the chain's own clock, which a local test chain can move far from the wall clock.
    pub(crate) async fn latest_block_time(&self) -> Result<u64, CliError> {
        let block = self
            .rpc
            .call(
                "eth_getBlockByNumber",
                json!(["latest", false]),
                RPC_TIMEOUT,
            )
            .await
            .map_err(|e| CliError::Other(format!("eth_getBlockByNumber: {e}")))?;
        let text = block["timestamp"]
            .as_str()
            .ok_or_else(|| CliError::Other("the latest block has no timestamp".into()))?;
        u64::from_str_radix(text.trim_start_matches("0x"), 16)
            .map_err(|e| CliError::Other(format!("malformed block timestamp: {e}")))
    }

    pub(crate) async fn address_of(&self, to: &str, signature: &str) -> Result<String, CliError> {
        let word = self.word(to, &abi::selector(signature)).await?;
        Ok(format!("0x{}", hex::encode(&word[12..])))
    }

    /// The mandate's claim ledger and reviewer panel.
    async fn parts(&self) -> Result<(String, String), CliError> {
        Ok((
            self.address_of(&self.mandate, SIG_MANDATE_CLAIMS).await?,
            self.address_of(&self.mandate, SIG_MANDATE_VERIFIERS)
                .await?,
        ))
    }

    pub(crate) async fn send(
        &self,
        spender: &k256::ecdsa::SigningKey,
        to: &str,
        data: &[u8],
        what: &str,
    ) -> Result<String, CliError> {
        self.send_capped(spender, to, data, what, buzz_evm_allowance::tx::MAX_GAS)
            .await
    }

    /// Like [`Chain::send`] for a call that legitimately costs more (the cap is still held to the client's ceiling).
    pub(crate) async fn send_capped(
        &self,
        spender: &k256::ecdsa::SigningKey,
        to: &str,
        data: &[u8],
        what: &str,
        gas_cap: u64,
    ) -> Result<String, CliError> {
        send_contract_call(&self.rpc, RPC_TIMEOUT, to, spender, data, what, gas_cap).await
    }
}

/// `MilestoneLock.unlock(beneficiary, index, mandate, claimId)`.
pub fn encode_unlock(
    beneficiary: &str,
    index: u64,
    mandate: &str,
    claim_id: &[u8; 32],
) -> Result<Vec<u8>, CliError> {
    if index >= MAX_LOCK_TRANCHES {
        return Err(CliError::Usage(format!(
            "a lock has at most {MAX_LOCK_TRANCHES} milestones, counted from 0 (got {index})"
        )));
    }
    Ok(call(
        SIG_UNLOCK,
        &[
            address_word(beneficiary, "beneficiary")?,
            u64_word(index),
            address_word(mandate, "mandate")?,
            *claim_id,
        ],
    ))
}

fn print_sent(what: &str, mandate: &str, id: &str, tx_hash: &str, extra: serde_json::Value) {
    println!(
        "{}",
        json!({ "status": "ok", "step": what, "mandate": mandate, "id": id, "txHash": tx_hash, "details": extra })
    );
}

pub async fn cmd_claim(args: &ClaimArgs) -> Result<(), CliError> {
    let id = bytes32_arg(&args.id, "claim id")?;
    let decimals = match (args.amount.is_some() || args.stake.is_some(), args.decimals) {
        (true, Some(d)) => d,
        (true, None) => return Err(CliError::Usage(
            "say how many decimals the currency has (--decimals) when giving --amount or --stake"
                .into(),
        )),
        (false, d) => d.unwrap_or(18),
    };
    let amount = units_or_zero(args.amount.as_deref(), decimals, 256, "amount")?;
    let stake = units_or_zero(args.stake.as_deref(), decimals, 256, "stake")?;
    let evidence = match (&args.evidence, &args.evidence_file) {
        (Some(_), Some(_)) => {
            return Err(CliError::Usage(
                "give the evidence as a hash or as a file, not both".into(),
            ))
        }
        (Some(h), None) => hash_arg(Some(h), None, "evidence")?,
        (None, Some(path)) => {
            let bytes = std::fs::read(path)
                .map_err(|e| CliError::Usage(format!("cannot read {path}: {e}")))?;
            abi::keccak256(&bytes)
        }
        (None, None) => {
            return Err(CliError::Usage(
                "give the evidence: --evidence <0x hash> or --evidence-file <path>".into(),
            ))
        }
    };
    let (rpc_url, spender) = load_chain()?;
    let chain = Chain::open(&rpc_url, &args.mandate)?;
    let (claims, _) = chain.parts().await?;
    let data = encode_submit_claim(&id, &amount, &stake, &evidence);
    let tx = chain.send(&spender, &claims, &data, "the claim").await?;
    print_sent(
        "claim",
        &chain.mandate,
        &args.id,
        &tx,
        json!({ "claims": claims, "evidence": format!("0x{}", hex::encode(evidence)),
                "asksForCurrency": amount != BigUint::from(0u8) }),
    );
    Ok(())
}

pub async fn cmd_check(args: &CheckArgs) -> Result<(), CliError> {
    let id = bytes32_arg(&args.id, "claim id")?;
    let check = hash_arg(
        args.check.as_deref(),
        args.check_text.as_deref(),
        "acceptance check",
    )?;
    let (rpc_url, spender) = load_chain()?;
    let chain = Chain::open(&rpc_url, &args.mandate)?;
    let (claims, _) = chain.parts().await?;
    let tx = chain
        .send(
            &spender,
            &claims,
            &call(SIG_SET_CHECK, &[id, check]),
            "the check",
        )
        .await?;
    print_sent(
        "check",
        &chain.mandate,
        &args.id,
        &tx,
        json!({ "check": format!("0x{}", hex::encode(check)) }),
    );
    Ok(())
}

pub async fn cmd_bind(args: &BindArgs) -> Result<(), CliError> {
    let id = bytes32_arg(&args.id, "claim id")?;
    if args.milestone {
        let (rpc_url, spender) = load_chain()?;
        let chain = Chain::open(&rpc_url, &args.mandate)?;
        let tx = chain
            .send(
                &spender,
                &chain.mandate,
                &call(SIG_BIND_MILESTONE, &[id]),
                "the milestone binding",
            )
            .await?;
        print_sent(
            "bind",
            &chain.mandate,
            &args.id,
            &tx,
            json!({ "milestone": true }),
        );
        return Ok(());
    }
    if args.project.is_empty() || args.contributor.is_empty() {
        return Err(CliError::Usage(
            "--project and --contributor are needed to bind a claim (or --milestone for your own milestone claim)".into(),
        ));
    }
    let project = bytes32_arg(&args.project, "project id")?;
    let expected = validate_eth_address(&args.contributor, "contributor")?;
    let (rpc_url, spender) = load_chain()?;
    let chain = Chain::open(&rpc_url, &args.mandate)?;
    // Binding reserves the claim's payment and counts its work against the project: check whose claim it is first.
    let report = chain.claim_report(&args.mandate, &id).await?;
    ensure_claim_is_theirs(&report, &expected)?;
    let tx = chain
        .send(
            &spender,
            &chain.mandate,
            &call(
                SIG_FUND_MILESTONE,
                &[project, id, address_word(&expected, "contributor")?],
            ),
            "the binding",
        )
        .await?;
    print_sent(
        "bind",
        &chain.mandate,
        &args.id,
        &tx,
        json!({ "project": args.project, "contributor": expected,
                "amount": report["amount"], "asksForCurrency": report["asksForCurrency"] }),
    );
    Ok(())
}

/// Refuse to bind a claim that is not the contributor's, or is no longer open.
pub fn ensure_claim_is_theirs(report: &serde_json::Value, expected: &str) -> Result<(), CliError> {
    let actual = report["contributor"].as_str().unwrap_or_default();
    if !actual.eq_ignore_ascii_case(expected) {
        return Err(CliError::Usage(format!(
            "that claim was filed by {actual}, not {expected}: a claim id belongs to whoever filed it first, \
             so nothing was bound. Ask the contributor for a new id."
        )));
    }
    if report["status"] != "Open" {
        return Err(CliError::Usage(format!(
            "that claim is {}, not open, so it cannot be bound",
            report["status"].as_str().unwrap_or("in an unknown state")
        )));
    }
    Ok(())
}

pub async fn cmd_attest(args: &AttestArgs) -> Result<(), CliError> {
    let id = bytes32_arg(&args.id, "claim id")?;
    let approve = match args.verdict.trim().to_ascii_lowercase().as_str() {
        "approve" => true,
        "object" => false,
        other => {
            return Err(CliError::Usage(format!(
                "the verdict is approve | object (got {other:?})"
            )))
        }
    };
    let (rpc_url, spender) = load_chain()?;
    let chain = Chain::open(&rpc_url, &args.mandate)?;
    let (_, verifiers) = chain.parts().await?;
    let tx = chain
        .send(
            &spender,
            &verifiers,
            &call(SIG_ATTEST, &[id, u64_word(u64::from(approve))]),
            "the verdict",
        )
        .await?;
    print_sent(
        "attest",
        &chain.mandate,
        &args.id,
        &tx,
        json!({ "verdict": if approve { "approve" } else { "object" } }),
    );
    Ok(())
}

pub async fn cmd_settle(args: &ClaimRefArgs) -> Result<(), CliError> {
    let id = bytes32_arg(&args.id, "claim id")?;
    let (rpc_url, spender) = load_chain()?;
    let chain = Chain::open(&rpc_url, &args.mandate)?;
    let (claims, _) = chain.parts().await?;
    let tx = chain
        .send(
            &spender,
            &claims,
            &call(SIG_SETTLE, &[id]),
            "the settlement",
        )
        .await?;
    print_sent("settle", &chain.mandate, &args.id, &tx, json!({}));
    Ok(())
}

pub async fn cmd_payout(args: &ClaimRefArgs) -> Result<(), CliError> {
    let id = bytes32_arg(&args.id, "claim id")?;
    let (rpc_url, spender) = load_chain()?;
    let chain = Chain::open(&rpc_url, &args.mandate)?;
    let (claims, _) = chain.parts().await?;
    let tx = chain
        .send(&spender, &claims, &call(SIG_PAYOUT, &[id]), "the payout")
        .await?;
    print_sent("payout", &chain.mandate, &args.id, &tx, json!({}));
    Ok(())
}

fn big_word(bytes: &[u8], index: usize) -> BigUint {
    BigUint::from_bytes_be(&bytes[index * 32..(index + 1) * 32])
}

/// What happens next for a claim in this state, in the words an agent can act on.
pub fn next_step(
    status: &str,
    bound: bool,
    approvals: u64,
    quorum: u64,
    awarded: bool,
    asks_for_shares_only: bool,
) -> &'static str {
    match status {
        "Open" if !bound => "the project's manager binds it: buzz launchpad work bind",
        "Open" if approvals >= quorum && quorum != 0 => {
            "anyone settles it: buzz launchpad work settle"
        }
        "Open" => "reviewers approve or object: buzz launchpad work attest",
        "Approved" => {
            "after the challenge window the contributor takes it: buzz launchpad work payout"
        }
        "Paid" if awarded => "done: the Shares were awarded",
        "Paid" if bound && asks_for_shares_only => {
            "the DAO votes the award: buzz launchpad work award, then buzz launchpad propose"
        }
        "Paid" if bound => "the DAO may vote an award: buzz launchpad work award",
        "Paid" => "paid, but not bound to a project, so it cannot earn Shares",
        "Frozen" => "frozen: the DAO resolves it by vote",
        "Rejected" | "Recovered" | "Expired" => "closed: nothing more happens",
        _ => "unknown",
    }
}

pub async fn cmd_state(args: &ClaimRefArgs) -> Result<(), CliError> {
    let id = bytes32_arg(&args.id, "claim id")?;
    let rpc_url = std::env::var(ENV_EVM_RPC_URL)
        .ok()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| {
            CliError::Usage(format!("work state reads the chain: set {ENV_EVM_RPC_URL}"))
        })?;
    let chain = Chain::open(&rpc_url, &args.mandate)?;
    let report = chain.claim_report(&args.mandate, &id).await?;
    println!("{report}");
    Ok(())
}

pub async fn cmd_unlock(args: &UnlockArgs) -> Result<(), CliError> {
    let id = bytes32_arg(&args.id, "claim id")?;
    let data = encode_unlock(&args.beneficiary, args.index, &args.mandate, &id)?;
    let (rpc_url, spender) = load_chain()?;
    let chain = Chain::open(&rpc_url, &args.mandate)?;
    let lock = chain.lock_of(&args.dao).await?;
    let tx = chain.send(&spender, &lock, &data, "the unlock").await?;
    print_sent(
        "unlock",
        &chain.mandate,
        &args.id,
        &tx,
        json!({ "lock": lock, "beneficiary": args.beneficiary, "milestone": args.index }),
    );
    Ok(())
}

pub async fn cmd_locks(args: &LocksArgs) -> Result<(), CliError> {
    let rpc_url = std::env::var(ENV_EVM_RPC_URL)
        .ok()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| {
            CliError::Usage(format!("work locks reads the chain: set {ENV_EVM_RPC_URL}"))
        })?;
    let holder = match &args.holder {
        Some(h) => validate_eth_address(h, "holder")?,
        None => {
            let (_, spender) = load_chain()?;
            format!(
                "0x{}",
                hex::encode(buzz_evm_allowance::tx::address_from_key(&spender))
            )
        }
    };
    // The handle is opened for the DAO: these reads are about it, not about a mandate.
    let chain = Chain::open(&rpc_url, &args.dao)?;
    let report = chain.lock_report(&args.dao, &holder).await?;
    println!("{report}");
    Ok(())
}

impl Chain {
    /// The milestone lock a DAO's Shares name. A DAO whose Shares name none holds nothing back.
    async fn lock_of(&self, dao: &str) -> Result<String, CliError> {
        let dao = validate_eth_address(dao, "dao")?;
        let shares = self.address_of(&dao, SIG_DAO_SHARES).await?;
        let lock = self.address_of(&shares, SIG_SHARES_LOCK_GUARD).await?;
        if lock.trim_start_matches("0x").bytes().all(|b| b == b'0') {
            return Err(CliError::Usage(
                "this DAO's Shares have no milestone lock: nothing of the team's is held back"
                    .into(),
            ));
        }
        Ok(lock)
    }

    pub(crate) async fn lock_report(
        &self,
        dao: &str,
        holder: &str,
    ) -> Result<serde_json::Value, CliError> {
        let lock = self.lock_of(dao).await?;
        let holder_word = address_word(holder, "holder")?;
        let locked = BigUint::from_bytes_be(
            &self
                .word(&lock, &call(SIG_LOCKED_OF, &[holder_word]))
                .await?,
        );
        let count = BigUint::from_bytes_be(
            &self
                .word(&lock, &call(SIG_TRANCHE_COUNT, &[holder_word]))
                .await?,
        );
        let count = u64::try_from(count)
            .unwrap_or(MAX_LOCK_TRANCHES)
            .min(MAX_LOCK_TRANCHES);
        let mut milestones = Vec::new();
        for index in 0..count {
            let record = self
                .eth_call(
                    &lock,
                    &call(SIG_TRANCHE_OF, &[holder_word, u64_word(index)]),
                )
                .await?;
            if record.len() < 4 * 32 {
                return Err(CliError::Other("the milestone record is too short".into()));
            }
            let unlocked = record[2 * 32..3 * 32].iter().any(|b| *b != 0);
            let forfeited = record[3 * 32..4 * 32].iter().any(|b| *b != 0);
            let state = if unlocked {
                "unlocked"
            } else if forfeited {
                "given up"
            } else {
                "locked"
            };
            milestones.push(json!({
                "index": index,
                "check": format!("0x{}", hex::encode(&record[..32])),
                "amount": big_word(&record, 1).to_string(),
                "state": state,
                "next": if state == "locked" {
                    "file a claim in a mandate this DAO created, state exactly this milestone's words as its check \
                     (work claim, then work check), and once the reviewers approve it and the challenge window \
                     passes, run: buzz launchpad work unlock"
                } else {
                    "nothing more to do"
                },
            }));
        }
        Ok(json!({
            "status": "ok",
            "dao": dao,
            "lock": lock,
            "holder": holder,
            "locked": locked.to_string(),
            "milestones": milestones,
        }))
    }

    pub(crate) async fn claim_report(
        &self,
        mandate: &str,
        id: &[u8; 32],
    ) -> Result<serde_json::Value, CliError> {
        let (claims, verifiers) = self.parts().await?;
        let record = self.eth_call(&claims, &call(SIG_CLAIM, &[*id])).await?;
        if record.len() < 8 * 32 {
            return Err(CliError::Other("the claim record is too short".into()));
        }
        let contributor = format!("0x{}", hex::encode(&record[12..32]));
        if record[..32].iter().all(|b| *b == 0) {
            return Err(CliError::Usage(format!(
                "there is no claim {} under this mandate",
                hex::encode(id)
            )));
        }
        let amount = big_word(&record, 1);
        let stake = big_word(&record, 2);
        let status_index = big_word(&record, 3)
            .to_u64_digits()
            .first()
            .copied()
            .unwrap_or(0) as usize;
        let status = CLAIM_STATES.get(status_index).copied().unwrap_or("Unknown");
        let released_at = big_word(&record, 7)
            .to_u64_digits()
            .first()
            .copied()
            .unwrap_or(0);
        let project = self
            .word(&self.mandate, &call(SIG_CLAIM_PROJECT, &[*id]))
            .await?;
        let bound = project.iter().any(|b| *b != 0);
        let awarded = self.word(&self.mandate, &call(SIG_AWARDED, &[*id])).await?[31] != 0;
        let window = u64::from_be_bytes(
            self.word(&claims, &abi::selector(SIG_CHALLENGE_WINDOW))
                .await?[24..]
                .try_into()
                .unwrap_or([0; 8]),
        );
        let as_u64 = |w: [u8; 32]| u64::from_be_bytes(w[24..].try_into().unwrap_or([0; 8]));
        let approvals = as_u64(
            self.word(&verifiers, &call(SIG_APPROVAL_COUNT, &[*id]))
                .await?,
        );
        let objections = as_u64(
            self.word(&verifiers, &call(SIG_OBJECTION_COUNT, &[*id]))
                .await?,
        );
        let quorum = as_u64(self.word(&verifiers, &abi::selector(SIG_QUORUM)).await?);
        let zero = BigUint::from(0u8);
        Ok(json!({
            "mandate": mandate,
            "id": format!("0x{}", hex::encode(id)),
            "status": status,
            "contributor": contributor,
            "asksForCurrency": amount != zero,
            "amount": amount.to_string(),
            "stake": stake.to_string(),
            "project": if bound { json!(format!("0x{}", hex::encode(project))) } else { serde_json::Value::Null },
            "approvals": approvals,
            "objections": objections,
            "quorum": quorum,
            "challengeEndsAt": if released_at == 0 { serde_json::Value::Null } else { json!(released_at + window) },
            "sharesAwarded": awarded,
            "next": next_step(status, bound, approvals, quorum, awarded, amount == zero),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_evm_allowance::AllowanceError;
    use std::collections::HashMap;
    use std::sync::Mutex;

    const DAO: &str = "0x00000000000000000000000000000000000000aa";

    fn units(n: u64, decimals: u32) -> BigUint {
        BigUint::from(n) * BigUint::from(10u8).pow(decimals)
    }

    /// Selectors pinned against `cast sig`.
    #[test]
    fn selectors_match_cast_sig() {
        let cases = [
            (SIG_SUBMIT_CLAIM, "26d3f6d4"),
            (SIG_SET_CHECK, "5b66d37a"),
            (SIG_SETTLE, "987757dd"),
            (SIG_PAYOUT, "cfefb3d5"),
            (SIG_FUND_MILESTONE, "ec7742ad"),
            (SIG_BIND_MILESTONE, "3d3d949b"),
            (SIG_ATTEST, "5747a6b1"),
            (SIG_APPROVE_PROJECT, "7eb44f4d"),
            (SIG_CREATE_MANDATE, "d7810bbc"),
            (SIG_AWARD, "33184aca"),
            (SIG_BATCH_CALLS, "11c76fd9"),
            (SIG_MANDATE_CLAIMS, "dcc59b6f"),
            (SIG_MANDATE_VERIFIERS, "26779776"),
            (SIG_CLAIM, "eff0f592"),
            (SIG_APPROVE, "095ea7b3"),
            (SIG_UNLOCK, "33484b20"),
            (SIG_LOCKED_OF, "a5f1e282"),
            (SIG_TRANCHE_COUNT, "29dc62b4"),
            (SIG_TRANCHE_OF, "1141e136"),
            (SIG_SHARES_LOCK_GUARD, "36bc529d"),
            (SIG_DAO_SHARES, "03314efa"),
        ];
        for (signature, expected) in cases {
            assert_eq!(
                hex::encode(abi::selector(signature)),
                expected,
                "{signature}"
            );
        }
    }

    #[test]
    fn ids_are_words_or_short_labels_and_nothing_in_between() {
        assert_eq!(
            hex::encode(bytes32_arg("docs", "id").unwrap()),
            "646f637300000000000000000000000000000000000000000000000000000000"
        );
        let word = format!("0x{}", "ab".repeat(32));
        assert_eq!(
            hex::encode(bytes32_arg(&word, "id").unwrap()),
            "ab".repeat(32)
        );
        // A label may not be mistaken for a word: a half-typed hash is an error, not a label.
        assert!(bytes32_arg("0xabcd", "id").is_err());
        assert!(bytes32_arg("", "id").is_err());
        assert!(bytes32_arg(&"x".repeat(33), "id").is_err());
        assert!(bytes32_arg(&"x".repeat(32), "id").is_ok());
    }

    #[test]
    fn amounts_scale_exactly_and_refuse_what_does_not_fit() {
        assert_eq!(scaled_units("1.5", 18, 128, "x").unwrap(), units(15, 17));
        assert_eq!(scaled_units("1000", 6, 128, "x").unwrap(), units(1000, 6));
        assert_eq!(scaled_units("0", 6, 128, "x").unwrap(), BigUint::from(0u8));
        for bad in ["-1", "1e6", "1.", ".5", "1.0000001", "", "1,5", "0x10"] {
            assert!(
                scaled_units(bad, 6, 128, "x").is_err(),
                "{bad:?} must be refused"
            );
        }
        // 2^96 base units does not fit a uint96 Shares award.
        let too_big = (BigUint::from(1u8) << 96u32).to_string();
        assert!(scaled_units(&too_big, 0, 96, "x").is_err());
        assert!(scaled_units(&(BigUint::from(1u8) << 95u32).to_string(), 0, 96, "x").is_ok());
    }

    #[test]
    fn expiry_takes_one_form_and_never_the_past() {
        assert_eq!(expiry(Some(2_000), None, 1_000, "it").unwrap(), 2_000);
        assert_eq!(
            expiry(None, Some(2), 1_000, "it").unwrap(),
            1_000 + 2 * 86_400
        );
        assert!(expiry(Some(2_000), Some(2), 1_000, "it").is_err());
        assert!(expiry(None, None, 1_000, "it").is_err());
        assert!(expiry(Some(1_000), None, 1_000, "it").is_err());
        assert!(expiry(Some(5), None, 1_000, "it").is_err());
    }

    /// Calldata equals `cast calldata` for the same arguments.
    #[test]
    fn approve_project_matches_the_cast_golden() {
        let check = abi::keccak256(b"delivery acceptance");
        let data = encode_approve_project(
            &bytes32_arg("docs", "id").unwrap(),
            "0x00000000000000000000000000000000000B0B00",
            &BigUint::from(0u8),
            &units(20, 18),
            1_893_456_000,
            &check,
        )
        .unwrap();
        assert_eq!(
            hex::encode(data),
            "7eb44f4d646f63730000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000b0b000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001158e460913d000000000000000000000000000000000000000000000000000000000000070dbd880d4fbd32979f29c5e8b2dbb2d12c831a9258bd9083cbb24f5b0ff7c6e56a271cc"
        );
    }

    #[test]
    fn a_shares_only_mandate_matches_the_cast_golden() {
        let data = encode_create_mandate(&MandateTerms {
            currency: "0x3333333333333333333333333333333333333333",
            budget: &BigUint::from(0u8),
            cap: &BigUint::from(0u8),
            share_budget: &units(100, 18),
            share_cap: &units(25, 18),
            expires: 1_893_456_000,
            reviewers: &[
                "0x1111111111111111111111111111111111111111".to_string(),
                "0x2222222222222222222222222222222222222222".to_string(),
            ],
            quorum: 2,
            reviewer_bond: &BigUint::from(0u8),
            bond_token: "0x0000000000000000000000000000000000000000",
        })
        .unwrap();
        assert_eq!(
            hex::encode(data),
            "d7810bbc0000000000000000000000003333333333333333333333333333333333333333000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000056bc75e2d631000000000000000000000000000000000000000000000000000015af1d78b58c400000000000000000000000000000000000000000000000000000000000070dbd8800000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000200000000000000000000000011111111111111111111111111111111111111110000000000000000000000002222222222222222222222222222222222222222"
        );
    }

    #[test]
    fn a_reviewer_bond_is_the_word_after_the_quorum_as_cast_encodes_it() {
        let data = encode_create_mandate(&MandateTerms {
            currency: "0x3333333333333333333333333333333333333333",
            budget: &BigUint::from(0u8),
            cap: &BigUint::from(0u8),
            share_budget: &units(100, 18),
            share_cap: &units(25, 18),
            expires: 1_893_456_000,
            reviewers: &[
                "0x1111111111111111111111111111111111111111".to_string(),
                "0x2222222222222222222222222222222222222222".to_string(),
            ],
            quorum: 2,
            reviewer_bond: &units(50, 6),
            bond_token: "0x3333333333333333333333333333333333333333",
        })
        .unwrap();
        assert_eq!(
            hex::encode(data),
            "d7810bbc0000000000000000000000003333333333333333333333333333333333333333000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000056bc75e2d631000000000000000000000000000000000000000000000000000015af1d78b58c400000000000000000000000000000000000000000000000000000000000070dbd880000000000000000000000000000000000000000000000000000000000000014000000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000002faf0800000000000000000000000003333333333333333333333333333333333333333000000000000000000000000000000000000000000000000000000000000000200000000000000000000000011111111111111111111111111111111111111110000000000000000000000002222222222222222222222222222222222222222"
        );
    }

    #[test]
    fn a_bond_in_another_token_names_that_token_after_the_bond_as_cast_encodes_it() {
        let data = encode_create_mandate(&MandateTerms {
            currency: "0x3333333333333333333333333333333333333333",
            budget: &BigUint::from(0u8),
            cap: &BigUint::from(0u8),
            share_budget: &units(100, 18),
            share_cap: &units(25, 18),
            expires: 1_893_456_000,
            reviewers: &[
                "0x1111111111111111111111111111111111111111".to_string(),
                "0x2222222222222222222222222222222222222222".to_string(),
            ],
            quorum: 2,
            reviewer_bond: &units(50, 18),
            bond_token: "0x4444444444444444444444444444444444444444",
        })
        .unwrap();
        assert_eq!(hex::encode(data), "d7810bbc0000000000000000000000003333333333333333333333333333333333333333000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000056bc75e2d631000000000000000000000000000000000000000000000000000015af1d78b58c400000000000000000000000000000000000000000000000000000000000070dbd88000000000000000000000000000000000000000000000000000000000000001400000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000002b5e3af16b18800000000000000000000000000004444444444444444444444444444444444444444000000000000000000000000000000000000000000000000000000000000000200000000000000000000000011111111111111111111111111111111111111110000000000000000000000002222222222222222222222222222222222222222");
    }

    #[test]
    fn award_and_claim_match_the_cast_golden() {
        let award = encode_award(
            "0x4444444444444444444444444444444444444444",
            &bytes32_arg("work", "id").unwrap(),
            &units(15, 18),
            false,
        )
        .unwrap();
        assert_eq!(
            hex::encode(award),
            "33184aca0000000000000000000000004444444444444444444444444444444444444444776f726b00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000d02ab486cedc00000000000000000000000000000000000000000000000000000000000000000000"
        );
        let claim = encode_submit_claim(
            &bytes32_arg("work", "id").unwrap(),
            &BigUint::from(0u8),
            &BigUint::from(0u8),
            &abi::keccak256(b"evidence"),
        );
        assert_eq!(
            hex::encode(claim),
            "26d3f6d4776f726b000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000097794b46b3afe9245d61058666381907ac8a35b0e3bce564cde9dd0eea648cb6"
        );
    }

    #[test]
    fn a_cash_mandate_is_one_batch_that_approves_creates_and_clears() {
        let create = encode_create_mandate(&MandateTerms {
            currency: "0x3333333333333333333333333333333333333333",
            budget: &units(1000, 6),
            cap: &units(300, 6),
            share_budget: &BigUint::from(0u8),
            share_cap: &BigUint::from(0u8),
            expires: 1_893_456_000,
            reviewers: &["0x1111111111111111111111111111111111111111".to_string()],
            quorum: 1,
            reviewer_bond: &BigUint::from(0u8),
            bond_token: "0x0000000000000000000000000000000000000000",
        })
        .unwrap();
        let factory = "0x5555555555555555555555555555555555555555";
        let currency = address_bytes("0x3333333333333333333333333333333333333333", "c").unwrap();
        let factory_bytes = address_bytes(factory, "f").unwrap();
        let spend = call(
            SIG_APPROVE,
            &[
                address_word(factory, "f").unwrap(),
                word_of(&units(1000, 6)),
            ],
        );
        let clear = call(
            SIG_APPROVE,
            &[
                address_word(factory, "f").unwrap(),
                word_of(&BigUint::from(0u8)),
            ],
        );
        let batch = encode_batch_calls(&[
            (currency, spend),
            (factory_bytes, create),
            (currency, clear),
        ]);
        assert_eq!(
            hex::encode(batch),
            "11c76fd9000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000014000000000000000000000000000000000000000000000000000000000000003600000000000000000000000003333333333333333333333333333333333333333000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000044095ea7b30000000000000000000000005555555555555555555555555555555555555555000000000000000000000000000000000000000000000000000000003b9aca00000000000000000000000000000000000000000000000000000000000000000000000000000000005555555555555555555555555555555555555555000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000184d7810bbc0000000000000000000000003333333333333333333333333333333333333333000000000000000000000000000000000000000000000000000000003b9aca000000000000000000000000000000000000000000000000000000000011e1a300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000070dbd880000000000000000000000000000000000000000000000000000000000000014000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000001111111111111111111111111111111111111111000000000000000000000000000000000000000000000000000000000000000000000000000000003333333333333333333333333333333333333333000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000044095ea7b30000000000000000000000005555555555555555555555555555555555555555000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
        );
    }

    #[test]
    fn a_mandate_that_cannot_work_is_refused_before_anything_is_composed() {
        let base = || MandateArgs {
            dao: DAO.into(),
            factory: "0x5555555555555555555555555555555555555555".into(),
            currency: "0x3333333333333333333333333333333333333333".into(),
            decimals: Some(6),
            budget: None,
            cap: None,
            share_budget: Some("100".into()),
            share_cap: Some("25".into()),
            expires: None,
            expires_in_days: Some(90),
            reviewers: vec!["0x1111111111111111111111111111111111111111".into()],
            quorum: 1,
            reviewer_bond: None,
            reviewer_bond_token: None,
            reviewer_bond_decimals: None,
            nonce: None,
        };
        assert!(cmd_mandate(&base()).is_ok());
        let mut nothing = base();
        nothing.share_budget = None;
        nothing.share_cap = None;
        assert!(
            cmd_mandate(&nothing).is_err(),
            "a mandate with no budget of anything"
        );
        let mut no_cap = base();
        no_cap.share_cap = None;
        assert!(cmd_mandate(&no_cap).is_err(), "a budget without its cap");
        let mut over = base();
        over.share_cap = Some("101".into());
        assert!(cmd_mandate(&over).is_err(), "a cap above its budget");
        let mut cash_no_decimals = base();
        cash_no_decimals.budget = Some("10".into());
        cash_no_decimals.cap = Some("5".into());
        cash_no_decimals.decimals = None;
        assert!(
            cmd_mandate(&cash_no_decimals).is_err(),
            "currency without its decimals"
        );
        let mut quorum = base();
        quorum.quorum = 2;
        assert!(
            cmd_mandate(&quorum).is_err(),
            "a quorum above the reviewers"
        );
        let mut both = base();
        both.expires = Some(u64::MAX);
        assert!(cmd_mandate(&both).is_err(), "two ways to say when");
        // A bond in another token needs that token's decimals, and a token needs a bond to pay.
        let mut other = base();
        other.reviewer_bond = Some("50".into());
        other.reviewer_bond_token = Some("0x4444444444444444444444444444444444444444".into());
        assert!(
            cmd_mandate(&other).is_err(),
            "another bond token without its decimals"
        );
        other.reviewer_bond_decimals = Some(18);
        assert!(cmd_mandate(&other).is_ok());
        let mut no_bond = base();
        no_bond.reviewer_bond_token = Some("0x4444444444444444444444444444444444444444".into());
        assert!(
            cmd_mandate(&no_bond).is_err(),
            "a bond token with no bond to pay"
        );
        // In the currency itself, the currency's decimals are enough.
        let mut same = base();
        same.reviewer_bond = Some("50".into());
        same.reviewer_bond_token = Some("0x3333333333333333333333333333333333333333".into());
        assert!(cmd_mandate(&same).is_ok());
    }

    #[test]
    fn a_project_holds_something_unless_it_is_a_milestone_project() {
        let base = |milestone: bool| ProjectArgs {
            dao: DAO.into(),
            mandate: "0x5555555555555555555555555555555555555555".into(),
            id: "alpha".into(),
            manager: "0x00000000000000000000000000000000000B0B00".into(),
            amount: None,
            decimals: None,
            shares: None,
            expires: None,
            expires_in_days: Some(30),
            check: None,
            check_text: Some("alpha shipped".into()),
            milestone,
            nonce: None,
        };
        assert!(
            cmd_project(&base(false)).is_err(),
            "an ordinary project with nothing to hold is refused"
        );
        assert!(
            cmd_project(&base(true)).is_ok(),
            "a milestone project holds nothing"
        );
        // And what it encodes is the call a milestone panel accepts: no money, no Shares.
        let data = encode_approve_project(
            &bytes32_arg("alpha", "id").unwrap(),
            "0x00000000000000000000000000000000000B0B00",
            &BigUint::from(0u8),
            &BigUint::from(0u8),
            1_893_456_000,
            &abi::keccak256(b"alpha shipped"),
        )
        .unwrap();
        assert_eq!(&hex::encode(&data)[..8], "7eb44f4d");
    }

    #[test]
    fn what_happens_next_follows_the_claim() {
        assert!(next_step("Open", false, 0, 2, false, true).contains("binds"));
        assert!(next_step("Open", true, 0, 2, false, true).contains("attest"));
        assert!(next_step("Open", true, 2, 2, false, true).contains("settle"));
        assert!(next_step("Approved", true, 2, 2, false, true).contains("payout"));
        assert!(next_step("Paid", true, 2, 2, false, true).contains("award"));
        assert!(next_step("Paid", true, 2, 2, true, true).contains("done"));
        assert!(next_step("Paid", false, 2, 2, false, true).contains("cannot earn"));
        assert!(next_step("Expired", true, 0, 2, false, true).contains("closed"));
    }

    /// An `eth_call` mock keyed by target and selector.
    struct MockRpc {
        answers: Mutex<HashMap<String, String>>,
    }

    #[async_trait::async_trait]
    impl EvmRpc for MockRpc {
        async fn call(
            &self,
            method: &'static str,
            params: serde_json::Value,
            _timeout: Duration,
        ) -> Result<serde_json::Value, AllowanceError> {
            let to = params[0]["to"].as_str().unwrap_or_default().to_lowercase();
            let data = params[0]["data"].as_str().unwrap_or_default();
            let key = format!("{to}:{}", data.get(2..10).unwrap_or(""));
            match self.answers.lock().unwrap().get(&key) {
                Some(v) => Ok(serde_json::Value::String(v.clone())),
                None => Err(AllowanceError::Rpc {
                    method,
                    detail: format!("mock has no answer for {key}"),
                }),
            }
        }
    }

    fn word_hex(value: u64) -> String {
        format!("{value:064x}")
    }

    #[tokio::test]
    async fn state_reads_the_claim_and_says_what_comes_next() {
        let mandate = "0x00000000000000000000000000000000000000bb";
        let claims = "0x00000000000000000000000000000000000000cc";
        let verifiers = "0x00000000000000000000000000000000000000dd";
        let id = bytes32_arg("work", "id").unwrap();
        let sel = |s: &str| hex::encode(abi::selector(s));
        let mut answers = HashMap::new();
        answers.insert(
            format!("{mandate}:{}", sel(SIG_MANDATE_CLAIMS)),
            format!("0x{:0>64}", &claims[2..]),
        );
        answers.insert(
            format!("{mandate}:{}", sel(SIG_MANDATE_VERIFIERS)),
            format!("0x{:0>64}", &verifiers[2..]),
        );
        // contributor, amount 0, stake 0, status Approved (1), evidence, check, expiresAt, releasedAt 1000
        let record = [
            format!("{:0>64}", "0000000000000000000000000000000000000dad"),
            word_hex(0),
            word_hex(0),
            word_hex(1),
            word_hex(7),
            word_hex(8),
            word_hex(9_999),
            word_hex(1_000),
        ]
        .concat();
        answers.insert(
            format!("{claims}:{}", sel(SIG_CLAIM)),
            format!("0x{record}"),
        );
        answers.insert(
            format!("{mandate}:{}", sel(SIG_CLAIM_PROJECT)),
            format!("0x{}", word_hex(5)),
        );
        answers.insert(
            format!("{mandate}:{}", sel(SIG_AWARDED)),
            format!("0x{}", word_hex(0)),
        );
        answers.insert(
            format!("{claims}:{}", sel(SIG_CHALLENGE_WINDOW)),
            format!("0x{}", word_hex(259_200)),
        );
        answers.insert(
            format!("{verifiers}:{}", sel(SIG_APPROVAL_COUNT)),
            format!("0x{}", word_hex(2)),
        );
        answers.insert(
            format!("{verifiers}:{}", sel(SIG_OBJECTION_COUNT)),
            format!("0x{}", word_hex(0)),
        );
        answers.insert(
            format!("{verifiers}:{}", sel(SIG_QUORUM)),
            format!("0x{}", word_hex(2)),
        );
        let rpc: Arc<dyn EvmRpc> = Arc::new(MockRpc {
            answers: Mutex::new(answers),
        });
        let chain = Chain::with_transport(rpc, mandate).unwrap();
        let report = chain.claim_report(mandate, &id).await.unwrap();
        assert_eq!(report["status"], "Approved");
        assert_eq!(report["asksForCurrency"], false);
        assert_eq!(report["approvals"], 2);
        assert_eq!(report["quorum"], 2);
        assert_eq!(report["challengeEndsAt"], 1_000 + 259_200);
        assert_eq!(report["sharesAwarded"], false);
        assert!(report["project"].is_string());
        assert!(report["next"].as_str().unwrap().contains("payout"));
    }

    /// `cast calldata "unlock(address,uint256,address,bytes32)" 0x1111… 1 0x2222… 0x3333…`
    #[test]
    fn unlock_calldata_is_what_cast_encodes() {
        let data = encode_unlock(
            "0x1111111111111111111111111111111111111111",
            1,
            "0x2222222222222222222222222222222222222222",
            &[0x33u8; 32],
        )
        .unwrap();
        assert_eq!(
            hex::encode(data),
            "33484b200000000000000000000000001111111111111111111111111111111111111111000000000000000000000000000000000000000000000000000000000000000100000000000000000000000022222222222222222222222222222222222222223333333333333333333333333333333333333333333333333333333333333333"
        );
        let too_far = encode_unlock(
            "0x1111111111111111111111111111111111111111",
            MAX_LOCK_TRANCHES,
            "0x2222222222222222222222222222222222222222",
            &[0u8; 32],
        );
        assert!(too_far.is_err());
    }

    #[test]
    fn check_text_hashes_the_same_with_or_without_stray_spaces() {
        let clean = hash_arg(None, Some("alpha shipped"), "check").unwrap();
        let padded = hash_arg(None, Some("  alpha shipped\n"), "check").unwrap();
        assert_eq!(clean, padded);
        // keccak256("alpha shipped"), the same word the app and the launch kit commit a milestone to.
        assert_eq!(
            hex::encode(clean),
            "584c2cefcd48562da6fb9889be81b5ec58deec77062db839bf9de9f7bbb9aab8"
        );
    }

    fn lock_world() -> (Chain, &'static str, &'static str) {
        let dao = "0x00000000000000000000000000000000000000aa";
        let shares = "0x00000000000000000000000000000000000000bb";
        let lock = "0x00000000000000000000000000000000000000cc";
        let sel = |s: &str| hex::encode(abi::selector(s));
        let mut answers = HashMap::new();
        answers.insert(
            format!("{dao}:{}", sel(SIG_DAO_SHARES)),
            format!("0x{:0>64}", &shares[2..]),
        );
        answers.insert(
            format!("{shares}:{}", sel(SIG_SHARES_LOCK_GUARD)),
            format!("0x{:0>64}", &lock[2..]),
        );
        answers.insert(
            format!("{lock}:{}", sel(SIG_LOCKED_OF)),
            format!("0x{}", word_hex(40)),
        );
        answers.insert(
            format!("{lock}:{}", sel(SIG_TRANCHE_COUNT)),
            format!("0x{}", word_hex(1)),
        );
        // check 0xa1.., amount 40, not unlocked, not forfeited
        answers.insert(
            format!("{lock}:{}", sel(SIG_TRANCHE_OF)),
            format!(
                "0x{}{}{}{}",
                "a1".repeat(32),
                word_hex(40),
                word_hex(0),
                word_hex(0)
            ),
        );
        let rpc: Arc<dyn EvmRpc> = Arc::new(MockRpc {
            answers: Mutex::new(answers),
        });
        (Chain::with_transport(rpc, dao).unwrap(), dao, lock)
    }

    #[tokio::test]
    async fn locks_report_what_is_held_back_and_what_to_do() {
        let (chain, dao, lock) = lock_world();
        let holder = "0x00000000000000000000000000000000000000dd";
        let report = chain.lock_report(dao, holder).await.unwrap();
        assert_eq!(report["lock"], lock);
        assert_eq!(report["locked"], "40");
        assert_eq!(report["milestones"][0]["state"], "locked");
        assert_eq!(report["milestones"][0]["amount"], "40");
        assert_eq!(
            report["milestones"][0]["check"],
            format!("0x{}", "a1".repeat(32))
        );
        assert!(report["milestones"][0]["next"]
            .as_str()
            .unwrap()
            .contains("work unlock"));
    }

    #[tokio::test]
    async fn a_dao_whose_shares_name_no_lock_says_so_instead_of_failing_oddly() {
        let dao = "0x00000000000000000000000000000000000000aa";
        let shares = "0x00000000000000000000000000000000000000bb";
        let sel = |s: &str| hex::encode(abi::selector(s));
        let mut answers = HashMap::new();
        answers.insert(
            format!("{dao}:{}", sel(SIG_DAO_SHARES)),
            format!("0x{:0>64}", &shares[2..]),
        );
        answers.insert(
            format!("{shares}:{}", sel(SIG_SHARES_LOCK_GUARD)),
            format!("0x{}", "0".repeat(64)),
        );
        let rpc: Arc<dyn EvmRpc> = Arc::new(MockRpc {
            answers: Mutex::new(answers),
        });
        let chain = Chain::with_transport(rpc, dao).unwrap();
        let error = chain
            .lock_report(dao, "0x00000000000000000000000000000000000000dd")
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("no milestone lock"), "{error}");
    }

    #[test]
    fn a_claim_filed_by_someone_else_is_not_bound() {
        let theirs = json!({ "contributor": "0x00000000000000000000000000000000000000aa", "status": "Open" });
        assert!(
            ensure_claim_is_theirs(&theirs, "0x00000000000000000000000000000000000000aa").is_ok()
        );
        // Case does not matter; a different address does.
        assert!(
            ensure_claim_is_theirs(&theirs, "0x00000000000000000000000000000000000000AA").is_ok()
        );
        let squatted =
            ensure_claim_is_theirs(&theirs, "0x00000000000000000000000000000000000000bb")
                .unwrap_err()
                .to_string();
        assert!(
            squatted.contains("filed by 0x00000000000000000000000000000000000000aa"),
            "{squatted}"
        );
        let late = json!({ "contributor": "0x00000000000000000000000000000000000000aa", "status": "Paid" });
        assert!(
            ensure_claim_is_theirs(&late, "0x00000000000000000000000000000000000000aa").is_err()
        );
    }

    #[tokio::test]
    async fn state_of_a_claim_that_does_not_exist_says_so() {
        let mandate = "0x00000000000000000000000000000000000000bb";
        let claims = "0x00000000000000000000000000000000000000cc";
        let verifiers = "0x00000000000000000000000000000000000000dd";
        let sel = |s: &str| hex::encode(abi::selector(s));
        let mut answers = HashMap::new();
        answers.insert(
            format!("{mandate}:{}", sel(SIG_MANDATE_CLAIMS)),
            format!("0x{:0>64}", &claims[2..]),
        );
        answers.insert(
            format!("{mandate}:{}", sel(SIG_MANDATE_VERIFIERS)),
            format!("0x{:0>64}", &verifiers[2..]),
        );
        answers.insert(
            format!("{claims}:{}", sel(SIG_CLAIM)),
            format!("0x{}", "0".repeat(64 * 8)),
        );
        let rpc: Arc<dyn EvmRpc> = Arc::new(MockRpc {
            answers: Mutex::new(answers),
        });
        let chain = Chain::with_transport(rpc, mandate).unwrap();
        let error = chain
            .claim_report(mandate, &bytes32_arg("ghost", "id").unwrap())
            .await
            .unwrap_err();
        assert!(error.to_string().contains("no claim"), "{error}");
    }
}
