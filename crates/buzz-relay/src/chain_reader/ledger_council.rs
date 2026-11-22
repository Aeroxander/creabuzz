//! The Council and the holder vote, rebuilt from the events alone (`COUNCIL-PLAN.md` sections 1.6, 2.12 and 5.1).
//!
//! The Council's `SeatsSet` carries the whole picture of the seats at birth and after every change, so the ledger never
//! rebuilds seats from deltas. A pending proposal is the picture the three events that move it leave: `Proposed` (one
//! agreement and the call), `Agreed` (one more) and `Withdrawn` (one fewer); `Executed`, `Cancelled`, `Resigned` and a
//! new `SeatsSet` take one out of the set.
//!
//! The vote's `Voted` and `Fell` events carry **absolute** tallies: `optionTally` for the option, `fromTally` for the
//! option a move left, and the cast total after. So the ledger **sets** `tally[option]`, `tally[fromOption]` and `cast`
//! and keeps **no per-voter state**: nothing here remembers who voted or how much, and a moved vote leaves no stale
//! tally (COUNCIL-PLAN.md section 5.1).
//!
//! A row that does not read as its event says is an error, never a skip: a ledger that lost an event would sign a wrong
//! tally. A tie in an election is not an error (the contract leaves the second seat as it is); see
//! [`super::record_council::derive_result`].

use std::collections::BTreeMap;

use anyhow::{anyhow, bail, Context};
use serde_json::Value;

use super::ledger::{address, num, small, text, LogRow};
use super::word::hex0x;

/// The most ballots the ledger keeps (the record needs the newest and the recent past; a chain cannot grow the reader's
/// memory without bound).
pub const MAX_BALLOTS: usize = 64;
/// How many agreements a Council needs to run a call (`Council.THRESHOLD`). The contract's constant; used only to know
/// when a proposal has run, never carried into the record (the record reads it from the contract).
const THRESHOLD: u8 = 3;

/// One seat of a Council.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct SeatSeen {
    /// Who holds it (lower-case `0x` text); none for an open seat.
    pub who: Option<String>,
    /// Since when (`SeatsSet.seatedAt`); zero for an open seat.
    pub seated_at: u64,
}

/// One pending proposal.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProposalSeen {
    /// When it was proposed (the block's time: the event carries no time of its own).
    pub at: u64,
    /// The generation it was proposed in; a seat change kills it.
    pub generation: u32,
    /// One bit per seat that has agreed.
    pub mask: u8,
    /// The first four bytes of the call, its selector.
    pub selector: [u8; 4],
}

/// A Council as its events tell it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CouncilSeen {
    /// The Council contract, once `CouncilMade` named it.
    pub contract: Option<String>,
    /// The five seats, in order.
    pub seats: [SeatSeen; 5],
    /// Goes up whenever any seat changes.
    pub generation: u32,
    /// When two seats may next come up.
    pub next_election: u64,
    /// The proposals that may still run, by id.
    pub proposals: BTreeMap<[u8; 32], ProposalSeen>,
}

impl Default for CouncilSeen {
    fn default() -> Self {
        Self {
            contract: None,
            seats: std::array::from_fn(|_| SeatSeen::default()),
            generation: 0,
            next_election: 0,
            proposals: BTreeMap::new(),
        }
    }
}

impl CouncilSeen {
    /// The seat number `who` holds, if any.
    pub fn seat_of(&self, who: &str) -> Option<u8> {
        self.seats
            .iter()
            .position(|s| s.who.as_deref() == Some(who))
            .and_then(|i| u8::try_from(i).ok())
    }

    /// The number of distinct non-zero live seats.
    pub fn live_seats(&self) -> u64 {
        let mut seen: Vec<&str> = self.seats.iter().filter_map(|s| s.who.as_deref()).collect();
        seen.sort_unstable();
        seen.dedup();
        seen.len() as u64
    }
}

/// What an option of a ballot is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OptionKind {
    /// "keep" (option 0): nothing changes.
    Keep,
    /// A list of five accounts for a replace vote.
    List,
    /// One person for a seat.
    Person,
}

impl OptionKind {
    /// The record's word for it.
    pub fn as_str(self) -> &'static str {
        match self {
            OptionKind::Keep => "keep",
            OptionKind::List => "list",
            OptionKind::Person => "person",
        }
    }
}

