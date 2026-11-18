//! The reader against real Postgres and a fake chain: discovery, a chain
//! rollback undone, the confirmation depth, the signed record, and a posted
//! copy refused through the real `ingest_event` seam (the review fixes are in
//! `review_postgres_tests.rs`, on the same fake chain). Ignored without
//! infrastructure (a migrated database and Redis); run with
//! `cargo test -p buzz-relay --lib chain_reader::postgres_tests -- --ignored`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use buzz_auth::Scope;
use buzz_core::kind::KIND_PROJECT_NUMBERS;
use nostr::{EventBuilder, Keys, Kind, Tag};
use serde_json::Value;
use sqlx::Row;
use uuid::Uuid;

use super::events::{Role, EVENTS};
use super::source::{ChainSource, Header, RawLog};
use super::word::{hex0x, Word};
use super::{ChainReader, ChainReaderConfig};
use crate::handlers::ingest::{ingest_event, IngestAuth, IngestError};

pub(super) const T0: u64 = 1_700_000_000;
pub(super) const DAY: u64 = 86_400;

pub(super) fn topic(role: Role, name: &str) -> Word {
    EVENTS
        .iter()
        .find(|e| e.role == role && e.name == name)
        .map(|e| e.topic())
        .expect("event")
}

pub(super) fn u(v: u128) -> Word {
    let mut w = [0u8; 32];
    w[16..].copy_from_slice(&v.to_be_bytes());
    w
}

pub(super) fn a(addr: &[u8; 20]) -> Word {
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(addr);
    w
}

pub(super) fn data(words: &[Word]) -> Vec<u8> {
    words.iter().flat_map(|w| w.iter().copied()).collect()
}

/// A chain held in memory; `fork` replaces its tail. `limit` makes it refuse
/// a log answer over that many logs as a node does; `lagging` makes its log
/// index miss the newest block's logs while headers are up to date.
#[derive(Default)]
pub(super) struct FakeChain {
    blocks: Mutex<Vec<(Header, Vec<RawLog>)>>,
    pub(super) limit: Mutex<Option<usize>>,
    pub(super) lagging: AtomicBool,
    /// A node behind: its head and headers stop at this block.
    pub(super) behind: Mutex<Option<u64>>,
    /// `eth_call` answers by (contract, calldata); none set: the source makes
    /// no calls.
    pub(super) calls: Mutex<std::collections::HashMap<([u8; 20], Vec<u8>), Vec<u8>>>,
}

impl FakeChain {
    /// Append a block at `time` holding `logs` (address, topics, data);
    /// `salt` makes a different block at the same height after a fork.
    pub(super) fn mine(&self, time: u64, salt: u8, logs: Vec<([u8; 20], Vec<Word>, Vec<u8>)>) {
        let mut blocks = self.blocks.lock().expect("lock");
        let number = blocks.len() as u64;
        let parent = blocks.last().map(|(h, _)| h.hash).unwrap_or([0; 32]);
        let mut hash = [salt; 32];
        hash[..8].copy_from_slice(&number.to_be_bytes());
        let header = Header {
            number,
            hash,
            parent,
            time,
        };
        let raw = logs
            .into_iter()
            .enumerate()
            .map(|(i, (address, topics, data))| RawLog {
                block_number: number,
                block_hash: hash,
                tx_hash: [i as u8; 32],
                log_index: i as u32,
                address,
                topics,
                data,
                removed: false,
            })
            .collect();
        blocks.push((header, raw));
    }

    pub(super) fn truncate(&self, len: usize) {
        self.blocks.lock().expect("lock").truncate(len);
    }
}

