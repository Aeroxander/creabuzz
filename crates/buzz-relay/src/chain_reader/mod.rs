//! The chain reader (plan v2, milestone 5, part 1).
//!
//! It reads the contracts/next events (the Launcher, and each project's
//! Rounds, Vester, Treasury, Finisher, Pair and Shares found in the Launcher's
//! events) into tables that survive a chain rollback (`scan`, `store`), works
//! out the numbers the chain cannot give (`numbers`), and signs one "project
//! numbers" record per project, kind 39009 (`publish`), again whenever they
//! change. Off unless `BUZZ_CHAIN_RPC_URL` is set (`settings`).
//!
//! With `BUZZ_CHAIN_HELPER_KEY` set, the helper job (`helper`) also sends the
//! calls anyone may make (closing rounds, settling, releasing, finishing
//! sales) from a relay-held key. Signing records and sending calls are done by
//! one replica only: the one holding the writer lock, a session advisory lock
//! on a connection of its own, checked on every pass.

pub mod events;
pub mod helper;
pub mod numbers;
pub mod publish;
pub mod scan;
mod settings;
pub mod source;
pub mod store;
pub mod word;

use std::collections::HashSet;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use buzz_core::tenant::TenantContext;
use buzz_evm_allowance::HttpEvmRpc;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub use settings::ChainReaderConfig;

use crate::state::AppState;
use numbers::AsOf;
use scan::{ScanReport, ScanSettings};
use source::{ChainSource, RpcChainSource};
use word::{hex0x, Word};

/// The most records signed in one pass (the rest wait for the next pass).
pub const MAX_PUBLISH_PER_PASS: usize = 100;
/// Each RPC call is bounded by this.
const RPC_TIMEOUT: Duration = Duration::from_secs(20);
/// After this many failed passes in a row the reader waits the longest pause
/// between passes ([`MAX_BACKOFF`]) until one succeeds.
const MAX_BACKOFF: Duration = Duration::from_secs(600);
/// The newest blocks the reader never reads, whatever the confirmation depth:
/// a load-balanced node can answer the newest headers before its log index has
/// the newest blocks' logs, and a block read without its logs would be passed
/// for good (review F2). A confirmation depth below this acts as this.
pub const MIN_LAG: u64 = 2;

/// One reader: a chain, a Launcher, a community to publish into.
pub struct ChainReader {
    state: Arc<AppState>,
    source: Arc<dyn ChainSource>,
    config: ChainReaderConfig,
    scan: ScanSettings,
    /// Blocks per log request now: halved when a node refuses a range as too
    /// big, grown back after ranges that pass (review I2 / F1).
    span: AtomicU64,
    host: String,
    /// The helper, when its key is configured and a writer was given.
    helper: Option<helper::Helper>,
    /// The connection holding the writer lock, while this replica holds it.
    leader: tokio::sync::Mutex<Option<sqlx::PgConnection>>,
}

/// What one full pass did.
#[derive(Debug, Default)]
pub struct PassReport {
    /// The scan.
    pub scanned: ScanReport,
    /// Records signed (only by the writer).
    pub published: PublishReport,
    /// The helper's pass (only by the writer, when the helper is on).
    pub helper: Option<helper::HelperReport>,
    /// Why the helper's pass failed, when it did. The helper runs as its own
    /// step: its failure is logged and counted but never fails the reader's
    /// pass, which has scanned and signed already (review I3).
    pub helper_error: Option<String>,
    /// Whether this replica held the writer lock.
    pub writer: bool,
}

/// What one publishing pass did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct PublishReport {
    /// Records signed (new or changed numbers).
    pub signed: usize,
    /// Projects whose launch left the chain; a removal record was signed.
    pub removed: usize,
    /// Projects whose numbers could not be worked out or signed (tried again
    /// next pass).
    pub failed: usize,
}

fn digest(value: &Value) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(value.to_string().as_bytes());
    h.finalize().into()
}

