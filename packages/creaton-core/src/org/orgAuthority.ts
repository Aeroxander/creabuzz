// Client-side twin of the R1 authority resolver in
// crates/buzz-core/src/org_grant.rs — who may write the org graph, which node a
// reference means, and whether a grant chain is valid.
//
// The Rust module is the source of truth. `scripts/org-authority-corpus.json`
// is generated from it (`just regen-org-corpus`) and replayed by
// `orgAuthority.test.mjs`, so a UI that shows "this grant is valid" agrees with
// the relay that enforced it. This file is self-contained and byte-identical
// to its web twin (web/src/features/fleet/lib/orgAuthority.ts).
//
// Nodes, grants and budgets are addressed by (author, d) but *referenced* by
// the bare `d`. A resolver that takes "the newest record for this d" lets any
// member shadow a legitimate node, so every reference here resolves by who
// signed the record:
//
// - a node is **anchored** when the community owner/admin authored it, or its
//   author holds a seat (`holders`) in an anchored parent node;
// - a node reference resolves to an anchored candidate, never to the newest
//   unanchored one;
// - a grant reference resolves to a candidate whose stored author is its own
//   `issuer`, whose grantee is the child grant's issuer, and whose whole chain
//   verifies.
//
// Not modeled: the relay's per-decision lookup budget (an I/O bound with no
// meaning over an in-memory graph).

export const MAX_ORG_CANDIDATES = 32;
export const MAX_NODE_ANCHOR_DEPTH = 16;
export const MAX_GRANT_CHAIN_DEPTH = 32;
/** `subject` of the community default budget: covers agents with no budget. */
export const DEFAULT_BUDGET_SUBJECT = "*";
/** `content.type` of a kind:37011 record that is an ownership stake, not a delegation. */
export const ORG_GRANT_TYPE_EQUITY = "equity";

/** A stored kind:37010 org node with its signer. */
export type StoredOrgNode = {
  author: string;
  createdAt: number;
  eventId: string;
  d: string;
  parent: string | null;
  holders: string[];
  agentSeats: string[];
  canGrant: string[];
};

/** A stored kind:37011 grant with its signer. */
export type StoredOrgGrant = {
  author: string;
  createdAt: number;
  eventId: string;
  d: string;
  issuer: string;
  grantee: string;
  via: string;
  verbs: string[];
  parentGrant: string | null;
  expires: number | null;
  revoked: boolean;
};

/** A grant being published (no stored author yet). */
export type IncomingGrant = Omit<
  StoredOrgGrant,
  "author" | "createdAt" | "eventId"
>;

/** The org graph of one community: who administers it, plus every node and grant record. */
export type OrgGraph = {
  admins: readonly string[];
  nodes: readonly StoredOrgNode[];
  grants: readonly StoredOrgGrant[];
};

export type Denial =
  | "root_requires_admin"
  | "not_anchored"
  | "id_owned_by_another_author"
  | "scope_widens_parent"
  | "issuer_not_author"
  | "default_budget_requires_admin"
  | "budget_author_not_authorized"
  | "node_not_anchored"
  | "chain_invalid";

export type Refused = { ok: false; denial: Denial; detail: string };
export type AuthorityResult = { ok: true } | Refused;

const DENIAL_TEXT: Record<Denial, string> = {
  root_requires_admin:
    "a root org node (no parent) may only be published by the community owner or an admin",
  not_anchored:
    "the author is neither the community owner/admin nor a holder of an anchored parent node",
  id_owned_by_another_author:
    "another author already publishes a node with this id",
  scope_widens_parent: "the node's scope is wider than its parent's",
  issuer_not_author: "a grant's issuer must be the event author",
  default_budget_requires_admin:
    'the default budget (subject "*") may only be published by the community owner or an admin',
  budget_author_not_authorized:
    "a budget may only be published by the community owner/admin, an anchored seat holder, or its subject agent",
  node_not_anchored:
    "a referenced org node is not anchored to the community owner or an admin",
  chain_invalid: "the grant chain does not verify",
};

