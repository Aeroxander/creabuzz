//! A team's task records tied to their tasks on the network, driven through the real `ingest_event` seam.
//!
//! The rows the relay reads (`chain_logs`: the project's launch and its task book) come from the real run of the
//! contracts (`chain_reader/testdata/pot-run.json`, project A: serial 2 paid in part, 3 sent back, 4 ran out, 6 taken,
//! 7 announced, 8 the same record planned again, 9 withdrawn). They are stored as the reader stores them, block by
//! block; only two fields are pointed at the records of the test, because a real plan names the id of the signed
//! record: the launch's `projectId` (the hash of the project record's address) and a task's `what` (the id of its
//! record). No number is typed here. Removing a refusal of `task_chain` fails the test that names it; removing the
//! future-date bound of `ingest` fails the last one. Ignored without infrastructure; run with
//! `cargo test -p buzz-relay --lib -- task_chain_postgres_tests --include-ignored --test-threads=1`.

use std::sync::Arc;

use buzz_auth::Scope;
use buzz_core::kind::{KIND_LAUNCH_RECORD, KIND_LAUNCH_UPDATE};
use buzz_core::tenant::TenantContext;
use nostr::{Event, EventBuilder, Keys, Kind, Tag, Timestamp};
use serde_json::{json, Value};
use uuid::Uuid;

use super::ingest::{ingest_event, IngestAuth, IngestError};
use super::task_chain::{
    ANNOUNCED_SQL, AS_OF_SQL, LATER_SQL, NAME_WALLET, NOT_SEEN_YET, NOT_THAT_PAYMENT, OTHER_WALLET,
    PAID_ELSEWHERE, PAY_FIRST, PLAN_ENDED, TAKEN_ELSEWHERE, WITHDRAW_FIRST,
};
use crate::api::manager::cost::project_id;
use crate::chain_reader::events::{self, Role};
use crate::chain_reader::fixture::Fixture;
use crate::chain_reader::word::hex0x;
use crate::state::AppState;

// The serials of the run's project A that the tests use (the run's own scenario, see the fixture script).
const PAID: u64 = 2;
const SENT_BACK: u64 = 3;
const TAKEN: u64 = 6;
const ANNOUNCED: u64 = 7;
const WITHDRAWN: u64 = 9;

/// Ingest as the signer, with the scopes a signed-in app has.
async fn ingest(state: &Arc<AppState>, tenant: &TenantContext, event: Event) -> Result<(), String> {
    let auth = IngestAuth::Nip42 {
        pubkey: event.pubkey,
        scopes: vec![
            Scope::UsersWrite,
            Scope::ChannelsWrite,
            Scope::MessagesWrite,
        ],
        channel_ids: None,
        conn_id: Uuid::new_v4(),
    };
    match ingest_event(state, tenant, event, auth).await {
        Ok(result) if result.accepted => Ok(()),
        Ok(result) => Err(result.message),
        Err(IngestError::Rejected(reason)) | Err(IngestError::AuthFailed(reason)) => Err(reason),
        Err(IngestError::Internal(reason)) => Err(format!("internal: {reason}")),
        Err(other) => panic!("refused oddly: {other:?}"),
    }
}

fn signed(keys: &Keys, kind: u32, tags: &[&[&str]], ahead: u64) -> Event {
    let tags: Vec<Tag> = tags
        .iter()
        .map(|fields| Tag::parse(fields.to_vec()).expect("tag"))
        .collect();
    EventBuilder::new(Kind::Custom(kind as u16), "{}")
        .tags(tags)
        .allow_self_tagging()
        .custom_created_at(Timestamp::from(Timestamp::now().as_secs() + ahead))
        .sign_with_keys(keys)
        .expect("sign")
}

fn record(who: &Keys, coordinate: &str, tags: &[&[&str]]) -> Event {
    let a: [&str; 2] = ["a", coordinate];
    let mut all: Vec<&[&str]> = vec![&a];
    all.extend_from_slice(tags);
    signed(who, KIND_LAUNCH_UPDATE, &all, 0)
}

/// A task open to anyone, paying `usd`; `what` keeps two tasks signed in one second apart.
fn open_task(who: &Keys, coordinate: &str, what: &str, usd: &str) -> Event {
    record(
        who,
        coordinate,
        &[
            &["l", "creaton-task"],
            &["task-part", "task"],
            &["task-what", what],
            &["task-done", "A map anyone can read"],
            &["task-size", "small"],
            &["task-usd", usd],
        ],
    )
}

/// A task that names its helper.
fn named_task(who: &Keys, coordinate: &str, what: &str, helper: &Keys) -> Event {
    let helper = helper.public_key().to_hex();
    record(
        who,
        coordinate,
        &[
            &["l", "creaton-task"],
            &["task-part", "task"],
            &["task-what", what],
            &["task-done", "A map anyone can read"],
            &["task-size", "small"],
            &["task-helper", helper.as_str()],
        ],
    )
}

fn step(who: &Keys, coordinate: &str, part: &str, task: &Event, extra: &[&[&str]]) -> Event {
    let id = task.id.to_hex();
    let (l, p, e, t) = (
        ["l", "creaton-task"],
        ["task-part", part],
        ["e", id.as_str()],
        ["task", id.as_str()],
    );
    let mut tags: Vec<&[&str]> = vec![&l, &p, &e, &t];
    tags.extend_from_slice(extra);
    record(who, coordinate, &tags)
}