impl ChainReader {
    /// A reader over `source` (a node, or a fake chain in tests).
    pub fn new(
        state: Arc<AppState>,
        source: Arc<dyn ChainSource>,
        config: ChainReaderConfig,
        host: String,
    ) -> Self {
        let scan = ScanSettings {
            reader: config.reader_id(),
            launcher: config.launcher,
            start_block: config.start_block,
            range: config.log_range,
            lag: config.confirmations.max(MIN_LAG),
            max_ranges: 20,
            keep_blocks: config.confirmations + 64,
            max_fork_walk: 2_048,
        };
        let span = AtomicU64::new(scan.range.max(1));
        Self {
            state,
            source,
            config,
            scan,
            span,
            host,
            helper: None,
            leader: tokio::sync::Mutex::new(None),
        }
    }

    /// Send the helper's calls through `writer` (only when the helper is
    /// configured).
    pub fn with_writer(mut self, writer: Arc<dyn helper::writer::ChainWriter>) -> Self {
        if let Some(cfg) = self.config.helper.clone() {
            self.helper = Some(helper::Helper::new(writer, cfg));
        }
        self
    }

    /// Whether this replica holds the writer lock: a session advisory lock
    /// taken on a connection detached from the pool (dropping it closes the
    /// session, which frees the lock). Checked on every pass; a connection
    /// that stopped answering took the lock with it, so it is taken again.
    pub async fn is_writer(&self) -> anyhow::Result<bool> {
        let mut held = self.leader.lock().await;
        if let Some(conn) = held.as_mut() {
            if sqlx::query("SELECT 1").execute(&mut *conn).await.is_ok() {
                return Ok(true);
            }
            *held = None;
            tracing::warn!(reader = %self.reader_id(), "chain reader: the writer lock's connection was lost");
        }
        let mut conn = self.state.db.pool().acquire().await?.detach();
        let got: bool = sqlx::query_scalar("SELECT pg_try_advisory_lock(hashtextextended($1, 0))")
            .bind(format!("chain_writer:{}", self.reader_id()))
            .fetch_one(&mut conn)
            .await?;
        if got {
            *held = Some(conn);
        }
        Ok(got)
    }

    /// The tables' name for this reader.
    pub fn reader_id(&self) -> &str {
        &self.scan.reader
    }

    /// One pass: scan, then sign what changed (the writer only).
    pub async fn pass(&self) -> anyhow::Result<(ScanReport, PublishReport)> {
        let report = self.pass_all().await?;
        Ok((report.scanned, report.published))
    }

    /// One pass: scan; then, on the replica holding the writer lock, sign what
    /// changed and run the helper.
    pub async fn pass_all(&self) -> anyhow::Result<PassReport> {
        let pool = self.state.db.pool();
        let scanned =
            scan::scan_with_span(pool, self.source.as_ref(), &self.scan, &self.span).await?;
        let mut report = PassReport {
            writer: self.is_writer().await?,
            ..PassReport::default()
        };
        // Nothing is signed or sent from a node behind the stored blocks.
        if report.writer && !scanned.behind {
            report.published = self.publish_pass(scanned.head).await?;
            if let Some(helper) = &self.helper {
                match self.helper_pass(helper, scanned.head).await {
                    Ok(h) => {
                        if h.node_errors == 0 {
                            record_good_helper_pass();
                        }
                        report.helper = Some(h);
                    }
                    Err(e) => {
                        metrics::counter!("buzz_chain_helper_pass_failed_total").increment(1);
                        tracing::error!(reader = %self.reader_id(), "chain helper pass failed: {e:#}");
                        report.helper_error = Some(format!("{e:#}"));
                    }
                }
            }
        }
        report.scanned = scanned;
        Ok(report)
    }