#[async_trait]
impl ChainSource for FakeChain {
    async fn eth_call(
        &self,
        to: &[u8; 20],
        data: &[u8],
        _at: u64,
    ) -> anyhow::Result<Option<Vec<u8>>> {
        let calls = self.calls.lock().expect("lock");
        if calls.is_empty() {
            return Ok(None);
        }
        calls
            .get(&(*to, data.to_vec()))
            .cloned()
            .map(Some)
            .ok_or_else(|| anyhow::anyhow!("execution reverted"))
    }
    async fn logs_with_topic1(
        &self,
        address: &[u8; 20],
        topic0: &Word,
        topic1: &[Word],
        from: u64,
        to: u64,
    ) -> anyhow::Result<Vec<RawLog>> {
        let blocks = self.blocks.lock().expect("lock");
        Ok(blocks
            .iter()
            .filter(|(h, _)| h.number >= from && h.number <= to)
            .flat_map(|(_, logs)| logs.iter())
            .filter(|l| {
                l.address == *address
                    && l.topics.first() == Some(topic0)
                    && l.topics.get(1).is_some_and(|t| topic1.contains(t))
            })
            .cloned()
            .collect())
    }
    async fn chain_id(&self) -> anyhow::Result<u64> {
        Ok(31337)
    }
    async fn head(&self) -> anyhow::Result<u64> {
        let top = self.blocks.lock().expect("lock").len() as u64 - 1;
        Ok(self
            .behind
            .lock()
            .expect("lock")
            .map_or(top, |b| b.min(top)))
    }
    async fn header(&self, number: u64) -> anyhow::Result<Option<Header>> {
        if self
            .behind
            .lock()
            .expect("lock")
            .is_some_and(|b| number > b)
        {
            return Ok(None);
        }
        Ok(self
            .blocks
            .lock()
            .expect("lock")
            .get(number as usize)
            .map(|(h, _)| h.clone()))
    }
    async fn logs(
        &self,
        addresses: &[[u8; 20]],
        topics: &[Word],
        from: u64,
        to: u64,
    ) -> anyhow::Result<Vec<RawLog>> {
        let found: Vec<RawLog> = {
            let blocks = self.blocks.lock().expect("lock");
            let indexed = if self.lagging.load(Ordering::SeqCst) {
                (blocks.len() as u64).saturating_sub(2)
            } else {
                u64::MAX
            };
            blocks
                .iter()
                .filter(|(h, _)| h.number >= from && h.number <= to.min(indexed))
                .flat_map(|(_, logs)| logs.iter())
                .filter(|l| addresses.contains(&l.address) && topics.contains(&l.topics[0]))
                .cloned()
                .collect()
        };
        if let Some(max) = *self.limit.lock().expect("lock") {
            if found.len() > max {
                anyhow::bail!("rpc error -32005: query returned more than {max} results");
            }
        }
        Ok(found)
    }
}

pub(super) const LAUNCHER: [u8; 20] = [0x11; 20];
pub(super) const FOUNDER: [u8; 20] = [0xf0; 20];
pub(super) const SHARES: [u8; 20] = [0x21; 20];
pub(super) const TREASURY: [u8; 20] = [0x22; 20];
pub(super) const VESTER: [u8; 20] = [0x23; 20];
pub(super) const FINISHER: [u8; 20] = [0x24; 20];
pub(super) const ROUNDS: [u8; 20] = [0x25; 20];
pub(super) const BOB: [u8; 20] = [0xb0; 20];
pub(super) const PRICE: u128 = 3_000_000_000_000_000;

pub(super) fn key() -> Word {
    [0x4b; 32]
}

/// The launch block: the Vester's founder grant comes before the Launcher's
/// event, as on the real chain, and must still be read.
pub(super) fn launch_logs() -> Vec<([u8; 20], Vec<Word>, Vec<u8>)> {
    let mut words = vec![
        a(&FOUNDER),
        a(&SHARES),
        a(&TREASURY),
        a(&VESTER),
        a(&FINISHER),
        a(&ROUNDS),
        u(T0 as u128),
    ];
    words.extend([u(1), u(2), u(3), u(4), u(5), u(6)]);
    words.extend([
        a(&[0xd0; 20]),
        a(&[0xe0; 20]),
        a(&[0xc0; 20]),
        u(500),
        u(300),
        u(15),
        u(60),
        u(1),
        u(1),
    ]);
    vec![
        (
            VESTER,
            vec![topic(Role::Vester, "Granted"), a(&FOUNDER)],
            data(&[u(200_000_000_000_000_000_000_000_000)]),
        ),
        (
            LAUNCHER,
            vec![
                topic(Role::Launcher, "ProjectLaunched"),
                key(),
                [7; 32],
                a(&FOUNDER),
            ],
            data(&words),
        ),
        (
            TREASURY,
            vec![topic(Role::Treasury, "CheckedIn"), a(&FOUNDER)],
            Vec::new(),
        ),
        (
            ROUNDS,
            vec![topic(Role::Rounds, "RoundOpened"), u(1)],
            data(&[
                u(10_000_000_000),
                u(PRICE),
                u(T0 as u128),
                u((T0 + DAY) as u128),
            ]),
        ),
    ]
}

