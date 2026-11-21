//! The network's helper limits tied to the server's labels (`chain_agent_link`), driven through the real `ingest_event`
//! seam. The wallets are the real run's accounts, linked the way the app links them (a kind 37017 record signed by the
//! wallet's own key); the helpers the network shows are `AgentSet` rows stored as the reader stores them. Switch a rule
//! off (return `Ok` from its `decide_*`) and the test that names it fails. Ignored without infrastructure; run with
//! `cargo test -p buzz-relay --lib -- chain_agent_link_postgres_tests --include-ignored --test-threads=1`.

use buzz_core::kind::{KIND_LAUNCH_UPDATE, KIND_PROFILE};
use k256::ecdsa::SigningKey;
use nostr::{Event, Keys};
use serde_json::json;

use super::chain_agent_link::{
    ABOVE_HELPER_LIMIT, MANAGER_HAS_LIMITS, TOO_MANY_WALLETS, UNLABELLED_HELPER,
};
use super::room_support::{anvil, binding, ingest, room_world, signed, tag, RoomWorld};

/// The run's account whose wallet the tests use as the helper wallet.
const HELPER_WALLET: usize = 5;

impl RoomWorld {
    /// Store an `AgentSet` row of the project's Treasury for the run's account `n`, at the place `at` (a block no real
    /// row has), switching it on with `usd_cap` raw dollars a day (or off with `active = false`).
    async fn agent_set(&self, project: [u8; 32], n: usize, active: bool, usd_cap: u128, at: i64) {
        let (_, wallet) = anvil(&self.fx, n);
        self.chain_row(
            project,
            "AgentSet",
            at,
            json!({ "agent": wallet, "active": active, "usdCap": usd_cap.to_string(), "shareCap": "0" }),
        )
        .await;
    }

    /// A change of runner of the project's Treasury at the place `at`: it switches every earlier helper off.
    async fn runner_changed(&self, project: [u8; 32], at: i64) {
        self.chain_row(
            project,
            "RunnerChanged",
            at,
            json!({ "by": "0x", "to": "0x" }),
        )
        .await;
    }

    async fn chain_row(&self, project: [u8; 32], event: &str, at: i64, decoded: serde_json::Value) {
        sqlx::query(
            "INSERT INTO chain_logs (reader, block_number, log_index, block_hash, tx_hash, address, role, \
             project_key, event, topics, data, decoded) \
             VALUES ($1, $2, 0, $3, $3, $4, 'treasury', $5, $6, ARRAY[]::bytea[], ''::bytea, $7)",
        )
        .bind(&self.reader)
        .bind(1_000_000 + at)
        .bind([3u8; 32].as_slice())
        .bind([4u8; 20].as_slice())
        .bind(project.as_slice())
        .bind(event)
        .bind(&decoded)
        .execute(self.state.db.pool())
        .await
        .expect("a row");
    }

    async fn accepts(&self, event: Event, what: &str) {
        if let Err(reason) = ingest(&self.state, &self.tenant, event).await {
            panic!("{what}: refused: {reason}");
        }
    }

    async fn refuses(&self, event: Event, expected: &str, what: &str) {
        match ingest(&self.state, &self.tenant, event).await {
            Ok(()) => panic!("{what}: should be refused"),
            Err(reason) => assert!(
                reason.contains(expected),
                "{what}: refused for the wrong reason: {reason}"
            ),
        }
    }

    /// A task open to anyone offering `usd` dollars, signed by `who`.
    fn open_task(&self, who: &Keys, what: &str, usd: &str) -> Event {
        signed(
            who,
            KIND_LAUNCH_UPDATE,
            &[
                tag(&["a", &self.coordinate]),
                tag(&["l", "creaton-task"]),
                tag(&["task-part", "task"]),
                tag(&["task-what", what]),
                tag(&["task-done", "A map anyone can read"]),
                tag(&["task-size", "small"]),
                tag(&["task-usd", usd]),
            ],
            "{}",
            0,
        )
    }
}

/// A binding that is withdrawn must be newer than the one it withdraws: records of one second are one record.
async fn pause_a_second() {
    tokio::time::sleep(std::time::Duration::from_millis(1_100)).await;
}

