//! `buzz org` commands — NIP-ORG kinds:37010–37014 read/write path.
//!
//! The org graph is the coordination layer: roles, delegations, budgets,
//! and contribution records. Every mutation is a signed, community-level
//! Nostr event on the relay's hash-chain audit log.
//!
//! The `allowance` subcommands are the onchain value layer: the spend
//! ceiling of a kind:37012 budget with an `onchain` binding is enforced
//! against `OrgAllowance.sol` at the point where an agent would spend
//! (see `crates/buzz-evm-allowance`). Opt-in via `BUZZ_EVM_*` env; with it
//! unset, every other org command behaves exactly as before.

use buzz_core::kind::{KIND_CONTRIBUTION_RECORD, KIND_ORG_BUDGET, KIND_ORG_GRANT, KIND_ORG_NODE};
use buzz_evm_allowance::{AllowanceClient, AllowanceDecision, AllowanceError, Window};
use buzz_sdk::{
    build_budget_spend_receipt, build_delete_addressable, BudgetLimits, BudgetSpendReceiptContent,
    BudgetWindow, ContributionRecordContent, HumanVsAi, OnExceed, OrgBudgetContent,
    OrgGrantContent, OrgNodeContent, OrgNodeKind, OrgScope, ReviewStatus, SpendLimit, TaskLimits,
    ORG_D_MAX_LEN,
};
use nostr::{Event, Timestamp};

use crate::client::BuzzClient;
use crate::commands::parse_write_response;
use crate::error::CliError;

const ORG_QUERY_EVENT_BOUND: u32 = 10_000;

// ── Helpers ────────────────────────────────────────────────────────────────

fn validate_d_tag(d: &str, what: &str) -> Result<(), CliError> {
    if d.is_empty() {
        return Err(CliError::Usage(format!("{what} id must not be empty")));
    }
    if d.len() > ORG_D_MAX_LEN {
        return Err(CliError::Usage(format!(
            "{what} id exceeds {ORG_D_MAX_LEN} bytes"
        )));
    }
    Ok(())
}

fn validate_pubkey_hex(s: &str, what: &str) -> Result<String, CliError> {
    if s.len() != 64 || !s.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(CliError::Usage(format!(
            "{what} must be a 64-character hex pubkey"
        )));
    }
    Ok(s.to_ascii_lowercase())
}

async fn fetch_org_events(
    client: &BuzzClient,
    kinds: Vec<u32>,
    extra: Option<serde_json::Value>,
) -> Result<Vec<Event>, CliError> {
    let mut filter = serde_json::json!({ "kinds": kinds });
    if let Some(e) = extra {
        if let (Some(obj), serde_json::Value::Object(extra)) = (filter.as_object_mut(), e) {
            for (k, v) in extra {
                obj.insert(k, v);
            }
        }
    }
    client
        .query_all_bounded(filter, ORG_QUERY_EVENT_BOUND)
        .await?
        .into_iter()
        .map(|event| {
            serde_json::from_value(event)
                .map_err(|e| CliError::Other(format!("failed to parse relay response: {e}")))
        })
        .collect::<Result<_, _>>()
}

fn tombstoned_coordinates(events: &[Event]) -> std::collections::HashSet<String> {
    events
        .iter()
        .flat_map(|event| {
            event.tags.iter().filter_map(|tag| match tag.as_slice() {
                [n, v, ..] if n.as_str() == "a" => Some(v.clone()),
                _ => None,
            })
        })
        .collect()
}

async fn fetch_tombstones(
    client: &BuzzClient,
    coordinates: Vec<String>,
) -> Result<std::collections::HashSet<String>, CliError> {
    let mut out = std::collections::HashSet::new();
    for group in coordinates.chunks(100) {
        if group.is_empty() {
            continue;
        }
        let filter = serde_json::json!({ "kinds": [5], "#a": group });
        let events: Vec<Event> = client
            .query_all_bounded(filter, ORG_QUERY_EVENT_BOUND)
            .await?
            .into_iter()
            .filter_map(|e| serde_json::from_value(e).ok())
            .collect();
        out.extend(tombstoned_coordinates(&events));
    }
    Ok(out)
}

