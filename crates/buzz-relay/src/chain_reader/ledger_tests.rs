//! The ledger against a real run of the contracts (`testdata/pot-run.json`,
//! made by `scripts/chain-reader-fixture.py`): every event decodes, a replay
//! of the logs gives exactly the numbers the contracts' own views gave in the
//! same run, a log delivered twice changes nothing, a join dropped by a
//! reorganisation is taken back, and an event from a contract that is not the
//! project's is ignored.

use std::collections::{BTreeSet, HashMap};

use serde_json::Value;

use super::*;
use crate::chain_reader::events::{self, EVENTS};
use crate::chain_reader::fixture::Fixture;

fn fx() -> Fixture {
    Fixture::load()
}

fn n(v: &Value, name: &str) -> u128 {
    v[name]
        .as_str()
        .unwrap_or_else(|| panic!("{name} is missing"))
        .parse()
        .unwrap_or_else(|_| panic!("{name} is not a number"))
}

fn ledger_at(fx: &Fixture, project: &str, block: u64) -> Ledger {
    Ledger::from_logs(&fx.rows(project, block))
        .expect("the rows read")
        .expect("the project is launched")
}

/// The numbers a snapshot's views gave, as the ledger must hold them.
fn assert_same(l: &Ledger, views: &Value, at: &str) {
    assert_eq!(l.pot, n(views, "pot"), "{at}: pot");
    assert_eq!(l.paid_in, n(views, "paidIn"), "{at}: paid-in");
    assert_eq!(l.box_, n(views, "box"), "{at}: box");
    assert_eq!(l.arriving, n(views, "arriving"), "{at}: arriving");
    assert_eq!(l.fees_owed, n(views, "feesOwed"), "{at}: fees owed");
    assert_eq!(l.z, n(views, "Z"), "{at}: burn queue");
    assert_eq!(
        l.active_seconds,
        n(views, "activeSeconds"),
        "{at}: active seconds"
    );
    // A settle that moves nothing emits nothing, so the events' time can only be earlier.
    assert!(
        u128::from(l.last_settle) <= n(views, "lastSettle"),
        "{at}: last settle"
    );
    assert_eq!(l.shares, n(views, "sharesSupply"), "{at}: Shares");
    assert_eq!(l.team, n(views, "teamSupply"), "{at}: Team Shares");
    assert_eq!(u128::from(l.rate_ppm), n(views, "ratePpm"), "{at}: rate");
    assert_eq!(
        l.pending_rate.map_or(0, |p| u128::from(p.ppm)),
        n(views, "pendingRatePpm"),
        "{at}: pending rate"
    );
    if l.arriving != 0 || n(views, "arrivalEnd") != 0 {
        assert_eq!(
            u128::from(l.arrival_end),
            n(views, "arrivalEnd"),
            "{at}: arrival end"
        );
    }
    assert_eq!(
        u128::from(l.last_check_in),
        n(views, "lastCheckIn"),
        "{at}: last check-in"
    );
    assert_eq!(
        l.door_open,
        views["doorFlag"].as_bool().expect("flag"),
        "{at}: door"
    );
    assert_eq!(
        l.wind_down.map_or(0, |w| u128::from(w.kind)),
        n(views, "windDownKind"),
        "{at}: wind-down kind"
    );
    assert_eq!(
        l.wind_down.map_or(0, |w| u128::from(w.at)),
        n(views, "windDownAt"),
        "{at}: wind-down time"
    );
    assert_eq!(
        l.runner,
        views["runner"].as_str().expect("runner"),
        "{at}: runner"
    );
    assert_eq!(
        l.grants.len() as u128,
        n(views, "grantCount"),
        "{at}: grants"
    );
    assert_eq!(
        l.committed(),
        n(views, "committed"),
        "{at}: committed to grants"
    );
}

