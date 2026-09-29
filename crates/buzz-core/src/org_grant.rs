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
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
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

use std::future::Future;

// ── R1 authority anchor ───────────────────────────────────────────────────
//
// "One anchor of authority. Owner → seats → agents." (docs/dao-os.md R1.)
//
// The org graph is a set of community-level, globally addressed records:
// kind:37010 nodes are addressed by `(author, d)`, but everything that
// *refers* to a node or a grant (`parent`, `via`, `parentGrant`) names only the
// bare `d`. Two different authors can therefore publish records with the same
// `d`, and a resolver that takes "the newest record for this `d`" lets any
// member shadow a legitimate node or grant. The functions below resolve those
// references by *who signed them*:
//
// - a node is **anchored** when its author is the community owner/admin, or
//   its author holds a seat (`holders`) in an anchored parent node;
// - a node reference resolves to an anchored candidate, never to the newest
//   unanchored one;
// - a grant reference resolves to a candidate whose stored author is its own
//   `content.issuer`, whose grantee is the child grant's issuer, and whose
//   whole chain verifies.
//
// The decision logic is pure and I/O-free: it reads the graph through the
// [`OrgGraphSource`] trait, which the relay implements over Postgres and the
// tests implement over an in-memory graph.

/// Candidates fetched per `(kind, d)` coordinate when resolving a reference,
/// newest first. A community can hold at most one record per author for a
/// given `d`, so a legitimate reference never has more than a handful.
pub const MAX_ORG_CANDIDATES: usize = 32;

/// Maximum number of ancestors walked when deciding whether a node is
/// anchored. The walk is also cycle-safe (by node `d`).
pub const MAX_NODE_ANCHOR_DEPTH: usize = 16;

/// Maximum graph reads (candidate fetches and role checks) one authority
/// decision may perform. Exhausting the budget denies (fail closed): an
/// adversarial graph must not turn one ingest into unbounded I/O.
pub const MAX_ORG_LOOKUPS: usize = 256;

/// Wire value of `content.type` on kind:37011 records that record an equity
/// stake (the Project Board's ownership grant) rather than delegate
/// authority. Such records carry `verbs: []` and are exempt from grant-chain
/// verification; authority views must ignore them.
pub const ORG_GRANT_TYPE_EQUITY: &str = "equity";

/// Whether a parsed kind:37011 content object is an equity record
/// (`"type": "equity"`) rather than an authority grant.
pub fn is_equity_grant_content(content: &serde_json::Value) -> bool {
    content.get("type").and_then(|t| t.as_str()) == Some(ORG_GRANT_TYPE_EQUITY)
}

/// The kind:37010 content fields authority decisions need.
///
/// Parsed leniently (unknown fields are ignored) with camelCase keys per
/// NIP-ORG — in particular `agentSeats`. Absent seat and scope fields default
/// to empty, which fails closed (an empty node never confers standing).
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgNodeBody {
    /// `d` of the parent node; `None` (or empty) on a root.
    #[serde(default)]
    pub parent: Option<String>,
    /// Human seat holders (64-hex pubkeys).
    #[serde(default)]
    pub holders: Vec<String>,
    /// Agent seat holders (NIP-OA keys, 64-hex).
    #[serde(default)]
    pub agent_seats: Vec<String>,
    /// Delegation scope.
    #[serde(default)]
    pub scope: OrgScope,
}

/// A stored kind:37010 record with its signer, as the resolver sees it.
#[derive(Debug, Clone)]
pub struct StoredOrgNode {
    /// Signer of the event (lowercase 64-hex).
    pub author: String,
    /// Event `created_at` (unix seconds).
    pub created_at: u64,
    /// Event id (lowercase 64-hex) — deterministic tiebreak and cache key.
    pub event_id: String,
    /// `d` of the parent node, if any.
    pub parent: Option<String>,
    /// The parsed node (seat lists lowercased).
    pub node: ResolvedOrgNode,
}

/// A stored kind:37011 record with its signer, as the resolver sees it.
#[derive(Debug, Clone)]
pub struct StoredOrgGrant {
    /// Signer of the event (lowercase 64-hex).
    pub author: String,
    /// Event `created_at` (unix seconds).
    pub created_at: u64,
    /// Event id (lowercase 64-hex).
    pub event_id: String,
    /// The parsed grant (`issuer` / `grantee` lowercased).
    pub grant: ResolvedGrant,
}

/// Parse a stored kind:37010 event into a [`StoredOrgNode`].
///
/// Returns `None` for content that is not a valid org node body: such a record
/// can confer nothing, so the resolver simply never sees it as a candidate.
/// Pubkeys are lowercased so seat comparisons are case-insensitive.
pub fn parse_stored_node(
    author_hex: &str,
    created_at: u64,
    event_id: &str,
    d: &str,
    content: &str,
) -> Option<StoredOrgNode> {
    let body: OrgNodeBody = serde_json::from_str(content).ok()?;
    let lower = |v: Vec<String>| v.into_iter().map(|s| s.to_ascii_lowercase()).collect();
    Some(StoredOrgNode {
        author: author_hex.to_ascii_lowercase(),
        created_at,
        event_id: event_id.to_ascii_lowercase(),
        parent: body.parent.filter(|p| !p.is_empty()),
        node: ResolvedOrgNode {
            d: d.to_string(),
            holders: lower(body.holders),
            agent_seats: lower(body.agent_seats),
            scope: body.scope,
        },
    })
}

/// Parse a stored kind:37011 event into a [`StoredOrgGrant`].
///
/// Returns `None` for content that is not a valid org grant. Pubkeys are
/// lowercased. The signer-equals-issuer rule is applied by the resolver, not
/// here, so the record stays inspectable.
pub fn parse_stored_grant(
    author_hex: &str,
    created_at: u64,
    event_id: &str,
    d: &str,
    content: &str,
) -> Option<StoredOrgGrant> {
    let c: OrgGrantContent = serde_json::from_str(content).ok()?;
    Some(StoredOrgGrant {
        author: author_hex.to_ascii_lowercase(),
        created_at,
        event_id: event_id.to_ascii_lowercase(),
        grant: ResolvedGrant {
            d: d.to_string(),
            issuer: c.issuer.to_ascii_lowercase(),
            grantee: c.grantee.to_ascii_lowercase(),
            via: c.via,
            verbs: c.verbs,
            parent_grant: c.parent_grant,
            expires: c.expires,
            revoked: c.revoked,
        },
    })
}

/// Read access to the org graph for authority decisions.
///
/// Implementations return **candidates**: every stored, non-deleted,
/// community-level record for the coordinate, newest first, capped at
/// [`MAX_ORG_CANDIDATES`] — never a single pre-picked "latest" row. Choosing
/// among candidates is the resolver's job, because only the resolver knows
/// which candidate satisfies the authority rule.
///
/// All pubkeys are lowercase 64-hex.
pub trait OrgGraphSource: Sync {
    /// Error type of the backing store.
    type Error: Send;

