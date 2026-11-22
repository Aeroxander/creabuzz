//! A project's state, rebuilt from its events alone.
//!
//! Every state change of the Treasury and the Vester carries the state it
//! leaves behind (`potAfter`, `boxAfter`, `zAfter`, ...), so the reader needs
//! no contract formula to follow a project: it keeps what the events say.
//! `contracts/pot/test/EventsRebuild.t.sol` is the recipe (a ledger of events
//! alone equals the contracts after each of 400 random steps); this is that
//! ledger in the reader, extended with what the record needs (grants, agents,
//! totals, the first join, holders).
//!
//! What the ledger holds is the state **as of the last settle** (the numbers
//! the contracts' own `pot()`, `box()`, `arriving()` and `activeSeconds()`
//! return). The settled figures at a block's time are worked out from it by
//! the record's builder.
//!
//! Rules:
//! - A row counts once: a log delivered twice (same block and log index) is
//!   ignored the second time.
//! - A row from a contract that is not the project's own for its role is
//!   ignored, however it looks.
//! - A row that does not read as its event says (a missing field, a number
//!   that is not a number) is an error, never skipped: a ledger that missed an
//!   event would sign a wrong number.
//! - Token `Transfer`s move per-account balances (holders); in the reader
//!   they are not loaded with the logs but kept as running totals by the store
//!   (`set_balances`), and any `Transfer` rows given are counted on top.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use anyhow::{anyhow, bail, Context};
use serde_json::Value;

use super::events::Role;
use super::ledger_council::{CouncilSeen, VoteSeen};
use super::ledger_tasks::TaskLedger;
use super::word::hex0x;

/// One stored log of the project, with its block time.
#[derive(Clone, Debug)]
pub struct LogRow {
    /// Block number.
    pub block: u64,
    /// Position in the block.
    pub log_index: u32,
    /// Block time (unix seconds).
    pub time: u64,
    /// The transaction that emitted it.
    pub tx: [u8; 32],
    /// Emitting contract's role.
    pub role: Role,
    /// Emitting contract.
    pub address: [u8; 20],
    /// Event name.
    pub event: String,
    /// Decoded fields (see `events::decode`).
    pub fields: Value,
}

/// The state of a grant in the Vester.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GrantState {
    /// Vesting.
    Live,
    /// The unvested part is announced to burn; what stays has all vested.
    Announced,
    /// Settled: what stays is fixed.
    Closed,
}

/// One grant of Team Shares, as the Vester's events tell it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Grant {
    /// The grant's id in the Vester.
    pub id: u64,
    /// Who it is for (lower-case `0x` text).
    pub member: String,
    /// A protected grant (kind 1): vests on calendar time and cannot be forfeited.
    pub protected: bool,
    /// Where it is.
    pub state: GrantState,
    /// What was granted.
    pub granted: u128,
    /// What the member keeps: `granted` while live, then what stays after an
    /// announce or a close (`Grant.total` in the Vester).
    pub total: u128,
    /// Already sent to the member.
    pub claimed: u128,
    /// The active-time reading at the grant (`startActive`).
    pub start_active: u128,
    /// Announced to burn and not yet burned.
    pub burn: u128,
    /// When an announced burn may run (0 until announced).
    pub burn_at: u64,
    /// Whether the member announced their own exit (`Some`), for an announced
    /// or closed-after-announce grant.
    pub by_member: Option<bool>,
}

/// A rate raise that was announced and not applied.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PendingRate {
    /// The rate it will become (parts per million a day).
    pub ppm: u32,
    /// The first moment anyone may apply it.
    pub applicable_at: u64,
    /// When it was announced (the block time of the event).
    pub proposed_at: u64,
}

/// A wind-down.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WindDown {
    /// 1 by choice, 2 after 26 quiet units.
    pub kind: u8,
    /// When.
    pub at: u64,
}

/// What an agent's last `AgentSet` said. A hand-over switches every agent off
/// without an event, so whether an agent is live is read from the chain; the
/// events only say which agents are *probably* live ([`AgentSeen::probably_live`]),
/// which is all the cut of a long list needs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentSeen {
    /// Switched on by that event.
    pub active: bool,
    /// Whether that event came after the last change of runner (a change of
    /// runner switches every earlier agent off without an event).
    pub under_runner: bool,
    /// Daily dollar limit it named.
    pub usd_cap: u128,
    /// Daily Team Share limit it named.
    pub share_cap: u128,
}

impl AgentSeen {
    /// Whether the events say the agent can act now: switched on, and set
    /// under the current runner. The contract's own views decide in the end
    /// (`agents(addr).active` and the epoch); this only orders accounts when
    /// there are more than the record reads.
    pub fn probably_live(&self) -> bool {
        self.active && self.under_runner
    }
}

/// Sums of events, for the record's totals.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Totals {
    /// Everything ever paid in to Back, fee included (`Joined.paid`).
    pub joined: u128,
    /// The platform fee on those (`Joined.fee`).
    pub fees: u128,
    /// Everything paid out to Take out, backers and Team Shares.
    pub took_out: u128,
    /// Everything drawn from the allowance.
    pub drawn: u128,
    /// Everything paid in from outside.
    pub outside: u128,
    /// Everything paid to workers for tasks (`TaskResolved.pay`).
    pub paid_to_workers: u128,
    /// Everything paid out for claimed exit notes (`NoteClaimed.paid`).
    pub note_claims: u128,
}

