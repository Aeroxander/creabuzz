import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  KIND_CHANNEL_METADATA,
  knownBoards,
  NAMED_READ_CHUNK,
  readNamedBoards,
  readRecordsNaming,
} from "./named-boards.ts";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SERVER = "b".repeat(64);

function record(boardId, name, type, at = 100) {
  return {
    id: `meta-${boardId}-${at}`,
    pubkey: SERVER,
    kind: 39000,
    created_at: at,
    tags: [["d", boardId], ["name", name], ["public"], ["t", type]],
  };
}

/**
 * A server with `records`, read the way the real one answers: newest first and cut to the filter's limit. `asked`
 * keeps every filter it was sent.
 */
function server(records, { refuse = () => false } = {}) {
  const asked = [];
  let open = 0;
  let most = 0;
  const read = async (filter) => {
    asked.push(filter);
    open += 1;
    most = Math.max(most, open);
    await new Promise((resolve) => setTimeout(resolve, 1));
    open -= 1;
    if (refuse(filter)) throw new Error("the server did not answer");
    return records
      .filter(
        (r) =>
          filter.kinds.includes(r.kind) &&
          filter["#d"].includes(r.tags.find((t) => t[0] === "d")[1]),
      )
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, filter.limit);
  };
  return { read, asked, mostAtOnce: () => most };
}

describe("reading the boards a project's record names", () => {
  it("asks for them by id, so a board older than the first page of the channel list is still found", async () => {
    // 250 newer channels: a read of the newest 200 would not reach the project's board.
    const newer = Array.from({ length: 250 }, (_, i) =>
      record(id(1000 + i), `room-${i}`, "stream", 900),
    );
    const world = server([
      record(id(1), "nebula-talk", "forum", 100),
      ...newer,
    ]);
    const boards = await readNamedBoards(world.read, [id(1)]);
    assert.deepEqual(
      boards.map((board) => [board.id, board.name]),
      [[id(1), "nebula-talk"]],
    );
    assert.deepEqual(world.asked, [
      { kinds: [KIND_CHANNEL_METADATA], "#d": [id(1)], limit: 2 },
    ]);
  });

  it("leaves out the chat rooms a record names, and anything the server sends that was not asked for", async () => {
    const world = server([
      record(id(1), "nebula-talk", "forum"),
      record(id(2), "general", "stream"),
    ]);
    const stray = record(id(3), "someone-elses", "forum");
    const boards = await readNamedBoards(
      async (filter) => [...(await world.read(filter)), stray],
      [id(1), id(2)],
    );
    assert.deepEqual(
      boards.map((board) => board.id),
      [id(1)],
    );
  });

  it("asks in pieces the server accepts, a few at a time, each id once", async () => {
    const ids = Array.from({ length: 950 }, (_, i) => id(i));
    const world = server(ids.map((board) => record(board, "talk", "forum")));
    const boards = await readNamedBoards(world.read, [...ids, id(0), id(1)]);
    assert.equal(boards.length, 950);
    assert.equal(world.asked.length, 10);
    for (const filter of world.asked) {
      assert.ok(filter["#d"].length <= NAMED_READ_CHUNK);
      assert.equal(filter.limit, filter["#d"].length * 2);
    }
    assert.equal(world.asked.flatMap((filter) => filter["#d"]).length, 950);
    assert.ok(
      world.mostAtOnce() <= 4,
      `at most 4 reads open at once, saw ${world.mostAtOnce()}`,
    );
  });

  it("fails as a whole when one piece fails: never the boards of the pieces that answered", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => id(i));
    const world = server(
      ids.map((board) => record(board, "talk", "forum")),
      { refuse: (filter) => filter["#d"].includes(id(120)) },
    );
    await assert.rejects(
      readNamedBoards(world.read, ids),
      /the server did not answer/,
    );
  });

  it("asks the server nothing when no id is named", async () => {
    const world = server([]);
    assert.deepEqual(await readNamedBoards(world.read, []), []);
    assert.deepEqual(await readRecordsNaming(world.read, 39002, []), []);
    assert.equal(world.asked.length, 0);
  });
});

describe("the boards a project is known to have", () => {
  const board = { name: "supporters", description: "" };

  it("are not known while they are being read, even though the list is empty", () => {
    assert.equal(knownBoards({ boards: [], loading: true, error: null }), null);
  });

  it("are not known when the read failed", () => {
    assert.equal(
      knownBoards({ boards: [], loading: false, error: new Error("no") }),
      null,
    );
    assert.equal(
      knownBoards({ boards: [board], loading: false, error: "refused" }),
      null,
    );
  });

  it("are the list, empty or not, once the read succeeded", () => {
    assert.deepEqual(
      knownBoards({ boards: [], loading: false, error: null }),
      [],
    );
    assert.deepEqual(
      knownBoards({ boards: [board], loading: false, error: undefined }),
      [board],
    );
  });
});
