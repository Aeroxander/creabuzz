//! The reader's real-run fixture (tests only): a run of the contracts/pot
//! contracts on anvil, played by `scripts/chain-reader-fixture.py`, held in
//! `testdata/pot-run.json`: every block header, every log, the addresses the
//! Launcher named, and the numbers the contracts' own views gave right after
//! each block that changed a project, and at the last block.
//!
//! It is shared by the ledger tests (a replay in memory) and the Postgres
//! tests (the same blocks served by a fake chain to the real reader).

use std::collections::BTreeMap;

use serde_json::Value;

use super::events::{self, Role};
use super::ledger::LogRow;
use super::source::{ChainSource, Header, RawLog};
use super::word::{parse_bytes, parse_fixed, Word};

const RUN: &str = include_str!("testdata/pot-run.json");

/// A project's contracts in the run.
#[derive(Clone, Debug)]
pub struct FxProject {
    /// Its chain key.
    pub key: Word,
    /// The Treasury.
    pub treasury: [u8; 20],
    /// The backer Shares token.
    pub shares: [u8; 20],
    /// The Team Shares token.
    pub team: [u8; 20],
    /// The Vester.
    pub vester: [u8; 20],
    /// Its Pair, if one was made.
    pub pair: Option<[u8; 20]>,
}

/// The run.
pub struct Fixture {
    /// The whole file.
    pub json: Value,
    /// The Launcher.
    pub launcher: [u8; 20],
    /// The dollar.
    pub dollar: [u8; 20],
    /// Every header, by number.
    pub blocks: Vec<Header>,
    /// Every log of the chain, in chain order.
    pub logs: Vec<RawLog>,
    /// The projects by name ("A", "B").
    pub projects: BTreeMap<String, FxProject>,
}

fn addr(v: &Value) -> [u8; 20] {
    parse_fixed::<20>(v.as_str().expect("an address")).expect("20 bytes")
}

fn word(v: &Value) -> Word {
    parse_fixed::<32>(v.as_str().expect("a hash")).expect("32 bytes")
}

impl Fixture {
    /// Load the run.
    pub fn load() -> Self {
        let json: Value = serde_json::from_str(RUN).expect("the fixture is JSON");
        let blocks = json["blocks"]
            .as_array()
            .expect("blocks")
            .iter()
            .map(|b| Header {
                number: b["number"].as_u64().expect("number"),
                hash: word(&b["hash"]),
                parent: word(&b["parent"]),
                time: b["time"].as_u64().expect("time"),
            })
            .collect();
        let logs = json["logs"]
            .as_array()
            .expect("logs")
            .iter()
            .map(|l| RawLog {
                block_number: l["block"].as_u64().expect("block"),
                block_hash: word(&l["blockHash"]),
                tx_hash: word(&l["txHash"]),
                log_index: u32::try_from(l["index"].as_u64().expect("index")).expect("index"),
                address: addr(&l["address"]),
                topics: l["topics"]
                    .as_array()
                    .expect("topics")
                    .iter()
                    .map(word)
                    .collect(),
                data: parse_bytes(l["data"].as_str().expect("data")).expect("hex data"),
                removed: false,
            })
            .collect();
        let projects = json["projects"]
            .as_object()
            .expect("projects")
            .iter()
            .map(|(name, p)| {
                (
                    name.clone(),
                    FxProject {
                        key: word(&p["key"]),
                        treasury: addr(&p["treasury"]),
                        shares: addr(&p["shares"]),
                        team: addr(&p["team"]),
                        vester: addr(&p["vester"]),
                        pair: p.get("pair").map(addr),
                    },
                )
            })
            .collect();
        Self {
            launcher: addr(&json["launcher"]),
            dollar: addr(&json["dollar"]),
            blocks,
            logs,
            projects,
            json,
        }
    }

    /// The last block of the run.
    pub fn head(&self) -> u64 {
        self.blocks.last().map_or(0, |b| b.number)
    }

    /// The time of block `number`.
    pub fn time_of(&self, number: u64) -> u64 {
        self.blocks[usize::try_from(number).expect("block")].time
    }

    /// The role of the contract at `address` and the project it belongs to
    /// (none for the Launcher and the dollar), as the run's own addresses say.
    pub fn role_of(&self, address: &[u8; 20]) -> Option<(Role, Option<&str>)> {
        if *address == self.launcher {
            return Some((Role::Launcher, None));
        }
        if *address == self.dollar {
            return Some((Role::Dollar, None));
        }
        for (name, p) in &self.projects {
            for (a, role) in [
                (p.treasury, Role::Treasury),
                (p.shares, Role::Shares),
                (p.team, Role::Team),
                (p.vester, Role::Vester),
            ] {
                if a == *address {
                    return Some((role, Some(name)));
                }
            }
            if p.pair == Some(*address) {
                return Some((Role::Pair, Some(name)));
            }
        }
        None
    }