/// The addresses of a project's contracts (lower-case `0x` text).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Contracts {
    /// The Treasury.
    pub treasury: String,
    /// The backer Shares token.
    pub shares: String,
    /// The Team Shares token.
    pub team: String,
    /// The Vester.
    pub vester: String,
    /// The dollar token (`Platform.quote`).
    pub dollar: String,
    /// The task book, once the Treasury's `TasksReady` has been read.
    pub tasks: Option<String>,
    /// The holder pause, once the Treasury's `PauseReady` has been read (only a project of a deployment whose
    /// pause switch is on has one).
    pub pause: Option<String>,
    /// The earlier backers' claim contract, once the Launcher's `EarlierBound` for this project has been read.
    pub earlier: Option<String>,
    /// The project's Council, once the Launcher's `CouncilMade` for this project has been read.
    pub council: Option<String>,
}

/// What the holder pause's events say: who parked how much, and when the line was last seen reached.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PauseSeen {
    /// What each account has parked now (accounts with nothing parked are not kept).
    pub parked_by: BTreeMap<String, u128>,
    /// The sum of those (`HolderPause.parkedTotal()`).
    pub parked_total: u128,
    /// `armedAt` as the last event of the pause said (0 when it is not armed).
    pub armed_at: u64,
}

impl PauseSeen {
    /// How many accounts have Shares parked now.
    pub fn parker_count(&self) -> u64 {
        self.parked_by.len() as u64
    }
}

/// An account holding Shares or Team Shares.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Holder {
    /// The account.
    pub account: String,
    /// Backer Shares in hand.
    pub shares: u128,
    /// Team Shares in hand.
    pub team: u128,
}

/// The numbers the contracts' own views give for what the ledger rebuilds
/// (as of the same block): what [`Ledger::mismatches`] compares with.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Stored {
    /// `Treasury.pot()`.
    pub pot: u128,
    /// `Treasury.paidIn()`.
    pub paid_in: u128,
    /// `Treasury.box()`.
    pub box_: u128,
    /// `Treasury.arriving()`.
    pub arriving: u128,
    /// `Treasury.feesOwed()`.
    pub fees_owed: u128,
    /// `Treasury.Z()`.
    pub z: u128,
    /// `Treasury.activeSeconds()`.
    pub active_seconds: u128,
    /// `Treasury.lastSettle()`.
    pub last_settle: u64,
    /// `shares.totalSupply()`.
    pub shares_supply: u128,
    /// `team.totalSupply()`.
    pub team_supply: u128,
    /// `team.balanceOf(vester)`.
    pub vester_team_balance: u128,
    /// `Treasury.locked()`.
    pub locked: u128,
    /// `Treasury.notesOwed()`.
    pub notes_owed: u128,
    /// `Treasury.arrivalStart()`.
    pub arrival_start: u64,
    /// `Treasury.arrivalTotal()`.
    pub arrival_total: u128,
    /// The book's own numbers, when the project has a book.
    pub book: Option<StoredBook>,
}

/// The numbers the task book's views give, as of the same block.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct StoredBook {
    /// `book.openCount()`.
    pub open_count: u128,
    /// `book.nextSerial()`.
    pub next_serial: u128,
    /// `book.windowSumBps()` as read.
    pub window_sum_bps: u128,
    /// The time the view was read at (the block's time).
    pub at: u64,
    /// The cap's window in seconds (`CAP_WINDOW_MULT x unit`).
    pub span: u64,
}

/// One number on which the ledger and the contract's view disagree.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mismatch {
    /// The field.
    pub field: &'static str,
    /// What the events add up to.
    pub ledger: u128,
    /// What the view says (the view is right).
    pub view: u128,
}

