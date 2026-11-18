//! The contracts/next events the chain reader follows, and their decoding.
//!
//! Each event is named by the role of the contract that emits it and its first
//! topic, never by the topic alone: Rounds and Treasury share
//! `FeesSwept(address,uint256)` and `WoundDown(uint256)`, and three contracts
//! emit different events called `Settled`. Signatures are written out from the
//! sources in `contracts/next/src` and the topics are checked against the
//! artifacts in `contracts/next/out` by the tests below.

use std::sync::OnceLock;

use buzz_evm_allowance::abi::keccak256;
use serde_json::{Map, Value};

use super::word::{hex0x, word_to_address, word_to_decimal, Word};

/// Which contract emitted a log.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Role {
    /// The one Launcher the reader is configured with.
    Launcher,
    /// A project's Shares (ERC-20).
    Shares,
    /// A project's Treasury.
    Treasury,
    /// A project's Vester.
    Vester,
    /// A project's Finisher (the auction and pool steps).
    Finisher,
    /// A project's Rounds (backing rounds).
    Rounds,
    /// A Team runner (two signers).
    Pair,
}

impl Role {
    /// The name stored in `chain_contracts.role` and `chain_logs.role`.
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Launcher => "launcher",
            Role::Shares => "shares",
            Role::Treasury => "treasury",
            Role::Vester => "vester",
            Role::Finisher => "finisher",
            Role::Rounds => "rounds",
            Role::Pair => "pair",
        }
    }

    /// The role named by [`Role::as_str`].
    pub fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "launcher" => Role::Launcher,
            "shares" => Role::Shares,
            "treasury" => Role::Treasury,
            "vester" => Role::Vester,
            "finisher" => Role::Finisher,
            "rounds" => Role::Rounds,
            "pair" => Role::Pair,
            _ => return None,
        })
    }
}

