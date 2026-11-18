import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import {
  CLOCK_SKEW_SECONDS,
  FULL_READ_LIMIT,
  inboxFilter,
  mergeWraps,
  NEW_READ_LIMIT,
  readInboxWraps,
  resetInboxReads,
  WRAP_JITTER_SECONDS,
} from "./inbox-read.ts";

const ME = "a".repeat(64);
const KEY = `wss://alpha.example|${ME}`;
const wrap = (id, at) => ({ id, created_at: at });

/** A server holding `wraps`, answering each filter as a relay does (since, newest first, limit), and noting each ask. */
function server(wraps) {
  const asked = [];
  const read = async (filter) => {
    asked.push(filter);
    return wraps
      .filter((w) => filter.since === undefined || w.created_at >= filter.since)
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, filter.limit);
  };
  return { asked, read, wraps };
}

beforeEach(() => resetInboxReads());

test("the first read is the whole inbox, bounded; later ones ask only from two days before the last read", () => {
  assert.deepEqual(inboxFilter(ME, null), {
    filter: { kinds: [1059], "#p": [ME], limit: FULL_READ_LIMIT },
    full: true,
  });
  const later = inboxFilter(ME, 1_000_000);
  assert.equal(later.full, false);
  assert.equal(
    later.filter.since,
    1_000_000 - WRAP_JITTER_SECONDS - CLOCK_SKEW_SECONDS,
  );
  assert.equal(later.filter.limit, NEW_READ_LIMIT);
  assert.ok(NEW_READ_LIMIT < FULL_READ_LIMIT);
});

test("merging keeps each wrap once, newest first, and never more than the bound", () => {
  const merged = mergeWraps(
    [wrap("a", 10), wrap("b", 20)],
    [wrap("b", 20), wrap("c", 30)],
  );
  assert.deepEqual(
    merged.map((w) => w.id),
    ["c", "b", "a"],
  );
  assert.deepEqual(
    mergeWraps([wrap("a", 10), wrap("b", 20)], [wrap("c", 30)], 2).map(
      (w) => w.id,
    ),
    ["c", "b"],
  );
});

test("polling the inbox reads it whole once, then merges only what is new, even a wrap dated in the past", async () => {
  const NOW = 2_000_000;
  // Old messages: one older than any later read's window.
  const inbox = server([
    wrap("old", NOW - 30 * 86_400),
    wrap("recent", NOW - 3_600),
  ]);
  let clock = NOW;
  const first = await readInboxWraps(KEY, ME, inbox.read, () => clock);
  assert.deepEqual(
    first.map((w) => w.id),
    ["recent", "old"],
  );
  assert.equal(inbox.asked[0].since, undefined);

  // Twenty seconds later a message arrives whose wrap is dated a day and a half back, as NIP-59 has it.
  clock = NOW + 20;
  inbox.wraps.push(wrap("new", NOW - 36 * 3_600));
  const second = await readInboxWraps(KEY, ME, inbox.read, () => clock);
  assert.ok(
    inbox.asked[1].since !== undefined,
    "the second read is since-based",
  );
  assert.ok(inbox.asked[1].since > NOW - 30 * 86_400);
  assert.equal(inbox.asked[1].limit, NEW_READ_LIMIT);
  // The new wrap is found, and the old one, outside the window, is still held.
  assert.deepEqual(
    second.map((w) => w.id),
    ["recent", "new", "old"],
  );
});

test("a later read that fills its limit is followed by a whole read, so nothing past its limit is missed", async () => {
  const NOW = 3_000_000;
  const inbox = server([wrap("first", NOW - 10)]);
  await readInboxWraps(KEY, ME, inbox.read, () => NOW);
  for (let i = 0; i < NEW_READ_LIMIT + 5; i++)
    inbox.wraps.push(wrap(`burst-${i}`, NOW - i));
  const after = await readInboxWraps(KEY, ME, inbox.read, () => NOW + 5);
  assert.equal(inbox.asked.length, 3);
  assert.equal(inbox.asked[2].since, undefined);
  assert.equal(after.length, NEW_READ_LIMIT + 6);
});

test("a read that fails keeps what was held and asks again from the same point", async () => {
  const NOW = 4_000_000;
  const inbox = server([wrap("kept", NOW - 10)]);
  await readInboxWraps(KEY, ME, inbox.read, () => NOW);
  await assert.rejects(
    readInboxWraps(
      KEY,
      ME,
      async () => {
        throw new Error("query timed out");
      },
      () => NOW + 20,
    ),
  );
  const again = await readInboxWraps(KEY, ME, inbox.read, () => NOW + 40);
  assert.deepEqual(
    again.map((w) => w.id),
    ["kept"],
  );
  // Still since the last read that worked, not the one that failed.
  assert.equal(
    inbox.asked.at(-1).since,
    NOW - WRAP_JITTER_SECONDS - CLOCK_SKEW_SECONDS,
  );
});

test("each server and account has its own inbox", async () => {
  const one = server([wrap("mine", 100)]);
  const other = server([wrap("theirs", 100)]);
  await readInboxWraps(KEY, ME, one.read, () => 200);
  const read = await readInboxWraps(
    `wss://beta.example|${ME}`,
    ME,
    other.read,
    () => 200,
  );
  assert.deepEqual(
    read.map((w) => w.id),
    ["theirs"],
  );
  assert.equal(other.asked[0].since, undefined);
});