    async fn helper_pass(
        &self,
        helper: &helper::Helper,
        head: u64,
    ) -> anyhow::Result<helper::HelperReport> {
        let pool = self.state.db.pool();
        let reader = self.scan.reader.as_str();
        let head_header = self
            .source
            .header(head)
            .await?
            .with_context(|| format!("block {head} is not on the chain"))?;
        // Jobs are built only from final rows the reader has stored.
        let final_block = match head.checked_sub(self.scan.lag) {
            Some(f) if f >= self.config.start_block && store::cursor(pool, reader).await? > f => {
                let time = match store::block(pool, reader, f).await? {
                    Some(h) => h.time,
                    None => {
                        self.source
                            .header(f)
                            .await?
                            .with_context(|| format!("block {f} is not on the chain"))?
                            .time
                    }
                };
                Some((f, time))
            }
            _ => None,
        };
        helper
            .pass(pool, reader, (head, head_header.time), final_block, &[])
            .await
    }

    async fn tenant(&self) -> anyhow::Result<Option<TenantContext>> {
        let record = self
            .state
            .db
            .lookup_community_by_host(&self.host)
            .await
            .context("look up the community for the project numbers")?;
        Ok(record.map(|r| TenantContext::resolved(r.id, r.host)))
    }

    /// Sign the numbers of every project whose final events changed, or whose
    /// time-dependent numbers moved and are older than the refresh time.
    pub async fn publish_pass(&self, head: u64) -> anyhow::Result<PublishReport> {
        let pool = self.state.db.pool();
        let reader = self.scan.reader.as_str();
        let mut report = PublishReport::default();
        let Some(final_block) = head.checked_sub(self.scan.lag) else {
            return Ok(report);
        };
        if final_block < self.config.start_block
            || store::cursor(pool, reader).await? <= final_block
        {
            return Ok(report); // the final block is not read yet
        }
        let Some(tenant) = self.tenant().await? else {
            tracing::warn!(host = %self.host, "chain reader: no community for this host; numbers not signed");
            return Ok(report);
        };
        let as_of_header = match store::block(pool, reader, final_block).await? {
            Some(h) => h,
            None => self
                .source
                .header(final_block)
                .await?
                .with_context(|| format!("block {final_block} is not on the chain"))?,
        };
        let as_of = AsOf {
            chain_id: self.config.chain_id,
            launcher: self.config.launcher,
            block: final_block,
            time: as_of_header.time,
            runners: store::runners(pool, reader, final_block).await?,
        };
        let now = chrono::Utc::now().timestamp();
        let projects = store::final_projects(pool, reader, final_block).await?;
        let previous = store::published(pool, reader).await?;
        let refresh = i64::try_from(self.config.refresh_secs).unwrap_or(i64::MAX);

        // Changed projects first, then those due a refresh, longest unchecked
        // first, at most a pass's worth.
        let mut work: Vec<(Word, u64, Option<f64>)> = projects
            .iter()
            .filter_map(|(key, src)| match previous.get(key) {
                None => Some((*key, *src, None)),
                Some(p) if p.stale || p.source_block != *src => Some((*key, *src, None)),
                Some(p) if now - p.published_at >= refresh => {
                    Some((*key, *src, Some(p.checked_at)))
                }
                Some(_) => None,
            })
            .collect();
        work.sort_by(|a, b| match (a.2, b.2) {
            (None, None) => std::cmp::Ordering::Equal,
            (None, Some(_)) => std::cmp::Ordering::Less,
            (Some(_), None) => std::cmp::Ordering::Greater,
            (Some(x), Some(y)) => x.total_cmp(&y),
        });
        work.truncate(MAX_PUBLISH_PER_PASS);

        for (key, source_block, _) in work {
            match self
                .publish_project(&tenant, &key, source_block, &as_of, previous.get(&key), now)
                .await
            {
                Ok(true) => report.signed += 1,
                Ok(false) => {}
                Err(e) => {
                    report.failed += 1;
                    tracing::error!(project = %hex0x(&key), "chain reader: numbers not signed: {e:#}");
                }
            }
        }

        // A project whose launch left the chain (a rollback deeper than the
        // confirmations): sign a removal so its old numbers are not shown.
        let live: HashSet<Word> = projects.iter().map(|(k, _)| *k).collect();
        for (key, prev) in previous.iter().filter(|(k, _)| !live.contains(*k)) {
            let content = json!({
                "version": 1, "chainId": self.config.chain_id, "launcher": hex0x(&self.config.launcher),
                "key": hex0x(key), "removed": true,
                "asOf": {"block": as_of.block, "time": as_of.time},
            });
            let created_at = now.max(prev.published_at + 1);
            match self.sign(&tenant, key, &content, created_at).await {
                Ok(_) => {
                    store::forget_published(pool, reader, key).await?;
                    report.removed += 1;
                }
                Err(e) => {
                    report.failed += 1;
                    tracing::error!(project = %hex0x(key), "chain reader: removal not signed: {e:#}");
                }
            }
        }
        Ok(report)
    }

