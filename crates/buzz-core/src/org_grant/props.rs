//! Property tests for the R1 authority resolver.
//!
//! The production decision functions ([`check_node_publication`],
//! [`verify_incoming_grant`], [`is_authority_holder`], [`check_budget_publisher`],
//! [`tally_reviews`]) run here over an in-memory [`OrgGraphSource`] holding
//! *random* org graphs — including adversarial ones with same-`d` decoys,
//! forged grant authors, cycles, revoked and expired links. Each property
//! compares them with a deliberately naive oracle (a fixpoint for anchoring, an
//! exhaustive search for grant chains), so a bug has to be wrong in two
//! independently written places to survive.
//!
//! What they pin, in order of importance:
//!
//! 1. **Soundness of anchoring** — the resolver never anchors a node the
//!    oracle would not (a wrong "yes" is a privilege escalation).
//! 2. **Decoy invariance** — records authored by someone with no seat in any
//!    anchored node can neither grant nor remove authority for anyone else,
//!    however they are named or ordered.
//! 3. **Chain equivalence** — an incoming grant is accepted exactly when some
//!    chain of stored grants attenuates all the way to a canGrant, with every
//!    link signed by its own issuer and every issuer seated in an anchored node.
//! 4. **Entailment is a preorder** — attenuation composes, so a chain of
//!    individually valid hops can never widen scope.
//! 5. **Review tally** — a subject's own review and unauthorized reviews never
//!    count, and the canonical review per action is the newest authorized one.

use super::*;
use proptest::prelude::*;
use std::collections::HashSet;

const NOW: u64 = 1_700_000_000;
const ACTORS: usize = 5;
const NODE_DS: usize = 5;
const GRANT_DS: usize = 5;
/// The attacker in the decoy properties. Never an admin by construction.
const ATTACKER: usize = 4;
const VERBS: [&str; 8] = [
    "spend:100",
    "spend:50",
    "spend:10",
    "task:create",
    "read",
    "read:#eng",
    "read:#eng:fe",
    "read:#ops",
];

fn actor(i: usize) -> String {
    char::from(b'a' + i as u8).to_string().repeat(64)
}
fn node_d(i: usize) -> String {
    format!("n{i}")
}
fn grant_d(i: usize) -> String {
    format!("g{i}")
}
fn verbs_of(ix: &[usize]) -> Vec<String> {
    ix.iter().map(|i| VERBS[*i].to_string()).collect()
}

// ── random graphs ─────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct NodeSpec {
    author: usize,
    d: usize,
    parent: Option<usize>,
    holders: Vec<usize>,
    agents: Vec<usize>,
    can_grant: Vec<usize>,
}

#[derive(Debug, Clone)]
struct GrantSpec {
    author: usize,
    d: usize,
    issuer: usize,
    grantee: usize,
    via: usize,
    verbs: Vec<usize>,
    parent: Option<usize>,
    revoked: bool,
    expires: Option<u64>,
}

#[derive(Debug, Clone)]
struct Spec {
    admins: Vec<usize>,
    nodes: Vec<NodeSpec>,
    grants: Vec<GrantSpec>,
}

/// The incoming grant a decision is asked about. Its `d` is outside the stored
/// `g*` space, as a fresh publication's is.
#[derive(Debug, Clone)]
struct Incoming {
    issuer: usize,
    grantee: usize,
    via: usize,
    verbs: Vec<usize>,
    parent: Option<usize>,
}

fn ix(max: usize, n: usize) -> impl Strategy<Value = Vec<usize>> {
    prop::collection::vec(0..max, 0..=n)
}

