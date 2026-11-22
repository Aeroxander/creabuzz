//! Who may sign a project's update records (kind 47003).
//!
//! A project's public record is a stream of kind 47003 events that name the
//! project with one `a` tag (`37001:<founder>:<d>`). Several families of
//! record share the kind and are told apart by their tags. Before this module
//! the relay stored any of them from anyone and left "does this signer count"
//! to readers, so a stranger could fill a project's bounded reads with records
//! no reader would ever show, and a later change to the team changed what old
//! records meant.
//!
//! Now the signer is checked once, when the record is written, against the
//! project record (kind 37001) as it stands at that moment:
//!
//! | tags                                              | who may sign                         |
//! |---------------------------------------------------|--------------------------------------|
//! | `goal`, `promise`, `promise-mark`                 | the founder                          |
//! | `update-part`, `update-kind`, `help-needed`       | the founder or a team member         |
//! | `help-reply`, `help-found`                        | the founder or a team member         |
//! | `help-offer`                                      | anyone (the project must exist)      |
//! | `join-ask`                                        | anyone signed in but the team; a few |
//! |                                                   | a day, and a few for one project;    |
//! |                                                   | small, and its `p` tag is the        |
//! |                                                   | project's founder                    |
//! | `join-decline`                                    | the founder (turns an ask away)      |
//! | `task-part` = task, send-back, grant, cancel      | the founder or a team member         |
//! | `task-part` = confirm                             | founder or team, never the helper;   |
//! |                                                   | a founder working alone may check    |
//! |                                                   | their own work (see below)           |
//! | `task-part` = accept, evidence, more-time, give-up| the task's helper: the one it names, |
//! |                                                   | or for a task open to anyone, its    |
//! |                                                   | taker (see "Tasks open to anyone")   |
//! |   (accept may carry `task-pay-to`)                | the same: the wallet it names is the |
//! |                                                   | helper's own (see "Plans on the      |
//! |                                                   | network")                            |
//! | `task-part` = take                                | anyone signed in but the team, on a  |
//! |                                                   | task open to anyone that nobody has  |
//! |                                                   | taken; a few a day, and small        |
//! | `room-mute`                                       | the founder or a team member; never  |
//! |                                                   | of the founder, an operator or self  |
//! | `season-entry`, `season-leave`                    | the founder or a team member (see    |
//! |                                                   | `season_rules`)                      |
//! | `season-remove`                                   | an operator of the server only       |
//! | none of the above, body names on-chain work       | anyone, as before (no lookup)        |
//! | none of the above (a plain update, anything else) | the founder or a team member         |
//!
//! The founder is the author of the project record; the team is the founder
//! plus every `["team", <pubkey>, <role>]` tag on it (the same field the web
//! app reads). A record that carries tags from several families must satisfy
//! every one of them.
//!
//! A record with none of the tags above is the team's unless it is one of the
//! records people outside the team write about work that lives on the chain:
//! submitted evidence, a reviewer's reason, an agreement's words, a proposed
//! work area, the answers given before a vote. Those say so in their JSON body
//! (see [`OPEN_WORK_KEYS`]) and are checked by their readers against the chain,
//! not against the team. Everything else that names a project (an old-style
//! plain update, a team answer, a check note, a tag this module has never
//! heard of) is stored only from the founder or the team.
//!
//! # Reported numbers on a hand-in
//!
//! A helper's `evidence` step may carry `task-result`, `task-run-log` and `task-run-record` tags: numbers the helper
//! reports, the fingerprint of a log, and the id of a run record. They are bounded (`buzz_core::task_result`: at most
//! ten results, plain numbers, short words) and are refused on any other step. Nothing about them says the numbers are
//! true; readers show them as reported by the helper.
//!
//! # Agent accounts
//!
//! An account the server has on record as an agent (someone runs it, and both
//! keys signed to say so: see `agent_label`) has limited powers here, even when
//! it is on the team or is the founder: it may not confirm a task's work, grant
//! more time, or sign goals, promises and promise marks. Those need a person.
//! Everything else it may do exactly as any other account in its place. An
//! account with no such record is not affected.
//!
//! Authority follows the signing key. An agent is on a team only when its own
//! key is listed there; the relay's agent-owner link (`is_agent_owner`) lets a
//! person manage their agent's records, it does not lend the agent the
//! person's place on a team. The link is used once, to refuse: nobody confirms
//! work done by an agent they run, or by the person who runs them.
//!
//! # A founder working alone
//!
//! The one exception to "nobody confirms their own work" is a project with
//! nobody else to do it. The founder may confirm a task whose helper is the
//! founder, or an agent the founder runs, while the project record lists no
//! other person: every other team member is either that helper or an account
//! the server has on record as an agent (an agent can never confirm, so a team
//! of the founder and agents is still one person). The moment the record lists
//! another person the refusal is back, whether or not that person ever checks
//! anything. It is the founder's exception alone: a team member who is not the
//! founder never confirms their own work, and an agent account never confirms
//! at all. Readers show such a confirmation as the founder's own check, never
//! as work accepted by someone else.
//!
//! # Tasks open to anyone
//!
//! A task that names no `task-helper` is open to anyone, and must say what it pays in whole dollars (`task-usd`,
//! 1 to 100,000). Someone outside the team takes it with a `take` step, which may name the address the money goes to
//! (`task-pay-to`, under the taker's own signature). The task's helper is then its taker: the first `take` stored for
//! it, by `created_at` and then id, whose signer has not given the task up. A second take is refused while one is live,
//! and someone who gave a task up cannot take it again. A task the team cancelled cannot be taken. The team's
//! confirmation may carry the payment's transaction (`task-paid`); the money moves from the runner's own wallet in the
//! app, never from the server or an agent. A payment the team names is believed only when the network shows it (see
//! `task_chain`: a draw from the project's allowance box to the wallet the worker named, for what the task pays, not
//! already named for another task).
//!
//! An account on record as a manager agent (its profile says `["agent-role", "manager"]`, see `agent_label`) signs no
//! task step at all: it drafts for the founder and never takes, hands in or confirms work.
//!
//! # Plans on the network
//!
//! A team can announce a task on the network (a "plan"), naming the task record's id as the plan's `what`. When the
//! server's chain reader has read such a plan, the steps that touch its money agree with it (see `task_chain`): a take
//! names the wallet it is paid to (`task-pay-to`, also allowed on the `accept` step of a task that names its helper)
//! and that wallet is the plan's; a confirmation names the transaction that paid the plan; the team's cancel waits
//! until the plan is withdrawn on the network. A task with no plan, or a server with no chain reader, is judged as
//! before. The relay never checks money: the app reads the chain before it offers a payment.
//!
//! Records stored before this check existed are not looked at again.

use std::collections::HashSet;
use std::sync::Arc;

use buzz_core::kind::{KIND_LAUNCH_RECORD, KIND_LAUNCH_UPDATE};
use buzz_core::tenant::TenantContext;
use nostr::Event;

use super::ingest::IngestError;
use crate::state::AppState;

/// Said when a goal or a promise is signed by anyone but the founder.
pub(crate) const NOT_FOUNDER: &str = "restricted: only this project's founder can post this";
/// Said when a team record is signed by someone who is not on the team.
pub(crate) const NOT_TEAM: &str = "restricted: only this project's team can post this";
/// Said when a helper's step is signed by anyone but the task's helper.
pub(crate) const NOT_HELPER: &str = "restricted: only the helper this task names can post this";
/// Said when the helper (or whoever runs or is run by the helper) confirms the task's work.
pub(crate) const OWN_WORK: &str =
    "restricted: a task's work must be confirmed by someone other than its helper";
/// Said when an agent account signs something that needs a person.
pub(crate) const AGENT_LIMIT: &str =
    "restricted: an agent account cannot check work, grant more time, or sign goals and promises; a person on the team must";
/// Said when the `a` tag names a project record the server does not hold.
pub(crate) const NO_PROJECT: &str =
    "invalid: this record names a project that is not on this server";
/// Said when a step names a task record the server does not hold.
pub(crate) const NO_TASK: &str = "invalid: this step names a task that is not on this server";
/// Said when a step names a task that belongs to a different project than its `a` tag.
pub(crate) const OTHER_PROJECT: &str = "invalid: this step names a task from another project";

/// Said when an agent account puts someone who asked to join onto a project's team.
pub(crate) const AGENT_ACCEPT: &str =
    "restricted: an agent account cannot accept someone's ask to join; a person must";
/// Said when someone already on the team asks to join it.
pub(crate) const ON_TEAM: &str = "invalid: you are already on this project's team";
/// Said when an account has asked to join one project too often.
pub(crate) const ASKED_ENOUGH: &str =
    "restricted: you have already asked to join this project; it shows on the founder's Team card";
/// Said when an account asks to join too many projects in a day.
pub(crate) const ASKING_TOO_MUCH: &str =
    "rate-limited: you can ask to join a few projects a day; try again tomorrow";
/// Said when someone on the team takes a task open to anyone.
pub(crate) const TEAM_TAKES: &str =
    "invalid: a task open to anyone is taken by someone outside the team; the team names a helper instead";
/// Said when a take names a task that names its helper.
pub(crate) const NOT_OPEN: &str =
    "invalid: this task names its helper; only a task open to anyone can be taken";
/// Said when a take names a task someone else has taken, that was cancelled, or that the signer gave up before.
pub(crate) const TAKEN: &str =
    "restricted: this task is taken, stopped, or was given up by you before; it can't be taken now";
/// Said when an account takes too many tasks in a day.
pub(crate) const TAKING_TOO_MUCH: &str =
    "rate-limited: you can take a few tasks a day; try again tomorrow";
/// Said when a manager agent signs a task step.
pub(crate) const MANAGER_LIMIT: &str =
    "restricted: a manager agent drafts for the founder; it can't post, take, hand in or check tasks";
/// The most a task open to anyone may pay, in whole dollars.
pub(crate) const TASK_USD_MAX: u64 = 100_000;
/// How many tasks one account may take in a day.
const TAKES_PER_DAY: i64 = 20;

/// The `l` label an ask to join carries, so a project's asks are read apart from its other records.
pub(crate) const JOIN_LABEL: &str = "creaton-join";
/// The most JSON content an ask to join may carry, in bytes. The web app sends `{"title":"Asked to join","body":""}`
/// and never reads more, so nothing an ask holds is worth more than this to anyone, and a stranger's ask is small.
pub(crate) const JOIN_CONTENT_MAX: usize = 1024;
/// The most tags an ask to join may carry (the web app sends seven; a script may add a note or two).
const JOIN_TAGS_MAX: usize = 12;
/// The most bytes all of an ask's tag fields may hold together (the web app's are about 400).
const JOIN_TAG_BYTES_MAX: usize = 1536;
/// How many times one account may ask to join one project (a person removed from a team may ask again).
const ASKS_PER_PROJECT: i64 = 3;
/// How many projects one account may ask to join in a day.
const ASKS_PER_DAY: i64 = 20;

/// Which step of a task a record is (`task-part`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TaskPart {
    /// The team makes the task.
    Task,
    /// The team returns handed-in work.
    SendBack,
    /// A team member who is not the helper accepts handed-in work.
    Confirm,
    /// The team answers a request for more time.
    Grant,
    /// The team stops the task.
    Cancel,
    /// The helper agrees to the task.
    Accept,
    /// The helper hands work in.
    Evidence,
    /// The helper asks for more time.
    MoreTime,
    /// The helper stops.
    GiveUp,
    /// Someone outside the team takes a task open to anyone.
    Take,
}

impl TaskPart {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "task" => Self::Task,
            "send-back" => Self::SendBack,
            "confirm" => Self::Confirm,
            "grant" => Self::Grant,
            "cancel" => Self::Cancel,
            "accept" => Self::Accept,
            "evidence" => Self::Evidence,
            "more-time" => Self::MoreTime,
            "give-up" => Self::GiveUp,
            "take" => Self::Take,
            _ => return None,
        })
    }

    /// Whether the step needs a person: an agent account never signs it.
    fn needs_a_person(self) -> bool {
        matches!(self, Self::Confirm | Self::Grant)
    }

    /// Whether the step is the helper's to sign (the rest are the team's).
    fn is_helpers(self) -> bool {
        matches!(
            self,
            Self::Accept | Self::Evidence | Self::MoreTime | Self::GiveUp
        )
    }
}

