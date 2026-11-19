//! The contract views a record is built from, read at the one block the
//! record is true for (RECORD-V2 section 4.2).
//!
//! The whole list is built first and sent as one batch at one block number,
//! never at "latest". A call that fails, a node that cannot serve the block,
//! or an answer of the wrong shape fails the build: the caller retries on its
//! next pass and the previous record stays. Nothing here turns a failed read
//! into a zero.

use std::collections::BTreeMap;

use anyhow::{anyhow, bail, Context};
use buzz_evm_allowance::abi::selector;

use super::ledger::Ledger;
use super::source::{ChainSource, ViewCall};
use super::word::{hex0x, parse_fixed, Word};

/// The most grants whose views are read in one record.
pub const MAX_GRANT_READS: usize = super::record::MAX_GRANTS;
/// The most agent accounts whose views are read in one record.
pub const MAX_AGENT_READS: usize = 100;

const TREASURY_UINTS: [&str; 32] = [
    "pot",
    "paidIn",
    "box",
    "arriving",
    "arrivalEnd",
    "feesOwed",
    "locked",
    "notesOwed",
    "ratePpm",
    "pendingRatePpm",
    "pendingAt",
    "lastSettle",
    "lastCheckIn",
    "activeSeconds",
    "activeEnd",
    "activeNow",
    "windDownKind",
    "windDownAt",
    "Z",
    "unit",
    "feeBps",
    "boxCap",
    "leaveValue",
    "teamValue",
    "agentUsd",
    "agentTeam",
    "agentEpoch",
    "MIN_JOIN",
    "MIN_REVENUE",
    "MAX_RATE_PPM",
    "CHECK_IN_MULT",
    "WIND_MULT",
];
const VESTER_UINTS: [&str; 7] = [
    "grantCount",
    "committed",
    "CLIFF_MULT",
    "VEST_MULT",
    "MIN_GRANT",
    "MAX_GRANTS_PER_MEMBER",
    "PROTECTED_LENGTH",
];

/// One grant as the Vester's views give it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GrantView {
    /// Its id.
    pub id: u64,
    /// Who it is for.
    pub member: String,
    /// A protected grant.
    pub protected: bool,
    /// 0 live, 1 announced, 2 closed.
    pub state: u8,
    /// When an announced burn may run.
    pub burn_at: u64,
    /// What the member keeps.
    pub total: u128,
    /// Already sent.
    pub claimed: u128,
    /// The active-time reading at the grant (calendar time when protected).
    pub start: u128,
    /// Announced to burn.
    pub burn: u128,
    /// `vestedOf(id)`.
    pub vested: u128,
    /// `claimable(id)`.
    pub claimable: u128,
}

/// One agent account as the Treasury's views give it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentView {
    /// The account.
    pub agent: String,
    /// `agents(a).active`.
    pub active: bool,
    /// Daily dollar limit.
    pub usd_cap: u128,
    /// Daily Team Share limit.
    pub share_cap: u128,
    /// `agentEpochOf(a)`.
    pub epoch_of: u128,
    /// `agentUsdUsed(a)`.
    pub usd_used: u128,
    /// `agentTeamUsed(a)`.
    pub team_used: u128,
}

/// Everything read for one record, all at one block.
#[derive(Clone, Debug)]
pub struct Views {
    /// The block they were read at.
    pub block: u64,
    treasury: BTreeMap<&'static str, u128>,
    /// `Treasury.doorFlag()`.
    pub door_flag: bool,
    /// `Treasury.doorOpenNow()`.
    pub door_open_now: bool,
    /// `Treasury.runner()`.
    pub runner: String,
    vester: BTreeMap<&'static str, u128>,
    /// `shares.totalSupply()`.
    pub shares_supply: u128,
    /// `team.totalSupply()`.
    pub team_supply: u128,
    /// `team.balanceOf(vester)`.
    pub vester_team_balance: u128,
    /// `dollar.balanceOf(treasury)`.
    pub dollar_held: u128,
    /// `Launcher.testNetwork()`.
    pub test_network: bool,
    /// `Launcher.isPair(runner)`.
    pub is_pair: bool,
    /// `Pair.first()` and `Pair.second()` when the runner is a Pair.
    pub signers: Option<[String; 2]>,
    /// The unfinished grants, by id.
    pub grants: Vec<GrantView>,
    /// The agent accounts the events named.
    pub agents: Vec<AgentView>,
}

impl Views {
    /// A Treasury view by name. A name that was not read is a bug that fails
    /// the build, never a zero.
    pub fn t(&self, name: &str) -> anyhow::Result<u128> {
        self.treasury
            .get(name)
            .copied()
            .ok_or_else(|| anyhow!("the Treasury view {name} was not read"))
    }