    /// Sign and store a record. A newer stored record (another writer's, a
    /// clock ahead) would hide it: then it is signed once more one second
    /// after the stored one, and if that is refused too the error leaves the
    /// project's row as it was, so the next pass tries again (review F6).
    /// Returns the event id and the `created_at` kept.
    async fn sign(
        &self,
        tenant: &TenantContext,
        key: &Word,
        content: &Value,
        created_at: i64,
    ) -> anyhow::Result<([u8; 32], i64)> {
        let key_hex = hex0x(key);
        let mut created = u64::try_from(created_at).context("time before 1970")?;
        for _ in 0..2 {
            let tags = publish::tags(
                &key_hex,
                self.config.chain_id,
                &hex0x(&self.config.launcher),
            )?;
            match publish::publish(&self.state, tenant, tags, &key_hex, content, created).await? {
                publish::Outcome::Stored(id) => {
                    return Ok((id, i64::try_from(created).context("time too large")?))
                }
                publish::Outcome::Superseded(at) => {
                    tracing::warn!(project = %key_hex, stored_at = at, "chain reader: a newer record is stored; signing after it");
                    created = at.saturating_add(1).max(created);
                }
            }
        }
        anyhow::bail!("a newer record for the project is stored; the numbers were not kept")
    }

    /// Work out and, when they changed, sign one project's numbers. Returns
    /// whether a record was signed.
    async fn publish_project(
        &self,
        tenant: &TenantContext,
        key: &Word,
        source_block: u64,
        as_of: &AsOf,
        prev: Option<&store::Published>,
        now: i64,
    ) -> anyhow::Result<bool> {
        let pool = self.state.db.pool();
        let reader = self.scan.reader.as_str();
        let logs = store::project_logs(pool, reader, key, as_of.block).await?;
        let balances = store::balances(pool, reader, key, as_of.block).await?;
        let Some(content) = numbers::derive(key, &logs, &balances, as_of)? else {
            return Ok(false);
        };
        let facts = digest(&numbers::facts_of(&content));
        let shown = digest(&numbers::without_as_of(&content));
        if let Some(p) = prev {
            let same_facts = p.facts_digest.as_slice() == facts.as_slice();
            let same_shown = p.content_digest.as_slice() == shown.as_slice();
            let refresh_due =
                now - p.published_at >= i64::try_from(self.config.refresh_secs).unwrap_or(i64::MAX);
            if same_facts && !p.stale && (same_shown || !refresh_due) {
                // Nothing a reader would see changed (or only the clock, and not
                // for long): keep the record, remember the block it covers, and
                // when nothing at all changed, that it was checked now.
                store::touch_source_block(pool, reader, key, source_block, same_shown).await?;
                return Ok(false);
            }
        }
        let created_at = prev.map_or(now, |p| now.max(p.published_at + 1));
        let (event_id, created_at) = self.sign(tenant, key, &content, created_at).await?;
        store::record_published(
            pool,
            reader,
            store::PublishedRow {
                key,
                source_block,
                facts_digest: &facts,
                content_digest: &shown,
                event_id: &event_id,
                published_at: created_at,
            },
        )
        .await?;
        Ok(true)
    }
}