/// A chain reader of this test's own (its launcher is random), so the rows it reads are the only rows there are.
fn reader() -> crate::chain_reader::ChainReaderConfig {
    let mut launcher = [0u8; 20];
    launcher.copy_from_slice(&Uuid::new_v4().as_bytes()[..16].repeat(2)[..20]);
    crate::chain_reader::ChainReaderConfig {
        rpc_url: "http://127.0.0.1:1".into(),
        chain_id: 31_337,
        launcher,
        start_block: 0,
        confirmations: 12,
        poll_secs: 12,
        refresh_secs: 3_600,
        active_refresh_secs: 600,
        log_range: 2_000,
        community_host: None,
        helper: None,
    }
}

struct World {
    state: Arc<AppState>,
    tenant: TenantContext,
    founder: Keys,
    mate: Keys,
    stranger: Keys,
    other: Keys,
    coordinate: String,
    /// The name the reader's rows are kept under.
    reader: String,
    fx: Fixture,
}

/// A community and a project whose record names the run's project A as its chain key, with a chain reader of the
/// test's own configured or not.
async fn world(with_reader: bool) -> World {
    world_for("A", with_reader).await
}

/// [`world`] naming the run's project `chain_project` (A or B) as the project's launch.
async fn world_for(chain_project: &str, with_reader: bool) -> World {
    let fx = Fixture::load();
    let config = reader();
    let reader_id = config.reader_id();
    let state = crate::test_support::test_state_with(|c| {
        c.new_account_posts_per_hour = 0;
        if with_reader {
            c.chain_reader = Some(config);
        }
    })
    .await;
    let host = format!("task-chain-{}.example", Uuid::new_v4().simple());
    let community = state
        .db
        .ensure_configured_community(&host)
        .await
        .expect("community")
        .id;
    let (founder, mate, stranger, other) = (
        Keys::generate(),
        Keys::generate(),
        Keys::generate(),
        Keys::generate(),
    );
    for keys in [&founder, &mate, &stranger, &other] {
        state
            .db
            .add_relay_member(community, &keys.public_key().to_hex(), "member", None)
            .await
            .expect("member");
    }
    let tenant = TenantContext::resolved(community, host);
    let (mate_hex, d) = (mate.public_key().to_hex(), "orbit");
    let key = format!("0x{}", hex::encode(fx.projects[chain_project].key));
    ingest(
        &state,
        &tenant,
        signed(
            &founder,
            KIND_LAUNCH_RECORD,
            &[
                &["d", d],
                &["name", "Orbit"],
                &["team", &mate_hex, "engineer"],
                &["chain-key", &key],
            ],
            0,
        ),
    )
    .await
    .expect("the project record");
    let coordinate = format!("37001:{}:{d}", founder.public_key().to_hex());
    World {
        state,
        tenant,
        founder,
        mate,
        stranger,
        other,
        coordinate,
        reader: reader_id,
        fx,
    }
}

impl World {
    async fn accept(&self, event: Event, what: &str) {
        if let Err(reason) = ingest(&self.state, &self.tenant, event).await {
            panic!("{what}: refused: {reason}");
        }
    }

    async fn refuse(&self, event: Event, expected: &str, what: &str) {
        match ingest(&self.state, &self.tenant, event).await {
            Ok(()) => panic!("{what}: should be refused"),
            Err(reason) => assert!(
                reason.contains(expected),
                "{what}: refused for the wrong reason: {reason}"
            ),
        }
    }

    /// Store the run's rows of `project` (its launch and its task book) for blocks `from..=to`, as the reader stores
    /// them: the blocks, then each log with its decoded fields. The launch names this world's project record, and the
    /// task serials in `whats` name the records the test made.
    async fn seed(&self, project: &str, whats: &[(u64, &Event)], from: u64, to: u64) {
        let pool = self.state.db.pool();
        let key = self.fx.projects[project].key;
        for h in self
            .fx
            .blocks
            .iter()
            .filter(|h| (from..=to).contains(&h.number))
        {
            sqlx::query(
                "INSERT INTO chain_blocks (reader, number, hash, parent_hash, block_time) VALUES ($1, $2, $3, $4, $5) \
                 ON CONFLICT DO NOTHING",
            )
            .bind(&self.reader)
            .bind(i64::try_from(h.number).expect("block"))
            .bind(h.hash.as_slice())
            .bind(h.parent.as_slice())
            .bind(i64::try_from(h.time).expect("time"))
            .execute(pool)
            .await
            .expect("block");
        }
        for log in self
            .fx
            .logs
            .iter()
            .filter(|l| (from..=to).contains(&l.block_number))
        {
            let Some((role, owner)) = self.fx.role_of(&log.address) else {
                continue;
            };
            let ours = match role {
                Role::Launcher => log.topics.get(1) == Some(&key),
                Role::Tasks => owner == Some(project),
                _ => false,
            };
            let Some(def) = log
                .topics
                .first()
                .and_then(|t| events::lookup(role, t))
                .filter(|_| ours)
            else {
                continue;
            };
            let mut decoded = events::decode(def, &log.topics, &log.data).expect("decodes");
            if def.name == "ProjectLaunched" {
                decoded["projectId"] = json!(project_id(&self.coordinate));
            }
            if def.name == "TaskAnnounced" {
                let serial: u64 = decoded["serial"]
                    .as_str()
                    .and_then(|s| s.parse().ok())
                    .expect("a serial");
                if let Some((_, task)) = whats.iter().find(|(s, _)| *s == serial) {
                    decoded["what"] = json!(hex0x(&task.id.to_bytes()));
                }
            }
            sqlx::query(
                "INSERT INTO chain_logs (reader, block_number, log_index, block_hash, tx_hash, address, role, \
                 project_key, event, topics, data, decoded) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
            )
            .bind(&self.reader)
            .bind(i64::try_from(log.block_number).expect("block"))
            .bind(i32::try_from(log.log_index).expect("index"))
            .bind(log.block_hash.as_slice())
            .bind(log.tx_hash.as_slice())
            .bind(log.address.as_slice())
            .bind(role.as_str())
            .bind(key.as_slice())
            .bind(def.name)
            .bind(log.topics.iter().map(|t| t.to_vec()).collect::<Vec<_>>())
            .bind(&log.data)
            .bind(&decoded)
            .execute(pool)
            .await
            .expect("log");
        }
    }