/// An ABI parameter type, as far as these events need.
#[derive(Debug)]
pub enum Ty {
    /// `address`.
    Address,
    /// `uintN`, kept with its Solidity name for the signature.
    Uint(&'static str),
    /// `bool`.
    Bool,
    /// `bytes32`.
    Bytes32,
    /// `bytes` (dynamic; only `Pair.Proposed.data`).
    Bytes,
    /// A static struct: its fields in order.
    Tuple(&'static [Param]),
}

/// One event parameter.
#[derive(Debug)]
pub struct Param {
    /// The parameter's name in the source (the key in the decoded JSON).
    pub name: &'static str,
    /// Its type.
    pub ty: Ty,
    /// Whether it is an indexed topic.
    pub indexed: bool,
}

/// One event the reader follows.
#[derive(Debug)]
pub struct EventDef {
    /// The emitting contract's role.
    pub role: Role,
    /// The event's name in the source.
    pub name: &'static str,
    /// Its parameters in order.
    pub params: &'static [Param],
}

const fn p(name: &'static str, ty: Ty) -> Param {
    Param {
        name,
        ty,
        indexed: false,
    }
}

const fn ix(name: &'static str, ty: Ty) -> Param {
    Param {
        name,
        ty,
        indexed: true,
    }
}

const U256: Ty = Ty::Uint("uint256");
const U64: Ty = Ty::Uint("uint64");

const SETTINGS: &[Param] = &[
    p("quote", Ty::Address),
    p("platform", Ty::Address),
    p("stake", Ty::Address),
    p("exitFeeBps", Ty::Uint("uint16")),
    p("platformFeeBps", Ty::Uint("uint16")),
    p("spendableParts", Ty::Uint("uint16")),
    p("floorParts", Ty::Uint("uint16")),
    p("agentUsd", Ty::Uint("uint128")),
    p("agentShares", Ty::Uint("uint128")),
];
const PROJECT: &[Param] = &[
    p("founder", Ty::Address),
    p("shares", Ty::Address),
    p("treasury", Ty::Address),
    p("vester", Ty::Address),
    p("finisher", Ty::Address),
    p("rounds", Ty::Address),
    p("launchedAt", U64),
];
const ALLOCATION: &[Param] = &[
    p("sale", U256),
    p("poolReserve", U256),
    p("founder", U256),
    p("workPot", U256),
    p("reserve", U256),
    p("backing", U256),
];

macro_rules! ev {
    ($role:ident, $name:literal, [$($param:expr),* $(,)?]) => {
        EventDef { role: Role::$role, name: $name, params: &[$($param),*] }
    };
}

/// Every event the reader decodes. A log whose (role, topic) is not here is
/// stored with `decoded` null and event name `unknown`.
pub static EVENTS: &[EventDef] = &[
    // ── Launcher ────────────────────────────────────────────────────────────
    ev!(
        Launcher,
        "ProjectLaunched",
        [
            ix("key", Ty::Bytes32),
            ix("projectId", Ty::Bytes32),
            ix("founder", Ty::Address),
            p("project", Ty::Tuple(PROJECT)),
            p("allocation", Ty::Tuple(ALLOCATION)),
            p("settings", Ty::Tuple(SETTINGS)),
        ]
    ),
    ev!(
        Launcher,
        "RoundOpened",
        [
            ix("key", Ty::Bytes32),
            ix("rounds", Ty::Address),
            ix("round", U256),
            p("size", U256),
            p("cap", U256),
            p("raisedBefore", U256),
            p("sharesPerRawDollar", U256),
        ]
    ),
    ev!(
        Launcher,
        "SaleOpened",
        [
            ix("key", Ty::Bytes32),
            ix("auction", Ty::Address),
            ix("runner", Ty::Address),
            p("finisher", Ty::Address),
            p("minimum", U256),
            p("startBlock", U64),
            p("endBlock", U64),
            p("floorPriceQ96", U256),
            p("tickSpacingQ96", U256),
        ]
    ),
    ev!(
        Launcher,
        "PairMade",
        [
            ix("key", Ty::Bytes32),
            ix("pair", Ty::Address),
            p("first", Ty::Address),
            p("second", Ty::Address),
        ]
    ),
    ev!(
        Launcher,
        "NoMarket",
        [ix("key", Ty::Bytes32), ix("runner", Ty::Address)]
    ),
    ev!(
        Launcher,
        "WoundDown",
        [ix("key", Ty::Bytes32), ix("runner", Ty::Address)]
    ),
    ev!(
        Launcher,
        "ReserveSaleOpened",
        [
            ix("key", Ty::Bytes32),
            ix("auction", Ty::Address),
            p("amount", U256),
            p("floorPriceQ96", U256),
            p("tickSpacingQ96", U256),
            p("startBlock", U64),
            p("endBlock", U64),
        ]
    ),
    ev!(
        Launcher,
        "ReserveSaleFinished",
        [
            ix("key", Ty::Bytes32),
            ix("auction", Ty::Address),
            p("toTreasury", U256),
            p("sharesBack", U256),
            p("endPriceQ96", U256),
        ]
    ),
    ev!(Launcher, "ProjectZeroNamed", [ix("key", Ty::Bytes32)]),
    ev!(
        Launcher,
        "EarlierBackersNamed",
        [
            ix("key", Ty::Bytes32),
            ix("claim", Ty::Address),
            p("keepBacking", U256),
        ]
    ),
    ev!(
        Launcher,
        "ProjectZeroSplit",
        [
            ix("key", Ty::Bytes32),
            ix("claim", Ty::Address),
            p("fromBacking", U256),
            p("fromFounder", U256),
            p("teamBudget", U256),
        ]
    ),
    ev!(Launcher, "CouncilRegistered", [ix("council", Ty::Address)]),
    ev!(
        Launcher,
        "PauserNamed",
        [ix("key", Ty::Bytes32), ix("pauser", Ty::Address)]
    ),
    ev!(
        Launcher,
        "SettingsChanged",
        [p("settings", Ty::Tuple(SETTINGS))]
    ),
    ev!(Launcher, "AdminChanged", [ix("admin", Ty::Address)]),
    // ── Rounds ──────────────────────────────────────────────────────────────
    ev!(
        Rounds,
        "RoundOpened",
        [
            ix("round", U256),
            p("size", U256),
            p("sharesPerRawDollar", U256),
            p("opensAt", U256),
            p("closesAt", U256),
        ]
    ),
    ev!(
        Rounds,
        "Asked",
        [
            ix("round", U256),
            ix("backer", Ty::Address),
            p("total", U256),
            p("added", U256)
        ]
    ),
    ev!(
        Rounds,
        "AskLowered",
        [
            ix("round", U256),
            ix("backer", Ty::Address),
            p("total", U256),
            p("returned", U256),
        ]
    ),
    ev!(
        Rounds,
        "RoundClosed",
        [
            ix("round", U256),
            p("asked", U256),
            p("accepted", U256),
            p("activeAtClose", U256),
        ]
    ),
    ev!(
        Rounds,
        "Settled",
        [
            ix("round", U256),
            ix("backer", Ty::Address),
            p("accepted", U256),
            p("returned", U256),
            p("shares", U256),
            p("toPlatform", U256),
            p("toProject", U256),
            p("held", U256),
        ]
    ),
    ev!(Rounds, "Released", [ix("round", U256), p("amount", U256)]),
    ev!(
        Rounds,
        "Refunded",
        [
            ix("round", U256),
            ix("backer", Ty::Address),
            p("unreleased", U256),
            p("paid", U256),
            p("toProject", U256),
            p("toPlatform", U256),
            p("shares", U256),
        ]
    ),
    ev!(
        Rounds,
        "FeesSwept",
        [ix("to", Ty::Address), p("amount", U256)]
    ),
    ev!(Rounds, "UnsoldReturned", [p("amount", U256)]),
    ev!(Rounds, "WoundDown", [p("time", U256)]),
    // ── Vester ──────────────────────────────────────────────────────────────
    ev!(
        Vester,
        "Granted",
        [ix("beneficiary", Ty::Address), p("amount", U256)]
    ),
    ev!(
        Vester,
        "Claimed",
        [ix("beneficiary", Ty::Address), p("amount", U256)]
    ),
    ev!(Vester, "Started", [p("time", U256)]),
    ev!(
        Vester,
        "HeldGranted",
        [
            ix("round", U256),
            ix("backer", Ty::Address),
            p("amount", U256)
        ]
    ),
    ev!(
        Vester,
        "HeldCancelled",
        [
            ix("round", U256),
            ix("backer", Ty::Address),
            p("amount", U256)
        ]
    ),
    ev!(
        Vester,
        "HeldClaimed",
        [
            ix("round", U256),
            ix("backer", Ty::Address),
            p("amount", U256)
        ]
    ),
    ev!(Vester, "FounderTrimmed", [p("kept", U256), p("cut", U256)]),
    // ── Treasury ────────────────────────────────────────────────────────────
    ev!(
        Treasury,
        "Settled",
        [
            p("amount", U256),
            p("toSpendable", U256),
            p("toFloor", U256)
        ]
    ),
    ev!(
        Treasury,
        "ReserveSaleSettled",
        [
            p("amount", U256),
            p("toSpendable", U256),
            p("toFloor", U256)
        ]
    ),
    ev!(
        Treasury,
        "ShareRevenue",
        [ix("from", Ty::Address), p("amount", U256)]
    ),
    ev!(
        Treasury,
        "ToppedUp",
        [ix("from", Ty::Address), p("amount", U256)]
    ),
    ev!(Treasury, "Released", [p("amount", U256)]),
    ev!(Treasury, "CheckedIn", [ix("by", Ty::Address)]),
    ev!(Treasury, "Paused", [p("on", Ty::Bool)]),
    ev!(Treasury, "PauserSet", [ix("pauser", Ty::Address)]),
    ev!(
        Treasury,
        "Spent",
        [
            ix("by", Ty::Address),
            ix("to", Ty::Address),
            p("amount", U256)
        ]
    ),
    ev!(
        Treasury,
        "TeamPaid",
        [ix("to", Ty::Address), p("amount", U256), p("left", U256)]
    ),
    ev!(
        Treasury,
        "SharesGiven",
        [
            ix("by", Ty::Address),
            ix("to", Ty::Address),
            p("amount", U256),
            p("vested", Ty::Bool),
        ]
    ),
    ev!(
        Treasury,
        "HandedBack",
        [
            ix("holder", Ty::Address),
            p("shares", U256),
            p("paid", U256),
            p("toPlatform", U256),
            p("toProject", U256),
        ]
    ),
    ev!(
        Treasury,
        "FeesSwept",
        [ix("to", Ty::Address), p("amount", U256)]
    ),
    ev!(
        Treasury,
        "ReserveReleased",
        [ix("to", Ty::Address), p("amount", U256)]
    ),
    ev!(Treasury, "ReserveSaleClosed", [p("time", U256)]),
    ev!(Treasury, "PoolOpened", [p("time", U256)]),
    ev!(
        Treasury,
        "StakeGranted",
        [ix("stake", Ty::Address), p("amount", U256)]
    ),
    ev!(Treasury, "SaleAbandoned", [p("time", U256)]),
    ev!(Treasury, "SaleClosed", [p("time", U256)]),
    ev!(Treasury, "NoMarketDeclared", [p("time", U256)]),
    ev!(Treasury, "WoundDown", [p("time", U256)]),
    ev!(
        Treasury,
        "SeatOffered",
        [
            ix("from", Ty::Address),
            ix("to", Ty::Address),
            p("founderLeaves", Ty::Bool)
        ]
    ),
    ev!(
        Treasury,
        "RunnerChanged",
        [
            ix("from", Ty::Address),
            ix("to", Ty::Address),
            p("cut", U256)
        ]
    ),
    ev!(
        Treasury,
        "AgentSet",
        [
            ix("agent", Ty::Address),
            p("active", Ty::Bool),
            p("usdCap", U256),
            p("shareCap", U256),
        ]
    ),
    // ── Finisher ────────────────────────────────────────────────────────────
    ev!(
        Finisher,
        "PoolOpened",
        [
            ix("auction", Ty::Address),
            p("poolId", Ty::Bytes32),
            p("sqrtPriceX96", Ty::Uint("uint160")),
            p("poolDollars", U256),
            p("poolShares", U256),
        ]
    ),
    ev!(
        Finisher,
        "Settled",
        [
            ix("auction", Ty::Address),
            p("raised", U256),
            p("afterFee", U256),
            p("toTreasury", U256),
        ]
    ),
    ev!(
        Finisher,
        "PoolStep",
        [ix("auction", Ty::Address), p("poolOpen", Ty::Bool)]
    ),
    ev!(
        Finisher,
        "SaleOpenedBy",
        [
            ix("auction", Ty::Address),
            p("endBlock", U64),
            p("attempt", Ty::Uint("uint32"))
        ]
    ),
    ev!(
        Finisher,
        "Swept",
        [ix("auction", Ty::Address), p("sharesToTreasury", U256)]
    ),
    ev!(
        Finisher,
        "SaleFailed",
        [ix("auction", Ty::Address), p("retryBlock", U64)]
    ),
    ev!(
        Finisher,
        "Abandoned",
        [
            ix("auction", Ty::Address),
            p("toFloorOnly", U256),
            p("split", U256)
        ]
    ),
    // ── Pair ────────────────────────────────────────────────────────────────
    ev!(
        Pair,
        "SpentAlone",
        [
            ix("by", Ty::Address),
            ix("to", Ty::Address),
            p("amount", U256)
        ]
    ),
    ev!(
        Pair,
        "Proposed",
        [
            ix("id", Ty::Bytes32),
            ix("by", Ty::Address),
            p("target", Ty::Address),
            p("data", Ty::Bytes),
            p("nonce", U256),
        ]
    ),
    ev!(
        Pair,
        "Executed",
        [ix("id", Ty::Bytes32), ix("confirmedBy", Ty::Address)]
    ),
    ev!(Pair, "Cancelled", [ix("id", Ty::Bytes32)]),
    // ── Shares ──────────────────────────────────────────────────────────────
    ev!(
        Shares,
        "Transfer",
        [
            ix("from", Ty::Address),
            ix("to", Ty::Address),
            p("value", U256)
        ]
    ),
];

fn type_name(ty: &Ty, out: &mut String) {
    match ty {
        Ty::Address => out.push_str("address"),
        Ty::Uint(name) => out.push_str(name),
        Ty::Bool => out.push_str("bool"),
        Ty::Bytes32 => out.push_str("bytes32"),
        Ty::Bytes => out.push_str("bytes"),
        Ty::Tuple(fields) => {
            out.push('(');
            for (i, field) in fields.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                type_name(&field.ty, out);
            }
            out.push(')');
        }
    }
}

impl EventDef {
    /// The canonical signature, e.g. `Asked(uint256,address,uint256,uint256)`.
    pub fn signature(&self) -> String {
        let mut out = String::from(self.name);
        out.push('(');
        for (i, param) in self.params.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            type_name(&param.ty, &mut out);
        }
        out.push(')');
        out
    }

