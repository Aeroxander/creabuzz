//! The project numbers record, version 2, as typed data
//! (`docs/next-version/RECORD-V2.md` sections 2 and 3), and the checks the
//! server makes on every record it is about to sign (section 4.3).
//!
//! The types are the spec's fields and nothing else: an unknown field is an
//! error when a record is read back (`deny_unknown_fields`), so the example
//! file (`docs/next-version/record-v2-example.json`) cannot drift from what
//! the server writes. Amounts are decimal strings of whole numbers; times are
//! unix seconds.
//!
//! [`roll_forward`] is the one place the server repeats a contract formula
//! (section 3): the settled pot, box, arriving money and active time, worked
//! forward from the stored numbers exactly as `Treasury._settled()` does. It is
//! checked against two of the contract's own views on every build.
//! [`validate`] runs the rules of section 7.3 that need no other contract
//! formula over a finished record.

use anyhow::{anyhow, bail, Context};
use serde::{Deserialize, Serialize};

/// The record's version.
pub const VERSION: u32 = 2;
/// "Dormant" is a display state at this many units of quiet (section 9, S5):
/// the contracts have no number for it.
pub const DORMANT_UNITS: u64 = 13;
/// The most holders a record lists.
pub const MAX_HOLDERS: usize = 200;
/// The most grants a record lists.
pub const MAX_GRANTS: usize = 200;
/// The most agents a record lists.
pub const MAX_AGENTS: usize = 50;
/// Parts per million.
const PPM: u128 = 1_000_000;

/// `a * b / c` rounded down, in 256-bit arithmetic: the contracts' `mulDiv`.
/// `None` when `c` is zero or the result does not fit in 128 bits.
pub fn mul_div(a: u128, b: u128, c: u128) -> Option<u128> {
    if c == 0 {
        return None;
    }
    const LOW: u128 = u64::MAX as u128;
    let (a0, a1) = (a & LOW, a >> 64);
    let (b0, b1) = (b & LOW, b >> 64);
    let (p00, p01, p10, p11) = (a0 * b0, a0 * b1, a1 * b0, a1 * b1);
    let mid = (p00 >> 64) + (p01 & LOW) + (p10 & LOW);
    let lo = (p00 & LOW) | (mid << 64);
    let hi = p11 + (p01 >> 64) + (p10 >> 64) + (mid >> 64);
    if hi >= c {
        return None;
    }
    // Long division of the 256-bit product (hi, lo) by c, one bit at a time.
    let (mut rem, mut quot) = (hi, 0u128);
    for i in (0..128).rev() {
        let carry = rem >> 127;
        rem = (rem << 1) | ((lo >> i) & 1);
        quot <<= 1;
        if carry == 1 || rem >= c {
            rem = rem.wrapping_sub(c);
            quot |= 1;
        }
    }
    Some(quot)
}

/// Where a project's money stood at its last settle (the contract's stored
/// numbers) and what the roll-forward needs besides.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Stored {
    /// `lastSettle()`.
    pub last_settle: u64,
    /// `activeEnd()`: zero once wound down.
    pub active_end: u64,
    /// `arrivalEnd()`.
    pub arrival_end: u64,
    /// `ratePpm()`.
    pub rate_ppm: u32,
    /// `unit()`.
    pub unit: u64,
    /// `pot()`.
    pub pot: u128,
    /// `box()`.
    pub box_: u128,
    /// `arriving()`.
    pub arriving: u128,
    /// `activeSeconds()`.
    pub active_seconds: u128,
}

/// The numbers after the roll-forward.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Settled {
    /// The pot.
    pub pot: u128,
    /// The allowance box.
    pub box_: u128,
    /// Outside money not yet arrived.
    pub arriving: u128,
    /// Active seconds.
    pub active_seconds: u128,
}

impl Settled {
    /// The most the box can hold: seven days of accrual on the pot and box.
    pub fn box_cap(&self, rate_ppm: u32) -> Option<u128> {
        mul_div(
            self.pot.checked_add(self.box_)?,
            u128::from(rate_ppm) * 7,
            PPM,
        )
    }
}