    /// Whether `pubkey` is the community owner or an admin.
    fn is_community_admin(
        &self,
        pubkey: &str,
    ) -> impl Future<Output = Result<bool, Self::Error>> + Send;

    /// Kind:37010 candidates whose `d` tag is `d`.
    fn node_candidates(
        &self,
        d: &str,
    ) -> impl Future<Output = Result<Vec<StoredOrgNode>, Self::Error>> + Send;

    /// Kind:37010 records that list `pubkey` among their `holders`.
    fn nodes_held_by(
        &self,
        pubkey: &str,
    ) -> impl Future<Output = Result<Vec<StoredOrgNode>, Self::Error>> + Send;

    /// Kind:37011 candidates whose `d` tag is `d`.
    fn grant_candidates(
        &self,
        d: &str,
    ) -> impl Future<Output = Result<Vec<StoredOrgGrant>, Self::Error>> + Send;
}

/// Why an org write or an authority claim was refused.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum OrgDenial {
    /// A root node (no `parent`) was published by someone other than the
    /// community owner or an admin.
    #[error(
        "a root org node (no parent) may only be published by the community owner or an admin"
    )]
    RootRequiresAdmin,

    /// The node's author is neither the owner/admin nor a holder of an
    /// anchored parent node (or the parent does not exist).
    #[error("org node {0} is not anchored: its author is neither the community owner/admin nor a holder of an anchored parent node")]
    NotAnchored(String),

    /// Another author already publishes a node with this `d`; only the
    /// community owner/admin may reuse an id another author holds.
    #[error("org node id {0} is already used by another author")]
    IdOwnedByAnotherAuthor(String),

    /// A non-admin node asked for a `canGrant` verb its parent does not have.
    #[error(
        "org node scope widens its parent's: verb {0} is not entailed by the parent's canGrant"
    )]
    ScopeWidensParent(String),

    /// A grant's signer is not its claimed issuer.
    #[error("org grant `issuer` must be the event author")]
    IssuerNotAuthor,

    /// A default budget (`subject: "*"`) was published by someone other than
    /// the community owner or an admin.
    #[error(
        "a default budget (subject \"*\") may only be published by the community owner or an admin"
    )]
    DefaultBudgetRequiresAdmin,

    /// The budget's author may not budget this subject.
    #[error("a budget may only be published by the community owner/admin, an anchored seat holder, or its subject agent")]
    BudgetAuthorNotAuthorized,

    /// A referenced org node exists but no candidate is anchored.
    #[error("org node {0} is not anchored to the community owner or an admin")]
    NodeNotAnchored(String),

    /// The grant chain does not verify.
    #[error("{0}")]
    Chain(GrantChainError),

    /// The decision needed more graph reads than [`MAX_ORG_LOOKUPS`].
    #[error("org graph too large to verify: more than {MAX_ORG_LOOKUPS} lookups needed")]
    LookupBudgetExceeded,
}

/// Failure of an authority decision: a store error, or a denial.
#[derive(Debug)]
pub enum OrgAuthorityError<E> {
    /// The backing store failed; the caller must surface this as an error,
    /// never as an implicit allow or deny.
    Source(E),
    /// The graph was read and the claim does not hold.
    Denied(OrgDenial),
}

impl<E> From<OrgDenial> for OrgAuthorityError<E> {
    fn from(value: OrgDenial) -> Self {
        Self::Denied(value)
    }
}

type Res<T, S> = Result<T, OrgAuthorityError<<S as OrgGraphSource>::Error>>;

fn src_err<S: OrgGraphSource>(e: S::Error) -> OrgAuthorityError<S::Error> {
    OrgAuthorityError::Source(e)
}

/// Outcome of resolving a node reference (`parent`, `via`).
#[derive(Debug, Clone)]
pub enum NodeLookup {
    /// No record with this `d` exists.
    Missing,
    /// Records exist but none is anchored.
    Unanchored,
    /// The canonical anchored record.
    Found(Box<StoredOrgNode>),
}

/// Memoizing, budgeted walk over the graph for one decision.
struct Walk<'a, S: OrgGraphSource> {
    src: &'a S,
    lookups: usize,
    admin: std::collections::HashMap<String, bool>,
    anchored: std::collections::HashMap<String, bool>,
    canonical: std::collections::HashMap<String, NodeLookup>,
}

impl<'a, S: OrgGraphSource> Walk<'a, S> {
    fn new(src: &'a S) -> Self {
        Self {
            src,
            lookups: 0,
            admin: Default::default(),
            anchored: Default::default(),
            canonical: Default::default(),
        }
    }

    fn tick(&mut self) -> Res<(), S> {
        self.lookups += 1;
        if self.lookups > MAX_ORG_LOOKUPS {
            return Err(OrgDenial::LookupBudgetExceeded.into());
        }
        Ok(())
    }

    async fn is_admin(&mut self, pubkey: &str) -> Res<bool, S> {
        if let Some(hit) = self.admin.get(pubkey) {
            return Ok(*hit);
        }
        self.tick()?;
        let v = self
            .src
            .is_community_admin(pubkey)
            .await
            .map_err(src_err::<S>)?;
        self.admin.insert(pubkey.to_string(), v);
        Ok(v)
    }

    fn order(mut v: Vec<StoredOrgNode>) -> Vec<StoredOrgNode> {
        v.sort_by(|a, b| {
            b.created_at
                .cmp(&a.created_at)
                .then_with(|| a.event_id.cmp(&b.event_id))
        });
        v.truncate(MAX_ORG_CANDIDATES);
        v
    }

    async fn node_candidates(&mut self, d: &str) -> Res<Vec<StoredOrgNode>, S> {
        self.tick()?;
        let v = self.src.node_candidates(d).await.map_err(src_err::<S>)?;
        Ok(Self::order(v))
    }

    async fn nodes_held_by(&mut self, pubkey: &str) -> Res<Vec<StoredOrgNode>, S> {
        self.tick()?;
        let v = self.src.nodes_held_by(pubkey).await.map_err(src_err::<S>)?;
        Ok(Self::order(v))
    }

    async fn grant_candidates(&mut self, d: &str) -> Res<Vec<StoredOrgGrant>, S> {
        self.tick()?;
        let mut v = self.src.grant_candidates(d).await.map_err(src_err::<S>)?;
        v.sort_by(|a, b| {
            b.created_at
                .cmp(&a.created_at)
                .then_with(|| a.event_id.cmp(&b.event_id))
        });
        v.truncate(MAX_ORG_CANDIDATES);
        Ok(v)
    }

