import assert from "node:assert/strict";
import { test } from "node:test";

import {
  aboutLine,
  adminOriginFromInfo,
  dealtWithElsewhere,
  doneLine,
  ESCALATED_STATUS_LINE,
  escalatedAgain,
  escalatedListUrl,
  escalatedRows,
  isOperatorProbe,
  operatorActions,
  parseEscalatedReports,
  personOf,
  refusalMessage,
  refusalWords,
  reopenBody,
  reportedWords,
  resolveBody,
} from "./escalatedReports.ts";

const REPORTER = "a".repeat(64);
const TARGET = "b".repeat(64);
const AUTHOR = "c".repeat(64);

function row(overrides = {}) {
  return {
    id: "r1",
    communityId: "c1",
    communityHost: "pilot.example",
    reportEventId: "e".repeat(64),
    reporterPubkey: REPORTER,
    targetKind: "event",
    target: TARGET,
    targetAuthorPubkey: AUTHOR,
    channelId: null,
    reportType: "spam",
    note: "buy now",
    status: "escalated",
    resolvedBy: "d".repeat(64),
    resolvedAt: "2026-11-01T09:30:00Z",
    actionId: null,
    createdAt: "2026-10-31T08:00:00Z",
    ...overrides,
  };
}

test("the admin origin comes from the server's info document, and only a web origin counts", () => {
  assert.equal(
    adminOriginFromInfo({ admin_api: "https://admin.example" }),
    "https://admin.example",
  );
  assert.equal(
    adminOriginFromInfo({ admin_api: "http://admin.localhost:3001" }),
    "http://admin.localhost:3001",
  );
  assert.equal(adminOriginFromInfo({}), null);
  assert.equal(adminOriginFromInfo(null), null);
  assert.equal(adminOriginFromInfo({ admin_api: "javascript:alert(1)" }), null);
  assert.equal(adminOriginFromInfo({ admin_api: "not a url" }), null);
});

test("only a signed member of the server's staff who may act is an operator here", () => {
  assert.equal(isOperatorProbe({ authMode: "nip98", canAct: true }), true);
  assert.equal(isOperatorProbe({ authMode: "nip98", canAct: false }), false);
  // A server that checks no identity serves its reports to anyone who can reach it: never show them in a page.
  assert.equal(isOperatorProbe({ authMode: "disabled", canAct: false }), false);
  assert.equal(isOperatorProbe(null), false);
});

test("escalated rows keep who sent it, which community and post, and when it was passed on", () => {
  const [report] = parseEscalatedReports([row()]);
  assert.deepEqual(report, {
    id: "r1",
    communityHost: "pilot.example",
    reporterPubkey: REPORTER,
    targetKind: "event",
    target: TARGET,
    targetAuthor: AUTHOR,
    channelId: null,
    reportType: "spam",
    note: "buy now",
    escalatedAt: "2026-11-01T09:30:00Z",
  });
});

test("a report that arrived escalated is dated when it was made", () => {
  const [report] = parseEscalatedReports([row({ resolvedAt: null })]);
  assert.equal(report.escalatedAt, "2026-10-31T08:00:00Z");
});

test("rows that are not escalated, or are malformed, are left out", () => {
  assert.deepEqual(
    parseEscalatedReports([
      row({ status: "open" }),
      row({ id: "" }),
      row({ communityHost: null }),
      "nonsense",
    ]),
    [],
  );
  assert.deepEqual(parseEscalatedReports({ not: "a list" }), []);
});

test("the list read asks for escalated reports only, a bounded page", () => {
  assert.equal(
    escalatedListUrl("https://admin.example"),
    "https://admin.example/api/admin/v1/reports?status=escalated&limit=25",
  );
});

test("a post can be removed and its author banned; a member banned; a file only closed", () => {
  const [post] = parseEscalatedReports([row()]);
  assert.deepEqual(operatorActions(post), ["delete", "ban", "dismiss"]);
  assert.equal(personOf(post), AUTHOR);
  const [unknownAuthor] = parseEscalatedReports([
    row({ targetAuthorPubkey: null }),
  ]);
  assert.deepEqual(operatorActions(unknownAuthor), ["delete", "dismiss"]);
  const [member] = parseEscalatedReports([row({ targetKind: "pubkey" })]);
  assert.deepEqual(operatorActions(member), ["ban", "dismiss"]);
  assert.equal(personOf(member), TARGET);
  const [file] = parseEscalatedReports([row({ targetKind: "blob" })]);
  assert.deepEqual(operatorActions(file), ["dismiss"]);
});

