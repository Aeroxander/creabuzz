import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

import {
  countSupporters,
  followersLine,
  newFollowersLead,
} from "./supporters.ts";

const F = "f".repeat(64);
const A = "a".repeat(64);
const B = "b".repeat(64);
const coord = `37001:${F}:nebula`;
const other = `37001:${F}:other`;
const list = (pubkey, created_at, ...coords) => ({
  pubkey,
  created_at,
  tags: coords.map((c) => ["a", c]),
});

test("each follower counts once per launch", () => {
  const counts = countSupporters(
    [list(A, 1, coord, other), list(B, 1, coord)],
    [coord, other],
  );
  assert.equal(counts.get(coord), 2);
  assert.equal(counts.get(other), 1);
});

test("only a person's newest list counts, so unfollowing removes them", () => {
  const counts = countSupporters(
    [list(A, 1, coord), list(A, 2), list(B, 5, coord), list(B, 3)],
    [coord],
  );
  assert.equal(counts.get(coord), 1);
});

test("the founder's own follow is not a supporter", () => {
  const counts = countSupporters(
    [list(F, 1, coord), list(A, 1, coord)],
    [coord],
  );
  assert.equal(counts.get(coord), 1);
});

test("launches nobody follows count zero, and unrelated bookmarks are ignored", () => {
  const counts = countSupporters(
    [
      {
        pubkey: A,
        created_at: 1,
        tags: [
          ["e", "x"],
          ["a", "30023:x:y"],
        ],
      },
    ],
    [coord],
  );
  assert.equal(counts.get(coord), 0);
});

test("key case does not double count", () => {
  const counts = countSupporters(
    [list(A.toUpperCase(), 1, coord), list(A, 2, coord)],
    [coord],
  );
  assert.equal(counts.get(coord), 1);
});

test("people who follow a project are called followers, in one word everywhere", () => {
  assert.equal(followersLine(0), "No followers yet");
  assert.equal(followersLine(1), "1 follower");
  assert.equal(followersLine(12), "12 followers");
  assert.equal(newFollowersLead(1), "1 new follower on ");
  assert.equal(newFollowersLead(3), "3 new followers on ");
  // The screens that count them take the words from here, and none calls them supporters beside a Follow button.
  for (const [file, word] of [
    ["../ui/LaunchHero.tsx", "followersLine("],
    ["../ui/YourLaunchesSection.tsx", "newFollowersLead("],
  ]) {
    const text = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.ok(text.includes(word), `${file} uses ${word}`);
    assert.doesNotMatch(
      text,
      /No supporters yet|\d+ supporters?\b|new supporters? on/,
      file,
    );
  }
});
