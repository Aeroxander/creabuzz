import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  activeModerators,
  activeMutes,
  appointDraft,
  boardRefusalText,
  isModerationRefusal,
  KIND_BOARD_MODERATION_LOG,
  KIND_BOARD_STATE,
  logSentence,
  mayActAgainst,
  muteChoices,
  muteDraft,
  parseBoardState,
  parseLog,
  pinnedFirst,
  removedReplies,
  rulesDraft,
  STANDING,
  standingOf,
  threadDraft,
} from "./board-moderation.ts";

const BOARD = "7b0e5a1c-4b1e-4f7e-9a51-2a7c0c1d9e01";
const RELAY = "aa".repeat(32);
const ALEX = "a1".repeat(32);
const BEA = "b2".repeat(32);
const POST = "c3".repeat(32);
const POST2 = "d4".repeat(32);

const record = (kind, tags, content = "", extra = {}) => ({
  id: extra.id ?? `${kind}-${Math.random()}`,
  pubkey: extra.pubkey ?? RELAY,
  kind,
  created_at: extra.at ?? 100,
  tags,
  content,
});

test("the kind numbers are the server's", () => {
  const generated = readFileSync(
    new URL(
      "../../../../../packages/creaton-core/src/kinds.generated.ts",
      import.meta.url,
    ),
    "utf8",
  );
  for (const [name, value] of [
    ["KIND_BOARD_LOCK_THREAD", 9045],
    ["KIND_BOARD_MUTE", 9049],
    ["KIND_BOARD_SET_RULES", 9051],
    ["KIND_BOARD_REMOVE_MODERATOR", 9053],
    ["KIND_BOARD_STATE", KIND_BOARD_STATE],
    ["KIND_BOARD_MODERATION_LOG", KIND_BOARD_MODERATION_LOG],
  ]) {
    assert.match(generated, new RegExp(`export const ${name} = ${value};`));
  }
});

test("commands carry the board, their target and a trimmed reason", () => {
  const lock = threadDraft({
    boardId: BOARD,
    post: POST,
    action: "lock",
    reason: `  off topic${"!".repeat(400)}`,
  });
  assert.equal(lock.kind, 9045);
  assert.deepEqual(lock.tags.slice(0, 2), [
    ["h", BOARD],
    ["e", POST],
  ]);
  assert.equal(lock.tags[2][0], "reason");
  assert.equal(lock.tags[2][1].length, 280);
  assert.equal(
    threadDraft({ boardId: BOARD, post: POST, action: "unpin" }).tags.length,
    2,
  );

  const mute = muteDraft({ boardId: BOARD, person: BEA, until: 1234.9 });
  assert.equal(mute.kind, 9049);
  assert.deepEqual(mute.tags, [
    ["h", BOARD],
    ["p", BEA],
    ["expiration", "1234"],
  ]);
  assert.deepEqual(appointDraft({ boardId: BOARD, person: BEA }).tags, [
    ["h", BOARD],
    ["p", BEA],
  ]);
  assert.equal(
    rulesDraft({ boardId: BOARD, rules: "  Be kind.  " }).content,
    "Be kind.",
  );
  assert.throws(() => rulesDraft({ boardId: BOARD, rules: "x".repeat(4001) }));
});

test("the board state comes from the newest record the server signed for this board", () => {
  const events = [
    record(
      KIND_BOARD_STATE,
      [
        ["d", BOARD],
        ["pinned", POST, "1"],
      ],
      "old",
      { at: 1 },
    ),
    record(
      KIND_BOARD_STATE,
      [
        ["d", BOARD],
        ["pinned", POST2, "9"],
        ["pinned", POST, "8"],
        ["locked", POST, "7"],
        ["moderator", ALEX, "500"],
        ["moderator", "not-hex", "500"],
      ],
      "Be kind.",
      { at: 5 },
    ),
    // Someone else's record, and another board's, never count.
    record(
      KIND_BOARD_STATE,
      [
        ["d", BOARD],
        ["locked", POST2, "1"],
      ],
      "fake",
      { at: 9, pubkey: BEA },
    ),
    record(KIND_BOARD_STATE, [["d", "other"]], "elsewhere", { at: 10 }),
  ];
  const state = parseBoardState(events, BOARD, RELAY);
  assert.equal(state.rules, "Be kind.");
  assert.deepEqual(state.pinned, [POST2, POST]);
  assert.deepEqual([...state.locked], [POST]);
  assert.deepEqual([...state.moderators], [[ALEX, 500]]);
  assert.deepEqual([...activeModerators(state, 499)], [ALEX]);
  assert.deepEqual(
    [...activeModerators(state, 500)],
    [],
    "a term that ended grants nothing",
  );
  assert.equal(parseBoardState([], BOARD).rules, "");
});

