//! The Council runner's two record keys, `runner.kind`/`runner.seats`, `council` and `vote`:
//! `docs/next-version/COUNCIL-PLAN.md` section 5.2, built from the events (`ledger_council`) and the contracts' views
//! at `asOf.block` (`views`).
//!
//! Every number a sentence needs is read from the contracts (`vote.rule`), so no screen types one. The result is
//! **derived from the frozen tallies from `voteEnd` on**, exactly as the contract's `_compute` does, so the card and the
//! alerts show it with nobody pressing `finish` (COUNCIL-PLAN.md section 2.6); a recorded `BallotFinished` must agree
//! with it, and a disagreement signs `vote: null` with one line for the log.
//!
//! The tallies are absolute numbers the contract carries on each `Voted` and `Fell`. Nothing here — or in the ledger —
//! holds a voter's address or a per-voter amount: the record has option tallies only.
//!
//! A key that cannot be worked out, or whose checks fail, is `null` with its reason returned for the log; nothing else
//! in the record depends on it.

use std::collections::BTreeMap;

use anyhow::{anyhow, bail, Context};
use serde::{Deserialize, Serialize};

use super::ledger::Ledger;
use super::ledger_council::{call_kind, BallotSeen, OptionKind};
use super::record::{amount, is_hex, Record};
use super::views::{CouncilViews, Views, VoteViews};

/// The most proposals `council.waiting.count` may count before the list is marked truncated (the key stays bounded).
pub const MAX_WAITING: u64 = 200;
/// The waiting proposals' kinds, in the order the record lists them (13 at most).
pub const WAITING_KINDS: [&str; 13] = [
    "draw", "checkIn", "rate", "door", "plan", "accept", "reject", "cancel", "grant", "helper",
    "handOver", "windDown", "other",
];
/// How long a ballot that ended without effect stays in the record, in days (`unit / 7` seconds each).
pub const ENDED_DAYS: u64 = 3;
/// One whole Share in wei (`HolderVote.MIN_VOTE`), the smallest tally a person needs to take a seat.
const ONE_SHARE: u128 = 1_000_000_000_000_000_000;

/// One seat of the Council section.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CouncilSeatRec {
    /// The account, or none for an open seat.
    pub account: Option<String>,
    /// When it was seated, or none for an open seat.
    pub seated_at: Option<u64>,
}

/// One kind of waiting proposal and how many of that kind.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WaitingKindRec {
    /// `draw`, `checkIn`, `rate`, `door`, `plan`, `accept`, `reject`, `cancel`, `grant`, `helper`, `handOver`,
    /// `windDown` or `other`.
    pub kind: String,
    /// How many proposals of that kind still wait.
    pub count: u64,
}

/// The Council's open proposals, counted, never their bytes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WaitingRec {
    /// How many proposals still wait (at most [`MAX_WAITING`]).
    pub count: u64,
    /// The same, by kind (at most 13 entries, in [`WAITING_KINDS`] order).
    pub kinds: Vec<WaitingKindRec>,
    /// True when more proposals wait than the cap counts.
    pub truncated: bool,
}

/// The project's Council (COUNCIL-PLAN.md section 5.2).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CouncilRec {
    /// The Council contract.
    pub contract: String,
    /// The five seats in order; null for an open seat.
    pub seats: [CouncilSeatRec; 5],
    /// How many seats must agree.
    pub needed: u8,
    /// Goes up whenever any seat changes.
    pub generation: u32,
    /// When two seats next come up.
    pub next_election: u64,
    /// Which two seats come up.
    pub up_seats: [u8; 2],
    /// The proposals still open.
    pub waiting: WaitingRec,
}

