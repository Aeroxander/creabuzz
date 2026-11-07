import assert from "node:assert/strict";
import test from "node:test";

import {
  BOARD_REPORTS_LIMIT,
  boardReportsUrl,
  reportChoices,
  reportedWords,
} from "./board-reports.ts";

const BOARD = "7b0e5a1c-4b1e-4f7e-9a51-2a7c0c1d9e01";
const ME = "a1".repeat(32);
const BEA = "b2".repeat(32);
const POST = "c3".repeat(32);
const REPLY = "d4".repeat(32);

const report = (overrides = {}) => ({
  id: "r1",
  reportEventId: "e5".repeat(32),
  reporterPubkey: null,
  targetKind: "event",
  target: POST,
  channelId: BOARD,
  reportType: "spam",
  note: "ads",
  status: "open",
  resolvedBy: null,
  resolvedAt: null,
  createdAt: "2026-10-23T00:00:00Z",
  ...overrides,
});

const events = [
  {
    id: POST,
    kind: 45001,
    pubkey: BEA,
    content: "# Cheap watches\n\nBuy now",
    tags: [["h", BOARD]],
  },
  {
    id: REPLY,
    kind: 45003,
    pubkey: BEA,
    content: `Click   here ${"x".repeat(200)}`,
    tags: [
      ["h", BOARD],
      ["e", POST, "", "root"],
    ],
  },
];

test("the board's read names the board and asks only for open reports", () => {
  const url = new URL(boardReportsUrl("https://example.org", BOARD));
  assert.equal(url.pathname, "/moderation/reports");
  assert.equal(url.searchParams.get("channel"), BOARD);
  assert.equal(url.searchParams.get("status"), "open");
  assert.equal(url.searchParams.get("limit"), String(BOARD_REPORTS_LIMIT));
});

test("reported words: a post by its title, a reply by its start and its thread, gone when the board no longer has them", () => {
  assert.deepEqual(reportedWords(report(), events), {
    what: "post",
    author: BEA,
    excerpt: "Cheap watches",
    thread: POST,
  });
  const reply = reportedWords(report({ target: REPLY }), events);
  assert.equal(reply.what, "reply");
  assert.equal(reply.thread, POST);
  assert.ok(reply.excerpt.startsWith("Click here x"));
  assert.ok(reply.excerpt.endsWith("…"));
  assert.equal(
    reportedWords(report({ target: "f6".repeat(32) }), events),
    null,
  );
});

test("choices mirror the server: never your own words, never someone you do not outrank, a gone post can be closed", () => {
  const words = reportedWords(report(), events);
  const outranksBea = (author) => author === BEA;
  assert.deepEqual(reportChoices(report(), words, ME, outranksBea), {
    remove: true,
    close: false,
    dismiss: true,
    leftFor: null,
  });
  const equal = reportChoices(report(), words, ME, () => false);
  assert.equal(equal.remove || equal.dismiss || equal.close, false);
  assert.match(equal.leftFor, /same or higher standing/);
  const own = reportChoices(report(), { ...words, author: ME }, ME, () => true);
  assert.equal(own.remove || own.dismiss, false);
  assert.match(own.leftFor, /your own words/);
  assert.deepEqual(
    reportChoices(report(), null, ME, () => false),
    {
      remove: false,
      close: true,
      dismiss: true,
      leftFor: null,
    },
  );
  // Signed out, or a report already closed: nothing.
  assert.equal(reportChoices(report(), words, null, outranksBea).remove, false);
  assert.equal(
    reportChoices(report({ status: "dismissed" }), words, ME, outranksBea)
      .dismiss,
    false,
  );
});
