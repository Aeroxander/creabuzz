import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BOARDS_NOT_KNOWN,
  createProjectStarterBoards,
  starterMemoKey,
} from "./project-starter.ts";

import { STARTER_BOARDS } from "./starter-boards.ts";

const have = (name) => {
  const board = STARTER_BOARDS.find((b) => b.name === name);
  return { name: board.name, description: board.purpose };
};

const scope = {
  relay: "wss://one.example/",
  founder: "A".repeat(64),
  projectId: "nebula",
};

function memoryStore(fail = false) {
  const map = new Map();
  return {
    map,
    getItem: (key) => {
      if (fail) throw new Error("blocked");
      return map.has(key) ? map.get(key) : null;
    },
    setItem: (key, value) => {
      if (fail) throw new Error("blocked");
      map.set(key, String(value));
    },
    removeItem: (key) => {
      if (fail) throw new Error("blocked");
      map.delete(key);
    },
  };
}

/** A server that keeps the boards it is asked to make and refuses the ones the test says to. */
function world({
  refuse = () => false,
  refuseTie = false,
  refuseSeed = () => false,
  prefix = "board",
} = {}) {
  let next = 0;
  const made = new Map();
  const posts = [];
  const tied = [];
  const creates = [];
  return {
    made,
    posts,
    tied,
    creates,
    run(store, existing = []) {
      return createProjectStarterBoards({
        scope,
        existing,
        store,
        newId: () => `${prefix}-${++next}`,
        exists: async (id) => made.has(id),
        create: async (board, id) => {
          if (refuse(board.name)) throw new Error(`refused ${board.name}`);
          creates.push(id);
          made.set(id, board.name);
        },
        seed: async (board, id) => {
          if (refuseSeed(board.name)) throw new Error(`no post ${board.name}`);
          posts.push([id, board.name]);
        },
        tie: async (ids) => {
          if (refuseTie) throw new Error("record refused");
          tied.push(...ids);
        },
      });
    },
  };
}

describe("a project's supporters and founders boards", () => {
  it("are made, each with its first post, and named in the record in one save", async () => {
    const store = memoryStore();
    const w = world();
    const ids = await w.run(store);
    assert.deepEqual(ids, ["board-1", "board-2"]);
    assert.deepEqual([...w.made.values()], ["supporters", "founders"]);
    assert.deepEqual(w.posts, [
      ["board-1", "supporters"],
      ["board-2", "founders"],
    ]);
    assert.deepEqual(w.tied, ["board-1", "board-2"]);
    assert.equal(store.map.size, 0, "nothing is left to pick up");
  });

  it("only the missing one is made when the project already has the other", async () => {
    const w = world();
    const ids = await w.run(memoryStore(), [have("supporters")]);
    assert.deepEqual([...w.made.values()], ["founders"]);
    assert.deepEqual(ids, ["board-1"]);
  });

  it("make nothing, and say why, when the project's boards are not known (still loading, or the read failed)", async () => {
    const store = memoryStore();
    const w = world();
    await assert.rejects(w.run(store, null), {
      message: BOARDS_NOT_KNOWN,
    });
    assert.equal(w.made.size, 0, "no board is made from a list nobody read");
    assert.deepEqual(w.posts, []);
    assert.deepEqual(w.tied, []);
    assert.equal(store.map.size, 0, "and nothing is remembered as begun");
    assert.match(BOARDS_NOT_KNOWN, /Try again\.$/);
  });

  it("make nothing when the project has both", async () => {
    const w = world();
    assert.deepEqual(
      await w.run(memoryStore(), [have("supporters"), have("founders")]),
      [],
    );
    assert.equal(w.made.size, 0);
    assert.deepEqual(w.tied, []);
  });

  it("when the second is refused, the first is still named, the reason is thrown, and trying again makes only the second", async () => {
    const store = memoryStore();
    let refuseFounders = true;
    const w = world({
      refuse: (name) => refuseFounders && name === "founders",
    });
    await assert.rejects(w.run(store), /refused founders/);
    assert.deepEqual(w.tied, ["board-1"]);
    refuseFounders = false;
    await w.run(store, [have("supporters")]);
    assert.deepEqual([...w.made.values()], ["supporters", "founders"]);
    assert.deepEqual(w.tied, ["board-1", "board-2"]);
  });

  it("when the record is refused, the boards stay remembered and the next try names them without making others", async () => {
    const store = memoryStore();
    const refusing = world({ refuseTie: true });
    await assert.rejects(refusing.run(store), /record refused/);
    assert.equal(refusing.made.size, 2);
    assert.ok(store.map.has(starterMemoKey(scope)), "the ids are kept");
    // The same server answers the next try; the record is now accepted.
    const again = world();
    for (const [id, name] of refusing.made) again.made.set(id, name);
    const ids = await again.run(store);
    assert.deepEqual(ids, ["board-1", "board-2"]);
    assert.equal(again.made.size, 2, "no third or fourth board");
    assert.deepEqual(
      again.creates,
      [],
      "the boards the server already has are not made again",
    );
    assert.deepEqual(
      again.posts,
      [],
      "boards that already had their first post are not posted to again",
    );
    assert.equal(store.map.size, 0);
  });

  it("a board whose record save was refused keeps its sent first post, and is not posted to twice", async () => {
    const store = memoryStore();
    const refusing = world({ refuseTie: true });
    await assert.rejects(refusing.run(store), /record refused/);
    const memo = JSON.parse(store.getItem(starterMemoKey(scope)));
    assert.deepEqual(
      Object.values(memo).map((e) => e.seeded),
      [true, true],
    );
  });

  it("a remembered id the server never got is made under that same id", async () => {
    const store = memoryStore();
    store.setItem(
      starterMemoKey(scope),
      JSON.stringify({ supporters: { id: "remembered-1", seeded: false } }),
    );
    const w = world();
    await w.run(store);
    assert.equal(w.made.get("remembered-1"), "supporters");
    assert.equal(w.made.size, 2);
  });

  it("a first post that is refused leaves the board unnamed and remembered, says so, and the next try posts it", async () => {
    const store = memoryStore();
    const w = world({ refuseSeed: () => true });
    await assert.rejects(w.run(store), /no post supporters/);
    assert.deepEqual(w.tied, [], "a board with no first post is not named");
    assert.equal(w.made.size, 1, "and the second board is not started");
    const again = world({ prefix: "later" });
    for (const [id, name] of w.made) again.made.set(id, name);
    const ids = await again.run(store);
    assert.deepEqual(ids, ["board-1", "later-1"]);
    assert.deepEqual(again.creates.length, 1, "only the second board is made");
    assert.deepEqual(
      again.posts.map(([, name]) => name),
      ["supporters", "founders"],
    );
    assert.deepEqual(again.tied, ids);
    assert.equal(store.map.size, 0);
  });

  it("works when the browser keeps nothing", async () => {
    const w = world();
    const ids = await w.run(memoryStore(true));
    assert.equal(ids.length, 2);
  });

  it("keeps one memo per server, person and project", () => {
    assert.equal(
      starterMemoKey({ ...scope, relay: "WSS://One.Example" }),
      starterMemoKey(scope),
    );
    assert.notEqual(
      starterMemoKey({ ...scope, projectId: "other" }),
      starterMemoKey(scope),
    );
    assert.notEqual(
      starterMemoKey({ ...scope, relay: "wss://two.example" }),
      starterMemoKey(scope),
    );
  });
});
