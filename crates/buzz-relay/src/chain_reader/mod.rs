//! The chain reader.
//!
//! It reads the contracts/pot events (the Launcher, and each project's
//! Treasury, Vester, Shares, Team Shares and Pair found in the Launcher's
//! events) into tables that survive a chain rollback (`scan`, `store`),
//! rebuilds each project's state from its events alone (`ledger`), works out
//! the numbers the chain cannot give (`numbers`), and signs one "project
//! numbers" record per project, kind 39009 (`publish`), again whenever they
//! change. Off unless `BUZZ_CHAIN_RPC_URL` is set (`settings`). The events are
//! decoded by a table generated from the contracts build (`events`).
//!
//! With `BUZZ_CHAIN_HELPER_KEY` set, the helper job (`helper`) also sends the
//! calls anyone may make from a relay-held key. Signing records and sending
//! calls are done by one replica only: the one holding the writer lock, a
//! session advisory lock on a connection of its own, checked on every pass.

pub mod events;
#[cfg(test)]
pub(crate) mod fixture;
pub mod held;
pub mod helper;
pub mod ledger;
pub mod ledger_tasks;
pub mod numbers;
mod numbers_tasks;
pub mod publish;
pub mod record;
pub mod record_social;
pub mod record_tasks;
mod record_tasks_rules;
pub mod scan;
mod settings;
pub mod source;
pub mod store;
pub mod views;
mod views_table;
pub mod word;

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicI64, AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use buzz_core::tenant::TenantContext;
use buzz_evm_allowance::HttpEvmRpc;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub use settings::ChainReaderConfig;

use crate::state::AppState;
use numbers::{AsOf, Cadence};
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
/// After a failed build a project waits this long before its next try, then
/// twice as long after each further failure, up to [`FAILURE_PAUSE_MAX_SECS`]:
/// a project whose numbers cannot be built must not take a slot of every pass
/// and starve the others.
const FAILURE_PAUSE_SECS: i64 = 15;
/// The longest wait between two tries of a project that keeps failing.
const FAILURE_PAUSE_MAX_SECS: i64 = 300;
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
    /// When each project is next worth looking at (the writer's memory only:
    /// after a restart every project is looked at once).
    schedule: std::sync::Mutex<Schedule>,
}

/// What the publishing pass remembers per project, so that a quiet project is
/// not read from the node again at every poll and a failing one does not keep
/// its place at the front of the queue.
#[derive(Debug, Default)]
struct Schedule {
    /// Unchanged and not due: the project's numbers are not worked out again
    /// before this unix second (its own promised refresh time after its last
    /// signing).
    quiet_until: HashMap<Word, i64>,
    /// Failed builds in a row, and the unix second before which the project
    /// is not tried again.
    failing: HashMap<Word, (u32, i64)>,
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
    /// Social keys (`held`, `feed`, `streaks`, `established`) signed as `null`
    /// because they could not be counted or failed their own checks. The rest
    /// of the record was signed.
    pub social_failed: usize,
    /// Held-for-a-window counts left without a figure because the window was
    /// over its cap of rows or accounts.
    pub held_cut: usize,
}

/// Whether a publishing pass that took `elapsed` outgrew `refresh_secs`, the
/// shortest refresh time the server promises: longer than half of it.
fn pass_is_slow(elapsed: Duration, refresh_secs: i64) -> bool {
    elapsed.as_millis().saturating_mul(2) > u128::try_from(refresh_secs).unwrap_or(0) * 1_000
}

