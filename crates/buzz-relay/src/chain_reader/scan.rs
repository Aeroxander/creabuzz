//! One pass of the reader over the chain: notice a rollback and undo it, then
//! read the next block ranges into the tables.

use std::collections::{BTreeSet, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{anyhow, bail};
use serde_json::Value;
use sqlx::PgPool;

use super::events::{self, Role};
use super::source::{is_too_many_logs, ChainSource, Header, RawLog};
use super::store::{self, Contract, RangeWrite, StoredLog};
use super::word::{parse_fixed, word_to_address, Word};

/// How the reader scans.
#[derive(Clone, Debug)]
pub struct ScanSettings {
    /// `<chain id>:<launcher>`, the rows' owner.
    pub reader: String,
    /// The Launcher.
    pub launcher: [u8; 20],
    /// The first block to read.
    pub start_block: u64,
    /// Blocks per `eth_getLogs` range at most.
    pub range: u64,
    /// The newest blocks not read (the confirmation depth, at least
    /// [`super::MIN_LAG`]): only blocks the numbers count are read, so a node
    /// whose log index trails its headers cannot make the reader pass a block
    /// before its logs are there.
    pub lag: u64,
    /// Ranges read per pass at most (so one pass is bounded).
    pub max_ranges: u32,
    /// Blocks without logs are kept this far below the newest scanned block,
    /// to find a fork point close to the tip.
    pub keep_blocks: u64,
    /// Stored blocks compared with the chain at most when looking for a fork
    /// point. Past that, everything after the start block is read again.
    pub max_fork_walk: i64,
}

/// What one pass did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ScanReport {
    /// The chain's newest block.
    pub head: u64,
    /// The last block read in this pass, if any.
    pub scanned_to: Option<u64>,
    /// Logs stored in this pass.
    pub logs: usize,
    /// The fork point when a rollback was undone.
    pub rolled_back_to: Option<u64>,
    /// Logs deleted by the rollback.
    pub logs_removed: u64,
    /// The node is behind the stored blocks (its head is lower than the
    /// newest stored block, or it does not have that block yet): nothing was
    /// read, undone or signed this pass (review F7).
    pub behind: bool,
}

/// Find the newest stored block that is still on the chain, walking stored
/// blocks newest first. `None` when none of the first `stored.len()` is.
pub async fn find_fork(source: &dyn ChainSource, stored: &[Header]) -> anyhow::Result<Option<u64>> {
    for h in stored {
        if let Some(chain) = source.header(h.number).await? {
            if chain.hash == h.hash {
                return Ok(Some(h.number));
            }
        }
    }
    Ok(None)
}

async fn check_rollback(
    pool: &PgPool,
    source: &dyn ChainSource,
    s: &ScanSettings,
    next: u64,
    report: &mut ScanReport,
) -> anyhow::Result<u64> {
    let stored = store::blocks_desc(pool, &s.reader, s.max_fork_walk).await?;
    let Some(tip) = stored.first() else {
        return Ok(next);
    };
    // A node behind the stored blocks (a lagging replica behind a load
    // balancer, a restarted node) is not a rollback: wait for it (review F7).
    if report.head < tip.number {
        report.behind = true;
        return Ok(next);
    }
    let Some(chain_tip) = source.header(tip.number).await? else {
        report.behind = true;
        return Ok(next);
    };
    if chain_tip.hash == tip.hash {
        return Ok(next);
    }
    let fork = match find_fork(source, &stored).await? {
        Some(fork) => fork,
        // Deeper than the walk: read everything again from the start.
        None => s.start_block.saturating_sub(1),
    };
    let removed = store::rollback(pool, &s.reader, next, fork).await?;
    tracing::warn!(reader = %s.reader, fork, removed, "chain reader: chain rolled back; rows past the fork deleted");
    report.rolled_back_to = Some(fork);
    report.logs_removed = removed;
    Ok(fork + 1)
}

fn topic_key(log: &RawLog, index: usize) -> Option<Word> {
    log.topics.get(index).copied()
}

