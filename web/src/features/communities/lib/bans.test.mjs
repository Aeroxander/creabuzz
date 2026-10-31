import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BAN_LENGTHS,
  banExpiry,
  describeBan,
  describeTimeout,
  parseBans,
  parseTimeouts,
} from "./bans.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const NOW = 1_800_000_000;
const iso = (unix) => new Date(unix * 1000).toISOString();

test("a ban lasts for good or for a fixed time, and the choices are plain words", () => {
  assert.deepEqual(
    BAN_LENGTHS.map((length) => length.label),
    ["For good", "1 day", "7 days", "30 days"],
  );
  assert.equal(BAN_LENGTHS[0].secs, null);
  assert.equal(
    banExpiry(NOW, null),
    undefined,
    "no expiry means it does not end",
  );
  assert.equal(banExpiry(NOW, 86_400), NOW + 86_400);
});

test("only current bans are read: time-outs, ended bans and half-rows are left out", () => {
  const bans = parseBans(
    [
      {
        pubkey: A,
        banned: true,
        ban_expires_at: null,
        ban_reason: " spam ",
        actor_pubkey: B,
      },
      {
        pubkey: B,
        banned: true,
        ban_expires_at: iso(NOW + 3 * 86_400),
        ban_reason: null,
        actor_pubkey: A,
      },
      { pubkey: A, banned: false, muted_until: iso(NOW + 60) },
      { pubkey: "c".repeat(64), banned: true, ban_expires_at: iso(NOW - 5) },
      { pubkey: "short", banned: true },
      { banned: true },
      "nope",
      null,
    ],
    NOW,
  );
  assert.deepEqual(bans, [
    { pubkey: A, reason: "spam", until: null, by: B },
    { pubkey: B, reason: "", until: NOW + 3 * 86_400, by: A },
  ]);
});

test("a body that is not a list gives no bans", () => {
  for (const bad of [null, undefined, "x", {}, { bans: [] }, 5]) {
    assert.deepEqual(parseBans(bad, NOW), []);
  }
});

test("keys are compared in lower case", () => {
  const [ban] = parseBans([{ pubkey: A.toUpperCase(), banned: true }], NOW);
  assert.equal(ban.pubkey, A);
});

test("a ban says how long it has left", () => {
  const forever = { pubkey: A, reason: "", until: null, by: B };
  assert.equal(describeBan(forever, NOW), "Banned for good");
  assert.equal(
    describeBan({ ...forever, until: NOW + 3 * 86_400 + 100 }, NOW),
    "Banned for 3 more days",
  );
  assert.equal(
    describeBan({ ...forever, until: NOW + 7 * 86_400 - 1 }, NOW),
    "Banned for 7 more days",
    "a week-long ban made a moment ago says seven",
  );
  assert.equal(
    describeBan({ ...forever, until: NOW + 86_400 }, NOW),
    "Banned for 1 more day",
  );
  assert.equal(
    describeBan({ ...forever, until: NOW + 5 * 3600 - 10 }, NOW),
    "Banned for 5 more hours",
  );
  assert.equal(
    describeBan({ ...forever, until: NOW + 30 }, NOW),
    "Banned for 1 more hour",
  );
});

test("current mutes are read from the same list: ended ones, rows with no mute and half-rows are left out", () => {
  const timeouts = parseTimeouts(
    [
      {
        pubkey: A.toUpperCase(),
        banned: false,
        muted_until: iso(NOW + 3600),
        mute_reason: "  spam  ",
        actor_pubkey: B,
      },
      // Banned and muted: in both lists.
      { pubkey: B, banned: true, muted_until: iso(NOW + 86_400) },
      { pubkey: "c".repeat(64), banned: false, muted_until: iso(NOW - 1) },
      { pubkey: "d".repeat(64), banned: true, muted_until: null },
      { pubkey: "short", muted_until: iso(NOW + 3600) },
      { pubkey: "e".repeat(64), muted_until: "not a date" },
      null,
    ],
    NOW,
  );
  assert.deepEqual(timeouts, [
    { pubkey: A, reason: "spam", until: NOW + 3600, by: B },
    { pubkey: B, reason: "", until: NOW + 86_400, by: "" },
  ]);
  assert.deepEqual(parseTimeouts({ rows: [] }, NOW), []);
  assert.deepEqual(
    parseBans(
      [{ pubkey: A, banned: false, muted_until: iso(NOW + 3600) }],
      NOW,
    ),
    [],
  );
});

test("a mute says how long it has left", () => {
  const base = { pubkey: A, reason: "", by: "" };
  assert.equal(
    describeTimeout({ ...base, until: NOW + 7 * 86_400 - 5 }, NOW),
    "Muted for 7 more days",
  );
  assert.equal(
    describeTimeout({ ...base, until: NOW + 86_400 }, NOW),
    "Muted for 1 more day",
  );
  assert.equal(
    describeTimeout({ ...base, until: NOW + 5 * 3600 - 10 }, NOW),
    "Muted for 5 more hours",
  );
  assert.equal(
    describeTimeout({ ...base, until: NOW + 3600 }, NOW),
    "Muted for 60 more minutes",
  );
  assert.equal(
    describeTimeout({ ...base, until: NOW + 30 }, NOW),
    "Muted for 1 more minute",
  );
  // Under a day is said in hours, never rounded up to a day.
  assert.equal(
    describeTimeout({ ...base, until: NOW + 13 * 3600 }, NOW),
    "Muted for 13 more hours",
  );
  assert.equal(
    describeTimeout({ ...base, until: NOW + 86_400 - 30 }, NOW),
    "Muted for 1 more day",
  );
  assert.equal(
    describeBan({ ...base, until: NOW + 13 * 3600 }, NOW),
    "Banned for 13 more hours",
  );
});