/// Work the stored numbers forward to time `t`, in integers, exactly as
/// `Treasury._settled()` does (RECORD-V2 section 3).
pub fn roll_forward(t: u64, s: &Stored) -> anyhow::Result<Settled> {
    let overflow = || anyhow!("the settled numbers overflow");
    let (mut pot, mut box_, mut arriving) = (s.pot, s.box_, s.arriving);
    let upto = t.min(s.active_end);
    let dt = upto.saturating_sub(s.last_settle);
    let rate = u128::from(s.rate_ppm);
    let cap =
        mul_div(pot.checked_add(box_).ok_or_else(overflow)?, rate * 7, PPM).ok_or_else(overflow)?;
    if dt != 0 && rate != 0 {
        let day = u128::from(s.unit / 7);
        let to_box = mul_div(pot, rate * u128::from(dt), PPM * day).ok_or_else(overflow)?;
        box_ = box_.checked_add(to_box).ok_or_else(overflow)?;
        pot = pot.checked_sub(to_box).ok_or_else(overflow)?;
    }
    if box_ > cap {
        pot = pot.checked_add(box_ - cap).ok_or_else(overflow)?;
        box_ = cap;
    }
    if arriving != 0 {
        let released = if t >= s.arrival_end {
            arriving
        } else {
            // The span is positive: the end is after `t`, and `t` is not
            // before the last settle.
            let span = s
                .arrival_end
                .checked_sub(s.last_settle)
                .filter(|span| *span != 0)
                .ok_or_else(|| {
                    anyhow!("outside money is arriving but its end is not after the last settle")
                })?;
            mul_div(
                arriving,
                u128::from(t.saturating_sub(s.last_settle)),
                u128::from(span),
            )
            .ok_or_else(overflow)?
        };
        arriving -= released;
        pot = pot.checked_add(released).ok_or_else(overflow)?;
    }
    Ok(Settled {
        pot,
        box_,
        arriving,
        active_seconds: s.active_seconds + u128::from(dt),
    })
}

/// Where a project is at a time (section 2.7).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuietState {
    /// Checked in within the window.
    Active,
    /// Past the window: no allowance, no vesting, door shut.
    Quiet,
    /// Past 13 units.
    Dormant,
    /// Past 26 units: anyone may wind it down.
    MayWindDown,
    /// Wound down.
    WoundDown,
}

/// The state word at time `t`, from the three times of a project that is not
/// wound down.
pub fn quiet_state(t: u64, quiet_from: u64, dormant_from: u64, windable_from: u64) -> QuietState {
    if t < quiet_from {
        QuietState::Active
    } else if t < dormant_from {
        QuietState::Quiet
    } else if t < windable_from {
        QuietState::Dormant
    } else {
        QuietState::MayWindDown
    }
}

/// The state after `state` and when it starts, from the three times.
pub fn next_state(
    state: QuietState,
    quiet_from: u64,
    dormant_from: u64,
    windable_from: u64,
) -> Option<QuietNext> {
    let (state, at) = match state {
        QuietState::Active => (QuietState::Quiet, quiet_from),
        QuietState::Quiet => (QuietState::Dormant, dormant_from),
        QuietState::Dormant => (QuietState::MayWindDown, windable_from),
        QuietState::MayWindDown | QuietState::WoundDown => return None,
    };
    Some(QuietNext { state, at })
}

// ---------------------------------------------------------------- the record

/// A project's contracts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContractsRec {
    /// The Treasury.
    pub treasury: String,
    /// The backer Shares token.
    pub shares: String,
    /// The Team Shares token.
    pub team: String,
    /// The Vester.
    pub vester: String,
    /// The dollar token.
    pub dollar: String,
    /// The project's Pair, once there is one.
    pub pair: Option<String>,
}

/// The block every number is true for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AsOfRec {
    /// The final block.
    pub block: u64,
    /// Its timestamp.
    pub time: u64,
}

/// The platform fee.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FeeRec {
    /// Ten-thousandths charged on money going in.
    pub bps: u32,
}