    /// The first topic: keccak256 of the signature.
    pub fn topic(&self) -> Word {
        keccak256(self.signature().as_bytes())
    }
}

fn table() -> &'static [(Role, Word, &'static EventDef)] {
    static TABLE: OnceLock<Vec<(Role, Word, &'static EventDef)>> = OnceLock::new();
    TABLE.get_or_init(|| EVENTS.iter().map(|e| (e.role, e.topic(), e)).collect())
}

/// The event `role` emits under `topic0`, if the reader knows it.
pub fn lookup(role: Role, topic0: &Word) -> Option<&'static EventDef> {
    table()
        .iter()
        .find(|(r, t, _)| *r == role && t == topic0)
        .map(|(_, _, e)| *e)
}

/// Every first topic the reader follows (for a `topics[0]` filter).
pub fn all_topics() -> Vec<Word> {
    let mut topics: Vec<Word> = table().iter().map(|(_, t, _)| *t).collect();
    topics.sort();
    topics.dedup();
    topics
}

/// Why a log could not be decoded.
#[derive(Debug, PartialEq, Eq)]
pub enum DecodeError {
    /// Fewer or more topics than the event's indexed parameters.
    Topics,
    /// The data is shorter than the parameters, or a `bytes` offset is wrong.
    Data,
}

