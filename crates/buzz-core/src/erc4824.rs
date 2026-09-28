//! ERC-4824 projection (OA.md Phase 1): `org_graph -> ERC4824Document`.
//!
//! A PURE function from a folded org graph to the ERC-4824 DAO JSON-LD
//! document (https://eips.ethereum.org/EIPS/eip-4824). No I/O, no clock, no
//! chain: the same input yields the same bytes, forever — which is what makes
//! the document's self-declared verification meaningful
//! (OA.md section 4: "the bytes are a pure function of the signed events").
//!
//! Phase 1 rules, each a test below:
//! - `type` is `"DAO"` when the org is onchain-bound, `"Organization"` when
//!   not (the spec's non-DAO entity clause — same graph either way).
//! - `contracts` is **omitted, not faked**, when unbound: an unbound org has
//!   no legal person, and a document that pretends otherwise is exactly the
//!   spoofing case `contracts` exists to prevent.
//! - A field with no value is **removed, never null** (spec requirement).
//! - `members[].id` may be a `nostr:` URI ("CAIP-10 address, DID address, or
//!   other URI identifier" — the spec is deliberately open here).
//! - Proposals carry `calls[]` in the spec's `CallDataEVM` shape; majeur
//!   proposals ARE call batches, so this is a lossless mapping — and the
//!   spec's stated use case for `calls` is execution simulation.
//!
//! Speculative metadata stays in `extensions` (DAOIP-5's rule: `x-` prefixed,
//! unknown extensions ignored gracefully) — the reversible container.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One member identity. `id` is spec-legal as CAIP-10 (`eip155:1:0x…`), DID,
/// or any other URI identifier — Buzz seat occupants use `nostr:` URIs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Member {
    /// CAIP-10 address, DID, or any other URI identifier (`nostr:…`).
    pub id: String,
    /// Display name, when the graph knows one.
    #[serde(rename = "name", skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

impl Member {
    /// A seat occupant's identity as the spec's "other URI identifier".
    pub fn nostr(pubkey_hex: &str) -> Self {
        Self {
            id: format!("nostr:{pubkey_hex}"),
            name: None,
        }
    }
}

/// `CallDataEVM` — the spec's execution-call shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Call {
    /// Always `"CallDataEVM"` (the spec's call type discriminator).
    #[serde(rename = "type")]
    pub call_type: String,
    /// `"call"` or `"delegatecall"` (majeur's `op` 0 / 1).
    pub operation: String,
    /// CAIP-10 of the caller (lowercase hex).
    pub from: String,
    /// CAIP-10 of the target (lowercase hex).
    pub to: String,
    /// Wei value as a decimal string.
    pub value: String,
    /// 0x-prefixed calldata.
    pub data: String,
}

impl Call {
    /// A `call` operation (majeur `op` 0).
    pub fn plain(from: &str, to: &str, value: &str, data: &str) -> Self {
        Self {
            call_type: "CallDataEVM".to_owned(),
            operation: "call".to_owned(),
            from: from.to_owned(),
            to: to.to_owned(),
            value: value.to_owned(),
            data: data.to_owned(),
        }
    }

    /// A `delegatecall` operation (majeur `op` 1).
    pub fn delegate(from: &str, to: &str, value: &str, data: &str) -> Self {
        Self {
            operation: "delegatecall".to_owned(),
            ..Self::plain(from, to, value, data)
        }
    }
}

/// A proposal in the spec's schema. `id` follows the spec's onchain form
/// `CAIP10 + "?proposalId=" + counter` (offchain proposals use a URI id).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Proposal {
    /// Always `"proposal"` (the spec's type discriminator).
    #[serde(rename = "type")]
    pub proposal_type: String,
    /// `CAIP10 + "?proposalId=" + id` for onchain proposals, a `nostr:` URI
    /// otherwise.
    pub id: String,
    /// The proposal title.
    pub name: String,
    /// Where the full text lives.
    #[serde(rename = "contentURI", skip_serializing_if = "Option::is_none")]
    pub content_uri: Option<String>,
    /// Where the discussion lives (a git issue, a channel thread).
    #[serde(rename = "discussionURI", skip_serializing_if = "Option::is_none")]
    pub discussion_uri: Option<String>,
    /// Free text in the spec (status vocabularies differ per governance) —
    /// Buzz sends majeur's `ProposalState` labels, which is strictly richer
    /// than the spec demands.
    pub status: String,
    /// The execution intent (`CallDataEVM`); empty is omitted.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub calls: Vec<Call>,
}