/// Start the reader from the relay's configuration, if it is on. It checks the
/// node serves the configured chain before its first pass; a failed pass is
/// logged and retried with a growing pause (at most ten minutes), never ended.
pub fn spawn(state: Arc<AppState>) -> anyhow::Result<Option<tokio::task::JoinHandle<()>>> {
    let Some(config) = state.config.chain_reader.clone() else {
        return Ok(None);
    };
    let host = match &config.community_host {
        Some(h) => h.clone(),
        None => crate::tenant::relay_url_authority(&state.config.relay_url),
    };
    if host.is_empty() {
        anyhow::bail!(
            "the chain reader needs BUZZ_CHAIN_COMMUNITY_HOST or a host in BUZZ_RELAY_URL"
        );
    }
    let rpc = HttpEvmRpc::new(config.rpc_url.clone())
        .map_err(|e| anyhow::anyhow!("chain reader RPC: {e}"))?;
    let source: Arc<dyn ChainSource> = Arc::new(RpcChainSource::new(Arc::new(rpc), RPC_TIMEOUT));
    let poll = Duration::from_secs(config.poll_secs);
    let expected_chain = config.chain_id;
    let helper_key = config.helper.as_ref().map(|h| h.key.0.clone());
    let chain_id = config.chain_id;
    let mut reader = ChainReader::new(state, Arc::clone(&source), config, host);
    if let Some(wallet) = helper_key {
        let writer = helper::writer::RpcChainWriter::new(
            Arc::new(
                HttpEvmRpc::new(reader.config.rpc_url.clone())
                    .map_err(|e| anyhow::anyhow!("chain helper RPC: {e}"))?,
            ),
            wallet,
            chain_id,
            RPC_TIMEOUT,
        );
        tracing::info!(address = %hex0x(&helper::writer::ChainWriter::address(&writer)), "chain helper on");
        reader = reader.with_writer(Arc::new(writer));
    }
    let reader = Arc::new(reader);
    Ok(Some(tokio::spawn(supervise(
        move || {
            run(
                Arc::clone(&reader),
                Arc::clone(&source),
                expected_chain,
                poll,
            )
        },
        poll,
        MAX_BACKOFF,
    ))))
}

/// Unix seconds of the last pass that worked (0: none yet).
static LAST_GOOD_PASS: AtomicI64 = AtomicI64::new(0);

/// When the reader last finished a pass without an error (unix seconds), if
/// ever: a health number (also the `buzz_chain_reader_last_good_pass_seconds`
/// gauge). A number that stops moving while the relay serves means the
/// records shown are getting old.
pub fn last_good_pass() -> Option<i64> {
    Some(LAST_GOOD_PASS.load(Ordering::Relaxed)).filter(|t| *t > 0)
}

fn record_good_pass() {
    let now = chrono::Utc::now().timestamp();
    LAST_GOOD_PASS.store(now, Ordering::Relaxed);
    metrics::gauge!("buzz_chain_reader_last_good_pass_seconds").set(now as f64);
}

/// Unix seconds of the helper's last pass that worked with the node answering
/// every job it asked about (0: none yet).
static LAST_GOOD_HELPER_PASS: AtomicI64 = AtomicI64::new(0);

/// When the helper last finished a pass without an error (unix seconds), if
/// ever: its own health number, apart from the reader's (also the
/// `buzz_chain_helper_last_good_pass_seconds` gauge).
pub fn last_good_helper_pass() -> Option<i64> {
    Some(LAST_GOOD_HELPER_PASS.load(Ordering::Relaxed)).filter(|t| *t > 0)
}

fn record_good_helper_pass() {
    let now = chrono::Utc::now().timestamp();
    LAST_GOOD_HELPER_PASS.store(now, Ordering::Relaxed);
    metrics::gauge!("buzz_chain_helper_last_good_pass_seconds").set(now as f64);
}