/// A project rebuilt from its events.
#[derive(Clone, Debug)]
pub struct Ledger {
    /// The project's chain key (`ProjectLaunched.key`), lower-case `0x` text.
    pub key: String,
    /// The id the founder chose.
    pub project_id: String,
    /// Who launched it.
    pub founder: String,
    /// When it was born.
    pub launched_at: u64,
    /// Its contracts.
    pub contracts: Contracts,
    /// The first Pair the Launcher made for it, if any.
    pub pair: Option<String>,
    /// The Team pool set at birth (the founder's pool only).
    pub team_pool: u128,
    /// The Team Shares the Launcher set aside at birth for the earlier backers (`EarlierPoolFunded`), on top of
    /// `team_pool`; none for a project that is not the one the claim contract names.
    pub earlier_pool: Option<u128>,
    /// The claim contract was tied to this project's Vester (`EarlierGrants.Bound`).
    pub earlier_bound: bool,
    /// Rows claimed and Team Shares claimed so far, as the claim contract's last `Claimed` said (running totals).
    pub earlier_claimed: (u32, u128),
    /// The holder pause's events.
    pub pause_seen: PauseSeen,
    /// The project's Council and its pending proposals (`COUNCIL-PLAN.md` section 1.6).
    pub council: CouncilSeen,
    /// The project's vote contract's ballots: absolute tallies, never voters (`COUNCIL-PLAN.md` section 5.1).
    pub vote: VoteSeen,
    /// The platform fee in ten-thousandths, as at birth.
    pub fee_bps: u32,
    /// The time unit in seconds, as at birth.
    pub unit: u64,
    /// The pot as of the last settle.
    pub pot: u128,
    /// Money set aside for taken tasks (the stayers' claims) as of the last
    /// settle.
    pub locked: u128,
    /// Money held for exit notes.
    pub notes_owed: u128,
    /// The block of the Treasury's `TasksReady` (the book's first possible log).
    pub book_block: Option<u64>,
    /// The task book's events.
    pub tasks: TaskLedger,
    /// What backers put in and have not taken back (paid-in, A).
    pub paid_in: u128,
    /// Backer Shares in existence (B).
    pub shares: u128,
    /// Team Shares counted (G).
    pub team: u128,
    /// Team Shares announced to burn (Z).
    pub z: u128,
    /// The allowance box as of the last settle.
    pub box_: u128,
    /// Outside money not yet arrived, as of the last settle.
    pub arriving: u128,
    /// When the last of it arrives (0 when none ever came).
    pub arrival_end: u64,
    /// When the current stream of outside money started arriving (the block
    /// time of the last `RevenueAdded`; 0 when none ever came).
    pub arrival_start: u64,
    /// The size of the current stream (`RevenueAdded.arrivingAfter`).
    pub arrival_total: u128,
    /// Active seconds as of the last settle.
    pub active_seconds: u128,
    /// The time of the last settle that moved something (its `Settled`
    /// event). The contract's `lastSettle()` can be later: a settle that moves
    /// nothing emits nothing but still sets it.
    pub last_settle: u64,
    /// The platform's fee waiting to be collected.
    pub fees_owed: u128,
    /// The allowance rate now (parts per million a day).
    pub rate_ppm: u32,
    /// A raise waiting.
    pub pending_rate: Option<PendingRate>,
    /// The founder's door switch.
    pub door_open: bool,
    /// The runner's last check-in (the birth time if none).
    pub last_check_in: u64,
    /// The record hash of the newest check-in.
    pub last_record_hash: Option<String>,
    /// Set once wound down.
    pub wind_down: Option<WindDown>,
    /// Who may check in, draw and change the rules.
    pub runner: String,
    /// Every account an `AgentSet` named, with what that event said.
    pub agents: BTreeMap<String, AgentSeen>,
    /// Every grant, by id.
    pub grants: BTreeMap<u64, Grant>,
    /// Sums of events.
    pub totals: Totals,
    /// The time of the first `Joined` (every join has money in it).
    pub first_backed_at: Option<u64>,
    /// Every draw from the allowance, with its block time, oldest first.
    pub draws: Vec<(u64, u128)>,
    shares_balances: BTreeMap<String, u128>,
    team_balances: BTreeMap<String, u128>,
    seen: HashSet<(u64, u32)>,
}

/// The Shares `Transfer`s of `rows` that are the other half of a park or an un-park: for each `Parked` or `Unparked`
/// row, the `Transfer` of the same Shares between the account and the pause in the same transaction with the greatest log
/// index below it (each used once), as `(block, log_index)`. `park` pulls the Shares and then says so; `unpark` sends them
/// and then says so. The same rule the store applies to the balances it keeps.
fn park_acts(rows: &[LogRow]) -> HashSet<(u64, u32)> {
    let text = |row: &LogRow, name: &str| {
        row.fields
            .get(name)
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    // The reader's own rows carry no `Transfer`s (the store keeps the balances), so there is nothing to look for.
    let mut by_tx: HashMap<[u8; 32], Vec<&LogRow>> = HashMap::new();
    for row in rows
        .iter()
        .filter(|r| r.role == Role::Shares && r.event == "Transfer")
    {
        by_tx.entry(row.tx).or_default().push(row);
    }
    let mut used = HashSet::new();
    if by_tx.is_empty() {
        return used;
    }
    for row in rows
        .iter()
        .filter(|r| r.role == Role::Pause && matches!(r.event.as_str(), "Parked" | "Unparked"))
    {
        let (Some(who), Some(amount)) = (text(row, "who"), text(row, "amount")) else {
            continue;
        };
        let pause = hex0x(&row.address);
        let (from, to) = if row.event == "Parked" {
            (who, pause)
        } else {
            (pause, who)
        };
        let found = by_tx
            .get(&row.tx)
            .into_iter()
            .flatten()
            .filter(|t| {
                t.block == row.block
                    && t.log_index < row.log_index
                    && !used.contains(&(t.block, t.log_index))
                    && text(t, "from").as_deref() == Some(from.as_str())
                    && text(t, "to").as_deref() == Some(to.as_str())
                    && text(t, "value").as_deref() == Some(amount.as_str())
            })
            .max_by_key(|t| t.log_index);
        if let Some(t) = found {
            used.insert((t.block, t.log_index));
        }
    }
    used
}

pub(super) fn text<'a>(row: &'a LogRow, name: &str) -> anyhow::Result<&'a str> {
    row.fields
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("{}.{name} is missing or not text", row.event))
}

pub(super) fn num(row: &LogRow, name: &str) -> anyhow::Result<u128> {
    text(row, name)?
        .parse::<u128>()
        .with_context(|| format!("{}.{name} is not an amount", row.event))
}

pub(super) fn small(row: &LogRow, name: &str) -> anyhow::Result<u64> {
    u64::try_from(num(row, name)?).with_context(|| format!("{}.{name} is too large", row.event))
}

pub(super) fn flag(row: &LogRow, name: &str) -> anyhow::Result<bool> {
    row.fields
        .get(name)
        .and_then(Value::as_bool)
        .ok_or_else(|| anyhow!("{}.{name} is missing or not true or false", row.event))
}