/// The activity log's member/proposal interplay.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Activity {
    /// `<kind>:<table>:<event id>` — joinable across every surface.
    pub id: String,
    /// Always `"activity"`.
    #[serde(rename = "type")]
    pub activity_type: String,
    /// The proposal this activity touched.
    pub proposal: ActivityRef,
    /// Who acted.
    pub member: Member,
}

/// An activity's proposal reference.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActivityRef {
    /// Always `"proposal"`.
    #[serde(rename = "type")]
    pub ref_type: String,
    /// The referenced proposal's `id` (or its record id, when unbound).
    pub id: String,
}

/// One entry of `contracts[]` — the anti-spoofing spine of the spec.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContractEntry {
    /// CAIP-10 address (lowercase hex).
    pub id: String,
    /// What the contract is (e.g. "Bound DAO").
    pub name: String,
    /// What it does / which legal wrapper it represents.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// The folded org graph — the projection's only input. Assembly from signed
/// events (37010/37011/47004/47005/37013 …) happens upstream; keeping this
/// struct neutral is what makes the projection pure and testable.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OrgGraph {
    /// The org's display name (usually the root node's).
    pub name: String,
    /// What the org is, when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// True when the org root is onchain-bound (NIP-ORG `content.onchain`).
    pub bound: bool,
    /// Seat occupants and shareholders (`nostr:` and CAIP-10 ids).
    #[serde(default)]
    pub members: Vec<Member>,
    /// The org's proposals (kind 47004 vocabulary).
    #[serde(default)]
    pub proposals: Vec<Proposal>,
    /// The org's receipts (kind 47005 governance vocabulary).
    #[serde(default)]
    pub activities: Vec<Activity>,
    /// Ignored — omitted — when `bound` is false (never faked).
    #[serde(default)]
    pub contracts: Vec<ContractEntry>,
    /// The charter flatfile URL (the handler fills the absolute URL).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub governance_uri: Option<String>,
    /// DAOIP-5 `extensions`: `x-` prefixed experimental metadata
    /// (OA.md section 5's `x-ao.*` keys). Passed through untouched.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub extensions: BTreeMap<String, Value>,
}

/// The ERC-4824 DAO JSON-LD document. Fields with no value are OMITTED (the
/// spec: "removed rather than left with an empty or null value").
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Erc4824Document {
    /// Always `https://www.daostar.org/schemas`.
    #[serde(rename = "@context")]
    pub context: String,
    /// `"DAO"` when bound, `"Organization"` when not.
    #[serde(rename = "type")]
    pub entity_type: String,
    /// The org's name (absent when there is none — removed, never nulled).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// What the org is, when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Seat occupants and shareholders; may include agent seats.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub members: Vec<Member>,
    /// Proposals with their `CallDataEVM` execution intent.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub proposals: Vec<Proposal>,
    /// The activity log (member ↔ proposal interplay).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub activities: Vec<Activity>,
    /// Omitted entirely when the org is unbound or none are declared.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub contracts: Vec<ContractEntry>,
    /// The charter flatfile (`.md`), for the social license.
    #[serde(rename = "governanceURI", skip_serializing_if = "Option::is_none")]
    pub governance_uri: Option<String>,
    /// DAOIP-5 `extensions` (`x-` experimental metadata), pass-through.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub extensions: BTreeMap<String, Value>,
}

/// The projection. Pure: same graph, same document — forever.
pub fn project(graph: &OrgGraph) -> Erc4824Document {
    Erc4824Document {
        context: "https://www.daostar.org/schemas".to_owned(),
        entity_type: if graph.bound {
            "DAO".to_owned()
        } else {
            "Organization".to_owned()
        },
        name: (!graph.name.is_empty()).then(|| graph.name.clone()),
        description: graph.description.clone(),
        members: graph.members.clone(),
        proposals: graph.proposals.clone(),
        activities: graph.activities.clone(),
        // The Phase 1 rule: unbound orgs never claim contracts.
        contracts: if graph.bound {
            graph.contracts.clone()
        } else {
            Vec::new()
        },
        governance_uri: graph.governance_uri.clone(),
        extensions: graph.extensions.clone(),
    }
}