/// One choice on a ballot.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OptionSeen {
    /// What it is.
    pub kind: OptionKind,
    /// The five accounts of a list, or the one person of a seat.
    pub members: Vec<String>,
    /// Who put it forward; none for "keep".
    pub proposer: Option<String>,
    /// The signed text's id; none for "keep".
    pub record_hash: Option<String>,
}

/// A recorded result (`BallotFinished`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Finished {
    /// 1 short, 2 kept, 3 moved, 4 seated, 5 unchanged (`HolderVote.OUTCOME_*`).
    pub outcome: u8,
    /// The first winner (0 when none).
    pub winner: u8,
    /// The second winner (0 when none).
    pub winner_b: u8,
    /// The cast total the contract recorded with it.
    pub cast_total: u128,
}

/// One ballot as its events tell it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BallotSeen {
    /// Its id (`BallotOpened.id`).
    pub id: u32,
    /// 1 replace, 2 seats (`HolderVote.KIND_*`).
    pub kind: u8,
    /// When it opened.
    pub opened_at: u64,
    /// When the stand window ends.
    pub stand_end: u64,
    /// When the vote ends; the tallies freeze here.
    pub vote_end: u64,
    /// When a won result takes effect (`voteEnd` plus the Treasury's longest notice, fixed at opening).
    pub effective_at: u64,
    /// The backers' Shares at the snapshot.
    pub supply: u128,
    /// The Shares that must be cast.
    pub floor: u128,
    /// One of the two seats up, for a seat election (0 otherwise).
    pub up_a: u8,
    /// The other seat up (0 otherwise).
    pub up_b: u8,
    /// The options (option 0 is always "keep").
    pub options: BTreeMap<u8, OptionSeen>,
    /// The absolute tally of each option.
    pub tallies: BTreeMap<u8, u128>,
    /// The Shares cast.
    pub cast: u128,
    /// The recorded result, once `BallotFinished` is seen.
    pub finished: Option<Finished>,
    /// When the result was put in (`BallotCarriedOut`); none until then.
    pub carried_out_at: Option<u64>,
    /// The Council a replace result seated, when the event named one.
    pub carried_out_council: Option<String>,
    /// Whether the result lapsed (`BallotLapsed`).
    pub lapsed: bool,
    /// When it lapsed.
    pub lapsed_at: Option<u64>,
    /// The block time of the ballot's `BallotOpened` row.
    pub opened_block_time: u64,
}

impl BallotSeen {
    /// How many options the ballot offers (including "keep").
    pub fn option_count(&self) -> u8 {
        self.options
            .keys()
            .copied()
            .max()
            .map_or(1, |max| max.saturating_add(1))
    }

    /// The options in order, with "keep" first.
    pub fn options_in_order(&self) -> Vec<(u8, &OptionSeen)> {
        (0..self.option_count())
            .map(|i| (i, self.options.get(&i).unwrap_or(&KEEP)))
            .collect()
    }

    /// The sum of every option's tally.
    pub fn tally_sum(&self) -> u128 {
        self.tallies.values().copied().sum()
    }
}

/// The one "keep" option, so a ballot without a stored entry for it can still be listed.
static KEEP: OptionSeen = OptionSeen {
    kind: OptionKind::Keep,
    members: Vec::new(),
    proposer: None,
    record_hash: None,
};

/// The vote contract's events.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct VoteSeen {
    /// Every ballot the ledger keeps, by id.
    pub ballots: BTreeMap<u32, BallotSeen>,
    /// The newest ballot's id, once one opened.
    pub newest: Option<u32>,
}

impl VoteSeen {
    /// The newest ballot, if any.
    pub fn newest_ballot(&self) -> Option<&BallotSeen> {
        self.newest.and_then(|id| self.ballots.get(&id))
    }

    fn ballot(&mut self, id: u32, event: &str) -> anyhow::Result<&mut BallotSeen> {
        self.ballots
            .get_mut(&id)
            .ok_or_else(|| anyhow!("{event} names ballot {id}, which never opened"))
    }
}

fn selector_bytes(row: &LogRow) -> anyhow::Result<[u8; 4]> {
    let bytes = super::word::parse_bytes(text(row, "data")?)
        .ok_or_else(|| anyhow!("Proposed.data is not hex"))?;
    let first = bytes
        .get(..4)
        .ok_or_else(|| anyhow!("Proposed.data is shorter than a selector"))?;
    let mut out = [0u8; 4];
    out.copy_from_slice(first);
    Ok(out)
}

