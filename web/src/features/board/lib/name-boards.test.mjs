import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { nameBoardsInRecord } from "./name-boards.ts";

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
        save: async (record, channels) => {
          saved = { record, channels };
        },
      },
      [id(9)],
      new Set([id(1), id(2)]),
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
          save: async () => void saves++,
        },
        [id(9)],
        new Set(),
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
          save: async () => {
            throw new Error("record refused");
          },
        },
        [id(9)],
        new Set(),
      ),
      /record refused/,
    );
  });
});
