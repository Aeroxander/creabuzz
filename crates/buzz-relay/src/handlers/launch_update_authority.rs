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
//! | `task-part` = task, send-back, grant, cancel      | the founder or a team member         |
//! | `task-part` = confirm                             | founder or team, never the helper    |
//! | `task-part` = accept, evidence, more-time, give-up| the helper the task names            |
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
}

impl TaskPart {
    fn parse(value: &str) -> Option<Self> {
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
}

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
            // The first of each, as the readers take it.
            "task" if task_id.is_none() => task_id = Some(value),
            "task-helper" if helper.is_none() => helper = Some(value),
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
                if helper.and_then(id_bytes).is_none() {
                    return Err("a task must name its helper in a `task-helper` tag".into());
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
    }))
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

    fn is_founder(&self, who: &str) -> bool {
        self.founder == who
    }

    fn has(&self, who: &str) -> bool {
        self.is_founder(who) || self.members.contains(who)
    }
}

/// What a stored task record says: its project and its helper.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct TaskFacts {
    /// The project the task names in its `a` tag.
    pub(crate) coordinate: String,
    /// The helper the task is with (`task-helper`).
    pub(crate) helper: String,
}

/// Read a stored event as a task record. `None` when it is not one: another
/// kind, another step, or no helper.
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
        helper: first("task-helper")?,
    })
}

/// Decide whether `signer` may post a record with these requirements on the
/// project `coordinate`.
///
/// `task` is the stored task a step names (`None` when the server does not
/// hold a task record under that id). `linked_to_helper` says the signer runs
/// the task's helper, or is run by it, in the relay's agent-owner records.
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
    linked_to_helper: bool,
    signer_is_agent: bool,
) -> Result<(), &'static str> {
    decide_by_place(
        requirement,
        signer,
        coordinate,
        team,
        task,
        linked_to_helper,
    )?;
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
    linked_to_helper: bool,
) -> Result<(), &'static str> {
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
    if part.is_helpers() {
        return if task.helper == signer {
            Ok(())
        } else {
            Err(NOT_HELPER)
        };
    }
    if !team.has(signer) {
        return Err(NOT_TEAM);
    }
    if part == TaskPart::Confirm && (task.helper == signer || linked_to_helper) {
        return Err(OWN_WORK);
    }
    Ok(())
}

fn internal(what: &str, error: impl std::fmt::Display) -> IngestError {
    IngestError::Internal(format!("error: db error {what}: {error}"))
}

/// Refuse a kind 47003 record whose family needs the founder, the team or a
/// task's helper when its signer is not that party.
///
/// Runs after the envelope check, so the record has exactly one well-formed
/// `a` tag. A lookup that fails is a server fault and refuses the write: an
/// outage never lets a record past the check.
pub(crate) async fn enforce_launch_update_authority(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    event: &Event,
) -> Result<(), IngestError> {
    let Some(requirement) =
        classify(event).map_err(|e| IngestError::Rejected(format!("invalid: {e}")))?
    else {
        return Ok(());
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
    let mut task = None;
    let mut linked_to_helper = false;
    if let Some((part, Some(task_id))) = requirement.step {
        task = state
            .db
            .get_event_by_id_for_event_write(community, &task_id)
            .await
            .map_err(|e| internal("reading the task", e))?
            .and_then(|stored| task_facts(&stored.event));
        if let (TaskPart::Confirm, Some(helper)) = (
            part,
            task.as_ref().and_then(|facts| id_bytes(&facts.helper)),
        ) {
            let signer_bytes = event.pubkey.to_bytes();
            if helper != signer_bytes {
                linked_to_helper = state
                    .db
                    .is_agent_owner(community, &helper, &signer_bytes)
                    .await
                    .map_err(|e| internal("checking who runs the helper", e))?
                    || state
                        .db
                        .is_agent_owner(community, &signer_bytes, &helper)
                        .await
                        .map_err(|e| internal("checking who runs the signer", e))?;
            }
        }
    }

    // Only a record that needs a person asks whether its signer is an agent.
    let signer_is_agent = if requirement.needs_a_person() {
        state
            .db
            .get_agent_channel_policy(community, &event.pubkey.to_bytes())
            .await
            .map_err(|e| internal("checking whether the signer is an agent account", e))?
            .is_some_and(|(_, owner)| owner.is_some())
    } else {
        false
    };

    decide(
        &requirement,
        &signer,
        &coordinate,
        &team,
        task.as_ref(),
        linked_to_helper,
        signer_is_agent,
    )
    .map_err(|reason| {
        if reason.starts_with("restricted:") {
            IngestError::AuthFailed(reason.into())
        } else {
            IngestError::Rejected(reason.into())
        }
    })
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
            let requirement = classify(event).expect("readable").expect("a known family");
            let facts = task.and_then(task_facts);
            decide(
                &requirement,
                &event.pubkey.to_hex(),
                &self.coordinate(),
                &self.team(),
                facts.as_ref(),
                linked,
                agent,
            )
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
}
