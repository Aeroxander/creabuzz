/**
 * Org tree index (NIP-ORG `37010` org nodes).
 *
 * The org graph is a **community-level** object: nodes carry no routing tag,
 * and are addressed by (author-pubkey, kind, `d`) exactly like a project
 * (`30621`) or a launch record (`37001`). One org belongs to the whole
 * community, not to a channel.
 *
 * Nodes are NIP-33 parameterized-replaceable: the newest event per
 * (author-pubkey, kind, `d`) wins. Keying per (author, d) mirrors the relay's
 * own replacement semantics — keying on `d` alone would let one member
 * publish a newer node with another author's node id and take over its chart
 * position.
 *
 * This module is alias-free so its test (`index-org.test.mjs`) can drive it
 * under `node --test`, like `index-roster.ts`.
 */

/** The subset of an org-node event this index needs. */
export interface OrgNodeEvent {
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
}

/** Parsed org node, before tree assembly. */
export interface OrgNodeEntry {
  /** The `d` tag: the node's stable id. */
  id: string;
  /** Author of the node event. */
  pubkey: string;
  /**
   * A non-routing `h` tag when the publisher included one (informational
   * grouping only), else null. The org is community-level, so this never
   * scopes a read.
   */
  group: string | null;
  name: string;
  /**
   * "role" | "team" | "agent_seat" — anything else fails open to "role". The
   * wire value is snake_case (serde); the CLI flag spelling `agent-seat` is
   * accepted on read as a legacy alias and normalized.
   */
  kind: string;
  /** `d` of the parent node, or null on a root. */
  parent: string | null;
  /** Human seat holders (pubkeys). */
  holders: string[];
  /** Agent seat occupants (pubkeys). */
  agentSeats: string[];
  /** Raw scope block, passed through for later enforcement stages. */
  scope: Record<string, unknown> | null;
  updatedAt: number;
}

/** Node-tree storage key: author-qualified, so nodes cannot shadow each other. */
export function orgNodeKey(pubkey: string, id: string): string {
  return `${pubkey}:${id}`;
}

function tagValue(event: OrgNodeEvent, name: string): string | null {
  const tag = event.tags.find((t) => t[0] === name);
  return tag && tag.length >= 2 ? tag[1] : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

/**
 * Parse one org-node event. Returns null when the event cannot form a node
 * (missing `d`) — a record without identity has no chart position. Malformed
 * content otherwise fails open with defaults rather than dropping the seat,
 * so a broken body cannot hide an occupant.
 */
export function parseOrgNode(event: OrgNodeEvent): OrgNodeEntry | null {
  const id = tagValue(event, "d");
  if (!id) return null;
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(event.content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed content: the node still surfaces with defaults.
  }
  const kind =
    body.kind === "team"
      ? "team"
      : body.kind === "agent_seat" || body.kind === "agent-seat"
        ? "agent_seat"
        : "role";
  const parent =
    typeof body.parent === "string" && body.parent ? body.parent : null;
  const scope =
    body.scope && typeof body.scope === "object" && !Array.isArray(body.scope)
      ? (body.scope as Record<string, unknown>)
      : null;
  return {
    id,
    pubkey: event.pubkey,
    group: tagValue(event, "h"),
    name:
      typeof body.name === "string" && body.name
        ? body.name
        : (tagValue(event, "name") ?? id),
    kind,
    parent,
    holders: stringArray(body.holders),
    agentSeats: stringArray(body.agentSeats),
    scope,
    updatedAt: event.created_at * 1000,
  };
}

/** Newest node per author-qualified identity. */
export function indexOrgNodes(
  events: OrgNodeEvent[],
): Record<string, OrgNodeEntry> {
  const byKey: Record<string, OrgNodeEntry> = {};
  for (const event of events) {
    const parsed = parseOrgNode(event);
    if (!parsed) continue;
    const key = orgNodeKey(parsed.pubkey, parsed.id);
    const existing = byKey[key];
    if (existing && existing.updatedAt >= parsed.updatedAt) continue;
    byKey[key] = parsed;
  }
  return byKey;
}

export interface OrgTreeNode {
  entry: OrgNodeEntry;
  children: OrgTreeNode[];
  /** Distance from the nearest root; roots are 0. */
  depth: number;
}

/**
 * Assemble indexed nodes into a forest.
 *
 * A node whose parent is missing — or whose parent link forms a cycle — is
 * never dropped. For each parent cycle the member with the lexicographically
 * smallest storage key is hoisted to the roots so both sides of an A↔B parent
 * link stay visible; depth is assigned afterwards by walking from the roots
 * with a visited guard, so a child listed before its parent still gets the
 * right depth.
 */
export function buildOrgTree(
  nodes: Record<string, OrgNodeEntry>,
): OrgTreeNode[] {
  const byId = new Map<string, OrgTreeNode>();
  for (const entry of Object.values(nodes)) {
    byId.set(orgNodeKey(entry.pubkey, entry.id), {
      entry,
      children: [],
      depth: 0,
    });
  }

  // Resolve effective parents: self-parents and missing parents are roots.
  // Parent lookup is by node id, not storage key: the org is cross-owner, so
  // a node may legally hang under a node another author published.
  const parentKeyOf = new Map<string, string>();
  const roots: OrgTreeNode[] = [];
  for (const [key, node] of byId) {
    const parentId = node.entry.parent;
    if (!parentId || parentId === node.entry.id) {
      roots.push(node);
      continue;
    }
    const parentKey = [...byId.entries()].find(
      ([, n]) => n.entry.id === parentId,
    )?.[0];
    if (parentKey === undefined) {
      roots.push(node);
    } else {
      parentKeyOf.set(key, parentKey);
    }
  }

  // Break parent cycles: hoist one member (smallest storage key) per cycle.
  for (const startKey of [...parentKeyOf.keys()]) {
    if (!parentKeyOf.has(startKey)) continue;
    const seen = new Set<string>([startKey]);
    let onCycle = false;
    let cursor: string | undefined = parentKeyOf.get(startKey);
    while (cursor !== undefined) {
      if (cursor === startKey) {
        onCycle = true;
        break;
      }
      if (seen.has(cursor)) break; // leads into a cycle this node is not on
      seen.add(cursor);
      cursor = parentKeyOf.get(cursor);
    }
    if (!onCycle) continue;
    const members: string[] = [];
    let walk: string | undefined = startKey;
    do {
      members.push(walk as string);
      walk = parentKeyOf.get(walk as string);
    } while (walk !== undefined && walk !== startKey);
    const hoisted = members.reduce((a, b) => (a < b ? a : b));
    parentKeyOf.delete(hoisted);
    roots.push(byId.get(hoisted) as OrgTreeNode);
  }

  // Wire children from the (now acyclic) effective parent map.
  for (const [key, parentKey] of parentKeyOf) {
    const parent = byId.get(parentKey);
    const child = byId.get(key);
    if (parent && child) parent.children.push(child);
  }

  // Assign depth from the roots, guarded against a corrupt parent link.
  const queue: OrgTreeNode[] = [...roots];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift() as OrgTreeNode;
    const key = orgNodeKey(current.entry.pubkey, current.entry.id);
    if (visited.has(key)) continue;
    visited.add(key);
    for (const child of current.children) {
      child.depth = current.depth + 1;
      queue.push(child);
    }
  }

  return roots;
}
