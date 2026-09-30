// Event-shape tests for the DM command/notice module — bound to the
// production builders, one test per invariant the relay relies on.
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDmAddMemberTags,
  buildDmHideTags,
  buildDmOpenTags,
  dmConversationLabel,
  hiddenDmIds,
  isDmChannelMetadata,
  KIND_DM_CREATED,
  KIND_DM_VISIBILITY,
  parseDmCreated,
  parseDmOpenAck,
} from "./dm.ts";

const PK_A = "aa".repeat(32);
const PK_B = "bb".repeat(32);
const PK_C = "cc".repeat(32);
const UUID = "12345678-1234-4abc-8def-1234567890ab";

test("open tags carry exactly one p tag per unique participant", () => {
  const tags = buildDmOpenTags([PK_A, PK_B]);
  assert.deepEqual(tags, [
    ["p", PK_A],
    ["p", PK_B],
  ]);
});

test("open tags normalize case, collapse duplicates, and cap at 8 participants", () => {
  const tags = buildDmOpenTags([PK_A.toUpperCase(), ` ${PK_A} `]);
  assert.deepEqual(tags, [["p", PK_A]]);
  const many = Array.from({ length: 9 }, (_, i) => i.toString().repeat(64 / 1));
  assert.throws(
    () =>
      buildDmOpenTags(
        many.slice(0, 9).map((s, i) => (i + 10).toString(16).padStart(64, "0")),
      ),
    /up to 8/,
  );
});

test("open tags refuse an empty participant set and malformed keys", () => {
  assert.throws(() => buildDmOpenTags([]), /at least one participant/);
  assert.throws(
    () => buildDmOpenTags(["not-a-key"]),
    /64-character public key/,
  );
  assert.throws(
    () => buildDmOpenTags([PK_A.slice(0, 63)]),
    /64-character public key/,
  );
});

test("add-member and hide tags reference the conversation by h tag", () => {
  assert.deepEqual(buildDmAddMemberTags(UUID, PK_A), [
    ["h", UUID],
    ["p", PK_A],
  ]);
  assert.deepEqual(buildDmHideTags(UUID), [["h", UUID]]);
  assert.throws(() => buildDmHideTags("nope"), /UUID/);
  assert.throws(
    () => buildDmAddMemberTags(UUID, "xyz"),
    /64-character public key/,
  );
});

test("open ack parses the response: payload and reports creation", () => {
  const ack = parseDmOpenAck(
    `response:{"channel_id":"${UUID}","created":true}`,
  );
  assert.deepEqual(ack, { channelId: UUID, created: true });
  assert.deepEqual(parseDmOpenAck(`response:{"channel_id":"${UUID}"}`), {
    channelId: UUID,
    created: false,
  });
});

test("an unconfirmed open is an error, not an empty success", () => {
  assert.throws(() => parseDmOpenAck("response:not-json"), /did not confirm/);
  assert.throws(
    () => parseDmOpenAck('response:{"created":true}'),
    /did not confirm/,
  );
  assert.throws(() => parseDmOpenAck(undefined), /did not confirm/);
  assert.throws(() => parseDmOpenAck(""), /did not confirm/);
});

test("kind 41001 notices parse into id + participants", () => {
  const notice = parseDmCreated({
    kind: KIND_DM_CREATED,
    created_at: 100,
    tags: [
      ["d", UUID],
      ["p", PK_A],
      ["p", PK_B.toUpperCase()],
    ],
  });
  assert.deepEqual(notice, {
    dmId: UUID,
    participants: [PK_A, PK_B],
    createdAt: 100,
  });
});

test("malformed notices are rejected, and non-notice kinds never parse", () => {
  assert.equal(
    parseDmCreated({
      kind: KIND_DM_CREATED,
      created_at: 1,
      tags: [["p", PK_A]],
    }),
    null,
  );
  assert.equal(
    parseDmCreated({
      kind: KIND_DM_CREATED,
      created_at: 1,
      tags: [["d", UUID]],
    }),
    null,
  );
  assert.equal(
    parseDmCreated({
      kind: 9,
      created_at: 1,
      tags: [
        ["d", UUID],
        ["p", PK_A],
      ],
    }),
    null,
  );
});

test("visibility snapshots list exactly the hidden conversations", () => {
  assert.deepEqual(
    hiddenDmIds({
      kind: KIND_DM_VISIBILITY,
      created_at: 5,
      tags: [
        ["d", PK_A],
        ["p", PK_A],
        ["h", UUID],
        ["h", "87654321-4321-4cba-8fed-210987654321"],
      ],
    }),
    [UUID, "87654321-4321-4cba-8fed-210987654321"],
  );
  assert.deepEqual(
    hiddenDmIds({ kind: 9, created_at: 5, tags: [["h", UUID]] }),
    [],
  );
});

test("DM channel metadata is recognized by type tag or hidden marker", () => {
  assert.equal(
    isDmChannelMetadata({ kind: 39000, created_at: 1, tags: [["t", "dm"]] }),
    true,
  );
  assert.equal(
    isDmChannelMetadata({ kind: 39000, created_at: 1, tags: [["hidden"]] }),
    true,
  );
  assert.equal(
    isDmChannelMetadata({
      kind: 39000,
      created_at: 1,
      tags: [["t", "stream"]],
    }),
    false,
  );
  assert.equal(
    isDmChannelMetadata({ kind: 39000, created_at: 1, tags: [] }),
    false,
  );
});

test("conversation labels prefer resolved names over shortened keys", () => {
  assert.equal(
    dmConversationLabel([PK_A, PK_B], (pk) =>
      pk === PK_A ? "Ada" : undefined,
    ),
    "Ada, unknown (bbbbbbbb)",
  );
  assert.equal(
    dmConversationLabel([PK_A], () => undefined, PK_A),
    "conversation",
  );
});