/// Canonical bytes: `serde_json`'s default map ordering is sorted, so the
/// output is deterministic and byte-comparable (the golden-vector seam).
pub fn document_bytes(graph: &OrgGraph) -> String {
    serde_json::to_string(&project(graph)).expect("document serializes")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The journey's DAO (contracts/script/JourneyGov.s.sol) as a graph —
    /// the golden vector binds to a shape the chain really produces.
    fn bound_graph() -> OrgGraph {
        let mut extensions = BTreeMap::new();
        extensions.insert(
            "x-ao.authorityChain".to_owned(),
            json!(["37011:grant:ops-budget"]),
        );
        // The consequential-events register (OAv2 section 4.3): WHICH
        // actions have a real checkpoint, categorized by authority — the
        // structural answer to auditability-washing.
        extensions.insert(
            "x-ao.enforced".to_owned(),
            json!([
                {"action": "propose", "authority": "permitted",
                 "checkpoint": {"kind": "policy-as-code", "mechanism": "proposalThreshold"}},
                {"action": "spend", "authority": "conditional",
                 "checkpoint": {"kind": "human-approval", "approver": "46010"},
                 "onViolation": "decreaseAllowance"},
                {"action": "exit", "authority": "permitted",
                 "checkpoint": {"kind": "policy-as-code", "mechanism": "ragequit"}},
            ]),
        );
        // The outcomes split (docs/aos/ao-survey.md): value production IS
        // instrumented here (receipts, royalty stream, close mirrors);
        // cooperation quality is not measured and this key does not claim it.
        extensions.insert(
            "x-ao.outcomes".to_owned(),
            json!({"instrument": "royalty-stream", "streams": ["47005", "47007"]}),
        );
        OrgGraph {
            name: "Buzz Gov Journey".to_owned(),
            description: Some("The governance leg's DAO".to_owned()),
            bound: true,
            members: vec![
                Member::nostr("ab".repeat(32).as_str()),
                Member {
                    id: "eip155:31337:0x70997970C51812dc3A010C7d01b50e0d17dc79C8".to_owned(),
                    name: Some("Voter".to_owned()),
                },
                // Agent seats are FIRST-CLASS members (the transcripts are
                // about non-human persons; a document listing only humans
                // loses the point). Same `nostr:` URI form as human seats.
                Member {
                    id: format!("nostr:{}", "ef".repeat(32)),
                    name: Some("Researcher (agent seat)".to_owned()),
                },
            ],
            proposals: vec![Proposal {
                proposal_type: "proposal".to_owned(),
                id: "eip155:31337:0xDAB83FF458201226b851B0638C1fb444eD515230?proposalId=0x4934".to_owned(),
                name: "Raise quorum to 600 bps".to_owned(),
                content_uri: Some("blossom://evidence".to_owned()),
                discussion_uri: None,
                status: "Executed".to_owned(),
                calls: vec![Call::plain(
                    "eip155:31337:0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
                    "eip155:31337:0xDAB83FF458201226b851B0638C1fb444eD515230",
                    "0",
                    "0x2fb15081", // setQuorumBps(uint16)
                )],
            }],
            activities: vec![Activity {
                id: "47005:vote:0xabc".to_owned(),
                activity_type: "activity".to_owned(),
                proposal: ActivityRef {
                    ref_type: "proposal".to_owned(),
                    id: "eip155:31337:0xDAB83FF458201226b851B0638C1fb444eD515230?proposalId=0x4934".to_owned(),
                },
                member: Member::nostr("ab".repeat(32).as_str()),
            }],
            contracts: vec![
                ContractEntry {
                    id: "eip155:31337:0xDAB83FF458201226b851B0638C1fb444eD515230".to_owned(),
                    name: "Moloch".to_owned(),
                    description: Some("The summoning DAO".to_owned()),
                },
                ContractEntry {
                    id: "eip155:31337:0x0000000000000000000000000000000000000Aa".to_owned(),
                    name: "Shares".to_owned(),
                    description: None,
                },
            ],
            governance_uri: Some("https://example.org/governance.md".to_owned()),
            extensions,
        }
    }

    fn unbound_graph() -> OrgGraph {
        OrgGraph {
            name: "Paper Team".to_owned(),
            description: None,
            bound: false,
            members: vec![Member::nostr("cd".repeat(32).as_str())],
            proposals: vec![],
            activities: vec![],
            // Declared but MUST be omitted while unbound ("not faked").
            contracts: vec![ContractEntry {
                id: "eip155:1:0xdead".to_owned(),
                name: "Wishful Treasury".to_owned(),
                description: None,
            }],
            governance_uri: None,
            extensions: BTreeMap::new(),
        }
    }

    /// Bound golden: `type: DAO`, all five sections present, `calls` in
    /// CallDataEVM shape, extensions passed through. The JSON literal is the
    /// independent expectation; `document_bytes` must serialize to exactly
    /// these bytes (serde's sorted maps make that stable).
    #[test]
    fn bound_golden_vector() {
        let doc = project(&bound_graph());
        let expected = json!({
            "@context": "https://www.daostar.org/schemas",
            "type": "DAO",
            "name": "Buzz Gov Journey",
            "description": "The governance leg's DAO",
            "members": [
                {"id": format!("nostr:{}", "ab".repeat(32))},
                {"id": "eip155:31337:0x70997970C51812dc3A010C7d01b50e0d17dc79C8", "name": "Voter"},
                {"id": format!("nostr:{}", "ef".repeat(32)), "name": "Researcher (agent seat)"},
            ],
            "proposals": [{
                "type": "proposal",
                "id": "eip155:31337:0xDAB83FF458201226b851B0638C1fb444eD515230?proposalId=0x4934",
                "name": "Raise quorum to 600 bps",
                "contentURI": "blossom://evidence",
                "status": "Executed",
                "calls": [{
                    "type": "CallDataEVM",
                    "operation": "call",
                    "from": "eip155:31337:0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
                    "to": "eip155:31337:0xDAB83FF458201226b851B0638C1fb444eD515230",
                    "value": "0",
                    "data": "0x2fb15081",
                }],
            }],
            "activities": [{
                "id": "47005:vote:0xabc",
                "type": "activity",
                "proposal": {"type": "proposal", "id": "eip155:31337:0xDAB83FF458201226b851B0638C1fb444eD515230?proposalId=0x4934"},
                "member": {"id": format!("nostr:{}", "ab".repeat(32))},
            }],
            "contracts": [
                {"id": "eip155:31337:0xDAB83FF458201226b851B0638C1fb444eD515230", "name": "Moloch", "description": "The summoning DAO"},
                {"id": "eip155:31337:0x0000000000000000000000000000000000000Aa", "name": "Shares"},
            ],
            "governanceURI": "https://example.org/governance.md",
            "extensions": {
                "x-ao.authorityChain": ["37011:grant:ops-budget"],
                "x-ao.enforced": [
                    {"action": "propose", "authority": "permitted",
                     "checkpoint": {"kind": "policy-as-code", "mechanism": "proposalThreshold"}},
                    {"action": "spend", "authority": "conditional",
                     "checkpoint": {"kind": "human-approval", "approver": "46010"},
                     "onViolation": "decreaseAllowance"},
                    {"action": "exit", "authority": "permitted",
                     "checkpoint": {"kind": "policy-as-code", "mechanism": "ragequit"}},
                ],
                "x-ao.outcomes": {"instrument": "royalty-stream", "streams": ["47005", "47007"]},
            },
        });
        assert_eq!(
            serde_json::to_value(&doc).expect("serializes"),
            expected,
            "bound document must match the golden vector exactly"
        );
    }

    /// Unbound golden: `type: Organization`, contracts OMITTED (not faked),
    /// valueless fields removed rather than nulled.
    #[test]
    fn unbound_golden_vector_omits_contracts() {
        let doc = project(&unbound_graph());
        let value = serde_json::to_value(&doc).expect("serializes");
        let expected = json!({
            "@context": "https://www.daostar.org/schemas",
            "type": "Organization",
            "name": "Paper Team",
            "members": [{"id": format!("nostr:{}", "cd".repeat(32))}],
        });
        assert_eq!(value, expected);
        assert!(value.get("contracts").is_none(), "contracts omitted, not faked");
        assert!(value.get("description").is_none(), "no value -> removed, not null");
        assert!(value.get("governanceURI").is_none());
    }

    /// Purity is the trust story (OA.md section 4): the bytes are a function
    /// of the graph alone. Two calls must produce identical bytes.
    #[test]
    fn projection_is_pure_and_byte_stable() {
        let graph = bound_graph();
        assert_eq!(document_bytes(&graph), document_bytes(&graph.clone()));
        // And nothing ambient: a rebuilt equal graph matches byte for byte.
        assert_eq!(document_bytes(&graph), document_bytes(&bound_graph()));
    }

    /// `Call` keeps the spec's closed operation vocabulary (majeur `op`).
    #[test]
    fn calls_map_majeur_ops() {
        let c = Call::delegate("0xa", "0xb", "1", "0x");
        assert_eq!(c.call_type, "CallDataEVM");
        assert_eq!(c.operation, "delegatecall");
        let s = serde_json::to_string(&c).unwrap();
        assert!(s.contains("\"type\":\"CallDataEVM\""));
        assert!(s.contains("\"operation\":\"delegatecall\""));
    }
}
