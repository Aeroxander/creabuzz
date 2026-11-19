//! The AI manager's one route: `POST /llm/manager/draft` (docs/MANAGEMENT-LAYER.md sections 5 and 9).
//!
//! The founder (or a manager agent the founder runs, see `agent_label`) asks for a draft of three things: the one thing
//! to do this week, what to leave aside, and "What happened" for the weekly update. Never "What's next". The answer is
//! for the founder only: it is this HTTP response (or a direct message the founder's own agent sends), never a public
//! record, and nothing here signs, posts or pays anything.
//!
//! The request names the project and the items of its record to read (by id: the server loads them and keeps only the
//! project's own records from its team), with the founder's answers and the brain files `facts.md`, `decisions.md`
//! and `voice.md` as text. Everything is data to the model, and the reply goes through the honesty envelope
//! ([`envelope`]) before anyone sees it. What it may cost is [`cost`].
//!
//! Refusals are a status with a plain-words `error` and a stable `code`, as the gateway's are:
//! `ai_manager_founder_only`, `ai_manager_post_weekly`, `ai_manager_own_key`, `ai_manager_platform_cap`,
//! `ai_manager_unmetered`, `ai_unavailable`, and the gateway's own `ai_too_fast`, `ai_limit_account` and
//! `ai_limit_community`.

pub(crate) mod cost;
pub(crate) mod envelope;
pub(crate) mod model;
#[cfg(test)]
mod planted_eval_tests;
#[cfg(test)]
mod review_tests;
#[cfg(test)]
mod route_postgres_tests;

use std::collections::HashSet;
use std::sync::Arc;

use axum::{
    body::Bytes,
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::Json,
};
use buzz_core::kind::{KIND_LAUNCH_RECORD, KIND_LAUNCH_UPDATE};
use nostr::Event;

use self::envelope::{Inputs, AI_SERVICE, CAN_BE_WRONG, LOOP_VERSION};
use self::model::{HostedModel, ManagerModel};
use super::llm_gateway::{enforce_daily_caps, enforce_llm_rate_limit, refusal};
use super::{api_error, bridge, relay_members};
use crate::handlers::agent_label::AgentRole;
use crate::state::AppState;

pub(crate) const MANAGER_DRAFT_PATH: &str = "/llm/manager/draft";

/// The largest request: ids, a few answers and three small files.
const MAX_REQUEST_BYTES: usize = 64 * 1024;
/// The longest brain file read, in bytes.
const FILE_MAX: usize = 8 * 1024;
/// The longest founder's answer read, in characters.
const ANSWER_MAX: usize = 1_000;
/// Weekly hosted drafts per project when the operator set none (`BUZZ_MANAGER_CALLS_PER_WEEK`).
pub(crate) const DEFAULT_CALLS_PER_WEEK: u32 = 10;

/// The words said when the AI service gives nothing usable (the web app's words, kept the same).
const UNAVAILABLE: &str = "The AI service didn't answer. Write it yourself, or try again later.";

type Refusal = (StatusCode, Json<serde_json::Value>);

#[derive(serde::Deserialize)]
struct DraftRequest {
    /// The project's address, `37001:<founder>:<id>`.
    project: String,
    /// Ids of the project's records to read (kind 47003).
    #[serde(default)]
    items: Vec<String>,
    #[serde(default)]
    answers: Vec<String>,
    #[serde(default)]
    facts: String,
    #[serde(default)]
    decisions: String,
    #[serde(default)]
    voice: String,
}

/// A lookup that failed: a server fault, said without its insides.
fn failed(what: &str, error: impl std::fmt::Display) -> Refusal {
    tracing::warn!("manager: {what}: {error}");
    api_error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "the server could not read what it needs",
    )
}

fn refuse(status: StatusCode, code: &str, words: &str) -> Refusal {
    refusal(status, code, words.to_string(), 0)
}

/// The project's founder and team, and its chain key, from its record.
struct ProjectFacts {
    founder: String,
    team: HashSet<String>,
    started_at: u64,
    chain_key: Option<[u8; 32]>,
}

