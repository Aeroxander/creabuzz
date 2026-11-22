//! The Council and the vote in the ledger (`ledger_council.rs`): the events of the third run rebuilt, every
//! `Stood`/`Voted`/`Fell` and proposal event checked, a mutated event refused, and 400 random votes, moves and unparks
//! replaying to the contract's own absolute tallies.

use std::collections::BTreeMap;

use serde_json::{json, Value};

use super::events::Role;
use super::fixture::Fixture;
use super::ledger::LogRow;
use super::ledger_council::{apply_vote, BallotSeen, CouncilSeen, VoteSeen};
use super::word::hex0x;

fn row(block: u64, log_index: u32, time: u64, role: Role, event: &str, fields: Value) -> LogRow {
    LogRow {
        block,
        log_index,
        time,
        tx: [0u8; 32],
        role,
        address: [0u8; 20],
        event: event.to_owned(),
        fields,
    }
}

/// The ballot the random replay votes in.
fn opened_ballot() -> LogRow {
    row(
        1,
        0,
        1_000,
        Role::Pause,
        "BallotOpened",
        json!({
            "id": "7", "kind": "1", "openedAt": "1000", "standEnd": "2000", "voteEnd": "3000",
            "effectiveAt": "4000", "supply": "10000000000000000000000", "floor": "3333333333333333333334",
            "upA": "0", "upB": "0", "by": hex0x(&[1u8; 20]),
        }),
    )
}

fn open(seen: &mut VoteSeen) {
    apply_vote(&opened_ballot(), seen).expect("the ballot opens");
}

fn vote_row(
    voter: usize,
    option: u8,
    weight: u128,
    option_tally: u128,
    cast: u128,
    from: u8,
    from_tally: u128,
) -> LogRow {
    let mut addr = [0u8; 20];
    addr[19] = u8::try_from(voter + 1).expect("a voter");
    row(
        2,
        u32::try_from(voter).expect("a voter"),
        2_000,
        Role::Pause,
        "Voted",
        json!({
            "id": "7", "who": hex0x(&addr), "option": option.to_string(), "weight": weight.to_string(),
            "optionTally": option_tally.to_string(), "castTotal": cast.to_string(),
            "fromOption": from.to_string(), "fromTally": from_tally.to_string(),
        }),
    )
}

fn fell_row(voter: usize, option: u8, weight: u128, option_tally: u128, cast: u128) -> LogRow {
    let mut addr = [0u8; 20];
    addr[19] = u8::try_from(voter + 1).expect("a voter");
    row(
        2,
        u32::try_from(voter).expect("a voter"),
        2_000,
        Role::Pause,
        "Fell",
        json!({
            "id": "7", "who": hex0x(&addr), "option": option.to_string(), "weight": weight.to_string(),
            "optionTally": option_tally.to_string(), "castTotal": cast.to_string(),
        }),
    )
}

/// The tallies of a ballot, zero entries left out, for comparing with the model's.
fn tallies(b: &BallotSeen) -> BTreeMap<u8, u128> {
    b.tallies
        .iter()
        .filter(|(_, v)| **v != 0)
        .map(|(k, v)| (*k, *v))
        .collect()
}