fn static_words(ty: &Ty) -> usize {
    match ty {
        Ty::Tuple(fields) => fields.iter().map(|f| static_words(&f.ty)).sum(),
        _ => 1,
    }
}

fn word_at(data: &[u8], index: usize) -> Result<Word, DecodeError> {
    let start = index.checked_mul(32).ok_or(DecodeError::Data)?;
    let slice = data.get(start..start + 32).ok_or(DecodeError::Data)?;
    let mut w = [0u8; 32];
    w.copy_from_slice(slice);
    Ok(w)
}

fn scalar(ty: &Ty, w: &Word) -> Value {
    match ty {
        Ty::Address => Value::String(hex0x(&word_to_address(w))),
        Ty::Uint(_) => Value::String(word_to_decimal(w)),
        Ty::Bool => Value::Bool(w[31] != 0),
        Ty::Bytes32 => Value::String(hex0x(w)),
        // Indexed dynamic values are hashes; not used by these events.
        Ty::Bytes | Ty::Tuple(_) => Value::String(hex0x(w)),
    }
}

fn decode_static(ty: &Ty, data: &[u8], cursor: &mut usize) -> Result<Value, DecodeError> {
    match ty {
        Ty::Tuple(fields) => {
            let mut obj = Map::new();
            for field in fields.iter() {
                obj.insert(
                    field.name.to_owned(),
                    decode_static(&field.ty, data, cursor)?,
                );
            }
            Ok(Value::Object(obj))
        }
        _ => {
            let w = word_at(data, *cursor)?;
            *cursor += 1;
            Ok(scalar(ty, &w))
        }
    }
}