fn project_facts(record: &Event) -> ProjectFacts {
    let founder = record.pubkey.to_hex();
    let mut team: HashSet<String> = HashSet::from([founder.clone()]);
    let mut chain_key = None;
    for tag in record.tags.iter() {
        match tag.as_slice() {
            [name, key, _role, ..] if name == "team" => {
                team.insert(key.clone());
            }
            [name, value, ..] if name == "chain-key" => {
                chain_key = value
                    .strip_prefix("0x")
                    .and_then(|hex| hex::decode(hex).ok())
                    .and_then(|bytes| <[u8; 32]>::try_from(bytes).ok());
            }
            _ => {}
        }
    }
    ProjectFacts {
        founder,
        team,
        started_at: record.created_at.as_secs(),
        chain_key,
    }
}

/// One record of the project as the manager is shown it: its goals, promises, answers, update parts, help asked and
/// tasks, in words, one part to a line (the envelope reads each line as a source of its own and tells what happened
/// from what was planned by how it opens). `None` when it says nothing the manager reads.
pub(crate) fn item_text(event: &Event) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    let mut confirm = false;
    for tag in event.tags.iter() {
        let fields = tag.as_slice();
        let field = |i: usize| fields.get(i).map(String::as_str).unwrap_or("");
        match field(0) {
            "goal-text" => parts.push(format!("Goal: {}", field(1))),
            "promise" => parts.push(format!("Promise: {}", field(2))),
            "promise-mark" => parts.push(
                format!("A promise marked {}. {}", field(2), field(3))
                    .trim()
                    .to_string(),
            ),
            "update-part" => parts.push(match field(1) {
                "done" => format!("What happened: {}", field(2)),
                "next" => format!("What was next then: {}", field(2)),
                "line" => format!("In one line: {}", field(2)),
                _ => field(2).to_string(),
            }),
            "help-needed" => parts.push(format!("Help needed: {}", field(1))),
            "task-what" => parts.push(format!("Task: {}", field(1))),
            "task-part" if field(1) == "confirm" => confirm = true,
            _ => {}
        }
    }
    if confirm {
        parts.push("Work on a task was accepted.".into());
    }
    if parts.is_empty() {
        let body: serde_json::Value = serde_json::from_str(event.content.as_str()).ok()?;
        let title = body
            .get("title")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let text = body
            .get("body")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let words = format!("{title}. {text}");
        let words = words.trim_matches(|c: char| c == '.' || c.is_whitespace());
        if words.is_empty() {
            return None;
        }
        parts.push(format!("Update: {words}"));
    }
    let text = parts
        .into_iter()
        .filter(|p| !p.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    (!text.is_empty()).then_some(text)
}

