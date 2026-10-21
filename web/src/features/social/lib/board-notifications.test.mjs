import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildBoardNotifications,
  groupNotifications,
} from "./notifications.ts";

const ME = "a".repeat(64);
const ANN = "b".repeat(64);
const BOB = "c".repeat(64);
let n = 0;
const ev = (pubkey, kind, tags, content = "", at = 100) => ({
  id: String(++n).padStart(64, "0"),
  pubkey,
  kind,
  created_at: at + n,
  tags,
  content,
});

describe("buildBoardNotifications", () => {
  const post = ev(ME, 45001, [["h", "film"]], "# My trailer\n\nWatch it");
  const myReply = ev(
    ME,
    45003,
    [
      ["h", "film"],
      ["e", "other-post", "", "root"],
      ["e", "their-reply", "", "reply"],
    ],
    "I agree",
  );

  it("tells you about replies to your board post and to your replies, with where to open them", () => {
    const onPost = ev(
      ANN,
      45003,
      [
        ["h", "film"],
        ["e", post.id, "", "reply"],
      ],
      "Great cut",
    );
    const onReply = ev(
      BOB,
      45003,
      [
        ["h", "film"],
        ["e", "other-post", "", "root"],
        ["e", myReply.id, "", "reply"],
      ],
      "Me too",
    );
    const elsewhere = ev(
      BOB,
      45003,
      [
        ["h", "film"],
        ["e", post.id, "", "root"],
        ["e", "someone-else", "", "reply"],
      ],
      "Not to you",
    );
    const items = buildBoardNotifications(
      [post, myReply],
      [onPost, onReply, elsewhere],
      ME,
    );
    assert.deepEqual(
      items.map((i) => [i.kind, i.actor, i.board]),
      [
        [
          "board-reply",
          BOB,
          { boardId: "film", postId: "other-post", text: "Me too" },
        ],
        [
          "board-reply",
          ANN,
          { boardId: "film", postId: post.id, text: "Great cut" },
        ],
      ],
    );
  });

  it("groups up votes on one post, ignores down votes and your own", () => {
    const up = (who) =>
      ev(
        who,
        45002,
        [
          ["h", "film"],
          ["e", post.id],
        ],
        "+",
      );
    const items = buildBoardNotifications(
      [post],
      [
        up(ANN),
        up(BOB),
        ev(
          BOB,
          45002,
          [
            ["h", "film"],
            ["e", post.id],
          ],
          "-",
        ),
        up(ME),
      ],
      ME,
    );
    assert.equal(items.length, 2);
    const groups = groupNotifications(items);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].kind, "board-upvote");
    assert.deepEqual(groups[0].actors.sort(), [ANN, BOB].sort());
    assert.deepEqual(groups[0].board, {
      boardId: "film",
      postId: post.id,
      text: "My trailer",
    });
  });

  it("ignores records that are not yours", () => {
    const theirs = ev(ANN, 45001, [["h", "film"]], "# Theirs");
    const reply = ev(
      BOB,
      45003,
      [
        ["h", "film"],
        ["e", theirs.id, "", "reply"],
      ],
      "hi",
    );
    assert.deepEqual(buildBoardNotifications([theirs], [reply], ME), []);
  });
});