pub(super) fn address(row: &LogRow, name: &str) -> anyhow::Result<String> {
    Ok(text(row, name)?.to_owned())
}

fn nested<'a>(row: &'a LogRow, outer: &str, name: &str) -> anyhow::Result<&'a str> {
    row.fields
        .get(outer)
        .and_then(|o| o.get(name))
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("{}.{outer}.{name} is missing", row.event))
}

fn nested_num(row: &LogRow, outer: &str, name: &str) -> anyhow::Result<u128> {
    nested(row, outer, name)?
        .parse::<u128>()
        .with_context(|| format!("{}.{outer}.{name} is not an amount", row.event))
}

pub(super) fn sub(a: u128, b: u128, what: &str) -> anyhow::Result<u128> {
    a.checked_sub(b)
        .ok_or_else(|| anyhow!("{what} would go below zero ({a} less {b})"))
}

pub(super) fn add(a: u128, b: u128, what: &str) -> anyhow::Result<u128> {
    a.checked_add(b)
        .ok_or_else(|| anyhow!("{what} is too large"))
}

impl Ledger {
    /// Rebuild a project from its stored rows (oldest first). `None` when its
    /// launch is not among them (after a rollback, or a project of another
    /// Launcher).
    pub fn from_logs(rows: &[LogRow]) -> anyhow::Result<Option<Self>> {
        let Some(launch) = rows
            .iter()
            .find(|r| r.role == Role::Launcher && r.event == "ProjectLaunched")
        else {
            return Ok(None);
        };
        let mut ledger = Self::launched(launch)?;
        // A Council's own `SeatsSet` is logged inside the transaction that makes it, *before* the Launcher's
        // `CouncilMade` names it; the single pass below would skip it as "not ours yet" and the events would say the
        // next election is at 0. The newest `CouncilMade` names the Council the project has now, so learn it first.
        if let Some(made) = rows
            .iter()
            .rev()
            .find(|r| r.role == Role::Launcher && r.event == "CouncilMade")
        {
            let council = address(made, "council")?;
            ledger.contracts.council = Some(council.clone());
            ledger.council.contract = Some(council);
        }
        let acts = park_acts(rows);
        for row in rows {
            // A park (or an un-park) is one act: its `Transfer` is not a movement of anyone's holding.
            if !acts.contains(&(row.block, row.log_index)) {
                ledger.apply(row)?;
            }
        }
        Ok(Some(ledger))
    }

    fn launched(row: &LogRow) -> anyhow::Result<Self> {
        let launched_at = nested_num(row, "project", "launchedAt")?;
        let launched_at = u64::try_from(launched_at).context("launchedAt is too large")?;
        let founder = address(row, "founder")?;
        let team_pool = nested_num(row, "terms", "teamPool")?;
        Ok(Self {
            key: hex0x(
                &super::word::parse_fixed::<32>(text(row, "key")?)
                    .ok_or_else(|| anyhow!("ProjectLaunched.key is not 32 bytes"))?,
            ),
            project_id: text(row, "projectId")?.to_owned(),
            founder: founder.clone(),
            launched_at,
            contracts: Contracts {
                treasury: nested(row, "project", "treasury")?.to_owned(),
                shares: nested(row, "project", "shares")?.to_owned(),
                team: nested(row, "project", "team")?.to_owned(),
                vester: nested(row, "project", "vester")?.to_owned(),
                dollar: nested(row, "platform", "quote")?.to_owned(),
                tasks: None,
                pause: None,
                earlier: None,
                council: None,
            },
            pair: None,
            team_pool,
            earlier_pool: None,
            earlier_bound: false,
            earlier_claimed: (0, 0),
            pause_seen: PauseSeen::default(),
            council: CouncilSeen::default(),
            vote: VoteSeen::default(),
            fee_bps: u32::try_from(nested_num(row, "platform", "feeBps")?).context("feeBps")?,
            unit: u64::try_from(nested_num(row, "platform", "unit")?).context("unit")?,
            pot: 0,
            locked: 0,
            notes_owed: 0,
            book_block: None,
            tasks: TaskLedger::new(),
            paid_in: 0,
            shares: 0,
            team: team_pool,
            z: 0,
            box_: 0,
            arriving: 0,
            arrival_end: 0,
            arrival_start: 0,
            arrival_total: 0,
            active_seconds: 0,
            last_settle: launched_at,
            fees_owed: 0,
            rate_ppm: u32::try_from(nested_num(row, "terms", "ratePpm")?).context("ratePpm")?,
            pending_rate: None,
            door_open: true,
            last_check_in: launched_at,
            last_record_hash: None,
            wind_down: None,
            runner: founder,
            agents: BTreeMap::new(),
            grants: BTreeMap::new(),
            totals: Totals::default(),
            first_backed_at: None,
            draws: Vec::new(),
            shares_balances: BTreeMap::new(),
            team_balances: BTreeMap::new(),
            seen: HashSet::new(),
        })
    }

