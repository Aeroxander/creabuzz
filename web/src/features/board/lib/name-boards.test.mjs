import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { nameBoardsInRecord } from "./name-boards.ts";
import { readNamedBoards } from "./named-boards.ts";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const noChat = { team: null, supporters: null, backers: null, board: null };

describe("naming boards in a project's record", () => {
  it("adds them to the record as the server has it now, not to the copy the page loaded", async () => {
    const loaded = { channels: [id(1)], chat: noChat };
    // Edited elsewhere since: another board was linked and a room was chosen.
    const latest = {
      channels: [id(1), id(2)],
      chat: { ...noChat, supporters: id(7) },
    };
    let saved = null;
    const dropped = await nameBoardsInRecord(
      {
        readLatest: async () => latest,
        boardsAmong: async () => new Set([id(1), id(2)]),
        save: async (record, channels) => {
          saved = { record, channels };
        },
      },
      [id(9)],
    );
    assert.equal(dropped, 0);
    assert.equal(saved.record, latest, "the newest record is the one saved");
    assert.notEqual(saved.record, loaded);
    assert.deepEqual(saved.channels, [id(1), id(2), id(9)]);
  });

  it("saves nothing when the newest record cannot be read", async () => {
    let saves = 0;
    await assert.rejects(
      nameBoardsInRecord(
        {
          readLatest: async () => {
            throw new Error("server did not answer");
          },
          boardsAmong: async () => new Set(),
          save: async () => void saves++,
        },
        [id(9)],
      ),
      /did not answer/,
    );
    assert.equal(saves, 0);
  });

  it("lets a refused save through, so the caller keeps its retry record", async () => {
    await assert.rejects(
      nameBoardsInRecord(
        {
          readLatest: async () => ({ channels: [], chat: noChat }),
          boardsAmong: async () => new Set(),
          save: async () => {
            throw new Error("record refused");
          },
        },
        [id(9)],
      ),
      /record refused/,
    );
  });

  it("keeps a full record's older board over its chat rooms, finding which are boards by their ids", async () => {
    // The record is full (8 links): a board made long ago and seven chat rooms. 250 newer channels fill the first
    // page of the server's channel list, so the board is not on it.
    const rooms = [2, 3, 4, 5, 6, 7, 8].map(id);
    const latest = {
      channels: [...rooms.slice(0, 3), id(1), ...rooms.slice(3)],
      chat: noChat,
    };
    const records = [
      meta(id(1), "old-talk", "forum", 100),
      ...rooms.map((room) => meta(room, "room", "stream", 100)),
      ...Array.from({ length: 250 }, (_, i) =>
        meta(id(1000 + i), "newer", "stream", 900),
      ),
    ];
    const asked = [];
    const read = async (filter) => {
      asked.push(filter);
      return records
        .filter((r) => filter["#d"].includes(r.tags[0][1]))
        .slice(0, filter.limit);
    };
    let saved = null;
    const dropped = await nameBoardsInRecord(
      {
        readLatest: async () => latest,
        boardsAmong: async (ids) =>
          new Set((await readNamedBoards(read, ids)).map((board) => board.id)),
        save: async (_record, channels) => {
          saved = channels;
        },
      },
      [id(9)],
    );
    assert.equal(dropped, 1);
    assert.ok(saved.includes(id(1)), "the older board is still linked");
    assert.ok(saved.includes(id(9)), "the new board is linked");
    assert.equal(saved.length, 8);
    assert.ok(
      !saved.includes(rooms[6]),
      "a chat room made way, the last one linked",
    );
    // Asked about the channels the newest record names.
    assert.deepEqual(
      asked.flatMap((filter) => filter["#d"]).sort(),
      [...latest.channels].sort(),
    );
  });

  it("saves nothing when which of the record's channels are boards cannot be read", async () => {
    let saves = 0;
    await assert.rejects(
      nameBoardsInRecord(
        {
          readLatest: async () => ({ channels: [id(1)], chat: noChat }),
          boardsAmong: async () => {
            throw new Error("server did not answer");
          },
          save: async () => void saves++,
        },
        [id(9)],
      ),
      /did not answer/,
    );
    assert.equal(saves, 0);
  });
});

function meta(boardId, name, type, at) {
  return {
    id: `meta-${boardId}`,
    pubkey: "b".repeat(64),
    kind: 39000,
    created_at: at,
    tags: [["d", boardId], ["name", name], ["public"], ["t", type]],
  };
}
