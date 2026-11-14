import assert from "node:assert/strict";
import test from "node:test";

import * as Y from "yjs";

import { applyPeerUpdate } from "./sync-loop.ts";

/**
 * Reproduce the production message policy between two peers: apply an incoming
 * update, then echo our full state if the update was new to us.
 *
 * The echo is what makes a late joiner converge, and it is also what made the
 * room chatty forever: without the guard, both peers keep answering each
 * other's echo with their own echo, one message per throttle window, and the
 * loop only stops when the socket does.
 */
function exchange({ guarded, limit = 50 }) {
  const peers = [new Y.Doc(), new Y.Doc()];
  peers[1].getText("content").insert(0, "hello from peer B");

  let messages = 0;
  const queue = [{ index: 0, bytes: Y.encodeStateAsUpdate(peers[1]) }];
  while (queue.length > 0 && messages < limit) {
    const { index, bytes } = queue.shift();
    messages += 1;
    const advanced = applyPeerUpdate(peers[index], bytes);
    const echo = guarded ? advanced : true;
    if (echo) {
      queue.push({
        index: index === 0 ? 1 : 0,
        bytes: Y.encodeStateAsUpdate(peers[index]),
      });
    }
  }
  assert.equal(
    peers[0].getText("content").toString(),
    peers[1].getText("content").toString(),
    "peers must converge either way",
  );
  return messages;
}

test("an update we already had does not advance the document", () => {
  const local = new Y.Doc();
  const remote = new Y.Doc();
  remote.getText("content").insert(0, "shared");

  const update = Y.encodeStateAsUpdate(remote);
  assert.equal(applyPeerUpdate(local, update), true, "first sight is new");
  assert.equal(
    applyPeerUpdate(local, update),
    false,
    "a duplicate must not report new state, or the caller echoes it back",
  );
  assert.equal(
    applyPeerUpdate(local, Y.encodeStateAsUpdate(remote)),
    false,
    "a peer's full state is not new either",
  );
});

test("a guarded echo settles instead of running forever", () => {
  assert.equal(exchange({ guarded: true }), 2, "one update, one echo, done");
});

test("the unguarded policy is what the guard fixes", () => {
  // Falsifiability check for the guard: if `applyPeerUpdate` stopped reporting
  // duplicates, the guarded run above would look the same as this one.
  assert.equal(exchange({ guarded: false, limit: 40 }), 40, "hits the cap");
});