    /// Whether `row` came from this project's own contract for its role.
    fn is_ours(&self, row: &LogRow) -> bool {
        let own = match row.role {
            Role::Treasury => &self.contracts.treasury,
            Role::Vester => &self.contracts.vester,
            Role::Shares => &self.contracts.shares,
            Role::Team => &self.contracts.team,
            Role::Dollar => &self.contracts.dollar,
            // The book is named by the Treasury's own `TasksReady`; before that
            // nothing is its own.
            Role::Tasks => match &self.contracts.tasks {
                Some(book) => book,
                None => return false,
            },
            // The pause is named by the Treasury's own `PauseReady`, the claim contract by the Launcher's
            // `EarlierBound`; before that nothing is theirs.
            Role::Pause => match &self.contracts.pause {
                Some(pause) => pause,
                None => return false,
            },
            Role::Earlier => match &self.contracts.earlier {
                Some(earlier) => earlier,
                None => return false,
            },
            // The Council is named by the Launcher's own `CouncilMade`.
            Role::Council => match &self.contracts.council {
                Some(council) => council,
                None => return false,
            },
            // The Launcher and a Pair are not named by the project's own
            // launch event; their rows are chosen by the store (the Launcher's
            // by key topic, a Pair by `PairMade`).
            Role::Launcher | Role::Pair => return true,
        };
        *own == hex0x(&row.address)
    }

    /// Count one row. A row already counted (same block and log index) or
    /// from a contract that is not the project's own changes nothing.
    pub fn apply(&mut self, row: &LogRow) -> anyhow::Result<()> {
        if !self.is_ours(row) {
            return Ok(());
        }
        if self.seen.contains(&(row.block, row.log_index)) {
            return Ok(());
        }
        let known = self.apply_event(row)?;
        if known {
            self.seen.insert((row.block, row.log_index));
        }
        Ok(())
    }

