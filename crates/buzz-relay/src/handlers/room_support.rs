//! Test support for the holder room, the seasons and the team's tools: one community, one project whose chain rows are
//! the real run of the contracts (`chain_reader/testdata/pot-run.json`, project A), and accounts bound to the run's
//! own wallets (anvil's public test accounts, whose keys are public).
//!
//! No number is typed here. The rows come from the run: the blocks, the project's launch (with its `projectId` pointed
//! at the test's own project record, because a real launch names the hash of the record's address), and every Share
//! and Team Share `Transfer` of project A, stored the way the reader stores them (`chain_balance_changes` and
//! `chain_balances`). Nothing is stored before a test asks for a block: `seed_to(n)` stores the run up to block `n`.

use std::sync::Arc;

use buzz_auth::Scope;
use buzz_core::kind::{KIND_EVM_BINDING, KIND_LAUNCH_RECORD};
use buzz_core::tenant::TenantContext;
use k256::ecdsa::SigningKey;
use nostr::{Event, EventBuilder, Keys, Kind, Tag, Timestamp};
use serde_json::{json, Value};
use uuid::Uuid;

use super::ingest::{ingest_event, IngestAuth, IngestError};
use crate::api::manager::cost::project_id;
use crate::chain_reader::events::Role;
use crate::chain_reader::fixture::Fixture;
use crate::chain_reader::word::hex0x;
use crate::state::AppState;

/// Anvil's ten public test accounts' private keys, in account order (the run's `account0` to `account9`). They are
/// public test keys of the local test chain.
const ANVIL_KEYS: [&str; 10] = [
    "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    "5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
    "7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
    "47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
    "8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
    "92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
    "4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
    "dbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
    "2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
];

/// The chain of the run (the reader the tests configure is about it).
pub(crate) const CHAIN_ID: u64 = 31_337;

/// The run's account `n` (0 to 9) as a wallet: its signing key and its lower-case address, checked against the run's
/// own list so a mistyped key cannot pass.
pub(crate) fn anvil(fx: &Fixture, n: usize) -> (SigningKey, String) {
    let key = SigningKey::from_slice(&hex::decode(ANVIL_KEYS[n]).expect("hex")).expect("a key");
    let address = buzz_evm_auth::EvmAddress::from_verifying_key(key.verifying_key()).to_hex();
    let expected = fx.json["accounts"][format!("account{n}")]
        .as_str()
        .expect("the run names its accounts")
        .to_lowercase();
    assert_eq!(address.to_lowercase(), expected, "anvil account {n}");
    (key, expected)
}