/// `acyclic`: a node's `parent` is always a strictly smaller `d` index, so no
/// chain of `d` values repeats. Under that shape the resolver's per-`d` path
/// guard and a plain fixpoint agree exactly; without it the resolver is
/// allowed to be *stricter* (never looser) than the fixpoint.
fn node_spec(acyclic: bool) -> impl Strategy<Value = NodeSpec> {
    (
        0..ACTORS,
        0..NODE_DS,
        prop::option::weighted(0.7, 0..NODE_DS),
        ix(ACTORS, 3),
        ix(ACTORS, 2),
        ix(VERBS.len(), 4),
    )
        .prop_map(
            move |(author, d, parent, holders, agents, can_grant)| NodeSpec {
                author,
                d,
                parent: if acyclic {
                    parent.filter(|p| *p < d)
                } else {
                    parent
                },
                holders,
                agents,
                can_grant,
            },
        )
}

fn grant_spec() -> impl Strategy<Value = GrantSpec> {
    (
        (0..ACTORS, prop::bool::weighted(0.12), 0..ACTORS),
        0..GRANT_DS,
        0..ACTORS,
        0..NODE_DS,
        ix(VERBS.len(), 3),
        prop::option::weighted(0.6, 0..GRANT_DS),
        (
            prop::bool::weighted(0.1),
            prop::option::weighted(0.15, prop_oneof![Just(NOW - 5), Just(NOW + 5)]),
        ),
    )
        .prop_map(
            |((issuer, forged, other), d, grantee, via, verbs, parent, (revoked, expires))| {
                GrantSpec {
                    // Grants are addressed by `(issuer, d)`: a stored grant whose
                    // signer is not its claimed issuer is a forgery.
                    author: if forged { other } else { issuer },
                    d,
                    issuer,
                    grantee,
                    via,
                    verbs,
                    parent,
                    revoked,
                    expires,
                }
            },
        )
}

fn spec(acyclic: bool) -> impl Strategy<Value = Spec> {
    (
        ix(ACTORS - 1, 2), // admins never include the attacker (index 4)
        prop::collection::vec(node_spec(acyclic), 0..8),
        prop::collection::vec(grant_spec(), 0..8),
    )
        .prop_map(|(admins, nodes, grants)| Spec {
            admins,
            nodes,
            grants,
        })
}

fn incoming() -> impl Strategy<Value = Incoming> {
    (
        0..ACTORS - 1, // never the attacker
        0..ACTORS,
        0..NODE_DS,
        ix(VERBS.len(), 3),
        prop::option::weighted(0.7, 0..GRANT_DS),
    )
        .prop_map(|(issuer, grantee, via, verbs, parent)| Incoming {
            issuer,
            grantee,
            via,
            verbs,
            parent,
        })
}

// ── plausible graphs: a valid skeleton, then random damage ─────────────────
//
// Fully random graphs almost never contain a valid chain (about 0.5% of them
// here), so equivalence properties over them would pass while proving little.
// Instead start from a valid three-level org with a three-link grant chain and
// apply a few random mutations — re-seating, re-authoring, revoking, forging,
// decoys — so most worlds are *near* valid and a wrong decision is likely to be
// exercised.

#[derive(Debug, Clone)]
enum Mut {
    NodeHolders(usize, Vec<usize>),
    NodeAgents(usize, Vec<usize>),
    NodeCanGrant(usize, Vec<usize>),
    NodeAuthor(usize, usize),
    NodeParent(usize, Option<usize>),
    GrantIssuer(usize, usize),
    GrantAuthor(usize, usize),
    GrantGrantee(usize, usize),
    GrantVia(usize, usize),
    GrantVerbs(usize, Vec<usize>),
    GrantParent(usize, Option<usize>),
    GrantRevoked(usize),
    GrantExpiry(usize, bool),
    AddNode(NodeSpec),
    AddGrant(GrantSpec),
    Incoming(Incoming),
}