    /// Returns whether the event is one the ledger counts.
    fn apply_event(&mut self, row: &LogRow) -> anyhow::Result<bool> {
        match (row.role, row.event.as_str()) {
            (Role::Launcher, "ProjectLaunched") => {
                // The row that made the ledger; counted already.
            }
            (Role::Launcher, "PairMade") => {
                if self.pair.is_none() {
                    self.pair = Some(address(row, "pair")?);
                }
            }
            (Role::Treasury, "Joined") => {
                self.pot = num(row, "potAfter")?;
                self.paid_in = num(row, "paidInAfter")?;
                self.shares = num(row, "sharesAfter")?;
                let fee = num(row, "fee")?;
                self.fees_owed = add(self.fees_owed, fee, "fees owed")?;
                self.totals.joined = add(self.totals.joined, num(row, "paid")?, "joined")?;
                self.totals.fees = add(self.totals.fees, fee, "fees")?;
                if self.first_backed_at.is_none() {
                    self.first_backed_at = Some(row.time);
                }
            }
            (Role::Treasury, "Left") => {
                self.pot = num(row, "potAfter")?;
                self.paid_in = num(row, "paidInAfter")?;
                self.shares = num(row, "sharesAfter")?;
                self.totals.took_out = add(self.totals.took_out, num(row, "cash")?, "took out")?;
            }
            (Role::Treasury, "TeamLeft") => {
                self.pot = num(row, "potAfter")?;
                self.team = num(row, "teamAfter")?;
                self.totals.took_out = add(self.totals.took_out, num(row, "cash")?, "took out")?;
            }
            (Role::Treasury, "AllowanceDrawn") => {
                self.box_ = num(row, "boxAfter")?;
                let amount = num(row, "amount")?;
                self.totals.drawn = add(self.totals.drawn, amount, "drawn")?;
                self.draws.push((row.time, amount));
            }
            (Role::Treasury, "Settled") => {
                self.pot = num(row, "potAfter")?;
                self.box_ = num(row, "boxAfter")?;
                self.arriving = num(row, "arrivingAfter")?;
                self.active_seconds = num(row, "activeSecondsAfter")?;
                self.last_settle = small(row, "time")?;
            }
            (Role::Treasury, "RateProposed") => {
                self.pending_rate = Some(PendingRate {
                    ppm: u32::try_from(num(row, "ppm")?).context("RateProposed.ppm")?,
                    applicable_at: small(row, "applicableAt")?,
                    proposed_at: row.time,
                });
            }
            (Role::Treasury, "RateSet") => {
                self.rate_ppm = u32::try_from(num(row, "ppm")?).context("RateSet.ppm")?;
                self.pending_rate = None;
            }
            (Role::Treasury, "CheckedIn") => {
                self.last_check_in = small(row, "time")?;
                self.last_record_hash = Some(text(row, "recordHash")?.to_owned());
            }
            (Role::Treasury, "RevenueAdded") => {
                self.arriving = num(row, "arrivingAfter")?;
                self.arrival_end = small(row, "arrivalEnd")?;
                // The contract starts a new stream now with what had not yet
                // arrived and the new money: what has arrived by any later second
                // is one rounding of one formula on these two (RECORD-V2 section 3).
                self.arrival_start = row.time;
                self.arrival_total = self.arriving;
                self.totals.outside = add(self.totals.outside, num(row, "amount")?, "outside")?;
            }
            (Role::Treasury, "RevenueReleased") => {
                self.arriving = num(row, "arrivingAfter")?;
            }
            (Role::Treasury, "DoorSet") => self.door_open = flag(row, "open")?,
            (Role::Treasury, "WoundDown") => {
                let kind = u8::try_from(num(row, "kind")?).context("WoundDown.kind")?;
                self.pot = add(self.pot, num(row, "boxReturned")?, "pot")?;
                self.box_ = 0;
                self.wind_down = Some(WindDown {
                    kind,
                    at: small(row, "time")?,
                });
            }
            (Role::Treasury, "FeesCollected") => {
                self.fees_owed = sub(self.fees_owed, num(row, "amount")?, "fees owed")?;
            }
            (Role::Treasury, "RunnerChanged") => {
                self.runner = address(row, "to")?;
                for agent in self.agents.values_mut() {
                    agent.under_runner = false;
                }
            }
            (Role::Treasury, "SeatOffered") => {
                // An offer is read from the chain when it is shown.
            }
            (Role::Treasury, "AgentSet") => {
                self.agents.insert(
                    address(row, "agent")?,
                    AgentSeen {
                        active: flag(row, "active")?,
                        under_runner: true,
                        usd_cap: num(row, "usdCap")?,
                        share_cap: num(row, "shareCap")?,
                    },
                );
            }
            (Role::Treasury, "BurnAnnounced") => self.z = num(row, "zAfter")?,
            (Role::Treasury, "TasksReady") => {
                if self.contracts.tasks.is_none() {
                    self.contracts.tasks = Some(address(row, "book")?);
                    self.book_block = Some(row.block);
                }
            }
            (Role::Treasury, "PauseReady") => {
                if self.contracts.pause.is_none() {
                    self.contracts.pause = Some(address(row, "gate")?);
                }
            }
            (Role::Launcher, "CouncilMade") => {
                if self.contracts.council.is_none() {
                    let council = address(row, "council")?;
                    self.contracts.council = Some(council);
                    self.council.contract = self.contracts.council.clone();
                }
            }
            (Role::Launcher, "EarlierBound") => {
                if self.contracts.earlier.is_none() {
                    self.contracts.earlier = Some(address(row, "earlier")?);
                }
            }
            (Role::Launcher, "EarlierPoolFunded") => {
                // The Launcher minted the pool to the Vester on top of `teamPool`, so the Team supply is both.
                if self.earlier_pool.is_none() {
                    let amount = num(row, "amount")?;
                    self.earlier_pool = Some(amount);
                    self.team = add(self.team, amount, "the Team supply")?;
                }
            }
            (Role::Earlier, "Bound") => self.earlier_bound = true,
            (Role::Earlier, "Claimed") => {
                let (rows, total) = (
                    u32::try_from(num(row, "claimedRows")?).context("Claimed.claimedRows")?,
                    num(row, "claimedTotal")?,
                );
                let (rows_before, total_before) = self.earlier_claimed;
                let amount = num(row, "amount")?;
                if rows != rows_before + 1 || total != add(total_before, amount, "claimed")? {
                    bail!(
                        "a claim says {rows} rows and {total} claimed after {rows_before} and {total_before} and {amount} more"
                    );
                }
                self.earlier_claimed = (rows, total);
            }
            (Role::Pause, event @ ("Parked" | "Unparked")) => {
                self.apply_park(row, event == "Parked")?
            }
            (Role::Pause, "Observed") => {
                if num(row, "parkedTotal")? != self.pause_seen.parked_total {
                    bail!(
                        "the pause says {} parked, the events add up to {}",
                        num(row, "parkedTotal")?,
                        self.pause_seen.parked_total
                    );
                }
                self.pause_seen.armed_at = small(row, "armedAt")?;
            }
            (Role::Pause, event) => {
                return super::ledger_council::apply_vote(row, &mut self.vote)
                    .map_err(|e| e.context(format!("pause event {event}")));
            }
            (Role::Council, event) => {
                return super::ledger_council::apply_council(row, &mut self.council)
                    .map_err(|e| e.context(format!("council event {event}")));
            }
            (Role::Treasury, "TaskMoney") => {
                // The three buckets after the move, as `TaskLedger._applyTaskMoney` keeps them.
                self.pot = num(row, "potAfter")?;
                self.locked = num(row, "lockedAfter")?;
                self.notes_owed = num(row, "notesOwedAfter")?;
            }
            (Role::Tasks, event) => {
                let known = self.tasks.apply(row)?;
                if known {
                    match event {
                        "TaskResolved" => {
                            self.totals.paid_to_workers = add(
                                self.totals.paid_to_workers,
                                num(row, "pay")?,
                                "paid to workers",
                            )?;
                        }
                        "NoteClaimed" => {
                            self.totals.note_claims =
                                add(self.totals.note_claims, num(row, "paid")?, "note claims")?;
                        }
                        _ => {}
                    }
                }
                return Ok(known);
            }
            (Role::Vester, "GrantMade") => {
                let id = small(row, "id")?;
                let amount = num(row, "amount")?;
                self.grants.insert(
                    id,
                    Grant {
                        id,
                        member: address(row, "member")?,
                        protected: num(row, "kind")? == 1,
                        state: GrantState::Live,
                        granted: amount,
                        total: amount,
                        claimed: 0,
                        start_active: num(row, "startActive")?,
                        burn: 0,
                        burn_at: 0,
                        by_member: None,
                    },
                );
            }
            (Role::Vester, "ForfeitAnnounced") => {
                let id = small(row, "id")?;
                let burn = num(row, "amount")?;
                let by_member = flag(row, "byMember")?;
                let burn_at = small(row, "burnAt")?;
                let g = self.grant(id, &row.event)?;
                g.total = sub(g.total, burn, "a grant's total")?;
                g.burn = burn;
                g.burn_at = burn_at;
                g.state = GrantState::Announced;
                g.by_member = Some(by_member);
                self.z = num(row, "zAfter")?;
            }
            (Role::Vester, "Forfeited") => {
                let id = small(row, "id")?;
                let burned = num(row, "burned")?;
                let g = self.grant(id, &row.event)?;
                match g.state {
                    // After an announce the part to burn was taken off the
                    // total already; the burn clears it.
                    GrantState::Announced => g.burn = 0,
                    // After a wind-down: what the grant does not keep.
                    GrantState::Live => g.total = sub(g.total, burned, "a grant's total")?,
                    GrantState::Closed => bail!("grant {id} was burned twice"),
                }
                g.state = GrantState::Closed;
                self.z = num(row, "zAfter")?;
                self.team = num(row, "teamAfter")?;
            }
            (Role::Vester, "GrantClaimed") => {
                let id = small(row, "id")?;
                let amount = num(row, "amount")?;
                let g = self.grant(id, &row.event)?;
                g.claimed = add(g.claimed, amount, "a grant's claimed")?;
            }
            (Role::Vester, "UngrantedBurned") => self.team = num(row, "teamAfter")?,
            (Role::Shares, "Transfer") => {
                let (from, to, value) = (
                    address(row, "from")?,
                    address(row, "to")?,
                    num(row, "value")?,
                );
                Self::move_balance(&mut self.shares_balances, &from, &to, value)?;
            }
            (Role::Team, "Transfer") => {
                let (from, to, value) = (
                    address(row, "from")?,
                    address(row, "to")?,
                    num(row, "value")?,
                );
                Self::move_balance(&mut self.team_balances, &from, &to, value)?;
            }
            _ => return Ok(false),
        }
        Ok(true)
    }