    /// Every log decoded, in chain order, with its role and project: a log
    /// from an address of the run whose event the table knows. Logs the table
    /// does not name (an `Approval`) are left out.
    pub fn decoded(&self) -> Vec<(Role, Option<String>, LogRow)> {
        let mut out = Vec::new();
        for log in &self.logs {
            let Some((role, project)) = self.role_of(&log.address) else {
                continue;
            };
            let Some(def) = log.topics.first().and_then(|t| events::lookup(role, t)) else {
                continue;
            };
            let fields = events::decode(def, &log.topics, &log.data)
                .unwrap_or_else(|e| panic!("{:?}.{} does not decode: {e:?}", role, def.name));
            // The Launcher's events carry the project's key as their first
            // topic argument.
            let project = match (role, project) {
                (Role::Launcher, _) => log.topics.get(1).and_then(|k| {
                    self.projects
                        .iter()
                        .find(|(_, p)| p.key == *k)
                        .map(|(n, _)| n.as_str())
                }),
                (_, p) => p,
            };
            out.push((
                role,
                project.map(str::to_owned),
                LogRow {
                    block: log.block_number,
                    log_index: log.log_index,
                    time: self.time_of(log.block_number),
                    role,
                    address: log.address,
                    event: def.name.to_owned(),
                    fields,
                },
            ));
        }
        out
    }

    /// Project `name`'s rows up to and including block `up_to`, oldest first
    /// (what the store hands the ledger; the token `Transfer`s are in).
    pub fn rows(&self, name: &str, up_to: u64) -> Vec<LogRow> {
        self.decoded()
            .into_iter()
            .filter(|(_, p, r)| p.as_deref() == Some(name) && r.block <= up_to)
            .map(|(_, _, r)| r)
            .collect()
    }
}

/// The raw answers of a book: `(contract, calldata)` to the answer.
pub type Answers = std::collections::HashMap<([u8; 20], Vec<u8>), Vec<u8>>;

/// A node that answers the record builder's view calls from a book of the
/// real chain's answers (`books` in the run), at the one block the book was
/// taken at. A call with no captured answer, or at another block, fails, like
/// a node that cannot serve it.
pub struct BookChain {
    /// The block the book was taken at.
    pub block: u64,
    /// `(contract, calldata)` to the raw answer.
    pub answers: Answers,
}

impl BookChain {
    /// Load the book `name` of the run, and the project it is of.
    pub fn load(fx: &Fixture, name: &str) -> (String, Self) {
        let book = &fx.json["books"][name];
        let answers = book["calls"]
            .as_object()
            .expect("a book of calls")
            .iter()
            .map(|(key, answer)| {
                let (to, data) = key.split_once(':').expect("to:data");
                (
                    (
                        parse_fixed::<20>(to).expect("address"),
                        parse_bytes(data).expect("calldata"),
                    ),
                    parse_bytes(answer.as_str().expect("an answer")).expect("hex answer"),
                )
            })
            .collect();
        (
            book["project"].as_str().expect("project").to_owned(),
            Self {
                block: book["block"].as_u64().expect("block"),
                answers,
            },
        )
    }
}

#[async_trait::async_trait]
impl ChainSource for BookChain {
    async fn chain_id(&self) -> anyhow::Result<u64> {
        Ok(31337)
    }
    async fn head(&self) -> anyhow::Result<u64> {
        Ok(self.block)
    }
    async fn header(&self, _number: u64) -> anyhow::Result<Option<Header>> {
        Ok(None)
    }
    async fn logs(
        &self,
        _addresses: &[[u8; 20]],
        _topics: &[Word],
        _from: u64,
        _to: u64,
    ) -> anyhow::Result<Vec<RawLog>> {
        Ok(Vec::new())
    }
    async fn eth_call(
        &self,
        to: &[u8; 20],
        data: &[u8],
        at: u64,
    ) -> anyhow::Result<Option<Vec<u8>>> {
        if at != self.block {
            anyhow::bail!("the node cannot serve block {at}");
        }
        self.answers
            .get(&(*to, data.to_vec()))
            .cloned()
            .map(Some)
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "no captured answer for 0x{} {}",
                    hex::encode(to),
                    hex::encode(data)
                )
            })
    }
}