fn tag_value(event: &Event, name: &str) -> Option<String> {
    event.tags.iter().find_map(|tag| match tag.as_slice() {
        [n, v, ..] if n.as_str() == name && !v.is_empty() => Some(v.clone()),
        _ => None,
    })
}

// ── Node commands ──────────────────────────────────────────────────────────

async fn cmd_node_create(
    client: &BuzzClient,
    node_id: &str,
    name: &str,
    kind: &str,
    parent: Option<&str>,
    holders: &[String],
    agent_seats: &[String],
) -> Result<(), CliError> {
    validate_d_tag(node_id, "node")?;

    let node_kind: OrgNodeKind = kind
        .parse()
        .map_err(|e: buzz_sdk::SdkError| CliError::Usage(e.to_string()))?;

    let holders_hex: Vec<String> = holders
        .iter()
        .map(|h| validate_pubkey_hex(h, "holder"))
        .collect::<Result<_, _>>()?;
    let agents_hex: Vec<String> = agent_seats
        .iter()
        .map(|a| validate_pubkey_hex(a, "agent seat"))
        .collect::<Result<_, _>>()?;

    let content = OrgNodeContent {
        v: 1,
        name: name.to_string(),
        node_kind,
        parent: parent.map(|s| s.to_string()),
        holders: holders_hex,
        agent_seats: agents_hex,
        scope: OrgScope::default(),
        ui: None,
    };

    let builder =
        buzz_sdk::build_org_node(node_id, &content).map_err(|e| CliError::Usage(e.to_string()))?;
    let event = client.sign_event(builder)?;
    let response = client.submit_event(event).await?;
    println!(
        "{}",
        parse_write_response(&response, "node already exists")?
    );
    Ok(())
}

async fn cmd_node_get(
    client: &BuzzClient,
    node_id: &str,
    _author: Option<&str>,
) -> Result<(), CliError> {
    validate_d_tag(node_id, "node")?;
    let filter = serde_json::json!({ "kinds": [KIND_ORG_NODE], "#d": [node_id] });
    let events = fetch_org_events(client, vec![KIND_ORG_NODE], Some(filter)).await?;

    let tombstones = fetch_tombstones(
        client,
        events
            .iter()
            .map(|e| {
                let pk = hex::encode(e.pubkey.to_bytes());
                format!("{KIND_ORG_NODE}:{pk}:{node_id}")
            })
            .collect(),
    )
    .await?;

    let active: Vec<&Event> = events
        .iter()
        .filter(|e| {
            let pk = hex::encode(e.pubkey.to_bytes());
            let coord = format!("{KIND_ORG_NODE}:{pk}:{node_id}");
            !tombstones.contains(&coord)
        })
        .collect();

    if active.is_empty() {
        return Err(CliError::Other(format!("org node '{node_id}' not found")));
    }

    for event in active {
        println!("{}", serde_json::to_string_pretty(event).unwrap());
    }
    Ok(())
}

async fn cmd_node_list(client: &BuzzClient, limit: Option<u32>) -> Result<(), CliError> {
    let events = fetch_org_events(client, vec![KIND_ORG_NODE], None).await?;
    let limit = limit.unwrap_or(100) as usize;
    // Sort first, then take: taking before sorting returns an arbitrary subset.
    let mut nodes: Vec<&Event> = events.iter().collect();
    nodes.sort_by_key(|e| std::cmp::Reverse(e.created_at));
    nodes.truncate(limit);
    for event in nodes {
        let name = tag_value(event, "name").unwrap_or_default();
        let d = tag_value(event, "d").unwrap_or_default();
        println!("{d}\t{name}");
    }
    Ok(())
}

async fn cmd_node_delete(client: &BuzzClient, node_id: &str) -> Result<(), CliError> {
    validate_d_tag(node_id, "node")?;
    let owner_hex = hex::encode(client.keys().public_key().to_bytes());
    let builder = build_delete_addressable(KIND_ORG_NODE, &owner_hex, node_id)
        .map_err(|e| CliError::Usage(e.to_string()))?;
    let event = client.sign_event(builder)?;
    let response = client.submit_event(event).await?;
    println!("{}", parse_write_response(&response, "node not found")?);
    Ok(())
}

