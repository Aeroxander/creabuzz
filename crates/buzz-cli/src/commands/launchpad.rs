//! `buzz launchpad` commands — NIP-LP kind:37001/47002–47005 read/write path.
//!
//! The chain is the ledger; Nostr is the record. Reads assemble the directory
//! and per-launch views from relay events; writes publish signed records and
//! mirrors. Mirror commands never move money — settlement is onchain.

use buzz_core::kind::{
    KIND_DELETION, KIND_DEPLOYMENT_RECORD, KIND_LAUNCH_BID, KIND_LAUNCH_PROPOSAL,
    KIND_LAUNCH_RECEIPT, KIND_LAUNCH_RECORD, KIND_LAUNCH_UPDATE,
};
use nostr::{Event, EventBuilder, Kind, Tag, Timestamp};

use crate::client::BuzzClient;
use crate::commands::parse_write_response;
use crate::error::CliError;

pub(crate) const LAUNCHPAD_QUERY_EVENT_BOUND: u32 = 10_000;
const LAUNCH_ID_RE: &str = "^[a-z0-9][a-z0-9_-]{0,63}$";

fn validate_launch_id(id: &str) -> Result<(), CliError> {
    let ok = !id.is_empty() && id.len() <= 64 && {
        let bytes = id.as_bytes();
        (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
            && bytes[1..]
                .iter()
                .all(|&b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
    };
    if ok {
        Ok(())
    } else {
        Err(CliError::Usage(format!(
            "launch id must match {LAUNCH_ID_RE} (got {id:?})"
        )))
    }
}

fn validate_0x_address(value: &str, what: &str) -> Result<(), CliError> {
    let ok = value.len() == 42
        && value.starts_with("0x")
        && value[2..].bytes().all(|b| b.is_ascii_hexdigit());
    if ok {
        Ok(())
    } else {
        Err(CliError::Usage(format!(
            "{what} must be a 0x address (got {value:?})"
        )))
    }
}

fn tag_value(event: &Event, name: &str) -> Option<String> {
    event.tags.iter().find_map(|tag| match tag.as_slice() {
        [n, v, ..] if n.as_str() == name && !v.is_empty() => Some(v.clone()),
        _ => None,
    })
}

fn launch_coordinate(author_hex: &str, id: &str) -> String {
    format!("{KIND_LAUNCH_RECORD}:{author_hex}:{id}")
}

async fn fetch_launchpad_events(
    client: &BuzzClient,
    kinds: Vec<u32>,
) -> Result<Vec<Event>, CliError> {
    let filter = serde_json::json!({ "kinds": kinds });
    client
        .query_all_bounded(filter, LAUNCHPAD_QUERY_EVENT_BOUND)
        .await?
        .into_iter()
        .map(|event| {
            serde_json::from_value(event)
                .map_err(|e| CliError::Other(format!("failed to parse relay response: {e}")))
        })
        .collect::<Result<_, _>>()
}

fn tombstoned_coordinates(client_events: &[Event]) -> std::collections::HashSet<String> {
    client_events
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
        let filter = serde_json::json!({ "kinds": [KIND_DELETION], "#a": group });
        let events: Vec<Event> = client
            .query_all_bounded(filter, LAUNCHPAD_QUERY_EVENT_BOUND)
            .await?
            .into_iter()
            .map(|event| {
                serde_json::from_value(event)
                    .map_err(|e| CliError::Other(format!("failed to parse relay response: {e}")))
            })
            .collect::<Result<_, _>>()?;
        out.extend(tombstoned_coordinates(&events));
    }
    Ok(out)
}

fn summarize_record(event: &Event) -> serde_json::Value {
    let body: serde_json::Value =
        serde_json::from_str(event.content.as_str()).unwrap_or(serde_json::Value::Null);
    serde_json::json!({
        "id": tag_value(event, "d"),
        "name": tag_value(event, "name"),
        "author": event.pubkey.to_hex(),
        "created_at": event.created_at.as_secs(),
        "stage": body.get("stage"),
        "admission": tag_value(event, "admission").unwrap_or_else(|| "curated".into()),
        "chain": tag_value(event, "chain"),
        "auction": tag_value(event, "auction"),
        "token": tag_value(event, "token"),
        "treasury": tag_value(event, "treasury"),
    })
}

/// `buzz launchpad list`
async fn cmd_list(client: &BuzzClient, limit: Option<u32>) -> Result<(), CliError> {
    let events = fetch_launchpad_events(client, vec![KIND_LAUNCH_RECORD]).await?;
    let coords: Vec<String> = events
        .iter()
        .filter_map(|e| tag_value(e, "d").map(|d| launch_coordinate(&e.pubkey.to_hex(), &d)))
        .collect();
    let dead = fetch_tombstones(client, coords).await?;
    let mut out: Vec<serde_json::Value> = events
        .iter()
        .filter(|e| {
            tag_value(e, "d")
                .map(|d| !dead.contains(&launch_coordinate(&e.pubkey.to_hex(), &d)))
                .unwrap_or(false)
        })
        .map(summarize_record)
        .collect();
    out.sort_by_key(|v| v.get("created_at").and_then(|c| c.as_u64()).unwrap_or(0));
    out.reverse();
    if let Some(limit) = limit {
        out.truncate(limit as usize);
    }
    println!("{}", serde_json::json!(out));
    Ok(())
}

/// `buzz launchpad show <id> [--author <hex>]`
async fn cmd_show(client: &BuzzClient, id: &str, author: Option<&str>) -> Result<(), CliError> {
    validate_launch_id(id)?;
    let owner = match author {
        Some(hex) => hex.to_string(),
        None => client.keys().public_key().to_hex(),
    };
    let coordinate = launch_coordinate(&owner, id);
    let filter = serde_json::json!({
        "kinds": [KIND_LAUNCH_RECORD, KIND_LAUNCH_BID, KIND_LAUNCH_UPDATE, KIND_LAUNCH_PROPOSAL, KIND_LAUNCH_RECEIPT],
        "#a": [coordinate.clone()],
    });
    let mut mirrors: Vec<Event> = client
        .query_all_bounded(filter, LAUNCHPAD_QUERY_EVENT_BOUND)
        .await?
        .into_iter()
        .map(|event| {
            serde_json::from_value(event)
                .map_err(|e| CliError::Other(format!("failed to parse relay response: {e}")))
        })
        .collect::<Result<_, _>>()?;
    let record_filter = serde_json::json!({
        "kinds": [KIND_LAUNCH_RECORD],
        "authors": [owner.clone()],
        "#d": [id],
    });
    let mut records: Vec<Event> = client
        .query_all_bounded(record_filter, 10)
        .await?
        .into_iter()
        .map(|event| {
            serde_json::from_value(event)
                .map_err(|e| CliError::Other(format!("failed to parse relay response: {e}")))
        })
        .collect::<Result<_, _>>()?;
    records.sort_by_key(|e: &Event| e.created_at.as_secs());
    let record = records
        .pop()
        .ok_or_else(|| CliError::NotFound(format!("launch {id:?} not found for author {owner}")))?;
    mirrors.retain(|e| e.kind.as_u16() as u32 != KIND_LAUNCH_RECORD);
    let mut bids = 0;
    let mut updates = 0;
    let mut proposals = 0;
    let mut receipts: Vec<serde_json::Value> = Vec::new();
    for event in &mirrors {
        match event.kind.as_u16() as u32 {
            KIND_LAUNCH_BID => bids += 1,
            KIND_LAUNCH_UPDATE => updates += 1,
            KIND_LAUNCH_PROPOSAL => proposals += 1,
            KIND_LAUNCH_RECEIPT => receipts.push(serde_json::json!({
                "table": tag_value(event, "kind"),
                "tx": tag_value(event, "tx"),
                "created_at": event.created_at.as_secs(),
            })),
            _ => {}
        }
    }
    let tables: Vec<String> = receipts
        .iter()
        .filter_map(|r| r.get("table").and_then(|t| t.as_str()).map(str::to_string))
        .collect();
    let stage = if tables.iter().any(|t| t == "summon" || t == "graduate") {
        "graduated"
    } else if tables.iter().any(|t| t == "refund-open" || t == "failed") {
        "failed"
    } else {
        "record"
    };
    println!(
        "{}",
        serde_json::json!({
            "record": summarize_record(&record),
            "effective_stage": stage,
            "bids": bids,
            "updates": updates,
            "proposals": proposals,
            "receipts": receipts,
        })
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn cmd_curate(
    client: &BuzzClient,
    id: &str,
    name: &str,
    pitch: &str,
    chain: Option<&str>,
    currency: Option<&str>,
    floor_price: Option<&str>,
    required_raised: Option<&str>,
    auction: Option<&str>,
    token: Option<&str>,
    treasury: Option<&str>,
    admission: &str,
) -> Result<(), CliError> {
    validate_launch_id(id)?;
    if name.is_empty() || name.len() > 256 {
        return Err(CliError::Usage("name must be 1–256 chars".into()));
    }
    if admission != "curated" && admission != "community" {
        return Err(CliError::Usage(
            "admission must be 'curated' or 'community'".into(),
        ));
    }
    for (label, value) in [
        ("auction", auction),
        ("token", token),
        ("treasury", treasury),
    ] {
        if let Some(address) = value {
            validate_0x_address(address, label)?;
        }
    }
    let mut tags = vec![
        Tag::parse(["d", id]).map_err(|e| CliError::Other(format!("bad d tag: {e}")))?,
        Tag::parse(["name", name]).map_err(|e| CliError::Other(format!("bad name tag: {e}")))?,
        Tag::parse(["t", "dao-launchpad"])
            .map_err(|e| CliError::Other(format!("bad t tag: {e}")))?,
        Tag::parse(["admission", admission])
            .map_err(|e| CliError::Other(format!("bad admission tag: {e}")))?,
    ];
    if let Some(chain) = chain {
        tags.push(
            Tag::parse(["chain", chain])
                .map_err(|e| CliError::Other(format!("bad chain tag: {e}")))?,
        );
    }
    for (label, value) in [
        ("auction", auction),
        ("token", token),
        ("treasury", treasury),
    ] {
        if let Some(address) = value {
            tags.push(
                Tag::parse([label, address])
                    .map_err(|e| CliError::Other(format!("bad {label} tag: {e}")))?,
            );
        }
    }
    let content = serde_json::json!({
        "pitch": pitch,
        "stage": "draft",
        "currency": currency,
        "floorPrice": floor_price,
        "requiredRaised": required_raised,
    })
    .to_string();
    let builder = EventBuilder::new(Kind::Custom(KIND_LAUNCH_RECORD as u16), content).tags(tags);
    let event = client.sign_event(builder)?;
    let raw = client.submit_event(event).await?;
    parse_write_response(&raw, "launch record was dominated; retry")?;
    println!(
        "{}",
        serde_json::json!({ "event": "launch-record", "id": id, "status": "ok" })
    );
    Ok(())
}

/// `buzz launchpad delete <id>` — signer-self tombstone by `a` coordinate.
async fn cmd_delete(client: &BuzzClient, id: &str) -> Result<(), CliError> {
    validate_launch_id(id)?;
    let owner = client.keys().public_key().to_hex();
    let coordinate = launch_coordinate(&owner, id);
    let tombstone = EventBuilder::new(Kind::Custom(KIND_DELETION as u16), "")
        .tag(
            Tag::parse(["a", coordinate.as_str()])
                .map_err(|e| CliError::Other(format!("bad a tag: {e}")))?,
        )
        .custom_created_at(Timestamp::now());
    let event = client.sign_event(tombstone)?;
    let raw = client.submit_event(event).await?;
    parse_write_response(&raw, "delete event was dominated; a newer head exists")?;
    println!("{}", serde_json::json!({ "deleted": id, "status": "ok" }));
    Ok(())
}

async fn cmd_mirror(
    client: &BuzzClient,
    kind: u32,
    label: &str,
    owner: &str,
    id: &str,
    extra_tags: Vec<Tag>,
    content: serde_json::Value,
) -> Result<(), CliError> {
    validate_launch_id(id)?;
    let coordinate = launch_coordinate(owner, id);
    let mut tags = vec![Tag::parse(["a", coordinate.as_str()])
        .map_err(|e| CliError::Other(format!("bad a tag: {e}")))?];
    tags.extend(extra_tags);
    let builder = EventBuilder::new(Kind::Custom(kind as u16), content.to_string()).tags(tags);
    let event = client.sign_event(builder)?;
    let raw = client.submit_event(event).await?;
    parse_write_response(&raw, &format!("{label} was dominated; retry"))?;
    println!(
        "{}",
        serde_json::json!({ "event": label, "launch": id, "status": "ok" })
    );
    Ok(())
}

/// `buzz launchpad mint-token` — deploy a Standard-pool apptoken via forge script.
///
/// Deploys an ERC-20C with a TokenMaster reserve pool (native pairing) and a
/// Vanilla validator ruleset, then mints the initial supply to the treasury.
/// Dev-local chain writes (default: Anvil at localhost:8545 with its default
/// key). Refuses known public networks unless `--i-know-what-i-am-doing` is
/// passed. The local protocol set comes from the apptoken-dev environment.
#[allow(clippy::too_many_arguments)]
async fn cmd_mint_token(
    client: &BuzzClient,
    name: &str,
    symbol: &str,
    supply: &str,
    treasury: &str,
    rpc_url: &str,
    private_key: &str,
    contracts_dir: &str,
    salt: Option<&str>,
    paired_deposit_eth: &str,
    force: bool,
) -> Result<(), CliError> {
    if name.is_empty() || name.len() > 64 {
        return Err(CliError::Usage("token name must be 1–64 chars".into()));
    }
    if symbol.is_empty() || symbol.len() > 16 {
        return Err(CliError::Usage("token symbol must be 1–16 chars".into()));
    }
    let supply_units: u64 = supply
        .parse()
        .map_err(|_| CliError::Usage("supply must be whole tokens (e.g. 1000000)".into()))?;
    if supply_units == 0 {
        return Err(CliError::Usage("supply must be positive".into()));
    }
    validate_0x_address(treasury, "treasury")?;
    // Unique salt per deploy (CREATE2): default to unix time so repeated
    // mints never collide with an existing pool address.
    let salt = match salt {
        Some(value) => value.to_string(),
        None => std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_secs().to_string())
            .map_err(|e| CliError::Other(format!("system clock error: {e}")))?,
    };
    let deposit_wei: u128 = (paired_deposit_eth
        .parse::<f64>()
        .map_err(|_| CliError::Usage("paired deposit must be ETH like 0.1".into()))?
        * 1e18) as u128;
    if !force {
        for host in ["mainnet", "eth-mainnet", "base-mainnet"] {
            if rpc_url.contains(host) {
                return Err(CliError::Usage(
                    "refusing to deploy to a public network without --i-know-what-i-am-doing"
                        .into(),
                ));
            }
        }
    }
    let _ = client;
    let output = std::process::Command::new("forge")
        .arg("script")
        .arg("script/DeployAppToken.s.sol")
        .arg("--rpc-url")
        .arg(rpc_url)
        .arg("--private-key")
        .arg(private_key)
        .arg("--broadcast")
        .arg("--no-storage-caching")
        .arg("-vv")
        .current_dir(contracts_dir)
        .env("APPTOKEN_NAME", name)
        .env("APPTOKEN_SYMBOL", symbol)
        .env("APPTOKEN_INITIAL_SUPPLY", supply_units.to_string())
        .env("APPTOKEN_TREASURY", treasury)
        .env("APPTOKEN_SALT", salt)
        .env("APPTOKEN_PAIRED_DEPOSIT_WEI", deposit_wei.to_string())
        .output()
        .map_err(|e| CliError::Other(format!("failed to run forge (is it installed?): {e}")))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: Vec<&str> = stderr.lines().rev().take(8).collect();
        return Err(CliError::Other(format!(
            "forge script failed:\n{}",
            tail.into_iter().rev().collect::<Vec<_>>().join("\n")
        )));
    }
    // The script writes its result file (script emits never land in
    // broadcast receipts). `_` keeps stdout available for diagnostics.
    let _ = stdout;
    let token = deployed_token_address(contracts_dir).ok_or_else(|| {
        CliError::Other(
            "forge succeeded but deployments/apptoken-latest.json is missing or invalid".into(),
        )
    })?;
    println!(
        "{}",
        serde_json::json!({
            "event": "token",
            "standard": "apptoken",
            "pool": "standard",
            "token": token,
            "name": name,
            "symbol": symbol,
            "supply": supply_units.to_string(),
            "treasury": treasury,
            "status": "ok",
        })
    );
    Ok(())
}

/// Read the token address the deploy script wrote to
/// `deployments/apptoken-latest.json`. Validates shape, not freshness: the
/// script overwrites it on every successful deploy.
fn deployed_token_address(contracts_dir: &str) -> Option<String> {
    let path = std::path::Path::new(contracts_dir).join("deployments/apptoken-latest.json");
    let text = std::fs::read_to_string(path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    let token = json.get("token")?.as_str()?;
    if token.len() == 42
        && token.starts_with("0x")
        && token[2..].bytes().all(|b| b.is_ascii_hexdigit())
    {
        Some(token.to_string())
    } else {
        None
    }
}

pub async fn dispatch(cmd: crate::LaunchpadCmd, client: &BuzzClient) -> Result<(), CliError> {
    use crate::LaunchpadCmd;
    match cmd {
        LaunchpadCmd::List { limit } => cmd_list(client, limit).await,
        LaunchpadCmd::Show { id, author } => cmd_show(client, &id, author.as_deref()).await,
        LaunchpadCmd::Curate {
            id,
            name,
            pitch,
            chain,
            currency,
            floor_price,
            required_raised,
            auction,
            token,
            treasury,
            admission,
        } => {
            cmd_curate(
                client,
                &id,
                &name,
                &pitch,
                chain.as_deref(),
                currency.as_deref(),
                floor_price.as_deref(),
                required_raised.as_deref(),
                auction.as_deref(),
                token.as_deref(),
                treasury.as_deref(),
                &admission,
            )
            .await
        }
        LaunchpadCmd::Delete { id } => cmd_delete(client, &id).await,
        LaunchpadCmd::MintToken {
            name,
            symbol,
            supply,
            treasury,
            rpc_url,
            private_key,
            contracts_dir,
            salt,
            paired_deposit_eth,
            i_know_what_i_am_doing,
        } => {
            cmd_mint_token(
                client,
                &name,
                &symbol,
                &supply,
                &treasury,
                &rpc_url,
                &private_key,
                &contracts_dir,
                salt.as_deref(),
                &paired_deposit_eth,
                i_know_what_i_am_doing,
            )
            .await
        }
        LaunchpadCmd::ComposeBid {
            id,
            as_agent,
            auction,
            currency,
            budget,
            max_price,
            tick_spacing,
            clearing_price,
            skip_clearing,
            floor_price,
            chain_id,
            owner,
            deadline,
        } => cmd_compose_bid(
            as_agent,
            &id,
            &auction,
            currency.as_deref(),
            &budget,
            &max_price,
            &tick_spacing,
            clearing_price.as_deref(),
            skip_clearing,
            &floor_price,
            &chain_id,
            &owner,
            deadline,
        ),
        LaunchpadCmd::RecordBid {
            id,
            author,
            bucket,
            budget,
            max_price,
            tx,
        } => {
            let owner = match author {
                Some(hex) => hex,
                None => client.keys().public_key().to_hex(),
            };
            let bucket_tag = Tag::parse(["m", bucket.as_str()])
                .map_err(|e| CliError::Other(format!("bad m tag: {e}")))?;
            cmd_mirror(
                client,
                KIND_LAUNCH_BID,
                "bid",
                &owner,
                &id,
                vec![bucket_tag],
                serde_json::json!({ "budget": budget, "maxPrice": max_price, "tx": tx }),
            )
            .await
        }
        LaunchpadCmd::PostUpdate { id, title, body } => {
            let owner = client.keys().public_key().to_hex();
            cmd_mirror(
                client,
                KIND_LAUNCH_UPDATE,
                "update",
                &owner,
                &id,
                vec![],
                serde_json::json!({ "title": title, "body": body }),
            )
            .await
        }
        LaunchpadCmd::RecordProposal {
            id,
            title,
            kind,
            issue,
            proposal_id,
        } => {
            if kind != "plain" && kind != "futarchy-budget" && kind != "signal" {
                return Err(CliError::Usage(
                    "proposal kind must be 'plain', 'futarchy-budget', or 'signal'".into(),
                ));
            }
            let owner = client.keys().public_key().to_hex();
            cmd_mirror(
                client,
                KIND_LAUNCH_PROPOSAL,
                "proposal",
                &owner,
                &id,
                vec![],
                serde_json::json!({ "title": title, "kind": kind, "issue": issue, "proposalId": proposal_id }),
            )
            .await
        }
        LaunchpadCmd::RecordClaim {
            id,
            claim_id,
            evidence_hash,
            tx,
        } => cmd_claim(client, &id, &claim_id, &evidence_hash, &tx).await,
        LaunchpadCmd::RecordVerdict {
            id,
            claim_id,
            verdict,
            tx,
        } => cmd_verdict(client, &id, &claim_id, &verdict, &tx).await,
        LaunchpadCmd::RecordReceipt { id, table, tx } => {
            let owner = client.keys().public_key().to_hex();
            let tx_tag = Tag::parse(["tx", tx.as_str()])
                .map_err(|e| CliError::Other(format!("bad tx tag: {e}")))?;
            let kind_tag = Tag::parse(["kind", table.as_str()])
                .map_err(|e| CliError::Other(format!("bad kind tag: {e}")))?;
            cmd_mirror(
                client,
                KIND_LAUNCH_RECEIPT,
                "receipt",
                &owner,
                &id,
                vec![tx_tag, kind_tag],
                serde_json::json!({ "table": table }),
            )
            .await
        }
        LaunchpadCmd::Deployment { cmd } => match cmd {
            crate::DeploymentCmd::Record { file, broadcast } => {
                cmd_deployment_record(client, &file, broadcast.as_deref()).await
            }
        },
        LaunchpadCmd::Propose { .. }
        | LaunchpadCmd::Vote { .. }
        | LaunchpadCmd::Process { .. }
        | LaunchpadCmd::ProposalState { .. } => {
            unreachable!("chain-local governance commands run before auth")
        }
    }
}

/// Compose an unsigned bid. ERC-20 currency: `currency.approve(PERMIT2, amount)`,
/// then `PERMIT2.approve(..)`, then `submitBid`. Native currency: `submitBid`
/// carrying the budget as `value`. Prints a JSON envelope a wallet or `cast
/// send` can sign — the CLI never signs or moves money ("machines compose,
/// humans sign").
#[allow(clippy::too_many_arguments)]
fn cmd_compose_bid(
    as_agent: bool,
    _id: &str,
    auction: &str,
    currency: Option<&str>,
    budget: &str,
    max_price: &str,
    tick_spacing: &str,
    clearing_price: Option<&str>,
    skip_clearing: bool,
    floor_price: &str,
    chain_id: &str,
    owner: &str,
    deadline: Option<u64>,
) -> Result<(), CliError> {
    use crate::commands::launchpad_compose::{
        compose_bid_calls, encode_submit_bid, snap_max_price_to_tick, validate_bid,
    };
    use num_bigint::BigUint;

    let to_big = |s: &str| -> Result<BigUint, CliError> {
        BigUint::parse_bytes(s.trim().as_bytes(), 10)
            .ok_or_else(|| CliError::Usage(format!("not a decimal integer: {s:?}")))
    };
    validate_0x_address(auction, "auction")?;
    validate_0x_address(owner, "owner")?;
    let desired = to_big(max_price)?;
    let spacing = to_big(tick_spacing)?;
    let snapped = snap_max_price_to_tick(&desired, &spacing);
    let clearing = clearing_price.map(to_big).transpose()?.unwrap_or_default();
    if !skip_clearing {
        if let Err(msg) = validate_bid(&snapped, &spacing, &clearing) {
            return Err(CliError::Usage(msg));
        }
    }
    let amount = to_big(budget)?;
    let floor = to_big(floor_price)?;
    let bid_data =
        encode_submit_bid(&snapped, &amount, owner, Some(&floor), "0x").map_err(CliError::Other)?;

    if let Some(currency_addr) = currency {
        validate_0x_address(currency_addr, "currency")?;
    }
    let exp = deadline.unwrap_or_else(|| {
        (std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0))
            + 3600
    });
    // The ordered calls (ERC-20: underlying approve -> Permit2 approve -> bid;
    // native: the bid carrying `value`). See `compose_bid_calls`.
    let calls =
        compose_bid_calls(currency, auction, &amount, bid_data, exp).map_err(CliError::Other)?;

    let mut envelope = serde_json::json!({
        "compose": "buzz launchpad compose-bid",
        "chainId": chain_id,
        "note": "unsigned — sign with a wallet or `cast send`",
        "maxPriceQ96": format!("{snapped}"),
        "amount": format!("{amount}"),
        "calls": calls.into_iter().map(|c| serde_json::json!({
            "to": c.to,
            "value": c.value,
            "data": c.data,
        })).collect::<Vec<_>>(),
    });
    if as_agent {
        envelope
            .as_object_mut()
            .expect("envelope is an object")
            .insert("agent".into(), serde_json::json!({"auth": "BUZZ_AUTH_TAG"}));
    }
    let json = serde_json::to_string_pretty(&envelope)
        .map_err(|e| CliError::Other(format!("failed to serialize: {e}")))?;
    println!("{json}");
    Ok(())
}

/// The `tx` tag every 47005 receipt must carry.
///
/// A receipt without it is refused by the relay
/// (`crates/buzz-relay/src/handlers/ingest.rs`, `validate_launch_mirror_envelope`)
/// and dropped by the web feed parser, so a claim or verdict mirrored without
/// one reached nobody. Validated before signing so a bad hash fails here.
fn receipt_tx_tag(tx: &str) -> Result<Tag, CliError> {
    if !is_tx_hash(tx) {
        return Err(CliError::Usage(
            "tx must be a 0x-prefixed 32-byte tx hash (0x + 64 hex chars)".into(),
        ));
    }
    Tag::parse(["tx", tx]).map_err(|e| CliError::Other(format!("bad tx tag: {e}")))
}

/// Tags and content of a milestone claim receipt (47005, `kind=claim`).
fn claim_receipt_parts(
    claim_id: &str,
    evidence_hash: &str,
    tx: &str,
) -> Result<(Vec<Tag>, serde_json::Value), CliError> {
    if evidence_hash.len() != 64 || !evidence_hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(CliError::Usage(
            "evidence-hash must be 64 hex chars (a sha256 of the canonical claim)".into(),
        ));
    }
    let kind_tag =
        Tag::parse(["kind", "claim"]).map_err(|e| CliError::Other(format!("bad kind tag: {e}")))?;
    let claim_tag = Tag::parse(["claim", claim_id])
        .map_err(|e| CliError::Other(format!("bad claim tag: {e}")))?;
    let evidence_tag = Tag::parse(["evidence", evidence_hash])
        .map_err(|e| CliError::Other(format!("bad evidence tag: {e}")))?;
    Ok((
        vec![kind_tag, claim_tag, evidence_tag, receipt_tx_tag(tx)?],
        serde_json::json!({ "table": "claim", "claim": claim_id, "evidenceHash": evidence_hash }),
    ))
}