test("the heading names the kind of report and what it is about", () => {
  const [home] = parseEscalatedReports([row()]);
  assert.equal(aboutLine(home), "Spam · about a post on Home");
  const [room] = parseEscalatedReports([row({ channelId: "ch1" })]);
  assert.equal(aboutLine(room), "Spam · about a message or board post");
  const [member] = parseEscalatedReports([row({ targetKind: "pubkey" })]);
  assert.equal(aboutLine(member), "Spam · about a member");
});

test("removal and bans carry their retry key; closing does not", () => {
  assert.deepEqual(resolveBody("delete", "k1", "Spam"), {
    action: "delete",
    requestId: "k1",
    reason: "Spam",
  });
  assert.deepEqual(resolveBody("ban", "k2", ""), {
    action: "ban",
    requestId: "k2",
  });
  assert.deepEqual(resolveBody("dismiss", "k3", undefined), {
    action: "dismiss",
  });
});

test("the reported words come from the report's detail", () => {
  assert.equal(
    reportedWords({ message: { content: "buy now", authorPubkey: AUTHOR } }),
    "buy now",
  );
  assert.equal(reportedWords({ message: null }), null);
  assert.equal(reportedWords(null), null);
});

test("refusals are said in plain words, and a report someone else dealt with is settled, not retried", () => {
  assert.equal(
    refusalMessage({
      error: {
        code: "conflict",
        message: "report is not open (current status: resolved)",
      },
    }),
    "report is not open (current status: resolved)",
  );
  assert.equal(refusalMessage({}), null);
  assert.match(
    refusalWords(409, "report is not open (current status: resolved)"),
    /already dealt with/,
  );
  assert.match(refusalWords(403, null), /didn’t accept you/);
  assert.equal(
    refusalWords(500, null),
    "Couldn’t apply the action. Try again.",
  );
  // A fenced reopen refused because the report is no longer escalated, including when someone reopened it: never
  // treated as this operator's own reopen.
  for (const message of [
    "report is not reopenable (current status: dismissed)",
    "report is not reopenable (current status: open)",
    "report is not open (current status: resolved)",
  ]) {
    assert.equal(dealtWithElsewhere(409, message), true, message);
  }
  assert.equal(dealtWithElsewhere(500, "report is not open"), false);
  assert.equal(dealtWithElsewhere(409, "request_id reused"), false);
  assert.equal(
    doneLine("elsewhere"),
    "Someone has already dealt with this report.",
  );
});

test("an operator reopens a report only while it is still escalated", () => {
  assert.deepEqual(reopenBody("k1"), {
    requestId: "k1",
    reason: "Taken up by the server’s owner",
    expectStatus: "escalated",
  });
});

test("a settled report escalated again gives way to the listed one", () => {
  const settled = { escalatedAt: "2026-10-30T09:00:00Z" };
  assert.equal(
    escalatedAgain(settled, { escalatedAt: "2026-10-31T09:00:00Z" }),
    true,
  );
  assert.equal(
    escalatedAgain(settled, { escalatedAt: "2026-10-30T09:00:00Z" }),
    false,
  );
  assert.equal(escalatedAgain(settled, { escalatedAt: "not a date" }), false);
});

test("what a done row and an escalated row say", () => {
  assert.equal(doneLine("delete"), "Removed, and the report closed.");
  assert.equal(doneLine("ban"), "Banned, and the report closed.");
  assert.equal(doneLine("dismiss"), "Closed with nothing done.");
  assert.match(ESCALATED_STATUS_LINE, /^Sent to the server’s owner\./);
});

test("a report reopened here whose resolve failed keeps its row after the list is read again", () => {
  const a = { report: row({ id: "a" }), words: "spam" };
  const b = { report: row({ id: "b" }), words: null };
  const c = { report: row({ id: "c" }), words: "scam" };
  // The server lists only a: b was settled here, c was reopened and its resolve failed (it is open now).
  const rows = escalatedRows(
    [a],
    new Map([["b", { ...b, action: "ban" }]]),
    new Map([["c", c]]),
  );
  assert.deepEqual(
    rows.map((r) => [r.report.id, r.done, r.words]),
    [
      ["a", null, "spam"],
      ["b", "ban", null],
      ["c", null, "scam"],
    ],
  );
  // Listed again, or settled, it shows once.
  assert.deepEqual(
    escalatedRows(
      [c],
      new Map([["c", { ...c, action: "delete" }]]),
      new Map([["c", c]]),
    ).map((r) => [r.report.id, r.done]),
    [["c", "delete"]],
  );
  assert.deepEqual(
    escalatedRows(
      [],
      new Map([["c", { ...c, action: "elsewhere" }]]),
      new Map([["c", c]]),
    ).map((r) => [r.report.id, r.done]),
    [["c", "elsewhere"]],
  );
});
