import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BOARD_PAGE_SIZE,
  BOARD_PAGES_PER_STEP,
  boardsOfSteps,
  readBoardStep,
} from "./board-pages.ts";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SERVER = "b".repeat(64);

function record(boardId, name, type, at) {
  return {
    id: `meta-${boardId}-${at}`,
    pubkey: SERVER,
    kind: 39000,
    created_at: at,
    tags: [
      ["d", boardId],
      ["name", name],
      ["public"],
      ...(type === "dm" ? [["hidden"]] : []),
      ["t", type],
    ],
  };
}

/**
 * A server with `records`, read the way the real one answers a read of channel records: newest first, cut to the
 * limit, and a `#t` asked for matched only AFTER that cut (so asking for boards alone would lose the older ones).
 */
function server(records, { refuse = () => false } = {}) {
  const asked = [];
  const read = async (filter) => {
    asked.push(filter);
    if (refuse(filter, asked.length))
      throw new Error("the server did not answer");
    const cut = records
      .filter(
        (r) =>
          filter.kinds.includes(r.kind) &&
          (filter.until === undefined || r.created_at <= filter.until),
      )
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, filter.limit);
    const types = filter["#t"];
    return types
      ? cut.filter((r) =>
          r.tags.some((t) => t[0] === "t" && types.includes(t[1])),
        )
      : cut;
  };
  return { read, asked };
}

/** `count` channel records newer than any board in these tests, one a second: rooms, with a DM thread every third. */
const newer = (count, from = 1000) =>
  Array.from({ length: count }, (_, i) =>
    record(id(5000 + i), `room-${i}`, i % 3 === 0 ? "dm" : "stream", from + i),
  );

const names = (boards) => boards.map((board) => board.name);

describe("reading a server's boards a step at a time", () => {
  it("finds a board older than the first page of channel records", async () => {
    // 250 newer rooms and DM threads: the newest 200 records hold no board at all.
    const world = server([
      record(id(1), "old-talk", "forum", 100),
      ...newer(250),
    ]);
    const step = await readBoardStep(world.read, undefined);
    assert.deepEqual(names(step.boards), ["old-talk"]);
    assert.equal(step.next, null, "a short page ends the list");
    assert.equal(step.failed, null);
    assert.equal(world.asked.length, 2);
    assert.deepEqual(world.asked[0], {
      kinds: [39000],
      limit: BOARD_PAGE_SIZE,
    });
    // The second read starts at the oldest record of the first.
    assert.deepEqual(world.asked[1], {
      kinds: [39000],
      limit: BOARD_PAGE_SIZE,
      until: 1050,
    });
    // Never by type: the server would match it after cutting the page, and send nothing.
    assert.ok(world.asked.every((filter) => !("#t" in filter)));
  });

  it("lists boards only: not chat rooms, not direct-message threads", async () => {
    const world = server([
      record(id(1), "talk", "forum", 100),
      record(id(2), "general", "stream", 101),
      record(id(3), "dm", "dm", 102),
    ]);
    const step = await readBoardStep(world.read, undefined);
    assert.deepEqual(names(step.boards), ["talk"]);
  });

  it("stops after a fixed number of reads and says where the next step starts, never that the list has ended", async () => {
    const total = BOARD_PAGE_SIZE * BOARD_PAGES_PER_STEP + 150;
    const world = server([
      record(id(1), "old-talk", "forum", 100),
      record(id(2), "new-talk", "forum", 900_000),
      ...newer(total),
    ]);
    const first = await readBoardStep(world.read, undefined);
    assert.equal(world.asked.length, BOARD_PAGES_PER_STEP);
    assert.deepEqual(names(first.boards), ["new-talk"]);
    assert.notEqual(first.next, null, "older records were not looked through");
    assert.equal(first.failed, null);

    const second = await readBoardStep(world.read, first.next);
    assert.deepEqual(names(second.boards), ["old-talk"]);
    assert.equal(second.next, null);
    assert.deepEqual(names(boardsOfSteps([first, second])), [
      "new-talk",
      "old-talk",
    ]);
  });

  it("keeps what it read when a later read of the step fails, and goes on from that read when asked again", async () => {
    let down = true;
    const world = server(
      [
        record(id(1), "old-talk", "forum", 100),
        record(id(2), "new-talk", "forum", 900_000),
        ...newer(450),
      ],
      { refuse: (_filter, nth) => down && nth === 3 },
    );
    const step = await readBoardStep(world.read, undefined);
    assert.deepEqual(names(step.boards), ["new-talk"]);
    assert.match(String(step.failed), /did not answer/);
    // Not the end of the list: the read that failed is where the next step starts.
    assert.deepEqual(step.next, world.asked[2].until);

    down = false;
    const again = await readBoardStep(world.read, step.next);
    assert.deepEqual(names(again.boards), ["old-talk"]);
    assert.equal(again.next, null);
    assert.equal(again.failed, null);
  });

  it("fails when its first read fails: there is no list to pass off as the answer", async () => {
    const world = server([record(id(1), "talk", "forum", 100)], {
      refuse: () => true,
    });
    await assert.rejects(
      readBoardStep(world.read, undefined),
      /did not answer/,
    );
    await assert.rejects(readBoardStep(world.read, 500), /did not answer/);
  });

  it("moves on past a full page made in one second, so the walk always ends", async () => {
    const sameSecond = Array.from({ length: 700 }, (_, i) =>
      record(id(7000 + i), `bulk-${i}`, "stream", 500),
    );
    const world = server([
      record(id(1), "old-talk", "forum", 100),
      ...sameSecond,
    ]);
    const step = await readBoardStep(world.read, undefined);
    assert.deepEqual(names(step.boards), ["old-talk"]);
    assert.equal(step.next, null);
    assert.deepEqual(
      world.asked.map((filter) => filter.until),
      [undefined, 499],
    );
  });

  it("lists a board once, by its newest record, however many steps held it", () => {
    const renamed = [
      { boards: [channel(id(1), "new-name", 300)], next: 200, failed: null },
      { boards: [channel(id(1), "old-name", 100)], next: null, failed: null },
    ];
    assert.deepEqual(names(boardsOfSteps(renamed)), ["new-name"]);
    assert.deepEqual(boardsOfSteps([]), []);
  });
});

function channel(boardId, name, createdAt) {
  return {
    id: boardId,
    name,
    description: "",
    visibility: "public",
    type: "forum",
    direct: false,
    createdAt,
    serverKey: SERVER,
  };
}