function denied(denial: Denial, detail?: string): Refused {
  return { ok: false, denial, detail: detail ?? DENIAL_TEXT[denial] };
}

// ── verb entailment ────────────────────────────────────────────────────────

const U64_MAX = 18446744073709551615n;

/** Mirror of Rust's `u64::from_str`: an optional "+", digits only, within range. */
function parseU64(text: string): bigint | null {
  if (!/^\+?\d+$/.test(text)) return null;
  const value = BigInt(text);
  return value <= U64_MAX ? value : null;
}

/** Split a verb into name and optional argument: "read:#eng" → ["read", "#eng"]. */
export function splitVerb(verb: string): [string, string | undefined] {
  const pos = verb.indexOf(":");
  if (pos === -1) return [verb, undefined];
  return [verb.slice(0, pos), verb.slice(pos + 1)];
}

function channelSegments(channel: string): string[] {
  const stripped = channel.startsWith("#") ? channel.slice(1) : channel;
  return stripped.split(":").filter((s) => s !== "");
}

/** "#eng:fe" is contained by "#eng"; "#l" is not contained by "#leadership". */
export function channelContainedBy(child: string, parent: string): boolean {
  const childSegs = channelSegments(child);
  const parentSegs = channelSegments(parent);
  if (parentSegs.length === 0 || childSegs.length < parentSegs.length) {
    return false;
  }
  return parentSegs.every((seg, i) => childSegs[i] === seg);
}

/**
 * Whether `child` is entailed by `parent` (NIP-ORG attenuation): same name and
 * an argument no broader. An unargued parent entails any argument; an unargued
 * child under a scoped parent is a widening; channels use path containment;
 * numbers compare child ≤ parent (only when both fit a u64); anything else
 * must match exactly.
 */
export function verbEntailedBy(child: string, parent: string): boolean {
  const [childName, childArg] = splitVerb(child);
  const [parentName, parentArg] = splitVerb(parent);
  if (childName !== parentName) return false;
  if (parentArg === undefined) return true;
  if (childArg === undefined) return false;
  if (childArg.startsWith("#") && parentArg.startsWith("#")) {
    return channelContainedBy(childArg, parentArg);
  }
  const childNum = parseU64(childArg);
  const parentNum = parseU64(parentArg);
  if (childNum !== null && parentNum !== null) return childNum <= parentNum;
  return childArg === parentArg;
}

function firstUnentailed(
  child: readonly string[],
  parent: readonly string[],
): string | null {
  return child.find((v) => !parent.some((p) => verbEntailedBy(v, p))) ?? null;
}

// ── the graph walk ─────────────────────────────────────────────────────────

export type NodeLookup =
  | { kind: "missing" }
  | { kind: "unanchored" }
  | { kind: "found"; node: StoredOrgNode };

function newestFirst<T extends { createdAt: number; eventId: string }>(
  a: T,
  b: T,
): number {
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
}

/** A memoizing walk over one graph for one decision. */
class Walk {
  private readonly graph: OrgGraph;
  private readonly admins: Set<string>;
  private readonly anchored = new Map<string, boolean>();
  private readonly canonical = new Map<string, NodeLookup>();

  constructor(graph: OrgGraph) {
    this.graph = graph;
    this.admins = new Set(graph.admins);
  }

  isAdmin(pubkey: string): boolean {
    return this.admins.has(pubkey);
  }

  nodeCandidates(d: string): StoredOrgNode[] {
    return this.graph.nodes
      .filter((n) => n.d === d)
      .sort(newestFirst)
      .slice(0, MAX_ORG_CANDIDATES);
  }

  nodesHeldBy(pubkey: string): StoredOrgNode[] {
    return this.graph.nodes
      .filter((n) => n.holders.includes(pubkey))
      .sort(newestFirst)
      .slice(0, MAX_ORG_CANDIDATES);
  }

  grantCandidates(d: string): StoredOrgGrant[] {
    return this.graph.grants
      .filter((g) => g.d === d)
      .sort(newestFirst)
      .slice(0, MAX_ORG_CANDIDATES);
  }

