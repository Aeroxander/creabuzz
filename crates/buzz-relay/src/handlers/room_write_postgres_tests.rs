//! The holder room's write rule, driven through the real `ingest_event` seam with really signed records and the real
//! run of the contracts (`room_support`): who holds, who took out, who has a grant to claim, who linked a wallet, and
//! who the team has stopped. Removing a refusal of `room_write` fails the test that names it. Ignored without
//! infrastructure; run with
//! `cargo test -p buzz-relay --lib -- room_write_postgres_tests --include-ignored --test-threads=1`.

use std::sync::atomic::Ordering;

use nostr::Keys;
use serde_json::{json, Value};
use uuid::Uuid;

use super::room_support::{example_record, ingest, room_world, signed, tag, RoomWorld};
use super::room_write::{
    ACCOUNTS_PER_WALLET, EVENTS_PER_DAY, LINK_WALLET, MUTED, NOT_HOLDING, NO_PROJECT, NO_READER,
    OUTSIDE_THE_ROOM, POSTS_PER_HOUR, ROOM_MIN_SHARES, RULE_RUNS, TEXT_ONLY, TOO_FAST, TOO_LONG,
    TOO_MANY_ACCOUNTS,
};

// The accounts of the run (anvil's public test accounts) and what the run does with them in project A: account 3 backs
// at block 12 and still holds at the end; account 2 backs, takes out and backs again, and holds nothing at the end
// (its last decrease is at block 118); account 4 is sent Shares at block 67; account 1 is sent Team Shares at block
// 76; accounts 0, 6, 7, 8 and 9 hold nothing of project A.
const HOLDER: usize = 3;
const LEAVER: usize = 2;
const LATE: usize = 4;
const TEAM_HOLDER: usize = 1;
const NOBODY: usize = 0;
const OTHER_NOBODY: usize = 8;
/// The block at which `HOLDER` is sent its first Shares, and the block before it.
const HOLDER_JOINS: u64 = 12;
/// The block at which `LATE` is sent Shares.
const LATE_JOINS: u64 = 67;
/// The block of the leaver's last decrease.
const LEAVER_LAST_DECREASE: u64 = 118;

impl RoomWorld {
    async fn accept(&self, event: nostr::Event, what: &str) {
        if let Err(reason) = ingest(&self.state, &self.tenant, event).await {
            panic!("{what}: refused: {reason}");
        }
    }

    async fn refuse(&self, event: nostr::Event, expected: &str, what: &str) {
        match ingest(&self.state, &self.tenant, event).await {
            Ok(()) => panic!("{what}: should be refused"),
            Err(reason) => assert!(
                reason.contains(expected),
                "{what}: refused for the wrong reason: {reason}"
            ),
        }
    }

    /// A new account linked to the run's account `n`.
    async fn linked(&self, n: usize) -> Keys {
        let keys = self.account().await;
        self.link(&keys, n, 3_600).await.expect("the link");
        keys
    }

    /// Give the run's account `n` a balance of `amount` of `token` in project A (a row the run does not make).
    async fn set_balance(&self, n: usize, token: &str, amount: u128) {
        let (_, address) = super::room_support::anvil(&self.fx, n);
        let account = crate::chain_reader::word::parse_fixed::<20>(&address).expect("address");
        sqlx::query(
            "INSERT INTO chain_balances (reader, project_key, token, account, balance) VALUES ($1, $2, $3, $4, $5::numeric) \
             ON CONFLICT (reader, project_key, token, account) DO UPDATE SET balance = EXCLUDED.balance",
        )
        .bind(&self.reader)
        .bind(self.key.as_slice())
        .bind(token)
        .bind(account.as_slice())
        .bind(amount.to_string())
        .execute(self.state.db.pool())
        .await
        .expect("a balance");
    }

    /// The run's example numbers record (what the server's own builder made from the same run).
    async fn example_numbers(&self) -> Value {
        let record = example_record();
        self.numbers_record(&record).await;
        record
    }
}