// ── Grant commands ─────────────────────────────────────────────────────────

async fn cmd_grant_create(
    client: &BuzzClient,
    grant_id: &str,
    grantee: &str,
    via: &str,
    verbs: &[String],
    parent_grant: Option<&str>,
    expires: Option<u64>,
) -> Result<(), CliError> {
    validate_d_tag(grant_id, "grant")?;
    let grantee_pk = validate_pubkey_hex(grantee, "grantee")?;
    let issuer_pk = hex::encode(client.keys().public_key().to_bytes());

    let content = OrgGrantContent {
        v: 1,
        issuer: issuer_pk,
        grantee: grantee_pk,
        via: via.to_string(),
        verbs: verbs.to_vec(),
        parent_grant: parent_grant.map(|s| s.to_string()),
        expires,
        revoked: false,
    };

    let builder = buzz_sdk::build_org_grant(grant_id, &content)
        .map_err(|e| CliError::Usage(e.to_string()))?;
    let event = client.sign_event(builder)?;
    let response = client.submit_event(event).await?;
    println!(
        "{}",
        parse_write_response(&response, "grant already exists")?
    );
    Ok(())
}

async fn cmd_grant_revoke(client: &BuzzClient, grant_id: &str) -> Result<(), CliError> {
    validate_d_tag(grant_id, "grant")?;

    // Fetch the current grant to read its content and republish with revoked=true.
    let filter = serde_json::json!({ "kinds": [KIND_ORG_GRANT], "#d": [grant_id] });
    let events = fetch_org_events(client, vec![KIND_ORG_GRANT], Some(filter.clone())).await?;

    let head = events
        .iter()
        .max_by_key(|e| e.created_at)
        .ok_or_else(|| CliError::Other(format!("grant '{grant_id}' not found")))?;
    let head_ts = head.created_at;

    let mut content: OrgGrantContent = serde_json::from_str(&head.content)
        .map_err(|e| CliError::Other(format!("failed to parse grant content: {e}")))?;
    content.revoked = true;

    // Publish at `max(now, head.created_at + 1)` so the revoke dominates the
    // observed head under NIP-33 last-write-wins (same pattern as project
    // deletion). Republishing at an arbitrary `now` could be dominated — and
    // silently dropped — by a concurrent newer edit of the same grant.
    let next_ts = head_ts
        .as_secs()
        .checked_add(1)
        .map(|after_head| after_head.max(Timestamp::now().as_secs()))
        .ok_or_else(|| CliError::Other("grant timestamp cannot be advanced".into()))?;
    let builder = buzz_sdk::build_org_grant(grant_id, &content)
        .map_err(|e| CliError::Usage(e.to_string()))?
        .custom_created_at(Timestamp::from(next_ts));
    let event = client.sign_event(builder)?;
    let revoke_ts = event.created_at;
    let response = client.submit_event(event).await?;
    println!(
        "{}",
        parse_write_response(&response, "grant was updated while revoking")?
    );

    // Post-submit guard (mirrors `projects delete`): re-fetch the coordinate.
    // If a newer head survived our revoke, a concurrent edit raced it — fail
    // instead of pretending the grant was revoked.
    let after = fetch_org_events(client, vec![KIND_ORG_GRANT], Some(filter.clone())).await?;
    if let Some(latest) = after.iter().max_by_key(|e| e.created_at) {
        let latest_revoked = serde_json::from_str::<OrgGrantContent>(&latest.content)
            .map(|c| c.revoked)
            .unwrap_or(false);
        if latest.created_at > revoke_ts || !latest_revoked {
            return Err(CliError::Conflict(
                "grant was updated while revoking".into(),
            ));
        }
    }
    Ok(())
}