/// Every event the table names appears in the real run and decodes, and the
/// only logs of the run's contracts the table does not name are allowances.
#[test]
fn every_event_decodes_from_the_real_run() {
    let fx = fx();
    let approval = events::topic_of(Role::Treasury, "Joined").map(|_| ());
    assert!(approval.is_some());
    let mut seen: BTreeSet<(&'static str, &'static str)> = BTreeSet::new();
    for log in &fx.logs {
        let Some((role, _)) = fx.role_of(&log.address) else {
            continue;
        };
        match log.topics.first().and_then(|t| events::lookup(role, t)) {
            Some(def) => {
                events::decode(def, &log.topics, &log.data)
                    .unwrap_or_else(|e| panic!("{role:?}.{} did not decode: {e:?}", def.name));
                seen.insert((role.as_str(), def.name));
            }
            None => {
                // The only logs the table does not name are `Approval`s.
                let approval = keccak_topic("Approval(address,address,uint256)");
                assert_eq!(log.topics[0], approval, "an unnamed log of {role:?}");
            }
        }
    }
    for def in EVENTS {
        assert!(
            seen.contains(&(def.role.as_str(), def.name)),
            "the real run never emitted {:?}.{}",
            def.role,
            def.name
        );
    }
}

fn keccak_topic(signature: &str) -> [u8; 32] {
    buzz_evm_allowance::abi::keccak256(signature.as_bytes())
}

/// The addresses the Launcher's event names are the ones the run's contracts
/// were deployed at: the reader finds a project's contracts from this event
/// alone.
#[test]
fn project_launched_names_the_real_contracts() {
    let fx = fx();
    let mut launched = 0;
    for (role, project, row) in fx.decoded() {
        if role != Role::Launcher || row.event != "ProjectLaunched" {
            continue;
        }
        let p = &fx.projects[project.as_deref().expect("a project")];
        let named = |name: &str| {
            row.fields["project"][name]
                .as_str()
                .expect("address")
                .to_owned()
        };
        assert_eq!(named("treasury"), hex0x(&p.treasury));
        assert_eq!(named("shares"), hex0x(&p.shares));
        assert_eq!(named("team"), hex0x(&p.team));
        assert_eq!(named("vester"), hex0x(&p.vester));
        assert_eq!(row.fields["platform"]["quote"], hex0x(&fx.dollar));
        assert_eq!(row.fields["platform"]["unit"], "604800");
        launched += 1;
    }
    assert_eq!(launched, 2);
}

/// The replay rebuilds exactly the numbers the contracts' views gave right
/// after every block that changed a project, in both projects of the run.
#[test]
fn a_replay_of_the_logs_gives_the_numbers_the_views_gave_at_every_step() {
    let fx = fx();
    let mut checked = 0;
    for name in ["A", "B"] {
        let snaps = fx.json["snapshots"][name].as_array().expect("snapshots");
        assert!(
            snaps.len() > 5,
            "the run changed {name} more than five times"
        );
        for snap in snaps {
            let block = snap["block"].as_u64().expect("block");
            let l = ledger_at(&fx, name, block);
            assert_same(
                &l,
                &snap["views"],
                &format!("project {name}, block {block}"),
            );
            // The stored numbers also pass the cross-check the record is
            // signed under (the Vester's Team balance is the ledger's own
            // here: it is read from the chain only at the end of the run).
            let v = &snap["views"];
            let stored = Stored {
                pot: n(v, "pot"),
                paid_in: n(v, "paidIn"),
                box_: n(v, "box"),
                arriving: n(v, "arriving"),
                fees_owed: n(v, "feesOwed"),
                z: n(v, "Z"),
                active_seconds: n(v, "activeSeconds"),
                last_settle: u64::try_from(n(v, "lastSettle")).expect("time"),
                shares_supply: n(v, "sharesSupply"),
                team_supply: n(v, "teamSupply"),
                vester_team_balance: l.vester_team_balance(),
            };
            assert_eq!(
                l.mismatches(&stored),
                vec![],
                "project {name}, block {block}"
            );
            checked += 1;
        }
    }
    assert!(checked > 50, "{checked} steps were compared");
}