/// The word for a call's selector (COUNCIL-PLAN.md section 5.2: the waiting proposals' kinds).
pub fn call_kind(sel: [u8; 4]) -> &'static str {
    use buzz_evm_allowance::abi::selector;
    for (signature, kind) in [
        ("draw(address,uint256)", "draw"),
        ("checkIn(bytes32)", "checkIn"),
        ("proposeRate(uint32)", "rate"),
        ("setRate(uint32)", "rate"),
        ("setDoor(bool)", "door"),
        ("announceTask(bytes32,address,uint256,uint16)", "plan"),
        ("acceptTask(uint64,uint256)", "accept"),
        ("rejectTask(uint64)", "reject"),
        ("cancelTask(uint64)", "cancel"),
        ("grantTeam(address,uint256)", "grant"),
        ("setAgent(address,uint128,uint128)", "helper"),
        ("authoriseAgent(address)", "helper"),
        ("revokeAgent(address)", "helper"),
        ("handOver(address,bool)", "handOver"),
        ("windDown()", "windDown"),
        ("windDown(bytes32)", "windDown"),
    ] {
        if selector(signature) == sel {
            return kind;
        }
    }
    "other"
}

/// The count of bits set in `mask`.
fn popcount(mask: u8) -> u8 {
    mask.count_ones().try_into().unwrap_or(u8::MAX)
}

fn seat_index(seen: &CouncilSeen, who: &str) -> anyhow::Result<u8> {
    seen.seat_of(who)
        .ok_or_else(|| anyhow!("{who} is not a seat of this Council"))
}

/// Apply one log of a Council. Returns whether the event is one the ledger counts.
pub fn apply_council(row: &LogRow, seen: &mut CouncilSeen) -> anyhow::Result<bool> {
    match row.event.as_str() {
        "SeatsSet" => {
            let seats = row
                .fields
                .get("seats")
                .and_then(Value::as_array)
                .ok_or_else(|| anyhow!("SeatsSet.seats is missing"))?;
            let at = row
                .fields
                .get("seatedAt")
                .and_then(Value::as_array)
                .ok_or_else(|| anyhow!("SeatsSet.seatedAt is missing"))?;
            if seats.len() != 5 || at.len() != 5 {
                bail!(
                    "SeatsSet names {} seats and {} times, not 5 and 5",
                    seats.len(),
                    at.len()
                );
            }
            let zero = hex0x(&[0u8; 20]);
            let mut next = std::array::from_fn(|_| SeatSeen::default());
            for (i, slot) in next.iter_mut().enumerate() {
                let who = seats[i]
                    .as_str()
                    .ok_or_else(|| anyhow!("SeatsSet.seats[{i}] is not an address"))?;
                let when = at[i]
                    .as_str()
                    .ok_or_else(|| anyhow!("SeatsSet.seatedAt[{i}] is not a number"))?
                    .parse::<u64>()
                    .with_context(|| format!("SeatsSet.seatedAt[{i}]"))?;
                *slot = SeatSeen {
                    who: (who != zero).then(|| who.to_owned()),
                    seated_at: when,
                };
            }
            seen.seats = next;
            seen.generation = u32::try_from(num(row, "generation")?).context("generation")?;
            seen.next_election = small(row, "nextElection")?;
        }
        "Proposed" => {
            let id = parse_id(row)?;
            let by = address(row, "by")?;
            let i = seat_index(seen, &by)?;
            if i >= 8 {
                bail!("seat {i} cannot be one bit of a proposal mask");
            }
            let proposal = ProposalSeen {
                at: row.time,
                generation: seen.generation,
                mask: 1u8 << i,
                selector: selector_bytes(row)?,
            };
            seen.proposals.insert(id, proposal);
        }
        "Agreed" => {
            let id = parse_id(row)?;
            let by = address(row, "by")?;
            let i = seat_index(seen, &by)?;
            let count = u8::try_from(num(row, "count")?).context("Agreed.count")?;
            let p = seen.proposals.get_mut(&id).ok_or_else(|| {
                anyhow!("Agreed names proposal {}, which is not pending", hex0x(&id))
            })?;
            if p.mask & (1u8 << i) != 0 {
                bail!("{} agreed twice to proposal {}", by, hex0x(&id));
            }
            p.mask |= 1u8 << i;
            if popcount(p.mask) != count {
                bail!(
                    "proposal {} says {count} agreements after one more, the mask holds {}",
                    hex0x(&id),
                    popcount(p.mask)
                );
            }
            if count >= THRESHOLD {
                // The third agreement runs the call and deletes the proposal; `Executed` follows.
                seen.proposals.remove(&id);
            }
        }
        "Withdrawn" => {
            let id = parse_id(row)?;
            let by = address(row, "by")?;
            let i = seat_index(seen, &by)?;
            let count = u8::try_from(num(row, "count")?).context("Withdrawn.count")?;
            let p = seen.proposals.get_mut(&id).ok_or_else(|| {
                anyhow!(
                    "Withdrawn names proposal {}, which is not pending",
                    hex0x(&id)
                )
            })?;
            if p.mask & (1u8 << i) == 0 {
                bail!(
                    "{} took back an agreement it never gave on {}",
                    by,
                    hex0x(&id)
                );
            }
            p.mask &= !(1u8 << i);
            if popcount(p.mask) != count {
                bail!(
                    "proposal {} says {count} agreements after one fewer, the mask holds {}",
                    hex0x(&id),
                    popcount(p.mask)
                );
            }
            if count == 0 {
                // The last agreement taken back deletes the proposal; `Cancelled` follows.
                seen.proposals.remove(&id);
            }
        }
        "Executed" | "Cancelled" => {
            let id = parse_id(row)?;
            seen.proposals.remove(&id);
        }
        "Resigned" => {
            let seat = u8::try_from(num(row, "seat")?).context("Resigned.seat")?;
            let at = usize::from(seat);
            let slot = seen
                .seats
                .get_mut(at)
                .ok_or_else(|| anyhow!("Resigned names seat {seat}, past the five"))?;
            let who = address(row, "who")?;
            if slot.who.as_deref() != Some(who.as_str()) {
                bail!("Resigned says {who} left seat {seat}, which is not theirs");
            }
            *slot = SeatSeen::default();
            // `SeatsSet` follows with the whole picture and the new generation.
        }
        _ => return Ok(false),
    }
    Ok(true)
}