/// The profile of `account` as `buzz agents label` writes it, run by `operator`, as a manager when `manager`.
fn label(account: &Keys, operator: &Keys, manager: bool, ahead: u64) -> Event {
    let json =
        buzz_sdk::nip_oa::compute_auth_tag(operator, &account.public_key(), "").expect("sign");
    let auth: Vec<String> = serde_json::from_str(&json).expect("tag");
    let mut tags = vec![tag(&["agent", &account.public_key().to_hex()]), auth];
    if manager {
        tags.push(tag(&["agent-role", "manager"]));
    }
    signed(account, KIND_PROFILE, &tags, r#"{"name":"Helper"}"#, ahead)
}

/// Rule 1: a manager account is refused while a wallet it linked is a live helper on the network, and the refusal clears
/// when the wallet is unlinked, when the network switches the helper off, or when the runner changes.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_manager_with_a_live_helper_wallet_is_refused_until_it_unlinks_the_wallet() {
    let w = room_world(true).await;
    let (manager, operator) = (w.account().await, w.account().await);
    w.link(&manager, HELPER_WALLET, 3_600).await.expect("links");
    // No helper on the network yet: the label is let through.
    w.accepts(
        label(&manager, &operator, true, 0),
        "a manager before the wallet is a helper",
    )
    .await;
    w.agent_set(w.key, HELPER_WALLET, true, 40_000_000, 1).await;
    w.refuses(
        label(&manager, &operator, true, 2),
        MANAGER_HAS_LIMITS,
        "a manager whose wallet is a live helper",
    )
    .await;
    // The same refusal on another account, so a word that says how to clear it is the one it gets.
    assert!(MANAGER_HAS_LIMITS.contains("unlink that wallet"));
    pause_a_second().await;
    w.unlink(&manager, HELPER_WALLET).await.expect("unlinks");
    w.accepts(
        label(&manager, &operator, true, 4),
        "the manager after unlinking the wallet",
    )
    .await;
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_helper_the_network_has_switched_off_or_handed_over_is_not_live() {
    let w = room_world(true).await;
    let (manager, operator) = (w.account().await, w.account().await);
    w.link(&manager, HELPER_WALLET, 3_600).await.expect("links");
    w.agent_set(w.key, HELPER_WALLET, true, 40_000_000, 1).await;
    w.agent_set(w.key, HELPER_WALLET, false, 40_000_000, 2)
        .await;
    w.accepts(
        label(&manager, &operator, true, 0),
        "a helper the network switched off",
    )
    .await;
    // Switched on again, then the runner changes: every helper is off without an event of its own.
    let second = room_world(true).await;
    let (manager, operator) = (second.account().await, second.account().await);
    second
        .link(&manager, HELPER_WALLET, 3_600)
        .await
        .expect("links");
    second
        .agent_set(second.key, HELPER_WALLET, true, 40_000_000, 1)
        .await;
    second.runner_changed(second.key, 2).await;
    second
        .accepts(
            label(&manager, &operator, true, 0),
            "a helper from before the runner changed",
        )
        .await;
}

/// Rule 2: a task step by an account that is not labelled, whose linked wallet is a live helper of that project, is
/// refused until it is labelled or the wallet unlinked; a wallet it never linked is not looked at; a helper of another
/// project does not count.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn an_unlabelled_account_whose_wallet_is_a_helper_of_the_project_cannot_write_task_steps() {
    let w = room_world(true).await;
    w.link(&w.founder, HELPER_WALLET, 3_600)
        .await
        .expect("links");
    // Not a helper of any project yet.
    w.accepts(w.open_task(&w.founder, "first", "10"), "the founder's task")
        .await;
    w.agent_set(w.key, HELPER_WALLET, true, 40_000_000, 1).await;
    w.refuses(
        w.open_task(&w.founder, "second", "10"),
        UNLABELLED_HELPER,
        "the wallet is a helper of the project",
    )
    .await;
    // Unlinking the wallet clears it.
    pause_a_second().await;
    w.unlink(&w.founder, HELPER_WALLET).await.expect("unlinks");
    w.accepts(
        w.open_task(&w.founder, "third", "10"),
        "after unlinking the wallet",
    )
    .await;

    // A helper of another project is not this project's helper.
    let other = room_world(true).await;
    other
        .link(&other.founder, HELPER_WALLET, 3_600)
        .await
        .expect("links");
    let elsewhere = [9u8; 32];
    other
        .agent_set(elsewhere, HELPER_WALLET, true, 40_000_000, 1)
        .await;
    other
        .accepts(
            other.open_task(&other.founder, "fourth", "10"),
            "a helper of another project",
        )
        .await;
}

/// Rule 3: a helper-labelled account posting a task open to anyone is held to its wallet's daily limit.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_helper_posts_an_open_task_for_no_more_than_its_wallets_daily_limit() {
    let w = room_world(true).await;
    // The project's team member becomes a labelled helper (run by someone else) and links the helper wallet.
    let operator = w.account().await;
    w.accepts(
        label(&w.mate, &operator, false, 0),
        "the team member is labelled a helper",
    )
    .await;
    w.link(&w.mate, HELPER_WALLET, 3_600).await.expect("links");
    w.agent_set(w.key, HELPER_WALLET, true, 40_000_000, 1).await;
    w.accepts(
        w.open_task(&w.mate, "within", "40"),
        "a task for exactly the daily limit",
    )
    .await;
    w.refuses(
        w.open_task(&w.mate, "above", "41"),
        ABOVE_HELPER_LIMIT,
        "a task above the daily limit",
    )
    .await;
    // A task naming its helper offers no open money and is not held to the limit.
    pause_a_second().await;
    w.unlink(&w.mate, HELPER_WALLET).await.expect("unlinks");
    w.accepts(
        w.open_task(&w.mate, "after", "41"),
        "the same task after unlinking the wallet",
    )
    .await;
}

