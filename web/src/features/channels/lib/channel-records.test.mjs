import assert from "node:assert/strict";
import test from "node:test";

import {
  channelFromRecord,
  channelsFromRecords,
  latestRecords,
  listedRooms,
} from "./channel-records.ts";

const SERVER = "a".repeat(64);

function record(d, tags, createdAt = 100) {
  return {
    id: `${d}-${createdAt}`,
    pubkey: SERVER,
    kind: 39000,
    created_at: createdAt,
    tags: [["d", d], ...tags],
  };
}

test("a room's record reads into its name, kind of room and who can read it", () => {
  const room = channelFromRecord(
    record("room-1", [
      ["name", "design"],
      ["about", "Sketches"],
      ["private"],
      ["t", "forum"],
    ]),
  );
  assert.deepEqual(room, {
    id: "room-1",
    name: "design",
    description: "Sketches",
    visibility: "private",
    type: "forum",
    direct: false,
    createdAt: 100,
    serverKey: SERVER,
  });
});

test("a direct-message thread is marked direct, by its type or only by being hidden", () => {
  assert.equal(
    channelFromRecord(record("dm-1", [["name", "DM"], ["hidden"], ["t", "dm"]]))
      .direct,
    true,
  );
  // An older server that only marks it hidden.
  assert.equal(
    channelFromRecord(record("dm-2", [["name", "DM"], ["hidden"]])).direct,
    true,
  );
  // A typed room is not a DM even if something marked it hidden.
  assert.equal(
    channelFromRecord(record("room", [["hidden"], ["t", "stream"]])).direct,
    false,
  );
});

test("only the newest record of a channel counts", () => {
  const older = record("room-1", [["name", "old name"]], 100);
  const newer = record("room-1", [["name", "new name"]], 200);
  assert.deepEqual(latestRecords([newer, older]), [newer]);
  assert.deepEqual(
    channelsFromRecords([older, newer]).map((channel) => channel.name),
    ["new name"],
  );
});

test("the listed rooms leave out DM threads, which the page itself still holds", () => {
  const page = channelsFromRecords([
    record(
      "general",
      [
        ["name", "general"],
        ["t", "stream"],
      ],
      300,
    ),
    record("dm-1", [["name", "DM"], ["hidden"], ["t", "dm"]], 200),
    record(
      "ideas",
      [
        ["name", "ideas"],
        ["t", "forum"],
      ],
      100,
    ),
  ]);
  // The page keeps every record: walking back to older pages goes by the oldest record, DM or not.
  assert.deepEqual(
    page.map((channel) => channel.id),
    ["dm-1", "general", "ideas"],
  );
  assert.deepEqual(
    listedRooms(page).map((channel) => channel.id),
    ["general", "ideas"],
  );
});
