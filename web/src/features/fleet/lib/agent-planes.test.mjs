// The browser agent's chat-plane contract: it posts on the live plane (kind 9)
// and reads both chat planes (kind 9 + kind 40002) so history and v2 posts
// render. Run with:
// node --experimental-strip-types --test src/features/fleet/lib/agent-planes.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { agentContextFilter, buildAgentTurnEvent } from "./agent-planes.ts";
import {
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_V2,
} from "../../../shared/constants/kinds.ts";

test("the agent posts its turns on the live chat plane (kind 9)", () => {
  const event = buildAgentTurnEvent("done", [
    ["h", "chan-1"],
    ["e", "parent-1"],
  ]);
  assert.equal(event.kind, 9, "wire plane, not the v2 line");
  assert.equal(event.kind, KIND_STREAM_MESSAGE, "canonical constant");
  assert.notEqual(event.kind, KIND_STREAM_MESSAGE_V2);
  assert.equal(event.content, "done");
  assert.deepEqual(event.tags, [
    ["h", "chan-1"],
    ["e", "parent-1"],
  ]);
});

test("channel-context reads cover both chat planes plus kind-1 notes", () => {
  const filter = agentContextFilter("chan-1");
  assert.deepEqual(
    [...filter.kinds].sort((a, b) => a - b),
    [1, 9, 40002],
    "history (9), v2 posts (40002) and plain notes (1) all render",
  );
  assert.ok(filter.kinds.includes(KIND_STREAM_MESSAGE));
  assert.ok(filter.kinds.includes(KIND_STREAM_MESSAGE_V2));
  assert.deepEqual(filter["#h"], ["chan-1"]);
  assert.equal(filter.limit, 25);
});

test("everything the agent posts is readable on the planes it reads", () => {
  const filter = agentContextFilter("chan-1");
  assert.ok(
    filter.kinds.includes(buildAgentTurnEvent("x", []).kind),
    "the agent must read back what it writes",
  );
});