/// The contract carries absolute tallies on every `Voted` and `Fell`: the ledger sets them, so 400 random votes, moves
/// and unparks replay to exactly the contract's numbers, and a moved vote leaves no stale tally (COUNCIL-PLAN.md
/// section 5.1 and the K2 check that replays 400 random steps including moves).
#[test]
fn four_hundred_random_votes_moves_and_unparks_leave_the_contracts_tallies() {
    let mut seen = VoteSeen::default();
    open(&mut seen);
    // The model (the test's own, not the reader's): 20 voters with fixed weights, the same state a contract would keep.
    let weights: Vec<u128> = (0..20).map(|i| 1_000_000 + u128::from(i) * 7_777).collect();
    let mut cast_of: Vec<Option<(u8, u128)>> = vec![None; 20];
    let mut tally: BTreeMap<u8, u128> = BTreeMap::new();
    let mut cast: u128 = 0;
    // A small deterministic PRNG (xorshift), so the test is the same every run.
    let mut state: u64 = 0x2545_f491_4f6c_dd1d;
    let mut next = || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    for step in 0..400u32 {
        let voter = usize::try_from(next() % 20).expect("a voter");
        let weight = weights[voter];
        let option = u8::try_from(1 + next() % 6).expect("an option");
        match cast_of[voter] {
            Some((old_option, old_weight)) if next() % 3 == 0 => {
                // An unpark cuts the voter's weight (a `Fell`); the option's absolute tally falls with it.
                let keep = old_weight / 2;
                let fall = old_weight - keep;
                cast -= fall;
                let t = tally.get(&old_option).copied().unwrap_or(0) - fall;
                if t == 0 {
                    tally.remove(&old_option);
                } else {
                    tally.insert(old_option, t);
                }
                cast_of[voter] = (keep > 0).then_some((old_option, keep));
                let r = fell_row(voter, old_option, keep, t, cast);
                apply_vote(&r, &mut seen).expect("a Fell applies");
            }
            Some((old_option, old_weight)) if old_option != option => {
                // A move: the old option's absolute tally and the new one's, as the contract emits them.
                cast -= old_weight;
                let from_tally = tally.get(&old_option).copied().unwrap_or(0) - old_weight;
                if from_tally == 0 {
                    tally.remove(&old_option);
                } else {
                    tally.insert(old_option, from_tally);
                }
                cast += weight;
                let option_tally = tally.get(&option).copied().unwrap_or(0) + weight;
                tally.insert(option, option_tally);
                cast_of[voter] = Some((option, weight));
                let r = vote_row(
                    voter,
                    option,
                    weight,
                    option_tally,
                    cast,
                    old_option,
                    from_tally,
                );
                apply_vote(&r, &mut seen).expect("a moved vote applies");
            }
            None => {
                // A new vote.
                cast += weight;
                let option_tally = tally.get(&option).copied().unwrap_or(0) + weight;
                tally.insert(option, option_tally);
                cast_of[voter] = Some((option, weight));
                let r = vote_row(voter, option, weight, option_tally, cast, u8::MAX, 0);
                apply_vote(&r, &mut seen).expect("a vote applies");
            }
            Some(_) => {
                // The same option again: nothing happens on the chain; the ledger is not asked to count it.
                continue;
            }
        }
        let ballot = seen.ballots.get(&7).expect("the ballot");
        assert_eq!(
            tallies(ballot),
            tally,
            "step {step}: the tallies are the contract's"
        );
        assert_eq!(
            ballot.cast, cast,
            "step {step}: the cast total is the contract's"
        );
    }
    // Every step moved something: the replay is not a no-op.
    assert!(cast > 0);
    assert!(!tally.is_empty());
}

/// A `Voted` whose absolute tally contradicts the option is stored as the event says (the record's tally-add-up check
/// is what refuses a disagreement with the cast total); a row naming a ballot that never opened is refused, never
/// skipped, because a lost event would sign a wrong tally.
#[test]
fn a_vote_for_a_ballot_that_never_opened_is_refused() {
    let mut seen = VoteSeen::default();
    let e = vote_row(0, 1, 10, 10, 10, u8::MAX, 0);
    assert!(apply_vote(&e, &mut seen).is_err());
    open(&mut seen);
    apply_vote(&e, &mut seen).expect("applies");
    // A `Stood` option past the 12 a ballot offers is refused.
    let stood = row(
        2,
        0,
        2_000,
        Role::Pause,
        "Stood",
        json!({
            "id": "7", "option": "13", "by": hex0x(&[9u8; 20]),
            "members": [hex0x(&[9u8; 20]), hex0x(&[0u8; 20]), hex0x(&[0u8; 20]), hex0x(&[0u8; 20]), hex0x(&[0u8; 20])],
            "count": "1", "recordHash": hex0x(&[7u8; 32]), "displaced": hex0x(&[0u8; 20]),
        }),
    );
    assert!(apply_vote(&stood, &mut seen).is_err());
}

/// An event the table does not name at the pause's address is ignored, never an error (COUNCIL-PLAN.md section 5.1).
#[test]
fn an_unknown_event_at_the_vote_contract_is_ignored() {
    let mut seen = VoteSeen::default();
    let unknown = row(1, 0, 1_000, Role::Pause, "SomethingElse", json!({"a": "1"}));
    assert!(!apply_vote(&unknown, &mut seen).expect("ignored, not an error"));
    assert!(seen.ballots.is_empty());
    let mut council = CouncilSeen::default();
    let unknown = row(1, 0, 1_000, Role::Council, "SomethingElse", json!({}));
    assert!(!super::ledger_council::apply_council(&unknown, &mut council).expect("ignored"));
    // The table names no event under a random topic for either role.
    assert!(super::events::lookup(Role::Pause, &[0xAB; 32]).is_none());
    assert!(super::events::lookup(Role::Council, &[0xAB; 32]).is_none());
}