fn skeleton() -> (Spec, Incoming) {
    let node =
        |author, d, parent, holders: &[usize], agents: &[usize], can_grant: &[usize]| NodeSpec {
            author,
            d,
            parent,
            holders: holders.to_vec(),
            agents: agents.to_vec(),
            can_grant: can_grant.to_vec(),
        };
    let grant = |author, d, grantee, via, verbs: &[usize], parent| GrantSpec {
        author,
        d,
        issuer: author,
        grantee,
        via,
        verbs: verbs.to_vec(),
        parent,
        revoked: false,
        expires: None,
    };
    let spec = Spec {
        admins: vec![0],
        nodes: vec![
            // root: the owner's, held by actors 0 and 1
            node(0, 0, None, &[0, 1], &[], &[0, 3, 4]),
            // actor 1's child: holders 1 and 2, agent seat 3
            node(1, 1, Some(0), &[1, 2], &[3], &[1, 5]),
            // actor 2's grandchild
            node(2, 2, Some(1), &[2], &[], &[2, 6]),
        ],
        grants: vec![
            // g0: actor 1 → 2, root grant from the root node's canGrant
            grant(1, 0, 2, 0, &[0], None),
            // g1: actor 2 → agent 3 under g0
            grant(2, 1, 3, 1, &[1], Some(0)),
        ],
    };
    // The agent seat 3 delegates one more hop under g1.
    let inc = Incoming {
        issuer: 3,
        grantee: 0,
        via: 1,
        verbs: vec![2],
        parent: Some(1),
    };
    (spec, inc)
}

fn mutation() -> impl Strategy<Value = Mut> {
    let i = 0..16usize;
    prop_oneof![
        (i.clone(), ix(ACTORS, 3)).prop_map(|(i, v)| Mut::NodeHolders(i, v)),
        (i.clone(), ix(ACTORS, 2)).prop_map(|(i, v)| Mut::NodeAgents(i, v)),
        (i.clone(), ix(VERBS.len(), 4)).prop_map(|(i, v)| Mut::NodeCanGrant(i, v)),
        (i.clone(), 0..ACTORS).prop_map(|(i, a)| Mut::NodeAuthor(i, a)),
        (i.clone(), prop::option::of(0..NODE_DS)).prop_map(|(i, p)| Mut::NodeParent(i, p)),
        (i.clone(), 0..ACTORS).prop_map(|(i, a)| Mut::GrantIssuer(i, a)),
        (i.clone(), 0..ACTORS).prop_map(|(i, a)| Mut::GrantAuthor(i, a)),
        (i.clone(), 0..ACTORS).prop_map(|(i, a)| Mut::GrantGrantee(i, a)),
        (i.clone(), 0..NODE_DS).prop_map(|(i, n)| Mut::GrantVia(i, n)),
        (i.clone(), ix(VERBS.len(), 3)).prop_map(|(i, v)| Mut::GrantVerbs(i, v)),
        (i.clone(), prop::option::of(0..GRANT_DS)).prop_map(|(i, p)| Mut::GrantParent(i, p)),
        i.clone().prop_map(Mut::GrantRevoked),
        (i, any::<bool>()).prop_map(|(i, past)| Mut::GrantExpiry(i, past)),
        node_spec(true).prop_map(Mut::AddNode),
        grant_spec().prop_map(Mut::AddGrant),
        incoming().prop_map(Mut::Incoming),
    ]
}

fn apply(spec: &mut Spec, inc: &mut Incoming, m: Mut) {
    let (n, g) = (spec.nodes.len(), spec.grants.len());
    match m {
        Mut::NodeHolders(i, v) if n > 0 => spec.nodes[i % n].holders = v,
        Mut::NodeAgents(i, v) if n > 0 => spec.nodes[i % n].agents = v,
        Mut::NodeCanGrant(i, v) if n > 0 => spec.nodes[i % n].can_grant = v,
        Mut::NodeAuthor(i, a) if n > 0 => spec.nodes[i % n].author = a,
        Mut::NodeParent(i, p) if n > 0 => {
            // keep the acyclic shape: a parent id is always smaller than its own
            let node = &mut spec.nodes[i % n];
            node.parent = p.filter(|p| *p < node.d);
        }
        Mut::GrantIssuer(i, a) if g > 0 => spec.grants[i % g].issuer = a,
        Mut::GrantAuthor(i, a) if g > 0 => spec.grants[i % g].author = a,
        Mut::GrantGrantee(i, a) if g > 0 => spec.grants[i % g].grantee = a,
        Mut::GrantVia(i, v) if g > 0 => spec.grants[i % g].via = v,
        Mut::GrantVerbs(i, v) if g > 0 => spec.grants[i % g].verbs = v,
        Mut::GrantParent(i, p) if g > 0 => spec.grants[i % g].parent = p,
        Mut::GrantRevoked(i) if g > 0 => spec.grants[i % g].revoked = true,
        Mut::GrantExpiry(i, past) if g > 0 => {
            spec.grants[i % g].expires = Some(if past { NOW - 5 } else { NOW + 5 })
        }
        Mut::AddNode(node) => spec.nodes.push(node),
        Mut::AddGrant(grant) => spec.grants.push(grant),
        Mut::Incoming(i) => *inc = i,
        _ => {}
    }
}

