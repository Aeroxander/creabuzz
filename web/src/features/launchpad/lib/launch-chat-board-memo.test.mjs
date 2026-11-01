import assert from "node:assert/strict";
import test from "node:test";

import {
  boardForLaunch,
  boardIsFounders,
  boardMemoKey,
  publishWithBoard,
} from "./launch-chat.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const HERE = "wss://one.example";
const THERE = "wss://two.example";
const empty = { team: null, supporters: null, backers: null, board: null };

function memoryStore() {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
  };
}

/** A server that makes numbered boards, owned by whoever made them. */
function server() {
  let next = 0;
  const owner = new Map();
  return {
    made: () => next,
    maker: (founder) => async () => {
      next += 1;
      const board = `board-${next}`;
      owner.set(board, founder);
      return { board, error: null };
    },
    isFoundersFor: (founder) => async (board) => owner.get(board) === founder,
  };
}

function publish({ store, srv, scope, saves, refuse = false, chat = empty }) {
  return publishWithBoard({
    scope,
    chat,
    store,
    isFounders: srv.isFoundersFor(scope.founder),
    make: srv.maker(scope.founder),
    save: async (saved) => {
      if (refuse) throw new Error("refused");
      saves.push(saved);
    },
  });
}

test("two founders who both start Demo in one browser get different boards", async () => {
  const store = memoryStore();
  const srv = server();
  const saves = [];
  // A's record is refused, so A's memo is still there when B starts.
  await assert.rejects(
    publish({
      store,
      srv,
      scope: { relay: HERE, founder: A, launchId: "demo" },
      saves,
      refuse: true,
    }),
  );
  await publish({
    store,
    srv,
    scope: { relay: HERE, founder: B, launchId: "demo" },
    saves,
  });
  assert.equal(saves[0].board, "board-2");
  assert.equal(srv.made(), 2);
});

test("one founder starting the same project in two communities gets a board in each", async () => {
  const store = memoryStore();
  const srv = server();
  const saves = [];
  await assert.rejects(
    publish({
      store,
      srv,
      scope: { relay: HERE, founder: A, launchId: "demo" },
      saves,
      refuse: true,
    }),
  );
  await publish({
    store,
    srv,
    scope: { relay: THERE, founder: A, launchId: "demo" },
    saves,
  });
  assert.equal(saves[0].board, "board-2");
  assert.notEqual(
    boardMemoKey({ relay: HERE, founder: A, launchId: "demo" }),
    boardMemoKey({ relay: THERE, founder: A, launchId: "demo" }),
  );
});

test("the memo key reads one server address however it is spelled", () => {
  assert.equal(
    boardMemoKey({ relay: "WSS://One.Example/", founder: A, launchId: "x" }),
    boardMemoKey({ relay: "wss://one.example", founder: A, launchId: "x" }),
  );
});

test("a refused record keeps the board, and the retry reuses it with no second board", async () => {
  const store = memoryStore();
  const srv = server();
  const saves = [];
  const scope = { relay: HERE, founder: A, launchId: "demo" };
  await assert.rejects(publish({ store, srv, scope, saves, refuse: true }));
  assert.equal(store.map.size, 1, "the board is remembered after the refusal");
  // A reload: same storage, a new operation.
  await publish({ store, srv, scope, saves });
  assert.equal(srv.made(), 1);
  assert.equal(saves[0].board, "board-1");
});

test("a saved record clears the memo", async () => {
  const store = memoryStore();
  const srv = server();
  const saves = [];
  await publish({
    store,
    srv,
    scope: { relay: HERE, founder: A, launchId: "demo" },
    saves,
  });
  assert.equal(saves[0].board, "board-1");
  assert.equal(store.map.size, 0);
});