/// Contracts a decoded Launcher log of project `key` in `block` reveals.
fn discovered(key: Word, block: u64, event: &str, decoded: &Value) -> Vec<Contract> {
    let addr = |v: Option<&Value>| v.and_then(Value::as_str).and_then(parse_fixed::<20>);
    let mut out = Vec::new();
    match event {
        "ProjectLaunched" => {
            for (name, role) in [
                ("shares", Role::Shares),
                ("treasury", Role::Treasury),
                ("vester", Role::Vester),
                ("finisher", Role::Finisher),
                ("rounds", Role::Rounds),
            ] {
                if let Some(address) = addr(decoded.get("project").and_then(|p| p.get(name))) {
                    out.push(Contract {
                        address,
                        role,
                        project_key: Some(key),
                        from_block: block,
                    });
                }
            }
        }
        // A sale's auction (the main sale and each reserve sale): its bids,
        // exits, claims and clearing price.
        "SaleOpened" | "ReserveSaleOpened" => {
            if let Some(address) = addr(decoded.get("auction")) {
                out.push(Contract {
                    address,
                    role: Role::Auction,
                    project_key: Some(key),
                    from_block: block,
                });
            }
        }
        // Project zero's claim contract for its earlier backers, named at
        // its launch. Only the claim in the split is followed:
        // `EarlierBackersNamed` may name another before the launch.
        "ProjectZeroSplit" => {
            if let Some(address) = addr(decoded.get("claim")) {
                out.push(Contract {
                    address,
                    role: Role::Earlier,
                    project_key: Some(key),
                    from_block: block,
                });
            }
        }
        "PairMade" => {
            if let Some(address) = addr(decoded.get("pair")) {
                out.push(Contract {
                    address,
                    role: Role::Pair,
                    project_key: Some(key),
                    from_block: block,
                });
            }
        }
        _ => {}
    }
    out
}

/// The project a log belongs to: the follower's project, or for the Launcher
/// the `key` topic of the events that carry one.
fn project_of(role: Role, contract_key: Option<Word>, event: &str, log: &RawLog) -> Option<Word> {
    if role != Role::Launcher {
        return contract_key;
    }
    match event {
        "CouncilRegistered" | "SettingsChanged" | "AdminChanged" | "unknown" => None,
        // key zero: the project zero name was taken back; it belongs to no project.
        "ProjectZeroNamed" => topic_key(log, 1).filter(|k| *k != [0u8; 32]),
        _ => topic_key(log, 1),
    }
}

/// The Launcher's fixed contracts, read once with `eth_call` at block `to` and
/// stored like the others: its `LiquidityHolder` (`holder()`), which keeps
/// every project's pool position and collects its fees, and the pool manager
/// (`strategy().poolManager()`), which holds the pools' Shares and is never a
/// holder. Nothing when they are known already, or when the source makes no
/// calls; a failed call fails the range, so it is read again.
async fn launcher_fixed(
    source: &dyn ChainSource,
    known: &HashMap<[u8; 20], Contract>,
    from: u64,
    to: u64,
) -> anyhow::Result<Vec<Contract>> {
    let Some(launcher) = known.values().find(|c| c.role == Role::Launcher) else {
        return Ok(Vec::new());
    };
    let have = |role: Role| known.values().any(|c| c.role == role);
    let mut out = Vec::new();
    let address_at = |answer: Option<Vec<u8>>| -> Option<[u8; 20]> {
        let bytes = answer?;
        let word: Word = bytes.get(..32)?.try_into().ok()?;
        Some(word_to_address(&word)).filter(|a| *a != [0u8; 20])
    };
    let selector = |sig: &str| buzz_evm_allowance::abi::selector(sig).to_vec();
    if !have(Role::Holder) {
        if let Some(holder) = address_at(
            source
                .eth_call(&launcher.address, &selector("holder()"), to)
                .await?,
        ) {
            out.push(Contract {
                address: holder,
                role: Role::Holder,
                project_key: None,
                from_block: from,
            });
        }
    }
    if !have(Role::PoolManager) {
        if let Some(strategy) = address_at(
            source
                .eth_call(&launcher.address, &selector("strategy()"), to)
                .await?,
        ) {
            if let Some(manager) = address_at(
                source
                    .eth_call(&strategy, &selector("poolManager()"), to)
                    .await?,
            ) {
                out.push(Contract {
                    address: manager,
                    role: Role::PoolManager,
                    project_key: None,
                    from_block: from,
                });
            }
        }
    }
    Ok(out)
}