    /// Is `start` anchored? `seed` are node ids already on the path above it
    /// (the node being published, when `start` is its prospective parent), so
    /// a chain that loops back to an id it passed through is not anchored.
    async fn node_anchored(&mut self, start: &StoredOrgNode, seed: &[String]) -> Res<bool, S> {
        let memo = seed.is_empty();
        if memo {
            if let Some(hit) = self.anchored.get(&start.event_id) {
                return Ok(*hit);
            }
        }
        let mut path = seed.to_vec();
        path.push(start.node.d.clone());
        let mut stack = vec![(start.clone(), path)];
        let mut seen = std::collections::HashSet::new();
        let mut result = false;
        while let Some((cur, path)) = stack.pop() {
            if !seen.insert(cur.event_id.clone()) {
                continue;
            }
            if self.is_admin(&cur.author).await? {
                result = true;
                break;
            }
            let Some(parent) = cur.parent.as_deref() else {
                continue;
            };
            if path.len() >= MAX_NODE_ANCHOR_DEPTH || path.iter().any(|d| d == parent) {
                continue;
            }
            for p in self.node_candidates(parent).await? {
                if p.node.holders.iter().any(|h| *h == cur.author) {
                    let mut next = path.clone();
                    next.push(parent.to_string());
                    stack.push((p, next));
                }
            }
        }
        if memo {
            self.anchored.insert(start.event_id.clone(), result);
        }
        Ok(result)
    }

    /// The canonical anchored record for `d`: among the anchored candidates,
    /// an owner/admin-authored one wins, then the newest.
    async fn canonical_node(&mut self, d: &str) -> Res<NodeLookup, S> {
        if let Some(hit) = self.canonical.get(d) {
            return Ok(hit.clone());
        }
        let cands = self.node_candidates(d).await?;
        let result = if cands.is_empty() {
            NodeLookup::Missing
        } else {
            let mut best: Option<(bool, StoredOrgNode)> = None;
            for c in cands {
                if !self.node_anchored(&c, &[]).await? {
                    continue;
                }
                let admin = self.is_admin(&c.author).await?;
                let better = match &best {
                    None => true,
                    Some((best_admin, _)) => admin && !*best_admin,
                };
                if better {
                    best = Some((admin, c));
                }
            }
            match best {
                Some((_, node)) => NodeLookup::Found(Box::new(node)),
                None => NodeLookup::Unanchored,
            }
        };
        self.canonical.insert(d.to_string(), result.clone());
        Ok(result)
    }
}

fn first_unentailed(child: &[String], parent: &[String]) -> Option<String> {
    child
        .iter()
        .find(|v| !parent.iter().any(|p| verb_entailed_by(v, p)))
        .cloned()
}

/// Whether `pubkey` is the community owner/admin or holds a seat in an
/// anchored node — the "anchored human seat holder" of R1. Agent seats
/// (`agentSeats`) never count: authority to review, budget or create nodes
/// belongs to humans.
pub async fn is_authority_holder<S: OrgGraphSource>(
    src: &S,
    pubkey: &str,
) -> Result<bool, OrgAuthorityError<S::Error>> {
    let pubkey = pubkey.to_ascii_lowercase();
    let mut walk = Walk::new(src);
    holds_authority(&mut walk, &pubkey).await
}