fn grant_of(record: &Value, member: &str) -> usize {
    record["team"]["grants"]
        .as_array()
        .expect("grants")
        .iter()
        .position(|g| g["member"].as_str() == Some(member) && g["claimable"].as_str() != Some("0"))
        .expect("the example has a grant to claim for that member")
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_server_with_no_chain_reader_says_rooms_are_not_switched_on() {
    let w = room_world(false).await;
    let keys = w.account().await;
    w.refuse(w.post(&keys, "hello"), NO_READER, "no reader")
        .await;
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn r1_to_r3_a_stranger_a_wallet_with_nothing_and_a_holder() {
    let w = room_world(true).await;
    w.seed_to(w.fx.head()).await;
    // R1: no linked wallet.
    let nobody_linked = w.account().await;
    w.refuse(
        w.post(&nobody_linked, "hi"),
        LINK_WALLET,
        "no wallet linked",
    )
    .await;
    // R2: a linked wallet with no Shares.
    let empty = w.linked(NOBODY).await;
    w.refuse(w.post(&empty, "hi"), NOT_HOLDING, "a wallet with nothing")
        .await;
    // R3: a holder.
    let holder = w.linked(HOLDER).await;
    w.accept(w.post(&holder, "hi"), "a holder writes").await;
    // Another holder, who was sent Shares at the end of the run, writes too.
    let late = w.linked(LATE).await;
    w.accept(w.post(&late, "hi"), "a holder of sent Shares writes")
        .await;
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn the_floor_is_in_shares_for_both_tokens_one_wei_short_is_no_seat_and_the_floor_is() {
    let w = room_world(true).await;
    w.seed_to(w.fx.head()).await;
    for (token, n) in [("shares", NOBODY), ("team", OTHER_NOBODY)] {
        let keys = w.linked(n).await;
        w.set_balance(n, token, ROOM_MIN_SHARES - 1).await;
        w.refuse(
            w.post(&keys, "dust"),
            NOT_HOLDING,
            &format!("{token}: one wei short"),
        )
        .await;
        w.set_balance(n, token, ROOM_MIN_SHARES).await;
        w.accept(
            w.post(&keys, "at the floor"),
            &format!("{token}: at the floor"),
        )
        .await;
    }
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_team_share_holder_in_hand_writes() {
    let w = room_world(true).await;
    w.seed_to(w.fx.head()).await;
    let keys = w.linked(TEAM_HOLDER).await;
    w.accept(w.post(&keys, "from the team"), "a Team Share holder")
        .await;
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn r4_and_r5b_a_grant_counts_for_what_is_left_to_claim_and_not_for_what_vested() {
    let w = room_world(true).await;
    // Before account 4 is sent its Shares and account 1 its Team Shares: they hold nothing of project A.
    w.seed_to(LATE_JOINS - 1).await;
    let example = w.example_numbers().await;
    let (_, member4) = super::room_support::anvil(&w.fx, LATE);
    let keys = w.linked(LATE).await;
    let g = grant_of(&example, &member4);
    // R4: a grant with something left to claim is a seat.
    assert_ne!(example["team"]["grants"][g]["claimable"], json!("0"));
    w.accept(
        w.post(&keys, "I have Team Shares to claim"),
        "a grant to claim",
    )
    .await;

    // R5b: the same member after claiming everything (`vested` stays above zero, `claimable` is zero): no seat.
    let (_, member1) = super::room_support::anvil(&w.fx, TEAM_HOLDER);
    let g1 = grant_of(&example, &member1);
    let mut claimed_all = example.clone();
    let vested = claimed_all["team"]["grants"][g1]["vested"].clone();
    assert_ne!(vested, json!("0"), "the grant has vested");
    claimed_all["team"]["grants"][g1]["claimed"] = vested;
    claimed_all["team"]["grants"][g1]["claimable"] = json!("0");
    // A newer record replaces the earlier one.
    tokio::time::sleep(std::time::Duration::from_millis(1_100)).await;
    w.numbers_record(&claimed_all).await;
    let claimed = w.linked(TEAM_HOLDER).await;
    w.refuse(
        w.post(&claimed, "I claimed it all"),
        NOT_HOLDING,
        "a grant claimed in full leaves no seat",
    )
    .await;
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn r6_a_leaver_writes_for_one_unit_on_the_chains_clock_and_is_then_read_only() {
    let w = room_world(true).await;
    w.seed_to(w.fx.head()).await;
    let keys = w.linked(LEAVER).await;
    let left_at = w.time_of(LEAVER_LAST_DECREASE);
    // Inside the unit the person still writes.
    w.accept(w.post(&keys, "I took out"), "inside the unit")
        .await;
    // The chain's clock one second before the end of the unit: still writes; at the end of it: read only.
    w.read_a_block_at(left_at + w.unit() - 1).await;
    w.accept(
        w.post(&keys, "one second left"),
        "one second before the end",
    )
    .await;
    w.read_a_block_at(left_at + w.unit()).await;
    w.refuse(
        w.post(&keys, "too late"),
        NOT_HOLDING,
        "at the end of the unit",
    )
    .await;
    // The grace follows the chain's clock, not the server's: a clock that moves back lets them write again.
    w.read_a_block_at(left_at + 1).await;
    w.accept(
        w.post(&keys, "the chain's clock is back"),
        "a reader that lags",
    )
    .await;
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn r7_and_r8_a_back_not_stored_yet_waits_and_a_stale_reader_never_shuts_a_holder_out() {
    let w = room_world(true).await;
    w.seed_to(HOLDER_JOINS - 1).await;
    let keys = w.linked(HOLDER).await;
    w.refuse(
        w.post(&keys, "just backed"),
        "wait about a minute",
        "the Back is not stored yet",
    )
    .await;
    w.seed_to(HOLDER_JOINS).await;
    w.accept(w.post(&keys, "now stored"), "the reader stored the Back")
        .await;
    // The reader stopped a month ago: the holder in its rows still writes.
    let stopped = u64::try_from(chrono::Utc::now().timestamp()).expect("now") - 30 * 86_400;
    w.read_a_block_at(stopped).await;
    w.accept(
        w.post(&keys, "the reader lags"),
        "a holder in a lagging reader's rows",
    )
    .await;
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn r9_an_expired_attestation_and_a_withdrawn_link_are_not_wallets() {
    let w = room_world(true).await;
    w.seed_to(w.fx.head()).await;
    let expiring = w.account().await;
    w.link(&expiring, HOLDER, 1)
        .await
        .expect("a link that ends in a second");
    w.accept(
        w.post(&expiring, "while it lasts"),
        "inside the attestation",
    )
    .await;
    tokio::time::sleep(std::time::Duration::from_millis(2_200)).await;
    w.refuse(
        w.post(&expiring, "after"),
        LINK_WALLET,
        "an expired attestation",
    )
    .await;

    let withdrawn = w.linked(HOLDER).await;
    w.accept(w.post(&withdrawn, "linked"), "linked").await;
    tokio::time::sleep(std::time::Duration::from_millis(1_100)).await;
    w.unlink(&withdrawn, HOLDER).await.expect("withdrawn");
    w.refuse(
        w.post(&withdrawn, "unlinked"),
        LINK_WALLET,
        "a withdrawn link",
    )
    .await;
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn r10_the_room_must_be_the_projects_own_and_the_project_must_be_here() {
    let w = room_world(true).await;
    w.seed_to(w.fx.head()).await;
    let keys = w.linked(HOLDER).await;
    // A room of another project (project B's chain key) under this project's address.
    let other_key = format!("room:0x{}", hex::encode(w.fx.projects["B"].key));
    let wrong_room = signed(
        &keys,
        1,
        &[tag(&["a", &w.coordinate]), tag(&["t", &other_key])],
        "wrong room",
        0,
    );
    w.refuse(
        wrong_room,
        "names its project and its room",
        "another project's room tag",
    )
    .await;
    // An address of a project that is not here.
    let nowhere = format!("37001:{}:nowhere", w.founder.public_key().to_hex());
    let wrong_project = signed(
        &keys,
        1,
        &[tag(&["a", &nowhere]), tag(&["t", &w.room()])],
        "wrong project",
        0,
    );
    w.refuse(wrong_project, NO_PROJECT, "a project that is not here")
        .await;
    // No project address, two of them, no room tag.
    let none = signed(&keys, 1, &[tag(&["t", &w.room()])], "no project", 0);
    w.refuse(none, "names its project and its room", "no project address")
        .await;
    let two = signed(
        &keys,
        1,
        &[
            tag(&["a", &w.coordinate]),
            tag(&["a", &nowhere]),
            tag(&["t", &w.room()]),
        ],
        "two projects",
        0,
    );
    w.refuse(
        two,
        "names its project and its room",
        "two project addresses",
    )
    .await;
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn r11_the_room_is_text_only_and_bounded() {
    let w = room_world(true).await;
    w.seed_to(w.fx.head()).await;
    let keys = w.linked(HOLDER).await;
    for media in [
        tag(&["image", "https://example.com/a.png"]),
        tag(&["url", "https://example.com/a.png"]),
        tag(&["x", "abcd"]),
    ] {
        let post = signed(
            &keys,
            1,
            &[
                tag(&["a", &w.coordinate]),
                tag(&["t", &w.room()]),
                media.clone(),
            ],
            "with a picture",
            0,
        );
        w.refuse(post, TEXT_ONLY, &format!("{media:?}")).await;
    }
    w.refuse(
        w.post(&keys, &"a".repeat(2_001)),
        TOO_LONG,
        "a body over 2000 characters",
    )
    .await;
    w.accept(
        w.post(&keys, &"é".repeat(2_000)),
        "2000 characters of two bytes",
    )
    .await;
    // A link inside the text is only text.
    w.accept(
        w.post(&keys, "see https://example.com/map.png"),
        "a link in the words",
    )
    .await;
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn r12_r17_and_r24_whatever_answers_a_room_post_is_in_its_room_and_passes_its_rule() {
    let w = room_world(true).await;
    w.seed_to(w.fx.head()).await;
    let holder = w.linked(HOLDER).await;
    let stranger = w.account().await;
    let root = w.post(&holder, "the room's first post");
    w.accept(root.clone(), "a root").await;

    // R17: an untagged reply, like and repost by a stranger are room events and are refused.
    let untagged_reply = signed(
        &stranger,
        1,
        &[tag(&["e", &root.id.to_hex(), "", "root"])],
        "a reply with no room",
        0,
    );
    w.refuse(untagged_reply, OUTSIDE_THE_ROOM, "an untagged reply")
        .await;
    let untagged_like = signed(
        &stranger,
        7,
        &[
            tag(&["e", &root.id.to_hex()]),
            tag(&["p", &holder.public_key().to_hex()]),
        ],
        "+",
        0,
    );
    w.refuse(untagged_like, OUTSIDE_THE_ROOM, "an untagged like")
        .await;
    let untagged_repost = signed(&stranger, 6, &[tag(&["e", &root.id.to_hex()])], "", 0);
    w.refuse(untagged_repost, OUTSIDE_THE_ROOM, "an untagged repost")
        .await;
    // Even a holder's own untagged answer is not a way round the tags.
    let holders_untagged = signed(
        &holder,
        1,
        &[tag(&["e", &root.id.to_hex(), "", "reply"])],
        "x",
        0,
    );
    w.refuse(
        holders_untagged,
        OUTSIDE_THE_ROOM,
        "a holder's untagged reply",
    )
    .await;

    // R24: a tagged like by a stranger is judged like any room write.
    w.refuse(
        w.like(&stranger, &root),
        LINK_WALLET,
        "a stranger's tagged like",
    )
    .await;
    let empty = w.linked(NOBODY).await;
    w.refuse(
        w.like(&empty, &root),
        NOT_HOLDING,
        "a tagged like with nothing held",
    )
    .await;
    // A holder's tagged reply and like go in.
    w.accept(w.reply(&holder, &root, "a reply"), "a holder's reply")
        .await;
    w.accept(w.like(&holder, &root), "a holder's like").await;

    // R12: a reply whose parent is an ordinary post, or no stored post at all, is not in this room.
    let ordinary = signed(&holder, 1, &[], "an ordinary post elsewhere", 0);
    w.accept(ordinary.clone(), "an ordinary post").await;
    let into_ordinary = signed(
        &holder,
        1,
        &[
            tag(&["a", &w.coordinate]),
            tag(&["t", &w.room()]),
            tag(&["e", &ordinary.id.to_hex(), "", "root"]),
        ],
        "a room reply to a post outside it",
        0,
    );
    w.refuse(
        into_ordinary,
        OUTSIDE_THE_ROOM,
        "a reply to an ordinary post",
    )
    .await;
    let nowhere = signed(
        &holder,
        1,
        &[
            tag(&["a", &w.coordinate]),
            tag(&["t", &w.room()]),
            tag(&["e", &hex::encode([0x42u8; 32]), "", "root"]),
        ],
        "a reply to nothing",
        0,
    );
    w.refuse(
        nowhere,
        OUTSIDE_THE_ROOM,
        "a reply to a post that is not stored",
    )
    .await;
    // A reply that carries one room's tag but names a post of another is refused too.
    let other_room = format!("room:0x{}", hex::encode(w.fx.projects["B"].key));
    let crossed = signed(
        &holder,
        1,
        &[
            tag(&["a", &w.coordinate]),
            tag(&["t", &other_room]),
            tag(&["e", &root.id.to_hex(), "", "root"]),
        ],
        "crossed",
        0,
    );
    w.refuse(crossed, OUTSIDE_THE_ROOM, "another room's tag on a reply")
        .await;
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn r17_an_ordinary_post_never_reaches_the_rule() {
    let w = room_world(true).await;
    let keys = w.account().await;
    let before = RULE_RUNS.load(Ordering::SeqCst);
    let plain = signed(&keys, 1, &[], "an ordinary post", 0);
    w.accept(plain.clone(), "an ordinary post").await;
    let reply = signed(
        &keys,
        1,
        &[tag(&["e", &plain.id.to_hex(), "", "reply"])],
        "its reply",
        0,
    );
    w.accept(reply, "an ordinary reply").await;
    let like = signed(
        &keys,
        7,
        &[
            tag(&["e", &plain.id.to_hex()]),
            tag(&["p", &keys.public_key().to_hex()]),
        ],
        "+",
        0,
    );
    w.accept(like, "an ordinary like").await;
    assert_eq!(
        RULE_RUNS.load(Ordering::SeqCst),
        before,
        "no ordinary post ran the room rule"
    );
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn r13_the_hourly_limit_of_posts_and_the_daily_limit_of_events() {
    let w = room_world(true).await;
    w.seed_to(w.fx.head()).await;
    let keys = w.linked(HOLDER).await;
    for n in 0..POSTS_PER_HOUR {
        w.accept(
            w.post(&keys, &format!("post {n}")),
            "inside the hour's limit",
        )
        .await;
    }
    w.refuse(
        w.post(&keys, "one too many"),
        TOO_FAST,
        "the 13th post in an hour",
    )
    .await;

    // The day's limit counts every room event (posts and likes), made here as the rows the server has stored.
    let busy = w.linked(LATE).await;
    let author = busy.public_key().to_bytes();
    let made = EVENTS_PER_DAY - 1;
    sqlx::query(
        "INSERT INTO events (community_id, id, pubkey, created_at, kind, tags, content, sig) \
         SELECT $1, sha256(($2 || g::text)::bytea), $3, now(), 7, $4::jsonb, '+', decode(repeat('00', 64), 'hex') \
         FROM generate_series(1, $5) g",
    )
    .bind(w.tenant.community().as_uuid())
    .bind(Uuid::new_v4().to_string())
    .bind(author.as_slice())
    .bind(json!([["a", w.coordinate], ["t", w.room()]]).to_string())
    .bind(made)
    .execute(w.state.db.pool())
    .await
    .expect("filler events");
    w.accept(
        w.post(&busy, "the last of the day"),
        "the 60th event of the day",
    )
    .await;
    w.refuse(
        w.post(&busy, "over the day"),
        TOO_FAST,
        "the 61st event of the day",
    )
    .await;
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn r14_at_most_five_accounts_write_through_one_wallet() {
    let w = room_world(true).await;
    w.seed_to(w.fx.head()).await;
    let mut accounts = Vec::new();
    for _ in 0..ACCOUNTS_PER_WALLET {
        accounts.push(w.linked(HOLDER).await);
    }
    for (n, keys) in accounts.iter().enumerate() {
        w.accept(w.post(keys, &format!("account {n}")), "one of five")
            .await;
    }
    // A sixth account proves the same wallet: nobody writes through it any more.
    let sixth = w.linked(HOLDER).await;
    w.refuse(
        w.post(&sixth, "the sixth"),
        TOO_MANY_ACCOUNTS,
        "the sixth account",
    )
    .await;
    w.refuse(
        w.post(&accounts[0], "the first again"),
        TOO_MANY_ACCOUNTS,
        "the wallet is over its cap",
    )
    .await;
    // A person who holds with another wallet is not stopped by it.
    let other = w.linked(LATE).await;
    w.accept(w.post(&other, "another wallet"), "an unrelated wallet")
        .await;
}

fn mute(
    w: &RoomWorld,
    who: &Keys,
    person: &Keys,
    wallets: &[usize],
    until: u64,
    ahead: u64,
) -> nostr::Event {
    let mut tags = vec![
        tag(&["a", &w.coordinate]),
        tag(&["room-mute", &person.public_key().to_hex()]),
        tag(&["expiration", &until.to_string()]),
    ];
    for n in wallets {
        let (_, address) = super::room_support::anvil(&w.fx, *n);
        tags.push(tag(&["room-mute-wallet", &address]));
    }
    signed(who, 47003, &tags, "{}", ahead)
}

fn now() -> u64 {
    u64::try_from(chrono::Utc::now().timestamp()).expect("now")
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn r15_and_r25_a_team_mute_holds_until_it_ends_follows_the_wallet_and_can_be_lifted() {
    let w = room_world(true).await;
    w.seed_to(w.fx.head()).await;
    let muted = w.linked(HOLDER).await;
    w.accept(w.post(&muted, "before the mute"), "before").await;
    let wallet_owner_other = w.linked(LATE).await;

    // The founder stops the person for a day, naming the wallet they had linked.
    w.accept(
        mute(&w, &w.founder, &muted, &[HOLDER], now() + 86_400, 0),
        "the founder's mute",
    )
    .await;
    w.refuse(w.post(&muted, "during"), MUTED, "the muted person")
        .await;
    // R25: a new account that proves the same wallet is stopped too; one with another wallet is not.
    let again = w.linked(HOLDER).await;
    w.refuse(
        w.post(&again, "a new key, the same wallet"),
        MUTED,
        "the same wallet",
    )
    .await;
    w.accept(
        w.post(&wallet_owner_other, "someone else"),
        "an unrelated wallet",
    )
    .await;
    // The mute does not touch what is not a write: the person still reads and may take their money out (nothing here).

    // A newer record with an end in the past lifts it.
    w.accept(
        mute(&w, &w.mate, &muted, &[HOLDER], now() - 1, 3),
        "a team member lifts the mute",
    )
    .await;
    w.accept(w.post(&muted, "after the lift"), "after it is lifted")
        .await;
    w.accept(
        w.post(&again, "the new key too"),
        "the wallet is free again",
    )
    .await;

    // A mute ends by itself.
    let short = w.linked(LATE).await;
    w.accept(
        mute(&w, &w.founder, &short, &[LATE], now() + 2, 6),
        "a mute of two seconds",
    )
    .await;
    w.refuse(w.post(&short, "stopped"), MUTED, "inside the mute")
        .await;
    tokio::time::sleep(std::time::Duration::from_millis(2_400)).await;
    w.accept(w.post(&short, "free"), "after its end").await;
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_mute_is_the_teams_alone_and_never_of_the_founder_a_server_operator_itself_or_over_30_days(
) {
    let w = room_world(true).await;
    let stranger = w.account().await;
    let person = w.account().await;
    // A person who is not on the team cannot stop anyone.
    w.refuse(
        mute(&w, &stranger, &person, &[], now() + 60, 0),
        "only this project's team",
        "a stranger's mute",
    )
    .await;
    // The team cannot stop the founder, or itself.
    w.refuse(
        mute(&w, &w.mate, &w.founder, &[], now() + 60, 0),
        "cannot be stopped",
        "a mute of the founder",
    )
    .await;
    w.refuse(
        mute(&w, &w.mate, &w.mate, &[], now() + 60, 0),
        "cannot be stopped",
        "a mute of oneself",
    )
    .await;
    // Not for longer than 30 days; not an end that is not a number; not nine wallets.
    w.refuse(
        mute(&w, &w.founder, &person, &[], now() + 31 * 86_400, 0),
        "within 30 days",
        "a mute of 31 days",
    )
    .await;
    w.accept(
        mute(&w, &w.founder, &person, &[], now() + 30 * 86_400 - 5, 0),
        "a mute of 30 days",
    )
    .await;
    let nine: Vec<usize> = vec![0, 1, 2, 3, 4, 5, 6, 7, 8];
    w.refuse(
        mute(&w, &w.founder, &person, &nine, now() + 60, 2),
        "within 30 days",
        "nine wallets",
    )
    .await;
    let not_a_number = signed(
        &w.founder,
        47003,
        &[
            tag(&["a", &w.coordinate]),
            tag(&["room-mute", &person.public_key().to_hex()]),
            tag(&["expiration", "soon"]),
        ],
        "{}",
        0,
    );
    w.refuse(
        not_a_number,
        "within 30 days",
        "an end that is not a number",
    )
    .await;
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_team_cannot_stop_a_server_operator() {
    let operator = Keys::generate();
    let operator_hex = operator.public_key().to_hex();
    let w = super::room_support::room_world_with(true, |c| {
        c.relay_operator_pubkeys = vec![operator_hex];
    })
    .await;
    w.refuse(
        mute(&w, &w.founder, &operator, &[], now() + 60, 0),
        "cannot be stopped",
        "a mute of an operator",
    )
    .await;
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn r21_a_lookup_that_fails_refuses_the_write_and_never_lets_it_pass() {
    let w = room_world(true).await;
    w.seed_to(w.fx.head()).await;
    let keys = w.linked(HOLDER).await;
    let post = w.post(&keys, "while the database is down");
    // The same post goes in while the database answers.
    w.accept(post.clone(), "the database answers").await;
    // With the database gone the rule refuses as a server fault: it is neither a pass nor a "not holding".
    w.state.db.pool().close().await;
    let again = w.post(&keys, "after the database went");
    let result = super::room_write::enforce(&w.state, &w.tenant, &again).await;
    assert!(
        matches!(result, Err(super::ingest::IngestError::Internal(_))),
        "a failed lookup refuses the write as a fault: {result:?}"
    );
}
