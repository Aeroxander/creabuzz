//! NIP-ORG grant-chain verification (kinds:37010/37011).
//!
//! Pure, I/O-free core of delegated-authority verification. The relay's
//! ingest gate (`buzz-relay/src/handlers/org_grant_enforcement.rs`) fetches
//! the referenced grant and node events from the event store and drives
//! [`verify_grant_chain`] here; clients do the same over relay reads (see
//! `buzz-sdk`'s re-exports). Keeping the walk pure makes it deterministic
//! and testable: time (`now`) is a parameter, and the caller supplies the
//! resolved grants and nodes.
//!
//! Semantics (NIP-ORG "Client behavior" / "Relay behavior"):
//! - **Attenuation** — every verb a grant carries must be entailed by some
//!   verb of its parent grant (`parentGrant` chain).
//! - **Root standing** — a root grant's verbs must be entailed by the
//!   `canGrant` scope of the org node (kind:37010) the issuer acts through.
//! - **Expiry / revocation** — no link in the chain may be revoked or
//!   expired at verification time.
//! - The walk is bounded ([`MAX_GRANT_CHAIN_DEPTH`]) and cycle-detecting.

/// Maximum byte length of an org `d` tag value (matches relay constant).
pub const ORG_D_MAX_LEN: usize = 64;

/// Maximum number of `parentGrant` hops the chain walk follows.
///
/// A legitimate delegation chain is a handful of links deep; a longer walk
/// can only be a pathological or adversarial graph. When enforcement is on,
/// exceeding the bound rejects the grant rather than verifying it (fail
/// closed).
pub const MAX_GRANT_CHAIN_DEPTH: usize = 32;

/// Scope declared by an org node — which verbs this node may delegate.
///
/// Serialized with camelCase keys per NIP-ORG (`readBelow`, `assignBelow`,
/// `canGrant`).
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgScope {
    /// Whether this node can read channels below it.
    #[serde(default)]
    pub read_below: bool,
    /// Whether this node can assign tasks to subordinates.
    #[serde(default)]
    pub assign_below: bool,
    /// Verbs this node may delegate (e.g. `["read", "task", "spend:100000"]`).
    #[serde(default)]
    pub can_grant: Vec<String>,
}

/// Content body of a kind:37011 org grant event.
///
/// Serialized with camelCase keys per NIP-ORG (`parentGrant`, …).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgGrantContent {
    /// Schema version — always `1`.
    pub v: u32,
    /// 64-char hex pubkey of the issuer (who holds the authority being delegated).
    pub issuer: String,
    /// 64-char hex pubkey of the grantee (human or agent receiving authority).
    pub grantee: String,
    /// `d` tag of the org node the issuer acts through.
    pub via: String,
    /// Scoped capability verbs (e.g. `["read:#leadership", "task:create", "spend:100000"]`).
    pub verbs: Vec<String>,
    /// `d` tag of the parent grant (omit for root grants from standing).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_grant: Option<String>,
    /// Unix timestamp when this grant expires (omit for no expiry).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires: Option<u64>,
    /// Whether this grant has been revoked (default false).
    #[serde(default)]
    pub revoked: bool,
}

/// A resolved org node fetched from the relay.
#[derive(Debug, Clone)]
pub struct ResolvedOrgNode {
    /// The node's `d` tag.
    pub d: String,
    /// Seat holders (human pubkeys).
    pub holders: Vec<String>,
    /// Agent seat holders.
    pub agent_seats: Vec<String>,
    /// Delegation scope.
    pub scope: OrgScope,
}

/// A resolved grant fetched from the relay.
#[derive(Debug, Clone)]
pub struct ResolvedGrant {
    /// The grant's `d` tag.
    pub d: String,
    /// Issuer pubkey.
    pub issuer: String,
    /// Grantee pubkey.
    pub grantee: String,
    /// Org node `d` the issuer acts through.
    pub via: String,
    /// Scoped capability verbs.
    pub verbs: Vec<String>,
    /// Parent grant `d` (if any).
    pub parent_grant: Option<String>,
    /// Unix timestamp after which this grant is no longer valid
    /// (`None` = no expiry).
    pub expires: Option<u64>,
    /// Whether this grant has been revoked.
    pub revoked: bool,
}