/// Read blocks `from..=to` and store them (one range).
async fn scan_range(
    pool: &PgPool,
    source: &dyn ChainSource,
    s: &ScanSettings,
    from: u64,
    to: u64,
) -> anyhow::Result<usize> {
    let mut known: HashMap<[u8; 20], Contract> = store::contracts(pool, &s.reader)
        .await?
        .into_iter()
        .map(|c| (c.address, c))
        .collect();
    let topics = events::all_topics();
    let tip_before = source
        .header(to)
        .await?
        .ok_or_else(|| anyhow!("block {to} is not on the chain"))?;
    if from > s.start_block {
        if let Some(prev) = store::block(pool, &s.reader, from - 1).await? {
            let first = source
                .header(from)
                .await?
                .ok_or_else(|| anyhow!("block {from} is not on the chain"))?;
            if first.parent != prev.hash {
                bail!(
                    "block {from} does not follow the stored block {}; the chain moved",
                    from - 1
                );
            }
        }
    }

    // Read the known contracts, then whatever the Launcher's events reveal,
    // from the block they were revealed in (their own logs in that block, such
    // as the founder's grant and the Shares minted at launch, come before the
    // Launcher's event).
    let mut new_contracts: Vec<Contract> = Vec::new();
    for c in launcher_fixed(source, &known, from, to).await? {
        known.insert(c.address, c.clone());
        new_contracts.push(c);
    }
    // Width of the pieces logs from before this range are read in: this
    // range's own width, which shrinks when the node refuses too many logs.
    let width = to - from + 1;
    let mut raw: Vec<RawLog> = Vec::new();
    // Contracts the stored Launcher rows name but the reader does not follow
    // yet (it ran before they were followed: review I2). They are followed
    // from now on, and their logs from where they were named up to this range
    // are read too.
    let mut late: Vec<Contract> = Vec::new();
    for (key, block, event, decoded) in store::launcher_reveals(pool, &s.reader, from).await? {
        for c in discovered(key, block, &event, &decoded) {
            if !known.contains_key(&c.address) && !late.iter().any(|l| l.address == c.address) {
                late.push(c);
            }
        }
    }
    if let Some(start) = late.iter().map(|c| c.from_block).min() {
        let addrs: Vec<[u8; 20]> = late.iter().map(|c| c.address).collect();
        // `start < from`; each piece moves `at` forward by at least one block.
        let mut at = start;
        while at < from {
            let end = at.saturating_add(width - 1).min(from - 1);
            raw.extend(source.logs(&addrs, &topics, at, end).await?);
            at = end + 1;
        }
        tracing::warn!(reader = %s.reader, contracts = late.len(), from = start, "chain reader: following contracts named by stored rows; their earlier logs were read");
        for c in late {
            known.insert(c.address, c.clone());
            new_contracts.push(c);
        }
    }
    // The pool manager is shared by every pool on the chain: only its `Swap`
    // logs for the projects' own pools are read, below.
    let mut asked: Vec<[u8; 20]> = known
        .values()
        .filter(|c| c.role != Role::PoolManager)
        .map(|c| c.address)
        .collect();
    let mut seen: BTreeSet<(u64, u32)> = BTreeSet::new();
    for log in &raw {
        if log.removed {
            bail!(
                "the node returned a removed log in block {}; the chain moved",
                log.block_number
            );
        }
        seen.insert((log.block_number, log.log_index));
    }
    let mut query_from = from;
    // Each round only asks for contracts found in the round before, and each
    // contract is found once, so this ends; the cap bounds a bad node.
    for _ in 0..1_000 {
        if asked.is_empty() {
            break;
        }
        let logs = source.logs(&asked, &topics, query_from, to).await?;
        let mut found: Vec<Contract> = Vec::new();
        for log in logs {
            if log.removed {
                bail!(
                    "the node returned a removed log in block {}; the chain moved",
                    log.block_number
                );
            }
            if !seen.insert((log.block_number, log.log_index)) {
                continue;
            }
            if let Some(c) = known.get(&log.address) {
                if c.role == Role::Launcher {
                    if let Some(def) = log
                        .topics
                        .first()
                        .and_then(|t| events::lookup(Role::Launcher, t))
                    {
                        let decoded = events::decode(def, &log.topics, &log.data);
                        if let (Ok(decoded), Some(key)) = (decoded, topic_key(&log, 1)) {
                            for c in discovered(key, log.block_number, def.name, &decoded) {
                                if !known.contains_key(&c.address) {
                                    found.push(c);
                                }
                            }
                        }
                    }
                }
            }
            raw.push(log);
        }
        query_from = found.iter().map(|c| c.from_block).min().unwrap_or(to);
        asked = found.iter().map(|c| c.address).collect();
        for c in found {
            known.insert(c.address, c.clone());
            new_contracts.push(c);
        }
    }

    // The projects' pool trades: `Swap` logs of the pools the Finishers
    // opened (stored, or opened in this range).
    let mut pools: HashMap<Word, Word> = store::pool_ids(pool, &s.reader).await?;
    // Pools first named in this range, with their project and auction.
    let mut named_here: Vec<(Word, Word, String)> = Vec::new();
    // In this range, per (project, auction): the first pool step's block and
    // the sale's last block.
    let mut marks: HashMap<(Word, String), (Option<u64>, Option<u64>)> = HashMap::new();
    for log in &raw {
        let Some(c) = known.get(&log.address) else {
            continue;
        };
        if c.role != Role::Finisher {
            continue;
        }
        let def = log
            .topics
            .first()
            .and_then(|t| events::lookup(Role::Finisher, t));
        let (Some(def), Some(key)) = (def, c.project_key) else {
            continue;
        };
        if !matches!(def.name, "PoolOpened" | "PoolStep" | "SaleOpenedBy") {
            continue;
        }
        let Ok(decoded) = events::decode(def, &log.topics, &log.data) else {
            continue;
        };
        let Some(auction) = decoded.get("auction").and_then(Value::as_str) else {
            continue;
        };
        let auction = auction.to_owned();
        match def.name {
            "PoolOpened" => {
                if let Some(id) = decoded
                    .get("poolId")
                    .and_then(Value::as_str)
                    .and_then(parse_fixed::<32>)
                {
                    if pools.insert(id, key).is_none() {
                        named_here.push((id, key, auction));
                    }
                }
            }
            "PoolStep" => {
                let m = marks.entry((key, auction)).or_default();
                m.0 = Some(m.0.map_or(log.block_number, |b| b.min(log.block_number)));
            }
            _ => {
                if let Some(end) = decoded
                    .get("endBlock")
                    .and_then(Value::as_str)
                    .and_then(|e| e.parse::<u64>().ok())
                {
                    let m = marks.entry((key, auction)).or_default();
                    m.1 = Some(m.1.map_or(end, |b| b.max(end)));
                }
            }
        }
    }
    let manager = known
        .values()
        .find(|c| c.role == Role::PoolManager)
        .map(|c| c.address);
    if let (Some(manager), false) = (manager, pools.is_empty()) {
        let swap = events::topic_of(Role::PoolManager, "Swap")
            .ok_or_else(|| anyhow!("the event list has no pool Swap"))?;
        let ids: Vec<Word> = pools.keys().copied().collect();
        let mut swaps = source
            .logs_with_topic1(&manager, &swap, &ids, from, to)
            .await?;
        // A pool exists from its pool step (`Finisher.openPool`), but is named
        // only by `settle()`, in a later transaction: trades in between that
        // landed in ranges already committed are read back now (review I1).
        for (id, key, auction) in &named_here {
            let here = marks
                .get(&(*key, auction.clone()))
                .copied()
                .unwrap_or_default();
            let start = match here.0 {
                Some(step) => Some(step),
                None => match store::pool_start(pool, &s.reader, key, auction).await? {
                    Some(b) => Some(b),
                    None => here.1,
                },
            };
            let Some(start) = start.filter(|b| *b < from) else {
                continue;
            };
            let mut at = start;
            while at < from {
                let end = at.saturating_add(width - 1).min(from - 1);
                swaps.extend(
                    source
                        .logs_with_topic1(&manager, &swap, &[*id], at, end)
                        .await?,
                );
                at = end + 1;
            }
        }
        for log in swaps {
            if log.removed {
                bail!(
                    "the node returned a removed log in block {}; the chain moved",
                    log.block_number
                );
            }
            if seen.insert((log.block_number, log.log_index)) {
                raw.push(log);
            }
        }
    }
    raw.sort_by_key(|l| (l.block_number, l.log_index));

    // Headers of the log blocks, each checked against the hash the log names.
    let mut headers: HashMap<u64, Header> = HashMap::new();
    for log in &raw {
        if let std::collections::hash_map::Entry::Vacant(slot) = headers.entry(log.block_number) {
            let h = source
                .header(log.block_number)
                .await?
                .ok_or_else(|| anyhow!("block {} is not on the chain", log.block_number))?;
            slot.insert(h);
        }
        if headers.get(&log.block_number).map(|h| h.hash) != Some(log.block_hash) {
            bail!(
                "a log of block {} names another block; the chain moved",
                log.block_number
            );
        }
    }
    let tip_after = source.header(to).await?;
    if tip_after.as_ref() != Some(&tip_before) {
        bail!("block {to} changed while it was read; the chain moved");
    }
    headers.insert(to, tip_before);

    let mut stored = Vec::with_capacity(raw.len());
    for log in raw {
        let Some(contract) = known.get(&log.address) else {
            continue;
        };
        let def = log
            .topics
            .first()
            .and_then(|t| events::lookup(contract.role, t));
        let Some(def) = def else { continue };
        // A known event that does not decode means the catalog and the
        // deployed contracts disagree. Storing it as unknown would leave it out
        // of the signed numbers for good (the rows are final), so the range
        // fails and is read again until the catalog is fixed (review I3).
        let decoded = events::decode(def, &log.topics, &log.data).map_err(|e| {
            anyhow!(
                "{:?}.{} in block {} (log {}) does not decode ({e:?}); the event list does not \
                 match the deployed contracts",
                contract.role,
                def.name,
                log.block_number,
                log.log_index
            )
        })?;
        let event = def.name.to_owned();
        let project_key = match contract.role {
            // The Launcher's one LiquidityHolder serves every project: a log
            // belongs to the project whose Treasury it names.
            Role::Holder => log.topics.get(2).and_then(|w| {
                known
                    .get(&word_to_address(w))
                    .filter(|t| t.role == Role::Treasury)
                    .and_then(|t| t.project_key)
            }),
            Role::PoolManager => log.topics.get(1).and_then(|id| pools.get(id).copied()),
            role => project_of(role, contract.project_key, &event, &log),
        };
        stored.push(StoredLog {
            project_key,
            block_number: log.block_number,
            log_index: log.log_index,
            block_hash: log.block_hash,
            tx_hash: log.tx_hash,
            address: log.address,
            role: contract.role,
            event,
            topics: log.topics,
            data: log.data,
            decoded,
        });
    }
    let mut blocks: Vec<Header> = headers.into_values().collect();
    blocks.sort_by_key(|h| h.number);
    let count = stored.len();
    store::commit_range(
        pool,
        &s.reader,
        RangeWrite {
            expected_next: from,
            to,
            blocks: &blocks,
            contracts: &new_contracts,
            logs: &stored,
            keep_from: to.saturating_sub(s.keep_blocks),
        },
    )
    .await?;
    Ok(count)
}

