// Golden vectors for the generated event-kind tables: the generated TS table
// must equal the Rust registry exactly (guards scripts/regen-kinds.mjs), and
// key wire-format constants — registry kinds plus the client-only aliases —
// stay pinned to today's values so a renumbering can never slip through.
// Run with: node --experimental-strip-types --test src/kinds.generated.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import * as generated from "./kinds.generated.ts";
import * as kinds from "./kinds.ts";

const RUST = readFileSync(
  new URL("../../../crates/buzz-core/src/kind.rs", import.meta.url),
  "utf8",
);
const rustKinds = new Map(
  [...RUST.matchAll(/pub const (KIND_[A-Z0-9_]+): u32 = (\d+);/g)].map(
    (match) => [match[1], Number(match[2])],
  ),
);

test("the generated table is exactly the Rust registry", () => {
  const generatedKinds = new Map(
    Object.entries(generated).filter(([name]) => name.startsWith("KIND_")),
  );
  assert.deepEqual(generatedKinds, rustKinds);
});

test("the shared kinds module re-exports every registry kind unchanged", () => {
  // A plain copy, so lookups by computed name are not dynamic namespace access.
  const table = { ...kinds };
  let compared = 0;
  for (const [name, value] of rustKinds) {
    assert.equal(table[name], value, name);
    compared += 1;
  }
  assert.ok(compared >= 100, `only ${compared} registry kinds were compared`);
});

test("key wire-format constants keep their pinned values", () => {
  // Registry kinds.
  assert.equal(kinds.KIND_PROFILE, 0);
  assert.equal(kinds.KIND_TEXT_NOTE, 1);
  assert.equal(kinds.KIND_CONTACT_LIST, 3);
  assert.equal(kinds.KIND_DELETION, 5);
  assert.equal(kinds.KIND_REACTION, 7);
  assert.equal(kinds.KIND_STREAM_MESSAGE, 9);
  assert.equal(kinds.KIND_AUTH, 22242);
  assert.equal(kinds.KIND_READ_STATE, 30078);
  assert.equal(kinds.KIND_SKILL, 30180);
  assert.equal(kinds.KIND_LAUNCH_RECORD, 37001);
  assert.equal(kinds.KIND_ORG_NODE, 37010);
  assert.equal(kinds.KIND_STREAM_MESSAGE_V2, 40002);
  assert.equal(kinds.KIND_SYSTEM_MESSAGE, 40099);
  assert.equal(kinds.KIND_WIKI_PAGE, 44001);
  assert.equal(kinds.KIND_AUDIT_ENTRY, 48001);
  // Client-only aliases and grouped sets (not registry names).
  assert.equal(kinds.KIND_CHANNEL_SECTIONS, 30078);
  assert.equal(kinds.KIND_CHANNEL_WINDOW_BOUNDS, 39006);
  assert.equal(kinds.KIND_REMINDER, 40007);
  assert.equal(kinds.KIND_APPROVAL_REQUEST, 46010);
  assert.deepEqual(
    [...kinds.ORG_EVENT_KINDS],
    [37010, 37011, 37012, 37013, 37014, 37015, 37016],
  );
  assert.deepEqual(
    [...kinds.LAUNCHPAD_EVENT_KINDS],
    [37001, 47002, 47003, 47004, 47005, 37006],
  );
});