/// At the end of the run: every holder's balances, every grant and every agent
/// are what the contracts say, and the dollars the Treasury holds are exactly
/// what its buckets owe.
#[test]
fn the_end_of_the_run_matches_the_contracts() {
    let fx = fx();
    for name in ["A", "B"] {
        let fin = &fx.json["final"][name];
        let l = ledger_at(&fx, name, fx.head());
        assert_same(&l, &fin["views"], &format!("project {name}, last block"));

        // Balances of both tokens, account by account.
        for (token, ours) in [
            ("shares", l.shares_balances().collect::<Vec<_>>()),
            ("team", l.team_balances().collect::<Vec<_>>()),
        ] {
            let theirs = fin["balances"][token].as_object().expect("balances");
            let ours: HashMap<&str, u128> =
                ours.into_iter().map(|(a, b)| (a.as_str(), *b)).collect();
            let theirs: HashMap<&str, u128> = theirs
                .iter()
                .map(|(a, b)| {
                    (
                        a.as_str(),
                        b.as_str().expect("amount").parse().expect("number"),
                    )
                })
                .collect();
            // The run's accounts only: the chain run lists the anvil accounts, the
            // Treasury, the Vester and the Pair.
            for (a, b) in &theirs {
                assert_eq!(
                    ours.get(a).copied().unwrap_or(0),
                    *b,
                    "{name}: {token} of {a}"
                );
            }
            let total: u128 = ours.values().sum();
            let supply = if token == "shares" { l.shares } else { l.team };
            assert_eq!(
                total, supply,
                "{name}: {token} balances add up to the supply"
            );
        }

        // The cross-check against the end-of-run views, the Vester's balance included.
        let vester_balance = fin["balances"]["team"]
            .get(hex0x(&fx.projects[name].vester))
            .map_or(0, |v| v.as_str().expect("amount").parse().expect("number"));
        let v = &fin["views"];
        let stored = Stored {
            pot: n(v, "pot"),
            paid_in: n(v, "paidIn"),
            box_: n(v, "box"),
            arriving: n(v, "arriving"),
            fees_owed: n(v, "feesOwed"),
            z: n(v, "Z"),
            active_seconds: n(v, "activeSeconds"),
            last_settle: u64::try_from(n(v, "lastSettle")).expect("time"),
            shares_supply: n(v, "sharesSupply"),
            team_supply: n(v, "teamSupply"),
            vester_team_balance: vester_balance,
        };
        assert_eq!(l.mismatches(&stored), vec![], "{name}");
        assert!(
            vester_balance > 0
                || name == "B"
                || l.team == 0
                || vester_balance == l.vester_team_balance()
        );

        // Grants.
        let grants = fin["grants"].as_array().expect("grants");
        assert_eq!(grants.len(), l.grants.len(), "{name}: grants");
        for g in grants {
            let id = g["id"].as_u64().expect("id");
            let ours = &l.grants[&id];
            assert_eq!(
                ours.member,
                g["member"].as_str().expect("member"),
                "{name} grant {id}"
            );
            assert_eq!(ours.protected, g["protected"].as_bool().expect("flag"));
            assert_eq!(
                ours.state,
                match g["state"].as_u64().expect("state") {
                    0 => GrantState::Live,
                    1 => GrantState::Announced,
                    _ => GrantState::Closed,
                },
                "{name} grant {id}: state"
            );
            assert_eq!(ours.total, n(g, "total"), "{name} grant {id}: total");
            assert_eq!(ours.claimed, n(g, "claimed"), "{name} grant {id}: claimed");
            assert_eq!(ours.start_active, n(g, "start"), "{name} grant {id}: start");
            assert_eq!(ours.burn, n(g, "burn"), "{name} grant {id}: burn");
            assert_eq!(
                u128::from(ours.burn_at),
                if ours.state == GrantState::Live {
                    0
                } else {
                    n(g, "burnAt")
                },
                "{name} grant {id}: burn time"
            );
        }

        // Agents: the last `AgentSet` says what the stored flag says.
        for (agent, seen) in &l.agents {
            let theirs = &fin["agents"][agent];
            assert_eq!(
                seen.active,
                theirs["active"].as_bool().expect("flag"),
                "{name}: agent {agent}"
            );
            assert_eq!(seen.usd_cap, n(theirs, "usdCap"), "{name}: agent {agent}");
            assert_eq!(
                seen.share_cap,
                n(theirs, "shareCap"),
                "{name}: agent {agent}"
            );
        }
    }

    // Project A, in particular: backers, a take-out, grants in every state, an agent.
    let a = ledger_at(&fx, "A", fx.head());
    assert!(
        a.totals.joined > 0 && a.totals.took_out > 0 && a.totals.drawn > 0 && a.totals.outside > 0
    );
    assert_eq!(
        a.totals.fees,
        a.totals.joined * u128::from(a.fee_bps) / 10_000
    );
    assert!(a.first_backed_at.is_some());
    assert_eq!(a.grants.len(), 4);
    assert!(a
        .grants
        .values()
        .any(|g| g.state == GrantState::Closed && g.by_member == Some(true)));
    assert!(!a.agents.is_empty());
    assert_eq!(a.wind_down.map(|w| w.kind), Some(1));
    assert_eq!(a.pair, None);
    // B has a Pair and a Pair-announced forfeit.
    let b = ledger_at(&fx, "B", fx.head());
    assert_eq!(
        b.pair.as_deref(),
        Some(hex0x(&fx.projects["B"].pair.expect("a pair")).as_str())
    );
    assert_eq!(b.runner, b.pair.clone().expect("a pair"));
    assert!(b.grants.values().any(|g| g.by_member == Some(false)));
    assert_ne!(a.key, b.key);
}

