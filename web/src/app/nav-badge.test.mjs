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

test("the one bell reads the rooms' poll through communityBadge, and counts it with the rest", () => {
  const source = readFileSync(new URL("./AppNav.tsx", import.meta.url), "utf8");
  assert.match(source, /communityBadge\(\{ view, unread \}\)/);
  assert.match(source, /<InboxLinks rooms=\{rooms\} \/>/);
  const bell = readFileSync(
    new URL("../features/social/ui/SocialShell.tsx", import.meta.url),
    "utf8",
  );
  assert.match(bell, /const unread = badge\.unread \+ rooms\.count;/);
  assert.match(bell, /const failed = badge\.failed \|\| rooms\.failed;/);
});