  /**
   * Is `start` anchored? `seed` are node ids already on the path above it (the
   * id being published, when `start` is its prospective parent), so a chain
   * that loops back to an id it passed through is not anchored.
   */
  isAnchored(start: StoredOrgNode, seed: readonly string[] = []): boolean {
    const memo = seed.length === 0;
    if (memo) {
      const hit = this.anchored.get(start.eventId);
      if (hit !== undefined) return hit;
    }
    const stack: Array<[StoredOrgNode, string[]]> = [
      [start, [...seed, start.d]],
    ];
    const seen = new Set<string>();
    let result = false;
    while (stack.length > 0) {
      const [cur, path] = stack.pop() as [StoredOrgNode, string[]];
      if (seen.has(cur.eventId)) continue;
      seen.add(cur.eventId);
      if (this.isAdmin(cur.author)) {
        result = true;
        break;
      }
      const parent = cur.parent;
      if (parent === null) continue;
      if (path.length >= MAX_NODE_ANCHOR_DEPTH || path.includes(parent))
        continue;
      for (const p of this.nodeCandidates(parent)) {
        if (p.holders.includes(cur.author)) stack.push([p, [...path, parent]]);
      }
    }
    if (memo) this.anchored.set(start.eventId, result);
    return result;
  }

  /** The canonical anchored record for `d`: an admin-authored one wins, then the newest. */
  canonicalNode(d: string): NodeLookup {
    const hit = this.canonical.get(d);
    if (hit) return hit;
    const candidates = this.nodeCandidates(d);
    let result: NodeLookup;
    if (candidates.length === 0) {
      result = { kind: "missing" };
    } else {
      let best: { admin: boolean; node: StoredOrgNode } | null = null;
      for (const c of candidates) {
        if (!this.isAnchored(c)) continue;
        const admin = this.isAdmin(c.author);
        if (best === null || (admin && !best.admin)) best = { admin, node: c };
      }
      result = best
        ? { kind: "found", node: best.node }
        : { kind: "unanchored" };
    }
    this.canonical.set(d, result);
    return result;
  }

  holdsAuthority(pubkey: string): boolean {
    if (this.isAdmin(pubkey)) return true;
    return this.nodesHeldBy(pubkey).some(
      (node) => node.holders.includes(pubkey) && this.isAnchored(node),
    );
  }
}

// ── decisions ──────────────────────────────────────────────────────────────

/** For each node in `graph.nodes` (same order): is it anchored to the owner/admin? */
export function nodeAnchoring(graph: OrgGraph): boolean[] {
  const walk = new Walk(graph);
  return graph.nodes.map((node) => walk.isAnchored(node));
}

/**
 * Resolve a node reference (`parent`, `via`) to its canonical anchored record:
 * an admin-authored one wins, then the newest. Never an unanchored decoy.
 */
export function resolveNode(graph: OrgGraph, d: string): NodeLookup {
  return new Walk(graph).canonicalNode(d);
}

/**
 * Whether `pubkey` is the community owner/admin or holds a seat in an anchored
 * node — the "anchored human seat holder" of R1. Agent seats never count.
 */
export function isAuthorityHolder(graph: OrgGraph, pubkey: string): boolean {
  return new Walk(graph).holdsAuthority(pubkey.toLowerCase());
}

/**
 * May `author` publish kind:37010 node `d`? The owner/admin may publish any
 * node. Anyone else only a child of an anchored node they hold a seat in, with
 * a `canGrant` no wider than the parent's and an id nobody else uses.
 */
export function checkNodePublication(
  graph: OrgGraph,
  author: string,
  d: string,
  parent: string | null,
  canGrant: readonly string[],
): AuthorityResult {
  const walk = new Walk(graph);
  const who = author.toLowerCase();
  if (walk.isAdmin(who)) return { ok: true };
  if (!parent) return denied("root_requires_admin");
  if (parent === d)
    return denied("not_anchored", `org node ${d} is not anchored`);
  for (const existing of walk.nodeCandidates(d)) {
    if (existing.author !== who) return denied("id_owned_by_another_author");
  }
  let widened: string | null = null;
  for (const p of walk.nodeCandidates(parent)) {
    if (!p.holders.includes(who)) continue;
    const verb = firstUnentailed(canGrant, p.canGrant);
    if (verb !== null) {
      widened ??= verb;
      continue;
    }
    if (walk.isAnchored(p, [d])) return { ok: true };
  }
  return widened !== null
    ? denied(
        "scope_widens_parent",
        `verb ${widened} is not entailed by the parent's canGrant`,
      )
    : denied("not_anchored", `org node ${d} is not anchored`);
}

