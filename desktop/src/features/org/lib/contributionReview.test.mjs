import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { buildReviewRepublish } from "./contributionReview.ts";

test("Accept copies the record rendered on screen, not a newer store version", () => {
  const displayed = {
    content: {
      action: "shipped parser",
      note: "on-screen version",
      reviewStatus: "pending",
    },
    tags: [
      ["d", "rec-1"],
      ["e", "on-screen-evidence"],
    ],
  };
  // A concurrent edit landed after render (the store now holds a different
  // version); Accept must still publish the version the reviewer saw.
  const draft = buildReviewRepublish(displayed, {
    reviewStatus: "accepted",
    nowSecs: 1_000,
  });
  const content = JSON.parse(draft.content);
  assert.equal(content.note, "on-screen version");
  assert.equal(content.action, "shipped parser");
  assert.equal(content.reviewStatus, "accepted");
  assert.deepEqual(draft.tags, [
    ["d", "rec-1"],
    ["e", "on-screen-evidence"],
  ]);
});

test("the displayed snapshot is copied, never mutated", () => {
  const displayed = {
    content: { reviewStatus: "pending" },
    tags: [["d", "rec-1"]],
  };
  buildReviewRepublish(displayed, { reviewStatus: "rejected" });
  assert.equal(displayed.content.reviewStatus, "pending");
});

test("appeals append to the on-screen history with the note", () => {
  const displayed = {
    content: {
      reviewStatus: "rejected",
      appealHistory: [{ status: "rejected", at: 1 }],
    },
    tags: [],
  };
  const draft = buildReviewRepublish(displayed, {
    reviewStatus: "appealed",
    appealNote: "the on-screen evidence shows otherwise",
    nowSecs: 2_000,
  });
  const content = JSON.parse(draft.content);
  assert.deepEqual(content.appealHistory, [
    { status: "rejected", at: 1 },
    {
      status: "appealed",
      at: 2_000,
      note: "the on-screen evidence shows otherwise",
    },
  ]);
});

test("the review mutation never reads the store at click time (mutation seam)", () => {
  const hooks = readFileSync(
    new URL("../hooks/contributionHooks.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    !/\bfetchEvents\s*\(/.test(hooks),
    "republish must copy the displayed record — a click-time read fails here",
  );
  assert.match(hooks, /buildReviewRepublish/);
});
