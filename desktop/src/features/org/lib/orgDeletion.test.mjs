// Unit tests for the shared org addressable-event deletion helper.
// Run with: node --import ./test-loader.mjs --experimental-strip-types --test src/features/org/lib/orgDeletion.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { deleteAddressableEvents } from "./orgDeletion.ts";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const NOW = 1_000;

function headEvent(pubkey, dtag, createdAt) {
  return {
    id: `head-${pubkey.slice(0, 4)}-${dtag}`,
    pubkey,
    created_at: createdAt,
    kind: 37010,
    tags: [["d", dtag]],
    content: "{}",
    sig: "sig",
  };
}

function makeDeps({ heads = [], afterPublishHeads = [] } = {}) {
  const signed = [];
  const published = [];
  let fetchCount = 0;
  return {
    signed,
    published,
    fetchEvents: async () => {
      fetchCount += 1;
      return fetchCount === 1 ? [...heads] : [...afterPublishHeads];
    },
    nowSeconds: () => NOW,
    publishEvent: async (event, timeoutMessage, failureMessage) => {
      published.push({ event, timeoutMessage, failureMessage });
    },
    signEvent: async (template) => {
      signed.push(template);
      return {
        id: `del-${signed.length}`,
        pubkey: ALICE,
        created_at: template.createdAt,
        kind: template.kind,
        tags: template.tags,
        content: template.content,
        sig: "sig",
      };
    },
  };
}

const TARGET = {
  kind: 37010,
  dtag: "eng",
  label: "org node",
  timeoutMessage: "Timed out deleting org node.",
  failureMessage: "Failed to delete org node.",
};

describe("deleteAddressableEvents", () => {
  it("tombstones the exact live coordinate with a bumped created_at", async () => {
    const deps = makeDeps({ heads: [headEvent(ALICE, "eng", 1_500)] });
    await deleteAddressableEvents(TARGET, deps);
    assert.equal(deps.signed.length, 1);
    const template = deps.signed[0];
    assert.equal(template.kind, 5);
    assert.equal(template.tags[0][0], "a");
    assert.equal(template.tags[0][1], `37010:${ALICE}:eng`);
    // Bumped past the live head (1500 + 1), not just "now".
    assert.equal(template.createdAt, 1_501);
    assert.equal(deps.published.length, 1);
    assert.equal(deps.published[0].timeoutMessage, TARGET.timeoutMessage);
    assert.equal(deps.published[0].failureMessage, TARGET.failureMessage);
  });

  it("throws when the coordinate has no live head", async () => {
    const deps = makeDeps({ heads: [] });
    await assert.rejects(
      () => deleteAddressableEvents(TARGET, deps),
      /Could not find this org node on the relay/,
    );
    assert.equal(deps.published.length, 0);
  });

  it("detects a concurrent replacement and throws", async () => {
    const deps = makeDeps({
      heads: [headEvent(ALICE, "eng", 1_500)],
      // After publishing, a newer head exists again: someone re-created it.
      afterPublishHeads: [headEvent(ALICE, "eng", 2_000)],
    });
    await assert.rejects(
      () => deleteAddressableEvents(TARGET, deps),
      /was updated while it was being deleted/,
    );
  });

  it("tombstones each author's coordinate behind the same d tag", async () => {
    const deps = makeDeps({
      heads: [
        headEvent(ALICE, "eng", 1_500),
        headEvent(BOB, "eng", 1_400),
        // An older event from ALICE must not get its own tombstone: the
        // newest head per author is the live coordinate.
        headEvent(ALICE, "eng", 1_200),
      ],
    });
    await deleteAddressableEvents(TARGET, deps);
    assert.equal(deps.signed.length, 2);
    const coordinates = deps.signed.map((t) => t.tags[0][1]).sort();
    assert.deepEqual(coordinates, [`37010:${ALICE}:eng`, `37010:${BOB}:eng`]);
  });
});