/// Error type for grant chain verification.
#[derive(Debug, thiserror::Error)]
pub enum GrantChainError {
    /// The grant has been revoked.
    #[error("grant {0} has been revoked")]
    Revoked(String),

    /// The grant references a parent grant that was not found.
    #[error("parent grant {0} not found")]
    ParentGrantNotFound(String),

    /// The grant references an org node that was not found.
    #[error("org node {0} not found")]
    NodeNotFound(String),

    /// The grant's issuer does not hold a seat in the referenced org node.
    #[error("issuer {0} is not seated in node {1}")]
    IssuerNotSeated(String, String),

    /// The grant's verbs are not a subset of the parent's verbs (attenuation violated).
    #[error("verb {0} is not entailed by parent grant verbs")]
    AttenuationViolation(String),

    /// The root grant's issuer does not have standing (no matching canGrant).
    #[error("root grant {0} issuer lacks standing (canGrant does not cover {1})")]
    RootLacksStanding(String, String),

    /// A circular grant chain was detected.
    #[error("circular grant chain detected at grant {0}")]
    CircularChain(String),

    /// The `parentGrant` chain exceeds [`MAX_GRANT_CHAIN_DEPTH`] hops.
    #[error("grant chain exceeds the maximum depth of {MAX_GRANT_CHAIN_DEPTH} hops at grant {0}")]
    ChainDepthExceeded(String),

    /// The grant's `expires` timestamp (unix seconds) is in the past.
    #[error("grant {0} expired at {1}")]
    Expired(String, u64),
}

/// Verify a grant chain from a grant up to its root.
///
/// Walks the `parentGrant` links, verifying at each step:
/// 1. The grant is not revoked.
/// 2. The grant is not expired: a link whose `expires` (unix seconds) is at
///    or before `now` fails the whole chain.
/// 3. The issuer holds a seat in the referenced org node.
/// 4. Every verb in the child is entailed by some verb in the parent (attenuation).
/// 5. The root grant's issuer has standing (canGrant entails the verbs,
///    comparing name and argument, not just the name).
///
/// `now` is the current unix time in seconds (pass `Utc::now().timestamp()`
/// as u64); it is a parameter so verification is deterministic and testable.
/// `grants` and `nodes` are maps from `d` tag to resolved records. The caller
/// is responsible for fetching these from the relay.
pub fn verify_grant_chain(
    grant_d: &str,
    now: u64,
    grants: &std::collections::HashMap<String, ResolvedGrant>,
    nodes: &std::collections::HashMap<String, ResolvedOrgNode>,
) -> Result<(), GrantChainError> {
    let mut visited = std::collections::HashSet::new();
    let mut current_d = grant_d.to_string();
    // Parent hops taken so far; bounded by [`MAX_GRANT_CHAIN_DEPTH`]. The
    // bound applies to links walked, not grants seen, so a chain of exactly
    // `MAX_GRANT_CHAIN_DEPTH` links still verifies.
    let mut hops = 0usize;

    loop {
        if !visited.insert(current_d.clone()) {
            return Err(GrantChainError::CircularChain(current_d));
        }

        let grant = grants
            .get(&current_d)
            .ok_or_else(|| GrantChainError::ParentGrantNotFound(current_d.clone()))?;

        if grant.revoked {
            return Err(GrantChainError::Revoked(current_d));
        }

        // A grant is valid only strictly before its expiry.
        if let Some(expires) = grant.expires {
            if now >= expires {
                return Err(GrantChainError::Expired(current_d, expires));
            }
        }

        // Check issuer is seated in the referenced node.
        let node = nodes
            .get(&grant.via)
            .ok_or_else(|| GrantChainError::NodeNotFound(grant.via.clone()))?;

        let issuer_seated =
            node.holders.contains(&grant.issuer) || node.agent_seats.contains(&grant.issuer);
        if !issuer_seated {
            return Err(GrantChainError::IssuerNotSeated(
                grant.issuer.clone(),
                grant.via.clone(),
            ));
        }

        match &grant.parent_grant {
            Some(parent_d) => {
                // Attenuation check: every verb here must be entailed by some parent verb.
                let parent = grants
                    .get(parent_d)
                    .ok_or_else(|| GrantChainError::ParentGrantNotFound(parent_d.clone()))?;

                for verb in &grant.verbs {
                    if !parent.verbs.iter().any(|pv| verb_entailed_by(verb, pv)) {
                        return Err(GrantChainError::AttenuationViolation(verb.clone()));
                    }
                }

                // Also check that parent's issuer is seated in its node.
                let parent_node = nodes
                    .get(&parent.via)
                    .ok_or_else(|| GrantChainError::NodeNotFound(parent.via.clone()))?;
                let parent_issuer_seated = parent_node.holders.contains(&parent.issuer)
                    || parent_node.agent_seats.contains(&parent.issuer);
                if !parent_issuer_seated {
                    return Err(GrantChainError::IssuerNotSeated(
                        parent.issuer.clone(),
                        parent.via.clone(),
                    ));
                }

                hops += 1;
                if hops > MAX_GRANT_CHAIN_DEPTH {
                    return Err(GrantChainError::ChainDepthExceeded(parent_d.clone()));
                }

                current_d = parent_d.clone();
            }
            None => {
                // Root grant: the issuer's node `canGrant` must entail every
                // verb — same name AND argument containment, via the same
                // entailment function used for chain attenuation. A bare
                // name match is not enough: `spend:999999` does not pass
                // under `canGrant` `spend:100000`.
                for verb in &grant.verbs {
                    if !node
                        .scope
                        .can_grant
                        .iter()
                        .any(|cg| verb_entailed_by(verb, cg))
                    {
                        return Err(GrantChainError::RootLacksStanding(current_d, verb.clone()));
                    }
                }
                return Ok(());
            }
        }
    }
}