async fn cmd_grant_get(client: &BuzzClient, grant_id: &str) -> Result<(), CliError> {
    validate_d_tag(grant_id, "grant")?;
    let filter = serde_json::json!({ "kinds": [KIND_ORG_GRANT], "#d": [grant_id] });
    let events = fetch_org_events(client, vec![KIND_ORG_GRANT], Some(filter)).await?;

    if events.is_empty() {
        return Err(CliError::Other(format!("grant '{grant_id}' not found")));
    }

    // Return the latest (most recent created_at).
    if let Some(head) = events.iter().max_by_key(|e| e.created_at) {
        println!("{}", serde_json::to_string_pretty(head).unwrap());
    }
    Ok(())
}

async fn cmd_grant_list(client: &BuzzClient, limit: Option<u32>) -> Result<(), CliError> {
    let events = fetch_org_events(client, vec![KIND_ORG_GRANT], None).await?;
    let limit = limit.unwrap_or(100) as usize;
    // Sort first, then take: taking before sorting returns an arbitrary subset.
    let mut grants: Vec<&Event> = events.iter().collect();
    grants.sort_by_key(|e| std::cmp::Reverse(e.created_at));
    grants.truncate(limit);
    for event in grants {
        let d = tag_value(event, "d").unwrap_or_default();
        let grantee = tag_value(event, "grantee").unwrap_or_default();
        println!("{d}\t{grantee}");
    }
    Ok(())
}

// ── Budget commands ────────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)] // CLI command: each flag is a distinct input
async fn cmd_budget_create(
    client: &BuzzClient,
    subject_id: &str,
    subject: &str,
    window: &str,
    spend_amount: Option<u64>,
    runs: Option<u32>,
    task_create: Option<u32>,
    task_approve: Option<u32>,
) -> Result<(), CliError> {
    validate_d_tag(subject_id, "budget")?;

    let budget_window: BudgetWindow = window.parse().map_err(|_| {
        CliError::Usage(format!(
            "invalid window: {window:?} (expected epoch/day/week/month)"
        ))
    })?;

    let spend = spend_amount.map(|amount| SpendLimit {
        amount,
        unit: "usd-cents".to_string(),
    });

    let tasks = if task_create.is_some() || task_approve.is_some() {
        Some(TaskLimits {
            create: task_create,
            approve: task_approve,
        })
    } else {
        None
    };

    let content = OrgBudgetContent {
        v: 1,
        subject: subject.to_string(),
        window: budget_window,
        limits: BudgetLimits { spend, runs, tasks },
        on_exceed: OnExceed::RequireApproval,
        // No CLI flag yet for the onchain spend binding — budgets created via
        // the CLI stay off-chain until a dedicated flag lands.
        onchain: None,
    };

    let builder = buzz_sdk::build_org_budget(subject_id, &content)
        .map_err(|e| CliError::Usage(e.to_string()))?;
    let event = client.sign_event(builder)?;
    let response = client.submit_event(event).await?;
    println!(
        "{}",
        parse_write_response(&response, "budget already exists")?
    );
    Ok(())
}

async fn cmd_budget_get(client: &BuzzClient, subject_id: &str) -> Result<(), CliError> {
    validate_d_tag(subject_id, "budget")?;
    let filter = serde_json::json!({ "kinds": [KIND_ORG_BUDGET], "#d": [subject_id] });
    let events = fetch_org_events(client, vec![KIND_ORG_BUDGET], Some(filter)).await?;

    if events.is_empty() {
        return Err(CliError::Other(format!("budget '{subject_id}' not found")));
    }

    if let Some(head) = events.iter().max_by_key(|e| e.created_at) {
        println!("{}", serde_json::to_string_pretty(head).unwrap());
    }
    Ok(())
}

