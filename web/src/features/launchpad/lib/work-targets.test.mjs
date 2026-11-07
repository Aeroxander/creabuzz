import assert from "node:assert/strict";
import { test } from "node:test";

import {
  boundTargets,
  contributorWorkTargets,
  NEWEST_CONTRIBUTOR_PROJECTS,
} from "./work-targets.ts";

const ME = "1".repeat(64);
const dao = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const launch = (n, { contributor = true, updates = [] } = {}) => ({
  record: {
    id: `p${n}`,
    author: "a".repeat(64),
    createdAt: n,
    treasury: dao(n),
    tokenPlan: { mode: "dao" },
    funding: contributor ? { path: "contributors" } : { path: "raise" },
    auction: "",
  },
  bids: [],
  updates,
  proposals: [],
  receipts: [],
});
const evidence = (author) => ({
  author,
  claim: { id: "0x", mandate: "0x", check: "" },
});

test("Home looks at contributor projects someone submitted work to, and the newest few for reviewers", () => {
  const launches = [
    launch(1, { updates: [evidence(ME)] }),
    launch(2),
    launch(3),
    launch(4),
    launch(5, { contributor: false }),
  ];
  const found = contributorWorkTargets(launches, ME).map(
    (t) => t.launch.record.id,
  );
  // Where they submitted work first, however old; then the newest contributor projects, never a raise.
  assert.deepEqual(
    found,
    ["p1", "p4", "p3"].slice(0, 1 + NEWEST_CONTRIBUTOR_PROJECTS),
  );
  // Someone else's evidence does not tie a person to a project.
  assert.deepEqual(
    contributorWorkTargets(
      [launch(1, { updates: [evidence("2".repeat(64))] })],
      ME,
    ).length,
    1,
    "only as one of the newest",
  );
  // Skipped launches (the sandbox) are never looked at.
  assert.deepEqual(
    contributorWorkTargets([launch(1)], ME, () => true),
    [],
  );
});

test("projects found only as the newest are marked so, and never push out the person's own", () => {
  const found = contributorWorkTargets(
    [launch(1, { updates: [evidence(ME)] }), launch(8), launch(9)],
    ME,
  );
  assert.deepEqual(
    found.map((t) => [t.launch.record.id, t.discovery]),
    [
      ["p1", false],
      ["p9", true],
      ["p8", true],
    ],
  );
  // Six projects of their own, all older than two newest contributor projects: the six are kept, the newest are not.
  const own = [1, 2, 3, 4, 5, 6].map((n) => ({
    launch: launch(n),
    dao: dao(n),
  }));
  const newest = [8, 9].map((n) => ({ launch: launch(n), dao: dao(n) }));
  assert.deepEqual(
    boundTargets(own, newest, 6).map((t) => t.launch.record.id),
    ["p6", "p5", "p4", "p3", "p2", "p1"],
  );
  // With room left, the newest fill it, newest first, and one already theirs is not counted twice.
  assert.deepEqual(
    boundTargets(own.slice(0, 3), [...newest, own[0]], 6).map(
      (t) => t.launch.record.id,
    ),
    ["p3", "p2", "p1", "p9", "p8"],
  );
});