/// Every number a vote sentence needs, from the contract's constants and views (COUNCIL-PLAN.md section 2.4).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RuleRec {
    /// The stand window, in seconds (`STAND_DAYS` days).
    pub stand_secs: u64,
    /// The vote length, in seconds (`VOTE_DAYS` days).
    pub vote_secs: u64,
    /// The wait before a result takes effect: the Treasury's longest task notice.
    pub wait_secs: u64,
    /// The turnout floor is one this-many-th of the snapshot's Shares.
    pub floor_divisor: u64,
    /// To open a replace vote, the Shares parked in all must be one this-many-th of the Shares.
    pub open_divisor: u64,
    /// To stand, an account needs one this-many-th of the snapshot's Shares.
    pub stand_divisor: u64,
    /// The replace cooldown after a "kept" result that met the floor, in seconds.
    pub cooldown_secs: u64,
    /// Two seats come up every this many seconds.
    pub seats_every_secs: u64,
    /// A proposal lives this long, in seconds.
    pub proposal_ttl_secs: u64,
    /// How many seats must agree to a Council action.
    pub needed: u8,
    /// The number of Council seats.
    pub seats: u8,
    /// The most lists a replace ballot offers.
    pub max_lists: u8,
    /// The most people a seat ballot offers.
    pub max_people: u8,
    /// The smallest weight that can be cast (18 decimals).
    pub min_vote: String,
}

/// One choice on the open ballot.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct VoteOptionRec {
    /// Its number (0 is always "keep").
    pub index: u8,
    /// `keep`, `list` or `person`.
    pub kind: String,
    /// The list's five accounts, or the one person (empty for "keep").
    pub members: Vec<String>,
    /// Who put it forward; none for "keep".
    pub proposer: Option<String>,
    /// The signed text's id; none for "keep".
    pub record_hash: Option<String>,
    /// Its Shares (18 decimals).
    pub tally: String,
}

/// The result the frozen tallies give.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VoteResultRec {
    /// `short`, `kept`, `moved`, `seated` or `unchanged`.
    pub outcome: String,
    /// The winning option numbers (at most 2).
    pub winners: Vec<u8>,
    /// True once `BallotFinished` was seen; it must equal the derived result.
    pub recorded: bool,
}

/// The newest ballot worth showing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct OpenVoteRec {
    /// Its id.
    pub id: u32,
    /// `seats` or `replace`.
    pub kind: String,
    /// `standing`, `voting`, `counting`, `waiting`, `carried-out`, `ended` or `lapsed`.
    pub phase: String,
    /// When the ballot opened.
    pub opened_at: u64,
    /// When the stand window ends.
    pub stand_end: u64,
    /// When the vote ends; the tallies freeze here.
    pub vote_end: u64,
    /// When a won result takes effect.
    pub effective_at: u64,
    /// The backers' Shares at the snapshot (18 decimals).
    pub supply: String,
    /// The Shares that must be cast (18 decimals).
    pub floor: String,
    /// The Shares cast so far (18 decimals).
    pub cast: String,
    /// The choices.
    pub options: Vec<VoteOptionRec>,
    /// The derived result, from `voteEnd` on.
    pub result: Option<VoteResultRec>,
    /// When the result was put in.
    pub carried_out_at: Option<u64>,
}

/// What the next ballots allow.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct VoteNextRec {
    /// When two seats may be opened (`Council.nextElection`).
    pub seats_at: Option<u64>,
    /// When a replace vote may next open (the cooldown's end, or now).
    pub replace_from: Option<u64>,
    /// The parked Shares needed to open a replace vote now (1 in 20 of the supply).
    pub open_floor: String,
}

/// The project's vote contract (COUNCIL-PLAN.md section 5.2).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VoteRec {
    /// The vote contract (the project's pause).
    pub contract: String,
    /// Every number a sentence needs.
    pub rule: RuleRec,
    /// The newest ballot worth showing.
    pub open: Option<OpenVoteRec>,
    /// What the next ballots allow.
    pub next: VoteNextRec,
}

/// What a key came to: the value, and a line to log when it was left `null` for a reason.
pub type Built<T> = (Option<T>, Option<String>);

fn outcome_word(code: u8) -> &'static str {
    match code {
        1 => "short",
        2 => "kept",
        3 => "moved",
        4 => "seated",
        5 => "unchanged",
        _ => "short",
    }
}

/// Whether an outcome moves the runner or a seat (a result that has to be carried out).
fn is_won(outcome: &str) -> bool {
    matches!(outcome, "moved" | "seated")
}