/// The dollars the Treasury holds are the buckets it owes (the record's
/// `held`), and the totals identity holds: what came in is what is out or in
/// a bucket.
#[test]
fn the_totals_identity_holds_at_the_end_of_each_project() {
    let fx = fx();
    for name in ["A", "B"] {
        let l = ledger_at(&fx, name, fx.head());
        let held = n(&fx.json["final"][name], "dollarHeld");
        assert_eq!(
            held,
            l.pot + l.box_ + l.arriving + l.fees_owed,
            "{name}: held"
        );
        // joined + outside = fees + took out + drawn + pot + box + arriving, up to what
        // was collected: fees collected leave the Treasury (A collected its fees).
        let collected = l.totals.fees - l.fees_owed;
        assert_eq!(
            l.totals.joined + l.totals.outside,
            l.totals.fees + l.totals.took_out + l.totals.drawn + l.pot + l.box_ + l.arriving,
            "{name}: the totals identity (collected fees {collected})"
        );
    }
}

/// A log delivered twice changes nothing.
#[test]
fn a_log_delivered_twice_changes_nothing() {
    let fx = fx();
    let rows = fx.rows("A", fx.head());
    let once = Ledger::from_logs(&rows).expect("reads").expect("launched");
    // Every row twice over, in order, then the whole run again.
    let mut doubled: Vec<LogRow> = rows.iter().flat_map(|r| [r.clone(), r.clone()]).collect();
    doubled.extend(rows.iter().cloned());
    let twice = Ledger::from_logs(&doubled)
        .expect("reads")
        .expect("launched");
    assert_eq!(once.pot, twice.pot);
    assert_eq!(once.totals, twice.totals);
    assert_eq!(once.draws, twice.draws);
    assert_eq!(once.grants, twice.grants);
    assert_eq!(
        once.holders(&BTreeSet::new()),
        twice.holders(&BTreeSet::new())
    );
}

/// A join taken away by a reorganisation (its block is gone from the stored
/// rows) takes its numbers with it: the numbers return to what the views gave
/// before it.
#[test]
fn a_dropped_join_rolls_the_numbers_back() {
    let fx = fx();
    let rows = fx.rows("A", fx.head());
    let joins: Vec<&LogRow> = rows
        .iter()
        .filter(|r| r.role == Role::Treasury && r.event == "Joined")
        .collect();
    assert!(joins.len() >= 3);
    let last = joins[joins.len() - 1];
    let before = joins[joins.len() - 2].block;
    let with = ledger_at(&fx, "A", last.block);
    let without = ledger_at(&fx, "A", last.block - 1);
    assert_ne!(with.paid_in, without.paid_in);
    assert_eq!(
        with.paid_in,
        without.paid_in + (n(&last.fields, "paidInAfter") - without.paid_in)
    );
    // Without the join the numbers are those of the newest snapshot before it.
    let snap = fx.json["snapshots"]["A"]
        .as_array()
        .expect("snapshots")
        .iter()
        .rev()
        .find(|s| s["block"].as_u64().expect("block") < last.block)
        .expect("a snapshot before the join");
    assert_same(&without, &snap["views"], "before the dropped join");
    assert!(snap["block"].as_u64().expect("block") >= before);
    // The totals went back too: the join's payment, its fee, its Shares.
    assert_eq!(
        with.totals.joined - without.totals.joined,
        n(&last.fields, "paid")
    );
    assert_eq!(
        with.totals.fees - without.totals.fees,
        n(&last.fields, "fee")
    );
    assert_eq!(with.fees_owed - without.fees_owed, n(&last.fields, "fee"));
    assert!(with.shares > without.shares);
}

