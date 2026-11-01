import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { communityBadge } from "./nav-badge.ts";

test("a failed poll with nothing read is marked, never shown as no count", () => {
  assert.deepEqual(communityBadge({ view: "error", unread: 0 }), {
    count: 0,
    failed: true,
  });
});

test("a read poll shows its count; nothing new shows nothing", () => {
  assert.deepEqual(communityBadge({ view: "list", unread: 3 }), {
    count: 3,
    failed: false,
  });
  assert.deepEqual(communityBadge({ view: "empty", unread: 0 }), {
    count: 0,
    failed: false,
  });
  assert.deepEqual(communityBadge({ view: "loading", unread: 0 }), {
    count: 0,
    failed: false,
  });
});

test("the main nav's Communities item reads the poll's state through communityBadge", () => {
  const source = readFileSync(new URL("./AppNav.tsx", import.meta.url), "utf8");
  assert.match(source, /communityBadge\(\{ view, unread \}\)/);
  assert.match(
    source,
    /data-testid=\{`\$\{navTestId\(item\)\}-badge-failed`\}/,
  );
});