async fn cmd_budget_list(client: &BuzzClient, limit: Option<u32>) -> Result<(), CliError> {
    let events = fetch_org_events(client, vec![KIND_ORG_BUDGET], None).await?;
    let limit = limit.unwrap_or(100) as usize;
    // Sort first, then take: taking before sorting returns an arbitrary subset.
    let mut budgets: Vec<&Event> = events.iter().collect();
    budgets.sort_by_key(|e| std::cmp::Reverse(e.created_at));
    budgets.truncate(limit);
    for event in budgets {
        let d = tag_value(event, "d").unwrap_or_default();
        let subject = serde_json::from_str::<serde_json::Value>(&event.content)
            .ok()
            .and_then(|c| c.get("subject").and_then(|s| s.as_str()).map(String::from))
            .unwrap_or_default();
        println!("{d}\t{subject}");
    }
    Ok(())
}

async fn cmd_budget_delete(client: &BuzzClient, subject_id: &str) -> Result<(), CliError> {
    validate_d_tag(subject_id, "budget")?;
    let owner_hex = hex::encode(client.keys().public_key().to_bytes());
    let builder = build_delete_addressable(KIND_ORG_BUDGET, &owner_hex, subject_id)
        .map_err(|e| CliError::Usage(e.to_string()))?;
    let event = client.sign_event(builder)?;
    let response = client.submit_event(event).await?;
    println!("{}", parse_write_response(&response, "budget not found")?);
    Ok(())
}

// ── Contribution record commands ───────────────────────────────────────────

#[allow(clippy::too_many_arguments)] // CLI command: each flag is a distinct input
async fn cmd_contribution_create(
    client: &BuzzClient,
    action_id: &str,
    action: &str,
    dimensions: &[String],
    evidence: &[String],
    informed_by: &[String],
    human_pct: f64,
    ai_pct: f64,
) -> Result<(), CliError> {
    validate_d_tag(action_id, "contribution record")?;

    if action.is_empty() {
        return Err(CliError::Usage(
            "contribution 'action' must not be empty".into(),
        ));
    }

    // Human/ai attribution fractions must each be within 0.0–1.0 and sum to 1.
    if !(0.0..=1.0).contains(&human_pct) || !(0.0..=1.0).contains(&ai_pct) {
        return Err(CliError::Usage(format!(
            "human/ai fractions must be within 0.0–1.0 (got human={human_pct}, ai={ai_pct})"
        )));
    }
    if (human_pct + ai_pct - 1.0).abs() > 1e-9 {
        return Err(CliError::Usage(format!(
            "human ({human_pct}) + ai ({ai_pct}) must sum to 1.0"
        )));
    }

    // Parse dimensions from "key:value" format.
    let mut dims = std::collections::HashMap::new();
    for dim in dimensions {
        let (key, value) = dim.split_once(':').ok_or_else(|| {
            CliError::Usage(format!(
                "dimension must be in 'key:value' format (got {dim:?})"
            ))
        })?;
        let val: f64 = value.parse().map_err(|_| {
            CliError::Usage(format!("dimension value must be a number (got {value:?})"))
        })?;
        dims.insert(key.to_string(), val);
    }

    let content = ContributionRecordContent {
        v: 1,
        action: action.to_string(),
        dimensions: dims,
        outcome: None,
        evidence: evidence.to_vec(),
        human_vs_ai: HumanVsAi {
            human: human_pct,
            ai: ai_pct,
        },
        informed_by: informed_by.to_vec(),
        classifier_version: None,
        review_status: ReviewStatus::Pending,
        appeal_history: vec![],
    };

    let builder = buzz_sdk::build_contribution_record(action_id, &content)
        .map_err(|e| CliError::Usage(e.to_string()))?;
    let event = client.sign_event(builder)?;
    let response = client.submit_event(event).await?;
    println!(
        "{}",
        parse_write_response(&response, "contribution record already exists")?
    );
    Ok(())
}

async fn cmd_contribution_get(client: &BuzzClient, action_id: &str) -> Result<(), CliError> {
    validate_d_tag(action_id, "contribution record")?;
    let filter = serde_json::json!({ "kinds": [KIND_CONTRIBUTION_RECORD], "#d": [action_id] });
    let events = fetch_org_events(client, vec![KIND_CONTRIBUTION_RECORD], Some(filter)).await?;

    if events.is_empty() {
        return Err(CliError::Other(format!(
            "contribution record '{action_id}' not found"
        )));
    }

    if let Some(head) = events.iter().max_by_key(|e| e.created_at) {
        println!("{}", serde_json::to_string_pretty(head).unwrap());
    }
    Ok(())
}