/// Channel-scope containment for NIP-ORG verbs.
///
/// A channel argument is a `#`-prefixed, `:`-separated path (`#leadership`,
/// `#eng:frontend`). `child` is contained by `parent` when the parent's
/// path segments are a prefix of the child's: `#eng:frontend` is contained
/// by `#eng`, and `#eng` is contained by `#eng`. Substring prefixes do not
/// count — `#l` is NOT contained by `#leadership`, because `#l` names a
/// different channel than the one the parent's scope covers.
fn channel_contained_by(child: &str, parent: &str) -> bool {
    let child_segs = channel_segments(child);
    let parent_segs = channel_segments(parent);
    !parent_segs.is_empty()
        && child_segs.len() >= parent_segs.len()
        && child_segs[..parent_segs.len()] == parent_segs[..]
}

/// Split a channel argument into its `:`-separated path segments,
/// stripping the leading `#` and ignoring empty segments.
fn channel_segments(channel: &str) -> Vec<&str> {
    channel
        .strip_prefix('#')
        .unwrap_or(channel)
        .split(':')
        .filter(|s| !s.is_empty())
        .collect()
}

/// Check if `child` verb is entailed by `parent` verb (NIP-ORG attenuation).
///
/// Entailment means: same name, and the child's argument is no broader than
/// the parent's:
///
/// - No argument on the parent means the parent's scope is unbounded, so any
///   child argument is entailed (`read:#eng` under `read`).
/// - An argument on the child with none on the parent is a widening and is
///   rejected (`read` — read everything — is broader than
///   `read:#leadership`).
/// - Channel scopes use path containment (see [`channel_contained_by`]):
///   `#eng:frontend` is contained by `#eng`; `#l` is not contained by
///   `#leadership`.
/// - Numeric arguments (spend ceilings) compare as `child ≤ parent`
///   (`spend:50000` under `spend:100000`).
/// - Anything else must match exactly.
fn verb_entailed_by(child: &str, parent: &str) -> bool {
    let (child_name, child_arg) = split_verb(child);
    let (parent_name, parent_arg) = split_verb(parent);

    if child_name != parent_name {
        return false;
    }

    match (child_arg, parent_arg) {
        (None, None) => true,
        // Parent is unbounded → any child argument is a subset.
        (Some(_), None) => true,
        // Child is unbounded, parent is scoped → widening.
        (None, Some(_)) => false,
        (Some(child_arg), Some(parent_arg)) => {
            if child_arg.starts_with('#') && parent_arg.starts_with('#') {
                channel_contained_by(child_arg, parent_arg)
            } else if let (Ok(child_num), Ok(parent_num)) =
                (child_arg.parse::<u64>(), parent_arg.parse::<u64>())
            {
                child_num <= parent_num
            } else {
                // Generic: exact match.
                child_arg == parent_arg
            }
        }
    }
}

