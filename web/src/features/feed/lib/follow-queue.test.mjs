import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createListWriter, MAX_QUEUED_LIST_WRITES } from "./follow-queue.ts";
import { followedPeople, withPerson } from "./lists.ts";

const ME = "a".repeat(64);
const ALICE = "b".repeat(64);
const CAROL = "c".repeat(64);
const DEV = "d".repeat(64);
const SCOPE = `ws://server|${ME}`;

// Later than the wall clock `withPerson` dates from, so only the queue's own dating can move a write past it.
const NOW = Math.floor(Date.now() / 1000) + 10_000;

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A server that keeps the newest contact list, answering reads and writes after a delay, as the real one does over a
 * socket. `now` is frozen so every write lands in the same second unless the writer dates it later.
 */
function fakeServer({ initial = null, failPublish = () => false } = {}) {
  let n = 0;
  const state = { latest: initial, published: [], reads: 0 };
  const deps = {
    now: () => NOW,
    readLatest: async (write) => {
      assert.equal(write.author, ME);
      state.reads += 1;
      const answer = state.latest;
      await tick();
      return answer;
    },
    publish: async (template) => {
      await tick();
      if (failPublish(template)) throw new Error("The server refused it.");
      const signed = {
        ...template,
        id: String(++n).padStart(64, "0"),
        pubkey: ME,
      };
      state.published.push(signed);
      // Replaceable: the newest wins, ties by the larger id.
      const cur = state.latest;
      if (
        !cur ||
        signed.created_at > cur.created_at ||
        (signed.created_at === cur.created_at && signed.id > cur.id)
      ) {
        state.latest = signed;
      }
      return signed;
    },
  };
  return { state, deps };
}

const follow = (person, extra = {}) => ({
  scope: SCOPE,
  author: ME,
  kind: 3,
  target: person,
  follow: true,
  apply: (latest) => withPerson(latest, person, true),
  ...extra,
});

describe("createListWriter", () => {
  it("keeps both of two follows made at once", async () => {
    const { state, deps } = fakeServer({
      initial: {
        id: "0".repeat(64),
        pubkey: ME,
        kind: 3,
        created_at: NOW,
        tags: [["p", DEV]],
        content: "",
      },
    });
    const writer = createListWriter(deps);
    await Promise.all([
      writer.enqueue(follow(ALICE)),
      writer.enqueue(follow(CAROL)),
    ]);
    assert.deepEqual(
      [...followedPeople(state.latest)].sort(),
      [ALICE, CAROL, DEV].sort(),
    );
  });

  it("dates every write strictly after the list it replaces, even in the same second", async () => {
    const { state, deps } = fakeServer({
      initial: {
        id: "0".repeat(64),
        pubkey: ME,
        kind: 3,
        created_at: NOW,
        tags: [],
        content: "",
      },
    });
    const writer = createListWriter(deps);
    await Promise.all([
      writer.enqueue(follow(ALICE)),
      writer.enqueue(follow(CAROL)),
      writer.enqueue(follow(DEV)),
    ]);
    assert.deepEqual(
      state.published.map((e) => e.created_at),
      [NOW + 1, NOW + 2, NOW + 3],
    );
  });

  it("builds on the list it wrote when a read still answers with an older one", async () => {
    const { state, deps } = fakeServer();
    const stale = { ...deps, readLatest: async () => null };
    const writer = createListWriter(stale);
    await writer.enqueue(follow(ALICE));
    await writer.enqueue(follow(CAROL));
    assert.deepEqual(
      [...followedPeople(state.latest)].sort(),
      [ALICE, CAROL].sort(),
    );
    // A cached read that predates both writes is fenced off too.
    assert.equal(writer.newest(SCOPE, 3, null), state.latest);
  });

  it("rejects a refused write, keeps the list as it was, and still runs the next change", async () => {
    const { state, deps } = fakeServer({
      failPublish: (template) =>
        template.tags.some((t) => t[0] === "p" && t[1] === ALICE),
    });
    const writer = createListWriter(deps);
    const refused = writer.enqueue(follow(ALICE));
    const next = writer.enqueue(follow(CAROL));
    await assert.rejects(refused, /refused/);
    await next;
    assert.deepEqual([...followedPeople(state.latest)], [CAROL]);
    assert.equal(writer.pendingFor(SCOPE, 3, ALICE), undefined);
  });

  it("rejects without writing when the newest list cannot be read", async () => {
    const { state, deps } = fakeServer();
    const writer = createListWriter({
      ...deps,
      readLatest: async () => {
        throw new Error("no answer");
      },
    });
    await assert.rejects(writer.enqueue(follow(ALICE)), /no answer/);
    assert.equal(state.published.length, 0);
  });

  it("shows the state a change waits for until it is written, and the written list before that clears", async () => {
    const { deps } = fakeServer();
    const writer = createListWriter(deps);
    let seenOnWrite;
    const done = writer.enqueue(
      follow(ALICE, {
        onWritten: () => {
          seenOnWrite = writer.pendingFor(SCOPE, 3, ALICE);
        },
      }),
    );
    assert.equal(writer.pendingFor(SCOPE, 3, ALICE), true);
    assert.equal(writer.pendingFor(`ws://other|${ME}`, 3, ALICE), undefined);
    await done;
    assert.equal(seenOnWrite, true);
    assert.equal(writer.pendingFor(SCOPE, 3, ALICE), undefined);
  });

  it("refuses more waiting changes than it holds", async () => {
    const { deps } = fakeServer();
    const writer = createListWriter(deps);
    const waiting = Array.from({ length: MAX_QUEUED_LIST_WRITES }, (_, i) =>
      writer.enqueue(follow(String(i).padStart(64, "e"))),
    );
    await assert.rejects(writer.enqueue(follow(ALICE)), /Too many/);
    await Promise.all(waiting);
  });
});
