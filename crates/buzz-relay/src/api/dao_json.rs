//! ERC-4824 `dao.json` + `governance.md` (OA.md Phase 2).
//!
//! `GET /dao.json` (and `GET /{community}/dao.json`) serves the tenant's
//! ERC-4824 DAO document as `application/ld+json` — the pure projection of
//! the signed event graph (`buzz_core::erc4824`), recomputable by anyone who
//! can query the same events (OA.md section 4: onchain `daoURI` is the
//! INDEX; this is the PAYLOAD).
//!
//! `GET /governance.md` serves the community charter — the social-license
//! flatfile ERC-4824's `governanceURI` points at (`docs/aos/ao-survey.md`
//! section 6: it must answer BOTH audiences — the public that never
//! consented, and agents asking what they may do here). The charter is the
//! wiki page `meta/governance.md` (or root-space `governance.md`), newest
//! wins; absent -> 404, never a fake charter.
//!
//! Tenant discipline mirrors NIP-05: the community binds from the request
//! Host; a path community that disagrees with the bound tenant 404s (no
//! cross-tenant peeking, never a default tenant).

use std::collections::BTreeMap;
use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use buzz_core::erc4824::{document_bytes, Activity, ActivityRef, Call, ContractEntry, Member, OrgGraph, Proposal};
use buzz_core::kind::{KIND_LAUNCH_PROPOSAL, KIND_LAUNCH_RECEIPT, KIND_ORG_NODE, KIND_WIKI_PAGE};
use buzz_core::tenant::CommunityId;
use buzz_core::StoredEvent;

use crate::state::AppState;

/// The two accepted `d` tags for the charter page (NIP-33 pushdown).
const GOVERNANCE_SLUGS: [&str; 2] = ["meta/governance.md", "governance.md"];