/// What a record's tags require of its signer.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Requirement {
    /// A goal or a promise: the founder alone.
    pub(crate) founder: bool,
    /// An update, a reply to an offer, "Help found": the founder or the team.
    pub(crate) team: bool,
    /// A task record: its step, and for every step but the first the task it names.
    pub(crate) step: Option<(TaskPart, Option<[u8; 32]>)>,
    /// An ask to join the project (`join-ask`): any signed-in account but the team may sign it.
    pub(crate) join: bool,
    /// A team's stop on a person writing in the project's room (`room-mute`).
    pub(crate) room_mute: Option<RoomMute>,
    /// A season family record (`season-entry`, `season-leave`, `season-remove`).
    pub(crate) season: Option<super::season_rules::Step>,
}

/// What a `room-mute` record names: the person it stops (hex pubkey) and when it ends (unix seconds).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RoomMute {
    /// The person it stops.
    pub(crate) person: String,
    /// When it ends.
    pub(crate) until: u64,
    /// The wallets it names: the mute follows each of them to every account that has linked it.
    pub(crate) wallets: Vec<super::wallet_binding::Wallet>,
}

/// The longest a team may stop a person writing in one record, in seconds (30 days).
pub(crate) const ROOM_MUTE_MAX_SECS: u64 = 30 * 86_400;
/// The most wallets a `room-mute` record lists.
pub(crate) const ROOM_MUTE_WALLETS_MAX: usize = 8;
/// Said when a `room-mute` record is not well formed or runs longer than 30 days.
pub(crate) const BAD_ROOM_MUTE: &str =
    "invalid: a room mute names one person, up to 8 wallets and an end within 30 days";
/// Said when a room mute lists a wallet the person it stops has not linked.
pub(crate) const MUTE_WALLET_NOT_THEIRS: &str =
    "invalid: a room mute may list only wallets the person has linked to their own account";
/// Said when a team tries to stop the founder, an operator or itself.
pub(crate) const MUTE_PROTECTED: &str =
    "restricted: the founder and the people who run this server cannot be stopped from writing";

impl Requirement {
    /// Whether the record is one an agent account never signs: a goal, a
    /// promise or a promise mark, a confirmation, or a grant of more time.
    pub(crate) fn needs_a_person(&self) -> bool {
        self.founder || self.step.is_some_and(|(part, _)| part.needs_a_person())
    }
}

/// The keys in a record's JSON body that mark it as a record about work that
/// lives on the chain, which people outside the team write: submitted evidence
/// (`claim`), a reviewer's reason (`review`), an agreement's words and a
/// request for corrections (`agreement`, `agreementCorrections`), a proposed
/// work area (`workArea`) and the answers given before a vote (`challenge`).
pub(crate) const OPEN_WORK_KEYS: [&str; 6] = [
    "claim",
    "review",
    "agreement",
    "agreementCorrections",
    "workArea",
    "challenge",
];

/// Whether a record with none of the known tags is a record about on-chain
/// work: its body is a JSON object that carries one of [`OPEN_WORK_KEYS`] as an
/// object. A plain update (`title`, `body`, `links`) is not.
fn is_open_work_record(event: &Event) -> bool {
    serde_json::from_str::<serde_json::Value>(event.content.as_str())
        .ok()
        .and_then(|body| {
            body.as_object().map(|body| {
                OPEN_WORK_KEYS
                    .iter()
                    .any(|key| body.get(*key).is_some_and(serde_json::Value::is_object))
            })
        })
        .unwrap_or(false)
}

fn id_bytes(value: &str) -> Option<[u8; 32]> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return None;
    }
    hex::decode(value).ok()?.try_into().ok()
}

/// Read what a kind 47003 record's tags require.
///
/// `Ok(None)` means the record carries none of the tags this module knows and
/// its body marks it as a record about on-chain work: it is stored from anyone,
/// as before. A record with none of those tags and no such body is the team's.
/// `Err` is a record that claims a family but
/// cannot be read as one (two steps at once, a step that names no task): no
/// reader would show it, so it is refused.
pub(crate) fn classify(event: &Event) -> Result<Option<Requirement>, String> {
    let mut founder = false;
    let mut team = false;
    let mut known = false;
    let mut help_marks: Vec<(&str, &str)> = Vec::new();
    let mut parts: Vec<&str> = Vec::new();
    let mut task_id: Option<&str> = None;
    let mut helper: Option<&str> = None;
    let mut joins: Vec<&str> = Vec::new();
    let mut declines: Vec<&str> = Vec::new();
    let mut labelled_join = false;
    let mut named: Vec<&str> = Vec::new();
    let mut project: Option<&str> = None;
    let mut money: Vec<(&str, &str)> = Vec::new();
    let mut room_mutes: Vec<&str> = Vec::new();
    let mut mute_wallets: Vec<&str> = Vec::new();
    let mut expirations: Vec<&str> = Vec::new();
    for tag in event.tags.iter() {
        let fields = tag.as_slice();
        let Some(name) = fields.first().map(|s| s.as_str()) else {
            continue;
        };
        let value = fields.get(1).map(|s| s.as_str()).unwrap_or("");
        match name {
            "goal" | "promise" | "promise-mark" => founder = true,
            "update-part" | "update-kind" | "help-needed" => team = true,
            "help-offer" | "help-reply" | "help-found" => help_marks.push((name, value)),
            "task-part" => parts.push(value),
            "join-ask" => joins.push(value),
            "join-decline" => declines.push(value),
            "p" => named.push(value),
            "a" if project.is_none() => project = Some(value),
            "l" if value == JOIN_LABEL => labelled_join = true,
            // The first of each, as the readers take it.
            "task" if task_id.is_none() => task_id = Some(value),
            "task-helper" if helper.is_none() => helper = Some(value),
            "task-usd" | "task-pay-to" | "task-paid" => money.push((name, value)),
            "room-mute" => room_mutes.push(value),
            "room-mute-wallet" => mute_wallets.push(value),
            "expiration" => expirations.push(value),
            _ => {}
        }
    }

    match help_marks.as_slice() {
        [] => {}
        [(name, target)] => {
            if id_bytes(target).is_none() {
                return Err(format!(
                    "`{name}` tag must hold the id of the record it answers"
                ));
            }
            known = true;
            if *name != "help-offer" {
                team = true;
            }
        }
        _ => {
            return Err(
                "a record can carry only one of `help-offer`, `help-reply` and `help-found`".into(),
            )
        }
    }

    let step = match parts.as_slice() {
        [] => None,
        [part] => {
            let Some(part) = TaskPart::parse(part) else {
                return Err(format!("unknown task step {part:?}"));
            };
            if part == TaskPart::Task {
                match helper {
                    Some(helper) if id_bytes(helper).is_none() => {
                        return Err("a task must name its helper in a `task-helper` tag".into());
                    }
                    // Open to anyone: it says what it pays.
                    None if !money.iter().any(|(name, _)| *name == "task-usd") => {
                        return Err(
                            "a task must name its helper in a `task-helper` tag, or say what it pays in `task-usd` \
                             to be open to anyone"
                                .into(),
                        );
                    }
                    _ => {}
                }
                Some((part, None))
            } else {
                let Some(id) = task_id.and_then(id_bytes) else {
                    return Err("a task step must name its task in a `task` tag".into());
                };
                Some((part, Some(id)))
            }
        }
        _ => return Err("a record can carry only one `task-part` tag".into()),
    };

    check_hand_in_extras(event, step.map(|(part, _)| part))?;
    check_money_tags(&money, step.map(|(part, _)| part))?;
    if step.is_some_and(|(part, _)| part == TaskPart::Take) {
        check_record_is_small(event, "a take")?;
    }

    if !joins.is_empty() {
        let [invite] = joins.as_slice() else {
            return Err("a record can carry only one `join-ask` tag".into());
        };
        let name_ok = !invite.is_empty()
            && invite.len() <= 32
            && invite
                .bytes()
                .all(|b| b.is_ascii_digit() || b.is_ascii_lowercase());
        if !name_ok {
            return Err(
                "`join-ask` tag must hold a short name of lowercase letters and digits".into(),
            );
        }
        if !labelled_join {
            return Err(format!(
                "an ask to join must carry the `l` label {JOIN_LABEL:?}"
            ));
        }
        if founder || team || known || step.is_some() || !declines.is_empty() {
            return Err("an ask to join cannot also be anything else".into());
        }
        check_ask_is_small(event)?;
        // The ask names the project's founder and nobody else, so the founder's own reads (`#p`) find it and a
        // stranger cannot aim one at somebody else's inbox.
        let project_founder = project
            .and_then(|coordinate| coordinate.split(':').nth(1))
            .unwrap_or("");
        if named != [project_founder] {
            return Err(
                "an ask to join must name the project's founder, and only the founder, in its `p` tag".into(),
            );
        }
        return Ok(Some(Requirement {
            founder: false,
            team: false,
            step: None,
            join: true,
            room_mute: None,
            season: None,
        }));
    }

    if !declines.is_empty() {
        let [asker] = declines.as_slice() else {
            return Err("a record can carry only one `join-decline` tag".into());
        };
        if id_bytes(asker).is_none() {
            return Err("`join-decline` tag must hold the key of the person turned away".into());
        }
        // Turning someone away is the founder's, as accepting is: the founder alone saves the project record.
        founder = true;
        known = true;
    }

    // The team's stop on a person writing in the room, and the season families: each is a record of its own.
    let season = super::season_rules::classify_step(event)?;
    let room_mute = if room_mutes.is_empty() && mute_wallets.is_empty() {
        None
    } else {
        Some(read_room_mute(&room_mutes, &mute_wallets, &expirations)?)
    };
    if season.is_some() || room_mute.is_some() {
        if founder || team || known || step.is_some() || !declines.is_empty() {
            return Err("a room mute or a season record cannot also be anything else".into());
        }
        if season.is_some() && room_mute.is_some() {
            return Err("a record cannot be both a room mute and a season record".into());
        }
        if event.content.len() > JOIN_CONTENT_MAX || event.tags.len() > SEASON_TAGS_MAX {
            return Err(format!(
                "this record carries at most {JOIN_CONTENT_MAX} bytes of content and {SEASON_TAGS_MAX} tags"
            ));
        }
        // A removal is the operator's, judged apart from the team; the rest are the team's.
        let removal = season.is_some_and(|step| step.family == super::season_rules::Family::Remove);
        return Ok(Some(Requirement {
            founder: false,
            team: !removal,
            step: None,
            join: false,
            room_mute,
            season,
        }));
    }

    if !(founder || team || known || step.is_some()) {
        if is_open_work_record(event) {
            return Ok(None);
        }
        // Nothing says what this is: only the project's own people may put it on the project's record.
        team = true;
    }
    Ok(Some(Requirement {
        founder,
        team,
        step,
        join: false,
        room_mute: None,
        season: None,
    }))
}

/// The most tags a `room-mute` or season record carries (its `a`, a topic, the family tag, up to 8 wallets, an end).
const SEASON_TAGS_MAX: usize = 16;

/// Read the tags of a `room-mute` record: exactly one person (64 hex digits), at most 8 wallets (lower-case `0x` and
/// 40 hex digits, none twice) and exactly one end (whole seconds). The end's bound against the clock is judged when the
/// record is written ([`enforce_launch_update_authority`]), not here.
fn read_room_mute(people: &[&str], wallets: &[&str], ends: &[&str]) -> Result<RoomMute, String> {
    let bad = || BAD_ROOM_MUTE.trim_start_matches("invalid: ").to_owned();
    let ([person], [end]) = (people, ends) else {
        return Err(bad());
    };
    if id_bytes(person).is_none() || wallets.len() > ROOM_MUTE_WALLETS_MAX {
        return Err(bad());
    }
    let mut seen: Vec<&str> = Vec::new();
    let mut named = Vec::with_capacity(wallets.len());
    for wallet in wallets {
        let Some(parsed) = super::wallet_binding::parse_wallet(wallet) else {
            return Err(bad());
        };
        if seen.contains(wallet) {
            return Err(bad());
        }
        seen.push(wallet);
        named.push(parsed);
    }
    let until = end
        .parse::<u64>()
        .ok()
        .filter(|until| until.to_string() == *end)
        .ok_or_else(bad)?;
    Ok(RoomMute {
        person: (*person).to_owned(),
        until,
        wallets: named,
    })
}

/// Hold an ask to join to a small size: its JSON content, its tag count and the bytes of its tag fields. A stranger can
/// sign one for nothing, and the founder's page reads up to 200 of them every few seconds, so one ask must never be
/// worth more than a few hundred bytes.
fn check_ask_is_small(event: &Event) -> Result<(), String> {
    check_record_is_small(event, "an ask to join")
}