/// A near-valid world (mostly) or a fully random one (sometimes).
fn world() -> impl Strategy<Value = (Spec, Incoming)> {
    let perturbed = prop::collection::vec(mutation(), 0..=4).prop_map(|ms| {
        let (mut spec, mut inc) = skeleton();
        for m in ms {
            apply(&mut spec, &mut inc, m);
        }
        (spec, inc)
    });
    prop_oneof![
        4 => perturbed,
        1 => (spec(true), incoming()),
    ]
}

// ── the graph under test ──────────────────────────────────────────────────

#[derive(Default)]
struct Graph {
    admins: HashSet<String>,
    nodes: Vec<StoredOrgNode>,
    grants: Vec<StoredOrgGrant>,
}

impl Graph {
    fn from_spec(spec: &Spec) -> Self {
        let mut g = Graph {
            admins: spec.admins.iter().map(|a| actor(*a)).collect(),
            ..Graph::default()
        };
        for (i, n) in spec.nodes.iter().enumerate() {
            g.nodes.push(StoredOrgNode {
                author: actor(n.author),
                created_at: NOW - 10_000 + i as u64,
                event_id: format!("{:064x}", i + 1),
                parent: n.parent.map(node_d),
                node: ResolvedOrgNode {
                    d: node_d(n.d),
                    holders: n.holders.iter().map(|h| actor(*h)).collect(),
                    agent_seats: n.agents.iter().map(|h| actor(*h)).collect(),
                    scope: OrgScope {
                        read_below: true,
                        assign_below: true,
                        can_grant: verbs_of(&n.can_grant),
                    },
                },
            });
        }
        for (i, gr) in spec.grants.iter().enumerate() {
            g.grants.push(StoredOrgGrant {
                author: actor(gr.author),
                created_at: NOW - 10_000 + i as u64,
                event_id: format!("{:064x}", 1000 + i),
                grant: ResolvedGrant {
                    d: grant_d(gr.d),
                    issuer: actor(gr.issuer),
                    grantee: actor(gr.grantee),
                    via: node_d(gr.via),
                    verbs: verbs_of(&gr.verbs),
                    parent_grant: gr.parent.map(grant_d),
                    expires: gr.expires,
                    revoked: gr.revoked,
                },
            });
        }
        g
    }
}