    /// A Vester view by name.
    pub fn v(&self, name: &str) -> anyhow::Result<u128> {
        self.vester
            .get(name)
            .copied()
            .ok_or_else(|| anyhow!("the Vester view {name} was not read"))
    }

    /// A Treasury view that must fit 64 bits (a time, a count).
    pub fn t64(&self, name: &str) -> anyhow::Result<u64> {
        u64::try_from(self.t(name)?)
            .with_context(|| format!("the Treasury view {name} is too large"))
    }

    /// A Vester view that must fit 64 bits.
    pub fn v64(&self, name: &str) -> anyhow::Result<u64> {
        u64::try_from(self.v(name)?).with_context(|| format!("the Vester view {name} is too large"))
    }
}

fn uint_word(v: u128) -> Word {
    let mut w = [0u8; 32];
    w[16..].copy_from_slice(&v.to_be_bytes());
    w
}

fn address_word(a: &[u8; 20]) -> Word {
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(a);
    w
}

fn call(to: [u8; 20], signature: &str, args: &[Word]) -> ViewCall {
    let mut data = selector(signature).to_vec();
    for a in args {
        data.extend_from_slice(a);
    }
    ViewCall { to, data }
}

/// One answer, read word by word.
struct Answer<'a> {
    label: &'a str,
    bytes: &'a [u8],
}

impl Answer<'_> {
    fn word(&self, i: usize) -> anyhow::Result<Word> {
        let start = i * 32;
        self.bytes
            .get(start..start + 32)
            .and_then(|s| <Word>::try_from(s).ok())
            .ok_or_else(|| {
                anyhow!(
                    "{}: the answer is {} bytes, word {i} is missing",
                    self.label,
                    self.bytes.len()
                )
            })
    }

    fn expect_words(&self, n: usize) -> anyhow::Result<()> {
        if self.bytes.len() != n * 32 {
            bail!(
                "{}: the answer is {} bytes, not {}",
                self.label,
                self.bytes.len(),
                n * 32
            );
        }
        Ok(())
    }

    fn uint(&self, i: usize) -> anyhow::Result<u128> {
        let w = self.word(i)?;
        super::word::word_to_u128(&w)
            .ok_or_else(|| anyhow!("{}: the number does not fit 128 bits", self.label))
    }

    fn flag(&self, i: usize) -> anyhow::Result<bool> {
        match self.uint(i)? {
            0 => Ok(false),
            1 => Ok(true),
            n => bail!("{}: {n} is not true or false", self.label),
        }
    }

    fn address(&self, i: usize) -> anyhow::Result<String> {
        let w = self.word(i)?;
        if w[..12].iter().any(|b| *b != 0) {
            bail!("{}: the answer is not an address", self.label);
        }
        Ok(hex0x(&super::word::word_to_address(&w)))
    }
}

/// `Launcher.testNetwork()` at `block`: whether the chain's dollar is play
/// money. It is a constant of the deployed Launcher, so every replica reads it
/// for itself (the writer's record builds are not the only place it is
/// known).
pub async fn read_test_network(
    source: &dyn ChainSource,
    launcher: [u8; 20],
    block: u64,
) -> anyhow::Result<bool> {
    let call = call(launcher, "testNetwork()", &[]);
    let answers = source
        .eth_call_batch(std::slice::from_ref(&call), block)
        .await
        .with_context(|| format!("read Launcher.testNetwork() at block {block}"))?;
    let [bytes] = answers.as_slice() else {
        bail!("the node answered {} of 1 calls", answers.len());
    };
    let answer = Answer {
        label: "Launcher.testNetwork()",
        bytes,
    };
    answer.expect_words(1)?;
    answer.flag(0)
}

/// The calls of one record, with where each answer goes.
struct Plan {
    calls: Vec<ViewCall>,
    labels: Vec<String>,
}

impl Plan {
    fn add(&mut self, label: String, to: [u8; 20], signature: &str, args: &[Word]) -> usize {
        self.calls.push(call(to, signature, args));
        self.labels.push(label);
        self.calls.len() - 1
    }
}

/// The grants whose views are read: those not finished (closed with all it
/// keeps claimed), by id, the first [`MAX_GRANT_READS`] of them. Finished
/// grants never take a place from one that is not. The cut is by id, so the
/// same ledger always gives the same list (RECORD-V2 section 2.9).
pub fn grants_to_read(ledger: &Ledger) -> Vec<u64> {
    ledger
        .grants
        .values()
        .filter(|g| !(g.state == super::ledger::GrantState::Closed && g.claimed == g.total))
        .map(|g| g.id)
        .take(MAX_GRANT_READS)
        .collect()
}

