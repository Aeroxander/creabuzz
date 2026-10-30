import assert from "node:assert/strict";
import { test } from "node:test";

import {
  mayHaveOlder,
  olderLimit,
  personToAct,
  QUEUE_MAX,
  QUEUE_PAGE,
  queueUrl,
  REPORTED_WORD_KINDS,
  reportedSubject,
  shownStatus,
  statusAfter,
  withDecided,
} from "./queueRow.ts";

const ALICE = "a".repeat(64);
const TARGET = "c".repeat(64);
const ROOT = "d".repeat(64);
const BOARD = "0f0f0f0f-1111-2222-3333-444444444444";
const ROOM = "1a1a1a1a-1111-2222-3333-444444444444";

function report(overrides = {}) {
  return {
    id: "r1",
    reportEventId: "f".repeat(64),
    reporterPubkey: "b".repeat(64),
    targetKind: "event",
    target: TARGET,
    channelId: null,
    reportType: "spam",
    note: null,
    status: "open",
    resolvedBy: null,
    resolvedAt: null,
    createdAt: "2026-10-29T10:00:00Z",
    ...overrides,
  };
}

function event(kind, content, tags = []) {
  return { id: TARGET, kind, pubkey: ALICE, content, tags };
}

const found = (e) => new Map([[e.id, e]]);
const readIds = new Set([TARGET]);

test("a Home post shows its words and author, and opens on its own page", () => {
  const subject = reportedSubject(
    report(),
    found(event(1, "  Send me\n your seed phrase ")),
    readIds,
    "/c/alpha.example.com",
  );
  assert.deepEqual(subject, {
    type: "words",
    about: "a post on Home",
    author: ALICE,
    excerpt: "Send me your seed phrase",
    href: `/social/post/${TARGET}`,
    linkLabel: "Open the post",
  });
  assert.equal(personToAct(subject), ALICE);
});

test("a room message opens in its room on the community page, scrolled to it", () => {
  const subject = reportedSubject(
    report({ channelId: ROOM }),
    found(event(9, "Buy my coin")),
    readIds,
    "/c/alpha.example.com",
  );
  assert.equal(subject.type, "words");
  assert.equal(subject.about, "a message");
  assert.equal(
    subject.href,
    `/c/alpha.example.com?channel=${ROOM}&message=${TARGET}`,
  );
});

test("a board post shows its title and the start of its body and opens on the board; a reply opens its thread", () => {
  const post = reportedSubject(
    report({ channelId: BOARD }),
    found(event(45001, "The title\nand the body")),
    readIds,
    "/",
  );
  assert.equal(post.about, "a post on a board");
  assert.equal(post.excerpt, "The title: and the body");
  assert.equal(post.href, `/b/${BOARD}?post=${TARGET}`);
  const reply = reportedSubject(
    report({ channelId: BOARD }),
    found(event(45003, "rude words", [["e", ROOT, "", "root"]])),
    readIds,
    "/",
  );
  assert.equal(reply.about, "a reply on a board");
  assert.equal(reply.href, `/b/${BOARD}?post=${ROOT}`);
  assert.equal(reply.linkLabel, "Open the thread");
});

test("long words are cut short", () => {
  const subject = reportedSubject(
    report(),
    found(event(1, "x".repeat(500))),
    readIds,
    "/",
  );
  assert.ok(subject.excerpt.length <= 201);
  assert.ok(subject.excerpt.endsWith("…"));
});

test("words the read covered and did not find are gone; words never read are not called gone", () => {
  assert.deepEqual(reportedSubject(report(), new Map(), readIds, "/"), {
    type: "gone",
    about: "a post on Home",
  });
  assert.deepEqual(
    reportedSubject(report({ channelId: ROOM }), new Map(), new Set(), "/"),
    { type: "unread", about: "a message" },
  );
  assert.equal(personToAct({ type: "gone", about: "a message" }), null);
});

test("words in a room or board the read covered and did not find are not called gone: the moderator may not be in it", () => {
  assert.deepEqual(
    reportedSubject(report({ channelId: ROOM }), new Map(), readIds, "/"),
    { type: "notFound", about: "a message" },
  );
  assert.equal(personToAct({ type: "notFound", about: "a message" }), null);
});

test("a reported person is named, linked to their profile, and is whom a ban is against", () => {
  const subject = reportedSubject(
    report({ targetKind: "pubkey", target: ALICE }),
    new Map(),
    new Set(),
    "/",
  );
  assert.deepEqual(subject, {
    type: "person",
    about: "a member",
    person: ALICE,
    href: `/u/${ALICE}`,
  });
  assert.equal(personToAct(subject), ALICE);
});

test("the read asks for every kind a reported message, post or reply can be", () => {
  for (const kind of [1, 9, 40002, 45001, 45003])
    assert.ok(REPORTED_WORD_KINDS.includes(kind), `kind ${kind}`);
});

test("the queue read names the filter and the page; All asks for every status", () => {
  assert.equal(
    queueUrl("https://h", "all", 30),
    "https://h/moderation/reports?limit=30",
  );
  assert.equal(
    queueUrl("https://h", "escalated", 60),
    "https://h/moderation/reports?limit=60&status=escalated",
  );
});

test("Show older is offered only when the server filled the page, up to the cap", () => {
  assert.equal(mayHaveOlder(QUEUE_PAGE, QUEUE_PAGE), true);
  assert.equal(mayHaveOlder(QUEUE_PAGE - 1, QUEUE_PAGE), false);
  assert.equal(mayHaveOlder(0, 0), false);
  assert.equal(mayHaveOlder(QUEUE_MAX, QUEUE_MAX), false);
  assert.equal(olderLimit(QUEUE_PAGE), QUEUE_PAGE * 2);
  assert.equal(olderLimit(QUEUE_MAX - 1), QUEUE_MAX);
});

test("a decision shows its status at once, and an escalated report stays listed when the page no longer has it", () => {
  assert.equal(statusAfter("escalate"), "escalated");
  assert.equal(statusAfter("dismiss"), "dismissed");
  assert.equal(statusAfter("ban"), "resolved");
  assert.equal(shownStatus(report(), "escalated"), "escalated");
  assert.equal(
    shownStatus(report({ status: "resolved" }), undefined),
    "resolved",
  );
  const escalated = report({ id: "r2" });
  const listed = withDecided([report()], [escalated, report()]);
  assert.deepEqual(
    listed.map((r) => r.id),
    ["r1", "r2"],
  );
});