/// The result the frozen tallies give, exactly as `HolderVote._compute` does (COUNCIL-PLAN.md section 2.6): a tie for
/// the last seat leaves that seat as it is.
pub fn derive_result(
    kind: u8,
    tallies: &BTreeMap<u8, u128>,
    option_count: u8,
    cast: u128,
    floor: u128,
    min_vote: u128,
) -> (u8, Vec<u8>) {
    if cast < floor {
        return (1, Vec::new());
    }
    let tally = |i: u8| tallies.get(&i).copied().unwrap_or(0);
    if kind == 1 {
        for i in 1..option_count {
            if tally(i).saturating_mul(2) > cast {
                return (3, vec![i]);
            }
        }
        return (2, Vec::new());
    }
    let keep = tally(0);
    let mut best: u128 = 0;
    let mut best_at: u8 = 0;
    let mut second: u128 = 0;
    let mut second_at: u8 = 0;
    for i in 1..option_count {
        let t = tally(i);
        if t < min_vote || t <= keep {
            continue;
        }
        if best_at == 0 || t > best {
            (second, second_at) = (best, best_at);
            (best, best_at) = (t, i);
        } else if second_at == 0 || t > second {
            (second, second_at) = (t, i);
        }
    }
    if best_at == 0 {
        return (5, Vec::new());
    }
    if second_at != 0 && second < best {
        (4, vec![best_at, second_at])
    } else {
        (4, vec![best_at])
    }
}

fn runner_word(kind: u8) -> &'static str {
    match kind {
        1 => "pair",
        2 => "council",
        _ => "single",
    }
}

/// `runner.kind` and `runner.seats` from the views (COUNCIL-PLAN.md section 5.2): the kind of the runner at
/// `asOf.block`, and for a Council the number of distinct non-zero live seats.
pub fn runner(v: &Views) -> (Option<String>, Option<u64>) {
    let kind = runner_word(v.runner_kind).to_owned();
    let seats = if v.runner_kind == 2 {
        v.council.as_ref().and_then(|c| c.as_ref().ok()).map(|c| {
            let mut live: Vec<&str> = c.seats.iter().filter_map(|s| s.as_deref()).collect();
            live.sort_unstable();
            live.dedup();
            live.len() as u64
        })
    } else {
        None
    };
    (Some(kind), seats)
}

/// The `council` key: `null` unless the runner is a Council, and `null` too when its views could not be read or did
/// not agree with the events.
pub fn council(ledger: &Ledger, v: &Views, time: u64) -> Built<CouncilRec> {
    let Some(read) = &v.council else {
        return (None, None);
    };
    let outcome = match read {
        Ok(read) => council_from(ledger, v, read, time),
        Err(e) => Err(anyhow!("{e}")),
    };
    match outcome {
        Ok(rec) => (Some(rec), None),
        Err(e) => (None, Some(format!("council: left null: {e:#}"))),
    }
}

fn council_from(
    ledger: &Ledger,
    _v: &Views,
    c: &CouncilViews,
    time: u64,
) -> anyhow::Result<CouncilRec> {
    if ledger.contracts.council.as_deref() != Some(c.address.as_str()) {
        bail!("the Council read is not the one the Launcher named");
    }
    // The seats are the view's: the event's own picture must be the same one.
    let seen = &ledger.council;
    if seen.generation != c.generation {
        bail!(
            "the events say generation {}, the Council says {}",
            seen.generation,
            c.generation
        );
    }
    if seen.next_election != c.next_election {
        bail!(
            "the events say the next election is at {}, the Council says {}",
            seen.next_election,
            c.next_election
        );
    }
    let mut seats = std::array::from_fn(|_| CouncilSeatRec {
        account: None,
        seated_at: None,
    });
    for (i, seat) in seats.iter_mut().enumerate() {
        if seen.seats[i].who != c.seats[i] {
            bail!(
                "seat {i} is {} in the events and {} in the Council",
                seen.seats[i].who.as_deref().unwrap_or("open"),
                c.seats[i].as_deref().unwrap_or("open")
            );
        }
        if seen.seats[i].seated_at != c.seated_at[i] {
            bail!(
                "seat {i} was taken at {} in the events and at {} in the Council",
                seen.seats[i].seated_at,
                c.seated_at[i]
            );
        }
        *seat = CouncilSeatRec {
            account: c.seats[i].clone(),
            seated_at: c.seats[i].is_some().then_some(c.seated_at[i]),
        };
    }
    if c.up_seats[0] > 4 || c.up_seats[1] > 4 {
        bail!(
            "the seats that come up are {} and {}, not 0 to 4",
            c.up_seats[0],
            c.up_seats[1]
        );
    }
    // The proposals that may still run: this generation, agreed to at least once, not expired (COUNCIL-PLAN.md 5.2).
    let mut kinds: BTreeMap<&'static str, u64> = BTreeMap::new();
    let mut waiting = 0u64;
    for p in seen.proposals.values() {
        let expired = p.at.saturating_add(c.proposal_ttl) < time;
        if p.generation != c.generation || p.mask == 0 || expired {
            continue;
        }
        *kinds.entry(call_kind(p.selector)).or_insert(0) += 1;
        waiting += 1;
    }
    let mut waiting = WaitingRec {
        count: waiting.min(MAX_WAITING),
        kinds: WAITING_KINDS
            .iter()
            .filter_map(|kind| {
                kinds.get(*kind).map(|count| WaitingKindRec {
                    kind: (*kind).to_owned(),
                    count: *count,
                })
            })
            .collect(),
        truncated: waiting_count(&kinds) > MAX_WAITING,
    };
    // The kinds list is bounded by construction (13 words); the count is capped, and the flag says when it was.
    waiting.kinds.truncate(WAITING_KINDS.len());
    Ok(CouncilRec {
        contract: c.address.clone(),
        seats,
        needed: c.needed,
        generation: c.generation,
        next_election: c.next_election,
        up_seats: c.up_seats,
        waiting,
    })
}