async fn holds_authority<S: OrgGraphSource>(walk: &mut Walk<'_, S>, pubkey: &str) -> Res<bool, S> {
    if walk.is_admin(pubkey).await? {
        return Ok(true);
    }
    for node in walk.nodes_held_by(pubkey).await? {
        if node.node.holders.iter().any(|h| h == pubkey) && walk.node_anchored(&node, &[]).await? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Decide whether `author` may publish kind:37010 node `d`.
///
/// - The community owner/admin may publish any node.
/// - Anyone else may publish only a **child** of a node they hold a seat in,
///   where that parent is itself anchored, the child's `canGrant` is no wider
///   than the parent's (authority attenuates down the tree), and no other
///   author already publishes a node under the same `d`.
/// - A root node (no `parent`) therefore requires the owner/admin.
pub async fn check_node_publication<S: OrgGraphSource>(
    src: &S,
    author: &str,
    d: &str,
    parent: Option<&str>,
    can_grant: &[String],
) -> Result<(), OrgAuthorityError<S::Error>> {
    let author = author.to_ascii_lowercase();
    let mut walk = Walk::new(src);
    if walk.is_admin(&author).await? {
        return Ok(());
    }
    let Some(parent) = parent.filter(|p| !p.is_empty()) else {
        return Err(OrgDenial::RootRequiresAdmin.into());
    };
    if parent == d {
        return Err(OrgDenial::NotAnchored(d.to_string()).into());
    }
    for existing in walk.node_candidates(d).await? {
        if existing.author != author {
            return Err(OrgDenial::IdOwnedByAnotherAuthor(d.to_string()).into());
        }
    }
    let mut widened: Option<String> = None;
    for p in walk.node_candidates(parent).await? {
        if !p.node.holders.iter().any(|h| *h == author) {
            continue;
        }
        if let Some(verb) = first_unentailed(can_grant, &p.node.scope.can_grant) {
            widened.get_or_insert(verb);
            continue;
        }
        if walk.node_anchored(&p, &[d.to_string()]).await? {
            return Ok(());
        }
    }
    Err(match widened {
        Some(verb) => OrgDenial::ScopeWidensParent(verb),
        None => OrgDenial::NotAnchored(d.to_string()),
    }
    .into())
}

/// The standing under which a kind:37012 budget is published.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BudgetPublisher {
    /// The community owner or an admin.
    CommunityAdmin,
    /// The budgeted subject itself. Its budget only ever *adds* constraints:
    /// enforcement applies the strictest limit among every budget that covers
    /// the subject, and a subject-authored budget never displaces the default
    /// budget or an authority-authored one.
    Subject,
    /// A human holding a seat in an anchored node.
    AnchoredHolder,
}

/// Decide whether `author` may publish a kind:37012 budget for `subject`
/// (a 64-hex pubkey, or `"*"` for the community default).
///
/// - `"*"` (default budget): the community owner/admin only.
/// - Otherwise the owner/admin, the subject itself, or an anchored holder.
pub async fn check_budget_publisher<S: OrgGraphSource>(
    src: &S,
    author: &str,
    subject: &str,
) -> Result<BudgetPublisher, OrgAuthorityError<S::Error>> {
    let author = author.to_ascii_lowercase();
    let mut walk = Walk::new(src);
    if walk.is_admin(&author).await? {
        return Ok(BudgetPublisher::CommunityAdmin);
    }
    if subject == DEFAULT_BUDGET_SUBJECT {
        return Err(OrgDenial::DefaultBudgetRequiresAdmin.into());
    }
    if author.eq_ignore_ascii_case(subject) {
        return Ok(BudgetPublisher::Subject);
    }
    if holds_authority(&mut walk, &author).await? {
        return Ok(BudgetPublisher::AnchoredHolder);
    }
    Err(OrgDenial::BudgetAuthorNotAuthorized.into())
}

/// `content.subject` of the community default budget (R2): it covers every
/// agent that has no budget of its own.
pub const DEFAULT_BUDGET_SUBJECT: &str = "*";

/// Verify an incoming kind:37011 grant against the graph.
///
/// `author` is the event signer. A revoked grant is always admissible (a
/// revocation only removes authority). Otherwise the signer must be the
/// grant's issuer, and there must exist a chain of stored grants up to a root
/// grant such that:
///
/// - every stored grant was signed by its own `issuer`;
/// - every link's issuer is the previous link's grantee;
/// - every `via` resolves to an **anchored** node (see [`OrgGraphSource`] and
///   the module notes) in which the link's issuer holds a seat;
/// - attenuation, root standing, expiry and revocation hold
///   ([`verify_grant_chain`]).
///
/// When a `parentGrant` reference has several candidates, the first (newest)
/// whose whole chain verifies wins; a decoy record with the same `d` cannot
/// block or hijack a legitimate chain. On failure the first-encountered
/// error is reported.
pub async fn verify_incoming_grant<S: OrgGraphSource>(
    src: &S,
    author: &str,
    incoming: ResolvedGrant,
    now: u64,
) -> Result<(), OrgAuthorityError<S::Error>> {
    if incoming.revoked {
        return Ok(());
    }
    if !author.eq_ignore_ascii_case(&incoming.issuer) {
        return Err(OrgDenial::IssuerNotAuthor.into());
    }
    let mut walk = Walk::new(src);
    let mut first_err: Option<OrgDenial> = None;

    struct Frame {
        cands: Vec<ResolvedGrant>,
        next: usize,
    }
    fn note(slot: &mut Option<OrgDenial>, e: OrgDenial) {
        slot.get_or_insert(e);
    }
    let mut chain: Vec<ResolvedGrant> = vec![incoming];
    let mut frames: Vec<Frame> = Vec::new();

    'search: loop {
        // Descend from the current leaf until a root is reached or a link fails.
        loop {
            let Some(cur) = chain.last().cloned() else {
                break;
            };
            let Some(parent_d) = cur.parent_grant.clone() else {
                match verify_selected_chain(&mut walk, &chain, now).await {
                    Ok(()) => return Ok(()),
                    Err(OrgAuthorityError::Denied(e)) => note(&mut first_err, e),
                    Err(other) => return Err(other),
                }
                break;
            };
            if chain.iter().any(|g| g.d == parent_d) {
                note(
                    &mut first_err,
                    OrgDenial::Chain(GrantChainError::CircularChain(parent_d)),
                );
                break;
            }
            if chain.len() > MAX_GRANT_CHAIN_DEPTH {
                note(
                    &mut first_err,
                    OrgDenial::Chain(GrantChainError::ChainDepthExceeded(parent_d)),
                );
                break;
            }
            let stored = walk.grant_candidates(&parent_d).await?;
            // Addressed by `(issuer, 37011, d)`: a record whose signer is not
            // its claimed issuer is forged. Authority only chains from what
            // was delegated to the current link's issuer.
            let usable: Vec<ResolvedGrant> = stored
                .into_iter()
                .filter(|c| c.author == c.grant.issuer && c.grant.grantee == cur.issuer)
                .map(|c| c.grant)
                .collect();
            let Some(first) = usable.first().cloned() else {
                note(
                    &mut first_err,
                    OrgDenial::Chain(GrantChainError::ParentGrantNotFound(parent_d)),
                );
                break;
            };
            frames.push(Frame {
                cands: usable,
                next: 1,
            });
            chain.push(first);
        }

        // Backtrack to the next untried candidate.
        loop {
            chain.pop();
            match frames.last_mut() {
                None => {
                    return Err(first_err
                        .unwrap_or_else(|| {
                            OrgDenial::Chain(GrantChainError::ParentGrantNotFound(String::new()))
                        })
                        .into());
                }
                Some(frame) if frame.next < frame.cands.len() => {
                    let cand = frame.cands[frame.next].clone();
                    frame.next += 1;
                    chain.push(cand);
                    continue 'search;
                }
                Some(_) => {
                    frames.pop();
                }
            }
        }
    }
}

/// Verify one fully selected chain (incoming grant first, root last): resolve
/// every `via` to its canonical anchored node and run [`verify_grant_chain`].
async fn verify_selected_chain<S: OrgGraphSource>(
    walk: &mut Walk<'_, S>,
    chain: &[ResolvedGrant],
    now: u64,
) -> Res<(), S> {
    let mut nodes = std::collections::HashMap::new();
    for g in chain {
        if nodes.contains_key(&g.via) {
            continue;
        }
        match walk.canonical_node(&g.via).await? {
            NodeLookup::Found(n) => {
                nodes.insert(g.via.clone(), n.node);
            }
            NodeLookup::Missing => {
                return Err(OrgDenial::Chain(GrantChainError::NodeNotFound(g.via.clone())).into());
            }
            NodeLookup::Unanchored => {
                return Err(OrgDenial::NodeNotAnchored(g.via.clone()).into());
            }
        }
    }
    let grants: std::collections::HashMap<String, ResolvedGrant> =
        chain.iter().map(|g| (g.d.clone(), g.clone())).collect();
    let head = chain.first().map(|g| g.d.clone()).unwrap_or_default();
    verify_grant_chain(&head, now, &grants, &nodes)
        .map_err(|e| OrgAuthorityError::Denied(OrgDenial::Chain(e)))
}

/// One review event for a kind:37013 action id, as the ladder counts it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewRow {
    /// Action id (`d` tag) the review disposes.
    pub d: String,
    /// Signer of the review event (lowercase 64-hex).
    pub reviewer: String,
    /// Event `created_at` (unix seconds).
    pub created_at: u64,
    /// Event id (lowercase 64-hex) — deterministic tiebreak.
    pub event_id: String,
    /// The event's `reviewStatus` (`accepted` / `rejected` / `pending` / …).
    pub status: Option<String>,
}