fn parse_id(row: &LogRow) -> anyhow::Result<[u8; 32]> {
    super::word::parse_fixed::<32>(text(row, "id")?)
        .ok_or_else(|| anyhow!("{}.id is not 32 bytes", row.event))
}

/// Apply one log of the vote contract. Returns whether the event is one the ledger counts.
pub fn apply_vote(row: &LogRow, seen: &mut VoteSeen) -> anyhow::Result<bool> {
    match row.event.as_str() {
        "BallotOpened" => {
            let id = u32::try_from(num(row, "id")?).context("BallotOpened.id")?;
            let kind = u8::try_from(num(row, "kind")?).context("BallotOpened.kind")?;
            if !matches!(kind, 1 | 2) {
                bail!("ballot {id} had kind {kind}, not replace (1) or seats (2)");
            }
            let mut options = BTreeMap::new();
            options.insert(0u8, KEEP.clone());
            seen.ballots.insert(
                id,
                BallotSeen {
                    id,
                    kind,
                    opened_at: small(row, "openedAt")?,
                    stand_end: small(row, "standEnd")?,
                    vote_end: small(row, "voteEnd")?,
                    effective_at: small(row, "effectiveAt")?,
                    supply: num(row, "supply")?,
                    floor: num(row, "floor")?,
                    up_a: u8::try_from(num(row, "upA")?).context("upA")?,
                    up_b: u8::try_from(num(row, "upB")?).context("upB")?,
                    options,
                    tallies: BTreeMap::new(),
                    cast: 0,
                    finished: None,
                    carried_out_at: None,
                    carried_out_council: None,
                    lapsed: false,
                    lapsed_at: None,
                    opened_block_time: row.time,
                },
            );
            seen.newest = Some(seen.newest.map_or(id, |newest| newest.max(id)));
            // Bound the history: the record needs the newest ballot and the recent past, never the whole chain.
            while seen.ballots.len() > MAX_BALLOTS {
                if let Some(oldest) = seen.ballots.keys().next().copied() {
                    seen.ballots.remove(&oldest);
                }
            }
        }
        "Stood" => {
            let id = u32::try_from(num(row, "id")?).context("Stood.id")?;
            let option = u8::try_from(num(row, "option")?).context("Stood.option")?;
            if option == 0 || option >= 13 {
                bail!("Stood names option {option}, outside 1 to 12");
            }
            let count = u8::try_from(num(row, "count")?).context("Stood.count")?;
            let members = row
                .fields
                .get("members")
                .and_then(Value::as_array)
                .ok_or_else(|| anyhow!("Stood.members is missing"))?;
            let take = usize::from(count).min(members.len());
            let members: Vec<String> = members[..take]
                .iter()
                .map(|m| {
                    m.as_str().map(str::to_owned).ok_or_else(|| {
                        anyhow!("Stood.members holds something that is not an address")
                    })
                })
                .collect::<anyhow::Result<_>>()?;
            let kind = match count {
                1 => OptionKind::Person,
                5 => OptionKind::List,
                n => bail!("Stood says {n} members: not one person or a list of five"),
            };
            let record_hash = text(row, "recordHash")?.to_owned();
            let displaced = address(row, "displaced")?;
            let zero = hex0x(&[0u8; 20]);
            let ballot = seen.ballot(id, "Stood")?;
            // A displacing Stood takes the displaced option's place (the event's `option` is that option); its tally
            // stays, as the contract keeps it.
            if displaced != zero {
                let current = ballot
                    .options
                    .get(&option)
                    .and_then(|o| o.proposer.as_deref());
                if current != Some(displaced.as_str()) {
                    bail!(
                        "Stood says it displaced {displaced} from option {option}, which is not theirs"
                    );
                }
            }
            ballot.options.insert(
                option,
                OptionSeen {
                    kind,
                    members,
                    proposer: Some(address(row, "by")?),
                    record_hash: Some(record_hash),
                },
            );
        }
        "Voted" => {
            let id = u32::try_from(num(row, "id")?).context("Voted.id")?;
            let option = u8::try_from(num(row, "option")?).context("Voted.option")?;
            let from = u8::try_from(num(row, "fromOption")?).context("Voted.fromOption")?;
            let option_tally = num(row, "optionTally")?;
            let cast = num(row, "castTotal")?;
            let ballot = seen.ballot(id, "Voted")?;
            ballot.tallies.insert(option, option_tally);
            if from != u8::MAX {
                // A move: the option it left is set to the absolute tally the event carries, so no stale tally stays.
                set_move_tally(ballot, from, num(row, "fromTally")?)?;
            }
            ballot.cast = cast;
        }
        "Fell" => {
            let id = u32::try_from(num(row, "id")?).context("Fell.id")?;
            let option = u8::try_from(num(row, "option")?).context("Fell.option")?;
            let option_tally = num(row, "optionTally")?;
            let cast = num(row, "castTotal")?;
            let ballot = seen.ballot(id, "Fell")?;
            ballot.tallies.insert(option, option_tally);
            ballot.cast = cast;
        }
        "BallotFinished" => {
            let id = u32::try_from(num(row, "id")?).context("BallotFinished.id")?;
            let outcome = u8::try_from(num(row, "outcome")?).context("outcome")?;
            let winner = u8::try_from(num(row, "winner")?).context("winner")?;
            let winner_b = u8::try_from(num(row, "winnerB")?).context("winnerB")?;
            let cast_total = num(row, "castTotal")?;
            let ballot = seen.ballot(id, "BallotFinished")?;
            if ballot.cast != cast_total {
                bail!(
                    "ballot {id} says {cast_total} cast when it finished, its votes add up to {}",
                    ballot.cast
                );
            }
            ballot.finished = Some(Finished {
                outcome,
                winner,
                winner_b,
                cast_total,
            });
        }
        "BallotCarriedOut" => {
            let id = u32::try_from(num(row, "id")?).context("BallotCarriedOut.id")?;
            let council = address(row, "council")?;
            let ballot = seen.ballot(id, "BallotCarriedOut")?;
            ballot.carried_out_at = Some(row.time);
            let zero = hex0x(&[0u8; 20]);
            ballot.carried_out_council = (council != zero).then_some(council);
        }
        "BallotLapsed" => {
            let id = u32::try_from(num(row, "id")?).context("BallotLapsed.id")?;
            let ballot = seen.ballot(id, "BallotLapsed")?;
            ballot.lapsed = true;
            ballot.lapsed_at = Some(row.time);
        }
        _ => return Ok(false),
    }
    Ok(true)
}

/// Set a moved vote's old option to the absolute tally the event carries.
fn set_move_tally(ballot: &mut BallotSeen, from: u8, from_tally: u128) -> anyhow::Result<()> {
    if from >= 13 {
        bail!("a move left option {from}, past the 13 a ballot offers");
    }
    ballot.tallies.insert(from, from_tally);
    Ok(())
}