/// Assemble the org graph from the tenant's signed events. PURE: the same
/// events always yield the same graph (sorts make the order deterministic);
/// only present values are populated — everything else is omitted upstream
/// by the projection ("removed, never null").
pub fn assemble_graph(events: &[StoredEvent]) -> OrgGraph {
    let mut members: BTreeMap<String, Member> = BTreeMap::new();
    let mut proposals: BTreeMap<String, Proposal> = BTreeMap::new();
    let mut activities: BTreeMap<String, Activity> = BTreeMap::new();
    let mut contracts: Vec<ContractEntry> = Vec::new();
    let mut name = String::new();
    let mut bound = false;
    let mut extensions: BTreeMap<String, serde_json::Value> = BTreeMap::new();

    for stored in events {
        let event = &stored.event;
        if event.kind.as_u16() != KIND_ORG_NODE as u16 {
            continue;
        }
        let body: serde_json::Value =
            serde_json::from_str(&event.content).unwrap_or(serde_json::Value::Null);
        if name.is_empty() {
            if let Some(n) = body.get("name").and_then(|v| v.as_str()) {
                name = n.to_owned();
            }
        }
        for key in ["holders", "agentSeats"] {
            if let Some(list) = body.get(key).and_then(|v| v.as_array()) {
                for who in list {
                    if let Some(hex) = who.as_str() {
                        members.entry(hex.to_owned()).or_insert_with(|| Member::nostr(hex));
                    }
                }
            }
        }
        if let Some(onchain) = body.get("onchain") {
            // Lowercase hex in CAIP-10 ids (ERC-8257's commitment rule:
            // consumers reject, never silently fix — so we normalize at the
            // one place ids are born).
            let chain = onchain
                .get("chain")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            let dao = onchain
                .get("dao")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if !chain.is_empty() && !dao.is_empty() {
                bound = true;
                // OAv2 §4.8: name WHICH legal wrapper — never just "a
                // wrapper exists"; `none` is a legal answer and "never
                // stated" is not the same as "none".
                let personhood = body.get("personhoodClass").and_then(|v| v.as_str());
                let description = match personhood {
                    Some(class) if !class.is_empty() && class != "none" => {
                        Some(format!("legal wrapper: {class}"))
                    }
                    Some(_) => Some("legal wrapper: none".to_owned()),
                    None => None,
                };
                contracts.push(ContractEntry {
                    id: format!("{chain}:{dao}"),
                    name: "Bound DAO".to_owned(),
                    description,
                });
                if let Some(class) = personhood {
                    if !class.is_empty() {
                        extensions
                            .insert("x-ao.personhoodClass".to_owned(), serde_json::json!(class));
                    }
                }
            }
        }
    }

    // Second pass — proposals and receipts need the binding resolved above.
    // (Two passes on purpose: the relay returns rows newest-first, and a
    // one-pass fold made proposal ids depend on row order — the determinism
    // test caught exactly that.)
    for stored in events {
        let event = &stored.event;
        let kind = event.kind.as_u16();
        if kind == KIND_LAUNCH_PROPOSAL as u16 {
            let body: serde_json::Value =
                serde_json::from_str(&event.content).unwrap_or(serde_json::Value::Null);
            let title = body
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("Proposal")
                .to_owned();
            let onchain_id = body.get("proposalId").and_then(|v| v.as_str());
            let id = match (onchain_id, contracts.first()) {
                (Some(oid), Some(dao)) if !oid.is_empty() && !oid.eq_ignore_ascii_case("null") => {
                    format!("{}?proposalId={}", dao.id, oid)
                }
                _ => format!("nostr:{}", event.id.to_hex()),
            };
            let status = body
                .get("state")
                .and_then(|v| v.as_str())
                .unwrap_or("open")
                .to_owned();
            // D10 (persona-drafting-loop): an `agent-draft` presents as
            // DAOIP-5 `draft` — never as open/active. The draft's full
            // identity (wiki anchor, evidence) stays on the event itself.
            let status = if status == "agent-draft" {
                "draft".to_owned()
            } else {
                status
            };
            let calls = parse_calls(&body);
            proposals.entry(id.clone()).or_insert_with(|| Proposal {
                proposal_type: "proposal".to_owned(),
                id,
                name: title,
                content_uri: None,
                discussion_uri: body
                    .get("issue")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_owned()),
                status,
                calls,
            });
        } else if kind == KIND_LAUNCH_RECEIPT as u16 {
            let body: serde_json::Value =
                serde_json::from_str(&event.content).unwrap_or(serde_json::Value::Null);
            let table = body.get("table").and_then(|v| v.as_str()).unwrap_or("");
            // The governance vocabulary only: proposal / vote / execute.
            if !matches!(table, "proposal" | "vote" | "execute") {
                continue;
            }
            let proposal_ref = body
                .get("proposal")
                .and_then(|v| v.as_str())
                .map(|s| s.to_owned())
                .unwrap_or_default();
            let table_owned = table.to_owned();
            activities.entry(event.id.to_hex()).or_insert_with(|| Activity {
                // The golden vector's shape: `<kind>:<table>:<event id>`
                // (asserted in tests — two divergent id forms would make
                // receipts unjoinable across surfaces).
                id: format!("47005:{table_owned}:{}", event.id.to_hex()),
                activity_type: "activity".to_owned(),
                proposal: ActivityRef {
                    ref_type: "proposal".to_owned(),
                    id: proposal_ref,
                },
                member: Member::nostr(&event.pubkey.to_hex()),
            });
        }
    }

    OrgGraph {
        name,
        description: None,
        bound,
        members: members.into_values().collect(),
        proposals: proposals.into_values().collect(),
        activities: activities.into_values().collect(),
        contracts,
        governance_uri: None, // the handler fills the absolute URL
        extensions,
    }
}

/// `calls[]` in the record is already ERC-4824 `CallDataEVM` shape
/// (NIP-LP §47004); map strictly — malformed entries mean no calls, never
/// guessed ones.
fn parse_calls(body: &serde_json::Value) -> Vec<Call> {
    let Some(list) = body.get("calls").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in list {
        let (Some(operation), Some(from), Some(to), Some(value), Some(data)) = (
            entry.get("operation").and_then(|v| v.as_str()),
            entry.get("from").and_then(|v| v.as_str()),
            entry.get("to").and_then(|v| v.as_str()),
            entry.get("value").and_then(|v| v.as_str()),
            entry.get("data").and_then(|v| v.as_str()),
        ) else {
            return Vec::new();
        };
        if operation != "call" && operation != "delegatecall" {
            return Vec::new();
        }
        out.push(Call {
            call_type: "CallDataEVM".to_owned(),
            operation: operation.to_owned(),
            from: from.to_owned(),
            to: to.to_owned(),
            value: value.to_owned(),
            data: data.to_owned(),
        });
    }
    out
}

/// Bind the request to its tenant from Host (the security boundary — the
/// NIP-05 discipline: never a default tenant, never cross-tenant data). The
/// optional path community is URL shape only: data ALWAYS comes from the
/// bound tenant, so a wrong path segment can neither peek nor enumerate.
async fn bound_community(state: &AppState, headers: &HeaderMap) -> Result<CommunityId, StatusCode> {
    let raw_host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let tenant = crate::tenant::bind_community(&state.db, raw_host)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;
    Ok(tenant.community())
}