fn waiting_count(kinds: &BTreeMap<&'static str, u64>) -> u64 {
    kinds.values().copied().sum()
}

/// The `vote` key: `null` when the project has no vote contract, and `null` too when a rule's check fails.
pub fn vote(ledger: &Ledger, v: &Views, time: u64) -> Built<VoteRec> {
    let Some(read) = &v.vote else {
        return (None, None);
    };
    let outcome = match read {
        Ok(read) => vote_from(ledger, v, read, time),
        Err(e) => Err(anyhow!("{e}")),
    };
    match outcome {
        Ok(rec) => (Some(rec), None),
        Err(e) => (None, Some(format!("vote: left null: {e:#}"))),
    }
}

fn vote_from(ledger: &Ledger, v: &Views, read: &VoteViews, time: u64) -> anyhow::Result<VoteRec> {
    if ledger.contracts.pause.as_deref() != Some(read.address.as_str()) {
        bail!("the vote read is not the project's pause");
    }
    let unit = ledger.unit;
    if read.day == 0 || read.day != unit / 7 {
        bail!(
            "the day is {} seconds, a seventh of the {unit} unit is {}",
            read.day,
            unit / 7
        );
    }
    let unit_secs = u128::from(unit);
    let rule = RuleRec {
        stand_secs: u64::try_from(
            read.stand_days
                .checked_mul(u128::from(read.day))
                .ok_or_else(|| anyhow!("the stand window overflows"))?,
        )?,
        vote_secs: u64::try_from(
            read.vote_days
                .checked_mul(u128::from(read.day))
                .ok_or_else(|| anyhow!("the vote length overflows"))?,
        )?,
        wait_secs: read.wait_secs,
        floor_divisor: u64::try_from(read.line_divisor).context("LINE_DIVISOR is too large")?,
        open_divisor: u64::try_from(read.open_divisor).context("OPEN_DIVISOR is too large")?,
        stand_divisor: u64::try_from(read.stand_divisor).context("STAND_DIVISOR is too large")?,
        cooldown_secs: u64::try_from(
            read.cooldown_units
                .checked_mul(unit_secs)
                .ok_or_else(|| anyhow!("the cooldown overflows"))?,
        )?,
        seats_every_secs: u64::try_from(
            u128::from(read.council_election_units)
                .checked_mul(unit_secs)
                .ok_or_else(|| anyhow!("the election interval overflows"))?,
        )?,
        proposal_ttl_secs: u64::try_from(
            u128::from(read.council_proposal_units)
                .checked_mul(unit_secs)
                .ok_or_else(|| anyhow!("a proposal's life overflows"))?,
        )?,
        needed: read.council_needed,
        seats: read.council_seats,
        max_lists: read.max_lists,
        max_people: read.max_people,
        min_vote: read.min_vote.to_string(),
    };
    // The plan's own sentences: the stand window is the pause's day times 1, the vote times 3, and the wait is the
    // Treasury's longest notice at this same block.
    if rule.stand_secs != read.day {
        bail!(
            "the stand window is {} seconds, not one day ({})",
            rule.stand_secs,
            read.day
        );
    }
    if rule.vote_secs != 3 * read.day {
        bail!(
            "the vote length is {} seconds, not three days ({})",
            rule.vote_secs,
            3 * read.day
        );
    }
    // The Council the vote seats must have the shape the rule says.
    if rule.seats != 5 {
        bail!("the Council has {} seats, not 5", rule.seats);
    }
    if !(1..=5).contains(&rule.needed) {
        bail!("{} seats must agree, not 1 to 5", rule.needed);
    }
    if let Some(Ok(c)) = &v.council {
        if c.needed != rule.needed || c.seats.len() != usize::from(rule.seats) {
            bail!(
                "the Council says {} seats and {} needed, the rule says {} and {}",
                c.seats.len(),
                c.needed,
                rule.seats,
                rule.needed
            );
        }
    }
    let next = VoteNextRec {
        seats_at: v
            .council
            .as_ref()
            .and_then(|c| c.as_ref().ok())
            .map(|c| c.next_election),
        replace_from: Some(read.next_replace_at.max(time)),
        open_floor: shares_div_ceil(v.shares_supply, read.open_divisor)?.to_string(),
    };
    let open = match ledger.vote.newest_ballot() {
        Some(ballot) => open_from(ledger, read, &rule, ballot, time)?,
        None => None,
    };
    Ok(VoteRec {
        contract: read.address.clone(),
        rule,
        open,
        next,
    })
}

