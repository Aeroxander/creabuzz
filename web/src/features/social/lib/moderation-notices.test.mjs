import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { moderationItem } from "../../notifications/lib/moderation-items.ts";
import {
  buildModerationNotifications,
  KIND_BOARD_MODERATION_LOG,
} from "./moderation-notices.ts";
import { groupNotifications, withoutMuted } from "./notifications.ts";
import { badgeState, notificationsView } from "./notifications-state.ts";

const ME = "a".repeat(64);
const SERVER = "f".repeat(64);
const BOB = "c".repeat(64);
const BOARD = "11111111-2222-3333-4444-555555555555";
let n = 0;
const entry = (tags, content = "Spam", at = 500) => ({
  id: String(++n).padStart(64, "0"),
  pubkey: SERVER,
  kind: KIND_BOARD_MODERATION_LOG,
  created_at: at + n,
  tags: [["h", BOARD], ...tags],
  content,
});

describe("buildModerationNotifications", () => {
  const removedPost = entry([
    ["action", "remove"],
    ["e", "9".repeat(64)],
    ["p", ME],
  ]);
  const removedReply = entry([
    ["action", "remove"],
    ["e", "8".repeat(64)],
    ["thread", "7".repeat(64)],
    ["p", ME],
  ]);

  it("tells you a moderator removed your post, with the reason, opening the board", () => {
    const [item] = buildModerationNotifications([removedPost], ME);
    assert.equal(item.kind, "moderation");
    assert.equal(item.at, removedPost.created_at);
    assert.equal(item.notice.title, moderationItem(removedPost, ME).title);
    assert.match(item.notice.preview, /Reason: Spam\./);
    assert.equal(item.notice.boardId, BOARD);
    assert.equal(item.notice.threadId, null);
  });

  it("opens a removed reply's conversation", () => {
    const [item] = buildModerationNotifications([removedReply], ME);
    assert.equal(item.notice.threadId, "7".repeat(64));
  });

  it("gives a Home removal (no board) the conversation to open, and nothing for a removed Home post", () => {
    const homeReply = {
      ...entry([
        ["action", "remove"],
        ["e", "6".repeat(64)],
        ["thread", "5".repeat(64)],
        ["p", ME],
      ]),
    };
    homeReply.tags = homeReply.tags.filter((t) => t[0] !== "h");
    const [reply] = buildModerationNotifications([homeReply], ME);
    assert.equal(reply.notice.boardId, null);
    assert.equal(reply.notice.threadId, "5".repeat(64));
  });

  it("leaves out entries about someone else, ones not yet in force, and repeats", () => {
    const aboutBob = entry([
      ["action", "remove"],
      ["p", BOB],
    ]);
    const waiting = entry([
      ["action", "mute"],
      ["status", "awaiting_second_moderator"],
      ["p", ME],
    ]);
    const items = buildModerationNotifications(
      [aboutBob, waiting, removedPost, removedPost],
      ME,
    );
    assert.deepEqual(
      items.map((i) => i.id),
      [removedPost.id],
    );
  });

  it("is never hidden by a mute, while a muted person's up vote is", () => {
    const [notice] = buildModerationNotifications([removedPost], ME);
    const like = {
      id: "x",
      kind: "like",
      actor: BOB,
      at: 1,
      targetId: "t",
      noteId: null,
    };
    // Muting the key the notice is signed with does not hide it either.
    assert.deepEqual(
      withoutMuted([notice, like], new Set([BOB, SERVER])).map((i) => i.id),
      [notice.id],
    );
  });

  it("keeps each notice its own row, with its words", () => {
    const groups = groupNotifications(
      buildModerationNotifications([removedPost, removedReply], ME),
    );
    assert.equal(groups.length, 2);
    assert.ok(groups.every((g) => g.kind === "moderation" && g.notice));
  });
});

describe("notificationsView", () => {
  it("says a failed read failed instead of showing nothing yet", () => {
    assert.equal(
      notificationsView({
        data: undefined,
        error: new Error("x"),
        isLoading: false,
      }),
      "error",
    );
  });
  it("keeps the last good list when a refresh fails", () => {
    assert.equal(
      notificationsView({
        data: [{}],
        error: new Error("x"),
        isLoading: false,
      }),
      "list",
    );
  });
  it("is empty only when a read succeeded with nothing", () => {
    assert.equal(
      notificationsView({ data: [], error: null, isLoading: false }),
      "empty",
    );
    assert.equal(
      notificationsView({ data: undefined, error: null, isLoading: true }),
      "loading",
    );
  });
});

describe("badgeState", () => {
  it("counts a moderator's notice that came after you last looked", () => {
    const items = buildModerationNotifications(
      [
        entry([
          ["action", "remove"],
          ["p", ME],
        ]),
      ],
      ME,
    );
    assert.deepEqual(badgeState(items, null, [], items[0].at - 1), {
      unread: 1,
      failed: false,
    });
  });
  it("says it failed, instead of nothing new, when nothing could be read", () => {
    assert.deepEqual(badgeState(undefined, new Error("x"), [], 0), {
      unread: 0,
      failed: true,
    });
    // A failed refresh over a good list still counts that list.
    assert.equal(badgeState([{ at: 5 }], new Error("x"), [], 0).failed, false);
  });
});