/// A throwaway wallet's key and address, made from a number (a key anyone could make: it holds nothing).
fn throwaway(n: u8) -> (SigningKey, String) {
    let key = SigningKey::from_slice(&[n; 32]).expect("a key");
    let address = buzz_evm_auth::EvmAddress::from_verifying_key(key.verifying_key()).to_hex();
    (key, address.to_lowercase())
}

impl RoomWorld {
    /// `who` links the throwaway wallet `n` (valid for an hour).
    async fn link_throwaway(&self, who: &Keys, n: u8) {
        let (key, address) = throwaway(n);
        let expires = nostr::Timestamp::now().as_secs() + 3_600;
        ingest(
            &self.state,
            &self.tenant,
            binding(&self.fx, who, &key, &address, expires, false),
        )
        .await
        .expect("links a throwaway wallet");
    }

    /// `who` links the helper wallet and then eight throwaway wallets whose addresses sort before it: the eight the
    /// rules used to look at, and nothing else.
    async fn pad_with_lower_wallets(&self, who: &Keys) {
        let (_, helper) = anvil(&self.fx, HELPER_WALLET);
        self.link(who, HELPER_WALLET, 3_600).await.expect("links");
        let lower: Vec<u8> = (1u8..=60)
            .filter(|n| throwaway(*n).1 < helper)
            .take(8)
            .collect();
        assert_eq!(
            lower.len(),
            8,
            "eight throwaway addresses sort below the helper wallet"
        );
        for n in lower {
            self.link_throwaway(who, n).await;
        }
    }
}

/// Review fix: an account cannot hide its helper wallet among eight throwaway wallets that sort before it. Every rule
/// asks about all the wallets the account has linked, not the first eight in address order. Cut the list back to eight
/// (`truncate(WALLETS_USED)` in `all_linked_wallets`) and the three refusals below are accepted.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_helper_wallet_cannot_be_hidden_among_eight_lower_throwaway_wallets() {
    // Rule 1: a manager's profile.
    let w = room_world(true).await;
    let (manager, operator) = (w.account().await, w.account().await);
    w.pad_with_lower_wallets(&manager).await;
    w.agent_set(w.key, HELPER_WALLET, true, 40_000_000, 1).await;
    w.refuses(
        label(&manager, &operator, true, 0),
        MANAGER_HAS_LIMITS,
        "a manager with the helper wallet behind eight others",
    )
    .await;

    // Rule 2: an unlabelled account's task step.
    let w = room_world(true).await;
    w.pad_with_lower_wallets(&w.founder).await;
    w.agent_set(w.key, HELPER_WALLET, true, 40_000_000, 1).await;
    w.refuses(
        w.open_task(&w.founder, "hidden", "10"),
        UNLABELLED_HELPER,
        "an unlabelled helper behind eight other wallets",
    )
    .await;

    // Rule 3: a labelled helper's open task above the limit.
    let w = room_world(true).await;
    let operator = w.account().await;
    w.accepts(
        label(&w.mate, &operator, false, 0),
        "the team member is labelled a helper",
    )
    .await;
    w.pad_with_lower_wallets(&w.mate).await;
    w.agent_set(w.key, HELPER_WALLET, true, 40_000_000, 1).await;
    w.refuses(
        w.open_task(&w.mate, "above", "41"),
        ABOVE_HELPER_LIMIT,
        "a task above the limit of a helper wallet behind eight others",
    )
    .await;
}

/// An account whose binding records were not all read (it links more wallets than one read holds) cannot be shown to
/// hold no live helper wallet: its manager profile and its task steps are refused, with the words that say what to do.
/// Treat an incomplete read as complete (`decide_complete` returning `Ok`) and both are accepted.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn an_account_with_more_wallet_records_than_one_read_holds_is_refused_not_trusted() {
    let w = room_world(true).await;
    let (manager, operator) = (w.account().await, w.account().await);
    for n in 1u8..=21 {
        w.link_throwaway(&manager, n).await;
    }
    w.refuses(
        label(&manager, &operator, true, 0),
        TOO_MANY_WALLETS,
        "a manager that links twenty-one wallets",
    )
    .await;
    // The same account writing a task step in the project (the founder here, who is the account that links them).
    let w = room_world(true).await;
    for n in 1u8..=21 {
        w.link_throwaway(&w.founder, n).await;
    }
    w.refuses(
        w.open_task(&w.founder, "padded", "10"),
        TOO_MANY_WALLETS,
        "a task step from an account that links twenty-one wallets",
    )
    .await;
}