/// A reader configuration of this test's own (its Launcher is random), so the rows it reads are the only rows there are.
fn reader_config() -> crate::chain_reader::ChainReaderConfig {
    let mut launcher = [0u8; 20];
    launcher.copy_from_slice(&Uuid::new_v4().as_bytes()[..16].repeat(2)[..20]);
    crate::chain_reader::ChainReaderConfig {
        rpc_url: "http://127.0.0.1:1".into(),
        chain_id: CHAIN_ID,
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

/// A community, a project and a chain reader's rows.
pub(crate) struct RoomWorld {
    pub(crate) state: Arc<AppState>,
    pub(crate) tenant: TenantContext,
    pub(crate) founder: Keys,
    /// On the project's team (`team` tag of the project record).
    pub(crate) mate: Keys,
    pub(crate) fx: Fixture,
    /// The name the reader's rows are kept under.
    pub(crate) reader: String,
    /// The project's coordinate and its chain key.
    pub(crate) coordinate: String,
    pub(crate) key: [u8; 32],
    /// How many other projects `extra_project` has made (their launch rows take the next log indexes).
    extra: std::sync::atomic::AtomicU32,
}

/// Ingest as the signer, with the scopes a signed-in app has. `Ok` for an accepted event, the server's sentence for
/// a refused one.
pub(crate) async fn ingest(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    event: Event,
) -> Result<(), String> {
    let auth = IngestAuth::Nip42 {
        pubkey: event.pubkey,
        scopes: Scope::all_known(),
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

/// Sign `kind` with `tags` and `content` at `ahead` seconds after now.
pub(crate) fn signed(
    keys: &Keys,
    kind: u32,
    tags: &[Vec<String>],
    content: &str,
    ahead: u64,
) -> Event {
    let tags: Vec<Tag> = tags
        .iter()
        .map(|fields| Tag::parse(fields.clone()).expect("tag"))
        .collect();
    EventBuilder::new(Kind::Custom(kind as u16), content)
        .tags(tags)
        .allow_self_tagging()
        .custom_created_at(Timestamp::from(Timestamp::now().as_secs() + ahead))
        .sign_with_keys(keys)
        .expect("sign")
}

/// A tag from strings.
pub(crate) fn tag(fields: &[&str]) -> Vec<String> {
    fields.iter().map(|s| (*s).to_owned()).collect()
}

/// A community with no chain reader (for the refusal of a server that has none) or with this test's own reader.
pub(crate) async fn room_world(with_reader: bool) -> RoomWorld {
    room_world_with(with_reader, |_| {}).await
}

/// [`room_world`] with a hook that adjusts the server's configuration (for instance who its operators are).
pub(crate) async fn room_world_with(
    with_reader: bool,
    configure: impl FnOnce(&mut crate::config::Config),
) -> RoomWorld {
    let fx = Fixture::load();
    let config = reader_config();
    let reader = config.reader_id();
    let state = crate::test_support::test_state_with(|c| {
        c.new_account_posts_per_hour = 0;
        c.new_account_project_records_per_day = 0;
        if with_reader {
            c.chain_reader = Some(config);
        }
        configure(c);
    })
    .await;
    let host = format!("room-{}.example", Uuid::new_v4().simple());
    let community = state
        .db
        .ensure_configured_community(&host)
        .await
        .expect("community")
        .id;
    let tenant = TenantContext::resolved(community, host);
    let (founder, mate) = (Keys::generate(), Keys::generate());
    for keys in [&founder, &mate] {
        add_member(&state, &tenant, keys).await;
    }
    let key = fx.projects["A"].key;
    let d = "orbit";
    let mate_hex = mate.public_key().to_hex();
    ingest(
        &state,
        &tenant,
        signed(
            &founder,
            KIND_LAUNCH_RECORD,
            &[
                tag(&["d", d]),
                tag(&["name", "Orbit"]),
                tag(&["team", &mate_hex, "engineer"]),
                tag(&["chain-key", &hex0x(&key)]),
            ],
            "{}",
            0,
        ),
    )
    .await
    .expect("the project record");
    let coordinate = format!("37001:{}:{d}", founder.public_key().to_hex());
    RoomWorld {
        state,
        tenant,
        founder,
        mate,
        fx,
        reader,
        coordinate,
        key,
        extra: std::sync::atomic::AtomicU32::new(0),
    }
}

/// A new account on the community's member list.
pub(crate) async fn add_member(state: &Arc<AppState>, tenant: &TenantContext, keys: &Keys) {
    state
        .db
        .add_relay_member(
            tenant.community(),
            &keys.public_key().to_hex(),
            "member",
            None,
        )
        .await
        .expect("member");
}

impl RoomWorld {
    /// A new account (a member of the community).
    pub(crate) async fn account(&self) -> Keys {
        let keys = Keys::generate();
        add_member(&self.state, &self.tenant, &keys).await;
        keys
    }

    /// The room tag of this project.
    pub(crate) fn room(&self) -> String {
        format!("room:{}", hex0x(&self.key))
    }

    /// Store the run up to and including block `to`: the blocks (all of them up to `to`), the project's launch (once),
    /// and the Share and Team Share transfers of project A with the balances they make, as the reader stores them.
    /// Already stored blocks and rows are left alone, so a test seeds in steps.
    pub(crate) async fn seed_to(&self, to: u64) {
        let pool = self.state.db.pool();
        for block in self.fx.blocks.iter().filter(|b| b.number <= to) {
            sqlx::query(
                "INSERT INTO chain_blocks (reader, number, hash, parent_hash, block_time) VALUES ($1, $2, $3, $4, $5) \
                 ON CONFLICT DO NOTHING",
            )
            .bind(&self.reader)
            .bind(i64::try_from(block.number).expect("block"))
            .bind(block.hash.as_slice())
            .bind(block.parent.as_slice())
            .bind(i64::try_from(block.time).expect("time"))
            .execute(pool)
            .await
            .expect("block");
        }
        for (role, project, row) in self.fx.decoded() {
            if row.block > to {
                continue;
            }
            let key = self.fx.projects["A"].key;
            let launch = role == Role::Launcher
                && row.event == "ProjectLaunched"
                && project.as_deref() == Some("A");
            let transfer = matches!(role, Role::Shares | Role::Team)
                && row.event == "Transfer"
                && project.as_deref() == Some("A");
            if !launch && !transfer {
                continue;
            }
            let mut decoded = row.fields.clone();
            if launch {
                decoded["projectId"] = json!(project_id(&self.coordinate));
            }
            if launch {
                sqlx::query(
                    "INSERT INTO chain_logs (reader, block_number, log_index, block_hash, tx_hash, address, role, \
                     project_key, event, topics, data, decoded) \
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT DO NOTHING",
                )
                .bind(&self.reader)
                .bind(i64::try_from(row.block).expect("block"))
                .bind(i32::try_from(row.log_index).expect("index"))
                .bind(self.fx.blocks[usize::try_from(row.block).expect("block")].hash.as_slice())
                .bind(row.tx.as_slice())
                .bind(row.address.as_slice())
                .bind(role.as_str())
                .bind(key.as_slice())
                .bind(&row.event)
                .bind(Vec::<Vec<u8>>::new())
                .bind(Vec::<u8>::new())
                .bind(&decoded)
                .execute(pool)
                .await
                .expect("log");
                continue;
            }
            let address = |name: &str| {
                decoded[name]
                    .as_str()
                    .and_then(crate::chain_reader::word::parse_fixed::<20>)
                    .expect("a transfer names its accounts")
            };
            let (from, to_account) = (address("from"), address("to"));
            let value = decoded["value"].as_str().expect("an amount").to_owned();
            let token = role.as_str();
            let mut moves: Vec<([u8; 20], String)> = Vec::new();
            if from != to_account {
                if from != [0u8; 20] {
                    moves.push((from, format!("-{value}")));
                }
                if to_account != [0u8; 20] {
                    moves.push((to_account, value));
                }
            }
            for (account, delta) in moves {
                let stored = sqlx::query(
                    "INSERT INTO chain_balance_changes (reader, block_number, log_index, account, project_key, token, delta) \
                     VALUES ($1, $2, $3, $4, $5, $6, $7::numeric) ON CONFLICT DO NOTHING",
                )
                .bind(&self.reader)
                .bind(i64::try_from(row.block).expect("block"))
                .bind(i32::try_from(row.log_index).expect("index"))
                .bind(account.as_slice())
                .bind(key.as_slice())
                .bind(token)
                .bind(&delta)
                .execute(pool)
                .await
                .expect("change")
                .rows_affected();
                // A change stored in an earlier step is not applied twice.
                if stored == 0 {
                    continue;
                }
                sqlx::query(
                    "INSERT INTO chain_balances (reader, project_key, token, account, balance) \
                     VALUES ($1, $2, $3, $4, $5::numeric) \
                     ON CONFLICT (reader, project_key, token, account) \
                     DO UPDATE SET balance = chain_balances.balance + EXCLUDED.balance",
                )
                .bind(&self.reader)
                .bind(key.as_slice())
                .bind(token)
                .bind(account.as_slice())
                .bind(&delta)
                .execute(pool)
                .await
                .expect("balance");
            }
        }
    }

    /// The time of the run's block `n`.
    pub(crate) fn time_of(&self, n: u64) -> u64 {
        self.fx.time_of(n)
    }

    /// The project's time unit in seconds, as the run says.
    pub(crate) fn unit(&self) -> u64 {
        self.fx.json["unit"]
            .as_u64()
            .expect("the run records its unit")
    }

    /// Add a block the reader has read after the run's newest, at `time` (a later chain clock).
    pub(crate) async fn read_a_block_at(&self, time: u64) {
        let head = self.fx.head();
        sqlx::query(
            "INSERT INTO chain_blocks (reader, number, hash, parent_hash, block_time) VALUES ($1, $2, $3, $3, $4) \
             ON CONFLICT (reader, number) DO UPDATE SET block_time = EXCLUDED.block_time",
        )
        .bind(&self.reader)
        .bind(i64::try_from(head + 1).expect("block"))
        .bind(vec![9u8; 32])
        .bind(i64::try_from(time).expect("time"))
        .execute(self.state.db.pool())
        .await
        .expect("a later block");
    }

    /// Link `who`'s account to the run's account `n` (kind 37017, signed by the wallet's own key as the app does),
    /// valid for `valid_secs` from now, on the reader's chain.
    pub(crate) async fn link(&self, who: &Keys, n: usize, valid_secs: u64) -> Result<(), String> {
        let (key, address) = anvil(&self.fx, n);
        let expires = Timestamp::now().as_secs() + valid_secs;
        ingest(
            &self.state,
            &self.tenant,
            binding(&self.fx, who, &key, &address, expires, false),
        )
        .await
    }

    /// Withdraw `who`'s link to the run's account `n`.
    pub(crate) async fn unlink(&self, who: &Keys, n: usize) -> Result<(), String> {
        let (key, address) = anvil(&self.fx, n);
        let expires = Timestamp::now().as_secs() + 60;
        ingest(
            &self.state,
            &self.tenant,
            binding(&self.fx, who, &key, &address, expires, true),
        )
        .await
    }

    /// A kind 1 room post by `who`.
    pub(crate) fn post(&self, who: &Keys, content: &str) -> Event {
        signed(
            who,
            1,
            &[tag(&["a", &self.coordinate]), tag(&["t", &self.room()])],
            content,
            0,
        )
    }

    /// A reply to `parent` that carries the room's own tags.
    pub(crate) fn reply(&self, who: &Keys, parent: &Event, content: &str) -> Event {
        signed(
            who,
            1,
            &[
                tag(&["a", &self.coordinate]),
                tag(&["t", &self.room()]),
                tag(&["e", &parent.id.to_hex(), "", "root"]),
                tag(&["e", &parent.id.to_hex(), "", "reply"]),
            ],
            content,
            0,
        )
    }

    /// A like (kind 7) of `target` that carries the room's own tags.
    pub(crate) fn like(&self, who: &Keys, target: &Event) -> Event {
        signed(
            who,
            7,
            &[
                tag(&["a", &self.coordinate]),
                tag(&["t", &self.room()]),
                tag(&["e", &target.id.to_hex()]),
                tag(&["p", &target.pubkey.to_hex()]),
                tag(&["k", "1"]),
            ],
            "+",
            0,
        )
    }

    /// Publish a numbers record (kind 39009, signed by this server) for the project with `content`.
    pub(crate) async fn numbers_record(&self, content: &Value) {
        let key_hex = hex0x(&self.key);
        let tags = crate::chain_reader::publish::tags(&key_hex, CHAIN_ID, &hex0x(&[0u8; 20]))
            .expect("tags");
        crate::chain_reader::publish::publish(
            &self.state,
            &self.tenant,
            tags,
            &key_hex,
            content,
            Timestamp::now().as_secs(),
        )
        .await
        .expect("a numbers record");
    }

    /// Another launched project of `founder` named `d`, with the counted accounts the example record says: a project
    /// record whose chain key is new, a launch row that is the run's own (project A's) with only its key and its
    /// `projectId` pointed at this record, and the example numbers record under that key. Returns its coordinate.
    pub(crate) async fn extra_project(&self, founder: &Keys, d: &str) -> String {
        use sha2::{Digest, Sha256};
        let n = self.extra.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let founder_hex = founder.public_key().to_hex();
        let key: [u8; 32] = Sha256::digest(format!("{}:{founder_hex}:{d}", self.reader)).into();
        let coordinate = format!("37001:{founder_hex}:{d}");
        ingest(
            &self.state,
            &self.tenant,
            signed(
                founder,
                KIND_LAUNCH_RECORD,
                &[
                    tag(&["d", d]),
                    tag(&["name", d]),
                    tag(&["chain-key", &hex0x(&key)]),
                ],
                "{}",
                0,
            ),
        )
        .await
        .expect("a project record");
        let (_, project, launch) = self
            .fx
            .decoded()
            .into_iter()
            .find(|(role, project, row)| {
                *role == Role::Launcher
                    && row.event == "ProjectLaunched"
                    && project.as_deref() == Some("A")
            })
            .expect("the run launches project A");
        let _ = project;
        let mut decoded = launch.fields.clone();
        decoded["key"] = json!(hex0x(&key));
        decoded["projectId"] = json!(project_id(&coordinate));
        sqlx::query(
            "INSERT INTO chain_logs (reader, block_number, log_index, block_hash, tx_hash, address, role, \
             project_key, event, topics, data, decoded) \
             VALUES ($1, $2, $3, $4, $5, $6, 'launcher', $7, 'ProjectLaunched', $8, $9, $10)",
        )
        .bind(&self.reader)
        .bind(i64::try_from(launch.block).expect("block"))
        .bind(i32::try_from(10_000 + n).expect("index"))
        .bind(self.fx.blocks[usize::try_from(launch.block).expect("block")].hash.as_slice())
        .bind(launch.tx.as_slice())
        .bind(launch.address.as_slice())
        .bind(key.as_slice())
        .bind(Vec::<Vec<u8>>::new())
        .bind(Vec::<u8>::new())
        .bind(&decoded)
        .execute(self.state.db.pool())
        .await
        .expect("a launch row");
        let mut record = example_record();
        record["key"] = json!(hex0x(&key));
        let key_hex = hex0x(&key);
        let tags = crate::chain_reader::publish::tags(&key_hex, CHAIN_ID, &hex0x(&[0u8; 20]))
            .expect("tags");
        crate::chain_reader::publish::publish(
            &self.state,
            &self.tenant,
            tags,
            &key_hex,
            &record,
            Timestamp::now().as_secs(),
        )
        .await
        .expect("a numbers record");
        coordinate
    }
}

/// The record of the run's real example (`docs/next-version/record-v2-example.json`: produced by the server's own
/// builder from the same run), read as JSON.
pub(crate) fn example_record() -> Value {
    serde_json::from_str(include_str!(
        "../../../../docs/next-version/record-v2-example.json"
    ))
    .expect("the example is JSON")
}

/// A kind 37017 binding by `who` of `address`, attested by the wallet's own `key`.
pub(crate) fn binding(
    fx: &Fixture,
    who: &Keys,
    key: &SigningKey,
    address: &str,
    expires: u64,
    revoked: bool,
) -> Event {
    let _ = fx;
    let attestation = buzz_evm_auth::NostrSignerAttestation {
        account: buzz_evm_auth::EvmAddress::parse(address).expect("address"),
        npub: who.public_key().to_bytes(),
        expires,
        nonce: 0,
    };
    let domain = buzz_evm_auth::Eip712Domain {
        name: "creabuzz".into(),
        version: "1".into(),
        chain_id: CHAIN_ID,
        verifying_contract: buzz_evm_auth::EvmAddress::from_bytes([0u8; 20]),
    };
    let digest = attestation.digest(&domain);
    let (signature, recid) = key.sign_prehash_recoverable(&digest);
    let mut bytes = signature.to_bytes().to_vec();
    bytes.push(if recid.is_y_odd() { 28 } else { 27 });
    let envelope = buzz_evm_auth::AttestationEnvelope {
        attestation,
        domain,
        signature: hex::encode(bytes),
    };
    let mut content = json!({
        "v": 1,
        "address": address,
        "siweMessageHash": format!("0x{}", "11".repeat(32)),
        "attestation": envelope,
    });
    if revoked {
        content["revoked"] = json!(true);
    }
    signed(
        who,
        KIND_EVM_BINDING,
        &[
            tag(&["d", address]),
            tag(&["address", address]),
            tag(&["chain", &CHAIN_ID.to_string()]),
        ],
        &content.to_string(),
        0,
    )
}