export type BudgetPublisher = "admin" | "subject" | "holder";

/**
 * May `author` publish a kind:37012 budget for `subject` (a pubkey, or "*" for
 * the community default)? "*": owner/admin only. Otherwise the owner/admin,
 * the subject itself, or an anchored holder.
 */
export function checkBudgetPublisher(
  graph: OrgGraph,
  author: string,
  subject: string,
): { ok: true; as: BudgetPublisher } | Refused {
  const walk = new Walk(graph);
  const who = author.toLowerCase();
  if (walk.isAdmin(who)) return { ok: true, as: "admin" };
  if (subject === DEFAULT_BUDGET_SUBJECT) {
    return denied("default_budget_requires_admin");
  }
  if (who === subject.toLowerCase()) return { ok: true, as: "subject" };
  if (walk.holdsAuthority(who)) return { ok: true, as: "holder" };
  return denied("budget_author_not_authorized");
}

/** Whether a parsed kind:37011 content object is an ownership record, not a delegation. */
export function isEquityGrantContent(content: unknown): boolean {
  return (
    typeof content === "object" &&
    content !== null &&
    (content as { type?: unknown }).type === ORG_GRANT_TYPE_EQUITY
  );
}

type ChainLink = Pick<
  StoredOrgGrant,
  | "d"
  | "issuer"
  | "grantee"
  | "via"
  | "verbs"
  | "parentGrant"
  | "expires"
  | "revoked"
>;

/** Verify one fully selected chain (incoming first, root last) against its canonical nodes. */
function verifySelectedChain(
  chain: readonly ChainLink[],
  nodes: ReadonlyMap<string, StoredOrgNode>,
  now: number,
): string | null {
  const seated = (node: StoredOrgNode, who: string) =>
    node.holders.includes(who) || node.agentSeats.includes(who);
  let hops = 0;
  for (let i = 0; i < chain.length; i++) {
    const grant = chain[i];
    if (grant.revoked) return `grant ${grant.d} has been revoked`;
    if (grant.expires !== null && now >= grant.expires) {
      return `grant ${grant.d} expired at ${grant.expires}`;
    }
    const node = nodes.get(grant.via);
    if (!node) return `org node ${grant.via} not found`;
    if (!seated(node, grant.issuer)) {
      return `issuer ${grant.issuer} is not seated in node ${grant.via}`;
    }
    const parent = chain[i + 1];
    if (parent) {
      for (const verb of grant.verbs) {
        if (!parent.verbs.some((pv) => verbEntailedBy(verb, pv))) {
          return `verb ${verb} is not entailed by parent grant verbs`;
        }
      }
      const parentNode = nodes.get(parent.via);
      if (!parentNode) return `org node ${parent.via} not found`;
      if (!seated(parentNode, parent.issuer)) {
        return `issuer ${parent.issuer} is not seated in node ${parent.via}`;
      }
      hops += 1;
      if (hops > MAX_GRANT_CHAIN_DEPTH)
        return "grant chain exceeds the maximum depth";
    } else {
      for (const verb of grant.verbs) {
        if (!node.canGrant.some((cg) => verbEntailedBy(verb, cg))) {
          return `root grant ${grant.d} issuer lacks standing (canGrant does not cover ${verb})`;
        }
      }
    }
  }
  return null;
}

/**
 * Verify an incoming kind:37011 grant against the graph. A revoked grant is
 * always admissible (a revocation only removes authority). Otherwise the signer
 * must be the issuer and some chain of stored grants must lead to a root such
 * that every stored grant was signed by its own issuer, every link's issuer is
 * the previous link's grantee, every `via` resolves to an anchored node the
 * issuer holds a seat in, and attenuation, standing, expiry and revocation hold.
 * Equity records are exempt (see `isEquityGrantContent`); callers skip them.
 */