/// A log from a contract that is not the project's own for its role is
/// ignored, however it looks: another project's Treasury, a stranger, or the
/// project's own Vester posing as its Treasury.
#[test]
fn an_event_from_a_contract_that_is_not_the_projects_is_ignored() {
    let fx = fx();
    let rows = fx.rows("A", fx.head());
    let base = Ledger::from_logs(&rows).expect("reads").expect("launched");
    let stranger = [0x99u8; 20];
    let b_treasury = fx.projects["B"].treasury;
    let a_vester = fx.projects["A"].vester;
    let join = rows
        .iter()
        .find(|r| r.role == Role::Treasury && r.event == "Joined")
        .expect("a join")
        .clone();
    for from in [stranger, b_treasury, a_vester] {
        let mut forged = join.clone();
        forged.address = from;
        forged.block = fx.head() + 1;
        forged.log_index = 0;
        forged.fields["potAfter"] = Value::String("123456789".into());
        forged.fields["sharesAfter"] = Value::String("987654321".into());
        let mut with_forgery = rows.clone();
        with_forgery.push(forged);
        let l = Ledger::from_logs(&with_forgery)
            .expect("reads")
            .expect("launched");
        assert_eq!(l.pot, base.pot);
        assert_eq!(l.shares, base.shares);
        assert_eq!(l.totals, base.totals);
    }
    // The other project's whole run, offered to this ledger, changes nothing.
    let mut mixed = rows.clone();
    mixed.extend(
        fx.rows("B", fx.head())
            .into_iter()
            .filter(|r| r.role != Role::Launcher),
    );
    let l = Ledger::from_logs(&mixed).expect("reads").expect("launched");
    assert_eq!(l.pot, base.pot);
    assert_eq!(l.totals, base.totals);
    assert_eq!(l.grants, base.grants);
    assert_eq!(l.runner, base.runner);
}

/// A row that does not read as its event says is an error, never skipped.
#[test]
fn a_row_that_does_not_read_is_an_error_not_a_skip() {
    let fx = fx();
    let mut rows = fx.rows("A", fx.head());
    let at = rows
        .iter()
        .position(|r| r.role == Role::Treasury && r.event == "Joined")
        .expect("a join");
    rows[at].fields["potAfter"] = Value::String("not a number".into());
    assert!(Ledger::from_logs(&rows).is_err());
    let mut rows = fx.rows("A", fx.head());
    let at = rows
        .iter()
        .position(|r| r.role == Role::Vester && r.event == "GrantClaimed")
        .expect("a claim");
    rows[at].fields["id"] = Value::String("99".into());
    assert!(
        Ledger::from_logs(&rows).is_err(),
        "a claim on a grant never made"
    );
    // No launch among the rows: no project.
    let rows: Vec<LogRow> = fx
        .rows("A", fx.head())
        .into_iter()
        .filter(|r| r.event != "ProjectLaunched")
        .collect();
    assert!(Ledger::from_logs(&rows).expect("reads").is_none());
}

/// The cross-check names every field on which the events and the view part,
/// and passes when they agree.
#[test]
fn the_cross_check_names_each_number_that_differs() {
    let fx = fx();
    let l = ledger_at(&fx, "A", fx.head());
    let v = &fx.json["final"]["A"]["views"];
    let good = Stored {
        pot: n(v, "pot"),
        paid_in: n(v, "paidIn"),
        box_: n(v, "box"),
        arriving: n(v, "arriving"),
        fees_owed: n(v, "feesOwed"),
        z: n(v, "Z"),
        active_seconds: n(v, "activeSeconds"),
        last_settle: u64::try_from(n(v, "lastSettle")).expect("time"),
        shares_supply: n(v, "sharesSupply"),
        team_supply: n(v, "teamSupply"),
        vester_team_balance: l.vester_team_balance(),
    };
    assert!(l.mismatches(&good).is_empty());
    let off = Stored {
        pot: good.pot + 1,
        z: good.z + 5,
        ..good
    };
    let fields: Vec<&str> = l.mismatches(&off).iter().map(|m| m.field).collect();
    assert_eq!(fields, vec!["pot", "Z"]);
    let m = &l.mismatches(&off)[0];
    assert_eq!((m.ledger, m.view), (good.pot, good.pot + 1));
}