/// Seconds a project waits after its `failures`-th failed build in a row.
fn failure_pause(failures: u32) -> i64 {
    FAILURE_PAUSE_SECS
        .saturating_mul(1i64 << failures.saturating_sub(1).min(10))
        .min(FAILURE_PAUSE_MAX_SECS)
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
            schedule: std::sync::Mutex::new(Schedule::default()),
        }
    }

    fn schedule(&self) -> std::sync::MutexGuard<'_, Schedule> {
        self.schedule
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
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
        self.note_play_money(scanned.head).await;
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

    /// Read `Launcher.testNetwork()` while it is not known in this process,
    /// on every replica (not only the writer, which learns it by building
    /// records). A failed read leaves it unknown, which counts as play money
    /// (the safe answer) until the next pass.
    async fn note_play_money(&self, head: u64) {
        if play_money().is_some() {
            return;
        }
        let block = head.saturating_sub(self.scan.lag);
        if block < self.config.start_block {
            return;
        }
        match views::read_test_network(self.source.as_ref(), self.config.launcher, block).await {
            Ok(play) => note_play_money(play),
            Err(e) => {
                tracing::warn!(reader = %self.reader_id(), "chain reader: the Launcher's test-network flag was not read: {e:#}")
            }
        }
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
        // Jobs are built only from final rows the reader has stored, and never
        // from a block below the newest one read (a head that stepped back).
        let cursor = store::cursor(pool, reader).await?;
        let final_block =
            match helper_final_block(head, self.scan.lag, self.config.start_block, cursor) {
                Some(f) => {
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
            .pass(pool, reader, (head, head_header.time), final_block)
            .await
    }

    fn cadence(&self) -> Cadence {
        Cadence {
            active_secs: self.config.active_refresh_secs,
            idle_secs: self.config.refresh_secs,
        }
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
        let began = std::time::Instant::now();
        let pool = self.state.db.pool();
        let reader = self.scan.reader.as_str();
        let mut report = PublishReport::default();
        let Some(final_block) = head.checked_sub(self.scan.lag) else {
            return Ok(report);
        };
        let cursor = store::cursor(pool, reader).await?;
        if final_block < self.config.start_block || cursor <= final_block {
            return Ok(report); // the final block is not read yet
        }
        if cursor > final_block + 1 {
            // The node answers a lower head than the blocks already read (a
            // load-balanced node a few blocks behind), and nothing rolled
            // back. Numbers worked out at the lower block would replace newer
            // ones, and a launch above it would look removed: wait for the
            // head to come back (records only go forward).
            tracing::warn!(reader = %self.reader_id(), final_block, read_to = cursor - 1, "chain reader: the node's head is below the blocks already read; nothing signed this pass");
            return Ok(report);
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
        };
        let now = chrono::Utc::now().timestamp();
        let projects = store::final_projects(pool, reader, final_block).await?;
        let previous = store::published(pool, reader).await?;
        // A project is looked at again once its shortest promise has passed;
        // `publish_project` keeps the record when the project's own promise
        // (`refreshEverySecs`) is not yet due, and remembers when that is, so
        // the node is not asked about it again before.
        let refresh = i64::try_from(
            self.config
                .active_refresh_secs
                .min(self.config.refresh_secs),
        )
        .unwrap_or(i64::MAX);

        // Changed projects first, then those due a refresh, longest unchecked
        // first, at most a pass's worth. A project that failed to build waits
        // out its pause.
        let mut work: Vec<(Word, u64, Option<f64>)> = {
            let schedule = self.schedule();
            projects
                .iter()
                .filter(|(key, _)| schedule.failing.get(key).is_none_or(|(_, at)| now >= *at))
                .filter_map(|(key, src)| match previous.get(key) {
                    None => Some((*key, *src, None)),
                    Some(p) if p.stale || p.source_block != *src => Some((*key, *src, None)),
                    Some(p) => {
                        let due = schedule
                            .quiet_until
                            .get(key)
                            .copied()
                            .unwrap_or_else(|| p.published_at.saturating_add(refresh));
                        (now >= due).then_some((*key, *src, Some(p.checked_at)))
                    }
                })
                .collect()
        };
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
                Ok((signed, social)) => {
                    self.schedule().failing.remove(&key);
                    if signed {
                        report.signed += 1;
                    }
                    report.social_failed += social.failed.len();
                    report.held_cut += usize::try_from(social.cut).unwrap_or(usize::MAX);
                }
                Err(e) => {
                    report.failed += 1;
                    self.note_failure(&key, now);
                    tracing::error!(project = %hex0x(&key), "chain reader: numbers not signed: {e:#}");
                }
            }
        }

        // A project whose launch left the chain (a rollback deeper than the
        // confirmations): sign a removal so its old numbers are not shown.
        let live: HashSet<Word> = projects.iter().map(|(k, _)| *k).collect();
        {
            let mut schedule = self.schedule();
            schedule.quiet_until.retain(|k, _| live.contains(k));
            schedule.failing.retain(|k, _| live.contains(k));
        }
        for (key, prev) in previous.iter().filter(|(k, _)| !live.contains(*k)) {
            let content = json!({
                "version": 2, "key": hex0x(key), "removed": true,
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
        // The reader reads a project's stored rows each pass (a Take out with notes
        // adds rows, RECORD-V2 section 10.3): a pass that outgrows its refresh time
        // is the alarm to fold the per-holder notes into a running-totals table.
        let took = began.elapsed();
        if pass_is_slow(took, refresh) {
            tracing::error!(
                took_secs = took.as_secs(),
                refresh_secs = refresh,
                "chain reader: a publishing pass took longer than half the refresh time it promises; \
                 the work per pass has outgrown it"
            );
        }
        Ok(report)
    }

    /// A project's build failed: it waits longer after each failure in a row.
    fn note_failure(&self, key: &Word, now: i64) {
        let mut schedule = self.schedule();
        let entry = schedule.failing.entry(*key).or_insert((0, 0));
        entry.0 = entry.0.saturating_add(1);
        entry.1 = now.saturating_add(failure_pause(entry.0));
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
        let mut content = content.clone();
        for _ in 0..2 {
            // `builtAt` is the event's own `created_at`.
            if let Some(built) = content.get_mut("builtAt") {
                *built = json!(created);
            }
            let tags = publish::tags(
                &key_hex,
                self.config.chain_id,
                &hex0x(&self.config.launcher),
            )?;
            match publish::publish(&self.state, tenant, tags, &key_hex, &content, created).await? {
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

    /// Count how long money has stayed over the ranking window and the badge
    /// window (`held`). An error is a database or consistency failure, never a
    /// window over its cap (that is [`held::Window::Cut`]).
    async fn count_windows(
        &self,
        key: &Word,
        as_of: &AsOf,
        ledger: &ledger::Ledger,
    ) -> anyhow::Result<(held::Window, held::Window)> {
        let pool = self.state.db.pool();
        let reader = self.scan.reader.as_str();
        let excluded = ledger.excluded(&std::collections::BTreeSet::from([hex0x(&as_of.launcher)]));
        let mut windows = Vec::with_capacity(2);
        for secs in [
            record_social::rank_secs(ledger.unit),
            record_social::badge_secs(ledger.unit),
        ] {
            let raw = held::held_input(
                pool,
                reader,
                key,
                as_of.block,
                as_of.time.saturating_sub(secs),
                held::Limits::default(),
            )
            .await?;
            windows.push(match raw {
                held::WindowRaw::Cut => held::Window::Cut,
                held::WindowRaw::Counted(runs) => {
                    held::Window::Counted(held::lowest(&runs, ledger.shares_balances(), &excluded)?)
                }
            });
        }
        let badge = windows.pop().context("the badge window")?;
        let rank = windows.pop().context("the rank window")?;
        Ok((rank, badge))
    }

    /// Work out and, when they changed, sign one project's numbers. Returns
    /// whether a record was signed, and what the social keys did.
    async fn publish_project(
        &self,
        tenant: &TenantContext,
        key: &Word,
        source_block: u64,
        as_of: &AsOf,
        prev: Option<&store::Published>,
        now: i64,
    ) -> anyhow::Result<(bool, record_social::SocialReport)> {
        let pool = self.state.db.pool();
        let reader = self.scan.reader.as_str();
        let logs = store::project_logs(pool, reader, key, as_of.block).await?;
        let Some(mut ledger) = ledger::Ledger::from_logs(&logs)? else {
            return Ok((false, record_social::SocialReport::default()));
        };
        ledger.set_balances(
            &store::balances(pool, reader, key, events::Role::Shares, as_of.block).await?,
            &store::balances(pool, reader, key, events::Role::Team, as_of.block).await?,
        )?;
        let created_at = prev.map_or(now, |p| now.max(p.published_at + 1));
        // The held-for-a-window counts are display only: a failure to read them leaves `held` null in this
        // record (and is tried again at the next build), it never stops the record.
        let windows = match self.count_windows(key, as_of, &ledger).await {
            Ok(windows) => Some(windows),
            Err(e) => {
                tracing::error!(project = %hex0x(key), "chain reader: held not counted: {e:#}");
                None
            }
        };
        let social = record_social::SocialInput {
            rows: &logs,
            held: windows.as_ref().map(|(rank, badge)| (rank, badge)),
        };
        let (content, social_report) = numbers::derive(
            self.source.as_ref(),
            &ledger,
            as_of,
            &self.cadence(),
            u64::try_from(created_at).context("time before 1970")?,
            &social,
        )
        .await?;
        for line in &social_report.failed {
            tracing::error!(project = %hex0x(key), "chain reader: {line}");
            metrics::counter!("buzz_chain_reader_social_failed_total").increment(1);
        }
        let facts = digest(&numbers::facts_of(&content));
        let shown = digest(&numbers::without_as_of(&content));
        if let Some(p) = prev {
            let same_facts = p.facts_digest.as_slice() == facts.as_slice();
            // The record promises a fresh one every `refreshEverySecs`.
            let promised = content
                .get("refreshEverySecs")
                .and_then(Value::as_i64)
                .unwrap_or(i64::try_from(self.config.refresh_secs).unwrap_or(i64::MAX));
            let refresh_due = now - p.published_at >= promised;
            if same_facts && !p.stale && !refresh_due {
                // No event moved and the promised refresh is not due yet: keep
                // the record and remember the block it covers. `published_at`
                // stays the time of the last signing, so a due refresh is
                // signed even when nothing changed (the heartbeat: a quiet
                // project must not look like a dead server).
                store::touch_source_block(pool, reader, key, source_block).await?;
                self.schedule()
                    .quiet_until
                    .insert(*key, p.published_at.saturating_add(promised));
                return Ok((false, social_report));
            }
        }
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
        // The next look is at the project's refresh time after this signing.
        self.schedule().quiet_until.remove(key);
        Ok((true, social_report))
    }
}

/// The final block the helper may build jobs from: the newest final block
/// (`head` less `lag`) when the reader has read exactly up to it and no
/// further (`cursor` is the next block to read). A head that stepped back
/// below the blocks already read gives none, so jobs are never built from a
/// block lower than the newest one read.
fn helper_final_block(head: u64, lag: u64, start_block: u64, cursor: u64) -> Option<u64> {
    let f = head.checked_sub(lag)?;
    (f >= start_block && cursor > f && cursor <= f + 1).then_some(f)
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

/// Whether the chain's dollar is play money, as the Launcher last said
/// (`testNetwork()`): 0 not known yet, 1 play money, 2 real money.
static PLAY_MONEY: AtomicU8 = AtomicU8::new(0);

/// Note what the Launcher said about the dollar (every record build reads it).
pub(crate) fn note_play_money(play: bool) {
    PLAY_MONEY.store(if play { 1 } else { 2 }, Ordering::Relaxed);
}

/// Whether the dollar of the chain this server reads is play money. `None`
/// until the reader has read the Launcher: callers treat that as play money,
/// the safe answer.
pub fn play_money() -> Option<bool> {
    #[cfg(test)]
    if let Some(forced) = TEST_PLAY_MONEY.with(std::cell::Cell::get) {
        return forced;
    }
    match PLAY_MONEY.load(Ordering::Relaxed) {
        1 => Some(true),
        2 => Some(false),
        _ => None,
    }
}

#[cfg(test)]
thread_local! {
    /// A test's own answer to [`play_money`], for the thread it runs on.
    static TEST_PLAY_MONEY: std::cell::Cell<Option<Option<bool>>> = const { std::cell::Cell::new(None) };
}

/// Forget what the process knows of the dollar's kind (tests only).
#[cfg(test)]
pub(crate) fn forget_play_money_for_test() {
    PLAY_MONEY.store(0, Ordering::Relaxed);
}

/// Make [`play_money`] answer `value` on this thread (tests only).
#[cfg(test)]
pub(crate) fn set_play_money_for_test(value: Option<bool>) {
    TEST_PLAY_MONEY.with(|c| c.set(Some(value)));
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
mod schedule_tests {
    use super::*;

    /// The alarm for a pass that outgrew its refresh time.
    #[test]
    fn a_pass_longer_than_half_the_refresh_time_is_slow() {
        let secs = Duration::from_secs;
        assert!(!pass_is_slow(secs(300), 600), "exactly half is not longer");
        assert!(pass_is_slow(Duration::from_millis(300_001), 600));
        assert!(!pass_is_slow(secs(0), 600));
        assert!(pass_is_slow(secs(1), 0), "a zero promise cannot be met");
    }

    /// A project that keeps failing waits longer each time, up to a cap.
    #[test]
    fn a_failing_project_waits_longer_each_time_up_to_a_cap() {
        let pauses: Vec<i64> = (1..=7).map(failure_pause).collect();
        assert_eq!(pauses, [15, 30, 60, 120, 240, 300, 300]);
        assert_eq!(failure_pause(u32::MAX), FAILURE_PAUSE_MAX_SECS);
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
mod helper_block_tests {
    use super::helper_final_block;

    /// The helper builds jobs only at the final block the reader has just
    /// read; a head that stepped back builds none (the clause that stops it
    /// is `cursor <= f + 1`).
    #[test]
    fn jobs_are_built_only_at_the_newest_block_read() {
        // Read exactly up to the final block (next to read is f + 1).
        assert_eq!(helper_final_block(110, 10, 50, 101), Some(100));
        // The final block is not read yet.
        assert_eq!(helper_final_block(110, 10, 50, 100), None);
        // The head stepped back two blocks below what is already read.
        assert_eq!(helper_final_block(108, 10, 50, 101), None);
        // Below the launcher's first block, or a head younger than the lag.
        assert_eq!(helper_final_block(40, 10, 50, 31), None);
        assert_eq!(helper_final_block(5, 10, 0, 1), None);
    }
}

#[cfg(test)]
mod mul_div_tests;
#[cfg(test)]
mod record_social_tests;
#[cfg(test)]
mod record_tests;
#[cfg(test)]
mod scan_postgres_tests;
#[cfg(test)]
mod task_checks_tests;
