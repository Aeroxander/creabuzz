import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLaunchUpdate,
  claimedLaunch,
  PRIORITY_PER_WEEK,
  priorityIds,
  teamsFromLaunches,
  verifiedUpdates,
} from "./launch-update.ts";

const hex = (c) => c.repeat(64);
const FOUNDER = hex("a");
const MATE = hex("b");
const STRANGER = hex("c");
const COORD = `37001:${FOUNDER}:nebula`;
const OTHER = `37001:${FOUNDER}:other`;
const DAY = 86_400;

const marked = (id, pubkey, at, coord = COORD) => ({
  id: hex(id),
  pubkey,
  created_at: at,
  kind: 1,
  content: "shipped",
  tags: [
    ["a", coord],
    ["l", "launch-update", "creaton.launch"],
  ],
});

const teams = teamsFromLaunches([
  { author: FOUNDER, id: "nebula", team: [{ pubkey: MATE }] },
  { author: FOUNDER, id: "other", team: [] },
]);

test("a launch-mode post is a normal note with the launch and the label", () => {
  const post = buildLaunchUpdate({
    text: "We shipped #beta",
    launch: { pubkey: FOUNDER, id: "nebula" },
  });
  assert.equal(post.kind, 1);
  assert.ok(post.tags.some((t) => t[0] === "a" && t[1] === COORD));
  assert.deepEqual(
    post.tags.find((t) => t[0] === "l"),
    ["l", "launch-update", "creaton.launch"],
  );
  assert.ok(post.tags.some((t) => t[0] === "t" && t[1] === "beta"));
  assert.match(post.content, /nostr:naddr1/);
});

test("the label alone is not enough: it must also name exactly one launch", () => {
  assert.equal(claimedLaunch(marked("1", FOUNDER, 1)), COORD);
  const noLaunch = {
    ...marked("1", FOUNDER, 1),
    tags: [["l", "launch-update", "creaton.launch"]],
  };
  assert.equal(claimedLaunch(noLaunch), null);
  const two = {
    ...marked("1", FOUNDER, 1),
    tags: [...marked("1", FOUNDER, 1).tags, ["a", OTHER]],
  };
  assert.equal(claimedLaunch(two), null);
  const wrongNamespace = {
    ...marked("1", FOUNDER, 1),
    tags: [
      ["a", COORD],
      ["l", "launch-update", "someone.else"],
    ],
  };
  assert.equal(claimedLaunch(wrongNamespace), null);
});

test("only the team's marked posts count", () => {
  const updates = verifiedUpdates(
    [
      marked("1", FOUNDER, 10),
      marked("2", MATE, 20),
      marked("3", STRANGER, 30),
      marked("4", MATE, 40, OTHER),
    ],
    teams,
  );
  assert.deepEqual(
    updates.map((u) => u.id),
    [hex("2"), hex("1")],
  );
});

test("duplicates are dropped and the newest comes first", () => {
  const a = marked("1", FOUNDER, 10);
  const updates = verifiedUpdates([a, a, marked("2", FOUNDER, 99)], teams);
  assert.equal(updates.length, 2);
  assert.equal(updates[0].at, 99);
});

test("a launch's priority updates are rationed per rolling week", () => {
  const events = Array.from({ length: 5 }, (_, i) =>
    marked(String(i + 1), FOUNDER, 1_000 + i * 60),
  );
  const updates = verifiedUpdates(events, teams);
  const priority = priorityIds(updates);
  assert.equal(priority.size, PRIORITY_PER_WEEK);
  // The earliest ones win, so the answer never changes as newer ones arrive.
  assert.ok(priority.has(hex("1")) && priority.has(hex("3")));
  assert.ok(!priority.has(hex("4")) && !priority.has(hex("5")));
});

test("the ration refills after a week and is per launch", () => {
  const events = [
    ...[1, 2, 3, 4].map((n) => marked(String(n), FOUNDER, 1_000 + n)),
    marked("5", FOUNDER, 1_000 + 8 * DAY),
    marked("6", FOUNDER, 1_000 + 8 * DAY + 1, OTHER),
  ];
  const priority = priorityIds(verifiedUpdates(events, teams));
  assert.ok(!priority.has(hex("4")));
  assert.ok(
    priority.has(hex("5")),
    "a week later the launch has priority again",
  );
  assert.ok(priority.has(hex("6")), "another launch is rationed separately");
});
