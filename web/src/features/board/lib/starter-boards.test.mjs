import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { splitPost } from "./post-text.ts";
import {
  missingStarterBoards,
  STARTER_BOARDS,
  starterDrafts,
} from "./starter-boards.ts";

describe("starter boards", () => {
  it("are an open supporters board and a private founders board", () => {
    assert.deepEqual(
      STARTER_BOARDS.map((b) => [b.name, b.visibility]),
      [
        ["supporters", "open"],
        ["founders", "private"],
      ],
    );
  });

  it("each opens with a titled first post", () => {
    for (const board of STARTER_BOARDS) {
      const { seed } = starterDrafts(board, "id-1");
      const { title, body } = splitPost(seed.content);
      assert.equal(title, board.title);
      assert.ok(body.length > 40, board.name);
    }
  });

  it("create a forum channel with the board's visibility, then post to it by the same id", () => {
    const { create, seed } = starterDrafts(STARTER_BOARDS[1], "board-1");
    assert.equal(create.kind, 9007);
    assert.deepEqual(create.tags.slice(0, 4), [
      ["h", "board-1"],
      ["name", "founders"],
      ["visibility", "private"],
      ["channel_type", "forum"],
    ]);
    assert.equal(seed.kind, 45001);
    assert.deepEqual(seed.tags, [["h", "board-1"]]);
  });

  it("are made only where missing, by name and purpose", () => {
    const [supporters, founders] = STARTER_BOARDS;
    const have = (board) => ({ name: board.name, description: board.purpose });
    assert.deepEqual(
      missingStarterBoards([]).map((b) => b.name),
      ["supporters", "founders"],
    );
    assert.deepEqual(
      missingStarterBoards([
        { name: "Supporters", description: ` ${supporters.purpose} ` },
      ]).map((b) => b.name),
      ["founders"],
    );
    assert.deepEqual(
      missingStarterBoards([have(supporters), have(founders)]),
      [],
    );
  });

  it("are still offered when the project only names other boards that share their names", () => {
    assert.deepEqual(
      missingStarterBoards([
        { name: "supporters", description: "" },
        { name: "founders", description: "Our own plans." },
      ]).map((b) => b.name),
      ["supporters", "founders"],
    );
  });
});