    /// A `Parked` or `Unparked` row: the account's parked Shares and the pause's total move to the numbers the
    /// event says (each is checked against what the events before it add up to). The Shares stay the account's
    /// holding: the token's own `Transfer` that moved them is not counted ([`Ledger::from_logs`] leaves it out, and
    /// the store, which keeps the reader's balances, cancels it, see `store::park_anchors`).
    fn apply_park(&mut self, row: &LogRow, parked: bool) -> anyhow::Result<()> {
        let who = address(row, "who")?;
        let amount = num(row, "amount")?;
        let (by, total) = (num(row, "parkedBy")?, num(row, "parkedTotal")?);
        let seen = &mut self.pause_seen;
        let before = seen.parked_by.get(&who).copied().unwrap_or(0);
        let (want_by, want_total) = if parked {
            (
                add(before, amount, "parked Shares")?,
                add(seen.parked_total, amount, "parked Shares")?,
            )
        } else {
            (
                sub(before, amount, "parked Shares")?,
                sub(seen.parked_total, amount, "parked Shares")?,
            )
        };
        if by != want_by || total != want_total {
            bail!(
                "{} says {by} and {total} parked after it, the events add up to {want_by} and {want_total}",
                row.event
            );
        }
        if by == 0 {
            seen.parked_by.remove(&who);
        } else {
            seen.parked_by.insert(who.clone(), by);
        }
        seen.parked_total = total;
        seen.armed_at = small(row, "armedAt")?;
        Ok(())
    }

    fn grant(&mut self, id: u64, event: &str) -> anyhow::Result<&mut Grant> {
        self.grants
            .get_mut(&id)
            .ok_or_else(|| anyhow!("{event} names grant {id}, which was never made"))
    }

    fn move_balance(
        map: &mut BTreeMap<String, u128>,
        from: &str,
        to: &str,
        value: u128,
    ) -> anyhow::Result<()> {
        let zero = hex0x(&[0u8; 20]);
        if from == to || value == 0 {
            return Ok(());
        }
        if from != zero {
            let have = map.get(from).copied().unwrap_or(0);
            map.insert(from.to_owned(), sub(have, value, "a token balance")?);
        }
        if to != zero {
            let have = map.get(to).copied().unwrap_or(0);
            map.insert(to.to_owned(), add(have, value, "a token balance")?);
        }
        Ok(())
    }

    /// Start the holders' balances from the store's running totals (backer
    /// Shares and Team Shares, as of the same block as the rows); `Transfer`
    /// rows applied afterwards move them on.
    pub fn set_balances(
        &mut self,
        shares: &HashMap<String, i128>,
        team: &HashMap<String, i128>,
    ) -> anyhow::Result<()> {
        let take =
            |from: &HashMap<String, i128>, what: &str| -> anyhow::Result<BTreeMap<String, u128>> {
                from.iter()
                    .map(|(a, b)| {
                        u128::try_from(*b)
                            .map(|b| (a.clone(), b))
                            .map_err(|_| anyhow!("a {what} balance of {a} is negative ({b})"))
                    })
                    .collect()
            };
        self.shares_balances = take(shares, "Shares")?;
        self.team_balances = take(team, "Team Shares")?;
        Ok(())
    }

    /// Backer Shares in hand per account (zero balances left out).
    pub fn shares_balances(&self) -> impl Iterator<Item = (&String, &u128)> {
        self.shares_balances.iter().filter(|(_, v)| **v != 0)
    }

    /// Team Shares in hand per account (zero balances left out).
    pub fn team_balances(&self) -> impl Iterator<Item = (&String, &u128)> {
        self.team_balances.iter().filter(|(_, v)| **v != 0)
    }

