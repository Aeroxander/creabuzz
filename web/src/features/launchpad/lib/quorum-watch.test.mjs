/**
 * `quorum-watch.ts` under `node --test` (node >= 22 strip-types) — the A5
 * turn-out watch: risk states, the compact clock, and the agent-nudge
 * reminder shape (NIP-ER).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  decodeTallies,
  nudgeReminderParts,
  quorumWatch,
} from "./quorum-watch.ts";

const T0 = 1_000_000n;
const DAY = 86_400n;

describe("quorumWatch — the visible gates", () => {
  it("leading when FOR beats AGAINST and clears minYes", () => {
    const w = quorumWatch({
      tallies: { forVotes: 12n, againstVotes: 5n, abstainVotes: 1n },
      minYes: 10n,
      ttlEndsAt: T0 + 20n * DAY,
      createdAt: T0,
      now: T0 + DAY,
    });
    assert.equal(w.status, "leading");
    assert.equal(w.votesNeeded, 0n);
  });

  it("counts BOTH gates and takes the larger shortfall", () => {
    // Margin gate: 8 + 1 - 6 = 3. Floor gate: 10 - 6 = 4 -> 4.
    const w = quorumWatch({
      tallies: { forVotes: 6n, againstVotes: 8n, abstainVotes: 0n },
      minYes: 10n,
      ttlEndsAt: T0 + 20n * DAY,
      createdAt: T0,
      now: T0 + DAY,
    });
    assert.equal(w.votesNeeded, 4n);
    assert.equal(w.status, "needs-votes");
    assert.match(w.detail, /4 more FOR vote\(s\) needed/);
  });

  it("at-risk = short AND in the TTL's last quarter", () => {
    const w = quorumWatch({
      tallies: { forVotes: 1n, againstVotes: 0n, abstainVotes: 0n },
      minYes: 10n,
      ttlEndsAt: T0 + 10n * DAY, // 20-day TTL; 2 days left = last quarter
      createdAt: T0 - 10n * DAY,
      now: T0 + 8n * DAY,
    });
    assert.equal(w.status, "at-risk");
  });

  it("expired with a shortfall says defeated; without one, executable", () => {
    const short = quorumWatch({
      tallies: { forVotes: 1n, againstVotes: 5n, abstainVotes: 0n },
      minYes: 10n,
      ttlEndsAt: T0,
      createdAt: T0 - DAY,
      now: T0 + 1n,
    });
    assert.equal(short.status, "expired");
    assert.match(short.detail, /defeated unless extended/);
    const met = quorumWatch({
      tallies: { forVotes: 12n, againstVotes: 1n, abstainVotes: 0n },
      minYes: 10n,
      ttlEndsAt: T0,
      createdAt: T0 - DAY,
      now: T0 + 1n,
    });
    assert.equal(met.status, "leading");
    assert.match(met.detail, /executable window/);
  });

  it("minYes null degrades to the margin gate only (never invented)", () => {
    const w = quorumWatch({
      tallies: { forVotes: 5n, againstVotes: 4n, abstainVotes: 0n },
      minYes: null,
      ttlEndsAt: T0 + 20n * DAY,
      createdAt: T0,
      now: T0 + DAY,
    });
    assert.equal(w.status, "leading", "5 > 4 clears the margin gate");
  });

  it("renders a compact clock", () => {
    const w = quorumWatch({
      tallies: { forVotes: 0n, againstVotes: 0n, abstainVotes: 0n },
      minYes: 1n,
      ttlEndsAt: T0 + DAY + 3n * 3600n,
      createdAt: T0,
      now: T0,
    });
    assert.match(w.detail, /1d 3h left/);
  });
});

describe("the agent nudge (NIP-ER reminder shape)", () => {
  it("carries one d, not_before, and the optional expiration", () => {
    const parts = nudgeReminderParts({
      d: "quorum:launch-1:0xabc",
      title: "Quorum watch",
      body: "4 more FOR votes needed before the TTL.",
      notBefore: "1790000000",
      expiration: "1790600000",
    });
    const dTags = parts.extraTags.filter(([k]) => k === "d");
    assert.equal(dTags.length, 1, "exactly one d (validate_event_reminder)");
    assert.ok(
      parts.extraTags.some(
        ([k, v]) => k === "not_before" && v === "1790000000",
      ),
    );
    assert.ok(
      parts.extraTags.some(
        ([k, v]) => k === "expiration" && v === "1790600000",
      ),
    );
    assert.match(parts.content, /Quorum watch/);
  });
});

describe("tallies decode", () => {
  it("reads the three words (FOR, AGAINST, ABSTAIN) and rejects short data", () => {
    const word = (v) => v.padStart(64, "0");
    const data = `0x${word("a")}${word("5")}${word("0")}`;
    const tallies = decodeTallies(data);
    assert.equal(tallies?.forVotes, BigInt("0xa"));
    assert.equal(tallies?.againstVotes, 5n);
    assert.equal(tallies?.abstainVotes, 0n);
    assert.equal(decodeTallies("0x1234"), null);
  });
});