/// The draft route. See the module documentation.
pub async fn draft(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<serde_json::Value>, Refusal> {
    let Some(llm) = state.config.llm.as_ref() else {
        return Err(api_error(
            StatusCode::NOT_FOUND,
            "the AI service is not set up on this server",
        ));
    };
    if body.len() > MAX_REQUEST_BYTES {
        return Err(api_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "this request is too large",
        ));
    }
    let raw_host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let tenant = crate::tenant::bind_community(&state.db, raw_host)
        .await
        .map_err(|_| {
            api_error(
                StatusCode::NOT_FOUND,
                "relay: no community is configured for this host",
            )
        })?;
    let expected_url =
        bridge::nip98_expected_url(&state.config.relay_url, &tenant, MANAGER_DRAFT_PATH);
    let bridge::VerifiedBridgeAuth {
        pubkey,
        event_id_bytes,
        signed_created_at,
    } = bridge::verify_bridge_auth_with_options(
        &headers,
        "POST",
        &expected_url,
        Some(&body),
        true,
        true,
    )?;
    bridge::enforce_http_admission(&state, &tenant, &pubkey).await?;
    bridge::check_nip98_replay(&state, &tenant, event_id_bytes).await?;
    relay_members::enforce_relay_membership(
        &state,
        tenant.community(),
        &pubkey.to_bytes(),
        relay_members::extract_auth_tag_header(&headers),
        signed_created_at,
    )
    .await?;
    let request: DraftRequest = serde_json::from_slice(&body).map_err(|_| {
        api_error(
            StatusCode::BAD_REQUEST,
            "the request must be JSON with a `project`",
        )
    })?;
    let community = tenant.community();

    // The project, and who may ask about it.
    let mut segments = request.project.splitn(3, ':');
    let (Some(kind), Some(author), Some(d)) = (segments.next(), segments.next(), segments.next())
    else {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "`project` must be 37001:<founder>:<id>",
        ));
    };
    let author_bytes = hex::decode(author)
        .ok()
        .filter(|bytes| bytes.len() == 32 && kind == KIND_LAUNCH_RECORD.to_string());
    let Some(author_bytes) = author_bytes else {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "`project` must be 37001:<founder>:<id>",
        ));
    };
    // The project's one address, whatever the case the caller typed the founder's key in: the weekly count, the
    // record's own `a` tags and the founder's updates are all found by it.
    let coordinate = format!("{KIND_LAUNCH_RECORD}:{}:{d}", hex::encode(&author_bytes));
    let record = state
        .db
        .query_events(&buzz_db::EventQuery {
            kinds: Some(vec![KIND_LAUNCH_RECORD as i32]),
            pubkey: Some(author_bytes.clone()),
            d_tag: Some(d.to_string()),
            global_only: true,
            limit: Some(1),
            ..buzz_db::EventQuery::for_community(community)
        })
        .await
        .map_err(|e| failed("reading the project", e))?
        .into_iter()
        .next()
        .ok_or_else(|| api_error(StatusCode::NOT_FOUND, "this project is not on this server"))?;
    let project = project_facts(&record.event);
    let caller = pubkey.to_hex();
    let allowed = if caller == project.founder {
        true
    } else {
        // A manager agent the founder runs, and no other agent.
        let runs = state
            .db
            .is_agent_owner(community, &pubkey.to_bytes(), &author_bytes)
            .await
            .map_err(|e| failed("checking who runs the caller", e))?;
        runs && crate::handlers::task_takes::stored_role(&state, community, &pubkey.to_bytes())
            .await
            .map_err(|_| failed("reading the caller's profile", "lookup failed"))?
            == Some(AgentRole::Manager)
    };
    if !allowed {
        return Err(refuse(
            StatusCode::FORBIDDEN,
            "ai_manager_founder_only",
            "Only the project's founder, or the manager agent the founder runs, can ask the manager for a draft.",
        ));
    }

    // The money, cheapest refusals first: prices set, a first look at the platform's cap, the founder's phase, the
    // per-minute limit. Nothing shared is counted yet.
    let now = chrono::Utc::now();
    let pool = state.db.pool();
    let worst = model::worst_cost(llm, MAX_REQUEST_BYTES).ok_or_else(|| {
        refuse(
            StatusCode::SERVICE_UNAVAILABLE,
            "ai_manager_unmetered",
            "The hosted manager is off on this server until its AI prices are set. Run it as your own agent with your \
             own AI key, or write this yourself.",
        )
    })?;
    let platform_cap = || {
        refuse(
            StatusCode::TOO_MANY_REQUESTS,
            "ai_manager_platform_cap",
            "The hosted manager has used what this server sets aside for it from its fees. Run it as your own agent \
             with your own AI key, or write this yourself.",
        )
    };
    let reader = state
        .config
        .chain_reader
        .as_ref()
        .map(|reader| reader.reader_id());
    let fees = cost::platform_fees(pool, reader.as_deref(), now)
        .await
        .map_err(|e| failed("reading the platform's fees", e))?;
    // Fees in play dollars count for nothing; the operator's floor, when set, is the least the cap allows.
    let fees = cost::cap_base(
        fees,
        crate::chain_reader::play_money(),
        llm.manager_floor_mc(),
    );
    let ceiling = llm.manager_ceiling_mc();
    let spent = cost::platform_spent(pool, community, now)
        .await
        .map_err(|e| failed("reading the manager's spend", e))?;
    if !cost::within_platform_cap(spent, fees, u128::from(worst), ceiling) {
        return Err(platform_cap());
    }
    // The project's first backing counts only when the chain's own launch log ties the record's chain key to this very
    // record: a founder cannot name another project's key and borrow its money.
    let backed = match project.chain_key {
        Some(key) => cost::first_backing(
            pool,
            reader.as_deref(),
            &key,
            &cost::project_id(&coordinate),
        )
        .await
        .map_err(|e| failed("reading the project's backing", e))?,
        None => false,
    };
    if !backed {
        // A project is new for 14 days from the earlier of its record's date and the first time it asked: the record
        // is replaceable, so re-saving it must not make the project new again.
        let first_seen = cost::first_seen(pool, community, &coordinate, now)
            .await
            .map_err(|e| failed("noting when the project first asked", e))?;
        let began = i64::try_from(project.started_at)
            .unwrap_or(i64::MAX)
            .min(first_seen);
        let young = now.timestamp() - began < cost::POSTED_WITHIN_DAYS * 86_400;
        if !young && !posted_weekly(&state, community, &record.event, now).await? {
            return Err(refuse(
                StatusCode::FORBIDDEN,
                "ai_manager_post_weekly",
                "The manager helps while you post your weekly update. Post this week's update first, then ask again.",
            ));
        }
    }
    enforce_llm_rate_limit(&state, &tenant, &pubkey, llm.rate_per_min()).await?;

    // What is read: the project's own records from its team, and the founder's text.
    let mut items = Vec::new();
    let mut not_read = 0usize;
    for id in request.items.iter().take(envelope::ITEMS_MAX) {
        let Some(id_bytes) = hex::decode(id).ok().filter(|b| b.len() == 32) else {
            not_read += 1;
            continue;
        };
        let stored = state
            .db
            .get_event_by_id(community, &id_bytes)
            .await
            .map_err(|e| failed("reading a record", e))?;
        let text = stored.as_ref().and_then(|stored| {
            let event = &stored.event;
            let own = u32::from(event.kind.as_u16()) == KIND_LAUNCH_UPDATE
                && project.team.contains(&event.pubkey.to_hex())
                && event.tags.iter().any(|t| {
                    t.as_slice().first().map(String::as_str) == Some("a")
                        && t.as_slice().get(1) == Some(&coordinate)
                });
            own.then(|| item_text(event)).flatten()
        });
        match text {
            Some(text) => items.push((id.clone(), text)),
            None => not_read += 1,
        }
    }
    not_read += request.items.len().saturating_sub(envelope::ITEMS_MAX);
    let inputs = Inputs {
        items,
        answers: request
            .answers
            .iter()
            .map(|a| a.chars().take(ANSWER_MAX).collect())
            .collect(),
        facts: request.facts.chars().take(FILE_MAX).collect(),
        decisions: request.decisions.chars().take(FILE_MAX).collect(),
        voice: request.voice.chars().take(FILE_MAX).collect(),
    };
    let Some(client) = state.llm_http_client.as_ref() else {
        return Err(refuse(
            StatusCode::SERVICE_UNAVAILABLE,
            "ai_unavailable",
            UNAVAILABLE,
        ));
    };

    // The shared counts, taken only now, and the shared daily pool last: a refusal for the project's week or the
    // platform's cap must never use up the account's or the community's AI calls. Each later refusal gives back what
    // an earlier step took for this draft.
    let per_week = llm.manager_calls_per_week();
    if !cost::take_weekly_call(pool, community, &coordinate, per_week, now)
        .await
        .map_err(|e| failed("counting the project's drafts", e))?
    {
        return Err(refuse(
            StatusCode::TOO_MANY_REQUESTS,
            "ai_manager_own_key",
            &format!(
                "This project has had this week's {per_week} hosted drafts. For more, run the manager as your own \
                 agent with your own AI key, or write this yourself."
            ),
        ));
    }
    let give_back_the_call = || async {
        // Best effort on purpose: if this fails the project is one draft short this week, never one over.
        if let Err(error) = cost::return_weekly_call(pool, community, &coordinate, now).await {
            tracing::warn!("manager: a weekly draft could not be given back: {error}");
        }
    };
    match cost::reserve_platform_spend(pool, community, worst, fees, ceiling, now).await {
        Ok(true) => {}
        Ok(false) => {
            give_back_the_call().await;
            return Err(platform_cap());
        }
        Err(error) => {
            give_back_the_call().await;
            return Err(failed("setting aside the manager's spend", error));
        }
    }
    if let Err(refused) = enforce_daily_caps(
        &state,
        &tenant,
        &caller,
        llm.max_calls_per_day(),
        llm.max_calls_per_day_total(),
    )
    .await
    {
        give_back_the_call().await;
        // Nothing was called: the set-aside spend goes back too. If this is lost the count only errs high.
        if let Err(error) = cost::settle_platform_spend(pool, community, worst, 0, now).await {
            tracing::warn!("manager: the spend set aside could not be given back: {error}");
        }
        return Err(refused);
    }

    let hosted = HostedModel {
        client,
        config: llm,
    };
    let answer = run(&hosted, &inputs, not_read).await;
    // What was set aside becomes what the call cost. If this correction is lost the worst cost stays counted, so the
    // platform's count can only err high; the founder still gets the draft that was paid for.
    if let Err(error) =
        cost::settle_platform_spend(pool, community, worst, answer.cost_mc.unwrap_or(0), now).await
    {
        tracing::warn!(
            "manager: the spend set aside was not corrected and stays at its worst: {error}"
        );
    }
    if answer.cost_mc.is_none() {
        // The AI service never answered: nothing was paid, so the project keeps its draft for the week.
        give_back_the_call().await;
    }
    answer
        .body
        .map(Json)
        .ok_or_else(|| refuse(StatusCode::BAD_GATEWAY, "ai_unavailable", UNAVAILABLE))
}

