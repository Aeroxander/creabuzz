import assert from "node:assert/strict";
import { test } from "node:test";

import {
  KIND_REPORT,
  MAX_NOTE_LENGTH,
  REPORT_REASONS,
  reportRecord,
  tidyNote,
} from "./report.ts";

const EVENT = "a".repeat(64);
const AUTHOR = "b".repeat(64);

test("a message is reported by naming the message with the reason, and its author", () => {
  assert.deepEqual(
    reportRecord({
      target: { kind: "message", eventId: EVENT, authorPubkey: AUTHOR },
      type: "spam",
      note: "  buy now!!  ",
    }),
    {
      kind: KIND_REPORT,
      content: "buy now!!",
      tags: [
        ["e", EVENT, "spam"],
        ["p", AUTHOR],
      ],
    },
  );
  assert.equal(KIND_REPORT, 1984);
});

test("a person is reported by naming them with the reason, and nothing else", () => {
  assert.deepEqual(
    reportRecord({
      target: { kind: "person", pubkey: AUTHOR },
      type: "impersonation",
    }),
    {
      kind: KIND_REPORT,
      content: "",
      tags: [["p", AUTHOR, "impersonation"]],
    },
  );
});

test("ids are accepted in any case and sent in lower case; anything else is refused", () => {
  const record = reportRecord({
    target: {
      kind: "message",
      eventId: EVENT.toUpperCase(),
      authorPubkey: ` ${AUTHOR.toUpperCase()} `,
    },
    type: "other",
  });
  assert.deepEqual(record.tags, [
    ["e", EVENT, "other"],
    ["p", AUTHOR],
  ]);
  for (const bad of ["", "abc", "g".repeat(64), "a".repeat(63)]) {
    assert.throws(() =>
      reportRecord({
        target: { kind: "message", eventId: bad, authorPubkey: AUTHOR },
        type: "spam",
      }),
    );
    assert.throws(() =>
      reportRecord({ target: { kind: "person", pubkey: bad }, type: "spam" }),
    );
  }
});

test("only the reasons the server takes can be sent", () => {
  assert.throws(
    () =>
      reportRecord({
        target: { kind: "person", pubkey: AUTHOR },
        type: "rude",
      }),
    /unknown report type/,
  );
  // The server's list, and every reason on the screen is one of them.
  const server = [
    "illegal",
    "nudity",
    "malware",
    "spam",
    "impersonation",
    "profanity",
    "other",
  ];
  assert.deepEqual(REPORT_REASONS.map((r) => r.value).sort(), server.sort());
});

test("a note is trimmed and cut to the limit, and an empty one is no note", () => {
  assert.equal(tidyNote("   "), "");
  assert.equal(
    tidyNote("x".repeat(MAX_NOTE_LENGTH + 50)).length,
    MAX_NOTE_LENGTH,
  );
  assert.equal(
    reportRecord({
      target: { kind: "person", pubkey: AUTHOR },
      type: "spam",
      note: "y".repeat(2000),
    }).content.length,
    MAX_NOTE_LENGTH,
  );
});

test("every reason has words a person can read", () => {
  for (const reason of REPORT_REASONS) {
    assert.ok(reason.label.length > 3 && reason.hint.length > 10, reason.value);
    // Plain words, not the protocol's.
    assert.doesNotMatch(
      reason.label + reason.hint,
      /nip-?56|kind|relay|nostr/i,
    );
  }
});