fn shares_div_ceil(shares: u128, divisor: u128) -> anyhow::Result<u128> {
    if divisor == 0 {
        bail!("the divisor is zero");
    }
    shares
        .checked_add(divisor - 1)
        .map(|n| n / divisor)
        .ok_or_else(|| anyhow!("the Shares over the divisor overflow"))
}

/// The newest ballot, when it is worth showing, with every check of COUNCIL-PLAN.md section 5.2 run over it.
fn open_from(
    ledger: &Ledger,
    read: &VoteViews,
    rule: &RuleRec,
    ballot: &BallotSeen,
    time: u64,
) -> anyhow::Result<Option<OpenVoteRec>> {
    // The times, in order, and built from the rule's own numbers.
    if !(ballot.opened_at < ballot.stand_end
        && ballot.stand_end < ballot.vote_end
        && ballot.vote_end < ballot.effective_at)
    {
        bail!(
            "ballot {} has its times out of order: {} {} {} {}",
            ballot.id,
            ballot.opened_at,
            ballot.stand_end,
            ballot.vote_end,
            ballot.effective_at
        );
    }
    if ballot.stand_end - ballot.opened_at != rule.stand_secs {
        bail!(
            "ballot {}'s stand window is {} seconds, the rule says {}",
            ballot.id,
            ballot.stand_end - ballot.opened_at,
            rule.stand_secs
        );
    }
    if ballot.vote_end - ballot.stand_end != rule.vote_secs {
        bail!(
            "ballot {}'s vote is {} seconds, the rule says {}",
            ballot.id,
            ballot.vote_end - ballot.stand_end,
            rule.vote_secs
        );
    }
    if ballot.effective_at - ballot.vote_end != rule.wait_secs {
        bail!(
            "ballot {} waits {} seconds, the Treasury's notice says {}",
            ballot.id,
            ballot.effective_at - ballot.vote_end,
            rule.wait_secs
        );
    }
    // The floor is a third of the snapshot, rounded up; the supply is what the events say.
    let want_floor = shares_div_ceil(ballot.supply, u128::from(rule.floor_divisor))?;
    if ballot.floor != want_floor {
        bail!(
            "ballot {}'s floor is {}, {} Shares over {} give {}",
            ballot.id,
            ballot.floor,
            ballot.supply,
            rule.floor_divisor,
            want_floor
        );
    }
    if ballot.floor > ballot.supply {
        bail!(
            "ballot {}'s floor {} is more than its supply {}",
            ballot.id,
            ballot.floor,
            ballot.supply
        );
    }
    // The tallies add up to the cast total, always; the cast never passes the supply, and never passes what is parked
    // while the vote runs (the tallies freeze at `voteEnd`, and winners may take their Shares out the second after).
    let count = ballot.option_count();
    if count == 0 || count > 13 {
        bail!("ballot {} offers {count} options, not 1 to 13", ballot.id);
    }
    let sum = ballot.tally_sum();
    if sum != ballot.cast {
        bail!(
            "ballot {}'s tallies add up to {}, its cast total is {}",
            ballot.id,
            sum,
            ballot.cast
        );
    }
    if ballot.cast > ballot.supply {
        bail!(
            "ballot {}'s cast {} is more than the {} Shares at its snapshot",
            ballot.id,
            ballot.cast,
            ballot.supply
        );
    }
    if time < ballot.vote_end && ballot.cast > read.parked_total {
        bail!(
            "ballot {}'s cast {} is more than the {} Shares parked while its vote runs",
            ballot.id,
            ballot.cast,
            read.parked_total
        );
    }
    if ballot.kind == 2 {
        if u64::from(count.saturating_sub(1)) > u64::from(rule.max_people) {
            bail!(
                "ballot {} offers {} people, the rule allows {}",
                ballot.id,
                count - 1,
                rule.max_people
            );
        }
    } else {
        if u64::from(count.saturating_sub(1)) > u64::from(rule.max_lists) {
            bail!(
                "ballot {} offers {} lists, the rule allows {}",
                ballot.id,
                count - 1,
                rule.max_lists
            );
        }
        // "keep" is option 0, a list is five accounts, and no other kind can be on a replace ballot.
        for (i, option) in ballot.options_in_order() {
            if i > 0 && option.kind != OptionKind::List {
                bail!("ballot {}'s option {i} is not a list", ballot.id);
            }
        }
    }
    // A seat ballot's options are one person each (the check is apart from the list one above).

    if ballot.kind == 2 {
        for (i, option) in ballot.options_in_order() {
            if i > 0 && option.kind != OptionKind::Person {
                bail!("ballot {}'s option {i} is not a person", ballot.id);
            }
        }
    }
    // The result, from the frozen tallies, and the recorded one must be the same.
    let (outcome_code, winners) = derive_result(
        ballot.kind,
        &ballot.tallies,
        count,
        ballot.cast,
        ballot.floor,
        read.min_vote,
    );
    let outcome = outcome_word(outcome_code);
    if let Some(finished) = ballot.finished {
        if finished.outcome != outcome_code {
            bail!(
                "ballot {} was recorded as {} but the frozen tallies give {}",
                ballot.id,
                outcome_word(finished.outcome),
                outcome
            );
        }
        let recorded_winners: Vec<u8> = [finished.winner, finished.winner_b]
            .into_iter()
            .filter(|w| *w != 0)
            .collect();
        if recorded_winners != winners {
            bail!(
                "ballot {} was recorded as winners {recorded_winners:?} but the frozen tallies give {winners:?}",
                ballot.id
            );
        }
        if finished.cast_total != ballot.cast {
            bail!(
                "ballot {} was recorded with {} cast, the tallies add up to {}",
                ballot.id,
                finished.cast_total,
                ballot.cast
            );
        }
    }
    let day = rule.stand_secs.max(1);
    let lapse_at = ballot.effective_at.saturating_add(
        u64::try_from(read.lapse_units)
            .unwrap_or(u64::MAX)
            .saturating_mul(ledger.unit),
    );
    let lapsed =
        ballot.lapsed || (is_won(outcome) && ballot.carried_out_at.is_none() && time > lapse_at);
    // Which ballots the record shows: the newest one, until it is carried out, lapsed, or ended without effect more
    // than three days ago (COUNCIL-PLAN.md section 5.2).
    let show = if ballot.carried_out_at.is_some() || lapsed {
        false
    } else if is_won(outcome) {
        true
    } else {
        time <= ballot.vote_end.saturating_add(ENDED_DAYS * day)
    };
    if !show {
        return Ok(None);
    }
    let result = (time >= ballot.vote_end).then(|| VoteResultRec {
        outcome: outcome.to_owned(),
        winners: winners.clone(),
        recorded: ballot.finished.is_some(),
    });
    let phase = if ballot.carried_out_at.is_some() {
        "carried-out"
    } else if lapsed {
        "lapsed"
    } else if time < ballot.stand_end {
        "standing"
    } else if time < ballot.vote_end {
        "voting"
    } else if !is_won(outcome) {
        "ended"
    } else if time < ballot.effective_at {
        "waiting"
    } else {
        // The wait is over: the result is due and being carried out; it lapses two time units later.
        "counting"
    };
    let options = ballot
        .options_in_order()
        .into_iter()
        .map(|(i, option)| VoteOptionRec {
            index: i,
            kind: option.kind.as_str().to_owned(),
            members: option.members.clone(),
            proposer: option.proposer.clone(),
            record_hash: option.record_hash.clone(),
            tally: ballot.tallies.get(&i).copied().unwrap_or(0).to_string(),
        })
        .collect();
    Ok(Some(OpenVoteRec {
        id: ballot.id,
        kind: if ballot.kind == 2 { "seats" } else { "replace" }.to_owned(),
        phase: phase.to_owned(),
        opened_at: ballot.opened_at,
        stand_end: ballot.stand_end,
        vote_end: ballot.vote_end,
        effective_at: ballot.effective_at,
        supply: ballot.supply.to_string(),
        floor: ballot.floor.to_string(),
        cast: ballot.cast.to_string(),
        options,
        result,
        carried_out_at: ballot.carried_out_at,
    }))
}