/// What a task's money tags may hold, and on which step: `task-usd` (whole dollars, 1 to [`TASK_USD_MAX`]) on the task,
/// `task-pay-to` (an address, `0x` and 40 hex digits) on a take or on the accept step of a task that names its helper
/// (the wallet the worker names under their own signature), `task-paid` (a transaction, `0x` and 64 hex digits) on a
/// confirmation. One of each at most, and none anywhere else.
fn check_money_tags(money: &[(&str, &str)], part: Option<TaskPart>) -> Result<(), String> {
    let hex_of = |value: &str, digits: usize| {
        value.len() == digits + 2
            && value.starts_with("0x")
            && value[2..].bytes().all(|b| b.is_ascii_hexdigit())
    };
    let mut seen: Vec<&str> = Vec::new();
    for (name, value) in money {
        if seen.contains(name) {
            return Err(format!("a record can carry only one `{name}` tag"));
        }
        seen.push(name);
        let (steps, ok): (&[TaskPart], bool) = match *name {
            "task-usd" => (
                &[TaskPart::Task],
                !value.starts_with('0')
                    && value.bytes().all(|b| b.is_ascii_digit())
                    && value
                        .parse::<u64>()
                        .is_ok_and(|usd| (1..=TASK_USD_MAX).contains(&usd)),
            ),
            "task-pay-to" => (&[TaskPart::Take, TaskPart::Accept], hex_of(value, 40)),
            _ => (&[TaskPart::Confirm], hex_of(value, 64)),
        };
        if !part.is_some_and(|part| steps.contains(&part)) {
            return Err(format!("`{name}` belongs on another step of a task"));
        }
        if !ok {
            return Err(match *name {
                "task-usd" => format!("`task-usd` must be whole dollars from 1 to {TASK_USD_MAX}"),
                "task-pay-to" => "`task-pay-to` must be an address: 0x and 40 hex digits".into(),
                _ => "`task-paid` must be a transaction: 0x and 64 hex digits".into(),
            });
        }
    }
    Ok(())
}

/// What a task record offers, in whole dollars, when it is open to anyone: it names no helper and says what it pays.
fn open_task_usd(event: &Event) -> Option<u64> {
    let first = |name: &str| {
        event.tags.iter().find_map(|tag| {
            let fields = tag.as_slice();
            (fields.first().map(String::as_str) == Some(name))
                .then(|| fields.get(1).cloned())
                .flatten()
        })
    };
    if first("task-helper").is_some() {
        return None;
    }
    first("task-usd").and_then(|usd| usd.parse().ok())
}

/// Hold a record a stranger signs for nothing (an ask to join, a take) to a small size.
fn check_record_is_small(event: &Event, what: &str) -> Result<(), String> {
    if event.content.len() > JOIN_CONTENT_MAX {
        return Err(format!(
            "{what} carries at most {JOIN_CONTENT_MAX} bytes of content"
        ));
    }
    let tags = event.tags.len();
    let bytes: usize = event
        .tags
        .iter()
        .map(|tag| tag.as_slice().iter().map(String::len).sum::<usize>())
        .sum();
    if tags > JOIN_TAGS_MAX || bytes > JOIN_TAG_BYTES_MAX {
        return Err(format!(
            "{what} carries at most {JOIN_TAGS_MAX} tags and {JOIN_TAG_BYTES_MAX} bytes of them"
        ));
    }
    Ok(())
}

/// Hold the reported-result tags of a hand-in to their bounds (`buzz_core::task_result`).
///
/// `task-result`, `task-run-log` and `task-run-record` belong to work handed in and nowhere else: on any other record
/// they are refused, and on a hand-in they must keep to the bounds, so a record can never carry an unbounded pile of
/// numbers. Nothing here says the numbers are true; they are the helper's own report, and readers say so.
fn check_hand_in_extras(event: &Event, part: Option<TaskPart>) -> Result<(), String> {
    let extras: Vec<Vec<String>> = event
        .tags
        .iter()
        .map(|tag| tag.as_slice().to_vec())
        .filter(|fields| buzz_core::task_result::is_hand_in_extra(fields))
        .collect();
    if extras.is_empty() {
        return Ok(());
    }
    if part != Some(TaskPart::Evidence) {
        return Err("results and run records can only be sent with work handed in".into());
    }
    let all: Vec<Vec<String>> = event
        .tags
        .iter()
        .map(|tag| tag.as_slice().to_vec())
        .collect();
    buzz_core::task_result::check_hand_in_tags(&all).map(|_| ())
}

/// A project's founder and team, read from its project record (kind 37001).
#[derive(Debug)]
pub(crate) struct ProjectTeam {
    founder: String,
    members: HashSet<String>,
}

impl ProjectTeam {
    /// The founder is the record's author; the team is every
    /// `["team", <pubkey>, <role>]` tag, as the web app's `parseLaunchRecord` reads it.
    pub(crate) fn from_record(record: &Event) -> Self {
        let members = record
            .tags
            .iter()
            .filter_map(|tag| {
                let fields = tag.as_slice();
                (fields.len() >= 3 && fields[0] == "team").then(|| fields[1].clone())
            })
            .collect();
        Self {
            founder: record.pubkey.to_hex(),
            members,
        }
    }

    pub(crate) fn is_founder(&self, who: &str) -> bool {
        self.founder == who
    }

    pub(crate) fn has(&self, who: &str) -> bool {
        self.is_founder(who) || self.members.contains(who)
    }

    /// The team members who are neither the founder nor `helper`: the only
    /// people who could check the founder's own work in the founder's place.
    pub(crate) fn others<'a>(&'a self, helper: &'a str) -> impl Iterator<Item = &'a String> + 'a {
        self.members
            .iter()
            .filter(move |member| !self.is_founder(member) && member.as_str() != helper)
    }

    /// Whether someone other than the founder and `helper` could confirm work
    /// here: a listed team member the server does not have on record as an
    /// agent account (`agents`).
    fn has_another_person(&self, helper: &str, agents: &HashSet<String>) -> bool {
        self.others(helper).any(|member| !agents.contains(member))
    }
}

/// What a stored task record says: its project and its helper.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct TaskFacts {
    /// The project the task names in its `a` tag.
    pub(crate) coordinate: String,
    /// The helper the task names (`task-helper`); `None` for a task open to anyone.
    pub(crate) helper: Option<String>,
    /// For a task open to anyone, what its stored steps say about who has it (see [`TakeFacts`]).
    pub(crate) takes: TakeFacts,
    /// What the task says it pays, in whole dollars (`task-usd`), when it says.
    pub(crate) usd: Option<u64>,
}

/// What the stored steps of a task open to anyone say, read by the server before a step is decided.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct TakeFacts {
    /// Its taker: the first `take` by `created_at` and then id whose signer has not given the task up.
    pub(crate) taker: Option<String>,
    /// Whether the signer of the record being decided took this task before and gave it up.
    pub(crate) signer_left: bool,
    /// Whether the team cancelled the task.
    pub(crate) cancelled: bool,
}

impl TaskFacts {
    /// Who does the work: the helper the task names, or its taker.
    pub(crate) fn worker(&self) -> Option<&str> {
        self.helper.as_deref().or(self.takes.taker.as_deref())
    }
}

/// The taker of a task open to anyone, from its stored steps: `(signer, created_at, id, step)` for each `take`,
/// `give-up` and `cancel` the server holds for it. The first take by `created_at` and then id whose signer has not
/// given the task up. Every reader (the CLI, the app) takes the same rule.
pub(crate) fn read_takes(steps: &[(String, u64, String, TaskPart)], signer: &str) -> TakeFacts {
    let left: HashSet<&str> = steps
        .iter()
        .filter(|(_, _, _, part)| *part == TaskPart::GiveUp)
        .map(|(who, _, _, _)| who.as_str())
        .collect();
    let mut takes: Vec<&(String, u64, String, TaskPart)> = steps
        .iter()
        .filter(|(who, _, _, part)| *part == TaskPart::Take && !left.contains(who.as_str()))
        .collect();
    takes.sort_by(|a, b| (a.1, &a.2).cmp(&(b.1, &b.2)));
    TakeFacts {
        taker: takes.first().map(|(who, _, _, _)| who.clone()),
        signer_left: left.contains(signer),
        cancelled: steps
            .iter()
            .any(|(_, _, _, part)| *part == TaskPart::Cancel),
    }
}

/// Read a stored event as a task record. `None` when it is not one: another
/// kind, another step, or a record that names neither a helper nor what it pays.
pub(crate) fn task_facts(task: &Event) -> Option<TaskFacts> {
    if u32::from(task.kind.as_u16()) != KIND_LAUNCH_UPDATE {
        return None;
    }
    match classify(task) {
        Ok(Some(Requirement {
            step: Some((TaskPart::Task, None)),
            ..
        })) => {}
        _ => return None,
    }
    let first = |name: &str| {
        task.tags.iter().find_map(|tag| {
            let fields = tag.as_slice();
            (fields.first().map(|s| s.as_str()) == Some(name))
                .then(|| fields.get(1).cloned())
                .flatten()
        })
    };
    Some(TaskFacts {
        coordinate: first("a")?,
        helper: first("task-helper"),
        takes: TakeFacts::default(),
        usd: first("task-usd").and_then(|usd| usd.parse().ok()),
    })
}

/// How a confirmation's signer and the task's helper are tied in the relay's
/// agent-owner records.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HelperLink {
    /// Neither runs the other.
    None,
    /// The signer runs the helper: the helper is the signer's agent.
    SignerRunsHelper,
    /// The helper runs the signer: the signer is the helper's agent.
    HelperRunsSigner,
}

/// What the server knows beyond the project record when a confirmation is
/// decided. Both are empty for every other record.
#[derive(Debug)]
pub(crate) struct ConfirmFacts {
    /// How the signer and the task's helper are tied.
    pub(crate) link: HelperLink,
    /// The team members the server has on record as agent accounts. Only
    /// looked up when the founder confirms their own work; a member missing
    /// from it counts as a person.
    pub(crate) agents: HashSet<String>,
}

impl ConfirmFacts {
    /// Nothing known: no tie, and every team member counts as a person.
    pub(crate) fn none() -> Self {
        Self {
            link: HelperLink::None,
            agents: HashSet::new(),
        }
    }
}

/// The most team members whose accounts are looked up to learn whether a
/// founder is working alone. A longer team is taken to hold another person.
const TEAM_LOOKUPS: usize = 32;

/// Decide whether `signer` may post a record with these requirements on the
/// project `coordinate`.
///
/// `task` is the stored task a step names (`None` when the server does not
/// hold a task record under that id). `confirm` says how the signer and the
/// task's helper are tied in the relay's agent-owner records, and which team
/// members are agent accounts (see [`ConfirmFacts`]).
/// `signer_is_agent` says the server has the signer on record as an agent
/// account; it matters only for records that need a person.
///
/// Who may sign is decided first, exactly as for any account; the agent limit
/// is applied after, so an account with no agent record gets the same answer
/// it always did.
pub(crate) fn decide(
    requirement: &Requirement,
    signer: &str,
    coordinate: &str,
    team: &ProjectTeam,
    task: Option<&TaskFacts>,
    confirm: &ConfirmFacts,
    signer_is_agent: bool,
) -> Result<(), &'static str> {
    decide_by_place(requirement, signer, coordinate, team, task, confirm)?;
    if signer_is_agent && requirement.needs_a_person() {
        return Err(AGENT_LIMIT);
    }
    Ok(())
}

fn decide_by_place(
    requirement: &Requirement,
    signer: &str,
    coordinate: &str,
    team: &ProjectTeam,
    task: Option<&TaskFacts>,
    confirm: &ConfirmFacts,
) -> Result<(), &'static str> {
    if requirement.join {
        // Anyone may ask, the team included only in the sense that they need not: a person already on it is told so.
        return if team.has(signer) {
            Err(ON_TEAM)
        } else {
            Ok(())
        };
    }
    if requirement.founder && !team.is_founder(signer) {
        return Err(NOT_FOUNDER);
    }
    if requirement.team && !team.has(signer) {
        return Err(NOT_TEAM);
    }
    let Some((part, named)) = requirement.step else {
        return Ok(());
    };
    if named.is_none() {
        // The task itself: the team hands work out.
        return if team.has(signer) {
            Ok(())
        } else {
            Err(NOT_TEAM)
        };
    }
    let task = task.ok_or(NO_TASK)?;
    if task.coordinate != coordinate {
        return Err(OTHER_PROJECT);
    }
    if part == TaskPart::Take {
        if team.has(signer) {
            return Err(TEAM_TAKES);
        }
        if task.helper.is_some() {
            return Err(NOT_OPEN);
        }
        let takes = &task.takes;
        return if takes.taker.is_some() || takes.signer_left || takes.cancelled {
            Err(TAKEN)
        } else {
            Ok(())
        };
    }
    if part.is_helpers() {
        return if task.worker() == Some(signer) {
            Ok(())
        } else {
            Err(NOT_HELPER)
        };
    }
    if !team.has(signer) {
        return Err(NOT_TEAM);
    }
    let own_work = task.worker() == Some(signer) || confirm.link != HelperLink::None;
    if part == TaskPart::Confirm && own_work && !founder_alone(signer, team, task, confirm) {
        return Err(OWN_WORK);
    }
    Ok(())
}