impl OrgGraphSource for Graph {
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

fn block_on<F: Future>(fut: F) -> F::Output {
    let mut fut = std::pin::pin!(fut);
    let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
    loop {
        if let std::task::Poll::Ready(v) = fut.as_mut().poll(&mut cx) {
            return v;
        }
    }
}

fn resolved(inc: &Incoming) -> ResolvedGrant {
    ResolvedGrant {
        d: "incoming".into(),
        issuer: actor(inc.issuer),
        grantee: actor(inc.grantee),
        via: node_d(inc.via),
        verbs: verbs_of(&inc.verbs),
        parent_grant: inc.parent.map(grant_d),
        expires: None,
        revoked: false,
    }
}

// ── oracles ───────────────────────────────────────────────────────────────

/// Anchoring as a least fixpoint: a node is anchored when an admin authored it,
/// or when a *parent* record (same `d` as its `parent`, never its own id) is
/// anchored and lists the node's author as a holder.
fn oracle_anchored(spec: &Spec) -> Vec<bool> {
    let admins: HashSet<usize> = spec.admins.iter().copied().collect();
    let mut anchored: Vec<bool> = spec
        .nodes
        .iter()
        .map(|n| admins.contains(&n.author))
        .collect();
    loop {
        let mut changed = false;
        for i in 0..spec.nodes.len() {
            if anchored[i] {
                continue;
            }
            let n = &spec.nodes[i];
            let Some(parent) = n.parent else { continue };
            if parent == n.d {
                continue;
            }
            let ok = spec
                .nodes
                .iter()
                .enumerate()
                .any(|(j, p)| anchored[j] && p.d == parent && p.holders.contains(&n.author));
            if ok {
                anchored[i] = true;
                changed = true;
            }
        }
        if !changed {
            return anchored;
        }
    }
}

/// The canonical anchored record for `d`: newest first, an admin-authored one
/// wins, else the newest anchored one.
fn oracle_canonical(spec: &Spec, anchored: &[bool], d: usize) -> Option<usize> {
    let admins: HashSet<usize> = spec.admins.iter().copied().collect();
    let mut first_anchored = None;
    for i in (0..spec.nodes.len()).rev() {
        if spec.nodes[i].d != d || !anchored[i] {
            continue;
        }
        if admins.contains(&spec.nodes[i].author) {
            return Some(i);
        }
        first_anchored.get_or_insert(i);
    }
    first_anchored
}

fn entails(child: &[String], parent: &[String]) -> bool {
    child
        .iter()
        .all(|c| parent.iter().any(|p| verb_entailed_by(c, p)))
}

struct Link {
    issuer: usize,
    via: usize,
    verbs: Vec<String>,
    parent: Option<usize>,
}

/// Exhaustive search for a chain of stored grants from `link` to a root.
fn oracle_chain(spec: &Spec, anchored: &[bool], link: &Link, seen: &mut Vec<String>) -> bool {
    let Some(node_ix) = oracle_canonical(spec, anchored, link.via) else {
        return false;
    };
    let node = &spec.nodes[node_ix];
    if !(node.holders.contains(&link.issuer) || node.agents.contains(&link.issuer)) {
        return false;
    }
    let Some(pd) = link.parent else {
        return entails(&link.verbs, &verbs_of(&node.can_grant));
    };
    if seen.contains(&grant_d(pd)) {
        return false;
    }
    seen.push(grant_d(pd));
    let found = spec.grants.iter().any(|cand| {
        cand.d == pd
            && cand.author == cand.issuer
            && cand.grantee == link.issuer
            && !cand.revoked
            && cand.expires.is_none_or(|e| NOW < e)
            && entails(&link.verbs, &verbs_of(&cand.verbs))
            && oracle_chain(
                spec,
                anchored,
                &Link {
                    issuer: cand.issuer,
                    via: cand.via,
                    verbs: verbs_of(&cand.verbs),
                    parent: cand.parent,
                },
                seen,
            )
    });
    seen.pop();
    found
}

fn oracle_grant_ok(spec: &Spec, inc: &Incoming) -> bool {
    let anchored = oracle_anchored(spec);
    let mut seen = vec!["incoming".to_string()];
    oracle_chain(
        spec,
        &anchored,
        &Link {
            issuer: inc.issuer,
            via: inc.via,
            verbs: verbs_of(&inc.verbs),
            parent: inc.parent,
        },
        &mut seen,
    )
}

fn prod_grant_ok(g: &Graph, inc: &Incoming) -> bool {
    block_on(verify_incoming_grant(
        g,
        &actor(inc.issuer),
        resolved(inc),
        NOW,
    ))
    .is_ok()
}

fn prod_anchored(g: &Graph) -> Vec<bool> {
    block_on(async {
        let mut walk = Walk::new(g);
        let mut out = Vec::new();
        for n in &g.nodes {
            out.push(walk.node_anchored(n, &[]).await.expect("in-memory graph"));
        }
        out
    })
}

/// Is `who` seated (holder or agent seat) in any anchored node of `spec`?
fn seated_in_anchored(spec: &Spec, anchored: &[bool], who: usize) -> bool {
    spec.nodes
        .iter()
        .enumerate()
        .any(|(i, n)| anchored[i] && (n.holders.contains(&who) || n.agents.contains(&who)))
}

fn proptest_config() -> ProptestConfig {
    ProptestConfig::with_cases(768)
}

proptest! {
    #![proptest_config(proptest_config())]

    /// Under an acyclic `d` shape the resolver anchors exactly the nodes the
    /// fixpoint does.
    #[test]
    fn anchoring_matches_the_fixpoint((s, _inc) in world()) {
        let g = Graph::from_spec(&s);
        prop_assert_eq!(prod_anchored(&g), oracle_anchored(&s));
    }

    /// On arbitrary graphs — cycles, self-parents, repeated ids — the resolver
    /// may be stricter than the fixpoint but never looser.
    #[test]
    fn anchoring_is_sound_on_arbitrary_graphs(s in spec(false)) {
        let g = Graph::from_spec(&s);
        let prod = prod_anchored(&g);
        let oracle = oracle_anchored(&s);
        for (i, p) in prod.iter().enumerate() {
            prop_assert!(!*p || oracle[i], "node {i} anchored by the resolver but not the fixpoint");
        }
    }

    /// Node publication: an admin may publish anything; anyone else only a
    /// child of an anchored node they hold, with a scope no wider than the
    /// parent's and an id nobody else uses.
    #[test]
    fn node_publication_matches_the_oracle(
        (s, _inc) in world(),
        author in 0..ACTORS,
        d in 0..NODE_DS,
        parent in prop::option::weighted(0.8, 0..NODE_DS),
        can_grant in ix(VERBS.len(), 3),
    ) {
        let admin = s.admins.contains(&author);
        // Republishing one's own id replaces a record; the graph model has no
        // replacement, so leave that case to the unit tests.
        prop_assume!(admin || !s.nodes.iter().any(|n| n.d == d && n.author == author));
        let g = Graph::from_spec(&s);
        let anchored = oracle_anchored(&s);
        let cg = verbs_of(&can_grant);
        let oracle = admin
            || match parent {
                None => false,
                Some(p) if p == d => false,
                Some(p) => {
                    !s.nodes.iter().any(|n| n.d == d && n.author != author)
                        && s.nodes.iter().enumerate().any(|(j, pn)| {
                            anchored[j]
                                && pn.d == p
                                && pn.holders.contains(&author)
                                && entails(&cg, &verbs_of(&pn.can_grant))
                        })
                }
            };
        let prod = block_on(check_node_publication(
            &g,
            &actor(author),
            &node_d(d),
            parent.map(node_d).as_deref(),
            &cg,
        ))
        .is_ok();
        prop_assert_eq!(prod, oracle);
    }

    /// An incoming grant is accepted exactly when a full chain exists.
    #[test]
    fn incoming_grant_matches_exhaustive_search((s, inc) in world()) {
        let g = Graph::from_spec(&s);
        prop_assert_eq!(prod_grant_ok(&g, &inc), oracle_grant_ok(&s, &inc));
    }

    /// A signer that is not the claimed issuer is refused, whatever the graph.
    #[test]
    fn a_grant_is_never_accepted_from_a_non_issuer(
        (s, inc) in world(),
        author in 0..ACTORS,
    ) {
        prop_assume!(author != inc.issuer);
        let g = Graph::from_spec(&s);
        let r = block_on(verify_incoming_grant(&g, &actor(author), resolved(&inc), NOW));
        prop_assert!(r.is_err());
    }

    /// Decoys: records signed by someone with no seat in any anchored node can
    /// neither create nor remove authority for anyone else — whatever `d` they
    /// squat, whoever they name, however new they are.
    #[test]
    fn decoys_never_change_a_decision(
        (s, inc) in world(),
        attack_nodes in prop::collection::vec(node_spec(true), 0..6),
        attack_grants in prop::collection::vec(grant_spec(), 0..6),
        probe in 0..ACTORS - 1,
    ) {
        let anchored = oracle_anchored(&s);
        prop_assume!(!seated_in_anchored(&s, &anchored, ATTACKER));

        let mut attacked = s.clone();
        for mut n in attack_nodes {
            n.author = ATTACKER;
            attacked.nodes.push(n);
        }
        for mut gr in attack_grants {
            gr.author = ATTACKER;
            attacked.grants.push(gr);
        }
        let (clean, dirty) = (Graph::from_spec(&s), Graph::from_spec(&attacked));

        prop_assert_eq!(prod_grant_ok(&clean, &inc), prod_grant_ok(&dirty, &inc));

        // Authority for every other actor is untouched, and the attacker has none.
        let holder = |g: &Graph, who: usize| {
            block_on(is_authority_holder(g, &actor(who))).expect("in-memory graph")
        };
        prop_assert_eq!(holder(&clean, probe), holder(&dirty, probe));
        prop_assert!(!holder(&dirty, ATTACKER));

        // Budget publication for a third party's subject is unchanged.
        let budget = |g: &Graph| {
            block_on(check_budget_publisher(g, &actor(probe), &actor(inc.grantee))).is_ok()
        };
        prop_assert_eq!(budget(&clean), budget(&dirty));
    }

    /// The default budget is owner/admin-only, however the org is shaped.
    #[test]
    fn only_admins_publish_the_default_budget(s in spec(false), author in 0..ACTORS) {
        let g = Graph::from_spec(&s);
        let ok = block_on(check_budget_publisher(&g, &actor(author), DEFAULT_BUDGET_SUBJECT)).is_ok();
        prop_assert_eq!(ok, s.admins.contains(&author));
    }
}

// ── the generator exercises both outcomes ─────────────────────────────────

/// Guard against a vacuous suite: if random graphs almost never yield an
/// accepted chain (or almost never a rejected one), the equivalence properties
/// above would pass while proving nothing.
#[test]
fn generator_reaches_accept_and_reject() {
    use proptest::strategy::ValueTree;
    use proptest::test_runner::TestRunner;

    let mut runner = TestRunner::deterministic();
    let strategy = world();
    let (mut accepted, mut with_parent, mut anchored_nodes, mut nodes) = (0u32, 0u32, 0u32, 0u32);
    const SAMPLES: u32 = 3000;
    for _ in 0..SAMPLES {
        let (s, inc) = strategy.new_tree(&mut runner).expect("sample").current();
        let g = Graph::from_spec(&s);
        if prod_grant_ok(&g, &inc) {
            accepted += 1;
            if inc.parent.is_some() {
                with_parent += 1;
            }
        }
        let a = oracle_anchored(&s);
        nodes += a.len() as u32;
        anchored_nodes += a.iter().filter(|x| **x).count() as u32;
    }
    eprintln!(
        "accepted {accepted}/{SAMPLES} (with a parent chain: {with_parent}); anchored nodes {anchored_nodes}/{nodes}"
    );
    assert!(
        accepted * 10 >= SAMPLES,
        "under 10% of grants accepted: {accepted}/{SAMPLES}"
    );
    assert!(
        accepted * 10 <= SAMPLES * 9,
        "over 90% of grants accepted: {accepted}/{SAMPLES}"
    );
    assert!(
        with_parent * 10 >= SAMPLES,
        "chains with a parent are too rare: {with_parent}"
    );
    assert!(anchored_nodes * 10 >= nodes, "under 10% of nodes anchored");
    assert!(anchored_nodes < nodes, "every node anchored");
}

// ── entailment is a preorder ──────────────────────────────────────────────

fn verb_strategy() -> impl Strategy<Value = String> {
    let names = prop_oneof![Just("read"), Just("spend"), Just("task")];
    let args = prop::option::of(prop_oneof![
        Just("#eng"),
        Just("#eng:fe"),
        Just("#eng:fe:x"),
        Just("#ops"),
        Just("#e"),
        Just("100"),
        Just("50"),
        Just("0"),
        Just("create"),
        Just("18446744073709551616"),
    ]);
    (names, args).prop_map(|(n, a)| match a {
        Some(a) => format!("{n}:{a}"),
        None => n.to_string(),
    })
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(2048))]

    /// Reflexive: a verb is entailed by itself, so re-delegating exactly what
    /// you hold is always valid.
    #[test]
    fn entailment_is_reflexive(v in verb_strategy()) {
        prop_assert!(verb_entailed_by(&v, &v), "{v} does not entail itself");
    }

    /// Transitive: if `a ⊑ b` and `b ⊑ c` then `a ⊑ c`. Without this, a chain
    /// of individually valid hops could widen scope end to end.
    #[test]
    fn entailment_is_transitive(a in verb_strategy(), b in verb_strategy(), c in verb_strategy()) {
        if verb_entailed_by(&a, &b) && verb_entailed_by(&b, &c) {
            prop_assert!(verb_entailed_by(&a, &c), "{a} ⊑ {b} ⊑ {c} but not {a} ⊑ {c}");
        }
    }

    /// A verb of a different name never entails another.
    #[test]
    fn entailment_never_crosses_names(a in verb_strategy(), b in verb_strategy()) {
        if split_verb(&a).0 != split_verb(&b).0 {
            prop_assert!(!verb_entailed_by(&a, &b));
        }
    }
}

