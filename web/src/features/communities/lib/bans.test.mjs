import assert from "node:assert/strict";
import { test } from "node:test";

import { BAN_LENGTHS, banExpiry, describeBan, parseBans } from "./bans.ts";

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