/// RECORD-V2.md 4.3: the ledger's `lastSettle` must not be later than the view's. A settle that moves nothing emits no
/// `Settled`, so a view that is later than the events is normal and passes; a ledger that is later than the view is a
/// mismatch, named with both values. The guard is `self.last_settle > view.last_settle` in `Ledger::mismatches`.
#[test]
fn a_ledger_settle_later_than_the_views_is_a_mismatch_and_an_earlier_one_is_not() {
    let fx = fx();
    let l = ledger_at(&fx, "A", fx.head());
    let v = &fx.json["final"]["A"]["views"];
    let good = Stored {
        pot: n(v, "pot"),
        paid_in: n(v, "paidIn"),
        box_: n(v, "box"),
        arriving: n(v, "arriving"),
        fees_owed: n(v, "feesOwed"),
        z: n(v, "Z"),
        active_seconds: n(v, "activeSeconds"),
        last_settle: u64::try_from(n(v, "lastSettle")).expect("time"),
        shares_supply: n(v, "sharesSupply"),
        team_supply: n(v, "teamSupply"),
        vester_team_balance: l.vester_team_balance(),
    };
    assert!(l.last_settle > 0, "the fixture's ledger has a last settle");
    assert!(l.mismatches(&good).is_empty());
    // The view's last settle is earlier than the ledger's: the events show a settle the contract does not.
    let behind = Stored {
        last_settle: l.last_settle - 1,
        ..good
    };
    let found = l.mismatches(&behind);
    assert_eq!(found.len(), 1, "only lastSettle differs: {found:?}");
    assert_eq!(found[0].field, "lastSettle");
    assert_eq!(found[0].ledger, u128::from(l.last_settle));
    assert_eq!(found[0].view, u128::from(l.last_settle - 1));
    // The view's last settle is later (a silent settle after the last event): not a mismatch.
    let ahead = Stored {
        last_settle: l.last_settle + 1,
        ..good
    };
    assert!(l.mismatches(&ahead).is_empty());
}

/// Holders: the accounts with Shares in hand, biggest first, without the
/// Treasury, the Vester, the tokens or the zero address.
#[test]
fn holders_list_people_only_biggest_first() {
    let fx = fx();
    let l = ledger_at(&fx, "A", 40);
    let holders = l.holders(&BTreeSet::new());
    assert!(!holders.is_empty());
    for h in &holders {
        assert_ne!(h.account, l.contracts.vester);
        assert_ne!(h.account, l.contracts.treasury);
        assert_ne!(h.account, hex0x(&[0u8; 20]));
        assert!(h.shares > 0 || h.team > 0);
    }
    assert!(holders.windows(2).all(|w| w[0].shares >= w[1].shares));
    // The Vester holds the unvested pool; it is not a holder.
    assert!(l.vester_team_balance() > 0);
    let skipped: BTreeSet<String> = holders.iter().map(|h| h.account.clone()).take(1).collect();
    assert_eq!(l.holders(&skipped).len(), holders.len() - 1);
}

/// An agent set on is "probably live" only until the runner changes: a
/// hand-over switches every agent off with no event of its own, so the ledger
/// must stop counting it (the views decide in the end, the ledger only orders
/// accounts when there are more than the record reads).
#[test]
fn an_agent_is_probably_live_only_until_the_runner_changes() {
    let fx = fx();
    let rows = fx.rows("A", fx.head());
    let set_on = rows
        .iter()
        .find(|r| r.event == "AgentSet" && r.fields["active"] == true)
        .expect("the run switches an agent on");
    let handed_over = rows
        .iter()
        .find(|r| r.event == "RunnerChanged")
        .expect("the run changes the runner")
        .clone();
    let mut ledger = ledger_at(&fx, "A", set_on.block);
    let (agent, seen) = ledger.agents.iter().next().expect("the agent");
    let agent = agent.clone();
    assert!(seen.active && seen.under_runner && seen.probably_live());

    // The same event later: the runner changes, the agent's last event still says "on".
    let mut later = handed_over;
    later.block = set_on.block + 1_000;
    later.log_index = 0;
    ledger.apply(&later).expect("a change of runner");
    let seen = &ledger.agents[&agent];
    assert!(seen.active, "the last AgentSet still says on");
    assert!(!seen.under_runner && !seen.probably_live());

    // Set again under the new runner: live again.
    let mut again = set_on.clone();
    again.block = later.block + 1;
    ledger.apply(&again).expect("set again");
    assert!(ledger.agents[&agent].probably_live());
}