/// Whether `signer` is the founder checking their own work with nobody else to
/// check it: the helper is the founder, or an agent the founder runs, and the
/// project record lists no other person. An agent that runs nothing is never
/// the founder's own work, and a founder that is itself run by the helper is
/// an agent account, which the agent limit refuses after this.
fn founder_alone(
    signer: &str,
    team: &ProjectTeam,
    task: &TaskFacts,
    confirm: &ConfirmFacts,
) -> bool {
    let worker = task.worker().unwrap_or("");
    team.is_founder(signer)
        && (worker == signer || confirm.link == HelperLink::SignerRunsHelper)
        && !team.has_another_person(worker, &confirm.agents)
}

pub(crate) fn internal(what: &str, error: impl std::fmt::Display) -> IngestError {
    IngestError::Internal(format!("error: db error {what}: {error}"))
}

/// Refuse a kind 47003 record whose family needs the founder, the team or a
/// task's helper when its signer is not that party.
///
/// Runs after the envelope check, so the record has exactly one well-formed
/// `a` tag. A lookup that fails is a server fault and refuses the write: an
/// outage never lets a record past the check.
///
/// Returns the lock on a season that an entry or a leave takes (see [`super::season_rules::SeasonLock`]): the caller
/// keeps it until the record is stored, so two entries arriving together cannot both pass the season's caps.
pub(crate) async fn enforce_launch_update_authority(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    event: &Event,
) -> Result<Option<super::season_rules::SeasonLock>, IngestError> {
    let Some(requirement) =
        classify(event).map_err(|e| IngestError::Rejected(format!("invalid: {e}")))?
    else {
        return Ok(None);
    };
    let community = tenant.community();
    let coordinate = event
        .tags
        .iter()
        .find_map(|tag| {
            let fields = tag.as_slice();
            (fields.first().map(|s| s.as_str()) == Some("a"))
                .then(|| fields.get(1).cloned())
                .flatten()
        })
        .unwrap_or_default();
    let mut segments = coordinate.splitn(3, ':');
    let (Some(_kind), Some(author), Some(d)) = (segments.next(), segments.next(), segments.next())
    else {
        return Err(IngestError::Rejected(NO_PROJECT.into()));
    };
    let Some(author) = id_bytes(author) else {
        return Err(IngestError::Rejected(NO_PROJECT.into()));
    };

    let record = state
        .db
        .query_events_for_event_write(&buzz_db::EventQuery {
            kinds: Some(vec![KIND_LAUNCH_RECORD as i32]),
            pubkey: Some(author.to_vec()),
            d_tag: Some(d.to_string()),
            global_only: true,
            limit: Some(1),
            ..buzz_db::EventQuery::for_community(community)
        })
        .await
        .map_err(|e| internal("reading the project record", e))?
        .into_iter()
        .next()
        .ok_or_else(|| IngestError::Rejected(NO_PROJECT.into()))?;
    let team = ProjectTeam::from_record(&record.event);

    let signer = event.pubkey.to_hex();
    // A manager agent drafts for the founder and signs no task step, whatever its place on the team.
    if requirement.step.is_some()
        && super::task_takes::is_manager_agent(state, community, &event.pubkey.to_bytes()).await?
    {
        return Err(IngestError::AuthFailed(MANAGER_LIMIT.into()));
    }
    let mut task = None;
    let mut confirm = ConfirmFacts::none();
    if let Some((part, Some(task_id))) = requirement.step {
        task = state
            .db
            .get_event_by_id_for_event_write(community, &task_id)
            .await
            .map_err(|e| internal("reading the task", e))?
            .and_then(|stored| task_facts(&stored.event));
        if let Some(facts) = task.as_mut().filter(|facts| facts.helper.is_none()) {
            facts.takes =
                super::task_takes::stored_takes(state, community, &task_id, &signer).await?;
        }
        if let (TaskPart::Confirm, Some(helper)) = (
            part,
            task.as_ref().and_then(TaskFacts::worker).and_then(id_bytes),
        ) {
            let signer_bytes = event.pubkey.to_bytes();
            if helper != signer_bytes {
                if state
                    .db
                    .is_agent_owner(community, &helper, &signer_bytes)
                    .await
                    .map_err(|e| internal("checking who runs the helper", e))?
                {
                    confirm.link = HelperLink::SignerRunsHelper;
                } else if state
                    .db
                    .is_agent_owner(community, &signer_bytes, &helper)
                    .await
                    .map_err(|e| internal("checking who runs the signer", e))?
                {
                    confirm.link = HelperLink::HelperRunsSigner;
                }
            }
            // The founder checking their own work, or their agent's: allowed only while the project record lists
            // no other person. Which of the other team members are agent accounts is asked here and nowhere else.
            let helper_hex = hex::encode(helper);
            if team.is_founder(&signer)
                && (helper == signer_bytes || confirm.link == HelperLink::SignerRunsHelper)
            {
                confirm.agents = agents_among(state, community, team.others(&helper_hex)).await?;
            }
        }
    }

    // Only a record that needs a person asks whether its signer is an agent.
    let signer_is_agent = if requirement.needs_a_person() {
        is_agent_account(state, community, &event.pubkey.to_bytes()).await?
    } else {
        false
    };

    decide(
        &requirement,
        &signer,
        &coordinate,
        &team,
        task.as_ref(),
        &confirm,
        signer_is_agent,
    )
    .map_err(|reason| {
        if reason.starts_with("restricted:") {
            IngestError::AuthFailed(reason.into())
        } else {
            IngestError::Rejected(reason.into())
        }
    })?;

    // A confirm that names a box payment holds a lock on that payment until its record is stored.
    let mut payment_lock = None;
    if let Some((part, Some(task_id))) = requirement.step {
        payment_lock = super::task_chain::enforce(
            state,
            community,
            &record.event,
            &coordinate,
            event,
            super::task_chain::StepOn {
                part,
                task_id: &task_id,
                worker: task.as_ref().and_then(TaskFacts::worker),
                usd: task.as_ref().and_then(|task| task.usd),
            },
        )
        .await?;
    }
    if let Some((part, _)) = requirement.step {
        // The chain's helper limits are tied to the server's labels through the wallets an account linked.
        if let Some(key) = super::task_chain::chain_key_of(&record.event) {
            let open_usd = (part == TaskPart::Task)
                .then(|| open_task_usd(event))
                .flatten();
            super::chain_agent_link::enforce_step(state, community, &key, event, open_usd).await?;
        }
    }
    if requirement.join {
        enforce_join_caps(state, community, event, &coordinate).await?;
    }
    if requirement
        .step
        .is_some_and(|(part, _)| part == TaskPart::Take)
    {
        super::task_takes::enforce_take_caps(state, community, event, TAKES_PER_DAY).await?;
    }
    if let Some(mute) = &requirement.room_mute {
        enforce_room_mute(state, community, &team, mute, &signer).await?;
    }
    match requirement.season {
        Some(step) => {
            super::season_rules::enforce_step(
                state,
                tenant,
                event,
                step,
                &record.event,
                &coordinate,
            )
            .await
        }
        // A season record is nothing else (see `classify`), so at most one of the two locks is held.
        None => Ok(payment_lock),
    }
}

/// Hold a `room-mute` record to its bounds against the clock and to the people no team may stop: its end is at most
/// 30 days ahead (one in the past lifts a mute), and it names neither the founder, an operator of the server, nor its
/// own signer. Who may sign it (the team) is judged by [`decide`].
///
/// A mute follows each wallet it lists to every account that has linked that wallet, so the wallets are held to the
/// same rule as the person: each must be one the person has linked themselves now, and none may be linked by the
/// founder, an operator or the signer. Without that, a team member could list the founder's wallet under any person
/// and stop the founder writing in their own room.
async fn enforce_room_mute(
    state: &AppState,
    community: buzz_core::tenant::CommunityId,
    team: &ProjectTeam,
    mute: &RoomMute,
    signer: &str,
) -> Result<(), IngestError> {
    let now = u64::try_from(chrono::Utc::now().timestamp()).unwrap_or(0);
    if mute.until > now.saturating_add(ROOM_MUTE_MAX_SECS) {
        return Err(IngestError::Rejected(BAD_ROOM_MUTE.into()));
    }
    let protected = |who: &str| {
        team.is_founder(who) || who == signer || super::season_rules::is_operator(state, who)
    };
    if protected(&mute.person) {
        return Err(IngestError::AuthFailed(MUTE_PROTECTED.into()));
    }
    if mute.wallets.is_empty() {
        return Ok(());
    }
    let person =
        id_bytes(&mute.person).ok_or_else(|| IngestError::Rejected(BAD_ROOM_MUTE.into()))?;
    let linked = super::wallet_binding::linked_wallets(state, community, &person)
        .await
        .map_err(|e| internal("reading the wallets of the person to stop", e))?;
    if mute.wallets.iter().any(|wallet| !linked.contains(wallet)) {
        return Err(IngestError::Rejected(MUTE_WALLET_NOT_THEIRS.into()));
    }
    let owners = super::wallet_binding::accounts_of_wallets(state, community, &mute.wallets)
        .await
        .map_err(|e| internal("reading who has linked the wallets of a mute", e))?;
    if owners
        .iter()
        .any(|(_, account)| protected(&hex::encode(account)))
    {
        return Err(IngestError::AuthFailed(MUTE_PROTECTED.into()));
    }
    Ok(())
}

/// Refuse a project record (kind 37001) signed by an agent account that adds to the team someone who asked to join it.
///
/// Saving the record again is how the founder accepts an ask, and accepting is for a person, as confirming work is.
/// An agent account may still ask to join a project and may add people nobody has asked about, as before. A record
/// that adds nobody, or whose signer is not on record as an agent account, is not looked at any further.
pub(crate) async fn enforce_agent_cannot_accept(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    event: &Event,
) -> Result<(), IngestError> {
    let community = tenant.community();
    let signer = event.pubkey.to_bytes();
    let incoming = ProjectTeam::from_record(event).members;
    if incoming.is_empty() || !is_agent_account(state, community, &signer).await? {
        return Ok(());
    }
    let d = event
        .tags
        .iter()
        .find_map(|tag| {
            let fields = tag.as_slice();
            (fields.first().map(|s| s.as_str()) == Some("d"))
                .then(|| fields.get(1).cloned())
                .flatten()
        })
        .unwrap_or_default();
    let stored = state
        .db
        .query_events_for_event_write(&buzz_db::EventQuery {
            kinds: Some(vec![KIND_LAUNCH_RECORD as i32]),
            pubkey: Some(signer.to_vec()),
            d_tag: Some(d.clone()),
            global_only: true,
            limit: Some(1),
            ..buzz_db::EventQuery::for_community(community)
        })
        .await
        .map_err(|e| internal("reading the project record", e))?
        .into_iter()
        .next()
        .map(|stored| ProjectTeam::from_record(&stored.event).members)
        .unwrap_or_default();
    let coordinate = format!("{KIND_LAUNCH_RECORD}:{}:{d}", event.pubkey.to_hex());
    let mut added: Vec<&String> = incoming
        .iter()
        .filter(|member| !stored.contains(*member))
        .collect();
    added.sort();
    for member in added.into_iter().take(TEAM_LOOKUPS_FOR_ASKS) {
        let Some(key) = id_bytes(member) else {
            continue;
        };
        let asked = state
            .db
            .count_tagged_events_received_since(
                community,
                &key,
                &[KIND_LAUNCH_UPDATE as i32],
                &[("l", JOIN_LABEL), ("a", &coordinate)],
                None,
            )
            .await
            .map_err(|e| internal("checking whether the person asked to join", e))?;
        if asked > 0 {
            return Err(IngestError::AuthFailed(AGENT_ACCEPT.into()));
        }
    }
    Ok(())
}

