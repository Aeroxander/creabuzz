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

use buzz_core::kind::{KIND_ORG_BUDGET, KIND_ORG_GRANT, KIND_ORG_NODE};
use buzz_sdk::{
    build_delete_addressable, BudgetLimits, BudgetWindow, GovernanceLimits, OnExceed,
    OnchainBinding, OrgBudgetContent, OrgGrantContent, OrgNodeContent, OrgNodeKind, OrgScope,
    SpendLimit, TaskLimits, ORG_D_MAX_LEN,
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

/// A `created_at` strictly newer than the record being replaced. NIP-33 keeps
/// only the newest event per coordinate, and a republish within the same second
/// as its predecessor is dropped as a duplicate — so every edit of an existing
/// record starts from `max(now, previous + 1)`.
fn next_ts(existing: Option<&Event>) -> Timestamp {
    let now = Timestamp::now().as_secs();
    let floor = existing.map_or(0, |e| e.created_at.as_secs() + 1);
    Timestamp::from(now.max(floor))
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
        onchain: None,
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
        let pretty = serde_json::to_string_pretty(event)
            .map_err(|e| CliError::Other(format!("serialize event: {e}")))?;
        println!("{}", pretty);
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

/// Merge `agent_hex` into (or out of) a node's `agentSeats`.
///
/// Returns `None` when there is nothing to change — the agent already sits in
/// the seat (attach) or does not (detach) — so callers publish only real edits.
/// Comparison is case-insensitive; holders, scope, parent and UI hints are kept.
fn with_agent_seat(
    mut content: OrgNodeContent,
    agent_hex: &str,
    detach: bool,
) -> Option<OrgNodeContent> {
    let present = content
        .agent_seats
        .iter()
        .any(|a| a.eq_ignore_ascii_case(agent_hex));
    match (present, detach) {
        (true, false) | (false, true) => None,
        (false, false) => {
            content.agent_seats.push(agent_hex.to_string());
            Some(content)
        }
        (true, true) => {
            content
                .agent_seats
                .retain(|a| !a.eq_ignore_ascii_case(agent_hex));
            Some(content)
        }
    }
}

async fn cmd_node_attach_agent(
    client: &BuzzClient,
    node_id: &str,
    agent: &str,
    detach: bool,
) -> Result<(), CliError> {
    validate_d_tag(node_id, "node")?;
    let agent_hex = validate_pubkey_hex(agent, "agent")?;
    let me = hex::encode(client.keys().public_key().to_bytes());

    // Nodes are addressed by (author, kind, d): only the author's own record
    // can be replaced, and the relay's authority anchor would reject anyone
    // else republishing this id.
    let filter = serde_json::json!({
        "kinds": [KIND_ORG_NODE],
        "#d": [node_id],
        "authors": [me],
    });
    let events = fetch_org_events(client, vec![KIND_ORG_NODE], Some(filter)).await?;
    let Some(current) = events.iter().max_by_key(|e| e.created_at) else {
        return Err(CliError::Other(format!(
            "org node '{node_id}' not found among your own nodes — only a node's author can change its seats"
        )));
    };
    let existing: OrgNodeContent = serde_json::from_str(&current.content).map_err(|e| {
        CliError::Other(format!("org node '{node_id}' has unreadable content: {e}"))
    })?;

    let Some(updated) = with_agent_seat(existing, &agent_hex, detach) else {
        println!(
            "{}",
            serde_json::json!({
                "accepted": true,
                "changed": false,
                "message": if detach { "agent is not in this seat" } else { "agent already sits in this seat" },
            })
        );
        return Ok(());
    };

    let builder = buzz_sdk::build_org_node(node_id, &updated)
        .map_err(|e| CliError::Usage(e.to_string()))?
        .custom_created_at(next_ts(Some(current)));
    let event = client.sign_event(builder)?;
    let response = client.submit_event(event).await?;
    println!(
        "{}",
        parse_write_response(&response, "node already exists")?
    );
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

// ── Budget commands ────────────────────────────────────────────────────────

/// Parse the `--onchain '<chain>|<contract>|<subject>'` flag into an
/// [`OnchainBinding`] (NIP-ORG §37012 spend binding).
///
/// One pipe-delimited value keeps the three coordinated fields atomic: a
/// binding without its subject or contract is meaningless, and clap would
/// happily accept a partial trio as three independent flags.
///
/// - `<chain>`: chain identifier, `eip155:<chainId>` (or `anvil-31337` in dev).
/// - `<contract>`: allowance contract address, `0x` + 40 hex chars.
/// - `<subject>`: the budgeted subject's 32-byte pubkey, 64 hex chars. Must
///   equal the budget's `--subject` when that names a pubkey.
pub fn parse_onchain_binding(spec: &str) -> Result<OnchainBinding, CliError> {
    let parts: Vec<&str> = spec.split('|').collect();
    if parts.len() != 3 {
        return Err(CliError::Usage(
            "--onchain must be '<chain>|<contract>|<subject>' (exactly three pipe-separated parts)"
                .to_string(),
        ));
    }
    let (chain, contract, subject) = (parts[0].trim(), parts[1].trim(), parts[2].trim());

    if chain.is_empty() {
        return Err(CliError::Usage(
            "--onchain chain must not be empty (expected eip155:<chainId>)".to_string(),
        ));
    }

    let contract_ok = contract.len() == 42
        && contract.starts_with("0x")
        && contract[2..].bytes().all(|b| b.is_ascii_hexdigit());
    if !contract_ok {
        return Err(CliError::Usage(format!(
            "--onchain contract must be a 0x-prefixed 20-byte address, got {contract:?}"
        )));
    }

    let subject_ok = subject.len() == 64 && subject.bytes().all(|b| b.is_ascii_hexdigit());
    if !subject_ok {
        return Err(CliError::Usage(format!(
            "--onchain subject must be a 32-byte hex pubkey, got {subject:?}"
        )));
    }

    Ok(OnchainBinding {
        chain: chain.to_string(),
        contract: contract.to_string(),
        subject: subject.to_lowercase(),
    })
}

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
    messages: Option<u32>,
    llm_calls: Option<u32>,
    llm_cost_cents: Option<u32>,
    onchain: Option<&str>,
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
        // `governance` caps (proposal/vote/execute — the S3 HITL gate) exist
        // on BudgetLimits but this setter has no flags for them yet; None
        // means unset, never "unlimited by promise" — the record says what it
        // knows and omits the rest.
        limits: BudgetLimits {
            spend,
            runs,
            tasks,
            governance: None,
            messages,
            llm_calls,
            llm_cost_cents,
        },
        on_exceed: OnExceed::RequireApproval,
        onchain: onchain.map(parse_onchain_binding).transpose()?,
        performance_link: None,
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

// ── Emergency stop ─────────────────────────────────────────────────────────

/// The newest record per `d` among `events` (NIP-33: only the newest counts).
fn newest_per_d(events: Vec<Event>) -> Vec<(String, Event)> {
    let mut newest: std::collections::HashMap<String, Event> = std::collections::HashMap::new();
    for event in events {
        let Some(d) = tag_value(&event, "d") else {
            continue;
        };
        match newest.get(&d) {
            Some(cur) if cur.created_at >= event.created_at => {}
            _ => {
                newest.insert(d, event);
            }
        }
    }
    let mut out: Vec<_> = newest.into_iter().collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// The all-time, hard-reject budget that stops an agent at once. The strictest
/// budget wins at enforcement, so this overrides whatever else covers it.
fn stop_budget(agent_hex: &str) -> OrgBudgetContent {
    OrgBudgetContent {
        v: 1,
        subject: agent_hex.to_string(),
        window: BudgetWindow::Epoch,
        limits: BudgetLimits {
            spend: Some(SpendLimit {
                amount: 0,
                unit: "usd-cents".to_string(),
            }),
            runs: Some(0),
            tasks: Some(TaskLimits {
                create: Some(0),
                approve: Some(0),
            }),
            governance: Some(GovernanceLimits {
                proposal: Some(0),
                vote: Some(0),
                execute: Some(0),
            }),
            messages: Some(0),
            llm_calls: Some(0),
            llm_cost_cents: Some(0),
        },
        on_exceed: OnExceed::Reject,
        onchain: None,
        performance_link: None,
    }
}

async fn stop_step_budget(
    client: &BuzzClient,
    agent_hex: &str,
    me: &str,
) -> Result<usize, CliError> {
    let id = format!("stop-{}", &agent_hex[..16]);
    let content = stop_budget(agent_hex);
    let filter = serde_json::json!({ "authors": [me], "#d": [id] });
    let existing = fetch_org_events(client, vec![KIND_ORG_BUDGET], Some(filter)).await?;
    let current = existing.iter().max_by_key(|e| e.created_at);
    // Already in force: nothing to publish (an identical republish within the
    // same second would only be dropped as a duplicate).
    if let Some(e) = current {
        if serde_json::from_str::<OrgBudgetContent>(&e.content).is_ok_and(|c| c == content) {
            return Ok(0);
        }
    }
    let builder = buzz_sdk::build_org_budget(&id, &content)
        .map_err(|e| CliError::Usage(e.to_string()))?
        .custom_created_at(next_ts(current));
    let event = client.sign_event(builder)?;
    let response = client.submit_event(event).await?;
    parse_write_response(&response, "stop budget already exists")?;
    Ok(1)
}

async fn stop_step_ban(
    client: &BuzzClient,
    agent_hex: &str,
    reason: Option<&str>,
) -> Result<usize, CliError> {
    let builder = buzz_sdk::build_moderation_ban(agent_hex, None, reason)
        .map_err(|e| CliError::Usage(format!("invalid ban: {e}")))?;
    let event = client.sign_event(builder)?;
    client.submit_event(event).await?;
    Ok(1)
}

async fn stop_step_seats(
    client: &BuzzClient,
    agent_hex: &str,
    me: &str,
) -> Result<usize, CliError> {
    let filter = serde_json::json!({ "authors": [me] });
    let events = fetch_org_events(client, vec![KIND_ORG_NODE], Some(filter)).await?;
    let mut changed = 0;
    for (d, event) in newest_per_d(events) {
        let Ok(content) = serde_json::from_str::<OrgNodeContent>(&event.content) else {
            continue;
        };
        let Some(updated) = with_agent_seat(content, agent_hex, true) else {
            continue;
        };
        let builder = buzz_sdk::build_org_node(&d, &updated)
            .map_err(|e| CliError::Usage(e.to_string()))?
            .custom_created_at(next_ts(Some(&event)));
        let signed = client.sign_event(builder)?;
        let response = client.submit_event(signed).await?;
        parse_write_response(&response, "node already exists")?;
        changed += 1;
    }
    Ok(changed)
}

async fn stop_step_grants(
    client: &BuzzClient,
    agent_hex: &str,
    me: &str,
) -> Result<usize, CliError> {
    let filter = serde_json::json!({ "authors": [me] });
    let events = fetch_org_events(client, vec![KIND_ORG_GRANT], Some(filter)).await?;
    let mut changed = 0;
    for (d, event) in newest_per_d(events) {
        let Ok(raw) = serde_json::from_str::<serde_json::Value>(&event.content) else {
            continue;
        };
        // Ownership stakes are records, not delegations: an emergency stop
        // cuts an agent's authority, it does not confiscate its equity.
        if buzz_core::org_grant::is_equity_grant_content(&raw) {
            continue;
        }
        let Ok(mut grant) = serde_json::from_value::<OrgGrantContent>(raw) else {
            continue;
        };
        if grant.revoked || !grant.grantee.eq_ignore_ascii_case(agent_hex) {
            continue;
        }
        grant.revoked = true;
        let builder = buzz_sdk::build_org_grant(&d, &grant)
            .map_err(|e| CliError::Usage(e.to_string()))?
            .custom_created_at(next_ts(Some(&event)));
        let signed = client.sign_event(builder)?;
        let response = client.submit_event(signed).await?;
        parse_write_response(&response, "grant already exists")?;
        changed += 1;
    }
    Ok(changed)
}

async fn cmd_agent_stop(
    client: &BuzzClient,
    pubkey: &str,
    ban: bool,
    reason: Option<&str>,
) -> Result<(), CliError> {
    let agent_hex = validate_pubkey_hex(pubkey, "agent")?;
    let me = hex::encode(client.keys().public_key().to_bytes());
    if agent_hex == me {
        return Err(CliError::Usage(
            "refusing to stop your own key — pass the agent's pubkey".into(),
        ));
    }

    let mut steps: Vec<serde_json::Value> = Vec::new();
    let mut failed: Vec<&str> = Vec::new();
    let mut record = |name: &'static str, result: Result<usize, CliError>| match result {
        Ok(changed) => {
            steps.push(serde_json::json!({ "step": name, "ok": true, "changed": changed }))
        }
        Err(e) => {
            failed.push(name);
            steps.push(serde_json::json!({ "step": name, "ok": false, "error": e.to_string() }));
        }
    };

    // Containment first: every later step is cleanup, and a failure in one
    // must not stop the others — the whole sequence is safe to re-run.
    record("budget", stop_step_budget(client, &agent_hex, &me).await);
    if ban {
        record("ban", stop_step_ban(client, &agent_hex, reason).await);
    }
    record("seats", stop_step_seats(client, &agent_hex, &me).await);
    record("grants", stop_step_grants(client, &agent_hex, &me).await);

    println!(
        "{}",
        serde_json::json!({ "agent": agent_hex, "stopped": failed.is_empty(), "steps": steps })
    );
    if failed.is_empty() {
        Ok(())
    } else {
        Err(CliError::Other(format!(
            "emergency stop incomplete — failed: {}; re-run to finish",
            failed.join(", ")
        )))
    }
}

/// Resolve a budget-overrun approval request: publish the grant or deny
/// command the relay's approval surface consumes (`d` = the request's token
/// hash, as carried by the kind:46010 event).
async fn cmd_budget_resolve(
    client: &BuzzClient,
    request: &str,
    approved: bool,
    note: Option<&str>,
) -> Result<(), CliError> {
    let request = validate_pubkey_hex(request, "request id")?;
    let builder = buzz_sdk::build_workflow_approval(&request, approved, note.unwrap_or(""))
        .map_err(|e| CliError::Usage(e.to_string()))?;
    let event = client.sign_event(builder)?;
    let response = client.submit_event(event).await?;
    println!(
        "{}",
        parse_write_response(&response, "approval already resolved")?
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
        let pretty = serde_json::to_string_pretty(head)
            .map_err(|e| CliError::Other(format!("serialize event: {e}")))?;
        println!("{}", pretty);
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

// ── Dispatch ───────────────────────────────────────────────────────────────

// ── Onchain allowance commands (OrgAllowance.sol) ──────────────────────────

pub async fn dispatch(cmd: crate::OrgCmd, client: &BuzzClient) -> Result<(), CliError> {
    use crate::OrgCmd;
    match cmd {
        OrgCmd::Agent(crate::OrgAgentCmd::Stop {
            pubkey,
            ban,
            reason,
        }) => cmd_agent_stop(client, &pubkey, ban, reason.as_deref()).await,
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
            crate::OrgNodeCmd::AttachAgent { id, agent, detach } => {
                cmd_node_attach_agent(client, &id, &agent, detach).await
            }
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
                messages,
                llm_calls,
                llm_cost_cents,
                onchain,
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
                    messages,
                    llm_calls,
                    llm_cost_cents,
                    onchain.as_deref(),
                )
                .await
            }
            crate::OrgBudgetCmd::Resolve {
                request,
                deny,
                note,
            } => cmd_budget_resolve(client, &request, !deny, note.as_deref()).await,
            crate::OrgBudgetCmd::Get { id } => cmd_budget_get(client, &id).await,
            crate::OrgBudgetCmd::List { limit } => cmd_budget_list(client, limit).await,
            crate::OrgBudgetCmd::Delete { id } => cmd_budget_delete(client, &id).await,
        },
    }
}