pub(super) fn ask(amount: u128) -> ([u8; 20], Vec<Word>, Vec<u8>) {
    (
        ROUNDS,
        vec![topic(Role::Rounds, "Asked"), u(1), a(&BOB)],
        data(&[u(amount), u(amount)]),
    )
}

pub(super) fn close_and_settle(amount: u128) -> Vec<([u8; 20], Vec<Word>, Vec<u8>)> {
    let held = amount * 82 / 100;
    vec![
        (
            ROUNDS,
            vec![topic(Role::Rounds, "RoundClosed"), u(1)],
            data(&[u(amount), u(amount), u(DAY as u128)]),
        ),
        (
            ROUNDS,
            vec![topic(Role::Rounds, "Settled"), u(1), a(&BOB)],
            data(&[
                u(amount),
                u(0),
                u(amount * PRICE),
                u(amount * 3 / 100),
                u(amount * 15 / 100),
                u(held),
            ]),
        ),
        (
            VESTER,
            vec![topic(Role::Vester, "HeldGranted"), u(1), a(&BOB)],
            data(&[u(amount * PRICE)]),
        ),
    ]
}

fn config(confirmations: u64) -> ChainReaderConfig {
    ChainReaderConfig {
        rpc_url: "http://127.0.0.1:1".into(),
        chain_id: 31337,
        launcher: LAUNCHER,
        start_block: 0,
        confirmations,
        poll_secs: 1,
        refresh_secs: 3_600,
        log_range: 3,
        community_host: None,
        helper: None,
    }
}

pub(super) async fn setup(
    chain: Arc<FakeChain>,
    confirmations: u64,
) -> (ChainReader, Arc<crate::state::AppState>, String) {
    let state = crate::test_support::test_state().await;
    let host = format!("chain-reader-{}.example", Uuid::new_v4().simple());
    state
        .db
        .ensure_configured_community(&host)
        .await
        .expect("community");
    let mut cfg = config(confirmations);
    // A fresh Launcher per test keeps the rows of parallel runs apart.
    cfg.launcher[..16].copy_from_slice(&Uuid::new_v4().into_bytes());
    let reader = ChainReader::new(Arc::clone(&state), chain, cfg, host.clone());
    (reader, state, host)
}

pub(super) async fn latest_record(state: &crate::state::AppState, host: &str) -> Option<Value> {
    let community = state
        .db
        .lookup_community_by_host(host)
        .await
        .expect("lookup")
        .expect("community")
        .id;
    let row = sqlx::query(
        "SELECT content FROM events WHERE community_id = $1 AND kind = $2 AND deleted_at IS NULL \
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(community.as_uuid())
    .bind(KIND_PROJECT_NUMBERS as i32)
    .fetch_optional(state.db.pool())
    .await
    .expect("query");
    row.map(|r| {
        let text: String = r.try_get("content").expect("content");
        serde_json::from_str(&text).expect("json")
    })
}

async fn log_count(state: &crate::state::AppState, reader: &str) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM chain_logs WHERE reader = $1")
        .bind(reader)
        .fetch_one(state.db.pool())
        .await
        .expect("count")
}

