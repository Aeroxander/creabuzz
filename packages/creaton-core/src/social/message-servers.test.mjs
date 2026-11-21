import assert from "node:assert/strict";
import test from "node:test";

import { listsServer, messageServersChange } from "./message-servers.ts";

const here = "wss://community.test";
const other = ["relay", "wss://other.test"];

test("turning this server on keeps every other server and tag, and never adds it twice", () => {
  const latest = { tags: [other, ["alt", "dm servers"]], content: "" };
  const on = messageServersChange(latest, here, true);
  assert.equal(on.kind, 10050);
  assert.deepEqual(on.tags, [other, ["alt", "dm servers"], ["relay", here]]);
  assert.deepEqual(
    messageServersChange({ tags: on.tags }, `${here}/`, true).tags,
    on.tags,
  );
});

test("turning it off removes only this server, however its address is written", () => {
  const latest = {
    tags: [["relay", "WSS://Community.test/"], other],
    content: "",
  };
  assert.ok(listsServer(latest, here));
  assert.deepEqual(messageServersChange(latest, here, false).tags, [other]);
  assert.equal(
    listsServer(messageServersChange(latest, here, false), here),
    false,
  );
});

test("no list yet: on makes a list of one, off makes an empty one", () => {
  assert.deepEqual(messageServersChange(null, here, true).tags, [
    ["relay", here],
  ]);
  assert.deepEqual(messageServersChange(null, here, false).tags, []);
  assert.equal(listsServer(null, here), false);
});
