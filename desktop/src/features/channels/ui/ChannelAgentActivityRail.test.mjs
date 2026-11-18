import assert from "node:assert/strict";
import test from "node:test";

import { selectActiveAgentNames } from "./ChannelAgentActivityRail.tsx";

function item(overrides = {}) {
  return {
    id: "e1",
    kind: 44010,
    pubkey: "abc",
    content: "{}",
    createdAt: 1_700_000_000,
    channelId: "chan",
    channelName: "general",
    tags: [],
    category: "agent_activity",
    ...overrides,
  };
}

test("selects distinct names newest-first from capabilities rows", () => {
  const names = selectActiveAgentNames([
    item({ content: JSON.stringify({ name: "Ralph" }), createdAt: 100 }),
    item({ content: JSON.stringify({ name: "Scout" }), createdAt: 200 }),
    item({ content: JSON.stringify({ name: "Ralph" }), createdAt: 300 }),
  ]);
  assert.deepEqual(names, ["Ralph", "Scout"]);
});

test("ignores non-capabilities rows and malformed content", () => {
  const names = selectActiveAgentNames([
    item({ kind: 44011, content: JSON.stringify({ title: "T" }) }),
    item({ content: "not json" }),
    item({ content: JSON.stringify({ name: "  " }) }),
    item({ content: JSON.stringify({ name: "Ada" }) }),
  ]);
  assert.deepEqual(names, ["Ada"]);
});

test("caps the roster line", () => {
  const rows = Array.from({ length: 8 }, (_, i) =>
    item({ id: `e${i}`, content: JSON.stringify({ name: `Bot${i}` }) }),
  );
  assert.equal(selectActiveAgentNames(rows).length, 5);
});