/// The rules of the two keys over a finished record (called from [`super::record::validate`]); a key that is `null`
/// has none.
pub fn check(r: &Record, bad: &mut Vec<String>) -> anyhow::Result<()> {
    let mut rule = |ok: bool, what: String| {
        if !ok {
            bad.push(what);
        }
    };
    if let Some(kind) = &r.runner.kind {
        rule(
            matches!(kind.as_str(), "single" | "pair" | "council"),
            format!("runner.kind is {kind}"),
        );
        rule(
            (kind == "pair") == r.runner.is_pair,
            "runner.kind and runner.isPair disagree".into(),
        );
        rule(
            (kind == "council") == r.runner.seats.is_some(),
            "runner.seats is set exactly for a Council".into(),
        );
    }
    if let Some(seats) = r.runner.seats {
        rule(seats <= 5, format!("runner.seats is {seats}, not 0 to 5"));
    }
    if let Some(c) = &r.council {
        rule(
            is_hex(&c.contract, 20) && r.runner.kind.as_deref() == Some("council"),
            "council.contract is not the Council the runner is".into(),
        );
        let live = c
            .seats
            .iter()
            .filter(|s| s.account.as_deref().is_some_and(|a| is_hex(a, 20)))
            .count() as u64;
        rule(
            c.seats
                .iter()
                .all(|s| s.account.is_some() == s.seated_at.is_some()),
            "council.seats: an account is set exactly when a time is".into(),
        );
        rule(
            r.runner.seats == Some(live),
            "council.seats' accounts are not runner.seats".into(),
        );
        rule(
            (1..=5).contains(&c.needed),
            format!("council.needed is {}", c.needed),
        );
        rule(
            c.up_seats.iter().all(|s| *s <= 4),
            "council.upSeats is not two seats 0 to 4".into(),
        );
        rule(
            c.waiting.count <= MAX_WAITING,
            "council.waiting.count is past its bound".into(),
        );
        rule(
            c.waiting.kinds.len() <= WAITING_KINDS.len()
                && c.waiting
                    .kinds
                    .iter()
                    .all(|k| WAITING_KINDS.contains(&k.kind.as_str())),
            "council.waiting.kinds names a kind not in the list".into(),
        );
        rule(
            c.waiting.kinds.iter().map(|k| k.count).sum::<u64>() >= c.waiting.count,
            "council.waiting.kinds add up to less than council.waiting.count".into(),
        );
    }
    if let Some(other) = &r.vote {
        rule(
            is_hex(&other.contract, 20)
                && r.contracts.pause.as_deref() == Some(other.contract.as_str()),
            "vote.contract is not contracts.pause".into(),
        );
        let numbers = [
            other.rule.stand_secs,
            other.rule.vote_secs,
            other.rule.wait_secs,
            other.rule.cooldown_secs,
            other.rule.seats_every_secs,
            other.rule.proposal_ttl_secs,
        ];
        rule(
            numbers.iter().all(|n| *n > 0),
            "vote.rule has a zero where a time is needed".into(),
        );
        rule(
            other.rule.floor_divisor > 0
                && other.rule.open_divisor > 0
                && other.rule.stand_divisor > 0,
            "vote.rule has a zero divisor".into(),
        );
        rule(
            (1..=5).contains(&other.rule.needed),
            format!("vote.rule.needed is {}", other.rule.needed),
        );
        rule(
            other.rule.max_lists > 0 && other.rule.max_people > 0,
            "vote.rule allows no lists or no people".into(),
        );
        rule(
            amount(&other.rule.min_vote, "vote.rule.minVote")? > 0,
            "vote.rule.minVote is zero".into(),
        );
        rule(
            other.next.replace_from.is_some(),
            "vote.next.replaceFrom is never null while there is a vote contract".into(),
        );
        amount(&other.next.open_floor, "vote.next.openFloor")?;
        if let Some(open) = &other.open {
            let (opened, stand, vote_end, effective) = (
                open.opened_at,
                open.stand_end,
                open.vote_end,
                open.effective_at,
            );
            rule(
                opened < stand && stand < vote_end && vote_end < effective,
                "vote.open's times are not in order".into(),
            );
            rule(
                stand - opened == other.rule.stand_secs
                    && vote_end - stand == other.rule.vote_secs
                    && effective - vote_end == other.rule.wait_secs,
                "vote.open's windows are not the rule's".into(),
            );
            let (supply, floor, cast) = (
                amount(&open.supply, "vote.open.supply")?,
                amount(&open.floor, "vote.open.floor")?,
                amount(&open.cast, "vote.open.cast")?,
            );
            rule(
                floor == shares_div_ceil(supply, u128::from(other.rule.floor_divisor))?,
                "vote.open.floor is not the rule's share of the supply".into(),
            );
            rule(
                cast <= supply,
                format!("vote.open.cast {cast} is more than its supply {supply}"),
            );
            let sum: u128 = open
                .options
                .iter()
                .map(|o| amount(&o.tally, "vote.open.option.tally"))
                .collect::<anyhow::Result<Vec<_>>>()?
                .into_iter()
                .sum();
            rule(
                sum == cast,
                format!("vote.open's tallies add up to {sum}, its cast is {cast}"),
            );
            rule(
                open.options.len() <= 13
                    && open
                        .options
                        .iter()
                        .enumerate()
                        .all(|(k, o)| usize::from(o.index) == k),
                "vote.open.options are not 1 to 13 in order".into(),
            );
            rule(
                matches!(open.kind.as_str(), "seats" | "replace"),
                format!("vote.open.kind is {}", open.kind),
            );
            rule(
                matches!(
                    open.phase.as_str(),
                    "standing"
                        | "voting"
                        | "counting"
                        | "waiting"
                        | "carried-out"
                        | "ended"
                        | "lapsed"
                ),
                format!("vote.open.phase is {}", open.phase),
            );
            let tallies: BTreeMap<u8, u128> = open
                .options
                .iter()
                .map(|o| Ok((o.index, amount(&o.tally, "vote.open.option.tally")?)))
                .collect::<anyhow::Result<_>>()?;
            let count = u8::try_from(open.options.len()).context("options")?;
            let (outcome, winners) = derive_result(
                if open.kind == "seats" { 2 } else { 1 },
                &tallies,
                count,
                cast,
                floor,
                amount(&other.rule.min_vote, "vote.rule.minVote")?,
            );
            if let Some(result) = &open.result {
                rule(
                    result.outcome == outcome_word(outcome) && result.winners == winners,
                    "vote.open.result is not the frozen tallies' result".into(),
                );
            }
            if open.phase == "ended" && is_won(outcome_word(outcome)) {
                rule(false, "vote.open.phase is ended for a won result".into());
            }
        }
    }
    // `runner.seats` is the Established rule's input: three or more live seats in a Council.
    Ok(())
}