/// Tally accepted/rejected contribution actions for `subject` from review
/// events.
///
/// The subject's own `reviewStatus` is never trusted. For each action id the
/// canonical disposition is the **newest review signed by an authorized
/// reviewer other than the subject** (ties: lowest event id); only that
/// event's status counts, so a later `pending`/`appealed` disposition by an
/// authorized reviewer supersedes an earlier `accepted`. Actions with no
/// authorized review count as neither.
///
/// Returns `(accepted, rejected)`.
pub fn tally_reviews(
    rows: &[ReviewRow],
    subject: &str,
    authorized: &std::collections::HashSet<String>,
) -> (u64, u64) {
    let mut canonical: std::collections::HashMap<&str, &ReviewRow> = Default::default();
    for row in rows {
        if row.reviewer.eq_ignore_ascii_case(subject) || !authorized.contains(&row.reviewer) {
            continue;
        }
        let replace = match canonical.get(row.d.as_str()) {
            None => true,
            Some(cur) => {
                row.created_at > cur.created_at
                    || (row.created_at == cur.created_at && row.event_id < cur.event_id)
            }
        };
        if replace {
            canonical.insert(row.d.as_str(), row);
        }
    }
    let mut accepted = 0u64;
    let mut rejected = 0u64;
    for row in canonical.values() {
        match row.status.as_deref() {
            Some("accepted") => accepted += 1,
            Some("rejected") => rejected += 1,
            _ => {}
        }
    }
    (accepted, rejected)
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

#[cfg(test)]
mod authority_tests {
    //! R1 authority-anchor tests over an in-memory graph. The graph
    //! implements [`OrgGraphSource`] exactly as the relay's Postgres adapter
    //! does, so these bind the production decision functions
    //! ([`check_node_publication`], [`verify_incoming_grant`],
    //! [`check_budget_publisher`], [`tally_reviews`]) — not test-only helpers.
    use super::*;
    use std::collections::HashSet;

    const NOW: u64 = 1_700_000_000;

    fn pk(c: char) -> String {
        c.to_string().repeat(64)
    }

    #[derive(Default)]
    struct MemGraph {
        admins: HashSet<String>,
        nodes: Vec<StoredOrgNode>,
        grants: Vec<StoredOrgGrant>,
        seq: u64,
    }

    impl MemGraph {
        fn next_id(&mut self) -> String {
            self.seq += 1;
            format!("{:064x}", self.seq)
        }

        fn admin(mut self, who: &str) -> Self {
            self.admins.insert(who.to_string());
            self
        }

        #[allow(clippy::too_many_arguments)]
        fn node(
            mut self,
            author: &str,
            d: &str,
            parent: Option<&str>,
            holders: &[&str],
            agents: &[&str],
            can_grant: &[&str],
        ) -> Self {
            let id = self.next_id();
            self.nodes.push(StoredOrgNode {
                author: author.to_string(),
                created_at: NOW - 1_000 + self.seq,
                event_id: id,
                parent: parent.map(String::from),
                node: ResolvedOrgNode {
                    d: d.to_string(),
                    holders: holders.iter().map(|s| s.to_string()).collect(),
                    agent_seats: agents.iter().map(|s| s.to_string()).collect(),
                    scope: OrgScope {
                        read_below: true,
                        assign_below: true,
                        can_grant: can_grant.iter().map(|s| s.to_string()).collect(),
                    },
                },
            });
            self
        }

        #[allow(clippy::too_many_arguments)]
        fn grant(
            mut self,
            author: &str,
            d: &str,
            issuer: &str,
            grantee: &str,
            via: &str,
            verbs: &[&str],
            parent: Option<&str>,
        ) -> Self {
            let id = self.next_id();
            self.grants.push(StoredOrgGrant {
                author: author.to_string(),
                created_at: NOW - 1_000 + self.seq,
                event_id: id,
                grant: ResolvedGrant {
                    d: d.to_string(),
                    issuer: issuer.to_string(),
                    grantee: grantee.to_string(),
                    via: via.to_string(),
                    verbs: verbs.iter().map(|s| s.to_string()).collect(),
                    parent_grant: parent.map(String::from),
                    expires: None,
                    revoked: false,
                },
            });
            self
        }
    }

    impl OrgGraphSource for MemGraph {
        type Error = String;

        async fn is_community_admin(&self, pubkey: &str) -> Result<bool, String> {
            Ok(self.admins.contains(pubkey))
        }

        async fn node_candidates(&self, d: &str) -> Result<Vec<StoredOrgNode>, String> {
            Ok(self
                .nodes
                .iter()
                .filter(|n| n.node.d == d)
                .cloned()
                .collect())
        }

        async fn nodes_held_by(&self, pubkey: &str) -> Result<Vec<StoredOrgNode>, String> {
            Ok(self
                .nodes
                .iter()
                .filter(|n| n.node.holders.iter().any(|h| h == pubkey))
                .cloned()
                .collect())
        }

        async fn grant_candidates(&self, d: &str) -> Result<Vec<StoredOrgGrant>, String> {
            Ok(self
                .grants
                .iter()
                .filter(|g| g.grant.d == d)
                .cloned()
                .collect())
        }
    }

    /// Minimal executor: every future in this module is immediately ready
    /// (the in-memory graph never yields), so a no-op-waker poll loop is
    /// enough and keeps buzz-core free of an async runtime dependency.
    fn block_on<F: Future>(fut: F) -> F::Output {
        let mut fut = std::pin::pin!(fut);
        let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
        loop {
            if let std::task::Poll::Ready(v) = fut.as_mut().poll(&mut cx) {
                return v;
            }
        }
    }

    fn denied<T: std::fmt::Debug>(r: Result<T, OrgAuthorityError<String>>) -> OrgDenial {
        match r {
            Err(OrgAuthorityError::Denied(d)) => d,
            other => panic!("expected a denial, got {other:?}"),
        }
    }

    fn incoming(
        issuer: &str,
        grantee: &str,
        via: &str,
        verbs: &[&str],
        parent: Option<&str>,
    ) -> ResolvedGrant {
        ResolvedGrant {
            d: "incoming".into(),
            issuer: issuer.into(),
            grantee: grantee.into(),
            via: via.into(),
            verbs: verbs.iter().map(|s| s.to_string()).collect(),
            parent_grant: parent.map(String::from),
            expires: None,
            revoked: false,
        }
    }

    fn strings(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    // ── node publication ──────────────────────────────────────────────────

    #[test]
    fn root_node_requires_admin() {
        let (owner, member) = (pk('a'), pk('b'));
        let g = MemGraph::default().admin(&owner);
        assert!(block_on(check_node_publication(&g, &owner, "root", None, &[])).is_ok());
        assert_eq!(
            denied(block_on(check_node_publication(
                &g,
                &member,
                "root",
                None,
                &[]
            ))),
            OrgDenial::RootRequiresAdmin
        );
        // An empty `parent` string is a root too.
        assert_eq!(
            denied(block_on(check_node_publication(
                &g,
                &member,
                "root",
                Some(""),
                &[]
            ))),
            OrgDenial::RootRequiresAdmin
        );
    }

    /// The finding: any member could publish node `cto` with themselves as
    /// holder. Without an anchored parent they now cannot.
    #[test]
    fn member_cannot_self_seat_a_node_under_a_missing_or_foreign_parent() {
        let (owner, alice, mallory) = (pk('a'), pk('b'), pk('c'));
        let g =
            MemGraph::default()
                .admin(&owner)
                .node(&owner, "root", None, &[&alice], &[], &["read"]);
        // Parent does not exist.
        assert!(matches!(
            denied(block_on(check_node_publication(
                &g,
                &mallory,
                "cto",
                Some("nope"),
                &[]
            ))),
            OrgDenial::NotAnchored(_)
        ));
        // Parent exists, but mallory does not hold it.
        assert!(matches!(
            denied(block_on(check_node_publication(
                &g,
                &mallory,
                "cto",
                Some("root"),
                &[]
            ))),
            OrgDenial::NotAnchored(_)
        ));
        // Alice, a holder of the anchored root, may create a child.
        assert!(block_on(check_node_publication(&g, &alice, "cto", Some("root"), &[])).is_ok());
    }

    #[test]
    fn agent_seat_cannot_anchor_children() {
        let (owner, agent) = (pk('a'), pk('b'));
        let g =
            MemGraph::default()
                .admin(&owner)
                .node(&owner, "root", None, &[], &[&agent], &["read"]);
        assert!(matches!(
            denied(block_on(check_node_publication(
                &g,
                &agent,
                "kid",
                Some("root"),
                &[]
            ))),
            OrgDenial::NotAnchored(_)
        ));
    }

    #[test]
    fn unanchored_parent_does_not_anchor_a_child() {
        let (owner, alice, mallory) = (pk('a'), pk('b'), pk('c'));
        // `fake` was published by mallory before the fix (no anchor); mallory
        // holds it. A child of `fake` must not be anchored through it.
        let g = MemGraph::default()
            .admin(&owner)
            .node(&owner, "root", None, &[&alice], &[], &["read"])
            .node(&mallory, "fake", None, &[&mallory], &[], &["read"]);
        assert!(matches!(
            denied(block_on(check_node_publication(
                &g,
                &mallory,
                "kid",
                Some("fake"),
                &[]
            ))),
            OrgDenial::NotAnchored(_)
        ));
    }

    #[test]
    fn descendant_anchoring_walks_several_levels() {
        let (owner, alice, bob, carol) = (pk('a'), pk('b'), pk('c'), pk('d'));
        let g = MemGraph::default()
            .admin(&owner)
            .node(&owner, "root", None, &[&alice], &[], &["read", "task"])
            .node(&alice, "eng", Some("root"), &[&bob], &[], &["read"])
            .node(&bob, "infra", Some("eng"), &[&carol], &[], &["read"]);
        assert!(block_on(check_node_publication(
            &g,
            &carol,
            "oncall",
            Some("infra"),
            &[]
        ))
        .is_ok());
    }

    #[test]
    fn id_reuse_across_authors_is_refused_for_non_admins() {
        let (owner, alice, bob) = (pk('a'), pk('b'), pk('c'));
        let g = MemGraph::default()
            .admin(&owner)
            .node(&owner, "root", None, &[&alice, &bob], &[], &["read"])
            .node(&alice, "eng", Some("root"), &[&alice], &[], &[]);
        // Bob (also a holder of root) may not publish a second `eng`.
        assert_eq!(
            denied(block_on(check_node_publication(
                &g,
                &bob,
                "eng",
                Some("root"),
                &[]
            ))),
            OrgDenial::IdOwnedByAnotherAuthor("eng".into())
        );
        // Alice may replace her own.
        assert!(block_on(check_node_publication(&g, &alice, "eng", Some("root"), &[])).is_ok());
        // The owner may always publish.
        assert!(block_on(check_node_publication(&g, &owner, "eng", Some("root"), &[])).is_ok());
    }

    /// A holder of `design` may not publish a node named like the owner's
    /// `cto` — nor loop a chain back through an id it already passed.
    #[test]
    fn id_cycle_through_a_descendant_is_not_anchored() {
        let (owner, alice, bob) = (pk('a'), pk('b'), pk('c'));
        let g = MemGraph::default()
            .admin(&owner)
            .node(&owner, "cto", None, &[&alice], &[], &["read"])
            .node(&alice, "eng", Some("cto"), &[&bob], &[], &["read"]);
        // Bob publishes `cto` with parent `eng`: cto -> eng -> cto.
        let r = block_on(check_node_publication(&g, &bob, "cto", Some("eng"), &[]));
        assert!(matches!(
            denied(r),
            OrgDenial::IdOwnedByAnotherAuthor(_) | OrgDenial::NotAnchored(_)
        ));
        // With a free id the same chain is only refused by the cycle rule
        // when the id repeats: `x` under `eng` is fine.
        assert!(block_on(check_node_publication(&g, &bob, "x", Some("eng"), &[])).is_ok());
    }

    #[test]
    fn child_scope_cannot_widen_the_parents() {
        let (owner, alice) = (pk('a'), pk('b'));
        let g = MemGraph::default().admin(&owner).node(
            &owner,
            "root",
            None,
            &[&alice],
            &[],
            &["read", "spend:1000"],
        );
        assert!(block_on(check_node_publication(
            &g,
            &alice,
            "eng",
            Some("root"),
            &strings(&["read", "spend:500"])
        ))
        .is_ok());
        assert_eq!(
            denied(block_on(check_node_publication(
                &g,
                &alice,
                "eng",
                Some("root"),
                &strings(&["spend:999999"])
            ))),
            OrgDenial::ScopeWidensParent("spend:999999".into())
        );
        // Admin is unconstrained.
        assert!(block_on(check_node_publication(
            &g,
            &owner,
            "eng",
            Some("root"),
            &strings(&["spend:999999"])
        ))
        .is_ok());
    }

    #[test]
    fn deep_chain_is_bounded() {
        let (owner, alice) = (pk('a'), pk('b'));
        let mut g = MemGraph::default()
            .admin(&owner)
            .node(&owner, "n0", None, &[&alice], &[], &[]);
        for i in 1..=(MAX_NODE_ANCHOR_DEPTH + 4) {
            g = g.node(
                &alice,
                &format!("n{i}"),
                Some(&format!("n{}", i - 1)),
                &[&alice],
                &[],
                &[],
            );
        }
        // Within the cap: anchored.
        assert!(block_on(check_node_publication(&g, &alice, "leaf", Some("n3"), &[])).is_ok());
        // Beyond the cap: refused rather than walked without bound.
        let deep = format!("n{}", MAX_NODE_ANCHOR_DEPTH + 4);
        assert!(matches!(
            denied(block_on(check_node_publication(
                &g,
                &alice,
                "leaf",
                Some(&deep),
                &[]
            ))),
            OrgDenial::NotAnchored(_)
        ));
    }

    // ── grant chains: candidate selection ─────────────────────────────────

    /// The shadowing finding: mallory publishes a *newer* node `cto` naming
    /// herself. The grant `via: cto` must resolve to the anchored one.
    #[test]
    fn newer_unanchored_node_does_not_shadow_the_anchored_one() {
        let (owner, alice, mallory, bob) = (pk('a'), pk('b'), pk('c'), pk('d'));
        let g = MemGraph::default()
            .admin(&owner)
            .node(&owner, "cto", None, &[&alice], &[], &["spend:100000"])
            // newer, unanchored decoy
            .node(&mallory, "cto", None, &[&mallory], &[], &["spend:9999999"]);
        // Mallory cannot claim standing through her decoy.
        let r = block_on(verify_incoming_grant(
            &g,
            &mallory,
            incoming(&mallory, &bob, "cto", &["spend:9999999"], None),
            NOW,
        ));
        assert!(matches!(
            denied(r),
            OrgDenial::Chain(GrantChainError::IssuerNotSeated(_, _))
        ));
        // Alice, the legitimate holder, still verifies.
        assert!(block_on(verify_incoming_grant(
            &g,
            &alice,
            incoming(&alice, &bob, "cto", &["spend:100000"], None),
            NOW,
        ))
        .is_ok());
    }

    #[test]
    fn grant_via_a_wholly_unanchored_node_is_refused() {
        let (owner, mallory, bob) = (pk('a'), pk('c'), pk('d'));
        let g = MemGraph::default().admin(&owner).node(
            &mallory,
            "cto",
            None,
            &[&mallory],
            &[],
            &["spend:100000"],
        );
        let r = block_on(verify_incoming_grant(
            &g,
            &mallory,
            incoming(&mallory, &bob, "cto", &["spend:1"], None),
            NOW,
        ));
        assert_eq!(denied(r), OrgDenial::NodeNotAnchored("cto".into()));
    }

    #[test]
    fn missing_node_is_not_found() {
        let g = MemGraph::default();
        let a = pk('a');
        let r = block_on(verify_incoming_grant(
            &g,
            &a,
            incoming(&a, &pk('b'), "ghost", &["read"], None),
            NOW,
        ));
        assert!(matches!(
            denied(r),
            OrgDenial::Chain(GrantChainError::NodeNotFound(_))
        ));
    }

    /// A newer decoy grant with the same `d` as a legitimate parent (its
    /// issuer is not seated anywhere) must not block or hijack the chain.
    #[test]
    fn decoy_parent_grant_cannot_block_or_hijack_the_chain() {
        let (owner, alice, bob, carol, mallory) = (pk('a'), pk('b'), pk('c'), pk('d'), pk('e'));
        let g = MemGraph::default()
            .admin(&owner)
            .node(&owner, "cto", None, &[&alice], &[], &["spend:100000"])
            .node(&alice, "eng", Some("cto"), &[&bob], &[], &["spend:100000"])
            .grant(&alice, "g1", &alice, &bob, "cto", &["spend:100000"], None)
            // Newer decoy under the same `d`, signed by an unseated key,
            // naming bob as grantee with wider verbs.
            .grant(
                &mallory,
                "g1",
                &mallory,
                &bob,
                "cto",
                &["spend:9999999"],
                None,
            );
        let ok = block_on(verify_incoming_grant(
            &g,
            &bob,
            incoming(&bob, &carol, "eng", &["spend:50000"], Some("g1")),
            NOW,
        ));
        assert!(ok.is_ok(), "the legitimate chain must still verify: {ok:?}");
        // …and the decoy's wider verbs are not usable as a parent.
        let wide = block_on(verify_incoming_grant(
            &g,
            &bob,
            incoming(&bob, &carol, "eng", &["spend:9999999"], Some("g1")),
            NOW,
        ));
        // The first (newest) candidate's error is reported: the decoy's
        // unseated issuer — the wider verbs never verify through it.
        assert!(matches!(
            denied(wide),
            OrgDenial::Chain(GrantChainError::IssuerNotSeated(_, _))
        ));
    }

    #[test]
    fn stored_grant_signed_by_someone_else_is_not_a_parent() {
        let (owner, alice, bob, carol, mallory) = (pk('a'), pk('b'), pk('c'), pk('d'), pk('e'));
        let g = MemGraph::default()
            .admin(&owner)
            .node(&owner, "cto", None, &[&alice], &[], &["spend:100000"])
            .node(&alice, "eng", Some("cto"), &[&bob], &[], &["read"])
            // Claims alice as issuer but was signed by mallory.
            .grant(&mallory, "g1", &alice, &bob, "cto", &["spend:100000"], None);
        let r = block_on(verify_incoming_grant(
            &g,
            &bob,
            incoming(&bob, &carol, "eng", &["spend:10"], Some("g1")),
            NOW,
        ));
        assert!(matches!(
            denied(r),
            OrgDenial::Chain(GrantChainError::ParentGrantNotFound(_))
        ));
    }

    #[test]
    fn parent_grant_must_have_been_delegated_to_the_issuer() {
        let (owner, alice, bob, carol, dave) = (pk('a'), pk('b'), pk('c'), pk('d'), pk('e'));
        let g = MemGraph::default()
            .admin(&owner)
            .node(&owner, "cto", None, &[&alice], &[], &["read"])
            .node(&alice, "eng", Some("cto"), &[&bob, &dave], &[], &["read"])
            .grant(&alice, "g1", &alice, &bob, "cto", &["read"], None);
        // Dave holds a seat but g1 was delegated to bob, not dave.
        let r = block_on(verify_incoming_grant(
            &g,
            &dave,
            incoming(&dave, &carol, "eng", &["read"], Some("g1")),
            NOW,
        ));
        assert!(matches!(
            denied(r),
            OrgDenial::Chain(GrantChainError::ParentGrantNotFound(_))
        ));
    }

    #[test]
    fn issuer_must_be_the_signer_and_revocation_is_always_admissible() {
        let (a, b) = (pk('a'), pk('b'));
        let g = MemGraph::default();
        assert_eq!(
            denied(block_on(verify_incoming_grant(
                &g,
                &b,
                incoming(&a, &b, "n", &["read"], None),
                NOW
            ))),
            OrgDenial::IssuerNotAuthor
        );
        let mut revoked = incoming(&a, &b, "n", &["read"], None);
        revoked.revoked = true;
        assert!(block_on(verify_incoming_grant(&g, &a, revoked, NOW)).is_ok());
    }

    /// Item 2: an agent-held seat can anchor a chain (the node carries the
    /// key under `agentSeats`).
    #[test]
    fn agent_seat_can_issue_a_root_grant() {
        let (owner, agent, bob) = (pk('a'), pk('b'), pk('c'));
        let g =
            MemGraph::default()
                .admin(&owner)
                .node(&owner, "bot", None, &[], &[&agent], &["read"]);
        assert!(block_on(verify_incoming_grant(
            &g,
            &agent,
            incoming(&agent, &bob, "bot", &["read"], None),
            NOW
        ))
        .is_ok());
    }

    #[test]
    fn lookup_budget_bounds_a_pathological_graph() {
        // Every node lists the same holder under many parents: the walk must
        // terminate with a denial, not loop or fan out unboundedly.
        let (owner, alice) = (pk('a'), pk('b'));
        let mut g = MemGraph::default().admin(&owner);
        for i in 0..40 {
            g = g.node(
                &alice,
                &format!("n{i}"),
                Some(&format!("n{}", (i + 1) % 40)),
                &[&alice],
                &[],
                &[],
            );
        }
        // The whole ring is unanchored: every candidate fails, quickly.
        assert!(matches!(
            denied(block_on(check_node_publication(
                &g,
                &alice,
                "x",
                Some("n0"),
                &[]
            ))),
            OrgDenial::NotAnchored(_) | OrgDenial::LookupBudgetExceeded
        ));
    }

    // ── budgets ───────────────────────────────────────────────────────────

    #[test]
    fn budget_publisher_rules() {
        let (owner, alice, agent, stranger) = (pk('a'), pk('b'), pk('c'), pk('d'));
        let g =
            MemGraph::default()
                .admin(&owner)
                .node(&owner, "root", None, &[&alice], &[], &["read"]);
        let who = |a: &str, subject: &str| block_on(check_budget_publisher(&g, a, subject));

        assert_eq!(
            who(&owner, &agent).unwrap(),
            BudgetPublisher::CommunityAdmin
        );
        assert_eq!(who(&owner, "*").unwrap(), BudgetPublisher::CommunityAdmin);
        assert_eq!(who(&agent, &agent).unwrap(), BudgetPublisher::Subject);
        assert_eq!(
            who(&alice, &agent).unwrap(),
            BudgetPublisher::AnchoredHolder
        );
        // Default budget: admin only — not a seat holder, not an agent.
        assert_eq!(
            denied(who(&alice, "*")),
            OrgDenial::DefaultBudgetRequiresAdmin
        );
        assert_eq!(
            denied(who(&agent, "*")),
            OrgDenial::DefaultBudgetRequiresAdmin
        );
        assert_eq!(
            denied(who(&stranger, &agent)),
            OrgDenial::BudgetAuthorNotAuthorized
        );
    }

    #[test]
    fn unanchored_holder_cannot_budget_others() {
        let (owner, mallory, agent) = (pk('a'), pk('c'), pk('d'));
        let g =
            MemGraph::default()
                .admin(&owner)
                .node(&mallory, "cto", None, &[&mallory], &[], &[]);
        assert_eq!(
            denied(block_on(check_budget_publisher(&g, &mallory, &agent))),
            OrgDenial::BudgetAuthorNotAuthorized
        );
    }

    #[test]
    fn authority_holder_covers_admin_and_anchored_seats_only() {
        let (owner, alice, agent, mallory) = (pk('a'), pk('b'), pk('c'), pk('d'));
        let g = MemGraph::default()
            .admin(&owner)
            .node(&owner, "root", None, &[&alice], &[&agent], &[])
            .node(&mallory, "fake", None, &[&mallory], &[], &[]);
        let is = |who: &str| block_on(is_authority_holder(&g, who)).unwrap();
        assert!(is(&owner));
        assert!(is(&alice));
        assert!(!is(&agent), "agent seats never review or budget");
        assert!(!is(&mallory), "an unanchored seat confers nothing");
    }

    // ── contribution review tally ─────────────────────────────────────────

    fn review(d: &str, reviewer: &str, at: u64, id: u64, status: &str) -> ReviewRow {
        ReviewRow {
            d: d.into(),
            reviewer: reviewer.into(),
            created_at: at,
            event_id: format!("{id:064x}"),
            status: Some(status.into()),
        }
    }

    #[test]
    fn tally_ignores_the_subject_and_unauthorized_reviewers() {
        let (subject, reviewer, outsider) = (pk('a'), pk('b'), pk('c'));
        let authorized: HashSet<String> = [reviewer.clone()].into_iter().collect();
        let rows = vec![
            // The agent grades itself: never counts.
            review("t1", &subject, 10, 1, "accepted"),
            // A random member grades it: never counts.
            review("t1", &outsider, 11, 2, "accepted"),
            // An authorized reviewer accepts t2 and rejects t3.
            review("t2", &reviewer, 12, 3, "accepted"),
            review("t3", &reviewer, 13, 4, "rejected"),
        ];
        assert_eq!(tally_reviews(&rows, &subject, &authorized), (1, 1));
    }

    #[test]
    fn tally_takes_the_newest_authorized_disposition() {
        let (subject, r1, r2) = (pk('a'), pk('b'), pk('c'));
        let authorized: HashSet<String> = [r1.clone(), r2.clone()].into_iter().collect();
        // accepted, then re-opened as pending by a second reviewer: neither.
        let rows = vec![
            review("t1", &r1, 10, 1, "accepted"),
            review("t1", &r2, 20, 2, "pending"),
        ];
        assert_eq!(tally_reviews(&rows, &subject, &authorized), (0, 0));
        // An unauthorized *newer* verdict cannot supersede an authorized one.
        let rows = vec![
            review("t1", &r1, 10, 1, "accepted"),
            review("t1", &pk('z'), 20, 2, "rejected"),
        ];
        assert_eq!(tally_reviews(&rows, &subject, &authorized), (1, 0));
        // Equal timestamps: the lowest event id wins, deterministically.
        let rows = vec![
            review("t1", &r1, 10, 5, "accepted"),
            review("t1", &r2, 10, 4, "rejected"),
        ];
        assert_eq!(tally_reviews(&rows, &subject, &authorized), (0, 1));
    }

    // ── content parsing ───────────────────────────────────────────────────

    /// Item 2: the wire key is `agentSeats` (camelCase). The exact JSON the
    /// SDK builder emits must populate the agent seats.
    #[test]
    fn node_body_parses_camel_case_agent_seats() {
        let agent = pk('b');
        let json = format!(
            r#"{{"v":1,"name":"Bot","kind":"agent-seat","parent":"root","holders":["{}"],"agentSeats":["{}"],"scope":{{"readBelow":true,"assignBelow":false,"canGrant":["read"]}}}}"#,
            pk('a'),
            agent.to_uppercase()
        );
        let n = parse_stored_node(&pk('c'), 5, &pk('d'), "bot", &json).expect("parses");
        assert_eq!(n.node.agent_seats, vec![agent], "agentSeats, lowercased");
        assert_eq!(n.node.holders, vec![pk('a')]);
        assert_eq!(n.parent.as_deref(), Some("root"));
        assert_eq!(n.node.scope.can_grant, vec!["read".to_string()]);
    }

    #[test]
    fn malformed_node_and_grant_content_is_not_a_candidate() {
        assert!(parse_stored_node(&pk('a'), 1, &pk('b'), "n", "not json").is_none());
        assert!(parse_stored_node(&pk('a'), 1, &pk('b'), "n", r#"{"holders":"x"}"#).is_none());
        assert!(parse_stored_grant(&pk('a'), 1, &pk('b'), "g", r#"{"v":1}"#).is_none());
    }

    #[test]
    fn equity_marker_is_recognized() {
        assert!(is_equity_grant_content(
            &serde_json::json!({"type":"equity"})
        ));
        assert!(!is_equity_grant_content(
            &serde_json::json!({"type":"authority"})
        ));
        assert!(!is_equity_grant_content(&serde_json::json!({"verbs":[]})));
    }
}