// ── review tally ──────────────────────────────────────────────────────────

fn review_rows() -> impl Strategy<Value = Vec<ReviewRow>> {
    prop::collection::vec(
        (
            0..3usize,
            0..ACTORS,
            0..3u64,
            prop_oneof![
                Just(Some("accepted")),
                Just(Some("rejected")),
                Just(Some("pending")),
                Just(None)
            ],
        ),
        0..12,
    )
    .prop_map(|rows| {
        rows.into_iter()
            .enumerate()
            .map(|(i, (d, reviewer, dt, status))| ReviewRow {
                d: format!("a{d}"),
                reviewer: actor(reviewer),
                created_at: NOW + dt,
                event_id: format!("{:064x}", i + 1),
                status: status.map(String::from),
            })
            .collect()
    })
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(1024))]

    /// The canonical review per action is the newest one by an authorized
    /// reviewer other than the subject (ties: lowest event id).
    #[test]
    fn tally_matches_the_oracle(
        rows in review_rows(),
        subject in 0..ACTORS,
        authorized in ix(ACTORS, 5),
    ) {
        let subject = actor(subject);
        let authorized: HashSet<String> = authorized.into_iter().map(actor).collect();
        let mut best: std::collections::HashMap<&str, &ReviewRow> = Default::default();
        for r in rows.iter().filter(|r| r.reviewer != subject && authorized.contains(&r.reviewer)) {
            let better = best.get(r.d.as_str()).is_none_or(|cur| {
                (std::cmp::Reverse(r.created_at), &r.event_id)
                    < (std::cmp::Reverse(cur.created_at), &cur.event_id)
            });
            if better {
                best.insert(&r.d, r);
            }
        }
        let count = |want: &str| best.values().filter(|r| r.status.as_deref() == Some(want)).count() as u64;
        prop_assert_eq!(tally_reviews(&rows, &subject, &authorized), (count("accepted"), count("rejected")));
    }

    /// A contributor cannot move their own tally: dropping every row they
    /// signed changes nothing, and neither does dropping unauthorized rows.
    #[test]
    fn self_and_unauthorized_reviews_never_count(
        rows in review_rows(),
        subject in 0..ACTORS,
        authorized in ix(ACTORS, 5),
    ) {
        let subject = actor(subject);
        let authorized: HashSet<String> = authorized.into_iter().map(actor).collect();
        let kept: Vec<ReviewRow> = rows
            .iter()
            .filter(|r| r.reviewer != subject && authorized.contains(&r.reviewer))
            .cloned()
            .collect();
        prop_assert_eq!(
            tally_reviews(&rows, &subject, &authorized),
            tally_reviews(&kept, &subject, &authorized)
        );
    }
}
