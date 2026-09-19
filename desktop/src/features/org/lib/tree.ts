import type { OrgNode, OrgGrant, OrgBudget } from "../orgModels";

export type OrgTreeNode = {
  node: OrgNode;
  children: OrgTreeNode[];
  depth: number;
};

export type OrgChartTree = {
  roots: OrgTreeNode[];
  byDtag: Map<string, OrgTreeNode>;
};

type ForestNode<D> = {
  data: D;
  children: ForestNode<D>[];
  depth: number;
};

/**
 * Assemble a forest from (key -> item, parent key) pairs. Two passes,
 * deliberately:
 *
 * 1. Resolve parents first, reading `parentOf` from the final item set — a
 *    child listed before its parent must still link. (The previous single
 *    pass assigned depth while wiring, so a child listed before its parent
 *    got a stale depth.)
 * 2. Assign depth afterwards by walking from the roots with a visited guard,
 *    so depth is always measured from a real root.
 *
 * Cycles are never dropped: for each parent cycle the member with the
 * lexicographically smallest key is hoisted to a root, so both sides of an
 * A↔B parent link stay visible. Missing/self parents are roots.
 */
function buildForest<D>(
  items: Iterable<D>,
  keyOf: (item: D) => string,
  parentOf: (item: D) => string | undefined,
): { nodes: Map<string, ForestNode<D>>; roots: ForestNode<D>[] } {
  const byKey = new Map<string, ForestNode<D>>();
  for (const item of items) {
    byKey.set(keyOf(item), { data: item, children: [], depth: 0 });
  }

  // Resolve effective parents: self-parents and missing parents are roots.
  const parentKeyOf = new Map<string, string>();
  const roots: ForestNode<D>[] = [];
  for (const [key, treeNode] of byKey) {
    const parentKey = parentOf(treeNode.data);
    if (!parentKey || parentKey === key || !byKey.has(parentKey)) {
      roots.push(treeNode);
    } else {
      parentKeyOf.set(key, parentKey);
    }
  }

  // Detect parent cycles and hoist one member of each (smallest key) to a
  // root so cycle data stays visible instead of being silently dropped.
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
      if (seen.has(cursor)) {
        // Leads into a cycle this node is not part of; its chain becomes
        // finite once that cycle is broken below.
        break;
      }
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
    roots.push(byKey.get(hoisted) as ForestNode<D>);
  }

  // Wire children from the (now acyclic) effective parent map.
  for (const [key, parentKey] of parentKeyOf) {
    const parent = byKey.get(parentKey);
    const child = byKey.get(key);
    if (parent && child) parent.children.push(child);
  }

  // Assign depth from the roots; the visited guard keeps a corrupt parent
  // link from looping even though the graph above is already acyclic.
  const queue: ForestNode<D>[] = [...roots];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift() as ForestNode<D>;
    const key = keyOf(current.data);
    if (visited.has(key)) continue;
    visited.add(key);
    for (const child of current.children) {
      child.depth = current.depth + 1;
      queue.push(child);
    }
  }

  return { nodes: byKey, roots };
}

function toOrgTreeNodes(forest: ForestNode<OrgNode>): OrgTreeNode {
  return {
    node: forest.data,
    children: forest.children.map(toOrgTreeNodes),
    depth: forest.depth,
  };
}

export function buildOrgTree(nodes: OrgNode[]): OrgChartTree {
  const active = nodes.filter((n) => !n.revoked);
  const { roots } = buildForest(
    active,
    (node) => node.dtag,
    (node) => node.parent,
  );

  // Sort children by name for stable ordering
  const sortChildren = (list: OrgTreeNode[]) => {
    list.sort((a, b) => a.node.name.localeCompare(b.node.name));
    for (const child of list) {
      sortChildren(child.children);
    }
  };
  const orgRoots = roots.map(toOrgTreeNodes);
  sortChildren(orgRoots);

  const orgByDtag = new Map<string, OrgTreeNode>();
  for (const root of orgRoots) {
    const flatten = (treeNode: OrgTreeNode) => {
      orgByDtag.set(treeNode.node.dtag, treeNode);
      for (const child of treeNode.children) flatten(child);
    };
    flatten(root);
  }

  return { roots: orgRoots, byDtag: orgByDtag };
}

export type GrantTreeNode = {
  grant: OrgGrant;
  children: GrantTreeNode[];
  depth: number;
};

export function buildGrantTree(grants: OrgGrant[]): GrantTreeNode[] {
  const active = grants.filter((g) => !g.revoked);
  const { roots } = buildForest(
    active,
    (grant) => grant.dtag,
    (grant) => grant.parentGrant,
  );
  const toGrantTreeNode = (forest: ForestNode<OrgGrant>): GrantTreeNode => ({
    grant: forest.data,
    children: forest.children.map(toGrantTreeNode),
    depth: forest.depth,
  });
  return roots.map(toGrantTreeNode);
}

/** Count total grants and budgets for summary display. */
export function orgChartSummary(
  nodes: OrgNode[],
  grants: OrgGrant[],
  budgets: OrgBudget[],
) {
  const activeNodes = nodes.filter((n) => !n.revoked);
  const activeGrants = grants.filter((g) => !g.revoked);
  return {
    nodeCount: activeNodes.length,
    grantCount: activeGrants.length,
    budgetCount: budgets.filter((b) => !b.revoked).length,
    roleCount: activeNodes.filter((n) => n.kind === "role").length,
    teamCount: activeNodes.filter((n) => n.kind === "team").length,
    agentSeatCount: activeNodes.filter((n) => n.kind === "agent_seat").length,
  };
}
