//! Which grants and agents the record reads when there are more than it can
//! hold: the cut is the same every time, and a live one is never left out for
//! one that is finished or switched off.

use super::*;
use crate::chain_reader::fixture::Fixture;
use crate::chain_reader::ledger::{AgentSeen, Grant, GrantState};

fn ledger() -> Ledger {
    let fx = Fixture::load();
    Ledger::from_logs(&fx.rows("A", fx.head()))
        .expect("the rows read")
        .expect("the project is launched")
}

fn grant(id: u64, state: GrantState, claimed: u128) -> Grant {
    Grant {
        id,
        member: format!("0x{id:040x}"),
        protected: false,
        state,
        granted: 10,
        total: 10,
        claimed,
        start_active: 0,
        burn: 0,
        burn_at: 0,
        by_member: None,
    }
}

fn agent(active: bool, under_runner: bool) -> AgentSeen {
    AgentSeen {
        active,
        under_runner,
        usd_cap: 1,
        share_cap: 1,
    }
}

#[test]
fn finished_grants_never_take_a_place_from_one_that_is_not() {
    let mut l = ledger();
    l.grants.clear();
    // 250 grants made; the first 230 are finished (closed, everything kept claimed), the last 20 are not.
    for id in 0..250 {
        let g = if id < 230 {
            grant(id, GrantState::Closed, 10)
        } else {
            grant(id, GrantState::Live, 0)
        };
        l.grants.insert(id, g);
    }
    assert_eq!(grants_to_read(&l), (230..250).collect::<Vec<u64>>());
    // A closed grant with something left to claim is not finished.
    l.grants.insert(3, grant(3, GrantState::Closed, 4));
    let ids = grants_to_read(&l);
    assert_eq!(ids.len(), 21);
    assert_eq!(ids[0], 3, "by id");
}

#[test]
fn more_unfinished_grants_than_the_cap_are_cut_by_id_every_time() {
    let mut l = ledger();
    l.grants.clear();
    // Inserted newest first: the cut must not depend on how the ledger was built.
    for id in (0..300).rev() {
        l.grants.insert(id, grant(id, GrantState::Live, 0));
    }
    let first = grants_to_read(&l);
    assert_eq!(first, (0..MAX_GRANT_READS as u64).collect::<Vec<u64>>());
    assert_eq!(MAX_GRANT_READS, 200);
    assert_eq!(grants_to_read(&l), first, "the same ledger, the same cut");
}

#[test]
fn live_agents_are_read_before_ones_that_are_off_or_were_handed_over() {
    let mut l = ledger();
    l.agents.clear();
    // 120 accounts with low addresses are switched off, 15 more are on but were set under a previous runner, and
    // 30 with the highest addresses are on under the current runner: the old rule (first 100 by address) read none
    // of the live ones.
    for i in 0..120u32 {
        l.agents
            .insert(format!("0x{:040x}", i + 1), agent(false, true));
    }
    for i in 0..15u32 {
        l.agents
            .insert(format!("0x{:040x}", 200 + i), agent(true, false));
    }
    for i in 0..30u32 {
        l.agents
            .insert(format!("0x{:040x}", 1_000 + i), agent(true, true));
    }
    let read = agents_to_read(&l);
    assert_eq!(read.len(), MAX_AGENT_READS);
    assert_eq!(MAX_AGENT_READS, 100);
    for i in 0..30u32 {
        let live = format!("0x{:040x}", 1_000 + i);
        assert!(read.contains(&&live), "the live agent {live} was left out");
    }
    // The 70 places left go to the others by address: the lowest ones.
    let others: Vec<&String> = read
        .iter()
        .copied()
        .filter(|a| !l.agents[*a].probably_live())
        .collect();
    let mut sorted = others.clone();
    sorted.sort();
    assert_eq!(others, sorted, "by address within the rest");
    assert_eq!(*others[0], format!("0x{:040x}", 1));
    assert_eq!(*others[69], format!("0x{:040x}", 70));
    assert_eq!(agents_to_read(&l), read, "the same ledger, the same cut");
}

#[test]
fn a_ledger_with_few_agents_and_grants_reads_them_all() {
    let mut l = ledger();
    l.agents.clear();
    l.agents.insert("0x00".into(), agent(false, true));
    l.agents.insert("0x01".into(), agent(true, true));
    assert_eq!(
        agents_to_read(&l)
            .into_iter()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        vec!["0x01", "0x00"]
    );
}
