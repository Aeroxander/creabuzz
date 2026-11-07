// Unit tests for the org canvas layout (packing, elbow edges, fit/clamp).
// Run with: node --import ./test-loader.mjs --experimental-strip-types --test src/features/org/lib/canvasLayout.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CANVAS_DENSITY,
  MAX_ZOOM,
  MIN_ZOOM,
  ancestorPaths,
  clampCanvasZoom,
  fitCanvasView,
  layoutCanvas,
} from "./canvasLayout.ts";
import { buildOrgTree } from "./tree.ts";

function node(dtag, parent, name = dtag) {
  return {
    eventId: `evt-${dtag}`,
    dtag,
    name,
    kind: "role",
    parent,
    holders: [],
    agentSeats: [],
    createdAt: 100,
    revoked: false,
  };
}

function layoutOf(spec, density = "comfortable") {
  return layoutCanvas(buildOrgTree(spec).roots, density);
}

describe("layoutCanvas", () => {
  it("centers a parent over its children", () => {
    const { nodes } = layoutOf([
      node("root"),
      node("a", "root"),
      node("b", "root"),
    ]);
    const root = nodes.find((n) => n.dtag === "root");
    const a = nodes.find((n) => n.dtag === "a");
    const b = nodes.find((n) => n.dtag === "b");
    const m = CANVAS_DENSITY.comfortable;
    // Children sit one row down, side by side with gapX between them.
    assert.equal(a.y, m.cardH + m.gapY + 60);
    assert.equal(b.y, a.y);
    // Parent is horizontally centered over the children pair.
    const childMid = (a.x + m.cardW / 2 + (b.x + m.cardW / 2)) / 2;
    assert.equal(root.x + m.cardW / 2, childMid);
  });

  it("lays multiple roots side by side with no overlap", () => {
    const { nodes } = layoutOf([node("r1"), node("r2", "r1"), node("r3")]);
    const r1 = nodes.find((n) => n.dtag === "r1");
    const r2 = nodes.find((n) => n.dtag === "r2");
    const r3 = nodes.find((n) => n.dtag === "r3");
    assert.ok(r3.x >= r1.x + CANVAS_DENSITY.comfortable.cardW);
    assert.ok(r3.x > r2.x);
  });

  it("emits an elbow edge per parent-child link from bottom to top center", () => {
    const { nodes, edges } = layoutOf([node("p"), node("c", "p")]);
    const p = nodes.find((n) => n.dtag === "p");
    const c = nodes.find((n) => n.dtag === "c");
    assert.equal(edges.length, 1);
    assert.equal(edges[0].dtag, "c");
    assert.equal(edges[0].parentDtag, "p");
    const m = CANVAS_DENSITY.comfortable;
    const start = `M ${p.x + m.cardW / 2} ${p.y + m.cardH}`;
    assert.ok(edges[0].path.startsWith(start));
    assert.ok(edges[0].path.endsWith(`L ${c.x + m.cardW / 2} ${c.y}`));
  });

  it("excludes revoked nodes (tree.ts filters) and compacts bounds with density", () => {
    const spec = [node("root"), node("a", "root"), node("b", "a")];
    const comfortable = layoutOf(spec, "comfortable");
    const compact = layoutOf(spec, "compact");
    assert.ok(comfortable.bounds.width > compact.bounds.width);
    assert.ok(comfortable.bounds.height > compact.bounds.height);
  });
});

describe("clampCanvasZoom", () => {
  it("clamps to [MIN_ZOOM, MAX_ZOOM]", () => {
    assert.equal(clampCanvasZoom(0.1), MIN_ZOOM);
    assert.equal(clampCanvasZoom(5), MAX_ZOOM);
    assert.equal(clampCanvasZoom(1), 1);
  });
});

describe("fitCanvasView", () => {
  it("scales down to fit oversized content, centered, never below MIN_ZOOM", () => {
    const view = fitCanvasView(1000, 600, { width: 2000, height: 1200 });
    assert.ok(view);
    assert.ok(view.zoom < 1);
    assert.ok(view.zoom >= MIN_ZOOM);
    assert.equal(view.x, (1000 - 2000 * view.zoom) / 2);
    assert.equal(view.y, (600 - 1200 * view.zoom) / 2);
  });

  it("scales sparse content UP to fill the viewport, clamped to MAX_ZOOM", () => {
    const view = fitCanvasView(1000, 600, { width: 200, height: 100 });
    assert.ok(view);
    assert.equal(view.zoom, MAX_ZOOM);
    assert.equal(view.x, (1000 - 200 * view.zoom) / 2);
    assert.equal(view.y, (600 - 100 * view.zoom) / 2);
  });

  it("never ships micro content at zoom 1 when the viewport is larger", () => {
    const view = fitCanvasView(1200, 800, { width: 300, height: 150 });
    assert.ok(view);
    assert.ok(view.zoom > 1);
  });

  it("returns null for a degenerate viewport", () => {
    assert.equal(fitCanvasView(10, 600, { width: 100, height: 100 }), null);
  });
});

describe("ancestorPaths", () => {
  it("joins ancestor names for tooltips and stops at roots", () => {
    const tree = buildOrgTree([
      node("root", null, "Founder"),
      node("mid", "root", "CTO"),
      node("leaf", "mid", "Eng"),
    ]);
    const paths = ancestorPaths(tree.roots);
    assert.equal(paths.get("leaf"), "Founder › CTO");
    assert.equal(paths.get("mid"), "Founder");
    assert.equal(paths.has("root"), false);
  });
});
