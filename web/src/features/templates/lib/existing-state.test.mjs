import test from "node:test";
import assert from "node:assert/strict";

import { itemKey } from "@creaton/core/templates/apply.ts";

import { buildExistingState } from "./existing-state.ts";

test("channels are found by name without the leading #, and records only count under their own marker", () => {
  const state = buildExistingState({
    templateId: "demo",
    channelRecords: [
      {
        id: "m1",
        kind: 39000,
        created_at: 1,
        tags: [
          ["d", "chan-1"],
          ["name", "#Writers-Room"],
        ],
      },
      {
        id: "m2",
        kind: 39000,
        created_at: 1,
        tags: [
          ["d", "chan-2"],
          ["name", ""],
        ],
      },
    ],
    markerRecords: [
      {
        id: "p1",
        kind: 30175,
        created_at: 5,
        tags: [
          ["d", "writer"],
          ["t", "demo", "writer"],
        ],
      },
      {
        id: "p2",
        kind: 30175,
        created_at: 5,
        tags: [
          ["d", "other"],
          ["t", "another", "other"],
        ],
      },
      {
        id: "w1",
        kind: 9,
        created_at: 6,
        tags: [
          ["h", "x"],
          ["t", "demo", "welcome"],
        ],
      },
      {
        id: "s1",
        kind: 9,
        created_at: 6,
        tags: [
          ["h", "x"],
          ["t", "demo", "seed:room"],
        ],
      },
      // A page and a note both mean the document is there.
      {
        id: "d1",
        kind: 44001,
        created_at: 7,
        tags: [
          ["d", "story-bible"],
          ["t", "demo", "docs/story-bible.md"],
        ],
      },
      {
        id: "d2",
        kind: 30023,
        created_at: 7,
        tags: [
          ["d", "role-catalog"],
          ["t", "demo", "docs/role-catalog.md"],
        ],
      },
    ],
    orgRecords: [
      { id: "o1", kind: 37010, created_at: 1, tags: [["d", "root"]] },
      { id: "o2", kind: 37012, created_at: 1, tags: [["d", "default-agents"]] },
      { id: "o3", kind: 37010, created_at: 1, tags: [] },
    ],
  });
  assert.equal(state.channels.get("Writers-Room"), "chan-1");
  assert.equal(state.channels.size, 1);
  assert.ok(state.items.has(itemKey("persona", "writer")));
  assert.equal(state.items.has(itemKey("persona", "other")), false);
  assert.ok(state.items.has(itemKey("welcome", "welcome")));
  assert.ok(state.items.has(itemKey("seed", "seed:room")));
  assert.ok(state.items.has(itemKey("doc", "docs/story-bible.md")));
  assert.ok(state.items.has(itemKey("doc", "docs/role-catalog.md")));
  assert.deepEqual([...state.orgNodes], ["root"]);
  assert.deepEqual([...state.orgBudgets], ["default-agents"]);
});

test("when a record was written twice, the newest one is kept, and a skill remembers its source", () => {
  const state = buildExistingState({
    templateId: "demo",
    channelRecords: [],
    markerRecords: [
      {
        id: "old",
        kind: 30180,
        created_at: 1,
        tags: [
          ["d", "craft"],
          ["t", "demo", "craft"],
          ["source", "skills/a.md"],
        ],
      },
      {
        id: "new",
        kind: 30180,
        created_at: 9,
        tags: [
          ["d", "craft"],
          ["t", "demo", "craft"],
          ["source", "skills/b.md"],
        ],
      },
    ],
    orgRecords: [],
  });
  const skill = state.items.get(itemKey("skill", "craft"));
  assert.equal(skill.eventId, "new");
  assert.equal(skill.createdAt, 9);
  assert.equal(skill.source, "skills/b.md");
});