/// The most people added in one save whose asks are looked up: a team is at most 200 (the server's cap on team tags).
const TEAM_LOOKUPS_FOR_ASKS: usize = 200;

/// Hold an ask to join to its caps: a few for one project, a few projects a day. Counted by the server's receive time,
/// and a refused ask is not stored, so it uses no room. The web app shows one button and hides it once asked, so a
/// person meets these only by asking again after being taken off a team, or by a script.
async fn enforce_join_caps(
    state: &Arc<AppState>,
    community: buzz_core::tenant::CommunityId,
    event: &Event,
    coordinate: &str,
) -> Result<(), IngestError> {
    let kinds = [KIND_LAUNCH_UPDATE as i32];
    let signer = event.pubkey.to_bytes();
    let for_project = state
        .db
        .count_tagged_events_received_since(
            community,
            &signer,
            &kinds,
            &[("l", JOIN_LABEL), ("a", coordinate)],
            None,
        )
        .await
        .map_err(|e| internal("counting asks to join this project", e))?;
    if for_project >= ASKS_PER_PROJECT {
        return Err(IngestError::AuthFailed(ASKED_ENOUGH.into()));
    }
    let today = state
        .db
        .count_tagged_events_received_since(
            community,
            &signer,
            &kinds,
            &[("l", JOIN_LABEL)],
            Some(chrono::Utc::now() - chrono::Duration::hours(24)),
        )
        .await
        .map_err(|e| internal("counting asks to join today", e))?;
    if today >= ASKS_PER_DAY {
        return Err(IngestError::Rejected(ASKING_TOO_MUCH.into()));
    }
    Ok(())
}

/// Whether the server has `account` on record as an agent account: someone runs it.
pub(crate) async fn is_agent_account(
    state: &Arc<AppState>,
    community: buzz_core::tenant::CommunityId,
    account: &[u8],
) -> Result<bool, IngestError> {
    Ok(state
        .db
        .get_agent_channel_policy(community, account)
        .await
        .map_err(|e| internal("checking whether an account is an agent account", e))?
        .is_some_and(|(_, owner)| owner.is_some()))
}