async fn cmd_contribution_list(client: &BuzzClient, limit: Option<u32>) -> Result<(), CliError> {
    let events = fetch_org_events(client, vec![KIND_CONTRIBUTION_RECORD], None).await?;
    let limit = limit.unwrap_or(100) as usize;
    // Sort first, then take: taking before sorting returns an arbitrary subset.
    let mut records: Vec<&Event> = events.iter().collect();
    records.sort_by_key(|e| std::cmp::Reverse(e.created_at));
    records.truncate(limit);
    for event in records {
        let d = tag_value(event, "d").unwrap_or_default();
        let action = serde_json::from_str::<serde_json::Value>(&event.content)
            .ok()
            .and_then(|c| c.get("action").and_then(|a| a.as_str()).map(String::from))
            .unwrap_or_default();
        println!("{d}\t{action}");
    }
    Ok(())
}

// ── Dispatch ───────────────────────────────────────────────────────────────

// ── Onchain allowance commands (OrgAllowance.sol) ──────────────────────────

/// Environment variable carrying the EVM node URL the guard talks to.
const ENV_EVM_RPC_URL: &str = "BUZZ_EVM_RPC_URL";
/// Environment variable carrying the deployed OrgAllowance contract address.
const ENV_ALLOWANCE_CONTRACT: &str = "BUZZ_ALLOWANCE_CONTRACT";
/// Environment variable carrying the authorized spender EVM key.
const ENV_SPENDER_KEY: &str = "BUZZ_SPENDER_KEY";

fn parse_allowance_amount(amount: &str) -> Result<u128, CliError> {
    amount
        .trim()
        .parse::<u128>()
        .map_err(|_| CliError::Usage(format!("amount must be a decimal integer: {amount:?}")))
}

fn parse_allowance_window(window: &str) -> Result<Window, CliError> {
    window
        .parse::<Window>()
        .map_err(|e| CliError::Usage(e.to_string()))
}

/// Build the guard from the opt-in environment. Returns a usage error that
/// documents the seam when the binding is unset — the default (unset)
/// behavior of every other command is unchanged.
fn allowance_client(rpc_url: &str, contract: &str) -> Result<AllowanceClient, CliError> {
    AllowanceClient::new(rpc_url, contract)
        .map_err(|e| CliError::Usage(format!("invalid allowance configuration: {e}")))
}

/// `buzz org allowance check` — read-only onchain spend-ceiling check.
///
/// Local-only: needs no relay connection and no Nostr key. Fails closed:
/// any guard error is a non-zero exit, never an allowance.
pub async fn cmd_allowance_check(
    subject: &str,
    token: &str,
    amount: &str,
    window: &str,
) -> Result<(), CliError> {
    let amount = parse_allowance_amount(amount)?;
    let window = parse_allowance_window(window)?;
    let rpc_url = std::env::var(ENV_EVM_RPC_URL)
        .ok()
        .filter(|v| !v.is_empty());
    let contract = std::env::var(ENV_ALLOWANCE_CONTRACT)
        .ok()
        .filter(|v| !v.is_empty());
    let (Some(rpc_url), Some(contract)) = (rpc_url, contract) else {
        return Err(CliError::Usage(format!(
            "onchain allowance enforcement is opt-in: set {ENV_EVM_RPC_URL} and \
             {ENV_ALLOWANCE_CONTRACT} to enable it"
        )));
    };
    let client = allowance_client(&rpc_url, &contract)?;
    let decision = client.check(subject, token, amount, window).await;
    match decision {
        AllowanceDecision::Allowed { remaining_after } => {
            println!(
                "{}",
                serde_json::json!({
                    "decision": "allowed",
                    "remainingAfter": remaining_after.to_string(),
                    "window": window.as_str(),
                    "contract": client.contract_hex(),
                })
            );
            Ok(())
        }
        AllowanceDecision::Exceeded { remaining } => Err(CliError::Other(format!(
            "spend exceeds the onchain allowance: remaining {} (window {})",
            remaining, window
        ))),
        AllowanceDecision::Denied { reason } => Err(CliError::Other(format!(
            "allowance check failed closed (deny): {reason}"
        ))),
    }
}