/// Decode one log's topics and data into a JSON object of its parameters.
/// Integers are decimal strings, addresses and fixed bytes `0x` hex.
pub fn decode(def: &EventDef, topics: &[Word], data: &[u8]) -> Result<Value, DecodeError> {
    let indexed = def.params.iter().filter(|p| p.indexed).count();
    if topics.len() != indexed + 1 {
        return Err(DecodeError::Topics);
    }
    let head_words: usize = def
        .params
        .iter()
        .filter(|p| !p.indexed)
        .map(|p| static_words(&p.ty))
        .sum();
    if data.len() < head_words * 32 {
        return Err(DecodeError::Data);
    }
    let mut out = Map::new();
    let mut topic = 1;
    let mut cursor = 0usize;
    for param in def.params {
        let value = if param.indexed {
            let v = scalar(&param.ty, &topics[topic]);
            topic += 1;
            v
        } else if matches!(param.ty, Ty::Bytes) {
            let offset_word = word_at(data, cursor)?;
            cursor += 1;
            let offset = super::word::word_to_u128(&offset_word)
                .and_then(|v| usize::try_from(v).ok())
                .ok_or(DecodeError::Data)?;
            if offset % 32 != 0 {
                return Err(DecodeError::Data);
            }
            let len_word = word_at(data, offset / 32)?;
            let len = super::word::word_to_u128(&len_word)
                .and_then(|v| usize::try_from(v).ok())
                .ok_or(DecodeError::Data)?;
            let start = offset + 32;
            let bytes = data
                .get(start..start.checked_add(len).ok_or(DecodeError::Data)?)
                .ok_or(DecodeError::Data)?;
            Value::String(hex0x(bytes))
        } else {
            decode_static(&param.ty, data, &mut cursor)?
        };
        out.insert(param.name.to_owned(), value);
    }
    Ok(Value::Object(out))
}

#[cfg(test)]
#[path = "events_tests.rs"]
mod tests;