/// One draft, with the model behind the seam: the prompt, the call, the envelope, the answer's words.
pub(crate) struct Answer {
    pub(crate) body: Option<serde_json::Value>,
    pub(crate) cost_mc: Option<u64>,
}

pub(crate) async fn run(model: &dyn ManagerModel, inputs: &Inputs, not_read: usize) -> Answer {
    let prepared = envelope::prepare(inputs);
    let (system, user) = envelope::prompt(&prepared);
    let Ok(reply) = model.draft(&system, &user).await else {
        return Answer {
            body: None,
            cost_mc: None,
        };
    };
    let cost_mc = Some(reply.cost_mc);
    let Some(draft) = envelope::read_reply(&reply.text, &prepared) else {
        return Answer {
            body: None,
            cost_mc,
        };
    };
    let body = serde_json::json!({
        "schema": "creaton.manager.v1",
        "loop_version": LOOP_VERSION,
        "read": envelope::read_words(&prepared.counts, prepared.set_aside.len()),
        "counts": prepared.counts,
        "not_read": not_read,
        "set_aside": prepared.set_aside,
        "this_week": draft.this_week,
        "not_doing": draft.not_doing,
        "what_happened": draft.what_happened,
        "needs_a_person": draft.needs_a_person,
        "dropped": draft.dropped,
        "blocked": draft.blocked,
        "can_be_wrong": CAN_BE_WRONG,
        "notice": AI_SERVICE,
    });
    Answer {
        body: Some(body),
        cost_mc,
    }
}

