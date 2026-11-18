// Variant→palette contract for the semantic status tier. Pure mapping test —
// the components are thin consumers; this pins the vocabulary (docs/
// paperclip-ux-reference.md §5: "Status is systematic").
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  STATUS_BADGE_VARIANTS,
  STATUS_TONE_CLASSES,
  statusBadgeClasses,
  statusBadgeLabel,
  statusToneOf,
} from "./statusTone.ts";

test("each badge variant maps to exactly one tone and one label", () => {
  assert.deepEqual(statusToneOf("pending"), "waiting");
  assert.deepEqual(statusToneOf("resolving"), "live");
  assert.deepEqual(statusToneOf("approved"), "ok");
  assert.deepEqual(statusToneOf("denied"), "blocking");
  assert.deepEqual(statusToneOf("review"), "review");
  assert.deepEqual(statusToneOf("neutral"), "neutral");

  assert.deepEqual(statusBadgeLabel("pending"), "Pending");
  assert.deepEqual(statusBadgeLabel("resolving"), "Resolving");
  assert.deepEqual(statusBadgeLabel("approved"), "Approved");
  assert.deepEqual(statusBadgeLabel("denied"), "Denied");
  assert.deepEqual(statusBadgeLabel("review"), "In review");
  assert.deepEqual(statusBadgeLabel("neutral"), "Neutral");
});

test("every tone routes through the status-* token tier, never raw colors", () => {
  for (const [tone, classes] of Object.entries(STATUS_TONE_CLASSES)) {
    for (const [key, value] of Object.entries(classes)) {
      assert.match(
        value,
        new RegExp(
          `^(?:[a-z-]+ )*(?:text|bg|border)-status-${tone}(?:-bg|-border)?(?: |$)`,
        ),
        `${tone}.${key} must use the status-${tone} token: ${value}`,
      );
      assert.doesNotMatch(value, /#[0-9a-f]{3,8}/i, `${tone}.${key}`);
    }
  }
});

test("pill classes carry surface, hairline, and saturated text", () => {
  const { pill, dot } = statusBadgeClasses("denied");
  assert.match(pill, /bg-status-blocking-bg/);
  assert.match(pill, /border-status-blocking-border/);
  assert.match(pill, /text-status-blocking/);
  assert.deepEqual(dot, "bg-status-blocking");
});

test("statusBadgeClasses agrees with the variant table", () => {
  for (const variant of Object.keys(STATUS_BADGE_VARIANTS)) {
    const resolved = statusBadgeClasses(variant);
    assert.deepEqual(resolved.label, statusBadgeLabel(variant));
    assert.match(resolved.pill, new RegExp(`status-${statusToneOf(variant)}`));
    assert.deepEqual(resolved.dot, `bg-status-${statusToneOf(variant)}`);
  }
});