/// The project's money (dollar units, 6 decimals).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct MoneyRec {
    /// What taking out can reach now.
    pub pot: String,
    /// What backers put in and have not taken back.
    pub paid_in: String,
    /// Outside money not yet in the pot.
    pub arriving: String,
    /// When the last of it has arrived.
    pub arrival_end: Option<u64>,
    /// The platform's fee waiting to be collected.
    pub fees_owed: String,
    /// Money set aside for a taken task (step 2).
    pub locked: String,
    /// Exit notes owed (step 2).
    pub notes_owed: String,
    /// Every dollar the Treasury holds.
    pub held: String,
}

/// Shares in existence (18 decimals).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SharesRec {
    /// Backer Shares.
    pub backers: String,
    /// Team Shares counted.
    pub team_counted: String,
    /// Team Shares announced to burn.
    pub announced_burn: String,
}

/// What one Share is worth if taken out now.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorthRec {
    /// One whole backer Share.
    pub leave_value: String,
    /// One whole Team Share.
    pub team_value: String,
}

/// A rate raise waiting.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PendingRec {
    /// The rate it becomes.
    pub rate_ppm: u32,
    /// When it was announced.
    pub proposed_at: u64,
    /// The first moment anyone may apply it.
    pub applicable_at: u64,
}

/// The allowance.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AllowanceRec {
    /// Parts per million of the pot a day.
    pub rate_ppm: u32,
    /// A raise waiting.
    pub pending: Option<PendingRec>,
    /// Accrued and not yet drawn.
    #[serde(rename = "box")]
    pub box_: String,
    /// The most the box can hold.
    pub box_cap: String,
    /// Drawn in the last day.
    pub drawn_last_day: String,
}

/// The weekly clock.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ClockRec {
    /// The runner's last check-in.
    pub last_check_in: u64,
    /// The hash signed with it.
    pub last_record_hash: Option<String>,
    /// The end of the check-in window.
    pub active_until: Option<u64>,
    /// Active time so far.
    pub active_seconds: u64,
}

/// The door.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DoorRec {
    /// The founder's switch.
    pub switch_on: bool,
    /// Whether a join would be accepted now.
    pub open_now: bool,
    /// When the door shuts by rule.
    pub shuts_at: Option<u64>,
}

/// The next quiet state and when it starts.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QuietNext {
    /// The state.
    pub state: QuietState,
    /// When.
    pub at: u64,
}

/// Where the project is on the quiet scale.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct QuietRec {
    /// The state at `asOf.time`.
    pub state: QuietState,
    /// When it started.
    pub since: u64,
    /// When "quiet" starts.
    pub quiet_from: Option<u64>,
    /// When "dormant" starts.
    pub dormant_from: Option<u64>,
    /// When anyone may wind the project down.
    pub windable_from: Option<u64>,
    /// The next state.
    pub next: Option<QuietNext>,
}

/// A wind-down.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WindDownRec {
    /// 1 by choice, 2 after 26 quiet units.
    pub kind: u8,
    /// When.
    pub at: u64,
}

/// Who runs the project.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RunnerRec {
    /// The runner.
    pub address: String,
    /// Whether it is a Pair the Launcher made.
    pub is_pair: bool,
    /// The Pair's two signers.
    pub signers: Option<[String; 2]>,
}

/// A grant's cliff.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CliffRec {
    /// Whether it has passed.
    pub passed: bool,
    /// When it passes if the project keeps checking in.
    pub ends_at_if_active: Option<u64>,
}

/// A forfeit notice running.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ForfeitRec {
    /// The unvested part announced to burn.
    pub amount: String,
    /// When anyone may run the burn.
    pub burn_at: u64,
    /// True for the member's own exit.
    pub by_member: bool,
}

/// A grant's kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GrantKind {
    /// Vests on active time with a cliff.
    Normal,
    /// Vests on calendar time, no cliff, never forfeited.
    Protected,
}

/// A grant's state.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GrantStateRec {
    /// Vesting.
    Live,
    /// The unvested part is announced to burn.
    Announced,
    /// Settled.
    Closed,
}

