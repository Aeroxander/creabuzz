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
use super::word::{parse_fixed, Word};

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

/// Contracts a decoded log of project `key` in `block` reveals, by the role of
/// the contract that emitted it: from the Launcher, a project's four contracts
/// at its launch and a Pair when one is made; from a project's Treasury, its task
/// book (`TasksReady`, emitted once in the launch transaction) and its holder
/// pause (`PauseReady`, the same way, only when the deployment's switch is
/// on); from the Launcher, also the deployment's earlier backers' claim
/// contract (`EarlierBound`), tied to the one project that event names. The
/// dollar (`Platform.quote`) is shared by every project and not followed.
fn discovered(role: Role, key: Word, block: u64, event: &str, decoded: &Value) -> Vec<Contract> {
    let addr = |v: Option<&Value>| v.and_then(Value::as_str).and_then(parse_fixed::<20>);
    let mut out = Vec::new();
    match (role, event) {
        (Role::Treasury, "TasksReady") => {
            // The book's own first event comes in a later transaction, so
            // following it from this block loses nothing.
            if let Some(address) = addr(decoded.get("book")) {
                out.push(Contract {
                    address,
                    role: Role::Tasks,
                    project_key: Some(key),
                    from_block: block,
                });
            }
        }
        (Role::Treasury, "PauseReady") => {
            // The pause clone is initialised before it is bound, so it has no
            // log before this one.
            if let Some(address) = addr(decoded.get("gate")) {
                out.push(Contract {
                    address,
                    role: Role::Pause,
                    project_key: Some(key),
                    from_block: block,
                });
            }
        }
        (Role::Launcher, "EarlierBound") => {
            // The claim contract's own project is named in the event's data
            // (the key is not a topic), not by the caller.
            let named = decoded
                .get("key")
                .and_then(Value::as_str)
                .and_then(parse_fixed::<32>);
            if let (Some(address), Some(named)) = (addr(decoded.get("earlier")), named) {
                out.push(Contract {
                    address,
                    role: Role::Earlier,
                    project_key: Some(named),
                    from_block: block,
                });
            }
        }
        (Role::Launcher, "ProjectLaunched") => {
            for (name, role) in [
                ("shares", Role::Shares),
                ("team", Role::Team),
                ("treasury", Role::Treasury),
                ("vester", Role::Vester),
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
        (Role::Launcher, "PairMade") => {
            if let Some(address) = addr(decoded.get("pair")) {
                out.push(Contract {
                    address,
                    role: Role::Pair,
                    project_key: Some(key),
                    from_block: block,
                });
            }
        }
        (Role::Launcher, "CouncilMade") => {
            // A Council is made by the runner handing its seat over, or by a carried-out vote: either way it can have
            // no log before this one.
            if let Some(address) = addr(decoded.get("council")) {
                out.push(Contract {
                    address,
                    role: Role::Council,
                    project_key: Some(key),
                    from_block: block,
                });
            }
        }
        _ => {}
    }
    out
}

/// The key `EarlierBound` names: its second data word (`earlier` is the first;
/// the key is not a topic).
fn earlier_bound_key(log: &RawLog) -> Option<Word> {
    log.data
        .get(32..64)
        .and_then(|bytes| <Word>::try_from(bytes).ok())
}

/// The project a log belongs to: the follower's project, or for the Launcher
/// the `key` topic of the events that carry one (`ProjectLaunched`, `PairMade`,
/// `WoundDown` and `EarlierPoolFunded`), or the key `EarlierBound` carries in
/// its data; the settings and admin events belong to no project.
fn project_of(role: Role, contract_key: Option<Word>, event: &str, log: &RawLog) -> Option<Word> {
    if role != Role::Launcher {
        return contract_key;
    }
    match event {
        "ProjectLaunched" | "PairMade" | "CouncilMade" | "WoundDown" | "EarlierPoolFunded" => {
            topic_key(log, 1)
        }
        "EarlierBound" => earlier_bound_key(log),
        _ => None,
    }
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
    // as the Team Shares minted to the Vester at launch, come before the
    // Launcher's event).
    let mut new_contracts: Vec<Contract> = Vec::new();
    // Width of the pieces logs from before this range are read in: this
    // range's own width, which shrinks when the node refuses too many logs.
    let width = to - from + 1;
    let mut raw: Vec<RawLog> = Vec::new();
    // Contracts the stored Launcher rows name but the reader does not follow
    // yet (it ran before they were followed: review I2). They are followed
    // from now on, and their logs from where they were named up to this range
    // are read too.
    let mut late: Vec<Contract> = Vec::new();
    for (role, key, block, event, decoded) in store::reveals(pool, &s.reader, from).await? {
        for c in discovered(role, key, block, &event, &decoded) {
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
            let logs = source.logs(&addrs, &topics, at, end).await?;
            raw.extend(
                logs.into_iter()
                    .filter(|l| (at..=end).contains(&l.block_number)),
            );
            at = end + 1;
        }
        tracing::warn!(reader = %s.reader, contracts = late.len(), from = start, "chain reader: following contracts named by stored rows; their earlier logs were read");
        for c in late {
            known.insert(c.address, c.clone());
            new_contracts.push(c);
        }
    }
    let mut asked: Vec<[u8; 20]> = known.values().map(|c| c.address).collect();
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
        // A node that ignores the end of the range sends logs of later blocks
        // too; they are read again in their own range, never stored twice.
        for log in logs
            .into_iter()
            .filter(|l| (query_from..=to).contains(&l.block_number))
        {
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
                // The Launcher's events name a project by their key topic; a
                // Treasury's own `TasksReady` by the project it belongs to.
                let revealing = match c.role {
                    Role::Launcher => topic_key(&log, 1)
                        .or_else(|| earlier_bound_key(&log))
                        .map(|key| (Role::Launcher, key)),
                    Role::Treasury => c.project_key.map(|key| (Role::Treasury, key)),
                    _ => None,
                };
                if let Some((role, key)) = revealing {
                    if let Some(def) = log.topics.first().and_then(|t| events::lookup(role, t)) {
                        let decoded = events::decode(def, &log.topics, &log.data);
                        if let Ok(decoded) = decoded {
                            for c in discovered(role, key, log.block_number, def.name, &decoded) {
                                if !known.contains_key(&c.address)
                                    && !found.iter().any(|f| f.address == c.address)
                                {
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
        let project_key = project_of(contract.role, contract.project_key, &event, &log);
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