/// Tags and content of a verifier verdict receipt (47005, `kind=verdict`).
///
/// The content carries the verdict *word*, not a boolean: NIP-LP fixes the
/// vocabulary at `approve|reject` so no reader has to guess which spelling of
/// "no" this client meant.
fn verdict_receipt_parts(
    claim_id: &str,
    verdict: &str,
    tx: &str,
) -> Result<(Vec<Tag>, serde_json::Value), CliError> {
    let approved = match verdict {
        "approve" => true,
        "reject" => false,
        other => {
            return Err(CliError::Usage(format!(
                "verdict must be approve|reject (got {other:?})"
            )))
        }
    };
    let kind_tag = Tag::parse(["kind", "verdict"])
        .map_err(|e| CliError::Other(format!("bad kind tag: {e}")))?;
    let claim_tag = Tag::parse(["claim", claim_id])
        .map_err(|e| CliError::Other(format!("bad claim tag: {e}")))?;
    Ok((
        vec![kind_tag, claim_tag, receipt_tx_tag(tx)?],
        serde_json::json!({ "table": "verdict", "claim": claim_id, "verdict": if approved { "approve" } else { "reject" } }),
    ))
}

/// Record a milestone claim (47005, table=claim): the Nostr side of the
/// ClaimStake evidence hash. Mirrors are advisory; the chain escrow is the
/// authority.
async fn cmd_claim(
    client: &BuzzClient,
    id: &str,
    claim_id: &str,
    evidence_hash: &str,
    tx: &str,
) -> Result<(), CliError> {
    validate_launch_id(id)?;
    let (tags, content) = claim_receipt_parts(claim_id, evidence_hash, tx)?;
    let owner = client.keys().public_key().to_hex();
    cmd_mirror(
        client,
        KIND_LAUNCH_RECEIPT,
        "claim mirror",
        &owner,
        id,
        tags,
        content,
    )
    .await
}