/// One grant that is not finished.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct GrantRec {
    /// Its id in the Vester.
    pub id: u64,
    /// Who it is for.
    pub member: String,
    /// Its kind.
    pub kind: GrantKind,
    /// Its state.
    pub state: GrantStateRec,
    /// What was granted.
    pub granted: String,
    /// What the member keeps.
    pub keeps: String,
    /// Already sent to the member.
    pub claimed: String,
    /// Unlocked so far.
    pub vested: String,
    /// What the member can claim now.
    pub claimable: String,
    /// Active time at the grant.
    pub start_active: u64,
    /// The cliff (live normal grants).
    pub cliff: Option<CliffRec>,
    /// When it is fully vested if the project keeps checking in.
    pub fully_vested_at_if_active: Option<u64>,
    /// A forfeit notice running.
    pub forfeit: Option<ForfeitRec>,
}

/// Team Shares and grants (18 decimals).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TeamRec {
    /// The pool set at birth.
    pub pool: String,
    /// Sent to members.
    pub in_hands: String,
    /// Still held by the Vester.
    pub in_vester: String,
    /// Promised and not yet sent or burned.
    pub promised: String,
    /// Nobody was granted.
    pub ungranted: String,
    /// Grants made for life.
    pub grant_count: u64,
    /// Grants not finished.
    pub grants: Vec<GrantRec>,
}

/// A helper account.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AgentRec {
    /// The account.
    pub agent: String,
    /// Whether it can act now.
    pub live: bool,
    /// Daily dollars out of the box.
    pub usd_cap: String,
    /// Daily Team Shares granted.
    pub team_cap: String,
    /// Used inside the current daily limit.
    pub usd_used: String,
    /// Used inside the current daily limit.
    pub team_used: String,
}

/// What the contracts allow.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LimitsRec {
    /// The smallest Back.
    pub min_join: String,
    /// The smallest outside payment.
    pub min_outside_payment: String,
    /// The allowance ceiling.
    pub max_rate_ppm: u32,
    /// The check-in window in units.
    pub check_in_window_units: u64,
    /// Quiet units after which anyone may wind down.
    pub wind_down_units: u64,
    /// The vesting cliff in units.
    pub cliff_units: u64,
    /// The vesting length in units.
    pub vest_units: u64,
    /// The smallest grant.
    pub min_grant: String,
    /// Grants one member can ever get.
    pub max_grants_per_member: u64,
    /// The default daily dollars of a new agent.
    pub agent_usd_per_day: String,
    /// The default daily Team Shares of a new agent.
    pub agent_team_per_day: String,
}

/// Sums of events.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TotalsRec {
    /// Everything ever paid in to Back.
    pub joined: String,
    /// The platform fee on those.
    pub fees: String,
    /// Everything paid out to Take out.
    #[serde(rename = "tookOut")]
    pub took_out: String,
    /// Everything drawn from the allowance.
    pub drawn: String,
    /// Everything paid in from outside.
    pub outside: String,
}

/// An account holding Shares or Team Shares in hand.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HolderRec {
    /// The holder.
    pub account: String,
    /// Backer Shares in hand.
    pub shares: String,
    /// Team Shares in hand.
    pub team_shares: String,
}

/// The stored numbers as of the last settle (for checks only).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LedgerRec {
    /// The contract's `lastSettle()`.
    pub last_settle: u64,
    /// Stored pot.
    pub pot: String,
    /// Stored box.
    #[serde(rename = "box")]
    pub box_: String,
    /// Stored arriving money.
    pub arriving: String,
    /// When it ends (none when nothing is arriving).
    pub arrival_end: Option<u64>,
    /// Stored active seconds.
    pub active_seconds: u64,
}

