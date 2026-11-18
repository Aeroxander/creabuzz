//! The chain reader (plan v2, milestone 5, part 1).
//!
//! It reads the contracts/next events (the Launcher, and each project's
//! Rounds, Vester, Treasury, Finisher, Pair and Shares found in the Launcher's
//! events) into tables that survive a chain rollback (`scan`, `store`), works
//! out the numbers the chain cannot give (`numbers`), and signs one "project
//! numbers" record per project, kind 39009 (`publish`), again whenever they
//! change. It never sends a transaction. Off unless `BUZZ_CHAIN_RPC_URL` is set
//! (`settings`).

pub mod events;
pub mod numbers;
pub mod publish;
pub mod scan;
mod settings;
pub mod source;
pub mod store;
pub mod word;

use std::collections::HashSet;
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

/// One reader: a chain, a Launcher, a community to publish into.
pub struct ChainReader {
    state: Arc<AppState>,
    source: Arc<dyn ChainSource>,
    config: ChainReaderConfig,
    scan: ScanSettings,
    host: String,
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
            max_ranges: 20,
            keep_blocks: config.confirmations + 64,
            max_fork_walk: 2_048,
        };
        Self {
            state,
            source,
            config,
            scan,
            host,
        }
    }

    /// The tables' name for this reader.
    pub fn reader_id(&self) -> &str {
        &self.scan.reader
    }

    /// One pass: scan, then sign what changed.
    pub async fn pass(&self) -> anyhow::Result<(ScanReport, PublishReport)> {
        let pool = self.state.db.pool();
        let scanned = scan::scan(pool, self.source.as_ref(), &self.scan).await?;
        let published = self.publish_pass(scanned.head).await?;
        Ok((scanned, published))
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
        let final_block = head.saturating_sub(self.config.confirmations);
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
        };
        let now = chrono::Utc::now().timestamp();
        let projects = store::final_projects(pool, reader, final_block).await?;
        let previous = store::published(pool, reader).await?;
        let refresh = i64::try_from(self.config.refresh_secs).unwrap_or(i64::MAX);

        // Changed projects first, then those due a refresh, at most a pass's worth.
        let mut work: Vec<(Word, u64, bool)> = projects
            .iter()
            .filter_map(|(key, src)| match previous.get(key) {
                None => Some((*key, *src, true)),
                Some(p) if p.stale || p.source_block != *src => Some((*key, *src, true)),
                Some(p) if now - p.published_at >= refresh => Some((*key, *src, false)),
                Some(_) => None,
            })
            .collect();
        work.sort_by_key(|(_, _, changed)| !*changed);
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

    async fn sign(
        &self,
        tenant: &TenantContext,
        key: &Word,
        content: &Value,
        created_at: i64,
    ) -> anyhow::Result<[u8; 32]> {
        let key_hex = hex0x(key);
        let tags = publish::tags(
            &key_hex,
            self.config.chain_id,
            &hex0x(&self.config.launcher),
        )?;
        let created = u64::try_from(created_at).context("time before 1970")?;
        publish::publish(&self.state, tenant, tags, &key_hex, content, created).await
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
        let Some(content) = numbers::derive(key, &logs, as_of)? else {
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
                // for long): keep the record, remember the block it covers.
                store::touch_source_block(pool, reader, key, source_block).await?;
                return Ok(false);
            }
        }
        let created_at = prev.map_or(now, |p| now.max(p.published_at + 1));
        let event_id = self.sign(tenant, key, &content, created_at).await?;
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
    let reader = ChainReader::new(state, Arc::clone(&source), config, host);
    Ok(Some(tokio::spawn(async move {
        tracing::info!(reader = %reader.reader_id(), "chain reader started");
        let mut failures: u32 = 0;
        loop {
            let result = async {
                let served = source.chain_id().await?;
                if served != expected_chain {
                    anyhow::bail!("the node serves chain {served}, not {expected_chain}");
                }
                reader.pass().await
            }
            .await;
            match result {
                Ok((scanned, published)) => {
                    failures = 0;
                    if scanned.logs > 0 || published.signed > 0 || scanned.rolled_back_to.is_some()
                    {
                        tracing::info!(?scanned, ?published, "chain reader pass");
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
    })))
}

#[cfg(test)]
mod postgres_tests;