/// The reader's loop: a pass, then a pause (doubling after failed passes, at
/// most ten minutes). It ends only by a panic, which [`supervise`] catches.
async fn run(
    reader: Arc<ChainReader>,
    source: Arc<dyn ChainSource>,
    expected_chain: u64,
    poll: Duration,
) {
    tracing::info!(reader = %reader.reader_id(), "chain reader started");
    let mut failures: u32 = 0;
    loop {
        let result = async {
            let served = source.chain_id().await?;
            if served != expected_chain {
                anyhow::bail!("the node serves chain {served}, not {expected_chain}");
            }
            reader.pass_all().await
        }
        .await;
        match result {
            Ok(PassReport {
                scanned,
                published,
                helper,
                ..
            }) => {
                failures = 0;
                record_good_pass();
                if scanned.logs > 0 || published.signed > 0 || scanned.rolled_back_to.is_some() {
                    tracing::info!(?scanned, ?published, "chain reader pass");
                }
                if let Some(h) = helper.filter(|h| *h != helper::HelperReport::default()) {
                    tracing::info!(helper = ?h, "chain helper pass");
                }
            }
            Err(e) => {
                failures = failures.saturating_add(1);
                tracing::error!(failures, "chain reader pass failed: {e:#}");
            }
        }
        let pause = if failures == 0 {
            poll
        } else {
            poll.saturating_mul(1u32 << failures.min(10))
                .min(MAX_BACKOFF)
        };
        tokio::time::sleep(pause).await;
    }
}

/// Run the task `start` makes, and start it again whenever it ends or panics
/// (review F9: before this, a panic ended the reader while the relay kept
/// serving the last records). The pause before a restart doubles from
/// `first_pause` up to `max_pause`, and starts over after a task that ran
/// longer than twice `max_pause`.
pub async fn supervise<F, Fut>(mut start: F, first_pause: Duration, max_pause: Duration)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    let mut restarts: u32 = 0;
    loop {
        let began = tokio::time::Instant::now();
        match tokio::spawn(start()).await {
            Ok(()) => tracing::error!("chain reader task ended; starting it again"),
            Err(e) if e.is_panic() => {
                tracing::error!("chain reader task panicked; starting it again")
            }
            Err(e) => tracing::error!("chain reader task stopped ({e}); starting it again"),
        }
        metrics::counter!("buzz_chain_reader_restarts_total").increment(1);
        if began.elapsed() > max_pause.saturating_mul(2) {
            restarts = 0;
        }
        restarts = restarts.saturating_add(1);
        let pause = first_pause
            .saturating_mul(1u32 << restarts.min(10))
            .min(max_pause);
        tokio::time::sleep(pause).await;
    }
}

#[cfg(test)]
mod supervise_tests {
    use std::sync::atomic::AtomicU32;

    use super::*;

    /// Review F9: a reader task that panics is started again, and the good
    /// pass number moves once a pass works.
    #[tokio::test]
    async fn a_panicking_reader_is_started_again_and_the_good_pass_moves() {
        let starts = Arc::new(AtomicU32::new(0));
        let began = chrono::Utc::now().timestamp();
        let counted = Arc::clone(&starts);
        let supervisor = tokio::spawn(supervise(
            move || {
                let n = counted.fetch_add(1, Ordering::SeqCst);
                async move {
                    if n == 0 {
                        panic!("a bug in a pass");
                    }
                    record_good_pass();
                    std::future::pending::<()>().await;
                }
            },
            Duration::from_millis(5),
            Duration::from_millis(50),
        ));
        let mut restarted = false;
        for _ in 0..200 {
            if starts.load(Ordering::SeqCst) >= 2 && last_good_pass().is_some_and(|t| t >= began) {
                restarted = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        supervisor.abort();
        assert!(
            restarted,
            "started {} time(s)",
            starts.load(Ordering::SeqCst)
        );
    }
}

#[cfg(test)]
mod hardening_postgres_tests;
#[cfg(test)]
mod postgres_tests;
#[cfg(test)]
mod review_m5p2_postgres_tests;
#[cfg(test)]
mod review_postgres_tests;