test("the log reads newest first, in plain words, and knows which mutes still hold", () => {
  const events = [
    record(
      KIND_BOARD_MODERATION_LOG,
      [
        ["h", BOARD],
        ["action", "mute"],
        ["actor", ALEX],
        ["role", "moderator"],
        ["p", BEA],
        ["until", "2000000000"],
        ["status", "awaiting_second_moderator"],
      ],
      "spam",
      { at: 10, id: "m1" },
    ),
    record(
      KIND_BOARD_MODERATION_LOG,
      [
        ["h", BOARD],
        ["action", "lock"],
        ["actor", ALEX],
        ["role", "board_owner"],
        ["e", POST],
      ],
      "",
      { at: 20, id: "l1" },
    ),
    record(
      KIND_BOARD_MODERATION_LOG,
      [
        ["h", BOARD],
        ["action", "remove"],
        ["actor", ALEX],
        ["role", "community_admin"],
        ["e", POST2],
        ["thread", POST],
      ],
      "",
      { at: 30, id: "r1" },
    ),
    record(
      KIND_BOARD_MODERATION_LOG,
      [
        ["h", BOARD],
        ["action", "explode"],
        ["actor", ALEX],
      ],
      "",
      { at: 40 },
    ),
    record(
      KIND_BOARD_MODERATION_LOG,
      [
        ["h", BOARD],
        ["action", "lock"],
        ["actor", ALEX],
      ],
      "",
      { at: 50, pubkey: BEA },
    ),
  ];
  const log = parseLog(events, BOARD, RELAY);
  assert.deepEqual(
    log.map((e) => e.id),
    ["r1", "l1", "m1"],
  );
  const names = (pubkey) => (pubkey === ALEX ? "Alex" : "Bea");
  assert.equal(
    logSentence(log[0], names),
    "Alex (community admin) removed a reply.",
  );
  assert.equal(
    logSentence(log[1], names),
    "Alex (board owner) locked a thread.",
  );
  assert.match(
    logSentence(log[2], names),
    /^Alex \(moderator\) muted Bea on this board until .+\. A longer mute waits for a second moderator\. Reason: spam\.$/,
  );
  assert.deepEqual([...activeMutes(log, 1000).keys()], [BEA]);
  assert.deepEqual(
    [...activeMutes(log, 2000000000).keys()],
    [],
    "an ended mute is not in force",
  );
  const lifted = parseLog(
    [
      ...events,
      record(
        KIND_BOARD_MODERATION_LOG,
        [
          ["h", BOARD],
          ["action", "unmute"],
          ["actor", ALEX],
          ["p", BEA],
        ],
        "",
        { at: 60, id: "u1" },
      ),
    ],
    BOARD,
    RELAY,
  );
  assert.deepEqual([...activeMutes(lifted, 1000).keys()], []);
  assert.deepEqual(
    removedReplies(log, POST).map((e) => e.id),
    ["r1"],
  );
});

test("standing and the guard rails mirror the server", () => {
  const roles = {
    communityRoles: new Map([[ALEX, "owner"]]),
    boardRoles: new Map([[BEA, "admin"]]),
    moderators: new Set([POST]),
  };
  assert.equal(standingOf(ALEX, roles), STANDING.communityOwner);
  assert.equal(standingOf(BEA, roles), STANDING.boardAdmin);
  assert.equal(standingOf(POST, roles), STANDING.moderator);
  assert.equal(standingOf(POST2, roles), STANDING.none);
  assert.equal(standingOf(null, roles), STANDING.none);
  assert.equal(mayActAgainst(STANDING.moderator, STANDING.none), true);
  assert.equal(mayActAgainst(STANDING.moderator, STANDING.moderator), false);
  assert.equal(mayActAgainst(STANDING.boardAdmin, STANDING.boardAdmin), false);
  assert.equal(
    mayActAgainst(STANDING.communityOwner, STANDING.communityOwner),
    true,
  );
  assert.deepEqual(
    muteChoices(STANDING.moderator)
      .filter((c) => c.needsSecond)
      .map((c) => c.days),
    [14, 30],
  );
  assert.equal(
    muteChoices(STANDING.boardOwner).some((c) => c.needsSecond),
    false,
  );
});

test("pinned posts come first, in pin order, and the rest keep theirs", () => {
  const posts = [{ id: "a" }, { id: POST }, { id: "b" }, { id: POST2 }];
  assert.deepEqual(
    pinnedFirst(posts, [POST2, POST]).map((p) => p.id),
    [POST2, POST, "a", "b"],
  );
});

test("board refusals read as sentences with dates", () => {
  assert.match(
    boardRefusalText(
      "restricted: you are muted on this board until 1893456000",
    ),
    /^You are muted on this board until .*2030\.$/,
  );
  assert.equal(
    boardRefusalText("restricted: this thread is locked"),
    "This thread is locked.",
  );
  assert.equal(
    boardRefusalText("rate-limited: a moderator may take 20 actions an hour"),
    "A moderator may take 20 actions an hour.",
  );
  assert.equal(
    boardRefusalText("error: database error: down"),
    "error: database error: down",
  );
  assert.equal(isModerationRefusal("restricted: this thread is locked"), true);
  assert.equal(
    isModerationRefusal("restricted: you are muted on this board until 5"),
    true,
  );
  assert.equal(
    isModerationRefusal("restricted: only members can post here"),
    false,
  );
});
