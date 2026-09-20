// Canvas layout for the org chart (P1 item 4). Pure math, no React — the
// packing algorithm and constants port the reference proportions from
// docs/paperclip-ux-reference.md §2.2 (Paperclip ui/src/pages/OrgChart.tsx):
// width-first subtree packing, parents centered over children, multiple
// roots side by side. No graph library.
import type { OrgTreeNode } from "./tree";

export type CanvasDensity = "comfortable" | "compact";

export type CanvasMetrics = {
  cardW: number;
  cardH: number;
  gapX: number;
  gapY: number;
};

// Reference proportions: card 200×100, gaps 32×80, padding 60. Compact
// shrinks every dimension; two densities are enough here (the reference
// ships four).
export const CANVAS_DENSITY: Record<CanvasDensity, CanvasMetrics> = {
  comfortable: { cardW: 200, cardH: 100, gapX: 32, gapY: 80 },
  compact: { cardW: 152, cardH: 72, gapX: 20, gapY: 56 },
};

export const CANVAS_PADDING = 60;
export const FIT_PADDING = 40;
export const MIN_ZOOM = 0.4;
export const MAX_ZOOM = 2;

export type PlacedNode = {
  dtag: string;
  treeNode: OrgTreeNode;
  x: number;
  y: number;
};

export type CanvasEdge = {
  /** Child node dtag (stable React key). */
  dtag: string;
  parentDtag: string;
  /** Elbow SVG path: parent bottom-center → child top-center. */
  path: string;
};

export type CanvasLayout = {
  nodes: PlacedNode[];
  edges: CanvasEdge[];
  bounds: { width: number; height: number };
};

export type CanvasView = { x: number; y: number; zoom: number };

/** Width a subtree needs at the given density. */
function subtreeWidth(treeNode: OrgTreeNode, m: CanvasMetrics): number {
  if (treeNode.children.length === 0) return m.cardW;
  let childrenW = 0;
  for (const child of treeNode.children) {
    childrenW += subtreeWidth(child, m);
  }
  const gaps = (treeNode.children.length - 1) * m.gapX;
  return Math.max(m.cardW, childrenW + gaps);
}

function elbowPath(
  parent: PlacedNode,
  child: PlacedNode,
  m: CanvasMetrics,
): string {
  const x1 = parent.x + m.cardW / 2;
  const y1 = parent.y + m.cardH;
  const x2 = child.x + m.cardW / 2;
  const y2 = child.y;
  const midY = y1 + (y2 - y1) / 2;
  return `M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}`;
}

function place(
  treeNode: OrgTreeNode,
  x: number,
  y: number,
  m: CanvasMetrics,
  nodes: PlacedNode[],
  edges: CanvasEdge[],
  parent?: PlacedNode,
): PlacedNode {
  const totalW = subtreeWidth(treeNode, m);
  const placed: PlacedNode = {
    dtag: treeNode.node.dtag,
    treeNode,
    x: x + (totalW - m.cardW) / 2,
    y,
  };
  nodes.push(placed);
  if (parent) {
    edges.push({
      dtag: placed.dtag,
      parentDtag: parent.dtag,
      path: elbowPath(parent, placed, m),
    });
  }
  if (treeNode.children.length > 0) {
    let childrenW = 0;
    for (const child of treeNode.children) {
      childrenW += subtreeWidth(child, m);
    }
    const gaps = (treeNode.children.length - 1) * m.gapX;
    let cx = x + (totalW - childrenW - gaps) / 2;
    for (const child of treeNode.children) {
      place(child, cx, y + m.cardH + m.gapY, m, nodes, edges, placed);
      cx += subtreeWidth(child, m) + m.gapX;
    }
  }
  return placed;
}

/**
 * Lay out a whole forest: every root's subtree packed by width, roots side
 * by side, each parent centered over its children.
 */
export function layoutCanvas(
  roots: OrgTreeNode[],
  density: CanvasDensity,
): CanvasLayout {
  const m = CANVAS_DENSITY[density];
  const nodes: PlacedNode[] = [];
  const edges: CanvasEdge[] = [];
  let cursor = CANVAS_PADDING;
  for (const root of roots) {
    const w = subtreeWidth(root, m);
    place(root, cursor, CANVAS_PADDING, m, nodes, edges);
    cursor += w + m.gapX;
  }
  let width = 2 * CANVAS_PADDING;
  let height = 2 * CANVAS_PADDING;
  for (const node of nodes) {
    width = Math.max(width, node.x + m.cardW + CANVAS_PADDING);
    height = Math.max(height, node.y + m.cardH + CANVAS_PADDING);
  }
  return { nodes, edges, bounds: { width, height } };
}

export function clampCanvasZoom(value: number): number {
  return Math.min(Math.max(value, MIN_ZOOM), MAX_ZOOM);
}

/**
 * Compute the fitted view (zoom clamped to at most 1, never below MIN_ZOOM)
 * that centers the content bounds in a container of the given size.
 */
export function fitCanvasView(
  containerWidth: number,
  containerHeight: number,
  bounds: { width: number; height: number },
): CanvasView | null {
  if (
    containerWidth <= FIT_PADDING ||
    containerHeight <= FIT_PADDING ||
    bounds.width <= 0 ||
    bounds.height <= 0
  ) {
    return null;
  }
  const scaleX = (containerWidth - FIT_PADDING) / bounds.width;
  const scaleY = (containerHeight - FIT_PADDING) / bounds.height;
  const zoom = clampCanvasZoom(Math.min(scaleX, scaleY, 1));
  return {
    zoom,
    x: (containerWidth - bounds.width * zoom) / 2,
    y: (containerHeight - bounds.height * zoom) / 2,
  };
}

/**
 * Ancestor label per node ("Founder › CTO › Engineering") for card hover
 * tooltips. Walks parent links from the forest itself; a depth guard keeps a
 * corrupt parent link from looping (tree.ts already breaks cycles, this is
 * belt and braces).
 */
export function ancestorPaths(roots: OrgTreeNode[]): Map<string, string> {
  const nameByDtag = new Map<string, string>();
  const parentOf = new Map<string, string>();
  const walk = (treeNode: OrgTreeNode, parentDtag?: string) => {
    nameByDtag.set(treeNode.node.dtag, treeNode.node.name);
    if (parentDtag) parentOf.set(treeNode.node.dtag, parentDtag);
    for (const child of treeNode.children) {
      walk(child, treeNode.node.dtag);
    }
  };
  for (const root of roots) walk(root);

  const paths = new Map<string, string>();
  for (const [dtag] of nameByDtag) {
    const parts: string[] = [];
    let cursor: string | undefined = parentOf.get(dtag);
    const seen = new Set<string>([dtag]);
    while (cursor !== undefined && !seen.has(cursor)) {
      seen.add(cursor);
      const name = nameByDtag.get(cursor);
      if (name) parts.unshift(name);
      cursor = parentOf.get(cursor);
    }
    if (parts.length > 0) paths.set(dtag, parts.join(" › "));
  }
  return paths;
}