/// The third run's Council: `SeatsSet` gives the whole picture, `Proposed`/`Agreed`/`Withdrawn` move one proposal, and
/// a `Resigned` clears its seat; a proposal of an older generation is not counted as waiting.
#[test]
fn the_council_events_rebuild_the_seats_and_the_pending_proposals() {
    let fx = Fixture::load_council();
    let rows = fx.rows("C", fx.book_block("C_end"));
    let ledger = super::ledger::Ledger::from_logs(&rows)
        .expect("the rows read")
        .expect("the project is launched");
    let c = &ledger.council;
    assert_eq!(c.contract, fx.projects["C"].council.map(|a| hex0x(&a)));
    assert_eq!(c.generation, 0);
    assert_eq!(c.live_seats(), 5);
    assert!(
        c.proposals.is_empty(),
        "the run executed or cancelled none and left none pending"
    );
    for seat in &c.seats {
        assert!(seat.who.is_some(), "a Council is born with five seats");
        assert!(seat.seated_at > 0);
    }
    // The two ballots: the replace one carried out, the seat one waiting for the reader's result.
    let one = ledger.vote.ballots.get(&1).expect("ballot 1");
    assert_eq!(one.kind, 1);
    assert!(one.carried_out_at.is_some());
    assert!(one.lapsed_at.is_none());
    assert!(one.cast > 0);
    assert_eq!(one.tallies.values().sum::<u128>(), one.cast);
    let two = ledger.vote.ballots.get(&2).expect("ballot 2");
    assert_eq!(two.kind, 2);
    assert!(two.carried_out_at.is_none());
    assert!(
        two.finished.is_none(),
        "nobody pressed finish on the seat ballot"
    );
    assert!(two.cast > 0);
    assert_eq!(two.tallies.values().sum::<u128>(), two.cast);
    assert_eq!(ledger.vote.newest, Some(2));
    // A Fell was played, and a moved vote, and a move after another voter's move.
    assert!(rows.iter().any(|r| r.event == "Fell"));
    let moves = rows
        .iter()
        .filter(|r| r.event == "Voted")
        .filter(|r| r.fields["fromOption"].as_str() != Some("255"))
        .count();
    assert!(
        moves >= 2,
        "a moved vote and a move after a voter's move: {moves}"
    );
    let with_old_tally = rows.iter().any(|r| {
        r.event == "Voted"
            && r.fields["fromOption"].as_str() != Some("255")
            && r.fields["fromTally"].as_str() != Some("0")
    });
    assert!(
        with_old_tally,
        "a move after another voter's move leaves a non-zero old tally"
    );
}

/// A `SeatsSet` naming three seats, or a `Proposed` by an account that holds no seat, is refused: the ledger never
/// guesses a seat it was not told.
#[test]
fn a_seats_set_or_a_proposal_that_does_not_read_is_refused() {
    let mut seen = CouncilSeen::default();
    let zero = hex0x(&[0u8; 20]);
    let seats = [
        hex0x(&[1u8; 20]),
        hex0x(&[2u8; 20]),
        hex0x(&[3u8; 20]),
        zero.clone(),
        zero.clone(),
    ];
    let bad = row(
        1,
        0,
        1_000,
        Role::Council,
        "SeatsSet",
        json!({
            "seats": [seats[0], seats[1], seats[2]],
            "seatedAt": ["1", "1", "1"], "generation": "0", "nextElection": "9",
        }),
    );
    assert!(super::ledger_council::apply_council(&bad, &mut seen).is_err());
    let good = row(
        1,
        0,
        1_000,
        Role::Council,
        "SeatsSet",
        json!({
            "seats": seats, "seatedAt": ["1", "2", "3", "0", "0"], "generation": "4", "nextElection": "99",
        }),
    );
    super::ledger_council::apply_council(&good, &mut seen).expect("five seats");
    assert_eq!(seen.live_seats(), 3);
    assert_eq!(seen.generation, 4);
    let outsider = row(
        2,
        0,
        2_000,
        Role::Council,
        "Proposed",
        json!({
            "id": hex0x(&[9u8; 32]), "by": hex0x(&[9u8; 20]), "target": zero.clone(),
            "data": "0x12345678", "nonce": "0",
        }),
    );
    assert!(super::ledger_council::apply_council(&outsider, &mut seen).is_err());
    let seat = row(
        2,
        0,
        2_000,
        Role::Council,
        "Proposed",
        json!({
            "id": hex0x(&[9u8; 32]), "by": seats[0], "target": zero,
            "data": "0x12345678", "nonce": "0",
        }),
    );
    super::ledger_council::apply_council(&seat, &mut seen).expect("a seat proposes");
    // Three agreements run the call: `Agreed` with count 3 takes the proposal out of the set.
    for (i, count) in [(1u8, 2u8), (2, 3)] {
        let agreed = row(
            3,
            u32::from(i),
            3_000,
            Role::Council,
            "Agreed",
            json!({
                "id": hex0x(&[9u8; 32]), "by": seats[usize::from(i)], "count": count.to_string(),
            }),
        );
        super::ledger_council::apply_council(&agreed, &mut seen).expect("agreement");
    }
    assert!(
        seen.proposals.is_empty(),
        "the third agreement runs the call"
    );
    assert_eq!(
        super::ledger_council::call_kind([0x12, 0x34, 0x56, 0x78]),
        "other"
    );
}
