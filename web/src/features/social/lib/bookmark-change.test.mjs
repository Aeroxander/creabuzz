import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createListWriter } from "../../feed/lib/follow-queue.ts";
import { followedLaunches, withLaunch } from "../../feed/lib/lists.ts";
import {
  bookmarkChange,
  savedIds,
  UNREADABLE_BOOKMARKS,
} from "./bookmark-change.ts";

const ME = "a".repeat(64);
const SCOPE = `ws://server|${ME}`;
const KIND = 10003;
const NOW = Math.floor(Date.now() / 1000) + 10_000;
const COORD = `37001:${"d".repeat(64)}:film`;
const POST_A = "1".repeat(64);
const POST_B = "2".repeat(64);

// A reversible stand-in for the reader's NIP-44 key: it hides nothing, but a list it did not seal cannot be opened.
const crypto = {
  seal: async (text) => `sealed:${text}`,
  open: async (text) => {
    if (!text.startsWith("sealed:")) throw new Error("not mine");
    return text.slice("sealed:".length);
  },
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 3));

/** A server that keeps the newest bookmark list and answers after a delay, as the real one does over a socket. */
function fakeServer({ initial = null, refuse = false } = {}) {
  let n = 0;
  const state = { latest: initial, published: 0 };
  const deps = {
    now: () => NOW,
    readLatest: async () => {
      const answer = state.latest;
      await tick();
      return answer;
    },
    publish: async (template) => {
      await tick();
      if (refuse) throw new Error("The server did not accept this change.");
      state.published += 1;
      const signed = {
        ...template,
        id: String(++n).padStart(64, "0"),
        pubkey: ME,
      };
      const cur = state.latest;
      if (!cur || signed.created_at > cur.created_at) state.latest = signed;
      return signed;
    },
  };
  return { state, deps };
}

const save = (writer, id, saved) =>
  writer.enqueue({
    scope: SCOPE,
    author: ME,
    kind: KIND,
    target: id,
    follow: saved,
    apply: async (latest) =>
      (await bookmarkChange(latest, id, saved, crypto)).template,
  });

describe("bookmarkChange", () => {
  it("saves a post privately and reads it back from the written list", async () => {
    const { state, deps } = fakeServer();
    await save(createListWriter(deps), POST_A, true);
    assert.deepEqual(await savedIds(state.latest, crypto.open), [POST_A]);
    // Nothing public says what was saved.
    assert.equal(JSON.stringify(state.latest.tags).includes(POST_A), false);
    assert.equal(state.latest.kind, KIND);
  });

  it("reports the ids the list holds after the change", async () => {
    const { template, ids } = await bookmarkChange(null, POST_A, true, crypto);
    assert.deepEqual(ids, [POST_A]);
    assert.equal(template.kind, KIND);
    const removed = await bookmarkChange(
      {
        id: "f".repeat(64),
        pubkey: ME,
        kind: KIND,
        created_at: NOW,
        tags: [],
        content: template.content,
      },
      POST_A,
      false,
      crypto,
    );
    assert.deepEqual(removed.ids, []);
    assert.equal(removed.template.content, "");
  });

  it("keeps both of two posts saved at once, and removes only the one asked for", async () => {
    const { state, deps } = fakeServer();
    const writer = createListWriter(deps);
    await Promise.all([save(writer, POST_A, true), save(writer, POST_B, true)]);
    assert.deepEqual((await savedIds(state.latest, crypto.open)).sort(), [
      POST_A,
      POST_B,
    ]);
    await save(writer, POST_A, false);
    assert.deepEqual(await savedIds(state.latest, crypto.open), [POST_B]);
  });

  it("keeps a launch follow made at the same moment as a save", async () => {
    const { state, deps } = fakeServer();
    const writer = createListWriter(deps);
    await Promise.all([
      save(writer, POST_A, true),
      writer.enqueue({
        scope: SCOPE,
        author: ME,
        kind: KIND,
        target: COORD,
        follow: true,
        apply: (latest) => withLaunch(latest, COORD, true),
      }),
      save(writer, POST_B, true),
    ]);
    assert.deepEqual([...followedLaunches(state.latest)], [COORD]);
    assert.deepEqual((await savedIds(state.latest, crypto.open)).sort(), [
      POST_A,
      POST_B,
    ]);
  });

  it("refuses to write over a list it cannot open, and leaves it as it was", async () => {
    const foreign = {
      id: "e".repeat(64),
      pubkey: ME,
      kind: KIND,
      created_at: NOW,
      tags: [["e", POST_B]],
      content: "sealed-by-another-app",
    };
    const { state, deps } = fakeServer({ initial: foreign });
    await assert.rejects(save(createListWriter(deps), POST_A, true), {
      message: UNREADABLE_BOOKMARKS,
    });
    assert.equal(state.published, 0);
    assert.equal(state.latest, foreign);
    // Reading still shows the public entries.
    assert.deepEqual(await savedIds(foreign, crypto.open), [POST_B]);
  });

  it("rejects when the server refuses the save, and leaves nothing waiting", async () => {
    const { state, deps } = fakeServer({ refuse: true });
    const writer = createListWriter(deps);
    await assert.rejects(save(writer, POST_A, true), /did not accept/);
    assert.equal(writer.pendingFor(SCOPE, KIND, POST_A), undefined);
    assert.equal(state.latest, null);
  });

  it("shows the wanted state while the save is on its way", async () => {
    const { deps } = fakeServer();
    const writer = createListWriter(deps);
    const done = save(writer, POST_A, true);
    assert.equal(writer.pendingFor(SCOPE, KIND, POST_A), true);
    await done;
    assert.equal(writer.pendingFor(SCOPE, KIND, POST_A), undefined);
  });
});