/// `GET /dao.json`, `GET /{community}/dao.json` — the recomputable document.
pub async fn serve(
    State(state): State<Arc<AppState>>,
    Path(path_community): Path<String>,
    headers: HeaderMap,
) -> Response {
    serve_inner(state, headers, Some(path_community.as_str())).await
}

/// Host-bound variant without a path community.
pub async fn serve_root(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    serve_inner(state, headers, None).await
}

async fn serve_inner(
    state: Arc<AppState>,
    headers: HeaderMap,
    path_community: Option<&str>,
) -> Response {
    let community = match bound_community(&state, &headers).await {
        Ok(c) => c,
        Err(status) => return status.into_response(),
    };

    // The graph's kinds: org nodes, proposals, receipts (community-scoped
    // reads; global-only guard keeps channel rows out).
    let mut query = buzz_db::EventQuery::for_community(community);
    query.kinds = Some(vec![
        KIND_ORG_NODE as i32,
        KIND_LAUNCH_PROPOSAL as i32,
        KIND_LAUNCH_RECEIPT as i32,
    ]);
    query.limit = Some(2_000);
    query.global_only = true;
    let events = match state.db.query_events_routed("dao_json", &query).await {
        Ok(events) => events,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };

    let mut graph = assemble_graph(&events);
    let host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let slug = path_community.unwrap_or("");
    graph.governance_uri = Some(format!(
        "https://{}/{}/governance.md",
        host.trim_end_matches('/'),
        slug
    ));

    let mut response = document_bytes(&graph).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/ld+json; charset=utf-8"),
    );
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    response
}

/// `GET /governance.md`, `GET /{community}/governance.md` — the charter.
/// Absent page -> 404 (an honest absence beats a fake charter).
pub async fn governance_md(
    State(state): State<Arc<AppState>>,
    Path(_path_community): Path<String>,
    headers: HeaderMap,
) -> Response {
    governance_inner(state, headers).await
}

/// Host-bound variant without a path community.
pub async fn governance_md_root(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    governance_inner(state, headers).await
}