/// The record.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Record {
    /// Always 2.
    pub version: u32,
    /// The network.
    pub chain_id: u64,
    /// The Launcher.
    pub launcher: String,
    /// The project's chain key.
    pub key: String,
    /// The id the founder chose.
    pub project_id: String,
    /// Who launched it.
    pub founder: String,
    /// When it was born.
    pub launched_at: u64,
    /// True when the dollar is play money.
    pub play_money: bool,
    /// Its contracts.
    pub contracts: ContractsRec,
    /// The block every number is true for.
    pub as_of: AsOfRec,
    /// When the server signed it.
    pub built_at: u64,
    /// How often the server promises a fresh record.
    pub refresh_every_secs: u64,
    /// The time unit in seconds.
    pub unit: u64,
    /// The platform fee.
    pub fee: FeeRec,
    /// The money.
    pub money: MoneyRec,
    /// Shares.
    pub shares: SharesRec,
    /// What one Share is worth.
    #[serde(rename = "value")]
    pub worth: WorthRec,
    /// The allowance.
    pub allowance: AllowanceRec,
    /// The weekly clock.
    pub clock: ClockRec,
    /// The door.
    pub door: DoorRec,
    /// Where it is on the quiet scale.
    pub quiet: QuietRec,
    /// A wind-down.
    pub wind_down: Option<WindDownRec>,
    /// Who runs it.
    pub runner: RunnerRec,
    /// Team Shares and grants.
    pub team: TeamRec,
    /// Helper accounts.
    pub agents: Vec<AgentRec>,
    /// What the contracts allow.
    pub limits: LimitsRec,
    /// Sums of events.
    pub totals: TotalsRec,
    /// When the first backer joined.
    pub first_backed_at: Option<u64>,
    /// Holders, biggest first.
    pub holders: Vec<HolderRec>,
    /// Accounts holding backer Shares.
    pub holder_count: u64,
    /// Accounts holding Team Shares.
    pub team_holder_count: u64,
    /// True when a list was cut at its cap.
    pub truncated: bool,
    /// The stored numbers, for checks only.
    pub ledger: LedgerRec,
}

// ----------------------------------------------------------------- the checks

fn amount(text: &str, what: &str) -> anyhow::Result<u128> {
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        bail!("{what} is not a whole number: {text:?}");
    }
    text.parse::<u128>()
        .with_context(|| format!("{what} is too large"))
}