    /// The accounts that are not holders: the zero address, the Treasury, the
    /// Vester, the two tokens, the dollar and the holder pause (Shares sent
    /// there are stuck, and nobody holds them), and `also` (the Launcher). The one list that
    /// [`Ledger::holders`] and the held-for-a-window count both leave out.
    pub fn excluded(&self, also: &BTreeSet<String>) -> BTreeSet<String> {
        let mut skip: BTreeSet<String> = also.clone();
        skip.insert(hex0x(&[0u8; 20]));
        for a in [
            &self.contracts.treasury,
            &self.contracts.vester,
            &self.contracts.shares,
            &self.contracts.team,
            &self.contracts.dollar,
        ] {
            skip.insert(a.clone());
        }
        // The pause holds parked Shares for their owners (the holdings already count them for the owner) and
        // any Shares sent to it by a plain transfer; nobody holds those.
        if let Some(pause) = &self.contracts.pause {
            skip.insert(pause.clone());
        }
        skip
    }

    /// The accounts that hold Shares or Team Shares in hand, biggest backer
    /// Shares first (then Team Shares, then address). Left out: the zero
    /// address, the Treasury, the Vester, the two tokens and the dollar
    /// (Shares sent there are stuck, nobody holds them), and `also`.
    pub fn holders(&self, also: &BTreeSet<String>) -> Vec<Holder> {
        let skip = self.excluded(also);
        let accounts: BTreeSet<&String> = self
            .shares_balances()
            .map(|(a, _)| a)
            .chain(self.team_balances().map(|(a, _)| a))
            .filter(|a| !skip.contains(*a))
            .collect();
        let mut out: Vec<Holder> = accounts
            .into_iter()
            .map(|a| Holder {
                account: a.clone(),
                shares: self.shares_balances.get(a).copied().unwrap_or(0),
                team: self.team_balances.get(a).copied().unwrap_or(0),
            })
            .collect();
        out.sort_by(|x, y| {
            y.shares
                .cmp(&x.shares)
                .then(y.team.cmp(&x.team))
                .then(x.account.cmp(&y.account))
        });
        out
    }

    /// Team Shares promised to someone and not yet sent or burned: what the
    /// Vester must always hold (`Vester.committed()`).
    pub fn committed(&self) -> u128 {
        self.grants
            .values()
            .map(|g| g.total.saturating_sub(g.claimed) + g.burn)
            .sum()
    }

    /// Backer Shares held by accounts (all of them, whoever they are).
    pub fn shares_in_hands(&self) -> u128 {
        self.shares_balances.values().sum()
    }

    /// Team Shares the Vester holds (from the Team token's `Transfer`s).
    pub fn vester_team_balance(&self) -> u128 {
        self.team_balances
            .get(&self.contracts.vester)
            .copied()
            .unwrap_or(0)
    }

    /// Compare what the events add up to with the contracts' own views, as of
    /// the same block. Every number the record is built on is checked here:
    /// where one differs the view is right and the record must not be signed.
    pub fn mismatches(&self, view: &Stored) -> Vec<Mismatch> {
        let mut out = Vec::new();
        let mut check = |field: &'static str, ledger: u128, view: u128| {
            if ledger != view {
                out.push(Mismatch {
                    field,
                    ledger,
                    view,
                });
            }
        };
        check("pot", self.pot, view.pot);
        check("locked", self.locked, view.locked);
        check("notesOwed", self.notes_owed, view.notes_owed);
        check(
            "arrivalStart",
            u128::from(self.arrival_start),
            u128::from(view.arrival_start),
        );
        check("arrivalTotal", self.arrival_total, view.arrival_total);
        if let Some(book) = &view.book {
            check(
                "openCount",
                u128::from(self.tasks.open_count),
                book.open_count,
            );
            check(
                "nextSerial",
                u128::from(self.tasks.next_serial),
                book.next_serial,
            );
            check(
                "windowSumBps",
                self.tasks.window_sum(book.at, book.span),
                book.window_sum_bps,
            );
        }
        check("paidIn", self.paid_in, view.paid_in);
        check("box", self.box_, view.box_);
        check("arriving", self.arriving, view.arriving);
        check("feesOwed", self.fees_owed, view.fees_owed);
        check("Z", self.z, view.z);
        check("activeSeconds", self.active_seconds, view.active_seconds);
        check("sharesSupply", self.shares, view.shares_supply);
        check("teamSupply", self.team, view.team_supply);
        // The token balances the Transfers add up to must be the supplies.
        check(
            "sharesBalancesSum",
            self.shares_in_hands(),
            view.shares_supply,
        );
        check(
            "teamBalancesSum",
            self.team_balances.values().sum(),
            view.team_supply,
        );
        check(
            "vesterTeamBalance",
            self.vester_team_balance(),
            view.vester_team_balance,
        );
        // `lastSettle` is set by every settling call, but a settle that moves
        // nothing emits no `Settled` (the numbers it leaves are the numbers it
        // found), so the events give a time that is never later than the
        // view's, and equal to it unless such a silent settle came after.
        if self.last_settle > view.last_settle {
            out.push(Mismatch {
                field: "lastSettle",
                ledger: u128::from(self.last_settle),
                view: u128::from(view.last_settle),
            });
        }
        out
    }
}

#[cfg(test)]
#[path = "ledger_tests.rs"]
mod tests;
