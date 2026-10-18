import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  commentDraft,
  deletionDraft,
  moderationDeletionDraft,
  postDraft,
  voteDraft,
} from "./board-events.ts";

const BOARD = "0f0f0f0f-1111-2222-3333-444444444444";
const ROOT = "a".repeat(64);
const OTHER = "b".repeat(64);
const DAO = `0x${"ab".repeat(20)}`;
const ID = `0x${"0f".repeat(32)}`;

describe("postDraft", () => {
  it("is a kind 45001 for the board with the title as a heading", () => {
    assert.deepEqual(
      postDraft({ boardId: BOARD, title: "Hello", body: "World" }),
      {
        kind: 45001,
        tags: [["h", BOARD]],
        content: "# Hello\n\nWorld",
      },
    );
  });

  it("names the decision a proposal post is about", () => {
    const draft = postDraft({
      boardId: BOARD,
      title: "Fund it",
      body: "",
      proposal: { chainId: 31337, dao: DAO, id: ID },
    });
    assert.deepEqual(draft.tags, [
      ["h", BOARD],
      ["t", "proposal"],
      ["t", `proposal:31337:${DAO}:${ID}`],
    ]);
  });

  it("refuses a decision it cannot name exactly", () => {
    assert.throws(
      () =>
        postDraft({
          boardId: BOARD,
          title: "x",
          body: "",
          proposal: { chainId: 1, dao: "0x1", id: ID },
        }),
      /can't be linked/,
    );
  });
});

describe("commentDraft", () => {
  it("answers the post with a single reply marker", () => {
    assert.deepEqual(
      commentDraft({ boardId: BOARD, root: ROOT, parent: ROOT, body: " hi " }),
      {
        kind: 45003,
        tags: [
          ["h", BOARD],
          ["e", ROOT, "", "reply"],
        ],
        content: "hi",
      },
    );
  });

  it("answers a comment with a root and a reply marker", () => {
    const draft = commentDraft({
      boardId: BOARD,
      root: ROOT,
      parent: OTHER,
      body: "re",
    });
    assert.deepEqual(draft.tags, [
      ["h", BOARD],
      ["e", ROOT, "", "root"],
      ["e", OTHER, "", "reply"],
    ]);
  });

  it("refuses an empty comment", () => {
    assert.throws(
      () =>
        commentDraft({ boardId: BOARD, root: ROOT, parent: ROOT, body: "  " }),
      /Write something/,
    );
  });
});

describe("voteDraft / deletionDraft", () => {
  it("votes with + or - on the target in the same board", () => {
    assert.deepEqual(
      voteDraft({ boardId: BOARD, target: ROOT, direction: "up" }),
      {
        kind: 45002,
        tags: [
          ["h", BOARD],
          ["e", ROOT],
        ],
        content: "+",
      },
    );
    assert.equal(
      voteDraft({ boardId: BOARD, target: ROOT, direction: "down" }).content,
      "-",
    );
  });

  it("deletes with the shape the chat uses", () => {
    assert.deepEqual(deletionDraft({ boardId: BOARD, target: ROOT }), {
      kind: 5,
      tags: [
        ["h", BOARD],
        ["e", ROOT],
      ],
      content: "",
    });
  });
});

describe("moderationDeletionDraft", () => {
  it("is a NIP-29 delete-event scoped to the board, naming the record", () => {
    assert.deepEqual(
      moderationDeletionDraft({ boardId: BOARD, target: ROOT }),
      {
        kind: 9005,
        tags: [
          ["h", BOARD],
          ["e", ROOT],
        ],
        content: "",
      },
    );
  });
});