    /// The block of the run the example record is built at: serial 6 is taken and 7 announced and none has run out
    /// (the run goes on past their ends, to a head at which every open plan is over).
    fn live_block(&self) -> u64 {
        self.fx.book_block("A_example")
    }

    /// Project A's rows to the live block, with `whats` naming the test's records.
    async fn seed_run(&self, whats: &[(u64, &Event)]) {
        self.seed("A", whats, 0, self.live_block()).await;
    }

    /// A task book row of project A: the first of `event` for `serial` and the block it is in.
    fn book_row(&self, event: &str, serial: u64) -> (u64, [u8; 32], Value) {
        self.fx
            .decoded()
            .into_iter()
            .find(|(role, project, row)| {
                *role == Role::Tasks
                    && project.as_deref() == Some("A")
                    && row.event == event
                    && row.fields["serial"] == json!(serial.to_string())
            })
            .map(|(_, _, row)| (row.block, row.tx, row.fields))
            .unwrap_or_else(|| panic!("the run has no {event} for serial {serial}"))
    }

    /// The wallet the run's plan `serial` names (lower case).
    fn payee(&self, serial: u64) -> String {
        self.book_row("TaskAnnounced", serial).2["payee"]
            .as_str()
            .expect("a payee")
            .to_lowercase()
    }

    /// The wallet that took the run's plan `serial` (lower case): the one the network paid.
    fn taken_by(&self, serial: u64) -> String {
        self.book_row("TaskTaken", serial).2["takenBy"]
            .as_str()
            .expect("a taker")
            .to_lowercase()
    }

    /// The transaction that paid the run's plan `serial` (the resolve whose state is paid), as `0x` hex.
    fn paid_tx(&self, serial: u64) -> String {
        let paid = self
            .fx
            .decoded()
            .into_iter()
            .find(|(role, project, row)| {
                *role == Role::Tasks
                    && project.as_deref() == Some("A")
                    && row.event == "TaskResolved"
                    && row.fields["serial"] == json!(serial.to_string())
                    && row.fields["state"] == json!("3")
            })
            .expect("the run paid it");
        hex0x(&paid.2.tx)
    }

    /// Add a block after the run's newest, `after` seconds after `time` (a later block the reader has read).
    async fn read_a_block_at(&self, time: u64) {
        let head = self.fx.head();
        sqlx::query(
            "INSERT INTO chain_blocks (reader, number, hash, parent_hash, block_time) VALUES ($1, $2, $3, $3, $4)",
        )
        .bind(&self.reader)
        .bind(i64::try_from(head + 1).expect("block"))
        .bind(vec![9u8; 32])
        .bind(i64::try_from(time).expect("time"))
        .execute(self.state.db.pool())
        .await
        .expect("a later block");
    }
}

fn pay_to(wallet: &str) -> [&str; 2] {
    ["task-pay-to", wallet]
}

