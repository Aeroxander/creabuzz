import assert from "node:assert/strict";
import test from "node:test";

import {
  KIND_BOARD_MODERATION_LOG,
  moderationItem,
} from "./moderation-items.ts";

const ME = "a1".repeat(32);
const BEA = "b2".repeat(32);
const entry = (tags, content = "") => ({
  kind: KIND_BOARD_MODERATION_LOG,
  content,
  tags: [["h", "board"], ["actor", BEA], ...tags],
});

test("a removal of the reader's post or reply reads as a notification with its reason", () => {
  assert.deepEqual(
    moderationItem(
      entry(
        [
          ["action", "remove"],
          ["p", ME],
        ],
        "Spam",
      ),
      ME,
    ),
    {
      title: "A moderator removed your post",
      preview: "Reason: Spam. It is in the board's moderation log.",
    },
  );
  const reply = moderationItem(
    entry([
      ["action", "remove"],
      ["p", ME],
      ["thread", "c3".repeat(32)],
    ]),
    ME,
  );
  assert.equal(reply.title, "A moderator removed your reply");
  assert.match(reply.preview, /^No reason was given\./);
});

test("only entries about the reader, and only removals and mutes in force", () => {
  assert.equal(
    moderationItem(
      entry([
        ["action", "remove"],
        ["p", BEA],
      ]),
      ME,
    ),
    null,
  );
  assert.equal(
    moderationItem(
      entry([
        ["action", "lock"],
        ["p", ME],
      ]),
      ME,
    ),
    null,
  );
  assert.equal(
    moderationItem(
      entry([
        ["action", "mute"],
        ["p", ME],
        ["status", "awaiting_second_moderator"],
      ]),
      ME,
    ),
    null,
  );
  const mute = moderationItem(
    entry(
      [
        ["action", "mute"],
        ["p", ME],
        ["until", "2000000000"],
      ],
      "rude",
    ),
    ME,
  );
  assert.equal(mute.title, "You were muted on a board");
  assert.match(mute.preview, /^Until .+\. Reason: rude\.$/);
  assert.equal(
    moderationItem({ kind: 1, content: "", tags: [["p", ME]] }, ME),
    null,
  );
});

test("a Home post removed by the community's moderators says so, with the reason", () => {
  // A Home removal's log entry carries no board tag.
  const home = (tags, content = "") => ({
    kind: KIND_BOARD_MODERATION_LOG,
    content,
    tags: [["action", "remove"], ["actor", BEA], ...tags],
  });
  assert.deepEqual(moderationItem(home([["p", ME]], "Spam"), ME), {
    title: "A moderator removed your post from Home",
    preview: "Reason: Spam.",
  });
  assert.deepEqual(
    moderationItem(
      home([
        ["p", ME],
        ["thread", "c3".repeat(32)],
      ]),
      ME,
    ),
    {
      title: "A moderator removed your reply from Home",
      preview: "No reason was given.",
    },
  );
  assert.equal(moderationItem(home([["p", BEA]], "Spam"), ME), null);
});
