// Moderation command contract: the queue's action events must match the
// canonical SDK builders (crates/buzz-sdk/src/builders.rs `build_moderation_*`
// / `build_delete_message`) that the desktop moderation surface publishes.
// The builder pins bind web to those shapes — flipping a tag must fail.
// Run with: node --experimental-strip-types --test src/features/moderation/lib/moderationEvents.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildBan,
  buildDeleteContent,
  buildResolveReport,
  buildTimeout,
} from "./moderationEvents.ts";
import {
  enforcementTarget,
  parseModerationReports,
  resolvableActions,
  reportTypeLabel,
  sortQueue,
} from "./moderationQueue.ts";

const REPORT = "ab".repeat(32);
const MEMBER = "cd".repeat(32);
const CHANNEL = "3f2b7c9e-1111-2222-3333-444455556666";

describe("buildResolveReport (desktop-pinned)", () => {
  it("pairs dismiss with dismissed and everything else with resolved", () => {
    assert.deepEqual(
      buildResolveReport({ reportEventId: REPORT, action: "dismiss" }),
      {
        kind: 9044,
        content: "",
        tags: [
          ["report", REPORT],
          ["status", "dismissed"],
          ["action", "dismiss"],
        ],
      },
    );
    assert.deepEqual(
      buildResolveReport({
        reportEventId: REPORT,
        action: "escalate",
        reason: "repeat offender",
      }).tags,
      [
        ["report", REPORT],
        ["status", "resolved"],
        ["action", "escalate"],
        ["reason", "repeat offender"],
      ],
    );
  });

  it("rejects a report id that is not a 64-char hex id", () => {
    assert.throws(
      () => buildResolveReport({ reportEventId: "nope", action: "ban" }),
      /64-character hex id/,
    );
  });
});

describe("enforcement builders (desktop-pinned)", () => {
  it("builds ban with p, optional expiration and reason", () => {
    assert.deepEqual(buildBan({ pubkey: MEMBER }), {
      kind: 9040,
      content: "",
      tags: [["p", MEMBER]],
    });
    assert.deepEqual(
      buildBan({ pubkey: MEMBER, expiresAt: 1700000000, reason: "spam" }).tags,
      [
        ["p", MEMBER],
        ["expiration", "1700000000"],
        ["reason", "spam"],
      ],
    );
  });

  it("builds timeout with a required expiration", () => {
    assert.deepEqual(buildTimeout({ pubkey: MEMBER, expiresAt: 2 }), {
      kind: 9042,
      content: "",
      tags: [
        ["p", MEMBER],
        ["expiration", "2"],
      ],
    });
    assert.throws(
      () => buildTimeout({ pubkey: MEMBER, expiresAt: 0 }),
      /expiry/,
    );
  });

  it("builds content delete with h and e tags", () => {
    assert.deepEqual(
      buildDeleteContent({ channelId: CHANNEL, eventId: REPORT }),
      {
        kind: 9005,
        content: "",
        tags: [
          ["h", CHANNEL],
          ["e", REPORT],
        ],
      },
    );
    assert.throws(
      () => buildDeleteContent({ channelId: "", eventId: REPORT }),
      /channel id/,
    );
  });
});

describe("queue rows", () => {
  const rawRow = (overrides = {}) => ({
    id: "r1",
    report_event_id: REPORT,
    reporter_pubkey: MEMBER,
    target_kind: "event",
    target: "e".repeat(64),
    channel_id: CHANNEL,
    report_type: "spam",
    note: "ads everywhere",
    status: "open",
    resolved_by: null,
    resolved_at: null,
    created_at: "2026-09-30T00:00:00Z",
    ...overrides,
  });

  it("maps snake_case rows and drops malformed ones", () => {
    const rows = parseModerationReports([rawRow(), { id: "" }, null]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reportEventId, REPORT);
    assert.equal(rows[0].reportType, "spam");
    assert.equal(reportTypeLabel(rows[0].reportType), "Spam");
  });

  it("sorts open rows first and by severity", () => {
    const rows = parseModerationReports([
      rawRow({
        id: "a",
        report_type: "spam",
        created_at: "2026-09-30T01:00:00Z",
      }),
      rawRow({
        id: "b",
        report_type: "illegal",
        created_at: "2026-09-30T00:00:00Z",
      }),
      rawRow({ id: "c", status: "resolved", report_type: "illegal" }),
    ]);
    assert.deepEqual(
      sortQueue(rows).map((row) => row.id),
      ["b", "a", "c"],
    );
  });

  it("offers only the actions the target supports", () => {
    const [eventRow] = parseModerationReports([rawRow()]);
    assert.deepEqual(resolvableActions(eventRow, MEMBER), [
      "delete",
      "timeout",
      "ban",
      "dismiss",
      "escalate",
    ]);
    assert.deepEqual(resolvableActions(eventRow, null), [
      "delete",
      "dismiss",
      "escalate",
    ]);
    const [pubkeyRow] = parseModerationReports([
      rawRow({ target_kind: "pubkey", target: MEMBER, channel_id: null }),
    ]);
    assert.deepEqual(resolvableActions(pubkeyRow, null), [
      "timeout",
      "ban",
      "dismiss",
      "escalate",
    ]);
    const closed = { ...eventRow, status: "resolved" };
    assert.deepEqual(resolvableActions(closed, MEMBER), []);
  });

  it("resolves the enforcement target from the reported message's signer", () => {
    const [row] = parseModerationReports([rawRow()]);
    assert.equal(enforcementTarget(row, new Map([[REPORT, MEMBER]])), MEMBER);
    assert.equal(enforcementTarget(row, new Map()), null);
    const [pubkeyRow] = parseModerationReports([
      rawRow({ target_kind: "pubkey", target: MEMBER }),
    ]);
    assert.equal(enforcementTarget(pubkeyRow, new Map()), MEMBER);
  });
});