const NOT_A_PLANNED_WALLET: &str = "0x00000000000000000000000000000000000000cd";

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_take_before_the_reader_has_the_plan_goes_through_and_after_it_must_match_the_plan() {
    let w = world(true).await;
    let (before, planned) = (
        open_task(&w.founder, &w.coordinate, "Before the plan", "40"),
        open_task(&w.founder, &w.coordinate, "Planned", "40"),
    );
    w.accept(before.clone(), "the team posts a task").await;
    w.accept(planned.clone(), "the team posts a task").await;

    // The launch is read and the plan is not yet: lenient, whatever wallet is named.
    let (announce_block, ..) = w.book_row("TaskAnnounced", ANNOUNCED);
    w.seed("A", &[], 0, announce_block - 1).await;
    w.accept(
        step(
            &w.stranger,
            &w.coordinate,
            "take",
            &before,
            &[&pay_to(NOT_A_PLANNED_WALLET)],
        ),
        "a take before the plan",
    )
    .await;

    // The plan is read: the take must name the wallet the plan names.
    w.seed(
        "A",
        &[(ANNOUNCED, &planned)],
        announce_block,
        w.live_block(),
    )
    .await;
    let wallet = w.payee(ANNOUNCED);
    w.refuse(
        step(&w.stranger, &w.coordinate, "take", &planned, &[]),
        NAME_WALLET,
        "a take that names no wallet",
    )
    .await;
    w.refuse(
        step(
            &w.stranger,
            &w.coordinate,
            "take",
            &planned,
            &[&pay_to(NOT_A_PLANNED_WALLET)],
        ),
        OTHER_WALLET,
        "a take that names another wallet",
    )
    .await;
    w.accept(
        step(
            &w.stranger,
            &w.coordinate,
            "take",
            &planned,
            &[&pay_to(&wallet)],
        ),
        "a take that names the plan's wallet",
    )
    .await;
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_task_the_network_says_is_taken_by_another_wallet_or_paid_cannot_be_taken() {
    let w = world(true).await;
    let (taken, paid) = (
        open_task(&w.founder, &w.coordinate, "Taken", "40"),
        open_task(&w.founder, &w.coordinate, "Paid", "40"),
    );
    w.accept(taken.clone(), "the team posts a task").await;
    w.accept(paid.clone(), "the team posts a task").await;
    w.seed_run(&[(TAKEN, &taken), (PAID, &paid)]).await;

    w.refuse(
        step(
            &w.stranger,
            &w.coordinate,
            "take",
            &taken,
            &[&pay_to(NOT_A_PLANNED_WALLET)],
        ),
        TAKEN_ELSEWHERE,
        "taken on the network by another wallet",
    )
    .await;
    w.refuse(
        step(
            &w.stranger,
            &w.coordinate,
            "take",
            &paid,
            &[&pay_to(&w.payee(PAID))],
        ),
        PLAN_ENDED,
        "a plan that was paid",
    )
    .await;
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn an_accept_may_carry_a_pay_to_and_it_must_match_the_plan_and_no_other_step_may() {
    let w = world(true).await;
    let helper = &w.stranger;
    let named = named_task(&w.founder, &w.coordinate, "Named", helper);
    w.accept(named.clone(), "the team names a helper").await;
    w.seed_run(&[(ANNOUNCED, &named)]).await;
    let wallet = w.payee(ANNOUNCED);

    w.refuse(
        step(
            helper,
            &w.coordinate,
            "accept",
            &named,
            &[&pay_to(NOT_A_PLANNED_WALLET)],
        ),
        OTHER_WALLET,
        "an accept that names another wallet",
    )
    .await;
    // Any other step than a take or an accept keeps its old rule.
    w.refuse(
        step(
            helper,
            &w.coordinate,
            "evidence",
            &named,
            &[&pay_to(&wallet), &["note", "x"]],
        ),
        "belongs on another step",
        "a pay-to on a hand-in",
    )
    .await;
    w.accept(
        step(helper, &w.coordinate, "accept", &named, &[&pay_to(&wallet)]),
        "an accept that names the plan's wallet",
    )
    .await;
    // An accept that names no wallet is as it always was.
    let plain = named_task(&w.founder, &w.coordinate, "Plain", &w.other);
    w.accept(plain.clone(), "another named task").await;
    w.accept(
        step(&w.other, &w.coordinate, "accept", &plain, &[]),
        "an accept without a wallet",
    )
    .await;
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_confirm_for_a_planned_task_needs_the_network_payment() {
    let w = world(true).await;
    let (paid, taken, announced) = (
        open_task(&w.founder, &w.coordinate, "Paid", "40"),
        open_task(&w.founder, &w.coordinate, "Taken", "40"),
        open_task(&w.founder, &w.coordinate, "Announced", "40"),
    );
    for task in [&paid, &taken, &announced] {
        w.accept(task.clone(), "the team posts a task").await;
    }
    // The worker took the paid one before the reader had its plan (a lenient take), naming the wallet that was paid.
    w.accept(
        step(
            &w.stranger,
            &w.coordinate,
            "take",
            &paid,
            &[&pay_to(&w.taken_by(PAID))],
        ),
        "the worker takes it, naming their wallet",
    )
    .await;
    w.seed_run(&[(PAID, &paid), (TAKEN, &taken), (ANNOUNCED, &announced)])
        .await;
    let right = w.paid_tx(PAID);
    // Another task's payment: the run's sent-back task was never paid; its resolving transaction is not a payment.
    let (_, other_tx, _) = w.book_row("TaskResolved", SENT_BACK);
    let other = hex0x(&other_tx);

    w.refuse(
        step(&w.founder, &w.coordinate, "confirm", &paid, &[]),
        NOT_THAT_PAYMENT,
        "a confirm that names no payment",
    )
    .await;
    w.refuse(
        step(
            &w.founder,
            &w.coordinate,
            "confirm",
            &paid,
            &[&["task-paid", &other]],
        ),
        NOT_THAT_PAYMENT,
        "a confirm naming another task's payment",
    )
    .await;
    w.refuse(
        step(
            &w.founder,
            &w.coordinate,
            "confirm",
            &taken,
            &[&["task-paid", &right]],
        ),
        NOT_SEEN_YET,
        "a confirm while the network says taken",
    )
    .await;
    w.refuse(
        step(
            &w.founder,
            &w.coordinate,
            "confirm",
            &announced,
            &[&["task-paid", &right]],
        ),
        PAY_FIRST,
        "a confirm before anything was taken",
    )
    .await;
    w.accept(
        step(
            &w.founder,
            &w.coordinate,
            "confirm",
            &paid,
            &[&["task-paid", &right]],
        ),
        "a confirm naming the right payment",
    )
    .await;
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_cancel_is_refused_while_the_plan_is_announced_or_taken_and_accepted_after_the_network_withdrew_or_the_plan_is_past_its_end(
) {
    let w = world(true).await;
    let (announced, taken, withdrawn) = (
        open_task(&w.founder, &w.coordinate, "Announced", "40"),
        open_task(&w.founder, &w.coordinate, "Taken", "40"),
        open_task(&w.founder, &w.coordinate, "Withdrawn", "40"),
    );
    for task in [&announced, &taken, &withdrawn] {
        w.accept(task.clone(), "the team posts a task").await;
    }
    // The run to just before the network withdrew serial 9: it is announced.
    let (withdraw_block, ..) = w.book_row("TaskResolved", WITHDRAWN);
    let whats = [
        (ANNOUNCED, &announced),
        (TAKEN, &taken),
        (WITHDRAWN, &withdrawn),
    ];
    w.seed("A", &whats, 0, withdraw_block - 1).await;
    for (task, what) in [
        (&announced, "while the plan is announced"),
        (&taken, "while the plan is taken"),
        (&withdrawn, "before the network withdrew it"),
    ] {
        w.refuse(
            step(&w.founder, &w.coordinate, "cancel", task, &[]),
            WITHDRAW_FIRST,
            what,
        )
        .await;
    }

    // The network withdrew serial 9: its plan ended unpaid and binds nothing.
    w.seed("A", &whats, withdraw_block, w.live_block()).await;
    w.accept(
        step(&w.founder, &w.coordinate, "cancel", &withdrawn, &[]),
        "a cancel after the network withdrew the plan",
    )
    .await;
    w.refuse(
        step(&w.founder, &w.coordinate, "cancel", &announced, &[]),
        WITHDRAW_FIRST,
        "the others are still planned",
    )
    .await;

    // A plan nobody settled past its deadline counts as over: the reader has a later block than the deadline.
    let deadline: u64 = w.book_row("TaskTaken", TAKEN).2["deadline"]
        .as_str()
        .and_then(|s| s.parse().ok())
        .expect("a deadline");
    w.read_a_block_at(deadline).await;
    // The same moment ends the take of a plan that ran out, with words (and the cancel that follows is let through).
    w.refuse(
        step(
            &w.stranger,
            &w.coordinate,
            "take",
            &taken,
            &[&pay_to(&w.payee(TAKEN))],
        ),
        PLAN_ENDED,
        "a take of a plan past its end",
    )
    .await;
    w.accept(
        step(&w.founder, &w.coordinate, "cancel", &taken, &[]),
        "a cancel of a plan past its deadline",
    )
    .await;
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_task_with_no_plan_or_whose_plan_ended_unpaid_is_judged_as_in_step_1() {
    let w = world(true).await;
    let (none, sent_back, withdrawn) = (
        open_task(&w.founder, &w.coordinate, "Never planned", "40"),
        open_task(&w.founder, &w.coordinate, "Sent back", "40"),
        open_task(&w.founder, &w.coordinate, "Withdrawn", "40"),
    );
    for task in [&none, &sent_back, &withdrawn] {
        w.accept(task.clone(), "the team posts a task").await;
    }
    w.seed_run(&[(SENT_BACK, &sent_back), (WITHDRAWN, &withdrawn)])
        .await;
    let paid_elsewhere = w.paid_tx(PAID);

    // No plan: a confirm naming any payment, a take naming any wallet, a cancel.
    w.accept(
        step(
            &w.founder,
            &w.coordinate,
            "confirm",
            &none,
            &[&["task-paid", &paid_elsewhere]],
        ),
        "a confirm of a task with no plan",
    )
    .await;
    // Plans that ended unpaid bind nothing.
    w.accept(
        step(
            &w.stranger,
            &w.coordinate,
            "take",
            &sent_back,
            &[&pay_to(NOT_A_PLANNED_WALLET)],
        ),
        "a take of a plan that was sent back",
    )
    .await;
    w.accept(
        step(&w.founder, &w.coordinate, "cancel", &withdrawn, &[]),
        "a cancel of a plan that was withdrawn",
    )
    .await;
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn the_same_record_planned_twice_is_tied_to_its_lowest_serial_plan() {
    let w = world(true).await;
    // The run planned serial 2's record again as serial 8: both rows name this record.
    let again = open_task(&w.founder, &w.coordinate, "Planned twice", "40");
    w.accept(again.clone(), "the team posts a task").await;
    w.accept(
        step(
            &w.stranger,
            &w.coordinate,
            "take",
            &again,
            &[&pay_to(&w.taken_by(PAID))],
        ),
        "the worker takes it, naming their wallet",
    )
    .await;
    w.seed_run(&[(PAID, &again), (8, &again)]).await;
    // Serial 2 was paid: it binds, so its payment confirms and the later row does not.
    w.accept(
        step(
            &w.founder,
            &w.coordinate,
            "confirm",
            &again,
            &[&["task-paid", &w.paid_tx(PAID)]],
        ),
        "the payment of the plan that binds",
    )
    .await;
    // A worker who had not taken it yet is refused too: the record is planned and paid already.
    let w = world(true).await;
    let again = open_task(&w.founder, &w.coordinate, "Planned twice", "40");
    w.accept(again.clone(), "the team posts a task").await;
    w.seed_run(&[(PAID, &again), (8, &again)]).await;
    w.refuse(
        step(
            &w.stranger,
            &w.coordinate,
            "take",
            &again,
            &[&pay_to(&w.payee(PAID))],
        ),
        PLAN_ENDED,
        "the record is planned and paid already",
    )
    .await;
}

/// A worker's take of `task` naming `wallet`, accepted before the reader has the plan (a lenient take).
async fn worker_takes(w: &World, task: &Event, wallet: Option<&str>) {
    let extra: Vec<[&str; 2]> = wallet.map(pay_to).into_iter().collect();
    let extra: Vec<&[&str]> = extra.iter().map(|tag| tag.as_slice()).collect();
    w.accept(
        step(&w.stranger, &w.coordinate, "take", task, &extra),
        "the worker takes the task",
    )
    .await;
}

/// Review fix: the network paid the wallet that took the plan, and a `confirm` records that as the worker's pay only
/// when the worker named that very wallet under their own signature. A team that planned its own wallet as the
/// payee, took it and paid itself cannot record it as the named worker's paid task. With the check switched off the
/// two refusals below are accepted and this test fails.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_confirm_is_refused_when_the_network_paid_a_wallet_the_worker_never_named() {
    // (what the worker named, accepted?)
    for (named, accepted, what) in [
        (Some(NOT_A_PLANNED_WALLET), false, "another wallet"),
        (None, false, "no wallet"),
        (Some("taken-by"), true, "the wallet that was paid"),
    ] {
        let w = world(true).await;
        let task = open_task(&w.founder, &w.coordinate, "Paid", "40");
        w.accept(task.clone(), "the team posts a task").await;
        let wallet = w.taken_by(PAID);
        worker_takes(
            &w,
            &task,
            named.map(|n| if n == "taken-by" { wallet.as_str() } else { n }),
        )
        .await;
        w.seed_run(&[(PAID, &task)]).await;
        let confirm = step(
            &w.founder,
            &w.coordinate,
            "confirm",
            &task,
            &[&["task-paid", &w.paid_tx(PAID)]],
        );
        if accepted {
            w.accept(confirm, what).await;
        } else {
            w.refuse(confirm, PAID_ELSEWHERE, what).await;
        }
    }
}

/// Review fix: a plan that is past its end but that nobody has settled yet must not hide a live later plan of the
/// same record. The run's serial 6 (taken) is past its deadline at the reader's newest block while serial 7
/// (announced, same record here) is still live: every rule is held against serial 7. With the lowest-serial rule
/// judging only afterwards whether the plan is over, all four steps below were let through (or wrongly refused).
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_plan_past_its_end_that_nobody_settled_does_not_hide_a_live_repeat_of_the_same_record() {
    let w = world(true).await;
    let task = open_task(&w.founder, &w.coordinate, "Planned twice", "40");
    w.accept(task.clone(), "the team posts a task").await;
    w.seed_run(&[(TAKEN, &task), (ANNOUNCED, &task)]).await;
    let time = |event: &str, serial: u64, field: &str| -> u64 {
        w.book_row(event, serial).2[field]
            .as_str()
            .and_then(|s| s.parse().ok())
            .expect("a time")
    };
    let deadline = time("TaskTaken", TAKEN, "deadline");
    let ends = time("TaskAnnounced", ANNOUNCED, "expiresAt");
    assert!(
        deadline < ends,
        "the run must have serial 6 past its deadline while serial 7 still lives"
    );
    w.read_a_block_at(deadline).await;

    w.refuse(
        step(&w.stranger, &w.coordinate, "take", &task, &[]),
        NAME_WALLET,
        "a take that names no wallet is held to the live plan",
    )
    .await;
    w.refuse(
        step(
            &w.founder,
            &w.coordinate,
            "confirm",
            &task,
            &[&["task-paid", &w.paid_tx(PAID)]],
        ),
        PAY_FIRST,
        "a confirm while the live plan is announced and unpaid",
    )
    .await;
    w.refuse(
        step(&w.founder, &w.coordinate, "cancel", &task, &[]),
        WITHDRAW_FIRST,
        "a cancel while the live plan can still be taken",
    )
    .await;
    w.accept(
        step(
            &w.stranger,
            &w.coordinate,
            "take",
            &task,
            &[&pay_to(&w.payee(ANNOUNCED))],
        ),
        "a take of the live plan is not refused as ended",
    )
    .await;
}

/// A plan that ended unpaid binds nothing, and the plan read is the lowest-serial one that did not: the run's serial 3
/// was sent back and serial 7 is announced and live, both naming this record. The take is held to serial 7. With the
/// number of announced rows read cut to one, only serial 3 is seen, the lookup says "no plan" and the take passes.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_plan_that_ended_unpaid_is_followed_by_the_live_repeat_of_the_same_record() {
    let w = world(true).await;
    let task = open_task(
        &w.founder,
        &w.coordinate,
        "Sent back, then planned again",
        "40",
    );
    w.accept(task.clone(), "the team posts a task").await;
    w.seed_run(&[(SENT_BACK, &task), (ANNOUNCED, &task)]).await;
    w.refuse(
        step(&w.stranger, &w.coordinate, "take", &task, &[]),
        NAME_WALLET,
        "the live repeat binds",
    )
    .await;
    w.refuse(
        step(&w.founder, &w.coordinate, "cancel", &task, &[]),
        WITHDRAW_FIRST,
        "the live repeat holds the task on the network",
    )
    .await;
}

/// Review fix: a task record that was announced more often than the lookup reads (64 times, each costing the team
/// gas) is not guessed at. The old cut read the lowest 64 and, if all had ended, said "no plan" and switched every
/// rule off for a live 65th; now the lookup fails and the write is refused as a server fault.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_record_announced_more_often_than_the_lookup_reads_is_refused_not_guessed_at() {
    let w = world(true).await;
    let task = open_task(&w.founder, &w.coordinate, "Announced again and again", "40");
    w.accept(task.clone(), "the team posts a task").await;
    w.seed_run(&[(ANNOUNCED, &task)]).await;
    let key = w.fx.projects["A"].key;
    let what = hex0x(&task.id.to_bytes());
    // 64 more plans of the same record, all withdrawn: 65 rows name it.
    for i in 0..64u64 {
        let serial = 1_000 + i;
        for (block, event, decoded) in [
            (
                10_000 + 2 * i,
                "TaskAnnounced",
                json!({ "serial": serial.to_string(), "what": what, "payee": NOT_A_PLANNED_WALLET,
                        "expiresAt": "99999999999" }),
            ),
            (
                10_001 + 2 * i,
                "TaskResolved",
                json!({ "serial": serial.to_string(), "state": "6" }),
            ),
        ] {
            sqlx::query(
                "INSERT INTO chain_logs (reader, block_number, log_index, block_hash, tx_hash, address, role, \
                 project_key, event, topics, data, decoded) \
                 VALUES ($1, $2, 0, $3, $3, $4, 'tasks', $5, $6, '{}', $7, $8)",
            )
            .bind(&w.reader)
            .bind(i64::try_from(block).expect("block"))
            .bind(vec![1u8; 32])
            .bind(vec![2u8; 20])
            .bind(key.as_slice())
            .bind(event)
            .bind(Vec::<u8>::new())
            .bind(&decoded)
            .execute(w.state.db.pool())
            .await
            .expect("a row");
        }
    }
    w.refuse(
        step(&w.stranger, &w.coordinate, "take", &task, &[]),
        "internal:",
        "a record with more plans than are read is not guessed at",
    )
    .await;
}

/// The three reads of a plan are served by indexes, not by a scan of the project's whole book (which holds every note):
/// with sequential scans switched off and the general indexes out of the way, the planner can only answer them through
/// the partial indexes of migration 0072, and reads the newest block through its key.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn the_plan_reads_use_their_indexes_and_never_scan_every_block() {
    let w = world(true).await;
    let task = open_task(&w.founder, &w.coordinate, "Indexed", "40");
    w.seed_run(&[(ANNOUNCED, &task)]).await;
    let key = w.fx.projects["A"].key;
    let mut tx = w.state.db.pool().begin().await.expect("a transaction");
    // On a table this small the planner may prefer any index; leave it only the ones the reads are meant for (the drops
    // are rolled back with the transaction).
    for statement in [
        "SET LOCAL enable_seqscan = off",
        "DROP INDEX idx_chain_logs_project, idx_chain_logs_tasks",
    ] {
        sqlx::query(statement)
            .execute(&mut *tx)
            .await
            .expect("prepare the plan");
    }
    let explain = |sql: &str| format!("EXPLAIN {sql}");
    let announced: Vec<String> = sqlx::query_scalar(sqlx::AssertSqlSafe(explain(ANNOUNCED_SQL)))
        .bind(&w.reader)
        .bind(key.as_slice())
        .bind(format!("0x{}", hex::encode(task.id.to_bytes())))
        .bind(65i64)
        .fetch_all(&mut *tx)
        .await
        .expect("explain");
    let later: Vec<String> = sqlx::query_scalar(sqlx::AssertSqlSafe(explain(LATER_SQL)))
        .bind(&w.reader)
        .bind(key.as_slice())
        .bind(vec!["7".to_owned()])
        .fetch_all(&mut *tx)
        .await
        .expect("explain");
    let as_of: Vec<String> = sqlx::query_scalar(sqlx::AssertSqlSafe(explain(AS_OF_SQL)))
        .bind(&w.reader)
        .fetch_all(&mut *tx)
        .await
        .expect("explain");
    let (announced, later, as_of) = (announced.join("\n"), later.join("\n"), as_of.join("\n"));
    assert!(
        announced.contains("idx_chain_logs_task_what"),
        "the announced rows of a record use their index:\n{announced}"
    );
    assert!(
        later.contains("idx_chain_logs_task_serial"),
        "the takes and resolutions of a serial use their index:\n{later}"
    );
    assert!(
        as_of.contains("chain_blocks_pkey"),
        "the newest block is read through the primary key:\n{as_of}"
    );
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_confirm_before_the_reader_has_the_launch_is_refused_with_retry_and_the_rest_is_lenient()
{
    let w = world(true).await;
    let task = open_task(&w.founder, &w.coordinate, "Not read yet", "40");
    w.accept(task.clone(), "the team posts a task").await;
    // The reader has stored nothing of this project.
    w.refuse(
        step(
            &w.founder,
            &w.coordinate,
            "confirm",
            &task,
            &[&["task-paid", &w.paid_tx(PAID)]],
        ),
        NOT_SEEN_YET,
        "a confirm before the launch is read",
    )
    .await;
    w.accept(
        step(
            &w.stranger,
            &w.coordinate,
            "take",
            &task,
            &[&pay_to(NOT_A_PLANNED_WALLET)],
        ),
        "a take before the launch is read",
    )
    .await;
    w.accept(
        step(&w.founder, &w.coordinate, "cancel", &task, &[]),
        "a cancel before the launch is read",
    )
    .await;
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_plan_of_another_project_with_the_same_what_is_ignored() {
    // This project's record names the run's project B as its launch; the plan with this task's id is project A's.
    let w = world_for("B", true).await;
    let task = open_task(&w.founder, &w.coordinate, "Mine", "40");
    w.accept(task.clone(), "the team posts a task").await;
    w.seed("B", &[], 0, w.live_block()).await;
    w.seed("A", &[(ANNOUNCED, &task), (PAID, &task)], 0, w.live_block())
        .await;
    w.accept(
        step(
            &w.stranger,
            &w.coordinate,
            "take",
            &task,
            &[&pay_to(NOT_A_PLANNED_WALLET)],
        ),
        "a take with the same what under another project",
    )
    .await;
    w.accept(
        step(
            &w.founder,
            &w.coordinate,
            "confirm",
            &task,
            &[&["task-paid", &w.paid_tx(PAID)]],
        ),
        "a confirm with the same what under another project",
    )
    .await;
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_launch_made_for_another_record_is_ignored() {
    let w = world(true).await;
    let task = open_task(&w.founder, &w.coordinate, "Mine", "40");
    w.accept(task.clone(), "the team posts a task").await;
    w.seed_run(&[(ANNOUNCED, &task)]).await;
    // The launch the record names was made for somebody else's record.
    sqlx::query(
        "UPDATE chain_logs SET decoded = jsonb_set(decoded, '{projectId}', to_jsonb($2::text)) \
         WHERE reader = $1 AND role = 'launcher' AND event = 'ProjectLaunched'",
    )
    .bind(&w.reader)
    .bind(project_id("37001:somebody-else:orbit"))
    .execute(w.state.db.pool())
    .await
    .expect("another launch");
    w.accept(
        step(
            &w.stranger,
            &w.coordinate,
            "take",
            &task,
            &[&pay_to(NOT_A_PLANNED_WALLET)],
        ),
        "a take under a launch made for another record",
    )
    .await;
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_reader_that_cannot_be_read_refuses_the_write() {
    let w = world(true).await;
    let task = open_task(&w.founder, &w.coordinate, "Unreadable", "40");
    w.accept(task.clone(), "the team posts a task").await;
    w.seed_run(&[(ANNOUNCED, &task)]).await;
    // A stored row of the plan that does not read as its event says.
    sqlx::query(
        "UPDATE chain_logs SET decoded = jsonb_set(decoded, '{serial}', '\"x\"') \
         WHERE reader = $1 AND event = 'TaskAnnounced' AND decoded->>'serial' = '7'",
    )
    .bind(&w.reader)
    .execute(w.state.db.pool())
    .await
    .expect("a broken row");
    w.refuse(
        step(
            &w.stranger,
            &w.coordinate,
            "take",
            &task,
            &[&pay_to(NOT_A_PLANNED_WALLET)],
        ),
        "internal:",
        "a take while the plan cannot be read",
    )
    .await;
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn no_reader_leaves_step_1_behaviour_exactly() {
    let w = world(false).await;
    let task = open_task(&w.founder, &w.coordinate, "Step one", "40");
    w.accept(task.clone(), "the team posts a task").await;
    // Rows that would refuse everything are in the table, under a reader nobody configured.
    w.seed_run(&[(PAID, &task), (ANNOUNCED, &task), (TAKEN, &task)])
        .await;
    w.accept(
        step(
            &w.stranger,
            &w.coordinate,
            "take",
            &task,
            &[&pay_to(NOT_A_PLANNED_WALLET)],
        ),
        "a take with no reader",
    )
    .await;
    w.accept(
        step(&w.founder, &w.coordinate, "confirm", &task, &[]),
        "a confirm with no reader",
    )
    .await;
    // A team member may not take, as before.
    w.refuse(
        step(&w.mate, &w.coordinate, "take", &task, &[]),
        "a task open to anyone is taken by someone outside the team",
        "the old rules still hold",
    )
    .await;
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_task_record_dated_more_than_15_minutes_ahead_is_refused_with_words() {
    let w = world(true).await;
    let ahead = |secs: u64, what: &str| {
        let tags: [&[&str]; 7] = [
            &["a", &w.coordinate],
            &["l", "creaton-task"],
            &["task-part", "task"],
            &["task-what", what],
            &["task-done", "A map anyone can read"],
            &["task-size", "small"],
            &["task-usd", "40"],
        ];
        signed(&w.founder, KIND_LAUNCH_UPDATE, &tags, secs)
    };
    // The search for an earlier payment trusts a task record's time: a clock an hour ahead is refused.
    for (secs, what) in [(16 * 60, "sixteen minutes"), (3_600, "an hour")] {
        w.refuse(
            ahead(secs, what),
            "invalid: event timestamp too far from server time",
            what,
        )
        .await;
    }
    // Within the bound (a clock a little fast) it is stored.
    w.accept(ahead(14 * 60, "fourteen minutes"), "fourteen minutes ahead")
        .await;
}
