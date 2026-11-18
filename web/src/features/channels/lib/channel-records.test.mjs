import assert from "node:assert/strict";
import test from "node:test";

import {
  channelFromRecord,
  channelsFromRecords,
  defaultRoom,
  latestRecords,
  listedRooms,
  mergeChannelPages,
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

test("a community opens on #general, else its first chat room, else its first board, and never on a direct thread", () => {
  const room = (name, type = "stream", direct = false) => ({
    id: name,
    name,
    description: "",
    visibility: "public",
    type,
    direct,
    createdAt: 1,
    serverKey: null,
  });
  assert.equal(
    defaultRoom([room("supporters", "forum"), room("random"), room("General")])
      ?.name,
    "General",
  );
  assert.equal(
    defaultRoom([room("supporters", "forum"), room("random"), room("design")])
      ?.name,
    "random",
  );
  assert.equal(
    defaultRoom([room("general", "stream", true), room("supporters", "forum")])
      ?.name,
    "supporters",
  );
  assert.equal(defaultRoom([room("general", "stream", true)]), null);
  assert.equal(defaultRoom([]), null);
});

test("pages merge to one room each, and the newest record of a room wins whichever page it is on", () => {
  const renamed = channelFromRecord(record("r1", [["name", "new-name"]], 300));
  const stale = channelFromRecord(record("r1", [["name", "old-name"]], 100));
  const other = channelFromRecord(record("r2", [["name", "other"]], 50));
  // The first page holds the room's new record; an older page read before the rename still holds its old one.
  const merged = mergeChannelPages([renamed], [stale, other]);
  assert.deepEqual(
    merged.map((c) => [c.id, c.name]),
    [
      ["r1", "new-name"],
      ["r2", "other"],
    ],
  );
  // And the other way round: a newer record on an older page is still the one kept.
  assert.equal(mergeChannelPages([stale], [renamed])[0].name, "new-name");
});