async fn governance_inner(state: Arc<AppState>, headers: HeaderMap) -> Response {
    let community = match bound_community(&state, &headers).await {
        Ok(c) => c,
        Err(status) => return status.into_response(),
    };
    let mut query = buzz_db::EventQuery::for_community(community);
    query.kinds = Some(vec![KIND_WIKI_PAGE as i32]);
    query.limit = Some(50);
    query.global_only = true;
    query.d_tags = Some(GOVERNANCE_SLUGS.iter().map(|s| s.to_string()).collect());
    let mut events = match state.db.query_events_routed("governance_md", &query).await {
        Ok(events) => events,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    // Newest revision wins (NIP-33 LWW semantics).
    events.sort_by(|a, b| {
        b.event
            .created_at
            .cmp(&a.event.created_at)
            .then_with(|| b.event.id.cmp(&a.event.id))
    });
    match events.first() {
        Some(page) => {
            let mut response = page.event.content.clone().into_response();
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/markdown; charset=utf-8"),
            );
            response.headers_mut().insert(
                header::ACCESS_CONTROL_ALLOW_ORIGIN,
                HeaderValue::from_static("*"),
            );
            response
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind};

    fn event(kind: u32, content: serde_json::Value) -> StoredEvent {
        let keys = Keys::generate();
        let built = EventBuilder::new(Kind::Custom(kind as u16), content.to_string())
            .sign_with_keys(&keys)
            .expect("event");
        StoredEvent::new(built, None)
    }

    fn node(name: &str, holders: &[&str], agents: &[&str], onchain: Option<serde_json::Value>) -> StoredEvent {
        let mut body = serde_json::json!({
            "v": 1,
            "name": name,
            "kind": "role",
            "holders": holders,
            "agentSeats": agents,
        });
        if let Some(o) = onchain {
            body["onchain"] = o;
        }
        event(KIND_ORG_NODE, body)
    }

    /// The assembly must bind to the production seam: the same events a
    /// relay stores in, the same graph out — sorted, never invented.
    #[test]
    fn assemble_graph_from_the_typed_seam() {
        let events = vec![
            node(
                "Buzz Gov Journey",
                &["ab".repeat(32).as_str()],
                &["ef".repeat(32).as_str()],
                Some(serde_json::json!({"chain": "eip155:31337", "dao": "0xDAB8"})),
            ),
            event(
                KIND_LAUNCH_PROPOSAL,
                serde_json::json!({
                    "proposalId": "0x4934",
                    "kind": "plain",
                    "state": "executed",
                    "title": "Raise quorum",
                    "calls": [{"operation": "call", "from": "0xa", "to": "0xb", "value": "0", "data": "0x2fb15081"}],
                }),
            ),
            event(
                KIND_LAUNCH_RECEIPT,
                serde_json::json!({"table": "vote", "proposal": "0x4934", "vote": "for"}),
            ),
            // Not the governance vocabulary -> excluded from activities.
            event(
                KIND_LAUNCH_RECEIPT,
                serde_json::json!({"table": "claim", "claim": "m1"}),
            ),
        ];
        let graph = assemble_graph(&events);
        assert_eq!(graph.name, "Buzz Gov Journey");
        assert!(graph.bound);
        assert_eq!(graph.members.len(), 2, "holder + agent seat, deduped");
        assert_eq!(graph.contracts.len(), 1);
        assert_eq!(graph.proposals.len(), 1);
        let proposal = &graph.proposals[0];
        assert_eq!(proposal.id, "eip155:31337:0xdab8?proposalId=0x4934");
        assert_eq!(proposal.calls.len(), 1);
        assert_eq!(proposal.calls[0].operation, "call");
        assert_eq!(graph.activities.len(), 1, "vote yes, claim no");
        assert_eq!(graph.activities[0].proposal.id, "0x4934");
        // The activity id keeps the golden vector's `<kind>:<table>:<id>`
        // shape (erc4824.rs) — receipts must be joinable across surfaces.
        let activity_id = &graph.activities[0].id;
        assert!(
            activity_id.starts_with("47005:vote:"),
            "activity id shape: {activity_id}"
        );
        assert_eq!(
            activity_id.as_str(),
            format!("47005:vote:{}", events[2].event.id.to_hex())
        );

        // Determinism: a shuffled-equal input assembles identically.
        let mut swapped = events.clone();
        swapped.swap(0, 1);
        assert_eq!(
            serde_json::to_string(&assemble_graph(&events)).unwrap(),
            serde_json::to_string(&assemble_graph(&swapped)).unwrap()
        );
    }

    /// Malformed calls mean NO calls (never guessed), and unbound orgs never
    /// claim contracts at the assembly layer either.
    #[test]
    fn assembly_refuses_guessed_values() {
        let events = vec![
            node("Paper Team", &["cd".repeat(32).as_str()], &[], None),
            event(
                KIND_LAUNCH_PROPOSAL,
                serde_json::json!({
                    "proposalId": "0x1",
                    "kind": "plain",
                    "state": "open",
                    "title": "Broken calls",
                    "calls": [{"operation": "staticcall", "from": "0xa", "to": "0xb", "value": "0", "data": "0x"}],
                }),
            ),
        ];
        let graph = assemble_graph(&events);
        assert!(!graph.bound);
        assert!(graph.contracts.is_empty());
        assert_eq!(graph.proposals[0].calls.len(), 0, "malformed -> none");
        assert_eq!(graph.proposals[0].id, format!("nostr:{}", events[1].event.id.to_hex()));
    }

    /// CAIP-10 ids born lowercase (ERC-8257 commitment rule: reject, never
    /// silently fix — so nothing mixed-case ever leaves the assembler).
    #[test]
    fn caip10_ids_are_lowercased_at_birth() {
        let events = vec![node(
            "Mixed",
            &[],
            &[],
            Some(serde_json::json!({"chain": "eip155:31337", "dao": "0xDAB83FF458201226b851B0638C1fb444eD515230"})),
        )];
        let graph = assemble_graph(&events);
        assert_eq!(
            graph.contracts[0].id,
            "eip155:31337:0xdab83ff458201226b851b0638c1fb444ed515230"
        );
    }

    /// D10 (persona-drafting-loop): an `agent-draft` presents as DAOIP-5
    /// `draft` — never as open/active — and carries no onchain id claim.
    #[test]
    fn agent_drafts_present_as_drafts() {
        let events = vec![event(
            KIND_LAUNCH_PROPOSAL,
            serde_json::json!({
                "proposalId": null,
                "kind": "plain",
                "issue": null,
                "state": "agent-draft",
                "title": "Raise proposal quorum to 600 bps",
                "evidence": "The round-2 postmortem asks for a 600 bps quorum.",
            }),
        )];
        let graph = assemble_graph(&events);
        assert_eq!(graph.proposals.len(), 1);
        let proposal = &graph.proposals[0];
        assert_eq!(proposal.status, "draft", "agent-draft -> DAOIP-5 draft");
        assert_eq!(proposal.id, format!("nostr:{}", events[0].event.id.to_hex()));
        assert_eq!(proposal.name, "Raise proposal quorum to 600 bps");
    }
}