/// Whether the founder posted a weekly update on this project in the last [`cost::POSTED_WITHIN_DAYS`] days.
async fn posted_weekly(
    state: &Arc<AppState>,
    community: buzz_core::tenant::CommunityId,
    record: &Event,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<bool, Refusal> {
    let coordinate = format!(
        "{KIND_LAUNCH_RECORD}:{}:{}",
        record.pubkey.to_hex(),
        record
            .tags
            .iter()
            .find_map(|t| (t.as_slice().first().map(String::as_str) == Some("d"))
                .then(|| t.as_slice().get(1).cloned())
                .flatten())
            .unwrap_or_default()
    );
    let recent = state
        .db
        .query_events(&buzz_db::EventQuery {
            kinds: Some(vec![KIND_LAUNCH_UPDATE as i32]),
            pubkey: Some(record.pubkey.to_bytes().to_vec()),
            tag_filters: vec![("a".to_string(), vec![coordinate])],
            since: Some(now - chrono::Duration::days(cost::POSTED_WITHIN_DAYS)),
            global_only: true,
            limit: Some(50),
            ..buzz_db::EventQuery::for_community(community)
        })
        .await
        .map_err(|e| failed("reading the founder's updates", e))?;
    Ok(recent.iter().any(|stored| {
        stored.event.tags.iter().any(|t| {
            matches!(
                t.as_slice().first().map(String::as_str),
                Some("update-kind" | "update-part")
            )
        })
    }))
}