/// One pass: undo a rollback if the chain moved under the stored rows, then
/// read up to `max_ranges` ranges toward the chain's head, less `lag`.
pub async fn scan(
    pool: &PgPool,
    source: &dyn ChainSource,
    s: &ScanSettings,
) -> anyhow::Result<ScanReport> {
    let span = AtomicU64::new(s.range.max(1));
    scan_with_span(pool, source, s, &span).await
}

/// [`scan`], starting from `span` blocks per range. A range the node (or the
/// reader's own limit) refuses as too many logs is halved and read again, down
/// to one block; ranges that pass double it back toward `s.range`. `span`
/// keeps the size reached for the next pass.
pub async fn scan_with_span(
    pool: &PgPool,
    source: &dyn ChainSource,
    s: &ScanSettings,
    span: &AtomicU64,
) -> anyhow::Result<ScanReport> {
    store::ensure_reader(pool, &s.reader, &s.launcher, s.start_block).await?;
    let mut report = ScanReport {
        head: source.head().await?,
        ..ScanReport::default()
    };
    let mut next = store::cursor(pool, &s.reader).await?;
    next = check_rollback(pool, source, s, next, &mut report).await?;
    if report.behind {
        tracing::warn!(reader = %s.reader, head = report.head, "chain reader: the node is behind the stored blocks; waiting for it");
        return Ok(report);
    }
    let Some(last) = report.head.checked_sub(s.lag) else {
        return Ok(report);
    };
    let full = s.range.max(1);
    let mut width = span.load(Ordering::Relaxed).clamp(1, full);
    let mut done = 0u32;
    // Each refusal halves a width of at most `full`, so at most 64 refusals in
    // a row; each success counts toward `max_ranges`. Bounded either way.
    let mut refusals = 0u32;
    while done < s.max_ranges && next <= last {
        let to = last.min(next.saturating_add(width - 1));
        match scan_range(pool, source, s, next, to).await {
            Ok(n) => {
                report.logs += n;
                report.scanned_to = Some(to);
                next = to + 1;
                done += 1;
                refusals = 0;
                width = width.saturating_mul(2).min(full);
            }
            Err(e) if is_too_many_logs(&e) => {
                if to == next {
                    span.store(1, Ordering::Relaxed);
                    return Err(e.context(format!(
                        "block {next} alone holds more logs than the node answers in one request; \
                         the reader cannot pass it until the node allows a bigger answer"
                    )));
                }
                refusals += 1;
                if refusals > 64 {
                    return Err(e.context("the node kept refusing smaller and smaller ranges"));
                }
                // Half of the `to - next + 1` blocks just refused (`to > next`).
                width = (to - next).div_ceil(2).max(1);
                tracing::warn!(reader = %s.reader, from = next, to, width, "chain reader: too many logs; reading a smaller range");
            }
            Err(e) => {
                span.store(width, Ordering::Relaxed);
                return Err(e);
            }
        }
    }
    span.store(width, Ordering::Relaxed);
    Ok(report)
}