/// Record a verifier verdict (47005, table=verdict): the Nostr side of a
/// VerifierSet attestation. The verdict word must be approve|reject so the
/// vocabulary stays closed; the onchain attestation is the authority.
async fn cmd_verdict(
    client: &BuzzClient,
    id: &str,
    claim_id: &str,
    verdict: &str,
    tx: &str,
) -> Result<(), CliError> {
    validate_launch_id(id)?;
    let (tags, content) = verdict_receipt_parts(claim_id, verdict, tx)?;
    let owner = client.keys().public_key().to_hex();
    cmd_mirror(
        client,
        KIND_LAUNCH_RECEIPT,
        "verdict mirror",
        &owner,
        id,
        tags,
        content,
    )
    .await
}

// ---------------------------------------------------------------------------
// Discovery plane: kind:37018 deployment records
// (`buzz launchpad deployment record`).
//
// The chain is the ledger; Nostr is the record (NIP-LP rule). The deployer —
// never the relay — authors these: `DeployOrgDao.s.sol` writes the
// deployments manifest and prints this command, and the CLI publishes one
// record per role so a client resolves "where is the Summoner" from signed
// events alone. The relay enforces the same envelope at ingest
// (`validate_deployment_record_envelope`), including the required `tx` tag.
// ---------------------------------------------------------------------------