fn is_hex(text: &str, bytes: usize) -> bool {
    text.len() == 2 + 2 * bytes
        && text.starts_with("0x")
        && text[2..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The rules every record must pass before it is signed (RECORD-V2 section
/// 4.3 and the parts of section 7.3 that need no contract formula beyond
/// section 3). Returns one line per broken rule, empty when the record is
/// sound. A record with problems is never published.
pub fn validate(r: &Record) -> Vec<String> {
    let mut bad = Vec::new();
    if let Err(e) = check(r, &mut bad) {
        bad.push(format!("{e:#}"));
    }
    bad
}

fn check(r: &Record, bad: &mut Vec<String>) -> anyhow::Result<()> {
    let mut rule = |ok: bool, what: String| {
        if !ok {
            bad.push(what);
        }
    };
    // Types.
    rule(r.version == VERSION, format!("version is {}", r.version));
    for (name, text, bytes) in [
        ("launcher", &r.launcher, 20),
        ("founder", &r.founder, 20),
        ("key", &r.key, 32),
        ("projectId", &r.project_id, 32),
        ("contracts.treasury", &r.contracts.treasury, 20),
        ("contracts.shares", &r.contracts.shares, 20),
        ("contracts.team", &r.contracts.team, 20),
        ("contracts.vester", &r.contracts.vester, 20),
        ("contracts.dollar", &r.contracts.dollar, 20),
        ("runner.address", &r.runner.address, 20),
    ] {
        rule(
            is_hex(text, bytes),
            format!("{name} is not lower-case hex: {text}"),
        );
    }
    rule(
        r.launched_at <= r.as_of.time,
        format!(
            "launchedAt {} is after asOf.time {}",
            r.launched_at, r.as_of.time
        ),
    );

    let unit = r.unit;
    let m = &r.money;
    let (pot, paid_in, arriving) = (
        amount(&m.pot, "money.pot")?,
        amount(&m.paid_in, "money.paidIn")?,
        amount(&m.arriving, "money.arriving")?,
    );
    let (fees_owed, locked, notes_owed, held) = (
        amount(&m.fees_owed, "money.feesOwed")?,
        amount(&m.locked, "money.locked")?,
        amount(&m.notes_owed, "money.notesOwed")?,
        amount(&m.held, "money.held")?,
    );
    let box_ = amount(&r.allowance.box_, "allowance.box")?;
    let box_cap = amount(&r.allowance.box_cap, "allowance.boxCap")?;
    let _ = (paid_in, box_cap);
    let wound = r.wind_down.is_some();

    // The roll-forward from the stored numbers gives the settled ones.
    let l = &r.ledger;
    let stored = Stored {
        last_settle: l.last_settle,
        active_end: r.clock.active_until.unwrap_or(0),
        arrival_end: l.arrival_end.unwrap_or(0),
        rate_ppm: r.allowance.rate_ppm,
        unit,
        pot: amount(&l.pot, "ledger.pot")?,
        box_: amount(&l.box_, "ledger.box")?,
        arriving: amount(&l.arriving, "ledger.arriving")?,
        active_seconds: u128::from(l.active_seconds),
    };
    rule(
        (stored.arriving == 0) == l.arrival_end.is_none(),
        "ledger.arrivalEnd must be none exactly when ledger.arriving is zero".into(),
    );
    let settled = roll_forward(r.as_of.time, &stored)?;
    for (name, got, want) in [
        ("money.pot", pot, settled.pot),
        ("allowance.box", box_, settled.box_),
        ("money.arriving", arriving, settled.arriving),
        (
            "clock.activeSeconds",
            u128::from(r.clock.active_seconds),
            settled.active_seconds,
        ),
    ] {
        rule(
            got == want,
            format!("{name} is {got} but the stored numbers worked forward give {want}"),
        );
    }
    rule(
        (arriving == 0) == m.arrival_end.is_none(),
        "money.arrivalEnd must be none exactly when money.arriving is zero".into(),
    );
    if arriving != 0 {
        rule(
            m.arrival_end.is_some_and(|e| e > r.as_of.time),
            "money.arrivalEnd is not after asOf.time while money is arriving".into(),
        );
    }

    // What the Treasury holds covers what it owes (a gift nobody can claim
    // makes it more, never less).
    let owed = pot + box_ + arriving + fees_owed + locked + notes_owed;
    rule(
        held >= owed,
        format!("the Treasury holds {held} but owes {owed}"),
    );

    // Totals: every dollar that came in is somewhere or went out.
    let t = &r.totals;
    let (joined, fees, tookout, drawn, outside) = (
        amount(&t.joined, "totals.joined")?,
        amount(&t.fees, "totals.fees")?,
        amount(&t.took_out, "totals.tookOut")?,
        amount(&t.drawn, "totals.drawn")?,
        amount(&t.outside, "totals.outside")?,
    );
    let (inflow, outflow) = (
        joined.checked_add(outside),
        [
            fees, tookout, drawn, pot, box_, arriving, locked, notes_owed,
        ]
        .iter()
        .try_fold(0u128, |a, b| a.checked_add(*b)),
    );
    rule(
        inflow.is_some() && inflow == outflow,
        format!("joined + outside is {inflow:?} but fees + took out + drawn + pot + box + arriving + locked + owed is {outflow:?}"),
    );

    // Team Shares.
    let (counted, in_hands, in_vester, promised, ungranted) = (
        amount(&r.shares.team_counted, "shares.teamCounted")?,
        amount(&r.team.in_hands, "team.inHands")?,
        amount(&r.team.in_vester, "team.inVester")?,
        amount(&r.team.promised, "team.promised")?,
        amount(&r.team.ungranted, "team.ungranted")?,
    );
    rule(
        in_hands.checked_add(in_vester) == Some(counted),
        format!("team.inHands {in_hands} + team.inVester {in_vester} is not shares.teamCounted {counted}"),
    );
    rule(
        in_vester.checked_sub(promised) == Some(ungranted),
        format!("team.ungranted {ungranted} is not team.inVester {in_vester} less team.promised {promised}"),
    );

    // Holders (a cut list says nothing about the rest).
    let backers = amount(&r.shares.backers, "shares.backers")?;
    let (mut sum_shares, mut sum_team) = (0u128, 0u128);
    let (mut with_shares, mut with_team) = (0u64, 0u64);
    for h in &r.holders {
        rule(
            is_hex(&h.account, 20),
            format!("holder {} is not lower-case hex", h.account),
        );
        let (s, tm) = (
            amount(&h.shares, "holder.shares")?,
            amount(&h.team_shares, "holder.teamShares")?,
        );
        sum_shares += s;
        sum_team += tm;
        with_shares += u64::from(s != 0);
        with_team += u64::from(tm != 0);
    }
    if !r.truncated {
        rule(
            sum_shares <= backers,
            format!("holders hold {sum_shares} Shares of {backers}"),
        );
        rule(
            sum_team <= in_hands,
            format!("holders hold {sum_team} Team Shares of {in_hands}"),
        );
        rule(
            with_shares == r.holder_count && with_team == r.team_holder_count,
            "holderCount or teamHolderCount does not match the list".into(),
        );
        // Grants: what is promised is what the unfinished grants still owe.
        let mut owed_by_grants = 0u128;
        let mut announced = 0u128;
        for g in &r.team.grants {
            let (keeps, claimed) = (
                amount(&g.keeps, "grant.keeps")?,
                amount(&g.claimed, "grant.claimed")?,
            );
            let burn = g
                .forfeit
                .as_ref()
                .map(|f| amount(&f.amount, "forfeit.amount"))
                .transpose()?
                .unwrap_or(0);
            owed_by_grants += keeps.saturating_sub(claimed) + burn;
            announced += burn;
        }
        rule(
            owed_by_grants == promised,
            format!("the grants owe {owed_by_grants} but team.promised is {promised}"),
        );
        rule(
            announced == amount(&r.shares.announced_burn, "shares.announcedBurn")?,
            "the forfeits announced do not add up to shares.announcedBurn".into(),
        );
    }
    for g in &r.team.grants {
        let (vested, claimed, claimable) = (
            amount(&g.vested, "grant.vested")?,
            amount(&g.claimed, "grant.claimed")?,
            amount(&g.claimable, "grant.claimable")?,
        );
        rule(
            vested.checked_sub(claimed) == Some(claimable),
            format!(
                "grant {}: claimable {claimable} is not vested {vested} less claimed {claimed}",
                g.id
            ),
        );
        rule(
            (g.state == GrantStateRec::Announced) == g.forfeit.is_some(),
            format!(
                "grant {}: a forfeit is set exactly while it is announced",
                g.id
            ),
        );
        rule(
            g.cliff.is_none() || (g.kind == GrantKind::Normal && g.state == GrantStateRec::Live),
            format!("grant {}: only a live normal grant has a cliff", g.id),
        );
    }
    rule(
        r.team.grants.len() as u64 <= r.team.grant_count,
        "more grants are listed than were ever made".into(),
    );

    // The quiet scale.
    let q = &r.quiet;
    let pend = r.allowance.pending;
    if let Some(p) = pend {
        rule(
            p.applicable_at == p.proposed_at.saturating_add(unit),
            "allowance.pending.applicableAt is not proposedAt + unit".into(),
        );
    }
    if wound {
        rule(
            q.state == QuietState::WoundDown
                && q.quiet_from.is_none()
                && q.dormant_from.is_none()
                && q.windable_from.is_none()
                && q.next.is_none()
                && r.clock.active_until.is_none()
                && r.door.shuts_at.is_none()
                && !r.door.open_now
                && box_ == 0,
            "a wound-down project must show the wound-down shape".into(),
        );
    } else {
        let (Some(qf), Some(df), Some(wf)) = (q.quiet_from, q.dormant_from, q.windable_from) else {
            bail!(
                "quiet.quietFrom, dormantFrom and windableFrom are all needed before a wind-down"
            );
        };
        let last = r.clock.last_check_in;
        rule(
            Some(qf) == r.clock.active_until && Some(qf) == r.door.shuts_at,
            "quiet.quietFrom, clock.activeUntil and door.shutsAt must be one time".into(),
        );
        rule(
            qf == last + r.limits.check_in_window_units * unit
                && df == last + DORMANT_UNITS * unit
                && wf == last + r.limits.wind_down_units * unit,
            "quiet times are not the last check-in plus the window, 13 units and the wind-down length".into(),
        );
        let want = quiet_state(r.as_of.time, qf, df, wf);
        rule(
            q.state == want,
            format!("quiet.state is {:?} but the times give {want:?}", q.state),
        );
        rule(
            q.next == next_state(want, qf, df, wf),
            "quiet.next does not follow quiet.state".into(),
        );
        rule(
            r.door.open_now == (r.door.switch_on && r.as_of.time < qf),
            "door.openNow is not (switch on and before the door shuts)".into(),
        );
        rule(
            box_cap == settled.box_cap(r.allowance.rate_ppm).unwrap_or(u128::MAX),
            format!("allowance.boxCap {box_cap} is not what the settled pot and box allow"),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mul_div_rounds_down_and_does_not_overflow_in_the_middle() {
        assert_eq!(mul_div(7, 3, 2), Some(10));
        assert_eq!(mul_div(0, u128::MAX, 5), Some(0));
        assert_eq!(mul_div(u128::MAX, u128::MAX, u128::MAX), Some(u128::MAX));
        // Products above 2^128 that divide back into range (values from exact big-integer arithmetic).
        let a = 1_000_000_000_000_000_000_000_000_000_000u128; // 1e30
        assert_eq!(mul_div(a, 2_400_000_000, 1_000_000 * 86_400), Some(a / 36));
        assert_eq!(mul_div(5, 5, 0), None);
        // The result itself too large for 128 bits.
        assert_eq!(mul_div(u128::MAX, 2, 1), None);
        assert_eq!(
            mul_div(
                123_456_789_012_345_678_901_234_567_890,
                987_654_321_098_765_432_109,
                555_555_555_555_555_555_555_555
            ),
            Some(219_478_736_046_639_231_406_938_491)
        );
        assert_eq!(
            mul_div(u128::MAX / 3, u128::MAX / 5, u128::MAX / 7),
            Some(158_798_437_896_437_949_616_241_483_468_158_498_680)
        );
        assert_eq!(
            mul_div(1u128 << 100, 1u128 << 100, 1u128 << 90),
            Some(1_298_074_214_633_706_907_132_624_082_305_024)
        );
    }

    #[test]
    fn the_roll_forward_moves_the_allowance_and_releases_arriving_money() {
        // One active day at 1000 ppm on 1,000 dollars: a thousandth goes to the box.
        let s = Stored {
            last_settle: 1_000,
            active_end: 1_000_000,
            arrival_end: 0,
            rate_ppm: 1000,
            unit: 604_800,
            pot: 1_000_000_000,
            box_: 0,
            arriving: 0,
            active_seconds: 5,
        };
        let day = 604_800 / 7;
        let got = roll_forward(1_000 + day, &s).expect("settles");
        assert_eq!(got.box_, 1_000_000);
        assert_eq!(got.pot, 999_000_000);
        assert_eq!(got.active_seconds, 5 + u128::from(day));
        // The box never passes seven days of accrual.
        let capped = roll_forward(
            1_000 + 3 * day,
            &Stored {
                box_: 7_000_000,
                pot: 993_000_000,
                ..s
            },
        )
        .expect("settles");
        assert_eq!(capped.box_, 7_000_000);
        assert_eq!(capped.pot, 993_000_000);
        // Half of the arriving money has arrived half way.
        let arr = roll_forward(
            2_000,
            &Stored {
                arriving: 100,
                arrival_end: 3_000,
                last_settle: 1_000,
                active_end: 0,
                ..s
            },
        )
        .expect("settles");
        assert_eq!((arr.arriving, arr.pot), (50, 1_000_000_050));
        assert_eq!(arr.active_seconds, 5, "no active time past the end");
    }
}