/// The agent accounts whose views are read: the first [`MAX_AGENT_READS`] of
/// all the accounts an `AgentSet` named, those the events say are live (on, and
/// set under the current runner) before the rest, each group by address. A
/// switched-off or handed-over account never takes a place from a live one, and
/// the same ledger always gives the same list (RECORD-V2 section 2.10).
pub fn agents_to_read(ledger: &Ledger) -> Vec<&String> {
    let mut accounts: Vec<(&String, bool)> = ledger
        .agents
        .iter()
        .map(|(account, seen)| (account, seen.probably_live()))
        .collect();
    // The map is in address order already, and the sort is stable.
    accounts.sort_by_key(|(_, live)| !*live);
    accounts
        .into_iter()
        .take(MAX_AGENT_READS)
        .map(|(account, _)| account)
        .collect()
}

fn address_of(text: &str, what: &str) -> anyhow::Result<[u8; 20]> {
    parse_fixed::<20>(text).ok_or_else(|| anyhow!("{what} is not an address: {text}"))
}

/// Read every view a record needs for `ledger` at block `block`.
///
/// Grants whose events say they are finished are not read; at most
/// [`MAX_GRANT_READS`] unfinished grants, by id, and [`MAX_AGENT_READS`] agent
/// accounts are read (the record says when a list was cut).
pub async fn read(
    source: &dyn ChainSource,
    launcher: [u8; 20],
    ledger: &Ledger,
    block: u64,
) -> anyhow::Result<Views> {
    let treasury = address_of(&ledger.contracts.treasury, "the Treasury")?;
    let vester = address_of(&ledger.contracts.vester, "the Vester")?;
    let shares = address_of(&ledger.contracts.shares, "the Shares token")?;
    let team = address_of(&ledger.contracts.team, "the Team Shares token")?;
    let dollar = address_of(&ledger.contracts.dollar, "the dollar")?;
    let runner = address_of(&ledger.runner, "the runner")?;

    let mut plan = Plan {
        calls: Vec::new(),
        labels: Vec::new(),
    };
    let mut treasury_at = Vec::new();
    for name in TREASURY_UINTS {
        let at = plan.add(
            format!("Treasury.{name}()"),
            treasury,
            &format!("{name}()"),
            &[],
        );
        treasury_at.push((name, at));
    }
    let door_flag = plan.add("Treasury.doorFlag()".into(), treasury, "doorFlag()", &[]);
    let door_open = plan.add(
        "Treasury.doorOpenNow()".into(),
        treasury,
        "doorOpenNow()",
        &[],
    );
    let runner_at = plan.add("Treasury.runner()".into(), treasury, "runner()", &[]);
    let mut vester_at = Vec::new();
    for name in VESTER_UINTS {
        let at = plan.add(
            format!("Vester.{name}()"),
            vester,
            &format!("{name}()"),
            &[],
        );
        vester_at.push((name, at));
    }
    let shares_supply = plan.add("Shares.totalSupply()".into(), shares, "totalSupply()", &[]);
    let team_supply = plan.add("Team.totalSupply()".into(), team, "totalSupply()", &[]);
    let vester_team = plan.add(
        "Team.balanceOf(vester)".into(),
        team,
        "balanceOf(address)",
        &[address_word(&vester)],
    );
    let held = plan.add(
        "Dollar.balanceOf(treasury)".into(),
        dollar,
        "balanceOf(address)",
        &[address_word(&treasury)],
    );
    let test_network = plan.add(
        "Launcher.testNetwork()".into(),
        launcher,
        "testNetwork()",
        &[],
    );
    let is_pair = plan.add(
        "Launcher.isPair(runner)".into(),
        launcher,
        "isPair(address)",
        &[address_word(&runner)],
    );

    let grant_ids = grants_to_read(ledger);
    let mut grants_at = Vec::new();
    for id in &grant_ids {
        let arg = [uint_word(u128::from(*id))];
        grants_at.push((
            *id,
            plan.add(
                format!("Vester.grantOf({id})"),
                vester,
                "grantOf(uint256)",
                &arg,
            ),
            plan.add(
                format!("Vester.vestedOf({id})"),
                vester,
                "vestedOf(uint256)",
                &arg,
            ),
            plan.add(
                format!("Vester.claimable({id})"),
                vester,
                "claimable(uint256)",
                &arg,
            ),
        ));
    }
    let agent_list = agents_to_read(ledger);
    let mut agents_at = Vec::new();
    for agent in &agent_list {
        let a = address_of(agent, "an agent")?;
        let arg = [address_word(&a)];
        agents_at.push((
            (*agent).clone(),
            plan.add(
                format!("Treasury.agents({agent})"),
                treasury,
                "agents(address)",
                &arg,
            ),
            plan.add(
                format!("Treasury.agentEpochOf({agent})"),
                treasury,
                "agentEpochOf(address)",
                &arg,
            ),
            plan.add(
                format!("Treasury.agentUsdUsed({agent})"),
                treasury,
                "agentUsdUsed(address)",
                &arg,
            ),
            plan.add(
                format!("Treasury.agentTeamUsed({agent})"),
                treasury,
                "agentTeamUsed(address)",
                &arg,
            ),
        ));
    }

    let answers = source
        .eth_call_batch(&plan.calls, block)
        .await
        .with_context(|| format!("read the contract views at block {block}"))?;
    if answers.len() != plan.calls.len() {
        bail!(
            "the node answered {} of {} calls",
            answers.len(),
            plan.calls.len()
        );
    }
    let at = |i: usize| Answer {
        label: &plan.labels[i],
        bytes: &answers[i],
    };

    let mut treasury_views = BTreeMap::new();
    for (name, i) in &treasury_at {
        let a = at(*i);
        a.expect_words(1)?;
        treasury_views.insert(*name, a.uint(0)?);
    }
    let mut vester_views = BTreeMap::new();
    for (name, i) in &vester_at {
        let a = at(*i);
        a.expect_words(1)?;
        vester_views.insert(*name, a.uint(0)?);
    }
    let single = |i: usize| -> anyhow::Result<Answer<'_>> {
        let a = at(i);
        a.expect_words(1)?;
        Ok(a)
    };
    let runner_view = single(runner_at)?.address(0)?;
    let is_pair_view = single(is_pair)?.flag(0)?;

    let mut grants = Vec::new();
    for (id, grant_of, vested_of, claimable) in &grants_at {
        let g = at(*grant_of);
        g.expect_words(8)?;
        let state = u8::try_from(g.uint(2)?).context("a grant's state")?;
        if state > 2 {
            bail!("{}: state {state} is not known", g.label);
        }
        grants.push(GrantView {
            id: *id,
            member: g.address(0)?,
            protected: g.flag(1)?,
            state,
            burn_at: u64::try_from(g.uint(3)?).context("a grant's burn time")?,
            total: g.uint(4)?,
            claimed: g.uint(5)?,
            start: g.uint(6)?,
            burn: g.uint(7)?,
            vested: single(*vested_of)?.uint(0)?,
            claimable: single(*claimable)?.uint(0)?,
        });
    }
    let mut agents = Vec::new();
    for (agent, info, epoch_of, usd_used, team_used) in &agents_at {
        let a = at(*info);
        a.expect_words(3)?;
        agents.push(AgentView {
            agent: agent.clone(),
            active: a.flag(0)?,
            usd_cap: a.uint(1)?,
            share_cap: a.uint(2)?,
            epoch_of: single(*epoch_of)?.uint(0)?,
            usd_used: single(*usd_used)?.uint(0)?,
            team_used: single(*team_used)?.uint(0)?,
        });
    }

    // A Pair's two signers: asked of the Pair itself, at the same block.
    let signers = if is_pair_view {
        let mut second = Plan {
            calls: Vec::new(),
            labels: Vec::new(),
        };
        let first = second.add("Pair.first()".into(), runner, "first()", &[]);
        let next = second.add("Pair.second()".into(), runner, "second()", &[]);
        let got = source
            .eth_call_batch(&second.calls, block)
            .await
            .with_context(|| format!("read the Pair's signers at block {block}"))?;
        let pick = |i: usize| -> anyhow::Result<String> {
            let a = Answer {
                label: &second.labels[i],
                bytes: got
                    .get(i)
                    .ok_or_else(|| anyhow!("the node did not answer {}", second.labels[i]))?,
            };
            a.expect_words(1)?;
            a.address(0)
        };
        Some([pick(first)?, pick(next)?])
    } else {
        None
    };

    Ok(Views {
        block,
        treasury: treasury_views,
        door_flag: single(door_flag)?.flag(0)?,
        door_open_now: single(door_open)?.flag(0)?,
        runner: runner_view,
        vester: vester_views,
        shares_supply: single(shares_supply)?.uint(0)?,
        team_supply: single(team_supply)?.uint(0)?,
        vester_team_balance: single(vester_team)?.uint(0)?,
        dollar_held: single(held)?.uint(0)?,
        test_network: single(test_network)?.flag(0)?,
        is_pair: is_pair_view,
        signers,
        grants,
        agents,
    })
}

#[cfg(test)]
#[path = "views_tests.rs"]
mod tests;