/// Launch replaces the launcher address in the fixture logs with the test's own.
pub(super) fn with_launcher(
    mut logs: Vec<([u8; 20], Vec<Word>, Vec<u8>)>,
    launcher: [u8; 20],
) -> Vec<([u8; 20], Vec<Word>, Vec<u8>)> {
    for l in &mut logs {
        if l.0 == LAUNCHER {
            l.0 = launcher;
        }
    }
    logs
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn reads_discovers_rolls_back_and_signs_the_numbers() {
    let chain = Arc::new(FakeChain::default());
    let (reader, state, host) = setup(Arc::clone(&chain), 0).await;
    let launcher = reader.config.launcher;
    chain.mine(T0, 1, with_launcher(launch_logs(), launcher)); // block 0
    chain.mine(T0 + 10, 1, vec![ask(100_000_000)]); // block 1
    chain.mine(T0 + DAY, 1, close_and_settle(100_000_000)); // block 2
    chain.mine(T0 + DAY + 12, 1, vec![]); // block 3
                                          // The newest two blocks are never read (MIN_LAG), even with no confirmations.
    chain.mine(T0 + DAY + 24, 1, vec![]); // block 4
    chain.mine(T0 + DAY + 36, 1, vec![]); // block 5

    // log_range 3: two ranges, and the project's contracts are found inside
    // the first one, in the same block as their first logs.
    let (scanned, published) = reader.pass().await.expect("pass");
    assert_eq!(scanned.scanned_to, Some(3));
    assert_eq!(scanned.logs, 4 + 1 + 3);
    assert_eq!(published.signed, 1);
    let first = latest_record(&state, &host).await.expect("a record");
    assert_eq!(first["raised"]["total"], "100000000");
    assert_eq!(first["stage"]["name"], "backed");
    assert_eq!(first["now"]["refunds"][0]["per100"], "77.90");
    assert_eq!(first["holders"][0]["account"], hex0x(&FOUNDER));
    assert_eq!(first["asOf"]["block"], 3);

    // Nothing new: nothing signed again.
    let (_, again) = reader.pass().await.expect("pass");
    assert_eq!(again.signed, 0);

    // The chain rolls back to block 1 and the round closes with 40 instead.
    chain.truncate(2);
    chain.mine(T0 + DAY, 2, close_and_settle(40_000_000)); // a different block 2
    chain.mine(T0 + DAY + 12, 2, vec![]);
    chain.mine(T0 + DAY + 24, 2, vec![]);
    chain.mine(T0 + DAY + 36, 2, vec![]);
    let (scanned, published) = reader.pass().await.expect("pass after the rollback");
    assert_eq!(scanned.rolled_back_to, Some(1));
    assert_eq!(scanned.logs_removed, 3);
    assert_eq!(published.signed, 1);
    let after = latest_record(&state, &host).await.expect("a record");
    assert_eq!(after["raised"]["total"], "40000000");
    assert_eq!(log_count(&state, reader.reader_id()).await, 8);
    let hashes: Vec<Vec<u8>> = sqlx::query_scalar(
        "SELECT DISTINCT block_hash FROM chain_logs WHERE reader = $1 AND block_number = 2",
    )
    .bind(reader.reader_id())
    .fetch_all(state.db.pool())
    .await
    .expect("hashes");
    assert_eq!(hashes.len(), 1);
    assert_eq!(hashes[0][8], 2, "only the new block 2's logs remain");
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn numbers_count_only_logs_past_the_confirmation_depth() {
    let chain = Arc::new(FakeChain::default());
    let (reader, state, host) = setup(Arc::clone(&chain), 2).await;
    let launcher = reader.config.launcher;
    chain.mine(T0, 1, with_launcher(launch_logs(), launcher)); // 0
    chain.mine(T0 + 10, 1, vec![ask(100_000_000)]); // 1
    chain.mine(T0 + DAY, 1, close_and_settle(100_000_000)); // 2
    chain.mine(T0 + DAY + 12, 1, vec![]); // 3
    let (scanned, _) = reader.pass().await.expect("pass");
    // Head 3, two confirmations: block 1 is final, the close in block 2 is not
    // final and not even read.
    assert_eq!(scanned.scanned_to, Some(1));
    let n = latest_record(&state, &host).await.expect("a record");
    assert_eq!(n["asOf"]["block"], 1);
    assert_eq!(n["raised"]["total"], "0");
    assert_eq!(n["rounds"][0]["asked"], "100000000");
    chain.mine(T0 + DAY + 24, 1, vec![]); // 4: block 2 becomes final
    reader.pass().await.expect("pass");
    let n = latest_record(&state, &host).await.expect("a record");
    assert_eq!(n["raised"]["total"], "100000000");
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_posted_project_numbers_record_is_refused() {
    let state = crate::test_support::test_state().await;
    let host = format!("chain-reader-{}.example", Uuid::new_v4().simple());
    let community = state
        .db
        .ensure_configured_community(&host)
        .await
        .expect("community")
        .id;
    let keys = Keys::generate();
    let forged = EventBuilder::new(
        Kind::Custom(KIND_PROJECT_NUMBERS as u16),
        r#"{"version":1,"raised":{"total":"999"}}"#,
    )
    .tags([Tag::parse(["d", &hex0x(&key())]).expect("tag")])
    .sign_with_keys(&keys)
    .expect("sign");
    let tenant = buzz_core::tenant::TenantContext::resolved(community, host);
    let auth = IngestAuth::Nip42 {
        pubkey: keys.public_key(),
        scopes: vec![Scope::MessagesWrite, Scope::ChannelsWrite],
        channel_ids: None,
        conn_id: Uuid::new_v4(),
    };
    match ingest_event(&state, &tenant, forged, auth).await {
        Err(IngestError::Rejected(reason)) => assert!(reason.contains("relay-only"), "{reason}"),
        other => panic!(
            "a posted record must be refused, got {:?}",
            other.map(|_| ())
        ),
    }
}