/// The team members among `others` that the server has on record as agent
/// accounts, read until the first one that is a person: one person is enough
/// to say the founder is not alone, so nothing after it is asked. At most
/// [`TEAM_LOOKUPS`] accounts are looked up; a member past that, or one whose
/// key cannot be read, is left out and so counts as a person.
async fn agents_among<'a>(
    state: &Arc<AppState>,
    community: buzz_core::tenant::CommunityId,
    others: impl Iterator<Item = &'a String>,
) -> Result<HashSet<String>, IngestError> {
    let mut agents = HashSet::new();
    for member in others.take(TEAM_LOOKUPS) {
        let Some(key) = id_bytes(member) else {
            break;
        };
        if !is_agent_account(state, community, &key).await? {
            break;
        }
        agents.insert(member.clone());
    }
    Ok(agents)
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind, Tag};

    struct World {
        founder: Keys,
        mate: Keys,
        former: Keys,
        stranger: Keys,
        helper: Keys,
    }

    impl World {
        fn new() -> Self {
            Self {
                founder: Keys::generate(),
                mate: Keys::generate(),
                former: Keys::generate(),
                stranger: Keys::generate(),
                helper: Keys::generate(),
            }
        }

        fn coordinate(&self) -> String {
            format!("37001:{}:orbit", self.founder.public_key().to_hex())
        }

        /// The project record as it stands now: `former` was on an earlier version and is gone.
        fn team(&self) -> ProjectTeam {
            let mate = self.mate.public_key().to_hex();
            let record = sign(
                &self.founder,
                KIND_LAUNCH_RECORD,
                &[
                    &["d", "orbit"],
                    &["name", "Orbit"],
                    &["team", &mate, "engineer"],
                    // Not a member: the tag has no role, and the web app does not read it either.
                    &["team", &self.stranger.public_key().to_hex()],
                ],
            );
            ProjectTeam::from_record(&record)
        }

        fn record(&self, who: &Keys, tags: &[&[&str]]) -> Event {
            let coordinate = self.coordinate();
            let a: [&str; 2] = ["a", &coordinate];
            let mut all: Vec<&[&str]> = vec![&a];
            all.extend_from_slice(tags);
            sign(who, KIND_LAUNCH_UPDATE, &all)
        }

        fn task(&self, who: &Keys) -> Event {
            let helper = self.helper.public_key().to_hex();
            self.record(
                who,
                &[
                    &["l", "creaton-task"],
                    &["task-part", "task"],
                    &["p", &helper],
                    &["task-helper", &helper],
                    &["task-what", "Draw the map"],
                    &["task-done", "A map anyone can read"],
                    &["task-size", "small"],
                ],
            )
        }

        fn step(&self, who: &Keys, part: &str, task: &Event) -> Event {
            let id = task.id.to_hex();
            self.record(
                who,
                &[
                    &["l", "creaton-task"],
                    &["task-part", part],
                    &["e", &id],
                    &["task", &id],
                ],
            )
        }

        /// The verdict on `event`, with `task` as the stored task it names.
        fn verdict(&self, event: &Event, task: Option<&Event>) -> Result<(), &'static str> {
            self.verdict_as(event, task, false, false)
        }

        fn verdict_linked(
            &self,
            event: &Event,
            task: Option<&Event>,
            linked: bool,
        ) -> Result<(), &'static str> {
            self.verdict_as(event, task, linked, false)
        }

        /// The verdict when the server has the signer on record as an agent account.
        fn verdict_agent(&self, event: &Event, task: Option<&Event>) -> Result<(), &'static str> {
            self.verdict_as(event, task, false, true)
        }

        fn verdict_as(
            &self,
            event: &Event,
            task: Option<&Event>,
            linked: bool,
            agent: bool,
        ) -> Result<(), &'static str> {
            let link = if linked {
                HelperLink::SignerRunsHelper
            } else {
                HelperLink::None
            };
            self.verdict_on(event, task, &self.team(), link, &[], agent)
        }

        /// The verdict against any team, with the server's agent-owner tie and the team members it has on record
        /// as agent accounts.
        fn verdict_on(
            &self,
            event: &Event,
            task: Option<&Event>,
            team: &ProjectTeam,
            link: HelperLink,
            agents: &[&Keys],
            signer_is_agent: bool,
        ) -> Result<(), &'static str> {
            let requirement = classify(event).expect("readable").expect("a known family");
            let facts = task.and_then(task_facts);
            let confirm = ConfirmFacts {
                link,
                agents: agents.iter().map(|k| k.public_key().to_hex()).collect(),
            };
            decide(
                &requirement,
                &event.pubkey.to_hex(),
                &self.coordinate(),
                team,
                facts.as_ref(),
                &confirm,
                signer_is_agent,
            )
        }

        /// The project record with exactly these team members.
        fn team_of(&self, members: &[&Keys]) -> ProjectTeam {
            let keys: Vec<String> = members.iter().map(|k| k.public_key().to_hex()).collect();
            let mut tags: Vec<Vec<&str>> = vec![vec!["d", "orbit"], vec!["name", "Orbit"]];
            for key in &keys {
                tags.push(vec!["team", key, "engineer"]);
            }
            let tags: Vec<&[&str]> = tags.iter().map(Vec::as_slice).collect();
            ProjectTeam::from_record(&sign(&self.founder, KIND_LAUNCH_RECORD, &tags))
        }

        /// A task on this project that `who` makes for `helper`.
        fn task_for(&self, who: &Keys, helper: &Keys) -> Event {
            let helper = helper.public_key().to_hex();
            self.record(who, &[&["task-part", "task"], &["task-helper", &helper]])
        }
    }

    fn sign(keys: &Keys, kind: u32, tags: &[&[&str]]) -> Event {
        let tags: Vec<Tag> = tags
            .iter()
            .map(|fields| Tag::parse(fields.to_vec()).expect("tag"))
            .collect();
        EventBuilder::new(Kind::Custom(kind as u16), "{}")
            .tags(tags)
            .allow_self_tagging()
            .sign_with_keys(keys)
            .expect("sign")
    }

    const ID: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    /// A record with these tags after the `a` tag and this JSON body.
    fn with_body(w: &World, who: &Keys, tags: &[&[&str]], body: &str) -> Event {
        let coordinate = w.coordinate();
        let a: [&str; 2] = ["a", &coordinate];
        let mut all: Vec<&[&str]> = vec![&a];
        all.extend_from_slice(tags);
        let tags: Vec<Tag> = all
            .iter()
            .map(|fields| Tag::parse(fields.to_vec()).expect("tag"))
            .collect();
        EventBuilder::new(Kind::Custom(KIND_LAUNCH_UPDATE as u16), body)
            .tags(tags)
            .allow_self_tagging()
            .sign_with_keys(who)
            .expect("sign")
    }

    /// A task is "open" (its pay is held to the signer's helper limit) only when it names no helper: a task that names one
    /// is that helper's alone and offers nothing to anyone else. Remove the early return and the named task offers its pay.
    #[test]
    fn only_a_task_that_names_no_helper_offers_its_pay_to_the_helper_limit() {
        let w = World::new();
        let open = |extra: &[&[&str]]| {
            let mut tags: Vec<&[&str]> = vec![&["l", "creaton-task"], &["task-part", "task"]];
            tags.extend_from_slice(extra);
            w.record(&w.founder, &tags)
        };
        let helper = w.helper.public_key().to_hex();
        assert_eq!(open_task_usd(&open(&[&["task-usd", "30"]])), Some(30));
        assert_eq!(
            open_task_usd(&open(&[&["task-usd", "30"], &["task-helper", &helper]])),
            None
        );
        assert_eq!(open_task_usd(&open(&[])), None);
        assert_eq!(open_task_usd(&open(&[&["task-usd", "lots"]])), None);
    }

    #[test]
    fn a_record_that_says_nothing_about_itself_is_the_teams() {
        let w = World::new();
        // A plain update (only the `a` tag), tags this module does not know, a team answer: the team's.
        let unknown: &[&[&str]] = &[
            &["claim", "c1"],
            &["goal-text", "not the goal tag"],
            &["e", ID],
        ];
        // `task` and `task-helper` alone say nothing: the step is what makes a task record.
        let loose: &[&[&str]] = &[&["task", ID], &["task-helper", ID]];
        let answer: &[&[&str]] = &[&["l", "creaton-team"], &["team-answer", "yes"]];
        for tags in [&[][..], unknown, loose, answer] {
            for member in [&w.founder, &w.mate] {
                assert_eq!(w.verdict(&w.record(member, tags), None), Ok(()), "{tags:?}");
            }
            for other in [&w.former, &w.stranger, &w.helper] {
                assert_eq!(
                    w.verdict(&w.record(other, tags), None),
                    Err(NOT_TEAM),
                    "{tags:?}"
                );
            }
        }
        // A body that is plain words, not JSON, or names on-chain work badly is still a plain update.
        for body in [
            r#"{"title":"News","body":"We shipped"}"#,
            "not json",
            r#"["claim"]"#,
            r#"{"claim":"0xabc"}"#,
            r#"{"claim":null,"review":true}"#,
            r#"{"check":{"v":1}}"#,
        ] {
            let plain = with_body(&w, &w.stranger, &[], body);
            assert_eq!(w.verdict(&plain, None), Err(NOT_TEAM), "{body}");
        }
    }

    #[test]
    fn records_about_on_chain_work_are_still_anyones() {
        let w = World::new();
        for key in OPEN_WORK_KEYS {
            let body =
                format!(r#"{{"title":"Evidence","body":"See the link","{key}":{{"id":"0x01"}}}}"#);
            assert_eq!(
                classify(&with_body(&w, &w.stranger, &[], &body)),
                Ok(None),
                "{key}"
            );
            // The body opens nothing once the record carries a known tag: a goal is the founder's whatever it says.
            let dressed = with_body(&w, &w.stranger, &[&["goal", "g1"]], &body);
            assert_eq!(w.verdict(&dressed, None), Err(NOT_FOUNDER), "{key}");
        }
    }

    #[test]
    fn an_agent_account_never_signs_what_needs_a_person() {
        let w = World::new();
        let task = w.task(&w.founder);
        // Goals, promises and promise marks: refused even from the founder's own key.
        for tags in [
            vec![vec!["goal", "g1"]],
            vec![
                vec!["update-part", "next", "Ship"],
                vec!["promise", "p1", "Ship"],
            ],
            vec![vec!["promise-mark", "p1", "kept"]],
        ] {
            let tags: Vec<&[&str]> = tags.iter().map(|t| t.as_slice()).collect();
            let record = w.record(&w.founder, &tags);
            assert_eq!(w.verdict(&record, None), Ok(()));
            assert_eq!(w.verdict_agent(&record, None), Err(AGENT_LIMIT), "{tags:?}");
        }
        // Checking work and granting more time: refused even from a team member.
        for part in ["confirm", "grant"] {
            let step = w.step(&w.mate, part, &task);
            assert_eq!(w.verdict(&step, Some(&task)), Ok(()));
            assert_eq!(
                w.verdict_agent(&step, Some(&task)),
                Err(AGENT_LIMIT),
                "{part}"
            );
        }
        // Everything else an agent may do exactly as any account in its place.
        for part in ["accept", "evidence", "more-time", "give-up"] {
            let step = w.step(&w.helper, part, &task);
            assert_eq!(w.verdict_agent(&step, Some(&task)), Ok(()), "{part}");
        }
        for part in ["send-back", "cancel"] {
            let step = w.step(&w.mate, part, &task);
            assert_eq!(w.verdict_agent(&step, Some(&task)), Ok(()), "{part}");
        }
        let offer = w.record(&w.stranger, &[&["e", ID], &["help-offer", ID]]);
        assert_eq!(w.verdict_agent(&offer, None), Ok(()));
        let update = w.record(&w.mate, &[&["update-part", "done", "Shipped"]]);
        assert_eq!(w.verdict_agent(&update, None), Ok(()));
        assert_eq!(w.verdict_agent(&w.task(&w.mate), None), Ok(()));
        // An agent out of place is told what anyone out of place is told.
        assert_eq!(
            w.verdict_agent(&w.record(&w.stranger, &[&["goal", "g1"]]), None),
            Err(NOT_FOUNDER)
        );
        assert_eq!(
            w.verdict_agent(&w.step(&w.stranger, "confirm", &task), Some(&task)),
            Err(NOT_TEAM)
        );
    }

    #[test]
    fn goals_and_promises_are_the_founders_alone() {
        let w = World::new();
        for tags in [
            vec![
                vec!["goal", "g1"],
                vec!["goal-level", "main"],
                vec!["goal-state", "open"],
            ],
            vec![
                vec!["update-part", "next", "Ship it"],
                vec!["promise", "p1", "Ship it"],
            ],
            vec![vec!["promise-mark", "p1", "kept"]],
        ] {
            let tags: Vec<&[&str]> = tags.iter().map(|t| t.as_slice()).collect();
            assert_eq!(w.verdict(&w.record(&w.founder, &tags), None), Ok(()));
            for other in [&w.mate, &w.former, &w.stranger, &w.helper] {
                assert_eq!(
                    w.verdict(&w.record(other, &tags), None),
                    Err(NOT_FOUNDER),
                    "{tags:?}"
                );
            }
        }
    }

    #[test]
    fn updates_and_answers_to_offers_are_the_teams() {
        let w = World::new();
        for tags in [
            vec![vec!["update-part", "done", "Shipped"]],
            vec![vec!["update-kind", "weekly"]],
            vec![
                vec!["help-needed", "A designer"],
                vec!["help-size", "small"],
            ],
            vec![vec!["e", ID], vec!["help-reply", ID]],
            vec![vec!["e", ID], vec!["help-found", ID]],
        ] {
            let tags: Vec<&[&str]> = tags.iter().map(|t| t.as_slice()).collect();
            for member in [&w.founder, &w.mate] {
                assert_eq!(
                    w.verdict(&w.record(member, &tags), None),
                    Ok(()),
                    "{tags:?}"
                );
            }
            // A former member is a stranger now; so is a `team` tag without a role.
            for other in [&w.former, &w.stranger, &w.helper] {
                assert_eq!(
                    w.verdict(&w.record(other, &tags), None),
                    Err(NOT_TEAM),
                    "{tags:?}"
                );
            }
        }
    }

    #[test]
    fn anyone_may_offer_help() {
        let w = World::new();
        for who in [&w.stranger, &w.former, &w.helper, &w.mate, &w.founder] {
            let offer = w.record(who, &[&["e", ID], &["help-offer", ID]]);
            assert_eq!(w.verdict(&offer, None), Ok(()));
        }
    }

    #[test]
    fn the_team_makes_tasks_and_answers_and_the_helper_does_the_work() {
        let w = World::new();
        for member in [&w.founder, &w.mate] {
            assert_eq!(w.verdict(&w.task(member), None), Ok(()));
        }
        for other in [&w.former, &w.stranger, &w.helper] {
            assert_eq!(w.verdict(&w.task(other), None), Err(NOT_TEAM));
        }

        let task = w.task(&w.founder);
        for part in ["send-back", "confirm", "grant", "cancel"] {
            for member in [&w.founder, &w.mate] {
                assert_eq!(
                    w.verdict(&w.step(member, part, &task), Some(&task)),
                    Ok(()),
                    "{part}"
                );
            }
            for other in [&w.former, &w.stranger] {
                assert_eq!(
                    w.verdict(&w.step(other, part, &task), Some(&task)),
                    Err(NOT_TEAM),
                    "{part}"
                );
            }
        }
        for part in ["accept", "evidence", "more-time", "give-up"] {
            assert_eq!(
                w.verdict(&w.step(&w.helper, part, &task), Some(&task)),
                Ok(()),
                "{part}"
            );
            // The team cannot do the helper's part for them, and neither can anyone else.
            for other in [&w.founder, &w.mate, &w.former, &w.stranger] {
                assert_eq!(
                    w.verdict(&w.step(other, part, &task), Some(&task)),
                    Err(NOT_HELPER),
                    "{part}"
                );
            }
        }
    }

    #[test]
    fn nobody_confirms_their_own_work() {
        let w = World::new();
        // The helper is not on the team: refused as a stranger to it.
        let task = w.task(&w.founder);
        assert_eq!(
            w.verdict(&w.step(&w.helper, "confirm", &task), Some(&task)),
            Err(NOT_TEAM)
        );
        // A team member helping on their own project's task still cannot grade it.
        let mate = w.mate.public_key().to_hex();
        let own = w.record(
            &w.founder,
            &[&["task-part", "task"], &["task-helper", &mate]],
        );
        assert_eq!(
            w.verdict(&w.step(&w.mate, "confirm", &own), Some(&own)),
            Err(OWN_WORK)
        );
        assert_eq!(
            w.verdict(&w.step(&w.founder, "confirm", &own), Some(&own)),
            Ok(())
        );
        // Whoever runs the helper, or is run by it, may not either. Other team steps are unaffected.
        assert_eq!(
            w.verdict_linked(&w.step(&w.founder, "confirm", &task), Some(&task), true),
            Err(OWN_WORK)
        );
        assert_eq!(
            w.verdict_linked(&w.step(&w.founder, "send-back", &task), Some(&task), true),
            Ok(())
        );
        // The helper on the team may still do the team's other steps.
        assert_eq!(
            w.verdict(&w.step(&w.mate, "cancel", &own), Some(&own)),
            Ok(())
        );
    }

    #[test]
    fn a_founder_working_alone_checks_their_own_work() {
        let w = World::new();
        let none = HelperLink::None;
        let runs = HelperLink::SignerRunsHelper;
        let alone = w.team_of(&[]);
        let own = w.task_for(&w.founder, &w.founder);
        let confirm = w.step(&w.founder, "confirm", &own);
        // Nobody else is on the project: the founder's own task is theirs to check.
        assert_eq!(
            w.verdict_on(&confirm, Some(&own), &alone, none, &[], false),
            Ok(())
        );
        // So is the work of an agent the founder runs, whether or not that agent is listed on the team.
        let agents_task = w.task_for(&w.founder, &w.helper);
        let agents_confirm = w.step(&w.founder, "confirm", &agents_task);
        for team in [w.team_of(&[]), w.team_of(&[&w.helper])] {
            assert_eq!(
                w.verdict_on(&agents_confirm, Some(&agents_task), &team, runs, &[], false),
                Ok(())
            );
        }
        // The founder listing themself on the team adds nobody.
        assert_eq!(
            w.verdict_on(
                &confirm,
                Some(&own),
                &w.team_of(&[&w.founder]),
                none,
                &[],
                false
            ),
            Ok(())
        );

        // One other person on the team, and the refusal is back: for the founder's own task and their agent's.
        let with_mate = w.team_of(&[&w.mate]);
        assert_eq!(
            w.verdict_on(&confirm, Some(&own), &with_mate, none, &[], false),
            Err(OWN_WORK)
        );
        assert_eq!(
            w.verdict_on(
                &agents_confirm,
                Some(&agents_task),
                &with_mate,
                runs,
                &[],
                false
            ),
            Err(OWN_WORK)
        );
        // That person checks it as before.
        assert_eq!(
            w.verdict_on(
                &w.step(&w.mate, "confirm", &own),
                Some(&own),
                &with_mate,
                none,
                &[],
                false
            ),
            Ok(())
        );

        // A team whose only other member is an agent account: an agent can never confirm, so the founder is
        // still the only person and may check their own work.
        assert_eq!(
            w.verdict_on(&confirm, Some(&own), &with_mate, none, &[&w.mate], false),
            Ok(())
        );
        // An agent and a person: not alone.
        let two = w.team_of(&[&w.mate, &w.stranger]);
        assert_eq!(
            w.verdict_on(&confirm, Some(&own), &two, none, &[&w.mate], false),
            Err(OWN_WORK)
        );

        // It is the founder's exception alone. A team member who is not the founder never checks their own work,
        // even when nobody but the founder could (and the founder can).
        let mates = w.task_for(&w.founder, &w.mate);
        assert_eq!(
            w.verdict_on(
                &w.step(&w.mate, "confirm", &mates),
                Some(&mates),
                &with_mate,
                none,
                &[],
                false
            ),
            Err(OWN_WORK)
        );
        // Nor the work of an agent they run.
        assert_eq!(
            w.verdict_on(
                &w.step(&w.mate, "confirm", &agents_task),
                Some(&agents_task),
                &with_mate,
                runs,
                &[],
                false
            ),
            Err(OWN_WORK)
        );
        // An agent account never confirms: not as the founder alone, and not as the founder's agent.
        assert_eq!(
            w.verdict_on(&confirm, Some(&own), &alone, none, &[], true),
            Err(AGENT_LIMIT)
        );
        assert_eq!(
            w.verdict_on(
                &w.step(&w.helper, "confirm", &agents_task),
                Some(&agents_task),
                &w.team_of(&[&w.helper]),
                none,
                &[],
                true
            ),
            Err(OWN_WORK)
        );
        // A founder the helper runs is that helper's agent, not a person working alone.
        assert_eq!(
            w.verdict_on(
                &agents_confirm,
                Some(&agents_task),
                &alone,
                HelperLink::HelperRunsSigner,
                &[],
                false
            ),
            Err(OWN_WORK)
        );
        // A stranger with no place on the project is told so, alone or not.
        assert_eq!(
            w.verdict_on(
                &w.step(&w.stranger, "confirm", &own),
                Some(&own),
                &alone,
                none,
                &[],
                false
            ),
            Err(NOT_TEAM)
        );
    }

    #[test]
    fn a_step_needs_its_task_on_this_project() {
        let w = World::new();
        let task = w.task(&w.founder);
        // No task record under that id (never stored, deleted, or not a task at all).
        assert_eq!(
            w.verdict(&w.step(&w.helper, "evidence", &task), None),
            Err(NO_TASK)
        );
        let not_a_task = w.record(&w.founder, &[&["update-part", "done", "x"]]);
        assert_eq!(task_facts(&not_a_task), None);
        let a_step = w.step(&w.helper, "evidence", &task);
        assert_eq!(task_facts(&a_step), None);
        let wrong_kind = sign(
            &w.founder,
            KIND_LAUNCH_RECORD,
            &[
                &["a", &w.coordinate()],
                &["task-part", "task"],
                &["task-helper", ID],
            ],
        );
        assert_eq!(task_facts(&wrong_kind), None);

        // A task on another project, where the signer is the founder and names themselves helper.
        let elsewhere = format!("37001:{}:mine", w.stranger.public_key().to_hex());
        let stranger = w.stranger.public_key().to_hex();
        let foreign = sign(
            &w.stranger,
            KIND_LAUNCH_UPDATE,
            &[
                &["a", &elsewhere],
                &["task-part", "task"],
                &["task-helper", &stranger],
            ],
        );
        assert_eq!(
            w.verdict(&w.step(&w.stranger, "evidence", &foreign), Some(&foreign)),
            Err(OTHER_PROJECT)
        );
        // The team's steps are held to the same rule.
        assert_eq!(
            w.verdict(&w.step(&w.founder, "cancel", &foreign), Some(&foreign)),
            Err(OTHER_PROJECT)
        );
    }

    #[test]
    fn records_that_cannot_be_read_as_their_family_are_refused() {
        let w = World::new();
        let helper = w.helper.public_key().to_hex();
        let refused = |tags: &[&[&str]]| classify(&w.record(&w.founder, tags)).unwrap_err();
        assert!(refused(&[&["task-part", "task"], &["task-part", "confirm"]]).contains("only one"));
        assert!(refused(&[&["task-part", "reopen"], &["task", ID]]).contains("unknown task step"));
        assert!(refused(&[&["task-part", "task"]]).contains("task-helper"));
        assert!(
            refused(&[&["task-part", "task"], &["task-helper", "not-a-key"]])
                .contains("task-helper")
        );
        assert!(refused(&[&["task-part", "evidence"]]).contains("`task` tag"));
        assert!(refused(&[&["task-part", "evidence"], &["task", "ABC"]]).contains("`task` tag"));
        // The step's task is the `task` tag, never the helper tag or an `e` alone.
        assert!(refused(&[
            &["task-part", "evidence"],
            &["e", ID],
            &["task-helper", &helper]
        ])
        .contains("`task` tag"));
        assert!(refused(&[&["help-offer", ID], &["help-found", ID]]).contains("only one"));
        assert!(refused(&[&["help-reply", "nope"]]).contains("help-reply"));
        assert!(refused(&[&["help-offer"]]).contains("help-offer"));
    }

    #[test]
    fn a_record_of_two_families_must_satisfy_both() {
        let w = World::new();
        // A goal that also claims to be "Help found": the founder passes both, a team member only one.
        let tags: &[&[&str]] = &[&["goal", "g1"], &["help-found", ID]];
        assert_eq!(w.verdict(&w.record(&w.founder, tags), None), Ok(()));
        assert_eq!(w.verdict(&w.record(&w.mate, tags), None), Err(NOT_FOUNDER));
        // A helper's step dressed as an update is still the team's to post.
        let task = w.task(&w.founder);
        let id = task.id.to_hex();
        let dressed = w.record(
            &w.helper,
            &[
                &["task-part", "evidence"],
                &["task", &id],
                &["update-part", "done", "x"],
            ],
        );
        assert_eq!(w.verdict(&dressed, Some(&task)), Err(NOT_TEAM));
    }

    #[test]
    fn reported_results_ride_only_on_work_handed_in_and_stay_in_bounds() {
        let w = World::new();
        let task = w.task(&w.founder);
        let id = task.id.to_hex();
        let hand_in = |extra: &[&[&str]]| {
            let mut tags: Vec<&[&str]> = vec![&["task-part", "evidence"]];
            let task_tag = ["task", id.as_str()];
            tags.push(&task_tag);
            tags.extend_from_slice(extra);
            w.record(&w.helper, &tags)
        };
        let ok: &[&[&str]] = &[
            &[
                "task-result",
                "pass_rate",
                "0.82",
                "ratio",
                "0.71",
                "40",
                "commit abc",
            ],
            &["task-run-log", &"a".repeat(64), "run.log"],
            &["task-run-record", &"b".repeat(64)],
        ];
        assert!(classify(&hand_in(ok)).is_ok());
        assert_eq!(w.verdict(&hand_in(ok), Some(&task)), Ok(()));
        // Out of bounds: not a number, a missing field, a repeated name, a run record that is not an id.
        for bad in [
            &["task-result", "pass_rate", "high", "", "", "", ""][..],
            &["task-result", "pass_rate", "0.8"][..],
            &["task-run-record", "nope"][..],
        ] {
            let error = classify(&hand_in(&[bad])).unwrap_err();
            assert!(!error.is_empty(), "{bad:?}");
        }
        let twice: &[&[&str]] = &[
            &["task-result", "score", "1", "", "", "", ""],
            &["task-result", "Score", "2", "", "", "", ""],
        ];
        assert!(classify(&hand_in(twice)).unwrap_err().contains("twice"));
        let eleven: Vec<Vec<String>> = (0..11)
            .map(|i| {
                ["task-result", &format!("m{i}"), "1", "", "", "", ""]
                    .iter()
                    .map(|p| (*p).to_string())
                    .collect()
            })
            .collect();
        let eleven: Vec<Vec<&str>> = eleven
            .iter()
            .map(|t| t.iter().map(String::as_str).collect())
            .collect();
        let eleven: Vec<&[&str]> = eleven.iter().map(Vec::as_slice).collect();
        assert!(classify(&hand_in(&eleven)).unwrap_err().contains("at most"));
        // On any other step they are refused: the team's confirmation cannot carry a helper's numbers.
        let confirm = w.record(
            &w.mate,
            &[
                &["task-part", "confirm"],
                &["task", &id],
                &["task-result", "pass_rate", "0.9", "", "", "", ""],
            ],
        );
        assert!(classify(&confirm).unwrap_err().contains("handed in"));
        let plain = w.record(
            &w.founder,
            &[
                &["update-part", "done", "x"],
                &["task-result", "a", "1", "", "", "", ""],
            ],
        );
        assert!(classify(&plain).unwrap_err().contains("handed in"));
    }
    /// An ask to join, as the web app signs it: its label, its name, and the person's own yes to that name.
    fn ask(w: &World, who: &Keys, invite: &str) -> Event {
        let founder = w.founder.public_key().to_hex();
        w.record(
            who,
            &[
                &["l", JOIN_LABEL],
                &["join-ask", invite],
                &["l", "creaton-team"],
                &["team-answer", "yes"],
                &["team-invite", invite],
                &["p", &founder],
            ],
        )
    }

    /// An ask with these extra tags and this body, otherwise as the web app signs it.
    fn ask_with(w: &World, extra: &[&[&str]], body: &str) -> Event {
        let founder = w.founder.public_key().to_hex();
        let mut tags: Vec<&[&str]> = vec![&["l", JOIN_LABEL], &["join-ask", "abc123"]];
        let p = ["p", founder.as_str()];
        tags.push(&p);
        tags.extend_from_slice(extra);
        with_body(w, &w.stranger, &tags, body)
    }

    #[test]
    fn anyone_not_on_the_team_may_ask_to_join_and_nobody_else_gets_a_say() {
        let w = World::new();
        // A stranger, the helper and someone who was on an earlier version of the team may ask.
        for who in [&w.stranger, &w.helper, &w.former] {
            assert_eq!(w.verdict(&ask(&w, who, "abc123"), None), Ok(()));
        }
        // An agent account may ask: an ask needs no person.
        assert_eq!(
            w.verdict_agent(&ask(&w, &w.stranger, "abc123"), None),
            Ok(())
        );
        // A person on the team is told so, not stored a second time.
        for who in [&w.mate, &w.founder] {
            assert_eq!(w.verdict(&ask(&w, who, "abc123"), None), Err(ON_TEAM));
        }
        // The ask grants nothing else: the same stranger still cannot post an update, a goal or a task.
        let update = w.record(&w.stranger, &[&["update-part", "done", "Shipped"]]);
        assert_eq!(w.verdict(&update, None), Err(NOT_TEAM));
        assert_eq!(w.verdict(&w.task(&w.stranger), None), Err(NOT_TEAM));
        assert_eq!(
            w.verdict(&w.record(&w.stranger, &[&["goal", "g1"]]), None),
            Err(NOT_FOUNDER)
        );
    }

    #[test]
    fn an_ask_to_join_is_nothing_but_an_ask() {
        let w = World::new();
        let refused = |tags: &[&[&str]]| classify(&w.record(&w.stranger, tags)).unwrap_err();
        // Dressed as an update, a goal or an offer it is refused, so asking never lends a stranger a place.
        for other in [
            &["update-part", "done", "x"][..],
            &["goal", "g1"],
            &["help-offer", ID],
        ] {
            assert!(
                refused(&[&["l", JOIN_LABEL], &["join-ask", "abc"], other])
                    .contains("cannot also be anything else"),
                "{other:?}"
            );
        }
        assert!(refused(&[&["join-ask", "abc"]]).contains(JOIN_LABEL));
        assert!(refused(&[&["l", JOIN_LABEL], &["join-ask", ""]]).contains("short name"));
        assert!(refused(&[&["l", JOIN_LABEL], &["join-ask", "Has Space"]]).contains("short name"));
        assert!(
            refused(&[&["l", JOIN_LABEL], &["join-ask", &"a".repeat(33)]]).contains("short name")
        );
        assert!(
            refused(&[&["l", JOIN_LABEL], &["join-ask", "a"], &["join-ask", "b"]])
                .contains("only one `join-ask`")
        );
    }

    #[test]
    fn an_ask_to_join_is_small_and_names_only_the_founder() {
        let w = World::new();
        let ok = |event: &Event| classify(event).is_ok();
        let error = |event: &Event| classify(event).unwrap_err();
        // As the web app signs it.
        assert!(ok(&ask_with(
            &w,
            &[],
            r#"{"title":"Asked to join","body":""}"#
        )));
        // A body of any size beyond the cap is refused, even valid JSON (a stranger signs these for nothing).
        let big = format!(
            r#"{{"title":"Asked to join","body":"{}"}}"#,
            "x".repeat(250_000)
        );
        assert!(error(&ask_with(&w, &[], &big)).contains("bytes of content"));
        let just_over = format!(r#"{{"body":"{}"}}"#, "x".repeat(JOIN_CONTENT_MAX));
        assert!(error(&ask_with(&w, &[], &just_over)).contains("bytes of content"));
        let just_under = format!(r#"{{"body":"{}"}}"#, "x".repeat(JOIN_CONTENT_MAX - 12));
        assert!(ok(&ask_with(&w, &[], &just_under)));
        // The tags are held to a size too, so the bulk cannot move there.
        let fat = "y".repeat(JOIN_TAG_BYTES_MAX);
        assert!(error(&ask_with(&w, &[&["note", &fat]], "{}")).contains("tags"));
        let many: Vec<[&str; 2]> = (0..JOIN_TAGS_MAX).map(|_| ["note", "n"]).collect();
        let many: Vec<&[&str]> = many.iter().map(|t| t.as_slice()).collect();
        assert!(error(&ask_with(&w, &many, "{}")).contains("tags"));
        // The p tag is the project's founder, and only the founder: not nobody, not somebody else, not two.
        let other = w.stranger.public_key().to_hex();
        let founder = w.founder.public_key().to_hex();
        let no_p = with_body(
            &w,
            &w.stranger,
            &[&["l", JOIN_LABEL], &["join-ask", "abc123"]],
            "{}",
        );
        assert!(error(&no_p).contains("founder"));
        assert!(error(&ask_with(&w, &[&["p", &other]], "{}")).contains("founder"));
        let aimed = with_body(
            &w,
            &w.stranger,
            &[&["l", JOIN_LABEL], &["join-ask", "abc123"], &["p", &other]],
            "{}",
        );
        assert!(error(&aimed).contains("founder"));
        // Two p tags, even with the founder among them, would put the ask in another person's inbox.
        let twice = ask_with(&w, &[&["p", &founder]], "{}");
        assert!(error(&twice).contains("founder"));
    }

    #[test]
    fn only_the_founder_turns_an_ask_away() {
        let w = World::new();
        let asker = w.stranger.public_key().to_hex();
        let decline = |who: &Keys| w.record(who, &[&["l", JOIN_LABEL], &["join-decline", &asker]]);
        assert_eq!(w.verdict(&decline(&w.founder), None), Ok(()));
        // A team member, the person themselves and a stranger have no say.
        for who in [&w.mate, &w.stranger, &w.helper] {
            assert_eq!(w.verdict(&decline(who), None), Err(NOT_FOUNDER));
        }
        // Turning someone away is for a person, as accepting is.
        assert_eq!(
            w.verdict_agent(&decline(&w.founder), None),
            Err(AGENT_LIMIT)
        );
        let refused = |tags: &[&[&str]]| classify(&w.record(&w.founder, tags)).unwrap_err();
        assert!(refused(&[&["join-decline", "nobody"]]).contains("key of the person"));
        assert!(
            refused(&[&["join-decline", &asker], &["join-decline", &asker]])
                .contains("only one `join-decline`")
        );
        // It is no ask, and an ask is no decline.
        assert!(refused(&[
            &["l", JOIN_LABEL],
            &["join-ask", "abc"],
            &["join-decline", &asker]
        ])
        .contains("cannot also be anything else"));
    }

    /// A task open to anyone that the founder posts: no helper, and what it pays.
    fn open_task(w: &World, usd: &str) -> Event {
        w.record(
            &w.founder,
            &[
                &["l", "creaton-task"],
                &["task-part", "task"],
                &["task-what", "Draw the map"],
                &["task-usd", usd],
            ],
        )
    }

    /// The verdict on `event` naming the open `task`, with what its stored steps say.
    fn verdict_open(
        w: &World,
        event: &Event,
        task: &Event,
        takes: TakeFacts,
    ) -> Result<(), &'static str> {
        let requirement = classify(event).expect("readable").expect("a known family");
        let mut facts = task_facts(task).expect("a task");
        facts.takes = takes;
        decide(
            &requirement,
            &event.pubkey.to_hex(),
            &w.coordinate(),
            &w.team(),
            Some(&facts),
            &ConfirmFacts::none(),
            false,
        )
    }

    fn taken_by(who: &Keys) -> TakeFacts {
        TakeFacts {
            taker: Some(who.public_key().to_hex()),
            ..TakeFacts::default()
        }
    }

    #[test]
    fn a_task_open_to_anyone_says_what_it_pays_and_the_money_tags_stay_on_their_step() {
        let w = World::new();
        assert!(classify(&open_task(&w, "40")).is_ok());
        assert!(classify(&open_task(&w, "100000")).is_ok());
        for bad in ["0", "040", "100001", "12.5", "-3", "", "1e3"] {
            assert!(
                classify(&open_task(&w, bad))
                    .unwrap_err()
                    .contains("whole dollars"),
                "{bad}"
            );
        }
        // No helper and no dollars is neither a named task nor an open one.
        let neither = w.record(&w.founder, &[&["task-part", "task"], &["task-what", "x"]]);
        assert!(classify(&neither).unwrap_err().contains("task-usd"));
        let task = open_task(&w, "40");
        let id = task.id.to_hex();
        let take = |extra: &[&str]| {
            let named = ["task", id.as_str()];
            let mut tags: Vec<&[&str]> = vec![&["task-part", "take"], &named];
            tags.push(extra);
            w.record(&w.stranger, &tags)
        };
        assert!(classify(&take(&[
            "task-pay-to",
            "0x00000000000000000000000000000000000000aa"
        ]))
        .is_ok());
        assert!(classify(&take(&["task-pay-to", "0xabc"]))
            .unwrap_err()
            .contains("address"));
        // Each tag on its own step only.
        assert!(classify(&take(&["task-usd", "40"]))
            .unwrap_err()
            .contains("another step"));
        assert!(classify(&take(&["task-paid", &format!("0x{ID}")]))
            .unwrap_err()
            .contains("another step"));
        let confirm = |paid: &str| {
            w.record(
                &w.founder,
                &[
                    &["task-part", "confirm"],
                    &["task", &id],
                    &["task-paid", paid],
                ],
            )
        };
        assert!(classify(&confirm(&format!("0x{ID}"))).is_ok());
        assert!(classify(&confirm(ID)).unwrap_err().contains("transaction"));
        let twice = w.record(
            &w.founder,
            &[
                &["task-part", "task"],
                &["task-usd", "4"],
                &["task-usd", "5"],
            ],
        );
        assert!(classify(&twice)
            .unwrap_err()
            .contains("only one `task-usd`"));
        // A take is small, like an ask to join.
        let big = with_body(
            &w,
            &w.stranger,
            &[&["task-part", "take"], &["task", &id]],
            &format!("\"{}\"", "x".repeat(JOIN_CONTENT_MAX)),
        );
        assert!(classify(&big)
            .unwrap_err()
            .contains("a take carries at most"));
    }

    #[test]
    fn anyone_outside_the_team_takes_an_open_task_once_and_then_does_its_steps() {
        let w = World::new();
        let task = open_task(&w, "40");
        let take = w.step(&w.stranger, "take", &task);
        assert_eq!(verdict_open(&w, &take, &task, TakeFacts::default()), Ok(()));
        // The team names a helper instead; nobody on it takes.
        for who in [&w.founder, &w.mate] {
            assert_eq!(
                verdict_open(&w, &w.step(who, "take", &task), &task, TakeFacts::default()),
                Err(TEAM_TAKES)
            );
        }
        // Taken, stopped, or given up by this person before: no second take.
        let other = Keys::generate();
        let late = w.step(&other, "take", &task);
        assert_eq!(
            verdict_open(&w, &late, &task, taken_by(&w.stranger)),
            Err(TAKEN)
        );
        let left = TakeFacts {
            signer_left: true,
            ..TakeFacts::default()
        };
        assert_eq!(verdict_open(&w, &late, &task, left), Err(TAKEN));
        let cancelled = TakeFacts {
            cancelled: true,
            ..TakeFacts::default()
        };
        assert_eq!(verdict_open(&w, &late, &task, cancelled), Err(TAKEN));
        // A task that names its helper is not open.
        let named = w.task(&w.founder);
        assert_eq!(
            verdict_open(
                &w,
                &w.step(&w.stranger, "take", &named),
                &named,
                TakeFacts::default()
            ),
            Err(NOT_OPEN)
        );
        // The taker is the helper: they hand in; nobody else does, and before a take nobody does.
        for part in ["evidence", "more-time", "give-up", "accept"] {
            assert_eq!(
                verdict_open(
                    &w,
                    &w.step(&w.stranger, part, &task),
                    &task,
                    taken_by(&w.stranger)
                ),
                Ok(()),
                "{part}"
            );
            assert_eq!(
                verdict_open(
                    &w,
                    &w.step(&other, part, &task),
                    &task,
                    taken_by(&w.stranger)
                ),
                Err(NOT_HELPER),
                "{part}"
            );
            assert_eq!(
                verdict_open(
                    &w,
                    &w.step(&w.stranger, part, &task),
                    &task,
                    TakeFacts::default()
                ),
                Err(NOT_HELPER),
                "{part}"
            );
        }
        // The team confirms the taker's work; the taker never does.
        let confirm = |who: &Keys| w.step(who, "confirm", &task);
        assert_eq!(
            verdict_open(&w, &confirm(&w.founder), &task, taken_by(&w.stranger)),
            Ok(())
        );
        assert_eq!(
            verdict_open(&w, &confirm(&w.stranger), &task, taken_by(&w.stranger)),
            Err(NOT_TEAM)
        );
        // A team member who took nothing confirms a stranger's work, and the founder's own taken work is the founder's.
        assert_eq!(
            verdict_open(&w, &confirm(&w.mate), &task, taken_by(&w.stranger)),
            Ok(())
        );
    }

    #[test]
    fn the_first_take_that_was_not_given_up_is_the_tasks() {
        let (a, b, c) = ("a".repeat(64), "b".repeat(64), "c".repeat(64));
        let step = |who: &str, at: u64, id: &str, part: TaskPart| {
            (who.to_string(), at, id.to_string(), part)
        };
        // Earliest by time, then by id; whatever order the server read them in.
        let steps = vec![
            step(&b, 20, "02", TaskPart::Take),
            step(&a, 10, "09", TaskPart::Take),
            step(&c, 10, "01", TaskPart::Take),
        ];
        assert_eq!(read_takes(&steps, &a).taker, Some(c.clone()));
        // Whoever gave up is out, for good; the next one has it.
        let mut gave_up = steps.clone();
        gave_up.push(step(&c, 30, "03", TaskPart::GiveUp));
        let facts = read_takes(&gave_up, &c);
        assert_eq!(facts.taker, Some(a.clone()));
        assert!(facts.signer_left);
        assert!(!facts.cancelled);
        assert!(read_takes(&[step(&a, 1, "0", TaskPart::Cancel)], &b).cancelled);
        assert_eq!(read_takes(&[], &a), TakeFacts::default());
    }

    const WALLET_A: &str = "0x00000000000000000000000000000000000000aa";

    #[test]
    fn a_room_mute_and_a_season_entry_are_the_teams_and_a_season_removal_is_not() {
        let w = World::new();
        let (team, person) = (w.team(), w.helper.public_key().to_hex());
        let mute = w.record(
            &w.founder,
            &[
                &["room-mute", &person],
                &["room-mute-wallet", WALLET_A],
                &["expiration", "1900000000"],
            ],
        );
        let req = classify(&mute).expect("reads").expect("a family");
        assert!(req.team && !req.founder);
        assert_eq!(
            req.room_mute,
            Some(RoomMute {
                person: person.clone(),
                until: 1_900_000_000,
                wallets: vec![
                    crate::handlers::wallet_binding::parse_wallet(WALLET_A).expect("a wallet")
                ],
            })
        );
        let confirm = ConfirmFacts::none();
        let decide_for = |req: &Requirement, who: &Keys| {
            decide(
                req,
                &who.public_key().to_hex(),
                &w.coordinate(),
                &team,
                None,
                &confirm,
                false,
            )
        };
        assert_eq!(decide_for(&req, &w.founder), Ok(()));
        assert_eq!(decide_for(&req, &w.mate), Ok(()));
        assert_eq!(decide_for(&req, &w.stranger), Err(NOT_TEAM));

        for family in ["season-entry", "season-leave"] {
            let record = w.record(&w.mate, &[&["t", "season-2"], &[family, "2"]]);
            let req = classify(&record).expect("reads").expect("a family");
            assert!(req.team, "{family}");
            assert_eq!(decide_for(&req, &w.mate), Ok(()), "{family}");
            assert_eq!(decide_for(&req, &w.stranger), Err(NOT_TEAM), "{family}");
        }
        // A removal is judged by the operator test of its own rule, not by the team.
        let removal = w.record(&w.stranger, &[&["t", "season-2"], &["season-remove", "2"]]);
        let req = classify(&removal).expect("reads").expect("a family");
        assert!(!req.team && !req.founder);
        assert_eq!(decide_for(&req, &w.stranger), Ok(()));
    }

    #[test]
    fn a_room_mute_or_a_season_record_is_nothing_else_and_holds_to_its_shape() {
        let w = World::new();
        let person = w.helper.public_key().to_hex();
        let ok_mute: Vec<Vec<&str>> =
            vec![vec!["room-mute", &person], vec!["expiration", "1900000000"]];
        let with = |extra: &[&[&str]]| {
            let mut tags: Vec<&[&str]> = ok_mute.iter().map(Vec::as_slice).collect();
            tags.extend_from_slice(extra);
            classify(&w.record(&w.founder, &tags))
        };
        assert!(with(&[]).expect("reads").is_some());
        // Mixed with another family.
        assert!(with(&[&["update-part", "done", "x"]]).is_err());
        assert!(with(&[&["goal", "g1"]]).is_err());
        assert!(with(&[&["t", "season-1"], &["season-entry", "1"]]).is_err());
        // Two people, a wallet that is not an address, nine wallets, a second end, no end, an end that is not a number.
        assert!(with(&[&["room-mute", &person]]).is_err());
        assert!(with(&[&["room-mute-wallet", "0xAA"]]).is_err());
        let nine: Vec<Vec<String>> = (0..9)
            .map(|n| vec!["room-mute-wallet".to_string(), format!("0x{n:040x}")])
            .collect();
        let nine: Vec<Vec<&str>> = nine
            .iter()
            .map(|t| t.iter().map(String::as_str).collect())
            .collect();
        let nine: Vec<&[&str]> = nine.iter().map(Vec::as_slice).collect();
        assert!(with(&nine).is_err());
        assert!(with(&[&["expiration", "1900000001"]]).is_err());
        assert!(classify(&w.record(&w.founder, &[&["room-mute", &person]])).is_err());
        assert!(classify(&w.record(
            &w.founder,
            &[&["room-mute", &person], &["expiration", "01"]]
        ))
        .is_err());
        assert!(
            classify(&w.record(&w.founder, &[&["room-mute", "short"], &["expiration", "1"]]))
                .is_err()
        );
        // A season record carries its one family and its one topic.
        assert!(classify(&w.record(&w.founder, &[&["season-entry", "1"]])).is_err());
        assert!(classify(&w.record(
            &w.founder,
            &[&["t", "season-1"], &["season-entry", "1"], &["goal", "g"]]
        ))
        .is_err());
    }
}