/// Split a verb into name and optional argument.
/// `"read:#leadership"` → `("read", Some("#leadership"))`
/// `"task:create"` → `("task", Some("create"))`
/// `"read"` → `("read", None)`
fn split_verb(verb: &str) -> (&str, Option<&str>) {
    match verb.find(':') {
        Some(pos) => (&verb[..pos], Some(&verb[pos + 1..])),
        None => (verb, None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    // ── Grant chain verification tests ────────────────────────────────────

    /// Fixed "current time" (unix seconds) for chain-verification tests.
    const TEST_NOW: u64 = 1_700_000_000;

    fn make_node(d: &str, holders: Vec<&str>, can_grant: Vec<&str>) -> ResolvedOrgNode {
        ResolvedOrgNode {
            d: d.to_string(),
            holders: holders.into_iter().map(String::from).collect(),
            agent_seats: vec![],
            scope: OrgScope {
                read_below: true,
                assign_below: true,
                can_grant: can_grant.into_iter().map(String::from).collect(),
            },
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn make_grant(
        d: &str,
        issuer: &str,
        grantee: &str,
        via: &str,
        verbs: Vec<&str>,
        parent_grant: Option<&str>,
        revoked: bool,
        expires: Option<u64>,
    ) -> ResolvedGrant {
        ResolvedGrant {
            d: d.to_string(),
            issuer: issuer.to_string(),
            grantee: grantee.to_string(),
            via: via.to_string(),
            verbs: verbs.into_iter().map(String::from).collect(),
            parent_grant: parent_grant.map(String::from),
            expires,
            revoked,
        }
    }

    #[test]
    fn grant_chain_valid_root() {
        let pk = "a".repeat(64);
        let mut nodes = std::collections::HashMap::new();
        nodes.insert(
            "cto".into(),
            make_node("cto", vec![&pk], vec!["read", "task"]),
        );

        let mut grants = std::collections::HashMap::new();
        grants.insert(
            "g1".into(),
            make_grant(
                "g1",
                &pk,
                "b".repeat(64).as_str(),
                "cto",
                vec!["read"],
                None,
                false,
                None,
            ),
        );

        assert!(verify_grant_chain("g1", TEST_NOW, &grants, &nodes).is_ok());
    }

    #[test]
    fn grant_chain_valid_2_level() {
        let pk_a = "a".repeat(64);
        let pk_b = "b".repeat(64);
        let mut nodes = std::collections::HashMap::new();
        nodes.insert(
            "cto".into(),
            make_node("cto", vec![&pk_a], vec!["read", "task", "spend"]),
        );
        nodes.insert("eng".into(), make_node("eng", vec![&pk_b], vec!["read"]));

        let mut grants = std::collections::HashMap::new();
        // Root grant: pk_a → pk_b via cto, with spend:100000
        grants.insert(
            "g1".into(),
            make_grant(
                "g1",
                &pk_a,
                &pk_b,
                "cto",
                vec!["spend:100000"],
                None,
                false,
                None,
            ),
        );
        // Child grant: pk_b → pk_c via eng, with spend:50000 (attenuated)
        grants.insert(
            "g2".into(),
            make_grant(
                "g2",
                &pk_b,
                "c".repeat(64).as_str(),
                "eng",
                vec!["spend:50000"],
                Some("g1"),
                false,
                None,
            ),
        );

        assert!(verify_grant_chain("g2", TEST_NOW, &grants, &nodes).is_ok());
    }

    #[test]
    fn grant_chain_rejected_revoked() {
        let pk = "a".repeat(64);
        let mut nodes = std::collections::HashMap::new();
        nodes.insert("cto".into(), make_node("cto", vec![&pk], vec!["read"]));

        let mut grants = std::collections::HashMap::new();
        grants.insert(
            "g1".into(),
            make_grant(
                "g1",
                &pk,
                "b".repeat(64).as_str(),
                "cto",
                vec!["read"],
                None,
                true,
                None,
            ),
        );

        let err = verify_grant_chain("g1", TEST_NOW, &grants, &nodes).unwrap_err();
        assert!(matches!(err, GrantChainError::Revoked(_)));
    }

    #[test]
    fn grant_chain_rejected_issuer_not_seated() {
        let pk_a = "a".repeat(64);
        let pk_x = "x".repeat(64); // not seated
        let mut nodes = std::collections::HashMap::new();
        nodes.insert("cto".into(), make_node("cto", vec![&pk_a], vec!["read"]));

        let mut grants = std::collections::HashMap::new();
        grants.insert(
            "g1".into(),
            make_grant(
                "g1",
                &pk_x,
                "b".repeat(64).as_str(),
                "cto",
                vec!["read"],
                None,
                false,
                None,
            ),
        );

        let err = verify_grant_chain("g1", TEST_NOW, &grants, &nodes).unwrap_err();
        assert!(matches!(err, GrantChainError::IssuerNotSeated(_, _)));
    }

    #[test]
    fn grant_chain_rejected_attenuation_violation() {
        let pk_a = "a".repeat(64);
        let pk_b = "b".repeat(64);
        let mut nodes = std::collections::HashMap::new();
        nodes.insert(
            "cto".into(),
            make_node("cto", vec![&pk_a], vec!["read", "task"]),
        );
        nodes.insert("eng".into(), make_node("eng", vec![&pk_b], vec!["read"]));

        let mut grants = std::collections::HashMap::new();
        // Root: spend:100000
        grants.insert(
            "g1".into(),
            make_grant(
                "g1",
                &pk_a,
                &pk_b,
                "cto",
                vec!["spend:100000"],
                None,
                false,
                None,
            ),
        );
        // Child: spend:200000 (wider than parent → violation)
        grants.insert(
            "g2".into(),
            make_grant(
                "g2",
                &pk_b,
                "c".repeat(64).as_str(),
                "eng",
                vec!["spend:200000"],
                Some("g1"),
                false,
                None,
            ),
        );

        let err = verify_grant_chain("g2", TEST_NOW, &grants, &nodes).unwrap_err();
        assert!(matches!(err, GrantChainError::AttenuationViolation(_)));
    }

    #[test]
    fn grant_chain_rejected_root_lacks_standing() {
        let pk = "a".repeat(64);
        let mut nodes = std::collections::HashMap::new();
        // Node has no canGrant for "spend"
        nodes.insert("cto".into(), make_node("cto", vec![&pk], vec!["read"]));

        let mut grants = std::collections::HashMap::new();
        grants.insert(
            "g1".into(),
            make_grant(
                "g1",
                &pk,
                "b".repeat(64).as_str(),
                "cto",
                vec!["spend:100000"],
                None,
                false,
                None,
            ),
        );

        let err = verify_grant_chain("g1", TEST_NOW, &grants, &nodes).unwrap_err();
        assert!(matches!(err, GrantChainError::RootLacksStanding(_, _)));
    }

    #[test]
    fn grant_chain_rejected_circular() {
        let pk = "a".repeat(64);
        let mut nodes = std::collections::HashMap::new();
        nodes.insert("cto".into(), make_node("cto", vec![&pk], vec!["read"]));

        let mut grants = std::collections::HashMap::new();
        grants.insert(
            "g1".into(),
            make_grant(
                "g1",
                &pk,
                "b".repeat(64).as_str(),
                "cto",
                vec!["read"],
                Some("g2"),
                false,
                None,
            ),
        );
        grants.insert(
            "g2".into(),
            make_grant(
                "g2",
                &pk,
                "c".repeat(64).as_str(),
                "cto",
                vec!["read"],
                Some("g1"),
                false,
                None,
            ),
        );

        let err = verify_grant_chain("g1", TEST_NOW, &grants, &nodes).unwrap_err();
        assert!(matches!(err, GrantChainError::CircularChain(_)));
    }

    #[test]
    fn verb_entailment_basic() {
        // Same verb, no args → entailed.
        assert!(verb_entailed_by("read", "read"));
        // Parent unbounded → any child argument is a subset.
        assert!(verb_entailed_by("read:#leadership", "read"));
        // Child unbounded, parent scoped → widening, rejected.
        assert!(!verb_entailed_by("read", "read:#leadership"));
        // Spend: child ≤ parent.
        assert!(verb_entailed_by("spend:50000", "spend:100000"));
        assert!(!verb_entailed_by("spend:200000", "spend:100000"));
        // Different names → not entailed.
        assert!(!verb_entailed_by("task:create", "read"));
        // Channel scope: exact match or child contained by parent.
        assert!(verb_entailed_by("read:#eng", "read:#eng"));
        assert!(verb_entailed_by("read:#eng:frontend", "read:#eng"));
        // Different channels → not entailed (conservative).
        assert!(!verb_entailed_by("read:#eng", "read:#leadership"));
        // Substring prefixes are NOT containment: #l names a different
        // channel than #leadership.
        assert!(!verb_entailed_by("read:#l", "read:#leadership"));
    }

    #[test]
    fn grant_chain_rejects_channel_widening() {
        let pk_a = "a".repeat(64);
        let pk_b = "b".repeat(64);
        let mut nodes = std::collections::HashMap::new();
        nodes.insert(
            "cto".into(),
            make_node("cto", vec![&pk_a], vec!["read:#leadership"]),
        );
        nodes.insert("eng".into(), make_node("eng", vec![&pk_b], vec![]));

        let mut grants = std::collections::HashMap::new();
        // Root: read:#leadership
        grants.insert(
            "g1".into(),
            make_grant(
                "g1",
                &pk_a,
                &pk_b,
                "cto",
                vec!["read:#leadership"],
                None,
                false,
                None,
            ),
        );
        // Child: read:#l — a substring prefix, not a contained sub-channel.
        grants.insert(
            "g2".into(),
            make_grant(
                "g2",
                &pk_b,
                "c".repeat(64).as_str(),
                "eng",
                vec!["read:#l"],
                Some("g1"),
                false,
                None,
            ),
        );

        let err = verify_grant_chain("g2", TEST_NOW, &grants, &nodes).unwrap_err();
        assert!(matches!(err, GrantChainError::AttenuationViolation(_)));
    }

    #[test]
    fn grant_chain_accepts_channel_containment() {
        let pk_a = "a".repeat(64);
        let pk_b = "b".repeat(64);
        let mut nodes = std::collections::HashMap::new();
        nodes.insert(
            "cto".into(),
            make_node("cto", vec![&pk_a], vec!["read:#eng"]),
        );
        nodes.insert("eng".into(), make_node("eng", vec![&pk_b], vec![]));

        let mut grants = std::collections::HashMap::new();
        // Root: read:#eng
        grants.insert(
            "g1".into(),
            make_grant(
                "g1",
                &pk_a,
                &pk_b,
                "cto",
                vec!["read:#eng"],
                None,
                false,
                None,
            ),
        );
        // Child: read:#eng:frontend — contained by #eng.
        grants.insert(
            "g2".into(),
            make_grant(
                "g2",
                &pk_b,
                "c".repeat(64).as_str(),
                "eng",
                vec!["read:#eng:frontend"],
                Some("g1"),
                false,
                None,
            ),
        );

        assert!(verify_grant_chain("g2", TEST_NOW, &grants, &nodes).is_ok());
    }

    #[test]
    fn grant_chain_root_standing_compares_spend_argument() {
        let pk = "a".repeat(64);
        let mut nodes_over = std::collections::HashMap::new();
        nodes_over.insert(
            "cto".into(),
            make_node("cto", vec![&pk], vec!["spend:100000"]),
        );
        let mut grants_over = std::collections::HashMap::new();
        grants_over.insert(
            "g1".into(),
            make_grant(
                "g1",
                &pk,
                "b".repeat(64).as_str(),
                "cto",
                vec!["spend:999999"],
                None,
                false,
                None,
            ),
        );
        // Name matches but the ceiling is above the node's canGrant amount.
        let err = verify_grant_chain("g1", TEST_NOW, &grants_over, &nodes_over).unwrap_err();
        assert!(matches!(err, GrantChainError::RootLacksStanding(_, _)));

        // A spend within the node's ceiling has standing.
        let mut grants_under = std::collections::HashMap::new();
        grants_under.insert(
            "g1".into(),
            make_grant(
                "g1",
                &pk,
                "b".repeat(64).as_str(),
                "cto",
                vec!["spend:50000"],
                None,
                false,
                None,
            ),
        );
        assert!(verify_grant_chain("g1", TEST_NOW, &grants_under, &nodes_over).is_ok());
    }

    #[test]
    fn grant_chain_rejects_expired_grant() {
        let pk = "a".repeat(64);
        let mut nodes = std::collections::HashMap::new();
        nodes.insert("cto".into(), make_node("cto", vec![&pk], vec!["read"]));

        let mut grants = std::collections::HashMap::new();
        grants.insert(
            "g1".into(),
            make_grant(
                "g1",
                &pk,
                "b".repeat(64).as_str(),
                "cto",
                vec!["read"],
                None,
                false,
                Some(TEST_NOW - 1),
            ),
        );

        let err = verify_grant_chain("g1", TEST_NOW, &grants, &nodes).unwrap_err();
        assert!(matches!(err, GrantChainError::Expired(_, _)));
    }

    #[test]
    fn grant_chain_accepts_non_expired_grant() {
        let pk = "a".repeat(64);
        let mut nodes = std::collections::HashMap::new();
        nodes.insert("cto".into(), make_node("cto", vec![&pk], vec!["read"]));

        let mut grants = std::collections::HashMap::new();
        grants.insert(
            "g1".into(),
            make_grant(
                "g1",
                &pk,
                "b".repeat(64).as_str(),
                "cto",
                vec!["read"],
                None,
                false,
                Some(TEST_NOW + 1),
            ),
        );

        assert!(verify_grant_chain("g1", TEST_NOW, &grants, &nodes).is_ok());
    }

    #[test]
    fn grant_chain_at_max_depth_still_verifies() {
        // A 32-hop chain (33 grants including the root) is exactly at the
        // bound and must verify when every link attenuates.
        let pk = "a".repeat(64);
        let mut nodes = HashMap::new();
        nodes.insert("cto".into(), make_node("cto", vec![&pk], vec!["read"]));

        let mut grants = HashMap::new();
        let depth = MAX_GRANT_CHAIN_DEPTH; // 32 parent links
        for i in 0..=depth {
            let parent = if i == 0 {
                None
            } else {
                Some(format!("g{}", i - 1))
            };
            grants.insert(
                format!("g{i}"),
                make_grant(
                    &format!("g{i}"),
                    &pk,
                    &"b".repeat(64),
                    "cto",
                    vec!["read"],
                    parent.as_deref(),
                    false,
                    None,
                ),
            );
        }

        assert!(verify_grant_chain(&format!("g{depth}"), TEST_NOW, &grants, &nodes).is_ok());
    }

    #[test]
    fn grant_chain_rejects_depth_exceeded() {
        // 33 parent links — one past the bound. Every link attenuates and
        // the graph is acyclic, so only the depth bound rejects it.
        let pk = "a".repeat(64);
        let mut nodes = HashMap::new();
        nodes.insert("cto".into(), make_node("cto", vec![&pk], vec!["read"]));

        let mut grants = HashMap::new();
        let depth = MAX_GRANT_CHAIN_DEPTH + 1;
        for i in 0..=depth {
            let parent = if i == 0 {
                None
            } else {
                Some(format!("g{}", i - 1))
            };
            grants.insert(
                format!("g{i}"),
                make_grant(
                    &format!("g{i}"),
                    &pk,
                    &"b".repeat(64),
                    "cto",
                    vec!["read"],
                    parent.as_deref(),
                    false,
                    None,
                ),
            );
        }

        let err = verify_grant_chain(&format!("g{depth}"), TEST_NOW, &grants, &nodes).unwrap_err();
        assert!(matches!(err, GrantChainError::ChainDepthExceeded(_)));
    }
}