/// `buzz org allowance spend` — settle a spend onchain from the authorized
/// spender key, then mirror a kind:37014 Budget Spend Receipt to the relay.
///
/// The receipt is published only after the spend transaction mined
/// successfully; a failed or unconfirmed spend publishes nothing.
async fn cmd_allowance_spend(
    client: &BuzzClient,
    subject: &str,
    token: &str,
    amount: &str,
    window: &str,
    unit: &str,
) -> Result<(), CliError> {
    let amount = parse_allowance_amount(amount)?;
    let window = parse_allowance_window(window)?;
    let budget_window: BudgetWindow = window
        .as_str()
        .parse()
        .map_err(|e| CliError::Usage(format!("{e}")))?;

    let rpc_url = std::env::var(ENV_EVM_RPC_URL)
        .ok()
        .filter(|v| !v.is_empty());
    let contract = std::env::var(ENV_ALLOWANCE_CONTRACT)
        .ok()
        .filter(|v| !v.is_empty());
    let spender_key = std::env::var(ENV_SPENDER_KEY)
        .ok()
        .filter(|v| !v.is_empty());
    let (Some(rpc_url), Some(contract), Some(spender_key)) = (rpc_url, contract, spender_key)
    else {
        return Err(CliError::Usage(format!(
            "onchain allowance enforcement is opt-in: set {ENV_EVM_RPC_URL}, \
             {ENV_ALLOWANCE_CONTRACT} and {ENV_SPENDER_KEY} to enable it"
        )));
    };

    let guard = allowance_client(&rpc_url, &contract)?
        .with_spender_key(&spender_key)
        .map_err(|e| CliError::Usage(format!("invalid {ENV_SPENDER_KEY}: {e}")))?;

    // Fail closed before broadcasting: a denied or exceeded check never
    // reaches the chain.
    if let AllowanceDecision::Exceeded { remaining } =
        guard.check(subject, token, amount, window).await
    {
        return Err(CliError::Other(format!(
            "spend exceeds the onchain allowance: remaining {remaining} (window {})",
            window
        )));
    }

    let receipt = guard
        .record_spend(subject, token, amount, window)
        .await
        .map_err(|e: AllowanceError| match e {
            AllowanceError::SpendRejectedByContract { detail } => CliError::Other(format!(
                "the contract refused the spend at simulation; nothing was broadcast: {detail}"
            )),
            AllowanceError::SpendReverted { tx_hash } => CliError::Other(format!(
                "spend transaction {tx_hash} reverted onchain; nothing was spent"
            )),
            AllowanceError::SpendUnconfirmed { tx_hash, .. } => CliError::Other(format!(
                "spend transaction {tx_hash} not confirmed in time; \
                 treat the spend as unsettled and re-check before retrying"
            )),
            other => CliError::Other(format!("spend failed closed: {other}")),
        })?;

    // Receipt mirror — kind:37014, published only after a settled spend.
    // The d tag (NIP-33 replacement key) is the tx hash: one receipt per
    // onchain spend, idempotent under republication.
    let spend_id = receipt
        .tx_hash
        .trim_start_matches("0x")
        .to_ascii_lowercase();
    if spend_id.len() > ORG_D_MAX_LEN {
        return Err(CliError::Other(format!(
            "tx hash exceeds the {}-byte d-tag cap",
            ORG_D_MAX_LEN
        )));
    }
    let content = BudgetSpendReceiptContent {
        v: 1,
        subject: subject.to_ascii_lowercase(),
        token: token.to_ascii_lowercase(),
        amount: u64::try_from(amount).map_err(|_| {
            CliError::Other("amount exceeds u64 and cannot be mirrored to a receipt".into())
        })?,
        unit: unit.to_string(),
        epoch: window.epoch_now(),
        window: budget_window,
        tx_hash: receipt.tx_hash.clone(),
        contract: guard.contract_hex(),
    };
    let builder = build_budget_spend_receipt(&spend_id, &content)
        .map_err(|e| CliError::Usage(e.to_string()))?;
    let event = client.sign_event(builder)?;
    let response = client.submit_event(event).await?;
    parse_write_response(&response, "spend receipt was dominated; retry")?;

    println!(
        "{}",
        serde_json::json!({
            "status": "ok",
            "txHash": receipt.tx_hash,
            "receipt": { "kind": 37014, "d": spend_id },
            "amount": amount.to_string(),
            "unit": unit,
            "window": window.as_str(),
            "contract": guard.contract_hex(),
        })
    );
    Ok(())
}

