import assert from "node:assert/strict";
import test from "node:test";

import { defaultProfileTab, tabFromHash } from "./profile-tab.ts";

const none = { foundedProject: false, hasWork: false };

test("a profile waits for the record read before it picks a tab", () => {
  assert.equal(
    defaultProfileTab({ read: "pending", foundedProject: true, hasWork: true }),
    "pending",
  );
});

test("a founder or someone with work opens on Record once the read has finished", () => {
  assert.equal(
    defaultProfileTab({ read: "done", foundedProject: true, hasWork: false }),
    "record",
  );
  assert.equal(
    defaultProfileTab({ read: "done", foundedProject: false, hasWork: true }),
    "record",
  );
});

test("someone with neither opens on Posts", () => {
  assert.equal(defaultProfileTab({ read: "done", ...none }), "posts");
});

test("a failed read keeps Posts, whatever else is known", () => {
  assert.equal(
    defaultProfileTab({ read: "failed", foundedProject: true, hasWork: true }),
    "posts",
  );
});

test("an address that names a tab names it, and anything else names none", () => {
  assert.equal(tabFromHash("#record"), "record");
  assert.equal(tabFromHash("posts"), "posts");
  assert.equal(tabFromHash("#nonsense"), null);
  assert.equal(tabFromHash(""), null);
});
