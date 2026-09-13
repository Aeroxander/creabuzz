//! `buzz launchpad` commands — NIP-LP kind:37001/47002–47005 read/write path.
//!
//! The chain is the ledger; Nostr is the record. Reads assemble the directory
//! and per-launch views from relay events; writes publish signed records and
//! mirrors. Mirror commands never move money — settlement is onchain.

use buzz_core::kind::{
    KIND_DELETION, KIND_LAUNCH_BID, KIND_LAUNCH_PROPOSAL, KIND_LAUNCH_RECEIPT, KIND_LAUNCH_RECORD,
    KIND_LAUNCH_UPDATE,
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
    }
}


/// Compose an unsigned bid: Permit2 approve (ERC-20 currency) then submitBid.
/// Prints a JSON envelope a wallet or `cast send` can sign — the CLI never
/// signs or moves money ("machines compose, humans sign").
fn cmd_compose_bid(
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
        encode_permit2_approve, encode_submit_bid, snap_max_price_to_tick, validate_bid,
        PERMIT2_ADDRESS, TxCall,
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
    let bid_data = encode_submit_bid(&snapped, &amount, owner, Some(&floor), "0x")
        .map_err(CliError::Other)?;

    let mut calls: Vec<TxCall> = Vec::new();
    if let Some(currency_addr) = currency {
        validate_0x_address(currency_addr, "currency")?;
        let exp = deadline.unwrap_or_else(|| {
            (std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0))
                + 3600
        });
        let approve = encode_permit2_approve(currency_addr, auction, &amount, exp)
            .map_err(CliError::Other)?;
        calls.push(TxCall {
            to: PERMIT2_ADDRESS.to_string(),
            data: approve,
        });
    }
    calls.push(TxCall {
        to: auction.to_string(),
        data: bid_data,
    });

    let envelope = serde_json::json!({
        "compose": "buzz launchpad compose-bid",
        "chainId": chain_id,
        "note": "unsigned — sign with a wallet or `cast send`",
        "maxPriceQ96": format!("{snapped}"),
        "amount": format!("{amount}"),
        "calls": calls.into_iter().map(|c| serde_json::json!({
            "to": c.to,
            "value": "0x0",
            "data": c.data,
        })).collect::<Vec<_>>(),
    });
    let json = serde_json::to_string_pretty(&envelope)
        .map_err(|e| CliError::Other(format!("failed to serialize: {e}")))?;
    println!("{json}");
    Ok(())
}