export function verifyIncomingGrant(
  graph: OrgGraph,
  author: string,
  incoming: IncomingGrant,
  now: number,
): AuthorityResult {
  if (incoming.revoked) return { ok: true };
  if (author.toLowerCase() !== incoming.issuer.toLowerCase()) {
    return denied("issuer_not_author");
  }
  const walk = new Walk(graph);
  let firstError: { denial: Denial; detail: string } | null = null;
  const note = (denial: Denial, detail: string) => {
    firstError ??= { denial, detail };
  };

  const verifySelected = (chain: readonly ChainLink[]): boolean => {
    const nodes = new Map<string, StoredOrgNode>();
    for (const grant of chain) {
      if (nodes.has(grant.via)) continue;
      const lookup = walk.canonicalNode(grant.via);
      if (lookup.kind === "found") {
        nodes.set(grant.via, lookup.node);
      } else if (lookup.kind === "missing") {
        note("chain_invalid", `org node ${grant.via} not found`);
        return false;
      } else {
        note("node_not_anchored", `org node ${grant.via} is not anchored`);
        return false;
      }
    }
    const error = verifySelectedChain(chain, nodes, now);
    if (error !== null) {
      note("chain_invalid", error);
      return false;
    }
    return true;
  };

  const descend = (chain: ChainLink[]): boolean => {
    const cur = chain[chain.length - 1];
    if (cur.parentGrant === null) return verifySelected(chain);
    const parentD = cur.parentGrant;
    if (chain.some((g) => g.d === parentD)) {
      note(
        "chain_invalid",
        `circular grant chain detected at grant ${parentD}`,
      );
      return false;
    }
    if (chain.length > MAX_GRANT_CHAIN_DEPTH) {
      note("chain_invalid", "grant chain exceeds the maximum depth");
      return false;
    }
    // Addressed by (issuer, d): a record signed by anyone else is a forgery,
    // and authority only chains from what was delegated to the current issuer.
    const usable = walk
      .grantCandidates(parentD)
      .filter((c) => c.author === c.issuer && c.grantee === cur.issuer);
    if (usable.length === 0) {
      note("chain_invalid", `parent grant ${parentD} not found`);
      return false;
    }
    return usable.some((cand) => descend([...chain, cand]));
  };

  if (descend([incoming])) return { ok: true };
  // `note` assigns from inside closures, which flow analysis cannot see.
  const failure = firstError as { denial: Denial; detail: string } | null;
  return denied(failure?.denial ?? "chain_invalid", failure?.detail);
}

// ── review tally ───────────────────────────────────────────────────────────

export type ReviewRow = {
  d: string;
  reviewer: string;
  createdAt: number;
  eventId: string;
  status: string | null;
};

/**
 * Tally accepted/rejected contribution actions for `subject`. The subject's own
 * review is never trusted; per action the canonical disposition is the newest
 * review by an authorized reviewer other than the subject (ties: lowest event
 * id), and only its status counts. Returns [accepted, rejected].
 */
export function tallyReviews(
  rows: readonly ReviewRow[],
  subject: string,
  authorized: ReadonlySet<string> | readonly string[],
): [number, number] {
  const allowed = authorized instanceof Set ? authorized : new Set(authorized);
  const canonical = new Map<string, ReviewRow>();
  for (const row of rows) {
    if (
      row.reviewer.toLowerCase() === subject.toLowerCase() ||
      !allowed.has(row.reviewer)
    ) {
      continue;
    }
    const cur = canonical.get(row.d);
    if (
      !cur ||
      row.createdAt > cur.createdAt ||
      (row.createdAt === cur.createdAt && row.eventId < cur.eventId)
    ) {
      canonical.set(row.d, row);
    }
  }
  let accepted = 0;
  let rejected = 0;
  for (const row of canonical.values()) {
    if (row.status === "accepted") accepted += 1;
    else if (row.status === "rejected") rejected += 1;
  }
  return [accepted, rejected];
}