/// Roles a kind:37018 record may name (the contract grammar).
const DEPLOYMENT_ROLES: [&str; 3] = ["summoner", "factory", "implementation"];
/// Cap on roles in one manifest: a deployment names a handful of contracts.
const DEPLOYMENT_ROLE_CAP: usize = 8;
/// Bound on manifests and broadcast artifacts read from disk (a forge
/// `run-latest.json` is a few hundred KB; 8 MiB is generous headroom).
const DEPLOYMENT_FILE_MAX_BYTES: u64 = 8 * 1024 * 1024;
/// Max chars in the optional `note` (matches the relay's cap).
const DEPLOYMENT_NOTE_MAX_CHARS: usize = 256;

/// True when `value` is a `0x`-prefixed 32-byte tx hash.
fn is_tx_hash(value: &str) -> bool {
    value.len() == 66
        && value.starts_with("0x")
        && value[2..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// One role entry of a deployments manifest.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub(crate) struct DeploymentRoleEntry {
    /// One of [`DEPLOYMENT_ROLES`].
    pub role: String,
    /// Deployed contract address (`0x` + 40 hex).
    pub address: String,
}

/// `contracts/deployments/org-dao-<chainid>.json` — the shape
/// `DeployOrgDao.s.sol` writes (the `apptoken-latest.json` convention: one
/// JSON file per deployment, read by this command and nothing else).
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub(crate) struct DeploymentManifest {
    /// EIP-155 chain the contracts were deployed on (JSON key `chainId`).
    #[serde(rename = "chainId")]
    pub chain_id: u64,
    /// Launch/org slug the records are filed under (optional).
    #[serde(default)]
    pub project: Option<String>,
    /// Free-text provenance note (optional, ≤ [`DEPLOYMENT_NOTE_MAX_CHARS`]).
    #[serde(default)]
    pub note: Option<String>,
    /// Deploying tx hash (optional — see [`resolve_deployment_tx`]).
    #[serde(default)]
    pub tx: Option<String>,
    /// Deploy block (optional — see [`resolve_deployment_tx`]).
    #[serde(default)]
    pub block: Option<u64>,
    /// Forge broadcast artifact path, relative to the manifest's directory,
    /// consulted only when `tx`/`block` are absent.
    #[serde(default)]
    pub broadcast: Option<String>,
    /// The deployed contracts, one entry per role.
    pub roles: Vec<DeploymentRoleEntry>,
}

/// Parse and validate a deployments manifest.
///
/// This is the CLI half of the kind:37018 contract; the relay re-checks every
/// shape it is given at ingest, so a manifest that slips past here still
/// cannot produce a record the relay rejects silently — it fails as a write.
pub(crate) fn parse_deployment_manifest(raw: &str) -> Result<DeploymentManifest, CliError> {
    if raw.len() as u64 > DEPLOYMENT_FILE_MAX_BYTES {
        return Err(CliError::Usage(format!(
            "deployments manifest too large (max {DEPLOYMENT_FILE_MAX_BYTES} bytes)"
        )));
    }
    let manifest: DeploymentManifest = serde_json::from_str(raw)
        .map_err(|e| CliError::Usage(format!("invalid deployments JSON: {e}")))?;
    if manifest.chain_id == 0 {
        return Err(CliError::Usage("chainId must be non-zero".into()));
    }
    if manifest.roles.is_empty() || manifest.roles.len() > DEPLOYMENT_ROLE_CAP {
        return Err(CliError::Usage(format!(
            "roles must hold 1..={DEPLOYMENT_ROLE_CAP} entries (got {})",
            manifest.roles.len()
        )));
    }
    let mut seen = std::collections::HashSet::new();
    for (index, entry) in manifest.roles.iter().enumerate() {
        if !DEPLOYMENT_ROLES.contains(&entry.role.as_str()) {
            return Err(CliError::Usage(format!(
                "roles[{index}].role must be one of {} (got {:?})",
                DEPLOYMENT_ROLES.join("|"),
                entry.role
            )));
        }
        if !seen.insert(entry.role.as_str()) {
            return Err(CliError::Usage(format!(
                "roles[{index}] duplicates role {:?}",
                entry.role
            )));
        }
        validate_0x_address(&entry.address, &format!("roles[{index}].address"))?;
    }
    if let Some(project) = &manifest.project {
        validate_deployment_slug(project, "project")?;
    }
    if let Some(note) = &manifest.note {
        if note.chars().count() > DEPLOYMENT_NOTE_MAX_CHARS {
            return Err(CliError::Usage(format!(
                "note must be at most {DEPLOYMENT_NOTE_MAX_CHARS} chars"
            )));
        }
    }
    if let Some(tx) = &manifest.tx {
        receipt_tx_tag(tx)?;
    }
    Ok(manifest)
}

/// `project` slugs use the same shape as launch ids.
fn validate_deployment_slug(value: &str, what: &str) -> Result<(), CliError> {
    let ok = !value.is_empty() && value.len() <= 64 && {
        let bytes = value.as_bytes();
        (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
            && bytes[1..]
                .iter()
                .all(|&b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
    };
    if ok {
        Ok(())
    } else {
        Err(CliError::Usage(format!(
            "{what} must match [a-z0-9][a-z0-9_-]{{0,63}} (got {value:?})"
        )))
    }
}

/// Resolve `(tx, block)` for a manifest: explicit manifest fields win;
/// anything missing is read from forge's broadcast artifact.
///
/// Why the artifact exists at all: forge **cannot** expose the current run's
/// transaction hashes from inside `run()` — broadcast artifacts are written
/// only after the script finishes (verified against forge 1.4.3:
/// `vm.getBroadcast` reverts with "broadcast dir does not exist" mid-run).
/// The manifest's `broadcast` field (or `--broadcast`) points at
/// `broadcast/<script>.s.sol/<chainid>/run-latest.json`, which carries both
/// the tx hash and the receipt's block number.
pub(crate) fn resolve_deployment_tx(
    manifest: &DeploymentManifest,
    broadcast_raw: Option<&str>,
) -> Result<(String, u64), CliError> {
    let explicit_tx = manifest.tx.clone();
    let explicit_block = manifest.block;
    if let (Some(tx), Some(block)) = (&explicit_tx, explicit_block) {
        receipt_tx_tag(tx)?;
        if block == 0 {
            return Err(CliError::Usage("block must be non-zero".into()));
        }
        return Ok((tx.clone(), block));
    }

    let raw = broadcast_raw.ok_or_else(|| {
        CliError::Usage(
            "manifest carries no `tx`/`block`; point its `broadcast` field at forge's \
             run-latest.json (or pass --broadcast)"
                .into(),
        )
    })?;
    let (artifact_tx, artifact_block) = broadcast_tx_and_block(raw, manifest)?;

    let tx = match explicit_tx {
        Some(tx) => {
            receipt_tx_tag(&tx)?;
            tx
        }
        None => artifact_tx,
    };
    let block = match explicit_block {
        Some(0) => return Err(CliError::Usage("block must be non-zero".into())),
        Some(block) => block,
        None => artifact_block,
    };
    Ok((tx, block))
}

/// Pull the deploying tx hash and its block out of a forge broadcast artifact.
///
/// The artifact records the script's *top-level* broadcasts, so the match is
/// the `CREATE` transaction whose `contractAddress` is one of the manifest's
/// role addresses. For `DeployOrgDao` that single transaction also creates the
/// Summoner and its Moloch implementation (both are constructed inside
/// `OrgBinding`'s constructor), which is why one tx serves every role.
fn broadcast_tx_and_block(
    raw: &str,
    manifest: &DeploymentManifest,
) -> Result<(String, u64), CliError> {
    let artifact: serde_json::Value = serde_json::from_str(raw)
        .map_err(|e| CliError::Usage(format!("invalid broadcast artifact JSON: {e}")))?;
    let addresses: Vec<String> = manifest
        .roles
        .iter()
        .map(|entry| entry.address.to_lowercase())
        .collect();

    let tx_hash = artifact
        .get("transactions")
        .and_then(serde_json::Value::as_array)
        .and_then(|transactions| {
            transactions.iter().find(|tx| {
                let is_create = tx
                    .get("transactionType")
                    .and_then(serde_json::Value::as_str)
                    == Some("CREATE");
                let address = tx
                    .get("contractAddress")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_lowercase);
                is_create && address.is_some_and(|address| addresses.contains(&address))
            })
        })
        .and_then(|tx| tx.get("hash").and_then(serde_json::Value::as_str))
        .ok_or_else(|| {
            CliError::Usage(format!(
                "broadcast artifact has no CREATE tx for any manifest role address ({})",
                addresses.join(", ")
            ))
        })?;
    if !is_tx_hash(tx_hash) {
        return Err(CliError::Usage(
            "broadcast artifact tx hash is not a 32-byte hash".into(),
        ));
    }

    let block = artifact
        .get("receipts")
        .and_then(serde_json::Value::as_array)
        .and_then(|receipts| {
            receipts.iter().find(|receipt| {
                receipt
                    .get("transactionHash")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|hash| hash.eq_ignore_ascii_case(tx_hash))
            })
        })
        .and_then(|receipt| receipt.get("blockNumber"))
        .and_then(json_u64)
        .ok_or_else(|| {
            CliError::Usage(
                "broadcast artifact has no receipt with a block number for the deploy tx".into(),
            )
        })?;
    if block == 0 {
        return Err(CliError::Usage(
            "broadcast artifact block must be non-zero".into(),
        ));
    }
    Ok((tx_hash.to_string(), block))
}

/// Read a `u64` from JSON that may be a number, a decimal string, or a
/// `0x`-prefixed hex string (forge writes receipt `blockNumber` as hex).
fn json_u64(value: &serde_json::Value) -> Option<u64> {
    match value {
        serde_json::Value::Number(number) => number.as_u64(),
        serde_json::Value::String(raw) => match raw.strip_prefix("0x") {
            Some(hex) => u64::from_str_radix(hex, 16).ok(),
            None => raw.parse::<u64>().ok(),
        },
        _ => None,
    }
}

/// Build one kind:37018 record (`d`, tags, content) from a manifest — pure,
/// deterministic, and independent of the clock, so re-running the command
/// rebuilds byte-identical records and NIP-33 LWW replaces the coordinate
/// instead of duplicating it (idempotency).
pub(crate) fn deployment_record_parts(
    manifest: &DeploymentManifest,
    entry: &DeploymentRoleEntry,
    tx: &str,
    block: u64,
) -> Result<(String, Vec<Tag>, serde_json::Value), CliError> {
    if block == 0 {
        return Err(CliError::Usage("block must be non-zero".into()));
    }
    let d = format!("{}:{}", manifest.chain_id, entry.role);
    let tags = vec![
        Tag::parse(["chain", manifest.chain_id.to_string().as_str()])
            .map_err(|e| CliError::Other(format!("bad chain tag: {e}")))?,
        Tag::parse(["role", entry.role.as_str()])
            .map_err(|e| CliError::Other(format!("bad role tag: {e}")))?,
        Tag::parse(["address", entry.address.as_str()])
            .map_err(|e| CliError::Other(format!("bad address tag: {e}")))?,
        receipt_tx_tag(tx)?,
    ];
    let mut content = serde_json::json!({ "v": 1, "block": block });
    if let Some(project) = &manifest.project {
        content["project"] = serde_json::json!(project);
    }
    if let Some(note) = &manifest.note {
        content["note"] = serde_json::json!(note);
    }
    Ok((d, tags, content))
}

/// Read a manifest/artifact from disk with the size bound applied first.
fn read_deployment_file(path: &std::path::Path) -> Result<String, CliError> {
    let meta = std::fs::metadata(path)
        .map_err(|e| CliError::Usage(format!("cannot read {}: {e}", path.display())))?;
    if meta.len() > DEPLOYMENT_FILE_MAX_BYTES {
        return Err(CliError::Usage(format!(
            "{} too large (max {DEPLOYMENT_FILE_MAX_BYTES} bytes)",
            path.display()
        )));
    }
    std::fs::read_to_string(path)
        .map_err(|e| CliError::Usage(format!("cannot read {}: {e}", path.display())))
}

/// `buzz launchpad deployment record --file <manifest> [--broadcast <artifact>]`.
async fn cmd_deployment_record(
    client: &BuzzClient,
    file: &str,
    broadcast: Option<&str>,
) -> Result<(), CliError> {
    let manifest_path = std::path::Path::new(file);
    let manifest = parse_deployment_manifest(&read_deployment_file(manifest_path)?)?;

    // Only reach for forge's artifact when the manifest cannot answer itself.
    let broadcast_raw = if manifest.tx.is_none() || manifest.block.is_none() {
        let path = match broadcast {
            Some(path) => std::path::PathBuf::from(path),
            None => {
                let base = manifest_path.parent().unwrap_or(std::path::Path::new("."));
                let relative = manifest.broadcast.as_deref().ok_or_else(|| {
                    CliError::Usage(
                        "manifest carries no `tx`/`block` and no `broadcast` field to \
                         resolve them from (pass --broadcast)"
                            .into(),
                    )
                })?;
                base.join(relative)
            }
        };
        Some(read_deployment_file(&path)?)
    } else {
        None
    };

    let (tx, block) = resolve_deployment_tx(&manifest, broadcast_raw.as_deref())?;

    let mut published = Vec::with_capacity(manifest.roles.len());
    for entry in &manifest.roles {
        let (d, tags, content) = deployment_record_parts(&manifest, entry, &tx, block)?;
        let builder = EventBuilder::new(
            Kind::Custom(KIND_DEPLOYMENT_RECORD as u16),
            content.to_string(),
        )
        .tags(tags);
        let event = client.sign_event(builder)?;
        let raw = client.submit_event(event).await?;
        parse_write_response(&raw, &format!("deployment record {d} was dominated; retry"))?;
        published.push(d);
    }
    println!(
        "{}",
        serde_json::json!({
            "event": "deployment-records",
            "chain_id": manifest.chain_id,
            "records": published,
            "status": "ok",
        })
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TX: &str = "0x1111111111111111111111111111111111111111111111111111111111111111";
    const EVIDENCE: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

    fn tag_pairs(tags: &[Tag]) -> Vec<Vec<String>> {
        tags.iter()
            .map(|t| t.as_slice().iter().map(|s| s.to_string()).collect())
            .collect()
    }

    /// The relay refuses a 47005 without exactly one well-formed `tx` tag
    /// (`validate_launch_mirror_envelope`), and the web parser drops such a
    /// receipt, so a producer that omits it reaches nobody.
    #[test]
    fn claim_receipt_carries_the_tx_tag_the_relay_requires() {
        let (tags, content) = claim_receipt_parts("milestone-1", EVIDENCE, TX).expect("parts");
        let pairs = tag_pairs(&tags);
        let tx_tags: Vec<_> = pairs.iter().filter(|p| p[0] == "tx").collect();
        assert_eq!(tx_tags.len(), 1, "exactly one tx tag, got {pairs:?}");
        assert_eq!(tx_tags[0], &vec!["tx".to_string(), TX.to_string()]);
        assert!(pairs.contains(&vec!["kind".into(), "claim".into()]));
        assert!(pairs.contains(&vec!["claim".into(), "milestone-1".into()]));
        assert!(pairs.contains(&vec!["evidence".into(), EVIDENCE.into()]));
        assert_eq!(content["table"], "claim");
    }

    #[test]
    fn verdict_receipt_states_the_word_and_carries_the_tx_tag() {
        let (tags, content) = verdict_receipt_parts("milestone-1", "reject", TX).expect("parts");
        assert_eq!(content["verdict"], "reject");
        assert!(tag_pairs(&tags).contains(&vec!["tx".into(), TX.into()]));
        let (_, approved) = verdict_receipt_parts("milestone-1", "approve", TX).expect("parts");
        assert_eq!(approved["verdict"], "approve");
    }

    #[test]
    fn a_malformed_tx_hash_is_refused_before_signing() {
        let bad = [
            String::new(),
            "0x".to_string(),
            "0x1234".to_string(),
            "1".repeat(64),
            format!("0x{}", "zz".repeat(32)),
        ];
        for value in &bad {
            let err = claim_receipt_parts("milestone-1", EVIDENCE, value).unwrap_err();
            assert!(
                matches!(err, CliError::Usage(_)),
                "{value:?} must fail as usage"
            );
            let err = verdict_receipt_parts("milestone-1", "approve", value).unwrap_err();
            assert!(
                matches!(err, CliError::Usage(_)),
                "{value:?} must fail as usage"
            );
        }
    }

    #[test]
    fn an_unknown_verdict_word_is_refused() {
        let err = verdict_receipt_parts("milestone-1", "maybe", TX).unwrap_err();
        assert!(matches!(err, CliError::Usage(_)));
    }

    // ---- Discovery plane: kind:37018 deployment records ----

    const DEPLOY_ADDRESS: &str = "0x1550141d1bcba032262413ead1c0ce24373382b6";

    /// A well-formed manifest, with `tx`/`block` included only when asked for.
    fn manifest_json(tx: Option<&str>, block: Option<u64>) -> String {
        let mut manifest = serde_json::json!({
            "chainId": 8453,
            "project": "nebula",
            "note": "forge script script/DeployOrgDao.s.sol",
            "broadcast": "../broadcast/DeployOrgDao.s.sol/8453/run-latest.json",
            "roles": [
                { "role": "summoner", "address": DEPLOY_ADDRESS },
                { "role": "factory", "address": "0xE7F1725E7734ce288F8367e1bb143e90BB3f0512" },
                { "role": "implementation", "address": "0x9f7250d94297279596c31979ae916d9707a9fc49" },
            ],
        });
        if let Some(tx) = tx {
            manifest["tx"] = serde_json::json!(tx);
        }
        if let Some(block) = block {
            manifest["block"] = serde_json::json!(block);
        }
        manifest.to_string()
    }

    /// A forge `run-latest.json` reduced to the fields the resolver reads.
    /// `contractAddress` is checksum-cased while the manifest is lowercase —
    /// the match must be case-insensitive.
    fn broadcast_artifact_json() -> String {
        serde_json::json!({
            "transactions": [
                { "transactionType": "CREATE", "contractName": "OrgAllowance",
                  "contractAddress": "0x5fbdb2315678afecb367f032d93f642f64180aa3",
                  "hash": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
                { "transactionType": "CREATE", "contractName": "OrgBinding",
                  "contractAddress": "0xE7F1725E7734ce288F8367e1bb143e90BB3f0512",
                  "hash": TX },
            ],
            "receipts": [
                { "transactionHash": TX, "blockNumber": "0xb45" },
            ],
        })
        .to_string()
    }

    #[test]
    fn deployment_records_carry_the_golden_tags_and_content() {
        let manifest = parse_deployment_manifest(&manifest_json(Some(TX), Some(1234)))
            .expect("valid manifest");
        let entry = &manifest.roles[0];
        let (d, tags, content) =
            deployment_record_parts(&manifest, entry, TX, 1234).expect("parts");
        assert_eq!(d, "8453:summoner", "`d` is <chainId>:<role>");
        assert_eq!(
            tag_pairs(&tags),
            vec![
                vec!["chain".to_string(), "8453".to_string()],
                vec!["role".to_string(), "summoner".to_string()],
                vec!["address".to_string(), DEPLOY_ADDRESS.to_string()],
                vec!["tx".to_string(), TX.to_string()],
            ],
            "the relay requires exactly chain/role/address/tx, in this order"
        );
        assert_eq!(
            content,
            serde_json::json!({
                "v": 1,
                "block": 1234,
                "project": "nebula",
                "note": "forge script script/DeployOrgDao.s.sol",
            })
        );

        // Every role gets its own coordinate and nothing else changes.
        let roles: Vec<String> = manifest
            .roles
            .iter()
            .map(|entry| {
                deployment_record_parts(&manifest, entry, TX, 1234)
                    .expect("parts")
                    .0
            })
            .collect();
        assert_eq!(
            roles,
            vec!["8453:summoner", "8453:factory", "8453:implementation"]
        );
    }

    #[test]
    fn rebuilding_the_same_manifest_rebuilds_identical_records() {
        // Idempotency: publishing twice rewrites the same (chainId, role)
        // NIP-33 coordinates with byte-identical tags and content, so a
        // re-run replaces the head instead of creating a parallel record.
        let first = parse_deployment_manifest(&manifest_json(Some(TX), Some(1234)))
            .expect("valid manifest");
        let second = parse_deployment_manifest(&manifest_json(Some(TX), Some(1234)))
            .expect("valid manifest");
        for (a, b) in first.roles.iter().zip(second.roles.iter()) {
            let left = deployment_record_parts(&first, a, TX, 1234).expect("parts");
            let right = deployment_record_parts(&second, b, TX, 1234).expect("parts");
            assert_eq!(left.0, right.0, "d coordinate must be stable");
            assert_eq!(
                tag_pairs(&left.1),
                tag_pairs(&right.1),
                "tags must be stable"
            );
            assert_eq!(left.2, right.2, "content must be stable");
        }
    }

    #[test]
    fn tx_and_block_resolve_from_the_forge_broadcast_artifact() {
        let manifest =
            parse_deployment_manifest(&manifest_json(None, None)).expect("valid manifest");
        let (tx, block) =
            resolve_deployment_tx(&manifest, Some(&broadcast_artifact_json())).expect("resolved");
        assert_eq!(tx, TX, "the CREATE tx whose contractAddress matches a role");
        assert_eq!(block, 0xb45, "receipt blockNumber is hex");
    }

    #[test]
    fn manifest_tx_and_block_skip_the_artifact() {
        let manifest =
            parse_deployment_manifest(&manifest_json(Some(TX), Some(7))).expect("valid manifest");
        let (tx, block) = resolve_deployment_tx(&manifest, None).expect("resolved");
        assert_eq!((tx.as_str(), block), (TX, 7));
    }

    #[test]
    fn unresolvable_tx_or_block_is_refused_with_a_pointer_to_the_artifact() {
        // No tx, no block, no artifact: the command must say how to fix it
        // rather than publish a record the relay would reject (no `tx` tag).
        let manifest =
            parse_deployment_manifest(&manifest_json(None, None)).expect("valid manifest");
        let err = resolve_deployment_tx(&manifest, None).expect_err("must refuse");
        assert!(matches!(err, CliError::Usage(_)), "got {err:?}");

        // A `CREATE` tx that matches none of the manifest's role addresses
        // cannot be attributed to this deployment.
        let artifact = serde_json::json!({
            "transactions": [
                { "transactionType": "CREATE", "contractName": "SomethingElse",
                  "contractAddress": "0x5fbdb2315678afecb367f032d93f642f64180aa3",
                  "hash": TX },
            ],
            "receipts": [{ "transactionHash": TX, "blockNumber": "0xb45" }],
        })
        .to_string();
        let err = resolve_deployment_tx(&manifest, Some(&artifact)).expect_err("must refuse");
        assert!(matches!(err, CliError::Usage(_)), "got {err:?}");
    }

    #[test]
    fn malformed_manifests_are_refused_before_signing() {
        let cases: Vec<(&str, String)> = vec![
            ("unknown role", manifest_json_replace_role("summoner-summoner")),
            (
                "duplicate role",
                r#"{"chainId":8453,"roles":[
                    {"role":"summoner","address":"0x1550141d1bcba032262413ead1c0ce24373382b6"},
                    {"role":"summoner","address":"0x1550141d1bcba032262413ead1c0ce24373382b6"}]}"#
                    .into(),
            ),
            (
                "no roles",
                r#"{"chainId":8453,"roles":[]}"#.into(),
            ),
            (
                "bad address",
                r#"{"chainId":8453,"roles":[{"role":"summoner","address":"0xnope"}]}"#.into(),
            ),
            ("chainId zero", r#"{"chainId":0,"roles":[{"role":"summoner","address":"0x1550141d1bcba032262413ead1c0ce24373382b6"}]}"#.into()),
            ("bad tx", manifest_json(Some("0xdead"), Some(1))),
            (
                "bad project slug",
                manifest_json_with_project("Nebula!"),
            ),
            (
                "oversized note",
                serde_json::json!({
                    "chainId": 8453,
                    "note": "x".repeat(257),
                    "roles": [{ "role": "summoner", "address": DEPLOY_ADDRESS }],
                })
                .to_string(),
            ),
            ("not JSON", "{".into()),
        ];
        for (label, raw) in cases {
            let err = parse_deployment_manifest(&raw).expect_err(label);
            assert!(
                matches!(err, CliError::Usage(_)),
                "{label} must fail as usage, got {err:?}"
            );
        }
    }

    #[test]
    fn a_zero_block_is_refused_even_when_everything_else_is_valid() {
        let manifest =
            parse_deployment_manifest(&manifest_json(Some(TX), Some(1))).expect("valid manifest");
        let err = deployment_record_parts(&manifest, &manifest.roles[0], TX, 0)
            .expect_err("block 0 must refuse");
        assert!(matches!(err, CliError::Usage(_)));

        let manifest =
            parse_deployment_manifest(&manifest_json(Some(TX), Some(0))).expect("parsed");
        let err = resolve_deployment_tx(&manifest, None).expect_err("block 0 must refuse");
        assert!(matches!(err, CliError::Usage(_)));
    }

    /// Swap in a bad `role` while keeping the rest of the manifest valid.
    fn manifest_json_replace_role(role: &str) -> String {
        serde_json::json!({
            "chainId": 8453,
            "roles": [{ "role": role, "address": DEPLOY_ADDRESS }],
        })
        .to_string()
    }

    /// Same as [`manifest_json`] with a different `project` slug.
    fn manifest_json_with_project(project: &str) -> String {
        serde_json::json!({
            "chainId": 8453,
            "project": project,
            "roles": [{ "role": "summoner", "address": DEPLOY_ADDRESS }],
        })
        .to_string()
    }
}