pub async fn dispatch(cmd: crate::OrgCmd, client: &BuzzClient) -> Result<(), CliError> {
    use crate::OrgCmd;
    match cmd {
        OrgCmd::Node(sub) => match sub {
            crate::OrgNodeCmd::Create {
                id,
                name,
                kind,
                parent,
                holder,
                agent_seat,
            } => {
                cmd_node_create(
                    client,
                    &id,
                    &name,
                    &kind,
                    parent.as_deref(),
                    &holder,
                    &agent_seat,
                )
                .await
            }
            crate::OrgNodeCmd::Get { id, author } => {
                cmd_node_get(client, &id, author.as_deref()).await
            }
            crate::OrgNodeCmd::List { limit } => cmd_node_list(client, limit).await,
            crate::OrgNodeCmd::Delete { id } => cmd_node_delete(client, &id).await,
        },
        OrgCmd::Grant(sub) => match sub {
            crate::OrgGrantCmd::Create {
                id,
                grantee,
                via,
                verb,
                parent_grant,
                expires,
            } => {
                cmd_grant_create(
                    client,
                    &id,
                    &grantee,
                    &via,
                    &verb,
                    parent_grant.as_deref(),
                    expires,
                )
                .await
            }
            crate::OrgGrantCmd::Revoke { id } => cmd_grant_revoke(client, &id).await,
            crate::OrgGrantCmd::Get { id } => cmd_grant_get(client, &id).await,
            crate::OrgGrantCmd::List { limit } => cmd_grant_list(client, limit).await,
        },
        OrgCmd::Budget(sub) => match sub {
            crate::OrgBudgetCmd::Create {
                id,
                subject,
                window,
                spend,
                runs,
                task_create,
                task_approve,
            } => {
                cmd_budget_create(
                    client,
                    &id,
                    &subject,
                    &window,
                    spend,
                    runs,
                    task_create,
                    task_approve,
                )
                .await
            }
            crate::OrgBudgetCmd::Get { id } => cmd_budget_get(client, &id).await,
            crate::OrgBudgetCmd::List { limit } => cmd_budget_list(client, limit).await,
            crate::OrgBudgetCmd::Delete { id } => cmd_budget_delete(client, &id).await,
        },
        OrgCmd::Contribution(sub) => match sub {
            crate::OrgContributionCmd::Create {
                id,
                action,
                dim,
                evidence,
                informed_by,
                human,
                ai,
            } => {
                cmd_contribution_create(
                    client,
                    &id,
                    &action,
                    &dim,
                    &evidence,
                    &informed_by,
                    human,
                    ai,
                )
                .await
            }
            crate::OrgContributionCmd::Get { id } => cmd_contribution_get(client, &id).await,
            crate::OrgContributionCmd::List { limit } => cmd_contribution_list(client, limit).await,
        },
        // `Allowance(Check)` is intercepted in `run()` before the relay
        // connection (local-only EVM read); only Spend reaches dispatch.
        OrgCmd::Allowance(sub) => match sub {
            crate::OrgAllowanceCmd::Check { .. } => unreachable!("handled before dispatch"),
            crate::OrgAllowanceCmd::Spend {
                subject,
                token,
                amount,
                window,
                unit,
            } => cmd_allowance_spend(client, &subject, &token, &amount, &window, &unit).await,
        },
    }
}