test("a save clears only the entry holding the board it used", async () => {
  const store = memoryStore();
  const srv = server();
  const scope = { relay: HERE, founder: A, launchId: "demo" };
  await publishWithBoard({
    scope,
    chat: empty,
    store,
    isFounders: srv.isFoundersFor(A),
    make: srv.maker(A),
    // Another tab remembers a different board while this save is on its way.
    save: async () => {
      store.setItem(boardMemoKey(scope), "board-other");
    },
  });
  assert.equal(store.getItem(boardMemoKey(scope)), "board-other");
});

test("a remembered board that is not the founder's is never adopted", async () => {
  const store = memoryStore();
  const scope = { relay: HERE, founder: A, launchId: "demo" };
  store.setItem(boardMemoKey(scope), "someone-elses");
  let made = 0;
  const result = await boardForLaunch({
    scope,
    store,
    isFounders: async () => false,
    make: async () => {
      made += 1;
      return { board: "fresh", error: null };
    },
  });
  assert.equal(result.board, "fresh");
  assert.equal(made, 1);
  assert.equal(store.getItem(boardMemoKey(scope)), "fresh");
});

test("the avoided board is never adopted, even when it checks out", async () => {
  const store = memoryStore();
  const scope = { relay: HERE, founder: A, launchId: "demo" };
  store.setItem(boardMemoKey(scope), "gone");
  const result = await boardForLaunch({
    scope,
    avoid: "gone",
    store,
    isFounders: async () => true,
    make: async () => ({ board: "fresh", error: null }),
  });
  assert.equal(result.board, "fresh");
});

test("a check that cannot reach the server keeps the memo and makes no board", async () => {
  const store = memoryStore();
  const scope = { relay: HERE, founder: A, launchId: "demo" };
  store.setItem(boardMemoKey(scope), "board-1");
  let made = 0;
  await assert.rejects(
    boardForLaunch({
      scope,
      store,
      isFounders: async () => {
        throw new Error("no answer");
      },
      make: async () => {
        made += 1;
        return { board: "fresh", error: null };
      },
    }),
    /no answer/,
  );
  assert.equal(made, 0);
  assert.equal(store.getItem(boardMemoKey(scope)), "board-1");
});

test("an older memo keyed by the project id alone is not adopted", async () => {
  const store = memoryStore();
  store.setItem("creaton:launch-board:demo", "legacy");
  const result = await boardForLaunch({
    scope: { relay: HERE, founder: A, launchId: "demo" },
    store,
    isFounders: async () => true,
    make: async () => ({ board: "fresh", error: null }),
  });
  assert.equal(result.board, "fresh");
  assert.equal(store.getItem("creaton:launch-board:demo"), "legacy");
});

const meta = (board, tags, at = 1) => ({
  kind: 39000,
  created_at: at,
  tags: [["d", board], ...tags],
});
const admins = (board, people, at = 1) => ({
  kind: 39001,
  created_at: at,
  tags: [["d", board], ...people.map(([p, role]) => ["p", p, role])],
});

test("boardIsFounders: a board the founder owns or runs", () => {
  for (const role of ["owner", "admin"]) {
    assert.equal(
      boardIsFounders({
        board: "x",
        founder: A,
        records: [meta("x", [["t", "forum"]]), admins("x", [[A, role]])],
      }),
      true,
    );
  }
});

test("boardIsFounders: not a board, someone else's, or no records", () => {
  const cases = [
    [meta("x", []), admins("x", [[A, "owner"]])],
    [meta("x", [["t", "forum"]]), admins("x", [[B, "owner"]])],
    [meta("x", [["t", "forum"]])],
    [admins("x", [[A, "owner"]])],
    [meta("y", [["t", "forum"]]), admins("y", [[A, "owner"]])],
    [],
  ];
  for (const records of cases) {
    assert.equal(boardIsFounders({ board: "x", founder: A, records }), false);
  }
});

test("boardIsFounders reads the newest admins record", () => {
  const records = [
    meta("x", [["t", "forum"]]),
    admins("x", [[A, "owner"]], 1),
    admins("x", [[B, "owner"]], 2),
  ];
  assert.equal(boardIsFounders({ board: "x", founder: A, records }), false);
});
